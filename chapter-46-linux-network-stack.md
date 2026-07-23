# Chapter 46 — The Linux Network Stack

## Why This Matters — Core

Linux networking is easiest to reason about as a sequence of ownership transfers separated by queues. A received packet moves from a NIC-owned receive queue to driver-owned buffers, through kernel protocol processing, into a socket receive queue, and finally into application memory. A transmitted packet moves in the other direction through a socket send queue, protocol and routing state, an optional queueing discipline, a driver queue, and a NIC-owned descriptor ring.

That model gives this chapter its practical rule:

> For a drop or latency spike, find the first queue or stage whose counter changes. Measure its producer, consumer, occupancy, and service CPU before changing its capacity or policy.

Larger rings and buffers may postpone loss while increasing queueing delay. More queues may reduce contention while scattering cache state. Polling may avoid a wakeup while consuming an entire CPU. Offloads may reduce packets per second seen by the CPU while changing where bursts appear. There is no universally fast setting.

This chapter describes mainstream Linux with a multiqueue Ethernet NIC. Kernel configuration, kernel release, driver, firmware, NIC, virtualization layer, and namespace topology can all change details. `struct sk_buff` field layout, threaded NAPI, hardware counters, offload support, and exact hook placement are implementation facts—not architecture guarantees. Confirm them on the deployed system.

## 90-Second Screen — Core

When a Linux service reports packet loss or a latency regression, collect a synchronized before/after snapshot:

```bash
IFACE=eth0

uname -r
ip -details link show dev "$IFACE"
ip -s -s link show dev "$IFACE"
ethtool -i "$IFACE"
ethtool -k "$IFACE"
ethtool -g "$IFACE"
ethtool -c "$IFACE"
ethtool -l "$IFACE"
ethtool -x "$IFACE"
ethtool -S "$IFACE"
grep -E "$IFACE|CPU" /proc/interrupts
cat /proc/net/softnet_stat
nstat -az
ss -mti
tc -s qdisc show dev "$IFACE"
```

Some virtual devices or drivers reject some `ethtool` queries; that absence is itself topology information. Capture the same commands during a healthy interval and during the event, preferably with application request rates, sequence gaps, CPU utilization, and latency histograms on the same time axis.

Interpret the first deltas, not the largest lifetime totals:

| First changing evidence | Likely boundary | Next question |
|---|---|---|
| NIC missed/no-buffer/FIFO counter | NIC RX queue or driver refill | Was one hardware queue starved or its ring exhausted? |
| Interface `rx_dropped` but no NIC miss | driver or early kernel receive path | Is NAPI/backlog processing falling behind? |
| `/proc/net/softnet_stat` drop or squeeze-like field | per-CPU receive processing | Is one CPU overloaded, throttled, or poorly steered? |
| UDP receive-buffer errors | socket receive queue | Is the application draining slowly or is the buffer too small for the measured burst? |
| TCP retransmissions with no local drop evidence | path or peer, not proved local | Do packet capture and peer counters locate the loss? |
| qdisc backlog/drop grows | software TX queue | Is offered load above service rate or is the qdisc policy intentional? |
| driver TX busy/timeout or BQL in-flight stalls | driver/NIC TX boundary | Are completions delayed, the queue stopped, or the link blocked? |

Counter names and semantics vary. In particular, `ethtool -S` is a driver/vendor interface: never map an unfamiliar name to a cause without the driver documentation or a controlled test. `/proc/net/softnet_stat` is a versioned hexadecimal record; use the documentation or source matching the running kernel before assigning column meanings.

## 46.1 One Packet, End to End — Core

The common receive path is:

```text
wire
  |
NIC parser/filter/RSS
  |
RX queue: posted buffer descriptors <--- driver refills
  | DMA packet bytes, write completion
MSI-X interrupt or active polling
  |
NAPI poll: reap completions, build packet representation
  |
[XDP, when attached] -> driver/GRO entry -> Ethernet demux
  |
[tc ingress / netfilter hooks, according to configuration]
  |
IP validation -> routing decision -> UDP/TCP demux
  |
socket receive queue / socket backlog
  |
wakeup, readiness notification, or application polling
  |
recv()/recvmsg(): normally copy payload to user memory
```

The common transmit path is:

```text
application send()/sendmsg()
  |
normally copy or pin/reference user data under an explicit zero-copy API
  |
socket memory accounting and protocol queue
  |
TCP segmentation state or UDP datagram construction
  |
route and neighbor lookup -> filtering/traffic-control hooks
  |
qdisc (or a direct/noqueue path)
  |
TX queue selection -> driver descriptor ring
  |
DMA mapping and doorbell, often batched
  |
NIC segmentation/checksum -> wire
  |
TX completion -> reclaim mappings/skbs -> possible writer wakeup
```

These are maps, not promises that every packet executes every box. Loopback has no physical DMA. A veth pair transfers packets between two `net_device` instances. A bridge may forward at layer 2. XDP can drop or redirect before an `sk_buff` exists in common driver modes. GRO can combine multiple received packets into one larger object for later stack processing. TCP can coalesce writes, retain data for retransmission, and segment later. A qdisc may be bypassed when empty or absent. Virtualized NICs may add host and guest queues.

The ordering guarantee is usually flow-scoped, not global. RSS tries to keep a flow on one receive queue; RFS and XPS take care when moving a flow; TCP restores a byte stream despite network reordering. Packets from unrelated flows can be processed in any relative order.

### Name the ownership boundary

At any point, ask who may reuse the storage:

