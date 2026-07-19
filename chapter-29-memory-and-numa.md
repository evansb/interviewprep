# Chapter 29 — Memory and NUMA

*Interview-focused revision notes. The theme: below the cache hierarchy the machine stops looking like memory and starts looking like a network — banked, queued, asynchronous, and topology-dependent — and every ordering guarantee the C++ memory model gives you is implemented by buffers and fences in this layer.*

---

## 29.1 DRAM Channels, Ranks, Banks, and Rows

DRAM is not a flat array; it is a hierarchy of parallel resources, and its performance is entirely determined by how your access pattern maps onto them.

```
CPU socket
 └─ Memory controller (2-4 per socket)
     └─ CHANNEL (independent bus, 64-bit DDR / 2×32-bit DDR5 subchannels)
         └─ DIMM
             └─ RANK (set of chips accessed together; 1-4 per DIMM)
                 └─ BANK GROUP (DDR4/5: 4-8 groups)
                     └─ BANK (4 banks/group → 16-32 banks/rank)
                         └─ ROW (~64-128 K rows, each 1-8 KB)
                             └─ COLUMN (the 64 B burst you asked for)
```

| Term | Definition | Why it matters |
|---|---|---|
| **Channel** | An independent memory bus with its own command/data path | **Parallelism and bandwidth**: 8 channels of DDR5-4800 ≈ 8 × 38.4 = **307 GB/s** per socket |
| **Rank** | A group of chips responding together to one command | Ranks share a channel's bus but can overlap internal operations; more ranks = better bank-level parallelism, slightly worse signal integrity |
| **Bank group** | DDR4/5 grouping with faster back-to-back access within vs across groups | tCCD_S (short, cross-group) < tCCD_L (long, same group) — the controller schedules to exploit this |
| **Bank** | An independent array with its own row buffer (sense amplifiers) | **Bank-level parallelism**: 32 banks per rank means 32 rows can be open simultaneously |
| **Row (page)** | 1–8 KB of cells activated together into the row buffer | Row hit vs miss is the single biggest DRAM latency variable (§29.2) |

### Address interleaving

The memory controller does **not** map physical addresses linearly to channels. It interleaves at a fine granularity — typically **256 B or 4 KB across channels** — so that a sequential scan automatically spreads across all channels and gets the full aggregate bandwidth. Bank and rank bits are similarly scattered through the address, often via an XOR hash to avoid pathological patterns.

The consequence you can be asked about: a pathological stride can land every access on **one bank**, serializing everything. If your stride matches the controller's bank-interleave period (commonly some multiple of a few KB), you get bank conflicts and effective bandwidth drops by nearly the bank count. It's the DRAM-level analogue of the cache-set conflict in Ch. 28 §28.3, and it's why huge-power-of-two strides are bad at *every* level of the hierarchy.

### Timing parameters and where latency comes from

DDR5-4800 with typical timings (`CL40-39-39`):
```
tCL  (CAS latency)      = 40 cycles @ 2400 MHz clock  ≈ 16.7 ns
tRCD (RAS-to-CAS delay) = 39 cycles                   ≈ 16.3 ns
tRP  (row precharge)    = 39 cycles                   ≈ 16.3 ns
tRAS (row active time)  ≈ 32 ns
```
- **Row buffer hit** (row already open): tCL ≈ **~17 ns** of DRAM device time
- **Row buffer empty** (no row open): tRCD + tCL ≈ **~33 ns**
- **Row buffer conflict** (wrong row open): tRP + tRCD + tCL ≈ **~49 ns**

Add controller queuing, the on-die interconnect (mesh/IF) traversal, and the LLC lookup that preceded it, and you arrive at the ~**70–100 ns** end-to-end local DRAM latency quoted in Ch. 28 §28.1. Note that **DRAM device latency has barely improved in 20 years** (~15 ns tCL in DDR2, ~14–17 ns today); only bandwidth has scaled. This is the single most important structural fact about memory and worth stating explicitly in an interview.

---

## 29.2 Row-Buffer Behavior

Each bank has one **row buffer** (a row of sense amplifiers). Reading DRAM means:

1. **ACTIVATE** the row → the entire 1–8 KB row is destructively read into the row buffer (tRCD).
2. **READ/WRITE** a column from the row buffer (tCL). Repeatable, cheaply, for any column in that row.
3. **PRECHARGE** to close the row and restore the cells before a different row can be activated (tRP).

So the row buffer is effectively a **direct-mapped, 1–8 KB cache in front of each bank**, and the three outcomes are:

| Outcome | Condition | Cost |
|---|---|---|
| **Row hit** | Requested row is open | tCL ≈ 17 ns |
| **Row empty** | No row open (closed-page policy, or just precharged) | tRCD+tCL ≈ 33 ns |
| **Row conflict** | A *different* row is open in that bank | tRP+tRCD+tCL ≈ 49 ns |

**Row-buffer locality is why sequential access is fast at the DRAM level too**, independently of prefetching and caches: an 8 KB row holds 128 cache lines, so a sequential scan gets 127 row hits per activation.

### Page policies

| Policy | Behavior | Best for |
|---|---|---|
| **Open-page** | Leave the row open after access | Sequential / high-locality workloads (row hits) |
| **Closed-page** | Precharge immediately after each access | Random workloads (turns every access into "row empty" rather than "row conflict" — cheaper on average) |
| **Adaptive** | Predict per-bank based on recent hit rate | What real controllers do |

You generally can't control this from software, but you can control locality: **structure data so that concurrent streams don't map to the same bank with different rows.** Many independent random streams (a hash table probe per core, on 32 cores) produce near-100% row conflicts and effective DRAM latency toward the 49 ns device figure plus heavy queuing — which is why *measured* random-access latency under load is often 130–200 ns rather than the quoted 70–80 ns.

### Refresh

DRAM cells leak; every row must be refreshed every **32–64 ms** (tREFI ≈ 3.9 µs between refresh commands, each blocking a rank for tRFC ≈ 350–560 ns on large DDR4/5 devices). During refresh, that rank is unavailable. On a latency-sensitive path this contributes **sub-microsecond jitter that you cannot eliminate** — a genuine, physics-level floor on tail latency, and a good answer to "what's the irreducible source of memory jitter?" Higher temperatures halve the refresh interval (doubling the rate), so a hot server has measurably worse memory tail latency. This is also the mechanism behind **Rowhammer**: repeatedly activating a row leaks charge from adjacent rows faster than refresh restores it.

---

## 29.3 Memory Controllers

The **integrated memory controller (IMC)** sits on the CPU die (since Nehalem/Opteron; before that it was in a separate northbridge, which cost ~30 ns extra) and mediates between the LLC/interconnect and the DRAM devices.

Responsibilities:

- **Address decode** — physical address → (channel, rank, bank group, bank, row, column), with interleaving/XOR hashing.
- **Scheduling** — reorder queued requests to maximize row hits and bus utilization. The standard algorithm is **FR-FCFS** (First-Ready, First-Come-First-Served): among ready requests, prefer **row hits** first, then oldest. This is a *reordering* engine, so DRAM does not service requests in program order — one more layer of reordering below the CPU's own.
- **Read/write turnaround** — the DDR bus is bidirectional; switching direction costs bus turnaround time (tWTR, tRTW). Controllers therefore **batch reads and writes**, draining a queue of writes at once. This is why a read-heavy workload sharing a controller with a write-heavy one sees latency spikes at write-drain boundaries.
- **Refresh management**, **ECC** (SECDED, or on-die ECC in DDR5), **power management** (CKE / self-refresh).

### The queuing effect — the number that surprises people

Latency under load is not the idle latency. A memory controller is a queueing system, and as utilization approaches capacity, latency rises hyperbolically:

```
latency
   ▲
   │                                  ╱
300ns                            ╱
   │                        ╱
150ns                 ╱
   │        ______╱
 80ns ──────
   └────┴────┴────┴────┴────┴────► bandwidth utilization
        20%  40%  60%  80% 100%
```
The **knee is around 60–70% utilization**. Beyond it, latency degrades severely. This is the fundamental tension in low-latency system design: **you must leave memory bandwidth headroom**, because a background process consuming 80% of DRAM bandwidth doubles or triples *your* memory latency without touching a single line you own. The curve is exactly what `Intel MLC` (Memory Latency Checker) plots:

```
$ mlc --loaded_latency          # latency vs injected bandwidth — draws this curve
$ mlc --latency_matrix          # per-NUMA-node idle latency matrix
$ mlc --bandwidth_matrix
$ pcm-memory                    # live per-channel read/write bandwidth
```
Naming MLC's `--loaded_latency` when asked "how would you show that a batch job hurts your trading process?" is a strong, concrete answer.

---

## 29.4 Memory-Level Parallelism

**MLP** is the number of independent memory requests in flight simultaneously. Because DRAM latency (~80 ns) vastly exceeds DRAM occupancy per request (~few ns of bus time), throughput is entirely determined by how many misses you can overlap.

```
effective throughput = MLP / latency
```
At 80 ns latency and MLP=1, you get **12.5 million accesses/sec** — 800 MB/s of cache lines. At MLP=10, 125 M/s and 8 GB/s. To saturate 200 GB/s you need thousands of concurrent line fetches across all cores.

### The hardware limits on MLP

