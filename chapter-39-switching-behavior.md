# Chapter 39 — Switching Behavior

*Interview-focused revision notes. The theme: a switch is a shared, finite-bandwidth resource with a queue in front of every output port — every latency number and every jitter event in this chapter is either a store-and-forward decision, a serialization time, or a queue that filled up.*

---

## 39.1 Store-and-Forward Switching

**Store-and-forward (S&F)** switching means the switch receives the *entire* Ethernet frame into a buffer, validates its **FCS** (the trailing 4-byte CRC-32, Ch. 36 §36.3), and only then makes a forwarding decision and begins transmitting on the egress port.

The defining cost is that the frame must be fully serialized *in* before any of it is serialized *out*. The switch adds at minimum one full **serialization delay** (§39.3) of the frame at the ingress link rate, plus a fixed pipeline/lookup latency:

```
t_S&F ≈ (frame_bits / ingress_rate) + t_lookup + t_fabric
```

At 10 GbE, a 1518-byte frame is 1.21 µs of serialization; a 64-byte frame is 51.2 ns. So S&F latency is **frame-size dependent** — the fundamental distinction from cut-through.

| Frame size | Serialization at 1 GbE | 10 GbE | 25 GbE | 100 GbE |
|---|---|---|---|---|
| 64 B (min) | 512 ns | 51.2 ns | 20.5 ns | 5.1 ns |
| 256 B | 2.05 µs | 205 ns | 82 ns | 20.5 ns |
| 1518 B (max std) | 12.1 µs | 1.21 µs | 486 ns | 121 ns |
| 9000 B (jumbo) | 72 µs | 7.2 µs | 2.88 µs | 720 ns |

Typical total port-to-port figures for S&F datacenter switches: **~600 ns to ~2 µs** for a minimum-size frame on modern merchant silicon (Broadcom Trident/Tomahawk class), and several microseconds on older or feature-rich enterprise gear. A Tomahawk-class 100 G switch in S&F mode is roughly 450–800 ns; a Trident-class 10 G access switch is 1–3 µs.

**Why anyone chooses S&F:**

1. **Error containment.** A frame with a bad FCS — from a marginal optic, a bad cable, or a CRC-stomping upstream device — is dropped at the switch rather than propagated. In cut-through it is *forwarded* and dropped by the endpoint NIC, wasting fabric bandwidth and inflating your receiver's error counters with faults you did not cause.
2. **Speed mismatch is mandatory.** If ingress is 10 G and egress is 1 G, the switch *cannot* cut through: it would underrun the egress transmitter. Any rate step-down forces S&F for that flow. This is the most common reason a "cut-through switch" silently behaves as store-and-forward.
3. **Egress port busy.** If the output port is already transmitting, the frame must be buffered anyway (§39.4). Cut-through is only cut-through when the egress port is idle at the moment the header is parsed.
4. **Any operation requiring the whole frame** — deep packet inspection, encryption, some ACL/QoS classification on trailers, cross-chip fabric traversal on chassis switches.

**Diagnostic signature:** if measured port-to-port latency scales linearly with frame size, you are in store-and-forward regardless of what the datasheet claims. Test with a 64-byte and a 1500-byte frame and diff. A cut-through switch shows a flat difference of a few nanoseconds; an S&F switch shows the full serialization delta from the table above (~1.16 µs at 10 G).

In a tick-to-trade budget (Ch. 52 §52.1), S&F on the market-data path is often invisible because exchange multicast packets are small, but S&F on a 1500-byte order-entry path or a snapshot feed costs you a microsecond you can measure.

---

## 39.2 Cut-Through Switching

**Cut-through** switching begins transmitting on the egress port as soon as enough of the frame has arrived to make a forwarding decision — in practice after the destination MAC (bytes 0–5 of the frame) or, for L3 or ACL-aware switches, after the full L2/L3 header block.

Latency becomes **independent of frame size**:

```
t_cut-through ≈ (header_bits / ingress_rate) + t_lookup + t_fabric
```

Because the tail of the frame is still arriving while the head is already leaving, the switch is pipelined and transit cost is a fixed constant.

**Port-to-port figures worth memorizing** (10 GbE, min-size frames, same-ASIC path):

| Device class | Port-to-port latency |
|---|---|
| Arista 7150S (Fulcrum Alta) | ~350 ns |
| Arista 7050X / Trident class, cut-through | ~550–800 ns |
| Cisco Nexus 3548 (Algo Boost "warp mode") | ~190–250 ns |
| Exablaze / Cisco Nexus 3550-F, L2/L3 | ~95–120 ns |
| Arista 7130 / Metamako / 3550-F, layer-1 | ~4–5 ns |
| Typical S&F enterprise switch | 1–5 µs |

The step from ~350 ns to ~5 ns is the most important discontinuity in the table. A **layer-1 switch** does not parse the frame at all — it is an electrical/optical crosspoint replicating the bit stream, so it cannot make forwarding decisions, detect errors, or arbitrate contention. Its use is **fan-out of a single exchange multicast feed to many trading servers**, where there is one source and contention is impossible by construction. Layer-1 fan-out plus a real L2/L3 switch for everything else is the standard colo topology.

**Fragment-free** (modified cut-through) is the middle ground: wait for the first 64 bytes — the minimum legal Ethernet frame — so collision fragments and runts are filtered while long frames still avoid full serialization. Mostly historical (collisions are a half-duplex artifact), but the term appears in interviews.

**What cut-through cannot do:**

- **It cannot avoid buffering under contention.** The moment two ingress ports target one egress port, one queues (§39.4). Cut-through eliminates the *store* step, not the *queue*.
- **It cannot verify FCS before forwarding.** Corrupt frames propagate. Good switches still compute FCS afterwards and increment an error counter; some **stomp** the CRC (deliberately invert it) so downstream devices reliably drop the frame rather than seeing a coincidentally-valid one.
- **It cannot cut through a rate step-down** (10 G → 1 G would underrun the transmitter), nor is cut-through meaningful when egress is faster than ingress in a way that would starve the egress mid-frame.

