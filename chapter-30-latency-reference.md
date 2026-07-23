# Chapter 30 — Latency Reference

**Why this matters.** Latency folklore ages badly. “A cache miss costs 100 ns” may have been a useful estimate on one host, for one working set, at one load, using one statistic. It is not a property of C++, Linux, x86, Arm, or “modern hardware.” This chapter is the book’s home for reference values so that later chapters can cite one qualified source instead of repeating incompatible constants.

The durable skill is not memorizing a table. It is learning to classify a number, reconstruct an estimate, identify the critical path, predict where queueing begins, and replace the estimate with a measurement from the target system.

**90-second screen.**

Five facts:

1. Keep the scale straight: \(1\text{ s}=10^3\text{ ms}=10^6\text{ µs}=10^9\text{ ns}\). At a stated 3.2 GHz, one cycle is 0.3125 ns; at another frequency, recalculate.
2. A latency number needs a boundary, platform, workload, load, statistic, and provenance. “80 ns” alone is not evidence.
3. Latency, throughput, and bandwidth are different. Add serial critical-path stages; for genuinely overlapping work, follow the longest dependency.
4. Queueing can dominate service time near capacity. A low-load median neither predicts a loaded tail nor combines arithmetically with component percentiles.
5. The C++ standard specifies semantics, not nanoseconds. Architecture, OS, vendor, measured, derived, and illustrative values have different scopes.

Two decisions:

- Use a qualified reference range to reject an impossible claim or size an experiment, never as a production service-level objective.
- Make a design decision from an end-to-end measurement on a production-like target, then use component measurements to explain it.

---

## 30.1 A Number Is a Claim — Core

Attach one of these labels whenever a number enters a design document:

| Label | Kind of claim | What it can legitimately establish |
|---|---|---|
| **S — standard** | ISO C++ semantics or complexity | What a program may rely on; normally no wall-clock latency |
| **A — architecture** | ISA or architectural specification | Required behavior of an architecture; usually not a microarchitectural cost |
| **O — OS/interface** | Kernel or API contract and configuration | Boundaries, states, and guarantees; not a portable runtime |
| **V — vendor** | Published data for a named processor, NIC, switch, or drive | A part-specific figure under the vendor’s stated conditions |
| **M — measured** | A benchmark record with raw samples and metadata | What happened on that system, with that workload and statistic |
| **D — derived** | Arithmetic from stated inputs | What follows from the model, such as serialization or propagation |
| **I — illustrative** | A teaching assumption | How to calculate; never evidence about a target |

These labels do not rank truthfulness. A **V** value can be precise and useful. It simply cannot be silently promoted into an **A** guarantee or a universal constant. Likewise, a correct **M** result does not automatically transfer from one machine to the next.

Every usable latency claim answers six questions:

1. **Boundary:** from what event to what event? `send()` entry to return, application timestamp to application timestamp, first bit at ingress to first bit at egress, or durable media commit?
2. **Platform:** which processor stepping, sockets, memory, device, firmware, kernel, mitigations, and power settings?
3. **Workload:** what size, dependency pattern, working set, queue depth, contention, and locality?
4. **Load:** idle, steady-state utilization, or burst?
5. **Statistic:** minimum, median, mean, p99, p99.9, or maximum over a stated interval?
6. **Provenance:** **S**, **A**, **O**, **V**, **M**, **D**, or **I**?

A seventh question—*when?*—matters for changing firmware, kernels, compilers, and cloud hosts. Record the date.

### Units and conversions

Frequency in GHz is cycles per nanosecond:

\[
t_{\text{ns}}=\frac{\text{cycles}}{f_{\text{GHz}}}
\qquad
\text{cycles}=t_{\text{ns}} f_{\text{GHz}}
\]

Thus 160 cycles at a *stated* 3.2 GHz is 50 ns. This is a conversion, not a prediction: turbo, throttling, heterogeneous cores, and invariant timestamp counters can make “the frequency” ambiguous. Record the effective frequency during the run.

Rates require equal care:

\[
\text{operations/s}=\frac{1}{\text{seconds/operation}},\qquad
\text{bandwidth}=\text{operations/s}\times\text{bytes/operation}
\]

The inverse of single-operation latency is a throughput ceiling only when operations cannot overlap. Chapters 27–29 explain why modern cores overlap independent instructions and memory misses.

---

## 30.2 The Logarithmic Ladder — Core

