# Chapter 58 — Native Debugging

Debugging is the conversion of evidence into a causal explanation.

A stack trace is evidence, not a root cause. A crash inside an allocator does not prove an allocator defect. A thread waiting in a mutex does not prove deadlock. A bug that disappears at `-O0` does not prove an optimizer defect. Each observation narrows hypotheses only within the guarantees of the operating system, compiler, ABI, debugger, binary, and captured artifact.

This chapter develops one workflow:

> preserve evidence → classify failure → inspect core/live state → reconstruct chronology → identify cause → reproduce and verify

Chapter 44 owns installation and tool catalogs. Chapter 57 owns test strategy, sanitizers as test configurations, and deterministic fault injection. Chapter 59 owns production metrics, logs, traces, watchdog signals, and flight recorders. Here those artifacts are inputs to native diagnosis.

## The 90-second version

When an incident begins:

1. Stop changing the evidence. Preserve the exact executable, libraries, debug files, core/minidump, build identity, configuration, input, and production timeline.
2. Classify the symptom: crash/assert, wrong result, delayed corruption, blocked hang/deadlock, CPU spin/livelock, resource exhaustion, or timing-sensitive race.
3. Verify artifact identity before trusting symbols.
4. For a crash, start with signal/exception, fault address, program counter, stack pointer, mappings, all thread stacks, and nearby instructions.
5. For corruption, distinguish the detection site from the earlier invalid write. Reproduce with sanitizers, allocator diagnostics, watchpoints, or record/replay.
6. For a hang, take repeated thread snapshots plus progress and CPU evidence. Build a wait-for graph; do not infer a cycle from one blocked thread.
7. For optimized code, reason from machine instructions and debug-location ranges. Source stepping and local variables may be incomplete.
8. State a mechanism that predicts the evidence. Change one causal condition, reproduce the old failure, and show the regression test fails before the fix and passes after it.

Never debug a core with a merely “similar” binary. Never restart first and hope to recover evidence later. Never call the crash location the bug location without a mechanism.

### Label the claim

Native debugging crosses several contracts:

- **OS:** core/minidump format, process attach policy, signals/exceptions, mappings, dump filters, and permissions for a named OS/kernel version.
- **Tool:** exact GDB, LLDB, sanitizer, rr, debugger-server, symbolizer, or allocator-tool version.
- **Compiler/linker:** compiler version, target, optimization/LTO/sanitizer flags, debug format/version, unwind and frame-pointer choices.
- **ABI/ISA:** register roles, calling convention, stack alignment, instruction behavior, and watchpoint resources for a named architecture/ABI.
- **Artifact:** exact executable/shared-library/debug-file identity and source revision.
- **Measured:** observed overhead, stop duration, reproduction rate, or failure distribution with environment, sample count, and statistic.

Commands in this chapter are representative. Confirm with the installed tool’s `help`, version, target, and platform documentation.

## Core: preserve, classify, explain

## 58.1 Preserve evidence before reproducing

The first restart, package upgrade, symbol-server cleanup, or “quick rebuild” can destroy the only evidence.

Preserve:

- raw core, minidump, or kernel crash record;
- exact executable and every loaded module;
- separate debug information and source tree/commit;
- build ID/UUID and full build manifest;
- compiler, linker, standard library, allocator, and flags;
- container image, filesystem mappings, environment, limits, capabilities, and working directory;
- OS/kernel and CPU architecture/features;
- process arguments, configuration, input/capture, random seed, and clocks;
- signal/exception, exit status, fault address, registers, and thread list;
- loaded-module base addresses and address-space mappings;
- production chronology from Chapter 59, including artifact loss;
- actions already taken by operators or automation.

Core files can contain secrets, credentials, order data, and other process memory. Apply incident access controls, encryption, retention, and secure transfer. Evidence preservation does not override privacy or security policy.

### Artifact identity is non-negotiable

ELF build IDs, Mach-O UUIDs, PE/PDB identities, package versions, and file hashes can pair artifacts. Their generation and security properties differ: a build ID is an identifier, not automatically a cryptographic authenticity proof.

A symbol mismatch can produce plausible function names and line numbers. Verify:

```text
core module identity == archived binary identity
binary debug link/identity == archived debug identity
debug source mapping == archived source revision
```

Do this for the executable and shared libraries. Container layers and rolling deployments make path names insufficient.

### Core dumps are snapshots, not histories

A core commonly provides selected memory mappings, thread register state, signal/exception notes, and module metadata. It does not generally provide:

- the write that corrupted memory earlier;
- syscall or lock history;
- packets not retained in memory;
- values optimized away before the snapshot;
- every mapping excluded by policy;
- open-resource contents or remote system state.

On Linux, core production can depend on resource limits, dumpability, `core_pattern`, a user-space collector such as systemd-coredump, `coredump_filter`, `MADV_DONTDUMP`, filesystem capacity, namespace/container policy, and security settings. Other OSes use different mechanisms. Test the deployed path end to end; `ulimit -c unlimited` alone is not proof.

Creating a live core with GDB `gcore` or LLDB `process save-core` can stop or perturb the target, consume memory/storage bandwidth, and omit mappings according to target/tool policy. Measure and approve this operational action before an incident.

### Check core completeness

Before interpreting an unreadable pointer as the runtime fault, ask whether its mapping was included in the dump. Compare core notes/mappings with the captured process map and dump policy. A valid pointer into an excluded huge mapping, file mapping, device region, or `MADV_DONTDUMP` area can be unavailable offline even though it was readable at runtime.

