# Chapter 40 — Compiler Optimization

An optimizer does not make source code “faster” in the abstract. It replaces a program with another program whose permitted observable behavior is the same, then chooses instructions and layout using a target- and version-specific cost model. When an expected transformation is missing, either semantics forbid it, the compiler cannot prove its preconditions, or its model judges the transformation unprofitable.

The interview skill is therefore evidence-driven: state the language permission, identify the blocking dependence or missing fact, inspect the optimization report and generated code, and measure the deployed binary. Assembly syntax and ABI details belong to Chapter 41, CPU execution decisions to Chapter 42, and build/inspection tooling to Chapter 44.

## 90-Second Screen — Core

Retain these facts:

1. The **as-if rule** permits any transformation that preserves the observable behavior required by the C++ abstract machine. Source statement order is not an instruction schedule.
2. Undefined behavior has no required result. Optimizers may use “this execution is defined” as an assumption, which can remove checks placed after an invalid operation.
3. Optimization works through enabling chains: inlining reveals constants; constants fold branches; dead paths disappear; alias facts permit load motion and vectorization.
4. `inline` has C++ ODR/linkage semantics; it does not require call-site substitution. `always_inline`, `noinline`, and `restrict` spellings are compiler extensions.
5. Auto-vectorization needs a profitability case and a legality proof: iterations must be independent or form a recognized reduction, and possible aliasing often requires a runtime check or blocks the transform.
6. `-O2`, `-O3`, `-march`, PGO, and LTO are compiler/version/build choices, not portable semantic labels. Keep the compiler identity, flags, target ISA, profile, and workload with every claim.

Be ready to defend two decisions:

- Start from a production-like optimized build with debug information and safety checks appropriate to the deployment. Compare flag sets by correctness tests, code size, profiles, and latency distributions; do not assume a higher `-O` level wins.
- Diagnose one hot region from evidence: profile first, reduce the source, obtain missed-optimization remarks, inspect the final binary, then measure after changing one blocking mechanism.

---

## 40.1 The Semantic Permission: As-If and Undefined Behavior — Core

The **as-if rule** lets an implementation transform a program in any way so long as the observable behavior of every defined execution remains within what the standard permits. This is why a compiler can keep a local in a register, remove a temporary object, combine arithmetic, reorder independent operations, or delete a function call whose effects cannot be observed.

Observable behavior includes required interactions such as volatile accesses and library I/O, plus the ordering and values constrained by the C++ memory model for atomics. The exact list has qualifications—especially for floating-point environment access and implementation-defined volatile device semantics—but ordinary non-volatile intermediate loads and stores are not individually sacred.

```cpp
int square_plus_one(int x) {
    int temporary = x * x;
    return temporary + 1;
}
```

There need not be an object named `temporary` in the generated code. The return value is what matters for a defined call. Debugger visibility, source line mapping, and a convenient stack slot are not ordinary runtime semantics.

### Undefined behavior becomes an optimizer assumption

For an execution containing undefined behavior (UB), the C++ standard imposes no requirements. Optimizers reason in the other direction: while compiling a defined execution, operations that would already have caused UB can be assumed not to have occurred.

```cpp
int read_or_zero(const int* pointer) {
    const int value = *pointer;         // null would already be UB
    if (pointer == nullptr) return 0;   // redundant on every defined execution
    return value;
}

int checked_read(const int* pointer) {
    if (pointer == nullptr) return 0;   // check precedes dereference
    return *pointer;
}
```

The first function is intentionally wrong. An optimizer may remove its null check because reaching the check in a defined execution proves `pointer` was non-null. The fix is the second function, not disabling optimization.

Other important assumptions include:

- signed integer overflow does not occur;
- array indexing and pointer arithmetic stay within their permitted object/range rules;
- object lifetimes and alignment are valid for every access;
- two conflicting non-atomic accesses do not form a data race;
- type-based access rules are obeyed;
- an exception attempting to escape a `noexcept` function invokes termination rather than continuing into the caller.

Unsigned arithmetic is different: it wraps modulo \(2^N\), so a transformation must preserve wrapping behavior. Floating-point reassociation is also restricted under ordinary rules because changing evaluation order can change rounding, exceptions, signed zero, NaN behavior, or infinity behavior.

Do not infer “compiler bug” from a difference between `-O0` and `-O2`. First run warnings, sanitizers, differential tests, and a minimized reproducer. Sanitizers do not detect every alias, lifetime, race, or extension-contract violation, but they test the highest-probability explanation.

### Volatile and atomics are not general optimization off-switches

Accesses through volatile glvalues are observable in the ways the implementation defines, so the compiler must preserve the required accesses. `volatile` does not create inter-thread synchronization, atomicity, or a device protocol. Atomics constrain transformations according to their memory order and the C++ memory model; they do not necessarily prevent unrelated local arithmetic optimization.

Use the type required by the correctness contract. Adding `volatile` to force benchmark work to remain can change the work being measured and still does not form a sound benchmark harness; Chapter 43 owns measurement barriers.

---

## 40.2 From Source to Optimized Machine Code — Core

Modern compilers lower source through several representations. Names differ by implementation, but the model is durable:

```
C++ source
   │ parse, name/type checking, templates, constant evaluation
   ▼
front-end AST
   │ language lowering
   ▼
high-level IR ──▶ canonical scalar passes ──▶ loop/vector passes
   │                    │                           │
   │                    └─ DCE, GVN, SROA, LICM ──┘
   │ interprocedural summaries / inlining / devirtualization
   ▼
target-oriented IR
   │ instruction selection, scheduling, register allocation
   ▼
object code
   │ linker: resolution, layout, section GC, optional LTO
   ▼
executable ──▶ optional post-link rewriting
```

LLVM commonly uses LLVM IR and a lower machine IR; GCC commonly uses GIMPLE and RTL. Those are compiler implementation details, not C++ concepts. Passes interact and may repeat. For example, inlining reveals a constant argument, sparse conditional constant propagation removes a branch, dead-code elimination shrinks the caller, and the smaller result may now be profitable to inline elsewhere.

### Debug, release, and optimized builds

“Debug” and “release” have no standard meaning. They are build-system configurations that usually combine independent choices:

| Choice | Examples | Semantic or engineering effect |
|---|---|---|
| Optimization | GCC/Clang `-O0`, `-Og`, `-O2`, `-O3` | Pass bundle and cost-model posture |
| Debug information | `-g` and format/version options | Symbol/source mapping; mostly orthogonal to optimization |
| Assertions | `-DNDEBUG` | Source-level removal of standard `assert` checks |
| Sanitizers | `-fsanitize=address,undefined` and others | Instrumentation, changed layout/timing, bug detection |
| Target | `-march`, `-mcpu`, `-mtune` | Permitted ISA and/or scheduling model |
| Language/runtime policy | exceptions, RTTI, floating options | Can change semantics and ABI; not merely “speed” |

An `-O0` build is not guaranteed to map one statement to one instruction or place every variable in memory. It is designed to minimize optimization, not to define a portable code-generation model. An optimized build with debug information is often the right artifact for profiling production-like behavior, though stepping and variable inspection become less intuitive.

### Optimization levels are versioned bundles

GCC and Clang both accept familiar level names, but the enabled passes and thresholds differ by compiler and release:

| Level | Broad intent | Main trade-off to verify |
|---|---|---|
| `-O0` | Minimize optimization work | Unrepresentative memory traffic and call overhead |
| `-Og` | Preserve a useful debugging experience while applying selected passes | Compiler-specific contents |
| `-O1` | Cheap local/canonical transformations | Leaves major cross-function/loop opportunities |
| `-O2` | Broad speed optimization with controlled growth | Still compiler/version dependent |
| `-O3` | More aggressive inlining and loop transforms | Code size, register pressure, compile time |
| `-Os` / `-Oz` | Prefer smaller code with differing aggressiveness | May help or hurt hot-code locality |
| `-Ofast` | Aggressive bundle that includes semantic relaxations | Floating-point and standards-conformance changes |

`-O3` can outperform or underperform `-O2`. More unrolling and inlining may reduce branches while increasing instruction-cache footprint and spills. `-ffast-math` is a family of semantic permissions, not a universally safe speed flag. Its exact bundle is compiler/version specific; do not claim that it always configures a particular FTZ/DAZ processor state. Inspect enabled options, generated startup code, and runtime floating-point environment on the deployed toolchain.

Keep `NDEBUG` separate in your reasoning. A benchmark that changes both optimization level and assertion policy has changed two variables and perhaps the workload.

### CPU architecture and tuning flags

On GCC/Clang targets, architecture options are compiler extensions whose meanings depend on the backend:

- `-march` or target-specific `-mcpu` commonly determines which instructions the compiler may emit. A binary using an unsupported instruction can fail on an older deployment CPU.
- `-mtune` commonly changes scheduling, alignment, and cost heuristics without enabling a newer ISA.
- `-march=native` derives features from the build host. It is safe only when the deployment contract matches that host or artifacts are not redistributed.

Do not call an ISA baseline “portable” without naming the fleet. Wider SIMD is not automatically better: vector width changes instruction count, register pressure, memory traffic behavior, and on some processors sustained use can affect frequency. Chapter 42 owns those CPU decisions. This chapter's rule is to record the exact target and test every supported machine class.

---

## 40.3 Scalar Transformations and Escape Analysis — Core

Many impressive outputs come from a short set of transformations composed together.

| Transformation | Proof needed | Named benefit | Common blocker |
|---|---|---|---|
| Constant folding | Operands known and operation valid | Removes runtime arithmetic | Runtime input, FP environment constraints |
| Constant propagation / SCCP | Value known along reachable paths | Deletes branches and specializes code | Opaque calls, stores through possible aliases |
| Dead-code elimination (DCE) | Result/effects unobservable | Removes instructions and whole paths | Volatile/atomic/I/O effects |
| Common-subexpression elimination / GVN | Expressions have same value and no intervening clobber | Avoids recomputation/reload | Aliasing, volatile, unknown calls |
| Loop-invariant code motion (LICM) | Value unchanged for all loop iterations | Hoists work out of loop | Possible store alias, exceptions/control flow |
| Strength reduction | Replacement preserves semantics | Cheaper induction/arithmetic form | Overflow or FP semantic differences |
| Scalar replacement of aggregates (SROA) | Object fields need not remain in memory | Registers instead of stack aggregate | Address escapes or opaque use |

### Folding, propagation, and dead code

```cpp
int normalized_price(int ticks, bool inverted) {
    constexpr int scale = 100;
    const int factor = scale / 10;       // folds to 10
    if (inverted) return -ticks * factor;
    return ticks * factor;
}
```

