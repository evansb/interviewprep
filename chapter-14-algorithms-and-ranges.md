# Chapter 14 — Algorithms and Ranges

Standard algorithms are contracts over sequences. The contract names the required iterator capability, callable semantics, preconditions, postcondition, invalidation behavior, and a complexity measure. Choosing an algorithm means choosing the cheapest postcondition that actually solves the problem: selection instead of full sorting, partitioning instead of ordering, or a lazy view instead of an intermediate container.

This chapter uses C++23. Standard guarantees are stated separately from common implementation techniques and hardware-dependent costs. Chapter 11 owns sequence-container behavior, Chapter 12 owns associative containers, Chapter 13 owns `span` and string-view lifetimes, and Chapter 22 owns derivation of general interview algorithms.

---

## Why this matters — Core

The name of an algorithm is less important than its contract. `lower_bound` can perform logarithmically many comparisons yet linearly many iterator increments. `nth_element` is linear only on average and does not sort either partition. A comparator that is not a strict weak ordering violates a precondition and can make a sorting call undefined. A range pipeline can avoid temporary allocations, but a stored view may retain references to an owner or callable that has already died.

For low-latency code, asymptotic complexity is only the first filter. Iterator movement, branches, cache misses, element moves, allocation, and parallel scheduling determine the measured distribution. Start by proving the call is valid and identifying the counted operations. Then measure the implementation on representative sizes, layouts, key distributions, and hardware.

---

## 90-second screen — Core

Five facts:

1. A valid half-open range is `[first, last)`: `last` is reachable from `first`, is not dereferenced, and permits empty ranges where `first == last`.
2. Every algorithm has preconditions. Common ones are a required iterator category, an already partitioned or sorted range, enough output storage, non-invalidated iterators, and a predicate or comparator satisfying its semantic laws.
3. `std::sort` guarantees `O(N log N)` comparisons in the worst case. `std::nth_element` guarantees `O(N)` comparisons only on average; it has no general standard worst-case bound.
4. `std::lower_bound` uses logarithmically many comparisons, but on non-random-access iterators it may perform linearly many increments. A tree container's member lookup follows the tree instead.
5. A view may borrow or own. An adaptor over an lvalue container normally refers to that container; a C++23 pipeline over a movable rvalue container can own it through `owning_view`. In either case, referenced storage and captured callables must outlive use.

Two decisions:

- For top-k, use `nth_element` when the selected prefix need not be ordered, `partial_sort` or `partial_sort_copy` when it must be ordered, and a bounded heap when input is streaming. Full sort buys an unnecessary postcondition unless the rest of the order is also needed.
- Use `accumulate` or another fixed-order reduction when replay reproducibility matters. Use `reduce` or a parallel policy only when regrouping, callable restrictions, resource use, and latency variability are acceptable and measured.

---

## 14.1 The contract model: iterators, sentinels, and half-open ranges — Core

A classic algorithm receives two iterators:

```cpp
auto found = std::find(first, last, key);
```

They describe the half-open range `[first, last)`. The convention gives three useful properties:

```text
empty:       [first,last) where first == last
one element: first points here, last points one step beyond
split at m:  [first,m) followed by [m,last), with no overlap or gap
```

The caller must supply a **valid range**. Informally, repeated increment from `first` must eventually reach `last` without leaving the sequence, and every iterator before `last` must be dereferenceable as required by the algorithm. `last` itself is a boundary and is not dereferenced.

Passing `begin()` from one vector and `end()` from another does not form a valid range. Neither does retaining iterators across a vector reallocation and then passing them to an algorithm. These are caller errors; an implementation need not diagnose them.

C++20 ranges generalize the endpoint to a **sentinel**, which may have a different type from the iterator. The sentinel must be comparable with the iterator and mark termination. This supports a null-terminated sequence or a counted/predicate endpoint without inventing an iterator value that points into the same representation.

```cpp
#include <cassert>
#include <ranges>

int main() {
    int values[] = {4, 8, 15, 16, 23, 42};
    auto first = std::counted_iterator{values, 4};
    auto range = std::ranges::subrange{
        first, std::default_sentinel
    };

    assert(std::ranges::distance(range) == 4);
    assert(*std::ranges::find(range, 15) == 15);
}
```

Here the iterator stores a remaining count and `std::default_sentinel` detects when it reaches zero. The algorithm needs no pointer to a one-past element.

### Preconditions before performance

The following checks prevent most algorithm misuse:

| Question | Example requirement | Failure consequence |
|---|---|---|
| Is `[first,last)` valid? | Both endpoints belong to the same live sequence | Undefined behavior |
| Does the iterator meet the capability? | `sort` needs random access; `reverse` needs bidirectional | Usually a compile-time failure |
| Does the data satisfy a structural precondition? | `lower_bound` needs partitioning; `merge` needs sorted inputs | Undefined behavior or unspecified result as stated by the algorithm |
| Does the callable satisfy its laws? | Sorting comparator is a strict weak ordering | Undefined behavior |
| Is output large enough? | `copy(first,last,out)` needs enough writable positions | Out-of-bounds writes and undefined behavior |
| Can input and output overlap? | Depends on the algorithm and direction | Undefined behavior if the overlap violates its precondition |
| Will the callback invalidate the traversal? | `push_back` may reallocate a vector being traversed | Iterator invalidation and undefined behavior |

Algorithms generally do not change container size because iterators do not provide a resizing interface. `remove` rearranges values but cannot erase vector elements; `copy` writes through an output iterator but does not know an output container's capacity unless an inserter is used.

### Invalidation belongs to the underlying range

An algorithm's iterators and references obey the invalidation rules of their source container. Mutating element values is different from structurally mutating the container:

- Sorting a vector reorders its elements. Existing iterators still designate positions in the same allocation, but may now refer to different values.
- A callback that calls `push_back` on that vector may reallocate and invalidate the algorithm's current iterators.
- Erasing from a list invalidates iterators to erased nodes; erasing from a vector invalidates the erased position and later positions.
- A non-owning range or view does not shield its iterators from owner mutation.

Do not modify the traversed structure from a predicate unless the algorithm explicitly permits it. Invocation order and count are constrained only by the algorithm's specification; they are not a safe event protocol.

---

## 14.2 Algorithm chooser: buy only the postcondition you need — Core

The smallest sufficient postcondition usually moves fewer elements or performs fewer comparisons:

| Need | Algorithm | Main contract |
|---|---|---|
| Find/count/test in unsorted input | `find`, `count`, `all_of`, `any_of`, `none_of` | Linear predicate/comparison applications |
| Sort all elements | `sort` | Worst-case `O(N log N)` comparisons, unstable |
| Sort all while preserving equivalent order | `stable_sort` | Stable; complexity depends on extra memory |
| Select the element at rank k | `nth_element` | Average linear comparisons; partitions, does not sort |
| Sorted top-k | `partial_sort` | Approximately `N log k` comparisons |
| Sorted top-k into separate storage | `partial_sort_copy` | Source unchanged; output holds best k in order |
| Find insertion/equivalence boundary | `lower_bound`, `upper_bound`, `equal_range` | Requires partitioning; logarithmic comparisons |
| Group by a predicate | `partition`, `stable_partition` | Linear predicate applications |
| Compact survivors | `remove_if` then container `erase`, or `erase_if` | Stable compaction for sequence containers |
| Map values | `transform` | Linear callable applications |
| Ordered fold | `accumulate` | Strict left-to-right accumulation |
| Regroupable reduction | `reduce`, `transform_reduce` | Permits reordering/grouping |

Complexity counts named abstract operations, not elapsed time. For example, a comparison may itself scan a long string, and one iterator increment in a linked list may miss in cache. Big-O also discards constants and input sizes. Use it to reject asymptotically unsuitable choices, then reason about the data path.

### Sorting contracts

`std::sort` and `std::ranges::sort` require random-access iterators and a strict weak ordering. They are not stable: equivalent elements may change relative order. In C++23, the standard requires `O(N log N)` comparisons in the worst case. It does not mandate introsort, quicksort, heapsort, insertion-sort thresholds, or any vendor-specific partition scheme.

`std::stable_sort` preserves the relative order of equivalent elements. Its comparison guarantee in C++23 is `O(N log N)` if enough extra memory is available and `O(N log²N)` otherwise. This conditional bound permits implementations to use an auxiliary buffer and an in-place fallback; it is not a portable promise that a particular call allocates or that allocation failure is handled in one specific way.

`std::list::sort` exists because the generic sort requires random access. The list member can reorder by relinking nodes and guarantees `O(N log N)` comparisons. Iterator/reference validity and implementation technique are properties of the list member, not evidence that generic `std::sort` should accept bidirectional iterators.

| Operation | Stability | Standard comparison bound | Iterator need |
|---|---|---|---|
| `sort` | No | `O(N log N)` worst case | Random access |
| `stable_sort` | Yes | `O(N log N)` with enough memory, otherwise `O(N log²N)` | Random access |
| `partial_sort` | No | Approximately `N log M`, where M is prefix size | Random access |
| heap creation `make_heap` | No | At most `3N` comparisons | Random access |
| `list::sort` | Yes | `O(N log N)` comparisons | List member operation |

The standard does not generally give these calls a “no dynamic allocation” label. If a hot-path requirement forbids allocation, test or audit the exact library implementation, provide the scratch/storage policy explicitly where possible, or choose an implementation whose memory contract you control.

### Selection and partial sorting

For `nth` inside `[first,last)`, `nth_element` rearranges the range so:

- the element at `nth` is the element that would occur there in a fully sorted range;
- for every iterator `i` in `[first,nth)` and `j` in `[nth,last)`,
  `comp(*j, *i)` is false;
- neither side is itself sorted.

The formal partition relation matters with equivalent elements and custom comparators. Avoid paraphrasing it as ordinary `<=` unless that is truly the ordering.

```cpp
#include <algorithm>
#include <cassert>
#include <vector>

int main() {
    std::vector<int> values{9, 1, 7, 3, 8, 2, 6, 4, 5};
    auto nth = values.begin() + 4;
    std::nth_element(values.begin(), nth, values.end());

    assert(*nth == 5);
    assert(std::all_of(values.begin(), nth,
                       [&](int x) { return x <= *nth; }));
    assert(std::all_of(nth, values.end(),
                       [&](int x) { return x >= *nth; }));
}
```

The inequalities are valid in this example because the default ordering on `int` is used. They do not say the prefix is `{1,2,3,4}` in that order.

`nth_element` performs `O(N)` comparisons on average. C++23 gives no general worst-case complexity guarantee. A particular implementation may use an introselect-style fallback, but that is not a standard contract.

`partial_sort(first,middle,last)` puts the smallest `M = middle-first` elements into `[first,middle)` in sorted order. It is appropriate when the prefix must be consumed in order. `partial_sort_copy` does the same into a separate output range and accepts weaker input iterators, which is useful when the source is immutable.

### Worked selection decision

Suppose one million immutable orders arrive in a snapshot and a report needs the best 100 in order. The relevant postconditions are:

1. the source must not change;
2. only 100 results are retained;
3. those 100 must be ordered.

`nth_element` violates (1) and does not provide (3). Copying all one million elements and sorting them provides far more ordering than needed. `partial_sort_copy` writes only the selected output and performs on the order of `N log k` comparisons. It also needs initialized output storage for `k` objects.

