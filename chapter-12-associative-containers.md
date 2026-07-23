# Chapter 12 — Associative Containers

## Why this matters in an HFT interview — Core

Associative containers are where "know the API" stops being enough. Interviewers use them to check whether you reason about memory layout, cache misses, and tail latency, not just Big-O. The recurring question is a workload description — order-ID lookup, price-level book, static reference data — and you are expected to name the container, its allocation and stability guarantees, and what changes under load. `std::map` and `std::unordered_map` are the baseline; knowing when a flat/open-addressed map or a direct-indexed array beats both is the signal that separates a correct answer from a strong one.

For the underlying tree mechanics, see Chapter 21. Chapter 50 develops the full order-book design; the case study here stays focused on selecting lookup structures.

---

## 90-second screen — Core

1. A key must not change in a way that changes its ordering, hash, or equality while it is stored. An ordered comparator must be a strict weak ordering; equal keys in an unordered container must hash equally.
2. `std::map`/`std::set` guarantee logarithmic lookup and preserve every iterator, pointer, and reference except those to an erased element. The standard does not specify a red-black tree.
3. `std::unordered_map` gives average constant-time lookup. Rehash invalidates all iterators but not element pointers or references; its stability and bucket requirements favor node-based, chaining-like implementations.
4. Load factor α = `size() / bucket_count()` trades memory for collision work. Growth can perform O(n) work in one operation, so reserve for the bounded peak before a latency-sensitive phase.
5. Open-addressed flat hash maps trade element stability for fewer allocations and denser probes. `std::flat_map` is different: it is an ordered, sorted-sequence adaptor with logarithmic lookup and linear insertion/erasure.

Two decisions should fall out immediately: choose order before speed, because only ordered structures answer range queries directly; then choose the stability and mutation contract before comparing benchmark numbers.

---

## Decision table — Core

| Workload trait | Choose |
|---|---|
| Need sorted order or range queries (`lower_bound`) | `std::map` / `std::flat_map` |
| Need pointer/reference stability under mutation | `std::map`, `std::unordered_map`, or a node-based flat-hash variant |
| Read-heavy, unordered, small movable keys, latency-critical | Open-addressed flat hash map (`absl::flat_hash_map`, `boost::unordered_flat_map`, `ankerl::unordered_dense`) |
| Read-mostly ordered data, rare mutation | `std::flat_map` |
| Ordered data, frequent insert *and* erase | B-tree (`absl::btree_map`) — see §12.6 |
| Dense integer key space (ticks, small IDs) | Direct-indexed array — see §12.7 |
| Tiny table with a measured crossover | Flat array, linear scan — see §12.7 |
| Fixed key set known at compile time | Perfect hash (`gperf`, `frozen::unordered_map`) |

---

## Contracts before costs — Core

Associative lookup maps a **key** to either membership (`set`) or an associated **mapped value** (`map`). Unique-key containers store at most one element from each equivalence class; `multi` containers retain every equivalent element. The two families define equivalence differently:

- Ordered containers use the comparator: `a` and `b` are equivalent when neither compares before the other.
- Unordered containers use the equality predicate. If `key_equal(a, b)` is true, `hasher(a) == hasher(b)` must also be true.

These are correctness contracts, not tuning hints. Changing a stored key behind the container's back, using a comparator whose answer changes with time, or supplying inconsistent hashing and equality makes the container unable to find the element in the structure where it was placed. Map keys are exposed as `const Key` to prevent ordinary mutation. If a key genuinely must change, erase and reinsert it, or use a C++17 node handle where supported.

### The authoritative invalidation table

“Stable” means an existing iterator, pointer, or reference still denotes the same element after the operation. It says nothing about concurrent access; unsynchronized conflicting accesses remain a data race.

| Operation | Ordered node containers | Standard unordered containers | `std::flat_map` / `flat_set` | Typical flat hash map |
|---|---|---|---|---|
| Lookup | No invalidation | No invalidation | No invalidation | No invalidation |
| Insert without growth | Stable | Iterators stable; pointers/references stable | May invalidate at or after insertion point; consult underlying sequence | Library-specific; commonly may relocate elements |
| Insert with growth/rehash | Stable | All iterators invalid; pointers/references stable | All iterators, pointers, and references may be invalid | All commonly invalid |
| Erase one element | Only erased element invalid | Only erased element invalid | Erased element and following positions invalid; implementations may move many values | Library-specific; erased element invalid and relocation may invalidate more |
| `clear` / destruction | All invalid | All invalid | All invalid | All invalid |

For `std::flat_map`, the exact invalidation result follows the operations on its underlying key and mapped containers; with the default `std::vector` containers, insertion without reallocation still shifts suffix elements. Non-standard flat hash maps have their own contracts, so a brand name is not enough—check the selected type and version.

This table should be consulted before taking an address into a container. A pointer into `std::unordered_map` survives `reserve` and rehash; an iterator does not. A pointer into a vector-backed flat container generally survives neither reallocation nor shifting.

### A compiling key-contract example

