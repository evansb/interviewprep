# Chapter 38 — TCP

*Interview-focused revision notes. The theme: TCP buys reliability and fairness with buffering, timers, and state — every one of which is a latency cost, which is why it is banned from the market-data path and unavoidable on the order-entry path.*

---

## 38.1 TCP Byte-Stream Semantics

**TCP** (Transmission Control Protocol, RFC 793, updated by RFC 9293) provides a **reliable, ordered, connection-oriented byte stream** between exactly two endpoints, identified by the 4-tuple `(src IP, src port, dst IP, dst port)`.

The defining property, and the source of most application bugs: **TCP has no message boundaries.** It is a stream of bytes, not a sequence of messages.

```
 Application writes:   send("ABCDE")  send("FGHIJ")  send("KLMNO")

 Possible receives:    recv() → "ABCDEFGHIJKLMNO"      (one call, coalesced)
                       recv() → "ABC"  "DEFGHIJKL"  "MNO"   (arbitrary splits)
                       recv() → "ABCDE" "FGHIJ" "KLMNO"     (coincidence, not a guarantee)
```

Every one of these is conforming. A `send` of N bytes may be split across many segments (by MSS, by Nagle, by the congestion window) and multiple `send`s may be coalesced into one segment. Therefore **the application must impose its own framing** (§38.20). Code that assumes one `recv` returns one message works in testing on a loopback with small messages and fails in production under load — a classic, and one interviewers deliberately probe.

### The TCP header

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
┌───────────────────────────────┬───────────────────────────────┐
│        Source Port (16)       │      Destination Port (16)    │
├───────────────────────────────┴───────────────────────────────┤
│                    Sequence Number (32)                       │
├───────────────────────────────────────────────────────────────┤
│                 Acknowledgement Number (32)                   │
├───────┬───────────┬───┬───┬───┬───┬───┬───┬───────────────────┤
│ Data  │ Reserved  │C│E│U│A│P│R│S│F│                           │
│Offset │           │W│C│R│C│S│S│Y│I│      Window Size (16)     │
│ (4)   │    (4)    │R│E│G│K│H│T│N│N│                           │
├───────┴───────────┴─┴─┴─┴─┴─┴─┴─┴─┴───────────────────────────┤
│          Checksum (16)        │     Urgent Pointer (16)       │
├───────────────────────────────┴───────────────────────────────┤
│                  Options (0–40 bytes) + padding               │
└───────────────────────────────────────────────────────────────┘
   Minimum 20 bytes; Data Offset counts 32-bit words (5..15 → 20..60 B)
```

| Flag | Meaning |
|---|---|
| **SYN** | Synchronize sequence numbers — connection setup |
| **ACK** | The Acknowledgement Number field is valid (set on every segment after the first SYN) |
| **FIN** | No more data from this sender (graceful, half-close) |
| **RST** | Abort immediately — no graceful teardown, no guarantee about buffered data |
| **PSH** | Push buffered data to the application (largely advisory today) |
| **URG** + Urgent Pointer | Out-of-band data. Ambiguously specified, inconsistently implemented, **never use it** |
| **ECE / CWR** | Explicit Congestion Notification signalling (§38.19) |

### Options that matter

Options live in the 0–40 byte area and are negotiated on the SYN:

| Option | Kind | Size | Purpose |
|---|---|---|---|
| MSS | 2 | 4 B | Max segment size this side will accept (§38.2) |
| Window Scale | 3 | 3 B | Shifts the 16-bit window up to 30 bits (§38.5) |
| SACK Permitted | 4 | 2 B | Enables selective ACK (§38.11) |
| SACK blocks | 5 | 10–34 B | The actual received ranges |
| Timestamps | 8 | 10 B | RTT measurement and PAWS (§38.10) |

Timestamps and SACK together consume **12 bytes** of every data segment (10 for timestamps plus 2 of padding/NOP alignment), reducing the usable payload from 1460 to **1448** at MTU 1500.

### What TCP guarantees — and what it does not

| Guaranteed | Not guaranteed |
|---|---|
| Bytes delivered in order, exactly once, or the connection fails | Message boundaries |
| Detection of most corruption (weak 16-bit checksum) | Bounded latency |
| Flow control — the sender never overruns the receiver | That data was *processed*, only that it was received into a buffer |
| Congestion response | Delivery after a crash — a successful `send()` means "copied to the kernel buffer," nothing more |

That last row is the one to state in an interview: **`send()` returning N does not mean the peer got N bytes, let alone acted on them.** It means the kernel accepted them. Application-level acknowledgement is a separate, necessary layer for anything transactional (Ch. 54 §54.9).

---

## 38.2 TCP Three-Way Handshake

Connection establishment synchronizes initial sequence numbers in both directions and negotiates options.

```
   Client                                              Server
     │                                            (LISTEN)
     │ ── SYN, seq=x, MSS, WS, SACK-perm, TS ──────────►│
     │                                        (SYN_RECEIVED)
     │ ◄── SYN+ACK, seq=y, ack=x+1, MSS, WS, SACK, TS ──│
 (SYN_SENT→ESTABLISHED)                                 │
     │ ── ACK, seq=x+1, ack=y+1 ──────────────────────►│
     │                                       (ESTABLISHED)
     │ ── [data may ride on this third packet] ────────►│
