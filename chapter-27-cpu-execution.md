# Chapter 27 — CPU Execution

*Interview-focused revision notes. The theme: a modern core is a speculative dataflow machine wearing a sequential-ISA costume, and every latency number in this chapter falls out of one question — what stops the machine from retiring 4–6 instructions per cycle?*

---

## 27.1 CPU Pipeline Fundamentals

A **pipeline** overlaps the stages of instruction processing so that one instruction can retire per cycle even though each instruction takes many cycles end-to-end. The classic five stages — fetch, decode, execute, memory, writeback — are a teaching model; a modern x86-64 core (Golden Cove, Zen 4/5) has **15–20 pipeline stages** between fetch and retire, and ARM Neoverse V2 is comparable at ~13–15.

Two numbers describe a pipeline:

- **Latency** — cycles from an instruction issuing to its result being usable by a dependent instruction.
- **Throughput** — instructions of that kind that can begin per cycle (often expressed as reciprocal throughput, CPI).

The pipeline's *depth* buys frequency: shorter per-stage work means a shorter clock period. It costs **misprediction penalty**, which is roughly the number of stages between the branch's fetch and its resolution. A 20-stage pipeline at 3 GHz has a ~15–20-cycle branch flush, i.e. **~5–7 ns of pure waste per mispredict**. This tradeoff — deep pipeline for GHz, paid for in mispredict cost — is the single most important structural fact about modern cores, and it's why branchless code (Ch. 42 §42.3) pays.

### The canonical modern layout

```
        ┌──────────── FRONT END (in-order) ────────────┐
BPU → L1i fetch (32B/cyc) → predecode → decode (4-6 µops/cyc)
                                 ↓            ↑
                          µop cache (DSB) ────┘  (6-8 µops/cyc, bypasses decode)
                                 ↓
                       µop queue / loop buffer
                                 ↓
        ┌──────────── BACK END (out-of-order) ─────────┐
   rename+allocate (5-6/cyc) → scheduler (RS) → ports 0..11 → writeback
                                 ↓
                    reorder buffer (ROB) → RETIRE (in order, 6-8/cyc)
```

The **front end** is in-order and its job is to keep the µop queue full. The **back end** is out-of-order and its job is to find work. **Retirement is strictly in-order** — this is what makes precise exceptions and speculation rollback possible.

### Pipeline width, generation by generation

| Core | Decode | Rename/alloc | Retire | ROB entries |
|---|---|---|---|---|
| Skylake (2015) | 4+1 | 4 | 4 | 224 |
| Ice Lake / Sunny Cove | 5 | 5 | 5 | 352 |
| Golden Cove (Alder Lake P) | 6 | 6 | 8 | 512 |
| Zen 3 | 4 | 6 | 8 | 256 |
| Zen 5 | 8 (dual 4-wide) | 8 | 8 | 448 |
| Apple M1 Firestorm | 8 | 8 | 8 | ~630 |
| Neoverse V2 | 8 | 8 | 8 | ~320 |

ARM's advantage historically is decode width: fixed 4-byte instructions decode trivially in parallel, whereas x86's 1–15-byte variable-length encoding forces a serial length-determination pass (hence the µop cache, §27.7).

### The performance identity

```
cycles = instructions / IPC       IPC ≤ retire width (4–8 on modern cores)
time   = cycles / frequency
```

Real code rarely exceeds **IPC 2–3**; a well-tuned tight kernel can hit 4–5. `perf stat` reports it directly (`instructions`, `cycles`, and the derived `insn per cycle`). An IPC below ~1.0 on a hot loop is a signal — it means stalls, and the rest of this chapter is the taxonomy of stall causes. Top-down analysis (§27.15, Ch. 43 §43.19) is the systematic way to attribute them.

---

## 27.2 Superscalar Execution

**Superscalar** means the core can issue and execute more than one instruction per cycle from a *single* instruction stream. This is distinct from SIMD (one instruction, many data — Ch. 42 §42.6) and from SMT (multiple streams — §27.17). All three multiply throughput by orthogonal factors.

Superscalar width is limited at four places, and the *narrowest* is your ceiling:

| Stage | Skylake | Golden Cove | Zen 5 |
|---|---|---|---|
| Fetch (bytes/cycle) | 16 | 32 | 32×2 |
| Decode (µops/cycle) | 5 | 6 | 8 |
| µop cache delivery | 6 | 8 | 12 (op cache) |
| Rename/allocate | 4 | 6 | 8 |
| Execution ports | 8 | 12 | 10+ |
| Retire | 4 | 8 | 8 |

The **allocation/rename width** is usually the practical ceiling because it's the narrowest of the sustained stages — Skylake's famous "4-wide" figure is its rename width. This is why "reduce instruction count" is real advice even when the instructions are cheap: at 4 µops/cycle allocation, 100 extra µops in a loop body costs 25 cycles no matter how trivial they are.

### µop count, not instruction count

x86 instructions decode into µops, and the mapping isn't 1:1:

```asm
add  %rax, (%rbx)      ; 1 instruction, but 2-3 µops (load, add, store)
                       ;  → 4 µops unfused on Intel; 2 fused-domain
push %rbp              ; 1 instruction, 1 µop on Intel (dedicated stack engine)
                       ;  — the stack engine handles RSP updates outside the OOO core
```

Two domains matter for reading counters:

- **Fused-domain** µops — what allocation/retire bandwidth is spent on. Macro-fusion (`cmp` + `jcc` → one µop) and micro-fusion (load+ALU held as one entry until dispatch) both reduce this.
- **Unfused-domain** µops — what execution ports actually see.

`perf stat -e uops_issued.any,uops_executed.thread,uops_retired.retire_slots` gives you all three on Intel. `uops_issued.any / uops_retired.retire_slots > 1` means speculation waste (§27.11, §27.16).

**Macro-fusion** is worth naming explicitly: on Intel and Zen, an `cmp`/`test`/`add`/`sub` immediately followed by a conditional jump fuses into a single µop. It's why loop counters compiled as `dec`/`jnz` cost one µop, and why an instruction inserted between the compare and the branch is a real regression. It requires the pair to not straddle certain fetch boundaries — one more reason code alignment (§27.15) matters.

### Why width doesn't translate to speed

An 8-wide machine on a serial dependency chain runs at the chain's latency, IPC ≈ 1/latency. `for (p = head; p; p = p->next)` on a linked list runs at one iteration per L2/L3/DRAM latency regardless of core width — perhaps IPC 0.02. Superscalar width converts *available parallelism* into speed; it does not create parallelism. Finding it is §27.4.

---

## 27.3 Out-of-Order Execution and Retirement

**Out-of-order (OoO) execution**: instructions execute as soon as their operands are ready and a port is free, not in program order. **In-order retirement**: architectural state (registers, memory) is updated in program order.

The separation is the whole trick. Execution is a dataflow graph; retirement replays the illusion of sequential execution for the benefit of exceptions, interrupts, and debuggers.

```
Program order:   A: load  rax, [rdi]        ← misses to DRAM, ~250 cycles
                 B: add   rax, 1            ← depends on A, blocked
                 C: load  rbx, [rsi]        ← independent, ISSUES IMMEDIATELY
                 D: imul  rbx, 3            ← runs while A is still in flight

Execution order: A(start) C D ... A(complete) B
Retire order:    A B C D
```

C and D execute *underneath* A's cache miss. This is **memory-level parallelism** in embryo (Ch. 29 §29.4) and it is the single largest reason real code isn't 100× slower than it looks.

### What "in flight" means and its limits

An instruction occupies a **ROB entry** from allocation to retirement. The ROB is the OoO window: with a 512-entry ROB, at most 512 µops can be in flight. If a load misses to DRAM at ~250 cycles and the core allocates 6 µops/cycle, the window drains in 512/6 ≈ 85 cycles and then the machine **stalls on allocation** with a full ROB, even though the miss has 165 cycles left. This is the ROB-limited regime, and it's exactly why prefetching (Ch. 28 §28.13) matters: it starts the miss earlier so the ROB isn't the binding constraint.

