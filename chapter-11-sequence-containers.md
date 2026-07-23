# Chapter 11 — Sequence Containers

## Why this matters — Core

Container choice is a joint decision about **layout, mutation, handle stability, and allocation**. `std::vector` is often the right starting point because contiguous traversal and compact storage suit modern processors, but “use vector by default” is not a complete engineering argument. A vector that grows on the critical path can allocate and move every element. A deque keeps references stable during end insertion but is segmented and can still allocate. A list keeps all surviving elements stationary but normally pays for a node allocation and a dependent pointer load per element.

The interview-quality answer therefore starts with a workload:

1. Is the maximum count fixed, bounded, or unbounded?
2. Is access a scan, indexed access, end mutation, or mutation at a known position?
3. Must pointers, references, or iterators survive a mutation?
4. May allocation or element movement occur in the latency-critical phase?
5. Is overflow impossible by contract, an error, or a condition that needs backpressure?

Those questions usually select the representation before Big-O notation does. This chapter covers the C++23 standard library and clearly labels non-standard alternatives. C++23 has no standard fixed-capacity vector named `std::inplace_vector`; that type belongs to a later standard. In C++23 code, a fixed-capacity vector is a third-party or application type.

---

## 90-second screen — Core

1. `std::array<T, N>` stores exactly `N` contiguous `T` objects inline. `std::vector<T>` stores a variable number of contiguous `T` objects in allocator-provided storage. `std::deque<T>` is random-access but not contiguous. `std::list` and `std::forward_list` are node-based.
2. For `vector`, reallocation invalidates every iterator, pointer, and reference. Without reallocation, insertion invalidates handles at or after the insertion point; erasure invalidates handles at or after the erased position.
3. For `deque`, insertion at either end invalidates iterators but preserves pointers and references to existing elements. Middle insertion or erasure has much broader invalidation. Never infer pointer stability from iterator stability or vice versa.
4. `reserve` changes vector capacity, not size. Reserve once before a growth phase when a useful bound is known. Calling `reserve(size() + 1)` before every append defeats amortized growth and produces quadratic movement.
5. List insertion is O(1) only after the position is known. A search followed by insertion is still O(n), with poor locality. Lists are compelling when a stable iterator is already available and nodes must be spliced or erased.
6. A bounded inline vector avoids allocation but needs an explicit overflow policy. A small-vector-optimized type is different: it stores a small count inline and allocates when that count is exceeded.
7. A fixed-capacity ring is usually the sequence for bounded FIFO traffic. It needs a separate concurrency protocol if producer and consumer are different threads; container layout alone does not make a queue thread-safe.

Two choices to defend:

- Choose `vector` for append-then-scan data when handles do not cross a reallocating mutation; reserve before the measured hot phase if a bound is available.
- Choose stable storage or stable generational handles when other components retain element identity. Do not repair a dangling-pointer design by hoping that capacity will be “large enough.”

---

## 11.1 The governing model: storage topology — Core

All of these containers maintain an ordered sequence, but they place its elements differently:

```text
array object:   [ T ][ T ][ T ][ T ]             fixed, contiguous, inline

vector object:  [metadata] ──> [ T ][ T ][ T ]   variable, contiguous allocation
                                      [spare]

deque object:   [metadata] ──> [block][block]...  variable, segmented
                                [T T]  [T T]

list object:    [metadata] ──> [links|T] <─> [links|T] <─> ...
```

The standard guarantees the observable properties—contiguity, complexity, and invalidation—not these exact metadata layouts. Implementations are free to represent a vector, deque, or list differently while preserving the specified behavior. Code must not copy container objects with `memcpy`, assume a particular `sizeof`, or calculate a deque block boundary.

### Common sequence operations

Sequence containers organize elements by position rather than by key. Their interfaces overlap, but the overlap is not complete:

| Operation or property | `array` | `vector` | `deque` | `list` | `forward_list` |
|---|---:|---:|---:|---:|---:|
| Fixed size | Yes | No | No | No | No |
| Contiguous elements | Yes | Yes | No | No | No |
| Constant-time indexed access | Yes | Yes | Yes | No | No |
| Constant-time insertion at back | — | Amortized | Yes | Yes | — |
| Constant-time insertion at front | — | No | Yes | Yes | Yes |
| Constant-time insertion at a known middle position | — | No | No | Yes | Yes, after predecessor |
| Iterator category | Random access, contiguous | Random access, contiguous | Random access | Bidirectional | Forward |
| Allocator-aware | No | Yes | Yes | Yes | Yes |

“Constant time” does not mean fixed latency. A deque end insertion may allocate a block; a list insertion normally allocates a node; a vector append occasionally reallocates and moves the existing sequence. Complexity counts operations as input size grows. It does not bound allocator locks, page faults, cache misses, element constructor work, or exception paths.

`std::array` is the fixed-size exception to most mutating sequence APIs: it has no `insert`, `erase`, `push_back`, or `clear` because all `N` elements always exist. `std::forward_list` uses `insert_after` and `erase_after`; a singly linked node does not know its predecessor.

### Contiguous versus segmented versus node-based

Contiguous storage gives three practical advantages:

- A scan reads densely packed bytes and exposes predictable addresses to hardware prefetching.
- Indexed access is address arithmetic.
- The range can be passed as `std::span<T>` or as a pointer and length to an appropriate C interface.

