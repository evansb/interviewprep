# Chapter 36 — Ethernet and IP

**Why this matters.** A low-latency network problem is often a byte-accounting problem wearing a larger costume. A parser trusts Ethernet padding as IP data. A 1,500-byte payload is mistaken for a 1,500-byte frame. A VLAN tag is absent from a host capture because hardware stripped it. A sender resolves the destination host’s MAC even though the destination is across a router. A UDP datagram crosses the MTU and quietly becomes three failure opportunities.

This chapter owns the book’s packet-size arithmetic. Later transport, switching, Linux packet-path, bypass, and NIC chapters use these definitions rather than inventing another meaning for “wire bytes.” The objective is to walk a frame and an IP packet, calculate every byte, and diagnose a path from protocol invariants before reaching for tuning folklore.

**90-second screen.**

Five facts:

1. Keep four sizes separate: application payload, IP packet, Ethernet MAC frame, and occupied wire byte-times. Preamble and interpacket gap consume link time but are not part of the MAC frame.
2. An ordinary non-jumbo, untagged Ethernet II frame is 64–1,518 bytes from destination MAC through FCS. A 1,500-byte Ethernet MTU limits the IP packet to 1,500 bytes; it is not the total wire size.
3. IPv4 has a variable 20–60-byte header and may be fragmented by a source or router when permitted. IPv6 has a fixed 40-byte base header; routers do not fragment it.
4. A host resolves the layer-2 address of its **next hop**: the destination when it is on-link, otherwise the router. IPv4 uses ARP; IPv6 Neighbor Discovery uses ICMPv6.
5. Ethernet FCS, IPv4 header checksum, and transport checksums cover different bytes. Offloads can make a host capture disagree with what appears on the wire.

Two decisions:

- Keep latency-sensitive datagrams below a verified path MTU; treat fragmentation or repeated neighbor resolution as a correctness and tail-latency incident.
- Before trusting a capture or rate claim, state the observation point and whether it includes VLAN tags, FCS, preamble, interpacket gap, offload aggregation, and physical-layer overhead.

---

## 36.1 Layers, Units, and Claim Labels — Core

A **host** originates or consumes packets. A **link** connects interfaces that can exchange link-layer frames. A **switch** forwards Ethernet frames within a layer-2 domain. A **router** forwards IP packets between IP networks. A **protocol** defines a header format and rules for interpreting it.

The OSI model is useful vocabulary, not a seven-stage implementation mandate.
The working table below uses the common TCP/IP collapse: its link layer spans
roughly OSI layers 1–2, internet corresponds to layer 3, transport to layer 4,
and application combines layers 5–7. Implementations can cross these conceptual
boundaries through offload or bypass without changing the protocols' wire
formats.

| Working layer | Unit | Address or selector | Examples | Owned later |
|---|---|---|---|---|
| Application | message | protocol-defined | market data, FIX, DNS | Chapters 49–54 |
| Transport | UDP datagram or TCP segment | ports and connection state | UDP, TCP | Chapters 37–38 |
| Internet | IP packet | IP address and next-header value | IPv4, IPv6, ICMP | this chapter |
| Link | Ethernet frame | MAC address, VLAN, EtherType | Ethernet, 802.1Q | this chapter |
| Physical | symbols/bits | physical lane | fibre, copper, PHY | Chapters 35, 39, 48 |

Encapsulation adds an outer header as data moves downward:

```text
application bytes
└─ UDP header | application bytes
   └─ IP header | UDP header | application bytes
      └─ Ethernet header | IP packet | FCS
         └─ preamble/SFD | MAC frame | interpacket gap
```

Each layer also supplies a demultiplexing key. Ethernet uses a destination MAC and EtherType; IP uses destination address and Protocol/Next Header; UDP and TCP use ports plus address/connection context. Layering therefore gives a diagnostic sequence: prove the frame arrived, prove the IP header is valid and addressed locally, then investigate transport demultiplexing.

### Protocol is not platform

This chapter marks claims where the distinction matters:

| Label | Meaning |
|---|---|
| **P — protocol** | Required or defined by an RFC or IEEE protocol specification |
| **S — C++ standard** | Portable C++23 language behavior |
| **L — Linux** | Linux command, API, stack, or configuration behavior |
| **V — vendor** | Device- or implementation-specific behavior from vendor documentation |
| **M — measured** | Observation with a stated interface, capture point, configuration, load, and statistic |
| **D — derived** | Arithmetic from visible size and rate assumptions |

For example, IPv4 Total Length is a **P** field. Linux’s presentation of an offloaded packet is **L/V**. A packet rate calculated from 84 byte-times and 25 Gb/s is **D**. The rate an application actually sustains is **M**; it is never implied by the derived line-rate ceiling.

---

## 36.2 Walk an Ethernet Frame — Core

Ethernet II carries nearly all IP traffic encountered by an application:

```text
MAC frame, ordinary non-jumbo and untagged

0             6            12    14                         n      n+4
┌─────────────┬─────────────┬─────┬──────────────────────────┬──────┐
│ destination │   source    │type │ payload plus any padding │ FCS  │
│   MAC 6 B   │   MAC 6 B   │ 2 B│       46–1500 B          │ 4 B  │
└─────────────┴─────────────┴─────┴──────────────────────────┴──────┘

before frame: 7 B preamble + 1 B start-frame delimiter
after frame:  minimum 12 byte-times interpacket gap
```

The field rules are protocol facts:

| Field | Meaning and parser consequence |
|---|---|
| Destination MAC | Unicast, multicast, or broadcast delivery within the layer-2 domain |
| Source MAC | Sender on this link; switches commonly learn forwarding state from it |
| Type/Length | Values at least `0x0600` are EtherTypes; values at most 1,500 are IEEE 802.3 payload lengths |
| Payload/padding | IP packet or other payload; zero padding may extend a short payload to the minimum frame |
| FCS | Ethernet CRC over the MAC frame except the FCS itself; normally checked before host delivery |