Also check collector truncation, storage exhaustion, compression/decompression errors, and collection concurrency limits. Preserve collector logs. A debugger message such as “cannot access memory” describes the artifact presented to it; only the original signal/exception and mapping/protection evidence establish what failed in the process.

Conversely, bytes present in a core need not be logically initialized or published. Memory inclusion proves availability, not C++ object lifetime or application ownership.

## 58.2 Classify the failure

Classification selects the first evidence, not the final diagnosis.

| Symptom | First questions | Strong first artifacts |
|---|---|---|
| Signal/exception/assert | Which thread, instruction, access, invariant? | Core/minidump, registers, exact modules |
| Wrong result | First divergent input/state transition? | Deterministic replay, state hashes, trace |
| Heap/stack corruption | Where detected versus where written? | Sanitizer reproducer, watchpoint, allocator report |
| Low-CPU hang | Which threads wait for which resources/events? | Repeated all-thread stacks, wait/progress evidence |
| High-CPU stall | Which threads execute; does useful progress advance? | Repeated stacks, sampling profile, progress counters |
| Timing-sensitive failure | What ordering or lifetime is unprotected? | TSan/stress/replay, synchronization trace |
| Resource exhaustion | What resource, owner, growth path, limit? | Mapping/fd/thread/heap state and chronology |
| Optimized-only failure | UB, race, layout/timing, or tool visibility? | Sanitized optimized build, disassembly, reduced input |

Signals are not diagnoses. A segmentation fault might be null dereference, use-after-free, stack overflow, bad instruction fetch, corrupted return address, protection-key failure, or hardware/OS action. An abort might come from an assertion, allocator consistency check, `std::terminate`, sanitizer, or explicit policy.

### Reproduce, reduce, observe, explain

Use a loop:

1. **Reproduce:** make the failure occur under recorded conditions.
2. **Reduce:** remove irrelevant input, threads, timing, and code without changing the mechanism.
3. **Observe:** add one discriminating check or tool.
4. **Explain:** state the causal chain and predictions.
5. **Falsify:** change a condition the explanation says is necessary.

Keep the original artifact. A reduced reproducer may expose a different bug.

Record reproduction count as a fraction over independent runs and exact conditions. “It stopped happening” is not verification for a low-probability race.

### Reconstruct chronology from partial evidence

No artifact is complete. Build a timeline whose rows distinguish observation from inference:

| Time/order | Observation | Source and clock | Confidence | Inference/hypothesis |
|---|---|---|---|---|
| A | Input record accepted | Raw capture, device clock | Captured; loss counters recorded | Trigger candidate |
| B | Invariant record changes | Flight recorder, host monotonic | Ring may have overwritten records | State first known bad |
| C | Allocator reports corruption | Core/stderr | Direct detection | Earlier write suspected |
| D | Fatal signal at PC | Kernel/core | Direct snapshot | Detection site |

Clock domains and buffering can reorder apparent times. A line emitted later may reach storage before another thread’s earlier line. A core can contain a ring entry whose producer had not yet published it under the application’s memory protocol. Chapter 59 develops event correlation; here, state the uncertainty.

Find three boundaries:

- **last known-good:** the invariant and ownership are established;
- **first known-bad:** evidence proves corruption, stall, or divergence;
- **detection:** the system finally faults or alarms.

The invalid action lies between the first two, not necessarily near detection. A watchpoint or reverse debugger is most useful after narrowing that interval and reproducing the same mechanism.

## 58.3 Symbols, DWARF, source mappings, and stacks

Native symbols have several layers:

- dynamic/static symbol tables name some addresses;
- DWARF or another debug format maps addresses to source, types, variables, inlining, and unwind information;
- unwind tables describe how to recover caller state;
- source-path mappings connect recorded build paths to archived source;
- language pretty-printers interpret standard-library/private layouts.

Stripping debug sections need not remove all symbols or unwind tables, but results depend on linker options, platform, exception/unwind configuration, and stripping command. Verify the actual artifact with versioned `readelf`, `objdump`, `llvm-dwarfdump`, `dwarfdump`, or platform equivalents.

### Split debug information

ELF deployments may use separate `.debug` files, GNU debug links, split DWARF `.dwo`/`.dwp`, package debug files, or debuginfod. Mach-O commonly uses dSYM bundles. Windows commonly uses PDBs. The exact production binary and separate information must remain paired.

`debuginfod` is an elfutils HTTP service indexed by build ID; debugger/binutils integration and authentication/signature policy depend on installed versions and deployment configuration. Do not permit incident hosts to fetch untrusted symbols silently.

### Symbolization pipeline failures

When a frame looks wrong, test the pipeline in order:

1. Is the raw address inside a captured executable mapping?
2. Was address-space relocation accounted for?
3. Does the module identity match the archived file?
4. Does the separate debug file identify that module?
5. Does its compilation unit map to the archived source?
6. Were inline frames, split units, and source-path substitutions loaded?
7. Did unwinding reach this frame reliably?

Symbolizing an absolute address from a position-independent executable without its load base can name the wrong location. Manual `addr2line` or symbolizer workflows must calculate the correct module-relative address. Debuggers normally handle relocation only when core and module metadata are adequate.

Archive link maps or symbol manifests where they help identify folded/cloned functions. LTO can change which compilation unit owns generated code. A source line is not a unique instruction address.

### What a stack frame means

A logical source call can be:

