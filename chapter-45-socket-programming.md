# Chapter 45 — Socket Programming

## Why this matters — Core

A socket program does not “send a message to the network.” It asks the kernel to move bytes between user memory and queues associated with an endpoint. The return value reports what that call accomplished, not what the peer application observed. Correct code therefore has to manage four things explicitly: descriptor lifetime, protocol-specific I/O boundaries, readiness state, and bounded queues.

That model explains the production bugs that socket interviews target. A TCP `send` may accept only a prefix. A TCP `recv` may split or coalesce application records. A UDP receive can consume and truncate one whole datagram. A writable non-blocking connect may have failed. Closing one descriptor may not destroy a socket shared through `dup`. An event loop can spin forever because it watches `EPOLLOUT` with nothing pending, or go silent because an edge-triggered socket was not drained.

This chapter covers the POSIX socket API and labels Linux extensions explicitly.
Chapter 37 owns UDP/multicast wire behavior, membership, and loss recovery.
Chapter 38 owns TCP sequencing, retransmission, flow/congestion control, and
Nagle/delayed-ACK mechanisms. Chapter 46 owns Linux packet traversal, `sk_buff`,
NAPI, offloads, steering, and device queues. Here the question is narrower: how
does an application use sockets without losing bytes, corrupting messages,
hiding backpressure, or misreading failure?

## 90-second screen — Core

Retain these facts:

1. A file descriptor is a process-local handle. The socket may remain alive through another descriptor or process; `FD_CLOEXEC`, `O_NONBLOCK`, socket options, and connection state do not all have the same ownership.
2. TCP is a byte stream. Both `send` and `recv` can make partial progress. Buffer unsent bytes in order and parse received bytes incrementally.
3. UDP preserves datagram boundaries. One receive consumes one datagram; a short buffer can discard the remainder, and a return value of zero can mean a valid empty datagram.
4. Non-blocking means “attempt now,” while readiness means “the operation might now make progress.” Readiness is stale by the time code acts, so `EAGAIN` remains normal.
5. A successful send means bytes were accepted by the local kernel. Transport acknowledgement and application acknowledgement are different milestones.
6. `shutdown(SHUT_WR)` ends one direction of a stream; `close` releases a descriptor reference. Neither proves that the peer processed preceding data.

Be ready to defend two decisions:

- Choose blocking I/O for a small, ownership-simple thread-per-session design; choose non-blocking readiness when one thread must bound work across many descriptors. Do not choose edge triggering until the drain/re-arm invariants are explicit.
- Size application and socket queues from burst, service-rate, and failure requirements. Larger buffers reduce immediate blocking or drops but increase memory and stale-data queueing.

## 45.1 Descriptors, Endpoints, and Addresses — Core

### The ownership layers

`socket()` creates a kernel communication endpoint and returns a descriptor referring to it. A useful application-level ownership diagram is:

```text
process fd table          open file description             socket/protocol state
  fd 7  ───────────────►  status flags, file offset  ─────► local/peer address,
  fd 9 (after dup) ─────►  (shared by dup'd fds)             queues, options, state

per-descriptor: FD_CLOEXEC
shared file-status flag: O_NONBLOCK
shared socket state: addresses, options, shutdown, queued data
```

This distinction predicts behavior:

- `dup`, `dup2`, `fork`, and descriptor passing can create another reference. `close(fd)` releases one reference; final socket destruction occurs only after the last reference is gone.
- `FD_CLOEXEC` is a descriptor flag. Set it atomically at creation where the platform supports that, so another thread cannot `fork`/`exec` during a `socket`-then-`fcntl` window.
- `O_NONBLOCK` is a file-status flag associated with the shared open file description. Changing it through one duplicated descriptor affects the others.
- Socket options and `shutdown` affect the underlying socket, not merely one integer descriptor.

**Linux:** since 2.6.27, `SOCK_CLOEXEC | SOCK_NONBLOCK` may be ORed into
the `type` argument to `socket`; `accept4` (Linux 2.6.28+) can apply the same
flags to an accepted socket. These interfaces avoid both extra calls and races.
POSIX specifies `socket` and `accept`, but not these Linux flag forms. Code
targeting other systems must use their atomic facilities where available or
carefully control process creation.

An RAII wrapper should be move-only and should never retry `close` blindly:

```cpp
#include <unistd.h>
#include <utility>

class UniqueFd {
  public:
    explicit UniqueFd(int fd = -1) noexcept : fd_(fd) {}
    ~UniqueFd() { if (fd_ >= 0) ::close(fd_); }
    UniqueFd(const UniqueFd&) = delete;
    UniqueFd& operator=(const UniqueFd&) = delete;
    UniqueFd(UniqueFd&& other) noexcept
        : fd_(std::exchange(other.fd_, -1)) {}
    UniqueFd& operator=(UniqueFd&& other) noexcept {
        if (this != &other) {
            if (fd_ >= 0) ::close(fd_);
            fd_ = std::exchange(other.fd_, -1);
        }
        return *this;
    }
    [[nodiscard]] int get() const noexcept { return fd_; }
  private:
    int fd_;
};
```

On Linux, `close` releases the descriptor even when it reports an error; retrying can close an unrelated object if another thread reuses the number. Other systems differ, which makes delayed close errors awkward for portable code. Handle data durability at the protocol level instead of treating a successful `close` as delivery proof.

### Families, types, and protocol

The three `socket(domain, type, protocol)` arguments select distinct properties:

| Choice | Common values | Meaning |
|---|---|---|
| Address family | `AF_INET`, `AF_INET6`, `AF_UNIX` | How endpoints are named |
| Socket type | `SOCK_STREAM`, `SOCK_DGRAM`, `SOCK_SEQPACKET`, `SOCK_RAW` | Application-visible I/O semantics |
| Protocol | usually `0`, or `IPPROTO_TCP` / `IPPROTO_UDP` | Protocol within that family/type |

`SOCK_STREAM` with TCP provides an ordered byte stream or a reported connection failure; it provides no records. `SOCK_DGRAM` with UDP preserves message boundaries but does not provide delivery, ordering, or duplicate suppression. `SOCK_RAW` exposes protocol-specific packets and normally needs privilege; header layout and availability are OS-specific. `SOCK_SEQPACKET` preserves records while providing connection semantics for protocols that implement it, including some UNIX-domain uses.

An **endpoint** is one end of communication. For Internet sockets it is normally an IP address plus a port. A connected TCP flow is identified by local and remote endpoint plus protocol. A socket is the kernel object through which the application uses that endpoint; “socket,” “port,” and “connection” are not synonyms.

### Store addresses generically; resolve names deliberately

