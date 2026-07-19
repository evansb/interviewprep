# Chapter 48 — NICs, Acceleration and Measurement

*Interview-focused revision notes. The theme: every layer below the socket API is a latency budget you can either spend or reclaim — and none of it means anything until you can measure it with a clock you trust and a tap that doesn't lie.*

---

## 48.1 FPGA-Based NICs

A **field-programmable gate array** is a chip of reconfigurable logic: a fabric of lookup tables (LUTs), flip-flops, block RAM, and DSP slices, wired together by a synthesized netlist. Unlike a CPU it does not fetch and execute instructions; the "program" *is* the circuit. That distinction is the entire latency argument. A CPU processing a packet must at minimum have the bytes DMA'd to memory, notice them (interrupt or poll), fetch them into L1 (Ch. 29 §29.22), decode them with branchy code, and issue a response through the transmit path. An FPGA sitting between the SFP+ cage and the PCIe bus can start reacting to a packet **while the packet is still arriving on the wire**.

**Cut-through parsing** is the key mechanism (compare cut-through switching, Ch. 39 §39.2). A 10 GbE link delivers 64 bits per 6.4 ns cycle at 156.25 MHz. The Ethernet header is 14 bytes, IPv4 20, UDP 8 — 42 bytes, or ~34 ns of wire time. An FPGA pipeline can have the message type decoded and a comparator loaded before the payload's last byte has arrived. A CPU cannot begin until the *entire* frame is received, checked, and DMA'd, because the NIC only signals completion at end-of-frame.

```
Wire arrival:  [preamble][eth][ip][udp][----- payload -----][FCS]
                          ^          ^                        ^
FPGA:                     |parse     |compare/decide          |emit TX (start)
CPU path:                                                     |----DMA----|IRQ/poll|L1 miss|parse|...
```

**Latency scale.** Wire-to-wire on a tuned FPGA trading path is roughly 20–100 ns for a simple decision; a kernel-bypass CPU path (Ch. 47) is roughly 1–5 µs tick-to-trade, and a kernel socket path 10–50 µs. Two orders of magnitude separate the top and bottom.

**What you give up:**

| Property | FPGA | CPU (bypass) |
|---|---|---|
| Latency | 20–100 ns wire-to-wire | 1–5 µs |
| Jitter | Deterministic, cycle-accurate | Interrupts, cache misses, C-states |
| Logic complexity | Severely limited by LUT/BRAM budget | Effectively unlimited |
| Iteration time | Hours (synthesis + place-and-route) | Seconds (compile) |
| Debuggability | Simulation, ILA/ChipScope probes | gdb, perf, printf |
| Floating point | Expensive; use fixed-point (Ch. 23 §23.10) | Native |
| Cost | High (hardware + FPGA engineers) | Commodity |

**Determinism is the underrated half.** An FPGA's latency distribution is nearly a spike: same path, same cycle count, every time. A CPU's is a long right tail driven by cache misses, TLB misses, IRQs, and frequency transitions (Ch. 35 §35.11–§35.13). For strategies where the *99.9th percentile* decides fills, removing the tail is often worth more than removing the mean.

**Vendors and forms.** AMD/Xilinx (Alveo, UltraScale+, Versal) and Intel/Altera (Agilex, Stratix) dominate; trading-specific boards come from Exablaze/Cisco Nexus SmartNIC, Solarflare/AMD X2/X3 with "Application Onload Engine" (AOE) FPGA variants, Enyx, NovaSparks, and Metamako/Arista layer-1 devices. Development is via VHDL/Verilog, or High-Level Synthesis (HLS) which compiles a restricted C++ subset to RTL — useful for datapath prototyping, rarely competitive with hand-written RTL on the critical path.

**Interview framing:** "Why is an FPGA faster than a well-tuned C++ program?" The strong answer is not "hardware is fast" — it is *cut-through processing plus no instruction fetch/decode plus deterministic pipelining*, and the cost is a logic budget measured in LUTs and a build measured in hours.

---

## 48.2 FPGA Order Entry

**Order entry** is the path from a trading decision to an order message on the wire toward the exchange's matching engine (Ch. 50 §50.18). Putting it in an FPGA is the most common production FPGA application in trading, and it comes in three architectures.

**1. Full-FPGA (autonomous) path.** The FPGA parses market data, evaluates a decision, and emits the order — the CPU never touches the critical path. Wire-to-wire ~30–100 ns. The strategy must fit in the fabric: comparators against thresholds, simple book state, fixed-point arithmetic. Anything requiring a model evaluation, a large lookup, or a floating-point computation does not fit.

**2. Pre-staged trigger ("firing solution", "canned order").** The dominant production design and the one interviewers probe. The CPU computes the *content* of an order in advance and writes it into the FPGA's buffer; the FPGA holds it armed and, on detecting a trigger condition in the inbound feed, transmits it immediately.

```
CPU (slow path, microseconds):
    build order template  →  DMA into FPGA "order slot" N
    write arm/trigger predicate (price threshold, symbol, side)
FPGA (fast path, nanoseconds):
    on each inbound feed message:
        if (symbol == armed.symbol && price crosses armed.threshold && armed.enabled)
            emit slot N onto TX  (already-serialized bytes, checksum precomputed)
```

The genius of this split is that all complexity — strategy, risk, message construction, sequence numbers, checksums — is done ahead of time on the CPU, and the FPGA does only a comparison and a DMA-to-wire. The FPGA's task reduces to *"stream these N bytes when this predicate fires."*

**3. Hybrid / "TCP offload with FPGA punt".** The FPGA maintains the exchange TCP session (or at least the transmit side) so a pre-staged order can be sent with correct sequence numbers without CPU involvement. See §48.6.

**Non-obvious engineering details:**

- **Checksums and sequence numbers must be precomputed.** A TCP order carries a sequence number and checksum that depend on the exact bytes. Because the pre-staged payload is fixed, the checksum is computed once by the CPU. If the FPGA mutates any field (e.g. patches a quantity at fire time), it must incrementally adjust the checksum — RFC 1624 one's-complement update — in a single cycle.
- **Arming is a race.** Between "CPU decides to arm" and "market moves," the market can move. The disarm path must be as fast as the fire path, or you send stale orders. Production designs use a monotonically increasing generation counter so a late disarm cannot resurrect an old arm.
- **Pre-trade risk must live in the FPGA.** If the CPU is not in the path, the CPU's risk checks are not in the path either (Ch. 56 §56.13–§56.17). Regulatory regimes (SEC Rule 15c3-5, "the market access rule") require pre-trade controls on every order, so quantity, notional, and price-collar checks are synthesized into the fabric as fixed-point comparators. A candidate who mentions this unprompted is signalling real exposure to the domain.
- **Kill switch in hardware.** A single register write (or a physical signal) must be able to disable all slots in one cycle (Ch. 56 §56.18).

**Failure mode with signature:** an FPGA that fires on a *duplicate* market data packet from the redundant B feed (Ch. 37 §37.14) will double-fire. Diagnostic signature: two identical orders separated by the A/B feed skew (typically 5–200 µs), on exactly the trigger event. Fix: sequence-number-based duplicate suppression in the fabric (Ch. 53 §53.5), not timestamp windows.

---

## 48.3 SmartNICs