Its main cost is displacement. Growing a vector beyond capacity moves or copies existing elements into a new allocation. Inserting in the middle shifts the suffix even when capacity is available.

Segmented storage avoids moving the whole sequence when it grows at an end. A deque typically manages separately allocated blocks through indexing metadata. The standard does not specify the block size or the form of that metadata. Indexed access remains O(1), but a range can cross block boundaries and `data()` is unavailable.

Node-based storage makes the address of each surviving element independent of changes elsewhere. That stability costs link fields, allocation metadata, and pointer chasing. The next node's address becomes known only after reading the current node, which forms a dependency chain. The penalty depends on node placement and cache residency; it is not a universal number of nanoseconds.

### A compact decision flow

```text
Fixed element count known at compile time?
  yes ──> array
  no
   │
Hard maximum with no allocation allowed?
  yes ──> fixed-capacity inline vector, array+size, or ring
  no
   │
Need FIFO overwrite/wrap or bounded producer-consumer traffic?
  yes ──> ring, with a separate synchronization protocol if shared
  no
   │
Need surviving element addresses stable across mutation?
  end insertion only ──> consider deque
  arbitrary splice/erase with a held iterator ──> consider list/intrusive list
  identity outlives storage changes ──> pool/slab plus generational handle
  no ──> vector
```

The final branch is deliberately biased toward `vector`. Replace it only when the workload names the guarantee that vector cannot provide.

---

## 11.2 Correctness first: invalidation and exception boundaries — Core

A handle is an iterator, pointer, or reference that designates an element or a position. An operation **invalidates** a handle when subsequent use is no longer permitted. Dereferencing an invalid handle is undefined behavior; even operations such as incrementing an invalid iterator are invalid. A pointer can dangle although its stored bits still resemble the old address.

### Authoritative invalidation table

The table separates iterators from pointers/references because `deque` treats them differently. “At/after” includes the old past-the-end iterator.

| Container and operation | Iterators | Pointers and references to elements | Past-the-end iterator |
|---|---|---|---|
| `array`: element assignment | Remain valid | Remain valid; designated value may change | Remains valid |
| `array`: `swap` | Remain associated with the same array object | Remain associated with the same element slot; value is exchanged | Remains valid |
| `vector`: `reserve` with requested capacity no greater than current capacity | Remain valid | Remain valid | Remains valid |
| `vector`: `reserve` that increases capacity | All invalidated | All invalidated | Invalidated |
| `vector`: end insertion without reallocation | Existing element iterators remain valid | Existing element handles remain valid | Invalidated |
| `vector`: any insertion with reallocation | All invalidated | All invalidated | Invalidated |
| `vector`: middle insertion without reallocation | At and after insertion invalidated | At and after insertion invalidated | Invalidated |
| `vector`: erase or `pop_back` | Erased element and everything after it invalidated | Same | Invalidated |
| `vector`: `clear` | All element iterators invalidated | All element handles invalidated | Invalidated |
| `vector`: `shrink_to_fit` | All invalidated if capacity is reduced; otherwise none | Same | Same |
| `deque`: insert at either end | All invalidated | Existing element handles remain valid | Invalidated |
| `deque`: insert in the middle | All invalidated | All invalidated | Invalidated |
| `deque`: erase at the front | Only handles to erased elements invalidated | Same | Remains valid |
| `deque`: erase at the back | Handles to erased elements invalidated | Same | Invalidated |
| `deque`: erase in the middle | All invalidated | All invalidated | Invalidated |
| `list`/`forward_list`: insert | Remain valid | Remain valid | Remains valid |
| `list`/`forward_list`: erase | Only handles to erased elements invalidated | Same | Remains valid |
| `list`/`forward_list`: splice | Remain valid; moved-element iterators now refer into the destination | Remain valid | Remains valid |

For deque erasure of a range, classify the operation by whether the range is wholly at the beginning, wholly at the end, or in the middle. Conservative code should recalculate `end()` after every size-changing operation rather than encode container-specific past-the-end exceptions into a loop.

`swap` deserves special care. Standard container rules generally preserve element handles while changing which container owns the elements, subject to allocator requirements. `std::array::swap` is different in mechanism: it swaps corresponding element values, so a reference continues to refer to the same slot in the same array. For allocator-aware containers, unequal non-propagating allocators can restrict or change the legality and cost of swap; Chapter 8 owns allocator propagation.

### Stable does not mean synchronized

Reference stability says that a single-threaded mutation does not relocate a particular element. It grants no permission for concurrent unsynchronized access. If one thread modifies a deque while another reads it without a valid synchronization protocol, a data race can still occur. Similarly, a list iterator remaining valid after insertion says nothing about visibility between threads. Chapters 25 and 26 own data races and concurrent queues.

### Exception guarantees affect latency and state

Allocation and element construction can throw. The most important vector case is reallocation:

1. allocate new storage;
2. construct the new sequence there, transferring old elements;
3. destroy the old elements;
4. release the old storage.

To preserve the original vector if transfer fails, standard-library implementations commonly copy when `T` has a potentially throwing move constructor and is copy-constructible. If `T` is move-only and its move can throw, a failed reallocation cannot always restore already moved-from elements; the strong guarantee may be waived and effects can be unspecified. A `noexcept` move constructor therefore affects both the failure model and the transfer strategy an implementation can safely choose. Chapter 10 develops that rule.

