# Chapter 37 — UDP and Multicast

**Why this matters.** UDP is small enough to describe in one diagram and easy enough to misuse for years. It preserves datagram boundaries but promises neither delivery nor order. Multicast adds network-managed replication, not reliability. A low-latency receiver therefore has two separate jobs: configure the transport path precisely, then detect when the application protocol's assumptions were violated.

The interview skill is not reciting socket options. It is tracing one datagram from sender to socket, naming every finite queue and filter, and deciding whether a missing sequence means network loss, host overload, or an application stall. This chapter builds that model. Chapter 45 owns socket lifecycle and I/O API selection. Chapter 53 owns feed arbitration, retransmission, snapshots, and book correctness.

**90-second screen.**

Five facts:

1. UDP preserves one datagram as one receive record, subject to truncation when the supplied buffer is too small. It does not guarantee delivery, order, uniqueness, flow control, or congestion control.
2. The UDP checksum covers a pseudo-header, UDP header, and payload. A zero checksum is permitted by ordinary IPv4 UDP but not by ordinary IPv6 UDP.
3. A receive buffer absorbs a finite mismatch between arrival and service. Required payload capacity begins with `arrival_rate × maximum_stall`, then must account for bursts, packet metadata, and safety margin.
4. Multicast membership is scoped by group, interface, and—under source filtering—source. IGMP carries IPv4 membership state; MLD carries IPv6 membership state. Neither protocol makes the data reliable.
5. A sequence gap is application evidence that something was missed or reordered. It does not identify the drop point and cannot by itself choose the correct recovery.

Two decisions:

- Choose UDP only when the application can bound datagrams, pace the sender responsibly, and define behavior for loss, duplication, and reordering.
- For every multicast stream, choose the exact `(source, group, port, interface)` policy and prove membership, delivery, queue capacity, and loss telemetry independently.

Keep six claim layers distinct:

| Layer | Example claim |
|---|---|
| UDP/IP protocol | UDP has an eight-octet base header and does not retransmit |
| Multicast protocol | IGMP/MLD report membership to neighboring multicast routers |
| Socket API | `recvmsg` exposes a message-flags field; RFC 3678 defines source-filter operations |
| Linux behavior | `SO_RXQ_OVFL`, `/proc/net/igmp`, buffer accounting, and error queues |
| Network/vendor behavior | Snooping fallback, NIC filter capacity, queue counters, and multicast routing commands |
| Application protocol | Sequence width, session reset, packet/message count, and recovery rules |

An RFC guarantee does not prove a switch is configured to carry the group. A Linux counter does not define UDP semantics. A venue sequence rule does not come from the kernel. Most multicast debugging mistakes cross one of those boundaries silently.

---

## 37.1 The UDP Contract — Core

UDP is an IP transport protocol identified by protocol number 17. Its durable contract is deliberately small:

| Property | Protocol guarantee |
|---|---|
| Service unit | One datagram with a preserved payload boundary |
| Demultiplexing | Source and destination ports in the UDP header |
| Integrity check | One's-complement checksum over pseudo-header, header, and data |
| Delivery | Not guaranteed |
| Order | Not guaranteed |
| Duplicate suppression | Not guaranteed |
| Retransmission | None |
| Flow/congestion control | None |
| Peer/session state | None in the protocol |

“Preserved boundary” does not mean a receive buffer grows to fit the packet. A datagram-socket receive operation consumes one queued datagram. If the application buffer is shorter, the API returns what fits and discards the remainder. On Linux, `recvmsg` reports `MSG_TRUNC` in `msg_flags`; Linux also gives `MSG_TRUNC` an input-flag behavior that can return the full datagram length. Chapter 45 owns the API variants. The application rule is simpler: size from a protocol maximum and reject truncation explicitly.

A zero-length UDP payload is legal. A return of zero from a datagram receive therefore is not TCP-style end-of-file.

### Ports and demultiplexing

A UDP endpoint is described by addresses and ports, but exact socket selection is an operating-system rule. At the protocol level, the destination port identifies a service at the destination IP. At the host, Linux considers local address, port, device restrictions, connected peer, reuse options, multicast memberships, and namespace state. `SO_REUSEADDR` and `SO_REUSEPORT` consequences belong to Chapter 45 because they are API/lifecycle choices, not UDP guarantees.

Applications commonly identify a multicast feed by at least:

```
(IP version, destination group, UDP destination port,
 source policy, ingress interface, application session/channel)
```

The group alone is not a stream identifier. Two publishers can send to the same group and port, two ports can coexist on one group, and the same addresses can exist in separate network namespaces.

### “Connected” UDP

`connect` on a UDP socket does not perform a handshake or create transport reliability. It records a default peer, permits `send`/`recv` forms, and normally filters received datagrams to that peer. It can also make asynchronous network errors easier to associate with the peer. Linux may report network errors for unconnected sockets as well, and `IP_RECVERR` exposes an error queue; never build portable logic from the myth that unconnected UDP discards every error.

A connected socket may let an implementation retain destination/route state and avoid passing an address on every call. The performance difference is **Linux/kernel/version/workload behavior**, not a UDP property. Measure the target binary. Do not connect a receiver to the group expecting source filtering; request `(S,G)` membership instead.

### When UDP is appropriate

