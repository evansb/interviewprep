# Chapter 38 — TCP

## Why this matters — Core

TCP turns an unreliable packet service into an ordered byte stream by maintaining state at both endpoints: sequence numbers, acknowledgements, receive and congestion windows, retransmission state, and timers. Those mechanisms provide a strong transport abstraction, but they also create queueing, recovery delay, and failure ambiguity that the application must handle.

The durable way to reason about TCP is to ask three questions:

1. Which byte sequence ranges has each endpoint sent, received, and acknowledged?
2. Which limit currently prevents another byte from being sent: application demand, receiver window, congestion window, or a local queue?
3. If progress stops, which event can restart it: an ACK, a window update, a loss-recovery signal, a timer, or an application action?

The core wire protocol is standardized, principally by RFC 9293 and related RFCs. Congestion algorithms, delayed-ACK policy, timer bounds, socket options, counters, and defaults are implementation behavior. Linux examples below are labeled and must be checked against the deployed kernel. Chapter 45 owns socket calls and option-setting code.

## 90-second screen — Core

- TCP presents a **reliable, ordered byte stream**, not messages. One write may require many reads; many writes may arrive in one read. Applications must frame.
- Sequence numbers identify bytes. An acknowledgement `ACK=N` cumulatively confirms every byte before `N`; SYN and FIN each consume one sequence number.
- A connection is state at two endpoints identified by an address/port tuple. The ordinary handshake costs one RTT before the server can receive post-handshake application data; data on the third ACK is ordinary TCP, while data on the initial SYN requires an extension such as TCP Fast Open.
- Reliability is not bounded latency. A hole blocks later bytes from the receiving application until recovery, even if those later bytes arrived correctly.
- Flow control protects the receiver through `rwnd`; congestion control protects the network through `cwnd`. Roughly, `in_flight <= min(rwnd, cwnd)`.
- A successful write only means the local stack accepted bytes. A transport ACK means the peer TCP stack received them, not that the peer application processed or durably recorded them.
- Nagle, delayed ACK, RTO minima, keepalive intervals, and modern loss detection are not universal constants. Diagnose the actual packet trace and implementation.
- For a latency decision, calculate bandwidth-delay product, queued bytes divided by drain rate, and the recovery event available for the missing segment.

---

## 38.1 The Byte Stream and Connection Identity — Core

TCP connects two endpoints. Each endpoint consists of an IP address and TCP port; a conventional connection is distinguished by:

```text
(local address, local port, remote address, remote port)
```

The same listening endpoint can therefore support many simultaneous connections whose remote endpoint differs. A socket descriptor is an operating-system handle to endpoint/connection state, not the connection itself; descriptor lifecycle and partial I/O belong to Chapter 45.

### No message boundaries

TCP numbers and delivers bytes. Segmentation is an internal transport decision and does not preserve application write calls:

```text
Application writes:   [ABCD] [EF] [GHIJK]

Possible reads:       [ABCDEFGHIJK]
                      [A] [BCDEF] [GHI] [JK]
                      [ABCD] [EF] [GHIJK]   ← coincidence, not a contract
```

The sender may split a write because of the maximum segment size, available window, offload, or local scheduling. A receiver may coalesce several segments or return only the currently available prefix. Packet boundaries observed in a capture are therefore not application records.

TCP's delivery contract is:

| TCP provides while the connection succeeds | TCP does not provide |
|---|---|
| Ordered delivery of the byte sequence | Application message boundaries |
| Duplicate suppression in delivered bytes | A bounded delivery time |
| Retransmission after detected loss | Proof that the peer application acted |
| Per-connection flow control | Recovery of application state after either process crashes |
| A checksum over header and data | Cryptographic integrity or detection of every possible corruption |

"Reliable" means the receiver gets the ordered bytes or the connection eventually reports failure. It does not mean exactly-once business processing. If a client submits a request and the connection fails before an application response, the request may have been lost, queued, processed, or processed with its response lost. Transactional protocols need identifiers, idempotency, and application acknowledgements.

### Sequence-space mental model

Each direction has an independent 32-bit modular sequence space. At any instant, a sender conceptually divides it into:

```text
already ACKed | sent but unacknowledged | allowed but unsent | outside window
              SND.UNA                  SND.NXT
```

The receiver tracks the next contiguous byte expected, `RCV.NXT`, and buffers implementation-dependent amounts of out-of-order data. These state variables, rather than packet count, explain the rest of TCP.

Modular comparison is valid only when relevant values are less than half the 32-bit space apart. A portable half-range helper makes that precondition explicit:

```cpp
#include <cstdint>

constexpr bool seq_before(std::uint32_t a, std::uint32_t b) {
    return a != b && (b - a) < 0x8000'0000u;
}
```

At exactly half the space, order is ambiguous; a conforming implementation constrains live windows and segment lifetimes so it never needs that comparison. TCP timestamps can also support PAWS, which rejects old segments after sequence wrap. Do not reuse this helper for an unbounded application counter without proving the same half-range invariant.

---

## 38.2 Sequence Numbers, ACKs, and a Worked Trace — Core

The sequence number in a segment identifies its first payload byte. The acknowledgement number is the next byte expected in the opposite direction. Thus `ACK=5001` means all bytes through 5000 arrived contiguously. It says nothing cumulative about bytes above a hole unless a SACK option reports them separately.

SYN and FIN each consume one sequence number so setup and shutdown can be acknowledged and retransmitted in the same sequence machinery. A pure ACK consumes none.

