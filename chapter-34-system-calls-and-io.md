# Chapter 34 — System Calls and I/O

The durable mental model for operating-system I/O is a pipeline, not a function
call:

```
application
  │ request + user buffer
  ▼
libc wrapper → system-call boundary → kernel object → cache / device / peer
                                             │
                              block, queue, copy, or complete
```

Crossing into the kernel has a cost, but a copy, page fault, scheduler wake-up,
queue, device operation, or durability barrier can dominate it. An
interview-quality design therefore names which work exists, who owns each buffer,
where the caller can sleep, and what “complete” means.

This chapter is Linux-focused. **C++23** supplies the language used in examples,
but it does not standardize file descriptors or these I/O APIs. `open`, `read`,
`write`, `close`, `poll`, `mmap`, and related interfaces are **POSIX** unless
noted. `epoll`, `io_uring`, `O_DIRECT`, `sendfile`, `splice`, `statx`, and `/proc`
details are **Linux-specific**. `kqueue` is a BSD-family interface. Socket
lifecycle and protocol semantics belong to Chapter 45; the packet path belongs
to Chapter 46.

| Layer | What this chapter may rely on |
|---|---|
| Standard C++23 | Object lifetime, atomics used by libraries, error-safe wrappers; no descriptor API |
| POSIX | Descriptor-oriented calls and broad contracts, subject to option groups and platform details |
| Linux UAPI | epoll, io_uring, direct-I/O queries, `/proc`, and Linux syscall behavior |
| libc/liburing | User-space wrappers whose implementation and version can add behavior beyond the kernel ABI |
| Filesystem/device | Alignment, caching, persistence, queueing, and supported acceleration |

When two layers offer different guarantees, the narrowest deployed layer wins.
For example, POSIX may define a call shape while the Linux filesystem determines
whether a direct or accelerated path is supported.

## Why this matters — Core

Low-latency failures often appear far from the responsible call: a harmless
buffered write triggers later dirty-page throttling; a blocking read wakes on the
wrong CPU; an edge-triggered loop leaves bytes unread and never receives another
notification; a cancelled completion still owns a buffer that the application
has already reused.

The goal is not “avoid all syscalls.” It is to choose deliberately among:

- simple blocking I/O, where a thread represents an outstanding operation;
- readiness I/O, where the kernel reports which operation might make progress;
- completion I/O, where submitted work finishes later;
- memory-mapped, direct, or in-kernel transfer paths for particular file
  workloads.

## 90-second screen — Core

1. A system call changes privilege context; blocking may additionally cause the
   scheduler to run another task. Measure boundary, work, sleep, and wake-up
   separately.
2. A file descriptor is a process-local integer referring through a descriptor
   table to an **open file description**. Duplicates share offset and status
   flags; close-on-exec is per descriptor.
3. `read`, `write`, `readv`, and `writev` may complete partially. An
   `-1`/`EINTR` result means no transfer was reported before interruption;
   `EAGAIN`/`EWOULDBLOCK` means progress would block. Neither is a generic fatal
   error.
4. Non-blocking, synchronous/asynchronous, and readiness/completion are separate
   axes. `epoll` reports readiness; it does not perform the transfer.
5. Edge-triggered readiness requires non-blocking operations and draining until
   would-block, while still bounding work per descriptor for fairness.
6. `io_uring` shares submission and completion queues with the kernel, but
   feature support and execution paths vary by kernel, filesystem, operation,
   and policy. Probe rather than infer from headers.
7. Buffered I/O, `mmap`, direct I/O, and in-kernel transfer optimize different
   costs. Direct I/O is not automatically durable; `mmap` does not eliminate
   faults; “zero-copy” rarely means zero data movement everywhere.

Two decisions to defend:

- Where may this path wait, and what owns the outstanding operation while it
  waits?
- Is the dominant cost crossings, bytes copied, wake-ups, cache misses, page
  faults, queueing, or device service—and which measurement distinguishes them?

---

## Part I — Boundary, descriptors, and byte I/O

## 34.1 User Mode, Kernel Mode, and System-Call Cost — Core

Applications cannot directly execute privileged device-management operations or
access kernel-only mappings. They request kernel services through a defined
system-call ABI. A libc function such as `read` normally prepares arguments,
enters the kernel using the architecture’s syscall mechanism, and translates a
kernel error into `-1` plus thread-local `errno`. Calling a raw syscall number
directly is Linux- and architecture-specific and bypasses useful libc
adaptation.

On x86-64 Linux, `syscall`/`sysret` and a register convention are common; AArch64
uses `svc` and a different convention. Register assignments, entry instructions,
stack handling, and mitigation sequences are ABI details, not C++ or POSIX
rules. Even on one architecture, kernel-page-table isolation, speculation
mitigations, tracing, seccomp, audit hooks, signal delivery, and rescheduling
checks can change the entry/exit path.

```
user mode                     kernel mode
---------                     -----------
wrapper sets ABI arguments
      │
      ├── entry instruction ──► validate fd / flags / user range
      │                         find kernel object
      │                         copy, queue, wait, or operate
      ◄── return state ──────── set result or error
wrapper sets errno
```

A **mode transition** changes privilege context while the same task continues.
A **context switch** changes the running task. A syscall need not switch tasks;
a blocking syscall may do so when it cannot make progress. Conversely, the
scheduler can switch tasks without an application making a syscall, for example
after preemption.

