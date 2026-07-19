# Chapter 30 — Latency Reference

*Interview-focused revision notes. The theme: every number in this chapter is the visible output of a mechanism described in Ch. 27–29 — you should be able to derive it, not recite it, and you should know which hardware or kernel decision moves it.*

---

## Conventions used throughout

Unless stated otherwise, figures are **typical modern x86-64 Linux server** values: an Intel Skylake-SP-through-Sapphire-Rapids or AMD Zen 3/4 core at a **~3 GHz sustained all-core clock**, 64-byte cache lines, DDR4-3200 or DDR5-4800 memory, a recent (5.x/6.x) kernel with default Spectre/Meltdown mitigations enabled. At 3 GHz, **1 cycle ≈ 0.33 ns** and **1 ns ≈ 3 cycles** — that conversion is the single most useful thing to have memorized, because hardware documentation quotes cycles and latency budgets are quoted in nanoseconds.

Two units matter and they degrade differently:

- **Cycles** are the right unit for anything inside the core (ALU latency, branch mispredict, L1/L2 hit). These are nearly frequency-invariant: the pipeline depth doesn't change when the clock changes.
- **Nanoseconds** are the right unit for anything off-core (DRAM, interconnect, PCIe, network). These are nearly *cycle*-variant: DRAM latency is set by the DIMM and the memory controller, so raising the clock raises the *cycle* cost of a memory access without changing the nanosecond cost.

That asymmetry is why "L3 miss costs 200 cycles" and "L3 miss costs 70 ns" are both correct and neither is portable across frequencies. State which unit you're using.

---

## 30.1 CPU and Memory Latency Numbers

### The core hierarchy

| Operation | Cycles | ns @3 GHz | Mechanism (Ch.) |
|---|---|---|---|
| Register-to-register ALU op (add, and, shift) | 1 | 0.33 | Ch. 27 §27.13 |
| Simple ALU with 3-4 ops in flight | 0.25 (throughput) | 0.08 | 4-wide superscalar |
| L1d hit, simple addressing | 4 | 1.3 | Ch. 28 §28.1 |
| L1d hit, complex/indexed addressing | 5–6 | ~1.7 | AGU penalty |
| L2 hit | 12–16 | 4–5 | |
| L3 hit, same-socket (server mesh/CCX) | 40–75 | 15–25 | Higher on mesh than on client ring |
| DRAM, local socket, unloaded | 200–260 | 70–90 | Ch. 29 §29.5 |
| DRAM, local socket, ~80% loaded | 400–900 | 130–300 | Queueing, not physics |
| DRAM, remote NUMA socket | 320–450 | 110–150 | 1.4–2.0× local |
| Cache line from another core's L1/L2, same socket (HITM) | 120–220 | 40–75 | Coherence transfer, Ch. 28 §28.7 |
| Cache line from another socket (HITM cross-socket) | 550–900 | 180–300 | UPI/xGMI hop |

**Deriving DRAM latency instead of memorizing it.** A local DRAM read is roughly: L1+L2+L3 lookup miss chain (~20 ns) + memory controller queue + DRAM device timing. On a row-buffer *hit* the DRAM device contributes tCL only (~14 ns at DDR4-3200 CL22 → 13.75 ns); a row *miss* costs tRP+tRCD+tCL (~42 ns); a row-buffer *conflict* on a busy bank costs more. Add the on-die mesh traversal to the home agent and back (~15–25 ns) and you land at 70–90 ns. This is why DRAM latency has barely improved in fifteen years while bandwidth has grown 10× — the bank timings are electrically bound, only the channel count scales.

### Control flow, arithmetic, and address translation

