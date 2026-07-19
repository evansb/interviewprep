# Chapter 45 — Socket Programming

*Interview-focused revision notes. The theme: the socket API is a thin, leaky abstraction over the kernel's packet machinery — every call is a syscall, every buffer is a copy, and every option you set is really a knob on a queue somewhere in Ch. 46's pipeline. Knowing which knob moves which microsecond is the whole game.*

---

## 45.1 Socket Lifecycle

A **socket** is a kernel object (`struct socket` wrapping a protocol-specific `struct sock`) referenced by a file descriptor. The descriptor is an index into the process's file-descriptor table (Ch. 34 §34.17); the underlying object is reference-counted and can outlive the descriptor via `dup`, `fork`, or `SCM_RIGHTS` passing (Ch. 33 §33.3).

```c
int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
```

The three arguments:

| Argument | Meaning | Values that matter |
|---|---|---|
| `domain` | Address family | `AF_INET`, `AF_INET6`, `AF_UNIX`, `AF_PACKET` (raw L2, Ch. 47 §47.9), `AF_XDP` |
| `type` | Semantics | `SOCK_STREAM` (reliable byte stream), `SOCK_DGRAM` (unreliable message), `SOCK_RAW`, `SOCK_SEQPACKET` |
| `protocol` | Usually 0 (infer from type) | `IPPROTO_TCP`, `IPPROTO_UDP`, `ETH_P_ALL` for raw |

**`SOCK_NONBLOCK` and `SOCK_CLOEXEC` in the type field are Linux extensions and are the correct way to create such sockets.** The alternative — `socket()` then `fcntl(F_SETFL, O_NONBLOCK)` — costs two extra syscalls and, for `CLOEXEC`, has a genuine race: between `socket()` and `fcntl()` another thread can `fork`+`exec` and leak the descriptor. Same applies to `accept4()` versus `accept()`. This is a small detail that reliably separates people who have written production network code from people who have read a tutorial.

The lifecycle for the two socket types:

```
STREAM server:  socket → setsockopt → bind → listen → accept → read/write → shutdown → close
STREAM client:  socket → setsockopt → [bind] → connect → read/write → shutdown → close
DGRAM:          socket → setsockopt → bind → recvfrom/sendto → close
DGRAM connected: socket → bind → connect → recv/send → close
```

**Order matters.** Several options must be set *before* `bind` or `listen` to take effect: `SO_REUSEADDR`, `SO_REUSEPORT`, and `SO_RCVBUF` (because the initial window and the auto-tuning state are derived at connection setup). Setting `SO_RCVBUF` on an already-established TCP connection changes the buffer but the peer has already been told a window; the effect is muted. Setting `SO_REUSEPORT` after `bind` returns success and does nothing useful.

### Descriptor states and the kernel objects behind them

A listening TCP socket owns **two queues** (Ch. 38 §38.2):

- **SYN queue** (incomplete): connections that have received a SYN and sent SYN-ACK. Sized by `net.ipv4.tcp_max_syn_backlog`.
- **Accept queue** (complete): fully-established connections waiting for `accept()`. Sized by `min(backlog, net.core.somaxconn)`.

`listen(fd, backlog)` sizes the *accept* queue. When it overflows, the kernel's behaviour depends on `net.ipv4.tcp_abort_on_overflow`: 0 (default) silently drops the ACK, so the client thinks it is connected and the server retransmits SYN-ACK — producing the notorious "connection succeeded but the first request hangs for 1 second" symptom; 1 sends RST, which fails fast. **Diagnostic signature:** `nstat -az TcpExtListenOverflows` / `TcpExtListenDrops` incrementing, or `ss -lnt` showing `Recv-Q` at or near `Send-Q` on a listening socket (for listeners those columns mean *current accept-queue depth* and *backlog*, not bytes — a classic misreading).

**Latency framing:** socket creation is ~2–5 µs (allocation, inode, fd table entry); it never belongs on a hot path. Trading systems create every socket at startup, `connect` during warmup, and treat the descriptor set as immutable for the session (Ch. 55 §55.1).

---

## 45.2 Binding, Listening, Accepting and Connecting

### bind

`bind()` associates a local address (IP + port) with the socket. Without it, the kernel assigns an ephemeral port at `connect()` time from `net.ipv4.ip_local_port_range` (default 32768–60999).

```c
sockaddr_in a{};
a.sin_family = AF_INET;
a.sin_port   = htons(9000);           // network byte order — Ch. 36 §36.9
a.sin_addr.s_addr = htonl(INADDR_ANY);
bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof a);
```

The `sockaddr_in*` → `sockaddr*` cast is the canonical real-world use of first-member pointer-interconvertibility for standard-layout types (Ch. 3 §3.6). `sockaddr_storage` is the correct type for a family-agnostic buffer; `sockaddr` itself is too small for IPv6.

Non-obvious binds:

- **Binding the source address on a client** before `connect` pins which NIC/route is used — essential on multi-homed trading hosts where the market-data NIC and the order-entry NIC are different cards on different NUMA nodes (Ch. 29 §29.21).
- **`IP_FREEBIND` / `net.ipv4.ip_nonlocal_bind`** allows binding an address the host does not (yet) own — used for failover VIPs (Ch. 56 §56.4).
- **`SO_BINDTODEVICE`** forces egress through a specific interface, bypassing the routing table. Requires `CAP_NET_RAW`.
- **Ephemeral-port exhaustion** is a real production failure: 28k ports, `TIME_WAIT` holding each for 60 s (Ch. 38 §38.17) caps you at ~470 connections/s to a single destination tuple. Diagnostic: `connect()` returning `EADDRNOTAVAIL`, and `ss -s` showing tens of thousands of `timewait`.

### listen

```c
listen(fd, 1024);   // clamped to net.core.somaxconn (default 4096 on modern kernels)
```

### accept

`accept()` removes the head of the accept queue and returns a **new** descriptor for the established connection; the listening socket is unaffected. `accept4(fd, addr, len, SOCK_NONBLOCK|SOCK_CLOEXEC)` is the version to use.

**Crucially, the accepted socket does not inherit `O_NONBLOCK` from the listener** — a perennial bug. It *does* inherit most socket options (`SO_RCVBUF`, `TCP_NODELAY` set on the listener propagates on Linux, but this is not portable; set it explicitly on the accepted fd).

### connect

For blocking sockets, `connect()` returns when the handshake completes (~1 RTT). For non-blocking sockets it returns `-1/EINPROGRESS` immediately; completion is signalled by the socket becoming **writable**, and you must then call `getsockopt(fd, SOL_SOCKET, SO_ERROR, ...)` to distinguish success from failure — a writable-and-failed socket is indistinguishable from writable-and-connected otherwise. This is the single most common non-blocking-connect bug.

```c
int err; socklen_t l = sizeof err;
getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &l);
if (err) { /* connection failed with errno == err */ }
```

**`connect()` on a UDP socket** does not send anything. It stores the peer address in the socket, which has three effects worth knowing:
1. You may use `send`/`write` instead of `sendto` — this **skips a route lookup per datagram**, worth roughly 100–200 ns.
2. The kernel filters inbound datagrams to that source, cheaply.
3. You now receive ICMP port-unreachable errors as `ECONNREFUSED` on the next `recv` — unconnected UDP sockets silently discard them. This is how you detect a dead multicast retransmission peer.

**TCP Fast Open** (`TCP_FASTOPEN`, `MSG_FASTOPEN`) carries data in the SYN, saving one RTT on reconnect. Rarely used in colocated trading because the RTT is already microseconds, but it is a legitimate answer for WAN order routing.

---

## 45.3 Datagram Send and Receive

```c
ssize_t n = recvfrom(fd, buf, len, flags, (sockaddr*)&src, &srclen);
ssize_t m = sendto  (fd, buf, len, flags, (sockaddr*)&dst,  dstlen);
```

Datagram semantics (Ch. 37 §37.1) are **message-preserving**: one `sendto` produces exactly one datagram, one `recvfrom` consumes exactly one datagram, and there is no partial read. Consequences that get asked about:

- **A short buffer truncates.** If the datagram is 1500 bytes and `len` is 1000, you get 1000 bytes and *the rest is discarded*. `MSG_TRUNC` in the returned `msg_flags` tells you it happened; passing `MSG_TRUNC` as an input flag makes `recvmsg` return the *full* datagram length so you can size a retry. Silent truncation is a classic feed-handler corruption source.
- **A zero-length datagram is legal** and returns 0 — which is *not* EOF for a datagram socket. Code that treats `n == 0` as "peer closed" (correct for TCP) breaks on UDP heartbeats.
- **`recvfrom` fills the source address**, costing a copy of `sockaddr_storage` (128 bytes) into user space. Pass `nullptr` if you do not need it; on a connected socket, do.

### Flags worth knowing

