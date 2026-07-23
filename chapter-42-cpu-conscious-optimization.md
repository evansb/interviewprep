# Chapter 42 — CPU-Conscious Optimization

## Why This Matters — Core

CPU-conscious optimization is the translation from evidence to a smaller cost. A profile says where time or latency accumulates; the engineer must decide whether the governing mechanism is unnecessary data movement, poor locality, branch recovery, a dependency chain, instruction throughput, or frequency behavior. Changing syntax without that model often makes the program more complicated while moving no relevant metric.

This chapter applies the machinery introduced earlier. Chapter 27 owns execution, prediction, and out-of-order concepts; Chapters 28–29 own caches, coherence, DRAM, and NUMA; Chapter 30 owns reference latency numbers; Chapter 40 owns compiler transformations and reports. Here the question is: **given a measured workload, which source/data change should we try, what does it trade away, and what evidence would make us keep or roll it back?**

The governing loop is:

```
workload + correctness contract
             │
             ▼
baseline distribution + profile ─▶ cost model ─▶ one bounded change
             ▲                                      │
             └──── inspect code + remeasure ◀───────┘
                              │
                        keep or roll back
```

## 90-Second Screen — Core

Five facts:

1. Optimize a named workload and metric—such as feed-handler p99.9 latency at a specified message rate—not “the function” in the abstract.
2. Layout follows access pattern. SoA can reduce bytes fetched for field-wise scans; AoS can reduce misses for random full-record access; neither is universally superior.
3. Branchless code exchanges control dependencies for extra work and data dependencies. It helps only when those new costs are lower than measured branch recovery.
4. SIMD increases work per instruction, not necessarily work per cycle or per request. Aliasing, reductions, tails, memory bandwidth, code size, and target-specific frequency behavior can erase the gain.
5. Alignment, prefetch, lookup tables, non-temporal stores, and intrinsics all carry preconditions. A violated precondition can cause undefined behavior or incorrect publication, not merely slower code.

Two decisions to defend:

- Which bottleneck does this change attack, and which counter, code observation, or distribution would falsify that model?
- What portability, memory, precision, power, code-size, or maintainability cost does it add, and how is rollback kept cheap?

## 42.1 The Optimization Contract — Core

Before touching code, write a short contract. This prevents a throughput win for a synthetic batch from being shipped into a tail-latency path.

| Contract item | Example | Why it constrains the optimization |
|---|---|---|
| Workload | 64–512 byte market-data messages, bursty at open | Determines reuse, branch entropy, and batch size |
| Metric | End-to-end p99.9 and sustained messages/s | Distinguishes latency from throughput |
| Correctness | Bit-identical integer result; no dropped sequence | Excludes unsafe arithmetic and lossy batching |
| Deployment | Linux x86-64 baseline plus AVX2 fleet subset | Determines legal ISA and dispatch |
| Resource budget | One isolated core; 32 MiB extra memory allowed | Prices polling, tables, and duplicated layouts |
| Baseline | Exact commit, flags, data set, raw samples | Makes comparison and rollback possible |

Chapter 43 owns experimental design. The minimum here is still strict: use production-shaped data, retain raw distributions, warm or intentionally cold-start both variants the same way, and separate setup from the timed region. A profile collected on a different input distribution is not evidence for the target path.

### Keep Evidence Layers Separate

Optimization claims commonly mix five layers:

| Label | What it means | Example |
|---|---|---|
| **C++23 guarantee** | Required by the language/library | Unsigned arithmetic wraps modulo \(2^N\) |
| **Compiler observation** | Output of a named compiler and flags | Clang 21 vectorized a loop after an alias check |
| **ISA fact** | Architectural instruction semantics | x86 AVX2 has 256-bit integer vector operations |
| **Microarchitecture behavior** | A particular CPU implementation | A target core has a given load latency or vector-frequency policy |
| **Measurement** | Result for this executable and workload | SoA reduced p99.9 on host class A |

Only the first two can be inferred from the standard or generated code alone. An instruction sequence does not reveal cache residency, branch entropy, OS noise, or achieved frequency. Conversely, a counter name is not portable across PMUs. State the layer next to the claim.

This separation also controls the strength of the prose. “The compiler emitted an
AVX2 loop” is a directly inspectable observation. “That loop reduced instructions”
needs a counter measurement. “It is faster” needs elapsed-time samples for the
declared workload. “It is the version we should ship” additionally needs the
correctness, tail-latency, deployment, and resource gates from the contract. Moving
between those statements without new evidence is one of the easiest ways to turn a
promising experiment into folklore.

### A Repeatable Workflow

1. **Constrain.** Freeze input distribution, correctness, metric, deployment target, and resource budget.
2. **Locate.** Use time profiles and distributions to find the path correlated with the metric. Sampling finds expensive regions; counters help classify mechanisms.
3. **Model.** Estimate bytes, cache lines, branches, dependent operations, instructions, and parallel work per item.
4. **Change one governing cost.** Split hot/cold data, shorten a dependency chain, make work contiguous, batch by type, or expose vector independence.
5. **Inspect.** Check optimization remarks and assembly. Confirm the expected loads, branches, vector width, and fallback path exist.
6. **Remeasure.** Compare throughput and latency distributions, resource use, and at least one adverse workload.
7. **Decide.** Keep the change only if the target metric improves without violating correctness or budgets; otherwise revert it and retain the evidence.

