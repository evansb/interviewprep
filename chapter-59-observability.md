# Chapter 59 — Observability

*Interview-focused revision notes. The theme: every measurement perturbs the thing measured, and in a system whose end-to-end budget is a few microseconds the probe's cost is a first-class design constraint — so observability becomes an exercise in moving work off the hot path rather than in collecting more data.*

---

## 59.1 Metrics Types and Semantics

A **metric** is a numeric time series describing a system property. Four semantic kinds dominate, and confusing them is the most common conceptual error:

| Kind | Semantics | Hot-path cost | Aggregation across instances |
|---|---|---|---|
| **Counter** | Monotonically increasing total (orders sent, packets dropped) | one `++` on a thread-local | sum |
| **Gauge** | Instantaneous value (queue depth, position, free descriptors) | one store | **not summable** in general; last-value or sum depending on meaning |
| **Histogram** | Distribution of observations (latency) | bucket index + `++` (§59.4) | mergeable if bucket boundaries match |
| **Summary / quantile** | Pre-computed quantiles at the source | expensive (needs sorted state) | **not mergeable** — averaging p99s is meaningless |

The **counter vs gauge** distinction matters because counters are *resettable-safe*: a monotonic counter plus a timestamp lets the collector compute a rate and correctly handle process restarts (a decrease implies a reset). A gauge sampled at 1 Hz simply misses everything that happened between samples, which for a system operating at microsecond scale is essentially all of it. **Anything you care about the tail of must be a counter or a histogram, never a gauge.**

The **summary is the trap.** Prometheus-style summaries compute quantiles in the process, which means (a) you pay the cost in the process, and (b) the resulting numbers cannot be combined. If eight strategy processes each report p99 = 4 µs, the fleet p99 is *not* 4 µs and cannot be derived. Histograms with fixed shared bucket boundaries are mergeable by construction — sum the bucket counts, then interpolate. This is why every serious latency pipeline ships histograms, not quantiles (§59.4).

### Semantics that must be nailed down

- **Unit and scale.** Store nanoseconds as `uint64_t`; never store a pre-divided float. Division loses precision and hides the true distribution. Name the metric with its unit (`order_ack_latency_ns`).
- **Monotonicity across restart.** Export a `process_start_time` gauge alongside counters so a collector can distinguish "counter reset" from "counter wrapped."
- **Counter width.** 64-bit. A 32-bit packet counter at 10 Gbps line rate wraps in about five minutes.
- **Delta vs cumulative.** Cumulative (report the running total, let the collector difference) is robust to lost scrapes; delta (report the increment since last scrape) silently loses data if a scrape fails. Prefer cumulative.

### The cost model

A metric update on the hot path should be a single non-atomic increment to a thread-local or per-core cache line:

```cpp
struct alignas(64) CoreCounters {          // one line per core, no false sharing (Ch. 3 §3.3)
    uint64_t orders_sent;
    uint64_t rejects;
    uint64_t md_msgs;
    char pad[64 - 3 * sizeof(uint64_t)];
};
inline CoreCounters& my() noexcept;        // thread_local or indexed by core id
// hot path:
++my().orders_sent;                        // ~1 cycle, no lock, no atomic, no cache-line contention
```

A `std::atomic<uint64_t>` increment shared between threads is a locked RMW: ~20 cycles uncontended, and under contention it serializes the cache line across cores at ~100 ns per hop (Ch. 28). A `std::map<std::string, Counter>` lookup on the hot path is a hash or tree traversal plus a possible allocation — three orders of magnitude too expensive. **The metric handle must be resolved at construction time, not at update time**; the hot path holds a pointer or index, never a name. This single point separates candidates who have instrumented a real hot path from those who have used a metrics library.

---

## 59.2 High-Cardinality Metrics

**Cardinality** is the number of distinct time series a metric produces: the metric name multiplied by the cross-product of its label values. `order_latency{symbol, venue, strategy, side}` with 8000 symbols, 6 venues, 40 strategies, 2 sides is 3.8 million series — each of which the backend stores, indexes, and retains.

The cost is borne in three places:

| Location | Cost of high cardinality |
|---|---|
| **Hot path** | Label lookup becomes a hash of a string tuple; the counter is no longer a fixed address. Allocation on first sight of a new label set. |
| **Process memory** | One counter/histogram per series. A 200-bucket histogram × 3.8 M series = gigabytes. |
| **Backend** | Prometheus/InfluxDB index explosion; ingestion falls over. This is the standard way monitoring systems die. |

### The hot-path structure that makes it survivable

Never key metrics by string at runtime. Key them by a dense integer id you already have:

```cpp
// Symbols are already interned to a dense id for the book (Ch. 50 §50.13).
// Metrics reuse that id — the "label lookup" is an array index.
struct SymbolMetrics { uint64_t fills; uint64_t rejects; Histogram ack_ns; };
std::vector<SymbolMetrics> per_symbol;      // sized at startup, index = symbol_id
per_symbol[sym].fills++;                    // 1 load + 1 add + 1 store
```

This turns unbounded cardinality into a bounded, preallocated array, and it makes the hot path allocation-free — the property that actually matters (Ch. 7). Cardinality is then a *memory* problem, not a *latency* problem, and memory problems are tractable.

### Reducing cardinality without losing information

- **Drop the label at export, keep it in the log.** The dimension that matters for post-hoc analysis (order id, client id) belongs in the event stream (§59.5), not in a metric. Metrics answer "is the system healthy"; events answer "what happened to *this* order." Conflating them is the root cause of most cardinality explosions.
- **Bucket the label.** Replace `symbol` with `liquidity_tier`, replace `client_id` with `client_class`. Three values instead of 40 000.
- **Top-K with an overflow bucket.** Track the 100 busiest symbols exactly and aggregate the rest into `other`. A Space-Saving / Misra-Gries counter (Ch. 22) does this in fixed memory.
- **Exemplars.** Keep the aggregate histogram low-cardinality, but attach a handful of full-detail sample records (trace id, symbol, timestamp) to the tail buckets. You get "p99.9 is 40 µs" *and* "here are five specific orders that took 40 µs" for the price of a few slots. This is the single highest-value pattern in latency observability and is worth naming explicitly in an interview.

### The unbounded-label failure mode

**Diagnostic signature:** process RSS grows monotonically and without bound; the growth rate tracks message rate; a heap profile (Ch. 58) shows the allocation site inside the metrics registry; the monitoring backend simultaneously reports rising ingestion lag and index size. The cause is almost always a label derived from an unbounded input — an order id, a timestamp, a client-supplied string, or an error message used as a label value. **Any label whose value comes from the network is a bug.** Validate at registration: assert that the label's value set is drawn from a closed enumeration known at startup.

---

## 59.3 Per-Core Metrics Aggregation

Sharding counters per core (or per thread) removes contention but creates a **read-side consistency** problem: aggregating N shards is not atomic, so the sum you read never corresponds to any single instant.

### The layout

```
core 0: [ orders | rejects | md | pad ...... ] ← 64 B, exclusive-owned line
core 1: [ orders | rejects | md | pad ...... ]
...
reader:  sum over cores  → one shared-read of each line (~100 ns each, cold)
```