| Structure | Typical | Role |
|---|---|---|
| **L1 MSHRs / fill buffers (LFBs)** | **10–16 per core** | Outstanding L1 misses. **This is the hard per-core cap.** |
| L2 outstanding requests | ~32–48 | Superset |
| Superqueue / offcore requests | 64+ | Per-core to LLC/memory |
| ROB (Ch. 27 §27.3) | 224–512 | Bounds how far ahead you can find independent misses |
| Load buffer | 72–192 | Outstanding loads |

With ~12 LFBs and 80 ns latency, a single core tops out around **12 × 64 B / 80 ns ≈ 9.6 GB/s** for demand misses — which is why **a single core cannot saturate a modern server's memory bandwidth** (you need 8–20 cores). That figure ("one core gets about 10 GB/s; the socket has 200+") is a favorite interview number.

### The pointer-chasing catastrophe

```cpp
while (p) { sum += p->value; p = p->next; }    // MLP = 1
```
Each load's *address* depends on the previous load's *result*. No amount of ROB, LFB, or prefetch capacity helps: the accesses are serialized by a data dependence. Runtime = N × latency. For 1 M nodes at 80 ns: **80 ms**, versus ~3 ms for a sequential array scan of the same data. This ~25× ratio is the entire quantitative argument for flat containers.

### Creating MLP

1. **Sequential access** — the prefetcher generates MLP for free.
2. **Multiple independent streams** — process several arrays or several list heads at once:
```cpp
// Traverse K lists in lockstep: MLP = K
for (int k = 0; k < K; ++k) p[k] = heads[k];
while (any_alive) for (int k = 0; k < K; ++k) if (p[k]) { s[k] += p[k]->v; p[k] = p[k]->next; }
```
3. **Software prefetch of indirect accesses** (Ch. 28 §28.13) — a prefetch is a non-blocking miss, so it directly raises MLP.
4. **Batching**: gather all the keys first, prefetch all their buckets, then process. This "batched, prefetched hash probe" pattern converts MLP=1 into MLP=batch_size and is worth 3–10× on hash-heavy workloads.

**Measuring MLP:** `l1d_pend_miss.pending / l1d_pend_miss.pending_cycles` on Intel gives average outstanding L1 misses. Values near 1 mean a dependence chain; values near 10+ mean you're saturating the LFBs.

---

## 29.5 Memory Bandwidth and Latency

Two independent axes, and workloads are bound by one or the other.

| Metric | Typical modern 2-socket x86-64 server |
|---|---|
| Per-channel bandwidth | DDR4-3200: 25.6 GB/s; DDR5-4800: 38.4 GB/s |
| Channels per socket | 6 (older Xeon) / 8 (SPR, Zen 4) / 12 (Zen 5, Granite Rapids) |
| **Per-socket peak** | **150–460 GB/s** |
| Achievable (STREAM Triad) | ~70–85% of peak |
| **Single-core achievable** | **~8–15 GB/s** (LFB-limited, §29.4) |
| Local DRAM latency (idle) | 70–100 ns |
| Local DRAM latency (loaded, 70%) | 150–300 ns |
| Remote NUMA latency | 120–200 ns idle |
| L3 latency | 15–20 ns |

*(ARM: Neoverse V2 platforms are comparable per-channel; Apple M-series uses very wide LPDDR — M2 Ultra ~800 GB/s — with somewhat higher latency ~100–110 ns.)*

### Little's Law applied to memory

```
concurrency = bandwidth × latency
```
To sustain 200 GB/s at 80 ns latency you need 200e9 × 80e-9 = **16,000 bytes in flight = 250 cache lines outstanding**. With 12 LFBs per core, that's ~21 cores minimum. This calculation is the rigorous form of "one core can't saturate memory," and producing it on demand is a strong signal.

### Measuring

```
$ ./stream                                  # classic Copy/Scale/Add/Triad
$ mlc --bandwidth_matrix --latency_matrix   # per-node, both metrics
$ likwid-bench -t load -w S0:1GB:8          # controlled kernels, per-socket
$ likwid-perfctr -g MEM ./a.out             # DRAM read/write bandwidth via IMC counters
$ pcm-memory 1                              # live per-channel utilisation
$ perf stat -e uncore_imc/data_reads/,uncore_imc/data_writes/ ./a.out
```
Note that DRAM bandwidth counters live in the **uncore/IMC**, not the core PMU, so they are per-socket and cannot be attributed to a process by the core PMU alone. MBM (Ch. 28 §28.15) is the per-process alternative.

### Bandwidth-bound vs latency-bound — the diagnostic

| Symptom | Bandwidth-bound | Latency-bound |
|---|---|---|
| Scaling with more threads | Flattens hard at N cores | Scales nearly linearly |
| DRAM counters | Near peak | Far below peak |
| MLP (`l1d_pend_miss.pending`) | High (10+) | ~1–2 |
| Fix | Reduce bytes moved: compression, SoA, smaller types, blocking, NT stores | Increase MLP: prefetch, batch, restructure to remove dependence chains |

Confusing these leads to the classic wasted effort: adding threads to a bandwidth-bound kernel (no gain) or compressing data in a latency-bound one (no gain, plus CPU cost).

---

## 29.6 Load-Store Queues

The core's memory execution unit maintains queues tracking in-flight memory operations, enforcing dependences that can't be resolved at rename because addresses aren't known yet.

| Structure | Alt. names | Holds | Size (Golden Cove) |
|---|---|---|---|
| **Load buffer / load queue** | LQ, MOB-load | Every in-flight load, from allocation to retirement | 192 |
| **Store buffer / store queue** | SQ, STLB (store-to-load buffer) | Every in-flight store: address + data, until retirement **and** drain | 114 |
| **Fill buffers / MSHRs** | LFB | Outstanding cache-line fills | 10–16 |
| **Write-combining buffers** | WCB | NT stores and WC-memory writes | 4–10 (often the LFBs, repurposed) |

The load and store queues exist because a store's address may not be computed when a later load issues. The core must:
- Check every issuing load against **older stores with matching addresses** → forward the data (§29.9).
- Check every completing store against **younger loads that already executed** → if one read the location before the store, that load was wrong: **machine clear / replay** (§29.8).

This is an associative search over up to a hundred entries every cycle in both directions, and it is one of the most power-hungry structures in the core.

### Exhaustion signatures

| Full structure | Counter (Intel) | Meaning |
|---|---|---|
| Store buffer | `resource_stalls.sb` | Stores retiring faster than they drain — often an uncached/WC region, an unaligned store stream, or many fences |
| Load buffer | `resource_stalls.lb` (older) / RAT stalls | Very miss-heavy load stream |
| Fill buffers | `l1d_pend_miss.fb_full` | **You've hit the MLP ceiling** (§29.4) — the machine literally cannot have more misses outstanding |

`l1d_pend_miss.fb_full` being high is a precise, unambiguous statement that you are memory-parallelism-limited, and it's the counter to name when asked how you'd prove it.

### Loads and stores are asymmetric

- **Loads are speculative and can be replayed.** They execute as early as possible.
- **Stores cannot be undone**, so a store's data is held in the store buffer and written to L1 only **after retirement**. This is what makes the store buffer *the* structure implementing the memory model (§29.7, §29.13).

---

## 29.7 Store Buffers

The **store buffer** decouples the core's store issue rate from the cache's write rate. Every store, on every mainstream architecture, goes:

```
execute → store buffer (address + data)
        → [retire: now architecturally committed but still not visible to other cores]
        → drain to L1d (requires the line in M/E — may need an RFO, §29.10)
        → visible to other cores
```

### Why it exists

Without it, a store missing in L1 would stall the core for the full RFO latency (up to ~250 ns). With it, the store retires immediately and the RFO proceeds in the background. In store-heavy code this is worth an order of magnitude.

### Why it is the memory model

The store buffer is the **only** reason x86-TSO is not sequential consistency. Consider Dekker's/store-buffer litmus test (Ch. 25 §25.19):

```
Thread 1:            Thread 2:
x = 1;               y = 1;
r1 = y;              r2 = x;

Result r1 == 0 && r2 == 0 is ALLOWED on x86.
```
Both stores sit in their respective store buffers; both loads bypass them and read the old value from cache. **StoreLoad reordering** is the one reordering x86 permits, and it is exactly the store buffer being drained lazily. The fix is `mfence` (or a `lock`-prefixed instruction), which drains the store buffer before the load is allowed to execute — costing **~30–40 cycles** on a modern core.

This is why `std::atomic<T>::store(std::memory_order_seq_cst)` on x86 compiles to `xchg` (or `mov` + `mfence`): seq_cst requires draining. `memory_order_release` stores compile to a **plain `mov`** with no fence, because the store buffer is FIFO and preserves StoreStore order for free. That asymmetry — **release stores are free on x86, seq_cst stores cost ~30–40 cycles** — is one of the highest-value facts in this chapter.

### Draining and its hazards

- **Retired but undrained stores are unrecoverable** — the core must drain them; it cannot roll back. So a full store buffer stalls retirement (`resource_stalls.sb`).
- **Uncacheable (UC) stores** drain one at a time, synchronously, at MMIO speed (hundreds of ns each). A hot loop writing UC MMIO registers will pin the store buffer full. This is precisely why NIC drivers map doorbells **WC**, not UC (Ch. 28 §28.5, §29.11).
- **`sfence`/`mfence` in a loop** serializes drains and destroys store throughput.
- **The store buffer is per-core and not visible to other cores**, which is why store-to-load forwarding (§29.9) works within a core but a peer core must wait for the drain.