UDP fits when the application prefers current independent messages over an in-order byte stream and can supply the missing policy. Examples include discovery, telemetry, media, queries with application retries, and engineered market-data distribution.

It is not appropriate merely because “latency matters.” A sender without congestion control can overload a receiver, switch queue, or shared path. A request protocol without transaction IDs can misassociate delayed replies. A stateful consumer without sequence numbers can accept silent corruption of its derived state. TCP may be the better choice when ordered completeness and backpressure matter more than avoiding transport head-of-line blocking (Chapter 38).

### Sender pacing and success

A successful UDP send call ordinarily means the local implementation accepted the datagram for processing. It is not an acknowledgement from the receiver, switch, or NIC. Errors can be synchronous (bad arguments, message too large, unavailable local resources) or asynchronous (for example, an ICMP error associated later); exact delivery to the application is never confirmed by UDP.

Size a sender in packets and bytes:

```
packets/second = application_payload_rate / mean_payload_per_datagram
wire demand    = packets/second × bytes_per_packet_on_the_relevant_link
```

The second term includes the header/encapsulation and link framing defined for the calculation in Chapter 36. Bursts matter even when long-window average demand is below link capacity. If a publisher emits `B` bytes nearly instantaneously toward an egress that drains at `C` bytes/s, the ideal serialization interval alone is `B/C`; concurrent traffic and finite queues add delay or loss.

Pacing can be application-timed, kernel-assisted, or NIC/hardware-assisted. Each changes burst shape and timestamp meaning. Batching several datagrams into one syscall reduces call overhead but does not merge their UDP boundaries. Multicast reduces copies on the sender's common path; it does not exempt the publisher from a rate contract. Measure send errors, queue drops, actual inter-packet spacing, and receiver gaps together.

---

## 37.2 Header, Checksum, and Datagram Size — Core

The base UDP header is eight octets:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
┌───────────────────────────────┬───────────────────────────────┐
│          Source Port          │       Destination Port        │
├───────────────────────────────┼───────────────────────────────┤
│            Length             │           Checksum            │
└───────────────────────────────┴───────────────────────────────┘
```

- The source-port field may be zero when unused.
- The destination port supplies the receiving service identifier.
- Length includes header and payload, so the base minimum is eight.
- The checksum is a 16-bit one's-complement checksum.

The checksum input includes a pseudo-header derived from IP source, destination, protocol/next-header value, and UDP length. Those fields are not duplicated on the wire inside UDP; including them detects some forms of misdelivery as well as corruption of UDP data.

For ordinary IPv4 UDP, a transmitted checksum of zero means no UDP checksum was generated. If the computed checksum is numerically zero, it is transmitted as all ones so it cannot be confused with “absent.” Ordinary IPv6 UDP requires a checksum, with narrow standardized exceptions outside the normal application model. Disabling checksums is not a general low-latency recommendation.

The checksum is error detection, not authentication or a strong application-integrity code. It does not sequence messages or identify a malicious sender. If a feed format specifies its own CRC or message authentication, validate that according to the protocol; Ethernet FCS and UDP checksum operate at different scopes.

### Offload and capture

Checksum offload changes where work occurs, not the protocol value on the wire. A host capture on the transmit side may observe a checksum field before the NIC fills it and label a valid eventual packet “bad.” Receive offload can pass checksum-validation metadata upward rather than making the CPU repeat the calculation.

Therefore:

- a sender-side capture alone cannot prove the wire checksum was wrong;
- a receiver capture, NIC statistics, and offload configuration provide separate evidence;
- a kernel-bypass application must follow its NIC/library contract for checksum calculation or offload metadata (Chapter 47).

Feature names and counters from `ethtool` are driver/vendor behavior. Confirm with the deployed driver and, when necessary, an external capture point.

### Size and fragmentation

For IPv4 without options, the largest UDP payload expressible in the ordinary 16-bit IP total length is `65,535 - 20 - 8 = 65,507` octets. That is not a recommendation and is not the path-MTU limit. IP options, IPv6 headers, extension headers, tunnels, VLAN/network encapsulation, and device policy change the payload that fits without IP fragmentation.

Use the equation:

```
maximum unfragmented UDP payload
    = path MTU
      - IP header and extension headers
      - UDP header
```

Chapter 36 owns path MTU and fragmentation rules. The consequence needed here is that reassembly occurs before UDP delivery. If a datagram becomes `k` fragments, losing any fragment loses the entire UDP datagram. Under an oversimplified independent per-fragment loss probability `p`,

```
P(datagram lost) = 1 - (1 - p)^k
```

Real losses are bursty and correlated, so this is an intuition pump, not a production predictor. Fragmentation also consumes reassembly state and can turn one oversized application message into multiple opportunities for queue pressure. Define a protocol payload maximum that fits the verified path and treat a send-side `EMSGSIZE` as configuration evidence, not permission to disable path-MTU discovery blindly.

---

## 37.3 Buffering, Queueing, and Copy Cost — Core

UDP has no receive window. The sender does not learn that the receiver's socket queue is nearly full. Every stage is a finite reservoir:

```
wire
  → switch egress queue
  → NIC receive queue/ring
  → driver/NAPI processing
  → kernel packet object
  → UDP socket receive buffer
  → receive syscall and payload copy
  → application queue/parser