1. The driver posts empty receive buffers and descriptors to the NIC.
2. The NIC owns those descriptors until it reports completion.
3. The driver reclaims completed entries and passes packet storage upward, often with recycling machinery.
4. Kernel layers may share, clone, fragment, aggregate, or copy the storage.
5. The socket owns accounted receive data until the application consumes it or it is dropped.
6. On transmit, the driver must retain DMA-visible storage until the device reports completion.

These ownership rules explain why “zero copy” never means “zero bookkeeping.” It substitutes pinning, reference counts, completion notifications, DMA mapping, and lifetime constraints for a payload copy. Chapter 45 owns socket API details; Chapter 47 owns kernel-bypass APIs.

## 46.2 DMA Rings, Interrupts, and NAPI — Core

### Descriptor rings

A descriptor ring is a bounded producer-consumer data structure shared by a driver and a device. Its entries describe buffers and carry completion state. The exact descriptor format, memory ordering protocol, and head/tail mechanism belong to the NIC and driver.

On receive, the driver allocates or recycles buffers, maps them for DMA as required by the platform, and posts descriptors. The NIC consumes a descriptor, transfers packet data, and records completion. The driver then:

- validates the completion and packet length;
- synchronizes DMA memory when the platform requires it;
- constructs or attaches the Linux packet representation;
- supplies a replacement buffer;
- advances its consumer state.

If the NIC receives faster than buffers are replenished, it can run out of usable descriptors. The observable result might be a NIC “no buffer,” “missed,” FIFO, or queue-specific drop counter. Ring depth changes burst tolerance, not steady-state service capacity:

\[
T_{\text{burst}} \approx \frac{D}{\lambda-\mu}
\]

where \(D\) is available descriptors, \(\lambda\) is arrival rate, and \(\mu\) is the rate at which the driver returns usable entries during the burst. This is a diagnostic approximation. Packet sizes, coalescing, shared resources, and refill batches make real systems less tidy.

On transmit, the driver maps packet storage, fills one or more descriptors, and notifies the device. The NIC reads the data and later completes the entry. Until completion, the driver cannot free or modify storage still visible to the NIC. A full ring causes backpressure: the driver may stop the software TX queue and restart it after completions.

Increasing a ring can absorb a longer burst, but can also permit a longer residence time and consume more memory. Decreasing it can expose overload sooner but drop otherwise survivable bursts. Treat `ethtool -G` as an experiment gated by driver support, not a recipe.

### Interrupts are notifications, not packet execution

Modern multiqueue PCIe NICs commonly associate queue vectors with MSI-X interrupts. One interrupt may report many completions, and a vector may cover RX, TX, or other events. On the usual receive path:

```text
first completion(s)
  -> device raises interrupt
  -> short driver interrupt handler masks/acknowledges events
  -> handler schedules a NAPI instance
  -> NAPI poll drains RX and often TX completions
  -> if complete, NAPI completes and interrupts are re-enabled
```

NAPI is Linux’s event-processing abstraction for networking. Its driver poll method receives a work budget. It normally runs in software-interrupt context, but supported kernels and drivers can use threaded NAPI; busy-poll mechanisms can also drive NAPI from another context. Therefore, “NAPI always runs in the interrupting task” and “NAPI is a dedicated thread” are both wrong as general statements.

If work remains after a poll budget or global softirq limit is reached, processing is deferred. Under sustained load, networking work may appear in `ksoftirqd/N` and acquire scheduler latency. Budget exhaustion is not itself proof of packet loss: it is evidence that work remains queued. Loss occurs when a bounded queue upstream fills, memory allocation fails, a policy drops, or a protocol rejects the packet.

The per-CPU networking backlog is important when a driver injects packets through the backlog path or when RPS hands work to another CPU. It is distinct from a NIC descriptor ring and from a socket receive queue. Raising `net.core.netdev_max_backlog` changes how much work may wait there. It cannot repair a CPU whose long-term arrival rate exceeds its service rate.

Do not confuse the receive work budget passed to a NAPI poll with a generic “TX budget.” A poll method commonly reclaims TX completions too, but transmit pressure is observed through completion progress, stopped/woken TX queues, BQL, qdisc backlog, and descriptor availability. Those mechanisms and their accounting are driver- and kernel-version-specific.

### Coalescing: fewer notifications, more waiting

Interrupt moderation lets the NIC wait for a packet count, a timer, or adaptive policy before notifying the host. The conceptual trade is:

| Policy direction | Expected benefit | Expected risk | Measure |
|---|---|---|---|
| More coalescing | fewer interrupts, larger batches, better throughput per CPU | first packet waits longer; bursts become lumpier | IRQ rate, packets/poll, CPU, p50/p99/p99.9 |
| Less coalescing | earlier notification, smaller batches | interrupt storm, less batching, reduced throughput headroom | same metrics plus softirq saturation |
| Adaptive moderation | follows changing traffic without a fixed compromise | driver/firmware policy may be opaque or unstable for the workload | phase-specific latency and actual settings |

`ethtool -c` shows what the driver exposes. `ethtool -C` requests a change, but available fields and meanings are device-specific. A safe experiment records the old output, changes one supported field, runs the same workload, and restores the original value if tail latency, drops, or CPU headroom worsens.

### A compact NAPI failure timeline

```text
t0  one RX queue receives a burst
t1  IRQ schedules its NAPI poll
t2  poll consumes its budget; more completions remain
t3  processing is deferred; that CPU's queued work grows
t4  application socket is not yet receiving these packets
t5  first bounded upstream queue fills
t6  a counter at that boundary increments
```

The wrong response is “increase every buffer.” The right response is to determine whether the first full boundary was hardware RX, per-CPU backlog, protocol memory, or socket receive memory. Then investigate why its consumer fell behind: steering skew, CPU interference, application pause, allocation pressure, filtering cost, or a true offered-load excess.