| | Store-and-forward | Cut-through |
|---|---|---|
| Latency vs frame size | Linear in size | Constant |
| 10 G, 64 B frame | ~600 ns–2 µs | ~200–500 ns |
| 10 G, 1518 B frame | ~1.8–3 µs | ~200–500 ns (unchanged) |
| Corrupt frames | Dropped at switch | Forwarded, dropped at endpoint |
| Rate mismatch | Supported | Falls back to S&F |
| Egress busy | Already buffering | Falls back to buffering |
| FCS validation | Before forwarding | After forwarding (counter only) |

**Interview framing:** *"Your vendor sells a cut-through switch and you measure 2 µs. Why?"* — Speed mismatch, egress contention, cross-chip/cross-line-card traversal on a chassis, an ACL or tunnel feature forcing S&F, or you measured with large frames on a path that was S&F all along.

---

## 39.3 Serialization Delay

**Serialization delay** is the time to clock a frame's bits onto the wire: `bits / line_rate`. It is not a switch property — it is physics of the link — and it appears once per hop in every latency budget.

The bits counted are more than the payload. Each Ethernet frame carries (Ch. 36 §36.4):

```
[7 B preamble][1 B SFD][14 B header][payload 46–1500][4 B FCS][12 B IPG]
 └──────── 20 B of framing overhead not visible to software ────────┘
```

So a 64-byte minimum frame occupies **84 bytes = 672 bits** of wire time. At 10 GbE that is **67.2 ns**, not 51.2 ns. Confusing "frame size" with "wire time" is a classic interview slip; the per-packet overhead is 20 bytes and it dominates for small packets.

**Reference numbers** (wire time including the 20 B overhead):

| Payload | Wire bytes | 1 GbE | 10 GbE | 25 GbE | 40 GbE | 100 GbE |
|---|---|---|---|---|---|---|
| 46 B (min) | 84 | 672 ns | 67.2 ns | 26.9 ns | 16.8 ns | 6.7 ns |
| 100 B | 138 | 1.10 µs | 110 ns | 44 ns | 27.6 ns | 11 ns |
| 1500 B | 1538 | 12.3 µs | 1.23 µs | 492 ns | 308 ns | 123 ns |

Useful constants: **10 GbE moves 1.25 bytes per nanosecond**; 1 GbE moves 1 byte per 8 ns; 100 GbE moves 12.5 bytes per nanosecond.

**Serialization vs propagation.** Propagation delay is distance-limited: light in fibre travels at ~2/3 c, giving **~5 ns per metre** (~4.9 ns/m typical SMF), i.e. **1 µs per 200 m**. A 10 m cross-connect inside a cage is 50 ns; two buildings 2 km apart is 10 µs each way. Copper DAC is similar (~4.5–5 ns/m). The two combine differently:

- Serialization is paid **per hop** — each switch re-serializes on egress.
- Propagation is paid **per metre of medium**, once per segment.

For one 64-byte market-data packet crossing one 10 G cut-through switch and 30 m of fibre: 67 ns serialization at the source NIC + 150 ns propagation + ~350 ns switch + 67 ns re-serialization ≈ **630 ns** wire-to-wire before the receiving NIC does anything. That "before software runs" floor is what makes kernel bypass (Ch. 47) worth a chapter.

**Why jumbo frames are a latency mistake on hot paths.** A 9000-byte jumbo frame is 7.2 µs of serialization at 10 G. If one is in flight on an egress port when your 64-byte order arrives, your order waits up to 7.2 µs of **transmit blocking** — a switch will not preempt a frame mid-transmission (802.3br frame preemption exists but is essentially absent from datacenter switches). Jumbo frames are a throughput optimization that directly damages tail latency; trading networks standardize on 1500-byte MTU on market-data and order paths for exactly this reason.

The same argument applies to **TSO/GSO** (Ch. 46 §46.10): a 64 KB TSO segment handed to the NIC becomes a burst of back-to-back MTU frames occupying the egress port for ~54 µs at 10 G, blocking anything behind it.

---

## 39.4 Switch Output-Port Contention

**Output-port contention** occurs when two or more ingress ports have frames destined for the same egress port in the same interval. An egress port transmits one frame at a time, so the switch queues the losers. This — not switching decision time — is the dominant source of switch latency variance in production.

Modern datacenter switches are **output-queued or virtual-output-queued** (§39.7) with a non-blocking crossbar, so the fabric is not the bottleneck. The bottleneck is arithmetic: N ingress ports at rate R can offer N×R to a single egress port that drains at R.

```
ingress p1 ──┐
ingress p2 ──┼──► [egress queue] ──► egress port (drains at line rate)
ingress p3 ──┘         ▲
                       └── depth grows at (offered − drain) rate
```

**Queueing delay for a frame that finds k frames ahead of it** is the time to serialize those k frames:

```
t_queue = Σ serialization(frame_i)   for i in queue ahead
```

At 10 G, each 1500-byte frame ahead of you costs 1.23 µs. Ten frames of backlog is **12 µs**, dwarfing the switch's own 350 ns forwarding latency by 35×. Datasheet "switch latency" is the *unloaded* number and is nearly meaningless for tail latency.

### Queueing discipline — what determines who drains first

Switches classify frames into **traffic classes** (8, matching the 3-bit PCP field in the 802.1Q tag or the 6-bit DSCP field in the IP header — Ch. 36 §36.7, §36.13) and keep one queue per class per egress port. The scheduler over those queues is the lever that keeps your critical traffic from waiting behind bulk traffic.

