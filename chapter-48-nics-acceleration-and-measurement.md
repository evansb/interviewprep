# Chapter 48 — NICs, Acceleration, and Measurement

A network latency claim is meaningless until its endpoints are named.

“The NIC adds almost nothing,” “the FPGA responds immediately,” and “wire-to-user is only a few microseconds” sound precise enough to repeat. Yet each can hide serialization, PHY processing, buffering, DMA, notification, queueing, clock conversion, capture loss, or work performed outside the timed interval. A product number may be correct for its test and irrelevant to yours.

This chapter connects three questions:

1. How do bytes travel through NIC queues, offload engines, PCIe, and host software?
2. Which work can a SmartNIC or FPGA actually remove from the critical path?
3. Where must timestamps and counters be placed to measure latency, loss, jitter, and saturation honestly?

Chapters 36 and 39 own Ethernet and switching details. Chapters 45 and 46 own socket and Linux packet-path APIs. Chapter 47 owns kernel-bypass and RDMA programming. Chapter 43 owns general statistical methodology. Here, packet-rate arithmetic and timestamp placement are first-class tools.

## The 90-second version

Draw the path before measuring:

```text
remote wire
    │
    ▼
[medium]─[PHY]─[MAC/parser/offloads]─[RX queue/ring]─DMA/PCIe─[host buffer]
                                                              │
                                  interrupt/poll─[driver/stack]─[socket/bypass]
                                                              │
                                                          [application]

[application]─[socket/bypass]─[host buffer]─descriptor/doorbell─PCIe/DMA
                                                              │
remote wire ◀─[medium]─[PHY]─[MAC/scheduler/offloads]─[TX queue/ring]◀────┘
```

Then record:

- exact start and end events;
- the clock domain of every timestamp;
- frame sizes **on the MAC link**, including framing overhead used in the calculation;
- offered packets, offered bits, completions, useful messages, and loss at each layer;
- queue, ring, interrupt/coalescing, RSS, offload, affinity, and NUMA settings;
- NIC, firmware, driver, kernel, capture-tool, and FPGA-image versions.

Use five rules:

- An RX descriptor is not a packet; it is a negotiated unit of buffer ownership. Ring capacity and packet capacity may differ.
- An offload is beneficial only if it removes more critical-path work than it adds in batching, queueing, observability loss, or semantic constraints.
- A hardware timestamp marks a device-specific point. It is not automatically “the wire.”
- One-way latency across two clocks inherits their relative clock error. RTT avoids that offset but does not reveal either direction without assumptions.
- Find capacity with open-loop offered-load sweeps. Report goodput, loss, and latency together; delivered throughput alone can hide overload.

At the end, a reader should be able to look at a vendor benchmark and ask: Were preamble and interpacket gap counted? Which timestamp point? Which clock? Which direction? Which frame distribution? Which offloads? Did the generator sustain the stated offered load? What was dropped before the measurement endpoint?

### Label every claim

Networking crosses several authorities. Prefix working notes with the claim’s source:

- **Protocol:** Ethernet, IP, UDP, TCP, or PTP wire semantics under a named revision/profile.
- **PCIe:** transaction and ordering semantics for a named PCIe generation, topology, and device configuration.
- **NIC:** behavior documented for an exact adapter, port mode, firmware, and driver.
- **Vendor:** a product or tool claim whose test method and version must accompany it.
- **Version:** the exact protocol revision, hardware stepping, firmware, driver, kernel, tool, or FPGA image to which another claim applies.
- **OS/tool:** Linux, `ethtool`, libpcap, tcpdump, Wireshark, or another versioned interface.
- **Measured:** an observation tied to a build, host, topology, workload, sample definition, and statistic.

A **calculated** value is another category. The 10 Gb/s minimum-frame rate derived later follows from declared MAC-layer assumptions; it is not a measured capacity claim about a NIC or host.

## Core path: from wire to application and back

The Core follows ownership and time through the live path. Read §§48.1–48.10 in order the first time; the reference material that follows is designed for lookup.

## 48.1 Ports, queues, rings, and ownership

A physical port contains or connects several stages: medium-dependent circuitry, a PHY, a MAC, packet classification and offload logic, queue state, DMA engines, and a host interface. Implementations may combine or reorder internal stages. Product block diagrams are evidence for that product, not an Ethernet guarantee.

### Receive

A simplified RX lifecycle is:

1. The driver or user-space bypass process allocates buffers.
2. It places buffer addresses and metadata in receive descriptors.
3. It publishes descriptors to the NIC according to the device’s ownership protocol.
4. The NIC receives and validates a frame, classifies it, and selects an RX queue.
5. DMA writes packet bytes and status into host-visible memory.
6. The NIC makes completion state visible and may signal an interrupt.
7. The driver or polling process consumes the completion and packet.
8. The buffer is returned, recycled, or replaced.

```text
software owns free buffer
        │ post descriptor
        ▼
NIC owns descriptor/buffer
        │ receive + DMA + completion
        ▼
software owns filled buffer
        │ consume + recycle
        └──────────────────────────► post again
```

The exact ownership bits, descriptor size, memory barriers, head/tail registers, completion format, and DMA ordering are NIC- and driver-specific. Portable code cannot infer them from “ring buffer.”

If no usable receive buffer is available, a device may drop the frame, place it elsewhere, or apply a product-specific fallback. The counter naming and counting point vary. Never translate a counter named `rx_missed_errors` into a universal cause without the driver/NIC documentation and a controlled test.

### Transmit

A simplified TX lifecycle is:

1. Software prepares packet bytes and metadata.
2. It posts one or more TX descriptors.
3. It orders the writes required by the device contract and notifies the NIC, often through a memory-mapped doorbell.
4. The NIC DMA-reads bytes or metadata, applies requested offloads, queues the frame, and transmits it.
5. A completion eventually permits software to reuse the buffer and descriptor.

