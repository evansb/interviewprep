# Chapter 28 — Caches

## Why this matters — Core

A short loop can be limited by where its data resides rather than by its arithmetic. Four mechanisms explain most cache-sensitive behavior: caches transfer blocks called lines, each line maps to a limited set of slots, coherent writers acquire ownership of a line, and speculative fetchers try to move predictable data before demand. These mechanisms let you predict which layout will reduce misses or ownership traffic. Chapter 30 contains measured latency ranges; this chapter derives behavior without repeating them.

## 90-second screen — Core

Five facts:

1. On common CPUs, a cache line is the allocation and transfer unit and usually the coherence granule. Its size is a target property, not a C++ constant.
2. In a conventional set-associative cache, an address selects a byte offset, a set, and a tag. Too many simultaneously live lines mapping to one set cause conflict misses even when total capacity is sufficient.
3. Normal cacheable memory commonly uses write-back, write-allocate caches. A store miss normally requests ownership and may fetch the existing line: the **read for ownership** (RFO) tax.
4. False sharing (independent variables in one line) is fixed by padding. True sharing (one variable) is not — it needs an algorithm change.
5. Hardware prefetchers readily learn sequential or simple strided streams. Dependent pointer chains expose the next address too late for ordinary stream prefetchers, though more capable prefetchers exist on some processors.

Two decisions:

- Given a hot structure, decide its layout: which fields travel together, what the access stride is, and how many lines one operation touches.
- Given a shared datum, decide whether to pad it, partition it per core, batch updates to it, or restructure so writes flow in one direction only.

Chapter 29 develops DRAM and NUMA; Chapter 30 supplies reproducible latency ranges; Chapter 32 covers translation, page walks, and huge pages; Chapter 42 turns these mechanisms into an optimization workflow.

---

## 28.1 Lines, Sets, and Address Decomposition — Core

A cache holds a subset of a larger memory, exploiting **temporal locality** (recent data is reused) and **spatial locality** (nearby data is used soon). For a conventional power-of-two, set-associative cache:

```
sets       = size / (line_size × ways)
index_bits = log2(sets)
```

An address decomposes accordingly:

```
 63                       index+offset bits             6           0
┌────────────────────────┬──────────────────────────┬──────────────────┐
│          TAG           │          INDEX           │   BLOCK OFFSET   │
└────────────────────────┴──────────────────────────┴──────────────────┘
                                                     └ 6 bits = 64 B line
```

The index selects a set, tags identify which memory blocks occupy its ways, and the offset selects a byte within the line. As a worked example, consider a hypothetical 32 KiB, 8-way L1 data cache with 64-byte lines:

```
sets   = 32768 / (64 × 8) = 64
offset = bits [5:0]
index  = bits [11:6]
tag    = bits [63:12]
```

This simple bit selection accurately models many L1 caches because their index lies within the page offset. Lower cache levels may use physical-address bits, hashing, slice selection, or undocumented indexing, so the same arithmetic is a starting hypothesis rather than a universal mapping formula.

### Locality means useful work per fill

Spatial locality is not "arrays are fast" as a rule; it is the fraction of each fetched line that the operation uses. With a target 64-byte line, scanning sixteen contiguous 32-bit quantities can use every transferred byte. Reading one 32-bit field from records spaced 64 bytes apart uses only one sixteenth of each line before eviction unless other fields are also consumed.

```cpp
#include <cstdint>
#include <vector>

struct Quote {
    std::int64_t price;
    std::int32_t quantity;
    std::uint32_t venue;
    std::int64_t timestamp;
};

std::vector<Quote> aos;             // array of structures
std::vector<std::int32_t> quantity; // one column of a structure-of-arrays
```

If every operation needs all four fields for one quote, `aos` packs related data and avoids coordinating several arrays. If an aggregation reads only quantities across thousands of quotes, the separate column transfers more useful quantities per line and gives the prefetcher one dense stream. Structure-of-arrays is therefore an access-pattern decision, not a universally superior layout.

Temporal locality is governed by **reuse distance**: the distinct cache footprint touched between two uses of the same line. A line reused after touching more competing data than the effective cache capacity may be evicted even when wall-clock time is short. Loop tiling improves temporal locality by finishing work on a small block before moving on:

```text
poor reuse:  touch one element in every row, then return much later
tiled reuse: finish a B×B region while its lines remain candidates for residency
```

Count three things for a proposed layout: lines touched per operation, useful bytes per fetched line, and reuse distance in lines. Those quantities explain the direction of the change before a benchmark supplies target-specific magnitude.

### Worked cache-set derivation

For this L1, index plus offset consumes 12 low address bits. Addresses separated by 4096 bytes therefore preserve both the line offset and set index. Nine such lines compete for eight ways:

```text
base + 0 × 4096  ┐
base + 1 × 4096  │ same index bits [11:6]
...              │ eight ways available
base + 8 × 4096  ┘ ninth live line requires a victim
```

A dependent cycle prevents memory-level parallelism from hiding the effect:

```cpp
#include <cstddef>
#include <span>

std::size_t chase(std::span<const std::size_t> next,
                  std::size_t index, std::size_t steps) {
    while (steps-- != 0) index = next[index];
    return index;
}
```