If the orders instead arrive as a stream that cannot be retained, maintain a k-element heap: compare each new order with the current worst retained order and replace when better. The standard heap algorithms provide the operations, while Chapter 22 owns the derivation and invariant.

---

## 14.3 Binary search, partitioning, and compaction — Core

Binary-search algorithms require a partitioned range with respect to the value and comparator used by that call. A fully sorted range satisfies this for all compatible values, but “sorted” is stronger than the actual per-call precondition.

```text
lower_bound(value v):

[ elements for which elem < v ][ elements for which elem < v is false ]
 first                         result                              last

upper_bound(value v):

[ elements for which !(v < elem) ][ elements for which v < elem ]
 first                           result                           last
```

The family has distinct postconditions:

- `lower_bound` returns the first position at which the element does not precede the value.
- `upper_bound` returns the first position at which the value precedes the element.
- `equal_range` returns both boundaries of the equivalent run.
- `binary_search` reports whether an equivalent element exists.
- `partition_point` generalizes the boundary search to a unary predicate that is true and then false.

```cpp
#include <algorithm>
#include <cassert>
#include <vector>

int main() {
    std::vector<int> prices{100, 101, 101, 104, 108};

    auto [first, last] =
        std::equal_range(prices.begin(), prices.end(), 101);

    assert(first - prices.begin() == 1);
    assert(last - prices.begin() == 3);

    auto insertion = std::lower_bound(
        prices.begin(), prices.end(), 103);
    prices.insert(insertion, 103);
    assert(std::is_sorted(prices.begin(), prices.end()));
}
```

The algorithms use `O(log N)` comparisons. With a random-access iterator, finding each midpoint is constant-time arithmetic, giving logarithmically many iterator operations. With a forward or bidirectional iterator, advancing to midpoints can total `O(N)` increments.

For `N = 1,048,576`, a logarithmic comparison bound is around twenty comparisons, but a linked traversal can still advance through a substantial fraction of the nodes. This is why `set::lower_bound` and `map::find` should be used instead of applying the generic algorithm to their iterators: the member follows tree links directly.

On contiguous data, binary search introduces data-dependent branches and non-sequential accesses. A linear scan may beat it for a small range that fits in a few cache lines, but there is no portable crossover size. Measure key distribution, element size, comparator cost, cache residency, and compiler output.

### Partition algorithms

`partition` groups elements satisfying a predicate before the rest and returns the boundary. It does not preserve relative order. `stable_partition` preserves relative order within both groups. `is_partitioned` tests the property, and `partition_copy` writes the two groups to separate outputs.

```cpp
#include <algorithm>
#include <cassert>
#include <vector>

int main() {
    std::vector<int> values{1, 2, 3, 4, 5, 6};
    auto even = [](int x) { return x % 2 == 0; };

    auto boundary =
        std::partition(values.begin(), values.end(), even);

    assert(std::all_of(values.begin(), boundary, even));
    assert(std::none_of(boundary, values.end(), even));
}
```

For C++23, `partition` applies the predicate exactly `N` times. It performs at most `N/2` swaps with bidirectional iterators and at most `N` swaps with forward iterators. `stable_partition` also applies the predicate exactly `N` times; it uses at most `N` swaps if enough extra memory is available and at most `N log N` swaps otherwise.

The conditional memory bound does not expose a portable knob for caller-provided scratch space. An allocation-free path must not infer “no allocation happened” from successful completion. Instrument the target library or use an explicit stable-compaction implementation with caller-owned storage.

### Remove does not erase

`remove` and `remove_if` stably move retained values toward the front and return a new logical end. Elements between that iterator and the old end remain alive but have unspecified values. The container's size is unchanged.

```cpp
#include <algorithm>
#include <cassert>
#include <vector>

int main() {
    std::vector<int> values{1, 2, 3, 2, 4};

    auto logical_end =
        std::remove(values.begin(), values.end(), 2);
    assert(values.size() == 5); // no container operation occurred

    values.erase(logical_end, values.end());
    assert((values == std::vector<int>{1, 3, 4}));

    std::erase_if(values, [](int x) { return x % 2 != 0; });
    assert((values == std::vector<int>{4}));
}
```

C++20 `std::erase` and `std::erase_if` package the appropriate container operation. There is no C++20 standard guarantee that classic `std::remove` is marked `[[nodiscard]]`; do not depend on a warning to catch a discarded new end.

Choose `remove_if` when survivor order matters. Choose unstable `partition` when only grouping matters and fewer element moves may benefit the measured workload. The actual cost depends on element move/swap cost and predicate distribution, not only the number of predicate applications.

---

## 14.4 Iterator-category consequences — Core

An iterator category or C++20 iterator concept is a capability contract. Stronger capabilities enable different algorithms and different complexity:

```text
input ──► forward ──► bidirectional ──► random_access ──► contiguous
output is a separate single-pass writing capability
```

| Capability | Adds | Typical standard type | Consequence |
|---|---|---|---|
| Input | Single-pass reading | `istream_iterator` | Linear scans and one-pass transforms |
| Output | Single-pass writing | `back_insert_iterator` | Destination for copy/transform |
| Forward | Multi-pass traversal | `forward_list` iterator | Partitioning, repeated passes |
| Bidirectional | `--it` | `list`, `map`, `set` iterator | Reverse traversal |
| Random access | Constant-time jumps and distance, ordering | `vector`, `deque` iterator | Generic sort, heap, selection |
| Contiguous | Adjacent elements in address order | `array`, `vector`, `span`, `string` iterator | Data-pointer interoperation and optimization opportunities |