- inlined into a caller;
- tail-called without a normal caller frame;
- split into hot/cold regions;
- cloned/specialized by the optimizer;
- absent because it was eliminated;
- represented by several machine ranges.

Unwinding may use frame pointers, call-frame information, platform unwind metadata, or debugger heuristics. Handwritten assembly, JIT code, corrupt stack/registers, missing metadata, signal trampolines, and mixed runtimes can break it. Frame pointers can help sampling and postmortems, but their runtime/code-size cost and reliability benefit are target/build/workload measurements—not a universal percentage.

A backtrace is strongest where:

- module identity matches;
- unwind metadata is present and valid;
- stack memory/registers are captured;
- the stack is not corrupted;
- inline/tail-call presentation is understood.

## 58.4 GDB and LLDB fundamentals

Use a debugger offline first when possible:

```sh
# GNU/Linux examples; exact syntax/version may differ.
gdb /archive/app /secure/core
gdb -batch -ex 'thread apply all bt full' /archive/app /secure/core

# LLDB examples.
lldb -c /secure/core /archive/app
lldb /archive/app
```

A compact cross-tool card:

| Goal | GDB example | LLDB example |
|---|---|---|
| All thread stacks | `thread apply all bt` | `thread backtrace all` |
| Select thread/frame | `thread N`; `frame N` | `thread select N`; `frame select N` |
| Registers | `info registers` | `register read` |
| Memory | `x/32gx ADDRESS` | `memory read --size 8 --count 32 ADDRESS` |
| Disassembly near PC | `x/16i $pc`; `disassemble /m` | `disassemble --pc`; `disassemble --frame --mixed` |
| Modules/mappings | `info sharedlibrary`; `info proc mappings` | `image list`; `memory region --all` |
| Address lookup | `info symbol ADDRESS`; `info line *ADDRESS` | `image lookup --address ADDRESS` |
| Breakpoint | `break NAME` | `breakpoint set --name NAME` |
| Write watchpoint | `watch -location EXPR` | `watchpoint set expression -- EXPR` |

Aliases and options change. GDB and LLDB do not share all semantics. Use `help` and capture the commands in the incident record.

### Live debugging and breakpoints

Attaching can suspend one or all threads depending on debugger mode, target, and command. Even a short stop can change timing, trigger watchdogs, lose network data, or violate external protocols. Obtain operational authority and prefer a clone/staging reproduction or offline artifact.

Software breakpoints commonly replace an instruction with a trap on supported targets, but details are ISA/OS/debugger-specific. Hardware execution/data breakpoints use finite architectural resources with alignment/size/access constraints. The number and behavior are not universal.

Conditional breakpoints often stop and communicate with the debugger before evaluating or reporting, making hot-path use intrusive. Debugger commands that evaluate expressions may:

- read variables only;
- invoke the inferior’s expression evaluator;
- allocate;
- acquire locks;
- change state;
- be impossible in a core target.

Prefer raw variable/memory inspection until you understand whether a pretty-printer or expression calls target code.

### Watchpoints

A data watchpoint is powerful when an address is stable and you can reproduce the invalid write:

```text
break immediately after object initialization
record object address and lifetime generation
watch the smallest field/region supported by the target
continue
inspect the writing instruction, thread, and stack
```

GDB may use hardware or software watchpoints. Its manual notes that software watchpoints single-step and have limitations in multithreaded programs; confirm what was installed. A watchpoint on recycled memory can correctly stop on a new object’s write and still mislead if lifetime was not tracked.

### Measure debugger perturbation

Debugger actions can change scheduling, signal delivery, timeouts, cache state, and external-peer behavior. Breakpoint patching or expression evaluation may also change process memory or invoke target code. A failure that disappears under a breakpoint is timing evidence, not proof that the stopped line is causal.

Record whether the debugger uses all-stop or non-stop mode, which threads are suspended, stop duration, and which commands invoked the inferior. Choose the least intrusive method that answers the question:

```text
offline core < live snapshot < sampling/trace < watchpoint
             < cold breakpoint < hot software watchpoint
```

That ordering is qualitative. A huge live core may perturb more than a narrow trace, and a hardware watchpoint may be nearly transparent on one target. Measure in a representative environment.

Before production attachment, define authorization, downstream safety action, maximum stop duration, peer/watchdog behavior, evidence capacity, detach procedure, and consistency checks after resume. Debugging authority is not permission to mutate business state through an expression evaluator.

## 58.5 Debugging optimized code

Debug information describes optimized machine code; it cannot recreate values or control flow the compiler removed.

Expect:

- `<optimized out>` or location unavailable for some PC ranges;
- parameters in registers only at certain points;
- source lines executing in surprising order;
- one source statement mapping to several instruction ranges;
- inlined frames and synthesized values;
- tail calls altering apparent callers;
- loop unrolling/vectorization;
- constant propagation and dead-store elimination.

The exact transformation is compiler/version/target/flags dependent. Do not teach “the optimizer always keeps X in register.”

### Work from the instruction

At a crash:

1. identify the exact module-relative PC;
2. verify symbol and source mapping;
3. disassemble a bounded region with bytes;
4. identify the faulting instruction and memory operand;
5. read the registers used to form the address;
6. trace definitions backward within the function/call path;
7. inspect the object/lifetime/invariant that should make the address valid;
8. compare with compiler-generated assembly for the exact build.

Source is the specification clue; assembly is what executed.

Compiling with `-g` often places debug information in non-loaded sections and may have little direct runtime cost, but it can change artifacts, link behavior, size, build time, and sometimes code generation through related options. Measure the exact build. Keep an optimized symbolized build for production diagnosis and separate configurations for sanitizers or higher variable visibility.

