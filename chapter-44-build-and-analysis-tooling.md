# Chapter 44 — Build and Analysis Tooling

*Interview-focused revision notes. The theme: C++'s failure modes are silent by default, and the build system is where you make them loud. This chapter is the toolchain that converts undefined behavior, races, leaks, ABI breaks, and compile-time waste from production incidents into build failures.*

---

## 44.1 Compiler Explorer

**Compiler Explorer** (godbolt.org, Matt Godbolt) compiles a source snippet with a chosen compiler and flags and displays the generated assembly with source-line color correspondence. It is the fastest way to answer the only question that matters about a performance claim: *what did the compiler actually emit?*

What it is used for, in rough order of value:

- **Verifying an optimization happened.** Did the ternary become a `cmov` (Ch. 42 §42.4)? Did the loop vectorize? Did RVO elide the copy (Ch. 10 §10.1)? Did the `std::function` allocate? Did the abstraction cost anything?
- **Comparing compilers and versions.** GCC, Clang, MSVC, ICX, and cross-compilers for AArch64/RISC-V side by side. "GCC 13 vectorizes this and Clang 17 does not" is a routine, checkable finding.
- **Bisecting an optimization regression** across compiler versions without installing any of them.
- **Reading library internals** — the actual `std::vector` growth code, the `libstdc++` vs `libc++` SSO layout (Ch. 13 §13.2).
- **The auxiliary views**: the LLVM **optimization-pipeline** viewer (IR after each pass), **`llvm-mca`** (static per-cycle throughput/port-pressure analysis of a block), **Compiler Explorer's "opt remarks" pane** (Ch. 40 §40.21), preprocessor output, AST dump, and the **execution** pane with `-fsanitize=` enabled.

### How to use it without fooling yourself

The dominant error is that **a Compiler Explorer snippet is not your program**. Specific ways it diverges:

- **Everything is in one translation unit and fully visible.** Real code has an opaque call across a TU boundary that blocks inlining, escape analysis, and constant propagation unless you enable LTO (Ch. 40 §40.3). Model this by marking the function `extern` or making arguments come from `volatile`/opaque sources.
- **Constant inputs get folded.** A function called with literals disappears entirely. Use `int f(int x)` with `x` from a parameter, and export the function so DCE cannot remove it — that is what the `-fno-inline`-free idiom of writing a non-`static`, non-`inline` free function accomplishes.
- **No profile data, no PGO, no BOLT** — the layout you see is not the shipping layout (Ch. 40 §40.9–§40.11).
- **`-march` matters enormously** and defaults to a conservative baseline; `-march=native` is not available (there is no fixed "native"), so you must name the target explicitly.
- **Assembly size is not speed.** Fewer instructions with a longer dependency chain is slower (Ch. 42 §42.10). Use `llvm-mca` for a static estimate, and a real benchmark (Ch. 43) for a real one.

**Local equivalents to know:** `g++ -S -masm=intel -fverbose-asm`, `objdump -dS --no-show-raw-insn`, `clang -emit-llvm -S`, `llvm-mca`, and `cppinsights.io` for what the compiler does to your *source* (implicit conversions, generated special members, lambda closure types, coroutine transforms, range-for expansion) — a genuinely useful complement when the question is semantic rather than performance.

Also: **Compiler Explorer sends your source to a server.** Self-hosting is supported and is what any firm with proprietary strategy code does.

---

## 44.2 AddressSanitizer

**ASan** (`-fsanitize=address`) is a compiler-instrumentation + runtime-library memory-error detector. It is the single highest-value tool in this chapter and should be running on your entire test suite.

### Mechanism

Two mechanisms working together:

**1. Shadow memory.** Every 8 bytes of application memory maps to 1 shadow byte at `(addr >> 3) + offset`, encoding how many of those 8 bytes are addressable (0–8) or a negative "poison" code identifying *why* they are not (redzone, freed, stack-after-return, global overflow, container-annotation). Every load and store is instrumented to check the shadow byte first — roughly two extra instructions plus a rarely-taken branch. The shadow costs **1/8 of the address space**.

**2. Redzones and quarantine.** The allocator is replaced. Each allocation is surrounded by poisoned **redzones** (default 16+ bytes) so adjacent overflow is caught. Freed memory goes into a **quarantine** (default 256 MB) rather than being reused immediately, so use-after-free is caught for as long as the quarantine holds the block — and the report includes the allocation *and* the deallocation stack traces.

### What it catches

| Error | Caught? |
|---|---|
| Heap buffer overflow/underflow | Yes (within the redzone) |
| Stack buffer overflow | Yes |
| Global buffer overflow | Yes |
| Use-after-free | Yes, while quarantined |
| Use-after-return | Only with `ASAN_OPTIONS=detect_stack_use_after_return=1` (extra cost) |
| Use-after-scope | With `-fsanitize-address-use-after-scope` (default on in Clang at `-O1`+) |
| Double free, invalid free, `new`/`free` mismatch | Yes (`alloc_dealloc_mismatch`) |
| Memory leaks | Yes — LeakSanitizer is bundled by default on Linux (§44.6) |
| `std::vector` overflow into capacity | Only with **container annotations** (libc++ `_LIBCPP_HAS_ASAN`, libstdc++ `_GLIBCXX_SANITIZE_STD_ALLOCATOR`) |
| **Uninitialized reads** | **No** — that is MSan (§44.5) |
| **Data races** | **No** — that is TSan (§44.4) |
| Integer overflow, misalignment, UB | No — that is UBSan (§44.3) |
| Overflow *within* a struct (field to field) | **No** — the fields are contiguous with no redzone between them |
| Overflow beyond the redzone into another valid allocation | **No** — a far-out-of-bounds write can land in a valid object |

### Cost and operation

- **~2× slowdown, ~3× memory** (typical; the memory factor can be worse with large quarantine).
- Build with `-fsanitize=address -fno-omit-frame-pointer -g -O1` (or `-O2`); frame pointers and `-g` are what make the reports readable, and `llvm-symbolizer` must be on `PATH`.
- Key `ASAN_OPTIONS`: `detect_leaks=1`, `halt_on_error=0` (keep going and report all), `abort_on_error=1` (get a core dump), `detect_stack_use_after_return=1`, `strict_string_checks=1`, `check_initialization_order=1` + `strict_init_order=1` (**catches the static initialization order fiasco**, Ch. 5 §5.10 — a genuinely non-obvious ASan feature), `malloc_context_size=30`, `quarantine_size_mb=`, `log_path=`.
- Suppressions via `ASAN_OPTIONS=suppressions=file`, and per-function `__attribute__((no_sanitize("address")))` for code that intentionally does something unusual.
- **ASan is incompatible with `mmap`-heavy custom allocators, huge shadow reservations under low `vm.max_map_count`, and most of the memory tricks a low-latency system uses.** Custom arenas hide errors from ASan entirely unless you call the manual poisoning API: `__asan_poison_memory_region` / `__asan_unpoison_memory_region` around your own alloc/free. **Doing this for your arena allocator is the answer that separates people who have actually deployed ASan on a trading system.**
- **HWASan** (`-fsanitize=hwaddress`, AArch64) uses top-byte-ignore tagging instead of shadow memory: ~15% memory overhead and ~2× speed, and it catches use-after-free probabilistically without a quarantine. It is the future of this on ARM, and **MTE** (Memory Tagging Extension) makes it nearly free in hardware.

**Interview point:** ASan finds *spatial and temporal* memory errors deterministically only for code paths you actually execute. It is a runtime tool; coverage is your test suite's coverage. That is why it is paired with fuzzing (Ch. 57 §57.6) — the fuzzer generates the paths, ASan detects the corruption.

---

## 44.3 UndefinedBehaviorSanitizer

**UBSan** (`-fsanitize=undefined`) is not one tool but a family of independent, individually-selectable checks, each inserting a targeted test before an operation that would be UB (Ch. 4 §4.5).

### The check groups

| Check | Catches |
|---|---|
| `signed-integer-overflow` | `INT_MAX + 1` (Ch. 2 §2.4) |
| `shift` / `shift-exponent` / `shift-base` | `x << 32`, negative shift counts, shifting into the sign bit |
| `integer-divide-by-zero` | including `INT_MIN / -1` |
| `null` | dereference, member access, method call on null |
| `alignment` | misaligned load/store/reference binding (Ch. 3 §3.3) |
| `bounds` | array index out of bounds where the bound is statically known |
| `object-size` | accesses beyond a known object size (needs optimization on) |
| `vptr` | calling a virtual function on a wrong-type or destroyed object — **catches use-after-free of polymorphic objects and bad `static_cast` down-casts**; requires RTTI and the C++ runtime |
| `return` | falling off the end of a non-void function |
| `bool` / `enum` | loading a `bool` that is not 0/1, or an enum outside its range (Ch. 3 §3.1) |
| `float-cast-overflow` | `(int)1e20` |
| `nonnull-attribute`, `returns-nonnull-attribute` | violating `__attribute__((nonnull))` |
| `pointer-overflow` | pointer arithmetic that overflows or leaves the object (Ch. 3 §3.10) |
| `unreachable` | reaching `__builtin_unreachable()`/`std::unreachable()` — **finds violated assumptions** |
| `function` | calling a function pointer through the wrong type |
| `implicit-conversion` (`-fsanitize=implicit-integer-truncation,implicit-integer-sign-change`) | **Not** UB, but a huge real-world bug source; not in `undefined` — enable explicitly |

