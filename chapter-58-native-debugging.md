# Chapter 58 — Native Debugging

*Interview-focused revision notes. The theme: a production C++ binary is optimized, stripped, and running on an isolated core at 3 a.m., so the debugging skills that matter are the ones that work without a breakpoint — reading a stack from raw registers, recovering symbols from a build ID, recognizing a corruption pattern from the shape of the crash, and knowing what your crash handler is allowed to do.*

---

## 58.1 GDB and LLDB Fundamentals

A debugger is a process that `ptrace`s (Linux) or uses `mach_exception_ports` (macOS) another process, reads **DWARF** debug information (§58.7) to map addresses to source, and controls execution by rewriting instructions and single-stepping.

**Attach modes**, and when each is the right one:

```
gdb ./app                      # launch under the debugger
gdb -p 12345                   # attach to a running process (SIGSTOPs it)
gdb ./app core.12345           # postmortem (§58.4)
gdb --args ./app --flag=v      # launch with arguments
gdb -batch -ex bt -ex 'thread apply all bt' ./app core   # scripted, for automation
```

Attaching **stops the world**. On a live trading process this drops market data, trips watchdogs (Ch. 56 §56.8), and may cause the exchange to disconnect on a missed heartbeat (Ch. 54 §54.2). The safer production move is almost always: take a core with `gcore -o /tmp/x <pid>` (which also stops the process, but only for the duration of the dump) or, better, let the process crash into a core and debug the core offline. On modern Linux, attaching also requires `ptrace_scope` permission: `/proc/sys/kernel/yama/ptrace_scope` = 0 allows any same-uid attach, 1 (the default) only allows a parent, 3 forbids it entirely. "I couldn't attach" is usually Yama, not permissions.

**The command vocabulary that actually gets used**, GDB / LLDB:

| Purpose | GDB | LLDB |
|---|---|---|
| Backtrace | `bt`, `bt -full`, `thread apply all bt` | `bt`, `bt all` |
| Frame selection | `frame 3`, `up`, `down` | `frame select 3`, `up`, `down` |
| Registers | `info registers`, `p $rip` | `register read`, `p $pc` |
| Disassemble | `disassemble /s`, `x/20i $pc` | `disassemble -m`, `x/20i $pc` |
| Memory examine | `x/16xg addr`, `x/s addr` | `memory read -f x -s 8 -c 16 addr` |
| Threads | `info threads`, `thread 4` | `thread list`, `thread select 4` |
| Breakpoint | `b file.cc:42`, `b ns::fn` | `b -f file.cc -l 42`, `b -n fn` |
| Source-level step | `n`, `s`, `finish`, `until` | `n`, `s`, `finish` |
| Instruction step | `si`, `ni` | `si`, `ni` |
| Shared libraries | `info sharedlibrary` | `image list` |
| Symbol lookup | `info symbol 0x4011a6`, `info line *0x4011a6` | `image lookup -a 0x4011a6` |

**Pretty printers** are what makes GDB usable on modern C++: libstdc++ ships Python printers so `p vec` shows elements rather than three pointers. They must be loaded (`~/.gdbinit` with `python ... register_libstdcxx_printers`), and they *execute Python*, which is why `p some_map` on a corrupted structure can hang or throw — `set print pretty off` / `p /r obj` gives you the raw view when the pretty printer chokes on garbage. LLDB uses built-in C++ data formatters plus `type summary add`.

**Non-obvious fundamentals worth having ready:**
- `p` runs the **inferior's** code for anything non-trivial: calling `p v.size()` on an inlined-away or optimized-out method fails, and calling a function in the inferior from a core dump is impossible (nothing is running). `p` on a core only reads memory.
- `set follow-fork-mode child` / `detach-on-fork off` for debugging across `fork` (Ch. 31 §31.3).
- `catch throw`, `catch syscall write`, `catch signal SIGSEGV` for event-based stopping.
- `handle SIGUSR1 nostop noprint pass` — essential when the application uses signals for timers or profiling, otherwise the debugger traps on every one.
- `gdb -batch` plus a script is how you build automated triage: run it over every core in a directory and emit a stack signature for deduplication.
- **Scripting**: GDB's Python API (`gdb.parse_and_eval`, `gdb.Breakpoint` subclasses with `stop()` returning False) lets you write conditional logic that is orders of magnitude faster than a `condition` string, and lets you dump application state (walk your order table, print your ring buffer's indices) in one command.

---

## 58.2 Breakpoints and Watchpoints

**Software breakpoints** work by replacing the instruction byte at the target address with a trap instruction (`0xCC`, `int3`, on x86-64), catching `SIGTRAP`, restoring the original byte, single-stepping, and re-inserting. Consequences: they are unlimited in number; they modify the text segment (so a checksum over `.text` will fail under a debugger, and they are invisible to another process reading the same page thanks to COW, Ch. 31 §31.3); and each hit costs two context switches to the debugger — a breakpoint in a 10 M-events/sec hot loop is unusable.

**Hardware breakpoints** use the CPU's debug registers (x86: `DR0`–`DR3` for addresses, `DR7` for control) and do not modify memory. There are **only four**, they can be set on execute, write, or read/write, and they cover 1, 2, 4, or 8 aligned bytes. `hbreak` in GDB. Use them when the memory is read-only, when you're debugging self-modifying or JIT-generated code, or when you must not perturb the instruction stream.

**Watchpoints** are the single most useful debugger feature that engineers underuse. A watchpoint stops when a *value* changes.

```
watch counter                  # hardware if possible
watch -l obj->field            # -l: watch the ADDRESS, not the expression's scope
rwatch  ptr                    # on read
awatch  ptr                    # on read or write
watch *(uint64_t*)0x7fffdeadbeef   # watch raw memory — the corruption workhorse
info watchpoints
```

**Hardware vs software watchpoints is the point to know.** A hardware watchpoint uses a debug register and is essentially free — the CPU traps on the access. A **software watchpoint single-steps the entire program and re-evaluates the expression after every instruction**, which is roughly 1000× slower and often means an overnight run. GDB silently falls back to software when the watched region exceeds the debug registers' capacity (more than 8 bytes, or more than 4 regions). `show can-use-hw-watchpoints` and the message "Hardware watchpoint" vs "Watchpoint" in the confirmation tell you which you got. If you need to watch a 64-byte structure, watch the specific 8-byte field that gets corrupted, not the whole object.

**The canonical corruption workflow** (§58.11): a field holds a plausible value at construction and garbage later. Run to construction, `p &obj->field`, `watch -l *(uint64_t*)<that address>`, continue. The debugger stops on the exact instruction of the write, with a stack — which identifies the culprit directly, no reasoning required. The `-l` flag matters: without it, the watchpoint is deleted when the expression's scope exits.

**Conditional breakpoints and the cost model.** `b handler.cc:88 if order_id == 99123` evaluates the condition *in the debugger* on every hit — two context switches per evaluation. On a hot path this is thousands of times slower than the alternatives: a `dprintf`, a GDB Python breakpoint whose `stop()` returns quickly, or (best) an `if (order_id == 99123) __builtin_trap();` compiled into a debug build. `ignore <bpnum> <count>` skips *n* hits with the same per-hit cost, so "break on the 1,000,000th iteration" is often faster achieved by a counter in the code.