`deque` is random access but not contiguous. A random-access algorithm can jump by index across its internal blocks, but one `data()` pointer cannot describe all elements.

The C++20 `contiguous_iterator` concept formally expresses contiguity. Standard containers such as vector guaranteed contiguous storage before that concept existed. A library may optimize operations on contiguous trivially copyable values into bulk moves, but a call to `memmove` is an implementation optimization, not an algorithm-level standard promise.

Legacy algorithms use iterator tags and require the same iterator type for both endpoints. Ranges algorithms use concepts and can accept a distinct sentinel. A custom iterator can expose `iterator_concept` for ranges and `iterator_category` for legacy compatibility; mixing the two interfaces may reveal different effective capabilities.

### Capability changes cost

Consider `std::distance(first,last)`:

- for random-access iterators it can compute `last-first` in constant time;
- for input, forward, or bidirectional iterators it increments until `last`, taking linear time.

`std::advance` similarly jumps in constant time only for random access. This cost propagates into algorithms such as `lower_bound`, even though the comparison count remains logarithmic.

The ranges concepts also separate properties that are not a simple hierarchy:

- `sized_sentinel_for<S,I>` permits constant-time distance between a sentinel and iterator;
- `common_range` means iterator and sentinel have the same type;
- `sized_range` exposes constant-time `ranges::size`;
- `borrowed_range` concerns whether iterators remain usable after the range object itself is destroyed.

Do not infer one from another. A filtered view is commonly not sized even when its base is sized because finding the number of survivors requires evaluation. A `span` is contiguous, sized, common, and borrowed, but its data still belongs to someone else.

---

## 14.5 Predicates, comparators, and projections — Core

A **predicate** classifies an element. A **comparator** defines an ordering relation between two values. A **projection** maps an element to the value seen by the predicate or comparator.

Ranges algorithms make projection explicit:

```cpp
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <functional>
#include <vector>

struct Order {
    std::int64_t price;
    std::uint64_t sequence;
};

int main() {
    std::vector<Order> orders{{102, 3}, {100, 1}, {101, 2}};

    std::ranges::sort(orders, std::ranges::less{}, &Order::price);
    assert(orders.front().price == 100);

    auto expensive = std::ranges::count_if(
        orders, [](std::int64_t p) { return p >= 101; },
        &Order::price);
    assert(expensive == 2);
}
```

The projection is invoked through `std::invoke`, so pointers to data members work directly. It can also be a function object. The algorithm may invoke it many times; a sort does not promise to cache projected keys. If projection computes an expensive normalization or hash, precomputing keys can exchange memory and setup time for fewer repeated computations.

### Predicate discipline

A predicate must accept the values the algorithm supplies and must not invalidate the traversal or mutate through an argument when the algorithm's predicate requirements forbid it. Avoid depending on a particular visitation order or exact number of calls unless the specification gives one.

Stateful counters inside predicates are especially misleading with parallel policies: the callable may be copied, invoked concurrently, or invoked in an unspecified order. For sequential diagnostics, keep observation separate from the decision when possible.

### Strict weak ordering

Sorting, ordered set operations, heaps, and binary-search families rely on a strict weak ordering compatible with the data's existing partition/order. For comparator `comp`:

- **irreflexive:** `comp(a,a)` is false;
- **asymmetric:** if `comp(a,b)`, then `comp(b,a)` is false;
- **transitive:** `comp(a,b)` and `comp(b,c)` imply `comp(a,c)`;
- **transitive incomparability:** if neither value precedes the other, that equivalence relation is transitive.

Using `<=` fails irreflexivity. Combining independent fields with
`a.x < b.x || a.y < b.y` can fail transitivity. Lexicographic comparison is safer:

```cpp
struct Level {
    std::int64_t price;
    std::uint64_t sequence;

    auto operator<=>(const Level&) const = default;
};
```

For mixed directions, write and test the cases directly:

```cpp
auto better = [](const Level& a, const Level& b) {
    if (a.price != b.price) {
        return a.price > b.price;      // higher price first
    }
    return a.sequence < b.sequence;    // earlier sequence first
};
```

Floating-point keys need an explicit NaN policy. Built-in `<` makes a NaN incomparable with every value, which can make the induced equivalence relation non-transitive across NaNs and ordinary numbers. Reject NaNs, normalize them into a chosen bucket, or compare a representation/key that establishes the required ordering.

### A comparator-law test

Concept constraints cannot prove semantic laws. A small cubic test can find counterexamples in representative data:

```cpp
#include <functional>
#include <span>

template<class T, class Compare>
bool obeys_strict_weak_order(
    std::span<const T> xs, Compare comp) {
    auto equivalent = [&](const T& a, const T& b) {
        return !std::invoke(comp, a, b) &&
               !std::invoke(comp, b, a);
    };

    for (const T& a : xs) {
        if (std::invoke(comp, a, a)) return false;
        for (const T& b : xs) {
            if (std::invoke(comp, a, b) &&
                std::invoke(comp, b, a)) return false;

            for (const T& c : xs) {
                if (std::invoke(comp, a, b) &&
                    std::invoke(comp, b, c) &&
                    !std::invoke(comp, a, c)) return false;

                if (equivalent(a, b) && equivalent(b, c) &&
                    !equivalent(a, c)) return false;
            }
        }
    }
    return true;
}
```

This test is not a proof over all possible values. Use a small set containing equal keys, boundary values, reversed inputs, and invalid/special values. Property-based generation can broaden coverage. The production algorithm still relies on the comparator satisfying the law for every value it receives.

### Callable cost

A directly passed lambda gives the compiler the comparator type and usually allows inlining. Type-erasing it behind `std::function` adds an indirect call unless optimization can recover the target. Sorting performs the comparison many times, so the dispatch can matter for small cheap keys.