---

## 29.8 Memory Disambiguation

The problem: a load issues while an **older store's address is still unknown**. Two choices:

- **Conservative**: block the load until all older store addresses resolve. Safe, and disastrous for performance — a single unresolved store address stalls all later loads.
- **Speculative**: predict the load does *not* alias any older unknown store, execute it, and verify later.

All modern cores speculate, guided by a **memory disambiguation predictor** (Intel has had one since Core 2). It learns per-load-PC whether that load has historically conflicted with older stores.

### The verification and its cost

When the older store's address resolves and it turns out to alias a younger load that already executed, the core must recover: on Intel this is a **memory-ordering/disambiguation machine clear** (`machine_clears.disambiguation`), costing ~20–40 cycles, or a load replay. The observable pattern is a hot loop with `machine_clears.*` in the millions/sec.

### 4 K aliasing — the false-positive that bites everyone

The disambiguation check is done on **partial addresses** (bits [11:0]) for speed, because full physical addresses aren't available until translation completes. So a load and an older store whose addresses match in the low 12 bits but differ in the page number are **falsely predicted to conflict**, forcing a stall of ~5 cycles per occurrence.

```cpp
void copy(char* dst, const char* src, size_t n) {
    for (size_t i = 0; i < n; ++i) dst[i] = src[i];
}
copy(buf + 4096, buf, N);     // dst and src differ by EXACTLY 4096
                              // → every load falsely conflicts with the previous store
```
Counter: `ld_blocks_partial.address_alias`. Fix: offset one buffer by a cache line (or any non-multiple of 4096), or use vectorized copies that reduce the store count. This is a real, reproducible effect and a great "explain this benchmark anomaly" question — two buffers separated by exactly a page runs measurably slower than the same buffers separated by 4160 bytes.

### The compiler-level analogue

`__restrict` (Ch. 40 §40.7) tells the *compiler* that pointers don't alias, allowing it to hoist loads above stores at compile time. Hardware disambiguation solves the runtime version of the same problem. Both matter; neither substitutes for the other. Without `__restrict` the compiler emits a runtime overlap check with duplicated vector/scalar loop bodies — recognizing that pattern in generated assembly is a good thing to mention (Ch. 3 §3.8).

---

## 29.9 Store-to-Load Forwarding

When a load's address matches a **retired-or-not, still-in-store-buffer** older store, the core can supply the data directly from the store buffer rather than waiting for it to reach L1. This is **store-to-load forwarding (STLF)**, and it is essential: without it, every `x = 1; y = x;` pair would cost a full L1 round trip after drain.

**Successful forwarding latency: ~5 cycles** (roughly L1-hit latency; on some cores slightly more). **Failed forwarding: the load must wait for the store to drain to L1 and then read it — ~12–20 extra cycles.**

### When forwarding fails

Forwarding requires the load to be **fully contained** within a single store, and usually **same size and alignment**. It fails when:

| Situation | Forwards? |
|---|---|
| Store 8 B at addr, load 8 B at addr | ✅ Yes |
| Store 8 B at addr, load 4 B at addr (contained, aligned) | ✅ Usually yes |
| Store 4 B at addr, **load 8 B at addr** (load is larger) | ❌ **No** — stall |
| Two 4 B stores, one 8 B load covering both | ❌ **No** — a load can only forward from *one* store |
| Store 8 B at addr, load 4 B at addr+4 (offset) | ⚠️ Modern cores yes, older no |
| Store crosses a cache line, load overlaps | ❌ No |
| NT store → load | ❌ No |

Counter: `ld_blocks.store_forward` on Intel.

### The classic C++ failure

```cpp
union U { float f; uint32_t i; };
U u; u.f = x;
uint32_t bits = u.i;              // store 4 B as float, load 4 B as int — same size: OK
                                  // BUT: also crosses int/FP domains (Ch. 27 §27.14)

// The real killer — type punning across sizes:
struct Msg { uint32_t a, b; };
Msg m; m.a = 1; m.b = 2;
uint64_t both = *reinterpret_cast<uint64_t*>(&m);   // two 4B stores, one 8B load
                                                     // → STLF FAILURE, ~15 cycle stall
```
Serializer/deserializer code that writes fields individually and then reads the whole message as a block hits this constantly. So does a small `std::string`/SSO buffer written byte-by-byte then read as a word. `std::bit_cast` doesn't help — it's the *store widths* that matter, not the cast.

**Fixes:** write and read at the same granularity; or build the value in a register and store once; or introduce enough distance between the store and the load that the store has drained (which the OoO window may do for you anyway).

A related low-latency case: an SPSC ring buffer where the producer writes a payload field-by-field and the consumer reads it as a wide vector. Because they're on **different cores**, forwarding isn't involved at all — the consumer waits for coherence, not forwarding. Knowing that STLF is strictly intra-core is a precise distinction interviewers probe.

---

## 29.10 Read For Ownership

To write a cache line, a core must hold it in **M** or **E** state (Ch. 28 §28.7). If it holds it in **S** or not at all, it issues a **Read For Ownership (RFO)**: a request that both fetches the data *and* invalidates every other copy, waiting for invalidation acknowledgements.

```
Core 0: store to X (line in S, also in cores 1,2,3)
   → RFO on the interconnect
   → directory/snoop filter sends INVALIDATE to cores 1,2,3
   → cores 1,2,3 respond INVALID-ACK (and one supplies data if it had it in M/O)
   → Core 0 receives data, transitions to M, store drains from the store buffer
```

### Costs

| Case | Cost |
|---|---|
| Line already in M or E | ~0 extra (silent) |
| Line in S in this core, S elsewhere | Invalidate-only ("upgrade"), ~40–80 cycles |
| Line in another core's M (HITM), same socket | ~70–110 cycles (~25–35 ns) |
| Line in another socket | 150–300 ns |
| Line not cached anywhere | Full DRAM latency, ~80 ns |

**RFO is the hidden cost of every write**, and it explains several things at once:

1. **Write-allocate's 2× traffic** (Ch. 28 §28.6) — the RFO is a full line read even when you overwrite all 64 bytes.
2. **Why false sharing hurts so much** — each write on each core RFOs the line away from the other, so the line ping-pongs, with a full invalidation round trip per write.
3. **Why read-mostly shared data is free** — S-state copies coexist; no RFO occurs until someone writes.
4. **Why `fetch_add` on a contended counter is ~100× slower than an uncontended one.**

### Avoiding RFOs

- **Non-temporal stores** (Ch. 28 §28.14) — write through WC buffers, no ownership acquired, no invalidation of *your own* caches. (Coherence is still maintained; the WC flush invalidates other copies, but no line is read.)
- **`prefetchw` / `__builtin_prefetch(p, 1)`** — start the RFO early so it overlaps with other work. Genuinely useful in histogram/counter-update loops.
- **Full-line write detection** (`rep stosb`/ERMSB, some AVX-512 stores) — hardware skips the read when it knows the whole line is overwritten.
- **Don't share the line.** Per-core data (Ch. 28 §28.8).

---

## 29.11 Write Combining

**Write combining** merges multiple small writes to the same 64-byte region into one bus transaction, in a dedicated **write-combining buffer** (4–10 per core, 64 B each).

It applies to:
- Memory explicitly typed **WC** by the PAT/MTRRs (framebuffers, PCIe BARs, NIC doorbell pages).
- **Non-temporal stores** to normal WB memory (`movntdq` etc., Ch. 28 §28.14).

### Semantics — the part that matters

WC memory is **weakly ordered**, and this is the documented exception to x86-TSO:
- Writes may be **combined and reordered** among themselves.
- They become visible only when the buffer is **flushed**: when full, on `sfence`/`mfence`/`lock`, on a serializing instruction, on a context switch, or when the buffer is needed for another region.

Consequences you must be able to state:

```cpp
// Kernel-bypass TX doorbell, WC-mapped BAR:
write_descriptor(ring, pkt);      // WB memory
_mm_sfence();                     // ensure descriptor is visible to the NIC BEFORE the doorbell
*doorbell = producer_index;       // WC store
_mm_sfence();                     // FLUSH the WC buffer — otherwise the write may sit
                                  // in the buffer indefinitely and the packet never goes out
```
The failure mode of a missing final `sfence` is spectacular and confusing: **the packet is transmitted only when some unrelated later write happens to flush the buffer**, producing latency that depends on subsequent activity. This is a real class of bug in DPDK/ef_vi-style code and a fine war story to have.

### Efficiency rules

- **Write full 64-byte lines, sequentially.** A partially-filled buffer flushes as multiple partial writes and loses most of the benefit — with PCIe MMIO, a partial flush can turn one TLP into several, which is dramatically worse.
- **Limit concurrent WC streams to ≲ the buffer count** (4). More streams evict each other prematurely.
- Don't read from WC memory — WC reads are uncached and slow (hundreds of ns), and a read forces a flush.

### Why doorbells are WC, not UC

