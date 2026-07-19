# Chapter 34 — System Calls and I/O

*Interview-focused revision notes. The theme: every syscall is a measurable, avoidable tax — this chapter is about what that tax actually pays for, how the kernel charges it, and the four generations of Linux I/O interfaces built to charge it less often.*

---

## 34.1 User Mode and Kernel Mode

x86-64 defines four privilege rings; Linux uses exactly two: **ring 0** (kernel mode) and **ring 3** (user mode). The current privilege level lives in the low two bits of `%cs` and is enforced by the hardware on every instruction fetch, memory access, and I/O port access.

**What ring 3 cannot do:** execute privileged instructions (`hlt`, `lgdt`, `lidt`, `mov` to/from control registers, `wrmsr`, `invlpg`, `wbinvd`), access memory whose page-table entries lack the User bit, or touch I/O ports outside its I/O permission bitmap. Attempting any of them raises `#GP` — which the kernel converts to `SIGSEGV` or `SIGILL`.

**The address-space split.** A Linux process's 64-bit virtual address space is divided: user space occupies the low canonical half (`0x0000...` – `0x00007fff_ffffffff`, 128 TiB with 4-level paging), and the kernel occupies the high half (`0xffff8000...` upward). The kernel's mappings are present in *every* process's page tables, marked supervisor-only, which is why a syscall does **not** require a page-table switch and therefore does not flush the TLB — the single most important fact for understanding why a syscall is 60 ns and a context switch is 2 µs (§34.3).

**KPTI changed that.** Meltdown (2018) showed that speculative execution could leak supervisor-mapped data readable through a fault-suppressed load. **Kernel Page-Table Isolation** gives each process two page-table sets: a user set containing only a trampoline stub of kernel text, and a full kernel set. Entering the kernel now writes `CR3` — a page-table switch — and returning writes it back. On hardware without PCID this flushes the entire TLB twice per syscall; with PCID (Westmere+) the flush is avoided but the two `CR3` writes still cost ~100–200 cycles each. Net measured effect: syscall cost roughly **doubled**, from ~50 ns to ~100–180 ns on affected parts, and syscall-heavy workloads regressed 5–30%. `/sys/devices/system/cpu/vulnerabilities/meltdown` reports the status; `nopti` disables it (only defensible on a dedicated, physically-secured trading box, and worth knowing as an answer even if you would not do it).

**The mechanisms that carry data across the boundary** are equally load-bearing: `copy_to_user`/`copy_from_user` perform the copy with fault handling and, historically, SMAP (`stac`/`clac` around the access) to prevent the kernel from accidentally dereferencing a user pointer. Every syscall that moves a buffer pays at least one such copy — the thing `io_uring` registered buffers (§34.21), `mmap`, and kernel bypass (Ch. 47) all exist to eliminate.

