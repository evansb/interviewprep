# Chapter 33 — IPC and Signals

*Interview-focused revision notes. The theme: every inter-process mechanism is a tradeoff between a kernel round-trip you can measure and a shared-memory protocol you must write yourself — and signals are the one asynchronous channel the kernel forces on you whether you asked for it or not.*

---

## 33.1 Pipes and FIFOs

A **pipe** is a unidirectional in-kernel byte stream with a fixed-capacity ring buffer. `pipe(int fds[2])` returns `fds[0]` (read end) and `fds[1]` (write end); the classic use is `fork()` followed by each side closing the end it does not need. A **FIFO** (named pipe) is the same object with a filesystem name, created by `mkfifo(3)`; opening it for reading blocks until a writer appears (and vice versa) unless `O_NONBLOCK` is set.

**Capacity and mechanics.** On Linux the default pipe buffer is **64 KiB**, implemented as a circular array of 16 page-sized `struct pipe_buffer` entries. `fcntl(fd, F_SETPIPE_SZ, n)` resizes it, bounded by `/proc/sys/fs/pipe-max-size` (default 1 MiB). The buffer holds *pages*, not a flat byte array, which is what makes `splice()` (§34.15) able to move pages into a pipe by reference rather than by copy.

**Atomicity.** Writes of at most `PIPE_BUF` bytes (**4096** on Linux) are atomic: they are never interleaved with another writer's data. Above `PIPE_BUF`, a write may be split, so a multi-writer protocol must keep messages ≤ 4096 bytes or carry its own framing. This is the single most-asked pipe detail.

**Semantics that bite:**

| Event | Result |
|---|---|
| Read when empty, writers exist | Blocks (or `EAGAIN` if `O_NONBLOCK`) |
| Read when empty, **all** write ends closed | Returns `0` — EOF |
| Write when no reader exists | `SIGPIPE`; if blocked/ignored, `write` returns `EPIPE` |
| Write when full | Blocks, or `EAGAIN` |

The "all write ends closed" clause is the classic bug: the parent forgets to close its copy of the write end, so the child's read never sees EOF and the pipeline hangs forever. `fork()` duplicates descriptors, so every process holding the write fd keeps the pipe alive.

**SIGPIPE** kills the process by default. Any server writing to sockets or pipes should `signal(SIGPIPE, SIG_IGN)` at startup and handle `EPIPE` from the write, or use `send(..., MSG_NOSIGNAL)`.

**Cost.** A pipe write plus read is two syscalls and two copies (user → kernel page, kernel page → user). A round-trip ping-pong between two processes on a modern x86-64 Linux server costs roughly **5–10 µs** if both sides block and are woken by the scheduler, dominated by wakeup latency, not by the copy. If both sides busy-poll with non-blocking reads on isolated cores, the same exchange is **~1–2 µs**, still paying two syscalls (~50–70 ns each, §34.5) plus the copies. Compared to a shared-memory ring at **~100–300 ns**, pipes are 1–2 orders of magnitude too slow for a hot path.

**Where pipes still belong in a trading system:** the self-pipe trick (pre-`eventfd` wakeup channel for an event loop), child-process plumbing, and control/administrative channels. Never on the market-data or order path.

---

## 33.2 POSIX and System V Message Queues

Message queues are **datagram-oriented**: the kernel preserves message boundaries and, uniquely among Linux IPC primitives, offers **priority ordering**.

**POSIX (`mq_*`, `<mqueue.h>`)** — created with `mq_open("/name", O_CREAT|O_RDWR, 0600, &attr)`. Names live in a virtual filesystem mountable at `/dev/mqueue`. Key operations:

```c
mq_send(mqd, buf, len, prio);         // prio: 0..sysconf(_SC_MQ_PRIO_MAX)-1 (32768 on Linux)
mq_receive(mqd, buf, len, &prio);     // ALWAYS returns the highest-priority oldest message
mq_timedsend/mq_timedreceive(...);    // with an absolute CLOCK_REALTIME deadline
mq_notify(mqd, &sigevent);            // one-shot async notification: signal or thread
```

The receive buffer **must be at least `mq_msgsize`** or `mq_receive` fails with `EMSGSIZE` — it will not truncate. Defaults come from `/proc/sys/fs/mqueue/msg_max` (10) and `msgsize_max` (8192), and unprivileged limits are charged against `RLIMIT_MSGQUEUE`.

The decisive practical advantage of POSIX queues on Linux: **the descriptor is a real file descriptor**, so it is pollable with `select`/`poll`/`epoll` (§34.10). System V queues are not, which alone disqualifies them from event-loop designs.

**System V (`msgget`/`msgsnd`/`msgrcv`/`msgctl`)** — identified by a `key_t` from `ftok(path, id)`, not by a name or an fd. Each message carries a `long mtype` and selection is by type:

```c
struct msgbuf { long mtype; char mtext[N]; };
msgrcv(id, &m, N, 0,   0);            // any message, FIFO
msgrcv(id, &m, N, 5,   0);            // first message with mtype == 5
msgrcv(id, &m, N, -5,  0);            // lowest mtype <= 5  (priority queue emulation)
```

| | POSIX mq | System V mq |
|---|---|---|
| Identifier | Name in `/dev/mqueue` | `key_t` via `ftok` |
| Pollable fd | **Yes** | **No** |
| Ordering | Strict priority, then FIFO | By `mtype` selector |
| Async notify | `mq_notify` (signal/thread) | None |
| Cleanup | `mq_unlink`, refcounted | `msgctl(IPC_RMID)`; **leaks until reboot** |
| Limits | `RLIMIT_MSGQUEUE`, procfs | `msgmax`/`msgmnb`/`msgmni` sysctls |

`ftok()` hashes the inode number and a project byte into 32 bits; **collisions are real**, and if the path is deleted and recreated the key changes silently. System V objects persist beyond process death — `ipcs`/`ipcrm` are the diagnostic and cleanup tools, and stale segments after a crash loop are a recognizable operational signature.

**Latency.** Both are kernel-mediated with a copy in each direction; a send/receive pair costs roughly **3–8 µs** with a blocking receiver, comparable to pipes. Priority ordering is the only thing you cannot get cheaply from a shared-memory ring, and it is rarely worth the syscall.

---

## 33.3 UNIX-Domain Sockets

A **UNIX-domain socket** (`AF_UNIX`, a.k.a. `AF_LOCAL`) is the general-purpose local IPC mechanism: same `socket`/`bind`/`listen`/`accept`/`connect` API as TCP, but no protocol stack, no checksums, no routing, no packetization. Three types:

- `SOCK_STREAM` — reliable, ordered byte stream. The local analogue of TCP.
- `SOCK_DGRAM` — **reliable** and ordered here (unlike UDP), message-boundary preserving, no loss unless the receive queue overflows.
- `SOCK_SEQPACKET` — reliable, ordered, connection-oriented, **and** boundary-preserving. The best default for message protocols.

**Addressing.** `struct sockaddr_un` has a `sun_path[108]` — a filesystem path whose permissions govern access (on Linux; not on all BSDs). A leading NUL byte selects the **abstract namespace**: the name lives in a kernel table, has no filesystem entry, disappears automatically when the last reference closes, and therefore has **no permission checks** beyond network namespace membership. Convenient for containers, a security hazard on a shared host.

**Two capabilities no other IPC gives you**, both via `sendmsg`/`recvmsg` ancillary data (Ch. 45 §45.14):

```c
// 1. Descriptor passing — the receiving process gets a NEW fd to the SAME open file description
cmsg->cmsg_level = SOL_SOCKET;  cmsg->cmsg_type = SCM_RIGHTS;
memcpy(CMSG_DATA(cmsg), &fd, sizeof fd);

// 2. Peer credentials — kernel-verified pid/uid/gid, unforgeable
SO_PEERCRED (getsockopt) or SCM_CREDENTIALS (per-message)
```

`SCM_RIGHTS` is how privilege-separated daemons hand a listening socket or a `memfd` to an unprivileged worker, and how a supervisor implements zero-downtime restarts. Two traps: fds in flight are held by the kernel, so a socket buffer full of unreceived `SCM_RIGHTS` messages **leaks descriptors** (there is a garbage collector for cycles precisely because of this); and if the receiver's `msg_control` buffer is too small the fds are **closed and `MSG_CTRUNC` is set** — silently losing them if you do not check.

**Cost.** A stream `send`+`recv` pair is two syscalls plus two copies, no protocol processing. Round-trip request/response on the same NUMA node:

| Path | Typical RTT (x86-64 Linux) |
|---|---|
| AF_UNIX stream, blocking, cross-core | **8–15 µs** (dominated by two wakeups) |
| AF_UNIX stream, both ends busy-polling | **2–4 µs** |
| TCP over loopback | **10–25 µs** (full stack, checksums, netfilter) |
| Shared-memory SPSC ring, busy-polled | **0.1–0.3 µs** |

