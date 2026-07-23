# Chapter 59 — Observability

Observability is the ability to answer important production questions correctly and quickly from evidence the system deliberately emits or retains. In a low-latency service, that evidence must not become an unbounded producer of latency, memory, disk, network traffic, or cardinality.

The design problem is not “add logs and dashboards.” It is:

> Define signal semantics and ownership, bound hot-path work and storage, account for telemetry loss, preserve causal context, and make one incident reconstructible without pretending timestamps or sampled data are complete.

Chapter 43 owns measurement methodology, statistics, histogram interpretation, and benchmarking. This chapter owns production signals: metrics, structured events, traces, profiles, health/progress signals, watchdogs, alerts, and flight recorders.

Label every implementation claim:

| Label | Example |
|---|---|
| Signal contract | `orders_rejected_total` counts terminal admission rejections |
| C++ requirement | concurrent non-atomic read/write is a data race |
| Product/tool fact | a backend’s histogram or tail-sampling behavior |
| Version/schema fact | log record version 7 and dictionary build ID |
| Deployment fact | collector CPU, scrape cadence, ring capacity |
| Measurement | instrumentation cost and telemetry loss under workload B |

A sampling rate, buffer size, cache-line width, alert window, or stall timeout is not universal. Derive it from event rate, diagnostic objective, resource budget, failure policy, and measured observer effect.

The final test of observability is practical: during a failure, can an owner determine what became unsafe, when, why the evidence is incomplete, and which reversible action follows?

## The 90-second screen — Core

For each production signal, answer:

1. **Question:** What operator or automated decision does it support?
2. **Semantic owner:** Which component defines and increments/emits it?
3. **Type/unit:** Counter, gauge, histogram, state transition, event, span, profile, or recorder entry?
4. **Dimensions:** Which labels are bounded, and what is the maximum series/schema cardinality?
5. **Hot-path cost:** Copies, atomics, cache lines, timestamp reads, allocation, formatting, syscalls, and branches?
6. **Buffering:** Capacity in records and bytes, expected coverage horizon, and memory placement?
7. **Backpressure:** Drop, overwrite, sample, block, spill, or disable—and why is that safe?
8. **Loss visibility:** Which counter/gap record proves telemetry is incomplete?
9. **Correlation:** Event/trace/order IDs, per-owner sequence, clock domain, and uncertainty?
10. **Failure behavior:** What happens when collector, disk, network, clock sync, or decoder fails?

The signal flow should be explicit:

```text
critical owner
  | fixed, bounded update/record
  +-> owner-local counters/histogram
  +-> bounded event or trace ring
  +-> overwriting flight recorder

collector / backend (off critical owner)
  -> aggregate, encode, batch, persist/export
  -> expose telemetry-loss and collector-health signals
  -> trigger alerts and incident capture
```

No arrow has infinite capacity. If an exporter slows, the critical owner follows a predeclared policy rather than inheriting the exporter’s latency.

## 59.1 Goals, signals, and ownership

Production evidence should answer:

- **rate:** what work arrives, completes, rejects, or drops;
- **errors:** which invariant, protocol, resource, or dependency failed;
- **saturation:** which queue, thread, pool, session, device, or storage boundary is nearing capacity;
- **distribution:** how latency, size, batch, and queue age vary;
- **state:** which mode, health, reference version, session, or failover epoch is active;
- **causality:** which input and state produced an output;
- **history:** what happened immediately before a rare failure.

The main signal classes trade detail for cost:

| Signal | Best for | Main cost/risk | Loss behavior to define |
|---|---|---|---|
| counter | cumulative occurrences/rates | update and collection coherence | reset/wrap/process restart |
| gauge | current sampled state | missed between-sample behavior | staleness and scrape gaps |
| histogram | mergeable distribution with fixed schema | per-observation bucket update, storage | overflow/underflow and dropped samples |
| structured event/log | discrete explanation and audit context | bytes, queue, formatting/persistence | record drops and gaps |
| trace/span | causal path and stage timing | context propagation and event volume | sampling and partial traces |
| profile | where CPU/memory/blocking occurs | sampling/collection overhead | sample bias and unsupported frames |
| health/progress | automation and operator state | false confidence or flapping | stale/missing signal semantics |
| flight recorder | detailed recent pre-failure history | fixed memory and dump path | overwritten generations/dump failure |

One signal should have one semantic owner. Multiple components can contribute separate shards, but the aggregation rule must be explicit. A metric called `errors` owned by everyone has no stable meaning.

### Start from incident questions

For a latency incident, operators need more than a percentile:

```text
Did offered load or event mix change?
Which stage/queue accumulated age?
Were inputs healthy and clocks comparable?
Which event IDs form the tail?
Did telemetry itself drop or stall?
What build/config/reference/deployment was active?
What state transitions or faults preceded it?
```

Design dashboards, traces, and recorder schemas from these questions. Collecting every available host metric without an investigation path increases cost and cognitive load.

### Signal ownership map

Map each critical architecture boundary to both a correctness signal and a capacity signal:

| Boundary | Correctness/state signal | Rate/saturation signal | Detail source |
|---|---|---|---|
| network -> feed | sequence gaps, invalid/recovery transitions | packets/events, ring/backlog drops | packet metadata and feed recorder |
| feed -> market state | rejected version/event, stale state | apply rate, queue age/high-water | state-transition event |
| state -> strategy | decision suppressed by quality/version | decision rate and span histogram | sampled causal decision |
| strategy -> risk | reject/reason, reservation expiry | intent rate and reservation saturation | risk decision record |
| risk -> gateway | admission without/with valid reservation | intent-queue age, throttle headroom | order audit transition |
| gateway -> venue | disconnect/ambiguous state, encode/send error | bytes/messages, TX queue age | session recorder |
| venue -> gateway | duplicate/illegal response, reconciliation state | ack/fill rate and latency | canonical order history |

