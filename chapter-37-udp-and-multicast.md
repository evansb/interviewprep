# Chapter 37 — UDP and Multicast

*Interview-focused revision notes. The theme: market data is a one-to-many, latency-over-reliability problem, and UDP multicast is the only transport whose cost model fits — which means the reliability TCP would have provided must be rebuilt, explicitly and cheaply, in the application.*

---

## 37.1 UDP Semantics and Datagrams

**UDP** (User Datagram Protocol, RFC 768) is a thin demultiplexing layer over IP. It adds exactly two things to IP: **port numbers** and an **optional checksum**. Everything else TCP does — ordering, retransmission, flow control, congestion control, connection state — is absent by design.

### The semantic contract

| Property | UDP | TCP |
|---|---|---|
| Unit | **Datagram** — a message with preserved boundaries | Byte stream, no boundaries |
| Delivery | Best effort; may be lost | Reliable (retransmitted until ACKed or the connection fails) |
| Ordering | None; may be reordered | In-order delivery to the application |
| Duplication | Possible (network or redundant feeds) | Suppressed |
| Connection | Connectionless | Handshake + teardown state machine |
| Flow control | None | Receive window |
| Congestion control | **None** — you can trivially melt a link | Slow start, congestion avoidance |
| Multicast/broadcast | **Yes** | No — point-to-point only |
| Header | 8 bytes | 20–60 bytes |
| Head-of-line blocking | None | Yes (Ch. 38 §38.15) |

**Message boundaries are the underrated property.** One `sendto` produces exactly one datagram; one `recvfrom` returns exactly one datagram or nothing. There is no framing problem, no length-prefix parsing, no partial message (Ch. 38 §38.20 is the TCP counterpart, which is an entire subsystem). If the buffer supplied to `recvfrom` is smaller than the datagram, **the remainder is discarded silently** (Linux sets `MSG_TRUNC` in `msg_flags` if you use `recvmsg`) — a classic bug where a feed handler with a 1024-byte buffer silently truncates 1300-byte updates.

### Datagram size limits

```
theoretical max UDP payload      = 65535 − 20 (IP) − 8 (UDP) = 65507 bytes
practical max without fragmenting = 1500 − 20 − 8            = 1472 bytes
jumbo (MTU 9000)                  = 8972 bytes
guaranteed-unfragmented IPv4      = 576 − 20 − 8             = 548 bytes
```
Anything above 1472 fragments (Ch. 36 §36.14), which multiplies loss and inherits the tail. **Exchange feeds keep datagrams under the path MTU as a hard rule.** A zero-length UDP datagram is legal and distinguishable from no datagram — `recvfrom` returns 0, which is *not* EOF as it would be for TCP.

### Why UDP is right for market data

1. **No retransmission means no head-of-line blocking.** A lost packet does not delay the next one. For a price feed, a 200 µs-old price is worth less than the current one; TCP would deliberately stall the stream to deliver the stale one first.
2. **One-to-many.** A single transmission reaches thousands of subscribers. With TCP, the exchange would need one connection and one copy of the stream per subscriber — impossible at scale and unfair, since the last subscriber served is systematically later than the first.
3. **No connection state**, so the exchange has no per-subscriber cost, and a subscriber crash is invisible to the publisher.
4. **Deterministic sender pacing.** With no congestion control, the exchange controls exactly when bytes go out; the network is engineered (provisioned, not shared) rather than negotiated.
5. **Kernel-bypass friendliness.** A UDP receive path is a parse and a demux; a TCP receive path is a state machine with timers. User-space UDP stacks are simple enough to be correct (Ch. 47 §47.10).

The price is that the application must handle loss, ordering, and duplication itself — the subject of §37.3 onwards.

### Connected UDP sockets

`connect()` on a UDP socket sets a default peer. It does not create a connection, but it has three real effects worth knowing:

- You can use `send`/`write` instead of `sendto`, avoiding the per-call address copy and the route lookup — measurably cheaper on high-rate senders.
- The kernel filters incoming datagrams to that peer.
- **You receive asynchronous errors**: an ICMP port unreachable becomes `ECONNREFUSED` on the next operation. On an unconnected socket, ICMP errors are discarded, which is why "my UDP send silently vanished" is normal (Ch. 36 §36.18).

Multicast receivers cannot usefully `connect()` to the group in the general case; use `IP_ADD_SOURCE_MEMBERSHIP` / SSM for source filtering instead (§37.7).

---

## 37.2 UDP Headers and Checksums

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
┌───────────────────────────────┬───────────────────────────────┐
│        Source Port (16)       │     Destination Port (16)     │
├───────────────────────────────┼───────────────────────────────┤
│          Length (16)          │        Checksum (16)          │
└───────────────────────────────┴───────────────────────────────┘
                                8 bytes total