A **SmartNIC** is a NIC with a general-purpose programmable processing complex on it — as opposed to a fixed-function NIC (offloads only, §48.4-adjacent) or a pure FPGA NIC (§48.1). Three families:

| Type | Programming model | Example | Latency character |
|---|---|---|---|
| **FPGA-based** | RTL / HLS | AMD Alveo, Napatech | Lowest, deterministic |
| **ASIC + fixed pipeline** | P4, flow rules | Mellanox/NVIDIA ConnectX ASAP², Intel FXP | Low, but only expressible operations |
| **SoC-based (DPU)** | Linux + C on embedded cores | NVIDIA BlueField (Arm A72/A78), Marvell OCTEON, Intel IPU | *Higher* than host CPU per-packet |

The critical and frequently-missed point: **a SoC-based SmartNIC is usually slower per packet than your host CPU.** BlueField Arm cores run at ~2–2.75 GHz with far smaller caches than a Xeon or EPYC core. Moving packet processing onto them raises per-packet latency. Their value is *offload of work you want removed from the host* — infrastructure functions, not trading hot paths:

- Virtual switching (OVS), overlay encap/decap (VXLAN/Geneve)
- Storage initiator emulation (NVMe-oF), encryption (IPsec, TLS handshake offload)
- Isolation: the DPU runs the infrastructure so the host is untrusted tenant space
- Telemetry and capture without host CPU cost (relevant to §48.7–§48.8)

**When SmartNICs pay in low latency:**

1. **Timestamping and capture** at line rate with no host involvement (§48.4, §48.7).
2. **Fan-out / replication in hardware** — e.g. arbitrating redundant A/B multicast feeds on the NIC and delivering one deduplicated stream to the host, removing an entire host-side stage (Ch. 53 §53.6).
3. **Filtering** — dropping the 95% of a multicast feed your strategy doesn't care about before it consumes host PCIe bandwidth and cache. This is a genuine win: PCIe bandwidth and DDIO cache footprint (Ch. 29 §29.24) are real constraints at high message rates.
4. **Pre-staged order transmit** as in §48.2, if the platform supports it.

**P4** deserves a mention: a domain-specific language for describing packet-processing pipelines (parse graph, match-action tables, deparse). It targets programmable switch ASICs (Tofino) and some SmartNICs. It cannot express arbitrary computation — no loops, bounded state — which is exactly why it can compile to a fixed-latency pipeline.

**The evaluation question you should be able to answer:** "Should we offload X to a SmartNIC?" Ask (a) is X on the critical path or beside it? (b) does the offload *remove* a host-side stage, or merely relocate it? (c) what is the added latency for anything that still must reach the host — because a DPU in front of the host adds a store-and-forward hop, typically 1–3 µs. Offloading beside-the-path work is nearly always good; offloading on-path work to a slower core is nearly always bad.

---

## 48.4 NIC Hardware Timestamping

A **timestamp** here means a recorded time associated with a packet's arrival at or departure from a point in the system. Where that timestamp is taken determines what it can tell you.

**The three timestamp points:**

```
   wire ──► [PHY/MAC] ──► [NIC SRAM] ──► DMA ──► [host RAM] ──► driver ──► socket ──► app
              ^hardware TS               ^                       ^softirq TS   ^app read
              (PHC domain)                                       (SW TS, CLOCK_REALTIME)
```

| Timestamp | Taken by | Typical precision | Includes |
|---|---|---|---|
| **Hardware (HW)** | NIC MAC/PHY, PHC clock | 1–10 ns resolution, few-ns error | Nothing downstream |
| **Software receive (SW)** | Kernel, in NAPI/softirq context | ~100 ns resolution, µs-scale error | DMA + interrupt/poll + scheduling delay |
| **Application** | `clock_gettime` after `recvmsg` | ~20 ns resolution, µs-scale error | Everything, incl. app scheduling |

The **PHC (PTP hardware clock)** is a free-running counter on the NIC, exposed on Linux as `/dev/ptp0` (Ch. 35 §35.9). Hardware timestamps are in the *PHC time domain*, not `CLOCK_REALTIME`. Comparing an HW timestamp with a `clock_gettime(CLOCK_REALTIME)` value without translating domains is one of the most common measurement errors in the field (see §48.11).

**Enabling it.** Hardware timestamping is requested per-socket via `SO_TIMESTAMPING` and enabled per-device via `SIOCSHWTSTAMP` (Ch. 45 §45.9):

```cpp
int flags = SOF_TIMESTAMPING_RX_HARDWARE   // NIC stamps on receive
          | SOF_TIMESTAMPING_TX_HARDWARE   // NIC stamps on transmit
          | SOF_TIMESTAMPING_RAW_HARDWARE  // deliver in PHC domain, untranslated
          | SOF_TIMESTAMPING_SOFTWARE;     // also give me the kernel SW stamp
setsockopt(fd, SOL_SOCKET, SO_TIMESTAMPING, &flags, sizeof flags);
// ethtool -T eth0  →  shows which of these the device actually supports
```

Received timestamps arrive as ancillary data in `recvmsg` (`SCM_TIMESTAMPING`, a `struct scm_timestamping` with three `timespec`s: software, deprecated, raw hardware). **Transmit** timestamps do not come back with `send`; they arrive later on the **socket error queue**, read with `recvmsg(fd, &msg, MSG_ERRQUEUE)` (Ch. 45 §45.15). Forgetting to drain the error queue leaks buffers and eventually stalls TX timestamping — diagnostic signature: TX timestamps stop appearing after N packets, `ethtool -S` shows no drops, and `SO_TIMESTAMPING` TX counters flatline.

**Where the stamp is really taken matters.** Some NICs stamp at the MAC after the PHY has already deserialized; the PHY itself contributes latency (100–300 ns for 10GBASE-SR, more for 10GBASE-T which is ~2 µs and disqualifying for latency work). Crucially, **PHY latency is not always constant** — some PHYs have variable pipeline depth on link retrain. For absolute accuracy you must know and calibrate the *ingress/egress asymmetry* of your PHY.

**Non-obvious details:**

- Many NICs support HW timestamping only for **PTP packets** by default; you must set the filter to `HWTSTAMP_FILTER_ALL` to stamp everything, and some devices refuse.
- HW timestamp precision is not accuracy. A 1 ns *resolution* counter disciplined to a grandmaster with 200 ns of error gives you 200 ns of accuracy (§48.11).
- Timestamping typically costs nothing in the datapath — the counter is captured by the MAC regardless — but delivering it consumes an ancillary-data path, so `recvmsg` becomes mandatory (no `recv`), which is a measurable syscall cost difference on kernel paths.
- Kernel-bypass stacks (Ch. 47) have their own APIs: `ef_vi` returns per-packet hardware timestamps directly in the event queue, which is the cleanest source available.

---

## 48.5 PTP Grandmaster Clocks

**PTP** (Precision Time Protocol, IEEE 1588) distributes time over Ethernet with sub-microsecond accuracy, versus NTP's typical millisecond-to-100-µs range (Ch. 35 §35.6–§35.8). A **grandmaster** is the root clock of a PTP domain — the device that all others synchronize to, normally disciplined by GNSS (GPS/Galileo) with a holdover oscillator (OCXO or rubidium) for when satellites are lost.

**The mechanism.** PTP measures offset and path delay using four timestamps:

```
Master                          Slave
  |----- Sync (t1) ------------->| t2
  |----- Follow_Up (carries t1)->|          (two-step clocks only)
  |<---- Delay_Req (t3) ---------| t3
  | t4                           |
  |----- Delay_Resp (carries t4)>|

offset      = ((t2 - t1) - (t4 - t3)) / 2
path_delay  = ((t2 - t1) + (t4 - t3)) / 2
```

**The load-bearing assumption is path symmetry.** The offset formula divides total round-trip by two; if forward and reverse delays differ by Δ, your clock is wrong by Δ/2. Asymmetry sources: different physical fibre lengths per direction, asymmetric switch queueing, and — the big one — a switch that is not PTP-aware.

**One-step vs two-step.** A one-step clock writes t1 into the Sync message as it transmits (requires on-the-fly checksum correction in hardware); a two-step sends t1 afterwards in Follow_Up. Both are accurate; one-step halves message count.

**Transparent clocks vs boundary clocks** — a guaranteed interview discriminator:

| | Boundary clock (BC) | Transparent clock (TC) |
|---|---|---|
| Behavior | Terminates PTP; acts as a slave upstream and a master downstream | Forwards PTP, adding its measured residence time to the `correctionField` |
| Error accumulation | Each hop adds its own servo error; errors compound over hops | Residence time measured in hardware; error does not compound the same way |
| Effect of switch queueing | Hidden (BC re-times) | Explicitly measured and corrected |
| Typical use | Hierarchical networks | Trading networks (preferred) |

A switch that is *neither* — a plain store-and-forward switch — injects its variable queueing delay directly into t2−t1 as noise, and that noise is asymmetric under load. This is why "we have PTP" is not the same as "we have accurate time": PTP over non-PTP-aware switches under load can be worse than a well-tuned NTP setup.

**Profiles.** The default IEEE 1588 profile, the **telecom profile (G.8275.1/.2)**, and importantly for finance, PTP over multicast UDP vs Layer-2. MiFID II RTS 25 mandates clock accuracy for reportable events: 100 µs of UTC for most HFT participants, 1 ms for others, with divergence documented. Note the regulatory bar (100 µs) is *thousands of times looser* than what latency measurement requires (sub-µs) — compliance time and measurement time are different problems.

**Practical stack on Linux:** `ptp4l` disciplines `/dev/ptpN` (the PHC) from the network; `phc2sys` copies PHC time into the system clock (or vice versa); `ts2phc` disciplines the PHC from a PPS input. Health signals to monitor: `ptp4l` reported *master offset* (should be tens of ns, stable), path delay stability, and grandmaster GNSS lock/holdover state. Diagnostic signature of a failing GNSS antenna: offset stays small but slowly ramps as the grandmaster free-runs on holdover, and every host drifts *together* — so intra-site comparisons look fine while inter-site comparisons diverge.

---

## 48.6 FPGA and Kernel-Bypass Hybrids

Pure FPGA logic is fast but small; pure CPU logic is flexible but slow. Production systems overwhelmingly use a **hybrid**: the FPGA owns a narrow, latency-critical slice; a kernel-bypass CPU path (Ch. 47) owns everything else; and both see the same packets.

**The canonical split:**

```
          ┌──────────────────── FPGA ────────────────────┐
  wire ───┤ parse → filter → [trigger match] → TX order  ├──► wire  (~40 ns)
          │            │                                  │
          │            └── copy every packet ──► PCIe DMA ┤
          └───────────────────────────────────────────────┘
                                     │
                          ef_vi / DPDK RX ring (Ch. 47 §47.5)
                                     ▼
                        CPU: full book build, strategy,
                        risk state, arming/disarming FPGA slots
```

The FPGA is the **fast path**; the CPU is the **slow path** that keeps the fast path's state current (Ch. 52 §52.7). The CPU sees the same market data with a few microseconds of additional delay and reconciles.

**Design invariants that matter:**

1. **The FPGA must never depend on a CPU response to complete an action.** Any round trip to the host costs 1–2 µs of PCIe plus host processing — more than the entire FPGA budget. The FPGA either decides alone or does not decide.
2. **State must be idempotent and versioned.** The CPU writes "slot 7 = order X, generation 42, armed." The FPGA fires only if generation matches its expectation. Otherwise a CPU update that races a fire produces a hybrid order (new price, old quantity) — a real and terrifying failure mode. Slot updates must be atomic from the FPGA's perspective: write payload, then write the arm word last (a release-style publication, Ch. 25 §25.17), and the FPGA reads the arm word first.
3. **Both paths must share risk state, and the FPGA's copy is authoritative on the fast path.** If the CPU decrements remaining quantity but the FPGA has already fired, the CPU must reconcile from the FPGA's fill notifications, not from its own intent.

**Onload/ef_vi + AOE-style designs.** Solarflare/AMD X2/X3 cards with an on-board FPGA (the "Application Onload Engine" lineage) let you run standard kernel-bypass sockets *and* have FPGA logic in the datapath on the same card, avoiding an extra device hop. Exablaze/Cisco cards similarly expose an FPGA plus a normal NIC personality.

**Layer-1 devices** are the adjacent trick worth knowing: a Metamako/Arista 7130-class device can replicate a feed to N ports in ~4–5 ns (essentially a physical-layer fanout, no packet parsing at all), and can do "media-with-tap" replication for capture. Sub-5 ns fanout beats any switch by two orders of magnitude, and it is the standard way to feed both the FPGA and the capture appliance from one wire without adding measurable delay.

**What breaks.** Hybrids fail at the seams: PCIe backpressure stalling the DMA copy while the FPGA path continues fine (host sees a gap, FPGA does not — diagnostic: CPU book has sequence gaps but FPGA fill reports reference prices the CPU never saw), and arm/disarm races (§48.2). Instrument both paths with the *same* hardware clock domain so the seam is measurable.

---

## 48.7 tcpdump and Wireshark

**tcpdump** is a CLI packet capture tool built on libpcap (§48.8); **Wireshark** is a GUI/TUI analyzer (`tshark` for CLI) with thousands of protocol dissectors. Both read/write **pcap** and **pcapng** files.

**What you must know about the capture point.** `tcpdump` on a host captures via `AF_PACKET` — a tap *inside the kernel*, after the driver has processed the packet. Consequences:

- It sees packets **after** NIC offloads have already acted. With GRO/LRO enabled (Ch. 46 §46.9) you will see a single 8 KB "TCP segment" that never existed on the wire. With TSO/GSO (Ch. 46 §46.10) you see one giant outbound segment that the NIC will actually split. Anyone reasoning about wire behavior from a host capture without disabling offloads is reading fiction:
  ```
  ethtool -K eth0 gro off lro off tso off gso off ufo off
  ```
- **It cannot see kernel-bypass traffic at all.** Onload, DPDK, ef_vi, and VMA take the packet before the kernel stack; `tcpdump` shows nothing. This surprises people constantly. Mitigations: Onload's `onload_tcpdump`, DPDK's `pdump`, or — correctly — an external tap (§48.9).
- Its timestamps are **software** by default. `tcpdump --time-stamp-precision=nano` gives nanosecond *units*, not nanosecond *accuracy*; use `-j adapter_unsynced` / `-j adapter` to request NIC hardware timestamps where supported (`tcpdump -J eth0` lists available sources).

**Essential invocations:**