If inlining proves `inverted` is always false at one call site, that branch and its dead arm can disappear there. Multiplication or division by a compile-time constant may become shifts, additions, or a reciprocal-multiply sequence when the target cost model prefers it. The exact instruction sequence is ISA/compiler dependent; recognize the transformation without promising a mnemonic.

DCE is also why careless microbenchmarks report impossible results. If the computed value cannot affect observable behavior, the entire computation may vanish. Use a benchmark framework's documented barriers and inspect the generated benchmark body.

### CSE, load motion, and clobbers

An optimizer can reuse `a * b` only while it knows `a` and `b` have not changed. A call whose body is unavailable can modify globally reachable memory or memory reachable through its arguments. A store through another pointer can clobber a load if alias analysis cannot prove separation.

Manually caching a member before a loop can communicate an invariant and shorten a load dependence, but it also extends the value's live range and can raise register pressure. Prefer making alias/lifetime relationships clear, then verify whether manual hoisting changes code or measurements.

### Escape analysis and SROA

An address **escapes** a region when code outside the optimizer's visible reasoning can retain or observe it: returning the address, storing it globally, capturing it in an escaping closure, or passing it to an opaque function are common examples.

If a small aggregate does not escape, SROA can split it into scalar SSA values and keep those values in registers:

```cpp
struct Point {
    double x;
    double y;
};

double squared_distance(Point a, Point b) {
    Point delta{a.x - b.x, a.y - b.y};
    return delta.x * delta.x + delta.y * delta.y;
}
```

There need not be stack storage for `delta`. C++ also permits certain replaceable allocation calls to be omitted or combined under specified conditions, so a visible `new`/`delete` pair is not an unconditional machine-code allocation. Do not promise allocation elision: custom allocation functions, escaping pointers, constructors/destructors, exceptions, and compiler maturity all affect the proof.

“Zero-cost abstraction” is a result to verify, not a property granted by a wrapper's name. A stack slot, unexpected copy, or surviving allocation in optimized code is evidence that inlining, escape, alias, or semantic constraints need investigation.

---

## 40.4 Inlining, Devirtualization, and Branch Layout — Core

Inlining replaces a call site with a version of the callee body. Removing call/return mechanics is often secondary. The main benefit is visibility: constant arguments propagate, aliases become local, branches fold, aggregates scalarize, and further calls may devirtualize.

Inlining is decided per call site. A compiler estimates code growth and potential simplification using static heuristics or profile data. A small function can remain out of line because its definition is unavailable; a larger function can inline when constant arguments delete most of its body.

### `inline` is not a code-generation command

The standard `inline` specifier permits multiple identical definitions across translation units under ODR rules and affects entity identity/linkage semantics. Functions defined inside a class definition are implicitly inline in this language sense. The standard does not require an inline call to be expanded or prevent a non-inline function from being expanded.

Compilers may consider the spelling as one heuristic input, but behavior is version-specific. Use optimization remarks and generated code to learn what happened.

### Forced inline and noinline are extensions

GCC, Clang, and MSVC provide different spellings:

```cpp
#if defined(__GNUC__) || defined(__clang__)
[[gnu::always_inline]] inline int scaled(int x) { return x * 8; }
[[gnu::noinline]] int handle_error(int code) { return -code; }
#elif defined(_MSC_VER)
__forceinline int scaled(int x) { return x * 8; }
__declspec(noinline) int handle_error(int code) { return -code; }
#endif
```

These are compiler extensions, not C++23. `always_inline` is a strong request and some compiler/configuration combinations diagnose failure, but it cannot make impossible cases valid. Target-feature mismatches, recursion, unavailable bodies, or disabled optimization can change results.

`noinline` is often the safer latency lever: moving a rare error path out of a hot function reduces hot code size and live ranges. It is also useful temporarily to create a profiling boundary. It prevents call-site inlining under that compiler contract, not necessarily interprocedural cloning or every other transformation.

Forced inlining can hurt by increasing instruction-cache footprint, register pressure, spill traffic, and compile time. Record the reason for the attribute and add a code-size/latency regression check.

### Devirtualization

A virtual or function-pointer call can become a direct call when the optimizer proves or predicts the target. Common evidence sources are:

- the dynamic type is locally visible;
- the class or override is `final`;
- whole-program/LTO visibility proves the target set;
- profile data identifies a dominant target and the compiler emits a guarded fast path plus fallback.

Direct calls enable inlining. An indirect call that remains has its own prediction and dependency costs, but Chapter 42 owns CPU execution. At this level, diagnose why the target set was unknown: shared-library interposition, plugin boundaries, type erasure, missing LTO, or genuinely polymorphic workloads.

### Branch probability hints

C++20 `[[likely]]` and `[[unlikely]]` have no effect on program semantics. They allow implementations to bias layout and optimization:

```cpp
int validate_sequence(unsigned expected, unsigned received) {
    if (received != expected) [[unlikely]] {
        return -1;
    }
    return 0;
}
```

A hint does not directly program a modern hardware branch predictor. It may influence fall-through layout, cold splitting, inlining budgets, and other compiler choices. A wrong hint can make common code colder or introduce an extra taken branch. Profile-guided probabilities are preferable when the workload is stable and representative.

GCC/Clang `__builtin_expect` and probability builtins, and `hot`/`cold` attributes, are extensions with version-specific interactions. Treat them as hypotheses. Confirm block layout in the final binary and branch behavior under the intended workload.

---