| Flag | Effect |
|---|---|
| `MSG_DONTWAIT` | Per-call non-blocking. Avoids `fcntl` churn; preferred when a descriptor is shared. |
| `MSG_PEEK` | Read without consuming. Costs a full copy you will pay again; almost never right on a hot path. |
| `MSG_WAITALL` | Block until the full `len` is read (stream sockets). Interacts badly with timeouts. |
| `MSG_TRUNC` (in) | Return real datagram size (UDP). |
| `MSG_ERRQUEUE` | Read from the error queue, not the data queue (§45.15). |
| `MSG_MORE` | Corking hint: more data follows, coalesce (Ch. 38 §38.14). |
| `MSG_ZEROCOPY` | Defer the copy; completion via error queue (§45.16). |
| `MSG_CONFIRM` | Tells ARP the path is valid, suppressing a re-probe. Rarely material. |

### Cost model

A single-datagram `recvfrom` on a warm, connected UDP socket costs roughly:

```
syscall entry/exit (Ch. 34 §34.5)         ~ 40–70 ns  (more with Spectre/Meltdown mitigations, ~100–200 ns)
socket lock + dequeue skb                 ~ 100 ns
copy_to_user (64-byte payload)            ~ 50 ns
skb free                                  ~ 100 ns
------------------------------------------------------
total                                       ~300–500 ns per datagram
```

That is the *syscall half* only. The packet already spent 2–10 µs traversing the kernel stack (Ch. 46). This is the number that motivates kernel bypass (Ch. 47).

**Multicast receive specifics** (Ch. 37 §37.5): you must `bind` to the port and then join the group with `IP_ADD_MEMBERSHIP` (or `MCAST_JOIN_SOURCE_GROUP` for SSM). Binding to `INADDR_ANY` means you receive traffic for that port from *every* joined group on *every* interface — cross-talk between two feeds sharing a port number is a real and confusing bug. Bind to the group address itself to filter in the kernel, and specify `imr_interface` explicitly rather than letting the routing table choose.

---

## 45.4 Stream Send and Receive

TCP is a byte stream (Ch. 38 §38.1): message boundaries do not exist. Every `send` may be split, every `recv` may return less than asked for, and two `send` calls may arrive coalesced in one `recv`.

```c
ssize_t n = recv(fd, buf, len, flags);
//  n > 0  : bytes read (possibly < len — ALWAYS)
//  n == 0 : orderly shutdown by peer (FIN received)
//  n < 0  : errno — EAGAIN/EWOULDBLOCK, EINTR, ECONNRESET, ...
```

The correct mental model is that `recv` returns "whatever is in the receive queue right now, up to `len`", and `send` returns "however much I could put in the send queue right now". Both are advisory about the peer: **a successful `send` means the bytes are in the kernel's send buffer, not that they reached the peer, and certainly not that the application read them.** This is why application-level acknowledgement is mandatory in order-entry protocols (Ch. 54 §54.9).

### The write path in detail

`send()` on an established TCP socket:
1. Acquire the socket lock.
2. Copy user bytes into `sk_buff`s allocated from the socket's send budget (Ch. 46 §46.7).
3. If the congestion window and receive window allow, and Nagle allows (Ch. 38 §38.13), hand the skb to the transmit path immediately — **the sending thread performs the transmit inline**, all the way to the driver's doorbell write. This is why `send()` latency is not just a queue push; it includes TSO segmentation, checksum setup, and an MMIO write (Ch. 46 §46.2).
4. Otherwise the data sits in the write queue until an ACK opens the window.

That inline transmit is a load-bearing fact: it means `send()` costs 1.5–4 µs of *your* thread's time on the critical path, and it means that reducing per-send work (fewer, larger writes; `TCP_NODELAY`; pre-touched buffers) directly reduces tick-to-trade.

### Framing

Because there are no boundaries, every stream protocol needs framing (Ch. 51 §51.7): length-prefix, delimiter, or fixed-size records. The parse loop must handle a header split across two `recv` calls.

```cpp
// Canonical non-blocking stream read loop with a ring buffer.
for (;;) {
    ssize_t n = ::recv(fd, rb.write_ptr(), rb.writable(), 0);
    if (n > 0)  { rb.commit(n); parse_all_complete_frames(rb); continue; }
    if (n == 0) { peer_closed(); break; }
    if (errno == EINTR)  continue;
    if (errno == EAGAIN) break;          // drained; return to the event loop
    fatal(errno);
}
```

**`EINTR` must be retried** for slow syscalls when a signal handler was installed without `SA_RESTART` (Ch. 33 §33.13). `EAGAIN` and `EWOULDBLOCK` are the same value on Linux but not guaranteed by POSIX to be; check both or use the Linux value knowingly.

### Latency-relevant behaviours

- **`recv` copies.** 1500 bytes ≈ 60–100 ns of `copy_to_user` plus cache pollution: the payload lands in L1/L2 evicting your working set. `MSG_ZEROCOPY` exists only for transmit (§45.16); zero-copy *receive* on stock TCP requires `SO_ZEROCOPY`-adjacent `TCP_ZEROCOPY_RECEIVE` with page-aligned mmap and is fiddly (Ch. 47 §47.12).
- **Reading in a loop until `EAGAIN`** costs one extra syscall (the one returning `EAGAIN`). Under level-triggered epoll you may skip it and let the next `epoll_wait` tell you; under edge-triggered you may not (§45.10).
- **`recv` with a large buffer is strictly better than several small ones** — the per-call overhead dominates for small reads. 64 KB read buffers are typical.

---

## 45.5 Socket Shutdown and Close

Two different operations that are constantly confused.

| | `close(fd)` | `shutdown(fd, how)` |
|---|---|---|
| Acts on | The **descriptor** | The **connection** |
| Reference counting | Decrements; the socket dies only at refcount 0 (so a `dup`'d or `fork`'d fd keeps it alive) | Immediate, affects all descriptors referring to the socket |
| Direction control | All or nothing | `SHUT_RD`, `SHUT_WR`, `SHUT_RDWR` |
| Sends FIN | Only when the last reference drops | `SHUT_WR` sends FIN now |
| Frees the fd | Yes | No — you must still `close` |

**`shutdown(fd, SHUT_WR)` is the half-close** (Ch. 38 §38.21): it sends FIN, telling the peer "I have no more data," while you continue to read their response. This is the correct way to end a request/response exchange where the peer must still reply. `close()` after `shutdown(SHUT_WR)` is still required to free the descriptor.

### The lingering question

`close()` on a socket with unsent data in the send buffer normally returns immediately and the kernel continues to transmit in the background, sending FIN when the queue drains. `SO_LINGER` changes this:

```c
struct linger l;
l.l_onoff = 1; l.l_linger = 0;   // linger ON, timeout ZERO
setsockopt(fd, SOL_SOCKET, SO_LINGER, &l, sizeof l);
close(fd);                        // sends RST, discards queued data, NO TIME_WAIT
```

| `l_onoff` | `l_linger` | Behaviour |
|---|---|---|
| 0 | — | Default: `close` returns at once; kernel drains and FINs in background. |
| 1 | 0 | **Abortive close**: RST immediately, queued data discarded, no `TIME_WAIT`. |
| 1 | N>0 | `close` blocks up to N seconds waiting for the send queue to drain and be ACKed; then FIN, or RST on timeout. |

The `l_onoff=1, l_linger=0` form is the standard trick for a server that must avoid accumulating `TIME_WAIT` state on forced disconnects — and it is *data-destructive*, so it is only correct when you have already confirmed at the application layer that the peer has everything. Using it as a blanket "fix" for `TIME_WAIT` corrupts protocols.

**Blocking `close` with lingering is a hidden latency landmine**: a single-threaded event loop that calls `close` on a socket with `SO_LINGER` and a nonzero timeout can stall for seconds. Never set a positive linger timeout on a hot-path thread.

### The `TIME_WAIT` side

`TIME_WAIT` is held by the side that closes **first** (sends the first FIN), for `2×MSL` (60 s on Linux, not tunable without a rebuild). It exists to absorb delayed duplicate segments and to guarantee the peer's FIN is ACKed. It consumes an ephemeral port on the *initiating* side. Server-side `TIME_WAIT` is cheap (the local port is fixed); client-side `TIME_WAIT` exhausts ports (§45.2). `net.ipv4.tcp_tw_reuse=1` allows reusing `TIME_WAIT` sockets for new *outgoing* connections when timestamps make it safe; `tcp_tw_recycle` was removed in 4.12 because it broke behind NAT — quoting that removal is a good signal of currency.

### Descriptor hygiene

- `close()` can return `EINTR`. **On Linux the descriptor is closed regardless**; retrying is a use-after-free race on the fd number (another thread may have been handed it). Never retry `close`.
- Closing a descriptor that another thread is blocked in `recv()` on does **not** reliably wake it. The portable fix is `shutdown()` (which does wake it with 0/`ECONNRESET`), or a wakeup `eventfd` in the poll set (Ch. 33 §33.8).
- `EBADF` from `close` means a double-close: a serious bug, because the number may have been reused.