```cpp
#include <cstddef>
#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>

struct SymbolHash {
    using is_transparent = void;

    std::size_t operator()(std::string_view s) const noexcept {
        return std::hash<std::string_view>{}(s);
    }
};

struct SymbolEqual {
    using is_transparent = void;

    bool operator()(std::string_view a,
                    std::string_view b) const noexcept {
        return a == b;
    }
};

int main() {
    std::unordered_map<std::string, int, SymbolHash, SymbolEqual> venue{
        {"XNAS", 1}, {"XNYS", 2}
    };
    return venue.at("XNAS") == 1 && venue.contains(std::string_view{"XNYS"})
             ? 0 : 1;
}
```

Both functors accept every lookup-key type used here, equality is symmetric over those types, and equal text is hashed from the same byte sequence. The transparent marker enables heterogeneous lookup; it does not relax the hash/equality invariant.

---

## 12.1 Ordered containers — Core

`std::map`, `std::set`, `std::multimap`, `std::multiset` keep elements in the order of a strict weak ordering, giving O(log n) lookup, insert, and erase, and O(n) in-order traversal.

The standard specifies the complexity and bidirectional iterators, not the representation. A balanced binary search tree is the usual implementation, often a red-black tree, but portable code may rely only on the observable guarantees.

A typical node stores tree links, balancing metadata, and the payload in a separately allocated object. This is a useful cost model, not a specified layout:

```text
                  [M]
                 /   \
              [F]     [T]
             /  \     /  \
           [B] [J]  [P]  [Z]

lookup: compare -> choose one child -> load that child -> repeat
```

The height is O(log n), so a lookup performs O(log n) comparisons. If `n = 1,048,576`, `log2(n) = 20`: the useful first estimate is “at most a few tens of dependent node visits,” not “20 cache misses.” Upper nodes may remain cached, several nodes may share a cache line by chance, the comparator may dominate for long strings, and allocators can improve or worsen locality. Measure comparison count, cache misses, branch misses, allocation rate, and p50/p99/p99.9 latency on the actual key distribution.

### Interface and guarantees

| Operation | Complexity | Notes |
|---|---|---|
| `find`, `count`, `lower_bound`, `upper_bound`, `equal_range` | O(log n) | |
| `insert`, `emplace` | O(log n) | Amortized constant when the hint is immediately before the insertion position |
| `erase(key)` | O(log n + count) | `count` matters for multi-containers |
| `erase(iterator)` | Amortized O(1) | Does not include finding the iterator |
| `operator[]` (map only) | O(log n) | Default-constructs and inserts if the key is absent |
| `at` | O(log n) | Throws `std::out_of_range` |
| Iteration | O(n) in key order | Bidirectional iterators only |

References, pointers, and iterators are not invalidated by insertion; erasing an element invalidates only handles to that element. This is often the decisive property. Ordered iteration and `lower_bound`/`upper_bound` range queries are the other decisive requirements. Without either requirement, a hash structure becomes a candidate—not an automatic winner.

`operator[]` inserts a value-initialized mapped object if the key is absent, so a read-looking expression can allocate and mutate the tree. Prefer `find`, `at`, or `contains` (C++20) for lookup. `try_emplace` (C++17) does not construct the mapped object from its constructor arguments when the key already exists, although the argument expressions themselves are still evaluated. `insert_or_assign` expresses upsert semantics directly.

The comparator must impose a strict weak ordering: it is irreflexive, asymmetric, transitive, and has transitive equivalence. A `<=` predicate fails immediately because `comp(a, a)` is true. Violating the requirement means the program cannot rely on the container's behavior. Equivalence is `!comp(a, b) && !comp(b, a)`, not necessarily `operator==`; a case-insensitive map can intentionally treat differently cased strings as one key.

### Heterogeneous lookup

```cpp
#include <map>
#include <string>
#include <string_view>

int main() {
    std::map<std::string, int> owning;
    owning.find("a symbol name long enough to allocate"); // temporary string

    std::map<std::string, int, std::less<>> transparent;
    auto it = transparent.find(std::string_view{"AAPL"});  // no temporary string
    return it == transparent.end() ? 0 : 1;
}
```

`std::less<>` is transparent, enabling templated lookup overloads (C++14); C++23 added heterogeneous erasure. Without it, conversion from a character pointer constructs a temporary `std::string`, which may allocate depending on length and that implementation's small-string optimization. With it, the comparison can consume `string_view` directly. This removes temporary construction and any possible allocation, but it does not promise that comparison itself is cheap.

### Node handles and splicing (C++17)

```cpp
auto node = src.extract(key);   // detaches the node, no allocation, no copy
node.key() = new_key;           // mutate the key in place
dst.insert(std::move(node));    // O(log n), no allocation
src.merge(other);                // splice all mergeable nodes into src
```

`extract`/`insert(node_handle)`/`merge` transfer whole nodes without copying their payload and ordinarily without allocating. Node insertion requires compatible allocators; check the preconditions before transferring between differently configured containers. A node handle is the supported way to change an ordered key before reinsertion without constructing a replacement node.

For read-mostly ordered data, `std::flat_map` (§12.6) is often the better default than `map`; the trade-off is O(n) insert/erase and no reference stability.

---

## 12.2 Unordered containers — Core

`std::unordered_map`, `unordered_set`, `unordered_multimap`, `unordered_multiset` (C++11) are hash tables giving average O(1) lookup and insert, worst case O(n).

### What the standard actually requires

The standard does not say "use separate chaining." It specifies observable behavior:

1. `begin()`/`end()` iterate all elements with forward iterators in O(n).
2. Insert never invalidates references or pointers to existing elements (only iterators, and only when it triggers a rehash). Erase invalidates only the erased element's references, pointers, and iterators.
3. A bucket interface is exposed: `bucket_count()`, `bucket(key)`, `bucket_size(n)`, and a `local_iterator` per bucket, itself a forward iterator.
4. `max_load_factor` is queryable and settable at runtime.
5. Average-case complexity for `find`/`insert`/`erase` is O(1).

Requirement 2 rules out storing elements directly in an ordinary open-addressed slot array, because growth moves those elements. Requirements 1 and 3 require forward iteration and observable per-bucket groups. Stable nodes connected to a bucket array satisfy these rules naturally, so standard-library implementations are generally chaining-like. The standard nevertheless names observable behavior, not a physical node or bucket layout.

```text
hash(key) -> bucket index
                |
bucket array: [ ] [*] [ ] [*] [ ]
                   |       |
                   v       v
                 [K,V]   [K,V] -> [K,V]   collision chain
```

The diagram is conceptual. An implementation may organize iteration links, bucket predecessors, cached hashes, and allocations differently. None of those details is portable.

### Cost model

A lookup hashes the key, reduces the hash to a bucket index, reads bucket metadata, and compares keys in that bucket. The reduction might be a remainder, mask, multiply-shift scheme, or something else; it is not specified. The named mechanisms are hash computation, bucket-array access, dependent node loads, equality comparisons after collisions, and possible allocator/cache overhead.

Node-based storage creates dependency chains: the processor cannot load the next node until it has obtained its address. That does not mean every load misses cache. A small hot table may be resident; a large randomly accessed table may generate multiple cache and TLB misses. Hashing can dominate for long strings, while equality can dominate under collisions. This is why throughput from a tight repeated-key benchmark does not predict a cold, random-key p99.

### Hashing

The standard provides `std::hash` support for many library and fundamental types, including strings and string views, but not general `pair` or `tuple` hashing through C++23. For an application type, pass a hash functor to the container or provide a permitted `std::hash` specialization for that user-defined type.

Avoid combining two component hashes with bare XOR: it is symmetric, so `(a,b)` and `(b,a)` collide. A combine operation should preserve order and spread changes across output bits. Hash quality must be judged together with the table's index reduction. Structured keys such as aligned pointers, timestamps, and sequential IDs can share low bits; a power-of-two table that masks those bits needs a mixing stage with good avalanche behavior. Standard-library hash values are not promised to be stable across processes or library versions, so do not persist them as data.

Hash flooding is the adversarial version: chosen inputs can force long collision sequences and expose worst-case linear operations. A keyed or per-process-seeded hash can make collisions difficult to predict, at additional hash cost. In a closed matching-engine feed, accidental structure and reproducibility may matter more; at an Internet-facing boundary, denial-of-service resistance may dominate. State the threat model instead of declaring one universal hash best.

### Hash and equality diagnosis

Suppose a team normalizes venue codes to uppercase in its equality predicate but hashes the original bytes:

```cpp
// Broken by design: Equal("xnas", "XNAS") is true, but their hashes may differ.
struct CaseFoldEqual {
    bool operator()(std::string_view a, std::string_view b) const;
};
```

The bug is not “more collisions.” The equal strings may be placed in different buckets, so lookup can miss and a unique-key map can hold logically duplicate keys. The repair is to apply the same normalization to both operations or store a canonical key. Canonicalization at ingestion often gives the clearest invariant and removes repeated folding work from every lookup.

### Customizing and heterogeneous lookup

The compiling example in “Contracts before costs” shows the complete pattern. Heterogeneous lookup for unordered containers is available since C++20 and requires both the hash and equality types to be transparent. Each functor must also be callable for the stored and lookup-key forms used by the program. If either marker is missing, the heterogeneous overload is unavailable; a call may convert to `Key` when such a conversion exists, or it may fail to compile. C++23 added heterogeneous `erase` and `extract`. All cross-type equality cases must still imply identical hashes.

`unordered_map` also supports `extract`/`insert(node)`/`merge` and `try_emplace`/`insert_or_assign`, for the same reasons as §12.1.

---

## 12.3 Load factor and rehashing — Core

Load factor α = `size() / bucket_count()`. It is the visible knob controlling the standard hash table's memory/collision trade-off; hash distribution and implementation policy matter too.

```cpp
m.load_factor();          // current alpha
m.max_load_factor();      // preferred maximum load; initially 1.0
m.max_load_factor(0.5f);  // settable at runtime
m.rehash(n);              // ensure bucket_count() >= n and >= size()/max_load_factor()
m.reserve(n);             // ensure capacity for n *elements* without a rehash
```

`max_load_factor` is the positive value the container tries to keep its load factor below. Changing it does not itself require an immediate rehash. After lowering it, call `reserve` or `rehash` before relying on the new capacity policy during inserts.

A rehash rebuilds the association between elements and buckets and may allocate a new bucket array. The standard complexity is average linear and worst-case quadratic in the number of elements; common well-distributed workloads look linear. Whether hashes are cached, recomputed, or used with a particular bucket-growth sequence is implementation-specific. Insertion is average constant time but can be linear when it triggers a rehash.

### Rehash as a latency spike

