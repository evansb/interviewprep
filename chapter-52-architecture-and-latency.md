# Chapter 52 — Architecture and Latency

*Interview-focused revision notes. The theme: a trading system's architecture is a latency budget made structural — every stage boundary, every queue, and every thread handoff is a line item you either paid for deliberately or are paying for by accident.*

---

## 52.1 Tick-to-Trade and Wire-to-Wire Latency

**Tick-to-trade** is the elapsed time from a market-data event arriving at your infrastructure to the resulting order leaving it. Precision matters enormously here, because the number is meaningless without stating the two measurement points and the measurement method.

### The measurement points

```
   exchange                your rack                                       exchange
   MD gateway                                                              OE gateway
       │                       │                                               │
       │───── multicast ──────►│ T0: first bit of MD frame at YOUR NIC port    │
       │                       │ T1: last bit received (serialization delay)   │
       │                       │ T2: DMA complete, descriptor visible          │
       │                       │ T3: application observes the packet           │
       │                       │ T4: message decoded, book updated             │
       │                       │ T5: decision made                             │
       │                       │ T6: order encoded, write posted to NIC        │
       │                       │ T7: first bit of order frame ON the wire      │
       │◄──── unicast ─────────│                                               │
```

| Metric | Span | Who quotes it |
|---|---|---|
| **Wire-to-wire** | T0 → T7, measured by an external tap | The honest number |
| **Tick-to-trade** | Often used as a synonym for wire-to-wire; sometimes T3 → T6 | Ambiguous — always ask |
| **Application latency** | T3 → T6, measured with `rdtsc` inside the process | Excludes the NIC and stack |
| **Decision latency** | T4 → T5 | Strategy only |

The distinguishing interview move is to ask which span is meant and to insist on **external tap measurement** for any published number: a hardware timestamping tap or a capture NIC (Ch. 48 §48.4, §48.9) observing both the inbound market-data frame and the outbound order frame, with both timestamps in the same clock domain. Internal `rdtsc` measurements systematically exclude the NIC receive path, the DMA, the poll-loop discovery delay, and the entire transmit path — which together are often larger than everything they do measure.

### Representative budgets

For a single-hop colocated setup with kernel bypass, 10 GbE, and a software fast path:

| Stage | Typical |
|---|---|
| Serialization of a 100 B frame at 10 Gb/s | 80 ns |
| Switch (cut-through) | 300–500 ns |
| NIC receive to application visibility (kernel bypass, busy poll) | 500 ns – 1.5 µs |
| Protocol decode | 50–200 ns |
| Book update | 100–500 ns |
| Decision | 100 ns – 2 µs |
| Order encode + NIC transmit posting | 300 ns – 1 µs |
| **Software wire-to-wire total** | **2–10 µs** |
| **FPGA wire-to-wire** (Ch. 48 §48.1) | **50–500 ns** |
| Kernel network stack instead of bypass | add 5–15 µs |

These are order-of-magnitude anchors, not constants (Ch. 30 §30.4). The two facts that matter: the **network stack dominates unless you bypass it**, and once bypassed, no single stage dominates — which is why §52.12's critical-path analysis is necessary rather than optional.

### The distribution, not the mean

A tick-to-trade figure quoted as a single number is nearly useless. What matters is the full distribution — p50, p99, p99.9, and max — because the events you care about (a large move, an auction, a burst) arrive precisely when the system is most loaded. Median latency under idle conditions is the easiest number to optimize and the least relevant.

**Coordinated omission** (Ch. 43 §43.3) is the specific trap: if your measurement loop only timestamps messages it actually processed, and the system stalled for 10 ms dropping or queueing messages, the stall is invisible. Correct measurement timestamps at **arrival** (ideally in NIC hardware, Ch. 48 §48.4) and computes latency against that, so queueing delay is included by construction.

---

## 52.2 Market-Data, Strategy, and Order-Gateway Pipeline

The canonical decomposition of a trading system into three functional blocks, and the interfaces between them.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MARKET-DATA SIDE                                │
│  NIC ──► feed handler ──► normalizer ──► book builder ──► book state    │
│         (§52.3)          (§52.5)        (§52.4)                          │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ book update event
┌───────────────────────────────────▼─────────────────────────────────────┐
│                              STRATEGY                                     │
│  reads book state, position, risk state ──► emits order intents          │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ order intent
┌───────────────────────────────────▼─────────────────────────────────────┐
│                           ORDER-ENTRY SIDE                                │
│  pre-trade risk ──► order state machine ──► protocol encoder ──► NIC     │
│  (Ch. 56)          (Ch. 50 §50.9, Ch. 54)  (Ch. 51)                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    exchange acks/fills ──► order state machine ──► strategy
```

### The three interfaces

**1. Feed handler → strategy.** Either a callback on the same thread (fastest, no queue, but the strategy's cost is now inside the feed handler's loop) or a bounded SPSC queue (§52.10). The design question is whether the strategy is fast and predictable enough to run inline. For a single-instrument strategy it usually is; for one that fans out across hundreds of instruments, it usually is not.

**2. Strategy → order gateway.** Almost always inline in a latency-sensitive path, because a queue here adds latency to the *outbound* leg where it is most expensive. Pre-trade risk (Ch. 56 §56.13–§56.17) sits between them and must be inline: risk checks that can be bypassed under load are not risk checks.

**3. Order gateway → strategy (acks/fills).** Necessarily asynchronous, since acks arrive on a different socket and often a different thread. The order state machine owns the truth; the strategy receives a notification.

### The colocation of the whole path

The strong architectural claim, and the one to defend in an interview: **for the latency-critical instrument set, run market data, strategy, and order entry on a single thread**, on one isolated core (Ch. 31 §31.19), with no queues in between. This eliminates every inter-thread handoff (200 ns – 2 µs each, §52.10) and every associated cache-coherence transfer. Everything else — logging, metrics, position reconciliation, less-critical instruments — moves off that thread.

The counterargument, which you should raise yourself: a single thread bounds your throughput to one core, so an instrument burst that exceeds that core's capacity queues at the NIC and blows the tail. The resolution is **sharding by instrument across cores** rather than pipelining stages across cores — each core owns a disjoint set of instruments end-to-end. Sharding preserves the no-handoff property while scaling throughput; pipelining scales throughput by adding handoffs, which is the wrong trade for latency.

The residual problem with sharding is any strategy that requires a **cross-instrument view** (a spread between two instruments on different shards). That forces either a handoff, duplicated market-data processing on both shards, or co-locating correlated instruments on the same shard — the last being the standard answer, with instrument-to-shard assignment driven by strategy topology rather than load balance.

---

## 52.3 Feed Handlers

A **feed handler** is the component that receives an exchange's market-data transport, decodes its protocol, and emits normalized events. It owns everything in Ch. 51 (framing, decoding, sequencing) and Ch. 53 (arbitration, gap recovery) and nothing above it.

### Structure

```cpp
// One feed handler per multicast channel; owns its sockets and its sequence state.
class FeedHandler {
    RxRing            a_, b_;              // ef_vi / AF_XDP rings for A and B feeds
    ArbitrationState  arb_;                // Ch. 53 §53.6
    SequenceState     seq_;                // Ch. 51 §51.14
    Sink&             sink_;               // book builder, called inline

public:
    // Called from the busy-poll loop. Never allocates, never blocks, never logs
    // synchronously. Returns the number of packets processed for the loop's
    // adaptive backoff decision.
    unsigned poll() noexcept;
};
```

Key properties, each of which is a defensible design decision:

- **Runs in the poll loop, not on a timer or an epoll wakeup.** Busy polling (Ch. 47 §47.11) removes the interrupt, the wakeup, and the scheduler from the path, at the cost of a fully consumed core.
- **Calls the book builder inline.** A queue between feed handler and book builder buys nothing — the book builder is fast and the feed handler has no other work.
- **Owns arbitration and gap state.** The A/B merge (Ch. 53 §53.6) must happen before the book builder sees anything, so that the book builder receives a single, gap-free, in-order stream and can be written without recovery logic.
- **Is a pure function of its input stream plus reference data.** No wall-clock reads on the decode path (except for timestamping, which is captured as data, not consumed as control), no map iteration order dependence, no randomness. This is what makes replay (§52.12, Ch. 53 §53.9) meaningful.

### One handler per channel, one channel per thread

Exchanges partition instruments across multicast channels (CME MDP has dozens; Nasdaq splits by symbol range). The natural unit of parallelism is the channel: one thread, one core, one set of channels, disjoint instrument state. This gives you sharding for free and requires no locking anywhere in the market-data path.

The consequence is that **the book state for a given instrument is single-writer by construction** — only one thread ever mutates it. That, in turn, is what makes seqlock-based publication (§52.8) viable for readers on other cores.

### Failure modes and their signatures

| Failure | Signature |
|---|---|
| Poll loop falls behind | Rising NIC ring occupancy, then `rx_missed_errors` / ring overflow counters (Ch. 46 §46.16). Latency rises smoothly then cliffs. |
| Slow path taken on the hot path (allocation, logging, exception) | Bimodal latency histogram: a tight p50 with a second mode 10–100× higher |
| Decode bug on a rare message type | Book divergence that appears only for certain instruments or times of day |
| Gap-recovery storm | Outbound retransmission-request rate spikes; exchange rate-limits or disconnects you |
| Multicast group not joined / IGMP timeout | Feed goes silent with no error — only a staleness timer (Ch. 53 §53.8) detects it |

The last one deserves emphasis: **the absence of data is not an error signal**. IGMP snooping state (Ch. 37 §37.9) expires, a switch reconverges, or a queried group is pruned, and your feed simply stops. Nothing throws. Only an explicit staleness detector catches it.

---

## 52.4 Book Builders

A **book builder** consumes normalized market-data events and maintains the limit order book (Ch. 50 §50.13) — the current state of resting orders at every price level for an instrument. It is the hottest data structure in the system: touched by every message, read by every decision.

### The two granularities

| Feed type | What you get | Book builder complexity |
|---|---|---|
| **Order-by-order** (ITCH, most equity feeds) | Individual orders with reference numbers | Must maintain per-order state and per-level queues; gives queue position (Ch. 49 §49.3) |
| **Aggregated / price-level** (many futures and FX feeds) | Net size at each price level, by level index | Just an array of (price, size); no queue position available |

Order-by-order is strictly more information and strictly more work. The core structure:

```cpp
// Order-by-order book. Preallocated, index-based, no pointers, no allocation.
struct Order { std::uint32_t next, prev; std::int64_t price; std::uint32_t qty, level; };
struct Level { std::int64_t price; std::uint64_t total_qty; std::uint32_t head, tail, count; };