| Component | Why it appears | How to observe or control it |
|---|---|---|
| Entry and exit | Architecture and kernel ABI | Microbenchmark a minimal real syscall on the target kernel |
| Mitigations and policy | KPTI, speculation controls, seccomp, audit | Record kernel command line, vulnerability state, and security policy |
| Descriptor/object lookup | Resolve integer to kernel object and operation | Batch operations or register stable resources where supported |
| User-memory access | Validate/fault/copy user buffers | Prefault, reuse, pin only with a budget, inspect faults |
| Blocking and wake-up | Operation cannot progress now | Scheduler tracepoints, voluntary context switches, run-queue delay |
| Device or filesystem work | Cache miss, allocation, queue, flush | Block/filesystem tracepoints and device latency |

Do not quote one universal syscall duration. Measure a distribution on named
hardware, kernel, mitigation state, CPU placement, clock source, and load.
Subtract or separately measure loop and timestamp overhead. A minimal syscall
benchmark answers only boundary questions; it does not predict a cache-missing
file read or a durability flush.

A useful accounting identity is:

```
operation latency
  = entry/exit
  + kernel work
  + data movement
  + queue wait
  + optional sleep/wake delay
  + device or peer service
```

Batching amortizes entry, lookup, and fixed bookkeeping over more work. It does
not remove bytes copied or device service, and waiting to fill a batch can worsen
latency. Busy polling avoids a sleep/wake cycle only by consuming CPU and power;
whether it helps depends on idle-gap distribution, CPU isolation, and the
application’s tail target.

### vDSO: avoiding some calls

Linux maps a **virtual dynamic shared object** (vDSO) into a process so selected
operations can execute in user space. `clock_gettime` is the familiar example:
when the requested clock and current kernel clocksource support a vDSO path,
user code reads kernel-maintained timekeeping data with consistency checks
instead of entering the kernel. Supported symbols and mechanisms depend on
architecture and kernel.

The vDSO is not tied universally to x86’s TSC. A clocksource or virtualization
change can force fallback on a particular system, but the condition is
architecture- and clock-specific. Chapter 35 owns clocksource selection. Two
diagnostic consequences matter here: `strace` cannot show a call that never
entered the kernel, and syscall filters do not mediate the user-space execution
itself.

## 34.2 Descriptor and Open-File Model — Core

A Unix “file” is a broad byte-oriented kernel object: regular files, directories,
pipes, terminals, devices, event sources, and sockets can be represented by file
descriptors. Their operations differ. In particular, not every descriptor is
seekable, pollable in a useful way, or persistent.

```
process descriptor table       system-wide open description       object
+----+------------------+       +-----------------------------+     +--------+
| 3  | ───────────────────────► | current offset              | ──► | inode, |
| 7  | ────────────────┐        | access mode                 |     | pipe,  |
+----+------------------+       | status flags: APPEND, ...   |     | device |
 FD_CLOEXEC per entry           | references                  |     +--------+
                               +-----------------------------+
          dup(3) can make 7 refer to the same open description
```

`open` creates or finds an open file description and installs a reference in the
calling process’s descriptor table. The returned integer is normally the lowest
available descriptor number. `read` and `write` operate through it. `close`
releases that descriptor-table entry; the open description remains alive while
another descriptor or kernel reference still refers to it.

`dup`, `dup2`, and `dup3` make another descriptor refer to the same open file
description. The duplicates therefore share:

- the current file offset;
- file status flags such as `O_APPEND` and `O_NONBLOCK`;
- the underlying object.

The close-on-exec flag is descriptor-specific. `O_CLOEXEC`, `dup3(...,
O_CLOEXEC)`, and creation APIs with a close-on-exec option avoid the race between
creating a descriptor and a second `fcntl` call in a multithreaded process that
may concurrently `fork` and `exec`.

After `fork`, parent and child descriptor entries refer to the same open file
descriptions. After `exec`, descriptors remain unless marked close-on-exec.
These rules explain why an unexpected process can keep a pipe open or advance a
file offset.

### Offsets, seeking, append, and positional I/O

For a seekable object, `lseek` changes the offset in the open description. A
successful ordinary `read` or `write` advances it. Duplicates sharing one
description therefore coordinate through one offset. POSIX `pread` and `pwrite`
take an explicit offset and do not change the shared current offset, making them
usually safer for concurrent positional file access.

Not every descriptor supports seeking; a pipe returns `ESPIPE`. Seeking beyond
the current end of a regular file and then writing can create a sparse region,
whose unread holes behave as zero bytes without necessarily occupying physical
blocks.

With `O_APPEND`, each `write` positions at end-of-file and writes as one atomic
offset-selection-plus-write operation under the filesystem’s semantics. That
does not combine multiple `write` calls into one record transaction, and remote
filesystems may emulate append with weaker failure behavior. Linux `pwrite`
appends when the open description has `O_APPEND`, ignoring the supplied offset;
this differs from POSIX `pwrite` semantics, so portable code must not combine
that flag with an assumption of independent positioning.

### Closing safely

Descriptor numbers are reused. Closing a descriptor while another thread may use
it creates an ownership race: a new `open` can reuse the integer before the old
thread acts. RAII prevents leaks in one ownership domain but does not synchronize
shared use. Establish one close owner, stop new operations, wait for outstanding
ones, then close.

Do not blindly retry `close` after an error. On Linux the descriptor is released
early except for invalid-descriptor cases, so a retry can close an unrelated,
newly reused descriptor. Other POSIX systems have historically differed. If
writeback failure matters, call the required synchronization operation before
`close` and handle its error; `close` is not a durability protocol.