An application signal does not replace lower-layer evidence. A feed gap can originate on the wire, NIC, kernel, application queue, or decoder. Chapter 46 names those counters. Likewise, a host CPU metric does not reveal which business state became unsafe. Preserve layer boundaries so an incident can identify the first failing stage.

**Profiles** are supporting signals, not continuous truth. A CPU profile can explain where samples landed during a slow interval; it cannot show a missing market-data packet, prove order identity, or replace state transitions. Combine resource evidence with domain evidence.

## 59.2 Cost, boundedness, cardinality, and backpressure

### Instrumentation cost model

For one signal update, inventory:

\[
C = C_{\text{clock}}+C_{\text{lookup}}+C_{\text{atomic/coherence}}
  +C_{\text{copy}}+C_{\text{branch}}+C_{\text{queue}}
\]

Formatting, allocation, syscall, compression, and network/disk I/O should normally be off the critical owner. “Asynchronous logging” is not free: producing a record still evaluates arguments, reads time, copies fields, updates queue state, and may transfer cache lines.

Measure:

- disabled instrumentation;
- enabled without a collector;
- enabled with healthy export;
- exporter slow/unavailable;
- ring full/drop/overwrite;
- trigger/dump;
- realistic event mix and burst load.

Report distributions and correctness outcomes, not one minimum loop number. Chapter 43 defines methodology.

### Bounded cardinality

Metric series count is approximately the cross-product of metric name and label values. Labels such as raw order ID, user string, stack trace, error text, IP, or symbol from an unbounded namespace can create unbounded memory/index/network work.

Before adding a label, write:

```text
value source
maximum values per process and fleet
retention/lifecycle
aggregation question it answers
behavior for unknown/new values
backend product limits and cost
```

Use bounded categories for metrics: venue/partition from configuration, status enum, error-reason code, latency class, or a deliberately capped top-K/bucket. Put per-order or per-packet detail in a bounded event/trace/recorder channel and link a small number of examples through exemplars or IDs where the product supports it.

Cardinality controls must exist before backend ingestion. A backend rejecting excess series does not refund hot-path allocation or network cost.

Calculate the bound before coding. With 8 owners, 4 configured venues, and 12 reason codes, a fully crossed metric can produce at most:

\[
8\times4\times12=384
\]

series per metric name. Adding an `instrument` label with 4,000 values raises that theoretical bound to 1,536,000. Adding raw order ID makes the bound a function of traffic and retention, which is not acceptable for a normal metric.

Cross-products may be sparse, but budgeting the maximum forces an explicit decision. If per-instrument visibility is necessary, alternatives include:

- a fixed array aggregated into configured product/venue groups;
- capped top-K with an `other` bucket and churn/eviction counters;
- on-demand temporary diagnostics with authorization and expiry;
- structured events queried by entity ID;
- recorder capture triggered for a selected instrument;
- exemplars linking selected histogram observations to traces.

Top-K is approximate and can churn under changing workloads. Export the algorithm/window/capacity and eviction count. An `other` bucket is part of the truth, not an inconvenience to hide.

### Backpressure table

| Signal | Full/slow policy candidate | Required evidence |
|---|---|---|
| owner-local counter | remain local until collector catches up | collector age/staleness |
| optional debug event | drop/sample | dropped count by reason/source |
| mandatory audit event | reserved durable path or fail action safely | commit/ack state and failure alarm |
| trace span | head/tail/adaptive sampling per policy | sampled/dropped/incomplete counts |
| flight recorder | overwrite oldest | generation/overwrite boundary |
| recorder dump | rate-limit/coalesce/fail visibly | dump result and suppressed-trigger count |

Audit/compliance records are not ordinary debug logs. Their durability and failure action are business/jurisdiction requirements and may deliberately constrain trading. Chapter 60 owns disk retention and operational lifecycle.

Never let an unbounded logger turn telemetry overload into process memory exhaustion. Never block a critical owner merely because a debug backend is slow. If a mandatory sink must block or fail closed, state that as a safety requirement and capacity-test it.

### Telemetry resource budget

Budget telemetry like any other pipeline:

```text
per-event producer work
records/s and bytes/s at normal and burst load
in-memory bytes and coverage age
collector CPU and batching
export/network bytes
disk/backend ingest and retention
worst-case time to detect sink failure
```

For a synthetic 48-byte detailed record at 200,000 events/s, the producer generates 9.6 MB/s before ring headers, alignment, batching, or exporter encoding. At a burst of 1,000,000 events/s it generates 48 MB/s. A 65,536-record queue covers about 328 ms at the first rate and 66 ms at the second if the consumer stops. These numbers are arithmetic examples, not recommended formats or capacities.

The calculation exposes choices: sample detail while retaining aggregate counts, enlarge a fixed memory budget, drain faster off-path, or accept a shorter evidence window with explicit loss. It also reveals when continuous “full detail” cannot meet both hot-path and retention objectives.

Measure bytes as well as records. One exceptional event containing a bounded-but-large payload can dominate. Keep record-size histograms or counters by schema class, and reject/truncate according to a documented diagnostic policy rather than allowing arbitrary text.

