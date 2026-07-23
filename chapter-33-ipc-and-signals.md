# Chapter 33 — IPC and Signals

## Why This Matters — Core

Process boundaries contain failures and establish security boundaries, but they remove ordinary in-process references and synchronization. IPC reconnects the processes. The choice is not “fast versus slow”: message channels can provide framing, buffering, credentials, and peer-close semantics; shared memory removes kernel payload buffering and steady-state syscalls but makes layout, publication, backpressure, and crash recovery application responsibilities.

Signals are a separate mechanism. They are asynchronous notifications with process-wide dispositions and per-thread masks, not a general message transport. A handler can interrupt code while it holds an allocator or stream lock, so handler safety is a correctness rule before it is a latency concern.

This chapter labels facilities explicitly: **C++23** for language/library guarantees, **POSIX** for portable Unix interfaces, and **Linux** for facilities such as futexes, `eventfd`, `signalfd`, `timerfd`, `memfd_create`, abstract UNIX-socket names, and `/proc` controls. Chapter 26 owns queue algorithms, Chapter 32 owns virtual-memory behavior, and Chapter 34 owns the syscall and readiness machinery.

## 90-Second Screen — Core

Five facts:

1. Ordinary pipe, queue, and socket exchanges normally cross into the kernel on send and receive and copy payload data between user and kernel buffers. Batching and blocking policy determine how much of that cost is paid per logical message.
2. Shared memory can keep the steady-state payload path in user space, but publication still incurs atomic operations, cache-coherence traffic, and either polling cost or a wakeup path.
3. A lock-free atomic is *necessary* but not *sufficient* for cross-process use — the standard only recommends, and does not require, that lock-free operations be usable through shared memory.
4. Multiple instances of a pending standard signal can coalesce; POSIX real-time signals queue, subject to resource limits.
5. A POSIX signal handler may call only async-signal-safe functions and communicate through carefully permitted state. Allocation, C/C++ streams, ordinary locks, and most library code are unsafe there.

Two decisions:

- For each channel in the system: which mechanism, and what happens when the peer dies mid-message.
- For signals: which are blocked where, which thread handles them, and whether anything at all runs in handler context.

---

## Part I — Inter-process Communication

## 33.1 Choosing a Mechanism — Core

Start with the decision, because the mechanism catalogue is only useful in service of it.

| Mechanism | Data path after setup | Semantics and pressure | Readiness | Best reason to choose it |
|---|---|---|---|---|
| Shared-memory ring | User-space loads/stores; coherence traffic; optional notification | Application-defined records and overwrite/block/drop policy | Poll, or pair with a notifier | High-rate fixed-layout data with controlled peers |
| Shared memory + futex | User-space fast path; syscalls when parking/waking | Application protocol plus wait-state invariant | Not a descriptor | Sleep when idle without putting every operation through the kernel |
| Linux `eventfd` | `write`/`read` syscalls; counter only, no payload copy | Coalescing counter; bounded overflow behavior | Yes | Notify an event loop that shared state changed |
| AF_UNIX socket | Kernel send/receive path and ordinary user/kernel payload copies | Stream, datagram, or sequenced-packet backpressure | Yes | Framing, peer credentials, descriptor passing, close detection |
| Pipe / FIFO | Kernel byte buffer and ordinary user/kernel copies | Byte stream; atomicity only for bounded writes | Yes | Simple one-way plumbing and child-process integration |
| POSIX message queue | Kernel-maintained messages and priorities | Bounded messages; send can block/fail when full | Linux: pollable implementation | Priority-ordered local messages |
| System V queue / semaphore | Syscalls operate on persistent kernel IPC objects | Messages, or atomic semaphore-operation vectors | Not ordinary descriptor readiness | Compatibility or SysV multi-semaphore transaction semantics |
| Loopback TCP | Socket and TCP/IP stack on the host | Reliable byte stream with network-compatible endpoint model | Yes | Location transparency |

No table can supply a timeless latency ranking. Payload size, batching, core placement, queue occupancy, scheduler state, mitigations, and kernel version all change the result. Chapter 30 owns reference measurements; for a design, measure end-to-end distributions and count syscalls, bytes copied, wakeups, cache misses, and drops under the intended load.

Use these axes in order:

1. **Ownership:** does a message become kernel-owned, receiver-owned, or remain in a shared region?
2. **Semantics:** byte stream, records, priorities, one-to-one, or fan-out?
3. **Pressure:** block, reject, drop newest, overwrite oldest, or disconnect?
4. **Failure:** how are partial messages, peer death, stale shared state, and restart detected?
5. **Authority:** are peer credentials, filesystem permissions, or descriptor transfer required?
6. **Waiting:** busy-poll, spin-then-park, or integrate with descriptor readiness?

**The decision procedure**, applied to three cases:

*Market data from a feed handler to several strategy processes, hundreds of thousands of messages per second, with a measured tight latency budget.* Start with a shared-memory, single-writer fan-out ring and one cursor per reader. Busy-poll only on provisioned cores; otherwise add spin-then-park notification. The trade is lower crossing/copy/wakeup frequency for reserved CPU, a fixed layout, and explicit overrun recovery.

*A control plane: configuration reload, health queries, and administrative commands at low rate.* A UNIX-domain `SOCK_SEQPACKET` socket is a strong Linux default. It provides message boundaries, peer identity mechanisms, close/error signals, and descriptor readiness. The additional crossings and copies are accepted because correctness and operability dominate this workload.

*A supervisor handing a listening socket to a worker it just spawned.* Use UNIX-domain socket descriptor passing. It transfers a reference to the same open file description without publishing a process-local descriptor number. Descriptors in queued messages consume receiver and kernel resources until received or the socket closes; a truncated ancillary receive sets `MSG_CTRUNC` and Linux closes excess received descriptors, so both sides need acknowledgement and bounds.

Everything else in this half of the chapter is the detail needed to implement one of those three answers correctly.

---

## 33.2 Shared Memory — Core

