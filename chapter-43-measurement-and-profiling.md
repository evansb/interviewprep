# Chapter 43 — Measurement and Profiling

*Interview-focused revision notes. The theme: almost every performance number you have ever seen is wrong in a specific, nameable way. This chapter is about the ways measurement lies — coordinated omission, probe effects, sampling skid, averaged percentiles, unrepresentative microbenchmarks — and how to build a harness whose numbers survive an adversarial reading.*

---

## 43.1 Latency versus Throughput

**Latency** is the time from the start of one operation to its completion. **Throughput** is the number of operations completed per unit time. They are not reciprocals, and conflating them is the most common analytical error in performance work.

A pipelined unit makes this obvious. An FP multiply has 4-cycle latency and 2-per-cycle throughput: `1/latency = 0.25 ops/cycle`, but actual throughput is `2 ops/cycle` — 8× higher — because eight independent multiplies are in flight simultaneously. The same structure appears at every scale:

| System | Latency | Throughput | Why they differ |
|---|---|---|---|
| FP multiply | 4 cycles | 2/cycle | Pipelining |
| DRAM access | ~80 ns | ~10 GB/s+ | Bank/channel parallelism, 10–16 outstanding misses per core (Ch. 29 §29.5) |
| Disk (NVMe) | ~80 µs | ~1 M IOPS | Queue depth |
| Network RTT | ~10 µs | 100 Gb/s | Bandwidth-delay product (Ch. 38 §38.18) |
| Order gateway | 2 µs tick-to-trade | 500 k msg/s | Batching and parallel stages |

### Little's Law

`L = λ · W` — the average number of items in a system equals arrival rate times average time in system. Rearranged, `W = L / λ`. Its use in interviews: **if you know the concurrency and the throughput, you know the average latency, and vice versa.** A pipeline sustaining 1 M msg/s with 8 messages in flight has an average latency of 8 µs. If someone claims 1 M msg/s at 1 µs latency with a single-threaded, non-pipelined design, Little's Law says they have at most 1 message in flight and the numbers are consistent — but if they also claim it is batching 64 at a time, the latency must be ≥ 64 µs for the last message in the batch.

### The tension

Every throughput optimization has a latency cost, and they are usually the *same* mechanism seen from two sides:

- **Batching** amortizes fixed cost across N items, raising throughput, while item 1 waits for item N (Ch. 52 §52.13).
- **Interrupt coalescing** (Ch. 46 §46.6) reduces interrupts per second and adds up to the coalescing timer to every packet's latency.
- **Nagle's algorithm** (Ch. 38 §38.13) raises goodput and adds up to an RTT.
- **Queueing** absorbs bursts and, by Little's Law, adds queueing delay proportional to occupancy.
- **Deep pipelines** raise IPC and lengthen mispredict recovery.

**The load-dependence point that must be stated:** latency is a function of utilization. For an M/M/1 queue, `W = 1/(µ - λ)` — waiting time goes to infinity as utilization ρ = λ/µ → 1, with the knee around ρ ≈ 0.7–0.8. This is why a latency-critical system is provisioned at low utilization, and why "we measured latency at 50% load" and "we measured latency at 95% load" are different experiments with a 10× difference in the tail. **Any latency number without a stated offered load is meaningless.**

### What to report

A defensible measurement states: the operation boundary (where the clock starts and stops), the offered load and its arrival distribution, the percentile, the sample count, the duration, and the machine/kernel/compiler configuration. "Our median is 800 ns" is not a result; "at 200 k msg/s Poisson arrivals, wire-to-wire p50 = 800 ns, p99 = 2.1 µs, p99.99 = 14 µs over 10⁸ samples on isolated cores with C-states disabled" is.

---

## 43.2 Tail-Latency Percentiles

A **percentile** (quantile) p*X* is the value below which X% of samples fall. In latency work, the distribution is always right-skewed and multi-modal — a fast path, plus modes contributed by cache misses, page faults, context switches, interrupt handling, TLB shootdowns, and GC-like effects — so **the mean is not a location estimator of anything real**.

```
count
  |█
  |█
  |██                              ← p50 = 800ns (the fast path, tight)
  |███
  |████  ▁
  |█████ ▂▁      ▁                 ← p99 = 2µs   (an L3 miss, a light interrupt)
  |██████▃▂▁▁▁ ▁ ▁▁    ▁      ▁    ← p99.9 = 8µs (context switch, page fault)
  +---------------------------->   ← p99.99 = 40µs (softirq, THP compaction)
   0.5µs      5µs      50µs        ← max = 3ms   (something is deeply wrong)
```

Why the mean fails: with 99% at 1 µs and 1% at 1 ms, the mean is ~11 µs — a value that describes no actual request. Worse, the mean is dominated by the tail, so it moves for reasons that have nothing to do with typical behavior. **Report percentiles, plus max, plus the sample count.**

### Why the tail is the business metric

1. **Fan-out amplification.** If a request touches N services in parallel and waits for all of them, the user-visible latency is the *maximum* of N samples. With N = 100 and a per-service p99 of 10 ms, the probability that *no* subrequest hits the tail is 0.99¹⁰⁰ ≈ 37% — so **63% of requests see the p99**. Your p99 is your users' median. This is Dean and Barroso's "The Tail at Scale" argument and is worth being able to reproduce numerically.
2. **In trading, latency has a payoff cliff, not a curve.** Being 200 ns slower than the next participant on a quote update means you miss the fill entirely; the value of the median is zero if the tail is where you lose money. Tail events cluster exactly at high-volatility moments, which are also the moments with the most edge — the worst possible correlation.
3. **Tails compose through pipelines.** A staged pipeline's end-to-end p99 is *worse* than the sum of per-stage p99s if stages are independent, and much worse if a slow stage causes queueing at the next.

### Which percentiles, and how many samples

To resolve p*X* you need enough samples in the tail. A rule of thumb: **you need at least 10–100 samples beyond the percentile** to estimate it stably, so p99.9 requires ≥ 10⁴–10⁵ samples, and p99.999 requires ≥ 10⁶–10⁷. Reporting a p99.99 from 1000 samples is reporting the maximum with extra decimal places.

Standard reporting set: **p50, p90, p99, p99.9, p99.99, max**, plus N and duration. In HFT, `max` is often the operative number, because one 5 ms stall during a market open is a risk event regardless of what the distribution says. Add a **stall counter** — the number of samples exceeding a fixed budget — since that is what SLOs and alerts actually key on (Ch. 59 §59.12).

---

## 43.3 Coordinated Omission

**Coordinated omission (CO)** is the systematic under-reporting of latency that occurs when the measurement loop's request rate is itself slowed by the system under test. Gil Tene named it, and understanding it is the single highest-signal item in this chapter.

The mechanism:

```cpp
// The broken harness — a closed loop
for (int i = 0; i < N; ++i) {
    auto t0 = now();
    send_and_wait();          // if this takes 100 ms, the next iteration STARTS LATE
    record(now() - t0);
}
```

If the system stalls for 100 ms while the intended request rate is 10 000/s, a correct measurement records **1000 requests that experienced delays from 100 ms down to 0.1 ms** (each request that *should* have been issued during the stall waited its share). The broken loop records **one** 100 ms sample and then resumes. The stall is measured once instead of 1000 times, and it is the samples that were never taken that would have populated the tail.

Numerically: 10 000 requests at 1 ms plus one 100 ms stall.

| Harness | p99 | p99.9 | Mean |
|---|---|---|---|
| Closed loop (omitted) | 1 ms | 1 ms | 1.01 ms |
| Corrected (uncoordinated) | ~1 ms | ~90 ms | ~5.9 ms |

The reported p99.9 is off by roughly two orders of magnitude. This is why JMH/wrk-style "latency" results from a closed loop routinely disagree with production by 100×.

### The two fixes

**1. Uncoordinated (open-loop) measurement.** Compute each request's *intended* start time from a schedule, not from when the previous one finished, and measure from the intended start:

```cpp
auto start = now();
for (int i = 0; i < N; ++i) {
    auto intended = start + i * interval;       // fixed schedule; do NOT drift
    busy_wait_until(intended);                  // if we are already late, do not wait
    auto t0 = now();
    send_and_wait();
    auto t1 = now();
    record(t1 - intended);                      // service time + queueing/backlog delay
}
```

Measuring `t1 - intended` rather than `t1 - t0` is the entire fix. It captures the backlog the stall created.

**2. Post-hoc correction.** HdrHistogram provides `recordValueWithExpectedInterval(value, expectedInterval)`, which, when a sample exceeds the expected interval, synthesizes the missing samples at decreasing values. This is a reconstruction, not a measurement — it assumes a fixed rate and a specific stall shape — so it is a fallback, not a substitute for open-loop measurement. `HdrHistogram`'s `copyCorrectedForCoordinatedOmission` does the same on an existing histogram.

### Where CO hides beyond load generators

- **A single-threaded event loop that timestamps at dequeue rather than arrival.** If you record `now()` when you pop from the queue, you have erased all queueing delay. **Timestamp at the earliest possible point — ideally NIC hardware receive timestamp** (Ch. 48 §48.4) — and measure to completion.
- **Sampling profilers on a blocked thread.** A thread that is off-CPU generates no samples; the profiler reports zero time in the thing that is causing all the delay (§43.25).
- **Any "if we are behind, skip this tick" logic** in a benchmark or a periodic task.
- **Backpressure that throttles the generator.** If the system under test can push back on the generator, the generator's arrival process is no longer independent, and you are measuring a closed loop with extra steps.

**Interview framing:** *"Your load generator sends one request, waits for the reply, then sends the next. What is wrong with the latency numbers?"* — coordinated omission; the generator's rate is coupled to the system's stalls, so stalls are counted once instead of once per request that should have been issued during them. Fix by measuring from an intended schedule.

---

## 43.4 Histograms and HDR Histogram

You cannot store 10⁹ latency samples, and you must not store only a mean. A **histogram** stores bucket counts, giving O(1) recording, bounded memory, and computable quantiles.

The naive designs fail:

- **Linear buckets** (1 µs each) covering 0–10 s need 10⁷ buckets, and give absurd resolution at the top and inadequate coverage at the bottom.
- **Fixed logarithmic buckets** (powers of two) give ~100% relative error within a bucket — you cannot distinguish 1.0 ms from 1.9 ms.
- **Reservoir sampling** (t-digest's ancestor, and what many metrics libraries default to) discards data and gives unstable extreme quantiles precisely where you need them.

**HdrHistogram** (High Dynamic Range histogram, Gil Tene) solves this with a design worth being able to explain: it is **a floating-point-like layout — an exponent selecting a "bucket" and a linear array of sub-buckets within it** — configured by the **number of significant decimal digits** you want (1, 2, or 3) and the maximum trackable value.

```
significant digits = 3  →  relative error ≤ 0.1% at ANY magnitude
sub-buckets per bucket = 2 * 10^3 = 2048 (rounded to a power of two)
value → bucket = floor(log2(v)) - log2(subbuckets), index = v >> bucket_shift
```

Properties:

| Property | Value |
|---|---|
| Record cost | O(1): a `clz`, a shift, an array increment — ~5–10 ns, no allocation, no locks |
| Memory | Fixed at construction; e.g. 1 ns–1 hour at 3 significant digits ≈ 185 KB of counters |
| Precision | Guaranteed relative (not absolute) error at every magnitude |
| Aggregation | Histograms with the same configuration **add elementwise** — exactly and losslessly |
| Concurrency | `Recorder`/double-buffered histograms give lock-free record with safe interval sampling |

The last two are why it wins in production: per-core histograms can be summed with no synchronization on the hot path (Ch. 59 §59.3), and interval histograms can be sampled and reset without losing counts, which is what makes per-minute p99.9 reporting correct.

**Practical C++ usage:** HdrHistogram_c is the C library; there are C++ wrappers. In a hot path, record raw cycle counts (§43.12), convert to nanoseconds offline, and keep one histogram per thread with no sharing. Never record into a `std::map<uint64_t,uint64_t>` on the hot path — an allocation and a tree walk per sample is a probe effect (§43.26) that dwarfs the thing you are measuring.

**t-digest** is the main alternative: it gives better accuracy at extreme quantiles for a given size and handles unbounded ranges, but recording is more expensive, merging is approximate, and it is harder to reason about. For fixed-range latency measurement with a known upper bound, HdrHistogram is the correct default.

---

## 43.5 Correct Quantile Aggregation

**You cannot average percentiles.** This is the most frequently violated rule in production monitoring, and stating it correctly is a strong signal.

```
Host A: 1000 requests, p99 = 2 ms
Host B: 1000 requests, p99 = 100 ms
avg(p99) = 51 ms   ← meaningless
true p99 of the 2000 combined requests = ??? — unknowable from these two numbers alone
```

Why it fails: a percentile is a nonlinear order statistic. The p99 of a union is not any function of the members' p99s. The true combined p99 could be anywhere from ~2 ms (if B's tail is only 1% of B and A dominates the ordering) to ~100 ms. Worse, the error is not conservative — averaging can produce a number both above and below the truth depending on the shapes.

The same error appears in three disguises:

1. **Averaging p99 across hosts/shards** in a dashboard.
2. **Averaging p99 across time buckets** — "the daily p99 is the mean of the 1440 per-minute p99s". The daily p99 is systematically *higher* than the mean of per-minute p99s, because bad minutes are underweighted.
3. **max of percentiles** — using `max(p99)` instead. This is at least conservative (an upper bound in most cases) but it tracks the worst host, not the population.

### What actually works