| Operation | Cycles | ns | Notes |
|---|---|---|---|
| Correctly predicted, not-taken branch | 0 (extra) | 0 | Free; folded in the front end |
| Correctly predicted taken branch | 1–2 | ~0.5 | BTB hit |
| **Branch misprediction** | **15–20** | **5–7** | Pipeline flush + refill; Ch. 27 §27.11 |
| Mispredict with cold I-cache refill | 30–60 | 10–20 | Front-end starvation dominates |
| Integer multiply (64-bit) | 3 | 1 | Fully pipelined |
| Integer divide (32-bit) | 12–26 | 4–9 | Not pipelined; Ice Lake+ ~12–18 |
| Integer divide (64-bit) | 18–90 | 6–30 | Pre-Ice-Lake 64-bit `div` is a disaster |
| FP add / multiply / FMA | 4 | 1.3 | 2/cycle throughput |
| FP divide (`divsd`) | 13–20 | 4–7 | Poorly pipelined |
| `sqrtsd` | 15–20 | 5–7 | |
| `rsqrtps` approximation | 4 | 1.3 | 12-bit accuracy |
| L1 dTLB hit | 0 (extra) | 0 | Parallel with L1 tag lookup |
| STLB (L2 TLB) hit | 7–9 | 2–3 | |
| Page walk, PTEs in L1/L2 | 20–40 | 7–14 | Ch. 32 §32.8 |
| Page walk, PTEs in DRAM | 300–600 | 100–200 | Up to 4 dependent DRAM reads |

**The mispredict number is derivable.** Pipeline depth from fetch to branch resolution is ~15–19 stages on Skylake/Golden Cove; a mispredict discards everything younger than the branch and restarts fetch. That's why the penalty tracks pipeline depth and why it did *not* grow with core width. Note the "up to 30–60" row: the raw flush is 16 cycles, but if the correct path isn't in the µop cache or L1i you also pay a front-end refill, and a modern profile will attribute that to `frontend_bound`, not `bad_speculation`.

### Memory-system throughput (Little's Law)

Latency alone is misleading for streaming code. **Little's Law**: `outstanding_bytes = bandwidth × latency`. A single core supports ~10–16 outstanding line fills (line-fill buffers / miss-status registers), so single-core streaming bandwidth ≈ `12 × 64 B / 80 ns ≈ 9.6 GB/s` from DRAM, even though the socket can do 200+ GB/s. Hardware prefetch raises the effective concurrency; that is the mechanism by which prefetching helps sequential code, not "hiding latency" in the abstract.

| Bandwidth figure | Value |
|---|---|
| L1d load bandwidth | 2× 32 B/cycle ≈ 190 GB/s |
| L2 → L1 | 64 B/cycle ≈ 190 GB/s |
| L3 → L2 | ~32 B/cycle ≈ 100 GB/s |
| DRAM per socket, DDR4-3200 ×8 channels | 204 GB/s peak, ~150 GB/s achieved |
| DRAM per socket, DDR5-4800 ×8 | 307 GB/s peak, ~230 GB/s achieved |
| **Single core from DRAM** | **8–15 GB/s** (concurrency-bound, not bandwidth-bound) |
| UPI/xGMI cross-socket link | 30–60 GB/s per direction |

### Data-structure consequences

| Access pattern | Effective per-element cost |
|---|---|
| Sequential array scan, prefetcher engaged | 0.2–1 ns/element (bandwidth-bound) |
| Random access within L1 (32 KB) | ~1.3 ns |
| Random access within L2 (1–2 MB) | ~4 ns |
| Random access within L3 (32–128 MB) | ~20 ns |
| Random access in a 10 GB working set | 80–120 ns + likely TLB miss = 150–250 ns |
| Pointer-chasing linked list, 100 M nodes | 150–300 ns/node (no MLP; dependent loads serialize) |
| Binary search over 1 M `int64` (8 MB) | ~7 dependent misses × ~25 ns ≈ 175 ns |
| Hash lookup, open addressing, 1 probe | 1 miss ≈ 80–100 ns |

**Pointer chasing is the worst case not because a miss is expensive but because dependent misses cannot overlap.** Memory-level parallelism goes to 1. Indexed/flat structures (Ch. 12 §12.7, Ch. 21) win precisely by restoring MLP.

### ARM differences

Neoverse N1/V1/V2 (Graviton 2/3/4), at ~2.6–3.0 GHz: L1d 4 cycles, L2 11–14 cycles, system-level cache ~30 ns, DRAM 90–110 ns — broadly the same shape, slightly worse DRAM latency on Graviton 2, comparable on V2. Branch mispredict is ~11–13 cycles (shallower pipeline). Cache line is 64 B on Neoverse but **128 B on Apple M-series**, which changes false-sharing padding (Ch. 26 §26.16). Integer divide is much better than pre-Ice-Lake x86. The big architectural difference is not latency but ordering: ARM is weakly ordered (Ch. 29 §29.14), so barriers appear where x86 needed none, and `ldar`/`stlr` cost ~5–20 cycles where x86 acquire/release loads and stores are free.

