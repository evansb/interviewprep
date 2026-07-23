# Chapter 21 — Core Data Structures

## Why this matters — Core

A data structure is an invariant plus a representation. The invariant proves which results are correct; the representation determines allocation, movement, cache locality, indirection, and handle stability. An O(1) lookup can still have variable probe length and a rehash path. An O(n) array shift can be a dense sequential copy. “Which Big-O is smaller?” is therefore only the first part of a systems decision.

This chapter uses one comparison method across the structures most relevant to low-latency work and general coding screens. Chapters 11 and 12 own the standard sequence- and associative-container APIs, including exact invalidation tables. This chapter does not repeat that taxonomy. It asks what array, ring, slab, hash, tree, heap, graph, and range-query representations guarantee and what physical mechanisms their operations invoke.

Concurrency is a separate correctness layer. A ring or free list is not thread-safe merely because its indices are integers. Chapter 26 owns atomic publication, progress, ABA, and reclamation.

---

## 90-second screen — Core

1. State the invariant before the operation: heap parents dominate children; a ring's live logical interval is `[head, tail)`; CSR row `u` is `targets[offsets[u]..offsets[u+1])`.
2. Separate worst-case, expected, and amortized bounds. Hash lookup is expected O(1) under hash/load assumptions, vector append is amortized O(1), and heap insertion is O(log n) worst case.
3. Contiguous and index-based structures trade relocation/stability for density and predictable scans. Linked structures trade extra links, allocation, and dependent loads for stable nodes and O(1) unlink at a known position.
4. A bounded FIFO is a ring, not a shifting array. Full behavior—reject, overwrite, or backpressure—is part of correctness.
5. An intrusive hook or slab index removes per-node container allocation, but the application then owns object lifetime. Add a generation to an index when slot reuse must be detected.
6. Choose lookup structure from queries: direct index for dense bounded IDs; hash for equality; ordered tree/B-tree/flat sorted storage for order and ranges; trie for prefixes.
7. A binary heap is a partial order, not a sorted array. `top` is O(1), push/pop are O(log n) worst case, and bottom-up heap construction is O(n).
8. Static sparse graphs favor CSR because neighbor rows are contiguous. Mutable sparse graphs favor adjacency lists; dense edge tests can justify a matrix.

Two decisions to defend:

- If an external component retains identity across mutation, name whether the handle is a stable pointer, iterator, index, or index-plus-generation and when it becomes invalid.
- If capacity is bounded, define exhaustion before choosing the structure. Falling back to allocation and rejecting input are different contracts.

---

## 21.1 Start with the ADT and invariant — Core

An **abstract data type** (ADT) defines states and legal operations without fixing storage. A stack is LIFO, a queue is FIFO, a deque admits both ends, and a priority queue returns an extremal element. Each can have multiple representations.

| ADT | Required behavioral invariant | Plausible representations |
|---|---|---|
| Stack | `pop` returns the most recently pushed live item | Dynamic array, fixed array plus size |
| Queue | `pop` returns the oldest live item | Ring, segmented deque, linked queue |
| Deque | Both ends can be inserted/removed | Ring with policy, segmented array, linked structure |
| Priority queue | `top` is extremal under the comparator | Binary/d-ary heap, ordered tree, buckets |
| Set/map | Keys obey uniqueness/equivalence policy | Hash table, search tree, sorted array, trie |

Representation follows the operations. A stack does not need stable front insertion. A queue does not need random access. Choosing a general container before writing the ADT often purchases unused guarantees.

### The proof pattern

For every mutating operation:

1. **Precondition:** indices, capacity, ownership, and key assumptions hold.
2. **Preservation:** describe exactly which fields/links/slots change.
3. **Postcondition:** re-establish the invariant, including empty/full/root cases.
4. **Failure:** state whether the operation leaves the old state, consumes input, or partially changes state.
5. **Cost:** count comparisons, moves, allocations, and dependent memory accesses.

For a binary heap push, for example, the old prefix already satisfies the heap property. Appending can violate the property only along the new node's ancestor path. Sifting upward fixes that path and touches no other parent-child relation. That is both the correctness argument and the O(log n) bound.

### Common comparison template

| Dimension | Question |
|---|---|
| Operation bound | Worst-case, expected, or amortized? Under which assumptions? |
| Allocation | Per element, during growth, or none after setup? |
| Space | Payload plus which links, tags, empty slots, or capacity reserve? |
| Access chain | Sequential scan, arithmetic index, probe sequence, or dependent pointers? |
| Handle stability | Which mutation moves/destroys the designated object? |
| Write amplification | How many elements, links, metadata words, or tree levels change? |
| Failure policy | Full table, exhausted slab, duplicate key, allocation failure? |
| Concurrency | Which state is shared? What synchronization is separately required? |

The count of “cache misses” is not a structure constant. It depends on working set, placement, element size, cache/TLB state, prefetch behavior, and workload history. Name the mechanism—such as a dependent child-pointer load—then measure it on the target.

---

## 21.2 Contiguous versus linked representation — Core

An array computes element `i` from a base address and an index. A linked structure reads a link to discover the next address:

```text
contiguous:  [A][B][C][D]             next address = current + sizeof(T)

linked:      [A|next] ──> [B|next] ──> [C|next]
                         addresses depend on earlier loads
```