List and deque operations can also allocate. Node or block allocation failure is not made predictable by their asymptotic complexity. For a latency-critical phase, the robust policy is to establish capacity/storage beforehand, use an allocator/resource with understood behavior, or choose a bounded representation whose full condition is explicit.

### Correct erasure idioms

Erasing while iterating must use the iterator returned by `erase`:

```cpp
#include <vector>

struct Order {
    bool cancelled;
};

int main() {
    std::vector<Order> orders{{false}, {true}, {false}};

    for (auto it = orders.begin(); it != orders.end();) {
        if (it->cancelled) {
            it = orders.erase(it);
        } else {
            ++it;
        }
    }
}
```

Incrementing `it` after `orders.erase(it)` would increment an invalid iterator. For vector-like containers, repeated single-element erasure can also be O(n²) because every erase shifts a suffix. C++20's `std::erase_if(orders, predicate)` performs the appropriate bulk removal and is normally clearer.

The classic erase-remove form remains useful:

```cpp
orders.erase(
    std::remove_if(orders.begin(), orders.end(), predicate),
    orders.end());
```

`std::remove_if` alone changes no container size. It moves retained elements toward the front and returns the new logical end; `erase` destroys the tail.

### External identity needs more than a stable address

Suppose another component retains an order handle while the owning sequence mutates. Options include:

- a deque when mutations are strictly at the ends and erased elements are never retained;
- a node-based container when stable addresses and arbitrary erasure are required;
- individually owned objects with a separate sequence of owning or non-owning handles;
- a preallocated slab addressed by an index plus generation.

A bare index prevents relocation from changing the handle, but it does not detect slot reuse. Pairing the index with a generation lets lookup reject a handle after the slot has been released and reacquired. It still requires synchronization if access is concurrent. Chapter 21 develops indexed free lists; this chapter uses the pattern only as a container-selection alternative.

---

## 11.3 `std::array`: fixed count, inline elements — Core

`std::array<T, N>` is an aggregate containing exactly `N` elements in contiguous order. Its size never changes, it has no allocator, and access to an element requires no container-managed pointer to a separate buffer. Those are portable semantic guarantees. An exact implementation struct, object size, padding pattern, and type-trait result should be queried on the target rather than asserted as part of a portable design.

For `N > 0`, `data()` points at the first element and `data() + size()` is the end of the contiguous range. `std::array<T, 0>` is valid and `begin() == end()`, but calling `front()` or `back()` is undefined. Code should not assume whether `data()` for the zero-size case is null.

### Initialization is the main correctness trap

```cpp
#include <array>
#include <cassert>
#include <tuple>

int main() {
    std::array<int, 3> values{};       // {0, 0, 0}
    std::array<int, 3> partial{7};     // {7, 0, 0}
    std::array deduced{2, 4, 6};       // std::array<int, 3>

    auto [a, b, c] = deduced;          // tuple protocol
    assert(a == 2 && b == 4 && c == 6);
    assert(values[1] == 0 && partial[2] == 0);
}
```

At block scope, `std::array<int, 3> values;` default-initializes its `int` elements; in C++23, reading them before writing them has undefined behavior. Braces value-initialize the remaining elements. `std::to_array("OK")` produces an array that also contains the terminating null character.

Unlike a built-in array, `std::array` does not decay to a pointer during ordinary expression use, is assignable element by element, supports lexicographical comparison, and participates in the tuple protocol. It can still expose its elements through `data()` or convert to `std::span`.

### Workloads and costs

Choose `array` when the element count is part of the type or protocol: a fixed set of feed fields, a lookup table, a vector of SIMD lanes, or a bounded set of book levels whose every slot is a live object. It gives:

- no allocation;
- no reallocation or iterator invalidation;
- dense traversal;
- object size proportional to `N * sizeof(T)` plus any permitted padding.

That final property is also a cost. Passing a large array by value copies or moves every element. Embedding it in another object enlarges every instance, even if a separate logical `size` says few entries are used. A large automatic array consumes stack space. Pass read-only data as `std::span<const T>` when callers may supply different contiguous containers, and measure object placement rather than assuming “inline” always means cache-resident.

An `array<T, N>` constructs all `N` elements. It is not a substitute for a fixed-capacity vector when only the first `size` slots should have live `T` objects, especially if `T` is expensive to default-construct or not default-constructible.

---

## 11.4 `std::vector`: the contiguous dynamic default — Core

`std::vector<T>` owns a variable-size contiguous sequence. The vector object stores metadata; its elements occupy allocator-provided storage. The exact metadata layout is unspecified. Once the first element address has been loaded, an optimized scan can keep that pointer in a register and advance through contiguous memory. It is therefore misleading to price every `v[i]` as a mandatory repeated “two-load” sequence; inspect generated code and measure the actual loop.

### Guarantees and operation costs

| Operation | Complexity | Invalidation/cost consequence |
|---|---:|---|
| `operator[]`, `front`, `back`, `data` | O(1) | `operator[]` is unchecked; precondition is that the element exists |
| `at` | O(1) | Checks bounds and throws `std::out_of_range` |
| `push_back`, `emplace_back` | Amortized O(1) | Reallocating call is O(n) and invalidates all handles |
| `pop_back` | O(1) | Destroys last element; capacity is unchanged |
| insert/erase at index `i` | O(size − i) | Shifts the suffix; invalidates from the position onward |
| `clear` | O(n) destruction | Size becomes zero; capacity is unchanged |
| sequential traversal | O(n) | Dense, predictable access |