---

## 30.2 Synchronization and Syscall Latency Numbers

### Atomics and fences

| Operation | Cycles | ns | Condition |
|---|---|---|---|
| Relaxed atomic load (x86 plain `mov`) | 4 | 1.3 | Identical to a normal load |
| Acquire load / release store (x86) | 4 / 1 | ~1 | Free — TSO gives them for nothing |
| `seq_cst` store (`xchg` or `mov`+`mfence`) | 20–35 | 7–12 | Full barrier |
| `lock xadd` / `lock cmpxchg`, line in L1 Modified, uncontended | 18–25 | 6–9 | |
| `lock` op, line in another core's cache, same socket | 100–250 | 35–85 | RFO + HITM |
| `lock` op, heavily contended, 8 threads | 500–2000 | 170–700 | Serialized queue |
| `lock` op, cross-socket contention | 1500–4000 | 500–1300 | |
| `mfence` | 20–35 | 7–12 | Drains the store buffer |
| `pause` (spin hint) | 5 (pre-Skylake) / ~40 (Skylake+) | 1.5 / 13 | Deliberately lengthened |
| Split-lock atomic (straddles a cache line) | — | **1000–5000** | Bus lock; stalls **every** core |
| ARM `ldaxr`/`stlxr` LL-SC pair, uncontended | ~20–40 | 8–15 | Can livelock |
| ARM LSE `casal`/`ldadd`, uncontended | ~10–20 | 4–8 | Far-atomic capable |

**The single most important number here:** an uncontended atomic RMW on a line you already own is ~20 cycles; a contended one is 10–100× worse. Lock-free code doesn't fail because atomics are slow, it fails because *shared* atomics are slow. Per-core sharded counters (Ch. 59 §59.3) exist entirely to move the operation from row 4 to row 3 of that table.

### Locks and thread coordination

| Operation | Typical | Notes |
|---|---|---|
| `std::mutex` lock+unlock, uncontended | 15–25 ns | Two atomics, no syscall — glibc futex fast path |
| `std::mutex`, contended, spin phase succeeds | 50–500 ns | Adaptive spin before parking |
| `std::mutex`, contended, futex park + wake | **2–8 µs** | Two syscalls + a context switch |
| `std::shared_mutex` read lock, uncontended | 20–40 ns | Still a shared atomic — readers contend with readers |
| `condition_variable::notify_one` → waiter runs | 3–10 µs | `FUTEX_WAKE` + wakeup latency |
| `std::atomic::wait`/`notify` (C++20) | Same as futex | Spins first, then parks |
| Thread creation (`pthread_create`) | 15–40 µs | `clone` + stack mmap + TLS setup |
| Thread join | 5–15 µs | |
| Voluntary context switch (same core, warm) | 1–3 µs | Direct cost only |
| Involuntary context switch, cross-core | 3–10 µs | Plus cold-cache recovery |
| **Cache/TLB "recovery" after a switch** | **10–100 µs** | The indirect cost, usually the dominant one |
| Thread migration to another NUMA node | 50–500 µs of degraded work | Working set is now remote |
| SPSC ring-buffer handoff, cores on same socket | 40–80 ns | One cache-line transfer (Ch. 26 §26.3) |
| SPSC handoff, cross-socket | 200–400 ns | |
| Futex wake-to-run under `SCHED_OTHER`, loaded box | 10 µs – 10 ms | Tail depends entirely on run-queue depth |

The **indirect** cost of a context switch is the interview point. The direct cost (save/restore registers, switch `CR3`, run the scheduler) is ~1–3 µs. The real cost is that the incoming thread finds its L1/L2 evicted and its TLB entries flushed, and spends tens of microseconds re-warming. On a busy-polling hot path a *single* involuntary preemption can create a 50 µs latency outlier that no amount of code optimization removes — which is the whole justification for core isolation (Ch. 31 §31.19).

### System calls