## 46.3 `sk_buff`, Copies, Cache Traffic, and Wakeups — Core

`struct sk_buff`, usually called an skb, is Linux’s primary packet metadata object. The structure itself describes packet data; it does not contain all packet bytes inline. Data may live in a linear head buffer, page fragments, or a fragment list. An skb also carries protocol offsets, device and route state, checksum/offload metadata, marks, timestamps, a flow hash, and references used by later layers.

Never memorize its byte size as an architectural fact. Size and layout change with kernel release, architecture, configuration, debugging features, and compiler. The durable ideas are:

- allocation and initialization touch metadata and allocator state;
- the linear head makes protocol headers convenient to parse and modify;
- fragments avoid copying large payloads but add indirection;
- `skb_clone()` creates new metadata while sharing packet data;
- modifying shared headers can require copy-on-write;
- a layer that requires contiguous bytes may pull data into the linear area;
- a layer that cannot consume scatter-gather data may force linearization;
- socket memory accounting uses charged sizes such as skb `truesize`, not simply wire payload bytes.

Cloning is cheaper than copying payload, but it is not free: metadata allocation, reference counting, cache-line ownership, and later copy-on-write remain. Linearization cost depends on the number and location of fragments and bytes copied. Measure actual rates with suitable tracepoints or profiles; do not multiply a guessed skb size by packets per second.

### A cost model that survives hardware changes

For a received batch, think in named terms:

\[
C_{\text{RX}} =
C_{\text{notify}} +
C_{\text{DMA/coherence}} +
C_{\text{descriptor}} +
C_{\text{metadata}} +
C_{\text{protocol}} +
C_{\text{filter}} +
C_{\text{queue}} +
C_{\text{wake}} +
C_{\text{copy}}
\]

For a transmitted batch:

\[
C_{\text{TX}} =
C_{\text{syscall}} +
C_{\text{copy/pin}} +
C_{\text{protocol}} +
C_{\text{route/neighbor}} +
C_{\text{qdisc}} +
C_{\text{descriptor}} +
C_{\text{completion}}
\]

These are categories, not independent constants. GRO changes packet count and metadata work. Coalescing amortizes notification overhead but adds waiting. Steering can move cache lines and cause an inter-processor interrupt. A copy may be cheaper than sharing a cache line across sockets or NUMA nodes. A sleeping application adds a wakeup and scheduler decision; an already-running event loop may simply observe readiness; a busy-polling thread spends cycles to avoid waiting for the interrupt and wakeup path.

Measure the following distributions or rates:

- packets and bytes per IRQ and per NAPI poll;
- RX/TX work per hardware queue;
- softirq time and run-queue delay per CPU;
- socket queue occupancy and application drain gaps;
- qdisc backlog and driver in-flight bytes;
- allocation failures, skb clone/linearize hot spots, and cache misses when profiling justifies that depth;
- latency from NIC or software timestamp to application handling, with clock provenance understood.

### Protocol demultiplexing

After early ingress processing, Ethernet protocol identifies IPv4, IPv6, ARP, or another handler. IP validates headers, applies configured hooks, and makes a local-delivery or forwarding routing decision. For local traffic, the transport protocol identifies UDP, TCP, or another protocol; address/port tables then find a socket. `SO_REUSEPORT` can distribute matching traffic among a group, and an attached reuseport BPF program can select the socket. Those selection rules are application architecture, while the hash and table internals are versioned Linux implementation.

TCP and UDP expose different queue semantics. UDP normally enqueues complete datagrams; when receive memory is exhausted, datagrams can be dropped and error counters rise. TCP queues a reliable ordered byte stream, retains out-of-order and retransmission state, advertises receive-window changes, and applies flow/congestion control. A slow TCP reader more often propagates backpressure than produces a local UDP-style receive-buffer drop.

## 46.4 Socket Queues and Memory Accounting — Core

A socket receive queue holds data ready for the application. A Linux socket can also have a backlog used when protocol input cannot immediately acquire the socket in the normal receive path; that backlog is processed when ownership is released. Exact locking and queue details are kernel implementation, but the latency lesson is stable: a packet can have finished IP/TCP/UDP demultiplexing and still wait behind socket ownership or application work.

The application sees data after a readiness notification, a wakeup, or an active poll. A normal `recv()`/`recvmsg()` then copies payload into user-provided memory. Readiness does not guarantee the thread runs immediately: scheduler placement, preemption, affinity, cgroup throttling, page faults, and higher-priority work can add delay. Chapters 31 and 35 cover scheduling and isolation; do not diagnose those solely from network counters.

The send side accounts data waiting for protocol processing, transmission, and—in TCP—acknowledgment or retransmission. A blocking send may sleep when limits are reached; a nonblocking send may report `EAGAIN`. TCP Small Queues (TSQ) limit how much data one TCP flow can have queued in lower layers, reducing domination and excessive local buffering. Byte Queue Limits (BQL) are a driver-facing feedback mechanism that limits bytes outstanding to a device TX queue based on completions. They solve different boundaries:

```text
application
  | socket send accounting / TCP not-sent data
TCP Small Queues: per-flow pressure into lower stack
  | qdisc backlog and policy
Byte Queue Limits: bytes admitted to driver/device queue
  | descriptor ring
NIC
```

TCP receive autotuning adjusts eligible socket receive buffers up to configured limits based on path and consumption behavior. Explicit `SO_RCVBUF` changes semantics for that socket and can disable TCP’s automatic choice. UDP does not gain TCP’s flow-control response merely by receiving a larger buffer. Global `rmem`/`wmem`, protocol memory pressure, cgroup accounting, and per-socket limits interact; inspect the running kernel’s documentation and `ss -m`.