```

A gap can originate at any arrow. One aggregate `packets received` number cannot locate it.

### Buffer capacity is time at a stated rate

Let:

- `R` be peak incoming payload bytes per second over a relevant burst window;
- `T` be the longest application service stall the design intends to absorb;
- `Bburst` be additional burst backlog not represented by `R × T`;
- `H` be headroom for packet metadata, simultaneous streams, measurement error, and scheduling variation.

Then a first estimate is:

```
required usable queue bytes ≥ R × T + Bburst + H
```

This is not “set `SO_RCVBUF` to rate times average parse time.” Averages conceal the stall that fills the queue. Packet count matters too because per-packet metadata and fixed processing can dominate small datagrams. Linux accounts more than payload against a socket receive buffer and commonly reports a doubled `SO_RCVBUF` value for bookkeeping; caps and forced options are Linux/version/configuration behavior. Query the effective value after setting it.

A more general queue model uses cumulative arrivals `A(t)` and completed service `S(t)`:

```
backlog over interval [u,t] = A(t)-A(u) - (S(t)-S(u))
required capacity = maximum positive backlog over all relevant intervals
```

That model handles microbursts and variable parser service without inventing a universal packet rate.

### CPU and copy model

For one receive design, estimate core time as:

```
CPU time / second
  ≈ packets/second × fixed_per_packet_work
   + payload_bytes/second × per_byte_work
   + receive_calls/second × syscall_and_wakeup_work
```

Parsing, allocation, timestamping, ancillary data, cache misses, and application fan-out add terms. `recvmmsg` can amortize calls; busy polling can alter wakeup cost; kernel bypass changes queue ownership and copy structure. Those choices belong to Chapters 45–47. This chapter's rule is to separate per-packet, per-byte, and per-wakeup costs before optimizing.

Larger datagrams reduce packet-rate overhead but increase serialization time, burst size, truncation impact, and fragmentation risk. Smaller datagrams do the reverse. There is no universal ideal payload.

Batching creates a similar trade. A receive call that drains several datagrams can reduce call overhead and keep the parser supplied, but waiting to form a batch intentionally delays the earliest datagram. “Drain everything currently ready” differs from “wait until the batch is full.” Low-latency systems should cap both batch count and time, record the observed batch distribution, and distinguish overload-driven large batches from deliberate amortization.

Queue placement matters as much as queue size. If several busy feeds share one socket or one receive queue, a burst on one can consume capacity and service time needed by another. Separate sockets improve accounting and policy isolation but can increase file descriptors, polling work, and demultiplexing overhead. Separate NIC queues help only when steering is correct and the consuming threads actually drain them. These are Chapters 45–47 design choices; the cost model here identifies which terms to measure.

### Receiving without silent truncation

This compact POSIX datagram helper checks the boundary explicitly:

```cpp
#include <cerrno>
#include <cstddef>
#include <span>
#include <stdexcept>
#include <system_error>
#include <sys/socket.h>
#include <sys/uio.h>