```

| Field | Detail that matters |
|---|---|
| **Source Port** | May be **0** meaning "no reply expected" — legal and used by pure senders |
| **Destination Port** | The demux key. Multicast receivers on one host share a port via `SO_REUSEPORT`/`SO_REUSEADDR` |
| **Length** | **Header + payload**, so the minimum legal value is 8. Redundant with the IP Total Length, which is a known wart |
| **Checksum** | Covers pseudo-header + UDP header + payload. **Optional in IPv4** (0 = not computed); **mandatory in IPv6** |

### The pseudo-header

The checksum is computed over a synthetic prefix that is never transmitted:

```
IPv4 pseudo-header (12 bytes):
┌──────────────────┬──────────────────┬────┬────────┬───────────┐
│   Source IP  4   │    Dest IP   4   │ 0  │Proto=17│ UDP Len 2 │
└──────────────────┴──────────────────┴────┴────────┴───────────┘
```
Its purpose is to detect **misdelivery** — a datagram that arrived at the wrong host or whose addresses were mangled fails the check. Its side effect is the layering violation that forces NAT to rewrite L4 checksums (Ch. 36 §36.10, §36.17).

Two encoding subtleties:
- A computed checksum of `0x0000` is transmitted as **`0xFFFF`** (the other one's-complement representation of zero), because `0x0000` is reserved to mean "no checksum."
- Disabling the checksum is possible on Linux with `setsockopt(SO_NO_CHECK)`. Some exchanges do send zero-checksum multicast to save sender-side work. This is defensible only because Ethernet's CRC-32 already covers each hop and the application carries its own integrity check — but it means a corrupt-in-router-memory packet reaches your parser, which is exactly why exchange protocols carry sequence numbers and their own CRCs (Ch. 51 §51.13).

### Checksum strength and offload

The 16-bit one's-complement sum is weak: blind to 16-bit word reordering, to insertion/deletion of zero words, and to compensating error pairs. Do not treat a passing UDP checksum as message integrity.

Offload behaviour you must know:
- `ethtool -k eth0` shows `tx-checksumming`/`rx-checksumming`. With TX offload, **`tcpdump` on the sender shows "bad udp cksum"** — expected, not a bug.
- With RX offload, the NIC verifies and sets `CHECKSUM_UNNECESSARY` in the `sk_buff`; the stack skips verification entirely. A NIC with a checksum bug therefore silently admits corruption.
- On **kernel bypass** you are responsible: DPDK requires `PKT_TX_UDP_CKSUM` plus a correctly-seeded pseudo-header partial checksum, or you compute it yourself. Forgetting this is one of the most common first-week DPDK bugs, and the symptom is packets that leave the NIC and are dropped by the first receiving host with no error anywhere on the sender.

### Cost accounting

| Operation | Approximate cost |
|---|---|
| `sendto` syscall, small datagram | 1–3 µs (Ch. 34 §34.5) |
| `recvfrom`, kernel path | 1–3 µs after the packet is in the socket queue |
| `sendmmsg`/`recvmmsg` batch of 32 | ~1 syscall amortized, ~0.2 µs/msg (Ch. 45 §45.11) |
| Software UDP checksum, 1 KB | ~100–200 ns (usually offloaded) |
| Kernel-bypass receive (ef_vi/DPDK) | ~250 ns–1 µs wire-to-application |

---

## 37.3 Application-Level Loss Recovery

Because UDP does not retransmit, the application must decide what "recovery" even means. The design space is defined by one question: **is stale data useful?**

| Data model | Loss response | Example |
|---|---|---|
| **State snapshot** (current best bid/offer) | Ignore the loss, wait for the next update, or re-sync from a snapshot | Conflated top-of-book feeds |
| **Event log** (every add/cancel/execute) | Must recover every message or the book is wrong | ITCH, MDP incremental |
| **Idempotent refresh** | Periodic full state makes losses self-healing | Some FX and index feeds |

Order-book feeds are the hard case: the book is a *replayed log*, so a single missing "order add" leaves the book permanently wrong. There is no way to infer the missing message; you must obtain it or rebuild.

### The four recovery mechanisms

1. **Detect and request retransmission** (§37.12) — a separate TCP or UDP unicast channel to a retransmission server. Latency: milliseconds. Bounded by the exchange's retention window (often only a few thousand messages).
2. **Detect and re-snapshot** (§37.13) — join a snapshot feed carrying periodic full book state, discard incremental messages older than the snapshot, and resume. Latency: up to the snapshot period (typically 1–30 s).
3. **Redundant feeds / arbitration** (§37.14) — subscribe to two identical A/B feeds on disjoint paths and take whichever copy of each sequence number arrives first. Latency: **zero** for losses that are not correlated across both paths. This is the primary mechanism.
4. **Forward error correction** — send redundant parity packets so that k of n suffice. Costs bandwidth continuously and adds decode latency and buffering; rare in equities market data, more common in some derivatives and in video. Its virtue is needing no feedback channel, which matters for a one-to-many publisher.

The layered reality in production: **arbitration first (free), retransmission second (milliseconds), snapshot third (seconds), full restart last.**

### The staleness decision

Loss recovery is not free, and the important design judgement is **when to stop trying and go flat**. A feed handler that has a gap and is waiting for a retransmit is holding a *known-wrong* book. The choices are:

- **Block**: buffer subsequent messages, do not publish, wait for the gap fill. Preserves correctness; introduces unbounded latency and memory growth; the strategy trades on stale prices unless it is told.
- **Publish degraded**: mark the instrument (or the whole book) stale and let the strategy decide. This is the standard approach — the risk layer refuses to quote on a stale book (Ch. 53 §53.8).
- **Reset**: drop the book, re-snapshot, and quote nothing until recovered.

**The non-negotiable rule is that a gap must never silently produce a wrong book.** Anything that continues applying deltas across a known gap is a defect, and interviewers probe for whether you say this unprompted.

### Buffering during recovery

Messages arriving *after* the gap must be buffered while it is being filled, because they will be needed once the missing ones arrive. That buffer needs a bound and a policy:

```cpp
// Preallocated reorder buffer indexed by sequence modulo capacity (Ch. 26 §26.4)
struct ReorderBuffer {
    static constexpr size_t Cap = 8192;        // power of two
    std::array<Msg, Cap> slots;
    std::array<uint64_t, Cap> seq_of;          // sentinel for empty
    uint64_t expected;
};
```
Capacity is a latency/memory tradeoff: too small and a recoverable gap forces a snapshot; too large and a pathological gap grows unbounded delay. A power-of-two ring with sequence tagging avoids any allocation on the hot path (Ch. 55 §55.1).

---

## 37.4 Sequence-Number Gap Detection

Every serious UDP feed carries a monotonically increasing **sequence number** so the receiver can detect loss, reordering, and duplication. The sequence number lives in the *application* protocol, not in UDP — this is exactly the reliability layer UDP omits.

### The state machine

Maintain `expected` = the next sequence number you require. For an arriving message with sequence `s`:

```
 s == expected      → in order:  process, ++expected, then drain the reorder buffer
 s <  expected      → DUPLICATE or late: discard (or count and discard)
 s >  expected      → GAP of (s − expected) messages:
                        buffer this message,
                        start the gap timer,
                        request recovery / wait for the other feed
```

```
 expected = 1004

 arrivals:  1004  1005  1008  1006  1007  1009
 state:      ok    ok   GAP    fill  fill  ok
                        (2 missing: 1006,1007)
                        buffer 1008
                                    buffer 1006 → still need 1007
                                          1007 arrives → drain 1006,1007,1008
```

The subtlety: **a gap and reordering are indistinguishable at the moment of detection.** The only way to tell them apart is time. So the correct implementation does not immediately request a retransmit — it sets a short **gap timer** (typically 1–10 ms, or as low as tens of microseconds on a clean colo LAN where reordering is essentially absent) and only escalates if the hole is still there when it fires. Escalating instantly generates spurious retransmit requests that add load precisely when the network is stressed.

### Message-level vs packet-level sequencing

Two numbering schemes coexist and they are frequently confused:

| Scheme | Where | Gap arithmetic |
|---|---|---|
| **Packet sequence number** | On the datagram (e.g. MoldUDP64 header) | Gap = missing packets |
| **Message sequence number** | On each message inside the packet | Gap = missing messages |

MoldUDP64 (used by NASDAQ) carries a **sequence number of the first message in the packet** plus a **message count**, so the next expected sequence is `seq + count`. A packet containing 5 messages advances the counter by 5. Getting this arithmetic wrong — treating the packet sequence as a per-packet counter — is a common bug that produces phantom gaps under batching. The equivalent in CME MDP 3.0 is a per-packet `MsgSeqNum` in the binary packet header.

### Wraparound and width

A 32-bit sequence at 1 Mmsg/s wraps in ~71 minutes; at 10 Mmsg/s in 7 minutes. Feeds use 64-bit sequences (MoldUDP64 is named for this) or reset daily. **Compare with wrap-safe arithmetic** whenever the width could wrap:

```cpp
// wrap-safe "is a after b" for unsigned N-bit sequence numbers (Ch. 38 §38.4)
inline bool seq_gt(uint32_t a, uint32_t b) { return int32_t(a - b) > 0; }
```
This is the same trick TCP uses for its 32-bit sequence space and is worth being able to write.

### Session and stream identity

A sequence number is only meaningful within a **session** (a trading day, or a MoldUDP64 10-byte session ID). A session change resets the sequence to 1, and a receiver that does not check the session identifier will see a catastrophic backwards jump and, if written carelessly, will treat every subsequent message as a duplicate and go silent for the entire day. Always key `expected` by `(session, channel)`.

### Metrics that must exist

Any production feed handler exposes: `gaps_detected`, `messages_recovered_by_arbitration`, `retransmit_requests`, `retransmit_timeouts`, `snapshots_taken`, `duplicates_discarded`, `max_gap_size`, `gap_fill_latency_histogram`. These are the operational evidence that the recovery machinery works, and their absence is the reason nobody knows the feed was degraded until a trading loss appears (Ch. 59 §59.1).

---

## 37.5 IP Multicast Groups

**IP multicast** delivers one transmission to a set of receivers who have expressed interest, with the network — not the sender — performing replication. **Unicast** is one-to-one, **broadcast** is one-to-all-on-a-subnet, **multicast** is one-to-many-who-asked.

```
 Unicast to 4 subscribers:            Multicast to 4 subscribers:

   sender ──┬──► A                       sender ──► switch ──┬──► A
            ├──► B                                            ├──► B
            ├──► C                       one copy on the      ├──► C
            └──► D                       sender's link        └──► D
   4 copies leave the sender             1 copy; switch replicates
   4× bandwidth, and A is served         all receivers served
   before D — systematically unfair      simultaneously — FAIR