`sockaddr_in` holds IPv4, `sockaddr_in6` holds IPv6, and `sockaddr_un` holds a local-domain address. APIs accept `sockaddr*` plus an explicit length. Use `sockaddr_storage` for family-independent storage:

```cpp
sockaddr_storage peer{};
socklen_t peer_len = sizeof peer;
int cfd = ::accept(listener,
    reinterpret_cast<sockaddr*>(&peer), &peer_len);
```

Port fields and binary IP fields use network byte order. `htons`/`ntohs` handle 16-bit ports; do not serialize C++ structs directly as a wire protocol.

`getaddrinfo` is the POSIX family-independent resolver and address constructor. It can return several candidates. Robust clients try candidates according to a bounded connection policy rather than assuming the first IPv4 address works. Resolution may block and may consult DNS, local files, or name-service plugins, so it does not belong unexpectedly on a latency-critical thread. Numeric services and `AI_NUMERICHOST`/`AI_NUMERICSERV` avoid name lookup when configuration already contains numeric endpoints.

`AF_UNIX` names local endpoints and can pass credentials or descriptors with ancillary data. Filesystem-path lifetime and Linux abstract-namespace addresses are different: the latter are Linux-specific and start with a zero byte rather than naming a filesystem object.

## 45.2 TCP and UDP Setup — Core

### Lifecycle map

```text
TCP server: socket → options → bind → listen → accept
                                              │
                                              └→ connected fd → I/O → shutdown/close

TCP client: socket → optional bind → connect → I/O → shutdown/close

UDP:        socket → optional bind/connect → send/receive → close
```

The listener and each accepted connection are separate sockets. Closing an accepted descriptor does not close the listener. Closing the listener stops new accepts but does not inherently terminate already accepted connections.

Always check each return value and preserve `errno` before another failing call overwrites it. Creation code should make cleanup ownership obvious. A production server also sets resource limits, validates configuration, and defines overload behavior before accepting traffic.

### Bind and listen

`bind` assigns a local address. A server normally binds a configured address and port. Binding the wildcard address accepts traffic destined to any appropriate local interface; binding a specific address narrows exposure and affects failover behavior. A client that omits `bind` receives a kernel-selected source address and ephemeral port during connect or first send.

```cpp
sockaddr_in local{};
local.sin_family = AF_INET;
local.sin_port = htons(9000);
local.sin_addr.s_addr = htonl(INADDR_ANY);

if (::bind(fd, reinterpret_cast<sockaddr*>(&local),
           sizeof local) < 0) {
    // report errno; fd remains owned by the caller
}
```

`listen(fd, backlog)` converts a stream socket into a listener. POSIX leaves backlog interpretation partly implementation-defined. On Linux, the argument limits completed connections waiting to be accepted and is capped by system configuration; incomplete-handshake handling has separate limits and mechanisms. Treat exact queue behavior, counter names, and overflow policy as Linux-version/configuration facts, not TCP guarantees.

**Worked capacity check.** If arrivals briefly reach 20,000 connections/s and the acceptor can be descheduled for 5 ms, approximately

```text
20,000 connections/s × 0.005 s = 100 completed connections
```

can accumulate even before normal service-time variance. A backlog of 32 cannot absorb that burst. Increasing backlog may avoid immediate refusal or retransmission, but it cannot repair an acceptor whose sustained service rate is below arrival rate. Measure queue depth and overflow counters, then fix the bottleneck or shed load.

On Linux, `ss -lnt` reports current and configured listener-queue values in columns whose meaning differs from connected sockets. `nstat` exposes version-dependent listen-overflow counters. Verify names and semantics on the deployed kernel.

### Accept

`accept` removes one completed connection from the listener queue and returns a new descriptor. It may fail with `EINTR`; on a non-blocking listener, `EAGAIN`/`EWOULDBLOCK` means another thread or an earlier drain consumed the readiness.

**Linux:** accepted sockets do not inherit file status flags such as `O_NONBLOCK` from the listener. Use `accept4(..., SOCK_NONBLOCK | SOCK_CLOEXEC)` or configure the result before publishing it. Socket-option inheritance is option- and OS-specific; explicitly establish every application invariant on the accepted socket.

A readiness event is not a reservation. Between `epoll_wait` and `accept4`, another worker may accept the connection. Correct loops treat `EAGAIN` as ordinary and do not assume one event equals one connection.

Linux can also surface certain pending network errors from the new connection
through `accept`. A robust loop classifies the documented transient network
errors, resource exhaustion such as `EMFILE`/`ENFILE`, and permanent local
configuration/programming errors separately; “retry every accept error” can
spin or hide overload.

### Connect

For a blocking stream socket, `connect` waits until connection establishment succeeds or fails according to the OS timeout and signal behavior. For a non-blocking stream socket, `-1` with `EINPROGRESS` means establishment continues asynchronously. Completion makes the descriptor writable or reports an error event, but writability alone does not mean success:

```cpp
int err = 0;
socklen_t len = sizeof err;
if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0) {
    // getsockopt itself failed
} else if (err != 0) {
    // connect failed; 'err' is the saved socket error
} else {
    // connected
}
```

Use a separate deadline in the event loop; a readiness wait timeout is not a connection cancellation policy. On expiry, remove the descriptor from the poll set and close it under single-owner rules. If several resolved addresses are attempted, bound concurrency and define which result wins.

After a `connect` failure other than a documented in-progress result, portable
code should treat the socket state as unspecified, close it, and create a new
socket for another attempt. Do not recycle one failed descriptor through a list
of address candidates unless the target OS explicitly documents that sequence.

`connect` on a UDP socket performs no handshake. It records a default peer, restricts which remote endpoint is received, permits `send`/`recv`, and changes how some asynchronous errors are surfaced. It does not turn UDP into a reliable protocol and does not prove that the peer exists. Linux route-caching details and error delivery are implementation behavior, not portable guarantees.

## 45.3 Stream and Datagram I/O Contracts — Core

### Return values are progress reports

For stream receive:

| Result | Meaning |
|---|---|
| `n > 0` | `n` bytes copied; there may be fewer than requested |
| `n == 0` | for a nonzero receive request, orderly end of the peer-to-local byte stream |
| `n < 0`, `EINTR` | interrupted before a reportable result; retry if policy permits |
| `n < 0`, `EAGAIN`/`EWOULDBLOCK` | no progress now on non-blocking I/O |
| other error | handle according to connection state and protocol policy |

Stream `send` may also return any positive prefix length. This is true for blocking and non-blocking sockets: signals and other conditions can produce partial progress, and portable code must advance by the returned count. A return value does not align with an application frame.

