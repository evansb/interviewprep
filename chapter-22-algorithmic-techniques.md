# Chapter 22 — Algorithmic Techniques

*Interview-focused revision notes. The theme: a technique is a reusable argument about why a loop terminates with the right answer in less work than brute force — and on modern hardware the winning technique is usually the one with the most predictable memory and branch behaviour, not the one with the smallest exponent.*

---

## 22.1 Two Pointers

**Two pointers** is the family of algorithms that maintains two indices into a sequence and advances them under a rule that guarantees each index moves monotonically, giving O(n) total work where a naive double loop gives O(n²). The correctness argument is always the same shape: *an invariant says the answer, if it exists, lies between the pointers; each step provably removes a candidate that cannot be the answer.*

Three canonical shapes:

**Opposite ends (converging).** Requires a sorted or otherwise monotone input.

```cpp
// Two-sum on a sorted range.
std::pair<int,int> two_sum(std::span<const int> a, int target) {
    size_t lo = 0, hi = a.size() - 1;
    while (lo < hi) {
        int s = a[lo] + a[hi];
        if (s == target) return {int(lo), int(hi)};
        if (s < target) ++lo;   // a[lo] can pair with nothing larger than a[hi]; discard it
        else            --hi;
    }
    return {-1,-1};
}
```
The discard argument is the whole proof: if `a[lo]+a[hi] < target`, then `a[lo]` paired with *any* remaining element is also too small, so row `lo` is eliminated in O(1) instead of O(n).

**Same direction (fast/slow).** In-place partition, `std::remove`, deduplication of a sorted range. The write pointer trails the read pointer and the prefix `[0, write)` is the invariant-satisfying output.

```cpp
// This is exactly how libstdc++ implements std::remove.
auto w = first;
for (auto r = first; r != last; ++r)
    if (!(*r == value)) *w++ = std::move(*r);
return w;   // erase-remove: c.erase(w, c.end());
```

**Cycle detection (Floyd's tortoise and hare).** Slow advances one, fast two; they meet inside the cycle within O(λ+μ) steps. Restarting one pointer at the head and advancing both by one finds the cycle entry. Constant space, versus a hash set's O(n). Brent's algorithm is the faster variant (fewer pointer chases, better for expensive `next()`).

### Low-latency angle

Two-pointer scans over contiguous storage are the ideal memory access pattern: two independent forward (or one forward/one backward) streams, both of which the L2 hardware prefetcher recognizes and tracks (Ch. 28 covers stream detection). Converging scans generate two streams walking toward each other — still prefetchable, but the total resident footprint is the whole range, so they thrash on large inputs where a single forward scan would not.

The branch in the loop body (`s < target`) is data-dependent and typically unpredictable, costing ~15–20 cycles per mispredict. When the loop body is otherwise cheap, a branchless formulation using `cmov`-style arithmetic wins:

```cpp
lo += (s < target);
hi -= (s > target);   // both compile to setcc/cmov, no branch
```
This is the general lesson (expanded in Ch. 42): O(n) with an unpredictable branch per element can lose to O(n log n) with predictable control flow.

**Preconditions are the failure mode.** Every converging two-pointer algorithm silently returns wrong answers on unsorted input rather than crashing. In interviews, state the precondition explicitly; in code, `assert(std::is_sorted(...))` under a debug build.

---

## 22.2 Sliding Windows

A **sliding window** is a two-pointer variant where `[lo, hi)` is a contiguous subrange maintained under a predicate, plus an incrementally-updated aggregate over that subrange. It applies when two conditions hold:

1. The aggregate is **incrementally updatable** — adding an element at `hi` and removing one at `lo` are O(1) or O(log k), not O(window).
2. The predicate is **monotone in the window** — if `[lo,hi)` violates it, so does every superset (or: if it satisfies it, so does every subset). This is what makes `lo` monotone and gives the amortized O(n) bound.

### Two forms

| Form | Loop shape | Typical question |
|---|---|---|
| **Variable-size** | Extend `hi`; while predicate violated, shrink `lo` | "Longest substring with ≤ k distinct chars", "smallest subarray with sum ≥ S" |
| **Fixed-size k** | Advance both together | Moving average, rolling max, k-gram hashing |

```cpp
// Longest subarray with sum <= S (non-negative values → monotone).
size_t best = 0, lo = 0; long long sum = 0;
for (size_t hi = 0; hi < a.size(); ++hi) {
    sum += a[hi];
    while (sum > S) sum -= a[lo++];     // lo never moves backward → total O(n)
    best = std::max(best, hi - lo + 1);
}
```

**The monotonicity trap:** with negative values present, shrinking from the left can *decrease* the sum further, so the predicate is no longer monotone and the window is invalid. The correct tool becomes prefix sums plus a sorted structure or a monotonic deque (§22.12, §22.13). "Does the array contain negatives?" is the single highest-value clarifying question in sliding-window interviews.

### Aggregate maintenance

- **Sum / count / XOR** — O(1) both directions. Trivial.
- **Distinct count** — hash map of counts; increment on add, decrement on remove, adjust distinct count when a count crosses 0/1. O(1) amortized.
- **Max / min** — *not* invertible: removing an element cannot restore the previous max. Requires a **monotonic deque** (§22.11) for O(1) amortized, or a multiset for O(log k).
- **Median / k-th** — two heaps or an order-statistic tree, O(log k).

The invertibility question is the deep one: sums form a group (there is an inverse), maxima form only a semigroup (no inverse). Any sliding-window aggregate over a non-invertible operation needs either a deque, a "two-stacks" trick (amortized O(1) for arbitrary associative ops), or a sparse table for the offline case.

### Low-latency angle

Fixed-size windows over a ring buffer (Ch. 21) are the standard market-data primitive: rolling VWAP, rolling volatility, N-tick momentum. Prefer a preallocated power-of-two ring with an `& (N-1)` mask over `%`; prefer maintaining the aggregate incrementally over recomputation — but watch **floating-point drift**: incrementally subtracting the outgoing value from a running `double` sum accumulates error without bound over millions of updates. Periodic full recomputation, Kahan summation, or a fixed-point accumulator is required (Ch. 23 §23.9, §23.10). This is a very common HFT follow-up: the naive incremental rolling mean is numerically wrong on a long-running feed handler.

---

## 22.3 Binary Search

**Binary search** finds a position in a sorted (more precisely, *partitioned*) range in O(log n) comparisons. The generalized precondition is not "sorted" but: the predicate `p(x)` is **monotone** over the range — false for a prefix and true for the suffix. Binary search finds the boundary.

### Write it as partition-point, not as "find"

The equality-testing three-branch form is the one people get wrong. The robust formulation returns the boundary and has exactly one comparison per iteration:

```cpp
// Returns first index i in [lo,hi) with pred(a[i]) true; hi if none.
size_t lower_bound_if(std::span<const T> a, auto pred) {
    size_t lo = 0, hi = a.size();
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;    // never lo+hi: overflow (Ch. 2 §2.4)
        if (pred(a[mid])) hi = mid;         // answer is at or left of mid
        else              lo = mid + 1;     // answer is right of mid
    }
    return lo;                              // == hi; invariant holds at exit
}
```
The invariant: *the answer is always in `[lo, hi]`.* Termination: `hi - lo` strictly decreases because `mid < hi` always and `mid + 1 > lo` always. Writing this invariant on the whiteboard before the loop is the difference between a candidate who derives the code and one who recites it.

The `lo + (hi-lo)/2` form avoids the signed overflow bug that sat in `java.util.Arrays.binarySearch` and the JDK for nine years. With `size_t` indices on a real array the overflow is unreachable, but the habit is correct and interviewers look for it.

### Standard library

| Function | Returns | Predicate |
|---|---|---|
| `std::lower_bound` | first element **not less than** value | `*it < value` |
| `std::upper_bound` | first element **greater than** value | `!(value < *it)` |
| `std::equal_range` | both, as a subrange | — |
| `std::binary_search` | `bool` only | — |
| `std::partition_point` | first element where predicate is false | arbitrary monotone predicate |

`std::partition_point` is the general one; `lower_bound` is `partition_point` with `pred = (x < value)`. All four require only **ForwardIterator**, but on a non-random-access iterator (`std::list`, `std::set::iterator`) they perform O(n) *advances* while doing O(log n) comparisons — so binary search on a `std::list` is O(n) and pointless. Ch. 14 §14.3 covers the ranges versions and projections.

### Low-latency angle

Binary search is a **branch-misprediction machine**: every iteration's branch is ~50/50 by construction, so a search over 1M elements costs ~20 mispredicts ≈ 300+ cycles of pure penalty, on top of ~20 dependent cache misses (each iteration's address depends on the previous comparison — a serialized pointer-chase with no memory-level parallelism).

Mitigations, in ascending order of effort:

- **Branchless binary search.** Fixed trip count, `cmov` for the index update, and `__builtin_prefetch` of both candidate midpoints one level ahead. Typically 2–3× faster than `std::lower_bound` on large arrays.
  ```cpp
  auto base = a.data(); size_t n = a.size();
  while (size_t half = n / 2) {
      base += (base[half] < value) ? half : 0;   // cmov, no branch
      n -= half;
  }
  ```
- **Eytzinger (BFS) layout.** Store the implicit search tree in breadth-first order so the first log(cacheline) levels live in one or two cache lines. Removes most of the misses; costs a permuted layout and makes range scans impossible.
- **B-tree / interpolation layouts** for very large static tables.
- **Just use a hash table** if you only need exact lookup — O(1) with one or two misses beats O(log n) misses (Ch. 12).