std::size_t receive_datagram(int fd, std::span<std::byte> storage) {
    iovec iov{storage.data(), storage.size()};
    msghdr msg{};
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;

    const auto n = ::recvmsg(fd, &msg, 0);
    if (n < 0)
        throw std::system_error(errno, std::generic_category());
    if ((msg.msg_flags & MSG_TRUNC) != 0)
        throw std::runtime_error("UDP datagram truncated");
    return static_cast<std::size_t>(n);
}
```

The protocol must define the maximum size before this function is called. Production code also handles nonblocking `EAGAIN`, timestamps, source addresses, shutdown, and batching; Chapter 45 owns that lifecycle.

### Loss telemetry by layer

| Layer | Evidence class | Limitation |
|---|---|---|
| Sender/application | Sent sequence and send errors | A successful send is not delivery confirmation |
| Switch/router | Interface and queue drops | Counter names and replication behavior are product-specific (Ch. 39) |
| NIC | Missed/no-buffer/ring counters | Driver names and reset behavior vary |
| IP/UDP stack | Protocol receive/error counters | Aggregated across sockets or namespaces in some views |
| Socket | Effective receive buffer, optional overflow ancillary counter | Not every earlier loss reaches the socket |
| Application | Sequence gaps, truncations, parse rejects, service stalls | Detects effect, not physical cause |

Linux `SO_RXQ_OVFL` can attach a socket-drop count to received messages. It is useful correlation, but a sequence gap with no increment can still be a NIC, network, sender, or application-protocol problem.

---

## 37.4 Multicast Addressing and Replication — Core

IP multicast sends one IP datagram to a group address. Receivers express interest; multicast-capable network elements may replicate traffic toward interested interfaces.

| Mode | Destination | Sender work | Receiver selection |
|---|---|---|---|
| Unicast | One interface address | One datagram per destination | Routing to that host |
| IPv4 broadcast | A broadcast domain | One datagram, normally flooded within scope | All hosts on that broadcast domain |
| Multicast | A group address | One datagram per stream/path | Membership plus forwarding/filter state |

Multicast can reduce sender bandwidth and per-subscriber sender state. It does **not** guarantee equal arrival time. Replication points, link speeds, queueing, topology, receiver NICs, and capture clocks can differ. Claims that every subscriber receives a frame “simultaneously” or within a fixed delta require a named network design and measurement. Switch replication behavior belongs to Chapter 39.

For a payload stream of rate `R` sent separately to `N` receivers, sender-link payload demand is roughly `N×R` before transport/link overhead. With multicast, demand on the sender's common link is roughly `R`, and replication increases traffic only after the branching points. For example, a stated `40 MB/s` stream sent as twenty unicasts would require about `800 MB/s` of sender-link payload capacity, while one multicast copy would require about `40 MB/s` there. That calculation says nothing about downstream oversubscription, per-port copies, or loss.

Choose multicast when receivers intentionally share one published stream, the network can maintain forwarding state, and receivers accept the same pacing/loss domain. Choose unicast when per-receiver authorization, backpressure, individualized content, or ordinary routed reachability dominates. IPv4 broadcast is usually confined to local discovery/control and sends work to every host on the broadcast domain; it is not a substitute for managed multicast membership.

### IPv4 and IPv6 groups

IPv4 multicast uses `224.0.0.0/4`. Important subranges have assigned scope or semantics:

- `224.0.0.0/24` is the local-network control block and is not forwarded by multicast routers.
- `232.0.0.0/8` is the IPv4 source-specific multicast range.
- `239.0.0.0/8` is administratively scoped space.

IPv6 multicast addresses begin with `ff00::/8`; fields encode flags and scope. IPv6 has no IPv4-style broadcast and uses multicast for several control functions. IPv6 SSM uses the `ff3x::/32` service model, with allocation details defined by the relevant RFCs.

A group address identifies a receiver set, not an owner, server, or authenticated source. Administrative allocation must avoid accidental reuse in the relevant routing domain.

### Link-layer mapping is not exact filtering

On Ethernet, an IPv4 multicast group maps into a destination MAC beginning `01:00:5e` using only the low 23 group-address bits. Consequently 32 IPv4 group addresses share one Ethernet multicast MAC mapping. IPv6 multicast maps the low 32 address bits under `33:33`, producing a different many-to-one mapping.

That means a NIC or switch filtering only on multicast MAC may admit traffic for other IP groups. The IP layer still checks the destination group, and UDP demultiplexing still checks the port. A bypass application must reproduce the required IP and UDP filtering itself.

Do not infer a NIC's behavior from the mapping alone. Exact-match tables, hash filters, all-multicast fallback, flow steering, and queue placement are vendor/driver/firmware properties with finite capacities. Verify the actual receive mode and unwanted traffic rate.

---

## 37.5 Membership: IGMP, MLD, and Source Filters — Core

Joining a group changes receiver and local-network control state. It does not contact the UDP sender.

```
application requests membership on interface I
        ↓
host aggregates socket memberships into interface state
        ↓
IGMP report (IPv4) or MLD report (IPv6)
        ↓
neighboring multicast router learns listener interest
        ↓
multicast routing may extend/maintain delivery tree

switch snooping may observe reports and constrain L2 forwarding
```

**IGMP** communicates IPv4 multicast membership between systems and neighboring multicast routers. IGMPv2 added explicit leave behavior; IGMPv3 added source-filter state. The current IGMPv3 specification is RFC 9776, which supersedes RFC 3376 while remaining backward compatible.

**MLD** is the IPv6 counterpart and is carried in ICMPv6. MLDv2 supports source filtering. The current MLDv2 specification is RFC 9777, superseding RFC 3810. Treat ICMPv6 filtering as a correctness issue: blocking required control traffic can break IPv6 multicast membership.

Queries, reports, robustness variables, response intervals, compatibility modes, and state-change retransmissions determine convergence and aging. Their values are configured or protocol-derived and can be changed by the elected querier. There is no universal “join takes X” or “traffic stops after four minutes” rule.

The standards distinguish **per-socket requested state** from **per-interface aggregate state**. Several sockets may request overlapping include/exclude source lists; the host combines them before reporting network-facing interest. Consequently:

- one socket dropping membership may produce no leave/state-change report if another socket still needs the channel;
- a packet visible at an interface can still be rejected for one socket by its source-filter state;
- host tables and a packet capture can disagree temporarily during state transitions without proving data loss;
- membership reports are control messages subject to loss and retransmission rules, not synchronous acknowledgements from every network hop.

Joining before the publisher starts is valid; publishers do not register receivers. Joining after publication begins can miss earlier datagrams because UDP offers no history. Start- and mid-session state recovery belong to Chapter 53.

### ASM and SSM

Any-source multicast (ASM) expresses interest in group `G`, often written `(*,G)`. Source-specific multicast (SSM) expresses interest in channel `(S,G)`.

SSM is attractive for a known publisher because unwanted sources can be excluded by membership/forwarding state and the routed service need not discover an arbitrary source through an ASM rendezvous model. It is not authentication: source addresses can be spoofed within a threat model that permits it.

Costs of SSM include:

- the source address becomes required configuration;
- source migration must be coordinated;
- IGMPv3 or MLDv2 and compatible network state are required;
- a receiver joining the wrong interface or source sees silence that looks like data absence.

IPv4 SSM uses `232/8`; IPv6 defines `ff3x::/32` SSM semantics. Whether a particular enterprise, cloud, switch, or router supports the required path is deployment behavior, not an address-range guarantee.

### Snooping and the querier

IGMP/MLD snooping is a link-layer switch feature: the switch observes membership control traffic and builds per-port forwarding state. It is not part of the host's UDP contract. Without snooping, a switch may flood multicast within the VLAN. With snooping, behavior during absent queries, topology changes, overflow, fast-leave, or control-packet loss is vendor/configuration-specific: implementations may flood, age state, constrain delivery, or fail open/closed according to policy.

The querier supplies periodic membership queries on a LAN. An L2-only VLAN may need an explicit snooping querier even when no multicast router is present. Diagnose with a capture and switch state rather than the folklore timer:

```bash
$ ip maddr show dev eth0
$ cat /proc/net/igmp
$ cat /proc/net/igmp6
$ tcpdump -ni eth0 'igmp or (ip6 protochain 58)'
```

The broad IPv6 protocol-chain filter also captures non-MLD ICMPv6 but follows extension headers instead of assuming a fixed offset. Record report version, group/source, interface, querier address, and actual intervals.

---

## 37.6 Socket and Interface Consequences — Core

Multihomed hosts make implicit selection dangerous. A membership is not merely “join group G”; it must select an interface and, for SSM, a source. Sending similarly needs an egress interface plus multicast hop limit/TTL appropriate to the routed domain.

The RFC 3678 advanced multicast API represents this directly. This compact IPv4 SSM join uses an interface index:

```cpp
#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <netinet/in.h>
#include <stdexcept>
#include <system_error>
#include <sys/socket.h>