If a bug changes under optimization, investigate UB, data races, lifetime, uninitialized data, timing/layout, and compiler defects in that order based on evidence—not folklore. A true compiler defect still needs a minimized valid program and exact compiler version/options.

## 58.6 Core, register, stack, and memory workflow

For a crash core:

```text
1. confirm signal/exception and faulting thread
2. confirm exact module identities and mappings
3. save all-thread stack output before interactive changes
4. record PC, SP, fault address, general registers, and signal/exception code
5. disassemble around PC
6. inspect the current and caller frames
7. inspect bounded memory around relevant addresses
8. classify access: read/write/execute, mapped/unmapped/protected
9. correlate with other threads and chronology
```

On GDB/Linux, `$_siginfo` may expose signal details when present in the core. On LLDB/platforms, stop reasons and exception data differ. A core may lack information the live debugger would have.

### ISA/ABI-specific deductions

Examples must be labeled:

- **x86-64:** `$rip` is the instruction pointer and `$rsp` the stack pointer in common debugger naming; effective addresses can combine base/index/scale/displacement.
- **AArch64:** `pc` is program counter, `sp` stack pointer, and fault information comes through OS exception/signal records; load/store addressing differs.
- calling-convention argument registers are ABI-specific and may no longer contain original arguments after instructions execute.

A small fault address can be consistent with a null base plus member offset, but it is not proof. Integer corruption can produce the same address. An instruction-fetch fault at zero can be consistent with a null function pointer, corrupted return address, or bad unwind. Follow the data.

### When unwinding fails

Check:

- whether the PC/SP and stack mapping are plausible;
- whether the current module has unwind information;
- whether the current instruction is in JIT/assembly/signal trampoline code;
- whether stack bounds/guard indicate overflow;
- whether return addresses map into executable modules;
- whether a corrupted frame begins at a specific transition.

Manual stack scanning can generate many false “return addresses.” Validate candidates against instruction boundaries/call sites, module mappings, ABI stack rules, and neighboring frames. Never present a heuristic stack as authoritative.

### Guided core session

Start by exporting, not clicking around:

```text
(gdb) set pagination off
(gdb) info files
(gdb) info sharedlibrary
(gdb) thread apply all bt full
(gdb) info registers
(gdb) p $_siginfo
(gdb) x/16i $pc-16
(gdb) info symbol $pc
(gdb) info line *$pc
```

This is a GNU/Linux/GDB-shaped example. `$pc-16` is only a display window; on a variable-length ISA, use a known symbol/range to establish instruction boundaries. `$_siginfo` exists only when the target/core supplies it.

An LLDB-shaped equivalent begins with:

```text
(lldb) image list
(lldb) memory region --all
(lldb) thread backtrace all
(lldb) register read
(lldb) disassemble --pc
(lldb) image lookup --address ADDRESS
```

Save raw addresses as well as symbols. If symbol correction later changes the stack, the raw evidence remains.

For the faulting instruction, fill out:

```text
instruction:   target-specific load/store/branch
access kind:   read / write / execute / unknown
address rule:  target-specific effective-address calculation
registers:     values from the faulting context
computed addr: ...
OS fault addr: ...
mapping:       absent / protected / guard / captured?
source claim:  exact build's mapped line/inlined call
```

If computed and reported addresses disagree, consider instruction semantics, tagged/canonical addresses, a multi-access instruction, wrong fault-thread selection, unavailable register state, or symbol error. Do not force the source hypothesis.

## 58.7 Memory corruption and heap diagnosis

The crash site is often the detection site:

```text
invalid write at time A
  → nearby object/allocator/control data corrupted
  → many successful operations
  → corrupted data consumed at time B
  → crash/assert inside unrelated code
```

Classify:

- out-of-bounds read/write;
- use-after-free or lifetime-end;
- double/invalid free;
- stack-use-after-return/scope;
- uninitialized read;
- integer overflow leading to wrong allocation/index;
- data race;
- invalid vptr/function pointer;
- allocator misuse or cross-module mismatch.

### Tools by hypothesis

| Tool/configuration | Strong for | Important limits |
|---|---|---|
| AddressSanitizer | Many spatial/lifetime violations | Layout/timing changes; not every intra-object or stale access |
| UndefinedBehaviorSanitizer | Selected UB checks | Only enabled checks; recovery/trap policy matters |
| MemorySanitizer | Uninitialized data flow | Requires instrumented dependency coverage; platform limits |
| ThreadSanitizer | Data-race reports | High perturbation; unsupported constructs/platform limits; no proof of race freedom |
| Valgrind Memcheck | Many memory errors without compiler instrumentation | Target/platform support and substantial slowdown |
| Hardware watchpoint | Exact write to small stable address | Few target resources; needs reproduction and valid lifetime |
| Guard/quarantine allocator | Converts selected overrun/UAF into earlier fault | Memory/latency perturbation and allocator-specific behavior |
| Record/replay debugger | Revisit execution chronology | Platform/version constraints and external nondeterminism |

Sanitizer combinations and support change by compiler/runtime/platform. Use the current documentation and test the exact deployed dependencies. No clean sanitizer run proves the absence of corruption or races.

### Heap evidence

Allocator consistency errors describe detected metadata/state violations under one allocator/version. Private metadata layouts and diagnostic strings are not portable APIs. Do not inspect a `pthread_mutex_t` or malloc chunk by hard-coded offsets unless the exact libc/allocator build is archived and the inference is labeled.