Contiguity means that for a valid element index, `&v[i] == v.data() + i`. The buffer can be viewed as `std::span<T>` and can be passed to an interface that accepts a pointer and element count. This does not make an arbitrary `T` buffer byte-serializable; object representation rules remain those of Chapter 3.

`emplace_back(args...)` constructs the new element from the supplied arguments. `push_back(value)` copies or moves an existing `T`. Emplacement removes a temporary only when the call site would otherwise create one; it does not avoid vector growth, element transfer, allocation, or the cost of the constructor itself. Prefer whichever form makes ownership and construction clear.

### `vector<bool>` is a deliberate specialization

`std::vector<bool>` may pack bits. Its reference type is a proxy rather than `bool&`, and its iterators do not necessarily satisfy assumptions made by generic code about ordinary contiguous `T` storage. It has no ordinary `bool*` data buffer. Use it when compact bit storage is the actual requirement and the proxy semantics are acceptable. Use `std::vector<std::uint8_t>` when ordinary addressable byte-sized elements matter, or a dedicated bit-vector type when bit operations dominate.

### Aliasing an element during insertion

A direct call such as `v.push_back(v.front())` must preserve the value of its aliased argument even if growth occurs. That does not rescue a pointer invalidated by an earlier operation:

```cpp
#include <cassert>
#include <vector>

int main() {
    std::vector<int> values{9};

    while (values.size() < values.capacity()) {
        values.push_back(0);
    }

    values.push_back(values.front());  // source is an element of this vector
    assert(values.back() == 9);

    [[maybe_unused]] int* cached = values.data();
    while (values.size() < values.capacity()) {
        values.push_back(0);
    }
    values.push_back(1);               // necessarily grows: cached now dangles
    // Reading *cached here would be undefined behavior.
}
```

The distinction is temporal: `values.front()` is valid when the container operation begins, so the operation must implement its specified semantics in the presence of that alias. `cached` becomes invalid when the later reallocation completes. Passing `*cached` after it has already become invalid would dereference a dangling pointer before vector could protect anything.

### Erasing cheap-to-move values

For small trivially copyable or cheap-to-move elements, shifting a contiguous suffix can be competitive with a node-based “constant-time” insertion because the shift is sequential while finding a list position is a pointer-chasing scan. The relevant estimate is not merely O(n):

```text
vector middle erase:
    elements moved = size - erased_index - 1
    bytes touched  ≈ elements moved × sizeof(T)

list erase by value:
    nodes visited  = distance from known start to target
    each visit depends on loading the previous node's link
```

If the position is already known through a list iterator, the search term disappears and list may win. If it is not known, compare measured suffix movement with measured node traversal and allocation behavior on the target workload.

### C++23 range insertion

C++23 adds range-oriented vector operations including `assign_range`, `insert_range`, and `append_range`, as well as range construction facilities. They express whole-range intent and can exploit range properties such as a known size. They do not change the fundamental rule: if capacity is insufficient, element relocation and global invalidation can occur.

---

## 11.5 Vector growth, capacity, and failure cost — Core

`size()` counts constructed elements. `capacity()` counts how many elements can fit in the current allocation before another allocation is required. The interval `[size(), capacity())` is storage, not a range of live elements.

```cpp
#include <cassert>
#include <vector>

int main() {
    std::vector<int> values;
    values.reserve(8);

    assert(values.empty());
    assert(values.capacity() >= 8);

    values.push_back(4);  // values[0] now exists
    values.resize(4);     // adds three value-initialized ints
    assert(values[3] == 0);
}
```

Writing `values[0]` immediately after `reserve(8)` is undefined because no `int` exists there. `resize(8)` would create elements; `reserve(8)` does not.

### What geometric growth guarantees—and what it does not

Repeated `push_back` has amortized constant complexity. Implementations obtain that result by reserving spare capacity rather than allocating exactly one additional slot on every append. The standard does not specify a growth factor, an initial capacity, or the capacity observed after a particular append sequence. Those choices can vary by library version, element size, allocator, and requested size.

When growth occurs, old and new buffers may coexist while elements are transferred. Peak live allocation therefore includes both buffers plus allocator overhead. For large sequences, a reallocating call can create a memory-pressure and latency spike even though the average append cost is constant.

If a model assumes a fixed multiplicative growth factor `g > 1`, the number of old elements transferred over many reallocations forms a geometric series. A larger `g` usually reduces transfer frequency but leaves more spare capacity; a smaller `g` usually uses space more tightly but reallocates more often. This is a model for reasoning, not a portable prediction of `capacity()`.

### Capacity controls

- `reserve(n)` ensures capacity is at least `n`; it reallocates only if `n` exceeds current capacity.
- `resize(n)` changes the number of live elements, constructing or destroying as required.
- `clear()` destroys all elements but does not reduce capacity.
- `shrink_to_fit()` is a non-binding request. If capacity is reduced, all handles are invalidated.

Reserve once before a known growth phase. This pattern is deterministic with respect to vector growth until the bound is exceeded:

```cpp
std::vector<Event> events;
events.reserve(max_events_for_batch);
for (const Event& event : input) {
    events.push_back(event);
}
```

By contrast, this pattern is quadratic:

```cpp
for (const Event& event : input) {
    events.reserve(events.size() + 1);  // defeats spare-capacity growth
    events.push_back(event);
}
```