```bash
tcpdump -i eth0 -n -s 0 -w cap.pcap 'udp port 12345'   # -n: no DNS; -s 0: full frame
tcpdump -i eth0 -B 65536 --time-stamp-precision=nano -j adapter_unsynced -w cap.pcap
tcpdump -r cap.pcap -c 10 -tttt -vv                     # read back, absolute timestamps
tshark -r cap.pcap -T fields -e frame.time_epoch -e udp.length -E separator=,
```

**The drop counters are the first thing to check.** On exit tcpdump prints `N packets captured, M packets received by filter, K packets dropped by kernel`. Nonzero `dropped by kernel` means your capture is incomplete and any latency conclusion drawn from it is suspect — the drops are load-correlated, so you lose exactly the interesting bursts. Fixes: larger `-B` buffer, write to a fast local device or `-w -` into a compressor on another core, use `PACKET_MMAP` (libpcap does by default) and pin the capture process off your trading cores (Ch. 31 §31.17).

**Wireshark essentials for this domain:** custom dissectors (Lua for prototyping, C for volume), `Statistics → I/O Graph` for microburst visualization at 1 ms granularity, `tcp.analysis.retransmission` / `tcp.analysis.lost_segment` filters (Ch. 38), and *time reference* / delta-time columns to compute per-packet deltas. Be aware Wireshark's own "expert" TCP analysis is heuristic and reports spurious retransmissions when the capture itself dropped packets — a capture artifact misread as a network problem is a classic diagnostic dead end.

---

## 48.8 Packet Capture with libpcap

**libpcap** is the portable capture library beneath tcpdump. Understanding it matters because at trading message rates the naive path drops packets.

**The mechanism on Linux.** libpcap opens an `AF_PACKET` socket, attaches a compiled **BPF filter** (Ch. 45 §45.12) in the kernel so unwanted packets are discarded before being copied, and maps a ring buffer with `PACKET_MMAP` (`TPACKET_V3`) so packets are read from a shared memory ring with no per-packet syscall.

```c
pcap_t* p = pcap_create("eth0", errbuf);
pcap_set_snaplen(p, 65535);          // 0/65535 = full frame; small snaplen = headers only
pcap_set_promisc(p, 1);
pcap_set_timeout(p, 1);              // ms; buffering delay before delivery
pcap_set_buffer_size(p, 256<<20);    // kernel ring; the single most important knob
pcap_set_tstamp_type(p, PCAP_TSTAMP_ADAPTER_UNSYNCED);   // NIC hardware clock
pcap_set_tstamp_precision(p, PCAP_TSTAMP_PRECISION_NANO);
pcap_activate(p);
struct bpf_program fp; pcap_compile(p, &fp, "udp port 12345", 1, PCAP_NETMASK_UNKNOWN);
pcap_setfilter(p, &fp);
pcap_loop(p, -1, handler, nullptr);
```

**Timestamp source selection is the load-bearing call.** `pcap_list_tstamp_types` enumerates what the device offers:

| Type | Meaning |
|---|---|
| `PCAP_TSTAMP_HOST` | Host clock, taken by kernel — includes driver/IRQ delay |
| `PCAP_TSTAMP_HOST_LOWPREC` | Jiffy-granularity; useless for latency |
| `PCAP_TSTAMP_HOST_HIPREC` | Best host clock |
| `PCAP_TSTAMP_ADAPTER` | NIC hardware clock, synchronized to host time |
| `PCAP_TSTAMP_ADAPTER_UNSYNCED` | NIC hardware clock, free-running (best precision, own domain) |

`ADAPTER_UNSYNCED` gives you the tightest *relative* measurements (deltas between packets on the same NIC) at the cost of needing your own translation to wall clock. For measuring latency between two points on one card, that is exactly what you want.

**File formats.** Classic **pcap** has a 16-byte per-packet header with microsecond or nanosecond timestamps (indicated by magic number `0xa1b2c3d4` vs `0xa1b23c4d`) and one link type for the whole file. **pcapng** is the modern block-based format: multiple interfaces, per-interface timestamp resolution, comments, name resolution blocks. Trading capture appliances often write pcapng with nanosecond resolution and per-packet metadata.

**Snaplen is a real tuning decision.** Capturing 64 bytes per packet instead of 1500 cuts capture bandwidth by an order of magnitude and is sufficient for latency and sequence-number analysis — but destroys your ability to reconstruct the book from the capture. Full-payload capture at 10 Gbps sustained is 1.25 GB/s to disk; plan storage accordingly or use a purpose-built capture appliance (Corvil/Pico, Napatech, cPacket) with hardware timestamping and dedicated recording.

**Failure modes and their signatures:**

- **Kernel ring overflow** — `pcap_stats().ps_drop` climbs; drops cluster during microbursts (Ch. 39 §39.5), so your capture is systematically blind to the events you care about.
- **NIC-level drop** — `pcap_stats().ps_ifdrop` and `ethtool -S | grep -i drop`; the packet never reached the ring. Ring sizing (§48.13) is the fix, not buffer sizing.
- **BPF filter too permissive** — capture CPU saturates; a filter that must touch payload (`udp[8:4] == ...`) is far more expensive than a header-field match.
- **Writing to a shared/spinning disk** — write stalls backpressure into the ring. Always benchmark the writer independently.

---

## 48.9 Software and Hardware Timestamp Selection

The single most important measurement decision: *which clock stamps the event, and where*. Getting this wrong invalidates everything downstream, and interviewers test it because it separates people who have measured from people who have read.

**The hierarchy, worst to best:**

| Method | Resolution | Accuracy vs wire | Includes |
|---|---|---|---|
| Application `clock_gettime` after read | ~20–30 ns | ±10s of µs | Everything: DMA, IRQ, softirq, scheduler, app loop |
| Kernel software timestamp (`SOF_TIMESTAMPING_SOFTWARE`) | ~100 ns | ±1–20 µs | DMA + IRQ/NAPI + softirq scheduling |
| NIC hardware timestamp (`RAW_HARDWARE` / PHC) | 1–10 ns | ±50–500 ns (PHC sync) | PHY/MAC ingress only |
| External tap + capture appliance | ~1 ns | ±5–20 ns | Nothing (true wire time) |
| FPGA inline stamp at the SFP | sub-ns | ±few ns | Nothing |

**Key principle: a timestamp measures the instant the *stamping stage* saw the packet, so the difference between two timestamps only measures the stages between them.** An application timestamp minus a hardware timestamp is a legitimate and extremely useful measurement — it is exactly your *host stack latency*. But an application timestamp minus another application timestamp on a different host measures host stack on both ends plus the network plus the clock offset, and blames it all on "the network."

```
wire_arrival ──► HW TS ──► [DMA+IRQ+softirq] ──► SW TS ──► [sched+loop] ──► APP TS
                 |◄──────────── stack latency ─────────────►|
                                 |◄─ delivery jitter ─►|
```

**Decision rules:**

- Measuring *your own* stack: HW RX timestamp vs application timestamp on the same host. Requires translating PHC→host clock, or (better) reading the TSC and PHC together once to establish an offset and slope (Ch. 43 §43.13).
- Measuring *wire-to-wire* (tick-to-trade): tap both the inbound feed and your outbound order on a single capture device with one clock (§48.10). This removes clock sync error entirely — the strongest measurement you can make.
- Measuring *exchange-to-you*: needs synchronized clocks at both ends, which you rarely have; you almost always measure round trips instead.
- Never mix domains without explicit conversion. Symptom of mixing: negative latencies, or a latency distribution with a constant offset that changes after a `phc2sys` restart.