Notably **not** covered: strict-aliasing violations (Ch. 3 §3.8), data races, uninitialized reads, most lifetime issues, and integer *unsigned* overflow (which is defined, hence `-fsanitize=unsigned-integer-overflow` is separate and off by default because it fires on legitimate hashing code).

### Cost and modes

- **Overhead is low and highly variable: typically 20%–2×**, depending on which checks and how hot the checked operations are. Much cheaper than ASan.
- **Three reporting modes**, and knowing the third is a strong signal:
  - Default: print a diagnostic and **continue** — so one run reports many problems, but the program keeps running in a UB state.
  - `-fno-sanitize-recover=undefined`: **trap and abort** on first error; correct for CI.
  - **`-fsanitize-trap=undefined` (or the legacy `-fsanitize-undefined-trap-on-error`)**: emit a bare `ud2`/`brk` with **no runtime library and near-zero code size cost**. This is what makes UBSan viable in *production* builds — you get an immediate crash with a core dump instead of silent UB, without linking the diagnostic runtime. Several security-conscious projects and the Linux kernel's UBSAN ship this way. `-fsanitize-minimal-runtime` is the middle ground: small runtime, short messages.
- Combine freely with ASan (`-fsanitize=address,undefined`); it is *not* combinable with TSan or MSan meaningfully in one binary.
- `UBSAN_OPTIONS=print_stacktrace=1` — off by default, and without it the reports are much less useful.

**The `unreachable` check is underrated:** if you wrote `std::unreachable()` or `__builtin_assume`, or the compiler inferred an assumption from `[[assume]]`, UBSan tells you when reality disagrees — a class of bug that is otherwise invisible and produces arbitrary miscompilation.

---

## 44.4 ThreadSanitizer

**TSan** (`-fsanitize=thread`) detects **data races** — two accesses to the same memory location from different threads, at least one a write, not ordered by a happens-before relation (Ch. 25 §25.1) — plus some deadlocks and misuse of thread APIs.

### Mechanism

TSan implements a **vector-clock / happens-before** algorithm (a hybrid of FastTrack and dynamic annotation). Every memory word (8 bytes) has **shadow state** holding up to 4 recent access records (thread id, epoch, size, is-write). Each thread carries a vector clock updated at synchronization operations, which TSan intercepts: mutexes, atomics, thread create/join, condvars, semaphores, and `pthread` primitives. On each access, the new access is compared against the stored shadow records; if two accesses to the same location are unordered by the clocks and at least one is a write, that is a race.

The critical property, and the usual interview question: **TSan does not report "possible" races based on lock-set heuristics; it reports races it can prove from the happens-before relation of the observed execution.** So it has essentially **no false positives** (barring custom synchronization it cannot see), but it only finds races on **executions it actually observes** — it does not explore alternative interleavings. A race in code that ran with a particular timing may not manifest as an *incorrect result*, but TSan still flags it, because it detects the *absence of ordering*, not a bad outcome. That is what makes it far more powerful than stress testing.

### Cost and limits

- **5–15× slowdown, 5–10× memory** (shadow is ~4× application memory plus metadata). Substantially heavier than ASan.
- Requires **all** code to be instrumented. Uninstrumented libraries (a vendor `.so`, a hand-written assembly ring buffer) create both blind spots and false positives, since TSan cannot see their synchronization.
- **Cannot be combined with ASan or MSan** in one binary.
- Historically limited to 64-bit Linux/macOS with specific address-space layouts; requires PIE on Linux.
- **Custom synchronization is invisible to it** — a hand-rolled spinlock built on `std::atomic` is fine (TSan understands atomics), but a seqlock (Ch. 26 §26.9), an RCU scheme, or any protocol relying on `volatile` or on inline asm fences will produce **false positives**. The fix is the annotation API:

```cpp
#include <sanitizer/tsan_interface.h>
__tsan_acquire(&obj);          // "a happens-before edge arrives here"
__tsan_release(&obj);          // "a happens-before edge departs here"
// or annotate a whole region:
__tsan_mutex_pre_lock / __tsan_mutex_post_lock / ...
// and to silence a benign-by-design race:
__attribute__((no_sanitize("thread"))) void racy_stat_counter();
```
Knowing that this API exists, and that annotating your lock-free primitives is a prerequisite for running TSan on a low-latency codebase, is exactly the practical detail interviewers probe.

- **"Benign races" are not benign.** A racy `int` counter is UB: the compiler may load it twice and get different values, invent a store, or fuse operations. If you genuinely want a racy counter, it must be `std::atomic` with `memory_order_relaxed`, which is free on x86 for loads/stores and silences TSan correctly.
- TSan also detects: destroying a locked mutex, unlocking a mutex owned by another thread, lock-order inversions (potential deadlock), thread leaks, and use of a `pthread` object after destruction.

**Alternatives:** Valgrind **Helgrind** and **DRD** (lock-set / happens-before, ~20–100× slower, more false positives, but no recompilation needed); **relacy** and **CDSChecker** for exhaustive model checking of small lock-free algorithms (Ch. 57 §57.11), which is the tool for *proving* a lock-free queue rather than testing it.

---

## 44.5 MemorySanitizer

**MSan** (`-fsanitize=memory`, Clang only) detects **reads of uninitialized memory** — the one major category ASan and Valgrind Memcheck handle differently and that has enormous security consequences (Ch. 3 §3.2: leaking padding or stack contents).

### Mechanism

MSan maintains **bit-level shadow state**: one shadow bit per application bit, recording "poisoned" (uninitialized) or clean. Shadow **propagates through computation** — if you add a poisoned value to a clean one, the result is poisoned — and MSan reports only when a poisoned value **affects observable behavior**: a branch condition, a memory address, or a syscall argument. This deferred reporting is what keeps false positives down; copying uninitialized bytes around is not an error, using them to make a decision is.

With `-fsanitize-memory-track-origins=2`, MSan also records *where* the uninitialized value originated (which allocation, which stack slot), turning "you used an uninitialized value here" into "…and it came from this `malloc` at line N". This roughly doubles the overhead again but is usually essential to acting on a report.

### The hard requirement

**Every library the program links must be instrumented, including libc++ and libstdc++.** Uninstrumented code writes memory that MSan still considers poisoned, producing a flood of false positives. In practice this means building an MSan-instrumented libc++ (`-DLLVM_USE_SANITIZER=MemoryWithOrigins` in the LLVM build, or the documented `libcxx_msan` recipe), and instrumenting every third-party dependency. **This deployment cost is the reason MSan is far less widely used than ASan**, and stating it is the mark of someone who has actually tried.

| | MSan | Valgrind Memcheck |
|---|---|---|
| Requires recompilation | **Yes**, plus instrumented deps and libc++ | No — works on any binary |
| Overhead | ~3× (2× more with origins) | **20–50×** |
| Shadow granularity | Per-bit | Per-bit (V bits) plus per-byte addressability (A bits) |
| Also finds leaks / overflows / UAF | No (leaks via LSan) | Yes — Memcheck does all of it |
| Multithreaded programs | Native speed relative to itself | Serialized; hides concurrency |
| False positives | Only from uninstrumented code | Occasional, from optimized code and inline asm |

**Practical guidance:** ASan+UBSan on everything, TSan on concurrency tests, MSan only where the uninitialized-read risk is high enough to justify the build effort — parsers of untrusted input, anything that serializes structs to the wire, and security-sensitive code. If you cannot afford the MSan build, Valgrind Memcheck gives you the same class of finding at 20–50× and zero build effort, which is often the right trade for a nightly job.

---

## 44.6 LeakSanitizer

**LSan** (`-fsanitize=leak`, or bundled into ASan on Linux where it is on by default) detects memory reachable by no pointer at process exit.

**Mechanism:** at exit (or on demand via `__lsan_do_leak_check()`), it performs a **conservative, stop-the-world, mark-and-sweep scan** from roots — globals, thread stacks, thread-local storage, and registers — treating any word that looks like a pointer into a live allocation as a reference. Anything unreached is reported with its allocation stack.

Properties:

- **Nearly zero runtime cost** during execution; the cost is one scan at exit. Standalone LSan (without ASan) is essentially free, which makes it viable to leave on in far more builds than ASan.
- **Conservative scanning means false negatives, not false positives** — an integer that happens to look like a pointer keeps a block alive and the leak goes unreported. This is the same limitation as any conservative GC.
- **Known misses:** memory reachable from an unregistered thread's stack, pointers stored only in a mangled/encoded form (XOR-linked lists, tagged pointers with the low bits set beyond the block, Ch. 3 §3.10), and memory intentionally leaked (which you suppress).
- Suppressions: `LSAN_OPTIONS=suppressions=lsan.supp` with `leak:pattern` lines, or `__lsan_ignore_object(p)`, or bracket allocations with `__lsan_disable()`/`__lsan_enable()`.
- `LSAN_OPTIONS=detect_leaks=0` disables it under ASan — commonly needed for programs that legitimately never free (single-shot tools) or that use custom allocators LSan cannot see.

**The distinction to have ready:** a leak is *memory with no remaining reference*. LSan does **not** find:
- **Unbounded growth of still-referenced memory** (a cache that never evicts, a `vector` that only grows). That is the more common production failure, and it needs Massif/heaptrack/RSS monitoring (Ch. 43 §43.23), not LSan.
- **Non-memory resource leaks** — file descriptors, sockets, mutexes, timers, shm segments. Those need `/proc/PID/fd` counting, `lsof`, or a wrapper that tracks lifetime.
- **`shared_ptr` reference cycles**, which are still-referenced and therefore not leaks by LSan's definition — even though they are exactly the leak the programmer means (Ch. 9 §9.6).

That last point is a good interview answer: *"LSan will not find a `shared_ptr` cycle, because the memory is reachable — from itself."*

---

## 44.7 Valgrind Memcheck

**Memcheck** is Valgrind's default tool: dynamic binary instrumentation (the program is JIT-translated into an instrumented form) with **no recompilation required**. It detects uninitialized reads, invalid reads/writes, invalid/double frees, mismatched `new`/`delete`/`free`, overlapping `memcpy`, and leaks — the union of what ASan, MSan, and LSan cover, in one tool.

**Mechanism:** every byte of memory has an **A bit** (addressable) and every bit has a **V bit** (defined). Loads and stores check A bits; value propagation tracks V bits exactly as MSan does, reporting only when an undefined value influences a branch, an address, or a syscall.

```bash
valgrind --leak-check=full --show-leak-kinds=all --track-origins=yes \
         --errors-for-leak-kinds=definite --error-exitcode=1 ./prog
```
Leak categories in the report: **definitely lost** (no pointer at all — a real leak), **indirectly lost** (reachable only from a definitely-lost block), **possibly lost** (only an interior pointer remains — common and usually benign for `std::string`-like types), and **still reachable** (a live pointer exists at exit; usually a singleton, not a bug).

### Memcheck versus the sanitizers

| | Memcheck | ASan + LSan + MSan |
|---|---|---|
| Recompilation | **None** — works on release binaries and third-party blobs | Required, for everything |
| Overhead | **20–50× time, ~2× memory** | ASan 2×, MSan 3×, LSan ~0 |
| Uninitialized reads | Yes, out of the box | MSan only, with an instrumented world |
| Buffer overflow detection | Only into *unaddressable* memory — **it cannot see overflow from one heap block into an adjacent one** unless the redzone catches it | ASan's redzones catch adjacent overflow reliably |
| Stack overflow (local arrays) | **Poor** — stack memory is addressable | ASan catches it |
| Global overflow | Poor | ASan catches it |
| Threads | **Serialized onto one core** — hides races and changes all timing | Native concurrency |
| Self-modifying / JIT / unusual instructions | Can fail or need flags | Fine |
| Debugging integration | `--vgdb=yes` + GDB | Standard |

**The practical rule:** *sanitizers first, Memcheck for what you cannot rebuild.* Memcheck's unique value is that it requires no build changes at all — you can point it at a production binary, a vendor library, or a customer's crashing artifact. Its unique weakness is that it serializes threads and misses stack and inter-block overflows, which is exactly what ASan is best at.

**Other Valgrind tools** relevant here: Helgrind/DRD (races, §44.4), Cachegrind/Callgrind and DHAT/Massif (Ch. 43 §43.20, §43.23), and **exp-sgcheck** (stack/global bounds, experimental and now removed).

---

## 44.8 Static Analysis

Static analysis reasons about code **without running it**, so it covers paths tests never reach — the complement to every runtime tool above. The cost is false positives, which is the entire practical problem.

### The tiers

| Tier | Tools | What it finds | False-positive rate |
|---|---|---|---|
| **Compiler warnings** (§44.9) | GCC/Clang/MSVC `-W*` | Local, syntactic, type-level | Very low |
| **Linters / style + simple checks** | `clang-tidy`, `cppcheck`, `cpplint` | Modernization, naming, obvious bug patterns, some flow analysis | Low–medium |
| **Path-sensitive symbolic execution** | **Clang Static Analyzer** (`scan-build`, `clang --analyze`), `cppcheck --enable=all` | Null deref, leaks, use-after-free, uninitialized reads *along a specific path* | Medium |
| **Whole-program / abstract interpretation** | Coverity, PVS-Studio, Klocwork, Polyspace, Infer, CodeQL | Cross-TU dataflow, taint, resource-lifecycle, concurrency | Medium; tuned by suppression baselines |
| **Formal/verification** | Frama-C, CBMC, `constexpr` evaluation, contracts (Ch. 19 §19.13) | Proofs of specific properties | Zero FP by construction, huge effort |

**Clang-tidy** is the practical workhorse:
```bash
clang-tidy -p build/ src/*.cpp --checks='-*,bugprone-*,cert-*,clang-analyzer-*,performance-*,modernize-*,cppcoreguidelines-*'
```
It requires `compile_commands.json` (CMake: `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`), supports `--fix` for many checks, and honors `// NOLINTNEXTLINE(check-name)` with a required reason in disciplined setups. Check families worth naming: `bugprone-use-after-move`, `bugprone-dangling-handle` (the `string_view`/`span` lifetime bug, Ch. 13 §13.3), `bugprone-branch-clone`, `performance-unnecessary-value-param`, `performance-move-const-arg`, `cppcoreguidelines-pro-type-reinterpret-cast`, `misc-const-correctness`, `concurrency-mt-unsafe`.

**Clang thread-safety analysis** (`-Wthread-safety`) is a distinct, underused facility worth naming separately: annotations (`GUARDED_BY(mutex_)`, `REQUIRES(mu)`, `ACQUIRE()`, `RELEASE()`) let the compiler *statically* verify that every access to a member happens with the right lock held, with essentially zero false positives and zero runtime cost. It is the cheapest concurrency-correctness tool in existence and it catches the class of bug TSan needs a 15× slowdown and a lucky interleaving to find.

### Making it stick

The failure mode of static analysis is organizational, not technical: 5000 findings on first run, everyone ignores them, the tool is disabled. The working pattern:

1. **Baseline** existing findings as accepted (Coverity, CodeQL, and clang-tidy-diff all support this).
2. **Gate only new code** — `clang-tidy-diff.py` against the merge base, or `git diff | clang-format --diff`.
3. **Zero-warning policy on the diff**, ratcheting the baseline down over time.
4. **Require a written justification for every suppression**, in the code.

Also worth knowing: **sanitizer-guided coverage and fuzzing (Ch. 57 §57.6) is the third leg** — static analysis for unreachable paths, fuzzing to generate reachable ones, sanitizers to detect corruption when they are reached. A candidate who frames the three as complementary rather than competing is answering the question correctly.

---

## 44.9 Compiler Warnings

The cheapest analysis available and the one most often left half-configured.

### The baseline set

```
-Wall -Wextra -Wpedantic          # start here; -Wall is nowhere near "all"
-Werror                           # in CI; optionally not in local dev builds
```

Beyond the defaults, the ones that actually catch bugs:

| Flag | Catches |
|---|---|
| `-Wshadow` | A local shadowing a member or outer variable — a classic silent bug |
| `-Wconversion` `-Wsign-conversion` | Implicit narrowing and sign changes (Ch. 2 §2.2). Noisy, but this is where integer bugs live |
| `-Wold-style-cast` | C casts hiding a `reinterpret_cast` (Ch. 2 §2.18) |
| `-Wnon-virtual-dtor` | Deleting through a base pointer without a virtual destructor (Ch. 6 §6.13) |
| `-Woverloaded-virtual` | A derived function hiding rather than overriding |
| `-Wsuggest-override` / `-Winconsistent-missing-override` | Missing `override` |
| `-Wfloat-equal` | `==` on floating point (Ch. 23 §23.8) |
| `-Wcast-align` | A cast that increases required alignment (Ch. 3 §3.3) |
| `-Wformat=2` `-Wformat-security` | printf format/argument mismatches and non-literal formats |
| `-Wnull-dereference` | Provable null derefs (needs optimization) |
| `-Wduplicated-cond` `-Wduplicated-branches` `-Wlogical-op` (GCC) | Copy-paste errors in conditionals |
| `-Wuseless-cast` (GCC) | Casts that do nothing |
| `-Wdouble-promotion` | Accidental `float`→`double` in embedded/SIMD code |
| `-Wpadded` | Where the compiler inserted padding (Ch. 3 §3.4) — noisy, use on hot structs |
| `-Wlifetime` / `-Wdangling-gsl` (Clang) | Dangling references from temporaries |
| `-Wthread-safety` (Clang) | Annotated lock discipline (§44.8) |
| `-Wimplicit-fallthrough` | Missing `break`; silence intentionally with `[[fallthrough]]` |
| `-Wstrict-aliasing=3` | Some aliasing violations — weak; do not rely on it (Ch. 3 §3.8) |
| `-D_GLIBCXX_ASSERTIONS` / `-D_LIBCPP_HARDENING_MODE=...` | **Runtime** bounds checks in the standard library — cheap and catches `operator[]` overruns |
| `-D_FORTIFY_SOURCE=3` (with `-O2`) | Compiler-checked `memcpy`/`sprintf` bounds where the size is knowable |
| `-fstack-protector-strong`, `-fstack-clash-protection`, `-fcf-protection` | Hardening (small cost, non-zero on hot paths) |

### The judgment questions

- **`-Werror` in CI, yes; in developer builds, contentious.** It turns a new compiler version into a build break for the whole team. The standard resolution is `-Werror` in CI only, with a pinned compiler version (§44.16).
- **`-Wconversion` is the highest-value/highest-noise flag.** Enabling it on a mature codebase produces thousands of findings, most benign and some genuine (a `size_t` to `int` truncation in a length field is a remote-code-execution primitive, Ch. 51 §51.12). Introduce it per-directory.
- **Warnings are not portable.** GCC and Clang disagree substantially; MSVC's `/W4 /permissive-` is a separate axis. Compile in CI with **both** GCC and Clang precisely because their warning sets and their UB exploitation differ — this is a cheap and effective bug-finding strategy in its own right.
- **`-Wall -Wextra` misses the important ones.** Being able to name `-Wshadow`, `-Wconversion`, `-Wnon-virtual-dtor`, and `-Wold-style-cast` as deliberate additions is the expected answer.

---

## 44.10 The CMake Target Model

Modern CMake (≥ 3.15, practically ≥ 3.20) is built on **targets carrying usage requirements**, replacing the old directory-scoped, variable-mutating style.

```cmake
cmake_minimum_required(VERSION 3.20)
project(feedhandler LANGUAGES CXX)

add_library(core STATIC src/book.cpp src/parser.cpp)
target_include_directories(core
    PUBLIC  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
            $<INSTALL_INTERFACE:include>
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_features(core PUBLIC cxx_std_20)
target_link_libraries(core PUBLIC fmt::fmt PRIVATE ZLIB::ZLIB)
target_compile_options(core PRIVATE -Wall -Wextra -Werror)

add_executable(feedhandler src/main.cpp)
target_link_libraries(feedhandler PRIVATE core)
```

### The rules that matter

- **Everything attaches to a target**, never to a directory. `include_directories()`, `add_definitions()`, `link_libraries()`, and mutating `CMAKE_CXX_FLAGS` are the anti-patterns; they leak into unrelated targets and cannot be exported.
- **`target_link_libraries` does far more than link.** It propagates include directories, compile definitions, compile options, compile features, and link options according to the PUBLIC/PRIVATE/INTERFACE keyword (§44.11).
- **Namespaced targets (`Foo::Bar`)** are the correct way to reference dependencies: CMake errors immediately if a namespaced target does not exist, whereas a bare name silently falls through to a raw `-lname` at link time — turning a configure-time error into a confusing link-time one. **Always use the namespaced form.**
- **Generator expressions** (`$<...>`) defer evaluation to generate time, which is how you express per-configuration and per-language flags in a multi-config generator: `$<$<CONFIG:Release>:-O3>`, `$<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>`, `$<BUILD_INTERFACE:...>` vs `$<INSTALL_INTERFACE:...>`.
- **`INTERFACE` libraries** carry requirements with no sources — the standard way to express a header-only library or a shared "project options" bundle:
```cmake
add_library(project_options INTERFACE)
target_compile_options(project_options INTERFACE -Wall -Wextra -Wconversion)
target_compile_features(project_options INTERFACE cxx_std_20)
# then: target_link_libraries(core PRIVATE project_options)
```
- **`ALIAS` targets** (`add_library(Foo::core ALIAS core)`) let in-tree consumers use the same namespaced name as installed consumers, so `add_subdirectory` and `find_package` are interchangeable.
- **Presets** (`CMakePresets.json`, CMake 3.19+) replace ad-hoc shell wrappers and make the exact configure/build/test invocation reproducible and shareable — the modern answer to "how does someone else build this the same way you do".
- **`CMAKE_EXPORT_COMPILE_COMMANDS=ON`** produces `compile_commands.json`, which clang-tidy, clangd, IWYU, and every modern tool require.
- For sanitizer builds, define a build type or an option, never hand-edit flags: `target_compile_options(x PRIVATE -fsanitize=address)` **and** `target_link_options(x PRIVATE -fsanitize=address)` — forgetting the link side is the single most common CMake sanitizer mistake, producing undefined symbol errors from the sanitizer runtime.

---

## 44.11 PUBLIC, PRIVATE, and INTERFACE Dependencies

The three keywords express **who needs this requirement**, and getting them right is what makes a large build both correct and fast.

```
                 Used to BUILD this target?    Propagated to CONSUMERS?
PRIVATE                  yes                            no
INTERFACE                no                             yes
PUBLIC                   yes                            yes      (= PRIVATE + INTERFACE)
```

**The decision rule:** the distinction is whether the dependency appears in your **headers** (your interface) or only in your **`.cpp` files** (your implementation).

```cpp
// core/include/core/book.hpp
#include <fmt/core.h>            // fmt appears in the INTERFACE  → target_link_libraries(core PUBLIC fmt::fmt)
class Book { ... };

// core/src/book.cpp
#include <zlib.h>                // zlib is an implementation detail → PRIVATE ZLIB::ZLIB
```

### Why it matters beyond correctness

- **Compile time.** A `PUBLIC` dependency injects its include directories into every consumer, and transitively into *their* consumers. A `PUBLIC` heavyweight header (Boost, a protobuf-generated header) can multiply the parse cost of the entire build (§44.12). Marking dependencies `PRIVATE` wherever possible is a direct compile-time optimization.
- **Rebuild scope.** Changing a `PUBLIC` dependency's headers rebuilds everything downstream; changing a `PRIVATE` one rebuilds only your target.
- **ABI surface.** A `PUBLIC` dependency's types appear in your ABI, so its version becomes part of your compatibility contract (§44.17).
- **Static-library link ordering.** With static libraries, `PRIVATE` still propagates the *link* requirement (because a static archive does not resolve its own dependencies), while include directories and definitions do not propagate. CMake handles the `$<LINK_ONLY:...>` distinction for you — one of the genuinely valuable things the target model does automatically.

**Practical guidance:** default to `PRIVATE`. Promote to `PUBLIC` only when a header forces you to, and treat every promotion as a design decision. Use PIMPL (§44.14) to demote a `PUBLIC` dependency to `PRIVATE` when the cost justifies it. `INTERFACE` is for header-only libraries and for option-bundle targets that have no sources of their own.

---

## 44.12 Reducing C++ Compile Times

Compile time is a first-order productivity cost and, at scale, a real infrastructure cost. The causes and their remedies:

### Where the time goes

1. **Preprocessed source volume.** A single `#include <vector>` pulls in tens of thousands of lines; `<iostream>`, `<regex>`, `<ranges>`, and most of Boost pull in hundreds of thousands. Measure with `g++ -E file.cpp | wc -l` and `-H` (include tree) or `clang -H`.
2. **Template instantiation.** Each distinct instantiation is a separate parse-and-codegen; deep metaprogramming and heavy `std::variant`/`std::tuple`/`ranges` usage dominate (Ch. 17 §17.22).
3. **Codegen and optimization**, especially with LTO — this is the link phase, and it is often the serial bottleneck at the end of a parallel build.
4. **Linking.** The default `bfd` linker is slow and single-threaded.

### The measurement tools (do this before optimizing)

```bash
clang -ftime-trace file.cpp                # per-TU Chrome-trace JSON: exact cost of each header and template
                                           # aggregate with ClangBuildAnalyzer for a whole-project ranking
g++ -ftime-report -Q                       # per-pass timings
clang -H / g++ -H                          # include tree with nesting depth
ninja -t graph / ninja_explain             # dependency-graph and rebuild-reason analysis
include-what-you-use (IWYU)                # which includes are actually needed
```
`-ftime-trace` plus **ClangBuildAnalyzer** is the answer to "how would you find why our build is slow" — it ranks headers by total parse cost across the project and templates by total instantiation cost, which is otherwise guesswork.