## 40.5 Aliasing, `restrict`, and Type-Based Access — Core

Two pointers **alias** when they can designate overlapping storage during the relevant execution. Aliasing constrains load reuse, store motion, loop-invariant code motion, and vectorization because a store through one pointer may change a later load through another.

```cpp
#include <cstddef>

void add_arrays(float* output,
                const float* left,
                const float* right,
                std::size_t count) {
    for (std::size_t i = 0; i < count; ++i) {
        output[i] = left[i] + right[i];
    }
}
```

The interface permits `output` to overlap `left` or `right`. Some overlaps remain semantically valid but create loop-carried dependencies. A vectorizer can decline, or it can emit **loop versioning**: runtime overlap checks select a vector loop when ranges are disjoint and a scalar fallback otherwise. The checks add branches and code size, so profitability depends on trip counts and target.

### `restrict` is not standard C++23

GCC/Clang `__restrict__`, C `restrict`, and MSVC `__restrict` are extension contracts. They tell the optimizer that accesses through the restricted association obey non-aliasing rules for the relevant execution.

```cpp
#include <cstddef>

void add_arrays_restricted(float* __restrict__ output,
                           const float* __restrict__ left,
                           const float* __restrict__ right,
                           std::size_t count) {
    for (std::size_t i = 0; i < count; ++i) {
        output[i] = left[i] + right[i];
    }
}
```

Violating the extension's contract can produce wrong code without a runtime check. Before adding it, prove the call graph's overlap invariant and test adversarial cases. An alternative API can express ownership of disjoint buffers structurally, or copy a scalar invariant to a local when only one load needs separation.

### Strict aliasing is a language rule, not pointer overlap

Type-based alias analysis relies on C++ rules governing which glvalue types may access an object's stored value. It is distinct from `restrict`: two `int*` values may alias under type rules; an `int*` and an unrelated `double*` generally cannot both access the same object's value as those types.

Common safe representation tools are:

- `std::bit_cast<To>(from)` for same-size trivially copyable value reinterpretation;
- `std::memcpy` for copying object representations;
- `char`, `unsigned char`, and `std::byte` views for inspecting object representation;
- explicit lifetime-starting construction when reusing raw storage.

Dereferencing a `reinterpret_cast` pointer does not by itself create the destination object or make the access valid. Reading an inactive union member is not a portable C++ type-punning technique merely because a compiler supports it as an extension.

`-fno-strict-aliasing` tells a compiler to avoid a class of type-based assumptions. It can be a useful differential diagnostic and may be a project policy for legacy code. It does not legalize out-of-lifetime objects, misalignment, invalid pointers, races, or every form of type punning.

### A practical alias diagnosis

When a load remains inside a loop:

1. Find every store and opaque call that could reach the same storage.
2. Check whether the function signature permits overlap even if current callers do not.
3. Inspect vectorization/LICM remarks for “unsafe dependent memory operations” or equivalent wording.
4. Try a local copy or a restricted experimental variant.
5. Compare final code and tests, including deliberate overlapping inputs.

The correct remedy communicates a true invariant. It does not silence the optimizer's caution with a promise the program cannot keep.

---

## 40.6 Loop Transformations and Automatic Vectorization — Core

Loop optimizers normalize induction variables, move invariants, remove bounds proven redundant, unswitch invariant conditions, peel iterations, unroll bodies, interchange or fuse loops where legal, and vectorize across iterations.

### Unrolling

Unrolling duplicates the body to reduce loop-control frequency and expose more independent operations:

```cpp
#include <cstddef>

float sum_four_way(const float* values, std::size_t count) {
    float a = 0.0F, b = 0.0F, c = 0.0F, d = 0.0F;
    std::size_t i = 0;
    for (; i + 3 < count; i += 4) {
        a += values[i];
        b += values[i + 1];
        c += values[i + 2];
        d += values[i + 3];
    }
    for (; i < count; ++i) a += values[i];
    return (a + b) + (c + d);
}
```

This source changes floating-point evaluation order compared with one serial accumulator, so results can differ. A compiler cannot generally introduce the same reassociation under strict floating semantics. If the domain permits an error bound rather than bitwise equivalence, encode and test that numerical contract before enabling relaxed FP options.

Unrolling can expose instruction-level parallelism and reduce branch overhead. It also increases code size and live values, potentially causing spills or harming front-end locality. Short typical trip counts can spend more time in the remainder path than they save. Profile data helps the cost model choose factors.

### Vectorization legality and profitability

Loop vectorization performs several scalar iterations with SIMD operations. SLP vectorization combines independent scalar operations within a basic block. Both require a legal transform and a profitable target implementation.

| Question | If the answer is uncertain |
|---|---|
| Are iterations independent or a recognized reduction/induction? | Preserve scalar ordering or reject vectorization |
| Can input and output ranges overlap? | Version with runtime checks or use scalar path |
| Are accesses contiguous and suitably aligned? | Use unaligned operations, peel, gather/scatter, or reject |
| Is control flow representable with masks/selects? | Predication may cost more than scalar branching |
| Are calls inlinable or available as vector functions? | Calls block or limit the vector loop |
| Does FP transformation preserve required results? | Ordered implementation or no reassociation |
| Is trip count large enough to repay setup/remainder work? | Scalar code can be cheaper |
| Does target ISA make the vector width profitable? | Cost model selects width or declines |

The standard does not promise vectorization, a particular width, or a speedup. GCC and Clang have changed which levels enable which vectorizers and which cost models they use. Use remarks from the exact compiler version.