A successful `send()` normally means that the software layer accepted data, not that the last bit crossed the medium. A TX descriptor consumed by the NIC is also not necessarily a wire event. The selected TX timestamp or completion definition must name the boundary.

Doorbell writes, descriptor fetches, data reads, completions, and interrupts consume PCIe transactions. Devices can prefetch or batch them. IOMMUs, address-translation caches, relaxed ordering, switch topology, NUMA placement, and host cache/I/O-coherence policy can affect the path. Those are platform properties; Chapter 29 owns their deeper mechanics.

A negotiated PCIe generation and lane count is not an application DMA-bandwidth guarantee. Encoding, TLP/DLLP overhead, read completions, payload size, topology sharing, and transfer direction matter. Declare those assumptions before calculating a bound, then measure the actual path.

### Multiple queues

Modern NICs commonly expose multiple RX and TX queues. On receive, RSS can hash selected header fields and use an indirection table to choose a queue. Explicit filters may steer selected traffic. On transmit, the driver, queue discipline, or application chooses a queue.

Multiple queues can:

- distribute independent flows across CPUs;
- isolate traffic classes;
- preserve per-flow processing locality;
- reduce contention on a single descriptor ring.

They can also:

- reorder packets when a flow moves between queues;
- spread one application’s working set across caches;
- create uneven “elephant-flow” load;
- multiply total buffered packets;
- make counters and timestamp streams queue-specific.

The Linux RSS/RPS/RFS/XPS interfaces are OS mechanisms, not NIC guarantees. Verify the active indirection table, queue count, IRQ mapping, and application CPU placement. A configuration with more queues is not universally faster; the useful number is the smallest arrangement that meets the measured parallelism, isolation, ordering, and loss requirements.

### Rings are capacity with a time dimension

An RX ring absorbs arrivals while the consumer is not returning buffers. For an offered packet rate \(R\) packets/s and a service gap \(g\) seconds, a first lower-bound estimate is:

\[
B_{\text{gap}} = \lceil Rg \rceil
\]

This is arithmetic, not a sizing prescription. Add existing occupancy, burstiness, descriptor-to-packet mapping, safety margin, and any hardware buffering outside the ring. Multi-buffer receives can consume several descriptors per packet; header splitting can do the same. Conversely, aggregation may make one host object represent multiple wire packets.

At a declared 1.5 Mpacket/s arrival rate and a declared 200 µs gap, the calculation gives:

\[
\lceil 1.5\times10^6 \times 200\times10^{-6}\rceil = 300
\]

At the calculated 10 Gb/s minimum-frame MAC rate derived in §48.8, the same declared gap covers approximately 2,977 packet arrival opportunities after rounding upward. Neither result says that a 300- or 2,977-entry ring is supported, sufficient, or desirable on a particular adapter.

A deeper ring trades drops for residence time and memory footprint. If \(N\) packets are already ahead in a FIFO and departure rate is \(C\), the added queue time is approximately \(N/C\) while the rate remains stable. For stale market data, delayed delivery may be worse than explicit loss. For bulk transfer, buffering a burst may improve goodput. Choose from the application’s loss and freshness contract.

## 48.2 Offload engines: conditional decisions

An offload moves or combines work; it does not make the work disappear. Evaluate it against the outcome you care about.

| Facility | Potential benefit | What can change | Reasons to disable or constrain it |
|---|---|---|---|
| RX/TX checksum offload | Avoid host checksum work | Capture may see partial or not-yet-final checksums on local TX | Unsupported encapsulation, diagnostic fidelity, device errata |
| TSO/GSO/USO | Submit a large software object for later segmentation | Host capture can show “superpackets” not present on wire | Per-packet timing, unsupported headers, latency from batching |
| GRO/LRO | Coalesce received packets | Packet boundaries, timestamps, and observed counts can change | Wire-faithful capture, per-datagram latency, ordering diagnosis |
| RSS/flow steering | Parallelism and locality | Queue assignment, CPU ownership, possible flow migration | Single-flow ordering, skewed load, cache footprint |
| Interrupt moderation | Amortize interrupt cost | Notification delay and burst delivery | Tight latency tail, timestamp-to-app decomposition |
| VLAN/tunnel/crypto offload | Remove encapsulation or cryptographic CPU work | Supported headers, state, and failure paths differ | Feature mismatch, fallback cost, visibility, key/state handling |
| Flow filtering/replication | Avoid unwanted DMA or host fan-out | Capacity and rule priority are finite | Rule overflow/fallback, correctness, operational complexity |
| Hardware timestamping | Timestamp near a device boundary | Only selected packets/queues may be supported | Missing support, timestamp resource limits, clock uncertainty |

Do not ask “Should GRO be on?” without naming the workload and measurement endpoint. For a throughput test of TCP byte delivery, aggregation may be appropriate. For a packet-by-packet feed latency test, it may erase the boundaries being measured.

Inspect, do not assume:

```sh
ethtool -i eth0
ethtool -k eth0
ethtool -l eth0
ethtool -x eth0
ethtool -g eth0
ethtool -c eth0
ethtool -T eth0
```

These Linux commands are read-only examples. Options, fields, privilege requirements, and support depend on the installed `ethtool`, kernel, driver, and NIC. Save their full output with the experiment. A feature displayed as enabled is not proof that every packet used it; protocol, encapsulation, size, or resource limits can cause fallback.

### Capture lies when offload boundaries are ignored

A capture on the transmitting host may occur before segmentation and checksum completion. A receiving host capture may occur after aggregation. Therefore:

- a large captured TCP object may correspond to several wire frames;
- a locally captured checksum may look invalid although the NIC later completes it;
- one captured aggregate may contain several original packets;
- traffic consumed by a bypass path may never reach an ordinary kernel capture hook.