| Operation | No mitigations | With KPTI + IBRS/retpoline (default) |
|---|---|---|
| `SYSCALL`/`SYSRET` mode switch, no work | 40–60 ns | 100–200 ns |
| `getpid()` (cheapest real syscall) | ~60 ns | 200–350 ns |
| `clock_gettime()` **via vDSO** | 15–25 ns | 15–25 ns (no mode switch at all) |
| `clock_gettime()` forced through syscall | ~80 ns | 300–500 ns |
| `rdtsc` / `rdtscp` | 6–10 ns / 10–12 ns | unchanged |
| `read()`/`write()` on a ready socket, small | 1–3 µs | Includes stack traversal, not just entry |
| `sendto()` UDP, 100 B | 1.5–3 µs | |
| `epoll_wait()` returning immediately | 1–2 µs | |
| `io_uring` SQE submit, `SQPOLL` mode | **0 syscalls**, ~100–300 ns | Ch. 34 §34.21 |
| `mmap()` / `munmap()` | 1–5 µs | `munmap` also triggers TLB shootdown |
| Minor page fault | 0.5–2 µs | Ch. 32 §32.4 |
| Copy-on-write fault (4 KB) | 1.5–3 µs | Fault + page copy |
| Major page fault, NVMe backing | 30–150 µs | |
| Major page fault, spinning disk | 3–10 ms | |
| TLB shootdown IPI, 2 cores | 2–5 µs | |
| TLB shootdown, 64 cores | 10–50 µs | Scales with participating CPUs |
| `fork()` of a 1 GB-RSS process | 300 µs – 2 ms | Page-table copy is O(mapped pages) |
| `signal` delivery to a running thread | 2–5 µs | |

**Why mitigations cost what they cost.** KPTI (Meltdown) swaps `CR3` on every kernel entry and exit; without PCID that flushes the entire TLB, and with PCID it still costs two `mov %cr3` (~200–300 cycles combined) plus lost TLB reach. IBRS/eIBRS and retpoline add indirect-branch serialization inside the kernel. Measure your own box: `cat /sys/devices/system/cpu/vulnerabilities/*` tells you which are active, and a `getpid()` loop tells you the price. Turning them off (`mitigations=off`) is a common, deliberate, security-accepting choice on an air-gapped trading host and typically restores 2–3× on syscall-heavy paths.

**The rule that falls out:** at 200 ns of pure entry overhead plus 1–3 µs of real work, a syscall in a hot loop that runs 1 M times/second consumes 1–3 full cores of overhead. That is the arithmetic behind kernel bypass (Ch. 47), `io_uring` (Ch. 34 §34.13), and vDSO.

---

## 30.3 Network Latency and Serialization Numbers

### Propagation and serialization — the two irreducible components

**Propagation delay** is distance ÷ signal velocity. In single-mode fiber the refractive index is ~1.47, so light travels at ~204,000 km/s:

```
fiber:      ~4.9 µs per km   (≈ 5 µs/km — memorize this)
copper:     ~5.0 ns per metre
free space / microwave: ~3.34 µs per km  (≈ 1.5× faster than fiber)
```

**Serialization delay** is frame bits ÷ link rate. Ethernet adds 8 B preamble/SFD and a 12 B interframe gap to every frame, so a 64 B frame occupies 84 B on the wire:

| Frame | 1 GbE | 10 GbE | 25 GbE | 100 GbE |
|---|---|---|---|---|
| 64 B (84 B on wire) | 672 ns | 67.2 ns | 26.9 ns | 6.7 ns |
| 256 B | 2.2 µs | 220 ns | 88 ns | 22 ns |
| 1500 B MTU | 12.2 µs | 1.22 µs | 488 ns | 122 ns |
| 9000 B jumbo | 72.5 µs | 7.25 µs | 2.9 µs | 725 ns |

Serialization is why **store-and-forward switching costs a full frame time per hop** and cut-through does not (Ch. 39 §39.1–§39.2). It is also why jumbo frames are a *throughput* optimization and a *latency* pessimization.

### Switches, NICs, and stacks

