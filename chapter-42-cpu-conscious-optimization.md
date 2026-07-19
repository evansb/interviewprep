# Chapter 42 — CPU-Conscious Optimization

*Interview-focused revision notes. The theme: the compiler optimizes your source; only you can optimize your data. This chapter is about restructuring programs so the machine's real bottlenecks — memory bandwidth, branch mispredicts, dependency latency, and issue width — stop being the limit.*

---

## 42.1 Data-Oriented Design

**Data-oriented design (DOD)** is the discipline of choosing data layout first, from the access pattern of the hot loop, and letting the code shape follow. Its opposite is object-oriented design, which chooses layout from a conceptual model of "things" and lets access patterns fall where they may.

The justification is arithmetic. A modern core retires up to 4–6 µops per cycle at ~3 GHz, so it can consume roughly 20 bytes of *useful* data per nanosecond in an ideal loop. A DRAM miss costs ~80–100 ns (Ch. 30 §30.1) and brings back exactly one 64-byte line. If you use 8 of those 64 bytes, your effective bandwidth is one-eighth of the machine's. **The unit of memory cost is the cache line, not the field**, and every DOD technique is a way of raising the fraction of each fetched line you actually consume — call it *line utilization*.

```cpp
// Model-driven layout: an Order "is a thing", so it owns everything about itself
struct Order {                       // 96 bytes = 1.5 cache lines
    uint64_t id;                     // hot: used every tick
    int64_t  price;                  // hot
    uint32_t qty;                    // hot
    uint32_t venue_id;               // cold
    char     symbol[16];             // cold: only on log/reject
    Timestamp created, last_modified;// cold
    std::string tag;                 // cold, and a pointer chase
    OrderState state;                // hot
};
std::vector<Order> book;             // scan for best bid touches 1.5 lines per order
```

Scanning 1000 orders for the best bid touches ~1500 cache lines to read 20 useful bytes each. Split hot from cold and the same scan touches ~310 lines:

```cpp
struct OrderHot  { int64_t price; uint32_t qty; uint32_t idx; };  // 16B, 4 per line
struct OrderCold { uint64_t id; char symbol[16]; Timestamp t0, t1; std::string tag; };
std::vector<OrderHot>  hot;    // scanned
std::vector<OrderCold> cold;   // indexed on the rare path
```

### The principles that generalize

1. **Separate hot from cold fields**, not "objects from objects." The split is by *access frequency in the hot loop*, and it is the highest-yield transformation in most codebases.
2. **Prefer indices to pointers.** A `uint32_t` index is half the size of a pointer, survives reallocation, is trivially relocatable and shareable across processes (Ch. 3 §3.12), and can be range-checked. Pointer-rich structures (linked lists, trees of nodes, `shared_ptr` graphs) serialize on dependent loads: each miss must complete before the next address is even known, so memory-level parallelism (Ch. 29 §29.5) collapses to one outstanding miss.
3. **Batch homogeneous work.** Process all orders of one type together rather than dispatching per-object; this removes indirect branches (Ch. 27 §27.9), lets the same code stay in the µop cache, and enables vectorization.
4. **Prefer explicit arrays to allocators.** Contiguity gives the hardware prefetcher (Ch. 28 §28.12) a stride to learn; a heap-scattered object graph gives it nothing.
5. **Design for the common case; make the rare case correct, not fast.** A `std::vector<uint32_t>` free list plus a dense array beats a `map<Id, Object*>` even when the dense array is 30% empty.

### The counter-argument, and the honest answer

DOD costs abstraction. `hot[i]` and `cold[i]` must be kept in sync; a bug there is a silent data corruption rather than a compile error. The mitigation is to make the split an implementation detail behind an accessor type (a "handle" or "view" struct) rather than exposing parallel arrays to callers, and to assert `hot.size() == cold.size()` at every mutation point in debug builds. The interview answer: **DOD is not "avoid classes"; it is "the class boundary should wrap the collection, not the element."**

---

## 42.2 Array-of-Structures versus Structure-of-Arrays

**AoS** stores one contiguous record per entity: `std::vector<Particle>`. **SoA** stores one contiguous array per field: `struct { vector<float> x, y, z; }`. **AoSoA** (also "tiled" or "hybrid") stores small fixed-width blocks of SoA inside an array: `struct Block { float x[8], y[8], z[8]; }; vector<Block>`.

```
AoS  (vector<Particle>, Particle = {x,y,z,m}):
  [x0 y0 z0 m0][x1 y1 z1 m1][x2 y2 z2 m2]...
  reading all x: stride 16B, uses 4 of every 16 bytes → 25% line utilization
  a SIMD load of 4 x-values requires a gather or 4 loads + shuffles

SoA:
  x: [x0 x1 x2 x3 x4 ...]   y: [y0 y1 ...]   z: [...]
  reading all x: stride 4B, 100% line utilization, one vmovups loads 8 x's

AoSoA (block of 8):
  [x0..x7 | y0..y7 | z0..z7][x8..x15 | ...]
  full-record access touches 3 lines instead of 24; SIMD-friendly within a block
```

### The decision rule

| Access pattern | Winner | Why |
|---|---|---|
| Scan one/few fields across all entities | **SoA** | Line utilization and contiguous SIMD loads |
| Touch all fields of one entity (random access) | **AoS** | One line fetch gets the whole record; SoA needs N misses across N arrays |
| Scan all fields of all entities | Roughly a tie | Both stream; SoA wins slightly on vectorizability, AoS on TLB entries |
| Mixed: hot scan + occasional full-record access | **AoSoA** or hot/cold split | Bounded working set per block |
| Insert/erase in the middle | **AoS** | SoA must shift N arrays; N times the memmove and N times the bookkeeping |

The failure case people forget: **SoA multiplies your streaming stream count.** Hardware prefetchers track a limited number of streams (typically 16–32 per core for the L2 streamer). A structure with 20 fields in SoA scanned all at once needs 20 concurrent forward streams plus 20 TLB entries; you can exhaust prefetcher tracking slots and DTLB entries simultaneously, and the "obviously faster" SoA version regresses. AoSoA with a block size of 8–64 elements is the standard fix and is what most SIMD-heavy production code actually uses.

### In C++

There is no language support; you build it. Common approaches:

```cpp
// 1. Manual — clearest, and what most trading systems do
struct Book {
    std::vector<int64_t>  price;
    std::vector<uint32_t> qty;
    std::vector<uint32_t> order_count;
    size_t size() const { return price.size(); }
};

// 2. AoSoA with explicit blocks, alignment for SIMD (§42.9)
struct alignas(64) Block { int64_t price[8]; uint32_t qty[8]; };

// 3. Tuple-of-vectors with a generated proxy reference (soa_ptr, Kokkos, EASTL)
//    Costs: operator[] returns a proxy, so `auto& e = v[i]` breaks, and
//    generic algorithms that require a true reference type stop compiling.
```

Approach 3 is where most "zero-cost SoA library" attempts die: a proxy reference is not a reference, `std::sort` on a proxy-iterator range requires a correct `swap` and `value_type`, and debug builds become unreadable. C++26's static reflection (Ch. 19 §19.14) is the first realistic route to generated SoA without the proxy tax.