```

The **fairness property is the reason exchanges are regulated toward multicast**: with unicast, whichever subscriber the exchange serialized first would have a structural latency advantage measured in microseconds per subscriber. Multicast makes the replication point the switch, and all receivers on the same switch tier get the frame within nanoseconds of each other.

### The address space

**224.0.0.0/4** (224.0.0.0 – 239.255.255.255). A multicast address identifies a **group**, not a host; there is no "owner."

| Range | Name | Use |
|---|---|---|
| `224.0.0.0/24` | Local network control | Never forwarded by routers, **must be sent with TTL 1**. `224.0.0.1` all-hosts, `224.0.0.2` all-routers, `224.0.0.5/6` OSPF, `224.0.0.22` IGMPv3 reports |
| `224.0.1.0/24` | Internetwork control | `224.0.1.1` NTP; routable |
| `232.0.0.0/8` | **Source-Specific Multicast** | SSM only (§37.7) |
| `233.0.0.0/8` | GLOP | AS-number-derived global allocation; several exchanges publish here |
| `239.0.0.0/8` | **Administratively scoped** | Private, RFC 2365 — the RFC 1918 of multicast; most in-house and many venue feeds |

There is **no port in the group address** — a group plus a UDP port together identify a stream, and multiple streams can share a group on different ports (though feeds usually get their own group so that NIC and switch filtering works per-stream).

### The layer-2 mapping and its collision

The destination MAC for an IPv4 multicast group is `01:00:5e` followed by the **low 23 bits** of the group address, with bit 24 forced to zero:

```
 239.1.2.3   = 11101111 00000001 00000010 00000011
                          └── low 23 bits ──────────┘
 MAC         = 01:00:5e:01:02:03
 239.129.2.3 → 01:00:5e:01:02:03    ← SAME MAC
```
28 significant group bits into 23 MAC bits means **32 groups per MAC** (Ch. 36 §36.5). The consequences are concrete: a NIC filtering by MAC admits up to 32 unwanted groups, the kernel or your bypass stack must filter on destination IP, and a badly chosen group allocation can cost real CPU. Exchanges and well-run firms allocate groups so that the low 23 bits differ.

### Sending and joining

```cpp
// Sender: TTL is the scope control and defaults to 1 (Ch. 36 §36.15)
int ttl = 8;   setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof ttl);
// Choose the egress interface EXPLICITLY — the default route is usually wrong
in_addr ifaddr{ .s_addr = inet_addr("10.9.0.7") };
setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &ifaddr, sizeof ifaddr);
int loop = 0;  setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof loop);

// Receiver: bind to the port (and, on Linux, optionally the group) then join
ip_mreq mreq{ .imr_multiaddr = { inet_addr("233.54.12.88") },
              .imr_interface = { inet_addr("10.9.0.7") } };
setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof mreq);
```

Three traps in that snippet, all common:
- **`IP_MULTICAST_TTL` defaults to 1** — works on the local switch, silently dies at the first router.
- **`IP_MULTICAST_IF` must be set explicitly** on a multi-homed host, or the kernel picks by route table and sends out the wrong (often the management) NIC.
- **`IP_MULTICAST_LOOP` defaults to on** — a sender receives its own traffic, which is occasionally useful for testing and usually just wasted work and a source of confusing duplicates.

Membership is per-socket **and** per-interface; the kernel refcounts joins, and joining the same group on two interfaces creates two separate memberships. `netstat -gn` / `ip maddr show` list current memberships. `IP_DROP_MEMBERSHIP` leaves; closing the socket leaves implicitly.

---

## 37.6 IGMP

**IGMP** (Internet Group Management Protocol) is how a host tells its local router "I want group G." It operates only on the last hop — between hosts and their first-hop router — and is carried in IP protocol 2 with TTL 1.

### Versions

| Version | RFC | Key features |
|---|---|---|
| **IGMPv1** | 1112 | Reports only; leaves detected by query timeout (up to ~3 min of wasted traffic) |
| **IGMPv2** | 2236 | Adds **Leave Group** message and group-specific queries → fast leave |
| **IGMPv3** | 3376 | Adds **source filtering** (INCLUDE/EXCLUDE source lists) — required for SSM (§37.7) |

IGMPv3 is what trading networks use, because SSM eliminates the group-collision and rogue-source problems.

### The protocol exchange

```
 Router (querier)                              Host
      │                                          │
      │ ── General Query (to 224.0.0.1) ────────►│   every ~125 s
      │                                          │
      │                          (random delay 0..Max Resp Time,
      │                           suppressed if another host reports*)
      │◄──── Membership Report (v3 → 224.0.0.22)─│
      │                                          │
      │ ◄─── Leave Group / v3 state-change ──────│   on IP_DROP_MEMBERSHIP
      │ ── Group-Specific Query ────────────────►│   "anyone else want G?"
      │      (no reply within ~2×1 s)            │
      │  → stop forwarding G on this port        │
```

\* Report suppression exists in v1/v2 and is **removed in IGMPv3** — every host reports, which is what lets snooping switches build accurate per-port state.

**Timers worth knowing:** query interval 125 s, max response time 10 s, robustness variable 2, group membership interval = `robustness × query_interval + max_response_time` ≈ **260 s**. That 260 s is the worst-case time a router keeps forwarding a group after the last receiver disappears without a proper leave — and, symmetrically, it bounds how long a lost join can leave you with no data if nothing retriggers it.

### The unsolicited-report and join-latency question

A host does not wait for a query to join: `IP_ADD_MEMBERSHIP` triggers an **unsolicited report** immediately, and the host sends it `robustness` times (twice) to survive loss. Join latency is therefore typically **sub-millisecond to a few milliseconds** on a LAN — but the join must propagate to the snooping switch and possibly the router, and PIM (§37.10) may need to build a path back to the source, which can take longer on a cold group.

**Operationally, this is why trading systems join their multicast groups at startup, long before the market opens, and never leave during the session.** A mid-session rejoin costs an unknown amount of missing data. Systems that dynamically subscribe per instrument (rather than per feed) must accept join latency in their design or pre-join everything.

### Failure modes

| Symptom | Cause |
|---|---|
| Data flows for ~4 minutes then stops | Host is not answering queries (firewall dropping IGMP, or the app joined then the socket closed); the router timed the group out at ~260 s |
| Data never arrives, switch shows no group | Join went out the wrong interface (`imr_interface` unset on a multi-homed host) |
| Data arrives on all ports, CPU high | No snooping, or no querier (§37.9) |
| Data stops when an unrelated host leaves | IGMPv2 fast-leave misconfigured on a port with multiple receivers |
| Join succeeds, no data, router sees no source | PIM/RPF failure upstream (§37.10) |

Diagnostics: `tcpdump -i eth0 igmp`, `ip maddr show`, `netstat -gn`, `cat /proc/net/igmp` (shows groups, refcounts, and the querier version per interface), and on the switch `show ip igmp snooping groups`.

---

## 37.7 Source-Specific Multicast

**SSM** (Source-Specific Multicast, RFC 4607) changes the subscription unit from a group `(*, G)` to a **channel** `(S, G)` — a specific source address *and* group. The receiver names the source; the network delivers only that source's traffic.

| | ASM (Any-Source Multicast) | SSM (Source-Specific) |
|---|---|---|
| Subscription | `(*, G)` — any sender to G | `(S, G)` — only S's traffic to G |
| Address range | `224/4` generally, `239/8` scoped | **`232.0.0.0/8`** (and `ff3x::/32` for IPv6) |
| Requires | IGMPv2+ | **IGMPv3** (or IGMPv2 with `IP_ADD_SOURCE_MEMBERSHIP`) |
| Routing | PIM-SM with a rendezvous point (RP), or PIM-DM | **PIM-SSM** — a direct shortest-path tree, no RP |
| Group uniqueness | Global collision risk — two senders to G interleave | Per-source, so `(S1,G)` and `(S2,G)` are distinct channels |
| Rogue-source injection | Possible | **Prevented by the network** |

### Why SSM is the right choice for market data

1. **Address collisions disappear.** Under ASM, two applications choosing the same group interleave their traffic and corrupt each other's sequence numbers. Under SSM, the group need only be unique per source, so an exchange can use `232.x.y.z` freely.
2. **Rogue or stale senders are filtered by the network**, not by your parser. A decommissioned test publisher that still transmits to a production group cannot reach SSM subscribers.
3. **No rendezvous point.** PIM-SM's RP is a shared, stateful, single-point-of-failure element that must be discovered (Auto-RP, BSR, or static) and adds a shared-tree-to-shortest-path-tree switchover with a brief disruption. PIM-SSM builds a shortest-path tree directly from the receiver toward the known source — simpler, faster to converge, and with less state.
4. **Faster and more deterministic join**, because there is no RP registration step.

### The socket API

```cpp
// Portable, RFC 3678 API (preferred)
group_source_req gsr{};
gsr.gsr_interface = if_nametoindex("eth1");
// gsr.gsr_group  = sockaddr_storage for 232.10.1.5
// gsr.gsr_source = sockaddr_storage for the exchange's publisher IP
setsockopt(fd, IPPROTO_IP, MCAST_JOIN_SOURCE_GROUP, &gsr, sizeof gsr);