A rehash of a large map can combine allocation, bucket initialization, per-element processing, cache pollution, and allocator synchronization on one operation. That is a tail-latency event (Chapter 43), even when long-run insertion throughput is acceptable. Mitigations:

1. **Set `max_load_factor`, then `reserve(expected_peak)` before the measured phase.** `reserve(n)` is expressed in elements and behaves as a request for at least `ceil(n / max_load_factor())` buckets; `rehash(n)` is expressed directly in buckets.
2. Bound the map's size, or use a fixed-capacity table that never grows.
3. Use an application or third-party table with incremental migration when a bounded per-operation budget matters. This adds migration state and often a second-table check to lookup; standard unordered containers do not expose incremental rehash.
4. Keep the hot path lookup-only; populate and grow the map from a slower path.

### Iterator invalidation

When rehashing actually occurs, it invalidates all iterators but not pointers or references to elements. Erase invalidates only handles to the erased element. None of this licenses unsynchronized access from another thread.

```cpp
for (auto it = m.begin(); it != m.end(); ) {
    if (pred(*it)) it = m.erase(it);   // fine
    else { m.emplace(k, v); ++it; }    // UB if the emplace triggers a rehash
}
```

Erasing elements does not itself rehash. `rehash(0)` can request an unconditional rebuild under the current policy, but the standard provides no `shrink_to_fit` operation and does not promise the smallest possible bucket array. If memory release matters, rebuilding into a fresh container is the explicit, testable strategy—and it invalidates all handles when the old container is replaced.

### Exercise: reserve and load factor

Given `Order { uint64_t id; Price price; Qty qty; }` and a service that expects up to 2,000,000 live orders with an average lifetime of a few seconds, size an `unordered_map<uint64_t, Order>` so that steady-state operation performs zero rehashes: pick a `max_load_factor` and a `reserve` call, and state, in one sentence each, what happens if the peak estimate is wrong in each direction (too low, too high).

```cpp
#include <unordered_map>
#include <cstdint>

struct Price { long long ticks; };
struct Qty   { long long lots; };
struct Order { uint64_t id; Price price; Qty qty; };

std::unordered_map<uint64_t, Order> make_order_table() {
    std::unordered_map<uint64_t, Order> orders;
    orders.max_load_factor(0.5f);   // trade memory for fewer, shorter chains
    orders.reserve(2'000'000);      // request room for this many elements
    return orders;
}
```

At α = 0.5, the request implies at least `ceil(2,000,000 / 0.5) = 4,000,000` buckets, although the chosen `bucket_count()` may be larger. Verify the postcondition by logging the actual count after construction. An underestimated peak can trigger growth in the hot phase; an overestimate consumes bucket memory and can enlarge the cache/TLB footprint. Neither choice changes lookup correctness.

For the latency experiment, replay representative insert/erase/find traffic and record operation-level p50, p99, and maximum latency, allocation count, resident memory, cache/TLB misses where available, and whether any rehash occurred. Compare α values only on the same implementation, hardware, key distribution, peak size, and allocator.

---

## 12.4 Collision resolution — Core

A collision is two distinct keys mapping to the same bucket index; by the birthday bound, collisions begin well before the table is full. Two families of resolution:

**Separate chaining** keeps colliding elements in a per-bucket group, commonly linked through stable nodes.

**Open addressing** searches a deterministic sequence of slots within the table itself. Flat variants usually store payloads inline; node variants may store pointers to separately allocated payloads.

| | Chaining | Open addressing |
|---|---|---|
| Load factor | Can exceed 1 | Must remain below 1; practical limit is design-specific |
| Element stability | Node chaining can preserve addresses | Inline entries can move on growth and mutation |
| Deletion | Trivial unlink | Needs tombstones or backward-shift |
| Memory | One allocation per element plus bucket array | One contiguous array, no per-element allocation |
| Locality | Node links create dependent loads | Adjacent metadata/slots support spatial locality |
| Degradation | Graceful as α grows | Steep as α → 1 (clustering) |
| Suits | Stability requirements, large payloads, simple erase | Small movable entries, dense read-heavy lookup |

The standard unordered stability rules prevent the usual inline open-addressed representation. Non-standard maps can choose a weaker invalidation contract and denser storage. That trade can improve locality and reduce allocation traffic, but it is not a semantic substitute when callers retain element addresses.

### Role-specific deep dive: probe sequences

The rest of §12.4 explains implementation mechanisms. Skip to §12.5 if the interview is about container selection rather than hash-table construction.

| Scheme | Sequence for attempt i | Cache behavior | Clustering |
|---|---|---|---|
| Linear probing | `(h + i) mod m` | Sequential near the home slot | Primary: adjacent runs merge and grow |
| Quadratic/triangular probing | Design-specific increasing offsets | Spreads probes farther apart | Same-home keys share a sequence |
| Double hashing | `(h₁ + i·h₂) mod m` | Effectively random access per probe | Minimal — closest to uniform hashing |

Double hashing reduces clustering under an idealized uniform-hash model. Linear or grouped probing often benefits from adjacent metadata and hardware prefetching. Which wins depends on successful versus unsuccessful lookup ratio, load factor, entry width, hash quality, and cache residency.