class Book {
    std::vector<Order>                   orders_;      // slab, indexed by internal id
    ankerl::unordered_dense::map<std::uint64_t,std::uint32_t> ref_to_idx_;  // flat hash
    std::array<Level, kMaxLevels>        bids_, asks_; // sorted, or price-indexed
    std::uint32_t                        best_bid_, best_ask_;   // cached indices
};
```

Design choices worth defending:

- **Indices, not pointers.** 4 bytes instead of 8 (double the entries per cache line), relocatable, and shared-memory-safe (Ch. 3 §3.12).
- **Flat hash map for order references** (Ch. 12 §12.7). A node-based `std::unordered_map` costs a pointer-chase miss per lookup; a flat open-addressed map with a good hash costs one miss. At millions of lookups per second this is the single largest line item in the book builder.
- **Price-level storage.** Three options, and the choice is instrument-dependent:

| Structure | Best/worst level access | Insert at new price | Memory | When |
|---|---|---|---|---|
| Sorted array of levels | O(1) best, O(log n) find | O(n) memmove | Tiny, cache-dense | Few active levels (most instruments) |
| **Direct-indexed array by price ticks** | **O(1) everything** | O(1) | O(price range) | Tight tick grid, bounded range — the fastest option |
| Balanced tree / skip list | O(log n) | O(log n) | Pointer-chasing | Rarely justified |

The direct-indexed array — a fixed array indexed by `(price - base) / tick_size`, with best-bid/best-ask tracked incrementally — is the low-latency answer where the price range is bounded. Its hazards are that the range must be validated against price bands (Ch. 49 §49.13) and re-based on limit-up/limit-down moves, and that a sparse book wastes cache. The sorted-array form wins in practice for most instruments because active levels number in the tens and the array fits in a handful of cache lines.

- **Cache the best bid and offer.** Every decision reads the BBO; recomputing it by scanning is wasteful. Maintain it incrementally on each update, and treat "did the BBO change?" as the event that wakes the strategy — most book updates do not change the top of book, and filtering them out at the source is the cheapest optimization available.

### Correctness is the harder half

Book builders fail *silently*. A dropped `Delete`, a mis-signed quantity delta, an unhandled implied order, or a `Trade` message applied to the book (Ch. 51 §51.4) leaves a book that is plausible and wrong. Chapter 53 covers the hazards in full; the architectural requirement here is that the book must be **checksummable and replayable** — many exchanges emit periodic book checksums for exactly this purpose, and validating them is non-negotiable.

---

## 52.5 Market-Data Normalization

**Normalization** is the translation of venue-specific messages into a single internal representation, so that strategy and book-building code is written once rather than per venue.

### What has to be normalized

| Dimension | Venue variation | Normalized form |
|---|---|---|
| Price | Implied decimals, explicit exponent, string decimal, varying tick grids | `int64_t` in a fixed scale (e.g. 10⁻⁹), never floating point (Ch. 23 §23.10) |
| Quantity | Shares, lots, contracts, notional | `int64_t` in the instrument's minimum tradable unit, with the multiplier in reference data |
| Symbol | Ticker string, numeric locate, exchange instrument ID, ISIN/RIC | Internal dense `uint32_t` instrument id |
| Timestamp | Nanos since midnight, micros since epoch, exchange-local, no timestamp | `int64_t` nanoseconds, TAI or UTC, with a documented clock domain (Ch. 59 §59.9) |
| Side | `'B'`/`'S'`, `1`/`2`, bid/ask ordinal | Enum |
| Event | Add/modify/delete/execute/trade with venue-specific semantics | A canonical event set |
| Book action | Level index vs price, absolute vs delta quantity | Canonical delta form |

### Where the normalization boundary sits

The costly mistake is normalizing to a *generic, self-describing* internal message (a variant, a map of fields, a virtual `Message` base with `getPrice()`). That reintroduces exactly what binary protocols removed: indirection, branching, and often allocation.

The right shape:

```cpp
// Fixed-layout, trivially copyable, no virtuals, no owning members.
struct alignas(64) BookUpdate {
    std::uint64_t exchange_ts_ns;
    std::uint64_t recv_ts_ns;         // hardware timestamp, Ch. 48 §48.4
    std::uint64_t seq;
    std::uint32_t instrument;
    std::int64_t  price;              // fixed-point
    std::int64_t  qty;                // signed delta
    Side          side;
    Action        action;
    std::uint8_t  flags;              // recovered / possibly-stale / implied
};
static_assert(std::is_trivially_copyable_v<BookUpdate>);
static_assert(sizeof(BookUpdate) == 64);
```

Three specific points a strong candidate raises:

1. **Two timestamps, always.** Exchange time and local receive time. Their difference is your feed's one-way latency plus clock offset (Ch. 48 §48.10), and it is the primary health metric of a feed handler. Storing only one throws away the ability to distinguish "the exchange was slow" from "we were slow".
2. **The `flags` field carries data quality.** A book built during gap recovery, or from a snapshot, or containing implied prices, is not the same as a clean incremental book. That distinction must survive normalization or the strategy cannot make a safe decision (Ch. 53 §53.8).
3. **Normalization is not free and belongs in the feed handler**, done once per message as part of decode, not as a second pass. A separate normalization stage is a separate queue, a separate cache pass, and a separate copy.

### Reference data is the coupling point

Symbol mapping, tick sizes, lot sizes, multipliers, and trading calendars (Ch. 49 §49.7–§49.10) are inputs to normalization. They change — intraday symbol reassignments, corporate actions, new listings. The rule (Ch. 60 §60.9, §60.10): reference data is loaded and validated at startup, versioned, and swapped atomically; the hot path reads it through a pointer that is never mutated in place. A `std::atomic<const RefData*>` with the old version retired after a grace period (Ch. 26 §26.14 RCU-style) is the standard mechanism.

---

## 52.6 Colocation and Cross-Connects

**Colocation** is renting rack space in the same data centre building as the exchange's matching engine. **A cross-connect** is a dedicated physical cable (usually single-mode fibre) from your rack to the exchange's demarcation point, bypassing any shared network.

### Why it dominates everything else

Light in fibre travels at roughly **5 ns per metre** (c/1.47). Signal propagation is therefore:

| Distance | One-way propagation |
|---|---|
| 10 m (within a data hall) | 50 ns |
| 500 m (across a campus) | 2.5 µs |
| 60 km (metro, e.g. Chicago suburbs) | 300 µs |
| 1,200 km (Chicago–New York, fibre) | ~6.5 ms |
| Same route by microwave | ~4 ms (air is faster than glass) |

Against a 2–10 µs software tick-to-trade, **being 500 metres further away costs more than your entire application**. This is why colocation is not an optimization but a precondition, and why microwave and millimetre-wave links exist for inter-venue paths despite terrible bandwidth and weather sensitivity.

### Fairness engineering

Because distance is decisive, exchanges engineer their colocation facilities for **equidistance**: every cabinet is connected with an identical length of fibre, coiled if necessary, so that no cabinet position confers an advantage. Nasdaq, CME, and the major European venues all publish such guarantees. The interview point is that this makes cable length a *solved* variable and pushes the competition back into the switch, the NIC, and your code.

### What is actually in your control

| Item | Impact | Notes |
|---|---|---|
| **Number of switch hops** | 300–500 ns each (cut-through, Ch. 39 §39.2) | Fewer is better; a direct cross-connect to the exchange handoff removes hops |
| **Cut-through vs store-and-forward** | Store-and-forward adds the full serialization delay of the frame | Ch. 39 §39.1; low-latency switches are cut-through |
| **Switch model** | 300 ns vs 800 ns port-to-port | A real, purchasable difference |
| **NIC and transport** | 5–15 µs (kernel) vs 1 µs (bypass) vs 100 ns (FPGA) | Ch. 47, Ch. 48 |
| **Server CPU choice and clocking** | Frequency directly scales the compute portion; turbo variability is jitter (Ch. 35 §35.12) | Fix the frequency, disable deep C-states |
| **NUMA placement relative to the NIC** | Crossing a socket costs 100–300 ns per remote access, plus DDIO misses | Ch. 29 §29.21, §29.24 |
| **Port-level oversubscription** | Microbursts cause queueing at the switch egress (Ch. 39 §39.5) | Provision so the exchange handoff never queues |

### Ancillary requirements

Colocation also delivers the **PTP grandmaster** feed (Ch. 35 §35.7, Ch. 48 §48.5) most facilities provide, giving sub-microsecond clock alignment with the exchange — which is what makes one-way latency measurement and cross-venue event correlation possible at all. Without it, you can only measure round trips, and cannot compare your timestamps with the exchange's.

---

## 52.7 Hot, Warm, and Cold Paths

The central organizing principle of a low-latency system: **classify every piece of work by whether it is on the critical path, and physically separate the classes.**

| Path | Definition | Frequency | Rules |
|---|---|---|---|
| **Hot** | Executes between a market-data arrival and an order transmission | Every event | No allocation, no locks, no syscalls, no logging, no exceptions, no virtual dispatch where avoidable, no branches on cold conditions |
| **Warm** | Must happen promptly but not inside the critical path | Per event or per batch, off-thread | Bounded queue from the hot path; may allocate from a pool; may take a lock it never contends |
| **Cold** | Everything else: configuration, reference-data loads, reconciliation, reporting, admin interfaces | Rare | Anything goes; run on housekeeping cores |

### The mechanics of separation

**1. Code layout.** Cold code should not share cache lines or pages with hot code (Ch. 41 §41.17). `[[unlikely]]`, `__attribute__((cold))`, and `-freorder-blocks-and-partition` move cold basic blocks into a separate `.text.unlikely` section, so the hot loop's instruction footprint shrinks and the L1i / iTLB pressure drops (Ch. 28 §28.16). PGO and BOLT (Ch. 40 §40.9, §40.11) do this from measured profiles and typically buy 5–15% on branch-heavy dispatch code.

```cpp
void on_message(const Msg& m) noexcept {
    if (m.type == Type::Incremental) [[likely]] { apply_incremental(m); return; }
    handle_rare(m);                             // marked cold; out of line
}
[[gnu::cold, gnu::noinline]] void handle_rare(const Msg&) noexcept;
```

**2. Thread and core placement.** Hot threads on isolated cores (`isolcpus` + `nohz_full` + `rcu_nocbs`, Ch. 31 §31.19, Ch. 35 §35.17), pinned, with IRQs steered away (Ch. 35 §35.14). Warm and cold threads on housekeeping cores. Never let a cold thread share a physical core via SMT with a hot thread — SMT siblings contend for every front-end resource (Ch. 27 §27.17), and the standard practice is to disable SMT or leave the sibling idle.

**3. Data separation.** Hot data structures should not share cache lines with cold counters (Ch. 26 §26.15). A statistics counter incremented on the hot path but read by a monitoring thread causes cache-line bouncing; per-core counters aggregated on read (Ch. 59 §59.3) fix it.

**4. Deferring work off the hot path.** The pattern is to record the minimum on the hot path and reconstruct off it:

```cpp
// HOT: 8 bytes into a preallocated ring, no formatting, no locks.
log_ring_.push(LogRecord{ tsc(), EventId::OrderSent, order_id, price });
// WARM: another thread formats, timestamps in wall clock, and writes to disk.
```

This is the design of every serious low-latency logger (Ch. 55 §55.7, Ch. 59 §59.6): the hot path emits a fixed-size binary record with an integer event id and raw arguments; formatting, string handling, and I/O happen elsewhere.

### The judgement call

The classification is not obvious for everything. Pre-trade risk checks (Ch. 56 §56.13) *must* be hot even though they cost latency, because a risk check that can be skipped is not a control. Position updates must be hot enough to be correct before the next decision. Metrics must be hot enough not to lose events but cheap enough not to matter — hence per-core counters and sampled histograms (Ch. 59 §59.4). Getting this taxonomy right, and being able to justify each placement, is what the question is really testing.

---

## 52.8 Single-Writer Event Loops

The **single-writer principle**: every piece of mutable state has exactly one thread that writes it. Readers may be plentiful; writers are singular.

### Why it is the dominant pattern

A shared-mutable-state design pays for every access:

- A contended mutex costs 20 ns uncontended and microseconds contended, with unbounded tail from futex sleep/wake (Ch. 24 §24.16).
- Even an *uncontended* atomic RMW on a shared line costs ~20 cycles, and a contended one costs a cache-line transfer (~100 ns, Ch. 28 §28.8).
- Lock-free structures remove the blocking but not the coherence traffic, and add reclamation complexity (Ch. 26 §26.12).
- None of them are deterministic, which destroys replayability (§52.12).

Single-writer removes the problem rather than solving it. The writer's state stays in its own core's L1/L2 in Modified state; no invalidation traffic, no atomics, no ordering constraints on the write path.

### The event-loop shape

```cpp
// One thread, one core, owns all state it touches.
[[noreturn]] void run() noexcept {
    for (;;) {
        unsigned n = 0;
        n += md_feed_.poll();          // market data  (§52.3)
        n += order_sock_.poll();       // exchange acks
        n += control_q_.try_pop_all(); // config/commands from cold threads
        n += timers_.expire(now_tsc());// timeouts
        if (n == 0) cpu_relax();       // PAUSE; never sleep, never yield
    }
}
```

Properties:

- **Deterministic ordering.** Given the same inputs in the same order, the same outputs. This is what makes replay-based debugging (Ch. 57 §57.12) work.
- **No synchronization on the hot path.** Only the `control_q_` boundary is shared, and it is an SPSC queue read once per iteration.
- **Bounded work per iteration.** Each `poll()` must process a bounded number of items so no source starves the others. Unbounded draining of a busy feed can starve the order socket, which is the worst possible starvation — you stop learning about your own fills.

### Publishing state to readers

Other cores need to read the book without slowing the writer. The mechanism is a **seqlock** (Ch. 26 §26.9):

```cpp
// Writer (the single owner) — no atomic RMW, no contention.
seq_.store(s + 1, std::memory_order_relaxed);   // odd = write in progress
std::atomic_thread_fence(std::memory_order_release);
data_ = new_value;                               // plain stores
std::atomic_thread_fence(std::memory_order_release);
seq_.store(s + 2, std::memory_order_release);    // even = stable