AF_UNIX beats loopback TCP by roughly 2× because it skips the entire IP/TCP stack; both lose to shared memory by 20–100×. Use AF_UNIX for control planes, credential-checked service APIs, and fd passing — its unique features — not for throughput.

---

## 33.4 POSIX and System V Shared Memory

Shared memory is the only IPC mechanism with **zero per-message kernel involvement**: after setup, a write by one process is visible to another via the cache-coherence protocol at the cost of a cache-line transfer (~40–100 ns cross-core, Ch. 28), not a syscall.

**POSIX (`shm_open` + `mmap`)** — the modern choice:

```c
int fd = shm_open("/md_ring", O_CREAT|O_RDWR, 0600);   // lives in tmpfs at /dev/shm
ftruncate(fd, SIZE);                                    // MUST size before mapping
void* p = mmap(NULL, SIZE, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
close(fd);                                              // mapping keeps the object alive
// ... shm_unlink("/md_ring") removes the name; memory freed at last unmap
```

Because the backing store is tmpfs, `/dev/shm` segments are ordinary files: inspectable with `ls`, sizeable, and subject to the tmpfs size limit (default half of RAM). `MAP_HUGETLB` or placing the file on `hugetlbfs` backs the segment with 2 MiB pages, which for a multi-gigabyte order book is the difference between constant TLB misses and none (Ch. 32 §32.10).

**System V (`shmget`/`shmat`/`shmdt`/`shmctl`)** — `key_t`-addressed, `SHMMAX`-limited (historically a painfully low default), persists past process exit, and requires `ipcrm` cleanup. Its one surviving advantage is `SHM_HUGETLB` plus an install base of legacy code. `shmctl(IPC_RMID)` marks for destruction but the segment survives while attached — the reason `ipcs -m` shows segments with `nattch > 0` and the `dest` flag.

**memfd.** `memfd_create("ring", MFD_CLOEXEC | MFD_ALLOW_SEALING)` gives an anonymous, name-free shared-memory file passed to peers via `SCM_RIGHTS` (§33.3). **Sealing** (`F_SEAL_SHRINK`, `F_SEAL_GROW`, `F_SEAL_WRITE`) lets a receiver verify the sender cannot shrink the file underneath it — which is exactly the defence against the SIGBUS attack described below.

**The hazards, all specific to shared memory:**

1. **No pointers.** The segment can map at different virtual addresses in each process. Store offsets or indices, never `T*`. Anything with a vtable, `std::string`, or a heap-allocating container is disqualified (Ch. 3 §3.12).
2. **`MAP_FIXED` is fragile.** Mapping both sides at a fixed address makes pointers work but collides with ASLR and any library mapping. Prefer offsets.
3. **Truncation → SIGBUS.** Accessing a mapped page beyond the file's current size raises `SIGBUS`, not `SIGSEGV`. A malicious or buggy peer calling `ftruncate` smaller turns every reader load into a fatal fault (Ch. 32 §32.27). Seal the fd or never shrink.
4. **`std::atomic<T>` must be `is_always_lock_free`.** Otherwise libstdc++ uses a **process-local** lock table and you get no cross-process atomicity at all — silent, catastrophic. `static_assert(std::atomic<T>::is_always_lock_free);` is mandatory.
5. **First touch decides NUMA placement.** Whichever process faults a page in owns its physical node (Ch. 29 §29.18). Pre-fault the segment from the process that will read it hottest, or set an explicit `mbind` policy.
6. **Crash consistency.** A process that dies holding a shared mutex leaves it locked forever unless the mutex is robust (§33.5).

---

## 33.5 Process-Shared Synchronization

A pthreads synchronization object placed in shared memory does **not** work by default: the default `PTHREAD_PROCESS_PRIVATE` attribute permits the implementation to store process-local data (addresses, thread IDs) inside it. You must opt in.

```c
pthread_mutexattr_t ma;
pthread_mutexattr_init(&ma);
pthread_mutexattr_setpshared(&ma, PTHREAD_PROCESS_SHARED);   // required
pthread_mutexattr_setrobust(&ma, PTHREAD_MUTEX_ROBUST);      // survive owner death
pthread_mutexattr_setprotocol(&ma, PTHREAD_PRIO_INHERIT);    // avoid priority inversion
pthread_mutex_init(shm_ptr->mtx, &ma);                        // object lives IN the segment
```

The same `setpshared` exists for `pthread_cond_t`, `pthread_rwlock_t`, `pthread_barrier_t`, and `sem_t` (via `sem_init(sem, /*pshared=*/1, val)`). On Linux the implementation is a futex (§33.7) on a word inside the shared page, so the mechanism works across address spaces naturally; the attribute mainly disables optimizations that would cache process-local state.

**Robust mutexes** are the answer to the hardest problem in cross-process locking: the holder crashing mid-critical-section. With `PTHREAD_MUTEX_ROBUST`, the kernel walks the dead task's robust futex list and marks the lock; the next `pthread_mutex_lock` returns **`EOWNERDEAD`**. The new owner then holds the lock but must repair whatever invariant was broken and call `pthread_mutex_consistent()`; if it instead unlocks without doing so, the mutex becomes permanently **`ENOTRECOVERABLE`** for everyone. Code that ignores `EOWNERDEAD` — treating a non-zero return as generic failure — is the common bug, and the diagnostic signature is a process that deadlocks only after a peer segfaults.

**Priority inheritance** matters when a `SCHED_FIFO` trading thread and a `SCHED_OTHER` housekeeping process share a lock: without PI, the low-priority holder can be preempted indefinitely and the RT thread blocks forever (unbounded priority inversion, Ch. 24 §24.18). `PTHREAD_PRIO_INHERIT` makes the kernel temporarily boost the holder. The cost is that lock/unlock take the slow futex path (`FUTEX_LOCK_PI`) more often.

**The low-latency verdict.** All of the above is correct and all of it is too slow for a hot path, because contention means a futex syscall and a wakeup — **1–5 µs**. The standard HFT design instead uses:

- A **single-writer** shared-memory ring with `std::atomic<uint64_t>` sequence counters and acquire/release ordering (Ch. 25, Ch. 26 §26.3). No lock, no syscall, no cross-process ownership problem.
- A **seqlock** for a small mutable snapshot (a book top-of-book, a risk limit table): the writer bumps an even/odd counter around the update, readers retry if the counter changed or is odd (Ch. 26 §26.9). Wait-free for the writer, no writer-side syscall ever.

Both degrade safely on peer death: a crashed writer simply stops advancing a sequence number, which a reader detects as staleness rather than as a permanent deadlock. That property — *no shared mutable lock state that can be left inconsistent* — is the real argument for lock-free interprocess design, and it is a stronger interview answer than raw latency.

---

## 33.6 POSIX and System V Semaphores

A **semaphore** is a counter with atomic decrement-and-block (`wait`/`P`) and increment-and-wake (`post`/`V`). Unlike a mutex it has no owner, so it may be posted by a different process or thread than the one that waited — which makes it the correct primitive for signalling and for counting resources, and the wrong one for mutual exclusion (no ownership means no priority inheritance, no robustness, no deadlock detection).

**POSIX semaphores** come in two flavours:

```c
// Named: kernel-persistent, visible in /dev/shm as sem.NAME
sem_t* s = sem_open("/orders", O_CREAT, 0600, 0);
// Unnamed: lives in memory YOU provide — put it in a shared segment for IPC
sem_init(&shm->sem, /*pshared=*/1, /*value=*/0);

sem_wait(s); sem_trywait(s); sem_timedwait(s, &abs_ts);   // abs deadline, CLOCK_REALTIME
sem_post(s);                                               // async-signal-safe (§33.15)
sem_getvalue(s, &v);                                       // snapshot, immediately stale
```

The **fast path is entirely in user space**: `sem_post` on a semaphore with no waiters, and `sem_wait` on a positive counter, are a single atomic RMW — roughly **15–25 ns**. Only the blocking path enters the kernel via `futex(FUTEX_WAIT)`. This is why glibc semaphores are dramatically cheaper than System V ones under low contention.

`sem_post` is one of the very few functions that is **async-signal-safe**, making it the canonical way for a signal handler to wake a worker thread — though `write()` to an `eventfd` (§33.8) is usually better because it integrates with an event loop.

**System V semaphores** (`semget`/`semop`/`semctl`) are a different animal: an *array* of semaphores operated on by a vector of `struct sembuf` operations applied **atomically as a group**. That group-atomicity is genuinely unique — you can decrement three counters or none, avoiding a class of deadlocks. They also support `SEM_UNDO`, which makes the kernel reverse a process's semaphore adjustments if it dies, a crude robustness mechanism.