### Telemetry failure matrix

| Failure | Hot-owner behavior | Evidence/alert |
|---|---|---|
| collector paused/crashed | local bounded signals continue; optional detail eventually drops | collector age, producer drops, restart epoch |
| exporter/network unavailable | bounded retry/spool/drop per stream | export failure, backlog bytes/age |
| disk full/slow | optional records drop; mandatory stream follows safety contract | disk error, partial commit, safety transition |
| backend cardinality/schema reject | producer cardinality remains bounded | rejection count and offending schema/label category |
| decoder/dictionary mismatch | retain raw bytes; fail decode loudly | build/schema identity and decode error |
| clock unsynchronized | stop publishing affected cross-domain latency as valid | sync/translation error and invalid observation count |
| owner process crash | recorder/event tail may be partial | process epoch, incomplete marker, external audit/recovery |
| observability configuration change | atomic/versioned activation | old/new policy IDs and effective boundary |

Test this matrix under burst load. Healthy-export tests do not reveal whether retry, dumping, or error reporting becomes the new critical path.

## 59.3 Metrics semantics and per-owner aggregation

### Types

A **counter** is cumulative over a declared lifetime and normally increases. A reset can occur at process restart or explicit epoch; export a start/epoch identity. Rates are derived from counter differences and time.

A **gauge** is a current value such as queue depth, live orders, mode, or last completed sequence. It can rise or fall. A scrape observes one instant and may miss intervening peaks, so separately maintain high-water or transition counters where needed.

A **histogram** stores counts in configured buckets or another mergeable schema. Histograms merge only when unit, boundaries/encoding, and semantic population match. Per-instance quantiles cannot be averaged into a fleet quantile.

A **summary/quantile product type** may compute client-side quantiles with product-specific windows/algorithms and often cannot be merged exactly. Treat this as a product contract, not a universal “summary” definition.

Every metric specifies:

```text
name and unit
what increments/sets/observes it
population and exclusions
labels and cardinality bounds
lifetime/reset/overflow behavior
collection consistency
schema version
```

Use units in names or metadata consistently. Do not publish a value called `latency` whose unit changes between code paths.

### Per-owner and per-core counters

Owner-local metrics avoid a single contended global update. If a collector concurrently reads fields that the owner writes, ordinary non-atomic C++ objects create a data race. For independent numeric counters, relaxed atomics can provide defined atomic access without claiming ordering of unrelated state.

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

struct alignas(64) OwnerMetrics {
    std::atomic<std::uint64_t> events{0};
    std::atomic<std::uint64_t> rejects{0};
    std::atomic<std::uint64_t> telemetry_drops{0};
};

