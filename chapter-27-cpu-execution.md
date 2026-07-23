# Chapter 27 — CPU Execution

**Why this matters.** Every latency claim later in this book bottoms out in one question: what stopped the core from retiring instructions this cycle? A modern core is a speculative dataflow machine that presents a sequential-ISA interface. If you can decide whether a piece of hot code is limited by its dependency chain, by execution-port capacity, by the front end's ability to supply instructions, or by memory, you can predict which changes will help before you make them — and you can say why a change that "should" have helped did not. This chapter builds that diagnostic model. It does not ask you to memorize a processor table.

**90-second screen.**

Five facts:

1. When operands arrive from the expected cache level, a loop's steady-state floor is the maximum of its dependency, execution-resource, and front-end limits. A cache miss can dominate that model.
2. Register renaming removes false WAR and WAW dependences between architectural register names. RAW dependences—and possible memory aliases—remain.
3. Out-of-order execution overlaps latency only while independent work and tracking resources remain. A sufficiently long miss eventually fills the finite window and blocks further allocation.
4. Out-of-order cores retire in order so that exceptions and architectural state remain precise. Discarded work can still leave microarchitectural traces.
5. A mispredicted branch costs a pipeline flush *plus* whatever the machine spent running the wrong path while the condition resolved.

Two decisions:

- Given a hot loop, decide whether to shorten the dependency chain (more accumulators, restructuring), reduce µops, or fix the branch — and how you will tell which one worked.
- Decide whether to make a branch branchless, knowing that `cmov` converts a control dependence into a data dependence on the critical path.

---

## 27.1 The Cost Model for a Hot Loop — Core

Start at the conclusion, because every later section is one term in it.

For a loop whose operands arrive with the latency assumed by the model, steady-state cycles per iteration is bounded below by the largest of three quantities:

```
cycles/iteration ≥ max(
    loop-carried dependency chain latency,      // §27.4
    Σ µops per port / port issue width,          // §27.5
    µops per iteration / front-end delivery rate // §27.2
)
```

This is a lower bound, not a complete performance equation. A load's latency belongs on every dependence path that consumes it; enough independent misses can instead hit load-tracking or bandwidth limits. Front-end bubbles, recovery from bad speculation, and operating-system interference can also prevent the bound from being reached. Cache mechanisms belong to Chapter 28, NUMA and memory bandwidth to Chapter 29, and measured latency ranges to Chapter 30.

Diagnosing a loop is therefore a matter of computing all three terms and finding which one binds:

| If the binding term is | The symptom is | The fix is |
|---|---|---|
| Dependency chain | Independent work runs quickly, but the dependent form does not | Expose independent chains or change the algorithm |
| Execution capacity | A required class of operation reaches its issue limit | Reduce that work or choose a different instruction mix |
| Front-end supply | Instructions delivered per cycle below back-end width | Smaller loop body, less unrolling, better layout (Ch. 42) |
| Bad speculation | Much wrong-path work; poor branch recovery behavior | Improve predictability or evaluate a branchless form (§27.7) |

The measurement protocol and model-specific event selection belong to Chapter 43. This chapter names event *classes*—front-end starvation, bad speculation, back-end pressure—not a supposedly portable counter recipe.

Use five truth layers and do not silently slide between them:

| Layer | What it can establish | Example |
|---|---|---|
| C++ standard | Observable behavior of the abstract machine | Signed overflow has language consequences; a loop has no required instruction sequence |
| Compiler/build | Code chosen for one source, compiler, flags, and target | This build vectorized the loop and emitted a conditional select |
| ISA | Architectural registers, instructions, exceptions, and ordering | x86-64 has variable-length encodings; AArch64 instructions are fixed-width |
| Microarchitecture | How one core implements the ISA | This model renames registers, caches decoded operations, or maps an FMA to certain ports |
| Measurement | What happened on one controlled system and workload | This binary was front-end limited under this input distribution |

The standard and ISA layers are specifications. Compiler output is inspectable but can change with source, flags, version, and profile data. ROBs, schedulers, decoded-operation caches, predictors, and ports are implementation models supported to different degrees by vendor documentation and experiment. Nothing in either ISA requires those exact structures. A counter observation is evidence about a run, not a new architectural guarantee.

This distinction prevents common category errors. `[[likely]]` is a C++ hint to the implementation; it is not an instruction that sets predictor state. A source-level `if` need not become a branch. An x86 `cmov` has architectural semantics, while its latency and port use belong to a CPU model. A benchmark result can falsify a cost model for its setup without establishing a universal replacement rule.

---

## 27.2 The Front End: Fetch, Decode, and the µop Cache — Core

Conceptually, the front end predicts the next fetch address, fetches instruction bytes, finds boundaries, decodes instructions, and supplies internal operations to the back end. Implementations overlap these stages aggressively, but they preserve program order at the handoff into rename. When supply is the bottleneck, idle execution units cannot compensate.