Typical commands, labeled as GCC/Clang interfaces rather than C++:

```bash
# GCC: report successful and missed vectorization decisions
g++ -std=c++23 -O3 -fopt-info-vec-optimized -fopt-info-vec-missed -c loop.cpp

# Clang: report the decision and analysis behind it
clang++ -std=c++23 -O3 -Rpass=loop-vectorize \
  -Rpass-missed=loop-vectorize -Rpass-analysis=loop-vectorize -c loop.cpp
```

A pragma such as OpenMP `simd` or a vendor loop directive is also a contract. If it asserts independence that is false, results are not rescued by the compiler. Explicit SIMD intrinsics and CPU-specific layout choices belong to Chapter 42.

---

## 40.7 Worked Diagnosis: Why Did the Vector Loop Gain Guards? — Core

Consider the `add_arrays` loop from §40.5. The source looks independent, but its signature permits overlap. Compile a self-contained translation unit and retain both remarks and assembly:

```cpp
#include <cstddef>

extern "C" void add_arrays(float* output,
                           const float* left,
                           const float* right,
                           std::size_t count) {
    for (std::size_t i = 0; i < count; ++i) {
        output[i] = left[i] + right[i];
    }
}
```

```bash
# Example investigation: Clang targeting an x86-64 AVX2 deployment baseline
clang++ -std=c++23 -O3 -march=x86-64-v3 -S -masm=intel \
  -Rpass=loop-vectorize -Rpass-analysis=loop-vectorize add.cpp

# Preserve source mapping and inspect the final linked binary as a separate step
clang++ -std=c++23 -O3 -march=x86-64-v3 -g add.cpp driver.cpp -o add-test
objdump -d -M intel --disassemble=add_arrays add-test
```

The command lines are examples for a Clang/GNU-style x86-64 toolchain. Option availability and spelling are compiler/version/platform specific. On a conforming build, the C++ source semantics are the same even if the backend uses another ISA or declines vectorization.

### Evidence chain

Suppose the remark says the loop was vectorized, yet disassembly shows pointer comparisons and two loop bodies. That is not contradictory. The optimizer emitted **runtime alias versioning**:

```
entry
  ├─ count large enough?
  ├─ output range disjoint from left range?
  └─ output range disjoint from right range?
          │ yes                         │ no / short
          ▼                             ▼
   vector loop                    scalar loop
   vector loads                   scalar load/add/store
   vector add/store
          │
          ▼
   scalar remainder
```

A representative AVX2 vector body may contain instructions shaped like:

```asm
vmovups ymm0, ymmword ptr [rsi + 4*rax]
vaddps  ymm0, ymm0, ymmword ptr [rdx + 4*rax]
vmovups ymmword ptr [rdi + 4*rax], ymm0
add     rax, 8
cmp     rax, rcx
jne     .vector_loop
```

This is illustrative x86-64 assembly, not a compiler guarantee. Register allocation, unroll factor, vector width, instruction selection, guards, and labels change across versions and flags. Chapter 41 teaches how to read the actual output.

### Decide whether the guards matter

The guards add fixed setup work and code size. They may be negligible for large arrays and material for tiny message-sized arrays. Do not remove them by reflex:

1. Benchmark the real count distribution, including the p50 and lower tail of `count`.
2. Measure both disjoint and intentionally overlapping cases to preserve behavior.
3. Attribute time to this function in the final binary, not only a reduced example.
4. Record instruction count/code size and check whether the vector path is actually taken.

If the application invariant truly guarantees non-overlap, an extension-specific restricted interface can remove the version checks. Verify the new assembly and run overlap-negative tests that assert callers never violate the contract. If typical counts are very small, a scalar specialized path may beat both versioned and restricted vector loops. If the loop is not hot, keep the simpler standard interface.

This diagnosis demonstrates the full method:

```
language permits overlap
    → optimizer needs a legality guard
    → IR creates versioned loops
    → backend selects target SIMD
    → assembly confirms both paths
    → workload measurement decides whether redesign pays
```

---

## 40.8 Profiles: PGO, Sample Profiles, and Post-Link Layout — Core

Static heuristics estimate hotness, branch probabilities, call targets, and trip counts. A representative profile supplies observed frequencies. Profile-guided optimization can change:

- inlining decisions and function cloning;
- hot/cold block and function layout;
- branch probabilities and switch lowering;
- loop unroll/vector profitability;
- indirect-call promotion and speculative devirtualization.

PGO improves the compiler's model; it does not change C++ correctness rules. A profile cannot legalize aliasing, data races, signed overflow, or FP reassociation.

### Instrumented PGO

The broad workflow is build → exercise → merge if required → rebuild:

```bash
# Clang example; names and workflow vary by version/platform
clang++ -O2 -fprofile-instr-generate app.cpp -o app-instrumented
LLVM_PROFILE_FILE='run-%p.profraw' ./app-instrumented representative-input
llvm-profdata merge -output=app.profdata run-*.profraw
clang++ -O2 -fprofile-instr-use=app.profdata app.cpp -o app-pgo
```

GCC uses its own profile-generation/use options and data formats. Profiles are compiler- and build-specific artifacts. Keep source revision, compiler version, flags, and training workload with them.

