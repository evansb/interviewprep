# Chapter 36 — Ethernet and IP

*Interview-focused revision notes. The theme: every byte a trading system sends crosses a layered stack of headers, and each layer imposes a fixed, countable cost in bytes, nanoseconds, and failure modes — this chapter is the byte-level and nanosecond-level accounting of layers 2 and 3.*

---

## 36.1 OSI and TCP/IP Models

A **layering model** is a decomposition of network functionality into levels where each level offers a service to the one above and consumes the service of the one below. The point is not taxonomy; it is that each layer contributes a header, a processing step, and a failure mode you can name independently.

The **OSI seven-layer model** (ISO, 1984) is the vocabulary; the **TCP/IP four-layer model** (RFC 1122) is what actually exists in the code.

| OSI | Name | TCP/IP | Unit ("PDU") | Concrete example | Addressing |
|---|---|---|---|---|---|
| 7 | Application | Application | Message | ITCH, FIX, HTTP | URI / symbol |
| 6 | Presentation | Application | — | TLS, SBE encoding | — |
| 5 | Session | Application | — | FIX session layer (Ch. 51 §51.1) | Session ID |
| 4 | Transport | Transport | Segment (TCP) / Datagram (UDP) | TCP, UDP | Port (16-bit) |
| 3 | Network | Internet | Packet | IPv4, IPv6, ICMP | IP address |
| 2 | Data link | Link | Frame | Ethernet, 802.1Q | MAC (48-bit) |
| 1 | Physical | Link | Symbol / bit | 10GBASE-SR, SFP+, twinax | — |

Layers 5 and 6 have no separate implementation in the TCP/IP world — they collapse into the application. Interviewers use "what layer is TLS at?" as a probe: the honest answer is that TLS sits between 4 and 7, is usually called layer 6 in OSI terms, and does not exist as a distinct layer in TCP/IP at all.

### Why the model matters operationally

Each layer defines a **demultiplexing key**, and knowing the key tells you which device drops your packet and why:

```
Ethernet:  destination MAC + EtherType  → which host, which L3 protocol
IPv4:      destination IP + Protocol    → which host, which L4 protocol
UDP/TCP:   destination port             → which socket
```

A failure at each layer has a distinct signature. Wrong MAC → the switch floods or discards; the NIC's `rx_dropped`/filter counters move. Wrong IP → the router drops and may emit ICMP; `netstat -s` shows `InAddrErrors`. Wrong port → the host emits ICMP port unreachable (UDP) or RST (TCP); `netstat -s` shows `NoPorts`. A candidate who can map symptom → layer → counter is demonstrating exactly the skill the question is testing.

### The latency view of the model

Layering is not free. Each layer costs header bytes on the wire (serialization delay, §36.4) and CPU cycles in the stack. For a 64-byte market-data update:

| Layer | Header bytes | Kernel cost on receive (rough) |
|---|---|---|
| Ethernet | 14 (+4 VLAN) | NIC DMA + driver, ~1–2 µs to `napi_gro_receive` |
| IPv4 | 20 | route/validate, ~200 ns |
| UDP | 8 | checksum + socket lookup, ~300 ns |
| Application | payload | copy to user, ~500 ns + syscall |

Total kernel-path NIC-to-application latency on a tuned Linux box is roughly **2–5 µs**; kernel bypass (Ch. 47 §47.1) removes the socket, protocol, and copy costs and lands at **~1 µs or below**, and an FPGA parsing the frame in flight (Ch. 48 §48.1) reaches **~100 ns wire-to-decision**. The layering model is the map of what bypass removes.

**Interview framing:** *"Why does anyone still teach OSI when nothing implements it?"* — because it is the shared vocabulary for locating a fault, and because the demultiplexing-key-per-layer structure is real even where the layer boundary is not.

---

## 36.2 Encapsulation and Protocol Headers

**Encapsulation** is the process by which each layer prepends (and occasionally appends) its own header to the payload handed down from above, treating that payload as opaque. **Decapsulation** is the reverse on receive.

```
                 ┌──────────────────────────────────────────┐
 Application     │            ITCH message  (50 B)          │
                 └──────────────────────────────────────────┘
                 ┌────────┬─────────────────────────────────┐
 Transport (UDP) │ UDP 8B │            50 B                 │
                 └────────┴─────────────────────────────────┘
                 ┌────────┬────────┬────────────────────────┐
 Network (IPv4)  │ IP 20B │ UDP 8B │            50 B        │
                 └────────┴────────┴────────────────────────┘
        ┌────────┬────────┬────────┬────────────────────┬───┐
 Link   │ Eth 14B│ IP 20B │ UDP 8B │        50 B        │FCS│
        └────────┴────────┴────────┴────────────────────┴───┘
   ┌────┬─────────────────────────────────────────────────┬──────┐
 Wire│Pre │              frame: 14+20+8+50+4 = 96 B        │ IPG  │
   └────┴─────────────────────────────────────────────────┴──────┘
     8B                                                     12B
```

The **frame** is what the FCS covers: destination MAC through payload. The **preamble** (7 bytes of `0xAA` plus a 1-byte start-frame delimiter `0xAB`) and the **inter-packet gap** (12 byte-times) are on the wire but not in the frame and not captured by `tcpdump`. Forgetting them is the single most common error when computing packets-per-second limits (§36.4, Ch. 48 §48.14).

### Header overhead accounting

For a small market-data message the headers dominate:

| Payload | Eth+IP+UDP headers | FCS+preamble+IPG | Wire bytes | Efficiency |
|---|---|---|---|---|
| 1 B | 42 | 24 | 84 (padded to 64-byte min frame) | 1.2 % |
| 50 B | 42 | 24 | 116 | 43 % |
| 200 B | 42 | 24 | 266 | 75 % |
| 1472 B | 42 | 24 | 1538 | 96 % |
| 8972 B (jumbo) | 42 | 24 | 9038 | 99 % |

This table is the quantitative reason exchanges pack many small updates into one datagram, and the reason a naive one-message-per-packet feed burns three times the bandwidth for the same information.

### Structural consequences

- **Headers are prepended, so a zero-copy stack must reserve headroom.** Linux `sk_buff` allocates `NET_SKB_PAD` (typically 64 bytes) in front of the data so that TX headers can be written without a copy; DPDK mbufs have the same `headroom` concept. Getting headroom wrong is the classic reason a user-space stack copies when it claimed not to.
- **Decapsulation is a chain of bounds checks.** Every real vulnerability in packet parsing is a missing length validation before indexing into the next header (Ch. 51 §51.12). Parse defensively: validate that `frame_len >= 14`, then that IHL is in range and `frame_len >= 14 + ihl*4`, then that the UDP length fits, *before* touching any field.
- **Tunneling** is encapsulation applied recursively — VXLAN puts an Ethernet frame inside UDP inside IP inside Ethernet, adding 50 bytes and reducing the effective MTU. Every tunnel is a latency and MTU tax; trading networks avoid them entirely on the market-data path.

**In C++ terms**, a header is exactly the ABI-safe wire layout problem of Ch. 3 §3.12: fixed-width types, explicit byte order, no bit-fields, and a `static_assert` wall on `sizeof` and `offsetof`.

---

## 36.3 Ethernet Frames

An **Ethernet frame** is the layer-2 PDU. The modern format (DIX / Ethernet II, which is what essentially all IP traffic uses) is:

```
 bytes:  0        6        12   14                        n      n+4
        ┌────────┬────────┬────┬─────────────────────────┬──────┐
        │ Dest   │ Source │Type│         Payload         │ FCS  │
        │  MAC   │  MAC   │ /  │      46 .. 1500 B       │CRC32 │
        │  6 B   │  6 B   │Len │                         │ 4 B  │
        └────────┴────────┴────┴─────────────────────────┴──────┘
                            2B
```

- **Destination MAC (6 B)** — first on the wire *by design*: a switch can start its forwarding lookup after receiving only 6 bytes, which is what makes cut-through switching possible (Ch. 39 §39.2).
- **Source MAC (6 B)** — what switches learn from to build their forwarding table.
- **EtherType / Length (2 B)** — values ≥ `0x0600` (1536) are an **EtherType** identifying the layer-3 protocol; values ≤ 1500 are an 802.3 **length** field. The disambiguation is by magnitude, which is why the max payload is 1500 and not 1535.

| EtherType | Protocol |
|---|---|
| `0x0800` | IPv4 |
| `0x0806` | ARP |
| `0x86DD` | IPv6 |
| `0x8100` | 802.1Q VLAN tag (§36.7) |
| `0x88A8` | 802.1ad QinQ outer tag |
| `0x88F7` | PTP over Ethernet (Ch. 35 §35.7) |
| `0x8847` | MPLS unicast |

- **Payload (46–1500 B)** — the 46-byte minimum enforces a 64-byte minimum frame (6+6+2+46+4). This minimum exists because of half-duplex CSMA/CD collision detection: the frame had to be long enough that a collision on a maximum-diameter segment reached the sender before it finished transmitting. Half duplex is extinct; the 64-byte minimum is not, so **short payloads are padded with zeros** and you pay for 64 bytes whether you use them or not.
- **FCS (4 B)** — CRC-32 over destination MAC through payload. A frame failing FCS is dropped silently by the NIC and counted in `rx_crc_errors` (`ethtool -S`). The FCS is normally stripped by the NIC before DMA, so `tcpdump` does not show it.

### The minimum-frame trap in trading

A 1-byte heartbeat and a 46-byte payload cost exactly the same on the wire. Conversely, a 47-byte payload costs one more 64-byte-equivalent slot than a 46-byte one at the framing level but nothing extra structurally — the real cliff is at 1500 (fragmentation, §36.14). For packets-per-second-limited paths, the shape of the cost curve is: flat to 46 bytes of payload, linear to 1500, then a hard discontinuity.