A **UC** store is uncached, un-combined, and strongly ordered: each one is a separate PCIe transaction with full serialization, hundreds of nanoseconds, and it blocks the store buffer. A **WC** store is buffered and can be combined; a 64-byte descriptor written as four 16-byte WC stores becomes a **single 64-byte PCIe write**, which is both faster and (on many NICs) required for the "write the whole descriptor in one TLP" fast path. Understanding that the mapping type is a first-class performance decision is exactly what a kernel-bypass interview is looking for.

---

## 29.12 Split-Line and Split-Page Accesses

An access that **straddles a boundary** requires two lookups and two transactions.

| Straddle | Cost |
|---|---|
| Within a cache line (aligned or not) | **Free** on modern x86 — the L1 handles unaligned access within a line at full speed |
| **Split cache line** (crosses a 64 B boundary) | Two L1 accesses; ~**2× latency**, half throughput. Counter: `ld_blocks.no_sr`, `misalign_mem_ref.loads` |
| **Split 4 K page** | Two TLB lookups plus possibly two page walks. Historically ~**100+ cycles**; Skylake+ reduced it to ~5–10 cycles for loads, but stores and older cores are still costly |
| **Split line with an atomic RMW** | **SPLIT LOCK** — see below |
| Unaligned SIMD (`movups` on aligned data) | Free on Nehalem+ if not split; only the *split* costs |

### Split locks — the whole-machine stall

An atomic read-modify-write (`lock xadd`, `lock cmpxchg`, `xchg`) whose operand crosses a cache line cannot be made atomic by the normal mechanism (holding the line in M state). The CPU falls back to asserting a **bus lock**, which on modern systems means **serializing the entire coherence fabric — stalling every core on the socket** for the duration.

Measured cost: **~1,000 cycles for the issuing core and tens of microseconds of aggregate disruption**; a loop doing split-locked atomics can degrade an entire machine's throughput by 10× or more. It is one of very few things a userspace process can do to hurt every other process on the box.

Linux has detection and mitigation:
```bash
# Kernel cmdline / runtime:
split_lock_detect=warn      # log the offender (dmesg: "split lock detected")
split_lock_detect=fatal     # SIGBUS the offender
split_lock_detect=ratelimit:N  # throttle the process
$ dmesg | grep -i "split lock"
$ perf stat -e sq_misc.split_lock ./a.out        # Intel counter
```
The C++ rule that prevents it: **`std::atomic<T>` is always naturally aligned by the implementation** (`alignof(std::atomic<T>) >= sizeof(T)` for lock-free sizes) — so you only get split locks by defeating it: packed structs (`#pragma pack`), atomics inside `__attribute__((packed))` types, `std::atomic_ref` on a misaligned member, hand-rolled `lock cmpxchg` inline asm, or an atomic in a wire-format struct parsed in place (Ch. 3 §3.12). ARM avoids the whole category: unaligned exclusive/atomic instructions simply **fault**.

### Practical guidance

- Assert alignment on anything atomic: `static_assert(alignof(T) >= sizeof(T))`.
- For 16-byte atomics (`cmpxchg16b`), require 16-byte alignment explicitly — a tagged pointer pair (Ch. 26 §26.11) misaligned to 8 is a split lock on every operation.
- In parsers, `memcpy` fields out rather than taking references into a packed buffer (Ch. 3 §3.12).

---

## 29.13 x86 TSO

**x86-TSO (Total Store Order)** is the memory model of x86-64. Stated precisely:

| Reordering | Allowed on x86? |
|---|---|
| Load → Load | **No** |
| Load → Store | **No** |
| Store → Store | **No** |
| **Store → Load** | **YES** (the only one) |
| Loads/stores to the *same* address | Never reordered (coherence) |

Plus: **stores are not visible to other cores before they are visible to the issuing core** (a core sees its own stores early, via store-to-load forwarding), and there is a **total order on all stores** that all cores agree on — hence "total store order." Independent stores by different cores appear in one global order; this is what makes IRIW (independent reads of independent writes) impossible on x86.

Exceptions to TSO: **non-temporal stores**, **WC memory**, and `movnt`-family instructions (§29.11), plus `clflushopt`. These require explicit `sfence`.

### The mapping to C++ atomics on x86-64

| C++ operation | x86-64 codegen | Cost |
|---|---|---|
| `load(relaxed / acquire / seq_cst)` | plain `mov` | **Free** — all loads are acquire on x86 |
| `store(relaxed / release)` | plain `mov` | **Free** — the store buffer is FIFO |
| `store(seq_cst)` | `xchg` (or `mov`+`mfence`) | **~30–40 cycles** — must drain the store buffer |
| `fetch_add`, `exchange`, `compare_exchange` (any order) | `lock`-prefixed | **~20 cycles** uncontended; RMW is always fully ordered on x86 |
| `atomic_thread_fence(acquire/release)` | nothing (compiler barrier only) | Free |
| `atomic_thread_fence(seq_cst)` | `mfence` | ~30–40 cycles |

**The two consequences that matter:**

1. **Acquire/release costs nothing on x86 beyond a compiler barrier.** Code that "works" with `relaxed` on x86 may be broken on ARM. Never validate memory-ordering correctness on x86 alone — use TSan, run on ARM, or model-check (Ch. 57 §57.11).
2. **seq_cst stores are the one genuinely expensive default.** Changing a hot `store(seq_cst)` to `store(release)` is a real, measurable win (~30 cycles per store) and one of the highest-yield atomics optimizations on x86.

---

## 29.14 Weak Hardware Memory Ordering

**ARM (AArch64), POWER, and RISC-V** are weakly ordered: essentially *any* pair of accesses to *different* addresses may be reordered by hardware unless a barrier or an ordered instruction forbids it.

| Reordering | x86-TSO | ARMv8 | POWER |
|---|---|---|---|
| Load → Load | No | **Yes** | **Yes** |
| Load → Store | No | **Yes** | **Yes** |
| Store → Store | No | **Yes** | **Yes** |
| Store → Load | Yes | **Yes** | **Yes** |
| IRIW (non-multi-copy-atomic) | Impossible | ARMv8 is **other-multi-copy-atomic** (so IRIW is forbidden) | **Possible** — POWER is not multi-copy-atomic |

**Multi-copy atomicity** is the property that a store becomes visible to all other cores at the same instant. x86 has it; ARMv8 has "other-multi-copy-atomicity" (all *other* cores see it simultaneously, though the issuing core sees it earlier); POWER does not, which is why POWER needs `sync` where ARM needs only `dmb ish` and why the C++ memory model's `seq_cst` is expensive on POWER.

### ARM's ordered load/store instructions

ARMv8 provides acquire/release *semantics on the instruction itself*, which is cheaper than a separate barrier:

```asm
ldar  x0, [x1]     ; load-acquire   — no later access moves before it
stlr  x0, [x1]     ; store-release  — no earlier access moves after it
ldaxr / stlxr      ; exclusive (LL/SC) load-acquire / store-release
casal x0, x1, [x2] ; ARMv8.1 LSE compare-and-swap, acquire+release
ldadd / ldaddal    ; ARMv8.1 LSE atomic add (far better under contention than LL/SC)
```
**ARMv8.1 LSE atomics matter enormously**: the older LL/SC (`ldxr`/`stxr`) loop can livelock under contention and requires a retry loop, while LSE atomics are single instructions executed *at the point of coherence* (potentially in the interconnect/LLC), giving far better scaling. Compile with `-march=armv8.1-a` or `-moutline-atomics` (which dispatches at runtime) — a real, commonly-missed performance flag on ARM servers.

### Practical consequences for portable C++

```cpp
std::atomic<Node*> head;
// Publication:
node->data = 42;
head.store(node, std::memory_order_release);    // x86: plain str. ARM: stlr.
// Consumption:
Node* n = head.load(std::memory_order_acquire); // x86: plain ldr. ARM: ldar.
int v = n->data;                                 // ARM: WITHOUT acquire, this load
                                                 // may be reordered BEFORE the head load
```
On x86 the `relaxed` version of this is accidentally correct. On ARM it is genuinely broken — you can read a null/garbage `data` through a valid pointer. **The single most common real-world weak-memory bug is a missing acquire on the consumer side of a publication**, and it is invisible on x86.

Cost comparison (approximate, ARM Neoverse): `ldar`/`stlr` ~ a few cycles more than plain; `dmb ish` (full barrier) ~10–20 cycles; `dmb ishld` (load barrier) cheaper. Relative to x86's ~30–40-cycle `mfence`, ARM barriers are cheaper individually but you need more of them.

---

## 29.15 Hardware Memory Barriers

A **barrier/fence** constrains the order in which memory operations become visible. Distinguish sharply from a **compiler barrier** (`asm volatile("" ::: "memory")`, `std::atomic_signal_fence`), which constrains only the compiler and emits no instructions.

### x86-64

| Instruction | Orders | Cost | Use |
|---|---|---|---|
| `mfence` | All loads and stores (full barrier) | **~30–40 cycles** | seq_cst fence; drain the store buffer |
| `sfence` | Stores only (StoreStore) | ~5–10 cycles | **Only** needed for NT stores / WC memory; a no-op for normal WB stores |
| `lfence` | Loads only (LoadLoad); also **serializes instruction execution** | ~5–20 cycles | Rarely needed for ordering; used for `rdtsc` serialization (Ch. 43 §43.12) and Spectre-v1 mitigation |
| `lock`-prefixed op | Full barrier as a side effect | ~20 cycles | **Cheaper than `mfence`** — `lock add $0, (%rsp)` is a well-known faster full fence, used by the Linux kernel and some libstdc++ paths |
| `xchg` | Implicitly locked, full barrier | ~20 cycles | How seq_cst stores are emitted |