Contiguous traversal exposes adjacent data to cache-line fetch and hardware prefetch. It minimizes per-element metadata and enables vectorization when other dependencies permit. Insertion or erasure in the middle shifts a suffix; growth of a dynamic array can allocate new storage and relocate every element.

A linked node remains at one address until erased. Given its predecessor or a doubly linked node itself, unlinking changes a constant number of links. Finding that node is still O(n) unless another structure already holds a handle. Separately allocated nodes add allocator metadata/fragmentation and turn traversal into dependent pointer loads.

### Arrays and dynamic arrays

The core invariants of a dynamic array are:

```text
0 <= size <= capacity
elements [0, size) are alive and contiguous
storage [size, capacity) contains no T objects
```

Random access and back removal are O(1). Back insertion is amortized O(1) because occasional growth moves a geometric series of prefixes; the individual growing operation is O(n). A particular growth factor is not standardized and is not part of this chapter's selection proof.

Reserve or fixed capacity can remove growth from a phase, but reserve is not a hard bound: exceeding it may allocate and invalidate handles. Chapter 11 owns exact standard-container behavior and C++23 fixed-capacity alternatives.

### Linked lists

For a doubly linked list with sentinels:

```text
sentinel.next.prev == sentinel
sentinel.prev.next == sentinel
for every live node x:
    x.next.prev == x
    x.prev.next == x
```

Insertion between `a` and `b` is correct when it establishes `a.next = x`, `x.prev = a`, `x.next = b`, and `b.prev = x`. Erasure must repair both neighboring links before the node dies.

| Workload fact | Contiguous array | Linked nodes |
|---|---|---|
| Scan/index dominates | Strong fit | Pays link traversal |
| Middle edit after linear search | Search plus suffix shift | Search plus constant unlink |
| Position already held and must remain stable | Movement may invalidate | Strong fit |
| Per-element allocation forbidden | Preallocate/fixed capacity | Needs pool or intrusive nodes |
| Data crosses process boundary | Offsets/indices work | Raw pointers do not |

The list wins only when its specific guarantees matter. “O(1) insert” without “given a valid position” omits the dominant precondition.

---

## 21.3 Stacks, queues, deques, and rings — Core

LIFO and FIFO describe access order, not storage. A stack often maps naturally to a dynamic or fixed array because only the back changes. An unbounded general queue can use a segmented deque. A bounded queue maps naturally to a ring because popping the front advances an index instead of shifting elements.

| ADT/workload | Natural representation | Mechanism and limitation |
|---|---|---|
| Bounded stack | Fixed array plus size | Dense, no allocation; push must report full |
| Growing stack | Dynamic array | Dense; a growth operation can allocate/move |
| Bounded FIFO | Ring | Reuses slots; full policy required |
| Growing FIFO | Segmented deque | End growth without shifting the whole sequence; not contiguous |
| Stable-node FIFO | Linked queue/pool | Constant link updates; node allocation or pool lifetime |
| Double-ended bounded worklist | Ring if overwrite/reject semantics fit | Both logical ends advance through fixed slots |

A deque ADT does not imply the standard `deque` representation, and a queue ADT does not imply a linked list. Select the narrowest representation that supports the required ends, bound, and handle stability. Chapter 11 owns the standard sequence-container details.

### Ring invariant and full policy

A ring maps monotonically advancing logical positions onto `Capacity` physical slots:

```text
occupancy = tail - head
0 <= occupancy <= Capacity
logical element p lives in slot p % Capacity
live logical interval is [head, tail)
empty when head == tail
full when tail - head == Capacity
```

With unsigned counters, subtraction is modular. The scheme is valid while operations preserve an occupancy no greater than capacity and capacity is representable; producer and consumer must not lap by an unbounded amount. Storing only already-reduced indices makes `head == tail` ambiguous, so another convention must distinguish full from empty, such as sacrificing one slot.

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <optional>
#include <type_traits>
#include <utility>

template <class T, std::size_t Capacity>
class Ring {
    static_assert(Capacity > 0);
    static_assert(std::is_nothrow_move_constructible_v<T>);

    std::array<std::optional<T>, Capacity> slots_{};
    std::size_t head_{};
    std::size_t tail_{};

public:
    bool push(T value) noexcept {
        if (tail_ - head_ == Capacity) return false;
        slots_[tail_ % Capacity].emplace(std::move(value));
        ++tail_;
        return true;
    }

    std::optional<T> pop() noexcept {
        if (head_ == tail_) return std::nullopt;
        auto result = std::move(slots_[head_ % Capacity]);
        slots_[head_ % Capacity].reset();
        ++head_;
        return result;
    }
};