```
        ┌──────────── FRONT END (in-order) ────────────┐
BPU ─► L1i fetch ─► predecode ─► decode ──┐
        │                                 ├─► µop queue ─►
        └──────► µop cache (DSB) ─────────┘
                        (bypasses fetch+decode)
```

That x86-flavored sketch is only the supply half of the familiar **fetch → decode → execute** cycle. A fuller conceptual pipeline is:

```
predict/fetch → decode → rename/allocate → schedule → execute → retire
                              ↑             |
                              └── operands ──┘
```

Pipelining overlaps different instructions in different stages. **Superscalar** means a core may process more than one instruction or internal operation in a stage during a cycle. **Out of order** means ready younger work may execute while older work waits. Neither term means architectural results become unordered: retirement restores the sequential interface, subject to the ISA's memory model. Pipeline depth and width affect capacity and recovery, but they do not by themselves predict program speed. A wide back end starved by fetch, a deep pipeline fed an unpredictable branch, and a large window containing one serial dependence can all retire slowly for different reasons.

Three things make a front end interesting:

**Instruction representation.** x86-64 has variable-length instructions, while AArch64 instructions have a fixed width. That ISA difference changes boundary finding and decode, but it does not determine a core's total front-end width. Many high-performance cores cache or queue decoded work; the presence, organization, and terminology of such structures are microarchitecture facts.

**Instructions are not µops.** An x86 instruction decodes into one or more µops, and two fusion mechanisms reduce the count the machine pays for:

- *Macro-fusion* can combine a compare-like instruction and a following conditional branch. Eligible pairs and boundary restrictions differ by core.
- *Micro-fusion* can represent some memory-plus-ALU instructions compactly in part of the pipeline and split their work later.

Consequently, “instructions per cycle” and even “µops per cycle” are ambiguous unless the counting point is named. Use the target vendor's event definitions when comparing allocation, execution, and retirement. Fusion is neither a C++ nor an x86-64 guarantee.

**Decoded-work caches and loop delivery.** A decoded-operation cache can bypass some fetch-boundary and decode work on a hit. Its capacity, indexing, and alignment constraints are model-specific. The transferable consequences are:

- A small change in alignment or loop size can change where decoded work is delivered from.
- Complex instructions may use a separate sequencer rather than the ordinary decode path.
- More inlining or unrolling can cross a capacity boundary and make the front end slower.

Some cores also replay very small loops from a dedicated structure or queue. Firmware can change whether such a facility is enabled, so code must not depend on it.

Front-end starvation has a small set of causes:

| Cause | Mechanism |
|---|---|
| Instruction-fetch miss | Needed instruction bytes are not available from the closest instruction cache |
| Instruction-TLB miss | Address translation for the code is not ready (Ch. 32) |
| Decode or decoded-cache limit | The selected delivery path cannot supply enough internal operations |
| Complex-instruction sequencing | A multi-operation instruction monopolizes or uses a special path |
| Redirect | Prediction supplied the wrong direction or target (§27.6) |

A latency-sensitive path may execute intermittently among logging, risk checks, and bookkeeping, so its code is not guaranteed to remain resident in the closest instruction structures. That first-pass behavior can differ from a tight-loop benchmark. The countermeasures—hot/cold splitting, post-link layout, and restraint about inlining—belong to Chapter 42, with compiler mechanisms in Chapter 40 and binary mechanics in Chapter 41. Chapter 28 owns cache organization. The point here is only that the back end cannot execute work the front end has not supplied.

---

## 27.3 Dependencies, Renaming, and the OoO Window — Core

Before naming structures, name the hazards:

| Hazard | Meaning | Typical handling |
|---|---|---|
| RAW, read after write | A consumer needs a producer's result | Wait; this is a true dependence |
| WAR, write after read | Reusing a register name appears to constrain a later write | Rename the destination |
| WAW, write after write | Reusing a register name appears to order two independent results | Give each result a physical destination |
| Control | The next instruction address is unresolved | Predict and recover if wrong |
| Structural | Ready operations need the same finite resource | Arbitrate; throughput is limited |

Register renaming eliminates WAR and WAW hazards caused by *architectural register names*. It does not remove true RAW edges, and it does not prove that two memory addresses do not alias. Memory disambiguation is separate speculation.

**Register renaming** maps architectural names onto a larger set of physical destinations at allocation. The exact register counts are ISA-version and implementation facts; the useful idea is that source code and machine code can reuse a name without serializing unrelated values.

```asm
        ; architectural                    ; after renaming
1  mov  rax, [rdi]                         p37 ← [rdi]
2  add  rax, 5                             p38 ← p37 + 5
3  mov  [rsi], rax                         [rsi] ← p38
4  mov  rax, [rdx]      ← WAW+WAR on rax   p52 ← [rdx]   ← independent of 1–3
5  add  rax, 7                             p53 ← p52 + 7
```

Compiled x86-64 code necessarily reuses a finite set of architectural register names. Register renaming lets an implementation recover ILP that those repeated names would otherwise obscure; the amount recovered is a property of the generated instruction stream and the named core.

Some implementations also recognize dependency-breaking or eliminated operations during rename:

- *Zeroing idioms* — `xor eax, eax`, `sub eax, eax`, `pxor xmm0, xmm0` — are recognized, break the dependence on the old value, and allocate a zeroed physical register. That dependency-breaking property, not just the shorter encoding, is why `xor eax, eax` is preferred to `mov eax, 0`.
- *Move elimination* can implement a register-to-register move by changing a mapping rather than executing a data-copy operation. Which moves qualify varies by core.

Partial-register writes illustrate the boundary between ISA semantics and implementation. Under x86-64 semantics, `mov al, [rdi]` preserves the other bits of `rax`, so a later whole-register read needs both old and new portions. A compiler can often use `movzx eax, byte [rdi]` when zero extension is acceptable; a 32-bit destination write defines the full 64-bit register. Whether a particular core inserts a merge operation or avoids the penalty is microarchitecture-specific.

The renamed stream enters a finite **out-of-order window**. A common explanatory model has a **reorder buffer (ROB)** tracking in-flight work in program order and one or more **schedulers**—described as reservation stations in some models—holding work until operands and execution resources are ready. Real cores may distribute or combine these structures.

| | Reorder buffer | Scheduler |
|---|---|---|
| Holds | Every in-flight µop, program order | µops waiting on operands or a port |
| Purpose | In-order retirement, precise exceptions, rollback | Wake-up and select: dispatch ready µops |
| Entry freed at | Retirement | Dispatch |
| Ordering | Circular, strictly program order | Unordered, content-addressed |

In this model, an operation is tracked until retirement. A dispatched load may no longer occupy a scheduler entry while its dependent operations remain waiting. Miss-heavy code can instead exhaust load-tracking entries, register resources, or the general in-flight window. Which resource binds is a measurement question for a named core.

This gives a useful limit on out-of-order execution. In a ROB-based explanatory model, the ROB bounds the broad window, while other queues may bind sooner. If a load misses for `L` cycles and the core allocates `W` tracked operations per cycle, ideal coverage is no greater than roughly `ROB_size / W` cycles:

```
window coverage (cycles) ≈ ROB entries / allocation width
```

For example, a window with a few hundred tracking entries and an allocation rate of several operations per cycle covers only tens of ideal allocation cycles. Those are deliberately orders of magnitude rather than a processor specification. Prefetching and memory-level parallelism matter because they start work earlier or overlap independent misses (Chs. 28–29), but they remain bounded by the machine's tracking capacity.

**In-order retirement supports precise architectural state.** If an operation faults, older instructions may complete while younger architectural effects must appear not to have happened. Branch recovery and other pipeline clears reuse related checkpoint-and-restart machinery, although implementations differ. Completed execution is not the same as retirement, and retired stores may still wait in implementation buffers before other cores observe them. Chapter 29 owns that visibility model.

---

## 27.4 Critical Paths and Instruction-Level Parallelism — Core

Instruction-level parallelism is a property of your code. The core harvests what exists; it does not create any.

The most useful representation of a loop is a directed graph: nodes are operations, edges say “this result is needed first,” and edge weights include result latency. The longest path is the **critical path**. Independent paths are instruction-level parallelism (ILP) that a superscalar core may overlap.

The distinction that often matters is *loop-carried* versus iteration-local. Iteration-local work can overlap with later iterations when independence is visible. A loop-carried edge links one iteration to the next and therefore sets a recurrence limit no matter how many unrelated operations the core can issue.

```cpp
// Loop-carried RAW through `sum`: one FP add latency per element.
double sum = 0;
for (int i = 0; i < n; ++i) sum += a[i];

// Four independent chains: now bounded by FP-add throughput, not latency.
double s0 = 0, s1 = 0, s2 = 0, s3 = 0;
for (int i = 0; i + 3 < n; i += 4) {
    s0 += a[i]; s1 += a[i+1]; s2 += a[i+2]; s3 += a[i+3];
}
// (tail handling omitted; s0+s1+s2+s3 at the end changes summation order)
```

An estimate for the number of independent chains needed to cover operation latency is:

```
chains ≈ ceiling(latency / reciprocal_throughput)
```

Insert the latency and throughput measured or documented for the exact instruction form and target. The estimate can be capped earlier by register pressure, loads, the front end, or another execution resource; it is not an instruction to create a fixed number of accumulators on every CPU.

Compilers may unroll or vectorize reductions when language semantics and optimization settings permit. Floating-point reassociation changes rounding and exceptional behavior, so strict modes constrain transformations that would create independent accumulators. Writing the structure explicitly makes the numerical decision reviewable; Chapter 2 owns the semantics and Chapter 40 the compiler controls.

Pointer chasing is the pathological case. `for (p = head; p; p = p->next)` has a loop-carried RAW *through memory*: each address depends on the previous load's result, so there is no memory-level parallelism to harvest within that chain. When each node access misses at the same cache level, each dependent miss is exposed regardless of core width. No amount of superscalar issue removes that dependence. This is a central mechanism behind the "linked list versus array" results in Chapter 21, and it is why the fix is usually a layout change, not a tuning flag.

