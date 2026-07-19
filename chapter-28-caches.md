# Chapter 28 — Caches

*Interview-focused revision notes. The theme: every memory access is a bet that the data is nearby, and the entire discipline of low-latency data layout is the business of making that bet win — which requires knowing exactly what "nearby" costs and exactly why a miss happened.*

---

## 28.1 Cache Hierarchy

A **cache** is a small, fast memory holding a subset of a larger, slower one, exploiting **temporal locality** (recently used data is used again) and **spatial locality** (data near recently-used data is used soon).

### Typical modern x86-64 server (Ice Lake SP / Sapphire Rapids / Zen 4 class)

| Level | Size | Assoc | Latency | Bandwidth | Scope |
|---|---|---|---|---|---|
| Registers | ~1 KB | — | 0 (bypass) | ~6 ops/cyc | Per-thread |
| **L1d** | 32–48 KB | 8–12-way | **4–5 cycles (~1.3 ns)** | 2×64 B load + 1–2×64 B store /cyc | Per-core (shared by SMT siblings) |
| **L1i** | 32–64 KB | 8-way | ~5 cycles | 32 B/cyc fetch | Per-core |
| **L2** | 1–2 MB (Intel SPR: 2 MB; Zen 4: 1 MB) | 8–16-way | **~14 cycles (~4.5 ns)** | ~64 B/cyc | Per-core |
| **L3 / LLC** | 1.5–4 MB per core, 30–100+ MB total | 12–16-way | **~40–60 cycles (~15–20 ns)**, higher on large-mesh parts | ~16–32 B/cyc/core | Shared per socket (or per CCX on AMD) |
| **DRAM (local)** | GBs | — | **~70–100 ns (~250–350 cycles)** | ~20–40 GB/s per channel | Socket |
| **DRAM (remote NUMA)** | GBs | — | **~120–200 ns** | Interconnect-limited | Other socket (Ch. 29 §29.19) |

*(Cycle figures at ~3 GHz. ARM: Neoverse V2 L1d 64 KB / ~4 cyc, L2 1–2 MB / ~13 cyc, system-level cache tens of MB at ~30–40 ns; Apple M-series L1d 128 KB with ~4-cycle latency and a very large shared SLC. The **shape** is identical everywhere; the constants shift.)*

The ratio that matters: **L1 to DRAM is ~50–70×**. A single unhidden DRAM miss costs more than 200 dependent ALU operations. Consequently, on any modern machine, *data layout beats instruction count* for almost all real workloads — the entire argument for data-oriented design (Ch. 42 §42.1).

### Inclusive, exclusive, non-inclusive

| Policy | Meaning | Used by | Consequence |
|---|---|---|---|
| **Inclusive** | L3 contains everything in L1/L2 | Intel pre-Skylake-SP | L3 eviction must **back-invalidate** L1/L2 copies; simplifies coherence (L3 acts as a snoop filter) but wastes capacity |
| **Non-inclusive** | L3 *may* contain L2 lines | Intel Skylake-SP onward | Needs a separate snoop filter; larger effective capacity |
| **Exclusive / victim** | L3 holds only lines evicted from L2 | AMD (L3 is a victim cache per CCX) | Max effective capacity = L2 + L3; but an L3 hit on AMD does **not** mean another core had it |

This matters for interpreting counters. On AMD, the L3 is a **victim cache private to a CCX** (core complex, 8 cores on Zen 3/4), so a miss that crosses CCXs costs an Infinity Fabric round trip — **~100+ ns even to the same socket's other CCX**. Cross-CCX thread placement is an AMD-specific latency hazard that has no Intel analogue; pin communicating threads within a CCX (`lscpu -e`, `numactl --hardware`, and `/sys/devices/system/cpu/cpu*/cache/index3/shared_cpu_list` reveal the boundaries).

### Where the tools look

```
$ lscpu -C                      # cache sizes, ways, line size, sharing
$ getconf -a | grep CACHE       # LEVEL1_DCACHE_LINESIZE etc.
$ cat /sys/devices/system/cpu/cpu0/cache/index0/{size,ways_of_associativity,coherency_line_size}
$ perf stat -e L1-dcache-loads,L1-dcache-load-misses,LLC-loads,LLC-load-misses ./a.out
$ likwid-topology -g            # graphical topology incl. cache sharing
```

---

## 28.2 Cache-Line Organization

The **cache line** (Intel: cache line; ARM: cache line; the coherence unit) is the atomic unit of transfer and coherence: **64 bytes on all mainstream x86-64 and most ARM**; Apple Silicon uses **128 bytes**; some IBM POWER parts use 128.

Everything about cache behavior follows from this granularity:

- Touching **one byte** transfers **64 bytes** from the next level. A random 8-byte read from a large array wastes 87.5% of the bandwidth it consumes.
- Two variables in the same line are **coherently indistinguishable** — a write to either invalidates the whole line elsewhere. That is false sharing (Ch. 26 §26.15) if they're logically independent, and true sharing (§28.8) if they aren't.
- An access **straddling** two lines requires two lookups (§29.12).

### Lines, sectors, and the adjacent-line prefetcher

Intel's L2 has an **adjacent-line prefetcher** ("spatial prefetcher") that, on a miss, also fetches the *paired* line so that the 128-byte-aligned pair is brought in together. The effective sharing granularity for false-sharing purposes is therefore often **128 bytes, not 64**, on Intel. This is why `std::hardware_destructive_interference_size` is **128** in libstdc++ on x86-64 while the line size is 64, and why HFT codebases commonly pad to 128 (and to 128 on Apple for the real line size).

```cpp
struct alignas(64)  Counter64  { std::atomic<uint64_t> v; char pad[56]; };  // may still bounce
struct alignas(128) Counter128 { std::atomic<uint64_t> v; char pad[120]; }; // safe on Intel
```

### Address decomposition preview

A physical (or, for L1 VIPT caches, partly virtual) address splits into:

```
 63                    offset_bits+index_bits              6           0
┌────────────────────────┬──────────────────────────┬──────────────────┐
│          TAG           │          INDEX           │   BLOCK OFFSET   │
└────────────────────────┴──────────────────────────┴──────────────────┘
                                                     └ 6 bits = 64 B line
```
`INDEX` selects the set; `TAG` is compared against every way in that set; `OFFSET` selects the byte. §28.3 works the arithmetic.

### Critical-word-first and early restart

The memory controller returns the **requested word first**, and the core can restart the dependent instruction before the full 64 bytes arrive. So the *latency* of a miss is the latency to the critical word, while the *bandwidth* consumed is the whole line. This is why a load's latency and a line fill's occupancy are different numbers, and why measuring "DRAM latency" with a pointer-chase gives a smaller number than the line's total transfer time.

---

## 28.3 Cache Associativity and Address Decomposition

**Associativity** (*N*-way) is the number of distinct lines that may occupy a given set. Direct-mapped is 1-way; fully associative is "any line anywhere" (used only for tiny structures like TLBs and victim buffers).