Descriptor exhaustion is part of the design, not merely an operations setting.
`RLIMIT_NOFILE` bounds a process, while the system also has global file-object
limits. `EMFILE` and `ENFILE` therefore describe different exhaustion scopes.
Raising a limit without bounding application queues can move the failure into
memory, scheduler pressure, or a later kernel resource. Track descriptor count,
set a deliberate admission policy, and reserve capacity for diagnostics and
shutdown. Because descriptors are small reusable integers, never use the number
alone as a long-lived operation identity; pair it with owned connection/file
state and a generation when stale events are possible.

## 34.3 Short I/O, Errors, and Scatter/Gather — Core

`read(fd, buf, n)` asks for *up to* `n` bytes. A positive return is progress, zero
has object-specific end-of-input meaning, and `-1` reports an error through
`errno`. `write` similarly reports bytes accepted, not a promise that all bytes
were written or made durable.

Short transfers arise from available data, end-of-file, capacity, implementation
limits, signals after partial progress, and object semantics. Correct code tracks
an explicit cursor.

```cpp
#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <limits.h>
#include <unistd.h>

enum class IoState { complete, would_block, failed };

struct IoResult {
    std::size_t transferred{};
    IoState state{};
    int error{};                 // meaningful only for failed
};

IoResult write_until_blocked(int fd, const std::byte* data, std::size_t size) {
    std::size_t done = 0;
    while (done != size) {
        const auto* p = data + done;
        const std::size_t chunk =
            std::min(size - done, static_cast<std::size_t>(SSIZE_MAX));
        const ssize_t n = ::write(fd, p, chunk);
        if (n > 0) {
            done += static_cast<std::size_t>(n);
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return {done, IoState::would_block, 0};
        }
        return {done, IoState::failed, n < 0 ? errno : EIO};
    }
    return {done, IoState::complete, 0};
}
```

This POSIX example preserves partial progress. A caller receiving
`would_block` keeps the remaining buffer alive and waits for writability instead
of spinning. For a deadline-sensitive operation, an `EINTR` retry must also
recheck cancellation and recompute remaining time; “retry forever” can violate a
deadline even though each retry is locally valid.

`EINTR` means the operation was interrupted before it returned progress.
Restart behavior depends on the operation, signal disposition, flags, and
platform. `EAGAIN` and `EWOULDBLOCK` may have the same value on Linux but POSIX
allows them to differ, hence the two comparisons.

Atomicity is object-specific. POSIX gives writes of at most `PIPE_BUF` to a pipe
non-interleaving guarantees under stated conditions; that rule does not make
arbitrary file or stream writes transactional. Chapter 45 owns transport
framing. At this layer, retain the generic rule: byte streams do not preserve
application record boundaries.

### Scatter/gather I/O

POSIX `readv` and `writev` describe multiple memory regions in one call:

```cpp
#include <sys/uio.h>

iovec parts[] = {
    {.iov_base = header,  .iov_len = header_size},
    {.iov_base = payload, .iov_len = payload_size},
    {.iov_base = trailer, .iov_len = trailer_size},
};
const ssize_t n = ::writev(fd, parts, 3);
```

Vectored I/O can remove staging copies and amortize one syscall, but it remains a
single byte transfer and can be short. To resume, consume whole vectors covered
by the returned count, then advance `iov_base` and reduce `iov_len` for the
partially covered vector. Respect the runtime/platform vector-count limit
(`sysconf(_SC_IOV_MAX)` where available). The pointed-to storage must remain
valid for the duration of a synchronous call and until completion for an
asynchronous submission.

---

## Part II — Waiting, readiness, and completion

## 34.4 Blocking, Non-blocking, Synchronous, and Asynchronous — Core

These terms describe independent questions:

| Axis | First choice | Second choice |
|---|---|---|
| Caller waiting | Blocking: call may wait | Non-blocking: report would-block |
| Transfer timing | Synchronous: transfer belongs to the call | Asynchronous: submit now, complete later |
| Notification model | Readiness: operation may progress | Completion: operation has produced a result |

Non-blocking is a property of the open file description on POSIX/Linux, commonly
set with `O_NONBLOCK`; changing it through one duplicate affects the others. Set
creation flags atomically where an API supports that. Exact behavior depends on
the object. For regular files and block devices, Linux generally does not make
ordinary I/O meaningfully non-blocking merely because `O_NONBLOCK` is set; a
cache miss or filesystem work can still delay the call. Do not put unpredictable
regular-file access directly in an event-loop thread and assume the flag protects
the tail.

A synchronous buffered file write may return after copying data into the page
cache. It has completed as an API transfer but not necessarily reached stable
storage. An asynchronous file operation may be executed by hardware, kernel
code, or a worker thread; “asynchronous” describes the application contract, not
the implementation mechanism.

### Sleep, wake-up, and polling

When a blocking operation cannot progress, the kernel can enqueue the task on a
wait queue and schedule another task. Later, an event marks it runnable; it then
waits for CPU scheduling and resumes. The resulting tail includes run-queue
delay, CPU migration, idle-state exit, and cold execution state in addition to
the original syscall.

```
call → inspect object → not ready → enqueue waiter → schedule away
                                             event → wake → runnable
                                                       │
                                  scheduler delay ◄────┘
                                      resume → finish → return
```

Busy polling repeatedly tests progress instead. It trades scheduler/wakeup
variance for a dedicated CPU budget, cache and memory traffic, power, and thermal
effects. A hybrid can spin for a measured interval and then arm a wait. The
choice must be based on the distribution of idle gaps and wake-up latency, not a
fixed folklore threshold.

### A cost worksheet: crossings, copies, wake-ups, and queues