**Tracepoints and low-overhead alternatives.** For a running production process where stopping is unacceptable, the debugger is the wrong tool. `bpftrace`/`uprobes` attach to a function without stopping the process (Ch. 35 §35.21): `bpftrace -e 'uprobe:/opt/app:_ZN6Engine8on_orderEy { @[arg1] = count(); }'` gives you the data with microseconds of overhead per hit and no trap to a debugger.

---

## 58.3 Debugging Optimized Code

Production binaries are `-O2`/`-O3` with LTO, and the single most common frustration is `<optimized out>`. Understanding *why* is the difference between fumbling and diagnosing.

**Why a variable is optimized out.** DWARF describes a variable's location as a *location expression* that can vary by PC range: "in `%rbx` from 0x4011a0 to 0x4011c8, at `-0x18(%rbp)` from 0x4011c8 to 0x4011f0, nowhere thereafter." The compiler is under no obligation to keep a variable materialized anywhere:

| Cause | What you see | Recovery |
|---|---|---|
| Value lives only in a register, and that register was reused | `<optimized out>` at some PCs, correct at others | Move `up`/`down` frames; step to a PC where it is live; read the register directly |
| Constant-folded / propagated away | `<optimized out>` everywhere | Recompute from other values |
| Computed but never stored (dead store eliminated) | `<optimized out>` | — |
| Inlined callee's parameter | Frame missing entirely, or shown as `inlined frame` | `info frame`, `bt` shows inline frames if `-g` is good |
| Tail call (Ch. 41 §41.9) | The caller's frame is **gone** from the backtrace | Reason about the missing link; `-fno-optimize-sibling-calls` in debug builds |
| Loop induction variable strength-reduced | The source variable doesn't exist; a derived pointer does | Read the pointer, back out the index |
| Struct scalarized (SROA) | Members in separate registers, object "not available" | Read members individually if DWARF describes them |

**Inlining changes the shape of the stack.** With `-g`, GCC/Clang emit `DW_TAG_inlined_subroutine` records, so GDB *does* show inlined frames — but they are not real frames: `finish` behaves oddly, `up` moves within one physical frame, and the return address you see in the raw stack (§58.6) will not correspond to them. When you read a stack without symbols, inlined functions are simply invisible; a five-line backtrace may represent twenty source-level calls.

**Statement reordering and jumpy stepping.** `-O2` interleaves instructions from different statements, so single-stepping bounces between source lines and a breakpoint on line 40 may fire "after" line 42's effects. This is not a bug; it is the scheduler. `set print address on` and stepping by instruction (`si`) plus `disassemble /s` is the honest view.

**The build configurations that matter:**

```
-O2 -g                      # production: full optimization, full debug info. ALWAYS do this.
-O2 -g -fno-omit-frame-pointer     # ~1% slower, backtraces work everywhere (§58.6)
-Og -g                      # "optimize for debugging": most optimizations, but variables stay live
-O0 -g                      # everything visible; often 10-50x slower, and the bug may vanish
-O2 -g -fvar-tracking-assignments   # GCC default at -O2 with -g; improves location accuracy
```

**`-g` does not slow down or change the generated code.** It only adds `.debug_*` sections. Shipping `-O2 -g` and splitting the debug info out (§58.7) is the correct default and the answer expected in an interview — the historical practice of building production without `-g` is what makes production crashes undebuggable.

**Heisenbugs.** If the bug disappears at `-O0`, the cause is usually one of: undefined behaviour that the optimizer exploited (Ch. 4 §4.5); a data race whose window widens or narrows with instruction scheduling (Ch. 25 §25.1); uninitialized memory that happened to be zero in the larger `-O0` stack frames; or a timing dependence. The productive step is not to debug at `-O0` but to run the `-O2` build under UBSan/ASan/TSan (Ch. 44 §44.2–§44.4), which finds the actual defect rather than the symptom. `-O2 -fno-inline` or `-Og` is a middle ground that often keeps the bug alive while restoring visibility.

---

## 58.4 Core Dumps

A **core dump** is a snapshot of a process's memory, registers, and thread state written by the kernel at abnormal termination. It is the primary debugging artifact for production, because it turns a 3 a.m. crash into an offline analysis.

**Getting one at all** requires three things to be right:

```
ulimit -c unlimited                       # per-process RLIMIT_CORE; 0 by default in many setups
cat /proc/sys/kernel/core_pattern         # where it goes, or which program receives it
sysctl -w kernel.core_pattern='/var/cores/core.%e.%p.%t'
sysctl -w kernel.core_uses_pid=1
cat /proc/<pid>/coredump_filter           # bitmask: which VMAs are included
```
`core_pattern` beginning with `|` pipes the core to a program (`systemd-coredump`, `apport`, `abrt`) — a frequent surprise when the file never appears where expected; `coredumpctl list` / `coredumpctl gdb <pid>` is then the retrieval path. A setuid or `prctl(PR_SET_DUMPABLE, 0)` process does not dump at all.

**Size is the operational problem in this domain.** A trading process with 64 GB of huge-page-backed arenas (Ch. 7 §7.14) and mapped market-data buffers produces a core that takes minutes to write and fills the disk — during which the process is dead and the machine is doing synchronous I/O. Mitigations:

- `coredump_filter` (per-process, inheritable, `/proc/self/coredump_filter`) selects which mapping classes are dumped: bit 0 anonymous private, 1 anonymous shared, 2 file-backed private, 3 file-backed shared, 4 ELF headers, 5 private huge pages, 6 shared huge pages, 7/8 DAX. Clearing the huge-page and shared bits typically shrinks a core by orders of magnitude while retaining the stacks and heap you actually need. Default is usually `0x33`.
- `madvise(MADV_DONTDUMP)` on specific large regions (packet buffers, mmapped reference data) is the surgical version — exclude the 40 GB of ring buffers, keep everything else.
- Write cores to a fast local NVMe partition, never to network storage, and cap total retention (Ch. 60 §60.13).

**Using the core.** `gdb ./app core` needs the *exact* binary and the *exact* shared libraries; a mismatched build silently produces a plausible-looking, wrong backtrace. This is what build IDs (§58.8) exist to prevent — GDB checks them and warns. On a different host, set `set sysroot /path/to/captured/libs` and `set solib-search-path`. `info sharedlibrary` tells you which libraries GDB failed to find; missing libc is why `bt` degenerates to `??` frames.

**What a core does and does not contain.** It contains all dumped memory, all threads' registers, and the signal info (`p $_siginfo` gives `si_signo`, `si_code`, and `si_addr` — the faulting address, which is the single most informative field for a SIGSEGV). It does **not** contain: file descriptors' contents, kernel state, the contents of pages never faulted in, or anything about the *past* — you see the final state, not how it got there.

**Reverse debugging is the answer to that last limitation.** `rr record ./app` captures a recording by making execution deterministic (single-threaded serialization of the trace, recorded syscall results, disabled ASLR); `rr replay` then gives a GDB session in which `reverse-continue`, `reverse-step`, and — critically — **reverse watchpoints** work. The canonical workflow for a corruption bug becomes: replay to the crash, `watch -l` the corrupted address, `reverse-continue`, and land directly on the instruction that wrote it. Costs and limits: ~1.2–2× record overhead, single-core execution (so genuinely parallel timing bugs change or vanish), a requirement for PMU access (`perf_event_paranoid ≤ 1`) and hardware or a container that exposes it, and no support for some instructions and for processes that depend on true multicore parallelism. `rr record --chaos` randomizes scheduling to *find* the race first (Ch. 57 §57.10). GDB's built-in `record full` does the same thing in software at ~1000× slowdown — usable only for the last few thousand instructions before a fault, via `record` then `reverse-stepi`.