| Element | One-way latency |
|---|---|
| Cut-through switch (Arista 7130/Exablaze class) | 40–130 ns |
| Cut-through switch, general datacenter (Tomahawk/Trident) | 400–800 ns |
| Store-and-forward switch, 1500 B @10G | 1.3–2 µs |
| Switch under output-port contention (microburst) | +1 µs to +1 ms (queueing) |
| Optical layer-1 tap / passive splitter | ~5 ns |
| NIC RX: wire → DMA into host memory | 300–800 ns |
| PCIe Gen3/4 round trip (doorbell → completion) | 500 ns – 1 µs |
| Intel DDIO (DMA lands in L3, not DRAM) | saves ~70–100 ns per line |
| **Kernel UDP RX, wire → `recvfrom` returns** | **3–6 µs** |
| **Kernel TCP RX, wire → `read` returns** | **4–8 µs** |
| Kernel TX, `send()` → wire | 2–5 µs |
| Kernel path with `SO_BUSY_POLL` | 2–4 µs (removes interrupt+wakeup) |
| Interrupt-driven wakeup (no busy poll) | +5–30 µs, and it is the jitter source |
| Interrupt coalescing at default settings | +20–200 µs of added tail |
| **Kernel bypass (OpenOnload/VMA), UDP** | **1.2–2 µs** |
| **ef_vi / DPDK raw, wire-to-wire** | **700 ns – 1.5 µs** |
| **FPGA NIC, tick-to-trade** | **30–120 ns** |
| RDMA one-sided read, RoCE | 1.5–3 µs |
| TCP loopback RTT (`lo`) | 15–40 µs |
| UNIX-domain socket RTT | 8–20 µs |
| Shared-memory SPSC queue, cross-process | 100–300 ns |

### Application-level and geographic

| Path | Latency |
|---|---|
| Same rack, cut-through, kernel bypass, RTT | 3–6 µs |
| Cross-connect within a colo hall | 100–500 ns of cable + 1 switch hop |
| Within one metro (e.g. Secaucus ↔ Carteret, ~30 km) | ~150 µs one-way fiber |
| Chicago ↔ New York, best commercial **fiber** | ~6.5 ms one-way, ~13 ms RTT |
| Chicago ↔ New York, **microwave** | ~4.0 ms one-way, ~8.1 ms RTT |
| London ↔ Frankfurt fiber | ~4.5 ms RTT |
| New York ↔ London fiber | ~55–60 ms RTT |
| Trans-Pacific | ~150–200 ms RTT |

The Chicago–NY spread is the standard illustration of why microwave networks exist: the great-circle distance is ~1,190 km, so a straight-line vacuum path is 3.97 ms one-way. Fiber loses on both counts — a longer physical route (~1,300 km) and a slower medium (1.47× index) — giving ~6.5 ms. **Microwave cannot beat physics; it beats the refractive index and the routing.**

### Tick-to-trade budgets

A realistic decomposition for a competitive equities/futures strategy, one way, from the first bit of the market-data packet arriving at your NIC to the first bit of the order leaving it:

| Stage | Software (bypass) | FPGA |
|---|---|---|
| NIC RX to user memory | 400–700 ns | 30–50 ns (on-chip) |
| Feed decode / book update | 200–800 ns | 10–30 ns |
| Strategy decision | 100–500 ns | 5–20 ns |
| Order encode | 100–300 ns | 5–15 ns |
| NIC TX to wire | 400–700 ns | 20–40 ns |
| **Total** | **1.2–3 µs** | **70–150 ns** |

Serialization, encoding, and byte-order work (Ch. 3 §3.9, Ch. 51) sit inside the middle three rows. A `BSWAP` costs 1 cycle; a `std::stringstream` parse costs 500 ns–2 µs and is the reason allocation-free binary parsing exists.

---

## 30.4 Latency Numbers as Estimates, Not Constants

Every table above is a *distribution summarized by its mode*, quoted for one machine class. Treating any of them as a constant is the most common way engineers reason themselves into wrong designs.

### What moves the numbers, and by how much

| Factor | Effect | Typical magnitude |
|---|---|---|
| CPU frequency (C-state/P-state, turbo, AVX offset) | Changes cycles↔ns conversion | 0.8–2.5× |
| Waking from C6 | Adds fixed exit latency | 50–150 µs |
| Frequency ramp after idle | Runs at base clock briefly | 20–40% slower for ~1 ms |
| SMT sibling active | Halves front-end and L1 capacity | 1.2–2× worse |
| NUMA node of memory vs thread | Remote access penalty | 1.4–2.0× |
| Memory-controller load | Queueing delay | 1× → 4× at saturation |
| Working-set size crossing a cache level | Discontinuous jump | 4×, 5×, 4× at each boundary |
| TLB reach exceeded (4 KB vs 2 MB pages) | Adds page walks | 10–40% on random access |
| Spectre/Meltdown mitigations | Syscall + indirect-branch cost | 2–3× on syscalls |
| Hypervisor / cloud tenancy | Steal time, vCPU preemption | 10 µs – 10 ms outliers |
| Kernel version | Scheduler, io_uring, mitigation changes | Occasionally 2× |
| Compiler and code layout | I-cache and BTB pressure | 5–30% with no source change |