Before changing an interface, classify the work per logical record:

| Term | Scales with | Typical reduction | What can get worse |
|---|---|---|---|
| Boundary/setup | calls or submissions | Vectored/batched calls, registered resources | Batch-fill delay, larger failure unit |
| Data copy | bytes and memory locality | Mapping, in-kernel transfer, direct paths | Pinning, page faults, ownership complexity |
| Sleep/wake | idle episodes and scheduling | Polling, affinity, isolated worker | CPU/power use, contention, fairness |
| Queue wait | arrival burst and service capacity | Capacity, admission control, balanced queue depth | Dropping/rejection or underutilization |
| Device service | access pattern and hardware | Coalescing, parallelism, layout | Write amplification, tail queueing |
| Durability | barrier/group policy | Group commit | Added acknowledgement delay and loss window policy |

Suppose a producer generates logical operations at rate `λ` and batches up to
`B` operations per submission. Under sustained full batches, submission rate is
approximately `λ/B`; this estimates only the fixed work that batching can
amortize. Under sparse or bursty traffic, time-to-fill becomes part of latency.
Every batcher therefore needs both a size limit and a time limit, plus a rule for
urgent work.

Queue depth is similarly two-sided. Too little concurrency can leave a device or
worker idle. Too much moves waiting into the queue and can make cancellation and
tail latency worse. For a stable system, Little’s law relates average outstanding
work `L`, average completion rate `λ`, and average time in system `W` as
`L = λW`. It is an average identity, not a tail guarantee. Use it to catch
impossible capacity claims, then inspect queue-age and high-percentile service
time.

Backpressure closes the model. When a queue or buffer pool is full, choose among
blocking the producer, rejecting/dropping according to semantics, replacing
older work, or propagating a would-block state. An “unbounded async queue” merely
converts I/O pressure into memory growth and stale work. The queue-full decision
belongs beside buffer ownership because an item accepted into a queue has
already transferred responsibility even though kernel I/O has not started.

## 34.5 Readiness: `select`, `poll`, `epoll`, and `kqueue` — Core

Readiness APIs report that an operation of a given kind should not block *at that
instant*. State can change before the application acts, another thread can
consume the condition, and errors can coexist with readable data. Use
non-blocking operations even after a readiness event.

The meaning remains object-specific. On Linux, regular files generally appear
immediately ready to `select`/`poll`, while `epoll_ctl` commonly rejects regular
files with `EPERM`; neither behavior says the data is resident in memory.
Readiness is therefore not a regular-file cache-miss completion mechanism.

```
readiness:
  register/wait ──► “fd may be readable” ──► read()
                                            ├─ bytes
                                            ├─ EOF
                                            └─ would-block (state changed)

completion:
  submit read(fd, buffer) ──► later CQ result + bytes already in buffer
```

`select` represents descriptor sets as bit sets and modifies them on return.
`FD_SETSIZE` limits what the conventional interface can safely represent, so
descriptor values must be checked rather than copied into an undersized
`fd_set`. `poll` accepts an array without that descriptor-number encoding limit,
but the kernel and application examine an array proportional to the interest-set
size on each wait.

For a small fixed set, `poll` can be the simplest and fastest-enough answer.
Asymptotic superiority does not compensate for unnecessary registration,
state-management, and cache footprint.

Linux `epoll` separates registration from waiting. The kernel maintains an
interest structure and a ready list, so `epoll_wait` returns ready entries rather
than requiring the caller to resubmit and scan the whole interest set.

```cpp
#include <cerrno>
#include <cstddef>
#include <sys/epoll.h>
#include <unistd.h>

int drain_readable(int fd, std::byte* buf, std::size_t capacity) {
    // Precondition: capacity > 0.
    for (;;) {
        const ssize_t n = ::read(fd, buf, capacity);
        if (n > 0) {
            consume(buf, static_cast<std::size_t>(n));
            continue;
        }
        if (n == 0) return 0; // object-specific EOF/closure handling
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 1;
        return -1;
    }
}
```

This is the inner loop used after an edge-triggered readable event. `consume` is
application code. In a complete loop, `epoll_create1(EPOLL_CLOEXEC)` creates the
instance, `epoll_ctl` registers an event and user token, and `epoll_wait` returns
a bounded array of events.

### Level-triggered versus edge-triggered

Level-triggered reporting continues while a condition remains true.
Edge-triggered reporting emphasizes transitions. With `EPOLLET`, drain a
non-blocking descriptor until would-block before waiting again; otherwise
unconsumed work can remain without a new transition to report. A blocking final
read can stall the entire loop.

| Concern | Level-triggered | Edge-triggered |
|---|---|---|
| Residual readiness | Reported again | Application must preserve/drain state |
| Non-blocking operations | Strongly recommended | Required for a safe drain loop |
| Bookkeeping | Often simpler | More application state |
| Hot source fairness | Still must bound work | Drain requirement makes starvation especially easy |
| Common failure | Repeated events for ignored state | Silent stall after incomplete drain |

“Drain” does not mean monopolize the event loop forever. Cap bytes, operations,
or time per source, place residual work on an application ready queue, and rotate
fairly. For output, register writable interest only while data is queued in a
level-triggered design; writable conditions are often persistent.

`EPOLLONESHOT` disables an entry after delivering an event and requires rearming,
which can serialize ownership across worker threads. Linux `EPOLLEXCLUSIVE`
(available since Linux 4.5) can reduce thundering-herd wake-ups for supported
registrations. Both require design and testing; neither repairs unsynchronized
connection state.