Common EtherTypes are `0x0800` for IPv4, `0x0806` for ARP, `0x86dd` for IPv6, `0x8100` for an IEEE 802.1Q tag, and `0x88a8` for a common provider-bridging outer tag. Treat an unfamiliar EtherType as unsupported input, not as IPv4 by default.

Ethernet supplies error detection, not reliable delivery. It does not promise that a frame will arrive, arrive once, or arrive in order. A bad-FCS frame is normally discarded before the application sees it. Loss recovery and ordering, if required, belong above Ethernet.

### MAC delivery

A 48-bit MAC address has two important low-order bits in its first octet:

- the I/G bit distinguishes an individual address from a group address;
- the U/L bit distinguishes universally administered from locally administered addresses.

`ff:ff:ff:ff:ff:ff` is Ethernet broadcast. Multicast addresses have the group bit set. Unicast normally targets one interface, but a switch may flood an unknown unicast within the VLAN until it learns the destination’s location. Exact learning, aging, security, and flooding policy are switch configuration and therefore **V**, not a universal timing or delivery guarantee. Chapter 39 owns switch pipelines, buffers, and forwarding modes.

IPv4 multicast maps to Ethernet multicast prefix `01:00:5e` plus the low 23 bits of the group address. Because an IPv4 multicast address contributes 28 variable bits, 32 IP groups map to each such MAC. A receiver must still filter on destination IP; a MAC filter alone cannot identify one IPv4 multicast group. Chapter 37 develops multicast membership and delivery.

### VLAN tags

An 802.1Q tag inserts four bytes between the source MAC and the original EtherType:

```text
┌──── DA 6 ────┬──── SA 6 ────┬ TPID 2 ┬ TCI 2 ┬ inner type 2 ┬ payload ┬ FCS 4 ┐
                                  0x8100

TCI:  PCP 3 bits | DEI 1 bit | VLAN identifier 12 bits
```

The tag changes the link envelope, not the IP packet. A network that supports a
1,500-byte IP MTU must permit the corresponding tagged MAC frame: 1,522 bytes
including one tag and FCS. Two tags add eight header bytes instead of four. For
a short frame, tag bytes can replace padding, so the standard 64-byte minimum
does not automatically grow by four bytes. “Jumbo” and “baby giant” limits are
vendor/configuration properties; verify the accepted frame size at every port.

An access port commonly sends and receives untagged frames associated internally with one VLAN. A trunk commonly carries tagged frames for multiple VLANs. Native-VLAN and allowed-VLAN behavior is configuration-specific. A mismatch can produce one-way traffic or make only one feed disappear.

Host captures are not wire truth. A NIC may remove a VLAN tag and report it as descriptor metadata, or insert a transmit tag after the capture hook. Linux packet capture may therefore show no tag even though the physical frame had one. Record the capture point and inspect the interface’s offload settings before diagnosing the switch.

### Four sizes, one vocabulary

Use these terms exactly:

1. **Application payload:** bytes meaningful to the application.
2. **IP packet:** IP header plus IP payload. The Ethernet MTU limits this size.
3. **MAC frame:** destination MAC through FCS.
4. **Occupied wire byte-times:** preamble/SFD, MAC frame, and the minimum interpacket gap used for serialization and maximum-frame-rate arithmetic.

For ordinary untagged Ethernet:

\[
\begin{aligned}
\text{frame bytes}
  &=14+\max(46,\text{IP packet bytes})+4\\
\text{occupied byte-times}
  &=8+\text{frame bytes}+12
\end{aligned}
\]

The `max` matters. Ethernet padding belongs to the frame but not to the IP Total Length. A parser that derives IP payload length from captured frame length will consume padding as data on small packets.

At the usual untagged extremes:

| Object | Minimum frame | Full 1,500-byte IP packet |
|---|---:|---:|
| MAC frame, including FCS | 64 B | 1,518 B |
| Common host capture with FCS stripped | 60 B | 1,514 B |
| Preamble/SFD | 8 B | 8 B |
| Interpacket gap for rate arithmetic | 12 byte-times | 12 byte-times |
| Occupied wire byte-times | 84 | 1,538 |

This table assumes no VLAN tag. A capture may also omit or retain tags depending on hardware and capture position. Physical coding, forward-error correction, pause frames, and link-idle representation are not extra MAC bytes; account for them only when the measurement boundary requires PHY symbols rather than nominal MAC-rate byte-times.

---

## 36.3 Walk IPv4 and IPv6 — Core

An IP packet is routed independently. IP provides best-effort datagram delivery: it does not guarantee delivery, ordering, uniqueness, latency, or path stability.

### IPv4 header

```text
0                   1                   2                   3
0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
┌───────┬───────┬───────────────┬───────────────────────────────┐
│Version│  IHL  │   DSCP | ECN  │        Total Length           │
├───────────────────────────────┼─┬─┬───────────────────────────┤
│         Identification        │0│D│M│     Fragment Offset     │
├───────────────┬───────────────┼─┴─┴───────────────────────────┤
│      TTL      │   Protocol    │       Header Checksum         │
├───────────────────────────────────────────────────────────────┤
│                       Source Address                          │
├───────────────────────────────────────────────────────────────┤
│                    Destination Address                        │
├───────────────────────────────────────────────────────────────┤
│              Options, if IHL > 5, plus padding                │
└───────────────────────────────────────────────────────────────┘
```

| Field | Width | Invariant to validate |
|---|---:|---|
| Version | 4 bits | equals 4 |
| IHL | 4 bits | header length in 32-bit words; 5–15 means 20–60 bytes |
| DSCP/ECN | 8 bits | forwarding/QoS and explicit-congestion markings; policy-specific |
| Total Length | 16 bits | entire IP packet in bytes; at least the IHL-derived header length |
| Identification/flags/offset | 32 bits together | fragmentation state; offset is in 8-byte units |
| TTL | 8 bits | decremented at each routed hop; zero causes discard |
| Protocol | 8 bits | next protocol: ICMP 1, TCP 6, UDP 17, among others |
| Header checksum | 16 bits | covers the IPv4 header only |
| Addresses | 32 bits each | source and destination IPv4 addresses |