A zero-length stream receive returns zero without testing for EOF. Correct loops
avoid zero-capacity calls and interpret zero as peer EOF only after requesting a
nonzero number of bytes.

A successful stream send means the local kernel accepted those bytes. Chapter 38 explains when TCP acknowledges bytes and why retransmission can continue after the call. Only an application reply can prove application-level processing, and even that needs a protocol-defined idempotency/recovery model.

For datagrams, one successful send submits one datagram atomically: the call reports the message length or fails rather than sending a visible prefix as another datagram. One receive consumes at most one datagram. If the supplied buffer is too small, the excess is discarded; the exact returned length with `MSG_TRUNC` varies by API/OS, so inspect `msg_flags` and reject truncation. A zero-length datagram is valid and returns zero—it is not UDP EOF.

### A correct non-blocking stream session

The output queue owns every byte until `send` reports it accepted. New records append behind pending bytes, preserving stream order. `want_write()` tells the readiness layer whether to arm `POLLOUT`/`EPOLLOUT`.

```cpp
#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <limits.h>
#include <span>
#include <sys/socket.h>
#include <vector>

enum class IoResult { ready, peer_closed, fatal };

struct Session {
    std::vector<std::byte> out;
    std::size_t sent = 0;
    bool failed = false;

    void queue(std::span<const std::byte> bytes) {
        out.insert(out.end(), bytes.begin(), bytes.end());
    }
    [[nodiscard]] bool want_write() const {
        return sent != out.size();
    }
};

IoResult flush(Session& s, int fd) {
    while (s.sent < s.out.size()) {
        const auto* p = s.out.data() + s.sent;
        const auto left = s.out.size() - s.sent;
        const auto chunk =
            std::min(left, static_cast<std::size_t>(SSIZE_MAX));
#ifdef MSG_NOSIGNAL                 // Linux; use a platform policy elsewhere
        const int flags = MSG_NOSIGNAL;
#else
        const int flags = 0;
#endif
        const ssize_t n = ::send(fd, p, chunk, flags);
        if (n > 0) { s.sent += static_cast<std::size_t>(n); continue; }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
            return IoResult::ready; // keep bytes and write interest
        s.failed = true;
        return IoResult::fatal;
    }
    s.out.clear();
    s.sent = 0;                     // disarm write interest
    return IoResult::ready;
}
```

Production code adds a maximum output size and an overload action before `queue` grows memory. It may compact the vector or use a ring, but that does not change the invariant: the unsent suffix remains owned and ordered. Once any bytes are pending, bypassing the queue with a direct send can reorder logical records.

The read side drains bytes into a bounded framing buffer and invokes the incremental parser from Chapter 38:

```cpp
IoResult drain_reads(int fd, std::span<std::byte> space,
                     std::size_t& used) {
    while (used < space.size()) {
        const auto chunk = std::min(
            space.size() - used, static_cast<std::size_t>(SSIZE_MAX));
        const ssize_t n = ::recv(fd, space.data() + used,
                                 chunk, 0);
        if (n > 0) { used += static_cast<std::size_t>(n); continue; }
        if (n == 0) return IoResult::peer_closed;
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return IoResult::ready;
        return IoResult::fatal;
    }
    return IoResult::ready; // application buffer full: parse or apply backpressure
}
```

Do not read again with zero available space. Parse complete frames, retain an incomplete suffix, and cap declared lengths before allocation. Under edge-triggered readiness, an application buffer filling before the socket reaches `EAGAIN` needs an explicit continuation strategy; “drain to `EAGAIN`” does not permit overwriting bounded memory.

### A correct datagram receive

`recvmsg` exposes truncation and source address in one call:

```cpp
#include <cerrno>
#include <cstddef>
#include <span>
#include <sys/socket.h>

enum class DatagramResult { received, would_block, truncated, fatal };

DatagramResult receive_one(int fd, std::span<std::byte> payload,
                           sockaddr_storage& source, socklen_t& source_len,
                           std::size_t& size) {
    iovec iov{payload.data(), payload.size()};
    msghdr msg{};
    msg.msg_name = &source;
    msg.msg_namelen = static_cast<socklen_t>(sizeof source);
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;

    for (;;) {
        const ssize_t n = ::recvmsg(fd, &msg, 0);
        if (n >= 0) {
            source_len = msg.msg_namelen;
            size = static_cast<std::size_t>(n); // zero is a valid datagram
            return (msg.msg_flags & MSG_TRUNC)
                ? DatagramResult::truncated
                : DatagramResult::received;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return DatagramResult::would_block;
        return DatagramResult::fatal;
    }
}
```

Choose the payload cap from the application protocol, not from a presumed Ethernet MTU; IP fragmentation, loopback, UDP segmentation offload, and malicious inputs defeat that assumption. A truncated datagram is already consumed, so the safe action is normally to record/drop it and recover using a protocol sequence number—not to “read the rest.”

## 45.4 Blocking, Non-blocking, and Readiness — Core

### Separate the concepts

| Model | Contract | Typical interfaces |
|---|---|---|
| Blocking I/O | the operation may sleep until it progresses, fails, or is interrupted | `recv`, `send`, `accept`, `connect` |
| Non-blocking I/O | attempt immediately; return `EAGAIN` if it cannot progress | same calls with `O_NONBLOCK` |
| Readiness | report descriptors on which an operation may progress | POSIX `select`/`poll`; Linux `epoll` |
| Completion | submit an operation and later obtain its result | Linux `io_uring`, with operation-specific rules |

Readiness does not make an operation infallible or reserve data for the caller. Another thread can consume the data; an error can arrive; a datagram can fail a validation check. Always execute the I/O call and interpret its result.

Blocking designs are often the easiest correct choice for a small number of sessions with one owning thread each. Their risks are unbounded sleeping, thread-stack and scheduler costs, and difficult cancellation. Non-blocking loops centralize deadlines and multiplex descriptors, but require per-connection state and fairness budgets.

Socket timeouts and readiness timeouts are not interchangeable. `poll`/`epoll_wait` timeouts bound the wait call, while a connection or request deadline spans many waits and I/O attempts. Linux `SO_RCVTIMEO`/`SO_SNDTIMEO` affect blocking socket calls with operation-specific partial-progress behavior and generally do not turn a non-blocking event loop into a deadline system.

### POSIX poll: the portable mental model

`poll` receives an array of descriptors and requested events. The kernel updates returned events, and the application performs the operations. It is O(number of entries examined) per call and copies the array across the user/kernel boundary.