This is an implementation cost model, not a fixed penalty. Measure comparisons, projection invocations, branch misses, and element moves. Sorting indices instead of large records can reduce bytes moved but adds a later gather and less direct memory access; it wins only under the corresponding data layout and consumer pattern.

---

## 14.6 Transformation, accumulation, and reduction — Core

These algorithms describe dataflow while retaining explicit contracts:

| Algorithm | Shape | Ordering property |
|---|---|---|
| `transform` | Map one or two input ranges to output | One result per input position |
| `for_each` | Apply an operation | Sequential overload visits in order |
| `accumulate` | Fold a range into one value | Ordered left fold |
| `reduce` | Reduce a range | May reorder and regroup |
| `transform_reduce` | Map plus regroupable reduction | No intermediate range required |
| `inclusive_scan` / `exclusive_scan` | Prefix reduction | Produces all prefixes |
| `partial_sum` | Ordered prefix accumulation | Left-to-right |

A loop can often be made more declarative without changing ownership:

```cpp
#include <algorithm>
#include <cassert>
#include <vector>

int main() {
    std::vector<int> quantities{2, 3, 5};
    std::vector<int> doubled(quantities.size());

    // Before:
    for (std::size_t i = 0; i < quantities.size(); ++i) {
        doubled[i] = quantities[i] * 2;
    }

    // After: the same output postcondition is explicit.
    std::ranges::transform(
        quantities, doubled.begin(),
        [](int q) { return q * 2; });

    assert((doubled == std::vector<int>{4, 6, 10}));
}
```

The destination must have enough writable elements. `std::back_inserter` changes the destination behavior to repeated insertion and may trigger container growth; reserve first if a no-reallocation requirement and output bound are known.

### `accumulate` versus `reduce`

`std::accumulate(first,last,init,op)` is an ordered left fold. The type of `init` is the result type. An integer initializer for floating input truncates the running state:

```cpp
#include <cassert>
#include <numeric>
#include <vector>

int main() {
    std::vector<double> values{0.5, 1.5};
    auto wrong =
        std::accumulate(values.begin(), values.end(), 0);   // int
    auto right =
        std::accumulate(values.begin(), values.end(), 0.0); // double

    assert(wrong == 1);
    assert(right == 2.0);
}
```

`std::reduce` may group operands in an unspecified order even without a parallel execution policy. Its operation must support the combinations required by the overload. Associativity and commutativity are needed if regrouping is to preserve the mathematical result. They are not true of floating-point addition.

### Deterministic floating reduction

If event replay must produce the same result, fix the traversal and grouping:

```cpp
#include <numeric>
#include <span>

double replay_sum(std::span<const double> values) {
    // Fixed left-to-right grouping for this sequence.
    return std::accumulate(values.begin(), values.end(), 0.0);
}
```

This defines an evaluation order at the library level. Reproducibility also assumes the same values, floating environment, relevant compiler options, and compatible floating implementation.

The reason grouping matters can be observed with `{1e16, -1e16, 1.0}` on a typical IEC 60559 binary64 implementation. Left grouping computes `(1e16 + -1e16) + 1.0`, retaining `1.0`; a grouping that first combines `-1e16 + 1.0` commonly loses the unit and later produces zero. These numeric outcomes are an implementation observation, while the standard-level rule is that `reduce` may choose different groupings.

Use `reduce` or `transform_reduce` only after accepting that freedom. A fixed pairwise tree can improve numerical error and remain reproducible if the tree is specified, but standard `reduce` does not expose its tree. Chapter 23 owns compensated summation and detailed numerical analysis.

### Fusion and locality

`transform_reduce` can avoid an intermediate transformed container. That removes allocation and one memory round trip when the compiler/library produces a fused loop. The gain depends on vectorization, alias analysis, callable inlining, and cache behavior.

Scans express prefix dependencies. `exclusive_scan` is useful for computing offsets from record lengths; each output gets the reduction of preceding inputs. Parallel scan implementations require more scheduling and temporary state than a serial loop. Compare throughput and tail latency for the actual range length rather than inferring speed from the API name.

---

## 14.7 Range algorithms and range concepts — Core

Ranges algorithms replace many iterator-pair calls with a range argument and constrain invalid combinations through concepts:

```cpp
std::sort(values.begin(), values.end(), comp); // classic
std::ranges::sort(values, comp);               // range overload
```

They often return richer result types. For example, `ranges::copy` returns both the final input iterator and final output iterator. Projections are a regular parameter across many algorithms.

The range overload does not change the underlying algorithmic postcondition or invalidate fewer iterators. `ranges::sort` still requires random access and a sortable relation. Concepts improve diagnostics and overload participation; they do not prove runtime preconditions such as “this range is partitioned.”

### Core concepts

| Concept | Meaning | Practical consequence |
|---|---|---|
| `range` | `ranges::begin` and `ranges::end` form a range | Base requirement |
| `input_range` | Single-pass readable iterator | Linear scans |
| `forward_range` | Multi-pass iterator | Repeat traversal |
| `random_access_range` | Constant-time jumps | Sorting and selection |
| `contiguous_range` | Elements contiguous in memory | Pointer/data interoperation |
| `sized_range` | Constant-time `ranges::size` | Consumers can know output bounds |
| `common_range` | Iterator and sentinel have same type | Easier legacy interoperation |
| `view` | Lightweight range type meeting view semantics | Cheap pipeline composition |
| `borrowed_range` | Iterators do not depend on range-object lifetime | Safe iterator return from an rvalue range object, subject to storage lifetime |
| `viewable_range` | Can be converted to a view by `views::all` | Accepted by view adaptors |