Each reserve request can force allocation and movement of the entire existing prefix. If no useful bound is known, normal vector growth is better than manufacturing an exact-capacity sequence.

### Releasing capacity is allocator-sensitive

Destroying a vector asks its allocator to deallocate its buffer. Swapping with a compatible empty vector or assigning an empty temporary may release the vector's current allocation, subject to allocator equality and propagation rules. A polymorphic memory resource may retain the returned block for later use, and an operating-system allocator may keep freed pages in the process. Therefore “capacity became zero,” “the allocator accepted deallocation,” and “resident memory fell” are different observations.

Capacity release is normally a control-plane operation, not a hot-path optimization. It can allocate during transfer, invalidate every handle, and worsen the next growth phase. Measure the quantity that matters—container capacity, allocator resource usage, or resident memory—instead of assuming they move together.

### Low-latency policy

For append-then-process batches:

1. obtain a defensible upper bound or measured percentile;
2. reserve before entering the critical phase;
3. define what happens if the estimate is exceeded;
4. keep stored handles shorter-lived than the next possible reallocation;
5. measure allocation count, bytes moved, and high-percentile operation latency.

If exceeding the estimate is unacceptable, `vector` plus `reserve` is not a hard bound. Use a fixed-capacity type and make “full” part of the interface.

---

## 11.6 `std::deque`: end growth with stable references — Core

`std::deque<T>` is a variable-size random-access sequence whose elements are not required to be contiguous. A typical implementation uses multiple allocated blocks plus indexing metadata, but block dimensions and metadata representation are implementation details.

The defining guarantee is precise:

- inserting at either end invalidates all iterators;
- pointers and references to existing elements survive that end insertion;
- inserting in the middle invalidates all iterators, pointers, and references.

That makes deque suitable when a sequence grows at its ends while another component temporarily retains a reference to an existing element. It does not make references to erased elements safe, and it does not permit concurrent access without synchronization.

### Costs relative to vector

| Property | `vector` | `deque` |
|---|---|---|
| Element layout | Contiguous | Segmented |
| Random access | O(1) | O(1) |
| `data()` | Yes | No |
| Append at back | Amortized O(1), may move all elements | O(1), does not move existing elements |
| Push at front | O(n) | O(1) |
| Existing references after end insert | May dangle on reallocation | Remain valid |
| Middle insert/erase | Shifts suffix | Moves the shorter side in typical designs; O(n), broad invalidation |
| Allocation pattern | Occasional growing buffer | Additional blocks and occasional metadata growth |

Deque's O(1) indexed access can involve more address calculations and metadata reads than vector access. Whether that matters depends on the loop, compiler, element size, and cache state. A sequential deque scan may still be efficient within blocks, but it cannot be treated as one contiguous byte range.

### A valid stability use

```cpp
#include <cassert>
#include <deque>

int main() {
    std::deque<int> queue{10, 20};
    int& first = queue.front();

    queue.push_back(30);
    queue.push_front(5);
    assert(first == 10);       // reference survived both end insertions

    // An iterator saved before either insertion would be invalid.
    // Erasing the element denoted by first would invalidate first itself.
}
```

A deque end operation can still allocate, so it does not provide an allocation-free tail-latency bound. For a bounded FIFO on a hot path, a preallocated ring is usually a better match. For an unbounded staging sequence outside the critical path, deque may be the simpler standard type.

`std::queue` and `std::stack` are adaptors, and deque is their default underlying container. The default is a semantic choice that supports the required end operations; it is not proof that deque is fastest for every stack or queue workload. A vector-backed stack can be attractive when only back operations are needed and capacity is planned.

---

## 11.7 `std::list` and `std::forward_list` — Core, skippable after selection

`std::list<T>` is a bidirectional node-based sequence. `std::forward_list<T>` is singly linked and exposes only forward traversal. Both keep iterators, pointers, and references to surviving elements valid across insertion, erasure elsewhere, and splice operations.

`std::list::size()` is constant time. `forward_list` deliberately has no `size()`, `back()`, or `push_back()`. Mutation occurs after a known predecessor through operations such as `insert_after` and `erase_after`. That interface exposes the actual singly linked mechanism rather than hiding an O(n) predecessor search.

### The O(1) claim needs its precondition

Given an iterator to the position, list insertion and erasure are constant time. Given only a value or index, finding that position is linear. This difference is the center of most list interview questions.

An LRU structure illustrates a legitimate use:

- a hash table maps a key to a `list` iterator;
- the list records recency order;
- `splice` moves a known node to the front without moving its value or invalidating its iterator;
- eviction removes the known back node.

The associative lookup belongs to Chapter 12. The sequence-side reason for the list is that the position is already known and node identity must survive reordering.

### Splice and allocator compatibility

`splice` transfers nodes within a list or between compatible lists without copying or moving the contained `T`. A single-node splice is constant time. Some range and whole-list cases have different complexity because sizes may need to be determined or updated. For splicing between distinct lists, allocator compatibility is a correctness precondition; unequal allocators can make the operation undefined. Do not reduce splice to “pointer changes, always O(1)” without stating which overload and which containers are involved.

List-specific `sort`, `merge`, `reverse`, `unique`, and removal operations manipulate links. `std::sort` cannot accept list iterators because it requires random-access iterators; use `list::sort`. Link-based sorting preserves references and can sort types that should not be repeatedly moved, though locality often makes sorting a vector preferable when values are movable.

