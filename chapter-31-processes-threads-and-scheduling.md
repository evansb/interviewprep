# Chapter 31 — Processes, Threads and Scheduling

*Interview-focused revision notes. The theme: Linux has one scheduling entity — the task — and everything from `fork` to core isolation is a policy decision about what tasks share, when they run, and who is allowed to take the CPU away from them.*

---

## 31.1 Processes and Address Spaces

A **process** is the pairing of an *address space* with one or more *threads of execution*, plus a bundle of kernel-managed resources: a file-descriptor table, a signal disposition table, a working directory, credentials, a namespace set, and resource limits.

Linux does not represent this as "process" internally. The kernel's unit is `struct task_struct`, a **task**, and each task holds *pointers* to the resource structures:

```
task_struct
 ├── mm_struct*      → address space (page tables, VMAs)     [shared by threads]
 ├── files_struct*   → fd table                              [shared by threads]
 ├── sighand_struct* → signal handlers                       [shared by threads]
 ├── signal_struct*  → per-process signal state, rlimits     [shared by threads]
 ├── fs_struct*      → cwd, root, umask                      [shared by threads]
 ├── nsproxy*        → namespaces
 ├── thread_struct   → saved registers, FPU state            [PRIVATE per task]
 └── kernel stack    → 16 KB on x86-64                       [PRIVATE per task]
```

A **thread** is a task that shares `mm`, `files`, `sighand`, and `signal` with its peers. A **process** is a task that shares none of them. There is no third mechanism — this is the single most important structural fact in this chapter, and §31.6 shows the syscall that expresses it.

Terminology that trips people up:

| Term | Meaning |
|---|---|
| **PID** (kernel: TGID) | Thread *group* ID — what userspace calls "the process ID". `getpid()` returns this. |
| **TID** (kernel: PID) | The per-task ID. `gettid()` returns this. For the main thread, TID == TGID. |
| **PPID** | Parent's TGID. |
| **PGID** | Process group ID (§31.7). |
| **SID** | Session ID (§31.7). |

The confusion is real and historical: the kernel's `pid` field is what POSIX calls a TID, and the kernel's `tgid` is what POSIX calls a PID. `/proc/<tgid>/task/<tid>/` is the directory structure that exposes it, and `perf`, `gdb`, and `top -H` all switch between the two views.

### The address space

Every process gets a private virtual address space (Ch. 32 §32.1–§32.2). On x86-64 with 4-level paging, user space is the low 128 TiB (`0x0000_0000_0000_0000`–`0x0000_7fff_ffff_ffff`) and the kernel occupies the top half; with 5-level paging (LA57) user space extends to 128 PiB but only for mappings explicitly requested above `0x7fff_ffff_ffff`, precisely so that programs that stuff tag bits into high pointer bits (Ch. 3 §3.10) don't break.

**Why address-space isolation costs something:** switching between processes requires reloading `CR3`, which invalidates TLB entries unless **PCID** (process-context identifiers) is in use. With PCID, the CPU tags TLB entries with a 12-bit context ID and can keep entries from several address spaces resident, turning a process switch from "flush the TLB" into "change the tag". Linux uses PCID on all modern x86-64. Thread switches within a process don't touch `CR3` at all, which is a large part of why they're cheaper (§31.13).

---

## 31.2 Process States

Linux task states, as reported in `/proc/<pid>/stat` and by `ps`:

| Code | Kernel name | Meaning |
|---|---|---|
| `R` | `TASK_RUNNING` | Running **or runnable** — on a run queue. `ps` does not distinguish. |
| `S` | `TASK_INTERRUPTIBLE` | Sleeping, will wake on signal or event. The normal blocked state. |
| `D` | `TASK_UNINTERRUPTIBLE` | Sleeping, **will not wake for signals**. Typically blocked in I/O or on a kernel mutex. |
| `T` | `TASK_STOPPED` | Stopped by `SIGSTOP`/`SIGTSTP`. |
| `t` | `TASK_TRACED` | Stopped by a debugger. |
| `Z` | `EXIT_ZOMBIE` | Terminated, exit status not yet reaped (§31.5). |
| `X` | `EXIT_DEAD` | Being torn down; never observable. |
| `I` | `TASK_IDLE` | Idle kernel thread; `TASK_UNINTERRUPTIBLE` but excluded from load average. |

```
        ┌──────────┐  schedule in   ┌─────────┐
        │ Runnable │ ─────────────▶ │ Running │
        │   (R)    │ ◀───────────── │   (R)   │
        └──────────┘  preempted     └─────────┘
             ▲                          │ blocks
             │ wakeup (event, signal)   ▼
        ┌────┴───────────────────────────────┐
        │  Sleeping: S (interruptible)       │
        │            D (uninterruptible)     │
        └────────────────────────────────────┘
                                        │ exit()
                                        ▼
                                   Zombie (Z) ── reaped ──▶ gone
```

**`R` is the trap.** It means *runnable*, not *on a CPU*. A machine with 200 tasks in `R` on 16 cores has 184 tasks waiting, and that queueing delay is the wakeup latency of §31.16. The Linux **load average** is the exponentially-decayed count of tasks in `R` *plus* `D` — the inclusion of `D` is why heavy disk I/O inflates load average without consuming CPU, and it's a favourite interview question.

**`D` state is the diagnostic signature of blocked I/O or a stuck kernel lock.** A task in `D` cannot be killed, not even with `SIGKILL`, because signal delivery requires the task to reach a signal check point and an uninterruptible sleep never does. `cat /proc/<pid>/stack` or `echo w > /proc/sysrq-trigger` (which dumps blocked-task stacks) tells you where. Persistent `D` on a trading host usually means an NFS mount, a failing disk, or a kernel-mutex convoy — none of which your process can recover from.

For latency work, the states you care about are the *transitions*: how long between `wakeup` and `Running` (§31.16), and how often you involuntarily leave `Running`. `perf stat` gives `context-switches` split by voluntary (`nvcsw`/`nivcsw` in `/proc/<pid>/status`); a busy-polling thread should show ~zero involuntary switches.

---

## 31.3 `fork` and Copy-on-Write

`fork()` creates a new process that is a near-duplicate of the caller: same memory contents, same open descriptors (sharing file *descriptions*, hence a shared file offset), same signal dispositions. It returns 0 in the child and the child's PID in the parent.

Naïvely this means copying the entire address space. **Copy-on-write (COW)** avoids that:

1. The kernel allocates a new `mm_struct` and copies the **VMA list** (the map of regions) and the **page tables**.
2. Every writable private page-table entry in *both* parent and child is marked **read-only**, and the underlying `struct page` refcount is incremented.
3. Execution resumes. The first *write* to such a page traps as a protection fault; the kernel sees the VMA is writable but the PTE is not and the page is shared, allocates a fresh page, copies 4 KiB, and remaps it writable in the faulting process (Ch. 32 §32.6).

```
before fork:      parent PTE ──▶ page P (rw)
after fork:       parent PTE ──▶ page P (ro)   refcount 2
                  child  PTE ──▶ page P (ro)
after child write: child PTE ──▶ page P' (rw)  ← 1.5–3 µs fault + copy
```

**Costs, with numbers.** `fork()` itself is O(mapped pages) because the page tables must be copied, not O(1): a process with 1 GiB resident in 4 KiB pages has ~262,000 PTEs across ~512 PMD pages, and `fork` runs 300 µs–2 ms. Huge pages help enormously (one PMD entry per 2 MiB). Each subsequent COW fault costs 1.5–3 µs. A parent that forks while holding a 100 GiB heap can stall for hundreds of milliseconds.

**Latency implications that matter in interviews:**

- **`fork` in a latency-sensitive process is forbidden.** Not only does it stall, it also marks the parent's own pages read-only, so the parent then takes COW faults on its own hot data — the stall lands on the *parent's* critical path after `fork` returns.
- **`fork` in a multithreaded process only clones the calling thread.** All other threads vanish in the child. If any of them held a `malloc` lock or a `std::mutex`, the child inherits it *locked forever*. This is why POSIX says the child may call only async-signal-safe functions before `exec` (Ch. 33 §31.15 and Ch. 33 §33.15). `pthread_atfork` handlers are a partial mitigation and are widely considered unfixable in general.
- **`vfork()`** suspends the parent and shares its address space until the child `exec`s or `_exit`s — no page-table copy at all. Dangerous and largely superseded by **`posix_spawn`**, which uses `CLONE_VFORK|CLONE_VM` internally and is the correct way to launch a child from a latency-sensitive process.
- **Huge pages and `fork` interact badly**: a COW fault on a 2 MiB THP copies 2 MiB (~50–100 µs) or splits the huge page. `MADV_DONTFORK` on large data regions avoids both.

`getrusage`/`/proc/<pid>/stat` fields `min_flt` (minor faults) count COW faults; a spike after `fork` is the signature.

---

## 31.4 `exec` and Process Replacement

`execve(path, argv, envp)` **replaces** the current process image. It does not create a process; the PID, PPID, PGID, SID, and (mostly) the open descriptors survive.

What happens:

1. The kernel parses the file header (ELF, or `#!` interpreter, or a registered `binfmt_misc` handler).
2. The **entire address space is torn down** and a new one built: new VMAs for the text (file-backed, read-only, executable), data, BSS, stack, and the ELF interpreter `ld.so`.
3. Signal *handlers* are reset to default (there is no code left to run them); signal *masks* and pending signals are preserved. Ignored signals stay ignored.
4. Descriptors with `FD_CLOEXEC` are closed; the rest survive. **This is the mechanism behind shell redirection**: `fork`, rearrange descriptors with `dup2`, then `exec`.
5. Threads other than the caller are terminated. Memory locks (`mlock`), timers, and `MAP_SHARED` mappings are dropped.
6. Setuid/setgid bits on the binary change credentials here — the only place they can.
7. Control transfers to `ld.so`, which maps shared libraries, performs relocations (Ch. 41 §41.13), and jumps to `_start`.

**The `FD_CLOEXEC` race.** `open()` followed by `fcntl(F_SETFD, FD_CLOEXEC)` is not atomic: another thread forking in between leaks the descriptor to the child. Every descriptor-creating syscall therefore has an atomic variant — `open(O_CLOEXEC)`, `socket(SOCK_CLOEXEC)`, `pipe2(O_CLOEXEC)`, `accept4(SOCK_CLOEXEC)`, `epoll_create1(EPOLL_CLOEXEC)`. **Always use them.** Descriptor leaks into children are both a resource leak and a security issue (a leaked listening socket lets a child hold a port open after the parent restarts).

**Cost.** A bare `fork`+`exec` of a small dynamically linked binary is ~1–3 ms wall time, dominated by `ld.so` relocation and page faults on first touch, not by the syscalls. Static linking, prelinking, or `-Wl,-z,now` with `BIND_NOW` changes the distribution (all relocation up front rather than lazily via the PLT). For a latency-sensitive service, launch every child process at startup, never on the hot path.

`strace -f -e trace=execve,clone` shows the sequence; `LD_DEBUG=statistics` quantifies the dynamic-linking share.

---

## 31.5 Process Reaping, Zombies and Orphans

When a process terminates, the kernel frees its memory and descriptors immediately but **retains the `task_struct` and exit status** until the parent collects it. That retained shell is a **zombie** (`Z`). It consumes no memory beyond the task struct but does consume a PID.

```c
pid_t pid = fork();
if (pid == 0) { _exit(0); }
// parent never calls wait() → child is a zombie until the parent dies
```

**Reaping** is `wait()`, `waitpid()`, `wait4()`, or `waitid()`. `waitid(P_PID, pid, &info, WEXITED|WNOWAIT)` is the precise modern form — it can peek without consuming.

| Situation | Outcome |
|---|---|
| Parent calls `wait*` | Zombie reaped, status delivered |
| Parent ignores `SIGCHLD` (`SIG_IGN` explicitly) | Kernel auto-reaps; **`wait` then fails with `ECHILD`** |
| Parent sets `SA_NOCLDWAIT` | Same auto-reap behaviour |
| Parent exits first | Child is **orphaned**, reparented to `init`/`systemd` (or the nearest **subreaper**), which reaps it |
| Parent alive but never reaps | Zombies accumulate until the PID limit (`/proc/sys/kernel/pid_max`, default 4194304 on 64-bit) |

A **child subreaper** (`prctl(PR_SET_CHILD_SUBREAPER, 1)`) makes a process the reparenting target for its descendants instead of PID 1 — this is how `systemd` user sessions and container supervisors track process trees. It's the correct answer to "how does a supervisor know when a double-forked daemon dies?"

**`SIGCHLD` handling correctly** is a classic bug source. Signals do not queue: three children exiting while your handler runs may produce one `SIGCHLD`. The handler must loop:

```c
void sigchld(int) {
    int saved = errno;                       // handlers must preserve errno
    while (waitpid(-1, nullptr, WNOHANG) > 0) {}
    errno = saved;
}
```
`WNOHANG` plus the loop is mandatory. `signalfd` or `SIGCHLD` via a self-pipe integrates this into an event loop without async-signal-safety constraints (Ch. 33 §33.9).

**Diagnostics.** `ps -eo pid,stat,comm | grep ' Z'` finds zombies; `ps -ef --forest` shows reparenting. A process with hundreds of zombies has a missing `wait` loop, and the failure mode is eventual PID exhaustion producing `EAGAIN` from `fork` — which looks like a memory problem and isn't.

---

## 31.6 Linux `clone` and Task Sharing

`clone()` is the primitive; `fork`, `vfork`, and `pthread_create` are all thin wrappers over it. Its power is the flags word, which selects **which resources the new task shares** with the caller.

| Flag | Effect when set |
|---|---|
| `CLONE_VM` | Share the address space (`mm_struct`) |
| `CLONE_FS` | Share cwd, root, umask |
| `CLONE_FILES` | Share the descriptor table |
| `CLONE_SIGHAND` | Share signal handlers (requires `CLONE_VM`) |
| `CLONE_THREAD` | Join the same thread group — same TGID, shared signal delivery, no `SIGCHLD` to parent |
| `CLONE_SETTLS` | Set the new task's TLS base (`FS_BASE` on x86-64) |
| `CLONE_PARENT_SETTID` / `CLONE_CHILD_CLEARTID` | Write the TID into a supplied address / clear it and `FUTEX_WAKE` on exit |
| `CLONE_NEWNS`, `CLONE_NEWPID`, `CLONE_NEWNET`, … | New namespaces — the container primitive |
| `CLONE_IO` | Share the I/O scheduler context |

The two canonical combinations:

```
fork():            clone(SIGCHLD, ...)                      — shares nothing
pthread_create():  clone(CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND
                       | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS
                       | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID, ...)
```

**"A thread and a process are the same thing to the Linux scheduler"** is the sentence to have ready. Both are `task_struct`s on a run queue; the scheduler doesn't know or care which resources they share, except that switching between tasks sharing an `mm` skips the `CR3` reload.

`CLONE_CHILD_CLEARTID` is the mechanism behind `pthread_join`: the kernel clears a word in the thread's TLS on exit and issues a `FUTEX_WAKE` on it, so `join` is just a futex wait (Ch. 33 §33.7) — no polling, no signal.

`clone3()` (kernel 5.3+) replaces the flag-argument mess with a versioned struct and adds `CLONE_INTO_CGROUP` and explicit stack size. Container runtimes use it.

**Where this shows up in interviews:** explaining that Linux has no separate thread scheduler, that namespaces are just more `clone` flags (so a container is a process with an unusual flag set, not a virtual machine), and that `CLONE_VM` without `CLONE_THREAD` gives you the strange middle ground of two "processes" sharing memory — which is exactly what `vfork` and some sandboxes use.

---

## 31.7 Process Groups, Sessions and Daemons

These exist for **job control** and **terminal signal delivery**, and they matter operationally even in headless services.

- A **process group** is a set of processes that receive terminal-generated signals together. `Ctrl-C` sends `SIGINT` to the *foreground process group* of the terminal, not to one process. `kill(-pgid, sig)` targets a group.
- A **session** is a set of process groups sharing a **controlling terminal**. Each session has one leader (the process whose PID == SID). Exactly one process group in the session is the foreground group.
- **`SIGHUP`** is sent to the foreground group when the controlling terminal is lost, and to a session's members when the leader exits. This is why background jobs die when an SSH connection drops, and why `nohup`, `setsid`, and `disown` exist.

```
Session (SID=100, controlling tty /dev/pts/3)
 ├── Process group 100 (leader: shell)         ← background
 ├── Process group 105 (foreground)  ← gets SIGINT/SIGTSTP/SIGHUP from tty
 └── Process group 110                          ← background; SIGTTIN if it reads the tty
```

Background processes that *read* from the terminal get `SIGTTIN`; those that write get `SIGTTOU` if `TOSTOP` is set. Both stop the process — an obscure but real cause of a "hung" background service.

### The classic daemonization sequence

```
1. fork(); parent _exit()          → child is not a process-group leader
2. setsid()                        → new session + new group, NO controlling terminal
3. fork() again; parent _exit()    → child cannot ever acquire a controlling tty
4. chdir("/")                      → don't hold a mount busy
5. umask(0)
6. close/redirect fds 0,1,2 to /dev/null
7. optionally write a pidfile, install signal handlers
```

Step 3 is the one candidates omit: only a session leader can acquire a controlling terminal, so forking a second time and letting the leader exit permanently forecloses it. The double-fork also orphans the daemon so `init` reaps it (§31.5).

**Modern practice inverts all of this.** Under `systemd`, `Type=simple` services should **not** daemonize: staying in the foreground lets the supervisor track the main PID directly, capture stdout/stderr into the journal, apply cgroup limits, and restart deterministically. Daemonizing under a supervisor is an anti-pattern that breaks PID tracking. Knowing both the classic sequence *and* why it's obsolete is the complete answer.