This is not a tcpdump or Wireshark defect. The capture accurately reports its observation point. For wire claims, use an external tap/capture device or a documented NIC capture point and calibrate it.

## 48.3 Timestamp placement and clock domains

Timestamp placement determines which latency components are included.

```text
RX:
wire ─ PHY ─ MAC ─ classify ─ queue ─ DMA ─ completion ─ driver ─ socket ─ app
       h0?    h1?                         s0?       s1?                a0

TX:
app ─ send ─ scheduler ─ driver ─ DMA/descriptor ─ NIC queue ─ MAC ─ PHY ─ wire
a1              s2?       s3?              c?          h2?     h3?
```

The labels are possibilities, not guaranteed locations:

- `h*`: a hardware timestamp at a device-documented provider;
- `s*`: a kernel/software timestamp;
- `a*`: an application clock read;
- `c`: a completion whose semantics may be DMA consumption, transmission completion, or a batched report.

The phrase “NIC hardware timestamp” does not tell you whether the provider is in the PHY, MAC, or another block. Recent Linux interfaces can represent different hardware timestamp providers, but actual support is device and driver dependent. Determine the provider and qualify whether the stamp refers to start-of-frame, end-of-frame, or another event.

### Linux timestamp delivery

Linux `SO_TIMESTAMPING` separates timestamp **generation** from timestamp **reporting**. Relevant requests include RX/TX software and hardware generation. Receive timestamps arrive as ancillary data with the normal `recvmsg()` result. Transmit timestamps are normally reported asynchronously through the socket error queue; applications correlate them with transmitted data or an ID.

New Linux interfaces and flags evolve. The current kernel documentation recommends the newer time structures for year-2038-safe applications and describes options such as timestamp IDs and timestamp-only error-queue payloads. Chapter 45 owns complete socket code. The robust event loop here is:

```text
configure device timestamp provider/filter
configure socket generation + reporting flags

on receive-ready:
    recvmsg(normal queue)
    parse all ancillary messages
    record packet identity, timestamp type, value, clock domain

on error-queue-ready:
    repeat recvmsg(MSG_ERRQUEUE) until empty
    parse extended error + timestamp ancillary data
    correlate timestamp ID with the original transmission

continuously:
    count requests, delivered stamps, missing stamps, queue overflows
```

Do not assume one TX request produces one immediate timestamp. Segmentation, fragmentation, retransmission, device filtering, and completion aggregation affect semantics. Undrained TX timestamp data consumes socket receive-buffer budget on Linux, so error-queue handling is part of correctness.

### Which timestamp should you choose?

| Goal | Prefer | Includes | Excludes or risks |
|---|---|---|---|
| Arrival near a port boundary | Documented RX hardware timestamp | Device processing up to stamp point | DMA, host queueing, app wakeup; provider placement |
| Host-stack receive delay | RX hardware plus application timestamp in a related clock | Difference spans downstream path | Cross-clock conversion and correlation |
| Time accepted by kernel TX path | Application + TX scheduler/software stamps | Selected protocol/scheduler stages | NIC queue and physical transmission |
| Actual device egress event | Documented TX hardware timestamp | Path up to hardware stamp | Later PHY/medium stages; device filtering |
| Application-observed response | Application monotonic timestamps | All delays between calls | Remote direction and remote processing combined |
| Wire-to-wire response | One external capture clock on both directions | Between calibrated tap points | Tap/channel skew, capture loss, trigger correlation |

Hardware timestamps usually reduce host scheduling uncertainty, but their **resolution**, **precision**, **accuracy**, and **placement** are separate. A counter with fine nominal units can be poorly synchronized. A repeatable stamp at the MAC can omit variable PHY or queue latency on the other side of that point.

### PTP and PHCs

A PTP hardware clock (PHC) is associated with a timestamp-capable hardware provider and exposed by supported Linux drivers. `ptp4l` can discipline a PHC using IEEE 1588 messaging; `phc2sys` can synchronize the system clock and a PHC in a selected direction; `ts2phc` can synchronize PHCs from external timestamp signals. Exact topology and configuration matter.

A **grandmaster** is the root time source for a PTP domain. It can be selected by the profile’s best-master-clock procedure or constrained by configuration. A GNSS-disciplined oscillator is one possible source; holdover quality, antenna state, UTC/PTP time-scale data, and the selected profile remain part of the accuracy chain. An ordinary clock has one PTP port, a boundary clock participates in separate timing segments, and a transparent clock forwards timing messages while correcting for measured residence time where supported. These roles describe protocol behavior, not a universal error bound.

PTP may use one-step timestamp insertion or a two-step follow-up carrying the precise origin timestamp. The choice changes message handling, not the need to account for path asymmetry and timestamp placement.

In an end-to-end delay exchange, use:

```text
server/master sends Sync at t1
client/slave receives it at t2
client/slave sends Delay_Req at t3
server/master receives it at t4
```

Let the client clock offset from the server be \(\theta\), forward path delay be \(d_f\), and reverse delay be \(d_r\). Then:

\[
t_2-t_1=d_f+\theta
\]

\[
t_4-t_3=d_r-\theta
\]

The familiar estimate is:

\[
\hat{\theta} =
\frac{(t_2-t_1)-(t_4-t_3)}{2}
= \theta + \frac{d_f-d_r}{2}
\]

The last term is the asymmetry error. More samples reduce random variation but do not remove a stable path asymmetry. Transparent clocks can report residence-time corrections and boundary clocks create new timing domains, but neither name guarantees a particular end-to-end accuracy. Profile, topology, hardware support, servo state, holdover behavior, and asymmetry must be recorded.

Grandmaster selection and GNSS discipline are operational subjects, not magic accuracy sources. Monitor identity, port state, offset/path-delay estimates, servo state, frequency adjustment, time-scale configuration, leap-second state, and holdover alarms. For relative latency on one host, a common monotonic clock may be better than translating through UTC. For UTC traceability across devices, record the synchronization chain and uncertainty.

