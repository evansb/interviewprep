# Chapter 29 — Memory and NUMA

## Why this matters

Below the last-level cache, a memory request enters a distributed system. Physical-address bits select controllers, channels, ranks, banks, rows, and columns. Controllers queue and reorder requests. On a NUMA machine, the request may cross an on-package or inter-socket fabric before reaching its home memory. A device can add a PCIe path, DMA translation, and another coherence boundary.

Three consequences matter in low-latency systems:

1. “Memory latency” is not one constant. It depends on row state, queueing, contention, coherence ownership, and topology.
2. Placement is part of the program’s effective data layout. A correct buffer on the wrong NUMA node consumes interconnect bandwidth on every miss.
3. A local average can hide a remote or contended tail. Placement must be verified from the running process and measured under representative load.

This chapter follows one request from DRAM organization through NUMA placement, then explains remote coherence and device effects. Chapter 28 owns cache structure and coherence protocols; Chapter 32 owns address translation, faults, and huge pages; Chapters 31 and 35 own affinity and deployment recipes. Chapter 30 is the calibrated latency reference.

---

## 90-second screen — Core

- A DRAM access may be a **row hit**, require **activation**, or require **precharge plus activation**. Which case occurs depends on the controller’s address mapping and recent traffic.
- Bandwidth and latency are different limits. Controller queueing raises latency as offered load approaches the sustainable service rate.
- Memory-level parallelism hides latency only when requests are independent. A pointer chain exposes approximately one miss latency per step.
- On Linux’s default local NUMA policy, a newly faulted anonymous page is normally allocated near the CPU that faults it, subject to policy, cpusets, and available memory. Allocation and physical placement are separate events.
- A remote access may use remote DRAM, a remote cache, or a cache-to-cache ownership transfer. “The page is remote” does not identify the entire path.
- Thread, memory, and device locality must be planned together. A NIC-local thread reading buffers placed on another node still pays the fabric crossing.

Be ready to defend two decisions:

1. Should a region be partitioned, replicated, bound, preferred, or interleaved?
2. Which measurements prove that the intended threads, pages, traffic, and devices are actually local?

---

## 29.1 Keep guarantees, policies, and measurements separate — Core

Memory discussions become unreliable when four kinds of claim are mixed:

| Claim type | Example | Where authority comes from |
|---|---|---|
| Standard C++ guarantee | A data race has undefined behavior | ISO C++ rules; Chapter 25 |
| ISA guarantee | Required ordering of x86 locked operations | Architecture manual |
| OS policy | Linux local allocation and `mbind` behavior | Kernel documentation and configuration |
| Implementation observation | Address hashing, queue policy, forwarding restrictions | Vendor documentation or measurement |
| Workload measurement | Local/remote latency distribution on one host | Reproducible experiment |

This chapter labels platform-specific commands and behavior. Do not convert a measured x86 server result into a C++ guarantee, or a Linux default into a NUMA law.

Use costs symbolically until the target is measured:

```text
serialized miss time       ~= misses × service latency
one-core miss bandwidth    <= MLP × bytes per completed miss / latency
remote request time        ~= local path + fabric traversals + remote service + queueing
controller response time   ~= device service time + waiting time
```

These are models, not promises of additivity. Requests overlap, paths share resources, prefetch changes the request stream, and coherence may source a line from a cache instead of DRAM. Their value is diagnostic: they name the variable a change is meant to improve.

---

## 29.2 DRAM cells, rows, banks, and address selection — Core

A DRAM cell stores charge in a capacitor selected by a transistor. Reading disturbs that charge, so the device senses and restores an entire row. Cells also leak and must be refreshed. Software does not issue row commands directly; the memory controller turns physical-address requests into device commands.

The useful hierarchy is:

```text
CPU request
  -> memory controller
     -> channel
        -> DIMM
           -> rank
              -> bank group / bank
                 -> row buffer
                    -> column burst
```

| Component | Role in the path |
|---|---|
| Controller | Maps addresses, queues requests, schedules commands, manages timing and refresh |
| Channel | Independent data/command interface contributing bandwidth |
| Rank | Group of DRAM devices responding together |
| Bank | Array that can overlap work with other banks, subject to device timing rules |
| Row buffer | Sense-amplifier state holding the activated row for that bank |
| Column | Portion transferred from the active row |

Exact channel counts, row sizes, bank-group rules, burst lengths, and timings are part- and configuration-specific. Read the platform’s memory population guide before assuming that installed DIMMs provide the intended channel bandwidth.

### Population changes the available parallelism

A processor can expose several controllers and channels while a particular machine populates only some of them. Capacity may look correct even though bandwidth and bank/rank parallelism are lower than the processor’s maximum. Conversely, adding ranks can expose more independent banks but can also change electrical loading and the supported transfer rate. The net result is a platform configuration question.

ECC adds redundant information so the memory subsystem can detect and, for supported error patterns, correct corruption. Its capacity and transfer overhead are part of the memory-interface design rather than an extra C++ load. Reliability events can still affect service through retry, logging, page retirement, or machine-check handling. Treat corrected-error counts as an operational signal; do not infer an application latency penalty without a correlated measurement.