| | POSIX unnamed | POSIX named | System V |
|---|---|---|---|
| Uncontended cost | ~20 ns (user-space atomic) | ~20 ns | **~1 µs — always a syscall** |
| Storage | Caller-provided (shared mem) | `/dev/shm` | Kernel, `key_t` |
| Multi-op atomicity | No | No | **Yes (`semop` vector)** |
| Death recovery | None | None | `SEM_UNDO` |
| Pollable | No | No | No |
| Cleanup | With the memory | `sem_unlink` | `ipcrm`; **leaks** |

Neither is pollable, which is the recurring theme of the old SysV API and the reason `eventfd` exists.

**Traps.** `sem_wait` returns `-1`/`EINTR` when interrupted by a signal — always loop (§33.20 of Ch. 34; here: `while (sem_wait(s) == -1 && errno == EINTR);`). `sem_timedwait` uses `CLOCK_REALTIME`, so an NTP step (Ch. 35 §35.9) can lengthen or shorten your timeout; glibc offers `sem_clockwait` with `CLOCK_MONOTONIC` and it should be preferred. And a named semaphore's *value* persists across process restarts — a crashed process that had decremented but not posted leaves the count permanently low, presenting as a system that works after boot and hangs after a restart.

---

## 33.7 Futexes

The **futex** (*fast userspace mutex*) is the primitive underneath essentially every Linux synchronization object: pthread mutexes, condition variables, semaphores, `std::atomic::wait`, Java monitors, Go's runtime parking. Understanding it explains why uncontended locks are ~20 ns and contended ones are ~2 µs.

**The design principle:** keep the lock state in a user-space 32-bit word, and only enter the kernel when a thread actually has to sleep or wake someone.

```c
// The two core operations (via syscall(SYS_futex, ...); no glibc wrapper historically)
futex(&word, FUTEX_WAIT, expected, timeout, NULL, 0);
    // Atomically: IF *word == expected, sleep. Else return EAGAIN immediately.
futex(&word, FUTEX_WAKE, n, NULL, NULL, 0);
    // Wake up to n waiters queued on this address. Returns the number woken.
```

The compare-then-sleep must be atomic **inside the kernel** — that is the entire trick. Without it, the classic lost-wakeup race exists: the waiter reads the word, decides to sleep, and is preempted; the waker changes the word and calls `FUTEX_WAKE` with nobody queued; the waiter then sleeps forever. The kernel takes the hash-bucket lock covering the futex address, re-reads the word, and enqueues only if the value still matches.

**A minimal mutex:**

```cpp
std::atomic<uint32_t> state{0};   // 0=free, 1=locked, 2=locked-with-waiters
void lock() {
    uint32_t c = 0;
    if (state.compare_exchange_strong(c, 1)) return;      // fast path: ONE atomic, ~20 ns
    do {
        if (c == 2 || !state.compare_exchange_strong(c, 2))
            futex_wait(&state, 2);                        // slow path: syscall
        c = 0;
    } while (!state.compare_exchange_strong(c, 2));
}
void unlock() {
    if (state.fetch_sub(1) != 1) { state.store(0); futex_wake(&state, 1); }
}
```

The three-state encoding is the point: state 2 records "there may be waiters," so `unlock` can skip the `FUTEX_WAKE` syscall entirely in the uncontended case. This is Drepper's design and it is what libstdc++/glibc implement.

**Kernel side.** Futex addresses are hashed into a global table of buckets (`futex_hash_bucket`). For a `MAP_PRIVATE` mapping the key is (mm, virtual address); for `MAP_SHARED` it is (inode, page offset) — which is precisely what makes futexes work **across processes** on the same physical page mapped at different virtual addresses. `FUTEX_PRIVATE_FLAG` tells the kernel the futex is process-local, skipping the more expensive shared-key derivation and the mmap semaphore; glibc sets it automatically for non-pshared objects, and it is worth a measurable fraction of the slow-path cost.

**Important operation variants:**

| Op | Purpose |
|---|---|
| `FUTEX_WAIT` / `FUTEX_WAKE` | The basic pair; `WAIT` uses a **relative** `CLOCK_MONOTONIC` timeout |
| `FUTEX_WAIT_BITSET` | Absolute timeout, and selective wakeup by mask (used for rwlocks) |
| `FUTEX_REQUEUE` / `FUTEX_CMP_REQUEUE` | Move waiters from one futex to another **without waking them** — the fix for the condition-variable *thundering herd*: `pthread_cond_broadcast` requeues waiters onto the mutex instead of waking N threads that immediately contend |
| `FUTEX_WAKE_OP` | Wake plus a conditional atomic op on a second word, in one syscall |
| `FUTEX_LOCK_PI` / `UNLOCK_PI` | Priority-inheritance mutexes (§33.5); the kernel tracks the owner TID in the word |
| `FUTEX_WAIT_MULTIPLE` / `futex_waitv` (5.16+) | Wait on several futexes at once |

**Costs (typical modern x86-64 Linux server).** Uncontended lock/unlock: **~20 ns** (one or two atomic RMWs, no syscall). Contended lock that sleeps and is woken: **~1.5–5 µs**, of which the syscalls are ~150 ns and the rest is scheduler wakeup and context-switch cost, plus a cold cache on the waking core. That ~100× cliff is why `std::mutex` on a hot path is acceptable only if it is truly uncontended, and why spin-then-park (Ch. 24 §24.15) exists: spinning for a few hundred nanoseconds is strictly cheaper than a park/unpark pair if the critical section is short.

**Diagnostic signature.** `perf stat -e syscalls:sys_enter_futex` or `strace -c -f` showing a high futex count means you are hitting the slow path; a hot path with a nonzero futex rate has a contention problem. `perf record` on a contended futex workload shows time in `futex_wait_queue_me` and `schedule`.

---

## 33.8 eventfd

`eventfd` is a **file descriptor wrapping a 64-bit kernel counter** — the minimal, pollable notification primitive, and the correct replacement for the self-pipe trick.

```c
int efd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
uint64_t one = 1;
write(efd, &one, 8);          // counter += 1;  becomes readable
uint64_t v;
read(efd, &v, 8);             // returns accumulated count, resets counter to 0
```

Reads and writes must be exactly **8 bytes** or fail with `EINVAL`. The fd is readable whenever the counter is nonzero and writable whenever adding would not overflow `UINT64_MAX - 1`; a write that would overflow blocks, or returns `EAGAIN`.

**`EFD_SEMAPHORE`** changes the read semantics: instead of draining the whole counter, each read returns 1 and decrements by 1 — turning the object into a pollable counting semaphore, which is exactly what a work-queue wakeup wants when you need one wakeup per item.

**Why it beats a pipe** for the same job:

| | Self-pipe | eventfd |
|---|---|---|
| Descriptors consumed | 2 | **1** |
| Kernel memory | 64 KiB ring | **one 64-bit counter** |
| Coalescing | Manual (drain loop) | **Automatic** — N writes = one readable event |
| Overflow | Buffer fills, writer blocks | Counter saturates at 2⁶⁴−2 |
| Cost per notify | ~1 µs (copy + ring bookkeeping) | **~0.5–1 µs** |

Automatic coalescing is the substantive win: a burst of 10,000 notifications produces one epoll wakeup and one read returning 10000, whereas a pipe requires draining 10,000 bytes and can fill.

**`EFD_NONBLOCK` is essentially mandatory** in an event loop. With level-triggered epoll and a blocking eventfd, a spurious wakeup followed by a read blocks the entire loop.

**Kernel-adjacent uses worth naming:** `eventfd` is the notification mechanism for KVM ioeventfd/irqfd, for `io_uring` completion notification (`IORING_REGISTER_EVENTFD`, §34.22), and for AIO (`io_setup` + `IOCB_FLAG_RESFD`). Any time a kernel subsystem needs to say "something happened" into an epoll loop, it uses an eventfd.

**Low-latency framing.** An eventfd notification is still a syscall on each side plus a wakeup — **1–3 µs** end-to-end if the reader is sleeping in `epoll_wait`. A busy-polling hot thread should never be woken by an eventfd; it should poll a shared-memory sequence number. The correct architecture uses eventfd for the *cold* path (a slow consumer that would otherwise burn a core) and shared memory for the hot one, with a hybrid "spin for N microseconds, then arm the eventfd and block" policy for medium-rate consumers. Getting that hybrid right — and being able to say why the crossover point is where the cost of a wakeup (~2 µs) equals the cost of spinning for the expected idle interval — is the interview-grade answer.

---

## 33.9 signalfd

`signalfd` converts asynchronous signal delivery into **synchronous, pollable file-descriptor reads**, eliminating essentially every hazard of §33.15 (async-signal safety).