### Trace: one hole in the stream

Assume the sender's first data byte is sequence 1001 and each shown segment carries 500 bytes:

```text
Sender                                      Receiver / application

SEQ=1001 LEN=500  ───────────────────────►  accepts [1001,1501)
                    ◄─────────────────────  ACK=1501

SEQ=1501 LEN=500  ─────── X (lost)

SEQ=2001 LEN=500  ───────────────────────►  buffers [2001,2501)
                    ◄─────────────────────  ACK=1501, SACK=[2001,2501)

SEQ=2501 LEN=500  ───────────────────────►  buffers [2501,3001)
                    ◄─────────────────────  ACK=1501, SACK=[2001,3001)

retransmit
SEQ=1501 LEN=500  ───────────────────────►  fills hole
                    ◄─────────────────────  ACK=3001
```

After the first segment, the application can read bytes through 1500. Bytes 2001–3000 may already occupy the receive buffer, but ordered-stream semantics prevent their delivery before 1501–2000. When the retransmission fills the hole, the cumulative ACK jumps and the receiver can deliver the now-contiguous range. This is TCP head-of-line blocking in its simplest form.

The trace also separates three kinds of information:

- Repeated `ACK=1501` says the cumulative edge did not move.
- A SACK block says higher ranges arrived; it does not replace the cumulative ACK.
- The sender infers loss from ACK/SACK/timing evidence. The receiver does not send a special "packet 2 was lost" message.

### SACK and duplicate suppression

Selective Acknowledgement (SACK, negotiated during setup) reports non-contiguous received byte ranges. This lets a sender retransmit holes rather than all later bytes. TCP's option budget limits the number of blocks that fit in one segment, especially when timestamps are present, so SACK state may span several ACKs.

SACK information is advisory: the sender retains data until it is cumulatively acknowledged because a receiver may renege under exceptional resource pressure. D-SACK uses the SACK format to report duplicate data and can help an implementation recognize spurious retransmission or path reordering.

Duplicate packets do not become duplicate application bytes. The receiver uses sequence ranges to discard already-received data and merge overlaps. That transport duplicate suppression still does not deduplicate two application requests that happen to contain the same business operation.

### Reading ACK state correctly

At the sender, `SND.UNA` is the oldest unacknowledged sequence position and `SND.NXT` is the next position to transmit. An acceptable cumulative ACK normally falls within the active send range:

```text
ACK <= SND.UNA            old/duplicate acknowledgement; no advancement
SND.UNA < ACK <= SND.NXT  advances the cumulative edge
ACK > SND.NXT             acknowledges unsent sequence space; invalid/challenge case
```

Exact challenge-ACK and security behavior is standards- and implementation-specific, but the invariant is simple: an ACK cannot legitimately confirm bytes never sent.

ACKs acknowledge sequence space, not packet objects. If a 1,000-byte write was transmitted as two 500-byte segments, `ACK=2001` can cumulatively acknowledge the entire range regardless of how it was segmented. Conversely, one ACK may cover many segments, and ACK loss may be harmless when a later cumulative ACK covers the same bytes.

The PUSH flag does not repair message framing. It can influence when a stack makes received bytes available, but it does not define a record boundary visible through the portable stream API. Applications should not attempt to reconstruct writes from PSH flags in a capture.

---

## 38.3 Connection Lifecycle and Failure Ambiguity — Core

### Establishment

The three-way handshake synchronizes initial sequence numbers (ISNs), confirms two-way reachability, and negotiates options:

```text
Active opener                                 Passive opener

SYN, seq=x, options        ─────────────────►  SYN-RECEIVED
                            ◄────────────────  SYN+ACK, seq=y, ack=x+1, options
ESTABLISHED
ACK, seq=x+1, ack=y+1      ─────────────────►  ESTABLISHED
```

The third packet can carry application data after the active side has received the SYN+ACK. This is ordinary TCP; whether application scheduling actually puts data there depends on the API and stack. Sending application data on the initial SYN is different: it requires a facility such as TCP Fast Open, has deployment and replay/idempotency implications, and is not part of the basic handshake guarantee.

For conventional connect-then-write behavior, the setup adds approximately one network RTT before the server receives application bytes. Retransmitted SYN timing, retry counts, SYN-cookie behavior, listener queues, and connection API errors are operating-system policy and belong to Chapter 45. Do not quote one retry schedule as TCP itself.

The key options are exchanged on SYN segments:

| Option | Directional meaning |
|---|---|
| MSS | Largest TCP payload the option sender is willing to receive in one segment |
| Window Scale | Scale used to interpret that receiver's advertised window; factors can differ by direction |
| SACK Permitted | Allows the peer to send SACK information later |
| Timestamps | Supports timestamp echo/RTT mechanisms and PAWS |

MSS is not the Ethernet MTU. It is payload after IP/TCP headers, and actual payload can be further constrained by path MTU and TCP option bytes. Window scaling must be negotiated during the handshake; it cannot be enabled halfway through a connection.

### Graceful teardown and half-close

TCP is full duplex, so each sending direction closes independently:

```text
Active closer                                  Peer

FIN, seq=u                  ─────────────────►  receives EOF after prior bytes
                             ◄────────────────  ACK=u+1
                             ◄────────────────  remaining data, then FIN, seq=v
ACK=v+1                     ─────────────────►
TIME-WAIT                                      CLOSED
```