When investigating an unexpectedly low streaming ceiling, check in this order:

1. firmware-reported channel/DIMM population;
2. negotiated memory speed and rank layout;
3. whether the workload reaches all controllers or is restricted to one NUMA node;
4. read/write mix and useful-byte ratio;
5. controller and fabric counters under the measured run.

This prevents an algorithm rewrite intended to recover bandwidth that the physical DIMM layout never supplied.

### Row-buffer states

For one bank:

```text
closed --activate row R--> R open --column read/write--> R remains open
R open --precharge-------> closed
R open --different row---> precharge -> activate new row
```

This produces three useful cases:

| Case | Prior bank state | Required device work |
|---|---|---|
| Row hit | Requested row already active | Column command and transfer |
| Closed/empty bank | No row active | Activate, then column command |
| Row conflict | Different row active | Precharge, activate, then column command |

“Sequential access gets row hits” is a tendency, not a guarantee. Cache-line requests may be interleaved across channels and banks; hardware prefetch can create more outstanding traffic; other cores can change the open row before the next request arrives. Controllers may use open-page, closed-page, or adaptive policies.

Refresh temporarily consumes device resources and can contribute jitter, but its schedule and granularity depend on the DRAM generation, density, temperature policy, and controller. Quote refresh timings only for a named memory configuration.

### Physical-address mapping is an implementation detail

A controller selects channel, rank, bank, row, and column from physical-address bits, often with XOR hashing. The mapping is designed to spread common streams, but it is not standardized by C++, the OS ABI, or the DRAM interface. It can change with processor generation, firmware settings, channel population, and memory-encryption modes.

Consequences:

- a virtual-address stride does not by itself reveal a bank stride because translation chooses physical pages;
- a power-of-two stride can conflict in a cache, TLB, bank mapping, or all three, but the cause must be measured;
- reverse-engineered address maps are platform observations, not portable algorithms.

Chapter 32 owns virtual-to-physical translation and page mapping. Here the durable rule is to test several access patterns and strides rather than infer the controller map from a diagram.

---

## 29.3 Memory controllers: bandwidth, latency, and queueing — Core

The controller is a scheduler for constrained parallel resources. It must respect DRAM timing rules while choosing among reads, writes, banks, ranks, channels, and refresh work.

Common implementation goals include:

- serve ready row hits to improve throughput;
- avoid starving older requests;
- batch writes to amortize bus-direction changes;
- spread requests across banks and channels;
- enforce thermal, reliability, and quality-of-service policy.

The exact algorithm is normally vendor-specific. A label such as “first-ready, first-come-first-served” is a model for reasoning, not proof of a particular server’s policy.

### Latency under offered load

Even if the device service time were fixed, response time would rise as requests queue:

```text
response time
    ^
    |                                  queueing dominates
    |                           ______/
    |                    ______/
    |___________________/
    +----------------------------------> offered bandwidth
                  sustainable service rate
```

There is no universal utilization percentage at which the curve bends. The knee depends on read/write mix, locality, request size, number of sources, channel population, controller policy, and what latency percentile is being observed.

This explains a common production failure: a batch process does not share the service’s objects, yet it consumes the same controllers and fabric. The service’s misses wait behind unrelated traffic. Cache partitioning cannot fix a saturated memory channel.

### A bandwidth/latency cost model

Let:

- `L` be measured average completion latency for the tested request stream;
- `M` be average independent misses in flight;
- `S` be useful bytes obtained per completed miss;
- `B_service` be the memory subsystem’s sustainable bandwidth for that mix.

Then:

```text
B_observed <= min(B_service, M × S / L)
```

The formula supplies two different diagnoses:

- If `M` is small and bandwidth is far below the platform’s measured service limit, the kernel is latency/dependency limited.
- If many requests are outstanding and aggregate bandwidth has flattened, reducing bytes or contention matters more than creating more parallel requests.

Use useful bytes for `S`, not automatically the cache-line size. A program can fetch a line and use one field, so traffic bandwidth and application bandwidth differ.

Do not use a vendor peak-data-rate calculation as `B_service`. Measure a sustainable value with the same read/write ratio, locality, NUMA placement, thread count, and transfer pattern.

### Design a loaded-controller experiment

An idle pointer chase measures one end of the response curve. To reveal queueing, run a latency-sensitive probe concurrently with a controlled bandwidth generator and sweep the generator’s load.

```text
probe: one randomized dependent chain on a fixed core/node
load:  configurable read/write streams on selected cores/nodes
record: probe distribution + load bandwidth + controller/fabric counters
```

The experiment must say whether the load uses the same controllers, remote controllers, or the inter-socket links. Increasing the number of loading threads is not a calibrated x-axis if frequency, placement, or achieved bandwidth changes unpredictably; report the achieved traffic rate.

Interpret shapes rather than one threshold:

- a smooth local-latency rise with local controller traffic suggests queueing at shared memory resources;
- an abrupt remote-only change can indicate a fabric or remote-controller boundary;
- periodic tails correlated with write traffic can suggest read/write scheduling phases, but that conclusion needs vendor events or a controlled read/write-ratio experiment;
- a flat probe while the load grows may mean the data remains cached, the load uses other controllers, or the generator is not achieving the assumed bandwidth.

