# Chapter 40 — Compiler Optimization

*Interview-focused revision notes. The theme: every optimization is a transformation the compiler may perform only when it can *prove* the transformation preserves observable behavior — so the practical skill is knowing what defeats each proof, and how to verify from the outside which transformations actually fired.*

---

## 40.1 Compiler Optimization Levels

An **optimization level** is a named bundle of individual passes plus a cost-model posture. The levels are not a linear "more is better" axis; they encode different tradeoffs between code size, compile time, and speed.

| Level | GCC/Clang meaning | Inlining | Vectorization | Unrolling | Debuggability |
|---|---|---|---|---|---|
| `-O0` | No optimization; every variable lives in memory, every statement maps to instructions | None (except `always_inline`) | No | No | Perfect |
| `-O1` | Cheap, mostly-local passes; no size-expanding transforms | Trivial only | No | No | Good |
| `-O2` | The production default; nearly all passes that don't grow code much | Aggressive | GCC 12+: yes (`-ftree-vectorize` moved into `-O2` with the "very-cheap" cost model); Clang: yes | Limited | Fair |
| `-O3` | `-O2` plus size-increasing transforms | More aggressive (higher thresholds) | Yes, aggressive cost model | Yes | Poor |
| `-Os` | `-O2` minus anything that grows code | Restricted | Mostly off | No | Fair |
| `-Oz` | Minimize size at any speed cost (Clang; GCC 12+) | Minimal | No | No | Fair |
| `-Ofast` | `-O3` + `-ffast-math` + `-fno-protect-parens` etc. | As `-O3` | Yes, plus FP reassociation | Yes | Poor |
| `-Og` | Optimize while preserving debug quality | Some | No | No | Good |

**Things worth knowing precisely:**

- **`-O3` is not reliably faster than `-O2`.** It enables aggressive inlining, loop unrolling, and loop vectorization, all of which increase code size and can *worsen* performance by blowing the L1 instruction cache and the micro-op cache (Ch. 27 §27.7, §27.15). On a hot path made of many small functions this is a real regression risk. The correct posture: `-O2` as the baseline, `-O3` on measured hot translation units, and always measure.
- **`-Ofast` / `-ffast-math` is dangerous for financial code.** It enables `-fno-signed-zeros`, `-freciprocal-math`, `-ffinite-math-only` (assume no NaN/Inf), and FP reassociation, so `a + b + c` may be reordered and comparisons against NaN can be optimized away entirely. Any code with NaN sentinels breaks silently. It also sets FTZ/DAZ in MXCSR at program start — which is *global to the process* and affects libraries you didn't compile (Ch. 2 §2.8). Interview-grade answer: `-ffast-math` is a semantic change, not an optimization level.
- **`-O0` semantics people rely on:** every load and store actually happens, so `-O0` accidentally masks data races and aliasing bugs. "It works at `-O0` and breaks at `-O2`" is nearly always UB in your code, not a compiler bug (Ch. 4 §4.5).
- **`-Og` is the debug build for latency work** — you get real code without the `-O0` memory-traffic pathology, and DWARF line info still tracks.
- **NDEBUG is orthogonal.** `-DNDEBUG` disables `assert`, which is a *source-level* change; optimization level does not control it. Shipping `-O2` without `-DNDEBUG` leaves asserts on the hot path.

**Verification:** `gcc -O2 -Q --help=optimizers` prints every flag and whether it is enabled at the current level — the authoritative answer to "is X on at `-O2` on this compiler version?", which changes between releases. Clang's equivalent introspection is `-mllvm -debug-pass=Structure` or `clang -O2 -### `.

---

## 40.2 CPU Architecture and Tuning Flags

Two independent knobs, constantly confused:

- **`-march=X`** — *what instructions the compiler may emit*. Setting `-march=haswell` permits AVX2, FMA, BMI2, and the resulting binary **will crash with SIGILL** on older CPUs.
- **`-mtune=X`** — *what microarchitecture to optimize scheduling and heuristics for*, with **no** effect on the instruction set. A binary built `-march=x86-64 -mtune=skylake` runs everywhere but has its instruction scheduling, unroll factors, and alignment padding tuned for Skylake.

`-march=X` implies `-mtune=X` unless `-mtune` is given explicitly.

**Important values:**

| Flag | Meaning |
|---|---|
| `-march=native` | Detect the build machine's CPU and target exactly it. Convenient, and a deployment landmine if build and run hosts differ. |
| `-mtune=native` | Tune for the build machine, portable ISA |
| `-march=x86-64-v2` | SSE4.2, POPCNT (roughly Nehalem+) |
| `-march=x86-64-v3` | AVX2, FMA, BMI1/2, LZCNT, MOVBE (roughly Haswell+) — the common HFT baseline |
| `-march=x86-64-v4` | AVX-512F/BW/DQ/VL (Skylake-SP+) |
| `-mtune=generic` | Default; blended heuristics across current CPUs |

**Non-obvious details:**

- **AVX-512 is not a free win.** On Skylake-SP and Cascade Lake, sustained 512-bit operations trigger **license-based downclocking** (Ch. 42 §42.13) — the core drops one or two frequency tiers, and the transition takes tens of microseconds during which the core runs at reduced frequency. A single stray AVX-512 instruction emitted into a hot loop by autovectorization can slow the *entire* thread, including scalar code. Many HFT shops build with `-march=x86-64-v3` deliberately, or `-mprefer-vector-width=256` to allow AVX-512 features (masking, more registers) without 512-bit vector width. Ice Lake and later greatly reduce but do not eliminate the effect.
- **`-mtune` affects unroll factors, alignment padding (`-falign-loops`), and the choice between `cmov` and branches.** Tuning for the wrong core is a measurable but second-order effect, usually a few percent.
- **Function multiversioning** solves the "one binary, several CPU generations" problem without runtime dispatch code: GCC/Clang `__attribute__((target_clones("avx2","default")))` or `target("avx2")` overloads plus an IFUNC resolver picking at load time. The cost is an indirect call at the boundary (resolved once via PLT, Ch. 41 §41.12).
- **`-mno-vzeroupper`, `-mavx256-split-unaligned-load`, and similar** are microarchitecture-specific workarounds worth knowing exist; the AVX–SSE transition penalty (Ch. 42 §42.12) is the reason `vzeroupper` insertion matters.

**Verification:** `objdump -d bin | grep -E 'vmov|vfmadd|zmm'` tells you whether AVX/AVX-512 was actually emitted; `readelf -n` shows GNU property notes recording ISA requirements; and `perf stat -e core_power.lvl2_turbo_license` on Intel counts cycles spent in the AVX-512 license state.

---

## 40.3 Link-Time Optimization

**LTO** defers final code generation to link time so the optimizer can see *across translation units* (Ch. 1 §1.1). Without it, a function defined in `a.cpp` and called from `b.cpp` is an opaque call: no inlining, no interprocedural constant propagation, no alias information, no devirtualization.

**Mechanism.** With `-flto`, the compiler emits its **IR** (GIMPLE for GCC, LLVM bitcode for Clang) into the object file instead of, or alongside, machine code. The linker — via a plugin (`LLVMgold.so`, `liblto_plugin.so`, or the native `lld`/`gold`/`mold` support) — reassembles the whole-program IR, runs interprocedural passes, and then generates code.

Two flavors:

| | Monolithic LTO (`-flto=full`) | ThinLTO (`-flto=thin`) |
|---|---|---|
| Model | Merge all IR into one module, optimize serially | Per-module summaries + a global index; cross-module import of just the needed functions, optimized in parallel |
| Link time | Very long, single-threaded, huge memory (10s of GB on large binaries) | Near-parallel; minutes not hours |
| Incremental builds | Terrible | Good — supports caching (`-flto=thin -Wl,--thinlto-cache-dir=`) |
| Optimization quality | Slightly better in principle | Within a few percent in practice |

ThinLTO is the practical default for anything large.

**What LTO buys you concretely:**

- **Cross-TU inlining** — the biggest single win, and it enables everything downstream (constant propagation, dead-code elimination, better alias analysis).
- **Whole-program devirtualization.** If LTO can prove only one class derives from an interface, virtual calls become direct calls and then get inlined. `-fwhole-program-vtables` (Clang, requires LTO) enables this properly; combined with `final` on classes and methods it is the standard way to get rid of dispatch cost without restructuring code (Ch. 6 §6.11, Ch. 55 §55.9).
- **Interprocedural constant propagation and dead-code elimination** across the whole binary, which combines with `--gc-sections` (§40.20) to shrink binaries substantially.
- **Better alias analysis**, because the definition of the callee is visible.

**What defeats it:**

- **Any object not compiled with LTO** — a static library built without `-flto` is an opaque blob. Mixed builds silently produce worse results with no diagnostic.
- **Symbols that must remain visible** — anything referenced by `dlsym`, an assembly file, or the linker script must be marked used (`__attribute__((used))`, `-Wl,--undefined=sym`) or LTO may delete it.
- **`-fno-semantic-interposition` matters for shared libraries.** By default a shared library's global functions can be interposed by `LD_PRELOAD`, so the compiler cannot inline them even within the same library. `-fno-semantic-interposition` (plus `-fvisibility=hidden`) recovers those inlines and is the single highest-value flag for library-heavy builds.
- **ODR violations become miscompiles.** Two TUs with different definitions of the same inline function is UB the linker previously tolerated; LTO merges them and produces genuinely wrong code. LTO is an ODR-violation detector by accident (`-Wodr`).

