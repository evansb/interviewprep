# Chapter 21 — Core Data Structures

*Interview-focused revision notes. The theme: asymptotics choose the candidate structures, but memory layout chooses the winner — every structure here is evaluated by cache lines touched and pointer chases incurred, not just by big-O.*

---

## 21.1 Arrays and Dynamic Arrays

An **array** is N elements of one type at consecutive addresses. Element `i` is at `base + i * sizeof(T)` — a single multiply-add, no memory access to find it. That address arithmetic is the reason arrays dominate: random access is O(1) with no indirection, iteration is sequential so the hardware prefetcher (Ch. 28) streams ahead of you, and the compiler can vectorize the loop.

A **dynamic array** (`std::vector`, Ch. 11 §11.2) adds a heap buffer, a size, and a capacity, growing by reallocating and moving. The amortized-O(1) `push_back` argument: with **geometric growth** by factor `k`, inserting N elements copies at most `N·k/(k-1)` elements total, so the per-insert average is constant. With *arithmetic* growth (`capacity += C`) the total is O(N²/C) — quadratic — which is why "grow by 100" is always wrong.

### The growth-factor argument

| Factor | Memory overhead | Can reuse freed blocks? |
|---|---|---|
| 2 (libstdc++, libc++) | Up to 100% slack | **No** — the sum of all previous allocations `1+2+…+2^(n-1) = 2^n − 1` is always just short of the next request, so the allocator can never coalesce old blocks into the new one |
| 1.5 (MSVC, folly) | Up to 50% slack | **Yes**, eventually — any factor < φ ≈ 1.618 lets earlier freed blocks be reused |

This is the classic interview follow-up. In practice the difference is dominated by allocator behavior (a good allocator may `mremap` large blocks and never copy at all), so the honest answer names both the theory and its limited practical weight.

### Costs and controls

- **`reserve()` before a known-size fill** is the single highest-value optimization: it converts log₂(N) reallocations, each a full copy plus a `malloc`/`free` pair, into one allocation. It also prevents iterator/pointer invalidation (Ch. 11 §11.8).
- **`shrink_to_fit()` is non-binding** and, if honored, reallocates.
- **`resize()` value-initializes**, which for `vector<char>` means a `memset` of the whole buffer — a real cost when you are about to overwrite it. C++26's `std::uninitialized_value_construct`-style workarounds, a custom default-init allocator, or `reserve` + `insert` avoid it.
- **`vector<bool>` is a bitset proxy specialization**, not a container of `bool`; `&v[0]` does not yield `bool*` and `auto& x = v[i]` fails. Use `std::vector<char>`, `std::bitset` (Ch. 15 §15.6), or `boost::dynamic_bitset`.

### Fixed-capacity alternatives

`std::array<T,N>` (Ch. 11 §11.1) is the array with no allocation and no indirection — the correct default for a bounded collection on a hot path. C++26's `std::inplace_vector<T,N>` (Ch. 11 §11.6) adds a runtime size with the buffer inline, giving `vector` semantics with zero allocation — exactly what an order-book price level or a fixed-arity message needs. **Small-vector optimization** (`llvm::SmallVector`, `boost::container::small_vector`) combines both: inline storage up to N, heap beyond.

**Low-latency framing:** on the hot path, a `vector` whose capacity was reserved at startup and never exceeded is allocation-free and cache-optimal, and beats every "smarter" structure below a few hundred elements. Linear scan of a contiguous array is faster than a tree or hash lookup up to surprisingly large N (typically 16–64 elements for 4–8 byte keys) because a scan is one or two cache lines with perfect prefetch, while a lookup is a dependent chain of misses.

---

## 21.2 Linked Lists

A **singly linked list** node holds a value and a `next` pointer; a **doubly linked** node adds `prev`. `std::forward_list` and `std::list` (Ch. 11 §11.5) are the standard versions.

### What they actually buy

| Operation | Linked list | Dynamic array |
|---|---|---|
| Insert/erase **given a position** | O(1), no element movement | O(n) shift |
| Insert/erase **found by value** | O(n) to find, O(1) to splice | O(n) to find, O(n) to shift |
| Random access | O(n) | O(1) |
| Splice a whole range between lists | O(1) (`std::list::splice`) | O(n) |
| Reference/iterator stability | Total — only the erased node is invalidated | None across reallocation |
| Memory per element | Value + 2 pointers + allocator header/rounding (often 32 B for an `int`) | `sizeof(T)`, plus slack |

The two genuine reasons to use one are **reference stability** (pointers into the list stay valid across any other mutation — essential for order books where you hand out handles) and **O(1) splice**. Its notional advantage — cheap middle insertion — is usually false in practice because *finding* the position is the expensive part.

### Why they are slow

Each node is a separate allocation at an arbitrary address. Traversal is a **dependent load chain**: the address of node i+1 is not known until node i's load retires, so the CPU cannot overlap misses, memory-level parallelism (Ch. 29 §29.4) is 1, and the prefetcher has nothing to predict. A list traversal of N nodes scattered across memory costs ~N × 80–100 ns; the equivalent vector scan costs ~N × 0.3 ns amortized. **Two orders of magnitude** is the number to quote. Bjarne Stroustrup's famous benchmark — vector beats list even for insertion-heavy workloads with linear search — is the canonical citation.

Mitigations: allocate nodes from a **pool or arena** (Ch. 7 §7.7) so they are contiguous and in allocation order, which restores prefetcher traction; or use an **unrolled linked list** (a node holds an array of K elements plus a pointer), which amortizes the pointer chase over K elements and is what `std::deque` (§21.3) effectively is.

### Standard-library specifics

- `std::list::size()` is O(1) since C++11 (mandated), which cost `splice(pos, other, first, last)` its O(1) — that overload is O(distance) because the size must be recomputed.
- `std::forward_list` has no `size()` at all and uses `insert_after`/`erase_after`, because a singly linked list cannot cheaply insert *before* an iterator. It exists purely to save the `prev` pointer.
- `std::list::sort` is a bottom-up merge sort using splices: O(n log n) comparisons, **no allocation**, and stable — the one place a list genuinely wins over `std::sort`, which needs random access.

**Interview position:** default to `vector`; reach for a list only when you need stable references *and* O(1) unlink, and when you do, prefer an **intrusive** list (§21.5) over `std::list`.

---

## 21.3 Stacks, Queues, and Deques

These are **abstract data types** (interfaces), not layouts — which is precisely why `std::stack`, `std::queue`, and `std::priority_queue` are *container adaptors* parameterized on an underlying container.

```cpp
std::stack<T, std::vector<T>> s;                 // vector is usually the best stack backing
std::queue<T, std::list<T>> q;                   // default is deque
std::priority_queue<T, std::vector<T>, Cmp> pq;  // vector is the mandated-in-practice choice
```

- **Stack** — LIFO. Requires `back()`, `push_back()`, `pop_back()`. `std::vector` is the ideal backing: contiguous, one bounds-relevant pointer, perfect locality. The default is `std::deque`, chosen for its non-invalidating growth; override it.
- **Queue** — FIFO. Requires `front()`, `back()`, `push_back()`, `pop_front()`. `std::vector` cannot back it (no O(1) `pop_front`); `std::deque` or `std::list` can. For a bounded FIFO, a **circular buffer** (§21.4) is strictly better than either.
- **Adaptors are not containers**: no iterators, no `begin()`/`end()`. That is intentional — the interface is the point — but it means you cannot inspect a `priority_queue` without deriving from it to reach the protected `c` member (a legitimate, if ugly, technique).

### `std::deque`

A **double-ended queue** supporting O(1) push/pop at both ends and O(1) random access. Implementation (Ch. 11 §11.4): a **map** (array) of pointers to fixed-size **chunks**. `operator[]` is two dependent loads — index into the map, then into the chunk — plus a division/shift by the chunk size.

| | libstdc++ | libc++ | MSVC |
|---|---|---|---|
| Chunk size | max(512 B, sizeof(T)) → 512/sizeof(T) elements | 4096 B worth (16 elements min) | **16 bytes** — pathological for small T |

MSVC's 16-byte block is a well-known defect: `deque<int>` allocates one block per 4 elements, making it slower than `list`. Quoting this is a strong signal of practical experience.

Deque properties that matter:
- **`push_back`/`push_front` do not invalidate references** to existing elements (they do invalidate *iterators*). This is unique among the standard sequence containers and is the reason `deque` is the default adaptor backing.
- Iteration is ~as fast as `vector` within a chunk but has a branch and a pointer indirection at each chunk boundary, and it does not vectorize across boundaries.
- Memory is never returned on `pop`, and `deque` never shrinks its map.

**Low-latency verdict:** for a hot single-producer/single-consumer path use a fixed-capacity ring (§21.4), which is one allocation at startup, contiguous, index-arithmetic-only, and lock-free-able. `deque` is the right general-purpose answer and the wrong hot-path answer.

---

## 21.4 Circular Buffers

A **circular (ring) buffer** is a fixed-capacity array with a head and tail index that wrap. It is the single most important data structure in low-latency systems: bounded memory, one allocation ever, contiguous storage, and no node management.