Run long enough to observe the application’s relevant percentile, randomize trial order, and include an unloaded recovery run to detect thermal or frequency drift. Chapter 43 owns full benchmark methodology; these controls define the memory hypothesis.

---

## 29.4 Memory-level parallelism and load/store machinery — Core

Out-of-order cores can overlap independent cache misses. The hardware resources have vendor-specific names and capacities, but the roles are stable:

| Resource | What it tracks |
|---|---|
| Load queue/buffer | In-flight loads and ordering checks |
| Store queue/buffer | In-flight stores until ordering and ownership permit completion |
| Line-fill/miss-status entries | Outstanding cache-line fills |
| Reorder window | Instructions available for finding independent work |
| Memory-controller queues | Requests after they leave the core/cache hierarchy |

Chapter 27 owns pipeline sizing and execution detail. For this chapter, the question is whether an address can be issued before a preceding miss completes.

### Dependent versus independent streams

The complete C++23 example below illustrates dependency shape; it is not a timing harness:

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

std::uint32_t chase(std::span<const std::uint32_t> next,
                    std::uint32_t cursor, std::size_t steps) {
    while (steps-- != 0) cursor = next[cursor];
    return cursor;
}

std::array<std::uint32_t, 4>
chase_four(std::span<const std::uint32_t> next,
           std::array<std::uint32_t, 4> cursor, std::size_t steps) {
    while (steps-- != 0) {
        for (auto& c : cursor) c = next[c];
    }
    return cursor;
}

int main() {
    std::vector<std::uint32_t> next{1, 2, 3, 0, 5, 6, 7, 4};
    assert(chase(next, 0, 4) == 0);
    const auto result = chase_four(next, {0, 1, 4, 5}, 4);
    assert((result == std::array<std::uint32_t, 4>{0, 1, 4, 5}));
}
```

Within one cursor, the next address depends on the previous load. Four cursors create four independent chains that the processor may overlap. Whether the compiler and CPU actually sustain four misses depends on optimization, layout, cache state, and available tracking entries.

Other ways to expose parallelism include:

- scan contiguous data so hardware prefetch can work ahead;
- batch independent hash probes;
- use a structure-of-arrays layout so unused fields do not consume bandwidth;
- software-prefetch an indirect target far enough ahead, after verifying that the address is known and the prefetch does not evict useful data.

### Memory disambiguation

A younger load may execute before every older store address is fully known. The core predicts whether they alias and checks later. A wrong prediction causes replay or another recovery event. Some implementations use partial address information early, which can create false dependencies for addresses with matching page offsets.

This is a microarchitecture observation, not a C++ guarantee. Diagnose it with vendor-specific events or profiling metrics and an address-layout experiment. Do not prescribe a fixed padding offset across processors.

### Store-to-load forwarding

When a load reads bytes written by an older store still buffered on the same core, the core may forward the value without waiting for the store to reach L1. Favorable cases generally match address, size, and containment. Difficult cases include:

- a wide load assembled from multiple narrow stores;
- partial overlap rather than containment;
- a load or store crossing a cache-line boundary;
- mismatched alignment;
- memory types or instructions that do not participate in ordinary forwarding.

Exact forwarding rules vary by microarchitecture. Build the final value in registers and store it once when practical; otherwise measure the exact load/store widths and alignments. Forwarding is intra-core. A different core obtains data through coherence, not another core’s store buffer.

---

## 29.5 NUMA topology and the local/remote path — Core

In a cache-coherent NUMA system, CPUs share one address space but do not have uniform access to every memory controller. A NUMA node is an OS representation of CPUs, memory, and their relative locality; some nodes can be memory-only.

```text
Node 0                                           Node 1
+----------------------+      fabric       +----------------------+
| cores -- caches      |<----------------->|      caches -- cores |
|          |           |                   |           |          |
| memory controllers --+-- local DRAM      | local DRAM -- controllers
| PCIe root / device A |                   | device B / PCIe root |
+----------------------+                   +----------------------+
```

A miss from a core on node 0 can take several paths:

```text
local memory:
core -> local caches/directory -> local controller -> local DRAM

remote memory:
core -> local fabric endpoint -> inter-node fabric
     -> remote home/cache/controller -> return fabric path

cache-to-cache:
requester -> directory/home lookup -> owning cache
          -> data/ownership transfer -> requester