The hard problem is representativeness. A training run with only normal market flow can move recovery code far away and over-specialize indirect calls; that may be excellent for normal latency and poor during an incident. Include weighted production modes, validate rare but critical paths, and compare profile coverage. Treat missing or mismatched profile warnings as build failures when PGO is required.

Instrumentation changes execution and can perturb layout, concurrency, and timing. Measure the final profile-use binary on a clean workload; do not report training-binary latency as production latency.

### AutoFDO and sample-based profiles — Role-specific

AutoFDO is a GCC-oriented sample-profile workflow, commonly built from Linux performance-counter data. LLVM has its own sample-profile and `llvm-profgen` workflows. They can profile an already optimized binary with lower perturbation than edge instrumentation, but attribution depends on debug information, branch-stack/LBR availability, sampling quality, and tooling versions.

Do not attach universal overhead or benefit percentages. Sampling frequency, kernel permissions, multiplexing, binary layout, workload duration, and hardware support determine fidelity. Validate profile coverage and compare decisions in optimization remarks.

### BOLT — Role-specific

BOLT is an LLVM post-link optimizer that rewrites supported binaries using execution profiles. Depending on binary format, linker output, BOLT version, and selected mode, it can reorder functions/basic blocks, split hot and cold code, and perform related whole-binary layout transforms.

It does not replace semantic optimization in the compiler. It sees the linked binary and is strongest when instruction-fetch/layout evidence shows a problem. Required relocation, symbol, instrumentation, and profile options vary; follow the documentation for the exact toolchain. Revalidate unwinding, symbolization, debug information, build IDs, signatures, and deployment packaging after rewriting.

The order of engineering decisions is profile the real binary, establish that front-end/layout cost matters, test a post-link variant, then retain it only if production-like distributions improve.

---

## 40.9 Interprocedural Optimization, LTO, and Linker Passes — Core

**Interprocedural optimization** (IPO/IPA) reasons across function boundaries. It includes inlining but also constant-argument propagation, cloning, parameter removal/scalarization, side-effect inference, points-to analysis, devirtualization, and hot/cold splitting.

Without visibility, an external call is conservative: it may modify reachable state, throw, or return different results. Header definitions expose template/small-function bodies inside each translation unit; LTO extends visibility across object-file boundaries.

### Link-time optimization

With LTO, compiler-specific intermediate representation or summaries survive into the link so whole-program passes can import or combine information before final code generation.

Two common designs are:

- **full/monolithic LTO**, which combines broad IR visibility and can consume substantial link memory/time;
- **ThinLTO-style summary/import**, which builds a global index, imports selected definitions, supports parallelism, and can use a cache.

Exact availability and flag spelling differ: Clang supports full and ThinLTO modes; GCC's LTO implementation and partition modes are not simply interchangeable with LLVM ThinLTO. All participating objects, libraries, linker plugins, compiler versions, and archive tools must be compatible. Mixed non-LTO code remains opaque rather than magically becoming IR.

LTO can enable cross-TU inlining and devirtualization, then trigger scalar/loop passes exposed by them. It can also increase link time, memory, code growth, and sensitivity to ODR violations. Dynamic linking, symbol visibility, interposition, plugins, inline assembly, and `dlsym`-style lookup limit whole-program assumptions. Platform/compiler visibility and semantic-interposition flags are extensions; test exported interfaces carefully.

### Identical-code folding

ICF is usually a linker feature that merges eligible code sections judged identical. It reduces code size, especially with templates, but aggressive modes can violate assumptions about distinct function addresses. Linkers commonly offer safe and aggressive modes with different guarantees; names and eligibility differ among lld, gold, mold, and platform linkers.

Use function-pointer identity tests, symbolization tests, and the linker's ICF report when enabling it. Do not assume two equal instruction byte strings are interchangeable if addresses are observable or relocations differ.

### Section garbage collection

Section GC removes input sections not reachable from linker roots. It normally needs functions/data emitted into separate sections:

```bash
# GNU-style GCC/Clang and linker example
c++ -std=c++23 -O2 -ffunction-sections -fdata-sections -c app.cpp
c++ app.o -Wl,--gc-sections -Wl,--print-gc-sections -o app
```

Entry points, exported symbols, initialization arrays, linker-script `KEEP` directives, relocations, and compiler/linker retention annotations affect roots. Code reached only by string lookup, a plugin, assembly, or an external loader may appear unreachable. This is a build contract, not a C++ semantic discovery; verify dynamic entry points and inspect the linker's discarded-section report.

Section GC and ICF mainly reduce size. Smaller text can improve instruction-cache/TLB locality, but only profiles and counters establish a latency benefit. ELF sections, relocations, ABI, and loading are owned by Chapter 41.

---

## 40.10 Optimization Evidence — Core

An optimization remark is the compiler's explanation of a decision. Assembly is evidence of the emitted object. A runtime profile shows where the deployed workload spent time. None substitutes for the others.

### A compact investigation loop

1. **Find a hot region.** Use a production-like profile and a latency distribution, not intuition.
2. **Preserve the reproducer.** Capture input shape, compiler/version, complete flags, target, libraries, link mode, and source revision.
3. **Request focused remarks.** Ask about the suspected pass instead of drowning in all-pass output.
4. **Reduce carefully.** Build a small source example while checking it still produces the same missed decision.
5. **Inspect the final binary.** LTO, linking, ICF, and post-link tools can make compile-stage assembly stale.
6. **Change one fact.** Inline a body, prove non-overlap, remove an escape, or alter layout.
7. **Recheck correctness and measure.** Include tails, code size, counters, and rollback criteria.