---

## 27.5 Execution Ports and Instruction Cost — Core

A µop dispatches to an execution port feeding one or more functional units. Ports are a structural resource, and **port contention** limits throughput independently of dependences.

Two numbers describe each instruction, and confusing them is the most common analysis error:

- **Latency** — cycles until a dependent instruction can use the result. This is what enters the dependency-chain term.
- **Reciprocal throughput** — cycles between successive *independent* instructions of that kind. This is what enters the port term.

For any claimed instruction cost, record the inputs in one row rather than quoting a bare cycle count:

| Machine-code form | Producer → consumer edge | Latency (cycles) | Reciprocal throughput (cycles/instruction) | µops at named counting point | Eligible ports/units |
|---|---|---:|---:|---:|---|
| Exact opcode, operands, and widths | Exact source and destination operands | Named-core vendor value or measured value | Named-core vendor value or measured value | Named-core model/event definition | Named-core model |

That row is a **microarchitecture/model claim**, not an ISA guarantee. Attach the CPU model and stepping, source document or measurement method, and tool version. A measured row also needs frequency, dependency pattern, unroll factor, operand classes, and controls for front-end and memory effects.

If a named core documents an operation with latency `L` and reciprocal throughput `T`, a chain advances roughly once every `L` cycles while independent operations can begin roughly every `T` cycles. Completion includes pipeline fill and drain, so multiplying either figure by an instruction count is rarely a complete runtime prediction. Chapter 30 owns latency ranges; carry the method, not a memorized table.

The method, applied to a loop:

```asm
.intel_syntax noprefix
.L:  vmovups     ymm0, [rsi+rax]      # vector load
     vfmadd231ps ymm1, ymm0, ymm2      # loop-carried accumulator
     add         rax, 32               # advance by one vector
     cmp         rax, rdx              # compare for the loop branch
     jne         .L
```

This is **representative x86-64 compiler output**, not a C++ guarantee. Count a vector load, a vector FMA, induction work, and a loop branch. On a target with multiple load and FMA-capable paths, the loop-carried update of `ymm1` may bind before the port term does. Splitting the reduction into enough independent accumulators can move the bottleneck from latency to FMA throughput. At that point further unrolling cannot improve that execution limit and may increase register pressure or front-end footprint.

`llvm-mca` can estimate this analysis statically and print modeled resource pressure and a timeline:

```
$ llvm-mca -mcpu=skylake -timeline -iterations=100 loop.s
```

Treat its numbers as a model of a named microarchitecture, not as a measurement of your machine; use it to find the binding constraint, then confirm on hardware (Ch. 43).

Contention patterns worth carrying:

- **Asymmetric units.** Not every port supports every operation. A shuffle-heavy SIMD kernel can saturate a narrow subset while general ALUs sit idle; the exact mapping differs across vendors and generations.
- **Partly pipelined or iterative units.** Division is a common example: it can have both a long result latency and limited overlap between independent operations. Compilers commonly replace division by suitable compile-time constants with multiply-and-shift sequences when semantics permit.
- **Addressing modes affect port choice.** On some Intel parts the dedicated store-address port handles only simple addressing, so an indexed store address competes with loads. Simplifying addressing in a hot loop is occasionally worth real cycles.
- **Bypass paths differ.** Some instruction pairs incur extra latency when a result must cross execution domains or use a constrained forwarding path. This is a per-core instruction-pair property, not a reason to classify C++ values by their source type.

---

## 27.6 Branch Prediction and Target Prediction — Core

Direction prediction answers *taken or not taken*. Target prediction answers *where to*, and it must answer at fetch time, before the instruction has been decoded — the front end does not yet know there is a branch. So the branch-target buffer is really a cache of "there is a branch at this fetch address and it goes here."

**What is publicly known about predictor design.** Intel and AMD do not document their predictors. The public understanding comes from academic designs — the TAGE family (tagged tables indexed by geometrically increasing history lengths) and perceptron predictors — plus reverse-engineering by measurement. Vendor patents and measured behavior are consistent with TAGE-like and perceptron-like structures, and AMD has publicly described perceptron components. Treat "modern cores use TAGE" as an informed model of observed behavior, not a specification you can rely on. What you *can* rely on is the observed behavior itself:

- Long-history correlation exists: a branch correlated with something that happened tens or hundreds of branches earlier is often still predicted well.
- Fixed-trip-count loops are often highly predictable after warm-up, though exits and changing trip counts can still miss.
- Prediction resources are finite and indexed by hashed address, so two hot branches can alias and interfere destructively. Large hot-code footprints degrade prediction, which is one more reason code size matters.
- Predictor state may persist or remain shared across protection-boundary changes; cross-domain influence is one concern addressed by Spectre-class mitigations (§27.11).

What is and is not predictable:

| Pattern | Predictable | Why |
|---|---|---|
| `for (i = 0; i < 1000; ++i)` | Yes | Fixed trip count |
| `if (rare_error_case)` | Yes | Strongly biased |
| Short repeating pattern | Yes | Captured by history |
| `if (data[i] > threshold)` on random data | No | No correlation exists to learn |
| Same test on sorted data | Yes | Long runs of one outcome |
| Virtual call, one dynamic type at a time | Yes | Monomorphic target |
| Virtual call, several types interleaved randomly | No | Indirect target has no learnable pattern |

The sorted-versus-unsorted array benchmark can demonstrate this effect when the compiler actually emits the relevant branch and other data effects are controlled. Without checking the binary and memory behavior, attributing the whole difference to prediction is unjustified.

**Target prediction has three distinct failure modes**, and naming the right one is most of the diagnosis:

1. **BTB capacity.** A large hot-code footprint — a switch-driven feed handler, a template-heavy dispatch layer — overflows the target buffer. The signature is front-end re-steer cycles with a *low* misprediction rate: the direction was right, the front end just did not know where to go early enough. This is a code-size and layout problem (Ch. 42).

2. **Indirect-branch misprediction.** Virtual calls, function pointers, jump tables, PLT stubs. A monomorphic site can become highly predictable after warm-up. A polymorphic site whose targets are randomly interleaved with no learnable correlation can mispredict frequently and pay target-specific recovery costs. This is the concrete risk behind "avoid virtual dispatch on the hot path" (Ch. 55) — not merely the dependent target load, which may hit in L1 and overlap on a particular core. Devirtualization, `final`, CRTP (Ch. 6), or batching work by type so a site becomes monomorphic all attack the same thing.

3. **Return prediction failure.** Many cores predict well-nested calls and returns with a return-address structure. Its capacity and underflow/overflow behavior are undocumented or model-specific. Deep recursion, non-local control transfer, exception unwinding, some coroutine or fiber mechanisms, and unusual call/return sequences can disturb the expected nesting.

Performance-monitoring facilities often distinguish retired branch misses, indirect misses, and front-end redirects, but event names and semantics vary. Choose them from the exact processor's event list as described in Chapter 43.

**What source-level hints do and do not do.** `[[likely]]`, `[[unlikely]]`, and `__builtin_expect` do not program the hardware predictor. They influence code layout and optimization decisions — moving the cold path out of line so the common case falls through. Only profile-guided optimization supplies the compiler with real branch frequencies (Ch. 40). If a claim in a code review says an annotation "helps the branch predictor," it is wrong; if it says the annotation "improves layout so the hot path stays contiguous," it may well be right.

---

## 27.7 Misprediction Recovery and the Branchless Trade-off — Core

A mispredict is not a single published constant. It is the sum of several delays, and where the correct path lives changes the total.

```
t0        branch fetched; predictor supplies a (wrong) direction or target
t0+ε      decoder may disagree with the predictor → target-specific early re-steer
t1        branch µop executes; the condition resolves → MISPREDICT
t1+1      flush: ROB entries younger than the branch are squashed;
          the rename map is restored from a checkpoint, or walked back
t1+2      front end redirected to the correct target
t1+2…     refetch (L1i, or further out), re-decode or µop-cache hit, re-execute
```

There is no architectural branch-miss penalty. It depends on how early the branch resolves, how the rename state is restored, and whether the correct-path instructions are available. Two things can make the *effective* cost much larger than pipeline recovery alone:

- If the correct path is not in L1i or the µop cache, add the instruction-fetch latency.
- If the branch condition depended on a cache-missing load, the machine spent the entire miss on the wrong path. The mispredict cost then includes the miss.

Recovery commonly uses rename-state checkpoints or related history, but the mechanism and resource bounds are implementation details. Do not infer a universal nested-branch penalty from one core's design.

### The branchless trade-off

Replacing a branch with `cmov` or a `select` converts a probabilistic cost into a certain one:

```
branch     expected recovery component ≈ P(miss) × target-specific recovery cost
select     adds the selected value and condition to a data-dependence graph
```

An x86 `cmov` needs its condition and source operands before its result is ready, so a consumer cannot use the selected result early. A branch can let the predicted path run ahead, but a miss discards that work. A compiler's branchless lowering might use `cmov`, masks, or vector selects, with different costs.

The useful rule is qualitative: **branchless is not universally faster.** It trades variable recovery for unconditional work and data dependence. A correctly predicted branch is not literally free—it still consumes front-end and branch resources—but it can be cheaper than computing both alternatives. Chapter 42 owns the transformation choices; Chapter 43 owns the measurement.

---

## 27.8 Speculation and Machine Clears — Core

Speculation is executing work whose necessity or correctness is not yet established, plus a mechanism to undo it. Cores speculate on more than branch direction:

| Kind | Speculating that | Verified by | Recovery |
|---|---|---|---|
| Control | The predicted direction/target is right | Branch execution | Flush younger µops (§27.7) |
| Memory disambiguation | A load does not alias an older store whose address is unknown | Store address resolution | Machine clear or replay (Ch. 29) |
| Store-to-load forwarding | A load's data can come from the store buffer | Address and size match | Forwarding failure → replay |
| Load latency | The load hits L1 | Tag check | Dependent µops replayed |
| Code stability | No store is modifying in-flight code | SMC detection | Machine clear |