template<std::size_t N>
std::uint64_t total_events(const std::array<OwnerMetrics, N>& shards) {
    std::uint64_t total = 0;
    for (const auto& shard : shards) {
        total += shard.events.load(std::memory_order_relaxed);
    }
    return total;
}
```

`alignas(64)` is an illustrative deployment choice, not a portable claim that every destructive-interference boundary is 64 bytes. Validate type layout and cache behavior on supported targets. `memory_order_relaxed` makes only the counter access atomic; it does not publish the owner’s book, order, or risk state.

Per-core metrics are a deployment specialization of owner-local shards, not a portable thread identity. They are straightforward when each owner is pinned under a stable placement contract. A migratable user-space thread can update several CPU shards, and reading a current-CPU ID before an update can race migration unless the placement or update protocol prevents it. CPU hotplug and topology changes also alter the shard set. Prefer per-owner shards unless the diagnostic question truly concerns CPU placement; if per-core shards are required, bound configured CPU IDs and export placement/epoch changes.

The collector’s sum is not an atomic fleet snapshot. Owners advance while it reads. Cross-counter expressions such as `sent - acked` can appear transiently inconsistent when collected from different shards/instants. Options include:

- accept eventual/approximate semantics and avoid invariants on the scrape;
- publish an owner-created snapshot;
- attach per-owner epochs/sequences and retry;
- collect an event ledger for exact reconciliation.

Choose collection cadence by operational need and measured observer effect. Reading a hot owner’s cache lines too often can create coherence traffic.

For several related values, define whether readers need:

1. **independent eventual counters:** each field is meaningful alone;
2. **owner-consistent snapshot:** one owner publishes related values together;
3. **globally consistent cut:** several owners coordinate at an epoch/barrier;
4. **exact event ledger:** derive state from ordered durable events.

The cost and availability rise down the list. Most dashboards need (1) or (2), while financial reconciliation may need (4). Do not build a global stop-the-world scrape merely to make a graph look tidy.

A safe owner-published snapshot can be copied into a bounded message whose ownership transfers to the collector, or placed in immutable storage with a lifetime protocol. Double buffering alone is insufficient if the owner reuses a buffer while a reader still accesses it. A sequence protocol over non-atomic concurrently modified payload bytes can still be a C++ data race. Use atomic fields, a proven publication/lifetime mechanism, or quiescence.

### Overflow and reset

Unsigned counters wrap modulo their width in C++, but exporters/backends may convert to signed integers or floating point and lose precision. Define realistic maximum rate/lifetime, reset behavior, and export representation. Epoch/start identity distinguishes restart from negative rate. Saturating a counter hides subsequent occurrences; wrapping without detection corrupts rate. Test the chosen policy.

## 59.4 Latency histograms in production

A latency histogram needs:

- start and end event definitions;
- clock domain(s) and uncertainty;
- unit and range;
- bucket/encoding schema and version;
- event population and exclusion reasons;
- sample policy and weight;
- underflow/overflow counters;
- count and telemetry-drop counters;
- labels/cardinality limit.

Record end-to-end latency plus selected stage spans for the same causal event. Do not add independently aggregated p99 values. Chapter 43 covers percentiles, coordinated omission, confidence, and comparison.

### Merge and rotation

Bucket histograms merge by summing corresponding bucket counts only when boundaries and semantics match. If a deployment changes buckets, retain schema identity or translate with explicitly accepted information loss. An observation on a histogram boundary follows the library/product’s inclusion convention; tests should pin it.

Maintain interval views by rotating or differencing cumulative data with reset-safe epochs. Rotation across owners is not simultaneous unless coordinated. A fleet view must preserve total sample count and under/overflow counts; otherwise a “better” tail may simply mean missing samples.

### Sampling

**Head sampling** decides before the outcome, so it can be unbiased if selection is independent and weights are handled correctly, but it may miss rare tails. **Tail sampling** retains based on outcome, requiring buffering or later correlation and producing a deliberately biased diagnostic set. **Adaptive sampling** changes with load/state and must export its probability/policy.

There is no universal sampling rate. Suppose a rare class occurs with probability \(p\) and independent head sampling retains fraction \(s\). The chance of retaining at least one instance in \(n\) events is:

\[
1-(1-ps)^n
\]

This simplified calculation helps size a policy; independence and stationarity may not hold during correlated incidents. Always preserve unsampled aggregate counts/histograms when using sampled detailed records.

Sampling and telemetry drops are different. A planned sampling decision follows policy; a queue/drop is loss. Count both separately.

### Exemplars and tail investigation

An **exemplar** associates a selected histogram observation or bucket with a trace/event identifier. Product support and storage semantics vary, but the architectural value is stable: aggregate evidence says the distribution moved; the exemplar points to a concrete causal record.

Selection must be bounded. Options include one exemplar per interval/bucket, reservoir within a bounded interval, or first/last/worst under a declared policy. “Worst” requires comparing observations and can overrepresent one repeated cause. Export how the exemplar was chosen and never treat it as a statistically representative sample.

When an observation lacks a valid clock translation, increment a clock-invalid counter and retain diagnostic context separately; do not insert a negative or clamped duration into the ordinary latency histogram. When an operation has no completion, represent timeout/missing outcome in counters or a censored/outcome model rather than silently excluding it.

## 59.5 Structured events, binary logging, and queues

Text formatting is useful for humans but expensive and ambiguous on a hot path. A structured record carries typed fields:

```text
schema/site ID
record version and build/dictionary ID
owner/thread ID and monotonic sequence
local timestamp plus clock-domain ID
causal/event/order identifiers
event kind/reason
fixed payload or reference to durable owned data
```

Binary/deferred logging moves formatting and encoding work to a backend. It imposes lifetime rules: never enqueue a pointer/string view into mutable or stack storage unless the ownership protocol guarantees it survives consumption. Copy bounded bytes or intern stable IDs.

Schema evolution must decode old retained data. Ship the dictionary/schema with the artifact and stamp every stream/dump. A decoder mismatch should fail loudly, not produce plausible wrong text.

### Queue choice

Per-owner SPSC rings can avoid multi-producer contention when one backend consumes each ring. MPSC/MPMC designs trade topology simplicity for additional coordination. “Lock-free” says something about progress, not cost, boundedness, correctness, or absence of cache-line transfer.

The queue contract includes:

- fixed record and byte capacity;
- payload lifetime;
- producer/consumer memory ordering;
- behavior at wrap and integer overflow;
- full policy;
- record-drop/gap representation;
- shutdown/drain behavior;
- backend batching and sink failure.

**Drop accounting.** A debug queue normally drops rather than blocks its owner. The producer increments a drop counter even if it cannot enqueue a gap record. When space returns, the backend can synthesize “records missing” using observed sequence gaps and producer counters. Never make the only loss counter travel through the queue whose loss it measures.

### Reserve, commit, and consume

A bounded ring record commonly has a lifecycle:

```text
free slot -> producer owns/reserves -> payload complete
          -> committed/published -> consumer owns/reads -> free
```

The consumer must not observe a partially initialized payload. The producer must not reuse storage until the consumer has released it, unless overwrite is the declared recorder policy. Memory-order details belong to the chosen queue implementation and Chapter 26; tests should cover wrap, full, producer interruption after reserve, consumer restart, and integer-counter rollover assumptions.

Variable-size records complicate wrap and recovery. A fixed header with total length, schema, sequence, and commit/integrity marker lets an offline decoder reject a truncated tail. Still bound individual record length and total bytes. A corrupt length must not cause the decoder to walk beyond the retained segment.

The backend is a state machine too:

```text
drain rings -> batch encode -> write/export -> acknowledge local progress
                        \-> retry/drop/spool/fail according to stream policy