This workflow is slower than guessing for the first hour and faster over the life of the system.

## 42.2 From Profile to Cost Model — Core

A hotspot is a location, not an explanation. The same loop can be memory-bound on a large cold data set, branch-bound on irregular input, or dependency-bound when everything is resident.

| Evidence pattern | Candidate mechanism | First source/data question |
|---|---|---|
| Time grows with bytes; cache/TLB misses rise | Locality or bandwidth | Can the hot loop fetch fewer or more contiguous bytes? |
| Retired work is modest; branch recovery is prominent | Unpredictable control | Can data be partitioned, branch moved out, or cheap selection used? |
| Low useful parallelism with resident data | Critical dependency chain | Can accumulators or requests be made independent? |
| Vectorization report says alias/dependence | Compiler cannot prove independence | Can the interface express non-overlap or loop independence safely? |
| Instruction count drops but elapsed time does not | Different bottleneck, frequency, or front-end effect | Did width/code layout change achieved clock or cache behavior? |
| Mean improves while tail regresses | Cold path, queueing, or rare input | Which samples moved, and what new work occurs only there? |

Counter ratios are supporting evidence, not universal cutoffs. “One percent branch misses” has no stable meaning without branch density, penalty, overlap, and the target metric. Use counters to compare variants on the same PMU and workload, then localize with source/assembly. Chapter 43 explains multiplexing and sampling bias.

### The First Triage Pass

Begin with questions that can eliminate whole classes of transformations:

1. **Does elapsed cost scale with items, bytes, or a particular input
   property?** A size sweep can separate fixed setup from per-item work. A sweep
   over sorted, random, and skewed inputs can expose branch or lookup
   sensitivity.
2. **Is the hot region inclusive or exclusive cost?** A caller may look hot only
   because it invokes allocation, locking, parsing, or a cold helper. Optimize the
   actual leaf or change the call frequency.
3. **Is useful work reaching the target core?** Queueing, migration, page faults,
   throttling, and contention can dominate an end-to-end sample even when the
   inner loop is excellent.
4. **Does the working set cross a visible knee?** Compare several sizes rather
   than labeling the loop “cache-bound” from one large run. The knee is an
   observation for that host and concurrent workload, not a portable cache
   capacity constant.
5. **Which events correlate with slow samples?** A high aggregate counter value
   is weaker evidence than a change that tracks the latency distribution across
   inputs or variants.

Then choose one mechanism. If the hypothesis is “cold fields waste transfer,” do
not simultaneously add prefetch, unrolling, and intrinsics. The combined version
cannot tell which cost moved, and interactions make rollback harder. A useful
stop gate is: if you cannot name the source-level change, expected generated-code
change, and metric expected to move, collect more evidence before implementing.

### Back-of-the-Envelope Models

Useful models are small:

- **Bytes per item:** record stride × records visited, adjusted for fields actually consumed and write allocation.
- **Lines per item:** distinct cache lines touched, including metadata and output.
- **Branch cost:** outcomes × observed misprediction probability × target recovery cost.
- **Dependency bound:** chain latency × dependent steps, divided only by independent chains actually available.
- **Vector ceiling:** scalar work / lanes, capped by memory traffic, instruction throughput, reductions, and tails.

The estimate need not predict nanoseconds. It must distinguish competing hypotheses. If an AoS scan transfers four times the hot bytes of an SoA scan, layout is plausible. If both fit in L1 and the loop is a serial hash chain, layout is not the first lever.

## 42.3 Data-Oriented Design and AoS/SoA — Core

Data-oriented design means shaping representation around important operations while preserving a coherent API. It does not mean “avoid classes.” Often the class should own a collection and enforce relationships among its arrays.

Consider a quote cache:

```cpp
#include <cstdint>
#include <vector>

struct Quote {
    std::uint64_t id;
    std::int64_t price;
    std::uint32_t quantity;
    std::uint32_t flags;
    char symbol[16];
};

std::uint64_t total_quantity(const std::vector<Quote>& quotes) {
    std::uint64_t total = 0;
    for (const Quote& q : quotes) total += q.quantity;
    return total;
}
```

The loop consumes four bytes from each `Quote` but advances by `sizeof(Quote)`. On a target with 64-byte cache lines, multiple cold fields share the transferred lines. A structure-of-arrays representation makes the requested field contiguous:

```cpp
struct QuoteColumns {
    std::vector<std::uint64_t> id;
    std::vector<std::int64_t> price;
    std::vector<std::uint32_t> quantity;
    std::vector<std::uint32_t> flags;
    // symbol storage can remain on a cold path

    [[nodiscard]] std::size_t size() const noexcept {
        return quantity.size();
    }
};

std::uint64_t total_quantity(const QuoteColumns& quotes) {
    std::uint64_t total = 0;
    for (std::uint32_t q : quotes.quantity) total += q;
    return total;
}
```

This is a hypothesis: fewer hot bytes, denser prefetch, and a simpler vectorization shape. It also introduces invariants—column sizes, stable row identity, coordinated erase—and can worsen full-record random access.