Correct speculation still costs real resources: energy, execution slots that an SMT sibling could have used, and possible cache or translation effects. Wrong-path loads can create persistent microarchitectural traces even when their architectural results are discarded. Such traces are central to Spectre-class attacks (§27.11), although the attack families and channels are broader than a single cache-fill mechanism.

Some implementations also execute memory operations before all older addresses or ordering checks are resolved, then detect violations and replay or clear work. This is one way a core can preserve the ISA memory model without waiting at every possible ambiguity. The architectural ordering rules belong to Chapters 25 and 29; the presence and name of a “machine clear” event are not architectural.

A **machine clear** is a broad pipeline restart triggered by an implementation-detected condition. Public event guides mention causes such as memory-order violations, self-modifying code, and disambiguation mistakes. Other exceptional slow paths are reported as assists rather than clears. Do not merge all of these into one folklore number:

| Observation | Plausible mechanism | Necessary check |
|---|---|---|
| Many replays around overlapping loads/stores | Store-to-load forwarding or alias speculation failed | Exact load/store addresses and sizes |
| Clears rise with shared-data traffic | An ordering speculation was invalidated | Model-specific clear event plus coherence evidence |
| Clears follow generated-code publication | Self-modifying-code rules forced refetch | ISA-required publication sequence and code/data page separation |
| Floating-point tail appears near zero | The target may handle subnormals slowly or take assists | Operand classes and the target's FP-assist event |

These are hypotheses, not diagnoses from a single counter. For example, a floating-point assist can be expensive without being a machine clear. Flush-to-zero modes are ISA- and environment-specific, are generally thread state, and change numerical results; Chapter 2 owns that policy. Similarly, instructions such as `pause`, timestamp reads, and fences have architectural meanings but model-specific throughput and ordering details. Chapters 24, 29, 30, and 43 are their owners.

---

## 27.9 Worked Diagnosis: Four Loops — Core

Each loop below is bound by a different term of §27.1. Work through the reasoning before reading the verdict; this is the chapter's actual skill.

```cpp
// A
float dot = 0;
for (int i = 0; i < n; ++i) dot += x[i] * y[i];

// B
for (int i = 0; i < n; ++i) out[i] = x[i] * a + b;

// C
for (int i = 0; i < n; ++i) if (key[i] > pivot) ++count;   // key[] is random

// D
for (Node* p = head; p; p = p->next) sum += p->value;      // nodes malloc'd separately
```

**A — potentially dependency-bound.** Under strict scalar evaluation, `dot` is a loop-carried FP chain; the add in iteration `i + 1` needs iteration `i`. A target compiler may unroll, vectorize, fuse multiply-add, or preserve the strict order depending on flags and observable FP semantics. Inspect the actual generated loop. If one accumulator remains and its recurrence estimate exceeds the execution-resource estimate, independent accumulators are the relevant experiment—not because a universal count is known, but because they expose ILP.

**B — execution- or bandwidth-bound.** Element results are independent; ordinary induction bookkeeping need not impose a one-element-at-a-time recurrence. The floor is the larger of the load/store execution demand and the memory bandwidth the array traffic requires. Extra reduction accumulators address no limit here. Vectorization is a candidate transformation evaluated in Chapter 42. If sustained array traffic is the limit, Chapter 29 owns the diagnosis.

**C — potentially speculation-bound.** If the compiler emits a scalar conditional branch and the random keys have no learnable correlation, outcomes approach the difficult case for direction prediction. But optimizing compilers often turn this simple count into a branchless or vector loop. Diagnose the *binary*, not the source. Compare it with `count += (key[i] > pivot)` and with realistic data. Sorted or clustered keys can make the branch highly predictable and reverse the result.

**D — memory-bound with no parallelism to harvest.** Loop-carried RAW through memory: `p->next` must arrive before the next address exists. One miss latency per node, no memory-level parallelism, no help from core width. Verdict: this is not a tuning problem. Change the layout — arena-allocate the nodes contiguously, or switch to an array-based structure (Ch. 21, Ch. 42).

The general procedure is:

1. Identify the actual hot machine-code loop and its ISA.
2. Draw loop-carried RAW edges and estimate the longest recurrence.
3. Count internal operations by execution-resource class for the named core.
4. Check whether the front end can deliver that loop body and whether branch outcomes and targets are learnable.
5. Add the memory path: required load latency, independent outstanding accesses, and bandwidth.
6. Form a hypothesis, make one change that attacks only that limit, and validate it with Chapter 43's method.

The largest computed bound is a candidate bottleneck, not a permission to skip measurement. Bounds can be close, compiler output can change, and contention can move the limit.

---

## 27.10 Simultaneous Multithreading — Role-specific

Simultaneous multithreading (SMT) lets more than one hardware thread issue work on a physical core. Product support and thread count vary. Each hardware thread has architectural state, while substantial microarchitectural capacity is shared or partitioned:

| Resource | Sharing model |
|---|---|
| Architectural registers, PC, stack pointer | Replicated per thread |
| In-flight tracking and queues | Partitioned, shared, or dynamically apportioned by implementation |
| Scheduler and physical registers | Commonly shared or partly partitioned |
| Execution ports, ALUs, FPUs | Competitively shared |
| Caches, TLBs, µop cache | Competitively shared, not partitioned |
| Branch prediction structures | Often shared in some way; tagging and partitioning vary |

Two consequences follow.

First, **a sibling can reduce effective out-of-order or execution capacity.** Static partitions, dynamic competition, or both may leave less room for one thread to hide latency.

Second, **shared front-end, translation, and cache capacity can be displaced.** Effective capacity does not necessarily halve; it depends on the two workloads and replacement behavior.

Throughput workloads can gain when the sibling uses slots that would otherwise be idle. A latency-sensitive workload can lose when its tail becomes coupled to sibling activity. Neither outcome is guaranteed. Firmware disabling and operating-system offlining can also expose different hardware behavior, so treat them as distinct configurations:

```bash
# Which logical CPUs share a physical core:
$ lscpu -e
$ cat /sys/devices/system/cpu/cpu3/topology/thread_siblings_list
3,35
# Runtime offlining:
$ echo 0 | sudo tee /sys/devices/system/cpu/cpu35/online
```

The Linux paths and CPU numbers are examples, not portable interfaces. Whether a particular part changes resource allocation when a sibling is offline is measurable; do not infer it from the logical-CPU state alone.

Making this operational, per the conditional-advice rule: the benefit is a tail-latency reduction and removal of a cross-thread coupling you cannot observe from inside the process; the cost is roughly halved logical core count and any throughput work that depended on it; the prerequisite is enough physical cores for your thread budget (Ch. 31); rollback is a firmware setting and a reboot; success is measured as a change in the latency distribution of the real workload, not in a microbenchmark.

If SMT remains enabled, account for sibling placement when isolating a core (Ch. 31, Ch. 35). Correlation between sibling activity and latency is evidence; a bimodal distribution alone is not.

---

## 27.11 Speculation-Security Mitigations — Role-specific

Speculative execution can leave microarchitectural traces—cache state, translation state, predictor state, or internal-buffer effects—after wrong-path instructions are architecturally discarded. Spectre-class attacks arrange a transient secret-dependent action and infer information through such a trace. Architectural rollback is therefore sufficient for correctness but not automatically for confidentiality.

| Class | Example mitigation shape | Where cost can appear |
|---|---|---|
| Bounds-check bypass | Data-dependence masking, a specified speculation barrier, compiler hardening | Hardened access sites and enlarged dependency chains |
| Branch-target injection | Indirect-branch sequences, prediction controls, history clearing | Indirect calls and protection-boundary transitions |
| Rogue or stale-data sampling | Page-table isolation, buffer overwrite/clear, scheduling restrictions | System calls, VM transitions, and SMT capacity |
| Model-specific transient flaw | Firmware, microcode, kernel, or compiler workaround | Depends on the affected instruction or boundary |

The aggregate cost depends on the processor revision, firmware, kernel, compiler, enabled mitigations, trust boundaries, system-call and VM-transition rates, and instruction mix. A percentage without that context is not transferable.

```bash
# What is actually enabled on this host:
$ grep . /sys/devices/system/cpu/vulnerabilities/*
```

That Linux status directory is useful evidence, but the filenames and status text evolve with the kernel and CPU. Use current vendor, operating-system, and cloud guidance for the actual platform.

Changing mitigation policy is a security decision, not a local code optimization. The prerequisite is an explicit threat model covering untrusted local code, JITs, containers, VMs, operators, and future workload changes. The benefit hypothesis must be measured on the real transition and branch mix. Rollback must be documented and tested. This chapter intentionally does not prescribe a disable flag.

---

## 27.12 Microarchitecture Reference — Reference

Skippable on a first pass. This section is a checklist for constructing a model for one named CPU, not a table of values to carry between machines.

**Identify the target precisely.** Record the CPU model and stepping, enabled ISA features, frequency policy, SMT state, firmware or microcode revision, compiler version, target flags, and operating-system mitigation state. “x86-64” or “ARM” is not enough. Hybrid processors may contain two different core microarchitectures in one package.

**Use evidence in this order.**

1. The C++ standard defines observable language behavior, not instructions or cycles.
2. Compiler output establishes the instruction sequence for one build. Optimization reports explain some transformations but are not hardware measurements.
3. The ISA manual defines instruction semantics, exceptions, and architectural ordering.
4. The CPU vendor's optimization and performance-monitoring manuals describe the named implementation, sometimes only approximately.
5. Instruction-characterization projects and static analyzers fill gaps with measured or modeled latency, throughput, fusion, and port data.
6. Chapter 43's on-target experiment decides whether the model explains the workload.