// Older IPv4-only equivalent
ip_mreq_source imr{ .imr_multiaddr = {group}, .imr_interface = {local},
                    .imr_sourceaddr = {source} };
setsockopt(fd, IPPROTO_IP, IP_ADD_SOURCE_MEMBERSHIP, &imr, sizeof imr);
```

`MCAST_JOIN_SOURCE_GROUP` / `MCAST_BLOCK_SOURCE` / `MCAST_LEAVE_SOURCE_GROUP` are the protocol-independent forms and are what new code should use; the `ip_mreq_source` forms are IPv4-only.

### The operational trap

**SSM makes the source IP part of your configuration.** When an exchange migrates a feed to new publisher infrastructure, the source address changes and every SSM subscriber loses the feed at the cutover unless the config was updated. This is a real, recurring cause of outages, and the mitigation is to treat source addresses as versioned reference data with a validation step (Ch. 60 §60.9) and to join both old and new `(S,G)` across a migration window.

Also note that the network *must* support IGMPv3 end to end: an IGMPv2-only switch or a snooping implementation that does not parse v3 source lists will either flood or fail the join. `cat /proc/net/igmp` shows the negotiated version per interface — if it reports v2 on a network you believe is v3, something forced a downgrade (usually an old querier, §37.9).

---

## 37.8 Multicast NIC Filtering

A NIC must decide which arriving frames to DMA to the host. For multicast this decision happens in hardware, imperfectly, and understanding the imperfection is a genuine low-latency topic.

### The three filtering modes

| Mode | Mechanism | Cost |
|---|---|---|
| **Exact / perfect filter** | A small table (typically 16–128 entries) of full 48-bit MAC addresses | Zero false positives, but a very limited number of groups |
| **Hash filter (imperfect)** | A 4096- or 512-bit bitmap indexed by a CRC over the destination MAC; a set bit admits the frame | Unbounded groups, but **collisions admit unwanted traffic** |
| **Promiscuous / all-multicast** | Admit everything (`IFF_PROMISC` / `IFF_ALLMULTI`) | Every multicast frame on the segment is DMAed and dropped in software |

The escalation is automatic and silent: **joining more groups than the NIC's exact-filter table holds causes the driver to fall back to the hash filter, and joining enough to make the hash useless (or joining certain drivers' thresholds) causes a fall back to all-multicast.** The host then receives every multicast frame on the wire and discards most of it in the kernel — burning PCIe bandwidth, memory bandwidth, and CPU, and adding jitter to the packets you actually wanted.

### The three-layer filtering funnel

```
 wire ──► [1] NIC MAC filter        (exact / hash / promiscuous)
      ──► [2] destination IP check  (resolves the 32:1 MAC collision)
      ──► [3] UDP port + socket demux, plus SSM source check
      ──► application
```

Layer 2 exists because of the 32:1 group-to-MAC collision (§37.5). Even a perfect MAC filter admits up to 32 groups per entry, so **the IP-level check is not optional** — and on a kernel-bypass stack, *you* implement it. A bypass feed handler that filters only on MAC will silently process another feed's packets, produce sequence-number chaos, and be very hard to debug. The fix is a hash set of `(dst_ip, dst_port)` — or, better, a per-queue hardware flow rule.

### Hardware flow steering — the correct answer

Modern NICs support **flow director / n-tuple filters** that match on the full 5-tuple in hardware and steer matching packets to a specific receive queue:

```
ethtool -K eth0 ntuple on
ethtool -N eth0 flow-type udp4 dst-ip 233.54.12.88 dst-port 14310 action 3
ethtool -n eth0                       # list installed rules
```
This gives you per-feed queue isolation: feed A lands on queue 3 pinned to core 3, feed B on queue 4, and neither can add jitter to the other. Combined with per-queue interrupt affinity (Ch. 46 §46.15) and core isolation (Ch. 31 §31.19), this is the standard architecture for a deterministic feed handler. Solarflare/Xilinx and Mellanox/NVIDIA cards additionally expose bypass-native filter APIs (`ef_filter_spec`, `rte_flow`) that do the same for user-space stacks.

### Diagnosis

| Command | Reveals |
|---|---|
| `ip maddr show dev eth0` | The multicast MAC/IP addresses the interface is filtering for |
| `ip link show eth0` | `PROMISC` or `ALLMULTI` flags — the smoking gun for filter fallback |
| `ethtool -S eth0` | `rx_multicast_packets`, `rx_missed_errors`, `rx_no_buffer_count`, per-queue counters |
| `netstat -s \| grep -i "packet receive errors"` | Socket-level drops (buffer overrun, §37.10) |
| `ethtool -n eth0` | Installed n-tuple rules |

**The signature to recognize:** `rx_multicast_packets` far exceeding the rate of the groups you joined, plus `ALLMULTI` in `ip link`, plus otherwise-unexplained CPU in softirq. That is filter fallback, and the fix is fewer groups per NIC, explicit flow rules, or splitting feeds across NICs.

---

## 37.9 IGMP Snooping and Queriers

**IGMP snooping** is a layer-2 switch feature: the switch inspects IGMP messages passing through it and builds a per-port, per-group forwarding table, so multicast is sent only to ports that joined. Without it, a switch treats multicast exactly like broadcast and **floods every multicast frame to every port in the VLAN**.

```
 No snooping (flooding):              With snooping:

  source ──► switch ─┬──► A (wants G)   source ──► switch ─┬──► A (joined G)
                     ├──► B ✗ wasted                       │    B  (no traffic)
                     ├──► C ✗ wasted                       │    C  (no traffic)
                     └──► D ✗ wasted                       └──► D (joined G)