int main() {
    Ring<int, 3> q;
    assert(q.push(4) && q.push(5) && q.push(6));
    assert(!q.push(7));
    assert(q.pop() == 4);
    assert(q.push(7));
}
```

The optional slots make object lifetime visible and compile for non-default-constructible `T`. They add representation overhead; a production fixed-capacity ring may manage raw inline storage, but then it owns alignment, construction, destruction, and exception safety.

The example is single-threaded. Turning indices atomic is not a complete concurrent-queue proof. Publication ordering, producer/consumer ownership, counter wrap, false sharing, progress, and multi-producer reservation belong to Chapter 26.

Full behavior is part of the ADT:

- **reject:** caller handles backpressure or loss;
- **overwrite oldest:** appropriate only when dropping old data preserves the domain contract;
- **block/wait:** introduces scheduling and queueing behavior outside the structure;
- **grow:** abandons fixed capacity and can allocate/move.

Modulo by a compile-time constant is normally optimized by the compiler; power-of-two capacity is not required for ring correctness. Use masking only when the capacity contract and generated code justify it.

---

## 21.4 Intrusive lists, indexed slabs, and free lists — Core

### Intrusive ownership

An intrusive list stores links in the application object:

```text
Order:
    payload
    price_level_hook {prev, next}
    recency_hook     {prev, next}
```

The list owns no node and performs no node allocation. Given an order/hook, unlink is O(1). Multiple hooks allow membership in multiple lists without wrapper-node allocations.

The application pays with stronger lifetime rules:

- a linked object must not be destroyed;
- one hook cannot represent two simultaneous memberships;
- copying raw links would duplicate membership and corrupt invariants;
- hook initialization/unlink policy must be explicit;
- synchronization is still required for shared mutation.

A reviewed intrusive-container library is preferable to hand-written pointer recovery. Recovering an enclosing object from a member address has layout and lifetime constraints; it is not an excuse for unrestricted pointer arithmetic.

### Indexed slab and generation handles

A slab preallocates slots and threads unused indices into a free list. Indices can be narrower than pointers when capacity permits, survive relocation of the slab buffer if interpreted relative to its current base, and can be validated before access. These are design properties, not permission to resize while references are active.

An index alone becomes ambiguous after reuse. A handle `{index, generation}` is valid only when the slot is occupied and its current generation matches:

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <utility>

struct Handle {
    std::size_t index;
    std::uint32_t generation;
};

template <class T, std::size_t N>
class Slab {
    static_assert(N > 0);
    std::array<std::optional<T>, N> slots_{};
    std::array<std::size_t, N> next_{};
    std::array<std::uint32_t, N> generation_{};
    std::size_t free_{};

public:
    Slab() {
        for (std::size_t i = 0; i < N; ++i) next_[i] = i + 1;
    }

    std::optional<Handle> insert(T value) {
        if (free_ == N) return std::nullopt;
        const auto i = free_;
        slots_[i].emplace(std::move(value));
        free_ = next_[i];
        return Handle{i, generation_[i]};
    }

    T* get(Handle h) {
        if (h.index >= N || generation_[h.index] != h.generation) return nullptr;
        return slots_[h.index] ? &*slots_[h.index] : nullptr;
    }

    bool erase(Handle h) {
        if (get(h) == nullptr) return false;
        slots_[h.index].reset();
        ++generation_[h.index];
        next_[h.index] = free_;
        free_ = h.index;
        return true;
    }
};

int main() {
    Slab<int, 1> slab;
    auto old = *slab.insert(7);
    assert(slab.erase(old));
    auto current = *slab.insert(9);
    assert(slab.get(old) == nullptr);
    assert(*slab.get(current) == 9);
}
```

Invariant:

- every slot is exactly one of occupied or reachable from `free_`;
- free-list indices are unique and within `[0, N]`, where `N` is the sentinel;
- an occupied slot's generation identifies its current lifetime.

The example is single-threaded. A generation counter detects stale handles until it wraps; choose width and wrap policy from the maximum reuse rate/lifetime. It does not prevent a concurrent reader from racing with erase/reuse after validation. That is reclamation, not handle encoding.

The allocation mechanism is O(1) and performs no upstream allocation after slab construction. Access adds bounds, generation, and engagement checks. A bitmap free map can improve packing or bulk scans at the cost of searching words; a threaded free list gives constant work but reuse order follows churn.

---

## 21.5 Lookup structures: direct, hash, ordered, and flat — Core

Chapter 12 owns standard associative-container APIs. The structural decision is driven by query shape and stability:

| Query/workload | Representation | Bound and mechanism |
|---|---|---|
| Dense bounded integer key | Direct-index array | O(1) worst case; one bounds check/address calculation |
| Equality lookup, general keys | Hash table | Expected O(1); hash plus probe/chain |
| Ordered lookup and range queries | Balanced search tree/B-tree | O(log n); dependent levels, ordered traversal |
| Read-mostly ordered data | Sorted flat array | O(log n) binary search; O(n) updates |
| Prefix/longest-prefix query | Trie/radix tree | Driven by key length and node lookup |

### Hash invariants

A hash table must ensure:

- each live key is discoverable along the collision policy's prescribed search path;
- key equality is consistent with hashing: equal keys have equal hashes;
- insertion preserves the termination markers used by lookup;
- load stays within the policy required for expected performance.

**Chaining** stores collided entries behind buckets, often as nodes. **Open addressing** keeps entries in the slot array and probes other positions. Linear probing has dense access but develops clusters; other probe policies trade locality for dispersion. Erasure in open addressing needs tombstones or a repair strategy—clearing a slot naively can make later keys unreachable.

Expected O(1) assumes a suitable hash and controlled load. Worst-case lookup is O(n). A rehash is O(n) and can dominate one insertion's tail latency. Pre-sizing avoids rehash only until the planned bound is exceeded.