// Reader — retries if it raced; never blocks the writer.
do { s1 = seq_.load(acquire); if (s1 & 1) continue;
     copy = data_;
     std::atomic_thread_fence(memory_order_acquire);
} while (seq_.load(relaxed) != s1);
```

The writer pays two stores and never waits. The reader may retry, which is acceptable because readers are off the critical path. Formally the plain data accesses race under the C++ memory model; the correct-by-the-standard form uses relaxed atomics or `atomic_ref` for the payload, which compiles identically on x86 (Ch. 25 §25.20).

### Where it breaks

Single-writer fails when a piece of state genuinely has multiple logical writers — a position updated by fills from two venues, a global risk counter checked by every strategy shard. Options, in order of preference: (1) shard the state so each writer owns a slice and aggregate on read; (2) funnel updates to one owner thread via SPSC queues, accepting the handoff latency; (3) use an atomic and accept the coherence cost. A per-shard position with a monitoring thread summing them is far better than a shared atomic position, and this is the standard answer for risk counters that must be global (Ch. 56 §56.22).

---

## 52.9 Staged Pipeline Architectures

A **staged pipeline** splits processing into stages connected by queues, each stage possibly on its own thread and core. It is the classical throughput architecture and the classical latency mistake.

```
Stage A (decode) ──q1──► Stage B (book) ──q2──► Stage C (strategy) ──q3──► Stage D (order)
   core 2                    core 3                  core 4                    core 5