A larger socket buffer is appropriate when a measured, bounded burst temporarily exceeds the application’s drain rate and the added queueing fits the latency objective. It is inappropriate when the consumer is permanently slower, pauses unpredictably, or the memory multiplied across sockets is unacceptable. Roll back if queue residence or memory pressure grows without eliminating the first drop.

## 46.5 Routing, Neighbors, Namespaces, and Filters — Core

### Routes and neighbors are state machines

Transmit processing needs a destination result: output device, next hop, source address, MTU, and policy. Linux combines routing tables, policy rules, cached destination state, per-route metrics, and exception state. A route lookup is not simply “longest prefix once”; policy rules can select tables based on source, mark, interface, or other fields.

For Ethernet output, the next-hop IP must resolve to a link-layer address. ARP for IPv4 and Neighbor Discovery for IPv6 maintain neighbor entries with states such as reachable, stale, probe, failed, or permanent. While resolution is pending, packets may wait on a bounded unresolved-neighbor queue. A cold or failed neighbor can therefore create a latency spike or drop before the driver ring. Inspect:

```bash
ip rule show
ip route show table all
ip route get 192.0.2.10
ip -s neigh show
```

Do not “fix” a failed neighbor by increasing its unresolved queue before checking link/VLAN reachability, duplicate addressing, ARP/NDP filtering, and the peer. Per-route metrics can deliberately override transport behavior; document them as configuration state.

### `net_device` and network namespaces

Linux represents an interface with a `net_device`: physical ports, bonds, VLANs, bridges, loopback, tunnels, and veth endpoints all appear through this abstraction. A network namespace owns a separate view of interfaces, routes, neighbor tables, many network sysctls, firewall state, and sockets. Some resources and limits still interact with the host, driver, cgroup, or physical device.

A typical container path adds visible stages:

```text
container socket
 -> container routing/filtering
 -> veth endpoint
 -> peer veth in host namespace
 -> bridge or host routing
 -> host filtering/conntrack/NAT
 -> physical net_device/qdisc/NIC
```

Each transition may add an skb clone or metadata change, a queue, classification, cache traffic, and another CPU. Offload features on virtual devices can make captures look surprising: a host capture may show large GSO/GRO packets or checksums not yet completed. Establish the capture point before interpreting packet shape.

Useful topology commands are:

```bash
ip -details link show
ip netns list
ip -all netns exec ip -brief link
bridge link show
bridge fdb show
nft list ruleset
conntrack -S
```

The last two require the corresponding userspace tools and permissions. Namespace-local commands must run in the namespace of interest. Host interface counters do not automatically account for every drop inside a container namespace.

### Filtering and programmable hook points

Packets may encounter multiple programmable paths:

| Hook family | Approximate position | Typical use | Important cost/failure |
|---|---|---|---|
| XDP | native driver path before skb allocation; generic mode after skb allocation but before the ordinary protocol stack | early drop, redirect, load balancing | program cost per packet; redirect-map pressure; mode/driver differences |
| tc ingress/egress | network-device traffic-control path | BPF or other classification, policing, redirect, shaping | classifier/action work; configured drops |
| netfilter/nftables | protocol hooks across ingress/local/forward/output | firewall, NAT, policy | rule traversal, conntrack state and locks, intentional drops |
| socket filter | socket receive selection | reject/truncate traffic for a socket | runs after earlier stack work |
| reuseport BPF | socket selection within a reuseport group | application sharding | bad selection can imbalance workers |

“Earlier is faster” is incomplete. Earlier hooks have less context, different semantics, and different observability. XDP can avoid skb allocation in supported modes, but it cannot replace transport semantics. Conntrack and NAT maintain per-flow state, add lookups and updates, and can exhaust finite tables; their cost depends on rule set, traffic mix, CPU locality, collisions, and contention. Verify `nft` rule counters and `conntrack -S` before blaming generic protocol code.

A classic or eBPF socket filter attached through the corresponding socket option runs only after earlier receive work has occurred. Its result can reject the packet for that socket or limit the delivered length; it does not undo DMA, NAPI, routing, or demultiplexing cost already paid. Program loading can fail validation or permission checks, and replacing a filter changes application-visible selection semantics. A reuseport BPF program has a different contract: it chooses a socket in the reuseport group rather than filtering arbitrary earlier traffic.

## 46.6 Aggregation, Segmentation, and Checksums — Core

Offloads change the unit of work visible at each layer.

### Receive: GRO and LRO

Generic Receive Offload (GRO) combines compatible received packets into a larger skb representation so later kernel layers process fewer objects. GRO is implemented in the host stack with protocol-aware rules. Large Receive Offload (LRO) is traditionally more NIC/driver-specific aggregation and may be unsuitable for forwarding or workloads that require the original packet boundaries; support and restrictions vary.

Aggregation often improves throughput and CPU efficiency. Its possible costs are extra holding time until a flush condition, burstier delivery to the socket, and confusing captures. Whether it harms a latency objective is measured, not assumed. UDP GRO behavior is not identical to TCP GRO and can expose ancillary information or require application support in specific APIs; Chapter 45 covers those interfaces.

### Transmit: GSO and TSO

Generic Segmentation Offload (GSO) lets upper layers represent data as a large skb that is segmented later in software if necessary. TCP Segmentation Offload (TSO) lets compatible NIC hardware form wire-sized TCP segments. These reduce per-packet traversal and descriptor overhead but do not put oversized Ethernet frames on a normal-MTU wire.

Large software objects can create bursts at the eventual segmentation boundary. A qdisc, virtual device, tunnel, or NIC may impose feature constraints and trigger software segmentation. Feature propagation through stacked devices matters: a feature advertised by one `net_device` may be masked because a lower device cannot perform it.