Other in-flight resources exhaust first in practice:

| Resource | Skylake | Golden Cove | Exhaustion symptom |
|---|---|---|---|
| ROB | 224 | 512 | Any long stall |
| Integer PRF | 180 | 280 | Register-heavy code |
| Vector PRF | 168 | 332 | SIMD kernels |
| Load buffer | 72 | 192 | Load-heavy / miss-heavy |
| Store buffer | 56 | 114 | Store-heavy, or store draining |
| Scheduler (RS) | 97 | 205 | Dependency-dense code |
| Branch order buffer | 48 | ~128 | Deeply nested branches |

`perf` on Intel exposes these as `RESOURCE_STALLS.*` and, more usefully, via toplev's Backend_Bound breakdown. When you see `RESOURCE_STALLS.SB` dominating, you have store-buffer pressure (Ch. 29 §29.7).

### Precise exceptions

If instruction A faults, everything after it in program order must appear not to have happened. Because retirement is in-order and speculative results live in rename registers rather than architectural ones, the recovery is: mark the ROB entry as faulting, let earlier entries retire, then flush the ROB and redirect. **This is also the exact mechanism for branch misprediction recovery (§27.11) and machine clears (§27.16)** — all three are "flush everything younger than entry N."

The interview point: *speculation is only safe because architectural state is not updated until retirement.* Spectre (§27.18) is what happens when a *microarchitectural* side effect (a cache line fill) survives a rollback that correctly undid all architectural effects.

---

## 27.4 Instruction-Level Parallelism

**ILP** is the number of instructions in a window that could execute simultaneously without violating dependences. It is a property of *your code*, not of the CPU; the CPU can only harvest what exists.

Three dependence types bound it (§27.14 covers the hazard framing):

- **RAW (true / flow)** — B reads what A wrote. **Irreducible.** Only algorithm change removes it.
- **WAR (anti)** — B writes what A read. Removed entirely by register renaming (§27.6).
- **WAW (output)** — both write the same register. Also removed by renaming.

So in practice **ILP is limited by RAW chains and by branches**.

### The critical path calculation

```cpp
// Serial: latency-bound. FP add latency 4 cycles on Skylake+.
double sum = 0;
for (int i = 0; i < n; ++i) sum += a[i];      // 4 cycles/element → 0.25 elem/cyc

// Unrolled with 4 accumulators: throughput-bound.
double s0=0,s1=0,s2=0,s3=0;
for (int i = 0; i < n; i += 4) {
    s0 += a[i]; s1 += a[i+1]; s2 += a[i+2]; s3 += a[i+3];
}                                              // 2 FP adds/cycle → 8× faster
```
The rule: **accumulators needed = latency × throughput**. FP add is latency 4, throughput 2/cycle → 8 independent accumulators to saturate. FMA on Skylake is latency 4, throughput 2/cycle → also 8. This "latency×throughput accumulators" formula is a standard interview answer and generalizes to any reduction.

Note the compiler will **not** do this for floating point without `-ffast-math` (Ch. 2 §2.8), because FP addition isn't associative and reassociating changes results. For integers it will. This is the most common concrete case where `-ffast-math` produces a large, legitimate speedup — and where you should instead write the multiple accumulators explicitly so the change is visible and controlled.

### Measuring ILP

```
$ perf stat -e cycles,instructions,uops_executed.thread,uops_executed.cycles_ge_1_uop_exec ./a.out
```
`uops_executed.thread / uops_executed.cycles_ge_1_uop_exec` gives µops per *active* cycle — the achieved ILP when the machine isn't fully stalled. Compare against the port-limited ceiling from §27.12. LLVM-MCA and Intel IACA (deprecated) statically model a loop body's ILP and print the critical path; `llvm-mca -mcpu=skylake -timeline` is the practical modern tool and produces exactly the resource-pressure table an interviewer would want you to reason about.

### Loop-carried dependences

The distinction that separates candidates: a dependence *within* an iteration is harmless (the OoO window overlaps iterations); a **loop-carried** dependence caps throughput at chain-latency per iteration. Pointer chasing, running sums, `x = f(x)`, and CRC-style feedback are all loop-carried. Techniques: multiple accumulators, loop unroll + interleave, software pipelining (Ch. 42 §42.7), or restructuring (e.g. CRC via `PCLMULQDQ` with 4 interleaved streams).

---

## 27.5 Reorder Buffers and Reservation Stations

Two structures, constantly confused, doing different jobs.

| | Reorder buffer (ROB) | Reservation station / scheduler (RS) |
|---|---|---|
| Holds | Every in-flight µop, in program order | µops **waiting for operands or a port** |
| Purpose | In-order retirement, precise exceptions, rollback | Wake-up and select: find ready µops, dispatch to ports |
| Entry freed when | The µop **retires** | The µop **dispatches** to a port |
| Size (Golden Cove) | 512 | 205 |
| Full ⇒ | Allocation stalls (whole front end blocks) | Allocation stalls |
| Ordering | Strictly program order (circular buffer) | Unordered / content-addressed |

A µop enters *both* at allocation. It leaves the RS as soon as it's dispatched, but stays in the ROB until it and everything older has completed. So a long-latency load occupies one ROB entry for 250 cycles while its RS entry is freed almost immediately — but every *dependent* µop sits in the RS for the duration, which is why dependency-dense code exhausts the RS before the ROB.

### Unified vs distributed schedulers

- **Intel (Sandy Bridge onward)** uses a *unified* RS: one pool of ~97–205 entries feeding all ports. Simpler to fill, but a single port's backlog can hog entries.
- **AMD Zen** uses *distributed* schedulers: separate queues per execution pipe (4× ~24 entries for integer, plus a separate FP scheduler). More total entries, but a misallocated µop can block a queue while another sits idle.
- **Apple/ARM designs** are typically distributed too, with very large aggregate capacity.

This is why "scheduler entries" numbers aren't directly comparable across vendors.

### Wake-up and select

Each cycle the RS does:
1. **Wake-up** — broadcast completing results' tags; any waiting µop matching a tag marks that operand ready.
2. **Select** — among ready µops, pick up to N per port by age (oldest-first, approximately).

Wake-up must complete in one cycle for back-to-back dependent execution (an `add` chain runs at 1 cycle/link). This CAM broadcast is one of the hardest circuits in the core and is a primary reason schedulers don't grow arbitrarily.

**Speculative wake-up** matters for loads: the scheduler wakes a load's dependents assuming an L1 hit (4–5 cycles) *before* knowing the hit occurred. On a miss, the dependents must be **replayed** — re-dispatched later. This shows up as `uops_dispatched` > `uops_retired` and, on Intel, as load-replay events. It's why L1 misses cost more than the raw latency difference suggests, and why a load feeding a long dependent chain is worse than the same load feeding nothing.

**Retirement and the ROB in practice:** `perf stat -e resource_stalls.any` or toplev's `Backend_Bound.Core` tells you the RS/ROB story; `RESOURCE_STALLS.ROB` specifically means the OoO window filled, which almost always traces to an unhidden memory stall upstream.

---

## 27.6 Register Renaming

The x86-64 ISA has 16 general-purpose architectural registers (32 with APX, 32 vector with AVX-512). The physical register file has **280+ integer and 330+ vector entries** on Golden Cove. **Register renaming** maps architectural names to physical registers, dynamically, at allocation.

Purpose: eliminate **WAR and WAW hazards**, which are not real data dependences but naming collisions forced by having few architectural names.

```asm
        ; architectural                    ; after renaming
1  mov  rax, [rdi]                         p37 ← [rdi]
2  add  rax, 5                             p38 ← p37 + 5
3  mov  [rsi], rax                         [rsi] ← p38
4  mov  rax, [rdx]      ← WAW+WAR on rax   p52 ← [rdx]     ← NO dependence on 1-3
5  add  rax, 7                             p53 ← p52 + 7
```
Instructions 4–5 are a completely independent chain despite reusing `rax`. Without renaming, 4 would have to wait for 3. Since compilers reuse registers aggressively (there are only 16), essentially **all** ILP in real x86 code depends on renaming.