| Access pattern | Candidate layout | Expected benefit | Main cost/failure |
|---|---|---|---|
| Scan one or two fields | SoA or hot/cold split | Higher line utilization; unit-stride vectors | Parallel-array invariants |
| Randomly inspect most fields | AoS | One record's fields arrive together | Field-wise scans fetch cold bytes |
| Scan groups, then inspect rows | AoSoA (blocked SoA) | Vector-friendly blocks with bounded locality | Block/tail complexity |
| Rare cold metadata | Hot/cold split joined by index | Keeps scan footprint small | Extra lookup on cold path |
| Frequent insert/erase of complete records | AoS or indirection over dense storage | Simpler coordinated mutation | Possible fragmentation/extra mapping |

### Indices, Handles, and Object Graphs

An index can be narrower than a pointer, survives remapping, and lets a dense owner validate generation. It does not automatically make access independent: `next = nodes[next].next` remains a serial pointer-equivalent chain. The win comes from compact storage or from changing traversal, not from spelling the address differently.

A robust collection exposes a handle `{index, generation}` and performs all column mutation in one method. Debug builds assert equal sizes. Stable external identity remains separate from dense row position, allowing swap-erase without corrupting clients. Chapter 21 owns data-structure choices; Chapter 9 owns ownership.

### AoSoA and Stream Count

Pure SoA creates one stream per field. A loop consuming many fields can pressure prefetch tracking, TLB reach, and registers. AoSoA groups a fixed number of rows:

```cpp
#include <cstddef>
#include <cstdint>

template<std::size_t Lanes>
struct QuoteBlock {
    alignas(64) std::int64_t price[Lanes];
    std::uint32_t quantity[Lanes];
    std::uint32_t flags[Lanes];
};
```

`64` here is a deployment choice for layout, not a C++ cache-line guarantee. Select `Lanes` from the vector width, fields used together, and measured tile footprint. Keep a scalar or masked tail path.

## 42.4 Alignment, Locality, and Loop Tiling — Core

Alignment has three separate meanings:

- **Language correctness:** every object must satisfy `alignof(T)`. Violating it is undefined behavior even if the hardware tolerates the access.
- **Instruction requirement:** some ISA operations require or benefit from a particular address alignment; unaligned variants may be available.
- **Placement goal:** separating independent writers, avoiding line splits, or making block boundaries predictable.

Do not substitute one for another. `alignas(64)` does not promise that 64 is a cache-line size on every target, and page-aligning every buffer can create identical cache-set offsets.

```cpp
#include <cstddef>
#include <memory>
#include <span>

float sum_aligned(std::span<const float> input) {
    // Precondition belongs to the caller; violating it makes the assumption invalid.
    if (input.empty()) return 0.0f;
    const float* p = std::assume_aligned<32>(input.data());
    float sum = 0.0f;
    for (std::size_t i = 0; i < input.size(); ++i) sum += p[i];
    return sum;
}
```

`std::assume_aligned` is C++20. It emits no runtime check and should appear only behind an allocator/type invariant or a checked dispatch. The compiler may use the assertion to remove a versioning/peeling path. Whether that changes time depends on the generated loop and target.

### Tiling

Tiling reorders a large iteration space so a working subset is reused before eviction. For a kernel touching `A`, `B`, and `C`, a first model is:

\[
\text{tile bytes} =
T \times (\text{bytes of A per item} + \text{bytes of B per item}
          + \text{bytes of C per item})
\]

Choose `T` so the live tile leaves headroom in the intended cache for stack, metadata, conflicts, and other threads. Cache capacity is not the usable budget. Then sweep neighboring sizes on each supported host class.

```cpp
for (std::size_t base = 0; base < n; base += tile) {
    const std::size_t end = std::min(base + tile, n);
    for (std::size_t i = base; i < end; ++i) {
        consume(a[i], b[i], c[i]);
    }
}
```

This one-dimensional form helps only if `consume` or later passes reuse the tile. Tiling a single streaming pass adds branches without creating reuse. Matrix multiplication, multi-pass normalization, and block joins are stronger candidates. Compilers routinely interchange or unroll simple loops; general cache tiling is usually an algorithm/data decision.

### Loop Transformations as Trade-offs

| Transformation | Mechanism | Can lose when |
|---|---|---|
| Interchange | Makes inner access unit-stride | Changes order/legality or harms another operand |
| Fusion | Reuses data before eviction; removes loop overhead | Raises register pressure or couples rare work |
| Fission | Shrinks hot working set; separates vectorizable work | Adds passes and memory traffic |
| Unrolling | Exposes independent operations; reduces branch overhead | Inflates code, registers, and front-end footprint |
| Tiling | Creates bounded reuse | Tile overhead exceeds reuse or size is wrong |

Inspect the compiler's existing transformation before hand-writing it.

## 42.5 Dependency Chains and Software Pipelining — Core

Throughput resources do not help a single serial recurrence. If each iteration needs the previous result, the critical path is:

```
x0 ──op──▶ x1 ──op──▶ x2 ──op──▶ x3
```

Independent chains let the out-of-order engine overlap latency:

```
a0 ──op──▶ a1 ──op──▶ a2
b0 ──op──▶ b1 ──op──▶ b2
c0 ──op──▶ c1 ──op──▶ c2
                   \   |   /
                    combine
```

An integer sum is a compact example. Unsigned arithmetic makes overflow semantics explicit:

```cpp
#include <cstddef>
#include <cstdint>
#include <span>

std::uint64_t sum_four(std::span<const std::uint32_t> values) {
    std::uint64_t a = 0, b = 0, c = 0, d = 0;
    std::size_t i = 0;
    for (; i + 3 < values.size(); i += 4) {
        a += values[i + 0];
        b += values[i + 1];
        c += values[i + 2];
        d += values[i + 3];
    }
    std::uint64_t total = (a + b) + (c + d);
    for (; i < values.size(); ++i) total += values[i];
    return total;
}
```

The compiler may already unroll and vectorize the simple one-accumulator source, so inspect before preserving manual code. The number of useful accumulators is target- and operation-dependent: enough to cover latency at achieved issue throughput, but not enough to spill registers or enlarge the reduction excessively.

Floating-point reduction is a correctness decision. Reassociating into multiple accumulators changes rounding and special-value behavior; ordinary C++ does not allow the compiler to pretend addition is associative under strict rules. If the domain permits an error bound or deterministic tree reduction, encode and test that contract. Do not introduce fast-math globally to solve one loop.

### Software Pipelining

Software pipelining overlaps stages from different items:

```
iteration i:      use load[i]
iteration i + D:  issue load[i + D]
```

It is useful when future addresses are known early and hardware scheduling/prefetch does not already cover latency. Options include unrolling several independent requests, batching lookups, or issuing a software prefetch.

```cpp
for (std::size_t i = 0; i < n; ++i) {
    if (i + distance < n) {
        __builtin_prefetch(&table[index[i + distance]], 0, 1); // GCC/Clang
    }
    result += table[index[i]];
}
```

The builtin is a compiler extension, and its locality argument is only a hint. The prefetch address must itself be safe to compute. Distance depends on miss latency, work per iteration, memory-level parallelism, and cache lifetime; too near arrives late, too far consumes bandwidth or evicts before use. Sequential streams are often already recognized by hardware. Keep prefetch only when miss-latency evidence and adverse-workload tests support it.

Pointer chasing cannot be repaired by prefetch if the next address is unknown until the current miss completes. Change representation, batch several independent chains, or accept the serialization.

## 42.6 Branches, Branchless Code, and Conditional Moves — Core

Branchless programming is a cost exchange:

\[
C_{\text{branch}} =
C_{\text{selected arm}} +
p_{\text{mispredict}} C_{\text{recovery}}
\]

\[
C_{\text{branchless}} =
C_{\text{both/encoded arms}} +
C_{\text{new dependency}}
\]

The variables come from the workload and target. Predictable branches can skip substantial work and allow speculation past a not-yet-ready condition. Branchless code is attractive when outcomes have measured entropy, both alternatives are cheap and safe to evaluate, and the selection does not lengthen a critical chain.

```cpp
#include <cstdint>
#include <span>

std::uint64_t sum_if(std::span<const std::uint32_t> values,
                     std::uint32_t threshold) {
    std::uint64_t sum = 0;
    for (std::uint32_t x : values) {
        if (x > threshold) sum += x;               // branch or if-converted
    }
    return sum;
}

std::uint64_t sum_mask(std::span<const std::uint32_t> values,
                       std::uint32_t threshold) {
    std::uint64_t sum = 0;
    for (std::uint32_t x : values) {
        const std::uint64_t mask =
            std::uint64_t{0} - static_cast<std::uint64_t>(x > threshold);
        sum += static_cast<std::uint64_t>(x) & mask;
    }
    return sum;
}
```

Both are C++23 and produce the same unsigned result. They do not guarantee a branch or a conditional move: the compiler can if-convert either representation. Compare optimization output and assembly for the named compiler, then measure predictable, alternating, and production distributions.

### Conditional Moves

On x86, `cmovcc`; on AArch64, `csel` and relatives select without a control transfer. This is an ISA observation, not source semantics. A conditional move waits for the condition and selected-value inputs, converting a control dependency into a data dependency. A predicted branch can execute downstream speculatively.

Prefer an actual branch when one arm:

- performs an expensive call or store;
- may fault or is not legal for all inputs;
- is rarely needed and can remain cold;
- would put selection on a loop-carried chain.

Prefer selection/masking as a hypothesis when both values are already available and branch outcomes are difficult to predict. Never “force `cmov`” with fragile inline assembly before checking whether the compiler chose a better sequence. PGO and code layout belong to Chapter 40.

### Higher-Level Control Changes

Instruction-level branch removal is often weaker than changing the work:

- Hoist a loop-invariant condition outside the loop.
- Partition or batch messages by type so each loop is homogeneous.
- Separate valid common input from rare validation/error handling.
- Replace unpredictable virtual/indirect dispatch over a mixed collection with per-type batches where the architecture permits it.

These trades can add buffering and delay individual items, so throughput and tail latency must both be measured.

## 42.7 Lookup Tables: Compute Versus Fetch — Core

A lookup table replaces computation with an indexed load. It wins when the table entry is available sooner than recomputation and the footprint does not displace more valuable data.

Good candidates include compact byte classification, CRC tables chosen for a specific kernel, digit-pair formatting tables, and protocol state transitions. Poor candidates are large tables accessed randomly with little reuse, especially when the replaced computation is a few arithmetic instructions.

| Question | Evidence |
|---|---|
| How large is the table including padding? | Object/map size and relevant page count |
| What is the access distribution? | Production indices, not uniform synthetic indices unless realistic |
| Where does it hit? | Cache/TLB counters and latency sensitivity |
| What does it evict? | Whole-process profile, not isolated LUT benchmark |
| Is initialization on the critical startup path? | Startup trace; prefer `constexpr` where appropriate |
| Is dispatch still unpredictable? | Indirect-branch profile if entries are function pointers |