The epoll identity is the combination of descriptor number and open file
description. Duplicates can therefore create surprising lifetime behavior:
closing one descriptor does not necessarily remove interest while another
reference to the same open description remains. Explicitly delete registrations
before complicated duplication/close sequences.

BSD-family `kqueue` combines change registration and event retrieval and covers
several event classes through filters. It is not a portable synonym for epoll:
flags, EOF reporting, event data, and supported object types differ. Portable
event libraries exist precisely because the semantic adapters are nontrivial.

## 34.6 Completion I/O and `io_uring` — Core

In a completion model, the application submits an operation with its resources
and later receives a result. From successful submission until the operation’s
terminal completion, referenced buffers and metadata must obey the interface’s
lifetime rules. Cancellation is another asynchronous operation, not permission
to free memory immediately.

Linux introduced `io_uring` in 5.1. User space and the kernel communicate through
memory-mapped submission and completion structures, with syscalls used to set up,
register resources, submit/wake, or wait as required by the configured mode.
Applications can have multiple producers; the queues should not be described as
universally single-producer/single-consumer. Use liburing or implement the
specified atomic ordering carefully.

```
user                                  kernel / worker / device
----                                  ------------------------
reserve SQE
fill opcode, fd, buffer, user_data
publish submission ─────────────────► execute now, queue, or delegate
                                      write CQE {user_data, result, flags}
consume CQE ◄──────────────────────── publish completion
release/reuse operation resources
```

A compact **liburing** example for regular-file reads:

```cpp
#include <liburing.h>

io_uring ring{};
if (io_uring_queue_init(64, &ring, 0) < 0) fail();

io_uring_sqe* sqe = io_uring_get_sqe(&ring);
if (!sqe) fail();
io_uring_prep_read(sqe, fd, buffer, length, offset);
io_uring_sqe_set_data64(sqe, operation_id);
if (io_uring_submit(&ring) < 0) fail();

io_uring_cqe* cqe = nullptr;
if (io_uring_wait_cqe(&ring, &cqe) < 0) fail();
const int result = cqe->res; // nonnegative byte count, or negative errno
const auto id = io_uring_cqe_get_data64(cqe);
handle_completion(id, result);
io_uring_cqe_seen(&ring, cqe);
```

This snippet omits shutdown and buffer ownership machinery to expose the state
transition. Production code must keep `buffer` alive, handle short reads, ensure
`operation_id` cannot alias an old outstanding operation, drain every CQE, and
call `io_uring_queue_exit`.

### What the rings change—and what they do not

Submitting several SQEs together amortizes fixed entry work. Chaining can express
dependencies without a user-space round trip. A completion queue decouples
finished work from the thread that submitted it. None of those facts guarantees
that the kernel never blocks internally, that storage is durable, that no copy
occurs, or that an individual operation has lower latency than a direct
synchronous call.

Buffered regular-file operations may complete from cache, fault, or use io-wq
worker context when work can block. Direct I/O may map more naturally to device
asynchrony, subject to filesystem and device support. The completion contract is
stable; the execution mechanism is conditional.

### Registration and polling modes — Role-specific

Registered files can avoid repeated descriptor-to-file reference setup.
Registered buffers can avoid repeating memory-registration work and may pin
memory, consuming a bounded system resource. Provided-buffer mechanisms let the
kernel choose from an application-owned pool when an operation needs storage.
Each changes teardown: unregister or observe all completions before freeing,
closing, unmapping, or reusing the resource.

`IORING_SETUP_SQPOLL` creates a kernel submission-polling thread that can consume
published SQEs without a syscall on an active steady-state path. It may sleep
after an idle interval and need waking. CPU affinity, power, idle policy, and
kernel-version permissions are deployment choices, not automatic wins.

`IORING_SETUP_IOPOLL` asks for polled completion on supported storage paths and
is associated with direct-I/O/device constraints. It trades interrupts for CPU
polling. Do not conflate SQ polling (how submissions are noticed) with I/O
polling (how completions are detected).

The interface evolves quickly. Base rings date to Linux 5.1, but provided-buffer
forms, multishot operations, ring registration, restrictions, and opcode details
arrived across later kernels and continue to gain flags. Header availability
does not prove the running kernel, filesystem, device, container policy, or
security profile supports a feature. Use liburing feature-probe facilities,
check every setup/registration result, define a fallback, and record the minimum
tested kernel in deployment requirements. Some environments restrict
`io_uring`; the applicable seccomp, LSM, sysctl, or service policy is
distribution/version-specific.

### Cancellation and lifetime

Tag every logical operation with unique `user_data`. Cancellation can race with
normal completion. A cancellation request’s CQE describes the cancellation
request; the original operation’s CQE remains the authoritative terminal result
for that operation. Retain its buffer and state until the protocol proves the
original can no longer access them. Also handle “not found” as a possible sign
that the target already completed or is completing, rather than as permission to
reuse memory blindly.

POSIX AIO should be described separately. The POSIX API defines an asynchronous
contract, but common glibc implementations have used user-space worker threads;
that is an implementation fact, not a POSIX requirement. Linux’s older native
AIO interface was designed primarily around file/block workloads and has
operation/filesystem-dependent behavior. Neither should be summarized as “all
POSIX AIO is fake” or “Linux AIO supports only one exact path.”

---

## Part III — Regular-file paths and bulk transfer

## 34.7 Buffered I/O, `mmap`, Direct I/O, and In-Kernel Copy — Core

The right file path depends on access pattern, reuse, ownership, durability, and
tail behavior.

### Buffered `read`/`write`