### Checksum offload

Transmit checksum offload records what checksum work remains; the device completes it for supported packet forms. Receive checksum offload records what the device verified; Linux still interprets metadata and performs required validation. A packet capture taken before TX completion may show an apparently bad checksum because the NIC has not filled it yet.

Offload is not unambiguously good or bad. It usually saves CPU, but a driver or firmware defect, unsupported encapsulation, misleading instrumentation, or a latency-sensitive batching interaction may justify a controlled comparison. Use:

```bash
ethtool -k "$IFACE"
```

If testing a change with `ethtool -K`, record every affected feature because dependencies can cause multiple flags to change. Retest throughput, CPU, drops, and latency, then restore the prior state. Never disable all offloads as a first diagnostic step.

## 46.7 RSS, RPS, RFS, XPS, and Flow Steering — Core

Steering selects where work happens. The goal is not “use every CPU”; it is sufficient parallelism with stable flow ordering, good cache/NUMA locality, and no overloaded queue.

### RSS: hardware receive distribution

Receive Side Scaling hashes selected packet fields and uses an indirection table to choose an RX hardware queue. Each queue is normally associated with a NAPI instance and interrupt vector, although drivers can group them. The hash fields, key, indirection table, protocol coverage, and symmetric modes depend on hardware and configuration.

RSS acts before host protocol processing. It can distribute many flows cheaply, but a dominant single flow normally stays on one queue, and a poor hash/input mix can create queue skew. More queues increase parallelism but also interrupt and cache footprint. Inspect configured and maximum channel counts with `ethtool -l`, the indirection table/hash configuration with `ethtool -x`, queue counters with `ethtool -S`, and vector placement with `/proc/interrupts`.

### RPS: software receive distribution

Receive Packet Steering chooses a target CPU after the hardware queue has delivered a packet into the kernel. It can enqueue the packet to that CPU’s backlog and trigger an inter-processor notification. RPS helps when a NIC has too few hardware queues or RSS placement cannot supply enough protocol-processing capacity. If RSS already maps adequate queues to suitable CPUs, RPS may only add a remote enqueue, IPI, and cache movement.

RPS is configured per RX queue through:

```text
/sys/class/net/IFACE/queues/rx-N/rps_cpus
```

It is kernel-configuration dependent and normally disabled when the mask is zero. CPU masks must be interpreted against the host’s CPU numbering and NUMA topology.

### RFS and accelerated RFS

Receive Flow Steering (RFS) builds on RPS. It tracks the CPU on which an application consumes a flow and tries to move later protocol processing toward that CPU, while avoiding unsafe movement when packets remain queued on the previous CPU. It can improve data-cache locality for flow-oriented servers; it can also add flow-table state and follow a thread that the scheduler moves frequently.

Accelerated RFS asks a supporting driver/NIC to steer the flow to a suitable hardware queue. It requires kernel, driver, and NIC support and typically hardware flow-filter capability. Do not infer support from the presence of an `ethtool` binary.

### XPS: transmit queue selection

Transmit Packet Steering maps CPUs or receive queues to TX queues. Stable selection can reduce lock contention and keep TX completion work near the sending or receive-processing CPU. It has no queue choice to make on a single-TX-queue device. A poor mapping can overload one queue or move completion data across cache/NUMA boundaries.

Configuration is exposed, when supported, under:

```text
/sys/class/net/IFACE/queues/tx-N/xps_cpus
/sys/class/net/IFACE/queues/tx-N/xps_rxqs
```

Linux preserves a flow’s selected TX queue until it is safe to change so that steering does not casually introduce reordering.

### Explicit hardware flow steering

Some NICs accept n-tuple rules that direct selected traffic to a queue. This can isolate a critical port or tenant from unrelated flows, or guarantee that a single important flow lands on a chosen queue. Rule capacity, match fields, priority, replacement behavior, and interaction with RSS are vendor/driver facts.

```bash
ethtool -n "$IFACE"
```

Use the driver’s documented `ethtool -N` syntax only after recording existing rules and proving a queue/CPU placement problem. A stale rule can silently direct production traffic to an offline, overloaded, or unexpected queue.

### The steering decision table

| Observed condition | Candidate | Mechanism | Risk and rollback signal |
|---|---|---|---|
| Several flows overload one RSS queue while peers idle | adjust RSS indirection/hash or queue count | rebalance before software stack | more IRQs/cache footprint; undo if CPU or tails worsen |
| Too few hardware queues for protocol CPU demand | RPS within a local CPU set | spread upper receive work | IPI/cache cost; remove masks if no capacity gain |
| Application and protocol work repeatedly use different CPUs | pin workers first, then consider RFS | follow consumer CPU | flow-table churn; disable if migrations or tails rise |
| TX queue lock/contention or cross-node completion traffic | XPS | stabilize CPU-to-TX mapping | queue skew; restore maps if one queue backs up |
| One known flow needs dedicated treatment | hardware flow rule | exact match to RX queue | finite/stale rules; delete on validation failure |

Queue count, affinity, steering, and application placement form one system. Change one dimension at a time.

## 46.8 IRQ Affinity, NUMA, and Busy Polling — Core

`/proc/interrupts` identifies active vectors and their per-CPU counts. `/proc/irq/N/smp_affinity_list` requests CPUs allowed to service a vector; `effective_affinity_list`, when present, shows the effective result. Some managed interrupts restrict what user space can change. CPU hotplug, driver reload, device reset, and `irqbalance` can alter placement.

`irqbalance` is not inherently an enemy. It is useful for general-purpose balance and can override manual assignments. For a dedicated service, either configure it to respect reserved CPUs or manage specific vectors explicitly and monitor that policy. Never disable it globally merely because one queue is skewed.