| Discipline | Behavior | High-priority latency | Risk |
|---|---|---|---|
| **FIFO / tail-drop** | Strict arrival order, one queue | Whatever the backlog is | No isolation at all |
| **Strict priority (SP)** | Always drain the highest non-empty class | Minimal — blocked only by the frame currently on the wire | **Starvation** of lower classes |
| **DWRR** | Serve classes proportional to weights, deficit-corrected for frame size | Bounded by weights × cycle | Higher than SP; needs tuning |
| **WRED / ECN** | Probabilistic drop or mark before the queue fills | (a loss policy, not an ordering policy) | Bad thresholds cause early drops |

The standard trading configuration is **strict priority for market-data and order-entry classes, DWRR beneath** — accepting that bulk traffic can starve, because bulk traffic is by definition off the critical path. Residual blocking under SP is exactly one in-flight frame, which is the anti-jumbo argument restated (§39.3).

**Tail-drop vs AQM.** Tail-drop discards on overflow, causing TCP **global synchronization**: many flows lose a packet at once, halve their windows together, and utilization sawtooths. RED/WRED drops probabilistically as average depth rises, desynchronizing flows. **ECN** marks instead of dropping, letting senders back off losslessly — the basis of DCTCP and DCQCN.

**The canonical HFT contention scenario:** the exchange bursts market data; the switch replicates it to 20 subscriber ports; simultaneously your order-entry traffic wants the uplink port. If market data and orders share an egress port, orders queue behind market data at exactly the moment you want to trade. **Physically separating market-data and order-entry onto different ports, switches, and NICs is the structural fix**, and saying so scores well.

**Incast** is the pathological many-to-one case (N senders answering one requester). With shallow buffers you get synchronized drops and, on TCP, correlated retransmit timeouts (Ch. 38 §38.10) costing hundreds of milliseconds.

**Measurement.**

```
$ ethtool -S eth0 | grep -E 'drop|discard|pause'
# switch side:
show interface ethernet 1/1 counters        # output discards
show queuing interface ethernet 1/1         # per-queue max depth watermark
```

The counter you want is the **peak queue-depth watermark** per egress queue, not the drop count. Drops mean you already overflowed; a rising watermark shows latency being added *before* any loss. In-band telemetry (INT / postcard telemetry) stamps per-hop queue depth into packets and is the only way to attribute a specific spike to a specific hop. Two more traps worth naming: a switch that does not **trust** incoming DSCP/PCP silently remaps everything to class 0, defeating your QoS design; and **shaping** (delay to a rate) must never be used where **policing** (drop above a rate) will do, because a shaper's job is to add latency.

The mental model: **contention converts bandwidth headroom into latency**. A link at 40% average utilization is not safe; what matters is the instantaneous arrival pattern (§39.5).

---

## 39.5 Network Microbursts

A **microburst** is a period, typically 10 µs to a few milliseconds, during which the instantaneous arrival rate at a switch port exceeds the egress line rate — even though average utilization measured over a 1-second or 5-minute SNMP interval is low.

This is the most important operational concept in the chapter, because it explains the observation that breaks naive capacity planning: *"the link is at 15% utilization and we're dropping packets."*

**Why averages lie.** SNMP polls every 30 s. A 10 GbE port carrying 1.5 Gbps average could be idle for 850 ms and transmitting at full line rate for 150 ms — and during those 150 ms anything offered above 10 G queues or drops. The sampling granularity needed to see a microburst is roughly the **buffer drain time**: for 10 MB of buffer at 10 G that is 8 ms, so sub-millisecond sampling is required to see what filled it.

```
Instantaneous rate
   10G ┤    ██        ██  ██
       │    ██        ██  ██
  1.5G ┼────██──avg───██──██──────
       └──────────────────────────► t
        SNMP sees 1.5G. The buffer sees 10G.
```

**Sources in trading networks:**

1. **Market-data events.** An index recalculation, an open/close auction (Ch. 49 §49.12), a macro announcement, or a large sweep produces thousands of multicast packets within a few hundred microseconds. Feed rates jump from a 200 k msg/s baseline to 5–10 M msg/s peaks in under a millisecond. Exchange feed specs publish exactly these peak-vs-average figures and you are expected to size for the peak.
2. **TSO/GSO and interrupt coalescing** on the sender turn smoothly-paced application writes into wire-level bursts (Ch. 46 §46.6, §46.10).
3. **Aggregation topology.** Many 10 G access links into a 40 G uplink is fine on average and instantly congested when five sources transmit at once.
4. **Speed step-down.** A 25 G source feeding a 10 G destination bursts by construction; the switch buffers the difference every time.
5. **Synchronized senders** — cron jobs, snapshot broadcasts, and monitoring scrapes all firing on the same wall-clock second.

**Consequences, in order of severity:** added queueing latency (µs) → jitter and reordering across parallel paths → tail-latency spikes → buffer exhaustion → drops. On a UDP multicast feed a drop means a sequence gap and a recovery cycle (Ch. 37 §37.4, Ch. 53 §53.4) costing milliseconds and potentially forcing you out of the market. On TCP it means retransmission and congestion-window collapse (Ch. 38 §38.7).

**Detection.** Modern switches ship microburst detection: Arista **LANZ** (Latency ANalyzer) samples queue depth at microsecond granularity and streams threshold-crossing events with timestamps; Cisco has equivalent burst monitoring. LANZ output is the standard evidence artifact — *which* egress queue, *when*, *how deep*. Absent that, a hardware-timestamped capture (Ch. 48 §48.4) with per-packet arrival deltas lets you reconstruct instantaneous rate offline.

**Mitigation is capacity and separation, not buffering:** more egress bandwidth, dedicated ports for market data, pacing on the sender, and disabling TSO/coalescing on latency-critical transmit paths. Adding buffer converts drops into latency, which for market data is often *worse* (§39.6).