**Measurement note:** the AoS→SoA win only appears if you were memory-bound. If the loop was already bound on a dependency chain (§42.10) or on branch mispredicts (§42.3), SoA changes nothing and you will have rewritten your data model for zero gain. Confirm with `perf stat` cache-miss and `CYCLE_ACTIVITY.STALLS_L3_MISS` counters *first* (Ch. 43 §43.14).

---

## 42.3 Branchless Programming

A **branch** is a control transfer whose target the front-end must predict. A correctly predicted branch is nearly free (~0.5–1 cycle of front-end bandwidth); a **mispredict costs the full pipeline refill, 15–20 cycles on Skylake-class cores, ~12–18 on recent Zen** (Ch. 27 §27.11). **Branchless programming** replaces control dependencies with data dependencies so no prediction is required.

The whole tradeoff is a single inequality:

```
branchy cost   = p_taken · cost_A + (1-p_taken) · cost_B + p_mispredict · penalty
branchless cost= cost_A + cost_B  (both paths executed)  + dependency-latency effects
```

Branchless wins when the branch is **unpredictable** (p_mispredict near 0.5, i.e. data-dependent on random-ish input) and both arms are cheap. Branchless *loses* when the branch is well-predicted (>95%), because you unconditionally pay for work the predictor was letting you skip — and it loses badly if the branchless form lengthens the critical dependency chain (§42.10).

### The canonical idioms

```cpp
// max without a branch — compilers emit cmov/maxss anyway
int m = a > b ? a : b;

// conditional accumulate: sum of elements passing a predicate
sum += (x > threshold) * x;                    // mask-multiply
sum += x & -(int64_t)(x > threshold);          // mask-and, no multiplier port pressure

// conditional increment
count += (x == target);                        // setcc + add

// branchless select without cmov (works in SIMD too)
int64_t mask = -(int64_t)cond;                 // 0 or all-ones
int64_t r = (a & mask) | (b & ~mask);

// clamp
v = v < lo ? lo : (v > hi ? hi : v);           // two cmovs / two minmax instructions

// branchless binary search: no data-dependent branch, but a data-dependent LOAD
size_t base = 0, n = len;
while (n > 1) { size_t half = n / 2; base += (a[base+half-1] < key) * half; n -= half; }
```

The branchless binary search is the honest illustration of the limits: it removes the mispredict, but the load address now depends on the previous comparison, so you have a serial chain of L1/L2 loads (4–14 cycles each) with no speculation to hide them. A branchy binary search on a small array can be *faster* because the predictor speculates the next load's address and the memory system runs ahead. Eytzinger layout (breadth-first array) plus software prefetch of both children is the technique that actually wins here, because it restores memory-level parallelism.

### Branch elimination at a higher level

Removing branches at the instruction level is the least important form. The higher-yield versions:

- **Hoist the branch out of the loop.** `for(i) if(flag) A(); else B();` → `if(flag) for(i) A(); else for(i) B();`. This is *loop unswitching*; GCC/Clang do it at `-O3` when `flag` is provably invariant, and `if constexpr` (Ch. 17 §17.19) does it at compile time.
- **Sort or partition the input** so branches become predictable. The famous "sorted array is 6× faster" result is entirely branch prediction. If you can batch and partition by branch outcome, do that instead of going branchless.
- **Replace dispatch with dense enumeration.** A virtual call on a heterogeneous vector is an indirect branch with a poorly-predicted target; bucketing objects by concrete type and running homogeneous loops removes it entirely (Ch. 55 §55.9).
- **Use `[[likely]]`/`[[unlikely]]` and PGO** (Ch. 40 §40.6, §40.9) to move cold arms out of line rather than eliminating them; this is a front-end/I-cache win, not a prediction win.

**Diagnostic signature:** high `branch-misses` in `perf stat` (>1% of `branches`, or >2–3 mispredicts per thousand instructions) with `BR_MISP_RETIRED.ALL_BRANCHES` localized by `perf record -e branch-misses` to a specific line. If the misprediction rate is under ~1%, going branchless there is almost certainly a pessimization.

---

## 42.4 Conditional Moves

**`cmov`** (x86) / **`csel`, `csinc`** (AArch64) compute both results and select one based on flags, with no control transfer. `cmovcc r64, r/m64` has 1-cycle latency and executes on a general ALU port; on pre-Broadwell Intel it decoded to 2 µops and had 2-cycle latency, which is why older tuning advice is more hostile to it.

The crucial and frequently-missed property: **`cmov` converts a control dependency into a data dependency.** The result is not available until *all three* inputs (both values and the condition) are ready. A predicted branch, by contrast, lets the CPU speculate past the condition entirely — the dependent work begins before the condition is even computed.

```
branch:   cond ──(predicted)──> downstream work starts immediately, verified later
cmov:     cond ──────────────>┐
          a    ──────────────>├─ cmov ─> downstream work waits for the slowest input
          b    ──────────────>┘
```

Consequences:

| Situation | Prefer |
|---|---|
| Condition unpredictable, both values cheap and already available | **`cmov`** |
| Condition well predicted (>90%) | **branch** — speculation is free, cmov adds latency |
| One arm is expensive or has side effects (a store, a call, a possibly-faulting load) | **branch** — cmov must evaluate both |
| `cmov` would sit on the loop-carried critical path | **branch** — you just added a cycle per iteration |
| Condition depends on a long-latency load | **branch** — cmov serializes on the load; branch speculates past it |

The last row is the one that separates strong candidates. If `cond` comes from an L3 miss, `cmov` stalls for 40+ cycles; a branch predicts, runs ahead, and only pays if wrong.

### Getting the codegen you want

There is no portable `__builtin_cmov`. What works:

```cpp
int sel = c ? a : b;                    // usually cmov, but compilers may if-convert back to a branch
// force it with inline asm when it genuinely matters:
asm("cmp %[c], $0; cmovne %[a], %[r]" : ...);   // fragile, last resort
// or use arithmetic masking (§42.3), which no pass will turn into a branch
int64_t m = -(int64_t)c; int sel = (a & m) | (b & ~m);
```

GCC's `-fno-if-conversion` / `-fno-if-conversion2` disable the branch→cmov transform; Clang has `-mllvm -enable-if-conversion=false`. PGO actively *un*-converts cmovs when profile data shows a branch is predictable — one of the more valuable things PGO does (Ch. 40 §40.9). Inspect the actual output with `-S -masm=intel` or Compiler Explorer (Ch. 44 §44.1); assuming a ternary became a `cmov` without looking is a common error.

**Security aside worth one sentence:** `cmov` is the standard constant-time-selection primitive, because it has no data-dependent control flow. But it is not architecturally guaranteed to be constant-time, and speculation around the *inputs* can still leak; real constant-time code uses masking and `-mno-cmov`-independent formulations.

---

## 42.5 Lookup-Table Optimization

A **lookup table (LUT)** trades computation for memory: precompute results, index at runtime. The classic wins are tiny tables that stay resident in L1: `popcount` nibble tables (pre-`POPCNT`), CRC byte tables (Ch. 51 §51.13), decimal-digit pair tables for integer formatting, and ASCII classification tables.

The modern calculus has shifted hard against large tables. An L1 hit is 4–5 cycles; an L2 hit ~14; an L3 hit ~40–50; a DRAM access ~80–100 ns ≈ 250–300 cycles. Meanwhile a multiply is 3 cycles, a divide by a constant is a multiply-and-shift, and `POPCNT`/`LZCNT`/`TZCNT`/`PDEP` are 1–3 cycles. **A table that misses L1 is usually slower than recomputing.** Additionally, a table consumes cache and TLB capacity that the rest of the program needed — a cost invisible in a microbenchmark that measures the table alone (Ch. 43 §43.26).