```c
sigset_t mask;
sigemptyset(&mask); sigaddset(&mask, SIGTERM); sigaddset(&mask, SIGINT);
sigprocmask(SIG_BLOCK, &mask, NULL);        // MANDATORY — and in EVERY thread
int sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);

struct signalfd_siginfo si;
read(sfd, &si, sizeof si);                  // si.ssi_signo, ssi_pid, ssi_uid, ssi_code, ssi_fd...
```

**The block step is not optional and is the number-one bug.** `signalfd` reads signals from the *pending* set; a signal is only pending if it is blocked. If you forget `sigprocmask`, the default disposition runs and your process dies — intermittently, because there is a race window. Since the signal mask is per-thread and inherited across `pthread_create`, the idiom is: block the mask in `main()` **before** creating any threads.

**What you get in `signalfd_siginfo`:** the full `siginfo_t` content flattened into a fixed-layout 128-byte structure — signal number, sending PID and UID, `si_code`, the exit status for `SIGCHLD`, the faulting address for `SIGSEGV`, and `ssi_int`/`ssi_ptr` for `sigqueue` payloads. That means you can handle `SIGCHLD` reaping and even inspect fault addresses from ordinary code with no async-signal-safety constraint whatsoever — you may `malloc`, take locks, log, and call anything you like.

**The critical limitation:** signalfd works only for signals you can afford to *block*. **Synchronous, thread-directed fault signals — `SIGSEGV`, `SIGBUS`, `SIGFPE`, `SIGILL` — cannot usefully be handled this way.** They are generated by the faulting instruction itself; if blocked, the kernel forces the default action (kill + core) rather than queuing them, because returning to the faulting instruction would loop forever. So signalfd covers `SIGTERM`, `SIGINT`, `SIGHUP`, `SIGCHLD`, `SIGUSR1/2`, `SIGALRM`, `SIGPIPE`, and timer signals; crash handling still requires `sigaction` with an alternate stack (§33.16–33.17).

**Coalescing.** Standard (non-realtime) signals do not queue: three `SIGTERM`s while blocked produce **one** read. Realtime signals (`SIGRTMIN..SIGRTMAX`) do queue, up to `RLIMIT_SIGPENDING`. This mirrors the pending-set bitmask semantics of §33.12 exactly — signalfd changes the delivery channel, not the queuing model.

| | `sigaction` handler | `signalfd` |
|---|---|---|
| Execution context | Interrupts arbitrary code | Ordinary read in your loop |
| Safety constraint | Async-signal-safe only | **None** |
| Works for `SIGSEGV`/`SIGBUS` | **Yes** | No |
| Integrates with epoll | Via self-pipe/eventfd | **Natively** |
| Interrupts a blocking syscall | Yes (`EINTR`) | No |
| Per-thread targeting | Whichever thread has it unblocked | Whichever thread reads |

**Cost:** a `read()` on a signalfd is ~200–400 ns; the signal itself still costs the sender a `kill()` syscall and the receiver a wakeup, so end-to-end notification is **2–5 µs**. Signals are a control-plane mechanism; nothing on a trading hot path should depend on them.

---

## 33.10 timerfd

`timerfd` exposes a POSIX timer as a **readable file descriptor**, giving an event loop timeouts on the same footing as I/O readiness and with a choice of clock.

```c
int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
struct itimerspec its = {
    .it_value    = { .tv_sec = 0, .tv_nsec = 500'000 },   // first expiry: 500 µs from now
    .it_interval = { .tv_sec = 1, .tv_nsec = 0 }          // then every 1 s; {0,0} = one-shot
};
timerfd_settime(tfd, 0, &its, NULL);                       // flags=0 → RELATIVE
uint64_t expirations;
read(tfd, &expirations, 8);                                // count of expiries since last read
```

**Absolute vs relative** is the detail that matters. Flag `TFD_TIMER_ABSTIME` interprets `it_value` as an absolute time on the chosen clock. A periodic task built from relative timers **accumulates drift**, because each rearm starts from "now," which is already late by the wakeup latency. Absolute deadlines computed as `base + n*period` do not drift. Alternatively use `it_interval`, which the kernel rearms internally from the scheduled expiry, not from the delivery time.

**Clock choice.**

- `CLOCK_MONOTONIC` — never steps, never goes backwards; the default for timeouts and periodic work.
- `CLOCK_REALTIME` — follows wall clock; an NTP step or `settimeofday` shifts your deadline (Ch. 35 §35.9). Use only when the deadline is a wall-clock event ("at 09:30:00 exchange open").
- `CLOCK_BOOTTIME` — like monotonic but includes suspend time.
- `TFD_TIMER_CANCEL_ON_SET` with an absolute `CLOCK_REALTIME` timer: a discontinuous clock change makes the read return **`ECANCELED`**, so you can recompute. This is exactly how a system that must fire at a wall-clock instant survives an NTP step, and it is a strong detail to know.

**Read semantics.** The 8-byte read returns the number of expirations since the last read and resets it to zero; if the timer has not expired, a blocking read waits and a non-blocking one returns `EAGAIN`. A returned value **greater than 1 means you missed deadlines** — this is a free, built-in overrun counter and the standard way to detect that your loop is falling behind.

**Resolution and jitter.** Timer expiry is delivered by the high-resolution timer subsystem (`hrtimer`), programmed into the local APIC timer or TSC-deadline timer. The nominal resolution is nanoseconds, but the *achieved* accuracy on a normally-configured server is **50–200 µs** of jitter under load; on a tuned box (isolated core, `SCHED_FIFO`, C-states limited to C1, no THP compaction) it drops to **2–20 µs**. Deep C-states are typically the largest single contributor — an exit from C6 costs tens of microseconds (Ch. 35 §35.13). Practical floor for a `timerfd` wakeup on a well-tuned system is around **10 µs**; anything requiring finer granularity must busy-wait on `rdtsc` (Ch. 35 §35.3), not sleep.

**Comparison to the alternatives:**

| Facility | Delivery | Pollable | Per-process limit |
|---|---|---|---|
| `alarm` / `setitimer` | Signal | No | One of each type |
| POSIX `timer_create` | Signal or thread | No | `RLIMIT_SIGPENDING` |
| **`timerfd`** | fd readable | **Yes** | fd limit |
| `epoll_wait` timeout | Return value | n/a | 1 ms granularity (pre-`epoll_pwait2`) |
| `clock_nanosleep(ABSTIME)` | Return from sleep | No | n/a |

`epoll_wait`'s millisecond timeout argument is why timerfd is used at all in modern loops; `epoll_pwait2` (5.11+) finally takes a `timespec` and gives nanosecond granularity, but timerfd remains cleaner for multiple independent deadlines.

---

## 33.11 Lock-Free Interprocess Queues

This is the mechanism that actually carries market data between processes in a low-latency system: a bounded ring buffer in a `MAP_SHARED` segment, coordinated by atomics, with **no kernel involvement per message**.

**The single-producer/single-consumer ring** (Ch. 26 §26.3, here specialized to processes):

```cpp
struct alignas(64) Ring {                       // placed at offset 0 of the shm segment
    std::atomic<uint64_t> write_seq;            // producer-owned cache line
    char pad0[64 - sizeof(std::atomic<uint64_t>)];
    std::atomic<uint64_t> read_seq;             // consumer-owned cache line
    char pad1[64 - sizeof(std::atomic<uint64_t>)];
    uint64_t capacity;                          // power of two
    Slot slots[];                               // flexible array; Slot is trivially copyable
};
static_assert(std::atomic<uint64_t>::is_always_lock_free);   // MANDATORY for cross-process

// Producer
uint64_t w = ring->write_seq.load(std::memory_order_relaxed);
if (w - ring->read_seq.load(std::memory_order_acquire) == capacity) return FULL;
ring->slots[w & (capacity - 1)] = msg;                       // payload store
ring->write_seq.store(w + 1, std::memory_order_release);     // PUBLISH — release orders the payload
```

The release store on `write_seq` and the acquire load on the consumer side are what make the payload visible; on x86-64 both compile to plain `mov` (TSO gives you acquire/release for free, Ch. 29 §29.13), so the publish costs **one store**, and the consumer's first read of a new cache line costs a cross-core transfer of **~40–80 ns** on the same socket, **~150–300 ns** across sockets.

**The cache-line padding is not decoration.** Without it, `write_seq` and `read_seq` share a line, and every producer publish invalidates the consumer's copy of the line it is polling — false sharing that turns a 40 ns handoff into a 200 ns one and destroys throughput (Ch. 26 §26.16).

**The Disruptor variant (broadcast to N processes)** is the standard market-data fan-out: one writer, a monotonically increasing sequence, and each reader keeping its *own* cursor. Readers never write to shared state on the fast path, so adding a reader costs the writer nothing. Slow readers are detected by `write_seq - reader_seq > capacity` and are **overwritten**, not blocked — the correct policy for market data, where a slow consumer should be dropped and forced to re-snapshot rather than be allowed to back-pressure the feed (Ch. 53 §53.4). A reader that detects it was lapped must discard and resynchronize, which requires a per-slot sequence stamp so it can tell a stale slot from a fresh one:

```cpp
// Per-slot sequence enables torn-read detection under overwrite (seqlock per slot)
uint64_t s1 = slot.seq.load(acquire);
if (s1 != expected || (s1 & 1)) return STALE;
copy_out(slot.payload);
if (slot.seq.load(acquire) != s1) return TORN;   // writer lapped us mid-copy
```

**MPSC/MPMC across processes** requires a `fetch_add` on the write sequence (a `lock xadd`, ~20 ns uncontended, degrading badly under contention as the line bounces) and a per-slot ready flag, because slot *n* may be filled after slot *n+1*. Contention across processes is worse than across threads only because processes are more likely to be on different NUMA nodes; the coherence cost is identical otherwise.

**Interprocess-specific hazards, none of which exist for the intra-process version:**

1. **No pointers in slots.** Offsets or fixed-size inline payloads only (§33.4).
2. **A crashed producer** leaves `write_seq` frozen. Consumers must detect staleness by timeout, not by liveness of a lock. This is the design's biggest advantage over a shared mutex.
3. **A crashed consumer** in a bounded SPSC ring stops advancing `read_seq` and blocks the producer forever — hence the overwrite policy above, or a heartbeat and forced deregistration.
4. **Mismatched builds.** Both sides must agree on `sizeof(Slot)`, offsets, and alignment; a version field plus `static_assert`s on layout (Ch. 3 §3.12) is the defence, and a mismatch presents as garbage payloads rather than a clean error.
5. **Huge pages.** A multi-megabyte ring on 4 KiB pages costs a TLB miss (~100 ns page walk) on a meaningful fraction of accesses; back the segment with 2 MiB pages.

**Measured comparison, same-host message handoff:**

| Mechanism | One-way latency | Syscalls/msg |
|---|---|---|
| Shared-memory ring, busy-polled | **~100–300 ns** | 0 |
| Shared-memory ring + futex wake when idle | ~2 µs when parked | 0 or 2 |
| eventfd notification | ~1–3 µs | 2 |
| UNIX socket | ~4–8 µs | 2 |
| Pipe | ~5–10 µs | 2 |
| Loopback TCP | ~10–25 µs | 2 |

The busy-polled ring costs you a dedicated core. That is the trade: one core burned per consumer for a 20–50× latency reduction, which in an HFT context is trivially worth it and in a general server is usually not.

---

## 33.12 Signal Delivery and Disposition

A **signal** is a software interrupt: a per-process (or per-thread) asynchronous notification with a number, a disposition, and — for realtime signals — an optional payload.

**Generation → pending → delivery.** Signals pass through three states, and conflating them causes most signal bugs.

```
generate         : kill(), raise(), hardware fault, kernel event (SIGCHLD, SIGPIPE)
      ↓
pending set      : a per-task BITMASK for signals 1..31 (so DUPLICATES ARE LOST),
                   plus a real QUEUE for SIGRTMIN..SIGRTMAX (bounded by RLIMIT_SIGPENDING)
      ↓  (blocked signals stay here indefinitely — §33.14)
delivery         : on return to user mode, the kernel picks a pending unblocked signal
                   and performs the disposition
```

Because signals 1–31 live in a bitmask, **standard signals do not queue**: 1000 rapid `SIGCHLD`s while blocked yield exactly one delivery. Any `SIGCHLD` handler must therefore loop `while (waitpid(-1, &st, WNOHANG) > 0)` — the single most common signal bug in real daemons, presenting as accumulating zombie processes (Ch. 31 §31.5).

**Dispositions** are per-process: `SIG_DFL`, `SIG_IGN`, or a handler. Default actions are Term, Ign, Core, Stop, or Cont. `SIGKILL` (9) and `SIGSTOP` (19) can be neither caught, blocked, nor ignored — the kernel's guaranteed control channel.

**Thread targeting** (the part interviewers probe):

| Origin | Delivered to |
|---|---|
| Synchronous fault (`SIGSEGV`, `SIGFPE`, `SIGBUS`, `SIGILL`) | **The offending thread**, always |
| `pthread_kill(tid, sig)` / `tgkill` | That specific thread |
| `kill(pid, sig)` / terminal / `SIGCHLD` | **Any one thread** that does not have it blocked — *arbitrarily chosen* |

Handlers, however, are **process-wide**: there is one disposition table per process, so a handler installed by any thread runs for all. The standard idiom follows directly: block all process-directed signals in `main()` before spawning threads, then either dedicate one thread to `sigwaitinfo`/`sigwait` or use `signalfd` (§33.9). Ad-hoc handling means the signal lands on an arbitrary thread — possibly your latency-critical one — and interrupts it.

**Interruption of syscalls.** Delivering a signal to a thread blocked in a syscall either aborts it with `EINTR` or restarts it, depending on `SA_RESTART` and the syscall (§33.20 in Ch. 34). Some calls — notably `poll`, `select`, `epoll_wait`, `nanosleep`, `sem_wait`, and any syscall with a timeout — are **never** restarted even with `SA_RESTART`, because the kernel cannot correctly resume a partially-elapsed timeout.

**Cost.** Delivering a caught signal is expensive: the kernel builds a signal frame on the user stack (saving the full register set plus, on x86-64 with AVX-512, up to ~2.5 KiB of `xsave` state), transfers to the handler, and the handler returns via a `rt_sigreturn` syscall that restores everything. Typical measured cost is **1.5–4 µs** per delivery for the receiver, plus ~1 µs for the sender's `kill()`. `sigreturn` alone is a full syscall. This is why signals are unusable as a high-rate IPC mechanism and why the correct answer to "how would you notify a process 100k times per second?" is never "signals."

---

## 33.13 `sigaction`

`sigaction()` is the only correct way to install a handler. `signal()` is specified with **implementation-defined semantics** — historically System V reset the disposition to `SIG_DFL` on entry to the handler (creating a race where a second signal kills you) and did not block the signal during its own handler; BSD did the opposite. glibc's `signal()` gives BSD semantics, but portable and reviewable code uses `sigaction` unconditionally.

```c
struct sigaction sa;
memset(&sa, 0, sizeof sa);              // zero FIRST — sa_mask is opaque
sa.sa_sigaction = handler;              // 3-arg form; union with sa_handler
sigemptyset(&sa.sa_mask);
sigaddset(&sa.sa_mask, SIGTERM);        // additionally blocked DURING the handler
sa.sa_flags = SA_SIGINFO | SA_RESTART | SA_ONSTACK;
sigaction(SIGSEGV, &sa, NULL);

void handler(int sig, siginfo_t* info, void* ucontext);
```

**Key flags:**

| Flag | Effect |
|---|---|
| `SA_SIGINFO` | Use the 3-argument handler; gives `siginfo_t` and the `ucontext_t` |
| `SA_RESTART` | Auto-restart interruptible syscalls (but not timeout-bearing ones) |
| `SA_ONSTACK` | Run on the alternate signal stack (§33.16) — **required** for `SIGSEGV` stack-overflow handling |
| `SA_NODEFER` | Do *not* block this signal during its own handler — makes the handler reentrant on itself; almost always a bug |
| `SA_RESETHAND` | Reset to `SIG_DFL` on entry — the old System V behaviour, used deliberately in crash handlers so a fault inside the handler dies cleanly |
| `SA_NOCLDWAIT` | Children are auto-reaped, never become zombies |
| `SA_NOCLDSTOP` | No `SIGCHLD` on child stop/continue, only on exit |

**The implicit mask.** During the handler, the signal being handled is blocked automatically (unless `SA_NODEFER`), plus everything in `sa_mask`. The previous mask is restored by `sigreturn`. Consequence: a second instance of the same signal arriving during the handler is merely marked pending and delivered once on return — coalesced, per §33.12.

**`siginfo_t` is where the real information lives:**

```c
info->si_signo, si_code;                  // si_code disambiguates the CAUSE
info->si_pid, si_uid;                     // SI_USER: who sent it
info->si_addr;                            // SIGSEGV/SIGBUS: the FAULTING ADDRESS
info->si_addr_lsb;                        // SIGBUS BUS_MCEERR_*: page size of the failure
info->si_status;                          // SIGCHLD: exit status
info->si_value;                           // sigqueue() payload (int or pointer)
info->si_fd, si_band;                     // SIGIO
```

`si_code` distinguishes `SEGV_MAPERR` (address not mapped) from `SEGV_ACCERR` (mapped but permission denied) — the difference between a null/wild pointer and a write to a read-only or guard page, and the first thing a crash handler should record. For `SIGBUS`, `BUS_ADRALN` means misalignment while `BUS_ADRERR` typically means the shared-memory-truncation case of §33.4.