For small n (≲ 64 on modern x86), a **linear SIMD scan beats binary search** outright: it is branchless, sequential, and prefetch-friendly. This crossover is a favourite HFT question, and the answer "measure it, but expect the crossover around a cache line or two" is the right one.

---

## 22.4 Binary Search on the Answer

Also called **parametric search**. When the *answer* is a number and there is a monotone feasibility predicate `feasible(x)` — true for all x above some threshold and false below — you binary search over the answer space rather than over an array. This converts an optimization problem into O(log range) instances of a decision problem, which is usually far easier.

The template:

```cpp
// Minimize x subject to feasible(x), where feasible is monotone increasing in x.
T lo = min_possible, hi = max_possible;      // hi must be known-feasible
while (lo < hi) {
    T mid = lo + (hi - lo) / 2;
    if (feasible(mid)) hi = mid;
    else               lo = mid + 1;
}
return lo;
```

Total cost = O(log(range) × cost(feasible)). Note the log is over the *magnitude* of the range, not the input size — searching a 64-bit range is 64 iterations regardless of n.

### Recognizing it

The tell is a problem statement of the form *"minimize the maximum …"* or *"maximize the minimum …"* or *"what is the smallest capacity/speed/time such that X is achievable."* Examples: minimum ship capacity to deliver in D days; minimum largest sum when splitting an array into k parts; smallest maximum distance when placing k routers; **Kth smallest element in a sorted matrix** (feasible(x) = "at least k elements ≤ x", counted in O(n) by walking the staircase).

The proof obligation is always **monotonicity of `feasible`**, and it is where sloppy candidates lose points. If more capacity can ever make the problem *infeasible*, the search is invalid. State and justify it.

### Real-valued search

Over reals, `lo < hi` never terminates. Two correct forms:

```cpp
// (a) fixed iteration count — preferred, deterministic, no epsilon tuning
for (int i = 0; i < 100; ++i) { double m = 0.5*(lo+hi); feasible(m) ? hi=m : lo=m; }
// 100 halvings of a double's range exhausts its precision; ~60 is already exact.

// (b) bit-level: binary search over the integer ordering of positive doubles
//     std::bit_cast<uint64_t> of a positive double is monotone in the double's value.
```
Form (b) is a genuinely non-obvious fact worth knowing (Ch. 23 §23.8): for positive IEEE-754 doubles, the bit pattern read as `uint64_t` orders identically to the value, so `std::bit_cast` gives an exact integer binary search and a well-defined ULP distance metric.

### Low-latency angle

Parametric search shows up in production as **calibration and sizing**: finding the largest batch size meeting a p99 latency target, the smallest ring-buffer size with zero drops under replay, the price level at which cumulative depth exceeds a quantity. In the last case the predicate is a prefix sum over the book, so binary search over a **prefix-sum array of depth** (§22.12) answers "what price fills N shares" in O(log levels) instead of a linear walk — worthwhile only if the book has many levels; for the typical 10-level book a linear scan of contiguous levels wins on cache and branch behaviour.

---

## 22.5 Sorting Properties and Tradeoffs

Ch. 14 §14.1 covered the standard-library algorithms and their guarantees. This section is the algorithm-selection view.

### The property matrix

| Algorithm | Avg | Worst | Space | Stable | Adaptive | In practice |
|---|---|---|---|---|---|---|
| Insertion | O(n²) | O(n²) | O(1) | Yes | **Yes** (O(n+inv)) | Best for n ≲ 32; the base case of everything |
| Selection | O(n²) | O(n²) | O(1) | No | No | Only when writes are far costlier than reads (n−1 writes) |
| Heapsort | O(n log n) | **O(n log n)** | O(1) | No | No | Worst-case guarantee; terrible cache locality |
| Mergesort | O(n log n) | O(n log n) | **O(n)** | **Yes** | Yes (natural/Tim) | External sort, linked lists, stability requirement |
| Quicksort | O(n log n) | **O(n²)** | O(log n) | No | No | Fastest constant factor; needs pivot defence |
| Introsort | O(n log n) | **O(n log n)** | O(log n) | No | Partly | `std::sort` — quicksort + heapsort fallback + insertion base |
| Radix / counting | O(nk) / O(n+k) | same | O(n+k) | Yes | No | Fixed-width integer keys; beats comparison sorts at scale |
| Pdqsort | O(n log n) | O(n log n) | O(log n) | No | **Yes** | libstdc++/Rust default class; O(n) on patterned input |

**Stable** means equal elements retain their relative input order. It matters when sorting by successive keys (sort by secondary key, then stable-sort by primary — "radix by field") and whenever an equal-comparing tiebreak is semantically meaningful. `std::sort` is **not** stable; `std::stable_sort` is, and allocates O(n) (falling back to an O(n log² n) in-place merge if allocation fails — a real, silently-slower failure mode under memory pressure).

**Adaptive** means faster on already-partially-sorted input. Timsort and pdqsort detect runs; `std::sort` in modern libstdc++ (pdqsort-derived) detects them too, which is why re-sorting a nearly-sorted book is close to O(n).

### The Ω(n log n) bound and its escape hatches

Any **comparison** sort needs Ω(n log n) comparisons: the decision tree has n! leaves, so its height is ≥ log₂(n!) ≈ n log₂ n − 1.44n. This bound is about *comparisons only*. Radix and counting sort escape it by using the key's structure rather than comparing — O(n·k/b) passes for k-bit keys in b-bit digits. For 10⁶ 32-bit integers, a 4-pass 8-bit LSD radix sort typically beats `std::sort` by 2–4×.

### Low-latency angle