**Verification:** `nm -C bin | grep symbol` to confirm cross-TU functions were inlined away; `-Rpass=inline` (§40.21) to see the decisions; build with and without and diff `size bin`.

---

## 40.4 Inlining Heuristics

**Inlining** replaces a call with the callee's body. It is the single most important optimization not because calls are expensive (a predicted direct call is ~1–2 cycles plus the `ret`) but because inlining is an **enabler**: once the body is in the caller, constant propagation, dead-code elimination, CSE, alias analysis, and scalar replacement of aggregates all apply across what was a call boundary.

**The `inline` keyword is not an inlining request.** It is a linkage directive meaning "multiple definitions permitted, ODR-merged" (Ch. 1 §1.9). It contributes a small bonus to the heuristic in GCC and essentially none in Clang. Members defined in-class are implicitly `inline` in the linkage sense.

**The actual decision** is a cost/benefit computation, run bottom-up over the call graph:

```
cost   = estimated instruction count of the callee body after
         simplification with the caller's known argument values
benefit= call overhead removed + constants propagated + branches folded
         + (call-site is hot? from profile or static heuristics)
inline if cost - benefit < threshold
```

The knobs:

| Compiler | Parameter | Typical default | Meaning |
|---|---|---|---|
| GCC | `-finline-limit=N` / `max-inline-insns-auto` | ~15–30 (auto), ~70 (single-call) | Pseudo-instruction size cap |
| GCC | `--param inline-unit-growth=N` | 20 (%) | Cap on total unit growth from inlining |
| GCC | `--param large-function-growth` | 100 (%) | Cap for growing one function |
| Clang | `-mllvm -inline-threshold=N` | 225 at `-O2`, 275 at `-O3` | Cost units; `-Oz` uses 25 |
| Clang | `inlinehint-threshold` | 325 | Applied when `inline` is present |

**Heuristic amplifiers** — things that make inlining much more likely: the callee is called exactly once and is `static`/internal-linkage (it will be inlined and the original deleted, since there is no size cost); the callee is tiny; arguments are compile-time constants; the callee body simplifies dramatically under those constants; PGO says the call site is hot (§40.9).

**Heuristic suppressors:** the callee is large; it contains a loop (loops are weighted heavily); it takes the address of a local (may prevent SROA); it uses `alloca` or VLAs; it is recursive (bounded by `max-inline-recursive-depth`, typically 8); it is `noinline`; it is in another TU without LTO; it may be interposed (shared library default visibility); it has an exception-handling landing pad in some cost models; it is `virtual` and not devirtualized.