`POLLIN` can mean bytes, a pending connection on a listener, an orderly stream shutdown that will make `recv` return zero, or another readable condition. `POLLOUT` means a write is likely to make some progress, not that an arbitrarily large frame fits. `POLLERR`, `POLLHUP`, and `POLLNVAL` require handling even if not requested.

Keep write interest disabled while the output queue is empty. Most connected TCP sockets are writable most of the time, so permanent `POLLOUT` interest makes the wait return immediately and burns a core.

### Linux epoll

`epoll` stores an interest set in the kernel and returns batches of ready events. It avoids rescanning and copying an entire large descriptor set on every wait, though processing cost is not literally constant: it still scales with ready events, callbacks, contention, and application work.

```cpp
int ep = ::epoll_create1(EPOLL_CLOEXEC);
epoll_event interest{};
interest.events = EPOLLIN | EPOLLRDHUP; // level-triggered by default
interest.data.fd = fd;
::epoll_ctl(ep, EPOLL_CTL_ADD, fd, &interest);
```

This is Linux-specific code and needs `<sys/epoll.h>`. Check every call; descriptor reuse makes stale registrations dangerous if ownership is unclear. Store a generation or stable connection pointer/token rather than assuming an integer fd uniquely identifies the lifetime forever.

Level-triggered mode reports a condition while it remains true. It is forgiving: if a fairness budget stops reading while data remains, the descriptor will be reported again. Edge-triggered `EPOLLET` reports readiness transitions and usually reduces repeated notifications, but imposes stricter drain and state-transition rules.

For edge-triggered sockets:

- Make the descriptor non-blocking.
- Accept/read/write repeatedly until `EAGAIN`, subject to bounded application storage.
- If application capacity stops a drain, arrange an explicit retry after capacity returns; a new edge is not guaranteed.
- Treat an immediate `EAGAIN` as normal because events can be stale.
- Arm `EPOLLOUT` only while unsent bytes exist; disarm after the queue drains.

`EPOLLONESHOT` disables an entry after delivery until `EPOLL_CTL_MOD` re-arms
it. It can enforce single-worker processing, but every exit path must re-arm or
close. `EPOLLEXCLUSIVE` (Linux 4.5+) can reduce some listener wakeups across
epoll waiters; its supported combinations and exact wake behavior are
kernel-specific. `SO_REUSEPORT` offers a different architecture with per-worker
listeners. Neither removes the need to measure distribution and overload.

### Fairness is part of correctness

“Drain until `EAGAIN`” can let one hot socket monopolize the loop while thousands wait. Production loops combine a byte/message/time budget with level triggering, one-shot re-arming, or an application run queue. The invariant is:

```text
per-ready-fd work is bounded
AND
remaining work is guaranteed another scheduling opportunity
```

The right budget depends on service objectives. A smaller budget improves cross-connection tail latency but increases readiness/syscall overhead; a larger budget improves throughput and cache locality but can starve quiet latency-sensitive sessions.

### Syscall, copy, wakeup, and queueing costs

Avoid timeless nanosecond constants. Kernel version, mitigations, CPU frequency, cache state, payload size, contention, and whether a call sleeps can change results by orders of magnitude. Use this decomposition:

```text
Tapplication-observed
  ≈ Nsyscalls × Csyscall
  + bytes-copied / effective-copy-bandwidth
  + Nwakeups × Csleep/wakeup
  + queue-bytes / drain-rate
  + protocol/device work described in Chapters 38 and 46
```

Suppose 32 UDP datagrams are already queued. Calling `recvmsg` 32 times pays roughly 32 syscall boundaries; one `recvmmsg` can amortize that boundary and some lookup/locking work. It does not eliminate the payload copies, packet processing, or per-message validation. Conversely, waiting to fill a batch adds queueing delay to the first datagram.

If an application drains 1 MiB at 200 MiB/s, the oldest byte has approximately

```text
1 MiB / 200 MiB/s = 5 ms
```

of application-queue delay before considering kernel and network queues. That calculation often matters more than shaving tens of nanoseconds from a syscall.

Measure distributions under the target kernel and load. Useful experiments compare blocking versus polling, single-message versus batch, payload sizes, ready-set size, queue depth, and p50/p99/max latency while checking CPU and drops.

## 45.5 Options, Buffers, and Backpressure — Core

Socket options are typed, level-specific kernel configuration. `setsockopt` can fail because the option is unsupported, the value is invalid, privilege is missing, or the lifecycle point is wrong. Check the result and read back values when the OS may clamp them.

### Reuse is not one portable rule

`SO_REUSEADDR` and `SO_REUSEPORT` differ substantially across operating systems and socket types:

| Option | Portable decision | Linux behavior to verify |
|---|---|---|
| `SO_REUSEADDR` | set before `bind` when restart/bind policy requires it | relaxes particular local-address conflicts, including common server restart cases; it does not generally authorize arbitrary duplicate TCP listeners |
| `SO_REUSEPORT` | treat as OS-specific | Linux 3.9+ can form TCP/UDP groups bound to the same endpoint and select a recipient; security, UID, multicast, and group membership rules matter |

Do not memorize “REUSEADDR means TIME_WAIT” or “REUSEPORT fans out.” The result depends on wildcard versus specific address, protocol, live listeners, multicast/unicast, OS, and option ordering. Test the exact bind matrix on the deployment platform.

Linux `SO_ATTACH_REUSEPORT_CBPF`/`SO_ATTACH_REUSEPORT_EBPF` can select a group member programmatically. This is specialized steering, not a portable socket guarantee, and program indices/lifecycle must be managed during rolling changes.

### Multicast bind, membership, and filtering are distinct

For a multicast UDP receiver, `bind` establishes the local address/port
demultiplexing rule; it does **not** join a multicast group. A membership request
selects a group and interface and, for source-specific multicast, an allowed
source. Reuse options determine whether several local sockets may share the
port; they do not request network delivery or guarantee whether copies are
fanned out versus selected between sockets.

A common Linux receiver sets the intended reuse policy before `bind`, binds the
wildcard local address and destination port, then joins the exact
group/interface or source/group/interface channel. Binding the group address is
not a portable substitute: bind and multicast-delivery rules differ across
Linux, BSD-family systems, and Windows. Likewise, Linux unicast
`SO_REUSEPORT` distribution must not be generalized to multicast delivery.

When one socket joins several groups on one port, receive destination/interface
metadata such as Linux `IP_PKTINFO`/`IPV6_PKTINFO` can let the application
validate the channel. Leave every membership during controlled teardown or rely
only on documented final-socket cleanup. Chapter 37 owns IGMP/MLD, ASM/SSM,
source filters, routing, and switch behavior; this chapter owns socket creation,
bind/reuse ordering, non-blocking I/O, and cleanup.