```

Flooding a 100 Mbit/s feed to 40 ports means 4 Gbit/s of unnecessary switching and a NIC on every host discarding traffic it did not ask for — CPU burn, PCIe pressure, and jitter on hosts with no interest in the feed at all.

### The querier problem

Snooping is **passive**: the switch learns only from IGMP messages it happens to see. Hosts send unsolicited reports on join, but thereafter they report only in *response to queries*. If no device on the VLAN sends periodic General Queries, the switch's snooping entries age out and it either reverts to flooding or — depending on the implementation — **stops forwarding the group entirely**.

A **querier** is the device that sends those periodic General Queries. Normally it is the first-hop router (the PIM router elects a querier — the lowest IP address on the subnet wins). But a **purely layer-2 VLAN with no router has no querier**, which is exactly the configuration of an isolated market-data VLAN. The fix is to enable the switch's **IGMP snooping querier** on that VLAN.

**This is the single most common multicast failure in practice, and the signature is diagnostic:** everything works for a few minutes after startup, then the feed goes dead or the whole VLAN starts flooding — because the last unsolicited report has aged out. Anyone who can name "no querier on an L2-only multicast VLAN" as the cause of a multicast feed that dies after ~4–5 minutes is signalling real operational experience.

### The failure matrix

| Snooping | Querier | Result |
|---|---|---|
| Off | — | Flooding to all ports. Works, wasteful, adds jitter fabric-wide |
| On | Present | Correct: traffic only to joined ports |
| **On** | **Absent** | **Entries age out → feed stops (or flooding resumes) after ~260 s** |
| On, v2 | v3 sources in use | Source lists ignored; SSM joins degrade or fail |

### Related switch behaviours to know

- **Fast-leave / immediate-leave** removes a port from the group on receiving a Leave without sending a group-specific query. Correct only on ports with a single receiver; on a port leading to another switch or a host with multiple containers, it cuts off receivers who did not leave.
- **Multicast router ports (mrouter)** — the switch must forward all IGMP reports and all multicast toward the router port; misdetection here breaks joins for everyone.
- **Unregistered multicast flooding behaviour** varies by vendor: some flood unknown groups, some drop them. Both are defensible; not knowing which your switch does is not.
- **Storm control thresholds** applied to multicast can silently police a legitimate market-data burst. Check them before blaming the feed.

Diagnostics: on the switch, `show ip igmp snooping`, `show ip igmp snooping querier`, `show ip igmp snooping groups`. On the host, `tcpdump -i eth0 -n igmp` should show a General Query roughly every 125 s — **if you never see one, you have no querier**, and that single observation solves most multicast mysteries.

---

## 37.10 Multicast Routing Failures

Once multicast must cross a router, **PIM** (Protocol Independent Multicast) builds the distribution tree. PIM does not compute routes itself; it uses the unicast routing table, which is the source of its most distinctive failure mode.

| Mode | How the tree is built |
|---|---|
| **PIM-SM** (sparse) | Receivers join toward a **rendezvous point** (RP); the RP joins toward the source; the tree later switches to the shortest path (SPT switchover) |
| **PIM-SSM** | Receiver joins directly toward the known source — no RP, shortest path immediately (§37.7) |
| **PIM-DM** (dense) | Flood-and-prune; obsolete and unsuitable for anything large |
| **PIM-BiDir** | Shared bidirectional tree for many-to-many |

### RPF — the failure mode you must be able to name

**Reverse Path Forwarding** is the loop-prevention rule: a router accepts a multicast packet only if it arrived on the interface the router would use to send *unicast* traffic back to the source. If not, the packet is discarded as an **RPF failure**.

```
   source S ─────► R1 ─────► R2 ─────► receiver
                     └──────► R3 ──────┘
   If R2 receives S's traffic from R3, but its unicast route to S points at R1,
   the packet FAILS RPF and is silently dropped.
```

RPF failures are the classic multicast-specific outage, and they are triggered by things that look unrelated to multicast: **asymmetric routing**, a unicast route change, ECMP over multiple paths, or a policy route. The signature is precise — **unicast to the source works perfectly, and multicast does not arrive** — and the diagnostic is on the router: `show ip mroute` shows the `(S,G)` entry with an incoming interface, `show ip rpf <source>` tells you which interface RPF expects, and mismatch is the answer.

### The full failure catalogue and signatures

| Failure | Signature | Where to look |
|---|---|---|
| **RPF failure** | Unicast to source fine, no multicast; RPF drop counters increment | `show ip rpf`, `show ip mroute` |
| **No RP / wrong RP (ASM)** | `(*,G)` join goes nowhere; `show ip pim rp mapping` empty or inconsistent | Router |
| **TTL too low** | Works on-LAN, dies at the first router; `IP_MULTICAST_TTL` left at 1 | Sender socket options |
| **TTL threshold on a router interface** | Works to some hops, not further; the interface has a configured multicast TTL threshold | Router interface config |
| **No querier** (§37.9) | Works for ~4 minutes then stops | `tcpdump igmp` on the host |
| **Snooping without mrouter port** | Joins never reach the router | Switch |
| **Wrong egress/ingress interface** | Multi-homed host joined on the wrong NIC | `ip maddr show`, `netstat -gn` |
| **Firewall dropping IGMP or protocol 2** | Join sent, never acted on | `iptables -L -n -v`, host firewall |
| **Socket receive buffer overflow** | Bursts lost, steady state fine; `netstat -s` "receive buffer errors" climbs | `SO_RCVBUF`, `net.core.rmem_max` |
| **NIC ring overflow** | `ethtool -S` `rx_missed_errors` / `rx_no_buffer_count` climb | Ring size, IRQ affinity (Ch. 46) |
| **Rogue sender to the same ASM group** | Sequence-number chaos, unparseable messages | Move to SSM |
| **Duplicate delivery** | Every message twice — usually two paths or `IP_MULTICAST_LOOP` | Topology, socket options |

### The receive-buffer overflow deserves emphasis

The most common *host-side* multicast loss is not a network problem at all: the socket receive buffer fills because the application did not drain it fast enough during a burst. Multicast senders do not slow down for you — there is no flow control — so a 200 µs GC pause, page fault, or scheduler preemption during a microburst loses packets.

```
sysctl -w net.core.rmem_max=33554432
setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &sz, sizeof sz);   // request; kernel doubles it
netstat -su | grep -i "receive buffer errors"            # THE counter to watch
```
The buffer must be sized to absorb the worst microburst (Ch. 39 §39.5) over the worst scheduling delay: `bytes = peak_rate × max_stall`. At 1 Gbit/s of feed and a 10 ms worst-case stall, that is 1.25 MB — far above the default 208 KB. This calculation is a strong, concrete interview answer.

### A disciplined diagnostic order

1. `netstat -su` / `ethtool -S` — is the host dropping? (Fix locally; stop blaming the network.)
2. `ip maddr show` / `netstat -gn` — did the join actually happen, on the right interface?
3. `tcpdump -i ethX -n 'host <group>'` — is the traffic on the wire at all?
4. `tcpdump -i ethX igmp` — are queries arriving every ~125 s?
5. Switch: snooping groups, querier, mrouter port.
6. Router: `show ip mroute`, `show ip rpf <source>`.

Working bottom-up from the host is right because the host is the most common culprit and the cheapest to check.

---

## 37.11 Reliable Multicast Patterns

"Reliable multicast" means adding delivery guarantees on top of an unreliable one-to-many transport. The fundamental obstacle is **ACK implosion**: if every one of N receivers acknowledges every message, the sender's inbound link and CPU scale with N, destroying the very property that made multicast attractive.

### The design axis: ACK vs NAK

| | ACK-based | **NAK-based** |
|---|---|---|
| Receiver sends | Confirmation of every message | Only a request for what is **missing** |
| Traffic in the healthy case | O(N) per message | **Zero** |
| Traffic under loss | O(N) | O(losses) |
| Sender state | Per-receiver windows | Retention buffer only |
| Scales to thousands of receivers | No | Yes |

**All practical reliable multicast is NAK-based**, precisely because the healthy case must cost nothing. The sender retains recently sent messages in a buffer and replies to NAKs; receivers detect loss from sequence gaps (§37.4).

### NAK suppression

If 500 receivers all miss the same packet (a switch dropped it on a shared segment), 500 simultaneous NAKs is a second implosion. The standard mitigations:

- **Random backoff** before sending a NAK (a few milliseconds, scaled to the group size).
- **Multicast the NAK** to the group, so other receivers see it and suppress their own.
- **Multicast the repair**, so one retransmission serves everyone who lost it.

These three together are the core of SRM (Scalable Reliable Multicast) and appear, in various forms, in PGM and in exchange retransmission designs.

### The named protocols

| Protocol | Mechanism | Where seen |
|---|---|---|
| **PGM** (Pragmatic General Multicast, RFC 3208) | NAK-based, router-assisted NAK suppression and repair, sender-side windows | 29West/LBM, TIBCO RV, some internal distribution |
| **NORM** (RFC 5740) | NAK-oriented with optional FEC | Standards-track, less common in finance |
| **SRM** | Randomized NAK + repair suppression | Research lineage; ideas reused everywhere |
| **MoldUDP64** | Sequenced datagrams + **separate unicast retransmit service** | NASDAQ ITCH distribution — the dominant pattern in equities |
| **Vendor middleware** (LBM/UM, TIBCO FTL, Solace) | NAK + retention + optional persistence | In-house distribution inside firms |

### The exchange pattern, explicitly

Exchanges do **not** run a general-purpose reliable multicast protocol on the primary feed. They do something simpler and more predictable:

```
  ┌──────────────────────────────────────────────────────────────┐
  │ A-feed  (UDP multicast, group A)  ── sequenced, never repeated │
  │ B-feed  (UDP multicast, group B)  ── identical, disjoint path  │  ← §37.14
  │ Snapshot feed (UDP multicast)     ── periodic full state       │  ← §37.13
  │ Retransmit service (TCP unicast)  ── request by sequence range │  ← §37.12
  └──────────────────────────────────────────────────────────────┘