```

### The throughput argument

Each stage's working set fits in its core's L1/L2. Total throughput becomes `1 / max(stage_cost)` rather than `1 / sum(stage_cost)`, so a pipeline of four 100 ns stages sustains 10 M/s where a monolith sustains 2.5 M/s. Instruction cache pressure drops because each core runs a smaller code footprint.

### The latency argument against

Total latency becomes `sum(stage_cost) + sum(handoff_cost)`, and handoffs are expensive (§52.10). Four stages add 3 handoffs at 200–500 ns each: **0.6–1.5 µs added to a path whose compute might be 500 ns**. You have doubled or tripled latency to buy throughput you may not need.

Worse, latency now depends on the *slowest* stage under load. If stage B momentarily takes 2 µs, q1 fills, and every message behind it queues. In a monolith the same slowdown affects only that message.

### When each is right

| Choose | When |
|---|---|
| **Single-threaded monolith, sharded by instrument** | Latency-critical path. The default for tick-to-trade. |
| **Staged pipeline** | Throughput-bound work that is not on the critical path: full-depth book building for hundreds of instruments feeding analytics, market-data recording, drop-copy reconciliation |
| **Hybrid** | Hot instruments on a dedicated single-threaded core; the long tail on a staged pipeline |

The hybrid is what most real systems look like, and saying so is a better answer than defending either extreme. The essential asymmetry to state: **pipelining trades latency for throughput; sharding buys throughput without spending latency.** Shard first; pipeline only when the work genuinely cannot be partitioned by instrument.

### If you must pipeline

- **Minimize stage count.** Every boundary is a fixed cost. Three stages is usually the most that can be justified.
- **Make stages equal-cost.** The pipeline runs at the rate of the slowest stage; an imbalanced pipeline wastes cores and queues at one point.
- **Pass indices, not data.** The queue element should be a small handle into a preallocated slab, not a copy of the message (§52.10).
- **Never let a stage block.** A stage that blocks on a full downstream queue propagates backpressure all the way to the NIC; a stage that drops must do so by an explicit, accounted policy (§52.16).
- **Consider the mechanical-sympathy variant**: the LMAX Disruptor pattern, where all stages consume from one preallocated ring buffer at their own cursors, with no per-stage queues, no allocation, and dependency ordering expressed as cursor barriers. It reduces the handoff to a single cache-line transfer of a cursor and removes queue memory management entirely.

---

## 52.10 Inter-Stage Queue Costs

The cost of moving a message from one thread to another, itemized. This is the number that determines whether a stage boundary is worth it.

### The cost breakdown

| Component | Cost | Cause |
|---|---|---|
| Producer's store to the slot | ~0 (already in L1) | — |
| Consumer's load of the slot | **~40–100 ns** | Cache line is Modified in the producer's L1; the read triggers a coherence transfer (Ch. 28 §28.8). Cross-socket: 150–300 ns (Ch. 29 §29.19) |
| Sequence/index update | ~20 cycles | Atomic store with release, plus its own line transfer |
| False sharing of head/tail | **up to 100 ns extra per op** | If producer and consumer indices share a line — must be `alignas(64)` separated (Ch. 3 §3.3, Ch. 26 §26.16) |
| Consumer discovery delay | **0 – full poll period** | If the consumer polls, it discovers the item on its next loop iteration |
| Wakeup if the consumer sleeps | **1–10 µs, unbounded tail** | Futex wake + scheduler + possible migration (Ch. 31 §31.16) |

**A well-tuned SPSC handoff with both sides busy-polling on the same socket costs 100–300 ns.** With a sleeping consumer it costs microseconds and has a fat tail. That range is the single most important number in this chapter, because it is the price of every architectural boundary you draw.

### Making the queue as cheap as possible

```cpp
template <class T, std::size_t N>  // N a power of two
class SpscRing {
    static_assert((N & (N - 1)) == 0);
    alignas(64) std::atomic<std::size_t> head_{0};   // written by consumer
    alignas(64) std::atomic<std::size_t> tail_{0};   // written by producer
    alignas(64) std::size_t cached_head_{0};         // producer-private
    std::size_t              cached_tail_{0};        // consumer-private
    alignas(64) std::array<T, N> buf_;               // T trivially copyable
public:
    bool push(const T& v) noexcept {
        const auto t = tail_.load(std::memory_order_relaxed);
        if (t - cached_head_ == N) {                 // only re-read on apparent full
            cached_head_ = head_.load(std::memory_order_acquire);
            if (t - cached_head_ == N) return false;
        }
        buf_[t & (N - 1)] = v;
        tail_.store(t + 1, std::memory_order_release);
        return true;
    }
};
```

The techniques, each worth naming:

1. **`alignas(64)` on head and tail** — eliminates false sharing. Without it, every push invalidates the consumer's cached tail line and vice versa; this alone can triple the cost.
2. **Cached opposite index** — the producer reads the consumer's `head_` only when it appears full, turning a per-operation cross-core read into a rare one. This is the largest single optimization in SPSC ring design.
3. **Power-of-two capacity with masking** — replaces a division/modulo with an `and`.
4. **Release/acquire on the index, relaxed on the data** — the index store publishes the payload (Ch. 25 §25.8, §25.17). Sequential consistency here would add an `MFENCE` for nothing.
5. **Trivially copyable payload** — the slot assignment is a `memcpy`, not a constructor call (Ch. 3 §3.5).
6. **Batched draining** — the consumer reads `tail_` once and processes everything available, amortizing the coherence transfer across many items. This is where batching genuinely pays (§52.13).

### What to put in the queue

Not the message. Put a **32-bit index into a preallocated slab** the producer wrote. This shrinks the queue's cache footprint by 10–100×, means the coherence transfer moves one line instead of many, and avoids copying. The cost is that the slab entry must not be recycled until the consumer is done, requiring the ring's own capacity to bound the in-flight set — which it does naturally if the slab and the ring have the same size and the same indices.

---

## 52.11 Per-Stage Latency Budgets

A **latency budget** assigns a target and a tolerance to each stage, converting an aggregate goal into per-component engineering constraints. It is what turns "make it fast" into a set of falsifiable claims.

### Constructing one

```
Target: p99 wire-to-wire ≤ 5 µs

  Stage                                   p50      p99     budget   owner
  ─────────────────────────────────────────────────────────────────────────
  NIC RX to app visible (ef_vi busy poll)  700 ns  1.2 µs   1.5 µs   platform
  Protocol decode                          80 ns   150 ns   200 ns   feed
  Book update + BBO recompute              150 ns  400 ns   600 ns   feed
  Strategy decision                        200 ns  900 ns   1.2 µs   strategy
  Pre-trade risk                           60 ns   120 ns   200 ns   risk
  Order encode + TX post                   400 ns  800 ns   1.0 µs   gateway
  ─────────────────────────────────────────────────────────────────────────
  Sum of p50                             1.59 µs
  Sum of p99                             3.57 µs           4.7 µs
  Measured wire-to-wire p99                       4.9 µs   ← the gap is the finding