A FIN means "no bytes after this sequence position in my sending direction." The peer may continue sending until it sends its own FIN. A half-close exposes this property: one side can finish its request stream while continuing to receive a response. The socket API for doing so is in Chapter 45.

An RST aborts a connection rather than completing the two FIN directions. Applications should not assume locally queued bytes reached the peer after an abort. A normal EOF, reset, local timeout, and application heartbeat failure are distinct observations and should remain distinct in logs.

RST interpretation requires context. It may mean no matching connection existed, an endpoint aborted deliberately, a policy device rejected traffic, or a peer restarted and lost connection state. A reset after the local application writes does not identify which earlier bytes the remote application consumed. Packet direction, sequence/ACK state, and endpoint logs are required.

Common states and their diagnostic meaning:

| State | Meaning |
|---|---|
| `SYN-SENT` / `SYN-RECEIVED` | Handshake incomplete |
| `ESTABLISHED` | Both sequence spaces established |
| `FIN-WAIT-1/2` | Local FIN sent; waiting for its ACK or peer FIN |
| `CLOSE-WAIT` | Peer FIN received; local application has not closed its sending side |
| `LAST-ACK` | Local FIN sent after receiving peer FIN |
| `TIME-WAIT` | Final-ACK side retains tuple state temporarily |

An unexpected growing population in `CLOSE-WAIT` usually indicates that the application observed EOF but retained descriptors or failed to finish its half. A deliberate long-lived half-close is possible, so the state alone is evidence, not a protocol proof of a bug.

### TIME-WAIT, keepalive, and reconnect

TIME-WAIT lets the endpoint retransmit the final ACK if the peer repeats its FIN and prevents delayed segments from an older incarnation being mistaken for a new connection using the same tuple. The conceptual duration is tied to maximum segment lifetime; actual duration and tuple-reuse policy are implementation-specific. Persistent connections and correct lifecycle design matter more than memorizing a Linux timer or applying tuple-reuse sysctls.

TCP keepalive is an optional idle-connection probe mechanism. Enablement, probe intervals, counts, and failure reporting vary by OS and configuration. A successful probe shows that the peer network stack responded; it does not prove that the peer application event loop is healthy. Application heartbeats carry semantic liveness and can include sequence/progress state.

After a disconnect, transport state does not answer whether a business request executed:

```text
local write accepted → bytes transmitted → peer TCP ACKed → peer app read
                    → peer app validated → operation committed → response received
```

A failure can occur between any two arrows. Reconnection therefore requires application session resynchronization, idempotent request identifiers, reconciliation, and jittered retry policy. TCP only establishes a new byte stream.

The same ambiguity exists during graceful failure. Receiving FIN proves the peer TCP endpoint closed its sending direction after the bytes before that FIN; it does not prove that every request caused the intended business transition. Graceful transport shutdown is useful evidence, not an application commit record.

---

## 38.4 Reliability, RTT Estimation, and Retransmission — Core

TCP retains unacknowledged data and retransmits when it concludes that a range is missing. The conclusion can come from packet/ACK evidence or a timer.

### Evidence-based recovery

In the classic RFC 5681 model, out-of-order arrivals generate duplicate cumulative ACKs. Three duplicate ACKs trigger fast retransmit, while fast recovery reduces the congestion window without waiting for the retransmission timeout. The threshold is a heuristic: reordering can also generate duplicate ACKs, and a short flight may not contain enough later segments to produce three.

SACK-based recovery identifies multiple holes more precisely. Modern stacks may also use time-based loss detection and tail-loss probes. RACK-TLP is standardized in RFC 8985, but kernel enablement, exact reordering windows, and counters are version/configuration details. State the observed implementation before claiming that a tail loss recovers in a particular number of RTTs.

The recovery cost model is:

| Available evidence | Earliest plausible recovery | Latency consequence |
|---|---|---|
| Later data produces duplicate ACK/SACK evidence | Around an RTT plus detection/retransmission path | Hole blocks delivery until repair |
| Time-based detector/probe is enabled | Implementation-chosen multiple/fraction of measured RTT | Often earlier than fallback RTO |
| No usable evidence | Retransmission timeout | Timer floor plus retransmission, then backoff on repeated failure |

A middle loss in a long flight has evidence behind it. A **tail loss** at the end of an otherwise idle burst does not, which is why probe-based modern recovery matters for request/response traffic.

### RTT estimator and RTO

RFC 6298 describes the baseline estimator. For an RTT sample `R`:

```text
first sample:
    SRTT   = R
    RTTVAR = R / 2

later samples:
    RTTVAR = (1 - 1/4) × RTTVAR + (1/4) × |SRTT - R|
    SRTT   = (1 - 1/8) × SRTT   + (1/8) × R

RTO = SRTT + max(clock_granularity, 4 × RTTVAR)
```

Mean plus variation prevents ordinary jitter from causing constant spurious retransmission. RFC 6298 also specifies conservative initialization/backoff behavior. Operating systems may implement additional recovery and different effective timer bounds within their standards constraints. Linux has historically used an established-connection minimum below RFC 6298's one-second recommendation and supports route/stack-specific behavior, but neither one number nor one sysctl is a portable TCP fact.

After an RTO, repeated expiration backs off, commonly exponentially. Therefore the cost of a silent blackhole is not "one timeout"; it can be a growing sequence until policy declares failure. An application with a tighter liveness objective needs its own deadline and protocol-level recovery rather than assuming TCP will fail within a chosen bound.