**The hardware-generation caveat, stated precisely.** Between Skylake-SP (2017) and Sapphire Rapids/Genoa (2023): L1/L2 latency in *cycles* barely moved (4/12 → 5/16 — L2 got *slower* in cycles as it got bigger); L3 latency worsened as core counts grew and meshes lengthened; DRAM latency in *nanoseconds* is nearly unchanged; per-socket bandwidth roughly tripled; core width went from 4-wide to 6-wide; branch mispredict penalty is flat. **Latency is stagnant, bandwidth and parallelism are not.** Any design whose performance rests on a latency improvement arriving is a design that will not improve.

### Mean is the wrong statistic

For a low-latency system the mode is irrelevant and the mean is misleading. What matters is p99, p99.9, and max, and those are governed by entirely different mechanisms than the median:

| Percentile | Dominated by |
|---|---|
| p50 | Cache hits, correct prediction, hot path |
| p90 | L3 misses, occasional branch mispredict |
| p99 | Page faults, TLB misses, lock contention, allocator slow paths |
| p99.9 | Context switches, IRQ handling, timer ticks, THP compaction |
| p99.99 / max | C-state exit, NUMA migration, page-cache writeback, GC-like arena reclaim, `mmap` semaphore stalls |

A change that improves p50 by 20 ns and adds a 1-in-10⁵ chance of a 500 µs stall is a loss. This is why Ch. 43 §43.2–§43.5 insists on full histograms and warns about coordinated omission: a load generator that stops sending during a stall never records the stall.

### Measuring rather than assuming

| Question | Tool | Specific counter/knob |
|---|---|---|
| Where are the cache misses? | `perf stat` | `LLC-load-misses`, `mem_load_retired.l3_miss` |
| Is it front-end or back-end bound? | `perf stat --topdown`, `toplev` | Top-down levels 1–3 |
| Actual DRAM latency on this box | Intel MLC (`mlc --latency_matrix`), `lmbench lat_mem_rd` | Per-NUMA-node matrix |
| Branch mispredicts | `perf stat` | `branch-misses`, `br_misp_retired.all_branches` |
| TLB cost | `perf stat` | `dtlb_load_misses.walk_active`, `.walk_pending` |
| Syscall cost on this kernel | `perf trace`, a `getpid` loop | — |
| Which mitigations are on | `/sys/devices/system/cpu/vulnerabilities/*` | — |
| Actual core frequency during the run | `turbostat`, `perf stat` | `cycles` ÷ `ref-cycles` ratio |
| Context switches and migrations | `perf stat` | `context-switches`, `cpu-migrations` |
| Off-CPU time and why | `bpftrace` / `offcputime` | Kernel stack at schedule-out |
| Scheduler latency | `perf sched latency`, `ftrace sched_switch` | Wakeup-to-run delay |
| Page faults | `perf stat`, `/proc/PID/stat` | `page-faults`, `minflt`/`majflt` |
| NUMA behaviour | `numastat`, `perf c2c` | Remote access %, HITM sources |
| Network stack timing | NIC hardware timestamps, `SO_TIMESTAMPING` | Ch. 48 §48.9 |

**`perf c2c` deserves a specific mention**: it attributes cache-line contention to the exact line, offset, and pair of code sites, and is the correct answer to "how would you find false sharing in production?" (Ch. 26 §26.15).

### How to use this chapter in an interview

The expected failure mode is reciting a table. The expected strong answer has three parts:

1. **Order of magnitude and unit.** "An L3 miss is ~80 ns, call it 250 cycles at 3 GHz."
2. **The mechanism that produces it.** "Because the mesh traversal is ~20 ns and DRAM row activation plus CAS is ~40–50 ns; bandwidth has scaled, timings haven't."
3. **What would change it here.** "But this is a remote node in a two-socket box, so 130 ns, and if the working set is 10 GB with 4 KB pages I should assume a page walk on top."

