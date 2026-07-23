# Chapter 23 — Complexity and Numerical Correctness

## Why this matters in a low-latency interview — Core

“O(1)” does not mean bounded latency, one operation, or one cache miss. “Exact to eight decimal places” does not mean an unchecked `int64_t` multiplication cannot overflow. Strong answers state the model and its assumptions: worst-case or amortized, operation count or cache-line transfers, binary floating point or scaled decimal, reject or saturate, and which boundary validates the input.

This chapter has two parts because performance and numerical correctness share a discipline: choose a model that preserves the property you care about. Part A builds asymptotic, amortized, and cache-transfer cost models. Part B builds arithmetic contracts for conditioning, summation, fixed point, rounding, overflow, and sentinels. An operation can be O(1) and still have unacceptable tail latency or produce a wrong financial result.

## The 90-second screen — Core

Five facts:

1. O, Ω, and Θ describe growth bounds; best/average/worst case describes inputs; amortized cost describes a sequence; expected cost describes a probability model.
2. A useful cost model names the counted resource: comparisons, bytes copied, allocations, cache-line transfers, dependent misses, or another workload-specific unit.
3. Amortized O(1) permits an individual O(n) operation. Reserve or fixed capacity can move or reject that spike only when a reliable bound exists.
4. Conditioning belongs to the problem; stability belongs to the algorithm. More precision cannot repair a badly conditioned problem or an unstable formulation.
5. Financial fixed-point arithmetic is incomplete until scale, representable range, rounding, overflow, and boundary-validation policies are all explicit.

Two decisions:

- Use asymptotics to reject designs that scale badly, then compare survivors with a cache/allocation model and latency distribution measured on the target workload.
- Use floating point for domains that tolerate quantified approximation; use exact decimal/fixed-point or tick representations when protocol, accounting, or venue rules require exact grids.

---

## Part A — Cost Models and Tail Latency

## 23.1 Choose the counted resource — Core

Before writing O-notation, define an input variable and a cost unit. For a lookup, `n` might mean keys and cost might mean comparisons. For a scan, `n` might mean bytes and cost might mean cache-line transfers. For a latency service, the output is not one number but a distribution under stated load.

| Model | Unit counted | Useful when | Main blind spot |
|---|---|---|---|
| RAM/asymptotic | Primitive operations | Growth and algorithm selection | Constants, locality, allocation, contention |
| Comparison model | Key comparisons | Sorting/search decision | Comparison cost may depend on key length |
| Allocation/copy model | Allocations, bytes moved | Containers and ownership | Cache state and allocator contention |
| Cache-transfer model | Blocks/lines moved | Large or pointer-heavy data | Instruction and branch costs |
| Work/span model | Total work and critical path | Parallel algorithms | Scheduling and synchronization overhead |
| Empirical latency | Time distribution | Deployment decision | Valid only for measured workload/environment |

For example, binary search performs Θ(log n) comparisons, but a comparison of two long strings can itself scan Θ(k) characters. The honest bound is Θ(k log n) in the worst case, with early mismatches often cheaper. A hash lookup can reduce comparisons while adding a hash over Θ(k) bytes. The key representation changes the cost model.

```text
question → define n and operation → derive growth/case bound
                                  → identify allocations and bytes moved
                                  → estimate working set and dependency chains
                                  → measure distribution on target workload
```

Do not add unlike units into a fake universal score. Use the models in sequence: prove the scaling property, identify mechanisms likely to dominate, then measure.

## 23.2 Asymptotic notation — Core

Asymptotic notation classifies how a cost function grows as input size grows without bound. The definitions are about *sets of functions*.

| Notation | Definition | Reading |
|---|---|---|
| f = O(g) | ∃ c, n₀ : f(n) ≤ c·g(n) for all n ≥ n₀ | Upper bound; "grows no faster than" |
| f = Ω(g) | ∃ c, n₀ : f(n) ≥ c·g(n) for all n ≥ n₀ | Lower bound |
| f = Θ(g) | f = O(g) and f = Ω(g) | Tight bound |
| f = o(g) | ∀ c > 0, ∃ n₀ : f(n) < c·g(n) | Strictly smaller; f/g → 0 |
| f = ω(g) | ∀ c > 0, ∃ n₀ : f(n) > c·g(n) | Strictly larger |

Three points worth being precise about:

O is an upper bound, not a description of typical behavior. "O(n²)" is a true statement about a linear algorithm; it is just not the tightest one. When an interviewer asks "what is the complexity," they usually want Θ.

O is not the worst case. Complexity class and case analysis (§23.3) are orthogonal. "Quicksort is O(n log n)" is ambiguous — average case is Θ(n log n), worst case is Θ(n²). "O(n²) worst case, Θ(n log n) expected" is unambiguous.

Constants and the threshold n₀ are hidden by design. A contiguous linear scan can beat a logarithmic node-tree lookup for small ranges because the scan has simple control flow and spatial locality while the tree follows dependent pointers. The crossover depends on key cost, element layout, cache state, compiler, and hardware; derive the growth class, then measure representative sizes.

### Growth ordering

```
O(1) < O(α(n)) < O(log log n) < O(log n) < O(log²n) < O(n^ε) < O(n) < O(n log n)
     < O(n log²n) < O(n²) < O(n³) < O(2ⁿ) < O(n!) < O(nⁿ)
```
α(n) is the inverse Ackermann function from union-find (Chapter 21). It grows extraordinarily slowly, but it is not literally a constant.

Log bases do not matter for the notation (they differ by a constant factor) — except in an exponent, where they do: `n^log₂3 ≠ n^log₁₀3`.

### Amortized vs expected vs worst case

- **Amortized** — a guarantee over a sequence of operations, with no randomness (§23.4). `vector::push_back` is amortized O(1): n pushes from an initially empty vector have O(n) total element work under the container's contract.
- **Expected** — an average over randomness, either in the input distribution or the algorithm's own coin flips. Quickselect is expected O(n); a specific run can be O(n²).
- **Worst case** — a per-operation guarantee.