The following is an **orientation sheet**, not a benchmark result. Its scope is commodity server-class systems commonly encountered in the first half of the 2020s. The bands are intentionally wide, mix x86-64 and Arm implementations, assume warmed steady-state execution unless stated, and are rounded to orders of magnitude. They help choose a measurement method and catch a missing unit. They must not be copied into a service-level objective.

| Approximate scale | Representative operation class | Conditions that can move it | Claim |
|---:|---|---|---|
| \(10^0\) ns | Simple dependent core operation or private-cache hit | instruction, core model, dependency, frequency | **I**, informed by named-part **V** manuals |
| \(10^1\) ns | Last-level-cache access or an ownership transfer with favorable topology | cache slice, hop count, coherence state, contention | **I** |
| \(10^2\) ns | Idle local DRAM access; a very small kernel crossing may also land on this scale | memory clocks, NUMA node, mitigations, timer boundary | **I** |
| \(10^3\) ns = 1 µs | Park/wake, minor fault, or host-network software path can begin on this scale | scheduler, kernel, device path, load | **I** |
| \(10^4\) ns = 10 µs | Fast storage or a longer host/network path can begin on this scale | device, queue depth, block size, interrupt policy | **I** |
| \(10^5\) ns = 100 µs | Many device completions and loaded software paths | firmware, queues, filesystem, coalescing | **I** |
| \(10^6\) ns = 1 ms and above | WAN paths, storage tails, scheduler delay, overload | distance, retry, reclaim, preemption, queueing | **I** |

This is a logarithmic ladder: each row is ten times the previous one. It deliberately avoids claims such as “L1 is exactly four cycles” or “a syscall is exactly 200 ns.” For instruction and cache details, consult the optimization manual for the *named* CPU and verify with a dependency-chain benchmark. For kernel, device, and network paths, measure the boundary the application actually cares about.

A compact picture is often more useful than another table:

```text
time ───────────────────────────────────────────────────────────────►
      core      cache/coherence     DRAM/kernel     device/network
      ns             10 ns            100 ns          µs … ms

      └──────── machine-local mechanisms ────────┘
                                      └──── queues, scheduling,
                                            firmware, and distance ────┘
```

The categories overlap. That is the point: mechanism and boundary classify a result better than a memorized decimal.

### First-pass planning bands

For interview estimation, the scale rows can be expanded into the following deliberately broad bands. This table is an editorial synthesis for experiment sizing, not a shared benchmark dataset. Its claim label is therefore **I**, even where named-part vendor manuals and reproducible measurements motivate the order of magnitude. Scope: server-class systems from roughly 2020–2025, warmed steady state, low offered load, bare metal, and favorable local placement unless the row says otherwise. A machine outside that scope—or a tail statistic—may fall outside a band.

| Operation class | First-pass band | Boundary and caveat | Claim |
|---|---:|---|---|
| Dependent simple integer operation | 1–a few cycles | result available to a dependent instruction; instruction and core specific | **I** |
| Private L1 data-cache load | roughly 3–6 cycles | aligned scalar dependent load, hot line; not store or scan throughput | **I** |
| Private or mid-level cache load | roughly 10–30 cycles | dependent load; cache organization varies substantially | **I** |
| Shared last-level-cache load | roughly 30–150 cycles | hit in shared cache; slice, hop, contention, and topology matter | **I** |
| Local DRAM load | roughly 60–200 ns | unloaded dependent pointer chase, local NUMA allocation, beyond LLC | **I** |
| Cache-line ownership transfer | roughly 30–300 ns | favorable same-host topology; coherence state and contention dominate | **I** |
| Uncontended user-space lock path | roughly 10–100 ns | lock already available; no park or kernel wait | **I** |
| Park-to-wake synchronization | roughly 1–30 µs | lightly loaded host; excludes an unbounded run-queue wait | **I** |
| Small real syscall | roughly 0.1–2 µs | actual kernel entry with little work; kernel and mitigations matter | **I** |
| Minor page fault | roughly 1–20 µs | resident backing, no storage I/O; allocator and kernel paths vary | **I** |
| Small host-network path | roughly 2–50 µs | low load; boundary may be NIC-to-application or application round trip | **I** |
| NVMe read at queue depth one | roughly 10–500 µs | small block, device completion; model, firmware, and thermal state matter | **I** |
| Durable small write | roughly 0.1 ms to many ms | requested persistence boundary; device/filesystem/cache policy dominate | **I** |