**Collect only the inputs the hypothesis needs.** For a recurrence question, collect latency for the exact producer-to-consumer instruction forms. For throughput, collect decoded-operation count and execution-resource mapping. For window coverage, collect the relevant in-flight resource and allocation rate. For a branch question, measure outcomes, targets, and recovery behavior. For a memory question, stop here and use Chapters 28–30.

**Qualify special instructions.** `pause`/`yield`-like hints, timestamp reads, serializing instructions, fences, locked operations, gathers, division, and assists have particularly variable costs or ordering properties. Separate their ISA semantics from the throughput of one implementation. Do not use a timestamp instruction as a measurement recipe merely because it appears in a latency table; Chapter 43 supplies the required ordering and controls.

**Check generated assembly without worshipping it.** These two C++ functions express different dependence graphs:

```cpp
#include <cstddef>
#include <cstdint>

std::uint64_t serial_hash(const std::uint32_t* p, std::size_t n) {
    std::uint64_t h = 0;
    for (std::size_t i = 0; i != n; ++i)
        h = h * 33 + p[i];
    return h;
}

void scale_add(float* out, const float* in, std::size_t n,
               float scale, float bias) {
    for (std::size_t i = 0; i != n; ++i)
        out[i] = in[i] * scale + bias;
}
```

`serial_hash` has a required loop-carried hash value. `scale_add` has independent element results, though its load/store traffic and possible aliasing still constrain transformation. An optimizer may vectorize the second function only after it proves or versions alias conditions. That distinction follows from the source semantics and compiler proof; the chosen vector width and instructions are build facts; their port mappings are CPU facts.

The portable lesson is the classification, not any width or timing: front-end delivery, true dependence, finite scheduling window, execution-resource contention, branch recovery, or memory.

---

## 27.13 Recall and Practice — Core

**Recall card.**

1. With an explicit operand-residency assumption, cycles per iteration is bounded by the largest dependency, execution-resource, and front-end term; memory and recovery can dominate.
2. Register renaming removes WAR and WAW hazards caused by architectural register names. RAW and possible memory aliases survive.
3. A finite out-of-order window overlaps independent work; in-order retirement preserves precise architectural state.
4. Independent chains needed to cover latency are estimated by `ceiling(latency / reciprocal throughput)`, until some other resource binds.
5. Latency and reciprocal throughput are different numbers; using one where the other belongs is the most common analysis error.
6. `[[likely]]` and compiler expectation hints do not program predictor state. Profile-guided optimization can give the compiler measured training frequencies for layout and transformation decisions.
7. Polymorphic dispatch can cost little when its target is predictable and much more when target history is unlearnable; inspect the binary before blaming source-level virtuality.
8. Machine clears, replays, and assists are different implementation events. Use the exact event guide and corroborating evidence before assigning a cause.

**Questions.**

1. Why does a wider core not speed up a pointer-chasing loop?
2. What exactly does register renaming eliminate, and what does it leave untouched?
3. Distinguish the reorder buffer from the scheduler by what each holds, what each is for, and when each entry is freed.
4. Explain what `window entries / allocation rate` estimates, and give two reasons it is not a guarantee of hidden memory latency.
5. Given a loop body's µop and port assignment plus its loop-carried chain, state the cycles-per-iteration floor and which term binds.
6. Under what conditions is a branchless rewrite slower than the branch it replaced? Give the mechanism, not just the breakeven number.
7. Why can a strongly-ordered x86 core execute loads out of order, and what does it do when that turns out to have been observable?
8. Name three control transfers that can challenge return prediction, and explain what each has in common.
9. A service shows a sudden p99.9 latency increase with no code change and no increase in cache misses. Give two microarchitectural causes consistent with that signature and the counter you would check for each.
10. Why does adding unrolling sometimes make a loop slower on x86, and what would confirm that explanation?

**Applied exercise (calculation).** Take this loop, compiled for a target you can identify precisely:

```cpp
for (int i = 0; i < n; ++i)
    hash = hash * 31 + data[i];
```

(a) Identify the loop-carried dependency chain in the generated assembly. (b) Using data for that exact core, estimate its recurrence and execution-resource bounds. (c) Explain whether the front end or memory could plausibly bind first. (d) Propose a restructuring only if it preserves the specified hash result; show the algebraic condition it relies on. (e) Predict the direction and rough limit of improvement, then use Chapter 43 to explain any gap.

**Puzzle: the obvious optimization is wrong.** A colleague profiles the order-book update path, finds a hot conditional that selects between two price levels, and replaces it with a branchless `cmov` formulation. The microbenchmark — driven by a randomly generated book — improves by 30%. In production the change is neutral at the median and *worse* at p99. Explain the mechanism: what property does real order-book traffic have that the random benchmark does not, and what does `cmov` do to the dependency chain on every iteration, including the ones the branch predictor would have gotten right? Then state what the benchmark should have been driven with, and what measurement would have exposed the problem before deployment.

**Prerequisites for the next chapter.** Chapter 28 assumes you can state why a dependent load's latency lands directly on the critical path (§27.4), and what "the ROB drained and allocation stalled" means (§27.3). It will supply the cache latencies this chapter deliberately did not quote.