## 48.4 Acceleration boundaries: fixed function, SmartNIC, and FPGA

Acceleration is valuable when it removes a dominant path stage without breaking correctness or observability.

### Three broad device styles

- A **fixed-function NIC** has vendor-defined parsers, queues, filters, and offloads.
- A **programmable NIC or SmartNIC** adds a programmable pipeline, embedded processor complex, FPGA fabric, or a combination.
- An **FPGA-based NIC** exposes reconfigurable logic close to the packet path and host interface.

Product names do not define architecture consistently. “DPU,” “IPU,” and “SmartNIC” are marketing categories. Record the actual execution resource, memory hierarchy, pipeline constraints, queue crossings, and software/bitstream version.

An embedded general-purpose core is not inherently faster or slower than a host core. Its value may be isolation, host-CPU reclamation, direct access to NIC state, or deterministic placement. Measure the complete path; moving work to a device can add a hop for packets that still need the host.

### When offload helps

Good candidates are work with:

- a bounded protocol and state space;
- high per-packet repetition;
- a clear hardware-friendly pipeline;
- limited shared mutable state;
- a benefit from acting before host DMA or scheduling;
- a reliable fallback and observable failure mode.

Examples include classification, filtering, replication, timestamping, simple feed arbitration, checksums, encryption under a supported state model, and narrowly defined trigger logic.

Poor candidates include rapidly changing algorithms, large irregular models, unbounded parsing, complex recovery, or logic whose correctness depends on host state that cannot be synchronized cheaply.

### FPGA cut-through processing

An FPGA pipeline can sometimes parse earlier fields while later frame bytes are still arriving. This can reduce the decision’s dependency on full-frame reception and host notification. It does not abolish:

- serialization until each required field arrives;
- PHY/MAC and clock-domain crossing;
- parsing and pipeline stages;
- output arbitration and egress serialization;
- protocol checks that require later fields;
- queueing behind an already transmitting frame;
- error handling when the frame later fails validation.

Therefore a “wire-to-wire FPGA latency” must define:

- ingress reference: first bit, start-of-frame delimiter, end of required field, or end of frame;
- egress reference: enqueue, first transmitted bit, or end of frame;
- frame size and link rate;
- whether frames were already queued;
- decision path and enabled checks;
- FPGA image, synthesis constraints, place-and-route result, board, transceiver, and clock;
- sample count, statistic, loss, and measurement apparatus.

Do not transfer a latency number between bitstreams or board configurations.

### FPGA order entry

A common boundary is **pre-staged transmission**:

1. Host software constructs and validates an order template.
2. It publishes the payload and metadata into device-visible storage.
3. It atomically arms a generation/version.
4. FPGA logic recognizes an inbound trigger.
5. It validates the armed state and hardware-resident risk limits.
6. It patches permitted fields, updates length/checksum/sequence state as required, and schedules TX.
7. It reports the decision and completion to the host.

The safety problem is harder than the comparator:

- partially published templates must never fire;
- a late disarm must not re-enable an old generation;
- duplicate or reordered feed messages must not double-trigger;
- sequence numbers and sessions must remain correct;
- all mandatory pre-trade controls must be on the actual path;
- kill, cancel, recovery, and reconciliation paths must work when PCIe or host software fails;
- retransmission/recovery cannot silently send a different semantic order.

Use a versioned slot state such as `EMPTY → PREPARED(version) → ARMED(version) → FIRED(version)` with one owner for each transition. The precise atomicity mechanism is a device contract. A host memory barrier alone does not define visibility through PCIe and FPGA logic.

### FPGA and bypass hybrids

Hybrid designs keep a narrow trigger/transmit path in hardware and send the complete feed and device events to a bypass application for strategy, monitoring, recovery, and slow-path orders.

This creates two timelines:

```text
fast: ingress → FPGA parse/state/risk → egress
slow: ingress → DMA → CPU strategy/state/reconcile → control update → FPGA
```

The critical invariant is agreement between hardware and software state. Include monotonically identified input events, configuration generations, fired-order IDs, acknowledgments, and replayable logs. Measure fast-path latency separately from host visibility and reconciliation lag.

Choose acceleration only after locating the budget. If external switch queueing dominates, an FPGA host path may not improve end-to-end outcome. If CPU parsing dominates and the parser is bounded, it may.

## Core measurement: wire to application

The next sections turn the path into an explicit experiment: define endpoints, calibrate clocks, account for loss, derive the packet budget, and sweep through saturation.

## 48.5 Define endpoints and the error model

Write the measurement as an equation. For RX:

\[
L_{\text{wire→app}} =
L_{\text{tap/PHY}} +
L_{\text{MAC/NIC}} +
L_{\text{queue}} +
L_{\text{DMA/PCIe}} +
L_{\text{notify/driver}} +
L_{\text{stack}} +
L_{\text{schedule}} +
L_{\text{app boundary}}
\]

Not every component is separately observable. The equation prevents an omitted component from silently becoming zero.

For two timestamp readings:

\[
\hat L = (T_B + e_B) - (T_A + e_A)
\]

where \(e_A\) and \(e_B\) include clock offset, rate error, timestamp placement error, quantization, and capture/association error. If clocks differ, relative offset appears directly. If maximum relative frequency error is bounded by \(|\epsilon|\), additional time uncertainty after \(\Delta t\) without a new calibration can be bounded by \(|\epsilon|\Delta t\). Add worst-case bounds for a conservative bound; combine variances only with a justified stochastic independence model.

Every result should state:

- event A and event B;
- direction;
- clocks and their synchronization/translation;
- calibration time and uncertainty;
- timestamp provider/placement;
- trigger/response correlation rule;
- workload and frame distribution;
- independent sample unit/count and statistic.

### One-way versus round-trip

One-way delay measures a direction but usually needs synchronized endpoints or a common external clock. Its observed value includes relative clock offset.