These bands are order-of-magnitude envelopes, not means or percentiles. Do not average the endpoints or quote the midpoint as “the latency.” Choose the row, tighten its boundary and platform assumptions, and then replace **I** with a dated **M** record. If a result lands outside the band, first check units and boundaries; then investigate rather than deleting the sample.

### Compute and memory

Instruction latency is the delay along a dependency chain. Reciprocal throughput is the rate for independent operations after the execution machinery is full. A vendor may publish both for a named microarchitecture; confusing them can produce a several-fold error.

Cache latency also needs a definition. A pointer chase makes each address depend on the preceding load, exposing load-to-use latency. An array scan lets prefetchers and memory-level parallelism overlap requests, so it measures throughput more than isolated latency. Neither benchmark is “the cache speed.”

Memory results additionally depend on:

- cache state and working-set size;
- access order and prefetching;
- page size and translation state;
- local versus remote NUMA placement;
- read/write mix and memory-controller utilization;
- the number of outstanding misses; and
- coherence ownership, including whether another core has modified the line.

An unloaded pointer chase and a saturated bandwidth test answer different questions. Keep both. Chapter 29 develops the topology and memory mechanisms.

### Synchronization and system calls

“Atomic latency” is not one value. A load from a line already present locally, a read-modify-write that must acquire ownership, and an operation fought over by many sockets exercise different paths. Similarly, an uncontended mutex may remain entirely in user space; a contended mutex may spin, enter the kernel, sleep, wait in a run queue, wake on another core, and reload cold state.

The C++ standard label **S** can tell us that an atomic operation has a particular ordering effect. It does not tell us how many cycles that effect costs. An x86 or Arm architecture label **A** constrains permitted behavior, but timing remains implementation-specific. Vendor guidance is **V**; the result from the target is **M**.

A syscall number also needs an OS boundary. A vDSO-assisted clock read may not enter the kernel at all. A ready-file `read`, a blocking socket `read`, and a storage-backed `read` share a spelling but not a path. Speculation mitigations, tracing, security modules, virtualization, and kernel configuration can all change the result.

### Storage

Separate at least three boundaries:

- **page-cache access:** data is already in memory;
- **device completion:** the device reports completion to the host;
- **durable completion:** the required persistence domain has committed the data.

Then state operation size, access pattern, queue depth, read/write mix, filesystem and mount options, device model, firmware, and cache/flush policy. Queue depth one exposes something like a request’s service path. A high queue depth may maximize throughput while increasing individual response time. A surprisingly fast durability result is a reason to inspect the persistence boundary, not a reason to celebrate.

---

## 30.3 Latency, Throughput, and the Critical Path — Core

Suppose a four-stage pipeline has an **illustrative** 100 ns service time at each stage. With no overlap, one item takes 400 ns and the maximum rate is 2.5 million items/s. If different stages can process different items concurrently, latency is still 400 ns, but after filling, the pipeline may complete one item every 100 ns: 10 million items/s. Throughput improved; the latency of an individual item did not.

For one request, draw dependencies:

```text
receive ──► decode ──► decide ──► encode ──► transmit
                         │
                         └──► asynchronous log
```

If the log is truly asynchronous and never creates backpressure, it is not on the request’s critical path. If the logging queue fills and the producer waits, it rejoins the path. “Asynchronous” is therefore a normal operating condition to verify, not a permanent property.

For serial stages,

\[
T_{\text{critical}}=\sum_i T_i
\]

For independent work that completely overlaps,

\[
T_{\text{critical}}=\max_i T_i
\]

Real systems lie between these extremes. DMA may overlap compute but still contend for memory bandwidth. Two nominally parallel branches may serialize on a lock or cache line. Use a trace to discover the dependency graph; do not infer it from thread count.

Bandwidth is rate times size. A path transferring 64-byte cache lines at 100 million lines/s carries 6.4 GB/s of payload. That says nothing by itself about whether an individual miss takes 10 ns or 200 ns; many requests may be in flight. Little’s Law supplies the connection.

---

## 30.4 Queueing, Load, and Tails — Core

For a stable system in steady state, Little’s Law is:

\[
L=\lambda W
\]

where \(L\) is the average number of requests in the system, \(\lambda\) is the average completion rate, and \(W\) is average time in the system. If a memory path completes 100 million requests/s and the average request spends 80 ns in flight, it needs eight requests in flight on average. Those inputs are **illustrative**; the relationship is general when its steady-state assumptions hold.