Build `next` so its cycle visits slots `0, 4096/sizeof(std::size_t), 2×4096/sizeof(std::size_t), ...`. Compare eight and nine slots over many rounds. Eight can reside in the set; nine exceeds associativity. Then change the stride to 4096+64: the addresses rotate through sets while total touched bytes remain the same. That control separates conflict pressure from capacity. A benchmark must consume the returned index, randomize trial order, and follow Chapter 43's timing rules.

The set capacity is `ways × line_size = 8 × 64 = 512` useful bytes for these congruent addresses, even though the whole cache holds 32 KiB. Padding a matrix leading dimension, tiling a traversal, or changing allocation offsets changes the index sequence; Chapter 42 covers how to choose and verify such transformations.

### Virtual indexing and fill behavior

Many L1 caches are virtually indexed and physically tagged (VIPT). When offset and index bits fit entirely inside the page offset, a set lookup can begin in parallel with address translation because those bits do not change during translation. For 4 KiB pages, the common design relation is:

```text
L1 capacity ≤ page size × associativity
```

This is a design pressure, not an architectural requirement. Processors can use extra alias handling, banking, way prediction, different page sizes, or other organizations. It is therefore safer to derive geometry from the target's documentation or system topology than to infer it from a product family.

A demand fill transfers a line, but some processors can return the requested **critical word** before the remaining beats arrive. Consequently, dependent-load latency and sustained line-fill bandwidth are different quantities. Chapter 30 measures the former; Chapter 29 develops the path beyond the cache hierarchy.

---

## 28.2 The Hierarchy and What a Miss Actually Costs — Core

Most server CPUs provide small private caches near each core and a larger shared or distributed last-level cache (LLC). Exact sharing domains, inclusivity, capacities, and lookup paths are implementation properties.

| Level | Common organization | Consequence |
|---|---|---|
| L1 data / instruction | Private to a core, shared by its SMT threads | Smallest capacity; nearest target for the active loop |
| L2 | Often private to a core or core cluster | A useful working-set residency target |
| LLC | Shared or distributed across cores/clusters | Hit cost and available capacity depend on placement and sharing domain |
| Beyond LLC | Coherent peer cache or memory hierarchy | An LLC miss does not by itself identify the responder |

Three structural facts matter more than the numbers:

**Inclusion changes eviction effects.** In an inclusive hierarchy, every private-cache line is represented in the inclusive level, so eviction there may require invalidating private copies. An exclusive or victim organization uses levels for mostly different lines, increasing aggregate data capacity at the cost of more movement on promotion. A non-inclusive cache promises neither containment relation. These terms describe policies, not performance rankings.

Coherence directories or snoop filters also have finite capacity. On designs where an entry is required to track private copies, directory pressure can cause probes or back-invalidations even when the data itself appeared resident. Whether this occurs, and which counter exposes it, is processor-specific.

**The responder matters.** A clean LLC hit, a cache-to-cache transfer from a peer, and a memory response follow different paths. Intel performance tools use **HITM** ("hit modified") for a load served from a peer's modified line. Do not equate an LLC miss with DRAM traffic without a data-source or offcore-response event. §28.3 covers the mechanism.

Where to look on Linux:

```bash
$ lscpu -C                       # sizes, ways, line size, sharing
$ cat /sys/devices/system/cpu/cpu0/cache/index0/{size,ways_of_associativity,coherency_line_size}
$ cat /sys/devices/system/cpu/cpu0/cache/index3/shared_cpu_list   # reported sharing domain
```

The index numbers are not portable; enumerate the `index*` directories and read each `level` and `type` file before interpreting them.

### From miss rate to exposed latency

For a single dependent access, a simplified average-access model is:

```text
L1 hit time
+ P(L1 miss) × additional L2 service time
+ P(L2 miss) × additional LLC service time
+ P(LLC miss) × additional off-chip/peer service time
```

The probabilities after the first are conditional: "L2 miss rate" must be clear about whether its denominator is all loads or only L1 misses. Mixing counter denominators is a common way to produce an impossible estimate.

Real loops need a second dimension: **memory-level parallelism**. Four independent misses may overlap, consuming fill buffers and bandwidth while exposing much less than four times one miss's latency. Four dependent pointer loads cannot overlap because each address waits for the previous result. Thus the same miss count can describe two different bottlenecks:

```text
independent:  load A ─────────┐
              load B ────────┼─ overlap
              load C ────────┘

dependent:    load A ───────► address B ───────► address C
```

Prefetching also changes whether a line is a *demand* miss without eliminating the underlying fill traffic. For latency reasoning, ask how many cycles are exposed on the dependency chain. For throughput reasoning, ask how many lines per unit time move through the hierarchy and which finite resources—miss-status entries, fill buffers, cache ways, or bandwidth—saturate. Chapter 27 develops dependency chains; Chapter 30 supplies target measurements.

### Replacement policies are implementation behavior

On a miss into a full set, the cache chooses a victim. Exact replacement is generally not an ISA guarantee and is often undocumented. High-associativity caches avoid the state and update cost of exact least-recently-used (LRU) tracking by using approximations or adaptive policies.