Round-trip time can use one clock:

\[
RTT = t_{\text{return}} - t_{\text{send}}
\]

but contains forward delay, remote turnaround, and reverse delay:

\[
RTT = d_f + p_{\text{remote}} + d_r
\]

Dividing by two assumes a known or negligible turnaround and symmetric directions. That is a model, not a measurement. Report RTT as RTT unless those assumptions are tested.

For tick-to-action measurement, a high-quality design taps inbound and outbound links into two channels of one capture clock. Calibrate channel skew and tap/fibre asymmetry, verify no capture loss, and correlate the response with an explicit triggering sequence ID. “Nearest preceding packet” fails during bursts and can bias latency downward.

### Error inventory

| Source | Symptom | Detection/control |
|---|---|---|
| Different clock offset | Constant or slowly changing shift; possible negative delays | Common clock or repeated cross-timestamp calibration |
| Clock rate error | Delay estimate drifts with elapsed time | Frequency/servo telemetry; shorten calibration interval |
| Path asymmetry | Biased one-way time despite stable PTP | Calibrated links, topology reversal, common capture clock |
| Timestamp placement | Missing fixed or variable stages | Device documentation and loopback/tap experiment |
| Capture channel skew | Direction-dependent constant | Swap channels; calibrated simultaneous stimulus |
| Offload/aggregation | Impossible sizes or altered packet counts | External capture; record offloads |
| Capture loss | Gaps concentrated during bursts | Capture and interface drop counters; second observer |
| Wrong association | Implausibly small/negative response delays | Protocol identifiers; ambiguity count |
| Probe effect | Outcome changes when capture enabled | A/B collection-control runs |

Precision is not accuracy. A timestamp displayed to nanoseconds may have much larger uncertainty. Averaging can reduce some zero-mean random error, not systematic placement, offset, or asymmetry.

## 48.6 Capture: tcpdump, Wireshark, and libpcap

Host capture answers “what crossed this capture hook?” An external optical/electrical tap answers a different question. A switch mirror may drop, reorder, or apply its own timestamp behavior under load. Document the observation point.

### tcpdump and Wireshark

A bounded Linux capture might begin with:

```sh
tcpdump --version
tcpdump -D
tcpdump -i eth0 -nn -s 0 -w trial.pcap
```

Record the exact filter, snap length, capture buffer setting, timestamp type/precision, interface, offloads, and tool versions. Check tcpdump’s final received/dropped counts. A zero displayed drop count is not proof that upstream NIC or switch loss was zero.

Wireshark is valuable for protocol decoding, sequence analysis, I/O graphs, and expert warnings. Its displayed “time” can be absolute, relative, delta, or adjusted; choose explicitly. A checksum warning on locally transmitted traffic can reflect checksum offload rather than a corrupt wire frame. Verify externally before diagnosing the network.

### libpcap

libpcap lets an application select a device, snap length, promiscuous mode, buffer size, timeout/immediate behavior, timestamp type and precision where supported, and a compiled BPF filter before activation. Requested settings may be adjusted or unsupported; query the activated handle and record results.

Minimal control flow:

```text
h = pcap_create(device)
set snaplen, buffer, timeout/immediate mode
enumerate/select timestamp type and precision if supported
compile + install filter
activate; record warnings and effective settings

while experiment_active:
    dispatch packets
    for each packet:
        retain capture timestamp, captured length, original length,
        interface/direction metadata, sequence identity

read pcap_stats
store ps_recv, ps_drop, ps_ifdrop with platform semantics
close handle
```

`pcap_stats` fields are not fully portable. `ps_drop` and `ps_ifdrop` availability and counting semantics differ by platform. The capture file alone cannot prove completeness; preserve source sequence numbers and independent device counters.

Capture work itself can cause drops or perturb the host. Filter early when that preserves the target population, write to adequate storage, avoid expensive live decoding during the run, and compare application behavior with and without capture.

## 48.7 Loss and jitter are layered

Packet loss must be localized:

```text
source generated
  ├─ lost before tap/switch
tap observed
  ├─ lost in network
NIC port observed
  ├─ rejected/classified/dropped in NIC
DMA/completion observed
  ├─ lost in driver/kernel queue
socket/bypass observed
  ├─ overwritten/dropped by application queue
application processed
```

Use monotonically increasing protocol sequence numbers where available. At each layer retain counts with definitions and reset/wrap behavior:

- source offered and transmitted;
- external tap/capture observed and dropped;
- switch ingress/egress and discard counters;
- NIC MAC/PHY error and discard counters;
- per-queue no-buffer/missed counters;
- kernel and socket drop indicators;
- bypass-ring and application-queue overruns;
- application accepted, duplicate, stale, invalid, and processed counts.

Counter names are not standardized across drivers. Use `ethtool -S eth0` plus exact driver documentation and a controlled fault. `ip -s link show dev eth0` and protocol statistics provide other views, but counters can overlap. Do not sum overlapping layers as if they were disjoint.

Define loss rate from a named population:

\[
\text{loss fraction} =
\frac{N_{\text{expected}}-N_{\text{accepted exactly once}}}
     {N_{\text{expected}}}
\]

Separate missing, duplicate, corrupt, late, and reordered packets. For an application with a freshness deadline, “arrived after deadline” may be an operational loss even though the NIC delivered it.

**Jitter** is variation in a defined delay or interarrival process. Avoid one undocumented scalar. Report:

- the underlying latency or interarrival distribution;
- units and timestamp point;
- central and tail summaries;
- consecutive differences if that is the chosen packet-delay-variation definition;
- burst/gap sequence and loss;
- clock-error bound.

Host software timestamps can show batching caused by interrupt moderation or scheduling rather than wire jitter. Hardware or external timestamps help distinguish them.

## 48.8 Packet-rate arithmetic