Utilization is

\[
\rho=\lambda S
\]

for arrival rate \(\lambda\) and mean service time \(S\) at one server. Capacity planning must leave \(\rho<1\), but merely being below one is not enough for low tails.

For an **illustrative M/M/1 model only**—Poisson arrivals, exponential service times, one server, unlimited queue—the mean response time is:

\[
W=\frac{S}{1-\rho}
\]

At \(\rho=0.5\), this model gives \(W=2S\); at 0.9, \(10S\); at 0.99, \(100S\). Those multipliers are consequences of this model, not predictions for a trading system, NIC, mutex, or SSD. Bursty arrivals, bounded queues, batching, correlated service times, priorities, and multiple servers change the distribution. The model’s lesson survives: waiting becomes nonlinear near saturation.

### Tails are not a lookup table

There is no universal rule that p50 “belongs to caches” while p99.9 “belongs to the kernel.” Any mechanism can dominate any percentile if it occurs often enough. Typical tail contributors include:

- cache and TLB misses;
- lock or cache-line contention;
- run-queue delay and preemption;
- interrupts, deferred work, and timer activity;
- allocator, page-fault, reclaim, migration, and writeback paths;
- device firmware, retries, and queueing;
- power-state and frequency transitions; and
- virtualization pauses or noisy neighbors.

Measure a histogram and preserve raw samples. State the observation interval because a maximum over ten seconds is not comparable with a maximum over ten days.

Component percentiles do not normally add:

\[
p99(A+B)\ne p99(A)+p99(B)
\]

The slow samples may be correlated, anticorrelated, or occur on different requests. Measure end to end, then use per-stage traces to attribute the result. Summing stage p99s can be a conservative planning exercise only if it is explicitly presented as such, not as the predicted end-to-end p99.

Open-loop load generation also matters. A benchmark that waits for each response before sending the next request stops creating work during a stall and can under-report the latency that scheduled arrivals would have experienced. Chapter 43 treats this coordinated-omission failure in depth.

---

## 30.5 Network Numbers You Can Derive — Core

Two network floors are arithmetic rather than folklore.

### Serialization

For \(B\) transmitted bytes on a link of \(R\) bits/s:

\[
T_{\text{serialization}}=\frac{8B}{R}
\]

An Ethernet example must state what \(B\) includes. A 64-byte MAC frame plus an 8-byte preamble/start delimiter spans 72 transmitted byte-times. The mandatory interpacket gap sends no bits, but reserves another 12 byte-times before the next frame; the complete transmission opportunity is therefore 84 byte-times for packet-rate calculations. These counts exclude physical-layer coding and forward-error-correction delay.

At a stated 10 Gb/s:

- the 72-byte-time minimum-frame span serializes in \(72\times8/10^{10}=57.6\) ns (**D**), while its 84-byte-time transmission opportunity consumes 67.2 ns;
- an untagged 1,518-byte MAC frame carrying a 1,500-byte payload spans 1,526 byte-times including preamble, or 1.2208 µs (**D**); including the following gap, its 1,538-byte-time transmission opportunity consumes 1.2304 µs.

A store-and-forward switch must receive the complete frame before forwarding it, so a frame-span term can recur at hops. Output-port spacing can add gap time as well. A cut-through switch may begin earlier, but it still has implementation delay and can queue at an output. Chapter 36 owns the Ethernet byte accounting, Chapter 38 develops transport queueing, and Chapter 39 owns switch forwarding and queueing.

### Propagation

The SI fixes vacuum light speed at exactly 299,792,458 m/s. A 1 km vacuum path therefore has a one-way propagation floor of about 3.336 µs (**D**). For an **illustrative** fibre refractive index of 1.468:

\[
T_{\text{fibre/km}}
=\frac{1000\times1.468}{299\,792\,458}
\approx4.897\text{ µs}
\]

The index is an assumption, not a value for every cable and wavelength. Real routes exceed map distance and add transceivers, repeaters, switches, coding, packetization, host processing, and queues. Round-trip time is not one-way time, and dividing by two is justified only when path and processing asymmetry are acceptable.

### Host and device paths

“Network latency” may mean any of these:

```text
application ─ kernel/bypass ─ driver ─ NIC ─ wire ─ switch ─ wire ─ NIC ─ application
     ▲                                                           ▲
 software timestamp                                      hardware timestamp
```