| Method | Correct? | Cost |
|---|---|---|
| Aggregate **histograms**, then compute the quantile from the merged histogram | **Yes, exactly** (to the histogram's precision) | Ship counters, not quantiles |
| t-digest merge | Approximately, with bounded error | Cheaper to ship |
| Keep all raw samples | Yes | Infeasible at scale |
| Average the percentiles | **No** | — |
| Max of the percentiles | Upper-bound heuristic only | — |

**The operational rule:** *metrics pipelines must transport histograms, not quantiles.* Prometheus's `histogram_quantile()` over `_bucket` series does this correctly; a `summary` metric type computes quantiles client-side and is therefore **not aggregatable across instances** — the Prometheus docs say so explicitly, and knowing that distinction is a good interview detail.

**Related trap: quantile interpolation.** Different tools compute quantiles differently (nearest-rank vs linear interpolation between order statistics; R alone defines nine types). For large N the difference is negligible; for small N or coarse histograms it is not, and it explains small disagreements between two tools measuring the same data. State which definition you use when precision matters.

---

## 43.6 Benchmark Warmup

A cold process is a different machine from a warm one. Warmup is the process of reaching the steady state you intend to measure — and deciding *which* steady state that is.

What is cold at process start:

| Cold resource | Effect on first iterations | Warm-up requirement |
|---|---|---|
| I-cache and µop cache | Front-end stalls, ~10× slower first passes | Execute the hot path |
| D-cache, L2, L3 | Every access is a DRAM miss | Touch the working set |
| **Branch predictors, BTB, indirect predictors** | Near-100% mispredict initially | Thousands of iterations with representative patterns |
| **TLB / page tables** | A minor fault per 4 KB page, ~1–3 µs each with the kernel involved | Prefault (`MAP_POPULATE`, `mlockall`, or a touch loop) — Ch. 32 §32.16 |
| Lazy PLT binding | First call per symbol goes through the resolver | `LD_BIND_NOW` / `-Wl,-z,now` (Ch. 41 §41.12) |
| Demand-paged text | Major faults from disk | `mlockall(MCL_CURRENT|MCL_FUTURE)` |
| Allocator arenas | `mmap`/`brk` syscalls, arena initialization | Allocate and free a representative volume |
| CPU frequency / C-state residency | Core at low P-state; first work runs at base clock or lower, and exiting C6 costs tens of µs | Busy-spin, or disable C-states (§43.9) |
| Kernel: socket buffers, ARP, route cache, conntrack | First packet takes a slow path | Send warmup traffic |
| JIT (if any), lazy `constinit`/function-local statics | Guard-variable checks, one-time init | Exercise |

**The two-steady-states problem.** Some things warm up *toward* the fast case (caches, predictors) and some drift *away* from it (memory fragmentation, cache pollution accumulating, thermal throttling, TLB shootdowns from other activity). A benchmark that runs 30 seconds may sit in a regime that neither the first second nor the tenth minute resembles. Report the shape: run long, and plot latency versus time rather than collapsing to one number.

**How much warmup?** Empirically, not by rule: **run the benchmark, plot per-iteration time against iteration index, and find where the curve flattens.** Then discard that prefix explicitly. Google Benchmark's automatic iteration scaling does *not* discard warmup — it chooses an iteration count to reach a target wall time and averages everything, so short-running benchmarks include cold-start cost. If it matters, use `benchmark::DoNotOptimize` in an explicit warm phase or a manual timing loop.

**The trading-system counterpoint (Ch. 60 §60.7).** In production the thing you care about may be exactly the *cold* case — the first message after a quiet period, which is the one that arrives at the open. That is why real systems run **cache-warming loops** that periodically execute the hot path on dummy data to keep code, data, branch predictors, and TLB entries resident. "Warmup is what a benchmark discards and what production must engineer" is a good line.

---

## 43.7 Outliers and Jitter Sources

**Jitter** is variance in latency. An outlier is not noise to be discarded — it is a measurement of a real mechanism, and identifying which mechanism is the actual work.

A checklist, roughly ordered by magnitude, with the diagnostic that identifies each:

| Source | Typical magnitude | Diagnostic |
|---|---|---|
| Page fault (minor) | 1–3 µs | `perf stat -e page-faults`; `/proc/PID/stat` min_flt |
| Page fault (major) | 100 µs – 10 ms | maj_flt; `mlockall` to eliminate |
| **THP compaction / khugepaged** | 100 µs – 100 ms | `/proc/vmstat` compact_stall; disable THP (Ch. 35 §35.19) |
| Context switch / preemption | 1–10 µs, plus cold caches after | `perf stat -e context-switches,cpu-migrations`; `/proc/PID/status` voluntary/nonvoluntary |
| CPU migration | 10–50 µs (cold L1/L2, possibly remote NUMA) | `cpu-migrations`; fix with affinity |
| **Interrupt / softirq** | 1–100 µs | `/proc/interrupts` deltas per core; `ftrace` irq events; IRQ affinity (Ch. 35 §35.13) |
| Timer tick | ~1 µs per tick | `nohz_full` (Ch. 35 §35.16) |
| **C-state exit (C6)** | 30–100 µs | `turbostat` residency; `idle=poll` or `/dev/cpu_dma_latency` |
| P-state / frequency transition | 10–100 µs | `turbostat`; fix with `performance` governor |
| **SMT sibling activity** | 2× slowdown, unpredictable | Disable SMT or isolate both siblings (Ch. 27 §27.17) |
| TLB shootdown IPI | 5–50 µs across all cores | `perf stat -e tlb_flush.*`; caused by another thread's `munmap`/`mprotect` |
| **Split lock** | 10–1000 µs, socket-wide | `split_lock_detect`; Ch. 42 §42.9 |
| Allocator slow path (`mmap`, arena lock) | 1–100 µs | Allocation profiler (§43.23) |
| Logging / `printf` on the hot path | 1 µs – 1 ms | The most common self-inflicted one |
| GC-like effects: `free` of a large structure, destructor cascades | 10 µs – ms | Off-CPU or `perf record` |
| SMI / System Management Interrupt | 100 µs – 10 ms, **invisible to the OS** | `MSR_SMI_COUNT` (MSR 0x34) delta; often BIOS/firmware |
| Machine check / thermal throttle | ms | `turbostat` PkgTmp, `dmesg` |
| **Hypervisor steal time** | ms | `/proc/stat` steal; `vmstat` st column |

**SMIs deserve emphasis.** They execute in System Management Mode, are not maskable, are not counted as CPU time by the OS, and are the classic explanation for a stall that shows up in your TSC deltas but in *no* kernel trace. Reading `MSR_SMI_COUNT` before and after a stall is the definitive test, and mentioning it is a strong signal.

**Method:** do not discard outliers. Record a timestamp with each outlier, then correlate against `/proc/interrupts`, `perf sched`, `ftrace`, and the counters above. A **flight recorder ring buffer** (Ch. 59 §59.13) that dumps the last N events whenever a latency exceeds a threshold is the production form of this and is what a good answer describes.

---

## 43.8 Benchmark Isolation

The measured system must be the only thing changing. Isolation is a checklist, and reciting it credibly is much of the value of this chapter in an interview.

**Machine-level:**
- Dedicated hardware, not a VM (hypervisor steal, vCPU migration, and unstable TSC destroy results). If virtualized, at minimum pin vCPUs and check `/proc/stat` steal.
- Disable **Turbo Boost** *or* pin to a fixed frequency — turbo makes results depend on the thermal history of the previous run (Ch. 35 §35.12).
- Disable **SMT/hyperthreading**, or ensure the sibling of every measured core is idle *and* isolated. A busy sibling halves your execution resources.
- Disable **C-states** deeper than C1 (`intel_idle.max_cstate=1`, `processor.max_cstate=1`, or hold `/dev/cpu_dma_latency` open at 0).
- Disable **ASLR** for reproducibility (`setarch -R`) — layout randomization shifts code across cache sets and page boundaries and produces several percent of run-to-run variance from nothing else.
- Disable **THP** or set it to `madvise` (Ch. 35 §35.19).
- Fix **kernel, microcode, and BIOS settings** and record them; a microcode update changing a mitigation flips results.

**Kernel/scheduler:**
- `isolcpus=`, `nohz_full=`, `rcu_nocbs=` on the measured cores (Ch. 31 §31.19, Ch. 35 §35.16).
- Move IRQs off the measured cores (`/proc/irq/*/smp_affinity`) and move kernel threads via a housekeeping cpuset.
- `SCHED_FIFO` for the measured thread — with a watchdog, since a spinning FIFO thread can wedge the machine (Ch. 31 §31.21).
- Stop `irqbalance`, `tuned`, cron, monitoring agents, and anything else on the box. `systemctl` list what is running and say so in the report.

**Process-level:**
- `mlockall(MCL_CURRENT|MCL_FUTURE)` and prefault the heap and stacks.
- `-Wl,-z,now` to avoid lazy PLT resolution mid-measurement.
- Pin memory to the local NUMA node (§43.10).
- Fixed environment size — the environment block shifts the stack, which shifts alignment (this genuinely produces multi-percent swings; see Mytkowicz et al., "Producing Wrong Data Without Doing Anything Obviously Wrong").

**Statistical:**
- **Randomize and interleave the A/B order.** Do not run all of A then all of B; drift in temperature, frequency, or memory fragmentation will be attributed to your change. Alternate A/B/A/B and compare paired samples.
- **Run the whole binary multiple times**, not just multiple iterations inside one process. Between-process variance (layout, ASLR, allocator state) is often larger than within-process variance, and a single process gives you n = 1 on that axis.
- **Report a confidence interval or a nonparametric test** (Mann–Whitney U on paired runs), not a difference of two means. A 2% "improvement" with 5% run-to-run variance is nothing.

**The layout-bias point** is the deepest one here: changing an unrelated function's length can shift a hot loop across a cache-line or 4 KB boundary and change performance by 5–10%, which is larger than most optimizations you are trying to measure. **Stabilizer**-style randomized layout, or simply averaging over many link orders / `-falign-functions` settings, is the rigorous answer; the practical answer is "measure the same binary many times, and be suspicious of small wins."

---

## 43.9 CPU Affinity and Frequency Control for Benchmarks

**Affinity.** Pin every measured thread to a specific core, and pin it to a core that is isolated from the scheduler.

```bash
taskset -c 4 ./bench                        # simple pinning
numactl --physcpubind=4 --membind=0 ./bench # pinning + memory policy
chrt -f 80 taskset -c 4 ./bench             # + SCHED_FIFO priority 80
```
```cpp
cpu_set_t set; CPU_ZERO(&set); CPU_SET(4, &set);
pthread_setaffinity_np(pthread_self(), sizeof set, &set);
```

Choose the core deliberately from the topology (`lscpu -e`, `lstopo`): CPU numbering is *not* topological, and `taskset -c 0,1` frequently pins you to two SMT siblings of the same physical core — the single most common pinning mistake (Ch. 31 §31.18). Check `/sys/devices/system/cpu/cpuN/topology/thread_siblings_list`.

**Frequency.** Uncontrolled frequency is the most common source of unreproducible results.

```bash
# Governor: performance = always max non-turbo (or max turbo, depending on driver)
cpupower frequency-set -g performance
# intel_pstate specifics
echo 100 > /sys/devices/system/cpu/intel_pstate/min_perf_pct
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo     # DISABLE turbo for reproducibility
# verify what actually happened
turbostat --interval 1        # Bzy_MHz is the real busy frequency
```

Turbo is a genuine dilemma: **disable it for reproducibility, enable it for realism.** Production runs with turbo, so a turbo-disabled benchmark understates absolute performance; but turbo frequency depends on core count, temperature, power budget, and AVX license (Ch. 42 §42.13), so results become time- and history-dependent. The defensible approach is to disable turbo for A/B comparisons (where you want a stable ratio) and to run separate turbo-enabled runs for absolute numbers, stating which is which.

**Always verify frequency from within the measurement**, not from configuration:

```
effective frequency multiplier = cycles / ref-cycles      (perf stat gives both)
```

`ref-cycles` counts at the invariant TSC rate; `cycles` counts actual core clocks. Their ratio is the real frequency relative to nominal, per measurement interval. If it moved between your A and B runs, your comparison is invalid. This is the check that catches thermal throttling, AVX downclocking, and a governor that silently did not apply.

Also: **`cpupower idle-set -D 0`** or holding `/dev/cpu_dma_latency` at 0 prevents C-state entry — necessary because between iterations of a benchmark that sleeps, the core drops into C6 and the first iteration after each sleep pays 30–100 µs of exit latency plus a cold cache.

---

## 43.10 NUMA-Aware Benchmarking

On a multi-socket machine, a local DRAM access is ~80 ns and a remote one is ~130–200 ns, with roughly half the bandwidth and additional interconnect contention (Ch. 29 §29.17). A benchmark that does not control NUMA placement measures a coin flip.

The mechanism that catches people is **first-touch allocation** (Ch. 32 §32.26): a page is physically allocated on the node of the thread that *first writes* to it, not the thread that called `malloc`. So:

```cpp
std::vector<double> v(1'000'000);      // allocation; may or may not touch
std::fill(v.begin(), v.end(), 0.0);    // FIRST TOUCH — happens on the initializing thread's node
// ... later, worker threads on the other socket read it → every access is remote
```

The classic manifestation: a single-threaded initialization loop places the entire dataset on node 0, then an OpenMP parallel loop across both sockets runs at half the expected bandwidth. **Parallel-initialize with the same decomposition as the parallel compute** — this is the standard STREAM-benchmark correctness rule.

### Controlling and verifying placement

```bash
numactl --hardware                      # topology and free memory per node
numactl --cpunodebind=0 --membind=0 ./bench     # strict: fail rather than fall back
numactl --interleave=all ./bench                # for bandwidth benchmarks that should not favor a node
numastat -p $(pidof bench)              # per-node pages actually used by the process
```
```bash
# Verify from the process's own view:
cat /proc/PID/numa_maps               # per-mapping node distribution — the ground truth
```

`--membind` is strict (allocation fails / OOMs if the node is full); `--preferred` falls back silently, which is friendlier and worse for measurement, because a silent fallback turns a controlled experiment into an uncontrolled one.

### Additional NUMA measurement points

- **The NIC has a NUMA node too** (`/sys/class/net/eth0/device/numa_node`). A receive path where the NIC DMAs into node 1 memory while the handler thread runs on node 0 pays a remote access on every packet, plus DDIO writes into the wrong L3 (Ch. 29 §29.25). Benchmarking network latency without pinning to the NIC's node measures the wrong thing.
- **Automatic NUMA balancing** (`/proc/sys/kernel/numa_balancing`) migrates pages under the benchmark, producing multi-second drift and periodic latency spikes from the migration faults. Disable it for measurement.
- **Report per-node counters.** `perf stat -e node-loads,node-load-misses` or the uncore counters via PCM (§43.22) show the local/remote split directly. On AMD, the equivalent is the per-CCX/CCD data-fabric counters; on Intel, `OFFCORE_RESPONSE` with remote-DRAM masks.
- Even single-socket parts are NUMA-like: AMD Zen's CCX/CCD structure means cross-CCD L3 access is far more expensive than intra-CCD, and Intel's sub-NUMA clustering (SNC) splits one socket into two nodes. `lstopo` shows it.

---

## 43.11 Google Benchmark Barriers

The core problem in a microbenchmark: **the compiler can delete the thing you are measuring.** If a computed value is unused, dead-code elimination removes it (Ch. 40 §40.12); if inputs are compile-time constant, constant folding evaluates it at compile time; if the loop body is invariant, it is hoisted out.

Google Benchmark provides two barriers:

```cpp
static void BM_Hash(benchmark::State& state) {
    std::string s(state.range(0), 'x');
    for (auto _ : state) {
        benchmark::DoNotOptimize(s);         // "the compiler must assume s may be read/written"
        auto h = std::hash<std::string>{}(s);
        benchmark::DoNotOptimize(h);         // "h escapes; you may not delete its computation"
    }
    state.SetBytesProcessed(int64_t(state.iterations()) * state.range(0));
}
BENCHMARK(BM_Hash)->Range(8, 8<<10);
```

The two primitives differ:

| Primitive | Implementation (GCC/Clang) | Meaning |
|---|---|---|
| `DoNotOptimize(x)` | `asm volatile("" : "+r,m"(x) : : "memory")` (or `"+m"` for non-register types) | The value is read *and* written by opaque code; it must exist in a register or memory and cannot be folded away |
| `ClobberMemory()` | `asm volatile("" ::: "memory")` | All memory may have been written; forces pending stores to be materialized before this point |

`ClobberMemory()` is what you need when the operation's effect is a **store** — e.g. benchmarking `memcpy` into a buffer nobody reads. `DoNotOptimize` on the destination pointer is not enough, because the compiler can still see the stores are dead; the memory clobber makes them observable.

**What the barriers cost, and cannot fix:**

- `DoNotOptimize` with the `"+r"` constraint **forces the value into a register**, which can inhibit optimizations (constant propagation into the operation, keeping something in a vector register) and change codegen versus real usage. It is a probe effect (§43.26): you are benchmarking a slightly different program.
- The `"memory"` clobber acts as a **compiler barrier**, preventing reordering across the loop boundary. This can prevent software pipelining and loop-invariant hoisting that would legitimately occur in real code.
- **Neither barrier stops the CPU** from overlapping iterations. A benchmark of a 4-cycle-latency operation with independent inputs measures *throughput* (2/cycle), not latency. To measure latency you must create a dependency chain: feed each iteration's output into the next input (Ch. 42 §42.10). Failing to distinguish these is the most common microbenchmark error after DCE.
- **Neither barrier stops the branch predictor from learning your input pattern.** A benchmark with 1000 repeated inputs measures a fully-trained predictor and a fully-warm cache, which is exactly the case production does not have.

Other Google Benchmark specifics worth knowing: `->UseManualTime()` when you time inside the loop (e.g. GPU or an explicit RDTSC region); `->Threads(n)` for contention benchmarks; `->MinTime()`; `benchmark::State` iteration counts are chosen automatically so warmup is *not* excluded (§43.6); and the harness reports the **mean** by default — add `->ComputeStatistics("p99", ...)` or use `--benchmark_repetitions=N --benchmark_report_aggregates_only=true`, but understand that repetitions give you between-run statistics, not a latency distribution over operations.

**When not to use it at all:** Google Benchmark measures throughput of a tight loop. For end-to-end latency distributions of a request path, it is the wrong tool — build a harness with an open-loop generator and an HdrHistogram (§43.3, §43.4).

---

## 43.12 RDTSC and RDTSCP Timing

`RDTSC` reads the **Time Stamp Counter**, a 64-bit per-core counter. It is the cheapest high-resolution timer available: ~15–25 cycles, no syscall, no ring transition.

```cpp
static inline uint64_t rdtsc() {
    uint32_t lo, hi;
    asm volatile("rdtsc" : "=a"(lo), "=d"(hi));   // NOT ordered
    return (uint64_t(hi) << 32) | lo;
}
static inline uint64_t rdtscp(uint32_t& aux) {
    uint32_t lo, hi;
    asm volatile("rdtscp" : "=a"(lo), "=d"(hi), "=c"(aux));  // waits for prior instrs to retire
    return (uint64_t(hi) << 32) | lo;
}
```

### The pitfalls, in the order they bite

**1. `RDTSC` is not serializing.** It can execute out of order with respect to the code you are timing — before the work has started, or after unrelated later work. `RDTSCP` waits for all *previous* instructions to retire but does not prevent *later* instructions from executing before it. The canonical Intel-recommended sequence:

```cpp
// start:  LFENCE; RDTSC          (or CPUID; RDTSC — CPUID is fully serializing but ~100+ cycles
//                                  and varies with the leaf, so LFENCE is preferred)
// end:    RDTSCP; LFENCE          (RDTSCP waits for prior retire; LFENCE stops later code moving up)
```
`LFENCE` became a full load-serializing instruction on Intel as part of Spectre mitigation and is the standard fence here; on AMD, `LFENCE` is serializing only when `MSR_C001_1029[1]` is set (which modern kernels do set). Cost: ~20–40 cycles for the fenced pair, which sets the floor on what you can measure. **Do not try to time anything shorter than ~100 cycles with RDTSC**; use a repeated-loop measurement and divide instead.

**2. Constant vs invariant TSC.** Historically the TSC counted core clocks and therefore changed rate with frequency scaling and stopped in deep C-states. Modern CPUs advertise `constant_tsc` (fixed rate independent of P-state) and `nonstop_tsc`/`invariant_tsc` (keeps running in C-states). **Check `/proc/cpuinfo` flags for `constant_tsc nonstop_tsc`** before trusting any TSC measurement; on hardware without them, TSC deltas are not time.

**3. Cross-core and cross-socket synchronization.** The TSC is per-core. Modern multi-socket systems synchronize them at reset and the kernel validates this (`tsc: Marking TSC unstable`, or the clocksource watchdog), but small offsets can exist, and a thread migrating between cores mid-measurement can produce a *negative* delta. Always pin (§43.9), and treat any negative or absurd delta as a migration, not as a measurement. Ch. 35 §35.3 covers the synchronization details.

**4. Virtualization.** Under a hypervisor, `RDTSC` may be trapped and emulated (hundreds of ns) or offset/scaled per-VM. `rdtsc` in a VM without pass-through is untrustworthy.

**5. Frequency ≠ TSC rate.** The TSC ticks at a fixed reference frequency, typically the nominal (base) frequency, *not* the current turbo frequency. A TSC delta converts to *time*, not to *core cycles*. If you want core cycles, use the PMU's `cycles` event (`CPU_CLK_UNHALTED.THREAD`) — the ratio `cycles/ref-cycles` is exactly the frequency check from §43.9.

### The alternatives, with costs

| Timer | Cost | Resolution | Notes |
|---|---|---|---|
| `rdtsc` | 15–25 cycles | ~0.3 ns | Not ordered; needs fences; per-core |
| `rdtscp` | ~30 cycles | ~0.3 ns | Ordered w.r.t. prior instructions; returns core/node id in ECX — useful to *detect* migration |
| `clock_gettime(CLOCK_MONOTONIC)` via **vDSO** | ~20–25 ns | 1 ns | No syscall (Ch. 34 §34.4); reads TSC and applies the kernel's calibration. Usually the right default. |
| `clock_gettime(CLOCK_MONOTONIC_RAW)` | ~20–25 ns, sometimes a real syscall | 1 ns | No NTP slewing; not always in the vDSO |
| `std::chrono::steady_clock::now()` | Same as above plus a little | 1 ns | Portable; `high_resolution_clock` is an alias for one of the others and should be avoided (Ch. 15 §15.11) |
| Real syscall (`clock_gettime` when not vDSO-able) | 60–100+ ns | 1 ns | Also with SPECTRE/Meltdown mitigations enabled |
| NIC hardware timestamp | 0 on the host | 1–10 ns | The only honest wire-to-wire clock (Ch. 48 §48.4) |

**Design rule for the hot path:** record raw TSC values into a preallocated array or an HdrHistogram, convert to nanoseconds offline. Never call `clock_gettime` twice per event on a critical path if a TSC pair will do, and never format or log inside the timed region.

---

## 43.13 TSC-to-Time Calibration

A TSC delta is a count of reference ticks; converting it to nanoseconds requires the TSC frequency.

### Getting the frequency

1. **From the kernel, best:** `dmesg | grep -i "tsc: Detected"` prints e.g. `tsc: Detected 2999.999 MHz processor`, and `/sys/devices/system/clocksource/clocksource0/` plus `/proc/cpuinfo` corroborate. On modern Intel, the kernel reads it from **CPUID leaf 0x15** (TSC/core-crystal ratio) and leaf 0x16 (base frequency), which is exact — no calibration error at all. Preferring the enumerated value over a measured one is the correct answer when it is available.
2. **By calibration against a known clock:**

```cpp
double calibrate_tsc_hz() {
    // Warm up and pin first. Use a long interval: error ≈ (2 × timer resolution) / interval.
    timespec ts{}; ts.tv_sec = 0; ts.tv_nsec = 200'000'000;   // 200 ms
    uint64_t c0 = rdtscp_fenced();
    auto t0 = std::chrono::steady_clock::now();
    ::nanosleep(&ts, nullptr);
    uint64_t c1 = rdtscp_fenced();
    auto t1 = std::chrono::steady_clock::now();
    double ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
    return (c1 - c0) * 1e9 / ns;
}
```

Calibration errors and their sizes:

- **Interval too short.** With ~25 ns of timer overhead at each end, a 1 ms interval gives ~5×10⁻⁵ relative error (50 ppm); a 200 ms interval gives ~0.25 ppm. Use ≥ 100 ms, and take the **median of several trials**, not the mean — a preemption during one trial poisons a mean.
- **Preemption during calibration** inflates `ns` and understates the frequency. Pin, use `SCHED_FIFO`, and reject trials whose measured frequency deviates from the median by more than a threshold.
- **Using `CLOCK_REALTIME`** — NTP slewing changes its rate by up to 500 ppm, and a step (or leap second) breaks it entirely. Calibrate against `CLOCK_MONOTONIC_RAW` if you want a rate uncontaminated by NTP discipline, or against `CLOCK_MONOTONIC` if you want to *agree* with the disciplined clock (Ch. 35 §35.5).
- **Drift.** The TSC crystal drifts with temperature at roughly 1–50 ppm. Over a trading day, 10 ppm is 0.86 s of accumulated error against a reference. For interval measurement this is irrelevant; for correlating timestamps with an external clock it is not — that is what PTP and the PHC exist for (Ch. 35 §35.8).

### Converting without a division on the hot path

Do not divide per sample. Precompute a fixed-point multiplier:

```cpp
// ns = cycles * 1e9 / hz  →  ns = (cycles * mult) >> shift
uint64_t shift = 32;
uint64_t mult  = (uint64_t)((1e9 / hz) * (1ull << shift));
uint64_t ns    = (cycles * mult) >> shift;      // one imul + one shr
```
This is exactly what the kernel's `clocksource` `mult`/`shift` mechanism does, and quoting that is a good detail. Watch for overflow: `cycles * mult` must fit in 64 bits, which bounds the representable interval — choose `shift` accordingly, or use `__int128`.

**Cross-checking is mandatory.** A ten-second run should agree with `steady_clock` to within your calibration error. Add that assertion to the harness; a wrong TSC frequency produces results that are *self-consistent and uniformly wrong by a constant factor*, which is the hardest kind of error to notice.

---

## 43.14 `perf stat`

`perf stat` counts hardware and software events over a whole execution — the correct first step, before any profiling, because it tells you *what class* of problem you have.

```bash
perf stat -d ./prog                       # detailed: adds cache and TLB events
perf stat -e cycles,instructions,branches,branch-misses,cache-references,cache-misses ./prog
perf stat -p PID -a -C 4 sleep 10         # attach, or system-wide, or per-CPU
perf stat -r 10 ./prog                    # 10 runs with mean ± stddev — use this, always
perf stat -I 1000 -e ...                  # interval printing: catches phase behavior
```

Typical output and how to read it:

```
    12,345,678,901      cycles                    #    3.001 GHz
    24,691,357,802      instructions              #    2.00  insn per cycle
     2,469,135,780      branches                  #  600.1 M/sec
        12,345,678      branch-misses             #    0.50% of all branches
       246,913,578      L1-dcache-load-misses     #    5.00% of all L1-dcache accesses
        12,345,678      LLC-load-misses           #   25.00% of all LL-cache accesses
```

### The triage table

| Symptom | Likely cause | Next step |
|---|---|---|
| **IPC < 1** | Stalled: memory, dependency chains, or mispredicts | Look at the other counters; then top-down (§43.19) |
| **IPC > 3** | Front-end/issue bound or genuinely efficient | Check if instruction count itself is too high (algorithmic) |
| **branch-misses > 1–2% of branches** | Unpredictable control flow | `perf record -e branch-misses` to localize; Ch. 42 §42.3 |
| **High `LLC-load-misses` (absolute count high)** | DRAM-bound | Layout (Ch. 42 §42.1), tiling (§42.7), prefetch (§42.8) |
| **High `dTLB-load-misses`** | Working set spans too many pages | Huge pages (Ch. 32 §32.9) |
| **High `page-faults`** | Not prefaulted / growing heap | `mlockall`, `MAP_POPULATE` |
| **`context-switches` / `cpu-migrations` nonzero** | Not isolated | §43.8 |
| **`cycles`/`ref-cycles` ≠ expected** | Frequency scaling or AVX license | §43.9, Ch. 42 §42.13 |
| **`stalled-cycles-frontend` high** | I-cache/µop-cache misses, code bloat | Ch. 40 §40.22, BOLT (Ch. 40 §40.11) |

**Instructions per cycle is a ratio, not a goal.** A change that halves the instruction count and lowers IPC from 3 to 2 is a 25% win. Optimize wall time; use IPC only to explain *why*.

**Practical cautions:** `-r N` (repeat) and the ± stddev it prints is the minimum rigor for any comparison. Counting requires `perf_event_paranoid ≤ 2` (usually needs `sysctl kernel.perf_event_paranoid=1` or `CAP_PERFMON`). Inside containers and VMs, PMU access is often unavailable — `<not supported>` in the output means the event does not exist on this hardware/hypervisor, while `<not counted>` means multiplexing gave it zero time (§43.18). Requesting more events than there are counters silently enables multiplexing and scales the numbers, which is the most common source of confusing `perf stat` output.

---

## 43.15 `perf record`, `report`, and `annotate`

`perf record` is a **sampling** profiler: it programs a PMU counter to overflow every N events and captures the instruction pointer (and optionally the call stack) at each overflow.

```bash
perf record -F 999 -g --call-graph dwarf -- ./prog     # 999 Hz, DWARF-based stacks
perf record -F 999 -g --call-graph fp -- ./prog        # frame pointers: cheap, needs -fno-omit-frame-pointer
perf record --call-graph lbr -- ./prog                 # LBR: hardware, cheapest, depth-limited (~16-32)
perf record -e cache-misses -c 10000 -- ./prog         # sample every 10k cache misses
perf record -e cycles:pp -- ./prog                     # precise (PEBS) — see §43.18
perf report --sort=dso,symbol --percent-limit 1
perf annotate -s hot_function                          # per-instruction attribution
perf script                                            # raw samples, for flame graphs (§43.16)
```

### Sampling versus instrumentation

| | Sampling (`perf record`, VTune, gprof-with-sampling) | Instrumentation (Callgrind, `-finstrument-functions`, tracing) |
|---|---|---|
| Mechanism | Periodic interrupt records the PC | Code inserted at every entry/exit or every instruction |
| Overhead | **1–5% at 1 kHz**; ~10% at 10 kHz | **10–100×** (Callgrind ~50×), or 1.5–3× for coarse function tracing |
| Bias | Statistical; misses rare events, skewed by skid | None statistically, but the probe changes the program |
| Exact call counts | No | Yes |
| Sees blocked/off-CPU time | **No** (§43.25) | Depends |
| Small functions | Under-sampled and mis-attributed | Dominated by probe cost — inlining is destroyed |
| Best for | "Where does wall time go" on a real workload | Exact call counts, cache simulation, deterministic comparison |

The decisive practical asymmetry: **sampling measures the real program; instrumentation measures a modified program.** Instrumentation disables inlining of the instrumented functions, which for C++ with lots of small methods changes the program's performance character entirely.

### Reading the output honestly

- **`-F 999` not `-F 1000`** — a prime-ish frequency avoids aliasing with periodic activity at 1000 Hz (the timer tick, a 1 kHz poll loop). Aliasing produces spectacularly wrong profiles.
- **Symbols.** Build with `-g` (or split debug info, Ch. 58 §58.6) and keep frame pointers on for cheap stacks. Without them, `--call-graph dwarf` requires copying 8 KB of stack per sample — huge file sizes and ~2–5× the overhead — and `lbr` is limited to the last 16–32 branches.
- **Inlining destroys attribution.** Time attributed to a function may belong to something inlined into it. `perf report --inline` (with good DWARF) reconstructs it; otherwise you must read `perf annotate` output against the source.
- **`perf annotate` shows a skewed instruction attribution** (§43.18): the sample lands on an instruction *after* the one that caused the event. A load's cost usually appears on the instruction that consumes the loaded value, or a few instructions later. Use `:pp` (PEBS) events to reduce this.
- **Self vs children.** `perf report` defaults to self time per symbol; `-g --children` gives inclusive time. Both are needed: self time finds the hot instruction, children time finds the hot subsystem.
- **`perf diff`** compares two recordings — the correct tool for "which function got slower after my change".

---

## 43.16 Flame Graphs

A **flame graph** (Brendan Gregg) visualizes aggregated stack traces: the x-axis is *sorted alphabetically by symbol*, not by time; width is the fraction of samples containing that frame; the y-axis is stack depth. Adjacent boxes at the same level are merged only if they share the full ancestry.

```bash
perf record -F 999 -g -- ./prog
perf script | stackcollapse-perf.pl | flamegraph.pl > out.svg
# or, since Linux 5.x, without the toolchain:
perf script report flamegraph
```

**How to read one:**
- **Width = total (inclusive) time.** A wide box is a subsystem that costs a lot; it does not mean that function is slow.
- **Plateaus (wide boxes with nothing on top) are where the CPU actually is** — those are leaf frames, i.e. self time. Look for the widest plateau, not the widest box.
- **Height is meaningless for cost.** A 40-frame-deep stack is not a problem by itself.
- **The x-axis is not time.** You cannot read a flame graph left-to-right as chronology; that is what a *flame chart* (Chrome DevTools style) does.

**Variants worth naming:**

| Variant | Shows |
|---|---|
| **Icicle graph** (inverted) | Same data drawn downward; conventional for off-CPU or for merging on leaves |
| **Differential flame graph** | Red/blue coloring of A-vs-B sample deltas — the best tool for "what got slower" |
| **Off-CPU flame graph** | Stacks aggregated by *blocked* time from scheduler tracepoints (§43.25) |
| **Hot/cold flame graph** | On-CPU and off-CPU merged, so total wall time is represented |
| **Memory/allocation flame graph** | Stacks weighted by bytes allocated (§43.23) |

**Limitations to state:** flame graphs are aggregate — they hide time-varying behavior and cannot show tail events (a 10 ms stall in a 60 s profile is 0.017% of the width and invisible). They require correct stacks, so broken frame pointers produce a flat, useless graph. And they show *on-CPU* time only unless you deliberately build the off-CPU variant, which means a program spending 95% of its wall time blocked produces a flame graph of the 5% that does not matter.

---

## 43.17 Hardware Performance Counters

The **PMU** (Performance Monitoring Unit) provides a small number of programmable counters per core (typically **4 general-purpose per thread on Intel, 8 with SMT disabled; 3 fixed counters** for `INST_RETIRED.ANY`, `CPU_CLK_UNHALTED.THREAD`, `CPU_CLK_UNHALTED.REF_TSC`; 6 general-purpose on AMD Zen), plus **uncore/offcore counters** for the L3, memory controller, and interconnect that are per-socket rather than per-core.

Events are named per microarchitecture; the authoritative sources are the Intel SDM Volume 3 Appendix, `perf list`, and the `perf` JSON event files (from Intel's `perfmon` repository). The events actually worth memorizing:

| Purpose | Intel event | perf alias |
|---|---|---|
| Retired instructions | `INST_RETIRED.ANY` | `instructions` |
| Core cycles (frequency-varying) | `CPU_CLK_UNHALTED.THREAD` | `cycles` |
| Reference cycles (fixed rate) | `CPU_CLK_UNHALTED.REF_TSC` | `ref-cycles` |
| Branch mispredicts | `BR_MISP_RETIRED.ALL_BRANCHES` | `branch-misses` |
| L1D miss | `MEM_LOAD_RETIRED.L1_MISS` | `L1-dcache-load-misses` |
| L2 miss | `MEM_LOAD_RETIRED.L2_MISS` | — |
| L3 miss (to DRAM) | `MEM_LOAD_RETIRED.L3_MISS` | `LLC-load-misses` |
| Cycles stalled on an L3 miss | `CYCLE_ACTIVITY.STALLS_L3_MISS` | — |
| dTLB miss with a page walk | `DTLB_LOAD_MISSES.WALK_COMPLETED` | `dTLB-load-misses` |
| iTLB walks | `ITLB_MISSES.WALK_COMPLETED` | `iTLB-load-misses` |
| Split loads / stores | `MEM_INST_RETIRED.SPLIT_LOADS/_STORES` | — |
| Store-forward block (4K alias) | `LD_BLOCKS_PARTIAL.ADDRESS_ALIAS` | — |
| Machine clears (incl. memory ordering) | `MACHINE_CLEARS.COUNT`, `.MEMORY_ORDERING` | — |
| False sharing / HITM | `MEM_LOAD_L3_HIT_RETIRED.XSNP_HITM` | used by `perf c2c` |
| Offcore / remote DRAM | `OFFCORE_RESPONSE.*` with response masks | `node-loads`, `node-load-misses` |
| Front-end bound | `IDQ_UOPS_NOT_DELIVERED.CORE` | `stalled-cycles-frontend` |

Two specialized facilities to name:

- **PEBS (Precise Event-Based Sampling)** — the hardware itself writes a record (registers, IP, and on later parts the data address, latency, and data source) to a buffer at the event, eliminating most interrupt skid. Requested in perf as `event:pp` or `:ppp`. Only a subset of events supports PEBS. **`MEM_TRANS_RETIRED.LOAD_LATENCY` with PEBS gives per-load latency and the cache level it was served from** — this is how you find *which* load is missing, not just that loads miss. AMD's equivalent is IBS (Instruction-Based Sampling), which is arguably better designed (it tags a random op and reports everything about it).
- **`perf c2c`** — "cache to cache", built on HITM events: it identifies the exact cache lines, offsets, and pairs of threads involved in **false sharing** (Ch. 26 §26.15). Point it at a multithreaded program and it names the struct field. This is the single best "how would you find false sharing?" answer.
- **Intel PT / ARM CoreSight ETM** — hardware *tracing* of every branch taken, giving exact control flow with ~2–5% overhead. `perf record -e intel_pt//` then `perf script --insn-trace`. The output is enormous but it gives cycle-accurate reconstruction of a rare event, which sampling cannot.

---

## 43.18 PMU Multiplexing, Skid, and Sampling Bias

Three distinct distortions that make counter data misleading. A candidate who names all three is unusual.

### Multiplexing

If you request more events than there are physical counters, the kernel **time-slices** them and **scales the results by the fraction of time each was active**:

```
perf stat output with multiplexing:
  1,234,567   L1-dcache-load-misses     (49.87%)     ← the % is the enabled fraction
```

Consequences: every count becomes an extrapolation; short-lived or bursty phenomena are systematically misestimated (a burst that happens while the event was descheduled is invisible and then scaled as if it were absent); and **derived ratios computed from events measured in different time slices are unsound** — you divided a number measured during one interval by one measured during another. Top-down analysis (§43.19) requires several events at once and is especially exposed.

Fixes: request ≤ the number of available counters (check `perf list` and remember 4/thread on Intel with SMT, 8 without); disable SMT to double them; group events with `perf stat -e '{a,b,c}'` so they are scheduled together and their ratio is meaningful; or run multiple passes over a stable, repeatable workload.

### Skid

The PMU interrupt fires *after* the instruction that caused the event, by an unpredictable distance — typically a few instructions, sometimes tens. **The sample lands on the wrong instruction.**

- Classic signature: `perf annotate` blames the instruction *after* a long-latency load, or blames a `nop`, or attributes all of a loop's cost to the loop-closing branch.
- Skid also biases toward instructions after a stall (which are the ones executing when the interrupt is finally taken), which systematically over-attributes to the *consumer* of a miss rather than the miss itself. That is sometimes what you want and sometimes badly misleading.
- **Fix: use precise events.** `:p` (some skid removed), `:pp` (PEBS, precise), `:ppp` (fully precise where supported). `cycles:pp` is the correct default for a CPU profile on Intel. On AMD, use IBS.

### Sampling bias

- **Aliasing.** A fixed sampling frequency that harmonizes with a periodic program behavior samples the same phase every time. Use a prime-ish frequency (999 Hz) and, better, event-count-based sampling with `-c` and a non-round period.
- **Interrupts are only delivered when interrupts are enabled and the core is running.** Time in interrupt-disabled kernel sections, in SMM, or off-CPU is under-sampled or invisible. A profile therefore cannot show you a stall caused by an SMI (§43.7).
- **Frequency-based sampling under a varying clock** biases toward high-frequency phases when counting cycles.
- **Skewed by thread count.** `perf record` without `-a` samples only your process; a spinning kernel thread stealing your core is invisible.
- **The observer effect on the sampled program** — see §43.26.

**The honest summary to give an interviewer:** counter data is directionally reliable and numerically approximate. Use it to form hypotheses; confirm with a controlled A/B on wall time.

---

## 43.19 Top-Down Microarchitecture Analysis

**Top-Down Microarchitecture Analysis (TMA)**, from Ahmad Yasin, is a hierarchical method that attributes every **issue slot** (a pipeline slot capable of delivering one µop per cycle; a 4-wide core has 4 slots/cycle) to exactly one of four top-level categories. It replaces the older, unreliable practice of staring at individual stall counters.

```
                  Every pipeline issue slot
                            |
        ┌───────────────────┼───────────────────┐
   µop delivered?                          not delivered
        |                                       |
   ┌────┴─────┐                        ┌────────┴────────┐
Retired    Bad Speculation        Front-End Bound   Back-End Bound
(useful)   (mispredict,           (fetch/decode      (execution can't
           machine clear)          couldn't supply)   accept more)
```

| Level 1 | Meaning | Level 2 | Typical fix |
|---|---|---|---|
| **Retiring** | Slots that produced useful work | Base / Microcode Sequencer | High is good — unless it is high because you execute too many instructions (algorithmic) |
| **Bad Speculation** | Slots wasted on wrong-path µops or machine clears | Branch Mispredict / Machine Clears | Branch elimination, PGO, sorting input (Ch. 42 §42.3); machine clears → memory ordering violations, self-modifying code, 4K aliasing |
| **Front-End Bound** | Front end could not deliver µops | Latency (I-cache/iTLB miss, µop-cache miss) / Bandwidth (decode limits, LSD) | Reduce code size, BOLT/PGO layout, `-Os` on cold code, fewer inlined giants (Ch. 40 §40.11) |
| **Back-End Bound** | Back end stalled | **Memory Bound** (L1/L2/L3/DRAM/Store bound) / **Core Bound** (divider, port saturation, dependency latency) | Memory Bound → layout, tiling, prefetch. Core Bound → break dependency chains, reduce divides, balance ports (Ch. 42 §42.10) |

Rough interpretation thresholds (Intel's guidance): investigate a category when it exceeds ~20% for Front-End or Bad Speculation, ~20% for Back-End, and consider Retiring under ~50% as room to improve. Descend only into the dominant branch — that is the whole point of the hierarchy.

**Tools:**
```bash
perf stat --topdown -a                     # L1 topdown, on supported hardware (Icelake+ has HW support)
perf stat -M TopdownL1 ./prog              # metric group; -M TopdownL2, TopdownL3 for deeper
toplev.py -l3 --no-desc ./prog             # pmu-tools (Andi Kleen) — the reference implementation
```
`toplev.py` from **pmu-tools** is the answer to "how do you do top-down on Linux": it knows the event formulas per microarchitecture, handles multiplexing by grouping and multiple runs, and prints the drill-down with thresholds applied.

**Why the hierarchy matters:** stall counters overlap and double-count — a cycle can be simultaneously "stalled on L3" and "stalled on the divider" by naive counting, and pre-TMA methodology routinely produced attributions summing to 250%. TMA's slot-based accounting is exhaustive and non-overlapping by construction. Being able to say *that* is the point of the question.

---

## 43.20 Cachegrind and Callgrind

Both are **Valgrind** tools: the program runs on a synthetic CPU under dynamic binary instrumentation, so every memory access and instruction is simulated.

**Cachegrind** simulates the cache hierarchy and branch predictor:
```bash
valgrind --tool=cachegrind --branch-sim=yes ./prog
cg_annotate cachegrind.out.PID             # per-function and per-line miss counts
```
Output: `Ir` (instruction reads), `I1mr`/`ILmr`, `Dr`/`Dw`, `D1mr`/`D1mw`, `DLmr`/`DLmw`, `Bc`/`Bcm` (conditional branches/misses), `Bi`/`Bim` (indirect).

**Callgrind** adds call-graph and per-call-site attribution; `kcachegrind`/`qcachegrind` visualizes it.
```bash
valgrind --tool=callgrind --cache-sim=yes --dump-instr=yes ./prog
callgrind_annotate callgrind.out.PID
callgrind_control -d                       # dump on demand, to skip startup
```

### The tradeoff, stated precisely

| Property | Cachegrind/Callgrind | `perf` |
|---|---|---|
| Overhead | **20–100×** (Cachegrind ~20–50×, Callgrind ~50–100×) | 1–5% |
| Determinism | **Fully deterministic and repeatable** | Statistical, noisy |
| Attribution | **Exact, per source line, no skid** | Skewed by skid |
| Fidelity | A *model*: default 2-level (I1/D1 + LL), LRU, no prefetchers, no OOO, no TLB, no store buffers, no coherence | The real machine |
| Threads | Serialized (Valgrind runs one thread at a time) — hides all concurrency effects | Real |

**Use Cachegrind when you want a stable, comparable number** — "did my layout change reduce D1 misses?" — precisely because it has no noise and no machine variance; it is excellent in CI as a regression gate. **Do not use it to predict runtime**: it models no hardware prefetcher, so it will show misses that the real machine prefetches away, and it models no out-of-order execution, so its instruction counts do not translate to cycles.

Related Valgrind tools worth naming: **DHAT** (heap allocation profiling — block lifetimes, access density, "you allocated 400 MB and read 3% of it"), **Massif** (heap size over time), and **Helgrind/DRD** (race detection, largely superseded by TSan, Ch. 44 §44.4). Memcheck is covered in Ch. 44 §44.7.

---

## 43.21 Intel VTune

**VTune Profiler** is Intel's integrated performance analyzer. What it provides that `perf` does not, out of the box:

- **Curated analysis types**: Hotspots (sampling or instrumentation), Microarchitecture Exploration (TMA, §43.19, with the correct event formulas per microarchitecture pre-encoded), Memory Access (with the **memory-object attribution** that maps misses to *which allocation/data structure*, not just which instruction), Threading (lock and wait analysis, §43.24), I/O, HPC Performance Characterization, and Anomaly Detection (fine-grained, for spotting rare long iterations).
- **Uncore and integrated-memory-controller counters** with a coherent UI: DRAM bandwidth per channel, UPI/QPI traffic, DDIO hit rate, and per-socket NUMA local/remote breakdowns — the data that is painful to assemble from raw `perf` events.
- **Source and assembly correlated views** with automatic inline expansion and correct handling of PEBS-precise events.
- **Stack sampling plus context switches**, so it can give a usable wall-clock (not just CPU) picture with less setup than off-CPU perf work.

Practical notes: `vtune -collect uarch-exploration -- ./prog` from the CLI; `vtune-cl` results are directories, importable into the GUI on another machine; collection requires a driver (`sepdk`) for full features on older kernels, or falls back to `perf_event` (with the accompanying paranoid-level and container constraints). Sampling overhead is comparable to perf (a few percent); the instrumentation-based "User-Mode Sampling and Tracing" is heavier. ITT API calls (`__itt_task_begin`/`__itt_task_end`) let you annotate regions and get per-region attribution — the equivalent of `perf`'s uprobes but far easier.

**The interview-relevant framing:** VTune's advantage is not that it sees different counters — it sees the same PMU — but that it encodes the *methodology* (correct TMA formulas, event grouping to avoid multiplexing errors, memory-object attribution) so you do not derive it yourself. Its disadvantages are Intel-only microarchitecture depth (AMD support is limited; use AMD's **µProf** there), licensing/deployment friction, and that it is not scriptable into a CI gate as easily as `perf stat -r`.

---

## 43.22 LIKWID and Intel PCM

Two lighter-weight, more surgical alternatives.

**LIKWID** ("Like I Knew What I'm Doing") is a suite of command-line tools popular in HPC:

```bash
likwid-topology -g                       # cache/NUMA topology, ASCII diagram — better than lscpu
likwid-perfctr -C 4 -g MEM_DP ./prog     # run with a named event GROUP, get derived metrics
likwid-perfctr -g L3 -m ./prog           # -m = marker API: only measure annotated regions
likwid-bench -t load -w S0:1GB:4         # microbenchmark kernels for bandwidth/latency baselines
likwid-pin -c 0-3 ./prog                 # pinning with topology-aware syntax
likwid-powermeter                        # RAPL energy
likwid-mpirun                            # per-rank counters
```

Its two distinguishing features: **performance groups** (`MEM`, `L3`, `FLOPS_DP`, `BRANCH`, `TLB`, `ENERGY`) that bundle the right events and compute derived metrics — memory bandwidth in MB/s, FLOP/s, arithmetic intensity — so you get engineering units rather than raw counts; and the **Marker API** (`LIKWID_MARKER_START("kernel")`) for per-region measurement from inside your code, which gives exact counter attribution to a code region without sampling or skid. That combination makes it the natural tool for building a **roofline model** (arithmetic intensity vs achieved bandwidth) and deciding whether a kernel is compute- or memory-bound.

**Intel PCM (Performance Counter Monitor)** targets **uncore** measurement — the things per-core counters cannot see:

```bash
pcm 1                          # per-socket: IPC, L3 hit rate, DRAM read/write GB/s, QPI/UPI, C-state residency, energy
pcm-memory 1                   # per-channel DRAM bandwidth read/write
pcm-numa                       # local vs remote memory accesses
pcm-pcie                       # PCIe traffic, DDIO hits/misses — critical for NIC work (Ch. 29 §29.25)
pcm-latency                    # memory latency estimation
pcm-power                      # RAPL, frequency, throttling reasons
```

`pcm-pcie` is the one to name in a networking context: it shows whether NIC DMA writes are landing in L3 via **DDIO** or going to DRAM, and whether DDIO's limited way allocation is thrashing — a real and hard-to-find cause of receive-path latency on high-rate feeds.

Both tools need MSR access (`modprobe msr`, root or `CAP_SYS_RAWIO`) and both will refuse to run if another agent has the counters. PCM in particular conflicts with `perf` and with the NMI watchdog (`sysctl kernel.nmi_watchdog=0` is the usual prerequisite) — a concrete operational detail worth knowing.

---

## 43.23 Allocation Profiling

Allocation is the most common hidden cost on a supposedly hot path, and it has three distinguishable costs: the CPU time of `malloc`/`free`, the **latency tail** when the allocator takes a slow path (arena lock contention, `mmap`, `madvise`, coalescing), and the **cache/TLB footprint** of the resulting layout.

| Tool | Measures | Overhead | Notes |
|---|---|---|---|
| **heaptrack** | Every allocation with stack, peak, leaks, temporary allocations | ~1.5–3× | The best general answer on Linux; GUI shows "temporary allocations" (alloc+free with nothing between) which is the actionable metric |
| **DHAT** (Valgrind) | Block lifetimes, read/write density per block, "at-peak" analysis | ~20× | Uniquely tells you *how much of what you allocated you actually touched* |
| **Massif** (Valgrind) | Heap size over time, by allocation site | ~20× | Peak-memory work |
| **jemalloc/tcmalloc built-in heap profiler** | Sampled allocation by stack | **~1–2%** (sampling) | `MALLOC_CONF=prof:true` / `HEAPPROFILE=`; the only one usable in production |
| **`perf record -e ...:malloc` / uprobes / bpftrace** | Call counts and stacks | Low | `bpftrace -e 'uprobe:libc:malloc { @[ustack] = count(); }'` |
| **`perf trace -e 'syscalls:sys_enter_mmap,brk,madvise'`** | Allocator slow paths hitting the kernel | Low | This is how you find the tail, not the mean |
| **LD_PRELOAD counting shim** | Count and size histogram | Low | Trivial to write; often sufficient |
| **`mallinfo2` / `malloc_stats` / jemalloc `stats.*`** | Arena state, fragmentation | Free | Ch. 7 §7.13 |

**The low-latency perspective:** the goal is not to make allocation fast, it is to have **zero allocations on the hot path** (Ch. 8 §8.8, Ch. 55 §55.1). The measurement that matters is therefore an *assertion*, not a profile: install a hook that counts (or aborts on) allocations between two points on the critical path.

```cpp
// A hot-path allocation tripwire: override the global operator new in test builds
static thread_local bool g_no_alloc = false;
void* operator new(size_t n) {
    if (g_no_alloc) { std::abort(); }          // or increment a counter and log offline
    if (void* p = std::malloc(n)) return p;
    throw std::bad_alloc{};
}
struct NoAllocScope { NoAllocScope(){g_no_alloc=true;} ~NoAllocScope(){g_no_alloc=false;} };
```
This finds the allocations that a *profiler* will report as 0.1% of CPU time and that are actually responsible for your p99.99, because the one in ten thousand that takes the `mmap` path costs 50 µs. **Mean allocation cost is irrelevant; the tail is the whole story.** Note the hook itself must be careful: `operator new` can be called before `main` and from the allocator's own bookkeeping, and a non-async-signal-safe abort inside it is fine for a test build and not for production.

---

## 43.24 Lock-Contention Profiling

Contention wastes time in three ways: spinning (CPU burned, visible in a CPU profile), blocking (invisible in a CPU profile — §43.25), and **convoying/cache-line bouncing** on the lock word itself even when the critical section is trivial (Ch. 24 §24.19).

```bash
# 1. Kernel-side: futex waits — the definitive view of blocking on pthread mutexes
perf lock record ./prog && perf lock report      # requires lock tracepoints / CONFIG_LOCKDEP for kernel locks
perf trace -e 'syscalls:sys_enter_futex' -p PID  # count and stack-attribute futex sleeps
bpftrace -e 'tracepoint:syscalls:sys_enter_futex { @[ustack, comm] = count(); }'

# 2. Off-CPU time attributed to lock acquisition (the general method, §43.25)
offcputime-bpfcc -p PID 30

# 3. Cache-line contention, including uncontended-but-bouncing atomics
perf c2c record ./prog && perf c2c report --stdio     # HITM analysis: names the line and the offset

# 4. Userspace instrumentation
mutrace ./prog                                    # LD_PRELOAD; reports contended mutexes, ranked
# glibc: MUTEX_DEBUG / pthread_mutex_timedlock wrappers; or your own RAII wrapper that
# records (acquire_wait_ns, hold_ns) into a per-mutex HdrHistogram
```

**What to measure per lock:** acquisition wait time (a distribution, not a mean), hold time, acquisition rate, and the number of distinct threads contending. Hold time × rate gives the utilization of the lock as a server; by Little's Law (§43.1), a lock at 80% utilization has an exploding wait-time tail exactly like any other queue. That framing — **a mutex is a single-server queue** — is the strong answer to "how do you reason about lock contention?"

**The signatures:**

| Signature | Diagnosis |
|---|---|
| High `futex` syscall rate, low CPU | Blocking contention; the mutex is going to the kernel |
| High CPU, low IPC, time in `pthread_mutex_lock`'s spin loop | Spin contention; adaptive mutex spinning before parking |
| `perf c2c` shows HITM on one line, many threads | **False sharing** (Ch. 26 §26.15) or true sharing of a hot counter |
| Long tail on one thread, others fine | **Lock convoy** or priority inversion (Ch. 24 §24.18–19) |
| Throughput *decreases* with more threads | Contention past the knee; the lock is the bottleneck and adding threads adds coherence traffic |
| Fine mean, terrible p99.9 | A rare long hold — often an allocation, a syscall, or logging inside the critical section |

The last row is the most common real finding: someone does I/O, allocates, or takes a page fault while holding a lock. **Audit critical sections for syscalls, allocation, and anything that can fault** — that is the fix more often than a lock-free redesign.

---

## 43.25 Off-CPU Profiling

A sampling CPU profiler answers "where is the CPU spending time". If your latency problem is that a thread is **not** running, the CPU profile is silent about it — this is the single largest blind spot in ordinary profiling, and off-CPU profiling closes it.

**Method:** trace the scheduler. On every `sched_switch` out, record the timestamp and the stack; on `sched_switch` in, compute the blocked duration and attribute it to that stack.

```bash
# BCC / bpftrace
offcputime-bpfcc -df -p PID 30 > out.stacks      # folded output for flamegraph.pl
flamegraph.pl --colors=io --title="Off-CPU" < out.stacks > offcpu.svg

# perf-based (higher overhead: writes a record per context switch)
perf record -e sched:sched_switch -e sched:sched_stat_sleep -g -p PID -- sleep 30
perf inject -s -i perf.data -o perf.inject.data   # merge sleep times into stacks
```

**Reading it:** the blocked stack tells you *what the thread was waiting for* — `futex_wait` (a mutex or condvar), `epoll_wait` (idle, and usually uninteresting), `read`/`write` (I/O), `nanosleep`, `page_fault` paths, or `io_schedule`. The critical filtering step is separating **involuntary** waiting (the thing you care about) from **voluntary idle** waiting (an event loop correctly sleeping). Filter by stack, or restrict to non-idle states.

**Limitations, which are important:**

- Overhead scales with **context-switch rate**, not with a sampling frequency. A program switching 1 M times/second will pay heavily; a mostly-blocked program pays almost nothing. This is the inverse of on-CPU profiling's cost model.
- **It tells you the blocked thread's stack, not the cause.** Thread A blocked in `futex_wait` does not tell you that thread B held the lock for 40 ms. **Wakeup tracing** (`wakeuptime`, `offwaketime` in BCC) records the *waker's* stack and joins them, which is what actually identifies the culprit. Chained wakeups need `offwaketime`'s multi-level variants or manual correlation.
- Runnable-but-not-running time (scheduler queueing delay) is a *third* category, distinct from both on-CPU and blocked. `runqlat`/`runqslower` (BCC) measure it, and it is the signature of oversubscription or of a `SCHED_OTHER` thread losing to something else (Ch. 31 §31.16).

**Hot/cold flame graph** = on-CPU + off-CPU merged so widths sum to wall-clock time. That is the complete picture and the right thing to name when asked "how do you profile a program that is slow but not CPU-bound?"

---

## 43.26 Probe Effects

The **probe effect** (observer effect) is the change in program behavior caused by measuring it. Every technique in this chapter has one; a defensible measurement states which, and bounds it.

| Probe | Direct cost | Indirect distortion |
|---|---|---|
| `rdtsc` pair with fences | 40–60 cycles | `LFENCE` serializes, killing OOO overlap around the region — a 20-cycle region measures as 60+ and the surrounding code slows too |
| `clock_gettime` (vDSO) | ~25 ns each | Touches vDSO data pages: extra cache lines, extra TLB entry |
| Storing a sample per event | ~5 ns | **Evicts cache lines**; a 1 M-entry array streams through and destroys your L2 |
| Logging on the hot path | 100 ns – 1 ms | Allocation, formatting, locks, I/O, page faults; changes everything |
| `perf record -F 999` | 1–3% | Interrupts flush the pipeline, perturb the branch predictor and caches; delivers samples only when interrupts are enabled |
| `perf record --call-graph dwarf` | 5–20% | Copies 8 KB of stack per sample — huge cache and bandwidth impact |
| PEBS | Low | Writes records to a memory buffer, using bandwidth and cache |
| Instrumentation (`-finstrument-functions`) | 1.5–3× | **Prevents inlining** — the program's shape changes, small functions become dominant |
| Callgrind / Cachegrind | 20–100× | Serializes threads; hides all concurrency and timing behavior entirely |
| ASan / TSan / MSan (Ch. 44 §44.2–44.5) | 2–20× | Changes layout, allocator, and timing; race windows open or close |
| `ptrace`/GDB breakpoints | Enormous per hit | Traps to the kernel; a breakpoint in a hot loop makes the program a different program |
| Off-CPU tracing | Proportional to switch rate | Adds work in the scheduler path |
| Enabling `-g` / frame pointers | ~0–2% (frame pointers cost a register) | `-fno-omit-frame-pointer` costs ~1% typically, up to 5–10% on register-starved x86 code — but it is the price of usable stacks and most shops now pay it |

### The Heisenberg cases

- **Timing changes concurrency outcomes.** A logging statement inside a critical section widens the window and can make a race reproducible — or make it disappear. "It only fails in release builds without logging" is the signature.
- **Instrumentation changes optimization.** Adding a timer around a small function forces it to exist as a function.
- **Measurement changes layout.** Adding a counter changes struct size, moving everything after it — a genuine several-percent effect (§43.8).
- **Sampling under-reports what disables sampling.** SMM, interrupt-disabled sections, and off-CPU periods.

### Building a defensible harness — the synthesis

1. **Timestamp at the earliest and latest points possible** — ideally NIC hardware RX timestamp to NIC hardware TX timestamp (Ch. 48 §48.4, §48.10), which has *zero* host probe effect and is the only true wire-to-wire measurement.
2. **Open-loop generator** with a fixed intended schedule; measure from intended start (§43.3).
3. **Two raw TSC reads and nothing else** inside the measured region; no formatting, no logging, no allocation, no branching on the result.
4. **Record into a preallocated per-thread HdrHistogram or ring buffer**; convert and aggregate offline (§43.4, §43.13).
5. **Isolate**: pinned isolated cores, fixed frequency, no turbo (for A/B), no SMT sibling, no C-states, THP off, `mlockall`, NUMA-local memory (§43.8–§43.10).
6. **Report the distribution**: p50/p90/p99/p99.9/p99.99/max, N, duration, offered load — never a mean alone (§43.2).
7. **Aggregate histograms, never percentiles** (§43.5).
8. **Run the binary many times, interleaved A/B, and give a confidence interval.** Between-run variance is usually larger than within-run.
9. **Validate the harness against a known quantity** — measure an empty operation to establish the noise floor, and measure something whose cost you know (a `nanosleep(1ms)`, a fixed-length dependency chain) to prove the clock and the conversion are right.
10. **State the probe effect** you could not remove.

The last two are what distinguish a professional result from a plausible one. A harness that cannot measure its own noise floor cannot report a 3% improvement.

---

## Key Interview Questions

1. **Why are latency and throughput not reciprocals?** — Pipelining and parallelism: many operations are in flight, so throughput can exceed 1/latency by the concurrency factor. Little's Law (`L = λW`) relates them.
2. **Why is a latency number without an offered load meaningless?** — Queueing: waiting time grows as 1/(µ−λ) and explodes above ~70–80% utilization, so the same system has completely different tails at different loads.
3. **Why report percentiles instead of the mean?** — Latency distributions are right-skewed and multi-modal; the mean describes no real request and is dominated by the tail.
4. **Why does p99 matter more than p50 at scale?** — Fan-out: with 100 parallel subrequests, ~63% of user requests hit at least one p99 event, so the service p99 becomes the user median.
5. **What is coordinated omission?** — A closed-loop harness whose request rate is slowed by the system's own stalls, so a stall is recorded once instead of once per request that should have been issued during it. Fix: measure from an intended schedule in an open loop.
6. **How much does coordinated omission distort results?** — Two orders of magnitude at p99.9 is typical: 10 000 requests at 1 ms plus one 100 ms stall reports p99.9 ≈ 1 ms instead of ≈ 90 ms.
7. **Why can you not average percentiles across hosts or time buckets?** — A quantile is a nonlinear order statistic; the p99 of a union is not a function of the members' p99s. Aggregate histograms and recompute.
8. **What makes HdrHistogram the right structure?** — O(1) lock-free recording (~5–10 ns), fixed memory, guaranteed *relative* precision at every magnitude, and exact elementwise mergeability across threads and time.
9. **What is warm in a warmed-up process?** — I/D caches, branch predictors and BTB, TLB and page tables, PLT bindings, allocator arenas, kernel socket/route state, and the CPU's P-state. Warmup is what a benchmark discards and what production must engineer.
10. **Name the top jitter sources in a pinned, isolated thread.** — Interrupts and softirqs, C-state exit (30–100 µs), THP compaction, page faults, TLB shootdown IPIs, SMT sibling activity, split locks, SMIs (invisible to the OS — read MSR 0x34).
11. **Why should you randomize the A/B order and re-run the binary?** — Thermal, frequency, and fragmentation drift get attributed to your change otherwise; and code-layout effects mean between-process variance often exceeds within-process variance.
12. **Why is `RDTSC` alone insufficient?** — It is not serializing and can be reordered; use `LFENCE;RDTSC` … `RDTSCP;LFENCE`. Also check `constant_tsc`/`nonstop_tsc`, pin the thread, and remember the TSC ticks at the reference, not the current, frequency.
13. **How do you convert TSC ticks to nanoseconds correctly?** — Prefer CPUID leaf 0x15 or the kernel's detected frequency; otherwise calibrate over ≥100 ms against `CLOCK_MONOTONIC` and take a median. Convert with a precomputed multiply-and-shift, not a divide.
14. **What does `DoNotOptimize` actually do, and what can it not prevent?** — An `asm volatile` with a `"+r,m"` operand forces the value to exist and not be folded away; `ClobberMemory` is a `"memory"` clobber for store-only work. Neither stops the CPU from overlapping iterations (so you measure throughput, not latency, unless you build a dependency chain), and neither stops the predictor from learning your inputs.
15. **Sampling versus instrumentation — when do you use each?** — Sampling (1–5%) measures the real program and answers "where does wall time go"; instrumentation (Callgrind 20–100×) gives exact deterministic counts but changes the program by preventing inlining. Use Cachegrind for stable CI regression numbers, `perf` for reality.
16. **What is PMU multiplexing and why does it corrupt derived metrics?** — With more events than counters, the kernel time-slices and scales; ratios formed from events measured in different slices are unsound. Group events with `{}` or reduce the event count.
17. **What is skid, and how do you eliminate it?** — The PMU interrupt fires some instructions after the event, misattributing samples. Use precise events (`:pp`/PEBS on Intel, IBS on AMD).
18. **Explain top-down microarchitecture analysis.** — Attribute every pipeline issue slot to exactly one of Retiring, Bad Speculation, Front-End Bound, or Back-End Bound, then descend into the dominant branch. It is exhaustive and non-overlapping, unlike raw stall counters that double-count. `perf stat -M TopdownL1` or `toplev.py`.
19. **How do you find false sharing?** — `perf c2c`, which uses HITM events to name the exact cache line, offset, and contending threads.
20. **How would you find which allocation causes your p99.99?** — Not with a mean-cost profiler: trace allocator slow paths (`mmap`/`brk`/`madvise` syscalls), use a sampling heap profiler in production, and install a hot-path allocation tripwire that aborts or counts allocations in the critical region.
21. **Your program is slow but the CPU profile is flat and idle — what now?** — Off-CPU profiling: trace `sched_switch`, attribute blocked time to stacks, and use wakeup tracing to find who held the resource. Add `runqlat` to separate blocked time from runnable-but-queued time.
22. **How do you measure a mutex?** — As a single-server queue: the distribution of acquisition wait, hold time, and rate. Hold × rate is utilization; past ~80% the wait tail explodes. Then audit critical sections for syscalls, allocation, and faults.
23. **Name three probe effects you cannot remove.** — Fences around `rdtsc` serialize the region; storing samples evicts cache lines; sampling interrupts perturb the caches and predictors and are invisible during interrupt-disabled or SMM periods.
24. **What does your measurement harness look like?** — Hardware timestamps if possible; open-loop schedule; two fenced TSC reads and nothing else in the region; per-thread HdrHistogram; isolated pinned cores with fixed frequency, no SMT, no C-states, THP off, `mlockall`, NUMA-local; percentile reporting with N and load; histogram aggregation; interleaved repeated runs with a confidence interval; and a measured noise floor.

---

## Common Traps

- **Reporting a mean latency.** It describes no request and is dominated by the tail.
- **Reporting a percentile without N, duration, or offered load.** A p99.99 from 1000 samples is the maximum in disguise.
- **A closed-loop load generator** — coordinated omission, and your p99.9 is off by 100×.
- **Timestamping at dequeue instead of arrival** — erases all queueing delay; the same bug in a different costume.
- **Averaging p99 across hosts or across time buckets.** Ship histograms, not quantiles; Prometheus `summary` is not aggregatable, `histogram_quantile` over buckets is.
- **Discarding outliers.** They are the measurement.
- **Benchmarking with turbo on, C-states on, SMT on, and no pinning** — you measured the thermal history of the machine.
- **Pinning to `-c 0,1` and getting two SMT siblings.** Check `thread_siblings_list`.
- **Not verifying frequency from inside the run.** `cycles/ref-cycles` catches throttling, AVX downclock, and a governor that did not apply.
- **Single-threaded initialization of a dataset used by all sockets** — first touch puts it all on one NUMA node.
- **`--preferred` instead of `--membind`** — a silent fallback turns a controlled experiment into an uncontrolled one.
- **Leaving automatic NUMA balancing on during a benchmark.**
- **Forgetting `DoNotOptimize`/`ClobberMemory`** — you benchmarked dead code, and the number is suspiciously round.
- **Measuring throughput and calling it latency** — independent iterations overlap in the OOO core; latency needs a dependency chain.
- **`RDTSC` without fences, without pinning, or without checking `constant_tsc`/`nonstop_tsc`.**
- **Calibrating the TSC over 1 ms** — 50 ppm error, and one preemption ruins it. Use ≥100 ms and a median.
- **Dividing to convert TSC on the hot path** instead of a precomputed multiply-shift.
- **Requesting 12 events in `perf stat`** — silent multiplexing, scaled numbers, unsound ratios.
- **Trusting `perf annotate` line attribution without a precise event.** Skid put the sample on the next instruction.
- **`-F 1000`** — aliases with the 1 kHz timer tick and other periodic activity.
- **Profiling without frame pointers or `-g`** and getting a flat, unusable flame graph.
- **Reading a flame graph left-to-right as a timeline.** The x-axis is alphabetical.
- **Using a flame graph to find a tail event.** A 10 ms stall in a 60 s profile is 0.017% of the width.
- **Predicting runtime from Cachegrind.** It models no prefetcher, no OOO, and no TLB, and it serializes threads.
- **Concluding "no lock contention" from a CPU profile** — blocked threads generate no CPU samples.
- **Doing I/O, allocating, or faulting inside a critical section** — the classic cause of a fine mean and a terrible p99.9.
- **Claiming a 3% improvement without measuring the harness's noise floor.**

---

## Compact Recall Summary

**Latency vs throughput.** Not reciprocals; concurrency separates them (`L = λW`). Every throughput mechanism — batching, coalescing, Nagle, queueing, deep pipelines — buys throughput with latency. Latency is a function of utilization and explodes past ρ ≈ 0.7–0.8, so a latency number without an offered load is not a result.

**Percentiles.** Distributions are right-skewed and multi-modal; report p50/p90/p99/p99.9/p99.99/max with N, duration, and load. Fan-out makes the service p99 the user's median (0.99¹⁰⁰ ≈ 37%). Resolving p*X* needs ≥10–100 samples beyond it.

**Coordinated omission.** A closed loop couples the generator's rate to the system's stalls, recording a stall once instead of once per omitted request; p99.9 comes out ~100× low. Fix by measuring from an *intended* schedule (open loop), or correct post-hoc with HdrHistogram's expected-interval API. It also hides in dequeue-time timestamping and in blocked-thread sampling.

**Histograms.** HdrHistogram: exponent-plus-linear-sub-bucket layout parameterized by significant digits; O(1) recording, fixed memory, guaranteed relative precision, exactly mergeable. **Never average percentiles** — aggregate histograms and recompute. Prometheus `histogram_quantile` over buckets is correct; `summary` quantiles are not aggregatable.

**Warmup and jitter.** Cold: I/D caches, BTB and predictors, TLB, PLT, arenas, kernel state, P-state. Find the warm point empirically by plotting per-iteration time. Jitter sources with magnitudes: page faults (µs–ms), THP compaction (up to 100 ms), context switch (µs), C6 exit (30–100 µs), interrupts (µs–100 µs), TLB shootdown IPIs, split locks (socket-wide), SMIs (invisible — MSR 0x34), hypervisor steal.

**Isolation.** `isolcpus`/`nohz_full`/`rcu_nocbs`, IRQs moved off, SMT off or sibling idle, C-states ≤ C1, turbo off for A/B, THP off, ASLR off, `mlockall`, `-z now`, NUMA-bound, fixed environment. Interleave A/B, re-run the binary (layout variance often exceeds iteration variance), and report a confidence interval. Verify frequency with `cycles/ref-cycles` or `turbostat`.

**NUMA.** First touch places pages on the writing thread's node — parallel-initialize with the same decomposition as the parallel compute. `numactl --membind` (strict), `numastat`, `/proc/PID/numa_maps` for ground truth, the NIC's `numa_node` for network paths, automatic NUMA balancing off.

**Google Benchmark.** `DoNotOptimize` = `asm volatile("":"+r,m"(x)::"memory")`; `ClobberMemory` = a memory clobber for store-only work. Neither prevents cross-iteration overlap (build a dependency chain to measure latency) nor predictor training. Warmup is not excluded from the reported mean.

**Timers.** `rdtsc` 15–25 cycles, unordered → `LFENCE;RDTSC` / `RDTSCP;LFENCE`; check `constant_tsc nonstop_tsc`; pin; TSC ticks at the reference frequency, not the current one. vDSO `clock_gettime` ~20–25 ns. Calibrate from CPUID 0x15 or over ≥100 ms with a median; convert via precomputed multiply-shift. NIC hardware timestamps are the only zero-probe wire-to-wire clock.

**perf.** `perf stat -r N -d` first, for triage: IPC, branch-miss rate, LLC misses, dTLB misses, page faults, context switches, `cycles/ref-cycles`. Then `perf record -F 999 -g` (frame pointers or LBR; DWARF is expensive), `perf report --children`, `perf annotate` with a `:pp` event, `perf diff` for A/B. Flame graphs: width = inclusive samples, plateaus = self time, x-axis alphabetical, aggregate-only so tails are invisible.

**Counters and their distortions.** 4 GP counters/thread on Intel (8 with SMT off) + 3 fixed; multiplexing scales results and invalidates cross-slice ratios; skid misattributes samples (fix with PEBS `:pp` / AMD IBS); sampling is blind to SMM, interrupt-disabled sections, and off-CPU time. Know `MEM_LOAD_RETIRED.L3_MISS`, `CYCLE_ACTIVITY.STALLS_L3_MISS`, `DTLB_LOAD_MISSES.WALK_COMPLETED`, `LD_BLOCKS_PARTIAL.ADDRESS_ALIAS`, `MACHINE_CLEARS.*`, `XSNP_HITM`, `OFFCORE_RESPONSE`. `perf c2c` finds false sharing by line and offset; Intel PT gives exact control-flow traces.

**Top-down.** Every issue slot → Retiring / Bad Speculation / Front-End Bound / Back-End Bound (→ Memory Bound vs Core Bound). Exhaustive and non-overlapping, unlike raw stall counters. `perf stat -M TopdownL1`, `toplev.py -l3`.

**Other tools.** Cachegrind/Callgrind: 20–100×, deterministic, exact per-line attribution, but a cache *model* with no prefetcher, no OOO, no TLB, serialized threads — great as a CI regression gate, useless for predicting runtime. DHAT for allocation density, Massif for peak. VTune for curated TMA, memory-object attribution, and uncore. LIKWID for performance groups, the Marker API, and roofline. Intel PCM for uncore, per-channel DRAM bandwidth, UPI, and `pcm-pcie` DDIO analysis.

**Allocation and locks.** The goal is zero hot-path allocations; assert it with a tripwire rather than profiling a mean. Find tails by tracing `mmap`/`brk`/`madvise`. Treat a mutex as a single-server queue — measure wait distribution, hold time, and rate; past ~80% utilization the tail explodes; the usual root cause is a syscall, an allocation, or a fault inside the critical section.

**Off-CPU.** CPU profiles are silent on blocked time. Trace `sched_switch`, attribute blocked duration to stacks, and use wakeup tracing to find the culprit rather than the victim; `runqlat` separates runnable-but-queued from blocked. Merge with on-CPU for a hot/cold graph that sums to wall time.

**Probe effects.** Fences serialize; sample storage evicts cache; sampling interrupts perturb caches and predictors; instrumentation prevents inlining; sanitizers change layout and timing; adding a counter changes struct size and code layout. The defensible harness: earliest/latest timestamps, open-loop schedule, two fenced reads and nothing else, preallocated per-thread histogram, full isolation, distribution reporting, histogram aggregation, interleaved repeated runs with confidence intervals, a measured noise floor, and an explicit statement of the probe effect you could not remove.