void join_ipv4_ssm(int fd, unsigned ifindex,
                   const char* source, const char* group) {
    group_source_req req{};
    req.gsr_interface = ifindex;

    sockaddr_in g{};
    g.sin_family = AF_INET;
    sockaddr_in s{};
    s.sin_family = AF_INET;

    if (inet_pton(AF_INET, group, &g.sin_addr) != 1 ||
        inet_pton(AF_INET, source, &s.sin_addr) != 1)
        throw std::invalid_argument("invalid IPv4 address");

    std::memcpy(&req.gsr_group, &g, sizeof g);
    std::memcpy(&req.gsr_source, &s, sizeof s);
    if (setsockopt(fd, IPPROTO_IP, MCAST_JOIN_SOURCE_GROUP,
                   &req, sizeof req) == -1)
        throw std::system_error(errno, std::generic_category());
}
```

This is the RFC 3678 multicast extension, with platform availability differences. Linux also exposes older IPv4-specific membership structures. Chapter 45 owns socket creation, binding, reuse, nonblocking mode, error handling, and cleanup.

Four consequences matter:

1. **Route and membership are distinct.** The unicast route to a source, multicast route, selected local interface, and socket membership can disagree. “Ping works” proves little about multicast delivery.
2. **Membership is reference-counted/aggregated by the host implementation.** Closing or dropping one socket membership need not remove interface interest if another remains.
3. **Port reuse is not membership.** Binding a port does not request multicast traffic, and joining a group does not establish exclusive ownership of that port.
4. **Loopback is policy.** Multicast loopback controls whether locally transmitted multicast is delivered locally. Leaving it enabled is not inherently wrong; tests and same-host publishers may require it. Define and verify the intended behavior.

### Socket layout choices

| Layout | Benefit | Cost / failure mode |
|---|---|---|
| One socket per stream | Clear ownership, buffer, counters, and parser | More descriptors and polling sources |
| One socket per port, several groups | Fewer polling objects | Membership/demux mistakes share a queue |
| One socket for many channels | Easy batching | One burst or parser stall can affect every channel |
| Separate socket per redundant path | Independent queue/drop evidence | Merge and lifecycle complexity (Ch. 53) |

Linux delivery when multiple sockets bind the same address/port depends on bind address, multicast membership, reuse options, connected peer, and kernel behavior. Do not assume unicast `SO_REUSEPORT` load distribution is the same as multicast fan-out. Design a small on-target test for the intended bind/join order and inspect every receiving socket. Chapter 45 owns the rules and setup sequence.

### Filtering funnel

For a received stream, state every layer:

```
switch port forwarding
  → NIC MAC/flow filter and receive queue
  → host IP destination and source filter
  → UDP destination-port/socket demultiplexing
  → application session, channel, sequence, and schema checks