The two length fields use different units. The correct payload length is:

\[
\text{IPv4 payload bytes}=\text{Total Length}-4\times\text{IHL}
\]

Validate Version, IHL, Total Length, and capture bounds before following Protocol. Do not assume IHL is five. Options are uncommon, but an uncommon valid field is not permission for an out-of-bounds read.

### IPv4 addresses, subnets, and CIDR

A CIDR prefix `/p` says that the first \(p\) address bits identify a network. For `10.1.2.130/26`:

```text
address:    10.1.2.130 = ... 10000010
mask /26:                  ... 11000000
network:    10.1.2.128
broadcast:  10.1.2.191
host range: 10.1.2.129 through 10.1.2.190
```

There are \(2^{32-p}\) addresses in a prefix. Subtracting two for network and broadcast describes conventional IPv4 subnets, with important exceptions such as `/31` point-to-point links and `/32` host routes. Do not apply the “minus two” mnemonic blindly.

Private IPv4 ranges are `10.0.0.0/8`, `172.16.0.0/12`, and `192.168.0.0/16`. `127.0.0.0/8` is loopback, `169.254.0.0/16` is link-local, and `224.0.0.0/4` is multicast. These classifications describe addressing; whether a route or policy permits traffic is a separate question.

Given several routes, IP forwarding uses the matching route with the longest
prefix. The IPv4 default route `0.0.0.0/0` and IPv6 default route `::/0` are the
least-specific fallbacks; any matching more-specific route wins. A default route
often names a gateway, but connected and policy routes can choose another next
hop or declare a destination on-link. Policy routing, metrics among equally
specific candidates, and equal-cost multipath selection are
implementation/configuration details. On Linux, `ip route get ADDRESS` asks the
kernel to apply those rules and source-address selection.

### IPv6 base header

IPv6 has a fixed 40-byte base header:

```text
┌────────┬───────────────┬──────────────────────────────────────┐
│Version │ Traffic Class │            Flow Label                │
├────────────────────────┴────────┬─────────────┬───────────────┤
│       Payload Length            │ Next Header │   Hop Limit   │
├─────────────────────────────────┴─────────────┴───────────────┤
│                  Source Address, 128 bits                     │
├───────────────────────────────────────────────────────────────┤
│               Destination Address, 128 bits                   │
└───────────────────────────────────────────────────────────────┘
```

Important differences from IPv4:

- Payload Length normally counts bytes **after** the 40-byte base header. The
  IPv6 jumbogram exception uses zero in this field and carries a larger length
  in a Hop-by-Hop option; reject that form unless it is explicitly supported.
- Next Header identifies an extension header or upper-layer protocol.
- Hop Limit is IPv4 TTL with an honest name.
- The base header has no header checksum.
- Routers do not fragment IPv6 packets.
- IPv6 has multicast but no broadcast.

Extension headers form a chain. A parser must walk that chain with a byte bound, a header-count bound, and protocol-specific length rules. “The UDP header starts at byte 40” is correct only when the base header’s Next Header is UDP. Complex chains may be unsupported or slow-pathed by particular devices; that is **V/M**, not permission to parse them unsafely.

IPv6 text uses eight 16-bit hexadecimal groups. One run of zero groups may be compressed with `::`; only one such run is allowed. `::1/128` is loopback, `fe80::/10` is link-local, `2000::/3` covers global unicast allocation, and `ff00::/8` is multicast. A link-local address often requires an interface scope, such as `fe80::1%eth0`, because the same prefix exists on every link.

---

## 36.4 MTU, Fragmentation, and Path MTU — Core

The **link MTU** is the largest network-layer packet the link carries without IP-layer fragmentation. The standard IP-over-Ethernet MTU is 1,500 bytes. A configured “jumbo” MTU such as 9,000 is a common convention, not one universal IEEE value; every host, switch port, subinterface, and tunnel in the path must support the chosen envelope.

The transport payload that fits depends on every header inside the MTU:

| Case, no IP/TCP options unless stated | Maximum upper-layer payload within MTU |
|---|---:|
| IPv4 + UDP, MTU 1,500 | \(1500-20-8=1472\) B |
| IPv6 + UDP, MTU 1,500 | \(1500-40-8=1452\) B |
| IPv4 + TCP, MTU 1,500 | \(1500-20-20=1460\) B MSS |
| IPv6 + TCP, MTU 1,500 | \(1500-40-20=1440\) B MSS |

These are **D** values under the stated minimum-header assumptions. IP options, TCP options, extension headers, and tunnels reduce what remains. A VLAN tag normally enlarges the layer-2 envelope and does not reduce the 1,500-byte IP MTU when the link is configured to accept tagged frames.

Larger frames amortize per-packet work and framing bytes, which can improve throughput per CPU cycle. They also take longer to serialize and can create a larger head-of-line blocking interval when queued ahead of a latency-sensitive packet. Neither “jumbo is faster” nor “jumbo is slower” is a complete claim; state whether the objective is throughput, per-message latency, or a tail under mixed traffic.

### IPv4 fragmentation

If an IPv4 packet exceeds a next-hop MTU and DF is clear, a router may split it into fragments. The source can fragment too. Reassembly happens at the final destination, not at each router. Each fragment gets its own IPv4 header; fragments share identifying fields, and Fragment Offset locates their payload in units of eight bytes. All non-final fragment payloads must therefore be multiples of eight bytes.

For a 4,000-byte IPv4 packet with a 20-byte header crossing an MTU of 1,500:

```text
original IP payload = 4000 - 20 = 3980 bytes
largest non-final fragment payload = floor((1500 - 20) / 8) * 8
                                   = 1480 bytes

fragment 1: IP 20 + data 1480, offset   0, MF=1, Total Length 1500
fragment 2: IP 20 + data 1480, offset 185, MF=1, Total Length 1500
fragment 3: IP 20 + data 1020, offset 370, MF=0, Total Length 1040
```

If the original payload begins with UDP, only fragment 1 contains the UDP header. Later fragments therefore lack ports. Firewalls, load balancers, RSS, and telemetry that expect a transport header need explicit fragment handling.

Fragmentation harms a low-latency datagram path for structural reasons:

- one missing fragment prevents delivery of the whole original packet;
- reassembly waits for the last required fragment and holds state;
- every extra fragment adds an IP header and another Ethernet frame envelope;
- reordering and overlapping fragments complicate validation;
- non-first fragments are harder to classify; and
- reassembly limits and timeouts create additional drop modes.

If independent fragment loss probability were an illustrative \(p\), a three-fragment datagram’s success probability would be \((1-p)^3\). Real losses are often correlated, so this is a model, not a production prediction.

IPv6 routers never fragment. A source may add a Fragment extension header; a router unable to forward the packet returns ICMPv6 Packet Too Big. IPv6 requires every link to support an MTU of at least 1,280 bytes at the IPv6 layer or provide fragmentation below IPv6.

### Path MTU discovery

The **path MTU** is the minimum link MTU along the current path. Classical IPv4 PMTUD sends packets with DF and uses ICMP Destination Unreachable, Fragmentation Needed. IPv6 PMTUD uses ICMPv6 Packet Too Big. If required ICMP errors are blocked, a small handshake may work while larger packets disappear: the PMTU black-hole symptom.

Packetization-layer PMTU discovery can infer a usable packet size with probes rather than trusting ICMP alone. The transport-specific behavior belongs in Chapters 37–38. The design requirement here is simpler: define a maximum application datagram from a verified PMTU and all headers, leave margin when the path can gain encapsulation, and alarm on observed fragmentation.

On Linux, this IPv4 probe requests a 1,500-byte IP packet because 1,472 bytes of echo data plus an 8-byte ICMP header plus a 20-byte IPv4 header equals 1,500:

```sh
ping -4 -M do -s 1472 DESTINATION
```

That conclusion assumes no IPv4 options and the iputils form of `ping`; the command is **L**, while the arithmetic is **D**. A successful echo proves only that this probe and return path worked at that moment. It does not prove a transport’s path, a one-way path, or every ECMP member.

---

## 36.5 Byte Order and Checksums — Core

Multi-byte integer fields in Internet protocol headers are encoded in network byte order, most-significant byte first. This is a **P** wire representation, independent of the host’s native endianness.

Portable C++ must not reinterpret a packet buffer as a header struct and dereference it. Alignment may be insufficient; object lifetime and aliasing rules may not permit the access; struct padding and bit-field allocation are not wire-format guarantees. Read bytes with shifts or copy into integers and convert explicitly. Chapter 3 owns the C++ object-model details.

POSIX-family APIs commonly provide `ntohs`, `ntohl`, `htons`, and `htonl`; those APIs are not ISO C++. C++23 provides `std::byteswap`, but the program must still branch at compile time on `std::endian::native` when converting a native integer. Explicit byte reads avoid both host-order cases in a parser.

### Three different integrity checks

| Check | Coverage | Consequence |
|---|---|---|
| Ethernet FCS | MAC frame from destination address through payload/padding | detects link-frame corruption; normally checked and regenerated per link |
| IPv4 header checksum | IPv4 header only | a router updates it when a covered field such as TTL changes |
| TCP/UDP Internet checksum | pseudo-header, transport header, and transport payload | detects corruption and some IP misdelivery; details belong to Chapters 37–38 |

IPv6 deliberately has no base-header checksum. Ordinary IPv6 UDP use requires a UDP checksum, although narrowly specified tunnel exceptions exist. IPv4 UDP permits a transmitted zero to mean that no UDP checksum was generated. Do not generalize that exception to IPv6 or TCP.

The Internet checksum is the one’s-complement sum of 16-bit words with end-around carry, followed by one’s complement. An odd final byte is padded with zero for calculation. Its algebra permits incremental updates, but it is not a cryptographic hash and is weaker than a message-level integrity scheme. Sequence numbers detect loss/order events; they are not checksum substitutes.

This C++23 implementation is bounded and alignment-independent:

```cpp
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <span>

constexpr std::uint16_t internet_checksum(
    std::span<const std::byte> bytes) noexcept {
    std::uint32_t sum = 0;
    std::size_t i = 0;
    for (; i + 1 < bytes.size(); i += 2) {
        const std::uint32_t word =
            (std::to_integer<std::uint32_t>(bytes[i]) << 8)
          |  std::to_integer<std::uint32_t>(bytes[i + 1]);
        sum += word;
        sum = (sum & 0xffffU) + (sum >> 16);
    }
    if (i < bytes.size()) {
        sum += std::to_integer<std::uint32_t>(bytes[i]) << 8;
        sum = (sum & 0xffffU) + (sum >> 16);
    }
    while (sum >> 16) {
        sum = (sum & 0xffffU) + (sum >> 16);
    }
    return static_cast<std::uint16_t>(~sum);
}

int main() {
    constexpr std::byte data[]{std::byte{0x45}, std::byte{0x00},
                               std::byte{0x00}, std::byte{0x14}};
    static_assert(internet_checksum(data) == 0xbaeb);
    constexpr std::byte with_checksum[]{
        std::byte{0x45}, std::byte{0x00}, std::byte{0x00},
        std::byte{0x14}, std::byte{0xba}, std::byte{0xeb}};
    static_assert(internet_checksum(with_checksum) == 0);
}
```

