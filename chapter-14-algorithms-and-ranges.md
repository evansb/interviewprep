# Chapter 14 — Algorithms and Ranges

*Interview-focused revision notes. The theme: the standard algorithms are a contract between an iterator's capabilities and a complexity guarantee — knowing which guarantee you bought, what the implementation actually does to honor it, and what ranges changed about composing them.*

---

## 14.1 Sorting Algorithms in the Standard Library

Four sorting entry points, distinguished by stability and complexity guarantee:

| Algorithm | Complexity | Stable | Extra memory | Underlying implementation |
|---|---|---|---|---|
| `std::sort` | O(n log n) **worst case** (C++11+) | No | O(log n) stack | **Introsort**: quicksort → heapsort on depth overrun → insertion sort on small ranges |
| `std::stable_sort` | O(n log n) with memory, O(n log²n) without | **Yes** | O(n) if available | Merge sort (adaptive: timsort-like in libc++'s newer code, in-place merge fallback) |
| `std::partial_sort` | O(n log k) | No | O(1) | Heap-based (§14.2) |
| `std::sort_heap` / `push_heap` / `pop_heap` | O(n log n) / O(log n) | No | O(1) | Binary heap |

**Introsort** is the detail that separates candidates. C++98 only required *average* O(n log n) for `std::sort`, so a naive quicksort's O(n²) adversarial case was conforming — and exploitable (the "quicksort killer" input, a real DoS vector). C++11 tightened the requirement to worst-case O(n log n), which forced introsort: run quicksort, but track recursion depth, and when it exceeds ~2·log₂n switch that subrange to heapsort. Ranges below a threshold (16 in libstdc++) are left unsorted during recursion and cleaned up with a single final insertion-sort pass over the whole array, which is cache-friendly and exploits the near-sortedness.

`std::sort` requires **random-access iterators** (§14.7), which is why `std::list` has its own member `list::sort` (a bottom-up merge sort that relinks nodes, O(n log n) with no element moves and no allocation).

### Comparator requirements

The comparator must be a **strict weak ordering**: irreflexive (`!comp(a,a)`), asymmetric, transitive, and with transitive incomparability (if `a` and `b` are equivalent and `b` and `c` are equivalent, then `a` and `c` are). Violating it is **undefined behavior, not merely a wrong order** — libstdc++'s introsort will run off the end of the array during partitioning and corrupt memory. The classic violations:

```cpp
[](const T& a, const T& b){ return a.x <= b.x; }   // WRONG: <= is not irreflexive
[](const T& a, const T& b){ return a.x < b.x || a.y < b.y; }  // WRONG: not transitive
// Correct:
[](const T& a, const T& b){ return std::tie(a.x, a.y) < std::tie(b.x, b.y); }
```

`_GLIBCXX_DEBUG` and `_LIBCPP_HARDENING_MODE=debug` add comparator validation; C++26's hardened preconditions make several of these diagnosable.

### Sorting performance in practice

- **Comparison cost dominates.** Sorting `vector<string>` with 30-char keys is bound by `memcmp` and pointer-chasing; sorting `vector<uint64_t>` is bound by branch mispredicts in the partition step.
- **Branch mispredicts are the quicksort tax.** Each partition comparison is a ~50% unpredictable branch, ~15–20 cycles when wrong (Ch. 27). Branchless partitioning (BlockQuicksort, used by pdqsort and adopted by libstdc++ since GCC 14 and libc++) uses `cmov`-style buffered index writes and is 2–3× faster on integers.
- **Radix / counting sort beats comparison sort** for fixed-width integer keys — O(n·w/b) with no branches. For sorting order-book price levels or 32-bit IDs, a two-pass LSD radix sort is the low-latency answer; the standard has no radix sort.
- **Sort indices, not objects**, when elements are large: sort a `vector<uint32_t>` of indices with a projection (§14.8), then gather. Moves become 4-byte moves.
- `std::ranges::sort` (C++20) takes a range and a projection and returns the end iterator; it is otherwise identical and has the same complexity guarantees.

---

## 14.2 Selection and Partial-Sorting Algorithms

When you need the top-k, or the k-th element, sorting everything is wasteful.

```cpp
std::nth_element(v.begin(), v.begin()+k, v.end());
// after: v[k] is the element that would be there if sorted;
//        everything before is <= it, everything after is >= it. NEITHER SIDE IS SORTED.

std::partial_sort(v.begin(), v.begin()+k, v.end());
// after: the first k elements are the k smallest, IN SORTED ORDER; the rest is unspecified.

std::partial_sort_copy(first, last, out_first, out_last);  // doesn't modify the input
```

| Algorithm | Complexity | Result | Use when |
|---|---|---|---|
| `nth_element` | **O(n) average**, O(n) worst with median-of-medians fallback (libstdc++ uses introselect: quickselect + heapsort fallback) | Partition around the k-th | You need the k-th value, or an unordered top-k |
| `partial_sort` | O(n log k) | First k sorted | You need the top-k *in order* |
| `partial_sort_copy` | O(n log k) | Output range filled | Source is read-only or a non-random-access range |
| Full `sort` then take k | O(n log n) | Everything sorted | k ≈ n |

**`nth_element` is linear on average**, which is the headline fact: quickselect recurses into only one partition, giving the n + n/2 + n/4 + … = 2n expected-comparison series. `partial_sort` maintains a k-element max-heap: push the first k, then for each remaining element compare against the heap top and replace-and-sift only if smaller — so the per-element cost is one comparison when the element loses (the common case for large n), plus O(log k) rarely.

**Interview framing:** "Find the top 100 of 10 million." Answer: `nth_element` (O(n)) if order doesn't matter, `partial_sort` (O(n log k)) if it does, and a bounded max-heap if the data is streaming and you can't hold it all. Do **not** say `sort` then `resize`.

The median is `nth_element(v.begin(), v.begin()+v.size()/2, v.end())` — a classic and a genuinely correct use. Note the postcondition is stated in terms of a *partition*, so the two halves are unsorted; people who then read `v[k-1]` expecting the second-smallest are wrong.

C++20 gives `ranges::nth_element` and `ranges::partial_sort` with projections. Neither is stable, and `nth_element` in particular may reorder equivalent elements arbitrarily — relevant for tie-breaking in price-time priority (Ch. 49), where you must include the sequence number in the key rather than rely on any residual order.

---

## 14.3 Binary-Search Algorithms

Four functions, all requiring the range to be **partitioned with respect to the predicate** — a weaker and more precise requirement than "sorted":

```cpp
std::lower_bound(f, l, v);   // first position where !(*it < v)   — first >= v
std::upper_bound(f, l, v);   // first position where   v < *it    — first  > v
std::equal_range(f, l, v);   // the pair {lower_bound, upper_bound} — the run of equivalents
std::binary_search(f, l, v); // bool: does an equivalent element exist
std::partition_point(f, l, pred);  // generalization: first element where pred is false
```

`lower_bound` is the one you almost always want, because it gives you the *insertion position* as well as the found position:

```cpp
auto it = std::lower_bound(v.begin(), v.end(), key);
if (it != v.end() && *it == key) { /* found */ } else { v.insert(it, key); }
```

### Complexity and the iterator subtlety

The guarantee is **O(log n) comparisons** for any forward iterator — but only **O(log n) iterator increments** for random-access iterators. On a `std::list` (bidirectional), `lower_bound` performs O(n) increments while doing only O(log n) comparisons, so it is O(n) overall and pointless. This distinction — comparisons vs iterator movement — is exactly the kind of complexity-guarantee nuance interviewers probe (§14.6).

**Member `find` beats free `binary_search` on ordered containers.** `std::set::find` is O(log n) tree descent; `std::binary_search(s.begin(), s.end(), x)` is O(n) because `set` iterators are bidirectional. Similarly `map::lower_bound` is a member for a reason.

### Performance reality

Binary search is **branch-mispredict-bound and cache-miss-bound**, not comparison-bound. Each of the log n steps is an unpredictable branch and a cache miss into a fresh region:

- **Branchless binary search** replaces the `if` with arithmetic on the midpoint (`base += (cmp) * half`), turning mispredicts into a data dependency. Typically 2× faster for n in the tens of thousands.
- **Prefetching both children** (`__builtin_prefetch` on both possible next midpoints) hides latency, since only one is used but both are fetched in parallel — memory-level parallelism (Ch. 29).
- **Eytzinger (BFS) layout** stores the implicit binary tree breadth-first so the first few levels share cache lines; combined with prefetching it is the fastest known static search layout, several times faster than a sorted array for large n. For a static, rarely-changing table (a symbol table, a tick-size ladder), this is the right structure.
- For small n (≤ 16–32), **linear search wins** — no mispredicts, one cache line, SIMD-friendly. This is why flat maps (Ch. 12) and B-tree nodes use linear scans inside nodes.

`std::ranges::lower_bound` adds projections. C++20 also permits heterogeneous comparison: passing a `string_view` key to a range of `string` needs a transparent comparator (Ch. 13 §13.3).

---

## 14.4 Partitioning Algorithms

**Partitioning** rearranges a range so that all elements satisfying a predicate precede all that don't. It is the primitive under quicksort, `nth_element`, and every "compact the live entries" loop.

```cpp
auto it = std::partition(f, l, pred);        // O(n) swaps, NOT stable, returns the boundary
auto it = std::stable_partition(f, l, pred); // preserves relative order; O(n) with a buffer,
                                             // O(n log n) swaps without
bool b  = std::is_partitioned(f, l, pred);
auto p  = std::partition_point(f, l, pred);  // O(log n) — requires an already-partitioned range
std::partition_copy(f, l, out_true, out_false, pred);  // C++11, writes both halves elsewhere
```

`std::partition` needs only **forward iterators** (it uses a find-and-swap loop); the two-pointer Hoare scheme requires bidirectional. `stable_partition` allocates a temporary buffer via `get_temporary_buffer`-style logic and degrades gracefully to an in-place divide-and-conquer if allocation fails — an important detail for `-fno-exceptions` or allocation-free contexts, because **it can allocate**.

### The remove/erase family is partitioning in disguise

```cpp
v.erase(std::remove(v.begin(), v.end(), value), v.end());       // erase-remove idiom
v.erase(std::remove_if(v.begin(), v.end(), pred), v.end());
std::erase(v, value);        // C++20 — does the above in one call
std::erase_if(v, pred);      // C++20 — and works on maps/sets too
```

`std::remove` does **not** remove anything: it move-assigns the surviving elements forward and returns the new logical end, leaving the tail in a valid-but-unspecified moved-from state. Forgetting the `erase` call is the single most common standard-library bug, and `[[nodiscard]]` on `remove` (added in C++20 via P0600's sweep) now catches it.

`remove` is stable and O(n) with O(n) move-assignments; `partition` is unstable and O(n) with at most n/2 swaps, so if you don't need order preservation, `partition` moves less. For a hot compaction loop over an object pool, `std::partition` (or a hand-written branchless compaction using `cmov`/AVX-512 `vpcompressd`) is the right tool.

### Low-latency angle

Partitioning is where **branchless programming** pays (Ch. 42). The naive loop has one unpredictable branch per element; the branchless form always writes and advances the output pointer by the predicate result:

```cpp
// branchless compaction: always store, conditionally advance
for (auto& x : in) { *out = x; out += pred(x); }
```

This has a store per element regardless (fine — it's an L1 hit) and zero mispredicts. It's the same trick `std::partition_copy` implementations and SIMD filters use, and it wins whenever the predicate is roughly 50/50. When the predicate is heavily skewed (95% true), the branchy version wins because the predictor is right almost always — the general rule that **branchless is a bet on unpredictability, not a universal improvement**.

---

## 14.5 Transformation and Accumulation Algorithms

```cpp
std::transform(f, l, out, unary_op);            // and the binary two-range form
std::for_each(f, l, fn);
std::accumulate(f, l, init, binop);             // <numeric>, LEFT fold, sequential
std::reduce(f, l, init, binop);                 // C++17, UNORDERED — needs associativity
std::transform_reduce(f, l, init, red, tr);     // C++17 — the fused map-reduce
std::inner_product(f1, l1, f2, init);           // sequential dot product
std::partial_sum / std::inclusive_scan / std::exclusive_scan;  // prefix sums
std::iota(f, l, start);                          // fill with increasing values
```

### `accumulate` vs `reduce` — the key distinction

| | `std::accumulate` | `std::reduce` |
|---|---|---|
| Order | Strict left fold: `((init⊕a)⊕b)⊕c` | Unspecified order and grouping |
| Requires | Nothing beyond callable | **Associative and commutative** binop |
| Parallel | Never | Accepts an execution policy |
| Floating point | Deterministic, reproducible | **Non-deterministic result** — FP addition is not associative |
| Init type trap | `accumulate(v.begin(), v.end(), 0)` on `vector<double>` **truncates to `int`** | Same trap; also `reduce`'s default init is `T{}` from the range |

The `0` vs `0.0` init trap is a perennial interview question: `std::accumulate(d.begin(), d.end(), 0)` deduces `int`, so every partial sum is truncated. Write `0.0`, or `T{}`, or use `reduce` without an init.

The **floating-point determinism** point matters in trading: a parallel `reduce` over P&L gives different last bits on different runs and different core counts, which breaks reconciliation and replay determinism (Ch. 53). Use `accumulate` (or Kahan summation, Ch. 23) when reproducibility is required, and `reduce` only when you have accepted the non-determinism.

`std::transform_reduce` is the important C++17 addition: it fuses the map and the fold into one pass, avoiding an intermediate container, and it parallelizes. `transform_reduce(a.begin(), a.end(), b.begin(), 0.0, std::plus{}, std::multiplies{})` is a parallel dot product in one line.

### Scans

`inclusive_scan` and `exclusive_scan` (C++17) are the parallel-friendly counterparts to `partial_sum`. `exclusive_scan` omits the current element (`out[i] = sum of in[0..i-1]`), which is precisely the offset-table computation you need for bucketing, radix sort, and variable-length message framing. `partial_sum` is a strict left fold; the scans are order-relaxed and policy-accepting.

### Codegen and the vectorization story

`std::transform` with a lambda inlines to the same loop you'd write by hand — but **auto-vectorization depends on aliasing** (Ch. 3 §3.8, Ch. 40). `transform(in.begin(), in.end(), out.begin(), f)` where `in` and `out` may overlap forces the compiler to emit a runtime overlap check and a scalar fallback. `__restrict` on the underlying pointers, or using distinct types, removes it. This is why the two-loop pattern (a vectorized body plus a scalar remainder plus an overlap-guarded duplicate) shows up in the disassembly of trivial-looking `transform` calls.

`std::for_each` differs from a range-for only in that it can take an execution policy and returns the functor (useful for stateful accumulation, though `reduce` is cleaner). `ranges::for_each` returns `{in, fun}`.

---

## 14.6 Algorithm Complexity Guarantees

Every standard algorithm specifies its complexity in terms of **a specific counted operation** — comparisons, applications of the predicate, assignments, or swaps — not wall time and not iterator movement unless stated. Reading the guarantee precisely is the skill.

| Algorithm | Guaranteed | Not guaranteed |
|---|---|---|
| `sort` | O(n log n) comparisons, worst case (C++11+) | Stability; number of moves |
| `stable_sort` | O(n log n) with extra memory, else O(n log² n) | That it won't allocate |
| `nth_element` | **Linear on average** | Worst case (implementations use introselect to bound it) |
| `lower_bound` | O(log n) **comparisons** | O(log n) *increments* unless random-access |
| `find` | At most `last-first` applications | Anything about early exit |
| `rotate` | Linear | Which of the three algorithms is used |
| `inplace_merge` | O(n) with memory, O(n log n) without | Non-allocation |
| `stable_partition` | O(n) with memory, O(n log n) swaps without | Non-allocation |
| `vector::push_back` | **Amortized** O(1) | Any individual call (Ch. 11 §11.3) |

Three traps live here:

1. **Amortized vs per-operation.** Amortized O(1) `push_back` means a single call can be O(n) and can allocate. On a latency-percentile-sensitive path, the amortized average is the wrong statistic entirely — the P99.9 is the reallocation (Ch. 43). `reserve` converts the tail into a startup cost.
2. **"With sufficient additional memory."** `stable_sort`, `stable_partition`, and `inplace_merge` all *try to allocate* and silently take an asymptotically worse path if they can't. In an allocation-free hot path (Ch. 55), these three are disqualified.
3. **Complexity is in the counted operation, so a cheap-looking O(log n) can be an expensive O(log n).** `map::find` is O(log n) node hops, each a cache miss (~80 ns); a linear scan of a 64-element flat array is O(n) but one or two cache lines. **Asymptotics do not model the memory hierarchy**, which is the entire argument for flat containers (Ch. 12) and cache complexity (Ch. 23).

Container-side guarantees worth memorizing alongside: `map`/`set` O(log n) with stable references; `unordered_map` O(1) average / O(n) worst with reference stability but iterator invalidation on rehash; `deque` O(1) push at both ends with reference stability but not iterator stability; `list` O(1) splice.

---

## 14.7 Iterator Categories

An iterator category is a **capability contract**; algorithms select implementations by tag dispatch (Ch. 17) or, in C++20, by concept.

```
input          ──► forward ──► bidirectional ──► random_access ──► contiguous (C++17/20)
(single-pass)      (multi-pass)   (--)              (+n, it2-it1, <)     (&*it is a raw pointer)
output
(single-pass write)
```

| Category | Required ops | Canonical example | Enables |
|---|---|---|---|
| Input | `*`, `++`, `==`, single pass | `istream_iterator` | `find`, `copy`, `accumulate` |
| Output | `*it = v`, `++`, single pass | `back_insert_iterator` | Destination of `copy`/`transform` |
| Forward | multi-pass, default-constructible, `*it` returns a real reference | `forward_list` | `search`, `replace`, `partition` |
| Bidirectional | `--` | `list`, `map`, `set` | `reverse`, `prev`, `stable_partition` |
| Random access | `+n`, `-n`, `it2-it1`, `[]`, relational | `deque` | `sort`, `nth_element`, O(1) `advance` |
| Contiguous | elements adjacent in memory; `std::to_address` | `vector`, `array`, `span`, `string` | `memcpy`/SIMD fast paths, C-API interop |

**Contiguous** was carved out in C++17 (as a guarantee) and given a real tag in C++20. It is what lets `std::copy` on a `vector<int>` become a single `memmove` and lets you pass `v.data()` to `read()`. `deque` is random-access but **not** contiguous — a distinction that trips people up.

### C++20 ranges iterators are a different model

The ranges iterators relaxed the old requirements in ways worth knowing:

- **`std::input_iterator` no longer requires copyability** — move-only iterators are allowed, which is what makes `views::istream` and generator-backed ranges work.
- **The sentinel is a separate type.** `ranges::begin(r)` and `ranges::end(r)` may differ in type, so a null-terminated string or a predicate-terminated stream is a valid range with no precomputed end. This eliminates the classic `strlen`-then-iterate double pass.
- **`std::ranges::forward_iterator` requires equality-preserving `*`**, which is why many views (e.g. `transform_view` with a non-reference-returning function) are only `input_range`, and hence cannot be `sort`ed.
- `iterator_traits`-based tag detection was supplemented by `iterator_concept`, and a range can advertise `random_access` under the ranges concepts while its `iterator_category` is `input` — a real source of confusion when mixing old and new algorithms.

**Why an algorithm's category requirement is a design signal:** `std::sort` needs random access because introsort indexes into partitions; `std::list::sort` exists because `list` can't provide it. When an interviewer asks "why can't you `std::sort` a `std::list`?", the answer is the iterator category, and the follow-up is that `list::sort` relinks nodes instead of moving values.

---

## 14.8 Custom Comparators and Projections

A **comparator** answers "does a come before b"; a **projection** answers "which part of the element do I look at". C++20 ranges algorithms take both, and the split removes most of the reason to write comparators at all.

```cpp
// Classic:
std::sort(v.begin(), v.end(), [](const Order& a, const Order& b){ return a.price < b.price; });
// Ranges with a projection:
std::ranges::sort(v, {}, &Order::price);              // comparator defaults to ranges::less
std::ranges::sort(v, std::greater{}, &Order::price);  // descending by price
std::ranges::max_element(v, {}, [](const Order& o){ return o.qty * o.price; });
```

The projection can be a **pointer to member, a pointer to member function, or any callable**; it is invoked via `std::invoke` (Ch. 4), which is why `&Order::price` works directly. Projections apply to `find`, `min/max_element`, `sort`, `unique`, `lower_bound`, `count`, and essentially every ranges algorithm.

### Comparator correctness

The strict-weak-ordering requirement (§14.1) applies to `sort`, `stable_sort`, `nth_element`, the binary searches, `min_element`, `set_*` operations, `map`/`set` keys, and priority queues. Multi-key comparators should be written with `std::tie` (pre-C++20) or `<=>` (C++20):

```cpp
struct Level { int64_t price; uint64_t seq; };
// C++20: one line, correct by construction, and gives all six operators
auto operator<=>(const Level&, const Level&) = default;   // lexicographic by member order
// Or explicit multi-key with mixed direction:
auto cmp = [](const Level& a, const Level& b){
    return std::tie(b.price, a.seq) < std::tie(a.price, b.seq);  // price desc, seq asc
};
```

`std::greater<>{}` (the transparent, void-specialized form, C++14) is preferred over `std::greater<T>{}` because it deduces argument types and enables heterogeneous comparison — the same mechanism as transparent comparators in `map` (Ch. 12).

### Performance

- **A comparator lambda inlines; a `std::function` comparator does not.** Storing a comparator as `std::function<bool(const T&, const T&)>` costs an indirect call per comparison — ~n log n indirect calls, each defeating inlining and branch prediction. This is a 3–10× sort slowdown and a common real-world finding.
- **Stateless comparators are empty**, so `std::set<T, Cmp>` and `std::priority_queue` pay zero storage for them via EBO / `[[no_unique_address]]` (Ch. 3 §3.4). A capturing lambda comparator has size and must be stored.
- **Projections are zero-cost** when they're member pointers — they inline to a field load. But a projection that *computes* (e.g. `o.qty * o.price`) is re-evaluated on every comparison, i.e. O(n log n) times. If the projection is expensive, precompute a key array (a **Schwartzian transform**) and sort that.
- **`ranges::sort` with a projection generates the same code** as a hand-written comparator; there is no abstraction penalty, but there is a compile-time and error-message cost.

---

## 14.9 Range Concepts

A **range** is anything with `begin()` and `end()` (via the `ranges::begin`/`end` customization point objects). The concept hierarchy in `<ranges>` mirrors the iterator hierarchy plus a few orthogonal axes:

```
range → input_range → forward_range → bidirectional_range → random_access_range → contiguous_range
        output_range
Orthogonal: sized_range, common_range, borrowed_range, view, viewable_range
```

| Concept | Means | Why it matters |
|---|---|---|
| `sized_range` | `ranges::size(r)` is O(1) | Algorithms can preallocate; `views::filter` is **not** sized |
| `common_range` | `begin` and `end` have the same type | Required to feed a range into a legacy iterator-pair algorithm; `views::common` adapts |
| `borrowed_range` | Iterators remain valid after the range object dies | Lets an algorithm safely return an iterator into an rvalue range (§14.11) |
| `view` | O(1) copy/move and destroy; semantically a *reference* to elements | The composability requirement for `|` chaining |
| `viewable_range` | Can be safely converted to a view — either an lvalue range or an rvalue *view* | Prevents piping a temporary `vector` into an adaptor |

**`view` vs `container`** is the central distinction: a container owns its elements and copying is O(n); a view refers to elements and copying is O(1). `std::ranges::view_interface` is the CRTP base (Ch. 6) that supplies `empty`, `front`, `back`, `operator[]`, and `operator bool` to a custom view given only `begin`/`end`.

**`std::ranges::dangling`** is the safety mechanism: `ranges::find(std::vector{1,2,3}, 2)` returns `std::ranges::dangling` — a type with no members — instead of a dangling iterator, so misuse is a *compile error* rather than a runtime UB. A range opts out by specializing `enable_borrowed_range` (as `string_view`, `span`, and `subrange` do), declaring that its iterators outlive it.

`std::ranges::subrange<I, S>` packages an iterator/sentinel pair as a view and is the standard return type for the "range half" of algorithms. `std::ranges::to<Container>()` (C++23) closes the loop by materializing any range into a container — the long-missing piece that made views practical:

```cpp
auto v = data | std::views::filter(live) | std::views::transform(&Order::price)
              | std::ranges::to<std::vector>();     // C++23
```

C++23 also relaxed several concepts and added `views::cartesian_product`, `views::zip`, `views::enumerate`, `views::chunk`, `views::slide`, and `views::join_with`. C++26 adds `views::concat` and `ranges::concat_view`.

---

## 14.10 Lazy Range Views

A **view adaptor** wraps a range and produces a new range whose iterators do work on demand. Nothing is computed at composition time; elements are produced one at a time as the consuming loop advances.

```cpp
auto result = orders
            | std::views::filter([](const Order& o){ return o.side == Buy; })
            | std::views::transform(&Order::price)
            | std::views::take(10);
// No work has happened. No allocation. Iterating `result` runs filter→transform per element.
```

Laziness gives three concrete wins: **no intermediate containers** (a `filter`+`transform` chain that would need two temporary vectors needs zero), **short-circuiting** (`take(10)` stops the pipeline after ten survivors, so the filter never examines the rest), and **infinite ranges** (`views::iota(0)` with `take_while`).

### The adaptor catalogue (C++20 unless noted)

| Adaptor | Semantics | Cost note |
|---|---|---|
| `views::all`, `views::counted` | Wrap / take n from a pointer | Free |
| `views::filter` | Skip non-matching | Not `sized_range`; **`begin()` is O(n)** and cached |
| `views::transform` | Apply f on dereference | Only `input_range` if f returns by value |
| `views::take`, `drop` | Prefix / suffix | O(1) on random access, O(n) `drop` otherwise |
| `views::take_while`, `drop_while` | Predicate-bounded | `drop_while::begin()` is O(n), cached |
| `views::reverse` | Reversed traversal | Requires bidirectional |
| `views::join` | Flatten range-of-ranges | |
| `views::split`, `lazy_split` | Tokenize by delimiter | `split` (C++20 fixed by P2210) is the usable one |
| `views::elements`, `keys`, `values` | Tuple element projection | Free |
| `views::zip`, `enumerate`, `adjacent`, `chunk`, `slide`, `stride`, `chunk_by`, `repeat`, `cartesian_product` | C++23 | |
| `views::concat` | C++26 | |

### The performance caveat that must be stated

Views are **usually** zero-overhead, and **sometimes not**. The known issues:

- **`filter_view::begin()` is amortized-O(1) only because it caches** the first satisfying position. That cache makes `filter_view` non-const-iterable (`begin()` is non-const), which cascades: you can't pass a `const filter_view&` to an algorithm, and you can't use it in a const member function.
- **`filter | transform` compiles to worse code than a hand-written loop in some compilers**, because the filter's per-increment predicate check creates a loop structure the vectorizer can't handle. Range pipelines over trivially-transformable data frequently fail to vectorize where the equivalent raw loop does. Always check the assembly (Compiler Explorer, Ch. 44) before putting a view chain on a hot path.
- **Debug builds are catastrophically slow** — every layer is a separate iterator class with several inlined calls per increment, and at `-O0` none of it inlines. A 10–50× debug slowdown is normal, which matters if you run tests unoptimized.
- **Compile time and error messages** are the real tax; a deep pipeline instantiates dozens of templates (Ch. 17 §17.22).

**When to use views:** expressive non-hot-path code, and pipelines where laziness eliminates a real allocation or enables real short-circuiting. **When not to:** the innermost loop of a feed handler, where a hand-written loop over a `span` is both faster and easier to reason about.

---

## 14.11 Range View Lifetimes

Views borrow. Every lifetime hazard in Ch. 13 §13.3 applies, plus two that are specific to pipelines.

**1. A view over a temporary container dangles.**

```cpp
auto bad = make_vector() | std::views::filter(pred);   // the vector is destroyed here
for (int x : bad) { /* UB */ }
```
The language partially protects you: `viewable_range` rejects piping an lvalue-less non-view *container* in most cases, and C++20's rules make `make_vector() | views::filter(...)` ill-formed for named use — but the protection is incomplete, and `owning_view` (C++20 DR, P2415) was added precisely to make rvalue containers *safe* by taking ownership:

```cpp
auto ok = make_vector() | std::views::filter(pred);   // filter over owning_view — the vector
                                                       // is moved into the pipeline and kept alive
```
So an rvalue *container* is now safe (it's owned); an rvalue *view over something else* is not, because the view owns nothing.

**2. Range-for over a temporary's subobject was UB until C++23.**

```cpp
for (auto c : get_object().get_string()) { ... }   // pre-C++23: UB. get_object()'s temporary
                                                    // died before the loop body ran.
```
The range-for expansion binds the range to `auto&& __range = expr`, which extends the lifetime of the *final* temporary only — not intermediate ones in the expression. **P2718 (C++23)** extends the lifetime of all temporaries in the range expression to the end of the loop, fixing a decade-old footgun. Until your toolchain is C++23, name the intermediate:

```cpp
auto obj = get_object();
for (auto c : obj.get_string()) { ... }
```

**3. Captured references in adaptor callables.** A lambda inside `views::filter` capturing by reference outlives the enclosing scope if the view is stored. Views are frequently stored in members or returned; a by-reference capture then dangles exactly like §13.3.

**4. `ranges::dangling`.** Algorithms taking an rvalue non-borrowed range return `std::ranges::dangling` rather than an iterator. Using the result is a compile error — the design deliberately converts a runtime UB into a type error. `views::all_t`, `subrange`, `span`, `string_view`, and `iota_view` are `borrowed_range`s (marked with `enable_borrowed_range`), so returning iterators from them is fine.

**Rule:** treat a stored view exactly like a stored raw pointer. Name the owner, and if you can't, materialize with `ranges::to<std::vector>()`.

---

## 14.12 Parallel Algorithms and Execution Policies

C++17 added an overload set taking an **execution policy** as the first argument:

```cpp
#include <execution>
std::sort(std::execution::par, v.begin(), v.end());
std::reduce(std::execution::par_unseq, v.begin(), v.end(), 0.0);
```

| Policy | Threads | Vectorization / interleaving | Constraints on your callable |
|---|---|---|---|
| `seq` | 1 | No | None (still no exception escape semantics) |
| `unseq` (C++20) | 1 | Yes — element operations may interleave in one thread | **No mutexes, no allocation, no order dependence** |
| `par` | Many | No interleaving within a thread | Must be data-race free; may use locks |
| `par_unseq` | Many | Both | No locks, no allocation, no vectorization-unsafe ops |

The `unseq` constraint is the sharp one: because operations from different elements may be interleaved within a single thread's instruction stream, **taking a lock inside a `par_unseq` callable can self-deadlock** — the same thread may attempt to acquire the mutex for element *i+1* before releasing it for element *i*. This is stated in the standard as "vectorization-unsafe" operations.

### Semantics and failure modes

- **Exceptions.** If an element access throws and it escapes a parallel algorithm, `std::terminate` is called. There is no propagation. Handle errors inside the callable.
- **Allocation failure.** If the implementation can't obtain resources for parallelism, it may fall back to sequential execution — or throw `std::bad_alloc`. It is not required to parallelize at all: **a conforming implementation may ignore the policy entirely**, and libstdc++ did exactly this until it gained a TBB dependency.
- **Determinism.** `reduce(par, …)` over floats is non-reproducible (§14.5).
- **Which algorithms parallelize well:** `sort`, `transform`, `reduce`, `transform_reduce`, `for_each`, `count_if`, the scans. Which don't: anything with a serial dependency, and anything where the per-element work is a few nanoseconds — the fork/join and cache-coherence overhead dominates below roughly 10⁴–10⁵ elements of nontrivial work.

### Tooling reality

- **libstdc++ requires linking Intel TBB** (`-ltbb`) for the parallel policies; without it you get link errors or silent sequential behavior.
- **libc++** shipped `<execution>` late and partially; check your version.
- **NVIDIA nvc++** maps `par`/`par_unseq` to GPU execution, which is the most interesting real use of the feature.

### Low-latency verdict

Parallel algorithms are **almost never right on a trading hot path**. The hot path is a pinned, isolated single thread (Ch. 31, Ch. 55); introducing a thread pool means scheduler interaction, cross-core cache traffic, unpredictable tail latency, and NUMA effects (Ch. 29). They belong in batch/offline work — backtests, risk recomputation, historical replay — where throughput matters and jitter doesn't. What *is* on the hot path is `unseq`-style vectorization, and there you want explicit SIMD (Ch. 42, and `std::simd` in Ch. 15 §15.8), not a policy tag whose behavior depends on your standard library vendor.

---

## Key Interview Questions

1. **What algorithm does `std::sort` use, and what changed in C++11?** — Introsort (quicksort → heapsort past a depth limit → final insertion-sort pass). C++11 upgraded the requirement from average to **worst-case** O(n log n), which is what forced the heapsort fallback.
2. **Why can't you `std::sort` a `std::list`?** — `sort` requires random-access iterators; `list` is bidirectional. `list::sort` is a merge sort that relinks nodes instead of moving values.
3. **What happens if your comparator isn't a strict weak ordering?** — UB, not just a wrong order: libstdc++'s partition loop can run past the end and corrupt memory. `a <= b` and non-transitive multi-key comparisons are the usual culprits.
4. **Top-100 of 10 million: which algorithm?** — `nth_element` (O(n) average) if order doesn't matter, `partial_sort` (O(n log k)) if it does. Never sort-then-truncate.
5. **What exactly does `nth_element` guarantee?** — Only that position k holds the k-th element and the range is partitioned around it; **neither side is sorted**.
6. **`lower_bound` vs `upper_bound` vs `equal_range`?** — First `>= v`, first `> v`, and the pair delimiting the equivalent run. `lower_bound` doubles as the insertion point.
7. **Is `std::lower_bound` on a `std::set` O(log n)?** — No: the free function does O(log n) comparisons but O(n) increments on bidirectional iterators. Use `set::lower_bound`.
8. **Why is binary search slower than its asymptotics suggest, and how do you fix it?** — Every step is an unpredictable branch and a cache miss; use branchless midpoint arithmetic, prefetch both children, or an Eytzinger layout; use linear search below ~32 elements.
9. **What does `std::remove` actually remove?** — Nothing. It compacts survivors forward and returns the new logical end; you must `erase`, or use C++20 `std::erase`/`erase_if`.
10. **`accumulate` vs `reduce`?** — Left fold with defined order vs unordered/unspecified-grouping fold requiring associativity and commutativity; `reduce` can be parallel and is non-deterministic for floats.
11. **Why does `std::accumulate(v.begin(), v.end(), 0)` on a `vector<double>` give the wrong answer?** — `init` deduces `int`; every partial sum truncates.
12. **What is `transform_reduce` for?** — A fused map-then-fold in one pass, no intermediate container, parallelizable — e.g. a dot product.
13. **What does "amortized O(1)" hide, and why does it matter for latency?** — Any single call can be O(n) and can allocate; the percentile tail is the reallocation, not the average.
14. **Which standard algorithms can allocate?** — `stable_sort`, `stable_partition`, `inplace_merge` (all degrade to a worse complexity if allocation fails).
15. **What is a contiguous iterator and what does it unlock?** — Elements adjacent in memory (C++17 guarantee, C++20 tag): `memmove` fast paths, SIMD, and passing `data()` to C APIs. `deque` is random-access but not contiguous.
16. **What did ranges change about iterators?** — Sentinels may differ in type from iterators, input iterators need not be copyable, and `iterator_concept` supplements `iterator_category`.
17. **What is a projection and how does it differ from a comparator?** — It selects what to compare (invoked via `std::invoke`, so `&T::member` works); the comparator orders the projected values. Projections are re-evaluated per comparison, so expensive ones want a precomputed key array.
18. **What distinguishes a `view` from a container?** — O(1) copy/move/destroy and reference semantics; that's the requirement for `|` composition.
19. **Why is `views::filter` not const-iterable?** — `begin()` caches the first satisfying element, so it is non-const and the view is not a `sized_range` either.
20. **What is `std::ranges::dangling` and `enable_borrowed_range`?** — Algorithms over rvalue non-borrowed ranges return `dangling`, converting a runtime UB into a compile error; borrowed ranges (`span`, `string_view`, `subrange`) opt out because their iterators outlive them.
21. **What did P2718 fix in C++23?** — Range-for over a temporary's subobject (`for (auto c : f().g())`) was UB; all temporaries in the range expression now live to the end of the loop.
22. **Why can a mutex inside a `par_unseq` callable deadlock?** — Element operations may interleave within one thread, so the same thread can re-enter the lock before releasing it.
23. **What happens if an exception escapes a parallel algorithm?** — `std::terminate`. No propagation.
24. **Would you use parallel algorithms on a trading hot path?** — No: thread-pool scheduling, cross-core coherence traffic, and NUMA effects destroy tail latency. They belong in batch work; on the hot path use explicit SIMD.

---

## Common Traps

- **A comparator using `<=`** — not a strict weak ordering; UB, and it really does corrupt memory.
- **Non-transitive multi-key comparators** (`a.x < b.x || a.y < b.y`) — use `std::tie` or `<=>`.
- **`std::remove` without `erase`** — the container's size never changes.
- **Reading a "sorted" prefix after `nth_element`** — the partition halves are unsorted.
- **`std::binary_search`/`lower_bound` on `set`/`map`/`list`** — O(n) iterator increments.
- **`accumulate(..., 0)` on floating-point ranges** — integer truncation.
- **`reduce` over floats where reproducibility matters** — non-associative, non-deterministic.
- **Assuming `stable_sort` doesn't allocate** — it does, and quietly degrades if it can't.
- **`std::function` as a comparator** — an indirect call per comparison, killing inlining.
- **An expensive projection** — re-evaluated O(n log n) times; precompute the keys.
- **Storing a view over a temporary that isn't owned** — dangles; only rvalue *containers* are rescued by `owning_view`.
- **Range-for over `f().g()` before C++23** — the intermediate temporary dies first.
- **By-reference captures in `views::filter`/`transform` callables** on a stored view.
- **Expecting `const` iteration over `views::filter`** — `begin()` is non-const because it caches.
- **Assuming range pipelines vectorize** — filter chains often defeat the vectorizer; check the assembly.
- **Running range-heavy code at `-O0`** — 10–50× slower; debug builds are not representative.
- **Locks or allocation inside a `par_unseq` callable** — vectorization-unsafe; can self-deadlock.
- **Letting an exception escape a parallel algorithm** — `std::terminate`.
- **Forgetting `-ltbb`** with libstdc++ parallel policies.
- **Treating asymptotic complexity as the performance model** — `map`'s O(log n) pointer chase loses to a flat array's O(n) scan at realistic sizes.

---

## Compact Recall Summary

**Sorting.** `sort` = introsort (quicksort + heapsort depth fallback + final insertion pass), worst-case O(n log n) since C++11, unstable, random-access only. `stable_sort` = merge sort, allocates. Comparators must be strict weak orderings or you get UB. Modern implementations use branchless (BlockQuicksort/pdqsort) partitioning; radix sort still beats all of them on fixed-width integer keys, and sorting indices beats sorting fat objects.

**Selection.** `nth_element` = quickselect, **O(n) average**, produces only a partition. `partial_sort` = heap-based, O(n log k), first k sorted. Top-k of a large set is one of these, never a full sort.

**Binary search.** `lower_bound` (first ≥), `upper_bound` (first >), `equal_range`, `partition_point`. Requires only a partitioned range. O(log n) *comparisons*, but O(n) *increments* on non-random-access iterators, so use the member functions on node-based containers. Real cost is mispredicts and misses: branchless search, prefetching, Eytzinger layout, linear scan below ~32.

**Partitioning.** `partition` (unstable, forward iterators, ≤ n/2 swaps) vs `stable_partition` (allocates). `remove`/`remove_if` compact and return the new end — always pair with `erase`, or use C++20 `erase`/`erase_if`. Branchless compaction (`*out = x; out += pred(x);`) wins when the predicate is unpredictable, loses when it's skewed.

**Transform/accumulate.** `accumulate` is an ordered left fold; `reduce`/`transform_reduce`/the scans are order-relaxed, policy-accepting, and require associativity — hence non-deterministic for floats. `exclusive_scan` is the offset-table primitive. Watch the `init` type. Vectorization of `transform` hinges on aliasing.

**Complexity guarantees.** Stated in counted comparisons/assignments/swaps, not time and not iterator movement. Amortized O(1) hides an O(n) tail (a latency-percentile problem). `stable_sort`, `stable_partition`, `inplace_merge` allocate and silently degrade. Asymptotics ignore the memory hierarchy.

**Iterator categories.** input/output → forward → bidirectional → random access → contiguous. Contiguous unlocks `memmove` and C interop. Ranges added sentinels of a distinct type, move-only input iterators, and `iterator_concept`.

**Comparators and projections.** Comparator = ordering, projection = what to look at (via `std::invoke`, so `&T::member` works). Transparent `less<>`/`greater<>` for heterogeneous comparison; never `std::function`; precompute expensive projections.

**Range concepts.** `range` + the iterator ladder, plus orthogonal `sized_range`, `common_range`, `borrowed_range`, `view`, `viewable_range`. A view is O(1) to copy; a container isn't. `ranges::to<C>()` (C++23) materializes.

**Views.** Lazy, allocation-free, short-circuiting, composable with `|`. Costs: `filter_view::begin()` caches (so it's non-const and unsized), pipelines often fail to vectorize, debug builds are 10–50× slower, compile times and diagnostics suffer. Great above the hot path, suspect inside it.

**View lifetimes.** Views borrow; treat a stored view as a stored pointer. Rvalue containers are rescued by `owning_view`; rvalue views are not. `ranges::dangling` turns a class of dangling-iterator UB into compile errors. P2718 (C++23) fixed range-for over a temporary's subobject.

**Parallel algorithms.** `seq`/`unseq`/`par`/`par_unseq`. `unseq` forbids locks and allocation (interleaving can self-deadlock); escaping exceptions call `std::terminate`; implementations may ignore the policy entirely; libstdc++ needs TBB. Wrong for hot paths — right for batch, backtests, and replay.