The "`lock add $0,(%rsp)` is cheaper than `mfence`" fact is a favorite: it does the same store-buffer drain but avoids `mfence`'s additional serialization against non-temporal operations, and it touches a line certain to be in M state (the top of your own stack).

### ARM/AArch64

| Instruction | Orders |
|---|---|
| `dmb ish` | Full barrier, inner-shareable domain |
| `dmb ishld` | Load-load and load-store (acquire-ish) |
| `dmb ishst` | Store-store (release-ish) |
| `dsb` | Data synchronization barrier — also waits for completion (used for TLB/cache maintenance, not for normal ordering) |
| `isb` | Instruction synchronization barrier — flushes the pipeline; needed after modifying system registers or code |

`ldar`/`stlr` (§29.14) are preferred over explicit `dmb` because they're cheaper and more precise.

### The C++ mapping (Ch. 25 §25.14)

```cpp
std::atomic_thread_fence(std::memory_order_acquire);  // x86: nothing. ARM: dmb ishld.
std::atomic_thread_fence(std::memory_order_release);  // x86: nothing. ARM: dmb ish.
std::atomic_thread_fence(std::memory_order_seq_cst);  // x86: mfence. ARM: dmb ish.
std::atomic_signal_fence(std::memory_order_seq_cst);  // NOTHING anywhere — compiler only
```

**`volatile` is not a barrier** (Ch. 25 §25.21). It prevents the *compiler* from eliding or reordering accesses to the volatile object relative to each other, but emits no fence and constrains the *hardware* not at all. Using `volatile` for inter-thread communication is a data race and is broken on ARM. It remains correct for MMIO (where the memory type provides the ordering) and for `sig_atomic_t` with signal handlers.

---

## 29.16 Locked Instructions and Atomic Operations

An **atomic read-modify-write** must make the read and write indivisible with respect to other cores. On x86, the `lock` prefix does this.

### The mechanism

The modern implementation is **not** a bus lock. The core:
1. Acquires the line in **M** state (RFO, §29.10).
2. **Holds the line** — refuses to respond to snoops for it — for the duration of the RMW.
3. Completes the read-modify-write.
4. Releases.

Bus locking is only used when the operand **crosses a cache line** (§29.12, split lock) or targets uncacheable memory.

### Costs

| Operation | Uncontended (line in M) | Contended (HITM, same socket) | Cross-socket |
|---|---|---|---|
| `lock xadd` / `lock inc` | **~20 cycles** | ~70–110 cycles | 150–300 ns |
| `lock cmpxchg` (success) | ~20 cycles | ~70–110 cycles | 150–300 ns |
| `lock cmpxchg` (fail, retry loop) | ~20 cycles/attempt | Worse — livelock-prone | Worse |
| `xchg` (implicitly locked) | ~20 cycles | Same | Same |
| `cmpxchg16b` | ~25–30 cycles | Worse | Worse |
| Uncontended `pthread_mutex` lock+unlock | ~20–40 cycles (two atomics, no syscall) | — | — |
| Contended mutex → futex syscall | **~1–3 µs** (syscall + context switch) | — | — |

The last row is the important contrast: an *uncontended* mutex is just two atomic operations, ~10 ns. A *contended* one costs a syscall and a context switch, 1000× more. This is the entire justification for spin-then-park (Ch. 24 §24.15) and for lock-free designs on the hot path.

### `lock` implies a full barrier

Every `lock`-prefixed instruction is a full memory barrier on x86 — which is why all `std::atomic` RMW operations, regardless of the requested memory order, cost the same on x86. `fetch_add(1, relaxed)` and `fetch_add(1, seq_cst)` generate **identical code**. This surprises people who expect `relaxed` to be cheaper; on x86 relaxed only helps by permitting *compiler* reorderings. On ARM with LSE, `ldadd` vs `ldaddal` genuinely differ.

### CAS loop pathology

```cpp
while (!head.compare_exchange_weak(expected, desired, std::memory_order_release,
                                                      std::memory_order_relaxed)) { }
```
Under contention, every attempt RFOs the line away from other cores. With N threads, the line ping-pongs N times per successful update and throughput *decreases* with more threads. Mitigations: exponential backoff with `pause`, read the value with a plain load before attempting the CAS (avoid RFO when the CAS would obviously fail — the "test and test-and-set" pattern), reduce contention structurally, or use `fetch_add`-style operations that always succeed. Note also that `compare_exchange_weak` may fail **spuriously** on LL/SC architectures (ARM/POWER) — that's why the weak form exists and why it must always be in a loop (Ch. 25 §25.6).

---

## 29.17 NUMA Topology

**NUMA** (Non-Uniform Memory Access): memory attached to one socket (or one die/CCX) is faster for that socket's cores than memory attached to another.

```
┌────────── Socket 0 ──────────┐   UPI/IF   ┌────────── Socket 1 ──────────┐
│ cores 0-31   LLC   IMC ──DRAM│◄──────────►│DRAM── IMC   LLC   cores 32-63│
│              PCIe ──NIC0     │  ~30-40    │     NIC1── PCIe              │
└──────────────────────────────┘   GB/s     └──────────────────────────────┘
   local: ~80 ns                                remote: ~140 ns
```

| Access | Latency | Bandwidth |
|---|---|---|
| Local DRAM | ~80 ns | Full (e.g. 200 GB/s) |
| Remote DRAM (1 hop) | **~130–200 ns (1.6–2.2×)** | Interconnect-limited (~30–60 GB/s) |
| Remote LLC (HITM) | ~150–300 ns | — |

### Sub-NUMA clustering and chiplets

Modern parts are NUMA *within* a socket:
- **Intel SNC** (Sub-NUMA Clustering) splits a socket's mesh + LLC + memory controllers into 2–4 NUMA nodes, reducing average on-die latency by shortening mesh hops. Enabling SNC and pinning correctly is a real ~10–15% memory-latency win; enabling it *without* pinning makes things worse.
- **AMD NPS** (Nodes Per Socket) 1/2/4 does the same for Zen's chiplet layout, and **CCX/CCD boundaries** matter independently: cross-CCD traffic goes over Infinity Fabric even within one NUMA node (Ch. 28 §28.1).

### Inspecting topology

```
$ numactl --hardware
node distances:      # 10 = local, 21 = one hop (relative, not ns)
node   0   1
  0:  10  21
  1:  21  10
$ lscpu -e                                  # CPU → node/socket/core/cache mapping
$ numastat -m                               # per-node memory usage, numa_miss/numa_foreign
$ lstopo                                     # hwloc: full topology incl. PCIe device locality
$ cat /sys/class/net/eth0/device/numa_node   # which node the NIC is on
$ mlc --latency_matrix                       # actual measured ns, not the SLIT distances
```
The `node distances` are firmware-declared **relative** values from the ACPI SLIT table — not nanoseconds and not always accurate. Always measure with MLC.

### The counters that reveal a problem

`numastat` reports `numa_miss` (allocations that went to a non-preferred node) and `numa_foreign` (allocations on this node preferred elsewhere). Nonzero and growing means your memory policy is failing. On Intel, `offcore_response` with a remote-DRAM mask, or the simpler `perf mem report` which labels samples "Remote RAM."

---

## 29.18 First-Touch Allocation

**Linux allocates physical pages on first *write* (or first touch), not on `malloc`/`mmap`.** `mmap` creates a VMA; the physical page is allocated by the page-fault handler, on the node of the **CPU that touched it first**, under the default `MPOL_DEFAULT` (local) policy.

This is the single most consequential NUMA fact for application programmers.

### The canonical bug

```cpp
// Thread 0 (main) allocates and initializes everything:
auto* data = static_cast<double*>(malloc(N * sizeof(double)));
for (size_t i = 0; i < N; ++i) data[i] = 0.0;      // ALL pages land on node 0

#pragma omp parallel for
for (size_t i = 0; i < N; ++i) data[i] = f(data[i]);  // half the threads run on node 1
                                                      // → 100% remote access, ~2× slower
```
The fix is **parallel first touch**: initialize with the same parallel decomposition used later, so each thread faults in its own pages locally.

```cpp
#pragma omp parallel for
for (size_t i = 0; i < N; ++i) data[i] = 0.0;      // each thread touches its own range
```

### Explicit control

```cpp
// Process-level:
$ numactl --cpunodebind=0 --membind=0 ./trader
$ numactl --interleave=all ./throughput_job          // spread for bandwidth, not latency

// Programmatic:
#include <numa.h>
numa_set_preferred(0);
void* p = numa_alloc_onnode(size, 0);
// or POSIX-ish:
mbind(addr, len, MPOL_BIND, &nodemask, maxnode, MPOL_MF_MOVE | MPOL_MF_STRICT);
set_mempolicy(MPOL_BIND, &nodemask, maxnode);
move_pages(0, count, pages, nodes, status, MPOL_MF_MOVE);   // migrate after the fact
```