```

### The two facts that make budgets subtle

**1. Percentiles do not add.** The p99 of a sum is not the sum of the p99s. If stages are independent, the sum's p99 is *less* than the sum of p99s (the stages rarely have their bad case simultaneously); if they are correlated — and they usually are, because the same cache-miss storm or the same load burst hits all of them — it can be *worse*. Summing p99s is therefore a heuristic, and the discrepancy between the summed budget and the measured end-to-end figure is itself the diagnostic: a large positive gap means unmeasured time (a stage boundary, a queue, an interrupt).

**2. Instrumentation perturbs.** Timestamping every stage with `rdtscp` (Ch. 43 §43.12) costs ~30 cycles each and serializes execution. Six probes is ~60 ns on a 2 µs path — 3%, tolerable. Twenty probes is not. The mitigations: `rdtsc` without the serializing `p` variant where ordering permits, sampling rather than timestamping every message, and validating against an external tap that has zero probe effect (Ch. 43 §43.25).

### Enforcing the budget

Budgets that are not enforced decay. The mechanisms:

- **Per-stage histograms in production** (HDR-style, Ch. 43 §43.4, Ch. 59 §59.4), recorded from TSC deltas, aggregated per core, exported without touching the hot path.
- **Regression gates in CI**: a replay of a captured trading session through the full pipeline with per-stage assertions on p50/p99 (Ch. 57 §57.14). This is the only reliable way to catch a change that adds 200 ns.
- **Alerting on the tail, not the mean** (Ch. 59 §59.12). A p99.9 regression is a real degradation; a p50 regression is usually a measurement artifact.

The key discipline: **budget the p99, not the mean**, because the p99 is what you experience during the events that matter, and because optimizing the mean frequently makes the tail worse (batching is the standard example, §52.13).

---

## 52.12 Critical-Path Analysis

**Critical-path analysis** identifies the specific chain of dependent operations between input and output, and optimizes only that chain. Everything not on it is, by definition, not worth optimizing for latency.

### The method

1. **Define the endpoints precisely.** Usually: first bit of the triggering market-data frame in, first bit of the order frame out.
2. **Enumerate the dependency chain.** Not the code that runs — the code whose *result the output depends on*. Work that runs concurrently or is not a prerequisite is off the path.
3. **Measure each link** with TSC deltas or an external tap.
4. **Attack the longest link**, remeasure, repeat. The path changes as you optimize it; the second-longest link becomes the target and may be in a completely different component.

### What is off the path and commonly optimized by mistake

- **Book maintenance for price levels the decision never reads.** If the strategy only reads the top three levels, maintaining fifty is off the critical path — but it is not free, because it consumes cache and cycles that delay the path. The right framing: it is not on the *dependency* chain but it is on the *resource* chain.
- **Logging, metrics, position bookkeeping.** Move them after the send, not before it (see below).
- **Processing messages for instruments you do not trade.** Filter as early as possible — ideally in the NIC or in a BPF filter (Ch. 45 §45.12) so the packet never reaches your code.
- **The second and subsequent messages in a batched datagram**, when the decision depends only on the first. Realizing that you can decode, decide, and *send* on the first message before touching the rest of the packet is one of the highest-leverage restructurings available.

### The reordering that matters most

```cpp
// BEFORE: 250 ns of bookkeeping sits between the decision and the wire.
update_position(o); record_metrics(o); log_order(o);
nic_.send(encode(o));