For trading systems, the operational point is that the service must survive terminal loss and must not be in the foreground group of anything interactive — `systemd`, `KillMode=`, and cgroup membership (Ch. 35 §35.20) are what actually control lifecycle.

---

## 31.8 Kernel and User Threads

**Kernel threads** are tasks with no user address space (`mm == NULL`); they run only in kernel mode and borrow the previous task's page tables ("lazy TLB" mode). They appear in `ps` in square brackets: `[kworker/2:1]`, `[ksoftirqd/0]`, `[rcu_sched]`, `[migration/4]`, `[kswapd0]`.

These matter enormously for latency, because they are the tasks that will preempt yours:

| Kernel thread | What it does | Latency risk |
|---|---|---|
| `ksoftirqd/N` | Deferred softirq processing when the softirq load is high | Network RX offload can preempt your polling thread |
| `kworker/N:M` | Generic deferred work (workqueues) | Unbounded; can run anything |
| `migration/N` | Stop-machine, CPU hotplug, task migration | `SCHED_FIFO` priority 99 — preempts *everything* |
| `rcu_sched`, `rcuc/N` | RCU grace-period processing | Offloadable to housekeeping CPUs (`rcu_nocbs`) |
| `kswapd0` | Page reclaim | Can stall allocations for milliseconds |
| `khugepaged` | THP collection/compaction | Notorious source of multi-ms stalls (Ch. 32 §32.11) |
| `watchdog/N` | Hard/soft lockup detector | Small periodic wakeup; disable on isolated cores |

**Threading models** — historical but still asked:

| Model | Description | Where seen |
|---|---|---|
| **1:1** | One kernel task per user thread | Linux NPTL, Windows, macOS |
| **N:1** | Many user threads multiplexed onto one kernel thread by a userspace scheduler | Old GNU Pth, green threads. A blocking syscall blocks everyone; no multicore. |
| **M:N** | M user threads over N kernel threads | Solaris LWPs, old FreeBSD KSE, Go's goroutines, Java's virtual threads |

Linux chose 1:1 deliberately: the scheduler is fast enough, blocking syscalls stay simple, and debugging/profiling tools see real tasks. M:N gets you cheap creation (goroutines ~2 KB stack, ~200 ns to spawn) and cheap switching (~50–100 ns, just a register swap in user space) at the cost of needing every blocking operation to be intercepted. §31.12 covers the user-space half of this.

---

## 31.9 Linux NPTL

**NPTL** (Native POSIX Thread Library, Drepper & Molnar, glibc 2.3.2, 2003) is the current Linux threading implementation, replacing **LinuxThreads**, whose defects define what NPTL had to fix:

| LinuxThreads problem | NPTL fix |
|---|---|
| Each thread had a distinct PID; `getpid()` differed per thread | `CLONE_THREAD` gives one TGID for all threads |
| A dedicated "manager thread" serialized creation and cleanup | Kernel handles it via `CLONE_CHILD_CLEARTID` |
| Signals were per-thread only; process-directed signals didn't work | Kernel-level thread groups deliver process-directed signals to any eligible thread |
| Synchronization used signals — slow and racy | **Futexes** (Ch. 33 §33.7): no syscall in the uncontended case |
| 8192-thread limit | Limited only by memory and `threads-max` |
| `exec` from a non-main thread was broken | Correct |

**The futex is the central idea.** A `pthread_mutex_t` is a word in user memory. Locking is a `cmpxchg`; if it succeeds (uncontended) *no syscall occurs* — that's the 15–25 ns figure from Ch. 30 §30.2. Only on contention does the thread call `futex(FUTEX_WAIT)` and pay ~2–8 µs. Everything NPTL exposes — mutexes, condition variables, barriers, semaphores, `pthread_join`, `pthread_once` — is built on this pattern.

NPTL details worth knowing:

- **TLS** (`__thread`, C++ `thread_local`) is implemented with a per-thread block reached via `%fs` on x86-64 (`tpidr_el0` on AArch64). Access to a static-TLS variable in the main executable is a single `mov %fs:offset` — as cheap as a global. Access from a `dlopen`ed shared library uses the **general dynamic** TLS model and calls `__tls_get_addr`, which is 5–20× slower. `-ftls-model=initial-exec` on hot libraries fixes it; `local-exec` is fastest but only valid in the executable.
- **Thread-local destructors** for C++ objects run at thread exit via `__cxa_thread_atexit`, which can resurrect surprising ordering problems at shutdown.
- **`pthread_cancel`** is implemented by sending a real signal (`SIGRTMIN`) and unwinding the stack — it interacts with C++ destructors through forced unwinding, and in practice is unusable in C++. Use a `std::stop_token` (Ch. 24 §24.1) instead.
- **`set_robust_list`** supports robust mutexes: if a thread dies holding one, the kernel marks it `EOWNERDEAD` for the next acquirer. This is the only sane basis for process-shared mutexes (Ch. 33 §33.5).

---

## 31.10 Pthreads

The POSIX threads API, which `std::thread` is implemented over on Linux. Interviews use it to test whether you know what the C++ abstraction hides.

| POSIX | C++ equivalent | Gap |
|---|---|---|
| `pthread_create` | `std::thread` ctor | C++ has no attribute object — no stack size, no scheduling policy, no affinity at creation |
| `pthread_join` | `std::thread::join` | Same |
| `pthread_detach` | `std::thread::detach` | Same |
| `pthread_mutex_t` | `std::mutex` | POSIX has types: `NORMAL`, `ERRORCHECK`, `RECURSIVE`, `ADAPTIVE`, plus `PTHREAD_PRIO_INHERIT` and `PROCESS_SHARED` — **C++ exposes none of these** |
| `pthread_cond_t` | `std::condition_variable` | POSIX lets you choose the clock (`pthread_condattr_setclock(CLOCK_MONOTONIC)`); C++ `wait_until` on `steady_clock` may still convert to realtime internally |
| `pthread_rwlock_t` | `std::shared_mutex` | POSIX exposes reader/writer preference |
| `pthread_key_t` | `thread_local` | `thread_local` is faster and typed |
| `pthread_setaffinity_np` | — | **No C++ equivalent**; `native_handle()` is the escape hatch |
| `pthread_setschedparam` | — | Same |
| `pthread_barrier_t` | `std::barrier` | C++20 version has a completion function |

**The three attributes you must set manually for low latency**, none of which C++ exposes:

```cpp
pthread_attr_t attr;
pthread_attr_init(&attr);
pthread_attr_setstacksize(&attr, 1 << 20);            // §31.11
cpu_set_t set; CPU_ZERO(&set); CPU_SET(7, &set);
pthread_attr_setaffinity_np(&attr, sizeof set, &set);  // §31.17
pthread_attr_setschedpolicy(&attr, SCHED_FIFO);
sched_param sp{ .sched_priority = 50 };
pthread_attr_setschedparam(&attr, &sp);
pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);  // ← easy to forget
pthread_create(&tid, &attr, fn, arg);
```

`PTHREAD_EXPLICIT_SCHED` is the classic gotcha: the default is `PTHREAD_INHERIT_SCHED`, so your carefully specified policy and priority are silently ignored and the thread inherits the creator's. Candidates who name this have used the API.

With `std::thread`, the equivalent is to set affinity/policy from *inside* the thread function (`sched_setaffinity(0, ...)`, `pthread_setschedparam(pthread_self(), ...)`) or via `native_handle()`. Setting it from inside means the thread runs briefly on the wrong CPU and may allocate its first-touch pages on the wrong NUMA node (Ch. 32 §32.26) — pin before touching memory.

**`PTHREAD_PRIO_INHERIT`** is the mutex attribute that enables priority inheritance and is the standard mitigation for priority inversion (Ch. 24 §24.18, §31.22). `std::mutex` cannot do it. That alone justifies dropping to pthreads in a real-time process.

---

## 31.11 Thread Stacks and Guard Pages

Each thread needs its own stack. The main thread's stack is created by the kernel at `exec` and **grows dynamically** (Ch. 32 §32.21) up to `RLIMIT_STACK` (default 8 MiB). Non-main thread stacks are **fixed-size `mmap` regions** allocated by pthreads — they never grow.

```
default pthread stack = RLIMIT_STACK (8 MiB), capped; overridable per-attr
layout:  [guard page(s)] [ ......... stack, grows down ......... ] [TLS block][pthread struct]
              PROT_NONE                                              at the top
```

**Guard pages** are `PROT_NONE` mappings placed at the low end of each thread stack. Overflowing into one raises `SIGSEGV` instead of silently corrupting the adjacent mapping. Size is one page by default (`pthread_attr_setguardsize`); the kernel's main-thread `stack_guard_gap` is 256 pages (1 MiB) since the 2017 Stack Clash work.

**Guard pages are not sufficient.** A function with a large local array can skip *past* the guard page in a single `sub %rsp, N` and write into whatever is below:

```cpp
void f() { char buf[65536]; buf[0] = 1; }   // may jump the 4 KiB guard entirely
```
The fix is **stack probing** — `-fstack-clash-protection` (GCC 8+/Clang) makes the compiler touch each page as it extends the frame, guaranteeing the guard is hit. This is a hardening flag with essentially zero steady-state cost and should be on.