**Karn's algorithm** avoids RTT samples from ambiguously acknowledged retransmissions: an ACK after retransmission might correspond to the original or replacement copy. Timestamp echo provides more measurement information, but exact sampling/recovery still depends on the implementation.

### Worked diagnosis: loss, reordering, or receiver stall?

Suppose an application reports a 12 ms pause:

1. The capture shows one sequence hole, later ranges arriving, repeated cumulative ACKs, and then a retransmission. This supports network loss or reordering followed by recovery.
2. SACK/D-SACK and timing distinguish the hypotheses: a D-SACK after retransmission suggests the original was delayed rather than lost.
3. If sequence delivery is complete but the advertised window shrinks to zero, the network delivered bytes and the receiver stopped draining them.
4. If neither packets nor ACKs progress until an RTO, inspect both path loss and peer liveness; do not infer one from the application pause alone.

The diagnosis follows sequence state first, timers second, and implementation counters last.

---

## 38.5 Flow Control and Backpressure — Core

Flow control protects receiver buffering. Every valid ACK advertises how much additional sequence space the receiver currently accepts. Let `rwnd` be that advertised receive window, `cwnd` the sender's congestion window, and `flight` the bytes sent but not cumulatively acknowledged:

```text
additional send allowance ≈ max(0, min(rwnd, cwnd) - flight)
```

The real stack also accounts for segmentation, recovery, pacing, and local send queues, but the minimum-window rule is the correct first model.

### Receive window, scaling, and MSS

The TCP header's window field is 16 bits. The Window Scale option negotiated in the handshake shifts this value, allowing a larger receive window. Each endpoint announces the scale for windows it will advertise, so directions can use different factors. A missing/stripped negotiation can cap throughput on a high bandwidth-delay path.

MSS constrains payload per segment, while `rwnd` constrains unacknowledged receive sequence space. They solve different problems:

| Quantity | Unit | Protects/limits |
|---|---|---|
| MSS | Bytes per TCP segment | Receiver/path packet size |
| `rwnd` | Bytes in receive sequence space | Receiver buffer capacity |
| `cwnd` | Bytes (often accounted in segments internally) | Network congestion exposure |

If an application stops reading, receive-buffer occupancy rises and advertised `rwnd` shrinks. At zero window the sender stops ordinary data transmission. A persist mechanism probes periodically so a lost window-update ACK cannot leave both endpoints waiting forever. Probe timing/backoff is implementation policy, not a universal interval.

This is **backpressure**, not packet loss. Increasing buffers postpones the zero-window point but also permits a larger hidden queue. A system should choose whether overload waits in the application, the socket buffers, or an upstream queue, then bound and observe that location. Socket-buffer autotuning and option semantics are OS-specific and belong to Chapter 45.

### Worked receive-window calculation

Suppose the receiver cumulatively acknowledges through byte 99,999, so `RCV.NXT=100,000`, and advertises a scaled window of 32,768 bytes. The advertised right edge is:

```text
100,000 + 32,768 = 132,768
```

Subject to the sender's congestion window, new data may occupy sequence positions below 132,768. If 8 KiB of out-of-order data already consumes receive-buffer space above a hole, the receiver may advertise less free space even though the application cannot read those bytes yet. This couples loss recovery and flow control: a persistent hole can hold buffer capacity while later arrivals continue.

Now assume the sender has 20 KiB outstanding and `cwnd=24 KiB`. Although `rwnd` permits roughly 32 KiB, congestion permits only about 4 KiB more. If `cwnd=64 KiB` instead, the receiver window is the active bound and roughly 12 KiB remains after the 20 KiB flight. The minimum, not the largest configured buffer, controls.

### Flow-control diagnosis

Use a packet trace to distinguish:

```text
receiver window falls steadily → consumer is not draining as fast as arrivals
window reaches zero           → sender is receiver-limited
window remains large          → look at cwnd, local queue, application demand, or path
```

On Linux, `ss -tin` exposes version-dependent fields such as RTT, congestion algorithm, window scale, congestion window, delivery rate, and retransmission state. Treat the field set and units as tool/kernel documentation, not wire protocol.

---

## 38.6 Congestion Control, BDP, and Queueing — Core

Congestion control limits how much unacknowledged data a sender injects based on inferred network capacity. It is separate from flow control:

| | Flow control | Congestion control |
|---|---|---|
| Protects | Receiver | Network/path |
| Primary limit | `rwnd` advertised by peer | `cwnd` computed by sender |
| Signals | Receive-window updates | Loss, ACK timing, ECN, delay/rate model |
| Typical stall | Receiver window closes | Congestion window/recovery limits sending |

### Classic growth and recovery

The RFC 5681 mental model has:

- **Slow start:** grow `cwnd` rapidly, approximately doubling per RTT when ACKs cover a full window.
- **Congestion avoidance:** grow more cautiously, approximately one sender MSS per RTT in classic Reno.
- **Fast retransmit/recovery:** infer a hole from duplicate ACK evidence, retransmit, and reduce the sending window without waiting for RTO.
- **Timeout recovery:** retransmit after RTO and return to a conservative sending state.

The permitted initial window and restart-after-idle behavior are governed by RFCs plus implementation policy. "Always ten segments" and "always resets after one RTO idle" are not safe cross-platform claims. For a short transfer, count how much data the observed initial window admits rather than assuming bulk steady state.

### Window growth as an RTT cost model

Suppose a trace shows an initial congestion window of 10 segments and a response requires 25 equal-sized segments. With no loss, a simplified slow-start schedule is:

```text
round 1: send up to 10
ACKs return
round 2: window has grown enough to send the remaining 15
```

The response therefore needs at least two flights even though the link could serialize all 25 quickly. If the response were eight segments, it could fit in the first observed window. This is an RTT-count argument, not a throughput benchmark.

Now suppose one of the first few segments is lost. Too little later data may exist to generate classic duplicate-ACK evidence, so recovery can depend on a probe or RTO. A long bulk flight is more likely to expose the hole promptly. Short transfers are consequently sensitive to initial-window and tail-loss policy even when average bandwidth is low.

In congestion avoidance, recovery time after a reduction depends on the chosen algorithm. Reno's approximate one-segment-per-RTT growth can take many RTTs on a large window; CUBIC was designed to restore large windows differently. Quote the algorithm and observed state before estimating recovery.

### Reno, CUBIC, and BBR — Role-specific

These are algorithm families, not TCP's reliability contract:

| Family | Main model/signal | Useful consequence | Boundary |
|---|---|---|---|
| Reno/NewReno | Loss; additive increase and multiplicative decrease | Simple reference model | Slow recovery on high-BDP paths; RTT bias |
| CUBIC | Loss; cubic window growth in elapsed time | Faster high-window recovery | Still loss-driven; implementation parameters vary |
| BBR family | Estimated bottleneck delivery rate and propagation RTT | Pacing around a path model | Version-specific behavior/fairness; needs suitable pacing support |

Linux has commonly selected CUBIC in many distributions and offers BBR in supported kernels/builds, but availability and default choice are configuration facts. Do not prescribe a WAN algorithm for a tiny low-rate connection without showing that `cwnd` or queueing is the bottleneck.

### Bandwidth-delay product

The **bandwidth-delay product** (BDP) is the data required in flight to keep a path busy:

```text
BDP_bits  = bottleneck_bits_per_second × RTT_seconds
BDP_bytes = BDP_bits / 8
```

For a hypothetical 10 Gbit/s path with 100 microseconds RTT:

```text
10,000,000,000 × 0.0001 / 8 = 125,000 bytes
```

A usable window well below 125 kB caps throughput even with no loss. A window at least that large is necessary but not sufficient: the application, pacing, CPU, NIC, and receiver must also sustain the rate.

For a 100 Mbit/s path with 50 ms RTT, BDP is 625 kB. This is why long-distance throughput can be window-limited while a small-message LAN workload is dominated by RTT and processing rather than steady-state bandwidth.

### Bufferbloat and queueing cost

Any queue adds approximately:

```text
queueing_delay = queued_bytes / bottleneck_bytes_per_second
```

One MiB queued before a 1 Gbit/s bottleneck adds:

```text
1,048,576 × 8 / 1,000,000,000 ≈ 8.39 ms
```

Large buffers prevent drops during bursts but can turn overload into standing delay. Loss-based congestion control may build queues until loss/ECN signals cause a response. Active queue management, fair queueing, ECN, pacing, traffic separation, and right-sized application queues address different parts of this mechanism; their configuration belongs to Chapters 39, 42, and 46.

ECN marks congestion instead of dropping an ECN-capable packet, but it does not eliminate queueing or guarantee that every path/device preserves markings. Treat support as an end-to-end deployment property.

---

## 38.7 Latency Consequences: HOL, Nagle, and ACK Policy — Core

### Head-of-line blocking

TCP must withhold bytes after a hole until the missing range arrives. This produces two distinct queues:

1. out-of-order bytes waiting in the receiver TCP stack;
2. later application messages trapped behind an earlier message's missing bytes.

Multiplexing independent logical requests on one TCP connection couples their latency through this ordering. More connections can isolate loss domains but cost extra state, congestion histories, and application complexity. UDP-based transports with independent stream sequence spaces can avoid cross-stream transport HOL, but they introduce different protocol trade-offs.

Recovery delay is not one constant:

```text
middle loss + useful later data → ACK/SACK evidence may recover near an RTT scale
tail loss                       → needs time-based probe or fallback timer
receiver stall                  → waits for application drain/window update
```

### Nagle's algorithm

Nagle's algorithm (RFC 896) reduces tiny packets by allowing a small outstanding segment and coalescing further small writes while prior data remains unacknowledged, subject to the implementation's rules. This improves wire efficiency but can delay a latency-sensitive write pattern.

The important condition is not merely "small messages." Delay appears when the application produces a small trailing write while unacknowledged data remains and the stack chooses to coalesce it. If the application writes a complete record in one operation and no other limit intervenes, Nagle may have no visible effect.

`TCP_NODELAY` requests disabling Nagle. It does not make writes atomic, preserve boundaries, remove congestion/flow control, or force immediate NIC transmission. Chapter 45 covers option APIs.

### Delayed acknowledgements

A receiver may delay an ACK to reduce pure-ACK traffic or piggyback it on reverse data. Standards constrain correctness and broad behavior, but the trigger count, delay bound, adaptive heuristics, and quick-ACK state vary by implementation and traffic history.

Nagle and delayed ACK can interact:

```text
sender: small remainder waits for ACK of prior bytes
receiver: ACK waits briefly for more data or reverse traffic
result: application pause until some ACK-policy event releases progress
```

This is not a universal 40 ms timer or a protocol deadlock. Diagnose it by observing a small unsent remainder, outstanding unacknowledged data, and the actual ACK delay in a capture.