```

**Cost: one full RTT before any application data can flow** (the client may append data to the third packet, so it is 1 RTT, not 1.5, from the client's perspective). Over a 100 µs LAN that is 100 µs; over an 80 ms transatlantic link it is 80 ms — before TLS, which adds another 1–2 RTTs (TLS 1.3: 1 RTT, or 0 with resumption).

### Why three packets and not two

The handshake must synchronize sequence numbers **in both directions** and prove each side can both send and receive. A two-way exchange would leave the server unsure the client received its ISN. The third ACK is what moves the server out of `SYN_RECEIVED`.

**Initial sequence numbers are randomized** (RFC 6528: a keyed hash of the 4-tuple plus a clock) to prevent off-path attackers guessing sequence numbers and injecting data, and to prevent old duplicate segments from a previous incarnation of the same 4-tuple being accepted.

### Option negotiation rules

Options are only negotiated on the SYN and SYN+ACK. Consequences:

- **MSS is announced, not negotiated.** Each side states the largest segment it is willing to *receive*; the sender uses `min(peer's advertised MSS, own path MTU − 40)`. There is no single "the MSS."
- **Window scaling requires both sides to send the option.** If either omits it, scaling is off for both directions and the window is capped at 65535 bytes — which caps throughput at `65535/RTT` (§38.18). A middlebox stripping the option is a real cause of mysteriously slow long-distance transfers.
- SACK and timestamps are similarly all-or-nothing.

### Backlog, SYN queue, and accept queue

The kernel maintains **two** queues on a listening socket:

```
 SYN arrives ──► [SYN queue / half-open]  ──(3rd ACK)──► [accept queue] ──► accept()
                 net.ipv4.tcp_max_syn_backlog          backlog arg to listen(),
                                                       capped by net.core.somaxconn
```

| Overflow | Behaviour | Counter |
|---|---|---|
| SYN queue full | New SYNs dropped (or SYN cookies engaged) | `netstat -s`: "SYNs to LISTEN sockets dropped" |
| Accept queue full | New completed connections dropped silently; the client believes it is connected until it times out | `netstat -s`: "times the listen queue of a socket overflowed"; `ss -lnt` `Recv-Q` vs `Send-Q` |

`ss -lnt` on a listening socket shows the **current accept-queue depth in `Recv-Q` and its limit in `Send-Q`** — a non-obvious and very useful piece of knowledge. A persistently non-zero `Recv-Q` means the application is not calling `accept()` fast enough.

**SYN cookies** (`net.ipv4.tcp_syncookies`) encode the connection state into the ISN so no SYN-queue entry is needed, defeating SYN-flood attacks. The cost is that options which do not fit in the encoded cookie (historically window scale and SACK, though modern Linux preserves them via timestamps) can be lost, degrading the connection. Enabling cookies globally on a low-latency server is a tradeoff, not a free win.

### Failure signatures

| Symptom | Cause |
|---|---|
| `ECONNREFUSED` immediately | RST returned — nothing listening on that port |
| `ETIMEDOUT` after ~2 min (`tcp_syn_retries`=6: 1+2+4+8+16+32 s) | SYN silently dropped — firewall DROP rule, blackhole route, wrong address |
| Connection "succeeds" then nothing happens | Accept queue overflow, or the server accepted but is stuck |
| Slow connects, retried SYNs | Packet loss on the path, or SYN-queue overflow |

`tcpdump -i any 'tcp[tcpflags] & (tcp-syn|tcp-rst) != 0'` isolates handshake behaviour cleanly.

---

## 38.3 TCP Connection Teardown

Teardown is **independent per direction** — TCP connections are full-duplex and each side closes its own sending half.

```
   Initiator (active close)                        Peer (passive close)
        │ (ESTABLISHED)                              (ESTABLISHED)
        │ ── FIN, seq=u ────────────────────────────────►│
   (FIN_WAIT_1)                                    (CLOSE_WAIT)
        │ ◄── ACK, ack=u+1 ─────────────────────────────│
   (FIN_WAIT_2)          ← peer may still send data! →
        │ ◄── FIN, seq=v ───────────────────────────────│
        │                                          (LAST_ACK)
        │ ── ACK, ack=v+1 ─────────────────────────────►│
   (TIME_WAIT: 2×MSL)                                (CLOSED)
        │
   (CLOSED)
```

Four packets, though the peer's ACK and FIN frequently combine into three when it has nothing more to send.

### The state machine, compactly

| State | Meaning | Who |
|---|---|---|
| `LISTEN` | Awaiting SYNs | Server |
| `SYN_SENT` | Sent SYN, awaiting SYN+ACK | Client |
| `SYN_RECEIVED` | Sent SYN+ACK, awaiting final ACK | Server |
| `ESTABLISHED` | Data transfer | Both |
| `FIN_WAIT_1` | Sent FIN, awaiting its ACK | Active closer |
| `FIN_WAIT_2` | FIN ACKed, awaiting peer's FIN | Active closer |
| `CLOSE_WAIT` | Received FIN, **application has not called `close()` yet** | Passive closer |
| `LAST_ACK` | Sent own FIN, awaiting its ACK | Passive closer |
| `TIME_WAIT` | Waiting 2×MSL before reuse (§38.17) | Active closer |
| `CLOSING` | Simultaneous close | Both |

**`CLOSE_WAIT` accumulating is always an application bug**, never a network problem: the peer closed, the kernel delivered EOF, and your code never called `close()`. It leaks a file descriptor per occurrence and ends in `EMFILE`. `ss -tan state close-wait` counts them; a rising count is one of the highest-signal diagnostics in this chapter because the conclusion is unambiguous.

### FIN vs RST

| | FIN (graceful) | RST (abortive) |
|---|---|---|
| Sends queued data first | **Yes** | **No** — discards send and receive buffers |
| Peer sees | EOF (`recv` returns 0) | `ECONNRESET` on read/write |
| Leaves TIME_WAIT | Yes, on the active closer | **No** |
| Triggered by | `close()`, `shutdown(SHUT_WR)` | `SO_LINGER` with timeout 0, writing to a closed peer, data arriving for a nonexistent connection, some firewall/OS timeouts |

An RST is generated whenever a segment arrives for a connection that does not exist — including a connection the peer rebooted out from under you. Its second arrival pattern is important: **write to a peer that has closed and you get an RST back; the *first* write succeeds locally and the *second* fails with `EPIPE`/`SIGPIPE`.** That one-write delay in error detection surprises people and matters for order-entry error handling.

`SO_LINGER` with `l_onoff=1, l_linger=0` makes `close()` send an RST instead of a FIN. This avoids TIME_WAIT and is occasionally used to reclaim ports on a client with huge connection churn — but it **discards unsent data**, so it is wrong for any session where the last messages matter. On an order-entry gateway, that could mean discarding a cancel.

### Trading relevance

An exchange session disconnect is a risk event, not a network event. What matters is the observable difference between a graceful FIN (the venue is shutting the session down; state is likely consistent) and an RST or a silent blackhole (state is unknown; orders may be live). Sane gateways treat any unexpected disconnect as "position unknown until reconciled," rely on cancel-on-disconnect where the venue provides it, and reconcile via drop copy (Ch. 54 §54.13, §54.15).

---

## 38.4 TCP Sequence and Acknowledgement Numbers

The **sequence number** is the byte offset, in a 32-bit modular space, of the first data byte in the segment. The **acknowledgement number** is the next byte the receiver expects — an ACK is **cumulative**: `ack=N` means "I have all bytes up to N−1."

```
   Sender writes 3000 bytes, MSS 1460, ISN 1000 (so first data byte is 1001):

   seg1: seq=1001  len=1460      covers bytes 1001..2460
   seg2: seq=2461  len=1460      covers bytes 2461..3920
   seg3: seq=3921  len=80        covers bytes 3921..4000

   receiver ACKs:  ack=2461  (got seg1)
                   ack=3921  (got seg2)
                   ack=4001  (got seg3, all data received)
```

### The details that matter

- **SYN and FIN each consume one sequence number** even though they carry no data. This is why the handshake ACKs `x+1`, and it is what makes them reliably retransmittable.
- **A cumulative ACK loses information.** If segments 1, 3, 4, 5 arrive and 2 is lost, the receiver can only keep saying `ack=2461`. Everything after the hole is invisible to the sender without SACK (§38.11) — which is precisely why SACK was added.
- **Sequence space wraps at 2³².** At 10 Gbit/s the space wraps in about 3.4 seconds, well inside the maximum segment lifetime. **PAWS** (Protection Against Wrapped Sequences) uses the timestamp option to disambiguate; this is a concrete reason timestamps are not optional on fast links.
- **Wrap-safe comparison** is mandatory throughout the implementation:
  ```cpp
  inline bool seq_lt(uint32_t a, uint32_t b) { return int32_t(a - b) < 0; }
  ```
  The same trick appears in application sequence handling (Ch. 37 §37.4) and is worth being able to write from memory.
- **`tcpdump` shows relative sequence numbers by default**, subtracting the ISN so the first data byte appears as 1. Use `-S` for absolute values. Reading a capture and reporting "the sequence number is 1" without knowing this is a tell.

### Duplicate ACKs

When an out-of-order segment arrives, the receiver immediately re-sends the same cumulative ACK. Repeated identical ACKs are therefore the sender's only pre-timeout evidence that something is wrong — and the ambiguity is fundamental: **duplicate ACKs mean either loss or reordering.** Three duplicates is the heuristic threshold for declaring loss (§38.8), chosen to tolerate modest reordering.

### Retransmission ambiguity

If a segment is retransmitted and an ACK arrives, the sender cannot tell whether the ACK was for the original or the retransmission — **Karn's algorithm** (§38.10) resolves this by refusing to sample RTT from retransmitted segments. The timestamp option removes the ambiguity entirely by echoing the exact timestamp, which is a cleaner solution and another reason timestamps are standard.

---

## 38.5 TCP Flow Control

**Flow control prevents a fast sender from overrunning a slow receiver.** It is entirely distinct from congestion control (§38.6), which protects the *network*. Confusing the two is one of the most common interview failures, and the distinction is worth stating explicitly.

| | Flow control | Congestion control |
|---|---|---|
| Protects | The **receiver's buffer** | The **network's** capacity |
| Signal | Advertised window (explicit, in every ACK) | Loss, delay, or ECN (inferred) |
| Sender variable | `rwnd` (told to it) | `cwnd` (computed by it) |
| Failure if absent | Receiver drops data it already accepted | Congestion collapse |

The sender is bounded by both: **`in_flight ≤ min(rwnd, cwnd)`**.

### The advertised window

Every ACK carries a 16-bit **Window Size** — the free space remaining in the receiver's buffer. 16 bits caps it at 65535 bytes, which caps throughput at `65535 / RTT`:

| RTT | Max throughput without scaling |
|---|---|
| 0.1 ms (LAN) | 5.2 Gbit/s |
| 1 ms | 524 Mbit/s |
| 10 ms | 52 Mbit/s |
| 80 ms (transatlantic) | 6.5 Mbit/s |

**Window scaling** (RFC 7323, option kind 3) fixes this: a shift count 0–14 negotiated on the SYN multiplies the advertised window by `2^shift`, allowing up to 1 GB. It must be offered by **both** sides on the SYN or it is disabled in both directions. A middlebox that strips or rewrites the option produces a connection that works but is inexplicably capped — and the signature is throughput exactly equal to `65535/RTT`. That is a satisfying diagnosis to be able to deliver.

### Zero window and the persist timer

If the receiver's buffer fills, it advertises **window 0** and the sender stops. The deadlock hazard: the window-update ACK that reopens the window is a pure ACK, and pure ACKs are not retransmitted. If it is lost, both sides wait forever.

The **persist timer** solves it: the sender periodically transmits a 1-byte **window probe**, forcing the receiver to respond with its current window. Backoff is exponential up to ~60 s.

A related pathology is **silly window syndrome** — a receiver that frees one byte at a time advertises 1-byte windows, and the sender emits 41-byte packets carrying 1 byte of payload. Fixes exist on both sides: the receiver (RFC 1122) does not advertise a window smaller than one MSS or half the buffer, and the sender (Nagle, §38.12) refuses to send small segments while data is unacknowledged.

### Buffer sizing on Linux

```
net.ipv4.tcp_rmem = 4096 131072 6291456     # min, default, max (auto-tuned)
net.ipv4.tcp_wmem = 4096 16384 4194304
net.ipv4.tcp_moderate_rcvbuf = 1            # autotuning on
```
Autotuning grows the buffer toward the measured bandwidth-delay product (§38.18). **Setting `SO_RCVBUF` or `SO_SNDBUF` explicitly disables autotuning for that socket** — a very common own-goal: a hand-tuned 256 KB buffer that seemed generous becomes a hard cap on a high-BDP path. Note also that Linux doubles the requested value to account for bookkeeping overhead, so `getsockopt` returns twice what you set.

**For latency, smaller send buffers are often better**: a large `SO_SNDBUF` lets the application queue megabytes of data in the kernel, and a message written at the back of that queue waits for everything ahead of it. On an order-entry socket you want the buffer just large enough to never block, so that queueing delay is visible as backpressure rather than hidden as latency. `TCP_NOTSENT_LOWAT` gives finer control: it limits *unsent* bytes in the kernel while keeping enough in flight to fill the pipe, and is the right tool for latency-sensitive writers.

---

## 38.6 TCP Congestion Control

**Congestion control** limits the sender's in-flight data to what the *network* can carry. It exists because of the 1986 **congestion collapse** on the NSFNET, where throughput fell by three orders of magnitude as retransmissions of already-queued packets consumed all capacity.

### Core state

| Variable | Meaning |
|---|---|
| **`cwnd`** | Congestion window — sender's estimate of what the network can hold |
| **`ssthresh`** | Slow-start threshold — the boundary between exponential and linear growth |
| **`rwnd`** | Receiver's advertised window (§38.5) |
| **`flight_size`** | Bytes sent but not yet ACKed |

The governing rule: `flight_size ≤ min(cwnd, rwnd)`.

### The self-clocking insight

TCP is **ACK-clocked**: each arriving ACK indicates a packet left the network, so a new one may enter. This means the sender's transmission rate naturally matches the bottleneck's drain rate without any explicit rate calculation. It also means **the ACK path's timing matters** — ACK compression or aggregation in the network makes transmission bursty, which is why modern Linux uses **pacing** (`fq` qdisc) to spread transmissions rather than relying purely on ACK arrivals.

### The four classic phases (RFC 5681)

```
 cwnd
   │                      ╱╲            ╱╲
   │            ╱─────────╯  ╲────────╯   ╲      ← congestion avoidance (+1 MSS/RTT)
   │          ╱                ↓ loss        ↓
   │        ╱  ← ssthresh
   │      ╱
   │    ╱  ← slow start (×2 per RTT)
   │  ╱
   │╱________________________________________ time
       ↑ start        ↑ fast recovery (halve)   ↑ RTO → cwnd=1, slow start again
```

1. **Slow start** — exponential growth; probe quickly for available capacity (§38.7).
2. **Congestion avoidance** — linear growth; probe gently (§38.7).
3. **Fast retransmit / fast recovery** — respond to 3 duplicate ACKs by retransmitting and halving, without draining the pipe (§38.8).
4. **Timeout (RTO)** — the catastrophic case: `cwnd` collapses to 1 MSS and slow start restarts (§38.10).

The asymmetry between cases 3 and 4 is the whole game. **A loss detected by duplicate ACKs costs you half your window; a loss detected by timeout costs you everything plus an RTO of at least 200 ms.** All of SACK, fast recovery, tail loss probe, and RACK exist to keep losses in category 3.

### Why this is fatal on a hot path

Congestion control means **your latency depends on other people's traffic and on your own history of loss**. A single dropped packet can:

- halve your throughput for many RTTs (fast recovery), or
- stall you for ≥ 200 ms (RTO), during which every subsequent byte queues behind the missing one (§38.15).

For market data that is unacceptable, and it is *the* structural reason UDP multicast is used (Ch. 37 §37.1). For order entry you accept it, and you engineer around it: small messages, `TCP_NODELAY`, warm connections, short paths, and no bulk traffic sharing the socket.

---

## 38.7 Slow Start and Congestion Avoidance

### Slow start

Despite the name, slow start is the **fastest-growing** phase — "slow" refers to starting from a small window rather than blasting at line rate. On each ACK, `cwnd += MSS`, which doubles `cwnd` every RTT.

```
 RTT 0:  cwnd = 10 MSS   (RFC 6928 initial window; was 1, then 2–4)
 RTT 1:  cwnd = 20
 RTT 2:  cwnd = 40
 RTT 3:  cwnd = 80
 ...
 exits when cwnd ≥ ssthresh, or on loss
```

**Initial window (IW) = 10 MSS ≈ 14.6 KB** on modern Linux (RFC 6928). This matters concretely: a 20 KB response does not fit in the first window, so it takes **2 RTTs** instead of 1. Bytes deliverable in the first N round trips: 14.6 KB, 43.8 KB, 102 KB, 219 KB. Any short-lived connection — an HTTP request, a small order-entry burst on a fresh socket — is spending its entire life in slow start and is dominated by RTT, not bandwidth.

**Slow start also restarts after an idle period** (`net.ipv4.tcp_slow_start_after_idle`, default 1): a connection idle for longer than one RTO resets `cwnd` to the initial window. On an order-entry session that is quiet between bursts, this means **your first burst after a lull is throttled** — an entirely avoidable, and frequently overlooked, source of latency. Setting `tcp_slow_start_after_idle=0` is standard practice on trading hosts, and mentioning it unprompted is a strong signal.

### Congestion avoidance

Above `ssthresh`, growth becomes linear — approximately **+1 MSS per RTT**, implemented per-ACK as `cwnd += MSS × MSS / cwnd`. This is the **AIMD** (Additive Increase, Multiplicative Decrease) rule: increase by a constant, decrease by a factor. AIMD is what makes TCP converge to fairness — Chiu and Jain showed that additive increase with multiplicative decrease drives competing flows toward an equal share, while additive decrease does not.

### The consequence for high-BDP paths

Recovering a large window with +1 MSS/RTT is glacial. To reach 10 Gbit/s at 100 ms RTT you need a window of 125 MB ≈ 85 000 segments; recovering from a single halving takes ~42 500 RTTs ≈ **71 minutes**. This is exactly why Reno was replaced (§38.9) — CUBIC's cubic growth function recovers a large window in seconds rather than hours, and it is why "long fat networks" needed a new algorithm at all.

### Where each phase shows up in practice

| Situation | Phase | Latency consequence |
|---|---|---|
| New connection, small request | Slow start, IW=10 | 1–2 RTTs; bandwidth irrelevant |
| Bulk transfer, steady state | Congestion avoidance | Bandwidth-bound |
| After idle | Slow start again | First burst is throttled — disable it |
| After a loss | Fast recovery, then avoidance | Half the window, recovered slowly |
| After a timeout | `cwnd = 1`, slow start | ≥ 200 ms stall plus a rebuild |

Diagnostics: `ss -tin` prints `cwnd`, `ssthresh`, `rtt`, `retrans`, `bytes_retrans`, and the congestion-control algorithm per socket. It is the single most useful TCP command and knowing what its fields mean is directly testable.

---

## 38.8 Fast Retransmit and Recovery

**Fast retransmit** avoids waiting for a timeout. When the sender receives **three duplicate ACKs** for the same sequence number, it infers loss and retransmits immediately, without waiting for the RTO.

```
 sent:  1  2  3  4  5  6            (segment 2 is lost)
 ACKs:      ack=2        ← for seg 1
            ack=2 (dup1) ← seg 3 arrived out of order
            ack=2 (dup2) ← seg 4
            ack=2 (dup3) ← seg 5   → FAST RETRANSMIT seg 2 now
            ack=7        ← seg 2 arrives, cumulative ACK jumps
```

**Why three?** One or two duplicate ACKs are readily explained by mild reordering; three makes reordering unlikely enough to act on. It is a heuristic, and it is why networks that reorder heavily (some ECMP configurations, Ch. 39 §39.9) cause spurious retransmissions and needless window reductions. RACK (below) replaces the counting heuristic with time.

### Fast recovery

Retransmitting alone is not enough — naively re-entering slow start would drain the pipe unnecessarily, since the duplicate ACKs prove data is still flowing. Fast recovery (RFC 5681) keeps the pipe full:

```
 ssthresh = max(flight_size / 2, 2·MSS)
 cwnd     = ssthresh + 3·MSS         ← the 3 accounts for the 3 segments that LEFT the network
 for each further dup ACK: cwnd += MSS      ← "window inflation"; keep sending new data
 on the recovery ACK:      cwnd = ssthresh  ← "deflation"; resume congestion avoidance
```

The inflation/deflation dance exists because during recovery the sender's normal `flight_size` accounting is wrong: each duplicate ACK is evidence that one more packet has left the network, so one more may be sent.

### The variants worth naming

| Mechanism | Problem solved |
|---|---|
| **NewReno** (RFC 6582) | Multiple losses in one window: a partial ACK during recovery triggers the next retransmission rather than exiting recovery, so N losses take N RTTs instead of an RTO |
| **SACK-based recovery** (RFC 6675) | With SACK the sender knows exactly which segments are missing and retransmits all of them in one RTT (§38.11) |
| **Limited Transmit** (RFC 3042) | On the 1st and 2nd dup ACK, send a *new* segment to keep ACKs flowing — essential when the window is too small to ever generate three dup ACKs |
| **Tail Loss Probe** (TLP) | The last segment of a burst has nothing behind it to generate dup ACKs, so its loss can only be found by RTO. TLP sends a probe after ~2×RTT to elicit an ACK |
| **RACK-TLP** (RFC 8985) | Replaces dup-ACK counting with **time-based** loss detection: a segment is lost if a later-sent segment was ACKed and more than an RTT+reordering-window has passed. Now the Linux default |
| **F-RTO / Eifel** | Detect that a timeout was *spurious* (the data was merely delayed) and undo the window reduction |

**The tail-loss case is the one that matters most for trading.** Request/response order entry sends small bursts and then goes quiet. If the last message of a burst is lost, there is no subsequent data to trigger duplicate ACKs, so classical TCP can only recover it by RTO — **a 200 ms+ stall for a single lost order message**. TLP reduces that to roughly 2 RTTs, and RACK further. Verifying that TLP and RACK are enabled (`net.ipv4.tcp_early_retrans`, `tcp_recovery`) on an order-entry host is a legitimate, concrete tuning action.

`ss -tin` exposes `retrans`, `lost`, `sacked`, and `reordering`; `netstat -s | grep -i retrans` gives system-wide counts, and `TCPLostRetransmit`, `TCPSpuriousRTOs`, and `TCPDSACKRecv` in `nstat` distinguish real loss from spurious detection.

---

## 38.9 Reno, CUBIC, and BBR

| | **Reno / NewReno** | **CUBIC** | **BBR** |
|---|---|---|---|
| Signal | Loss | Loss | **Delivery rate + min RTT** (delay-and-rate-based) |
| Growth | Linear, +1 MSS/RTT | **Cubic function of time since last loss** | Probes rate directly; no window growth curve |
| Reduction on loss | ×0.5 | ×0.7 | Does not react to loss per se |
| RTT fairness | Poor — short-RTT flows dominate | **Good** — growth depends on wall time, not RTT | Good |
| High-BDP recovery | Hours (see §38.7) | Seconds | Immediate |
| Bufferbloat behaviour | Fills buffers | **Fills buffers** | **Drains them** (§38.19) |
| Behaviour with random loss (wireless) | Collapses | Collapses | Tolerant |
| Default in | Historical | **Linux since 2.6.19** | Google (YouTube, GCP), opt-in elsewhere |

### CUBIC in one paragraph

`W(t) = C(t − K)³ + W_max`, where `W_max` is the window at the last loss, `K` is the time to return to it, and `C` is a scaling constant. The shape is the point: growth is **fast when far below `W_max`** (aggressive recovery), **flat near `W_max`** (careful probing where the loss occurred), and **fast again above it** (aggressive exploration of new capacity). Because `t` is wall-clock time rather than RTT counts, flows with different RTTs grow at comparable rates — fixing Reno's systematic bias against long-RTT flows.

### BBR in one paragraph

BBR (Bottleneck Bandwidth and Round-trip propagation time) models the path explicitly: it continuously estimates the **maximum delivery rate** and the **minimum RTT**, and sets `BDP = BtlBw × RTprop`, pacing at the bottleneck rate with about one BDP in flight. It periodically probes up (×1.25 for one RTT) and drains down (×0.75). Because it targets the BDP rather than "as much as fits before loss," it **keeps queues nearly empty** — dramatically lower latency on bloated paths. Criticisms: BBRv1 could be unfair to CUBIC flows and could sustain persistent queues with many flows; BBRv2/v3 add loss and ECN response to address this.

### Which to use

- **Order entry inside a colo:** the algorithm barely matters — RTT is tens of microseconds, windows are tiny, and you are never bandwidth-limited. Message size, Nagle, and interrupt handling dominate by orders of magnitude. Claiming a congestion-control change will meaningfully improve colo order-entry latency is a red flag.
- **WAN links between sites** (replication, cross-region market data, backhaul): here it matters, and **BBR is usually the better choice** for latency-sensitive traffic because it does not fill intermediate buffers.
- **Random loss (wireless, lossy long-haul):** loss-based algorithms misinterpret corruption as congestion and collapse; BBR does not.

```
sysctl net.ipv4.tcp_available_congestion_control
sysctl -w net.ipv4.tcp_congestion_control=bbr
setsockopt(fd, IPPROTO_TCP, TCP_CONGESTION, "bbr", 3);   # per socket
```
BBR should be paired with the `fq` qdisc (`tc qdisc add dev eth0 root fq`) because it relies on pacing.

**DCTCP** deserves a mention: a datacentre algorithm using ECN marks proportionally rather than as a binary signal, achieving very shallow queues within a single administrative domain. It requires ECN support on every switch in the path, which is feasible in a private fabric and not on the internet.

---

## 38.10 RTT Estimation and Retransmission Timeout

The **RTO** is the sender's fallback: if no ACK arrives within it, retransmit and treat the loss as severe. Setting it correctly is a balance — too short causes spurious retransmissions that worsen congestion, too long causes long stalls.

### The estimator (RFC 6298)

```
 On each RTT sample R:
   if first sample:  SRTT = R                 RTTVAR = R/2
   else:             RTTVAR = (1−β)·RTTVAR + β·|SRTT − R|      β = 1/4
                     SRTT   = (1−α)·SRTT   + α·R               α = 1/8
   RTO = SRTT + max(G, 4·RTTVAR)              G = clock granularity
   RTO = clamp(RTO, 1 s, 60 s)                ← RFC minimum is 1 s
```

Two exponentially-weighted moving averages: **SRTT** tracks the mean, **RTTVAR** tracks the deviation, and the RTO is mean + 4 deviations. The `4·RTTVAR` term is what makes the estimator robust to jitter rather than merely to the mean.

**Linux uses a minimum RTO of 200 ms** (`TCP_RTO_MIN`), not the RFC's 1 second. This single constant is the most-quoted number in TCP latency discussions: **a timeout-detected loss costs at least 200 ms**, which on a colo LAN with a 50 µs RTT is four thousand times the round trip. It can be lowered per-route:

```
ip route change 10.0.0.0/24 dev eth0 rto_min 5ms
```
This is a real tuning knob for a datacentre order-entry path — but lowering it too far causes spurious retransmissions that make things worse, so it is done with measurement, not by default.

### Exponential backoff

Each successive timeout for the same segment doubles the RTO: 200 ms, 400 ms, 800 ms, … up to `tcp_retries2` (default 15), giving a total of roughly **13–30 minutes** before the connection is declared dead. That is far too long for a trading session to notice a dead peer — hence application heartbeats (Ch. 54 §54.2), which detect a dead session in seconds. `TCP_USER_TIMEOUT` caps the total time unacknowledged data may remain outstanding and is the correct socket-level mechanism:

```cpp
unsigned ms = 5000;
setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &ms, sizeof ms);   // fail fast
```

### Karn's algorithm and timestamps

**Karn's algorithm**: do not take an RTT sample from a retransmitted segment, because you cannot tell whether the ACK acknowledges the original or the retransmission — sampling wrongly would corrupt SRTT in whichever direction the guess was wrong. Backoff is retained across the ambiguity and cleared only on an unambiguous sample.

**The timestamp option (kind 8, 10 bytes)** removes the ambiguity: the sender writes `TSval`, the receiver echoes it in `TSecr`, and the sender computes the exact RTT for that segment — including for retransmissions. Timestamps also enable **PAWS** (§38.4) and give one sample per ACK rather than one per RTT, producing a much better-conditioned estimator. The cost is 12 bytes per segment (10 plus alignment padding). On a high-rate small-message path that overhead is real but rarely decisive.

Measure with `ss -ti` (`rtt:<srtt>/<rttvar>` in milliseconds), and note it is the *kernel's* estimate, not an independent measurement — for true one-way latency you need hardware timestamping (Ch. 48 §48.4).

---

## 38.11 Selective Acknowledgements

**SACK** (RFC 2018) lets the receiver tell the sender exactly which non-contiguous ranges it has received, instead of only the cumulative point.

```
 sent:     1    2    3    4    5    6    7    8
 lost:          ✗              ✗
 arrived:  1         3    4         6    7    8

 without SACK:  ack=2 repeatedly.  Sender knows only "2 is missing";
                it must guess about 5, or discover it an RTT later (NewReno),
                or retransmit everything from 2 (Go-Back-N behaviour).

 with SACK:     ack=2, SACK blocks: [3–5), [6–9)
                → sender knows precisely that 2 and 5 are missing
                → retransmits exactly those two, in ONE round trip.
```

### Encoding

A SACK option carries up to **4 blocks** (each a 32-bit left and right edge = 8 bytes), plus a 2-byte header: `2 + 4×8 = 34` bytes, which is why 4 is the maximum — 40 bytes of option space, minus the 10 bytes usually consumed by timestamps, leaves room for **only 3 blocks** on a typical connection. This is a nice, concrete detail: SACK capacity is limited by the interaction of two options competing for a 40-byte budget.

The first block always reports the most recently received segment; older blocks follow. **SACK is advisory** — the receiver may later discard SACKed data (the cumulative ACK is the only binding promise), so the sender must retain SACKed segments until they are cumulatively acknowledged.

### D-SACK

**D-SACK** (RFC 2883) uses the same encoding to report a *duplicate* segment. It tells the sender "I received this twice," which lets it distinguish:

- a spurious retransmission caused by an RTO that fired too early (→ undo the window reduction),
- reordering rather than loss (→ increase the reordering threshold rather than retransmit sooner),
- ACK loss on the return path.

`nstat` counters `TcpExtTCPDSACKRecv` / `TcpExtTCPDSACKOfoRecv` are how you detect a network that reorders, and a high D-SACK rate with low real loss is the signature of an ECMP or LAG path that is spraying a flow across members (Ch. 39 §39.8).

### Why it matters

Without SACK, multiple losses in one window cost one RTT each (NewReno) or a full Go-Back-N retransmission. With SACK they cost one RTT total. On a high-BDP path with a large window, that is the difference between a hiccup and a collapse.

```
sysctl net.ipv4.tcp_sack        # 1
sysctl net.ipv4.tcp_dsack       # 1
ss -tin                          # shows 'sack' and the 'sacked' segment count
```

Historical caveat worth knowing: SACK processing has been a source of CPU-exhaustion CVEs (SACK Panic, CVE-2019-11477/11478) because a crafted sequence of SACK blocks could fragment the retransmission queue pathologically. It was patched, not removed — SACK is not optional in practice.

---

## 38.12 Nagle's Algorithm

**Nagle's algorithm** (RFC 896) reduces the number of tiny packets on the network. Its rule is a single sentence:

> If there is unacknowledged data outstanding, buffer any new small (< MSS) data until either an ACK arrives or a full MSS accumulates.

```
 Without Nagle:  "A" → packet (41 bytes: 40 header + 1 payload)
                 "B" → packet (41 bytes)
                 "C" → packet (41 bytes)      98 % overhead

 With Nagle:     "A" → packet (41 bytes), now unACKed data exists
                 "B" → buffered
                 "C" → buffered
                 ACK arrives → "BC" → one packet
```

The motivating problem was the "tinygram" flood from character-at-a-time telnet over 1980s links, where each keystroke produced a 41-byte packet and the network drowned in headers.

### Why it is wrong for trading

Nagle deliberately introduces **delay in exchange for efficiency**, and on an order-entry socket the exchange rate is terrible: you are trading microseconds of latency, which is the entire product, for bytes of bandwidth on a link that is 1 % utilized.

More precisely: a request/response protocol that writes a small order message and then waits for the exchange's ACK will have its message sent immediately if nothing is outstanding — but the moment there is *any* unacknowledged data (a pipelined second order, a partially-ACKed previous write), the next small message is held. The result is intermittent, load-dependent latency spikes that appear only under pipelining, which makes them maddening to reproduce.

**Turn it off on every latency-sensitive socket:**
```cpp
int one = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
```

### The write-pattern issue Nagle exposes

Nagle interacts badly with applications that build a message with multiple small `write()` calls (header, then body). Even with `TCP_NODELAY`, multiple writes mean multiple segments, extra syscalls, and extra header bytes. **The correct fix is not only `TCP_NODELAY` but writing the whole message in one call** — `writev`/`sendmsg` scatter-gather (Ch. 45 §45.4, Ch. 34 §34.12) or serialize into a single contiguous buffer. Interviewers like this because it shows you understand that the socket option treats a symptom whose cause is the write pattern.

The deadly combination is Nagle plus delayed ACK (§38.13) — worth understanding as a unit, because neither alone produces the 40 ms stall.

---

## 38.13 Delayed Acknowledgements

**Delayed ACK** (RFC 1122) makes the receiver wait briefly before acknowledging, hoping to (a) piggyback the ACK on outgoing data or (b) cover two segments with one ACK.

| Rule | Value |
|---|---|
| Maximum delay | 500 ms (RFC), **~40 ms on Linux** (`TCP_DELACK_MIN`), 200 ms on many others |
| Must ACK immediately | On every **second** full-size segment |
| Must ACK immediately | On out-of-order data (to trigger fast retransmit) |
| Must ACK immediately | When the receive window must be updated |

Delayed ACK is generally beneficial: it halves ACK traffic on bulk transfers and lets request/response protocols piggyback. Its pathology only emerges in combination with Nagle.

### The Nagle + delayed-ACK deadlock

This is the single most-asked TCP interaction question, and it must be explained mechanically, not as folklore.

```
 Sender has Nagle ON. Receiver has delayed ACK ON.
 Sender's message is 1.5 MSS: one full segment plus a small remainder.

  t=0     sender: send segment 1 (full MSS)        → unACKed data now exists
  t=0     sender: segment 2 is small (< MSS) and data is unACKed
                  → Nagle BUFFERS it
  t=0     receiver: got 1 segment, not two, and has no data to send
                  → delayed ACK WAITS
  ...
  t=40ms  receiver's delayed-ACK timer fires → ACK
  t=40ms  sender: ACK received, no unACKed data → sends segment 2
  t=40ms  receiver: finally has the complete message → can respond
```

**Each side is waiting for the other, and only a 40 ms timer breaks the deadlock.** The signature is unmistakable: latency quantized at multiples of ~40 ms (or ~200 ms on other stacks), appearing only for messages whose size is not a multiple of the MSS, and vanishing entirely on loopback or under continuous load. If a candidate can produce "40 ms is the delayed-ACK timer interacting with Nagle" from a latency histogram showing a spike at 40 ms, that is a very strong signal.

The fix is `TCP_NODELAY` on the sender. It is a sender-side fix for a two-sided interaction, which is worth noting: you cannot generally control the receiver's ACK policy, so you remove your own contribution.

### Delayed ACK's cost in an RPC pattern

Even without Nagle, delayed ACK adds latency to strict request/response protocols with an odd number of segments, and it delays the *sender's* congestion-window growth because `cwnd` advances per ACK, not per byte. On a short-lived connection in slow start, delayed ACK effectively halves the growth rate — one of the reasons `TCP_QUICKACK` exists (§38.14).

---

## 38.14 TCP_NODELAY, TCP_QUICKACK, and TCP_CORK

Three socket options that control the batching-versus-latency tradeoff. They are frequently confused; the table is the answer.

| Option | Side | Effect | Persistence |
|---|---|---|---|
| **`TCP_NODELAY`** | Sender | **Disables Nagle** — send small segments immediately | Sticky until changed |
| **`TCP_QUICKACK`** | Receiver | **Disables delayed ACK** — ACK immediately | **Not sticky** — Linux resets it after some ACKs; must be re-armed |
| **`TCP_CORK`** | Sender | **Opposite of NODELAY**: hold data until a full segment accumulates or 200 ms elapses | Until uncorked |

### `TCP_NODELAY`

```cpp
int one = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
```
**Set it on every latency-sensitive socket**, both client and server, immediately after `accept`/`connect`. It costs bandwidth efficiency for small messages; on a colo order-entry link that is a non-issue. Note it must be set on *both* ends if both send small messages — a common oversight is setting it on the client only.

### `TCP_QUICKACK`

```cpp
int one = 1;
setsockopt(fd, IPPROTO_TCP, TCP_QUICKACK, &one, sizeof one);   // re-arm periodically!
```
The **non-stickiness is the key non-obvious detail**. Linux enters "quickack mode" for a limited number of ACKs and then reverts to the normal delayed-ACK heuristic. Code that sets it once at connection setup and assumes it persists is subtly wrong; correct usage re-arms it after each read (or accepts the heuristic). Being able to state this distinguishes someone who has actually used it from someone who has read a list of socket options.

### `TCP_CORK`

```cpp
int one = 1;
setsockopt(fd, IPPROTO_TCP, TCP_CORK, &one, sizeof one);
write(fd, header, hlen);  write(fd, body, blen);      // both held
int zero = 0;
setsockopt(fd, IPPROTO_TCP, TCP_CORK, &zero, sizeof zero);   // uncork → one segment
```
Cork is for **throughput**: it guarantees full-size segments when you are assembling a response from multiple writes, and it is what `sendfile`-based servers use to avoid a small header segment followed by a large body. It caps the hold at 200 ms. On a latency path, cork is precisely what you do not want; `MSG_MORE` on `send()` gives the same effect per-call without the socket-level state.

**`TCP_CORK` and `TCP_NODELAY` on the same socket:** Linux gives cork precedence while corked. Setting both is a code smell indicating confusion about intent.

### Related options worth knowing

| Option | Purpose |
|---|---|
| `TCP_NOTSENT_LOWAT` | Limit *unsent* bytes in the kernel send buffer — keeps the pipe full without hiding queueing delay in the socket |
| `TCP_USER_TIMEOUT` | Cap total time unacknowledged data may remain outstanding before the connection fails (§38.10) |
| `TCP_DEFER_ACCEPT` | Do not return from `accept()` until data arrives — saves a wakeup |
| `TCP_FASTOPEN` | Carry data in the SYN, saving one RTT on reconnect using a cached cookie |
| `TCP_INFO` | Read the full kernel state block (`cwnd`, `rtt`, `retrans`, …) — what `ss -i` prints |
| `SO_BUSY_POLL` | Busy-poll the NIC in the socket call, cutting wakeup latency (Ch. 45 §45.8) |

**The standard trading configuration:** `TCP_NODELAY` on, `tcp_slow_start_after_idle` off, `TCP_USER_TIMEOUT` set to a few seconds, send buffers sized for backpressure rather than hoarding, quickack re-armed or accepted, connections established and warmed before the open.

---

## 38.15 TCP Head-of-Line Blocking

**Head-of-line (HOL) blocking** is the delivery of correctly-received data being withheld because an *earlier* byte is missing. It is the direct, unavoidable consequence of TCP's in-order delivery guarantee.

```
 Wire order:   [msg 1][msg 2][msg 3][msg 4][msg 5]
 Lost:                 ✗
 Arrived:      1              3      4      5

 Receiver's kernel buffer holds 3, 4, 5 — complete, verified, correct data.
 The application receives NOTHING until msg 2 is retransmitted and arrives.

 Delay to the application for msgs 3–5 = detection + 1 RTT (fast retransmit)
                                       or ≥ 200 ms (RTO)
```

### The cost quantified

| Detection mechanism | Added delay to everything behind the hole |
|---|---|
| Fast retransmit (3 dup ACKs) | ~1 RTT after the 3rd duplicate |
| SACK-based recovery | ~1 RTT, and multiple holes in that same RTT |
| Tail loss probe | ~2×RTT |
| **RTO** | **≥ 200 ms on Linux** |

On a colo link with a 50 µs RTT, a fast-retransmit recovery costs perhaps 150 µs — survivable. An RTO costs 200 ms, which is **four thousand RTTs** and an eternity in trading terms. The distribution is what kills you: the mean is fine, the tail is catastrophic (Ch. 43 §43.2).

### Why this is the reason market data is not TCP

A price update that is 200 ms late is not merely late — it is *actively harmful*, because the receiver may act on it believing it is current. UDP's behaviour under the same loss is to deliver messages 3, 4, 5 immediately and let the application decide what to do about the hole (Ch. 37 §37.3). **The application, not the transport, is the only layer that knows whether stale data is worth waiting for**, and TCP takes that decision away.

### Multiplexing makes it worse

Running multiple logical streams over one TCP connection means a loss affecting one stream stalls all of them. This is exactly the flaw HTTP/2 hit: it multiplexed requests over one connection, solving HTTP/1.1's application-layer HOL blocking but inheriting TCP's transport-layer version. **QUIC** fixes it by implementing streams above UDP with per-stream sequencing, so a loss in stream A does not block stream B. The same reasoning applies to any in-house multiplexed session protocol: if you put N independent order flows on one TCP connection, one lost packet delays all N.

### Mitigations when you must use TCP

- **Separate connections for independent flows** — restores per-flow independence at the cost of more sockets, more handshakes, and more state.
- **Keep messages small and connections warm**, so recovery is fast-retransmit rather than RTO.
- **Ensure TLP/RACK are enabled** — the tail-loss case (§38.8) is precisely the one that becomes an RTO.
- **Lower `rto_min` per route** on a measured, clean datacentre path.
- **Eliminate loss** rather than tolerating it: provision the fabric, watch microbursts and shallow buffers (Ch. 39 §39.5, §39.6). Loss on a well-engineered colo path should be essentially zero, and a nonzero retransmit counter is a defect to investigate, not a fact of life.

---

## 38.16 TCP Keepalive

**TCP keepalive** detects dead peers on idle connections by sending a probe segment with a sequence number one less than the current one, forcing an ACK.

```
net.ipv4.tcp_keepalive_time   = 7200    # idle seconds before the first probe (2 HOURS)
net.ipv4.tcp_keepalive_intvl  = 75      # seconds between probes
net.ipv4.tcp_keepalive_probes = 9       # probes before declaring the connection dead
```
Defaults therefore detect a dead peer after **7200 + 9×75 ≈ 2 hours 11 minutes** — useless for any trading purpose, and the reason "just enable keepalive" is not an answer.

```cpp
int on = 1, idle = 5, intvl = 1, cnt = 3;
setsockopt(fd, SOL_SOCKET,  SO_KEEPALIVE,  &on,    sizeof on);
setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE,  &idle,  sizeof idle);
setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof intvl);
setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT,   &cnt,   sizeof cnt);
// detection in ~5 + 3×1 = 8 seconds
```

### What keepalive actually solves

1. **Detecting a peer that vanished without a FIN** — power loss, kernel panic, cable pull. Without probes, the connection sits in `ESTABLISHED` forever on both sides; nothing on an idle TCP connection generates traffic.
2. **Refreshing NAT and stateful-firewall mappings**, which expire after minutes of idleness (Ch. 36 §36.17). This is often the real reason keepalive is enabled: not to detect death, but to prevent a middlebox from silently killing the session.
3. **Reclaiming resources** from half-open connections on a server.

### Why applications use their own heartbeats anyway

Every serious trading session protocol (FIX heartbeats, ITCH/OUCH session-level messages, in-house protocols) implements **application-level heartbeats**, and the reasons are substantive rather than stylistic:

| TCP keepalive | Application heartbeat |
|---|---|
| Proves the **kernel** is alive | Proves the **application** is alive and processing |
| Cannot detect a hung, deadlocked, or GC-stalled process | Detects it — the peer stops responding |
| Granularity limited by kernel timers, per-socket config | Arbitrary interval, per-session negotiation |
| No sequence-number context | Can carry sequence state, enabling gap detection at the same time |
| Not portable across stacks | Fully controlled |

**A process stuck in an infinite loop still answers TCP keepalives**, because the kernel generates them. This is the decisive argument, and it is exactly what FIX's `Heartbeat`/`TestRequest` pair exists for (Ch. 54 §54.2). The correct production configuration is *both*: aggressive TCP keepalive or `TCP_USER_TIMEOUT` for transport-level death, plus application heartbeats for liveness.

`TCP_USER_TIMEOUT` is frequently the better transport-level tool because it bounds the time *unacknowledged data* may remain outstanding — covering the active-transmission case that keepalive (which only probes idle connections) does not.

---

## 38.17 TIME_WAIT

After an active close, the closing side holds the 4-tuple in **`TIME_WAIT`** for **2×MSL** (Maximum Segment Lifetime) — **60 seconds on Linux** (a fixed `TCP_TIMEWAIT_LEN`, not tunable via sysctl).

### The two reasons it exists

1. **Absorb delayed duplicates.** A segment from this connection could still be wandering the network. If the same 4-tuple were immediately reused, that old segment could be accepted into the new connection and corrupt its data stream. Waiting 2×MSL guarantees every old segment has expired.
2. **Guarantee the final ACK is delivered.** If the active closer's last ACK is lost, the peer retransmits its FIN. Only a socket still in `TIME_WAIT` can respond with the ACK again; a fully closed socket would respond with an RST, which the peer would report as an error on an otherwise clean shutdown.

Reason 2 is the one people forget, and stating it distinguishes a real understanding from "it's for old packets."

### Why it hurts

`TIME_WAIT` sockets occupy a 4-tuple. A client making many short-lived outbound connections to the same server exhausts the **ephemeral port range** (`net.ipv4.ip_local_port_range`, typically 32768–60999, so ~28 000 ports). At 60 seconds each, that caps sustained connection rate at roughly **470 connections/second to a single destination `(dst IP, dst port)`** — a real limit that surprises people, and one that only applies per-destination since the 4-tuple includes the remote address.

### The remedies, ranked

| Approach | Verdict |
|---|---|
| **Persistent connections** | **The correct fix.** Establish once, keep it up, reuse. Trading sessions do this anyway |
| `SO_REUSEADDR` | Lets a *listener* bind a port with `TIME_WAIT` sockets present. Standard and safe on servers; does not reduce client-side exhaustion |
| `net.ipv4.tcp_tw_reuse=1` | Allows reusing a `TIME_WAIT` socket for a **new outbound** connection when timestamps show the old one is older. Safe with timestamps enabled; the standard client-side answer |
| Widen `ip_local_port_range` | Helps linearly; cheap; do it |
| `tcp_max_tw_buckets` | Caps the number of `TIME_WAIT` sockets by *destroying* the excess — trades correctness for resource limits; a blunt instrument |
| `SO_LINGER(1, 0)` to force RST | Avoids `TIME_WAIT` **by discarding unsent data**. Correct only when you genuinely do not care about the tail of the stream |
| `net.ipv4.tcp_tw_recycle` | **Removed from Linux in 4.12.** It broke catastrophically behind NAT by rejecting connections from clients whose timestamps appeared to go backwards. Recommending it is a red flag |

That last row is a genuine discriminator: `tcp_tw_recycle` appears in countless stale tuning guides, and knowing it was removed for correctness reasons — and *why* — is a strong signal.

### Which side pays

**The side that closes first pays.** Design accordingly: for a server handling many short connections, having the *client* close first moves `TIME_WAIT` to the client, where 28 000 ports per destination is usually ample. HTTP servers do this deliberately with connection-close semantics. `ss -tan state time-wait | wc -l` counts them.

For trading, the topic is mostly moot on the session path — order-entry connections are long-lived by design — but it matters for reconnect storms after a mass disconnect, where hundreds of sessions try to re-establish simultaneously and hit port and `TIME_WAIT` limits precisely when recovery is urgent.

---

## 38.18 Bandwidth-Delay Product

The **bandwidth-delay product** is the amount of data "in flight" on a path at full utilization:

```
 BDP (bytes) = bandwidth (bytes/s) × RTT (s)
```

It is the minimum window required to keep the pipe full. If `min(cwnd, rwnd) < BDP`, the sender stalls waiting for ACKs and throughput is `window / RTT`, independent of the link's capacity.

| Path | Bandwidth | RTT | BDP |
|---|---|---|---|
| Colo LAN | 10 Gbit/s | 50 µs | **62.5 KB** |
| Same metro | 10 Gbit/s | 1 ms | 1.25 MB |
| Chicago–NY | 10 Gbit/s | 9 ms | 11.25 MB |
| Transatlantic | 1 Gbit/s | 80 ms | 10 MB |
| Satellite (GEO) | 100 Mbit/s | 600 ms | 7.5 MB |

**Throughput = min(window, BDP) / RTT.** Two immediate corollaries:

- Without window scaling, the window is capped at 65535 bytes, so a transatlantic 80 ms path is capped at **6.5 Mbit/s** regardless of a 10 Gbit/s link. This is the classic "why is my long-distance transfer so slow" diagnosis (§38.5).
- Buffers must be sized to at least the BDP for full throughput, which is what Linux's autotuning is estimating — and what a manual `SO_RCVBUF` setting overrides and freezes.

### The trading interpretation

Inside a colo the BDP is tiny — 62.5 KB, and for a 50-byte order message it is irrelevant. **On a colo path you are never bandwidth-limited; you are latency-limited and per-message-cost-limited.** This is why congestion-control tuning does essentially nothing for colo order entry (§38.9) and why the productive optimizations are syscall count, interrupt handling, and message size.

Where BDP matters in a trading firm: cross-site replication, historical data transfer, and remote market-data backhaul. There, size buffers to the BDP, enable window scaling, and consider BBR.

### Related quantity: the pipe in packets

`BDP / MSS` gives the number of segments in flight. For the colo case: `62500 / 1460 ≈ 43` segments. For the transatlantic case: `10 MB / 1460 ≈ 7200` segments — which is also roughly how many RTTs a Reno flow needs to recover from one loss (§38.7), making the high-BDP fragility concrete.

---

## 38.19 Bufferbloat

**Bufferbloat** is excessive latency caused by oversized, unmanaged buffers in network devices. Its mechanism is a direct consequence of loss-based congestion control.

```
 Loss-based CC increases cwnd until it sees loss.
 Loss occurs only when a buffer OVERFLOWS.
 ⇒ TCP deliberately fills every buffer on the path before it backs off.
 ⇒ A 1 GB buffer on a 10 Mbit/s link means TCP fills it,
   and every packet then waits behind ~800 seconds of queued data.
```

Queueing delay = `queue_bytes / drain_rate`:

| Buffer | Link rate | Added latency |
|---|---|---|
| 64 KB | 10 Gbit/s | 51 µs |
| 1 MB | 10 Gbit/s | 800 µs |
| 1 MB | 1 Gbit/s | 8 ms |
| 100 MB | 1 Gbit/s | 800 ms |

The pathology is the **interaction**: a single bulk transfer fills the bottleneck buffer, and then every latency-sensitive packet — an order message, a heartbeat, an ACK — queues behind hundreds of milliseconds of bulk data. Interactive traffic collapses while throughput looks perfect. The classic home-network symptom (a large upload makes voice calls unusable) is the same phenomenon that makes a shared uplink unusable for trading traffic.

### Why buffers got big

Memory became cheap, "more buffer means fewer drops" was intuitive, and vendors competed on buffer size as a spec-sheet number. The correct queue size is roughly the BDP (or `BDP/√n` for n flows, the Appenzeller result), not "as much as fits."

### The fixes

| Technique | Mechanism |
|---|---|
| **AQM: CoDel** | Drops packets when the *minimum* queueing delay over a window exceeds a target (5 ms), which distinguishes a persistent standing queue from a transient burst |
| **fq_codel** | CoDel plus per-flow fair queueing — isolates a bulk flow from an interactive one, so one flow cannot build a queue in front of another |
| **CAKE** | fq_codel plus shaping and better classification |
| **BBR** | Sender-side: targets the BDP rather than buffer overflow, so it does not fill queues at all (§38.9) |
| **ECN** | Mark instead of drop: the router sets CE (`11`) in the IP ECN bits, the receiver echoes ECE, the sender reduces `cwnd` **without any loss or retransmission** |
| **Right-size buffers** | The structural fix, applicable in a private fabric |

```
tc qdisc add dev eth0 root fq_codel      # or fq for BBR pacing
tc -s qdisc show dev eth0                # backlog and drop statistics
```

### ECN, precisely

Two bits in the IP header (Ch. 36 §36.13) plus two TCP flags:

```
 IP ECN bits:  00 not-ECT   01/10 ECT (capable)   11 CE (congestion experienced)
 Router experiencing congestion rewrites ECT → CE instead of dropping.
 Receiver sets ECE in ACKs; sender reduces cwnd and sets CWR to confirm.
```
The benefit is congestion signalling **without loss**, which removes the retransmission and the head-of-line blocking that a drop would cause. ECN is negotiated on the SYN; historically some middleboxes dropped ECN-marked SYNs, which is why deployment lagged. **DCTCP** uses ECN marks proportionally to hold datacentre queues at a few packets — the right answer inside a controlled fabric.

### Trading relevance

In a properly provisioned colo fabric there should be no persistent queueing at all — the design goal is zero standing queue, and the enemy is **microbursts** rather than sustained congestion (Ch. 39 §39.5). Bufferbloat matters on shared WAN uplinks and on any link where bulk traffic (backups, replay, market-data recording) shares a path with latency-sensitive traffic. The two structural answers are **physical separation** (dedicated links or NICs for bulk) and **fq_codel plus shaping** where separation is impossible. Deep switch buffers on a trading path are a liability, not a feature — a point Ch. 39 §39.6 develops.

---

## 38.20 TCP Message Framing

Because TCP is a byte stream (§38.1), the application must define message boundaries. This is not optional and it is where a large fraction of real protocol bugs live.

### The three schemes

| Scheme | Example | Pros | Cons |
|---|---|---|---|
| **Length prefix** | `[uint32 len][payload]` — SBE, ITCH-over-TCP, most binary protocols | Single allocation, no scanning, exact bounds | Must validate the length before trusting it |
| **Delimiter** | HTTP `\r\n\r\n`; FIX's `10=xxx\x01` trailer | Human-readable, streamable | Requires escaping, scanning cost, ambiguous if the delimiter appears in data |
| **Fixed size** | Fixed-layout binary records | Trivial, zero parsing | Wastes space, no evolution path |

FIX is a hybrid and a good illustration of why: it is delimited by SOH characters, but it carries `BodyLength` (tag 9) as the second field precisely so a receiver need not scan for the end — plus a `CheckSum` (tag 10) trailer as a frame-integrity check.

### The length-prefix implementation, done correctly

```cpp
// Returns true if a complete message is available at the front of buf.
bool try_frame(std::span<const std::byte> buf, size_t& msg_len) {
    if (buf.size() < 4) return false;                 // header not yet complete
    uint32_t len = rd_be32(buf.data());               // Ch. 36 §36.9
    if (len < kMinMsg || len > kMaxMsg) throw ProtocolError{};  // ← MANDATORY
    if (buf.size() < 4 + len) return false;           // body not yet complete
    msg_len = 4 + len;
    return true;
}
```

Four rules, each corresponding to a real production incident class:

1. **Validate the length against a hard maximum before using it.** An attacker (or a corrupt link, or a version mismatch) sending `0xFFFFFFFF` becomes a 4 GB allocation or an integer overflow in `4 + len`. This is the single most common serious bug in hand-written protocol parsers (Ch. 51 §51.12).
2. **Handle partial headers.** The 4-byte length prefix itself can arrive split across two segments. Code that reads 4 bytes assuming they are all present fails rarely and catastrophically.
3. **Handle multiple messages per read.** One `recv` can return many complete messages plus a partial one; loop until you cannot frame another, then compact the remainder.
4. **Never assume one `recv` = one message.** This is §38.1 restated, and it is the assumption that testing on loopback never falsifies.

### The receive loop shape

```cpp
size_t used = 0;
n = recv(fd, buf.data() + fill, buf.size() - fill, 0);
if (n == 0) { /* peer closed: EOF */ }
if (n < 0 && (errno == EAGAIN || errno == EINTR)) { /* Ch. 34 §34.20 */ }
fill += n;
size_t off = 0, len;
while (try_frame({buf.data() + off, fill - off}, len)) { dispatch(buf.data() + off, len); off += len; }
std::memmove(buf.data(), buf.data() + off, fill - off);   // compact the partial tail
fill -= off;
```

The `memmove` is the naive approach; a **ring buffer** avoids it, and a fixed-capacity buffer sized to the maximum message avoids allocation entirely on the hot path (Ch. 55 §55.1). For very high rates, parse **in place** from the receive buffer with `std::span`/`string_view` views rather than copying out fields (Ch. 13 §13.4, Ch. 51 §51.9).

### The performance angle

- One `recv` per message is one syscall per message (~1–3 µs); **reading large chunks and framing in user space amortizes it** — the single biggest win in a TCP message parser.
- Zero-copy parsing means constructing views over the receive buffer, which requires the buffer to outlive the views. Alignment for in-place field access is a real constraint (Ch. 3 §3.12).
- Batching writes with `writev`/`sendmsg` avoids both extra syscalls and extra segments (§38.12).

---

## 38.21 TCP Half-Close and Reconnect Behaviour

### Half-close

TCP connections are full-duplex and each direction closes independently. `shutdown()` exposes this:

```cpp
shutdown(fd, SHUT_WR);   // send FIN; we send no more, but CAN STILL RECEIVE
shutdown(fd, SHUT_RD);   // stop receiving locally; no FIN is sent
shutdown(fd, SHUT_RDWR); // both directions
close(fd);               // release the descriptor; sends FIN if not already sent
```

| | `shutdown(SHUT_WR)` | `close()` |
|---|---|---|
| Sends FIN | Yes | Yes (if the last reference) |
| Can still read | **Yes** | No |
| Releases the descriptor | No | Yes |
| Effect with `dup`'d/forked descriptors | Affects the connection immediately | Only when the **last** reference closes |

That last row matters: a forked child holding a copy of the descriptor keeps the connection open after the parent's `close()`, which is a classic source of connections that will not die.

The **half-close idiom** is "send everything, signal I am done, then read the response until EOF." It is how a client can stream a request of unknown length and still receive a reply. The peer sees `recv` return 0 (EOF) and knows the request is complete, while its own direction remains open.

**The `CLOSE_WAIT` connection:** the peer's FIN puts your socket in `CLOSE_WAIT` and delivers EOF; your side stays there until *you* call `close()`. A pile of `CLOSE_WAIT` sockets means your application read EOF and never closed (§38.3).

### Reconnect behaviour

Reconnecting an exchange session is a correctness problem, not a networking one. The mechanics:

1. **Detect the disconnect.** EOF (graceful FIN), `ECONNRESET` (RST), `ETIMEDOUT` (`TCP_USER_TIMEOUT` or retransmission exhaustion), or an application heartbeat timeout. **Heartbeat timeout is usually first and is the one to act on** — a hung peer never sends a FIN.
2. **Back off.** Exponential with jitter. Without jitter, every disconnected client reconnects simultaneously after a venue blip and the reconnect storm prevents anyone from getting in.
3. **Re-establish and re-logon.** New TCP connection, new session-level logon with sequence numbers (Ch. 54 §54.1).
4. **Resynchronize sequence numbers.** The session protocol's sequence state — *not* TCP's — determines what must be resent. FIX's `ResendRequest`/`SequenceReset` and OUCH/SoupBinTCP's sequence-based replay exist for exactly this.
5. **Reconcile order state.** This is the part that matters: **during the disconnect, orders may have been filled, cancelled, or rejected.** Until reconciliation completes (via drop copy or an order-status request), your position is unknown.

### The safety rules

- **Never assume an unacknowledged order was not executed.** A `send()` that succeeded, followed by a disconnect, leaves the order in an unknown state. `send()` returning N means "the kernel took N bytes" (§38.1) — nothing more.
- **Use cancel-on-disconnect** where the venue offers it: on session loss, the exchange cancels all resting orders, which converts an unknown state into a known-flat one. This is the single most valuable disconnect-safety feature and should be requested by default (Ch. 54 §54.12).
- **Make order state transitions idempotent**, keyed on client order ID, so a replayed or duplicated message after reconnect does not create a second order (Ch. 54 §54.8).
- **Do not send new orders before reconciliation completes.** The gap between reconnect and reconciliation is a common source of duplicate and orphaned orders.
- **Alarm on reconnect**, always. A reconnect is a risk event; silent automatic recovery hides a degrading link until it fails during a volatile period.

### Diagnosing a disconnect after the fact

| Evidence | Tool |
|---|---|
| Was there a FIN or an RST? | `tcpdump` capture, always running on session links |
| Did the kernel time out? | `ss -tin` before death; `nstat` `TcpExtTCPAbortOnTimeout` |
| Retransmissions leading up to it? | `nstat`, `netstat -s`, `ss -tin` `retrans` |
| Did the peer stop responding first? | Application heartbeat log with timestamps |
| Link-level fault? | `ethtool -S` error counters, switch port counters, link flap logs |

Running a continuous rotating packet capture on every exchange session link is standard practice precisely because disconnect post-mortems are impossible without it (Ch. 48 §48.7).

---

## Key Interview Questions

1. **Why is TCP unsuitable for market data but acceptable for order entry?** — Retransmission plus in-order delivery causes head-of-line blocking (≥ 200 ms on an RTO), and TCP is point-to-point so it cannot fairly serve thousands of subscribers. Order entry is a low-rate, point-to-point, must-not-lose flow where reliability is worth the tail risk.
2. **Explain the three-way handshake and what it costs.** — SYN / SYN+ACK / ACK synchronizes ISNs in both directions and negotiates MSS, window scale, SACK, and timestamps; one full RTT before data, plus TLS on top.
3. **Why three packets rather than two?** — Both directions must synchronize sequence numbers and each side must confirm the other's ISN was received; the third ACK is what completes the server's state.
4. **What is the difference between flow control and congestion control?** — Flow control protects the receiver's buffer via the explicitly advertised window; congestion control protects the network via an inferred `cwnd`. The sender is bounded by `min(rwnd, cwnd)`.
5. **A transfer over an 80 ms path is stuck at 6.5 Mbit/s on a 10 Gbit/s link. Diagnose.** — Window scaling not in effect (stripped by a middlebox or not offered by one side): 65535 bytes / 80 ms = 6.5 Mbit/s exactly.
6. **What is the bandwidth-delay product and why does it matter?** — `bandwidth × RTT` is the in-flight data needed to keep the pipe full; throughput is `min(window, BDP)/RTT`. Colo BDP is ~62 KB, so colo paths are latency-limited, never bandwidth-limited.
7. **Walk through what happens on a single lost segment.** — Out-of-order arrivals trigger duplicate ACKs; three duplicates trigger fast retransmit and fast recovery (`ssthresh = flight/2`, `cwnd = ssthresh + 3`); with SACK the sender retransmits exactly the missing ranges in one RTT. If no duplicates arrive (tail loss), only an RTO — ≥ 200 ms — recovers it.
8. **Why is a timeout-detected loss so much worse than a duplicate-ACK-detected loss?** — Fast recovery halves the window and costs ~1 RTT; an RTO collapses `cwnd` to 1 MSS, restarts slow start, and costs at least Linux's 200 ms `rto_min`.
9. **Explain the Nagle plus delayed-ACK interaction.** — Sender withholds a sub-MSS trailing segment because data is unacknowledged; receiver withholds the ACK hoping to piggyback or cover two segments. Neither moves until the ~40 ms delayed-ACK timer fires. Signature: latency quantized at 40 ms. Fix: `TCP_NODELAY`, and write whole messages in one call.
10. **`TCP_NODELAY` vs `TCP_QUICKACK` vs `TCP_CORK`?** — Disable Nagle on the sender / disable delayed ACK on the receiver (and it is **not sticky** — re-arm it) / the opposite of NODELAY, batching until a full segment or 200 ms.
11. **What is head-of-line blocking and how does QUIC avoid it?** — Correctly received bytes are withheld pending an earlier missing byte, because TCP guarantees in-order delivery. QUIC implements independent streams over UDP so a loss in one stream does not stall another.
12. **What does SACK buy you, and how many blocks fit?** — Precise knowledge of received ranges, so multiple losses in one window are repaired in one RTT instead of one RTT each. Up to 4 blocks (34 bytes), but only 3 alongside the 10-byte timestamp option.
13. **What is D-SACK for?** — Reporting a duplicate receipt, which lets the sender detect spurious retransmissions, undo an unnecessary window reduction, and raise its reordering threshold. High `TCPDSACKRecv` with low real loss indicates a reordering path.
14. **Why does `TIME_WAIT` exist and who pays it?** — To absorb delayed duplicates from the old incarnation and to be able to re-ACK a retransmitted FIN. The active closer pays, for 60 s on Linux, holding the 4-tuple.
15. **How do you fix ephemeral-port exhaustion from `TIME_WAIT`?** — Persistent connections first; then `tcp_tw_reuse` with timestamps, a wider `ip_local_port_range`, and having the other side close. Never `tcp_tw_recycle` — removed from Linux for breaking NATted clients.
16. **A server accumulates `CLOSE_WAIT` sockets. What is wrong?** — The application read EOF and never called `close()`. Always an application bug, never the network. It leaks descriptors toward `EMFILE`.
17. **Why are application heartbeats needed when TCP keepalive exists?** — Keepalive is generated by the kernel, so a deadlocked or stalled process still answers it. Only an application-level heartbeat proves the application is processing. Also, keepalive defaults detect death after ~2 hours 11 minutes.
18. **Compare Reno, CUBIC, and BBR.** — Loss-based linear (RTT-unfair, hopeless at high BDP); loss-based cubic-in-wall-time (RTT-fair, fast recovery, still fills buffers); rate-and-delay-based targeting the BDP (drains queues, tolerates random loss, needs pacing).
19. **What is bufferbloat and why is it caused by TCP itself?** — Loss-based congestion control only backs off when a buffer overflows, so it deliberately fills every buffer on the path; a large buffer therefore becomes standing queueing delay. Fixes: fq_codel/CoDel, ECN, BBR, right-sized buffers.
20. **How do you frame messages on a TCP stream, and what must you validate?** — Length prefix, delimiter, or fixed size. With a length prefix: validate against a hard maximum before allocating or indexing, handle a partial length field, handle multiple messages per `recv`, and never assume one `recv` is one message.
21. **After an order-entry disconnect, what must you assume?** — That any unacknowledged order may or may not have executed. `send()` succeeding proves only that the kernel accepted the bytes. Reconcile via drop copy or order status before sending anything new, and prefer cancel-on-disconnect.
22. **What TCP settings would you apply to a trading host?** — `TCP_NODELAY` on every session socket, `tcp_slow_start_after_idle=0`, `TCP_USER_TIMEOUT` of a few seconds, TLP/RACK enabled, per-route `rto_min` lowered on a measured clean path, send buffers sized for backpressure not hoarding, and connections established and warmed before the open.

---

## Common Traps

- **Assuming one `recv` returns one message** — TCP is a byte stream; framing is the application's job.
- **Assuming `send()` returning N means the peer received N bytes** — it means the kernel buffered them.
- **Not validating a length prefix before allocating or indexing** — 4 GB allocations, integer overflow, and the most common serious parser vulnerability.
- **Forgetting the length prefix itself can arrive split** across segments.
- **Leaving Nagle enabled on a latency-sensitive socket** — 40 ms stalls that appear only under specific message sizes and pipelining.
- **Fixing Nagle with `TCP_NODELAY` while still doing multiple small `write`s per message** — treats the symptom; use `writev`/`sendmsg` or one buffer.
- **Setting `TCP_QUICKACK` once and assuming it persists** — Linux resets it; it must be re-armed.
- **Setting `TCP_NODELAY` on only one end** when both sides send small messages.
- **Setting `SO_RCVBUF`/`SO_SNDBUF` explicitly** — disables autotuning and can cap throughput on a high-BDP path. Also, Linux doubles what you request.
- **Huge send buffers on a latency path** — hides queueing delay inside the kernel instead of surfacing it as backpressure; use `TCP_NOTSENT_LOWAT`.
- **Leaving `tcp_slow_start_after_idle=1`** — the first burst after a quiet period is throttled back to a 10-segment window.
- **Relying on TCP keepalive defaults** — ~2 hours 11 minutes to detect a dead peer.
- **Relying on TCP keepalive at all to prove liveness** — the kernel answers probes for a hung process.
- **Accumulating `CLOSE_WAIT`** — an application that never calls `close()` after EOF, leaking descriptors.
- **`SO_LINGER(1,0)` to dodge `TIME_WAIT`** — discards unsent data, which on an order path can discard a cancel.
- **Recommending `tcp_tw_recycle`** — removed from Linux; it broke NATted clients.
- **Confusing flow control with congestion control** in an interview — the fastest way to lose credibility on this topic.
- **Assuming three duplicate ACKs always means loss** — reordering produces them too, which is why RACK replaced the counting heuristic.
- **Ignoring the tail-loss case** — the last message of a burst has nothing behind it to generate duplicate ACKs, so without TLP/RACK it costs a full RTO.
- **Believing a congestion-control change will improve colo order-entry latency** — the BDP is 62 KB and you are never bandwidth-limited.
- **Deep switch buffers as a latency "safety margin"** — they convert loss into hundreds of milliseconds of standing queue.
- **Multiplexing independent order flows on one TCP connection** — one lost packet head-of-line blocks all of them.
- **Reconnecting without jitter** — a venue blip becomes a synchronized reconnect storm.
- **Sending new orders before post-reconnect reconciliation completes** — duplicate and orphaned orders.
- **Reading `tcpdump` sequence numbers as absolute** — they are relative to the ISN unless you pass `-S`.

---

## Compact Recall Summary

**Semantics.** Reliable, ordered, connection-oriented **byte stream** on a 4-tuple; 20–60 byte header (Data Offset in 32-bit words); flags SYN/ACK/FIN/RST/PSH/URG/ECE/CWR. **No message boundaries** — the application must frame. `send()` returning N means the kernel buffered N bytes, nothing about the peer. Options negotiated on the SYN only: MSS, window scale, SACK-permitted, timestamps (timestamps+alignment cost 12 B, reducing payload from 1460 to 1448).

**Handshake and teardown.** SYN / SYN+ACK / ACK = **1 RTT** before data; SYN and FIN each consume a sequence number. Two queues: SYN queue (`tcp_max_syn_backlog`, SYN cookies) and accept queue (`listen` backlog, `somaxconn`) — `ss -lnt` shows depth in `Recv-Q` and limit in `Send-Q`. Teardown is per-direction: FIN/ACK/FIN/ACK; the active closer sits in **TIME_WAIT for 60 s**. **`CLOSE_WAIT` accumulating is always an application bug.** FIN flushes queued data; RST discards it and skips TIME_WAIT.

**Sequencing.** Byte-offset sequence numbers in a 32-bit modular space; **cumulative** ACKs mean "everything below N." Wrap in 3.4 s at 10 Gbit/s ⇒ PAWS via timestamps. Duplicate ACKs are ambiguous between loss and reordering. Compare with `int32_t(a-b) < 0`. `tcpdump` shows relative sequences without `-S`.

**Flow vs congestion control.** Flow control = **receiver's buffer**, explicit `rwnd`; congestion control = **the network**, inferred `cwnd`; sender bounded by `min(rwnd, cwnd)`. 16-bit window caps throughput at `65535/RTT` (6.5 Mbit/s at 80 ms) without **window scaling**, which requires both sides on the SYN. Zero window → persist timer with 1-byte probes. Explicit `SO_RCVBUF` disables autotuning.

**Congestion phases.** Slow start (×2/RTT, **IW = 10 MSS ≈ 14.6 KB**, restarts after idle unless disabled) → congestion avoidance (**AIMD**, +1 MSS/RTT) → fast retransmit/recovery on 3 dup ACKs (`ssthresh = flight/2`, `cwnd = ssthresh + 3`, inflate/deflate) → **RTO** (`cwnd = 1`, slow start, **≥ 200 ms on Linux**). NewReno, SACK recovery, Limited Transmit, **TLP** for tail loss, **RACK** time-based detection.

**Algorithms.** Reno: linear, RTT-unfair, 71 minutes to recover 10 Gbit/s at 100 ms. CUBIC: cubic in wall time, RTT-fair, Linux default, still fills buffers. BBR: models `BtlBw × RTprop`, paces, drains queues, tolerates random loss, needs `fq`. DCTCP: proportional ECN for shallow datacentre queues. **None of them matter for colo order entry.**

**RTO.** `SRTT` and `RTTVAR` as EWMAs (α=1/8, β=1/4); `RTO = SRTT + 4·RTTVAR`, clamped to **`rto_min` = 200 ms on Linux** (tunable per route with `ip route ... rto_min`). Exponential backoff to `tcp_retries2` ≈ 13–30 minutes — hence `TCP_USER_TIMEOUT` and application heartbeats. **Karn**: no RTT sample from retransmissions; timestamps remove the ambiguity.

**SACK.** Reports received ranges so multiple holes are repaired in one RTT; ≤ 4 blocks (34 B), realistically 3 alongside timestamps; advisory, not binding. **D-SACK** reports duplicates, revealing spurious RTOs and reordering paths.

**Nagle and delayed ACK.** Nagle withholds sub-MSS data while anything is unacknowledged; delayed ACK withholds the ACK up to ~40 ms. Together they deadlock on a 1.5-MSS message: **latency quantized at 40 ms**. Fix with `TCP_NODELAY` plus single-call writes. `TCP_QUICKACK` disables delayed ACK but is **not sticky**; `TCP_CORK` is the deliberate opposite, batching to full segments or 200 ms.

**Head-of-line blocking.** In-order delivery withholds correct data behind a hole: ~1 RTT with fast retransmit/SACK, ~2 RTT with TLP, **≥ 200 ms with an RTO**. The structural reason market data is UDP multicast, the flaw HTTP/2 inherited, and the thing QUIC fixes with per-stream sequencing over UDP.

**Keepalive and TIME_WAIT.** Keepalive defaults: 7200 s idle + 9×75 s ≈ **2 h 11 m**; tune to seconds, but remember the kernel answers probes for a hung process — application heartbeats are what prove liveness. TIME_WAIT exists to absorb old duplicates **and** to re-ACK a retransmitted FIN; the active closer pays; fix exhaustion with persistent connections, `tcp_tw_reuse`, and a wider port range — never `tcp_tw_recycle`.

**BDP and bufferbloat.** `BDP = bandwidth × RTT`; throughput = `min(window, BDP)/RTT`. Colo ≈ 62.5 KB (latency-limited, never bandwidth-limited); transatlantic ≈ 10 MB. Loss-based CC fills every buffer before backing off, so oversized buffers become standing delay (`queue/drain_rate`: 1 MB at 1 Gbit/s = 8 ms). Fix with fq_codel/CoDel, ECN (mark CE instead of dropping — congestion signal with no loss and no HOL blocking), BBR, or right-sized buffers and physical separation of bulk traffic.

**Framing and reconnect.** Length prefix, delimiter, or fixed size; **validate the length against a hard maximum**, handle split headers and multiple messages per `recv`, and amortize syscalls by reading large chunks. Half-close via `shutdown(SHUT_WR)` sends FIN while still reading. On reconnect: detect via heartbeat first, back off **with jitter**, re-logon, resynchronize the *session* sequence numbers, and reconcile order state before sending anything new — assume any unacknowledged order may have executed, prefer cancel-on-disconnect, make transitions idempotent by client order ID, and always alarm.