### Cost model

| Property | Value |
|---|---|
| Default stack size | 8 MiB **virtual**; RSS grows by touched pages only |
| Actual initial RSS per thread | 4–12 KiB (one or two pages) |
| Cost of 1,000 threads at default size | 8 GiB of VSZ, ~10 MiB of RSS |
| Stack allocation cost | One `mmap` (~2–5 µs); glibc **caches** freed stacks for reuse |
| Guard page cost | One VMA, no physical memory |

Because stacks are demand-paged, a large default size is mostly harmless for memory — but it consumes address space and, more importantly, **each first touch of a new stack page is a minor page fault (0.5–2 µs)**. A hot thread that recurses deeply for the first time under load takes a burst of faults exactly when you can least afford it. The mitigations: pre-fault the stack at startup by touching it (an `alloca` + `memset` of the expected depth, or `MAP_POPULATE`/`mlock`), and set `MCL_CURRENT|MCL_FUTURE` via `mlockall` (Ch. 32 §32.15).

`ulimit -s`, `pthread_attr_setstacksize`, and `/proc/<pid>/maps` (look for the 8 MiB `PROT_NONE`-preceded regions) are the tools. Deep recursion, large stack buffers, and ASAN (which inflates frames) are the usual overflow causes; ASAN's `stack-overflow` report or a `SIGSEGV` with a fault address just below a mapped stack is the signature.

---

## 31.12 Fibers and User-Space Scheduling

A **fiber** (a.k.a. coroutine with its own stack, green thread, user-level thread) is a unit of execution scheduled entirely in user space. Switching one means saving and restoring callee-saved registers and swapping the stack pointer — **no kernel involvement, no `CR3` change, no scheduler**.

| | Kernel thread switch | Fiber switch |
|---|---|---|
| Cost | 1–3 µs direct, 10–100 µs indirect | **20–100 ns** |
| Mechanism | `schedule()`, register + FPU save, possible `CR3` | `swapcontext`-style register swap |
| Preemptible | Yes (timer interrupt) | **No** — cooperative only |
| Blocking syscall | Blocks one thread | **Blocks the whole carrier thread** |
| Scales to cores | Yes | Only with a carrier thread per core |
| Stack | 8 MiB VSZ, kernel-managed, guard page | User-allocated; often segmented or small |
| Debugger/profiler support | Native | Poor — one kernel stack, many logical ones |

Implementations: `ucontext` (`makecontext`/`swapcontext` — POSIX but slow, since `swapcontext` does a `sigprocmask` syscall), Boost.Context / Boost.Fiber (hand-written assembly, ~20 ns), folly Fibers, Go's goroutines, Java virtual threads.

**C++20 coroutines are not fibers.** They are *stackless*: the compiler transforms the function into a state machine and heap-allocates a frame containing only the locals that live across suspension points (Ch. 19 §19.7–§19.9). Consequences:

| | Stackful fiber | Stackless coroutine (C++20) |
|---|---|---|
| Can suspend from a nested call | **Yes** | **No** — only from the coroutine body |
| Memory per instance | Whole stack (KiB–MiB) | Frame size only (tens of bytes possible) |
| Switch cost | ~20–100 ns (register swap) | ~2–10 ns (an indirect call; often inlined away) |
| Allocation | Stack, up front | Heap frame, elidable via HALO |
| Debuggability | Poor | Improving; frames are visible types |

For low latency the honest position is that **neither is usually the right answer on the hot path**. A single-writer busy-polling event loop (Ch. 52 §52.8, Ch. 55 §55.3) with explicit state machines has no switch cost at all and no allocation. Fibers earn their keep when you have many thousands of logically blocking flows (a gateway multiplexing 10,000 sessions) and the alternative is 10,000 kernel threads. Coroutines earn theirs when they make an async state machine readable without heap traffic — verify with `-Wno-coroutine-frame-size` diagnostics or by checking for the elided allocation in the assembly.

---

## 31.13 Context Switches

A **context switch** is the kernel replacing the currently running task on a CPU with another. Distinguish it from a **mode switch** (user↔kernel transition, e.g. a syscall), which does *not* change the running task and costs 40–350 ns (Ch. 30 §30.2, Ch. 34 §34.3).

### What actually happens

```
1. Enter kernel (interrupt, syscall, or explicit schedule())
2. Save the outgoing task's user registers on its kernel stack
3. Update accounting (runtime, vruntime, cgroup stats)
4. pick_next_task()  — run-queue selection, §31.16
5. switch_mm()  — if the address space differs: load CR3 (with PCID tag)
6. switch_to()  — swap kernel stack, callee-saved registers, TLS base (FS_BASE),
                  and lazily the FPU/AVX state (XSAVE/XRSTOR, up to ~2.5 KB with AVX-512)
7. Return to user mode
```

| Cost component | Magnitude |
|---|---|
| Direct kernel work | 1–3 µs |
| `CR3` reload without PCID | +100–200 cycles + full TLB refill |
| `CR3` reload with PCID | +~200 cycles, TLB entries preserved |
| FPU/AVX-512 state save+restore | 100–300 cycles |
| **Cache pollution (L1/L2 evicted)** | **10–100 µs of degraded execution** |
| Branch predictor and BTB pollution | 1–10 µs of extra mispredicts |
| Migration to a different NUMA node | Working set becomes remote; 1.4–2× until re-faulted |

**Voluntary vs involuntary** is the distinction to make:

- **Voluntary** (`nvcsw`): the task blocked — waited on a futex, a socket, a page fault. It gave up the CPU because it had nothing to do.
- **Involuntary** (`nivcsw`): the scheduler preempted it — quantum expired, a higher-priority task woke, or an interrupt arrived. This is the one that hurts, because it happens mid-computation.

```
$ perf stat -e context-switches,cpu-migrations ./app
$ grep ctxt /proc/<pid>/status         # voluntary_ctxt_switches / nonvoluntary_ctxt_switches
$ perf sched record -- sleep 5; perf sched latency
$ bpftrace -e 'tracepoint:sched:sched_switch /args->prev_comm == "myapp"/ { @[kstack] = count(); }'
```

**The target for a hot-path thread is zero involuntary switches per second.** Any nonzero number means something is sharing the core — another task, a kernel thread, an IRQ handler, or the timer tick — and each event costs you a 10–100 µs latency outlier. Sections §31.19–§31.20 are entirely about driving that number to zero.

A subtlety worth mentioning: on a machine with **SMT enabled**, your thread doesn't need to be switched out to be slowed down — the sibling hyperthread competes for the same L1, µop cache, and execution ports continuously. `perf stat` will not show a context switch; it will show elevated `cycles` per instruction. Disable SMT or isolate both siblings of a core.

---

## 31.14 Linux Fair Scheduling

`SCHED_OTHER` (also called `SCHED_NORMAL`) is the default policy and what almost every process uses.

### CFS (kernel < 6.6)

The **Completely Fair Scheduler** models an ideal multitasking CPU where every runnable task receives an equal share. It tracks per-task **`vruntime`** — the task's accumulated runtime, scaled inversely by its weight (derived from its nice value) — and always runs the task with the smallest `vruntime`, kept in a red-black tree keyed by `vruntime`.

```
vruntime += delta_exec × (NICE_0_WEIGHT / task_weight)
nice 0 → weight 1024;  each nice level is ~1.25× weight  → ~10% CPU per level
```

Tunables (`/proc/sys/kernel/`):

| Knob | Default | Meaning |
|---|---|---|
| `sched_latency_ns` | 6 ms (scaled ×log2(ncpus) → often 24 ms) | Target period in which every runnable task runs once |
| `sched_min_granularity_ns` | 0.75 ms (scaled → 2.25–3 ms) | Minimum slice; caps the number of tasks in one latency period |
| `sched_wakeup_granularity_ns` | 1 ms | How much `vruntime` advantage a waking task needs to preempt the current one |
| `sched_migration_cost_ns` | 0.5 ms | How recently-run a task must be to be considered cache-hot and not migrated |

With N runnable tasks, each slice ≈ `max(sched_latency/N, min_granularity)`. So the **effective quantum is 0.75–3 ms with few tasks, and floors at `min_granularity` once N is large** — at which point the actual latency period stretches beyond 6 ms. Those are the numbers to quote.

### EEVDF (kernel 6.6+)

CFS was replaced by **EEVDF** (Earliest Eligible Virtual Deadline First). Each task has a **lag** (how much service it is owed) and a **virtual deadline** = eligible time + its request size. The scheduler runs the *eligible* task with the earliest deadline. The practical differences: latency-sensitive tasks can request smaller slices and get better wakeup latency without abusing nice; `sched_latency_ns`/`sched_min_granularity_ns` are replaced by `sched_base_slice_ns` (default ~0.75–3 ms); and `sched_setattr` gains a per-task slice request (`SCHED_FLAG_KEEP_ALL` / custom slice).

### Related mechanisms