### Offload changes observations

On a Linux transmit capture, a checksum may appear wrong because the capture hook saw a partially prepared buffer and the NIC filled the checksum later. On receive, hardware may validate the checksum and report status without preserving all original bytes. Likewise, TSO/GSO and GRO can make host captures show objects larger than the path MTU even though the NIC transmitted or received ordinary frames.

Those are **L/V** observations, not protocol exceptions. Confirm interface features with `ethtool -k`, inspect driver/NIC counters, and move the capture to a tap or switch mirror when wire truth matters. Chapters 46 and 48 own the Linux and hardware packet paths.

---

## 36.6 ARP and IPv6 Neighbor Discovery — Core

Before sending an Ethernet frame, a host needs the MAC address of its IP **next hop**. Route selection happens first:

```text
destination on-link? ── yes ─► resolve destination address
          │
          no
          ▼
choose gateway ───────────────► resolve gateway address
```

Trying to ARP for an off-link destination is a conceptual error. The remote destination’s MAC never crosses the router. Each routed hop removes an incoming layer-2 envelope and creates a new one for the next link.

### IPv4 ARP

ARP is carried directly in Ethernet with EtherType `0x0806`, not inside IP. For IPv4 over Ethernet its payload contains hardware/protocol types and lengths, operation, sender MAC/IP, and target MAC/IP.

1. The sender broadcasts an ARP Request asking who owns the next-hop IPv4 address.
2. The owner normally unicasts an ARP Reply containing its MAC.
3. The sender records the mapping in a neighbor cache and can transmit the queued IP packet.

ARP provides no authentication. Duplicate addresses, spoofed replies, cache churn, and unresolved-neighbor queue overflow are correctness and security concerns. Cache state, probing timers, queue limits, and garbage collection are OS/configuration facts, not ARP constants.

An unresolved mapping inserts discovery and queueing into the first packet’s path. For a controlled low-latency deployment, choose one of three policies deliberately:

- exercise and monitor dynamic resolution before the session becomes critical;
- keep the peer active and verify neighbor state; or
- install static entries when topology and operational ownership make the configuration risk acceptable.

Static entries remove discovery but can black-hole traffic after legitimate MAC changes. A failover design must update both switch learning and neighbor caches; unsolicited/gratuitous ARP is advisory and can be lost, so the recovery design needs retries and verification.

### IPv6 Neighbor Discovery

IPv6 Neighbor Discovery (ND) uses ICMPv6, not ARP. It combines address resolution with router discovery, neighbor reachability detection, redirects, and parts of address autoconfiguration.

For address resolution, a node sends a Neighbor Solicitation to a solicited-node multicast address derived from the target. The target responds with a Neighbor Advertisement, commonly unicast to the solicitor. ND messages use Hop Limit 255 so a receiver can reject packets that could have crossed a router.

Multicast narrows the audience compared with Ethernet broadcast, but ND still has cache, queue, exhaustion, duplicate-address, and spoofing considerations. Linux exposes both ARP and ND state through `ip neigh`; the protocol differs, while the operational question—“is the next-hop mapping valid now?”—is shared.

---

## 36.7 Switching, Routing, TTL, NAT, and ICMP — Core

Switching and routing solve different forwarding problems:

| Property | Ethernet switching | IP routing |
|---|---|---|
| Scope | one VLAN/layer-2 domain | between IP networks |
| Lookup | destination MAC, commonly exact-match FDB | destination IP, longest-prefix match |
| State source | learned/configured MAC location | connected/static/dynamic routes and policy |
| Unknown destination | often flood within VLAN, subject to policy | no matching route: discard, often with an ICMP error |
| Header change | frame forwarded on the layer-2 path | new L2 envelope; TTL/Hop Limit decremented |
| Loop bound | topology/control mechanisms | TTL or Hop Limit bounds packet lifetime |

Do not attach a universal latency to either row. Cut-through/store-and-forward behavior, ASIC pipeline, queues, frame size, load, and enabled features are **V/M** and belong to Chapter 39.

### TTL and Hop Limit

An IPv4 router decrements TTL; an IPv6 router decrements Hop Limit. If the result is zero, it discards the packet and normally returns a Time Exceeded message. The purpose is to terminate packets caught in routing loops.

Traceroute exploits this behavior by sending probes with increasing TTL/Hop Limit and observing ICMP errors. A missing intermediate reply does not prove forwarding failed: routers may filter or rate-limit control-plane responses while continuing to forward data. Likewise, ping measures an ICMP round trip through two endpoints and a path; it is not a direct measurement of a router’s forwarding latency. Chapter 48 owns precise timestamp placement.

ICMP also reports destination unreachability and packet-too-big conditions. Blanket filtering can break diagnostics and PMTU discovery. Security policy should permit required errors with appropriate validation and rate limiting rather than assuming all ICMP is optional.

### NAT is a rewrite, not routing

Network Address Translation changes IP addresses and sometimes transport ports.
Common NAPT/PAT keeps mapping state so many internal endpoints can share an
external address. An IPv4 translator must update the IPv4 header checksum.
Because TCP and UDP checksums include an IP pseudo-header, a translator that
changes covered addresses must update transport checksums too.

NAT state capacity, idle timeouts, failover, port allocation, and latency are implementation/configuration properties. Do not quote a universal timeout or cost. NAT can create failure ambiguity when a mapping disappears while endpoints retain higher-layer state. Exchange-facing and multicast designs often avoid it, but that is an architecture choice, not an IP rule. Transport liveness belongs to Chapters 37–38 and session recovery to Chapter 54.

---

## 36.8 Three Packet-Arithmetic Exercises — Core

The governing equations are:

\[
T_{\text{serialization}}=\frac{8B_{\text{occupied}}}{R}
\qquad
\text{frames/s ceiling}=\frac{R}{8B_{\text{occupied}}}
\]