```

The physical page’s home node helps determine where memory is allocated and serviced, but cache coherence can source a line from another core. Therefore “remote DRAM latency” and “cross-node modified-line transfer” are distinct measurements.

### Distances are topology hints

On Linux, `numactl --hardware` reports nodes, CPUs, sizes, free memory, and a distance matrix. Firmware-provided distance values are relative costs, not nanoseconds. Virtual machines can expose synthetic topology, and firmware data can be incomplete.

Use the matrix to form a hypothesis, then measure:

- local and remote dependent-load latency;
- local and remote streaming bandwidth;
- cache-to-cache transfer between chosen core pairs;
- performance with the real application access mix.

Within one socket, chiplets, meshes, cache clusters, and sub-NUMA modes can also make distances non-uniform. Vendor names and firmware switches change; inspect the exact topology instead of assuming that “same socket” means one cost.

---

## 29.6 First touch, memory policy, and migration — Core

### OS policy — Linux

Under Linux’s default local allocation policy, a physical page is normally allocated from memory local to the CPU handling the allocation fault, subject to:

- the task or virtual-memory-area NUMA policy;
- cpuset/cgroup allowed-memory nodes;
- memory availability and fallback rules;
- mapping type and sharing;
- automatic NUMA balancing or explicit later migration.

This is the precise form of **first touch**. Reserving virtual address space does not necessarily allocate every physical page. Changing a memory policy normally affects future allocations; already faulted pages remain where they are unless a migration operation or balancing mechanism moves them.

Chapter 32 owns demand paging and fault mechanics. The NUMA consequence is that initialization chooses placement.

### The serial-initialization trap

```text
1. coordinator reserves a large anonymous region
2. coordinator writes every page while running on node 0
3. workers on nodes 0 and 1 process disjoint halves
4. node-1 workers repeatedly fetch their half across the fabric
```

Parallel first touch uses the same partition for initialization and steady-state processing. It works only if worker placement is already established and the mapping has not been populated earlier by value initialization, allocator behavior, prefaulting, or restoration from a file.

This intentionally incomplete C++ fragment shows the page-touch operation, not thread-affinity setup:

```cpp
#include <algorithm>
#include <cassert>
#include <cstddef>
#include <span>