- **Group scheduling / cgroup CPU controller**: `cpu.weight` (v2) distributes shares between cgroups first, then within. `cpu.max` sets a hard quota (`quota/period`), and **exceeding the quota throttles the whole group until the period rolls over** — producing multi-millisecond stalls that look like GC pauses. This is the #1 cause of mysterious tail latency in containerized services. `cpu.stat`'s `nr_throttled`/`throttled_usec` is the diagnostic.
- **`autogroup`** (`/proc/sys/kernel/sched_autogroup_enabled`) groups tasks by session, which can make nice values within a session appear ineffective.
- **`SCHED_BATCH`** hints that the task is throughput-oriented (no wakeup preemption); **`SCHED_IDLE`** gives it minimal weight.

**The conclusion for low latency:** fair scheduling guarantees *fairness*, not *latency*. Nothing in CFS or EEVDF bounds how long a runnable task waits. A hot thread under `SCHED_OTHER` on a shared core can be delayed by milliseconds. That's why §31.15 exists.

---

## 31.15 Real-Time Scheduling Policies

Linux implements POSIX real-time policies with static priorities 1–99, **all of which outrank every `SCHED_OTHER` task** (which effectively sit at priority 0).

| Policy | Selection rule |
|---|---|
| **`SCHED_FIFO`** | Highest priority runs until it blocks, yields, or is preempted by a *higher* priority task. No timeslice. Same-priority tasks run FIFO. |
| **`SCHED_RR`** | Like FIFO, but same-priority tasks round-robin with a quantum (`/proc/sys/kernel/sched_rr_timeslice_ms`, default 100 ms). |
| **`SCHED_DEADLINE`** | EDF + constant-bandwidth server. Per-task `(runtime, deadline, period)`; the kernel admission-controls to guarantee the set is schedulable. Outranks FIFO/RR. |

```bash
chrt -f 80 -p <pid>            # set SCHED_FIFO prio 80 on a running process
chrt -f 80 ./app               # launch under FIFO
chrt -p <pid>                  # query
```
```cpp
sched_param sp{ .sched_priority = 80 };
pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
// or sched_setattr() for SCHED_DEADLINE
```

Permissions: `CAP_SYS_NICE`, or `RLIMIT_RTPRIO` set in `/etc/security/limits.conf`, or `systemd`'s `LimitRTPRIO=`.

### Priority selection

Priorities are only meaningful relative to the kernel's own RT threads:

| Priority | Occupant |
|---|---|
| 99 | `migration/N` (stop-machine), watchdog |
| 50 | Default for many IRQ threads under `PREEMPT_RT` |
| 1–98 | Yours |

Running your application at 99 above `migration/N` is a good way to hang the machine. **Pick something in the 40s–80s and stay below the kernel's stop-machine threads.**

### The throttle

`SCHED_FIFO` has no timeslice, so a spinning RT task can monopolize a CPU and lock out `kworker`, `ksoftirqd`, and even `sshd`. Linux therefore ships **RT throttling**:

```
/proc/sys/kernel/sched_rt_period_us    = 1000000   (1 s)
/proc/sys/kernel/sched_rt_runtime_us   =  950000   (0.95 s)
```
RT tasks get at most 95% of each second per CPU; the remaining 5% is forced to non-RT. For a busy-polling thread this means **the kernel will preempt you for 50 ms out of every second** — a catastrophic, perfectly periodic latency spike that people spend days chasing. Setting `sched_rt_runtime_us = -1` disables the throttle and hands you the responsibility of never starving the housekeeping work (which you then must move off the isolated core; §31.20).

**`SCHED_DEADLINE`** is the principled alternative: you declare a budget, the kernel admission-controls, and there's no global throttle — but a task cannot fork under it, affinity is restricted, and the API (`sched_setattr`) has no glibc wrapper. Rare in trading, common in industrial control.

---

## 31.16 Scheduler Run Queues and Wakeup Latency

Linux keeps a **per-CPU run queue** (`struct rq`), which is why scheduling scales: there is no global lock on the common path. Each `rq` contains sub-queues per scheduling class, consulted in strict order:

```
pick_next_task():
   stop_sched_class     (migration/N)
   → dl_sched_class     (SCHED_DEADLINE, EDF)
   → rt_sched_class     (FIFO/RR, 100 priority bitmapped lists)
   → fair_sched_class   (CFS/EEVDF red-black tree)
   → idle_sched_class
```

**Wakeup latency** — the interval from the event that makes a task runnable to the task executing its first user instruction — is the number that determines your tail:

```
event (IRQ / futex wake / timerfd)
   │ 0.5–2 µs   interrupt entry, handler, ttwu()
   ▼
select_task_rq()  ← which CPU should run it?
   │ 0–3 µs      may need an IPI to the target CPU (reschedule_ipi)
   ▼
enqueue on target rq; set need_resched
   │ 0 µs (preemptible kernel) … up to full quantum (if the current task can't be preempted)
   ▼
context switch in  (1–3 µs) + cache-cold execution (10–100 µs)
```

| Condition | Typical wakeup latency |
|---|---|
| Idle target CPU, `SCHED_FIFO` waker and wakee | 2–5 µs |
| Idle target CPU in **C6**, must be woken | +50–150 µs |
| Target busy with a `SCHED_OTHER` task, wakee is RT | 3–8 µs (immediate preemption) |
| Target busy, wakee is `SCHED_OTHER`, insufficient vruntime lag | up to `sched_wakeup_granularity` (~1 ms) |
| Loaded box, 10 runnable per core, `SCHED_OTHER` | 1–20 ms |
| `PREEMPT_RT` kernel, tuned, isolated core | 5–30 µs worst case (`cyclictest`-measured) |

**`select_task_rq_fair`** implements wake affinity: it prefers to place a waking task on a CPU sharing cache with the waker (`wake_affine`), balancing cache locality against run-queue depth. `sched_migration_cost_ns` controls how "hot" a task is considered. This heuristic is usually right and occasionally disastrous — it can pile producer and consumer onto one core, or bounce a thread between NUMA nodes. Pinning (§31.17) removes the heuristic from the equation entirely.

**Measurement:**
```bash
perf sched record -- sleep 5 && perf sched latency --sort max   # per-task max wakeup delay
cyclictest -p 99 -t 4 -m -n -i 200 -D 60 -h 400                 # canonical RT latency test (Ch. 35 §35.18)
bpftrace -e 'tracepoint:sched:sched_wakeup { @w[args->pid] = nsecs; }
             tracepoint:sched:sched_switch /@w[args->next_pid]/ {
                 @lat = hist(nsecs - @w[args->next_pid]); delete(@w[args->next_pid]); }'
trace-cmd record -e sched_wakeup -e sched_switch                 # ftrace, full timeline
```

The `cyclictest` max is the honest headline number for a tuned box: **a stock kernel gives 50–500 µs worst case; a tuned `PREEMPT_RT` box with isolation gives 10–30 µs.** Neither is good enough for a 2 µs tick-to-trade budget, which is exactly why hot paths busy-poll and never sleep (§31.21).

---

## 31.17 CPU Affinity

**Affinity** is the set of CPUs a task is permitted to run on, held as a bitmask in the `task_struct`.

```c
cpu_set_t set;
CPU_ZERO(&set);
CPU_SET(7, &set);
sched_setaffinity(0, sizeof(set), &set);      // 0 = calling thread
pthread_setaffinity_np(tid, sizeof(set), &set);
```
```bash
taskset -c 7 ./app          # launch pinned
taskset -pc 7 <pid>         # repin a running process
taskset -pc <pid>           # query
```

Note `sched_setaffinity`'s first argument is a **TID**, not a PID: passing a PID sets only the main thread. `taskset -p` on a multithreaded process likewise affects only one thread unless you iterate `/proc/<pid>/task/*`. This catches people constantly.

### Why pin at all

1. **Cache locality.** An unpinned thread migrates and arrives with cold L1/L2 — 10–100 µs of degraded execution per migration (§31.13).
2. **NUMA locality.** First-touch allocation (Ch. 32 §32.26) binds pages to the node where they were first written. Migrating the thread makes every access remote: 1.4–2× latency, permanently, until the pages are moved.
3. **Determinism.** The scheduler's placement heuristics are a source of variance you cannot model.
4. **Prerequisite for isolation.** `isolcpus`/`nohz_full` (§31.19) only helps if your thread actually lands there.

### What pinning costs

- **Reduced flexibility**: a pinned thread on a busy CPU will not be load-balanced away, even if fifteen other cores are idle. Over-pinning creates its own hotspots.
- **Hidden serialization**: pinning two threads to the two SMT siblings of one physical core halves their throughput while looking like two cores in `top`.
- **`cpuset` interaction**: cgroup `cpuset.cpus` intersects with your mask. If it excludes your target, `sched_setaffinity` returns `EINVAL`. Under Kubernetes, this is why pinning fails inside a container.

**Order of operations matters:** pin the thread, *then* allocate and touch its memory, *then* start work. Pinning after first touch leaves the pages on the wrong node.

`/proc/<pid>/status` shows `Cpus_allowed_list`; `ps -eLo pid,tid,psr,comm` shows which CPU each thread last ran on (`psr`); `perf stat -e cpu-migrations` counts violations.