Shared memory separates **setup** from **exchange**. Mapping, sizing, permissions, and teardown enter the kernel; the steady-state exchange can then use ordinary loads, stores, and atomics. Visibility comes from the publication protocol and hardware coherence, not from `mmap` alone.

```cpp
// POSIX/Linux setup excerpt: every return value must be checked in production.
int fd = ::shm_open("/md_ring", O_CREAT | O_EXCL | O_RDWR, 0600);
if (fd == -1 || ::ftruncate(fd, kSize) == -1) fail();
void* p = ::mmap(nullptr, kSize, PROT_READ | PROT_WRITE,
                 MAP_SHARED, fd, 0);
if (p == MAP_FAILED) fail();
::close(fd);  // mapping remains; shm_unlink removes only the name
```

The excerpt shows creation order; error cleanup and a generated unique name are omitted. It needs `<fcntl.h>`, `<sys/mman.h>`, `<sys/stat.h>`, and `<unistd.h>` and is POSIX except for deployment details of the backing store. `O_EXCL` prevents accidentally resizing an existing live segment. `shm_unlink("/md_ring")` removes the name; existing mappings survive until `munmap`, like an unlinked open file.

The alternatives differ mostly in naming and lifecycle:

| Facility | Scope | Lifetime and naming | Operational consequence |
|---|---|---|---|
| POSIX `shm_open` | POSIX | Named object; `shm_unlink` removes name | File-descriptor workflow and normal mapping APIs |
| System V `shmget`/`shmat` | POSIX/XSI | Numeric identifier/key; remove with `shmctl(IPC_RMID)` | Can persist after creators exit; stale segments need cleanup |
| `memfd_create` | Linux | Anonymous file descriptor | Pass it over AF_UNIX; no global shared-memory name |

For `memfd_create`, pass `MFD_ALLOW_SEALING`, size the file, then use `F_ADD_SEALS` with `F_SEAL_SHRINK | F_SEAL_GROW` (and often `F_SEAL_SEAL`) before handing it to peers. Sealing prevents a peer from resizing the object and causing the truncation fault described below. Huge-page backing may help a large, TLB-sensitive segment, but it changes allocation and operational constraints; Chapter 32 owns that decision.

### The publication protocol

The mechanism is Chapter 26's single-producer ring, specialized to processes. The following publication pseudocode omits the mapped-region owner, slot type, and full consumer loop so it can focus on the cross-process contract:

```cpp
struct alignas(64) RingHeader {
    std::atomic<std::uint64_t> write_seq;   // producer's line
    char pad0[64 - sizeof(std::atomic<std::uint64_t>)];
    std::atomic<std::uint64_t> read_seq;    // consumer's line
    char pad1[64 - sizeof(std::atomic<std::uint64_t>)];
    std::uint64_t capacity;                 // power of two
};

// Producer
const auto w = h->write_seq.load(std::memory_order_relaxed);
if (w - h->read_seq.load(std::memory_order_acquire) == h->capacity) return Full;
slots[w & (h->capacity - 1)] = msg;                        // payload
h->write_seq.store(w + 1, std::memory_order_release);      // publish
```

The release store and the consumer's acquire load order payload publication. The padding prevents producer updates to `write_seq` and consumer updates to `read_seq` from sharing one line; the consumer necessarily observes coherence traffic on the `write_seq` line it polls. Chapter 26 owns the full proof.

For fan-out to several readers, a common market-data shape is one writer with a monotonically increasing sequence and a private cursor per reader. Readers then avoid writing a single contended shared cursor. Adding readers still costs memory bandwidth and cache capacity, so it is not free. An overwrite policy can be appropriate when Chapter 53's recovery protocol can resynchronize a lapped consumer; an order or risk channel usually needs backpressure or rejection instead. Per-slot sequence stamps let a reader detect stale data and being lapped during a copy. Chapter 26 owns the queue proof.

### The cross-process constraints

Cross-process use adds representation, implementation, lifecycle, and restart requirements beyond the queue proof.

**1. Avoid process-relative representation.** The segment may map at a different virtual address in each process, so store offsets, indices, or deliberately designed offset pointers. Raw pointers, ordinary allocator-backed containers, function pointers, and vptrs generally contain process-specific addresses. A custom shared-memory allocator can support container-like structures, but that is a different layout contract, not ordinary `std::vector`.

**2. Atomics require more than `is_always_lock_free`.** `std::atomic<T>::is_always_lock_free` says operations on that specialization are always lock-free in the implementation. It does *not* itself create a portable cross-process contract: C++ only **recommends** (non-normatively) that lock-free operations be *address-free*, meaning suitable when the same storage has different virtual addresses. Require all of:

- the atomic specialization is lock-free on this implementation (`is_always_lock_free`, or a checked runtime property where appropriate);
- the selected compiler, standard library, architecture, and ABI document or have been validated to provide address-free operations for the specialization;
- both processes were built with the same layout for the containing structure, and the object meets its alignment requirement in the shared page (misalignment is already a correctness violation; some x86 split-lock cases also incur severe penalties or platform fault policy—Chapter 29);
- both processes agree on the type's size and representation.

So the check is a `static_assert` **plus** a named platform and a layout assertion, not a `static_assert` alone:

```cpp
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);
static_assert(sizeof(RingHeader) == 192 && alignof(RingHeader) >= 64);
static_assert(offsetof(RingHeader, read_seq) == 64);
// Deployment contract must name compiler/library/architecture and record how
// address-free operation and multiprocess behavior were verified.
```

If the type is not lock-free, the implementation may use hidden synchronization whose process-sharing behavior is not promised by C++23. Do not place it in a cross-process protocol without a documented implementation guarantee.

**3. Linux file-backed truncation can produce `SIGBUS`.** Accessing a page of a mapping beyond the backing file's new end can raise `SIGBUS`. A peer that shrinks or replaces a live segment can therefore kill a reader at an ordinary load. Seal a `memfd`, or treat live segment size as immutable and publish a new version for readers to map (Chapter 32).

**4. First touch influences physical placement.** Under the common Linux first-touch policy, the thread that first faults a page influences its initial NUMA node. Automatic NUMA balancing, migration, reclaim, and explicit policies can change the later state. Establish and verify placement for the actual producer/consumer topology (Chapter 29).