**Why the boundary exists at all**, stated crisply for an interview: isolation (one process cannot read another's memory or corrupt the kernel), resource arbitration (the kernel multiplexes CPU, memory, and devices), and controlled hardware access. The cost of that guarantee is the ring transition, and low-latency engineering is largely the discipline of paying it as few times as possible.

---

## 34.2 System-Call Entry

**The modern x86-64 path is `syscall`/`sysret`**, not the legacy `int 0x80`. `int 0x80` performs a full interrupt-gate transition: read the IDT, validate the descriptor, push SS/RSP/RFLAGS/CS/RIP, and switch stacks with segment checks — roughly **250–400 cycles**. The `syscall` instruction is a purpose-built fast path that skips descriptor validation entirely, using MSRs configured at boot:

| MSR | Contents |
|---|---|
| `IA32_LSTAR` (0xC0000082) | Kernel RIP to jump to (`entry_SYSCALL_64`) |
| `IA32_STAR` (0xC0000081) | CS/SS selectors for kernel and user |
| `IA32_FMASK` (0xC0000084) | RFLAGS bits cleared on entry (IF, DF, AC, …) |
| `IA32_KERNEL_GS_BASE` | Per-CPU data pointer, swapped in by `swapgs` |

**The calling convention** (System V AMD64 syscall ABI, distinct from the *function* ABI of Ch. 41 §41.5):

```
rax = syscall number          (function ABI would use rax for return only)
rdi, rsi, rdx, r10, r8, r9    = args 1..6   ← note r10, NOT rcx
rcx  ← clobbered: saved user RIP
r11  ← clobbered: saved user RFLAGS
rax  = return value; negative in [-4095,-1] means -errno
```

`rcx` is displaced to `r10` precisely because the `syscall` instruction itself overwrites `rcx` with the return address. That substitution is a favourite trivia question and a real signal of assembly literacy.

**What the kernel does on entry** (`entry_SYSCALL_64` in `arch/x86/entry/entry_64.S`):

```
syscall                    ; HW: rcx←rip, r11←rflags, rflags &= ~FMASK, rip←LSTAR, cpl←0
  swapgs                   ; swap GS base to per-CPU kernel data
  switch to the kernel stack (per-task, from the per-CPU TSS)
  [KPTI: write CR3 to the kernel page tables]
  PUSH_REGS                ; build struct pt_regs
  [Spectre mitigations: IBRS write / retpoline setup / stack clearing]
  cmp rax, __NR_syscall_max ; bounds check
  call *sys_call_table(,rax,8)
  ... syscall_exit_to_user_mode(): signals, need_resched, rseq, work flags ...
  [KPTI: restore user CR3]  ; swapgs
sysretq                    ; rip←rcx, rflags←r11, cpl←3
```

**`sysret` has a hardware trap** worth knowing: it does not validate that the return RIP is canonical, so a non-canonical `rcx` faults in *ring 0* with the user stack loaded — the classic "sysret privilege escalation" bug class. Linux checks canonicality and falls back to the slower `iret` path when needed, which is also what happens whenever registers were modified (after `ptrace`, after a signal, or after `fork` in the child).

**AArch64** uses `svc #0` with the number in `x8`, arguments in `x0`–`x5`, and the return in `x0` — no errno convention; failure is a negative return, and libc translates.

The practical upshot for an interviewer: the ~50–60 ns floor of a modern syscall is not one big cost but the sum of the `syscall`/`sysret` pair (~40 cycles), `swapgs` and stack switch, saving/restoring `pt_regs`, KPTI `CR3` writes, and the speculation mitigations — and you can name which of those you would disable, and which you cannot.

---

## 34.3 Mode Switches Versus Context Switches

These are conflated constantly and the distinction is the cleanest way to explain why syscalls are cheap and blocking is not.

| | **Mode switch** (syscall/trap) | **Context switch** (task change) |
|---|---|---|
| What changes | Privilege level, stack, GS base | Everything: registers, page tables, kernel stack, FPU state |
| Page-table switch (`CR3`) | No (unless KPTI) | **Yes** — unless switching between threads of the same process |
| TLB impact | None (kernel mappings are global; PCID avoids KPTI flushes) | Full or PCID-tagged flush; **TLB refill afterwards is the real cost** |
| Cache impact | Kernel code/data evict some of your L1/L2 | New task evicts your working set from L1/L2, sometimes L3 |
| Branch predictor | Some pollution | Substantially polluted; BTB/RSB may be flushed by mitigations |
| Direct cost | **~50–70 ns** (~150–200 with KPTI + mitigations) | ~1–3 µs direct |
| **Indirect cost** | Small | **~10–50 µs** to refill caches/TLB and regain steady-state IPC |
| Scheduler involved | No | Yes (`schedule()`, run-queue lock, load balancing) |

The indirect cost dominates and is the number people forget. `perf stat` reports `context-switches` and `cpu-migrations`; the *direct* switch shows up as a few microseconds, but the victim's IPC stays depressed for tens of microseconds afterwards as it re-warms L1d, L1i, L2, and the TLB. On a latency-critical thread that is the difference between a 1 µs and a 40 µs tick-to-trade outlier — and it is exactly what core isolation (§35.16) exists to prevent.

**A blocking syscall costs both**, plus a wakeup:

```
read() on an empty socket:
  mode switch in (~60 ns)
  → no data → schedule() → context switch away (~1–3 µs)
  → [idle, possibly entering a C-state — §35.13]
  → packet arrives → IRQ → softirq → wake_up → run-queue insert
  → scheduler picks you (wakeup latency: ~2–10 µs typical, up to 100s of µs loaded)
  → context switch in (~1–3 µs)  + cache/TLB refill (~10–50 µs)
  → copy_to_user, mode switch out (~60 ns)
Total: 5–60 µs, of which the SYSCALL is ~1%.
```

That decomposition is the answer to "why do you busy-poll?" The syscall is not the enemy; **the sleep and the wakeup are**. A non-blocking `recvmsg` that returns `EAGAIN` in a spin loop costs 60–100 ns and never surrenders the core, keeping caches, TLB, and branch predictors hot — which is worth far more than the syscall you saved.

**Voluntary vs involuntary switches** matter diagnostically. `/proc/PID/status` reports `voluntary_ctxt_switches` (you blocked) and `nonvoluntary_ctxt_switches` (you were preempted). A busy-polling thread on an isolated core should show *both* near zero and a rising `nonvoluntary` count is the fingerprint of a housekeeping task or kernel thread stealing your core.

---

## 34.4 vDSO

The **vDSO** (virtual dynamic shared object) is a small ELF shared library the kernel maps into every process's address space, containing implementations of a handful of syscalls that can execute entirely in user space. It is the single largest syscall-avoidance mechanism in ordinary Linux programs.

```
$ cat /proc/self/maps | tail -3
7ffd...  r-xp  [vdso]        ← the code
7ffd...  r--p  [vvar]        ← the shared data page the kernel updates
7ffd...  r-xp  [vsyscall]    ← legacy, emulated, deprecated
```

**How it works.** The kernel maintains a page (`vvar`) containing the current clocksource selection, the last TSC value read at the last timekeeping update, the corresponding nanosecond timestamp, the multiplier and shift for TSC→ns conversion, the realtime/monotonic offset, and a **sequence counter** (a seqlock, Ch. 26 §26.9). `clock_gettime` in the vDSO reads the seqlock, executes `rdtsc`, applies `(tsc - last) * mult >> shift`, adds the base, re-checks the seqlock, and returns — with **no ring transition at all**.

```c
// Essence of __vdso_clock_gettime for CLOCK_MONOTONIC:
do {
    seq = read_seqcount_begin(vdata);
    cycles = rdtsc_ordered();                 // rdtsc + lfence, or rdtscp
    ns = vdata->base_ns + (((cycles - vdata->cycle_last) & mask) * vdata->mult) >> vdata->shift;
} while (read_seqcount_retry(vdata, seq));
```

**The functions provided on x86-64:** `clock_gettime`, `gettimeofday`, `time`, `clock_getres`, `getcpu`, and (5.x+) `clock_gettime64`. Notably absent: everything that must actually touch kernel state.

**The measured numbers, which you should have memorized (typical modern x86-64 Linux server):**

| Call | Cost |
|---|---|
| `rdtsc` (raw instruction) | **~15–25 cycles ≈ 5–8 ns** |
| `rdtscp` (serializing w.r.t. prior loads) | ~25–35 cycles ≈ 8–12 ns |
| `clock_gettime(CLOCK_MONOTONIC)` **via vDSO** | **~20–25 ns** |
| `clock_gettime(CLOCK_MONOTONIC_COARSE)` via vDSO | ~5–7 ns (just reads the cached value; ~1–4 ms granularity) |
| `clock_gettime` forced through the real syscall | **~250–500 ns** |
| Trivial syscall (`getpid`, cold) | ~50–70 ns (~150+ with KPTI) |

**The critical dependency:** the vDSO fast path works **only if the clocksource is `tsc`**. If the kernel demotes the clocksource to `hpet` or `acpi_pm` (because it detected TSC instability, §35.3), the vDSO cannot compute the time in user space and every `clock_gettime` becomes a real syscall reading an uncached MMIO register — **~250 ns for HPET, and worse under contention because the HPET is a single shared device**. A 10× regression in timestamping cost with no code change is one of the most recognizable production incidents in this area, and the diagnostic is one line:

```
$ cat /sys/devices/system/clocksource/clocksource0/current_clocksource
tsc
```

Other gotchas: seccomp filters cannot see vDSO calls (there is no syscall to filter), `strace` cannot see them either (which is why `strace` on a timestamp-heavy program shows nothing), and the vDSO's `getcpu` is what makes per-CPU data structures cheap in user space.

---

## 34.5 System-Call Overhead

**The number to quote:** a minimal syscall on a modern x86-64 Linux server costs **~50–70 ns** without mitigations and **~150–250 ns** with KPTI plus Spectre mitigations enabled. Measure it yourself with a tight `getpid()` loop (`getpid` is not cached by glibc since 2.25, precisely so it works as a benchmark) or with `perf bench syscall basic`.

**Decomposition of a ~60 ns null syscall:**

```
syscall/sysret instruction pair            ~15-20 ns   (40-60 cycles, microcoded)
swapgs + kernel stack switch                ~3 ns
push/pop pt_regs (15 GPRs)                  ~5 ns
syscall table dispatch (indirect call)      ~2 ns  (retpoline: +10-20 ns)
entry/exit work: signals, resched, rseq     ~5 ns
KPTI CR3 write x2                          +40-80 ns  (less with PCID)
IBRS/IBPB write (if enabled)               +50-100 ns
```

**Then the indirect costs**, which for a real syscall exceed the direct ones: the kernel's code and data evict some of your L1i/L1d and pollute the branch predictors, so the *next* few hundred instructions of your code run slower. A syscall that also copies a buffer adds `copy_to_user`/`copy_from_user` at roughly memcpy speed plus SMAP `stac`/`clac`.

**Representative real syscall costs (warm, x86-64, no KPTI):**

| Syscall | Typical cost |
|---|---|
| `getpid` | 50–70 ns |
| `clock_gettime` via vDSO | 20–25 ns (no ring transition) |
| `gettimeofday` forced syscall | 250–500 ns |
| `read`/`write` on a pipe, small | 300–800 ns |
| `send`/`recv` on a UDP socket, small | **1–3 µs** (stack traversal dominates) |
| `epoll_wait` returning immediately | 200–400 ns |
| `epoll_wait` that sleeps and is woken | 2–10 µs |
| `mmap` / `munmap` | 1–5 µs (page-table work, TLB shootdown on unmap) |
| `futex` slow path with wakeup | 1.5–5 µs |
| `fork` | 50–200 µs |
| `execve` | 200 µs–1 ms |

Note the shape: pure entry/exit is tens of nanoseconds; anything touching the network stack is microseconds; anything touching page tables or process creation is tens to hundreds of microseconds. **The syscall boundary is rarely the expensive part of an expensive syscall** — which is why "avoid syscalls" is really "avoid the *work* behind syscalls," and why batching (`sendmmsg`, `io_uring`) buys much less than kernel bypass does.

**Reduction strategies, in increasing order of aggression:**

1. **vDSO** for time (§34.4) — free, automatic.
2. **Batching**: `writev`/`readv` (§34.14), `sendmmsg`/`recvmmsg` (Ch. 45 §45.11), `io_uring` multi-SQE submission (§34.13). Amortizes entry cost over N operations.
3. **Non-blocking + readiness** so you never sleep (§34.7).
4. **`io_uring` with `IORING_SETUP_SQPOLL`** (§34.22) — a kernel thread polls the submission queue, so steady-state I/O involves **zero syscalls**.
5. **Kernel bypass** (DPDK, ef_vi, OpenOnload, AF_XDP — Ch. 47): the NIC's descriptor rings are mapped into user space and the kernel is not in the data path at all. Round-trip drops from ~5–10 µs to **~1–2 µs**, and the syscall count on the hot path is zero.

**Measurement.** `strace -c -f ./prog` gives a syscall histogram with time attribution (but slows the program 10–100×, §34.6). `perf stat -e 'syscalls:sys_enter_*'` counts without the ptrace penalty. `perf trace` is the low-overhead strace. For a hot path, the target is a syscall count of **zero per message**, and `perf stat -e raw_syscalls:sys_enter -p PID` over a steady-state minute is the check.

---

## 34.6 strace and ltrace

**`strace`** traces syscalls using `ptrace(PTRACE_SYSCALL)` (or, on modern versions, seccomp-BPF-assisted stops via `PTRACE_SECCOMP` with `--seccomp-bpf` for filtered tracing). The tracer is stopped **twice per syscall** — once on entry, once on exit — and each stop is a full context switch to the tracer, a `ptrace` peek at the registers, and a switch back.

**Cost: 100–500× slowdown on a syscall-heavy program**, adding roughly **50–150 µs per traced syscall**. This is the single most important fact about strace: it is a *correctness* and *behaviour* tool, never a performance tool, and any latency measured under strace is meaningless. The probe effect (Ch. 43 §43.26) is total.

```bash
strace -f -p PID                       # attach, follow threads/children
strace -c -f ./prog                    # summary histogram: count, time, errors per syscall
strace -e trace=network -s 256 ./prog  # filter by class; show 256 bytes of buffers
strace -T -tt ./prog                   # per-call duration and wall-clock timestamps
strace -k ./prog                       # stack trace at each syscall (very slow, very useful)
strace -y -yy ./prog                   # decode fds to paths and socket addresses
```

**What strace is uniquely good for**, and the right answers to "how would you debug this":

- *"It can't find its config file."* — `strace -e trace=openat` shows the exact paths tried and the `ENOENT`s.
- *"It hangs."* — attach; the last line shows what it is blocked in (`futex`, `epoll_wait`, `read`, `connect`).
- *"Permissions."* — the `EACCES`/`EPERM` and its argument.
- *"It's slow and I don't know why."* — `-c` reveals a syscall executed a million times that should have been executed once.
- *"Which fd is that?"* — `-y` decodes.

**What strace cannot see:** vDSO calls (§34.4), so a program spending all its time in `clock_gettime` looks idle; anything in user space; and `io_uring` operations submitted via SQPOLL (no syscall is made).

**`ltrace`** traces *library* calls by rewriting PLT entries (Ch. 41 §41.12) — so it only sees calls that go through the PLT, meaning it is defeated by static linking, `-fno-plt`, LTO-inlined calls, and internal (non-exported) calls. It is far less reliable than strace and largely superseded by `perf probe` on uprobes or a `bpftrace` `uprobe:` script.

**The modern replacements, which you should name:**

| Tool | Mechanism | Overhead |
|---|---|---|
| `strace` | ptrace, 2 stops/syscall | **100–500×** |
| `perf trace` | perf ring buffer + tracepoints | **~5–20%** |
| `bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'` | eBPF, in-kernel aggregation | **~1–5%** |
| `ftrace` (`trace-cmd`, `/sys/kernel/tracing`) | Static tracepoints, in-kernel ring | ~1–10% |

The reason eBPF wins is that aggregation happens **in the kernel**: a histogram is updated in a BPF map and only the map is read out, so there is no per-event user-space wakeup. That architectural point — move the reduction to where the data is — is the same idea as `io_uring` batching and is a good thing to articulate.

---

## 34.7 Blocking and Non-Blocking I/O

A **blocking** descriptor puts the calling thread to sleep when the operation cannot complete; a **non-blocking** one returns immediately with `EAGAIN`/`EWOULDBLOCK` (the same value on Linux).

```c
int fl = fcntl(fd, F_GETFL, 0);
fcntl(fd, F_SETFL, fl | O_NONBLOCK);
// Better: set it at creation to avoid a TOCTOU window and two syscalls
int s = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
int f = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
accept4(lfd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);   // accept() does NOT inherit O_NONBLOCK
```

**`accept()` does not inherit the listening socket's `O_NONBLOCK`** — a persistent bug. Use `accept4`. Similarly, `O_NONBLOCK` is a property of the **open file description**, not the descriptor, so `dup()`ed fds share it and a `fork`ed child sees it too (§34.18).

**Where `O_NONBLOCK` silently does nothing: regular files and block devices.** A `read()` from a file always "succeeds" from the API's perspective, blocking on the page fault or the disk I/O regardless of the flag. This is the reason `epoll` cannot be used for file I/O, the reason thread pools exist behind file access in every event-driven server, and one of the two original motivations for `io_uring` (§34.13). A candidate who says "I'll epoll the file descriptor" has revealed the gap.

**The three architectures:**

| Model | Concurrency cost | Latency | Notes |
|---|---|---|---|
| Thread-per-connection, blocking | ~8 KiB–8 MiB stack + a task each; scheduler pressure | Good at low load, collapses at high | Simple; fine for hundreds of connections |
| Non-blocking + readiness (epoll) | One thread, O(ready) per iteration | Good | The standard server design |
| Non-blocking + **busy-poll**, pinned | One dedicated core | **Best**: no wakeup, hot caches | The HFT design |

**The busy-poll argument, quantified.** A blocking `recv` that sleeps and is woken costs (§34.3) 5–60 µs of wakeup plus cache-refill. A non-blocking `recv` returning `EAGAIN` costs ~1–3 µs of syscall+stack traversal, or ~100 ns with kernel bypass. So spinning wins whenever the expected idle interval is short relative to the wakeup cost — and it additionally keeps the L1/L2, TLB, and branch predictors warm, which is worth several microseconds on the first message after an idle period. The costs are one burned core per polling thread, real power/thermal consequences (which interact with turbo headroom, §35.12), and a serious problem if you over-subscribe cores.

**Middle grounds worth naming:** `SO_BUSY_POLL`/`sysctl net.core.busy_poll` makes a *blocking* socket call poll the NIC driver for N microseconds before sleeping — a kernel-side hybrid (Ch. 45 §45.8); `epoll_wait` with a small timeout; and the general "spin for N µs then arm an eventfd and block" pattern, where the correct N is the wakeup cost (~5 µs), because spinning longer than the thing you are avoiding is pure waste.

---

## 34.8 Synchronous and Asynchronous I/O

The axes are independent and routinely confused:

- **Blocking vs non-blocking** — does the call wait?
- **Synchronous vs asynchronous** — does the *data transfer* happen during the call, or later with a completion notification?

|  | Synchronous | Asynchronous |
|---|---|---|
| **Blocking** | `read()` on a blocking fd | (degenerate) |
| **Non-blocking** | `read()` with `O_NONBLOCK`; `epoll` + `read` | `io_uring`, POSIX AIO, Windows IOCP |

`epoll` is **not** asynchronous I/O. It is a readiness notification mechanism: it tells you a subsequent *synchronous* `read` will not block, and you still perform the copy yourself in a syscall. That is the **readiness model** (Linux, BSD). The **completion model** (Windows IOCP, `io_uring`) instead accepts the buffer up front, performs the transfer in the kernel, and notifies you when it is *done*. Stating this distinction correctly is a reliable interview differentiator.

```
READINESS (epoll):    epoll_wait → "fd 7 is readable" → read(7, buf, n) → data
                      2 syscalls per event; you own the buffer at read time
COMPLETION (io_uring): submit READ(7, buf, n) → ... → completion "42 bytes in buf"
                      0–1 syscalls per event; kernel owns the buffer until completion
```

**POSIX AIO (`aio_read`/`aio_write`)** is the historical failure worth knowing about: glibc implements it in **user-space threads**, so it delivers none of the promised kernel asynchrony and is strictly worse than a thread pool. Linux's native `libaio` (`io_submit`/`io_getevents`) is real, but works only with `O_DIRECT` on regular files — buffered `io_submit` silently blocks, defeating the purpose — and supports no sockets. Both were superseded in 2019 by `io_uring`, and "why did Linux need io_uring when it had AIO?" is a common question whose answer is exactly this paragraph.

**Ownership rules for the completion model**, which is where the real bugs live: once you submit, the kernel owns the buffer and the `iovec` array until the completion arrives. You may not free, reuse, or move it, and you may not free it after cancelling until the cancellation completion arrives. The same discipline applies to `MSG_ZEROCOPY` on sockets (Ch. 45 §45.17), where the completion arrives asynchronously on the error queue and freeing the buffer early corrupts the wire.

---

## 34.9 select and poll

Both are **level-triggered readiness scanners** that take the entire interest set on every call — which is their fatal design flaw.

**`select`:**

```c
fd_set rfds; FD_ZERO(&rfds); FD_SET(fd, &rfds);
struct timeval tv = {0, 1000};                       // µs resolution
int n = select(maxfd + 1, &rfds, &wfds, &efds, &tv); // sets are MODIFIED in place
```

Limitations, all disqualifying: **`FD_SETSIZE` is 1024** and using an fd ≥ 1024 with `FD_SET` is a stack buffer overflow, not an error (glibc's `_FORTIFY_SOURCE` catches some cases); the fd_sets are modified so you must rebuild them every iteration; you must track `maxfd` yourself; and the timeout argument is modified on Linux. `select` survives only for portability and for its microsecond timeout.

**`poll`:**

```c
struct pollfd pfds[N];                     // {int fd; short events; short revents;}
pfds[i] = { .fd = s, .events = POLLIN | POLLOUT };
int n = poll(pfds, N, timeout_ms);         // ms resolution; -1 = infinite
// events you can only RECEIVE, never request: POLLERR, POLLHUP, POLLNVAL
```

`poll` removes the 1024 limit and separates `events` from `revents` (so the array is reusable), but retains the core problem.

**The scaling problem, precisely stated.** Both are **O(N) per call in the size of the interest set, not the number of ready events**, and both must copy the entire set into the kernel on each call and scan every descriptor's poll method. For 10,000 idle connections with 1 ready:

```
poll():   copy 10,000 × 8 bytes in, iterate 10,000 poll handlers, copy out,
          then YOU scan 10,000 revents for the 1 that is set   →  ~300–800 µs
epoll:    epoll_wait returns 1 event                            →  ~2–5 µs
```

This is the **C10K problem** and the entire reason `epoll` and `kqueue` exist. The break-even is around a few hundred descriptors; below ~100, `poll` is competitive and simpler.

**`ppoll` and `pselect`** add an atomic signal-mask swap for the race described in Ch. 33 §33.14, and `ppoll` takes a `struct timespec` for nanosecond-granularity timeouts — which is why `ppoll` is occasionally preferred over `epoll_wait` for a small fd set needing sub-millisecond timeouts (pre-`epoll_pwait2`).

**A genuinely non-obvious low-latency point:** for a *small, fixed* set of descriptors — say, four multicast feed sockets — `poll` on 4 fds costs ~1–2 µs and one syscall, versus `epoll_wait`'s ~1 µs plus the setup complexity. The asymptotic argument does not apply, and hand-rolled `recvmmsg` loops with `MSG_DONTWAIT` over 4 sockets beat both. Knowing when the textbook answer is wrong is worth more than the textbook answer.

---

## 34.10 epoll

`epoll` fixes the O(N) problem by keeping the interest set **in the kernel** across calls and returning only ready descriptors.

```c
int ep = epoll_create1(EPOLL_CLOEXEC);
struct epoll_event ev = { .events = EPOLLIN | EPOLLET, .data.ptr = conn };
epoll_ctl(ep, EPOLL_CTL_ADD, fd, &ev);        // also MOD, DEL
struct epoll_event out[64];
int n = epoll_wait(ep, out, 64, timeout_ms);  // returns only READY fds
```

**Kernel data structures**, which explain the complexity:

```
struct eventpoll
 ├─ rbr        : red-black tree of epitems, keyed by (fd, file*) — O(log N) add/mod/del
 ├─ rdllist    : ready list — O(1) to consume
 └─ wq         : wait queue of tasks blocked in epoll_wait

Each epitem registers a callback (ep_poll_callback) on the target file's wait queue.
When the fd becomes ready, the driver/socket wakes its wait queue → the callback
appends the epitem to rdllist and wakes anyone in epoll_wait.
```

So readiness is **pushed** by the source rather than **polled** by the scanner, making `epoll_wait` O(ready). The `data` field is an opaque 64-bit union — store a pointer to your connection object there, not the fd, to avoid a lookup per event.

**The details that matter:**

- **epoll tracks the open *file description*, not the descriptor.** Registration is keyed by (fd, struct file). If you `dup()` an fd and close the original, the description is still open and epoll keeps reporting it — the notorious "epoll won't stop firing on a closed fd" bug. Closing the *last* descriptor removes it automatically; closing one of several does not.
- **`EPOLLONESHOT`** disables the fd after one event; you must `EPOLL_CTL_MOD` to rearm. This is how you guarantee only one thread handles a connection at a time in a multi-threaded epoll pool.
- **`EPOLLEXCLUSIVE`** (4.5+) wakes only one waiter when multiple threads share an epoll set on the same listening socket — the fix for the **thundering herd** on `accept`. The alternative and generally better design is `SO_REUSEPORT` with a separate listening socket and epoll set per thread, giving kernel-side connection hashing and no shared state at all.
- **`EPOLLERR` and `EPOLLHUP` are always reported**, whether or not you requested them. `EPOLLRDHUP` (peer did a half-close, `shutdown(SHUT_WR)`) is distinct from `EPOLLHUP` (both directions down) and is what lets a server detect a graceful client close without a zero-length read.
- **Nesting:** an epoll fd is itself pollable, so epoll sets can be composed (with a depth limit of 5). Used by libraries that must integrate into a host's loop.
- **`epoll_pwait`** adds an atomic sigmask; **`epoll_pwait2`** (5.11+) takes a `timespec` for nanosecond timeouts instead of the millisecond `int`.

**Costs.** `epoll_wait` returning immediately with events: **~200–400 ns** plus ~100 ns per event copied out. `epoll_ctl` ADD/MOD: ~300–600 ns each — which is why you should **not** MOD on every state change; prefer edge-triggered registration once (§34.11) and manage interest in user space. Blocking `epoll_wait` woken by a packet: **2–10 µs**, dominated by wakeup as always.

**Where epoll cannot help:** regular files (always "ready", §34.7), and any per-event latency floor below ~2 µs. A trading system's market-data path typically uses busy-polled `recvmmsg` or kernel bypass and keeps epoll for the control plane.

---

## 34.11 Edge-Triggered and Level-Triggered Readiness

**Level-triggered (LT, the default):** the fd is reported ready as long as the condition *holds*. If 1000 bytes arrive and you read 100, the next `epoll_wait` reports it readable again.

**Edge-triggered (ET, `EPOLLET`):** the fd is reported only when the readiness state *transitions* — i.e., when new data arrives. If you do not drain the buffer, you get **no further notification** until more data arrives, and the residual bytes sit there indefinitely.

```c
// ET REQUIRES this discipline, and O_NONBLOCK, without exception:
for (;;) {
    ssize_t n = read(fd, buf, sizeof buf);
    if (n > 0)                       { process(buf, n); continue; }
    if (n == 0)                      { peer_closed(); break; }
    if (errno == EINTR)              { continue; }
    if (errno == EAGAIN)             { break; }      // drained — NOW you may wait again
    error(); break;
}
```

**An edge-triggered fd that is not `O_NONBLOCK` will deadlock the entire event loop**: the drain loop's final `read` blocks instead of returning `EAGAIN`. This is the single most common ET bug and the reason ET is described as "harder."

| | Level-triggered | Edge-triggered |
|---|---|---|
| Notification | While condition holds | On transition only |
| Must fully drain | No | **Yes, until `EAGAIN`** |
| `O_NONBLOCK` required | Recommended | **Mandatory** |
| Syscalls per burst | More (one wakeup per pass) | **Fewer** (one wakeup, one drain) |
| Partial processing / backpressure | Natural — just stop reading | Awkward; you must track residual state yourself |
| Risk if you get it wrong | Busy loop / spurious wakeups | **Silent stall** — connection hangs forever |
| Multi-threaded handoff | Duplicate wakeups | Cleaner with `EPOLLONESHOT` |

**Write readiness is where LT hurts.** A socket is almost always writable, so registering `EPOLLOUT` level-triggered produces a continuous storm of wakeups. The correct LT pattern is to register `EPOLLOUT` only while you have queued data and deregister when the queue drains — two `epoll_ctl` calls per burst. With ET, you can leave `EPOLLOUT` armed permanently: you only get notified on the `ENOSPC→space` transition. This is the strongest practical argument for ET.

**The starvation hazard of ET:** a connection with an endless stream keeps your drain loop running forever, starving other connections. Production loops cap the drain at N iterations or M bytes and re-queue the connection to a ready list they manage themselves — at which point you have rebuilt part of LT in user space, deliberately.

**`kqueue` offers the same choice** via `EV_CLEAR`, and additionally reports **how many bytes are available** in `kevent.data`, which lets you size a single read exactly — something epoll cannot tell you (you must use `ioctl(FIONREAD)`, another syscall).

---

## 34.12 kqueue

`kqueue` is FreeBSD's (and macOS's) event mechanism — worth knowing because interviewers use it to test whether you understand epoll's *design*, not just its API.

```c
int kq = kqueue();
struct kevent ch[2], ev[64];
EV_SET(&ch[0], fd, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, conn);   // EV_CLEAR = edge-triggered
struct timespec ts = {0, 1000000};                                 // ns resolution
int n = kevent(kq, ch, 1, ev, 64, &ts);   // register AND retrieve in ONE syscall
```

**Design advantages over epoll:**

1. **One syscall does both registration and retrieval.** epoll needs `epoll_ctl` per change plus `epoll_wait`; kqueue batches an array of changes with the wait. For a loop that modifies interest frequently this halves the syscall count.
2. **`kevent.data` carries a payload**: bytes available for `EVFILT_READ`, buffer space for `EVFILT_WRITE`, exit status for `EVFILT_PROC`. epoll returns only a bitmask.
3. **It is a unified event system, not just an fd multiplexer.** Filters cover far more than I/O:

| Filter | Watches |
|---|---|
| `EVFILT_READ` / `EVFILT_WRITE` | fd readiness (including **regular files**, unlike epoll) |
| `EVFILT_VNODE` | File changes: delete, write, rename, attrib |
| `EVFILT_PROC` | Process exit, fork, exec — no `SIGCHLD` needed |
| `EVFILT_SIGNAL` | Signals — no `signalfd` needed |
| `EVFILT_TIMER` | Timers — no `timerfd` needed |
| `EVFILT_USER` | User-triggered wakeup — no `eventfd` needed |
| `EVFILT_AIO` | AIO completions |

Linux needed four separate descriptor types (`signalfd`, `timerfd`, `eventfd`, `inotify`, Ch. 33 §33.8–33.10) to reach the coverage kqueue had in 2000. That comparison is the interview answer: **kqueue is a more general and more economical design; epoll won on ubiquity, and `io_uring` is Linux's belated unification** — which additionally moves from a readiness model to a completion model, going further than kqueue ever did.

**Portability practice.** Write against libevent, libev, libuv, or ASIO rather than either API directly, unless you are optimizing the last microsecond — in which case you are on Linux and using `io_uring` or kernel bypass anyway.

---

## 34.13 io_uring

`io_uring` (Linux 5.1, 2019, Jens Axboe) is a **completion-based** asynchronous I/O interface built on two lock-free single-producer/single-consumer ring buffers shared between user space and the kernel via `mmap`. It is the first Linux interface that can perform I/O with **zero syscalls in steady state**.

```
       USER                          shared mmap'd memory                    KERNEL
  ┌───────────────┐            ┌──────────────────────────┐          ┌────────────────┐
  │ fill SQE      │──write────▶│  SQ ring  (SQEs)         │──read───▶│  submit work   │
  │ bump SQ tail  │            │  head/tail as atomics    │          │                │
  │               │            ├──────────────────────────┤          │                │
  │ read CQE      │◀───read────│  CQ ring  (CQEs)         │◀──write──│  post result   │
  │ bump CQ head  │            └──────────────────────────┘          └────────────────┘
  └───────────────┘
       io_uring_enter() — needed only to kick the kernel or to wait; omitted with SQPOLL
```

```c
struct io_uring ring;
io_uring_queue_init(4096, &ring, 0);
struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv(sqe, fd, buf, len, 0);
io_uring_sqe_set_data(sqe, conn);
io_uring_submit(&ring);                       // ONE syscall for N queued SQEs
struct io_uring_cqe* cqe;
io_uring_wait_cqe(&ring, &cqe);               // cqe->res = bytes or -errno
io_uring_cqe_seen(&ring, cqe);
```

**The three syscalls, total:** `io_uring_setup`, `io_uring_enter`, `io_uring_register`. Everything else is memory writes to the shared rings with acquire/release ordering on the head/tail indices — structurally identical to the interprocess ring of Ch. 33 §33.11, which is exactly the observation to make.

**What it does that epoll cannot:**

- **Regular-file I/O is genuinely asynchronous**, buffered or `O_DIRECT` — closing the hole of §34.7.
- **Every operation is supported**, not just read/write: `accept`, `connect`, `send`/`recv`, `sendmsg`/`recvmsg`, `openat`, `close`, `statx`, `fsync`, `fallocate`, `splice`, `madvise`, `timeout`, `poll_add`, and `cancel`.
- **Chaining.** `IOSQE_IO_LINK` makes the next SQE execute only after this one succeeds, so `accept → recv → send` is one submission and one completion round-trip. `IOSQE_IO_DRAIN` waits for all prior. `IOSQE_IO_HARDLINK` continues the chain even on failure.
- **Multishot** operations (`IORING_OP_ACCEPT` with `IORING_ACCEPT_MULTISHOT`, `recv` multishot, `poll` multishot): one SQE produces many CQEs, so an accept loop needs no resubmission at all.
- **Registered buffers and files** (§34.21) and **polled modes** (§34.22).

**Measured performance.** On storage, `io_uring` with `SQPOLL` and registered buffers sustains multiple million IOPS per core, roughly 2–3× a `libaio` baseline and far beyond a thread pool. On networking, a simple echo server sees ~5–15% throughput improvement over epoll at moderate load and larger gains at high connection counts, mainly from syscall amortization; **it does not reduce single-message latency below epoll's**, because both still traverse the same kernel network stack. That distinction matters for a trading interview: `io_uring` is a *throughput and syscall-count* win, not a wire-to-wire latency win. Only kernel bypass (Ch. 47) changes the latency floor.

**The costs and hazards:** substantial complexity around buffer ownership (§34.8), memory ordering bugs if you hand-roll instead of using `liburing`, kernel-version-dependent feature availability requiring runtime probing (`io_uring_get_probe`), a large and historically vulnerability-prone attack surface (several distros and Google's production fleet disable it via `kernel.io_uring_disabled`), and confusing behaviour when operations fall back to the async worker-thread pool (`io-wq`) — which happens for anything that would block and cannot be polled, silently reintroducing thread-pool costs.

---

## 34.14 Scatter-Gather I/O

**Vectored I/O** transfers between a *list* of user buffers and a single file/socket in one syscall.

```c
struct iovec iov[3] = {
    { hdr,     sizeof(Header) },      // 16-byte binary header
    { payload, payload_len   },       // body, already in a pool buffer
    { crc,     4             },       // trailer
};
ssize_t n = writev(fd, iov, 3);       // ONE syscall, ONE TCP segment, NO concatenation copy
readv(fd, iov, 3);                    // fills buffers in order, filling each before the next
preadv/pwritev(fd, iov, n, offset);   // positioned; no shared file-offset race
preadv2/pwritev2(fd, iov, n, off, flags);  // RWF_NOWAIT, RWF_HIPRI, RWF_DSYNC, RWF_APPEND
```

**Why it matters.** The alternative to `writev` is either N syscalls (N × 60 ns of entry cost, and on a socket N separate segments unless `TCP_CORK` is used) or one memcpy into a staging buffer (a full copy of the payload plus a possible allocation). `writev` avoids both: the kernel walks the `iovec` array and copies each segment directly into the socket buffer or page cache.

The header/payload/trailer pattern is exactly the shape of a trading protocol message, and this is the standard idiom for emitting one — with the payload staying in a pooled, never-copied buffer.

**Rules and traps:**

- **`IOV_MAX` is 1024** on Linux; exceeding it gives `EINVAL`. `sysconf(_SC_IOV_MAX)` to query.
- **Atomicity** is guaranteed only in the sense that the operation is a single logical transfer (no interleaving with another writer on a pipe if total ≤ `PIPE_BUF`); on a socket, **partial writes are still possible** and you must handle advancing through the `iovec` array yourself:

```c
while (total_remaining) {
    ssize_t n = writev(fd, iov, iovcnt);
    if (n < 0) { if (errno == EINTR) continue; if (errno == EAGAIN) break; fail(); }
    // advance: consume whole iovecs, then partially consume the next one
    while (n >= (ssize_t)iov->iov_len) { n -= iov->iov_len; ++iov; --iovcnt; }
    iov->iov_base = (char*)iov->iov_base + n;  iov->iov_len -= n;
    total_remaining -= ...;
}
```

That advance loop is a classic whiteboard exercise and getting the partial-consumption arithmetic right is the point of it.

- `readv` **fills each buffer completely before moving on**, so a short read leaves later buffers untouched — you cannot use it to "demultiplex" into fixed slots unless the read is complete.
- `sendmsg`/`recvmsg` embed an `iovec` array plus ancillary data (Ch. 33 §33.3, Ch. 45 §45.14); `sendmmsg`/`recvmmsg` go further and batch **multiple messages** per syscall, which is the correct way to drain a multicast feed: one syscall for 64 datagrams amortizes entry cost to ~1 ns/packet and is a standard market-data optimization (Ch. 45 §45.11).
- `preadv2` with **`RWF_NOWAIT`** finally gives non-blocking semantics for regular files when the data is in page cache — returning `EAGAIN` if it would need I/O. This lets a hot thread opportunistically read cached file data without risking a disk stall.

---

## 34.15 sendfile, splice, and Zero-Copy File I/O

**The copies in a naive file→socket transfer** (4 copies, 4 context-switch-capable syscall boundaries):

```
disk → [DMA] → page cache → [CPU copy] → user buffer
                          → [CPU copy] → socket buffer → [DMA] → NIC
```

**`sendfile(out_fd, in_fd, &offset, count)`** removes the user-space round trip: the kernel copies page cache → socket buffer directly. With NIC scatter-gather DMA plus checksum offload, the kernel instead appends *references* to the page-cache pages into the sk_buff, and the NIC DMAs them — a true **zero-copy** path with only the DMA transfers. `out_fd` must be a socket (historically; any file since 2.6.33 with limits), and `in_fd` must be mmap-able (a regular file, not a pipe or socket).

**`splice(fd_in, off_in, fd_out, off_out, len, flags)`** generalizes it: it moves data between two descriptors **by moving page references through a pipe**, with no copy. One end must be a pipe, which is the awkward constraint and the reason the idiom is a pair of splices:

```c
int p[2]; pipe(p);
splice(sock_in, NULL, p[1], NULL, len, SPLICE_F_MOVE | SPLICE_F_MORE);
splice(p[0], NULL, sock_out, NULL, len, SPLICE_F_MOVE | SPLICE_F_MORE);
// socket → socket with zero copies: this is how a zero-copy proxy is built
```

Related: **`tee`** duplicates data between two pipes without consuming it (the basis of "log a copy of this stream" without a copy); **`vmsplice`** maps user pages into a pipe, and is the sharp edge — the pages must not be modified until consumed, and `SPLICE_F_GIFT` transfers ownership to the kernel, after which touching them is a correctness bug.

**`copy_file_range`** (4.5+) copies between two files entirely in-kernel, and on filesystems supporting reflinks (btrfs, XFS with reflink, NFSv4.2 server-side copy) performs a **metadata-only** copy — instantaneous regardless of size.

**Measured effect.** For a 1 GB file→socket transfer, `read`+`write` in 64 KiB chunks costs ~16,000 syscall pairs and 2 GB of CPU copying; `sendfile` costs ~1 syscall per call with no CPU copy. Throughput improvements of **2–3×** and CPU reductions of **50–70%** are typical — which is why nginx, Kafka, and every static file server use it.

**Why it is largely irrelevant to trading systems**, which is the sophisticated answer: zero-copy shines for *large, bulk, file-backed* transfers. HFT messages are 50–500 bytes, where the copy costs ~20 ns and the syscall and stack traversal cost microseconds — so eliminating the copy saves nothing measurable, and `sendfile`/`splice` add a syscall. Zero-copy *on the network path* for small messages means `MSG_ZEROCOPY` (which has a completion-notification cost that makes it a loss below ~10 KB, Ch. 45 §45.16) or, properly, kernel bypass. Knowing that zero-copy is a bandwidth optimization and not a latency optimization is exactly the kind of distinction these interviews probe.

---

## 34.16 Direct I/O

**`O_DIRECT`** bypasses the page cache: DMA goes straight between the device and your user buffer.

```c
int fd = open(path, O_RDWR | O_DIRECT);
void* buf;
posix_memalign(&buf, 4096, 1 << 20);     // alignment is MANDATORY
pread(fd, buf, 1 << 20, offset);         // offset AND length must also be aligned
```

**Three alignment requirements**, all of which must hold or the call fails with `EINVAL` (a famously unhelpful diagnostic): the user buffer address, the file offset, and the transfer length must all be multiples of the device's logical block size — 512 bytes on older devices, **4096** on modern ones. Query with `statx(STATX_DIOALIGN)` (5.19+) or `ioctl(BLKSSZGET)`; using 4096 unconditionally is the pragmatic choice.

**What you gain:**

- No page-cache copy, and no page-cache *pollution* — a 10 GB sequential scan does not evict everything else's working set. This is often the real motivation.
- Predictable latency: no writeback storms, no `kswapd` reclaim stalls in your path.
- No double-buffering when the application maintains its own cache (which is why every serious database — Oracle, PostgreSQL with direct-io, MySQL InnoDB, RocksDB — offers it).

**What you lose:** all readahead, all write-back coalescing, and all caching. Small random reads that would have been page-cache hits (~100 ns) become device round trips (~10–100 µs NVMe, ~100 µs–10 ms rotational). Direct I/O with a bad access pattern is **catastrophically slower**, not marginally.

**`O_DIRECT` is not `O_SYNC`.** Direct I/O bypasses the page cache but says nothing about the device's volatile write cache. Durability still requires `fsync`/`fdatasync` (or `O_DSYNC`), which issues a FLUSH/FUA to the device. Conflating them is the most common misconception here, and it is a correctness bug in a journaling design (Ch. 56 §56.1).

| Mechanism | Bypasses page cache | Durable on return |
|---|---|---|
| `write` | No | No |
| `write` + `fdatasync` | No | **Yes** |
| `O_DIRECT` | **Yes** | No |
| `O_DIRECT` + `fdatasync` | **Yes** | **Yes** |
| `O_DSYNC` / `O_SYNC` | No | **Yes** (per write; `O_SYNC` also flushes metadata) |
| `RWF_DSYNC` via `pwritev2` | No | **Yes**, per-call |

**Trading-system relevance.** A write-ahead order journal needs bounded, predictable write latency and durability. The typical design is a preallocated, `fallocate`d file opened `O_DIRECT`, written in 4 KiB-aligned records from a preallocated aligned buffer, with `fdatasync` batched across a group of records (group commit) — or, increasingly, `io_uring` with registered buffers and `IORING_SETUP_IOPOLL` (§34.22), which reaches sub-10 µs NVMe write completion with no interrupts and no syscall. Linus Torvalds' famous objection to `O_DIRECT` ("a deranged monkey" interface) is worth knowing as context: it is a layering violation that exists because databases genuinely need it.

---

## 34.17 File Descriptors and Descriptor Tables

Three levels of indirection, and essentially every fd-semantics question is answered by knowing which level an operation affects:

```
 Process A                    Process B (forked)
 ┌───────────────┐            ┌───────────────┐
 │ fd table      │            │ fd table      │       Per-process array of struct file*
 │ 0 ─┐          │            │ 0 ─┐          │       plus a close-on-exec bitmap.
 │ 1 ─┼──┐       │            │ 1 ─┼──┐       │
 │ 3 ─┼─┐│       │            │ 3 ─┼─┐│       │
 └────┼─┼┼───────┘            └────┼─┼┼───────┘
      │ ││                         │ ││
      ▼ ▼▼                         ▼ ▼▼
 ┌──────────────────────────────────────────┐
 │ OPEN FILE DESCRIPTION (struct file)      │  ← file OFFSET, status flags (O_NONBLOCK,
 │  offset, f_flags, f_count, f_op          │    O_APPEND), access mode, refcount
 └──────────────────┬───────────────────────┘
                    ▼
 ┌──────────────────────────────────────────┐
 │ INODE / vnode                            │  ← file size, permissions, mandatory
 └──────────────────────────────────────────┘    locks, actual data
```

**Which level does what:**

| Property | Lives in |
|---|---|
| `FD_CLOEXEC` | **fd table entry** — per descriptor |
| File offset | **Open file description** — shared by `dup` and by `fork` |
| `O_NONBLOCK`, `O_APPEND` (status flags) | **Open file description** — `fcntl(F_SETFL)` affects all sharing fds |
| Access mode (`O_RDONLY`…) | Open file description, immutable after open |
| epoll registration key | (fd, **file description**) — §34.10 |
| File locks (`flock`) | Open file description |
| POSIX record locks (`fcntl` `F_SETLK`) | **Process + inode** — famously broken semantics: closing *any* fd to the file drops all the process's locks |

**Allocation:** `open`/`socket`/`accept` return the **lowest-numbered free descriptor**. That determinism is what makes shell redirection work (`close(0); open(...)` → fd 0) and what makes closing a descriptor in a threaded program dangerous: another thread's `open` immediately reuses the number, and a third thread's in-flight `read(fd)` now reads the wrong file. There is no fix other than not closing fds shared across threads without a synchronized ownership protocol.

**Limits:** `RLIMIT_NOFILE` (soft/hard, `ulimit -n`; commonly 1024 soft / 1048576 hard — raise the soft limit at startup), `/proc/sys/fs/file-max` system-wide, and `/proc/PID/fd/` for inspection (`ls -l` shows targets; `lsof -p` is the tool). **Descriptor exhaustion** presents as `EMFILE` on `accept` — and the standard defence is to keep a spare fd open that you close, accept, and immediately close in order to shed the connection cleanly rather than spinning on `EMFILE` in a level-triggered epoll loop (an infamous production livelock).

**`O_CLOEXEC` should be on essentially every descriptor you create.** Without it, a `fork`+`exec` leaks the descriptor into the child: a leaked listening socket keeps the port bound after a restart, and a leaked secret-bearing fd is a security bug. It must be set *atomically at creation* (`SOCK_CLOEXEC`, `O_CLOEXEC`, `EPOLL_CLOEXEC`, `accept4`) because a `fcntl` afterwards races with another thread's `fork`.

---

## 34.18 Descriptor Duplication

```c
int n = dup(fd);                       // lowest free number; CLEARS FD_CLOEXEC on the copy
dup2(oldfd, newfd);                    // force a specific number; CLOSES newfd first, atomically
                                       // dup2(fd, fd) is a no-op that does NOT close (special case)
dup3(oldfd, newfd, O_CLOEXEC);         // like dup2 but can set CLOEXEC atomically; fails if equal
fcntl(fd, F_DUPFD, minfd);             // lowest free >= minfd
fcntl(fd, F_DUPFD_CLOEXEC, minfd);     // same, with CLOEXEC set atomically
```

**All duplicates share the open file description**, so they share the offset and the status flags. Two consequences people get wrong:

```c
int a = open("f", O_RDONLY);
int b = dup(a);
read(a, buf, 10);          // offset now 10
read(b, buf, 10);          // reads bytes 10..19 — SHARED offset

int c = open("f", O_RDONLY);   // SEPARATE open file description
read(c, buf, 10);              // reads bytes 0..9 — independent offset
```

and: `fcntl(b, F_SETFL, O_NONBLOCK)` makes `a` non-blocking too. Only `FD_CLOEXEC` is per-descriptor — which is exactly why `dup` clears it on the new fd (a fresh descriptor gets the default), and why `dup3`/`F_DUPFD_CLOEXEC` exist.

**The canonical use — shell redirection:**

```c
// child of fork(), wiring the pipe write end to stdout
dup2(pipefd[1], STDOUT_FILENO);   // atomically closes the old stdout and installs the copy
close(pipefd[0]); close(pipefd[1]);
execvp(prog, argv);                // the dup'ed fd 1 survives exec: FD_CLOEXEC is clear on it
```

The atomicity of `dup2` matters: a `close(1); dup(pipefd[1]);` sequence has a window in which another thread's `open` can claim fd 1.

**Other real uses:** temporarily redirecting stderr to a log file and restoring it (`saved = dup(2); dup2(logfd, 2); ... ; dup2(saved, 2); close(saved);`); implementing daemonization by pointing 0/1/2 at `/dev/null` so that a stray `printf` cannot write into an unrelated file that later occupies fd 1; and `SCM_RIGHTS` fd passing (Ch. 33 §33.3), which is conceptually `dup` **across processes** — the receiver gets a new descriptor in its own table pointing at the *same* open file description, so offsets and flags are shared across the process boundary. That last point surprises people and is a good detail to volunteer.

**Reference counting.** The open file description is freed when its last descriptor closes anywhere in the system. This is why the pipe-EOF rule of Ch. 33 §33.1 is stated in terms of "all write ends," and why an fd passed but not yet received still keeps a socket alive.

---

## 34.19 Short Reads and Writes

**`read` and `write` may transfer fewer bytes than requested, and this is not an error.** Treating a partial transfer as a failure — or, worse, assuming it cannot happen — is the most common I/O bug in production C++.

**When short reads happen:** the socket buffer holds less than you asked for (essentially always on a stream socket); a signal arrives after some bytes were transferred; end-of-file is reached; a pipe holds less than requested; a terminal returns a line.

**When short writes happen:** the socket send buffer fills (very common under backpressure); the pipe buffer fills; a signal arrives mid-write; a disk quota or `RLIMIT_FSIZE` is hit; the write exceeds 2 GiB (Linux caps a single transfer at `0x7ffff000`).

**The TCP framing consequence is the flagship interview point.** TCP is a byte stream with no message boundaries (Ch. 38 §38.1), so a 100-byte application message may arrive as 40 + 60, or two messages may arrive in one read. Every stream protocol therefore needs explicit framing — a length prefix, a delimiter, or fixed-size records — and a **reassembly buffer** that survives across reads:

```cpp
// Correct framing loop over a non-blocking stream socket
buf.append_from(fd);                                    // may be short; may be EAGAIN
while (buf.size() >= HEADER_SIZE) {
    uint32_t len = read_u32_be(buf.data());             // Ch. 3 §3.9
    if (len > MAX_MSG) { drop_connection(); return; }   // untrusted length — Ch. 51 §51.12
    if (buf.size() < HEADER_SIZE + len) break;          // incomplete: WAIT for more
    handle(buf.data() + HEADER_SIZE, len);
    buf.consume(HEADER_SIZE + len);
}
```

**The write-all loop:**

```cpp
ssize_t write_all(int fd, const char* p, size_t n) {
    size_t done = 0;
    while (done < n) {
        ssize_t r = ::write(fd, p + done, n - done);
        if (r > 0) { done += (size_t)r; continue; }
        if (r < 0 && errno == EINTR)  continue;
        if (r < 0 && errno == EAGAIN) return (ssize_t)done;   // queue the rest; arm EPOLLOUT
        return -1;
    }
    return (ssize_t)done;
}
```

Note that on a non-blocking socket, `EAGAIN` after a partial write is **not** an error — it is backpressure, and the correct response is to buffer the remainder and register for writability (§34.11), never to spin or to drop.

**Exceptions to the rule.** Writes of ≤ `PIPE_BUF` (4096) to a pipe are atomic and never short (Ch. 33 §33.1). `sendto`/`sendmsg` on a **datagram** socket either send the whole datagram or fail — datagram sockets do not do partial transfers, which is one reason UDP feed handlers are simpler than TCP ones. Regular-file reads are short only at EOF or on a signal.

**A subtle one:** a short write followed by a retry is *not* atomic with respect to other writers on the same fd. Two threads doing `write_all` on one socket will interleave message fragments. Serialize at the application level, or give each thread its own connection.

---

## 34.20 EINTR and EAGAIN Handling

Two error codes with opposite meanings that are both routinely mishandled.

**`EINTR` — "a signal handler ran; nothing (or nothing more) was done."** Returned when a blocking syscall is interrupted by a signal whose handler was installed *without* `SA_RESTART`.

```c
// The mandatory idiom (or use a TEMP_FAILURE_RETRY-style wrapper):
ssize_t r;
do { r = read(fd, buf, n); } while (r < 0 && errno == EINTR);
```

**`SA_RESTART` does not save you.** The kernel restarts only a subset of syscalls, and the exclusions are exactly the ones an event loop uses, because a partially-elapsed timeout cannot be resumed correctly:

| Restarted with `SA_RESTART` | **Never** restarted |
|---|---|
| `read`/`write` on slow devices | `poll`, `ppoll`, `select`, `pselect`, `epoll_wait` |
| `open`, `wait`, `waitpid` | `nanosleep`, `clock_nanosleep`, `usleep` |
| `accept`, `connect` (on some paths) | `sem_timedwait`, `futex` with timeout |
| `flock`, `fcntl(F_SETLKW)` | `recv`/`send` **with `SO_RCVTIMEO`/`SO_SNDTIMEO` set** |
| `ioctl` on some devices | `io_getevents`, `msgrcv`/`semop` with timeout |

The `SO_RCVTIMEO` row is the nastiest: adding a socket timeout silently converts a restartable `recv` into a non-restartable one, so code that worked for years starts returning `EINTR` when someone adds a timeout or a profiler (`perf record` sends signals; so do `SIGPROF`-based profilers, `timer_create`, and debuggers).

**A genuinely subtle case:** `close()` may return `EINTR`, but on Linux **the descriptor is closed regardless**. Retrying the close is a bug — the fd number may already have been reused by another thread — so the correct handling is to ignore `EINTR` from `close`. (HP-UX behaves oppositely, which is why the portable answer is "check your platform," and knowing that this is a known portability landmine is the real answer.)

**`EAGAIN` / `EWOULDBLOCK` — "the operation would have blocked; try later."** Identical values on Linux. Not an error condition; it is the *normal* terminating condition of an edge-triggered drain loop (§34.11) and the normal signal of backpressure on a write.

| | `EINTR` | `EAGAIN` |
|---|---|---|
| Means | A signal arrived | Would block |
| Correct response | **Retry immediately** | **Stop; wait for readiness** |
| Retrying immediately is | Correct | A **busy-loop bug** |
| Progress made? | Possibly partial (check the return) | None |
| Prevented by | `SA_RESTART` (partially), blocking signals | Nothing — it is by design |

Retrying `EAGAIN` in a tight loop is the classic accidental spin: correct output, 100% CPU. The diagnostic signature is a thread pegged at 100% with `strace` showing a torrent of `recvfrom(...) = -1 EAGAIN`.

**Other codes that belong in the same reflex:** `EPIPE` (peer closed; paired with `SIGPIPE` — ignore the signal, handle the errno), `ECONNRESET` (peer sent RST), `EMFILE`/`ENFILE` (descriptor exhaustion, §34.17), `ENOBUFS` (kernel memory pressure on send), and `EMSGSIZE`. A production I/O layer classifies every errno into retry / backpressure / fatal-for-this-connection / fatal-for-the-process, and being able to state that taxonomy is a better answer than reciting the codes.

---

## 34.21 io_uring Registered Resources

Registration front-loads per-operation kernel work so the hot path does none of it. It is the mechanism that takes `io_uring` from "fewer syscalls" to "genuinely less work per I/O."

**Registered buffers (`IORING_REGISTER_BUFFERS`).** Normally every I/O must pin the user pages (`get_user_pages`), build a `bio_vec`/`iov_iter`, and unpin on completion — tens of nanoseconds to a microsecond per operation depending on size, plus mmap-semaphore contention.

```c
struct iovec bufs[N] = { { pool_base, pool_size }, ... };
io_uring_register_buffers(&ring, bufs, N);
io_uring_prep_read_fixed(sqe, fd, bufs[i].iov_base, len, offset, /*buf_index=*/i);
// also: io_uring_prep_write_fixed, send_zc with fixed buffers
```

The pages are pinned **once**, at registration. Each subsequent `*_fixed` operation skips pinning entirely — typically **5–15% throughput improvement** on high-IOPS storage workloads, more on small transfers where the fixed cost dominates. The constraint: registered memory counts against `RLIMIT_MEMLOCK`, and the buffers cannot be freed or remapped while registered.

**Registered files (`IORING_REGISTER_FILES`).** Every operation normally does `fget`/`fput` — an atomic refcount increment and decrement on `struct file`, which under multi-threaded load on the same fd causes **cache-line bouncing on the refcount** (Ch. 28 §28.8). Registration takes the reference once:

```c
int fds[N] = { sock1, sock2, ... };
io_uring_register_files(&ring, fds, N);
io_uring_prep_recv(sqe, /*index, not fd=*/0, buf, len, 0);
sqe->flags |= IOSQE_FIXED_FILE;              // interpret fd as a table index
io_uring_register_files_update(&ring, off, &newfd, 1);   // sparse/dynamic updates (5.5+)
```

Worth roughly **2–5%** on network workloads, and more when many threads share descriptors.

**Provided buffers (`IORING_REGISTER_PBUF_RING`, 5.7 / ring-mapped in 5.19).** The key insight for *receive* paths: with a normal `recv`, you must dedicate a buffer per in-flight operation, so 100,000 idle connections need 100,000 buffers. With provided buffers you hand the kernel a *pool*, and the kernel selects one only when data actually arrives, reporting the chosen buffer ID in the CQE.

```c
sqe->flags |= IOSQE_BUFFER_SELECT;  sqe->buf_group = GID;
// on completion: buffer_id = cqe->flags >> IORING_CQE_BUFFER_SHIFT; recycle when done
```

This decouples memory from connection count and is what makes `io_uring` multishot-recv servers memory-efficient at high fan-out. It is also the single most important registered resource for a network server, and naming it distinguishes someone who has actually used `io_uring` from someone who has read about it.

**Other registrations:** `IORING_REGISTER_EVENTFD` (get an eventfd notification when CQEs are posted, so a legacy epoll loop can integrate); `IORING_REGISTER_RING_FDS` (avoid an fd lookup on `io_uring_enter` itself); `IORING_REGISTER_IOWQ_MAX_WORKERS` (bound the fallback worker pool); and restriction registration for sandboxing.

**The general principle**, which generalizes far beyond `io_uring`: *move per-operation setup to a one-time setup phase.* It is the same idea as RDMA memory registration (Ch. 47 §47.14), DPDK mempools, and preallocated object pools on a hot path (Ch. 55 §55.1).

---

## 34.22 io_uring Polling Modes

Two independent polling modes, each removing a different cost. Understanding what each one eliminates — and what it costs in CPU — is the substantive part.

**`IORING_SETUP_SQPOLL` — kernel-side submission polling.**

```c
struct io_uring_params p = {
    .flags        = IORING_SETUP_SQPOLL | IORING_SETUP_SQ_AFF,
    .sq_thread_cpu   = 3,          // PIN IT — off your isolated cores, on the right NUMA node
    .sq_thread_idle  = 2000,       // ms of inactivity before it sleeps
};
io_uring_queue_init_params(entries, &ring, &p);
```

A kernel thread (`iou-sqp-<pid>`) spins on the submission-queue tail. You fill an SQE and bump the tail with a **release store** — and that is the entire submission path. **No syscall at all** in steady state. If the thread has gone idle (after `sq_thread_idle` ms), the ring's flags word carries `IORING_SQ_NEED_WAKEUP` and you must call `io_uring_enter(..., IORING_ENTER_SQ_WAKEUP)` — `liburing`'s `io_uring_submit` checks this for you, and hand-rolled code that forgets it hangs.

Costs and constraints: the kernel thread **burns a full core** while active; it must be pinned deliberately (an unpinned SQPOLL thread wandering onto an isolated core is a nasty, hard-to-find jitter source); and it historically required `CAP_SYS_NICE` (relaxed in 5.11+). Multiple rings can share one SQPOLL thread via `IORING_SETUP_ATTACH_WQ`, which is how you avoid burning one core per ring.

**`IORING_SETUP_IOPOLL` — device-side completion polling.** For NVMe with a polled queue, the kernel *polls the completion queue* rather than taking a completion interrupt. This eliminates the interrupt, the softirq, and the associated context switch — worth **several microseconds** of latency and a large jitter reduction on fast NVMe. Constraints: **`O_DIRECT` only** (§34.16), block devices only (no network, no buffered file I/O), and reaping requires calling `io_uring_enter(..., IORING_ENTER_GETEVENTS)` because nothing will otherwise advance the CQ.

**Combined**, `SQPOLL` + `IOPOLL` + registered buffers + registered files gives an NVMe path with **zero syscalls and zero interrupts** in steady state — the storage analogue of NIC kernel bypass, and the configuration behind published multi-million-IOPS-per-core benchmarks.

| Mode | Eliminates | Cost | Works with |
|---|---|---|---|
| Default | — | 1–2 syscalls per batch | Everything |
| `SQPOLL` | The submission syscall | One kernel thread spinning | Everything |
| `IOPOLL` | The completion interrupt + softirq | Your thread must poll | **`O_DIRECT` block devices only** |
| `COOP_TASKRUN` / `DEFER_TASKRUN` (5.19/6.0) | IPI-based task-work signalling; batches completion processing to when you reap | Slightly higher completion latency if you reap rarely | Everything; **recommended default for a single-issuer ring** |

`IORING_SETUP_DEFER_TASKRUN` (with `SINGLE_ISSUER`) deserves a mention because it is the modern best-practice flag: it stops the kernel from interrupting your thread with task-work whenever a completion is ready and instead runs it when you next enter the ring — removing a real source of jitter for a busy-polling thread, at the cost of latency if you poll the CQ infrequently.

**The honest verdict for a trading interview.** `SQPOLL` gives you a zero-syscall submission path, which sounds like the HFT answer, but the packet still traverses the full kernel network stack (~2–5 µs each way) and you have spent a core on the SQPOLL thread. If you are willing to spend a core, spending it on a **user-space poll-mode driver** (ef_vi, OpenOnload, DPDK, Ch. 47) buys a ~1–2 µs round trip instead of ~5–10 µs. So `io_uring` polling modes are the right answer for **storage** (journals, tick capture, Ch. 56 §56.1) and for high-connection-count servers, and kernel bypass remains the right answer for the market-data and order paths. Saying that plainly is stronger than claiming `io_uring` solves latency.

---

## Key Interview Questions

1. **Why is a syscall cheaper than a context switch?** — A syscall changes privilege level, stack, and GS base but not the address space, so no TLB flush and no cache eviction; ~60 ns vs ~1–3 µs direct plus 10–50 µs of cache/TLB refill.
2. **What did KPTI change?** — It split user and kernel page tables to mitigate Meltdown, adding two `CR3` writes per syscall and roughly doubling syscall cost; PCID avoids the full TLB flush.
3. **Why does the syscall ABI use `r10` instead of `rcx`?** — The `syscall` instruction overwrites `rcx` with the saved user RIP (and `r11` with RFLAGS).
4. **What is the vDSO and what does it give you?** — A kernel-mapped shared object letting `clock_gettime`, `gettimeofday`, `time`, and `getcpu` execute in user space with no ring transition: ~20–25 ns instead of ~250–500 ns.
5. **Why can `clock_gettime` suddenly become 10× slower with no code change?** — The kernel demoted the clocksource from `tsc` to `hpet`, so the vDSO fast path is unavailable and every call becomes a syscall reading a shared MMIO register.
6. **How much does a syscall cost and what dominates it?** — ~50–70 ns bare (~150–250 with mitigations); for real syscalls the *work behind* the boundary dominates: ~1–3 µs for a UDP send, ~50–200 µs for `fork`.
7. **Why can't you use strace to measure latency?** — It stops the tracee twice per syscall via ptrace, adding 50–150 µs per call and slowing the program 100–500×. Use `perf trace` or `bpftrace`, which aggregate in-kernel.
8. **What does `O_NONBLOCK` do on a regular file?** — Nothing. Files are always "ready" and the read still blocks on I/O, which is why epoll cannot be used for file I/O and why `io_uring` exists.
9. **Is epoll asynchronous I/O?** — No. It is a *readiness* model: it tells you a subsequent synchronous read will not block. `io_uring`/IOCP are *completion* models where the kernel performs the transfer.
10. **Why is `poll` O(N) and epoll O(ready)?** — `poll` copies and scans the whole interest set every call; epoll keeps the set in a kernel red-black tree and appends to a ready list from a wakeup callback registered on each file's wait queue.
11. **Level-triggered vs edge-triggered — when does ET win, and what must you do?** — ET wins on `EPOLLOUT` (a socket is nearly always writable, so LT storms) and reduces wakeups on bursts; ET requires `O_NONBLOCK` and draining until `EAGAIN`, or the connection silently stalls forever.
12. **Why is edge-triggered on a blocking fd a deadlock?** — The final read of the drain loop blocks instead of returning `EAGAIN`, hanging the whole event loop.
13. **What does kqueue do better than epoll?** — Registration and retrieval in one syscall, a data payload (bytes available) per event, and unified filters for signals, timers, processes, vnodes, and user events — for which Linux needs signalfd/timerfd/eventfd/inotify.
14. **How does `io_uring` avoid syscalls?** — Two mmap'd SPSC rings with atomic head/tail indices; submission is a memory write plus a release store, and with `SQPOLL` a kernel thread consumes them, so steady state needs zero syscalls.
15. **Does `io_uring` reduce network latency?** — Not materially; the packet still traverses the whole kernel stack. It reduces syscall count and improves throughput and IOPS. Latency requires kernel bypass.
16. **What are io_uring provided buffers for?** — The kernel picks a buffer from a pool only when data actually arrives, so memory scales with *active* connections rather than with in-flight receives.
17. **When does `writev` beat `write`?** — Header/payload/trailer emission: one syscall, one TCP segment, and no concatenation copy. `IOV_MAX` is 1024, and partial writes still require advancing through the array.
18. **Is `sendfile` useful in a trading system?** — Rarely. Zero-copy is a bandwidth optimization; for 100-byte messages the copy costs ~20 ns while the stack traversal costs microseconds.
19. **Does `O_DIRECT` make writes durable?** — No. It bypasses the page cache, not the device write cache; you still need `fdatasync` or `O_DSYNC`.
20. **What are the three alignment requirements of `O_DIRECT`?** — Buffer address, file offset, and length, all multiples of the logical block size (4096 on modern devices); violating any gives `EINVAL`.
21. **What is shared between `dup`ed descriptors?** — The open file description: file offset and status flags (`O_NONBLOCK`, `O_APPEND`). Only `FD_CLOEXEC` is per-descriptor.
22. **Why must `O_CLOEXEC` be set at creation rather than with `fcntl`?** — The `fcntl` races with another thread's `fork`+`exec`, leaking the descriptor.
23. **Why must every stream protocol have framing?** — TCP is a byte stream; reads are short and messages coalesce. You need a length prefix or delimiter plus a reassembly buffer across reads.
24. **`EINTR` vs `EAGAIN`?** — `EINTR`: a signal arrived, retry immediately. `EAGAIN`: it would block, so stop and wait for readiness — retrying immediately is a busy-loop bug.
25. **`SA_RESTART` is set; can you still get `EINTR`?** — Yes: `poll`, `select`, `epoll_wait`, `nanosleep`, and any call with a timeout (including a socket with `SO_RCVTIMEO`) are never restarted.

---

## Common Traps

- **Believing a syscall is expensive because of the mode switch** — it is ~60 ns; the work behind it and the sleep/wakeup are the cost.
- **Measuring latency under `strace`** — 100–500× probe effect makes the number meaningless.
- **Expecting `strace` to show `clock_gettime`** — vDSO calls make no syscall.
- **`select` with an fd ≥ 1024** — stack buffer overflow, not an error.
- **Forgetting `select` modifies its fd_sets and its timeout** — must be rebuilt every iteration.
- **`accept()` not inheriting `O_NONBLOCK`** — use `accept4`.
- **`O_NONBLOCK` on a regular file** — silently does nothing.
- **Edge-triggered epoll without `O_NONBLOCK`** — the drain loop blocks and hangs the loop.
- **Edge-triggered without draining to `EAGAIN`** — silent, permanent connection stall.
- **Level-triggered `EPOLLOUT` left armed** — continuous wakeup storm.
- **`epoll_ctl(MOD)` on every state change** — 300–600 ns each; manage interest in user space instead.
- **Closing one of several `dup`ed fds and expecting epoll to stop reporting** — registration tracks the open file description.
- **Storing the fd in `epoll_event.data` instead of a connection pointer** — an unnecessary lookup per event.
- **Not handling `EMFILE` on `accept`** — level-triggered livelock at 100% CPU; keep a spare fd to shed connections.
- **Assuming `read`/`write` transfer everything requested** — short transfers are normal, not errors.
- **Assuming TCP preserves message boundaries** — it does not; frame explicitly.
- **Two threads `write_all`-ing to one socket** — interleaved message fragments.
- **Retrying `EAGAIN` immediately** — busy loop at 100% CPU with correct output.
- **Retrying `close()` on `EINTR`** — on Linux the fd is already closed and the number may be reused.
- **Adding `SO_RCVTIMEO` and then seeing `EINTR` despite `SA_RESTART`** — timeout-bearing calls are never restarted.
- **`O_DIRECT` without 4096-alignment of buffer, offset, *and* length** — `EINVAL` with no explanation.
- **Believing `O_DIRECT` implies durability** — it does not; `fdatasync` still required.
- **`O_DIRECT` with a random small-read pattern** — catastrophically slower than the page cache, not marginally.
- **Forgetting `O_CLOEXEC`** — leaked listening sockets keep ports bound after restart; leaked secret fds are a security bug.
- **Freeing or reusing a buffer submitted to `io_uring` or `MSG_ZEROCOPY`** — the kernel owns it until completion.
- **Hand-rolling `io_uring` ring index updates without acquire/release** — a memory-ordering bug that appears as lost or duplicated completions.
- **An unpinned `SQPOLL` kernel thread** — wanders onto an isolated core and becomes an unexplained jitter source.
- **Forgetting `IORING_SQ_NEED_WAKEUP` in hand-written SQPOLL code** — submissions silently stop being processed.
- **Using `IOPOLL` without `O_DIRECT`** or expecting it to work on sockets.
- **`ltrace` on a statically linked or LTO'd binary** — sees nothing; PLT rewriting is defeated.

---

## Compact Recall Summary

**The boundary.** Two rings; kernel mappings are present in every address space (supervisor-only), so a syscall needs no page-table switch — which is why it is ~60 ns while a context switch is ~1–3 µs direct plus 10–50 µs of cache/TLB refill. KPTI reintroduced a `CR3` write per transition and roughly doubled syscall cost; PCID mitigates the flush.

**Entry.** `syscall`/`sysret` with `LSTAR`/`STAR`/`FMASK` MSRs; number in `rax`, args in `rdi rsi rdx r10 r8 r9` (`r10` because the instruction clobbers `rcx`), return in `rax` as `-errno`. Entry does `swapgs`, stack switch, `pt_regs` push, KPTI `CR3`, and speculation mitigations before dispatch.

**vDSO.** Kernel-mapped shared object plus a `vvar` seqlock page: `clock_gettime` reads the seqlock, does `rdtsc`, applies mult/shift, retries — ~20–25 ns and no ring transition. Works **only when the clocksource is `tsc`**; a demotion to HPET turns every call into a ~250 ns syscall. `rdtsc` ~5–8 ns, `COARSE` ~5 ns with ms granularity.

**Cost table.** Null syscall 50–70 ns (150–250 mitigated); pipe read/write 300–800 ns; UDP send 1–3 µs; `epoll_wait` immediate 200–400 ns, sleeping 2–10 µs; futex slow path 1.5–5 µs; `mmap` 1–5 µs; `fork` 50–200 µs. Escalate avoidance: vDSO → batching → non-blocking → `SQPOLL` → kernel bypass.

**Tracing.** `strace` = ptrace, two stops per call, 100–500× slowdown, never for performance; `perf trace` ~5–20%; `bpftrace`/ftrace ~1–5% because aggregation happens in-kernel. `ltrace` rewrites PLT entries and is defeated by static linking and LTO.

**Blocking/non-blocking, sync/async.** Orthogonal axes. `O_NONBLOCK` does nothing on regular files. epoll is *readiness*, `io_uring`/IOCP are *completion*; POSIX AIO was user-space threads, `libaio` needed `O_DIRECT` — both superseded. Busy-polling wins not by saving the syscall but by avoiding the sleep, the wakeup, and the cold caches.

**Multiplexing.** `select` (1024 limit, sets modified) and `poll` are O(interest set) with a full copy per call — the C10K problem. `epoll` holds the set in a kernel RB-tree and appends to a ready list from a per-file wait-queue callback, so `epoll_wait` is O(ready). Registration keys on the *open file description*. `EPOLLONESHOT` for thread handoff, `EPOLLEXCLUSIVE` or `SO_REUSEPORT` against the accept thundering herd, `EPOLLRDHUP` for half-close. ET requires `O_NONBLOCK` and drain-to-`EAGAIN`; it wins decisively for `EPOLLOUT`. `kqueue` does registration+retrieval in one call, reports bytes available, and unifies signals/timers/processes/vnodes.

**io_uring.** Two mmap'd SPSC rings with atomic head/tail; three syscalls total in the whole API. Genuinely async file I/O, all operations, linking, multishot. Registered buffers skip page pinning (5–15%), registered files skip `fget`/`fput` (2–5%), provided buffers decouple memory from connection count. `SQPOLL` removes the submission syscall at the cost of a spinning kernel thread (pin it); `IOPOLL` removes the completion interrupt but is `O_DIRECT`-block-device only; `DEFER_TASKRUN` removes task-work interruptions. Throughput and IOPS win; **not** a network-latency win — that needs kernel bypass.

**Vectored and zero-copy.** `writev` for header/payload/trailer in one syscall and one segment (`IOV_MAX` 1024, partial writes still possible); `sendmmsg`/`recvmmsg` to batch datagrams. `sendfile` removes the user round trip; `splice`/`vmsplice`/`tee` move page references through a pipe; `copy_file_range` can be metadata-only with reflinks. All are bandwidth optimizations, not latency ones, and largely irrelevant to 100-byte trading messages.

**Direct I/O.** Bypasses the page cache; requires 4096-alignment of buffer, offset, and length; loses readahead and caching; does **not** imply durability (`fdatasync` still needed). Right for journals and self-caching databases, wrong for small random reads.

**Descriptors.** fd table → open file description → inode. `FD_CLOEXEC` is per-fd; offset and status flags live in the description and are shared by `dup` and across `fork` and `SCM_RIGHTS`. Lowest-free-number allocation makes closing shared fds in threaded programs dangerous. `dup2`/`dup3` are atomic; always create with `O_CLOEXEC`. Handle `EMFILE` with a reserved spare fd.

**Short I/O and errno.** Partial transfers are normal on sockets and pipes (not on datagrams, not on ≤`PIPE_BUF` pipe writes); every stream protocol needs framing plus a reassembly buffer, and every write needs a write-all loop that treats `EAGAIN` as backpressure. `EINTR` → retry immediately; `EAGAIN` → wait for readiness. `SA_RESTART` never covers `poll`/`select`/`epoll_wait`/`nanosleep`/anything with a timeout, including a socket with `SO_RCVTIMEO`. `close()` returning `EINTR` has still closed the fd.