A view is not synonymous with non-owning. `ref_view` and `span` refer to external storage. `owning_view` owns a moved-in range. `single_view` owns one element. The design question is always concrete: what state does this view contain, and what does that state refer to?

### Borrowed iterators and `dangling`

Ranges algorithms prevent one common temporary mistake in their return type:

```cpp
#include <ranges>
#include <type_traits>
#include <vector>

int main() {
    auto result = std::ranges::find(
        std::vector{1, 2, 3}, 2);

    static_assert(std::same_as<
        decltype(result), std::ranges::dangling>);
}
```

The temporary vector is not a borrowed range, so the algorithm returns the marker type `ranges::dangling` rather than an iterator into destroyed storage.

For a `span`, `string_view`, or suitable `subrange`, destroying the range object does not itself destroy the referenced storage, so these types model `borrowed_range`. That does not make their iterators immortal. If the actual array/string/vector owner dies or reallocates, they still dangle.

---

## 14.8 Lazy views, composition, materialization, and lifetime — Core

A view pipeline constructs adaptor objects first and evaluates elements when a consumer iterates:

```text
owner/range
    │
    ▼
filter(predicate) ── advances until a survivor
    │
    ▼
transform(projection) ── computes one exposed value
    │
    ▼
take(k) ── stops after k exposed values
    │
    ▼
consumer: loop, algorithm, or materialization
```

Laziness can avoid intermediate containers and stop upstream work early. It also means work is repeated if the pipeline is traversed again, and the pipeline retains any references or callable state needed for later evaluation.

```cpp
#include <cassert>
#include <ranges>
#include <vector>

int main() {
    std::vector<int> values{1, 2, 3, 4, 5, 6};

    auto pipeline =
        values
        | std::views::filter([](int x) { return x % 2 == 0; })
        | std::views::transform([](int x) { return x * x; })
        | std::views::take(2);

    auto it = pipeline.begin();
    assert(*it++ == 4);
    assert(*it == 16);
}
```

The pipeline refers to the lvalue vector. Destroying or reallocating `values` before iteration invalidates its use. Mutating element values without invalidating iterators can change future results because filtering and transformation are lazy.

### Common adaptors and capability effects

| Adaptor | Behavior | Important condition/effect |
|---|---|---|
| `filter` | Exposes matching elements | Usually not sized; searches during advancement |
| `transform` | Exposes projected values/references | Does not preserve contiguity |
| `take` / `drop` | Keeps/skips a prefix | Cost depends on base iterator capability |
| `take_while` / `drop_while` | Predicate-bounded prefix | Predicate evaluated lazily |
| `reverse` | Reverses traversal | Requires bidirectional range |
| `join` | Flattens range-of-ranges | Inner-range lifetime matters |
| `split` / `lazy_split` | Produces token subranges | Tokens commonly refer to source |
| `keys` / `values` | Selects tuple-like component | Projection view |
| `zip`, `enumerate`, `adjacent`, `chunk`, `slide`, `stride`, `chunk_by`, `cartesian_product` | C++23 composition tools | Each imposes its own range constraints |

Adaptor composition is normally allocation-free at construction, but that is not a blanket guarantee about callables or later consumers. A captured object may allocate when copied; materialization allocates according to its destination; the underlying owner may allocate independently.

### Rvalue ownership and lvalue borrowing

In C++23, piping a movable rvalue container through a standard adaptor can move it into an `owning_view`:

```cpp
#include <cassert>
#include <ranges>
#include <vector>

int main() {
    auto owned =
        std::vector{1, 2, 3, 4}
        | std::views::filter([](int x) { return x % 2 == 0; });

    assert(*owned.begin() == 2); // moved-in vector is still alive
}
```

Keeping `owned` alive keeps the moved vector subobject alive. This differs from adapting an lvalue, which normally creates a `ref_view` referring to the existing container.

`owning_view` does not repair a view that was deliberately built over someone else's reference. This function returns a pipeline referring to `source`:

```cpp
auto first_three(const std::vector<int>& source) {
    return source | std::views::take(3);
}

auto dangling =
    first_three(std::vector{1, 2, 3, 4}); // temporary owner then dies
```

The parameter is an lvalue expression inside the function, so the adaptor refers to it; it cannot recover ownership of the caller's temporary. Iterating `dangling` later has undefined behavior.

Captured references create the same hazard:

```cpp
auto make_filter(int threshold,
                 const std::vector<int>& source) {
    return source | std::views::filter(
        [&](int x) { return x >= threshold; }); // also captures threshold by ref
}
```

Both `source` and the local `threshold` are invalid after return. Capture small configuration by value and require the source owner to outlive the view, or materialize before returning.

### Materialization

C++23 `ranges::to` creates an owning destination:

```cpp
#include <cassert>
#include <ranges>
#include <vector>

int main() {
    std::vector<int> values{-2, 3, 4};
    auto squares =
        values
        | std::views::filter([](int x) { return x > 0; })
        | std::views::transform([](int x) { return x * x; })
        | std::ranges::to<std::vector>();

    assert((squares == std::vector<int>{9, 16}));
}
```

Materialization trades laziness for ownership, stable repeated access, and destination storage cost. If the source is sized and the library can exploit that information, it may reserve appropriately; a filtered range usually cannot know its result count without evaluating.

When the deployment library does not yet implement this C++23 facility, construct a destination and use `ranges::copy` with an inserter. That is a toolchain limitation, not a change to the C++23 standard.

### Hot-path trade-offs

After optimization, a short view pipeline can compile to the same loop as hand-written code. The standard does not guarantee this. Filtering creates a data-dependent branch, transformations may be recomputed, and deep adaptor types increase compile time and diagnostic size.