### Buffer sizes and watermarks

`SO_RCVBUF` and `SO_SNDBUF` set or request queue budgets. Linux doubles requested values for accounting and reports the doubled value; system ceilings and privileged “force” variants can apply. TCP autotuning interacts with explicit values in Linux-version-dependent ways. None of these values is simply “payload bytes available.”

Size from a model:

```text
receive capacity ≥ peak arrival rate × maximum tolerated service gap
send capacity    ≥ burst offered to socket before backpressure action
queue delay       = queued application-relevant bytes / actual drain rate
```

Example: a UDP source bursts at 800 MiB/s and the consumer may be descheduled for 250 µs:

```text
800 MiB/s × 0.000250 s ≈ 205 KiB
```

That is a lower-bound payload estimate. Kernel metadata and competing traffic require headroom. A multi-megabyte buffer may prevent the immediate drop but can make data milliseconds stale. The application still needs sequence-gap detection and a recovery policy because no finite buffer covers sustained overload.

For a stream sender, a large kernel buffer can hide a slow peer: `send` succeeds while stale requests accumulate locally. Bound the application queue, timestamp enqueue age, and choose an overload action—reject, shed optional updates, disconnect, or stop accepting. Chapter 38 explains how receive-window and congestion state interact with the TCP send queue.

**Linux diagnostics:** `ss -tinm` can expose queue, memory, and TCP fields, but output names vary with `iproute2` and kernel version. `SIOCINQ`/`FIONREAD` and `SIOCOUTQ` offer Linux queue observations with protocol-specific meanings. Treat them as diagnostic signals, not synchronization primitives; state changes immediately.

### Latency-related options

| Option | Scope | What the application should know |
|---|---|---|
| `TCP_NODELAY` | widely available TCP option | disables Nagle behavior; useful for small latency-sensitive writes when batching policy is intentional |
| `TCP_CORK` | Linux | holds/coalesces output under Linux rules; always uncork on every completion/error path |
| `MSG_MORE` | Linux per-send flag | hints that more data follows; protocol-specific effects |
| `TCP_NOTSENT_LOWAT` | Linux 3.12+ | changes when unsent-byte state makes a socket writable; availability and readiness behavior remain version-specific |
| `SO_KEEPALIVE` plus tunables | POSIX option, tunables OS-specific | detects some long-idle failures eventually; it is not an application heartbeat or processing proof |
| `SO_RCVLOWAT` | availability/readiness integration varies | changes receive low-water behavior; verify poll integration on target OS |

Chapter 38 owns the mechanisms and trade-offs behind Nagle, delayed acknowledgements, keepalive, flow control, and congestion. There is no universal delayed-ACK timer, cork timer, ideal buffer, or option bundle. Name OS/kernel, workload, measurement, rollback, and correctness effect when recommending a knob.

### `SIGPIPE`

Writing to a stream whose peer has closed can deliver `SIGPIPE`; its default action terminates the process. Linux offers `MSG_NOSIGNAL` per send. BSD-family systems offer `SO_NOSIGPIPE`; ignoring `SIGPIPE` process-wide is another policy. Portable libraries must choose deliberately. Even with the signal suppressed, handle `EPIPE`; suppression changes notification, not connection state.

## 45.6 Errors and Asynchronous Reporting — Core

### Classify before recovering

| Class | Examples | Typical response |
|---|---|---|
| No progress yet | `EAGAIN`, `EWOULDBLOCK`, `EINPROGRESS` | retain state; wait for the relevant event/deadline |
| Interrupted | `EINTR` | retry only if no progress was returned and operation policy permits |
| Local resource/configuration | `EMFILE`, `ENFILE`, `ENOBUFS`, `EADDRINUSE` | shed, reserve recovery capacity, fix limits/configuration |
| Peer/path/session failure | `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `ECONNREFUSED` | close/reconnect according to application recovery |
| Message violation | `EMSGSIZE`, truncation, malformed length | reject/drop and use protocol recovery |

Do not retry every error. Retrying `EAGAIN` in a tight loop is accidental busy polling; retrying a permanent configuration error floods logs; retrying a partially completed logical request without an idempotency key can duplicate business action.

`errno` belongs to the calling thread but is meaningful only after a call reports failure. Save it immediately. Some APIs report an error directly rather than through `errno`; `getaddrinfo`, for example, returns an `EAI_*` code.

### Failure is ambiguous above the syscall

Consider:

```text
client send returned success
server kernel received bytes
server application acted
server reply was lost
client observed timeout
```

The client cannot distinguish “request never arrived” from “request committed but reply was lost” using socket state. Reconnect alone does not solve it. The application protocol needs request identity, idempotency/deduplication, and reconciliation. TCP’s guarantees stop at the byte stream; Chapter 38 develops this boundary.

### Non-blocking connect and pending errors

As shown earlier, writable completion must be followed by `getsockopt(SO_ERROR)`. The call fetches the pending socket error; on common systems it also clears that simple pending state. Error events can coexist with readable data or half-close, so event processing should not discard already-received protocol evidence blindly.

### Linux error queue — Role-specific

Linux can place detailed asynchronous events on a socket error queue. Enable `IP_RECVERR` for IPv4 or `IPV6_RECVERR` for IPv6, then drain with:

```cpp
ssize_t n = ::recvmsg(fd, &msg, MSG_ERRQUEUE | MSG_DONTWAIT);
```

Ancillary records can contain `sock_extended_err` for ICMP/local errors and related offender information. Transmit timestamps and `MSG_ZEROCOPY` completions also use the error queue. These consumers share a finite facility, so dispatch by origin/type and drain until `EAGAIN` when `EPOLLERR` is observed.

Error-queue details are Linux API behavior, vary by protocol and option, and are not a liveness oracle. ICMP can be filtered; no error does not prove delivery. Connected UDP often surfaces certain asynchronous errors more directly, but applications still need heartbeats, sequence numbers, or acknowledgements appropriate to their protocol.

### Worked diagnosis: writable but no session

Symptom: a non-blocking client receives `EPOLLOUT`, sends its login, and gets `EPIPE`.

Reasoning:

1. `EPOLLOUT` reported possible write progress or completion state, not connect success.
2. Read `SO_ERROR`. If it contains `ECONNREFUSED`, establishment failed; the login must never have been submitted on a valid connection.
3. If `SO_ERROR` is zero, `send` can still race with a later reset. Record the send result and connection events.
4. If a login prefix was accepted before failure, application outcome is ambiguous; recover using session identity and protocol rules rather than replaying blindly.

The fix is a connection state machine:

```text
CONNECTING --writable + SO_ERROR=0--> ESTABLISHED
CONNECTING --SO_ERROR!=0/deadline----> FAILED
ESTABLISHED --I/O + parser-----------> ACTIVE
any state --terminal policy----------> CLOSED
```

## 45.7 Shutdown and Close — Core

`shutdown` changes communication direction on the socket; `close` releases one descriptor reference.

| Operation | Effect |
|---|---|
| `shutdown(fd, SHUT_WR)` | no more local sends; for TCP, requests an orderly end of the local byte stream after previously queued bytes |
| `shutdown(fd, SHUT_RD)` | disables local receive according to OS/protocol behavior; it is rarely a substitute for draining |
| `shutdown(fd, SHUT_RDWR)` | disables both directions but does not release the descriptor |
| `close(fd)` | releases this descriptor; final socket teardown depends on references and options |

A request/response protocol can use half-close:

```text
client sends request → client shutdown(SHUT_WR)
server recv returns 0 after complete request → server sends response
client drains response until recv returns 0 → both close descriptors
```

This only works when EOF is part of framing. Persistent framed protocols should not half-close after every record.

Closing a descriptor from one thread is not a portable cancellation mechanism for another thread blocked in an operation on the same underlying socket. Use single-owner event-loop commands, `shutdown` where its semantics fit, a pipe/eventfd wakeup, cancellation supported by the chosen API, or a finite deadline.

### Linger and abortive close

`SO_LINGER` changes close behavior, but exact blocking/error details vary by OS:

- Linger disabled: close normally returns without waiting for application confirmation; the protocol stack may continue orderly transmission.
- Linger enabled with positive timeout: close may block while attempting delivery, which can stall an event-loop thread.
- On common TCP implementations, linger enabled with zero timeout requests abortive close, discarding queued data and sending a reset when applicable.

Abortive close is data-destructive. It may be suitable when rejecting an invalid session whose remaining bytes must not be delivered; it is not a generic cure for `TIME_WAIT`. Chapter 38 owns TCP teardown and explains why the side performing the active close can retain TIME-WAIT state. Duration, tuple reuse, and sysctls are OS/version policy.

### A robust shutdown policy

Define milestones:

1. Stop accepting new application work.
2. Flush or reject the bounded output queue by a deadline.
3. If the protocol uses EOF, `shutdown(SHUT_WR)`.
4. Continue receiving required replies/acknowledgements until completion or deadline.
5. Remove readiness registration under the owner thread.
6. Close exactly once.

A deadline expiry must map to an explicit outcome: abort and reconcile, not “assume sent.” Duplicate descriptors must be included in ownership accounting or the connection can survive unexpectedly.

## 45.8 Linux Throughput and Metadata Interfaces — Role-specific

A reader can skip this section and still write correct portable socket code. These interfaces matter after profiling identifies syscall, copy, wakeup, filtering, or timestamp cost. Kernel versions below are introduction landmarks, not a substitute for checking distribution backports, configuration, privileges, NIC/driver support, and man pages on the deployment host.

### Batched datagrams

Linux `recvmmsg` (2.6.33+) and `sendmmsg` (3.0+) process arrays of `mmsghdr`
entries. With glibc, expose their declarations using the required GNU feature
test before including headers:

```cpp
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <array>
#include <cstddef>
#include <sys/socket.h>