**The `SOF_TIMESTAMPING_SOFTWARE` subtlety.** The kernel software timestamp is taken in `netif_receive_skb` — i.e. in NAPI softirq context, *after* the interrupt has been serviced. Under interrupt coalescing (Ch. 46 §46.6) with `rx-usecs=50`, that stamp can be up to 50 µs late and, worse, the *lateness is inversely correlated with load* (busy = coalescing fires early on packet-count threshold; idle = full timer expiry). The result is the notorious inverted latency profile where the system appears faster under load. If your software-timestamped latency drops when traffic increases, coalescing is your answer.

**TX timestamping is a different beast.** `SOF_TIMESTAMPING_TX_HARDWARE` stamps when the frame leaves the MAC, delivered later via `MSG_ERRQUEUE`. Comparing your application's pre-`send` timestamp to the TX HW stamp gives you *transmit stack latency* — the number that Nagle, qdisc, and TSO all live in (Ch. 38 §38.13, Ch. 46 §46.10). Many teams instrument RX exhaustively and never instrument TX, then wonder where microseconds go.

---

## 48.10 One-Way Versus Round-Trip Latency

**Round-trip time (RTT)** is measured with one clock: send at t0, receive the response at t1, RTT = t1 − t0. **One-way delay (OWD)** is measured with two clocks: sent at t0 by clock A, received at t1 by clock B, OWD = t1 − t0 — and is therefore contaminated by the offset between A and B.

| | Round-trip | One-way |
|---|---|---|
| Clocks needed | One | Two, synchronized |
| Error source | Only measurement overhead | Clock offset (§48.11) adds directly |
| Path asymmetry | Hidden (averaged) | Exposed (this is the point) |
| Includes remote processing | Yes, inseparably | No |
| Easy to get right | Yes | No |

**RTT/2 is not one-way delay.** It is one-way delay only if the path is symmetric *and* remote turnaround time is zero. In practice neither holds: exchange gateways have asymmetric internal paths, market data egresses via a different path than order entry ingresses, and remote processing is exactly what you often want to isolate. Stating "RTT/2 assumes symmetry, and in a trading network the market-data path and the order path are physically different, so it's meaningless" is a strong answer.

**The measurement that actually matters: wire-to-wire tick-to-trade.** Tap the inbound market-data fibre and the outbound order fibre into the *same* capture device:

```
exchange feed ──► [L1 tap] ──┬──► your host/FPGA
                             └──► capture appliance  (clock C, timestamp T_in)
your order    ◄── [L1 tap] ──┬──◄ your host/FPGA
                             └──► capture appliance  (clock C, timestamp T_out)

tick_to_trade = T_out − T_in     ← single clock domain, no sync error
```

This is the industry-standard measurement and it is exact to the appliance's timestamp precision (~a few ns) because **both stamps come from one clock**. Everything else — including any measurement that involves your application's view of time — is inferior.

**Matching the tick to the trade** is the hard part, not the timestamping. You must correlate the specific inbound message that *caused* the outbound order. Techniques: embed a sequence identifier of the triggering message in the order's client order ID (Ch. 54 §54.6) so correlation is exact; or, when you cannot, correlate by nearest-preceding-event and accept ambiguity under bursts. Under a microburst, nearest-preceding correlation systematically *under*-reports latency, because a later tick sits closer to your (actually slow) response. This bias is invisible unless you look for it.

**One-way delay when you must have it.** Use PTP (§48.5) with hardware timestamping on both ends and report the clock error alongside the measurement: "OWD 4.2 µs ± 0.3 µs (clock)". A latency figure without an error bar from someone who used two clocks is not a measurement, it's a number.

**Practical guidance:** measure RTT for anything involving a remote peer you don't control; measure single-clock wire-to-wire for anything inside your rack; measure one-way with PTP only when you own both ends and have characterized the clock error.

---

## 48.11 Clock Synchronization Error

**Clock error** decomposes into three components you should be able to name separately:

- **Offset** — the instantaneous difference between two clocks. Directly adds to any one-way measurement.
- **Skew (frequency error / drift rate)** — the rate at which offset grows, in parts per million. A free-running crystal is typically ±20–100 ppm: 50 ppm is 50 µs per second, 180 ms per hour. An OCXO is ~0.01 ppm; a rubidium standard ~0.001 ppm.
- **Jitter / wander** — short-term random variation in the offset, which sets the noise floor of your measurement.

**Why this dominates one-way measurements.** If your PTP servo holds ±200 ns and you are measuring a 500 ns link, your error bar is 40% of the measurement. Worse, offset is not random noise — it is *slowly varying and correlated*, so averaging many samples does not reduce it. Averaging reduces jitter; it does nothing for a systematic offset. Candidates frequently claim "we take a million samples so the error averages out" — this is wrong for exactly this reason, and saying so is a strong signal.

**Sources of PTP error, ranked:**

1. **Path asymmetry** (§48.5) — the un-measurable one. Contributes exactly Δ/2 and no amount of statistics detects it. Different fibre lengths in each direction of a "pair" is a real and common cause; 1 metre of fibre is ~5 ns.
2. **Non-PTP-aware switches** — queueing delay enters as asymmetric noise under load.
3. **Servo transients** — after a step correction or a link flap, the PLL takes seconds to reconverge.
4. **PHC↔system-clock translation** — `phc2sys` adds its own error; if you compare a PHC timestamp with a `CLOCK_REALTIME` timestamp you inherit it.
5. **Timestamping point** — MAC vs PHY, and PHY latency asymmetry.

**Validating your time infrastructure** (the answer to "how do you know your clocks are right?"):

- Two independent grandmasters from different GNSS receivers; compare their disciplined outputs. Divergence is the honest error estimate.
- A **loopback sanity test**: send a packet out one port and directly back into another on the *same* card, capturing both with the same PHC. The measured "network" delay should equal the cable's propagation delay (~5 ns/m) plus PHY latency. Anything else is your measurement error, exposed with no clock sync involved.
- Monitor `ptp4l` master offset and path delay time series continuously. Path delay should be constant to within a few ns; a step change means a topology or fibre change, and every one-way number recorded before it is now differently biased.

**Leap seconds and time bases** (Ch. 35 §35.10): PTP runs on **TAI**; UTC differs by the current leap-second count, carried in the PTP announce message's `currentUtcOffset`. A host that takes the offset from a misconfigured grandmaster is off by exactly 37 seconds — a beautifully unmistakable signature. Never use `CLOCK_REALTIME` for latency deltas; it can step backwards. Use `CLOCK_MONOTONIC`, `CLOCK_MONOTONIC_RAW`, or the TSC (Ch. 35 §35.2–§35.3, Ch. 43 §43.12).

---

## 48.12 Packet-Loss and Jitter Measurement

**Loss** is a packet that was sent and not received. **Jitter** is variation in delay. Both are meaningless without a defined observation point and a defined interval.

**Measuring loss correctly.** Never infer loss from application-level symptoms alone. Layer your accounting:

```
Exchange sequence numbers   → gaps = loss anywhere upstream of your app (Ch. 37 §37.4)
NIC counters (ethtool -S)   → rx_missed_errors, rx_no_buffer_count = NIC ring overflow (§48.13)
Kernel counters             → /proc/net/snmp UdpInErrors, netstat -su "receive buffer errors"
Socket counters             → SO_RXQ_OVFL gives per-socket drop count in ancillary data
Capture counters            → pcap_stats ps_drop / ps_ifdrop (§48.8)
```

Each layer localizes the loss. Sequence gaps with clean NIC and kernel counters means the loss happened before your NIC — the network or the source. Sequence gaps *with* `rx_no_buffer` means you dropped it yourself. Presenting this as a decision tree is the expected answer to "how do you debug a market-data gap?"

**`SO_RXQ_OVFL`** deserves a specific mention: enable it and every `recvmsg` carries a cumulative drop counter as ancillary data, letting you attribute drops to a specific socket and, by differencing, to a specific point in the message stream:

```cpp
int on = 1;
setsockopt(fd, SOL_SOCKET, SO_RXQ_OVFL, &on, sizeof on);
// then read cmsg SOL_SOCKET / SO_RXQ_OVFL as a uint32 counter
```

**Jitter definitions — do not conflate them:**

| Metric | Definition | Use |
|---|---|---|
| **RFC 3550 interarrival jitter** | Smoothed mean deviation of the transit-time difference between consecutive packets | RTP/streaming; heavily smoothed, hides tails |
| **IPDV** (RFC 3393) | Delay difference between *consecutive* packets: D(i) − D(i−1) | Detects bursts and gaps |
| **PDV** | Delay minus the minimum observed delay | The one that matters for queueing analysis |
| **Percentile spread** | p99.9 − p50, or the full histogram | What you actually report (Ch. 43 §43.2) |

For low-latency work, **report a histogram, not a jitter scalar.** The minimum observed delay is your structural floor (propagation + serialization + fixed processing); everything above it is queueing and contention. `p99.9 − min` is a far more actionable number than "jitter = 3 µs".

**Coordinated omission** (Ch. 43 §43.3) applies here too: if your measurement loop stalls, it doesn't sample during the stall, so the worst latencies are never recorded. In network measurement the equivalent is a capture that drops packets during microbursts — you lose exactly the samples that would show the problem. Always cross-check capture drop counters before believing a clean tail.

**Microburst detection** (Ch. 39 §39.5) needs sub-millisecond bins. A link averaging 2 Gbps over 1 second can be at 10 Gbps for 20 ms; a 1-second average shows 20% utilization and a full output buffer. Bin your capture at 10–100 µs and compute per-bin bit rate — a 1 ms bin already hides most of the problem.

---

## 48.13 NIC Ring Sizing

A **descriptor ring** is a circular array in host memory of descriptors, each pointing to a buffer (Ch. 46 §46.3). On receive, the NIC DMAs an arriving frame into the buffer named by the next descriptor the driver has posted, then advances a producer index; the driver consumes and re-posts descriptors. If the NIC finds no free descriptor, the packet is dropped **in the NIC** and counted as `rx_missed_errors` / `rx_no_buffer_count`.

```
 driver posts here                       NIC fills here
        ↓                                     ↓
 [ D ][ D ][ D ][ F ][ F ][ F ][ D ][ D ][ D ][ D ]   D=driver-owned(free), F=filled
        ^tail (driver)                 ^head (NIC)
 free descriptors = ring_size - in_flight ;  zero free ⇒ drop
```

**Sizing arithmetic.** The ring must absorb the largest burst that can arrive during the longest time the host fails to replenish it:

```
required_entries ≈ peak_pps × max_service_gap
e.g. 1.5 Mpps × 200 µs (a scheduling hiccup) = 300 entries
     14.88 Mpps (10G, 64B) × 200 µs          = 2976 entries
```

Common ring sizes are 512–4096 (`ethtool -g eth0` shows current and maximum; `ethtool -G eth0 rx 4096` sets it).

**The tradeoff — and why "bigger is better" is wrong:**

| Larger ring | Smaller ring |
|---|---|
| Absorbs longer bursts and scheduling stalls | Less absorption; drops sooner |
| More descriptors and buffers resident → larger cache/TLB footprint, worse DDIO hit rate (Ch. 29 §29.24) | Working set fits in LLC; better cache behavior |
| **Bufferbloat**: a packet at the back of a full ring waits behind everything ahead of it | Bounded queueing delay |
| Hides the symptom of a too-slow consumer | Exposes it |

That third row is the mature point. For a market-data feed, a packet that has been sitting in the ring for 500 µs is *stale* — acting on it may be worse than dropping it. A large ring converts loss into latency, and for trading, latency of stale data is not a win. Deep rings make sense for bulk throughput; shallow rings plus a consumer that never stalls make sense for latency. The right answer to "how big should the ring be?" is: *big enough to cover your worst consumer stall, and no bigger — then eliminate the stalls.*

**Related knobs and their interactions:**

- **Interrupt coalescing** (`ethtool -c`, Ch. 46 §46.6): coalescing lengthens the service gap, so it forces a larger ring. Low-latency configurations set `rx-usecs 0 rx-frames 1` (or busy-poll, Ch. 45 §45.8) and can then afford a smaller ring.
- **RSS queue count** (Ch. 46 §46.12): rings are per-queue, so total buffering is `queues × ring_size`. A single-queue latency-pinned setup has far less absorption than the default multi-queue configuration — a common regression when someone "simplifies" the NIC config.
- **Kernel-bypass rings** (Ch. 47 §47.13): with ef_vi/DPDK you own the refill loop directly, and the ring is the *only* buffer — there is no socket receive queue behind it. A single blocking operation in your poll loop drops packets immediately. This is why bypass loops must be strictly allocation-free and syscall-free (Ch. 55 §55.6–§55.7).

**Diagnostic signature.** `rx_missed_errors` rising with `rx_errors` at zero means the NIC received the frames fine and had nowhere to put them — a host-side problem (ring too small, consumer too slow, or IRQ affinity landing on a busy core, Ch. 35 §35.16). `rx_crc_errors` or `rx_length_errors` rising means a physical-layer problem — check optics, fibre, and the switch port's counters.

---

## 48.14 Packets-Per-Second Limits

Throughput limits in packet processing are almost always **packet-rate** bound, not bit-rate bound, and knowing the arithmetic cold is a standard interview probe.

**Wire arithmetic** (Ch. 36 §36.4). Every Ethernet frame carries 8 bytes preamble/SFD, 12 bytes interframe gap, and 4 bytes FCS beyond the payload:

```
on-wire bytes = payload_and_headers + 4 (FCS) + 8 (preamble) + 12 (IFG)
minimum frame = 64 bytes (incl. FCS) + 20 = 84 bytes = 672 bits

10 GbE max pps = 10e9 / 672  = 14,880,952 pps   → 67.2 ns per packet
25 GbE                        = 37.2 Mpps        → 26.9 ns
100 GbE                       = 148.8 Mpps       → 6.7 ns
1500B frame @10G              = 812,743 pps      → 1.23 µs
```

**67 nanoseconds per packet.** At 3 GHz that is roughly 200 cycles for *everything*: DMA, descriptor handling, parse, dispatch. A single LLC miss is ~80 ns — you cannot afford one per packet at line rate with small frames. This single number explains DPDK's entire design (batching, prefetching, huge pages, no syscalls) and is the answer to "why can't the Linux stack do line rate with 64-byte packets on one core?"