Ordinary regular-file I/O normally uses the Linux page cache. A cached read
copies from cache pages to the user buffer. A cache miss can initiate storage I/O
and block the caller. A buffered write usually copies into cache and marks pages
dirty; writeback occurs later. Under memory or dirty-page pressure, an
application write can be throttled or forced to participate in reclaim/writeback,
creating latency far after the writes that accumulated the debt.

Benefits include readahead, write coalescing, reuse across processes, and simple
ownership. Costs include the user/kernel copy, cache pollution for one-pass
data, and writeback/reclaim variance.

`fsync`/`fdatasync` express synchronization requirements, but durable semantics
still depend on filesystem, device cache behavior, ordering, errors, and what
metadata must survive. A successful `write` is not a durability statement.

### Memory mapping

POSIX `mmap` maps file-backed pages into an address range. Loads and stores then
look like memory accesses, but the first access may fault and initiate I/O.
Mapping moves the I/O boundary from explicit calls to page faults; it does not
make the work disappear.

Advantages:

- random access without an explicit copy into an application buffer;
- the page cache and virtual-memory system manage residency;
- pointer-based parsing can be convenient for stable, validated files.

Hazards:

- major faults can block at unpredictable instruction sites;
- truncation or storage errors can surface as signals such as `SIGBUS`;
- pointers and views depend on mapping lifetime and file-size stability;
- address-space use and page-table footprint matter for large mappings;
- dirty shared mappings still need an explicit persistence protocol.

`madvise`/`posix_madvise` are hints, not guarantees. Linux `MAP_POPULATE` and
manual prefaulting change when work occurs and can create large startup bursts.
`msync` can request writeback for mapped ranges; use the filesystem’s documented
`fsync`/metadata sequence when crash durability matters.

### Direct I/O

Linux `O_DIRECT` attempts to transfer between user memory and storage while
bypassing the page cache. It can reduce copies, cache pollution, and buffered
writeback interactions, but gives up cache reuse, readahead, and coalescing that
might have helped. It is a workload contract, not a generic “faster” flag.

Buffer address, length, and file-offset alignment requirements are
filesystem/device-specific and can differ for reads and writes. Since Linux 6.1,
`statx` with `STATX_DIOALIGN` can report direct-I/O alignment when the filesystem
supports that query. Lack of reported information requires filesystem-specific
documentation or a validated fallback; a block device’s logical block size is
not a universal substitute for every filesystem rule.

```cpp
// Linux-specific sketch; validate alignment before allocation and I/O.
void* storage = nullptr;
if (::posix_memalign(&storage, memory_alignment, transfer_size) != 0) fail();
const ssize_t n = ::pread(fd, storage, transfer_size, aligned_offset);
```

Direct I/O is not synonymous with asynchronous I/O and not synonymous with
durability. Device volatile caches and filesystem ordering still exist.
Mixing direct I/O with buffered I/O or writable mappings over overlapping ranges
can introduce coherency and performance hazards; Linux documentation generally
recommends avoiding that mixture.

### In-kernel and “zero-copy” transfer

POSIX `readv`/`writev` avoid application staging copies but still transfer
between user memory and the kernel. Linux `sendfile` can transfer from a file
descriptor to another supported descriptor without a user-space bounce buffer.
Linux `splice` moves data between supported descriptors through a pipe, often by
passing references to kernel buffers. `copy_file_range` requests an in-kernel
file-to-file copy and may exploit filesystem acceleration or fall back according
to kernel/filesystem rules.

All can return partial progress and have object/filesystem restrictions.
“Zero-copy” names the eliminated copy; pages may still be read from storage,
checksummed, mapped for DMA, copied by hardware, or retained until asynchronous
completion. For small transfers, setup and notification can cost more than the
copy saved. Measure CPU time, memory bandwidth, cache misses, throughput, and
tail latency separately.

### File-path chooser

| Path | Strong fit | Main costs/risks | Completion means |
|---|---|---|---|
| Buffered `read`/`write` | Reused data, sequential access, simplicity | Copy, cache pressure, faults/writeback | Bytes copied to/from page cache |
| `mmap` | Random reads, shared cache, pointer-oriented access | Fault location, signals, mapping lifetime, page tables | Load/store completed; persistence separate |
| Direct I/O | Application-managed cache, aligned large transfers, bounded page-cache interference | Alignment, no cache help, coherency constraints | Transfer finished; durability separate |
| `sendfile`/`splice`/`copy_file_range` | Bulk movement between supported kernel objects | Compatibility, partial progress, retained pages | Requested kernel transfer made reported progress |
| `io_uring` around a file path | Queue depth, completion ownership, batching/cancellation | Versioning, resource lifetime, queueing | CQE result; durability only if requested operation provides it |

## 34.8 Worked Diagnosis: A Journal’s p99 Spikes — Core

Assume a journal thread appends fixed-size records with buffered `write`. Median
latency is stable, but p99 periodically jumps. CPU utilization is moderate, and
the team proposes replacing each call with `io_uring` because “syscalls are the
problem.”

### Step 1: state the correctness requirement

Does the latency measurement end when bytes enter the page cache, when a group
is synchronized, or when the storage stack confirms durability? These are
different operations. If acknowledgements currently follow plain `write`, the
system may already have a correctness gap that an interface change will not fix.

### Step 2: decompose the delay

Instrument at least:

- syscall duration distribution and counts;
- voluntary/involuntary context switches and run-queue delay;
- major/minor faults;
- dirty-page volume and dirty throttling;
- filesystem writeback and block request issue/complete latency;
- queue depth and synchronization latency;
- CPU migration and competing work.