| Policy family | Mechanism | Trade-off |
|---|---|---|
| Pseudo-LRU | Compact state approximates recency | Cheap, but can choose a non-LRU victim |
| Not-recently-used | Tracks coarse recent use | Low metadata cost |
| Re-reference prediction | Predicts whether a new/resident line will return soon | Can resist one-pass scans |
| Adaptive / set dueling | Sample sets compare policies and select one dynamically | Responds to workload phases |
| Randomized | Selects victims with little recency state | Avoids some deterministic adversarial patterns |

Scan resistance illustrates why replacement matters. Strict LRU treats each line in a one-pass stream as most recently used, allowing the stream to displace a reusable working set. A re-reference predictor can insert streaming lines as early victims instead. Which policy a particular CPU uses is research- and measurement-informed, not a portable fact.

Three consequences:

- Do not predict an exact eviction sequence without a documented policy or a measurement.
- Cache simulators use simplified replacement and omit many physical-address, coherence, and prefetch effects. They remain useful for controlled comparisons within their model.
- Non-temporal hints (§28.6) can express expected low reuse, but their effect remains target-specific.

### Thrashing is repeated eviction before reuse

A workload **thrashes** when competing lines repeatedly evict one another before useful reuse. Total footprint can cause capacity thrashing; congruent addresses can cause set thrashing; two writers can cause coherence thrashing. The visible symptom—many misses or transfers—does not identify which resource is over capacity.

Estimate the active footprint over one reuse interval:

```text
active lines =
    payload lines
  + index/pointer lines
  + control and stack lines
  + concurrently active instruction/metadata effects
```

Compare payload and metadata with the effective sharing domain, not the marketing capacity. An LLC shared by several cores does not reserve its full nominal size for one thread, replacement does not partition capacity fairly, and inclusion may duplicate lines across levels. There is no portable "use at most 50% of cache" threshold.

The diagnostic is a controlled sweep. Vary only the number of active records while holding access order constant; then vary stride/base alignment while holding footprint constant. A footprint-dependent knee suggests capacity. A sharp sensitivity to congruence suggests conflict. A dependency on the second writer suggests coherence. This three-axis experiment is more informative than one aggregate miss rate.

---

## 28.3 Coherence and Store Ownership — Core

Store cost follows from two layers: the cache's write/allocation policy determines whether old data is fetched and when dirty data moves downward; coherence determines which core may write the line. These hardware mechanisms are separate from the C++ memory-order rules that make inter-thread communication correct.

### Write-back, write-allocate, and the RFO

Two orthogonal policies describe stores.

| Question | Policy choices | Consequence |
|---|---|---|
| When does modified data move downward? | Write-back vs. write-through | Combines repeated stores vs. propagates each store promptly |
| What happens on a store miss? | Write-allocate vs. no-write-allocate | Fetch/own a cache line vs. write without normal allocation |

These policies describe a cache or memory type, not the C++ memory-order relation. A release store can target ordinary write-back memory; a relaxed store still participates in hardware coherence.

**On a store hit**, normal memory on common x86-64 and AArch64 systems uses *write-back* caching: update the cached line, mark it dirty, and propagate it to the next level later. A write-through policy propagates each store promptly. Write-back combines repeated updates while a line remains resident, but dirty evictions consume finite writeback-buffer and downstream bandwidth. Once those resources fill, later loads or fills can be delayed.

**On a store miss**, normal write-back memory commonly uses *write allocate*: obtain the line in a writable coherence state before modifying it. The ownership request invalidates peer copies and, absent a target-specific optimization, fetches existing line contents. That transaction is called a **read for ownership**. It is necessary for a partial-line store because untouched bytes must be preserved; it is avoidable traffic when software overwrites the whole line and has an appropriate non-allocating mechanism.

The resulting traffic matters for write bandwidth:

```cpp
std::memset(buf, 0, 1u << 30);   // 1 GiB written
```

In the simple write-allocate model, this phase causes approximately 1 GiB of ownership reads and 1 GiB of later dirty writebacks. Real `memset` implementations may choose specialized paths, and traffic can be served or absorbed at several hierarchy levels, so confirm the model with separate read/write traffic counters.

Ways to reduce the ownership-read component are target-specific:

1. **Non-temporal stores** (§28.6) request low-pollution, write-combining behavior and commonly avoid ordinary write allocation for full-line streams.
2. **Architecture-specific whole-block operations**, such as cache-block zeroing on some AArch64 implementations, can establish a complete new block without reading old contents.
3. **Optimized library routines** may select non-temporal, block-zero, or other specialized sequences according to size, alignment, CPU dispatch, and library version.

Neither ordinary full-width vector stores nor `rep stos`/`rep movs` has a portable promise to avoid RFO traffic. Library thresholds are implementation details and sometimes runtime tunables; do not quote a universal cutoff. Inspect the selected routine and sweep size/alignment on the deployed build.

To test the hypothesis, compare intended store bytes with RFO/offcore events and memory-controller read/write traffic supported by the named processor. Event names and what they count vary. MMIO and write-combining memory types have different caching and ordering rules; Chapters 29 and 47 cover those device-facing cases.

### Coherence states and transfers

Hardware coherence establishes a serialization of writes to each coherent location and propagates ownership/data among caches. It is not the same as a memory-consistency model, which constrains observations across different locations.