NUMA is a placement concern, not a fixed nanosecond penalty. The NIC’s PCI locality, IRQ CPU, NAPI CPU, packet-buffer allocation, application CPU, and application memory can span nodes. Cross-node traffic may cost bandwidth and cache coherence, but concentrating everything on a local core can be worse if it saturates. Inspect:

```bash
cat "/sys/class/net/$IFACE/device/numa_node"
grep -E "$IFACE|CPU" /proc/interrupts
lscpu -e=CPU,NODE,SOCKET,CORE,ONLINE
```

Scheduling isolation, cgroup CPU quotas, realtime priorities, and frequency/power policies belong to Chapters 31 and 35. Here the required link is: if network queues remain shallow but application wake-to-run time grows, cross the boundary into scheduler evidence rather than enlarging network buffers.

### Busy polling

NAPI busy polling allows an application to ask for receive work before the device interrupt path would deliver it. Selected sockets can use `SO_BUSY_POLL`; global `net.core.busy_read` and `net.core.busy_poll` controls exist on supporting kernels. Recent kernels also offer epoll and io_uring integrations, with additional requirements and interfaces.

The durable trade is simple:

```text
interrupt path: wait -> interrupt/NAPI -> readiness -> scheduler -> application
busy poll path:  application spends CPU checking the relevant NAPI context
```

Busy polling can remove notification and wakeup delay when the application, socket, and NAPI context are placed coherently. It also consumes CPU while no packet is present and can steal service from softirq, peers, or colocated work. Socket NAPI IDs matter: `SO_INCOMING_NAPI_ID` can identify the receive NAPI context, and epoll-oriented busy polling may require descriptors in an epoll set to share a NAPI ID.

Treat the timeout or budget as a bounded spin policy. Compare:

- end-to-end tail latency under the real idle/burst mix;
- CPU time and power, including empty polls;
- drops and NAPI service of non-busy-polled traffic;
- fairness between workers;
- behavior after queue remapping, device reset, or connection migration.

Roll back if latency only improves at light load but throughput headroom, fairness, or worst-case tails degrade. Kernel availability, privileges, and exact options must be checked against the deployed kernel headers and documentation.

## 46.9 Transmit Queues and Traffic Control — Core

After protocol construction, Linux performs routing and neighbor resolution, passes configured output hooks, selects a TX queue, and submits through a queueing discipline. Traffic control can classify, police, shape, schedule, drop, mark, or redirect. The configured qdisc may have fast paths and may not enqueue an uncontended packet, but its policy becomes visible under load.

The queues must be distinguished:

| Boundary | Unit and purpose | Evidence |
|---|---|---|
| socket/protocol | bytes/skbs awaiting protocol progress | `ss -mti`, protocol counters |
| TSQ | per-TCP-flow admission to lower stack | indirect via TCP/qdisc behavior; kernel tracing if needed |
| qdisc | software packets/bytes awaiting policy/service | `tc -s qdisc show dev IFACE` |
| BQL | dynamic bytes admitted to driver hardware queue | queue `byte_queue_limits` sysfs, driver statistics |
| descriptor ring | DMA work owned by driver/NIC | vendor queue counters, TX stopped/busy/timeout |

Bufferbloat can occur when any queue hides overload for too long. A low-latency qdisc can control software queueing, but it cannot remove a queue inside a switch, peer, hypervisor, or NIC. Conversely, a qdisc drop may be the correct result of a policer rather than a fault.

Doorbells and completions are normally batched. Do not model each `send()` as exactly one skb, descriptor, MMIO write, wire packet, or interrupt. TCP corking/autocorking, GSO/TSO, qdisc batching, `xmit_more`, scatter-gather, and completion coalescing all change those ratios.

## 46.10 A Worked Drop-and-Latency Diagnosis — Core

Suppose a UDP market-data consumer reports sequence gaps and a p99.9 spike during a 20 ms burst. Average CPU is 35%. The temptation is to enlarge every queue.

### Step 1: prove the application symptom

Record sequence numbers and application receive timestamps. Confirm gaps are not publisher gaps, parser rejection, or stale data. A packet capture at one point cannot prove what happened at another point; if possible, capture at the sender and receiver with synchronized clocks.

### Step 2: snapshot deltas by layer

Take healthy and event snapshots. The result is:

```text
NIC queue 5 no-buffer counter       +18,420
other NIC queues no-buffer          +0
interface rx_dropped                +18,420
softnet drop-like field             +0
UDP receive-buffer errors           +0
application sequence gaps           +18,420
IRQ for queue 5                     concentrated on CPU 11
CPU 11 softirq utilization          saturated during burst
other queue CPUs                    had headroom
```

The exact equality is unusually clean, but the first counter is the important part: loss occurred at the hardware/driver RX boundary before socket queuing. Increasing `SO_RCVBUF` cannot recover packets the NIC never delivered.

### Step 3: explain the service deficit

RSS placed most burst traffic on queue 5 because it was one dominant flow. One queue/CPU cannot process it at the burst rate. Average machine CPU hid a local saturation. `/proc/interrupts`, per-queue NIC counters, and a per-CPU timeline support the explanation.

### Step 4: choose a hypothesis, metric, and rollback

Possible experiments depend on constraints:

1. If multiple flows are accidentally mapped unevenly, rebalance RSS indirection and verify per-flow ordering.
2. If the workload is one flow and hardware supports an appropriate technique, explicit flow placement can isolate it but cannot split that single ordered flow across CPUs by itself.
3. RPS may move upper-stack processing to another CPU, leaving the original CPU to refill the hardware queue sooner. It adds an enqueue/IPI/cache transfer, so measure whether RX no-buffer drops disappear and tail latency improves.
4. A larger RX ring may cover this bounded burst if its added maximum residence time is acceptable. It does not raise sustained service rate.
5. Reducing unrelated work or correcting IRQ/application placement may restore service capacity; scheduling mechanics are handled in Chapters 31 and 35.