```

If it retries forever in memory, the queue is effectively unbounded. If it drops a batch, count records/bytes/time range and preserve stream sequence gaps. If it spools, bound disk bytes and define eviction. If mandatory audit persistence fails, invoke the approved safety action rather than silently switching to debug-log semantics.

### Sampling and rate limiting

Sampling strategies include deterministic hashing by trace/order ID, probabilistic head sampling, first-N-per-category, token-bucket rate limits, state-triggered capture, and tail selection. Each biases the retained set differently.

Rate limiting protects resources but can discard the burst operators wanted to inspect. Pair it with aggregate counters and a flight recorder. Use stable hash sampling when all events for one causal ID should be retained together. Never sample mandatory audit facts without an approved alternative source.

Argument evaluation can dominate a disabled/sampled log site. Guard expensive field construction behind the enable/sample decision, while ensuring the decision itself does not depend on data omitted from the sampling policy. Avoid macros that evaluate an expression more than once. Any formatting deferred to another build/process must retain the exact site dictionary and type schema used by the producer.

## 59.6 Traces, correlation, clocks, and profiles

A trace represents causal work using a trace ID and spans/events with parent/link relationships. Distributed tracing products and OpenTelemetry-style specifications define particular context, sampling, and export formats; version and product behavior must be checked. The architecture is general:

```text
market ingress event
  trace/event ID
  -> decode span
  -> state-update span
  -> decision span
  -> risk span
  -> gateway/send span
  -> acknowledgment linked by order/session IDs
```

Not every externally related event is a strict parent/child. An acknowledgment can link to an order and session; a market decision can depend on several market events. Preserve domain IDs rather than forcing causality into one tree.

Span creation has costs: generating/propagating context, reading clocks, storing attributes/events, queueing/export, and retaining partial trace state. Attribute cardinality can be as dangerous as metric labels even when the backend stores traces differently. Bound attribute size and avoid copying payloads merely “for tracing.”

Sampling can create partial traces. A downstream component may receive sampled context when an upstream exporter lost its span, or a tail sampler may time out before late spans arrive. Export incomplete/late/dropped counts and allow incident tools to show gaps. Never infer “component did not run” solely from an absent sampled span.

For a decision depending on several market events, use links or domain dependency records. A trace tree optimized for request/response services may not naturally represent fan-in, multicast, replay, or asynchronous execution reports. Product conventions are not market-causality definitions.

### Correlation fields

Use complementary orderings:

- protocol sequence identifies source order/gaps within its domain;
- owner-local sequence gives total local emission order;
- trace/event/order IDs express causality/identity;
- monotonic timestamps give elapsed ordering within a clock domain;
- wall/exchange/hardware timestamps provide external anchors with uncertainty.

Timestamps alone do not prove causality or total order. Equal/coarse timestamps need a tie-break. Clocks can step, drift, migrate between domains, or be read at different physical points. Negative duration is a clock/correlation fault unless the defined endpoints legitimately reverse.

For cross-domain duration:

\[
\hat{L} = t_B - t_A,\qquad
|\text{error}| \le \epsilon_A+\epsilon_B+\epsilon_{\text{translation}}
\]

provided the error bounds are valid for that interval. Export clock source, sync state, offset/error estimates, and translation anchors. Chapter 48 covers timestamp mechanics; Chapter 43 covers measurement.

### Profiles

Profiles answer where CPU time, allocation, blocking, faults, or other sampled events occur. Continuous profiling can connect regressions to code paths, but collection, stack unwinding, symbolization, sampling frequency, and unsupported frames have product/platform/version-specific costs and bias.

Keep profiling on bounded controlled settings, measure observer effect, retain build IDs/symbols, and correlate profiles with load/state. A profile says where samples landed, not automatically why latency rose.

## 59.7 Health, heartbeats, watchdogs, and alerts

### Health is progress, not endpoint responsiveness

Separate:

- **liveness:** process/control plane is responding;
- **readiness:** safe and configured to accept intended work;
- **domain health:** feeds/session/risk/reference state valid;
- **progress:** critical owner advances expected counters within a workload-aware interval.

An HTTP health thread returning success does not prove the critical event loop is progressing. Conversely, a quiet market may legitimately leave a message counter unchanged. Use a loop/progress epoch plus input/output expectations and state.

Health collection must not take a lock held by the monitored hot owner or enqueue into its saturated queue. The monitor should be able to report “owner unobservable” separately from “owner unhealthy.”

A heartbeat carries identity and state such as build/config epoch, role/fencing epoch, domain status, and progress sequence. Sending and checking it through the same failed resource can create false health. Timeout and cadence are deployment policies derived from false-positive tolerance and required detection time; test stalls and partitions.

### Watchdogs and stall detectors

A stall detector samples:

```text
progress counter/sequence
last progress time in a monotonic domain
owner state and expected workload
queue age/depth
```

Distinguish no input, slow progress, no progress, blocked/uninterruptible state, spinning/livelock, and monitor failure. On trigger, preserve evidence before disruptive action: mark state, request flight-recorder freeze/dump, capture permitted thread/host diagnostics, and notify the safety owner.

Restart, halt, cancel, failover, or alert-only behavior is operational policy, not an observability default. Automated action must respect order/session/risk uncertainty. Chapter 60 owns supervision and recovery.

### Actionable alerts

Alert on a condition an owner can act on:

| Condition | Supporting context |
|---|---|
| error/invariant counter increase | reason, component, build/config, last transitions |
| queue age/high-water approaching bound | offered rate, consumer progress, drop count |
| latency objective violations | sample count, load/event mix, stage spans, exemplars |
| telemetry loss | source/ring/sink drop counters and collector lag |
| stale/invalid domain state | affected scope, source sequence, recovery status |
| clock uncertainty | clock source, offset/error, affected latency metrics |
| disk/export failure | buffered bytes/age, mandatory versus optional streams |

Percentile alerts require enough population and stable definitions. Counts of objective violations and error-budget consumption are often easier to reason about, but exact policy belongs to the service objective. Avoid universal thresholds/windows.

An alert should link a runbook and automatically preserve a bounded incident bundle. Deduplicate/rate-limit notifications without hiding the underlying condition count.

### Detection and action are separate

A detector states evidence:

```text
condition + scope + first/last time + count
+ signal quality/loss + relevant state/load
```

An action policy decides page, ticket, capture, reject-new, cancel, failover, restart, or observe. Keeping them separate makes alert logic testable and prevents a changed threshold from silently changing safety behavior.

Test alerts with recorded metric/event sequences and virtual time. Cover rising condition, recovery, missing data, clock jumps where relevant, deployment maintenance, and repeated flapping. Assert notification count plus capture/action requests. A dashboard screenshot is not an alert test.

Multi-window/error-budget methods can distinguish rapid severe burn from slow degradation, but parameters derive from the service objective and traffic. Low-volume services may need event-count or state-based alerts instead of unstable tail estimates.

## 59.8 Flight recorders

A flight recorder is a fixed-capacity circular history that overwrites old records and is frozen or dumped on a trigger:

```text
oldest retained -> [event ... event ... event] <- newest committed
                    ^ overwritten as writer wraps