Common compiler interfaces include:

```bash
# GCC family: selected optimization reports
g++ -O3 -fopt-info-vec-optimized -fopt-info-vec-missed -c source.cpp
g++ -O3 -fopt-info-inline-missed -c source.cpp

# Clang family: pass, missed-pass, and analysis remarks
clang++ -O3 -Rpass=inline -Rpass-missed=inline -c source.cpp
clang++ -O3 -Rpass-analysis=loop-vectorize -c source.cpp

# Clang family: serialized optimization record (format/version specific)
clang++ -O3 -fsave-optimization-record -c source.cpp
```

Flag group names and emitted text change between releases. Save reports as build artifacts, but avoid brittle CI checks that match an entire diagnostic sentence. For a small set of contractual hot loops, checking that a named optimization remains present can catch silent regressions—provided compiler upgrades intentionally update the baseline.

### Map symptoms to missing evidence

| Observation | Likely question | Next evidence |
|---|---|---|
| Call remains | Body visible? cost too high? indirect target unknown? | Inline/devirtualization remark |
| Same load repeats in loop | Which store/call may alias or clobber it? | Alias/LICM remark and IR |
| Scalar loop remains | Dependence, alias, trip count, call, or FP rule? | Vector analysis remark |
| Vector and scalar copies both exist | Runtime versioning or remainder? | CFG/assembly and path profile |
| Aggregate has stack traffic | Address escaped or ABI boundary? | SROA/escape remark, call sites |
| `-O3` regresses | Code growth, spills, different vector width/layout? | Size diff, disassembly, runtime counters |
| PGO variant regresses rare path | Training distribution missing mode? | Profile coverage and cold-path latency |
| Function vanished | Inlined, DCE, ICF, or section GC? | Link map, symbols, linker reports |

Compiler-generated assembly for a single source file is useful for transformations before link. Disassembly of the exact shipped binary is authoritative for final instructions. Chapter 41 covers the mechanics; Chapter 44 covers Compiler Explorer, build reproducibility, sanitizers, and inspection tools.

### Standard, extension, implementation, measurement

Label claims explicitly:

- **C++23 guarantee:** signed overflow is UB; unsigned arithmetic wraps; `inline` does not mandate substitution.
- **Compiler extension:** `__restrict__`, `always_inline`, `-march`, remark flags.
- **Compiler/version behavior:** a pass enabled at one optimization level, an inlining threshold, a vector-width choice.
- **ISA/backend output:** AVX2 `vaddps`, AArch64 `fadd`, runtime overlap-check shape.
- **Measured workload result:** p99 improvement, instruction-cache change, code-size growth.

This classification prevents a local observation from becoming false folklore.

### IR as a diagnostic bridge — Deep Dive

Assembly tells you what survived, but high-level IR can show why a proof succeeded before target lowering obscures it. In SSA form, each value definition is explicit; conditional branches, loads/stores, alias metadata, and vector-loop structure are easier to correlate with a pass.

```bash
# Clang/LLVM example: textual optimized LLVM IR
clang++ -std=c++23 -O2 -S -emit-llvm source.cpp -o source.ll

# GCC example: request an optimized-tree dump
g++ -std=c++23 -O2 -fdump-tree-optimized source.cpp -c
```

These formats and dump filenames are compiler/version interfaces, not stable source artifacts. IR is also not machine cost: a single IR operation can expand into several instructions, disappear during instruction selection, or choose differently after register allocation.

Use IR to answer a bounded question:

- Did inlining expose the callee?
- Did a branch fold before code generation?
- Does the loop have alias checks and separate vector/scalar regions?
- Was an aggregate split into scalars?
- Does a load remain because a call may write memory?

Then continue to final disassembly and measurement. Do not optimize IR aesthetics; an apparently longer IR form can encode target information that produces better machine code.

---

## 40.11 Flag and Transformation Reference — Reference

### Flag review

| Option family | Intended permission/input | Main risk | Verification |
|---|---|---|---|
| `-O0`…`-O3`, size levels | Select pass/cost bundle | Version changes; code growth | Compiler option dump, remarks, size/perf |
| `-ffast-math` and suboptions | Relax FP constraints | Numerical/NaN/Inf/signed-zero behavior | Domain tests, enabled-option dump, FP environment |
| `-march` / `-mcpu` | Permit target instructions | Unsupported deployment CPU | Artifact metadata/disassembly; fleet test |
| `-mtune` | Change target cost/scheduling model | Wrong workload/core model | A/B on supported CPUs |
| `-flto` / ThinLTO mode | Cross-TU visibility | Link cost, compatibility, code growth | Link logs, remarks, final symbols |
| profile generate/use | Supply observed frequencies | Stale or biased training | Coverage, mismatch diagnostics, A/B |
| function/data sections + GC | Fine-grained link removal | Hidden dynamic roots removed | Linker GC report, integration tests |
| linker ICF | Fold identical sections | Address identity/symbolization changes | ICF report and identity tests |
| `-fno-strict-aliasing` | Disable selected type-based assumptions | Lost optimization; UB still elsewhere | Differential test, alias audit |
| forced inline/noinline attributes | Override call-site heuristic | Code growth or artificial boundary | Remark and final disassembly |

Never copy a flag stack from another binary without its assumptions. The rollback is the last tested configuration; success is a measured distribution under each supported deployment target with correctness tests unchanged.