For the RPS experiment, record the original per-queue mask, enable only a nearby otherwise-idle CPU, repeat the identical burst, and compare NIC drops, softnet evidence, per-CPU work, application gaps, and p99.9. Restore the original mask immediately if remote processing raises tail latency without eliminating the hardware drop.

### A second outcome changes the diagnosis

If instead NIC and softnet counters stay flat while UDP receive-buffer errors rise, the first full queue is the socket receive boundary. Measure application drain pauses, socket memory, batch size, and scheduler wake-to-run delay. A modest receive-buffer increase may absorb a proven burst, but only after confirming that the application can catch up. If qdisc drops rise on transmit, investigate offered rate and qdisc policy; do not tune RX.

This method prevents a common failure: correlating a downstream symptom with a convenient upstream knob while ignoring the first loss evidence.

## 46.11 Reference Runbook — Reference

This section is skippable on a first reading.

### Establish identity and topology

```bash
IFACE=eth0

uname -a
ip -details link show dev "$IFACE"
ethtool -i "$IFACE"
readlink -f "/sys/class/net/$IFACE/device"
cat "/sys/class/net/$IFACE/device/numa_node"
ip rule show
ip route show table all
ip -s neigh show
```

Record kernel build, driver, firmware, NIC identity, link properties, namespace, virtual-device stack, and workload. A tuning result is not portable without this context.

### Inspect RX/TX queueing and steering

```bash
ethtool -l "$IFACE"       # current and maximum channel counts
ethtool -g "$IFACE"       # ring parameters
ethtool -c "$IFACE"       # interrupt coalescing
ethtool -k "$IFACE"       # offload features
ethtool -x "$IFACE"       # RSS hash/indirection, if supported
ethtool -S "$IFACE"       # driver/vendor statistics

grep -E "$IFACE|CPU" /proc/interrupts
for f in /sys/class/net/"$IFACE"/queues/rx-*/rps_cpus; do
    printf '%s: ' "$f"
    cat "$f"
done
for f in /sys/class/net/"$IFACE"/queues/tx-*/xps_cpus; do
    printf '%s: ' "$f"
    cat "$f"
done
```

The loops are read-only. A missing glob match or file means the interface/kernel does not expose that mechanism in the expected form; do not create it.

### Inspect kernel, protocol, socket, and qdisc evidence

```bash
ip -s -s link show dev "$IFACE"
cat /proc/net/softnet_stat
nstat -az
ss -u -a -m -i
ss -t -a -m -i
tc -s qdisc show dev "$IFACE"

for q in /sys/class/net/"$IFACE"/queues/tx-*/byte_queue_limits; do
    test -d "$q" || continue
    printf '%s\n' "$q"
    grep -H . "$q"/inflight "$q"/limit 2>/dev/null
done
```

`ss` queue columns and memory details have protocol-specific meanings. UDP queue occupancy, TCP not-sent data, and unacknowledged TCP bytes are not interchangeable.

### Trace only after counters narrow the stage

Start with available tracepoints:

```bash
sudo perf list 'napi:*' 'net:*' 'skb:*'
sudo perf trace -a -e 'napi:*'
sudo dropwatch -l kas
```

Names and availability depend on kernel build and tool version. Drop monitor/dropwatch and skb drop-reason tracepoints report only paths instrumented to report a reason; absence is not proof of no drop. Tracing can itself add overhead, lose events, or change timing.

A minimal bpftrace-style aggregation, after confirming the tracepoint and field names on the target, is:

```text
tracepoint:skb:kfree_skb
{
    @[args->reason] = count();
}
```

This is an eBPF tracing program expressed in bpftrace syntax. Treat it as version-specific pseudocode until `bpftrace -lv tracepoint:skb:kfree_skb` confirms the context. Prefer aggregation over printing every packet in a high-rate incident. Correlate reason values with headers from the exact running kernel.

### Safe tuning protocol

For every change, write down:

1. **Condition:** the measured bottleneck and first changing counter.
2. **Mechanism:** which producer, consumer, queue, or wakeup should change.
3. **Success metric:** throughput, drop delta, CPU headroom, and latency percentile.
4. **Risk:** extra queue residence, CPU, memory, reordering, or operational fragility.
5. **Rollback:** the exact prior value and command or deployment configuration.

Example experiment record:

```text
Hypothesis: RX queue 5 exhausts because CPU 11 cannot refill during the burst.
Change:     add one same-node CPU to rx-5 RPS mask.
Hold fixed: channels, ring, coalescing, application affinity, offered traffic.
Success:    queue-5 no-buffer delta becomes zero; p99.9 does not regress.
Rollback:   restore captured rx-5/rps_cpus value.
```

Never copy a hexadecimal CPU mask from another host. CPU count, offline CPUs, cpusets, IRQ restrictions, and bit ordering make that unsafe.

## 46.12 Common Traps — Core