### The remedies, by leverage

| Remedy | Typical gain | Cost |
|---|---|---|
| **Ninja instead of Make** | 10–30% wall time; far better incremental | None |
| **`mold` / `lld` instead of `bfd`** | Link 5–50× faster | None (mold: `-fuse-ld=mold`) |
| **ccache / sccache** | Near-instant rebuilds of unchanged TUs | Cache storage; needs `-fdebug-prefix-map` and determinism (§44.15) |
| **distcc / icecc / a remote build cluster** | Linear in workers for compile | Infrastructure |
| **Forward declarations + PIMPL** (§44.14) | Large, by cutting the include graph | Indirection cost |
| **Reduce `PUBLIC` deps to `PRIVATE`** (§44.11) | Large, and free | Design discipline |
| **`extern template`** (Ch. 17 §17.10) | Removes duplicated instantiation across TUs | Must instantiate in one TU |
| **Unity builds** (§44.13) | 2–5× full-build speedup | Terrible incremental builds; ODR hazards |
| **Precompiled headers** (§44.13) | 20–50% on include-heavy code | Fragile, per-config |
| **Modules** (Ch. 19 §19.6) | The real fix: parse once, import many | Toolchain and build-system maturity |
| **Split large TUs** | Better parallelism | More files |
| **Avoid `<iostream>`, `<regex>`, heavy Boost in headers** | Direct | `std::format`/`fmt` instead (Ch. 16 §16.3) |
| **Disable RTTI/exceptions where genuinely unused** | Small compile gain, some size gain | Semantics change (Ch. 10 §10.8) |
| **Thin LTO instead of full LTO** | Much faster link, most of the benefit | Slightly less optimization (Ch. 40 §40.3) |
| **Debug info: `-g1`, `-gsplit-dwarf`, `--gdb-index`** | Large link-time and disk gains | Less debug detail / extra files (Ch. 58 §58.6) |

**The non-obvious ones worth stating:** `-gsplit-dwarf` moves debug info out of object files into `.dwo` files so the linker never reads it — often the largest single link-time win on a debug build; and **the physical design principle** (Lakos): the compile-time cost of a header is paid by every TU that includes it, so the leverage is in *removing an include from a widely-included header*, not in optimizing a rarely-compiled file. Rank by `(parse cost) × (number of TUs including it)`, which is precisely what ClangBuildAnalyzer reports.

---

## 44.13 Precompiled Headers and Unity Builds

Two blunt instruments that trade properties you may not want to trade.

### Precompiled headers (PCH)

A PCH is a serialized snapshot of the compiler's internal state after parsing a fixed set of headers; subsequent TUs load it instead of re-parsing.

```cmake
target_precompile_headers(core PRIVATE <vector> <string> <memory> "common/types.hpp")
```

- **Gain:** 20–50% on include-heavy code, sometimes more.
- **Constraint:** the PCH must be included **first**, before anything else, in every TU. CMake injects it via `-include`.
- **Fragility:** a PCH is valid only for the exact compiler version, flags, macro definitions, and target. Any flag mismatch silently invalidates it or, worse, produces an obscure error. It must be rebuilt whenever any header inside it changes, so **putting a frequently-modified project header in the PCH is a self-inflicted full rebuild**.
- **PCH hides missing includes.** A TU that compiles only because the PCH provided `<string>` breaks for anyone not using the PCH, and IWYU/modules migrations expose a mountain of these.
- **Only put stable, external headers in it** — standard library and third-party.

### Unity builds (jumbo builds)

Concatenate N translation units into one and compile it once.

```cmake
set_target_properties(core PROPERTIES UNITY_BUILD ON UNITY_BUILD_BATCH_SIZE 16)
```