trigger -> freeze/swap/snapshot protocol -> bounded dump -> offline decode
```

It retains detailed pre-trigger context without continuously persisting every record. Capacity determines coverage:

\[
\text{expected horizon}\approx
\frac{\text{record capacity}}{\text{event rate}}
\]

Event rate varies during incidents, so measure actual oldest/newest timestamps and overwritten generations rather than promising “the last N seconds.”

For an illustrative 2 MiB buffer with 32-byte fixed records:

\[
\text{capacity}=\frac{2\times1024\times1024}{32}=65{,}536
\]

At 50,000 records/s its average horizon is about 1.31 s; at a 500,000 records/s burst it is about 0.13 s. Neither rate is a default or guarantee. Header/alignment overhead, multiple writers, variable events, and dump/swap behavior change the calculation. Choose capacity from the pre-trigger interval needed at the relevant burst rate and from a tested memory budget.

### Record and concurrency design

Prefer fixed-size records or a separately bounded payload arena. Include format/build ID, writer/owner, monotonically increasing writer sequence, clock domain, event kind, causal IDs, and payload validity. Preallocate and establish memory residency appropriate to the deployment, then measure record cost.

A simple single-writer buffer is safe to write, but a collector concurrently copying non-atomic slots can create a C++ data race. Safe choices include:

- quiesce the writer before snapshot;
- swap between buffers through a defined ownership handoff;
- publish each slot with an atomic fixed-record protocol;
- keep recorder per owner and have that owner perform a bounded freeze.

Do not cite “seqlock” while copying ordinary concurrently modified C++ bytes without addressing the data race. Verify wrap, incomplete record, sequence gap, and crash-mid-write behavior.

A double-buffer ownership protocol can be:

```text
owner writes A
trigger request observed by owner
owner seals A with [first_seq, last_seq, valid_bytes, schema]
owner publishes A to dump worker and switches to free B
dump worker exclusively reads A
after successful/failed bounded dump, A returns to free pool
```

If no free buffer exists on another trigger, count/coalesce/suppress according to policy; never let the owner wait unexpectedly. The handoff needs a C++-safe publication mechanism, and the dump worker must not return A until all I/O using it is complete. This preserves post-trigger events in B, but doubles recorder memory and still has finite trigger capacity.

### Dump failure and signal safety

Dumping is I/O and can amplify an incident. Bound dump size/rate, coalesce triggers, count suppressed requests, preflight storage, and report partial/failure status. Decide whether the live service continues recording into a second buffer or loses the post-trigger interval.

Crash/signal handlers have severe restrictions. C++ library facilities, locks, allocation, formatting, and even some atomic operations may not be async-signal-safe/lock-free on every platform. Chapter 58 owns crash-handler constraints. A normal watchdog-triggered dump from a controlled thread has a different safety envelope from a fatal-signal handler.

Kernel, hardware, and tracing products offer snapshot/ring mechanisms, but their modes, overwrite semantics, supported platforms, and overhead are tool/version-specific. Treat them as additional evidence sources and measure them on the deployed system.

## 59.9 Worked telemetry and incident design

Consider a service with two market-data owners, four strategy shards, and one order gateway. The objective is to diagnose order-ack tail spikes without making the gateway depend on telemetry.

### Signal plan

| Owner | Always-on local signals | Bounded detail | Full behavior |
|---|---|---|---|
| feed | packets/events/gaps/recovery counters; queue age histogram | quality-transition events; recorder | drop optional detail; never hide input gap |
| shard | decisions/rejects; decision latency; intent-queue age | sampled causal decision event; recorder | reject new intent by architecture, not telemetry |
| gateway | intents/bytes/acks/fills/throttles; live queue gauges; ack histogram | every state transition on mandatory audit path; recorder | debug drops; audit failure follows safety policy |
| collector | scrape/export/disk errors and lag | incident bundle manifest | never block owners for optional export |

Cardinality is bounded by configured owner/venue/reason codes. Raw order ID appears only in structured/audit/trace records, not as a metric label.

All event records carry:

```text
build/config/reference epoch
owner ID + owner sequence
monotonic timestamp + clock-domain ID
trace/event ID
order/client/session identifiers where applicable
event kind/reason and bounded payload
```

### Incident

At time \(t_0\), the `ack_latency_objective_violations_total` counter rises. A detailed record is sampled because the event exceeded the objective, and a gateway recorder freeze is requested.

The incident bundle shows:

```text
t0-40 ms  offered intent rate stable
t0-12 ms  gateway outbound queue age begins rising
t0-10 ms  gateway progress continues, but completion batch size falls
t0-8 ms   optional debug-log ring begins dropping; drop counter rises
t0        ack objective violations rise
t0+2 ms   flight recorder frozen; one duplicate trigger suppressed
```

Correlation by order ID and gateway sequence shows intent admission to send submission became slow; external order-to-ack after egress did not. Feed and strategy spans remained stable. The debug logger’s drops are evidence loss, not automatically the cause: its queue was designed not to block.

Further deployment counters show the gateway shared a CPU resource with a newly enabled collector task. Disabling that task in a controlled rollback restores outbound queue age and latency. This supports a mechanism: observer interference delayed gateway service. It is stronger than “logging caused it” because the architecture, telemetry-loss behavior, queue age, per-event spans, and reversal agree.

### What made diagnosis possible

- end-to-end and stage boundaries were distinct;
- owner-local sequences survived ambiguous timestamps;
- queue **age**, not only depth, led the alert;
- tail detail linked a histogram to concrete orders;
- debug loss was counted, so the timeline was marked incomplete;
- the flight recorder retained pre-trigger context;
- build/deployment/config identity was in the bundle;
- optional telemetry could degrade without backpressuring the gateway.

### Incident reconstruction procedure

1. **Validate evidence quality.** Check exporter lag, sampling-policy version, observation counts, clock health, ring/event drops, and recorder generation. Mark incomplete intervals.
2. **Establish scope and chronology.** Use domain/owner sequences for local order, causal IDs for links, and translated timestamps only where uncertainty permits.
3. **Find the first leading change.** Offered load, input quality, queue age, progress, state transition, resource saturation, or deployment/config event.
4. **Follow one concrete tail event.** Compare its end-to-end interval with stage spans, order/session transitions, and relevant recorder entries.
5. **Separate symptom from mechanism.** Log drops can be a consequence; queue age can be a location; a profile can show work. Form a causal hypothesis connecting them.
6. **Test a reversible prediction.** Roll back/configure one factor or reproduce under controlled load. Require the predicted leading signal and end-to-end outcome to reverse.
7. **Retain the bundle and gap statement.** Document what evidence was missing and add a bounded signal/test if it blocked diagnosis.

Do not sort all records from several hosts by wall timestamp and call that the truth. Construct a partial order from protocol sequence, owner sequence, message causality, and acknowledged clock bounds. Events whose order remains ambiguous should remain ambiguous in the report.

## 59.10 Reference: schema and runbook

This section is skippable on a first pass.

### Metric contract example

```yaml
name: order_ack_latency_seconds
type: histogram
owner: gateway_session
population: terminal new-order acknowledgments
start: egress hardware timestamp when available
end: ingress hardware timestamp when available
clock_domain: nic_phc
labels:
  venue: configured_bounded_enum
  result: [accepted, rejected]