### The resource bill

A standard list normally incurs:

- storage for links and allocator bookkeeping in addition to `T`;
- allocation/deallocation behavior per node unless a resource pools nodes;
- a dependent address chain during traversal;
- more cache and translation footprint than a packed vector of the same payloads.

Exact node size and allocation strategy are implementation- and allocator-dependent. Measure them on the target; do not publish a universal byte count.

An intrusive list places link fields inside an application object. It is not a standard library container, but it can remove a separate node allocation when objects already come from a pool. The trade-off is intrusive ownership discipline: an object must not be linked into incompatible lists through the same hook, unlinking and destruction invariants become the application's responsibility, and the hook enlarges every object.

Choose a standard list when the held-iterator and stability properties dominate and allocator behavior is acceptable. Choose an intrusive structure only when object lifetime is already centrally controlled and measurement shows node allocation or indirection to be material.

---

## 11.8 Worked reasoning: predict, estimate, choose — Core

### Prediction: which handles survive?

Consider:

```cpp
std::vector<int> v{10, 20, 30};
v.reserve(8);
int& first = v[0];
auto middle = v.begin() + 1;

v.push_back(40);
v.insert(v.begin() + 2, 25);
```

Reason operation by operation:

1. After `reserve(8)`, capacity is at least eight and all prior handles would have been invalidated if reserve increased capacity. The handles shown are acquired afterward.
2. `push_back(40)` cannot reallocate because four elements fit. `first` and `middle` remain valid; the old `end()` would not.
3. `insert` at index two also fits without reallocation. Handles before the insertion point remain valid, so `first` remains valid. `middle` denotes index one, also before the insertion point, and remains valid. A handle to the old element at index two would be invalidated because that element is shifted.

Now append until `size() == capacity()`, cache `&v[0]`, and append once more. The new size cannot fit in current storage, so reallocation occurs and the cached pointer dangles. No implementation growth factor is needed to make that prediction.

### Estimate: vector movement versus list traversal

Suppose a sequence contains `n` small records and an erase occurs at index `i`.

- Vector transfers approximately `n - i - 1` records and destroys the old final record.
- List erasure is constant time only if the iterator is already held. If code starts at `begin()` and searches for the index, it performs `i` dependent link traversals before the constant-time unlink.

For an erase near the front, vector moves more bytes. For a cold list whose iterator is not known, traversal can dominate. For a large or expensive-to-move `T`, the balance can reverse. The benchmark must preserve the real element type, mutation distribution, allocator, cache state, and need for stable handles. A microbenchmark that repeatedly edits one warm sequence answers a different question from a production workload with many cold sequences.

### Choose the container: five latency-sized workloads

| Workload | Choice | Deciding condition | Invalidation/allocation consequence |
|---|---|---|---|
| A protocol message has exactly eight numeric lanes | `std::array<Lane, 8>` | Count is part of the protocol | No size mutation or reallocation; all eight objects always exist |
| A batch receives up to a known operational limit, then is scanned and discarded | Reserved `std::vector<Event>` | Contiguous scan and one bounded growth phase | No invalidation until the reserved bound is exceeded; exceeding it reallocates and is a defined fallback, not a hard cap |
| A staging sequence grows at both ends while a formatter retains a reference to an existing item | `std::deque<Item>` if access is synchronized and mutation is end-only | Reference must survive end insertion; count is unbounded | End insertion preserves the reference but invalidates iterators and may allocate |
| An LRU index already maps every key to the recency node | `std::list<Entry>` plus associative index, or an intrusive list with pooled entries | Reordering starts from a held iterator | Splice preserves node handles; standard list allocation behavior must be controlled |
| A single-threaded bounded handoff buffer rejects new input when full | Fixed-capacity ring | FIFO order, slot reuse, explicit hard bound | No container allocation after setup; reuse invalidates the old logical occupant; full is visible |

Two nearby workloads choose differently:

- A per-order fill list that is usually small but must accept arbitrarily many valid fills favors an SVO vector, because heap fallback preserves correctness.
- A book side whose protocol enforces a hard maximum favors a fixed-capacity inline sequence, because fallback allocation would hide a contract violation.

### Choosing is also choosing a failure mode

The strongest answer states what happens outside the common case:

- reserved vector: reallocates and invalidates if the estimate is exceeded;
- deque: allocates another block or propagates allocation failure;
- list: allocates a node or propagates allocation failure;
- fixed-capacity sequence: reports full, throws, terminates, or relies on a precondition;
- SVO: switches to heap storage and invalidates inline handles;
- ring: rejects, overwrites, or applies backpressure.

Tail behavior is not an afterthought. It is part of the container contract.

---

## 11.9 Fixed-capacity inline sequences in C++23 — Role-specific

C++23 does not provide `std::inplace_vector`. When a codebase uses that spelling, it is either targeting a later language/library mode or using a non-standard type in another namespace. For C++23, there are three practical patterns:

1. `std::array<T, N>` plus a logical size, when constructing all `N` objects is acceptable.
2. A vetted third-party static/fixed-capacity vector that manages object lifetimes in inline storage.
3. An application-specific type, justified only when its lifetime, exception, iterator, and overflow contracts are fully tested.

The core semantics are dynamic size, fixed capacity, inline storage, and no allocator fallback. The overflow policy is part of the type's contract: insertion might report failure, throw, terminate, or have a precondition that capacity remains. Those behaviors are not interchangeable on a low-latency path.