Standard unordered-container lookup has average constant complexity and worst-case linear complexity. That average statement relies on the hash behavior and key distribution; collision-heavy or adversarial inputs can reach the linear case. Chapter 12 owns hash-table selection and mitigation.

### What asymptotics does not model

It counts abstract operations, treating memory accesses alike. It ignores allocation, cache state, branch prediction, SIMD width, and bandwidth. For a bounded production workload, supplement the RAM model with the transfer and allocation mechanisms that differ between candidate designs.

---

## 23.3 Best, average, expected, and worst case — Core

Case analysis asks *which input* the bound describes. It is orthogonal to O/Θ/Ω.

| Algorithm/operation | Best | Average or expected assumption | Worst | Worst-case trigger |
|---|---|---|---|---|
| Quicksort with ordinary partitioning | Θ(n log n) | Θ(n log n) under a stated permutation/pivot model | Θ(n²) | Repeatedly extreme pivots |
| Insertion sort | Θ(n) | Θ(n²) | Θ(n²) | Reverse-sorted |
| Mergesort | Θ(n log n) | Θ(n log n) | Θ(n log n) | — (input-oblivious) |
| Heapsort | Θ(n log n) | Θ(n log n) | Θ(n log n) | — |
| Standard unordered lookup | Θ(1) | Θ(1) under its average-case assumptions | Θ(n) | Collision-heavy bucket |
| Unbalanced BST search | Θ(1) | Θ(log n) only under a suitable shape/input model | Θ(n) | Degenerate chain |
| Red-black / AVL search | Θ(1) | Θ(log n) | Θ(log n) | — |
| `vector::push_back` | Θ(1) without growth | Θ(1) amortized over a sequence | Θ(n) single op | Capacity growth |
| Linear search | Θ(1) | Θ(n) | Θ(n) | Absent element |

Some algorithms perform essentially the same comparison/movement pattern for every input of a given size. That reduces input-dependent variance; it does **not** make p99 equal p50, because cache state, preemption, page faults, frequency changes, and contention remain. A tighter algorithmic worst case is one ingredient in a latency budget, not a latency-distribution guarantee.

### Adversarial worst cases

The worst case matters when an adversary — or an unlucky burst — chooses the input:

- **Hash flooding.** Colliding keys turn average constant lookup into linear work. Mitigations depend on threat model and container: a keyed hash, bounded input, a different structure, or admission controls.
- **Backtracking explosion.** Some regex/backtracking implementations can revisit the same input states exponentially; finite-automaton simulation has a different bound. Chapter 22 owns algorithm details.
- **Quicksort killers.** A deterministic pivot rule can admit adversarial partitions. Randomization or a worst-case fallback changes that risk.
- **Algorithmic-complexity attacks on parsers.** Quadratic behavior in header or field handling.

In market data the adverse input may be an ordinary burst rather than an attacker. Select the bound appropriate to the consequence: hard real-time admission needs a per-operation bound; a throughput service may accept a controlled amortized spike.

### The amortized/worst-case tension

`vector::push_back` is amortized Θ(1), but capacity growth is one Θ(n) operation. `reserve(bound)` moves the allocation and establishes capacity only when `bound` is valid and no later operation exceeds it. Otherwise choose an overflow policy—reject, slow path, or a different bounded structure—rather than claiming the spike is eliminated.

---

## 23.4 Amortized analysis — Core

Amortized cost is total cost over a sequence divided by the number of operations, stated as a guarantee — no probability involved. It is the right framing whenever an operation is usually cheap and occasionally expensive in a way paid for by the cheap ones.

Three standard methods:

**Aggregate.** Bound the total for n operations, divide. In an abstract dynamic array whose capacity doubles, growth relocates approximately `1 + 2 + 4 + …` existing elements. The sum is less than twice the final capacity, so n appends perform O(n) total element construction/relocation and have O(1) amortized work. This derivation is a model; the C++ standard does not specify `vector`'s growth factor.