```
sets = size / (line_size × ways)
index_bits = log2(sets)
```

Worked, for a 32 KB 8-way L1d with 64 B lines:
```
sets       = 32768 / (64 × 8) = 64 sets
offset     = bits [5:0]        (6 bits, 64 B line)
index      = bits [11:6]       (6 bits, 64 sets)
tag        = bits [63:12]
```
**The crucial consequence:** two addresses map to the same set iff they agree in bits [11:6] — that is, iff they are **congruent modulo 4096 (the page size)**. This is not a coincidence: L1 index+offset ≤ 12 bits is deliberate, so that the set index comes entirely from the page *offset*, which is identical in virtual and physical addresses. That permits **VIPT** (virtually-indexed, physically-tagged) lookup: the set lookup starts from the virtual address in parallel with the TLB translation, and the physical tag comparison completes when the TLB result arrives. This overlap is exactly why L1 latency can be 4 cycles rather than TLB-latency plus cache-latency.

It also explains why L1 caches stopped growing: to stay VIPT with 4 KB pages, `size ≤ page_size × ways`. 32 KB needs 8 ways; 48 KB needs 12 (Ice Lake did exactly that); 64 KB needs 16 ways, which is expensive. AMD and ARM use way-prediction or larger associativity to get past it.

For a 2 MB 16-way L2: `sets = 2097152/(64×16) = 2048`, index = bits [16:6], so conflicts occur modulo **128 KB**.

### The power-of-two stride disaster

```cpp
double m[1024][1024];                       // row stride = 8192 B
for (int i = 0; i < 1024; ++i) sum += m[i][0];   // column walk
```
Every element is 8192 bytes apart. 8192 mod 4096 = 0, so **all 1024 addresses map to L1 set 0**. With 8 ways, you get 8 useful lines and then thrash — a 100% miss rate on a working set that would trivially fit. The same happens in L2 (stride 8192 mod 128 KB gives 16 distinct sets, so 1024 accesses hit 16 sets × 16 ways = 256 lines).

**Fixes:** pad the leading dimension to a non-power-of-two (`double m[1024][1024+8]`), tile the loop (Ch. 42 §42.7), or transpose. Padding by one line is the classic one-line fix and a good thing to produce on a whiteboard.

The diagnostic signature: L1 miss rate near 100% with a working set far smaller than L1, and a **stride that is a large power of two**. Detect with `perf stat -e L1-dcache-load-misses` plus a stride sweep, or with `cachegrind`/`valgrind --tool=cachegrind` which simulates the exact set mapping.

---

## 28.4 Cache Replacement Policies

On a miss into a full set, one line must be evicted. Real policies are approximations of LRU because true LRU for 16 ways requires log2(16!) ≈ 45 bits of state per set.

| Policy | Mechanism | Where |
|---|---|---|
| **Pseudo-LRU (tree-PLRU)** | Binary tree of N−1 bits per set | L1/L2 on many cores |
| **NRU** | One reference bit per line, periodic clear | Simple L2s |
| **RRIP / DRRIP / SRRIP** | 2-bit "re-reference prediction value"; new lines inserted with *distant* prediction so streaming data doesn't evict the working set | Intel LLC since Ivy Bridge, ARM |
| **Adaptive / set-dueling** | A few sampled sets run each policy; the winner drives the rest | Intel LLC |
| **Random / pseudo-random** | Cheap; avoids pathological patterns | Some ARM L2s |

### Why RRIP exists — the scan-resistance problem

Under true LRU, a **single sequential pass over data larger than the cache** evicts everything and hits nothing: each new line is MRU, so it displaces the resident working set, and the working set is destroyed for no benefit. This is the "streaming kills the cache" pathology. RRIP inserts new lines with a *distant re-reference prediction*, so a line that is never reused is the first victim, and the resident working set survives a scan.

The practical implications:

- **You cannot reason about LLC hit rates as if it were LRU.** Intel's adaptive LLC policy will often behave better than LRU on streaming workloads and worse than an idealized model on others.
- **Non-temporal stores and `prefetchnta`** (§28.14, §28.13) exist to give software the same hint explicitly: "this data has no reuse; don't disturb the cache."
- Benchmarks that assume LRU (classic cache-simulation exercises) will disagree with hardware. `cachegrind` models LRU and is therefore *approximate* on modern LLCs — a good thing to say when asked about its limitations.

### Sub-policies you may be asked about

- **Insertion policy** — where in the recency order a fill lands. This is where RRIP does its work.
- **Promotion policy** — how a hit updates recency. "Hit-promote to MRU" vs. "gradual."
- **Victim selection** — which of the N ways to evict.
- **Dead-block prediction** — some LLCs predict lines that will not be reused and evict them early.

**Interview framing:** *"Is the LLC LRU?"* — No; it's an adaptive RRIP variant chosen specifically to be scan-resistant, which is why a streaming memcpy doesn't destroy your hot data as badly as naive analysis predicts — and why explicit non-temporal hints are still worth using when you *know* there's no reuse.

---

## 28.5 Write-Back and Write-Through Caches

What happens on a store that hits in cache?

| | **Write-back** | **Write-through** |
|---|---|---|
| On a store hit | Update the line, set the **dirty bit**. Lower level unchanged. | Update the line **and** propagate to the next level immediately |
| Traffic to next level | Only on eviction of a dirty line | Every store |
| Latency of the store | Store-buffer speed (retire immediately) | Same for the core (buffered), but sustained bandwidth is far higher |
| State needed | Dirty bit per line | None |
| Coherence | Needs M state (Modified) | Line is never stale below |
| Used by | **All modern x86-64 and ARM data caches** | Some L1s in embedded/GPU designs; some ARM L1s are write-through to L2 |

**All mainstream CPU data caches are write-back.** The reason is bandwidth: a hot loop doing `++counter` a million times generates one memory transaction with write-back and a million with write-through. Write-through survives only where the next level is very close and the simplicity is worth it.

### Dirty-line eviction and the writeback buffer