A vendor’s port-to-port switch result (**V**) cannot be compared directly with an application round trip (**M**). A producer-side enqueue duration excludes consumer observation. Interrupt coalescing, busy polling, batching, offloads, PCIe topology, IOMMU settings, NUMA locality, frame size, offered load, and timestamp position all need to be recorded. Chapter 48 develops the measurement boundary.

---

## 30.6 Worked Latency Budget — Core

Consider a feed handler. Every number in this example is **I**—an assumption for arithmetic, not a claim about a product.

**Boundary:** first inbound preamble bit enters a local 100 m fibre segment to the last outbound FCS bit leaving a second 100 m segment.

**Assumptions:**

- both links are 10 Gb/s;
- each isolated minimum frame spans 72 transmitted byte-times per direction; the following interpacket gap affects capacity but lies outside this first-bit-to-last-bit boundary;
- both fibre segments use the illustrative refractive index 1.468;
- receive processing takes 650 ns;
- decode, decision, and encode take 900, 700, and 500 dependent cycles;
- effective core frequency is fixed at 3.2 GHz for the conversion;
- transmit processing takes 550 ns; and
- initially there is no queueing and no overlap.

The derived pieces are:

\[
\begin{aligned}
T_{\text{serialization, one link}} &= 57.6\text{ ns}\\
T_{\text{propagation, 100 m}} &\approx489.7\text{ ns}\\
T_{\text{CPU}} &= (900+700+500)/3.2=656.25\text{ ns}
\end{aligned}
\]

The serial critical path is:

\[
\begin{aligned}
T_{\text{total}}
&=57.6+489.7+650+656.25+550+57.6+489.7\\
&\approx2,951\text{ ns}=2.95\text{ µs}
\end{aligned}
\]

This result is only as valid as the boundary and assumptions. If the published boundary is NIC ingress to NIC egress, both external propagation terms may disappear. If receive DMA overlaps inbound serialization, the sum is pessimistic. If a cache miss, interrupt, or queue occurs, it is optimistic. The right next step is a trace with matching timestamps, not an extra significant digit.

Now treat only the 656.25 ns CPU handler as one server. Its no-overlap service capacity is:

\[
\mu=1/S\approx1.524\text{ million requests/s}
\]

At an **illustrative** arrival rate of 500,000 requests/s, \(\rho=0.328125\). If—and only if—the M/M/1 assumptions were reasonable:

\[
W=\frac{656.25}{1-0.328125}\approx976.7\text{ ns}
\]

The model adds about 320 ns of mean queueing to the CPU stage, making the illustrative mean end-to-end budget about 3.27 µs. This is not a tail prediction. A bursty feed and variable service times require measured arrival and service distributions, a realistic load generator, and an explicit overflow policy.

The following C++23 calculator reproduces the unit conversions. It is deliberately not a benchmark:

```cpp
#include <cassert>
#include <iostream>

constexpr double cycles_to_ns(double cycles, double ghz) {
    return cycles / ghz;                 // GHz == cycles/ns
}

constexpr double serialization_ns(double wire_bytes, double gbps) {
    return wire_bytes * 8.0 / gbps;      // Gb/s == bits/ns
}

constexpr double propagation_ns(double metres, double refractive_index) {
    constexpr double c_m_per_s = 299'792'458.0;
    return metres * refractive_index / c_m_per_s * 1.0e9;
}

constexpr double mm1_response_ns(double service_ns,
                                 double arrivals_per_second) {
    const double rho = arrivals_per_second * service_ns / 1.0e9;
    return service_ns / (1.0 - rho);
}

int main() {
    constexpr double serial = serialization_ns(72.0, 10.0);
    constexpr double fibre = propagation_ns(100.0, 1.468);
    constexpr double cpu = cycles_to_ns(900.0 + 700.0 + 500.0, 3.2);
    constexpr double total =
        serial + fibre + 650.0 + cpu + 550.0 + serial + fibre;
    constexpr double cpu_response = mm1_response_ns(cpu, 500'000.0);

    static_assert(serial > 57.5 && serial < 57.7);
    static_assert(cpu > 656.2 && cpu < 656.3);
    static_assert(cpu_response > 976.6 && cpu_response < 976.8);
    assert(total > 2950.0 && total < 2952.0);
    std::cout << "serial critical path: " << total << " ns\n"
              << "M/M/1 CPU response: " << cpu_response << " ns\n";
}
```