---

## 45.6 Socket Address and Port Reuse

Three distinct options, routinely conflated.

| Option | Purpose | Semantics |
|---|---|---|
| `SO_REUSEADDR` | Rebind while old connections are in `TIME_WAIT` | Allows `bind` to a port with `TIME_WAIT` sockets present. For multicast/UDP, also allows multiple sockets on the same addr+port (all receive copies). |
| `SO_REUSEPORT` | Multiple *listening/bound* sockets on the exact same addr+port, load-balanced | Kernel hashes the 4-tuple to pick one socket. All bind()ers must set it, and (unless `SO_REUSEPORT` + matching uid) must be the same user. |
| `SO_REUSEPORT` + `SO_ATTACH_REUSEPORT_[C]BPF` | Programmable steering | A BPF program chooses the receiving socket index instead of the default hash. |

**`SO_REUSEADDR` is not about "sharing a port".** For TCP it is about the `TIME_WAIT` restriction, and it is what every server should set before `bind` so that a restart does not fail with `EADDRINUSE` for 60 seconds. It does *not* let two live TCP listeners share a port.

### `SO_REUSEPORT` — the important one

Introduced in Linux 3.9. `N` processes/threads each create a socket, set `SO_REUSEPORT`, and `bind` the same address:port. The kernel then:

- For **TCP**: hashes the incoming SYN's 4-tuple and enqueues the connection to exactly one listener's accept queue. Each thread has its own accept queue.
- For **UDP**: hashes each datagram's 4-tuple and delivers it to exactly one socket's receive queue.

This solves two problems at once:
1. **The thundering herd on accept** (§45.10) — no shared listener to wake everyone on.
2. **Cross-core lock contention** on the single accept queue / receive queue, which is a real scalability wall above ~100k conn/s.

```c
int one = 1;
setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);   // BEFORE bind
bind(fd, ...); listen(fd, 1024);
```

Architecture: one socket per pinned worker thread, each thread's socket on a NIC queue steered to that thread's core (Ch. 46 §46.15). This gives a shared-nothing receive path — no cross-core cache-line bouncing on the socket lock (Ch. 26 §26.15).

**Failure modes with a diagnostic signature:**
- **Rebalancing on socket removal.** When a `SO_REUSEPORT` socket closes, the group is re-hashed. In-flight SYNs and, for UDP, in-flight datagrams that were destined for the departing socket are *dropped*, and existing UDP flows get remapped to different sockets. Symptom: connection resets and datagram loss precisely during a rolling restart. Mitigation: `SO_ATTACH_REUSEPORT_EBPF` with a stable mapping, or drain via a BPF program that stops steering to the departing socket before it closes.
- **Uneven distribution.** The 4-tuple hash is uniform only over many distinct tuples. A handful of long-lived connections from one source distributes terribly. Symptom: one worker at 100% CPU, the rest idle. `ss -lnt` shows one socket with a deep `Recv-Q`.
- **A non-`SO_REUSEPORT` binder steals the port**: if the first binder does not set the flag, subsequent ones get `EADDRINUSE`.

`SO_REUSEPORT` on **UDP multicast** does not fan out — for multicast, `SO_REUSEADDR`/`SO_REUSEPORT` semantics give *every* socket a copy of every datagram (which is what you want when two processes consume the same feed). Getting the fan-out-vs-load-balance distinction right for UDP unicast versus multicast is a good discriminating question.

---

## 45.7 Socket Buffer Sizing

Every socket has a receive queue and a send queue, measured in bytes of `sk_buff` *charged* memory — not payload bytes.

```c
int sz = 4 * 1024 * 1024;
setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &sz, sizeof sz);   // kernel DOUBLES the value
```

**The doubling is real and confuses everyone**: Linux stores `sk_rcvbuf = 2 * requested`, on the theory that roughly half is consumed by `sk_buff` metadata overhead. `getsockopt(SO_RCVBUF)` returns the doubled value. The overhead ratio is charged per-skb, so with small datagrams the *effective payload* capacity can be far below half — a 1 MB `SO_RCVBUF` (2 MB charged) may hold only ~300 KB of 64-byte datagram payloads, because each carries a `sk_buff` (~200 B) plus a page fragment.

### Limits and knobs

| sysctl | Meaning |
|---|---|
| `net.core.rmem_default` / `wmem_default` | Default per-socket buffer |
| `net.core.rmem_max` / `wmem_max` | Ceiling for `SO_RCVBUF`/`SO_SNDBUF` |
| `net.ipv4.tcp_rmem` = min default max | TCP **auto-tuning** triple |
| `net.ipv4.tcp_wmem` = min default max | Same for send |
| `net.ipv4.tcp_moderate_rcvbuf` | Enables receive auto-tuning (on by default) |

**`SO_RCVBUF` disables TCP receive auto-tuning.** Setting it explicitly pins the buffer and stops the kernel from growing it to match the bandwidth-delay product (Ch. 38 §38.18). On a WAN link that is usually a pessimisation; in colo, where BDP is tiny, pinning is fine and gives predictability. `SO_RCVBUFFORCE`/`SO_SNDBUFFORCE` (needs `CAP_NET_ADMIN`) exceed `rmem_max`.

### Sizing for latency versus loss

The tension is exact:

```
Too small  → drops under microburst (Ch. 39 §39.5).  Signature: UdpRcvbufErrors,
             TcpExtTCPRcvQDrop, ss showing Recv-Q pegged at the limit.
Too large  → bufferbloat: a slow reader accumulates a deep queue, and the data you
             finally read is stale by (queue_bytes / drain_rate) — which for market
             data is worse than dropping it.  Ch. 38 §38.19.
```

For **market data** the correct sizing is *large enough to absorb the worst expected microburst over your worst expected scheduling delay*, and no larger. A 10 GbE feed bursting at line rate for 200 µs delivers 250 KB; if your thread can be descheduled for 1 ms you need ~1.25 MB. Then you must *detect* when the buffer was ever deep, because deep means stale: track `SO_RCVBUF` occupancy via `ioctl(FIONREAD)` or the `SIOCINQ` ioctl at each read, and alarm on watermarks (Ch. 56 §56.11).

For **order entry**, the send buffer should be small: you want `send()` to fail or block rather than silently queue 4 MB of orders you can no longer cancel. Backpressure visibility beats buffering (Ch. 52 §52.15).

**Diagnostics:** `ss -tim` shows `skmem:(r<rcv_queue>,rb<rcv_buf>,t<snd_queue>,tb<snd_buf>,f<fwd_alloc>,w<wmem_queued>,o<opt_mem>,bl<backlog>,d<drops>)`. The `d` field — per-socket drops — is the direct evidence of receive-buffer overflow on that specific socket, and knowing that field exists is a strong signal.

---

## 45.8 Busy-Poll Socket Options

Normally a blocking `recv()` puts the thread to sleep; the packet arrives, an interrupt fires, NAPI runs in softirq, the skb is queued, and the thread is woken. The wakeup path costs **5–15 µs** end to end (interrupt latency + softirq scheduling + run-queue wakeup, Ch. 31 §31.16).

**Busy polling** removes it: instead of sleeping, the *application's own thread* drives the NIC's NAPI poll routine directly from the syscall context.

```c
unsigned int usec = 50;
setsockopt(fd, SOL_SOCKET, SO_BUSY_POLL, &usec, sizeof usec);
// or globally: sysctl net.core.busy_poll = 50, net.core.busy_read = 50
```

The mechanism: `recv()` finds the queue empty, and instead of sleeping it calls `napi_busy_loop()` on the NAPI instance associated with the socket's last-received packet (`sk->sk_napi_id`), repeatedly polling the NIC RX ring for up to `usec` microseconds. A packet that arrives during that window is processed in-line and returned to the caller with **no interrupt, no softirq scheduling, and no context switch**.

```
Blocked recv:   pkt → IRQ → softirq → skb queued → wake → sched → recv returns   ~15 µs
Busy-poll recv: pkt →(app thread polls ring)→ skb built → recv returns            ~2–5 µs
```

| Knob | Scope | Note |
|---|---|---|
| `SO_BUSY_POLL` | Per socket, blocking recv | Requires `CAP_NET_ADMIN` above `net.core.busy_poll_range`, and driver NAPI support |
| `net.core.busy_read` | Global default for `SO_BUSY_POLL` | |
| `net.core.busy_poll` | Global default for `poll`/`select`/`epoll` busy polling | |
| `SO_PREFER_BUSY_POLL` (5.11+) | Suppresses NAPI's own deferral so the app stays authoritative | Pairs with `napi_defer_hard_irqs` and `gro_flush_timeout` |
| `EPIOCSPARAMS` / `epoll` `busy_poll_usecs` (6.9+) | Per-epoll-instance busy poll | The modern, precise interface |