---

## 39.6 Shallow and Deep Switch Buffers

Switch **packet buffer** is on-chip SRAM shared across ports, and it is the scarcest resource in the ASIC. Two design philosophies exist, and the choice is a direct latency/loss tradeoff.

| | Shallow-buffer ("low-latency") | Deep-buffer |
|---|---|---|
| Total buffer | 12–42 MB shared (Tomahawk ~42 MB, Trident3 ~32 MB, older Alta ~2 MB) | 4–24 GB off-chip (Arista 7280R/7500R with Jericho, Cisco Nexus 9500-R) |
| Buffer per 10 G port | tens to hundreds of KB | tens of MB |
| Drain time at 10 G | tens of µs | tens of ms to seconds |
| Behavior under burst | Drops early | Absorbs, adds latency |
| Forwarding | Usually cut-through capable | Usually VOQ + store-and-forward |
| Base port-to-port latency | 350 ns–1 µs | 2–20 µs |
| Fit | Trading, HPC, RDMA | WAN edge, storage, incast-heavy workloads |

**The core tradeoff:** buffer does not create bandwidth. If offered load exceeds egress capacity for longer than the buffer absorbs, you drop anyway. Buffer only converts a *drop* into a *delay*, and whether that trade is good depends entirely on the traffic:

- **TCP bulk transfer** — delay beats loss, since a drop costs a retransmit RTT plus window collapse. Deep buffers help.
- **Market data** — a packet delayed 20 ms is *worthless*; the market has moved. You would rather drop it and let A/B arbitration (Ch. 53 §53.6) supply the copy than receive stale data. Deep buffers actively hurt.
- **Your own order flow** — a 20 ms delayed order can execute against a price that no longer exists, an outcome worse than a rejection.

Hence HFT networks standardize on shallow-buffer cut-through switches and treat buffer occupancy as a *fault indicator*, not a feature. **Bufferbloat** (Ch. 38 §38.19) is the pathology of oversized buffers — standing queues that never drain, so every packet inherits the full queueing delay. A deep-buffer switch on a low-latency path is bufferbloat at 10 G.

**Architecture details that separate strong candidates:**

- **Shared vs dedicated pools.** Most ASICs have a small per-port reservation plus a large **dynamic shared pool**, governed by an **alpha** parameter capping how much of the shared pool one congested port may take. A single congested port with a high alpha can starve every other port — a real failure mode where an unrelated bulk transfer causes drops on your market-data port. Lowering alpha for non-critical ports is standard hardening.
- **Ingress vs egress accounting.** VOQ designs buffer at ingress on behalf of an egress port; output-queued designs buffer at egress. This changes which counter increments and where blocking can occur (§39.7).
- **MMU counters.** Per-queue peak occupancy is the diagnostic; on Broadcom platforms it is exposed via `bcmcmd` or vendor telemetry.

**Diagnostic signature:** growing latency with no loss = deep buffers absorbing bursts. Loss with low reported latency = shallow buffers. Loss *and* high latency = you are past capacity, and no buffer tuning will save you.

---

## 39.7 Switch Head-of-Line Blocking

**Head-of-line (HOL) blocking** is when a packet at the front of a queue cannot be forwarded and thereby blocks packets behind it that *could* have been. The distinction from ordinary contention is essential: in HOL blocking the blocked packets are destined somewhere that is **not** congested.

### The classic input-queued case

A pure **input-queued** switch keeps one FIFO per ingress port:

```
ingress port 1 FIFO:  [→ egress 3][→ egress 7][→ egress 7]
                          ▲ egress 3 is congested
                          └── both frames for egress 7 are stuck,
                              even though egress 7 is idle.
```

A single FIFO per input under uniform random traffic saturates at **58.6% throughput** (the Karol/Hluchyj result, 2 − √2). That number is worth knowing: it is why no modern switch is purely input-queued.

### The fix: Virtual Output Queues

**VOQ** gives each ingress port a *separate queue per egress port* (N² queues), with a scheduler computing a maximal matching between ingress and egress each cycle (iSLIP or similar). A congested egress backs up only its own VOQ; traffic to other egresses flows unimpeded. VOQ recovers ~100% throughput and is standard on all serious datacenter silicon.

### Where HOL blocking still bites

VOQ eliminates the textbook case; three real variants remain:

1. **Same-class blocking.** VOQs are per-(egress port × traffic class), not per-flow. Two flows in the same class to the same egress still block each other — a 9000-byte frame ahead of your 64-byte order costs 7.2 µs at 10 G (§39.3). Fix: give latency-critical traffic its own strict-priority class (§39.4).
2. **PFC-induced HOL blocking.** The big one. **Priority Flow Control** (§39.11) pauses an entire priority class on a link, so a downstream congestion point stops *every* flow in that class on that link — including flows headed to entirely uncongested destinations. The pause propagates hop by hop upstream ("congestion spreading") and in the worst case forms a **PFC deadlock** via a cyclic buffer dependency, wedging the fabric. This is why lossless-Ethernet RDMA deployments (Ch. 47 §47.17) are operationally fragile.
3. **Multicast replication blocking.** A frame being replicated to 30 egress ports holds its replication resource until done; if one of the 30 is congested, some ASICs stall replication to the rest. Well-designed silicon decouples per-egress replication queues; cheaper silicon does not, so a single congested subscriber port degrades multicast delivery for *all* subscribers — a genuinely nasty, hard-to-attribute market-data failure.

**Related but distinct:** TCP head-of-line blocking (Ch. 38 §38.15) is an *end-to-end protocol* phenomenon — one lost segment blocks delivery of all later in-order bytes to the application — with nothing to do with switch queues. Interviewers ask precisely to check you don't conflate them: same name, different layer, different fix (QUIC/SCTP independent streams vs VOQ).