Here \(R\) is the stated nominal MAC bit rate in bits/s. The result is a serialization or framing ceiling, not achieved application throughput.

### Exercise 1: minimum-frame packet rate

For minimum untagged frames:

\[
B_{\text{occupied}}=8+64+12=84\text{ byte-times}
\]

At 25 Gb/s in one direction:

\[
\frac{25\times10^9}{84\times8}
\approx37.20\text{ million frames/s}
\]

The serialization interval is \(84\times8/(25\times10^9)\approx26.88\) ns. These are **D** values for continuous minimum frames at the nominal MAC rate. They say nothing about whether a host, switch feature, or application sustains that rate.

For comparison under the same assumptions:

| Nominal MAC rate | Minimum-frame ceiling | Serialization interval |
|---:|---:|---:|
| 1 Gb/s | 1.488 million frames/s | 672 ns |
| 10 Gb/s | 14.881 million frames/s | 67.2 ns |
| 25 Gb/s | 37.202 million frames/s | 26.88 ns |
| 100 Gb/s | 148.810 million frames/s | 6.72 ns |

Do not add a second 64b/66b factor to this MAC-rate calculation. If the question asks for physical lane symbols, coding and FEC belong in a separate PHY model.

### Exercise 2: one tagged IPv4/UDP update

Assume:

- application payload: 100 bytes;
- UDP header: 8 bytes;
- IPv4 header: 20 bytes, no options;
- one 802.1Q tag;
- FCS present on the wire;
- preamble/SFD and interpacket gap included; and
- link rate: 25 Gb/s.

Then:

```text
IP packet                  = 20 + 8 + 100 = 128 B
tagged Ethernet header     = 18 B
MAC frame including FCS    = 18 + 128 + 4 = 150 B
occupied wire byte-times   = 8 + 150 + 12 = 170
application efficiency     = 100 / 170 ≈ 58.8%
serialization              = 170 × 8 / 25e9 = 54.4 ns
```

A host capture might show 146 bytes if it retains the tag but strips FCS, or 142 bytes if hardware also strips the tag. Neither capture length changes the 170-byte-time wire accounting. This is why capture metadata is part of the claim.

### Exercise 3: fragmentation overhead

Use the 4,000-byte IPv4 packet from §36.4 on an untagged 1,500-byte-MTU link. Its fragments have IP Total Lengths 1,500, 1,500, and 1,040.

```text
first two occupied sizes = 8 + (14 + 1500 + 4) + 12 = 1538 each
last occupied size       = 8 + (14 + 1040 + 4) + 12 = 1078
total                    = 1538 + 1538 + 1078 = 4154 byte-times
```

If one larger frame could carry the original IP packet on the same Ethernet conventions, it would occupy:

```text
8 + (14 + 4000 + 4) + 12 = 4038 byte-times
```

Fragmentation therefore adds 116 byte-times: two additional Ethernet envelopes contribute \(2\times38=76\), and two additional IPv4 headers contribute \(2\times20=40\). At 10 Gb/s that extra serialization is 92.8 ns (**D**). The more important costs are extra loss opportunities, classification difficulty, and reassembly tail.

---

## 36.9 A Bounded C++23 Parser and Linux Diagnosis — Core

This parser accepts untagged, single-tagged, or double-tagged Ethernet and returns a bounded IPv4 view. It does not claim that two tags are the protocol maximum; two is an application policy. Unsupported encapsulation is rejected. It never dereferences an overlay struct.

```cpp
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

struct Ipv4View {
    std::size_t offset, header_bytes, packet_bytes;
    std::uint8_t protocol;
};

constexpr std::uint16_t be16(std::span<const std::byte> b,
                             std::size_t p) noexcept {
    const std::uint32_t value =
        (std::to_integer<std::uint32_t>(b[p]) << 8)
      |  std::to_integer<std::uint32_t>(b[p + 1]);
    return static_cast<std::uint16_t>(value);
}

constexpr std::optional<Ipv4View>
parse_eth_ipv4(std::span<const std::byte> b) noexcept {
    if (b.size() < 14) return std::nullopt;
    std::size_t type_at = 12;
    std::uint16_t type = be16(b, type_at);
    unsigned tags = 0;
    while ((type == 0x8100 || type == 0x88a8) && tags < 2) {
        if (b.size() < type_at + 6) return std::nullopt;
        type_at += 4;
        type = be16(b, type_at);
        ++tags;
    }
    if (type == 0x8100 || type == 0x88a8) return std::nullopt;
    const std::size_t ip = type_at + 2;
    if (type != 0x0800 || b.size() < ip + 20) return std::nullopt;

    const auto first = std::to_integer<std::uint8_t>(b[ip]);
    const std::size_t ihl = (first & 0x0fU) * 4U;
    const std::size_t total = be16(b, ip + 2);
    if ((first >> 4) != 4 || ihl < 20 || total < ihl ||
        b.size() - ip < total) return std::nullopt;
    return Ipv4View{ip, ihl, total,
                    std::to_integer<std::uint8_t>(b[ip + 9])};
}

int main() {
    std::byte frame[60]{};
    frame[12] = std::byte{0x08}; frame[13] = std::byte{0x00};
    frame[14] = std::byte{0x45}; frame[16] = std::byte{0x00};
    frame[17] = std::byte{0x14}; frame[23] = std::byte{0x11};
    const auto v = parse_eth_ipv4(frame);
    assert(v && v->offset == 14 && v->packet_bytes == 20 &&
           v->protocol == 17);
}
```

Production policy must add checksum verification, fragment policy, destination checks, and protocol-specific parsing. A truncated capture may be useful to an analyst but should not be presented to this full-packet parser.

### A compact Linux diagnostic sequence

These commands are **L** and require interface/addresses appropriate to the host:

```sh
ip -br link
ip -br address
ip route get 198.51.100.7
ip neigh show nud all
ethtool -k eth0
ethtool -S eth0
tcpdump -ni eth0 -e -vvv -s 0 'arp or icmp or icmp6'
tcpdump -ni eth0 -e -vvv -s 0 'ip[6:2] & 0x3fff != 0'
```

Read them as a narrowing procedure:

1. Confirm link state, MTU, addresses, and VLAN subinterfaces.
2. Ask the kernel which route, source address, gateway, and interface it will use.
3. Inspect next-hop neighbor state.
4. Record offloads before interpreting capture length, tags, or checksums.
5. Compare protocol-visible capture with driver/NIC error and drop counters.
6. Look explicitly for IPv4 MF/offset bits when fragmentation is suspected.

Counter names are driver-specific. A zero application receive count does not locate the drop by itself; correlate switch port counters, NIC counters, kernel counters, socket/stack counters, and application sequence gaps. Chapters 43, 46, and 48 turn that chain into a measurement method.

### HFT application: an executable packet contract

A feed handler should not accept “anything that eventually parses as UDP.” Turn the provisioned network contract into cheap, ordered validation. For one illustrative IPv4 feed, the contract might state:

- ingress interface or receive queue;
- expected VLAN metadata, with a documented policy for stripped tags;
- permitted source and destination MAC categories;
- EtherType IPv4;
- IPv4 Version 4, IHL five unless options are explicitly supported, and Total Length within the captured buffer;
- no IPv4 fragments: MF clear and Fragment Offset zero;
- expected source and destination prefixes, Protocol UDP, and bounded UDP/application length;
- checksum disposition derived from trusted NIC/driver metadata or software verification; and
- application session/channel and sequence checks, owned by Chapters 51 and 53.

Order checks from structural safety to increasingly specific policy:

```text
buffer bound
  └─ Ethernet/VLAN structure
      └─ EtherType
          └─ IP version, IHL, Total Length
              └─ fragment policy
                  └─ addresses and next protocol
                      └─ transport length/checksum
                          └─ application sequence
```

The order is both a correctness boundary and a latency decision. No later load occurs until its containing length has been validated. Unsupported packets take an early, bounded reject path. The hot path increments fixed counters or records a compact reason code; it does not format log strings, allocate, or invoke a control-plane lookup.

Do not hard-code a network accident into the contract. A particular source MAC may legitimately change during failover, while source IP and session identity remain stable. A VLAN may be delivered as descriptor metadata rather than bytes. Check each invariant at the layer where operations promise stability, and provide a rehearsed configuration update path.

For the first packet after startup, readiness should mean more than “socket bound”:

1. the intended interface is up with the intended MTU;
2. route lookup chooses the intended interface and source address;
3. required ARP/ND state is reachable or has been exercised;
4. switch/NIC counters show the expected test traffic;
5. the packet contract accepts a captured canary; and
6. fragmentation and unexpected-encapsulation counters remain zero during the readiness test.

This moves neighbor discovery, VLAN mistakes, and MTU surprises out of the first live order or market-data burst. It does not guarantee future delivery; it establishes a measured precondition and observable failure modes.

---

## 36.10 Reference Notes — Skippable

### Standards route

Use primary specifications for protocol guarantees:

- [RFC 894](https://www.rfc-editor.org/info/rfc894) defines IPv4 encapsulation over Ethernet, including the 46-byte minimum data field, padding outside IP Total Length, and 1,500-byte IP maximum for standard Ethernet.
- [RFC 791](https://www.rfc-editor.org/info/rfc791) defines the IPv4 header, Total Length, flags, and 8-byte Fragment Offset units. Later RFCs update parts of IPv4 behavior, so consult the RFC Editor’s update list for implementation work.
- [RFC 8200](https://www.rfc-editor.org/info/rfc8200/) defines IPv6, its 40-byte base header, source fragmentation, and 1,280-byte minimum IPv6 link MTU.
- [RFC 826](https://www.rfc-editor.org/rfc/rfc826.html) defines ARP; [RFC 4861](https://www.rfc-editor.org/info/rfc4861/) defines IPv6 Neighbor Discovery.
- [RFC 1191](https://www.rfc-editor.org/info/rfc1191/) and [RFC 8201](https://www.rfc-editor.org/info/rfc8201/) specify classical IPv4 and IPv6 Path MTU Discovery.
- [RFC 1071](https://www.rfc-editor.org/info/rfc1071/) explains the Internet checksum calculation and its algebraic properties.

IEEE 802.3 and 802.1Q are normative for Ethernet MAC and VLAN details. Vendor documentation owns maximum accepted frame size, tag handling, FCS retention, checksum/segmentation offloads, switch learning policy, and counters.

### ICMP and traceroute interpretation

ICMP errors quote enough of the invoking packet for the receiver to associate an error with traffic. Relevant families include Destination Unreachable, Packet Too Big, and Time Exceeded. ICMPv4 and ICMPv6 type/code numbers differ; do not reuse an IPv4 filter for IPv6 by changing only the address family.

Ping answers “what round-trip did this ICMP exchange observe?” Traceroute answers “which devices chose to identify themselves for increasing hop limits?” Neither alone proves the application data path, one-way latency, or forwarding delay of an intermediate router. ECMP, asymmetric routes, control-plane rate limiting, tunneling, and policy can all alter the picture.

### A packet-path failure matrix

| Symptom | First hypothesis | Evidence to seek |
|---|---|---|
| No frames at host | link/VLAN/MAC forwarding or capture point | switch and NIC counters, tagged mirror capture |
| First packet delayed after idle | unresolved/stale neighbor or power/scheduler event | ARP/ND trace and neighbor-state transition |
| Small traffic works, large traffic fails | MTU mismatch or PMTU black hole | DF/PTB evidence and size sweep |
| Capture reports bad outbound checksum | transmit checksum offload | offload state and downstream capture |
| Capture shows packet larger than MTU | GSO/TSO/GRO capture artifact | offload state and wire-side capture |
| Fragments arrive but no UDP delivery | missing fragment, reassembly limit, or policy drop | fragment IDs/offsets and reassembly counters |
| Wrong egress interface | route/policy/source-selection error | `ip route get`, rules, and namespace/VRF context |
| Duplicate or intermittent destination | address conflict or neighbor churn | multiple ARP/ND advertisements and MAC moves |

This matrix chooses the next observation. It does not assign a universal cause.

---

## 36.11 Recall and Practice — Core

**Recall card.**

- Ordinary non-jumbo Ethernet frame: 14-byte untagged header,
  payload/padding, 4-byte FCS; 64–1,518 bytes.
- Rate accounting adds 8 bytes of preamble/SFD and 12 byte-times of interpacket gap: minimum slot 84, full untagged 1,500-byte-IP slot 1,538.
- One VLAN tag adds four header bytes to the layer-2 envelope; it does not
  consume IP MTU when the tagged envelope is supported, and on a short frame
  those bytes can replace padding rather than increase total frame size.
- IPv4: IHL in 32-bit words, Total Length in bytes, header checksum, possible fragmentation.
- IPv6: fixed 40-byte base header, extension chain, no base-header checksum, no router fragmentation.
- MTU 1,500 gives 1,472 bytes for IPv4/UDP and 1,452 for IPv6/UDP with minimum headers.
- Resolve the next hop: ARP for IPv4, ICMPv6 Neighbor Discovery for IPv6.
- Route selection is longest-prefix matching; routing replaces the L2 envelope and decrements TTL/Hop Limit.
- Host capture length, tags, checksums, and aggregation can differ from wire reality because of offloads.
- Line-rate packet arithmetic is **D**; achieved throughput and latency are **M**.

### Common traps

- Calling 1,500 bytes “an Ethernet frame.” It is the ordinary IP MTU; the untagged full MAC frame is 1,518 bytes including FCS.
- Adding 20 bytes for preamble/gap to a parser’s frame bound. Those byte-times affect rate arithmetic but are not delivered as MAC-frame bytes.
- Forgetting Ethernet padding and treating all captured bytes after an IP header as IP payload.
- Assuming FCS or VLAN bytes are present in a host capture without checking offload and capture position.
- Double-counting 64b/66b encoding after using the nominal Ethernet MAC bit rate for the 84-byte-time formula.
- Treating a line-rate frames/s ceiling as measured host throughput.
- Resolving the remote destination’s MAC when the route uses a gateway; ARP/ND resolves the next hop.
- Assuming every IPv4 header is 20 bytes or every IPv6 upper-layer header begins at offset 40.
- Confusing IPv4 Total Length, which includes its header, with IPv6 Payload Length, which excludes the 40-byte base header.
- Treating a successful small ping as proof that the path carries full-sized application packets.
- Blocking all ICMP and then diagnosing the resulting PMTU black hole as a transport failure.
- Interpreting bad outgoing checksums or oversized host-capture packets before accounting for checksum and segmentation offloads.
- Quoting a NAT timeout, switch latency, neighbor-cache timer, or jumbo limit without naming the implementation and configuration.
- Casting a packet buffer to a C++ header struct; wire alignment, object lifetime, padding, and bit-field order do not follow from the protocol diagram.

### Interview questions

1. A capture reports 1,514 bytes for a full untagged Ethernet frame. Which four bytes are probably absent, and what else might the capture omit?
2. Derive the 84 byte-times used for minimum-frame packet-rate arithmetic. Which parts are and are not in the MAC frame?
3. Why must an IPv4 parser use Total Length rather than the captured Ethernet payload length?
4. A destination is outside the local prefix. Which IP address is used for route selection, and whose MAC address does the sender resolve?
5. Derive maximum IPv4/UDP and IPv6/UDP application payloads for a 1,500-byte path MTU with minimum headers.
6. Recalculate the three IPv4 fragments for a 4,000-byte IP packet and explain the offset values 185 and 370.
7. Why can an outgoing host capture show an invalid checksum or a packet larger than MTU even when the wire traffic is correct?
8. Contrast an Ethernet FCS, IPv4 header checksum, and UDP checksum by coverage and hop behavior.
9. Why does one missing traceroute hop not prove that router is dropping forwarded application packets?
10. Explain why the theoretical 37.20 million minimum frames/s at 25 Gb/s is not an application throughput claim.

### Puzzle: the 146-byte capture

A feed specification says each update uses a 100-byte application payload over IPv4/UDP and one VLAN. An engineer sees 142-byte packets in `tcpdump`, computes 42 bytes of headers, and concludes the venue omitted the VLAN tag. The switch mirror shows 146 bytes, while a hardware tap’s accounting reports 150-byte frames and 170 occupied byte-times.

Reconcile all four numbers. Identify where FCS, tag metadata, preamble/SFD, and interpacket gap appear or disappear. Then state which number belongs in application-efficiency arithmetic and which one a parser may safely use as its buffer bound.

### Applied exercise

Capture one controlled IPv4/UDP packet at two observation points if possible. Record:

- application payload and transport/IP lengths;
- IHL, Total Length, DF/MF, Fragment Offset, TTL, and checksum status;
- destination/source MAC, EtherType, VLAN tags, and whether FCS is present;
- interface MTU and route/neighbor choice;
- GSO/TSO/GRO, VLAN, and checksum-offload state; and
- the exact formula from application bytes to occupied byte-times.

Repeat with a payload below the Ethernet padding threshold and one near the path MTU. Predict both frame sizes before capture. If observation and prediction disagree, explain the capture boundary before changing the network.

**Prerequisite for Chapter 37.** Be able to distinguish an application message, UDP datagram, IP packet, MAC frame, and occupied wire byte-times; derive the UDP payload limit from a path MTU; and explain why multicast still requires IP-level filtering even after Ethernet MAC filtering.