**5. Build skew is a data-corruption bug, not an error.** Both sides must agree on layout. Carry a version field and assert the layout; a mismatch otherwise presents as garbage payloads.

**6. Crash consistency is a protocol property.** With “fill payload, then release-publish sequence,” a crash before publication leaves the record invisible; a crash after publication leaves a complete record. The consumer still needs a heartbeat or deadline to distinguish idle from dead, and a sleeping consumer needs a notification protocol that cannot lose the published work. Avoiding a shared lock removes owner-death lock recovery, but it does not solve every partial-update or restart problem.

---

## 33.3 Kernel-Mediated Channels — Core

What you need from each, compressed to the parts that change a decision.

**Pipes and FIFOs (POSIX; sizing controls below are Linux).** A pipe is an anonymous unidirectional byte stream, often created before `fork`; a FIFO gives a similar stream a filesystem name. Three facts matter:

- *Capacity is version-, page-size-, and configuration-dependent.* Linux has commonly defaulted to 16 pages since 2.6.11, but later kernels can reduce defaults when per-user pipe limits are reached, and `/proc/sys/fs/pipe-max-size` can cap the default. Query the actual pipe with `fcntl(F_GETPIPE_SZ)`; request a size with `F_SETPIPE_SZ` and handle refusal.
- *Writes of at most `PIPE_BUF` bytes are not interleaved with other writers.* POSIX requires `PIPE_BUF >= 512`; query `_PC_PIPE_BUF` with `fpathconf` for the object. This guarantee says nothing about application message framing on reads: a reader must still handle short reads and concatenated writes.
- *EOF requires that **all** write descriptors be closed.* `fork` duplicates them, so a parent that forgets to close its copy leaves the reader blocked forever. This is the classic pipeline hang.

Opening a FIFO read-only normally waits for a writer, and opening it write-only waits for a reader. Nonblocking mode changes these cases; notably, a nonblocking write-only open fails with `ENXIO` when no reader exists. Treat open/reconnect behavior as part of the protocol rather than hiding it with a permanently open extra descriptor, which would also hide EOF.

Writing to a pipe with no reader generates `SIGPIPE`; if ignored or blocked, `write` fails with `EPIPE`. Linux socket code can use `MSG_NOSIGNAL` per send, while a process-wide ignored disposition is broader. In either design, handle the error because it is the peer-death indication.

This POSIX example sends one bounded record through a pipe. It is intentionally single-threaded before `fork`; Chapter 34 owns general short-I/O loops.

```cpp
#include <cstdint>
#include <cstdlib>
#include <sys/wait.h>
#include <type_traits>
#include <unistd.h>

struct Quote { std::uint64_t seq; std::int64_t price_ticks; };
static_assert(std::is_trivially_copyable_v<Quote>);
static_assert(sizeof(Quote) <= 512);       // within POSIX's minimum PIPE_BUF

int main() {
    int fd[2];
    if (::pipe(fd) == -1) return 1;
    const pid_t pid = ::fork();
    if (pid == -1) return 1;

    if (pid == 0) {
        ::close(fd[0]);
        const Quote q{42, 10125};
        const bool ok = ::write(fd[1], &q, sizeof q) == sizeof q;
        ::close(fd[1]);
        ::_exit(ok ? 0 : 2);
    }

    ::close(fd[1]);                       // required for eventual EOF
    Quote q{};
    const ssize_t n = ::read(fd[0], &q, sizeof q);
    ::close(fd[0]);
    int status{};
    ::waitpid(pid, &status, 0);
    return n == sizeof q && q.seq == 42 ? 0 : 3;
}
```

**UNIX-domain sockets.** The general-purpose local channel: the socket API without a protocol stack. Three types, and the distinction matters more here than it does for network sockets:

- *Stream*: a reliable ordered byte stream with no message boundaries — the local analogue of TCP.
- *Datagram*: Linux AF_UNIX datagrams preserve boundaries and are delivered reliably and in order once accepted by the socket layer. Capacity is bounded: a blocking send can wait for space, a nonblocking send can fail with `EAGAIN`/`EWOULDBLOCK`, and addressing or peer failures are reported as errors. This is not permission to omit an overload policy.
- *Sequenced packet*: connection-oriented, ordered, reliable, and record-preserving. It is a strong default for a Linux local control protocol when both endpoints support it.

Linux AF_UNIX supports descriptor passing with `SCM_RIGHTS` and peer identity through `SO_PEERCRED` or credential ancillary data. Descriptors queued in ancillary messages consume resources until received or the socket is closed. If a receive control buffer is too small, Linux sets `MSG_CTRUNC` and closes excess received descriptors; ignoring the flag loses resources the sender thought it transferred.

A Linux address beginning with a null byte selects the abstract namespace. It has no filesystem inode or permission check and disappears when the last reference closes. Authenticate peers explicitly when using it on a shared host.

**Message queues.** POSIX queues preserve records and deliver the highest-priority pending message first, with FIFO ordering among equal priorities. They are named kernel objects with explicit unlinking and configured maximum message count/size. On Linux, the `mqd_t` implementation is a file descriptor and can be monitored for readiness; portable POSIX code must not assume that representation.

System V queues use an IPC identifier obtained from a key, select messages by a numeric type, and remain until explicitly removed or the system removes them. They are not ordinary pollable descriptors. System V **semaphores**, not message queues, add group-atomic operations over a vector of semaphore changes. Choose either legacy family for compatibility or a required semantic, not by default for a measured hot path.

### Worked IPC Diagnosis: The Fast Control Channel That Cannot Recover

A supervisor publishes commands to a shared slot:

```
supervisor: write {generation, length, bytes} ─▶ release-store ready = 1
strategy:   acquire-load ready ─▶ execute ─▶ store ready = 0
```

The benchmark looks excellent because the test has one healthy producer and consumer. Production restart testing exposes three failures:

1. The strategy dies after observing `ready` but before clearing it. The restarted process cannot tell whether the slot contains an unexecuted command, an already executed command awaiting acknowledgement, or bytes from an old process incarnation.
2. The supervisor dies after writing part of a command but before publication. The current release/acquire ordering keeps that partial payload invisible, but it does not say when abandoned storage may be reused or how the consumer learns the producer is dead.
3. Any process that can map the segment can write the command bytes. The slot has no kernel-provided peer identity, close event, or trustworthy framing validation.

The problem is not that shared memory lacks speed. It lacks the semantics this low-rate channel needs. Replace it with a Linux AF_UNIX `SOCK_SEQPACKET` protocol:

```
validated command record
      │ sendmsg: user → kernel queue
      ▼
credential + record boundary + bounded receive queue
      │ recvmsg: kernel → strategy
      ▼
validate version/length/id ─▶ execute ─▶ ACK{id,status}
      │
EOF/error means peer connection ended
```

Give every command an idempotency key or generation and require an acknowledgement. Use `SO_PEERCRED` on an accepted connection, restrict the filesystem socket path or authenticate abstract-namespace peers, reject malformed lengths before acting, and define what nonblocking `EAGAIN` means—retry to a deadline, reject, or disconnect. If configuration is large, pass a sealed `memfd` and keep only its metadata in the control record.

The costs are named: a one-way unbatched command uses a send and receive operation, user/kernel copies of the small control record, kernel queueing, and a wakeup if the receiver sleeps; an acknowledgement traverses the path in reverse. At a few commands per second these costs buy failure detection, authority, framing, and backpressure. Validate the choice with restart/fault-injection tests and queue-saturation tests; latency percentiles matter only after those semantics pass.

---

## 33.4 Notification: Futexes, eventfd, timerfd — Core

**A futex (Linux)** combines a user-space state word with kernel-assisted waiting. Many Linux pthread synchronization implementations use it so an uncontended operation can remain in user space and only a waiter that must park enters the kernel.

```c
// Pseudocode around the Linux futex syscall:
futex(&word, FUTEX_WAIT, expected, ...);  // sleep only if word still equals expected
futex(&word, FUTEX_WAKE, n, ...);         // make up to n matching waiters runnable
```

The compare-and-sleep must be atomic *inside the kernel*; that is the whole trick. Without it, the lost-wakeup race exists: a waiter reads the word, decides to sleep, is preempted, the waker changes the word and wakes nobody, and the waiter sleeps forever. This is the same structure as the mask-and-sleep race that `ppoll` and `pselect` exist to close (§33.7) — worth recognizing as a general pattern rather than two unrelated facts.

`FUTEX_WAIT` can also return because the value changed first, a signal interrupted the wait, or a spurious wake occurred. The waiter always loops and rechecks the user-space predicate; a wake is permission to retry, not proof that the desired state now holds.

The consequences for design:

- A well-designed uncontended lock path can be user-space atomics only. Parking and waking add syscall, scheduler, queueing, and likely cache-reacquisition work. Chapter 30 supplies target-specific measurements.
- A futex word can live in a shared mapping. For a process-shared futex, the kernel identifies the shared backing object and offset; do not use the `FUTEX_PRIVATE_FLAG`, which promises the futex is process-private.
- Requeue operations move waiters from one futex to another *without waking them*, which is how a condition-variable broadcast avoids waking N threads that would immediately contend.
- Futex calls in a path expected to be uncontended indicate parking, wakeup, or another slow path worth explaining. Where the syscall tracepoint is available, `perf trace` or an appropriate `perf stat -e syscalls:sys_enter_futex ...` run can test that hypothesis.

**`eventfd` (Linux)** is a descriptor wrapping a 64-bit counter. An eight-byte write adds a value; a normal eight-byte read returns the accumulated counter and resets it. If many writes occur before the consumer reads, readiness can coalesce and one read observes their sum. The writes still cost syscalls, and concurrent draining can produce more than one read/wakeup, so “ten thousand notifications means exactly one wakeup” is not a guarantee. `EFD_SEMAPHORE` makes each successful read return one and decrement by one. Use `EFD_NONBLOCK | EFD_CLOEXEC` in an event loop and treat `EAGAIN` as part of the protocol.

**`timerfd`** exposes a timer as a readable descriptor, which puts deadlines on the same footing as I/O readiness. Three details carry:

- **Absolute versus relative.** A periodic task built from relative rearming accumulates drift, because each rearm starts from "now", which is already late by the wakeup latency. Use absolute deadlines computed as `base + n × period`, or an interval timer, which the kernel rearms from the scheduled expiry rather than from delivery.
- **Clock choice.** Use a monotonic clock for elapsed-time deadlines. For a genuine wall-clock deadline, Linux `TFD_TIMER_CANCEL_ON_SET` together with absolute mode on a supported realtime clock can surface a discontinuous clock change as cancellation instead of silently retaining a wrong civil-time target (Chapter 35).
- **The read value is an expiration count.** A value greater than one means multiple expirations accumulated before the read. Record it as direct evidence that the loop did not service every period separately.

Timer resolution does not guarantee wakeup accuracy. Scheduler load, interrupt handling, timer slack, and idle-state exit can all widen the distribution (Chapters 31 and 35). If a measured sleep/wakeup path cannot meet a deadline, a bounded spin on a provisioned core is one option, with explicit CPU and power cost.

**A hybrid design:** spin on a shared-memory cursor for a bounded interval, then publish a sleeping state, recheck the cursor, and block on a notifier only if no work arrived. The recheck closes the producer/waiter lost-wakeup race. Choose the spin duration from the idle-gap distribution and measured wakeup tail, then verify CPU consumption, power, message latency, and missed-notification tests.

---

## 33.5 Cross-Process Synchronization — Role-specific

A POSIX pthread synchronization object is process-private by default; using it between processes without the process-shared attribute is outside the contract. Initialize the object in shared memory before peers use it and check every attribute call because combinations are implementation-dependent:

```c
pthread_mutexattr_t ma;
pthread_mutexattr_init(&ma);
pthread_mutexattr_setpshared(&ma, PTHREAD_PROCESS_SHARED);  // required for shared memory
pthread_mutexattr_setrobust(&ma, PTHREAD_MUTEX_ROBUST);     // survive owner death
pthread_mutexattr_setprotocol(&ma, PTHREAD_PRIO_INHERIT);   // bound priority inversion
pthread_mutex_init(&shm->mtx, &ma);                          // the object lives IN the segment
```

**Robustness addresses owner death:** if a robust-mutex owner exits while holding it, the next acquirer receives `EOWNERDEAD` while owning the mutex. It must repair the protected invariant and call `pthread_mutex_consistent`. Unlocking first makes later lock attempts return `ENOTRECOVERABLE` until the mutex is reinitialized. Code that treats every nonzero result as a generic lock failure skips this recovery state.

**Priority inheritance** can bound one form of priority inversion when a higher-priority real-time thread waits for a lower-priority owner. It does not repair long critical sections, dead owners, or unbounded chains, and the requested protocol may be unsupported. Chapter 31 owns real-time scheduling policy.

**Semaphore choices.** A named POSIX semaphore comes from `sem_open`; an unnamed one can live in shared memory when `sem_init(..., pshared != 0, ...)` is supported. Both model a count and can block when it is zero. System V `semop` can apply a vector of changes atomically and offers `SEM_UNDO`, which asks the kernel to adjust selected operations when a process exits. `SEM_UNDO` has system limits and does not restore an arbitrary application invariant.

**The hot-path decision:** contention can add kernel waiting and scheduler wakeup, but an uncontended process-shared pthread mutex may remain in user space on a given implementation. Measure both states. A single-writer ring or sequence-based snapshot often avoids owner-death recovery and shared-lock cache traffic; Chapter 26 owns their correctness. A stalled writer remains a liveness condition that readers must detect.

---

## Part II — Signals

## 33.6 The Signal Model — Core

Three states, and conflating them causes most signal bugs:

```
generated : kill/raise, a hardware fault, or a kernel event
    ↓
pending   : per-thread and process pending state; standard instances may coalesce,
            while real-time signals carry queued instances
    ↓       (a blocked signal stays here indefinitely)
delivered : on return to user mode, the kernel selects a pending unblocked signal
            and performs its disposition
```

**Pending state is per-process and per-thread.** A process-directed signal can be pending for the process; a thread-directed signal is pending for that thread. If multiple instances of a standard signal become pending before delivery, POSIX does not require them to queue and they commonly coalesce into one pending indication. A thousand child exits can therefore yield one `SIGCHLD` delivery, so reaping must loop until no more children are ready. Real-time signals queue in defined order, subject to resource limits and send failure.

**Blocked is not ignored.** Blocking makes delivery ineligible for that thread while preserving pending state; unblocking makes a pending signal eligible. Ignoring discards the signal according to the disposition rules. `SIGKILL` and `SIGSTOP` cannot be caught, blocked, or ignored.

**Which thread receives it** is the part interviews probe:

| Origin | Delivered to |
|---|---|
| A synchronous fault | **The offending thread**, always |
| `pthread_kill` / thread-directed send | That thread |
| `kill` to the process, terminal signals, child notifications | One eligible thread chosen by the implementation/kernel |

Dispositions, however, are **process-wide**: one handler table per process. The design conclusion follows directly and is the single most useful thing in this half of the chapter: **block the process-directed signals in `main` before creating any threads, then handle them in exactly one place.** Anything else means the signal lands on an arbitrary thread — possibly your latency-critical one.

**Delivery has a substantial path.** On Linux, the kernel arranges a signal frame containing saved execution state, redirects execution to the handler, and later restores state through `sigreturn`. The exact saved state and cost depend on architecture, kernel, and thread state. For a high-rate notification, compare a shared counter plus `eventfd`, a queue, or another batched transport; measure signal delivery only if signal semantics are actually required.

**Interruption.** A caught signal can make a blocking interface fail with `EINTR`, or Linux can restart particular interfaces when the handler uses `SA_RESTART`. Linux documents a list that is never restarted, including readiness waits such as `poll`/`ppoll` and sleep interfaces; other timed operations have interface-specific behavior. Write loops from the documented contract, recompute deadline-based timeouts after interruption, and do not assume the flag restarts everything.

---

## 33.7 Installing Handlers and Managing Masks — Core

Use POSIX `sigaction` to install handlers because it specifies the mask and flags needed for review. The simpler `signal` interface exposes less control and has historical portability traps outside modern POSIX environments.

```cpp
#include <signal.h>

extern "C" void handler(int, siginfo_t*, void*) noexcept {}

int install_usr1_handler() {
    struct sigaction sa {};
    sa.sa_sigaction = handler;
    sigemptyset(&sa.sa_mask);             // extra signals blocked in handler
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    return sigaction(SIGUSR1, &sa, nullptr);
}
```

`SA_SIGINFO` selects the three-argument handler and supplies a `siginfo_t`; `SA_RESTART` requests restart only for eligible interfaces; `SA_ONSTACK` uses a registered alternate stack (§33.10); `SA_NODEFER` allows the current signal to reenter its handler and therefore requires an explicitly reentrant design; `SA_RESETHAND` resets the disposition on entry.

For synchronous faults, `si_code` and `si_addr` can distinguish categories such as address-not-mapped versus permission failure for `SIGSEGV`, or kernel-defined `SIGBUS` causes. The `ucontext` argument exposes architecture-specific saved state on Linux, but portable POSIX code cannot assume its layout. Reading or modifying it, unwinding, and resuming after a fault are runtime/architecture techniques, not a general C++ recovery mechanism.

**Masks are per-thread.** A new POSIX thread inherits a copy of its creator's mask; a child of `fork` inherits the calling thread's mask; the mask is preserved across `exec`. Caught dispositions reset to default across `exec`, while ignored dispositions remain ignored. A launcher must deliberately establish the child mask before `exec` or use an interface such as `posix_spawn` with mask attributes. In a multithreaded process, use `pthread_sigmask`; POSIX leaves `sigprocmask` behavior unspecified there.