---

## 39.8 ECMP and LAG Hashing

**Link aggregation (LAG / 802.3ad / port-channel)** bonds several physical links into one logical link between two devices. **ECMP (equal-cost multi-path)** spreads traffic across multiple equal-cost L3 next hops. Both choose a physical path the same way: a **hash of header fields**.

The canonical input is the **5-tuple** — source IP, destination IP, protocol, source port, destination port — sometimes plus ingress port, MACs, VLAN, or the IPv6 flow label. The field set is configurable (`port-channel load-balance src-dst-ip-l4port` and equivalents).

```
member = H(src_ip, dst_ip, proto, src_port, dst_port) mod N_links
```

**Why hashing rather than round-robin:** all packets of a flow must take the same path or they arrive out of order (§39.9). Per-packet round-robin maximizes utilization and destroys ordering; per-flow hashing preserves ordering at the cost of imperfect balance.

**Consequences you must be able to state:**

1. **A single flow never exceeds one link's bandwidth.** A 4×10 G LAG does not give one TCP connection 40 G — it gives it 10 G. Missing this gets candidates dinged.
2. **Hash polarization.** With few large "elephant" flows the hash distributes badly; with 8 flows over 4 links the expected imbalance is substantial and one member can carry 2–3× another. This is the standard cause of "one link at 95% while the aggregate is at 40%."
3. **Correlated hashing across tiers.** If every switch in a Clos fabric uses the same hash function, seed, and fields, flows that collide at one tier collide at every tier. Vendors mitigate with per-device hash seeds; verifying seeds differ is a real troubleshooting step.
4. **Rehash on topology change.** Adding or removing a member changes N, so `hash mod N` remaps most flows — a burst of reordering and, on TCP, a wave of spurious fast retransmits. **Resilient (consistent) hashing** uses a lookup table remapped only for the failed member's flows and exists specifically to avoid this.
5. **Multicast is generally not per-packet ECMP'd** — a group is pinned to a path by multicast routing state, so it sidesteps these concerns but also cannot use aggregate LAG bandwidth.
6. **Latency asymmetry between members.** Members can have different fibre lengths or traverse different line cards, differing by tens to hundreds of nanoseconds. A/B redundant feeds hashed onto different members show a consistent skew.

**In trading contexts the general answer is: avoid ECMP/LAG on market-data and order-entry paths entirely.** Use single, deterministic, dedicated links. Multipath introduces path-dependent latency and reordering in exchange for bandwidth you do not need on a path carrying a few hundred megabits. LAG belongs on the bulk/back-office network.

**Diagnostics:** most platforms expose a hash simulator (`test etherchannel load-balance interface ...`, `show port-channel load-balance forwarding-path ...`) that reports exactly which member a given 5-tuple selects — indispensable for confirming your A and B feeds, or primary and backup order sessions, do not land on the same physical link.

---

## 39.9 Packet Reordering

**Reordering** is delivery of packets in an order different from transmission. It is distinct from loss, and every receiver that cares about sequence must be able to tell them apart.

**Sources:**

- Per-packet load balancing (or ECMP rehash, §39.8) across paths of unequal latency.
- LAG member latency asymmetry — different fibre lengths, different line cards.
- **Receiver-side** multi-queue steering: RSS hashing packets of one flow to different queues, or RPS/RFS migration between cores (Ch. 46 §46.12, §46.13). This is a *host*, not network, reordering source and is frequently overlooked.
- A/B redundant feed merge (§39.10) — arbitration inherently interleaves two streams.
- Retransmissions and gap-fill traffic arriving after later original packets.

**Impact by protocol:**

- **TCP** — three duplicate ACKs trigger **fast retransmit** (Ch. 38 §38.8) even though nothing was lost, halving the congestion window. Persistent mild reordering therefore *caps throughput with zero packet loss*, a signature that confuses people badly: `netstat -s` shows retransmits and `DSACK` counts rising while interface error/drop counters stay at zero. Linux exposes `net.ipv4.tcp_reordering` (the dup-ACK threshold estimate) and RACK-TLP, which uses time rather than dup-ACK counts and tolerates reordering far better.
- **UDP market data** — the feed handler sees a sequence-number gap (Ch. 37 §37.4) and must distinguish *reordering* (the missing packet arrives shortly) from *loss* (it never does).

**The reorder window.** The feed handler buffers out-of-order packets for a bounded time or count before declaring a gap and initiating recovery:

```
expected = 1000
arrive: 1000, 1002, 1003, 1001   ← reordering, depth 1, latency ~µs
arrive: 1000, 1002, 1003, ...    ← loss; after window expiry, request retransmit
```

Too short a window ⇒ spurious recovery requests, extra load on the exchange's retransmit channel (Ch. 37 §37.12), and needless churn. Too long ⇒ every real gap costs the full window before recovery even starts. Typical settings are a handful of packets or tens of microseconds. Note the asymmetry: an out-of-order packet delivered *late* to the book builder is fine as long as the book applies updates by sequence number, so a well-designed book builder tolerates small reorder depth without any latency penalty at all — the window only gates *recovery initiation*.

**Measuring reordering.** Hardware-timestamped capture (Ch. 48 §48.4) at the receiver, then compute for each packet the number of higher sequence numbers seen before it (RFC 4737 "reordering extent"). Metrics that matter: reorder *rate*, reorder *depth*, and *lateness in time*. A path with 0.1% reordering at depth 1 is harmless for UDP and quietly halves TCP throughput.

**Design rule:** design for reordering rather than trying to eliminate it. Sequence-number-driven state machines, idempotent application of updates, and a bounded reorder buffer are cheap; guaranteeing in-order delivery across a real network is not.

---

## 39.10 Redundant Network Paths