Useful evidence includes:

- allocation/free stacks from an instrumented reproduction;
- object lifetime generation;
- neighboring allocation sizes/owners;
- allocator/tool report before secondary failure;
- heap growth separated into live allocations, fragmentation, caches, and mappings;
- address reuse chronology.

For a corrupt field, set the watchpoint immediately after the last known-good initialization, not after corruption is already visible.

### Heap growth is not automatically a leak

Separate:

- live reachable allocations growing with real state;
- unreachable leaked allocations;
- allocator caches/arenas retaining freed memory;
- fragmentation preventing page return;
- mapped files, shared pages, stacks, JIT, and device mappings;
- copy-on-write/private-dirty growth.

On Linux, `/proc/PID/smaps` or `smaps_rollup` describes mapping accounting under that kernel interface. Glibc `malloc_info`, alternative-allocator profiles, macOS malloc stack logging, and similar facilities are allocator/OS/version-specific. Chapter 43 owns allocation profiling methodology.

Take comparable snapshots over time and reconcile:

\[
\Delta RSS \neq \Delta \text{live requested heap bytes}
\]

The difference can be allocator overhead, fragmentation, unrelated mappings, page residency, or accounting semantics. Sampling heap profilers also have uncertainty and probe effect.

For exhaustion, inspect ownership and release paths. A file-descriptor limit can result from a socket leak, delayed asynchronous close, inheritance, or a retry storm. Thread growth can exhaust stack/address space without a heap leak. The resource named by the final error is not automatically the causal defect.

## 58.8 Concurrency: deadlock, blocked hang, spin, livelock, and race

Take at least two observations separated by a declared interval. One stack is a photograph; a hang is lack of progress over time.

Record:

- per-thread CPU state and stack;
- application progress counters/sequence;
- scheduler/blocking reason where available;
- lock/queue ownership instrumentation;
- thread creation/lifetime and names;
- recent synchronization events from Chapter 59;
- whether debugger attachment changed scheduling.

### Low-CPU blocked hang

Build a wait-for graph:

```text
thread T1 → waits for resource R2 → owned/fulfilled by T2
thread T2 → waits for resource R1 → owned/fulfilled by T1
```

A directed cycle supports deadlock. Threads all waiting on a condition variable could instead mean no work, missing producer, lost notification, violated predicate protocol, shutdown, or deadlock elsewhere. Inspect predicates and the code that can make them true.

Debugger-specific inspection of native mutex owner fields is libc/version-specific and may be unavailable or misleading for C++ wrappers, adaptive locks, robust mutexes, or corrupted state. Prefer instrumented lock identity/ownership, known application wrappers, or a validated libc layout.

### High-CPU stall

High CPU can mean useful busy polling, retry storm, livelock, or an accidental infinite loop. Compare repeated PCs/stacks with progress:

- same loop, no progress, no failed-operation counter: possible spin/infinite loop;
- changing stacks, growing retries, no committed work: possible livelock;
- expected poll loop, advancing input/output: healthy for that design;
- one core busy, downstream blocked: backpressure or queue protocol.

Sampling profiles and hardware counters can localize execution but do not prove the concurrency cause. Chapter 43 owns their measurement methodology.

### Races

A data race in C++ creates undefined behavior unless the accesses are properly synchronized/atomic under the language rules. The observed symptom may be stale data, corruption, impossible control flow, or a hang that changes with optimization.

Use TSan/stress/model tests to find evidence, then explain:

- the conflicting accesses;
- object lifetime;
- happens-before relationship that is absent;
- required invariant;
- why the chosen atomic ordering or lock establishes it.

Making one field atomic can remove the reported race while leaving a multi-field invariant broken. Verification needs an adversarial test and the semantic invariant, not only a silent TSan run.

Record/replay tools such as rr can help reverse from detection to the earlier write on supported OS/architecture/kernel/CPU/tool versions. They may serialize or virtualize events and cannot capture arbitrary external systems without recorded inputs. Version-gate before planning an incident around them.

### Concurrency chronology without a perfect trace

Combine:

- lock-wrapper owner/waiter generation;
- queue head/tail and producer/consumer progress;
- scheduler or futex wait evidence;
- last completed sequence per stage;
- retry/failed-CAS counters;
- per-thread CPU-time change;
- two or more debugger/core snapshots;
- deterministic barriers that recreate the ordering.

Thread IDs are reusable; pair them with process/session and thread-lifetime generation. A core taken after a timeout handler starts can show the handler’s locks rather than the original stall. Freezing a process can also prevent lease/timeout threads from making their usual progress.

For condition variables, reason about the predicate:

```text
mutex protects predicate P
waiter:   while (!P) wait(lock)
producer: lock; change P; publish/notify under the designed protocol
```

Notification is not stored state. Correctness comes from the predicate and happens-before relationships. Whether notification occurs while holding or after releasing the mutex depends on the invariant and performance design; neither style is a universal prescription.

## 58.9 Worked crash diagnosis

This intentionally faulty C++23 reproducer has a one-element overrun:

```cpp
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

void copy_payload(std::span<const std::uint32_t> input,
                  std::span<std::uint32_t> output) {
    if (input.size() > output.size()) return;

    // BUG: i == input.size() is outside both equal-sized spans.
    for (std::size_t i = 0; i <= input.size(); ++i) {
        output[i] = input[i];
    }
}

int main() {
    const std::array<std::uint32_t, 4> input{10, 20, 30, 40};
    std::array<std::uint32_t, 4> output{};
    copy_payload(input, output);
}
```