```cpp
template <class T, std::size_t N>            // N a power of two
class Ring {
    static_assert((N & (N - 1)) == 0);
    alignas(64) std::size_t head_ = 0;       // consumer
    alignas(64) std::size_t tail_ = 0;       // producer  — separate cache lines
    std::array<T, N> buf_;
public:
    bool push(const T& v) {
        if (tail_ - head_ == N) return false;          // full
        buf_[tail_ & (N - 1)] = v;
        tail_++;                                        // release in the atomic version
        return true;
    }
};
```

### Design decisions, each an interview question

**Full-vs-empty disambiguation.** With only `head` and `tail` indices modulo N, `head == tail` is ambiguous. Three fixes:
1. **Monotonic counters** (above): never wrap the indices, only the *masked* value. `size = tail - head`, full when `size == N`. Unsigned arithmetic makes wraparound of the counters themselves correct (a 64-bit counter never wraps in practice; a 32-bit one wraps after 4 G operations and still works because the subtraction is modular).
2. **Sacrifice one slot** — full when `(tail+1) % N == head`. Costs a slot, keeps indices small.
3. **A separate count** — needs its own atomic in a concurrent setting, adding a contended cache line. Worst choice for MPMC.

**Power-of-two capacity** replaces `%` (a 20–40 cycle integer division) with `& (N-1)` (1 cycle). Non-power-of-two rings must use a conditional subtract (`if (++i == N) i = 0;`) — a well-predicted branch, still cheaper than division.

**False sharing.** Producer and consumer write different indices. If they share a cache line, every push invalidates the consumer's line and vice versa — MESI ping-pong costing ~100 ns per operation instead of ~2 ns. `alignas(64)` on each (Ch. 3 §3.3) is mandatory. The next refinement is **cached indices**: each side keeps a local copy of the other's index and only re-reads the shared one when its cached value says the ring is full/empty, cutting cross-core reads by orders of magnitude. This is the core trick in a fast SPSC queue (Ch. 26 §26.3).

**Overwrite vs reject when full.** Market-data flight recorders overwrite (newest data matters); order pipelines reject and apply backpressure (Ch. 52 §52.15). The policy must be explicit — silent overwrite in an order path is a lost order.

**Storage and lifetime.** For non-trivial `T`, a ring should hold raw aligned storage and placement-new/destroy on push/pop, not default-construct N objects up front. For trivially copyable `T` (the normal case for messages) the simple array is correct and lets the compiler use wide stores.

Standard/library options: `boost::circular_buffer` (general, not lock-free), `folly::ProducerConsumerQueue` (SPSC, the reference implementation), and the SPSC/MPMC designs in Ch. 26. A **magic ring buffer** — mapping the same physical pages twice consecutively with `mmap` so a wrapped record is contiguous in the virtual address space — eliminates split-record handling in packet parsers and is a strong detail to know.

---

## 21.5 Intrusive Lists

In an **intrusive** container the link pointers live *inside* the element, rather than in a separately allocated node that points to the element.

```cpp
struct Hook { Hook* next; Hook* prev; };
struct Order {
    OrderId  id;
    Price    px;
    Hook     book_hook;      // membership in a price level's list
    Hook     lru_hook;       // membership in an LRU list — SAME object, two lists
};
```
Recovering the element from the hook uses the `container_of` idiom (Ch. 3 §3.11): subtract `offsetof(Order, book_hook)` from the hook pointer.

### Why it matters

| | `std::list<Order>` | Intrusive list |
|---|---|---|
| Insert | Allocate node (~50–100 ns + fragmentation) | Zero allocation — write two pointers |
| Erase given an `Order*` | Must find the iterator first | **O(1) with no lookup** — the hook is right there |
| Cache misses to reach the value | Node, then the value if stored indirectly | One — the hook and the data are the same object |
| Memory | Value + node header + allocator rounding | Value + 2 pointers, in the same cache line |
| Membership in k lists | k separate node allocations | k hooks, no allocation |
| Ownership | Container owns elements | **Container does not own anything** |

The "erase given a pointer to the element" property is the decisive one for trading systems: a cancel message carries an order ID, you look it up once in a hash map to get an `Order*`, and unlinking it from its price level is then two pointer writes — no second search, no node lookup. With `std::list` you would need to store an iterator alongside the order, which is a `std::list` iterator (a node pointer) and works but re-adds the node allocation.

### Costs and hazards

- **You manage lifetime.** Destroying an element that is still linked corrupts the list. Boost.Intrusive's `auto_unlink` hooks (with `safe_link`/`auto_unlink` link modes) unlink in the hook's destructor, at the cost of the list's `size()` becoming O(n) and losing thread-safety of the destructor.
- **An element can belong to only the lists it has hooks for** — the set is fixed at compile time.
- **No value semantics**: copying an element copies its hooks, producing a corrupt second membership. Delete the copy operations or clear hooks on copy.
- **The type must be modified** to add hooks, so you cannot intrusively store `int` or a third-party type without a wrapper.

`boost::intrusive::list`, `slist`, `set` (an intrusive red-black tree), and `unordered_set` are the production implementations; the Linux kernel's `list_head`/`hlist` is the same design in C. Use the size-tracking option deliberately: `constant_time_size<false>` makes `size()` O(n) but removes a counter update from every splice.

---

## 21.6 Indexed and Free Lists

The refinement of intrusive structures for maximum locality: replace pointers with **indices into a preallocated slab**.

```cpp
struct Node { Value v; uint32_t next; };        // next is an INDEX, not a pointer
std::array<Node, CAP> slab;
uint32_t free_head;                              // head of the free list
uint32_t alloc() { uint32_t i = free_head; free_head = slab[i].next; return i; }
void     free_(uint32_t i) { slab[i].next = free_head; free_head = i; }
```

A **free list** threads the unused slots through the same storage the live data occupies — the `next` field of a free node overlays the payload — so an object pool costs zero extra memory and allocation/deallocation are each three instructions with no `malloc` involved (Ch. 7 §7.9, §7.10).

### Why indices beat pointers

| Property | Pointer | 32-bit index |
|---|---|---|
| Size | 8 bytes | 4 bytes — **halves node size**, doubling nodes per cache line |
| Valid after the slab is relocated/resized | No | Yes |
| Valid in another process (shared memory) | **No** | **Yes** — Ch. 3 §3.12 |
| Serializable / persistable | No | Yes |
| Bounds-checkable | Only with extra metadata | `i < CAP` is one compare |
| Cost to dereference | One load | `base + i*sizeof(Node)` — an LEA, folded into the addressing mode |

Halving link size is a real throughput win: a node with a value and two 32-bit indices fits where one with two pointers does not, and a hot linked structure's miss rate scales with nodes per line. Shared-memory validity is why every interprocess ring, order book, and slab in a trading system is index-based.

### The ABA and stale-handle problem

An index alone cannot tell you whether the slot was recycled. Two standard fixes:

- **Generation counters (handles).** Store `{index: 24 bits, generation: 8 bits}` in a 32-bit handle and a generation per slot; bump the generation on free. Dereferencing checks the generation and rejects stale handles. This turns use-after-free from silent corruption into a detectable error, and is the standard design in game engines and exchange gateways alike.
- **Tagged indices for lock-free use.** A lock-free free list pushes/pops with a CAS on `{head_index, tag}` packed into 64 bits; the tag defeats ABA (Ch. 26 §26.10) without needing double-width CAS on pointers.

### Practical notes

- Size the slab at startup from a capacity bound (max open orders, max book levels) and treat exhaustion as a risk event, not an allocation failure — the whole point is that steady-state behavior has no `malloc` (Ch. 55 §55.1).
- A **freshly built** free list should be in ascending index order so early allocations are sequential; after churn the list order becomes scrambled and locality degrades. Periodically rebuilding, or using a bitmap + `countr_zero` (Ch. 15 §15.7) to always allocate the lowest free slot, keeps live objects packed at the front.
- Compared to a bitmap allocator, a free list is O(1) with worse locality of *the free list itself*; a bitmap is O(words scanned) with excellent locality and gives you first-fit packing for free.

---

## 21.7 Hash Tables

(Ch. 12 §12.2–§12.7 covers `unordered_map`, collision resolution, load factors, open addressing, Robin Hood, and flat maps in depth; this section is the structural recap and the decision framework.)

A hash table maps a key to a bucket index via `h(k) mod m`, giving expected O(1) lookup under the **simple uniform hashing** assumption. Everything interesting is in what happens when two keys collide and how memory is arranged.

### The two families

| | **Chaining** (`std::unordered_map`) | **Open addressing** (flat maps) |
|---|---|---|
| Collision handling | Bucket holds a pointer to a node list | Probe other slots in the same array |
| Layout | Bucket array of pointers + one heap node per element | One contiguous array of slots |
| Cache misses per lookup | ≥ 2 (bucket, then node), more per chain step | Usually 1, often 0 extra with SIMD metadata |
| Load factor ceiling | > 1 tolerable | Must stay < ~0.875; degrades sharply near 1 |
| Reference stability | **Stable** — mandated for `unordered_map` | None; any insert may rehash and move everything |
| Erase | Unlink a node | Needs tombstones or backward-shift |
| Iterator invalidation | Only rehash invalidates iterators; references never | Everything on rehash |