```
The primary feed stays absolutely simple — fire and forget, no feedback, no per-receiver state, deterministic pacing — and *all* the reliability machinery is moved to side channels that only degraded receivers touch. This separation is the key architectural insight, and it is what a good answer to "how do you make multicast reliable for market data?" should describe: **you don't make the multicast reliable; you make loss recoverable out-of-band and make the common case free.**

### FEC as the alternative

Forward error correction sends `n` packets carrying `k` packets' worth of data (Reed–Solomon or an XOR-based scheme); any `k` of `n` reconstruct. Properties:

- **No feedback channel**, so it scales perfectly and has bounded recovery latency.
- Costs `(n−k)/k` extra bandwidth **all the time**, even when nothing is lost.
- Adds **decode latency and buffering** — you must wait for enough packets to arrive before you can reconstruct, which directly opposes the low-latency goal.

That last point is why FEC is rare on equity market data and common in video and in satellite/wireless links: when the alternative to buffering is a round-trip you cannot afford, FEC wins; when a redundant second feed is available for free, arbitration wins.

---

## 37.12 Retransmission Channels

A **retransmission (or "recovery") channel** is a separate, usually unicast, service from which a receiver requests specific missed sequence numbers.

### Shape of the service

| Property | Typical value / choice |
|---|---|
| Transport | **TCP unicast** (reliability matters more than latency here), sometimes UDP unicast |
| Request | "Send me sequences 10 043 – 10 057 on channel X" |
| Response | The original messages, replayed verbatim, on the unicast channel |
| Retention window | Seconds to minutes, or a fixed message count (often 10 000 – 1 000 000) |
| Rate limits | Requests per second, messages per request, requests per day — **strictly enforced** |
| Latency | **1–50 ms** — orders of magnitude above the primary feed |

Two design points follow immediately. First, **retransmission is a slow path by construction** — a round trip plus server-side lookup. Nothing on the hot path may block on it. Second, **the retention window bounds recoverability**: if your gap is older than the window, the retransmit server cannot help and you must re-snapshot (§37.13).

### Client-side rules

1. **Never request on first detection.** Wait a gap timer (§37.4) — the packet may be reordered, and the B feed may deliver it (§37.14). Requesting instantly is how a transient blip becomes a request storm.
2. **Coalesce.** Request ranges, not individual sequences; batch multiple small gaps into one request where the protocol allows.
3. **Respect the rate limit.** Exceeding it typically results in the exchange disabling your recovery access — turning a recoverable gap into a mandatory restart. Implement a token bucket and treat exhaustion as an alarm.
4. **Bound the attempt.** After k failures or t milliseconds, escalate to snapshot recovery. An unbounded retry loop is how a feed handler hangs for an entire session.
5. **Do the work off the hot path.** The recovery request, the TCP socket, and the response parsing belong on a separate thread and a separate core from the primary feed loop (Ch. 52 §52.7). The primary loop must keep draining the socket during recovery or you will lose *more* packets and cascade.
6. **Merge correctly.** Recovered messages must be inserted into the reorder buffer and applied in sequence order, and duplicates (the same message arriving from both the B feed and the retransmit) must be idempotently discarded.

### The cascade failure

The failure mode interviewers look for: a network event causes widespread loss, thousands of subscribers simultaneously request retransmission, the retransmit server saturates, responses are slow, receivers time out and retry, and the resulting load prevents anyone from recovering. This is a **congestion collapse in the recovery channel**, and the defences are exactly the ones that fix any thundering herd:

- Randomized backoff before the first request.
- Exponential backoff between retries, with a cap.
- Client-side rate limiting independent of the server's.
- Prefer arbitration (free) then snapshot (bounded, multicast, serves everyone at once) over unicast retransmission (O(N) load on one server).

Note that the snapshot feed is the natural pressure valve precisely because it is *multicast*: one transmission recovers every degraded receiver.

### The mid-session-start case

A process starting at 10:30 has no history and a gap of millions of messages. Retransmission is the wrong tool (the window is far too small); the correct sequence is **join the incremental feed and start buffering, then join the snapshot feed, then apply the snapshot and replay the buffered incrementals from the snapshot's sequence number forward**. Order matters: joining incrementals *first* is essential, because otherwise messages published between the snapshot and your join are lost forever (Ch. 53 §53.3).

---

## 37.13 Snapshot Recovery

A **snapshot** is a complete statement of current state — the full order book for each instrument — from which a receiver can resume without any prior history. **Incrementals** (deltas) are the stream of changes. Snapshot + incremental is the standard market-data architecture.

### The recovery algorithm

```
 1. JOIN the incremental feed first.  Buffer everything; apply nothing.
 2. JOIN the snapshot feed.
 3. Receive a complete snapshot for the instrument; note its
    "last included sequence number" L.
 4. DISCARD buffered incrementals with seq <= L.
 5. APPLY buffered incrementals from L+1 onward, in order.
 6. If a gap exists between L+1 and the oldest buffered message,
    the snapshot is too old → wait for the next snapshot cycle.
 7. Once caught up, LEAVE the snapshot feed and continue on incrementals.
```

**Step 1 before step 2 is the non-negotiable ordering**, and it is the single most-tested detail in this topic. If you join the snapshot first and the incrementals second, messages published in the interval between the snapshot's cut and your incremental join are lost with no way to detect it — you get a silently wrong book, the worst possible outcome.

### Snapshot delivery mechanisms

| Mechanism | Latency to recover | Notes |
|---|---|---|
| **Periodic multicast snapshot feed** | Up to one cycle (1–30 s, instrument-count dependent) | CME MDP: a continuously recycling snapshot channel. Scales to any number of recovering clients |
| **On-demand TCP snapshot/replay** | 100 ms – seconds | NASDAQ GLIMPSE: connect, authenticate, receive a point-in-time book plus the sequence number to resume from |
| **Start-of-day file** | Minutes | Reference/opening state, not intraday recovery |

The multicast snapshot cycles through all instruments, so **recovery latency is proportional to the number of instruments in the cycle** — a venue with 10 000 symbols may take 30 s to cycle. During that time the affected instruments are stale and must not be traded (Ch. 53 §53.8).

### Design consequences

- **Snapshots are large.** A full book for a liquid instrument is kilobytes; the whole universe is megabytes per cycle, which is why the snapshot feed is on its own group (so healthy receivers are not forced to receive it) and why joining it during recovery adds a bandwidth burst exactly when you are already struggling.
- **The snapshot must be internally consistent** — a coherent point in time, not a smear across updates. Protocols carry the sequence number the snapshot is valid as of, which is what makes step 3–5 well defined.
- **Per-instrument recovery is far better than whole-feed recovery.** A gap usually affects a bounded set of instruments; resetting the entire book universe converts a small problem into a total outage. Feeds that let you recover one instrument (or one channel) at a time keep the blast radius small.
- **Book building is idempotent under this scheme**, which is what makes it safe: applying a snapshot replaces state rather than mutating it, so a duplicate snapshot is harmless.

### Failure modes

| Failure | Signature |
|---|---|
| Snapshot applied without buffering incrementals | Book quietly missing all updates from the gap window; detected only by cross-checking against another source |
| Snapshot older than the buffered incrementals | An unfillable hole; must wait for the next cycle, or restart |
| Never leaving the snapshot feed | Permanent extra bandwidth and CPU; snapshot bursts jitter the incremental path |
| Recovering all instruments on any gap | Multi-second outage from a one-message loss |
| No staleness marking during recovery | **Trading on a known-wrong book** — the outcome every control in Ch. 56 exists to prevent |

**Interview framing:** *"Walk me through recovering a feed handler that started mid-session."* The expected answer is the seven-step algorithm above with the join ordering stated explicitly, the staleness flag raised throughout, and the per-instrument granularity noted.

---

## 37.14 Redundant Multicast Feeds

Exchanges publish **two identical copies** of each market-data stream — conventionally the **A feed** and **B feed** — over physically and logically disjoint paths: separate multicast groups, separate VLANs, separate switches, separate NICs on your side, and ideally separate cross-connects into the venue.

```
                    ┌── switch A ── NIC A ──┐
   exchange ────────┤                        ├──► arbitrator ──► book builder
   publisher        └── switch B ── NIC B ──┘
                     identical messages, identical sequence numbers,
                     independent loss and independent jitter