```

Hardware flow steering can direct a flow to a queue, but supported match keys, table capacity, precedence, and fallback vary. An exact `(source IP, group IP, UDP port)` rule is valuable only if the NIC actually supports it and the deployment confirms the queue. Chapter 46 traces the kernel packet path; Chapter 47 covers bypass.

### Where local membership ends

IGMP or MLD reports listener interest to neighboring multicast routers. It does not itself build the entire routed tree. A routed multicast deployment can involve multicast-routing protocols and forwarding entries commonly described with:

- `(*,G)` or `(S,G)`;
- an incoming interface expected for the source/tree;
- outgoing interfaces toward listeners;
- timers and policy controlling retention.

**Reverse-path forwarding (RPF)** is a central failure mechanism. A router typically accepts multicast from a source on the interface its routing logic expects toward that source or tree. If traffic arrives elsewhere because of asymmetric routing, route changes, or mismatched multicast topology, it may be dropped even though ordinary unicast reachability works.

Other boundary failures include:

- multicast TTL or hop limit expires before the receiver;
- the sender uses an address outside the provisioned scope;
- SSM source and receiver configuration disagree;
- ASM tree or rendezvous state is absent or wrong;
- an ACL blocks UDP data or IGMP/ICMPv6 control;
- a tunnel, VRF, VLAN, or namespace separates sender and membership;
- the cloud or virtual network does not provide the requested multicast service.

These do not justify a universal router command: vendors represent RPF and multicast forwarding differently. The application should provide precise channel identity and capture evidence; the network operator should prove incoming/outgoing interface state. Chapter 39 owns switch replication and queue behavior.

| Symptom | What it proves | What it does not prove |
|---|---|---|
| Unicast ping to source works | Some unicast/ICMP path exists | Multicast RPF, tree, membership, TTL, or UDP path |
| Host sends a membership report | Local control request left an interface | Every hop installed forwarding state |
| Switch forwards group to port | L2 delivery was intended there | NIC, socket, source filter, or parser acceptance |
| Router has `(S,G)` state | A forwarding/control entry exists | No downstream queue loss or host overload |
| NIC capture sees packet | Frame reached that capture hook | Correct socket delivery or parsing |

---

## 37.7 Loss, Reordering, and the Recovery Boundary — Core

UDP exposes no sequence number. If completeness matters, the application protocol needs a session/channel identity and sequence semantics.

For a simple monotonically increasing, nonwrapping sequence within one session:

```
seq == expected  → in order; accept and advance
seq <  expected  → duplicate or late arrival
seq >  expected  → gap or reordering; expected is missing now
```

Real protocols complicate this with wraparound, packet-versus-message numbering, multiple messages per datagram, resets, epochs, and session changes. Implement the protocol definition, not a generic signed-difference trick copied from TCP.

Suppose a packet header carries the sequence of its first contained message and a message count. The next expected value may be `first + count`, not `first + 1`. A heartbeat may consume no sequence or may occupy one, depending on the venue. A new session can legitimately reset numbering. These are schema/protocol facts and must be tested with captures around empty packets, batching boundaries, wrap/reset, and session rollover.

A newly observed gap does not tell you:

- whether the sender emitted the sequence;
- whether the network reordered it;
- whether another redundant path will supply it;
- whether a switch, NIC ring, socket buffer, or application queue dropped it;
- whether the receiver parsed the session or count incorrectly.

The transport layer should emit evidence: expected and observed sequence, session/channel, receive timestamp, ingress path, relevant overflow counters, datagram length, and parser outcome. It must not silently apply state across a known gap.

What happens next belongs to Chapter 53. That chapter decides whether to wait briefly for reordering, accept a redundant copy, request retransmission, buffer later messages, acquire a snapshot, mark instruments stale, or stop publication. A/B arbitration is not “zero latency”: it has receive, merge, buffering, and coordination cost, while its tail benefit depends on path independence and measured arrival distributions. Retransmission and snapshot timers are protocol/venue configuration, not UDP constants.

Reliable-multicast patterns such as NAKs, suppression, repair multicast, FEC, and snapshots similarly belong to the feed-correctness design. The only transport conclusion needed here is that UDP and multicast provide none of them automatically.

The interface between chapters should be explicit:

| Transport supplies to recovery | Recovery supplies to transport/application |
|---|---|
| Session/channel and expected/observed sequence | Whether the channel is publishable or stale |
| Bytes, source, path, timestamp, truncation status | Whether to wait, arbitrate, retransmit, snapshot, or reset |
| Later datagrams drained under a bounded contract | Buffer ownership, capacity, expiry, and overflow action |
| NIC/socket/application overflow evidence | Escalation and retry/rate-limit policy |
| Membership/path health events | Whether loss is local, path-wide, or session-wide |

An ACK-per-receiver scheme can create feedback proportional to receiver count; NAK suppression, multicast repair, or FEC can change that scaling. Redundant feeds can cover independent path loss but add duplicate work and correlated-failure analysis. Snapshots can restore a state image but must be reconciled with incrementals. Chapter 53 owns those algorithms because correctness depends on the feed schema, not on UDP.

---

## 37.8 Worked Design and Loss Diagnosis — Core

Suppose a feed handler has these measured/design inputs:

- twelve IPv4 SSM channels, each with a documented source, group, and port;
- two physical ingress interfaces intended to represent separate paths;
- aggregate peak payload rate over the chosen burst window: `80 MB/s`;
- maximum application stall the design intends the socket queue to absorb: `3 ms`;
- observed excess microburst backlog above that rate model: `96 KiB`;
- maximum protocol datagram: `1,400 bytes`, verified below the deployed path limit.

These numbers describe this scenario only.

### Step 1: specify identity before sockets

Create a configuration record per channel:

```
path, interface index, source IP, group IP, UDP port,
session/channel identifier, maximum datagram, expected rate envelope
```

Validate that the interface is up, has the expected address, and maps to the intended NIC/queue. Join `(S,G)` on that interface. Do not accept “the default route chose the right NIC” as a production invariant.

### Step 2: estimate and verify buffering

Payload backlog estimate:

```
80 MB/s × 0.003 s + 96 KiB
  ≈ 240,000 B + 98,304 B
  = 338,304 B ≈ 330.4 KiB