### `array` plus size

For cheap default-constructible values, the simple pattern is often sufficient:

```cpp
#include <array>
#include <cstddef>
#include <span>

struct Level {
    int price{};
    int quantity{};
};

template <std::size_t Capacity>
class BookSide {
    std::array<Level, Capacity> levels_{};
    std::size_t size_{};

public:
    bool push_back(Level level) noexcept {
        if (size_ == Capacity) {
            return false;
        }
        levels_[size_++] = level;
        return true;
    }

    std::span<const Level> levels() const noexcept {
        return {levels_.data(), size_};
    }
};

int main() {
    BookSide<32> bids;
    return bids.push_back({101, 8}) ? 0 : 1;
}
```

This constructs 32 `Level` objects and assignment replaces their values. A true fixed-capacity vector would keep only `size()` live `T` objects in raw inline storage. Implementing that correctly requires alignment, explicit lifetime start and end, exception-safe partial construction, copy/move operations, destruction, and iterator rules. Reuse a reviewed type rather than compressing those rules into interview pseudocode.

### Invalidation and move cost

A fixed-capacity inline vector never reallocates, so appending at the end preserves existing element pointers and references. Middle insertion and erasure still shift elements and invalidate handles at or after the modification. Moving the container generally has to move its inline elements; unlike an ordinary vector with compatible allocators, it cannot necessarily transfer ownership by stealing one buffer pointer.

The container object is large enough for its maximum capacity even when empty. This removes allocation and an element-buffer indirection, but increases the size of every parent object and the cost of moving or copying that parent. Select `N` from a protocol limit or measured distribution, not from a cache-line slogan.

---

## 11.10 Small-vector optimization — Role-specific

A small-vector-optimized type stores up to an inline capacity inside the container object and switches to allocated storage when the sequence grows beyond it. Several non-standard libraries provide such types; their APIs, allocator support, growth policy, move behavior, and invalidation details differ.

The crucial distinction is:

| Question | Fixed-capacity inline vector | Small-vector-optimized vector |
|---|---|---|
| Maximum size | Hard limit | Limited only by allocation/resources |
| Allocation | Never | Begins after inline capacity |
| Overflow | Explicit policy | Falls back to heap |
| Object size | Includes fixed storage | Includes inline storage plus state |
| Append invalidation | No reallocation, but full must be handled | Switching to heap invalidates all element handles |
| Move | Usually moves inline elements | May move inline elements or steal heap storage |

SVO is attractive for collections that are usually small but must preserve correctness for a long tail: a fill list that normally contains two entries but occasionally contains many, for example. It trades a smaller common-case allocation count for larger container objects and a bimodal path. Crossing the inline threshold is exactly the kind of rare event that can appear in tail latency.

Measure:

- the distribution of sizes, including bursts;
- the fraction that crosses the inline threshold;
- object density in the parent array or pool;
- allocations and bytes moved;
- typical and high-percentile append latency.

If “never allocate” is a requirement, SVO is the wrong type because heap fallback is its defining escape hatch. If size is formally bounded, a fixed-capacity type makes the contract visible and avoids maintaining two storage modes.

---

## 11.11 Fixed-capacity rings — Role-specific

A ring stores a bounded logical sequence in a fixed array and wraps indices at the end. It is the natural representation for FIFO traffic when old front slots can be reused. After initialization, a simple ring needs no container-storage allocation and moves no surviving element merely to pop the front; operations performed by `T` can still allocate.

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <utility>

template <class T, std::size_t Capacity>
class Ring {
    static_assert(Capacity > 0);

    std::array<T, Capacity> storage_{};
    std::size_t head_{};
    std::size_t size_{};

public:
    bool push_back(T value) {
        if (size_ == Capacity) {
            return false;
        }
        const auto slot = (head_ + size_) % Capacity;
        storage_[slot] = std::move(value);
        ++size_;
        return true;
    }

    T& front() {
        assert(size_ != 0);
        return storage_[head_];
    }

    void pop_front() {
        assert(size_ != 0);
        head_ = (head_ + 1) % Capacity;
        --size_;
    }

    bool empty() const noexcept { return size_ == 0; }
};