**Preconditions people forget:**
- `sk_napi_id` is only populated after at least one packet has been received on the socket, so **the first receive never busy-polls**. Warm the socket at startup.
- The driver must implement `ndo_busy_poll`/NAPI polling (ixgbe, i40e, ice, mlx5 do; virtio historically did not).
- Busy polling burns a full core at 100%. It is only viable on isolated cores (Ch. 31 §31.19) with `nohz_full`.
- It contends with the NAPI softirq for the same ring. `SO_PREFER_BUSY_POLL` + `napi_defer_hard_irqs=2` + `gro_flush_timeout=200000` is the standard tuning that keeps interrupts off while the app polls.

**Where it sits in the hierarchy:** busy polling gets a stock kernel socket from ~15 µs to ~3–5 µs. Kernel bypass (Ch. 47) gets to ~1 µs. Busy polling is the "no vendor library, no code rewrite" tier, and that framing — *it removes the wakeup, not the stack* — is the answer interviewers want.

---

## 45.9 Socket Timestamp Options

Knowing *when* a packet arrived, accurately, is the foundation of latency measurement (Ch. 48 §48.9) and of one-way latency analysis.

Three generations of API:

| API | Resolution | Source | Verdict |
|---|---|---|---|
| `SO_TIMESTAMP` | microsecond, `timeval` | Software, at skb receive in softirq | Legacy |
| `SO_TIMESTAMPNS` | nanosecond, `timespec` | Same | Legacy-ish |
| `SO_TIMESTAMPING` | nanosecond, multiple stamps per packet | Software *and* NIC hardware | **The one that matters** |

```c
int flags = SOF_TIMESTAMPING_RX_HARDWARE      // NIC PHY timestamp on RX
          | SOF_TIMESTAMPING_TX_HARDWARE      // NIC PHY timestamp on TX
          | SOF_TIMESTAMPING_SOFTWARE         // kernel-entry timestamp
          | SOF_TIMESTAMPING_RAW_HARDWARE     // deliver the raw PHC value
          | SOF_TIMESTAMPING_OPT_ID           // tag TX stamps with a sequence number
          | SOF_TIMESTAMPING_OPT_TSONLY;      // TX completions carry no payload copy
setsockopt(fd, SOL_SOCKET, SO_TIMESTAMPING, &flags, sizeof flags);
```

**RX timestamps arrive as ancillary data on the data `recvmsg` (§45.14). TX timestamps arrive later, on the *error queue* (§45.15)** — this asymmetry is the single most-missed detail. A transmit timestamp cannot be delivered with the `send()` call because the packet has not been transmitted yet; the NIC stamps it at the PHY and the driver posts a completion, which the kernel enqueues on the socket's error queue for you to reap with `recvmsg(fd, &msg, MSG_ERRQUEUE)`.

```c
// RX side: parse cmsg for SCM_TIMESTAMPING
for (cmsghdr* c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
    if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_TIMESTAMPING) {
        auto* ts = reinterpret_cast<timespec*>(CMSG_DATA(c));
        // ts[0] = software, ts[1] = deprecated, ts[2] = raw hardware (PHC domain)
    }
}
```

**The three-slot array is a classic gotcha.** `ts[0]` is the software stamp (in `CLOCK_REALTIME`), `ts[1]` is legacy/unused, `ts[2]` is the hardware stamp **in the NIC's PHC time domain, not the system clock**. To compare a hardware RX stamp with a `clock_gettime` reading you must either discipline the system clock to the PHC with `phc2sys`, or read the offset explicitly with `PTP_SYS_OFFSET_PRECISE` (Ch. 35 §35.7). Reporting hardware stamps as if they were system time is a real, frequently-shipped bug; the error is the PHC-to-system offset, typically tens to hundreds of nanoseconds, but unbounded if `phc2sys` is not running.

**Enabling hardware timestamping** requires a separate ioctl on the *interface*, not the socket:

```bash
hwstamp_ctl -i eth0 -r 1 -t 1     # rx_filter=ALL, tx_type=ON
ethtool -T eth0                    # capabilities + which PHC index
```

`ethtool -T` output is the diagnostic: it lists supported `SOF_TIMESTAMPING_*` capabilities and the `PTP Hardware Clock` index. If it reports `hardware-receive` absent, no amount of socket-option code will produce a hardware stamp — you silently fall back to software, which is 1–3 µs later and jittery.

**What each stamp actually measures:**

```
wire → [PHY: RX_HARDWARE] → DMA → IRQ → softirq → [SOFTWARE] → skb queue → recvmsg
        ^ true arrival                              ^ ~1–3 µs later, jitter ~µs
```

Subtracting hardware RX from your application's `rdtsc` (Ch. 43 §43.12) after cross-calibration gives you the true kernel-plus-application receive latency — which is exactly the number you present when arguing for kernel bypass.

---

## 45.10 Non-Blocking Socket Event Loops

### Blocking versus non-blocking versus readiness versus completion

Four concepts, two axes. Define them precisely before using them:

| Model | Question the API answers | Examples |
|---|---|---|
| **Blocking** | "Do the work; wake me when done." | `recv` on a blocking fd |
| **Non-blocking** | "Do what you can right now; tell me if it was nothing." | `recv` + `EAGAIN` |
| **Readiness** | "Tell me *when* I could do the work without blocking." Then I do it. | `select`, `poll`, `epoll`, `kqueue` |
| **Completion** | "Here is the work and the buffer; tell me when it is *done*." | `io_uring`, Windows IOCP, POSIX AIO |

Readiness models require two syscalls per unit of work (wait, then read). Completion models require one submission and one completion, and the completion can be batched or polled without any syscall at all (§45.11, Ch. 34 §34.20).

### epoll semantics

```c
int ep = epoll_create1(EPOLL_CLOEXEC);
epoll_event ev{ .events = EPOLLIN | EPOLLET, .data = { .ptr = conn } };
epoll_ctl(ep, EPOLL_CTL_ADD, fd, &ev);
int n = epoll_wait(ep, out, MAXEV, timeout_ms);
```

`epoll` is O(1) in the number of watched descriptors because the kernel keeps a per-instance **ready list** (a doubly-linked list) that descriptors are pushed onto by their wake callbacks; `epoll_wait` just drains it. `select`/`poll` are O(N) because the entire descriptor set is copied in and scanned on every call — the reason `select` is unusable above a few hundred fds, and the reason it caps at `FD_SETSIZE` (1024) with silent stack corruption beyond it (Ch. 34 §34.9).

### Edge-triggered versus level-triggered

| | **Level-triggered (default)** | **Edge-triggered (`EPOLLET`)** |
|---|---|---|
| Reports | "The fd *is* readable" — every call, while data remains | "The fd *became* readable" — only on a state transition |
| If you read partially | Reported again next `epoll_wait` | **Not reported again.** You hang. |
| Required read discipline | Read once, return to loop | Loop until `EAGAIN` |
| Syscalls per event | More `epoll_wait` returns | Fewer returns, one extra `recv` (the `EAGAIN`) |
| Thundering herd (multi-thread) | Wakes every waiter | Wakes one (but see below) |
| Ease of correctness | Forgiving | Unforgiving |

The edge-triggered contract: **you must drain the descriptor to `EAGAIN`, or you will never hear about it again.** This is the number-one epoll bug, and its signature is a connection that goes permanently silent under load while others are fine — because a `recv` was cut short by a full application buffer and nobody ever re-armed.

Corollary traps:
- **A partial write under `EPOLLET|EPOLLOUT`**: if `send` returns short, you must keep `EPOLLOUT` armed; if it returns the full amount you should *disarm* it, or you spin on a permanently-writable socket burning CPU. The standard design is to arm `EPOLLOUT` only when a write is pending.
- **`EPOLLET` does not de-duplicate across events.** A new packet arriving while you are still draining generates another edge; you may get a spurious wakeup where the fd is already drained. Handle `EAGAIN` on the first read gracefully.
- **`EPOLLERR` and `EPOLLHUP` are always reported**, whether or not you asked for them, and cannot be masked. `EPOLLRDHUP` (peer sent FIN, half-close) is the one you must request explicitly and is how you detect an orderly peer shutdown without a read.

### The thundering-herd problem

If `N` threads call `epoll_wait` on the *same* epoll instance watching the *same* listening socket, an incoming connection makes the kernel wake **all N** — they race, one wins `accept`, the rest get `EAGAIN` and go back to sleep. Cost: `N-1` wasted context switches (~2–5 µs each), plus run-queue lock contention, plus cache pollution. At 100k conn/s with 32 threads this is catastrophic.

Four remedies, in ascending order of quality:

1. **One thread accepts, hands off.** Simple; the accept thread is a bottleneck and the hand-off costs a queue push plus a wakeup.
2. **`EPOLLEXCLUSIVE`** (Linux 4.5): added to the `epoll_ctl` events mask on the *listening* fd, it tells the kernel to wake only one (or a few) waiters. It is a *hint* — the kernel may still wake more than one — and it forbids `EPOLL_CTL_MOD` afterwards. It solves the multi-epoll-instance-per-thread case.
3. **`SO_REUSEPORT`** (§45.6): each thread has its own listening socket and its own accept queue; the kernel steers by hash. No shared wake-up point at all. This is the standard modern answer.
4. **Kernel bypass with per-queue polling** (Ch. 47 §47.11): no wakeups exist to stampede.

Note the same herd exists for *level-triggered epoll on a shared connected socket*, which is why "one epoll instance per thread, descriptors partitioned, never shared" is the canonical low-latency event-loop architecture.

### `EPOLLONESHOT`

Delivers an event once, then disables the fd until you re-arm with `EPOLL_CTL_MOD`. It is the correct primitive for a thread pool processing one connection at a time: it guarantees no two threads ever handle the same fd concurrently, which readiness models otherwise do not.

---

## 45.11 Batched Datagram Syscalls

At 300–500 ns of syscall overhead per datagram (§45.3), a 1 Mpps feed spends 0.3–0.5 s per second — a third of a core — purely on syscall entry and exit. Batching amortises it.

```c
struct mmsghdr msgs[64];
struct iovec   iov [64];
char           bufs[64][2048];
for (int i = 0; i < 64; ++i) {
    iov[i]  = { bufs[i], sizeof bufs[i] };
    msgs[i].msg_hdr = { nullptr, 0, &iov[i], 1, nullptr, 0, 0 };
}
timespec to{0, 0};
int n = recvmmsg(fd, msgs, 64, MSG_DONTWAIT, &to);
for (int i = 0; i < n; ++i)
    handle(bufs[i], msgs[i].msg_len);      // msg_len is per-datagram
```

`recvmmsg`/`sendmmsg` (note the double *m* — "multiple messages") transfer up to `vlen` datagrams in one syscall. Each `mmsghdr` is a `msghdr` plus a `msg_len` output field.

| | Per-datagram cost, 1 msg | Per-datagram cost, 64 msgs |
|---|---|---|
| Syscall entry/exit | ~50–200 ns | ~1–3 ns amortised |
| Socket lock acquire | ~30 ns | amortised (taken once) |
| Copy + skb free | ~150 ns | ~150 ns (unavoidable) |
| **Total** | **~300–500 ns** | **~160–200 ns** |

Roughly a 2× throughput improvement — significant for a throughput-bound feed handler, and **irrelevant or harmful for latency**, which is the point to make in an interview.

**The latency trap:** `recvmmsg`'s `timeout` argument is checked only *between* datagrams, not before the first, and famously the timeout is not re-armed correctly in older kernels (a documented bug in the man page). Worse: if you call `recvmmsg` for 64 and only 1 arrives, you either block waiting for 63 more (fatal for latency) or pass `MSG_DONTWAIT` and get 1 — in which case you have gained nothing over `recvfrom`. **Batching only helps when the queue is already deep**, i.e. when you are behind. The correct architecture is: busy-poll or epoll to learn that data exists, then `recvmmsg` with `MSG_DONTWAIT` to drain whatever accumulated. That is "batch on the recovery path, not the fast path" — the same trade-off as Ch. 52 §52.13.

**`MSG_WAITFORONE`** is the fix for the blocking form: return as soon as at least one datagram is available, having opportunistically collected any others. This is the flag you want if you are going to block.

For transmit, `sendmmsg` batches similarly and pairs well with a burst of order messages or a multicast retransmission replay. Note that `sendmmsg` can return a partial count with an error on the *next* message; `msgs[i].msg_len` for `i < ret` tells you what was sent, and `errno` describes message `ret`.

**GSO for UDP** (`UDP_SEGMENT`) is the complementary trick: one `sendmsg` of a large buffer plus a segment size, and the kernel (or the NIC) splits it into MTU-sized datagrams (Ch. 46 §46.10). One syscall, many packets — better than `sendmmsg` when the datagrams are the same size to the same destination.

---

## 45.12 BPF Socket Filters

A **socket filter** is a small program the kernel runs on each packet *before* it is queued to the socket, deciding how many bytes to accept (0 = drop). It moves filtering from user space (after a copy and a wakeup) to the kernel receive path.

```c
// Classic BPF (cBPF), the sock_filter form
struct sock_fprog prog = { .len = n, .filter = insns };
setsockopt(fd, SOL_SOCKET, SO_ATTACH_FILTER, &prog, sizeof prog);
// eBPF variant: SO_ATTACH_BPF with a loaded program fd
// Detach: SO_DETACH_FILTER;  lock against modification: SO_LOCK_FILTER
```

Two dialects:

| | **cBPF** (classic) | **eBPF** (extended) |
|---|---|---|
| Registers | 2 (A, X), 32-bit | 11, 64-bit |
| Attach | `SO_ATTACH_FILTER` | `SO_ATTACH_BPF` |
| Maps / state | None | Yes — counters, hash maps, per-CPU arrays |
| Source | `tcpdump -d` output, `libpcap` compiler | C compiled by clang to BPF target |
| Verifier | Simple | Full CFG verifier, bounded loops |

Internally, cBPF is translated to eBPF and JIT-compiled (`net.core.bpf_jit_enable=1`), so the runtime cost is native code — typically 20–80 ns for a simple header match.

### Where it matters for trading

1. **Multicast port sharing.** When two feeds land on the same UDP port on a socket bound to `INADDR_ANY`, a filter on the destination group address discards the unwanted one *before* the copy and the wakeup. Without it, you pay a full receive plus a user-space discard for every foreign packet.
2. **`SO_ATTACH_REUSEPORT_[C]BPF`** — a *steering* program rather than a filter: it returns the index of the `SO_REUSEPORT` group member that should receive the packet. This lets you steer by symbol, by session, or by any header field, giving deterministic thread affinity for a given instrument instead of a 4-tuple hash (§45.6). This is the strongest answer to "how do you make sure all packets for instrument X land on the same core?" short of NIC flow steering (Ch. 46 §46.14).
3. **Capture narrowing.** `libpcap`'s filter string compiles to cBPF and is attached to an `AF_PACKET` socket. `tcpdump -d 'udp port 4000'` prints the generated instructions — worth being able to say.

### Limits and traps

- The filter runs **per socket, in softirq context**, on the receiving CPU. A slow filter directly adds to softirq time and delays every subsequent packet on that queue.
- Filters see the packet **after** the kernel's protocol demux for the socket type, so an `AF_INET` UDP socket's filter sees the IP header for raw sockets but the semantics differ by socket type — always test what offset 0 actually is.
- **A filter attached after packets are already queued does not retroactively filter them.** For an exact start, attach a "drop everything" filter, drain, then attach the real one — this is the documented `libpcap` race workaround.
- `SO_LOCK_FILTER` prevents an unprivileged descendant from removing your filter after a privilege drop.
- For truly hot paths, XDP (Ch. 47 §47.8) runs *before* skb allocation and is strictly cheaper than a socket filter; a socket filter is the "I still want a normal socket" tier.

---

## 45.13 Partial TCP I/O

Every stream `send` and `recv` may transfer less than requested. This is not an error condition; it is the normal contract, and code that ignores it corrupts data under exactly the load conditions where it matters.

### Short writes

```cpp
bool write_all(int fd, const std::byte* p, size_t n) {
    while (n) {
        ssize_t k = ::send(fd, p, n, MSG_NOSIGNAL);
        if (k > 0) { p += k; n -= k; continue; }
        if (k < 0 && errno == EINTR)  continue;
        if (k < 0 && errno == EAGAIN) return false;   // caller must buffer + arm EPOLLOUT
        return false;                                  // fatal
    }
    return true;
}
```

`send` returns short when the socket send buffer fills — i.e. when the peer's receive window is closed, or the congestion window is small, or the buffer is simply smaller than your message. On a **blocking** socket, `send` blocks until it has queued *everything* (POSIX guarantees a blocking write of `n` bytes returns `n` or an error, for sockets)... except that it can be interrupted by a signal after partial transfer and return the partial count. On a **non-blocking** socket, short writes are routine.

**`MSG_NOSIGNAL` on every `send` is mandatory.** Writing to a socket whose peer has closed raises `SIGPIPE`, whose default disposition terminates the process. `MSG_NOSIGNAL` converts it to `EPIPE`. The alternatives — `signal(SIGPIPE, SIG_IGN)` globally, or `SO_NOSIGPIPE` on BSD/macOS — are coarser. A trading process killed by `SIGPIPE` mid-session is a real, embarrassing outage.

### The pending-write state machine

A correct non-blocking writer needs three states, and this is a standard whiteboard question:

```
IDLE      : no pending bytes, EPOLLOUT disarmed
          → send() directly on new data; if short, buffer remainder, arm EPOLLOUT, → PENDING
PENDING   : bytes buffered, EPOLLOUT armed
          → on EPOLLOUT: flush; if fully flushed, disarm EPOLLOUT → IDLE
          → on new data: append to buffer only (never send out of order!)
OVERFLOW  : buffer exceeded the watermark → disconnect or shed (Ch. 52 §52.16)
```

The "never send out of order" rule is the subtle one: once anything is buffered, *all* subsequent data must go through the buffer, or you interleave and corrupt the stream.

Leaving `EPOLLOUT` armed permanently is the mirror bug: a writable socket with nothing to write makes `epoll_wait` return immediately, forever, and your event loop spins at 100% CPU with zero work. **Diagnostic signature: a busy loop with `epoll_wait` returning instantly and no `recv` syscalls in `strace`.**

### Short reads

Every framing bug begins here. `recv` returning 3 bytes of an 8-byte header is normal. The parser must be a **resumable** state machine over a ring buffer, never a "read exactly N" helper on a non-blocking socket. On a *blocking* socket `MSG_WAITALL` gives you "read exactly N", but it interacts badly with `SO_RCVTIMEO` (on timeout it returns the partial count, and you have no way to know how much of the remaining timeout to use) and it destroys latency because you wait for a full frame instead of processing what arrived.

### Related knobs

- **`TCP_CORK`**: hold small writes and coalesce until 200 ms or uncorked. Throughput tool, latency poison (Ch. 38 §38.14). `MSG_MORE` is the per-call version.
- **`TCP_NOTSENT_LOWAT`**: limits *unsent* bytes in the send queue, so `EPOLLOUT` fires only when the application can meaningfully add data rather than when there is buffer space. Reduces application-level buffer bloat and is how you keep the newest order at the head of the queue rather than behind 2 MB of stale ones.
- **`SIOCOUTQ` / `TIOCOUTQ` ioctl**: bytes still unacknowledged in the send queue. The direct measurement for "how far behind is my order gateway?" and a good watermark alarm source.

---

## 45.14 `recvmsg` Ancillary Data

`recvmsg`/`sendmsg` are the general forms of the socket I/O calls. Two capabilities beyond `recv`/`send`:

1. **Scatter-gather** via an `iovec` array (Ch. 34 §34.15) — read a header into one buffer and the body into another with no copy or split.
2. **Ancillary data (control messages, "cmsg")** — out-of-band metadata alongside the payload.

```c
struct msghdr {
    void*         msg_name;       // src/dst sockaddr (in/out)
    socklen_t     msg_namelen;
    struct iovec* msg_iov;        // scatter-gather array
    size_t        msg_iovlen;
    void*         msg_control;    // ancillary buffer
    size_t        msg_controllen; // IN: capacity; OUT: bytes used
    int           msg_flags;      // OUT on recv: MSG_TRUNC, MSG_CTRUNC, MSG_EOR...
};
```

The control buffer is a sequence of variable-length, alignment-padded `cmsghdr` records, and **must** be walked with the macros — the padding rules are platform-specific and hand-rolled offsets break:

```c
char cbuf[CMSG_SPACE(sizeof(timespec[3])) + CMSG_SPACE(sizeof(in_pktinfo))];
msghdr m{}; m.msg_control = cbuf; m.msg_controllen = sizeof cbuf;
recvmsg(fd, &m, 0);
for (cmsghdr* c = CMSG_FIRSTHDR(&m); c; c = CMSG_NXTHDR(&m, c)) { ... }
```

`CMSG_SPACE(n)` is the buffer size to reserve (includes header + padding); `CMSG_LEN(n)` is the value to put in `cmsg_len` (header + data, no trailing pad). **Using `CMSG_LEN` where `CMSG_SPACE` is needed under-allocates and silently truncates the last message** — signalled by `MSG_CTRUNC` in `msg_flags`, which almost nobody checks. That check is the diagnostic: if timestamps stop appearing, print `msg_flags`.

### The control messages that matter

| Level / Type | Direction | Content |
|---|---|---|
| `SOL_SOCKET` / `SCM_TIMESTAMPING` | RX and errqueue | The three-slot timestamp array (§45.9) |
| `SOL_SOCKET` / `SCM_RIGHTS` | Both, `AF_UNIX` | **File-descriptor passing** between processes (Ch. 33 §33.3) |
| `SOL_SOCKET` / `SCM_CREDENTIALS` | `AF_UNIX` | Verified pid/uid/gid of the peer — kernel-attested, unforgeable |
| `IPPROTO_IP` / `IP_PKTINFO` | RX (needs `IP_PKTINFO` sockopt) | `ipi_ifindex`, `ipi_spec_dst`, `ipi_addr` — **which interface and which destination address** the datagram arrived on |
| `IPPROTO_IP` / `IP_TOS`, `IP_TTL` | RX | Received DSCP / TTL |
| `IPPROTO_IP` / `IP_ORIGDSTADDR` | RX (with `IP_TRANSPARENT`) | Original destination before redirect |
| `SOL_IP` / `IP_RECVERR` | errqueue | ICMP error detail (§45.15) |
| `SOL_UDP` / `UDP_SEGMENT` | TX | GSO segment size for batched UDP send |

**`IP_PKTINFO` is the answer to a genuinely common problem**: a socket bound to `INADDR_ANY` receiving multicast cannot otherwise tell *which group* a datagram was addressed to, nor which NIC it came in on. For a redundant A/B feed arbitration (Ch. 53 §53.6) where both feeds share a port, `ipi_addr` is how you label the packet. It also lets a UDP server reply from the same address it was addressed on — without it, the reply's source address is chosen by the routing table and may differ, which breaks NAT traversal and confuses exchanges.

**`SCM_RIGHTS`** is the mechanism behind zero-downtime restarts: the old process passes its listening socket to the new one over a UNIX socket, so the accept queue and all established connections survive the handover. Traps: the fd is duplicated (both processes hold references, so the socket lives until both close), a `SCM_RIGHTS` message with `MSG_CTRUNC` **leaks the descriptors in the receiving process** (they were installed then discarded — a real fd leak), and you must send at least one byte of real payload or the control message may be dropped.

---

## 45.15 The Linux Socket Error Queue

Every socket has a third queue besides receive and send: the **error queue**, read with `recvmsg(fd, &msg, MSG_ERRQUEUE)`. It carries asynchronous notifications that have no place in the byte stream.

```c
setsockopt(fd, SOL_IP, IP_RECVERR, &one, sizeof one);      // enable for IPv4
// later, when POLLERR / EPOLLERR fires:
char cbuf[512]; char payload[64];
iovec  iov{payload, sizeof payload};
msghdr m{}; m.msg_iov=&iov; m.msg_iovlen=1;
m.msg_control=cbuf; m.msg_controllen=sizeof cbuf;
ssize_t n = recvmsg(fd, &m, MSG_ERRQUEUE);
```

Contents, by `cmsg_type`:

| Type | Meaning |
|---|---|
| `IP_RECVERR` → `struct sock_extended_err` with `ee_origin == SO_EE_ORIGIN_ICMP` | An ICMP error (port unreachable, fragmentation needed, TTL exceeded) plus the offending packet's header |
| `ee_origin == SO_EE_ORIGIN_LOCAL` | A local error: no route, `EMSGSIZE`, queue full |
| `SCM_TIMESTAMPING` | **Transmit timestamps** (§45.9) |
| `ee_origin == SO_EE_ORIGIN_ZEROCOPY` | `MSG_ZEROCOPY` completions (§45.16) |

### Why it exists and why it matters

For **UDP**, ICMP errors are normally invisible: a datagram to a closed port elicits an ICMP port-unreachable that the kernel discards, and your `sendto` keeps returning success forever. With `IP_RECVERR` on a *connected* UDP socket you learn about it — either as `ECONNREFUSED` from the next `recv`, or in full detail (including which datagram) from the error queue. **This is the only way to detect that your order-entry UDP endpoint or multicast retransmission server is dead.** Without it, the diagnostic signature of a dead peer is "everything looks fine and nothing happens", which is the worst possible failure mode in a trading system.

`IP_RECVERR` also enables **Path MTU Discovery reporting**: an ICMP "fragmentation needed" arrives with `ee_info` containing the next-hop MTU, and `sendto` starts returning `EMSGSIZE`. Without `IP_RECVERR`, `EMSGSIZE` on UDP is delivered but the *reason* and the correct new size are not.

### Operational rules