Consider an application that emits a 900-byte header/body and then a 20-byte trailer in separate writes. If the first write leaves unacknowledged data and the second is below the stack's useful segment threshold, Nagle may hold the trailer. If the receiver is temporarily delaying its ACK, completion waits for that ACK decision. Combining the 920 bytes before writing removes the split-write precondition and often improves behavior even without changing options.

The same pause does not occur for every 900+20-byte exchange. MSS, earlier outstanding bytes, ACK ratio, reverse traffic, offload, congestion window, and scheduler timing all matter. This is why a packet trace is stronger evidence than a latency histogram with a familiar-looking mode.

Linux exposes `TCP_QUICKACK` as a request to enter quick-ACK behavior; it is Linux-specific and not a permanent portable mode. Linux `TCP_CORK` requests batching toward fuller segments and has implementation-specific release behavior. Their detailed use and interactions with `TCP_NODELAY` belong to Chapter 45.

| Mechanism | Intended effect | Does not guarantee |
|---|---|---|
| `TCP_NODELAY` | Disable Nagle-style small-write coalescing | One segment per write or immediate wire transmission |
| Linux `TCP_QUICKACK` | Request prompt ACK behavior | A sticky mode or fixed ACK policy |
| Linux `TCP_CORK` | Hold/coalesce output for fuller segments | A portable timer or message boundary |

The first application fix is usually to frame and assemble a complete record before handing it to the transport. That reduces syscall/write fragmentation without depending on packetization.

---

## 38.8 Application Framing and a Bounded Decoder — Core

Framing converts the byte stream into records. Common schemes:

| Scheme | Benefit | Failure boundary |
|---|---|---|
| Fixed size | No header parsing | Wastes space or cannot represent variable records |
| Delimiter | Human-readable/simple | Escaping, delimiter search, and maximum-length enforcement |
| Length prefix | O(1) length discovery; binary-friendly | Untrusted length must be validated before allocation/copy |
| Type + length + payload | Supports evolution and dispatch | Header/version validation required |

A correct decoder must accept a header split across chunks, a payload split across chunks, and several frames in one chunk. It must impose a hard maximum before allocating.

### Compiling C++23 decoder

This decoder uses a four-byte big-endian payload length. It processes arbitrarily chunked input while retaining at most one bounded frame. The emitted view is valid only during the callback.

```cpp
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

class FrameDecoder {
    static constexpr std::size_t max_payload = 1u << 20;
    std::array<std::byte, 4> header_{};
    std::size_t header_used_ = 0;
    std::size_t expected_ = 0;
    bool have_length_ = false;
    bool failed_ = false;
    std::vector<std::byte> payload_;

    std::uint32_t decode_length() const {
        std::uint32_t n = 0;
        for (std::byte b : header_)
            n = (n << 8) | std::to_integer<std::uint8_t>(b);
        return n;
    }

public:
    template<class Emit>
    bool consume(std::span<const std::byte> input, Emit emit) {
        if (failed_) return false;

        while (!input.empty()) {
            if (!have_length_) {
                const std::size_t take =
                    std::min(input.size(), header_.size() - header_used_);
                std::copy_n(input.begin(), take,
                            header_.begin() + static_cast<std::ptrdiff_t>(header_used_));
                header_used_ += take;
                input = input.subspan(take);
                if (header_used_ != header_.size()) continue;

                expected_ = decode_length();
                if (expected_ > max_payload) {
                    failed_ = true;
                    return false;
                }
                payload_.clear();
                payload_.reserve(expected_);
                have_length_ = true;

                if (expected_ == 0) {
                    emit(std::span<const std::byte>{payload_});
                    header_used_ = 0;
                    have_length_ = false;
                    continue;
                }
            }

            const std::size_t take =
                std::min(input.size(), expected_ - payload_.size());
            payload_.insert(payload_.end(), input.begin(),
                            input.begin() + static_cast<std::ptrdiff_t>(take));
            input = input.subspan(take);

            if (payload_.size() == expected_) {
                emit(std::span<const std::byte>{payload_});
                header_used_ = 0;
                have_length_ = false;
            }
        }
        return true;
    }
};
```

The zero-length branch emits immediately and resets before looping, so it neither waits for a nonexistent payload byte nor spins without consuming state. A format that forbids empty records would instead reject `expected_ == 0`.

The decoder was designed for these properties:

- the maximum is checked before `reserve`;
- each input byte is copied at most once into bounded frame storage;
- split headers, split payloads, and coalesced frames use one state machine;
- after an oversized length, `failed_` makes all later calls fail consistently;
- emitted spans cannot outlive the callback.

Validation should enumerate every split position for representative frames, feed multiple frames in one chunk, exercise zero and maximum lengths, and encode `max_payload+1` without supplying a payload. Sanitizers help detect memory errors but do not replace assertions about emitted frame contents and counts.

The transport read loop should feed whatever bytes are available to the decoder. It must not wait for "one message-sized read." Buffer reuse and zero-copy views require explicit lifetime rules; Chapter 45 covers partial reads and Chapter 51 covers hostile-input parser design.

### Framing failure is a protocol decision

After an invalid length, this decoder enters a terminal failed state. That is deliberate: without a self-synchronizing marker, scanning forward for a "plausible" header can mistake payload bytes for a new record and silently corrupt the session. The connection-level policy should log the reason and sequence/session context, then reject or close according to the application protocol.