**The unmask-and-sleep race** is why `pselect`, `ppoll`, and the signal-aware wait variants exist:

```c
if (!got_signal) poll(fds, n, -1);   // BROKEN: handler can run between test and sleep

sigset_t empty; sigemptyset(&empty);
ppoll(fds, n, &ts, &empty);          // temporarily replace mask while sleeping
```

Assuming the relevant signal was blocked beforehand, `ppoll` changes the mask and waits atomically, then restores the old mask. The caller must still loop on its predicate and handle `EINTR`. This is structurally the same race as futex compare-and-sleep (§33.4).

---

## 33.8 Async-Signal Safety — Core

A handler can interrupt the program at any instruction, including inside the allocator's free-list manipulation or while a lock is held. Async-signal-safe means a function is safe in that context: reentrant, and not dependent on global state that could be mid-update.

**The checklist.** Given a handler body, every one of the following is a defect:

| In a handler | Why it is unsafe |
|---|---|
| `malloc`, `free`, `new`, `delete`, or anything that allocates | The allocator's locks are not reentrant — deadlock or heap corruption |
| Any stdio call, `std::cout`, or a formatting library | Internal stream locks and buffers |
| `std::string`, `std::vector`, or any container operation that may allocate | As above |
| Taking a mutex of any kind | Not reentrant; immediate self-deadlock if the interrupted thread holds it |
| `syslog`, name lookups, locale-dependent time formatting, dynamic loading | Global state and internal locks |
| Symbolizing a backtrace | Allocates, and may load libraries |
| `exit` | Runs exit handlers and flushes streams — `_Exit`/`_exit` is the immediate form |
| Touching a non-trivially-constructed function-local static | Its initialization guard is a lock |
| Throwing an exception out of the handler | POSIX handler context is not a supported C++ exception boundary |
| Failing to save and restore `errno` | Any syscall in the handler silently corrupts the interrupted code's error handling |
| Communicating through ordinary global C++ objects | C++/POSIX signal rules and data races do not permit ordinary shared access |

Local arithmetic and fixed local data are not forbidden merely because they are local. The boundary is shared state and called functions. For communication, the portable baseline is assignment to a `volatile sig_atomic_t`; C++ also defines a narrow role for lock-free atomics, but a POSIX design should verify both the C++ implementation and platform contract before relying on it.

**The safe pattern** is to set a flag, optionally write to a pre-created nonblocking descriptor, and return:

```cpp
#include <cerrno>
#include <cstdint>
#include <signal.h>
#include <unistd.h>

volatile sig_atomic_t g_stop = 0;
volatile sig_atomic_t g_wake_fd = -1;  // eventfd, fixed before handler install

extern "C" void handler(int) noexcept {
    const int saved = errno;
    g_stop = 1;
    const std::uint64_t one = 1;
    (void)::write(static_cast<int>(g_wake_fd), &one, sizeof one);
    errno = saved;
}
```

Create the Linux `eventfd` with `EFD_NONBLOCK`; if the counter cannot accept the write, `write` fails rather than blocking inside the handler, and existing counter state already makes the descriptor readable. Install the handler only after publishing the descriptor value, and never change it afterward. All real work happens in normal code.

### Worked Signal-Safety Diagnosis

Suppose a production process occasionally freezes after `SIGTERM`. The handler is:

```cpp
void stop_handler(int) {
    std::cerr << "stopping " << active_orders.size() << '\n';
    std::lock_guard lock(state_mutex);
    stopping = true;
}
```

Reason from the interruption point:

1. The signal can arrive while the same thread is inside `operator new`, an iostream operation, a vector update, or while it owns `state_mutex`.
2. `std::cerr` can take stream/locale locks; `active_orders.size()` races with mutation; `lock_guard` can reacquire a mutex already held by the interrupted thread; `stopping` is ordinary shared state.
3. A low-rate test usually delivers between these critical regions, so it passes. Under load, one unlucky delivery self-deadlocks or races.
4. Replace the handler with the flag/nonblocking-write pattern above, or block `SIGTERM` in all threads and consume it through `signalfd`. Then log, lock, and begin shutdown from the event loop.

The confirming evidence is a thread stack stopped in a lock or allocator below a signal frame, plus a controlled stress test that repeatedly delivers the signal while allocator, stream, and mutex activity runs. The fix is successful when the handler contains only audited operations and the shutdown path survives that test without missed wakeups.

---

## 33.9 `signalfd` and the Block-and-Centralize Design — Core

`signalfd` converts asynchronous delivery into synchronous, pollable reads, which removes the constraint of §33.8 rather than working around it.

```cpp
#include <cerrno>
#include <pthread.h>
#include <signal.h>
#include <sys/signalfd.h>

int make_control_signal_fd() {
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGTERM);
    sigaddset(&mask, SIGINT);
    const int e = pthread_sigmask(SIG_BLOCK, &mask, nullptr);
    if (e != 0) { errno = e; return -1; }
    return signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
}
```

**The block step is part of the protocol.** `signalfd` consumes signals directed to the process or reading thread that are both in its mask and pending. If one thread leaves a process-directed signal unblocked, normal asynchronous delivery can select that thread instead. Block the set in `main` before thread creation so every child thread inherits it; audit threads created by libraries and reset masks deliberately in spawned programs.

The read returns fixed-layout `signalfd_siginfo` records in ordinary event-loop context. Handler async-signal restrictions no longer apply there, so normal logging and locking are available, subject to the event loop's own latency and reentrancy design. This suits termination, interrupt, hangup, child status, user-defined, and timer signals.

**The architectural limitation:** do not route synchronously generated `SIGSEGV`, `SIGBUS`, `SIGFPE`, or `SIGILL` through `signalfd`. POSIX does not define a useful recovery path when such a signal is generated while blocked, and the faulting thread cannot progress past the instruction. Crash diagnostics still require a minimal real handler, commonly on an alternate stack (§33.10).

Coalescing is unchanged: this changes the delivery channel, not the queuing model, so standard signals still collapse.