The C++ standard does not require `unordered_map` to use chaining. Its observable bucket interface and reference-stability rules make node-based designs natural, but the named algorithm is not a guarantee. Likewise, the standard does not require ordered maps to be red-black trees.

### Ordered and flat layouts

A balanced binary search tree preserves:

```text
all keys in left subtree compare before node key
all keys in right subtree compare after node key
height remains O(log n) under the balancing discipline
```

It supports lower-bound/range traversal and stable nodes, but each level commonly follows a child pointer. A B-tree increases fan-out so one loaded node resolves several comparisons before the next dependent child access. A sorted array eliminates node links and makes binary-search storage compact, but insertion shifts a suffix.

Choose stability only when consumers retain handles. If lookup returns a copied value or short-lived index, flat/open layouts can avoid the node guarantee and its allocation/indirection cost.

---

## 21.6 Binary heaps and priority queues — Core

A binary max-heap is a complete tree stored in an array:

```text
children(i) = 2*i + 1, 2*i + 2
for every non-root node i: heap[parent(i)] >= heap[i]
```

Completeness gives logarithmic height without pointers. The heap property is partial: siblings and subtrees are not sorted.

| Operation | Bound | Work |
|---|---:|---|
| Read extremum | O(1) | Read root |
| Push | O(log n) worst case | Append, sift toward root |
| Pop extremum | O(log n) worst case | Move last to root, sift down |
| Bottom-up heapify | O(n) | Sift internal nodes from bottom |
| Search arbitrary value | O(n) | Heap order cannot eliminate a general branch |

```cpp
#include <algorithm>
#include <cassert>
#include <cstddef>
#include <span>
#include <vector>

void sift_down(std::span<int> heap, std::size_t root, std::size_t count) {
    while (root < count / 2) {
        std::size_t child = 2 * root + 1;
        if (child + 1 < count && heap[child] < heap[child + 1]) ++child;
        if (heap[root] >= heap[child]) return;
        std::swap(heap[root], heap[child]);
        root = child;
    }
}

void heapify(std::span<int> values) {
    for (std::size_t i = values.size() / 2; i-- > 0;) {
        sift_down(values, i, values.size());
    }
}

int main() {
    std::vector<int> values{2, 9, 4, 1, 7, 3};
    heapify(values);
    assert(std::is_heap(values.begin(), values.end()));
    assert(values.front() == 9);
}
```

Heapify is linear because most nodes are near the leaves and move only a short distance. Summing “nodes at height h × h work” yields a convergent series times n. Building by n separate pushes is O(n log n) and is a different algorithm.

Arbitrary cancellation/decrease-key needs more state:

- lazy duplicate/tombstone entries, checked when popped;
- an index map from item ID to heap position, updated on every swap;
- a different ordered structure.

An indexed heap keeps O(log n) updates but adds metadata writes and invariant obligations. A d-ary heap reduces height while comparing more children per level; the best arity depends on element/comparator cost and locality and should be measured.

---

## 21.7 Graph terminology and representations — Core

A graph has vertices and edges. Directed edges have orientation; undirected edges are symmetric. A **walk** may repeat vertices/edges, a **path** conventionally does not repeat vertices, and a **cycle** returns to its start. Degree counts incident edges; directed graphs distinguish in-degree and out-degree. Representation does not change these definitions, but it changes every traversal's memory behavior.

| Representation | Space | Edge test | Neighbor iteration | Mutation fit |
|---|---:|---:|---:|---|
| Adjacency matrix | O(V²) | O(1) | O(V) per vertex | Simple dense graphs |
| Edge list | O(E) | O(E) | O(E) without indexing | Batch edge algorithms |
| Per-vertex adjacency lists | O(V+E) plus container overhead | O(deg(u)), or O(log deg(u)) sorted | O(deg(u)) | Mutable sparse graph |
| CSR | O(V+E) compact arrays | O(deg(u)), or O(log deg(u)) sorted | O(deg(u)) contiguous | Static sparse graph |

CSR (**compressed sparse row**) uses offsets and targets:

```cpp
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

struct Csr {
    std::vector<std::size_t> offsets;
    std::vector<std::uint32_t> targets;

    bool valid() const {
        if (offsets.empty() || offsets.front() != 0) return false;
        if (offsets.back() != targets.size()) return false;
        for (std::size_t i = 1; i < offsets.size(); ++i) {
            if (offsets[i - 1] > offsets[i]) return false;
        }
        return true;
    }

    std::span<const std::uint32_t> neighbors(std::size_t vertex) const {
        const auto first = offsets[vertex];
        const auto count = offsets[vertex + 1] - first;
        return std::span<const std::uint32_t>{targets}.subspan(first, count);
    }
};

int main() {
    Csr graph{{0, 2, 3, 3}, {1, 2, 2}};
    assert(graph.valid());
    assert(graph.neighbors(0).size() == 2);
    assert(graph.neighbors(2).empty());
}
```

Invariants: `offsets` has `V+1` nondecreasing entries, starts at zero, and ends at `targets.size()`. Vertex `u` requires `u+1 < offsets.size()`. Sorted rows permit binary edge tests; unsorted rows require a scan. Undirected adjacency normally stores each edge in both endpoint rows.

CSR removes per-vertex allocations and keeps each neighbor list contiguous. It is expensive to mutate because insertion shifts targets and later offsets. Static instrument-dependency, routing, or state-transition graphs fit it; rapidly changing graphs do not.