```cpp
#include <array>
#include <cstdint>

constexpr auto make_hex_class() {
    std::array<std::uint8_t, 256> result{};
    for (unsigned c = '0'; c <= '9'; ++c) result[c] = 1;
    for (unsigned c = 'A'; c <= 'F'; ++c) result[c] = 1;
    for (unsigned c = 'a'; c <= 'f'; ++c) result[c] = 1;
    return result;
}

inline constexpr auto kIsHex = make_hex_class();
```

This table has no dynamic initializer. Whether it beats comparisons depends on surrounding parsing, cache residency, and vectorization. Some SIMD ISAs provide byte-shuffle/permutation instructions that act as tiny in-register tables; those are target-specific kernel techniques, not a reason to convert the entire parser to intrinsics.

Measure cold and steady-state cases. Repeating a table lookup until the table remains resident answers a different question from sporadic access after unrelated work.

## 42.8 Scalar Versus Vector Execution — Core

SIMD executes one operation over multiple lanes. The useful speedup is bounded by the vectorizable fraction and by whichever resource becomes limiting:

\[
S \leq
\min(\text{lane width},\ \text{load/store capacity},\
\text{compute throughput},\ \text{dependency freedom})
\]

Vectorization also adds setup, tail handling, possible runtime alias/alignment checks, and horizontal reduction. A short or early-exit loop can favor scalar code. A memory-bandwidth-bound loop may issue fewer instructions without transferring fewer bytes.

### Start with Vectorizable Source

The most portable route in C++23 is simple scalar source that exposes independence:

```cpp
#include <cstddef>
#include <span>

void scale(std::span<float> values, float factor) {
    for (float& x : values) x *= factor;
}
```

Ask the compiler for an optimization report and inspect the target build. Common blockers are:

- possible overlap between input/output ranges;
- loop-carried dependence;
- calls that were not inlined or lack vector semantics;
- non-unit stride or gathers;
- early exit;
- floating-point reassociation requirements;
- a cost model that finds setup/tail work unprofitable.

Fix truth in the interface rather than asserting fiction. Compiler `restrict` spellings are extensions; use them only when callers really provide non-overlap. Pragmas that promise independence can make a program wrong if the promise is false.

### Intrinsics

Intrinsics expose a particular ISA. They are appropriate when a measured kernel cannot obtain required instructions from portable source, or when explicit masks/shuffles are central to the algorithm. They impose:

- separate implementations or a deployment-wide ISA requirement;
- runtime dispatch before executing unsupported instructions;
- explicit tails, alignment, and lane semantics;
- more code to test across compilers and CPUs;
- possible inhibition of higher-level compiler transforms.

This AVX2 implementation is x86-specific and must be compiled only for an AVX2 target:

```cpp
#include <cstddef>
#include <immintrin.h>

void scale_avx2(float* values, std::size_t n, float factor) {
    const __m256 f = _mm256_set1_ps(factor);
    std::size_t i = 0;
    for (; i + 8 <= n; i += 8) {
        __m256 x = _mm256_loadu_ps(values + i);
        x = _mm256_mul_ps(x, f);
        _mm256_storeu_ps(values + i, x);
    }
    for (; i < n; ++i) values[i] *= factor;
}
```

`loadu` avoids an alignment precondition; it does not promise equal cost for every address. Compare this with autovectorized `scale`, including small sizes and misaligned inputs. If deployed broadly, select the function through a one-time capability dispatch, not a feature test inside the element loop.

### `std::simd` Status

C++23 does **not** contain `std::simd`. Data-parallel types have appeared in the Parallelism TS and in experimental library namespaces, but those spellings and guarantees are not portable C++23. For this book's language baseline, use portable loops, a vetted portability library, or isolated target intrinsics, and label the dependency/toolchain explicitly.

### Numerical Semantics

Element-wise integer or floating operations can often vectorize without changing order. Reductions, scans, and fused operations are different:

- floating reassociation changes rounding and NaN/signed-zero behavior;
- FMA can produce a different correctly rounded result from multiply then add;
- narrow integer lanes may wrap where promoted scalar C++ would not;
- saturating ISA arithmetic differs from ordinary C++ arithmetic.

Define acceptable error, reproducibility, and exceptional-value behavior before choosing the fast path.

## 42.9 Architecture-Specific SIMD Hazards — Reference

*Skippable on a first pass. Verify every item against the deployed CPU, compiler, ABI, and library.*

| Hazard | Scope | Mechanism | Validation/mitigation |
|---|---|---|---|
| Partial-register dependency | Mainly historical/current x86 cases | A narrow write can leave old upper state or require merging | Inspect disassembly and target-specific dependency counters |
| False destination dependency | Particular instructions/microarchitectures | Hardware treats a destination as if its prior value were an input | Use a recognized zero idiom only when target guidance/codegen supports it |
| AVX-to-legacy-SSE transition | Older Intel x86 and mixed encodings | Dirty upper vector state crosses into legacy SSE | Let compiler emit `vzeroupper`; audit handwritten assembly and boundaries |
| Wide-vector frequency behavior | Some Intel/other CPU families, workload-dependent | Power/current policy lowers achieved frequency for heavy vectors | Compare `cycles`, reference cycles, wall time, and per-core frequency telemetry |
| Lane-local shuffle | ISA-specific | Operation does not cross 128-bit or other lane boundaries | Test boundary vectors and inspect intrinsic documentation |