- **The error queue must be drained.** It has a finite size (charged against `SO_RCVBUF` via `sk_error_queue`); an undrained queue means dropped notifications and, for `MSG_ZEROCOPY`, pinned pages that are never released (§45.16).
- `EPOLLERR` is reported unconditionally — you cannot mask it — and it is the signal to drain. Under level-triggered epoll, **failing to drain the error queue makes `epoll_wait` return immediately forever**: a 100% CPU spin with no data. This exact symptom, "epoll spinning on EPOLLERR", is a great war story to have.
- Reading the error queue does **not** consume normal data, and normal reads do not consume errors. They are independent queues on the same descriptor.
- `SO_ERROR` (via `getsockopt`) fetches and *clears* the simple pending error; it is the non-detailed sibling used for non-blocking connect (§45.2).

---

## 45.16 `MSG_ZEROCOPY`

The normal `send()` path copies user bytes into kernel `sk_buff` pages. For large payloads that copy dominates: ~1 GB/s per core of pure `copy_from_user` at ~0.1 ns/byte plus the cache pollution of pushing your payload through L1.

`MSG_ZEROCOPY` (Linux 4.14 for TCP, 5.0 for UDP) instead **pins the user pages and lets the NIC DMA directly from them**.

```c
int one = 1;
setsockopt(fd, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof one);   // required, before use
ssize_t n = send(fd, buf, len, MSG_ZEROCOPY);
// buf MUST remain unmodified and alive until the completion arrives on the error queue
```

### The mechanism

1. `send` walks the user buffer, `get_user_pages`-pins each page, and attaches page references to the skb as fragments. No bytes are copied.
2. The kernel assigns a monotonically increasing 32-bit **completion ID** per `MSG_ZEROCOPY` send on that socket.
3. When the NIC has DMA'd the data *and* (for TCP) the data has been acknowledged so it can never be retransmitted from those pages, the kernel unpins and posts a completion to the **error queue** with `ee_origin == SO_EE_ORIGIN_ZEROCOPY` and a range `[ee_info, ee_data]` of completed IDs.
4. Only then may the application reuse or free the buffer.

```
send(MSG_ZEROCOPY) ──► pages pinned, id=N assigned ──► NIC DMA ──► ACK ──►
                                                     errqueue: "ids 12..17 done"
```

### When it wins and when it loses