Chapter 22 owns BFS, DFS, shortest paths, and topological algorithms. Their correctness is separate from choosing matrix, adjacency, or CSR storage.

---

## 21.8 Worked selection and operation traces — Core

### Workload-driven choices

| Workload | Structure | Deciding invariant/cost |
|---|---|---|
| Protocol IDs are dense in `[0, max_id]` | Direct-index array with occupancy state | Worst-case O(1), no hashing; memory proportional to ID range |
| Bounded single-threaded FIFO rejects on full | Fixed-capacity ring | O(1), no shifting/allocation after setup; explicit full state |
| Orders live in a bounded pool and cancellation retains identity | Slab plus generation handle; intrusive hooks for list membership | Detects reuse and unlinks known nodes without allocation |
| Equality lookup over dynamic general keys | Pre-sized hash table | Expected O(1); load/hash assumptions and rehash boundary named |
| Read-mostly ordered reference data | Sorted flat array | Dense binary search; batch rebuild accepted |
| Frequently mutated ordered index with range scans | Balanced/B-tree family | O(log n) updates and ordered traversal |
| Next timer/deadline | Min-heap; indexed or lazy cancellation | Root is minimum, O(log n) update |
| Static sparse dependency graph | CSR | Contiguous neighbors, no per-vertex allocation |
| Dynamic prefix sums | Fenwick tree | O(log n) point update and prefix/range sum |

### Trace a wrapping ring

Let capacity be four, `head = 6`, `tail = 8`. Occupancy is two. Logical positions 6 and 7 occupy physical slots 2 and 3.

1. Push at logical 8 constructs slot `8 % 4 = 0`, then sets `tail = 9`.
2. Pop reads logical 6 from slot `6 % 4 = 2`, destroys that slot, then sets `head = 7`.
3. Occupancy remains `9 - 7 = 2`; the live logical interval is now positions 7 and 8.

Physical ordering wrapped, but logical FIFO order did not. Correctness comes from monotonically advancing logical counters and mapping only at access.

### Trace stale-handle detection

A slot has generation 12. Inserting an order returns `{slot, 12}`. Erase destroys the object, increments the generation to 13, and returns the slot to the free list. Reuse returns `{slot, 13}`. Looking up the old handle fails the generation comparison.

If code cached a raw pointer before erase, generation validation is bypassed; dereferencing that pointer is still invalid. A safe handle discipline must prohibit such pointer escape or constrain its lifetime.

### Compare the physical bill

The following terms are symbolic because exact bytes and cache behavior depend on types and implementations:

| Structure | Space beyond live payload | Allocation pattern | Access/indirection | Handle behavior |
|---|---|---|---|---|
| Dynamic array | Spare capacity and container metadata | On growth | Arithmetic index, dense scan | Relocation invalidates element addresses |
| Linked list | One/two links plus node allocator overhead | Usually per node; pool can change this | Dependent link per step | Surviving node addresses stable |
| Ring | Fixed unused slots plus two logical counters | None after setup | Modulo/index arithmetic | Slot address stable, logical occupant reused |
| Indexed slab | Free link, generation, occupancy state | None after setup | Bounds/tag check plus indexed access | Handle survives relocation; reuse changes generation |
| Open-address hash | Empty capacity, control/tombstone metadata | Whole-table growth | Hash plus probe sequence | Rehash/movement invalidates element addresses |
| Node-based hash/tree | Bucket/root metadata plus node links | Usually per node | Hash/tree then pointer links | Node stability available at locality cost |
| Binary heap | Dynamic-array spare capacity | On growth | Arithmetic tree path | Movement on sift invalidates positional identity |
| CSR | `V+1` offsets plus edge targets | Build-time arrays | Offset read then contiguous row | Static layout; mutation requires rebuild/shift |

“Bytes per element” is therefore a workload calculation: include reserved-but-empty slots, allocator metadata, hash load slack, alignment/padding, and auxiliary maps. An intrusive hook is not free because it enlarges every payload instance, even when that object is not currently linked. An index can reduce link width only when the capacity bound permits the chosen integer type.

Structure choice also does not confer concurrency. A reader of immutable CSR needs no mutation protocol; a writer to an LRU or hash table does. For mutable structures, add the synchronization/reclamation cost to this table rather than describing it as an implementation afterthought.

---

## 21.9 Search trees: BST, AVL, and red-black — Role-specific

A binary search tree (BST) needs an explicit duplicate/equivalence policy and the ordering invariant. Search, insertion, and deletion cost O(h), where `h` is height. Sorted insertion into an unbalanced BST can produce `h = n`; ordering alone does not guarantee logarithmic operations.

In-order traversal is sorted because it recursively visits left subtree, node, right subtree. The successor of a node is the leftmost node of its right subtree when one exists; otherwise it is the first ancestor reached from a left edge.

Deletion has three structural cases:

- leaf: detach it;
- one child: replace the node link with its child;
- two children: exchange/replace with predecessor or successor, then remove a node with at most one child.

Payload ownership and whether keys may be assigned affect how “replace” is implemented.

### Balance disciplines

An AVL tree stores height/balance information and requires the two child-subtree heights at every node to differ by at most one. A red-black tree uses color constraints:

- every node is red or black, with null leaves treated as black;
- root is black;
- a red node has no red child;
- every path from a node to descendant null leaves has equal black height.

Both imply O(log n) height. AVL's tighter height can reduce comparisons; updates may maintain more exact balance. Red-black rules allow looser balance and bounded rotation counts for standard update algorithms. Workload and implementation determine the actual result.

The C++ standard requires logarithmic operations and ordered behavior from its ordered associative containers; it does not mandate red-black trees. Chapter 12 owns those APIs.

### Rotation mechanism — Deep detail within the module

A rotation changes local links while preserving in-order key order:

```text
right rotation at y:             left rotation at x:
       y         becomes x              x       becomes y
      / \               / \            / \             / \
     x   C             A   y          A   y           x   C
    / \                   / \            / \         / \
   A   B                 B   C          B   C       A   B
```

AVL insertion repairs the first unbalanced ancestor with a single or double rotation; deletion can propagate height reduction upward. Red-black repair combines recoloring and rotations. Memorizing every case is less durable than checking two facts after each local rewrite: BST order is unchanged, and stored balance/color invariants are restored.

For AVL, classify the heavy direction at the unbalanced node and at its heavy child:

- left-left and right-right use one rotation;
- left-right and right-left first rotate the child, then the unbalanced node;
- recompute stored heights/balance factors from children after links change.

Insertion stops after the first repaired ancestor because the rotated subtree regains its previous height. Deletion can shorten the repaired subtree, so imbalance may continue toward the root.

For red-black insertion, a red parent with a red uncle is repaired by recoloring and may propagate upward. A black uncle leads to one or two rotations plus recoloring. Deletion repair reasons about a missing unit of black height and may propagate. The important contrast is not a slogan that one tree is universally “read optimized” and the other “write optimized”; it is that their height and repair constraints differ. Compare actual key/comparator cost, mutation mix, node layout, and allocator.

---

## 21.10 Disjoint-set union — Role-specific

Disjoint-set union (DSU/union-find) maintains a partition of dense IDs. Each set is a parent-pointer tree whose root is its representative:

```text
parent[root] == root
find(x) returns the root reached from x
unite(a,b) links two distinct roots
```

The public operations below require every ID to be less than the construction-time `n`; a production interface should enforce or document that precondition.

```cpp
#include <cassert>
#include <cstddef>
#include <numeric>
#include <utility>
#include <vector>

class Dsu {
    std::vector<std::size_t> parent_;
    std::vector<std::size_t> size_;

public:
    explicit Dsu(std::size_t n) : parent_(n), size_(n, 1) {
        std::iota(parent_.begin(), parent_.end(), std::size_t{0});
    }

    std::size_t find(std::size_t x) {
        while (x != parent_[x]) {
            parent_[x] = parent_[parent_[x]];  // path halving
            x = parent_[x];
        }
        return x;
    }

    bool unite(std::size_t a, std::size_t b) {
        a = find(a);
        b = find(b);
        if (a == b) return false;
        if (size_[a] < size_[b]) std::swap(a, b);
        parent_[b] = a;
        size_[a] += size_[b];
        return true;
    }
};

int main() {
    Dsu sets{5};
    assert(sets.unite(0, 3));
    assert(sets.find(0) == sets.find(3));
    assert(!sets.unite(3, 0));
}
```

Union by size alone keeps height O(log n). Path compression/halving shortens paths encountered by finds. Applied together, a sequence of operations has O(alpha(n)) amortized time per operation, where alpha is the inverse Ackermann function. That is an amortized sequence bound, not a claim that each access executes a fixed number of instructions.

Path compression alone should not be credited with the combined inverse-Ackermann bound. After compression, rank/size metadata is not generally the current height. DSU supports incremental merging; arbitrary deletions/splits need another method or an offline rollback design.

Dense arrays give DSU compact storage and arithmetic indexing. It fits connectivity, equivalence merging, and Kruskal's algorithm; Chapter 22 owns those algorithms.

---

## 21.11 Bloom filters and LRU caches — Role-specific

### Bloom filter: one-sided approximate membership

A Bloom filter has `m` bits and `k` derived hash positions. Insert sets those positions. Query returns “possibly present” only when all positions are set.

Under correct operation with the same hash scheme and without unsupported deletion:

- a negative answer is definitive;
- a positive answer may be a false positive;
- inserted items do not produce false negatives.

With `n` inserted items and idealized independent uniform hashing, the common false-positive approximation is:

```text
p ≈ (1 - exp(-k*n/m))^k
```

This is a model, not a guarantee for weak/correlated hashes or a saturated/adversarial filter. A standard Bloom filter cannot delete by clearing bits because other keys may share them. Counting filters add counters; blocked filters constrain probes to a locality region; both change the space/error trade.

The structure is useful only when a cheap negative avoids a more expensive operation and false positives are harmless. It cannot enumerate keys or replace the authoritative set. Hash work and scattered bit accesses can outweigh the saved lookup for a small hot set.

### LRU: exact recency with mutation on read

An O(1)-average LRU cache combines:

- a key lookup index mapping each key to one entry;
- a doubly linked recency order, most-recent to least-recent;
- capacity invariant `size <= capacity`;
- exactly one list node and index entry per cached key.