The POSIX alternative is to block the selected asynchronous signals and dedicate a thread to `sigwaitinfo`/`sigtimedwait`. Linux `signalfd` is convenient when descriptor readiness is already the program's coordination model.

**For a latency-critical thread:** keep process-directed control signals blocked and handle them on a designated housekeeping/event-loop thread. This removes signal-frame construction and `EINTR` branches from the critical thread. Synchronous faults still occur on the faulting thread. Verify masks at runtime—for example through `/proc/<pid>/task/<tid>/status` on Linux—and measure the intended core placement (Chapter 31).

---

## 33.10 Crash Handlers and Core Dumps — Role-specific

**The alternate stack.** If a thread exhausts its normal mapped stack, the kernel may be unable to place a signal frame there. `sigaltstack` registers alternate storage for the calling thread, and `SA_ONSTACK` tells the process-wide action to use it. Both are required, each thread that needs crash diagnostics needs its own stack, and the storage must remain live. `MINSIGSTKSZ` is a minimum for delivery, not a promise that a complex handler fits. Choose and test a bounded size for the target architecture and enabled register state; a guard page around the alternate stack makes its own overflow diagnosable.

A handler can distinguish overflow from a wild pointer by comparing the fault address against the thread's known stack bounds, which is worth reporting separately.

**Handler ownership matters.** Sanitizers, managed runtimes, profilers, and user-space paging mechanisms may install fault handlers. Installing another action replaces the previous one process-wide. Decide which component owns installation and chaining; naïvely calling a previous function pointer ignores masks, flags, `SIG_DFL`, and `SIG_IGN`.

**Core-dump dispositions.** POSIX/Linux defines a default core-producing action for faults such as `SIGILL`, `SIGABRT`, `SIGFPE`, `SIGSEGV`, and `SIGBUS` (Linux documents additional signals in `signal(7)`). Installing a handler replaces that default path. If diagnostics still require a core, the handler must restore/reach the default disposition rather than exit normally.

Then verify the complete operational path:

| Item | Why |
|---|---|
| The core-size resource limit | Frequently zero by default — **no core is written at all** |
| The core pattern | May name a file or pipe the core to a collector |
| `/proc/<pid>/coredump_filter` (Linux) | Selects mapping classes; inspect the running process instead of assuming shared or huge mappings are present |
| The dumpable flag | Can change after privilege or credential transitions |
| Collector destination | A configured collector can redirect storage away from the process directory |

Including large mappings can greatly increase dump time, storage, and collector I/O; excluding the shared ring can remove the evidence needed to explain the crash. Measure a staged crash with production-like mappings and set the filter and collector limits deliberately.

**Writing the handler.** Every constraint of §33.8 applies in the worst possible environment — the heap may be corrupt, locks may be held, the stack may be exhausted:

```cpp
#include <cerrno>
#include <cstdint>
#include <signal.h>
#include <unistd.h>

struct CrashRecord {
    int signal;
    int code;
    std::uintptr_t address;
};

volatile sig_atomic_t g_crash_fd = -1;  // fixed before installing handler

extern "C" void crash_handler(int sig, siginfo_t* info, void*) noexcept {
    const int saved = errno;
    const CrashRecord record{
        sig,
        info == nullptr ? 0 : info->si_code,
        reinterpret_cast<std::uintptr_t>(
            info == nullptr ? nullptr : info->si_addr)
    };
    (void)::write(static_cast<int>(g_crash_fd), &record, sizeof record);
    errno = saved;
    (void)::signal(sig, SIG_DFL);
    (void)::raise(sig);  // becomes pending; default action runs after handler return
}
```

This is POSIX/Linux best effort, not portable ISO C++ crash recovery. The descriptor is opened at startup; the handler performs no symbolization or heap allocation. A blocking sink can hang and a nonblocking pipe can drop the record when full, so choose that trade explicitly; any write can be partial, and the process can be too damaged to produce useful output. With ordinary automatic deferral of the current signal, restoring the default disposition and re-raising preserves the default core-producing path after handler return; calling `_exit` would skip it. Symbolize the binary record and core offline against the exact build identifier (Chapter 58).

Backtrace and symbolization helpers are not generally POSIX async-signal-safe. Lazy binding, allocator use, and unwinder locks can fail in the same corrupted process. If a library documents a constrained signal-safe mode for the exact platform, treat it as additional best-effort evidence rather than the only artifact.

**A C++-specific complement.** Uncaught exceptions, violated `noexcept`, and some failures during unwinding reach `std::terminate`. A terminate handler is not a POSIX signal handler, so async-signal-safe restrictions do not automatically apply; however, the program may already be compromised and the handler must finish by terminating. Keep it bounded, capture `std::current_exception` when meaningful, and retain the minimal signal/core path for faults that bypass C++.

---

## 33.11 Operational Inspection — Reference

*Skippable on a first pass. These Linux commands diagnose lifecycle and masks; availability and permissions vary by distribution.*

| Question | Useful inspection |
|---|---|
| Which AF_UNIX endpoints and queues exist? | `ss -x -a -p` |
| Which IPC descriptors does a process hold? | `ls -l /proc/<pid>/fd` and `/proc/<pid>/fdinfo/*` |
| What are this pipe's actual capacity and atomic-write bound? | `fcntl(fd, F_GETPIPE_SZ)` and `fpathconf(fd, _PC_PIPE_BUF)` in a probe |
| Which System V objects remain? | `ipcs -m -q -s`; remove a confirmed stale object with the corresponding `ipcrm` option |
| Which POSIX shared-memory names exist on typical Linux? | Inspect the mounted shared-memory filesystem, commonly `/dev/shm` |
| Which POSIX queues exist when `mqueue` is mounted? | Inspect `/dev/mqueue` |
| Which signals are blocked, pending, caught, or ignored? | Read `SigBlk`, `SigPnd`, `ShdPnd`, `SigCgt`, and `SigIgn` in `/proc/<pid>/status`; inspect each task for per-thread masks |
| Will Linux attempt a core and where? | Check the core resource limit, `/proc/sys/kernel/core_pattern`, `/proc/<pid>/coredump_filter`, and the active collector |