schema_version: 3
required_companions:
  - order_ack_latency_observations_total
  - order_ack_latency_overflow_total
  - telemetry_records_dropped_total
```

YAML is illustrative configuration, not a standard observability schema. Bucket/encoding and backend mapping belong in the versioned product-specific definition.

### Structured event contract

```text
header:
  magic, schema_version, record_length
  build_id, config_epoch
  owner_id, owner_sequence
  timestamp, clock_domain
  event_kind, flags

identity:
  trace_id/event_id
  domain identifiers (order/session/instrument where applicable)

payload:
  fixed versioned fields
  no borrowed pointer

integrity:
  framing/length validation
  optional checksum according to persistence threat model
```

### Incident bundle manifest

```text
trigger reason and objective
UTC and monotonic/PHC anchors with uncertainty
service/build/config/reference/deployment identity
metric histogram/count snapshots with schema IDs
telemetry loss/sampling/export health
structured events and trace fragments
flight-recorder dump with generation boundaries
host/kernel/NIC signals relevant to hypothesis
commands/actions taken and rollback result
```

### Review checklist

- Does every alert map to an owner and action?
- Can series count be computed from configuration?
- Are metric populations, units, resets, and exclusions documented?
- Are histograms merge-compatible and under/overflow visible?
- Are per-owner reads C++ data-race-free?
- Can collection cadence perturb hot cache lines?
- Are record payload lifetimes safe?
- Can optional sink failure block or allocate on a critical owner?
- Are drops, sampling, sequence gaps, and incomplete traces distinguishable?
- Can timestamps be compared, and is uncertainty reported?
- Does health reflect domain state and progress?
- Can recorder snapshot/dump race with writers?
- Does the incident bundle survive schema/build changes?

## 59.11 Common traps

- A metric with no stable population, unit, lifetime, or owner.
- Treating a gauge scrape as proof that no intermediate peak occurred.
- Averaging per-instance or per-window quantiles.
- Merging histograms with different boundaries, units, or populations.
- Omitting sample, underflow, overflow, or telemetry-drop counts.
- Using raw order IDs, symbols, error strings, or stack traces as labels.
- Enforcing cardinality only after backend ingestion.
- Looking up metric names or allocating label sets on the hot path.
- Concurrently reading plain per-owner counters in C++.
- Assuming relaxed counter reads publish unrelated owner state.
- Treating an asynchronously collected cross-counter expression as exact.
- Calling asynchronous/deferred logging free.
- Enqueueing borrowed strings/pointers whose lifetime ends before decode.
- A logging queue that blocks or grows without bound.
- Sending the log-drop counter through the same full log queue.
- Confusing planned sampling with unplanned loss.
- Tail sampling without accounting for buffered/partial traces.
- Reconstructing causality from timestamps alone.
- Comparing clock domains without offset/error/translation evidence.
- Health that checks only an HTTP thread, not domain validity/progress.
- A watchdog whose observation path uses the failed resource.
- Universal heartbeat/stall/alert thresholds copied across deployments.
- Alerting on a tail percentile with too few or missing observations.
- A flight-recorder horizon based on average, not incident event rate.
- Concurrently copying recorder slots without a C++-safe publication protocol.
- Unbounded or repeated recorder dumps turning diagnosis into an outage.
- Claiming a crash-handler dump is signal-safe without platform validation.
- Product/tool overhead figures presented as architecture constants.

## 59.12 Recall card

```text
GOAL
rates + errors + saturation + distributions + states + causal history
with bounded observer effect and explicit evidence loss