void touch_partition(std::span<std::byte> region,
                     std::size_t page_size,
                     std::size_t worker,
                     std::size_t workers) {
    assert(page_size != 0 && workers != 0 && worker < workers);
    assert(region.size() % page_size == 0);
    const auto pages = region.size() / page_size;
    const auto base = pages / workers;
    const auto extra = pages % workers;
    const auto first = worker * base + std::min(worker, extra);
    const auto last = first + base + (worker < extra ? 1 : 0);
    for (auto page = first; page < last; ++page) {
        region[page * page_size] = std::byte{0};
    }
}
```

The assertions express the input preconditions; workers own disjoint balanced partitions. On Linux under the intended policy, each worker must already run on the node meant to own its pages. The function touches one byte per page; a production initialization must also establish the required object lifetimes and values.

### Placement policies are workload choices

| Policy | Benefit | Cost / failure mode |
|---|---|---|
| Partition by node | Local reads/writes and scalable bandwidth | Cross-partition work needs routing or remote access |
| Replicate read-mostly data | Local reads on every node | Memory footprint and update/version protocol |
| Bind to one node | Predictable locality | Allocation can fail or capacity can be constrained |
| Prefer one node | Locality with fallback | Some pages may silently be remote under pressure |
| Interleave pages | Aggregate bandwidth for uniform parallel scans | Every thread sees a mix of local and remote pages |
| Automatic migration/balancing | Adapts to changing access | Sampling, page movement, and translation/coherence disruption |

Interleave is not “NUMA optimization” in general. It is useful when many threads consume a shared streaming region and aggregate bandwidth matters more than per-thread local latency. It is harmful for a partition that could have remained local.

### Allocator and lifetime effects

An allocator can return a block whose pages were faulted or reused by another thread. Freeing and reallocating virtual storage does not guarantee physical relocation. Thread-local caches reduce allocator contention but do not alone establish NUMA ownership.

For a node-owned arena:

1. establish the worker’s CPU placement using the deployment mechanism owned by Chapter 31;
2. apply the intended memory policy;
3. reserve and touch the pages from that worker;
4. keep allocation, use, and reclamation within the node where possible;
5. verify the resulting pages, not merely the allocator’s configuration.

Shared and file-backed mappings have different policy rules. Consult the Linux memory-policy documentation for the exact mapping and kernel version rather than extending anonymous-memory first-touch claims to every mapping.

### Migration and automatic NUMA balancing

Page placement can change after first touch. Linux can migrate pages explicitly through memory-policy/migration interfaces, during memory-management operations, or through automatic NUMA balancing when enabled and applicable. Migration copies page contents, updates mappings and accounting, and coordinates translations and concurrent access. The resulting disturbance depends on page size, sharing, dirty state, access rate, kernel version, and topology.

Automatic balancing trades adaptation for work at times chosen by the kernel. It can help a long-running workload whose threads or access phases move. It can hurt a latency-sensitive workload that already has deliberate stable placement. Neither “always disable it” nor “let the kernel fix NUMA” is a complete policy.

Evaluate it with:

| Question | Evidence |
|---|---|
| Are pages initially misplaced? | Mapping-level placement immediately after initialization |
| Does the access owner remain stable? | Thread/node and phase trace |
| Are pages migrating? | Kernel NUMA-balancing/migration statistics and repeated location samples |
| Does locality improve? | Falling remote-access traffic after migration |
| What is the disruption? | Application tail distribution correlated with migration activity |
| Can placement be correct at startup instead? | Parallel-touch or explicit-policy comparison |

Explicit migration after applying a policy is also not free and can fail partially under constraints. Check the API’s result at page granularity where required, verify the final distribution, and define what the program does if the target node lacks capacity. Chapter 32 covers the translation and page-size consequences; this chapter treats migration as a placement transition with observable cost.

---

## 29.7 Worked placement experiment and diagnosis — Core

Consider a two-node service:

- a NIC is attached near node 1;
- a receive thread runs on node 1;
- a parser runs on node 1;
- a coordinator on node 0 creates and initializes the packet pool;
- latency worsens when traffic exceeds the caches.

The hypothesis is not “NUMA is slow.” It is:

```text
the coordinator first-touched the pool on node 0,
so node-1 receive/parser misses cross the fabric to node-0 memory
and compete for fabric/controller capacity under load
```

### Build a controlled matrix

Hold code, frequency policy, page size, data set, and access pattern constant. Use the CPU-placement method from Chapter 31 and a Linux memory policy to construct:

| Worker node | Memory node | Expected path |
|---|---|---|
| 0 | 0 | local baseline |
| 0 | 1 | remote |
| 1 | 1 | local baseline |
| 1 | 0 | remote |

Measure at least two kernels:

1. a randomized dependent chain, which exposes service latency with little MLP;
2. a streaming or multi-stream kernel, which exposes sustainable bandwidth and controller/fabric saturation.

Run idle and with controlled local/remote background traffic. Report median and tail distributions, not one mean. Record the machine, firmware topology, memory population, kernel, compiler, page configuration, core pair, data size, and trial duration.

### Verify placement before trusting timing

Linux read-only inspection:

```bash
numactl --hardware
numactl --show
numastat -p "$PID"
cat "/proc/$PID/numa_maps"
cat /sys/class/net/eth0/device/numa_node
```

These commands answer different questions:

- `numactl --hardware`: firmware/kernel topology and relative distances;
- `numactl --show`: policy and allowed sets for the inspecting process;
- `numastat -p`: per-process page distribution summary;
- `/proc/PID/numa_maps`: mapping-level policy and placement detail;
- device `numa_node`: kernel-reported locality for that PCIe device, where known.

Tool availability and fields vary by Linux distribution and kernel. A device may report `-1` when locality is unknown; that is not node 1.

### Distinguish competing explanations

| Observation | More consistent with | Next check |
|---|---|---|
| Pages mostly on node 0; worker on node 1 | Placement error | Repeat after parallel first touch |
| Placement local, remote HITM/cache transfers high | Shared-line ownership traffic | `perf c2c` or vendor coherence counters |
| Local and remote both worsen under background stream | Controller/fabric queueing | Per-socket memory bandwidth and loaded-latency curve |
| Dependent chain slow, stream bandwidth healthy | Latency/MLP limit | Batch or restructure independent probes |
| Stream plateaus, dependent chain unchanged | Bandwidth limit | Reduce bytes or add local channels/nodes |
| Placement changes during run | Migration/balancing or workload movement | Page-location samples over time |

`perf mem`, `perf c2c`, and uncore events are hardware- and kernel-dependent. Unsupported sampling, skid, and event semantics must be documented. For Intel systems, Intel Memory Latency Checker can produce idle matrices and loaded-latency experiments; it is a vendor tool, not a portable truth source.

### Decide and verify the fix

For this scenario, the likely fix is to have the node-1 owner first-touch its pool after placement is established. Confirmation requires:

- pages shift to node 1 in placement inspection;
- remote bandwidth and remote-access samples fall;
- the application’s latency distribution improves under the same offered load;
- node-1 memory capacity and bandwidth remain within headroom.

If pages are already local but ownership traffic remains, first touch is not the fix. Partition or replicate the hot shared data, or change the communication protocol. A successful placement experiment can falsify the original hypothesis; that is useful.

---

## 29.8 Remote coherence, read-for-ownership, and sharing — Core

NUMA affects more than DRAM misses. Cache coherence tracks which caches hold a line and which core may modify it. Chapter 28 owns the protocol states; this section follows their topology cost.

### Reads

A read miss can be satisfied by:

- a local cache or last-level slice;
- local memory;
- a remote cache holding a clean or dirty copy;
- remote memory;
- a home/directory lookup followed by another hop.

The order of these costs is not universal. A remote cache response can beat or lose to local DRAM depending on topology, cache state, congestion, and implementation. Measure named paths rather than memorize one ladder.

### Writes and ownership

Before modifying an ordinary write-back line, a core obtains exclusive ownership. A read-for-ownership request can require invalidating other sharers or transferring a dirty line from its current owner.

```text
Core A owns line X modified
        |
        | Core B wants to write X
        v
home/directory locates A
        |
        +---- request / snoop across fabric ----> A
        <---- data + ownership / acknowledgments