On hit, unlink the known node and move it to the front. On insertion at capacity, remove the back node and its index entry. Complexity is expected O(1) only because the lookup index is expected O(1); list work is worst-case O(1) given the node.

The simplest representation allocates both hash and list nodes. A bounded production design can use a slab, index links, intrusive recency hooks, and a pre-sized lookup table. That removes steady-state node allocation while preserving the same invariant.

LRU mutates recency on every hit. Under a shared lock, reads serialize. Sharding, deferred/batched recency, or an approximate policy such as CLOCK changes that contention pattern. Chapter 24 owns locks; no eviction policy is automatically concurrent.

LRU also suffers scan pollution: a one-time scan can evict a frequently reused working set. Admission/frequency-aware policies may improve hit rate, but selection must use the measured access distribution. If the key universe is dense and bounded, a direct-index table with no eviction is simpler and exact.

---

## 21.12 Tries, skip lists, and B/B+ trees — Deep dive

### Tries and adaptive radix layouts

A trie follows key units from root to terminal state. Lookup cost is proportional to key length times the child-selection cost. A fixed alphabet array gives O(1) child selection but wastes space at sparse nodes; a sorted child array or map changes both memory and lookup bound.

Path compression collapses single-child chains into radix edges. Adaptive radix trees choose node layouts by fan-out, aiming to retain prefix/ordered behavior while reducing sparse-node waste. Tries are compelling for prefix and longest-prefix queries; for fixed short keys, direct encoding, perfect hashing, or a flat table may be simpler.

Every pointer node can add a dependent access. “O(key length)” is not automatically cache-efficient.

### Skip lists

A skip list adds probabilistically selected forward links above a sorted bottom list. With a suitable independent random-level process, search/insert/erase are expected O(log n); worst case remains O(n). Its update mechanics avoid tree rotations and can localize link changes, which is useful in some concurrent designs, but a lock-free skip list still requires a complete memory-order/reclamation proof.

Single-threaded locality is generally weaker than flat or high-fan-out storage because a search follows links at multiple levels. Choose it for its probabilistic/simple update structure, not from an unsupported universal speed claim.

### B-trees and B+ trees

A B-tree node holds multiple sorted separator keys and child links. All leaves share a depth; split/merge/redistribution preserve occupancy bounds and balance. High fan-out reduces tree height and amortizes one dependent node access across several in-node comparisons.

In a B+ tree, values reside in leaves and internal nodes guide search; linked leaves support range scans. Exact node capacity depends on page/cache target, key/value sizes, metadata, and implementation. On-disk indexes often align nodes with storage pages; in-memory B-trees choose layouts for cache density. Not every database index is a B+ tree, and not every in-memory B-tree beats a flat array.

Compared with a binary node tree, B-tree nodes reduce per-key pointers and height but may move keys during updates, affecting reference stability. Compared with a sorted flat array, updates move within/split nodes rather than shifting the entire sequence.

Insertion descends to a leaf, inserts into sorted node storage, and splits an overflowing node. A separator is propagated to the parent; root split creates a new root and is the only way height increases. Deletion removes a key/value and, when occupancy falls below the discipline's minimum, borrows from a sibling or merges nodes, possibly propagating toward the root. Each operation must preserve sorted keys, child-range separation, occupancy policy, and equal leaf depth.

Bulk loading already-sorted data can construct densely occupied leaves and parent levels without replaying individual insertions. That is often the correct initialization path for read-mostly snapshots, while online inserts retain the split path. Exact occupancy targets and split bias are design choices rather than universal constants.

---

## 21.13 Segment and Fenwick trees — Deep dive

Both structures maintain aggregates over indexed ranges.

### Segment tree

A segment-tree node represents an interval and stores the associative combination of its children. The root represents the entire range; leaves represent individual positions. A query decomposes a range into O(log n) canonical nodes, and a point update repairs the leaf-to-root path in O(log n). Storage is O(n).

The combine operation must be associative and have the identity used for empty query pieces. Sum, minimum, maximum, and structured aggregates can work. Range updates require additional lazy metadata and a proof that pending updates compose and are pushed before dependent child use.

### Fenwick tree

A Fenwick tree specializes compact prefix aggregation. With one-based indices:

```text
lowbit(i) = i & -i
tree[i] stores the sum over (i - lowbit(i), i]
```

```cpp
#include <cassert>
#include <cstddef>
#include <vector>

class Fenwick {
    std::vector<long long> tree_;  // index 0 unused

public:
    explicit Fenwick(std::size_t n) : tree_(n + 1) {}

    void add(std::size_t index, long long delta) {
        for (std::size_t i = index + 1; i < tree_.size();) {
            tree_[i] += delta;
            const auto step = i & (~i + 1);
            if (step >= tree_.size() - i) break;
            i += step;
        }
    }

    long long prefix(std::size_t end) const {  // sum of [0, end)
        long long result = 0;
        for (std::size_t i = end; i != 0; i -= i & -i) result += tree_[i];
        return result;
    }

    long long range(std::size_t first, std::size_t last) const {
        return prefix(last) - prefix(first);
    }
};

int main() {
    Fenwick sums{5};
    sums.add(1, 4);
    sums.add(3, 7);
    assert(sums.prefix(4) == 11);
    assert(sums.range(2, 4) == 7);
}
```