- **Quicksort's O(n²)** is not theoretical: a naive first-element or median-of-three pivot has known adversarial inputs, and organized-pivot attacks were a real DoS vector. Introsort's heapsort fallback (triggered at depth 2·log n) is the defence and is why `std::sort` has a hard worst-case guarantee since C++11.
- **Sorting is memory-bound, not compare-bound**, above L2. Mergesort's sequential streams prefetch well; heapsort's `2i+1` index jumps miss constantly, which is why it loses badly in wall-clock despite an identical asymptotic bound.
- **Sort indices, not objects,** when the payload is large — then either permute once or keep the index array. Conversely, for *small* records, sorting the records directly beats an index sort because the index sort's final gather is a random-access pass.
- **Don't sort at all** if you need only the top k: `std::nth_element` or a bounded heap (§22.6) is O(n) vs O(n log n).
- In a hot path, a **presorted insert into a small array** (insertion sort's inner loop, or a branchless shift) beats re-sorting; this is the standard price-level book update.

---

## 22.6 Selection and Partial Sorting

**Selection** is finding the k-th order statistic without fully sorting. Partial sorting is producing the first k in order.

| Task | Tool | Complexity |
|---|---|---|
| k-th element, unordered rest | `std::nth_element` | O(n) average |
| Top k in sorted order | `std::partial_sort` | O(n log k) |
| Top k from a stream into a range | `std::partial_sort_copy` | O(n log k) |
| Just min / max / both | `std::min_element`, `std::minmax_element` | n−1 / ~1.5n comparisons |

`std::nth_element` is **introselect**: quickselect (partition around a pivot, recurse into only the side containing k) with a median-of-medians or heapselect fallback to guarantee O(n) worst case. Quickselect's average is O(n) because the recursion cost is n + n/2 + n/4 + … = 2n — this derivation is a common ask.

**Median of medians** gives deterministic O(n) with a large constant (~10–20× quickselect's), so it is used only as a fallback, never as the primary path.

### Streaming top-k

When n does not fit in memory or arrives incrementally, maintain a **bounded min-heap of size k**: push if the incoming element beats the heap's minimum, else discard.

```cpp
// Top-k largest from a stream; heap holds the k best seen, root = smallest of them.
std::priority_queue<T, std::vector<T>, std::greater<>> h;   // min-heap
for (const T& x : stream) {
    if (h.size() < k) h.push(x);
    else if (x > h.top()) { h.pop(); h.push(x); }
}
```
O(n log k) time, O(k) space, one pass. The `else if` guard is the important part: on random input, the probability that the i-th element enters the heap is k/i, so the expected number of heap operations is O(k log n), not O(n log k). Most elements cost a single well-predicted comparison.

### Low-latency angle

`std::nth_element` **reorders your input** and gives no ordering guarantee outside the k-th position — surprising people who then read `a[k+1]` expecting the (k+1)-th smallest. If you need both a median and the original order, copy first.

For a **running median** over a sliding window (a real market-data need: median trade size, median spread), the standard structure is two heaps (max-heap of the lower half, min-heap of the upper half) rebalanced on each insert — but heaps do not support arbitrary deletion, so a sliding window needs lazy deletion with a "to-delete" multiset, or an order-statistic tree, or for a small fixed window (k ≲ 32) simply an insertion-sorted array, which wins on cache and branch behaviour despite O(k) per update.

**Percentile computation on latency data** is the other production case: do not sort millions of samples to get p99. Use a fixed-bucket histogram (HDR Histogram, Ch. 43), which is O(1) per sample, allocation-free, and mergeable — and note that quantiles of quantiles are not quantiles, so per-thread histograms must be merged as histograms, never averaged.

---

## 22.7 Recursion and Backtracking

**Recursion** solves a problem by reducing it to smaller instances of itself; the machinery is the call stack, which stores each frame's locals, return address, and saved registers (Ch. 41 covers frame layout).

**Backtracking** is depth-first search over a space of partial solutions with **pruning**: build a candidate incrementally, and abandon a branch as soon as it cannot be completed. Without pruning it degenerates to brute-force enumeration; the pruning predicate is the algorithm.

```cpp
void permute(std::vector<int>& a, size_t i, std::vector<std::vector<int>>& out) {
    if (i == a.size()) { out.push_back(a); return; }
    for (size_t j = i; j < a.size(); ++j) {
        std::swap(a[i], a[j]);
        permute(a, i + 1, out);
        std::swap(a[i], a[j]);        // undo — the "backtrack"
    }
}
```
The **undo step** is the defining feature: state is mutated in place and restored on exit, so the working set is O(depth) rather than O(nodes). Forgetting the undo is the classic bug; so is undoing incorrectly when the forward step was conditional.

### Complexity and pruning

The cost is O(nodes visited × work per node), and *nodes visited* is what pruning controls. N-Queens is the canonical demonstration: naive enumeration is 8⁸ ≈ 16M placements; column/diagonal constraint pruning cuts it to ~2000 nodes. Constraint propagation (forward checking, arc consistency) prunes further. When asked "what's the complexity of your backtracking solution," the honest answer is the unpruned bound plus a statement of what the pruning buys.

### Recursion in production C++

| Hazard | Detail |
|---|---|
| **Stack overflow** | Default thread stack is 8 MB on Linux main, often 2 MB for `std::thread`; a frame with a few `std::vector`s is ~100 B, so depth ~10⁵ is fine and ~10⁷ is fatal. Overflow hits the guard page → `SIGSEGV` with no unwinding, no destructors, no exception. |
| **Not a tail call** | C++ has no guaranteed TCO. GCC/Clang perform it at `-O2` when the call is in tail position and no destructors must run after it — a local `std::string` silently disables it. Never rely on it for correctness. |
| **Depth-dependent latency** | Recursive descent on adversarial input (deeply nested protocol messages, JSON) is a DoS vector. Always impose an explicit depth limit when parsing untrusted data (Ch. 51). |
| **Cache behaviour** | The stack is the hottest memory in the machine (L1-resident, prefetched, no TLB pressure). Shallow recursion is often *faster* than an explicit heap-allocated stack, which is why "convert recursion to iteration" is not automatically a win. |

**Converting to iteration** means making the frame explicit: a `std::vector<Frame>` used as a stack, with a state machine for the resume point. Do it when depth is unbounded or input is untrusted; it costs readability and adds heap traffic, but the vector is contiguous (better than the real stack for very deep, narrow frames) and reserve-able.

Recursion depth for divide-and-conquer is O(log n) and never a concern; recursion depth for linked-list or path traversal is O(n) and always is.

---

## 22.8 Divide and Conquer

**Divide and conquer** splits a problem into a subproblems of size n/b, solves them recursively, and combines in O(f(n)). The cost obeys T(n) = a·T(n/b) + f(n), resolved by the **Master Theorem**:

| Case | Condition | Result | Example |
|---|---|---|---|
| 1 | f(n) = O(n^(log_b a − ε)) | T(n) = Θ(n^(log_b a)) | Karatsuba: 3T(n/2)+O(n) → Θ(n^1.585) |
| 2 | f(n) = Θ(n^(log_b a)) | T(n) = Θ(n^(log_b a) · log n) | Mergesort: 2T(n/2)+O(n) → Θ(n log n) |
| 3 | f(n) = Ω(n^(log_b a + ε)), regular | T(n) = Θ(f(n)) | 2T(n/2)+O(n²) → Θ(n²) |

Read it as: *the work is dominated by the leaves (case 1), spread evenly across levels (case 2), or dominated by the root (case 3).* Being able to state which case applies and why is more valuable than memorizing the inequalities.

Key instances: mergesort and quicksort; binary search (a=1, b=2, f=O(1) → Θ(log n)); Karatsuba multiplication; Strassen matrix multiply (7T(n/2)+O(n²) → Θ(n^2.807)); FFT; closest pair of points (Θ(n log n) with the 7-point strip argument); `std::inplace_merge`.

### Why it matters beyond asymptotics

**Cache-obliviousness.** Recursive subdivision automatically produces a memory access pattern that is optimal at *every* level of the cache hierarchy without knowing any cache parameters, because the recursion eventually reaches a subproblem that fits in whatever cache level you name. This is the deep reason recursive matrix multiplication and recursive transposes beat naive triple loops (Ch. 23 §23.6).

**Parallelism.** Independent subproblems parallelize with no synchronization until the combine step — the fork-join model. `std::execution::par` (Ch. 14 §14.12) and Intel TBB are built on exactly this recursive splitting. The practical rule is a **grain size cutoff**: below ~1000 elements, switch to the serial base case, because task-spawn overhead (~hundreds of ns) dominates.

**The base case is where the constant factor lives.** `std::sort` switches to insertion sort at 16 elements; recursive FFT switches to unrolled radix-4 kernels; recursive matmul switches to a register-blocked SIMD kernel. A divide-and-conquer algorithm with a naive base case is usually slower than a well-tuned iterative one.

### Failure modes

- **Combine cost dominating.** If the merge is O(n log n), the whole thing is O(n log² n). Check case 3.
- **Unbalanced splits.** Quicksort with a bad pivot is D&C with a = 1 effectively, giving O(n²).
- **Recomputing overlapping subproblems.** If subproblems overlap, it is not divide and conquer — it is dynamic programming (§22.9), and naive recursion is exponential. The distinguishing question is: *do the subproblems share sub-subproblems?*

---

## 22.9 Dynamic Programming

**Dynamic programming** applies when a problem has (a) **optimal substructure** — an optimal solution is composed of optimal solutions to subproblems — and (b) **overlapping subproblems** — the same subproblem is reached along many recursion paths. DP eliminates the redundancy by storing each subproblem's answer once.

Naive Fibonacci recursion is Θ(φⁿ); memoized it is Θ(n). That gap is the entire point of the technique.

### Two implementation styles

| | Top-down (memoized recursion) | Bottom-up (tabulation) |
|---|---|---|
| Shape | Recursion + cache lookup | Loops over states in dependency order |
| Computes | Only reachable states | All states |
| Stack | O(depth) — can overflow | O(1) |
| Speed | Slower (hash/table lookup + call overhead) | Faster; enables rolling arrays and SIMD |
| Ease | Easier to derive from the recurrence | Requires establishing a valid topological order |

Derive top-down, then convert to bottom-up if it is hot. That is the honest workflow and a good thing to say aloud.

### The four-step method

1. **Define the state** — what parameters uniquely identify a subproblem. This is 80% of the difficulty.
2. **Write the recurrence** — the transition between states.
3. **Identify base cases.**
4. **Determine the evaluation order** (bottom-up) so every dependency is computed first.

Complexity = (number of states) × (transition cost). Say it that way; it is exact and immediately gives the answer.

```cpp
// 0/1 knapsack: states = (item index, remaining capacity); transition O(1).
// O(n·W) time. Rolling 1-D array, iterated DOWNWARD so each item is used once.
std::vector<int> dp(W + 1, 0);
for (const auto& [w, v] : items)
    for (int c = W; c >= w; --c)              // upward iteration → unbounded knapsack
        dp[c] = std::max(dp[c], dp[c - w] + v);
```
The direction of that inner loop is the classic 0/1-vs-unbounded distinction, and interviewers ask about it precisely because it looks like an arbitrary detail and is not.

### The canonical family

Linear DP (LIS — O(n log n) via patience sorting with `lower_bound`, not O(n²) DP); grid DP (edit distance, LCS); interval DP (matrix chain, O(n³)); tree DP (DFS post-order, states per subtree); bitmask DP over subsets (TSP: O(2ⁿ·n²), practical to n ≈ 20); digit DP; DP on DAGs (which is exactly memoized topological traversal, §22.17).

### Low-latency and engineering angle

- **Space optimization.** If row i depends only on row i−1, keep two rows — or one, with careful direction. This is not just memory: an O(W) rolling array fits in L1/L2 while an O(nW) table streams from DRAM, often a 10× wall-clock difference at identical asymptotics.
- **Memory layout.** Iterate the DP table in row-major order to keep the access pattern sequential and prefetchable. A transposed loop nest with identical complexity can be 5–10× slower (Ch. 23 §23.5).
- **`std::vector<bool>` for DP bitsets** is genuinely the right tool here (unlike almost everywhere else) — or better, `std::bitset` / `uint64_t` words, letting subset-sum-style DP advance 64 states per instruction via shifts and ORs. This bitset trick turns O(n·W) into O(n·W/64) and is a strong answer.
- **Memoization container choice.** `unordered_map` for sparse state spaces costs a hash and a likely cache miss per lookup; a flat `vector` indexed by an encoded state is far faster when the space is dense. Encode multi-dimensional states into a single integer index by hand.

**Greedy vs DP** is the most common misclassification: if a locally optimal choice provably extends to a global optimum, greedy is O(n log n); if not, DP is required. Fractional knapsack is greedy; 0/1 knapsack is not.

---

## 22.10 Greedy Algorithms

A **greedy algorithm** builds a solution by repeatedly making the locally best choice and never reconsidering. It is correct only when the problem has one of two structures:

- **The greedy-choice property** — some optimal solution contains the first greedy choice. Proved by an **exchange argument**: take any optimal solution, show you can swap in the greedy choice without making it worse.
- **Matroid structure** — the independent sets form a matroid, in which case greedy by weight is provably optimal (this is the general theorem behind Kruskal's MST).

Without such a proof, greedy is a heuristic. "It seems to work on the examples" is exactly the answer an interviewer is probing for.

### Correct greedy, with the argument

| Problem | Greedy rule | Why it works |
|---|---|---|
| Activity selection / max non-overlapping intervals | Earliest **finish** time | Exchange: the earliest-finishing activity leaves the most room; swapping it in never hurts |
| Fractional knapsack | Highest value/weight ratio | Divisibility makes the exchange argument exact |
| Huffman coding | Merge two least-frequent nodes | The two rarest symbols are siblings at max depth in some optimal tree |
| MST (Kruskal / Prim) | Cheapest safe edge | Cut property; matroid |
| Dijkstra | Nearest unsettled vertex | Non-negative weights ⇒ settled distances are final (§22.16) |
| Coin change, canonical systems (US/EUR) | Largest coin first | System-specific; **fails** for {1,3,4} making 6 (4+1+1 vs 3+3) |
| Minimize lateness / job scheduling | Earliest deadline first | Exchange: any inversion can be swapped without increasing max lateness |

Interval **scheduling** (max count) is greedy by finish time; interval **partitioning** (min rooms) is greedy by start time with a min-heap of end times; interval **point-cover** is greedy by right endpoint. These three get conflated constantly — see §22.15.

### Greedy failure modes

- **Choosing the wrong greedy key.** Activity selection by *earliest start* or *shortest duration* both fail; only earliest-finish works. Constructing the counterexample on the spot is the skill being tested.
- **Non-canonical coin systems.** The coin-change counterexample above is the standard rebuttal to "greedy always works for coins."
- **0/1 constraints.** Indivisibility breaks the exchange argument, which is exactly why fractional knapsack is greedy and 0/1 is DP.

### Low-latency angle

Greedy algorithms dominate hot paths because they are single-pass, allocation-free, and branch-light. Order-matching (Ch. 50) is greedy: fill against the best price level, then the next — the price-time priority rule *is* the greedy choice, and it is optimal by construction because the exchange defines the objective. Similarly, best-execution routing across venues is greedy by effective price, and greedy bin-packing (first-fit-decreasing, within 11/9 of optimal) is what real allocators use for size-class assignment (Ch. 7).

When greedy is provably correct, prefer it to DP even at equal asymptotics: it is O(1) space, has no table to miss on, and vectorizes.

---

## 22.11 Bit-Manipulation Techniques

Bit tricks matter because they replace branches and loops with one or two ALU instructions of ~1-cycle latency, and because subset/flag problems map directly onto machine words. Ch. 15 §15.7 covers the C++20 `<bit>` header; this section is the technique catalogue.

### The core identities

```cpp
x & (x - 1)        // clear lowest set bit
x & (-x)           // isolate lowest set bit  (== x & ~x + 1; two's complement)
x | (x + 1)        // set lowest clear bit
x ^ (x - 1)        // mask of lowest set bit and everything below
x & (x - 1) == 0   // is power of two (or zero — check separately)
x & (n - 1)        // x % n for power-of-two n
(x >> k) & 1       // test bit k
x ^= (1u << k)     // toggle bit k
```

`x & (x-1)` is the basis of **Brian Kernighan's popcount**: loop while x, clearing the lowest set bit — O(popcount) iterations rather than O(bits). Superseded by hardware `POPCNT`, but still the right answer for sparse masks on targets without it.

### Prefer the standard library (C++20 `<bit>`)

| Function | Instruction | Notes |
|---|---|---|
| `std::popcount` | `POPCNT` / `CNT` | Needs `-mpopcnt`; ~3-cycle latency, 1/cycle throughput |
| `std::countl_zero` / `countr_zero` | `LZCNT` / `TZCNT` | `BSR`/`BSF` are the legacy forms and are **undefined for zero**; `LZCNT`/`TZCNT` return the width |
| `std::bit_width`, `bit_floor`, `bit_ceil` | derived | `bit_ceil` on a value that would overflow is UB |
| `std::rotl` / `std::rotr` | `ROL` / `ROR` | Hand-written `(x<<k)|(x>>(32-k))` is **UB when k==0** (shift by width); the standard function is not |
| `std::has_single_bit` | — | Power-of-two test, correctly excluding zero |
| `std::byteswap` (C++23) | `BSWAP` / `REV` | Ch. 3 §3.9 |

The `rotl` point is the one that separates candidates: the classic hand-rolled rotate has undefined behaviour at a zero rotation and at width, and compilers *do* miscompile it. Use `std::rotl`.

### Subset enumeration

```cpp
// Enumerate all submasks of m, descending, in O(2^popcount(m)) total.
for (int s = m; s; s = (s - 1) & m) { /* use s */ }
// (plus s == 0 separately)
```
Summed over all m in [0,2ⁿ), this is exactly 3ⁿ iterations — the standard bound for subset-sum-over-subsets DP.

Gray code (`i ^ (i >> 1)`) enumerates subsets changing one bit at a time, which matters when the incremental update is cheaper than recomputation.

### BMI/BMI2 and low-latency uses

`BLSI`, `BLSR`, `BEXTR`, and especially `PDEP`/`PEXT` (parallel deposit/extract) implement bit gather/scatter in one instruction — used for chess move generation, sparse-index compaction, and packed protocol field extraction. Caveat: `PDEP`/`PEXT` are microcoded and **catastrophically slow on AMD Zen 1–2** (~18–300 cycles vs 3 on Intel), so portable code must not assume they are fast.

Practical bit uses in trading systems: bitmask sets of subscribed instruments (`uint64_t` per 64 symbols, intersect with one `AND`); free-list allocators using `countr_zero` on an availability bitmap to find a free slot in ~2 instructions (Ch. 7); flags packed into the low bits of an aligned pointer (Ch. 3 §3.10 — low bits only, never high bits, because of ARM TBI/MTE); and branchless min/max/abs/sign via `x >> 31` arithmetic-shift masks (though `cmov` from a plain ternary is usually as good and far more readable).

**Traps:** shifting by ≥ the operand width is UB; shifting a signed negative left is UB before C++20 (well-defined from C++20, which mandates two's complement); `1 << 31` on `int` overflows — write `1u << 31` or `UINT64_C(1) << 63`; and integer promotion turns `uint8_t << 8` into an `int` operation (Ch. 2 §2.2).

---

## 22.12 Monotonic Stacks and Queues

A **monotonic stack** maintains its elements in sorted (increasing or decreasing) order by popping violators on push. Each element is pushed once and popped at most once, so a loop with an inner `while` pop is **amortized O(1) per element, O(n) total** — the amortization argument (Ch. 23 §23.3) is the point of the technique and the thing to state.

### Next-greater-element

```cpp
// For each i, index of the next element strictly greater than a[i], or n.
std::vector<int> next_greater(std::span<const int> a) {
    std::vector<int> res(a.size(), int(a.size()));
    std::vector<int> st;  st.reserve(a.size());     // indices, values decreasing
    for (int i = 0; i < int(a.size()); ++i) {
        while (!st.empty() && a[st.back()] < a[i]) { res[st.back()] = i; st.pop_back(); }
        st.push_back(i);
    }
    return res;
}
```
Invariant: the stack holds indices whose "next greater" is not yet known, in decreasing value order. When `a[i]` arrives it resolves exactly those elements it exceeds. Strict vs non-strict comparison (`<` vs `<=`) decides how ties are handled — get it wrong and duplicates break the answer.

This single pattern solves: next/previous greater/smaller (four variants), **largest rectangle in a histogram** (O(n)), maximal rectangle in a binary matrix (histogram per row), trapping rain water, stock span, and "sum of subarray minimums" (count, for each element, the subarrays in which it is the minimum — via previous-smaller and next-smaller boundaries).

### Monotonic deque — sliding-window maximum

The queue variant supports removal at both ends and solves sliding-window max/min in O(n), which a heap cannot do without lazy deletion.

```cpp
std::deque<int> dq;                              // indices, values decreasing
for (int i = 0; i < n; ++i) {
    while (!dq.empty() && dq.front() <= i - k) dq.pop_front();   // expire
    while (!dq.empty() && a[dq.back()] <= a[i]) dq.pop_back();   // dominated
    dq.push_back(i);
    if (i >= k - 1) out.push_back(a[dq.front()]);
}
```
The back-popping is justified because an element that is both older and smaller than the incoming one can never again be the window maximum — it is dominated. This is the correct answer to "maximum in a sliding window in O(n)", and the heap-with-lazy-deletion answer (O(n log n)) is the acceptable second-best.

### Low-latency angle

Use `std::vector` as the stack, not `std::stack<std::deque>` — `std::stack`'s default container is `std::deque`, which allocates in chunks and indirects through a map of blocks (Ch. 11 §11.4). `std::vector` with `reserve(n)` is contiguous, allocation-free after the reserve, and the push/pop pattern keeps the top in L1.

For the deque, prefer a **fixed-capacity ring buffer** of size k over `std::deque`: the window bounds the size exactly, so the allocation is one-time and the indices mask with `& (k-1)`. This is the shape used in production for rolling max/min over market data.

Store **indices, not values**, when you need positions or expiry — and note that storing indices also keeps elements small (4 bytes) so more of the stack fits per cache line.

---

## 22.13 Prefix Sums

A **prefix sum** (cumulative sum, scan) array `P[i] = a[0] + … + a[i-1]` with `P[0] = 0` answers any range-sum query in O(1): `sum(l, r) = P[r] - P[l]` for half-open `[l, r)`. Build is O(n); the trade is O(n) extra space and invalidation on any update.

Using the **half-open convention with a leading zero** eliminates every off-by-one; the `[l, r]` inclusive form (`P[r] - P[l-1]`) needs a special case at `l == 0` and is where bugs live.

```cpp
std::vector<long long> P(a.size() + 1, 0);
std::inclusive_scan(a.begin(), a.end(), P.begin() + 1);   // C++17; or std::partial_sum
// exclusive_scan writes P[0]=init and shifts — pick one convention and hold it
```

### The pattern family

| Structure | Query | Update | Use |
|---|---|---|---|
| Prefix sum array | O(1) | O(n) rebuild | Static data |
| **Difference array** | O(n) to materialize | **O(1) range add** | Many range updates, one final read |
| Fenwick tree (Ch. 21) | O(log n) | O(log n) point | Mixed updates and queries |
| Segment tree (Ch. 21) | O(log n) | O(log n), lazy range | Arbitrary associative op, range updates |

The **difference array** is the dual and is under-known: to add `v` to `[l, r)`, do `d[l] += v; d[r] -= v;` in O(1), then a single prefix scan materializes the result. The classic use is "N range-increment operations then read the array" in O(N + n) instead of O(N·n) — sweep-line problems (§22.14) are exactly this.

Prefix sums generalize to any **associative** operation with an inverse (XOR prefix, product with care for zeros, prefix min *without* an inverse — which is why prefix-min supports only prefix queries, not arbitrary ranges; arbitrary-range min needs a sparse table or segment tree).

### Multi-dimensional

2-D prefix sums use inclusion–exclusion:
```
P[i][j] = a[i][j] + P[i-1][j] + P[i][j-1] - P[i-1][j-1];
rect(r1,c1,r2,c2) = P[r2][c2] - P[r1-1][c2] - P[r2][c1-1] + P[r1-1][c1-1];
```
The four-term query with two subtractions and one add-back is the thing to remember.

### Correctness and latency

- **Overflow.** Prefix sums of `int32_t` over a large array overflow silently. Accumulate in `int64_t`, or `__int128` for 64-bit inputs. This is the most common bug in the technique.
- **Floating point.** A prefix sum over `double` accumulates O(n) rounding error and, worse, `P[r] - P[l]` **catastrophically cancels** when the two prefixes are large and close: a range sum of small values computed from huge prefixes can have no correct digits. For financial data, accumulate in fixed-point integers or use Kahan/pairwise summation (Ch. 23 §23.9, §23.10). This is the single best "why did my PnL not tie out" answer.
- **Vectorization.** A serial prefix sum is a loop-carried dependency chain (one add of 4-cycle latency per element ≈ 4 cycles/element). `std::inclusive_scan` with `std::execution::par_unseq`, or a manual SIMD log-shift scan (Hillis–Steele), or simply splitting into chunks with per-chunk offsets, breaks the chain. Compilers do not auto-vectorize scans.
- **Cache.** Building the prefix array doubles the memory traffic of a single pass. If the query count is small, a direct loop is faster than building the array — the crossover is roughly (queries > n / range_length).

---

## 22.14 Sweep-Line Algorithms

A **sweep line** processes geometric or interval data by moving a conceptual line across one axis, maintaining a data structure of the objects currently intersecting it, and handling a sorted list of **events** where that set changes. Sorting the events is the O(n log n); the per-event work is what varies.

The universal shape:

```cpp
struct Event { int64_t x; int delta; };          // +1 at start, -1 at end
std::vector<Event> ev;
for (auto& [s, e] : intervals) { ev.push_back({s, +1}); ev.push_back({e, -1}); }
std::ranges::sort(ev, {}, &Event::x);            // ties: see below
int active = 0, best = 0;
for (auto& [x, d] : ev) { active += d; best = std::max(best, active); }
```
This computes maximum overlap (minimum meeting rooms, peak concurrent connections, peak order-book depth at a price) in O(n log n) time and O(n) space.

**Tie-breaking at equal coordinates is the whole correctness question.** If intervals are half-open `[s, e)`, ends must be processed before starts at the same coordinate; if closed `[s, e]`, starts first. Sorting by `(x, delta)` with `delta = -1 < +1` achieves the half-open convention. Nearly every wrong answer to "minimum meeting rooms" comes from this.

### The variants

| Problem | Sweep structure | Complexity |
|---|---|---|
| Max overlap / min rooms | Counter | O(n log n) |
| Union of interval lengths | Sorted merge, track coverage | O(n log n) |
| Rectangle union area (Klee) | Segment tree with coverage counts over y | O(n log n) |
| Closest pair of points | `std::set` of active points by y, ±d strip | O(n log n) |
| Line-segment intersection (Bentley–Ottmann) | Balanced BST ordered by y at the sweep | O((n+k) log n) |
| Skyline problem | Multiset of active heights | O(n log n) |

The active-set structure must support insert, erase, and an order query — hence `std::set` / `std::multiset` in the general case, or a counter when only the cardinality matters. Bentley–Ottmann additionally inserts *future* events (intersections) discovered during the sweep, which is why its event queue is a priority queue rather than a presorted vector.

### Low-latency angle

When all events are known up front — the common case — **presort into a `std::vector` and iterate**, never a `std::priority_queue`. The vector version is a single sequential pass with perfect prefetching; the heap version does O(n log n) random-access sift operations with poor locality. Only when events are generated during the sweep is a heap necessary.

Coordinate compression (mapping the O(n) distinct coordinates to `[0, m)` via sort + `unique` + `lower_bound`) is the standard companion, letting a segment tree or difference array be indexed densely instead of over the full coordinate range.

For **market-data book aggregation**, the sweep-line-over-events framing is the natural model: order add/cancel/execute events sorted by sequence number, with the "active set" being the price-level structure. The insight that carries over is that a presorted event vector plus a flat active structure beats a general-purpose priority queue, which matters when the sweep is on the critical path.

---

## 22.15 Interval Algorithms

Intervals recur constantly and the variants are easy to confuse. Fix a convention first: **half-open `[s, e)`** is strongly preferred — it makes adjacency (`a.e == b.s`) unambiguous, makes lengths `e - s` without a `+1`, and composes under splitting.

**Overlap test.** Two intervals `[a1,a2)` and `[b1,b2)` overlap iff `a1 < b2 && b1 < a2`. Memorize this form; the negation-of-disjoint derivation (`!(a2 <= b1 || b2 <= a1)`) is where sign errors happen. For closed intervals the comparisons become `<=`.

### The four canonical problems

| Problem | Sort by | Method |
|---|---|---|
| **Merge overlapping** | start | Scan; extend current end to `max(end, next.end)` if `next.start <= end`, else emit |
| **Insert into sorted non-overlapping** | — | Three phases: copy strictly-before, absorb overlapping via min/max, copy strictly-after |
| **Max non-overlapping subset** | **end** | Greedy: take if `start >= last_end` (§22.10) |
| **Min rooms / max overlap** | events | Sweep line (§22.14) |

Note the sort key differs between merging (by start) and max-subset selection (by end). Sorting by the wrong key gives a plausible-looking wrong algorithm, which is exactly why it is asked.

```cpp
// Merge — O(n log n), dominated by the sort.
std::ranges::sort(iv, {}, &Interval::start);
std::vector<Interval> out;
for (const auto& x : iv)
    if (!out.empty() && x.start <= out.back().end) out.back().end = std::max(out.back().end, x.end);
    else out.push_back(x);
```

### Query structures

For repeated "which intervals contain point p" or "which overlap query range" against a static set:

| Structure | Build | Query | Notes |
|---|---|---|---|
| Sorted array + `lower_bound` | O(n log n) | O(log n + k) | Only for **non-overlapping** sets — then it is a partition and binary search suffices |
| **Interval tree** (augmented BST storing subtree max-end) | O(n log n) | O(log n + k) | General overlapping sets; the standard answer |
| Segment tree (Ch. 21) | O(n log n) | O(log n + k) | Better for stabbing queries over a fixed coordinate universe |
| Boost.ICL `interval_map` | — | — | Production-ready if you may take the dependency |

The augmentation trick in an interval tree — each node stores the maximum end in its subtree, allowing a whole subtree to be pruned when `max_end < query.start` — is the mechanism worth being able to describe.

### Low-latency angle

For a **small** interval set (tens), a flat sorted `std::vector` with a linear scan beats every tree: no pointer chasing, one or two cache lines, and a fully predictable loop. The tree structures pay off in the thousands. This is the same crossover as §22.3 and it recurs throughout Ch. 21.

Production uses: trading-session calendars and halt windows (query "is this instrument tradeable at time t"), rate-limit and throttle windows (Ch. 54), IP/CIDR range matching for entitlements, and time-bucketing of market-data snapshots. In all of them the interval set is small, static between reference-data updates, and queried millions of times — so build a sorted flat array at load time and binary-search or linearly scan it, and never allocate on the query path.

---

## 22.16 Breadth-First and Depth-First Search

Both traverse a graph in O(V + E) with an adjacency list. They differ only in the frontier container — queue vs stack — and that difference determines what they can compute.

| | BFS | DFS |
|---|---|---|
| Frontier | FIFO queue | LIFO stack (or recursion) |
| Order | By distance from source | By depth |
| Memory | O(width) — can be huge | O(depth) |
| Gives | **Shortest path in unweighted graphs** | Topological order, cycle detection, SCCs, bridges/articulation points |
| Failure mode | Frontier blowup on wide graphs | Stack overflow on deep graphs |

```cpp
// BFS: dist[] doubles as the visited marker; mark on ENQUEUE, not on dequeue.
std::vector<int> dist(n, -1);
std::deque<int> q;  dist[s] = 0;  q.push_back(s);
while (!q.empty()) {
    int u = q.front(); q.pop_front();
    for (int v : adj[u]) if (dist[v] < 0) { dist[v] = dist[u] + 1; q.push_back(v); }
}
```
**Mark on enqueue.** Marking on dequeue admits a node into the queue multiple times, turning O(V+E) into O(E) duplicate work and, in dense graphs, memory blowup. This is the single most common BFS bug.

### DFS colouring and what it detects

Three-colour DFS (white = unvisited, grey = on the current recursion stack, black = finished) is what enables cycle detection: **a back edge to a grey node is a cycle** in a directed graph. Using a plain boolean `visited` detects cross edges as false cycles. In an *undirected* graph, cycle detection instead means "an edge to a visited node that is not the parent" (with care for parallel edges).

DFS classifies edges as tree / back / forward / cross, and the finish-time ordering is the basis of Tarjan's SCC algorithm and of topological sort (§22.17).

### Variants worth naming

- **Multi-source BFS** — seed the queue with all sources at distance 0. Computes the distance to the *nearest* source in one pass, not k passes. (Rotting oranges, nearest-exit, flood distance.)
- **0-1 BFS** — edges of weight 0 or 1: use a deque, `push_front` for weight-0 edges and `push_back` for weight-1. O(V+E), beating Dijkstra's log factor.
- **Bidirectional BFS** — search from both ends; b^(d/2)·2 instead of b^d. Requires a known target and reversible edges.
- **Iterative deepening DFS** — DFS memory with BFS optimality; the repeated work is a constant factor because the last level dominates.

### Low-latency angle

Graph traversal is **latency-bound on pointer chasing**, not compute-bound. The fixes are structural:

- **CSR (compressed sparse row)** adjacency: two flat arrays (`offsets[V+1]`, `targets[E]`) instead of `vector<vector<int>>`. One allocation, sequential neighbour access, no per-node indirection. This is the single largest win — often 3–5×.
- **Bitset visited array** instead of `vector<bool>`-of-bytes or a hash set — 8× the density means the visited set stays in cache for graphs up to millions of nodes.
- **`std::vector` as the queue with head/tail indices**, not `std::deque` or `std::queue` — contiguous, one allocation, prefetchable.
- **Direction-optimizing BFS** (bottom-up when the frontier is large: have unvisited nodes scan for a visited parent, stopping at the first) turns the dominant cost from E edge-reads to far fewer, on high-degree graphs.
- Software-prefetch the next frontier node's adjacency while processing the current one (Ch. 28).

---

## 22.17 Shortest Paths

Choosing the right algorithm is entirely a function of the edge weights and the query pattern.

| Algorithm | Weights | Complexity | Notes |
|---|---|---|---|
| BFS | Unweighted (all equal) | O(V+E) | Always use this when applicable |
| 0-1 BFS (deque) | {0, 1} | O(V+E) | No priority queue needed |
| **Dijkstra** (binary heap) | **Non-negative** | O((V+E) log V) | The default |
| Dijkstra (Fibonacci heap) | Non-negative | O(E + V log V) | Theoretically better, practically slower — constants |
| **Bellman–Ford** | Any, detects negative cycles | O(V·E) | V−1 relaxation rounds; a V-th improvement ⇒ negative cycle |
| SPFA | Any | O(V·E) worst | Queue-based Bellman–Ford; fast in practice, adversarially O(VE) |
| **Floyd–Warshall** | Any (no negative cycles) | O(V³), O(V²) space | All-pairs; trivial 3-loop; practical to V ≈ 500 |
| Johnson | Any | O(V·E + V² log V) | All-pairs on sparse graphs; reweight via Bellman–Ford, then V Dijkstras |
| A* | Non-negative + admissible heuristic | ≤ Dijkstra | Dijkstra with `f = g + h`; optimal iff h is admissible and consistent |

**Why Dijkstra requires non-negative weights:** its correctness rests on the claim that when a node is popped with the minimum tentative distance, that distance is final. A negative edge could later reduce it, invalidating the settled set. The exchange argument fails, and the algorithm silently returns wrong answers — it does not loop or crash.

### Implementation details that get asked

```cpp
// Lazy-deletion Dijkstra: the idiomatic C++ form, since std::priority_queue
// has no decrease-key.
using P = std::pair<int64_t,int>;                       // (dist, node)
std::priority_queue<P, std::vector<P>, std::greater<>> pq;
std::vector<int64_t> dist(n, INF);
dist[s] = 0; pq.push({0, s});
while (!pq.empty()) {
    auto [d, u] = pq.top(); pq.pop();
    if (d > dist[u]) continue;                          // stale entry — skip
    for (auto [v, w] : adj[u])
        if (d + w < dist[v]) { dist[v] = d + w; pq.push({dist[v], v}); }
}
```
The stale-entry skip is mandatory: without decrease-key, the heap accumulates up to E entries, and processing a stale one re-relaxes edges from an outdated distance. The heap therefore holds O(E) not O(V) entries — which is why the complexity is O(E log E) = O(E log V), identical either way.

`INF` must be chosen so that `INF + w` does not overflow — use `INT64_MAX/2` or check before adding. Silent overflow producing a negative distance is a classic bug (Ch. 23 §23.12).

### Low-latency and production angle

- **Precompute when the graph is static.** For routing across a fixed set of venues or a fixed instrument graph, precompute all-pairs at startup and make the hot path an O(1) table lookup.
- **The heap is the bottleneck.** A 4-ary heap has better cache behaviour than a binary heap (fewer levels, siblings on one line). For small integer weights, a **bucket queue / Dial's algorithm** replaces the heap with an array of buckets indexed by distance: O(V·C + E), fully cache-friendly, no comparisons.
- **A\* with a consistent heuristic** never re-expands a node and is the practical answer for large spatial graphs; an *inadmissible* heuristic gives fast but non-optimal answers, which is often the right production trade.

---

## 22.18 Topological Sorting

A **topological order** of a DAG is a linear ordering in which every edge `u → v` places `u` before `v`. It exists **iff the graph is acyclic**, and it is generally not unique.

### Two algorithms

**Kahn's (BFS, indegree-based)** — repeatedly emit a node with indegree 0 and decrement its successors'.

```cpp
std::vector<int> indeg(n, 0);
for (int u = 0; u < n; ++u) for (int v : adj[u]) ++indeg[v];
std::vector<int> q, order;                       // vector as queue: contiguous
for (int u = 0; u < n; ++u) if (!indeg[u]) q.push_back(u);
for (size_t i = 0; i < q.size(); ++i) {          // q grows as we go
    int u = q[i]; order.push_back(u);
    for (int v : adj[u]) if (--indeg[v] == 0) q.push_back(v);
}
if (order.size() != size_t(n)) { /* CYCLE — the remaining nodes are in cycles */ }
```
The size check is the **cycle detector**, and it comes free. Substituting a `priority_queue` for the queue yields the lexicographically smallest topological order (O(V log V + E)).

**DFS-based** — push each node onto an output list on *finish* (post-order), then reverse. Detect cycles with the grey-node rule (§22.16). More concise, but recursive and thus depth-limited; the iterative version needs an explicit state machine to know when a node's children are exhausted.

| | Kahn | DFS |
|---|---|---|
| Cycle detection | Emitted count < V | Back edge to grey node |
| Order control | Any queue discipline (min-heap ⇒ lexicographic) | Fixed by DFS order |
| Recursion | None | Yes (stack-overflow risk) |
| Incremental | Naturally supports streaming ready-nodes | No |

### Applications

Build systems and `make`/Ninja dependency graphs (Ch. 1); C++ static initialization order across TUs — *unordered* precisely because there is no cross-TU topological sort, which is the static initialization order fiasco (Ch. 5 §5.10); task/DAG schedulers; instruction scheduling; spreadsheet recalculation; and **longest path in a DAG**, which is linear-time via DP over the topological order (and NP-hard in general graphs — a good contrast to have ready).

DP over a topological order is the general statement of §22.9's "DP on DAGs": process nodes in topological order and every state's dependencies are already computed. Shortest *and* longest paths in a DAG are both O(V+E) this way, with no need for Dijkstra and no restriction on edge signs.

### Low-latency angle

In a trading system the concrete use is **startup dependency ordering** (Ch. 60): components declare dependencies, Kahn's algorithm produces the init order, and the count check turns a dependency cycle into a startup-time error instead of a deadlock or a null dereference at 09:29:59. Doing the sort once at startup and storing the resulting flat order keeps the hot path free of graph structure entirely — the general pattern of moving graph work out of the critical path.

---

## 22.19 Finite-State Machines

A **finite-state machine** is a tuple (states, alphabet, transition function, start state, accepting states). It is the right model whenever behaviour depends on history that can be summarized in a bounded amount of state — protocol sessions, order lifecycles, lexers, and stream validators.

**DFA vs NFA:** a DFA has exactly one transition per (state, input); an NFA may have several or none, plus ε-transitions. Every NFA has an equivalent DFA (subset construction), potentially with exponentially more states. DFAs run in O(1) per input symbol, which is why regex engines that guarantee linear time (RE2, `std::regex` implementations that use a DFA) compile to DFAs, while backtracking engines (PCRE) are NFA simulators and are subject to **catastrophic backtracking** — a genuine production DoS vector.

**Moore vs Mealy:** a Moore machine's output depends only on the state; a Mealy machine's depends on state *and* input, so it can have fewer states but its output is tied to a transition. Order-lifecycle machines are usually modelled as Mealy (the side effect belongs to the transition), which matters for where you place logging and risk checks.

### Implementation choices in C++

| Style | Dispatch | Cost | When |
|---|---|---|---|
| `switch` on enum state | Jump table or branch chain | Predictable, inlines, no memory | Few states, complex per-state logic |
| **2-D transition table** `next[state][input]` | One indexed load | 1 load + 1 indirect branch | Many states, uniform actions (§22.20) |
| Function-pointer table | Indirect call | BTB pressure; no inlining | Actions differ wildly per state |
| `std::variant` + `std::visit` | Jump table | Type-safe states with per-state data; ~5–15 ns dispatch | Rich state payloads (Ch. 15 §15.4) |
| Virtual `State` classes | Vtable | Allocation per transition unless states are singletons | Rarely worth it on a hot path |

```cpp
enum class S : uint8_t { New, PendingNew, Live, PendingCancel, Filled, Cancelled, Rejected };
enum class E : uint8_t { Send, Ack, Fill, PartialFill, CancelReq, CancelAck, Reject };

// Explicit table makes illegal transitions detectable rather than merely unwritten.
constexpr S kNext[7][7] = { /* ... S::Invalid for illegal pairs ... */ };
S step(S s, E e) {
    S n = kNext[size_t(s)][size_t(e)];
    if (n == S::Invalid) [[unlikely]] on_protocol_violation(s, e);
    return n;
}
```

### Why the table form is the strong answer

A transition table makes the machine **data, not control flow**: it is exhaustively checkable (assert every cell is reachable and every illegal pair is marked), testable by enumeration, `constexpr`-constructible so it lands in `.rodata`, and — for a 7×7 table of `uint8_t` — a single cache line. The `switch` form scatters the same information across code and lets an unhandled pair fall through silently.

**Low-latency notes.** The table lookup is one L1 hit (~4 cycles) plus a well-predicted branch, versus a `switch`'s indirect jump whose BTB entry is polluted by mixed traffic. For order-entry state machines (Ch. 50, Ch. 54) the machine must also be **idempotent under duplicates and tolerant of reordering**: exchanges deliver duplicate execution reports and late acknowledgements, so transitions must be keyed on sequence numbers and self-loops on already-applied events must be explicit states in the table, not accidental fall-throughs. Encoding "receive a fill for an order already in Cancelled" as an explicit, benign table entry is exactly the kind of detail that distinguishes production experience.

---

## 22.20 Table-Driven Parsing

**Table-driven parsing** replaces hand-written conditional logic with lookups into precomputed tables. The technique is the natural continuation of §22.19 and the dominant one for wire-protocol decoding on a hot path.

### The levels

**1. Character classification.** Replace `if (c >= '0' && c <= '9' || c == '.' || …)` with a 256-entry `uint8_t` class table. One L1 load replaces a chain of unpredictable branches, and the table is a quarter of a cache line's worth of lines (4 lines) that stay resident.

```cpp
constexpr std::array<uint8_t,256> kClass = make_class_table();   // constexpr, in .rodata
enum : uint8_t { Digit=1, Alpha=2, Space=4, Delim=8 };
while (kClass[uint8_t(*p)] & Digit) ++p;      // no branch chain, one load per char
```

**2. DFA transition tables.** `state = table[state][kClass[c]]` — a two-level lookup collapsing the 256-wide alphabet into a handful of classes, which shrinks the table from `states×256` to `states×classes` and usually into L1. This is exactly how flex-generated lexers, `ragel`, and high-performance HTTP/JSON parsers work.

**3. Dispatch tables for message types.** A binary protocol's one-byte message type indexes a table of handlers, offsets, or lengths.

```cpp
struct MsgSpec { uint16_t len; void (*parse)(const std::byte*, Book&); };
constexpr MsgSpec kSpec[256] = { /* ITCH: 'A' add, 'D' delete, 'E' execute, ... */ };
const auto& spec = kSpec[uint8_t(buf[0])];
if (spec.len == 0) [[unlikely]] return reject();       // unknown type — validated, not assumed
spec.parse(buf, book);
```

**4. LR/LALR parse tables.** ACTION/GOTO tables from `bison`/`yacc`. Relevant to interviews mostly as vocabulary — real trading protocols are fixed-layout binary and never need a context-free parser. Recursive descent (a hand-written LL parser) is the pragmatic alternative and is easier to produce good error messages from, at the cost of the depth limit noted in §22.7.

### Why it wins, precisely

A branch chain costs one predicted branch per test (~1 cycle) and ~15–20 cycles per mispredict; on adversarial or high-entropy input the mispredict rate approaches 50% and the chain dominates. A table lookup costs one L1 load (4–5 cycles), *always*, with no data-dependent control flow — the classic latency-versus-variance trade. Tables win when the input is unpredictable and lose when one branch is taken 99% of the time (where the predictor is essentially free and the load is not).

The other advantages: the table is `constexpr`-generated so there is no startup cost and it lives in a read-only page shared across processes; it is exhaustively testable; and adding a message type is a data change, not a control-flow change.

### Traps

- **Table size vs cache.** A `states × 256` table of `uint32_t` for 100 states is 100 KB — it will not stay in L1 and each miss costs more than the branches saved. Compress the alphabet into classes first.
- **`char` is signed** on x86: `table[c]` with a negative `char` indexes out of bounds. Always `uint8_t(c)`. This is a real, exploitable bug and a favourite reviewer catch.
- **Untrusted length and count fields.** A table-driven binary parser must validate the declared length against the remaining buffer *before* advancing (Ch. 51). Table lookups on unvalidated input are how a length field of `0xFFFF` becomes an out-of-bounds read.
- **Indirect calls in the dispatch table** cost a BTB entry and block inlining. When there are few message types and one dominates the traffic, a `switch` with the hot type first — or a `[[likely]]`-annotated early check for it — beats a uniform function-pointer table. In market-data feeds, add/execute/cancel are ~99% of messages; specializing them and table-dispatching the tail is the production pattern.

---

## Key Interview Questions

1. **What precondition makes the converging two-pointer technique valid, and what happens if it is violated?** — Monotonicity (usually sortedness), so that advancing a pointer provably eliminates candidates; violated, it silently returns wrong answers rather than failing.
2. **When does a sliding window fail?** — When the predicate is not monotone in the window (e.g. negative numbers with a sum bound), or when the aggregate is not invertible (max/min need a monotonic deque, not subtraction).
3. **Why `mid = lo + (hi-lo)/2`?** — Avoids signed overflow of `lo+hi`; the JDK carried that bug for nine years.
4. **State binary search as a loop invariant.** — The answer is always in `[lo, hi]`; each iteration strictly shrinks the interval; at exit `lo == hi` is the partition point.
5. **Why is `std::lower_bound` on a `std::list` a bad idea?** — O(log n) comparisons but O(n) iterator advances; binary search needs random access to be O(log n).
6. **Why is binary search slow in wall-clock terms, and what beats it?** — ~50/50 unpredictable branches plus a serialized dependent-miss chain; branchless `cmov` search, Eytzinger layout, a hash table, or for n ≲ 64 a linear SIMD scan.
7. **What is "binary search on the answer" and what must you prove?** — Searching the answer space via a decision predicate; you must prove the predicate is monotone in the searched parameter.
8. **Which sorts are stable, and when does it matter?** — Insertion, merge, radix, `std::stable_sort`; it matters for multi-key sorting and any semantically meaningful tie order. `std::sort` is not stable.
9. **How does `std::sort` avoid quicksort's O(n²)?** — Introsort: it switches to heapsort past depth 2·log n and to insertion sort below ~16 elements.
10. **How can a sort beat Ω(n log n)?** — The bound applies only to comparison sorts; radix/counting sort use key structure, O(n·k/b).
11. **Top-k from a stream of a billion elements?** — Bounded size-k min-heap, one pass, O(k) space; expected heap operations are O(k log n), not O(n log k).
12. **What does the "undo" step in backtracking buy you?** — O(depth) working state instead of O(nodes); forgetting it is the canonical bug.
13. **Divide and conquer vs dynamic programming?** — Both split into subproblems; DP is required when subproblems *overlap*, which makes naive recursion exponential.
14. **How do you state a DP's complexity?** — States × transition cost.
15. **Why does 0/1 knapsack iterate capacity downward?** — So each item is used at most once; upward iteration lets an item be reused, which is unbounded knapsack.
16. **When is greedy provably correct?** — When there is an exchange argument for the greedy-choice property, or matroid structure. Otherwise it is a heuristic — cite {1,3,4} coins making 6.
17. **Why use `std::rotl` instead of `(x<<k)|(x>>(32-k))`?** — The hand-written form is UB at k == 0 and k == width.
18. **Prove that a monotonic stack loop is O(n) despite the inner `while`.** — Each element is pushed once and popped at most once; total pops ≤ total pushes = n.
19. **Sliding-window maximum in O(n)?** — Monotonic deque of indices with decreasing values, expiring the front and popping dominated elements from the back.
20. **What are the two hazards in prefix sums over financial data?** — Integer overflow of the accumulator, and catastrophic cancellation in `P[r]-P[l]` for floating point (Ch. 23 §23.7).
21. **What is the tie-breaking rule in a sweep line and why does it matter?** — For half-open intervals, ends before starts at equal coordinates; getting it backwards is the standard "minimum meeting rooms" bug.
22. **Merge intervals sorts by start; max non-overlapping subset sorts by end. Why?** — Merging needs adjacency in position; the greedy exchange argument for selection requires the earliest-finishing choice.
23. **Why must BFS mark visited on enqueue, not dequeue?** — Otherwise a node can be enqueued many times, inflating work and memory.
24. **Why does Dijkstra require non-negative weights?** — Its correctness assumes a popped minimum is final; a negative edge could later improve it, and the algorithm returns a wrong answer silently.
25. **Why does the standard C++ Dijkstra skip stale heap entries?** — `std::priority_queue` has no decrease-key, so obsolete (dist, node) pairs remain; skipping when `d > dist[u]` is required for correctness and keeps it O(E log V).
26. **How does Kahn's algorithm detect a cycle for free?** — Fewer than V nodes emitted means the remainder have nonzero indegree, i.e. lie on cycles.
27. **When does a table-driven parser lose to a branch chain?** — When one branch is highly predictable (predictor ≈ free) or the table exceeds L1; tables win on unpredictable input by trading latency for variance.

---

## Common Traps

- **Converging two pointers on unsorted input** — silent wrong answer, no crash.
- **Sliding window with negative values** — the predicate is no longer monotone; the window is invalid.
- **Trying to maintain a window max by "removing" the outgoing element** — max is not invertible; use a monotonic deque.
- **Incremental floating-point rolling sums** — unbounded drift; recompute periodically or use fixed point.
- **`lo + hi` in binary search** — overflow.
- **Binary search with an off-by-one in `hi = mid` vs `hi = mid - 1`** — pair the update with the right loop condition (`lo < hi` with `hi = mid`) and never mix conventions.
- **Binary search on a non-monotone predicate** — including "sorted by a different key than you are searching".
- **Assuming `std::sort` is stable.** It is not.
- **`std::stable_sort` silently degrading** to O(n log² n) when its temporary allocation fails.
- **`std::nth_element` reordering your input** and giving no guarantee about elements past position k.
- **Averaging per-thread p99s.** Quantiles do not average; merge histograms.
- **Forgetting the undo in backtracking**, or undoing a step that was skipped.
- **Unbounded recursion depth on untrusted input** — stack overflow is a `SIGSEGV`, not an exception; no destructors run.
- **Relying on tail-call optimization** — C++ does not guarantee it, and a local with a destructor disables it.
- **Applying divide and conquer to overlapping subproblems** — exponential; that is DP's domain.
- **0/1 knapsack with an upward capacity loop** — becomes unbounded knapsack.
- **Greedy without an exchange argument** — coin change with {1,3,4} is the counterexample.
- **Activity selection sorted by start time or duration** — only earliest-finish is correct.
- **`(x << k) | (x >> (32-k))`** — UB at k == 0.
- **`1 << 31` on `int`** — signed overflow; use `1u`/`UINT64_C(1)`.
- **`BSR`/`BSF` on zero** — undefined; `std::countl_zero`/`countr_zero` are not.
- **`table[c]` with a signed `char`** — negative index, out-of-bounds read.
- **`std::stack`'s default `std::deque` container** on a hot path — use `std::vector`.
- **Prefix sums accumulated in the element type** — overflow for integers, catastrophic cancellation for floats.
- **Sweep-line tie-breaking at equal coordinates** — decides whether touching intervals overlap.
- **Using a `priority_queue` for a sweep whose events are all known in advance** — presorted vector is strictly better.
- **BFS marking visited on dequeue.**
- **Plain boolean `visited` for directed cycle detection** — you need the three-colour (grey = on-stack) distinction.
- **`INF + w` overflowing** in Dijkstra/Bellman–Ford relaxation.
- **Dijkstra on graphs with negative edges** — no error, just wrong distances.
- **A parse table indexed by an unvalidated length or type field.**

---

## Compact Recall Summary

**Two pointers and windows.** Both rest on a monotonicity invariant that lets an index advance without backtracking, giving O(n). Converging form needs sortedness; sliding form needs a monotone predicate *and* an incrementally maintainable aggregate. Non-invertible aggregates (max/min) need a monotonic deque; sums over floats need Kahan or fixed point. Floyd's tortoise-and-hare gives O(1)-space cycle detection.

**Binary search.** Really `partition_point` over a monotone predicate. Write it as an invariant (`answer ∈ [lo,hi]`), use `lo+(hi-lo)/2`, and pair `lo<hi` with `hi=mid` / `lo=mid+1`. `lower_bound`/`upper_bound`/`equal_range`/`partition_point`; ForwardIterator-capable but O(n) advances on lists. Wall-clock cost is mispredicts plus a serialized miss chain — beat it with branchless `cmov`, Eytzinger layout, a hash table, or a linear SIMD scan below ~64 elements. **Binary search on the answer** converts optimization into O(log range) decision problems; the obligation is proving the feasibility predicate monotone. Real-valued: fixed iteration count, or `bit_cast` to integers.

**Sorting and selection.** Comparison sorts are Ω(n log n) (decision-tree argument); radix/counting escape via key structure. `std::sort` = introsort (quicksort + heapsort at depth 2 log n + insertion below 16), unstable, hard O(n log n). `std::stable_sort` allocates and degrades to O(n log² n) if it cannot. Sorting is memory-bound above L2 — mergesort streams, heapsort thrashes. Selection: `nth_element` (introselect, O(n) average, 2n series), `partial_sort` O(n log k), bounded min-heap for streams. Histograms, not sorts, for percentiles.

**Recursion, D&C, DP, greedy.** Backtracking = DFS over partial solutions with pruning and an explicit undo; guard depth on untrusted input, since overflow is a `SIGSEGV`. Master theorem: leaves / even / root. Recursive subdivision is cache-oblivious for free; grain-size cutoffs and tuned base cases carry the constants. DP needs optimal substructure **and overlapping subproblems**; complexity = states × transition; derive top-down, tabulate if hot, roll the array to fit L1, and use bitset words for 64-state-per-instruction transitions. Greedy requires an exchange argument or matroid structure — earliest-finish for activity selection, ratio for fractional knapsack, and a counterexample ({1,3,4} → 6) for anything unproved.

**Bits.** `x&(x-1)` clears the low bit, `x&-x` isolates it, `x&(n-1)` is `%` for powers of two. Use `<bit>`: `popcount`, `countl_zero`/`countr_zero` (defined at zero, unlike `BSR`/`BSF`), `rotl` (the hand-rolled form is UB at 0), `bit_width`, `has_single_bit`. Submask enumeration `s=(s-1)&m` totals 3ⁿ. `PDEP`/`PEXT` are one instruction on Intel and microcoded disaster on Zen 1–2.

**Monotonic structures and prefix sums.** A monotonic stack is amortized O(n) because each element is pushed and popped once — next-greater, histogram rectangle, subarray-minimum counting. The deque variant gives O(n) sliding max. Use `std::vector`/a fixed ring, never `std::stack`'s deque. Prefix sums give O(1) range queries in half-open convention with a leading zero; the **difference array** is the dual for O(1) range updates; Fenwick/segment trees cover the mixed case. Watch overflow and cancellation; scans are a loop-carried dependency and do not auto-vectorize.

**Sweeps and intervals.** Sort events, maintain an active set, and get the tie-break right (half-open ⇒ ends before starts). Presorted vector beats a heap when all events are known. Overlap is `a1 < b2 && b1 < a2`. Merge sorts by start; max non-overlapping subset sorts by end; min rooms is a sweep. Interval trees augment a BST with subtree max-end; for small static sets a flat sorted vector with a linear scan wins.

**Graphs.** BFS/DFS are O(V+E) and differ only in frontier discipline: queue ⇒ unweighted shortest paths, stack ⇒ topological order, cycles, SCCs. Mark on enqueue; use three-colour DFS for directed cycles. CSR adjacency, bitset visited, and a vector-as-queue are the performance essentials. Shortest paths: BFS (unweighted) → 0-1 BFS (deque) → Dijkstra (non-negative, lazy-deletion heap, skip stale entries) → Bellman–Ford (negative edges, V−1 rounds, V-th detects a negative cycle) → Floyd–Warshall (all-pairs, V³). Topological sort by Kahn (count check detects cycles free) or reverse DFS post-order; DP over a topological order solves longest path in a DAG in linear time.

**State machines and tables.** FSMs summarize unbounded history in bounded state; DFA is O(1) per symbol, NFA backtracking is a DoS risk. Prefer an explicit `constexpr` transition table over a `switch`: it is data, exhaustively checkable, `.rodata`-resident, and one cache line for small machines. Table-driven parsing replaces unpredictable branch chains with a fixed-latency L1 load — compress the alphabet into classes so the table stays in L1, index with `uint8_t` never `char`, validate untrusted lengths before advancing, and specialize the two or three dominant message types rather than dispatching everything indirectly.