---

## 31.18 CPU Topology-Aware Pinning

Pinning to "core 7" is meaningless without knowing what core 7 *is*. Linux numbers logical CPUs in whatever order the firmware presents them, and the two common enumerations are:

```
Interleaved (common on Intel 2-socket, SMT on):
  CPU 0..N-1   = one thread of every core, node 0 then node 1
  CPU N..2N-1  = the sibling threads, same order
  → CPU 0 and CPU N are SMT siblings of the SAME physical core

Sequential (common on AMD, some BIOSes):
  CPU 0,1 = siblings of core 0;  CPU 2,3 = siblings of core 1; ...
```

**Never assume.** Read it:

```bash
lscpu -e=CPU,NODE,SOCKET,CORE,L1d:L2:L3      # the definitive table
lstopo-no-graphics                            # hwloc, shows cache/PCI topology visually
cat /sys/devices/system/cpu/cpu7/topology/{core_id,physical_package_id,thread_siblings_list}
cat /sys/devices/system/cpu/cpu7/cache/index*/shared_cpu_list
numactl --hardware                            # node ↔ CPU ↔ memory map and distance matrix
cat /sys/class/net/eth0/device/numa_node      # which node the NIC is on
```

### The placement rules

| Rule | Reason |
|---|---|
| Never place two hot threads on **SMT siblings** | They share L1, L2, µop cache, and execution ports; 1.2–2× slowdown with no visible context switch |
| Place producer and consumer on **cores sharing an L3** (same socket / same CCX on AMD) | Cache-line handoff is 40–80 ns intra-socket vs 200–400 ns cross-socket (Ch. 30 §30.2) |
| Place the NIC-polling thread on the **NUMA node the NIC is attached to** | Avoids cross-socket DMA and remote descriptor reads; DDIO only lands in the local L3 (Ch. 29 §29.24) |
| Allocate ring buffers and packet pools on the **same node as the consuming thread** | First touch (Ch. 32 §32.26) |
| On AMD Zen, keep a thread group within one **CCX/CCD** | Cross-CCD L3 is not shared; a transfer goes through Infinity Fabric |
| Avoid **core 0** for hot threads | Many IRQs, RCU callbacks, and legacy timers default there |
| Keep siblings of an isolated core **also isolated** | Otherwise a housekeeping task on the sibling steals half your core |

A realistic layout for a two-socket box with the NIC on node 0:

```
node 0: cpu 0      housekeeping, IRQs, logging          (not isolated)
        cpu 2      feed handler / NIC busy-poll         (isolated, FIFO 80)
        cpu 4      book builder + strategy              (isolated, FIFO 80)
        cpu 6      order gateway TX                     (isolated, FIFO 80)
        cpu 1,3,5,7  SMT siblings of the above — isolated and left IDLE
node 1: everything else — metrics, journal writer, control plane
```

Leaving SMT siblings idle "wastes" cores and is standard practice; the alternative is unpredictable ~1.5× slowdowns. Many shops simply disable SMT in BIOS (`nosmt` boot parameter) to remove the possibility.

`hwloc-bind`, `numactl --cpunodebind=0 --membind=0`, and `taskset` are the operational tools; `perf c2c` verifies that the cache lines you expect to be shared actually are.

---

## 31.19 Core Isolation

Isolation means removing a CPU from the general-purpose scheduler and from as many kernel activities as possible, so that the one thread you place there runs uninterrupted.

### The layers

| Mechanism | What it removes | How |
|---|---|---|
| **`isolcpus=2-7`** | The CPU from the load balancer's domains; nothing is placed there unless explicitly pinned | Boot parameter |
| **`nohz_full=2-7`** | The **1000 Hz timer tick** on CPUs running exactly one runnable task | Boot parameter; requires `CONFIG_NO_HZ_FULL` |
| **`rcu_nocbs=2-7`** | RCU callback processing (offloaded to `rcuo` kthreads on housekeeping CPUs) | Boot parameter |
| **`irqaffinity=0,1`** | Interrupt handling | Boot parameter + `/proc/irq/*/smp_affinity` |
| **cgroup v2 `cpuset.cpus.partition=isolated`** | Same as `isolcpus` but dynamic, no reboot | `cpuset` controller |
| **`nosmt` or per-core `cpu/online=0`** | Sibling interference | Boot parameter or sysfs |
| **`workqueue.cpumask`, `kthread_cpus`** | Unbound kernel work | Boot parameters |

`nohz_full` is the highest-value item and the most misunderstood. The tick normally fires 250–1000 times per second per CPU to do accounting, run timers, and check preemption; each is a ~1–5 µs interrupt plus cache pollution. `nohz_full` suppresses it — **but only while exactly one task is runnable on that CPU**. Two runnable tasks (including a stray kernel thread) and the tick comes back at full rate. Verify, don't assume:

```bash
cat /sys/devices/system/cpu/nohz_full
perf stat -e irq_vectors:local_timer_entry -C 4 -- sleep 10   # should be ~1/s, not 1000/s
cat /proc/interrupts | grep LOC                                # local timer count per CPU
```

Residual interrupts you cannot remove: NMI (watchdog — disable with `nmi_watchdog=0`), machine-check, IPIs for TLB shootdowns (Ch. 32 §32.9) and `smp_call_function`, and the ~1 Hz residual tick `nohz_full` keeps for scheduler accounting.

### The full boot line, as used in practice

```
isolcpus=nohz,domain,2-7 nohz_full=2-7 rcu_nocbs=2-7 rcu_nocb_poll
irqaffinity=0-1 nosoftlockup nmi_watchdog=0 mce=ignore_ce
intel_pstate=disable idle=poll processor.max_cstate=1 intel_idle.max_cstate=0
tsc=reliable clocksource=tsc audit=0 nowatchdog skew_tick=1
mitigations=off transparent_hugepage=never default_hugepagesz=1G hugepagesz=1G hugepages=32
```

`idle=poll` keeps the CPU in C0 (busy-looping in the idle thread) to avoid the 50–150 µs C-state exit latency — at the cost of ~100 W and heat, which reduces turbo headroom for the other cores. `skew_tick=1` staggers the residual ticks across CPUs so they don't all fire simultaneously and contend on the same locks.

**Measured effect.** On a stock kernel, a busy-poll loop sees interruptions of 50–500 µs at p99.99. Fully isolated with `nohz_full` and `idle=poll`, the same loop sees 5–20 µs, and the remaining outliers are IPIs and SMIs. **SMIs (System Management Interrupts)** are firmware-level and invisible to the OS — they can take 100 µs–1 ms and are detectable only via `hwlatdetect` or the `SMI count` MSR (`msr 0x34`). Checking for them is a strong interview answer to "you've isolated everything and still see 200 µs spikes."

---

## 31.20 Housekeeping CPUs

Isolation is only half the design: the work you removed from the isolated cores still has to run somewhere. **Housekeeping CPUs** are the non-isolated cores that absorb it.

What lands there:

| Work | Directed by |
|---|---|
| All device interrupts | `irqaffinity=` boot param, `/proc/irq/N/smp_affinity_list`, `irqbalance` (**disable it** — it will undo your work) |
| RCU callbacks | `rcu_nocbs=` offloads to `rcuo/N` kthreads, which must themselves be pinned |
| Unbound workqueues | `/sys/devices/virtual/workqueue/cpumask` |
| `kswapd`, `khugepaged`, writeback | Kernel threads; pin with `taskset` at boot or via a systemd unit |
| Timer callbacks, deferred work | Follows the tick |
| Your own logging, metrics, control plane, admin RPC | Application design |
| `systemd` and all system services | `systemd.conf` `CPUAffinity=0-1` — applies to PID 1 and everything it spawns |

```bash
systemctl set-property --runtime user.slice AllowedCPUs=0-1
systemctl set-property --runtime system.slice AllowedCPUs=0-1
systemctl set-property --runtime init.scope AllowedCPUs=0-1
echo 0-1 > /sys/devices/virtual/workqueue/cpumask
for i in /proc/irq/*/smp_affinity_list; do echo 0-1 > $i 2>/dev/null; done
systemctl stop irqbalance && systemctl disable irqbalance
```

**Sizing.** Housekeeping needs real capacity: on a 32-core box, 2–4 housekeeping cores is typical, more if the NIC generates heavy interrupt load or you run a chatty logging pipeline. Under-provisioning them produces a subtle failure: kernel work backs up, `ksoftirqd` starts running, and eventually the kernel schedules it *onto an isolated core* anyway because nothing else can make progress — reintroducing exactly the jitter you eliminated.

**The `nohz_full` dependency.** A `nohz_full` CPU still needs a housekeeping CPU to be running its timekeeping; if all CPUs were `nohz_full` there would be no one to advance `jiffies`. Linux enforces this by refusing to make CPU 0 `nohz_full`.

**Verification** is the part candidates forget. After configuration:

```bash
watch -n1 'cat /proc/interrupts | awk "{print \$1, \$5, \$6}"'   # no IRQs on isolated CPUs
ps -eLo pid,tid,psr,rtprio,comm | awk '$3 ~ /^[2-7]$/'           # nothing unexpected on 2-7
perf stat -a -C 2-7 -e context-switches,cpu-migrations -- sleep 60   # expect 0
turbostat --interval 1                                            # confirm C0 residency, actual MHz
```

Any nonzero context-switch count on an isolated core is a bug in the configuration, and finding *what* switched in is a `bpftrace` on `sched_switch` filtered by CPU.

---

## 31.21 Busy Polling versus Blocking

The fundamental tradeoff: **blocking** costs a wakeup (2 µs to 20 ms depending on load) but frees the CPU; **busy polling** costs a whole core but responds in the time it takes to read a memory location.

| | Blocking (`epoll_wait`, futex, `read`) | Busy polling |
|---|---|---|
| Response latency | 3 µs – 20 ms (wakeup path, §31.16) | 20–200 ns (one cache-line read) |
| Jitter | High — depends on run-queue state, C-states, IRQ timing | Very low |
| CPU cost | ~0 when idle | 100% of a core, always |
| Power | Low | +80–150 W per core; heat reduces turbo for neighbours |
| Scales to many flows | Yes | No — one core per polled queue |
| Syscall count | 1+ per event | 0 |
| Cache state on arrival | Cold (was descheduled) | **Hot** — this is an underrated second-order win |

**Polling wins twice**: no wakeup latency *and* the code, data, and branch predictors are already warm. A blocked thread waking after 500 µs of idleness finds its L1 evicted and pays another 10–50 µs re-warming; that hidden cost is often larger than the wakeup itself.

### The spectrum

```
pure block  ──▶ spin-then-park ──▶ kernel busy-poll ──▶ user-space poll ──▶ FPGA
epoll_wait      adaptive mutex     SO_BUSY_POLL       DPDK/ef_vi/spin      no CPU at all
20 µs–ms        50 ns–5 µs         2–4 µs             0.7–2 µs             30–120 ns
```

- **Spin-then-park** (Ch. 24 §24.15): spin for N iterations, then block. The right N is roughly the cost of a park+wake (≈2 µs ≈ 6,000 cycles), because spinning longer than the sleep cost is never worse. glibc adaptive mutexes and `std::atomic::wait` do this.
- **`SO_BUSY_POLL` / `/proc/sys/net/core/busy_poll`**: the kernel polls the NIC driver inside `recvmsg`/`epoll_wait` for N microseconds before sleeping, removing the interrupt and wakeup from the path while keeping the socket API.
- **Full user-space polling** (Ch. 47): the application reads the NIC descriptor ring directly. No kernel involvement at all.

### Writing a correct spin loop

```cpp
while (!queue.try_pop(msg)) {
    _mm_pause();                      // ~40 cycles on Skylake+; yields SMT resources,
                                      // avoids memory-order machine clears on loop exit
}
```
`_mm_pause()` (`YIELD` on ARM) is mandatory, not optional: without it the spinning core saturates its load ports, starves its SMT sibling, and suffers a memory-ordering machine clear when the value finally changes. `sched_yield()` in a spin loop is an anti-pattern — it is a syscall (200–350 ns), and under `SCHED_FIFO` it moves you to the tail of your priority's run queue, which can be worse than not yielding.

**When to block anyway:** control-plane threads, anything handling more flows than you have cores, and anything where a 100 µs response is acceptable. Burning a core to poll a channel that sees one message per second is how you run out of cores and start co-scheduling hot threads — the failure mode that busy polling was supposed to prevent.

---

## 31.22 Real-Time Scheduling Operational Hazards

Turning on `SCHED_FIFO` is easy; the failure modes are what interviews probe.

**1. Locking out the kernel.** A `SCHED_FIFO` thread that spins without blocking prevents every lower-priority task on that CPU from running — including `kworker`, `ksoftirqd`, and `sshd`. If it also happens to hold a lock the kernel needs, the machine wedges. The RT throttle (§31.15) exists to prevent exactly this, and disabling the throttle (`sched_rt_runtime_us=-1`) removes the safety net. **Always leave a housekeeping core out of your RT set, and always have an out-of-band way in (IPMI/serial).**

**2. The 50 ms periodic spike.** The default throttle yields 950 ms of RT time per 1 s per CPU. A busy-polling FIFO thread is therefore forcibly descheduled for ~50 ms once per second. Diagnostic signature: a *perfectly periodic* 1 Hz latency spike of tens of milliseconds, visible in `perf sched` as an involuntary switch to `swapper` or a fair task.

**3. Priority inversion.** A high-priority RT thread blocks on a mutex held by a low-priority thread, which is itself preempted by a medium-priority thread; the high-priority thread waits indefinitely. This is the Mars Pathfinder failure. Mitigations: `PTHREAD_PRIO_INHERIT` (priority inheritance — the holder is temporarily boosted), `PTHREAD_PRIO_PROTECT` (priority ceiling), or — best for a hot path — **never share a lock between RT and non-RT threads at all**. `std::mutex` supports neither protocol (§31.10).

**4. Unbounded priority inversion via the kernel.** Your RT thread calls into the kernel and blocks on a kernel mutex held by a `SCHED_OTHER` task. On a stock kernel most kernel locks are non-preemptible spinlocks without inheritance; `PREEMPT_RT` converts them to `rt_mutex` with inheritance, which is one of its main reasons to exist.

**5. Hidden blocking on the "lock-free" path.** The archetypal bug: a hot path that is carefully lock-free but calls `malloc` (which takes an arena lock and can `mmap`), or logs through `std::cout` (locale lock, `write` syscall), or touches a page for the first time (page fault, `mmap_lock`), or grows a `std::vector`. Each is a syscall or a lock you didn't intend. Detect with `perf trace` filtered to the hot thread, `bpftrace` on `sys_enter`, or by asserting zero `voluntary_ctxt_switches` growth in steady state.

**6. Priority and CPU-frequency interaction.** RT tasks don't drive the `schedutil` governor's frequency estimate the way you'd expect, and a busy-poll loop that executes few instructions can leave the core at a low P-state. Pin the frequency (`intel_pstate=disable` + `cpupower frequency-set -g performance`, or `performance` governor) rather than trusting the governor (Ch. 35 §35.11).

**7. Debugging becomes hostile.** A `SCHED_FIFO` 99 thread that spins makes `gdb` attach, `perf record`, and even `ssh` unresponsive on that CPU. Develop at a lower priority; raise it only in production configuration.

**8. `mlockall` is a prerequisite, not an optional extra.** An RT thread that takes a major page fault has just done a 30 µs–10 ms blocking disk read at priority 99. `mlockall(MCL_CURRENT|MCL_FUTURE)` plus pre-faulting (Ch. 32 §32.15–§32.16) is part of the RT setup, not a separate optimization.

**The operational checklist**, worth reciting: pin, isolate, move IRQs and kernel threads to housekeeping cores, disable `irqbalance`, disable C-states and fix the frequency, `mlockall` and pre-fault, preallocate every buffer, no syscalls and no allocation on the hot path, decide about the RT throttle deliberately, disable SMT or idle the siblings, and then **verify with `cyclictest`, `perf stat -e context-switches`, `/proc/interrupts`, and `turbostat`** rather than trusting the configuration.

---

## Key Interview Questions