constexpr unsigned Batch = 32;
std::array<mmsghdr, Batch> messages{};
std::array<iovec, Batch> iov{};
std::array<std::array<std::byte, 2048>, Batch> buffers{};

for (unsigned i = 0; i < Batch; ++i) {
    iov[i] = {buffers[i].data(), buffers[i].size()};
    messages[i].msg_hdr.msg_iov = &iov[i];
    messages[i].msg_hdr.msg_iovlen = 1;
}
int count = ::recvmmsg(fd, messages.data(), Batch, MSG_DONTWAIT, nullptr);
```

Check `count`, every `msg_len`, every `msg_flags`, and truncation. `sendmmsg` can complete only an initial subset; retain unsent datagrams individually. Datagram atomicity does not imply whole-batch atomicity.

Batching amortizes syscall overhead when several datagrams are already queued. It can worsen first-message latency if code waits to fill a batch. `MSG_WAITFORONE` and timeout behavior have Linux-version-specific details and documented historical quirks; non-blocking drain after a readiness event is the least surprising latency-oriented pattern.

Linux UDP GSO (`UDP_SEGMENT`) and GRO can reduce per-packet work while changing what one call observes. Chapter 46 owns their packet-path mechanics. Validate segment sizing, offload support, capture interpretation, and error behavior before use.

### `recvmsg`, scatter/gather, and ancillary data

`sendmsg`/`recvmsg` combine:

- `iovec` scatter/gather payloads,
- optional source/destination address,
- a control buffer containing aligned `cmsghdr` records,
- output flags such as `MSG_TRUNC` and `MSG_CTRUNC`.

Use `CMSG_SPACE` to size storage, `CMSG_LEN` when constructing `cmsg_len`, and `CMSG_FIRSTHDR`/`CMSG_NXTHDR` to walk it. Never hand-roll alignment. Reject or diagnose `MSG_CTRUNC`; otherwise missing metadata can be silently treated as valid.

Common control data:

| Facility | Scope | Use |
|---|---|---|
| `IP_PKTINFO` / `IPV6_PKTINFO` | Linux and related APIs, details vary | destination address/interface on receive; source/interface control on send |
| `SCM_RIGHTS` | UNIX-domain sockets | pass descriptor references between processes |
| `SCM_CREDENTIALS` | Linux UNIX-domain | receive kernel-supplied peer credentials when configured |
| `SCM_TIMESTAMPING` | Linux | receive software/hardware timestamp records |
| `IP_RECVERR` / `IPV6_RECVERR` | Linux error queue | detailed asynchronous network errors |

Descriptor passing transfers a new reference, not ownership magically. The receiver must validate counts, set close-on-exec safely (Linux `MSG_CMSG_CLOEXEC` helps), and close every received descriptor on all error paths. Credential and namespace assumptions require a threat model.

### Timestamps

Linux offers legacy `SO_TIMESTAMP`/`SO_TIMESTAMPNS` and the richer `SO_TIMESTAMPING` family. Receive timestamps arrive with data ancillary records. Transmit timestamps arrive asynchronously, commonly through the error queue, because the timestamp does not exist when `send` returns.

Hardware timestamps require NIC, driver, interface, and socket configuration. The raw hardware clock may be in a PTP hardware-clock domain rather than the application’s clock domain. Compare timestamps only after establishing clock identity and synchronization error. `ethtool -T <interface>` reports driver-advertised capabilities; `ip -s link`, `ss`, and application counters help correlate missing metadata.

Do not infer “wire time” from an option name. Software receive timestamps, hardware receive timestamps, scheduler wakeup time, and application read time mark different path locations. Chapter 46 maps those locations.

### Busy polling and socket filters

Linux `SO_BUSY_POLL` dates to 3.11; related controls evolved later. They can
spend CPU polling for receive work rather than sleeping and waking. They may
reduce wakeup tail latency when driver/NAPI association, privileges, CPU
isolation, and kernel configuration align. They also consume CPU, can harm
fairness, and do not bypass the network stack. Measure the target kernel; do not
attach a universal microsecond saving.

Classic BPF (`SO_ATTACH_FILTER`) or eBPF socket filters can reject unwanted
traffic before it is copied to the application. `SO_ATTACH_REUSEPORT_EBPF`
selects among reuseport sockets. Filter cost runs on receive-path CPU and
correctness depends on packet layout and hook semantics. XDP and packet steering
belong to Chapters 46–47; a socket filter is useful when normal socket delivery
remains desirable.

### `MSG_ZEROCOPY` and ownership

Linux 4.14 introduced initial `MSG_ZEROCOPY` support; protocol coverage and
behavior evolved in later kernels. Support, fallback, device behavior, and
accounting must be verified. The application first enables `SO_ZEROCOPY`, then
sends eligible buffers with `MSG_ZEROCOPY`. Completion ranges arrive on the
error queue.

The word “zero-copy” hides the important contract:

```text
application owns buffer
    → submit