With a power-of-two table size, linear probing eventually visits every slot. For double hashing, an odd step is relatively prime to that table size and therefore visits every slot. Quadratic-family coverage depends on the exact recurrence and table size; do not copy constants without proving full coverage. Every lookup must use exactly the same probe rule as insertion.

### Deletion: the hard part

Marking an erased slot empty would break the probe sequence of any key that passed that slot before insertion.

- **Tombstones**: mark the slot deleted; lookups keep probing past it, inserts may reuse it. Simple, but tombstones accumulate under a delete-heavy workload and lengthen probe sequences until a rehash clears them.
- **Backward-shift deletion**: in a compatible linear-probing design, move later entries backward when their lookup paths cross the hole. Erase then costs work proportional to the affected run but avoids tombstone accumulation.

### Robin Hood hashing

Robin Hood hashing is linear probing plus one rule: on insert, if the entry being placed has traveled farther from its home bucket (probe sequence length, PSL) than the entry currently occupying the slot, swap them and continue inserting the displaced entry.

```cpp
// conceptual insert step — not a complete implementation
// insert K (psl=3) into slot i occupied by X (psl=1):
//   3 > 1  ->  place K at i, continue inserting X from i+1 with psl=2
```

For a fixed set of linear-probing placements, swaps redistribute displacement without changing its sum; Robin Hood therefore reduces displacement variance rather than magically removing total probe work. Lower variance can improve the long-probe tail. It also enables early exit: if the occupant has traveled less far than the current search has, the sought key would have displaced it during insertion and therefore cannot appear later under the invariant.

```cpp
// lookup sketch, pseudocode: assumes psl()/hash()/key() accessors on a real table
size_t i = h & mask, d = 0;
for (;;) {
    if (empty(i)) return not_found;
    if (psl(i) < d) return not_found;          // Robin Hood early-exit invariant
    if (hash(i) == h && key(i) == k) return i;
    i = (i + 1) & mask; ++d;
}
```

Costs: insertion may move several existing entries, and deletion must preserve the early-exit invariant. Backward shifting is a common solution; a tombstone scheme is possible only if lookup treats tombstones consistently and does not apply the early-exit test across invalid metadata. Higher usable load factors are possible in some designs, but the supported threshold and invalidation rules belong to the particular library.

---

## 12.5 Flat hash maps — Role-specific / Deep dive

"Flat" usually means elements live inline in dense table storage rather than one allocation per element. The term is conventional, not a standard C++ category, so inspect the actual library contract.

### The conceptual design (SwissTable family)

One influential family separates compact control metadata from payload slots. A control byte can encode empty/deleted state or a fingerprint taken from the hash. Other hash bits select a starting group.

A lookup compares the desired fingerprint against a group of control bytes, often with SIMD or word-at-a-time operations. The result is a candidate mask; every candidate still requires full equality checking because fingerprints collide. Empty metadata can terminate the probe according to the design's rules. The advantage is selective payload access: most nonmatches are rejected from compact metadata.

SwissTable-style designs and F14-style designs are useful names to recognize, but group width, instructions, load policy, allocation scheme, and exception/invalidation contracts change by implementation and version. Check the library documentation and test the exact build.

<details>
<summary>Optional: the SIMD instructions behind the control-byte scan (illustrative, not a complete program)</summary>

```cpp
// Pseudocode/illustrative only — omits key comparison, wraparound, and empty handling.
// __m128i ctrl_group = load 16 control bytes;
// __m128i match = _mm_cmpeq_epi8(ctrl_group, _mm_set1_epi8(h2));
// int mask = _mm_movemask_epi8(match);   // one bit set per candidate slot
// while (mask) { int slot = countr_zero(mask); /* compare full key at slot */ mask &= mask - 1; }
```

</details>

### Choose a contract, then an implementation

| Representation category | Element-address stability | Main cost |
|---|---|---|
| Inline/flat payload | Usually invalidated by growth; insert/erase may also relocate | Moving entries; address-taking is fragile |
| Node payload with open-addressed index | Payload addresses can remain stable | Allocation and an extra indirection |
| Inline pointer or stable handle | Pointee stable if separately owned | Ownership/lifetime complexity and pointer chasing |

### Choosing among them

- For small movable keys and values with no retained addresses, benchmark an inline flat map.
- For large values, consider storing an owning pointer or stable handle, but include the extra allocation and indirection in the measurement.
- For retained element addresses, select a documented node variant or `std::unordered_map`.
- For a fixed known key set, a generated perfect hash can avoid collisions among that set, but membership validation and its control flow still depend on the implementation.

Candidate libraries include Abseil, Boost.Unordered, Folly, and ankerl containers. Naming one is not the decision. Record its exact version, allocator, maximum load policy, exception guarantees, iteration order, and invalidation contract. Benchmark hits and misses separately with representative key/value sizes and distributions; include construction, growth, deletion churn, memory, and latency percentiles, not lookup throughput alone.

---

## 12.6 `std::flat_map` — Core

`std::flat_map`, `std::flat_set`, `std::flat_multimap`, `std::flat_multiset` (C++23, P0429/P1222) are container adaptors, not new containers: they wrap sorted sequence containers behind the `std::map`/`std::set` interface.

```cpp
// Conceptual representation, not the standard library's class definition.
template <class Key, class T, class Compare = std::less<Key>,
          class KeyContainer = std::vector<Key>,
          class MappedContainer = std::vector<T>>
class flat_map {
    KeyContainer    keys_;     // sorted
    MappedContainer values_;   // parallel, same order
};
```