### Zero-latency and eliminated operations

Renaming enables several µops to complete at the rename stage with **zero execution latency and no port**:

| Idiom | Handled how |
|---|---|
| `mov rax, rbx` | **Move elimination** — just point rax's map entry at rbx's physical reg. 0 cycles, 0 ports (Ivy Bridge+, Zen). |
| `xor rax, rax` / `sub rax, rax` | **Zeroing idiom** — recognized, breaks all dependences on the old rax, allocates a zeroed physical reg. This is *why* `xor eax,eax` beats `mov eax,0`: it's shorter *and* dependency-breaking. |
| `pxor xmm0, xmm0`, `vpxor`, `vzeroall` | Same for vectors. |
| `cmp`-style ones idiom (`pcmpeqd x,x`) | Recognized as all-ones on some cores. |

Move elimination has limits: Intel throttles it under high rename pressure, and it doesn't apply to all widths. Don't rely on it for correctness of a performance model; do know it exists.

### False dependences (partial registers)

The dark side of renaming (see Ch. 42 §42.11):

```asm
mov  al, [rdi]      ; writes only low 8 bits of rax → must MERGE with old rax
                    ;   → false dependence on the previous value of rax
movzx eax, byte [rdi] ; writes full 32/64-bit reg (32-bit writes zero-extend)
                    ;   → NO dependence. Always prefer this.
```
On Haswell+ a partial-register write inserts a **merge µop**; on older cores it caused a multi-cycle **partial-register stall**. The same applies to legacy SSE writing the low 128 bits of a 256-bit YMM register — the source of the **AVX–SSE transition penalty** (Ch. 42 §42.12), where mixing `addps` (legacy SSE, preserves upper YMM bits) with AVX code costs ~70 cycles per transition on Haswell, or a persistent false dependence on Skylake. Fix: compile everything with VEX encoding (`-mavx`) or issue `vzeroupper` before calling legacy code. `perf stat -e other_assists.avx_to_sse,other_assists.sse_to_avx` counts them directly.

**Flags renaming** is real too: `EFLAGS` is renamed in pieces, so `inc` (which writes some flags but not CF) can cause a partial-flags merge, which is why compilers emit `add reg, 1` rather than `inc` in flag-sensitive contexts.

---

## 27.7 Micro-ops and the Micro-op Cache

x86 instructions are variable length (1–15 bytes) and semantically complex. The core translates them into fixed-format internal **µops**. Decode is expensive: finding instruction boundaries is inherently serial, which is why x86 decode width lagged ARM's for a decade.

The **µop cache** (Intel: DSB, Decoded Stream Buffer; AMD: op cache) stores already-decoded µops keyed by instruction address, bypassing fetch and decode entirely.

| | Skylake DSB | Golden Cove | Zen 4 op cache |
|---|---|---|---|
| Capacity | 1536 µops (32 sets × 8 ways × 6) | ~4000 | 6.75K ops |
| Delivery rate | 6 µops/cycle | 8 | 9 |
| Legacy decode rate | 5 µops/cycle | 6 | 4 |
| Fetch window | 32B per DSB "way" | 32B | 64B |

Three delivery paths, in decreasing preference: **LSD (loop stream detector)** → **DSB** → **MITE (legacy decode)**. The LSD replays a small loop straight from the µop queue with the front end powered down; it was disabled on several Skylake steppings for an erratum and is absent on some later cores.

### DSB restrictions worth knowing

The DSB indexes by **32-byte aligned regions**; each region maps to at most 3 DSB ways × 6 µops = 18 µops. Consequences:

- A 32B region containing more than 18 µops **cannot be cached** at all and falls back to legacy decode for that region.
- An instruction whose µops would straddle a way boundary can force the whole region out.
- Microcoded instructions (>4 µops: `rep movsb`, `div`, gather, far calls) come from the **MSROM** and evict/bypass the DSB.

The diagnostic:
```
$ perf stat -e idq.dsb_uops,idq.mite_uops,idq.ms_uops,lsd.uops ./a.out
```
A hot loop with high `idq.mite_uops` is DSB-missing. Fixes: reduce code size in the loop (fewer/shorter instructions), align the loop to 32 bytes (`-falign-loops=32`), or reduce unrolling — over-unrolling can push a loop out of the DSB and *lose* performance, which is a great counterintuitive answer.

**DSB thrash from branch-heavy layout** is the other common cause: cold code interleaved with hot code within the same 32B regions wastes DSB capacity. This is what BOLT and PGO code layout (Ch. 40 §40.9, §40.11) fix.

### ARM contrast

AArch64's fixed 4-byte instructions decode cheaply, so most ARM cores have **no µop cache** — they decode 8-wide directly from L1i. Apple's cores likewise. This is why front-end analysis on ARM focuses on **L1i misses and branch prediction** rather than DSB residency, and why `idq.*`-style counters have no ARM analogue; you use `L1I_CACHE_REFILL` and `BR_MIS_PRED` instead.

---

## 27.8 Speculative Execution

**Speculation** is executing work whose necessity or correctness is not yet established, and having a mechanism to undo it. It exists because waiting for certainty would idle the machine: a branch's condition may depend on a load that's 250 cycles out.

Forms of speculation in a modern core:

| Kind | Speculating on | Verified by | Recovery |
|---|---|---|---|
| **Control** | Branch direction/target | Branch execution | Pipeline flush (§27.11), 15–20 cyc |
| **Memory disambiguation** | Load doesn't alias older unknown store | Store address resolution | Machine clear / load replay, ~20+ cyc (Ch. 29 §29.8) |
| **Store-to-load forwarding** | Load's data can come from store buffer | Address/size match | Forwarding failure → replay, ~12 cyc penalty |
| **Value/latency (L1 hit)** | Load hits L1 | Cache tag check | Dependent-µop replay |
| **Self-modifying / cross-page** | Code isn't being modified | SMC detection | Machine clear (§27.16), ~150+ cyc |

The invariant: **speculative results live only in rename registers, the store buffer, and the ROB; they never touch architectural state.** Retirement is the commit point. A store becomes visible to other cores only after the store retires and drains from the store buffer (Ch. 29 §29.7).

### What speculation costs even when it's *correct*

Nothing architecturally, but real resources: energy, execution slots that could have gone to other SMT threads, and **cache pollution** — a speculatively executed load fills a cache line even if the branch was wrong. That last point is both a real performance effect (`L1D` misses attributable to bad speculation) and the entire mechanism of Spectre (§27.18).

### Measuring speculation waste

```
$ perf stat -e uops_issued.any,uops_retired.retire_slots ./a.out
```
`Bad_Speculation = (uops_issued.any − uops_retired.retire_slots + N*machine_clears) / (width × cycles)` is the top-down formula. In practice `toplev.py --level 2` computes it for you and splits it into `Branch_Mispredicts` vs `Machine_Clears`. Above ~10% Bad Speculation on a hot path, branch layout is your problem; above ~20%, it's usually a genuinely unpredictable data-dependent branch that should be made branchless.

### Speculative memory ordering

Loads execute speculatively *out of order with respect to each other* even on x86, whose model forbids load–load reordering (Ch. 29 §29.13). The trick: the core executes them out of order, then checks at retirement whether any other core invalidated a line it had speculatively read early. If so, it issues a **memory-ordering machine clear** (`MACHINE_CLEARS.MEMORY_ORDERING`). So x86's strong model is *enforced by detection and rollback*, not by actually serializing — a genuinely non-obvious detail that explains why TSO is nearly free in the uncontended case and expensive under sharing.

---

## 27.9 Branch Prediction

Every taken branch would otherwise cost the full front-end latency. Modern predictors are astonishingly good — **95–99.5% accuracy** on typical code — because at 4-wide issue with a 20-cycle penalty, 95% accuracy already costs ~10% of throughput.

### Predictor structure