At the Ethernet MAC service boundary, a conventional minimum frame occupies:

- 64 bytes from destination address through frame check sequence;
- 8 bytes of preamble and start-frame delimiter;
- 12 byte-times of interpacket gap.

Under those declared assumptions, one minimum frame consumes 84 byte-times, or 672 bit-times. Thus:

\[
PPS = \frac{\text{MAC bit rate}}
            {8(\text{frame bytes} + 8 + 12)}
\]

Calculated examples:

| Declared MAC rate and frame | Calculated packets/s | Calculated serialization opportunity |
|---|---:|---:|
| 10 Gb/s, 64-byte frame | 14.880952 Mpacket/s | 67.2 ns/packet |
| 25 Gb/s, 64-byte frame | 37.202381 Mpacket/s | 26.88 ns/packet |
| 100 Gb/s, 64-byte frame | 148.809524 Mpacket/s | 6.72 ns/packet |
| 10 Gb/s, 1,518-byte frame | 0.812744 Mpacket/s | 1.2304 µs/packet |

These are arithmetic upper bounds on continuously occupied MAC time, not guaranteed NIC, PCIe, host, switch, or application rates. Pause frames, link-layer control traffic, FEC/PCS behavior, VLAN/tunnel headers, bursts, flow-control gaps, device packet-rate limits, and the actual frame-size distribution change the usable result.

The following C++23 program validates the arithmetic and two ring-coverage examples:

```cpp
#include <cstdint>
#include <iomanip>
#include <iostream>

constexpr long double packets_per_second(std::uint64_t bits_per_second,
                                         std::uint64_t frame_bytes) {
    constexpr std::uint64_t preamble_sfd = 8;
    constexpr std::uint64_t interpacket_gap = 12;
    const auto byte_times = frame_bytes + preamble_sfd + interpacket_gap;
    return static_cast<long double>(bits_per_second) /
           (8.0L * static_cast<long double>(byte_times));
}

constexpr std::uint64_t packets_during_gap(long double pps,
                                           long double gap_seconds) {
    // Precondition: inputs are finite and nonnegative, and their product is
    // representable as std::uint64_t.
    const long double exact = pps * gap_seconds;
    const auto whole = static_cast<std::uint64_t>(exact);
    return whole + (static_cast<long double>(whole) < exact ? 1U : 0U);
}

int main() {
    constexpr auto pps_10g_min =
        packets_per_second(10'000'000'000ULL, 64);
    constexpr auto pps_10g_1518 =
        packets_per_second(10'000'000'000ULL, 1'518);

    static_assert(packets_during_gap(1'500'000.0L, 200e-6L) == 300);
    static_assert(packets_during_gap(pps_10g_min, 200e-6L) == 2'977);

    std::cout << std::fixed << std::setprecision(6)
              << "10G minimum-frame Mpps: " << pps_10g_min / 1e6L << '\n'
              << "10G 1518-byte Mpps: " << pps_10g_1518 / 1e6L << '\n';
}
```

For goodput, count useful application bytes once:

\[
\text{goodput} =
\frac{\text{useful bytes accepted}}
     {\text{measurement duration}}
\]

For a calculated UDP/IPv4 example with no options or VLAN tag, one 40-byte application message occupies:

\[
14_{\text{Ethernet}}+20_{\text{IPv4}}+8_{\text{UDP}}+
40_{\text{data}}+4_{\text{FCS}}+8_{\text{preamble}}+12_{\text{gap}}
=106\text{ byte-times}
\]

Its calculated link efficiency is \(40/106 \approx 37.74\%\). Packing ten such messages in one datagram under the same assumptions gives \(400/466 \approx 85.84\%\). These calculations do not include application-level envelope headers, timestamps, VLANs, tunnels, loss, or retransmission.

## 48.9 Capacity and saturation

Define:

- **offered load:** packets, bits, or messages presented per second;
- **accepted load:** work admitted at a named boundary;
- **throughput:** work completed at a named boundary per second;
- **goodput:** useful nonduplicate application data completed per second;
- **capacity:** the greatest load meeting a declared correctness, loss, and latency criterion for a declared duration.

Capacity is not “the highest number printed before the test ended.” Use an open-loop generator whose schedule does not wait for responses. Verify offered load with an independent counter or capture. If the generator cannot sustain a step, report the achieved offered rate rather than the requested rate.

A useful sweep:

1. Fix topology, frame/message distribution, flow count, offloads, and queue placement.
2. Start well below expected saturation.
3. Increase offered load in randomized or otherwise drift-controlled steps.
4. At every step record offered, accepted, goodput, every loss layer, queue depth/residence evidence, CPU/device utilization, and latency distribution.
5. Hold each step long enough to cover relevant bursts and state transitions.
6. Repeat independent runs near the transition.
7. Define capacity as the highest range satisfying the predeclared service criteria with uncertainty.

The “knee” is measured, not assumed to occur at a universal utilization. Saturation may appear as:

- increasing queue residence and latency tails;
- NIC or driver no-buffer drops;
- application queue overflow;
- flat goodput with growing offered load;
- throughput collapse from livelock or retry work;
- unfairness between flows;
- timestamp/capture loss before workload loss.

Small frames may hit packet/descriptor/transaction limits before bit rate. Large frames may hit byte bandwidth. One flow may hit one queue/core before total device capacity. Report a surface over frame sizes, flow counts, and rates when those dimensions matter.

## 48.10 Worked packet-budget and timestamp diagnosis

The following values form one **illustrative calculated-and-measured record**. They are not vendor specifications.

### Declared setup