The write side is a plain non-atomic increment because only the owning thread writes. The read side is done by a separate, non-latency-critical collector thread.

### The formal problem: it is a data race

A non-atomic write on core 0 concurrently with a non-atomic read on the collector thread is a data race and therefore UB (Ch. 25). It "works" on x86 because aligned 64-bit loads and stores are atomic in hardware, but the compiler is entitled to tear, duplicate, or invent the load. The correct construction costs nothing on x86:

```cpp
struct alignas(64) Shard {
    std::atomic<uint64_t> orders{0};
    // writer (owner only):
    void inc() noexcept {
        orders.store(orders.load(std::memory_order_relaxed) + 1,
                     std::memory_order_relaxed);   // compiles to a plain inc/add on x86
    }
};
```
`relaxed` atomics generate identical code to plain accesses for loads and stores on x86-64 and ARM (no fences, no `lock` prefix) while removing the UB and the tearing risk. **"Use relaxed atomics for per-core counters — same instruction, defined semantics"** is a strong, precise answer.

### Consistency guarantees you can and cannot offer

| Property | Achievable? |
|---|---|
| Each shard's value is a real value that existed | Yes (relaxed atomic load) |
| The sum equals the true total at some instant | **No** — shards are read at different times |
| The sum is monotonically non-decreasing across reads | Yes, if every shard is monotonic |
| Two different counters are mutually consistent (`sent >= acked`) | **No** — you can observe `acked > sent` |

That last row causes real alarm noise: a derived metric like `fill_ratio = fills / orders` can transiently exceed 1.0, or a "leaked orders" gauge computed as `sent - acked` can go negative. Fixes: (a) accept and clamp, (b) read counters in a fixed order that makes the skew's sign harmless (read `sent` before `acked` so `sent - acked` is biased non-negative), or (c) use a **sequence-number snapshot**: the owner bumps an even/odd seqlock around a batch update and the reader retries on a torn read (Ch. 26). The seqlock costs the writer two extra stores and a compiler barrier — usually too much for a per-message counter, appropriate for a per-batch snapshot of a struct.

### Aggregation cost and cadence

Reading N shards touches N cache lines that are in **Modified** state in other cores' caches, so each read is a coherence miss costing ~100–300 ns and — crucially — it **downgrades the owner's line to Shared**, so the owner's next increment takes a fresh RFO (Ch. 28). Scraping 64 shards every second is negligible. Scraping every millisecond puts a periodic ~20 µs coherence storm into the hot path's cache. **Scrape cadence is an observer-effect knob**: 1 Hz is normal, 10 Hz is defensible, 1 kHz means the monitoring is now part of the latency distribution. Pin the collector thread to a non-trading core (Ch. 31) and never let it run on an isolated core.

---

## 59.4 Latency Histograms in Production

An average latency is nearly useless: the distribution is heavy-tailed and multi-modal (cache-warm vs cache-cold, page-fault, interrupt, GC-equivalent pauses), so the mean sits in a region where no actual sample lives. Production latency measurement means **histograms**, and reporting p50/p99/p99.9/p99.99/max.

### The structure

**HdrHistogram** (High Dynamic Range) is the reference design: it stores counts in buckets whose width grows exponentially while guaranteeing a fixed *relative* precision. Conceptually, the value is split into an exponent (bucket index) and a mantissa (sub-bucket index):

```cpp
// significant_bits = 3 → 2^3 = 8 sub-buckets per power of two → ≤ ~6% relative error
inline int index(uint64_t v) noexcept {
    int e = 63 - __builtin_clzll(v | 1);          // LZCNT: 1 cycle
    int sub = (v >> (e - 3)) & 7;                 // top 3 bits below the leading one
    return (e << 3) | sub;
}
void record(uint64_t v) noexcept { ++counts[index(v)]; }   // ~4 instructions, no branch, no atomic
```

Covering 1 ns to 60 s at 3 significant bits needs a few hundred `uint64_t` — a handful of cache lines, comfortably resident. The recording cost is **~2–4 ns**, which is the number to quote.

Alternatives and their trade-offs:

| Structure | Record cost | Accuracy | Mergeable | Notes |
|---|---|---|---|---|
| Linear buckets | ~2 ns | Poor at the tail unless huge | Yes | Fine when the range is known and narrow |
| **HdrHistogram / log-linear** | 2–4 ns | Fixed relative error | Yes | The default choice |
| t-digest | ~50 ns+ | Excellent near 0 and 1 | Yes (approximately) | Too expensive for a hot path; good for a collector |
| Reservoir sampling | ~10 ns | Loses the tail — the tail is rare and sampling drops it | No | **Wrong tool for tail latency** |
| Store every sample | ~1 ns (ring append) | Exact | Yes | Memory-bounded; the flight recorder pattern (§59.13) |

### Coordinated omission

The subtlest and most interview-relevant trap. If your measurement loop is *"send request, wait for response, record elapsed"*, then a 10 ms stall causes you to send **fewer** requests during the stall. The slow period is under-sampled: one bad sample instead of the thousand requests that *would* have been delayed had you kept to schedule. The reported p99 can be off by orders of magnitude.

The fix is to measure against the **intended** start time, not the actual one:

```cpp
// Correct: schedule is fixed; latency is measured from when the request SHOULD have gone out.
for (uint64_t i = 0; ; ++i) {
    uint64_t due = start + i * interval_ns;
    busy_wait_until(due);
    uint64_t t0 = rdtscp();
    send_and_await();
    hist.record_corrected(rdtscp() - t0, /*expected_interval=*/interval_ns);
}
```
`record_corrected` backfills synthetic samples at `v - interval`, `v - 2*interval`, … for any observation exceeding the expected interval. HdrHistogram implements this directly. In a live trading system the equivalent is measuring from the **hardware receive timestamp of the market-data packet that triggered the order** (§59.6), not from the moment your code got around to looking at it — that timestamp is schedule-independent and immune to coordinated omission by construction.

### Reporting discipline

- **Never average percentiles across time or instances.** Merge the raw bucket counts, then compute.
- **Report max alongside p99.99.** For a system doing 10⁶ events/day, p99.99 still hides 100 events; max is the one number a risk officer will ask about.
- **Reset semantics:** keep both a cumulative histogram (since start) and an interval histogram (since last scrape). Emitting only cumulative makes a recent regression invisible under a day of good data; emitting only interval loses the session view.
- **Record what the histogram is of.** "Tick-to-trade" must state both endpoints: NIC hardware RX timestamp → NIC hardware TX timestamp is the only definition that is comparable across firms.

---

## 59.5 Structured and Binary Logging

Text logging is the single most common hot-path performance bug. `fprintf`-style logging costs, per call: format-string parsing, integer-to-decimal conversion (~20–50 ns per field), a `snprintf` into a buffer, a timestamp syscall or `clock_gettime` (Ch. 35), a mutex, and a `write` (Ch. 34) — **1–10 µs**, with a tail into milliseconds when the disk or the pipe backs up. That is the entire latency budget, spent describing the latency budget.

**Structured logging** means emitting typed key-value records rather than prose, so downstream tools can query without regex. **Binary logging** means deferring the *formatting* entirely: the hot path writes raw argument bytes plus an identifier for the format string, and an offline or off-thread process reconstructs the text.

