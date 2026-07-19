# Chapter 23 — Complexity and Numerical Correctness

*Interview-focused revision notes. The theme: two models that both lie. Asymptotic complexity ignores the memory hierarchy that dominates real runtime, and floating point ignores the arithmetic identities you were taught. This chapter is about knowing precisely where each model breaks and what to substitute.*

---

## 23.1 Asymptotic Notation

Asymptotic notation classifies how a cost function grows as input size grows without bound. The definitions are about *sets of functions*, and stating them precisely is the first filter.

| Notation | Definition | Reading |
|---|---|---|
| f = **O(g)** | ∃ c, n₀ : f(n) ≤ c·g(n) for all n ≥ n₀ | Upper bound; "grows no faster than" |
| f = **Ω(g)** | ∃ c, n₀ : f(n) ≥ c·g(n) for all n ≥ n₀ | Lower bound |
| f = **Θ(g)** | f = O(g) **and** f = Ω(g) | Tight bound |
| f = **o(g)** | ∀ c > 0, ∃ n₀ : f(n) < c·g(n) | Strictly smaller; f/g → 0 |
| f = **ω(g)** | ∀ c > 0, ∃ n₀ : f(n) > c·g(n) | Strictly larger |

Three things people get wrong:

**O is an upper bound, not a description of behaviour.** `O(n²)` is a true statement about a linear algorithm. Interviewers who ask "what is the complexity" almost always want Θ; saying "Θ(n log n)" instead of "O(n log n)" when you mean tight is a small but real signal.

**O is not the worst case.** Complexity class and case analysis are orthogonal axes (§23.2). "Quicksort is O(n log n)" is ambiguous — it is Θ(n log n) *average* and Θ(n²) *worst*. You can legitimately say "O(n²) worst case, Θ(n log n) expected."

**The constants and the n₀ are hidden by design and often decide the outcome.** Strassen's Θ(n^2.807) matrix multiply loses to a Θ(n³) SIMD-blocked kernel until n is in the hundreds. `std::map`'s Θ(log n) loses to a linear scan of a `std::vector` for n up to ~100 because the vector scan is a prefetched sequential stream and the tree is a chain of dependent cache misses. Van Emde Boas trees are Θ(log log u) and essentially unused.

### Growth ordering

```
O(1) < O(α(n)) < O(log log n) < O(log n) < O(log²n) < O(n^ε) < O(n) < O(n log n)
     < O(n log²n) < O(n²) < O(n³) < O(2ⁿ) < O(n!) < O(nⁿ)
```
α(n) is the inverse Ackermann function from union-find (Ch. 21) — bounded by 4 for any physically realizable n, so effectively constant.

**Log bases do not matter** (they differ by a constant factor) — except in the exponent, where they do: `n^log₂3 ≠ n^log₁₀3`.

### Amortized vs expected vs worst case

These three are routinely conflated and the distinction is a favourite probe:

- **Amortized** — a *guarantee* over a sequence of operations, with no randomness (§23.3). `vector::push_back` is amortized O(1): any n pushes cost O(n) total, always.
- **Expected** — an average over *randomness*, either in the input distribution or in the algorithm's own coin flips. Quickselect is expected O(n); a specific run can be O(n²).
- **Worst case** — a per-operation guarantee.

`unordered_map::find` is expected O(1) and worst-case O(n) — and the worst case is *reachable by an adversary*, which is why hash-flooding DoS attacks exist and why production hash maps use a per-process random seed (Ch. 12).

### What asymptotics does not model

It counts abstract operations, treating a cache hit and a DRAM access as identical when they differ by 200×. It ignores branch misprediction, SIMD width, and memory bandwidth. For the sizes real systems handle — a 10-level order book, a 64-entry symbol table, a 10⁶-element array — **the memory-hierarchy model (§23.5) predicts runtime far better than the RAM model does.** Being able to say that, with the crossover numbers, is the difference between reciting a course and having shipped something.

---

## 23.2 Best, Average and Worst-Case Complexity

Case analysis asks *which input* the bound describes. It is orthogonal to O/Θ/Ω.

| Algorithm | Best | Average | Worst | Worst-case trigger |
|---|---|---|---|---|
| Quicksort | Θ(n log n) | Θ(n log n) | **Θ(n²)** | Adversarial pivot sequence, sorted input with naive pivot |
| Insertion sort | **Θ(n)** | Θ(n²) | Θ(n²) | Reverse-sorted |
| Mergesort | Θ(n log n) | Θ(n log n) | Θ(n log n) | — (input-oblivious) |
| Heapsort | Θ(n log n) | Θ(n log n) | Θ(n log n) | — |
| Hash lookup | Θ(1) | Θ(1) | **Θ(n)** | All keys collide |
| BST search | Θ(1) | Θ(log n) | **Θ(n)** | Sorted insertion order → degenerate chain |
| Red-black / AVL search | Θ(1) | Θ(log n) | Θ(log n) | — |
| `vector::push_back` | Θ(1) | Θ(1) amortized | **Θ(n)** single op | Reallocation |
| Linear search | Θ(1) | Θ(n) | Θ(n) | Absent element |

**Input-oblivious algorithms** (mergesort, heapsort, radix sort, sorting networks) have identical best and worst cases. That property is worth more than raw speed in a latency-sensitive system: it makes p99 equal to p50. A "faster on average" algorithm with a bad tail is often the wrong choice on a trading hot path, where the tail *is* the metric (Ch. 43).

### Adversarial worst cases are a security property

The worst case matters when an attacker chooses the input:

- **Hash flooding** — colliding keys turn Θ(1) into Θ(n) per operation. Mitigation: seeded/keyed hashing (SipHash), or a tree fallback for oversized buckets (as Java's `HashMap` does).
- **Regex catastrophic backtracking** — NFA simulation on `(a+)+b` is exponential (Ch. 22 §22.19). Mitigation: a DFA engine such as RE2.
- **Quicksort killers** — a deterministic pivot rule has a computable adversarial sequence. Mitigation: introsort's heapsort fallback (Ch. 22 §22.5), or randomized pivots.
- **Algorithmic complexity attacks on parsers** — quadratic behaviour in header or field handling.

In market data, the "adversary" is usually not malicious but is real all the same: a burst that hits the worst case exactly when volume is highest. The correct discipline is to **budget for the worst case, not the average**, on anything in the critical path.

### The amortized-worst-case tension

`std::vector::push_back` is amortized Θ(1), but the reallocation is a single Θ(n) operation that will land on some unlucky message. In a hot path that is unacceptable jitter, and the fix is `reserve()` at startup — the general principle of Ch. 55: move variance out of the hot path even at the cost of average throughput.

---

## 23.3 Amortized Analysis

**Amortized cost** is total cost over a sequence divided by the number of operations, as a *guarantee* — no probability involved. It is the correct framing whenever an operation is usually cheap and occasionally expensive in a way that is paid for by the cheap ones.

Three standard methods:

**Aggregate.** Bound the total for n operations, divide. `vector::push_back` with doubling: reallocation copies 1 + 2 + 4 + … + n < 2n elements total, so n pushes cost O(n), so each is amortized O(1). The geometric series is the entire argument.

**Accounting (banker's).** Charge each operation more than it costs and save the credit. Each `push_back` is charged 3 units: 1 to write the element, 2 saved. When the vector doubles from n/2 to n, the n/2 newest elements have each saved 2 credits = n credits, exactly paying for the n-element copy. The invariant "credit is never negative" is the proof obligation.

**Potential.** Define Φ(state) ≥ 0 with Φ(initial) = 0; amortized cost = actual + ΔΦ. For a dynamic array, Φ = 2·size − capacity. This is the method to reach for when the structure has a natural "messiness" measure — it is how splay trees, Fibonacci heaps, and union-find with path compression are analysed.

### The growth-factor question

Why doubling? Growth factor k gives amortized cost k/(k−1) per element:

| k | Amortized copies/element | Memory overhead |
|---|---|---|
| 1.5 (MSVC) | 3 | Up to 50%; **can reuse freed blocks** — sum of all previous allocations exceeds the next request |
| 2 (libstdc++, libc++) | 2 | Up to 100%; never reuses previous blocks (1+2+4+…+2^(k-1) = 2^k − 1 < 2^k) |
| 1.0 (+constant) | **Θ(n) amortized** | Minimal — and this is the wrong answer |

Constant growth destroys the amortization: n pushes cost Θ(n²). Any growth factor > 1 gives O(1). The 1.5-vs-2 argument about block reuse is real for a naive bump allocator but largely irrelevant with modern size-class allocators (Ch. 7) — mention it as a known argument, not as settled fact.

### Where amortized guarantees break

- **They are not per-operation bounds.** A latency-sensitive system cares about the Θ(n) spike, not the Θ(1) average. `reserve()`, fixed-capacity containers (`std::inplace_vector`, Ch. 11 §11.6), or pool allocators (Ch. 7) convert amortized into worst-case.
- **They do not survive an adversarial reset.** Repeatedly pushing to trigger a realloc then popping back is a well-known attack on structures that shrink eagerly; this is exactly why `vector` never shrinks on `pop_back` and why `shrink_to_fit` is an explicit, non-binding request.
- **Hash table rehashing** is the same story: amortized O(1) insert, but a rehash is Θ(n) with n allocations and full re-probing. `reserve(expected)` before the hot path.
- **Union-find with path compression + union by rank** is amortized O(α(n)) — the classic non-trivial potential argument, worth naming.

---

## 23.4 Space-Time Tradeoffs

Nearly every optimization is an exchange of one resource for another. The catalogue:

| Technique | Buys | Costs |
|---|---|---|
| Memoization / DP tables | Exponential → polynomial time | O(states) memory |
| Precomputed lookup tables | Branches and arithmetic → one load | Table footprint, cache pressure |
| Hash index / secondary index | O(n) scan → O(1) lookup | O(n) memory, update cost, invalidation |
| Prefix sums (Ch. 22 §22.13) | O(n) range query → O(1) | O(n) memory, O(n) rebuild on update |
| Sparse table | O(n) range-min → O(1) | O(n log n) memory |
| Compression (bitsets, varint, delta) | Memory and bandwidth | Decode CPU |
| **Recomputation** | Memory and bandwidth | CPU |
| Bloom filter (Ch. 21) | Definite-negative in O(1) with tiny memory | False positives; no deletion |
| Streaming sketches (HLL, t-digest) | O(1) memory for approximate aggregates | Bounded error |

### The modern inversion

The classic instinct — cache the result to save the computation — is frequently **backwards on current hardware**. A DRAM access costs ~200–300 cycles; a floating-point multiply costs 4. If a lookup table falls out of L2, recomputing the value from registers is faster than reading it. This is the reason `sin`/`cos` lookup tables lost to polynomial approximation, why decompressing data in L1 beats reading uncompressed data from DRAM, and why compressed columnar formats are faster to scan than raw arrays.

The rule of thumb: **a table wins only if it stays in L1/L2 and replaces more than ~10–20 cycles of work.** A 4 KB table is fine; a 4 MB table is a cache-eviction machine that also destroys the performance of everything else running on that core.

### Cache pressure is a shared, invisible cost

A table that fits comfortably in a 32 MB L3 still evicts other threads' working sets on the same socket. Measuring a microbenchmark in isolation systematically under-counts this. `perf stat -e LLC-load-misses` on the *whole system*, or Intel CAT/way-partitioning experiments (Ch. 28), are how you find it.

### Low-latency framing

In trading systems the trade is usually stated as **precompute-at-startup vs compute-on-tick**. Anything derivable from reference data — instrument tables, tick-size ladders, risk limits, fee schedules, decimal scaling factors — is computed once at startup into flat arrays indexed by a dense instrument ID, because the hot path must not allocate, hash, or branch on reference data. Conversely, do *not* precompute a giant per-instrument × per-price matrix that will not fit in cache; compute it from two small tables instead. The decision is made by working-set size, not by operation count.

---

## 23.5 Cache Complexity

The RAM model assumes uniform O(1) memory access. The **external-memory (cache-aware) model**, due to Aggarwal and Vitter, replaces it with two parameters:

- **M** — cache size in bytes
- **B** — block (cache-line) size

Cost is counted in **memory transfers** (cache misses), not instructions. This model predicts real runtime dramatically better than instruction counts for anything above L2.

### Canonical results

| Problem | RAM model | Cache complexity (transfers) |
|---|---|---|
| Sequential scan of n elements | Θ(n) | **Θ(n/B)** — one miss per line, then prefetched |
| Random access, n probes over n ≫ M | Θ(n) | **Θ(n)** — one miss each; B buys nothing |
| Binary search | Θ(log n) | Θ(log(n/B)) — the last few levels share lines |
| Sorting (mergesort / funnel) | Θ(n log n) | **Θ((n/B)·log_{M/B}(n/B))** — the sorting bound |
| B-tree search (Ch. 21) | Θ(log n) | Θ(log_B n) — the whole point of B-trees |
| Naive n³ matmul | Θ(n³) | Θ(n³/B + n²) — poor |
| **Tiled** matmul | Θ(n³) | **Θ(n³/(B·√M))** — same instructions, √M fewer misses |

The tiled-matmul line is the headline result: identical asymptotic instruction count, a factor of √M fewer memory transfers, and in practice a 5–10× wall-clock improvement. Complexity did not change; the cost model did.

### The concrete numbers to have ready

| Access | Latency | Note |
|---|---|---|
| L1 hit | ~4 cycles (~1 ns) | 32–48 KB, ~8-way |
| L2 hit | ~12–14 cycles (~4 ns) | 512 KB–2 MB |
| L3 hit | ~40–50 cycles (~15 ns) | Shared across the socket |
| DRAM | ~200–300 cycles (~70–100 ns) | Plus row-buffer effects (Ch. 29) |
| Remote NUMA DRAM | ~350–500 cycles (~150 ns) | Ch. 29 |
| TLB miss + page walk | ~30–100 cycles extra | Huge pages mitigate (Ch. 32) |

A 64-byte line holds 16 `int32_t` or 8 pointers. **A sequential scan of `int32_t` gets 16 elements per miss; a linked-list traversal gets one node per miss** — and worse, the misses are serialized because the next address is not known until the current load returns, so there is no memory-level parallelism (Ch. 29). This is why `std::vector` beats `std::list` by 10–50× for traversal even when `std::list` has better insertion complexity, and it is the most reliably asked container question in the discipline.

### Consequences for structure choice

- **Array of structures vs structure of arrays** (Ch. 42): if you touch one field of many records, SoA loads only the field you need and gets B/sizeof(field) per miss instead of B/sizeof(record).
- **Node-based containers** (`std::map`, `std::list`, `std::unordered_map` with chaining) pay one miss per node and destroy prefetching. Flat containers (Ch. 12) trade O(n) insertion for O(1)-miss lookup and usually win.
- **Hot/cold splitting**: move rarely-touched fields into a separate structure so the hot fields pack more densely per line.
- Prefetchers detect sequential and constant-stride patterns and multiple concurrent streams; they do not detect pointer chasing. Software prefetch (`__builtin_prefetch`) is the manual escape (Ch. 28).

---

## 23.6 Cache-Oblivious Algorithms

A **cache-oblivious** algorithm achieves asymptotically optimal cache complexity **without knowing M or B**. It therefore performs optimally at *every* level of the hierarchy simultaneously — L1, L2, L3, DRAM, and disk — and does not need retuning for a new CPU.

The mechanism is almost always **recursive subdivision**: keep halving the problem, and at some level of the recursion the subproblem fits in whatever cache you name; from that point down, the entire subtree runs at zero additional misses. You never had to name the level.

### Cache-aware vs cache-oblivious

| | Cache-aware (tiled/blocked) | Cache-oblivious (recursive) |
|---|---|---|
| Knows M, B | Yes — tile size is a tuned parameter | No |
| Optimal at | The one level it was tuned for | **All levels** |
| Retuning | Per microarchitecture | None |
| Peak performance | Usually higher (hand-tuned) | Slightly lower constants |
| Complexity | Simple loops | Recursion overhead near the base case |

In practice the best implementations are hybrids: recursive subdivision down to a tuned, hand-vectorized base case. That is precisely what BLAS libraries, `std::sort`, and FFTW do — and stating that hybrid conclusion is the strong answer.

### The examples

- **Recursive matrix multiply and transpose.** Split each dimension in half and recurse. Achieves Θ(n³/(B√M)) with no tile parameter.
- **Funnelsort / cache-oblivious mergesort.** Achieves the optimal sorting bound Θ((n/B)log_{M/B}(n/B)).
- **Van Emde Boas layout** — recursively lay out a tree so that any root-to-leaf path touches Θ(log_B n) blocks. This is the cache-oblivious analogue of a B-tree, and it is the *reason* the Eytzinger/vEB binary-search layouts of Ch. 22 §22.3 work.
- **Cache-oblivious B-trees / packed-memory arrays** for dynamic ordered sets.

### FFTW as the case study

FFTW is worth naming: it uses recursive decomposition (cache-oblivious in structure) plus a runtime **planner** that measures the actual machine and selects among generated codelets. It is the standard illustration that the theoretically clean approach and the empirically tuned approach are complementary, not competing.

### Practical caveat

Cache-oblivious analysis assumes an ideal fully-associative cache with optimal replacement. Real caches are 8–16-way set-associative with pseudo-LRU, so conflict misses (Ch. 28) can appear where the model predicts none — most visibly with power-of-two strides, which map many addresses to the same set. The classic fix is padding array rows to a non-power-of-two stride, which the model does not predict at all.

---

## 23.7 Numerical Stability

A computation is **numerically stable** if small perturbations in the input (or the rounding errors introduced along the way) produce correspondingly small perturbations in the output. Two distinct notions must be separated, because the interview answer usually hinges on which one applies:

- **Conditioning** is a property of the *problem*. A problem is ill-conditioned if its true answer is hypersensitive to input perturbation. No algorithm can fix it.
- **Stability** is a property of the *algorithm*. A stable algorithm produces the exact answer to a slightly perturbed problem (backward stability).

`error ≈ condition_number × algorithm_error`. If the condition number is 10¹⁶, `double`'s 16 digits buy you nothing regardless of algorithm.

### Catastrophic cancellation

The dominant failure mode. Subtracting two nearly-equal floating-point numbers is *exactly* representable in the result's precision — the subtraction itself introduces no new error — but it **exposes** the error already present in the operands by cancelling all the leading correct digits.

```cpp
double a = 1.0000000001, b = 1.0;
double d = a - b;          // subtraction is exact; result 1.000000082740371e-10
                           // but a's own representation error is now 100% of d
```

The canonical instance is the quadratic formula:

```cpp
// UNSTABLE when b² ≫ 4ac: one root computes -b + b, cancelling catastrophically.
double r1 = (-b + std::sqrt(b*b - 4*a*c)) / (2*a);

// STABLE: compute the root that does NOT cancel, then use r1*r2 == c/a.
double q  = -0.5 * (b + std::copysign(std::sqrt(b*b - 4*a*c), b));
double r1 = q / a, r2 = c / q;
```
Also: `1 - cos(x)` for small x (use `2*sin²(x/2)`), `exp(x) - 1` (use `std::expm1`), `log(1+x)` (use `std::log1p`), and the **naive variance formula** `E[x²] − E[x]²`, which cancels catastrophically when the mean is large relative to the spread and can even return a negative variance. Use Welford's online algorithm:

```cpp
// Welford: numerically stable streaming mean and variance.
void update(double x) {
    ++n;
    double delta = x - mean;
    mean += delta / n;
    m2   += delta * (x - mean);      // note: uses the UPDATED mean
}
double variance() const { return n > 1 ? m2 / (n - 1) : 0.0; }
```
This matters directly in trading: rolling volatility over prices near 50,000 with variance near 0.01 is exactly the regime where `E[x²]−E[x]²` loses every significant digit.

### Other stability rules

- **Ordering matters.** Summing ascending by magnitude preserves more precision than descending; floating-point addition is commutative but **not associative** (§23.9).
- **Avoid subtracting large near-equal quantities**; reformulate algebraically first. This is the general fix and it is almost always available.
- **Avoid dividing by near-zero**; a small denominator amplifies error by 1/denominator.
- **Iterative refinement** — solve, compute the residual in higher precision, correct — recovers accuracy cheaply for linear systems.
- **Higher precision is a fallback, not a fix.** `long double` (80-bit on x86 SysV) or `__float128` buys digits; it does not fix an unstable formulation and it costs speed and SIMD width.

---

## 23.8 Floating-Point Comparison

Ch. 2 §2.5 covered IEEE-754 representation. This section is exclusively about comparison, which is where most production floating-point bugs actually live.

**`==` on computed floats is almost always wrong.** `0.1 + 0.2 != 0.3` because none of the three is exactly representable in binary and the rounding differs. `0.1+0.2` is 0.30000000000000004.

### The four comparison strategies

| Strategy | Form | When correct |
|---|---|---|
| **Absolute epsilon** | `std::abs(a-b) < eps` | Only when values are near a known scale (and near zero) |
| **Relative epsilon** | `std::abs(a-b) <= eps * std::max(abs(a), abs(b))` | General magnitudes; **fails near zero** (relative error is meaningless there) |
| **Combined** | `abs(a-b) <= max(abs_eps, rel_eps*max(abs(a),abs(b)))` | The practical default |
| **ULP distance** | integer difference of bit patterns | Exact control of representable steps |

```cpp
bool almost_equal(double a, double b, double rel = 1e-9, double abs_eps = 1e-12) {
    double d = std::abs(a - b);
    if (d <= abs_eps) return true;                       // handles the near-zero regime
    return d <= rel * std::max(std::abs(a), std::abs(b));
}
```

### ULP comparison

For positive IEEE-754 values, the bit pattern reinterpreted as an unsigned integer is **monotone in the value** — consecutive representable doubles are consecutive integers. That gives an exact "how many representable values apart" metric:

```cpp
int64_t ulp_distance(double a, double b) {
    auto ia = std::bit_cast<int64_t>(a), ib = std::bit_cast<int64_t>(b);
    if ((ia < 0) != (ib < 0)) return (a == b) ? 0 : INT64_MAX;   // ±0.0 compare equal
    return std::abs(ia - ib);
}
```
`std::nextafter` walks one ULP. Note the sign-bit special case: IEEE uses sign-magnitude, not two's complement, so negatives are ordered *backwards* as integers.

### NaN and the ordering trap

`NaN` compares **false against everything, including itself**. Consequences:

- `x != x` is the classic NaN test (`std::isnan` is clearer and equally free).
- A comparator that can see NaN **violates strict weak ordering**, and `std::sort` with a violated comparator is undefined behaviour — in libstdc++ it reads past the end of the array and segfaults, a well-known and genuinely surprising crash. Sanitize NaNs before sorting, or use `std::strong_order` / a total-order comparator.
- `std::set<double>`, `std::map<double,...>` with NaN keys corrupt the tree invariants.
- `-0.0 == 0.0` is true, but they have different bit patterns — which is why `std::has_unique_object_representations_v` is false for float types (Ch. 3 §3.2) and why byte-comparing floats is wrong.

C++20 added `std::partial_order`, `std::weak_order`, and `std::strong_order`, which give an IEEE-754 totalOrder — NaNs ordered, −0.0 < +0.0 — and are the correct tool when floats must be keys.

### The real answer

For **money and prices, do not compare floats at all** — use scaled integers (§23.10). Every epsilon scheme is a heuristic with a wrong regime; exact integer arithmetic has none. Reaching for fixed point instead of tuning an epsilon is the answer that signals production experience.

---

## 23.9 Kahan Summation

Floating-point addition is **not associative**: `(a+b)+c ≠ a+(b+c)`. Naive summation of n values accumulates rounding error that grows as **O(n·ε)** in the worst case and O(√n·ε) statistically, where ε ≈ 2.2×10⁻¹⁶ for `double`. Summing 10⁸ small values into a large running total can lose every digit — in the extreme, adding 1.0 to a `double` accumulator already at 2⁵³ changes nothing at all, so the sum stalls permanently.

**Kahan (compensated) summation** carries the lost low-order bits in a separate compensation variable:

```cpp
double kahan_sum(std::span<const double> v) {
    double sum = 0.0, c = 0.0;            // c accumulates the running error
    for (double x : v) {
        double y = x - c;                 // apply pending correction
        double t = sum + y;               // this addition rounds...
        c = (t - sum) - y;                // ...and this recovers exactly what was lost
        sum = t;
    }
    return sum;
}
```
Error becomes **O(ε)** — independent of n (plus an O(nε²) term). Cost is 4 flops per element instead of 1.

**Neumaier's variant** additionally handles the case where the incoming value is larger in magnitude than the running sum, which plain Kahan mishandles; it is the better default. **Klein / second-order Kahan** compensates the compensation.

### The compiler trap

`-ffast-math` (and `-fassociative-math`) tells the compiler that FP arithmetic is associative — so it **algebraically simplifies `c = (t - sum) - y` to zero and deletes the entire compensation**. Kahan summation silently becomes naive summation with extra instructions. This is the single most important practical fact about the technique.

Defences: compile the summation TU without fast-math; mark the accumulators `volatile` (blunt, slow); use `#pragma float_control` / `__attribute__((optimize("no-fast-math")))`; or in C++26 use the standard `[[no_fast_math]]`-style controls and `std::fenv`-aware pragmas. Verify by inspecting the assembly on Compiler Explorer (Ch. 44) — the absence of the compensation instructions is visible immediately.

### The alternatives

| Method | Error | Cost | Notes |
|---|---|---|---|
| Naive | O(nε) | 1 add | Vectorizes; fine for small n |
| **Pairwise / cascaded** | **O(ε log n)** | ~1 add | Recursive halving; what NumPy and most SIMD reductions do *for free* |
| Kahan | O(ε) | 4× | Defeated by fast-math |
| Neumaier | O(ε) | 4× | Handles magnitude inversion |
| Sorted ascending then naive | O(ε log n)-ish | + sort | Rarely worth it |
| `long double` / `__float128` accumulator | Extra digits | 2–10× | Not a fix for unstable formulations |
| **Integer / fixed-point accumulation** | **Exact** | 1 add | The correct answer for money |

**Pairwise summation is the best default**: near-Kahan accuracy at naive cost, and a SIMD reduction with 4 or 8 partial accumulators already performs it implicitly — which is a nice observation, since vectorizing a sum *improves* its accuracy as well as its speed.

For trading: never accumulate PnL, position value, or notional in `double`. Use `int64_t` in minor units or a fixed-point type (§23.10). Exact, no drift, no fast-math hazard, and faster.

---

## 23.10 Fixed-Point Price Arithmetic

**Fixed-point** represents a real number as an integer scaled by a fixed power of ten (or two): value = raw / 10^s, where s is the **scale**. It is exact for decimal quantities, which is the property `double` cannot provide.

### Why prices must not be `double`

- `0.1` is not representable in binary; a price of 100.10 is stored as 100.09999999999999432.
- `double` has 53 bits ≈ 15–16 decimal digits. Prices × quantities × many instruments can exceed that; a notional of 10¹⁶ minor units has already lost the cents.
- Accumulated PnL drifts (§23.9), so books do not reconcile.
- Regulatory and exchange semantics are decimal: tick sizes, price bands, and rounding rules are specified in decimal, and binary floating point cannot represent the tick grid exactly.
- Equality and ordering comparisons become epsilon heuristics (§23.8).

### The representation

```cpp
// Price in ticks or in a fixed decimal scale. Scale is part of the TYPE, not a runtime field.
template <int Scale>
struct Fixed {
    int64_t raw;                                    // value = raw / 10^Scale
    static constexpr int64_t kFactor = pow10(Scale);
    constexpr double to_double() const { return double(raw) / kFactor; }  // display only
};
using Price = Fixed<8>;      // 8 decimals: range ±9.2e10 at 1e-8 resolution
using Qty   = Fixed<0>;
```

Range analysis for `int64_t` (±9.22×10¹⁸):

| Scale | Resolution | Max value | Suitable for |
|---|---|---|---|
| 10⁻² | cent | 9.2×10¹⁶ | Cash amounts |
| 10⁻⁴ | pip | 9.2×10¹⁴ | FX, most equities |
| 10⁻⁸ | satoshi | 9.2×10¹⁰ | Crypto, precise FX |
| 10⁻⁹ | nano | 9.2×10⁹ | Only if values are small |

**Multiplication is where the scale bites.** `Fixed<s> × Fixed<s>` produces scale 2s and must be rescaled — and the intermediate overflows `int64_t` routinely.

```cpp
// Notional = price * quantity. Intermediate needs 128 bits.
__int128 prod = __int128(price.raw) * qty.raw;          // scale = 2s
int64_t  notional = int64_t(prod / Price::kFactor);     // back to scale s; truncates
```
`__int128` is a GCC/Clang extension (MSVC uses `_mul128`); C++26's `std::(u)int128_t` standardizes it. On x86-64 a 64×64→128 multiply is a single `MUL` instruction with the result in RDX:RAX — the "wide intermediate" costs essentially nothing, which removes the usual objection.

**Division must round explicitly**, never implicitly: C++ integer division truncates toward zero, so `-7/2 == -3`, not −4. For prices this is a real, auditable difference (§23.11).

### Alternatives and their costs

| Option | Exact decimal | Speed | Notes |
|---|---|---|---|
| `int64_t` scaled (hand-rolled) | Yes | Fastest | The production answer; scale in the type |
| `double` | **No** | Fast | Only for analytics and display |
| `long double` | No | Slow | 80-bit, not portable, no SIMD |
| Boost.Multiprecision `cpp_dec_float` | Yes | Very slow | Allocating; never on a hot path |
| IEEE-754 **decimal64/128** (C++23 `<stdfloat>` proposals, `_Decimal64`) | Yes | Slow in software | Hardware support only on IBM POWER/z |
| Integer **ticks** (price as a count of tick sizes) | Yes | Fastest | Requires a per-instrument tick ladder; makes the book an array index |

**Representing price as an integer number of ticks** is the strongest form: it makes every price a small dense integer, which turns the order book into a direct-indexed array (Ch. 50), makes price comparison a single integer compare, and eliminates rounding at the tick grid entirely. The cost is a per-instrument conversion table and complexity when the tick size varies by price band.

---

## 23.11 Scale Conversion and Rounding

Every system boundary is a scale conversion: the exchange's wire format, your internal representation, the risk engine's, and the display. Each conversion is a potential rounding decision, and unspecified rounding is how positions fail to reconcile.

### Rescaling

```cpp
// Upscale: exact, but may overflow.
int64_t up(int64_t raw, int from, int to) { return raw * pow10(to - from); }

// Downscale: LOSSY — the rounding mode must be chosen explicitly.
int64_t down_half_up(int64_t raw, int from, int to) {
    int64_t d = pow10(from - to);
    return (raw >= 0) ? (raw + d/2) / d : -((-raw + d/2) / d);
}
```
Note the sign handling: naive `(raw + d/2)/d` rounds −0.5 toward zero on truncating division, silently giving asymmetric behaviour for shorts versus longs. That asymmetry is exactly the kind of bug that shows up as a systematic PnL bias.

### The rounding modes

| Mode | −2.5 | −1.5 | 1.5 | 2.5 | Use |
|---|---|---|---|---|---|
| Toward zero (truncate) | −2 | −1 | 1 | 2 | C++ integer `/`; **biased toward zero** |
| Floor | −3 | −2 | 1 | 2 | Bid-side conservative rounding |
| Ceiling | −2 | −1 | 2 | 3 | Ask-side conservative rounding |
| Half away from zero | −3 | −2 | 2 | 3 | Common commercial convention |
| **Half to even (banker's)** | **−2** | **−2** | **2** | **2** | IEEE-754 default; **unbiased over many roundings** |
| Half toward zero | −2 | −1 | 1 | 2 | Rare |

Half-to-even is the IEEE default precisely because half-away-from-zero introduces a systematic upward bias — summed over millions of roundings, that bias is money. State that reason; it is the point of the question.

### Domain-correct rounding

Rounding in a trading system is not a numerical decision, it is a **risk** decision:

- **Round prices toward the passive side.** A buy limit rounds *down* to the tick grid, a sell limit rounds *up*, so rounding never makes an order more aggressive than intended. Rounding "to nearest" can cross the spread.
- **Round quantities down** to the lot size; rounding up can breach a position limit or create an unfillable residual.
- **Round fees and margin against yourself** (ceiling for what you owe, floor for what you receive) so you never under-reserve.
- **Round once, at the boundary.** Repeated round-trip conversions compound error; carry full precision internally and round only when emitting.

### Validation

The tick-grid check is a mandatory pre-trade validation (Ch. 56): an order whose price is not an exact multiple of the tick size is rejected by the exchange, and discovering that at the venue costs a round trip.

```cpp
constexpr bool on_tick_grid(int64_t price_raw, int64_t tick_raw) {
    return tick_raw > 0 && price_raw % tick_raw == 0;
}
```
With integer prices this is one `IDIV`-free check if the tick is a power of two, or one modulo otherwise — cheap enough for the hot path. With `double` prices it is not expressible at all, which is another argument for §23.10.

---

## 23.12 Checked and Saturating Arithmetic

Signed integer overflow is **undefined behaviour** in C++ (Ch. 2 §2.4); unsigned overflow wraps, which is defined but usually still a bug. Both silently produce wrong risk numbers. Three disciplines exist for handling it.

### Checked arithmetic

Detect the overflow and report it. The correct primitives are the compiler builtins, which read the hardware overflow flag and cost a single `jo`/`jc` after the arithmetic:

```cpp
int64_t r;
if (__builtin_add_overflow(a, b, &r)) return error;      // GCC/Clang; MSVC: <intsafe.h>
// C++26: std::add_sat / sub_sat / mul_sat plus checked forms;
// C++20 gave std::cmp_less etc. for safe MIXED-SIGN comparison.
```
Hand-written pre-checks (`if (a > INT64_MAX - b)`) are correct but longer and easy to get wrong for multiplication and for the `INT_MIN / -1` and `-INT_MIN` cases, which trap on x86 (`IDIV` raises `#DE`) rather than merely overflowing.

**Cost:** the branch is perfectly predicted in the non-overflow case, so the practical cost is near zero — typically one extra instruction and no mispredicts. "Overflow checks are too slow for the hot path" is usually false and worth pushing back on.

### Saturating arithmetic

Clamp at the type's limits instead of wrapping. C++26 standardizes `std::add_sat`, `sub_sat`, `mul_sat`, `div_sat`, and `saturate_cast` in `<numeric>`. SIMD has had saturating instructions forever (`PADDSW`, `PACKSSDW`) — used in DSP and image processing where clamping is semantically right.

Saturation is right when the value is a **measurement** (a counter, a clamped signal). It is wrong for money: a saturated notional is a silently incorrect risk number, and silence is the worst property a risk system can have. Prefer checked-and-reject there.

### Wrapping arithmetic

Explicit modular arithmetic on unsigned types. Correct and intended for hash mixing, PRNGs, CRCs, and — importantly — **sequence-number arithmetic**, where you compare with wraparound-safe signed differences:

```cpp
// Correct for a wrapping 32-bit sequence space (TCP-style, Ch. 38).
bool seq_lt(uint32_t a, uint32_t b) { return int32_t(a - b) < 0; }
```
Not `a < b`, which breaks across the wrap point. This exact idiom appears in TCP, in exchange sequence-number handling (Ch. 53), and in lock-free ring buffers (Ch. 26), where the wraparound comparison is what makes a bounded queue work.

### Detection tooling

| Tool | Catches | Cost |
|---|---|---|
| **UBSan** `-fsanitize=signed-integer-overflow,shift,integer-divide-by-zero` | Signed overflow, bad shifts | ~2× |
| UBSan `-fsanitize=unsigned-integer-overflow` | Unsigned wrap | Noisy — flags intentional hashing |
| `-ftrapv` | Signed overflow → abort | Slower, less precise than UBSan; largely superseded |
| `-fwrapv` | Makes signed overflow *defined* as wrapping | Removes UB but loses loop optimizations |
| `-Wconversion`, `-Wsign-conversion` | Narrowing and sign changes at compile time | Free; noisy on legacy code |
| Static analysis / clang-tidy `bugprone-*` | Patterns | Free |

Run UBSan in CI, always. Signed overflow UB is not academic: compilers exploit it to assume `i + 1 > i`, which turns an overflow check written that way into dead code the compiler deletes — the classic "my overflow check disappeared at -O2" bug.

---

## 23.13 Sentinel-Value Hazards

A **sentinel** is an in-band value reserved to mean "absent", "invalid", or "unset" — `-1`, `0`, `INT_MAX`, `NaN`, `0xFFFFFFFF`, an empty string. It is compact and cache-friendly, and it is a recurring source of correctness failures because *the sentinel is a legal value of the domain type*.

### The failure modes

- **The sentinel becomes valid data.** `-1` for "no price" breaks the day a market goes negative — which happened to WTI crude in April 2020, and broke systems worldwide that used non-positive prices as a sentinel. `0` for "no quantity" collides with a legitimate zero. `0xFFFF` for "no instrument" collides once the universe exceeds 65534 instruments.
- **Arithmetic on sentinels silently propagates.** `INT_MAX + w` overflows (Ch. 22 §22.17); `NaN` propagates through every subsequent computation and surfaces far from its origin; summing an array containing a `-1` sentinel produces a plausible wrong number rather than an error.
- **Comparisons rank sentinels.** `INT_MAX` as "no value" sorts to the end (sometimes desired) but also wins a `min()` reduction incorrectly if the polarity is reversed. `NaN` breaks strict weak ordering outright (§23.8).
- **Every reader must know the convention.** The sentinel is a protocol carried in documentation, not in the type. A new consumer that does not check is a latent bug, and there is no compiler diagnostic.

### The alternatives

| Approach | Cost | Type-safe | Notes |
|---|---|---|---|
| `std::optional<T>` (Ch. 15 §15.3) | +1 byte + padding (`sizeof(optional<int>) == 8`) | **Yes** | Cannot be dereferenced without a check by accident *in review*; `operator*` on empty is still UB |
| `std::expected<T,E>` (C++23) | Similar | Yes | Carries a *reason*, which sentinels never do |
| Separate presence bitmap / valid flag | 1 bit per field | Partly | Keeps the payload dense; good for SoA layouts |
| **Named constant sentinel** (`kNoPrice`) with a checked accessor | 0 | No | The pragmatic hot-path choice — but centralize the check |
| Strong typedef wrapping the sentinel | 0 | Yes | `struct Price { int64_t raw; bool valid() const; }` — zero-overhead and self-documenting |

`std::optional` is the right default, but note its real costs on a hot path: it adds a byte plus padding (doubling an 8-byte payload's footprint), it may inhibit vectorization, and it is not trivially copyable for non-trivial `T` (Ch. 3 §3.5). In a packed market-data structure where every byte per instrument matters, a documented sentinel plus a **separate validity bitmap** is often the correct engineering choice — the bitmap is dense, cache-friendly, and checkable with one `AND`.

### The discipline

If you must use a sentinel:

1. **Choose a value outside the representable domain**, not merely outside the currently observed one. For a scale-8 `int64_t` price, `INT64_MIN` is unreachable by any real price; `-1` is not.
2. **Name it** (`inline constexpr int64_t kNoPrice = INT64_MIN;`) and never write the literal.
3. **Check at the boundary**, once, on ingest — not at every use site.
4. **Assert it never enters arithmetic.** A debug-build check on the accumulator catches sentinel leakage immediately.
5. **Document it in the wire format** (Ch. 51), since real exchange protocols do exactly this — ITCH and OUCH both use reserved values for "market order price" and similar, and misreading one is a live-trading incident.

---

## 23.14 Decimal Conversion and Tick Precision

Converting between decimal text and internal numeric representation sits on both the parse hot path (market data) and the emit hot path (order entry), and it is a place where correctness and speed genuinely conflict.

### Parsing

```cpp
// C++17 <charconv>: no locale, no allocation, no exceptions, fastest available.
int64_t v;
auto [ptr, ec] = std::from_chars(begin, end, v);           // integer overload: C++17
if (ec != std::errc{}) return reject();
double d;
std::from_chars(begin, end, d, std::chars_format::fixed);  // FP overload: C++17, shipped
                                                           // GCC 11+ / MSVC 19.24+ / libc++ 20
```
Ch. 13 §13.6 covers `<charconv>` in full. The essentials for this chapter:

| Method | Locale-free | Allocates | Throws | Speed |
|---|---|---|---|---|
| `std::from_chars` / `to_chars` | **Yes** | No | No | Fastest; round-trip exact |
| `std::stod`, `std::stoi` | **No** — locale-dependent | Yes (`std::string`) | Yes | Slow |
| `strtod`, `atoi` | No (C locale) | No | No (`errno`) | Moderate |
| `std::istringstream` | No | Yes | Configurable | ~100× slower |
| `sscanf` | No | No | No | Slow |

**Locale dependence is the trap:** in a `de_DE` locale, `strtod("1.5")` parses as 1 because the decimal separator is a comma. A process that calls `setlocale` (or links a library that does) can silently corrupt every price it parses. `from_chars` is immune by specification — this is the reason it exists and the reason to use it unconditionally in a feed handler.

### Fixed-point decimal parsing, exactly

For a fixed-scale price field, do not route through `double` at all — parse the integer and fractional parts as integers:

```cpp
// Parse "123.45" at scale 4 → 1234500. Exact, no FP, ~few ns.
int64_t parse_fixed(std::string_view s, int scale) {
    bool neg = !s.empty() && s[0] == '-'; if (neg) s.remove_prefix(1);
    auto dot = s.find('.');
    int64_t ip = 0, fp = 0; int fdigits = 0;
    std::from_chars(s.data(), s.data() + std::min(dot, s.size()), ip);
    if (dot != std::string_view::npos) {
        auto f = s.substr(dot + 1);
        fdigits = int(f.size());
        std::from_chars(f.data(), f.data() + f.size(), fp);
    }
    int64_t v = ip * pow10(scale) + rescale(fp, fdigits, scale);   // rescale rounds (§23.11)
    return neg ? -v : v;
}
```
Going through `double` introduces a rounding step that fixed point exists to avoid, and it is slower.

### Formatting

`std::to_chars` with `std::chars_format::general` and no precision produces the **shortest round-trippable representation** — the Ryū/Grisu-family guarantee that `from_chars(to_chars(x)) == x` exactly, with the fewest digits. That is the correct default for logging and serializing doubles; `printf("%.17g")` round-trips but is verbose and slow, and `%.6f` (iostream's default precision of 6 significant digits) **silently truncates**, which is how a price of 100.123456789 gets logged as 100.123 and an investigation goes sideways.

For fixed-point, formatting is integer division and digit emission — exact, branch-light, and roughly an order of magnitude faster than any floating-point formatter.

### Tick precision

The tick size is the minimum price increment, and it is a **decimal** quantity (0.01, 0.0001, 1/32 for some treasuries). Consequences:

- Represent prices as integer multiples of the tick where possible (§23.10) — then tick validation is `price % tick == 0` and price-level indexing is `(price - base) / tick`, both integer ops.
- **Tick ladders vary by price band** on many venues (finer ticks at lower prices). The mapping from price to level index is then piecewise, and must come from a reference-data table, not a formula.
- **Fractional ticks** (32nds and 64ths for US treasuries) mean a decimal scale alone is insufficient; use a rational representation or a scale fine enough to represent 1/32 exactly (a scale of 10⁻⁶ does not represent 1/3 but does represent 1/32 = 0.03125 exactly, since 32 is a power of two).
- **Tick size changes** are reference-data events (Ch. 49). Cached derived tables — price-to-index maps, collar bounds — must be rebuilt on change, and a stale ladder produces rejected orders at exactly the wrong moment.

**Low-latency summary:** parse with `from_chars` or hand-rolled integer parsing, never through `double`, never through locale-aware functions, never with allocation. Keep prices as integers end to end. The only place a `double` should appear is analytics and human-readable display.

---

## Key Interview Questions

1. **State the definitions of O, Ω, Θ, and o.** — Upper, lower, tight, and strictly-smaller bounds with the ∃c,n₀ / ∀c formulations; O is an upper bound, not a description of behaviour, and not the worst case.
2. **Amortized vs expected vs worst case?** — Amortized is a deterministic guarantee over a sequence; expected averages over randomness; worst case is per-operation. `vector::push_back` is amortized O(1); quickselect is expected O(n); `unordered_map::find` is expected O(1) and worst O(n).
3. **Prove `push_back` is amortized O(1).** — Geometric series: doubling copies fewer than 2n elements total over n pushes. Or the accounting method: charge 3, save 2, and the saved credits exactly pay for the copy.
4. **Why is growth by a constant amount wrong?** — Σ of copies becomes Θ(n²); any factor > 1 gives O(1) amortized, with k/(k−1) copies per element.
5. **When does an amortized bound not help you?** — When the metric is tail latency: the Θ(n) reallocation lands on some message. Use `reserve` or a fixed-capacity container.
6. **Why does `std::list` lose to `std::vector` despite O(1) insertion?** — One cache miss per node with no memory-level parallelism (the next address depends on the current load), versus 16 elements per miss on a prefetched sequential scan.
7. **What is the external-memory model and what does it predict that the RAM model does not?** — Cost in cache-line transfers with parameters M and B; it explains tiled matmul (Θ(n³/(B√M)) vs Θ(n³/B)), B-trees (log_B n), and why scans beat pointer chasing.
8. **What makes an algorithm cache-oblivious, and why does that matter?** — Recursive subdivision achieves optimal transfers without knowing M or B, so it is optimal at every cache level and needs no retuning. Real code hybridizes with a tuned base case.
9. **Conditioning vs stability?** — Conditioning is sensitivity of the *problem*; stability is a property of the *algorithm*. No algorithm rescues an ill-conditioned problem.
10. **What is catastrophic cancellation and where does it appear?** — Subtracting near-equal values cancels the correct leading digits and exposes pre-existing error. Quadratic formula, `1-cos x`, `exp(x)-1`, naive variance `E[x²]−E[x]²`, and range sums from prefix arrays.
11. **How do you compute a running variance correctly?** — Welford's algorithm, updating the mean before accumulating M2.
12. **How should floats be compared?** — Combined absolute and relative epsilon, or ULP distance via `bit_cast` (bit patterns of positive doubles are monotone). For money, don't compare floats — use scaled integers.
13. **Why can a comparator that sees NaN crash `std::sort`?** — NaN compares false with everything, violating strict weak ordering, which is UB; libstdc++ runs off the end of the array.
14. **How does Kahan summation work and what defeats it?** — A compensation variable recovers the bits lost in each addition, reducing error from O(nε) to O(ε); `-ffast-math` assumes associativity and deletes the compensation entirely.
15. **What is the best default summation method?** — Pairwise: O(ε log n) error at naive cost, and a SIMD reduction with multiple accumulators performs it implicitly.
16. **Why must prices not be `double`?** — 0.1 is not representable; 53-bit mantissa; accumulated drift; decimal tick grids and rounding rules; equality becomes an epsilon heuristic.
17. **How do you multiply two fixed-point values?** — Widen to `__int128`, multiply, divide by the scale factor with an explicit rounding rule; on x86-64 the 64×64→128 multiply is one instruction.
18. **Why is banker's rounding the IEEE default?** — Half-away-from-zero has a systematic upward bias that accumulates over many roundings; half-to-even is unbiased.
19. **Which way should you round an order price?** — Toward the passive side (buys down, sells up) so rounding never makes an order more aggressive; quantities down to the lot size.
20. **How do you check for signed overflow correctly?** — `__builtin_add_overflow` / `std::add_sat` and friends; hand-written `a > MAX - b` checks written as `a + b < a` are deleted by the optimizer because signed overflow is UB.
21. **When is saturating arithmetic wrong?** — For money and risk values: a saturated number is a silently incorrect answer. Saturate measurements; check-and-reject financial quantities.
22. **How do you compare wrapping sequence numbers?** — `int32_t(a - b) < 0`, not `a < b`.
23. **What is wrong with `-1` as a "no price" sentinel?** — It is a legal price; negative crude oil in April 2020 broke exactly this. Use an unreachable value like `INT64_MIN`, or `std::optional`, or a validity bitmap.
24. **Why `std::from_chars` over `std::stod`?** — Locale-independent, non-allocating, non-throwing, and the fastest available; `stod`/`strtod` parse "1.5" as 1 under a comma-decimal locale.
25. **What does `std::to_chars` with no precision guarantee?** — The shortest representation that round-trips exactly, unlike `%.6g`, which silently truncates.

---

## Common Traps

- **Saying O when you mean Θ**, or treating O as "the worst case".
- **Ignoring constants and n₀** — `std::map` loses to a linear vector scan below ~100 elements; Strassen loses below n in the hundreds.
- **Confusing amortized with expected** — one is a guarantee, the other is a distribution.
- **Trusting an amortized bound in a tail-latency system** — the Θ(n) reallocation or rehash still happens.
- **Growing a buffer by a constant amount** — Θ(n²) total.
- **Assuming a hash map is O(1) under adversarial input** — hash flooding; seed your hash.
- **Building a lookup table larger than L2** — recomputation is faster than a DRAM read, and the table evicts everyone else's working set.
- **Benchmarking a table in isolation** — cache pressure on co-resident threads is invisible in a microbenchmark.
- **Counting instructions instead of cache-line transfers** for anything above L2.
- **Assuming the cache-oblivious model's ideal cache** — real set-associativity produces conflict misses at power-of-two strides.
- **`E[x²] − E[x]²` for variance** — catastrophic cancellation; can return a negative variance.
- **`a == b` on computed floats.**
- **A pure relative epsilon near zero**, or a pure absolute epsilon at large magnitudes.
- **NaN in a comparator** — violates strict weak ordering, so `std::sort` is UB and libstdc++ segfaults.
- **`-0.0 == 0.0` but different bits** — byte-comparing or byte-hashing floats is wrong.
- **Compiling Kahan summation with `-ffast-math`** — the compensation is algebraically simplified away.
- **Accumulating money in `double`** — drift, non-reconciliation; adding 1.0 to an accumulator at 2⁵³ does nothing at all.
- **Fixed-point multiply without a 128-bit intermediate** — silent overflow.
- **Relying on C++ integer division's truncation-toward-zero** for negative values — `-7/2 == -3`; rounding becomes sign-asymmetric.
- **Rounding half-away-from-zero for money** — systematic bias.
- **Rounding a limit price to nearest** — can make the order more aggressive than intended.
- **Rounding repeatedly through intermediate representations** rather than once at the boundary.
- **Hand-rolled overflow checks that rely on signed overflow** (`a + b < a`) — deleted by the optimizer.
- **`INT_MIN / -1` and `-INT_MIN`** — these trap (`#DE`) on x86, they do not merely wrap.
- **`a < b` on wrapping sequence numbers.**
- **Sentinels inside the valid domain** — `-1` prices, `0` quantities, `0xFFFF` IDs.
- **Sentinels entering arithmetic** — `INF + w` overflow, NaN propagation far from the source.
- **`std::stod`/`strtod`/`istringstream` in a parser** — locale-dependent, allocating, and 10–100× slower than `from_chars`.
- **Routing a fixed-point field through `double` while parsing** — reintroduces exactly the rounding you switched to integers to avoid.
- **Default iostream precision of 6** silently truncating logged prices.

---

## Compact Recall Summary

**Asymptotics.** O/Ω/Θ/o/ω are sets of functions with ∃c,n₀ definitions; O is an upper bound, orthogonal to case analysis. Amortized (deterministic guarantee over a sequence) ≠ expected (over randomness) ≠ worst case. Constants and n₀ decide real outcomes: `map` vs `vector` crosses around ~100 elements, Strassen in the hundreds, and the RAM model mispredicts anything memory-bound. Input-oblivious algorithms (mergesort, heapsort, radix, sorting networks) make p99 equal p50, which is often worth more than a better average.

**Amortization.** Aggregate (geometric series), accounting (charge 3, save 2), potential (Φ = 2·size − capacity). Growth factor k costs k/(k−1) copies per element; constant growth is Θ(n²). Amortized bounds are not per-operation bounds — `reserve()`, fixed-capacity containers, and pools convert them into worst-case guarantees. Union-find with compression + rank is amortized α(n).

**Space-time.** Memoization, tables, indices, prefix sums, and sketches all buy time with memory — but on modern hardware a table that leaves L2 loses to recomputation (DRAM ~250 cycles vs an FP multiply at 4). Tables win only when L1/L2-resident and replacing >10–20 cycles. Cache pressure is a shared cost invisible to microbenchmarks. In trading: precompute reference-derived tables at startup into dense flat arrays; never allocate, hash, or branch on reference data in the hot path.

**Cache complexity.** Count transfers with cache size M and line size B. Scan = Θ(n/B); random = Θ(n); sort = Θ((n/B)log_{M/B}(n/B)); B-tree = Θ(log_B n); tiled matmul = Θ(n³/(B√M)). L1 ~4 cy, L2 ~12, L3 ~45, DRAM ~250, remote NUMA ~400. Pointer chasing serializes misses and kills MLP; SoA, flat containers, and hot/cold splitting are the structural fixes. **Cache-oblivious** = recursive subdivision that is optimal at every level with no knowledge of M or B (vEB layout, funnelsort, recursive matmul); production code hybridizes with a tuned base case, as `std::sort`, BLAS, and FFTW do.

**Numerical stability.** Conditioning is the problem's sensitivity; stability is the algorithm's. Catastrophic cancellation exposes existing error when near-equal values are subtracted — reformulate (stable quadratic, `expm1`, `log1p`, `2sin²(x/2)`, Welford for variance). FP addition is not associative. Compare with combined absolute+relative epsilon or ULP distance via `bit_cast` (positive doubles are monotone as integers); NaN compares false with everything and breaks strict weak ordering, so it is UB in `std::sort` and corrupts ordered containers; `std::strong_order` (C++20) gives a total order.

**Summation.** Naive is O(nε); pairwise is O(ε log n) at the same cost and is the right default (SIMD reductions do it for free); Kahan/Neumaier are O(ε) at 4× cost and are **silently deleted by `-ffast-math`**. For money, accumulate in integers — exact, fastest, no fast-math hazard.

**Fixed point.** value = raw/10^s with the scale in the type. `int64_t` at scale 10⁻⁴ covers 9.2×10¹⁴; multiplication needs a `__int128` intermediate (one `MUL` on x86-64) and an explicit rescale; division must round explicitly since C++ truncates toward zero. Prices as integer tick counts is the strongest form — integer comparison, array-indexed books, exact grid validation. Rounding modes: half-to-even is unbiased and is the IEEE default; in trading, round toward the passive side, quantities down to lot size, fees against yourself, and round once at the boundary.

**Overflow and sentinels.** Signed overflow is UB and the optimizer deletes checks that depend on it; use `__builtin_*_overflow` or C++26 `std::add_sat`/checked forms, and run UBSan in CI. Saturate measurements, check-and-reject money. Wrapping sequence comparison is `int32_t(a-b) < 0`. Sentinels must be outside the representable domain (`INT64_MIN`, not `-1` — negative oil prices broke that assumption industry-wide), named, checked once at ingest, and kept out of arithmetic; `std::optional`/`std::expected` are the type-safe defaults, a validity bitmap the dense hot-path alternative.

**Decimal conversion.** `std::from_chars`/`to_chars` (C++17) are locale-free, non-allocating, non-throwing, and fastest; `to_chars` with no precision gives the shortest round-trippable form. `stod`/`strtod`/`istringstream` are locale-dependent (a comma-decimal locale parses "1.5" as 1) and orders of magnitude slower. Parse fixed-point fields as integers directly, never through `double`. Tick ladders are reference data, can vary by price band, and may be fractional (1/32 is exact in binary); rebuild derived tables on tick-size changes.