Exchange market data is delivered as IP multicast (Ch. 37 §37.5), and the standard reliability construction is **redundant A/B feeds**: two identical streams published to different multicast groups over physically disjoint infrastructure. The consumer subscribes to both, arbitrates by sequence number, takes whichever copy arrives first, and discards the duplicate (Ch. 53 §53.6).

Two benefits, and the second is often forgotten:

1. **Loss masking.** A sequence number is lost only if *both* paths drop it — the product of two independent small probabilities.
2. **Latency reduction.** You receive the **min** of two arrival times, so the effective latency distribution is the minimum of two draws, which tightens the tail considerably even when the means are equal.

**Design points:**

- **Disjointness is the whole point.** If A and B traverse the same switch, the same LAG member, or the same optic, the redundancy is illusory. Verifying physical disjointness — different switches, different fibre paths, different NIC ports, ideally NUMA-local NICs on different sockets (Ch. 29 §29.21) — is the real engineering work, and hash simulation (§39.8) is how you confirm it for L3 paths.
- **Arbitration must be O(1) and allocation-free** on the hot path: a fixed-size sequence window with a seen-bitmap, not a hash map (Ch. 55 §55.1).
- **L2 redundancy via spanning tree (STP/RSTP) is unsuitable for trading** — convergence takes seconds and it *blocks* links rather than using them. Modern fabrics use L3 ECMP or MLAG; latency-critical paths use explicit dual-homed multicast instead.

### Multicast replication in hardware — the fan-out side of redundancy

A multicast frame arriving on one ingress port must reach every egress port with a subscriber. The ASIC writes the frame to buffer **once** and enqueues a per-port descriptor to each egress queue — the payload is not physically duplicated N times, only the descriptor. Replication is therefore cheap in internal bandwidth but not free in time.

**The latency consequence that matters: replication is not simultaneous.** The engine enqueues to egress ports in an ASIC-defined order and each port serializes independently, so two subscribers on different ports of the same switch receive the same packet at different times — typically tens to a few hundred nanoseconds apart, with an order that may be fixed by port number or vary with load.

```
L2 switch replication:                L1 fan-out:
  in ──►[lookup][replicate]             in ──►┬──► out1  (t = 5 ns)
            ├──► port A  t+340 ns             ├──► out2  (t = 5 ns)
            ├──► port B  t+380 ns             └──► outN  (t = 5 ns)
            └──► port C  t+420 ns            deterministic, equal, no parsing
```

**Replication skew** is a competitive fairness issue, which is why colos and exchanges deploy **layer-1 fan-out** devices (Arista 7130/Metamako, Exablaze/Nexus 3550-F) that replicate at the physical layer with fixed ~4–5 ns latency, equal to every output port. Additional facts worth having ready:

- Replication cost scales with fan-out in descriptor-enqueue cycles, and the engine has a per-clock replication limit — a 200-member group on a 4-replications-per-cycle engine costs 50 cycles per packet, significant at high multicast rates.
- **Chassis and multi-chip switches** replicate once across the fabric to each destination chip, then locally — so cross-chip subscribers see systematically higher latency. Port selection within a chassis is a latency decision.
- **Unknown multicast floods.** If IGMP snooping is absent, misconfigured, or the querier disappears (Ch. 37 §37.9), the switch treats multicast as broadcast and floods the VLAN. Symptoms: every server's NIC receives every feed, RX rates jump an order of magnitude, kernel drops climb, and hardware MAC filters overflow into **multicast promiscuous** mode, moving all filtering to the host CPU (Ch. 37 §37.8). Signature: host CPU rise on the receive path with no change in subscribed groups. Diagnose with `show ip igmp snooping groups` plus NIC RX counters against expected feed rates. This is one of the most common real-world market-data outages.

---

## 39.11 Ethernet Flow Control and PFC

**802.3x PAUSE** is link-level flow control: a receiver whose buffer is filling sends a MAC control frame (EtherType 0x8808) telling the *directly attached* sender to stop transmitting for a specified number of quanta. One quantum is 512 bit-times; the field is 16 bits, so the maximum pause is 65535 × 512 bit-times — **335 µs at 1 G, 33.5 µs at 10 G**.

The problem is granularity: PAUSE stops **the entire link** — every traffic class, every flow. A slow bulk receiver can pause a link and thereby stall your market data. **Global PAUSE should be disabled on trading networks**, and its presence is a red flag.

```
$ ethtool -a eth0
Pause parameters for eth0:
Autonegotiate:  on
RX:             on      ← should be off on a latency-critical port
TX:             on      ← ditto
$ ethtool -S eth0 | grep -i pause
     tx_pause_frames: 0
     rx_pause_frames: 0      ← nonzero and rising = incident
```

Nonzero, increasing pause counters on a latency-critical port is an incident, not a statistic.

**802.1Qbb Priority Flow Control (PFC)** refines this to per-class pause: the PFC frame carries an 8-bit class-enable vector plus eight per-class quanta values, so class 3 can be paused while class 0 keeps flowing. PFC is the foundation of **lossless Ethernet** for **RoCEv2** (Ch. 47 §47.17), which needs a near-lossless fabric because RDMA's go-back-N recovery is catastrophically expensive.

PFC's failure modes are the interview content:

- **Congestion spreading / HOL blocking (§39.7).** A pause at one hop propagates upstream, stalling flows in that class that never approach the congestion point. The blast radius grows with each hop.
- **PFC deadlock.** A cyclic buffer dependency — possible even in a Clos fabric once link failure causes rerouting — leaves every switch in the cycle waiting for a peer to resume. The fabric wedges until an operator intervenes. **PFC watchdogs** detect a queue paused beyond a threshold and forcibly drop, trading loss for liveness. Deploying PFC without a watchdog is negligence.
- **Headroom sizing.** For true losslessness the receiver must reserve enough buffer to absorb everything already in flight when it sends the PAUSE: round-trip cable propagation, the PFC frame's own serialization and detection time, plus one maximum-size frame already in transmission. That headroom is per-port *per-class* and is precisely why lossless RoCE consumes so much of a shallow-buffer ASIC's memory — a 42 MB chip can be effectively exhausted by headroom reservations alone across many ports and classes.
- **Configuration must be consistent hop by hop.** PFC on a link where the peer has it disabled, or where the class mapping differs, silently degrades to loss or to global pause. Mismatched PFC config is a common RoCE deployment failure.

The modern alternative is **ECN-based congestion control** — DCQCN for RoCE, DCTCP for TCP — which signals congestion end-to-end by marking rather than pausing hop-by-hop, with PFC retained only as a last-resort backstop at very shallow thresholds.

**Summary rule for trading networks:** no global PAUSE; no PFC unless you are running RDMA and have explicitly accepted the operational cost; shallow buffers; strict priority for the hot classes; drop rather than delay.

---

## Key Interview Questions

1. **Store-and-forward vs cut-through — what's the latency difference and where does it come from?** — S&F adds one full serialization delay of the frame (1.23 µs for 1500 B at 10 G) because it buffers the whole frame to validate FCS; cut-through forwards after the header, so latency is frame-size independent (~200–500 ns at 10 G).
2. **When does a cut-through switch silently behave as store-and-forward?** — Any ingress/egress speed mismatch, egress port already transmitting, cross-chip or cross-line-card traversal, and features needing the whole frame (encryption, DPI, some ACLs).
3. **How do you empirically determine which mode a switch is in?** — Measure port-to-port latency with 64 B and 1500 B frames; if the delta matches the serialization delta (~1.16 µs at 10 G), it is store-and-forward.
4. **Compute the wire time of a minimum Ethernet frame at 10 GbE.** — 64 B frame + 8 B preamble/SFD + 12 B IPG = 84 B = 672 bits ⇒ 67.2 ns. Omitting the 20 B of framing overhead is the classic error.
5. **Why are jumbo frames bad for latency?** — 9000 B is 7.2 µs of serialization at 10 G and Ethernet has no preemption, so a small urgent frame can wait a full jumbo transmission on the egress port.
6. **What is a microburst and why doesn't utilization monitoring catch it?** — Sub-millisecond periods where instantaneous arrival exceeds line rate; SNMP's 30 s averaging hides a 150 ms full-rate burst inside a 1.5 Gbps average. Detect with LANZ-style microsecond queue sampling or hardware-timestamped capture.
7. **Deep buffers or shallow buffers for market data, and why?** — Shallow. Buffer converts drops into delay; a market-data packet delayed 20 ms is worthless, and A/B arbitration recovers the drop faster than the deep buffer would have delivered it.
8. **What is head-of-line blocking in a switch and how is it solved?** — A blocked front-of-queue packet stalls packets behind it destined elsewhere; pure input queueing caps throughput at 58.6%. Fixed by virtual output queues with a matching scheduler.
9. **How does switch HOL blocking differ from TCP head-of-line blocking?** — Switch HOL is a queue/fabric property fixed by VOQ; TCP HOL is in-order byte-stream delivery blocking the application on one lost segment, fixed by multi-stream protocols.
10. **Why doesn't a 4×10 G LAG give one TCP flow 40 Gbps?** — Per-flow 5-tuple hashing pins a flow to one member to preserve ordering, so a flow is capped at one member's rate.
11. **What happens to hashing when you add or lose a LAG member?** — `hash mod N` changes for most flows, remapping them and causing a reordering burst; resilient hashing remaps only the affected member's flows.
12. **Why do exchanges and colos use layer-1 switches for market-data fan-out?** — L1 crosspoints replicate the bit stream at ~4–5 ns with deterministic, *equal* latency to every port; an L2 switch replicates sequentially, giving per-subscriber skew of tens to hundreds of nanoseconds.
13. **What goes wrong when IGMP snooping breaks?** — Multicast floods every port as broadcast; NIC RX rates jump, hardware multicast filters overflow into promiscuous mode, host CPU rises, drops appear. Check `show ip igmp snooping groups` and NIC counters.
14. **How does a feed handler distinguish reordering from loss?** — A bounded reorder window (a few packets or tens of microseconds) before declaring a gap; too small causes spurious recovery requests, too large adds the window to every real gap.
15. **Why can reordering cap TCP throughput with zero packet loss?** — Three dup-ACKs trigger fast retransmit and halve the congestion window; the signature is rising retransmit/DSACK counters in `netstat -s` with clean interface error counters.
16. **What does 802.3x PAUSE do, and why disable it?** — Halts the entire link for up to 33.5 µs at 10 G regardless of class, so an unrelated slow receiver can stall market data. Check `ethtool -a` and pause-frame counters.
17. **What is PFC and what is PFC deadlock?** — Per-priority pause enabling lossless Ethernet for RoCE; a cyclic buffer dependency can leave switches mutually paused indefinitely, wedging the fabric until a PFC watchdog force-drops.
18. **Where does queueing delay come from, quantitatively?** — The serialization time of everything ahead of you in the egress queue: ten 1500 B frames at 10 G is 12 µs, 35× the switch's own forwarding latency.
19. **How would you structure a colo network for a tick-to-trade budget?** — L1 fan-out for market data, dedicated shallow-buffer cut-through switch, physically separated order-entry path, no LAG/ECMP on hot paths, 1500 B MTU, TSO and coalescing off, strict priority classes, disjoint A/B feeds on NUMA-local NICs, and per-queue watermark telemetry.

---

## Common Traps