Keys and values are stored in two parallel containers (structure-of-arrays; Chapter 42 §42.2), not one `vector<pair<K,T>>`. A binary search can inspect the key array without streaming mapped values, then access the matching value once.

| Operation | `std::map` | `std::flat_map` |
|---|---|---|
| `find` / `lower_bound` | O(log n), pointer chasing | O(log n), binary search over contiguous memory |
| `insert` / `erase` | O(log n) | O(n) — shifts the tail of both vectors |
| Iteration | O(n), pointer chasing | O(n), contiguous |
| Allocations | Commonly one per element | Amortized sequence growth; no per-element node |
| Reference/iterator stability | Total, except erased element | Follows underlying sequences; default vectors shift suffixes and can reallocate |

A binary search over sorted keys performs logarithmically many comparisons in non-sequential positions. Repeated queries may keep upper search regions cached, while nearby lower positions can share cache lines. That gives `flat_map` a plausible locality advantage over a node tree, not a guaranteed win. Key size, mapped-value size, query distribution, comparator cost, mutation frequency, and cache capacity decide the result.

### API details worth knowing

- `value_type` is `pair<Key, T>`, while iterator dereference returns a proxy `pair<const Key&, T&>` because keys and values occupy separate arrays. `auto p = *it;` therefore deduces a pair of references, not an owning value copy. Write `std::pair<Key, T> p = *it;` when a copy is intended. `auto& p = *it;` cannot bind an ordinary lvalue reference to the temporary proxy; `auto&&` can.
- Iterators are random-access when the required underlying containers are used, but they are not contiguous iterators: there is no adjacent array of `pair<Key, T>` objects behind them.
- A `sorted_unique` constructor asserts through its precondition that input is already sorted and unique according to the comparator. It can avoid sorting, but passing unsorted or duplicate input violates the contract.
- `extract()` returns the underlying key and mapped containers; `replace()` installs suitable replacements. Their size and ordering preconditions protect the parallel-array invariant.
- C++23 specifies effects as **unspecified** when exceptions escape several `flat_map` modifiers. That is weaker than the basic guarantee; do not assume the old elements remain intact or that retrying is safe. Prefer non-throwing moves/assignments for hot-path element types, construct a replacement off-path, and publish it only after success.
- Range insertion has standard complexity bounds, but it does not promise one particular append/sort/merge algorithm. If data already arrives sorted and unique, use the corresponding tagged facilities where their preconditions fit; otherwise benchmark bulk construction against repeated insertion.

`flat_set` needs only the sorted key sequence. For very small sets, a linear scan is a serious candidate because it reads adjacent memory and avoids hashing/setup overhead. There is no portable crossover count; derive it from the actual entry size, query distribution, and target processor.

### Availability

C++23 defines these containers, but language mode and library implementation are separate: a compiler accepting `-std=c++23` does not prove its standard library ships `<flat_map>`. Test the feature-test macro `__cpp_lib_flat_map` after including `<version>` or `<flat_map>`, and gate a fallback deliberately. Third-party “flat map” types can use different layouts and contracts.

For an ordered map that is read- and write-heavy, a third-party B-tree is another candidate: nodes hold multiple entries, reducing tree height and improving in-node locality. Its exact stability and exception contracts are library-specific; Chapter 21 explains the tree mechanics.

Order-book price levels are a canonical example of this trade-off, worked in full in Chapter 50. A direct-indexed tick grid eliminates comparisons when the allowed range and memory footprint are acceptable.

---

## 12.7 Small and dense-key alternatives — Core

Not every lookup problem needs a general-purpose associative container.

- **Very small tables:** compare a flat array and linear scan. It has no bucket array or hash computation, reads adjacent entries, and needs no per-element allocation. The crossover is workload-specific, not a universal 16- or 32-entry rule.
- **Dense bounded integer keys:** compute `index = key - base`, validate the range, and access a slot. This removes hashing, equality chains, and tree comparisons. The cost is memory proportional to the entire key range rather than the live-key count.
- **Fixed key set known ahead of time:** generated perfect hashing can be collision-free for that set. Unknown-key detection, build tooling, code size, and update workflow remain part of the design.

### Direct indexing with an explicit presence state

```cpp
#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

struct Level {
    std::int64_t quantity{};
};

class PriceGrid {
    std::int64_t first_tick_;
    std::vector<std::optional<Level>> slots_;

public:
    PriceGrid(std::int64_t first_tick, std::size_t tick_count)
        : first_tick_(first_tick), slots_(tick_count) {}

    Level* find(std::int64_t tick) noexcept {
        if (tick < first_tick_) return nullptr;
        const auto offset = static_cast<std::uint64_t>(tick - first_tick_);
        if (offset >= slots_.size()) return nullptr;
        auto& slot = slots_[static_cast<std::size_t>(offset)];
        return slot ? &*slot : nullptr;
    }
};

int main() {
    PriceGrid levels{100'000, 2'001};
    return levels.find(99'999) == nullptr ? 0 : 1;
}
```

Production code must avoid signed overflow in `tick - first_tick_`; establish normalized price bounds before subtraction or use a checked conversion. It must also decide whether pointers into the grid remain valid. Fixed-size construction keeps slot addresses stable, but replacing the vector, moving the grid, or resizing it can invalidate them.