- **“Average CPU is low, so Linux is not saturated.”** One RX queue, NAPI instance, IRQ CPU, socket lock, or worker may be saturated.
- **“A bigger buffer reduces latency.”** It reduces drops only for a bounded overload and permits more waiting.
- **“Every receive packet causes an interrupt.”** Coalescing and NAPI normally process batches.
- **“NAPI is always softirq-only.”** Busy polling and optional threaded modes make execution context version/configuration dependent.
- **“RPS is RSS in another spelling.”** RSS selects hardware RX queues before DMA completion processing; RPS selects a CPU later and may enqueue to a remote backlog.
- **“RFS splits one flow over CPUs.”** Its objective is application locality while preserving safe flow movement, not parallel processing of one ordered flow.
- **“XPS is a free win.”** It can reduce contention or improve locality, but a bad map creates TX skew or remote completions.
- **“Bad checksums in a host capture prove wire corruption.”** A capture may precede transmit checksum offload.
- **“`ethtool -S` counter names are standardized.”** They are driver/vendor-specific.
- **“No drop trace event means no drop.”** Instrumentation coverage and trace loss are finite.
- **“Disable `irqbalance` on every low-latency host.”** Coordinate automatic and manual policy; verify effective placement.
- **“One sysctl tunes the whole host.”** Many networking controls are namespace-, protocol-, device-, queue-, route-, socket-, cgroup-, kernel-, or driver-scoped.
- **“A packet capture sees the original wire packets.”** GRO/GSO, namespaces, virtual devices, and capture location change what is visible.
- **“Zero-copy removes ownership cost.”** It trades copying for pinning, references, mapping, completions, and stricter lifetimes.

## 46.13 Recall Card — Core

```text
RX
wire -> RSS/RX ring -> IRQ -> NAPI -> skb/GRO -> L2/L3/L4
     -> socket queue/backlog -> readiness/wakeup -> normal user copy

TX
user copy/reference -> socket/protocol -> route+neighbor -> hooks/qdisc
     -> XPS/TX ring -> DMA/NIC -> completion/reclaim/wakeup

STEERING
RSS  hardware chooses RX queue
RPS  software chooses upper-stack CPU
RFS  software follows application flow locality
aRFS asks capable NIC/driver to follow it
XPS  chooses TX queue from CPU or RX-queue mapping

QUEUE RULE
Find the first counter that changes.
Measure producer, consumer, occupancy, and CPU.
Capacity absorbs a burst; it does not fix sustained overload.

COSTS
notification + DMA/coherence + metadata + protocol/filter
+ queueing + wakeup/scheduling + copy/pinning + completion

LABELS
Architecture: bounded ownership transfers and queueing.
Linux: NAPI, skb, softnet backlog, TSQ/BQL, hook ordering.
Version/config: threaded NAPI, drop reasons, sysctls, layouts.
Driver/NIC/vendor: descriptor format, counters, rings, coalescing, rules.
Measured: latency, service rate, cache behavior, best queue count.
```

## 46.14 Reasoning Questions — Core

1. Trace a normal UDP receive from wire to `recvmsg()`. Name every bounded queue, likely copy, and possible wakeup.
2. Why can increasing an RX descriptor ring remove drops while worsening tail latency? What would you measure before and after?
3. Contrast RSS, RPS, RFS, accelerated RFS, and XPS by decision point, target, and cost.
4. A host has low aggregate CPU, one growing NIC RX no-buffer counter, and no UDP receive-buffer error. Where is the first loss, and which evidence would you collect next?
5. Explain how interrupt coalescing and NAPI budgets affect batching without claiming that budget exhaustion necessarily drops packets.
6. Why can `tcpdump` display a bad outgoing checksum or an oversized packet that never appears that way on the wire?
7. Distinguish socket send memory, TCP Small Queues, qdisc backlog, BQL, and the hardware TX ring.
8. When is busy polling a coherent latency experiment, and what rollback signals would make you reject it?
9. A packet traverses a container veth, bridge, conntrack/NAT, and physical NIC. Where might it be dropped, and why is one host-interface counter insufficient?
10. Which facts in this chapter are architectural, Linux-specific, kernel-version-specific, driver/NIC-specific, and workload measurements?

## 46.15 Puzzle and Exercise — Core

### Puzzle: the misleading socket fix

During bursts, a UDP service loses packets. An engineer quadruples `SO_RCVBUF`; losses fall in a short test but p99.9 grows. In the next larger burst, loss returns. NIC counters remain flat, `/proc/net/softnet_stat` shows no drop delta, and UDP receive-buffer errors track application sequence gaps.

Explain all three observations.

The first full boundary is the socket receive queue. A larger buffer lets a finite burst wait longer, so the short test loses fewer datagrams but increases residence time. The larger burst still exceeds the application’s ability to catch up, so finite capacity eventually fills again. The durable investigation is the consumer: application pause time, batching, per-message work, wake-to-run delay, socket sharing/lock contention, and sustained drain rate. Capacity may remain part of the solution only if the burst is bounded and its queueing delay and multiplied memory cost fit the objective.

### Exercise: build a reversible packet-path experiment

On a non-production Linux host:

1. Generate a reproducible TCP or UDP workload with a controlled steady phase and burst phase.
2. Save the 90-second screen before, during, and after the workload.
3. Draw the actual path, including namespaces and virtual devices.
4. Identify queue count, IRQ placement, RPS/XPS maps, offloads, qdisc, and socket memory.
5. Select exactly one reversible change: coalescing, ring depth, RSS indirection, RPS/XPS mapping, qdisc, or socket buffer.
6. Predict which counter and latency percentile should change, plus one adverse signal.
7. Repeat at least five times with the same workload and restore the original setting.
8. Report distributions and counter deltas, not a single average.

If no counter or latency distribution changes reproducibly, conclude that the hypothesis was unsupported. Do not keep the tuning merely because it sounds plausible.

## Prerequisites for Chapter 47 — Core

You are ready for kernel bypass when you can point to measured kernel costs—not just “syscalls are slow”—and name what bypass must replace: buffer ownership, descriptor management, queue isolation, flow steering, protocol work, memory registration, polling, observability, recovery, and security boundaries. Chapter 47 asks whether removing selected kernel stages is worth assuming those responsibilities.