The third argument, `ucontext_t*`, contains the full saved register set at the point of the fault (`uc_mcontext.gregs[REG_RIP]`, `REG_RSP`, …). A crash handler can read RIP and RSP from it to produce a correct backtrace even when frame pointers are absent, and — the sharp trick — can **modify** them, so that returning from the handler resumes at a different instruction. That is how userfaultfd-free software emulation, JIT deoptimization, and "skip the faulting instruction" recovery are implemented. It is also how a stack-overflow handler can hand control to a safe path rather than returning to the faulting frame.

---

## 33.14 Signal Masks

The **signal mask** is a per-thread set of blocked signals. Blocked ≠ ignored: a blocked signal stays *pending* and is delivered the moment it is unblocked. Ignored signals are discarded on generation.

```c
sigset_t set, old;
sigemptyset(&set); sigaddset(&set, SIGTERM);
pthread_sigmask(SIG_BLOCK, &set, &old);      // ALWAYS this in threaded programs
// sigprocmask() is UNSPECIFIED in a multithreaded process — use pthread_sigmask
```

`SIG_BLOCK` unions, `SIG_UNBLOCK` subtracts, `SIG_SETMASK` replaces. The mask is **inherited** across `pthread_create` (from the creating thread) and across `fork` (child copies the parent), and **preserved across `execve`** — which is a real bug source: a process that spawns a child while a signal is blocked leaves it blocked in the exec'd program, and the classic symptom is a child that ignores Ctrl-C or cannot be terminated by `SIGTERM`. Reset the mask to empty between `fork` and `exec`. (Pending signals, by contrast, are cleared on both `fork` in the child and on `exec`.)

**The self-pipe / sigsuspend race.** The reason `pselect`, `ppoll`, `epoll_pwait`, and `sigsuspend` exist:

```c
// BROKEN — race between the check and the sleep
if (!got_signal) poll(fds, n, -1);      // signal arriving HERE is lost until the next event

// CORRECT — atomic unmask-and-sleep
sigset_t empty; sigemptyset(&empty);
ppoll(fds, n, &timeout, &empty);        // unblocks, sleeps, reblocks — ATOMICALLY
```

The kernel performs the mask swap and the sleep as one operation, closing the window. This is the canonical "why does `pselect` exist?" answer and it is the same lost-wakeup structure as the futex compare-and-sleep of §33.7 — a general pattern worth naming explicitly in an interview.

**Related inspection and synchronous consumption:**

```c
sigpending(&set);                              // which signals are pending (blocked) right now
sigwait(&set, &signo);                         // block until one arrives; consume it, no handler
sigwaitinfo(&set, &info);                      // same, plus siginfo_t
sigtimedwait(&set, &info, &timeout);           // with a deadline
```

`sigwait` on a dedicated thread is the POSIX-portable version of the signalfd design: block everything in `main`, spawn a signal thread that loops on `sigwait`, and handle signals as ordinary code with no async-signal-safety constraint. On Linux `signalfd` is strictly nicer because it plugs into epoll, but `sigwait` is what you name if the question specifies portability.

**Low-latency relevance.** A hot thread should have every catchable signal blocked, for two reasons: a delivered signal costs 1.5–4 µs and, worse, it can interrupt a syscall and force `EINTR` handling in a path that assumed none. Block the full set on the hot thread, unblock only the fault signals (which cannot be usefully blocked anyway), and confine all signal handling to a housekeeping thread on a non-isolated core.

---

## 33.15 Async-Signal Safety

A handler can interrupt the main program **at any instruction**, including in the middle of `malloc`'s free-list manipulation or while a lock is held. **Async-signal-safe** means a function is safe to call from that context: reentrant, and not dependent on any global state that could be mid-update.

**The list is short, and POSIX enumerates it exactly (~180 functions).** Safe: `write`, `read`, `open`, `close`, `_exit`, `abort`, `kill`, `signal`, `sigaction`, `sigprocmask`, `sem_post`, `time`, `clock_gettime`, `waitpid`, `fork`, `execve`, `raise`, `select`, `poll`, most raw syscalls. **Unsafe, and these are the ones that matter:**

- **`malloc`/`free`/`new`/`delete`** — glibc's arena locks are non-reentrant. Interrupt `malloc` mid-update, call `malloc` in the handler, and the process deadlocks or corrupts the heap.
- **`printf`/`fprintf`/all of stdio** — internal `FILE*` locks and buffers.
- **`std::cout`, `std::string`, `std::vector`, anything allocating.**
- **`pthread_mutex_lock`** — not reentrant; a handler taking a lock the interrupted thread already holds is an immediate self-deadlock.
- **`syslog`**, `localtime`, `getpwnam`, `dlopen`, `backtrace_symbols` (allocates and may `dlopen`).
- **`exit()`** — runs `atexit` handlers and flushes stdio. Use `_exit()`.

The failure mode is what makes this insidious: it is a **race**, so a handler calling `printf` works in every test and deadlocks in production once a year under load. `strace` on a hung process showing the thread stopped inside `__lll_lock_wait` reached from a signal frame is the giveaway.

**`errno` is the subtle one.** A handler that calls any syscall clobbers `errno`, corrupting the interrupted code's error handling. Every handler must save and restore it:

```c
void handler(int sig) {
    int saved = errno;
    write(2, "sig\n", 4);
    errno = saved;
}
```