A hard length cap bounds memory but not all work. A stream of maximum-size valid frames can still consume bandwidth, allocation, copying, and callback time. Production protocols commonly add message-type validation, per-session rate/queue limits, and a bounded allocator strategy. These controls are application correctness and resource policy, not TCP flow control: the kernel receive window only knows bytes, not whether parsing those bytes is affordable.

The decoder's retained vector keeps its largest allocated capacity. That is bounded here by one MiB; if thousands of idle sessions make that retention excessive, use a smaller protocol maximum, a pool, or release capacity outside the latency-critical path. Measure memory against concurrent sessions rather than only one decoder.

---

## 38.9 Diagnosis: From Symptom to Sequence State — Core

Start with a capture and endpoint state rather than a sysctl list.

### Minimal commands

```bash
# Linux; fields vary with kernel/iproute2 version.
ss -tin
nstat -az | grep -E 'TcpRetransSegs|TCP.*(Retrans|Timeout|DSACK)'

# Packet trace: numeric names, absolute sequence numbers, relative time.
tcpdump -nn -ttt -S -i <interface> 'tcp port <port>'
```

`tcpdump` ordinarily displays relative sequence numbers for readability; `-S` requests absolute values. Offloads can make host captures show segments larger than wire MSS or checksums that appear invalid before NIC completion. Capture point and offload state must be recorded (Ch. 46 and Ch. 48).

### Decision procedure

| Observation | Leading hypothesis | Next check |
|---|---|---|
| Repeated ACK edge, later SACK ranges | Hole from loss/reordering | Retransmission timing and D-SACK |
| Advertised window trends to zero | Receiver/application backpressure | Receiver read progress and queue occupancy |
| Large unacknowledged range, `cwnd` small | Congestion/recovery limited | Loss/ECN and congestion state |
| Bytes queued locally but not sent | Local corking, Nagle, pacing, or closed window | Outstanding data, options, `rwnd`, `cwnd` |
| Complete TCP delivery but no response | Peer application/protocol issue | Application heartbeat and request ID logs |
| FIN then persistent `CLOSE-WAIT` | Local lifecycle incomplete | Descriptor ownership and shutdown path |
| RST | Abort/no matching connection/policy | Direction, preceding FIN/data, endpoint logs |
| Silence | Blackhole, peer failure, or capture gap | Bidirectional capture, link/route, application deadline |

### Worked latency diagnosis

An RPC normally completes in 300 microseconds but occasionally takes 9 ms:

1. Record application request ID and local monotonic timestamps.
2. Map its frame bytes to TCP sequence ranges in the capture.
3. If all request bytes leave promptly but one range is retransmitted after 8 ms, the tail is transport recovery. Determine whether later SACK evidence or a timer triggered it.
4. If bytes remain locally unsent until an ACK at 8 ms, inspect the small-write pattern and actual ACK timing rather than declaring "the 40 ms delayed-ACK bug."
5. If the peer ACKs all request bytes immediately but responds 8 ms later, TCP transport did its job; investigate peer processing.
6. If `rwnd` closes, investigate receiver drain/backpressure. If `cwnd` closes, investigate congestion/recovery.

This trace aligns application time, sender sequence state, receiver acknowledgements, and recovery. A generic retransmission counter cannot provide that causal chain.

---

## 38.10 Protocol and Implementation Reference — Reference

Skippable after the core.

### Header fields

```text
source port | destination port
sequence number
acknowledgement number
data offset | flags | advertised window
checksum | urgent pointer
options (header is 20–60 bytes) | payload
```

The data offset is measured in 32-bit words. Important flags are SYN, ACK, FIN, RST, and ECN-related ECE/CWR. PSH is not an application-message marker. Urgent-data behavior has portability complications and should not be used as ordinary framing.

TCP's checksum covers a pseudo-header plus TCP header/data. It detects many accidental corruptions but is only 16 bits; applications needing adversarial integrity or strong end-to-end corruption detection use cryptographic/authentication checks at another layer.

The option area is limited by the 60-byte maximum TCP header. Common options compete for that space:

| Option | Appears when | Purpose |
|---|---|---|
| MSS | SYN | Bound payload accepted from peer |
| Window Scale | SYN | Interpret future advertised receive windows |
| SACK Permitted | SYN | Negotiate later selective acknowledgements |
| SACK blocks | ACKs after out-of-order receipt | Describe received ranges above cumulative edge |
| Timestamps | Negotiated on SYN, then later segments | Timestamp echo/PAWS mechanisms |

At an IP MTU of 1500 bytes, IPv4 without options and a minimal 20-byte TCP header leave 1460 bytes for TCP payload. Additional IP/TCP options reduce payload that fits that MTU unless offload later segments differently. IPv6 has a larger base header. Treat "MSS is 1460" as one Ethernet/IPv4 configuration, not a TCP constant.

### What varies

| Topic | Protocol-level fact | Implementation/deployment variable |
|---|---|---|
| Delayed ACK | ACKs may be delayed within protocol constraints | Delay, ratio, adaptive triggers, quick-ACK behavior |
| Nagle | Standard small-segment avoidance algorithm | Exact interaction with queues/offload and option timing |
| RTO | RTT/variation estimator and backoff principles | Timer floor, granularity, modern pre-RTO recovery |
| Initial congestion window | Standards permit bounded initial behavior | Selected IW and idle restart policy |
| RACK/TLP | Standardized time/probe recovery mechanisms | Kernel version, enablement, reordering window, counters |
| CUBIC/BBR | Congestion-control algorithm families | Availability, version, parameters, default selection, qdisc |
| Keepalive | Optional probes for idle connections | Default off/on state, timers, counts, error delivery |
| TIME-WAIT | Retain state after close for protocol safety | Duration, tuple reuse, resource accounting |
| Receive/send buffers | Flow/local queue resources | Autotuning, accounting, caps, option semantics |
| `QUICKACK` / `CORK` | No portable TCP guarantee | Linux-specific requests and release behavior |