Do not carry a cycle count from one CPU generation into another. On older Intel designs, mixed AVX and legacy SSE could create substantial transition work; later designs changed the mechanism, and AMD behavior differs. Compilers normally manage upper-state cleanup for compiled functions, but handwritten assembly, JITs, and unusual call boundaries still require review.

Likewise, “AVX-512 is slow” is not a useful statement. Some server CPUs reduce frequency for particular widths/instruction mixes; other generations reduce less or implement width differently. A vector kernel can finish sooner even at a lower clock, while neighboring scalar work or post-kernel latency can regress. Measure the whole co-scheduled workload. A narrower preferred vector width is a compiler/deployment option, not a universal fix.

### Partial and False Dependencies

Source-level examples rarely map one-to-one to the issue. A C++ assignment to an 8-bit value can compile into a full-width operation; an intrinsic or inline-assembly constraint can accidentally preserve a dependency. The reliable procedure is:

1. localize a latency/throughput problem after cache and branch causes are weak;
2. inspect the actual register writes;
3. consult the optimization manual for the exact CPU;
4. alter codegen in a tiny isolated function;
5. verify the relevant counter or throughput changed.

Zero idioms such as x86 `xor reg, reg` are recognized specially on many cores, but writing source `x ^= x` is not a portable request for that instruction and can be optimized in other ways.

## 42.10 Non-Temporal Memory Operations — Role-specific

Non-temporal stores are ISA-specific hints for streaming data with little near-term reuse. On x86, aligned streaming stores can use write-combining resources and avoid allocating the destination line in ordinary caches. For large full-overwrite streams this may reduce read-for-ownership traffic and protect a hot cache working set.

The benefit has strict conditions:

- the destination is suitably aligned for the selected intrinsic/instruction;
- stores cover large contiguous regions, preferably complete lines;
- the consumer does not immediately reread the data;
- concurrent streaming destinations do not exhaust write-combining resources;
- publication occurs only after the architecture-required ordering operation;
- the measured gain includes effects on other threads and memory bandwidth.

```cpp
// x86 AVX2 excerpt: destination alignment and n%8 are caller preconditions.
#include <cstddef>
#include <immintrin.h>

void stream_copy_avx2(float* dst, const float* src, std::size_t n) {
    for (std::size_t i = 0; i < n; i += 8) {
        const __m256 x = _mm256_loadu_ps(src + i);
        _mm256_stream_ps(dst + i, x);
    }
    _mm_sfence();  // order streaming stores before later publication
}
```

The function is intentionally a constrained kernel, not a general `memcpy`: `dst` must meet the intrinsic's alignment, ranges must not overlap, `n` must be a multiple of eight, and runtime dispatch must establish AVX2. A wrapper handles head/tail, overlap policy, and small sizes with ordinary operations.

On x86, a C++ release store alone need not provide the `SFENCE` required to order preceding non-temporal stores before publishing a ready flag; the ISA ordering rule is additional to the C++ source-level relation. Encapsulate the streaming copy and publication protocol together so the fence cannot be omitted.

Non-temporal loads have different and memory-type-specific behavior; do not infer that an intrinsic bypasses cache for ordinary write-back memory. Device mappings and DMA buffers belong to Chapters 47–48.

## 42.11 Worked Case Study: Fewer Bytes, Then More Parallelism — Core

Suppose `mark_to_market` dominates a strategy replay. The target workload scans millions of live positions and needs only `quantity` and `mark`; descriptive metadata is used on rejects and reports.

### Step 1: Constrain and Baseline

- Metric: replay messages/s and per-batch p99, with identical output checksum.
- Input: production distribution of position counts and symbols.
- Deployment: one named host class and compiler flags.
- Observation: samples localize in the scan; time scales with position count; memory evidence rises with the large set; branch evidence is low.

The original record is 64 bytes because it contains IDs, timestamps, and a short label. The loop consumes 12 bytes. A 64-byte-line target therefore transfers roughly one line per position in the simplest estimate.

### Step 2: Change Layout

Split hot columns from cold metadata, preserving a generation-checked handle. The hot scan now streams an 8-byte mark and 4-byte quantity. The model predicts fewer lines and easier vectorization; it does not predict a particular speedup because cache reuse, prefetch, and arithmetic still matter.

### Step 3: Inspect and Remeasure

Record a table like this with actual values:

| Variant | Hot bytes/position | Compiler observation | Throughput | Batch p50 / p99 | LLC/TLB evidence | Decision |
|---|---:|---|---:|---|---|---|
| AoS baseline | `sizeof(Position)` | Scalar or gathered loads | measured | measured | measured | reference |
| Hot/cold SoA | 12 plus output | Named vector width/versioning | measured | measured | measured | keep/rollback |
| SoA + manual intrinsic | same | Explicit ISA and tail | measured | measured | measured | keep only if incremental |

The rows must come from the same harness and should retain distributions rather
than only best times. Run at least small, typical, and large live-set sizes. For
the small set, the AoS baseline may already reside in cache, so splitting fields
can add bookkeeping without avoiding misses. For the large set, reduced traffic
may dominate. Also run a mixed operation sequence—for example, many hot scans
interleaved with a few report lookups—because isolated scans conceal the join
cost of the cold columns.