kernel/device may retain references; application must not mutate/reuse
    → matching completion range
application owns reusable buffer again
```

The kernel may copy despite the flag and indicate fallback in completion metadata. Page pinning, bookkeeping, and completion processing can cost more than copying small messages. Use this only when measurement shows copy cost dominates and the buffer pool can bound outstanding ownership. A missing completion-drain path is both a resource leak and a correctness failure.

Every zero-copy API trades a visible copy for a more complex ownership protocol. That lesson generalizes to `io_uring`, packet rings, kernel bypass, and RDMA.

## 45.9 Diagnosis and Commands — Core

Start from application state and syscall results, then correlate kernel evidence. Packet-path internals come next in Chapter 46.

```bash
# Replace these example values with the diagnosed process/path.
target_pid=1234
target_fd=7
network_interface=eth0
target_port=9000

# Linux: listeners, connected sockets, queues, memory, TCP details.
ss -lnt
ss -tinm
ss -uapnm

# Per-process descriptors and ownership.
ls -l "/proc/${target_pid}/fd"
cat "/proc/${target_pid}/fdinfo/${target_fd}"

# Syscall sequence and blocking duration; use carefully in production.
strace -f -ttT -e trace=network,desc -p "${target_pid}"

# Protocol counters; exact names depend on kernel/iproute2.
nstat -az