// AFTER: send first; everything not needed to construct the order happens after.
nic_.send(encode(o));                    // ← the wire event
update_position(o); record_metrics(o); log_order(o);
```

The catch, and the reason this is a judgement call rather than a rule: any state that must be correct *before the next event is processed* has to be updated before returning to the poll loop, not before the send. Position and risk state qualify. Metrics and logging do not. And anything that could throw or fail must not be after a send that has already committed you.

### Speculative and precomputed work

The most effective critical-path technique is to move work **before** the trigger rather than making it faster:

- **Pre-encode the order message** with everything known in advance (session fields, symbol, side, capacity, firm), leaving only price, quantity, and the token to be filled in. This turns a 300 ns encode into three stores.
- **Precompute decision thresholds** whenever the book changes, so the trigger event only compares.
- **Warm every cache line and branch predictor** on the path by running the full path against synthetic input during quiet periods (Ch. 28 §28.10, Ch. 60 §60.7). A cold path costs 5–20 µs extra on its first execution — and the first execution after a quiet period is exactly the event you most want to win.

Cache warming is worth stating carefully because it is a favourite question: the fix is not to run the code with fake data and let it send an order, but to run it through a "dry-run" flag that exercises the same instructions and touches the same data up to the send, then discards. Some firms go further and send real orders far from the market purely to keep the transmit path warm.

---

## 52.13 Batching Trade-offs

**Batching** amortizes a fixed per-operation cost over several items. It is the single most reliable way to increase throughput and the single most reliable way to damage latency, and knowing exactly when it does which is the point.

### Where batching helps latency (yes, really)

Batching improves latency when the fixed cost is paid *per batch anyway* and the items are already present:

- **Draining a receive ring.** The poll-loop iteration cost, the coherence transfer of the ring's producer index, and the branch-predictor warmup are paid once. Processing all available packets per poll is strictly better than one per poll.
- **`recvmmsg` / `sendmmsg`** (Ch. 45 §45.11) amortize the syscall (~1–2 µs) across many datagrams. For a system that cannot bypass the kernel, this is the largest available win.
- **Consuming a queue** — read `tail_` once, process everything, update `head_` once (§52.10).

The unifying principle: **batching items that have already arrived is free latency-wise.** You are not waiting for anything.

### Where batching destroys latency

Batching hurts when it means **waiting** for more items:

- **Interrupt coalescing** (Ch. 46 §46.6) — a 50 µs coalescing timer adds up to 50 µs to every packet. Disable it entirely on latency-critical receive paths; the CPU cost of one interrupt per packet is irrelevant when you are busy-polling anyway.
- **Nagle's algorithm** (Ch. 38 §38.14) — withholds a small segment until the previous one is acked, adding up to an RTT. `TCP_NODELAY` on every order-entry socket, always.
- **Timer-based flush** — "send accumulated orders every 100 µs" adds up to 100 µs.
- **Generic Receive Offload** (Ch. 46 §46.9) — coalesces segments, adding delay and destroying per-packet timestamps.

### The general shape

```
latency
  │                                    ╱ waiting-for-batch regime
  │                                  ╱   (latency ∝ batch size)
  │  ╲                             ╱
  │    ╲                         ╱
  │      ╲___________________  ╱
  │        amortization regime
  │        (per-item cost falls)
  └────────────────────────────────────────► batch size
       1        opt
```

The optimum is the batch size at which the per-item fixed cost has been amortized but no waiting has been introduced — which, for an opportunistic batcher, is "however many happen to be available right now, and never more."

**The rule to state:** *batch opportunistically, never speculatively.* Process what is present; never wait for more. Every real low-latency batching mechanism — ring drain, `recvmmsg`, queue drain — has this property, and every harmful one (coalescing, Nagle, timer flush) violates it.

### The adaptive variant

Some systems batch more aggressively as load rises, on the theory that under overload throughput matters more than the latency of any individual message. This is defensible — it is a graceful-degradation mechanism (Ch. 56 §56.12) — but it must be an explicit, monitored policy with a documented trigger, not an emergent property of a queue that happens to fill.

---

## 52.14 Throughput-Latency Curves

The relationship between offered load and latency, which governs how much headroom a system needs.

### The shape and why

For a queueing system with utilization ρ = λ/µ (arrival rate over service rate), the M/M/1 mean waiting time is:

```
W = 1 / (µ − λ)  =  (1/µ) · 1/(1 − ρ)
```

```
latency
  │                                              │
  │                                             ╱│  ρ → 1: latency → ∞
  │                                          ╱   │
  │                                     ╱        │
  │                            ╱                 │
  │  ─────────────────                           │
  └──────────────────────────────────────────────┴──► ρ
  0        0.3        0.5      0.7   0.8  0.9   1.0
```

The consequences, which are not intuitive:

| ρ | Latency multiplier vs unloaded |
|---|---|
| 0.5 | 2× |
| 0.8 | 5× |
| 0.9 | 10× |
| 0.95 | 20× |
| 0.99 | 100× |

**Running at 50% utilization already doubles your queueing latency.** This is why low-latency systems are provisioned at utilizations that look absurdly wasteful — 10–20% average — and why "we have plenty of headroom, we're only at 60%" is a wrong answer.

### Why real systems are worse than M/M/1 predicts

- **Market data is not Poisson.** It is intensely bursty: microbursts (Ch. 39 §39.5) at 10–100× the average rate lasting microseconds to milliseconds, triggered by news, auctions, or a single large order sweeping levels. Instantaneous ρ during a burst can exceed 1 even when the daily average is 5%.
- **Variance is what drives queueing.** The Pollaczek–Khinchine formula shows waiting time grows with the *variance* of service time, not just its mean. A path with an occasional 50 µs stall queues far worse than one with a uniform 5 µs cost, at the same mean.
- **Correlated arrivals and correlated slowdowns.** The burst that raises λ is the same event that causes cache misses and branch mispredictions, raising service time simultaneously.

### The design implications

1. **Size for the burst, not the average.** The relevant capacity question is "how many messages can arrive in the worst 1 ms window?" — obtainable from packet captures of past volatile days (Ch. 57 §57.16).
2. **Measure the knee.** Load-test with realistic burst profiles and find the offered rate at which p99 begins to climb. Operate well below it (Ch. 60 §60.14).
3. **Queue depth is latency.** A 10,000-entry queue at 1 M msg/s holds 10 ms of latency when full. Bounded queues are not just a memory-safety measure — the bound *is* the latency bound (§52.15).
4. **Watch the coordinated-omission trap** (Ch. 43 §43.3) when load-testing. A load generator that slows down when the system slows down measures nothing.

---

## 52.15 Bounded Queues and Backpressure

Every queue between stages must have a fixed capacity, and the system must have a defined, tested behaviour when that capacity is reached.

### Why unbounded queues are always wrong

An unbounded queue converts a throughput problem into a latency problem and then into an availability problem:

1. Producer outpaces consumer; the queue grows.
2. Latency grows linearly with depth — a 1 M-entry backlog at 1 M msg/s is one second of staleness.
3. Memory grows; allocation appears on the hot path; the page cache and TLB (Ch. 32 §32.7) thrash.
4. Eventually the OOM killer (Ch. 32 §32.18) terminates the process — at peak load, which is the worst possible moment.

Critically, **the data at the head of a deep queue is stale and worthless.** A market-data update from 500 ms ago cannot inform a decision. The system is doing maximum work to produce output of zero value. This is the argument that makes bounded queues obviously correct rather than merely pragmatic.

### The four policies at capacity

| Policy | Behaviour | Correct for |
|---|---|---|
| **Block** | Producer waits | Never on a hot path — propagates the stall to the NIC and then to packet loss you cannot account for |
| **Drop newest** | Reject the incoming item | Rarely right for market data (you drop the *freshest* information) |
| **Drop oldest / overwrite** | Ring overwrites the stalest entry | **Usually right for market data and metrics** — the freshest state is what matters |
| **Fail fast** | Signal an error and take a defined action | **Right for order flow** — an order you cannot send must be reported, never silently dropped |

The asymmetry is the key insight: **market data is state, order flow is events.** Losing an old market-data update is usually recoverable (the next update supersedes it, or you resync — Ch. 53 §53.3). Losing an order message is never acceptable, because there is no subsequent message that supersedes it and the exchange may already have acted.

### Backpressure propagation

```
NIC ring ──► feed handler ──► [q1] ──► book builder ──► [q2] ──► strategy
   │             │                         │                        │
   │             │                         │                        └─ can't keep up
   │             │                         └─ q2 full: drop-oldest, count it
   │             └─ q1 full: same
   └─ if the feed handler stalls: ring overflow → rx_missed_errors → a GAP,
      handled by Ch. 53's recovery machinery, which is the honest outcome