Interpret the observations as a chain. If hot bytes fall but relevant cache
evidence and elapsed time do not, the supposedly cold data may already have been
resident, the scan may be compute-bound, or the hardware may transfer the same
number of lines. If misses fall and time still does not, bandwidth or miss
latency may have been overlapped already. If time improves without the expected
memory change, inspect code generation for a second cause such as easier
vectorization. The original hypothesis may still lead to a useful version, but
the ledger should record the mechanism the evidence actually supports.

If SoA improves the distribution but intrinsics add no incremental gain, keep SoA and delete the intrinsic version. The compiler may already saturate memory bandwidth. If only large batches improve while small-batch p99 regresses, dispatching by size is possible but adds a branch and two paths; often the simpler layout-only change is the better operational result.

### Step 4: Validate Costs

Test insert/erase, handle generation, cold report lookup, restart serialization, and memory overhead. Compare a full-record random-access benchmark because that is the predicted regression. Keep the old AoS implementation behind a build/runtime switch until production canary data agrees, then remove duplicate paths on a scheduled cleanup date.

This case combines two decisions in the right order: remove irrelevant bytes first, then ask whether instruction parallelism still matters.

## 42.12 Worked Case Study: The Obvious Branchless SIMD Rewrite Is Wrong — Core

A risk check rejects quantities over a limit. Historical traffic is valid almost all the time; rejects arrive in bursts during malformed-input incidents. A team replaces:

```cpp
if (quantity <= limit) {
    running_notional += price * quantity;
} else {
    record_reject(order_id, quantity);
}
```

with arithmetic masks and batches eight orders at a time. The steady-state throughput microbenchmark improves, but production-shaped p99.9 gets worse.

Reason through the mechanism:

1. The original common branch is highly predictable for normal traffic and skips the cold call completely.
2. `record_reject` has side effects and cannot be executed speculatively for both arms. The vector version must create a reject mask, test whether any lane rejects, extract lanes, and enter scalar repair.
3. Normal batches pay mask creation, tail/setup, and reduction even though no reject exists.
4. During reject bursts, lane extraction and mixed-path handling add variable work. Batching may also delay the first reject behind batch formation.
5. If `running_notional` is a strict ordered floating reduction, vector regrouping can change results; if integer multiplication can overflow, the scalar and lane-width semantics must be matched explicitly.

The better change is often **common-path isolation**, not branch elimination:

```cpp
if (quantity > limit) [[unlikely]] {
    record_reject(order_id, quantity);
    return;
}
running_notional += price * quantity;
```

`[[unlikely]]` is a C++20 hint that can influence layout; it does not guarantee prediction. PGO may provide better evidence. Inspect that the reject block is out of line, then compare valid traffic, alternating adversarial input, reject bursts, and end-to-end detection latency.

Rollback criterion: if p99.9, reject response, code size, or correctness worsens beyond the contract, revert even if bulk throughput rises. The mistake was optimizing branch count instead of the workload's control distribution and required side effects.

## 42.13 Decision Ledger, Measurement, and Rollback — Core

Every nontrivial optimization should leave a compact ledger:

| Field | Example |
|---|---|
| Hypothesis | Hot/cold split reduces bytes fetched by quantity scan |
| Expected evidence | Lower cache-line/LLC pressure; same branch behavior |
| Correctness gates | Identical checksum; generation-handle tests |
| Workloads | Normal, burst, cold start, maximum set, random full-record lookup |
| Build/host | Commit, compiler, flags, microcode/kernel, host class |
| Results | Raw histogram links and counter output |
| Costs | +18 MiB metadata, more complex erase, no ISA restriction |
| Rollback | Feature/build switch and owner/date for removal |

### Inspect What Changed

Use compiler optimization remarks for vectorization and missed transforms. Use disassembly to answer bounded questions:

- Did the loop retain a data-dependent branch?
- Are loads contiguous, gathered, or scalar?
- Is there a runtime alias/alignment check and scalar fallback?
- Which vector width and tail strategy were emitted?
- Did unrolling introduce spills or large code?
- Is `vzeroupper` present around a relevant x86 boundary?

Chapter 40 owns flags and optimization passes; Chapter 41 owns assembly reading. Generated code confirms implementation, not achieved performance.

### Remeasure the Whole Contract

At minimum report:

- throughput and the latency percentiles named in the contract;
- input sizes/distributions and number of repetitions;
- instructions/cycles plus only the counters relevant to the hypothesis;
- CPU time, memory footprint, and power/frequency telemetry when vector width changes;
- cold and warm behavior if production sees both;
- correctness results and any numerical deltas.

Use a deliberately small variant matrix:

| Axis | Representative cases | Question answered |
|---|---|---|
| Input size | below setup threshold, typical, upper tail | Where do setup, cache, or bandwidth regimes change? |
| Data shape | predictable/skewed, production mix, adversarial | Is control or lookup behavior distribution-sensitive? |
| Address | normal allocator, relevant offsets/alignment | Does the fast path depend on placement? |
| State | cold start and steady state | Is initialization or residency hidden? |
| Host | each supported CPU class | Is the ISA/microarchitecture claim portable enough to ship? |