**First five commands on any core**, worth being able to recite:
```
bt                                 # where it died
thread apply all bt                # what everyone else was doing (deadlocks live here)
p $_siginfo                        # signal, code, faulting address
info registers                     # $rip, $rsp, $rbp sanity
x/16i $pc-32                       # the instruction that faulted, in context
```

---

## 58.5 `std::stacktrace`

C++23's `<stacktrace>` makes capturing a backtrace a language-level facility rather than a platform hack.

```cpp
#include <stacktrace>
void on_error() {
    auto st = std::stacktrace::current();          // whole stack
    auto st2 = std::stacktrace::current(1, 16);    // skip 1 frame, max 16
    std::cerr << st << '\n';                       // formatted: index, description, file:line
    for (const auto& e : st)
        std::cerr << e.native_handle() << ' ' << e.description()
                  << ' ' << e.source_file() << ':' << e.source_line() << '\n';
}
```
Build requirement on libstdc++: link `-lstdc++exp` (GCC 14+) or `-lstdc++_libbacktrace`, and compile with `-g` or you get addresses without names. It is backed by `libbacktrace` on GCC; libc++ support arrived later and MSVC has its own.

**The properties that matter:**

- **`std::stacktrace_entry` is a plain address** (`native_handle()` is the program counter); everything else — `description()`, `source_file()`, `source_line()` — is resolved *lazily* by reading debug information, which is **slow** (milliseconds, allocating, and it may open files and take locks).
- Therefore: **capture in the fast path, symbolize elsewhere.** `std::stacktrace::current()` itself walks the stack and stores addresses; that's comparatively cheap (microseconds), but it still **allocates** (it has an allocator-aware `basic_stacktrace`, so you can supply a monotonic resource, Ch. 8 §8.6). For a hot path, capture into a fixed array with `libunwind`'s `unw_backtrace` or `__builtin_return_address`, and never symbolize in-process.
- **It is not async-signal-safe.** Calling it from a `SIGSEGV` handler is exactly what everyone wants to do and is formally unsound (§58.13) — it allocates and may take the loader lock.
- **`std::stacktrace` needs frame information.** With frame pointers omitted it relies on `.eh_frame` CFI, which is present in optimized builds but makes unwinding much more expensive and can fail in hand-written assembly or in a frame with a corrupted stack.
- **Inlined frames** appear or not depending on the backend's ability to read `DW_TAG_inlined_subroutine`; `libbacktrace` does expand them, plain `backtrace_symbols` does not.

**Pre-C++23 and production alternatives**: `backtrace()`/`backtrace_symbols_fd()` from `<execinfo.h>` (the latter *is* roughly signal-safe because it writes to an fd without allocating, but it needs `-rdynamic` to get names for non-exported symbols and never resolves file:line); `libunwind` (`unw_backtrace`, more robust, usable from signal handlers); Boost.Stacktrace (the direct ancestor of the standard facility, with selectable backends); and `absl::GetStackTrace`.

**Attaching a stack trace to an exception** is the natural use — C++26's proposed stacktrace-on-throw aside, the practical technique is a custom exception base that captures `std::stacktrace::current()` in its constructor, or a `__cxa_throw` interposer that records the stack at throw time. That matters because by the time you catch, the stack has unwound and the origin is gone (Ch. 10 §10.5).

---

## 58.6 Postmortem Register and Stack Analysis

The skill that distinguishes a strong candidate: recovering a call chain from a core with no symbols, no frame pointers, or a corrupted stack.

**The x86-64 stack frame convention** (Ch. 41 §41.5–§41.6):

```
higher addresses
   ┌──────────────────────┐
   │  caller's locals     │
   │  argument overflow   │
   ├──────────────────────┤
   │  RETURN ADDRESS      │  ← pushed by `call`
   ├──────────────────────┤
   │  saved RBP           │  ← only if frame pointers are used
   ├──────────────────────┤  ← RBP points here
   │  callee's locals     │
   │  saved callee-regs   │
   ├──────────────────────┤  ← RSP
   │  128-byte red zone   │  (leaf functions may use below RSP)
lower addresses
```

**With frame pointers** (`-fno-omit-frame-pointer`), unwinding is a trivial linked list: `saved_rbp = *(uint64_t*)rbp; retaddr = *(uint64_t*)(rbp+8)`, repeat. This is why frame pointers are worth ~1 % of performance in production — `perf` (Ch. 43 §43.15), `bpftrace`, and every crash handler unwind faster and more reliably with them, and the whole industry (Fedora, Ubuntu, Google) has swung back to enabling them by default.

**Without frame pointers**, unwinding requires **CFI** (call frame information) in `.eh_frame`: a per-PC table describing where the return address and each saved register live relative to a canonical frame address. `readelf --debug-dump=frames-interp` prints it decoded. CFI-based unwinding is correct but expensive and fails if the PC is in code without CFI (hand-written asm, some JIT), or if the stack is corrupted.