The constants are visible so that nobody mistakes the output for discovery.

---

## 30.7 Replacing the Reference with Measurements — Core

A measurement is authoritative only for its recorded scope. Keep a machine-readable record beside the raw samples:

| Field | Minimum record |
|---|---|
| Claim and boundary | Exact start event, end event, units, direction, and clock domain |
| Hardware | CPU model/stepping, sockets and topology, memory, NIC/device model, firmware |
| Software | OS and kernel, mitigations, drivers, compiler and flags, executable revision |
| Placement | CPU affinity, NUMA allocation, IRQ placement, SMT sibling, device locality |
| Workload | Operation and message size, working set, access order, queue depth, contention |
| Environment | Power policy, effective frequency, virtualization, background workload |
| Sampling | Warm-up, duration, count, timer, timer overhead, load-generation model |
| Result | Histogram or raw samples plus p50/p90/p99/p99.9 as justified; never only a mean |
| Reproduction | Command/configuration, raw-data path and checksum, timestamp |

### Match the benchmark to the question

- To measure dependent instruction or cache latency, create a dependency chain. To measure throughput, use independent operations and enough iterations to reach steady state.
- To expose cache levels, sweep working-set size and defeat unintended prefetching. Verify with counters; do not assume a “random” access pattern succeeded.
- To measure memory under load, vary offered bandwidth and plot latency against load. An idle point does not locate the queueing knee.
- To measure synchronization, timestamp the full handoff through consumer observation. Report producer-only enqueue separately if it matters.
- To measure a syscall, distinguish a real kernel entry from a vDSO fast path and record mitigation state.
- To measure storage, use direct or buffered I/O intentionally, state queue depth and block size, and verify the durability contract independently.
- To measure networking, state application, NIC, or switch timestamp positions and whether the clock domains are synchronized.

On Linux, `perf stat` can collect hardware and software event counts, but event availability and meaning are CPU- and kernel-specific. A useful command shape is:

```sh
perf stat -r 30 -e cycles,instructions,cache-misses,branch-misses -- ./bench
```

Treat it as **O/V-dependent**, not as a universal command: first list available events, check multiplexing, and record the `perf` and kernel versions. Counters attribute a result; they do not replace timing.

Timer choice is part of the experiment. A language-level monotonic clock is appropriate for many end-to-end intervals but can overwhelm a tiny operation. An architectural counter needs correct ordering and a conversion; its rate need not equal instantaneous core frequency. Measure timer overhead, use a control experiment, inspect generated code, and prevent the optimizer from deleting the work. Chapter 35 covers clocks and ordering; Chapter 43 gives the full benchmarking protocol.

Finally, run two experiments:

1. a controlled test that isolates the mechanism; and
2. a production-like test with realistic load, placement, background activity, and duration.

The first explains. The second decides.

---

## 30.8 Reference Notes — Skippable

Use primary, part-specific documents rather than an unattributed latency chart:

- The [Intel 64 and IA-32 Architectures Optimization manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel64-and-ia32-architectures-optimization.html) publish optimization guidance and named-microarchitecture throughput/latency material. Treat those figures as **V**, then verify the exact processor.
- AMD publishes [processor-specific software optimization guides](https://docs.amd.com/r/en-US/57368-uProf-user-guide/Useful-URLs) for several processor families. Again, the label is **V**, not a cross-family guarantee.
- The [Linux kernel workload-tracing documentation](https://origin.kernel.org/doc/html/latest/admin-guide/workload-tracing.html) describes `perf stat` and `perf bench`. Tool and event behavior remain kernel- and processor-dependent (**O/V**).
- The [BIPM SI Brochure](https://www.bipm.org/documents/20126/41483022/SI-Brochure-9-EN.pdf/2d2b50bf-f2b4-9661-f402-5f9d66e4b507?t=1671101192839&version=1.11) defines \(c=299\,792\,458\text{ m/s}\) exactly. Propagation results in §30.5 are **D** from that constant and a stated medium assumption.

These links are source routes, not a frozen benchmark dataset. When this chapter is revised, update a measured table only from its raw record; do not “refresh” a number by copying a newer marketing page with a different boundary.

---

## 30.9 Traps, Puzzle, and Exercise — Core

### Common traps

- **Latency versus throughput:** using reciprocal throughput as dependent latency.
- **Cycles versus nanoseconds:** converting with nominal frequency while the core boosts, throttles, or uses an invariant counter.
- **Warm versus cold:** presenting the minimum of a warmed loop as a first-request prediction.
- **Local versus remote:** omitting NUMA, cache ownership, IRQ, or device placement.
- **One-way versus round trip:** halving an asymmetric RTT without evidence.
- **Enqueue versus handoff:** timing the producer call but claiming consumer-visible latency.
- **Service versus response:** omitting queueing and scheduler delay.
- **Completion versus durability:** treating a returned write as persisted data.
- **Median versus tail:** improving a hot path while introducing a rare slow path.
- **Component percentiles:** adding p99 values and naming the sum “end-to-end p99.”
- **Coordinated omission:** letting the load generator stop issuing during stalls.
- **False precision:** writing 83.7 ns when the platform and boundary justify only “order \(10^2\) ns.”

### Puzzle: the impossible queue

A report says:

> “Our SPSC queue handoff is 18 ns p99 on every server.”

The benchmark timestamps immediately before and after the producer’s `push`, pre-faults the ring, runs the producer and consumer unpinned, and discards all samples above 100 ns as “scheduler noise.”

Find at least six defects. A strong answer should identify the wrong boundary, explain why unpinned placement changes coherence and scheduling, reject the censored percentile, request platform and load metadata, distinguish producer progress from consumer observation, and challenge “every server.” Then design the smallest experiment that measures publication-to-observation with a sequence number and timestamps at both ends.

### Applied exercise

Create a latency sheet for one real target:

1. Choose one compute/cache operation, one memory operation, one handoff or syscall, one storage operation, and one network boundary.
2. Write an order-of-magnitude estimate before measuring. Label each input **V**, **D**, or **I**.
3. Complete every field in the measurement record in §30.7.
4. Measure an idle distribution and at least three offered-load points, one near the observed knee.
5. Plot latency percentiles against load. Keep raw samples.
6. Reconcile estimate and measurement. Identify whether each miss came from a wrong constant, wrong boundary, wrong dependency model, or omitted queue.

The objective is not five impressive numbers. It is five claims another engineer can reproduce.

---

## 30.10 Recall and Review — Core

**Recall card.**

- \(1\text{ µs}=1{,}000\text{ ns}\); at \(f\) GHz, cycles divided by \(f\) gives ns.
- Label claims: **S** standard, **A** architecture, **O** OS/interface, **V** vendor, **M** measured, **D** derived, **I** illustrative.
- Record boundary, platform, workload, load, statistic, provenance, and date.
- Latency is dependency time; throughput is completion rate; bandwidth is rate times bytes.
- Sum serial critical-path stages; take the longest only for work that truly overlaps.
- Little’s Law is \(L=\lambda W\). Queueing rises nonlinearly near capacity.
- Serialization is \(8B/R\). Propagation is distance divided by signal speed.
- Percentiles do not add in general. Measure end to end and trace components.
- A reference range sizes an experiment. A qualified target measurement makes the decision.

**Questions.**

1. Why can the C++ standard specify atomic correctness yet say nothing useful about an atomic operation’s nanoseconds?
2. What metadata is missing from the claim “DRAM takes 90 ns”?
3. A vendor lists instruction latency as four cycles and reciprocal throughput as 0.5 cycles. What does each number mean?
4. How can a pipeline improve throughput without improving per-item latency?
5. When should serial stage costs be summed, and when is taking the maximum defensible?
6. Derive both the 1,526-byte-time frame span and the 1,538-byte-time transmission opportunity at 25 Gb/s. Why are they different, and which PHY details remain outside both results?
7. Why is fibre propagation near 4.9 µs/km only a qualified estimate even though vacuum light speed is exact?
8. In the worked example, which assumptions would make the 2.95 µs sum pessimistic, and which omitted events would make it optimistic?
9. Why does an M/M/1 calculation teach a useful queueing lesson without predicting a production p99?
10. Design a benchmark that distinguishes producer-side enqueue time from consumer-visible handoff time.

**Prerequisite for Chapter 31.** Be able to separate a thread’s service time from its run-queue wait, and to explain why a microbenchmark on an idle pinned core does not predict wake-to-run latency on a loaded scheduler. Chapter 31 applies those distinctions to processes, threads, scheduling, affinity, preemption, and futexes.