### The deferred-formatting design

```cpp
// Compile-time: the format string is interned into a static section; the hot path
// never touches its characters.
#define LOG_INFO(fmt, ...)                                            \
    do {                                                              \
        static constexpr LogSite site{__FILE__, __LINE__, fmt};       \
        log_binary(&site, __VA_ARGS__);                               \
    } while (0)

// Runtime, per record: [ uint32 site_id ][ uint64 tsc ][ packed args ... ]
template <class... Ts>
inline void log_binary(const LogSite* s, Ts... args) noexcept {
    auto* p = ring.claim(sizeof(Header) + (sizeof(Ts) + ...));   // may fail → drop (§59.7)
    if (!p) { ++dropped; return; }
    write_pod(p, Header{s->id, rdtsc()});                        // no clock_gettime
    (write_pod(p, args), ...);                                   // memcpy of trivially-copyable args
    ring.commit(p);
}
```

Cost: a TSC read (~15–20 cycles, `rdtsc` unserialized), a ring reservation (one relaxed CAS or, on an SPSC ring, a plain store), and a few `memcpy`s. **Total ~10–30 ns.** Two to three orders of magnitude cheaper than `fprintf`.

This is exactly what **NanoLog**, **Quill** (in its macro-based mode), **Binlog**, and most in-house HFT loggers do. NanoLog's published figure is ~7 ns per log call for the staging path; Quill and spdlog's async mode land in the tens to low hundreds of nanoseconds because they still format eagerly or copy strings.

| Logger design | Hot-path cost | Notes |
|---|---|---|
| `printf`/`ostream`, synchronous | 1–10 µs | Formatting + syscall + lock on the critical path |
| `spdlog` async | ~200 ns–1 µs | Formats on the caller side by default; queue is MPMC |
| `Quill` | ~20–50 ns | Defers formatting to a backend thread |
| **NanoLog-style binary** | **~7–20 ns** | Defers formatting *and* string parsing to an offline decompressor |
| Hand-rolled SPSC binary ring | ~10 ns | Best case; requires per-thread rings (§59.6) |

### Constraints the design imposes

- **Arguments must be trivially copyable** (Ch. 3 §3.5). You cannot log a `std::string` by reference — the string may be destroyed before the backend formats it. Options: copy the bytes into the ring (bounded length, costs the copy), or intern the string to an id. Logging a `const char*` pointing to a string literal is safe; logging one pointing to a stack buffer is a use-after-free with a *delayed, non-reproducible* signature.
- **The decoder needs the exact binary.** The site table lives in the executable (or an extracted sidecar dictionary). If you log with build A and decode with build B, the ids are wrong and you get plausible-looking garbage. **Ship the dictionary with the artifact and stamp both with the same build id** (Ch. 60 §60.1) — this is the single most common operational failure of binary logging.
- **Timestamps are raw TSC.** Conversion to wall-clock happens at decode time using a captured (TSC, CLOCK_REALTIME) pair plus the measured TSC frequency; see §59.9 for why this is harder than it looks.
- **Log-level filtering must be a predictable branch.** `if (level < threshold) return;` with the threshold in a hot cache line and the branch trivially predicted costs ~1 cycle. Using `[[unlikely]]` and keeping the argument evaluation *inside* the macro guard is essential — otherwise you pay for computing arguments to messages you discard.

---

## 59.6 Lock-Free Logging Queues

The queue between the hot path and the log backend determines whether logging can stall a trading thread. The goal is **wait-free on the producer side**: the producer's worst case must be bounded and must never depend on another thread's progress.

### SPSC per-thread rings are the right default

```
thread A ──▶ [ ring A ]  ┐
thread B ──▶ [ ring B ]  ├──▶ backend thread: poll all rings, merge by TSC, format, write()
thread C ──▶ [ ring C ]  ┘
```

An SPSC ring (Ch. 26) needs no atomic RMW at all — the producer does a relaxed load of the consumer's index, writes data, then a `release` store of its own index; the consumer mirrors it. On x86 the release store is a plain `mov`. **Producer cost: ~5–10 ns, wait-free, zero contention.** Contrast with an MPMC queue, where every producer does a `lock xadd` or CAS loop on a shared head — 20 cycles uncontended, unbounded under contention, and it drags a shared cache line across every logging core.

Design points that matter:

- **Cache-line separate the head and tail indices** (`alignas(64)`), or producer and consumer ping-pong the same line and you have reintroduced the contention you removed (Ch. 3 §3.3).
- **Cache the opposite index.** The producer keeps a local copy of the last-seen consumer index and only re-reads the shared one when its local copy says the ring is full. This turns a shared-line read per message into one per lap.
- **Power-of-two capacity** so wraparound is a mask, not a modulo. Use free-running 64-bit indices and mask on access — this removes the full/empty ambiguity without a wasted slot.
- **Variable-length records** need a claim/commit protocol with a length prefix and a wrap marker (a record that would straddle the end is preceded by a "skip to start" filler). Alternatively use fixed-size slots and pay the internal fragmentation; fixed slots are meaningfully simpler and usually the right call.
- **Huge pages for the ring** (Ch. 32): a 4 MB ring in 4 KB pages is 1024 TLB entries; in 2 MB pages it is 2. Log records are written to cold parts of the ring by definition, so TLB misses are otherwise routine.
- **Non-temporal stores** (`_mm_stream_si64`) for the payload avoid pulling ring lines into L1/L2 and evicting the hot path's working set. Real win when the ring is large and never re-read by the producer; measure, because the store buffer behaviour differs across microarchitectures (Ch. 42).

### Backend thread discipline

The backend does the expensive work: format, compress, `write()`. It must be pinned to a housekeeping core, never an isolated trading core, and must not be the same core as an interrupt-handling sibling hyperthread (Ch. 31, Ch. 35). Give it a **batched, timed flush**: drain all rings, sort the batch by TSC, `writev()` once. A per-record `write()` costs a syscall (~1 µs after Spectre/Meltdown mitigations, Ch. 34) and destroys throughput.

**Backpressure is the design decision.** Three options, in order of preference for trading systems:

| Policy | Behaviour when the ring is full | Verdict |
|---|---|---|
| **Drop and count** | Producer returns immediately, `++dropped` | **Correct default.** Latency is bounded; loss is measured (§59.7) |
| Block | Producer spins or sleeps until space | Never on a trading thread — the log backend now owns your tail latency |
| Grow (allocate) | Producer allocates a new segment | `malloc` on the hot path plus unbounded memory; a page fault here is a 10 µs stall |

**Failure signature of a blocking logger:** the latency histogram grows a distinct secondary mode at exactly the disk/pipe flush interval, and perf (Ch. 43) shows the trading thread in `futex_wait` or spinning in the queue's push. Correlating a p99.9 spike with log volume, not market volume, is the tell.

---

## 59.7 Log Sampling and Drop Accounting

Under a burst — a market open, a fat-finger order storm, an error loop — log volume can rise by two orders of magnitude at exactly the moment you most need the data. The system must degrade in a *measured*, not silent, way.