**C++-specific constraints.** You may not throw an exception out of a signal handler (unwinding through the kernel-built signal frame is not defined, though GCC's `-fnon-call-exceptions` makes a limited version work). Non-trivially-constructed function-local statics are initialized under a guard lock — touching one from a handler can deadlock. The only variables a handler may portably touch are `volatile sig_atomic_t` and lock-free atomics; C++ formally permits `std::atomic<T>` with `is_always_lock_free`, which is what modern code uses.

**The safe pattern, in full:**

```cpp
std::atomic<bool> g_stop{false};            // is_always_lock_free
int g_wakefd;                               // eventfd, created at startup

void handler(int) {
    int saved = errno;
    g_stop.store(true, std::memory_order_relaxed);
    uint64_t one = 1;
    ssize_t r = write(g_wakefd, &one, 8);   // async-signal-safe; wakes the event loop
    (void)r;
    errno = saved;
}
```

Set a flag, write one byte, return. All real work happens in the main loop. This "self-pipe / eventfd trick" is the universal answer, and the modern refinement is to skip handlers entirely and use `signalfd` (§33.9), which removes the constraint rather than working around it.

---

## 33.16 Alternate Signal Stacks

A handler normally runs on the stack of the interrupted thread. If the signal *is* `SIGSEGV` caused by **stack overflow**, there is by definition no room to push a signal frame — the kernel's attempt to build one faults again, and the second fault while delivering the first is unrecoverable: the kernel forces `SIG_DFL` and the process dies with no handler ever running. That is why a stack-overflow crash produces no diagnostics unless you set this up.

```c
static char stack_mem[SIGSTKSZ];        // or malloc'd; SIGSTKSZ is 8 KiB on glibc/x86-64
stack_t ss = { .ss_sp = stack_mem, .ss_size = sizeof stack_mem, .ss_flags = 0 };
sigaltstack(&ss, NULL);                 // PER-THREAD — must be done in EVERY thread

struct sigaction sa = {};
sa.sa_sigaction = crash_handler;
sa.sa_flags = SA_SIGINFO | SA_ONSTACK;  // SA_ONSTACK is what actually uses it
sigaction(SIGSEGV, &sa, NULL);
sigaction(SIGBUS,  &sa, NULL);
```

Three requirements, each independently sufficient to break it: the stack must be registered **per thread**; the handler must be installed with **`SA_ONSTACK`** (registering without the flag does nothing); and the stack must be large enough.

**`SIGSTKSZ` sizing.** Historically 8192 bytes. On x86-64 with AVX-512 the `xsave` area alone is ~2.5 KiB, and any real handler that formats a backtrace will overflow 8 KiB. Since glibc 2.34 `SIGSTKSZ` is no longer a compile-time constant but a call to `sysconf(_SC_SIGSTKSZ)` — which breaks code using it as an array size, a well-known porting break. Allocate **32–64 KiB** explicitly.

**Interaction with the guard page.** The guard page below a thread stack (Ch. 31 §31.11, Ch. 32 §32.20) is what converts overflow into a `SIGSEGV` rather than silent corruption of the adjacent mapping. Together, guard page + alternate stack + `SA_ONSTACK` is the complete recipe for surviving stack overflow long enough to log it. A handler can detect the case by comparing `info->si_addr` against the thread's stack bounds: a fault address within one page below the known stack limit is an overflow, not a wild pointer — worth reporting distinctly.

**Sanitizer interaction.** AddressSanitizer installs its own `SIGSEGV` handler with `SA_ONSTACK` and its own alternate stack; a custom handler installed afterwards will replace ASan's and lose its diagnostics (`ASAN_OPTIONS=handle_segv=0` if you want yours to win). Similarly, some JITs and garbage collectors use `SIGSEGV` for legitimate control flow (implicit null checks, write barriers, `userfaultfd`-style paging), so a crash handler must chain to the previously-installed handler rather than assuming a fault is fatal — save the old `struct sigaction` from `sigaction()`'s third argument and re-raise into it.

---

## 33.17 Core-Dump Signals and Crash Handlers

**Core-dumping signals:** `SIGSEGV` (invalid memory access), `SIGBUS` (valid address, unusable — misalignment on strict-alignment hardware, or a mapped page beyond EOF, §33.4), `SIGFPE` (integer divide-by-zero and `INT_MIN / -1`; note that floating-point exceptions are *masked* by default on x86 so `1.0/0.0` yields inf, not `SIGFPE`, unless you call `feenableexcept`), `SIGILL`, `SIGABRT` (from `abort()`, `assert`, and C++ `std::terminate`), `SIGTRAP`, `SIGSYS`, `SIGQUIT`, `SIGXCPU`, `SIGXFSZ`.

**Core dump configuration** — the operational checklist that separates people who have actually debugged production crashes:

| Knob | Meaning |
|---|---|
| `ulimit -c unlimited` / `RLIMIT_CORE` | **Zero by default on most distros — no core is written at all** |
| `/proc/sys/kernel/core_pattern` | Filename template, or `\|/path/to/prog` to **pipe** the core to a handler (systemd-coredump, apport) |
| `/proc/self/coredump_filter` | Bitmask of which mappings to include; **shared and huge-page mappings are excluded by default**, so a shared-memory ring is missing from the core unless you set it |
| `kernel.core_uses_pid`, `%e %p %t %s` in the pattern | Naming |
| `PR_SET_DUMPABLE` | Cleared by setuid transitions and by `PR_SET_NO_NEW_PRIVS` in some paths — no core |
| `systemd-coredump` + `coredumpctl` | Where the core actually went on a modern distro |

For a process with a 100 GB shared-memory mapping, an unfiltered core dump takes minutes and fills the disk — configure `coredump_filter` deliberately rather than accepting defaults, and be aware that writing a large core **stalls the machine's I/O**, which in a trading context can be worse than the crash.

**Writing a crash handler.** Every constraint of §33.15 applies, in the worst possible environment: the heap may be corrupt, locks may be held, and the stack may be exhausted.

```cpp
void crash_handler(int sig, siginfo_t* info, void* uc) {
    // 1. Only async-signal-safe calls. No malloc, no printf, no iostreams.
    // 2. Pre-format everything possible at startup; write() a fixed buffer.
    char buf[256];
    int n = fmt_fixed(buf, sig, info->si_addr, info->si_code);   // no allocation
    write(crash_fd, buf, n);                                     // pre-opened fd

    // 3. Backtrace: backtrace() itself is *mostly* safe; backtrace_symbols() ALLOCATES.
    void* frames[64];
    int k = backtrace(frames, 64);
    backtrace_symbols_fd(frames, k, crash_fd);                   // fd variant: no malloc

    // 4. Flush your pre-allocated flight-recorder ring (Ch. 59 §59.13) — it is in
    //    memory you already own, and it is the highest-value artifact you can emit.

    // 5. Restore the default disposition and re-raise, so a REAL core is produced
    //    with the original faulting register state and RIP.
    signal(sig, SIG_DFL);
    raise(sig);
}
```

Step 5 is the one candidates miss. Calling `_exit()` from the handler destroys the core dump; re-raising after resetting to `SIG_DFL` (equivalently, installing with `SA_RESETHAND`) lets the kernel dump core from the original fault context. Note that the core's stack will show the handler frame unless you re-raise — another reason the `ucontext_t` RIP/RSP values should be logged explicitly.

**Fundamental limitations to state plainly** (Ch. 58 §58.13): a handler cannot reliably run if the stack is exhausted (unless §33.16 is set up), cannot run at all for `SIGKILL` or a hardware machine check, cannot trust the heap, and cannot symbolize without a build ID and separate debug info. The robust production architecture is therefore *not* an in-process handler doing heavy work, but a minimal handler that writes a fixed-size record plus a core, with symbolization done offline by a separate process using the build ID (Ch. 58 §58.8).

**C++ specifics.** `std::terminate` (from an uncaught exception, a `noexcept` violation, or a throw during unwinding) calls `abort()` → `SIGABRT` → core. A custom `std::set_terminate` handler runs in *normal* context — the heap is intact and you may allocate — so it is a far better place to log an exception's `what()` than a signal handler is. `std::current_exception()` inside a terminate handler recovers the in-flight exception, which is the trick for logging what actually killed the process.

---

## Key Interview Questions

1. **What is `PIPE_BUF` and why does it matter?** — 4096 on Linux; writes up to that size are atomic and never interleaved between writers, so a multi-writer pipe protocol must keep messages under it or carry its own framing.
2. **Why does a pipeline hang when the parent forgets to close the write end?** — EOF is signalled only when *all* write descriptors are closed, and `fork` duplicated them; the reader blocks forever.
3. **POSIX vs System V message queues — which and why?** — POSIX: real file descriptors (pollable with epoll), priority ordering, refcounted cleanup. System V: `ftok` keys, not pollable, leaks until `ipcrm`. Choose POSIX; choose neither on a hot path.
4. **What can a UNIX-domain socket do that no other IPC can?** — Pass file descriptors (`SCM_RIGHTS`) and deliver kernel-verified peer credentials (`SO_PEERCRED`).
5. **Why is AF_UNIX faster than loopback TCP?** — It skips the entire IP/TCP stack: no checksums, no segmentation, no netfilter. Roughly 2× on round-trip.
6. **What breaks when you put a `std::atomic<T>` in shared memory?** — If it is not `is_always_lock_free`, the implementation uses a **process-local** lock table, so there is no cross-process atomicity at all — silently.
7. **Why can't you store pointers in a shared-memory segment?** — It may map at different virtual addresses in each process; use offsets or indices. Also disqualifies vtables and any heap-allocating container.
8. **What is a robust mutex and what is `EOWNERDEAD`?** — A `PTHREAD_PROCESS_SHARED` mutex whose owner died; the next locker gets `EOWNERDEAD`, must repair invariants and call `pthread_mutex_consistent`, or the mutex becomes permanently `ENOTRECOVERABLE`.
9. **Explain a futex.** — Lock state in a user-space word; the kernel is entered only to sleep (`FUTEX_WAIT`, which atomically compares-then-sleeps to close the lost-wakeup race) or wake (`FUTEX_WAKE`). Uncontended ~20 ns, contended ~2 µs.
10. **What is `FUTEX_REQUEUE` for?** — Moving waiters from a condvar's futex to the mutex's futex without waking them, eliminating the `pthread_cond_broadcast` thundering herd.
11. **eventfd vs a self-pipe?** — One fd instead of two, an 8-byte counter instead of a 64 KiB buffer, and automatic coalescing: N notifications produce one wakeup and a single read returning N.
12. **What must you do before using signalfd, and what can it not handle?** — Block the signals in every thread first (do it in `main` before spawning). It cannot handle synchronous fault signals — `SIGSEGV`/`SIGBUS`/`SIGFPE`/`SIGILL` — because blocking them forces the default kill action.
13. **Why do periodic timers drift, and how do you fix it?** — Relative rearming restarts from "now," which is already late by the wakeup latency. Use `TFD_TIMER_ABSTIME` with `base + n*period`, or `it_interval`, which the kernel rearms from the scheduled expiry.
14. **A timerfd read returns 7. What does that mean?** — Seven expirations elapsed since the last read: you missed six deadlines. It is a free overrun counter.
15. **How do you move a million messages per second between two processes?** — A bounded ring in `MAP_SHARED` huge-page memory with atomic sequence counters, release/acquire publication, cache-line-padded producer and consumer cursors, and a busy-polling consumer. ~100–300 ns one-way, zero syscalls.
16. **Why do standard signals not queue, and what bug does that cause?** — Signals 1–31 are a pending *bitmask*; duplicates collapse. The classic consequence is missed `SIGCHLD`s, so reaping must loop with `waitpid(..., WNOHANG)`.
17. **Which thread receives a signal?** — Synchronous faults go to the faulting thread; `pthread_kill` to the named thread; `kill(pid, ...)` to an arbitrary thread that has it unblocked. Dispositions are process-wide, which is why you block-and-centralize.
18. **Why must a signal handler save and restore `errno`?** — Any syscall in the handler clobbers it, silently corrupting the interrupted code's error handling.
19. **Why is `printf` in a signal handler a bug that passes all your tests?** — stdio holds non-reentrant locks; the deadlock only occurs if the signal lands inside a stdio critical section, which is a rare, load-dependent race.
20. **How do you handle a stack-overflow `SIGSEGV`?** — Guard page turns overflow into a fault; `sigaltstack` per thread plus `SA_ONSTACK` gives the handler room to run; compare `si_addr` against the stack bounds to distinguish overflow from a wild pointer.
21. **Why should a crash handler re-raise instead of calling `_exit`?** — Re-raising after resetting to `SIG_DFL` produces a core dump from the original faulting context; `_exit` throws away the core.
22. **Your production cores are missing the shared-memory ring. Why?** — `/proc/self/coredump_filter` excludes shared and huge-page mappings by default.

---

## Common Traps

- **Forgetting to close the unused pipe end after `fork`** — reader never sees EOF; pipeline hangs.
- **Ignoring `SIGPIPE`** — a write to a closed peer kills the process by default.
- **Assuming pipe writes are always atomic** — only up to `PIPE_BUF` (4096).
- **Using System V IPC in an event loop** — the identifiers are not file descriptors and cannot be polled.
- **Leaking System V objects** — they persist past process death; `ipcs`/`ipcrm` cleanup, and stale segments after a crash loop are the signature.
- **`ftok` collisions** — 32-bit hash of inode + project byte; recreating the path silently changes the key.
- **Undersized `mq_receive` buffer** — `EMSGSIZE`, never truncation.
- **`SCM_RIGHTS` with an undersized control buffer** — the fds are closed and `MSG_CTRUNC` is set; silent descriptor loss if unchecked.
- **Descriptors leaked in-flight** in an unread UNIX socket buffer.
- **Storing pointers, `std::string`, or polymorphic objects in shared memory.**
- **`std::atomic<T>` in shared memory that is not `is_always_lock_free`** — process-local lock table, zero cross-process atomicity.
- **A peer shrinking a shared-memory file** — every mapped access beyond EOF becomes `SIGBUS`, not `SIGSEGV`. Seal the memfd.
- **pthread mutex in shared memory without `PTHREAD_PROCESS_SHARED`** — undefined behaviour that appears to work.
- **Ignoring `EOWNERDEAD`** — treating it as a generic error leaves the mutex permanently `ENOTRECOVERABLE`.
- **`sem_timedwait` with `CLOCK_REALTIME`** — an NTP step changes your timeout; prefer `sem_clockwait`.
- **Not looping on `EINTR`** around `sem_wait`, `read`, `poll`.
- **False sharing between producer and consumer cursors** in a ring — pad both to 64 bytes.
- **A bounded interprocess ring with no overwrite policy** — a dead consumer permanently blocks the producer.
- **Assuming standard signals queue** — they coalesce; `SIGCHLD` handlers must loop on `waitpid(WNOHANG)`.
- **`signal()` instead of `sigaction()`** — implementation-defined reset and masking semantics.
- **Forgetting `sigprocmask` before `signalfd`** — the default disposition kills you, racily.
- **`sigprocmask` in a threaded program** — unspecified; use `pthread_sigmask`.
- **A blocked signal mask inherited across `exec`** — the child mysteriously ignores `SIGTERM`.
- **Checking a flag then blocking without `ppoll`/`pselect`** — lost-wakeup race; the atomic unmask-and-sleep is why those calls exist.
- **`malloc`, `printf`, or a mutex in a signal handler** — race-dependent deadlock or heap corruption.
- **Not restoring `errno` in a handler.**
- **`sigaltstack` without `SA_ONSTACK`** — registered and never used.
- **Using `SIGSTKSZ` as an array size on glibc ≥ 2.34** — it is no longer a constant; and 8 KiB is too small anyway.
- **Replacing ASan's or a JIT's `SIGSEGV` handler** without chaining to the saved previous handler.
- **`ulimit -c` left at 0** — no cores in production, discovered at the worst moment.
- **Calling `exit()` rather than `_exit()` from a handler** — runs `atexit` and flushes stdio.

---

## Compact Recall Summary

**Pipes/FIFOs.** 64 KiB kernel ring, resizable via `F_SETPIPE_SZ`. Writes ≤ `PIPE_BUF` (4096) are atomic. EOF only when all write ends close — the classic `fork` hang. `SIGPIPE` kills by default. Round-trip 5–10 µs blocking, 1–2 µs polled.

**Message queues.** POSIX `mq_*` gives pollable fds, strict priority, refcounted cleanup; System V gives `ftok` keys, no fd, `msgtype` selection, group leakage. Both ~3–8 µs. Priority is the only thing shared memory does not give you cheaply.

**UNIX sockets.** Stream/datagram/seqpacket, all reliable and ordered locally. Unique capabilities: `SCM_RIGHTS` fd passing and `SO_PEERCRED` credentials. ~2× faster than loopback TCP (no IP/TCP stack), ~20–50× slower than shared memory. Abstract namespace has no permission checks.

**Shared memory.** `shm_open`+`mmap` (tmpfs, inspectable, huge-page-able) or `memfd_create` + sealing + `SCM_RIGHTS`. No pointers — offsets only. Truncation → `SIGBUS`. `atomic<T>::is_always_lock_free` is mandatory. First touch decides NUMA node.

**Process-shared sync.** `PTHREAD_PROCESS_SHARED` is required and not the default; add `ROBUST` (handle `EOWNERDEAD` → repair → `pthread_mutex_consistent`) and `PRIO_INHERIT` against inversion. All of it costs a futex syscall under contention; the HFT answer is a single-writer ring or a seqlock, which cannot be left inconsistent by a crash.

**Semaphores.** No owner, so postable by anyone — right for signalling, wrong for mutual exclusion. POSIX unnamed/named are user-space atomics (~20 ns) falling back to futex; System V always syscalls (~1 µs) but offers atomic multi-op `semop` and `SEM_UNDO`. `sem_post` is async-signal-safe.

**Futex.** User-space word + kernel only to sleep/wake. `FUTEX_WAIT` compares-then-sleeps atomically to close the lost-wakeup race; the three-state mutex encoding avoids the wake syscall when uncontended. Shared futexes key on (inode, offset), which is what makes them work cross-process. ~20 ns vs ~2 µs — a 100× cliff. `REQUEUE` kills the condvar thundering herd; `LOCK_PI` implements priority inheritance.

**eventfd/signalfd/timerfd.** Three "kernel event as a file descriptor" primitives, all epoll-native. eventfd: 8-byte counter, auto-coalescing, `EFD_SEMAPHORE` for one-per-item. signalfd: signals as reads with no async-signal-safety constraint — but you must block first, and it cannot handle fault signals. timerfd: choose `CLOCK_MONOTONIC`, use `TFD_TIMER_ABSTIME` to avoid drift, read returns a missed-deadline count; realistic jitter 50–200 µs untuned, 2–20 µs tuned, floor ~10 µs.

**Interprocess lock-free queues.** Bounded ring in `MAP_SHARED` huge pages, `write_seq`/`read_seq` on separate cache lines, release-store to publish and acquire-load to consume (free on x86 TSO). Disruptor fan-out with per-reader cursors and per-slot sequence stamps for lapped-reader detection; overwrite rather than back-pressure for market data. ~100–300 ns one-way, zero syscalls, one core burned per polling consumer.

**Signals.** Generate → pending → deliver. Signals 1–31 are a bitmask (coalescing); RT signals queue. Faults go to the faulting thread, `kill()` to an arbitrary unblocked one; dispositions are process-wide. Delivery costs 1.5–4 µs (signal frame + `xsave` + `rt_sigreturn`). Use `sigaction` with `SA_SIGINFO`/`SA_ONSTACK`, never `signal()`. `si_code` distinguishes `SEGV_MAPERR` from `SEGV_ACCERR`; `ucontext_t` carries the faulting RIP/RSP and can be modified to resume elsewhere.

**Masks and safety.** Block everything in `main` before spawning threads; use `pthread_sigmask`, not `sigprocmask`; masks survive `exec`. `ppoll`/`pselect`/`sigsuspend` exist to make unmask-and-sleep atomic — the same lost-wakeup structure as futex wait. In a handler: only async-signal-safe calls, save/restore `errno`, set an atomic flag and `write()` to an eventfd, nothing more. Better still, use `signalfd` and have no handler at all.

**Crash handling.** Guard page + per-thread `sigaltstack` (32–64 KiB, not `SIGSTKSZ`) + `SA_ONSTACK` is the complete stack-overflow recipe. Handler: fixed buffers, pre-opened fd, `backtrace_symbols_fd`, dump the flight recorder, then `SIG_DFL` + `raise` so the kernel still produces a core from the original context. Check `RLIMIT_CORE`, `core_pattern`, and `coredump_filter` — the last of which excludes shared and huge-page mappings by default. For C++, `std::set_terminate` runs in normal context and is the right place to log an exception.