**Accounting (banker's).** Charge each append enough to construct its new element and bank credit toward a future relocation. For doubling, a constant extra credit per append pays for moving the existing elements at the next growth. The proof obligation is that stored credit never becomes negative, not that every individual append is cheap.

**Potential.** Define nonnegative stored potential Φ(state); amortized cost is actual cost plus ΔΦ. A suitable function for a doubling array stores potential as size approaches capacity and spends it at growth. Chapter 21 applies the method to richer structures.

### The growth-factor question

For an abstract capacity sequence multiplied by a constant `g > 1`, previous capacities form a geometric series. Relocation work stays O(n), so append remains amortized O(1). A larger `g` generally trades more unused capacity for fewer growth events; rounding, allocator behavior, element move/copy properties, and the implementation's actual policy determine measured cost.

Growing by a fixed additive amount instead produces Θ(n²) total relocation over n appends. No standard C++ container promises a particular geometric factor, so do not encode a vendor's observed factor into correctness or capacity calculations.

### Where amortized guarantees break

- **They are not per-operation bounds.** A latency-sensitive system may care about the Θ(n) spike more than total throughput. A validated `reserve` bound, a fixed array plus length, or a deliberately selected bounded container can avoid growth; each needs an explicit full-capacity policy.
- **They do not survive an adversarial reset.** Repeatedly pushing to trigger a reallocation, then popping back, is a known attack on structures that shrink eagerly — one reason `vector` never shrinks on `pop_back`, and `shrink_to_fit` is a non-binding request.
- **Hash-table rehashing** has the same shape: average/amortized insertion may be constant while a rehash moves or relinks Θ(n) elements. `reserve(expected)` helps only if the element bound and load-factor policy are correct.
- **Union-find with path compression + union by rank** is amortized O(α(n)) — the classic non-trivial potential argument.

---

## 23.5 Space-time trade-offs — Core

Nearly every optimization exchanges one resource for another.

| Technique | Buys | Costs |
|---|---|---|
| Memoization / DP tables | Exponential → polynomial time | O(states) memory |
| Precomputed lookup tables | Branches and arithmetic → one load | Table footprint, cache pressure |
| Hash index / secondary index | O(n) scan → O(1) lookup | O(n) memory, update cost, invalidation |
| Prefix sums (Chapter 22) | O(n) range query → O(1) | O(n) memory, O(n) rebuild on update |
| Sparse table | O(n) range-min → O(1) | O(n log n) memory |
| Compression (bitsets, varint, delta) | Memory and bandwidth | Decode CPU |
| Recomputation | Memory and bandwidth | CPU |
| Bloom filter (Chapter 21) | Definite-negative in O(1), compact memory | False positives; basic form has no deletion |
| Streaming sketches (HLL, t-digest) | O(1) memory for approximate aggregates | Bounded error |

### Recompute or load?

Precomputation replaces arithmetic/control flow with storage and memory traffic. It wins when the table is reused, local, and selective enough to replace meaningful work. Recalculation can win when inputs are already in registers and a table lookup adds a cache miss or expands the shared working set.

The decision needs four measurements: table footprint, access distribution, reuse distance, and computation cost. A byte count alone is insufficient because unrelated hot data competes for the same cache sets and shared cache capacity.

### Cache pressure is a shared, invisible cost

A table resident during an isolated microbenchmark may evict another thread's data under production colocation. Measure whole-workload miss rates and latency, not only a table lookup in isolation. Platform counters are useful evidence but require platform-specific interpretation (Chapter 43).

### Low-latency framing

Reference data often permits startup precomputation into arrays indexed by a dense instrument ID. That can remove hashing and repeated validation from the message path, but update semantics matter: tick ladders and risk limits can change. The design needs a publication/version rule and must include the precomputed footprint in its working-set budget. Sometimes two compact tables plus a small calculation outperform one sparse product table.

---

## 23.6 Cache-transfer complexity — Core

The RAM model assigns uniform cost to memory access. An external-memory/cache-aware model adds **M**, the number of elements fitting in fast memory, and **B**, the elements transferred per block. Cost is the number of block transfers between levels. Keep units consistent: if M and B are bytes, convert n to bytes too.

### Canonical results

| Access pattern/problem | RAM model | Idealized transfer count |
|---|---|---|
| Sequential scan of n elements | Θ(n) | Θ(n/B) |
| n independent random probes into data much larger than M | Θ(n) | Up to Θ(n) |
| Binary search in a sorted contiguous array | Θ(log n) comparisons | Θ(log(n/B) + 1) blocks in the ideal model |
| Comparison sorting | Θ(n log n) | Θ((n/B)·log_{M/B}(n/B)) under the model's assumptions |
| B-tree search (Chapter 21) | Θ(log n) | Θ(log_B n) |

The sorting bound assumes an ideal hierarchy and sufficient cache relative to block size. Real hardware adds associativity, prefetching, translations, write policies, and concurrent traffic. Treat the model as a way to predict transfer shape, then validate it with elapsed time and platform counters.

For a concrete scan, calculate elements per measured cache line: `line_bytes / sizeof(T)`. Contiguous traversal can use most transferred bytes and expose multiple outstanding misses. A linked structure may fetch one useful node per line and serialize address discovery. This mechanism explains why a vector traversal can outperform a list traversal even though insertion bounds favor the list in a different workload.

### Consequences for structure choice

- **Array of structures vs structure of arrays** (Chapter 42): touching one field of many records, SoA transfers fewer unused fields.
- **Node-based versus flat containers:** nodes add pointer and allocator overhead and weaker spatial locality. Flat containers trade mutation cost/stability for denser lookup. Chapter 12 owns the selection.
- **Hot/cold splitting** moves rarely-touched fields into a separate structure so hot fields pack more densely per line.
- Hardware prefetch behavior and software-prefetch facilities are platform-specific. Dependent pointer chasing is intrinsically harder because the next address is unavailable until the current load completes (Chapter 28).

---

## 23.7 Cache-oblivious algorithms — Deep dive

A **cache-oblivious** algorithm does not encode M or B yet can achieve good or optimal asymptotic transfer bounds in an ideal-cache model. Recursive subdivision eventually creates subproblems that fit each cache level without naming that level.

| | Cache-aware (tiled/blocked) | Cache-oblivious (recursive) |
|---|---|---|
| Knows M, B | Yes — tile size is tuned | No |
| Optimal at | The level it was tuned for | All levels |
| Retuning | Tile/base cases often tuned | Transfer proof does not require M/B; practical base case may still be tuned |
| Main practical issue | One tile choice can favor one level | Recursion, base-case, vectorization, and conflict constants |

Examples include recursive matrix transpose/multiplication, funnelsort, and recursively laid-out trees. Eytzinger and van Emde Boas layouts are related locality techniques but are not the same layout. Chapter 22 owns search-layout algorithms.

Practical implementations often recurse to a tuned iterative/vectorized base case. The transfer proof and fastest machine code are separate questions.

The model usually assumes ideal replacement and associativity. Real set conflicts, prefetchers, translations, and recursion overhead can change results. Padding or layout changes may help a conflict pattern, but measure the actual address mapping rather than applying a universal non-power-of-two rule.

---

## Transition: from cost models to correctness

Part A assumed every arithmetic operation is exact and asked only how many operations or transfers an algorithm needs. Part B drops that assumption. Floating-point arithmetic is not associative, most decimal fractions are not exactly representable in binary, and every numeric representation has range limits. A constant-count operation can still be the source of a correctness failure because its cost model said nothing about arithmetic semantics.

---

## Part B — Numerical and Financial Correctness

## 23.8 Conditioning, floating error, and stability — Core

A computation is **numerically stable** if small perturbations in the input, or the rounding errors introduced along the way, produce correspondingly small perturbations in the output. Two distinct notions matter, and the interview answer usually hinges on which one applies:

- **Conditioning** is a property of the *problem*. A problem is ill-conditioned if its true answer is hypersensitive to input perturbation. No algorithm can fix it.
- **Stability** is a property of the *algorithm*. A stable algorithm produces the exact answer to a slightly perturbed problem (backward stability).

As a first-order mental model, forward error is influenced by problem conditioning times the algorithm's backward error. The exact bound depends on the problem, norm, data, and rounding model. High condition number means input uncertainty and rounding can be strongly amplified; an algorithm cannot manufacture information absent from its inputs.

### Sterbenz's lemma and catastrophic cancellation

A precise claim first: for finite positive floating values x and y satisfying `y/2 ≤ x ≤ 2y`, their floating-point difference is exactly representable under the usual conditions of Sterbenz's lemma. Symmetric statements handle negative operands. This is a conditional theorem, not “near-equal subtraction is always exact.”

It does not, however, mean cancellation is safe. Catastrophic cancellation is not about the subtraction rounding incorrectly — the subtraction is often exact, exactly as Sterbenz predicts. It is about **exposing relative error that was already present in the operands** from earlier computation. If x and y each carry an absolute error of size ε from prior rounding, and x − y is small because x and y are close, then that same absolute error ε is now a huge fraction of a much smaller result. The subtraction did not introduce the error; it deleted the leading digits that were hiding it.

```text
true inputs ──rounding/measurement──► stored x, stored y
                                             │
                                  exact floating subtraction
                                             │
                                      small x - y result

The subtraction can add no rounding yet expose the operands' existing
absolute errors as a large relative error in the small result.
```

The canonical instance is the quadratic formula:

For the quadratic formula, choosing the sign that avoids subtracting similar magnitudes reduces cancellation:

```cpp
#include <cmath>
#include <optional>
#include <utility>

std::optional<std::pair<double, double>>
quadratic_roots(double a, double b, double c) {
    if (a == 0.0) return std::nullopt;
    const double disc = b * b - 4.0 * a * c;
    if (disc < 0.0) return std::nullopt; // real-roots policy
    const double root = std::sqrt(disc);
    const double q = -0.5 * (b + std::copysign(root, b));
    if (q == 0.0) return std::pair{0.0, 0.0};
    return std::pair{q / a, c / q};
}
```

This example states a real-roots policy but does not fully solve overflow in `b*b` or underflow in the discriminant; a production routine must scale inputs or use a specialized numerical library.

Also unstable by the same mechanism: `1 - cos(x)` for small x (use `2*sin(x/2)*sin(x/2)`), `exp(x) - 1` (use `std::expm1`), `log(1+x)` (use `std::log1p`), and the naive variance formula `E[x²] − E[x]²`, which cancels catastrophically when the mean is large relative to the spread and can degrade to a near-zero or even negative result. Use Welford's online algorithm instead:

```cpp
#include <cstddef>
#include <optional>

struct Welford {
    std::size_t n{};
    double mean{};
    double m2{};

    void update(double x) {
        ++n;
        const double delta = x - mean;
        mean += delta / static_cast<double>(n);
        m2 += delta * (x - mean);
    }

    std::optional<double> sample_variance() const {
        if (n < 2) return std::nullopt;
        return m2 / static_cast<double>(n - 1);
    }
};
```

### Other stability rules

- **Ordering matters.** Floating-point addition is commutative but not associative (§23.10); sorting by magnitude or using a tree can improve some datasets, but cancellation and signs determine the actual error.
- **Avoid subtracting large near-equal quantities carrying prior error** when a stable reformulation is available.
- **Treat division by a small uncertain denominator as ill-conditioned**; sensitivity depends on both numerator and denominator error.
- **Iterative refinement** — solve, compute a more accurate residual, and correct — can recover accuracy for suitable linear systems.
- **Higher precision is a tool, not a proof.** `long double` format and performance are implementation/ABI-specific. More precision can reduce rounding error but does not repair bad conditioning or an unstable formulation.

---

## 23.9 Floating-point comparison — Core

Chapter 2 covers IEEE-754 representation. This section is exclusively about comparison, where most production floating-point bugs live.

Exact `==` is correct when exact identity is the contract—for example, a sentinel-free state machine over prescribed values. It is often wrong as a test for independently rounded calculations. Tolerance is not universal either; it must come from a domain error budget.

### Comparison strategies

| Strategy | Form | When correct |
|---|---|---|
| Absolute epsilon | `abs(a-b) < eps` | Only when values are near a known scale, including near zero |
| Relative epsilon | `abs(a-b) <= eps * max(abs(a), abs(b))` | General magnitudes; fails near zero, where relative error is meaningless |
| Combined | `abs(a-b) <= max(abs_eps, rel_eps*max(abs(a),abs(b)))` | The practical default |
| ULP distance | Integer difference of ordered bit patterns | Exact control over representable steps |

A robust helper validates its tolerances, handles exact equality (including both signed zeros and same-signed infinities), and gives NaN and unequal infinities explicit policies:

```cpp
#include <cmath>

bool almost_equal(double a, double b,
                  double rel_tol, double abs_tol) {
    if (!std::isfinite(rel_tol) || !std::isfinite(abs_tol) ||
        rel_tol < 0.0 || abs_tol < 0.0) {
        return false;
    }
    if (a == b) return true; // includes equal infinities and both zeros
    if (!std::isfinite(a) || !std::isfinite(b)) {
        return false;        // policy: NaN unequal; unequal infinities unequal
    }
    const double diff = std::fabs(a - b);
    const double scale = std::fmax(std::fabs(a), std::fabs(b));
    return diff <= std::fmax(abs_tol, rel_tol * scale);
}
```

The caller supplies both tolerances from the measurement/numerical contract. A library-wide `1e-9` constant mixes units and scales and is rarely defensible.

### ULP comparison, done safely

For positive IEEE-754 values, the bit pattern reinterpreted as an unsigned integer is monotone in the value — consecutive representable positive doubles are consecutive unsigned integers. Negative values are sign-magnitude, so naively subtracting signed bit patterns is unsafe: it can signed-overflow, and negating `INT64_MIN` (the bit pattern for the most negative representable value's `int64_t` reinterpretation) is itself undefined behavior. The fix is to **bias the sign-magnitude pattern into one monotonic unsigned ordering** before differencing, and to make NaN a hard error rather than a silently wrong number:

```cpp
#include <bit>
#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>

// Map a double's bit pattern to an UNSIGNED value that is monotone
// across the full range of finite doubles, including negative values.
std::uint64_t to_biased(double value) {
    static_assert(std::numeric_limits<double>::is_iec559);
    static_assert(sizeof(double) == sizeof(std::uint64_t));
    const auto bits = std::bit_cast<std::uint64_t>(value);
    constexpr std::uint64_t sign = std::uint64_t{1} << 63;
    return (bits & sign) ? ~bits : (bits | sign);
}

// nullopt on NaN input — there is no meaningful ULP distance to a NaN.
std::optional<std::uint64_t> ulp_distance(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return std::nullopt;
    if (a == b) return 0; // policy: +0 and -0 have distance zero
    const auto ua = to_biased(a);
    const auto ub = to_biased(b);
    return ua > ub ? ua - ub : ub - ua;
}
```

This ULP policy is specific to IEC 60559 binary64 layout as enforced by the assertions. ULP distance is useful for testing tightly controlled operations; it is not a substitute for a domain tolerance across values whose ULP size changes with magnitude.

### NaN and the ordering trap

Equality and ordered comparisons with NaN are false (while `!=` is true), including comparison with another NaN. Consequences:

- `x != x` is the classic NaN test; `std::isnan` states intent.
- Ordinary `<` over a domain containing NaNs does not provide the strict weak ordering required by sorting and ordered containers. Reject NaNs or provide a comparator with a documented total/equivalence policy.
- `-0.0 == 0.0` is true, but the two have different bit patterns. Byte comparison or byte hashing therefore does not implement ordinary floating equality (Chapter 3).

C++20 provides `std::partial_order`, `std::weak_order`, and `std::strong_order` customization-point objects. `std::strong_order` can establish a total order for floating values, including distinctions among representations. Ensure its equivalence semantics match the application before using it for keys.

### The real answer, for money

For venue prices, quantities, fees, and accounting amounts defined on an exact decimal/tick grid, prefer a representation of that exact domain. Floating point remains appropriate for analytics whose error budget is quantified; do not turn an approximate metric into an exact execution price without a boundary conversion policy.

---

## 23.10 Summation: Kahan, Neumaier, and pairwise — Core

Floating-point addition is not associative: `(a+b)+c` and `a+(b+c)` can differ. A naive sum has an error bound that grows with n and the sum of magnitudes under the usual rounding model; cancellation and input order affect relative error. Adding 1.0 to a binary64 accumulator at 2⁵³ changes nothing because the representable spacing there exceeds one.

### Compensated summation

Kahan summation carries the low-order bits lost on each addition in a separate compensation variable:

```cpp
#include <span>

double kahan_sum(std::span<const double> v) {
    double sum = 0.0;
    double compensation = 0.0;
    for (double x : v) {
        const double y = x - compensation;
        const double t = sum + y;
        compensation = (t - sum) - y;
        sum = t;
    }
    return sum;
}
```
The compensation estimates low-order contribution lost by the running addition; its recovery operations also round, so “recovers exactly” is not a general guarantee. Under standard assumptions Kahan can greatly improve forward error, but the bound still depends on conditioning and floating semantics.

Neumaier's variant adjusts the correction when an incoming magnitude exceeds the running sum. Choose among naive, tree, Kahan, and Neumaier using an accuracy requirement and representative data rather than a universal “best” label.

### The fast-math trap

Compiler modes that permit reassociation can invalidate compensated-summation reasoning and transform away the correction. Compile numerically sensitive routines under a documented floating-point mode, test adversarial inputs, and inspect generated code when build flags permit reassociation. Pragmas and attributes are compiler-specific.

### Pairwise summation, and what SIMD lanes actually buy

Pairwise (cascaded) summation recursively splits the range in half, sums each half, and adds the two results. Its error is O(ε log n) — far better than naive, at essentially naive cost — because each partial sum only accumulates error across log n additions rather than n.

A SIMD reduction with k lane accumulators is **not automatically pairwise summation**. Each lane can still perform a long naive chain, followed by a horizontal combine. It shortens dependency chains and changes the error, but only a tree-structured reduction earns a pairwise error argument.

| Method | Error tendency under standard assumptions | Mechanism/trade-off |
|---|---|---|
| Naive | Bound grows with n and sum of magnitudes | One dependency chain; easy to vectorize |
| Pairwise/tree | Bound grows roughly with log n | Structured reduction; parallel-friendly |
| Fixed k lane accumulators | Shorter chains, not a pairwise proof | SIMD-friendly; order depends on width |
| Kahan | Compensates lost low-order contribution | Extra dependent operations; reassociation-sensitive |
| Neumaier | Handles magnitude inversion better | Extra comparison/operations |
| Wider accumulator | More precision/range | Format and cost are implementation-dependent |
| Checked fixed-point/integer | Exact within represented scale/range | Must detect overflow and define rescale rounding |

Execution/accounting values defined in decimal units should remain in a checked exact representation through accumulation. Risk analytics can use floating point when approximation, conditioning, overflow, and reproducibility policies are explicit.

---

## 23.11 Fixed-point representation and price arithmetic — Core

Fixed point represents `value = raw / 10^Scale`. It exactly represents values on that decimal grid **while raw remains in range**. Scale belongs in the type so incompatible units do not add accidentally:

```cpp
#include <cstdint>
#include <limits>
#include <optional>

template <int Scale>
consteval std::int64_t pow10() {
    static_assert(0 <= Scale && Scale <= 18);
    std::int64_t result = 1;
    for (int i = 0; i < Scale; ++i) result *= 10;
    return result;
}

template <int Scale>
struct Fixed {
    static_assert(0 <= Scale && Scale <= 18);
    static constexpr std::int64_t factor = pow10<Scale>();
    std::int64_t raw{};
};

using Price8 = Fixed<8>; // resolution 1e-8
using WholeQuantity = Fixed<0>;
```

The representable raw range is exactly `INT64_MIN..INT64_MAX`; the real-value range is that interval divided by `10^Scale`. A domain should usually validate a narrower range at ingest—venue price bands, maximum quantity, and maximum notional—rather than treating every `int64_t` bit pattern as business-valid.

### Worked overflow diagnosis: price times whole quantity

A `Price8` raw value already includes `10^8`. Multiplying it by a whole quantity (scale zero) produces another scale-eight value; dividing by `10^8` would be a mixed-scale bug. The arithmetic needs a checked product:

```cpp
#include <cstdint>
#include <limits>
#include <optional>

std::uint64_t magnitude(std::int64_t x) {
    return x < 0
        ? std::uint64_t(-(x + 1)) + 1
        : std::uint64_t(x);
}

std::optional<std::int64_t>
checked_mul(std::int64_t a, std::int64_t b) {
    const bool negative = (a < 0) != (b < 0);
    const std::uint64_t ua = magnitude(a);
    const std::uint64_t ub = magnitude(b);
    const std::uint64_t max = std::numeric_limits<std::int64_t>::max();
    const std::uint64_t limit = negative ? max + 1 : max;

    if (ub != 0 && ua > limit / ub) return std::nullopt;
    const std::uint64_t product = ua * ub;
    if (!negative) return static_cast<std::int64_t>(product);
    if (product == max + 1) {
        return std::numeric_limits<std::int64_t>::min();
    }
    return -static_cast<std::int64_t>(product);
}
```

This handles `INT64_MIN` without negating it and rejects every out-of-range product. A production `Price8 * WholeQuantity` wrapper would return an error/`expected`, preserve scale eight, and validate the resulting notional against a business limit.

For `Fixed<Sa> * Fixed<Sb> -> Fixed<Sr>`, let `d = Sa + Sb - Sr`. The raw product is divided by `10^d` when `d > 0`, multiplied by `10^-d` when `d < 0`, and unchanged when `d == 0`; every lossy division needs stated rounding. A full-width product may be required before rescaling. C++23 has no standard 128-bit integer type. GCC/Clang `__int128`, MSVC intrinsics, multiprecision integers, or a carefully decomposed portable algorithm are implementation choices that must be isolated and tested; unchecked narrowing from an extension type is not a policy.

| Representation | Exact domain | Main advantage | Main cost/risk |
|---|---|---|---|
| Scaled `int64_t` | One declared decimal grid | Compact, exact ordering/addition | Range and every rescale/product must be checked |
| Integer tick index | Instrument's valid tick ladder | Dense levels and exact grid checks | Variable ladders need reference-data mapping |
| Binary floating point | Binary fractions with bounded relative precision | Broad math/library/hardware support | Decimal protocol values generally round |
| Decimal/multiprecision library | Library-defined decimal precision/range | Wider or decimal arithmetic | Dependency, larger state, and workload-specific cost |

C++23 `<stdfloat>` names optional **binary** floating types; it is not a decimal floating-point facility. Integer ticks can be excellent when the ladder mapping is stable and versioned, but a variable tick ladder prevents treating one global tick size as a universal scale.

---

## 23.12 Scale conversion and rounding — Core

Every system boundary is a scale conversion: the exchange's wire format, the internal representation, the risk engine's, the display layer. Each conversion is a rounding decision, and an unspecified one is how positions fail to reconcile.

```cpp
#include <cstdint>
#include <optional>

// divisor is a validated positive power of ten.
std::optional<std::int64_t>
down_half_away(std::int64_t raw, std::int64_t divisor) {
    if (divisor <= 0) return std::nullopt;
    std::int64_t quotient = raw / divisor; // toward zero
    const std::int64_t remainder = raw % divisor;
    const std::uint64_t mag = remainder < 0
        ? std::uint64_t(-remainder)
        : std::uint64_t(remainder);
    const auto d = std::uint64_t(divisor);

    // 2*mag >= d, written without overflowing 2*mag.
    if (mag != 0 && mag >= d - mag) {
        quotient += raw < 0 ? -1 : 1;
    }
    return quotient;
}
```

This implementation avoids `abs(INT64_MIN)` and `raw + divisor/2`, both common overflow bugs. Upscaling is exact only if multiplication by the validated power of ten fits; use checked multiplication before constructing the destination type.

### Rounding modes, compressed

The direction matters more than the mode name. Ties (`x.5`) show the differences most clearly:

| Mode | Rule | Use |
|---|---|---|
| Toward zero (C++ `/`) | Truncate magnitude | Biased toward zero; the accidental default |
| Floor / Ceiling | Always down / always up | Bid-side / ask-side conservative rounding |
| Half away from zero | Ties round away from 0 | Common commercial convention; can introduce magnitude bias |
| Half to even | Ties round to the even neighbor | Reduces tie bias under suitable data assumptions |

No rounding mode is “financially correct” without a contract. Regulations, venue rules, accounting conventions, and conservative risk policy can require different directions.

### Domain-correct rounding

Rounding in a trading system is a risk decision, not a numerical one:

- A policy may round a buy limit down and sell limit up so conversion does not make the order more aggressive. Confirm the venue's sign and price conventions.
- Quantity conversion often rounds down to a lot, but liquidation and risk workflows may have different requirements.
- Reserving fees/margin often uses a conservative direction rather than nearest.
- **Round once, at the boundary.** Repeated round-trip conversions compound error; carry full precision internally and round only when emitting.

### Validation

Many venues require pre-trade tick-grid validation (Chapter 56); relying on a venue rejection adds a network round trip and may violate gateway policy.

```cpp
#include <cstdint>

constexpr bool on_tick_grid(std::int64_t price_raw,
                            std::int64_t tick_raw) {
    return tick_raw > 0 && price_raw % tick_raw == 0;
}
```
With integer prices the grid predicate is exact. Whether division/modulo latency matters depends on whether the tick is compile-time, runtime, and how often the check executes; measure after establishing correctness.

---

## 23.13 Overflow, checked/saturating policies, and sentinels — Core

The value domain a system needs (prices, quantities, PnL) and the representable range of the chosen type are different things. Signed integer overflow is undefined behavior (Chapter 2); unsigned overflow wraps modulo 2^N, which is defined but often still a domain error. A magic “absent” value is silently a valid value of the same machine type.

### Checked arithmetic — detect, then reject

No C++23 standard API provides general checked integer arithmetic. Portable preconditions are straightforward for addition:

```cpp
#include <cstdint>
#include <limits>
#include <optional>

std::optional<std::int64_t>
checked_add(std::int64_t a, std::int64_t b) {
    constexpr auto lo = std::numeric_limits<std::int64_t>::min();
    constexpr auto hi = std::numeric_limits<std::int64_t>::max();
    if ((b > 0 && a > hi - b) ||
        (b < 0 && a < lo - b)) {
        return std::nullopt;
    }
    return a + b;
}
```

Multiplication, division, and negation need their own proofs; `INT_MIN / -1` and `-INT_MIN` are undefined. Some targets trap for some forms, but portable code cannot depend on a trap. Compiler checked-arithmetic builtins and platform intrinsics are useful when isolated behind a tested interface.

### Saturating arithmetic — clamp, silently

Distinct from checked arithmetic: instead of reporting overflow, clamp to the type's limits. C++23 has no general standard saturating-arithmetic API. Some ISAs and libraries provide it, commonly for signal/image domains where clamping is the intended result.

Saturation is suitable when clamping is the domain result, such as a bounded signal. It is generally unsuitable for an authoritative monetary/risk value because a clamped notional is not the requested value. Use checked-and-report unless the specification explicitly defines both clamping and an accompanying status.

### Wrapping arithmetic — intentional modular arithmetic

Correct and intended for hash mixing, PRNGs, CRCs, and sequence-number arithmetic, where comparisons must be wraparound-safe:

```cpp
#include <cstdint>

// Valid only when compared positions are less than 2^31 apart.
bool seq_lt(std::uint32_t a, std::uint32_t b) {
    return static_cast<std::int32_t>(a - b) < 0;
}
```
Not `a < b`, which breaks across the wrap point. The half-range precondition resolves the otherwise ambiguous ordering in a modular space. Protocol chapters own their exact sequence rules.

### Sentinel values — the same gap, without a type system to enforce it

A sentinel is an in-band value reserved to mean "absent" — `-1`, `0`, `INT_MAX`, or NaN. The underlying type does not distinguish it from ordinary data, so misuse often survives compilation.

- **The sentinel becomes valid data.** `-1` for "no price" breaks the day a market trades negative, which happened to WTI crude in April 2020. `0` for "no quantity" collides with a legitimate zero.
- **Arithmetic on sentinels silently propagates.** `INT_MAX + w` can overflow; NaN propagates through many arithmetic operations and may surface far from its origin; summing an array containing a `-1` sentinel can produce a plausible wrong number.
- **Comparisons rank sentinels.** NaN breaks an ordinary `<` ordering (§23.9); an unset integer can enter a reduction as plausible data.
- **Every reader must know the convention**, and there is no compiler diagnostic when a new consumer does not check.

| Approach | Extra cost | Type-safe | Notes |
|---|---|---|---|
| `std::optional<T>` | Discriminator plus possible padding | Mostly — unchecked `*x` on empty is still invalid | Clear default when absence is part of the value |
| `std::expected<T,E>` (C++23) | Stores value/error state; layout-dependent | Yes | Carries a reason, unlike a sentinel |
| Separate validity bitmap | About 1 packed bit/field plus container overhead | Partly | Dense; fits SoA layouts; separate invariant |
| Named constant sentinel + checked accessor | 0 | No | Pragmatic hot-path choice; centralize the check |
| Domain type with checked construction/access | Representation-dependent | Yes at API boundary | Can centralize sentinel or bitmap policy |

`std::optional` often communicates absence well, but its size/layout is implementation-dependent and can affect dense arrays. A separate validity bitmap can improve density and vector operations at the cost of keeping two structures consistent. Measure the chosen representation.

If a sentinel is used, prove it lies outside the validated business domain, name it, centralize decoding, and prevent it from reaching arithmetic. `INT64_MIN` is suitable only if the domain explicitly excludes that raw value. Protocol-reserved values must be interpreted according to the protocol, not a local convention.

### Detection tooling

| Tool | Catches | Qualification |
|---|---|---|
| Undefined-behavior sanitizer | Signed overflow, bad shifts/division in exercised paths | Runtime overhead is workload/toolchain-dependent |
| Unsigned-integer sanitizer where available | Unsigned wrap | Also flags intentional modular arithmetic |
| `-fwrapv`-style compiler option | Gives implementation-defined build semantics for signed wrap | Toolchain policy; can change optimization |
| Conversion warnings | Narrowing and sign changes | Static and useful, but noisy in existing code |

Run sanitizer and boundary tests in CI, but keep explicit checked arithmetic in production logic. A post-operation check such as `a + b < a` is already too late for signed arithmetic because evaluating the overflowing expression is undefined.

---

## 23.14 Decimal boundaries and tick precision — Role-specific

Chapter 13 owns bounded, locale-independent numeric parsing with `<charconv>`. This chapter owns the **policy after tokenization**: how decimal digits map to an exact internal scale.

Do not route a fixed-point field through `double`. Parse sign, integer digits, and fractional digits as bounded character ranges; accumulate with checked integer operations; then apply the declared excess-digit policy.

| Boundary question | Example | Required policy |
|---|---|---|
| Empty/sign-only input | `""`, `"-"` | Reject |
| Decimal grammar | `"1."`, `".5"`, leading `+` | Accept/reject according to protocol, not convenience parser behavior |
| Extra fractional digits | `"1.2345"` into scale 2 | Reject or name a rounding mode |
| Rounding carry | `"9.999"` to scale 2 | Produce `10.00` only after checked carry |
| Negative extreme | value mapping to `INT64_MIN` | Avoid magnitude negation; check asymmetric range |
| Trailing characters | `"12.3x"` | Require full-field consumption |
| Domain range | syntactically valid extreme price | Reject before constructing domain type |
| Tick grid | valid decimal off current ladder | Reject or round in declared side-aware direction |

The parser result should distinguish grammar, excess precision, representation overflow, and domain rejection; collapsing them into zero or a sentinel loses operational evidence. Test at least both `int64_t` extremes, rounding carries, one digit above/below every tie, embedded zero, and the protocol's maximum field length.

Formatting fixed point is integer quotient/remainder plus zero-padded fractional digits. It must handle `INT64_MIN` without `-raw`, emit the exact declared scale, and use a caller-supplied bounded buffer when allocation is forbidden. Chapter 13 covers `to_chars` buffer/error mechanics.

Tick size can vary by instrument and price band, so price-to-level mapping is reference data, not always one division. Version derived lookup tables with the source ladder and update them atomically according to the system's publication design. Fractional ticks require a rational or scale that exactly represents the denominator; decimal power-of-ten scaling cannot represent denominators with prime factors other than two and five.

---

## Recall and Practice — Core
### Recall card

1. Name n, the case/probability model, and the resource counted before stating a complexity.
2. Amortized is a sequence guarantee; expected is probabilistic; neither is a per-operation worst-case bound.
3. Cache-transfer models explain locality and dependency mechanisms but remain idealizations; validate with the production working set.
4. Conditioning is a problem property; stability is an algorithm property. More precision does not erase either distinction.
5. Sterbenz gives exact subtraction only under stated floating/range conditions; cancellation can expose prior operand error.
6. Comparison policy must cover equality, ±0, infinities, NaN, near-zero absolute tolerance, and relative scale.
7. SIMD lane accumulators are not automatically pairwise summation; the reduction tree determines the error argument.
8. Fixed point is exact only within its scale and checked raw range. Every lossy conversion names rounding.
9. Checked arithmetic reports; saturating arithmetic clamps; modular arithmetic wraps intentionally; sentinels encode state in-band.
10. Decimal parsing mechanics belong to Chapter 13; Chapter 23 defines scale, excess precision, overflow, domain, and tick policies.

### Questions

1. Two designs perform O(log n) comparisons, but one compares fixed IDs and the other long strings. Write a cost model that exposes the missing work.
2. Prove geometric-growth append is amortized O(1), then explain why that proof does not satisfy a hard per-message latency budget.
3. Choose the right model for (a) a contiguous scan, (b) a pointer chain, and (c) a parallel reduction; name one blind spot in each model.
4. A near-equal subtraction has a large relative error. How can the subtraction be exact while the result is inaccurate?
5. Define `almost_equal` policies for zeros, infinities, NaNs, near-zero values, and ordinary magnitudes.
6. Why do four SIMD accumulators not by themselves prove pairwise-summation accuracy?
7. Derive the raw result scale for `Fixed<8> * Fixed<0> -> Fixed<8>` and for `Fixed<8> * Fixed<8> -> Fixed<8>`.
8. Compare reject, saturate, and wrap for a risk notional and for a packet sequence number.
9. Design a decimal-to-scale-2 boundary policy for `"9.999"`, `"-0.005"`, `"1."`, and the `int64_t` extremes.
10. When can precomputation reduce latency yet worsen whole-system tail behavior?

### Common traps

| Trap | Why it fails | Better reasoning |
|---|---|---|
| “O(1) means fast/bounded” | It hides constants, case, allocation, and contention | Name unit and per-operation bound |
| “Average” without distribution | No probability model is defined | State input/randomness assumptions |
| Reserve guarantees no growth forever | Bound can be exceeded | Enforce capacity and full policy |
| One hardware-latency table as a constant | Microarchitecture and system state differ | Measure target and state assumptions |
| Near-equal subtraction is always exact | Sterbenz has representability/range conditions | State theorem and prior operand error |
| One global epsilon | Units and magnitudes differ | Domain absolute/relative tolerances |
| Fixed point cannot overflow | Raw arithmetic is still bounded integer arithmetic | Checked intermediates and domain limits |
| Add half before integer division | Addition and `-INT64_MIN` can overflow | Quotient/remainder rounding |
| Saturation as “safe overflow” | It silently changes financial value | Reject/report unless clamping is domain semantics |
| Parse through `double`, then scale | Introduces binary rounding before exact representation | Parse decimal digits directly per Chapter 13 |

### Code-reading puzzle

```cpp
#include <optional>
#include <span>
#include <utility>

std::optional<std::pair<double, double>>
unstable_stats(std::span<const double> values) {
    if (values.empty()) return std::nullopt;
    double sum = 0.0;
    double sumsq = 0.0;
    for (double x : values) {
        sum += x;
        sumsq += x * x;
    }
    const double n = static_cast<double>(values.size());
    const double mean = sum / n;
    return std::pair{mean, sumsq / n - mean * mean};
}
```
For values with a large offset and tiny spread, identify the two long accumulation chains and the final cancellation. Compare a tree/compensated sum and Welford. What policies are still missing for NaN, infinity, and population versus sample variance?

### Implementation exercise

Design a fixed-point money type for a single currency, `FixedMoney<Scale>`, backed by `int64_t`. Specify, in writing, before implementing:

- the scale and the resulting resolution and maximum representable magnitude;
- the wide intermediate type used for multiplication and why it is sized the way it is;
- the rounding direction for every lossy operation (rescale, divide, multiply-then-rescale), stated per operation, not once for the whole type;
- the overflow policy (reject vs. saturate vs. UB) for addition, multiplication, and rescaling, and which one is correct for this type and why;
- the boundary validation performed on any externally supplied raw value before it enters arithmetic.

Then implement `operator+`, `operator*(FixedMoney, int64_t quantity)`, and `rescale<NewScale>()`, each enforcing the policy. Test maximum plus one, `INT64_MIN`, an intermediate-width multiply, ties of both signs, a rounding carry, and out-of-range rescale. If the wide type is non-standard, isolate it behind a feature-checked adapter and test its fallback.

As a second exercise, compare Welford, Kahan/tree summation, and the naive variance formula on an adversarial dataset with a large offset and tiny spread. Use a higher-precision or exact reference where available, explain why the dataset is ill-suited to `E[x²]-E[x]²`, and report both absolute and relative error.

Finally, choose a cost model for three operations: a hash lookup with long string keys, an SPSC queue under bursts, and a scan of a structure-of-arrays column. State n, unit, case/distribution, locality assumption, and the measurement that could falsify the model.

### Prerequisites for Chapter 24

Chapter 24 assumes the amortized/worst-case distinction from §§23.3–23.4 and the cache-transfer model from §23.6. It applies them to locks, queues, false sharing, and contended lines while keeping correctness (happens-before) separate from performance (spin, park, and contention).