The sizing calculation is concrete. If a bounded instrument spans 20,001 ticks and each slot consumes 32 bytes including presence metadata and alignment, the grid is about 640,032 bytes. If only 40 levels are normally populated, the density is about 0.2%; a sparse ordered structure may use less memory. The grid can still win when deterministic arithmetic lookup and stable preallocation matter more than footprint. Confirm with resident memory, cache/TLB events, and p99 lookup/update latency.

### A selection flow

```text
Need sorted iteration, predecessor/successor, or range queries?
  yes -> Is mutation rare and address stability unnecessary?
           yes -> benchmark std::flat_map
           no  -> start with std::map; benchmark a documented B-tree if allowed
  no  -> Is the key a dense bounded integer range?
           yes -> direct index, after a memory/range calculation
           no  -> Is the set tiny or fixed?
                    yes -> linear scan or generated perfect hash
                    no  -> Need stable element addresses?
                             yes -> std::unordered_map or documented node hash map
                             no  -> benchmark a flat/open-addressed map
```

This flow orders semantic questions before performance guesses. A final choice still needs expected peak size, mutation mix, hit/miss ratio, key distribution, ownership model, concurrency plan, allocator, and latency target.

---

## 12.8 Comparison table — Core

| | `std::map` | `std::unordered_map` | `std::flat_map` | Open-addressed flat hash map |
|---|---|---|---|---|
| Underlying structure | Typically node-based balanced search tree | Typically node-based, chaining-like hash table | Two sorted, parallel sequences | Open-addressed slots plus metadata |
| `find` complexity | O(log n) | O(1) average, O(n) worst | O(log n) | O(1) average, O(n) worst |
| `insert`/`erase` complexity | O(log n) | O(1) average | O(n) | O(1) average, amortized for growth |
| Ordered iteration | Yes | No | Yes | No |
| Allocation mechanism | Commonly one node allocation per insert | Commonly one node allocation per insert, plus bucket growth | Underlying sequence growth | Table growth; usually no allocation per entry |
| Reference/pointer stability | Stable except erased element | Stable except erased element | Follows sequences; default vector mutation can move values | Usually weak; library-specific |
| Iterator stability | Stable except erased element | Invalidated by a rehash | Follows sequences; suffix shifts/reallocation invalidate | Library-specific, commonly weak |
| Locality mechanism | Dependent tree links | Bucket access plus dependent node links | Binary search over contiguous keys | Grouped metadata and nearby slots |
| Tail-latency risk | Allocation and comparison-depth variance | Growth/rehash, allocation, collision chains | Linear shifts and sequence reallocation | Growth/rehash and long probe clusters |
| Hash requirement | None | Equal keys hash equally; distribution must suit keys/policy | None | Same invariant; low-bit quality is often important |

The complexity columns establish asymptotic work. The locality, allocation, invalidation, and tail-risk rows usually decide among containers with equally acceptable semantics.

---

## 12.9 HFT case study — Core

A matching engine typically needs three different lookup structures for three different access patterns:

1. **Order-ID lookup** supports cancel/replace by an exact 64-bit key. It needs no order or range query. If orders live in a separate stable pool, a flat hash table from ID to handle/pointer is a strong candidate because relocating table entries does not relocate the orders. If the map stores `Order` objects and queues retain their addresses, use stable storage or a node container. Reserve for the maximum live-order count before trading. A direct index is viable only when the ID-to-slot mapping is bounded and stale-ID reuse is prevented, commonly with a generation counter.
2. **Price levels** need best price, next price, and price-range traversal. Those semantics are ordered. A direct tick grid is attractive when venue limits yield a manageable range; arithmetic lookup and preallocation trade memory for predictable access. A sparse/unbounded range points first to `std::map`; a read-mostly snapshot may suit `std::flat_map`. Frequent middle insertions make vector-backed flat maps less attractive. Chapter 50 develops the full book design.
3. **Reference data** maps symbols or venue codes to contract specifications. It is often built off-path and then read without mutation. A sorted flat map provides ordered diagnostics and compact storage; a flat hash map provides unordered exact lookup; a linear table remains competitive when the set is genuinely small. A generated perfect hash is appropriate only if the operational update process tolerates regeneration.

The pattern to internalize: match the container to the access pattern and mutation frequency of that specific lookup, not to a single default for "the map" in the system.

### Worked diagnosis: excellent average, bad cancel tail

Assume an order gateway reports acceptable average cancel latency but periodic p99.99 spikes. A profiler shows the spikes inside `unordered_map::emplace`, not `find`. The order table starts empty each session, receives bursts up to 1.3 million live orders, and was reserved for 1 million. The current load factor before a spike is near its configured maximum.

Reason in this order:

1. **Correctness and handles:** callers retain `Order*` values stored in the table, not pointers to the table's `pair`. Rehash therefore does not invalidate those `Order` objects. Iterators are not retained. Changing capacity policy is semantically safe.
2. **Mechanism:** crossing the capacity policy triggers a rehash during burst insertion. Rebuilding buckets is large, burst-correlated work; the average hides the single-operation stall.
3. **Immediate experiment:** set the load policy first, reserve for a defensible upper bound such as the venue/session risk limit, warm the table, and log `bucket_count()` plus allocation events. Replay the same burst.
4. **Success measure:** no rehash during the trading phase and improved p99.9/p99.99 insertion latency without unacceptable resident-memory or cache/TLB regression. Find latency must also remain within target.
5. **Trade and rollback:** the larger bucket array consumes memory even during quiet periods. If the bound is too costly or truly unknown, evaluate a fixed-capacity table with explicit overflow handling or an incrementally growing third-party design. Keep the standard implementation as the rollback until the alternative's semantics and failure policy are verified.

Now change one fact: price-level iterators are retained by orders. Replacing the price-level `std::map` with `std::flat_map` to improve lookup locality would invalidate those associations during insertion and erasure. That proposal fails at the correctness boundary before benchmarking. The viable redesign must first replace iterators with stable IDs/handles or retain a stable-address structure.

---

## Recall and practice — Core

### Recall card

- Ordered equivalence comes from the comparator; unordered equality must imply identical hashes. Stored keys must not change in a way that changes their placement.
- `map`/`set`: logarithmic lookup/mutation, ordered range operations, and iterator/reference stability except for erased elements. A node-based balanced tree is typical, not specified.
- `unordered_map`'s reference-stability and bucket guarantees favor node-based, chaining-like designs; the standard does not name a physical layout.
- Load factor α = size/buckets; an adequate pre-trading `reserve()` avoids growth rehashes on the hot path; `reserve(n)` means elements, `rehash(n)` means buckets.
- Open addressing improves spatial locality and avoids per-element nodes, but weakens address stability and develops long probes near its design's capacity limit.
- Robin Hood insertion redistributes displacement to reduce variance; grouped-metadata designs reject most slots before loading full keys.
- `std::flat_map` stores sorted parallel key/value sequences: logarithmic lookup, linear mutation, proxy references, sequence-dependent invalidation, and weak exception outcomes for several modifiers.
- Always benchmark a linear table for a truly small set and calculate direct-index memory for a dense bounded integer range.

### Common traps

- Using `operator[]` as a lookup and accidentally inserting or allocating.
- Assuming `std::map` is specified as a red-black tree or `std::unordered_map` as one exact chaining layout.
- Treating average O(1) as bounded time, or ignoring collision attacks and rehash spikes.
- Calling `reserve` before changing `max_load_factor`, then assuming the old reservation matches the new policy.
- Keeping an unordered iterator across rehash because a pointer/reference would have survived.
- Mixing case-insensitive equality with case-sensitive hashing, or mutating state used by a comparator.
- Assuming transparent lookup always allocates zero bytes without checking that all cross-type operations avoid materializing `Key`.
- Treating `auto p = *flat_map.begin()` as an owning `pair<Key, T>` rather than a pair-of-references proxy.
- Selecting a non-standard flat map from benchmark rank without checking its versioned invalidation, exception, allocator, and overflow contracts.

### Questions

1. What complexity and stability guarantees does the standard place on `std::map`, independent of implementation?
2. Which `unordered_map` guarantees prevent an ordinary inline open-addressed representation?
3. What does `reserve(n)` mean for an `unordered_map`, and how does it differ from `rehash(n)`?
4. Why does a masked, power-of-two hash table need an avalanche/finalizer step even when a plain modulo table would work with the same weak hash?
5. What does Robin Hood hashing optimize, and what does it leave unchanged?
6. Why can't `absl::flat_hash_map` offer the same reference stability as `std::unordered_map`?
7. Given a read-mostly ordered dataset with rare mutation, justify choosing `std::flat_map` over `std::map`.
8. Why is “basic exception guarantee” too strong a blanket claim for C++23 `flat_map` modifiers, and how would you structure an off-path update?
9. For an order-ID cancel/replace table, a price-level book, and a static symbol table, name the container you'd reach for first and the one property that decided it.
10. Why does a linear scan over a small array often beat both a hash table and a balanced tree?

### Code-reading puzzle

```cpp
#include <iostream>
#include <unordered_map>

int main() {
    std::unordered_map<int, int> m;
    for (int i = 0; i < 1000; ++i) m.emplace(i, i * i);

    int* p = &m[42];
    m.reserve(m.size() * 4);
    std::cout << *p << "\n";   // what happens here, and why?
}
```

Is `*p` well-defined? What would change if `p` were an iterator instead of a pointer, and what would change if `m` were an `absl::flat_hash_map` instead?

### Design exercise

Implement a fixed-capacity open-addressed integer map (`int32_t` keys, `int64_t` values) using linear probing and backward-shift deletion, with a compile-time capacity and no dynamic allocation. Require: a sentinel key value for empty slots (state what happens if a caller tries to insert that sentinel), a finalizer applied to `std::hash<int32_t>` before masking, and a `full()` check that fails fast instead of looping forever when the table is saturated. Test it with an adversarial key set that collides under the identity hash but not under your finalizer.

### Prerequisites for Chapter 13

Chapter 13 assumes you can distinguish an owning container from a non-owning view without needing to relearn it — in particular, that a `std::string` key in a `map`/`unordered_map` owns its buffer while a `string_view` used for heterogeneous lookup does not, and that the transparent-comparator examples in this chapter (`m.find(std::string_view{...})`) rely on the view outliving the call, not on any extended lifetime guarantee from the container.