Do not multiply every axis blindly. Select cases that could falsify the mechanism
or exercise a stated precondition. For each retained fast path, test the dispatch
boundary on both sides and compare its output with the scalar reference. A change
that wins only at one convenient length, alignment, or branch pattern is a
specialized kernel; either constrain its API accordingly or do not deploy it as a
general replacement.

Rollback is not failure. It is the expected outcome of a falsified hypothesis. Avoid letting sunk implementation cost turn a neutral result into permanent complexity.

## 42.14 Common Traps — Core

- Rewriting AoS to SoA before showing that transferred bytes or locality govern the metric.
- Measuring only a field-wise scan and ignoring the full-record operation the new layout makes worse.
- Exposing parallel arrays without a collection invariant or generation-safe handle.
- Applying `std::assume_aligned` to an unchecked pointer; the optimizer may rely on the false promise.
- Tiling a single streaming pass that has no reuse.
- Adding accumulators after the compiler already unrolled/vectorized, increasing spills without shortening the chain.
- Reassociating floating-point reductions without an explicit numerical contract.
- Prefetching sequential data or choosing a distance from folklore rather than miss/work evidence.
- Replacing a predictable branch with unconditional work or a longer data dependency.
- Assuming a ternary expression guarantees `cmov`, or that `cmov` is always faster.
- Using a large lookup table in a hot isolated microbenchmark that hides its cache footprint in the real process.
- Promising non-aliasing through a pragma or extension when callers can overlap.
- Comparing an intrinsic kernel only on large aligned multiples and shipping it to small, misaligned tails.
- Calling an experimental SIMD namespace “C++23 `std::simd`.”
- Executing AVX2/AVX-512 without build-time fleet guarantees or runtime capability dispatch.
- Carrying AVX/SSE transition or frequency advice from one CPU generation to another.
- Publishing data after non-temporal stores without the ISA-required ordering fence.
- Keeping an optimization whose mean improves while the required tail or failure-path latency regresses.

## 42.15 Recall and Practice — Core

### Recall Card

- Start with workload, correctness, metric, deployment, resource budget, and a reproducible baseline.
- A profile locates cost; a bytes/branches/dependencies/vector model explains it.
- Choose AoS, SoA, AoSoA, or hot/cold split from the operations that dominate the target workload.
- Alignment assumptions are correctness preconditions. Placement alignment and cache-line goals are target observations.
- Shorten critical paths with independent work, but do not add accumulators past register/code-size limits.
- Branchless code trades branch recovery for unconditional work and data dependencies.
- A LUT trades computation for memory footprint and cache/TLB interference.
- Prefer vectorizable source; use intrinsics for measured target-specific kernels with dispatch and scalar tails.
- C++23 has no standard `std::simd`.
- Treat partial-register behavior, AVX/SSE transitions, vector frequency, and non-temporal operations as target-specific.
- Inspect generated code, remeasure the full distribution, validate adverse workloads, and keep rollback inexpensive.

### Reasoning Questions

1. A SoA rewrite halves scan time but doubles random lookup latency. Which production distribution decides whether it ships, and what hybrid would you test?
2. A loop has high cache misses and a long pointer chain. Why might software prefetch fail, and which representation change could expose parallel requests?
3. Under what conditions does splitting one reduction into four accumulators improve throughput, and when can it change correctness?
4. A branch is frequently executed but rarely mispredicted. What evidence would justify replacing it with arithmetic masking?
5. Why can a conditional move lose when its condition depends on a cache miss?
6. A 64 KiB lookup table wins its isolated benchmark but slows the service. Give two mechanisms and a corrected experiment.
7. The compiler reports a vectorized loop, yet wall time is unchanged. Name four possible limiting mechanisms.
8. What must a runtime-dispatched intrinsic path establish before executing, and which cases must its scalar fallback cover?
9. When can non-temporal stores help another thread more than the copying thread, and what publication rule must remain correct?
10. A wide-vector change reduces instructions but worsens tail latency. How would you distinguish frequency behavior from setup/tail overhead and scheduler noise?

### Code-Reading Puzzle

```cpp
#include <cstddef>
#include <memory>

float dot(const float* a, const float* b, std::size_t n) {
    a = std::assume_aligned<32>(a);
    b = std::assume_aligned<32>(b);
    float sum = 0.0f;
    for (std::size_t i = 0; i < n; ++i) sum += a[i] * b[i];
    return sum;
}
```

A caller sometimes passes offsets `base + 1`. The optimized build is faster in tests but occasionally crashes in production; a “fast-math” build also disagrees with the reference result. Identify the independent alignment and floating-point contracts, explain why the source contains no runtime alignment check, and design a checked dispatch plus numerical test.

### Applied Exercise

Choose one real hot loop. Write its optimization contract and collect a baseline distribution. Estimate bytes, distinct lines, branches, and longest dependency chain per item. Implement exactly two alternatives from different categories—for example, hot/cold layout and accumulator splitting. Inspect compiler remarks/assembly, test correctness and an adverse input, and report raw distributions with a keep/rollback decision. Do not combine the alternatives until each mechanism has been tested alone.

### Prerequisites for Chapter 43

Chapter 43 assumes you can state a falsifiable cost model, separate C++ guarantees from compiler/ISA/microarchitecture observations, and name the distribution and counters that would validate it. It teaches benchmark construction, tail statistics, profiling tools, PMU limitations, and measurement uncertainty in depth.