The ratios matter more than the absolutes, and the ratios are stable across generations: **L1 : L2 : L3 : DRAM ≈ 1 : 3 : 15 : 60**, and **cache-miss : syscall : context-switch : disk ≈ 1 : 3 : 30 : 1000**. Those two chains reconstruct most of the tables above.

---

## Key Interview Questions

1. **What's the cycles-to-nanoseconds conversion you work in?** — ~3 cycles/ns at 3 GHz; in-core costs quote in cycles (frequency-invariant), off-core in ns (frequency-invariant the other way).
2. **Give the cache hierarchy latencies.** — L1 ~4 cy (1.3 ns), L2 ~14 cy (4–5 ns), L3 ~50–70 cy (15–25 ns), local DRAM ~80 ns, remote NUMA ~130 ns.
3. **Why hasn't DRAM latency improved in 15 years?** — It's bounded by DRAM bank timings (tRP/tRCD/tCL), which are electrically constrained; channel count and clock scale bandwidth, not latency.
4. **What is the branch-misprediction penalty and why that value?** — 15–20 cycles, set by pipeline depth from fetch to branch resolution; add front-end refill if the correct path isn't in the µop cache.
5. **How fast is an uncontended atomic RMW vs a contended one?** — ~20 cycles if the line is already in Modified state in your L1; 100–250 cycles when another core owns it; 500–2000 under real contention; 10× that cross-socket.
6. **Why is a split-lock catastrophic?** — An atomic straddling two cache lines can't be done by cache-line locking, so the CPU asserts a bus lock, stalling every core for microseconds. Detect with `split_lock_detect`.
7. **Cost of a syscall today?** — 40–60 ns of raw entry/exit, but 200–350 ns with KPTI+IBRS enabled; a real syscall like `read` on a ready socket is 1–3 µs including stack work.
8. **Why is `clock_gettime` cheap?** — vDSO maps kernel timekeeping data into user space and reads the TSC there; no mode switch, 15–25 ns.
9. **Direct vs indirect cost of a context switch?** — 1–3 µs direct (registers, CR3, scheduler); 10–100 µs indirect from cold L1/L2/TLB. The indirect cost dominates and is what core isolation eliminates.
10. **Uncontended vs contended mutex?** — 15–25 ns (pure atomics, no syscall) vs 2–8 µs when it parks on a futex, because that's two syscalls plus a context switch.
11. **How long does 1500 B take to serialize at 10 GbE, and why does it matter?** — 1.22 µs; it is the per-hop cost of store-and-forward switching and the reason jumbo frames hurt latency.
12. **Fiber propagation delay?** — ~5 µs/km (index ~1.47); microwave ~3.34 µs/km, which is why Chicago–NY is ~4.0 ms one-way by microwave and ~6.5 ms by fiber.
13. **Kernel network stack vs kernel bypass?** — 3–6 µs one-way for kernel UDP RX vs 700 ns–1.5 µs for ef_vi/DPDK; FPGA tick-to-trade is 30–120 ns.
14. **What is Little's Law telling you about single-core memory bandwidth?** — With ~12 line-fill buffers and 80 ns latency, one core sustains ~10 GB/s from DRAM regardless of the socket's 200 GB/s; prefetching helps by raising concurrency.
15. **Why is pointer chasing so much worse than its miss count suggests?** — Dependent loads serialize, collapsing memory-level parallelism to 1, so misses add rather than overlap.
16. **Which mechanisms dominate p99.9 as opposed to p50?** — Context switches, IRQs, timer ticks, THP compaction, C-state exits, page faults — none of which appear in the median.
17. **How would you find false sharing in production?** — `perf c2c`, which attributes HITM events to specific cache lines, offsets, and code sites.
18. **What differs on ARM?** — Similar cache latencies, shallower pipeline (11–13 cycle mispredict), 128 B lines on Apple Silicon, weak ordering so acquire/release cost real instructions, and LSE atomics instead of LL/SC.
19. **How do you validate any of these numbers on a given machine?** — Intel MLC or lmbench for memory, `perf stat` with specific PMU events, `turbostat` for the actual frequency, `/sys/.../vulnerabilities` for mitigation state.