- two hosts connected through one named switch and two named 10 GbE NIC ports;
- NIC model, firmware, driver, PCIe link state, kernel, and `ethtool` outputs archived;
- fixed CPU/NUMA placement and offload state archived;
- UDP frames of 64 bytes from destination address through FCS for the packet-rate test;
- open-loop hardware generator;
- 30 independent 60 s runs per offered-load point in randomized order;
- RX hardware timestamp at the documented MAC provider, application timestamp immediately after bypass completion dequeue;
- PHC-to-host cross-timestamp calibration before and after each run;
- external two-channel capture with one clock, calibrated channel-skew bound;
- sequence number in every payload;
- statistics computed over runs; packet distributions retained separately.

Every measured number below belongs only to that setup.

### Budget

At the declared 10 Gb/s MAC rate and 64-byte frame, the §48.8 calculation gives 14.880952 Mpacket/s and 67.2 ns between frame starts under continuous occupancy. A measured worst host refill gap of 80 µs—the maximum across the 30 runs at one declared load point—corresponds arithmetically to:

\[
\lceil 14.880952\times10^6 \times 80\times10^{-6}\rceil
=1{,}191\text{ packet opportunities}
\]

The configured 1,024-descriptor ring therefore cannot by itself cover that calculated worst case even if every descriptor holds one packet and the ring begins empty. The conclusion is not “set the ring to 2,048.” The intervention should target the 80 µs stall and separately evaluate whether added buffering meets the freshness budget.

### Timestamp symptom

At a measured offered load of 12.0 Mpacket/s:

- the median over 30 runs of each run’s median hardware-to-application delta was 3.1 µs;
- the median over 30 runs of each run’s p99 delta was 7.4 µs;
- 8 of 30 runs contained intervals where the application delta exceeded 60 µs;
- source-to-external-capture sequence accounting found zero missing frames in those runs;
- NIC-to-application accounting found 18,420 missing sequence IDs across the affected 8 runs, out of the exact per-run offered counts stored in the artifact;
- the driver’s documented no-buffer counter increased by the same count in this illustrative record;
- external capture’s calibrated inter-channel uncertainty bound was ±12 ns for the run configuration;
- PHC-to-host conversion uncertainty was bounded at ±90 ns across each run by the stated calibration method.

The long delta is much larger than the declared clock-conversion bound, so clock uncertainty alone cannot explain it. The matching sequence and documented no-buffer counts place loss between NIC reception and a usable host buffer. Scheduler tracing finds the 80 µs refill gap on the queue’s polling CPU.

### Intervention

The suspected cause is a periodic statistics callback in the polling thread. Move it to a control thread while preserving queue, ring, and offered load. Repeat the 30-run randomized design.

In this illustrative result:

- the maximum observed refill gap across the 30 candidate runs becomes 11 µs;
- the candidate has zero application sequence gaps at 12.0 Mpacket/s across the exact offered counts;
- the median over 30 candidate runs of per-run p99 hardware-to-application delta is 6.9 µs;
- an additional larger-ring control removes loss in the baseline but leaves a measured long tail above the application freshness limit.

This supports a bounded causal conclusion:

> In the recorded configuration at the declared 12.0 Mpacket/s workload, moving the periodic callback off the poll thread removed the observed refill stall and associated RX no-buffer loss. Increasing ring depth masked loss but did not meet the declared freshness criterion.

It does not establish capacity at 14.880952 Mpacket/s, another frame distribution, another NIC, or another queue count. A complete capacity sweep is still required.

## Skippable reference

### 48.11 Choosing the observation point

| Claim | Minimum defensible observation |
|---|---|
| Frame crossed physical link | Calibrated external tap/capture or documented port timestamp |
| NIC received frame | Documented NIC/MAC counter or RX hardware timestamp |
| Host buffer became available | Device completion with documented semantics |
| Kernel accepted datagram | Named kernel/socket point and counter |
| Bypass application saw packet | Completion dequeue plus sequence ID |
| Frame began transmission | Documented TX hardware timestamp near egress |
| TX buffer may be reused | Completion under the device ownership contract |
| End-to-end application latency | Application-defined start/end plus correlation and clocks |
| Wire-to-wire reaction | Two directions captured in one calibrated clock domain |

### 48.12 Decision checklist for acceleration

1. What measured component dominates the target percentile or deadline miss?
2. Which stage will the accelerator remove rather than relocate?
3. Can required state, parsing, risk, and error handling fit?
4. What queue or bridge does acceleration add?
5. What is the fallback when device logic, host control, link, or clock fails?
6. How are configuration generations and events reconciled?
7. Can the accelerated path be captured, timestamped, and replayed?
8. Which product/firmware/bitstream claims require revalidation after upgrade?
9. Does the improvement persist end to end under representative offered load?

### 48.13 Primary references