```

The design principle: **backpressure must terminate somewhere explicit and accounted.** The worst architecture is one where each stage blocks on the next, so a slow strategy eventually causes silent NIC drops that appear as unexplained market-data gaps. Better: each stage drops according to its policy, counts the drops, and the counters are alarmed (Ch. 56 §56.11).

### Watermarks

A queue that reaches capacity has already failed. Instrument the depth and alarm at high-water marks well before:

```cpp
// Recorded on push, exported by a monitoring thread — no locks, no allocation.
depth_hwm_ = std::max(depth_hwm_, depth);
if (depth > kWarnDepth) [[unlikely]] ++warn_count_;   // relaxed counter, not a log
```

The observable that actually predicts trouble is not the average depth (near zero in a healthy system) but the **high-water mark per interval**. A queue whose HWM climbs from 3 to 300 over a week is degrading long before it drops anything, and that trend is the alert worth having (Ch. 59 §59.11).

---

## 52.16 Overload Shedding

**Load shedding** is the deliberate discarding of work when the system cannot keep up, chosen so that what remains is correct and useful. It is the difference between graceful degradation and collapse.

### Why "just process everything" fails

Under sustained overload, a system without shedding enters a **congestion collapse**: queues fill, latency rises, the work being done is stale, and the resources spent on stale work prevent fresh work from being processed. The system does maximum work and produces zero value. Shedding breaks the loop by ensuring the work in flight is always recent.

### What to shed, in priority order

| Priority | Work | Shed? |
|---|---|---|
| 1 | Order acknowledgements and fills | **Never.** Losing fill information corrupts position and risk state. |
| 2 | Risk checks, kill-switch evaluation | **Never.** |
| 3 | Cancels for working orders | Never — and prioritize them above new orders |
| 4 | Market data for traded instruments | Only by conflation (see below) |
| 5 | New order submissions | Yes — throttle before the exchange throttles you (Ch. 54) |
| 6 | Market data for non-traded instruments | Yes, and ideally filter it before it reaches the CPU |
| 7 | Logging, metrics, analytics | **Shed first.** Sample, then drop, and count what was dropped (Ch. 59 §59.7) |

### Conflation: the market-data-specific technique

**Conflation** replaces a queue of updates with a slot per instrument holding only the latest state. If three updates for the same instrument arrive before the consumer runs, the consumer sees only the third.

```cpp
// Conflating publisher: fixed slot per instrument, no queue growth, O(1).
void publish(std::uint32_t inst, const Book& b) noexcept {
    slots_[inst].store_seqlock(b);                 // §52.8
    if (!dirty_.test_and_set(inst)) pending_.push(inst);  // enqueue the ID once
}
```

The consumer drains `pending_`, and for each instrument reads the current slot. Queue depth is bounded by the instrument count regardless of update rate, and the consumer always sees the freshest state.

The essential caveat: **conflation is only valid for state, never for events.** A book snapshot can be conflated because the newest one supersedes the older. Trades, fills, and order acknowledgements cannot — each carries independent information, and conflating them loses it. Applying conflation to a fill stream is a position-corrupting bug. Conflating incremental *deltas* is equally wrong: deltas compose, so you must conflate the resulting *state*, not the delta messages.

### Detecting overload

The signal must lead the failure, not follow it:

| Signal | Quality |
|---|---|
| Queue high-water mark rising (§52.15) | **Good** — leads by seconds to minutes |
| Poll loop iterations per second falling | Good — direct measure of loop cost |
| Time-since-last-drain exceeding a threshold | Good |
| NIC `rx_missed_errors` rising | **Late** — you are already losing data |
| Latency p99 rising | Late and noisy |
| Dropped messages | Too late by definition |

### Shedding must be explicit and accounted

Every shed item is counted, by reason, per instrument or channel, and exported. An unaccounted drop is indistinguishable from a bug, and the first question after any incident is "did we drop anything, and what?" — a question the system must be able to answer without ambiguity. Shedding also must be **tested** (Ch. 57 §57.16): the overload path is the least-exercised code in the system and the most consequential, and a shedding policy that has never run in a load test will not work the first time it is needed.

---

## Key Interview Questions

1. **What exactly is tick-to-trade, and how would you measure it credibly?** — Wire-to-wire: first bit of the triggering market-data frame in, first bit of the order frame out, measured by an external hardware-timestamping tap. Internal `rdtsc` excludes the NIC, the DMA, poll discovery, and the entire transmit path.
2. **Why is the median tick-to-trade nearly useless?** — The events worth trading on arrive during bursts, when the system is loaded; the p99/p99.9 under burst conditions is the relevant statistic, and coordinated omission hides exactly the stalls that matter.
3. **Would you pipeline stages across cores or shard instruments across cores?** — Shard. Pipelining buys throughput by adding 200–500 ns handoffs to the latency path; sharding buys throughput with no handoff. Pipeline only work that cannot be partitioned by instrument.
4. **What does an inter-thread handoff actually cost, and where does the cost go?** — 100–300 ns busy-polled same-socket, microseconds with a sleeping consumer. It is a cache-line transfer of the payload plus one of the index, plus consumer discovery delay.
5. **What are the two biggest optimizations in an SPSC ring?** — `alignas(64)` separation of head and tail (kills false sharing) and caching the opposite index so the cross-core read happens only when the queue appears full/empty.
6. **Why put an index rather than the message in a queue?** — Shrinks the coherence transfer to one line, avoids the copy, and bounds the in-flight slab set naturally when the ring and slab share capacity.
7. **What is the single-writer principle and what does it buy?** — One thread writes each piece of state: no atomics, no locks, no coherence traffic on the write path, and deterministic ordering that makes replay-based debugging possible.
8. **How do you let other cores read the book without slowing the writer?** — A seqlock: the writer does two relaxed stores and never waits; readers retry on a version mismatch.
9. **Why is running at 60% utilization not "plenty of headroom"?** — Queueing latency scales as 1/(1−ρ): 50% doubles it, 90% is 10×. Market data is bursty, so instantaneous ρ during a microburst can exceed 1 at a 5% daily average.
10. **When does batching help latency and when does it hurt?** — It helps when the items are already present (ring drain, `recvmmsg`, queue drain) because nothing is waited for; it hurts whenever it means waiting (interrupt coalescing, Nagle, timer flush). Batch opportunistically, never speculatively.
11. **Why must every queue be bounded?** — An unbounded queue converts a throughput problem into unbounded latency, then memory exhaustion. Worse, the data at its head is stale and worthless, so the system does maximum work for zero value.
12. **What is the right overflow policy for a market-data queue versus an order queue?** — Market data is state: drop-oldest / overwrite, keeping the freshest. Order flow is events: fail fast and report, because no later message supersedes a lost order.
13. **What is conflation and when is it invalid?** — Replacing queued updates with a per-instrument latest-state slot. Valid for state (book snapshots), invalid for events (trades, fills, acks) and for deltas, which must be applied before conflating the resulting state.
14. **What signals overload early enough to act?** — Queue high-water marks and poll-loop iteration rate. NIC `rx_missed_errors`, latency p99, and drops are all lagging indicators.
15. **How do you separate hot, warm, and cold paths concretely?** — Isolated pinned cores and IRQ steering for hot threads; cold code out of line via `[[gnu::cold]]`/PGO/BOLT so it leaves the L1i; per-core counters so cold monitoring doesn't bounce hot cache lines; binary log records on the hot path with formatting off it.
16. **What work belongs after the send rather than before it?** — Anything not needed to construct the order and not needed for correctness before the next event: logging, metrics, analytics. Position and risk state must be updated before returning to the poll loop.
17. **Why is cache warming necessary and how do you do it safely?** — First execution after a quiet period costs 5–20 µs extra from cold L1i/dTLB/branch predictors — exactly the event you want to win. Exercise the full path with a dry-run flag that stops short of the send.
18. **Why does colocation dominate everything else?** — Fibre propagates at ~5 ns/m, so 500 extra metres costs more than an entire software tick-to-trade path. Exchanges equalize cable length, which pushes the competition into the switch, NIC, and code.
19. **Why do per-stage p99s not sum to the end-to-end p99?** — Percentiles are not additive; independent stages rarely have their bad case simultaneously, while correlated ones can be worse than the sum. The gap between the summed budget and the measured total is itself the diagnostic for unmeasured time.

---

## Common Traps

- **Quoting a tick-to-trade number without stating the measurement points** — internal timers routinely omit half the path.
- **Optimizing the mean instead of the tail** — the events that matter arrive when the system is loaded.
- **Coordinated omission in load tests** — a generator that backs off when the system stalls measures nothing.
- **Pipelining for latency** — every stage boundary adds 200–500 ns; shard instead.
- **Head and tail indices sharing a cache line** — triples SPSC cost through false sharing.
- **Re-reading the opposite index on every queue operation** — a cross-core load per item instead of per near-full event.
- **Copying whole messages through queues** — move indices into a preallocated slab.
- **Letting a stage block on a full downstream queue** — propagates backpressure to the NIC as silent, unaccounted packet loss.
- **Unbounded queues** — unbounded staleness, then OOM at peak load.
- **Drop-newest on market data** — discards the freshest information; overwrite the oldest instead.
- **Conflating fills, trades, or acks** — each carries independent information; conflation corrupts position.
- **Conflating deltas instead of state** — deltas compose and cannot be superseded.
- **Interrupt coalescing, Nagle, or GRO on a latency path** — pure added delay.
- **Draining only one message per poll iteration** — unbounded backlog under load, and a permanent stall under edge-triggered epoll.
- **Unbounded draining of one source** — starves the others; an order socket starved of acks is the worst case.
- **A cold thread on an SMT sibling of a hot core** — front-end contention on every shared resource.
- **Statistics counters sharing lines with hot data** — monitoring reads bounce the line to another core.
- **Formatting log strings on the hot path** — emit fixed-size binary records and format elsewhere.
- **Treating absence of market data as "no updates"** — an expired IGMP join produces silence, not an error; you need a staleness timer.
- **Running risk checks off the hot path** — a check that can be bypassed under load is not a control.
- **Provisioning to average rather than burst rate** — size for the worst 1 ms window in a captured volatile session.
- **Untested shedding logic** — the least-exercised, most consequential code in the system.
- **Unaccounted drops** — indistinguishable from a bug during an incident.
- **Floating-point prices anywhere in the pipeline** — fixed-point `int64_t` throughout.
- **A single global atomic for position or risk** — shard per writer and aggregate on read.

---

## Compact Recall Summary

**Latency definitions.** Wire-to-wire (external tap, first bit in to first bit out) is the honest metric; internal `rdtsc` measurements exclude NIC receive, DMA, poll discovery, and transmit. Software wire-to-wire is 2–10 µs with kernel bypass, 50–500 ns on FPGA, +5–15 µs with the kernel stack. Budget and report the p99 under burst load, and timestamp at arrival in hardware to avoid coordinated omission.

**Decomposition.** Feed handler → normalizer → book builder → strategy → risk → order encoder → NIC, with the market-data-to-order path ideally on **one thread, one isolated core, no queues**. Scale by **sharding instruments across cores**, not by pipelining stages; co-locate correlated instruments on the same shard. Feed handler owns framing, decoding, sequencing, and A/B arbitration so the book builder sees a single gap-free ordered stream.

**Book builders.** Indices not pointers, flat hash map for order references, and either a sorted level array (few active levels) or a direct price-tick-indexed array (bounded range, O(1) everything). Cache the BBO incrementally and use "BBO changed" as the strategy trigger. Validate against exchange book checksums; book bugs are silent.

**Normalization.** Fixed-point `int64_t` prices, dense `uint32_t` instrument IDs, nanosecond timestamps in a documented clock domain, **both exchange and local receive timestamps**, and a quality-flags field carrying recovered/stale/implied status. Normalize inline during decode into a trivially copyable fixed-layout struct — never a variant or virtual message type. Reference data is versioned and swapped atomically behind a pointer.

**Colocation.** ~5 ns/m in fibre makes distance decisive; exchanges equalize cabling, leaving switch hops (300–500 ns cut-through), NIC/transport choice, CPU clocking, and NUMA/NIC locality as the controllable variables. PTP grandmaster access is what makes one-way measurement possible.

**Path separation.** Hot = between market data in and order out: no allocation, locks, syscalls, logging, or exceptions. Warm = prompt but off-path, behind a bounded queue. Cold = everything else on housekeeping cores. Enforce with core isolation and IRQ steering, `[[gnu::cold]]`/PGO/BOLT code layout, per-core counters, and binary log records formatted off-thread.

**Single writer.** One writer per piece of state removes locks, atomics, and coherence traffic and makes execution deterministic and replayable. Publish to readers with a seqlock — the writer never waits, readers retry. When state genuinely has multiple writers: shard and aggregate, then funnel through a queue, then (last resort) an atomic.

**Queues.** SPSC handoff = 100–300 ns busy-polled, µs with a sleeping consumer. Make it cheap with `alignas(64)` head/tail separation, cached opposite indices, power-of-two masking, release/acquire on the index and relaxed data, trivially copyable payloads, and batched draining. Queue indices, not messages.

**Budgets and the critical path.** Assign p99 targets per stage; percentiles do not sum, and the gap between the summed budget and the measured total is the diagnostic for unmeasured time. Optimize only the dependency chain: send before logging, pre-encode static order fields, precompute thresholds, and warm the path during quiet periods.

**Batching and load.** Batch what has already arrived (ring drain, `recvmmsg`, queue drain); never wait for more (coalescing, Nagle, timer flush). Latency scales as 1/(1−ρ) — 50% utilization already doubles queueing delay — and bursty, variance-heavy market data is far worse than the M/M/1 model. Provision for the worst 1 ms window.

**Bounded queues and shedding.** Every queue is bounded, and the bound *is* the latency bound. Market data is state → overwrite the oldest; order flow is events → fail fast and report. Shed logging and analytics first, non-traded instruments next, new orders before cancels; never shed fills, acks, or risk checks. Conflate state per instrument, never events or deltas. Alarm on rising high-water marks, which lead failure; drops and `rx_missed_errors` are lagging. Count every shed item by reason, and load-test the shedding path.