### 802.3 with LLC/SNAP

The legacy alternative encodes a length in the type field and follows it with an 802.2 LLC header (DSAP/SSAP/Control, 3 B) and optionally a SNAP header (5 B) carrying the real EtherType. This costs 8 payload bytes and survives only in STP BPDUs and some industrial protocols. If you see `LLC` in a capture on a trading VLAN, something is misconfigured.

### Frame vs packet vs datagram vs segment

| Term | Layer | Precise meaning |
|---|---|---|
| **Frame** | 2 | Ethernet header + payload + FCS |
| **Packet** | 3 | IP header + payload (colloquially: any PDU) |
| **Datagram** | 3 or 4 | A self-contained, independently-routed unit; used for IP and for UDP |
| **Segment** | 4 | A TCP PDU — a slice of a byte stream, not a message |
| **MTU/MSS** | 3 / 4 | Max payload of a frame / max TCP payload of a segment (§36.8) |

Using these precisely is a cheap signal of competence; using "packet" for everything is the default and is not penalized, but being able to say "a TCP *segment* is not a message" when discussing framing (Ch. 38 §38.20) is.

---

## 36.4 Ethernet On-Wire Overhead

**Serialization delay** (also *transmission delay*) is the time to clock the bits of a frame onto the wire: `bits / line_rate`. It is distinct from **propagation delay**, the time for the signal to travel the distance, which depends only on distance and medium.

### The per-frame wire budget

```
 IPG (12 B) │ Preamble (7 B) │ SFD (1 B) │      FRAME (64..1518 B)      │ IPG …
            └──────── 8 B ────────┘        └── DA SA Type Payload FCS ──┘
 total wire bytes = frame_bytes + 20
```

Every frame therefore costs **20 bytes of pure overhead** beyond the frame itself. This is the number people forget.

### Serialization delay by link speed

Time to serialize one byte, and the resulting frame times:

| Link rate | ns per byte | 64 B frame (84 B wire) | 1518 B frame (1538 B wire) | 9018 B jumbo (9038 B) |
|---|---|---|---|---|
| 1 GbE | 8.0 | 672 ns | 12.3 µs | 72.3 µs |
| 10 GbE | 0.8 | 67.2 ns | 1.23 µs | 7.23 µs |
| 25 GbE | 0.32 | 26.9 ns | 492 ns | 2.89 µs |
| 40 GbE | 0.2 | 16.8 ns | 308 ns | 1.81 µs |
| 100 GbE | 0.08 | 6.7 ns | 123 ns | 723 ns |

Memorize the anchor: **at 10 GbE, one byte is 0.8 ns and a 1500-byte packet is ~1.2 µs.** Everything else derives from it. At 25 GbE a small frame is under 30 ns, which is why the switch and NIC fixed costs, not serialization, dominate the modern budget.

### Maximum frame rate

At 10 GbE with minimum-size frames: `10e9 / (84 × 8) = 14.88 Mpps`. This is the canonical "line rate" figure for 10G and the basis of the DPDK 67-ns-per-packet budget (Ch. 47 §47.2) — at 14.88 Mpps you have 67 ns per packet, which is roughly 200 cycles at 3 GHz, i.e. two or three cache misses. That arithmetic is the entire motivation for poll-mode drivers and batching.

| Link | Max pps (64 B frames) | ns per packet budget |
|---|---|---|
| 1 GbE | 1.488 Mpps | 672 |
| 10 GbE | 14.88 Mpps | 67.2 |
| 25 GbE | 37.2 Mpps | 26.9 |
| 100 GbE | 148.8 Mpps | 6.7 |

### Propagation delay

Signal velocity is roughly `0.66c` in fibre (~200,000 km/s ≈ **5 µs per km**, or **~1 µs per 200 m**) and similar in copper. Useful anchors:

- 100 m of fibre inside a colo cage: **0.5 µs** each way.
- Chicago ↔ New York, 1200 km great-circle: **~4 ms** one-way in straight fibre; real routes ~4.5 ms, microwave ~4.0 ms (microwave travels through air at ~0.99c and takes a straighter path — this is the entire economic basis of the CME–NASDAQ microwave networks).
- Same-rack, 3 m twinax: **15 ns** — utterly negligible against a 300 ns switch.

**The design rule:** inside a datacentre, propagation is negligible and serialization plus device latency dominates; between datacentres, propagation dominates absolutely and nothing you do in software matters.

### Encoding overhead

10GBASE-R uses 64b/66b line encoding: 66 physical bits carry 64 data bits, so the actual signalling rate is 10.3125 Gbaud for 10 Gbit/s of data. Because this is below the layer-2 abstraction, the 0.8 ns/byte figure already accounts for it — do not double-count. (1000BASE-X used 8b/10b, a 25 % overhead, which is why 1 GbE runs at 1.25 Gbaud.)

---

## 36.5 MAC Addressing

A **MAC address** (Media Access Control address, also *hardware* or *physical* address) is a 48-bit layer-2 identifier. Canonical text form is six colon- or hyphen-separated hex octets: `00:1b:21:3c:4d:5e`.

```
 byte 0        byte 1   byte 2    byte 3   byte 4   byte 5
┌────────────┬────────┬────────┬────────┬────────┬────────┐
│ b7..b0     │        │        │        │        │        │
└────────────┴────────┴────────┴────────┴────────┴────────┘
  ▲▲
  ││└─ bit 1 (of first octet): U/L — 0 = universally administered (OUI-assigned)
  ││                                 1 = locally administered
  │└── bit 0 (of first octet): I/G — 0 = unicast, 1 = multicast/group
  └─ first 24 bits = OUI (Organizationally Unique Identifier, IEEE-assigned vendor)
```

The two low bits of the **first transmitted octet** are the flags. Note "first transmitted octet" — Ethernet transmits octets in order but bits within an octet LSB-first, so the I/G bit is literally the first bit on the wire, letting hardware classify a frame as unicast or multicast after one bit time.

### Address categories

| Address | Meaning | Switch behaviour |
|---|---|---|
| Unicast (I/G = 0) | One NIC | Forwarded to the learned port; **flooded** if unknown |
| Broadcast `ff:ff:ff:ff:ff:ff` | All stations | Flooded to all ports in the VLAN |
| Multicast (I/G = 1) | A group | Flooded, unless IGMP snooping has built state (Ch. 37 §37.9) |
| IPv4 multicast mapping | `01:00:5e` + low 23 bits of the group IP | See below |
| IPv6 multicast mapping | `33:33` + low 32 bits of the group IP | — |

**The 32:1 IPv4 multicast MAC collision** is a genuinely important detail. The IPv4 multicast MAC is `01:00:5e:` followed by the **low 23 bits** of the group address, but a group address has 28 significant bits. Five bits are lost, so **32 distinct multicast groups map to the same destination MAC**. If an exchange feed uses `239.1.2.3` and another uses `239.129.2.3`, both hash to `01:00:5e:01:02:03`, and a NIC doing MAC-level filtering will deliver both to the host — the kernel (or your bypass stack) must filter by destination IP as well. This shows up as unexplained CPU burn or unexpected packets on a feed handler and is a favourite interview question (Ch. 37 §37.8).

### Learning and the CAM table

A switch is a self-configuring device: on receiving a frame it records `(source MAC, ingress port, VLAN)` in its **MAC address table** (also *CAM* or *FDB*), with an aging timer (default 300 s). Forwarding is a lookup on destination MAC:

- **Hit** → forward out that one port.
- **Miss** → **flood** out every other port in the VLAN (*unknown-unicast flooding*).

Unknown-unicast flooding is a real latency hazard in trading networks: a silent server whose MAC entry ages out causes every frame addressed to it to be flooded to all ports, adding load and jitter across the fabric. Diagnose with `show mac address-table` on the switch and by looking for unexpected unicast traffic in a `tcpdump` on an unrelated host.

### MAC addresses do not cross routers

A MAC address is meaningful only within one layer-2 broadcast domain. At each router hop, the L2 header is stripped and rewritten with the next hop's addresses; the IP header (except TTL and checksum) is unchanged. This "L2 changes every hop, L3 is end-to-end" fact is the cleanest one-sentence explanation of the layering split and is worth being able to state exactly.

Practical commands: `ip link show` (local MACs), `ip neigh` (the ARP/neighbour cache), `ethtool -P eth0` (permanent hardware address vs a configured one).

---

## 36.6 ARP

**ARP** (Address Resolution Protocol, RFC 826) maps an IPv4 address to a MAC address within one broadcast domain. It is the glue between layer 3 and layer 2 and it is not itself an IP protocol — ARP frames carry EtherType `0x0806` and have no IP header.

```
 ARP packet (28 B for IPv4 over Ethernet), inside an Ethernet frame:
┌──────────┬──────────┬────┬────┬────────┬────────────┬───────────┬────────────┬───────────┐
│ HTYPE  2 │ PTYPE  2 │HLEN│PLEN│ OPER 2 │ SHA      6 │ SPA     4 │ THA      6 │ TPA     4 │
│  = 1     │ = 0x0800 │ =6 │ =4 │1=req   │ sender MAC │ sender IP │ target MAC │ target IP │
│(Ethernet)│  (IPv4)  │    │    │2=reply │            │           │(0 in req)  │           │
└──────────┴──────────┴────┴────┴────────┴────────────┴───────────┴────────────┴───────────┘
```

### The exchange

1. Host A wants to send to `10.0.0.5`, has no cache entry. It **broadcasts** a request (dest MAC `ff:ff:ff:ff:ff:ff`): "who has `10.0.0.5`? tell `10.0.0.1`."
2. Host B, owning that IP, **unicasts** a reply with its MAC.
3. A caches the mapping. Linux's neighbour cache entry lives in state `REACHABLE` for ~30 s (randomized), then `STALE`; a stale entry is used immediately but triggers background revalidation.