Use a benchmark that checks generated work, allocation calls, branch behavior, and latency distribution. The comparison should use equivalent ownership and postconditions. A view chain that eliminates an intermediate vector is not comparable to a loop that was already fused manually.

---

## 14.9 Worked low-latency design: sorted top-k without full sort — Core

The following function returns the best `k` immutable orders, ordered by descending price and then ascending sequence number:

```cpp
#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

struct Order {
    std::int64_t price;
    std::uint64_t sequence;
};

std::vector<Order> top_k_orders(
    std::span<const Order> input, std::size_t k) {
    const std::size_t count = std::min(k, input.size());
    std::vector<Order> result(count);

    auto better = [](const Order& a, const Order& b) {
        if (a.price != b.price) return a.price > b.price;
        return a.sequence < b.sequence;
    };

    std::partial_sort_copy(
        input.begin(), input.end(),
        result.begin(), result.end(), better);
    return result;
}

int main() {
    std::vector<Order> orders{
        {101, 8}, {103, 9}, {103, 4}, {100, 1}
    };

    auto top = top_k_orders(orders, 2);
    assert(top.size() == 2);
    assert(top[0].price == 103 && top[0].sequence == 4);
    assert(top[1].price == 103 && top[1].sequence == 9);
}
```

Reason from the requirements:

- The input is a `span<const Order>`, so mutating selection algorithms cannot be used directly.
- The output must be ordered, eliminating plain `nth_element`.
- `partial_sort_copy` retains only `min(k,N)` output objects and provides them in comparator order.
- `k == 0` creates an empty output range; the algorithm performs no output writes.
- `k >= N` creates `N` outputs and orders all input values in the result.

The comparator is irreflexive because no order has a different price from itself and no sequence is less than itself. It is lexicographic across descending price and ascending sequence, so transitivity and equivalence follow from the corresponding integer orderings.

The operation performs approximately `N log(min(N,k))` comparisons and requires dynamic storage for the result vector when the result is nonempty. The standard does not specify an exact number of allocator calls here. For a steady-state handler, let the caller provide a preallocated output span or reusable vector and state its capacity precondition. That removes allocator variability but shifts failure handling to an explicit capacity check.

### Cost model and rollback

Expected costs are:

- one sequential read of the input;
- comparator branches on price equality and ordering;
- maintenance of a selected heap/prefix inside the library;
- moves/copies among `k` result objects;
- result-storage allocation behavior determined by the vector implementation and allocator.

If `Order` is large, store compact indices or keys and gather later; this reduces movement but adds indirection. If input is already mostly sorted or `k` approaches `N`, full sorting a copy may compete. If input streams indefinitely, maintain a bounded heap instead.

Measure representative `N`, `k`, tie frequency, record size, cache residency, and result reuse. Compare p50 and tail latency, comparisons, bytes moved, allocation calls, and cache/branch counters. Roll back to the simpler full-sort implementation if the selection path does not produce a meaningful benefit or creates unacceptable complexity.

---

## 14.10 Parallel algorithms and execution policies — Deep dive

C++17 added standard execution-policy overloads; C++20 added `unseq`. They change permissible execution, not only performance:

| Policy | Where invocations may run | Sequencing | Main callable obligation |
|---|---|---|---|
| `seq` | Calling thread | Indeterminately sequenced | No uncaught exception under the policy overload |
| `unseq` | Calling thread | May be unsequenced/interleaved | No vectorization-unsafe operations or order dependence |
| `par` | Implementation-selected threads, possibly one | Indeterminately sequenced within a thread | Data-race free; synchronization permitted |
| `par_unseq` | Implementation-selected threads | May be unsequenced within a thread | Data-race free and no vectorization-unsafe operations |

The standard permits an implementation to execute a parallel policy with limited or no parallelism. It does not specify a worker count, scheduling strategy, partition size, affinity, or thread-pool lifetime.

### Correctness constraints

Element-access functions may be copied and invoked in unspecified order. Under `par` or `par_unseq`, unsynchronized writes to shared non-atomic state are data races. Under `unseq` and `par_unseq`, invoking vectorization-unsafe standard-library operations can make behavior undefined. Operations that synchronize with another function are vectorization-unsafe, with specific exceptions in the standard such as memory allocation/deallocation functions. Locks are therefore not valid inside these unsequenced calls.

If a user function invoked by an algorithm exits with an uncaught exception under one of the standard execution policies, `std::terminate` is called, including for the `seq` policy overload. Allocation failure internal to the algorithm may be reported as `std::bad_alloc`. Custom execution policies have implementation-defined behavior.

These rules make the policy overload meaningfully different from calling the ordinary sequential overload. Do not add `execution::seq` as decoration when exception propagation is required.

### Reduction and determinism

Parallel `reduce` and `transform_reduce` partition and regroup work. For integers, overflow still follows the underlying type rules. For floating point, regrouping can alter rounding. For any stateful/non-associative operation, result meaning may depend on the permitted execution order.

Parallel scans preserve their specified prefix semantics but need coordination between partitions. An implementation may allocate temporary state and schedule work across cores. None of that provides a tail-latency bound.

### Decision framework

```text
Is the operation valid under arbitrary permitted ordering/grouping?
  ├─ no → ordinary sequential algorithm or explicitly designed schedule
  └─ yes
       ├─ must exceptions propagate? → ordinary overload, not policy overload
       ├─ callable synchronizes? → exclude unseq/par_unseq
       ├─ workload too small or latency-sensitive? → prefer measured serial path
       └─ throughput-oriented batch? → benchmark policies on deployment library
```

Parallel policies fit throughput-oriented batch work when per-element work dominates scheduling, partition, and coherence overhead. They are usually a poor default for a pinned latency-sensitive event loop: worker wake-up, shared queues, cache-line migration, and load imbalance widen the latency distribution. This is a workload conclusion, not a ban. Measure the actual implementation because some libraries execute a policy sequentially unless built with a backend.