Core B may now modify X
```

If A and B alternate writes, the line repeatedly crosses the fabric. The payload can be one counter byte; coherence moves at line granularity. This is true sharing when both modify the same logical value and false sharing when they modify independent fields on the same line.

Remote write contention consumes:

- interconnect bandwidth;
- directory/snoop resources;
- invalidation acknowledgments;
- store-buffer time while ownership is pending;
- retry work for contended atomic read-modify-write operations.

Padding fixes false sharing but not a globally shared counter. For true sharing, shard updates by node/core, batch them, or assign one owner and send messages.

### Home placement and current ownership are different

It helps to track two notions:

- the **home/placement** associated with the physical memory and directory/controller route;
- the **current coherence owner or sharers** of the cache line.

A page can be allocated on node 0 while a core on node 1 holds one of its lines modified. A third core’s request may consult the home information and obtain data from that owner. Moving the page does not automatically eliminate a protocol in which writers continue to alternate across nodes.

Use three experiments to separate the effects:

1. read a cold page locally and remotely to characterize memory placement;
2. have one core write, then another read, to characterize transfer of a modified line;
3. alternate atomic or ordinary ownership between cores to characterize repeated ping-pong.

Keep payload, core pair, cache state, and synchronization protocol explicit. The second and third experiments are coherence tests, not DRAM tests, even if the backing page is remote. This distinction prevents a common diagnostic error: applying page migration to a shared-line ownership problem.

### Placement patterns

| Data behavior | Preferred starting point |
|---|---|
| Read-only after startup | One shared copy if cache capacity/path is adequate; otherwise per-node replica |
| Read-mostly, versioned updates | Per-node immutable copies with explicit publication |
| Partitionable mutable state | Owner-computes partition with node-local storage |
| One global mutable scalar | Question the design; shard/aggregate if semantics allow |
| Producer-consumer stream across nodes | Place queue/control fields deliberately; measure handoff and payload paths |

Replication trades remote reads for memory and update complexity. It is most attractive when updates are rare and readers tolerate an explicit version transition. Replicating mutable state without a reconciliation rule replaces a performance problem with a correctness problem.

---

## 29.9 Hardware ordering at the useful level — Role-specific

Correct concurrent C++ is specified by the C++ abstract machine, not by direct reliance on a processor’s memory model. Use atomics and memory orders from Chapter 25. Hardware ordering explains cost and helps review generated code; it does not excuse a data race.

### Architecture — x86-64 TSO

A useful x86 write-back-memory model is:

- ordinary loads are not reordered with older ordinary loads;
- ordinary stores become globally visible in store order;
- a later load to another address can complete before an older store becomes globally visible;
- a core can forward its own buffered store to a matching later load;
- locked operations and fences have ordering defined by the architecture manuals.

The store buffer explains how store-to-load reordering can be observed, but it is not the architectural definition and not the “only reason” x86 differs from sequential consistency. Cacheability type, non-temporal instructions, locked operations, and serializing instructions have separate architectural rules.

Do not state that every locked instruction has one fixed cost or that every acquire/release operation is “free” on x86. Compiler mapping, operand state, contention, memory type, and microarchitecture determine emitted instructions and measured cost. The architectural ordering guarantee is the stable fact.

### Weakly ordered architectures

AArch64 and POWER permit more observations than x86 TSO, but not an undifferentiated “anything can reorder.” Their architecture manuals specify dependencies, acquire/release instructions, barriers, shareability domains, and memory types. The compiler maps C++ atomics to a sequence valid for the selected target and options.

Review rules:

- missing C++ synchronization is a source-level bug even if an x86 test passes;
- an explicit CPU barrier intrinsic is not a substitute for a C++ happens-before edge;
- device memory uses platform-specific ordering rules distinct from normal cacheable memory;
- generated-code comparisons must name compiler, flags, ISA level, and target.

This chapter stops at the hardware consequence. Chapter 25 owns the language proof, and Chapter 26 applies it to lock-free structures.

---

## 29.10 Split accesses and write combining — Role-specific

### Split-line and split-page accesses

An access spanning two cache lines can require two cache lookups and two line fills. An access spanning pages can require translation work for both pages. Whether an unaligned access contained within one line has a penalty depends on ISA and microarchitecture.

For atomic operations, the situation is stricter:

- `std::atomic<T>` and `std::atomic_ref<T>` have alignment and representation requirements;
- violating `atomic_ref`’s required alignment is a program error;
- whether a supported aligned atomic is lock-free is implementation-defined and queryable;
- x86 has special, costly handling for some locked accesses crossing cache-line boundaries, while other ISAs may reject misaligned atomic accesses.

Do not create atomics inside packed wire layouts. Decode into properly aligned native storage. A `static_assert` should check the exact type’s documented requirement, such as `std::atomic_ref<T>::required_alignment`, rather than assume alignment equals size.

### Write combining

Write-combining buffers merge adjacent writes before sending them onward. They are relevant to:

- non-temporal/streaming stores to normal memory;
- mappings with a write-combining memory type;
- some device doorbell or framebuffer paths.

Benefits require a streaming, write-only pattern large enough to avoid useful cache allocation. Costs include weak ordering, finite combining-buffer capacity, partial-line traffic, and poor read behavior. Exact flush and fence requirements depend on ISA, memory type, device, driver, and transport.

Therefore a generic C++ snippet containing `_mm_sfence()` and an MMIO pointer is not a portable device-publication recipe. Follow the device/driver API and architecture manual. Chapter 47 owns the complete descriptor/doorbell protocol.

---

## 29.11 Thread, memory, NIC, and DMA locality — Role-specific

A packet-processing path has several placements:

```text
NIC PCIe attachment
   -> DMA target pages
      -> interrupt or polling core
         -> packet-processing thread
            -> downstream queue/state