int main() {
    Ring<int, 4> ring;
    assert(ring.push_back(7));
    assert(ring.front() == 7);
    ring.pop_front();
    assert(ring.empty());
}
```

This compact version constructs every slot and is appropriate for cheap, default-constructible value types. Its own storage does not allocate after construction, but assignment of a general `T` still could. It also leaves a popped value alive until that slot is overwritten or the ring is destroyed. A general ring must manage the lifetime of only occupied slots, as a fixed-capacity vector does.

The full condition needs an explicit policy:

- reject the new element and return failure;
- overwrite the oldest element;
- block or apply backpressure outside the container;
- record loss and continue;
- treat full as a violated precondition.

Each policy changes correctness. Overwriting also invalidates the logical object previously occupying that slot even though the slot's address is stable. A generation counter can detect reuse when handles escape.

A ring shared between threads is a concurrent algorithm, not merely this container with atomic indices added. Publication ordering, ownership of slots, wraparound, false sharing, and progress guarantees belong to Chapter 26. Use the single-threaded ring here only as a layout and capacity model.

---

## 11.12 Measurement checklist — Role-specific

When container choice is performance-sensitive, benchmark the actual decision rather than isolated syntax. Record:

1. size and mutation-position distributions;
2. element size, alignment, and move/copy/destructor cost;
3. allocation count, allocated bytes, and resource behavior;
4. bytes moved per operation;
5. working-set size and cache state;
6. typical, high-percentile, and worst observed latency;
7. memory footprint per live element and per empty container;
8. handle lifetime and invalidation events;
9. overflow, allocation-failure, and estimate-exceeded paths.

Use an optimized build and ensure the benchmark consumes results. Separate construction from steady-state traversal if production does so. Randomize or reproduce the real access distribution; otherwise a hot repeated scan can exaggerate locality. Hardware counters can help attribute cache and branch effects, while allocator instrumentation identifies the rare calls that dominate a tail.

The rollback should also be explicit. For example: “Replace the list with a vector if measured middle-edit latency remains within the budget and no consumer requires stable references,” or “reduce the SVO inline count if parent-object density harms scan time more than saved allocations help.”

---

## Recall card — Core

- **Topology selects behavior:** array and vector are contiguous; deque is segmented; list-like containers are node-based.
- **`array`:** fixed count, inline elements, no allocation, no size-changing operations. Braces matter for initialization.
- **`vector`:** dynamic contiguous storage and the default for append/scan. Reallocation invalidates everything; middle edits invalidate from the edit onward.
- **Capacity:** `reserve` creates no objects. Reserve once before a bounded phase. `clear` retains capacity; `shrink_to_fit` is non-binding.
- **`deque`:** constant-time operations at both ends and stable references during end insertion, but all iterators are invalidated by end insertion and the range is not contiguous.
- **Lists:** stable surviving element handles and constant-time edits at a known position. Searching for that position is linear and traversal is pointer-dependent.
- **Fixed capacity:** C++23 has no `std::inplace_vector`. Use `array+size` for simple values or a vetted fixed-capacity type; define full behavior explicitly.
- **SVO:** small inline, heap fallback. It reduces common-case allocation but crossing the inline threshold can allocate and invalidate all handles.
- **Ring:** bounded FIFO with slot reuse. It is not concurrently safe without a separate synchronization algorithm.
- **Identity:** if a handle must outlive storage mutation and slot reuse, use stable ownership or an index plus generation—not a pointer into a vector.

---

## Common traps — Core

- Reading elements of a default-initialized local `std::array<int, N>` before writing them.
- Assuming `sizeof(std::array<T, N>) == N * sizeof(T)` or a particular vector/deque metadata layout as a portable ABI rule.
- Writing through `v[0]` after `v.reserve(n)` while `v.size()` is still zero.
- Retaining `v.data()`, an element pointer, or an iterator across a possibly reallocating vector operation.
- Caching `end()` across a size-changing operation.
- Calling `reserve(size() + 1)` on every append.
- Expecting `clear`, `pop_back`, or element erasure to reduce vector capacity.
- Treating `shrink_to_fit` as mandatory or harmless.
- Using repeated vector `erase` in a loop when one `std::erase_if` expresses the operation.
- Calling `remove_if` without erasing the returned tail.
- Assuming deque end insertion preserves iterators because it preserves references.
- Treating deque or list operations as allocation-free because their complexity is constant.
- Quoting list insertion as O(1) when the position must first be searched.
- Splicing between lists without checking allocator compatibility.
- Treating a stable address as permission for unsynchronized cross-thread access.
- Calling an SVO type fixed-capacity even though it allocates beyond the inline count.
- Teaching `std::inplace_vector` as C++23.
- Implementing raw inline storage without complete object-lifetime and exception-safety rules.
- Treating a fixed ring as a concurrent queue merely because indices can be atomic.

---

## Reasoning questions

1. A vector has spare capacity. Which handles survive an insertion at the end, and which survive an insertion at index three? Explain without saying only “no reallocation.”
2. Why can a deque reference survive `push_front` while a deque iterator does not? What implementation freedom does that distinction preserve?
3. A team calls `reserve` with the 99th-percentile batch size. What correctness and latency behavior remains for the largest one percent, and how would a hard-cap design differ?
4. Compare erasing a small record near the middle of a vector with erasing it from a list when the caller has only the record's value, not an iterator. What must be measured?
5. An SVO fill list removes almost every allocation but enlarges every `Order`. Describe a benchmark that can detect whether the trade improved end-to-end latency.
6. A pointer into a fixed-capacity ring retains the same address after many wraps. Why can it still be a stale handle, and what metadata can detect reuse?
7. A deque solves reference invalidation for an end-growing work queue. Why might it still be unacceptable on a critical thread?
8. Choose among `array`, reserved `vector`, fixed-capacity vector, SVO vector, and ring for: an exact protocol tuple, a bounded batch, a hard-bounded variable list, a usually small unbounded list, and a FIFO. State each overflow or invalidation consequence.
9. A type is move-only and its move constructor may throw. What happens to vector's reallocation strategy and exception guarantee?
10. Why is “list has O(1) insertion, vector has O(n), therefore list is faster” an incomplete argument on both the algorithmic and hardware axes?

---

## Prerequisite for Chapter 12

Chapter 12 assumes that you can classify a container as contiguous, segmented, or node-based; predict iterator/reference/pointer invalidation from a mutation; distinguish amortized complexity from a latency bound; and separate a standard guarantee from a common implementation. Associative containers reuse the same stability vocabulary, especially when rehashing invalidates iterators without necessarily invalidating references.