```

### Why this is the primary recovery mechanism

Loss events are usually **local and uncorrelated**: a queue overflow on one switch, a microburst on one port, a bad optic, a dropped frame in one NIC ring. A packet lost on A is overwhelmingly likely to arrive on B. Arbitration therefore recovers most losses at **zero added latency and zero request traffic** — strictly better than retransmission (milliseconds) or snapshots (seconds). Correlated losses (the publisher itself dropped a message, or a shared upstream link failed) defeat it, which is why the slower mechanisms still exist.

There is a second, less-obvious benefit: **jitter reduction**. Even with no loss, the two feeds arrive at slightly different times because the paths differ. Taking the first arrival of each sequence number gives you `min(t_A, t_B)` per message, which reduces both mean and tail latency. Measured improvements of a few microseconds at the 99th percentile are typical, and this "first-of-two" effect is a good detail to raise.

### The arbitrator

The arbitration logic is deliberately trivial, because it is on the hot path:

```cpp
// One line of real logic; everything else is bookkeeping.
if (seq == expected)      { publish(msg); ++expected; drain_buffer(); }
else if (seq <  expected) { ++dup_count; }                 // already had it
else                      { buffer(seq, msg); start_gap_timer(); }
```
Both feeds funnel into the same state machine (§37.4); whichever copy arrives first wins, and the second is discarded as a duplicate. Requirements and pitfalls:

- **Sequence numbers must be identical across A and B.** If the exchange sequences the two feeds independently, arbitration is impossible — verify this per venue.
- **Duplicate suppression must be exact**, not heuristic. Deduplicating by payload hash instead of sequence is slower and can wrongly suppress legitimately identical messages.
- **Both feeds must be drained continuously**, even when one is "ahead." Letting the B socket fill because A is currently winning destroys B's value at precisely the moment you need it — this is a real and common implementation bug.
- **Do not run the two receive paths on one core.** Separate NICs, separate RSS queues, separate isolated cores (Ch. 31 §31.19), so a stall on one path cannot stall the other. Sharing a core reintroduces the correlation the whole design exists to remove.
- **Independence must be verified, not assumed.** If A and B traverse the same switch, the same LAG member, or the same NIC, they share a failure domain and the redundancy is decorative. This is worth auditing physically.

### Monitoring

Per-feed, continuously: packets received, gaps, **which feed won each message** (the "A-win/B-win ratio"), and the inter-feed arrival delta distribution. These metrics are how you detect degradation *before* it causes loss:

| Observation | Meaning |
|---|---|
| A wins ~100 % of the time | B is systematically slower — a path or configuration asymmetry; B provides much less protection than you think |
| B-win share rising | A's path is degrading |
| Both feeds gap on the same sequences | Correlated loss — upstream of the split, or the publisher itself; escalate to retransmit/snapshot |
| Inter-feed delta widening | Growing queueing on one path (microbursts, Ch. 39 §39.5) |
| One feed silent | Join lost, querier problem (§37.9), or link down — alarm immediately, do not wait for a gap |

That last point matters: a dead B feed is invisible in normal operation because A is delivering everything. **Redundancy that is not monitored has already failed silently.** Some firms deliberately verify by periodically checking that B alone could have built the book.

### Beyond A/B

Larger firms take the same feed from multiple physical locations or multiple vendors and arbitrate across all of them, and some run three or more paths. The arbitration logic does not change — it is still first-arrival-wins by sequence number — but the failure-domain analysis and the monitoring burden grow. Ch. 53 §53.6 covers the deterministic merge rules that make multi-feed arbitration reproducible for replay.

---

## Key Interview Questions

1. **Why is market data delivered over UDP multicast rather than TCP?** — Fairness (network replicates, so all subscribers are served simultaneously rather than serialized), no head-of-line blocking on loss, no per-subscriber state at the publisher, deterministic sender pacing, and a bypass-friendly receive path.
2. **What does UDP add over raw IP?** — Ports and an optional checksum. Nothing else: no ordering, no retransmission, no flow control, no congestion control.
3. **What is the maximum UDP payload that avoids fragmentation on standard Ethernet?** — 1472 bytes (1500 − 20 IP − 8 UDP); 8972 with a 9000 MTU; 65507 theoretical.
4. **How does a receiver detect loss on a UDP feed?** — Application-level sequence numbers: `s > expected` is a gap, `s < expected` a duplicate. Note the MoldUDP-style arithmetic where the packet header carries the first message's sequence plus a message count.
5. **Why not request a retransmit the instant you see a gap?** — Reordering is indistinguishable from loss at that moment, and the B feed will usually deliver the packet. A short gap timer avoids spurious requests and prevents request storms during network stress.
6. **Why do 32 multicast groups collide on one Ethernet MAC?** — Only the low 23 bits of the 28-bit group address map into `01:00:5e`; the NIC filter is therefore imprecise and the stack must also filter on destination IP.
7. **What is SSM and why does it matter for market data?** — Subscription to `(source, group)` rather than `(*, group)`: eliminates address collisions and rogue senders, needs no rendezvous point, and joins on a shortest-path tree. Requires IGMPv3; makes the exchange's source IP part of your configuration.
8. **A multicast feed works for four minutes after startup then stops. Diagnose.** — IGMP snooping enabled with no querier on the L2 VLAN: entries age out after the ~260 s group-membership interval. Confirm by looking for periodic General Queries in `tcpdump -i ethX igmp`; fix by enabling the switch's snooping querier.
9. **Unicast to the multicast source works, multicast does not arrive. Diagnose.** — RPF failure: the multicast arrives on an interface other than the one the router's unicast route to the source uses, usually caused by asymmetric routing or an ECMP/route change. `show ip rpf <source>` and `show ip mroute`.
10. **What is ACK implosion and how is reliable multicast designed around it?** — N receivers acknowledging every message scales the sender's inbound load with N. Practical schemes are NAK-based (traffic only on loss), with randomized backoff, multicast NAKs for suppression, and multicast repairs.
11. **Describe the exchange's full reliability architecture.** — Simple fire-and-forget sequenced multicast, plus a redundant B feed for free arbitration, plus a periodic multicast snapshot feed, plus a rate-limited unicast retransmit service. All reliability is out-of-band; the primary feed stays stateless.
12. **What is the correct order of operations when recovering via snapshot?** — Join incrementals and buffer first, then join the snapshot, then discard buffered messages at or below the snapshot's sequence, then replay the rest. Reversing the order silently loses the messages published in between.
13. **Why is A/B arbitration preferred over retransmission?** — It recovers uncorrelated loss at zero latency and zero request traffic, and taking `min(t_A, t_B)` also reduces jitter and tail latency. Retransmission costs a millisecond-scale round trip and loads a shared server.
14. **What is the most common implementation bug in A/B arbitration?** — Not draining the "losing" feed's socket continuously, so B's buffer overflows and it cannot cover for A when needed. Also: sharing a core between the two paths, which reintroduces correlated stalls.
15. **How do you size a multicast receive buffer?** — `peak_rate × worst_case_application_stall`. At 1 Gbit/s and a 10 ms stall that is 1.25 MB, far above the default. Monitor `netstat -su` "receive buffer errors."
16. **Where can multicast packets be dropped, and which counter shows each?** — Switch (port/queue counters), NIC ring (`ethtool -S`: `rx_missed_errors`, `rx_no_buffer_count`), socket buffer (`netstat -su` receive buffer errors), application (its own gap counter). Diagnose bottom-up from the host.
17. **What happens if you join more multicast groups than the NIC's filter table holds?** — The driver falls back to a hash filter and eventually to all-multicast/promiscuous, DMAing every multicast frame on the segment and discarding it in software — CPU burn and jitter. `ip link show` reveals `ALLMULTI`.
18. **Why must a feed handler mark data stale rather than continuing across a gap?** — Continuing applies deltas to a book known to be wrong, producing confidently incorrect prices. The correct behaviour is to flag staleness and let the risk layer refuse to quote.
19. **What is the default multicast TTL and why does it matter?** — 1. The feed works on the local switch and dies silently at the first router; the classic first-deployment multicast bug.
20. **Why does `tcpdump` report bad UDP checksums on packets you send?** — Checksum offload: the NIC computes them after the capture point. On a kernel-bypass path you must supply them yourself.

---

## Common Traps

- **Assuming UDP delivers in order or at all** — everything above the socket must be written for loss, reordering, and duplication.
- **A receive buffer smaller than the datagram** — the remainder is silently discarded; use `recvmsg` and check `MSG_TRUNC`.
- **Treating `recvfrom` returning 0 as EOF** — a zero-length UDP datagram is legal and distinct from a closed connection.
- **Default `IP_MULTICAST_TTL` of 1** — works on the local switch, dies at the first router.
- **Not setting `IP_MULTICAST_IF` on a multi-homed host** — joins and sends go out the management NIC.
- **Leaving `IP_MULTICAST_LOOP` on** — the sender receives its own traffic and reports mystery duplicates.
- **Filtering only on MAC in a bypass stack** — the 32:1 group collision admits other feeds; you must check destination IP.
- **Joining more groups than the NIC filter supports** — silent fallback to all-multicast and a large, unexplained CPU cost.
- **IGMP snooping with no querier on an L2-only VLAN** — the feed dies after ~4 minutes.
- **Fast-leave on a port with multiple receivers** — one host leaving cuts off the others.
- **Requesting a retransmit on first gap detection** — turns reordering into a request storm exactly when the network is stressed.
- **Unbounded retransmit retries** — a feed handler that hangs all session instead of escalating to snapshot recovery.
- **Ignoring the exchange's retransmit rate limit** — access is revoked and a recoverable gap becomes a restart.
- **Joining the snapshot feed before the incremental feed** — silently loses everything published in between; a permanently wrong book.
- **Recovering all instruments on any gap** — converts a one-message loss into a multi-second outage.
- **Continuing to apply deltas across a known gap** — a confidently wrong book, the worst failure mode in market data.
- **Not draining the second feed while the first is winning** — B overflows and provides no protection when A finally drops.
- **Running both feeds on one core, one NIC, or one switch** — the failure domains are shared and the redundancy is decorative.
- **Never monitoring the B feed's win rate** — a dead redundant feed is invisible until the day you need it.
- **Ignoring the session/stream identifier in sequence tracking** — a session reset looks like a catastrophic backwards jump.
- **32-bit sequence comparison without wrap-safe arithmetic** — false gaps or false duplicates at wrap.
- **Trusting the UDP checksum for message integrity** — 16-bit one's-complement is blind to word reordering and compensating errors; use the protocol's own CRC and sequence numbers.

---

## Compact Recall Summary

**UDP.** Ports plus an optional checksum over IP; 8-byte header (src port, dst port, length including header, checksum). Preserves message boundaries — one `sendto` is one datagram, and an undersized receive buffer silently truncates. No ordering, no retransmission, no flow or congestion control, and therefore no head-of-line blocking. Max payload 1472 at MTU 1500, 8972 jumbo. `connect()` on a UDP socket buys a cheaper send path, peer filtering, and ICMP error delivery.

**Checksums.** Pseudo-header (src IP, dst IP, proto 17, UDP length) + header + payload; optional in IPv4 (0 = none, and a computed zero is sent as `0xFFFF`), mandatory in IPv6. Weak by design; offload makes sender-side captures show "bad" checksums, and bypass stacks must compute or request them explicitly.

**Loss handling.** Reliability moves into the application: sequence numbers, gap detection (`s > expected` = gap, `s < expected` = duplicate), a short gap timer so reordering is not mistaken for loss, a bounded preallocated reorder buffer, and wrap-safe sequence comparison. Watch MoldUDP-style arithmetic: `next = seq + message_count`. Key by `(session, channel)` so a session reset is not read as a giant backwards jump. **A gap must never silently yield a wrong book** — mark stale and let risk decide.

**Multicast.** `224.0.0.0/4`; `224.0.0.0/24` link-local TTL 1, `232/8` SSM, `233/8` GLOP, `239/8` scoped. Network replicates, so all subscribers are served simultaneously — the fairness property regulators care about. MAC mapping `01:00:5e` + low 23 bits ⇒ **32 groups per MAC**, so IP-level filtering is mandatory. Socket essentials: `IP_MULTICAST_TTL` (defaults to 1!), `IP_MULTICAST_IF`, `IP_MULTICAST_LOOP`, `IP_ADD_MEMBERSHIP` / `MCAST_JOIN_SOURCE_GROUP`.

**IGMP.** v2 adds Leave, v3 adds source lists and removes report suppression. Query every 125 s, max response 10 s, robustness 2 ⇒ **~260 s group membership interval**. Joins send unsolicited reports immediately, so join latency is sub-millisecond — but join at startup and never leave mid-session.

**SSM.** `(S,G)` channels on `232/8` with IGMPv3: no address collisions, no rogue senders, no rendezvous point, direct shortest-path tree. Cost: the source IP becomes configuration, and a venue's publisher migration breaks every subscriber that did not update it.

**NIC filtering.** Exact table → hash filter → all-multicast, escalating silently as group count grows. `ip link show` showing `ALLMULTI` plus inflated `rx_multicast_packets` is the signature. The fix is hardware n-tuple flow steering (`ethtool -N`) to per-queue, per-core isolation.

**Snooping and queriers.** Without snooping, multicast floods the VLAN. With snooping and **no querier**, entries age out and the feed dies after ~4 minutes — the single most common multicast failure. Look for General Queries every ~125 s in `tcpdump igmp`.

**Routing failures.** PIM builds trees using the unicast table, so **RPF** (packet must arrive on the interface unicast would use back to the source) fails whenever routing is asymmetric — signature: unicast to the source works, multicast does not arrive. Other causes: TTL 1, no RP under ASM, wrong interface joined, firewall dropping protocol 2, and — most often — host-side socket receive buffer overflow (`netstat -su`), sized as `peak_rate × worst_stall`.

**Reliable multicast.** ACK-based schemes implode at O(N); everything practical is NAK-based with randomized backoff, multicast NAKs for suppression, and multicast repairs (PGM, NORM, SRM, LBM). FEC trades constant bandwidth and decode buffering for no feedback channel — usually the wrong trade in equities.

**The exchange architecture.** Keep the primary feed stateless and fire-and-forget; move all reliability out-of-band: **A/B arbitration (free, zero latency, also cuts jitter via first-of-two) → unicast retransmit (1–50 ms, rate-limited, bounded retention) → multicast snapshot (seconds, serves all recovering receivers at once) → restart.** Snapshot recovery order is non-negotiable: **join incrementals and buffer first, then snapshot, then discard ≤ L and replay.** Arbitrate by sequence with exact duplicate suppression, drain both feeds always, keep the paths on separate NICs, cores, and switches, and monitor the A/B win ratio — unmonitored redundancy has already failed silently.
