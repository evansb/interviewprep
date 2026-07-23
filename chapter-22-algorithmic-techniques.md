# Chapter 22 — Algorithmic Techniques

An algorithmic technique is a reusable correctness argument. The name is secondary: begin with a baseline, identify the fact that lets you discard work, state what remains true after every step, and count the operations and storage that the representation actually causes.

## Why this matters — Core

Screening problems and production design reviews both reward the same skill: deriving an algorithm from its preconditions and explaining why a plausible alternative fails. This chapter focuses on those derivations. Chapter 14 covers library algorithm interfaces; Chapter 21 covers container and graph representations.

## 90-second screen — Core
- Start with the simplest correct baseline. It supplies an oracle for small randomized tests and exposes the repeated work that an improved algorithm must remove.
- Every technique's justification has the same shape: an **invariant** plus a **progress measure** that together prove termination with the right answer.
- Two pointers/sliding window need monotonicity: a pointer only ever moves one direction because the discarded region provably cannot hold the answer.
- Binary search needs a **monotone predicate** over the search space, not "sortedness" per se; `lo < hi` terminates on integers because `hi - lo` is a strictly decreasing non-negative integer — it does **not** terminate that way on `double`.
- DP requires optimal substructure *and* overlapping subproblems; state the complexity as states × transition cost.
- Greedy is correct only with a proof such as an exchange, staying-ahead, or cut argument; otherwise it is a heuristic.
- BFS gives shortest paths in unweighted graphs; DFS gives topological order and cycle detection; Dijkstra needs non-negative weights because "a popped minimum is final" assumes no later edge can reduce it.
- Optimize asymptotics first, then account for allocation, locality, branch predictability, and representation. Small inputs can reverse a theoretical ranking, so crossover claims require measurement.

---

## 22.0 Derivation Workflow and Baseline — Core

Before selecting a pattern, write the contract: valid inputs, requested output, tie rules, overflow policy, and whether input may be reordered. Then write the direct algorithm even if it is quadratic or exponential. A brute-force pair search, subset enumeration, or path enumeration has two uses: it reveals exactly what is being repeated, and it is a trustworthy oracle for exhaustive or randomized tests at small sizes.

For the improved algorithm, answer five questions:

1. **State:** what information summarizes all work performed so far?
2. **Invariant:** what claim about that state is true initially and remains true after each transition?
3. **Progress:** what integer, unexplored region, or finite set strictly shrinks?
4. **Exit:** why does the invariant at termination imply the postcondition?
5. **Cost:** how many times can each state transition occur, and what do its container operations cost?

That is a proof template, not ceremony. If a pointer may move backward, a state omits relevant history, or an operation believed to be O(1) is actually a tree lookup, the template exposes the mistake early.

| Signal in the problem | Candidate technique | Fact that must be proved |
|---|---|---|
| Pair or contiguous range in ordered data | Two pointers / window | Discarding an endpoint is safe; window feasibility is monotone |
| First feasible value or boundary | Binary search | Predicate changes in only one direction |
| Need only rank or top k | Selection / bounded heap | Full relative order is unnecessary |
| Enumerate choices with early rejection | Backtracking | Partial invalidity can never be repaired by extension |
| Repeated subproblems | Dynamic programming | State fully identifies a subproblem; dependencies are acyclic |
| Locally best choice | Greedy | An optimal solution can be transformed to contain that choice |
| Nearest greater/smaller or rolling extrema | Monotonic stack/deque | Removed elements can never become useful later |
| Unweighted reachability or dependencies | BFS / DFS / topological sort | Frontier order matches the desired property |
| Named states and bounded events | FSM / transition table | Every state-event pair has explicit semantics |

Test the proof's boundaries, not just ordinary examples: empty and singleton inputs, duplicates, equal endpoints, maximum numeric values, disconnected graphs, cycles, and the smallest counterexample to each precondition. Differential testing against the baseline is especially effective for two-pointer, window, greedy, and graph algorithms.

---

## 22.1 Two Pointers — Core

Two pointers maintains two indices into a sequence and advances them under a rule that keeps each index monotone, giving O(n) total work where a double loop gives O(n²).

**Recognize it:** a problem over a sequence where a brute-force double loop checks all pairs, but discarding one end is always safe once you look at the extremes.

**Precondition:** the input must be sorted, or otherwise arranged so the discard rule is valid. This is not automatic — a converging two-pointer scan on unsorted input returns a wrong answer without any error.

**Invariant:** the answer, if it exists, lies within `[lo, hi]`.

### Converging: two-sum on a sorted range

```cpp
#include <cstdint>
#include <optional>
#include <span>
#include <utility>

std::optional<std::pair<std::size_t, std::size_t>>
two_sum(std::span<const int> a, int target) {
    if (a.size() < 2) return std::nullopt;      // empty or single-element input
    std::size_t lo = 0, hi = a.size() - 1;
    while (lo < hi) {
        // widen the sum so it cannot overflow int even near INT_MIN/INT_MAX
        std::int64_t s = std::int64_t{a[lo]} + std::int64_t{a[hi]};
        if (s == target) return std::pair{lo, hi};
        if (s < target) ++lo;
        else            --hi;
    }
    return std::nullopt;
}
```

The size check must precede `a.size() - 1`, which would underflow on an empty span. Widening each operand before addition prevents signed `int` overflow near the limits.

**Complexity proof:** each iteration either increments `lo` or decrements `hi`, so `hi - lo` strictly decreases; the loop runs at most `n` times. If `a[lo] + a[hi] < target`, then `a[lo]` paired with any element at or before `hi` is also too small, so index `lo` is eliminated for every remaining candidate in O(1) — that is the entire correctness argument.

**Breaks when:** the input is not sorted (silent wrong answer, no crash) — assert `std::is_sorted` in debug builds if the precondition is not guaranteed by the caller.

**Exercise:** given a sorted array with duplicates, return *all* index pairs summing to target without duplicate pairs. What changes in the advance rule when `a[lo]+a[hi] == target`?

### Other shapes, briefly

**Same direction (fast/slow).** A write pointer trails a read pointer; the prefix `[0, write)` is the invariant-satisfying output. This is how in-place partition and `std::remove` work — the read pointer visits every element once, the write pointer only advances on a keep, so it is O(n) with O(1) extra space.