### Drop accounting is mandatory

An unaccounted drop is worse than no logging: it produces a record that looks complete and is not, and every subsequent reconstruction is wrong. The minimum contract:

```cpp
struct RingStats {
    uint64_t enqueued;      // records accepted
    uint64_t dropped;       // records rejected because the ring was full
    uint64_t bytes_dropped;
    uint64_t first_drop_tsc, last_drop_tsc;   // the outage window
};
// The backend emits a synthetic record whenever dropped changes:
//   [GAP] 14,203 records dropped between t=... and t=... on thread md-0
```

That synthetic gap record is the deliverable. It makes the hole visible in the log stream itself, so an analyst reading the file cannot mistake absence for silence. Export `dropped` as a counter (§59.1) and **alert on any non-zero value** — drops in a correctly-sized system are a bug, not a routine condition.

### Sampling strategies

| Strategy | Mechanism | Keeps the tail? | Cost |
|---|---|---|---|
| **Rate limiting (token bucket)** | N records/sec per site; excess dropped | No — drops are burst-correlated, i.e. exactly the interesting period | ~2 ns |
| **Deterministic 1-in-N** | `if ((++n & (N-1)) == 0)` | Statistically, but each individual event may be lost | ~1 ns |
| **Log-and-suppress-duplicates** | First occurrence logged, repeats counted | Yes for the first instance | hash lookup |
| **Tail-biased / conditional** | Always log if latency > threshold, sample otherwise | **Yes, by construction** | one compare |
| **Head-based trace sampling** | Decide at request entry, propagate the decision | Uniformly, not tail-biased | ~1 ns |
| **Tail-based trace sampling** | Buffer the whole trace, decide after it completes | Yes | Buffering cost at the collector |

For latency work, the **conditional/tail-biased** policy is dominant and cheap:

```cpp
uint64_t elapsed = t_out - t_in;
if (elapsed > slow_threshold_ns) [[unlikely]] LOG_SLOW(order_id, elapsed, stage_tsc);
hist.record(elapsed);                                   // always
```
You get the full distribution from the histogram and full detail on every outlier, at the cost of one predicted-not-taken branch. Pair it with **exemplars** (§59.2) so the histogram bucket links to the detailed record.

The "log first occurrence, count the rest" pattern deserves emphasis because the classic incident is a per-message error log inside a loop that is now firing on every message: the logging itself becomes the outage. A per-site token bucket with a suppression counter (`... [repeated 1,204,331 times]`) bounds the damage and preserves the count.

### Where drops actually happen

There are four independent queues, and each drops differently — an interview favourite because most candidates know only the first:

```
NIC RX ring ──▶ kernel socket buf ──▶ app ring ──▶ log ring ──▶ file ──▶ collector
   (ethtool -S       (netstat -s        (RingStats)  (RingStats)   (disk    (ingest
    rx_dropped)       drops)                                        full)     lag)
```
Ch. 46 covers the first two; §59.13 and Ch. 60 §60.13 cover the last. A "missing log lines" report must be triaged against all of them, and each has a distinct counter you should be able to name.

---

## 59.8 Sequence and Timestamp Event Correlation

Reconstructing what happened means joining events from multiple threads, processes, and machines into a single ordered narrative. Timestamps alone cannot do this; sequence numbers alone cannot either. You need both.

### Why timestamps are insufficient

- TSC values from different cores are only comparable if the TSC is **invariant and synchronized** (`constant_tsc`, `nonstop_tsc`; Ch. 35). It is, on modern single-socket x86 — but across sockets the sync is firmware-dependent, and after a socket-level C-state transition or a live migration it can jump.
- Two events genuinely 3 ns apart cannot be ordered by a clock whose read cost is 15 ns and whose resolution is ~0.3 ns but whose *serialization* is not guaranteed. `rdtsc` may be reordered by the CPU; `rdtscp` and `lfence; rdtsc` are the serialized forms and cost more (Ch. 35).
- Wall-clock (`CLOCK_REALTIME`) is not monotonic — NTP steps and leap seconds move it backwards.

### Why sequence numbers are insufficient

A per-thread sequence number orders that thread's events but says nothing about interleaving. A **global** sequence number is a shared atomic increment: 20+ cycles and a contended cache line, which is precisely the cost you were avoiding.

### The working construction

1. **Per-thread monotonic sequence + per-thread TSC.** Cheap, exact within a thread, and the TSC gives approximate cross-thread ordering.
2. **Causal identifiers threaded through the flow.** A `trace_id` (128-bit, generated once at ingress from the market-data packet) plus a per-hop `span_id` and `parent_id`. Copying 16 bytes is far cheaper than a global atomic and gives exact causality rather than approximate temporal order.
3. **The originating packet's hardware timestamp as the anchor** (§59.6, §59.7 of Ch. 48). Every downstream event carries the trigger packet's NIC RX timestamp, so end-to-end latency is computed against a clock that is the *same physical clock* for every machine on the PTP domain.

```cpp
struct EventHdr {
    uint64_t trace_id_lo, trace_id_hi;   // set once at ingress from md packet
    uint64_t trigger_hw_ts;              // NIC RX timestamp of the causing packet
    uint64_t tsc;                        // local TSC at this event
    uint32_t seq;                        // per-thread monotonic
    uint16_t thread_id, site_id;
};
```
32–40 bytes, all trivially copyable, all writable in a couple of stores. This header is what makes a binary log (§59.5) reconstructible into a causal graph rather than a pile of lines.

### Reconstruction and its pitfalls

- **Merge by TSC after converting each host's TSC to the PTP domain** (§59.9), not by arrival order at the collector.
- **Ties are common** at nanosecond resolution when events are pipelined; break them with (thread_id, seq) so the ordering is total and deterministic.
- **Exchange sequence numbers are the ground truth for market data.** Gap detection on the exchange's own sequence number (Ch. 37) is what tells you a multicast packet was lost; your internal sequence numbers cannot detect that.
- **Clock skew shows up as negative durations.** If a reconstructed span has `end < start`, you have a clock-domain bug, not a fast machine. Assert on it and count it; a rising count of negative spans is the cleanest possible signal that PTP has degraded (§59.9).

---

## 59.9 Clock-Domain Uncertainty

A **clock domain** is a set of timestamps that are meaningfully comparable to each other. Every end-to-end latency number is a subtraction of two timestamps, and if they come from different domains the result carries the domains' offset error, not just the true latency.

The domains present in one trading host:

| Domain | Source | Resolution | Comparable to |
|---|---|---|---|
| **TSC** | CPU counter, per-socket | ~0.3 ns | Other cores on the same socket (if invariant TSC) |
| **CLOCK_MONOTONIC** | kernel, TSC-derived | ~1 ns | Same host only; unaffected by NTP steps |
| **CLOCK_REALTIME** | kernel, NTP/PTP-disciplined | ~1 ns | Other hosts, to within sync error; **can step** |
| **NIC PHC** (PTP hardware clock) | NIC oscillator, PTP-disciplined | ~1–8 ns | Other PHCs in the PTP domain, to tens of ns |
| **Exchange timestamps** | Exchange's clock | µs typically | Nothing of yours, except via a regulatory sync bound |
| **Switch timestamps** | Cut-through switch (Ch. 39) | ~1 ns | Its own PTP domain |