Update and prefix query touch O(log n) entries using arithmetic indices and one compact array. Arbitrary range sum uses subtraction, so the aggregate needs an inverse for that step. Variants for other operations have different update/query restrictions; a plain Fenwick tree is not a universal range monoid.

The public methods require `index < n` and `first <= last <= n`; a production interface should enforce or document those preconditions. The guarded update step avoids unsigned wrap while advancing beyond the final responsible node.

Choose Fenwick for compact point-update/prefix/range sums. Choose a segment tree for richer associative aggregates or range-update machinery. For static data, prefix sums or other preprocessing may give O(1) queries with no update support.

---

## Recall card — Core

- **Invariant first:** state legal layout, then show each mutation preserves it.
- **Bounds:** label worst-case, expected, and amortized; do not merge them.
- **Arrays:** dense scans and O(1) index; growth/middle edits move elements.
- **Lists:** stable nodes and O(1) unlink only when the node/position is already known.
- **Ring:** live interval `[head, tail)`, physical slot `position % capacity`, explicit full policy.
- **Slab:** occupied/free partition plus generation-checked handles; generation is not reclamation.
- **Hash:** expected O(1) under hash/load assumptions; rehash O(n), worst lookup O(n).
- **Ordered:** binary/B-tree for ranges and mutation; sorted flat storage for read-mostly locality.
- **Heap:** root extremal, push/pop O(log n) worst case, bottom-up heapify O(n).
- **Graph:** CSR is static sparse adjacency flattened into offsets and targets.
- **DSU:** union by size/rank plus path compression gives inverse-Ackermann amortized sequences.
- **Approximate/cache:** Bloom has one-sided membership error; LRU mutates on hits.

---

## Common traps — Core

- Naming a container before defining the ADT operations and failure behavior.
- Saying list insertion is O(1) without already having the position.
- Treating reserved capacity as a hard maximum.
- Using reduced ring indices without a full/empty convention.
- Assuming power-of-two capacity is required for ring correctness.
- Making ring indices atomic and declaring the queue correct or lock-free.
- Destroying or copying an object while its intrusive hook is linked.
- Treating a generation tag as safe concurrent reclamation.
- Retaining a slab pointer across erase/reuse instead of revalidating the handle.
- Calling hash lookup worst-case O(1), or forgetting the rehash path.
- Claiming standard unordered containers are mandated to chain.
- Claiming standard ordered maps are mandated to use red-black trees.
- Assuming heap storage is sorted or that heapify is O(n log n).
- Failing to update an indexed heap's position map on every swap.
- Using CSR for a graph with frequent online edge insertion.
- Crediting path compression alone with the combined DSU bound.
- Clearing Bloom bits to delete keys.
- Treating a Bloom positive as authoritative.
- Forgetting that an LRU hit writes shared recency state.
- Applying Fenwick range subtraction to an operation without an inverse.

---

## Reasoning questions

1. A workload inserts into the middle after a linear search. Why does a linked list's O(1) splice not settle the choice against a vector?
2. Give two full/empty conventions for a ring and state the usable capacity of each.
3. What does a generation handle detect, and which concurrent-use failure does it not prevent?
4. Under what workload would direct indexing beat hashing despite potentially higher empty-space cost?
5. Why is hash lookup expected rather than worst-case O(1), and which single operation creates a latency spike after growth?
6. Prove bottom-up heap construction is O(n) without charging O(log n) to every node.
7. What CSR invariants must be validated before exposing a neighbor span?
8. Compare AVL, red-black, B-tree, and sorted-array layouts for a read-heavy ordered index with batch updates.
9. Why does an LRU cache serialize “reads” under a simple lock, and which policy/layout changes reduce that mutation?
10. For dynamic range sums, what does a Fenwick tree give up relative to a segment tree in exchange for compactness?

---

## Code-reading puzzle

```cpp
auto handle = slab.insert(Order{42}).value();
Order* cached = slab.get(handle);

slab.erase(handle);
auto replacement = slab.insert(Order{99}).value();  // may reuse the slot

if (slab.get(handle) == nullptr) {
    process(*cached);
}
```

The generation check correctly rejects `handle`, yet the program is still invalid. Identify the violated lifetime rule, explain why comparing generations cannot repair an already escaped pointer, and redesign the call site so every access passes through a live handle.

---

## Implementation exercise

Implement and test these invariant-focused components:

1. A single-threaded fixed-capacity ring with non-default-constructible values and explicit reject-on-full behavior. Trace a wrap and test destructor calls.
2. Floyd bottom-up heapify with `sift_down`; compare the result with `std::is_heap` and pop all values in order.
3. DSU with union by size and path halving; test repeated union, isolated elements, and a long merge sequence.
4. A fixed slab with generation handles; force slot reuse and verify stale lookup fails. Define generation-wrap behavior.

For each, write the invariant beside the implementation and add an assertion-oriented validator. Concurrency is deliberately excluded; Chapter 26 adds it only after the single-threaded state machine is correct.

---

## Prerequisite for Chapter 22

Chapter 22 assumes that operation bounds can be derived from invariants; expected and amortized costs are distinguished from worst case; graph storage terms such as adjacency and CSR are familiar; and heap, DSU, and range-query operations can be used without re-teaching their representations. Chapter 22 focuses on algorithmic patterns and proofs over these structures.