Modern Intel/AMD/ARM cores use a **TAGE**-family predictor (TAgged GEometric history length):

```
PC ──┬──► base bimodal table (2-bit counters, short history)
     ├──► T1: hash(PC, 4-bit history)   ─┐
     ├──► T2: hash(PC, 10-bit history)  ─┤ tagged tables; longest
     ├──► T3: hash(PC, 30-bit history)  ─┤ matching tag wins
     └──► T4: hash(PC, 120+-bit history)─┘
```

Key properties:
- **Geometric history lengths** — from a few branches to hundreds. A branch correlated with something that happened 80 branches ago is still predictable.
- **Tagged entries** with usefulness counters and periodic reset, so long-history entries only override when they've proven better.
- Effective capacity on a modern core is several thousand branches of context.

A **loop predictor** handles fixed-trip-count loops (predicting the final not-taken exit exactly), and a **statistical corrector / perceptron** component handles branches correlated linearly with many history bits (AMD has used perceptrons since Bobcat).

### What is and isn't predictable

| Pattern | Predictable? | Why |
|---|---|---|
| `for (i=0;i<1000;++i)` | Yes, ~1 miss total | Loop predictor / long history |
| `if (rare_error_case)` | Yes, ~100% | Bimodal saturates |
| Alternating T,N,T,N | Yes | Short history captures it |
| Repeating period-20 pattern | Yes | 30-bit history table |
| `if (data[i] > 128)` on **random** data | **No, ~50%** | No correlation exists to learn |
| `if (data[i] > 128)` on **sorted** data | Yes | Long runs |
| Virtual call, one type at a time | Yes (BTB, §27.10) | Monomorphic |
| Virtual call, 5 types interleaved randomly | No | Indirect target unpredictable |

The sorted-vs-unsorted array benchmark is the canonical demo: identical work, 3–6× runtime difference, entirely branch misprediction. Expect to be asked to explain it.

### Aliasing and capacity