**Where the limits actually bind:**

| Limit | Typical ceiling | Signature when hit |
|---|---|---|
| NIC ASIC pps | Often < line rate for small frames (e.g. 20–60 Mpps on a 100G card) | Drops at the NIC with no host load |
| PCIe transactions | Each packet costs descriptor read + data write + completion; PCIe Gen3 x8 ≈ 63 Gbps usable, and small packets waste TLP overhead | `rx_missed` under small-frame load only |
| Per-core packet rate | Kernel stack ~1–2 Mpps/core; DPDK 10–30 Mpps/core | 100% softirq CPU, `ksoftirqd` runnable |
| Interrupt rate | ~200k–1M IRQ/s before the CPU is consumed by entry/exit | High `%irq`, latency rising with load |
| Multicast group / flow-steering table size | Hundreds to thousands of entries | Groups silently fall back to host filtering (Ch. 37 §37.8) |

**Frame size dominates everything.** A NIC that does 100 Gbps with 1500-byte frames may manage only 30 Gbps with 128-byte frames, because the bottleneck is transactions, not bytes. Market data is *small-packet* traffic — ITCH messages are tens of bytes — so trading networks live in the worst region of the curve. Anyone benchmarking with `iperf`'s default large TCP segments is measuring the wrong thing entirely.

**Batching** is the standard mitigation and the standard tradeoff (Ch. 52 §52.13): processing 32 packets per poll amortizes the per-batch cost across 32 packets, raising throughput dramatically while adding up to a batch-time of latency to the first packet in the batch. Under low load, batching should collapse to batch-size-1 naturally — which is exactly what a busy-poll loop does, and why busy polling is both the lowest-latency and (at low rates) not the highest-throughput design.

---

## 48.15 Offered Load and Goodput

Four terms that get muddled, defined precisely:

- **Offered load** — the rate at which traffic is *presented* to the system, whether or not it can be handled.
- **Throughput / carried load** — the rate actually delivered, in bits or packets per second.
- **Goodput** — the rate of *useful application payload* delivered, excluding headers, retransmissions, duplicates, and padding.
- **Capacity** — the maximum sustainable throughput.

```
offered load
     │
     ├──► accepted ──► delivered ──► useful payload = GOODPUT
     ├──► dropped (ring, queue, switch buffer)
     └──► duplicated / retransmitted (counted in throughput, not goodput)
```

**Goodput arithmetic** (Ch. 36 §36.4). A 40-byte ITCH-style message inside UDP/IPv4/Ethernet:

```
payload 40 + UDP 8 + IP 20 + Eth 14 + FCS 4 = 86  (below 64-byte minimum? no, 86 > 64)
on-wire = 86 + 8 preamble + 12 IFG = 106 bytes
goodput efficiency = 40 / 106 = 37.7%
```

So a 10 Gbps link carrying single-message datagrams delivers under 4 Gbps of application data. **Message aggregation** — packing many messages into one datagram, which every real exchange feed does — moves this dramatically: ten 40-byte messages in one datagram gives 400/466 = 86%. This is why "our feed is 2 Gbps" tells you nothing about message rate without knowing the packing.

**The throughput–latency curve** (Ch. 52 §52.14) is the concept behind the whole section:

```
latency
  │                                        ╱  ← knee: queues start filling
  │                                      ╱
  │                                    ╱
  │─────────────────────────────────╱          ← flat region: latency ≈ structural floor
  └──────────────────────────────────────────► offered load
                                   ~70-80% of capacity
```

Latency is flat and near the structural minimum until utilization approaches capacity, then rises hyperbolically (the M/M/1 intuition: mean queue delay ∝ ρ/(1−ρ)). Two operational conclusions: (1) **run well below the knee** — a link at 80% average utilization has a terrible tail; (2) **the average is the wrong statistic**, because microbursts (Ch. 39 §39.5) put you past the knee for milliseconds at a time even when the one-second average is 20%.

**Measuring correctly:**

- **Report offered load and goodput together.** "We handle 5 Mpps" is incomplete without the loss rate at that offered load. A system that "handles" 5 Mpps while dropping 3% is handling 4.85.
- **Test past the knee deliberately** to find where the system degrades and *how* — gracefully (queueing, then drops) or catastrophically (livelock, where the machine spends 100% of its time in interrupt handling and delivers nothing; Ch. 24 §24.18). Receive livelock's signature is throughput that *decreases* as offered load increases.
- **Load generators must not be the bottleneck.** `pktgen`, DPDK `pktgen`, TRex, or a hardware generator (Ixia/Spirent). A software generator that can't sustain the target rate silently under-offers, and you conclude your receiver is fine.
- **Coordinated omission again** (Ch. 43 §43.3): an open-loop generator (fixed rate regardless of responses) exposes queueing; a closed-loop generator (send next after response) throttles itself and hides it. For latency-under-load testing, open-loop is mandatory.

**Overload policy is a design decision, not an accident** (Ch. 52 §52.16). When offered load exceeds capacity you will drop something; choosing *what* — oldest-first, newest-first, by priority, by symbol — is far better than letting a ring overflow arbitrarily. For market data, dropping the *oldest* queued message is often correct because stale prices have no value; for order entry, dropping newest and rejecting explicitly is correct because silent loss of an order is unacceptable.

---

## Key Interview Questions

1. **Why is an FPGA fundamentally faster than optimized C++ on a bypass stack?** — Cut-through processing begins before the frame fully arrives, there is no instruction fetch/decode or cache hierarchy, and the pipeline is cycle-deterministic; cost is a tiny logic budget and hours-long builds.
2. **What is a pre-staged (canned) order and why is it the dominant FPGA order-entry design?** — The CPU builds the full message, checksum and all, and arms an FPGA slot; the FPGA only evaluates a comparator and streams fixed bytes, so all complexity stays off the critical path.
3. **Are SmartNIC cores faster than host cores?** — Almost never for SoC/DPU designs; their value is offloading non-critical infrastructure, filtering, replication, and timestamping, not accelerating hot-path logic.
4. **Where exactly is a NIC hardware timestamp taken, and what does it exclude?** — At the MAC/PHY into the PHC domain; it excludes DMA, interrupt, softirq, and application scheduling — which is precisely why HW-minus-app is your stack latency.
5. **Why can't you compare a hardware timestamp to `clock_gettime(CLOCK_REALTIME)` directly?** — They are different clock domains (PHC vs system clock); you must translate, and the translation carries `phc2sys` error.
6. **Boundary clock vs transparent clock?** — BC terminates PTP and re-masters (servo error compounds per hop); TC forwards while adding measured residence time to `correctionField`, which is why trading networks use TCs.
7. **What single assumption does PTP's offset formula depend on?** — Path symmetry; asymmetry Δ produces exactly Δ/2 of unremovable error, invisible to any amount of averaging.
8. **Why doesn't averaging a million samples fix clock error?** — Averaging reduces jitter, not offset; offset is systematic and slowly varying.
9. **Why does `tcpdump` show an 8 KB TCP segment that can't exist on the wire?** — GRO/LRO coalesced it before the `AF_PACKET` tap; disable offloads or capture externally.
10. **Why does `tcpdump` show nothing for a kernel-bypass application?** — Onload/DPDK/ef_vi take the packet before the kernel stack; use the stack's own capture tool or an external tap.
11. **RTT/2 as one-way delay — what's wrong?** — Assumes path symmetry and zero remote turnaround; in trading, market data and order entry traverse physically different paths.
12. **What is the gold-standard tick-to-trade measurement?** — Tap inbound feed and outbound order into one capture device so both timestamps share a clock, eliminating sync error entirely.
13. **How do you correlate the triggering tick with the resulting order?** — Embed the triggering message's sequence identifier in the client order ID; nearest-preceding correlation under-reports latency during bursts.
14. **How would you localize a market-data gap?** — Layered counters: exchange sequence numbers, `ethtool -S rx_missed/rx_no_buffer`, `/proc/net/snmp` UDP errors, `SO_RXQ_OVFL`, and capture `ps_drop`/`ps_ifdrop`.
15. **Why is a bigger RX ring not always better?** — It converts loss into latency; a packet delayed 500 µs behind a full ring is stale data, and a deep ring hides a slow consumer while worsening cache/DDIO footprint.
16. **How many packets per second is 10 GbE, and why does the number matter?** — 14.88 Mpps at 64 bytes, i.e. 67 ns or ~200 cycles per packet — less than one LLC miss, which dictates batching, prefetching, and no syscalls.
17. **Why can a 100 G NIC deliver only 30 Gbps of small frames?** — The bottleneck is packet/PCIe transaction rate, not bits; small frames waste PCIe TLP overhead and exhaust the ASIC's pps budget.
18. **Difference between throughput and goodput, with numbers?** — Goodput excludes headers, IFG, retransmits and duplicates; a 40-byte message per datagram is only ~38% efficient on the wire, versus ~86% when ten are packed together.
19. **Why report a latency histogram instead of a jitter number?** — Minimum delay is the structural floor and everything above it is queueing; a smoothed jitter scalar hides exactly the tail that matters.