This hardware property does **not** make an unsynchronized C++ race legal. Conflicting non-atomic accesses without a happens-before relation are undefined behavior. Use atomics or another synchronization protocol first (Ch. 25–26); then use coherence to reason about its physical traffic.

MESI is a useful mental model; actual protocols add states and transient transitions:

| Stable state | Meaning | Others may hold it | Memory up to date |
|---|---|---|---|
| Modified | Sole copy, dirty | No | No |
| Exclusive | Sole copy, clean | No | Yes |
| Shared | Possibly several clean copies | Yes | Yes |
| Invalid | Not present | — | — |
| Owned (MOESI family) | Dirty but shared; an owner supplies data | Yes | No |
| Forward (MESIF family) | A designated clean sharer may answer requests | Yes | Yes |

Two extensions illustrate traffic reduction:

- **Exclusive** allows a clean sole copy to transition E→M without first invalidating sharers. This removes a coherence transaction for read-then-write private data.
- **Owned** allows a dirty line to be shared while a cache remains responsible for supplying it. **Forward** designates one clean sharer as responder. Protocol names and details are implementation-specific.

The two transitions that cost:

```
Core A stores x  →  needs M. If any other cache holds it, send a read-for-ownership,
                    invalidate every other copy, wait for acknowledgements.
Core B loads x   →  A holds it Modified. The snoop hits modified (HITM): A supplies
                    the line cache-to-cache and downgrades to S (or O).
```

Both operate at the coherence granule and require interconnect messages. Their cost depends on topology, sharer count, and responder placement. Chapter 30 contains measured examples; Chapter 29 covers cross-socket topology.

Large systems commonly use directories or snoop filters to narrow coherence probes rather than broadcasting every request. Their placement and protocol are not architectural C++ properties.

On supported Linux processors, `perf c2c` samples data-source/coherence events and groups accesses by cache line and offset. Availability and HITM precision vary by CPU and kernel, but when supported the offset report helps distinguish the two sharing cases in §28.4.

### Publication has a correctness cost and a traffic cost

Suppose a producer fills a slot, performs a release store to a ready sequence, and a consumer waits with an acquire load. Release/acquire establishes C++ visibility when the acquire reads the published value (Ch. 25). Coherence then implements the physical ownership changes.

If the payload and sequence share a line, publication can move one line but consumer polling may repeatedly interact with a line the producer is still modifying. If they occupy separate lines, the control line can bounce independently while payload lines remain read-only after publication. Neither arrangement is automatically best: a tiny immutable payload may benefit from one transfer; a large payload and frequent polling may benefit from separation and batching.

Count publications, not only messages. Publishing once per batch amortizes ownership of the control line, but increases queueing delay before the consumer sees the first item. That is a throughput-versus-latency trade-off, while release/acquire is the correctness boundary. Changing memory order to `relaxed` does not solve the ownership bottleneck and may break the protocol.

---

## 28.4 False Sharing, True Sharing, and the Miss Taxonomy — Core

**False sharing** is logically independent data occupying one line. **True sharing** is genuinely shared data — a queue index, a sequence number, a lock word. Both produce line bouncing: the line migrating between cores under ownership traffic. Only one of them can be padded away.

| | False sharing | True sharing |
|---|---|---|
| Cause | Unrelated variables in one line | The algorithm shares one variable |
| `perf c2c` signature | Different offsets in the line, different threads | The same offset, contended |
| Fix | Padding or alignment | Partition, batch, or make the sharing one-directional |
| Test | Slowdown disappears when padded | Padding changes nothing |

Assume `a` and `b` occupy different offsets of one line and start shared in cores P and Q. This is the ownership cycle when P updates `a` and Q updates `b`:

```text
P stores a:  P requests ownership ──► Q invalidates its copy ──► P has M
Q stores b:  Q requests ownership ──► P supplies/invalidates ──► Q has M
P stores a:  repeat
```

The language-level variables are independent, but the hardware cannot grant write permission to half a line. Each handoff moves coherence messages and may transfer data; a relaxed atomic changes ordering constraints but does not shrink the coherence granule. If P performs many consecutive updates while it owns the line, those stores combine locally. Alternating ownership is the damaging pattern.

The fixes for true sharing, in order of preference:

1. **Do not share.** Per-core counters aggregated at read time. This is the answer for metrics (Ch. 59) and allocator statistics.
2. **Batch.** Accumulate locally and publish every N operations, reducing the opportunities for ownership handoff from one per operation to one per batch.
3. **Make sharing one-directional.** An SPSC ring (Ch. 26) can put producer- and consumer-written positions on separate lines. Each line then has one writer, rather than two writers repeatedly exchanging ownership.
4. **Reload shared state only when necessary.** Repeated loads can hit locally while a line remains shared, but after the producer writes, the consumer's next load requests a fresh copy and the producer's next store reacquires ownership. A cached local position reduces those transitions.
5. **Back off** under contention (Ch. 24).

Read-mostly immutable data can remain shared without recurring write invalidations after initial fills. Publication still requires synchronization and safe reclamation (Ch. 25–26), and capacity misses remain possible.

### A minimal false-sharing experiment

Use relaxed atomics so the increments remain observable operations without adding cross-location ordering. The packed form usually places both counters in one line; the separated form guarantees at least the chosen alignment between array elements/fields:

```cpp
#include <atomic>
#include <cstddef>
#include <cstdint>

struct alignas(64) PackedCounters { // 64 is the documented target granule
    std::atomic<std::uint64_t> a{0};
    std::atomic<std::uint64_t> b{0};
};

template<std::size_t Separation>
struct alignas(Separation) Counter {
    std::atomic<std::uint64_t> value{0};
};

template<class Atomic>
void increment(Atomic& x, std::uint64_t count) {
    for (std::uint64_t i = 0; i < count; ++i)
        x.fetch_add(1, std::memory_order_relaxed);
}
```

Run two pinned threads, one per counter, comparing `PackedCounters` with the two elements of `std::array<Counter<64>, 2>` and `std::array<Counter<128>, 2>`. Record topology, compiler, iteration count, elapsed-time distribution, and line/offset evidence from a supported coherence tool. The experiment measures both atomic-instruction cost and ownership movement; the meaningful comparison holds the atomic operation constant and changes only placement.

### How much padding, and what the standard constant means

`std::hardware_destructive_interference_size` from `<new>` is an implementation-defined recommendation for the minimum separation between objects likely to suffer destructive interference. It is neither a runtime query nor a portable cache-line-size value.

- Common libstdc++ x86-64 configurations report 64, not 128. The value may depend on compiler target/tuning options; GCC can warn when it affects public layout. Keep all translation units and ABI participants consistent.
- A project may choose 128-byte separation after measuring adjacent-line interactions or future-proofing on a named target. That is a project layout policy, not the standard constant's meaning. A hardware prefetch into a neighboring line is not itself proof of destructive interference.

```cpp
// Suitable for internal layout when every translation unit uses one build target.
#include <atomic>
#include <cstdint>
#include <new>

struct alignas(std::hardware_destructive_interference_size) PaddedCounter {
    std::atomic<std::uint64_t> value{0};
};
```

Alignment makes `sizeof(PaddedCounter)` a multiple of the alignment, so adjacent array elements receive the same separation without a hand-written padding array. For a stable external ABI, use an explicit project constant and version the layout.

### The miss taxonomy

Four classes, each with a different fix — which is the entire reason the taxonomy exists.

| Class | Definition | Experimental test | Fix |
|---|---|---|---|
| Compulsory | First reference to the line | Still occurs in an infinite cache | Improve spatial use; prefetch may hide demand latency but not remove the fill |
| Capacity | Working set exceeds the cache | Occurs in a fully associative cache of the same size | Shrink the working set: tiling, smaller types, structure-of-arrays |
| Conflict | Too many lines map to one set | Absent in a fully associative cache of the same size | Change addresses: padding, offsetting, coloring (§28.8) |
| Coherence | Line invalidated by another coherent writer | Disappears when other writers are removed | Separate false sharers or redesign true sharing |

The classic taxonomy has three Cs; coherence misses are a useful fourth class on multiprocessors. Experiments can separate hypotheses:

- Compulsory: miss count tracks unique bytes touched ÷ line size and is insensitive to cache size.
- Capacity: sweep working-set size and plot time per access. Knees may correspond to effective cache capacities, blurred by replacement and prefetch.
- Conflict: hypersensitive to stride and base address. A sharp change after padding supports the hypothesis, then set arithmetic should predict the new mapping.
- Coherence: disappears with one thread; `perf c2c` names the line.

Chapter 43 covers sampled data-source events, top-down analysis, and cache simulation. Use them to test a hypothesis formed from the taxonomy rather than treating one generic miss counter as a diagnosis.

---

## 28.5 Hardware Prefetchers — Core

Prefetchers predict future accesses and request lines before a demand load stalls. Sequential and simple strided access give them both a recognizable pattern and enough lead time; random dependent access does not.

The useful model is deliberately less specific than any vendor's undocumented design:

- **Streams and stable strides are easiest.** Detectors may be keyed by the load instruction, region, or recent address history. Forward/backward support, stride limits, and training length vary.
- **A dependent pointer chain exposes no next address until the current load completes.** Ordinary stream prefetchers cannot get ahead. Some processors implement indirect or correlation-based prefetchers, so "no processor follows pointers" is too strong.
- **Page boundaries can interrupt training.** Many prefetchers are conservative near translation boundaries; others can cross under particular confidence or translation conditions. Do not assume either behavior without a target experiment. Huge-page policy belongs to Chapter 32.
- **Tracking and fill resources are finite.** Too many streams compete for prefetch state, miss-status entries, cache capacity, and bandwidth.
- **Incorrect predictions hurt.** Unused lines consume those resources and may evict useful lines.

```cpp
// One contiguous stream exposes future addresses early.
struct Tick {
    std::uint64_t ts;
    std::int64_t price;
    std::uint32_t quantity;
    std::uint32_t flags;
};
std::vector<Tick> ticks;

// Each next address depends on the current node load.
struct Node { Tick value; Node* next; };
Node* head = nullptr;
```

The comparison is not only prefetching: nodes add allocation overhead and consume pointer bytes. A fair measurement holds the represented data and operation constant, varies layout, and records useful bandwidth plus cache misses (Ch. 43).

---

## 28.6 Software Prefetch and Non-Temporal Stores — Role-specific