### Option ownership

This chapter explains the mechanism of `TCP_NODELAY`, Linux `TCP_QUICKACK`, Linux `TCP_CORK`, keepalive, user timeouts, and congestion selection. Chapter 45 owns their constants, `setsockopt` calls, inheritance/error behavior, and OS comparisons. A production recommendation must name OS/kernel, topology, workload, rollback, and the packet/counter evidence that would validate it.

---

## 38.11 Recall and Practice — Core

### Recall card

- TCP is an ordered byte stream. Framing, business acknowledgement, deduplication, and post-crash reconciliation are application responsibilities.
- `ACK=N` cumulatively acknowledges bytes below `N`; SACK reports higher received ranges. SYN and FIN each consume a sequence number.
- Setup synchronizes two sequence spaces. Ordinary data may accompany the third ACK; initial-SYN data is an extension such as TFO.
- A receiver withholds later bytes behind a hole. Recovery latency depends on available evidence: duplicate ACK/SACK, time-based probe, or RTO.
- Flow control advertises receiver capacity (`rwnd`); congestion control estimates path capacity (`cwnd`). In-flight data is bounded by both.
- `BDP = bandwidth × RTT`; `queueing delay = queued bytes / drain rate`.
- Delayed-ACK policy and Nagle can interact, but there is no universal delay constant. Observe outstanding bytes and ACK timing.
- On x86/Linux or any other target, label socket options, defaults, timers, and congestion algorithms as implementation behavior.
- A transport ACK proves receipt by peer TCP, not application processing. Disconnect after submission leaves business outcome ambiguous.

### Questions

1. Why can three application writes be returned by one read, and why can one write require several reads?
2. In the worked trace, why does `ACK=1501` persist after bytes 2001–3000 arrive, and what extra fact does SACK provide?
3. Distinguish ordinary data on the third handshake packet from TCP Fast Open data.
4. What does TIME-WAIT protect, and why is a memorized duration not a portable answer?
5. Compare loss recovery when a middle segment is followed by more data with recovery when the final segment of a burst is lost.
6. A sender has `rwnd=256 kB`, `cwnd=32 kB`, and 24 kB in flight. Approximately how much additional data may it send, and which subsystem is limiting it?
7. Calculate the BDP of 2 Gbit/s at 4 ms RTT. What else must be true before that window produces 2 Gbit/s throughput?
8. What packet evidence distinguishes receiver backpressure from congestion-window limitation?
9. Why can `TCP_NODELAY` remove one delay mechanism without guaranteeing one packet per write or immediate delivery?
10. After a request write succeeds and the connection resets, which outcomes remain possible and what application design resolves the ambiguity?

### Code-reading puzzle

Review this unsafe framing fragment:

```cpp
std::uint32_t length = decode_u32(buffer.data());
if (buffer.size() < 4 + length) return NeedMore;
std::vector<std::byte> payload(length);
std::copy_n(buffer.begin() + 4, length, payload.begin());
```

Identify the missing preconditions and explain why `4 + length` can wrap in the unsigned 32-bit expression before comparison with `size_t`. Rewrite the check so the four-byte header is known present, length is bounded before allocation, and subtraction rather than unchecked addition establishes payload availability.

### Implementation exercise

Build a deterministic trace checker that accepts records `(direction, seq, ack, payload_length, flags, optional_sack_ranges)` and maintains `SND.UNA`, `SND.NXT`, and `RCV.NXT` for both directions. Feed it:

1. a handshake whose third ACK carries data;
2. the loss/SACK/retransmission trace from §38.2;
3. an overlapping duplicate retransmission;
4. FIN in one direction while data continues in the other;
5. a wrap-around case whose live range stays below `2^31`.

The checker should flag impossible ACKs, distinguish cumulative from selective acknowledgement, and output when application delivery can advance. Compare its output with a packet capture from a local test connection; Chapter 45 supplies the socket harness.

### Common traps

- Treating read/write calls or captured segments as message boundaries.
- Saying TCP provides exactly-once business execution.
- Treating a successful local write or transport ACK as peer application acknowledgement.
- Comparing 32-bit sequence numbers with ordinary integer `<` across wrap.
- Confusing `rwnd` with `cwnd`, or MSS with either window.
- Interpreting all duplicate ACKs as loss rather than possible reordering.
- Quoting one delayed-ACK, RTO, SYN-retry, keepalive, or TIME-WAIT timer as universal.
- Claiming `TCP_QUICKACK` is portable or permanently disables delayed ACK.
- Assuming a congestion-control change helps when the application is receiver- or queue-limited.
- Allocating from an unvalidated length prefix or forgetting split/coalesced frames.
- Treating persistent `CLOSE-WAIT` as a network timeout instead of investigating local lifecycle ownership.
- Reconnecting and resubmitting an ambiguous request without an idempotency key or reconciliation.

### Prerequisites for Chapter 39

Chapter 39 assumes you can separate TCP's stream/recovery queueing from packet queueing in a switch. Be ready to map a missing packet to a byte-stream hole, calculate BDP and queueing delay, and explain why a complete later packet can still be blocked from application delivery.