- **Gain:** 2–5× on a full build, because each shared header is parsed once per *batch* instead of once per TU, and template instantiations are shared. It also improves optimization (everything in a batch is effectively LTO'd for free) and shrinks the binary via deduplication.
- **The cost is incremental builds:** editing one `.cpp` rebuilds its whole batch. On a codebase where developers do small incremental edits all day, this is a net loss.
- **The correctness hazards are real:**
  - **Anonymous-namespace and `static` symbols collide** across formerly-separate TUs — two files each defining `static int counter;` or an unnamed-namespace `helper()` now conflict or, worse, silently share.
  - **Macro leakage.** A `#define` in one file (or a `#undef`, or `#define private public` in a test) now affects the next file in the batch.
  - **`using namespace` at file scope** leaks into the following files, changing overload resolution silently — the worst case, because it compiles and behaves differently.
  - **Include-order dependence.** Files that compiled only because of an accidental include order now break, or vice versa.
  - **ODR violations become linkable.** A type defined differently in two TUs (guarded by different macros) is UB either way, but unity builds can turn it from a silent hazard into a compile error — arguably a benefit.
- **CI implication:** if you unity-build in CI but not locally (or vice versa), you have two different programs. Pick one, or build both.

**The strategic answer:** PCH and unity builds are workarounds for the textual `#include` model. **C++20 modules** (Ch. 19 §19.6) are the actual fix — a BMI is parsed once and imported by name, with no macro leakage, no include-order dependence, and no ODR-by-accident. Toolchain support (GCC 14+, Clang 17+, MSVC, CMake 3.28+ with `CXX_MODULES` and P1689 dependency scanning) is now real but the standard library module (`import std;`) and third-party ecosystem lag. Being able to say *why* modules solve the problem that PCH and unity builds paper over is the point of this section.

---

## 44.14 PIMPL

**PIMPL** ("pointer to implementation", the compilation firewall) hides a class's data members and its dependencies behind an opaque pointer, so the header exposes only the interface.

```cpp
// book.hpp — no expensive includes, no member types visible
#include <memory>
class Book {
public:
    Book();
    ~Book();                                  // MUST be declared here, defined in the .cpp
    Book(Book&&) noexcept;                    // and the move operations too
    Book& operator=(Book&&) noexcept;
    void add(int64_t px, uint32_t qty);
    int64_t best_bid() const;
private:
    struct Impl;
    std::unique_ptr<Impl> p_;
};
```
```cpp
// book.cpp
#include "book.hpp"
#include <map>                                // heavy includes live HERE only
struct Book::Impl { std::map<int64_t, uint32_t> bids, asks; };
Book::Book() : p_(std::make_unique<Impl>()) {}
Book::~Book() = default;                      // defined where Impl is complete
Book::Book(Book&&) noexcept = default;
Book& Book::operator=(Book&&) noexcept = default;
```

### The destructor rule

This is the classic interview trap. `std::unique_ptr<Impl>`'s default deleter requires `Impl` to be **complete** at the point the destructor is instantiated. If you let the compiler generate `~Book()` implicitly in the header, it is instantiated where `Impl` is incomplete — `static_assert` failure ("invalid application of `sizeof` to an incomplete type") or, historically, silently calling `delete` on an incomplete type, which is UB and skips the destructor. **Declare the destructor (and move operations) in the header and define them in the `.cpp` where `Impl` is complete.** Declaring the destructor also suppresses the implicit move operations, which is why you must declare those too.

### What it buys and what it costs

| Benefit | Cost |
|---|---|
| Header has no heavy includes → faster compiles for every consumer (§44.12) | **An extra pointer indirection on every member access** — a guaranteed cache miss if the impl is not hot |
| Changing private members does not recompile consumers | **A heap allocation per object** (and one per copy) |
| **ABI stability**: the class size and layout stop being part of the interface (§44.17) | Non-inlinable member functions (the definition is in another TU, absent LTO) |
| Reduces the rebuild blast radius of an edit | Copy requires a hand-written copy constructor; the type is move-only by default |
| Hides implementation details from consumers | Debuggers and profilers see an extra layer |

**Where it belongs and does not:** PIMPL is for **library boundaries and cold classes** — configuration objects, session managers, anything constructed rarely and called at a low rate. It is categorically wrong for a hot-path type (Ch. 55): an extra indirection and a heap allocation per object on a critical path is exactly what the rest of this book tells you to eliminate.

**Alternatives to name:**
- **Interface + factory** (abstract base class, `create()` returning `unique_ptr<Interface>`) — the same firewall, at the cost of virtual dispatch instead of an indirection; also gives you polymorphism you may not want.
- **Fast PIMPL / inline PIMPL** — an `alignas(N) std::byte storage[N]` buffer sized by a `static_assert`, with placement `new`, avoiding the allocation but reintroducing a fragile size constant that must be updated when `Impl` grows.
- **Modules** (§44.13) reduce the *compile-time* motivation for PIMPL substantially, but not the *ABI-stability* motivation, which is the more durable reason.

---

## 44.15 Reproducible and Hermetic Builds

**Reproducible build:** the same source and the same declared inputs produce a **bit-identical** output artifact. **Hermetic build:** the build depends only on declared inputs — not on the host's installed packages, environment variables, network, clock, or filesystem layout.

They are distinct: hermeticity is the property that makes reproducibility achievable and is the more important one operationally.

### What breaks reproducibility, and the fix

| Source of nondeterminism | Fix |
|---|---|
| `__DATE__`, `__TIME__`, `__TIMESTAMP__` | Ban them (`-Wdate-time` warns); use `SOURCE_DATE_EPOCH` for anything that must embed a date |
| Absolute paths embedded in debug info and assertions | `-ffile-prefix-map=/build/path=.` (covers `-fdebug-prefix-map` and `-fmacro-prefix-map`) |
| Build path in `__FILE__` | `-fmacro-prefix-map` |
| Archive/`ar` timestamps, uids, ordering | `ar D` (deterministic mode; the default in most distros), `--enable-deterministic-archives` |
| Filesystem readdir order feeding the file list | Sort inputs explicitly; never glob without sorting (`file(GLOB)` in CMake is discouraged for this and for dependency reasons) |
| Parallel-build nondeterminism in link/section order | Fixed link order; deterministic linkers |
| ASLR / address-dependent hashing during codegen (e.g. pointer-keyed maps in the compiler) | Modern GCC/Clang are deterministic; older PGO and LTO paths were not |
| Locale and `TZ` affecting sorting or formatting | Pin `LC_ALL=C`, `TZ=UTC` |
| Environment variables leaking into flags (`CFLAGS`, `CPATH`) | Sanitize the environment |
| Non-pinned compiler, libc, or dependency versions | §44.16 |
| PGO profiles differing between runs | Version and pin the profile as a build input (Ch. 40 §40.9) |
| `ccache`/`sccache` with non-deterministic inputs | `-fdebug-prefix-map`, `CCACHE_BASEDIR`, `hash_dir=false` |

Verify with `diffoscope` (a structural, not byte-level, diff of binaries, archives, and containers) — it tells you *what* differs, which is what makes reproducibility debuggable at all.

### Why anyone cares

1. **Supply-chain integrity.** A reproducible build lets an independent party verify that a published binary corresponds to the published source (the Reproducible Builds project; SLSA levels 3–4 require it). Post-SolarWinds this is a compliance requirement, not a nicety.
2. **Caching.** Bit-identical outputs make content-addressed caching (`ccache`, Bazel's remote cache, `sccache`) sound. Nondeterminism silently destroys cache hit rates and can produce inconsistent artifacts.
3. **Debugging production.** A crash from a binary you cannot rebuild identically is much harder to analyze; matching the build ID (Ch. 58 §58.7) requires the same inputs.
4. **In trading specifically: regulatory and post-mortem requirements.** Being able to reconstruct the exact binary that traded at a given time, from source and a manifest, is a compliance expectation, and it is also the only defensible answer to "was this behavior in the deployed version?"

**Hermetic build systems:** Bazel, Buck2, and Nix are the tools that enforce hermeticity structurally — sandboxed actions, declared toolchains (including the compiler itself as a versioned input), no ambient system dependencies, content-addressed caching. CMake plus a container image plus pinned dependency versions is the pragmatic approximation most C++ shops actually run, and it is a defensible answer as long as you can name what it does *not* guarantee: nothing prevents a rule from reading an undeclared file.

---

## 44.16 Dependency Pinning and Build Provenance

**Pinning** means every input is identified by an immutable, verifiable identity.

| Input | Weak identity | Pinned identity |
|---|---|---|
| Source dependency | `main`, `v1.x`, "latest" | **Commit SHA + expected content hash** |
| Package | `boost >= 1.80` | `boost/1.84.0` with a lockfile and a checksum |
| Compiler | "gcc" on `PATH` | A specific toolchain artifact with a hash (Bazel toolchains, Nix derivation, a pinned container digest) |
| Container base | `ubuntu:22.04` (a moving tag) | `ubuntu@sha256:...` (an immutable digest) |
| System libraries | Whatever is installed | Vendored, statically linked, or in the pinned image |
| PGO profile / BOLT profile | Regenerated ad hoc | Versioned artifact, hashed |

C++ package managers and their lock mechanisms: **Conan** (`conan.lock`), **vcpkg** (manifest mode + a pinned builtin-baseline commit and version overrides), **Bazel** (`MODULE.bazel.lock`, `http_archive` with `sha256`), **CMake FetchContent** (pin `GIT_TAG` to a full SHA, never a branch or a lightweight tag — a tag can be moved). "Pin to a SHA, not a tag" is the specific thing to say.

### Provenance

**Provenance** is the verifiable record of *how* an artifact was produced: which sources, which dependencies, which toolchain, which build machine, which parameters.

- **SBOM** (Software Bill of Materials) in **SPDX** or **CycloneDX** format — the dependency inventory, which is what lets you answer "are we exposed to CVE-X?" in minutes rather than days. Generate it from the build system, not by scanning the filesystem afterward.
- **in-toto attestations** and **SLSA** levels — signed statements binding an artifact hash to its build inputs and builder identity. SLSA L1 = provenance exists; L2 = it is signed by a hosted builder; L3 = the build is hardened and non-falsifiable; L4 adds hermeticity and two-party review.
- **Sigstore/cosign** for signing artifacts and attestations with short-lived, transparency-logged keys.
- **Build IDs** (`--build-id=sha1`, Ch. 41 §41.15, Ch. 58 §58.7) embedded in the ELF and used to key a symbol server, so a core dump from production maps unambiguously to the debug info for the exact binary that produced it. **This is the concrete, everyday payoff and the thing to mention first.**

### The operational discipline for a trading system

Record, for every deployed artifact: source commit SHA, dependency lockfile hash, toolchain identity, build flags, PGO profile identity, build ID, and the SBOM. Store them with the artifact and make them queryable. When a strategy behaves unexpectedly at 09:31:00, the first question is "what exactly was running?", and the entire answer must be reconstructible from an artifact hash — not from someone's memory of what was deployed on Tuesday (Ch. 60 §60.1, §60.11).

---

## 44.17 ABI Compatibility and Symbol Versioning

The **ABI** (Application Binary Interface) is the binary-level contract: calling conventions, register usage, name mangling, class layout, vtable layout, exception-handling tables, and the size and alignment of every type crossing the boundary (Ch. 41 §41.5–§41.8). It is enforced by nothing at link time and violated silently at runtime.

### What breaks ABI (a partial but memorizable list)

| Change | Source-compatible? | ABI-compatible? |
|---|---|---|
| Adding a non-static data member | Yes | **No** — `sizeof` changes; every consumer's allocations and offsets are wrong |
| Reordering data members | Yes | **No** — offsets change |
| Adding a virtual function | Yes | **No** — vtable layout changes (unless appended *and* no derived classes exist outside) |
| Reordering virtual functions | Yes | **No** — vtable indices change |
| Adding a *non-virtual* member function | Yes | Yes |
| Changing a parameter type (incl. `int`→`long`) | Maybe | **No** — mangled name changes; you get an undefined symbol (the good case) |
| Adding a default argument | Yes | Yes (it is a call-site substitution) |
| Adding a defaulted parameter to a function | Yes | **No** — mangled name changes |
| Changing an inline function's body | Yes | **No, in effect** — old callers keep the old inlined body; you get two behaviors in one process |
| Changing a `constexpr` value or an enum value in a header | Yes | **No, in effect** — same reason |
| Changing base classes | Maybe | **No** |
| Adding/removing `noexcept` (C++17: part of the type) | Maybe | **No** for function pointers/mangled names in some cases |
| Changing a template's definition | Yes | **No, in effect** — instantiations already emitted into consumers differ; a silent ODR violation |
| Changing `-D_GLIBCXX_USE_CXX11_ABI`, exceptions/RTTI flags, standard version, or struct-packing | — | **No** — the classic "it links but crashes" |

The **inline/template row is the one that catches experienced people**: header-only changes are ABI changes, because the code lives in the consumer. This is why header-only libraries have no ABI stability story at all and why PIMPL (§44.14) is the standard mitigation for a distributed library.

### Symbol versioning

ELF **symbol versioning** lets a single shared object export multiple incompatible definitions of one symbol, each tagged with a version, so old binaries keep the old behavior:

```
# version script
LIBFEED_1.0 { global: feed_open; feed_read; local: *; };
LIBFEED_2.0 { global: feed_open; } LIBFEED_1.0;    # 2.0 inherits from 1.0
```
```c
__asm__(".symver feed_open_v1, feed_open@LIBFEED_1.0");     // old definition, still exported
__asm__(".symver feed_open_v2, feed_open@@LIBFEED_2.0");    // @@ = the default for new links
```
Link with `-Wl,--version-script=libfeed.map`. This is exactly how glibc ships thirty years of compatible `libc.so.6`, and it is the reason a binary built in 2005 still runs — the mechanism behind `GLIBC_2.34` style symbols in your `nm` output.

The version script's `local: *;` clause is independently valuable: it **hides every symbol not explicitly exported**, which reduces the ABI surface (you cannot break what you never exported), speeds dynamic linking (fewer relocations, fewer PLT entries, no symbol interposition on internal calls — Ch. 41 §41.12), and shrinks the binary. `-fvisibility=hidden` plus explicit `__attribute__((visibility("default")))` on the API achieves the same from the source side (Ch. 1 §1.12) and is the recommended default.

### Tools and policy

- **`abi-compliance-checker`** and **`abidiff`/`abigail`** compare two library versions' DWARF and report ABI-breaking changes — the correct CI gate for a shipped library.
- **`nm -DC --defined-only`**, `readelf --dyn-syms -V`, `objdump -T` to inspect what you actually export.
- **Soname policy**: bump the soname (`libfoo.so.2`) on any ABI break so the loader refuses to mix, rather than crashing mysteriously. Semantic versioning at the *ABI* level, distinct from the API level.
- **The C++ standard library's own ABI freeze** is the canonical example of the cost of getting this wrong: `std::regex` cannot be made fast, `std::unordered_map` cannot become an open-addressing table, and `std::string`'s SSO layout is fixed, all because changing them would break every binary in existence. Being able to cite that is a strong close.

**The pragmatic escape:** most trading firms **statically link everything and deploy a single self-contained binary**, which converts every ABI question into a compile-time question and eliminates the entire class of problem — at the cost of larger artifacts, no shared page cache across processes, and a full redeploy for a dependency fix. That trade is almost always correct for latency-sensitive, tightly-controlled deployments, and saying so — with the tradeoff stated — is the right answer.

---

## Key Interview Questions

1. **What does Compiler Explorer let you check that a benchmark cannot?** — What the compiler actually emitted: whether a `cmov`, vectorization, RVO, or an allocation happened. Its trap is that a single-TU snippet with constant inputs is not your program.
2. **How does AddressSanitizer work?** — Shadow memory (1 byte per 8, encoding addressability) checked on every access, plus redzones around allocations and a quarantine for freed blocks; ~2× time, ~3× memory.
3. **What does ASan *not* catch?** — Uninitialized reads (MSan), data races (TSan), UB like signed overflow (UBSan), overflow between fields of the same struct, and anything in a custom allocator unless you call the manual poison API.
4. **How do you make ASan work with a custom arena allocator?** — `__asan_poison_memory_region` / `__asan_unpoison_memory_region` on alloc and free; otherwise the arena is one big valid block and every overflow is invisible.
5. **What is the `-fsanitize-trap=undefined` mode for?** — Emitting a bare trap instruction with no runtime library, so UBSan checks can ship in production builds: an immediate crash with a core dump instead of silent UB.
6. **How does ThreadSanitizer decide something is a race?** — Vector clocks: it intercepts synchronization operations and reports two accesses to the same location, at least one a write, unordered by happens-before. It proves races on observed executions rather than guessing; it does not explore other interleavings.
7. **Why does TSan produce false positives on lock-free code?** — Custom synchronization (seqlocks, RCU, inline-asm fences) is invisible to it; annotate with `__tsan_acquire`/`__tsan_release`.
8. **Why is MSan so much less used than ASan?** — It requires *every* library, including libc++, to be instrumented; uninstrumented code produces a flood of false positives.
9. **Why does MSan not report when you copy uninitialized bytes?** — Shadow propagates through computation and reports only when a poisoned value affects a branch, an address, or a syscall argument — which keeps false positives manageable.
10. **What will LeakSanitizer not find?** — Still-referenced growth (an unbounded cache), non-memory resources (fds, sockets), and `shared_ptr` cycles — the memory is reachable, from itself.
11. **Sanitizers or Valgrind Memcheck?** — Sanitizers when you can rebuild (2–3× vs 20–50×, better stack/global/adjacent-block detection, real concurrency); Memcheck when you cannot rebuild, and for its all-in-one coverage on a release binary.
12. **What is Clang thread-safety analysis?** — `GUARDED_BY`/`REQUIRES` annotations that let the compiler statically verify lock discipline at zero runtime cost and near-zero false positives — cheaper than TSan and it does not need a lucky interleaving.
13. **Name warnings beyond `-Wall -Wextra` that matter.** — `-Wshadow`, `-Wconversion`/`-Wsign-conversion`, `-Wold-style-cast`, `-Wnon-virtual-dtor`, `-Woverloaded-virtual`, `-Wcast-align`, `-Wfloat-equal`, `-Wformat=2`, plus `-D_GLIBCXX_ASSERTIONS` and `-D_FORTIFY_SOURCE=3` for runtime checks.
14. **PUBLIC vs PRIVATE vs INTERFACE in CMake?** — Whether the dependency is needed to build this target, propagated to consumers, or both. The rule is whether it appears in your headers; defaulting to PRIVATE is a direct compile-time and ABI-surface optimization.
15. **The most common CMake sanitizer mistake?** — Adding `-fsanitize=address` to compile options but not link options, producing undefined sanitizer-runtime symbols.
16. **How would you diagnose a slow build?** — `clang -ftime-trace` plus ClangBuildAnalyzer to rank headers by total parse cost and templates by instantiation cost; `-H` for the include tree; then attack the widely-included headers first, since cost is parse-cost × number of including TUs.
17. **What breaks with unity builds?** — Anonymous-namespace and `static` symbol collisions, macro leakage, file-scope `using namespace` leaking into the next file, include-order dependence — and terrible incremental builds.
18. **Why must a PIMPL class declare its destructor in the header?** — `unique_ptr<Impl>`'s deleter needs `Impl` complete where the destructor is instantiated; an implicit destructor is instantiated in the header where `Impl` is incomplete. Declaring it also suppresses the implicit moves, so declare those too.
19. **When is PIMPL wrong?** — On a hot-path type: an extra indirection and a heap allocation per object is exactly the cost you spend the rest of your time eliminating.
20. **Reproducible versus hermetic?** — Reproducible = bit-identical output from the same inputs; hermetic = the build depends only on declared inputs. Hermeticity is what makes reproducibility achievable, and it is enforced structurally by Bazel/Buck2/Nix, approximated by pinned containers plus lockfiles.
21. **Name three concrete reproducibility breakers and their fixes.** — `__DATE__`/`__TIME__` (ban, or `SOURCE_DATE_EPOCH`), absolute paths in debug info (`-ffile-prefix-map`), archive timestamps (`ar D`); verify with `diffoscope`.
22. **Why do build IDs matter?** — They bind a core dump to the exact binary and its debug info in a symbol server, which is the everyday payoff of provenance discipline.
23. **List changes that are source-compatible but ABI-breaking.** — Adding a data member, reordering members, adding or reordering a virtual function, changing a parameter type, changing an inline function's or a template's body, changing `_GLIBCXX_USE_CXX11_ABI` or the standard version.
24. **How does glibc keep thirty years of binaries working?** — ELF symbol versioning: multiple versioned definitions of one symbol in one `.so`, with `.symver` and a version script; new links get `@@default`, old binaries keep resolving the old version.
25. **Why can `std::regex` never be made fast?** — Its ABI is frozen; changing the layout would break every binary linked against the standard library. It is the canonical illustration of ABI as a permanent constraint.

---

## Common Traps

- **Trusting a Compiler Explorer snippet as representative** — one TU, constant inputs, no LTO, no PGO, and fewer instructions is not faster.
- **Running ASan only on a subset of tests.** It is a runtime tool; its coverage is your test suite's coverage.
- **Using ASan with a custom arena and concluding the code is clean** — the whole arena is one valid block; poison it manually.
- **Forgetting `-fno-omit-frame-pointer` and `-g`** with sanitizers — unreadable reports.
- **Adding `-fsanitize=...` to compile flags but not link flags.**
- **Leaving UBSan in default (recover) mode in CI** — it prints and continues in a UB state; use `-fno-sanitize-recover` so it fails the build.
- **Forgetting `UBSAN_OPTIONS=print_stacktrace=1`** and getting reports you cannot act on.
- **Assuming `-fsanitize=undefined` covers unsigned overflow or strict aliasing.** It covers neither.
- **Trying to combine TSan with ASan or MSan** in one binary.
- **Dismissing a TSan report as a "benign race"** — a non-atomic racy counter is UB; use `atomic` with `relaxed`.
- **Running TSan with an uninstrumented third-party library** — blind spots and false positives.
- **Running MSan without an instrumented libc++** — a flood of false positives and abandonment of the tool.
- **Expecting LSan to find a `shared_ptr` cycle** or unbounded cache growth.
- **Using Memcheck to find a stack buffer overflow** — stack memory is addressable; it will not see it.
- **Drawing timing or concurrency conclusions under Valgrind** — threads are serialized.
- **Enabling 5000 static-analysis findings at once** — the tool gets disabled. Baseline, then gate the diff.
- **`-Werror` in developer builds with an unpinned compiler** — a toolchain upgrade breaks everyone.
- **Directory-scoped `include_directories`/`CMAKE_CXX_FLAGS`** — leaks into unrelated targets and cannot be exported.
- **Bare library names instead of `Foo::Bar`** — a missing dependency becomes a confusing link error instead of a configure error.
- **Marking a dependency PUBLIC because it was easier** — you injected its headers into every downstream TU and its types into your ABI.
- **Putting a frequently-edited project header in the PCH** — every edit is a full rebuild.
- **PCH hiding missing `#include`s** — the code breaks for anyone not using the PCH, and blocks a modules migration.
- **Unity-building in CI but not locally** — two different programs.
- **A defaulted PIMPL destructor left in the header** — incomplete-type error, or historically silent UB.
- **PIMPL on a hot-path type.**
- **`FetchContent`/`GIT_TAG` pointing at a branch or a movable tag** — pin the full SHA.
- **`file(GLOB)` for sources** — nondeterministic order and no dependency on file addition.
- **Using a container tag instead of a digest** and calling the build reproducible.
- **Adding a data member or a virtual function to a shipped library's class** and expecting old binaries to work.
- **Changing an inline function's body and assuming it is ABI-safe** — old callers keep the old inlined code, and you now have two behaviors in one process.
- **Mixing objects built with different `_GLIBCXX_USE_CXX11_ABI`, standard versions, or exception settings** — it links and then crashes.

---

## Compact Recall Summary

**Compiler Explorer.** The fastest check on what was actually emitted — `cmov`, vectorization, RVO, allocations, per-compiler differences — with `llvm-mca`, opt-remarks, and the IR pipeline alongside. Traps: single TU, folded constants, no LTO/PGO, and instruction count ≠ speed. Local equivalents: `-S -masm=intel -fverbose-asm`, `objdump -dS`, cppinsights.

**ASan.** Shadow memory (1:8, addressability-encoded) plus redzones and a freed-block quarantine; ~2× time, ~3× memory. Catches heap/stack/global overflow, UAF, double free, mismatched delete, and leaks; misses uninitialized reads, races, UB, intra-struct overflow, and anything inside a custom arena unless you call `__asan_poison_memory_region`. `check_initialization_order` catches the static init order fiasco. HWASan/MTE is the cheaper ARM successor.

**UBSan.** A family of targeted checks (signed overflow, shift, null, alignment, bounds, `vptr`, `return`, `bool`/`enum`, float-cast, pointer-overflow, `unreachable`); 20%–2×. Three modes: recover (default, keeps running in UB), `-fno-sanitize-recover` (CI), and `-fsanitize-trap` (no runtime, shippable in production). Does not cover strict aliasing, races, uninitialized reads, or unsigned overflow.

**TSan.** Vector-clock happens-before with per-word shadow; 5–15× time, 5–10× memory. Proves races on observed executions; needs everything instrumented; cannot see custom synchronization — annotate with `__tsan_acquire`/`__tsan_release`. Also finds lock-order inversions and mutex misuse. No "benign" races: use `atomic` + `relaxed`.

**MSan.** Bit-level shadow propagated through computation, reported only when an uninitialized value reaches a branch, an address, or a syscall; ~3× (2× more with origin tracking). Requires an instrumented world including libc++ — the reason it is rare.

**LSan.** Conservative stop-the-world mark-and-sweep from globals, stacks, TLS, and registers at exit; near-zero cost, bundled with ASan on Linux. Conservative scanning gives false negatives. Finds no still-referenced growth, no fd/socket leaks, and no `shared_ptr` cycles.

**Memcheck.** DBI with A bits and V bits; 20–50×, no recompilation, all-in-one coverage on release binaries and vendor blobs. Weak on stack, global, and adjacent-heap-block overflow; serializes threads. Leak kinds: definitely / indirectly / possibly lost, still reachable. Rule: sanitizers first, Memcheck for what you cannot rebuild.

**Static analysis.** Tiers from warnings → clang-tidy/cppcheck → Clang Static Analyzer path-sensitive → Coverity/CodeQL whole-program → formal. Needs `compile_commands.json`. Clang thread-safety analysis (`GUARDED_BY`/`REQUIRES`) is statically verified lock discipline at zero cost. Adoption pattern: baseline, gate the diff, ratchet, justify suppressions. Static analysis + fuzzing + sanitizers are complements, not alternatives.

**Warnings.** `-Wall -Wextra` is a floor, not a ceiling. Add `-Wshadow`, `-Wconversion`, `-Wsign-conversion`, `-Wold-style-cast`, `-Wnon-virtual-dtor`, `-Woverloaded-virtual`, `-Wcast-align`, `-Wfloat-equal`, `-Wformat=2`, `-Wimplicit-fallthrough`; plus `_GLIBCXX_ASSERTIONS`/`_LIBCPP_HARDENING_MODE` and `_FORTIFY_SOURCE=3` for runtime checks. `-Werror` in CI with a pinned compiler. Build with both GCC and Clang.

**CMake.** Targets carry usage requirements; never use directory-scoped commands or mutate `CMAKE_CXX_FLAGS`. `target_link_libraries` propagates includes, definitions, options, and features. Namespaced `Foo::Bar` targets fail fast; bare names silently become `-lname`. Generator expressions for per-config and per-language flags; INTERFACE targets for header-only libs and option bundles; ALIAS so subdirectory and installed use match; presets for reproducible invocation; `CMAKE_EXPORT_COMPILE_COMMANDS` for tooling.

**PUBLIC/PRIVATE/INTERFACE.** PRIVATE = build-only; INTERFACE = consumers-only; PUBLIC = both. The test is whether the dependency appears in your headers. Consequences: compile time, rebuild blast radius, and ABI surface. Default to PRIVATE; every promotion to PUBLIC is a design decision.

**Compile time.** Measure with `clang -ftime-trace` + ClangBuildAnalyzer, `-H`, `-ftime-report`. Attack by leverage: Ninja, `mold`/`lld`, ccache, PRIVATE deps, forward declarations and PIMPL, `extern template`, `-gsplit-dwarf`, ThinLTO, avoiding heavy headers in headers. Cost of a header = parse cost × number of including TUs.

**PCH and unity builds.** PCH: 20–50%, must be included first, invalidated by any flag or content change, hides missing includes; only put stable external headers in it. Unity: 2–5× on full builds and better codegen, but batch-granularity incremental rebuilds and real hazards — `static`/anonymous-namespace collisions, macro leakage, file-scope `using namespace` leaking forward, include-order dependence. Modules are the actual fix for both.

**PIMPL.** Opaque `unique_ptr<Impl>`; the destructor and move operations must be declared in the header and defined where `Impl` is complete. Buys compile-time firewalling and ABI stability; costs an indirection, a heap allocation, and inlining. Right for library boundaries and cold classes, wrong for hot-path types. Alternatives: interface+factory, fast-PIMPL with inline storage, modules (for the compile-time motivation only).

**Reproducible and hermetic.** Reproducible = bit-identical; hermetic = only declared inputs. Breakers: `__DATE__`/`__TIME__`, absolute paths, archive timestamps, readdir order, locale/TZ, environment leakage, unpinned toolchains. Fixes: `-ffile-prefix-map`, `ar D`, sorted inputs, `SOURCE_DATE_EPOCH`, `LC_ALL=C`; verify with `diffoscope`. Motivations: supply-chain verification (SLSA), sound caching, and reconstructing exactly what traded.

**Pinning and provenance.** Pin commit SHAs and content hashes, not tags or branches; pin container digests, not tags; treat the compiler and the PGO profile as versioned inputs. Conan/vcpkg/Bazel lockfiles. Provenance: SBOM (SPDX/CycloneDX), in-toto/SLSA attestations, cosign signatures, and ELF build IDs binding a core dump to its exact debug info.

**ABI.** Layout, vtables, mangled names, and calling conventions — enforced by nothing and violated silently. Breaking: adding/reordering members, adding/reordering virtuals, changing parameter types, changing inline or template *bodies* (old callers keep the old code), changing `_GLIBCXX_USE_CXX11_ABI` or the standard version. Symbol versioning (`.symver` + version script, `@@` for the default) is how glibc stays compatible; `local: *;` and `-fvisibility=hidden` shrink the surface and speed dynamic linking. Gate with `abidiff`; bump the soname on a break. The standard library's frozen ABI is why `std::regex` and `std::unordered_map` cannot be fixed. Static linking of a single self-contained binary sidesteps the whole class of problem, at the cost of size and redeploy granularity — usually the correct trade for a latency-critical deployment.