| Payload size | Verdict |
|---|---|
| < ~10 KB | **Loses.** Page pinning (`get_user_pages`), the completion notification, and the error-queue `recvmsg` cost more than the copy. The kernel documentation states ~10 KB as the break-even. |
| 10 KB – 1 MB | Wins on CPU: roughly 20–40% reduction in send-side CPU at high rates. |
| Streaming bulk | Clear win; this is what it was built for (Facebook's original use case). |

For a **trading order message of 60 bytes, `MSG_ZEROCOPY` is strictly worse than a plain copy** — and knowing that is the point. Its place in a trading system is bulk paths: journal replication (Ch. 56 §56.1), market-data replay servers, drop-copy archives.

Also note: **it is not zero *syscall*.** You still pay `send`, and you now additionally pay a `recvmsg(MSG_ERRQUEUE)` — unless you amortise by reaping many completions at once, which the ID-range encoding is designed for.

**`ee_code & SO_EE_CODE_ZEROCOPY_COPIED`** in the completion means the kernel gave up and copied anyway (it does this when the pages could not be pinned, e.g. under memory pressure, or when the device cannot DMA from them). Silently falling back is the failure mode; check that bit or you will be measuring a copy you thought you had eliminated.

---

## 45.17 Zero-Copy Completion Ownership

This section is really about a general principle that recurs in `io_uring` (Ch. 34 §34.20), DPDK mbufs (Ch. 47 §47.2), and RDMA work requests (Ch. 47 §47.16): **in a completion model, the buffer's ownership transfers to the kernel/device for an unbounded interval, and the application must not touch it until told otherwise.**

### The ownership contract

```
Readiness model (recv/send):    caller owns the buffer before and after the call.
                                Synchronous. Simple. Costs a copy.

Completion model (MSG_ZEROCOPY, io_uring, RDMA, DPDK):
    submit  →  DEVICE OWNS THE BUFFER  →  completion  →  caller owns it again
               (may be microseconds; may be seconds if TCP is retransmitting)
```

Violating it produces the worst class of bug: **the wire content differs from what you believe you sent**, with no crash and no error. If you `send(MSG_ZEROCOPY)` an order, then reuse the buffer to build the next order before the completion arrives, and TCP then retransmits the first segment, the peer receives the *second* order's bytes under the first order's sequence numbers. Symptom: an exchange reporting an order you never sent, or a checksum/parse failure at the peer, occurring only under packet loss. It is unreproducible in a clean lab.

### Buffer lifetime management patterns

| Pattern | Mechanism | Trade-off |
|---|---|---|
| **Ring of buffers + completion index** | Preallocate `N` slots; a slot is reusable only when its ID has been completed. Since IDs are sequential per socket, a single "highest completed ID" watermark suffices. | Simple, allocation-free (Ch. 55 §55.1). Needs `N` sized for the worst-case outstanding window. |
| **Refcounted buffers** | Each send takes a reference; the completion drops it. | Flexible; an atomic RMW per send (Ch. 25 §25.4) and a nontrivial free path. |
| **Copy small, zero-copy large** | Threshold at ~10 KB. | The pragmatic default. |
| **Never reuse** (arena, bump-allocate, reclaim in bulk) | Reset the arena when all outstanding completions are reaped. | Best for latency; memory-hungry (Ch. 7 §7.7). |

### Backpressure and the pinning limit

Pinned pages count against `RLIMIT_MEMLOCK` (Ch. 32 §32.15). Exceeding it makes `MSG_ZEROCOPY` fall back to copying (with `SO_EE_CODE_ZEROCOPY_COPIED` set) or fail with `ENOBUFS`. The application must therefore bound its outstanding-send window explicitly — the completion queue *is* the flow-control signal, exactly as a bounded queue's occupancy is (Ch. 52 §52.15).

**Out-of-order and coalesced completions.** Completions arrive as *ranges* (`ee_info`..`ee_data`) and consecutive ranges are merged by the kernel to save error-queue space. Your reaping code must handle "IDs 5–19 completed" in one message, and must handle wraparound of the 32-bit counter on a long-lived high-rate socket. Assuming one completion per send is the classic implementation error.

**The generalisable interview point:** every zero-copy mechanism replaces a *copy* with an *ownership protocol*. The copy was CPU you could see; the ownership protocol is complexity and a class of silent corruption bugs you cannot. Choose zero-copy when the copy is measurably dominant, and never on a small-message hot path.

---

## Key Interview Questions

1. **Why create sockets with `SOCK_NONBLOCK | SOCK_CLOEXEC` rather than `fcntl` afterwards?** — Saves two syscalls and closes a fork/exec descriptor-leak race; `accept4` is the equivalent for accepted sockets.
2. **What is the difference between `close` and `shutdown`?** — `close` drops a descriptor reference (the socket may survive via `dup`/`fork`); `shutdown` acts on the connection immediately and can close one direction, which is how you do a half-close.
3. **When does `SO_LINGER` with a zero timeout make sense?** — Abortive close: RST, no `TIME_WAIT`, queued data discarded. Only safe after application-level confirmation; a positive timeout makes `close` block, which is fatal on an event-loop thread.
4. **`SO_REUSEADDR` versus `SO_REUSEPORT`?** — The former relaxes the `TIME_WAIT` bind restriction; the latter creates a load-balanced group of sockets on the same address:port with per-socket accept/receive queues.
5. **What breaks during a rolling restart with `SO_REUSEPORT`?** — Removing a socket re-hashes the group, dropping in-flight SYNs and remapping UDP flows; fix with an eBPF steering program that drains first.
6. **Why does `setsockopt(SO_RCVBUF, 1MB)` then `getsockopt` return 2 MB?** — Linux doubles the request to account for `sk_buff` overhead, and the effective payload capacity is lower still for small datagrams.
7. **Edge-triggered versus level-triggered epoll — what is the contract?** — ET reports transitions only, so you must drain to `EAGAIN` or lose the descriptor forever; LT reports state, so a partial read is safe but costs more wakeups.
8. **What is the thundering herd and how do you eliminate it?** — All threads waiting on a shared listener are woken for one connection; fix with `SO_REUSEPORT` (best), `EPOLLEXCLUSIVE`, or a single accept thread.
9. **How does a non-blocking `connect` report failure?** — The fd becomes writable in both success and failure; you must call `getsockopt(SO_ERROR)` to distinguish.
10. **What does `connect()` do on a UDP socket?** — Sends nothing; pins the peer so `send` skips a route lookup, filters inbound by source, and enables ICMP error delivery as `ECONNREFUSED`.
11. **Why do TX timestamps arrive on the error queue but RX timestamps on the data path?** — The packet has not been transmitted when `send` returns; the NIC stamps it later and the driver posts an asynchronous completion.
12. **Hardware timestamps are in whose time domain?** — The NIC's PHC, not the system clock; you need `phc2sys` or `PTP_SYS_OFFSET_PRECISE` to compare, and `ethtool -T` to confirm the capability exists at all.
13. **When does `recvmmsg` help?** — Only when the queue is already deep; it amortises syscall entry but does nothing for the first packet's latency, and blocking for a full batch is a latency disaster. Use `MSG_DONTWAIT` or `MSG_WAITFORONE`.
14. **How do you make all packets for one instrument land on one core?** — NIC flow steering (Ch. 46 §46.14), or `SO_ATTACH_REUSEPORT_EBPF` steering within a `SO_REUSEPORT` group.
15. **What is `IP_PKTINFO` for?** — Learning which interface and which destination address a datagram arrived on — essential for disambiguating multicast groups sharing a port and for replying from the correct source address.
16. **Why must every `send` use `MSG_NOSIGNAL`?** — Otherwise writing to a closed peer raises `SIGPIPE`, whose default action kills the process.
17. **What is the `MSG_ZEROCOPY` ownership contract, and when is it a pessimisation?** — The buffer belongs to the kernel until a completion appears on the error queue; below ~10 KB the pinning and notification cost exceeds the copy, so it is wrong for small order messages.
18. **How do you tell that a UDP peer is dead?** — `IP_RECVERR` plus a connected socket: ICMP port-unreachable surfaces as `ECONNREFUSED` or a detailed error-queue entry. Without it, failure is silent.
19. **What does `SO_BUSY_POLL` actually remove?** — The interrupt and wakeup path (~10 µs), by having the application thread run NAPI itself. It does not remove the kernel stack, which is why Ch. 47 exists.

---

## Common Traps

- **Forgetting that accepted sockets do not inherit `O_NONBLOCK`** — a blocking `recv` in a supposedly non-blocking event loop stalls the whole thread.
- **Treating `recv` returning 0 as EOF on a UDP socket** — zero-length datagrams are legal.
- **Ignoring `MSG_TRUNC`** — silently truncated datagrams corrupt feed parsing.
- **Partial reads/writes assumed impossible on TCP** — the root of nearly every framing bug.
- **Missing `MSG_NOSIGNAL`** → `SIGPIPE` kills the process.
- **Leaving `EPOLLOUT` permanently armed** → 100% CPU spin with no work.
- **Edge-triggered epoll without draining to `EAGAIN`** → one connection goes permanently silent.
- **Not draining the error queue** → `EPOLLERR` spins the loop forever and pins `MSG_ZEROCOPY` pages.
- **Retrying `close()` on `EINTR`** — Linux already closed the fd; you may close another thread's descriptor.
- **Closing a socket to wake a blocked reader** — use `shutdown` or a wakeup eventfd.
- **`SO_LINGER` with a positive timeout on an event-loop thread** — a multi-second stall.
- **Blanket `SO_LINGER{1,0}` to "fix" `TIME_WAIT`** — discards unsent data and corrupts protocols.
- **Setting `SO_REUSEPORT` after `bind`** — succeeds and does nothing.
- **Setting `SO_RCVBUF` on a WAN TCP socket** — disables receive auto-tuning and caps throughput.
- **Oversized receive buffers for market data** — you receive stale data instead of dropping it.
- **Blocking `recvmmsg` waiting for a full batch** — trades tail latency for throughput you did not need.
- **Using `CMSG_LEN` where `CMSG_SPACE` is required** — truncated control data, flagged only by an unchecked `MSG_CTRUNC`.
- **Interpreting `ts[2]` hardware timestamps as system time** — they are in the PHC domain.
- **Assuming one error-queue completion per `MSG_ZEROCOPY` send** — completions arrive as merged ID ranges.
- **Reusing a `MSG_ZEROCOPY` buffer before completion** — retransmission sends the new contents under the old sequence numbers; unreproducible without loss.
- **Ignoring `SO_EE_CODE_ZEROCOPY_COPIED`** — you measure a copy you believed you had removed.
- **Binding multicast to `INADDR_ANY` and sharing ports** — cross-talk between feeds; fix with a BPF filter, `IP_PKTINFO`, or binding the group address.
- **`select` above 1024 descriptors** — `FD_SETSIZE` overflow corrupts the stack.
- **Reading `Recv-Q` on a listening socket as bytes** — it is the accept-queue depth.

---

## Compact Recall Summary

**Lifecycle.** `socket(… | SOCK_NONBLOCK | SOCK_CLOEXEC)` and `accept4` avoid extra syscalls and fd-leak races. Options that must precede `bind`: `SO_REUSEADDR`, `SO_REUSEPORT`, `SO_RCVBUF`. A listener has a SYN queue (`tcp_max_syn_backlog`) and an accept queue (`min(backlog, somaxconn)`); overflow silently drops ACKs unless `tcp_abort_on_overflow`, and shows up as `TcpExtListenOverflows` and a deep `Recv-Q` in `ss -lnt`.

**Datagram vs stream.** UDP preserves messages, truncates silently (`MSG_TRUNC`), and returns 0 for empty datagrams. TCP has no boundaries: every read and write may be partial, so framing needs a resumable parser and writing needs an IDLE/PENDING state machine with `EPOLLOUT` armed only when data is buffered. `MSG_NOSIGNAL` always. `connect()` on UDP pins the peer, skips a route lookup, and enables ICMP error delivery.

**Close.** `close` drops a descriptor reference; `shutdown` acts on the connection and `SHUT_WR` is the half-close. `SO_LINGER{1,0}` is an abortive RST with no `TIME_WAIT` and data loss; positive linger blocks. `TIME_WAIT` is held by the first closer for 60 s and exhausts client ephemeral ports.

**Reuse.** `SO_REUSEADDR` relaxes the `TIME_WAIT` bind restriction. `SO_REUSEPORT` creates a hash-load-balanced group with per-socket queues — the standard cure for accept-queue contention and thundering herd — at the cost of re-hash-induced drops when a member leaves, fixable with `SO_ATTACH_REUSEPORT_EBPF`, which also gives deterministic per-instrument core affinity.

**Buffers.** `SO_RCVBUF` is doubled by the kernel, charged per-skb, and disables TCP auto-tuning. Size to absorb the worst microburst over the worst scheduling delay and no more; deep queues mean stale data. Watch `ss -tim` `skmem` `d` (per-socket drops), `SIOCINQ`, and `SIOCOUTQ`.

**Latency options.** `TCP_NODELAY` off Nagle (Ch. 38 §38.13). `SO_BUSY_POLL`/`SO_PREFER_BUSY_POLL` makes the app thread run NAPI, removing the ~10 µs interrupt-and-wakeup path and reaching ~3–5 µs; needs a warmed `sk_napi_id`, driver support, and an isolated core. `SO_TIMESTAMPING` gives hardware RX stamps in the data cmsg and hardware TX stamps on the *error queue*, in the PHC time domain; verify with `ethtool -T`.

**Event loops.** Readiness (epoll) = two syscalls per unit of work; completion (io_uring, Ch. 34 §34.20) = submit/complete with optional zero syscalls. epoll is O(1) via a kernel ready list; `select`/`poll` are O(N). Edge-triggered means drain to `EAGAIN` or lose the fd; level-triggered forgives partial reads. `EPOLLERR`/`EPOLLHUP` cannot be masked; `EPOLLRDHUP` must be requested; `EPOLLONESHOT` serialises a descriptor across a thread pool; `EPOLLEXCLUSIVE` blunts the herd but `SO_REUSEPORT` removes it.

**Batching and offload.** `recvmmsg`/`sendmmsg` amortise syscall entry ~2× but only when already behind — use `MSG_DONTWAIT` or `MSG_WAITFORONE`. `UDP_SEGMENT` (GSO) sends many datagrams per syscall. BPF socket filters (cBPF via `SO_ATTACH_FILTER`, eBPF via `SO_ATTACH_BPF`) drop unwanted packets in softirq before the copy and the wakeup.

**Ancillary and error queues.** `recvmsg` gives scatter-gather plus cmsgs; walk them with `CMSG_FIRSTHDR`/`CMSG_NXTHDR`, allocate with `CMSG_SPACE`, and check `MSG_CTRUNC`. Key cmsgs: `SCM_TIMESTAMPING`, `SCM_RIGHTS` (fd passing, the basis of zero-downtime restart), `IP_PKTINFO` (which group/interface). The error queue (`MSG_ERRQUEUE`, enabled by `IP_RECVERR`) delivers ICMP errors, PMTU updates, TX timestamps, and zero-copy completions; it must be drained or the loop spins on `EPOLLERR`.

**Zero-copy.** `MSG_ZEROCOPY` pins user pages for NIC DMA and returns ownership only via an error-queue completion range — wins above ~10 KB, loses badly on small order messages, and silently degrades to a copy (`SO_EE_CODE_ZEROCOPY_COPIED`). The general law: zero-copy trades a visible CPU copy for an ownership protocol whose violation corrupts the wire silently, typically only under retransmission.