- Linux kernel, [Timestamping](https://docs.kernel.org/networking/timestamping.html): `SO_TIMESTAMPING`, TX error-queue delivery, hardware providers, and device configuration.
- Linux kernel, [Scaling in the Linux Networking Stack](https://docs.kernel.org/networking/scaling.html): RSS, RPS, RFS, and XPS.
- Linux kernel, [Segmentation Offloads](https://docs.kernel.org/networking/segmentation-offloads.html): TSO, GSO, GRO, and related offloads.
- Linux kernel, [ethtool netlink interface](https://docs.kernel.org/networking/ethtool-netlink.html): versioned device-query and timestamp-provider interfaces.
- linuxptp, [`ptp4l`](https://www.linuxptp.org/documentation/ptp4l/) and [`phc2sys`](https://www.linuxptp.org/documentation/phc2sys/): PHC synchronization and time-scale behavior.
- libpcap, [`pcap_stats`](https://man7.org/linux/man-pages/man3/pcap_stats.3pcap.html): capture-statistic definitions and portability warnings.
- Wireshark, [User’s Guide](https://www.wireshark.org/docs/wsug_html_chunked/): capture, timestamp display, checksum, and protocol-analysis behavior.

Use the documentation matching the installed kernel, tool, driver, NIC, and firmware. “Latest” documentation is not evidence for an older deployed system.

## Recall card

- A descriptor represents buffer ownership; it is not necessarily one packet.
- RX: post → NIC owns → receive/DMA → completion → software owns → recycle.
- TX acceptance, descriptor completion, hardware timestamp, and wire departure are different events.
- Multiple queues trade parallelism against ordering, locality, imbalance, and buffering.
- Ring lower bound for a service gap is \(\lceil Rg\rceil\), then add occupancy and burst assumptions.
- Offloads move work and alter capture semantics; choose them per goal.
- A hardware timestamp is near a documented provider, not automatically at the wire.
- TX timestamps on Linux are asynchronous; drain and correlate the error queue.
- One-way time across clocks includes relative offset; RTT includes two paths and turnaround.
- PTP symmetry error is \((d_f-d_r)/2\); averaging does not remove it.
- External single-clock capture avoids endpoint offset but needs channel calibration and loss checks.
- Minimum-frame MAC PPS uses 64 + 8 + 12 byte-times under the declared Ethernet assumptions.
- Offered load, accepted load, throughput, goodput, and capacity are different.
- Find saturation with an open-loop sweep and report latency, goodput, and loss together.
- FPGA benefit comes from a bounded pipeline and earlier action, not a universal latency number.

## Review questions

1. Why can an RX ring with 1,024 descriptors hold fewer than 1,024 packets?
2. Distinguish TX socket acceptance, descriptor completion, and hardware egress timestamp.
3. Why can GRO make a host capture unsuitable for a wire packet-count claim?
4. Derive the packet rate for a declared link rate and frame size. Which overheads must be named?
5. What clock and path assumptions are hidden by reporting one-way latency?
6. Why is RTT/2 generally not a measured one-way delay?
7. How does a stable forward/reverse path asymmetry bias a PTP offset estimate?
8. Give two ways a larger RX ring can improve one outcome while harming another.
9. What must an FPGA order-entry path do besides recognize a trigger?
10. How would you distinguish source loss, NIC no-buffer loss, capture loss, and application-queue loss?

## Exercise

Measure one receive path at three offered-load levels.

Before running:

1. draw the wire-to-application stages;
2. name the timestamp provider and clock domain;
3. record NIC, firmware, driver, kernel, queue, ring, coalescing, offload, CPU, and NUMA state;
4. derive expected packet rate from the actual frame-size distribution;
5. choose source, capture, NIC, kernel/bypass, and application sequence/drop counters;
6. define a freshness deadline, loss limit, and independent run count.

At each load, retain raw timestamp deltas and all counts. Repeat once with a single controlled change—coalescing, queue placement, offload, or ring depth. Explain the result as a path change, not just a percentage.

Then audit your own report: could a reader tell whether the timestamp begins at first bit, end of frame, hardware provider, driver entry, or application dequeue? If not, the central number is not yet publishable.

## Puzzle

After enabling RX hardware timestamps, a team reports that “wire-to-application latency” improved by several microseconds, even though no packet-processing configuration changed. External capture shows identical application response times. What happened?

The likely error is a changed start point, not a faster path. The previous software timestamp may have been generated later in the host receive path than the hardware timestamp—or the two values may have been translated incorrectly between PHC and system clock domains. Subtracting each from the same application timestamp changes the reported interval. A hardware stamp can reveal more of the path, but enabling it cannot retroactively accelerate the packet. Define both old and new placement and validate clock conversion against the external common-clock measurement.

## Common traps

- Calling a MAC or completion timestamp “the wire” without provider documentation.
- Comparing PHC and system-clock values without conversion and uncertainty.
- Displaying nanoseconds and implying nanosecond accuracy.
- Treating more PTP samples as a cure for stable path asymmetry.
- Reporting RTT/2 as one-way delay without symmetry and turnaround evidence.
- Correlating a response with the nearest earlier packet during a burst.
- Believing host capture preserves wire packet boundaries with offloads enabled.
- Diagnosing locally captured partial checksums as wire corruption.
- Assuming tcpdump can see a bypass path.
- Ignoring capture drops because application counters look complete—or vice versa.
- Treating driver counter names as portable semantics.
- Summing overlapping drop counters.
- Forgetting duplicates and late packets in “loss” accounting.
- Equating a descriptor with a packet.
- Sizing a ring from average PPS instead of burst/service-gap behavior.
- Increasing a ring without checking added residence time and freshness.
- Assuming a documented maximum ring depth is the right operating depth.
- Treating more queues as universally better.
- Moving a flow between queues without checking ordering.
- Quoting line-rate PPS as measured host capacity.
- Omitting preamble and interpacket gap from small-frame arithmetic.
- Reporting requested generator rate instead of observed offered rate.
- Using a closed-loop generator to find saturation.
- Defining capacity without latency and loss criteria.
- Benchmarking only one frame size or flow distribution.
- Enabling/disabling all offloads as a ritual instead of matching the endpoint.
- Assuming SmartNIC or DPU product naming identifies its datapath.
- Quoting FPGA, PHY, PCIe, or NIC latency without board/image/version and endpoints.
- Accelerating the comparator while leaving risk or recovery outside the actual path.
- Publishing a staged order before its payload and version are coherently visible.
- Measuring the fast FPGA path but excluding host reconciliation and failure behavior.

## Prerequisite check

You are ready to use this chapter when you can:

- distinguish an Ethernet frame, IP packet, transport datagram/segment, and application message;
- explain DMA descriptor ownership and why memory ordering is device-specific;
- distinguish bit rate, packet rate, throughput, and goodput;
- explain the difference between a clock’s resolution and its accuracy;
- identify at least three possible receive timestamp points;
- use sequence numbers to localize a gap;
- state why a profile, counter, or timestamp difference needs a controlled intervention.

If any item is unfamiliar, begin with one RX queue and two observation points. Draw ownership, capture one fixed workload, reconcile every sequence number, and attach a clock domain to every timestamp before optimizing anything.
