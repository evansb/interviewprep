# Chapter 12 — Associative Containers

*Interview-focused revision notes. The theme: the standard's associative containers are specified in a way that mandates node-per-element pointer chasing, so the interesting engineering — and every serious low-latency map — lives in the open-addressed, flat alternatives the standard cannot provide.*

---

## 12.1 Ordered Maps and Sets

`std::map`, `std::set`, `std::multimap`, `std::multiset` are **sorted associative containers**: elements are kept in order of a strict weak ordering, giving O(log n) lookup, insert, and erase, and O(n) ordered traversal.

Every mainstream implementation uses a **red-black tree** (Ch. 21): a self-balancing BST with the invariant that no root-to-leaf path is more than twice as long as any other, giving height ≤ 2·log₂(n+1). Red-black is chosen over AVL because it does at most 3 rotations per insert/erase (AVL can do O(log n) on erase), trading slightly worse balance for cheaper mutation.

### Node layout and its consequences

```
_Rb_tree_node<T>:  [color][parent][left][right][ T ]
                     4+4     8      8     8
// 32 bytes of overhead per element, one malloc per element
```

`std::map<int,int>` therefore costs 32 + 8 = 40 bytes (padded to 40 or 48) per 8 bytes of payload — a **5–6× memory amplification** — and a separate allocation per node. Traversal from one element to the next is `_Rb_tree_increment`, a pointer walk up or down the tree: a sequence of **dependent loads** with no prefetchability (Ch. 28). A lookup is ~log₂(n) dependent cache misses; for n = 10⁶ that is ~20 misses × ~80 ns ≈ 1.6 µs if the tree is cold.

### The interface and its guarantees

| Operation | Complexity | Notes |
|---|---|---|
| `find`, `count`, `lower_bound`, `upper_bound`, `equal_range` | O(log n) | |
| `insert`, `erase`, `emplace` | O(log n) | Amortized O(1) with a correct hint |
| `operator[]` (map only) | O(log n) | **Default-constructs and inserts** if absent |
| `at` | O(log n) | Throws `std::out_of_range` |
| Iteration | O(n) in key order | Bidirectional iterators only |
| `erase(key)` | O(log n + count) | |

- **References, pointers, and iterators are never invalidated** except for the erased element. This is `map`'s single strongest property and often the reason to choose it.
- **Ordered traversal for free** — this is the *real* reason to use `map` over `unordered_map`, along with `lower_bound`/`upper_bound` **range queries**. If you never iterate in order and never do a range query, you almost certainly want a hash map.
- `operator[]` requires `mapped_type` to be default-constructible and *inserts on read*. `m[k]` in a lookup path silently grows the map; use `find` or `at`. `try_emplace` (C++17) does not construct the value when the key exists (unlike `emplace`, which may construct and then discard), and `insert_or_assign` gives the "upsert" semantics people expect from `operator[]`.

### Comparators

The comparator must be a **strict weak ordering**: irreflexive, asymmetric, transitive, with transitive incomparability. Violating it (e.g. `<=` instead of `<`) is **undefined behavior**, not merely a wrong answer — `std::sort` will walk off the end of the array, and the tree will corrupt. Equivalence is defined as `!(a<b) && !(b<a)`, *not* `operator==`, which is why a `map` can consider two distinct-by-`==` keys the same.

### `std::less<>` and heterogeneous lookup

```cpp
std::map<std::string, V> m;
m.find("literal");                       // constructs a temporary std::string — allocation!

std::map<std::string, V, std::less<>> m2;   // transparent comparator
m2.find(std::string_view{"literal"});       // no temporary, no allocation
```
`std::less<>` (the void specialization) makes the comparator **transparent**, enabling the templated `find`/`count`/`lower_bound`/`equal_range` overloads (C++14). C++23 extended heterogeneous overloads to `erase` and `extract`. Forgetting this is a real, measurable allocation on every lookup and is a favourite interview detail.

### Node handles and splicing (C++17)

```cpp
auto node = src.extract(key);      // detaches the node — no allocation, no copy
node.key() = new_key;              // mutate the key in place (impossible otherwise)
dst.insert(std::move(node));       // O(log n), still no allocation
src.merge(other);                  // splices all mergeable nodes
```
`extract`/`insert(node_handle)`/`merge` move nodes between compatible containers without allocating or copying the element — the only way to move a move-only mapped type out of a map, and the only way to change a key without erase+insert.

### `std::flat_map` preview

C++23 added `std::flat_map`/`flat_set` (§12.8) as sorted-vector adaptors with the same interface and radically different performance. For read-mostly ordered data, that is now the right default.

---

## 12.2 Unordered Maps and Sets

`std::unordered_map`, `unordered_set`, `unordered_multimap`, `unordered_multiset` (C++11) are **hash tables** giving average O(1) lookup, worst case O(n).

The standard's specification forces a particular implementation:

1. **`begin()`/`end()` must iterate all elements in O(n)** with forward iterators.
2. **References and pointers to elements are never invalidated** by insert or erase (only iterators, and only on rehash).
3. **Bucket interface is exposed**: `bucket_count()`, `bucket(key)`, `bucket_size(n)`, `local_iterator` per bucket.
4. **Erase invalidates only the erased element's iterators.**
5. **`max_load_factor` is settable at runtime.**

Together these mandate **separate chaining with stable nodes**. Requirement 2 forbids moving elements, so open addressing (§12.5) is impossible. Requirement 1 plus forward-iterator semantics pushes libstdc++ to a design where **all nodes live on one singly-linked list** and the bucket array holds pointers *into* that list (so that erase can find the predecessor and iteration is a simple list walk):

```
buckets:  [ ][*][ ][ ][*][ ][*]
             |        |     |
 list: head->n3------>n7--->n1->n5->null      (grouped by bucket)
```

libstdc++ additionally caches the hash value in each node when the hash is not `noexcept` (to avoid rehashing on rehash), costing 8 more bytes.

### The cost model

```
lookup:  hash(key)                       // may be expensive (string!)
         h % bucket_count                // MODULO BY A RUNTIME VALUE: ~20-40 cycle integer division
         load bucket pointer             // cache miss #1
         load node                       // cache miss #2 (dependent)
         compare key                     // possibly another miss for string data
         follow next on collision        // more dependent misses
```

Two or more **dependent** cache misses per lookup, plus an integer division. libstdc++ uses a **prime** bucket count and a real `%`; libc++ uses a power of two when it can and masks, but falls back to `%` with a prime otherwise. The division is a genuine, measurable cost — this is why fast hash maps universally use power-of-two capacity and a mask.

Per-element memory: node (next pointer 8 + optional cached hash 8 + `pair<const K,V>`) plus one slot in the bucket array plus one `malloc` header (~16 bytes). A `std::unordered_map<int,int>` costs ~48–56 bytes per 8 bytes of payload.

**The standard's `unordered_map` is, by construction, one of the slowest hash tables in wide use.** Saying that — and explaining that requirements 1–4 above are the reason, not implementer laziness — is the strong answer.

### Hashing

`std::hash<T>` is specialized for the fundamental types, pointers, `string`, `string_view`, `bitset`, `thread::id`, `optional`, `variant`, and `unique_ptr`/`shared_ptr`. There is **no `std::hash` for `std::pair`, `tuple`, or containers** — you must write one, and the naive `h1 ^ h2` is bad (symmetric, so `(a,b)` and `(b,a)` collide, and `(a,a)` hashes to 0). Use `boost::hash_combine`'s mixing (`seed ^= h + 0x9e3779b9 + (seed<<6) + (seed>>2)`) or a proper finalizer.

For integers, libstdc++'s `std::hash<int>` is the **identity function**. Combined with a prime modulus that mostly works; combined with a power-of-two mask it is catastrophic for keys with structure (pointers, aligned IDs, timestamps in nanoseconds — all with zero low bits). Any power-of-two table must apply a **finalizer/avalanche step** (e.g. `murmur3` fmix64, `wyhash`, or `absl`'s mix) before masking.