- **Quoting datasheet port-to-port latency as the production number** — it is the unloaded, same-ASIC, min-frame figure with no contention.
- **Computing serialization from payload size**, forgetting the 20 bytes of preamble/SFD/IPG per frame.
- **Believing "cut-through" means never buffering** — contention and speed mismatch both force buffering regardless of mode.
- **Planning capacity from average utilization** — microbursts operate orders of magnitude below SNMP's sampling interval.
- **Enabling jumbo frames on a latency-critical path** — 7.2 µs of non-preemptible blocking at 10 G.
- **Leaving TSO/GSO and interrupt coalescing on for hot-path transmit** — turns paced writes into wire bursts.
- **Assuming deeper buffers are always better** — they convert loss into unbounded delay, which is worse for market data.
- **Expecting a LAG to speed up a single flow.**
- **Assuming A and B feeds are disjoint without verifying the physical path** — a shared switch, LAG member, or optic silently voids the redundancy.
- **Trusting that DSCP/PCP markings survive** — a switch not configured to trust them remaps everything to class 0 and your QoS design does nothing.
- **Leaving global 802.3x PAUSE enabled** — one slow receiver stalls all traffic on the link.
- **Deploying PFC without watchdogs or correct headroom sizing** — congestion spreading and eventually fabric deadlock.
- **Mismatched PFC configuration between peers** — silently degrades to loss or to global pause.
- **Confusing switch HOL blocking with TCP HOL blocking.**
- **Assuming multicast replication is simultaneous across egress ports** — L2 replication is sequential and skewed.
- **Ignoring the ASIC's shared-buffer alpha** — one congested unrelated port can consume the shared pool and cause drops on your critical port.
- **Treating a reorder-induced TCP throughput cap as a loss problem.**
- **Overlooking host-side reordering from RSS/RFS** while hunting for a network cause.
- **Shaping instead of policing on a latency path** — a shaper's job is to add delay.

---

## Compact Recall Summary

**Modes.** Store-and-forward buffers the whole frame, validates FCS, and costs one full serialization delay — latency *linear in frame size*. Cut-through forwards after the header at constant latency but cannot validate FCS and falls back to S&F on speed mismatch, busy egress, or cross-chip paths. Diagnose by comparing 64 B and 1500 B latency.

**Numbers.** 10 GbE = 1.25 B/ns; a 64 B frame is 84 B on the wire = 67.2 ns; 1500 B = 1.23 µs; 9000 B jumbo = 7.2 µs. Fibre propagation ≈ 5 ns/m ⇒ 1 µs per 200 m. Fast L2 cut-through ≈ 350 ns port-to-port; ultra-low-latency ASICs 190–250 ns; layer-1 crosspoint 4–5 ns; store-and-forward enterprise gear 1–5 µs.

**Contention and scheduling.** Contention converts bandwidth headroom into latency: each 1500 B frame ahead of you at 10 G costs 1.23 µs, so ten frames of backlog dwarfs the switch's own 350 ns. Classify by PCP/DSCP into per-class egress queues; strict priority for market data and order entry, DWRR beneath; verify the trust boundary or everything lands in class 0; police, never shape, on hot paths. Tail-drop synchronizes TCP flows, WRED/ECN desynchronizes them.

**Microbursts.** Sub-millisecond excursions to line rate, invisible to SNMP averaging, caused by market-data events, TSO/coalescing, aggregation ratios, speed step-downs, and synchronized senders. Detect with LANZ-class microsecond queue telemetry or hardware-timestamped capture. Peak per-queue occupancy watermark is the leading indicator; drops are the lagging one. Fix with capacity and separation, not buffer.

**Buffers.** Buffer trades loss for delay. Shallow (tens of MB on-chip, µs of drain) fits trading, where a delayed packet is worthless and A/B arbitration covers the drop; deep (GB, ms–s of drain) fits TCP bulk and WAN, and is bufferbloat on a hot path. Watch the shared-pool alpha — one congested port can starve the rest.

**HOL blocking.** Pure input queueing caps at 58.6% throughput; VOQ (a queue per egress per ingress, resolved by a matching arbiter) fixes the textbook case. Residual blocking: same-class queueing, PFC pausing a whole class across a link, and ASIC multicast replication stalling behind one congested subscriber. Distinct from TCP HOL blocking.

**Multipath.** ECMP/LAG hash the 5-tuple to pin flows to paths, so one flow never exceeds one link; elephant flows polarize the hash; member changes rehash and reorder unless resilient hashing is used; identical hash seeds across tiers correlate collisions. Keep hot paths off multipath entirely and use the vendor hash simulator to prove path disjointness.

**Reordering.** Comes from multipath, LAG member asymmetry, receiver-side RSS/RFS, and A/B merge. TCP mistakes it for loss and caps throughput via fast retransmit with clean drop counters; UDP feed handlers need a bounded reorder window sized between spurious recovery and delayed recovery. Design sequence-driven, idempotent consumers rather than trying to eliminate reordering.

**Redundancy and replication.** A/B feeds give loss masking *and* min-of-two latency, but only if physically disjoint end to end; arbitration must be O(1) and allocation-free; STP is unusable for trading. Hardware replicates one buffered copy to N egress descriptors — cheap in bandwidth, *sequential and skewed* in time; layer-1 fan-out gives deterministic equal delivery. Broken IGMP snooping floods multicast as broadcast, overflowing NIC filters into promiscuous mode and spiking host CPU.

**Flow control.** 802.3x PAUSE stops an entire link (up to 33.5 µs at 10 G) — disable it and alarm on pause counters. 802.1Qbb PFC pauses per class and underpins lossless RoCE at the price of congestion spreading, deadlock risk requiring watchdogs, large per-port-per-class headroom, and hop-by-hop configuration consistency. ECN-based DCQCN/DCTCP is the modern replacement, with PFC as a backstop only.