Every host that sees the request also learns A's mapping (from SHA/SPA), which is why gratuitous ARP works.

### Latency and failure modes

**The first packet to a cold destination is delayed by a full ARP round trip** — typically 100 µs–1 ms on a LAN, but potentially far worse. Linux queues (by default) only a small number of packets per unresolved neighbour and drops the rest, so a burst to a cold destination loses packets. On a trading order-entry path this manifests as a mysteriously slow or lost first order after a quiet period. **Mitigation: pin static ARP entries** (`ip neigh add 10.0.0.5 lladdr aa:bb:cc:dd:ee:ff dev eth0 nud permanent`) for every exchange gateway, or keep the entry warm with periodic traffic. This is a standard, expected answer.

Other failure modes and their signatures:

| Failure | Signature |
|---|---|
| **Duplicate IP** | Two replies to one request; kernel logs "duplicate address detected"; intermittent connectivity as the cache flips |
| **ARP cache overflow** | `neighbour: arp_cache: neighbor table overflow!` in `dmesg`; fix with `net.ipv4.neigh.default.gc_thresh1/2/3` |
| **ARP spoofing** | An attacker replies to requests for the gateway; ARP is unauthenticated by design. Detect with `arpwatch`; mitigate with static entries or switch Dynamic ARP Inspection |
| **Proxy ARP** | A router answers for addresses it can reach, defeating subnet boundaries; almost always a misconfiguration in a datacentre |
| **ARP storm** | Broadcast flooding from a loop; the whole VLAN's latency degrades |

### Gratuitous ARP and adjacent mechanisms

A **gratuitous ARP** is a request (or reply) for one's *own* address, sent to update everyone's caches. Its critical use is **failover**: when a standby server takes over a virtual IP, it sends a gratuitous ARP so switches relearn the port and hosts relearn the MAC. If that ARP is lost, traffic keeps flowing to the dead node until caches age out — up to 300 s of outage. Any active-passive design (Ch. 56 §56.4) must send several gratuitous ARPs and must consider them advisory, not reliable.

**IPv6 has no ARP.** It uses **NDP** (Neighbor Discovery Protocol) carried over ICMPv6: Neighbor Solicitation / Neighbor Advertisement to solicited-node multicast addresses rather than broadcast, which is strictly better because it does not interrupt uninvolved hosts. It brings its own failure modes (RA-based misconfiguration, NDP cache exhaustion attacks on large subnets).

Diagnostics: `ip neigh show`, `arp -an`, `tcpdump -i eth0 arp`, and `ip -s neigh` for per-entry stats.

---

## 36.7 VLAN Tagging

A **VLAN** (Virtual LAN, IEEE 802.1Q) partitions one physical switched fabric into multiple isolated broadcast domains. A **tag** is 4 bytes inserted into the Ethernet frame after the source MAC.

```
 Untagged:  ┌──── DA 6 ────┬──── SA 6 ────┬ Type 2 ┬─ Payload ─┬ FCS 4 ┐

 802.1Q:    ┌──── DA 6 ────┬──── SA 6 ────┬ TPID 2 ┬ TCI 2 ┬ Type 2 ┬─ Payload ─┬ FCS 4 ┐
                                            0x8100

 TCI (16 bits):
   ┌─────┬───┬────────────────┐
   │ PCP │DEI│      VID       │
   │ 3 b │1 b│     12 bits    │
   └─────┴───┴────────────────┘
     ▲     ▲          ▲
     │     │          └── VLAN ID: 0..4095 (0 = priority-only, 1 = default, 4095 reserved)
     │     └── Drop Eligible Indicator (formerly CFI)
     └── Priority Code Point: 802.1p class of service, 0..7
```

The tag adds **4 bytes** to every frame, raising the maximum frame from 1518 to **1522** bytes — switches must be configured for "baby giant" frames or they will drop tagged full-size frames with an FCS/oversize error. The IP MTU is unaffected (still 1500) because the tag is layer 2.

### Access, trunk, and native

| Port mode | Behaviour |
|---|---|
| **Access** | Untagged frames only; switch associates them with one configured VLAN internally |
| **Trunk** | Carries multiple VLANs, tagged; the endpoint must understand tags |
| **Native VLAN** | The one VLAN sent untagged on a trunk — the classic source of "VLAN hopping" security issues and of silent misdelivery when the two ends disagree |

**QinQ** (802.1ad) stacks two tags — an outer service tag (TPID `0x88A8`) and an inner customer tag — for carrier transport, costing 8 bytes and pushing the max frame to 1526.

### Why it matters in trading

- **Feed separation.** Exchange multicast feeds arrive on dedicated VLANs, and A/B redundant feeds (Ch. 53 §53.6) typically arrive on separate VLANs over separate physical paths so that a single fabric fault cannot take both.
- **Broadcast containment.** ARP and unknown-unicast flooding are contained within a VLAN, so a storm in one does not add jitter to another.
- **PCP is real but rarely used inside colo.** In a properly provisioned trading fabric there is no persistent congestion, so QoS classes do nothing; where they matter is on shared uplinks. Priority queueing also *adds* a scheduling decision, so blanket-enabling it can add jitter rather than remove it.
- **Latency cost of the tag itself:** 4 bytes = 3.2 ns at 10 GbE. Structurally free; the cost is configuration risk, not time.

### Failure signatures

| Symptom | Cause |
|---|---|
| Traffic works one direction only | Native VLAN mismatch between the two ends of a trunk |
| Full-size frames drop, small ones work | Switch MTU not raised to 1522 for tagged frames |
| Feed A arrives, feed B silent | VLAN not allowed on the trunk (`switchport trunk allowed vlan`) |
| `tcpdump` shows no tag but the switch says tagged | The NIC stripped the tag into the `sk_buff` metadata — use `tcpdump -e` and check `ethtool -k eth0 \| grep vlan` for `rx-vlan-offload` |

That last row is a good diagnostic detail: **VLAN tag stripping offload** means the tag is removed by hardware before capture, so a capture appears untagged even on a trunk. Disable with `ethtool -K eth0 rxvlan off` when you need to see the tag, and remember that on a bypass stack (Ch. 47) *you* are responsible for parsing or configuring stripping.

Linux side: `ip link add link eth0 name eth0.100 type vlan id 100` creates a tagged subinterface; `ip -d link show eth0.100` displays the VLAN protocol and ID.

---

## 36.8 MTU and Jumbo Frames

**MTU** (Maximum Transmission Unit) is the largest layer-3 payload a link can carry in one frame — for standard Ethernet, **1500 bytes**. **MSS** (Maximum Segment Size) is the largest TCP *payload* in one segment. They differ by the IP and TCP headers.

### The arithmetic (memorize these)

```
MTU 1500  (IPv4 + TCP, no options)  →  MSS = 1500 − 20 (IP) − 20 (TCP) = 1460
MTU 1500  (IPv6 + TCP)              →  MSS = 1500 − 40 − 20            = 1440
MTU 1500  (IPv4 + TCP + timestamps) →  usable payload 1500 − 20 − 32   = 1448
MTU 1500  (IPv4 + UDP)              →  max UDP payload 1500 − 20 − 8   = 1472
MTU 9000  (IPv4 + UDP)              →  max UDP payload                 = 8972
MTU 1500 over PPPoE (8 B)           →  MTU 1492, MSS 1452
MTU 1500 over VXLAN (50 B)          →  inner MTU 1450
```

**1472** and **1460** are the two numbers you should be able to produce instantly. `ping -M do -s 1472 host` sends a 1500-byte IP packet with DF set and is the standard manual **path-MTU probe**: if it succeeds and 1473 fails, the path MTU is 1500.

### Jumbo frames

A **jumbo frame** carries an MTU above 1500, conventionally **9000** (occasionally 9216 as a device limit). Jumbos are not standardized by IEEE; they are a universally-implemented convention.

| | 1500 MTU | 9000 MTU |
|---|---|---|
| Wire bytes for max frame | 1538 | 9038 |
| Header efficiency | 96.2 % | 99.3 % |
| Serialization at 10 GbE | 1.23 µs | 7.23 µs |
| Interrupts/pps for 10 Gbit/s | ~812 kpps | ~138 kpps |
| Per-packet CPU cost | 6× higher per byte | lower |

**The tradeoff for low latency is unambiguous and counterintuitive to newcomers: jumbo frames increase latency.** A 9000-byte frame takes 7.2 µs to serialize at 10 GbE, and under store-and-forward switching (Ch. 39 §39.1) the switch must receive all 7.2 µs of it before forwarding. One jumbo frame ahead of your market-data packet in an output queue delays you by 7.2 µs — versus 1.2 µs for a standard frame. Trading fabrics therefore usually run **1500-byte MTU on market-data and order-entry paths** and reserve jumbos for bulk paths (storage, replay, backup) on separate VLANs or separate NICs.

Jumbos win where throughput and CPU per byte matter: NFS/iSCSI, historical data replay, intra-cluster bulk transfer.

### The consistency requirement

**Every device in the layer-2 path must agree on the MTU.** A single switch port left at 1500 while hosts run 9000 produces the classic pathology: small packets (ping, ARP, TCP handshake) succeed, large transfers hang. TCP hangs after the handshake completes; UDP silently loses large datagrams. The diagnostic is `ping -M do -s <size>` bisecting the size, plus `ip link show` on every hop and `show interface` on the switch.

### Path MTU Discovery