### The error budget

End-to-end "wire-to-wire across two hosts" via PHC timestamps carries:
- **PTP sync error** between the two PHCs: 10–100 ns typical with hardware timestamping and a boundary-clock-capable switch; microseconds with software PTP or a transparent-clock-less path.
- **PHC-to-TSC translation error** if you cross domains, from the `PTP_SYS_OFFSET_PRECISE` ioctl's own sampling window (tens of ns) plus drift between reads.
- **Oscillator drift** between disciplining events: a 100 ppb oscillator drifts 100 ns per second.

So a measured 2 µs cross-host latency has an uncertainty of perhaps ±50 ns. **A measured 200 ns cross-host latency is not measurable at all by that method** — the error dominates. This is why serious tick-to-trade measurement uses a **single external instrument**: a passive tap feeding one capture device (Corvil, Exablaze/Cisco Nexus SMARTNIC, Napatech, Solarflare with `sfptpd`) that timestamps *both* the inbound market-data packet and the outbound order with the *same* oscillator. One clock, no domain crossing, no sync error. Naming this trade-off — "if I need sub-100 ns confidence I must measure both endpoints with one clock" — is the mark of someone who has actually built the measurement rig.

### Practical mechanics

```cpp
// Correlating TSC to PHC once, then extrapolating. Do this off the hot path, periodically.
struct ClockPair { uint64_t tsc; uint64_t phc_ns; };
// ioctl(fd, PTP_SYS_OFFSET_PRECISE, &req)  → hardware-assisted, ~tens of ns of window
// TSC frequency: derived from CPUID leaf 0x15, or measured against CLOCK_MONOTONIC over ≥1 s.
```
- **Never derive TSC frequency by a short calibration loop.** A 10 ms calibration has ~100 ppm error, which is 100 µs of drift per second of extrapolation. Use CPUID 0x15 where available, or calibrate over seconds and re-fit continuously (linear regression over a window of pairs) so you track drift.
- **Re-anchor periodically** and store the anchor pairs *in the log stream* so decoding is reproducible after the fact.
- **`clock_gettime` via vDSO** is ~20–25 ns and gives CLOCK_MONOTONIC without a syscall (Ch. 35); this is the correct choice when you need a real clock and cannot afford TSC conversion complexity. Verify the vDSO is actually being used — a clocksource of `hpet` or `acpi_pm` instead of `tsc` makes `clock_gettime` a ~1 µs trap, and the diagnostic is `cat /sys/devices/system/clocksource/clocksource0/current_clocksource`.

**Failure signature of clock-domain confusion:** latency distributions with a small number of impossibly small or negative values; a step change in measured latency coinciding with an NTP adjustment or a PTP grandmaster failover; two machines reporting different latencies for the same round trip whose difference is constant rather than noisy (a constant difference is an offset, i.e. a sync error, not a performance difference).

---

## 59.10 Health Checks and Heartbeats

A **health check** is a query answered by the process. A **heartbeat** is an unsolicited periodic emission. The distinction matters because they fail differently: a health check can hang (and a hung check is indistinguishable from a hung process only if you time it out), while a missing heartbeat is unambiguous.

### What a health check must not do

- **Must not run on the hot path.** A health-check endpoint served by the trading thread means an external system can inject latency into trading by polling. Serve it from a separate thread on a housekeeping core, reading the same per-core counters the metrics path reads (§59.3).
- **Must not take the locks the hot path takes.** A health check that acquires the order-book mutex will, at the worst possible moment, be the thing that blocks.
- **Must not merely return 200.** A check that only proves the HTTP thread is alive proves nothing about the trading loop — this is the classic false-negative. It must assert on evidence *produced by* the critical path: "the market-data sequence number advanced within the last N ms", "the last strategy loop iteration completed less than N ms ago."

```cpp
// Hot path publishes liveness cheaply; checker reads it.
std::atomic<uint64_t> last_loop_tsc;                        // one relaxed store per loop, ~1 ns
// in the loop:
last_loop_tsc.store(rdtsc(), std::memory_order_relaxed);
// checker thread:
bool healthy = tsc_to_ns(rdtsc() - last_loop_tsc.load(std::memory_order_relaxed)) < budget_ns;
```

### Heartbeat design

- **Interval and timeout must differ by a factor.** Heartbeat every 100 ms, declare dead after 3 missed (300 ms). A timeout equal to the interval guarantees false positives from ordinary jitter.
- **Heartbeats carry state, not just liveness.** Include: sequence numbers consumed, orders live, mode (running/draining/halted), config version (Ch. 60 §60.2), build id. This makes the heartbeat stream a free audit trail and lets you detect a split-brain config mismatch across the fleet immediately.
- **Send over a path independent of the one being monitored.** A heartbeat sent over the same multicast group whose loss you are trying to detect tells you nothing new. Ideally a separate NIC/VLAN.
- **Exchange-side heartbeats are protocol-level obligations.** FIX `Heartbeat`/`TestRequest` (Ch. 50) and many binary order-entry protocols will drop your session if you miss them. A session dropped for a missed heartbeat *during* a busy period, because your heartbeat timer was starved by the trading loop, is a real and famous failure mode. Heartbeat generation must be on a thread that cannot be starved, or driven off a timerfd on a non-isolated core.

### Failure modes and signatures

| Failure | Signature |
|---|---|
| Health check served by hot thread | p99.9 latency spikes at exactly the monitoring poll interval |
| Check asserts only on the HTTP thread | Process reports healthy while stalled; only downstream staleness reveals it |
| Heartbeat timer starved | Session drops correlate with market bursts; heartbeat gaps precede the drop |
| Timeout == interval | Constant flapping; the ops team disables the alert, and it is off during the real outage |
| Heartbeat over the monitored path | Correlated failure; no signal when it matters |

The "healthy process, stale data" case is the one to lead with in an interview: **the useful definition of health is progress, not responsiveness.**

---

## 59.11 Watchdogs and Stall Detectors

A **watchdog** takes an action (kill, restart, cancel orders, flip to a hot spare) when progress stops. A **stall detector** merely observes and reports. In a trading system the difference is a policy decision with money attached, and conflating them is dangerous.

### Layers, from hardware down to application

| Layer | Mechanism | Reaction time | Action |
|---|---|---|---|
| Hardware watchdog | `/dev/watchdog` (IPMI/TCO timer) | 1–60 s | Hard reset the machine |
| Kernel soft/hard lockup detector | `watchdog_thresh`, NMI-based | 10–20 s | Panic or warn |
| RCU stall detector | `rcu_cpu_stall_timeout` | ~21 s | Dump stacks |
| **External process supervisor** | systemd `WatchdogSec` + `sd_notify(WATCHDOG=1)` | 100 ms–10 s | Restart the unit |
| **In-process stall detector** | Separate thread checks a progress counter | **1–10 ms** | Log, alert, cancel orders |
| **Peer/session watchdog** | Exchange or peer detects missing heartbeat | seconds | Cancel-on-disconnect |

The in-process detector is the only one operating at a timescale relevant to a trading loop, and it is the one worth designing:

```cpp
// Stall detector thread, pinned to a housekeeping core, running at ~1 kHz.
for (;;) {
    uint64_t now = rdtsc();
    for (auto& t : threads) {
        uint64_t last = t.last_progress.load(std::memory_order_relaxed);
        uint64_t age  = tsc_to_ns(now - last);
        if (age > t.stall_ns) {                     // e.g. 1 ms for a 5 µs loop
            record_stall(t, age);                   // to the flight recorder (§59.13)
            capture_backtrace(t.tid);               // via libunwind or /proc/<pid>/task/<tid>/stack
            if (age > t.kill_ns) policy_action(t);  // cancel orders / halt trading
        }
    }
    nanosleep_1ms();
}
```

### Design points

- **The progress signal must be a plain relaxed store by the monitored thread** (§59.3). Anything requiring the monitored thread to *do* something (respond to a ping, take a lock) is useless: a stalled thread cannot respond, and a healthy thread pays for the ceremony.
- **A stall detector cannot distinguish "stuck" from "slow but working"** unless you separate the counters: a monotonically advancing loop counter distinguishes them, a timestamp alone does not (a thread doing one iteration every 900 µs looks alive to a 1 ms timeout while being 200× too slow).
- **Capture on detection, decide later.** The moment of the stall is the only moment the evidence exists. Snapshot the flight recorder, per-thread backtraces, `/proc/<pid>/stat` (to see if the thread is in `R` or `D` state), and the perf counter deltas. In `D` state the cause is I/O or a page fault (Ch. 32); in `R` state with no progress it is a spin, a livelock, or a preemption by a higher-priority thread (Ch. 31).
- **Automatic restart during market hours is usually the wrong action.** A restarted trading process has an empty book, a cold cache, no session, and unknown positions. The default automated action should be **cancel and go flat, then halt** — a state a human can reason about — with restart as a deliberate decision (Ch. 60 §60.8).
- **Watchdog-induced outages are real.** A watchdog with too tight a threshold, triggered by a legitimate 5 ms GC-equivalent pause at market open, will restart every instance in the fleet simultaneously. Stagger thresholds, require N consecutive violations, and rate-limit the action.

**Diagnostic signature of a false-positive watchdog:** restarts cluster at a fixed time of day (open, auction, settlement message burst) across many hosts at once, and the pre-restart flight recorder shows the loop was running, merely slowly. **Signature of a true stall:** one host, no periodicity, and the captured thread state shows `D` (I/O wait) or a lock held by a descheduled thread.

---

## 59.12 Tail-Latency Alerting

The alerting problem for latency is that the interesting quantity is rare by construction. An alert on the mean will never fire; an alert on max will fire constantly.

### What to alert on

| Signal | Alert form | Why |
|---|---|---|
| p99.9 over a 1-min window | Threshold vs SLO | The primary latency SLO signal |
| **Count of samples above budget** | `sum(bucket[>budget]) > N per minute` | Directly counts SLO violations; scale-free and mergeable |
| Max | Report, don't page | One outlier is a fact of life; a *trend* in max is signal |
| Drop counters (§59.7) | Any non-zero | A drop is a defect, not a degradation |
| Negative/impossible durations | Any non-zero | Clock-domain break (§59.9) |
| Histogram *shape* change | New mode appears | A bimodal distribution is a different bug than a shifted one |

The **error-budget / burn-rate** formulation is the right framing and the one that avoids alert fatigue: if the SLO is "99.9% of order paths under 5 µs", the budget is 0.1% of events. Alert when the *rate of budget consumption* implies exhaustion within a short horizon — a fast burn (e.g. 14.4× budget rate over 5 minutes) pages immediately, a slow burn (3× over 6 hours) files a ticket. This gives one alert that is both sensitive to acute outages and to chronic degradation without needing two thresholds that fight each other.

### Statistical hazards

- **Never alert on a p99 computed by averaging p99s** (§59.1). Merge buckets first.
- **Small windows make percentiles meaningless.** A p99.9 over 100 samples is the max, with enormous variance. Either lengthen the window or alert on the violation count instead — counts are well-behaved at any sample size.
- **Percentiles hide multimodality.** A distribution that is 5 µs normally and 400 µs on cache-cold paths can have a fine p99 while every cache-cold order is catastrophically late. Alert per *class* (cold-start, first-message-after-idle, cross-NUMA) if the classes have different physics.
- **Beware sampling interactions.** If the metrics pipeline drops under load and load correlates with latency, your p99 improves during an incident. Always cross-check the sample count.

### Making the alert actionable

An alert that says "p99.9 exceeded 8 µs" is not actionable. Attach, automatically:
- the exemplars from the offending buckets (§59.2) — specific trace ids;
- the per-stage histogram breakdown (parse / decide / encode / send), so the regression localizes to a stage;
- the concurrent counters: message rate, drop counters, `perf` context switches and page faults for the thread, `softirq` time (Ch. 46), C-state residency (Ch. 35);
- a flight-recorder dump (§59.13) covering the window.

**The most common false alarm** is a latency regression that is really a *load* change: p99 rose because volume tripled and the batch sizes changed. Always plot latency against concurrent throughput; a latency alert without a throughput panel next to it wastes a page.

---

## 59.13 Flight-Recorder Ring Buffers

A **flight recorder** is a fixed-size in-memory ring holding the most recent N events, continuously overwritten, and dumped only when something goes wrong. It inverts the usual logging economics: you record *everything* at full detail because you almost never pay to persist it.

```
    ┌──────────────────────── 64 MB, huge pages, mlock'd ───────────────────────┐
    │ ...older... │ e_{n-3} │ e_{n-2} │ e_{n-1} │ e_n │ (free/oldest) │ ...     │
    └──────────────────────────────▲────────────────────────────────────────────┘
                                   write cursor (monotonic uint64, masked)
    Dump triggers: stall detector (§59.11), latency > threshold, exception,
                   crash handler, risk breach, operator request.
```

### Why it is the right structure for low latency

- **Write cost is a store to a preallocated slot**: ~5–15 ns, no allocation, no syscall, no I/O, bounded worst case. There is no backpressure path, because it never fills — it overwrites.
- **You get pre-fault context.** The single hardest thing about a rare latency event is that by the time you know it happened, the evidence is gone. The flight recorder has the preceding 100 ms of every event at full fidelity.
- **It composes with binary logging** (§59.5): same record format, same decoder; the only difference is that the ring is the destination of record, and the file is the destination of *exception*.

### Implementation details that matter

- **Preallocate and `mlock`** the buffer (Ch. 32). A flight recorder that page-faults during a stall adds latency at the worst moment and may fail to record the stall's cause. Huge pages keep the TLB footprint at a handful of entries.
- **Touch every page at startup** so the first write is not a fault.
- **Make the dump path allocation-free and signal-safe** if it can be invoked from a crash handler (Ch. 58): `write()` the raw bytes to a preopened fd, decode offline. Formatting inside a signal handler is how a crash handler deadlocks on the malloc lock.
- **Version and stamp the ring.** Header with build id, TSC anchor pairs (§59.9), record-format version, and the site dictionary id — a dump you cannot decode is worthless (Ch. 60 §60.1).
- **Dump on a rising edge, and rate-limit.** A dump is I/O; a condition that dumps 64 MB every 10 ms will itself cause the outage. One dump, then a cooldown, then a counter of suppressed dumps.
- **Consider a second, coarser ring** with a much longer horizon: a 64 MB full-detail ring might cover 200 ms, which is too short to see a slow-building problem. A parallel ring of periodic summaries covers hours in a few megabytes.