```

That is not the `SO_RCVBUF` setting. Add packet-accounting and safety headroom, decide whether twelve channels share a socket or have separate queues, respect system caps, set a candidate, and query the effective value. Then generate a production-shaped burst and stall; observe sequence gaps, socket overflow indications, and kernel/NIC counters. A larger buffer is successful only if it reduces loss without creating unacceptable stale backlog or memory usage.

### Step 3: separate membership from data

Capture control traffic and check host membership state. Verify:

- the report contains the intended group and source;
- it leaves through the intended interface;
- a querier is present where the design requires one;
- switch forwarding state points at the receiver port;
- the data packet arrives with expected source, group, port, TTL/hop limit, and length.

A correct join with no data may mean the publisher is silent, routing has not built the path, TTL/hop limit is insufficient, source filtering disagrees, or switch/router state is wrong. “Rejoin repeatedly” is not a diagnosis.

### Step 4: diagnose a gap causally

At sequence 500,000 the application observes 500,004. Preserve the event and compare deltas:

| Observation | Stronger hypothesis | Next corroboration |
|---|---|---|
| Both paths miss the same sequence | Sender/shared-upstream issue or parser/session error | Sender capture/reference receiver and raw packet trace |
| NIC missed/ring counter rises on path A only | Host cannot drain that receive queue | Queue mapping, interrupt/NAPI load, ring occupancy |
| Socket overflow counter rises, NIC clean | Application/socket service stalled | Scheduler and receive-call timeline |
| Raw packet captured, application sequence absent | Demux, truncation, parser, or application queue | Length/flags/socket identity/parser reject metrics |
| Packet arrives later with lower sequence | Reordering | Arrival delta distribution; Chapter 53 policy |
| No local counters, upstream port drops rise | Network queue loss | Switch telemetry and burst timeline (Ch. 39) |

No single counter proves causality. Counters can be aggregated, delayed, wrapping, or reset. Align them with the sequence event and a common timebase.

### Step 5: hand off correctness

The transport component reports a typed event and continues draining according to a bounded policy. It does not invent missing order-book updates. Chapter 53 consumes this evidence and applies the venue-specific redundancy/recovery state machine. That boundary keeps socket tuning from becoming entangled with trading-state correctness.

---

## 37.9 Diagnostic Runbook — Reference

Skippable until operating a Linux multicast receiver. Begin read-only and archive outputs with kernel, driver, firmware, switch, and topology identity.

### Host and membership

```bash
$ ip -details link show dev eth0
$ ip addr show dev eth0
$ ip route get 192.0.2.10
$ ip maddr show dev eth0
$ cat /proc/net/igmp
$ cat /proc/net/igmp6
$ ss -u -a -n -m
```

`ip route get` shows unicast route selection, not proof of multicast forwarding. `ip maddr` includes link-layer and protocol memberships but does not prove packets reach a specific socket.

### Packet and control evidence

```bash
$ tcpdump -ni eth0 'udp and dst host 232.1.2.3 and dst port 9000'
$ tcpdump -ni eth0 'igmp or (ip6 protochain 58)'
$ ethtool -k eth0
$ ethtool -S eth0
$ nstat -az
```

Use bounded captures and appropriate privileges. Capture placement relative to offloads matters. Driver counter names must be interpreted with the driver's documentation.

### Application evidence

Record per `(session, channel, path)`:

- datagrams and bytes received;
- last sequence and expected sequence;
- gaps, duplicates/late arrivals, truncations, parse rejects;
- `SO_RXQ_OVFL` deltas where enabled;
- receive-batch size, service time, and longest interval without draining;
- effective socket-buffer size;
- control-plane membership changes.

### Failure order

1. Confirm publisher/source, group, port, and session from authoritative configuration.
2. Confirm interface, source-specific membership, and report traffic.
3. Confirm switch/router delivery state with the network owner.
4. Confirm bytes at the NIC/capture point.
5. Compare NIC, stack, socket, and application counters over the same interval.
6. Reproduce with a controlled rate/burst and one change at a time.

Avoid mutable “fix” commands in a diagnostic pastebook. Changing IRQ affinity, ring size, receive buffers, snooping, querier configuration, or flow steering requires a benefit hypothesis, cost, prerequisite, rollback, and success metric. Socket setup belongs to Chapter 45, switch behavior to Chapter 39, and measurement discipline to Chapter 43.

### Conditional changes

| Candidate | Benefit hypothesis | Cost and prerequisite | Rollback / success measure |
|---|---|---|---|
| Increase receive buffer | Absorb a measured burst or service stall | Memory plus older queued data; system cap and per-socket accounting understood | Restore old setting; overflow/gap tail falls without unacceptable backlog age |
| Split streams across sockets | Isolate bursts and counters | More descriptors and polling/demux work | Return to shared socket; cross-stream loss correlation falls |
| Split flows across NIC queues | Parallelize fixed per-packet work | NIC rule capacity, queue/IRQ/thread mapping, extra cores | Remove rule; queue imbalance and application tail improve |
| Switch ASM membership to SSM | Reject unintended sources and simplify known-source service | Correct source inventory and IGMPv3/MLDv2 path | Restore ASM; unwanted-source traffic or ambiguity disappears |
| Increase datagram payload | Reduce fixed per-packet/call work | Verified path MTU and increased loss/truncation blast radius | Restore payload; packet CPU falls without fragmentation/errors |
| Increase receive batch | Amortize calls under load | Added head-of-batch delay and burstier downstream service | Restore cap; CPU falls while early-packet latency stays within objective |
| Change snooping/querier policy | Correct missing or excessive L2 forwarding | Network-owner approval and redundant management access | Restore switch config; membership survives tested transitions |

Do not change all rows together. A larger socket buffer can hide a parser stall while a queue-steering change appears successful; a snooping change can replace loss with flooding and host CPU load. One controlled change preserves causal evidence.

### Protocol references

- UDP base format and semantics: [RFC 768](https://www.rfc-editor.org/rfc/rfc768.html)
- IPv4 multicast host model: [RFC 1112](https://www.rfc-editor.org/rfc/rfc1112.html)
- Current IGMPv3: [RFC 9776](https://www.rfc-editor.org/rfc/rfc9776.html)
- Current MLDv2: [RFC 9777](https://www.rfc-editor.org/rfc/rfc9777.html)
- Source-specific multicast: [RFC 4607](https://www.rfc-editor.org/rfc/rfc4607.html)
- Multicast source-filter API: [RFC 3678](https://www.rfc-editor.org/rfc/rfc3678.html)
- Linux details: `udp(7)`, `ip(7)`, `socket(7)`, and the deployed kernel/driver documentation

---

## 37.10 Recall and Practice — Core

**Recall card.**

1. UDP is a best-effort datagram service with ports, length, and checksum—not a reliable message queue.
2. Datagram boundaries survive; excess bytes do not. Check `MSG_TRUNC`, and remember that zero-length UDP is legal.
3. Checksum semantics are protocol facts; where checksum work occurs is offload behavior. A transmit-host “bad checksum” capture can be pre-offload.
4. Queue capacity is a backlog bound: start with peak rate times maximum intended stall, then add burst, metadata, and margin and verify the effective buffer.
5. Multicast group membership is scoped by interface and optionally source. IGMP is IPv4; MLD is IPv6; snooping is a switch feature.
6. ASM is `(*,G)`; SSM is `(S,G)`. SSM filters by named source but does not authenticate it.
7. Multicast replication reduces sender copies; it does not guarantee equal arrival time, no loss, or ordering.
8. A sequence gap detects a protocol discontinuity, not its location or recovery. Chapter 53 owns recovery correctness.

**Common traps.**

- Treating a successful `sendto` as delivery confirmation.
- Reading zero bytes from UDP as stream EOF.
- Ignoring `MSG_TRUNC` or assuming the next receive returns the remainder.
- Hard-coding `MTU - 28` without accounting for IP version, extensions, options, or tunnels.
- Trusting a sender-side checksum capture without checking offload placement.
- Joining a group without specifying the intended interface on a multihomed host.
- Confusing bind/reuse rules with multicast membership.
- Treating IGMP/MLD reports as an end-to-end data-path guarantee.
- Assuming no querier always produces the same timed failure on every switch.
- Filtering a bypass stream only by the many-to-one multicast MAC.
- Increasing `SO_RCVBUF` without measuring application stall and resulting stale backlog.
- Applying application state across a known gap instead of handing it to Chapter 53's recovery policy.

**Questions.**

1. What does UDP guarantee about a datagram, and what five properties does it deliberately omit?
2. Why does the checksum include an IP pseudo-header, and how do IPv4 and ordinary IPv6 zero-checksum rules differ?
3. Derive an unfragmented payload limit from a stated path MTU and header stack.
4. Why can a larger receive buffer reduce drops yet worsen the usefulness of delivered data?
5. Distinguish group address, UDP port, source filter, ingress interface, and application channel.
6. What state does IGMP or MLD communicate, and what does a snooping switch infer from it?
7. Compare ASM and SSM, including one benefit and two operational costs of SSM.
8. A sequence gap occurs with no socket-overflow increment. Name four still-plausible causes and evidence for each.
9. Why can two multicast subscribers receive the same datagram at different times even though the sender transmitted one copy?
10. Which decisions must Chapter 37 hand to Chapter 53 after detecting a gap?

**Calculation exercise.** A receiver measures `R` bytes/s over its worst relevant burst window, must tolerate a service pause of `T`, and observes extra burst backlog `E`. Derive the payload lower bound. Then list every reason the requested Linux `SO_RCVBUF` value may need to differ from `R×T+E`, and design an experiment that finds whether bytes, packets, or wakeups bind first.

**Scenario puzzle.** A feed works on one interface in a lab. In production the host shows the intended SSM membership, but no application packets arrive. A capture on the ingress NIC sees the group from the wrong source address; the switch shows forwarding to the port; a second socket bound to the same port receives a different group. Explain why “multicast is broken” is not a diagnosis. Identify the source-filter mismatch and the independent socket-demultiplexing/reuse question, state which facts are protocol versus Linux behavior, and propose read-only evidence before any configuration change.

**Prerequisites for the next chapter.** Chapter 38 assumes you can contrast UDP's datagram/loss contract with TCP's reliable ordered byte stream. Chapter 39 assumes you understand that multicast membership creates desired forwarding state but that replication, queueing, and drop behavior depend on the switch. Chapter 45 owns socket lifecycle; Chapter 53 owns feed recovery and stale-state correctness.