**Why over-inlining hurts** — the counterintuitive half that interviews probe. Inlining increases I-cache and micro-op-cache footprint (Ch. 27 §27.7, Ch. 28 §28.16). A hot loop whose body no longer fits in the DSB (Skylake's micro-op cache holds ~1536 µops with strict allocation rules) falls back to legacy decode, halving front-end bandwidth. Additional effects: more live values ⇒ **register pressure** ⇒ spills to the stack; longer functions ⇒ worse code layout; larger stack frames.

**Diagnostic signature of over-inlining:** high `idq.dsb_miss_ps` or low `idq.dsb_uops / idq.mite_uops` ratio in `perf stat`, `frontend_bound` rising in top-down analysis (Ch. 43 §43.19), and binary size growth without latency improvement.

---

## 40.5 Forced Inline and Noinline Attributes

When you need to override the heuristic, these are the tools. All are compiler extensions, not standard C++.

```cpp
[[gnu::always_inline]] inline int hot(int x) { return x * 3 + 1; }
__attribute__((always_inline)) inline void f();     // GCC/Clang classic spelling
__forceinline void g();                              // MSVC
[[gnu::noinline]] void cold_path(const char* msg);
[[msvc::noinline]] void h();                         // MSVC
[[gnu::flatten]] void entry();   // inline EVERY call made by this function, recursively
```

**Semantics and traps:**

- **`always_inline` is a hard requirement in GCC**, and failing it is an *error*, not a warning: "inlining failed in call to always_inline 'f': function not considered for inlining" — typically because the callee is in another TU, is recursive, uses `alloca`, or mismatches target attributes (calling an AVX-512 function from a non-AVX-512 one). Clang treats it as very strong but can decline in a few cases.
- **`always_inline` must still be combined with `inline`** for linkage purposes when the function lives in a header; otherwise you get ODR/duplicate-symbol issues.
- **`always_inline` is the standard tool for wrappers that must vanish** — a `std::span`-like accessor, an atomic wrapper, a strong typedef, a logging macro's fast path. At `-O0` these otherwise cost a real call each, making debug builds unusably slow for a trading system; `always_inline` applies even at `-O0` in GCC/Clang, which is often the actual motivation.
- **`noinline` is the more useful of the pair for latency work.** Marking the *cold* path `noinline` (error handling, slow-path recovery, logging) keeps the hot function small, its I-cache footprint tight, and lets the linker/BOLT place the cold body far away (§40.11, §41.17). Pairing `[[unlikely]]` (§40.6) with `noinline` on the slow branch is the canonical hot/cold split:

```cpp
[[gnu::noinline, gnu::cold]] void handle_gap(Seq expected, Seq got);

inline void on_packet(const Packet& p) {
    if (p.seq != expected_) [[unlikely]] { handle_gap(expected_, p.seq); return; }
    apply(p);                       // hot path stays tiny and contiguous
}
```

- **`[[gnu::cold]]` and `[[gnu::hot]]`** are stronger than they look: `cold` marks the function unlikely to execute, optimizes it for size, moves it to the `.text.unlikely` section (§40.20), and implicitly marks branches leading to it as unlikely — propagating the hint to *callers*.
- **`flatten`** recursively inlines everything a function calls. Occasionally correct for a small dispatch root; usually a code-size disaster.
- **`noinline` is also a measurement tool.** Marking a function `noinline` makes it show up as a distinct symbol in `perf report`, which is how you attribute cost to something the optimizer would otherwise have dissolved. Remember to remove it.
- **`noinline` prevents inlining, not cloning.** GCC's IPA-CP may still clone a specialized copy; `-fno-ipa-cp-clone` or `noclone` stops that. This bites when you use `noinline` to guarantee exactly one copy exists (e.g. for a function-pointer identity check).

---

## 40.6 Branch Probability Hints

The compiler needs branch probabilities to decide code layout (which side falls through), which side to inline into, register allocation priorities, and whether to unswitch loops. It gets them from, in decreasing order of quality: **PGO profile data** (§40.9), **explicit hints**, and **static heuristics**.

**Static heuristics** (GCC's `predict.c` / LLVM's `BranchProbabilityInfo`) are surprisingly good defaults: a branch guarding a `return` of a constant is likely; a comparison against null is predicted not-null; loop back-edges are taken with ~97% probability; a branch leading to a `noreturn` function or a `cold` function is nearly never taken; `x == 0` is predicted false; pointer comparisons for equality are predicted false.

**C++20 attributes** standardize hints:

```cpp
if (rc != 0) [[unlikely]] { return handle_error(rc); }
switch (msg_type) {
    case Add:    [[likely]]   ...;
    case Delete:              ...;
    default:     [[unlikely]] ...;
}
while (running) [[likely]] { ... }
```

**GCC/Clang builtins** predate them and remain more expressive:

```cpp
#define LIKELY(x)   __builtin_expect(!!(x), 1)
#define UNLIKELY(x) __builtin_expect(!!(x), 0)
// with an explicit probability (GCC 9+/Clang):
if (__builtin_expect_with_probability(cond, 1, 0.99)) { ... }
```

**What the hint actually does — and does not do.** It is a **compile-time layout and cost-model hint**, not a runtime prediction hint. Modern x86 has no architectural static-prediction override (the old `2E`/`3E` branch prefixes are ignored by every current core). What changes is:

1. **Code layout.** The likely path becomes the fall-through, and the unlikely body is moved to a cold region — often a different section (`.text.unlikely`). The hot path becomes a contiguous run of cache lines with no taken branches, maximizing I-cache and micro-op-cache density and letting the front end fetch straight-line.
2. **Inlining and optimization effort.** The compiler spends its budget on the likely path and optimizes the cold path for size.
3. **Register allocation** favors values live on the hot path.

So the benefit is **front-end and layout**, not branch-prediction accuracy — the branch predictor learns actual behavior from execution regardless (Ch. 27 §27.8). Saying this precisely is a strong differentiator; many candidates claim `__builtin_expect` "tells the CPU which way to go", which is wrong on modern hardware.

**When hints hurt:** if you mark a branch unlikely and it is actually taken 50% of the time, you have relocated hot code to a cold section and inserted a taken branch on the common path — measurably worse. Hints are only safe where you *know* the distribution (error paths, sequence-gap handling, capacity-exceeded checks). For anything data-dependent, use PGO and let the profile decide; PGO data overrides `__builtin_expect` where they conflict.

**Verification:** dump assembly and check the layout — the unlikely body should be after the function's `ret`, or in `.text.unlikely` (`objdump -d --section=.text.unlikely`). `perf stat -e br_misp_retired.all_branches` measures whether misprediction was actually your problem in the first place; if misprediction cost is low, the right transformation is branchless code (Ch. 42 §42.3) rather than hints.

---

## 40.7 Restrict and Alias Analysis

**Alias analysis** answers: can these two pointers refer to the same memory? Every load/store reordering, every register caching of a memory value, and all vectorization depends on the answer. When the compiler cannot prove "no", it must assume "maybe" and emit conservative code.

```cpp
void add(int* out, const int* a, const int* b, size_t n) {
    for (size_t i = 0; i < n; ++i) out[i] = a[i] + b[i];
}
```

Because `out` may alias `a` or `b`, the compiler must reload `a[i]` and `b[i]` after every store to `out[i]`, and cannot vectorize freely. In practice GCC and Clang emit a **runtime overlap check** that branches between a vectorized loop and a scalar fallback:

```asm
    ; compare pointer ranges; if they overlap, take the scalar path
    lea  rax, [rsi + rcx*4]
    cmp  rdi, rax
    jb   .Lscalar_loop
    ...vectorized body...
```

Recognizing that duplicated-loop pattern in disassembly is a good thing to mention: it costs code size, an unpredictable-ish branch, and a versioning check per call.

**`restrict`** is the promise "within this scope, the object accessed through this pointer is not accessed through any other pointer". It is standard **C99**, not standard C++; every mainstream C++ compiler supports `__restrict` / `__restrict__`.

```cpp
void add(int* __restrict out, const int* __restrict a,
         const int* __restrict b, size_t n) {
    for (size_t i = 0; i < n; ++i) out[i] = a[i] + b[i];   // clean vectorized loop
}
```

**Violating `restrict` is UB with no diagnostic and no sanitizer.** It is one of the very few promises in C++ that nothing checks — pass overlapping pointers and you get silently wrong results at `-O2` and correct results at `-O0`. Treat it as a contract to be documented and asserted in debug builds (`assert(out + n <= a || a + n <= out)`).

**Alternatives and complements:**

- **`__builtin_assume_aligned` / `std::assume_aligned`** (C++20) removes the alignment-check prologue/epilogue that vectorizers otherwise emit.
- **`#pragma GCC ivdep` / `#pragma clang loop vectorize(assume_safety)` / `#pragma omp simd`** assert loop-carried independence for one loop, which is narrower and safer than a function-wide `restrict`.
- **Passing by value or copying to locals** lets the compiler keep values in registers with no aliasing question at all — often the simplest fix.
- **Using distinct types** helps only via strict aliasing (§40.8), which does not distinguish two `int*`.
- **Reducing pointer traffic** — indexing into one buffer, or using `std::span` over a single allocation — sidesteps the problem structurally.

The **`char*` pessimization** deserves a mention: `char`, `unsigned char`, `std::byte`, and (usually) `uint8_t` alias *everything* (Ch. 3 §3.8), so a serializer written over `uint8_t*` forces the compiler to assume every store invalidates every cached load. In hot parsers this shows up as reloads of loop-invariant values. `__restrict` on the byte pointer is the standard fix.

---

## 40.8 Strict-Aliasing Optimizations

**Strict aliasing** is the type-based half of alias analysis: the compiler assumes objects of unrelated types do not overlap in memory, so it may keep a value in a register across a store through an unrelated pointer type (Ch. 3 §3.8 has the formal rule).

```cpp
int f(int* i, float* g) {
    *i = 1;
    *g = 2.0f;      // assumed not to touch *i
    return *i;      // folded to `return 1` — no reload
}
```

This is enabled by `-fstrict-aliasing`, which is **on by default at `-O2` and above** in GCC and Clang.

**What the optimizer does with it, concretely:**

- **Load elimination / store-to-load forwarding at the IR level** — the `return 1` above.
- **Reordering loads across stores**, which is what makes software pipelining and vectorization of mixed-type loops possible.
- **Better vectorization**, because a `float*` write loop is known not to disturb an `int*` accumulator.

**What defeats it (and what it defeats):**

- Any access through `char*`/`unsigned char*`/`std::byte*` — these alias everything, so the compiler must be fully conservative for those accesses.
- `-fno-strict-aliasing` disables the whole thing. The Linux kernel and a lot of legacy C are built this way. It is a legitimate engineering decision (large existing codebase, unclear pun sites) with a real, measurable cost, mostly in numeric and parsing loops.
- Unions: formally UB in C++ for punning, but GCC and Clang document union punning as a supported extension and their alias analysis handles it correctly.

**The failure signature is distinctive:** code that produces correct results at `-O0`/`-O1` and wrong results at `-O2`, where the wrong value is a *stale* one — a value the code wrote through a different-typed pointer that was never reloaded. It typically appears in hand-rolled bit manipulation of floats, in old network parsers doing `ntohl(*(uint32_t*)ptr)`, and in ad-hoc object pools that reuse storage for different types.

**The correct toolkit** (recapped from Ch. 3 §3.8, which has the full table): `std::bit_cast` (C++20, zero cost, `constexpr`), `memcpy` (always legal, always recognized and elided), `std::start_lifetime_as` (C++23) for buffers of bytes you received from `read`/`mmap`.

**Detection.** GCC's `-Wstrict-aliasing=2` catches some cases but has significant false-negative and false-positive rates; there is no sanitizer for it. The practical detection method is a **differential test**: build the same test suite at `-O0 -fno-strict-aliasing` and at `-O2 -fstrict-aliasing` and compare outputs (Ch. 57 §57.3). Divergence is a strict-aliasing or UB bug essentially every time.

**Low-latency angle:** parsers are where this bites. The correct pattern is a `memcpy` of the field out of the buffer into a properly-typed local — which compiles to exactly one `mov` — rather than a `reinterpret_cast` that both violates aliasing and may be misaligned. Ch. 51 §51.9 covers zero-copy deserialization done legally.

---

## 40.9 Profile-Guided Optimization

**PGO** feeds real execution data back into the compiler so its cost models use measured probabilities instead of static guesses. It is the highest-leverage single build change for a large C++ binary — typically **5–20% end-to-end**, with the gains concentrated in front-end-bound workloads (large binaries with many branches and poor I-cache locality — i.e. exactly a trading system's message-handling paths).

**The instrumentation workflow:**

```bash
# 1. Instrumented build
clang++ -O2 -fprofile-generate=./prof -o app.inst app.cpp
g++     -O2 -fprofile-generate       -o app.inst app.cpp

# 2. Run a representative workload (this is the hard part)
./app.inst --replay market-data-capture.pcap

# 3. Merge (Clang only; GCC writes .gcda directly)
llvm-profdata merge -output=app.profdata ./prof/*.profraw

# 4. Optimized build
clang++ -O2 -fprofile-use=app.profdata -o app app.cpp
g++     -O2 -fprofile-use              -o app app.cpp
```

**What PGO changes:**

| Decision | Without profile | With profile |
|---|---|---|
| Branch layout | Static heuristics | Actual taken rates; hot path laid out straight-line |
| Inlining | Size-based threshold | Hot call sites inlined far past the normal threshold; cold call sites not inlined at all |
| Basic block placement | Source order | Hot blocks contiguous; cold blocks moved to `.text.unlikely` |
| Function ordering | Link order | Hot functions grouped, improving I-TLB and I-cache locality |
| Loop unrolling | Static trip-count guess | Measured trip counts |
| Indirect call promotion | Nothing | **Speculative devirtualization**: if 90% of calls through a function pointer or vtable go to one target, emit `if (target == F) F(...) else indirect(...)` — the inline-cache transformation, which then permits inlining `F`. This is often the single biggest PGO win in polymorphic C++. |
| `switch` lowering | Jump table vs branch tree by size | By measured case frequency |

**Practical hazards:**

- **Profile representativeness is everything.** Profiling with synthetic uniform data teaches the compiler the wrong branch distribution and can be *worse* than no profile. Profile with captured production traffic replayed deterministically (Ch. 57 §57.14).
- **Staleness.** When source changes, GCC/Clang match profiles by function control-flow-graph hash; mismatches produce `-Wmissing-profile` / `-Wprofile-instr-out-of-date` warnings and silently unprofiled functions. Regenerate profiles on a schedule and treat those warnings as errors in CI.
- **Instrumented builds are 2–5× slower** and change timing enough that timing-dependent code paths (timeouts, spin-then-park) may take different branches — a real source of unrepresentative profiles in latency systems. This is precisely what AutoFDO (§40.10) exists to fix.
- **Reproducible builds.** PGO makes the binary depend on the profile, so the profile must be a pinned, versioned build input (Ch. 44 §44.16).
- **`-fprofile-update=atomic`** is needed for correct counters in multithreaded programs; the default racy increments undercount hot paths.

---

## 40.10 AutoFDO

**AutoFDO** (sample-based / hardware-profile-based FDO) obtains the profile from **`perf` samples of an ordinary optimized production binary** rather than from an instrumented build. It removes PGO's biggest operational obstacles: no separate instrumented binary, no 2–5× slowdown, no artificial workload, and profiles can be collected continuously from production.

```bash
# 1. Build normally, but keep debug line info for attribution
clang++ -O2 -g -gline-tables-only -fdebug-info-for-profiling -o app app.cpp

# 2. Sample in production — LBR gives accurate branch-taken data
perf record -b -e cycles:u -o perf.data -- ./app        # -b = LBR / branch stacks

# 3. Convert to a compiler profile
create_llvm_prof --binary=./app --profile=perf.data --out=app.afdo   # LLVM
create_gcov      --binary=./app --profile=perf.data --gcov=app.gcov  # GCC AutoFDO

# 4. Rebuild
clang++ -O2 -fprofile-sample-use=app.afdo -o app app.cpp
g++     -O2 -fauto-profile=app.gcov       -o app app.cpp
```

**Why LBR matters.** The **Last Branch Record** is a hardware ring buffer (16–32 entries on modern Intel; ARM has BRBE) that records recent taken branches (source, destination, predicted/mispredicted, and on newer parts, cycle counts). Sampling LBR stacks gives *branch-level* frequency data rather than just PC histograms, which is what makes sample-based profiles accurate enough to drive layout and inlining. Without `-b`, AutoFDO quality degrades sharply.

**Tradeoffs vs instrumented PGO:**

| | Instrumented PGO | AutoFDO |
|---|---|---|
| Profile fidelity | Exact counts | Statistical, sample-skewed |
| Runtime overhead when profiling | 2–5× | ~1% |
| Workload realism | Whatever you can synthesize | Actual production |
| Needs debug info | No | Yes (line tables at minimum) |
| Handles timing-sensitive code | Poorly | Well |
| Typical gain | 5–20% | 3–15% (most of PGO's benefit) |

**Nuances worth knowing:**

- Sample attribution goes through **debug line info**, so inlined code is attributed via the inline stack — `-fdebug-info-for-profiling` adds the extra discriminators needed to distinguish multiple inlined copies of one function. Without it, profiles are blurred across inline instances.
- **Skid** (Ch. 43 §43.18): the sampled PC lags the actual event, which is why `cycles:u` with LBR beats naive PC sampling; precise events (`:pp`, PEBS) further reduce it.
- Google's published results have AutoFDO recovering roughly 80–90% of instrumented FDO's benefit, and it is the standard at fleet scale for exactly the operational reasons above.
- AutoFDO composes with ThinLTO (`-fprofile-sample-use` plus `-flto=thin`) and with BOLT (§40.11) — the usual production stack is **ThinLTO + AutoFDO + BOLT**, applied in that order.

---

## 40.11 BOLT Post-Link Optimization

**BOLT** (Binary Optimization and Layout Tool, from Meta, now in the LLVM project) rewrites an **already-linked** binary using a `perf` profile. It operates after the linker, which is precisely where whole-binary code layout can be done optimally — the compiler sees one TU at a time and even LTO does not control final placement across the whole `.text`.

```bash
# 1. Link with relocations preserved so BOLT can move code safely
clang++ -O2 ... -Wl,--emit-relocs -o app app.o

# 2. Profile the real binary
perf record -e cycles:u -j any,u -o perf.data -- ./app     # -j any,u = LBR branch stacks
perf2bolt -p perf.data -o app.fdata ./app

# 3. Rewrite
llvm-bolt ./app -o app.bolt -data=app.fdata \
    -reorder-blocks=ext-tsp -reorder-functions=hfsort+ \
    -split-functions -split-all-cold -icf=1 -use-gnu-stack
```

**What BOLT does that the compiler cannot:**

1. **Basic-block reordering with the ext-TSP layout algorithm**, minimizing taken branches on the hot path across the whole function.
2. **Hot/cold function splitting.** The cold portions of hot functions are physically moved to a separate `.text.cold` region far away, so the hot region packs densely into fewer I-cache lines and fewer 4 KB (or 2 MB) instruction pages.
3. **Whole-binary function reordering** (`hfsort+`), grouping functions that call each other so they share I-TLB entries and huge pages.
4. **Indirect call promotion**, PLT optimization, and identical code folding (§40.19) at the binary level.
5. **Huge-page-backing `.text`** (`-hugify`), which alone can be worth several percent on binaries with large hot code footprints (Ch. 32 §32.10, Ch. 28 §28.16).

**Reported gains:** Meta reports 2–8% on large services on top of an already PGO+LTO-optimized binary; the mechanism is almost entirely **front-end** — reduced I-cache misses, I-TLB misses, and taken branches. If `perf stat` shows your workload is not front-end bound (`topdown-fe-bound` low, `L1-icache-load-misses` low, `iTLB-load-misses` low), BOLT will do nothing for you. Conversely, a multi-megabyte trading binary with a hot path scattered across dozens of TUs is the ideal case.

**Operational caveats:**

- Requires `--emit-relocs` (or `-Wl,-q`) at link time; forgetting it means BOLT refuses or works in a degraded mode.
- Rewrites the binary, so build IDs change and **symbolization/unwinding must be re-validated** (Ch. 41 §41.15, Ch. 58 §58.7). BOLT updates DWARF but historically imperfectly; verify your crash handler still produces usable stacks on the BOLTed binary.
- Interacts with anything doing runtime code introspection, self-modifying code, or hard-coded offsets.
- Should be applied *after* LTO and PGO, not instead of them — they are complementary: LTO gives cross-TU inlining, PGO gives per-function decisions, BOLT gives whole-binary layout.

---

## 40.12 Dead-Code Elimination

**Dead-code elimination (DCE)** removes computations whose results are never observed. Related passes: **unreachable code elimination** (code no control path reaches), **dead store elimination** (a store overwritten before any read), and **aggressive DCE** (removes a computation unless proven live, so it can delete whole dependency chains).

```cpp
int f(int x) {
    int a = x * 2;      // dead — never used
    int b = x + 1;
    if (false) return 0;// unreachable
    return b;
}
// →  return x + 1;
```

DCE is mostly an *enabler cleanup*: it is what makes inlining, constant propagation, and `if constexpr` pay off, by deleting the branches those passes prove unreachable.

**The three consequences that matter in practice:**

1. **DCE deletes your benchmark.** A microbenchmark whose result is unused compiles to nothing, and you measure an empty loop.

```cpp
// Wrong: the compiler deletes the whole call.
for (int i = 0; i < N; ++i) hash(data[i]);

// Right — force the value to be observed:
benchmark::DoNotOptimize(hash(data[i]));   // Google Benchmark
asm volatile("" :: "r"(v) : "memory");     // hand-rolled equivalent
```
Google Benchmark's `DoNotOptimize` and `ClobberMemory` exist purely to defeat DCE and store-sinking (Ch. 43 §43.10). Recognizing a "0.2 ns per iteration" result as a deleted benchmark is table stakes.

2. **DCE and UB together produce shocking transformations.** Because UB may be assumed not to occur, a branch that would cause UB is treated as unreachable, and *everything guarded by it* is deleted:

```cpp
int f(int* p) {
    int v = *p;                 // dereference ⇒ p is assumed non-null
    if (p == nullptr) return 0; // therefore this branch is DEAD — deleted
    return v;
}
```
This is the classic null-check-elimination miscompile family (the Linux `tun` driver CVE-2009-1897). The interview point: **UB-based DCE removes safety checks you wrote**, and the fix is to order the check before the use, not to blame the compiler.

3. **Security-relevant dead store elimination.** `memset(key, 0, len)` before `free(key)` is a dead store and gets deleted. The fixes: `explicit_bzero`, `memset_s`, `SecureZeroMemory`, or `std::memset` through a `volatile` pointer. C++ has no standard solution as of C++23.

**Verification:** the honest method is to read the disassembly (`objdump -d`, or Compiler Explorer, §40.21) and confirm the instructions you expect exist. `-Wunused-*` warnings catch source-level deadness but say nothing about what the optimizer removed.

---

## 40.13 Constant Folding and Propagation

**Constant folding** evaluates constant expressions at compile time (`3 * 4` → `12`). **Constant propagation** replaces a variable with its known constant value at each use, which creates new folding opportunities; the two iterate. **Sparse conditional constant propagation (SCCP)** does this jointly with reachability, so it propagates through branches it can prove one-sided.

```cpp
constexpr int kScale = 10000;
int f(int px) {
    int s = kScale;
    int t = s / 100;      // → 100
    return px * t;        // → px * 100 → (px<<6) + (px<<5) + (px<<2)
}
```

That last step is **strength reduction**: multiplication by a constant becomes shifts and adds (or a single `LEA` chain), and division by a constant becomes a multiply-high by a magic reciprocal plus shifts. This is a favorite disassembly-reading question — seeing `mov rax, 0x51eb851eb851eb85; mul; shr` and recognizing it as *division by 100* rather than an encryption constant (Ch. 41 §41.3).

**Where the compiler gets its constants:**

- Literals, `constexpr` / `constinit` variables (Ch. 19 §19.12), and `enum` values.
- **Inlining a call with constant arguments** (§40.4) — the dominant source in real code.
- **Interprocedural constant propagation** (§40.18), including GCC's IPA-CP *cloning*: if `f(x, 0)` is the only call, GCC clones `f.constprop.0` specialized for `x==0`. You will see these `.constprop.N` and `.isra.N` suffixes in `perf report` and disassembly, and being able to explain them is a nice signal.
- **Value range propagation (VRP)** — not full constants but proven ranges, which eliminates bounds checks and lets the compiler narrow types and remove sign-extensions.

**What defeats it:**

- **`volatile`** — every access must occur exactly as written; no folding, no caching, no elimination. This is why `volatile` is used for memory-mapped I/O and is *not* a synchronization tool (Ch. 25 §25.21).
- **Function calls the compiler cannot see** — without LTO, an external function may modify any globally reachable memory, so all such values must be reloaded after the call. This is the "escape" problem (§40.17).
- **Address-taken locals** whose address escapes.
- **Atomics with ordering** — a `seq_cst` or acquire/release access is an optimization barrier for the surrounding memory operations by design.
- **`-O0`.**

**`constexpr` vs constant folding.** `constexpr` *guarantees* compile-time evaluation in constant-expression contexts and is a language feature; constant folding is an optimization the compiler does anyway at `-O1`+. A `constexpr` function called with runtime arguments is an ordinary function. `consteval` (C++20) forces compile-time evaluation unconditionally, and `constinit` guarantees static initialization without the static initialization order fiasco (Ch. 5 §5.10). For lookup tables on hot paths, `constexpr` table construction moves the work to compile time and puts the table in `.rodata` with no initialization guard (Ch. 42 §42.5).

---

## 40.14 Common-Subexpression Elimination

**CSE** identifies expressions computed more than once with the same operand values and reuses the first result. **Local CSE** works within a basic block; **global CSE (GVN — global value numbering)** works across the control-flow graph, and **partial redundancy elimination (PRE)** additionally hoists a computation into a predecessor block so it becomes fully redundant.

```cpp
// before
int f(int a, int b) { return (a*b + 1) * (a*b + 2); }
// after CSE
int f(int a, int b) { int t = a*b; return (t+1) * (t+2); }
```

**Loop-invariant code motion (LICM)** is the loop-specific relative: it hoists computations whose operands do not change in the loop out to the preheader. LICM plus CSE is what turns naive source into tight loops, and its failure is the most common cause of "why is this loop reloading the same value every iteration".

**What defeats CSE and LICM — the practically important list:**

1. **Possible aliasing (§40.7).** If a store inside the loop may alias the loaded object, the load cannot be hoisted:
```cpp
void f(Config* cfg, int* out, size_t n) {
    for (size_t i = 0; i < n; ++i)
        out[i] = compute(cfg->scale);   // cfg->scale reloaded EVERY iteration
}                                        // because out[i] may alias *cfg
```
The fix is to hoist manually (`const int scale = cfg->scale;`) or `__restrict`. Manual hoisting of a member load into a local before a loop is one of the highest-yield micro-optimizations in real C++ code, and it is not the compiler being dumb — it is the compiler being correct.
2. **Opaque function calls.** Any call to a function whose body is invisible (no LTO) may write to anything reachable, killing every cached load across it. `__attribute__((pure))` (reads memory, no side effects) and `__attribute__((const))` (reads nothing but arguments) tell the compiler otherwise and are the standard escape hatch for math-like helpers.
3. **`volatile` and atomics** — barriers by construction.
4. **Different types, same address** — strict aliasing helps here; `char*` access hurts (§40.8).
5. **Exceptions.** A call that may throw creates an edge to a landing pad, constraining code motion; `noexcept` helps the optimizer materially and not only via the vector-reallocation path (Ch. 10 §10.3).
6. **Floating point.** `a+b+c` and `c+b+a` are not the same expression under IEEE semantics, so FP CSE and reassociation are restricted unless `-ffast-math`/`-fassociative-math` is on. This is why FP-heavy loops look under-optimized compared to integer ones.

**Register pressure caveat.** CSE extends the live range of the reused value. Too much CSE causes spills. GCC and Clang model this, but in hand-written code, hoisting twenty values before a loop can be slower than recomputing cheap ones — the classic "rematerialization is cheaper than spilling" tradeoff, especially for values recomputable in one instruction.

**Verification:** count instructions in the loop body in the disassembly and look for a `mov` reloading from the same address each iteration; `perf annotate` will show the hot reload directly (Ch. 43 §43.15).

---

## 40.15 Loop Unrolling

**Unrolling** replicates the loop body k times and adjusts the induction variable, so per-iteration overhead (the increment, the compare, the back-edge branch) is amortized over k copies.

```cpp
for (int i = 0; i < n; ++i) s += a[i];
// unrolled ×4:
for (; i + 3 < n; i += 4) { s += a[i]; s += a[i+1]; s += a[i+2]; s += a[i+3]; }
for (; i < n; ++i) s += a[i];   // remainder / epilogue loop
```

**What it actually buys** — and the loop-overhead argument is the *least* important:

1. **Breaking dependency chains.** The real win. A serial `s += a[i]` accumulator has a loop-carried dependency of one add latency (4 cycles for FP add) per element. Unrolling with **multiple accumulators** lets independent chains issue in parallel:
```cpp
double s0=0,s1=0,s2=0,s3=0;
for (; i+3<n; i+=4) { s0+=a[i]; s1+=a[i+1]; s2+=a[i+2]; s3+=a[i+3]; }
double s = (s0+s1)+(s2+s3);
```
That converts a latency-bound loop into a throughput-bound one — typically a 4× speedup (Ch. 42 §42.10). Note the compiler will *not* do this for floating point without `-ffast-math`, because it changes the summation order and therefore the result. For integers it will.
2. **Exposing instruction-level parallelism** and giving the scheduler more to work with (Ch. 27 §27.4).
3. **Enabling vectorization** (§40.16) — unrolling by the vector width is a prerequisite.
4. **Reducing branch pressure** on the BTB and front end for very short loops.

**Costs:** code size (I-cache, micro-op cache — an unrolled loop that no longer fits the DSB is a net loss), a remainder loop that costs branches for small `n`, and increased register pressure.

**Controls:**

| Directive | Effect |
|---|---|
| `-funroll-loops` | Enable for loops with known or estimated trip counts (on at `-O3`; *not* at `-O2` in GCC) |
| `-funroll-all-loops` | Including unknown trip counts — rarely a good idea |
| `#pragma GCC unroll 4` | Per-loop factor (GCC 8+) |
| `#pragma clang loop unroll_count(4)` / `unroll(disable)` | Per-loop (Clang) |
| `--param max-unroll-times`, `max-unrolled-insns` | Cost caps (GCC) |

**Non-obvious points:**

- **Modern cores make unrolling less valuable than it once was.** The loop-overhead instructions are handled by the front end and the loop-stream detector; on a loop that fits the LSD/DSB, unrolling can cost more than it saves. The dependency-chain argument survives; the overhead-amortization argument mostly does not.
- **PGO-informed trip counts** matter: unrolling ×8 a loop that averages 3 iterations is pure cost. This is one of the cleanest PGO wins (§40.9).
- **Alignment.** GCC aligns loop heads (`-falign-loops=32`); a hot loop straddling a 32-byte fetch boundary loses front-end bandwidth, and the **JCC erratum** mitigation on Skylake-era parts (`-mbranches-within-32B-boundaries`) inserts padding to avoid a specific micro-op-cache invalidation. Worth knowing by name.

---

## 40.16 Automatic Vectorization

**Auto-vectorization** converts a scalar loop into one using SIMD registers, processing multiple elements per instruction (Ch. 42 §42.6). Two forms: **loop vectorization** (across iterations) and **SLP — superword-level parallelism** (combining independent scalar operations within a block).

Widths: SSE = 128 bit (4 floats), AVX/AVX2 = 256 bit (8 floats), AVX-512 = 512 bit (16 floats). Best case is a proportional speedup on the vectorized portion, subject to Amdahl and to memory bandwidth.

**What a loop must satisfy to be vectorized:**

| Requirement | Failure mode |
|---|---|
| Countable trip count known at loop entry | `while (*p)` and early `break` prevent it (though Clang can vectorize some search loops with predication) |
| No loop-carried dependencies (or only reductions/inductions the compiler recognizes) | `a[i] = a[i-1] + 1` cannot be vectorized |
| No aliasing between read and written arrays | Emits a runtime check + scalar fallback, or gives up (§40.7) |
| Unit-stride, contiguous access | Gather/scatter is possible but often not profitable |
| No function calls in the body (unless inlined or a vector variant exists) | The single most common blocker in C++ |
| No unhandled control flow | Simple `if` bodies become masked/blended operations; complex ones block it |
| FP reassociation allowed for reductions | A `double` sum needs `-ffast-math`/`#pragma omp simd reduction` |
| Data types uniform in width | Mixed 8/32-bit widths force packing/unpacking that may not pay |

**What defeats it in real C++ code**, in rough order of frequency: non-inlined calls (including operator overloads across a TU boundary, and `std::function`), aliasing between `T*` output and input, non-contiguous data (array-of-structures instead of structure-of-arrays — Ch. 42 §42.2), FP reduction order, `int` induction variables that could overflow (signed overflow is UB so this is usually fine; `unsigned` wraps and *blocks* some transformations, a rare case where signed is better for optimization), and exceptions/virtual calls in the body.

**Diagnosing it — the key skill:**

```bash
# GCC: what happened, per loop
g++ -O3 -fopt-info-vec-optimized -fopt-info-vec-missed foo.cpp
# foo.cpp:12:21: optimized: loop vectorized using 32 byte vectors
# foo.cpp:20:5: missed: couldn't vectorize loop
# foo.cpp:21:14: missed: not vectorized: unsupported use in stmt

# Clang: remarks, machine-readable with -fsave-optimization-record
clang++ -O3 -Rpass=loop-vectorize -Rpass-missed=loop-vectorize \
        -Rpass-analysis=loop-vectorize foo.cpp
# remark: loop not vectorized: cannot identify array bounds [-Rpass-analysis=...]
```

`-Rpass-analysis=loop-vectorize` is the one that tells you *why*, and it is the answer to "how do you find out why a loop didn't vectorize?"

**Portable alternatives** when auto-vectorization is unreliable: `#pragma omp simd`, `std::experimental::simd` / C++26 `std::simd` (Ch. 15 §15.8), explicit intrinsics (Ch. 42 §42.6), or a library (Highway, xsimd, EVE). For a trading hot path, explicit intrinsics are common precisely because auto-vectorization is fragile against unrelated source changes — a refactor that adds a call silently de-vectorizes a loop with no diagnostic unless you have remarks in CI.

---

## 40.17 Escape Analysis

**Escape analysis** determines whether a pointer to an object can be observed outside a given scope. If it cannot "escape", the compiler gains several powerful permissions.

An address escapes when it is: stored into a global or a heap object, passed to an opaque (non-inlined, non-annotated) function, returned, captured by a lambda that outlives the scope, or taken by a `volatile`/atomic operation.

**What non-escape enables:**

1. **Scalar Replacement of Aggregates (SROA)** — the most valuable. A struct that never escapes is decomposed into individual values that live in registers, so the struct never exists in memory at all:
```cpp
struct P { double x, y; };
double dist(P a, P b) { P d{a.x-b.x, a.y-b.y}; return std::sqrt(d.x*d.x + d.y*d.y); }
// `d` never materializes; two xmm registers.
```
SROA is why zero-cost abstraction works: `std::optional`, `std::pair`, iterators, strong typedefs, and small wrappers all vanish *provided they are inlined and their address never escapes*.
2. **Stack promotion of heap allocations.** C++ compilers may elide `operator new`/`delete` pairs entirely (this is explicitly permitted by [expr.new], unlike C's `malloc`). Clang does this for simple non-escaping `new`; GCC less so. `std::make_unique` in a local scope whose pointer never escapes can compile to nothing at all — worth demonstrating in Compiler Explorer.
3. **Lock elision** — a mutex provably never visible to another thread can theoretically be removed. Compilers do this rarely.
4. **Register promotion of loads/stores** — non-escaping memory can be kept in registers across calls.

**Why it fails, with the practical fixes:**

| Cause | Fix |
|---|---|
| Passing `&local` to a function in another TU | LTO (§40.3), or mark the callee `pure`/`const`, or inline it |
| Storing a pointer in a member "just in case" | Don't; pass by value or by reference at the point of use |
| Capturing by reference in a `std::function` | Type-erased callables defeat everything; use a template parameter or an inlined lambda |
| Virtual call taking `this` | Devirtualize with `final`, LTO + `-fwhole-program-vtables`, or CRTP (Ch. 6 §6.19) |
| Taking the address for a debug print / assert | Guard it behind `NDEBUG`; a debug-only `&x` in a hot function can pessimize the release build if the code is compiled in |

**Diagnostic signature:** a small wrapper type that should be free shows up as stack traffic in the disassembly — `mov QWORD PTR [rsp+8], rax` for a value that ought to live in a register. Compiler Explorer with a minimal reproducer is the fastest way to confirm, and removing one escape (usually an out-of-line call) often makes the whole frame disappear.

Note the contrast with JVM/Go escape analysis, which primarily decides heap-vs-stack allocation. In C++, allocation is already explicit; escape analysis instead determines whether objects need *memory* at all. That framing answers "does C++ have escape analysis?" well.

---

## 40.18 Interprocedural Optimization

**IPO / IPA** is any optimization reasoning across function boundaries. Inlining (§40.4) is the most famous, but the non-inlining passes matter and are frequently asked about because they explain the odd symbol names you see in profiles.

| Pass | GCC flag | What it does |
|---|---|---|
| **IPA-CP** (constant propagation) | `-fipa-cp`, `-fipa-cp-clone` | Propagates constant arguments into callees; **clones** a specialized copy when profitable → `f.constprop.0` |
| **IPA-SRA** | `-fipa-sra` | Removes unused parameters and splits aggregate parameters into scalars → `f.isra.0` |
| **IPA-PTA / alias** | `-fipa-pta` | Whole-program points-to analysis, improving alias info |
| **IPA-pure-const** | `-fipa-pure-const` | Infers `pure`/`const`/`noreturn`/`nothrow` automatically |
| **IPA reference** | `-fipa-reference` | Determines which globals a function reads or writes, so calls stop killing all cached loads |
| **IPA-ICF** | `-fipa-icf` | Identical code folding (§40.19) |
| **Devirtualization** | `-fdevirtualize`, `-fdevirtualize-speculatively` | Turns virtual calls into direct calls, or into a guarded direct call plus fallback |
| **Function splitting** | `-freorder-blocks-and-partition` | Splits cold parts into `.text.unlikely` (§40.20) |

**Devirtualization is worth its own paragraph** because it's a standard interview thread. The compiler may replace a virtual call with a direct call when it can prove the dynamic type:

- **Locally**, when the object's construction is visible (`Derived d; Base& b = d; b.f();`).
- **Via `final`** on the class or the method — the cheapest and most reliable lever, and it needs no LTO.
- **Whole-program**, with LTO + `-fwhole-program-vtables`, when only one class overrides the method. Requires that no shared library can add another override, hence the interaction with visibility.
- **Speculatively**, from PGO data: `if (vptr == &Derived::vtable) Derived::f(this); else indirect();` — which then permits inlining the hot case (§40.9).

A **failed devirtualization** costs an indirect call: a load of the vptr, a load of the slot, and an indirect branch predicted by the BTB (Ch. 27 §27.9). Mispredicted, that is 15–20 cycles; and the call is an optimization barrier regardless. The low-latency answer to "how do you avoid virtual dispatch cost" is: `final` first, then CRTP or a variant-based dispatch, then LTO+PGO for the cases you cannot restructure (Ch. 55 §55.9).

**What blocks IPO generally:** separate compilation without LTO; default visibility in shared libraries (semantic interposition, §40.3); function pointers and type erasure; `dlopen`-loaded plugins that could introduce new derived types; and taking the address of a function, which forces an out-of-line copy to exist.

---

## 40.19 Identical-Code Folding

**ICF** merges functions with identical machine code into a single copy, redirecting all references. It exists mainly because C++ templates instantiate near-duplicates at scale: `std::vector<int*>`, `std::vector<Foo*>`, and `std::vector<Bar*>` generate byte-identical code after type erasure to pointer-sized operations (Ch. 17 §17.22).

**Where it happens:**

| Level | Tool/flag |
|---|---|
| Compiler (IPA) | GCC `-fipa-icf` (on at `-O2`) |
| Linker | `ld.gold --icf=all|safe`, `lld --icf=all|safe`, MSVC `/OPT:ICF` |
| Post-link | `llvm-bolt -icf=1` |

**`safe` vs `all` is the whole interview question.** C++ requires that two distinct functions have distinct addresses. Folding them makes `&f == &g` true for functions the language says are different, which breaks:

- Function-pointer identity comparisons (dispatch tables checking "is this the default handler?").
- `std::function` target comparison and callback deregistration by pointer.
- Anything using a function's address as a unique token (a common trick for type IDs without RTTI).

`--icf=safe` folds only functions whose addresses provably are never taken, or that are marked in a way the linker can prove is address-insensitive (using the `.llvm_addrsig` section that Clang emits with `-faddrsig`). `--icf=all` ignores the rule and can silently break correct code.

**Vtable folding** deserves special mention: identical vtables from different classes can be folded, which is generally fine, but it interacts with RTTI-based comparisons and with any code that compares vptrs.

**Size effect:** ICF typically removes 3–10% of `.text` in a template-heavy C++ binary, occasionally much more. The latency argument for it is I-cache and I-TLB footprint, not disk size (Ch. 28 §28.16).

**Related size reductions:**

- **`-ffunction-sections -fdata-sections` + `--gc-sections`** (§40.20) — removes *unreferenced* code, orthogonal to ICF's removal of *duplicate* code.
- **Deduplicating templates at the source level** — the "thin template" idiom: a type-erased `void*`-based implementation function plus a thin typed inline wrapper. This beats ICF because it also reduces *compile* time (Ch. 44 §44.12).
- **`extern template`** to prevent repeated instantiation across TUs (Ch. 17 §17.10).

**Verification:** `nm --size-sort -S bin` before and after; `readelf -S bin` for section sizes; and to detect a folding-induced bug, `--icf=safe` first and diff behavior against `--icf=all`.

---

## 40.20 Section Garbage Collection

**`--gc-sections`** makes the linker discard input sections that are unreachable from the entry point and other roots. It only works if the compiler put things in *separate* sections in the first place:

```bash
g++ -O2 -ffunction-sections -fdata-sections -c *.cpp
g++ -Wl,--gc-sections -Wl,--print-gc-sections -o app *.o
```

`-ffunction-sections` emits each function into its own `.text.<mangled_name>` section; `-fdata-sections` does the same for variables into `.data.<name>` / `.rodata.<name>`. The linker then treats sections as GC nodes with relocations as edges, marks from the roots, and drops the unmarked.

**Roots** are: the entry symbol, `KEEP()` directives in the linker script, `__attribute__((used))` and `retain` symbols, exported dynamic symbols, `.init_array`/`.fini_array` entries, and exception-handling data referencing a section.

**Why it matters beyond binary size:** a smaller `.text` means fewer instruction pages, better I-TLB coverage (Ch. 28 §28.16), and — combined with hot/cold splitting — a denser hot region. Typical reductions are 10–30% on binaries linking large static libraries where only a fraction of each is used.

**The section taxonomy you should be able to recite** (Ch. 41 §41.10 has full ELF detail):

| Section | Contents |
|---|---|
| `.text` | Code |
| `.text.hot` / `.text.unlikely` / `.text.startup` / `.text.exit` | Hot, cold, and run-once code split by `-freorder-blocks-and-partition`, PGO, or `[[gnu::hot]]`/`[[gnu::cold]]` |
| `.rodata` | Constants, string literals, jump tables, vtables (in `.data.rel.ro` when they need relocation) |
| `.data` | Initialized mutable globals |
| `.bss` | Zero-initialized globals — occupies no file space |
| `.init_array` | Static constructor pointers (Ch. 5 §5.10) |
| `.eh_frame` / `.eh_frame_hdr` | Unwind tables (Ch. 41 §41.16) |
| `.gcc_except_table` | Landing-pad/action tables for exceptions |
| `.comment`, `.note.*` | Metadata; strippable |

**Layout control for latency.** Placing hot code together is the goal; the mechanisms are `[[gnu::hot]]`/`[[gnu::cold]]` attributes, `[[gnu::section("name")]]` for manual placement, PGO-driven splitting, a linker `--symbol-ordering-file` (lld) or `-Wl,--sort-section`, and BOLT (§40.11) for the whole-binary version. Hot/cold splitting is the single highest-value layout transformation because cold code interleaved with hot code wastes entire cache lines and TLB entries (Ch. 41 §41.17).

**Caveats:** a symbol reachable only via `dlsym`, from inline assembly, or from a `__attribute__((constructor))` in an unreferenced TU can be collected — mark it `used`/`retain` or `KEEP` it. `--print-gc-sections` shows exactly what was dropped and is how you debug the resulting "undefined symbol at runtime" surprise. Also note that `-ffunction-sections` slightly increases object size and link time, and can interact with `.eh_frame` deduplication.

---

## 40.21 Optimization Remarks and Missed-Optimization Reports

The theme of this chapter is that optimizations are conditional; therefore **verifying which ones fired is a first-class engineering activity**, not an afterthought. There are four tiers of tooling.

### 1. Compiler remarks

```bash
# GCC — grep-friendly text, one line per decision
g++ -O3 -fopt-info-vec-optimized -fopt-info-inline-missed -fopt-info-loop-all=opt.txt f.cpp
#   groups: vec, inline, loop, ipa, omp, all ;  suffixes: -optimized -missed -note -all

# Clang — regex over pass names
clang++ -O3 -Rpass='inline|loop-vectorize' -Rpass-missed='.*' -Rpass-analysis='loop-vectorize' f.cpp

# Clang — machine-readable YAML for CI
clang++ -O3 -fsave-optimization-record f.cpp        # emits f.opt.yaml
```

`-Rpass-analysis` is the one that explains *why* a transformation did not happen; `-Rpass-missed` only says that it didn't.

### 2. opt-viewer

`llvm/tools/opt-viewer/opt-viewer.py` turns `*.opt.yaml` into an HTML source view with per-line remarks and a hotness column when the YAML was produced with a PGO profile (`-fprofile-use` + `-fsave-optimization-record`). That combination — **remarks sorted by profile hotness** — is the right way to prioritize: an un-vectorized loop that runs twice is noise; the same remark on a loop with 40% of samples is the work item.

### 3. Compiler Explorer (godbolt.org)

The fastest tool for the question "what does this actually compile to". Beyond the assembly pane:

- Multiple compilers/versions side by side, which settles "is this a GCC-only behavior" in seconds.
- **Source↔asm color mapping**, and the **"Show only source-mapped instructions"** filter.
- The **opt pipeline viewer** (LLVM IR after each pass) and **opt remarks pane**.
- Built-in **llvm-mca** and **OSACA** panes: static throughput/port-pressure analysis of a code block — cycles per iteration, port utilization, and the critical dependency chain (Ch. 27 §27.12, Ch. 42 §42.10). llvm-mca models the scheduler, not the memory hierarchy, so treat its numbers as an upper bound on front-end/execution issues only.
- Execution and `perf`-style output panes for small benchmarks.

Standard practice: reduce the question to a 20-line self-contained example, check `-O2` and `-O3` on both GCC and Clang, and confirm the transformation in the assembly rather than in the remark.

### 4. Binary and runtime verification

Remarks tell you what the compiler *thinks* it did; only these confirm reality.

| Tool | What it reveals |
|---|---|
| `objdump -d --no-show-raw-insn -M intel` | Actual instructions; whether AVX/FMA/`cmov` were emitted; whether the call is gone |
| `objdump -dS` / `perf annotate` | Source-interleaved assembly with sample attribution per instruction |
| `nm -C --size-sort -S` | Whether a symbol still exists (i.e. was not inlined away) and how big it is |
| `readelf -S` / `size -A` | Section sizes — measures the cost of `-O3` and the benefit of ICF/`--gc-sections` |
| `perf stat -e instructions,branches,branch-misses,L1-icache-load-misses,idq.dsb_uops` | Whether more inlining actually helped or blew the front end |
| `perf stat --topdown` | Whether you are front-end bound, back-end bound, bad-speculation, or retiring (Ch. 43 §43.19) |
| `llvm-mca` | Static per-block throughput and port pressure |
| `pahole` | Struct layout, indirectly gating vectorization and cache behavior (Ch. 3 §3.4) |

**Practice worth adopting:** put a remarks check in CI for a named set of hot functions — assert that specific loops still vectorize and specific calls still inline. This catches the silent de-optimization caused by an unrelated refactor, which is otherwise found weeks later as a latency regression with no obvious cause.

---

## Key Interview Questions

1. **Is `-O3` always faster than `-O2`?** — No. It adds size-increasing transforms (aggressive inlining, unrolling, vectorization) that can blow the I-cache and micro-op cache. Use `-O2` as baseline, `-O3` on measured hot TUs, and verify with `perf stat` front-end counters.
2. **Difference between `-march` and `-mtune`?** — `-march` changes which instructions may be emitted (SIGILL on older CPUs); `-mtune` only changes scheduling/heuristics and keeps the binary portable. `-march=native` implies `-mtune=native` and is a deployment hazard.
3. **Why might you deliberately avoid AVX-512?** — License-based downclocking on Skylake-SP/Cascade Lake: sustained 512-bit ops drop core frequency for tens of microseconds, penalizing scalar code in the same thread. `-mprefer-vector-width=256` keeps the ISA features without the width.
4. **What does `-ffast-math` actually change and why is it dangerous?** — It permits FP reassociation, assumes no NaN/Inf, ignores signed zeros, and sets FTZ/DAZ process-wide, affecting libraries you didn't compile. Any NaN-sentinel logic breaks silently.
5. **What does LTO enable that `-O2` cannot?** — Cross-TU inlining, interprocedural constant propagation, whole-program devirtualization, and cross-TU alias analysis. ThinLTO gets ~the same quality with parallel, cacheable link times.
6. **Does the `inline` keyword request inlining?** — No; it is an ODR/linkage directive permitting multiple definitions. Inlining is decided by a cost model; `[[gnu::always_inline]]` is the actual request.
7. **When does inlining make code slower?** — I-cache and micro-op-cache pressure, register pressure and spills, and worse layout. Signature: rising `idq.dsb_miss_ps` / front-end-bound with binary growth and no latency gain.
8. **What does `__builtin_expect` / `[[unlikely]]` do on modern x86?** — It changes *compile-time layout and optimization effort*, putting the likely path on the fall-through and moving cold bodies to `.text.unlikely`. It does not steer the hardware branch predictor; there is no architectural static hint on current cores.
9. **Why can't the compiler vectorize `out[i] = a[i] + b[i]`?** — `out` may alias `a` or `b`; it emits a runtime overlap check plus a scalar fallback, or gives up. Fix with `__restrict`, `#pragma omp simd`, or restructuring.
10. **What is UB about violating `restrict` and why is that unusually bad?** — Nothing checks it: no compiler warning, no sanitizer. You get correct results at `-O0` and silently wrong ones at `-O2`.
11. **What is the diagnostic signature of a strict-aliasing bug?** — Correct at `-O0`/`-O1`, wrong at `-O2`, with a *stale* value being used. Detect by differential-testing `-fno-strict-aliasing` against `-fstrict-aliasing`.
12. **What is PGO's biggest single win in C++ code?** — Indirect-call promotion (speculative devirtualization): guard the dominant vtable/function-pointer target and inline it. Also hot/cold block placement and profile-driven inlining.
13. **How does AutoFDO differ from instrumented PGO?** — Profile comes from `perf` LBR samples on an ordinary optimized production binary: ~1% overhead instead of 2–5×, real workloads, needs debug line info, recovers ~80–90% of the benefit.
14. **What does BOLT do that LTO and PGO cannot?** — Whole-binary basic-block and function layout after linking, hot/cold splitting into separate regions, and huge-page-backed `.text`. Purely a front-end optimization; useless if you aren't front-end bound. Needs `--emit-relocs`.
15. **How can dead-code elimination delete a null check you wrote?** — Dereferencing the pointer earlier makes non-null an assumption, so the check becomes provably false and is removed with everything it guards. Order the check before the use.
16. **Why does `memset` of a key buffer before `free` disappear?** — Dead store elimination. Use `explicit_bzero` / `memset_s` / a `volatile` pointer.
17. **Why does this loop reload `cfg->scale` every iteration?** — The store to `out[i]` may alias `*cfg`, so LICM cannot hoist the load. Hoist into a local manually, or use `__restrict`.
18. **Why unroll a loop when modern CPUs handle loop overhead cheaply?** — To break loop-carried dependency chains with multiple accumulators, converting a latency-bound loop into a throughput-bound one; FP requires `-ffast-math` since it changes summation order.
19. **How do you find out why a loop didn't vectorize?** — `-fopt-info-vec-missed` (GCC) or `-Rpass-analysis=loop-vectorize` (Clang); `-fsave-optimization-record` plus opt-viewer with a PGO profile ranks the remarks by hotness.
20. **What is escape analysis good for in C++, given allocation is explicit?** — SROA: non-escaping aggregates are decomposed into registers and never materialize in memory, which is what makes small wrappers zero-cost. It also permits eliding `new`/`delete` pairs.
21. **What are `f.constprop.0` and `f.isra.0` in a profile?** — GCC IPA clones: a copy specialized for constant arguments, and a copy with unused/scalarized parameters removed.
22. **Difference between `--icf=safe` and `--icf=all`?** — C++ requires distinct functions to have distinct addresses; `all` breaks that, so function-pointer identity comparisons silently misbehave. `safe` only folds address-insensitive functions.
23. **What does `--gc-sections` require and how can it break you?** — `-ffunction-sections -fdata-sections`; symbols reachable only via `dlsym`, inline asm, or unreferenced constructors get collected unless marked `used`/`retain` or `KEEP`ed. Debug with `--print-gc-sections`.
24. **You changed nothing but a header and latency regressed 15%. How do you find it?** — Diff the disassembly of the hot function, diff `size`/`nm` output, diff optimization remarks (this is why remarks belong in CI), and check `perf stat --topdown` for a front-end shift.

---

## Common Traps

- **Assuming `-O3` > `-O2`** without measurement; the failure mode is front-end pressure, not wrong code.
- **Shipping `-march=native`** built on a different CPU than production — SIGILL, or silently worse tuning.
- **Using `-Ofast`/`-ffast-math` in code with NaN sentinels** — comparisons against NaN are optimized away and FTZ/DAZ are set process-wide.
- **Believing `inline` requests inlining.**
- **Believing `__builtin_expect` steers the hardware branch predictor.**
- **Mis-hinting a 50/50 branch as unlikely** — relocates hot code to a cold section and adds a taken branch to the common path.
- **Mixing LTO and non-LTO objects** — silently degraded optimization with no diagnostic.
- **LTO exposing a latent ODR violation as a miscompile.**
- **Forgetting `-fno-semantic-interposition` for shared libraries** — every default-visibility function stays uninlinable.
- **Violating `restrict`** — no warning, no sanitizer, wrong answers only under optimization.
- **Type punning via `reinterpret_cast`** instead of `bit_cast`/`memcpy` — breaks at `-O2` with stale values.
- **Benchmarking a computation whose result is unused** — DCE deletes it; use `DoNotOptimize`.
- **Zeroing a secret with `memset` before free** — dead store elimination removes it.
- **PGO with unrepresentative synthetic profiles** — worse than no profile.
- **Stale PGO profiles after refactoring** — functions silently drop to static heuristics; treat the warnings as errors.
- **Forgetting `-fprofile-update=atomic`** in multithreaded instrumented builds.
- **Running BOLT without `--emit-relocs`**, or shipping a BOLTed binary without re-validating symbolization and unwinding.
- **`--icf=all` breaking function-pointer identity comparisons.**
- **`--gc-sections` collecting `dlsym`-only symbols.**
- **Relying on auto-vectorization for a hot loop** — one added function call silently de-vectorizes it, with no diagnostic unless remarks are checked in CI.
- **Reading remarks and stopping there** — confirm in the disassembly, then confirm in `perf`.

---

## Compact Recall Summary

**Levels and targets.** `-O0` debug, `-O1` cheap local passes, `-O2` production default, `-O3` adds size-growing transforms (measure — front-end pressure can lose), `-Os`/`-Oz` size, `-Og` debuggable, `-Ofast` = `-O3` + semantic FP changes. `gcc -Q --help=optimizers` is the authoritative "is X on?". `-march` selects the ISA (SIGILL risk); `-mtune` only tunes scheduling. AVX-512 risks license downclocking — `-mprefer-vector-width=256` or `-march=x86-64-v3` is the common HFT baseline.

**Cross-TU.** LTO exposes cross-TU inlining, IPA-CP, whole-program devirtualization, and better aliasing; ThinLTO makes it parallel and cacheable. `-fno-semantic-interposition` + `-fvisibility=hidden` unlocks inlining inside shared libraries. Non-LTO objects and ODR violations are the two silent failure modes.

**Inlining.** `inline` is linkage, not a request. The decision is bottom-up cost/benefit driven by callee size, constant arguments, loops in the body, and profile hotness. `always_inline` is a hard error in GCC when impossible; `noinline`+`cold` on slow paths is the hot/cold split, and `noinline` is also a profiling instrument. Over-inlining shows as DSB misses and front-end-bound.

**Hints and aliasing.** `[[likely]]`/`__builtin_expect` shape *layout and effort*, not hardware prediction. `restrict` promises non-aliasing with no diagnostic when violated; without it the vectorizer emits a runtime overlap check plus a scalar fallback. Strict aliasing lets values stay in registers across unrelated-typed stores; violating it produces stale values only at `-O2`, detected by differential builds. `char`/`byte` pointers alias everything and pessimize parsers.

**Profiles.** PGO (instrumented: exact, 2–5× slower, needs realistic input) and AutoFDO (perf+LBR on production, ~1% overhead, needs debug line info, ~80–90% of the benefit) both drive layout, inlining, unrolling, switch lowering, and — the biggest C++ win — indirect-call promotion. BOLT then does whole-binary block/function layout, hot/cold splitting, and huge-page `.text` after linking, needing `--emit-relocs`. Production stack: ThinLTO → AutoFDO → BOLT.

**Scalar passes.** DCE removes unobserved computation — it deletes benchmarks (`DoNotOptimize`), security memsets (`explicit_bzero`), and UB-provably-dead safety checks. Constant folding/propagation plus strength reduction turn `/100` into a magic-multiply; `.constprop`/`.isra` clones come from IPA-CP/IPA-SRA. CSE/GVN/LICM are defeated by possible aliasing, opaque calls, `volatile`, atomics, exceptions, and FP reassociation rules; `pure`/`const` attributes and manual hoisting are the fixes.

**Loops.** Unrolling matters mainly for breaking loop-carried dependency chains via multiple accumulators (FP needs `-ffast-math`), and it costs I-cache. Vectorization requires countable trip counts, no loop-carried dependencies, no aliasing, unit stride, no un-inlined calls, and FP reassociation for reductions; the single most common blocker in C++ is a non-inlined call.

**Whole-binary hygiene.** Escape analysis enables SROA — the mechanism behind zero-cost abstraction — and heap-allocation elision; escapes come from opaque calls, stored pointers, and type erasure. ICF folds duplicate template instantiations (`safe` vs `all` matters because C++ requires distinct function addresses). `-ffunction-sections -fdata-sections --gc-sections` drops unreferenced code, shrinking I-TLB footprint; `.text.hot`/`.text.unlikely` splitting is the highest-value layout change.

**Verification.** GCC `-fopt-info-*`, Clang `-Rpass`/`-Rpass-missed`/`-Rpass-analysis` and `-fsave-optimization-record` + opt-viewer (rank by PGO hotness), Compiler Explorer with its opt-pipeline and llvm-mca panes for reduced examples, then `objdump -d`, `nm --size-sort`, `readelf -S`, `perf annotate`, and `perf stat --topdown` to confirm on the real binary. Remarks say what the compiler intended; only the disassembly and the counters say what happened.