### Transformation dependencies

```
body visibility
  └─▶ inlining/devirtualization
        ├─▶ constant propagation ─▶ branch folding ─▶ DCE
        ├─▶ better alias facts ─▶ LICM/CSE
        └─▶ escape proof ─▶ SROA

loop legality (dependence + alias + FP rules)
  └─▶ loop normalization/versioning
        ├─▶ unrolling
        └─▶ vectorization ─▶ target instruction selection

representative profile
  ├─▶ hotness-aware inlining/cloning
  ├─▶ branch/block/function layout
  └─▶ loop profitability
```

When a downstream optimization is absent, inspect its upstream fact. Adding a vector pragma cannot repair a true dependence; increasing an inline threshold cannot expose a body missing from the build; LTO cannot reason through a runtime-loaded implementation it never sees.

---

## Recall Card — Core

- The as-if rule preserves required observable behavior of defined executions, not source statement shape.
- UB is not “an unpredictable value”; it removes requirements and can make later checks unreachable on every defined path.
- Optimization is an enabling chain over IR. Visibility, constants, alias facts, escape facts, and profile hotness feed later passes.
- Debug information, assertions, sanitizers, target ISA, and optimization level are independent build choices.
- `inline` has language/ODR semantics. Forced-inline, noinline, `restrict`, branch builtins, and `-O*` are implementation interfaces.
- Inlining helps mainly by exposing the body; too much can increase code size, spills, and front-end pressure.
- Aliasing can block load motion and vectorization. Runtime loop versioning preserves overlap semantics.
- Strict aliasing, object lifetime, alignment, and `restrict` are separate contracts. `-fno-strict-aliasing` does not legalize all invalid accesses.
- Vectorization requires legality and profitability; width and assembly are target/compiler decisions.
- PGO supplies frequencies, LTO supplies cross-TU visibility, and BOLT applies supported post-link layout transformations.
- Remarks explain compiler decisions; final disassembly confirms emitted code; workload measurements decide value.

## Common Traps — Core

- Treating `-O3` as an ordered upgrade over `-O2`.
- Claiming `-O0` executes every source load/store or defines a stable machine model.
- Enabling `-ffast-math` without a numerical contract, then blaming changed NaN or rounding behavior.
- Shipping `-march=native` from a build host that is newer than part of the fleet.
- Believing `inline` forces inlining or that `noinline` prevents every clone.
- Using `[[likely]]` as if it directly controls the hardware predictor.
- Adding `__restrict__` because arrays “usually” do not overlap.
- Type-punning through `reinterpret_cast` and assuming `-fno-strict-aliasing` repairs lifetime/alignment.
- Benchmarking an unused result that DCE removes.
- Assuming a compiler remark proves the final linked binary or a performance win.
- Training PGO on an easy synthetic mode that omits recovery bursts.
- Mixing incompatible/stale profile or LTO artifacts and ignoring diagnostics.
- Enabling aggressive ICF or section GC without testing address identity and dynamic roots.
- Reading an illustrative assembly snippet as a stable compiler guarantee.

## Reasoning Questions — Core

1. Why may a compiler remove a null check that occurs after dereferencing the pointer, and how should the source be repaired?
2. A function marked `inline` still appears as a call. Name three independent reasons and the evidence for each.
3. Why can `-O3` increase latency even when it reduces dynamic branch count?
4. A load remains inside a loop after a store through another pointer. What alias proof would permit LICM, and how can the API truthfully provide it?
5. Why might a compiler emit vector and scalar versions of the same loop, and which workload property decides whether that is worthwhile?
6. What semantic permission is required to vectorize a floating-point reduction by changing its association?
7. Compare PGO and LTO: what missing information does each supply, and what can neither legalize?
8. A function disappears from the final symbol table. How would you distinguish inlining, DCE, ICF, and section GC?
9. Why can `-fno-strict-aliasing` change a bug's symptoms without making the source valid?
10. What must accompany a claim that one compiler flag improved p99 latency?

## Code-Reading Puzzle — Core

```cpp
#include <limits>

bool signed_grows(int value) {
    return value + 1 > value;
}

bool unsigned_grows(unsigned value) {
    return value + 1 > value;
}
```

For each function, predict the result for every **defined** input. Why may an optimizer replace one body with a constant while the other must preserve a boundary case? What happens if the caller passes `INT_MAX` to `signed_grows`?

## Diagnosis Exercise — Core

You inherit a price-normalization loop that was vectorized last month but is scalar after a refactor. The refactor introduced a helper call and changed an output parameter from a dedicated buffer type to `float*`.

Write an investigation note that includes:

1. the profile evidence showing the loop matters;
2. GCC or Clang vectorization-report commands;
3. the two new blocking hypotheses—opaque call and possible aliasing;
4. one minimal experiment for each hypothesis;
5. correctness tests with overlapping ranges and boundary trip counts;
6. final-binary disassembly and code-size checks;
7. workload, ISA baseline, compiler version, latency distribution, and rollback rule.

Do not solve it by adding `__restrict__`, a force-inline attribute, or a vector pragma until the corresponding contract is proven.

## Prerequisites for Chapter 41 — Core

Chapter 41 covers assembly, binaries, and ABI. Before starting it, you should be able to explain why source order differs from instruction order, identify calls/loads/branches/vector loops as evidence of completed or blocked transformations, and label an observed instruction sequence by compiler version, flags, and target ISA rather than as a C++ guarantee.