A minimal syscall trace can confirm crossings and blocking:

```sh
strace -f -ttT -e trace=read,write,sendmsg,recvmsg,futex,ppoll \
  ./ipc_test
```

`-f` follows children, `-ttT` timestamps calls and reports durations, and the filter keeps the trace bounded. Tracing changes scheduling and latency, so use it to confirm control flow—not to report production percentiles. For a load test, collect application timestamps and counters for sends, receives, queue-full outcomes, overwrite/lap events, futex waits, wakeups, `EINTR`, and peer reconnects. Averages hide the failure modes this chapter is trying to expose.

Cleanup is semantic, not cosmetic. Closing a descriptor releases one process reference; unlinking a POSIX shared-memory or FIFO name prevents new opens but does not invalidate existing references; System V objects require explicit removal; an abstract AF_UNIX address disappears with its final socket. Before automating cleanup, confirm the object's owner/generation so a stale-process janitor cannot remove the new process's live resource.

---

## 33.12 Recall and Practice — Core

**Recall card.**

1. Ordinary unbatched message channels usually pay send/receive crossings, payload copies, kernel queueing, and possibly wakeup; batching and readiness policy determine the per-message share.
2. Shared memory can remove steady-state payload syscalls and copies, but the application owns representation, publication, pressure, liveness, restart, and notification.
3. `is_always_lock_free` is necessary and not sufficient for cross-process atomics: address-freedom is a non-normative recommendation, so name the implementation, assert the layout, and guarantee alignment.
4. AF_UNIX adds valuable local semantics: stream/record choices, close detection, descriptor passing, and Linux peer-credential mechanisms.
5. Pending standard-signal instances can coalesce; POSIX real-time instances queue subject to limits.
6. Synchronously generated faults target the faulting thread. Block selected process-directed control signals before thread creation and centralize their handling.
7. In a real handler, preserve `errno`, use only audited async-signal-safe operations and permitted communication state, then return.
8. Stack-overflow diagnostics need a live per-thread alternate stack, `SA_ONSTACK`, a minimal handler, and a tested core-dump policy.

**Questions.**

1. Give the mechanism you would choose for three channels — a hot market-data path, an administrative control channel, and handing a listening socket to a child — and justify each in one sentence.
2. Why does a pipeline hang when the parent forgets to close the write end?
3. What exactly does `is_always_lock_free` guarantee about an atomic placed in shared memory, and what else must be true?
4. Describe the lost-wakeup race that futex wait exists to close, and name another interface in this chapter that closes the same race in a different context.
5. Under what scheduling/read timing can ten thousand `eventfd` writes coalesce into one read, what costs remain, and what changes in semaphore mode?
6. Why do relative periodic timers drift, and what are the two fixes?
7. Which thread receives a segmentation fault, a `kill` to the process, and a thread-directed signal? Why does that make process-wide handler dispositions a problem?
8. Why does a handler that formats a log message pass every test and deadlock in production?
9. What must be true, in three separate places, for a stack-overflow handler to run at all?
10. Your crash handler runs, writes a diagnostic, and calls the immediate-exit function. What did you lose?

### Common Traps

- Treating `SOCK_STREAM`, pipes, or FIFOs as record transports without an explicit framing and short-I/O loop.
- Hard-coding pipe capacity or confusing capacity with the `PIPE_BUF` atomic-write bound.
- Assuming a shared mapping makes ordinary pointers, allocators, mutexes, or non-lock-free atomics process-safe.
- Publishing a sleeping flag without rechecking work, creating a lost wakeup between the producer and waiter.
- Ignoring queue-full behavior because the nominal message rate is low.
- Blocking a control signal after worker creation, leaving an earlier thread eligible for asynchronous delivery.
- Calling a logger, allocator, mutex, symbolizer, or ordinary C++ container from a handler.
- Installing `SA_ONSTACK` without registering and retaining an alternate stack in every relevant thread.
- Calling `_exit` from a crash handler and then expecting the signal's default core-dump action.
- Assuming a core contains shared mappings without checking the live Linux dump filter and collector policy.

### Code-Reading Puzzle

```cpp
std::atomic<bool> stopping{false};
int wake_fd = ::eventfd(0, EFD_CLOEXEC);

void on_term(int) {
    stopping.store(true, std::memory_order_relaxed);
    const std::uint64_t one = 1;
    ::write(wake_fd, &one, sizeof one);
}
```

The program installs `on_term` for `SIGTERM` and usually shuts down correctly. Identify every unproven signal-safety or liveness assumption: consider the atomic specialization, access to `wake_fd`, blocking behavior when the counter cannot accept a write, `errno`, initialization order, and handler installation. Rewrite it using either the audited minimal-handler pattern or `signalfd`, and state which parts are C++23, POSIX, and Linux.

### Applied Exercise

Design the complete IPC layer for a system with one feed handler, three strategy processes, one order gateway, and one supervisor. For each channel, specify: mechanism, message framing, backpressure policy, what happens when the consumer is slower than the producer, and what happens when either side dies mid-message. Then write the signal plan: which signals are blocked in which threads, which thread handles them and how, what runs in handler context (ideally nothing), and what the crash path produces. Finally, write the async-signal-safety review checklist you would apply to any handler added later, and apply it to your own handler.

### Design Puzzle: The Obvious Optimization Is Wrong

A team replaces a UNIX-socket control channel with a shared-memory ring “for consistency with the data path.” Throughput and latency both improve in testing. In production, after a strategy crashes, the supervisor's next command is silently ignored; a malformed operator command corrupts a downstream process rather than being rejected. Explain both mechanically—what did the socket provide that the ring does not in liveness detection, framing, and authority—and state when a control plane should not share the data plane's transport.

### Prerequisites for Chapter 34

Chapter 34 assumes you can identify crossings, copies, queueing, and wakeups in an IPC path (§33.1), explain why batching changes per-message cost, and describe the user-space versus parked futex paths (§33.4). It owns syscall entry, short I/O, descriptor readiness, completion, and zero-copy I/O; this chapter does not reteach them.