**Manual stack scanning** — the technique for when everything else fails:
```
x/256a $rsp
```
Then identify which of those 8-byte values are plausible **return addresses**: they fall inside a mapped executable region (`info proc mappings`, or the core's ELF program headers), and the *preceding* bytes decode as a `call` instruction. `info symbol <value>` for each candidate. This reconstructs an approximate call chain including stale frames (which is both the weakness — false positives from dead frames — and a strength, since it shows where the code has been). GDB's `bt` after `set backtrace past-main on` plus manual `set $pc`/`set $sp` fiddling is the guided version.

**Reading the crash from registers alone:**

| Observation | Interpretation |
|---|---|
| `$rip` = 0, or a tiny value like `0x8` | Call through a **null/garbage function pointer** or a null vtable slot; the return address at `*$rsp` names the caller |
| `$rip` in a non-executable region | Jumped into data — corrupted function pointer or a smashed return address |
| `si_addr` = 0 | Null-pointer dereference; the offset from 0 gives the member offset (`si_addr = 0x28` → member at +0x28 of a null object) |
| `si_addr` just below a valid mapping | Stack overflow hitting the guard page (Ch. 32 §32.20); the backtrace will be enormous or recursive |
| `si_addr` = `0xffffffffffffffff` or similar | An unsigned underflow used as an index/size (Ch. 23 §23.12) |
| `si_addr` looks like ASCII or a small integer | A value was used as a pointer — type confusion or a union misuse |
| `$rip` in `free`/`malloc`/`_int_malloc` | **Heap metadata corruption** (§58.11); the culprit is elsewhere, earlier |
| `$rip` in `memcpy` with a huge `$rdx` | Attacker- or wire-controlled length (Ch. 51 §51.11) |
| `si_code = SEGV_ACCERR` vs `SEGV_MAPERR` | Permission violation (e.g. write to a read-only page / text) vs unmapped address |
| Deep uniform repeating frames | Infinite recursion |

**Recovering arguments.** Under System V AMD64 (Ch. 41 §41.5) integer arguments arrive in `RDI, RSI, RDX, RCX, R8, R9`. At the *entry* of the crashed function those registers still hold the arguments — so if you crashed in the prologue, `p $rdi` is `this`. Deeper into the function they've been reused, which is exactly why arguments show as `<optimized out>`. In the caller's frame, `x/8i` backwards from the return address usually shows the `mov`s that set them up, and the source of each is often recoverable.

---

## 58.7 DWARF and Split Debug Information

**DWARF** is the debug-information format: a tree of DIEs (Debugging Information Entries) in `.debug_info` describing types, variables, and functions; `.debug_line` mapping addresses to file:line (a compressed state machine, not a table); `.debug_loc`/`.debug_loclists` giving per-PC variable locations; `.debug_abbrev`, `.debug_str`; and `.eh_frame`/`.debug_frame` carrying unwind CFI. `.eh_frame` is special: it is a **loaded, allocated** section required for C++ exception unwinding (Ch. 10 §10.7), so it survives stripping — which is why a stripped binary can still be unwound but not symbolized.

Debug info is **large** — commonly 5–20× the size of the code for a template-heavy C++ program — so shipping it inside the binary is impractical. The three mechanisms:

| Technique | Flags | Result |
|---|---|---|
| **Split DWARF** | `-gsplit-dwarf` (+ `-Wl,--gdb-index`) | Debug info goes into per-object `.dwo` files, *not* linked in; the binary keeps a skeleton unit pointing at them. Dramatically faster links and smaller binaries. Requires the `.dwo` files to remain at their recorded paths (or a `.dwp` package via `dwp`/`llvm-dwp`). |
| **Separate debug file** | `objcopy --only-keep-debug app app.debug; objcopy --strip-debug app; objcopy --add-gnu-debuglink=app.debug app` | Ships a stripped binary plus a `.debug` file found via `.gnu_debuglink` (name + CRC) or, better, via build ID (§58.8) |
| **Compressed debug** | `-gz` / `--compress-debug-sections=zstd` | Same info, ~4–6× smaller on disk |

Related knobs: `-g1` (line tables and function names only — enough for a backtrace, tiny), `-g3` (adds macro definitions, so `p SOME_MACRO` works), `-fdebug-types-section` and `-gdwarf-5` for deduplication, and `-Wl,--gdb-index` / `gdb-add-index` to build an index so GDB starts in seconds instead of minutes on a large binary.

**The production recipe**, and the expected interview answer: build `-O2 -g -fno-omit-frame-pointer -gsplit-dwarf`, strip the deployed binary, archive the unstripped binary and `.dwp` in a symbol store keyed by build ID (§58.8), and never, ever build production without `-g`.

**Debug info can be wrong in ways worth knowing.** At `-O2`, line attribution to the *middle* of an optimized region is approximate; a PC may map to a line in a function that was inlined from another file, so a backtrace can name a header you did not expect. `-fvar-tracking-assignments` (GCC's default with `-g -O2`) exists specifically to keep variable locations accurate through optimization, and disabling it (`-fno-var-tracking-assignments`) speeds compilation at the cost of more `<optimized out>`. LTO makes line attribution worse still and requires `-flto -g` throughout, with debug info merged at link time.

`readelf -S`, `readelf --debug-dump=info`, `llvm-dwarfdump`, `eu-readelf`, and `pahole` (which reads DWARF to print struct layouts, Ch. 3 §3.4) are the inspection tools.

---

## 58.8 Build IDs and Symbol Servers

A **build ID** is a unique identifier — typically a 20-byte SHA1 over the binary's contents — stored in the `.note.gnu.build-id` ELF note and emitted by the linker (`-Wl,--build-id=sha1`, on by default in most distributions).

```
$ readelf -n ./app | grep -A1 'Build ID'
    Build ID: 3f0a1c9d4b8e2f6a71c0d5e8b3a9f2c14d7e6b02
$ eu-unstrip -n --core core.1234        # every module in the core, with its build ID
```

**Why it exists:** it makes the binary–debuginfo pairing *cryptographic* rather than by-name. A core dump records the build ID of every mapped module; the debugger reads them and fetches exactly the right symbols. Without it, "we debugged the core with last week's binary" produces a confident, entirely fictional backtrace — the failure mode that wastes the most time in postmortem work.

**The lookup convention** on Linux is a directory tree keyed by build ID:
```
/usr/lib/debug/.build-id/3f/0a1c9d4b8e2f6a71c0d5e8b3a9f2c14d7e6b02.debug
```
GDB searches `debug-file-directory` for exactly this path. `debuginfod` is the network version: an HTTP server indexing debug info by build ID, queried transparently by GDB, `perf`, `eu-stack`, and `elfutils`:
```
export DEBUGINFOD_URLS="https://debuginfod.internal:8002"
gdb ./core            # fetches the matching binary, debuginfo, and even sources
debuginfod-find debuginfo 3f0a1c9d...
```
LLDB/macOS uses **UUIDs** and `.dSYM` bundles with the same idea; `dsymutil` builds the bundle, Spotlight or `DBGShellCommands` locates it.

**Operational requirements for a symbol store that actually works:**
1. Every artifact ever deployed is archived — unstripped binary, `.dwp`, and all shared libraries including the *system* ones from that base image. A crash in `libstdc++` is unreadable without the matching libc/libstdc++ debug info.
2. The build is reproducible enough that the build ID identifies a source revision, and that mapping is recorded (build ID → git SHA → build flags, Ch. 44 §44.16, Ch. 60 §60.1).
3. Retention outlives your longest core-retention window.
4. The crash-handling pipeline records the build ID *in the crash report*, so triage does not depend on knowing which host ran which version.

**Deduplication by stack signature** is the payoff at scale: symbolize offline, hash the top *n* frames' function names (not addresses — addresses vary with ASLR and build), and count occurrences. This turns a thousand cores into five distinct bugs ranked by frequency.

---

## 58.9 Deadlock Diagnosis

A **deadlock** is a cycle in the wait-for graph: every thread holds a resource another needs (Ch. 24 §24.16). The diagnostic signature is unmistakable — **0 % CPU, no progress, process alive** — which distinguishes it immediately from livelock (§58.10, 100 % CPU) and from a crash.

**The procedure**, in order:

```
gdb -p <pid>                  (or gcore, then debug offline)
(gdb) thread apply all bt
```
Then read the stacks. Threads blocked in `__lll_lock_wait`, `pthread_mutex_lock`, `futex_wait`, `std::condition_variable::wait`, `pthread_cond_wait`, or `epoll_wait` are the candidates. `futex` waits (Ch. 33 §33.7) are the low-level signature of every blocking C++ synchronization primitive.

**Identifying who holds the lock.** A `pthread_mutex_t` on glibc stores the owner's **TID** in its `__data.__owner` field for error-checking and PI mutexes; for a normal mutex the owner field is set too in current glibc:
```
(gdb) p *(pthread_mutex_t*)&my_mutex
$1 = {__data = {__lock = 2, __count = 0, __owner = 41237, __nusers = 1, ...}}
(gdb) info threads          # find the GDB thread number whose LWP is 41237
```
`__lock = 2` means locked-with-waiters (the value that forces a futex syscall on unlock). Walk from each blocked thread to its lock's owner; a cycle is your deadlock. For `std::mutex` this works because it is a thin wrapper over `pthread_mutex_t`.

**Tools that do this for you:**

| Tool | Mode | Notes |
|---|---|---|
| **TSan deadlock detector** | Runtime, pre-emptive | Detects **lock-order inversions** even when no deadlock occurred (`detect_deadlocks=1`, on by default in recent builds; `second_deadlock_stack=1` for both stacks) — this is the important one, because it finds the bug *before* production |
| **Helgrind / DRD** (Valgrind) | Runtime | Lock-order checking; very slow |
| `pstack` / `eu-stack -p` | Snapshot | Dumps all thread stacks without a full debugger session |
| `gdb -batch -ex 'thread apply all bt' -p` | Snapshot | Scriptable; the standard production one-liner |
| `/proc/<pid>/task/*/stack`, `wchan` | Kernel-side | Where each thread is blocked in the kernel |
| `perf lock`, `bpftrace` on futex | Live | Contention and hold times without stopping |

**Deadlock variants whose signatures differ:**
- **Self-deadlock**: a non-recursive `std::mutex` locked twice by one thread. One thread, blocked in `lock`, its own TID in `__owner`. Frequently caused by a callback re-entering the locked object.
- **Lock-order inversion across a virtual call** — the second lock is acquired inside a user callback, so no single function shows both locks. Only TSan's ordering graph finds this reliably.
- **Deadlock with a condition variable**: all threads in `pthread_cond_wait`, none blocked on a mutex. That is not a lock cycle but a **lost wakeup** (Ch. 24 §24.10) — the predicate became true while no one was waiting, and `notify_one` was called with no waiter. Signature: everyone waiting, the predicate true, and the work queue non-empty.
- **Deadlock with a lock-free structure**: impossible by definition for lock-free progress, but a *blocking* fallback path (spin then park, Ch. 24 §24.15) can deadlock; and a spinlock held across a preemption produces the livelock-like signature of §58.10.
- **`fork()` in a threaded process**: the child inherits mutexes locked by threads that no longer exist. Any allocation in the child deadlocks in `malloc`'s arena lock. The canonical signature is a child process hung in `_int_malloc` immediately after `fork` — hence `pthread_atfork` and the rule that only async-signal-safe calls are legal between `fork` and `exec` (Ch. 31 §31.3–§31.4).

---

## 58.10 Livelock and CPU-Spin Diagnosis

The signature is the inverse of deadlock: **100 % CPU, no forward progress**. In a low-latency system this is genuinely ambiguous, because a healthy busy-poll loop (Ch. 55 §55.3) is *also* 100 % CPU — so the diagnosis must be based on progress counters, not on CPU usage.

**Distinguishing the cases:**

| Symptom | Likely cause | Confirm with |
|---|---|---|
| 100 % CPU, application counters advancing | Normal busy-poll | Metrics (Ch. 59 §59.1) |
| 100 % CPU, counters frozen, one hot function | Infinite loop / non-advancing parse (Ch. 57 §57.8) | `perf top -p`, repeated `bt` |
| 100 % CPU across several threads, all in CAS retry | **Livelock / contention collapse** on a lock-free structure | `perf record`, look for `lock cmpxchg` dominance and high retry counters |
| 100 % CPU in `__lll_lock_wait` spin phase | Adaptive-mutex spinning under heavy contention | `perf lock`, `off-cpu` profile |
| High `sys` time, low `usr` | Syscall storm — often `epoll_wait` returning immediately (level-triggered fd never drained, Ch. 34 §34.10) | `strace -c -p` (careful: it stops the process per syscall), `perf trace`, `bpftrace` |
| 100 % CPU, cycles high, instructions low | Stalled, not spinning — memory or false-sharing bound (Ch. 28 §28.8) | `perf stat` IPC, cache-miss counters |

**The zero-perturbation method** is the one to lead with, because attaching a debugger to a hot production process is often unacceptable:
```
perf top -p <pid>                        # what is executing right now
perf record -g -F 999 -p <pid> -- sleep 10 ; perf report   # sampled stacks
perf stat -p <pid> -- sleep 5            # IPC, branch misses, cache misses
```
A flat profile dominated by one function with high IPC is an infinite loop; a profile dominated by an atomic RMW with *low* IPC is contention (Ch. 43 §43.20).

**The poor man's profiler** — attach, `thread apply all bt`, detach, repeat a dozen times — is still remarkably effective for a hung process, because the modal stack is the answer. `pstack`/`eu-stack` do this without the full debugger cost.

**Livelock proper** is progress-free mutual retry: two threads repeatedly back off and retry in lockstep, or a CAS loop where every attempt is invalidated by another thread's success (Ch. 26 §26.1). Lock-free guarantees *system-wide* progress (someone advances), so a true CAS livelock at the system level indicates a bug in the algorithm; what usually happens instead is **starvation** of one thread and cache-line contention collapse, where throughput *falls* as thread count rises because the contended line ping-pongs (Ch. 28 §28.8, Ch. 26 §26.15). Confirm with a per-thread retry counter — instrumenting the retry count is the single most useful thing you can add to a CAS loop, and it costs a relaxed increment.

**Spin-with-preemption** is the low-latency-specific trap: a thread holding a spinlock is preempted (or its core is stolen by a housekeeping task or an interrupt), and every other spinner burns a full scheduling quantum. Signature: periodic multi-millisecond latency spikes correlated with `sched:sched_switch` events on the isolated cores. `perf sched`, and the `nr_involuntary_switches` field in `/proc/<pid>/task/<tid>/status`, are the confirmation. The fix is architectural (Ch. 31 §31.19, Ch. 24 §24.18), not a debugger session.

---

## 58.11 Memory-Corruption Diagnosis

Memory corruption's defining property is that **the crash is far from the bug**, in both time and space. The discipline is to recognize the class from the signature, then use a tool that catches the write rather than the consequence.

**Signatures by class:**

| Class | Typical crash site | Distinguishing signature |
|---|---|---|
| **Heap buffer overflow** | In `free`/`malloc` much later | glibc aborts: `malloc(): invalid size`, `free(): invalid next size (fast)`, `corrupted top size`, `double free or corruption` — all mean *heap metadata* was overwritten by an adjacent-block overflow |
| **Use-after-free** | Anywhere; often a vtable call | `$rip` garbage, or the object's first 8 bytes hold a **free-list pointer** (a heap address) where a vtable pointer belongs. `p obj->vptr` naming a nonsensical symbol is the tell |
| **Double free** | In `free` | `double free or corruption (fasttop)`; glibc's tcache has a `key` field precisely to detect this |
| **Stack buffer overflow** | On `ret`, jumping to garbage | `$rip` = ASCII or a data value; stack canary version aborts with `*** stack smashing detected ***` (`-fstack-protector-strong`) |
| **Use-after-return / dangling stack reference** | Reads plausible-then-garbage values | Value correct immediately after the call, garbage after the next call reuses the frame |
| **Wild write via bad index** | Anywhere | The corrupted target is unrelated to the writer; a watchpoint is the only reliable route |
| **Type confusion / bad `reinterpret_cast`** | On member access | Fields hold values from a different layout; sizes and offsets are "shifted" |
| **Buffer written by a wire-controlled length** | In `memcpy` | `$rdx` enormous; trace back to an unvalidated length field (Ch. 51 §51.11) |
| **Data race producing torn state** | Invariant violated, no memory error | ASan/Valgrind report **nothing**; only TSan finds it |

**Tools, and the crucial point that they detect different things:**

| Tool | Detects | Misses | Cost |
|---|---|---|---|
| **ASan** (`-fsanitize=address`) | Heap/stack/global overflow, UAF, double free, and (with `detect_stack_use_after_return=1`) UAR | Uninitialized reads, races, intra-object overflow by default | ~2× time, ~3× memory |
| **MSan** (`-fsanitize=memory`) | Reads of **uninitialized** memory, with origin tracking (`-fsanitize-memory-track-origins=2`) | Everything ASan finds; requires *all* deps instrumented | ~3× |
| **UBSan** | Misalignment, overflow, bad enum/bool values, invalid downcasts (`-fsanitize=vptr`) | Memory errors | small |
| **Valgrind Memcheck** | Uninitialized *and* invalid accesses, leaks; **no recompile needed** | Intra-heap-block overflows, races | 20–50× |
| **TSan** | Data races, lock-order inversion | Memory errors | ~10× |
| **glibc `MALLOC_PERTURB_`, `MALLOC_CHECK_=3`, `GLIBC_TUNABLES`** | Some corruption, earlier | Most | tiny |
| **Hardware: ARM MTE, Intel LAM/`-fsanitize=hwaddress`** | Same as ASan, ~5–15 % overhead | — | production-viable |

The practical hierarchy: **ASan for a reproducible case; a watchpoint for a known-corrupted address; MTE/HWASan or a guard-page allocator for production.**

**The watchpoint technique** (§58.2) is the definitive answer for "the value changes and I don't know who writes it," and it is what an interviewer wants to hear: find the address once, `watch -l *(uint64_t*)addr`, run, and the debugger stops on the writing instruction with the stack. Its limitation is that the address must be stable across runs — which ASLR breaks (`setarch -R`, or `set disable-randomization on`, which GDB does by default) and which a heap address may break anyway. When the address varies, use ASan first to localize.

**Guard-page allocation** is the heavyweight alternative: place each allocation at the end of a page with the next page unmapped (`electric fence`, `libgmalloc` on macOS, glibc's `M_PERTURB`+`mmap` threshold, or ASan's `redzone` mode). Every overflow faults *immediately*, at the exact instruction, converting a delayed corruption into a precise SIGSEGV. It costs a page per allocation and is only viable for targeted runs.

**Corruption you cannot see with any of these**: a data race that tears a 16-byte structure (Ch. 25 §25.20), an ABA-corrupted lock-free list (Ch. 26 §26.10), or a use-after-free in a reclamation scheme (hazard pointers/EBR, Ch. 26 §26.12–§26.13) — because the memory is legitimately allocated the whole time. Those require TSan, model checking (Ch. 57 §57.11), and invariant assertions inside the structure.

---

## 58.12 Heap Debugging

Beyond corruption, the heap produces three operational problems — **leaks**, **growth without leaks (fragmentation)**, and **latency spikes from allocation** — each with a different tool.

**Leaks.** LeakSanitizer is built into ASan (`ASAN_OPTIONS=detect_leaks=1`, default on Linux) and can also be used standalone (`-fsanitize=leak`); it reports at exit, with allocation stacks, classified as *definitely* vs *indirectly* lost. `LSAN_OPTIONS=suppressions=lsan.supp` handles known one-time allocations. Valgrind Memcheck's `--leak-check=full --show-leak-kinds=all` gives the same information without a rebuild, plus "still reachable" (usually benign: singletons, static caches). For a long-running trading process, exit-time leak checking is nearly useless — the process is supposed to run all day. Use `__lsan_do_recoverable_leak_check()` invoked periodically or on a signal, or track allocation counts as a metric.

**Growth without leaks.** RSS rising with no leaked blocks means **fragmentation** or **arena growth** (Ch. 7 §7.13, Ch. 32 §32.23). Diagnostics:
```
malloc_info(0, stdout)                   # glibc: per-arena XML with free/total sizes
malloc_stats()                           # human-readable summary
cat /proc/<pid>/smaps_rollup             # Rss, Pss, and per-mapping detail
jemalloc: MALLOC_CONF=stats_print:true, prof:true, prof_leak:true
tcmalloc: MallocExtension::GetStats, HEAPPROFILE=
```
glibc allocates a **64 MB arena per thread** (up to `8 × ncores`), so a thread-per-connection design shows enormous VSZ and stepped RSS growth that is not a leak. `M_ARENA_MAX` / `MALLOC_ARENA_MAX=2` is the standard mitigation; switching to jemalloc/tcmalloc/mimalloc is the other. `malloc_trim(0)` returns free top-of-heap memory to the OS, which `free` does not do automatically below `M_TRIM_THRESHOLD`.

**Allocation profiling** — where allocations come from and how much they cost — is covered in Ch. 43 §43.23; the tools are jemalloc/tcmalloc heap profilers, `heaptrack` (excellent flame-graph output, low enough overhead for a soak run), Massif, and `bpftrace` uprobes on `malloc`.

**The low-latency angle, which is the real interview content.** On the hot path the correct number of allocations is **zero** (Ch. 55 §55.1, Ch. 8 §8.8), because `malloc` can take a lock, touch a cold arena, trigger `brk`/`mmap` and therefore page faults, and occasionally take microseconds. Debugging technique follows: rather than profiling allocations, **assert their absence**.

```cpp
// Interpose and abort on any allocation between the markers.
static std::atomic<bool> g_no_alloc{false};
void* operator new(std::size_t n) {
    if (g_no_alloc.load(std::memory_order_relaxed)) __builtin_trap();  // stack points at the culprit
    if (void* p = std::malloc(n)) return p;
    throw std::bad_alloc{};
}
```
`__builtin_trap()` gives an immediate SIGILL with the offending stack — far better than a counter that tells you the count but not the site. The same pattern applies to syscalls (a `seccomp` filter returning `SIGSYS` on anything but the whitelist) and to page faults (compare `getrusage(RUSAGE_THREAD)`'s `ru_minflt` across the hot section, Ch. 32 §32.4). These three assertions — no allocation, no syscall, no page fault — are the operational definition of a clean hot path and are checkable in CI (Ch. 57 §57.16).

---

## 58.13 Crash-Handler Limitations

A **crash handler** is a signal handler for `SIGSEGV`/`SIGBUS`/`SIGFPE`/`SIGILL`/`SIGABRT` that records diagnostics before the process dies. Almost every hand-written one is subtly unsound, and knowing exactly why is a favourite interview probe.

**Constraint 1: async-signal safety.** A handler may call only the functions in the POSIX async-signal-safe list (`write`, `_exit`, `signalfd`-adjacent primitives, `kill`, some others) — see Ch. 33 §33.15. Forbidden in practice:

- `malloc`/`new`, and therefore `std::string`, `std::vector`, `std::ostringstream`, `std::format` into a dynamic buffer, and **`std::stacktrace::current()`** (§58.5). If the crash occurred *inside* `malloc` (very common with heap corruption, §58.11), the arena lock is already held and the handler deadlocks — producing a hung process with no core instead of a crash report.
- `printf`/`fprintf` (buffered, locks, allocates). Use `write(2)` to a preopened fd.
- Anything taking the dynamic-loader lock, which includes `dlopen`, `backtrace_symbols`, and lazy PLT resolution of a function not yet called (Ch. 41 §41.12) — so **pre-resolve** every function the handler needs, or link with `-Wl,-z,now`.
- Locks of any kind, since the crashing thread may hold them.

**Constraint 2: the stack may be unusable.** For a **stack overflow**, the guard page is what raised `SIGSEGV`, and the handler runs on that same exhausted stack — so it immediately faults again and the kernel kills the process with no handler output at all. The fix is `sigaltstack()` plus `SA_ONSTACK`:
```cpp
static char alt[SIGSTKSZ * 4];
stack_t ss{ .ss_sp = alt, .ss_flags = 0, .ss_size = sizeof alt };
sigaltstack(&ss, nullptr);
struct sigaction sa{};
sa.sa_sigaction = handler;
sa.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESETHAND;
sigemptyset(&sa.sa_mask);
sigaction(SIGSEGV, &sa, nullptr);
```
`SA_SIGINFO` gives `siginfo_t*` (so `si_addr`, the faulting address) and `ucontext_t*` (so the full register set at the fault, including `uc_mcontext.gregs[REG_RIP]` — the only way to know where it crashed if you cannot unwind).

**Constraint 3: re-entrancy.** If the handler itself crashes, it re-enters. `SA_RESETHAND` restores the default disposition so the second fault produces a normal core; alternatively set a static `volatile sig_atomic_t` guard and `_exit` on re-entry.

**Constraint 4: it must not prevent the core dump.** A handler that calls `exit()` or `_exit()` destroys the most valuable artifact you have. The correct ending is to **restore the default handler and re-raise**, so the kernel produces the core with the original signal and the original faulting context:
```cpp
signal(sig, SIG_DFL);
raise(sig);            // or: kill(getpid(), sig) — for the whole process
```

**Constraint 5: threads.** The handler runs on whichever thread faulted; `pthread_self()` inside it identifies that thread, but capturing *other* threads' stacks from a signal handler requires signalling them (`pthread_kill` with a dedicated signal, each handler writing its own stack) — fragile, and a core dump does it correctly for free.

**What a handler should therefore do**, minimally and safely: write a fixed-size, pre-formatted record with `write(2)` to a pre-opened fd — signal number, `si_addr`, `si_code`, the PC/SP from `ucontext`, the build ID (§58.8), the thread id and name, and a raw *address-only* backtrace from a signal-safe unwinder (`libunwind`'s `unw_backtrace`, or `backtrace()` which is generally safe once pre-warmed, but not `backtrace_symbols`) — then flush the flight-recorder ring buffer (Ch. 59 §59.13), which should already be a preallocated, lock-free, mmapped region precisely so that dumping it needs no allocation. Then restore and re-raise.

**In a trading system the handler has a domain job too**: it may need to trip the kill switch or rely on the exchange's cancel-on-disconnect (Ch. 56 §56.18, Ch. 54 §54.13). Doing this *from* the handler is risky — a `write` to an already-broken socket, or a `send` requiring a lock. The robust design puts the safety action outside the crashing process entirely: a watchdog or a separate risk process observes the heartbeat's disappearance and cancels (Ch. 56 §56.8). "The crashing process cannot be trusted to clean up after itself" is the principle, and it is the right thing to say.

---

## Key Interview Questions

1. **Why do variables show as `<optimized out>`, and does `-g` slow the program down?** — DWARF describes a variable's location per PC range; if the value lives only in a reused register, was constant-folded, or was never materialized, there is no location to report — the debugger is telling the truth. `-g` itself costs nothing at runtime (it only adds non-loaded `.debug_*` sections), so always build production `-O2 -g` and split/strip the debug info; `-Og` keeps variables live when you need visibility.
2. **Software vs hardware breakpoints?** — Software rewrites the instruction with `int3` (unlimited, modifies text, costs two context switches per hit); hardware uses the four debug registers (no modification, works on read-only or JIT code, limited to four and to 1/2/4/8 aligned bytes).
3. **Why can a watchpoint make the program 1000× slower?** — GDB falls back to a *software* watchpoint (single-step the whole program, re-evaluate after every instruction) when the region doesn't fit the debug registers. Watch one 8-byte field, not the whole object.
4. **A field holds garbage and you don't know who wrote it. What do you do?** — Take the address once, `watch -l *(uint64_t*)addr`, continue; the debugger stops on the writing instruction with the culprit's stack. Disable ASLR so the address is stable, or use ASan first if it isn't.
5. **How do you unwind a stack with no frame pointers?** — CFI in `.eh_frame` (a per-PC table of where the return address and saved registers live), which is present even in stripped binaries because C++ exceptions need it. Failing that, scan the stack for values that land in executable mappings preceded by a `call`.
6. **Why enable `-fno-omit-frame-pointer` in production?** — ~1 % cost for fast, reliable unwinding in `perf`, `bpftrace`, and crash handlers; CFI unwinding is slower and fails in asm/JIT frames. The industry has re-standardized on frame pointers for exactly this reason.
7. **`$rip` is 0 in a core. What happened?** — A call through a null or corrupted function pointer or vtable slot. `*$rsp` holds the return address and therefore names the caller.
8. **`si_addr` is `0x28` with a null-pointer fault. What does the offset tell you?** — The member offset within the null object — it identifies which field was accessed, and therefore usually which line.
9. **You crash inside `free`. Where is the bug?** — Not in `free`. A heap-buffer overflow overwrote allocator metadata earlier; the glibc message (`invalid next size`, `corrupted top size`) confirms it. Reproduce under ASan.
10. **How do you tell a use-after-free from a wild write?** — UAF: the freed object's first bytes hold a heap-looking free-list pointer where a vtable should be, and the object's contents look like allocator metadata. Wild write: the corrupted target has no relationship to the writer, and only a watchpoint or ASan localizes it.
11. **Why is a core dump huge and what do you do about it?** — Huge-page arenas and large mappings are dumped by default. Trim `/proc/self/coredump_filter` bits, `madvise(MADV_DONTDUMP)` the big buffers, and write to fast local disk.
12. **What are build IDs for?** — Cryptographically pairing a binary with its debug info and its source revision; the core records the build ID of every module, so the debugger (or `debuginfod`) fetches exactly the right symbols. Without it, mismatched symbols produce plausible, wrong backtraces.
13. **What is split DWARF and why use it?** — `-gsplit-dwarf` keeps debug info in `.dwo`/`.dwp` files out of the link, giving much faster links and smaller binaries with the same debuggability via the symbol store.
14. **Deadlock vs livelock: how do you tell them apart in seconds?** — CPU usage. Deadlock is 0 % with threads in `futex_wait`/`__lll_lock_wait`; livelock/spin is 100 % with no progress counters advancing. In a busy-poll system, always confirm with application progress counters, not CPU.
15. **How do you find who holds a mutex from a core?** — `p *(pthread_mutex_t*)&m` and read `__data.__owner` (the owning TID), then map it to a thread with `info threads`. Walk the wait-for graph for a cycle. TSan's deadlock detector finds the lock-order inversion before it ever deadlocks.
16. **All threads are in `pthread_cond_wait` — is that a deadlock?** — No lock cycle; it is a lost wakeup. The predicate became true while no thread was waiting, or `notify` was called without holding the mutex that guards the predicate.
17. **Why is `std::stacktrace::current()` unsafe in a signal handler?** — It allocates and symbolizes, which may take the loader lock and `malloc`'s arena lock — and if you crashed inside `malloc`, the handler deadlocks. Capture addresses only, symbolize offline.
18. **What must a crash handler do and not do?** — Use `sigaltstack` + `SA_ONSTACK` (or a stack overflow gets no output at all), only async-signal-safe calls, pre-resolve everything, write a fixed record with `write(2)`, flush a preallocated flight recorder, then restore `SIG_DFL` and re-raise so the kernel still writes the core. Never `exit()`.
19. **Why should the crashing process not cancel its own orders?** — It is untrustworthy at that moment; a `send` may block or take a lock. Put the safety action in an external watchdog or rely on exchange cancel-on-disconnect.

---

## Common Traps

- **Attaching GDB to a live trading process** — stops the world, drops market data, trips watchdogs, and can drop the exchange session.
- **Blaming permissions when attach fails** — it is usually Yama `ptrace_scope`.
- **Debugging a core with a binary that isn't the exact build** — produces a confident, fabricated backtrace. Check build IDs.
- **Building production without `-g`** — `-g` costs nothing at runtime and its absence costs every future postmortem.
- **Assuming `<optimized out>` means the debugger is broken** — the value genuinely does not exist at that PC.
- **Trusting a backtrace to be complete under `-O2`** — inlined frames may be absent and tail calls remove the caller's frame entirely.
- **Setting a conditional breakpoint in a hot loop** — the condition is evaluated in the debugger; expect a 1000×+ slowdown. Use `dprintf`, a Python `stop()`, `__builtin_trap()`, or `bpftrace`.
- **Watching a whole struct** — silently degrades to a software watchpoint and single-steps the program.
- **Forgetting `watch -l`** — the watchpoint disappears when the expression's scope exits.
- **Debugging at `-O0` because the bug reproduces there** — if it vanishes at `-O0` the cause is UB, a race, or uninitialized memory; run the optimized build under sanitizers instead.
- **Assuming the crash site is the bug site** — for heap corruption it never is.
- **Expecting ASan to find data races or uninitialized reads** — it finds neither; those are TSan and MSan, and the three cannot be combined.
- **Running MSan without instrumented dependencies** — an unusable flood of false positives.
- **Treating "still reachable" leaks as bugs** — usually singletons and static caches.
- **Interpreting glibc's per-thread 64 MB arenas as a leak** — cap with `MALLOC_ARENA_MAX` or change allocator.
- **Exit-time leak checking on a process designed to run all day** — use periodic `__lsan_do_recoverable_leak_check`.
- **Calling `malloc`, `printf`, `dlopen`, `backtrace_symbols`, or `std::stacktrace` from a signal handler** — unsafe, and a guaranteed deadlock if the crash was inside the allocator.
- **A crash handler without `sigaltstack`** — stack-overflow crashes produce no output at all.
- **A crash handler that calls `exit()`** — destroys the core dump.
- **A crash handler with no re-entrancy guard** — a fault inside the handler loops.
- **`fork()` in a threaded process, then allocating in the child** — deadlock on an inherited-locked arena.
- **Assuming 100 % CPU means healthy in a busy-poll system, or unhealthy in a blocking one** — always confirm with progress counters.
- **`strace`-ing a latency-sensitive process** — each syscall traps to the tracer; use `perf trace` or `bpftrace`.
- **Symbolizing crash stacks in-process** — slow, allocating, and needs debug info on the production host. Ship addresses plus a build ID; symbolize offline.

---

## Compact Recall Summary

**Tooling.** GDB/LLDB via `ptrace`; attaching stops the world, so prefer `gcore` or an offline core. Know `thread apply all bt`, `p $_siginfo`, `info registers`, `x/16i $pc`, `info sharedlibrary`, `info symbol`, `handle`, `catch throw`, `-batch` scripting, and the Python API. Pretty printers execute Python and choke on corrupt data (`p /r`). For live production, `perf`/`bpftrace`/uprobes instead of a debugger.

**Breakpoints.** Software = `int3` patch, unlimited, two context switches per hit; hardware = four debug registers, no memory modification, 1/2/4/8 aligned bytes. Watchpoints are the corruption workhorse — hardware is free, software single-steps everything at ~1000× cost; use `watch -l` on one 8-byte field.

**Optimized code.** Variable locations are per-PC DWARF expressions, so `<optimized out>` is truthful; inlining hides frames, tail calls delete callers, statements interleave. Always `-O2 -g`; `-Og` for visibility; if the bug vanishes at `-O0` the cause is UB, a race, or uninitialized memory — reach for sanitizers, not `-O0`.

**Cores.** Need `RLIMIT_CORE`, `core_pattern` (a leading `|` pipes to `systemd-coredump`), and `coredump_filter`; trim huge/shared mappings and `MADV_DONTDUMP` big buffers to keep them small. A core holds memory, registers, and `siginfo` — not fds, not history. Match binaries by build ID.

**Postmortem.** Frame pointers make unwinding a `rbp` linked list (worth ~1 % in production); otherwise `.eh_frame` CFI, which survives stripping because exceptions need it; otherwise scan `x/256a $rsp` for return addresses inside executable mappings. `$rip`=0 → call through a null pointer; `si_addr` small → null deref at that member offset; `$rip` in `free` → heap metadata corruption; `si_addr` at a guard page → stack overflow. Arguments live in `RDI/RSI/RDX/RCX/R8/R9` at function entry only.

**Symbols.** DWARF in `.debug_*`; `.eh_frame` is loaded and survives stripping. Ship `-gsplit-dwarf`, strip, archive unstripped binaries + `.dwp` + system libraries in a build-ID-keyed store; `debuginfod` serves them over HTTP. Deduplicate crashes by hashing symbolized top frames.

**Hangs.** Deadlock = 0 % CPU, `futex_wait`/`__lll_lock_wait`, cycle in the wait-for graph — read `pthread_mutex_t.__data.__owner` for the owning TID; all-threads-in-`cond_wait` is a lost wakeup, not a cycle; `fork` in a threaded process deadlocks in `malloc`. TSan's detector finds lock-order inversions before they deadlock. Livelock/spin = 100 % CPU with frozen progress counters; distinguish stall from spin with `perf stat` IPC, and instrument CAS retry counts.

**Corruption and heap.** ASan (overflow/UAF/double-free), MSan (uninitialized, needs all deps instrumented), UBSan (alignment, overflow, bad vptr), Valgrind (no rebuild, 20–50×), TSan (races) — non-overlapping, non-combinable. Guard-page allocation converts delayed corruption into an immediate fault; ARM MTE/HWASan is the production-viable version. RSS growth without leaks is fragmentation or glibc's per-thread 64 MB arenas (`MALLOC_ARENA_MAX`). On the hot path assert *zero* allocations, syscalls, and page faults with a trapping `operator new`, `seccomp`, and `ru_minflt` deltas.

**Crash handlers.** `sigaltstack` + `SA_ONSTACK` or stack-overflow crashes are silent; `SA_SIGINFO` for `si_addr` and `ucontext` registers; only async-signal-safe calls, pre-resolved (`-z now`), no `malloc`/`printf`/`std::stacktrace`; re-entrancy guard via `SA_RESETHAND`; write a fixed record with `write(2)`, flush a preallocated flight recorder, then `SIG_DFL` + `raise` so the kernel still writes the core. Never let the crashing process be responsible for cancelling its own orders — that belongs to an external watchdog or exchange cancel-on-disconnect.