On a Clang/GCC-style toolchain with supported runtimes:

```sh
c++ -std=c++23 -O1 -g -fno-omit-frame-pointer \
    -fsanitize=address,undefined repro.cpp -o repro-san
./repro-san
```

The exact report depends on compiler/runtime/version. A representative ASan diagnosis identifies an out-of-bounds access in `copy_payload`, the access size/direction, and the bounded object.

### Evidence to root cause

Suppose production instead crashed later in allocator code:

1. Core identity matches the archived optimized executable and allocator library.
2. Faulting stack detects invalid heap state during a later allocation.
3. This establishes detection, not the writer.
4. The production input is reduced to the four-element frame.
5. The sanitized optimized reproducer stops in `copy_payload`.
6. Disassembly/source show the loop admits `i == size`.
7. At that iteration, both `input[i]` and `output[i]` violate span preconditions.
8. Changing `<=` to `<` removes the sanitizer report.

Verification is stronger than “no crash”:

- a regression test covers empty, one, exact-capacity, and rejected-oversize inputs;
- the test fails under the faulty revision;
- ASan/UBSan pass under the fixed revision for the declared corpus;
- the production optimization level and captured input replay pass;
- output equality is checked;
- a soak/stress run reports independent run count and failures.

The root cause is the inclusive loop bound, not “malloc crashed.”

### Why a core alone may not solve it

The one-past-end access might touch mapped stack memory and continue. The later core can contain only allocator or control-data damage. Without the original input and build, the loop may be invisible.

The diagnosis combines:

- core: establishes production detection and exact build;
- raw input/replay: reintroduces the trigger;
- sanitizer: moves detection to the invalid access;
- disassembly/source: identifies the executed condition;
- boundary test: supplies a stable oracle;
- fixed production-like build: verifies the mechanism under relevant optimization.

None alone is the whole proof.

## 58.10 Worked hang and race diagnosis

At time \(t_0\), useful-progress sequence stops. Two all-thread samples at recorded later times show:

```text
T1: waits acquiring metrics_mutex inside publish_metrics()
    application evidence says T1 currently owns book_mutex

T2: waits acquiring book_mutex inside refresh_snapshot()
    application evidence says T2 currently owns metrics_mutex
```

CPU use is low, and the owner evidence comes from validated lock wrappers—not guessed libc offsets.

Wait-for graph:

```text
T1 → metrics_mutex → T2 → book_mutex → T1
```

That cycle explains the hang. Inspect all acquisition paths and find inconsistent order:

```text
publish_metrics:  book → metrics
refresh_snapshot: metrics → book
```

Fix by enforcing one order or removing nested ownership; add a deterministic two-thread test/barrier that reaches the old inversion. Verify the test deadlocks/times out on the faulty revision and completes repeatedly on the fix. A general timeout is a detector, not the synchronization fix.

### Race-shaped spin

A separate optimized-only hang shows one thread repeatedly in:

```cpp
while (!ready) {
    // no synchronization
}
```

Another thread writes the non-atomic `ready`. This is a C++ data race; debugger source stepping cannot impose a valid interpretation. TSan on a supported build reports conflicting accesses. The fix is not mechanically “make it relaxed atomic”: choose a mutex/condition variable or release/acquire publication that also makes the associated data visible. Verify both race freedom under the tool and the higher-level publication invariant.

## 58.11 Root cause and verification

A useful root-cause statement has six parts:

1. **Trigger:** input, state, or timing that activates the defect.
2. **Defect:** invalid code or missing invariant.
3. **Propagation:** how memory/state/wait relationships become wrong.
4. **Detection:** where and why the symptom appears.
5. **Contributors:** why defenses did not expose it earlier.
6. **Evidence:** artifacts and experiments supporting every link.

Example:

> When an exact-capacity payload arrived, the inclusive loop executed index `size`. The out-of-bounds access corrupted adjacent state in the production layout. A later allocator consistency check aborted. The core identified detection; replay plus ASan identified the earlier access; the boundary regression failed before and passed after changing the loop condition.

“Root cause: null pointer,” “race condition,” or “process hung” only restates a symptom category.

### Mitigation, workaround, fix, and detection

- **Mitigation:** reduce harm now—disable, isolate, roll back, restart.
- **Workaround:** avoid the trigger without correcting the defect.
- **Fix:** restore the violated invariant at its owning boundary.
- **Detection improvement:** expose recurrence earlier with context.

All may be necessary. Do not close the defect because a restart cleared damaged memory.

### Verification portfolio

Require:

- reproducer on the faulty revision;
- oracle that detects the mechanism, not only a crash;
- fixed revision passing the same test;
- boundary/property variants;
- sanitizer or race-tool run where applicable;
- production-like optimized build and input replay;
- adversarial schedule/fault injection for concurrency defects;
- soak/replay with independent run count and outcomes;
- no new invariant or performance regression under Chapter 43 methodology.

For rare failures, state what the run count can support. Zero observed failures is not zero probability. Preserve seeds, schedules, and artifacts for failing runs.

### Competing hypotheses and negative evidence

List alternatives and the observation that would distinguish them:

| Hypothesis | Predicted evidence | Discriminator |
|---|---|---|
| One-past-end access | Boundary-dependent; sanitizer/watchpoint at loop | Exact-capacity regression |
| Use-after-free | Access after lifetime end; reuse/quarantine sensitivity | Allocation/free chronology |
| Data race | Conflicting unsynchronized accesses; schedule sensitivity | TSan plus happens-before audit |
| Wrong symbols | Raw PC fails archived module/source mapping | Identity and relocation verification |
| Compiler defect | Minimized valid program fails for exact toolchain | Cross-version codegen after UB audit |