```

Aligning only the thread is insufficient. A local CPU can read a remote DMA buffer, update a remote queue, or contend on a line owned by another socket.

The placement objective is:

```text
minimize fabric crossings on the dominant path
while preserving capacity, failover, and workload balance
```

That may mean NIC-local receive queues and pools, then an explicit cross-node handoff to node-owned strategy state. It does not always mean putting the whole process on the NIC’s node; that node may lack enough cores or memory bandwidth.

### PCIe and DMA

DMA lets a device read or write host memory without a CPU copying each byte. The device uses addresses established by the OS/driver mapping API. PCIe topology determines which root complex and NUMA node are near the device.

**I/O coherence is a platform contract.** Many server platforms provide coherent DMA to ordinary host memory, but the exact scope and required cache maintenance depend on architecture, interconnect, firmware, device, and mapping API. Do not teach “x86 coherent, ARM non-coherent” as a universal split. Drivers use the platform DMA API precisely because it abstracts these differences.

CPU/device ordering is also distinct from CPU/CPU ordering. Publishing descriptors, ringing a doorbell, and consuming completions must follow the driver/framework’s barriers and ownership protocol. C++ atomics alone do not define MMIO semantics.

### IOMMU

An IOMMU translates device-visible I/O virtual addresses and enforces access permissions. Its translation cache is commonly called an IOTLB. Costs can arise from:

- IOTLB misses and page-table walks;
- mapping/unmapping work;
- invalidation and synchronization;
- limited translation reach for many small pages.

Long-lived mappings can amortize control-path work, but they do not make translation or invalidation universally free. Security/isolation policy determines whether bypass or identity-like modes are permitted. Chapter 47 owns framework-specific mapping setup.

### Device inspection — Linux

Read-only topology checks:

```bash
cat /sys/class/net/eth0/device/numa_node
lspci -tv
lstopo
```

Interrupt routing, queue steering, polling-core placement, and service isolation belong to Chapters 31, 35, 46, and 47. This chapter supplies the memory-path hypothesis those procedures should validate.

---

## 29.12 CPU interconnects, DDIO, and memory tiers — Reference

This section is skippable. Product names help interpret platform manuals, but they are not portable abstractions.

### CPU fabrics

Intel UPI, AMD Infinity Fabric, and Arm coherent mesh/interconnect products connect sockets, dies, caches, controllers, and I/O agents in different configurations. Hop count, link width/speed, routing, snoop mode, and congestion affect remote paths. Treat each system’s topology as data.

Useful measurements include:

- link utilization by direction;
- local versus remote controller traffic;
- cache-to-cache transfers by core pair;
- retries or congestion indicators where documented;
- latency/bandwidth matrices under idle and loaded conditions.

Event names and attribution are vendor- and generation-specific. Uncore counters often describe a socket or fabric, not one process.

### Intel DDIO

Intel Data Direct I/O on supported server platforms can place some PCIe device writes into the last-level cache rather than requiring an immediate DRAM round trip. Scope, allocation, configurability, and observability vary by processor generation and firmware.

Potential benefit:

```text
NIC DMA write -> LLC-resident line -> local polling core reads line
```

Potential failure:

```text
DMA working set exceeds effective cache allocation
-> useful application lines displaced or packet lines evicted before use
```

Verify that the processor and device path support the feature, identify the relevant cache/fabric domain, and compare counters plus application latency while varying ring/pool size. Do not assume a fixed number of ways or that every device write is injected identically.

### CXL and memory-only nodes

CXL revisions define several coherent device and memory capabilities over a PCIe-based physical/link foundation. A CXL memory device may be exposed by the OS as a memory tier or memory-only NUMA node, depending on platform firmware, kernel support, provisioning, and mode.

Do not classify all CXL memory as one latency tier. Device technology, switch topology, link generation/width, interleaving, and host controller matter. Name the CXL version and platform, then measure latency, bandwidth, failure behavior, and migration policy. Keep latency-critical allocations off a slower tier only after placement controls and verification demonstrate that the policy works.

---

## 29.13 Operational measurement checklist — Reference

Use the smallest tool that answers each question:

| Question | Linux/platform evidence |
|---|---|
| What nodes, CPUs, and relative distances exist? | `numactl --hardware`, `lscpu`, `lstopo` |
| What policy constrains this process? | `numactl --show`, cpuset/cgroup configuration |
| Where are this process’s pages? | `numastat -p PID`, `/proc/PID/numa_maps` |
| Which node is reported for the NIC? | `/sys/class/net/DEV/device/numa_node` |
| Are cache lines moving between cores/sockets? | `perf c2c` or documented vendor events |
| Are sampled loads local or remote? | `perf mem` where supported |
| Are controllers or links saturated? | Vendor uncore memory/fabric counters |
| What is the local/remote response curve under load? | Controlled benchmark; vendor tools where applicable |

Record:

- CPU and firmware model/configuration;
- DIMM population and speed;
- kernel, NUMA policy, cpuset, and balancing state;
- CPU and memory node used by each trial;
- mapping/page configuration;
- access pattern, data size, read/write mix, and MLP;
- background load and socket placement;
- repetitions and percentile method.

Do not compare “local” from one machine with “remote” from another and attribute the difference solely to NUMA. The experiment must reverse placement on the same host or otherwise control platform differences.

Rollback matters. Binding can cause allocation failure under pressure; replication consumes capacity; interleaving can worsen latency; disabling migration can preserve a placement bug. Each change needs a capacity check, failure policy, monitoring signal, and reversible deployment step.

---

## Recall card — Core

- DRAM work is organized by controllers, channels, ranks, banks, rows, and columns.
- Row hit, closed-bank access, and row conflict require different command sequences.
- Controller queueing makes response time load-dependent; there is no universal saturation knee.
- `B <= min(B_service, MLP × useful_bytes / latency)` separates service-bandwidth and dependency limits.
- Load/store forwarding and disambiguation rules are microarchitecture-specific observations.
- NUMA locality is a path involving core, cache/home, fabric, controller, memory, and sometimes a device.
- On Linux default local policy, the CPU faulting a new anonymous page normally influences its node; policy and allowed-node constraints qualify first touch.
- Partition mutable state, replicate suitable read-mostly state, and interleave only when aggregate bandwidth justifies mixed locality.
- Remote coherence ownership can dominate even when page placement is correct.
- I/O coherence, MMIO ordering, IOMMU behavior, DDIO, and CXL require platform/version labels.

---

## Common traps — Core

- Quoting one DRAM or remote-memory latency as a machine-independent constant.
- Treating advertised memory data rate as sustainable application bandwidth.
- Omitting useful-byte ratio from the MLP bandwidth model.
- Assuming a virtual-address stride uniquely selects a DRAM bank.
- Initializing every page on one coordinator before node-partitioned processing.
- Applying a new memory policy and assuming existing pages moved.
- Assuming thread-local allocator caches imply NUMA-local physical pages.
- Using interleave as a default fix for latency-sensitive partitioned state.
- Calling every remote access “remote DRAM” when a cache may supply the line.
- Padding a truly shared counter and expecting ownership traffic to disappear.
- Calling the store buffer the architectural definition of x86 TSO.
- Treating ordinary C++ atomics as an MMIO or DMA-ordering API.
- Assuming DMA coherence from the CPU architecture name alone.
- Reading firmware NUMA distance values as nanoseconds.
- Running a placement benchmark without first verifying the pages.

---

## Reasoning questions

1. Trace a row hit and a row conflict from controller command to data transfer. Which extra work distinguishes them?
2. A streaming kernel reaches high bandwidth while a pointer chain does not. Use the MLP model to explain why.
3. Why can an unrelated process increase memory latency without sharing any virtual or physical pages with the service?
4. A region was bound to node 1 after initialization but remains mostly on node 0. Give two mechanisms that explain the observation.
5. When is interleaving preferable to first-touch partitioning, and what latency property does it give up?
6. A node-local process still reports cross-socket cache-to-cache transfers. What data-layout or ownership problems would you investigate?
7. Why does a generation-specific store-forwarding rule belong in a measurement note rather than a portable optimization rule?
8. What evidence distinguishes remote DRAM traffic, remote cache ownership transfer, and controller saturation?
9. A NIC is local to node 1, but packet processing on node 1 still crosses the fabric. List three placement causes.
10. What must be labeled before making a claim about DDIO, CXL memory, or IOMMU cost?

---

## Code-reading puzzle

The workers are correctly placed before `process`, and each consumes a disjoint half. This intentionally incomplete fragment omits application types and thread-launch machinery:

```cpp
std::vector<Record> records(count); // construction occurs on coordinator
start_worker_on_node(0, [&] { process(records.first_half()); });
start_worker_on_node(1, [&] { process(records.second_half()); });
```

Assume Linux default local policy and that `Record` value initialization writes the backing pages. Explain why the code can be race-free and still create remote traffic. Does replacing `std::vector` with a raw allocator automatically fix it? Redesign initialization while preserving object lifetime and state which placement observation would confirm the fix.

---

## Implementation exercise

Build the four-cell placement matrix from Section 29.7 on a NUMA Linux host:

1. discover topology and select one core on each of two nodes;
2. create local and remote page placements without changing the access kernel;
3. implement a randomized dependent chain and four independent chains;
4. add a streaming read and a mixed read/write kernel;
5. verify page location before each timed trial;
6. repeat idle and with controlled bandwidth load;
7. report median, p99, sustainable bandwidth, and relevant remote/controller counters.

State all platform details and policy assumptions. Explain each result with row behavior, MLP, queueing, or fabric/coherence paths. If the machine has only one NUMA node, use two core clusters to measure cache-to-cache locality and explicitly label the experiment as non-NUMA rather than inventing a remote-memory result.

---

## Prerequisite for Chapter 30

Chapter 30 turns these mechanisms into calibrated orders of magnitude. Before continuing, be able to explain—without quoting a number—why a row conflict differs from a row hit, why a dependent chain cannot fill memory bandwidth, how first touch influences Linux page placement, and why a remote modified-line transfer is not the same experiment as remote DRAM.