**Hash flooding** is the security angle: an attacker who can choose keys can force every insert into one bucket, making an O(1) service O(n) per operation. Defenses: a per-process random seed (SipHash, as Rust and Python use), a tree-fallback per bucket (as Java's `HashMap` does at 8 collisions), or simply never hashing untrusted input.

### Customizing

```cpp
struct SymbolHash {
    using is_transparent = void;                              // enables heterogeneous lookup (C++20)
    size_t operator()(std::string_view s) const noexcept { return wyhash(s); }
    size_t operator()(const std::string& s) const noexcept { return wyhash(s); }
};
struct Eq { using is_transparent = void; bool operator()(...) const; };
std::unordered_map<std::string, V, SymbolHash, Eq> m;
m.find(std::string_view{"AAPL"});     // no temporary string
```
Heterogeneous lookup for unordered containers arrived in **C++20** (P0919), six years after the ordered ones, and requires `is_transparent` on **both** the hash and the equality functor. C++23 added heterogeneous `erase`/`extract`.

`unordered_map` also supports `extract`/`insert(node)`/`merge` and `try_emplace`/`insert_or_assign`, with the same rationale as §12.1.

---

## 12.3 Hash-Table Collision Resolution

A **collision** is two distinct keys mapping to the same bucket index. By the birthday bound, collisions begin at ~√m insertions into m buckets, so every table needs a resolution strategy. The two families:

### Separate chaining

Each bucket holds a container (list, vector, or tree) of the entries hashing there.

```
bucket[i] -> node -> node -> null
```

| | |
|---|---|
| Load factor | May exceed 1 (average chain length = α) |
| Element stability | **Yes** — nodes never move |
| Deletion | Trivial: unlink |
| Memory | One allocation per element + bucket array |
| Lookup | 1 + expected α/2 dependent pointer follows |
| Degradation | Graceful — a bad hash makes chains long, not the table unusable |

Expected probes for a successful search: 1 + α/2. For unsuccessful: α.

Java's `HashMap` converts a bucket to a red-black tree past 8 entries (with ≥ 64 buckets), bounding hash-flooding damage to O(log n).

### Open addressing

All entries live **in the bucket array itself**; on collision, probe other slots by a deterministic sequence. Covered in §12.5.

| | |
|---|---|
| Load factor | **Must be < 1** (typically ≤ 0.5–0.875) |
| Element stability | **No** — entries move on rehash and (for some schemes) on insert/erase |
| Deletion | Requires tombstones or backward-shift |
| Memory | One contiguous array, no per-element allocation |
| Lookup | Contiguous probes — 1 cache miss typically, then in-line |
| Degradation | **Cliff** — performance collapses as α → 1 (clustering) |

### The comparison that matters

| | Chaining | Open addressing |
|---|---|---|
| Cache misses per lookup | 2+ dependent | ~1 |
| Allocations | Per element | Per rehash |
| Memory per element | payload + 8–24 B links + malloc header | payload / α + 1 metadata byte (SwissTable) |
| Pointer/reference stability | **Yes** | **No** |
| Erase cost | O(1) unlink | Tombstone (degrades) or backward shift |
| Sensitivity to hash quality | Low | **High** — needs a good avalanche |
| Suits | Large elements, stability requirements, adversarial input | Small keys, read-heavy, latency-sensitive |

**The low-latency answer is open addressing**, because the dominant cost of a lookup is cache misses and chaining guarantees at least two dependent ones. The price is losing reference stability — which is why `std::unordered_map` cannot be implemented this way, and why every serious alternative (`absl::flat_hash_map`, `folly::F14`, `ankerl::unordered_dense`, `boost::unordered_flat_map`) is a non-standard type with different invalidation rules.

### Other schemes worth naming

- **Coalesced hashing** — chaining where the chain nodes are stored in the table itself. Historic.
- **Cuckoo hashing** — two (or d) hash functions and tables; an insert displaces the occupant, which relocates to its alternate slot, cascading. Gives **worst-case O(1) lookup** (check exactly d slots) but insert can loop and require a full rehash; load factors up to ~0.91 with d=2 and a bucket size of 4. Used where lookup tail latency must be bounded.
- **Hopscotch hashing** — keeps every entry within a bounded neighbourhood H (typically 32) of its home bucket, using a bitmap per bucket, so a lookup touches at most one or two cache lines. Concurrency-friendly.
- **2-choice / "power of two choices"** — hash to two buckets, insert into the shorter; reduces max chain length from O(log n / log log n) to O(log log n).

---

## 12.4 Load Factors and Rehashing

**Load factor** α = `size() / bucket_count()`. It is the single knob controlling the space/time trade-off of a hash table.

```cpp
m.load_factor();          // current α
m.max_load_factor();      // threshold, default 1.0 for unordered_map
m.max_load_factor(0.5);   // settable at runtime (the standard requires this)
m.rehash(n);              // ensure bucket_count >= n, and >= size/max_load_factor
m.reserve(n);             // ensure it can hold n elements without rehashing == rehash(ceil(n/mlf))
m.bucket_count();
```

**Rehash** occurs when inserting would push α above `max_load_factor`. It allocates a new bucket array, recomputes `hash(key) % new_count` for every element, and relinks. Cost O(n) — plus, if the hash is expensive and not cached, n hash computations. libstdc++ caches the hash in the node when `hash` is not `noexcept`; mark your hash `noexcept` and it will *not* cache it (saving 8 bytes/node) and recompute instead. That is a genuinely counterintuitive libstdc++ detail.

Growth is geometric (roughly ×2, snapped to the next prime in libstdc++), so insertion is amortized O(1). Same amortization argument as `std::vector` (Ch. 11 §11.3).

### The α trade-off

| α | Chaining | Open addressing (linear probing) |
|---|---|---|
| 0.25 | ~1.1 probes, 4× memory | ~1.2 probes, 4× memory |
| 0.5 | ~1.25 probes | ~1.5 probes |
| 0.75 | ~1.4 probes | ~2.5 probes |
| 0.9 | ~1.45 probes | ~5.5 probes |
| 0.95 | ~1.5 probes | **~10.5 probes** |

Linear probing's expected probes for an unsuccessful search is ½(1 + 1/(1−α)²) — it explodes as α → 1. Chaining degrades linearly. This is why open-addressed tables cap at 0.5 (older designs), 0.75, or 0.875 (SwissTable, which can afford more because its probes are SIMD-parallel within a group), while `unordered_map` defaults to 1.0.

### Rehashing as a latency spike

A rehash of a 10-million-entry map is an allocation of ~100 MB, n hash computations, and n pointer writes — tens of milliseconds, during which the thread does nothing else. On a trading hot path that is a catastrophic tail-latency event (Ch. 43). Mitigations:

1. **`reserve(expected_max)` at startup.** The single most important hash-map tuning action. Note `reserve(n)` means "n *elements*", already dividing by the max load factor — a common confusion with `rehash(n)`, which means "n *buckets*".
2. **Bound the map size** and use a fixed-capacity table that never grows.
3. **Incremental rehashing** — keep both tables and migrate a few entries per operation (what Redis does). Amortizes the spike into every operation, at the cost of every lookup checking two tables. Not available in the standard containers.
4. Never let the hot path insert into an unbounded map; do lookups only, and populate from a slow path.

### Iterator invalidation

Rehash invalidates **all iterators** but **no references or pointers** (§12.2). Erase invalidates only the erased element's. So:

```cpp
for (auto it = m.begin(); it != m.end(); ) {
    if (pred(*it)) it = m.erase(it);     // fine
    else { m.emplace(...); ++it; }       // UB if the emplace rehashes
}
```

`max_load_factor` is a *hint*: the standard says implementations may exceed it, and it does not shrink the table when set lower until the next rehash. There is no automatic shrinking on erase in any implementation — a map that grew to 10 M and shrank to 10 keeps its 10 M buckets. `rehash(0)` requests a shrink to the minimum.

---

## 12.5 Open Addressing

All entries live in a single contiguous array. On collision, probe a deterministic sequence of slots until finding the key or an empty slot.

### Probe sequences

| Scheme | Sequence for attempt i | Cache behavior | Clustering |
|---|---|---|---|
| **Linear probing** | `(h + i) mod m` | **Best** — sequential, prefetcher-friendly, often the same cache line | **Primary clustering**: runs merge and grow superlinearly |
| **Quadratic probing** | `(h + c₁i + c₂i²) mod m` | Poor after the first few | **Secondary clustering**: same-home keys share a sequence |
| **Double hashing** | `(h₁ + i·h₂) mod m` | Worst — random access every probe | Minimal; closest to uniform hashing |
| **Robin Hood (linear)** | linear + reordering | Best | Variance bounded (§12.6) |

Theory prefers double hashing (its expected probe count matches idealized uniform hashing). Practice overwhelmingly prefers **linear probing**, because on real hardware one cache miss followed by 8 sequential in-line comparisons beats 3 random cache misses. The whole modern design space is "linear probing plus something that fixes clustering."

Requirements: with quadratic probing and `m` a power of two and `c₁=c₂=½`, the sequence visits every slot (triangular numbers). With linear probing and a power-of-two mask, any `h` works. Double hashing requires `h₂` coprime to `m` — trivially satisfied by making `h₂` odd with a power-of-two `m`.

### Deletion: the hard part

You cannot simply blank a slot — that would truncate the probe sequence of any key that probed past it.

**Tombstones**: mark the slot `DELETED`. Lookups treat it as occupied-but-not-matching (keep probing); inserts may reuse it. Simple, but tombstones accumulate and lengthen probe sequences until a rehash clears them, so a delete-heavy workload degrades even at low α. Implementations count tombstones and trigger a rehash-in-place when they exceed a threshold.

**Backward-shift deletion**: after removing, walk forward and move back any entry whose home bucket is at or before the hole, closing the gap. Requires linear probing and preserves the invariant with no tombstones — used by Robin Hood tables and `ankerl::unordered_dense`. Erase is O(probe length) instead of O(1), but lookups never degrade.

### The consequences you must state

- **No reference or pointer stability.** Any insert can rehash and move every element; some schemes move elements on *every* insert. Callers must hold keys, not pointers. If stability is needed, store `unique_ptr`s or indices and accept the indirection (`absl::node_hash_map` exists for exactly this).
- **Requires a high-quality hash.** Identity hashing into a masked power-of-two table clusters catastrophically. Always finalize/avalanche.
- **Element type must be movable**, and ideally trivially copyable so the rehash is a `memcpy`-class operation.
- **Metadata must distinguish EMPTY / OCCUPIED / DELETED.** Either a separate byte array (SwissTable), reserved sentinel key values (fast but requires two unusable key values — a sentinel hazard, Ch. 23), or a bit in the hash.

---

## 12.6 Robin Hood Hashing

**Robin Hood hashing** is linear probing plus one rule: on insert, if the entry being placed has travelled farther from its home bucket than the entry currently occupying the slot, **swap them** and continue inserting the displaced one. "Rob from the rich (short probe distance) to give to the poor (long probe distance)."

Define **probe sequence length (PSL)** or *displacement* = current index − home index (mod m).

```
insert K (psl=3) into slot i occupied by X (psl=1):
    3 > 1  →  place K at i, continue inserting X from i+1 with psl=2
```

### What it buys

The mean probe length is unchanged, but the **variance collapses**. Without Robin Hood, maximum displacement is O(log n); with it, it is O(log log n) with high probability. Since tail latency is what matters (Ch. 43), bounding the worst case at essentially the same average cost is the entire point.

It also enables **early exit on lookup**: entries along a probe run are in non-decreasing PSL order, so when probing for key K at offset d, if the occupant's PSL < d, K cannot be further along — stop. A failed lookup therefore terminates early rather than running to the next empty slot.

```cpp
// lookup sketch
size_t i = h & mask, d = 0;
for (;;) {
    if (empty(i)) return not_found;
    if (psl(i) < d) return not_found;          // early exit — the Robin Hood invariant
    if (hash(i) == h && key(i) == k) return i;
    i = (i + 1) & mask; ++d;
}
```

### Costs and details

- **Inserts do more work**: swaps cascade. An insert is O(max displacement) writes rather than one.
- **Deletion must use backward shift** (§12.5) to keep the PSL invariant; tombstones break the early-exit rule.
- **Storing the PSL** costs a byte per slot, or you recompute it from the stored hash. Storing a truncated hash (e.g. 8 bits) in the metadata lets you reject non-matching keys without touching the key data at all — the same trick SwissTable uses, and it is where most of the practical speed comes from.
- **It tolerates higher load factors**: 0.9 is workable where plain linear probing is unusable.

Implementations: `ankerl::unordered_dense` (Robin Hood with backward-shift deletion, and a separate dense value array for stable iteration order), `tsl::robin_map`, Rust's `std::collections::HashMap` (Robin Hood until 2018, then SwissTable), `martinus/robin_hood`.

### Robin Hood vs SwissTable

| | Robin Hood | SwissTable (§12.7) |
|---|---|---|
| Bounds the tail by | Reordering (PSL invariant) | SIMD-scanning 16 slots per probe |
| Metadata | PSL byte or derived | 1 control byte: 7 hash bits + state |
| Probe granularity | 1 slot | **16 slots per SSE2 comparison** |
| Insert cost | Cascading swaps | Single write |
| Deletion | Backward shift | Tombstone (with in-place rehash) |
| Max load factor | ~0.9 | 0.875 |

Both are strong; SwissTable's group-wise SIMD probe generally wins on modern x86 and is the more widely deployed design.

---

## 12.7 Flat Hash Maps

"Flat" means **the elements live directly in the table array**, not in separately allocated nodes. This is the open-addressed family in production form.

### SwissTable (`absl::flat_hash_map`)

The design:

- One **control byte per slot**, in a separate array: bit 7 = 1 means empty (`0x80`) or deleted (`0xFE`); otherwise the byte holds `H2`, the **low 7 bits of the hash**.
- The 57 high bits (`H1`) select the starting **group** of 16 slots.
- A probe loads the 16 control bytes into an SSE2 register, does `_mm_cmpeq_epi8` against the broadcast `H2`, and `_mm_movemask_epi8` to get a 16-bit match mask. Iterate the set bits: for each, compare the full key.

```
_mm_cmpeq_epi8(ctrl_group, _mm_set1_epi8(H2))  →  movemask  →  0b0000000000100000
                                                               ^ candidate slot 5
```

Consequences:
- A lookup touches **one control cache line and (usually) one slot cache line**. 7 hash bits reject ~127/128 of non-matching slots without loading key data at all, so a miss usually costs one cache miss total.
- Probing advances by whole groups (quadratic in group index), so clustering is bounded.
- Max load factor 7/8 = 0.875.
- The control array is separate from the slots, so it is dense and prefetchable, and `absl` prefetches the slot line while comparing control bytes.

Non-SIMD platforms use a portable 8-byte-at-a-time SWAR fallback.

### The invalidation contract

| Container | Pointer/reference stability | Iterator stability |
|---|---|---|
| `std::unordered_map` | **Always** | Invalidated by rehash |
| `absl::flat_hash_map` | **None** — any insert may move everything | None |
| `absl::node_hash_map` | Always (nodes) | Invalidated by rehash |
| `folly::F14ValueMap` | None | None |
| `folly::F14NodeMap` | Always | None |
| `folly::F14VectorMap` | None (values in a dense vector) | Stable iteration order, erase is O(1) via swap-with-last |
| `ankerl::unordered_dense` | None | Elements in a dense vector; iteration is contiguous |

**`absl::flat_hash_map<K, V>` requires `V` to be movable and stores it by value**, so `flat_hash_map<K, LargeObject>` copies a lot on rehash — Abseil's guidance is to use `flat_hash_map<K, std::unique_ptr<V>>` for large or immovable values, which restores stability at the cost of the indirection.

### F14 (folly)

Uses 14 slots per 16-byte chunk (hence the name) with 2 bytes of chunk metadata, giving it an overflow-counting scheme that avoids tombstones. Offers the Value/Node/Vector variants above to let you pick the stability/locality trade-off explicitly.

### Choosing

- **Small trivially-copyable K and V, read-heavy, latency-critical** → `absl::flat_hash_map` / `boost::unordered_flat_map` (C++, header-only, no Abseil dependency) / `ankerl::unordered_dense`.
- **Need pointer stability** → `node_hash_map` / `F14NodeMap` / `std::unordered_map`.
- **Need to iterate often, or iteration order stability across erases** → `F14VectorMap` or `unordered_dense` (contiguous value array).
- **Fixed key set known at compile time** → a perfect hash (`gperf`, `frozen::unordered_map`) with zero collisions and no branch.
- **Very small maps (< ~16 entries)** → a flat sorted or unsorted array with linear scan beats every hash table; the whole thing is one or two cache lines and there is no hash to compute. This is the right answer for a per-symbol or per-venue table and is a good thing to volunteer.

Reported figures: `absl::flat_hash_map` and `boost::unordered_flat_map` typically deliver 2–4× the lookup throughput of `std::unordered_map` for small keys, with roughly half the memory. Always benchmark with your key distribution and working-set size (Ch. 43) — the advantage shrinks when the table fits in L2 and grows when it does not.

---

## 12.8 Flat Maps and Sets

`std::flat_map`, `std::flat_set`, `std::flat_multimap`, `std::flat_multiset` (**C++23**, P0429/P1222) are **container adaptors**, not containers: they wrap sorted sequence containers and present the `std::map`/`std::set` interface.

```cpp
template <class Key, class T, class Compare = std::less<Key>,
          class KeyContainer = std::vector<Key>,
          class MappedContainer = std::vector<T>>
class flat_map {
    KeyContainer     keys_;      // sorted
    MappedContainer  values_;    // parallel, same order
};
```

Note the **key/value split**: `flat_map` stores two parallel vectors, not a `vector<pair<K,V>>`. That is a structure-of-arrays layout (Ch. 42): a binary search touches only the key array, so the number of cache lines pulled in during the search is halved (or better, for large `V`), and the value is loaded once at the end.

### Complexity

| Operation | `std::map` | `std::flat_map` |
|---|---|---|
| `find` / `lower_bound` | O(log n) pointer chasing | O(log n) **binary search in contiguous memory** |
| `insert` / `erase` | O(log n) | **O(n)** — shifts the tail |
| Iteration | O(n), pointer-chasing | O(n), **contiguous** |
| Memory per element | `sizeof(pair)` + 32 B + malloc header | `sizeof(K) + sizeof(V)`, amortized |
| Allocations | One per element | O(log n) total (vector growth) |
| Reference stability | Total | **None** |
| Iterator invalidation | Only erased element | **Any insert or erase** |

A binary search over a sorted array is ~log₂(n) cache misses in theory, but the top few levels stay resident in cache across queries and the last few levels fall within one cache line, so in practice it is 3–5 misses for n = 10⁶ versus ~20 for a red-black tree, with 4–6× less memory. **For read-mostly ordered data, `flat_map` beats `map` by a wide margin.**

### The API oddities

- **`value_type` is `pair<const K, T>` but there is no such object in storage**, so `flat_map`'s iterators are **proxy iterators** returning `pair<const K&, T&>`. Consequences: `auto& p = *it;` does not do what you expect, `operator->` needs a proxy, and `flat_map` iterators are *not* `std::contiguous_iterator` and do not satisfy some older algorithm requirements. They do satisfy C++20 `random_access_iterator` under the relaxed proxy-friendly ranges rules.
- **`sorted_unique_t` tags** let you construct from an already-sorted range in O(n) instead of O(n log n).
- **`extract()` / `replace()`** hand you the underlying containers, so you can bulk-modify and hand them back.
- **Exception safety is weak**: if an operation throws mid-way, the two containers can desynchronize; the standard specifies that the `flat_map` is then **cleared**. That is a surprising and important detail.
- **Bulk insertion** of a range is O(n + m log m): append, sort the new part, `inplace_merge`. Far better than m individual O(n) inserts. Always batch.

### `flat_set` and small-map guidance

`flat_set` is a single sorted vector. For small n the binary search should be replaced by a **linear scan** — branchless comparison over a contiguous array beats binary search below roughly 32–64 elements because it is prefetchable and branch-predictable while binary search is a chain of mispredicted dependent loads (Ch. 27, Ch. 42). Some implementations do this switch internally; if yours does not and n is small, do it yourself.

### Availability and alternatives

C++23; libstdc++ 15 and MSVC ship it, libc++ is in progress. Before that: `boost::container::flat_map` (which stores `vector<pair<K,V>>`, i.e. AoS, not the C++23 SoA split), `absl::btree_map`, `folly::sorted_vector_map`.

**`absl::btree_map` deserves a mention as the middle ground**: a B-tree (Ch. 21) with ~64-byte-multiple nodes holding many keys each. It gives O(log n) insert *and* erase (unlike `flat_map`'s O(n)), contiguous scanning within a node, ~3× less memory than `std::map`, and stable *iteration* — at the cost of invalidating iterators on mutation. For an ordered map that is both read- and write-heavy, a B-tree is usually the right structure, and naming it is a strong answer.

**Order-book application (Ch. 50):** price levels are an ordered map with heavy insert/erase at the extremes and heavy lookup near the top of book. `std::map` is the naive answer; real implementations use a flat sorted array or, more often, a **direct-indexed array over the tick grid** (price → index arithmetic, O(1), no comparison at all) with a separate structure for the sparse tails. Reaching for the array is the answer that signals domain experience.

---

## Key Interview Questions

1. **What data structure backs `std::map`, and why that one?** — A red-black tree: at most 3 rotations per mutation versus AVL's O(log n) rebalancing on erase, trading a slightly taller tree for cheaper writes.
2. **What does a `std::map` node cost?** — Colour + three pointers ≈ 32 bytes plus a malloc header per element, one allocation each, and a lookup is ~log₂ n *dependent* cache misses.
3. **When should you actually choose `map` over `unordered_map`?** — Only when you need ordered iteration or range queries (`lower_bound`/`upper_bound`), or total reference stability with an ordering. Otherwise a hash map wins.
4. **What is wrong with `m[key]` in a lookup path?** — It default-constructs and inserts when absent. Use `find`, `at`, `try_emplace`, or `contains` (C++20).
5. **What is `std::less<>` for?** — A transparent comparator enabling heterogeneous lookup, so `m.find("literal")` on a `map<string,V>` does not allocate a temporary `string`. For unordered containers the equivalent needs `is_transparent` on both hash and equality, and arrived only in C++20.
6. **Why must `std::unordered_map` use separate chaining?** — The standard mandates never invalidating references, plus a bucket interface and O(n) forward iteration; open addressing moves elements, so it is impossible.
7. **What does an `unordered_map` lookup actually cost?** — A hash, an integer modulo by a runtime prime (~20–40 cycles), then at least two dependent cache misses (bucket pointer, then node), plus more per collision.
8. **Why is `std::hash<int>` being the identity a problem?** — With a power-of-two mask, structured keys (pointers, aligned IDs, ns timestamps) collide catastrophically. Any masked table needs an avalanche/finalizer step.
9. **Contrast chaining and open addressing.** — Chaining: stable references, α > 1 allowed, easy delete, 2+ dependent misses, per-element allocation. Open addressing: one contiguous array, ~1 miss, no stability, tombstones or backward shift for delete, needs a good hash, collapses as α → 1.
10. **What is a load factor and what does a rehash cost?** — size/bucket_count; a rehash is an O(n) reallocation plus n rehash computations plus relinking — tens of milliseconds for a large map and a tail-latency catastrophe. `reserve` at startup.
11. **What does a rehash invalidate?** — All iterators; **no references or pointers**.
12. **Why does linear probing beat double hashing in practice despite worse theory?** — Sequential probes are prefetchable and often stay in one cache line; one cache miss plus in-line scanning beats several random misses.
13. **How do you delete from an open-addressed table?** — Tombstones (simple, but they accumulate and degrade probe lengths until a rehash) or backward-shift deletion (requires linear probing, no degradation, O(probe length) erase).
14. **Explain Robin Hood hashing and what it optimizes.** — Swap on insert so the entry with the larger probe distance takes the slot; the mean is unchanged but maximum displacement drops from O(log n) to O(log log n), and lookups exit early when the occupant's PSL is smaller than the current distance.
15. **How does SwissTable work?** — One control byte per slot holding 7 hash bits plus state; a probe SIMD-compares 16 control bytes at once, so a miss usually costs one cache miss and 7 bits reject 127/128 of non-matches without touching key data. Max load factor 0.875.
16. **What do you give up with `absl::flat_hash_map`?** — Pointer and reference stability, entirely. Use `node_hash_map` or store `unique_ptr` values if you need it.
17. **How is `std::flat_map` laid out and what is its complexity profile?** — Two parallel sorted vectors (keys and values, structure-of-arrays); O(log n) contiguous binary search, **O(n) insert and erase**, contiguous iteration, ~5× less memory than `map`, no stability.
18. **Why does `flat_map` have proxy iterators?** — Its `value_type` is `pair<const K, T>` but no such object exists in storage; iterators synthesize `pair<const K&, T&>`.
19. **Read- and write-heavy ordered map — what do you use?** — A B-tree (`absl::btree_map`): O(log n) for both, contiguous scanning within nodes, ~3× less memory than `std::map`.
20. **What is the best map for 8 entries?** — A flat array with a linear scan. No hashing, one or two cache lines, perfectly predicted.

---

## Common Traps

- **`m[key]` in a read path** — inserts a default-constructed value.
- **A comparator that is not a strict weak ordering** (`<=`) — UB, not just wrong results.
- **Expecting `map` equivalence to mean `operator==`** — it is `!(a<b) && !(b<a)`.
- **`map<string,V>::find("literal")` without `std::less<>`** — allocates a temporary `string` on every lookup.
- **Assuming heterogeneous lookup works for `unordered_map` pre-C++20**, or forgetting `is_transparent` on the equality functor as well as the hash.
- **`h1 ^ h2` to combine hashes** — symmetric, and `(a,a)` hashes to zero.
- **A power-of-two masked table with an identity or weak hash** — pathological clustering.
- **Hashing untrusted keys without a randomized seed** — hash flooding turns O(1) into O(n).
- **Inserting into an `unordered_map` while iterating** — a rehash invalidates all iterators (references survive).
- **Confusing `reserve(n)` (n elements) with `rehash(n)` (n buckets).**
- **Not calling `reserve` up front** — an unbounded rehash mid-hot-path is a multi-millisecond stall.
- **Expecting the bucket count to shrink after erasing** — no implementation shrinks automatically.
- **Marking your hash `noexcept` and assuming libstdc++ still caches it** — it caches precisely when the hash is *not* `noexcept`.
- **Holding pointers into a flat hash map** — any insert can relocate every element.
- **`absl::flat_hash_map<K, BigObject>`** — every rehash moves all values; use `unique_ptr` or `node_hash_map`.
- **Tombstone accumulation** in a delete-heavy open-addressed table — probe lengths grow even at low α.
- **Robin Hood with tombstones** — breaks the PSL early-exit invariant; use backward shift.
- **Individual `flat_map::insert` calls in a loop** — O(n) each, so O(n·m). Batch: append, sort, `inplace_merge`, or construct with `sorted_unique_t`.
- **Assuming `flat_map` iterators are contiguous or that `&it->second` is a real `pair` member** — they are proxies.
- **Ignoring that a throwing `flat_map` operation leaves the container cleared.**
- **Binary-searching a 16-element sorted array** — a branchless linear scan is faster.
- **Benchmarking a hash map with a working set that fits in L2** — the flat-vs-node difference only shows once you miss cache.

---

## Compact Recall Summary

**Ordered.** `map`/`set` are red-black trees: ~32 bytes of links plus a `malloc` per node, O(log n) via dependent cache misses, total reference and iterator stability, ordered iteration and `lower_bound` range queries — which are the only real reasons to choose them. `operator[]` inserts; prefer `find`/`at`/`try_emplace`/`insert_or_assign`/`contains`. `std::less<>` enables heterogeneous lookup (C++14) and avoids per-lookup temporary strings. `extract`/`insert(node)`/`merge` (C++17) move nodes without allocating and are the only way to mutate a key.

**Unordered.** `unordered_map` is separate chaining with stable nodes, forced by the standard's no-reference-invalidation, bucket-interface, and O(n)-iteration requirements. Cost: a hash, a runtime modulo by a prime, and 2+ dependent cache misses. ~48–56 bytes per small entry. Heterogeneous lookup needs `is_transparent` on both functors and only landed in C++20. `std::hash<int>` is the identity in libstdc++; no `std::hash` for `pair`/`tuple`.

**Collisions.** Chaining: α may exceed 1, stable, trivial delete, graceful degradation, pointer chasing. Open addressing: contiguous, ~1 miss, no stability, needs a strong hash and tombstones or backward-shift delete, collapses as α → 1. Also cuckoo (worst-case O(1) lookup, cascading inserts), hopscotch (bounded neighbourhood), two-choice.

**Load factor.** α = size/buckets. Linear probing's unsuccessful-search cost is ½(1+1/(1−α)²) — explosive near 1; chaining degrades linearly. Caps: 1.0 for `unordered_map`, 0.875 for SwissTable, ~0.9 for Robin Hood. Rehash is O(n) plus reallocation plus rehashing, invalidates all iterators but no references, and is a tail-latency event: `reserve` at startup, bound the size, or rehash incrementally.

**Probing.** Linear wins in practice (prefetchable, in-line comparisons) despite double hashing's better theory. Quadratic sits between. Deletion needs tombstones (accumulate) or backward shift (linear probing only).

**Robin Hood.** Swap on insert when the incoming PSL exceeds the occupant's; mean probe length unchanged, maximum drops from O(log n) to O(log log n), and lookups terminate early when the occupant's PSL is smaller. Needs backward-shift deletion. `ankerl::unordered_dense`, `tsl::robin_map`.

**Flat hash.** SwissTable: one control byte per slot (7 hash bits + state), SIMD-compare 16 at a time, one cache miss for a typical lookup, α ≤ 0.875. `absl::flat_hash_map`, `boost::unordered_flat_map`, `folly::F14` (Value/Node/Vector variants), `ankerl::unordered_dense`. 2–4× `std::unordered_map`'s throughput at half the memory — in exchange for *zero* pointer stability. Below ~16 entries, a flat array with a linear scan beats all of them.

**Flat ordered.** `std::flat_map` (C++23) is an adaptor over two parallel sorted vectors (SoA), giving contiguous O(log n) binary search, contiguous iteration, ~5× less memory, and **O(n) insert/erase** with no stability and proxy iterators; a throwing operation clears it. Batch-build with `sorted_unique_t` or append-sort-merge. For read-and-write-heavy ordered data use a B-tree (`absl::btree_map`); for an order book use direct indexing over the tick grid.