### Software prefetch

When hardware cannot learn a pattern but software knows a future address early enough, consider a software hint.

GCC and Clang expose `__builtin_prefetch`; x86 also provides `_mm_prefetch`. Both are non-standard extensions.

A prefetch instruction is a hint and may be ignored. It generally does not raise the data-access fault that a demand load would, but source code must still avoid undefined pointer arithmetic and target-specific instructions have architectural caveats. It consumes front-end, lookup, fill, bandwidth, or cache resources even when it does not help.

The distance is a calculation followed by a sweep:

```
distance in iterations ≈ miss latency / steady-state cycles per iteration
```

Too close and the line has not arrived; too far and it is evicted before use, or it evicts data you still need. Use the formula for a starting point, then sweep — a plot of time against distance is usually broad and flat near the optimum, and the optimum moves when the loop body or the machine changes.

```cpp
#include <cstddef>
#include <cstdint>
#include <span>

template<class Process>
void indirect_pass(std::span<const std::uint64_t> data,
                   std::span<const std::size_t> index,
                   Process process) {
    constexpr std::size_t distance = 24; // example starting point
    for (std::size_t i = 0; i < index.size(); ++i) {
        if (distance < index.size() - i)
            __builtin_prefetch(&data[index[i + distance]], 0, 1);
        process(data[index[i]]);
    }
}
```

Assume every `index[j]` is in range; otherwise even forming the pointer is invalid C++. Indirect access such as `data[index[i]]` is a reasonable candidate because the index stream reveals future addresses. Hash probes, trees, and binary search may benefit when enough independent work exists between hint and use. Prefetching both tree children can instead double bandwidth for one useful path.

`__builtin_prefetch(p, 1)` expresses an intent to write; the generated instruction and whether it obtains ownership are target-dependent. It can be tested for histogram-like updates, but is not a C++ guarantee that the later RFO disappears.

### Non-temporal stores

Non-temporal stores hint that written data has little near-term reuse. On x86 write-back memory, streaming-store intrinsics commonly use write-combining resources and avoid ordinary cache allocation/RFO traffic for well-formed full-line streams. "Bypasses every cache" is too strong: handling of hits, partial writes, and hierarchy paths is microarchitecture- and memory-type-specific.

```cpp
#include <atomic>
#include <immintrin.h>

// x86/AVX2; dst is 64-byte aligned and names one complete target line.
void stream_line_then_publish(__m256i* dst, __m256i lo, __m256i hi,
                              std::atomic<bool>& ready) {
    _mm256_stream_si256(dst, lo);
    _mm256_stream_si256(dst + 1, hi);
    _mm_sfence();
    ready.store(true, std::memory_order_release);
}
```

The common mechanism coalesces adjacent writes in a finite number of write-combining buffers. Complete, aligned, sequential lines make good use of them; interleaved streams and partial lines consume buffers and may require read/merge traffic.

1. Write full lines, sequentially.
2. Keep concurrent streams within measured write-combining capacity; the count is part-specific.
3. **Fence before publication.** On x86, streaming stores are weakly ordered relative to later stores. Execute `_mm_sfence()` after the streaming stores and before the atomic release publication; a release store alone often compiles to an ordinary store and is not a substitute for the required streaming-store fence. The consumer uses an acquire load. Other architectures require their documented barrier sequence (Ch. 25).
4. Prefer them for data with little near-term reuse. When the destination is read soon, a temporal store may be better because it leaves the line cached.

The payoff for large write-once data is the elimination of the ownership read described in §28.3, plus survival of everyone else's working set. Both effects are workload-dependent; measure DRAM read and write bandwidth separately before and after.

Non-temporal stores are compiler/ISA extensions, not standard C++ operations. Verify generated instructions, alignment handling, read/write traffic, and publication ordering on the deployed target.

---

## 28.7 Case Study: Laying Out a Top-of-Book Structure — Core

The mechanisms above turn into one design problem: a per-instrument book updated by a feed handler and consumed by a strategy, with top levels read much more often than deep levels. Assume a correct SPSC or snapshot-publication protocol already exists. Layout changes do not make unsynchronized concurrent field access legal.

Start by counting lines per operation, not bytes.

```cpp
// Layout A: node-based baseline.
#include <array>
#include <cstddef>
#include <cstdint>
#include <map>

struct Order;
inline constexpr std::size_t kLevels = 8;

struct Level { std::int64_t price; std::int64_t qty; Order* orders; };
std::map<std::int64_t, Level> bids; // one allocation per level, pointer chase per lookup

// Layout B: flat, indexed by a dense tick offset from a reference price.
inline constexpr std::size_t kTargetLine = 64; // measured/documented target property
struct alignas(kTargetLine) TopOfBook {
    std::int64_t bid_px, ask_px;
    std::int32_t bid_qty, ask_qty;
    std::uint32_t sequence;
    std::uint32_t flags;
};
static_assert(sizeof(TopOfBook) == kTargetLine);

struct BookDepth {                  // separate lines; touched only on deeper updates
    std::array<std::int32_t, kLevels> bid_qty;
    std::array<std::int32_t, kLevels> ask_qty;
};
```

The analysis that justifies B:

- **Lines per read.** Layout A follows tree nodes at unrelated addresses, creating dependent loads that ordinary stream prefetching cannot cover. Layout B puts the frequently consumed snapshot in one target line.
- **Sets and strides.** `BookDepth` is contiguous and supports predictable scans. If an array-of-books has a power-of-two object stride, use §28.1's arithmetic to check whether corresponding fields cycle through too few L1 sets. A small layout change can rotate the index sequence, but it must be measured because lower-level hashing differs.
- **Sharing direction.** The publication channel should have one writer per control line. A strategy-owned "last seen sequence" placed beside feed-owned state creates two writers and avoidable ownership movement even though the fields are logically related.
- **Residency.** Splitting top data from depth prevents a top-only operation from fetching depth fields. Whether all hot top snapshots fit L2 is a capacity calculation using the deployed cache sharing domain, not a guarantee from `alignas`.
- **What not to do.** Do not pad every field to a line "to be safe." Padding costs residency, and residency is the thing you are optimizing. Pad what is written by different cores; pack what is read together.

### Compare layouts with a line budget

Suppose 20,000 instruments are active. A one-line top snapshot consumes about 1.22 MiB at a 64-byte target line, before container metadata. Padding each of six fields to its own line raises that to about 7.32 MiB. The padded form might remove false sharing between independent writers, but here all six fields travel together and share one logical owner, so it multiplies fills and reduces residency without removing an ownership conflict.

The decision rule is:

```text
pack fields read together and owned together
separate fields written by different cores
```

Validate both sides. A working-set sweep tests the predicted capacity knee; sampled load addresses count lines per operation; a supported coherence tool checks whether different threads write different offsets of one line. Chapter 43 covers experiment design.

---

## 28.8 Residency Control: Warming and Partitioning — Role-specific

**Warming** means deliberately touching code or data before a latency-sensitive event so the first measured access is not compulsory. It can reduce cold-start tails, but residency is not permanent: unrelated activity, interrupts, migration, and capacity pressure can evict the warmed state. A credible warm-up executes the same path and data footprint without external side effects, then verifies instruction/data misses on the first real operations. Page prefaulting and locking solve a different problem—page faults—and belong to Chapter 32; operational warm-up policy belongs to Chapter 42 and Chapter 55.

**Way partitioning** restricts which LLC ways a workload or class of service may allocate. Intel CAT exposed through Linux `resctrl` and Arm MPAM are examples, subject to processor and kernel support.

| Expected benefit | Cost / boundary | Verification |
|---|---|---|
| Reduced cross-workload capacity eviction | Each class receives less usable LLC capacity | Occupancy/miss counters plus workload latency distribution |
| More repeatable residency under co-tenancy | Does not isolate memory bandwidth or all coherence traffic | Run controlled noisy-neighbor A/B trials |
| Operational grouping by core/task | Masks and assignment semantics are platform-specific | Read back configuration and monitor placement |

More private ways are not automatically better: a partition that is smaller than the hot working set creates its own capacity misses. Conversely, unrestricted shared capacity may have worse tails under an interfering tenant. Chapter 42 develops the optimization decision; this chapter supplies the eviction mechanism.

**Page coloring** selects physical pages so physically indexed cache bits distribute or isolate allocations among sets. User-space virtual addresses alone generally do not control those physical bits, and mainstream general-purpose allocators do not offer a portable coloring contract. OS, hypervisor, and real-time deployments may provide target-specific controls. Huge pages change translation and physical-contiguity constraints but are not a portable substitute for an explicit coloring policy (Ch. 32).

---

## 28.9 Instruction-Side Locality and the iTLB — Reference

Data is only half of cache locality. Instructions occupy L1 instruction-cache lines, and their virtual pages require translations cached in the instruction TLB (iTLB). A large or scattered hot path can therefore stall even when its data fits L1d.

Keep three mechanisms distinct:

- An **L1i miss** fetches instruction bytes from a lower cache level.
- An **iTLB miss** looks for a cached translation at another TLB level or invokes a page walk.
- A **front-end delivery limit** may instead come from decode, branch-target, or µop-cache behavior (Ch. 27).

One event can lead to another, but their remedies and counters differ. Function order and hot/cold splitting change instruction-line locality; page size changes translation reach; neither guarantees better branch prediction. Huge executable pages are OS/toolchain/deployment-specific and trade translation reach against fragmentation, permissions, placement constraints, and operational complexity. Chapter 32 covers page mechanics, while Chapter 42 covers code-layout experiments.

Diagnose with instruction-cache and iTLB events available on the target, plus a source/assembly profile. Do not infer an iTLB problem merely from a large binary: only the executed working set and its page distribution matter.

---

## 28.10 Reference: Structures and Counters — Reference

Skippable. Counter names for Intel; ARM equivalents differ in name and availability, and both change with the part. Always confirm against `perf list` on the target rather than a book.