### Interaction with allocators and huge pages

- A general-purpose allocator (Ch. 7 §7.12) recycles freed memory across threads, so a block freed by a node-0 thread can be handed to a node-1 thread — **silently remote forever**. Per-NUMA-node arenas are the fix; jemalloc and tcmalloc have per-CPU/per-arena support, and the low-latency answer is a **per-thread arena allocated and first-touched by that thread at startup** (Ch. 8 §8.6).
- **`MAP_POPULATE`** or explicit prefaulting at startup makes first touch happen deterministically, at a controlled time, on the right thread — combining NUMA placement with page-fault elimination (Ch. 28 §28.11).
- **Transparent huge pages** interact badly: a 2 MB THP is allocated on one node, so a 2 MB region touched by threads on two nodes is entirely local to one of them. `khugepaged` collapsing pages later can also *move* data. For latency-critical regions, prefer explicit hugetlbfs pages with an explicit policy (Ch. 32 §32.10).

---

## 29.19 Remote-Memory Access

What actually happens on a remote access:

```
core (node 0) → L1 → L2 → LLC(node 0) miss
              → home agent / directory determines the line's home node
              → UPI/Infinity Fabric to node 1
              → node 1's LLC lookup (may hit! that's a remote-LLC hit)
              → node 1's IMC → DRAM
              → data returns over the interconnect
```

| Path | Typical latency |
|---|---|
| Local LLC hit | 15–20 ns |
| Local DRAM | ~80 ns |
| **Remote LLC hit** | ~100–150 ns |
| **Remote DRAM** | ~130–200 ns |
| Remote HITM (dirty in a remote core) | **200–350 ns** |

The **remote HITM** case is the worst and the most commonly overlooked: a cache line actively written by threads on both sockets costs 200–350 ns per transfer. A single shared atomic counter touched from both sockets can cap a whole application's throughput at ~3–5 M ops/sec.

### Bandwidth asymmetry

Interconnect bandwidth is a fraction of local memory bandwidth: UPI at ~20–24 GT/s gives roughly **30–50 GB/s per link**, versus 200–400 GB/s local. So a workload whose memory is entirely remote is not merely 2× slower in latency — it may be **5–8× worse in bandwidth**, and the interconnect becomes a global bottleneck affecting everyone on the machine.

### Design rules for latency-critical systems

1. **Pin threads and memory to the same node** (`numactl --cpunodebind=N --membind=N`), and verify with `numastat -p <pid>`.
2. **Put the NIC, its interrupt affinity, its DMA buffers, and the handling thread all on the same node** (§29.21).
3. **Never let a hot shared structure span nodes.** Replicate read-mostly data per node rather than sharing it.
4. **Disable automatic NUMA balancing** for latency-critical processes (`kernel.numa_balancing=0`) — it migrates pages at unpredictable times, causing TLB shootdowns and multi-microsecond stalls (Ch. 32 §32.27).
5. **Consider single-socket machines.** Many HFT deployments deliberately use one high-core-count socket, or leave the second socket entirely idle, because eliminating the NUMA dimension eliminates a whole class of tail-latency variance. Stating that as an architectural choice — not just a tuning tweak — reads very well.

---

## 29.20 CPU Interconnects

| Interconnect | Vendor / era | Topology | Bandwidth |
|---|---|---|---|
| **QPI** (QuickPath) | Intel, Nehalem–Broadwell | Point-to-point, ring on-die | ~9.6 GT/s, ~25 GB/s/link |
| **UPI** (Ultra Path) | Intel, Skylake-SP+ | Point-to-point; **mesh** on-die | 10.4–24 GT/s, ~30–50 GB/s/link; 2–4 links/socket |
| **Infinity Fabric** | AMD, Zen | Chiplet-based; IOD hub + CCDs | ~50–100 GB/s; **also the intra-socket CCD fabric** |
| **CCIX / CXL** | Cross-vendor | Over PHY | CXL 2.0/3.0 for coherent device/memory attach |
| **AMBA CHI** | ARM (Neoverse) | Mesh (CMN-700) | Vendor-configurable |
| **NVLink / Infinity Fabric (GPU)** | NVIDIA/AMD | GPU-GPU/CPU | 300–900 GB/s |

### On-die topology matters too

Intel moved from a **ring** (up to Broadwell: simple, low-latency for small core counts, but latency grows linearly and the ring saturates past ~12 cores) to a **2D mesh** (Skylake-SP onward: scales to 40+ cores, but adds hops — LLC latency became ~50–60 cycles and *variable* depending on which LLC slice holds your line). That variability is a real source of latency dispersion: two cores accessing the same LLC slice have different latencies depending on mesh distance. SNC (§29.17) exists to bound it.

AMD's chiplet design means an LLC access can be: **within the CCX** (fast, ~40 cycles), **to another CCD** (over Infinity Fabric via the IO die, ~100+ ns), or remote-socket. There is no "another core's L3" that is cheap on AMD — the L3 is per-CCX.

### CXL — the coming thing

**CXL** (Compute Express Link) rides on PCIe PHY and adds cache-coherent protocols (CXL.cache, CXL.mem) so accelerators and *memory expanders* can be coherently attached. CXL-attached memory is a **new, slower NUMA tier at ~170–400 ns**, appearing to Linux as a memory-only NUMA node. It's relevant to the interview mainly as: "the NUMA hierarchy is getting deeper, and tiered-memory policies (`demotion`, `NUMA` tiering in recent kernels) are how the kernel manages it." Nothing latency-critical should live on CXL memory.

---

## 29.21 Thread, Memory, and NIC NUMA Locality

The synthesis. A packet's journey through a badly-configured 2-socket box crosses the interconnect three times:

```
NIC (PCIe on node 0) ──DMA──► RX buffer allocated on node 1   ← cross #1
IRQ delivered to a core on node 1, but the poll thread runs on node 0 ← cross #2
Order book / arena allocated on node 1, hot thread on node 0  ← cross #3
```
Each crossing adds 50–120 ns and interconnect bandwidth. The correctly-configured version has **everything on one node**:

```bash
# 1. Which node is the NIC on?
$ cat /sys/class/net/eth0/device/numa_node
0
$ lstopo                                 # visual confirmation of PCIe locality

# 2. Pin IRQs for the NIC's queues to cores on that node
$ cat /proc/interrupts | grep eth0
$ echo 4 > /proc/irq/<N>/smp_affinity_list      # core 4, node 0
#   (stop irqbalance first, or it will undo this: systemctl stop irqbalance)

# 3. Pin the application thread and its memory to node 0
$ numactl --cpunodebind=0 --membind=0 ./trader
#   plus sched_setaffinity to a specific isolated core (Ch. 31 §31.17)

# 4. Ring buffers / DMA memory allocated by a thread already pinned to node 0
#    (first touch, §29.18) — and huge-page-backed (Ch. 32 §32.10)

# 5. Verify
$ numastat -p $(pgrep trader)            # expect ~all pages on node 0
$ perf mem report                         # expect no "Remote RAM" samples
```

### The subtleties worth stating

- **PCIe slot choice is a latency decision.** A NIC in a slot wired to socket 1 while your process runs on socket 0 costs an interconnect traversal on **every packet**, in both directions. In colocated deployments the slot assignment is checked at build time.
- **RSS/RFS queue-to-core mapping** (Ch. 46 §46.12–§46.14) must place each queue's interrupt and its consuming thread on the same node *and* ideally the same core.
- **DDIO writes into the LLC of the socket the NIC is attached to** (§29.24) — so a remote thread reading that data takes a remote LLC hit (~100–150 ns) instead of a local one (~20 ns). This makes NIC-node affinity matter *more* on DDIO-enabled systems, not less.
- **Interrupt coalescing and busy-polling** interact: a busy-polling thread (Ch. 47 §47.11) reading the RX ring directly must be on the NIC's node, or every descriptor poll is a remote read.
- **The single-socket answer.** If everything must be on node 0 anyway, the second socket is only a liability. Many production HFT boxes are single-socket high-frequency parts for exactly this reason.

---

## 29.22 PCIe and DMA

**PCIe** is a serial, packet-switched, point-to-point interconnect. Devices are reached through a root complex; transactions are **TLPs** (Transaction Layer Packets).

| Generation | Per-lane | x8 | x16 |
|---|---|---|---|
| PCIe 3.0 | ~985 MB/s | ~7.9 GB/s | ~15.8 GB/s |
| PCIe 4.0 | ~1.97 GB/s | ~15.8 GB/s | ~31.5 GB/s |
| PCIe 5.0 | ~3.94 GB/s | ~31.5 GB/s | ~63 GB/s |

**Latency, which is what matters here:** a PCIe round trip (CPU → device → CPU) is **~500 ns to 2 µs**; a one-way DMA write from device to host memory/LLC is **~300–800 ns**. This is an order of magnitude above DRAM latency and is a hard floor on any NIC interaction.

### Posted vs non-posted — the critical distinction

| Type | Waits for completion? | Latency | Examples |
|---|---|---|---|
| **Posted write** | **No** — fire and forget | ~100–300 ns to issue | MMIO write (doorbell), device→host DMA write |
| **Non-posted read** | **Yes** — requires a completion TLP | **~500 ns – 2 µs round trip** | **MMIO read**, device→host DMA read |