**The standard's mandate is the point.** `std::unordered_map` is required to provide stable references and bucket-based iteration (`bucket_count`, `local_iterator`), which forces node-based chaining. That single specification decision is why every performance-conscious codebase replaces it: `absl::flat_hash_map`, `boost::unordered_flat_map`, `ankerl::unordered_dense`, and `folly::F14` are typically 2–5× faster on lookup-heavy workloads. Being able to state *why the standard container is slow* — not just that it is — is the expected answer.

### Probing and the SIMD trick

Linear probing has the best locality (subsequent probes are the same or the next cache line) but suffers **primary clustering**. Quadratic probing and double hashing break clusters at the cost of locality. **Robin Hood** hashing (Ch. 12 §12.6) bounds probe-sequence variance by displacing richer entries, which makes lookup times tight — valuable for tail latency specifically.

Swiss tables (`absl`, `boost::unordered_flat_map`) store a **one-byte control word per slot** holding 7 bits of the hash plus an empty/deleted marker, packed in groups of 16. A lookup loads one 16-byte control group, compares all 16 with one SSE2 `_mm_cmpeq_epi8` + `movemask`, and gets a bitmask of candidate slots — typically resolving in **one cache line and one key comparison**. This is the design worth being able to describe in an interview.

### Practicalities

- **Hash quality dominates.** `std::hash<int>` is the identity on libstdc++, so integer keys with low entropy in the low bits (pointers, aligned IDs, sequence numbers × 8) collide catastrophically in a power-of-two table. Mix (`fibonacci hashing`: `h * 0x9E3779B97F4A7C15 >> (64-b)`, or wyhash/xxhash finalizers) before masking.
- **Prime vs power-of-two modulus.** Prime `m` tolerates bad hashes but costs a division (~20–40 cycles); power-of-two costs a mask but requires a good hash. libstdc++ uses primes; the fast third-party tables use power-of-two plus mixing. This trade-off is a frequent question.
- **`reserve()`** before bulk insertion avoids O(log n) rehashes, each of which is a full re-insert of every element.
- **Rehashing is a latency spike** — a single insert can be O(n). On a hot path, size the table at startup so it never rehashes, and assert on load factor.

---

## 21.8 Binary Search Trees

A **BST** maintains the invariant that every node's left subtree holds smaller keys and its right subtree larger ones, giving in-order traversal in sorted order and O(h) search where `h` is height. The entire subject is about controlling `h`.

```
        50
       /  \
     30    70          search(35): 50 → 30 → 40 → ... ; each step is a
    /  \     \         DEPENDENT load: one full cache miss per level
  20    40    80
```

An unbalanced BST built from sorted input degenerates to a linked list: `h = n`, search O(n). Since sorted or near-sorted input (timestamps, sequence numbers, incrementing IDs) is the *normal* case in trading systems, an unbalanced BST is not merely a theoretical risk.

### Operations

- **Search / insert** — descend comparing; insert at the null child found.
- **Delete** — three cases: leaf (unlink), one child (splice the child up), **two children** (replace the key with its in-order predecessor or successor — the rightmost node of the left subtree or leftmost of the right — then delete that node, which has at most one child). The two-child case is the one candidates fumble.
- **Successor** — if a right child exists, the leftmost node of the right subtree; else walk up until you come from a left child. This is what `++` on a `std::map` iterator does, and it is O(1) amortized over a full traversal but O(log n) worst case per step.

### Balancing landscape

| Structure | Balance invariant | Height bound | Rotations per insert / delete | Character |
|---|---|---|---|---|
| **AVL** (§21.9) | \|balance factor\| ≤ 1 | ≤ 1.44 log₂ n | ≤ 1 / O(log n) | Read-optimized |
| **Red-black** (§21.10) | No two consecutive reds; equal black-height | ≤ 2 log₂(n+1) | ≤ 2 / ≤ 3 | Write-optimized |
| **Treap / randomized BST** | Heap order on random priorities | O(log n) expected | O(1) expected | Simple, probabilistic |
| **Splay tree** | Move accessed node to root | O(log n) *amortized* | O(1) amortized | Self-adjusting, great with locality, bad worst case, **mutates on read** |
| **Scapegoat** | Rebuild a subtree when α-unbalanced | O(log n) | Amortized rebuild | No per-node metadata |

### The cache reality

A balanced BST of 1 M nodes has height ~20; each level is an independent, dependent cache miss because the child address comes from the node just loaded. That is ~20 × 80 ns ≈ 1.6 µs worst case with a cold cache — versus one or two misses for a hash lookup and versus ~4 levels for a B-tree of the same size (§21.14). **This is why `std::map` loses to `absl::btree_map` and to flat sorted vectors for most real workloads**, and it is the answer expected when an interviewer asks why `std::map` is slow. Use a BST when you need ordered iteration, range queries, and reference stability *and* the container is mutated often enough that a sorted vector's O(n) insert loses; otherwise use a flat structure (Ch. 12 §12.8).

---

## 21.9 AVL Trees

The first self-balancing BST (Adelson-Velsky and Landis, 1962). Invariant: for every node, the heights of its two subtrees differ by at most 1. Each node stores a **balance factor** (−1, 0, +1 — two bits, though usually a full height field).

### Rebalancing

After an insert, walk up from the new leaf recomputing balance factors. If a node becomes ±2, apply one of four rotations, named by the direction of the two steps down to the deepest subtree:

```
LL (single right rotation)          LR (left then right)
      z                x                   z                  x
     / \              / \                 / \               /   \
    y   D    →       y   z               y   D     →       y     z
   / \              / \ / \             / \              / \   / \
  x   C            A  B C  D           A   x            A   B C   D
 / \                                      / \
A   B                                    B   C
```
Mirror images give RR and RL. Each rotation is O(1): a handful of pointer writes.

**The asymmetry to remember:** an **insertion** needs at most **one** rotation (single or double) — the rotation restores the subtree's original height, so rebalancing stops there. A **deletion** may need **O(log n)** rotations, because a rotation can shorten the subtree, propagating the imbalance to the parent all the way to the root.

### AVL vs red-black