### Kernel and hardware analogues worth naming

The same pattern exists at every layer and citing it shows breadth: **Intel Processor Trace** (`perf record -e intel_pt//` with a snapshot-mode ring) records every branch executed in a small circular buffer with ~5% overhead and is dumped on trigger — the definitive tool for "what code path ran during that 40 µs"; **`perf record --snapshot`** with `SIGUSR2` triggering; **ftrace's snapshot buffer**; **eBPF ring buffers** (`BPF_MAP_TYPE_RINGBUF`) for kernel-side events with the same overwrite-and-dump discipline; and **`ltt`/LTTng** for full-system tracing. Intel PT in snapshot mode is the strongest single answer to "how would you find out what happened during a rare microsecond-scale stall" — it is the only tool that gives instruction-level history with acceptable steady-state cost.

### The observer-effect summary

Every technique in this chapter sits somewhere on one curve: **cost paid on the hot path vs information retained.**

```
  info
   ▲   full instruction trace (Intel PT, ~5%) ●
   │   flight recorder, full detail  ●
   │   binary log, all events    ●
   │   binary log, sampled   ●
   │   histogram            ●
   │   counters        ●
   │   nothing    ●
   └──────────────────────────────────────────▶ hot-path cost
       ~0      1ns    5ns   15ns   30ns    ~100ns+
```
The engineering answer is not a point on this curve but a *split*: cheap always-on aggregate signals (counters, histograms) to know that something is wrong, plus an always-writing/rarely-reading recorder to know what it was. Anything that costs more than ~30 ns per event and runs unconditionally on the critical path is a design error.

---

## Key Interview Questions

1. **Why are counters preferred over gauges for anything you care about?** — A gauge sampled at 1 Hz misses everything between samples; a cumulative counter plus timestamps lets the collector derive rates and detect resets, losing nothing to scrape gaps.
2. **Why can't you average p99s across instances?** — Percentiles are not linear; the fleet p99 is not derivable from per-instance p99s. Ship histograms with shared bucket boundaries and merge bucket counts, then compute.
3. **What does a metric update cost on the hot path, and how do you make it ~1 cycle?** — Resolve the handle at construction, store per-core in a cache-line-padded struct, increment with a relaxed atomic (identical codegen to a plain `++` on x86, but not UB). A name lookup or a shared atomic is 20–1000× worse.
4. **What is a cardinality explosion and what causes it?** — Series count = name × cross-product of label values; caused by a label derived from unbounded input (order id, error string). Signature: unbounded RSS growth tracking message rate plus backend ingestion lag.
5. **How do you get per-order detail without high-cardinality metrics?** — Exemplars: low-cardinality histogram plus a few full-detail sample records attached to tail buckets, linking "p99.9 = 40 µs" to specific trace ids.
6. **Reading per-core counters from a collector thread — what is the correctness issue?** — Non-atomic concurrent read/write is a data race (UB); use relaxed atomics for identical x86 codegen with defined semantics. Also, the sum corresponds to no single instant, so derived metrics can transiently be impossible.
7. **What is coordinated omission?** — A closed-loop measurement that stops issuing requests while stalled under-samples the slow period, understating the tail by orders of magnitude. Fix: measure from intended start times, or from the hardware timestamp of the triggering packet.
8. **Why HdrHistogram rather than linear buckets or reservoir sampling?** — Constant relative error across many decades in a few cache lines, ~2–4 ns per record, mergeable. Reservoir sampling structurally discards the tail, which is the only part that matters.
9. **How does binary logging achieve ~10 ns per record?** — Defer everything: intern the format string to an id at compile time, write raw trivially-copyable argument bytes plus a raw TSC into a preallocated ring, and format offline. No parsing, no conversion, no `clock_gettime`, no syscall, no lock.
10. **What breaks if you log a `const char*` into a deferred logger?** — If it points to non-static storage, the backend formats freed memory — a use-after-free with a delayed, non-reproducible signature. Only string literals or interned ids are safe.
11. **Why per-thread SPSC log rings rather than one MPMC queue?** — SPSC needs no atomic RMW: relaxed load, stores, release store — wait-free, ~5–10 ns, zero cross-core contention. MPMC costs a contended `lock`-prefixed RMW per record and drags a shared line across every producing core.
12. **What should a logger do when its queue is full?** — Drop and count, then emit a synthetic gap record naming the number of records and the time window. Blocking puts the log backend on the trading thread's critical path; growing puts `malloc` and page faults there.
13. **Which sampling policy preserves the tail?** — Conditional/tail-biased: always log when latency exceeds a threshold, sample otherwise. Rate limiting drops precisely during bursts, i.e. exactly when you need the data.
14. **Why isn't a timestamp enough to order events across threads and hosts?** — TSC comparability requires invariant/synchronized TSC and breaks across sockets and migrations; wall-clock is not monotonic; and event spacing can be below the clock's read cost. Carry causal ids (trace/span) and per-thread sequence numbers alongside.
15. **What is a clock domain, and what is the error budget on a cross-host latency measurement?** — A set of mutually comparable timestamps. Cross-host via PTP-disciplined PHCs carries 10–100 ns of sync error plus translation error; sub-100 ns claims require one instrument timestamping both endpoints with one oscillator.
16. **How do you detect that PTP has degraded, from application data alone?** — A rising count of negative or impossibly small reconstructed durations, and a *constant* (not noisy) difference between two hosts' measurement of the same round trip.
17. **What makes a health check useful rather than decorative?** — It must assert progress produced by the critical path (sequence advanced, loop iterated within budget), be served off the hot path, and take no lock the hot path takes. A 200 from an HTTP thread proves nothing.
18. **A stall detector fires — what do you capture, and what action?** — Capture at the moment of detection: flight recorder, per-thread backtraces, thread state (`R` vs `D`), perf counters. Default action during market hours is cancel-and-halt, not restart: a restarted process has no book, no session, and unknown state.
19. **How would you find out what code ran during a rare 40 µs stall?** — Intel PT in snapshot mode: a circular branch-trace buffer at ~5% overhead, dumped on trigger, giving instruction-level history. Backed by an application flight recorder for semantic events.

---

## Common Traps