Negative evidence is scoped. “ASan found nothing” weakens only violations it could detect on exercised paths. “The pointer was non-null in the core” does not rule out ended lifetime. Keeping alternatives explicit prevents the first convenient story from becoming an unsupported root cause.

## 58.12 Crash-handler limitations

The most reliable crash evidence is often produced by the OS or an external collector, not complex code inside a damaged process.

At a fatal signal/exception:

- the allocator may be corrupt or locked;
- the dynamic loader may hold a lock;
- the current stack may be exhausted/corrupt;
- another application lock may be held;
- global invariants may already be broken;
- other threads continue or stop according to OS/handler behavior.

POSIX signal handlers may call only async-signal-safe functions. C++ library facilities are not generally promised safe there. `std::stacktrace::current()`, formatting, iostreams, allocation, symbolization, locks, and most runtime operations do not belong in a generic fatal handler.

Do not assume `backtrace()`, `backtrace_symbols_fd()`, or a third-party unwinder is safe merely because one test worked. Lazy loading, allocator use, loader locks, and implementation/version behavior matter. Prewarming reduces some risks but does not create a POSIX guarantee.

An alternate signal stack can help when the normal stack overflows, but it is per-thread state on relevant POSIX systems, needs adequate guarded storage, and does not make unsafe calls safe. Signal disposition, reentrancy, and preserving core generation require OS-specific tested design.

A minimal handler may write a fixed preallocated record through an async-signal-safe primitive to a preopened descriptor, then preserve the platform’s core/minidump path. Even this needs a fault-injection test for:

- crash inside allocator/loader;
- stack exhaustion;
- recursive signal;
- multiple threads faulting;
- full/broken output descriptor;
- collector unavailable;
- sensitive-data handling;
- correct terminating signal/exception and core creation.

The crashing process should not be solely responsible for financial or operational cleanup. External watchdog/risk behavior belongs to Chapters 56 and 59.

### `std::stacktrace`

`std::stacktrace` is a C++23 library facility, but implementation and symbolization support vary by standard library, compiler, linker, and platform. Check `__cpp_lib_stacktrace`, compile/link support, and actual output. Capturing/symbolizing can allocate and be expensive; it is useful at controlled diagnostic points, not a portable fatal-signal primitive.

## Skippable reference and incident runbook

## 58.13 Symptom-to-tool map

| Evidence needed | Candidate | Caveat |
|---|---|---|
| Offline crash state | Core/minidump + GDB/LLDB | Snapshot only; exact artifacts required |
| Earlier invalid memory access | ASan/guard allocator/watchpoint | Reproduction and perturbation |
| Uninitialized value | MSan or platform equivalent | Dependency coverage |
| Race evidence | TSan | Perturbs timing; no proof of absence |
| Reverse execution | rr/debugger recording | Version/platform/external-input limits |
| Heap ownership/growth | Allocator profiler/tool | Allocator-specific semantics |
| Wait chronology | Lock/scheduler tracing | Instrumentation and clock effects |
| CPU spin location | Sampling profile | Correlation, not root cause |
| Source/address resolution | DWARF/dSYM/PDB + build identity | Mismatch gives plausible false results |

## 58.14 Ten-minute postmortem runbook

1. Copy evidence read-only; record hashes and access.
2. Identify OS/tool/compiler/ISA/artifact versions.
3. Verify executable and every module identity.
4. Load core/minidump with matching symbols.
5. Export signal/exception, fault address, registers, mappings, and all-thread stacks.
6. Classify crash, corruption, low-CPU wait, high-CPU spin, race, or resource failure.
7. For the faulting thread, inspect PC-relative instructions and effective addresses.
8. For hangs, compare at least two samples and build a wait-for/progress model.
9. Correlate with Chapter 59 chronology without treating logs as complete.
10. Write hypotheses with predictions; choose the least perturbing discriminating test.
11. Reduce and reproduce under the appropriate sanitizer/watchpoint/replay tool.
12. Add a regression that fails before the fix; verify mechanism and production-like build.

## 58.15 Command/reference card

```text
GDB:
  thread apply all bt full
  info registers
  x/16i $pc
  disassemble /m
  info sharedlibrary
  info proc mappings
  info symbol ADDRESS
  info line *ADDRESS
  watch -location EXPR

LLDB:
  thread backtrace all
  register read
  disassemble --pc
  disassemble --frame --mixed
  image list
  memory region --all
  image lookup --address ADDRESS
  watchpoint set expression -- EXPR
```

Confirm aliases/options with the installed tool and target.

### Primary references