| | AVL | Red-black |
|---|---|---|
| Height bound | ≤ 1.44 log₂ n — **strictly tighter** | ≤ 2 log₂ n |
| Comparisons per lookup | Fewer (~10–20% fewer on average) | More |
| Rotations per insert | ≤ 1 | ≤ 2 |
| Rotations per delete | **O(log n)** | ≤ 3 |
| Metadata per node | Height or 2-bit balance factor | 1 colour bit (usually stolen from a pointer's low bits) |
| Used by | In-memory indexes, some databases, `boost::intrusive::avl_set` | `std::map`/`std::set`, Linux CFS (`rbtree`), Java `TreeMap` |

The one-line summary: **AVL is more rigidly balanced, so lookups are faster and updates are more expensive; red-black is the opposite.** Choose AVL for read-heavy workloads (a reference-data index built once and queried constantly), red-black for mixed. Given that the standard chose red-black, knowing *why* — bounded rotation count on delete, and the fact that mixed workloads dominate — is the interview point.

Both are subject to §21.8's cache argument: at a million elements, AVL's height advantage (20 vs 28 levels worst case) is a real ~8 avoided cache misses, but a B-tree at 4 levels beats both by a wide margin. AVL's practical niche today is intrusive, pointer-stable, ordered containers where you cannot use a B-tree because you need stable node addresses.

---

## 21.10 Red-Black Trees

A BST with one colour bit per node and four rules:

1. Every node is red or black.
2. The root is black (and, by convention, null leaves are black).
3. **A red node's children are black** (no two consecutive reds).
4. **Every path from a node to its descendant nulls contains the same number of black nodes** (equal *black-height*).

Rules 3 and 4 together bound the height: the shortest possible root-to-leaf path is all black (length `bh`), the longest alternates red and black (length `2·bh`), so **no path is more than twice any other**, giving `h ≤ 2 log₂(n+1)`.

### Insertion

Insert as in a plain BST and colour the new node **red** (red never violates rule 4, only possibly rule 3). Then fix upward, examining the parent and **uncle**:

- **Uncle is red** → recolour parent and uncle black, grandparent red; move the problem up two levels. This is the O(log n)-recolouring case, but recolouring is cheap (bit flips, no pointer writes).
- **Uncle is black** → one or two rotations plus recolouring, and the fix **terminates**.

So an insert does at most **2 rotations**; a delete at most **3**. Recolourings can be O(log n) but are amortized O(1). This bounded structural-change count is red-black's core advantage and why it backs `std::map`, `std::set`, `std::multimap`, `std::multiset` (Ch. 12 §12.1), the Linux kernel's CFS run queue and VMA index, and `epoll`'s interest set.

### Implementation details worth knowing

- The colour bit is typically stored in the **low bit of a pointer** (nodes are ≥ 4-byte aligned so low bits are free) or packed with a parent pointer, so the per-node overhead is genuinely one bit, not one word.
- `std::map` nodes hold: parent, left, right, colour, plus the `pair<const Key, T>`. For `map<int,int>` that is 40+ bytes for 8 bytes of payload — an 80% overhead, one allocation per element, and one cache miss per level.
- **`std::map` guarantees**: O(log n) for everything, ordered iteration, and **reference and iterator stability across all insertions and across erasures of other elements**. That stability is the real reason to keep it. `extract`/`insert(node_handle)` (C++17) lets you move a node between maps or change its key without reallocating.
- **A red-black tree is a 2-3-4 B-tree in binary form**: a black node with its red children corresponds to a B-tree node of 2–4 children. Stating this equivalence connects §21.10 to §21.14 and is a strong answer.

**Low-latency verdict:** the same as §21.8 — `std::map` is the correct choice when you need ordered iteration *plus* pointer stability *plus* frequent mutation; otherwise `absl::btree_map` (fewer misses, less memory), `boost::flat_map` (contiguous, O(n) insert), or a sorted `vector` with batch rebuild will beat it. For an order book's price levels, an array indexed by tick offset from a moving reference price beats every tree, because the key space is small, dense, and bounded (Ch. 50 §50.13).

---

## 21.11 Binary Heaps and Priority Queues

A **binary heap** is a complete binary tree stored implicitly in an array: node `i` has children `2i+1`, `2i+2` and parent `(i-1)/2`. No pointers, no allocation per element, perfect contiguity. The **heap property** — every parent ≥ (max-heap) or ≤ (min-heap) its children — is a *partial* order, so the array is not sorted; only the root is guaranteed extremal.

```
array: [9, 7, 6, 5, 4, 2, 1]
              9              push:  append, then sift UP  — O(log n)
            /   \            pop:   move last to root, sift DOWN — O(log n)
          7      6           top:   O(1)
         / \    / \
        5   4  2   1
```

| Operation | Complexity | Notes |
|---|---|---|
| `top` | O(1) | |
| `push` (sift up) | O(log n) worst, **O(1) amortized/average** for random input | Most pushes stop after 1–2 levels |
| `pop` (sift down) | O(log n), and it really is log n | The moved element is a former leaf, so it usually sinks all the way |
| Build from n elements | **O(n)** via Floyd's heapify (sift down from `n/2−1` to 0) | Not O(n log n) — the standard interview trap |
| `decrease-key` / arbitrary erase | O(log n) **only if you track positions** | The standard `priority_queue` cannot do it at all |

### Standard library

`std::priority_queue<T, std::vector<T>, Compare>` is an adaptor over `std::make_heap`/`push_heap`/`pop_heap`. **It is a max-heap by default** — `std::greater<>` as the comparator gives a min-heap, and forgetting this is the most common bug. Note `pop_heap` does not remove: it swaps the root to the end and restores the heap over `[first, last-1)`, so `sort_heap` is just repeated `pop_heap` (that is heapsort: O(n log n), in-place, not stable, and cache-unfriendly).

The adaptor is limited: no iteration, no `decrease-key`, no erase-by-value. When you need those (Dijkstra with decrease-key, a timer wheel with cancellation), the practical answers are:
- **Lazy deletion** — push the updated entry and skip stale ones on pop, checking against a per-key best value. Simplest and usually fastest despite the extra entries.
- **An indexed heap** — maintain `pos[key] → heap index`, updated on every swap. Enables true O(log n) `decrease-key` and erase.
- **A tombstone set** — mark cancelled IDs, discard on pop.

### Cache and alternatives

Sift-down at depth d touches d cache lines with a dependent chain; the top levels stay hot but the bottom levels miss. A **d-ary heap** (typically 4-ary) reduces height to log₄ n and puts all d children in the *same cache line*, trading more comparisons per level for fewer misses — usually a 1.5–2× win for large heaps and a good thing to propose unprompted. **Pairing heaps** and **Fibonacci heaps** give O(1) amortized `decrease-key` (Fibonacci's is the theoretical foundation of Dijkstra's O(E + V log V) bound) but their pointer-chasing constants make them lose to a 4-ary array heap in practice for all but enormous graphs — a good "asymptotics vs constants" answer.

**Trading use:** event/timer queues. For timers specifically, a **hierarchical timer wheel** (Ch. 35 §35.5) gives O(1) insert and expire versus the heap's O(log n), which is why kernels and exchange simulators use wheels rather than heaps.

---

## 21.12 Tries

A **trie** (prefix tree) stores strings by their characters: the path from the root spells the key, so lookup is O(k) in the key length, **independent of the number of stored keys**. There is no key comparison at all, and no hashing.

```
        (root)
        /    \
      'A'     'M'
      /         \
    'A'         'S'        keys: "AAPL", "MSFT"
     |           |
    'P'         'F'
     |           |
    'L'*        'T'*        * = terminal marker
```

| | Trie | Hash map | Balanced BST |
|---|---|---|---|
| Lookup | O(k), no hashing, no comparisons | O(k) to hash + O(k) to compare on hit | O(k · log n) |
| Prefix queries / autocomplete | **Native** — descend to the prefix, enumerate the subtree | Impossible without a scan | O(log n + output) via range |
| Ordered iteration | Yes (lexicographic) | No | Yes |
| Memory | Poor for sparse alphabets — a 256-way node is 2 KB of pointers | Compact | Compact |
| Worst-case bound | Deterministic O(k) — **no adversarial input** | O(n) under hash collision attack | O(log n) |

### The variants that make it practical

- **Compressed trie / radix tree (PATRICIA)** — collapse chains of single-child nodes into one edge labelled with a substring. This is what makes tries memory-viable; it is the structure behind IP routing tables (longest-prefix match) and the Linux kernel's `radix_tree`/`xarray`.
- **Ternary search trie** — each node has a character and three children (<, =, >). Memory close to a BST, lookup close to a trie.
- **Double-array trie** and **HAT-trie** — cache-conscious layouts that flatten nodes into arrays.
- **ART (Adaptive Radix Tree)** — nodes adapt their representation to their fan-out (Node4, Node16, Node48, Node256), keeping memory near-optimal while allowing SIMD search within a node. The state of the art for in-memory ordered indexes, and a strong thing to name.

### Where they matter in trading

**Symbol lookup.** Mapping "ESZ5" or "AAPL" to an internal instrument index is on the critical path of every feed handler. A trie gives a deterministic bound with no hashing, no collisions, and no adversarial degradation. In practice, though, the winning implementation is usually simpler: symbols are short and the set is known at startup, so a **perfect hash** built offline (`gperf`, or a compile-time constexpr map) gives a single memory access and zero collisions, and packing an 8-character symbol into a `uint64_t` for direct integer comparison beats string handling entirely. The trie's real edge is when you need **prefix matching** or when the key set changes at runtime.

Cache behavior is the catch: a naive trie is a pointer chase per character — k dependent misses, worse than a hash's one. Compressed/adaptive variants exist precisely to reduce depth and keep nodes cache-line-sized.

---

## 21.13 Skip Lists

A **skip list** is a sorted linked list with a hierarchy of "express lane" lists above it. Each node is promoted to the next level with probability p (typically 1/2 or 1/4), so level `i` holds ~n·pⁱ nodes and the expected height is O(log₁∕ₚ n).

```
L3: HEAD ─────────────────────────→ 50 ──────────→ NIL
L2: HEAD ────────→ 20 ────────────→ 50 ──→ 70 ───→ NIL
L1: HEAD → 10 → 20 → 30 ─→ 40 ────→ 50 ──→ 70 ───→ NIL
search(40): start top-left, move right while next < target, else drop down.
```

Search, insert, and delete are all **O(log n) expected**, with the bound holding *with high probability* (the probability of exceeding c·log n is polynomially small). There is no worst-case guarantee — a pathological run of coin flips gives a linked list — but unlike a hash table this cannot be triggered by adversarial *input*, only by an adversarial RNG, because the structure depends on randomness rather than on key values.

### Skip list vs balanced BST

| | Skip list | Red-black tree |
|---|---|---|
| Bound | O(log n) **expected** | O(log n) **worst case** |
| Implementation complexity | Low — no rotations, no rebalancing cases | High — rotation and recolouring cases |
| Memory | ~2 pointers per node on average (1/(1−p)) | 3 pointers + colour |
| Concurrency | **Excellent** — insertion is a few CAS-linked pointers, no global restructuring; supports lock-free implementations | Poor — rotations restructure a path, needing coarse locks or complex protocols |
| Cache behavior | Poor — pointer chasing at every level | Poor, comparable |
| Range scans | Trivial — the bottom level is a sorted list | Requires successor walks |

The decisive column is **concurrency**. A rotation-free structure localizes updates, which is why lock-free and highly concurrent ordered maps are usually skip lists: `java.util.concurrent.ConcurrentSkipListMap`, Redis sorted sets (`zset`), LevelDB/RocksDB **memtables**, and MemSQL/HBase in-memory indexes. Being able to say "skip lists are chosen for concurrency and simplicity, not for speed" is the expected level of nuance.

### Practical notes

- **Node layout matters.** The classic implementation gives each node a variable-length array of forward pointers, which is a single allocation of `sizeof(Node) + h*sizeof(ptr)` — do not allocate the level array separately.
- **p = 1/4** gives fewer levels and lower memory than 1/2 with only slightly more comparisons per level, and is what Redis uses (with a hard level cap of 32).
- **Determinism.** Deterministic skip lists (1-2 skip lists) exist and are equivalent to 2-3 trees, removing the probabilistic bound.
- **Low-latency verdict:** for single-threaded ordered access, a B-tree or flat sorted vector beats a skip list on cache behavior. Skip lists earn their place in concurrent settings, and even there a sharded flat structure or a seqlock-protected (Ch. 26 §26.9) sorted array can win when reads dominate.

---

## 21.14 B-Trees and B+ Trees

A **B-tree of order m** is a balanced search tree whose nodes hold up to `m−1` keys and `m` children, with all leaves at the same depth. It is the cache/disk-conscious generalization of a BST: increasing fan-out from 2 to B reduces height from log₂ n to log_B n.

For n = 10⁶:

| Structure | Fan-out | Height | Dependent misses per lookup |
|---|---|---|---|
| Red-black tree | 2 | ~20 | ~20 |
| B-tree, 64-byte node (8 keys) | ~8 | ~7 | ~7 |
| B-tree, 256-byte node (32 keys) | ~32 | ~4 | ~4 |

Each node is a contiguous block searched by linear or binary scan **within already-loaded cache lines** — so the extra comparisons are nearly free while the avoided cache misses are not. This is the whole argument, and it is the same argument whether the "block" is a 4 KB disk page or a 64-byte cache line. **Choose node size = a small multiple of the cache line for in-memory, = the page/IO block size for on-disk.**

### B-tree vs B+ tree

| | B-tree | **B+ tree** |
|---|---|---|
| Where values live | In internal nodes *and* leaves | **Leaves only**; internal nodes hold keys as separators |
| Fan-out | Lower (values consume node space) | **Higher** — internal nodes are pure key arrays, so the tree is shorter |
| Range scan | Requires in-order traversal up and down | **Leaves are linked** — scan is a sequential walk |
| Point lookup | Can terminate early at an internal node | Always descends to a leaf |
| Used by | Some filesystems, in-memory indexes | **Every major database index**: InnoDB, PostgreSQL, SQLite, LMDB, filesystem B+ trees |

B+ trees win for the two workloads that matter — range scans and high fan-out — which is why "database index" and "B+ tree" are synonymous.

### Mechanics

- **Insert**: descend to a leaf, insert; if the node overflows (`> m−1` keys), **split** it at the median, push the median key up to the parent, and repeat upward. The root splitting is the only way the tree grows, which is why all leaves stay at the same depth.
- **Delete**: remove from a leaf; if it underflows (`< ⌈m/2⌉−1` keys), **borrow** from a sibling, or **merge** with a sibling and pull a key down from the parent, recursing upward.
- **Occupancy** is between 50% and 100%, averaging ~69% (ln 2) for random insertions. **Bulk-loading** sorted data with a bottom-up build gives ~100% occupancy and a perfectly packed tree — always do this when initializing from a snapshot.
- Sequential-insert workloads (auto-increment IDs, timestamps) always split the rightmost node; implementations special-case this with an asymmetric split (put most keys in the left node) to avoid 50% occupancy.

### In-memory B-trees

`absl::btree_map`/`btree_set` and `std::flat_map`'s cousins in the Boost.Container family are the practical options. Compared to `std::map`, a B-tree map typically uses **3–4× less memory** (no per-element node header, no three pointers per element) and is **2–3× faster** on lookup and iteration, at the cost of losing pointer stability — inserts move elements within a node. That trade — memory and speed versus reference stability — is exactly the interview framing for "when would you not use `std::map`?"

C++23's `std::flat_map`/`flat_set` (Ch. 12 §12.8) are the other end: two sorted vectors, O(log n) lookup with near-perfect locality, O(n) insert. For a read-mostly, batch-updated index, flat beats B-tree beats red-black.

---

## 21.15 Disjoint-Set Union

**DSU** (union-find) maintains a partition of n elements into disjoint sets, supporting `find(x)` (which set?) and `union(x, y)` (merge two sets). Each set is a rooted tree; the root is the set's canonical representative.

```cpp
struct DSU {
    std::vector<int> parent, rank_;
    explicit DSU(int n) : parent(n), rank_(n, 0) { std::iota(parent.begin(), parent.end(), 0); }
    int find(int x) {                                 // path compression, iterative
        int r = x;
        while (parent[r] != r) r = parent[r];
        while (parent[x] != r) { int nx = parent[x]; parent[x] = r; x = nx; }
        return r;
    }
    bool unite(int a, int b) {                        // union by rank
        a = find(a); b = find(b);
        if (a == b) return false;
        if (rank_[a] < rank_[b]) std::swap(a, b);
        parent[b] = a;
        if (rank_[a] == rank_[b]) ++rank_[a];
        return true;
    }
};
```

### The two optimizations and the bound

- **Union by rank** (or by size) attaches the shorter tree under the taller, bounding height at O(log n) alone.
- **Path compression** re-points every node on a `find` path directly at the root, flattening the tree.

Either alone gives O(log n) amortized. **Together they give O(α(n)) amortized**, where α is the inverse Ackermann function — below 5 for any n expressible in this universe, so effectively constant. The bound is **amortized, not worst case**: a single `find` can still be O(log n). Tarjan's 1975 result that this is *tight* (no better bound is possible for this class of algorithms) is the detail that distinguishes a strong answer.

**Union by size vs by rank**: by size (`parent[b] = a` where a's set is larger) is equally good asymptotically, is easier to reason about, and gives you set sizes for free — usually the better practical choice. Note that after path compression, "rank" is only an upper bound on height, not the height.

### Uses and variations

- **Kruskal's MST** — the canonical application: sort edges, unite endpoints if they are in different sets.
- **Connectivity queries** on an incrementally built graph (only additions — DSU cannot handle edge *deletion*, which requires link-cut trees or offline techniques).
- **Cycle detection** in an undirected graph.
- **Percolation, image segmentation, equivalence-class merging** (type unification in compilers is exactly DSU).
- **DSU with rollback** — skip path compression, keep a stack of parent changes, undo for offline dynamic connectivity. Gives O(log n) per operation.
- **Weighted DSU** — store an offset to the parent to answer relative-value queries ("is x = y + 3?") under merging.

**Implementation notes:** use two `vector<int>` (or one `vector<int>` where negative values encode set size at roots — a common compaction that halves memory and cache footprint). The iterative `find` above avoids recursion depth and is faster than the two-pass recursive version. Everything is index-based and contiguous, so DSU is one of the few pointer-free tree structures — its cache behavior is excellent, which is why it is fast in practice far beyond what α(n) suggests.

---

## 21.16 Graph Representations

The representation choice determines every algorithm's complexity, so it is the first question in any graph problem.

| Representation | Space | `has_edge(u,v)` | Iterate neighbours of u | Add edge | Best when |
|---|---|---|---|---|---|
| **Adjacency matrix** | O(V²) bits/words | **O(1)** | O(V) | O(1) | Dense (E ≈ V²), small V, or frequent edge queries |
| **Adjacency list** (`vector<vector<int>>`) | O(V + E) | O(deg u) | **O(deg u)** | O(1) amortized | Sparse graphs — the default |
| **CSR / compressed adjacency** | O(V + E), one allocation | O(log deg) with sorted rows | O(deg u), **contiguous** | Static only | Read-only graphs, maximum performance |
| **Edge list** | O(E) | O(E) | O(E) | O(1) | Kruskal, algorithms that just sweep edges |

### CSR — the layout that matters

**Compressed sparse row** stores two arrays: `offsets[V+1]` and `targets[E]`, where the neighbours of `u` are `targets[offsets[u] .. offsets[u+1])`.

```cpp
std::vector<uint32_t> offsets;   // size V+1, prefix sums of degrees
std::vector<uint32_t> targets;   // size E, all neighbour lists concatenated
for (uint32_t i = offsets[u]; i < offsets[u+1]; ++i) visit(targets[i]);
```

This is `vector<vector<int>>` with the inner vectors flattened: **two allocations instead of V+1**, no per-vertex heap headers, and neighbour iteration is a contiguous scan that the prefetcher handles perfectly. For any static graph — a routing table, an instrument dependency graph, a compiled state machine — CSR is strictly better. Building it is one degree-counting pass, a prefix sum (`std::exclusive_scan`), and one fill pass.

### Details that come up

- **Directed vs undirected**: undirected edges are stored twice in adjacency structures (so `targets` has 2E entries) and symmetrically in a matrix.
- **Weights** go in a parallel array (`weights[E]`, indexed identically to `targets`) — structure-of-arrays (Ch. 42 §42.2), so an unweighted traversal never loads the weights.
- **Bitset adjacency matrix**: for V ≤ a few thousand, `vector<std::bitset<V>>` makes neighbour-set intersection a word-parallel `AND` — the basis of fast triangle counting and Bron–Kerbosch clique enumeration. `V²/8` bytes, so V=4096 is 2 MB, still L2/L3-resident.
- **Vertex renumbering** is a real optimization: relabelling vertices so that neighbours have nearby IDs (BFS order, or a graph-partitioning tool) dramatically improves locality of the `targets` accesses. This is what makes large-graph frameworks fast.
- **`std::unordered_map<Node, vector<Node>>`** is the convenient representation and the slow one — hash lookup per neighbour access, plus a vector allocation per node. Map external IDs to dense `uint32_t` indices once, then work entirely in index space.

**Trading relevance:** dependency graphs for risk aggregation, instrument-to-underlying relationships, and multicast feed topologies are all static, so build them once as CSR at startup and never touch a `map` on the hot path.

---

## 21.17 Segment Trees

A **segment tree** answers associative range queries (sum, min, max, gcd, any monoid) over an array with **point or range updates**, both in O(log n).

Structure: a complete binary tree over the array; each node stores the aggregate of its range. The array form uses `2n` (iterative) or `4n` (recursive, safe upper bound) slots.

```
array [5, 2, 8, 1]              node 1: sum[0..3] = 16
                                 /                \
                       node 2: [0..1]=7      node 3: [2..3]=9
                        /      \              /      \
                    [0]=5    [1]=2         [2]=8   [3]=1
```

A range query decomposes `[l, r)` into **at most 2·log n canonical nodes** — that decomposition is the key insight and the source of the bound.

```cpp
// iterative, bottom-up, 2n storage, 0-indexed half-open [l, r)
long query(int l, int r) {
    long res = 0;
    for (l += n, r += n; l < r; l >>= 1, r >>= 1) {
        if (l & 1) res += t[l++];
        if (r & 1) res += t[--r];
    }
    return res;
}
void update(int i, long v) { for (t[i += n] = v; i > 1; i >>= 1) t[i>>1] = t[i] + t[i^1]; }
```
The iterative version is branch-light, allocation-free, and considerably faster than the recursive one — worth knowing by heart.

### Extensions

- **Lazy propagation** — to support *range* updates ("add 5 to `[l,r)`"), store a pending delta per node and push it down only when the node is descended into. Keeps updates O(log n).
- **Persistent segment tree** — path copying on update gives O(log n) new nodes per version and answers historical queries; the basis of "k-th smallest in a range" solutions.
- **Merge-sort tree / wavelet tree** — store sorted subranges to answer "how many elements < x in `[l,r)`".
- **2D segment tree** — O(log² n) for rectangle queries.

### Segment tree vs Fenwick vs sparse table

| | Segment tree | Fenwick (§21.18) | Sparse table |
|---|---|---|---|
| Operations | Any monoid; range update with lazy | Invertible ops (sum, xor) primarily | Idempotent ops (min, max, gcd) |
| Query | O(log n) | O(log n), ~2× faster constant | **O(1)** |
| Update | O(log n) | O(log n) | **Not supported** (static) |
| Memory | 2n–4n | **n** | n log n |
| Code size | Large | ~8 lines | Small |

**Choose:** sparse table for static idempotent queries; Fenwick for prefix sums with point updates; segment tree when you need non-invertible operations (min with updates), range updates, or custom merge logic. In practice, if the operation is a sum and updates are points, Fenwick is the right answer and the segment tree is over-engineering.

Practical relevance in trading is narrower than in competitive programming, but real: rolling aggregates over a time-indexed window, order-book depth aggregation (total quantity within a price range with per-level updates), and risk aggregation over a hierarchy are all segment-tree-shaped. Note that for a *sliding* window specifically, a monotonic deque (Ch. 22 §22.11) gives O(1) amortized and beats a segment tree outright.

---

## 21.18 Fenwick Trees

A **Fenwick tree** (binary indexed tree, BIT) maintains prefix sums with O(log n) point update and O(log n) prefix query in exactly `n` words and about eight lines of code.

```cpp
std::vector<long> bit;              // 1-indexed, size n+1, all zero initially
void add(int i, long v) { for (++i; i <= n; i += i & -i) bit[i] += v; }
long sum(int i) { long s = 0; for (++i; i > 0; i -= i & -i) s += bit[i]; return s; }   // [0..i]
long range(int l, int r) { return sum(r) - sum(l - 1); }
```

### The mechanism

`i & -i` isolates the lowest set bit of `i` (two's complement: `-i` is `~i + 1`). Node `i` is responsible for the range `(i − lowbit(i), i]` — that is, `lowbit(i)` elements ending at `i`. A prefix query strips low bits one at a time, visiting at most `popcount(i)` ≤ log₂ n nodes; an update adds the low bit repeatedly, visiting the log n nodes whose ranges cover `i`.

```
index:  1    2    3    4    5    6    7    8
covers [1] [1,2] [3] [1..4] [5] [5,6] [7] [1..8]
sum(7) = bit[7] + bit[6] + bit[4]      (7 → 6 → 4 → 0)
add(5) → bit[5], bit[6], bit[8]        (5 → 6 → 8)
```

### Why it beats a segment tree in practice

Same asymptotics, but: **half the memory** (n vs 2n–4n), no recursion, ~2× fewer memory touches per query (only the set bits of the index), a tighter loop, and the accessed indices for `sum` form a decreasing sequence with good locality in the low ranges. For the specific job of prefix sums with point updates, it is the correct answer.

**The restriction:** Fenwick requires an **invertible** operation, because `range(l, r) = sum(r) − sum(l−1)` needs subtraction. Sum, XOR, and product-over-a-field work; min and max do not (a Fenwick tree can be adapted for prefix-min only, with no arbitrary-range queries and no decreasing updates). If you need range-min with updates, use a segment tree.

### Useful variants

- **Range update, point query** — build the Fenwick over the *difference* array: `add(l, +v); add(r+1, −v);` and a point query becomes a prefix sum.
- **Range update, range query** — two Fenwick trees (the standard `B1`/`B2` construction).
- **2D Fenwick** — nested loops on both dimensions, O(log² n), n·m memory. The compact answer for rectangle sums with point updates.
- **`find_kth` / binary lifting on the tree** — descend from the highest power of two, giving O(log n) "find the smallest index with prefix sum ≥ k" without a binary search over queries. This is how a Fenwick tree over counts becomes an **order-statistics structure**.
- **O(n) construction** — build in place with `for i: j = i + lowbit(i); if (j <= n) bit[j] += bit[i];` rather than n calls to `add`.

**Trading relevance:** cumulative depth in an order book indexed by tick offset (total quantity up to a price), rolling volume-weighted aggregates, and rank queries over a live population (e.g. "what percentile is this order size?") via the `find_kth` variant. The structure is a flat `vector` of integers, so it is allocation-free after construction and entirely cache-friendly — which is why it survives on hot paths where a tree would not.

---

## 21.19 Bloom Filters

A **Bloom filter** is a probabilistic set membership structure: an `m`-bit array and `k` hash functions. `insert(x)` sets bits `h₁(x)…h_k(x)`; `contains(x)` returns true only if all k bits are set.

**One-sided error:** a negative answer is *always correct* (the element is definitely absent); a positive answer may be a **false positive**. There are **no false negatives**, and that asymmetry is the entire design contract.

### The math

With n inserted elements, m bits, k hash functions:

- False-positive rate ≈ `(1 − e^(−kn/m))^k`
- Optimal `k = (m/n)·ln 2 ≈ 0.693 · m/n`
- At the optimum, `p ≈ 0.6185^(m/n)`, i.e. **m/n ≈ −1.44 · log₂ p**

| Target FP rate | Bits per element | Optimal k |
|---|---|---|
| 10% | ~4.8 | 3 |
| 1% | **~9.6** | 7 |
| 0.1% | ~14.4 | 10 |

"About 10 bits per element for 1%" is the number to have memorized. Note this is **independent of the element size** — a filter over million-character strings costs the same 10 bits each. That is the property that makes Bloom filters valuable: they compress membership to a size that fits in cache when the real set does not.

### Limitations and variants

- **No deletion** — clearing a bit would create false negatives for other elements sharing it. **Counting Bloom filters** replace bits with small counters (typically 4 bits) to allow deletion, at 4× the space and with counter-overflow saturation issues.
- **No enumeration, no count.** You cannot list the members. (An approximate count can be derived from the fraction of set bits.)
- **Cuckoo filters** and **quotient filters** support deletion, are often smaller at low FP rates (< ~3%), and — crucially — are **more cache-friendly**: a cuckoo filter touches 2 buckets versus k scattered bits.
- **Blocked Bloom filter** — confine all k bits of an element to a single cache line (or 512-bit block). One cache miss instead of k, at a small FP-rate penalty. **This is the low-latency variant and the one to propose in an interview**; k scattered bit tests over a multi-megabyte array is k cache misses, which entirely defeats the point.
- **Double hashing**: `hᵢ(x) = h₁(x) + i·h₂(x)` generates k hashes from two — standard practice, with no meaningful FP-rate penalty (Kirsch–Mitzenmacher).

### Where they earn their place

The pattern is always **cheap negative filter in front of an expensive lookup**: LSM-tree databases (RocksDB, Cassandra, LevelDB) put a Bloom filter per SST file so a point lookup skips files that cannot contain the key; CDNs use them to avoid caching one-hit objects; distributed systems use them to avoid network round trips; browsers used them for malicious-URL lists.

In trading, the honest answer is that they are **less useful than they appear**: the hot sets (open orders, subscribed instruments) are small, bounded, and known, so a dense array indexed by an internal ID or a preallocated flat hash map is both exact and faster. The genuine uses are duplicate-message suppression over a large recent window (Ch. 53 §53.5 — where a false positive means dropping a duplicate you were going to drop anyway, an acceptable error) and pre-filtering in compliance/surveillance systems over large historical sets. Recognizing when the error is *asymmetrically harmless* is what makes the choice defensible.

---

## 21.20 LRU Caches

**Least Recently Used** eviction: when the cache is full, discard the entry whose last access is oldest. The classic implementation achieves O(1) `get` and `put` by combining two structures.

```cpp
// hash map: key → iterator into the list;  list: MRU at front, LRU at back
std::list<std::pair<K,V>> order;
std::unordered_map<K, decltype(order)::iterator> index;

V* get(const K& k) {
    auto it = index.find(k);
    if (it == index.end()) return nullptr;
    order.splice(order.begin(), order, it->second);   // O(1) move to front
    return &it->second->second;
}
void put(K k, V v) {
    if (auto it = index.find(k); it != index.end()) { it->second->second = std::move(v);
        order.splice(order.begin(), order, it->second); return; }
    if (index.size() == cap) { index.erase(order.back().first); order.pop_back(); }
    order.emplace_front(std::move(k), std::move(v));
    index[order.front().first] = order.begin();
}
```

Two details make this work: `std::list::splice` is O(1) and **does not invalidate iterators**, so the map's stored iterators remain valid; and `std::unordered_map` has stable references, so the pairing is sound. That iterator-stability requirement is exactly why the naive version cannot use a `vector`.

### The production version

The textbook implementation is also the slow one: a heap node per entry, a hash node per entry, and pointer chasing on every `get`. The performant design:

1. **Slab + indices** (§21.6). Preallocate `capacity` entries in one array; the list links are `uint32_t` indices, not pointers. One allocation total, half-size links, and the entries are contiguous.
2. **Intrusive hooks** (§21.5). The LRU list hook lives inside the entry, so eviction is `container_of` plus two writes.
3. **A flat hash map** (§21.7) from key to slot index instead of `std::unordered_map`.
4. Result: `get` is one hash probe (one or two cache lines) plus an O(1) unlink/relink within the slab. No allocation ever.

### Policy alternatives

| Policy | Idea | When it wins |
|---|---|---|
| **LRU** | Evict oldest access | General purpose; the default |
| **LRU-K / 2Q / SLRU** | Two lists — a probationary FIFO and a protected LRU; promote on second access | Resists **scan pollution**, where one sequential sweep evicts the whole working set |
| **CLOCK / second-chance** | A circular buffer with a reference bit; approximate LRU | Concurrency — no list mutation on read, so reads need no exclusive lock |
| **TinyLFU / W-TinyLFU** | Admission control via a frequency sketch (count-min + Bloom-style ageing) in front of an LRU | Highest hit rate in practice; used by Caffeine and modern caches |
| **ARC** | Adaptive balance between recency and frequency | Strong general performance; patent history limited adoption |
| **FIFO / random** | No metadata | Very high concurrency; surprisingly competitive (see S3-FIFO) |

**The concurrency problem is the real one.** LRU mutates shared state on every *read*, so a naively locked LRU serializes readers — a lock convoy (Ch. 24 §24.19) under load. Standard fixes: sharding by key hash (N independent caches, N locks), batching the recency updates in per-thread ring buffers and applying them periodically (Caffeine's approach), or switching to CLOCK, where a read only sets a bit and needs no lock at all. Being able to identify "LRU writes on read" as the scalability defect is the point of this question.

**Trading uses:** reference-data caches (symbol → instrument details), computed-value caches (implied volatility surfaces), and hot-path caches keyed by instrument. In the last case the correct answer is usually to **not use a cache at all** — with a bounded, known instrument universe, a dense array indexed by internal instrument ID is O(1), exact, allocation-free, prefetchable, and has no eviction logic to go wrong. A cache is what you build when the key space is unbounded; on a hot path, bound the key space instead.

---

## Key Interview Questions

1. **Why does `vector` grow geometrically, and what is the argument for 1.5 over 2?** — Geometric growth gives amortized O(1) push_back; a factor below the golden ratio lets previously freed blocks be coalesced and reused, which a factor of 2 never can.
2. **When is `std::list` actually the right choice?** — When you need reference stability across mutation *and* O(1) splice/unlink; otherwise `vector` wins even for insertion-heavy workloads because traversal is a dependent-load chain.
3. **Why is a linked-list traversal two orders of magnitude slower than an array scan?** — Each `next` load depends on the previous one, so memory-level parallelism is 1 and the prefetcher cannot help; ~80–100 ns per node versus sub-nanosecond amortized.
4. **What is `std::deque`'s layout, and why is it the default adaptor backing?** — A map of pointers to fixed chunks; push at either end is O(1) and does not invalidate *references*, unlike `vector`.
5. **How do you distinguish full from empty in a ring buffer?** — Monotonic non-wrapping counters with masked indexing (best), sacrificing one slot, or a separate count (worst for concurrency).
6. **Why must a ring buffer's head and tail be on separate cache lines?** — Otherwise every producer write invalidates the consumer's line; MESI ping-pong turns a 2 ns operation into ~100 ns.
7. **What does an intrusive container buy you over `std::list`?** — Zero allocation, O(1) erase *given a pointer to the element* with no lookup, one cache line for hook and data, and membership in multiple lists — at the cost of manual lifetime management and no value semantics.
8. **Why use 32-bit indices instead of pointers?** — Half the size (more nodes per cache line), valid across relocation, and valid in shared memory across processes. Add a generation counter to detect stale handles.
9. **Why is `std::unordered_map` slower than `absl::flat_hash_map`?** — The standard mandates reference stability and bucket iteration, forcing node-based chaining: an allocation per element and at least two dependent cache misses per lookup.
10. **How does a Swiss table resolve a lookup in one cache line?** — A one-byte control word per slot holding 7 hash bits; 16 are compared at once with SSE2 and a movemask, giving candidate slots with a single load.
11. **Why is `std::hash<int>` on libstdc++ dangerous?** — It is the identity, so keys with structure in the low bits (aligned pointers, IDs × 8) all collide in a power-of-two table. Mix before masking.
12. **Delete a node with two children from a BST — how?** — Replace its key with the in-order predecessor or successor, then delete that node, which has at most one child.
13. **AVL vs red-black — the trade?** — AVL is more tightly balanced (1.44 log n vs 2 log n) so lookups are faster; red-black bounds structural change (≤2 rotations on insert, ≤3 on delete, vs AVL's O(log n) rotations on delete), so updates are faster.
14. **Why does `std::map` lose to `absl::btree_map`?** — 20 dependent cache misses versus ~4, plus three pointers and an allocation per element; the B-tree's higher fan-out converts misses into nearly free in-cache comparisons.
15. **How is a red-black tree related to a B-tree?** — It is a 2-3-4 tree encoded in binary: a black node with its red children is one B-tree node of 2–4 children.
16. **Is building a heap from n elements O(n log n)?** — No, O(n) with Floyd's bottom-up heapify; the geometric series over subtree heights converges.
17. **Why is `std::priority_queue` insufficient for Dijkstra with decrease-key?** — No iteration, no positional update; use lazy deletion (push duplicates, skip stale) or an indexed heap with a key → position map.
18. **What is a 4-ary heap for?** — Height log₄ n and all children of a node in the same cache line: fewer misses per sift, typically 1.5–2× faster than a binary heap at scale.
19. **Trie vs hash map for symbol lookup?** — The trie is O(k) with a deterministic bound and native prefix queries but chases a pointer per character; for a fixed startup-known symbol set, a perfect hash or packing the symbol into a `uint64_t` beats both.
20. **Why are skip lists used for concurrent ordered maps?** — Insertion is a handful of localized CAS-linked pointer writes with no rotations, so lock-free implementations are tractable; that is the reason, not raw speed.
21. **B-tree vs B+ tree?** — B+ keeps values only in leaves, so internal nodes are pure key arrays (higher fan-out, shorter tree) and leaves are linked for sequential range scans. Every database index is a B+ tree.
22. **How do you choose B-tree node size?** — Cache-line multiple for in-memory, page/IO-block size on disk: the goal is minimizing dependent misses, since in-node comparisons are nearly free once the block is loaded.
23. **What makes DSU nearly O(1)?** — Union by rank/size plus path compression gives O(α(n)) *amortized*; a single `find` can still be O(log n), and Tarjan proved the bound tight.
24. **Fenwick vs segment tree?** — Same asymptotics; Fenwick uses n words, no recursion, ~2× better constants, but requires an invertible operation. Segment trees handle min/max, range updates with lazy propagation, and custom merges.
25. **Can a Bloom filter have false negatives?** — Never; only false positives. ~10 bits per element gives 1%, independent of element size. Deletion requires a counting Bloom or a cuckoo filter.
26. **What is a blocked Bloom filter and why does it matter?** — All k bits of an element live in one cache line, turning k scattered misses into one at a small false-positive cost.
27. **Implement an O(1) LRU cache.** — Hash map from key to a list iterator, plus a doubly linked list ordered by recency; `splice` to the front on access and evict from the back. Production version: a slab of entries, `uint32_t` links, intrusive hooks, and a flat hash map.
28. **What is the scalability defect of LRU?** — It mutates shared state on every *read*, so reads serialize. Fix by sharding, batching recency updates, or switching to CLOCK, where a read only sets a bit.

---

## Common Traps

- **Arithmetic vector growth** (`capacity += k`) — quadratic total copying.
- **Holding pointers or iterators across `push_back`** — invalidated by reallocation (Ch. 11 §11.8).
- **`vector<bool>`** — a proxy specialization; `&v[0]` is not `bool*` and `auto&` fails.
- **`resize()` on a large `vector<char>` before overwriting** — a full `memset` you did not want.
- **Choosing `std::list` for "fast insertion"** — finding the position is O(n) and traversal is a dependent-miss chain.
- **Assuming `std::list::splice` is always O(1)** — the range overload is O(distance) because `size()` must stay O(1).
- **`std::forward_list::insert`** — it does not exist; only `insert_after`, and there is no `size()`.
- **`std::deque` on MSVC with small elements** — 16-byte blocks make it pathologically slow.
- **`head == tail` as the only ring-buffer state** — full and empty are indistinguishable.
- **Ring head and tail sharing a cache line** — false sharing dominates the cost.
- **Modulo instead of masking** in a ring — a 20–40 cycle division on every operation.
- **Destroying an element still linked into an intrusive list** — corrupts the list; use `auto_unlink` hooks or discipline.
- **Copying an intrusively linked object** — duplicates the hooks and corrupts the list.
- **Reusing a slab index without a generation counter** — silent use-after-free through a stale handle.
- **Relying on `std::hash` for integer or pointer keys in a power-of-two table** — identity hash, catastrophic clustering. Mix.
- **Letting a hash table rehash on the hot path** — a single insert becomes O(n); reserve at startup.
- **Assuming a BST is balanced** — sorted input (timestamps, sequence numbers) degenerates it to a list.
- **Using `std::map` where ordered iteration is not actually needed** — pay ~20 cache misses per lookup for nothing.
- **Forgetting `std::priority_queue` is a max-heap** — needs `std::greater<>` for a min-heap.
- **Believing heap construction is O(n log n)** — it is O(n).
- **Trying to `decrease-key` a `std::priority_queue`** — impossible; use lazy deletion or an indexed heap.
- **A naive trie over a 256-way alphabet** — 2 KB of pointers per node; use a compressed/adaptive radix tree.
- **Expecting worst-case bounds from a skip list** — expected/whp only.
- **Bulk-loading a B+ tree by repeated insertion** — ~69% occupancy instead of ~100%; build bottom-up.
- **DSU with path compression but not union by rank** (or vice versa) — O(log n), not O(α(n)).
- **Expecting DSU to support edge deletion** — it cannot; use rollback DSU or link-cut trees.
- **`unordered_map<Node, vector<Node>>` as a graph** — a hash lookup and an allocation per vertex; use dense indices and CSR.
- **Using a Fenwick tree for range-min** — the operation must be invertible.
- **Scattering a Bloom filter's k bits across a large array** — k cache misses; use a blocked filter.
- **Deleting from a plain Bloom filter** — introduces false negatives and breaks the contract.
- **A single-lock LRU under concurrent reads** — every read takes the write lock; convoy.

---

## Compact Recall Summary

**Arrays.** Address arithmetic, no indirection, prefetchable, vectorizable — the baseline every other structure must beat. Geometric growth gives amortized O(1) `push_back`; factors below φ allow block reuse. `reserve` is the highest-value single call. Linear scan beats tree and hash lookup up to roughly 16–64 small elements.

**Lists.** Value plus links, one allocation per node, traversal is a dependent-load chain (MLP = 1) costing ~100 ns per node. Real advantages: total reference stability and O(1) splice/unlink. `std::list::size()` is O(1) since C++11, which cost the range `splice` its O(1). `std::list::sort` is an allocation-free stable merge sort.

**Adaptors and deque.** Stack/queue/priority_queue are interfaces over a container; back a stack with `vector`. `deque` is a map of pointers to chunks — O(1) at both ends, reference-stable on end insertion, two dependent loads per `operator[]`, and pathological chunk sizes on MSVC.

**Rings.** Fixed capacity, one allocation, power-of-two mask instead of modulo, monotonic counters to disambiguate full from empty, head and tail on separate cache lines, cached opposite-index to avoid cross-core reads, explicit overwrite-vs-reject policy. The foundation of every SPSC queue and flight recorder; the magic double-mapped variant removes wrap handling entirely.

**Intrusive and indexed.** Hooks inside the object: zero allocation, O(1) erase from an element pointer, one cache line for hook and payload, multiple list memberships, no ownership. Replace pointers with 32-bit slab indices for half-size links, relocation safety, and shared-memory validity; add generation counters to detect stale handles and tags to defeat ABA. A free list threads unused slots through the payload storage itself.

**Hash tables.** Chaining (`std::unordered_map`, mandated by the reference-stability and bucket-API requirements) versus open addressing (flat maps, one contiguous array). Swiss tables' one-byte control words let SIMD test 16 slots per load, resolving in one cache line. Prime modulus tolerates bad hashes at the cost of a division; power-of-two needs a mixing step. Reserve to avoid rehash spikes.

**Search trees.** Everything is about height and dependent misses. AVL (≤1.44 log n, one rotation on insert, O(log n) on delete) is read-optimized; red-black (≤2 log n, ≤2/≤3 rotations, one colour bit in a pointer's low bit) bounds update work and backs `std::map`, CFS, and `epoll`. A red-black tree is a binary encoding of a 2-3-4 tree. B-trees raise fan-out so 10⁶ elements are ~4 levels instead of ~20; B+ trees keep values in linked leaves for higher fan-out and sequential scans, which is why every database index is one. In-memory: `absl::btree_map` beats `std::map` on memory and speed but loses pointer stability; `std::flat_map` wins for read-mostly.

**Heaps.** Implicit array, no pointers; `top` O(1), `push` O(log n) worst but O(1) average, `pop` genuinely O(log n), **build O(n)** by Floyd. `std::priority_queue` is a max-heap with no iteration and no decrease-key — use lazy deletion or an indexed heap. 4-ary heaps put all children in one cache line. Timer wheels beat heaps for timers.

**Tries and skip lists.** Tries give O(k) with no comparisons and native prefix queries; naive ones chase a pointer per character, so use PATRICIA/ART. Skip lists give O(log n) *expected* with no rotations — chosen for concurrency (RocksDB memtables, Redis zsets, `ConcurrentSkipListMap`), not for speed.

**DSU.** Union by rank/size plus path compression → O(α(n)) amortized, tight by Tarjan's theorem. Index-based, contiguous, pointer-free. Incremental connectivity only; no deletion without rollback or link-cut trees.

**Graphs.** Matrix O(V²) for dense and O(1) edge tests; adjacency list O(V+E) for sparse; **CSR** (offsets + targets) is the same thing flattened into two arrays — build it once for static graphs and iterate contiguously. Weights in a parallel array; renumber vertices for locality; never key a hot graph by `unordered_map`.

**Range structures.** Segment tree: any monoid, range updates via lazy propagation, 2n–4n memory, queries decompose into ≤ 2 log n canonical nodes. Fenwick: n words, eight lines, `i & -i` low-bit stepping, ~2× better constants, but requires an invertible operation; `find_kth` by binary lifting makes it an order-statistics structure. Sparse table: O(1) query, static, idempotent operations only.

**Bloom filters.** One-sided error — no false negatives ever. ~10 bits per element for 1%, independent of element size; optimal k = 0.693·m/n. No deletion (use counting Bloom or cuckoo), no enumeration. Blocked variants confine k bits to one cache line, turning k misses into one. Correct when a false positive is asymmetrically harmless.

**LRU.** Hash map to list-iterator plus a recency list, O(1) via `splice`; the production form is a slab with `uint32_t` links, intrusive hooks, and a flat hash map — zero allocation. Its defect is writing on read, which serializes readers: shard, batch the updates, or use CLOCK. On a bounded, known key space (instrument IDs) a dense array beats any cache.