If spikes correlate with dirty limits and writeback while boundary-only calls
remain stable, removing submission syscalls attacks the wrong term. If the
journal thread sleeps waiting for synchronous storage, completion I/O can free
that thread or maintain queue depth, but the device service distribution remains.

### Step 3: compare candidate repairs

1. **Buffered grouped sync:** append several records, then `fdatasync` under a
   maximum age/size policy. This amortizes barriers but intentionally delays the
   earliest record in a group.
2. **Preallocated direct-I/O segments:** aligned buffers and offsets can isolate
   the path from page-cache writeback, but require an application cache,
   padding/recovery format, and explicit durable flush semantics.
3. **Completion queue:** submit writes and synchronization with explicit
   dependencies, retaining buffers until CQEs. This improves concurrency and
   ownership visibility; it does not guarantee a faster device.
4. **Dedicated blocking worker:** often the simplest isolation if queue depth is
   low and one thread per storage path is affordable.

### Step 4: price batching

If records arrive at rate `λ` and a full batch contains `B` records, the syscall
or submission rate approaches `λ/B` under steady full batches. But a record
arriving just after a batch starts can wait approximately `(B-1)/λ` for a full
batch, with about half that fill delay on average under evenly spaced arrivals.
A time cap bounds sparse-period waiting. This calculation makes the trade
explicit; it is not a recommendation to wait for full batches.

### Step 5: define success and rollback

Replay the same record-size, arrival-burst, durability, filesystem, device,
queue-depth, and co-tenant workload. Compare p50/p99/p99.9 acknowledgement
latency, CPU, write amplification, recovery correctness, and lost-record
behavior under power-failure testing appropriate to the platform. Keep the
buffered implementation as a rollback until the direct/completion path proves
both recovery and latency.

## 34.9 Choosing an I/O Model — Core

Choose correctness and ownership first, then latency mechanism.

| Workload question | Blocking | Readiness | Completion |
|---|---|---|---|
| Outstanding concurrency | Thread/task per wait is affordable | Many descriptors, operations initiated only when ready | Many operations must remain in flight |
| Regular-file cache misses | Isolate on worker; simple | Poor fit | Good fit when supported execution path is understood |
| Buffer ownership | Call returns before reuse | Application supplies buffer at transfer call | Buffer retained until terminal completion |
| Cancellation | Interrupt/close/task protocol; platform details | Remove interest and stop issuing work | Submit cancel, handle race, await original terminal state |
| Batching | Vectored or worker queue | Batch returned events and transfers | Batch SQEs/CQEs, link where semantics require |
| Tail risk | Scheduler wake-up and head-of-line blocking | Event-loop fairness and handler blocking | Queue depth, worker fallback, CQ handling, resource lifetime |
| Complexity | Lowest | Moderate state machine | Highest lifecycle/version surface |

A repeatable procedure:

1. Define what completion means: copied, consumed, synchronized, or durable.
2. Name maximum outstanding operations and who owns every buffer.
3. Identify where waiting is allowed and what a blocked worker can delay.
4. State arrival shape and permissible batching delay.
5. Write cancellation, shutdown, descriptor-close, and resource-exhaustion
   transitions before optimizing.
6. Measure the named cost terms on the deployment kernel and hardware.
7. Prefer the simplest model that meets the tail target with headroom.

For a small control plane, blocking calls on a bounded worker set are often
appropriate. For thousands of intermittently ready descriptors, readiness
avoids a thread stack and scheduler entity per wait. For a storage engine keeping
many independent reads in flight, completion I/O can expose device concurrency.
For a latency-critical polling path, a dedicated non-blocking loop may avoid
wake-ups, but it spends a core and must not perform blocking file access.

Do not infer “edge-triggered,” “SQPOLL,” “direct,” or “mmap” from the phrase
low-latency. Each is a conditional tool with a failure mode.

---

## Part IV — Observability and versioned reference

## 34.10 Observing the Path — Role-specific

`strace` uses ptrace-style syscall observation and materially perturbs a
syscall-heavy process. Use it to answer behavioral questions—what call failed,
which path was searched, where a process blocks—not to claim production latency.
`strace -c` provides counts and accumulated traced time, still under tracing
overhead. It cannot display vDSO-only execution as a syscall.

Examples:

```bash
strace -f -e trace=openat,read,write,close -o trace.log ./program
strace -c -f ./program
perf stat -r 10 -e cycles,instructions,context-switches,page-faults ./program
```

`perf trace`, scheduler/filesystem/block tracepoints, and eBPF tools can aggregate
in the kernel and reduce per-event handoff, but they still have overhead and
require a supported kernel/security configuration. Record tool version and
sampling/filter choices. `/proc/<pid>/status` exposes voluntary and involuntary
context-switch counts; `/proc/<pid>/fd` and `fdinfo` help inspect descriptors and
some object-specific state.

`ltrace` observes selected dynamic-library calls, not kernel entry. Static
linking, symbol visibility, inlining, direct calls, and loader details limit its
coverage. User probes or application instrumentation may be more reliable for a
specific library boundary.

A useful test sequence is:

1. reproduce without tracing and capture the end-to-end distribution;
2. use counts/low-overhead sampling to locate the layer;
3. enable targeted tracing for a short interval;
4. verify the proposed mechanism with a counter that should change;
5. rerun the clean benchmark.

## 34.11 Version and Portability Reference — Reference