| Question | Intel counters |
|---|---|
| Am I missing L1/L2/LLC? | `L1-dcache-load-misses`, `l2_rqsts.miss`, `LLC-load-misses` |
| Which load, and served from where? | `perf mem record` / `perf mem report` (PEBS) |
| Is a line contended, and false or true? | `perf c2c`, `mem_load_l3_hit_retired.xsnp_hitm` |
| Am I paying the write-allocate tax? | `offcore_requests.demand_rfo`, plus DRAM read/write bandwidth |
| Is the prefetcher helping or wasting? | `l2_rqsts.pf_hit`, `l2_rqsts.pf_miss`, useless-prefetch counters where available |
| Where is stall time going by level? | Top-down `Memory_Bound` breakdown (Ch. 43) |
| Is code missing L1i or translation? | Target-specific L1i/iTLB miss and page-walk events |

Counter semantics vary by processor, kernel, privilege settings, and event scheduling. In particular, an LLC miss can be satisfied by another coherent cache or another hierarchy domain; use a supported data-source/offcore event before attributing it to memory.

---

## 28.11 Recall and Practice — Core

**Recall card.**

1. Cache line size, sharing domains, indexing, inclusion, and replacement are target properties. C++ does not specify them.
2. For a conventional cache, `sets = size / (line × ways)`. More live congruent lines than ways create conflict pressure.
3. A VIPT L1 can overlap set lookup with translation when its index and offset lie within the page offset; that relation is a common design, not an ISA mandate.
4. Normal write-back, write-allocate memory generally requires ownership before a store. A cold partial-line store needs old contents; a full-line streaming overwrite may avoid that read with a target-specific mechanism.
5. Coherence serializes ownership per location, but it does not make C++ data races legal.
6. False sharing has different writers at different offsets of one line. True sharing has writers contending on the same logical data. Only the former is removed by separation.
7. Prefetchers readily learn streams, but page-boundary, stride, and indirect-pattern capabilities vary. Software hints compete for finite resources.
8. On x86, streaming stores require `_mm_sfence()` before a later release publication; a release store alone is not a guaranteed substitute.

**Questions.**

1. Given a cache size, line size, and associativity, derive the set count and the index bits, and state which addresses collide.
2. Derive the `capacity ≤ page_size × ways` relation for a VIPT L1. Why is it a design pressure rather than a universal limit?
3. Under the plain write-allocate model, why can a full-buffer overwrite cause read traffic comparable to write traffic? Why might an optimized `memset` not follow that model?
4. What does the Exclusive state save, and what would happen without it?
5. You see a shared counter's throughput fall as you add cores. Distinguish the two possible causes and give the measurement that separates them.
6. Why can an LLC miss not be translated directly into "DRAM access"?
7. Explain why a dependent linked-list traversal is difficult to prefetch. What exceptions keep that statement from being an architectural guarantee?
8. Under what conditions does software prefetch make a loop slower?
9. A producer writes a buffer with x86 non-temporal stores and then publishes readiness. State the required producer and consumer ordering.
10. Why can indiscriminate cache-line padding improve a two-counter microbenchmark yet worsen end-to-end latency?

### Worked exercises

**False-sharing experiment.** Extend §28.4's benchmark with separations of 8, 16, 32, 64, 128, and 256 bytes. Keep each counter distinct; a separation of zero would instead measure true sharing. Pin threads to two specified cores in one cache/coherence domain using a platform API. Plot operations per second and a latency distribution, then inspect line/offset samples if supported. Predict a knee when counters stop occupying one coherence granule; treat any second 128-byte effect as measured target behavior, not as the meaning of `hardware_destructive_interference_size`. Report CPU, topology, compiler flags, frequency policy, repetitions, and uncertainty.

**Cache-set exercise.** Use the target L1d's reported size, ways, and line size to compute its set count. For the hypothetical geometry in §28.1, eight 4096-byte-spaced lines fit one set and a ninth overflows it. Construct dependent cycles containing 7, 8, 9, and 10 lines, plus controls at a 4160-byte stride. Predict which runs add conflict misses before measuring. Randomize trial order and consume the returned index. If the knee differs, investigate replacement, address alignment, virtual/physical indexing, and prefetch effects rather than changing the prediction after seeing the result.

### Code-reading puzzle

```cpp
struct Shared {
    alignas(64) std::atomic<std::uint64_t> produced{0};
    std::atomic<std::uint64_t> consumed{0};
};
```

The author says `alignas(64)` prevents false sharing. Is that guaranteed for these two fields? Draw their possible offsets, then repair the layout for a target whose measured destructive-interference granule is 64 bytes. Explain why aligning the first member or the containing object does not by itself align the second member to another line.

### Common traps

- Treating a virtual address's visible bits as the exact index for every cache level.
- Calling every miss a capacity miss, or interpreting an LLC miss as DRAM.
- Padding the containing struct while leaving two writer-owned members adjacent within it.
- Using `hardware_destructive_interference_size` as a runtime cache-line query or assuming it is 128 on x86.
- Benchmarking non-atomic counters so the compiler combines increments and removes the coherence traffic.
- Prefetching an already streamed loop, issuing the hint too late, or forming an out-of-range address.
- Assuming wide temporal stores or `rep stos` portably avoid RFOs at a fixed size threshold.
- Publishing after x86 non-temporal stores without an explicit streaming-store fence.

**Prerequisites for Chapter 29.** Be able to derive set pressure from cache geometry (§28.1), explain when a store requests ownership, and trace a peer-cache transfer (§28.3). Chapter 29 extends that path through memory controllers, interconnects, and NUMA placement.