---

## Common Traps

- **Quoting cycle counts without a frequency**, or nanoseconds without saying which hardware class. Both are meaningless alone.
- **Assuming the core runs at turbo frequency** — all-core AVX-512 workloads can run 25–40% below the marketing clock.
- **Using the mean latency.** Low-latency systems are judged on p99.9 and max; the mean hides exactly the events that matter.
- **Forgetting the indirect cost of a context switch** and quoting only the 1–3 µs direct cost.
- **Assuming an atomic is "about 20 cycles"** without stating that this requires the line to be uncontended and already in Modified state.
- **Believing "syscalls are 100 ns"** on a machine with default mitigations — measure; it's usually 2–3× that.
- **Ignoring interframe gap and preamble** when computing serialization: a 64 B frame is 84 B on the wire.
- **Confusing propagation with serialization.** Distance sets the first, link rate sets the second; only one of them is fixed by geography.
- **Treating jumbo frames as a latency win.** They are a throughput/CPU win and a per-hop latency loss.
- **Comparing cross-machine latencies without hardware timestamping** — software timestamps carry the stack cost you're trying to measure.
- **Assuming DRAM latency scales with a newer CPU generation.** Bandwidth does; latency doesn't.
- **Benchmarking on a machine with C-states enabled** and reporting the warm number, then seeing 100 µs outliers in production after idle periods.
- **Measuring with an SMT sibling active** and attributing the noise to the code.
- **Extrapolating single-thread numbers to N threads** — memory latency degrades sharply under controller load.
- **Assuming remote NUMA is "a bit slower".** It's 1.4–2× on latency and drastically worse on contended lines (cross-socket HITM is 500 ns+).
- **Reciting the table without the mechanism.** The follow-up question is always "why", and the number alone doesn't survive it.

---

## Compact Recall Summary

**Anchors.** 3 cycles ≈ 1 ns at 3 GHz. L1 4 cy / 1.3 ns; L2 ~14 cy / 4 ns; L3 50–70 cy / 20 ns; local DRAM 80 ns; remote DRAM 130 ns; cross-socket dirty-line transfer 200–300 ns. Ratios **1 : 3 : 15 : 60** across the hierarchy. Branch mispredict 15–20 cy. Page walk 20–40 cy warm, 100–200 ns cold.

**Bandwidth vs concurrency.** Socket DRAM bandwidth is 200–300 GB/s but a single core gets 8–15 GB/s, because Little's Law caps it at `line_fill_buffers × 64 B / latency`. Prefetching raises concurrency; pointer chasing destroys it.

**Synchronization.** Uncontended atomic RMW ~20 cy; contended 100–2000 cy; cross-socket worse still; split lock is microseconds of whole-machine stall. Uncontended mutex 15–25 ns, parked mutex 2–8 µs. SPSC handoff 40–80 ns same socket.

**Kernel.** Syscall entry 40–60 ns bare, 200–350 ns with KPTI+IBRS. vDSO `clock_gettime` 15–25 ns. Minor fault 0.5–2 µs, COW fault 1.5–3 µs, major fault 30–150 µs on NVMe. Context switch 1–3 µs direct, 10–100 µs of cache recovery. TLB shootdown scales with core count: 2–5 µs at two cores, 10–50 µs at sixty-four.

**Network.** Fiber 5 µs/km, microwave 3.34 µs/km. 1500 B at 10 GbE = 1.22 µs; 64 B = 67 ns (84 B on wire). Cut-through switch 40–130 ns for HFT-grade silicon, 400–800 ns for general datacenter. Kernel UDP one-way 3–6 µs; bypass 0.7–2 µs; FPGA tick-to-trade 30–120 ns. Chicago–NY: 8.1 ms RTT microwave, 13 ms fiber.

**Variance.** Frequency, C-states, SMT, NUMA placement, controller load, page size, mitigations, hypervisor steal, and code layout each move these by 1.2–3×; C6 exit and THP compaction move the tail by orders of magnitude. p50 is cache behaviour; p99.9 is the operating system.

**Method.** Know the order of magnitude, the mechanism that produces it, and the local factor that would change it. Verify with `perf stat` (specific PMU events), `perf c2c`, Intel MLC, `turbostat`, `bpftrace`, and hardware timestamps — never with a remembered table.