---

## 14.11 Contract and cost reference — Reference

### Complexity vocabulary

| Wording | What it constrains | What it does not constrain |
|---|---|---|
| At most `N` predicate applications | Callable invocation count | Callable cost, branches, cache misses |
| `O(log N)` comparisons | Asymptotic comparison count | Iterator increments or memory locality |
| Average `O(N)` | Average under the specification's model | Worst-case call latency |
| Amortized constant | Total over a sequence of operations | Any single operation |
| Stable | Relative order of equivalent elements | Iterator/reference stability |
| In-place | Usually limited auxiliary storage in context | A universal no-allocation promise unless specified |

An amortized bound is particularly dangerous in a tail-sensitive path. `vector::push_back` is amortized constant time, yet a capacity growth moves/copies existing elements and may allocate. Reserve or use a fixed-capacity representation when capacity is bounded, then verify that nested element operations also avoid allocation.

### Common traps

| Trap | Violated contract | Repair |
|---|---|---|
| Binary search on unsorted/incompatibly ordered input | Range is not partitioned for the call | Sort with the same relation or use linear search |
| `sort` with `<=` | Comparator is reflexive | Use a strict relation |
| Floating comparator ignores NaNs | Induced equivalence may not be transitive | Reject or assign NaNs an explicit total position |
| Discarding `remove`'s return | Container size never changed | Erase the returned tail or use `erase_if` |
| Reading `nth_element`'s prefix as sorted | Selection gives partition only | Sort the selected prefix if needed |
| Applying generic `lower_bound` to `set` iterators | Log comparisons hide linear increments | Use the member function |
| Writing through `copy` to `out.begin()` of an empty vector | No output storage exists | Resize or use a suitable inserter |
| Predicate structurally mutates its source vector | Iterator invalidation | Separate traversal from mutation |
| Returning a view over a reference parameter fed a temporary | Owner dies at full-expression end | Require an lvalue owner or materialize |
| Capturing a local by reference in a stored view | Callable holds a dangling reference | Capture by value or shorten view lifetime |
| Assuming `borrowed_range` owns storage | It only decouples iterator validity from range-object lifetime | Track the actual storage owner |
| Using `reduce` for replay-sensitive floats | Grouping is unspecified | Use a fixed ordered/fixed-tree reduction |
| Throwing from a policy-overload callable | Standard policy calls `terminate` | Use ordinary overload or contain errors |
| Locking inside `par_unseq`/`unseq` work | Vectorization-unsafe operation | Redesign callable or use another policy |

---

## Recall and practice

### Recall card

1. `[first,last)` is valid only when `last` is reachable from `first`; `last` is never dereferenced.
2. Check iterator capability, structural preconditions, callable laws, output capacity, overlap, and invalidation before considering speed.
3. `sort` is worst-case `O(N log N)` comparisons; `nth_element` is average `O(N)` and only partitions.
4. `lower_bound` gives logarithmic comparisons, not necessarily logarithmic iterator increments.
5. `remove` compacts without shrinking; `partition` groups without sorting.
6. A strict weak ordering includes transitive incomparability; projections may be recomputed many times.
7. `accumulate` fixes a left-fold order; `reduce` permits regrouping, which matters for floating point and stateful operations.
8. Views may own or borrow. Track source storage, adaptor callable captures, owner mutation, and materialization explicitly.

### Questions

1. Why does a half-open range represent both an empty range and two adjacent subranges without special cases?
2. Which preconditions would you check before calling `ranges::lower_bound` with a custom projection?
3. A report needs an unordered best 50 from a mutable million-element vector. Which postcondition makes `nth_element` preferable to sorting?
4. Why can generic `lower_bound` perform linear work on a list despite logarithmic comparisons?
5. Compare `remove_if`, `partition`, and `stable_partition` for compacting expensive records when survivor order may or may not matter.
6. Give a three-value counterexample for a comparator whose incomparability is not transitive.
7. Why can a projection that looks syntactically cheap dominate a sorting call?
8. Under what ownership path is a pipeline over an rvalue vector safe, and why can a function returning a view over `const vector&` still dangle?
9. Which additional assumptions are needed for an ordered floating sum to be replay-reproducible?
10. Why does using the `execution::seq` overload change exception behavior compared with the ordinary overload?

### Code-reading puzzle

```cpp
std::vector<int> values{5, 3, 8, 1, 9, 2};
auto boundary = std::partition(
    values.begin(), values.end(),
    [](int x) { return x % 2 == 0; });

bool a = std::is_sorted(values.begin(), boundary);
bool b = std::all_of(
    values.begin(), boundary,
    [](int x) { return x % 2 == 0; });
```

Which of `a` and `b` is guaranteed true, and which has no guaranteed value? State the exact `partition` postcondition that determines the answer.

### Design exercise

Implement two forms of `top_k_orders` for a caller-defined `Order`:

1. an immutable-input function returning a sorted owning vector;
2. a steady-state function writing into caller-provided fixed-capacity storage without allocation.

Order by descending price and ascending sequence. Handle `k == 0`, `k > input.size()`, insufficient output capacity, duplicate keys, and invalid prices. State each function's iterator/range preconditions, comparator policy, postcondition, complexity, ownership, and failure behavior. Then propose a benchmark that distinguishes comparison count, bytes moved, allocation, and tail latency.

### Next prerequisite

Chapter 15 assumes comfort with value versus reference semantics and with the difference between owning and non-owning results. Before continuing, be able to identify what an algorithm returns, which objects own the referenced storage, and when a lazy or vocabulary type must be materialized into an owning value.