# Numeric packet capture; offloads and capture point can alter appearance.
tcpdump -nn -ttt -S -i "${network_interface}" "tcp port ${target_port}"
```

Commands are Linux-specific and can perturb the workload. `strace` is excellent for proving a partial-write bug or an `EPOLLOUT` spin in a reproduction, but ptrace overhead can be severe. A packet capture shows packets at its capture point, not application queue state; offloads can make sizes look unlike the wire.

### Symptom-to-invariant table

| Symptom | First invariant to test | Evidence |
|---|---|---|
| CPU at 100%, no useful I/O | write/error interest is armed only with work | readiness events, `strace`, output/error queue state |
| one connection becomes silent under ET | drain or explicit re-schedule was preserved | last read result, buffer-full transition, epoll modifications |
| corrupted/missing UDP records | truncation and sequence gaps are handled | `msg_flags`, datagram length, protocol sequence |
| stream frame corruption | every partial read/write retained order | syscall return counts, queue offsets, parser state |
| connect event followed by failure | `SO_ERROR` checked before use | connect state log and saved error |
| increasing latency without network RTT change | application/kernel queues are growing | enqueue age, `ss` queues, service rate |
| restart gets `EADDRINUSE` | bind matrix/options/order match deployment OS | exact local addresses, live listeners, TIME-WAIT state |
| descriptors survive restart | every duplicate/reference has an owner | `/proc/<pid>/fd`, fork/exec and `SCM_RIGHTS` paths |

### Worked session diagnosis

An event-driven gateway is healthy at low load. During a burst, one peer reports malformed frames and the gateway later spins at 100% CPU.

1. Trace shows `send(fd, 4096)` returned 1370, followed by a new frame sent directly. The program discarded the 2726-byte suffix and violated stream order. Fix: append the suffix and all subsequent bytes to the single per-session queue.
2. After backpressure begins, the program permanently enables `EPOLLOUT`. Once the queue drains, writable readiness remains true and `epoll_wait` returns continuously. Fix: remove write interest exactly when `sent == out.size()`.
3. Add a maximum queued byte count and enqueue-age metric. Without a bound, the “fixed” writer converts corruption into unbounded memory and stale requests.
4. Validate with forced small socket buffers, a slow-reading peer, signals, and many frame split points. Assert byte-for-byte order at the receiver and no write interest while idle.

This is the central socket-programming pattern: correctness first exposes backpressure; a bounded policy then decides what overload means.

## 45.10 Protocol/API Reference — Reference

### Core call matrix

| Call | Stream use | Datagram use | Main trap |
|---|---|---|---|
| `socket` | create listener/client endpoint | create endpoint | flags and cleanup race |
| `bind` | choose local endpoint | choose receive/source endpoint | wildcard/reuse semantics |
| `listen` | make listener | not used | backlog is not total capacity |
| `accept` | create connected socket | not used | new descriptor flags/ownership |
| `connect` | establish connection | record default peer | non-blocking completion / no UDP handshake |
| `send`/`write` | byte prefix | one connected datagram | partial stream progress / `SIGPIPE` |
| `recv`/`read` | available byte prefix or EOF | one connected datagram | stream framing / datagram truncation |
| `sendto`/`recvfrom` | uncommon after connection | explicit peer/source | address length and truncation |
| `sendmsg`/`recvmsg` | scatter/gather, metadata | scatter/gather, metadata | control alignment and flags |
| `shutdown` | directional end | protocol/OS-specific utility | does not release fd |
| `close` | release descriptor | release descriptor | shared references, late errors |

### Flags and state

| Flag/event | Scope | Rule |
|---|---|---|
| `O_NONBLOCK` | shared file-status flag | operations report `EAGAIN` rather than waiting |
| `FD_CLOEXEC` | per descriptor | prevent unintended inheritance across `exec` |
| `MSG_DONTWAIT` | per call on supporting systems | non-blocking attempt without changing shared status |
| `MSG_PEEK` | per call | observes without consuming; repeated copies/work can be expensive |
| `MSG_WAITALL` | stream receive hint/behavior varies on exceptional conditions | still handle signals, EOF, errors, and partial results |
| `MSG_TRUNC` / `MSG_CTRUNC` | receive result flags | payload/control data was truncated |
| `EPOLLIN` | Linux readiness | read/accept may progress; call determines result |
| `EPOLLOUT` | Linux readiness | write/connect may progress; check state and `SO_ERROR` |
| `EPOLLRDHUP` | Linux 2.6.17+ stream readiness | peer closed its write direction; still drain/read |
| `EPOLLERR` / `EPOLLHUP` | Linux readiness | reported independently of requested mask; inspect/drain state |

### Portability labels

- **POSIX core:** `socket`, `bind`, `listen`, `accept`, `connect`, `send`/`recv`, `sendto`/`recvfrom`, `sendmsg`/`recvmsg`, `shutdown`, `select`, `poll`, address conversion/resolution functions.
- **Widely available but semantics differ:** reuse options, buffer sizing, `MSG_WAITALL`, linger details, signal suppression, multicast controls, timestamp APIs.
- **Linux-specific in this chapter:** creation type flags, `accept4`, `epoll`, `recvmmsg`/`sendmmsg`, error queue, `MSG_NOSIGNAL`, `MSG_ZEROCOPY`, busy-poll controls, many BPF/reuseport controls, `/proc` and the shown diagnostic commands.
- **Version/vendor dependent:** defaults, limits, queue accounting, autotuning, readiness integration, offload behavior, hardware timestamps, busy polling, zero-copy fallback and performance.

## 45.11 Recall and Practice — Core

### Recall card

- A descriptor is a handle; lifetime, descriptor flags, file-status flags, and socket state live at different layers.
- TCP calls report byte progress. Retain every unsent suffix and parse every received prefix incrementally.
- UDP calls preserve datagrams. Detect truncation; zero bytes can be a real message.
- Readiness can be stale. Non-blocking calls and `EAGAIN` complete the protocol between application and kernel.
- For non-blocking connect, writable means “finished somehow”; `SO_ERROR` distinguishes success.
- Arm write readiness only while ordered output is pending. Bound both work per event and queued bytes.
- Options are conditional OS APIs, not magic performance settings. State platform, lifecycle point, workload, cost, and measurement.
- `shutdown(SHUT_WR)` half-closes a stream; `close` releases a descriptor. Business outcome remains an application-protocol question.
- Batching amortizes syscall overhead but can add queueing. Zero-copy replaces a copy with a completion-based ownership contract.

### Interview questions

1. A non-blocking `send` accepts 300 of 800 bytes. What exact state must the application retain, and when should it request write readiness?
2. Why can a blocking stream send still require a partial-I/O loop? What does a positive result prove?
3. A UDP `recvmsg` returns zero. How do you distinguish it from TCP EOF, and what flag must be checked before parsing?
4. A socket becomes writable after `connect` returned `EINPROGRESS`. Give the success/failure decision sequence.
5. Compare level-triggered and edge-triggered readiness when an application receive buffer fills before the socket reaches `EAGAIN`.
6. A service has low network RTT but requests become 8 ms old during bursts. Derive the measurements that distinguish syscall cost from queueing.
7. Explain why permanently monitoring `EPOLLOUT` spins, and why never re-arming after a short write loses progress.
8. When would `SO_REUSEPORT` help, and what Linux/version/distribution behaviors must be tested before relying on it?
9. Why is a successful TCP `send` insufficient evidence for safely replaying or not replaying an order after reconnect?
10. Under what payload/rate/ownership conditions might `MSG_ZEROCOPY` win, and what failure occurs if a buffer is reused before completion?

### Code-reading puzzle

This intentionally broken loop handles a non-blocking stream:

```cpp
void on_event(int fd, std::vector<std::byte>& frame) {
    if (::send(fd, frame.data(), frame.size(), 0) >= 0)
        frame.clear();

    std::byte header[4];
    if (::recv(fd, header, sizeof header, 0) == sizeof header)
        parse_header(header);
}
```

Find at least eight defects or missing policies. Start with: partial send discards a suffix; zero-byte send progress is mishandled; `SIGPIPE` policy is absent; `EINTR`/`EAGAIN`/terminal errors are conflated; new output can bypass earlier pending bytes; a four-byte TCP header can be split; payload length and buffer bounds are absent; EOF is ignored; fairness and deadlines are absent; descriptor ownership during callbacks is unspecified.

### Implementation exercise

Build a loopback test with a non-blocking `socketpair` or TCP pair:

1. Frame records with a bounded length prefix.
2. Restrict send/receive buffers and make the receiver sleep to force short writes.
3. Send randomized record sizes while injecting signals.
4. Toggle readiness interest according to the output queue.
5. Split reads at every byte boundary and include zero-length records.
6. Assert exact record order, bounded memory, no idle write interest, and clean half-close.

Then add a UDP socket test containing an empty datagram, a maximum legal datagram, and one larger than the receive buffer. Verify that truncation is detected and no residual suffix appears on the next receive.

### Common traps

- Treating an fd number as unique forever; descriptors are reused.
- Setting close-on-exec after publishing a descriptor in a multithreaded process.
- Assuming accepted sockets inherit non-blocking state portably.
- Treating blocking send as “all bytes or error.”
- Treating TCP reads as records or retrying a datagram receive to obtain its truncated remainder.
- Treating UDP zero-length receive as EOF.
- Ignoring `EINTR`, spinning on `EAGAIN`, or using `errno` after a successful call.
- Treating readiness as a reservation or non-blocking connect writability as success.
- Draining an edge-triggered socket into unbounded memory.
- Leaving write/error readiness active without draining or pending work.
- Growing socket buffers without computing queue age and overload behavior.
- Recommending reuse, timeout, cork, keepalive, busy-poll, or zero-copy settings without an OS/version and measurement.
- Closing from one thread to cancel another without a defined ownership/cancellation design.
- Retrying Linux `close` after an error and accidentally closing a reused descriptor.
- Treating transport delivery as application commit.
- Reusing a zero-copy buffer before its completion.

### Prerequisite for Chapter 46

Carry forward three objects: application buffers, socket queues/state, and the readiness/wakeup relationship between them. Chapter 46 follows packets below the socket boundary through the Linux transmit and receive paths. It assumes you can distinguish application queueing, socket queueing, protocol behavior, and device-path cost before tuning any of them.