**An MMIO read is catastrophically expensive.** A driver polling a device register in a loop pays a microsecond per poll and stalls the core (the load can't retire). This is why every well-designed fast-path driver **never reads device registers on the hot path**; instead the device **DMA-writes a completion/status into host memory**, and the CPU polls host memory (a cache hit or an L3/DDIO hit, tens of ns). Recognizing "poll host memory, never MMIO" as the fundamental fast-path rule is a strong kernel-bypass answer (Ch. 47 §47.13).

### DMA

**Direct Memory Access**: the device reads/writes host memory without CPU involvement.

- **Coherent DMA** on x86: DMA writes snoop the caches, so no software cache maintenance is needed. On many ARM SoCs DMA is **non-coherent** and drivers must `dma_sync_*`/`clean`/`invalidate` cache lines explicitly — a genuine portability difference.
- **Descriptor rings** (Ch. 46 §46.3): the driver writes descriptors (address + length) into a ring in host memory, then rings the doorbell (a WC MMIO posted write, §29.11). The device DMA-reads the descriptors, DMA-writes the packet data, and DMA-writes a completion. The CPU polls the completion in host memory.
- **Ordering**: PCIe guarantees that posted writes to the same path complete in order, which is what makes "write descriptor, then write doorbell" safe — provided the CPU-side stores were ordered by an `sfence` first (§29.11).

### Latency budget context

```
NIC wire→host DMA complete            ~300-800 ns
CPU notices (poll host memory)        ~20-100 ns
Parse + decide (hot path)             ~200-1000 ns
Write TX descriptor + doorbell        ~100-300 ns (posted)
NIC reads descriptor + DMA payload    ~300-800 ns
NIC serializes onto the wire (Ch.39)  ~80 ns for a 100B frame at 10 GbE
```
Total tick-to-trade for a software path is therefore ~1–5 µs, of which **PCIe is often the largest single component** — which is the entire commercial case for FPGA NICs (Ch. 48 §48.1–§48.2), where the decision is made on the NIC and PCIe is never crossed.

---

## 29.23 IOMMU

The **IOMMU** (Intel VT-d, AMD-Vi, ARM SMMU) is an MMU for devices: it translates **device (I/O virtual) addresses** to physical addresses and enforces access permissions.

Purposes:
1. **Protection** — a buggy or malicious device (or a driver bug) cannot DMA over arbitrary physical memory. Without an IOMMU, any device with bus-master capability owns the machine (the Thunderbolt/FireWire DMA-attack class).
2. **Virtualization** — a VM can be given direct device access (PCI passthrough / SR-IOV VFs) with the IOMMU mapping guest-physical to host-physical.
3. **Addressing** — lets a 32-bit-capable device reach memory above 4 GB without bounce buffers.

### The performance cost — the part interviews care about

Every DMA access must be translated, which means an **IOTLB** lookup and, on a miss, an I/O page-table walk. The costs:

| Effect | Impact |
|---|---|
| IOTLB hit | Small, tens of ns, usually hidden in PCIe latency |
| **IOTLB miss → I/O page walk** | **hundreds of ns**, added to every affected DMA |
| **Map/unmap on every I/O** (strict mode) | Expensive: page-table updates + **IOTLB invalidation**, which is a device round trip. This is the big one for high-PPS workloads |
| IOTLB size | Small (tens to a few hundred entries) — easily thrashed by many scattered DMA buffers |

Linux modes:
```bash
intel_iommu=on iommu=pt            # passthrough: identity-map trusted devices → near-zero cost
iommu.strict=0                     # lazy/deferred invalidation: batch IOTLB flushes
                                   #   (faster, but a freed buffer stays DMA-accessible briefly)
intel_iommu=off                    # fully disabled
$ dmesg | grep -i -e DMAR -e IOMMU
```

**`iommu=pt` (passthrough)** is the standard low-latency setting: the IOMMU stays enabled for devices that need it (VMs) but host-owned devices get an identity mapping, removing per-DMA translation cost while retaining the ability to isolate anything you explicitly want isolated. Fully disabling the IOMMU is faster still but forfeits all protection and breaks VFIO/DPDK's safe modes.

**DPDK specifics** (Ch. 47 §47.2): DPDK uses **VFIO** (which requires an IOMMU) or the legacy, unsafe `igb_uio`/`uio_pci_generic`. With VFIO, DPDK maps its huge-page pool into the IOMMU **once at startup**, so there is no per-packet map/unmap and the IOTLB is well-behaved — **huge pages here also mean fewer IOTLB entries**, which is a second, distinct reason DPDK mandates them. That link — hugepages → IOTLB coverage → sustained PPS — is precisely the kind of connected reasoning that distinguishes candidates.

---

## 29.24 Intel DDIO

**Data Direct I/O** lets a PCIe device DMA **directly into the LLC** rather than into DRAM, and read from the LLC directly. Enabled by default on Xeon E5/Scalable and later; AMD's analogue is **SDCI** on recent EPYC, and ARM has **Cache Stashing** in CMN interconnects.

### Why it matters

Without DDIO:
```
NIC DMA writes packet → DRAM  (~300-800 ns PCIe + DRAM write)
CPU reads packet → L1 miss → L2 miss → L3 miss → DRAM read (~80 ns)
```
With DDIO:
```
NIC DMA writes packet → LLC directly (allocates in LLC)
CPU reads packet → L3 hit (~15-20 ns)
```
**Saves ~60–80 ns per packet on receive** and, crucially, eliminates DRAM bandwidth for the packet's round trip. On transmit, the NIC can read the descriptor and payload from the LLC without a DRAM access.

### The constraints and the failure mode

- **DDIO uses a limited number of LLC ways** — historically **2 of 20** (~10% of the LLC) for I/O writes. If your RX ring plus buffer pool exceeds that allocation, the packets are written to LLC, immediately evicted before the CPU reads them, and you get the DRAM path anyway *plus* the eviction traffic.
- **"DDIO thrashing"** is the resulting pathology: at high packet rates with large ring buffers, DDIO's benefit inverts and it actively pollutes the LLC. The fix is **smaller RX rings and buffer pools** so the working set fits DDIO's ways — a counterintuitive tuning direction ("make the ring smaller to go faster") that is exactly the kind of thing an interviewer probes. Intel exposes the DDIO way allocation through an MSR (`IIO LLC WAYS`, 0xC8B) on some parts, adjustable via RDT-adjacent tooling.
- **DDIO is socket-local.** The NIC writes into the LLC of the socket it is attached to. A consumer thread on the other socket takes a **remote LLC hit (~100–150 ns)** instead of a local one (~20 ns) — so DDIO makes NIC-node affinity (§29.21) *more* important, not less.
- **DDIO interacts with kernel bypass**: DPDK/ef_vi ring sizing, mbuf pool sizing, and burst size all determine whether the hot buffers stay within DDIO's ways. Typical guidance is rings of 512–1024 descriptors rather than 4096, and reusing a small pool of buffers so the same lines stay resident.

**Measuring:** Intel PCM's `pcm-iio` and `pcm.x` report DDIO hit/miss rates (the "IIO" section shows inbound writes hitting or missing the LLC). A rising DDIO miss rate as packet rate increases is the thrashing signature.

---

## Key Interview Questions

1. **Why hasn't DRAM latency improved in 20 years while bandwidth has 10×'d?** — Device timings (tCL/tRCD/tRP) are set by cell physics and sense-amp behavior at ~15 ns each; bandwidth scales by widening and clocking the interface and adding channels.
2. **Explain row hit, row empty, and row conflict with numbers.** — ~17 ns (tCL), ~33 ns (tRCD+tCL), ~49 ns (tRP+tRCD+tCL). Sequential access gets ~127 row hits per 8 KB row activation.
3. **Why does memory latency get worse when another process uses bandwidth?** — The memory controller is a queueing system; latency knees upward past ~60–70% utilization. Demonstrate with `mlc --loaded_latency`.
4. **Why can't one core saturate a server's memory bandwidth?** — ~10–16 LFBs cap outstanding misses; 12 lines × 64 B / 80 ns ≈ 10 GB/s per core. By Little's Law, 200 GB/s at 80 ns needs 250 lines in flight ≈ 20+ cores.
5. **Why is linked-list traversal ~25× slower than an array scan of the same data?** — MLP = 1: each address depends on the previous load's result, so runtime is N × full latency with no overlap and no prefetching possible.
6. **What is the store buffer and why is it the memory model?** — It holds retired-but-not-visible stores; its lazy drain is exactly the StoreLoad reordering that x86-TSO permits, and `mfence` exists to drain it.
7. **Why is a release store free on x86 but a seq_cst store ~30–40 cycles?** — The store buffer is FIFO (StoreStore preserved for free), but seq_cst forbids StoreLoad reordering, requiring a drain via `xchg`/`mfence`.
8. **What is 4 K aliasing?** — Disambiguation compares only address bits [11:0], so a load and an older store exactly 4096 bytes apart falsely conflict, ~5 cycles each. Offset one buffer by a line.
9. **When does store-to-load forwarding fail, and what does it cost?** — When the load isn't fully contained in one store (larger load, two stores covering it, line-crossing); ~12–20 extra cycles. Classic case: write two `uint32_t`s, read one `uint64_t`.
10. **What is an RFO and why does it make writes expensive?** — Read For Ownership: fetch the line *and* invalidate all other copies before writing. It causes write-allocate's 2× traffic and is the mechanism of false-sharing ping-pong.
11. **Why are NIC doorbells mapped write-combining rather than uncacheable?** — UC stores are serialized, hundreds of ns each, and block the store buffer; WC buffers combine a 64 B descriptor write into one PCIe TLP. The price is weak ordering — you need `sfence` before *and* after.
12. **What is a split lock and why is it catastrophic?** — An atomic RMW crossing a cache line falls back to a bus lock that stalls every core on the socket; ~1000 cycles locally and machine-wide disruption. Detect with `split_lock_detect` and `sq_misc.split_lock`; prevent with natural alignment.
13. **State x86-TSO precisely.** — Only Store→Load may be reordered; there is a total order on stores; NT stores and WC memory are the exceptions.
14. **What breaks when you port x86-validated lock-free code to ARM?** — Load→Load and Store→Store reordering become possible; a missing acquire on the consumer side of a publication reads garbage through a valid pointer. Validate with TSan or on real ARM, never on x86 alone.
15. **Why is `lock add $0,(%rsp)` used instead of `mfence`?** — It performs the same store-buffer drain with less serialization overhead and touches a line certain to be in M state; measurably cheaper.
16. **On x86, is `fetch_add(relaxed)` cheaper than `fetch_add(seq_cst)`?** — No — identical code; every `lock`-prefixed op is a full barrier. Relaxed only relaxes the *compiler*. On ARM with LSE (`ldadd` vs `ldaddal`) they genuinely differ.
17. **What is first-touch allocation and what's the classic bug?** — Pages are placed on the node of the first toucher; initializing an array single-threaded then processing it in parallel makes half the accesses remote. Fix: parallel first touch with the same decomposition.
18. **How much does a remote NUMA access cost?** — ~130–200 ns vs ~80 ns local (1.6–2.2×), remote HITM 200–350 ns, and interconnect bandwidth is 5–8× below local.
19. **Why is `perf mem report` useful for NUMA?** — It labels each sampled load with where it was serviced from, including "Remote RAM" — direct evidence of misplacement.
20. **Why is an MMIO read so expensive, and what's the fast-path alternative?** — It's a non-posted PCIe transaction: 500 ns–2 µs round trip that stalls the core. The device should DMA a completion into host memory and the CPU should poll that instead.
21. **What does the IOMMU cost and what is `iommu=pt`?** — IOTLB misses cause I/O page walks (hundreds of ns); strict-mode map/unmap per I/O adds invalidation round trips. `iommu=pt` identity-maps host devices, retaining isolation where needed at near-zero cost. DPDK maps its hugepage pool once at startup for the same reason.
22. **What is DDIO and how can it hurt?** — NIC DMA lands directly in the LLC (~15–20 ns for the CPU instead of ~80 ns), but it's limited to ~2 of 20 ways; oversized RX rings thrash it, so *smaller* rings can be faster. It's also socket-local, making NIC-node affinity more important.
23. **Describe the fully NUMA-correct packet path.** — NIC's node determined from sysfs; IRQ affinity to a core on that node with irqbalance off; thread pinned to an isolated core on that node; buffers first-touched by that thread on huge pages; verified with `numastat -p` and `perf mem report`.
24. **What's the irreducible source of DRAM jitter?** — Refresh: every rank is unavailable for tRFC (~350–560 ns) every ~3.9 µs, and the rate doubles at high temperature.

---

## Common Traps

- **Assuming DRAM latency is a constant** — it's ~17/33/49 ns of device time depending on row state, plus queueing that explodes past 70% bandwidth utilization.
- **Benchmarking memory latency on an idle machine** and planning capacity from it.
- **Adding threads to a bandwidth-bound kernel** or compressing data in a latency-bound one — diagnose with MLP (`l1d_pend_miss.pending`) and DRAM counters first.
- **Believing prefetch fixes pointer chasing** — the address isn't known until the previous load returns.
- **Two buffers exactly 4096 bytes apart** — 4 K aliasing on every access.
- **Writing a struct field-by-field and reading it as a wide word** — store-to-load forwarding failure, ~15 cycles.
- **Assuming `volatile` orders memory** — it emits no fence and is broken on ARM.
- **Validating lock-free code only on x86** — acquire/release are free there, so missing barriers are invisible.
- **Expecting `relaxed` RMW to be cheaper on x86** — every `lock` op is a full barrier.
- **Atomics inside packed structs or `atomic_ref` on a misaligned member** — split lock, whole-socket stall.
- **16-byte atomics (tagged pointers) not 16-byte aligned** — split lock on every operation.
- **NT stores or WC doorbell writes without `sfence`** — data published before it's visible, or a doorbell that never rings until unrelated activity flushes the buffer.
- **Reading from WC or UC memory on the hot path** — hundreds of ns, and it forces a buffer flush.
- **Polling an MMIO register in a loop** — microseconds per poll; poll host memory instead.
- **Single-threaded initialization of data processed in parallel** — everything lands on one NUMA node.
- **A general-purpose allocator recycling memory across NUMA nodes** — silently remote forever; use per-thread/per-node arenas first-touched at startup.
- **Leaving `numa_balancing` on for a latency-critical process** — unpredictable page migration and TLB shootdowns.
- **Ignoring which socket the NIC is plugged into** — an interconnect crossing on every packet, in both directions.
- **Letting `irqbalance` run** — it silently undoes your IRQ affinity.
- **Oversizing RX rings "for safety"** — DDIO thrashing; the packets are evicted from LLC before you read them.
- **Trusting ACPI SLIT `node distances` as nanoseconds** — they're relative firmware values; measure with MLC.
- **Assuming DMA is coherent** — it is on x86, frequently not on ARM SoCs.

---

## Compact Recall Summary

**DRAM.** Channel → rank → bank group → bank → row. Device latency is tCL ≈ 17 ns (row hit), +tRCD (row empty, 33 ns), +tRP (row conflict, 49 ns) — **essentially unchanged in 20 years**; only bandwidth scaled (8–12 channels, 150–460 GB/s/socket). Controllers reorder with FR-FCFS, batch read/write turnarounds, and refresh every rank for ~350–560 ns every ~3.9 µs (irreducible jitter, worse when hot). **Latency knees upward past ~60–70% bandwidth utilization** — `mlc --loaded_latency` draws the curve.

**MLP.** Throughput = MLP / latency. Per-core MLP is capped by **10–16 fill buffers** → ~10 GB/s per core; Little's Law says 200 GB/s at 80 ns needs 250 lines in flight, i.e. 20+ cores. Pointer chasing is MLP=1 and therefore ~25× slower than a scan. Create MLP with sequential access, multiple streams, batched software prefetch. `l1d_pend_miss.fb_full` proves the ceiling.

**Core memory queues.** Load buffer (~192) and store buffer (~114) track in-flight accesses. Stores drain to L1 **only after retirement** — the store buffer *is* the memory model. Disambiguation speculates that loads don't alias unresolved older stores; 4 K aliasing is its false-positive. Store-to-load forwarding is ~5 cycles when the load is fully contained in one store, ~12–20 extra when not.

**Writes.** Every write needs the line in M/E → **RFO** (fetch + invalidate all copies), which causes write-allocate's 2× traffic and false-sharing ping-pong. Avoid with NT stores, `prefetchw`, full-line writes, or not sharing. **Write combining** (WC memory / NT stores) is weakly ordered even on x86 and needs `sfence`; it's why NIC doorbells are WC, not UC.

**Ordering.** x86-TSO permits **only Store→Load** reordering and is multi-copy-atomic. Therefore acquire loads and release stores are plain `mov`s (free), seq_cst stores cost ~30–40 cycles, and every `lock` op is a full barrier at ~20 cycles uncontended. ARM/POWER reorder everything; use `ldar`/`stlr` and prefer **ARMv8.1 LSE atomics** (`-moutline-atomics`) over LL/SC. A missing consumer-side acquire is invisible on x86 and fatal on ARM. Split locks (atomic crossing a line) fall back to a bus lock and stall the whole socket — ~1000 cycles plus machine-wide disruption.

**NUMA.** Local ~80 ns, remote ~130–200 ns, remote HITM 200–350 ns, interconnect bandwidth 5–8× below local; sub-NUMA (SNC/NPS) and AMD CCX boundaries create NUMA *inside* a socket. **First touch** places pages, so parallel initialization is mandatory and recycling allocators silently strand memory remotely. Pin thread + memory + NIC + IRQ to one node, disable `numa_balancing` and `irqbalance`, verify with `numastat -p` and `perf mem report`. Many HFT boxes are single-socket precisely to delete this dimension.

**I/O.** PCIe posted writes are ~100–300 ns; **non-posted MMIO reads are 500 ns–2 µs** — never poll a device register, poll a DMA-written completion in host memory. IOMMU adds IOTLB misses and, in strict mode, per-I/O map/unmap invalidations; `iommu=pt` plus a once-mapped hugepage pool (DPDK/VFIO) is the low-latency configuration. **DDIO** DMAs into the LLC (~15–20 ns instead of ~80 ns) but uses only ~2 of 20 ways, is socket-local, and thrashes with oversized rings — smaller RX rings can be measurably faster.