- GNU GDB manual: [core-file generation](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Core-File-Generation.html), [optimized code](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/Optimized-Code.html), and [watchpoints](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/Set-Watchpoints.html).
- LLVM LLDB, [GDB-to-LLDB command map](https://lldb.llvm.org/use/map.html).
- Linux `core(5)`, [core-dump controls](https://man7.org/linux/man-pages/man5/core.5.html).
- elfutils, [debuginfod](https://sourceware.org/elfutils/Debuginfod.html).
- Compiler/runtime documentation matching the exact sanitizer and standard-library version.

## Recall card

- Preserve exact cores, modules, symbols, source, configuration, input, and chronology before restarting.
- Build IDs/UUIDs identify artifacts; verify, do not trust path names.
- A core is a snapshot, not execution history.
- Classify crash, corruption, blocked hang, spin, race, or exhaustion before choosing tools.
- Verify module identity before believing a symbolic stack.
- Optimized source variables and stepping can be incomplete; disassemble from the exact PC.
- Register meaning is ISA/ABI/PC-position specific.
- The crash/detection site may be far after the corrupting write.
- Watch the smallest stable address and track object lifetime.
- Sanitizers find evidence within their coverage; clean runs prove little outside it.
- Deadlock requires a wait-for cycle, not merely waiting threads.
- High CPU is interpreted with progress, not alone.
- A race fix must restore the semantic happens-before invariant.
- Publish root cause only after a reproducer, causal mechanism, and failing-before/passing-after regression.
- Fatal handlers have severe async-safety, stack, reentrancy, and core-preservation constraints.
- `std::stacktrace`, rr, debuginfod, and debugger commands are version/platform gated.
- Chapter 59 owns production signals; Chapter 44 owns tool setup.

## Review questions

1. Why can correct-looking symbols still produce a false backtrace?
2. What evidence does a core contain, and what chronology does it normally omit?
3. Why may a local variable be unavailable in optimized code despite debug information?
4. How do you turn a faulting instruction and registers into a memory-access hypothesis?
5. Why is an allocator crash commonly a detection site rather than the invalid write?
6. What evidence distinguishes deadlock, blocked waiting, spin, and livelock?
7. Why can a hardware watchpoint mislead when object lifetime is ignored?
8. What must a valid data-race fix establish beyond making one field atomic?
9. Why is in-process stack symbolization unsafe in a generic fatal signal handler?
10. What evidence is required before calling a fix verified?

## Exercise

Use the faulty reproducer in §58.9:

1. compile optimized symbolized, ASan/UBSan, and unoptimized variants with recorded tool versions;
2. retain the sanitizer report and disassembly;
3. fix the bound and add boundary tests;
4. show the regression fails on the faulty revision and passes on the fix;
5. alter allocation/layout so the unsanitized failure moves, then explain why root cause does not;
6. produce a core or platform minidump in a controlled environment and verify exact module identities;
7. write a five-step causal explanation from invalid index to detection;
8. record independent run counts and outcomes rather than “works now.”

Then construct the two-lock inversion from §58.10 behind a test-only barrier. Capture two thread snapshots, draw the wait-for graph, and verify a single acquisition order removes the cycle.

## Puzzle

A production core shows a faulting load through address `0x20`. The source line is `return node->next->value;`, and the debugger prints `node` as non-null. Is `node->next` definitely null?

No. The debugger may be showing `node` for a different PC location range or a reconstructed/optimized value. The faulting instruction might use a register derived earlier, and `0x20` could also result from corrupted integer/address arithmetic. Disassemble the exact PC, identify its effective-address registers, inspect their values and defining instructions, then map that operation back to `node` or `node->next`. A small address supports a null-base-plus-offset hypothesis; it does not prove it.

## Common traps

- Restarting before preserving the core, exact modules, configuration, and input.
- Debugging with a locally rebuilt “same source” binary.
- Treating a build ID as cryptographic authenticity.
- Ignoring mismatched shared-library symbols.
- Shipping cores without sensitive-data controls.
- Assuming one core contains execution history.
- Treating signal name or top frame as root cause.
- Calling every wait a deadlock.
- Calling every high-CPU loop livelock.
- Taking only one thread snapshot for a hang.
- Reading private mutex/allocator fields without exact library/version layouts.
- Assuming attach or live-core capture has negligible/identical stop behavior.
- Copying GDB commands into LLDB and assuming the same semantics.
- Using a conditional breakpoint in a hot path without measuring perturbation.
- Believing a watchpoint is hardware-backed without checking.
- Watching recycled memory without lifetime generation.
- Calling pretty-printers on corrupt structures and trusting output.
- Calling functions in the inferior during diagnosis without understanding side effects.
- Expecting optimized source stepping to be chronological source execution.
- Treating `<optimized out>` as a debugger defect.
- Assuming `-g`, frame pointers, or unwind tables have universal cost/behavior.
- Applying x86 register/calling-convention deductions to another ABI.
- Treating heuristic stack scanning as an authoritative backtrace.
- Blaming `malloc`/`free` because allocator checks detected corruption.
- Assuming ASan finds races or TSan proves race freedom.
- Running MSan with incomplete instrumented dependencies and trusting noise.
- Fixing a race by changing timing or adding one relaxed atomic.
- Declaring success because a rare race did not recur once.
- Calling `std::stacktrace`, allocation, formatting, or symbolization in a fatal signal handler.
- Assuming `backtrace_symbols_fd` is portable async-signal-safe.
- Letting a custom handler suppress the OS core/minidump.
- Relying on the crashing process as the only safety actor.
- Using production observability as a substitute for native evidence—or vice versa.

## Prerequisite check

You are ready to use this chapter when you can:

- distinguish source, machine code, ABI, debug information, and unwind metadata;
- explain process memory mappings, stack/heap lifetime, and a data race;
- read a small disassembly and compute an effective address for your target ISA;
- distinguish artifact identity from file path/version label;
- draw a wait-for graph;
- state what a sanitizer can and cannot establish;
- design a regression with a causal oracle.

If any item is unfamiliar, begin with the reproducer: inspect its sanitizer report, disassembly, optimized variables, and core before diagnosing a production process.