SIGNAL CONTRACT
question + owner + type/unit/population + bounded dimensions
+ cost + capacity + full policy + loss indicator + version

METRICS
counter = cumulative lifetime/epoch
gauge = sampled current value
histogram = merge only identical schema/population
quantiles do not merge by averaging

PER-OWNER
owner-local update; concurrent collector uses defined atomic/publication
relaxed counter != publication of other state
cross-shard scrape is not one atomic snapshot

CARDINALITY
bound before ingestion
metrics carry categories; events/traces carry entity detail

LOGGING
fixed structured record -> bounded queue -> off-path encode/persist
no borrowed lifetime; schema/build ID; drop/gap accounting
optional telemetry never silently blocks or allocates

SAMPLING
policy decisions != telemetry loss
export probability/policy/count; retain unsampled aggregates
no universal sample or rate-limit default

CORRELATION
protocol sequence + owner sequence + domain IDs + causal ID
+ timestamp/clock domain + uncertainty
timestamps do not create causality

HEALTH
liveness != readiness != domain validity != progress
watch independently; preserve evidence before disruptive action

FLIGHT RECORDER
fixed capacity, overwrite oldest, measured horizon
safe writer/snapshot ownership; bounded rate-limited dump

INCIDENT
bundle identity + counts/distributions + loss + causal detail
+ recorder + relevant host signals + actions/rollback
```

## 59.13 Questions

1. Design a signal contract for feed gaps, including owner, type, dimensions, reset, loss behavior, and alert.
2. Why can per-owner relaxed atomics be correct for counters but incorrect for publishing book or order state?
3. Explain why quantiles cannot be averaged and when histogram counts can be merged.
4. How would you bound per-order diagnostic detail without creating per-order metric series?
5. Compare head sampling, tail sampling, rate limiting, and unplanned queue loss. What must each export?
6. Which fields reconstruct causality when threads, hosts, protocol streams, and clocks differ?
7. Design health/progress signals that distinguish a quiet service, a stalled owner, and an invalid feed.
8. Give three C++-safe strategies for snapshotting a flight recorder and the failure behavior of its dump path.
9. During an ack-latency incident, how do queue age, stage spans, load, telemetry loss, and recorder data narrow the cause?
10. Which observability costs and settings are architecture contracts, product/version facts, deployment choices, or measurements?

## 59.14 Puzzle and exercise

### Puzzle: the improving p99

During overload, a dashboard’s p99 latency improves while customers report worse delays. The histogram observation count falls by 80%, the optional event ring drop counter rises, and the exporter is behind.

The dashboard is showing a biased surviving population. Either latency observations share the dropping path, sampling changed with load, or completed fast events are overrepresented while slow/missing events have no end timestamp. The p99 is not evidence of improvement. Alert on telemetry loss and missing outcomes, preserve a counter/histogram path independent enough to survive the event path, and reconstruct from intended starts or external timestamps as Chapter 43 describes.

### Exercise: design and break a telemetry path

For one feed owner, strategy shard, and gateway:

1. define five counters, two gauges/high-water pairs, and three histograms;
2. calculate maximum label cardinality from configuration;
3. define one fixed structured record and its schema evolution;
4. give every buffer a record/byte capacity and full policy;
5. implement per-owner aggregation without C++ data races;
6. define head/tail/detail sampling and separate drop counters;
7. propagate causal IDs and owner sequences across one order/ack;
8. design a fixed-capacity recorder and safe snapshot ownership;
9. trigger slow exporter, full ring, clock degradation, and owner stall;
10. produce an incident bundle and identify which claims are incomplete because telemetry was lost.

Measure the instrumentation in disabled, healthy, full, exporter-failed, and dump modes. Reject a design that becomes unbounded, silently incomplete, or capable of blocking the critical owner outside an explicit mandatory-audit safety policy.

## Prerequisite for Chapter 60

You are ready for deployment and operations when every signal has a semantic owner and version; production telemetry is bounded and drop-aware; readiness/domain health/progress are distinguishable; incidents produce a decodable evidence bundle tied to the deployed artifact/configuration; and sink, disk, collector, clock, or recorder failure has an explicit safe behavior. Chapter 60 operationalizes those contracts.