**PMTUD** (RFC 1191) discovers the minimum MTU along a path: the sender sets the **DF** (Don't Fragment) bit; a router that must fragment instead drops the packet and returns **ICMP Type 3 Code 4** ("Fragmentation Needed and DF Set") carrying the next-hop MTU. The sender caches it per-destination.

PMTUD is fragile because it depends on ICMP surviving. Firewalls that blanket-drop ICMP create the **ICMP black hole**: connections establish and then stall on the first large transfer, retransmitting the same segment forever. This is the single most common "the network is broken but ping works" cause, and naming it is a strong answer. Mitigations: `net.ipv4.tcp_mtu_probing=1` (PLPMTUD, RFC 4821, which infers MTU from loss without ICMP), MSS clamping at the router (`iptables -t mangle -A FORWARD -p tcp --syn -j TCPMSS --clamp-mss-to-pmtu`), or fixing the firewall.

IPv6 has no router fragmentation at all, so PMTUD is mandatory and the ICMPv6 "Packet Too Big" message must be permitted. The IPv6 minimum link MTU is **1280** bytes.

---

## 36.9 Network Byte Order

**Network byte order is big-endian**: the most significant byte at the lowest address, i.e. first on the wire. Every IETF protocol header field wider than one byte — IP addresses, ports, lengths, checksums, TCP sequence numbers — is big-endian. Host order on x86-64 and default ARM is little-endian, so every header field access needs a swap.

(Ch. 3 §3.9 covers the representation-level mechanics; this section is the protocol-level consequence.)

```
 Port 443 = 0x01BB
   on the wire (network order):   01 BB
   in memory on x86 as uint16_t:  BB 01
```

### The POSIX API and its traps

```c
uint32_t htonl(uint32_t);   uint32_t ntohl(uint32_t);   // 32-bit
uint16_t htons(uint16_t);   uint16_t ntohs(uint16_t);   // 16-bit
```

Traps that catch people:

- **There is no `htonll`.** For 64-bit fields (timestamps, ITCH sequence numbers) use `htobe64`/`be64toh` from `<endian.h>` (glibc), `OSSwapHostToBigInt64` on macOS, or `std::byteswap` (C++23) guarded by `std::endian::native`.
- **`inet_addr` returns the address already in network order**, and returns `INADDR_NONE` (`0xFFFFFFFF`) on error — which is also the valid broadcast address `255.255.255.255`. Use `inet_pton` instead, which returns a status code.
- **`INADDR_ANY` is 0**, so it needs no swap and people forget the rule; `sin_port` always does.
- **`sockaddr_in::sin_family` is in *host* order** while `sin_port` and `sin_addr` are in *network* order. This inconsistency inside a single struct is a genuine API wart and a favourite trick question.

### The correct C++ pattern

Do not cast a buffer pointer to a header struct and call `ntohl` on the member — that is simultaneously a strict-aliasing violation and a potentially misaligned load (Ch. 3 §3.8, §3.9). Read with explicit shifts, which is endianness-independent by construction and compiles to a single `MOVBE` or load+`BSWAP`:

```cpp
constexpr uint32_t rd_be32(const std::byte* p) noexcept {
    return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16
         | uint32_t(p[2]) <<  8 | uint32_t(p[3]);
}
```

### Where trading protocols diverge

Exchange application protocols frequently are **not** big-endian, precisely to avoid the swap on x86:

| Protocol | Byte order |
|---|---|
| All IP/TCP/UDP headers | Big-endian (always) |
| NASDAQ ITCH | Big-endian |
| NASDAQ OUCH | Big-endian |
| CME MDP 3.0 / SBE | **Little-endian** |
| FIX (tag=value ASCII) | N/A — text |

So a single feed handler may swap for the transport headers, not swap for an SBE body, and parse ASCII for a FIX session. Knowing that SBE is explicitly little-endian for x86 performance reasons is a good concrete detail (Ch. 51 §51.6).

**Cost:** a byte swap is one instruction, ~1 cycle, and `MOVBE` folds it into the load. It is never the bottleneck; the bottleneck is the cache miss on the buffer. Do not let anyone convince you the swap is worth a protocol change — the reason SBE is little-endian is more about alignment and direct field access than about `BSWAP` cost.

---

## 36.10 Internet Checksums

The **Internet checksum** (RFC 1071) is the 16-bit one's-complement sum used by IPv4, ICMP, UDP, and TCP. It was chosen for cheap computation on 1970s hardware, and it is weak by modern standards.

### The algorithm

1. Treat the data as a sequence of 16-bit big-endian words (pad with a zero byte if odd length).
2. Sum them using **one's-complement addition**: add with carry, then fold the carry back into the low bit (`sum = (sum & 0xffff) + (sum >> 16)`, repeated).
3. The checksum is the **one's complement** (bitwise NOT) of the result.
4. To verify: sum the whole thing including the checksum field; a correct packet yields `0xFFFF`, whose complement is `0x0000`.

```cpp
uint16_t inet_csum(const uint8_t* p, size_t n) {
    uint32_t sum = 0;
    for (size_t i = 0; i + 1 < n; i += 2) sum += (uint32_t(p[i]) << 8) | p[i+1];
    if (n & 1) sum += uint32_t(p[n-1]) << 8;
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
    return uint16_t(~sum);
}
```

Two properties make it cheap and make it weak:

- **It is endian-neutral for computation.** Summing 16-bit words in the wrong byte order produces a byte-swapped result, so you can compute in host order and swap once at the end. (RFC 1071 §2.)
- **It is commutative and associative**, so a router can *incrementally* update the header checksum after decrementing TTL — subtract the old field, add the new — rather than recomputing. RFC 1624 covers the correct incremental algorithm and its one's-complement `-0` edge case.

### Weakness

The checksum cannot detect: reordering of 16-bit words, insertion or deletion of zero words, or any pair of compensating errors. Its residual undetected-error rate on real traffic has been measured at roughly **1 in 16 million to 1 in 10 billion** packets depending on error type — far worse than Ethernet's CRC-32. The famous Stone & Partridge "When the CRC and TCP Checksum Disagree" (SIGCOMM 2000) found roughly 1 in 16 million–10 billion packets arriving corrupted-but-accepted, mostly from buggy middleboxes and host memory, not the wire. **Consequence for trading: never rely on the transport checksum for message integrity.** Exchange protocols carry their own CRC/checksum and sequence numbers (Ch. 51 §51.13).

### Scope of each checksum

| Checksum | Covers | Notes |
|---|---|---|
| Ethernet FCS | Whole frame | CRC-32, strong; recomputed hop-by-hop by every switch |
| IPv4 header checksum | **IPv4 header only**, not payload | Recomputed at every router (TTL changes) |
| IPv6 | **None** | Removed deliberately — relies on L2 CRC and L4 checksums |
| UDP | Pseudo-header + UDP header + payload | **Optional in IPv4** (0 = not computed); mandatory in IPv6 |
| TCP | Pseudo-header + TCP header + payload | Mandatory |

The **pseudo-header** is a synthetic block (source IP, dest IP, zero, protocol, L4 length) prepended for checksum purposes only. Its purpose is to detect misdelivery — a packet that arrives at the wrong host or was mangled by NAT fails the checksum. Its side effect is a **layering violation**: L4 depends on L3 addresses, which is precisely why NAT (§36.17) must rewrite L4 checksums, and why NAT is architecturally intrusive.

### Offload

Every modern NIC computes and verifies IP/UDP/TCP checksums in hardware (`ethtool -k eth0` shows `tx-checksumming` / `rx-checksumming`). Consequences you must know:

- **`tcpdump` on the sending host shows "incorrect checksum" for outgoing packets.** This is normal and expected — the checksum has not been filled in yet when the packet is copied to the capture path. Wireshark's "checksum offload" note explains it. Reading this as a bug is a common junior mistake.
- On a **kernel-bypass** or **AF_XDP** path you may be responsible for checksums yourself, or must explicitly request offload flags in the descriptor (Ch. 47 §47.13).
- **UDP checksum 0 in IPv4** means "not computed"; some multicast feeds send zero checksums to save NIC work. If the value is genuinely 0 after computation, it is transmitted as `0xFFFF` (the equivalent one's-complement representation) to disambiguate.

---

## 36.11 IPv4 Addressing and CIDR

An **IPv4 address** is a 32-bit number, written as four dotted decimal octets. **CIDR** (Classless Inter-Domain Routing, RFC 4632) replaced the old class A/B/C system with an explicit **prefix length**: `10.1.2.0/24` means the first 24 bits identify the network.

```
 10.1.2.130 / 26

 address : 00001010 00000001 00000010 10000010
 mask/26 : 11111111 11111111 11111111 11000000
 network : 00001010 00000001 00000010 10000000  = 10.1.2.128
 broadcast:00001010 00000001 00000010 10111111  = 10.1.2.191
 usable  : 10.1.2.129 .. 10.1.2.190             = 2^(32−26) − 2 = 62 hosts
```

| Prefix | Mask | Addresses | Usable hosts |
|---|---|---|---|
| /24 | 255.255.255.0 | 256 | 254 |
| /25 | 255.255.255.128 | 128 | 126 |
| /26 | 255.255.255.192 | 64 | 62 |
| /28 | 255.255.255.240 | 16 | 14 |
| /30 | 255.255.255.252 | 4 | 2 (classic point-to-point link) |
| /31 | 255.255.255.254 | 2 | 2 (RFC 3021 — point-to-point, no net/bcast) |
| /32 | 255.255.255.255 | 1 | 1 (host route, loopback interfaces) |

Two addresses per subnet are unusable: the all-zeros **network address** and the all-ones **directed broadcast**. The /31 exception exists precisely to stop wasting half a /30 on router links.

### Reserved ranges worth knowing

| Range | Purpose |
|---|---|
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | RFC 1918 private |
| `127.0.0.0/8` | Loopback (the whole /8, not just `.0.0.1`) |
| `169.254.0.0/16` | Link-local / APIPA — an address here means DHCP failed |
| `224.0.0.0/4` | Multicast (Ch. 37 §37.5) |
| `224.0.0.0/24` | Link-local multicast, TTL 1, never routed (e.g. `224.0.0.1` all-hosts, `224.0.0.2` all-routers) |
| `239.0.0.0/8` | Administratively scoped multicast — where exchange feeds usually live |
| `100.64.0.0/10` | Carrier-grade NAT |
| `0.0.0.0/0` | Default route |

Seeing a `169.254.x.x` address on an interface is an immediate diagnosis: no DHCP response.

### Longest-prefix match

A router selects the route with the **longest matching prefix**, not the first match or the lowest metric. Given routes `0.0.0.0/0 → A`, `10.0.0.0/8 → B`, and `10.1.2.0/24 → C`, a packet to `10.1.2.5` goes to C. This single rule is what makes hierarchical routing and route aggregation work, and it is why a more specific route always wins regardless of protocol or metric — a fact that bites when a stray `/32` host route hijacks traffic. `ip route get 10.1.2.5` shows exactly which route the kernel will use, and is the correct first command when traffic goes to the wrong interface.

### Subnet arithmetic in an interview

You will be asked to do this on a whiteboard. The reliable method: subtract the prefix from 32 to get host bits `h`; the block size is `2^h`; subnets start at multiples of the block size in the last significant octet. For `/26`, `h = 6`, block = 64, so networks are `.0`, `.64`, `.128`, `.192`.

**Trading relevance:** exchange colo cross-connects hand you a small subnet (often a /29 or /30) per connection, and market-data multicast groups are allocated from `233.x.x.x` (GLOP) or `239.x.x.x` per-feed. Source addresses matter — SSM (Ch. 37 §37.7) subscribes to `(source, group)` pairs, so knowing the exchange's source IP is part of the configuration, and a source-address change during a venue migration is a classic outage cause.

---

## 36.12 IPv6 Fundamentals

**IPv6** uses 128-bit addresses written as eight groups of four hex digits, with one run of zero groups compressible to `::`:

```
 2001:0db8:0000:0000:0000:ff00:0042:8329
 2001:db8::ff00:42:8329          (leading zeros dropped, one :: run)
```

Only **one** `::` is permitted per address — otherwise the expansion is ambiguous. RFC 5952 mandates lowercase hex and compressing the *longest* zero run.

### Header comparison

```
 IPv6 header — FIXED 40 bytes, no options, no checksum, no fragmentation fields:
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
┌───────┬───────────────┬───────────────────────────────────────┐
│Ver=6  │Traffic Class  │            Flow Label (20)            │
├───────┴───────────────┴────────┬──────────────┬───────────────┤
│      Payload Length (16)       │ Next Header  │  Hop Limit    │
├────────────────────────────────┴──────────────┴───────────────┤
│                  Source Address (128 bits)                    │
├───────────────────────────────────────────────────────────────┤
│                Destination Address (128 bits)                 │
└───────────────────────────────────────────────────────────────┘
```

| | IPv4 | IPv6 |
|---|---|---|
| Header size | 20–60 B (variable, IHL) | **40 B fixed** |
| Checksum | Yes (header only) | **None** |
| Fragmentation | Router or host | **Host only** (extension header) |
| Options | In-header, IHL-counted | Extension header chain |
| Address resolution | ARP (broadcast) | NDP over ICMPv6 (multicast) |
| Broadcast | Yes | **None** — replaced by multicast |
| Min link MTU | 68 (576 practical) | **1280** |
| Autoconfiguration | DHCP | SLAAC (RA-based) or DHCPv6 |

The fixed 40-byte header with no checksum was a deliberate optimization for hardware forwarding: no IHL means no variable-offset parse, no checksum means no per-hop recompute. The **flow label** lets a router hash a flow without parsing L4 — useful for ECMP over encrypted or fragmented traffic (Ch. 39 §39.8).

### Address types

| Prefix | Type |
|---|---|
| `::1/128` | Loopback |
| `::/128` | Unspecified |
| `fe80::/10` | **Link-local** — auto-configured on every interface, required for NDP; needs a zone/scope ID (`fe80::1%eth0`) |
| `fc00::/7` (`fd00::/8` in practice) | Unique local (the RFC 1918 analogue) |
| `2000::/3` | Global unicast |
| `ff00::/8` | Multicast; scope in the second nibble (`ff02::1` = all nodes on-link) |

There is no broadcast. `ff02::1` (all-nodes) and the **solicited-node multicast** `ff02::1:ffXX:XXXX` (derived from the low 24 bits of a target address) replace it — NDP thereby disturbs on average far fewer hosts than ARP broadcast.

### Extension headers

Options live in a linked chain: the base header's **Next Header** field names the next extension header (Hop-by-Hop, Routing, Fragment, Destination Options, AH, ESP) or the L4 protocol. This is elegant and operationally troublesome: parsing to reach the TCP header requires walking a variable-length chain, which hardware dislikes, so many middleboxes and NICs simply drop packets with extension headers. Header-chain parsing is also a fertile source of parser bugs (unbounded chains, zero-length headers).

### Trading reality

IPv6 is **rare on exchange market-data and order-entry paths**. Reasons: entrenched IPv4 addressing in colo, hardware feed handlers and FPGAs written for a fixed 20-byte header, and no address-scarcity pressure inside a private colo. It appears in corporate infrastructure and some newer crypto venues. The interview-relevant points are the header-size and no-checksum differences, the ARP→NDP change, the 1280 minimum MTU, and the fact that IPv6 fragmentation is host-only so PMTUD is mandatory.

---

## 36.13 IP Headers

The IPv4 header, field by field:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
┌───────┬───────┬───────────────┬───────────────────────────────┐
│Version│  IHL  │      DSCP/ECN │        Total Length           │  bytes 0–3
├───────┴───────┴───────────────┼─┬─┬─┬─────────────────────────┤
│         Identification        │0│D│M│    Fragment Offset      │  bytes 4–7
├───────────────┬───────────────┼─┴─┴─┴─────────────────────────┤
│      TTL      │   Protocol    │       Header Checksum         │  bytes 8–11
├───────────────┴───────────────┴───────────────────────────────┤
│                     Source IP Address                         │  bytes 12–15
├───────────────────────────────────────────────────────────────┤
│                  Destination IP Address                       │  bytes 16–19
├───────────────────────────────────────────────────────────────┤
│              Options (0–40 B, only if IHL > 5)     │ Padding  │
└───────────────────────────────────────────────────────────────┘
```

| Field | Width | Meaning and the detail that matters |
|---|---|---|
| Version | 4 b | 4 |
| **IHL** | 4 b | Header length in **32-bit words**. Minimum 5 (= 20 B), maximum 15 (= 60 B). *Always* use it to find the payload; assuming 20 is a parser bug and a security hole |
| DSCP | 6 b | Differentiated services code point (QoS class) |
| ECN | 2 b | `00` not-capable, `01`/`10` ECN-capable, `11` **congestion experienced** (Ch. 38 §38.19) |
| **Total Length** | 16 b | Header **plus** payload, in bytes. Max 65535. Note the asymmetry: IHL is in words, Total Length is in bytes |
| Identification | 16 b | Groups fragments of one datagram (§36.14) |
| Flags | 3 b | bit 0 reserved (must be 0), bit 1 **DF** (Don't Fragment), bit 2 **MF** (More Fragments) |
| Fragment Offset | 13 b | Offset of this fragment's data in **8-byte units** — hence the 8-byte fragment granularity |
| **TTL** | 8 b | Hop count (§36.15) |
| Protocol | 8 b | 1 = ICMP, 2 = IGMP, 6 = TCP, 17 = UDP, 41 = IPv6-in-IP, 89 = OSPF, 132 = SCTP |
| Header Checksum | 16 b | Header only; recomputed every hop |
| Source / Dest | 32 b each | — |

### Details that separate candidates

- **Two length fields in different units.** IHL counts 32-bit words; Total Length counts bytes. Payload length = `total_length − ihl*4`. Deriving payload length from the *frame* length instead is wrong whenever Ethernet padding is present — a 20-byte UDP payload in a 64-byte minimum frame has 6 bytes of Ethernet pad that are not IP payload. **Always trust the IP Total Length, never the frame length.** This is a genuinely common bug in hand-rolled parsers.
- **Options are effectively dead.** Record Route, Timestamp, and Strict/Loose Source Route exist but are dropped or slow-pathed by essentially every router (they force software processing). A packet with options in a trading network is an anomaly worth alerting on.
- **The 8-byte fragment granularity** follows directly from the 13-bit offset field needing to address a 65535-byte datagram: `2^13 × 8 = 65536`.
- **DSCP replaced the old TOS byte**, and the ECN bits are the low two bits of that same byte — which is why old code that writes a whole TOS byte can clobber ECN.

### Parsing it in C++

```cpp
struct Ipv4Hdr {                       // Ch. 3 §3.12 rules apply
    uint8_t  ver_ihl;                  // never a bit-field: ABI-defined order
    uint8_t  dscp_ecn;
    uint16_t total_len;                // big-endian on the wire
    uint16_t id;
    uint16_t flags_frag;
    uint8_t  ttl, proto;
    uint16_t csum;
    uint32_t src, dst;
};
static_assert(sizeof(Ipv4Hdr) == 20);
static_assert(std::is_trivially_copyable_v<Ipv4Hdr>);

inline unsigned ihl_bytes(const Ipv4Hdr& h) { return (h.ver_ihl & 0x0F) * 4u; }
```

Use explicit masks and shifts rather than bit-fields — bit-field allocation order is ABI-defined (Ch. 3 §3.4) and a bit-field header that parses correctly on x86 parses wrongly on a big-endian target. And validate: `ihl_bytes >= 20 && ihl_bytes <= frame_remaining && total_len >= ihl_bytes` before touching the payload.

---

## 36.14 IP Fragmentation

**Fragmentation** splits an IP datagram larger than the next-hop MTU into pieces that are reassembled only at the final destination. Intermediate routers never reassemble.

### The mechanism

A 4000-byte UDP datagram (20 B IP + 8 B UDP + 3972 B data) over a 1500-byte MTU becomes:

```
 orig: [IP20][UDP8][........ 3972 data ........]   total 4000

 frag1: [IP20][UDP8][ 1472 data ]   off=0    MF=1   totlen=1500
 frag2: [IP20][      1480 data      ]  off=185  MF=1   totlen=1500
 frag3: [IP20][   1012 data   ]        off=370  MF=0   totlen=1032

 offsets are in 8-byte units: 1480/8 = 185, 2960/8 = 370
```

Rules that follow from the header layout:

- **Only the first fragment carries the L4 header.** Fragments 2..n have no UDP/TCP header, hence no port numbers. Consequently a firewall or load balancer that matches on ports cannot classify non-first fragments, and ECMP hashing (Ch. 39 §39.8) that includes ports sends fragments of one datagram down different paths.
- **All fragments except the last must be a multiple of 8 bytes** of payload, from the 8-byte offset unit.
- **All fragments share the Identification field**, plus source IP, dest IP, and protocol — that 4-tuple is the reassembly key.
- **Loss of any one fragment loses the whole datagram.** For a 3-fragment datagram at per-packet loss `p`, datagram loss is `1−(1−p)³ ≈ 3p`. Fragmentation multiplies your effective loss rate by the fragment count.
- Reassembly holds state and a timer (Linux default 30 s, `net.ipv4.ipfrag_time`) and a memory budget (`ipfrag_high_thresh`); exceeding it drops fragments and increments `ReasmFails` in `netstat -s`.

### Why it is banned on the hot path

| Cost | Detail |
|---|---|
| Loss amplification | ~N× the datagram loss rate |
| Reassembly latency | The datagram is not delivered until the *last* fragment arrives — you inherit the tail |
| Reassembly buffer DoS | Missing-fragment attacks pin kernel memory |
| Firewall/ECMP breakage | No ports in non-first fragments |
| No hardware offload | Fragmented traffic falls off GRO/RSS fast paths |
| Reordering sensitivity | Out-of-order fragments cost more state |

Exchange market-data feeds are therefore engineered to keep every datagram under the path MTU — typically **≤ 1472 bytes of UDP payload**, and often much smaller. If a feed handler ever sees fragments, it is a configuration error (an MTU mismatch or a tunnel), and it should alarm.

### Diagnosis

```
tcpdump -i eth0 -n 'ip[6:2] & 0x3fff != 0'     # any fragment (MF set or offset != 0)
netstat -s | grep -i -A3 reassembl              # ReasmReqds / ReasmOKs / ReasmFails
```
In Wireshark, the display filter `ip.flags.mf == 1 || ip.frag_offset > 0` shows fragments; Wireshark reassembles by default, which can *hide* the fragmentation — turn off "Reassemble fragmented IPv4 datagrams" when you specifically want to see it.

**IPv6 removes router fragmentation entirely.** Only the source may fragment, using a Fragment extension header; routers return ICMPv6 "Packet Too Big" instead. This is a deliberate simplification of the forwarding path, and it makes working PMTUD mandatory.

**Interview framing:** *"Should a market-data feed ever fragment?"* — no, and the reasons should be the loss-amplification arithmetic plus tail-latency inheritance, not just "it's slow."

---

## 36.15 TTL and Hop Limits

**TTL** (Time To Live) is an 8-bit IPv4 field decremented by one at every router. At zero, the packet is discarded and the router sends **ICMP Type 11 Code 0** (Time Exceeded) to the source. IPv6 renames it **Hop Limit**, which is the honest name — despite "time," it counts hops, not seconds. (RFC 791 nominally allowed decrementing by elapsed seconds; no implementation does.)

### Initial values as a fingerprint

| OS | Default initial TTL |
|---|---|
| Linux, macOS, modern BSD | 64 |
| Windows | 128 |
| Cisco IOS, Solaris | 255 |

Observed TTL therefore reveals hop count: a reply with TTL 61 from a Linux host is 3 hops away. This is how `nmap -O` guesses OS and how you sanity-check a path length without traceroute. In a colo, an unexpected TTL decrement in market data means an extra routed hop was inserted — a real, detectable configuration regression.

### The primary purpose

TTL exists to bound **routing-loop damage**. Without it, a transient loop during reconvergence would circulate packets until the link saturated. With it, each looped packet dies after at most 255 hops, and the loop degrades throughput instead of collapsing the network. A loop's signature is a burst of ICMP Time Exceeded messages plus link utilization spiking with no application traffic increase.

### Multicast TTL scoping

For multicast, TTL doubles as a **scope control** (Ch. 37 §37.5), which is the trading-relevant use:

| TTL | Scope |
|---|---|
| 0 | Host only — never leaves the sending machine |
| 1 | **Link-local** — never crosses a router (the default for `IP_MULTICAST_TTL`) |
| < 32 | Site |
| < 64 | Region |
| < 255 | Unrestricted |

**The default multicast TTL on a socket is 1.** This is the single most common multicast bug: the sender works when tested on the same switch and silently fails the moment a router is in the path. Fix with `setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof ttl)`. Conversely, the link-local range `224.0.0.0/24` is required to be sent with TTL 1 and routers must never forward it regardless.

### How traceroute uses it

Traceroute sends probes with TTL = 1, 2, 3, …; each router that decrements to zero identifies itself in the ICMP Time Exceeded. See §36.18.

### Related counters and gotchas

- `netstat -s | grep -i "time exceeded"` and the SNMP `icmpInTimeExcds` count these.
- A router **decrements before forwarding**, so a packet arriving with TTL 1 is dropped, not forwarded. Directly-connected delivery does not decrement.
- **TTL security (GTSM, RFC 5082)**: BGP peers can require an arriving TTL of 255, which proves the sender is exactly one hop away since any router would have decremented it. A neat trick worth knowing.
- Tunnels can either copy or reset TTL, so a whole MPLS or VXLAN cloud may appear as one hop — which is why traceroute sometimes shows fewer hops than the physical path.

---

## 36.16 Switching and Routing

**Switching** is layer-2 forwarding based on destination MAC within one broadcast domain. **Routing** is layer-3 forwarding based on destination IP between networks. The distinction determines both latency and failure behaviour.

| | Switch (L2) | Router (L3) |
|---|---|---|
| Forwards on | Destination MAC | Destination IP |
| Table | MAC/FDB, learned from source addresses | Routing table (FIB), built by config or protocol |
| Lookup | Exact match (hash/CAM) | **Longest-prefix match** (TCAM/trie) |
| Unknown destination | **Flood** to all ports in the VLAN | **Drop** + ICMP unreachable |
| Modifies the packet? | No (L2 header unchanged end to end) | Rewrites L2 header, decrements TTL, recomputes IP checksum |
| Loop protection | STP (topology-based) | TTL (packet-based) |
| Typical latency | 300 ns–1 µs (cut-through: ~250–500 ns) | 2–20 µs (software) / ~1 µs (hardware L3 switch) |
| Broadcast domain | Extends it | Terminates it |

### Latency detail

Modern datacentre switches do L3 in the same ASIC as L2 at the same speed, so "routing is slow" is outdated for hardware forwarding — the classic figures apply to software routers. Still, a routed hop adds a lookup and header rewrite, and each additional hop is a discrete, measurable step. **Colo trading topologies minimize hop count aggressively**: the ideal market-data path is exchange handoff → one cut-through switch → your NIC, with a single hop measured at ~300 ns (Ch. 39 §39.2).

Store-and-forward vs cut-through is covered in Ch. 39, but the headline is the one number: a store-and-forward switch adds the full serialization time of the frame (1.23 µs for 1500 B at 10 GbE) because it must receive the whole frame to check FCS, while cut-through forwards after reading the 6-byte destination MAC and adds ~250–500 ns regardless of frame size — at the price of propagating corrupt frames ("runt"/bad-FCS forwarding).

### Spanning Tree

Layer 2 has no TTL, so a physical loop would broadcast-storm the network to death within milliseconds. **STP** (802.1D) and its successors (RSTP 802.1w, MSTP 802.1s) elect a root bridge and block redundant links to produce a loop-free tree. Convergence: classic STP 30–50 s, RSTP ~1–6 s. Both are far too slow for a trading fabric, which is why modern designs prefer routed (L3) fabrics with ECMP, or MLAG/EVPN, where reconvergence is sub-second and all links carry traffic.

The failure to know about: a **broadcast storm** from a loop saturates links and spikes CPU on every host in the VLAN. Signature: link utilization at 100 %, enormous broadcast counters, hosts unreachable, and — critically — it affects everything in the broadcast domain simultaneously. Storm control and BPDU guard on access ports are the mitigations.

### Routing tables

```
$ ip route
default via 10.0.0.1 dev eth0 proto static metric 100
10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.7
233.54.12.0/24 via 10.0.9.1 dev eth1        # market data feed, separate NIC

$ ip route get 233.54.12.88          # authoritative: what the kernel WILL do
```
`ip route get` is the correct diagnostic, not reading the table by eye — it applies longest-prefix match, policy routing rules, and source-address selection for you.

Protocols: static routes (colo cross-connects, usually), OSPF/IS-IS (interior), BGP (between autonomous systems). For trading, **static routes plus separate physical NICs per feed** is the common pattern — deterministic, no protocol convergence to wait for, and no chance a routing update reroutes market data mid-day.

---

## 36.17 NAT

**NAT** (Network Address Translation) rewrites addresses (and usually ports) in packets crossing a boundary, letting many private hosts share few public addresses.

| Variant | Rewrites | Notes |
|---|---|---|
| **Static NAT** | 1:1 address mapping | Predictable; used for servers |
| **Dynamic NAT** | Address from a pool | Pool exhaustion is a failure mode |
| **PAT / NAPT / "NAT overload"** | Address **and source port** | What every home router and most enterprises do; the default meaning of "NAT" |
| **DNAT / port forwarding** | Destination address/port | Inbound to a private server |
| **CGNAT** | Carrier-scale PAT | `100.64.0.0/10` |

### The mechanism

For outbound `10.0.0.5:51000 → 93.184.216.34:443`, a PAT device rewrites the source to `203.0.113.7:60001` and records:

```
 (10.0.0.5, 51000, 93.184.216.34, 443, TCP)  ←→  (203.0.113.7, 60001)
```

The return packet is matched against this table and rewritten back. Consequences that follow directly:

1. **The L4 checksum must be recomputed** because the pseudo-header contains the IP addresses (§36.10). This is the layering violation biting: a device that claims to be L3 must parse and modify L4. Incremental checksum update (RFC 3022/1624) makes it cheap, but it means NAT devices must understand every L4 protocol.
2. **NAT is stateful**, so it is a single point of failure and its table has a finite size. Table exhaustion under a burst of connections produces dropped new connections while existing ones work — a confusing signature.
3. **State expires.** Idle TCP mappings are typically dropped after 2–5 minutes (some devices 30 s for UDP). An idle FIX session then silently breaks: the client believes the connection is up, the server believes the same, and the first message after the idle period vanishes. **This is the concrete reason TCP keepalive and application heartbeats exist** (Ch. 38 §38.16, Ch. 54 §54.2), and it is a very good thing to be able to explain causally rather than as a rule of thumb.
4. **Inbound connections are impossible without explicit mapping**, which is why P2P protocols need STUN/TURN/ICE and hole punching.
5. **Embedded addresses break.** Protocols that carry IP addresses in their payload — FTP `PORT`, SIP, and notably **FIX** if a party encodes addresses — require an application-layer gateway to rewrite the payload too.

### NAT and trading

**NAT is essentially absent from exchange-facing paths.** Colo cross-connects use routed public or exchange-assigned addressing, and market-data multicast cannot be NATted meaningfully in any case. Reasons NAT is excluded:

- Adds a stateful device — latency (µs, and variable), a failure point, and a table to exhaust.
- Breaks multicast source identification, which SSM depends on (Ch. 37 §37.7).
- Exchanges authorize sessions by source IP; NAT changes it.
- Adds jitter proportional to table pressure — precisely the kind of variable cost a hot path forbids.

Where you do meet NAT: corporate access to venue portals, VPNs, and cloud environments. In the cloud this is significant — an AWS instance's "public IP" is a 1:1 NAT and the instance never sees it, which surprises people binding sockets.

Linux implements NAT in `netfilter`/`conntrack`; `conntrack -L` lists the state table, `nf_conntrack_max` bounds it, and `dmesg` showing `nf_conntrack: table full, dropping packet` is the exhaustion signature. `iptables -t nat -L -n -v` shows the rules and hit counts.

---

## 36.18 ICMP, Ping, and Traceroute

**ICMP** (Internet Control Message Protocol, RFC 792, IP protocol number 1) carries error and diagnostic messages for IP. It is not a transport for applications — it has no ports.

```
┌───────────────┬───────────────┬───────────────────────────────┐
│     Type      │     Code      │          Checksum             │
├───────────────┴───────────────┴───────────────────────────────┤
│         Rest of header (type-dependent: ID/seq, MTU, …)       │
├───────────────────────────────────────────────────────────────┤
│  For errors: the IP header + first 8 bytes of the offending   │
│  datagram (enough to identify the flow: ports / seq)          │
└───────────────────────────────────────────────────────────────┘
```

The "IP header + 8 bytes" rule is why an ICMP error can be matched to a socket: 8 bytes of a TCP or UDP header contains both port numbers (and, for TCP, the sequence number).

| Type | Code | Meaning |
|---|---|---|
| 0 | 0 | Echo Reply |
| 3 | 0 | Net unreachable |
| 3 | 1 | Host unreachable |
| 3 | 3 | **Port unreachable** — the UDP "nobody is listening" signal |
| 3 | 4 | **Fragmentation needed, DF set** — the PMTUD message (§36.8) |
| 5 | — | Redirect (a router telling you a better next hop) |
| 8 | 0 | Echo Request |
| 11 | 0 | **TTL exceeded in transit** — the traceroute engine |
| 11 | 1 | Fragment reassembly time exceeded |

### Ping

`ping` sends Echo Request (type 8) and times the Echo Reply (type 0), matching by the ID and sequence fields.

What ping actually measures is **round-trip time including ICMP processing at the far end**, which is frequently *slow-pathed* — routers deprioritize ICMP generation to protect the control plane. Therefore:

- **High ping latency to a router does not mean high forwarding latency through it.** A router can forward at 500 ns and answer pings in 5 ms. This is one of the most useful things to be able to say in a networking interview.
- Ping RTT includes both serialization directions and both hosts' stacks; for sub-microsecond measurements it is useless. Use hardware timestamping and one-way measurement instead (Ch. 48 §48.10).
- `ping -M do -s N` is the PMTU probe; `ping -f` (flood) and `-i 0.01` measure loss under load; `ping -Q` sets DSCP.

Typical anchors: same rack ~30–60 µs (kernel stack dominated), same datacentre ~100–200 µs, Chicago–NY ~8–9 ms RTT, transatlantic ~70–80 ms RTT.

### Traceroute

Traceroute exploits TTL: send a probe with TTL = 1; the first router decrements to 0, drops it, and returns ICMP Time Exceeded, revealing its address. Repeat with TTL = 2, 3, … until the destination replies (Echo Reply for ICMP mode, or ICMP Port Unreachable for the classic UDP mode, which targets a high unused port).

| Variant | Probe | Advantage |
|---|---|---|
| Classic UDP (Unix default) | UDP to high ports 33434+ | Works where ICMP echo is filtered |
| ICMP (`ping`-style, Windows `tracert`) | Echo Request | Often permitted where UDP is not |
| **TCP (`traceroute -T`, `tcptraceroute`)** | TCP SYN to a real port | Traverses firewalls that permit only the service port — the one that usually works |
| **`mtr`** | Continuous, per-hop loss stats | The right tool for intermittent problems |

Reading traceroute output correctly is a discriminating skill:

- **Stars (`* * *`) at one hop but replies after it mean nothing is wrong** — that router simply does not generate ICMP or rate-limits it. Only stars *all the way to the destination* indicate a real break.
- **Rising latency at one hop that does not persist to later hops is not congestion** — it is control-plane deprioritization at that router.
- **Asymmetric return paths** mean each hop's RTT is measured over a possibly different return route; traceroute shows the forward path only.
- **ICMP rate limiting** (`net.ipv4.icmp_ratelimit`, default 1000 ms bucket) causes intermittent stars from Linux hosts.

### Should you block ICMP?

Blanket-blocking ICMP is a classic operational mistake: it breaks PMTUD (§36.8) and produces hanging connections instead of clean errors. The correct policy permits at minimum type 3 code 4 (Packet Too Big) and type 11, and rate-limits the rest.

**Trading relevance:** ICMP is a diagnostic tool, never a hot-path mechanism. But two ICMP behaviours matter operationally: **ICMP port unreachable** floods back to a UDP sender whose peer is not listening (which on Linux causes `ECONNREFUSED` on a *connected* UDP socket — surprising but useful for detecting a dead gateway), and **PMTUD black holes** silently break large TCP transfers on order-entry links.

---

## Key Interview Questions

1. **Walk me through what happens byte-by-byte when a UDP market-data packet arrives at a NIC.** — Preamble/SFD stripped; FCS checked and stripped; destination MAC filter; EtherType `0x0800` → IPv4; validate IHL and Total Length; Protocol 17 → UDP; verify checksum against the pseudo-header; demux on destination IP+port to a socket; copy to user or DMA to a bypass ring.
2. **How many bytes of overhead does Ethernet actually add per frame?** — 18 bytes of frame header/FCS plus 20 bytes of preamble+SFD+IPG that are on the wire but not in the frame; 38 total, or 42 with IP+UDP headers.
3. **How long does a 1500-byte packet take to serialize at 10 GbE?** — ~1.23 µs (1538 wire bytes × 0.8 ns/byte). At 25 GbE ~490 ns.
4. **Why does a switch forward on destination MAC being first in the frame?** — It enables cut-through: the lookup can begin after 6 bytes rather than after the entire frame.
5. **Why is the minimum Ethernet frame 64 bytes?** — CSMA/CD collision detection on a maximum-diameter half-duplex segment. Vestigial today, but still enforced, so tiny payloads are padded.
6. **What is the maximum packet rate at 10 GbE and why does it matter?** — 14.88 Mpps with 64-byte frames, giving a 67 ns per-packet budget — roughly 200 cycles, i.e. two or three cache misses. This is the DPDK design constraint.
7. **Why do jumbo frames hurt latency?** — 9 KB serializes in 7.2 µs at 10 GbE; one jumbo ahead of you in a store-and-forward queue adds that entire time as head-of-line delay.
8. **What are MTU and MSS, and what's the arithmetic?** — MTU 1500 → IPv4 UDP payload 1472, IPv4 TCP MSS 1460 (1440 for IPv6, 1448 with timestamps).
9. **A connection completes its handshake then hangs on the first large transfer. Diagnose.** — PMTUD black hole: a firewall dropping ICMP type 3 code 4. Confirm with `ping -M do -s` bisection; fix with MSS clamping or `tcp_mtu_probing`.
10. **Why is IP fragmentation forbidden on a market-data path?** — Loss of any fragment loses the datagram (loss ≈ N×p), delivery waits for the last fragment, ports are absent from non-first fragments (breaking firewalls and ECMP hashing), and no NIC offload path handles it.
11. **Why do 32 multicast groups share one destination MAC?** — Only the low 23 bits of the 28-bit group address map into the `01:00:5e` MAC; the NIC's MAC filter therefore admits unwanted groups and the stack must filter on destination IP.
12. **What breaks when a standby server takes over a virtual IP?** — Nothing, if the gratuitous ARP is delivered; if it is lost, switches and hosts keep sending to the dead node until the CAM and ARP caches age out (up to 300 s).
13. **Why does `tcpdump` show bad checksums on outgoing packets?** — Checksum offload: the NIC fills them in after the capture point. Expected, not a bug.
14. **What is the IPv4 pseudo-header and what does it break?** — Source IP, dest IP, protocol, and L4 length included in the TCP/UDP checksum to detect misdelivery; it makes L4 depend on L3, which is why NAT must rewrite L4 checksums.
15. **Why do routed hops matter more than cable length in a colo?** — 3 m of fibre is 15 ns; one switch hop is 300 ns–1 µs. Between cities the reverse holds absolutely: 5 µs per km of propagation dominates everything.
16. **Traceroute shows `* * *` at hop 4 but hops 5–10 respond. Is hop 4 broken?** — No. That router does not generate or rate-limits ICMP Time Exceeded. Only stars continuing to the destination indicate a real failure.
17. **Why is high ping RTT to a router not evidence of high forwarding latency?** — ICMP generation is a control-plane, deprioritized path; a router can forward in 500 ns and reply to pings in milliseconds.
18. **Why does an idle FIX session over NAT silently die?** — The NAT mapping expires after a few minutes of idleness; both endpoints still believe the connection is up. Keepalives and application heartbeats exist to refresh it.
19. **What does a `169.254.x.x` address tell you immediately?** — DHCP failed; the host self-assigned a link-local address.
20. **Why should you never derive the IP payload length from the Ethernet frame length?** — Frames below 64 bytes are zero-padded; the pad is not IP payload. Use the IP Total Length field minus IHL×4.

---

## Common Traps

- **Forgetting preamble + SFD + IPG (20 bytes)** when computing wire throughput or maximum packet rate.
- **Assuming the IPv4 header is 20 bytes** instead of reading IHL — a parser bug and a security hole.
- **Confusing the two IPv4 length units** — IHL counts 32-bit words, Total Length counts bytes.
- **Deriving payload length from frame length** — Ethernet padding on sub-64-byte frames corrupts the result.
- **Bit-fields for protocol headers** — allocation order is ABI-defined and differs across targets (Ch. 3 §3.4).
- **Casting a receive buffer to a header struct and dereferencing** — strict aliasing violation plus a possible misaligned load; `memcpy` or `std::start_lifetime_as` instead (Ch. 3 §3.7).
- **`sockaddr_in::sin_family` is host order while `sin_port` and `sin_addr` are network order** — inconsistent within one struct.
- **No `htonll`** — 64-bit fields need `htobe64` or `std::byteswap`.
- **`inet_addr` returning `INADDR_NONE` on error, which is also a valid broadcast address** — use `inet_pton`.
- **Default multicast TTL of 1** — works on the local switch, silently fails through any router.
- **Jumbo frames on a latency-sensitive path** — 7.2 µs of head-of-line delay per queued jumbo at 10 GbE.
- **MTU mismatch anywhere in the L2 path** — pings work, bulk transfers hang.
- **Blanket-blocking ICMP** — breaks PMTUD, producing hangs instead of errors.
- **Assuming VLAN-tagged frames fit in a 1518-byte switch limit** — they need 1522.
- **Reading a capture as untagged when VLAN offload stripped the tag** — use `tcpdump -e` and check `ethtool -k`.
- **Believing outgoing checksums shown as "incorrect" in tcpdump are real errors** — that is offload.
- **Cold ARP cache delaying or dropping the first burst** — pin static neighbour entries for exchange gateways.
- **Relying on the transport checksum for integrity** — it is 16-bit one's-complement, blind to word reordering and compensating errors; use application CRCs and sequence numbers.
- **Unknown-unicast flooding from an aged-out MAC entry** silently adding load and jitter across the fabric.
- **Assuming a router that answers ping slowly forwards slowly.**
- **Trusting traceroute's per-hop RTTs as forwarding latency** — they include control-plane processing and asymmetric return paths.

---

## Compact Recall Summary

**Layering.** Each layer contributes a header, a demultiplexing key (MAC+EtherType / IP+Protocol / port), and a distinct failure signature with its own counter. TCP/IP collapses OSI 5–7 into the application. Kernel NIC-to-application is ~2–5 µs; bypass ~1 µs; FPGA ~100 ns.

**Ethernet.** 14-byte header (DA 6, SA 6, EtherType 2) + payload 46–1500 + 4-byte FCS; plus 8 bytes preamble/SFD and 12 bytes IPG on the wire but not in the frame — **20 bytes of invisible overhead per frame**. EtherTypes: `0800` IPv4, `0806` ARP, `86DD` IPv6, `8100` VLAN. 64-byte minimum frame is a CSMA/CD fossil that still pads your small messages.

**Wire timing.** 10 GbE = **0.8 ns/byte**; 64 B frame = 67 ns, 1500 B = 1.23 µs, 9 KB jumbo = 7.2 µs. Max 14.88 Mpps at 10 GbE → 67 ns per packet ≈ 200 cycles. Propagation ≈ **5 µs/km** in fibre; 3 m is 15 ns, Chicago–NY ~4 ms one way. Inside a colo, device latency dominates; between cities, propagation dominates absolutely.

**MAC and ARP.** 48-bit, OUI + I/G + U/L bits; switches learn from source MAC and **flood unknown unicast**. IPv4 multicast maps to `01:00:5e` + low 23 bits, so **32 groups collide on one MAC** and you must filter on IP. ARP is a broadcast request / unicast reply cache with ~30 s reachability; the first packet to a cold destination eats a full ARP RTT, so pin static entries. Gratuitous ARP drives failover, and losing it strands traffic for up to 300 s. IPv6 replaces ARP with NDP over ICMPv6.

**VLAN and MTU.** 802.1Q adds 4 bytes (TPID `0x8100` + PCP/DEI/VID), max frame 1522 — switches must permit baby giants. MTU 1500 → UDP payload **1472**, TCP MSS **1460** (1440 IPv6, 1448 with timestamps). Jumbo 9000 improves efficiency to 99 % but adds 7.2 µs of head-of-line delay; trading paths stay at 1500. PMTUD depends on ICMP type 3 code 4 surviving; blocking it creates the black hole that hangs large transfers.

**IP header.** 20–60 bytes; IHL in words, Total Length in bytes; Identification + DF/MF + 13-bit offset in **8-byte units** for fragmentation; TTL; Protocol (1 ICMP, 6 TCP, 17 UDP); header-only checksum. IPv6 is a fixed 40 bytes, no checksum, no router fragmentation, 1280-byte minimum MTU, extension-header chain. Fragmentation multiplies loss by fragment count, hides ports from non-first fragments, and inherits the tail — banned on market-data paths.

**Byte order.** All IP/TCP/UDP header fields are big-endian; `htons`/`htonl`, `htobe64` for 64-bit, `std::byteswap` in C++23. Parse with explicit shifts, never a cast-and-deref. ITCH/OUCH are big-endian; **SBE and CME MDP are little-endian** to suit x86.

**Checksums.** 16-bit one's-complement over 16-bit words, folded and complemented; verification yields `0xFFFF`. Endian-neutral and incrementally updatable — hence weak: blind to word reordering and compensating errors. IPv4 covers the header only, IPv6 has none, UDP/TCP include a pseudo-header of L3 addresses (which is what NAT breaks). NIC offload makes outgoing captures show "bad" checksums.

**Addressing.** CIDR prefix arithmetic: usable hosts = `2^(32−p) − 2` (except /31 and /32); longest-prefix match always wins. Know `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16` (DHCP failed), `224/4` multicast, `239/8` scoped, `224.0.0.0/24` TTL-1 link-local.

**TTL.** Decremented per router hop; 0 → ICMP Time Exceeded, which is the traceroute engine. Initial 64 (Linux) / 128 (Windows) / 255 (Cisco) fingerprints the OS and reveals hop count. For multicast it is scope control, and the **default socket value of 1** is the classic silent-failure bug.

**Switching vs routing.** L2 exact-match on MAC, floods on miss, no TTL so it needs STP; L3 longest-prefix, drops on miss, rewrites L2 and decrements TTL. Modern ASICs route at switch speed. Cut-through ~300 ns fixed; store-and-forward adds full serialization. Trading fabrics minimize hops and prefer static routes on dedicated NICs.

**NAT.** Stateful address+port rewrite requiring L4 checksum recomputation; mappings expire in minutes (hence keepalives and heartbeats), tables exhaust, inbound needs explicit mapping, embedded addresses break, multicast and SSM are incompatible. Absent from exchange-facing paths by design.

**ICMP.** Type/code plus the offending IP header and 8 bytes (enough for ports). Key types: 0/8 echo, 3/3 port unreachable, **3/4 fragmentation needed** (PMTUD), 11/0 TTL exceeded (traceroute). ICMP is control-plane and deprioritized, so ping RTT is not forwarding latency and traceroute stars are usually rate limiting, not breakage.