- **Averaging percentiles** across instances or time windows — mathematically meaningless; merge histogram buckets instead.
- **Using a summary/quantile metric type** and then being unable to aggregate the fleet.
- **Looking up a metric by string on the hot path** — hash plus possible allocation, three orders of magnitude over budget.
- **A label sourced from network input** (order id, symbol string, error text) — unbounded cardinality; RSS grows without limit and the backend index dies.
- **Per-core counters as plain non-atomic reads from a collector** — formally a data race; use relaxed atomics for the same instructions.
- **Deriving `sent - acked` from unsynchronized shards** and alerting on the negative value.
- **Scraping shards at kHz rates** — turns metrics into a coherence storm that invalidates the hot path's cache lines.
- **Closed-loop latency measurement** — coordinated omission understates the tail catastrophically.
- **Reservoir sampling for tail latency** — the tail is rare, so sampling deletes it.
- **`printf`/`ostream` logging on the hot path** — 1–10 µs including format, lock, and syscall.
- **Logging a pointer to a stack buffer into a deferred logger** — the backend formats freed memory.
- **Decoding a binary log with a different build than produced it** — the site dictionary ids shift and you get plausible garbage. Stamp both with the build id.
- **A blocking log queue** — the disk now owns your p99.9; signature is a secondary latency mode at the flush interval.
- **Silent drops** — an incomplete log that looks complete makes every reconstruction wrong. Always emit a gap record.
- **Rate-limiting logs during bursts** — drops exactly the interesting period.
- **Sharing a cache line between a ring's head and tail indices** — reintroduces the contention the lock-free design removed.
- **Assuming TSC is comparable across sockets or after migration** — it is not guaranteed.
- **Short TSC frequency calibration** — 10 ms of calibration is ~100 ppm, i.e. 100 µs of drift per second of extrapolation.
- **A clocksource of `hpet`/`acpi_pm`** — `clock_gettime` silently becomes a ~1 µs syscall instead of a ~20 ns vDSO call.
- **A health check served by the trading thread** — monitoring becomes an attack surface on your own latency; spikes appear at the poll interval.
- **Heartbeat timeout equal to the heartbeat interval** — permanent flapping, so the alert gets disabled before the real outage.
- **Watchdog auto-restart during market hours** — replaces a slow process with a cold, sessionless, position-unknown one; and a fleet-wide threshold restarts everything at once at the open.
- **A stall detector using only a timestamp** — cannot distinguish "stuck" from "200× too slow but progressing." Use a loop counter too.
- **A flight recorder that page-faults or allocates on dump** — fails precisely when invoked, and deadlocks if invoked from a signal handler.
- **Alerting on a percentile over too few samples** — p99.9 of 100 samples is just the max.
- **A latency alert with no concurrent throughput panel** — most "regressions" are load changes.

---

## Compact Recall Summary

**Metric types.** Counter (monotone, cumulative, resettable-safe), gauge (instantaneous, not summable), histogram (mergeable if buckets match), summary (quantiles computed in-process — **not mergeable**, avoid). Store nanoseconds as `uint64_t`, 64-bit width, cumulative rather than delta. Hot-path update must be a resolved handle plus an increment on a padded per-core line: ~1 cycle. A name lookup or shared atomic is 20–1000× worse.

**Cardinality.** Series = name × label cross-product. Costs hit the hot path (string hashing, allocation), memory (one histogram per series), and backend index. Key by dense integer ids into preallocated arrays; bucket or top-K high-cardinality labels; push per-entity detail into the *event stream*, not metrics; link them with **exemplars**. Any label sourced from network input is a bug — signature is unbounded RSS tracking message rate.

**Per-core aggregation.** Owner-writes/collector-reads with **relaxed atomics** (identical x86 codegen, no UB, no tearing). The sum corresponds to no instant, so cross-counter invariants can be violated transiently; fix by read ordering, clamping, or a seqlock for batch snapshots. Scraping downgrades the owner's line from M to S and forces a fresh RFO — cadence is an observer-effect knob; 1 Hz fine, 1 kHz is a coherence storm.

**Histograms.** HdrHistogram: exponent (LZCNT) plus mantissa bits gives fixed relative error over many decades in a few hundred `uint64_t`; ~2–4 ns per record, branchless, mergeable. **Coordinated omission** is the headline trap — closed-loop measurement under-samples stalls; measure from intended start times or from the trigger packet's hardware RX timestamp. Report p50/p99/p99.9/p99.99 **and max**; keep both cumulative and interval histograms; state both endpoints of any "tick-to-trade" figure.

**Logging.** Text logging costs 1–10 µs (parse, convert, lock, syscall). Binary/deferred logging costs ~10–30 ns: intern the format string to an id at compile time, write raw TSC plus trivially-copyable argument bytes into a preallocated ring, format offline. Constraints: no dangling `const char*`, ship the site dictionary with the build id, convert TSC at decode time, and keep argument evaluation inside the level-guard.

**Queues.** Per-thread SPSC rings, wait-free producers, cache-line-separated indices, cached opposite index, power-of-two capacity with free-running masked 64-bit indices, huge pages, optional non-temporal stores. Backend on a housekeeping core, batched `writev`. Backpressure policy: **drop and count** — never block (log backend owns your tail) and never allocate (page fault at the worst moment).

**Sampling and drops.** Account for every drop and emit a synthetic gap record; alert on any non-zero drop counter. Tail-biased conditional logging (`if elapsed > threshold`) is the only cheap policy that preserves outliers; rate limiting drops precisely during bursts. Know the four independent drop points: NIC ring, socket buffer, app ring, log ring — each with its own counter.

**Correlation.** Per-thread sequence + per-thread TSC + a causal `trace_id`/`span_id` propagated from ingress + the trigger packet's hardware timestamp as the anchor. Merge by converted TSC, break ties by (thread, seq), and use exchange sequence numbers as ground truth for market-data gaps. Negative durations mean a clock bug, not speed.

**Clock domains.** TSC / CLOCK_MONOTONIC / CLOCK_REALTIME / NIC PHC / exchange / switch are distinct comparability sets. Cross-host PTP sync error is 10–100 ns with hardware timestamping; sub-100 ns claims require one instrument timestamping both endpoints with a single oscillator. Get TSC frequency from CPUID 0x15 or a multi-second continuous fit, re-anchor periodically, log the anchors, and verify the clocksource is `tsc`.

**Health, watchdogs.** Health = *progress*, not responsiveness: assert on a counter the critical path advances, served off the hot path, taking no hot-path lock. Heartbeats carry state (config version, build id, mode) and travel a path independent of the monitored one; timeout must be several intervals. Stall detection layers span 1 ms (in-process) to 60 s (hardware watchdog). Capture at the moment of detection (recorder dump, backtraces, `R` vs `D` state); the default in-hours action is cancel-and-halt, not restart.

**Alerting.** Alert on SLO-violation *counts* and error-budget burn rate rather than raw percentiles; never on averaged percentiles or on percentiles over tiny windows; alert on drops and impossible durations as defects. Attach exemplars, per-stage breakdown, and concurrent load automatically — a latency alert without a throughput panel is usually a load change.

**Flight recorders.** Fixed-size overwriting ring, huge pages, `mlock`ed, pre-touched, ~5–15 ns per record, dumped only on trigger, decode offline, signal-safe dump path, stamped with build id and TSC anchors, rate-limited. The kernel/hardware analogues — Intel PT snapshot mode, `perf --snapshot`, ftrace snapshot, BPF ringbuf — extend the same idea to instruction-level history at ~5% cost. The whole chapter is one curve: cheap always-on aggregates to know *that* something broke, plus always-writing/rarely-reading recorders to know *what* — and nothing unconditional on the critical path above ~30 ns per event.