1. **What is the difference between a process and a thread on Linux?** — Both are `task_struct`s; a thread is one that shares `mm`, `files`, `sighand`, and `signal` via `CLONE_*` flags. The scheduler treats them identically.
2. **What does `getpid()` return in a thread, and how do you get the thread's own ID?** — The TGID (shared by all threads); `gettid()` returns the kernel PID, which is the per-thread ID.
3. **What does `D` state mean and why can't you kill such a process?** — Uninterruptible sleep, usually in I/O or a kernel lock; signals are only checked on return to user mode, which never happens. `D` also inflates the load average.
4. **How does `fork` avoid copying memory, and what does it still cost?** — COW: page tables are copied and both sides marked read-only; cost is O(mapped pages) for the page-table copy (300 µs–2 ms for 1 GiB) plus 1.5–3 µs per later COW fault.
5. **Why is `fork` dangerous in a multithreaded program?** — Only the calling thread survives; any lock held by another thread (notably the allocator's) is inherited locked. Only async-signal-safe calls are legal before `exec`.
6. **What survives `exec`?** — PID/PPID/PGID/SID, non-`CLOEXEC` descriptors, signal mask and pending signals, `nice`, cwd, credentials (unless setuid). Handlers reset; address space, threads, and locks are gone.
7. **Why does every descriptor-creating syscall have an `O_CLOEXEC` variant?** — Setting the flag afterwards is racy against a concurrent `fork`+`exec`, leaking the descriptor.
8. **What is a zombie and how do you avoid accumulating them?** — A terminated task retained for its exit status; `wait`/`waitpid` in a loop with `WNOHANG` from a `SIGCHLD` handler, or `SIG_IGN`/`SA_NOCLDWAIT` for auto-reap.
9. **Why must a `SIGCHLD` handler loop?** — Standard signals don't queue; several exits can coalesce into one delivery.
10. **What problems did NPTL fix relative to LinuxThreads?** — Real thread groups (one PID), no manager thread, correct process-directed signals, and futex-based synchronization with no syscall in the uncontended case.
11. **Why is an uncontended `pthread_mutex_t` lock ~20 ns?** — It's a `cmpxchg` on a user-space word; the futex syscall only happens on contention.
12. **What's the default thread stack size and what does it actually cost?** — 8 MiB of virtual address space, a few KiB of RSS; the cost is minor page faults on first touch and address-space consumption, not memory.
13. **What is a guard page and why isn't it enough?** — A `PROT_NONE` page below the stack that turns overflow into `SIGSEGV`; a large stack frame can jump over it, so you also need `-fstack-clash-protection`.
14. **Stackful fibers vs C++20 coroutines?** — Fibers switch a real stack (~20–100 ns) and can suspend from nested calls; coroutines are compiler-generated state machines with heap frames that can only suspend in the coroutine body but cost near-zero per switch.
15. **Direct vs indirect cost of a context switch?** — 1–3 µs of kernel work vs 10–100 µs of cache/TLB/branch-predictor recovery; the indirect cost dominates.
16. **Voluntary vs involuntary context switches — which matters?** — Involuntary; it means something preempted you mid-work. Target zero per second on a hot thread.
17. **What is the CFS/EEVDF timeslice?** — Roughly `max(sched_latency_ns/N, sched_min_granularity_ns)` — 0.75–3 ms typically. EEVDF replaces it with `sched_base_slice_ns` plus per-task deadlines. Neither bounds latency.
18. **Why does fair scheduling not help latency?** — It guarantees proportional share, not bounded waiting. A runnable task can wait milliseconds behind other runnable tasks.
19. **`SCHED_FIFO` vs `SCHED_RR` vs `SCHED_DEADLINE`?** — FIFO runs until it blocks or is preempted by higher priority; RR adds a round-robin quantum among equals; DEADLINE is EDF with admission control and outranks both.
20. **What is RT throttling and what does it look like when it bites?** — 950 ms of RT time per second per CPU by default; a busy-polling FIFO thread sees a perfectly periodic ~50 ms stall once per second.
21. **How do you avoid priority inversion?** — Priority inheritance (`PTHREAD_PRIO_INHERIT`) or priority ceilings; better, don't share locks between RT and non-RT threads. `std::mutex` supports neither.
22. **What does `nohz_full` do and when does it stop working?** — Suppresses the 1000 Hz tick, but only while exactly one task is runnable on the CPU. Verify with `perf stat -e irq_vectors:local_timer_entry`.
23. **You've isolated a core and still see 200 µs spikes. What's left?** — IPIs (TLB shootdowns), NMI watchdog, residual ticks, the SMT sibling, C-state exits, and firmware **SMIs** — check with `hwlatdetect` and the SMI-count MSR.
24. **Why must housekeeping cores be provisioned properly?** — The kernel work you moved still has to run; if it backs up, the kernel schedules it onto your isolated cores anyway.
25. **When should you busy-poll and when should you block?** — Poll when latency below ~10 µs matters and you can afford a core; block for control-plane work and when flows outnumber cores. Spin-then-park for the middle, with a spin budget of about one park+wake (~2 µs).
26. **Why `_mm_pause()` in a spin loop?** — Frees SMT execution resources, reduces power, and avoids the memory-ordering machine clear when the awaited value changes.

---

## Common Traps

- **Assuming `R` state means "on a CPU".** It means runnable; the queue depth is your wakeup latency.
- **Forgetting `D` state counts toward the load average**, so heavy I/O inflates load with no CPU use.
- **Calling `fork()` from a multithreaded program and then doing anything but `exec`** — inherited locked mutexes, especially the allocator's.
- **`fork()` in a latency-sensitive parent** — the parent's own pages become read-only and it pays COW faults afterwards.
- **Setting `FD_CLOEXEC` with `fcntl` after `open`** instead of using `O_CLOEXEC` — racy with concurrent `fork`.
- **Not looping in a `SIGCHLD` handler**, so coalesced signals leave zombies.
- **Not preserving `errno` in a signal handler.**
- **`sched_setaffinity(getpid(), ...)` on a multithreaded process** — it only pins one thread; iterate `/proc/<pid>/task/*`.
- **Pinning after allocating and touching memory** — first-touch already placed the pages on the wrong NUMA node.
- **Pinning two hot threads to SMT siblings** — looks like two cores, performs like 1.2.
- **Forgetting `PTHREAD_EXPLICIT_SCHED`** — your policy and priority are silently ignored.
- **Running `SCHED_FIFO` at priority 99**, above `migration/N`, and hanging the machine.
- **Leaving RT throttling at default and chasing a 1 Hz 50 ms spike for a week.**
- **Disabling RT throttling without moving kernel work to housekeeping cores** — starves `kworker`/`ksoftirqd` and wedges the box.
- **Leaving `irqbalance` running** — it silently rewrites your IRQ affinities.
- **Assuming `nohz_full` is working** without checking `local_timer_entry` counts.
- **Isolating a core but not its SMT sibling.**
- **Calling `malloc`, logging, or touching a fresh page on a "lock-free" RT path** — every one is a hidden lock, syscall, or fault.
- **Forgetting `mlockall` on an RT thread** — a major fault at priority 99 is a millisecond of blocking disk I/O.
- **`sched_yield()` in a spin loop** — a syscall, and under FIFO it sends you to the back of your priority queue.
- **Daemonizing under `systemd`** — breaks main-PID tracking and journal capture.
- **Ignoring cgroup `cpu.max` throttling** in containers — the classic multi-millisecond tail with no visible CPU saturation (`cpu.stat: nr_throttled`).
- **Trusting the configuration instead of measuring it** — `cyclictest`, `/proc/interrupts`, `perf stat -e context-switches -C <core>`, `turbostat`.

---

## Compact Recall Summary

**Tasks.** Linux schedules `task_struct`s. A thread shares `mm`/`files`/`sighand`/`signal` via `clone` flags; a process shares none. `getpid()` = TGID, `gettid()` = the kernel's PID. Kernel threads have `mm == NULL` and are the tasks that will preempt yours (`ksoftirqd`, `kworker`, `migration/N` at FIFO 99, `khugepaged`).

**States.** `R` = runnable (not necessarily running); `S` interruptible; `D` uninterruptible and unkillable, and counted in the load average; `Z` awaiting reap. Transitions, not states, are what latency work measures.

**Creation.** `fork` = COW: page tables copied (O(mapped pages), 300 µs–2 ms per GiB), later writes fault at 1.5–3 µs each. Unsafe in multithreaded programs. `exec` replaces the image, keeps PID and non-`CLOEXEC` fds, resets handlers, kills other threads. `posix_spawn` beats `fork`+`exec`. Zombies need a `waitpid(WNOHANG)` loop or `SA_NOCLDWAIT`.

**Threads.** NPTL is 1:1 over `clone`, futex-based: uncontended mutex 15–25 ns with no syscall, contended 2–8 µs. Pthreads exposes stack size, affinity, policy, and `PTHREAD_PRIO_INHERIT`, none of which `std::thread`/`std::mutex` do — remember `PTHREAD_EXPLICIT_SCHED`. Stacks are 8 MiB virtual with a `PROT_NONE` guard page; add `-fstack-clash-protection`. Fibers switch in 20–100 ns but block a whole carrier thread on a syscall; C++20 coroutines are stackless state machines that can't suspend from nested calls.

**Scheduling.** Context switch: 1–3 µs direct, 10–100 µs of cache recovery. CFS/EEVDF gives fairness, not latency bounds; slices are 0.75–3 ms and cgroup `cpu.max` throttling produces multi-ms stalls. `SCHED_FIFO/RR` priorities 1–99 outrank everything fair, subject to RT throttling (950 ms/s → a 1 Hz 50 ms stall). Wakeup latency is 2–5 µs to an idle isolated core and milliseconds on a loaded fair queue; `cyclictest` measures the truth.

**Placement.** Pin with `sched_setaffinity` (per-TID) before touching memory. Read topology from `lscpu -e`, `lstopo`, and `/sys/.../topology/`; never place hot threads on SMT siblings, keep producer/consumer within one L3, and keep the polling thread on the NIC's NUMA node. Isolate with `isolcpus` + `nohz_full` + `rcu_nocbs` + `irqaffinity`, then give the displaced work real housekeeping cores and disable `irqbalance`.

**Polling.** Blocking costs 3 µs–20 ms of wakeup plus a cold cache; polling costs a core and responds in 20–200 ns. Spin-then-park with a budget of roughly one park+wake (~2 µs). Always `_mm_pause()`; never `sched_yield()`.

**RT hazards.** Kernel lockout, the 1 Hz throttle stall, priority inversion (use `PTHREAD_PRIO_INHERIT` or don't share the lock), hidden `malloc`/log/page-fault blocking, frequency governors that don't ramp for poll loops, and firmware SMIs that no kernel setting can remove. Configure, then verify.