Predictor tables are indexed by hashed PC, so **two hot branches can alias** and destructively interfere — a real effect in large binaries and one more reason code size matters (§27.15). Predictor state is also **not** flushed on context switch in general (it's tagged, and on some cores partially indexed by ASID/thread), which is exactly the Spectre-v2 cross-domain training problem (§27.18); IBPB exists to flush it deliberately.

### Practical control

```cpp
if (__builtin_expect(cond, 0)) { ... }        // GCC/Clang
if (cond) [[unlikely]] { ... }                // C++20, Ch. 40 §40.6
```
These do **not** control the hardware predictor — they control **code layout** (moving the cold path out of line, so the fall-through is the common case) and inlining/optimization decisions. Only PGO/AutoFDO gives the compiler real branch frequencies. Measure with `perf stat -e branches,branch-misses` and locate with `perf record -e branch-misses:pp` (the `:pp` requests precise/PEBS attribution — without it, skid makes the attribution useless).

---

## 27.10 Branch-Target Buffers

Direction prediction (§27.9) answers *taken or not*. The **BTB** answers *where to*, and it must do so **at fetch time**, before the instruction is even decoded — the front end doesn't yet know there *is* a branch. So the BTB is really a "there is a branch at this fetch address, and it goes here" cache indexed by fetch address.

| Structure | Predicts | Typical capacity | Miss cost |
|---|---|---|---|
| L1 BTB | Target of direct/indirect branch | 512–1024 entries (Golden Cove ~1K L1, 12K+ L2) | ~2–3 cycles (re-steer) |
| L2 BTB | Overflow, larger footprint | 4K–12K entries | ~8–10 cycles |
| **ITA / indirect predictor** | Indirect branch targets with history | 1–4K entries | Full mispredict, ~17 cyc |
| **RSB / RAS** (return stack) | `ret` targets | **16–32 entries**, LIFO | Full mispredict on underflow |

### The three failure modes

**1. BTB capacity miss.** A binary with a large hot code footprint — think a big switch-driven feed handler or a template-heavy dispatch layer — overflows the BTB. Symptom: high `BACLEARS` / front-end re-steer cycles with *low* branch-miss rate (the direction was right; the front end just didn't know where to go early). This is a code-size problem; BOLT's basic-block reordering (Ch. 40 §40.11) directly reduces BTB pressure by making hot paths fall through.

**2. Indirect branch misprediction.** Virtual calls, function pointers, `switch` jump tables, PLT stubs. A monomorphic site predicts perfectly. A **polymorphic** site with randomly-interleaved targets is ~unpredictable and costs a full ~17–20-cycle flush per call. This is the concrete, measurable cost behind "avoid virtual dispatch on the hot path" (Ch. 55 §55.9) — not the extra indirection (which is one L1-hit load, ~5 cycles, usually hidden), but the **misprediction**. Devirtualization, CRTP (Ch. 6), `final`, or sorting work by type so calls become monomorphic all attack this.

**3. Return stack (RSB) underflow.** The RAS is a small LIFO pushed on `call` and popped on `ret`. It predicts returns perfectly for well-nested code. It breaks on:
- **Recursion deeper than 16–32 frames** — the stack overflows and the oldest entries are lost, so unwinding mispredicts every return until depth drops back.
- **`setjmp`/`longjmp`, exception unwinding, coroutine resume, fiber switches, and user-space context switching** — the `ret` doesn't match a `call`. Every stack switch in a fiber library (Ch. 31 §31.12) costs a burst of return mispredictions.
- **The `call`/`ret` mismatch idiom** — `push addr; ret` as a jump, or `call next; pop rax` for PC-relative addressing in old 32-bit code, both corrupt the RAS.

That last family is a strong answer to "why are C++ coroutines/fibers not free even when they avoid allocation?"

**Measuring:** `perf stat -e br_inst_retired.all_branches,br_misp_retired.all_branches,br_misp_retired.indirect_call,br_misp_retired.ret` splits mispredicts by branch kind on Intel. On ARM, `BR_MIS_PRED_RETIRED` plus `BR_INDIRECT_SPEC`.

---

## 27.11 Branch-Misprediction Recovery

The cost of a mispredict is *not* a single published constant; it's the sum of several delays and it varies with where the correct path lives.

```
cycle 0     branch fetched, BPU predicts (wrongly), fetch continues down bad path
cycle ~2    BTB/decode disagreement may cause an early re-steer (BACLEAR, ~2-10 cyc)
cycle N     branch µop executes on port 0/6; comparison resolves → MISPREDICT
cycle N+1   flush: ROB entries younger than the branch are squashed,
            rename map restored from a checkpoint (or walked back)
cycle N+2   front end redirected to correct target
cycle N+2.. refetch: L1i hit (~5 cyc) / L2 (~14) / L3 (~45) / DRAM (~250)
            re-decode (or DSB hit), re-rename, re-execute
```

**Published penalty: 15–20 cycles on Skylake-and-later Intel, ~13–19 on Zen, ~13 on Neoverse, ~15 on Apple.** At 3 GHz that's **5–7 ns**. But the *effective* penalty is larger when the correct path isn't in L1i or the DSB, and when the branch itself resolved late because it depended on a cache-missing load. A mispredicted branch whose condition depends on a DRAM load costs the DRAM latency *plus* the flush, because the machine spent that whole time on the wrong path.

### Fast recovery mechanisms

Cores checkpoint the **rename map** at branches (a limited number of checkpoints — hence the branch order buffer limit in §27.3). With a checkpoint, restore is ~1 cycle; without one, the machine must walk the ROB backwards undoing map updates, which is slower. This is why *deeply nested* branch-heavy code recovers worse than a single hot branch.

### Cost model in context

| Event | Typical cost (x86-64 server, 3 GHz) |
|---|---|
| Correctly predicted, not-taken branch | ~0 (fall-through, fused) |
| Correctly predicted, taken branch | ~0–1 cycle (may cost a fetch bubble) |
| BTB miss / front-end re-steer (BACLEAR) | 2–10 cycles |
| Branch mispredict, hot code | 15–20 cycles (~5–7 ns) |
| Branch mispredict + L2 i-fetch | ~30 cycles |
| Machine clear (memory ordering) | ~20–30 cycles |
| Machine clear (SMC / 4K aliasing assist) | 100–200+ cycles |

### The branchless tradeoff

Replacing a branch with `cmov`/`select` converts a *probabilistic* cost into a *certain* one:

```
branch cost   = p_mispredict × 18 cycles
cmov cost     = 1-2 cycles latency, but ADDS to the dependency chain
                (cmov cannot be speculated past — it waits for the condition)
```
Breakeven is around **p ≈ 5–10%**. Below that, branch. Above that, `cmov`. Because `cmov` serializes the condition into the data path, it is *worse* than a well-predicted branch: a predicted branch is free and lets the machine run ahead, while `cmov` lengthens the critical path. This nuance — "branchless is not universally faster, and it's specifically bad when the branch is predictable because it converts control dependence into data dependence" — is exactly what interviewers are probing (Ch. 42 §42.3–§42.4).

---

## 27.12 Execution Ports and Port Contention

A µop dispatches to an **execution port**, which feeds one or more functional units. Ports are the structural resource; contention for them is a hard throughput limit independent of dependencies.

### Skylake / Ice Lake port map (representative)

| Port | Units |
|---|---|
| p0 | ALU, LEA, shift, FMA/FP mul+add, vector int, **branch (secondary)**, `divide` |
| p1 | ALU, LEA, **integer multiply**, FMA/FP mul+add, vector int |
| p2, p3 | **Load** address + data (2 loads/cycle) |
| p4 | **Store data** |
| p5 | ALU, LEA, vector **shuffle**, vector int |
| p6 | ALU, shift, **primary branch** |
| p7 | Store address (simple addressing only) |

Golden Cove widens this to 12 ports (5 ALU, 3 load, 2 store-data, 2 store-address). Zen 4 has 4 integer ALUs + 3 AGUs + 4 FP pipes with a separate FP scheduler.

### Reading the map for a real loop

```asm
.L:  vmovups  ymm0, [rsi+rax]     ; p2 or p3   (load)
     vfmadd231ps ymm1, ymm0, ymm2 ; p0 or p1   (FMA)
     add      rax, 32             ; p0,p1,p5,p6
     cmp      rax, rdx            ; fused with jne
     jne      .L                  ; p6
```
Per iteration: 1 load (2/cycle available), 1 FMA (2/cycle), 1 ALU, 1 branch. **Nothing is saturated at 1 iteration/cycle**; the binding constraint here is the loop-carried FMA dependency (latency 4), so you need 4×2 = 8 accumulators (§27.4). If instead you unroll to 8 FMAs and 8 loads per iteration, the loop becomes **FMA-port-bound at 2/cycle** — the theoretical peak — and further unrolling gains nothing.

That analysis — enumerate µops, assign ports, compute per-port cycles, take the max, compare against the dependency-chain latency — is the standard whiteboard exercise. `llvm-mca` automates it:

```
$ llvm-mca -mcpu=skylake -timeline -iterations=100 loop.s
Resource pressure per iteration:
[0]  [1]  [2]  [3]  [4]  [5]  [6]  [7]
1.00 1.00 0.50 0.50  -   1.00 1.00  -
```

### Contention patterns worth knowing

- **Shuffle bottleneck.** Only p5 does vector shuffles on Intel. A SIMD kernel heavy in `pshufb`/`vpermd` is p5-bound at 1/cycle no matter how many ALUs are idle. AMD spreads shuffles across more pipes; this is a real portability-of-tuning issue.
- **Store-address on p7 only handles simple addressing** (base+disp, no index) on Skylake — a `[rax+rbx*4]` store address must go to p2/p3, competing with loads. Simplifying store addressing in a hot loop is a real micro-optimization.
- **Divide is not pipelined.** `div r64` is 30–90 cycles latency, throughput ~20–40 cycles, and it occupies a dedicated unit on p0 that blocks other p0 work. Integer division by a constant is turned into multiply+shift by the compiler; division by a *variable* on the hot path is a genuine problem (Ch. 42). FP divide is better (~11–14 cycles) but still not pipelined; `rcpps`+Newton or `-freciprocal-math` are the escapes.
- **`lea` is the ALU escape hatch** — it computes address arithmetic on p1/p5 without touching flags, which is why compilers emit it for arithmetic.

`perf stat -e uops_dispatched_port.port_0,...` gives per-port µop counts on Intel; likwid-perfctr's `PORT_USAGE` group packages this, and Intel VTune's Microarchitecture Exploration displays it as a bar chart.

---

## 27.13 Instruction Latency and Throughput

Two numbers per instruction, and confusing them is the most common analysis error.

- **Latency** — cycles until a *dependent* instruction can use the result. Matters on the critical path.
- **Reciprocal throughput** — cycles between successive *independent* instructions of that kind. Matters in a saturated loop.

| Instruction (Skylake–Golden Cove) | Latency | Recip. throughput |
|---|---|---|
| `add`, `sub`, `and`, `or`, `xor` (reg) | 1 | 0.25 |
| `lea` (2-operand) | 1 | 0.5 |
| `lea` (3-operand / scaled+disp) | 3 | 1 |
| `imul r64, r64` | 3 | 1 |
| `div r64` | 30–90 | 20–40 (not pipelined) |
| `popcnt`, `lzcnt`, `tzcnt` | 3 | 1 |
| `mov` reg,reg | 0 (eliminated) | 0.2 |
| L1-hit load | **4–5** | 0.5 (2/cycle) |
| Store (to store buffer) | — | 1 (2/cycle on newer) |
| `vaddps`/`vmulps` ymm | 4 | 0.5 |
| `vfmadd` ymm | 4 | 0.5 |
| `vdivps` ymm | 11–14 | 5–8 |
| `sqrtps` ymm | 12–18 | 6–12 |
| `vpshufb` | 1 | 1 (p5 only) |
| `lock xadd` / `lock cmpxchg` (L1, uncontended) | ~20 | ~20 |
| `mfence` | — | ~30–40 |
| `rdtsc` | ~25 | ~25 |
| `rdtscp` | ~30–35 | — |
| `cpuid` | 100–250 | serializing |
| `pause` | ~5 (pre-Skylake) / **~140 (Skylake+)** | — |

*(Figures are typical modern x86-64 server. Agner Fog's tables and uops.info are the authoritative sources; uops.info is machine-generated and more reliable. ARM: Neoverse and Apple publish optimization guides; integer ALU is 1 cycle, L1 load ~4 cycles, FP FMA latency 2–4 with 4/cycle throughput on Apple's very wide FP units.)*

### The `pause` change is a trap

`pause` went from ~5 to ~140 cycles on Skylake to make spin-wait loops back off harder. Code that spins `for (i=0;i<N;++i) _mm_pause();` calibrated on Haswell suddenly waits 28× longer. Any hand-tuned spin-then-park threshold (Ch. 24 §24.15) must be recalibrated per microarchitecture — and on ARM, the analogue is `YIELD` (nearly free, a hint) or `WFE`/`SEV` (event-based, much heavier). This asymmetry is a favorite low-latency interview detail.

### Applying the two numbers

```cpp
// Critical path: 3 imuls in series → 3 × 3 = 9 cycles
x = (a*b)*c*d;
// Same work, tree-shaped: 2 levels → 3 + 3 = 6 cycles, and 2 imuls overlap
x = (a*b)*(c*d);
```
For a loop, compute both: `max(port-bound cycles, dependency-chain cycles)` is the throughput floor. If dependency-bound, add accumulators or restructure; if port-bound, reduce µops or use wider vectors.

---

## 27.14 Data, Control, and Structural Hazards

The classical taxonomy, mapped onto what actually happens in an OoO core.

| Hazard | Definition | Modern handling | Residual cost |
|---|---|---|---|
| **RAW (data, true)** | Consumer needs producer's result | Forwarding/bypass network; scheduler wake-up | **Instruction latency** — irreducible; this is the critical path |
| **WAR (anti)** | Writer must wait for an earlier reader | **Eliminated by register renaming** (§27.6) | None |
| **WAW (output)** | Two writers to the same name | **Eliminated by renaming** | None |
| **Control** | Next PC unknown | Branch prediction + speculation | Mispredict flush, 15–20 cyc |
| **Structural** | Two µops want one unit | Scheduler arbitration; ports | Port contention (§27.12); non-pipelined units (`div`) |

### Memory hazards are the interesting ones

Register hazards are solved. **Memory** dependences are not, because addresses aren't known until computed:

- **Memory RAW (store→load)** — handled by **store-to-load forwarding** when addresses match (Ch. 29 §29.9), and by **memory disambiguation** speculation when the older store's address is unknown (Ch. 29 §29.8). Mis-speculation costs a replay/machine clear.
- **4K aliasing** — a load whose address matches an older store in bits [11:0] but differs in the page number is *predicted* to conflict, forcing a false dependency and a ~5-cycle stall (`LD_BLOCKS_PARTIAL.ADDRESS_ALIAS`). Classic in `memcpy`-like loops where src and dst are offset by an exact multiple of 4 KB.
- **Structural at the memory level** — only 2 loads + 1–2 stores per cycle; MSHRs (~10–16 fill buffers) cap outstanding L1 misses, which is the hard ceiling on memory-level parallelism (Ch. 29 §29.4).

### Bypass-network latency

The forwarding network is not uniform. Moving a value between **integer and vector domains** costs extra: `movd eax, xmm0` has 2–3 cycle latency plus a domain-crossing penalty, and on some cores an int↔FP bypass costs 1–2 extra cycles. Compilers know this; hand-written intrinsics that shuttle values across domains per iteration often lose to a pure-domain formulation. Similarly, using an integer shuffle (`pshufd`) on FP data or vice versa can incur a **bypass delay** on older Intel cores — one of the reasons `_mm_shuffle_ps` and `_mm_shuffle_epi32` both exist.

---

## 27.15 Front-End Bandwidth and Instruction-Cache Pressure

The back end can retire 6–8 µops/cycle. If the front end delivers 3, that's your IPC ceiling, and no amount of back-end tuning helps. **Front-end bound** is the top-down category for this, and in large server binaries it is frequently 20–40% of slots.

### The front-end supply chain and its limits

```
L1i (32-48 KB, 8-way)  →  32B/cycle fetch  →  predecode  →  decode 4-6 µops/cyc
              ↑                                                     ↓
        L2 (~14 cyc)                                          DSB 6-8 µops/cyc
              ↑                                                     ↓
   L3 (~45 cyc) / DRAM (~250 cyc)                         µop queue → rename
```

Sources of front-end starvation:

| Cause | Counter (Intel) | Fix |
|---|---|---|
| L1i miss | `icache_16b.ifdata_stall`, `frontend_retired.l1i_miss` | Reduce code size; PGO/BOLT hot-cold splitting; huge pages for text |
| iTLB miss | `frontend_retired.itlb_miss`, `itlb_misses.walk_active` | Huge pages for `.text` (§28.16) |
| DSB miss → MITE | `idq.mite_uops` high | 32B loop alignment, fewer µops per 32B region |
| Microcode (MSROM) | `idq.ms_uops` | Avoid `rep`-string for tiny sizes, `div`, gathers |
| Branch re-steer | `baclears.any`, `int_misc.clear_resteer_cycles` | Better layout, fewer indirect branches |
| Instruction-length changing prefix (LCP) | `ild_stall.lcp` | Avoid 16-bit immediates (`mov ax, 1234`); costs **3 cycles per occurrence** in decode |

### Why this dominates in trading systems

A tick-to-trade path executed a few thousand times per second, interleaved with logging, risk checks, and bookkeeping, has a **cold instruction cache** on every message. The hot path's code is evicted between messages by everything else the process does. The measured effect is that the first pass through the hot path runs at a fraction of steady-state speed — which is precisely why **cache warming** (Ch. 28 §28.11) exercises the *instruction* path as well as the data path, and why hot/cold splitting (Ch. 41 §41.17) and `__attribute__((hot))`/`cold` matter more here than in throughput code.

Practical measures:
- **Hot/cold splitting** — `-freorder-blocks-and-partition` (default at `-O2` in GCC with profile data) moves cold blocks to `.text.unlikely`, compacting the hot footprint.
- **BOLT** (Ch. 40 §40.11) — reorders basic blocks and functions post-link using perf data; **routinely 5–15% on large binaries** purely from I-cache and iTLB locality.
- **Huge pages for text** — `hugetext`/`madvise` on `.text` cuts iTLB misses dramatically; a 10 MB hot text region needs 2560 4K iTLB entries (impossible — iTLB is ~128–256 entries) but only 5 2 MB entries.
- **Avoid over-inlining.** Inlining trades I-cache footprint for call overhead. Past a point it's a net loss, and it's a *measurable* one; `-O2` vs `-O3` regressions on large codebases are usually this.

### Loop alignment

Intel recommends 16- or 32-byte alignment for loop entry (`-falign-loops=32`). A loop whose body straddles a 32B fetch boundary awkwardly loses fetch bandwidth. The effect is real but small (a few percent) and — critically — **unstable**: adding an unrelated function can shift alignment and change a benchmark by 5–10%. This is a major source of "mysterious" benchmark noise and a good answer to "why did my unrelated change make the hot loop slower?" (See also Ch. 43 §43.7.)

---

## 27.16 Machine Clears

A **machine clear** (Intel's term; AMD calls the family "pipeline flush/resync") is a full flush of the *entire* pipeline, not just the µops younger than a branch. It is strictly more expensive than a branch mispredict — typically **~20 to 200+ cycles** depending on the cause — because the front end must restart from a known-good architectural state and, for some causes, invalidate caches or reload state.

| Cause | Counter | Typical cost | Trigger |
|---|---|---|---|
| **Memory ordering** | `machine_clears.memory_ordering` | ~20–30 cyc | Core speculatively loaded a line out of order; another core invalidated it before retirement, violating TSO (§27.8, Ch. 29 §29.13) |
| **Self-modifying code (SMC)** | `machine_clears.smc` | 100–200+ cyc | A store hits a cache line containing in-flight code. Also triggered by *any* write to a 4 K page containing recently-executed code on some cores |
| **Memory disambiguation** | `machine_clears.disambiguation` | ~20–40 cyc | Load speculated past a store that turned out to alias (Ch. 29 §29.8) |
| **Floating-point assist** | `fp_assist.any` | **~150–300 cyc** | Denormal/subnormal input or output requiring microcode (Ch. 2 §2.7) |
| **Page-fault / TLB assist** | `machine_clears.page_fault` | varies | Access/dirty bit update requiring microcode |
| **AVX–SSE transition** | `other_assists.avx_to_sse` | ~70 cyc | Legacy SSE after AVX without `vzeroupper` |
| **`count` (all)** | `machine_clears.count` | — | Umbrella counter — start here |

### The three you will actually hit

**1. Memory-ordering clears under true sharing.** Two threads hammering the same cache line (a shared counter, a queue head) generate these constantly. The diagnostic signature is `machine_clears.memory_ordering` in the millions/sec alongside high `mem_load_l3_hit_retired.xsnp_hitm`. Fix is the same as for false sharing (Ch. 26 §26.15): separate the lines, or reduce the sharing rate.

**2. Denormal FP assists.** A subnormal value entering a computation triggers a microcode assist costing **hundreds of cycles** on Intel (AMD handles denormals in hardware on Zen with much smaller penalty). In a trading system, a price or a decayed EWMA drifting toward zero produces subnormals and a sudden, mysterious latency cliff — a spike in p99.9 with no change in code path. The fix is FTZ/DAZ:
```cpp
_MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON);        // MXCSR FTZ
_MM_SET_DENORMALS_ZERO_MODE(_MM_DENORMALS_ZERO_ON); // MXCSR DAZ
```
(`-ffast-math` sets these at startup — one of its few unambiguously good effects. Note MXCSR is per-thread and must be set on every thread.) This is a top-tier interview answer for "describe a latency spike you diagnosed."

**3. SMC clears from JIT or code patching.** Any runtime code generation, hot-patching, or even a data structure sharing a page with code will produce SMC clears. Keep generated code on its own pages, and never write data into a page containing executed code.

**Measuring:** `perf stat -e machine_clears.count,machine_clears.memory_ordering,machine_clears.smc,fp_assist.any`. toplev attributes them under `Bad_Speculation.Machine_Clears`.

---

## 27.17 Hardware Multithreading and SMT Contention

**SMT** (Intel Hyper-Threading; AMD SMT; ARM servers generally don't implement it, Apple doesn't) presents two logical CPUs per physical core, each with its own architectural state (registers, program counter, APIC ID) but **sharing every execution resource**.

| Resource | Sharing model on Intel SMT |
|---|---|
| Architectural registers, PC, RSP | **Replicated** (per-thread) |
| ROB, load buffer, store buffer | **Statically partitioned** — each thread gets *half* |
| Reservation station / scheduler | Competitively shared (some entries partitioned) |
| Physical register file | Competitively shared |
| Execution ports, ALUs, FPUs | **Competitively shared** |
| L1i, L1d, L2, TLBs, µop cache | **Competitively shared** — no partitioning |
| Branch predictor tables | Shared (some tagging) |

### The two consequences

**1. The ROB halves.** A single thread on a 512-entry ROB gets 256 when the sibling is active — even if the sibling is idle-spinning. Static partitioning means the OoO window shrinks *whether or not the sibling is doing useful work*. A thread whose performance depends on hiding memory latency (i.e. any latency-sensitive thread) loses directly.

**2. Cache capacity halves in effect.** Two threads share a 48 KB L1d and a 1–2 MB L2. A hot path whose working set just fits L1 spills when a sibling runs.

### Why HFT disables SMT

Throughput workloads gain **15–30%** from SMT (idle slots get filled). Latency workloads *lose*: your p99 becomes a function of what the sibling thread does, which you don't control. The standard low-latency configuration is:

```
# BIOS: disable Hyper-Threading entirely (preferred — no partitioning at all)
# or, at runtime, offline the siblings:
$ cat /sys/devices/system/cpu/cpu3/topology/thread_siblings_list
3,35
$ echo 0 > /sys/devices/system/cpu/cpu35/online
```
Note: **offlining a sibling at runtime does not fully undo static partitioning on all microarchitectures** — some cores only recombine the ROB when SMT is disabled in BIOS or when the sibling halts in a deep C-state. Knowing that offlining is weaker than BIOS-disabling is a strong operational detail. Verify with `lscpu -e`, and confirm the ROB recombined by measuring a memory-latency-bound microbenchmark before and after.

If you must keep SMT on, at minimum ensure the sibling of every isolated core is also isolated (`isolcpus`/`nohz_full` in Ch. 31 §31.19, Ch. 35 §35.16) so nothing is scheduled there.

**Diagnostic signature of SMT interference:** identical code, identical input, bimodal latency distribution correlated with sibling activity. `perf stat -e cycles -C <sibling>` on the sibling core, or `toplev` showing high `Backend_Bound` with no corresponding cache-miss increase.

**A subtle one:** `pause` in a spin loop (Ch. 24 §24.15) exists largely for SMT — it releases the core's resources to the sibling and avoids a memory-order violation on loop exit. On a core with SMT disabled, `pause` is purely a power/backoff hint.

---

## 27.18 Spectre-Class Mitigations

Speculative execution leaves **microarchitectural** traces (cache lines, TLB entries, predictor state) that survive architectural rollback. Spectre-class attacks make a victim speculatively access secret-dependent addresses, then recover the secret by timing the cache. This section matters in a low-latency interview because the **mitigations are expensive** and turning them off is a real, defensible engineering decision on a dedicated trading host.

### The families

| Variant | Mechanism | Mitigation | Cost |
|---|---|---|---|
| **Spectre v1** (bounds-check bypass) | Train a conditional branch, then speculate past a bounds check | `lfence` after the check; array index masking (`array_index_nospec`); Clang SLH (`-mspeculative-load-hardening`) | `lfence` ~20–40 cyc each; SLH 10–50% slowdown |
| **Spectre v2** (branch target injection) | Poison the BTB/indirect predictor from another domain | **retpoline**, or hardware IBRS/eIBRS + IBPB + STIBP | Retpoline: every indirect call becomes a `call`/`ret` trampoline that also **corrupts the RSB**; 5–30% on indirect-heavy code |
| **Meltdown** (v3) | Speculative read of kernel memory across the user/kernel boundary | **KPTI** — separate page tables for user and kernel | **~5–30% syscall overhead**; worst on syscall-heavy code; mostly removed by PCID |
| **MDS / RIDL / Fallout / TAA** | Leak from internal buffers (LFB, store buffer, load port) | `VERW` buffer clear on every kernel exit / context switch; **SMT must be disabled** for full protection | VERW ~50–100 cyc per transition |
| **L1TF** | L1 data leak via bad PTEs | L1D flush on VM entry | Heavy in virtualized environments |
| **Retbleed / Inception / BHI** | RSB and branch-history poisoning | Extra RSB stuffing, BHB clearing | Additional per-switch cost |
| **Downfall (GDS)** | AVX gather leaks | Microcode; **gather instructions slowed substantially** | Large regression for gather-heavy SIMD |

### The cost picture

The aggregate effect of full mitigations on a syscall/context-switch-heavy workload has been measured at **10–40% throughput loss**; on pure user-space compute with few indirect calls it can be under 2%. The variance is entirely about how often you cross a protection boundary and how many indirect branches you execute.

```
# What is actually enabled:
$ grep . /sys/devices/system/cpu/vulnerabilities/*
.../meltdown:Mitigation: PTI
.../spectre_v2:Mitigation: Retpolines, IBPB: conditional, ...
.../mds:Mitigation: Clear CPU buffers; SMT vulnerable

# Turning them off (dedicated, physically-secured, single-tenant host only):
mitigations=off              # kernel cmdline; disables the lot
nopti spectre_v2=off spec_store_bypass_disable=off l1tf=off mds=off tsx_async_abort=off
```

### The interview position

`mitigations=off` is standard practice on isolated, single-tenant, colocated trading hosts running only trusted code, and it is one of the larger single-flag latency wins available (**particularly on syscall-heavy paths — often 10–25% of syscall cost**). The correct answer states the threat model explicitly: the mitigations defend against *untrusted code running on the same machine*. If nothing untrusted ever executes there — no JIT, no browser, no user shells, no containers from elsewhere, no VMs — the risk is accepted deliberately, documented, and paired with strict host access control. Saying "turn it off, it's faster" without the threat-model sentence is the wrong answer; refusing to consider it is also the wrong answer.

Two implementation details worth having: **retpoline degrades the RSB** (§27.10), so return-heavy code suffers extra mispredicts beyond the indirect-call cost, and **eIBRS** (enhanced IBRS, Ice Lake+) is a hardware mitigation that is materially cheaper than retpoline — so newer hardware makes leaving v2 mitigation on much more palatable.

---

## Key Interview Questions

1. **Why do modern CPUs have 15–20 pipeline stages instead of 5?** — Shorter per-stage work permits higher clock; the price is a 15–20-cycle branch-mispredict flush.
2. **What limits IPC on a 6-wide core to 1–2 in real code?** — RAW dependency chains, branch mispredicts, and memory stalls; width harvests parallelism but doesn't create it.
3. **What does register renaming actually eliminate?** — WAR and WAW hazards only. RAW is irreducible, so the critical path is unchanged.
4. **Why is `xor eax,eax` preferred over `mov eax,0`?** — Shorter encoding and it's a recognized zeroing idiom that breaks the dependence on the old value at rename, costing zero cycles and no port.
5. **Difference between the ROB and the reservation station?** — ROB holds every in-flight µop in program order for in-order retirement; the RS holds only µops waiting on operands/ports and frees on dispatch.
6. **Why is a linked-list traversal slow even on an 8-wide OoO core?** — Loop-carried RAW through memory: each `next` load depends on the previous, so throughput is one iteration per cache-miss latency; there's no MLP to harvest.
7. **How many accumulators do you need to saturate FP addition?** — latency × throughput = 4 × 2 = 8. The general rule applies to any reduction.
8. **What is the µop cache and how do you tell you're missing it?** — Decoded-µop cache bypassing the expensive x86 length-decode; high `idq.mite_uops` vs `idq.dsb_uops`. Fixes: smaller loop bodies, 32B alignment, less unrolling.
9. **Why does over-unrolling sometimes slow a loop down?** — It can push the body out of the DSB into legacy decode, and it inflates I-cache footprint.
10. **What is the effective cost of a branch mispredict?** — ~15–20 cycles (5–7 ns) if the correct path is hot; much more if it must be refetched from L2/L3, plus the time already wasted waiting for a slow-resolving condition.
11. **When is `cmov` worse than a branch?** — When the branch is predictable: `cmov` converts a control dependence (free when predicted) into a data dependence on the critical path. Breakeven around 5–10% misprediction.
12. **Why does virtual dispatch hurt the hot path?** — Not the extra load (an L1 hit, usually hidden), but indirect-branch misprediction at a polymorphic call site: a full ~17–20-cycle flush.
13. **What is the return stack buffer and what breaks it?** — A 16–32-entry LIFO predicting `ret`; broken by deep recursion, `longjmp`, exception unwinding, coroutine/fiber stack switches, and retpoline.
14. **What is a machine clear and how does it differ from a mispredict?** — A full-pipeline flush from causes other than branch direction (memory ordering, SMC, FP assist, disambiguation); 20–300 cycles versus ~18.
15. **A latency spike appears with no code-path change — what would you check first?** — Denormal FP assists (`fp_assist.any`, ~150–300 cycles each); fix with FTZ/DAZ in MXCSR, per thread.
16. **Why do HFT shops disable SMT?** — ROB, load buffer, and store buffer are *statically partitioned* (halved) and caches are competitively shared, so p99 becomes a function of the sibling's behavior. Prefer BIOS-disable over runtime offlining.
17. **Why did `pause` get slower?** — Skylake raised it from ~5 to ~140 cycles to force harder spin backoff; hand-calibrated spin loops must be retuned per microarchitecture. ARM's `YIELD` is not equivalent.
18. **How does a strongly-ordered x86 core still execute loads out of order?** — It speculates and detects: if a snoop invalidates a speculatively-read line before retirement, it takes a memory-ordering machine clear.
19. **Is `mitigations=off` acceptable?** — On a single-tenant, physically-secured host running only trusted code, yes, deliberately and documented; the mitigations defend against co-resident untrusted code, and disabling them recovers 10–25% of syscall cost.
20. **How do you decide whether a loop is latency-bound or throughput-bound?** — Enumerate µops and ports for the cycle floor, compute the loop-carried dependency-chain latency, and take the max; `llvm-mca -timeline` does both.

---

## Common Traps

- **Confusing latency with reciprocal throughput** — a 4-cycle-latency FMA at 0.5 recip. throughput runs 8 independent FMAs in 4 cycles, not 32.
- **Assuming instruction count equals µop count** — micro/macro-fusion and microcoded instructions break the mapping; measure fused- and unfused-domain separately.
- **Expecting the compiler to add FP accumulators** — it won't without `-ffast-math`, because FP addition isn't associative.
- **Believing `[[likely]]` programs the branch predictor** — it only affects code layout and optimization; only PGO supplies real frequencies.
- **Measuring branch misses with `perf record -e branch-misses` without `:pp`** — skid makes the attribution point at the wrong instruction.
- **Over-unrolling out of the µop cache** and losing more than the unroll gained.
- **Ignoring 16-bit immediates** — LCP stalls cost 3 cycles per decode.
- **Partial-register writes** (`mov al, ...`) creating false dependences; use `movzx`.
- **Mixing legacy SSE and AVX without `vzeroupper`** — transition penalties or persistent false dependences.
- **Hand-tuned spin loops with fixed `pause` counts** — the instruction's cost changed 28× across generations.
- **Deep recursion or fiber switching** silently destroying RSB accuracy.
- **Writing data into a page that also contains executed code** — SMC machine clears, 100–200 cycles each.
- **Subnormals on the hot path** — 150–300-cycle FP assists on Intel, invisible in code review; set FTZ/DAZ *per thread*.
- **Assuming offlining an SMT sibling fully restores the ROB** — on several microarchitectures only a BIOS disable un-partitions it.
- **Benchmarking with SMT enabled and an uncontrolled sibling** — bimodal results.
- **`div` by a runtime variable on the hot path** — 30–90 cycles, not pipelined, blocks port 0.
- **Assuming code alignment doesn't matter** — a 32B boundary shift from an unrelated edit can move a benchmark 5–10%.
- **Treating `mitigations=off` as free** — it is a threat-model decision, not a tuning flag.

---

## Compact Recall Summary

**Pipeline.** 15–20 stages; in-order front end feeds an out-of-order back end that retires in order. Retire width 4–8. Mispredict flush = pipeline depth ≈ 15–20 cycles ≈ 5–7 ns. Real IPC 1–3; the binding constraint is usually rename/allocate width (4–8 µops/cycle).

**OoO machinery.** ROB (224–512) holds all in-flight µops in program order and enables precise exceptions, rollback, and retirement; the RS (97–205) holds only operand-waiting µops and frees at dispatch. Renaming (280+ physical registers) removes WAR/WAW entirely and enables move elimination and zeroing idioms; RAW remains and *is* the critical path. Exhaustion order in practice: load/store buffers and RS before ROB.

**Front end.** Fetch 32 B/cycle → DSB (1.5–4K µops, 6–8/cycle) or legacy decode (4–6/cycle) or LSD. DSB indexes by 32 B regions with an 18-µop cap; overflow, microcode, and bad alignment push you to MITE. Front-end-bound is 20–40% of slots in large binaries; fixes are BOLT/PGO layout, hot-cold splitting, huge pages for `.text`, and less inlining.

**Prediction.** TAGE-family direction predictors reach 95–99.5%; BTB (1K L1 / 12K L2) supplies targets at fetch; RSB (16–32, LIFO) predicts returns and is destroyed by deep recursion, unwinding, fibers, and retpoline. Data-dependent random branches are unpredictable by construction — that's the sorted-array benchmark. Polymorphic indirect calls are the real cost of virtual dispatch.

**Ports and cost.** Enumerate µops → assign ports → per-port cycles → take the max, then compare with the loop-carried latency chain; `llvm-mca` automates it. L1 load latency 4–5; `imul` 3; `div` 30–90 unpipelined; `lock` RMW ~20 uncontended; `pause` ~140 on Skylake+. Accumulators needed = latency × throughput.

**Flushes.** Branch mispredict flushes younger µops (~18 cyc). A **machine clear** flushes everything: memory-ordering (~20–30), disambiguation (~20–40), SMC (100–200+), FP denormal assist (150–300). Denormals plus FTZ/DAZ is the classic unexplained-p99 story.

**SMT.** Registers replicated; **ROB and load/store buffers statically partitioned (halved)**; ports, caches, TLBs, and predictors competitively shared. Throughput +15–30%, tail latency worse and non-deterministic — hence BIOS-disable on trading hosts, and note that runtime offlining may not un-partition.

**Speculation security.** Spectre-class attacks read microarchitectural residue that survives architectural rollback. Retpoline (v2) also wrecks the RSB; KPTI (Meltdown) taxes syscalls 5–30%; MDS mitigation requires SMT off. `mitigations=off` recovers a large fraction on syscall-heavy paths and is defensible **only** with an explicit single-tenant, trusted-code-only threat model.