### Sizing rules

| Table size | Verdict |
|---|---|
| ≤ 4 KB, hot | Almost always a win; stays in L1D (32–48 KB) |
| ≤ 32 KB | Usually fine alone; competes with the rest of the working set |
| 256 KB – 1 MB | L2-resident at best; win only if the computation it replaces is >20 cycles |
| > L2 | Almost always a loss vs. computation; also burns TLB entries — consider huge pages (Ch. 32 §32.9) if unavoidable |

### The idioms that still pay

```cpp
// 1. Two-digit decimal conversion — the standard fast itoa core
static constexpr char kDigits[201] =
    "00010203040506070809101112131415161718192021...9899";
// writes two chars per iteration, halving the loop trip count and divisions

// 2. Perfect-hash dispatch on message type: dense uint8 → handler index
static constexpr uint8_t kMsgSlot[256] = {/* ... */};
handlers[kMsgSlot[msg_type]](payload);      // one L1 load, one indirect call

// 3. Table-driven state machine (Ch. 22 §22.18)
state = kTransition[state][input_class];    // no branches at all

// 4. SIMD in-register LUT: PSHUFB does 16 parallel 4-bit lookups with zero memory
//    — base64, hex encoding, UTF-8 validation, nibble popcount all use this
__m128i lo = _mm_shuffle_epi8(table_vec, _mm_and_si128(x, mask_0f));
```