| Facility | Contract/source | Important qualification |
|---|---|---|
| `open/read/write/close`, `pread/pwrite` | POSIX | Error/restart and object behavior still vary |
| `readv/writev`, `poll`, `mmap` | POSIX families/options | Limits and supported object semantics vary |
| `select` | POSIX | Conventional `fd_set` representation has a fixed safe range |
| `epoll` | Linux | Not a portable replacement name for kqueue |
| `EPOLLEXCLUSIVE` | Linux 4.5+ | Supported registration/event combinations only |
| `kqueue` | BSD family | Filters and flags differ across BSD/macOS releases |
| `io_uring` base API | Linux 5.1+ | Opcode/flag/resource/security support must be probed |
| `STATX_DIOALIGN` | Linux 6.1+ when filesystem reports it | Absence does not imply one default alignment |
| `O_DIRECT` | Linux extension with filesystem support | Alignment/coherency/behavior are filesystem-specific |
| `sendfile`, `splice`, `copy_file_range` | Linux forms discussed here | Descriptor combinations and fallback behavior vary |
| vDSO | Linux, architecture-specific | Exported symbols and fast-path eligibility vary |

### Common traps

- Treating a successful buffered `write` as durable.
- Assuming an rvalue buffer or stack `iovec` outlives an asynchronous operation.
- Retrying `EAGAIN` immediately instead of arming readiness or applying
  backpressure.
- Restarting a timeout-bearing call after `EINTR` without recomputing its
  deadline.
- Closing a shared descriptor while another thread can still issue operations.
- Using edge-triggered readiness with a blocking descriptor or incomplete drain.
- Reusing an `io_uring` buffer after the cancellation CQE but before the original
  operation reaches a terminal state.
- Hard-coding direct-I/O alignment from one machine.
- Mixing overlapping buffered, mapped, and direct writes without a documented
  coherency protocol.
- Calling a path “zero-copy” without naming which copy was removed.

## Recall Card — Core

- System-call latency is boundary plus kernel work, copies, queueing, optional
  sleep/wake, and device/peer service.
- A descriptor is process-local; duplicates share an open file description,
  including offset and status flags. Close-on-exec is per descriptor.
- Positive short I/O is progress. Preserve the cursor. `EINTR` is retry/deadline
  logic; would-block is readiness/backpressure logic.
- Non-blocking and asynchronous are different. Readiness precedes a transfer;
  completion follows a submitted transfer.
- Edge-triggered loops drain until would-block and enforce a fairness budget.
- An `io_uring` CQE carries a byte count or negative error. Outstanding resources
  remain owned by the operation until its terminal lifecycle is resolved.
- Buffered I/O uses the page cache; `mmap` shifts work into faults; direct I/O
  bypasses the page cache subject to alignment; none alone guarantees durability.
- Batch only under a maximum-delay policy, and measure the cost term the batch is
  intended to amortize.

## Questions — Core

1. Decompose a blocking cache-missing read into boundary, scheduler, memory, and
   device terms. Which tracepoints or counters distinguish them?
2. Two descriptors were created with `dup`. Which flags and offsets do they
   share, and which flag remains descriptor-local?
3. A non-blocking writer has transferred 600 of 1,000 bytes and receives
   `EAGAIN`. What state must survive, and what should trigger the retry?
4. Why can `epoll` report readability followed by a read that would block? What
   design rule makes that race harmless?
5. Compare cancellation in readiness and completion designs. When may each
   buffer be reused?
6. An edge-triggered handler drains an always-active source forever. It is
   correct about bytes but wrong as an event loop. Diagnose and repair it.
7. Under what workload can `poll` beat a registered readiness structure despite
   its linear scan?
8. Why might `io_uring` improve throughput but leave median storage latency
   unchanged?
9. Choose between buffered I/O, `mmap`, and direct I/O for a one-pass scan, a
   reused random-read index, and an application-managed journal cache. Which
   assumptions could reverse each choice?
10. What does `STATX_DIOALIGN` tell you, and what must the program do when the
    running kernel/filesystem does not report it?

## Code-Reading Puzzle — Core

```cpp
void cancel_and_reuse(io_uring& ring, Operation& op) {
    submit_cancel(ring, op.id);
    const Completion c = wait_one(ring);
    if (c.id == op.cancel_id) {
        refill(op.buffer);       // reused immediately
        submit_read(ring, op);   // same id and buffer
    }
}
```

Identify every invalid assumption. Consider completion ordering, a normal
completion racing cancellation, whether `wait_one` returns the cancellation or
original CQE, identifier reuse, buffer ownership, and how many completions must
be drained. Sketch a state machine that makes reuse provably safe.

## Implementation Exercise — Core

Design the I/O layer for four paths:

- a small administrative service with modest concurrency;
- an event loop managing many intermittently active descriptors;
- a journal requiring bounded acknowledgement latency and crash recovery;
- a large immutable index queried randomly by several processes.

For each, choose blocking, readiness, or completion; then choose buffered,
mapped, or direct file access where applicable. State:

1. the definition of completion/durability;
2. maximum outstanding operations and queue-full policy;
3. buffer and descriptor ownership through cancellation/shutdown;
4. batching size and maximum batching delay;
5. portability/kernel minimum and fallback;
6. measurements and rollback threshold.

Do not design socket protocol behavior here; Chapter 45 owns that layer.

## Prerequisite for Chapter 35 — Core

Chapter 35 assumes you can separate a privilege transition from a task switch,
explain why vDSO calls may avoid kernel entry, and trace blocking latency into
queueing and wake-up terms. It then applies those distinctions to clocks,
timestamping, CPU placement, power management, and host tuning.