---

## Common Traps

- **Believing a host `tcpdump` shows the wire** — GRO/LRO/TSO fabricate segments; kernel bypass is invisible entirely.
- **Ignoring `packets dropped by kernel`** in capture output — drops correlate with microbursts, so the capture is blind precisely where it matters.
- **Mixing PHC and system-clock timestamps** — symptom is negative latencies or a constant offset that changes on `phc2sys` restart.
- **Reporting one-way delay without a clock error bar** — the number is unverifiable and often smaller than the error.
- **Treating RTT/2 as one-way delay** on an asymmetric path.
- **Assuming more samples cancel clock offset** — they cancel jitter only.
- **Using `CLOCK_REALTIME` for latency deltas** — it steps; use `CLOCK_MONOTONIC`/TSC.
- **Forgetting to drain `MSG_ERRQUEUE`** for TX timestamps — TX stamps silently stop.
- **Software timestamps under interrupt coalescing** — produces the inverted profile where the system looks faster under load.
- **Sizing the RX ring for the burst instead of fixing the consumer stall** — trades drops for stale data.
- **Forgetting rings are per-queue** — reducing RSS queues silently reduces total absorption.
- **Benchmarking with large frames** — hides the pps limit that actually binds on market data.
- **Closed-loop load generators** for latency-under-load — they self-throttle and hide queueing (coordinated omission).
- **A load generator that is itself the bottleneck** — you measure the generator, not the system.
- **Assuming line rate means line rate at any frame size** — NIC ASIC and PCIe transaction limits bind first.
- **FPGA firing on duplicate A/B feed packets** — double orders separated by the feed skew; dedupe by sequence number, not time window.
- **Non-atomic FPGA slot updates** — a fire racing an update sends a hybrid order; publish the arm word last with a generation counter.
- **Assuming pre-trade risk is covered because the CPU checks it** — if the CPU isn't on the path, neither are its checks.
- **10GBASE-T copper on a latency path** — ~2 µs of PHY latency, versus ~300 ns for SR fibre.
- **Quoting mean utilization** — microbursts put you past the knee while the one-second average looks idle.

---

## Compact Recall Summary

**FPGA.** Reconfigurable logic, no instruction fetch, cut-through parsing that starts before the frame ends: 20–100 ns wire-to-wire versus 1–5 µs for bypass CPU and 10–50 µs for kernel sockets — and a near-spike latency distribution, which is often worth more than the mean. Costs: tiny logic budget, hours-long place-and-route, fixed-point only, hard debugging.

**FPGA order entry.** The production pattern is the **pre-staged trigger**: the CPU builds the full message with precomputed checksum and sequence number and arms a slot; the FPGA evaluates one comparator and streams bytes. Publish payload before the arm word, use a generation counter so a late disarm can't resurrect an old arm, put pre-trade risk and the kill switch in the fabric, and dedupe A/B feeds by sequence number or you double-fire.

**SmartNICs.** FPGA / ASIC-pipeline (P4) / SoC-DPU. DPU cores are *slower* than host cores — offload infrastructure, filtering, replication and capture beside the path, never hot-path logic. An in-line DPU adds a 1–3 µs store-and-forward hop.

**Timestamping.** HW (PHC domain, ns resolution, excludes everything downstream) > kernel SW (NAPI/softirq, µs error, inverted under coalescing) > application. TX stamps return via `MSG_ERRQUEUE` — drain it. HW-minus-app is your stack latency; that decomposition is the whole point of having multiple stamp points.

**PTP.** Four-timestamp exchange; offset = ((t2−t1)−(t4−t3))/2 assuming **path symmetry**. Transparent clocks (add residence time) beat boundary clocks (compound servo error). Grandmaster on GNSS with OCXO/rubidium holdover; `ptp4l`/`phc2sys`/`ts2phc`. Error = offset (systematic, unaveraged away) + skew (ppm) + jitter. MiFID II's 100 µs is compliance time, not measurement time. PTP runs on TAI; a bad `currentUtcOffset` shows as exactly 37 s.

**Capture.** libpcap over `AF_PACKET` + BPF + `PACKET_MMAP`; select `ADAPTER_UNSYNCED` for the tightest relative deltas. Check `ps_drop` (ring) and `ps_ifdrop` (NIC) before believing anything. Host captures see post-offload traffic and never see kernel bypass — use an L1 tap (~5 ns fanout) into a capture appliance.

**One-way vs round-trip.** RTT needs one clock and hides asymmetry; OWD needs two and inherits their offset. The gold standard is single-clock wire-to-wire tick-to-trade via taps on both fibres, with the trigger's sequence ID embedded in the client order ID for exact correlation.

**Loss and jitter.** Localize loss with layered counters (exchange sequence → NIC → kernel → socket `SO_RXQ_OVFL` → capture). Report histograms: min is the structural floor, p99.9−min is the queueing. Bin at 10–100 µs to see microbursts.

**Rings and rates.** `required ≈ peak_pps × max_service_gap`; bigger rings convert loss into *stale data* and hide slow consumers. 10 GbE at 64 B = 14.88 Mpps = 67 ns = ~200 cycles per packet, less than one LLC miss — hence batching, prefetch, no syscalls. Small frames bind on pps and PCIe transactions, not bits.

**Load.** Offered ≠ carried ≠ goodput; a lone 40-byte message on the wire is ~38% efficient, ten packed are ~86%. Latency is flat until ~70–80% of capacity then hyperbolic, so run below the knee, measure with open-loop generators, and choose your overload policy deliberately — drop oldest for market data, reject explicitly for orders.