Idiom 4 is the one to name in an interview: **`PSHUFB`/`VPSHUFB` is a 16-entry byte LUT that lives in a register**, so it has no cache cost at all. `VPERMB` (AVX-512VBMI) extends this to 64 entries. Nearly every modern high-performance parser (simdjson's structural-character classification, base64 codecs, UTF-8 validators) is built on in-register tables rather than memory tables, precisely to avoid the cache footprint.

### Failure modes

- **Cold-start cost.** The first pass over a 1 MB table takes 16k misses. Benchmarks that loop over the table 1000 times amortize this away and report a fantasy number. Real workloads with poor temporal locality pay it every time.
- **Table-driven branches are still indirect branches.** A jump table for a switch is an indirect jump; if the case sequence is unpredictable, the BTB (Ch. 27 §27.10) mispredicts and you pay 15–20 cycles anyway. Table-driven state machines that look branchless may still be branch-bound at the dispatch.
- **`constexpr` table construction.** Generating tables at compile time (`constexpr` loops, or `consteval` in C++20) puts them in `.rodata`, avoids a static initializer (Ch. 5 §5.10), and lets the linker place them; a runtime-initialized table also costs startup latency and can defeat `--gc-sections`.
- **Read-only sharing.** A `static const` table is shared across processes via the page cache; a mutable one is copy-on-write per process and duplicates memory.

---

## 42.6 SIMD Intrinsics

**SIMD** (single instruction, multiple data) executes the same operation across a vector register: 128-bit SSE/NEON (4×float, 16×int8), 256-bit AVX/AVX2 (8×float), 512-bit AVX-512 (16×float). The theoretical ceiling is the width times the number of vector ports (2 FMA ports on most Intel server parts), so a 512-bit FMA loop can retire 32 single-precision FLOPs per cycle.

Four ways to get vector code, in increasing order of control and decreasing order of portability:

| Route | Control | Portability | When |
|---|---|---|---|
| Autovectorization (Ch. 40 §40.16) | None | Total | Simple countable loops with no aliasing, no early exit |
| `#pragma omp simd` / `#pragma clang loop vectorize` | Hints | Good | Forcing a loop the cost model rejected |
| `std::simd` (C++26, `<simd>`; previously Parallelism TS `std::experimental::simd`) | High | Good | New code; ABI-parameterized width |
| Intrinsics (`<immintrin.h>`, `<arm_neon.h>`) | Total | Per-ISA | Shuffles, saturation, `pshufb` tricks, anything the compiler cannot express |

Autovectorization fails, silently, for well-understood reasons: possible aliasing between input and output pointers (fix with `__restrict`, Ch. 40 §40.7), a loop trip count not known before entry, control flow with side effects, reductions over floating point (reassociation changes results, so it requires `-ffast-math` or `#pragma omp simd reduction`), function calls that were not inlined, and non-unit stride. `-fopt-info-vec-missed` (GCC) or `-Rpass-missed=loop-vectorize` (Clang) tells you which (Ch. 40 §40.21).

```cpp
// Sum with intrinsics: the shape every SIMD kernel has
float sum(const float* __restrict p, size_t n) {
    __m256 acc0 = _mm256_setzero_ps(), acc1 = _mm256_setzero_ps();  // 2 accumulators: §42.10
    size_t i = 0;
    for (; i + 16 <= n; i += 16) {
        acc0 = _mm256_add_ps(acc0, _mm256_loadu_ps(p + i));
        acc1 = _mm256_add_ps(acc1, _mm256_loadu_ps(p + i + 8));
    }
    __m256 acc = _mm256_add_ps(acc0, acc1);
    // horizontal reduce: 3 shuffles + 3 adds, ~10 cycles — do it ONCE, outside the loop
    __m128 v = _mm_add_ps(_mm256_castps256_ps128(acc), _mm256_extractf128_ps(acc, 1));
    v = _mm_add_ps(v, _mm_movehl_ps(v, v));
    v = _mm_add_ss(v, _mm_shuffle_ps(v, v, 1));
    float r = _mm_cvtss_f32(v);
    for (; i < n; ++i) r += p[i];        // scalar tail — or a masked load on AVX-512
    return r;
}
```

Non-obvious points that mark experience:

- **Horizontal operations are expensive.** `hadd`, cross-lane shuffles, and reductions cost 3–7 cycles each and break the vertical-parallelism model. Keep accumulators vertical; reduce once at the end.
- **AVX2's 256-bit lanes are two independent 128-bit halves** for most shuffle instructions (`vpshufb`, `vpalignr`, `vunpck*` all operate *within* lanes). Cross-lane movement needs `vperm2i128`/`vpermd`, which are slower. This lane-crossing rule causes more SIMD bugs than anything else.
- **Tail handling** costs real code. AVX-512 masked loads (`_mm256_maskz_loadu_ps` with a `__mmask8`) eliminate the scalar tail entirely and are one of AVX-512's genuinely best features, along with `vpcompress`/`vpexpand` for stream compaction and `vpconflictd`.
- **Unaligned loads (`loadu`) are free on modern cores** *if* they do not cross a cache line; a line-crossing load costs an extra cycle, and a 4 KB-page-crossing load costs much more (Ch. 29 §29.12). Aligning your data (§42.9) still matters, but `movaps`-vs-`movups` no longer does.
- **Runtime dispatch:** `__builtin_cpu_supports("avx2")`, GCC/Clang `__attribute__((target("avx2")))` and `target_clones`, or manual function pointers set once at startup. Never test CPU features inside the hot loop.
- **Gather instructions (`vgatherdps`) are usually slower than scalar loads** on Intel (and were microcode-disabled on some parts after Downfall); they issue one element per cycle internally. Use them only when the alternative is worse.

---

## 42.7 Loop Tiling and Blocking

**Tiling** (blocking) restructures a nested loop so that the working set of the inner loops fits in a chosen cache level, converting capacity misses into hits. It is the single most effective transformation for dense multi-dimensional kernels, and its logic is the concrete instance of cache complexity (Ch. 23 §23.5).

Naive matrix multiply, `C = A·B`, with N=1024 doubles (8 MB per matrix):

```
for i in N: for j in N: for k in N: C[i][j] += A[i][k] * B[k][j];
```

`B[k][j]` walks a column — stride 8 KB — so every access is a new cache line *and* frequently a new page. Each of the N² inner loops re-reads all of B. Total traffic ≈ N³ lines from DRAM.

```
for ii in steps of T:  for jj in steps of T:  for kk in steps of T:
  for i in [ii,ii+T): for j in [jj,jj+T): for k in [kk,kk+T):
      C[i][j] += A[i][k] * B[k][j];
```

Now the three T×T sub-blocks are reused entirely from cache. Traffic drops by a factor of ~T. Choose T so that **3·T²·sizeof(elem) ≲ cache size**, with headroom: for a 32 KB L1D and doubles, 3·T²·8 ≤ 32768 gives T ≈ 36, so T = 32 (a power of two, and also a multiple of the SIMD width). Real BLAS implementations tile at *every* level — L1 micro-kernel, L2 block, L3 panel — and additionally **pack** the blocks into contiguous scratch buffers so the inner kernel sees unit stride and no TLB pressure.

### Related loop transformations

| Transformation | Shape | Purpose |
|---|---|---|
| **Interchange** | swap loop order | make the innermost loop unit-stride (`k`-`i`-`j` order fixes matmul's B access without tiling) |
| **Tiling/blocking** | strip-mine + interchange | fit the working set in cache |
| **Fusion** | merge two loops over the same range | one pass instead of two; reuse data in registers/L1 |
| **Fission (distribution)** | split one loop into two | reduce register pressure or stream count; enable vectorizing one half |
| **Unrolling** (Ch. 40 §40.15) | replicate the body | amortize loop overhead, expose ILP, enable multiple accumulators |
| **Strip-mining** | split a loop into outer/inner | prerequisite for tiling and for vectorization |
| **Loop-invariant code motion** | hoist | compilers do this reliably unless aliasing blocks it |

Fusion and fission pull in opposite directions and the choice is empirical: fusion helps when the two loops share data (temporal locality); fission helps when the fused body exceeds the register file or exceeds the prefetcher's stream tracking (§42.2).

### Practical notes

- **Compilers rarely tile automatically.** GCC has `-floop-block` via Graphite (needs `-fgraphite-identity`, historically fragile); Clang/Polly can. In practice you tile by hand, or you use a library (BLAS, Eigen) whose author already did.
- **Tile sizes must be tuned per machine**, and the optimum is not the largest fitting size — leave room for the other arrays, the stack, and hyperthread siblings sharing the L1/L2 (Ch. 27 §27.17). Autotuning by sweeping T is normal.
- **Cache-oblivious recursion** (divide the problem in half until it fits) gets most of the benefit with no tuning constant, at the cost of recursion overhead — see Ch. 23 §23.6.
- **Diagnostic signature:** high `L1-dcache-load-misses` or `LLC-load-misses` with a low miss *rate per useful byte*, and a runtime that scales worse than the operation count. `cachegrind` (Ch. 43 §43.20) gives exact per-level miss counts to validate a tile size without hardware-counter noise.

---

## 42.8 Software Pipelining

**Software pipelining** overlaps iterations of a loop so that the long-latency operations of iteration *i+k* are in flight while iteration *i* finishes. It is the compiler/programmer analogue of hardware pipelining, and it exists because out-of-order execution's reordering window is finite: the ROB (Ch. 27 §27.5) is ~350–512 entries, so if one iteration is 40 µops, the machine can only see ~10 iterations ahead — often not enough to hide a 250-cycle DRAM miss.

```
Unpipelined:   [load A][wait......][compute A][store A][load B][wait......][compute B]...
Pipelined:     [load A][load B][load C]
                       [compute A][compute B][compute C]
                                  [store A][store B][store C]
                prologue          steady state             epilogue
```

The three parts — **prologue** (fill), **steady state** (kernel), **epilogue** (drain) — are what makes hand-pipelined code look unfamiliar: the loop body works on data loaded two or three iterations ago.

```cpp
// Pipelined hash-table probe: issue the next load before using the current result
uint64_t h_next = hash(keys[0]);
__builtin_prefetch(&table[h_next & mask]);
for (size_t i = 0; i < n; ++i) {
    uint64_t h = h_next;
    if (i + 1 < n) {                       // prologue folded in
        h_next = hash(keys[i + 1]);
        __builtin_prefetch(&table[h_next & mask]);   // next miss starts now
    }
    process(table[h & mask]);              // this miss already resolved
}
```

This restores **memory-level parallelism**: instead of one outstanding miss at a time (fully serialized, n × 80 ns), you keep several line-fill buffers busy (10–16 per core on Intel; Ch. 29 §29.5), and throughput approaches n × (80 ns / MLP). This "batched/pipelined probe" is the standard trick behind fast hash joins and is a strong thing to be able to write on a whiteboard.

### Software prefetch: when it helps and when it hurts

`__builtin_prefetch(addr, rw, locality)` / `_mm_prefetch(p, _MM_HINT_T0|T1|T2|NTA)` issues a non-faulting, non-blocking load into cache. **Prefetch distance** must be tuned: prefetch `D` iterations ahead where `D ≈ memory_latency / cycles_per_iteration`. For a 200-cycle latency and a 10-cycle body, D ≈ 20 iterations.

| Software prefetch helps | Software prefetch hurts |
|---|---|
| Irregular but *computable* addresses: hash probes, index-indirection `a[idx[i]]`, pointer chases where the next pointer is known early | Sequential/strided access — the L2 streamer already handles it; you add µops and possibly evict |
| Short loops where the hardware prefetcher never gets to train (it needs 2–3 accesses to lock on) | Distance too short: the line has not arrived, no benefit, wasted issue slot |
| Crossing a 4 KB page boundary — hardware prefetchers **do not prefetch across pages** (they cannot translate), so a prefetch at the page edge is uniquely valuable | Distance too long: the line is evicted before use, and you have polluted the cache |
| Streaming stores where you want `NTA` locality to avoid polluting L3 | Bandwidth-saturated loops — extra requests just queue |

The hardware/software boundary is the key interview point: **hardware prefetchers handle constant strides within a page; they cannot follow pointers and cannot cross page boundaries.** Everything software prefetch is good at falls in that gap. Also note that a prefetch of an address that would fault is silently dropped — safe, but it means a prefetch through a garbage pointer is a *silent* no-op, not a bug you will notice.

**Failure signature:** you added prefetches and IPC went down while cache misses stayed flat. That means the prefetches are arriving too late (increase distance) or the loop was never memory-bound.

---

## 42.9 Alignment for Cache Lines and SIMD

Three distinct alignment concerns, routinely conflated:

| Concern | Granularity | Failure mode |
|---|---|---|
| **Scalar/atomic correctness** | `alignof(T)` | Split lock, torn atomic, UB (Ch. 3 §3.3) |
| **SIMD** | 16/32/64 B | `movaps`-family faults; `loadu` costs a line-cross penalty |
| **Cache line / false sharing** | 64 B (128 B effective on some parts) | MESI ping-pong, ~100 ns per access (Ch. 26 §26.15) |
| **Page / huge page** | 4 KB / 2 MB | TLB pressure, split-page loads, prefetcher stops at the boundary |

### The concrete numbers

- A load that stays within one 64-byte line: full speed, one cycle of AGU throughput.
- A load that **crosses a cache line**: the load unit splits it into two accesses; ~1 extra cycle of latency and it consumes an extra line-fill/load-buffer slot. `MEM_INST_RETIRED.SPLIT_LOADS` counts these.
- A load that **crosses a 4 KB page**: historically ~100+ cycles on pre-Skylake; on Skylake and later the penalty dropped to roughly that of a line split, but the store side (`SPLIT_STORES`) remains costly and blocks store-to-load forwarding (Ch. 29 §29.8).
- A **misaligned atomic RMW crossing a line** triggers a **split lock**: the core asserts a bus lock and stalls *every core on the socket* for microseconds. Linux can detect and SIGBUS on it via `split_lock_detect=fatal`. This is the single worst alignment failure in a low-latency system.

### Getting alignment

```cpp
alignas(64) std::array<float, 1024> buf;                 // static/automatic
auto* p = new (std::align_val_t{64}) float[1024];        // C++17 aligned new
void* q = std::aligned_alloc(64, 4096);                  // size must be a multiple of align
std::pmr::monotonic_buffer_resource pool{buf.data(), sizeof buf};   // Ch. 8 §8.6

// Tell the optimizer what it cannot prove:
float* a = std::assume_aligned<64>(raw);                 // C++20; enables aligned SIMD codegen
```

`std::assume_aligned` matters more than people expect: without it, an autovectorizer emits a *runtime alignment check plus a peeling loop* to reach an aligned boundary, which for short loops is most of the runtime. With it, the peeling loop disappears.

### Padding and layout for hot structures

```cpp
struct alignas(64) RingSlot {          // one slot per line: no false sharing between producers
    std::atomic<uint64_t> seq;
    char payload[56];
};
static_assert(sizeof(RingSlot) == 64);
```

Two further details worth knowing:

- **`std::hardware_destructive_interference_size`** is the standard answer for the padding constant, but it is a compile-time constant baked into your ABI, and GCC warns about using it in headers for exactly that reason. Many shops hardcode 64, or 128 on Intel parts with the adjacent-cache-line prefetcher and on Apple Silicon (128-byte lines).
- **Alignment interacts with cache associativity.** Allocating many buffers all aligned to 4 KB makes them all map to the same L1 sets — **conflict misses** and cache thrashing (Ch. 28 §28.9). This is the classic "power-of-two matrix stride is catastrophically slow" result; the fix is to pad the leading dimension by one line (`stride = N + 8` for doubles) to spread the sets. Over-aligning everything is not free.

---

## 42.10 Dependency Chains and Critical Paths

An out-of-order core (Ch. 27 §27.3) executes as fast as its **longest chain of dependent operations** permits, not as fast as its instruction count suggests. The **critical path** of a loop is the longest cycle in its data-dependence graph per iteration; if that path is `L` cycles, the loop cannot run faster than `L` cycles per iteration regardless of available ports.

The canonical example is a floating-point reduction. `vaddps` has 4-cycle latency and 2-per-cycle throughput on Skylake:

```cpp
float s = 0;
for (i...) s += a[i];                // s → s: a 4-cycle loop-carried chain. 4 cycles/element.
                                     // Machine can do 2 adds/cycle → running at 1/8 of peak.
```

The fix is **accumulator splitting** — break one chain into k independent chains:

```cpp
float s0=0,s1=0,s2=0,s3=0;
for (i; i+4<=n; i+=4) { s0+=a[i]; s1+=a[i+1]; s2+=a[i+2]; s3+=a[i+3]; }
float s = (s0+s1)+(s2+s3);
```

**Choose k ≥ latency × throughput** — for a 4-cycle, 2/cycle FP add, k = 8 saturates the units; for FMA (4-cycle latency, 2/cycle) on a dot product, 8–12 accumulators is standard, which is exactly why hand-written GEMM micro-kernels use 12–16 vector accumulators.

The compiler will not do this for floating point without `-ffast-math`/`-fassociative-math`, because FP addition is not associative and reassociation changes results (Ch. 2 §2.8). For integers it will, since integer addition is associative. **"Why is my float reduction 8× slower than my int reduction?"** — this, and it is a great interview question.

### Latency vs throughput bookkeeping

| Operation (Skylake/Ice Lake class) | Latency | Throughput |
|---|---|---|
| `add`/`sub`/`and`/`shift` (int) | 1 | 4/cycle |
| `imul` r64 | 3 | 1/cycle |
| `idiv` r64 | 30–90 | ~1/20–1/40 cycles |
| `vaddps`/`vmulps`/`vfmadd` | 4 | 2/cycle |
| `vdivps` (256-bit) | 11–14 | 1/4–1/8 cycles |
| `vsqrtps` | 12–19 | 1/6 cycles |
| L1 load-to-use | 4–5 | 2 loads + 1 store/cycle |
| L2 hit | ~14 | — |
| L3 hit | 40–50 | — |
| DRAM | 200–300 | — |
| `lock cmpxchg` (L1, uncontended) | ~20 | — |
| Predicted branch | ~0.5 | 1 taken/cycle |
| Mispredicted branch | 15–20 | — |

Agner Fog's tables and `uops.info` are the authoritative sources; knowing that these two exist and differ from vendor documentation is itself a signal.

### Breaking chains

- **Reassociate reductions** (above), including `min`/`max` and bitwise ORs.
- **Strength-reduce divides.** `x / 7` becomes a multiply-high plus shift; `x / y` with a runtime `y` does not, and a 30–90-cycle divide on the critical path is often the whole problem. Precompute a reciprocal, use libdivide, or restructure to a single divide outside the loop.
- **Replace long chains with trees.** Summing 8 values as `((a+b)+(c+d))+((e+f)+(g+h))` is 3 levels deep instead of 7.
- **Watch out for `cmov` on the chain** (§42.4) and for a store-to-load forward on the chain (Ch. 29 §29.8 — a forwarded load is ~5 cycles, a *failed* forward is ~12–15).
- **Loop-carried pointer chases cannot be broken** — that is why linked lists lose to arrays even when the algorithm looks identical.

**Diagnostic signature:** IPC well below 1 with near-zero cache misses and near-zero branch misses, and `perf record` showing time concentrated on a single arithmetic instruction. In top-down terms (Ch. 43 §43.19) this is "Backend Bound → Core Bound → not port-saturated", i.e. latency-bound.

---

## 42.11 Partial-Register and False Dependencies

A **false dependency** (write-after-write or write-after-read on a physical register) is one the algorithm does not require but the hardware enforces, usually because an instruction writes only *part* of an architectural register and the renamer (Ch. 27 §27.6) must merge with the old value.

### Partial-register stalls

```asm
mov  al, [rdi]        ; writes only the low 8 bits of rax
add  rax, rbx         ; needs the full rax → must merge new AL with the old upper 56 bits
```

On P6-era cores this was a 5–7 cycle stall. Modern Intel cores insert a **merge µop** instead, and Haswell+ handle the common cases well, but the dependency remains: `mov al, x` depends on the previous value of `rax`. The compiler's fix, which you will see everywhere in generated assembly, is **`movzx`/`movsx`** (zero/sign-extending load into the full 32/64-bit register), which has no dependency on the prior value.

**The 32-bit rule:** writing a 32-bit register (`mov eax, 1`) **implicitly zeroes the upper 32 bits** of `rax`, so 32-bit operations never create a partial-register dependency. Writing 8- or 16-bit registers (`al`, `ax`) does not zero, and does create one. This is why `xor eax, eax` is the idiomatic zeroing sequence and why compilers prefer 32-bit ops even for values that fit in a byte.

**Flags are partially written too.** `inc`/`dec` write some flags but leave CF alone, creating a partial-flags dependency on the previous flag producer; `add reg, 1` writes all flags and does not. This is why compilers emit `add`/`sub` instead of `inc`/`dec` when tuning for Intel, and it is a nice, specific detail to have ready.

### The zeroing and dependency-breaking idioms

The renamer recognizes these as **dependency-breaking** and executes them at rename with zero latency and zero execution port usage ("zero-idiom" / "move elimination"):

```asm
xor eax, eax          ; = 0, no dependency on old eax, no port used
sub eax, eax          ; same
pxor  xmm0, xmm0      ; SSE zero idiom
vpxor xmm0, xmm0, xmm0; AVX
vxorps ymm0, ymm0, ymm0
pcmpeqd xmm0, xmm0    ; all-ones idiom, also dependency-breaking
mov eax, ebx          ; register-to-register moves are eliminated at rename (Ivy Bridge+)
```

By contrast `mov eax, 0` is *not* a zero idiom (it is a real 2-byte-larger instruction that still executes) — hence the ubiquity of `xor`.

### The famous false dependencies

- **`popcnt`, `lzcnt`, `tzcnt` false dependency on the destination.** On Sandy Bridge through roughly Ice Lake, `popcnt rax, rbx` was decoded as if it also read `rax`, creating a false 3-cycle chain across loop iterations. A `popcnt` loop that should run at 1/cycle ran at 1 per 3 cycles. The fix compilers apply is emitting `xor rax, rax` before the `popcnt`. If you write `popcnt` in inline asm or an old compiler, you hit this. It is the textbook false-dependency example and a favorite question.
- **`vcvtsi2sd xmm0, rax`** and other scalar-converting instructions merge into the upper lanes of the destination, creating a dependency on the destination register. Compilers emit `vxorps xmm0,xmm0,xmm0` first; `vcvtsi2sd xmm0, xmm0, rax` (the 3-operand AVX form) exists to name the merge source explicitly.
- **Store-forwarding false dependencies (4K aliasing).** A load whose address matches a recent store *modulo 4096* is speculatively assumed to alias, stalling the load for ~5–12 cycles even though the addresses differ. Counter: `LD_BLOCKS_PARTIAL.ADDRESS_ALIAS`. Signature: two buffers whose addresses differ by an exact multiple of 4 KB (very common with `mmap`ed or page-aligned allocations) in a copy loop. Fix: offset one buffer by a cache line.

---

## 42.12 AVX-SSE Transition Penalties

x86 has two encodings for 128-bit vector instructions: **legacy SSE** (`addps xmm0, xmm1`) and **VEX-encoded AVX** (`vaddps xmm0, xmm1, xmm2`). The semantic difference is what happens to bits 128–255 of the corresponding YMM register:

- **Legacy SSE writes leave the upper 128 bits unchanged** (they predate YMM and must preserve them).
- **VEX 128-bit writes zero the upper 128 bits.**

This forces the hardware to track "upper state" and pay for transitions.

| Microarchitecture | Behavior | Cost |
|---|---|---|
| Sandy Bridge, Ivy Bridge | Hard transition penalty: saving/restoring upper YMM state | ~70 cycles **each way** |
| Haswell, Broadwell | Same class of penalty | ~70 cycles |
| Skylake and later | No save/restore; instead a legacy-SSE write creates a **false dependency** on the full YMM register, and the core enters a "dirty upper" state that can also cost ~1 cycle per SSE instruction | Blended: dependency stalls rather than a fixed penalty |
| AMD Zen | No transition penalty | ~0 |

### How you actually hit this

Not by writing mixed intrinsics — by **linking**. You compile your code with `-mavx2`, but you call into a library (an old `libm`, a vendor blob, a hand-written assembly routine, or a `memcpy` from a pre-AVX libc) that uses legacy SSE. Every call boundary is a transition. Signal handlers and JIT-generated code do the same thing.

**The fix, in order:**

1. **`vzeroupper` before any call into code that may use legacy SSE, and at the end of any AVX-using function.** The ABI requirement is that a function returning to unknown code should leave the upper state clean. Compilers insert `vzeroupper` automatically at function boundaries when compiling with AVX enabled — *this is why hand-written AVX assembly is a common source of the bug, since hand-written code forgets it.* `_mm256_zeroupper()` is the intrinsic.
2. **Compile everything with the same ISA level.** One `-mavx2` translation unit linked against `-msse2` objects is the setup.
3. **Never mix `_mm_*` (SSE) and `_mm256_*` (AVX) intrinsics in a file compiled without AVX enabled** — the SSE intrinsics will emit legacy encodings.

**Diagnostic signature:** `perf stat -e other_assists.avx_to_sse,other_assists.sse_to_avx` (Sandy Bridge–Broadwell) shows nonzero counts; on Skylake+, look for unexplained stalls at library-call boundaries and check for missing `vzeroupper` with `objdump -d | grep -c vzeroupper`. A profile where a trivial `memcpy` appears to cost hundreds of cycles is the classic presentation.

---

## 42.13 SIMD Frequency Downclocking

Wide vector execution draws enough current that Intel server parts (Haswell through Ice Lake, most severely Skylake-SP/Cascade Lake) reduce clock frequency when running 256- or 512-bit instructions. Frequencies are published per *license level*:

| License | Triggered by | Typical all-core turbo (Skylake-SP class) |
|---|---|---|
| **L0** | Scalar, SSE, and "light" 256-bit (no FP/int multiply) | Base turbo, e.g. 3.5 GHz |
| **L1** | Heavy 256-bit (FP, FMA, integer multiply) and light 512-bit | ~15% lower, e.g. 3.0 GHz |
| **L2** | Heavy 512-bit (FMA) | ~30–40% lower, e.g. 2.2 GHz |

Three properties make this worse than the raw numbers suggest:

1. **The frequency drop is per-core but affects the whole core, including scalar code**, and on some parts affects other cores on the socket via the shared voltage/frequency domain. A single thread running an AVX-512 memcpy can slow down a latency-critical scalar thread on a neighboring core.
2. **The transition is not instantaneous.** Entering a lower license takes effect within microseconds, but *returning* to the higher frequency takes on the order of **~2 milliseconds** of no heavy-vector activity. A brief AVX-512 burst therefore costs milliseconds of reduced clock. This asymmetry is the killer for trading systems: a background AVX-512 checksum can depress the hot path's clock long after it finished.
3. **During the transition the core may stall entirely** (the "frequency transition" halt, tens of microseconds on early parts).

### The practical rules

- **Ice Lake-SP and later (and Sapphire Rapids) drastically reduced these penalties**; AMD Zen 4/5's AVX-512 (double-pumped on Zen 4, native on Zen 5) has essentially no license-based downclocking. So "AVX-512 is always slower" is a 2017 statement, not a 2025 one — the correct answer names the microarchitecture.
- On affected parts, **AVX-512 pays off only for long, sustained, compute-dense kernels** — video encode, crypto, large GEMM. For short bursts in a latency-sensitive process it is a net loss.
- Some low-latency shops compile with `-mprefer-vector-width=256` (GCC/Clang) to get AVX-512's extra registers, masking, and instructions *without* 512-bit operations that trigger L2. This is the standard compromise and a good thing to name.
- glibc's `memcpy` selecting an AVX-512 variant via IFUNC has caused exactly this problem in production; `GLIBC_TUNABLES=glibc.cpu.x86_non_temporal_threshold=...` and `x86_rep_movsb_threshold` tune the related choices.

**Diagnostic signature:** measure actual frequency, not the nominal one — `perf stat` reports `cycles` and `ref-cycles`; their ratio gives the effective frequency multiplier, and `turbostat` reports `Bzy_MHz` directly. If a change made your instruction count go down and your wall time go up, check the frequency before anything else.

---

## 42.14 Non-Temporal Memory Access

**Non-temporal** (streaming) accesses tell the cache hierarchy "I will not reuse this data" so it bypasses or minimally disturbs the caches.

```cpp
_mm256_stream_si256((__m256i*)dst, v);   // vmovntdq  — NT store
_mm_stream_si32(p, x);                    // movnti
_mm_prefetch(p, _MM_HINT_NTA);            // NT prefetch: bring in with minimal pollution
_mm_sfence();                             // REQUIRED after NT stores before publishing
```

### Why NT stores can be faster

An ordinary store to a line not in cache triggers a **read-for-ownership (RFO)**: the core must fetch the line from memory to get exclusive ownership before it can write, even if the store will overwrite the entire line (Ch. 29 §29.10). For a pure memory-fill workload, that doubles DRAM traffic — you read data you are about to discard.

NT stores go to **write-combining buffers** (Ch. 29 §29.11). When a full 64-byte line has accumulated, it is written straight to memory with no RFO and no cache allocation. Benefits:

- **Up to ~2× effective write bandwidth** for large sequential fills, because the read half of the traffic disappears.
- **No cache pollution.** Copying a 1 GB file through the L3 evicts the entire working set of every other thread on the socket. NT stores leave L3 alone — this is often more valuable than the bandwidth itself in a multi-tenant or latency-critical box.

### The requirements and the traps

- **Ordering.** NT stores are **weakly ordered even on x86-TSO** (Ch. 29 §29.13). They can become visible out of order with respect to normal stores. You must execute `SFENCE` (or a stronger fence, or a locked instruction) before any store that publishes the data. `std::atomic` release semantics do *not* by themselves order NT stores on x86, since a release store compiles to a plain `mov` — this is a genuine correctness trap in lock-free code that mixes NT copies with atomic publication.
- **You must fill whole lines.** A partial line forces the WC buffer to be evicted as a partial write, which is *slower* than a normal store. Align the destination to 64 bytes and write in full-line units; handle the head/tail with normal stores.
- **Limited WC buffers.** There are only ~10–12 fill/WC buffers per core. Interleaving NT stores across more than a handful of destination streams causes premature partial evictions and destroys the benefit.
- **NT stores are slower for small copies and for data you will re-read**, since the data must come back from DRAM. The crossover in glibc's `memcpy` is around the non-temporal threshold (roughly 3/4 of L3 by default) — below that, normal stores win.
- **`_MM_HINT_NTA` prefetch** brings a line into L1 (or a way-limited subset of L3) marked for early eviction. Useful for a one-pass scan over data larger than L3 that you must not let evict your hot structures. Effects are microarchitecture-specific and it is easy to make things worse.
- **`movntdqa` (NT *load*)** only bypasses the cache for **WC memory type** (i.e. device/framebuffer memory, PCIe BARs), not for normal write-back memory. This is widely misunderstood; on WB memory it behaves like an ordinary load. It matters for reading from a mapped NIC BAR or FPGA aperture (Ch. 48 §48.1).

**When to reach for it in a trading system:** archival writes of market-data capture, journal writes (Ch. 56 §56.1), and any large buffer copy that would otherwise flush L3 out from under the hot path. Not for anything on the critical path itself.

---

## Key Interview Questions

1. **What is data-oriented design, in one sentence?** — Choose data layout from the hot loop's access pattern, so that the fraction of each fetched 64-byte cache line you actually use approaches 1.
2. **When is AoS better than SoA?** — When you touch all fields of one entity at random: AoS costs one line fetch, SoA costs one miss per array. SoA wins for scans over one or few fields.
3. **What is the failure mode of SoA with many fields?** — You exceed the hardware prefetcher's stream-tracking capacity and the DTLB entry budget; AoSoA (blocks of 8–64) is the fix.
4. **When does branchless beat branchy?** — Only when the branch is unpredictable and both arms are cheap. Under ~1% misprediction, branchless is a pessimization.
5. **Why can `cmov` be slower than a branch?** — It converts a control dependency into a data dependency, so it cannot be speculated past; if the condition comes from a cache miss, `cmov` stalls where a branch would have run ahead.
6. **When is a lookup table a bad idea?** — When it does not fit in L1/L2: an L3 or DRAM access is 40–300 cycles, more than most computations, and the table evicts the rest of your working set.
7. **What is `PSHUFB` used for beyond shuffling?** — A 16-entry in-register byte lookup table with zero cache cost; the basis of simdjson, base64, hex, and UTF-8 kernels.
8. **Why did the compiler not vectorize my loop?** — Possible aliasing, unknown trip count, early exit, non-unit stride, un-inlined calls, or FP reassociation. Diagnose with `-fopt-info-vec-missed` / `-Rpass-missed=loop-vectorize`.
9. **Why is a float reduction 8× slower than the integer version?** — FP addition is not associative, so the compiler keeps a single 4-cycle loop-carried chain. Split into ≥8 accumulators by hand (or allow `-fassociative-math`).
10. **How do you choose a tile size?** — So that the sum of the working blocks fits comfortably within the target cache level with headroom, and is a multiple of the SIMD width; then sweep empirically per machine.
11. **When does software prefetch help?** — For computable-but-irregular addresses, short loops the hardware prefetcher cannot train on, and across 4 KB page boundaries, which hardware prefetchers never cross. Not for plain sequential access.
12. **How do you pick the prefetch distance?** — Roughly memory latency divided by per-iteration cycles; too short gives no benefit, too long evicts the line before use.
13. **What is a split lock and why does it matter?** — A locked RMW straddling a cache line forces a bus lock that stalls every core on the socket for microseconds; detect with `split_lock_detect`.
14. **What is the `popcnt` false dependency?** — On Sandy Bridge through Ice Lake, `popcnt`/`lzcnt`/`tzcnt` falsely read their destination register, serializing a loop at 1-per-3-cycles; the fix is `xor` on the destination first.
15. **Why do compilers emit `xor eax, eax` rather than `mov eax, 0`?** — `xor` is a recognized zero idiom: broken dependency, handled at rename, no execution port, and smaller encoding.
16. **What causes an AVX–SSE transition penalty and how do you avoid it?** — Mixing VEX and legacy-SSE 128-bit encodings, usually across a library boundary; ~70 cycles each way pre-Skylake, a false YMM dependency after. Fix with `vzeroupper` and a uniform ISA level.
17. **Is AVX-512 slower than AVX2?** — On Skylake-SP/Cascade Lake, heavy 512-bit code drops to license level L2 (~30–40% clock reduction) with a ~2 ms recovery, so short bursts lose. On Ice Lake+ and Zen 4/5 the penalty is largely gone. `-mprefer-vector-width=256` is the compromise.
18. **Why can non-temporal stores double write bandwidth?** — They avoid the read-for-ownership that a normal store to an uncached line requires, halving DRAM traffic for pure fills; they also avoid evicting L3.
19. **What must you do after non-temporal stores?** — `SFENCE` before publishing, because NT stores are weakly ordered even under x86-TSO and a plain release store does not order them.

---

## Common Traps

- **Rewriting AoS to SoA without checking that the loop was memory-bound** — no gain, permanent complexity.
- **SoA with 20 fields** — prefetcher stream and TLB exhaustion; the "optimized" version is slower.
- **Going branchless on a 99%-predicted branch** — you now execute both arms every time.
- **Assuming a ternary compiled to `cmov`** — check the assembly; if-conversion is a heuristic and PGO reverses it.
- **Putting a `cmov` on the loop-carried critical path** — adds a cycle per iteration that a predicted branch would not have cost.
- **A lookup table that outgrew L2** — recomputation is now cheaper, and the table evicted everything else.
- **Measuring a LUT in a loop that keeps it hot** — the benchmark amortizes the cold-miss cost the real workload pays every time.
- **Cross-lane assumptions in AVX2** — `vpshufb`, `vpalignr`, and `vunpck*` operate within 128-bit lanes, not across the 256-bit register.
- **Horizontal reductions inside the loop** — 3–7 cycles each; reduce once at the end.
- **Forgetting `__restrict`** — the vectorizer emits a runtime overlap check and a scalar fallback, or gives up.
- **A single FP accumulator** — a 4-cycle loop-carried chain caps you at ⅛ of peak FLOPs.
- **A runtime `divide` in the inner loop** — 30–90 cycles on the critical path; hoist or strength-reduce.
- **Prefetching sequential data** — the L2 streamer already did it; you added µops and possibly evicted useful lines.
- **Prefetching with the wrong distance** — too short is useless, too long is pollution; both look like "prefetch doesn't help".
- **Aligning every buffer to 4 KB** — all of them map to the same cache sets; conflict-miss thrashing. Pad strides instead.
- **A misaligned atomic** — split lock, socket-wide stall.
- **8/16-bit register writes on the critical path** — partial-register merge dependency; `movzx` instead.
- **Two buffers whose addresses differ by an exact multiple of 4 KB** — 4K-aliasing false store-forwarding stalls.
- **Hand-written AVX assembly without `vzeroupper`** — transition penalties at every call boundary.
- **A background AVX-512 task in a latency-critical process** — depresses the core's clock for milliseconds after it stops.
- **Non-temporal stores without `SFENCE`, or not filling whole lines** — a correctness bug and a performance bug respectively.
- **Expecting `movntdqa` to bypass cache on normal memory** — it only does so for WC-typed memory.

---

## Compact Recall Summary

**Data-oriented design.** The cost unit is the 64-byte line, not the field; maximize line utilization. Split hot from cold fields, prefer `uint32_t` indices to pointers (half the size, relocatable, and they preserve memory-level parallelism where pointer chases serialize), batch homogeneous work, and wrap the *collection*, not the element.

**AoS/SoA/AoSoA.** SoA for scans over few fields (line utilization + contiguous SIMD loads); AoS for random full-record access (one line vs N misses); AoSoA for both, and as the fix when SoA exhausts prefetcher streams and TLB entries. C++ has no support; proxy-reference libraries break `auto&` and generic algorithms.

**Branches.** Mispredict ≈ 15–20 cycles. Branchless wins only when p_mispredict is near 0.5 and both arms are cheap. Higher-yield forms: unswitch the loop, sort/partition the data so branches become predictable, replace dispatch with dense homogeneous batches. Diagnose with `branch-misses`; under ~1% miss rate, leave it alone.

**`cmov`.** 1-cycle latency, but it turns a control dependency into a data dependency — no speculation past it. Losing case: the condition depends on a cache miss, or the `cmov` lands on the loop-carried chain.

**LUTs.** Only if L1/L2-resident. `PSHUFB`/`VPERMB` give a 16/64-entry table in a register with zero cache cost — the modern answer. Table-driven dispatch is still an indirect branch.

**SIMD.** Autovectorization dies on aliasing, unknown trip counts, early exits, and FP reassociation. Keep accumulators vertical, reduce once. AVX2 shuffles are per-128-bit-lane. `loadu` is free unless it crosses a line. AVX-512 masking removes the scalar tail. Gathers are usually slow.

**Loops.** Tile so the block working set fits the target cache, sized to a SIMD multiple, tuned per machine; pack blocks for unit stride. Interchange for unit stride, fuse for reuse, fission to relieve register/stream pressure, unroll to expose ILP. Compilers rarely tile for you.

**Pipelining and prefetch.** Overlap iterations so long-latency loads for *i+D* issue while *i* computes; the ROB alone cannot cover a 250-cycle miss. Software prefetch is for computable-irregular addresses, untrainable short loops, and page crossings — hardware prefetchers handle strides within a page and never cross pages. Distance ≈ latency ÷ cycles-per-iteration.

**Alignment.** Separate concerns: `alignof` for correctness, 32/64 B for SIMD, 64 B for false sharing, pages for TLB. Line-crossing loads cost a cycle; page-crossing stores cost more; a misaligned atomic causes a socket-wide split lock. `std::assume_aligned` removes the vectorizer's peeling loop. Over-aligning everything creates conflict misses.

**Dependency chains.** Throughput is capped by the longest loop-carried chain, not the instruction count. Split reductions into ≥ latency×throughput accumulators (8 for FP add/FMA). Kill divides on the chain. Signature: low IPC with no cache or branch misses — top-down "Core Bound", latency-flavored.

**False dependencies.** Partial 8/16-bit register writes merge with the old value (`movzx` avoids it); 32-bit writes zero-extend and are safe. `xor`/`pxor`/`vpxor` are recognized zero idioms. `popcnt`/`lzcnt`/`tzcnt` had a false destination dependency through Ice Lake. `inc`/`dec` partially write flags. 4K aliasing causes false store-forwarding stalls.

**AVX/SSE and frequency.** Legacy SSE preserves upper YMM bits, VEX zeroes them; mixing costs ~70 cycles each way pre-Skylake and a false dependency after. `vzeroupper` at function boundaries; uniform `-march`. Heavy 512-bit code drops to license L2 (~30–40% clock) on Skylake-SP with ~2 ms recovery — largely fixed on Ice Lake+ and Zen 4/5; `-mprefer-vector-width=256` is the hedge. Verify with `cycles`/`ref-cycles` or `turbostat`.

**Non-temporal.** NT stores skip the read-for-ownership and skip cache allocation: ~2× write bandwidth on pure fills and, more importantly, no L3 eviction of the hot path. Requires whole-line fills, few concurrent streams, and `SFENCE` before publication. NT loads only bypass cache on WC memory. `_MM_HINT_NTA` limits pollution for one-pass scans.