An eviction of a dirty line does not stall the miss — the dirty line is moved to a **writeback buffer** (or the LLC's victim path) and drained asynchronously while the fill proceeds. This decoupling is why read latency doesn't double in a store-heavy workload. But the writeback buffer is finite; a workload dirtying lines faster than they can drain to DRAM becomes **writeback-bandwidth-bound**, and the symptom is that read latency rises even though the reads themselves hit.

### The memory-type dimension (x86)

Write-back is one of several **memory types** set by the MTRRs/PAT:

| Type | Cached? | Write combining? | Ordering | Typical use |
|---|---|---|---|---|
| **WB** (write-back) | Yes | Yes (via cache) | TSO | Normal RAM |
| **WT** (write-through) | Reads yes | No | TSO | Rare |
| **WC** (write-combining) | No | **Yes** (WC buffers) | **Weakly ordered** | Framebuffers, **PCIe MMIO doorbells** (Ch. 29 §29.11) |
| **UC** (uncacheable) | No | No | Strongly ordered, no reorder | MMIO control registers |
| **WP** (write-protect) | Reads yes | No | — | Rare |

This table is directly relevant to kernel-bypass networking (Ch. 47): the NIC doorbell register is mapped **WC**, writes to it are combined in a write-combining buffer, and you need an `sfence` to force the flush — which is why ef_vi/DPDK transmit paths contain explicit fences and why a missing one manifests as "the packet sits there until the next unrelated write flushes the buffer."

---

## 28.6 Write Allocation Policies

What happens on a store **miss**?

| Policy | Behavior | Pairs with |
|---|---|---|
| **Write-allocate** (fetch-on-write) | Read the line into cache (an **RFO**, Ch. 29 §29.10), then write into it | Write-back |
| **No-write-allocate** (write-around) | Send the store to the next level; don't cache the line | Write-through |

Mainstream x86-64 and ARM use **write-back + write-allocate**. So a store to a cold line costs a **full line read from memory**, even if you are about to overwrite all 64 bytes. That read is pure waste.

### The overwrite cost — the number to know

```cpp
memset(buf, 0, 1<<30);          // 1 GiB
```
With write-allocate this consumes **2 GiB of DRAM traffic**: 1 GiB of RFO reads plus 1 GiB of eventual writebacks. The measured bandwidth appears to be half of what the DIMMs can do, and this is the single most common reason a `memcpy`/`memset` benchmark misses the theoretical peak.

Three escapes:

**1. Non-temporal stores** (§28.14) — `movntdq`/`movntps` bypass the cache and write directly through **write-combining buffers**, eliminating the RFO. Restores full bandwidth for large, non-reused writes. `memset`/`memcpy` in glibc switch to NT stores above a size threshold (roughly the non-shared LLC size), which is why the bandwidth curve has a visible knee.

**2. Full-line write combining without NT stores.** Modern cores can detect that a full 64-byte line is being written by consecutive stores and skip the RFO. Intel calls this an optimization for `rep stosb`/`rep movsb` (ERMSB/FSRM) and for some store streams; AMD Zen does the same. This is why `rep movsb` — historically slow — is now the fastest small-to-medium `memcpy` on Ice Lake+ (Fast Short REP MOV), and why glibc dispatches to it.

**3. AVX-512 masked/full-line stores** with all lanes written can also avoid the RFO on some parts.

### The measurement

```
$ perf stat -e L1-dcache-stores,l2_rqsts.all_rfo,offcore_requests.demand_rfo,\
             longest_lat_cache.miss ./a.out
```
On Intel, `offcore_requests.demand_rfo` counts RFOs going to memory — comparing it against your intended store volume shows whether you're paying the write-allocate tax. Intel PCM (`pcm-memory`) shows actual DRAM read and write bandwidth separately; seeing read traffic roughly equal to your write volume is the smoking gun.

---

## 28.7 Cache Coherence Protocols

**Coherence** guarantees that all cores see a single, consistent value for each memory location, with writes to a location serialized. It is a *per-location* guarantee, distinct from **consistency/memory ordering**, which is about the relative order of accesses to *different* locations (Ch. 25, Ch. 29 §29.13).

### MESI and its extensions

| State | Meaning | Other caches may hold it? | Memory up to date? |
|---|---|---|---|
| **M** odified | This cache has the only copy, and it's dirty | No | **No** — must write back |
| **E** xclusive | Only copy, clean | No | Yes |
| **S** hared | Possibly multiple clean copies | Yes | Yes |
| **I** nvalid | Not present | — | — |
| **O** wned (MOESI, AMD/ARM) | Dirty, but **shared** — this cache supplies data to others without writing back to memory | Yes | No |
| **F** orward (MESIF, Intel) | One designated S copy responsible for forwarding data on a request | Yes | Yes |

**Why E exists:** a load of a line nobody else has enters **E**, so a subsequent store can transition E→M **silently, with no bus traffic**. Without E, every first store to a private line would broadcast. This is why read-then-write on private data is cheap.

**Why O exists (MOESI):** without O, a dirty line requested by another core must be written back to memory before sharing. With O, the owner supplies the data cache-to-cache and keeps the dirty copy. AMD's and ARM's use of MOESI makes producer-consumer sharing cheaper in principle; Intel's MESIF designates a forwarder to avoid multiple caches responding to the same request.

### The transitions that cost you

```
Core A: store x   →  needs M. If S or I elsewhere: send RFO (Read For Ownership),
                     INVALIDATE all other copies, wait for acks. → Ch. 29 §29.10
Core B: load x    →  A has it in M. Snoop hits modified (HITM):
                     A supplies the line cache-to-cache, downgrades M→S (or O)
```

Costs on a modern server (typical, same socket):

| Event | Latency |
|---|---|
| L1 hit, line in E or M | 4–5 cycles |
| L2 hit | ~14 cycles |
| L3 hit, uncontended | ~40–60 cycles |
| **L3 hit with HITM** (another core's L1/L2 has it dirty) | **~70–110 cycles (~25–35 ns)** |
| Cross-socket HITM | **~150–300 ns** |
| Cross-CCX (AMD) | ~100+ ns |

`HITM` is the key counter name: `mem_load_l3_hit_retired.xsnp_hitm` and `offcore_response...HITM_OTHER_CORE` on Intel. `perf c2c` is the purpose-built tool — it records HITM events with PEBS and reports **which cache line, which offsets within it, and which threads** are contending, with a per-line report distinguishing false from true sharing. Naming `perf c2c` when asked "how would you find false sharing in production?" is the expected answer.

### Directories and snoop filters

Broadcasting snoops does not scale past a handful of cores. Large servers use a **directory** (or snoop filter) tracking which cores may hold each line — on Intel, distributed with the LLC slices on the mesh; on AMD, in the Infinity Fabric coherent masters. A **snoop filter eviction** can force back-invalidation of lines still live in a core's L2, producing mysterious misses on data that "should" be cached. This is a genuine effect on large-core-count parts and a strong detail to mention.

---

## 28.8 True Sharing and Cache-Line Bouncing

**False sharing** (Ch. 26 §26.15) is *logically independent* data sharing a line. **True sharing** is genuinely shared data — a queue head, a sequence number, a lock word — and it cannot be padded away. Both produce **cache-line bouncing**: the line migrating between cores' caches under RFO/invalidate traffic.

| | False sharing | True sharing |
|---|---|---|
| Cause | Unrelated variables in one 64/128 B line | The algorithm genuinely shares one variable |
| Fix | **Padding / `alignas(64)` or 128** | Algorithm change: partition, batch, or use a different protocol |
| Detection | `perf c2c` shows different offsets in the line touched by different threads | `perf c2c` shows the **same offset** contended |
| Signature | Slowdown vanishes when you pad | Padding changes nothing |

### The cost model

An uncontended atomic RMW on a line already in M state is **~20 cycles**. A contended one where the line must be pulled from another core is **~70–110 cycles same-socket, 150–300 ns cross-socket**. With *N* cores hammering one line, throughput collapses to roughly one operation per transfer latency, and it gets *worse* with more cores because the line is stolen before any core makes progress. A shared `std::atomic<uint64_t> counter{}; counter.fetch_add(1)` across 32 cores can run at **under 10 million ops/sec total** — worse than a single thread.

### The fixes, in order of preference

1. **Don't share.** Per-core counters aggregated on read. This is the answer to metrics counters (Ch. 59 §59.3) and to allocator statistics.
2. **Batch.** Accumulate locally, publish every N operations. Turns N bounces into one.
3. **Make the sharing one-directional.** An SPSC ring buffer (Ch. 26 §26.3) with the producer's index and consumer's index on **separate lines** has each line written by exactly one core and read by the other. Read-sharing (S state) is cheap; it's the write-invalidate that costs. Putting both indices on one line is the classic bug that turns an SPSC queue into a bouncing disaster — and it's exactly the padding question interviewers ask.
4. **Reduce polling frequency.** A consumer spinning on the producer's index in a tight loop generates continuous coherence traffic. Reading a *cached local copy* of the tail and only re-reading the shared one when exhausted (the "cached index" optimization in every good SPSC queue) can double throughput.
5. **Backoff.** Exponential backoff with `pause` under contention (Ch. 24 §24.15).

### The read-mostly case

Lines read by many cores and written rarely sit in **S** (or F) everywhere and cost nothing. This is why configuration and lookup tables are free to share, and why the correct structure for read-mostly data is copy-on-write with RCU-style publication (Ch. 26 §26.14) — the readers never write, so they never invalidate.

---

## 28.9 Compulsory, Capacity, and Conflict Misses

The **3 Cs** taxonomy (Hill & Smith), plus a fourth for multicore. It exists because the *fix* is different for each.

| Class | Definition | Test | Fix |
|---|---|---|---|
| **Compulsory** (cold) | First-ever reference to the line | Occurs in an infinite fully-associative cache | Prefetch (§28.13); larger lines; better spatial layout so one fill serves more useful data |
| **Capacity** | Working set exceeds cache size | Occurs in a fully-associative cache of the real size | **Shrink the working set**: blocking/tiling, smaller data types, SoA, compression |
| **Conflict** | Too many lines map to one set | Present in the real cache but not in a fully-associative one of the same size | **Change addresses**: pad the leading dimension, offset arrays, cache coloring (§28.15) |
| **Coherence** (4th C) | Line invalidated by another core | Disappears single-threaded | Padding (false) or algorithm change (true) — §28.8 |

### Identifying which one you have

The classification is operational: run the same access pattern with progressively larger caches (or simulate). In practice:

- **Compulsory** — miss count ≈ (unique bytes touched)/64, independent of cache size. Streaming workloads are ~100% compulsory.
- **Capacity** — miss rate is a step function of the working-set size, with the knee at each cache level. The classic **cache-size sweep** benchmark (walk an array of size S with a random stride, plot ns/access vs S) reveals the entire hierarchy as a staircase, and drawing that staircase from memory is a standard interview task:

```
ns/access
   ▲
80 |                                    ┌────────  DRAM
   |                                ┌───┘
20 |                    ┌───────────┘                LLC
   |             ┌──────┘
 5 |      ┌──────┘                                   L2
 1 |──────┘                                          L1
   └──────┴──────┴──────┴────────────┴───────────►  working set
         32KB   1MB    32MB                          (log scale)
```

- **Conflict** — miss rate is wildly sensitive to *stride* and to *base address*. If adding 64 bytes of padding to a struct or array changes performance by 2×, it's conflict.

### Tooling

- `cachegrind` / `callgrind` — full simulation, exact miss classification per source line, ~50× slowdown, LRU model (so LLC numbers are approximate, §28.4).
- `perf stat -e cache-references,cache-misses,L1-dcache-load-misses,l2_rqsts.miss,LLC-load-misses`.
- `perf mem record` / `perf mem report` — PEBS-based, attributes each sampled load to the level it was serviced from (L1/L2/L3/DRAM/remote DRAM). This is the fastest way to find *which line of code* eats DRAM latency.
- `toplev.py --level 3` → `Memory_Bound` → `L1_Bound`/`L2_Bound`/`L3_Bound`/`DRAM_Bound` splits the stall time by level directly.

---

## 28.10 Cache Thrashing

**Thrashing** is repeated eviction and refetch of lines that are still needed — the working set is nominally live but never resident. It is capacity or conflict miss behavior taken to its pathological limit.

### The three flavors

**1. Conflict thrashing.** The power-of-two-stride case from §28.3. N+1 hot lines mapping to an N-way set: every access misses, forever. The tell is a 100% miss rate with a tiny working set.

**2. Capacity thrashing.** Working set slightly larger than the cache, accessed cyclically. With LRU this is the worst possible pattern — by the time you come back to a line, it was just evicted. A loop over 1.1× the L2 size can be dramatically slower than one over 0.9×. (RRIP-family policies, §28.4, mitigate this — another reason the LLC isn't LRU.)

**3. Multi-tenant / LLC thrashing.** A co-resident process (or the kernel, or a logging thread, or a `memcpy`-heavy backup) streams through memory and evicts your hot data from the shared LLC. Your latency degrades with **no change to your code**. This is the "noisy neighbor" problem, and it is the single most common cause of unexplained p99.9 regressions on shared hardware.

### Diagnosing multi-tenant LLC thrashing

Intel **CMT/MBM** (Cache Monitoring Technology / Memory Bandwidth Monitoring), part of RDT, reports per-process LLC occupancy and memory bandwidth:
```
$ pqos -m "all:0-7"          # live LLC occupancy + local/remote MBM per core
$ perf stat -e intel_cqm/llc_occupancy/ -p <pid>
```
Seeing your process's LLC occupancy collapse when a neighbor runs is conclusive. The remedy is **CAT** (Cache Allocation Technology), §28.15.

### The low-latency structural answer

Thrashing is why HFT hot paths are designed to have a working set that provably fits:

- **Order books sized to fit in L2.** A per-instrument book of a few thousand price levels at 16–32 bytes each is 100 KB or less; the hot top-of-book slice is a few hundred bytes.
- **Flat arrays indexed by dense integer IDs**, not hash maps of pointers — one cache line per lookup instead of two or three.
- **Nothing else on the isolated core**, so nothing else evicts anything (`isolcpus`, `nohz_full`, Ch. 31 §31.19).
- **`memcpy` of large buffers kept off the hot core**, or done with NT stores (§28.14) so it doesn't pollute.
- Logging, serialization, and stats aggregation moved to other cores over an SPSC queue precisely so their footprints don't touch the hot core's L1/L2.

---

## 28.11 Cache Warming

Caches are cold when a code path hasn't run recently. In a system that executes its critical path a few thousand times a second while doing millions of other things, **every critical-path execution starts cold** — and the first-touch penalty lands exactly on the message that matters.

What is cold, and what it costs:

| Cold structure | Penalty on first touch |
|---|---|
| L1d line | +250 ns if from DRAM (per line) |
| L1i / DSB | Front-end starvation for the whole path (Ch. 27 §27.15) |
| dTLB / iTLB entry | +~100–300 ns for a page walk (Ch. 32 §32.8); worse if the page-table lines themselves miss |
| Branch predictor / BTB entries | 15–20 cycles per mispredicted branch, across the whole path |
| Page not yet faulted in (first touch) | **µs to ms** — a minor fault is ~1–3 µs, a major fault is a disk I/O |
| NIC descriptor rings, DMA buffers | Miss + possibly IOMMU translation (Ch. 29 §29.23) |

Note that branch-predictor and BTB state are as real a "cache" here as the data cache, and are often the larger effect on a branchy parsing path.

### Warming techniques

**1. Prefault and lock everything at startup.**
```cpp
mlockall(MCL_CURRENT | MCL_FUTURE);   // no swapping, no lazy faults later
// touch every page of the heap/arena once
for (size_t i = 0; i < size; i += 4096) ((volatile char*)p)[i] = 0;
```
Combined with a pre-sized arena allocator (Ch. 7 §7.7) and `MAP_POPULATE`. This removes the page-fault class entirely.

**2. Synthetic warming — run the real path on fake data.** Feed a shadow order book with synthetic ticks, run the full parse→decide→encode path, and discard the output at the last possible moment (a flag checked immediately before the `send`). This warms **I-cache, D-cache, TLB, branch predictors, and the DSB** together, which is why it beats any "touch the arrays" approach. The catch — and the interview point — is that the discard branch must be *outside* the warmed path's shape, or you warm the predictor for the wrong direction and pay a mispredict on the real message. Standard technique: warm with the send present but pointed at a dead socket / a disabled TX queue, so the code executed is byte-identical.

**3. Warm on every quiet period, not just at startup.** A path idle for 100 ms is cold again. Production systems warm on a timer (e.g. every few hundred µs when idle).

**4. Keep the hot path small enough to *stay* warm.** The real fix. If the working set fits comfortably in L2 and the code fits in L1i, background activity on other cores can't evict it — provided the core is isolated.

**5. Warm the NIC path too.** Kernel-bypass TX paths (Ch. 47) have their own state: descriptor rings, doorbell pages, and the PCIe posted-write path. "Pre-arming" a TX descriptor so the hot path only writes the doorbell is a related and widely used technique.

**Measuring warm vs cold:** run the path once after a deliberate cache flush (`clflush` over the structures, or `wbinvd` in kernel) and compare to steady-state. The gap is your warming benefit. HdrHistogram (Ch. 43 §43.4) with first-message tagging shows it in production.

---

## 28.12 Hardware Prefetchers

Hardware prefetchers predict future accesses and fetch lines before demand. They are the reason sequential access is 10–20× faster than random access on the same data volume.

### The Intel complement (four, per core)

| Prefetcher | Level | Trigger | Reach |
|---|---|---|---|
| **DCU (streaming)** | L1d | Ascending sequential access | Next line |
| **DCU IP-based (stride)** | L1d | Constant stride detected per *instruction pointer* | Stride × small distance; up to ~2 KB, **within a 4 KB page** |
| **L2 streamer** | L2 | Ascending/descending streams | Up to **20 lines ahead**, multiple streams tracked |
| **L2 adjacent line (spatial)** | L2 | Any miss | Fetches the 128 B-aligned partner line |

AMD Zen has analogous stream and stride prefetchers plus a **region prefetcher**; ARM Neoverse has stride, region, and (on V2) a **temporal/pointer-chase prefetcher** that can follow indirect patterns.

### The rules they obey (and the consequences)

- **Prefetchers do not cross 4 KB page boundaries** (the L2 streamer on Intel stops at the page boundary), because crossing would require a TLB translation for an address that may not be mapped. Consequence: a sequential stream over 4 KB pages **restarts prefetch training every 4 KB**, taking a fresh demand miss at each page start. **Huge pages (2 MB) let the prefetcher run 512× further before restarting** — a real, measurable, often-overlooked benefit of THP/hugepages beyond TLB coverage (Ch. 32 §32.10).
- They detect **constant strides**, forward or backward. They do **not** follow pointers (except ARM V2's special case), so linked lists, trees, and hash tables of pointers get nothing.
- They track a limited number of concurrent streams (Intel L2: ~16–32). More streams than that and each one falls off.
- They can be **too aggressive**: prefetching data you don't use consumes bandwidth and evicts useful lines. On some Intel parts, prefetchers can be disabled per-type via MSR 0x1A4 (`wrmsr -a 0x1a4 0xf`), which is occasionally a genuine latency tuning knob for pointer-chasing workloads that get only pollution from them.

### The layout implications

```cpp
// Prefetcher-friendly: one stream, constant stride, no pointers
struct Tick { uint64_t ts; int64_t px; uint32_t qty; uint32_t flags; };
std::vector<Tick> ticks;                    // 24 B stride, sequential

// Prefetcher-hostile: pointer chase, unpredictable stride
std::map<Key, Tick*> m;                     // node per element, random addresses
```
This is the concrete mechanism behind "use flat containers" (Ch. 12 §12.7), "SoA over AoS when you touch few fields" (Ch. 42 §42.2), and "intrusive lists over `std::list`" (Ch. 21 §21.5).

**Measuring:** compare `l2_rqsts.pf_hit` / `l2_rqsts.pf_miss` (prefetch effectiveness) against `l2_rqsts.demand_data_rd_miss`. A useful ratio is *prefetched lines that were never used* — Intel exposes `l2_lines_out.useless_hwpf` on some parts, and a high value means the prefetcher is burning bandwidth for nothing.

---

## 28.13 Software Prefetching and Prefetch Distance

When the hardware prefetcher can't predict (pointer chasing, indirect indexing, hash lookups), you can issue the fetch yourself.

```cpp
#include <xmmintrin.h>
_mm_prefetch(addr, _MM_HINT_T0);   // into L1 (and all levels)
_mm_prefetch(addr, _MM_HINT_T1);   // into L2
_mm_prefetch(addr, _MM_HINT_T2);   // into L3 / LLC
_mm_prefetch(addr, _MM_HINT_NTA);  // non-temporal: minimize pollution
__builtin_prefetch(addr, rw, locality);   // GCC/Clang; rw: 0=read 1=write, locality 0-3
```
Key properties: a prefetch is a **hint**. It never faults, never traps, and is dropped if the TLB misses (on most cores) or if resources are busy. It costs a µop and an L1 lookup slot.

### Prefetch distance — the actual calculation

Issue the prefetch far enough ahead that the line arrives just in time:

```
distance (iterations) = memory_latency / cycles_per_iteration
```
For a 250-cycle DRAM latency and a loop body taking 10 cycles/iteration: **prefetch 25 iterations ahead.**

```cpp
constexpr int PD = 25;
for (size_t i = 0; i < n; ++i) {
    __builtin_prefetch(&data[index[i + PD]], 0, 1);   // indirect: HW can't do this
    process(data[index[i]]);
}
```
- **Too close** — the line hasn't arrived; you've paid a µop for nothing.
- **Too far** — the line is evicted before use, or you've filled the cache with future data and evicted present data.

The distance is workload-specific and must be **tuned empirically** — a sweep from 4 to 64 typically shows a broad optimum. Stating "you must tune it, and the formula gives you the starting point" is the expected answer.

### Where software prefetch actually wins

| Pattern | Does HW handle it? | SW prefetch worth it? |
|---|---|---|
| Sequential array scan | Yes | **No** — pure overhead |
| Constant-stride scan | Yes | No |
| Indirect/gather `a[idx[i]]` | No | **Yes**, big win |
| Hash-table probe (two-phase: compute hash for i+D, prefetch bucket) | No | **Yes** — the standard technique in high-performance hash maps |
| Linked list with a known-ahead pointer | No | Yes, if you can look ahead (e.g. `node->next->next`) |
| Binary search | No | **Yes** — prefetch both possible next probes; also the reason Eytzinger layout exists (Ch. 21 §21.8) |
| Tree traversal | No | Yes, prefetch both children |

### `prefetchw` and the RFO trick

`__builtin_prefetch(p, 1)` emits `prefetchw`, which fetches the line into **M/E state** — acquiring ownership up front. For a read-modify-write pattern (`++hist[bucket]`) this eliminates a separate RFO round trip later. It is one of the few genuinely underused instructions.

**Caveat worth stating:** software prefetch adds instructions to the front end and can *reduce* performance if the hardware prefetcher already handles the pattern, and it's brittle — it must be retuned when the loop body or the machine changes. It is a late-stage optimization, applied after layout is already right, and always measured.

---

## 28.14 Non-Temporal Stores

A **non-temporal** (streaming) store writes to memory **bypassing the cache hierarchy**, avoiding both the RFO (§28.6) and the cache pollution.

```cpp
_mm_stream_si128((__m128i*)dst, v);    // movntdq  — 16 B
_mm256_stream_si256(...);              // vmovntdq — 32 B
_mm_stream_si64(dst, v);               // movnti   — 8 B (integer)
_mm_sfence();                          // MANDATORY before making data visible
```

### The mechanism

NT stores go into a small set of **write-combining (WC) buffers** — typically 4–10 per core, each 64 bytes (Ch. 29 §29.11). When a WC buffer is fully written, it is flushed as a single 64-byte burst to memory, with no line read and no cache allocation. If the buffer is only partially filled when evicted, it must be flushed as a **partial write**, which is much less efficient and defeats the purpose.

Hence the rules:

1. **Write full 64-byte lines, sequentially.** Partial-line NT stores are a pessimization.
2. **Don't interleave many NT streams.** More concurrent streams than WC buffers causes premature partial flushes. Keep it to ~4 or fewer streams.
3. **`sfence` before the data is read by anything else** — NT stores are **weakly ordered even on x86** (they are the documented exception to TSO, Ch. 29 §29.13). Without the fence, another thread can observe the NT stores out of order relative to a subsequent flag store. This is the classic bug: the producer sets `ready = true` after NT-storing a buffer, and the consumer sees `ready` before the data.
4. **Only for data you will not read again soon.** If you're going to read it, you want it cached.

### The measured effect

| Operation, 1 GiB, single core | DRAM traffic | Typical bandwidth |
|---|---|---|
| Regular stores (write-allocate) | 2 GiB (1 RFO + 1 WB) | ~10–12 GB/s effective |
| NT stores | 1 GiB | **~18–22 GB/s effective** |

Roughly a **1.5–2× improvement** for large, write-once data — and, just as importantly, the hot working set of *other* code on the machine survives.

### Where it belongs in a trading system

- Writing large log/journal buffers (Ch. 56 §56.1) before an `fsync` or an `io_uring` submit — the data will not be re-read, and you don't want it evicting the order book.
- Zeroing or filling large arenas at startup.
- Bulk `memcpy` of market-data snapshots to a secondary process's shared-memory region.

And where it does **not** belong: anything on the hot path that will be read back, and anything small (the fence cost and partial-line risk dominate).

**`clflushopt`/`clwb`** are the complements: explicitly evict or write back a line. `clwb` (write back, keep the line valid) is the persistent-memory primitive; `clflush`/`clflushopt` are useful for benchmarking (forcing a cold cache) and for the "flush after DMA" patterns on non-coherent hardware. `clflushopt` is weakly ordered and also needs `sfence`.

---

## 28.15 Cache Coloring and Way Partitioning

Two techniques for controlling *who gets which part of the cache*, addressing conflict misses and multi-tenant interference respectively.

### Page coloring (software)

A physically-indexed cache's set index includes bits **above** the page offset. For a 2 MB 16-way L2 with 64 B lines, the index is bits [16:6]; bits [16:12] come from the **physical page number**, which software doesn't choose — the kernel does. Two virtual pages the application believes are unrelated can land on physical pages that conflict in L2/L3.

**Page coloring** is the OS-level practice of allocating physical pages so that a process's pages spread evenly across cache sets. The number of "colors" is `cache_size / (page_size × ways)`. Linux does not implement page coloring (FreeBSD historically did); the practical mitigation on Linux is **huge pages**, which make a 2 MB region contiguous in physical memory and therefore span all sets uniformly by construction. That's a second, distinct performance benefit of hugepages after TLB coverage and prefetcher reach.

Application-level coloring is what you do when you pad an array's leading dimension (§28.3) or offset successive buffers by a line: you're choosing addresses to spread across sets.

### Intel CAT — way partitioning (hardware)

**Cache Allocation Technology**, part of Intel RDT, partitions the LLC by **ways**. You define Classes of Service (CLOS), each with a bitmask of allowed ways, and assign cores or processes to a CLOS.

```
# 16-way LLC. Give the hot trading core 8 exclusive ways; everything else shares 8.
$ pqos -e "llc:1=0x00ff;llc:2=0xff00"      # CLOS1 = low 8 ways, CLOS2 = high 8
$ pqos -a "llc:1=3"                        # core 3 → CLOS1
# or via resctrl:
$ mount -t resctrl resctrl /sys/fs/resctrl
$ mkdir /sys/fs/resctrl/hotpath
$ echo "L3:0=00ff;1=00ff" > /sys/fs/resctrl/hotpath/schemata
$ echo <pid> > /sys/fs/resctrl/hotpath/tasks
```

Related RDT features: **CMT** (occupancy monitoring), **MBM** (bandwidth monitoring), **MBA** (memory bandwidth allocation — throttle a noisy neighbor's DRAM bandwidth), and **CDP** (code/data prioritization, separate masks for instructions and data).

**When CAT matters:** shared hosts where you cannot isolate physically. Reserving LLC ways for the latency-critical process removes the noisy-neighbor eviction described in §28.10. The counterintuitive part is that **giving the hot path fewer, exclusive ways often beats giving it all ways shared** — determinism beats capacity for tail latency. Measure the p99.9, not the mean.

**Caveats:** masks must be contiguous on most parts; way-granularity is coarse (a 16-way 32 MB LLC gives 2 MB per way); and CAT partitions capacity, not bandwidth — a neighbor can still saturate the memory controller, which is what MBA is for. ARM's equivalent is **MPAM** (Memory System Resource Partitioning and Monitoring), available on Neoverse.

---

## 28.16 Instruction TLB Behavior

The **TLB** caches virtual→physical translations (Ch. 32 §32.7). The **iTLB** is separate from the dTLB, smaller, and — because it's on the front-end critical path — its misses are especially damaging.

### Typical capacities (Intel Golden Cove class)

| Structure | Entries | Page size | Coverage |
|---|---|---|---|
| L1 iTLB | 256 | 4 KB | 1 MB |
| L1 iTLB | 32 | 2 MB | 64 MB |
| L1 dTLB | 96 | 4 KB | 384 KB |
| L1 dTLB | 32 | 2 MB | 64 MB |
| **L2 STLB** (shared i+d) | 2048–3072 | 4 KB / 2 MB | 8–12 MB / 4–6 GB |

An iTLB miss that also misses the STLB requires a **page walk**: up to 4 (or 5 with LA57) memory accesses through the page-table hierarchy. If those page-table lines are cached, the walk is ~20–30 cycles; if not, **it can cost hundreds of cycles**, and it stalls the front end completely — no fetch, no decode, nothing to do.

### Why this bites large C++ binaries

A monolithic trading binary with a 20–80 MB `.text` section, template-instantiated everywhere, will have a hot instruction footprint of several MB spread across many pages. **256 4 KB iTLB entries cover 1 MB.** The hot path simply cannot be iTLB-resident. Symptom: high `itlb_misses.walk_active` / `frontend_retired.itlb_miss`, front-end-bound top-down, and a benchmark that is much faster than production for identical code (because the benchmark's footprint is small).

### The fixes

**1. Huge pages for `.text`.** 2 MB pages give 32 entries × 2 MB = **64 MB of iTLB coverage** — an entire large binary, from 32 entries.
```bash
# libhugetlbfs approach (classic):
hugeedit --text ./trader                      # mark .text for huge pages
# Modern: align .text to 2 MB and let khugepaged back it with THP for file maps
$ gcc -Wl,-z,common-page-size=2097152 -Wl,-z,max-page-size=2097152 ...
$ echo always > /sys/kernel/mm/transparent_hugepage/enabled   # + CONFIG_READ_ONLY_THP_FOR_FS
```
Reported gains on large server binaries are **5–15%** — comparable to BOLT, and they stack.

**2. Shrink the hot footprint.** PGO/AutoFDO + BOLT (Ch. 40 §40.9–§40.11) cluster hot basic blocks and hot functions together, so the hot path occupies a few contiguous pages instead of being scattered. This reduces iTLB *and* L1i pressure simultaneously and is why BOLT's gains are so large on server binaries.

**3. Static linking / `-fno-plt` / prelinking.** PLT indirection (Ch. 41 §41.12) adds branch targets and pages; a statically linked binary with `-fno-plt` has a tighter, more predictable text layout.

**4. Avoid over-inlining and over-instantiation.** Template bloat (Ch. 17 §17.22) is an iTLB problem as much as a compile-time one.

### Measuring

```
$ perf stat -e itlb_misses.miss_causes_a_walk,itlb_misses.walk_active,\
             dtlb_load_misses.miss_causes_a_walk,frontend_retired.itlb_miss:pp ./a.out
$ perf record -e frontend_retired.itlb_miss:pp   # locate the offending code
```
On ARM: `ITLB_WALK`, `L1I_TLB_REFILL`, `INST_RETIRED` for normalization. A rule of thumb: iTLB walk cycles above ~2% of total cycles means huge pages for text will pay.

**A final subtlety:** TLB entries are flushed on address-space change unless tagged. x86 **PCID** tags entries with the address space, so a context switch doesn't flush the TLB — but KPTI (Ch. 27 §27.18) reintroduces flushes for the kernel/user split unless PCID is available, which is precisely why Meltdown mitigation was catastrophic on pre-Westmere CPUs and merely expensive on modern ones. On ARM, **ASIDs** do the same job.

---

## Key Interview Questions

1. **Give the latency of each cache level and DRAM.** — L1 4–5 cyc (~1.3 ns), L2 ~14 cyc (~4.5 ns), L3 ~40–60 cyc (~15–20 ns), local DRAM ~70–100 ns, remote DRAM ~120–200 ns. L1-to-DRAM is ~50–70×.
2. **Why is the cache line 64 bytes and why does it matter?** — It's the transfer and coherence unit; one byte touched costs a 64-byte fill, and two variables in one line are coherently identical, which is the whole false-sharing story.
3. **Why is `hardware_destructive_interference_size` 128 on x86 when lines are 64 bytes?** — The L2 adjacent-line prefetcher pulls the 128-byte-aligned partner, making the effective sharing granularity 128.
4. **Why does striding an array by 4096 bytes destroy L1 performance?** — L1 index bits are [11:6], so addresses congruent mod 4096 map to the same set; an 8-way set holds 8 lines and then thrashes. Fix by padding the leading dimension.
5. **Why is L1 index+offset limited to 12 bits?** — So the index comes from the page offset and lookup can proceed (VIPT) in parallel with TLB translation. It's also why L1 sizes stalled at 32–48 KB.
6. **Is the LLC LRU?** — No; it's an adaptive RRIP-family policy chosen to be scan-resistant, so a streaming pass doesn't evict the working set. `cachegrind` models LRU and is therefore approximate.
7. **Why does `memset` of 1 GiB generate 2 GiB of DRAM traffic?** — Write-allocate: each store miss reads the line (RFO) before overwriting, then writes it back. NT stores or `rep stosb` full-line detection eliminate the read.
8. **What is MESI's E state for?** — It lets a first store to a privately-held clean line go E→M silently, with no bus traffic.
9. **What does the O state in MOESI buy?** — A dirty line can be shared and supplied cache-to-cache without writing back to memory.
10. **Distinguish false from true sharing and say how you'd tell.** — `perf c2c`: different offsets in the line ⇒ false (pad it); same offset ⇒ true (change the algorithm: partition, batch, or make sharing one-directional).
11. **What does a contended atomic actually cost?** — ~20 cycles uncontended (line in M), ~70–110 cycles for a same-socket HITM transfer, 150–300 ns cross-socket. N cores on one line collapses to one op per transfer.
12. **Name the 3 Cs and the distinct fix for each.** — Compulsory (prefetch/better spatial layout), capacity (shrink the working set: tiling, SoA, smaller types), conflict (change addresses: padding, coloring). Plus coherence as the fourth.
13. **How do you tell a conflict miss from a capacity miss experimentally?** — Conflict misses are hypersensitive to stride and base address: if adding 64 bytes of padding changes performance 2×, it's conflict. Capacity shows a knee at the cache size.
14. **Why do huge pages help beyond TLB coverage?** — Hardware prefetchers stop at page boundaries, so 2 MB pages let a stream prefetch 512× further; and physical contiguity spreads sets uniformly, which is page coloring for free.
15. **When is software prefetch worth it?** — Only for patterns hardware can't learn: indirect `a[idx[i]]`, hash probes, tree/list traversal with lookahead. Distance = memory latency / cycles per iteration, then tuned empirically.
16. **What does `prefetchw` do that `prefetch` doesn't?** — Fetches into M/E state, acquiring ownership, eliminating a later RFO for read-modify-write patterns.
17. **What are the rules for non-temporal stores?** — Full 64-byte sequential lines, few concurrent streams, mandatory `sfence` before publication (NT stores are weakly ordered even on x86), and only for data not read again.
18. **How would you protect a latency-critical process from a noisy neighbor?** — Intel CAT way-partitioning via resctrl/pqos, plus MBA for bandwidth; monitor with CMT/MBM. Fewer exclusive ways often beats more shared ways for p99.9.
19. **Why do large C++ binaries suffer iTLB misses, and what's the fix?** — 256 4 KB iTLB entries cover only 1 MB while `.text` hot footprint is many MB; use 2 MB pages for text (32 entries × 2 MB = 64 MB coverage) and shrink/cluster the hot path with PGO+BOLT.
20. **What is cache warming and why isn't touching the data enough?** — A path that runs rarely starts cold in L1i, DSB, BTB, and TLBs as well as L1d; you must execute the real code path on synthetic input, with a discard as late as possible, so branch predictors and instruction caches warm too.

---

## Common Traps

- **Padding to 64 bytes on Intel and still seeing bouncing** — adjacent-line prefetch makes the effective granularity 128.
- **Power-of-two array dimensions** — guarantees set conflicts; pad the leading dimension.
- **Assuming a benchmark's cache behavior transfers to production** — production has a vastly larger footprint and cold caches.
- **Reasoning about the LLC as LRU** — it isn't; it's scan-resistant RRIP with set dueling.
- **Ignoring the write-allocate tax** — half of your "write bandwidth" can be RFO reads.
- **Non-temporal stores without `sfence`** — a genuine, hard-to-reproduce ordering bug: the consumer sees the ready flag before the data.
- **Partial-line or many-stream NT stores** — WC buffers flush partially and you lose the benefit.
- **Software prefetching a sequential scan** — pure overhead; hardware already has it.
- **Prefetch distance copied from a blog post** — it depends on your loop's cycles/iteration and must be swept.
- **Putting an SPSC queue's head and tail on the same line** — turns a wait-free queue into a bouncing contention point.
- **A consumer spinning directly on the shared producer index** — continuous invalidation traffic; cache a local copy.
- **Sharing a `std::atomic` counter across many cores for metrics** — worse than single-threaded; use per-core counters.
- **Assuming `perf`'s `LLC-load-misses` means DRAM** — on AMD the L3 is a per-CCX victim cache; cross-CCX traffic isn't DRAM but isn't cheap either.
- **Believing a co-resident process can't hurt you if you're pinned** — the LLC and memory controller are shared; you need CAT/MBA or physical isolation.
- **Forgetting that `mlockall` doesn't prefault by itself with `MCL_FUTURE` semantics you assumed** — touch every page explicitly, or use `MAP_POPULATE`.
- **Warming with a branch that only exists in warm-up mode** — trains the predictor wrong and costs you a mispredict on the real message.
- **A 20 MB `.text` with default 4 KB pages** — the iTLB cannot hold the hot path; the fix (huge text pages) is a config change, not a code change.

---

## Compact Recall Summary

**Hierarchy.** L1d 32–48 KB / 4–5 cyc; L2 1–2 MB / ~14 cyc; L3 30–100 MB shared / ~40–60 cyc; local DRAM ~70–100 ns; remote ~120–200 ns. Intel L3 is non-inclusive with a snoop filter; **AMD L3 is a per-CCX victim cache** so cross-CCX traffic costs ~100 ns. Line = 64 B (128 on Apple), and Intel's adjacent-line prefetch makes the effective sharing granularity 128 B.

**Indexing.** `sets = size/(line×ways)`; L1 index+offset ≤ 12 bits keeps lookup VIPT (overlapped with TLB), which is why L1 stalled at 32–48 KB and why **stride-4096 access maps every element to one set**. Padding the leading dimension is the standard fix. LLC replacement is adaptive RRIP, not LRU — scan-resistant by design.

**Writes.** Write-back + write-allocate everywhere: a store miss costs an **RFO read** of the line first, so `memset` of N bytes moves 2N. NT stores (`movntdq` + mandatory `sfence`, full sequential lines, few streams) or full-line detection (`rep stosb`/ERMSB) eliminate it, worth ~1.5–2×. Memory types matter: **WC** for NIC doorbells, **UC** for MMIO.

**Coherence.** MESI(F) on Intel, MOESI on AMD/ARM. E enables a silent E→M first store; O enables sharing dirty lines cache-to-cache. Costs: ~20 cyc uncontended RMW, ~70–110 cyc same-socket HITM, 150–300 ns cross-socket. `perf c2c` identifies the exact line and offsets — different offsets ⇒ false sharing (pad), same offset ⇒ true sharing (partition, batch, or make sharing one-directional; cache the peer index locally).

**Misses.** 3 Cs + coherence, each with its own fix: compulsory→prefetch/layout, capacity→shrink the working set, conflict→change addresses, coherence→pad or redesign. Diagnose with `perf mem record`, `toplev --level 3` Memory_Bound split, and a working-set sweep that draws the latency staircase. Thrashing from a noisy neighbor is measured with CMT/MBM and fixed with CAT/MBA.

**Prefetching.** HW: L1 stream + IP-stride, L2 streamer (~20 lines) + adjacent-line; **stops at 4 KB page boundaries** (hence a further benefit of huge pages) and does not follow pointers. SW prefetch pays only for indirect/hash/tree patterns; distance = memory latency ÷ cycles-per-iteration, then swept. `prefetchw` pre-acquires ownership for RMW.

**Warming and residency.** Cold means L1d, L1i, DSB, BTB, and TLBs. Prefault + `mlockall`, then warm by executing the real path on synthetic input with a byte-identical code shape. Keep the hot working set inside L2 and the hot code inside L1i, on an isolated core.

**TLB.** 256 4 KB iTLB entries = 1 MB of coverage — nowhere near a multi-MB hot `.text`. 2 MB pages give 64 MB from 32 entries; combine with PGO/BOLT clustering for 5–15% on large binaries. PCID/ASID avoid flush-on-context-switch; KPTI reintroduces the cost when PCID is unavailable.