**Cycle detection (Floyd's tortoise and hare).** Slow advances one step, fast advances two; if there is a cycle they meet inside it within O(μ+λ) steps (μ = tail length, λ = cycle length). Restarting one pointer at the head and advancing both by one then finds the cycle's entry point. This uses constant extra space.

### Low-latency angle (skippable)

Two-pointer scans over contiguous storage have simple access patterns. The comparison branch is data-dependent, so a branchless update may help on some targets and hurt on others; inspect generated code and measure representative data. Asymptotic complexity remains the first filter.

---

## 22.2 Sliding Windows — Core

A sliding window is a two-pointer variant where `[lo, hi)` is a contiguous subrange maintained under a predicate, with an aggregate updated incrementally rather than recomputed.

**Recognize it:** "contiguous subarray/substring" combined with a running property (sum, count, distinct-count) that can be updated in O(1) or O(log k) per element.

**Precondition:** two things must both hold — the aggregate is incrementally updatable (adding at `hi`, removing at `lo`, cheaply), and the predicate is **monotone in the window**: if `[lo,hi)` violates it, so does every superset. Monotonicity is what lets `lo` move only forward.

For the example below, after the inner loop, `[lo, hi]` is feasible and `lo` is the smallest feasible start for that `hi` (unless `lo == 0`). Therefore it is the longest feasible window ending at `hi`.

```cpp
// Longest subarray with sum <= S; assume values and S are non-negative.
std::size_t best = 0, lo = 0;
std::int64_t sum = 0;
for (std::size_t hi = 0; hi < a.size(); ++hi) {
    sum += a[hi];
    while (sum > S) sum -= a[lo++];     // lo never moves backward -> total O(n)
    best = std::max(best, hi - lo + 1);
}
```

**Complexity proof:** `lo` only increases and is bounded by `n`, so the total work across all inner-loop iterations is O(n) even though each outer step can trigger several inner steps — the same amortized argument as a monotonic stack (§22.11).

**Breaks when:** negative values are present because extending a window can restore feasibility. With `a = {4, -3}` and `S = 3`, the loop discards `4` before seeing `-3` and reports length 1, missing the valid length-2 window. A prefix-sum-based method is then needed.

**Exercise:** adapt the loop to return the *count* of subarrays with sum in `[L, R]` rather than the single longest one. (Hint: count using two window-boundary passes, or via `count(sum <= R) - count(sum < L)`.)

### Aggregate maintenance

Sums, counts, and XOR are O(1) both directions because addition has an inverse. Max/min are **not** invertible — removing an element cannot restore the previous max — so they need a monotonic deque (§22.11) for O(1) amortized, or a multiset for O(log k). This invertibility distinction (group vs. semigroup) is the deep reason some window aggregates are easy and others need an auxiliary structure.

### Low-latency angle (skippable)

Fixed-size windows over a ring buffer (Ch. 21) support rolling metrics. A power-of-two capacity permits index masking with `& (N-1)`. Repeated floating-point add/subtract operations accumulate rounding error; a fixed-point accumulator or periodic compensated recomputation may be appropriate when the error budget requires it (Ch. 23).

---

## 22.3 Binary Search — Core

Binary search finds a boundary in a range of size n in O(log n) comparisons. The real precondition is not "sorted" but that predicate `p(x)` is **monotone**: false on a prefix, true on the suffix. Binary search finds where it flips.

**Recognize it:** any question phrased "find the first/last element such that..." over a monotone condition, or "search a sorted array."

```cpp
// Returns first index i in [lo,hi) with pred(a[i]) true; hi if none.
template<class T, class Pred>
std::size_t lower_bound_if(std::span<const T> a, Pred pred) {
    std::size_t lo = 0, hi = a.size();
    while (lo < hi) {
        std::size_t mid = lo + (hi - lo) / 2;
        if (pred(a[mid])) hi = mid;         // answer is at or left of mid
        else              lo = mid + 1;     // answer is right of mid
    }
    return lo;                              // == hi; invariant holds at exit
}
```

**Invariant:** the boundary is always in `[lo, hi]`. **Termination:** `hi - lo` is a non-negative integer that strictly decreases every iteration, because `mid < hi` and `mid + 1 > lo` both always hold — so on integer indices the loop is guaranteed to reach `lo == hi`. This integer-specific argument is why the same `lo < hi` shape does **not** terminate for `double` bounds (§22.4 covers the correct real-valued forms).

`lo + (hi-lo)/2` avoids overflowing the addition used by `(lo+hi)/2`. The half-open range also gives one consistent representation for "not found": `a.size()`.

**Breaks when:** the predicate is not monotone (including "sorted by a different key than the one you're searching"), or the container is not random-access. `std::lower_bound`/`upper_bound`/`equal_range`/`partition_point` require only ForwardIterator, so on `std::list` or `std::set::iterator` they still do O(log n) comparisons but O(n) *advances. Chapter 14 gives the complete library contracts.

**Exercise:** implement `partition_point` yourself and use it to find the first "true" in a boolean array produced by a monotone predicate over floating-point measurements — then explain why the predicate, not the array's sortedness, is the real requirement.

For small ranges, a linear scan can be faster because it accesses memory sequentially while binary search performs dependent probes and data-dependent branches. There is no universal crossover: element size, comparator cost, data distribution, and target hardware all matter.

### Low-latency angle (skippable)

Possible alternatives include a branchless index update, an Eytzinger layout that changes probe locality, or a hash table when only exact matches are required (Ch. 12). Each changes memory layout or available operations, so benchmark the full workload rather than an isolated lookup.

---

## 22.4 Binary Search on the Answer — Core

Also called parametric search: when the *answer* is a number and there is a monotone feasibility predicate `feasible(x)`, search over the answer space instead of an array. This turns an optimization problem into O(log range) instances of a decision problem.

**Recognize it:** "minimize the maximum," "maximize the minimum," or "what is the smallest capacity/speed/time such that X is achievable." Examples: minimum ship capacity to deliver in D days; minimum largest sum splitting an array into k parts; k-th smallest element in a sorted matrix (`feasible(x)` = "at least k elements ≤ x").

**Precondition — the one that must be proved, not assumed:** `feasible` is monotone in the searched parameter. If more of the resource can ever make the problem infeasible, the search is invalid.

```cpp
#include <numeric>

// Minimize integer x subject to feasible(x), feasible monotone increasing in x.
template<class Feasible>
std::int64_t min_feasible(std::int64_t lo, std::int64_t hi, Feasible feasible) {
    // Contract: hi is feasible; values below the answer are infeasible.
    while (lo < hi) {
        const std::int64_t mid = std::midpoint(lo, hi);
        if (feasible(mid)) hi = mid;
        else               lo = mid + 1;
    }
    return lo;
}
```

This integer template terminates for the same reason as §22.3: `hi - lo` is a strictly decreasing non-negative integer. It is **not** valid as written for a `double` answer space — `lo = mid + 1` does not converge, and `lo < hi` is not guaranteed to become false on floating-point values close together, so the loop can spin without terminating.

### Real-valued search

Use a fixed iteration count for a floating-point domain:

```cpp
// Maintain !feasible(lo) and feasible(hi).
for (int i = 0; i < iterations; ++i) {
    double m = std::midpoint(lo, hi);
    feasible(m) ? hi = m : lo = m;
}
```

In exact arithmetic, `k` iterations reduce the bracket width to `(initial width)/2^k`; choose `k` from the required tolerance. Midpoint rounding can eventually stop changing an endpoint, but the fixed count still guarantees termination. If the domain is naturally discrete—ticks, lots, bytes—search its integer representation instead.

**Complexity:** integer search takes O(log₂(domain size) × cost(feasible)); a real bracket needs O(log₂((hi-lo)/tolerance) × cost(feasible)) evaluations until representation precision becomes the limit.

**Exercise:** given a monotone `feasible` over `double` prices, find the price to within `1e-9` using the fixed-iteration form, and explain in one sentence why a `lo < hi` loop over `double` bounds is not a safe substitute.

A query such as "what price fills N shares?" can search a prefix-sum array of depth (§22.12). For a small number of levels a linear scan may still be preferable; measure the actual distribution.

---

## 22.5 Sorting Properties and Tradeoffs — Core

Sorting is often a transformation that exposes structure: adjacent duplicates become visible, interval starts become sweep events, and a pair problem gains a safe discard rule. Before sorting, ask whether mutation is allowed and whether its O(n log n) cost is amortized across later queries.

| Required property | Suitable family | Main tradeoff |
|---|---|---|
| Stable order among equivalent keys | Stable merge-based sort | Auxiliary storage is commonly used |
| Worst-case O(n log n), in place | Heap-based sort | Non-sequential access pattern |
| Nearly sorted input | Insertion/adaptive sort | Quadratic on adverse order |
| Fixed-width integer keys | Counting/radix method | Extra storage; depends on key representation |
| Only rank or top k | Selection/partial sort | Does not produce a full order |

**Stable** means equivalent elements retain their relative input order. It matters when tie order has semantics or when composing sorts by multiple keys. The comparator must define a strict weak ordering; using `<=`, mutating compared state, or mishandling NaNs can violate the sort's contract.

The Ω(n log n) lower bound applies to **comparison** sorting. A decision tree for `n!` possible orders needs height at least `log₂(n!)`. Counting and radix methods avoid that bound by using key representation, but their time and memory include the key range or number of digit passes.

For the standard algorithms, retain two accuracy points: C++ requires `std::sort` to use O(n log n) comparisons but does not mandate its implementation, and `std::nth_element` has average linear complexity rather than a guaranteed worst-case linear bound. Chapter 14 contains the full contracts.

**Exercise:** given an array where every element is at most k positions from its sorted position, argue why insertion sort (or a bounded-window heap) beats a full O(n log n) sort, and state the resulting complexity in terms of n and k.

### Low-latency angle (skippable)

Movement can dominate comparison cost for large records. Sorting compact keys or indices reduces movement but adds an indirection during later access. Sequential merge passes and heap-style index jumps have different locality. These mechanisms identify what to benchmark; they do not imply a universal winner.

---

## 22.6 Selection and Partial Sorting — Core

Selection finds the k-th order statistic without fully sorting; partial sorting produces the first k in order.

| Task | Tool | Complexity |
|---|---|---|
| k-th element, unordered rest | `std::nth_element` | O(n) average |
| Top k in sorted order | `std::partial_sort` | O(n log k) |
| Just min / max / both | `std::min_element`, `std::minmax_element` | n−1 / ~1.5n comparisons |

Quickselect partitions around a pivot and continues only into the side containing rank `k`. Balanced partitions give the recurrence `n + n/2 + n/4 + … = O(n)`; consistently poor pivots give O(n²). The standard guarantee for `std::nth_element` is linear complexity on average, not worst-case linear.

**Recognize it:** "find the k-th largest/smallest" or "top k" without a full order requirement.

**Precondition:** the comparator defines a strict weak ordering. `nth_element` reorders the *entire* range as a side effect and gives no ordering guarantee outside the partition around position `k`; copy first if the original order is needed.

### Streaming top-k

```cpp
// Top-k largest from a stream; precondition k > 0.
// Heap holds the k best seen, root = smallest of them.
std::priority_queue<T, std::vector<T>, std::greater<>> h;   // min-heap
for (const T& x : stream) {
    if (h.size() < k) h.push(x);
    else if (x > h.top()) { h.pop(); h.push(x); }
}
```

Worst-case time is O(n log k), space is O(k), and the stream is consumed once. The invariant is that after each input, the heap holds the largest `min(k, items_seen)` values; an element no larger than the root cannot belong to that set.

**Exercise:** implement `h` as a bounded min-heap and prove that after processing the stream, `h` contains exactly the k largest elements regardless of stream order (induction on the invariant "h holds the k largest seen so far").

### Low-latency angle (skippable)

For streaming top-k, reserve bounded storage and avoid rebuilding a complete order. Latency quantiles need a distribution summary rather than repeated full sorts; Chapter 43 develops histogram-based measurement.

---

## 22.7 Recursion and Backtracking — Core

Recursion reduces a problem to smaller instances of itself, using the call stack to hold each frame's locals and return address (Ch. 41 covers frame layout). Backtracking is depth-first search over partial solutions with pruning: build a candidate incrementally and abandon a branch as soon as it cannot be completed.

**Recognize it:** "generate all," "count all ways," or "does a valid arrangement exist" over a combinatorial space — permutations, subsets, board placements, constraint satisfaction.

```cpp
void permute(std::vector<int>& a, std::size_t i,
             std::vector<std::vector<int>>& out) {
    if (i == a.size()) { out.push_back(a); return; }
    for (std::size_t j = i; j < a.size(); ++j) {
        std::swap(a[i], a[j]);
        permute(a, i + 1, out);
        std::swap(a[i], a[j]);        // undo -- the "backtrack"
    }
}
```

**Invariant:** at each call, `a[0, i)` holds a valid partial candidate and `a[i, n)` holds the unused elements. The undo step restores that invariant on exit so the working set is O(depth), not O(nodes).

For `{A,B,C}`, the first two recursion levels are:

```text
[ | A B C]
├─ [A | B C] ── [A B | C], [A C | B]
├─ [B | A C] ── [B A | C], [B C | A]
└─ [C | B A] ── [C B | A], [C A | B]
```

The bar separates the fixed prefix from unused choices; every edge fixes one more position, and backtracking restores the parent state.

**Complexity:** (nodes visited) × (work per node). Pruning changes the first factor but must be justified: reject a branch only when no extension can repair it. State the unpruned bound and the pruning condition rather than quoting only a measured node count.

**Breaks when:** the undo is forgotten (state leaks between branches), or undo runs unconditionally after a conditional forward step.

**Exercise:** modify `permute` to skip duplicate permutations when `a` contains repeated values, without sorting first, and argue why your pruning condition is both necessary and sufficient to avoid duplicates.

### Recursion in production C++

| Hazard | Detail |
|---|---|
| Stack overflow | Available stack is platform- and configuration-dependent; unbounded depth can exhaust it. |
| No guaranteed tail-call optimization | Compilers may perform it at higher optimization levels when the call is in tail position and no destructors run after it, but the standard does not require it. Never rely on it for correctness. |
| Depth-dependent latency | Deeply nested untrusted input can exhaust the stack; impose an explicit parser depth limit (Ch. 51). |

Converting recursion to iteration means making the frame explicit (for example, a `std::vector<Frame>` with a resume-point state). Do it when depth is unbounded or input is untrusted. Balanced divide-and-conquer recursion is O(log n) deep; recursion over a linked list or path can be O(n) deep.

---

## 22.8 Divide and Conquer — Core

Divide and conquer splits a problem of size n into `a` subproblems of size `n/b`, solves them recursively, and combines in `f(n)`: `T(n) = a·T(n/b) + f(n)`, resolved by the Master Theorem.

| Case | Condition | Result | Example |
|---|---|---|---|
| 1 | f(n) = O(n^(log_b a − ε)) | T(n) = Θ(n^(log_b a)) | Karatsuba: 3T(n/2)+O(n) → Θ(n^1.585) |
| 2 | f(n) = Θ(n^(log_b a)) | T(n) = Θ(n^(log_b a)·log n) | Mergesort: 2T(n/2)+O(n) → Θ(n log n) |
| 3 | f(n) = Ω(n^(log_b a + ε)), regular | T(n) = Θ(f(n)) | 2T(n/2)+O(n²) → Θ(n²) |

Work is dominated by the leaves (case 1), spread evenly across levels (case 2), or dominated by the root (case 3). To classify a recurrence, compute `log_b a`, compare it with the exponent in `f(n)`, and match a row.

Key instances: mergesort/quicksort; binary search (a=1, b=2, f=O(1) → Θ(log n)); Karatsuba; Strassen (7T(n/2)+O(n²) → Θ(n^2.807)); closest pair of points.

**Recognize it:** a recurrence of the `aT(n/b) + f(n)` shape, or a problem that splits cleanly into independent same-shaped subproblems.

**Breaks when:** subproblems overlap. If a subproblem is reached along multiple recursion paths, naive recursion becomes exponential — that is dynamic programming's domain (§22.9), not divide and conquer's. Unbalanced splits (a bad quicksort pivot) also break the clean recurrence and degrade to O(n²).

**Exercise:** given `T(n) = 4T(n/2) + O(n)`, identify the Master Theorem case and state the resulting bound; then do the same for `T(n) = 4T(n/2) + O(n²)`.

Recursive subdivision can improve locality when successively smaller contiguous subproblems fit lower cache levels. Independent subproblems may also run in parallel before the combine step. Both benefits depend on representation, base-case work, and scheduling overhead.

---

## 22.9 Dynamic Programming — Core

DP applies when a problem has **optimal substructure** (an optimal solution is composed of optimal solutions to subproblems) and **overlapping subproblems** (the same subproblem recurs along many recursion paths). It eliminates the redundant recomputation by storing each subproblem's answer once. Naive Fibonacci recursion is Θ(φⁿ); memoized, it is Θ(n) — that gap is the entire point of the technique.

### The four-step method

1. **Define the state** — the parameters that uniquely identify a subproblem. This is most of the difficulty.
2. **Write the recurrence** — the transition between states.
3. **Identify base cases.**
4. **Determine evaluation order** (bottom-up) so every dependency is computed first.

Complexity = (number of states) × (transition cost).

| | Top-down (memoized recursion) | Bottom-up (tabulation) |
|---|---|---|
| Computes | Only reachable states | All states |
| Stack | O(depth) — can overflow | O(1) |
| Per-state overhead | Memo lookup + calls | Scheduled table access; often contiguous |
| Ease | Easier to derive from the recurrence | Requires a valid topological order over states |

### Worked example 1: 0/1 knapsack

```cpp
// states = (item index, remaining capacity); transition O(1); O(n*W) time.
// Rolling 1-D array, iterated DOWNWARD so each item is used at most once.
std::vector<int> dp(W + 1, 0);
for (const auto& [w, v] : items)
    for (int c = W; c >= w; --c)               // downward: 0/1. Upward would allow reuse (unbounded knapsack).
        dp[c] = std::max(dp[c], dp[c - w] + v);
```

**Invariant:** after processing the first `i` items, `dp[c]` holds the best value achievable with total weight ≤ `c` using only those items. The inner loop's direction is the entire 0/1-vs-unbounded distinction: iterating capacity downward guarantees `dp[c - w]` still reflects the state *before* item `(w,v)` was applied, so each item contributes at most once.

**Exercise:** change the inner loop to iterate upward and show, on a 2-element example, that it computes unbounded knapsack instead.

### A second derivation: edit distance

Let `dp[i][j]` be the minimum edits that turn `a[0,i)` into `b[0,j)`. Equal trailing characters use `dp[i-1][j-1]`; otherwise add one to the minimum of the deletion, insertion, and substitution states. The base row and column equal their prefix lengths. There are `(n+1)(m+1)` states with O(1) transitions, hence O(nm) time and space. Because row `i` depends only on itself and row `i-1`, two rows reduce space to O(min(n,m)). This derivation—state, recurrence, bases, dependency order—is more reusable than memorizing a table.

**Breaks when:** the "subproblems" don't actually overlap (then it is plain divide and conquer, and memoizing wastes memory for no benefit) or the state is under-specified (two genuinely different situations collapse to the same memo key, silently returning a cached wrong answer).

Linear, grid, interval, tree, bitmask, and DAG DP all use the same method with different state definitions. Exponential bitmask DP remains exponential even when it is much better than enumerating all permutations.

**Greedy vs. DP:** if a locally optimal choice provably extends to a global optimum, greedy suffices; if choices must be reconsidered across overlapping states, DP may be required. Fractional knapsack is greedy; 0/1 knapsack is not.

### Low-latency angle (skippable)

Rolling rows reduce both storage and the working set. Row-major iteration makes contiguous table access possible. Word-packed subset-state DP can update many Boolean states with shifts and ORs. For sparse states, compare a flat encoded-state representation with hashing; density and maximum key range determine the better choice.

**Exercise:** rewrite the knapsack loop to use two explicit `vector<int>` rows instead of one, verify it produces the same answer as the rolling 1-D version, and state which of the two is preferable and why.

---

## 22.10 Greedy Algorithms — Core

A greedy algorithm repeatedly makes a locally best choice and never reconsiders it. Correctness may follow from an **exchange argument** (transform an optimum to contain the greedy choice), **staying ahead** (the greedy prefix is never worse), a **cut property**, or a more general structure such as a matroid. Without such an argument, greedy is a heuristic.

| Problem | Greedy rule | Why it works |
|---|---|---|
| Activity selection (max non-overlapping) | Earliest finish time | Exchange: earliest-finishing leaves the most room |
| Fractional knapsack | Highest value/weight ratio | Divisibility makes the exchange exact |
| MST (Kruskal/Prim) | Cheapest safe edge | Cut property; matroid |
| Dijkstra | Nearest unsettled vertex | Non-negative weights ⇒ settled distances are final (§22.14) |
| Coin change, canonical systems | Largest coin first | System-specific; **fails** for {1,3,4} making 6 (4+1+1 vs 3+3) |

Interval **scheduling** (max count) is greedy by finish time; interval **partitioning** (min rooms) is greedy by start time with a min-heap of end times — the two are commonly conflated because both sort intervals, but by different keys.

**Recognize it:** a problem where you can state "the optimal solution always contains the choice X" as a claim to be checked, not assumed.

**Breaks when:** the greedy key is wrong (activity selection by earliest *start* or shortest *duration* both fail — only earliest-finish works), or the problem has 0/1 (indivisible) constraints that break the exchange argument, which is exactly why fractional knapsack is greedy and 0/1 knapsack is DP.

**Exercise:** prove or disprove: "sorting jobs by shortest processing time first minimizes total completion time on a single machine." Then find the smallest counterexample if the claim as stated is false for a different objective (e.g., minimizing maximum lateness with deadlines).

### Low-latency angle (skippable)

When a greedy proof applies, the implementation often stores less state than a DP formulation. That can reduce allocation and memory traffic, but the actual cost depends on sorting, priority queues, and candidate-set representation.

---

## 22.11 Monotonic Stacks and Queues — Core

A monotonic stack maintains its elements in sorted order by popping violators on push. Each element is pushed once and popped at most once, so a loop with an inner `while`-pop is **amortized O(1) per element, O(n) total**. Chapter 23 generalizes this accounting method.

**Recognize it:** "next greater/smaller element," "largest rectangle in histogram," or any problem where, for each element, you need the nearest element on one side satisfying a comparison.

```cpp
// For each i, index of the next element strictly greater than a[i], or n.
std::vector<std::size_t> next_greater(std::span<const int> a) {
    std::vector<std::size_t> res(a.size(), a.size());
    std::vector<std::size_t> st;
    st.reserve(a.size());                           // indices, values decreasing
    for (std::size_t i = 0; i < a.size(); ++i) {
        while (!st.empty() && a[st.back()] < a[i]) { res[st.back()] = i; st.pop_back(); }
        st.push_back(i);
    }
    return res;
}
```

**Invariant:** the stack holds indices whose "next greater" is not yet known, in decreasing value order; when `a[i]` arrives it resolves exactly the elements it exceeds.

This pattern solves next/previous greater/smaller (four variants), largest rectangle in a histogram (O(n)), trapping rain water, and stock span.

### Monotonic deque — sliding-window maximum

```cpp
// Precondition: 1 <= k <= n.
std::deque<int> dq;                              // indices, values decreasing
for (int i = 0; i < n; ++i) {
    while (!dq.empty() && dq.front() <= i - k) dq.pop_front();   // expire
    while (!dq.empty() && a[dq.back()] <= a[i]) dq.pop_back();   // dominated
    dq.push_back(i);
    if (i >= k - 1) out.push_back(a[dq.front()]);
}
```

An element that is both older and no larger than the incoming one can never again be the window maximum, so discarding it from the back is safe. This gives O(n) total time; a heap with lazy deletion gives O(n log n).

**Breaks when:** the comparison used for popping is strict where it needs to be non-strict (or vice versa) — get the tie-handling wrong and duplicate values break the answer.

**Exercise:** adapt `next_greater` to compute, for each element, the count of subarrays in which it is the *minimum* (via previous-smaller and next-smaller boundaries), and state why the boundary comparisons must be asymmetric (one strict, one not) to avoid double-counting equal elements.

### Low-latency angle (skippable)

A reserved `std::vector` is a compact stack. For the deque variant, a fixed-capacity ring buffer can bound allocation; masking indices with `& (capacity-1)` is valid only when the ring capacity is a power of two.

---

## 22.12 Prefix Sums — Core

A prefix sum array `P[i] = a[0] + … + a[i-1]`, `P[0] = 0`, answers any range-sum query in O(1): `sum(l, r) = P[r] - P[l]` for half-open `[l, r)`. Build is O(n); the trade is O(n) extra space and invalidation on any update to `a`.

The half-open convention with a leading zero eliminates off-by-one errors that the inclusive `[l, r]` form (`P[r] - P[l-1]`) introduces at `l == 0`.

```cpp
std::vector<long long> P(a.size() + 1, 0);
for (std::size_t i = 0; i < a.size(); ++i)
    P[i + 1] = P[i] + static_cast<long long>(a[i]);
```

**Recognize it:** repeated range-sum (or range-XOR, range-min-with-care) queries over static or slowly-changing data.

**Invariant:** `P[i]` equals the sum of exactly the first `i` elements, so any two prefixes subtract to the sum of the elements strictly between them.

| Structure | Query | Update | Use |
|---|---|---|---|
| Prefix sum array | O(1) | O(n) rebuild | Static data |
| Difference array | O(n) to materialize | O(1) range add | Many range updates, one final read |
| Fenwick / segment tree (Ch. 21) | O(log n) | O(log n) | Mixed updates and queries |

The **difference array** is the dual: to add `v` to `[l, r)`, do `d[l] += v; d[r] -= v` in O(1), then one final prefix scan materializes the result — turning N range-increment operations followed by a read into O(N + n) instead of O(N·n).

**Breaks when:** the accumulator overflows (`int32_t` prefix sums over a large array overflow silently — accumulate in `int64_t`), or when the operation is not invertible (prefix-min has no inverse, so it supports only prefix queries, not arbitrary-range ones; arbitrary-range min needs a sparse table or segment tree).

**Correctness note for financial data:** a prefix sum over `double` accumulates rounding error, and `P[r] - P[l]` may lose significant digits when both prefixes are large and close. Fixed-point integers or compensated/pairwise summation may be appropriate; Chapter 23 develops the numerical analysis.

**Exercise:** given an array of transaction deltas and Q queries each asking "what is the balance after transaction i," build the prefix sum once and answer every query in O(1); then extend to support "apply delta v to all transactions in [l, r)" using a difference array, and explain why you cannot mix live point-queries with pending range-updates without materializing first.

A serial prefix sum has a loop-carried dependency. Parallel scan algorithms trade extra work and synchronization for less dependency depth; whether that helps depends on input size and execution environment.

With a zero-padded row and column, 2-D prefix sums use
`P[i+1][j+1] = a[i][j] + P[i][j+1] + P[i+1][j] - P[i][j]`.
A half-open rectangle `[r1,r2) × [c1,c2)` then sums to
`P[r2][c2] - P[r1][c2] - P[r2][c1] + P[r1][c1]`.

---

## 22.13 Breadth-First and Depth-First Search — Core

Both traverse a graph in O(V + E) with an adjacency list; they differ only in the frontier container (queue vs. stack), and that difference determines what each can compute.

| | BFS | DFS |
|---|---|---|
| Frontier | FIFO queue | LIFO stack (or recursion) |
| Order | By distance from source | By depth |
| Gives | Shortest path in unweighted graphs | Topological order, cycle detection, SCCs |
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

**Invariant:** vertices leave the queue in nondecreasing distance order, and a vertex's first discovery gives its shortest unweighted distance. Mark on **enqueue** so each vertex enters the frontier at most once. Marking only on dequeue can admit many duplicates; if their adjacency lists are rescanned, both memory and work can exceed the O(V+E) bound.

Three-colour DFS (white = unvisited, grey = on the current recursion stack, black = finished) is what enables cycle detection: a back edge to a grey node is a cycle in a directed graph. A plain boolean `visited` cannot distinguish a back edge from a cross edge and will report false cycles.

**Recognize it:** "shortest path, unweighted" → BFS. "Does a cycle exist," "topological order," "connected components via DFS-tree structure" → DFS.

**Breaks when:** BFS is used expecting shortest paths on a *weighted* graph (it gives fewest edges, not lowest weight); or plain-boolean DFS is used for directed-cycle detection (it misses the grey/black distinction).

**Exercise:** implement multi-source BFS (seed the queue with all sources at distance 0) to compute, for every cell in a grid, the distance to the nearest of several marked cells in one pass — then argue why running single-source BFS from each source separately gives the same answer but at higher cost.

### Low-latency angle (skippable)

Graph traversal often spends much of its time on irregular adjacency access. CSR (offset and target arrays) removes per-vertex allocations and can improve locality compared with `vector<vector<int>>`. `vector<bool>` is bit-packed, but its proxy access differs from a raw word bitmap; benchmark either choice. A flat vector plus a head index is a compact BFS queue when the maximum frontier storage is acceptable.

---

## 22.14 Shortest Paths — Core

Algorithm choice is a function of the edge weights and the query pattern.

| Algorithm | Weights | Complexity | Notes |
|---|---|---|---|
| BFS | Unweighted | O(V+E) | Use whenever applicable |
| 0-1 BFS (deque) | {0, 1} | O(V+E) | No priority queue needed |
| Dijkstra (decrease-key heap) | Non-negative | O((V+E) log V) | Settled-minimum proof |
| Dijkstra (lazy binary heap) | Non-negative | O((V+E) log E) | Simple C++ implementation below |
| Bellman–Ford | Any, detects negative cycles | O(V·E) | V−1 relaxation rounds; a V-th improvement implies a negative cycle |
| Floyd–Warshall | Any (no negative cycles) | O(V³), O(V²) space | All-pairs; practical to a few hundred vertices |

**Why Dijkstra requires non-negative weights:** its proof rests on the claim that when a node is selected with the minimum tentative distance, no later path can improve it. A negative edge invalidates that claim. The lazy code below reopens improved vertices rather than maintaining an explicit settled set, but with negative edges its Dijkstra proof and complexity bound no longer apply; a reachable negative cycle may cause continual improvements.

```cpp
// Lazy-deletion Dijkstra: the idiomatic C++ form, since std::priority_queue
// has no decrease-key.
using P = std::pair<std::int64_t, int>;                 // (distance, node)
std::priority_queue<P, std::vector<P>, std::greater<>> pq;
std::vector<std::int64_t> dist(n, INF);
dist[s] = 0; pq.push({0, s});
while (!pq.empty()) {
    auto [d, u] = pq.top(); pq.pop();
    if (d > dist[u]) continue;                          // stale entry -- skip
    for (auto [v, w] : adj[u]) {
        // Precondition: w >= 0; choose INF so this addition cannot overflow.
        if (d + w < dist[v]) { dist[v] = d + w; pq.push({dist[v], v}); }
    }
}
```

The stale-entry skip is an **efficiency** optimization for this lazy form, not a correctness requirement under the non-negative-weight precondition. If `d > dist[u]`, the smaller entry has already relaxed `u`'s outgoing edges, so repeating them from `d` cannot improve a neighbor. Lazy insertion creates O(E) heap entries, giving O((V+E) log E) time and O(V+E) storage.

`INF` must leave enough headroom that `d + w` cannot overflow, or the addition must be checked. Chapter 23 develops overflow-detection policies.

**Recognize it:** shortest path with non-negative weights → Dijkstra; possible negative weights → Bellman–Ford; unweighted → BFS; all-pairs on a small dense graph → Floyd–Warshall.

**Exercise:** construct a graph with one negative edge where conventional Dijkstra permanently settles a vertex too early. Then trace the lazy code above on the same graph: does reopening repair that instance, and which part of the Dijkstra proof or bound is still lost?

### Low-latency angle (skippable)

For a small static graph, precomputing distances can turn repeated queries into table lookups at the cost of O(V²) storage. Higher-arity heaps reduce depth but perform more child comparisons; bucket queues exploit bounded non-negative integer weights. These are representation-dependent optimizations.

---

## 22.15 Topological Sorting — Core

A topological order of a DAG is a linear ordering where every edge `u → v` places `u` before `v`. It exists iff the graph is acyclic, and is generally not unique.

**Kahn's algorithm (BFS, indegree-based):**

```cpp
std::vector<int> indeg(n, 0);
for (int u = 0; u < n; ++u) for (int v : adj[u]) ++indeg[v];
std::vector<int> q, order;
for (int u = 0; u < n; ++u) if (!indeg[u]) q.push_back(u);
for (std::size_t i = 0; i < q.size(); ++i) {     // q grows as we go
    int u = q[i]; order.push_back(u);
    for (int v : adj[u]) if (--indeg[v] == 0) q.push_back(v);
}
if (order.size() != std::size_t(n)) { /* residual graph contains a cycle */ }
```

**Invariant:** a node is pushed into `q` exactly when all its predecessors have already been emitted, so `order` is always a valid prefix of some topological order. If fewer than `n` vertices are emitted, the residual subgraph contains a cycle. A residual vertex may merely be downstream of that cycle, so it need not itself lie on one.

**Alternative (DFS-based):** push each node onto an output list on *finish* (post-order), then reverse; detect cycles via the grey-node rule (§22.13). More concise but recursive, so depth-limited on deep graphs.

**Recognize it:** dependency ordering — build systems, task/DAG schedulers, spreadsheet recalculation, or "does this dependency graph have a cycle."

**Breaks when:** the graph has a cycle and the size check is omitted — silently returning a partial, invalid order instead of reporting the failure.

**Exercise:** extend Kahn's algorithm to report one cycle. After Kahn leaves a residual graph, run three-colour DFS within that residual graph and reconstruct a cycle from a back edge and parent links.

DP over a topological order is the general form of "DP on a DAG": process nodes in topological order and every state's dependencies are already computed, giving both shortest and longest path in a DAG in O(V+E) with no restriction on edge signs (longest path is NP-hard in general graphs, a useful contrast to have ready).

### Low-latency angle (skippable)

Startup dependency ordering (Ch. 60) is a direct application: components declare dependencies, Kahn's algorithm produces the init order, and the count check turns a dependency cycle into a startup-time error instead of a runtime deadlock. Sorting once at startup and storing the resulting flat order keeps the hot path free of graph structure entirely.

---

## 22.16 Finite-State Machines — Role-specific

A finite-state machine is a tuple (states, alphabet, transition function, start state, accepting states) — the right model whenever behavior depends on history summarizable in bounded state: protocol sessions, order lifecycles, lexers.

A deterministic machine defines one outcome for each `(state,event)` pair. It compresses all relevant history into the current state; if two histories require different future behavior, they must not be collapsed into the same state. A `switch` is convenient for a few transitions with complex actions, while a dense table exposes a small total transition function.

```cpp
#include <array>
#include <cstdint>

enum class S : std::uint8_t {
    New, PendingNew, Live, PendingCancel, Filled, Cancelled, Rejected, Invalid, Count
};
enum class E : std::uint8_t {
    Send, Ack, Fill, PartialFill, CancelReq, CancelAck, Reject, Count
};
constexpr std::size_t index(auto value) {
    return static_cast<std::size_t>(value);
}

constexpr auto make_table() {
    std::array<std::array<S, index(E::Count)>, index(S::Count)> t{};
    for (auto& row : t) row.fill(S::Invalid);
    t[index(S::New)][index(E::Send)]          = S::PendingNew;
    t[index(S::PendingNew)][index(E::Ack)]    = S::Live;
    t[index(S::PendingNew)][index(E::Reject)] = S::Rejected;
    t[index(S::Live)][index(E::Fill)]         = S::Filled;
    t[index(S::Live)][index(E::PartialFill)]  = S::Live;
    t[index(S::Live)][index(E::CancelReq)]    = S::PendingCancel;
    t[index(S::PendingCancel)][index(E::CancelAck)] = S::Cancelled;
    t[index(S::PendingCancel)][index(E::Fill)]      = S::Filled;
    return t;
}

constexpr auto kNext = make_table();

S step(S state, E event) {
    return kNext[index(state)][index(event)]; // caller handles Invalid explicitly
}
```

Without `Invalid`, value-initialized cells would silently map illegal transitions to the enum's zero-valued real state. The caller can now distinguish a protocol violation from every valid lifecycle state.

**Recognize it:** a bounded number of named states plus a bounded set of named events/inputs, where illegal combinations should be caught, not merely unhandled.

**Precondition:** the state and event sets are enumerable and small enough that a dense table is cheap. For an event space with wide values (arbitrary bytes), compose with table-driven classification first (§22.17) to shrink the effective alphabet.

**Invariant:** after each accepted event, the state summarizes exactly the history relevant to future transitions. The table is total: every in-range pair yields a valid next state or `Invalid`.

**Breaks when:** duplicates or reordered reports have valid semantics that the model omits. Idempotence is a domain decision: encode tolerated duplicates as explicit self-loops and distinguish buffering/reordering from a truly illegal transition.

**Exercise:** add an explicit self-loop for "duplicate Ack while already Live" and tests showing that it differs from a `Send` event while `Filled`.

A transition table makes the machine exhaustively inspectable and `constexpr`-constructible. Its performance relative to a `switch` depends on table size, event distribution, and the actions attached to transitions.

---

## 22.17 Table-Driven Parsing — Role-specific

Table-driven parsing replaces repeated classification or dispatch conditionals with precomputed mappings.

**1. Character classification.** A 256-entry table maps every byte to a class.

```cpp
constexpr std::array<std::uint8_t, 256> kClass = make_class_table();
enum : std::uint8_t { Digit=1, Alpha=2, Space=4, Delim=8 };
while (p != end && (kClass[std::uint8_t(*p)] & Digit)) ++p;
```

**2. DFA transition tables.** `state = table[state][kClass[c]]`. Collapsing a 256-byte alphabet into a few equivalence classes reduces table size when bytes in the same class have identical transitions.

**3. Dispatch tables for message types.** A binary protocol's message-type byte indexes a table of handlers or lengths.

```cpp
struct MsgSpec { std::uint16_t length; Handler handler; };
constexpr std::array<MsgSpec, 256> kSpec = make_specs(); // zero length = unknown

bool parse_one(std::span<const std::byte> input, Book& book) {
    if (input.empty()) return false;
    const auto type = std::to_integer<std::uint8_t>(input.front());
    const MsgSpec spec = kSpec[type];
    if (spec.length == 0 || input.size() < spec.length) return false;
    spec.handler(input.first(spec.length), book);
    return true;
}
```

**Recognize it:** a hot-path decoder currently written as an `if`/`else if` chain over byte values, where the branch outcome is unpredictable at runtime.

**Precondition:** the classification or dispatch key is bounded and small (a byte, or a state × small-alphabet pair) so the table fits comfortably in cache.

**Invariant:** the table is total over its domain — every input value maps to a defined entry (a valid class/state, or an explicit "unknown"/reject marker), never an unchecked fall-through.

A table replaces a variable number of comparisons with an indexed load, but that load is only cheap when the table is resident in a nearby cache. A short branch chain with strongly skewed input can be faster. Input distribution and table footprint determine the result.

**Breaks when:** a large table misses cache; a possibly signed `char` indexes it without conversion to an unsigned byte; or a length field is trusted before comparison with the remaining span. Table-driven dispatch does not replace bounds validation (Ch. 51).

**Exercise:** feed every possible first byte to `parse_one`, plus every truncated length from zero to one less than its specification. Confirm that undefined and truncated messages fail without invoking a handler.

---

## 22.18 Sweep-Line Algorithms — Deep dive

A sweep line processes interval/geometric data by moving a conceptual line across one axis, maintaining a structure of objects currently intersecting it, and handling sorted **events** where that set changes.

```cpp
struct Event { std::int64_t x; int delta; };     // +1 at start, -1 at end
std::vector<Event> ev;
for (auto& [s, e] : intervals) {
    if (s < e) { ev.push_back({s, +1}); ev.push_back({e, -1}); }
}
std::ranges::sort(ev, [](const Event& a, const Event& b) {
    return std::pair{a.x, a.delta} < std::pair{b.x, b.delta};
});                                              // ends (-1) before starts (+1)
int active = 0, best = 0;
for (auto& [x, d] : ev) { active += d; best = std::max(best, active); }
```

This computes maximum overlap (minimum meeting rooms, peak concurrent connections) in O(n log n).

**Precondition and the one correctness question that matters:** intervals satisfy `s <= e`; empty half-open intervals can be ignored. For `[s, e)`, ends must sort before starts at the same coordinate (sorting `(x, delta)` does this because `-1 < +1`); for closed intervals, starts sort first.

**Invariant:** after all events at coordinate `x` are processed in the chosen tie order, `active` equals the number of intervals covering the region immediately to the right of `x`.

| Problem | Structure | Complexity |
|---|---|---|
| Max overlap / min rooms | Counter | O(n log n) |
| Rectangle union area (Klee) | Segment tree with coverage counts | O(n log n) |
| Closest pair of points | `std::set` of active points by y, strip search | O(n log n) |

**Recognize it:** "maximum overlap," "union of intervals," or a geometric problem naturally ordered along one axis.

**Breaks when:** events are presorted into a `std::vector` but the code uses a `std::priority_queue` instead — unnecessary heap overhead for a case with perfect prefetching available. A heap is only necessary when new events (e.g. discovered intersections in Bentley–Ottmann) are generated during the sweep itself.

**Exercise:** given a list of `[start, end)` meeting intervals, compute the minimum number of rooms required, then extend it to also return, for each room, which meetings it hosts (in order) — verify the tie-break rule against a case with two meetings sharing an exact boundary.

Coordinate compression (sort + unique + `lower_bound` to map O(n) distinct coordinates to `[0, m)`) is the standard companion for indexing a segment tree or difference array densely.

---

## 22.19 Interval Algorithms — Deep dive

Fix a convention first: half-open `[s, e)` is preferred — it makes adjacency (`a.e == b.s`) unambiguous, length `e - s` needs no `+1`, and intervals compose cleanly under splitting.

**Overlap test:** `[a1,a2)` and `[b1,b2)` overlap iff `a1 < b2 && b1 < a2` (closed intervals use `<=`). Deriving this from "not disjoint" (`!(a2 <= b1 || b2 <= a1)`) is where sign errors happen — memorize the positive form.

| Problem | Sort by | Method |
|---|---|---|
| Merge overlapping | start | Scan; extend current end if `next.start < end`, else emit |
| Max non-overlapping subset | end | Greedy: take if `start >= last_end` (§22.10) |
| Min rooms / max overlap | events | Sweep line (§22.18) |

The sort key differs between merging (start) and max-subset selection (end) — sorting by the wrong key produces a plausible-looking wrong algorithm.

```cpp
// Merge -- O(n log n), dominated by the sort.
std::ranges::sort(iv, {}, &Interval::start);
std::vector<Interval> out;
for (const auto& x : iv)
    if (!out.empty() && x.start < out.back().end) out.back().end = std::max(out.back().end, x.end);
    else out.push_back(x);
```

For repeated "which intervals contain point p" queries against a static set, a general overlapping-interval set needs an **interval tree** (an augmented BST storing each subtree's max end, which lets a whole subtree be pruned when `max_end < query.start`) at O(log n + k) query; a *non-overlapping* set is just a partition and a sorted array with `lower_bound` suffices.

**Recognize it:** any "merge," "insert," or "count overlapping" question over a set of ranges.

**Breaks when:** the interval convention is mixed (some closed, some half-open) within one solution — pick one and hold it, especially at the `l==0`/adjacency boundary.

For a small static interval set, a flat sorted vector may outperform a tree because it avoids nodes and allocation. It also makes immutable query paths easy to keep allocation-free. The crossover is workload-specific.

**Exercise:** implement "insert a new interval into an already-merged, sorted, non-overlapping list" in three phases (copy strictly-before, absorb overlapping via min/max, copy strictly-after) and test it against inserting an interval that swallows several existing ones.

---

## 22.20 Bit-Manipulation Techniques — Deep dive

Bit tricks replace branches and loops with one or two ALU operations, and map subset/flag problems directly onto machine words.

```cpp
u & (u - 1)        // clear lowest set bit
u & (0u - u)       // isolate lowest set bit (unsigned modulo arithmetic)
u & (n - 1)        // u % n when n is a nonzero power of two
```

`x & (x-1)` is the basis of Brian Kernighan's popcount: loop while `x`, clearing the lowest set bit each time — O(popcount) iterations rather than O(bits). Prefer the standard library where available:

| Function | Notes |
|---|---|
| `std::popcount` | population count |
| `std::countl_zero` / `countr_zero` | defined at zero, unlike the legacy `BSR`/`BSF` intrinsics |
| `std::rotl` / `std::rotr` | the hand-written `(x<<k)\|(x>>(32-k))` is UB at `k==0` (a shift by the full width); the standard functions are not |
| `std::has_single_bit` | power-of-two test, correctly excluding zero |

### Subset enumeration

```cpp
// Enumerate all submasks of m, descending, in O(2^popcount(m)) total.
for (std::uint64_t s = m; s; s = (s - 1) & m) { /* use s */ }
// (plus s == 0 separately)
```

Summed over all `m` in `[0, 2ⁿ)`, this totals 3ⁿ iterations — the standard bound for subset-sum-over-subsets DP.

**Use unsigned operands.** Left-shifting a negative signed value is undefined in C++23; two's-complement representation does not make signed shifts wrap. Shifting any integer by an amount greater than or equal to its width is also undefined. Keep masks and shifts in an unsigned type, validate shift counts, and write `std::uint32_t{1} << 31` rather than `1 << 31`.

**Recognize it:** subset/flag problems over a fixed small universe (≤ 64 items maps naturally onto a 64-bit word), or a "count set bits / find lowest set bit / test power of two" primitive buried inside a larger problem.

**Breaks when:** `char` is treated as unsigned when indexing a table (§22.17), or a hand-rolled rotate/shift hits the UB cases above — both are real, exploitable bugs, not just style nits.

**Exercise:** let a set bit mean a free slot. Check `free == 0` before using `std::countr_zero(free)` to locate the lowest free bit, use `free &= free - 1` to allocate it, and `free |= (std::uint64_t{1} << k)` to release it. Test the empty/full boundaries and reject `k >= 64`.

---

## Recall card — Core
- Every technique's proof has two parts: an **invariant** (what's always true) and a **progress measure** (what strictly shrinks). State both before writing code.
- Two pointers/windows need monotonicity—a provably safe discard rule—and a window aggregate that supports cheap addition/removal directly or through an auxiliary structure.
- `lo < hi` terminates for integer bounds because `hi - lo` strictly decreases; use a fixed iteration count for a floating-point bracket, or search natural integer units such as ticks.
- DP = optimal substructure + overlapping subproblems; complexity is states × transition cost; without overlap, it's divide and conquer instead.
- Greedy needs a proof—exchange, staying-ahead, cut, or stronger structure—not just passing examples.
- BFS → shortest path in unweighted graphs (mark visited on enqueue); DFS → topological order/cycle detection (needs three-colour, not boolean, visited state for directed cycles); Dijkstra needs non-negative weights, and its stale-heap-entry skip is an efficiency optimization, not a correctness requirement.
- FSMs should make illegal transitions an explicit, checkable table entry, not a fallthrough — including duplicate/reordered real-world events.
- No performance number here is universal: crossovers (linear vs. binary search, table vs. branch chain) depend on element size, comparator cost, and the branch predictor's state — state that measurement is required, don't quote a fixed N.

## Questions — Core
1. What precondition makes converging two pointers valid, and what happens when it's violated?
2. When does a sliding window's aggregate stop being maintainable in O(1), and what structure replaces it?
3. Why does `lo < hi` terminate for integer binary search but not, as written, for a `double`-bounded search?
4. What must you prove before applying binary search on the answer, and what's the consequence of skipping that proof?
5. Does the C++ standard require `std::sort` to be introsort, or `std::nth_element` to have a linear worst case? What does it actually guarantee for each?
6. State the difference between divide and conquer and dynamic programming in terms of subproblem structure.
7. Give two different proof styles for a greedy algorithm. Why do passing examples not substitute for either?
8. Why must BFS mark a node visited at enqueue time rather than dequeue time?
9. Why does Dijkstra require non-negative edge weights, and is the "stale entry" skip in the lazy-deletion heap form required for correctness or only for efficiency?
10. Why does a finite-state machine's transition table need an explicit `Invalid` state rather than leaving illegal pairs unset?

## Common traps — Core

- Applying a discard rule without stating the ordering or monotonicity that makes it safe.
- Using a sliding window when negative values let an extension restore feasibility.
- Mixing closed and half-open intervals, especially when endpoints are equal.
- Omitting empty-input guards before subtracting one from an unsigned size.
- Letting DP update order reuse a value from the current item or row unintentionally.
- Treating a greedy rule as proved because it works on friendly examples.
- Marking BFS vertices too late, or using a Boolean visited flag for directed DFS cycle detection.
- Performing bit tricks on signed values or shifting by the type width.

## Code-reading puzzle — Core
```cpp
size_t hi = a.size() - 1;
while (lo < hi) {
    int s = a[lo] + a[hi];
    if (s == target) return {lo, hi};
    if (s < target) ++lo; else --hi;
}
```

Find two distinct bugs in this fragment (consider `a.size() == 0`, and consider `a` containing values near `INT32_MIN`/`INT32_MAX`), and state the minimal input that triggers each.

## Implementation exercise — Core
Implement a bounded event-sequencer: given a stream of `(sequence_number, event)` pairs that may arrive out of order or duplicated, and a finite-state machine over order-lifecycle events (New → PendingNew → Live → ... ), buffer out-of-order events up to a small window, apply them in sequence order, and treat both "duplicate already-applied event" and "true protocol violation" as distinct, explicit outcomes (not the same `Invalid` bucket). Write tests for: in-order delivery, one reordered pair, a duplicate delivery, and a genuine illegal transition.

## Prerequisites for Chapter 23 — Core
Chapter 23 assumes you can state a technique's complexity as a cost model (amortized argument from §22.11, states × transitions from §22.9) and identify where accumulators can overflow or lose floating-point precision (§22.9, §22.12). It develops fixed-point design, compensated/pairwise summation, and checked or saturating arithmetic.
