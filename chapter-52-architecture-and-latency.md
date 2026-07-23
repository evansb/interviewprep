# Chapter 52 — Architecture and Latency

A low-latency trading system is a collection of state machines joined by transports and queues. Its architecture is good when each state has one clear owner, every correctness dependency is on an explicit path, every queue has a capacity and overflow policy, and latency is measured across named boundaries under realistic load.

The shortest design is not automatically correct, and the most parallel design is not automatically fast. Removing a check can make a benchmark quicker while making the system unsafe. Splitting work across cores can raise throughput while adding handoffs to every reaction. Adding a buffer can suppress drops while turning fresh decisions into stale ones.

This chapter is a capstone. It references mechanisms developed earlier and assigns detail to later chapters:

- Chapter 48 owns network latency and measurement mechanics.
- Chapter 53 owns feed sequencing, recovery, and market-state correctness.
- Chapter 54 owns order sessions, correlation, retries, and reconciliation.
- Chapter 55 owns hot-path implementation and profiling.
- Chapters 56–60 own risk, testing, observability, operations, and deployment.

Label architecture claims correctly:

| Label | Example |
|---|---|
| Architecture invariant | one component owns each mutable state transition |
| Design choice | shard instruments rather than pipeline stages |
| Deployment fact | two shards share a socket or NIC queue |
| Protocol/venue fact | a feed is multicast and an order session is ordered |
| Measurement | p99 tick-to-order for a named event class and load |
| Objective | maximum allowed decision age or loss-recovery time |

A handoff does not “cost 200 ns” as an architectural truth. Its observed cost depends on topology, cache state, producer/consumer scheduling, queue state, payload, contention, and how the timestamps were taken.

## The 90-second screen — Core

Five facts:

1. Requirements name correctness outcomes, event classes, latency boundaries and percentiles, burst load, freshness, and failure behavior. “Low latency” alone is not a requirement.
2. The critical path contains only dependencies required before the externally visible action. Copies, queues, syscalls, coordination, wakeups, devices, and the return path still need explicit accounting.
3. Every mutable truth has one authoritative owner. Published copies carry versions and freshness; a single writer removes write races, not all synchronization.
4. Every queue has a payload meaning, unit, byte/item capacity, maximum useful age, full policy, and recovery contract. Backpressure must terminate explicitly because different streams cannot all be dropped, conflated, or slowed.
5. Measure latency, throughput, freshness, drops, and correctness together under realistic bursts and degraded modes. Per-stage percentiles are not additive.

Two decisions:

- Choose co-location, complete-path sharding, or staged pipelining from state ownership, dependency length, measured capacity, isolation needs, and handoff cost.
- Choose admission, rejection, conflation, invalidation/recovery, reserved capacity, and shedding by event semantics—especially for new orders, cancels, acknowledgments, fills, and ordered market deltas.

The end-to-end shape is:

```text
MARKET-DATA PATH
venue -> network/NIC -> receive -> decode/quality gate -> market state
                                                     -> strategy state

ORDER PATH
strategy decision -> pre-trade risk -> order intent -> gateway/session
                                                   -> encode/network -> venue

RETURN PATH
venue -> acknowledgment/execution -> gateway order state
                                  -> position/risk/strategy notification

SIDE PATHS
capture, replay, metrics, logs, control, reference data, monitoring
```

Side paths are not unimportant. They are removed from the reaction path only when a bounded, observable mechanism preserves the evidence and control the system requires.

Sections 52.1–52.12 are the Core design path. Section 52.13 is a skippable review reference; §§52.14–52.17 provide traps, recall, and retrieval practice.

## 52.1 Requirements before components

“Low latency” is not a complete requirement. Specify at least:

- **correctness:** which invalid or uncertain states prevent action;
- **latency:** boundaries, percentiles, event classes, and load profile;
- **throughput/capacity:** sustained and burst offered load by message type;
- **freshness:** maximum age of market state or an order decision;
- **availability:** permitted degradation, recovery time, and failover scope;
- **durability/audit:** which inputs, decisions, and outcomes must be reconstructible;
- **risk:** checks that must complete before submission and controls that remain available during failure;
- **operability:** configuration, deployment, rollback, diagnosis, and reconciliation.

Correctness and latency are not independent. A system that reacts to a gap-corrupted book has low numeric latency and no useful service. A risk check that reads an asynchronously stale limit may be fast but invalid. Conversely, synchronously formatting a human log line before every order adds no correctness if an equivalent fixed record can be emitted safely off-path.

**Throughput** is completed work per time under a definition. Packet rate, decoded-message rate, book-event rate, strategy-evaluation rate, order rate, and execution-report rate are different capacities. **Goodput** counts correct, useful outcomes. A decoder processing duplicates at high rate can show throughput while making no progress.

Requirements should be conditional:

```text
For eligible top-of-book changes on healthy feed state,
at offered load profile B and shard utilization below the admission limit,
99.9% of reactions must cross boundary X-to-Y within target T,
with zero omitted risk checks and zero silent event loss.
```

This is testable. “Sub-microsecond engine” is not.

## 52.2 Measurement boundaries and latency vocabulary

### Name the interval

Common intervals include:

| Metric | Start | End | Includes |
|---|---|---|---|
| wire-to-wire tick-to-order | market-data ingress on wire | order egress on wire | devices, discovery, software, and TX path between taps |
| NIC-to-NIC reaction | RX hardware timestamp | TX hardware timestamp | depends on timestamp semantics and clock |
| userspace reaction | application observes input | application submits/commits output | omits some RX/TX work |
| decision latency | normalized valid state change | strategy decision | state/decision only |
| order-to-ack | order egress boundary | acknowledgment ingress boundary | venue plus both network directions |
| internal gateway | accepted intent | encoded/submitted order | local gateway work |

“Tick-to-trade” is ambiguous: some use it for market data to order transmission, others for market data to an execution. Prefer `tick-to-order` for the former and define both boundaries.

**Wire-to-wire** must specify capture position and bit convention. First-bit-to-first-bit, last-bit-to-first-bit, and packet timestamps differ by serialization time. Hardware timestamps can still occur at different points inside a NIC or PHY. Internal cycle-counter measurements are valuable for attribution but do not become external latency simply because they are precise.

**One-way latency** requires clocks in a common, bounded-error domain. Round-trip measurement can use one clock but folds two directions and remote processing together. Chapter 48 covers clock synchronization, timestamping, serialization, packet loss, jitter, and coordinated omission.

### Report a distribution with context

At minimum record:

- event class and eligibility rule;
- sample count and exclusion count by reason;
- offered-load trace and background work;
- p50, p90, p99, p99.9 or appropriate tail, maximum with caveats;
- histogram resolution and range;
- deployment/build/configuration identity;
- clock/timestamp source and uncertainty;
- data-quality and overload state.

Do not average unlike events. A no-action update, a one-level book change, a recovery transition, and a risk-rejected order have different paths. A fast common case can conceal an unacceptable rare correctness path.

Stage percentiles do not generally add to an end-to-end percentile. The event at each stage’s p99 need not be the same event. Preserve a trace/event ID or another lossless correlation so the full latency and its stage contributions are calculated per event before summarizing.

### Work, waiting, and uncertainty

An observed interval can be decomposed conceptually:

\[
L = L_{\text{propagation/serialization}}
  + L_{\text{device}}
  + L_{\text{discovery/scheduling}}
  + L_{\text{queue}}
  + L_{\text{service}}
  + L_{\text{coordination}}
\]

The terms can overlap unless measurement points are chosen carefully. A queue wait may include a descheduled consumer; a syscall duration may include device backpressure; a cache miss may be attributed to service even though another core caused it. The purpose is to form hypotheses, not to force every cycle into an artificial independent bucket.

Timestamp uncertainty matters when it is comparable to the interval or when clocks disagree. Report bounds or calibration error rather than false precision. Instrumentation also needs a policy for events without an end timestamp: rejected, dropped, timed-out, or still-outstanding samples belong in outcome counts and often in separate distributions. Deleting them biases the result toward successful fast events.

## 52.3 Decomposition and state ownership

A useful logical decomposition is:

| Component | Owns | Consumes | Produces | Must not silently do |
|---|---|---|---|---|
| receive/feed boundary | channel/session input and quality state | packets/messages | ordered valid market events or invalidation | hide gaps or parse failure |
| market-state owner | book/quote state and definition version | valid market events | immutable view/change notification | accept events for wrong quality state |
| strategy shard | strategy-local state and decision sequence | state changes, controls | order intents or no-action reasons | mutate gateway truth |
| risk owner/check | limits and reservations | intent, positions, configuration | accept/reject/reservation | default allow on unavailable state |
| order gateway | venue session and client/venue ID mapping | authorized intents, venue responses | encoded orders, canonical order events | guess ambiguous remote state |
| position owner | canonical fills/adjustments | execution events | positions and exposures | conflate duplicate identity with duplicate economics |
| evidence/control | captures, decisions, metrics, commands | bounded records | replay/audit/alarms | block critical state unpredictably |

These are logical owners, not necessarily processes or threads. One core can own feed state, a book, a strategy, and its risk reservation for an instrument shard. A gateway session may need a separate owner because its outbound sequence is shared across instruments. Process boundaries can add isolation but also serialization, copying, scheduling, failure coordination, and deployment complexity.

Do not derive physical topology mechanically from the component diagram:

| Boundary | What it provides | Costs/questions it introduces |
|---|---|---|
| function/module | code ownership and test seam | can still share mutable state implicitly |
| event-loop owner | serialized mutations | scheduling policy among input classes |
| thread | independent execution | queueing, cache coherence, wakeups, affinity |
| process | address-space and crash isolation | IPC, serialization/lifetime, restart coordination |
| host | hardware/failure isolation | network hop, clock agreement, deployment skew |
| site/region | disaster/fault-domain separation | propagation, consistency, authority and failover |

Use the weakest physical boundary that supplies the required isolation, capacity, security, or operational ownership. Conversely, do not collapse a trust or failure boundary merely to remove a copy. A risk service in another process may be justified even when an in-process call benchmarks faster; then the architecture must decide what happens when that process is slow or unreachable.

### Ownership rules

For each state, write:

```text
authoritative owner
allowed writers
readers and publication mechanism
event ordering domain
persistence/recovery source
behavior while state is stale or unavailable
```

Single-writer ownership removes concurrent write races and makes event ordering explainable. It does not eliminate synchronization: readers still need a snapshot/publication protocol, and events crossing owners need a queue or message transport. “Lock-free” is not “coordination-free.”

Duplicating mutable truth is especially dangerous. If strategy, risk, and gateway each maintain an independently updated “live order quantity,” transient disagreement becomes inevitable. Instead assign canonical order state to the gateway/order owner and publish versioned facts; strategy may maintain a derived view with explicit staleness semantics.

### Conventional component names

Architecture diagrams commonly show a **feed handler**, **normalizer**, **book builder**, **strategy**, **risk engine**, and **order gateway**. Treat those as responsibilities, not mandatory thread boundaries:

- A feed handler receives and validates native market data and maintains input-quality state.
- A normalizer maps native identity, scale, and event type into a stable internal contract.
- A book builder applies valid ordered events to an authoritative market view.
- A strategy consumes versioned state and owns decision-specific state.
- A risk component decides or reserves whether intent is allowed under current limits.
- An order gateway admits intent into a venue session and owns protocol/order correlation.

For one protocol, decoding and normalization may naturally be one pass. For one instrument shard, book apply and strategy evaluation may naturally share an owner. On another workload, a shared feed must decode once before distributing. The architecture should preserve responsibility and evidence even when functions are fused.

Avoid an over-normalized universal event that loses venue semantics or carries a heap-allocated variant through every path. Also avoid making each strategy understand every native protocol. The boundary belongs where it removes repeated work while retaining native identity, quality, version, and fields required for correctness. Chapters 51 and 53 supply protocol and feed-reconstruction detail.

## 52.4 The critical path

The **critical path** is the longest dependency chain required before an outcome. For a reaction order:

```text
receive discovery
 -> frame/message validation
 -> feed-quality decision
 -> state apply
 -> strategy evaluation
 -> pre-trade risk decision/reservation
 -> order construction and session admission
 -> transmit submission/device
```

Work is on the path if the output cannot be correct without its result. It is not on the path merely because current code happens to execute it first.

Typical candidates to move after order submission or to a bounded side path are human-readable formatting, aggregate metrics export, dashboards, general analytics, and archival compression. But the fixed audit fact saying why an order was sent, the risk decision, and state necessary for the next event may be dependencies. “Move logging off-path” must define what evidence is still committed before a crash.

### Named cost inventory

At every arrow, inventory:

| Cost | Questions |
|---|---|
| copy | bytes, source/destination, cache lines, ownership, avoidability |
| queue | capacity, depth distribution, producer/consumer CPUs, age |
| syscall | call, blocking possibility, batching, kernel/device work excluded |
| serialization | encode/decode format, validation, conversion, allocation |
| coordination | lock, atomic, fence, cache-line transfer, RCU/seqlock retry |
| scheduling | polling, wakeup, preemption, run-queue delay |
| memory | allocation, page fault, TLB/cache miss, NUMA placement |
| device/network | DMA, rings, moderation, switching, propagation, wire time |
| branch/work variance | message type, book shape, risk path, error handling |

Zero-copy can replace a payload copy with ownership tracking, references, and lifetime pressure. A queue containing an index may reduce payload transfer but requires the referenced storage to remain valid until consumption. Evaluate the whole ownership protocol.

### Optimize dependencies, not boxes

Useful transformations include:

- precompute reference-data conversions outside the session;
- pre-encode order fields invariant for a session/instrument;
- combine state update and strategy trigger under one owner;
- publish one compact change rather than copying a whole book;
- defer work not needed for the next correct decision;
- remove redundant conversions between normalized forms;
- shard independent ownership domains to avoid handoffs.

Never precompute a value whose correctness depends on mutable state without versioning or invalidation.

### The return path is also critical

Latency discussions often stop when bytes leave for the venue. Safe architecture cannot. An acknowledgment, rejection, cancel response, or execution changes which future actions are valid:

```text
venue response
 -> receive/session validation
 -> correlate to canonical order
 -> apply one legal state transition
 -> update reservations/position if required
 -> publish strategy/risk facts
 -> enable or suppress the next action
```

The order-to-ack path may not be on the original tick-to-order interval, but it is on the dependency path for reuse of capacity, cancel decisions, and order-state correctness. A gateway that transmits quickly but cannot drain responses safely is not low latency under load.

Identify **fan-out** and **fan-in** explicitly. Market state might publish to several strategies; one slow optional reader must not hold the authoritative writer. A strategy may require two correlated instruments owned by different shards; that fan-in creates a freshness/atomicity question that cannot be solved by summing two fast paths. Choices include co-locating the instruments, consuming versioned snapshots with a maximum skew, or assigning the combined strategy its own owner. State the semantic compromise.

## 52.5 Single-writer event loops, sharding, and pipelines

### Single-writer event loop

A single-writer shard serializes related events and mutates its state without contended writers:

```text
poll bounded inputs
 -> select next event under an explicit ordering policy
 -> validate quality/version
 -> update owned state
 -> evaluate dependent logic
 -> perform required risk/admission
 -> emit bounded outputs
 -> record compact evidence/counters
```

One loop is not automatically deterministic. It needs a defined rule when market data, gateway responses, timers, and control commands are simultaneously ready. Unbounded draining of one source can starve fills or cancels; strict round-robin can delay a critical class. Set bounded drain budgets and priority rules, then test adversarial arrival patterns.

A single writer can still be slow because of cache misses, allocations, blocking calls, page faults, interrupts, or variable algorithms. Chapter 55 covers implementation.

### Sharding

**Sharding** partitions ownership—often by instrument group, strategy, account, or venue session—so independent work proceeds on separate cores:

```text
market events -> routing by stable shard key
              -> shard 0: state + strategy + local risk reservations
              -> shard 1: state + strategy + local risk reservations
              -> ...
              -> gateway owners as required by session topology
```

Good shard keys minimize cross-shard dependencies and keep correlated instruments together when a strategy needs atomic/coherent views. Poor sharding requires frequent cross-shard snapshots, global atomics, or distributed decisions and loses its benefit.

Global limits do not necessarily require a global atomic on every event. Possible designs include preallocated per-shard risk budgets with a slower rebalance path, hierarchical reservations, or routing a genuinely global decision to one owner. Each changes availability and conservatism; Chapter 56 owns the risk semantics.

### Staged pipeline

A staged pipeline assigns decode, book, strategy, risk, and gateway work to separate workers. It can increase throughput when stages are independently expensive and overlappable, and can isolate variable work. It adds:

- one bounded queue per boundary;
- producer/consumer coordination and cache transfer;
- queue residence and discovery delay;
- more copies or shared-lifetime complexity;
- distributed failure and version coordination;
- harder end-to-end attribution.

Use a pipeline when measured capacity or isolation requires it, not because the diagram looks modular. Prefer sharding complete paths when the state partitions naturally. Hybrid systems are common: a feed/session owner performs unavoidable shared work, then dispatches compact events to complete instrument shards, while a separate order-session owner serializes outbound protocol state.

## 52.6 Queue semantics, backpressure, and failure boundaries

A queue is a latency reservoir and a failure boundary. Document:

```text
producer -> consumer
payload/event semantics
capacity and memory bound
normal and high-water depth/age
ordering and duplicate rules
full behavior
restart/recovery behavior
monitoring and ownership
```

The oldest item’s age is often more actionable than depth. At a constant consumer service rate \(\mu\), \(n\) queued items imply roughly \(n/\mu\) waiting time, but varying service cost, batches, and priorities make that only an approximation.

### State, deltas, and events

“Market data is state; orders are events” is a useful warning but too coarse:

- a **complete published snapshot** can be conflated if readers only require the newest version and can detect skips;
- an **incremental market-data delta** cannot be dropped or overwritten safely before the authoritative state owner applies it;
- a **trade event** can carry independent information even if the current book later looks correct;
- an **order intent**, cancel, acknowledgment, or fill is an event with identity and cannot be silently conflated;
- telemetry may be sampled/dropped if the loss is counted and required evidence remains elsewhere.

Conflate derived state, not the input events required to derive it.

### Full policies

| Stream/boundary | Plausible full response | Never acceptable |
|---|---|---|
| external loss-prone market-data input | detect loss/gap, invalidate affected state, recover | silently continue as healthy |
| internal ordered market delta | invalidate/resync or fail affected shard | overwrite an arbitrary delta |
| latest derived book/analytics view | overwrite/conflate with version-gap signal | imply every version was observed |
| new order intent | reject/fail fast before ambiguous submission | silently discard after telling caller accepted |
| cancel/kill intent | reserve capacity/prioritize; escalate failure | treat as expendable telemetry |
| acknowledgment/fill | preserve, reconcile from authoritative source after failure | drop without making state uncertain |
| metrics/debug telemetry | sample/drop with counters | block critical owner unpredictably |

Backpressure cannot always propagate to the true producer. A UDP multicast venue does not slow because an application queue is full. The system must keep up, filter earlier, invalidate/recover, or shed a higher-level derived view. An outbound order producer can receive synchronous admission failure before the gateway claims ownership.

A queue contract can make the distinction executable:

```cpp
#include <cstdint>

enum class PayloadKind : std::uint8_t {
    OrderedDelta,
    DerivedSnapshot,
    NewOrderIntent,
    CancelIntent,
    VenueResponse,
    OptionalTelemetry
};

enum class FullAction : std::uint8_t {
    InvalidateAndRecover,
    ReplaceLatestAndSignalSkip,
    RejectBeforeAccept,
    UseReservedCapacityOrEscalate,
    PreserveOrMarkUncertain,
    DropAndCount
};

constexpr FullAction on_full(PayloadKind kind) {
    switch (kind) {
    case PayloadKind::OrderedDelta:
        return FullAction::InvalidateAndRecover;
    case PayloadKind::DerivedSnapshot:
        return FullAction::ReplaceLatestAndSignalSkip;
    case PayloadKind::NewOrderIntent:
        return FullAction::RejectBeforeAccept;
    case PayloadKind::CancelIntent:
        return FullAction::UseReservedCapacityOrEscalate;
    case PayloadKind::VenueResponse:
        return FullAction::PreserveOrMarkUncertain;
    case PayloadKind::OptionalTelemetry:
        return FullAction::DropAndCount;
    }
    return FullAction::PreserveOrMarkUncertain;
}
```

This is policy vocabulary, not a complete queue. In production, “preserve” needs finite reserved capacity plus an authoritative recovery/reconciliation design; it cannot promise infinite memory. “Replace latest” requires a version so the reader knows intermediate state was skipped.

### Failure containment

Place boundaries so a failure has the smallest honest scope:

- feed gap invalidates affected channel/instruments, not an unrelated gateway;
- a strategy shard overrun disables new actions from that shard;
- risk unavailability rejects new risk-increasing intent;
- gateway disconnect makes relevant order state uncertain until Chapter 54 reconciliation;
- evidence-path overload degrades optional detail but alarms and preserves mandatory audit facts;
- reference-version mismatch rejects events/orders using the wrong definition.

Fail closed does not mean terminate everything for every error. It means do not perform an action whose safety precondition is unknown.

## 52.7 Batching and the throughput–latency curve

Batching amortizes fixed costs: one receive call, queue-index observation, cache-line transfer, encoder setup, doorbell, or metrics publication can cover several items. It has two distinct forms:

- **opportunistic batch:** process several items already available;
- **wait-to-fill batch:** delay the first item hoping more arrive.

The first can improve both throughput and backlog latency under load. The second adds deliberate waiting and may improve throughput at the expense of low-load latency. Driver, kernel, and NIC batching can add similar effects outside the application.

Bound drain size so one busy source cannot starve another. Measure batch-size distribution, age of first and last item, per-item cost, queue high-water marks, and latency by load phase.

### Capacity and queueing

Let arrival rate be \(\lambda\), service rate \(\mu\), and utilization \(\rho=\lambda/\mu\). For the stationary M/M/1 model—Poisson arrivals, independent exponential service, one server, infinite buffer, \(\lambda<\mu\)—mean time in system is:

\[
W=\frac{1}{\mu-\lambda}
\]

With mean service time \(S=1/\mu\):

\[
\frac{W}{S}=\frac{1}{1-\rho}
\]

This is a model result, not a universal latency law. Trading traffic is bursty and correlated; service times depend on message type and cache state; buffers are finite; stages have priorities and batches; recovery work can arrive exactly when load rises. Use the equation to explain why headroom matters, then measure the actual throughput–latency curve.

A load test should increase realistic offered load until latency, queue age, drops, or correctness begins to degrade. The **knee** is workload/build/deployment-specific. Operate with headroom justified by burst and failure scenarios, not a folklore utilization percentage.

Capacity is a vector, not one messages-per-second number. A system may have enough decoder capacity but exhaust one instrument shard, gateway-session rate, risk reservation pool, TX queue, or response consumer. Report the limiting resource for each workload phase. Also test reduced-capacity states: one failed feed path, a recovering channel, a disabled shard, a slow venue session, or observability under incident load. Redundancy that is safe only while every component is healthy is not usable headroom. Admission limits should reflect the capacity actually available now, and a topology change should not silently preserve the old limit.

Measure **useful-age capacity** as well as throughput: the maximum offered burst the system can process before an item exceeds its decision-age objective. A queue can avoid drops and still fail this requirement.

## 52.8 Hot, warm, and cold paths

Path classes are dependency classifications:

- **hot:** required for the immediate correct external action;
- **warm:** prompt control/state work not required before that action;
- **cold:** configuration, reporting, historical processing, formatting, deployment.

Examples can move between classes. A position update needed by the next risk check is hot even if it sounds like accounting. An aggregate P&L dashboard is usually warm/cold. A kill command is infrequent but latency-critical and must not be queued behind bulk telemetry.

Separate paths with bounded publication and explicit freshness, not hope. Cold readers must not make a hot writer wait indefinitely. Hot code still needs observability: fixed-size records, per-owner counters, hardware/software timestamps, or flight-recorder slots can preserve evidence with predictable work. Chapter 59 owns detailed observability.

**Colocation** reduces physical network distance and can reduce variability, but it is a deployment option, not a software architecture. Cross-connect topology, switches, NICs, kernel/bypass path, NUMA placement, CPU isolation, clock distribution, and venue access rules all affect measurements. Do not quote propagation or switch delays without the actual path and source.

## 52.9 Building a latency budget

A latency budget is an allocation of an end-to-end objective to named work and unassigned contingency. It is not a list of “typical industry numbers.”

Start with an externally meaningful interval, then build a per-event trace:

```text
T0 ingress boundary
T1 userspace discovers input
T2 decode/quality complete
T3 authoritative state applied
T4 decision produced
T5 risk/admission complete
T6 order encoded/submitted
T7 egress boundary
```

For event \(e\):

\[
L_e=T_{7,e}-T_{0,e}=\sum_{i=0}^{6}(T_{i+1,e}-T_{i,e})
\]

The equality holds for the same event and clock domain. It does not justify adding independently computed stage p99s.

### Synthetic budget example

Suppose a fictional system sets a 7.0 µs p99.9 objective for one eligible event class at a defined burst profile:

| Budget item | Target | Owner | Evidence |
|---|---:|---|---|
| ingress/device/discovery | 1.4 µs | platform/feed | hardware + application timestamps |
| decode and quality gate | 0.7 µs | feed owner | correlated stage markers |
| state application | 0.8 µs | shard | event trace |
| strategy decision | 1.2 µs | strategy | decision trace |
| risk/admission | 0.6 µs | risk/gateway | reservation result |
| encode/submission/egress | 1.3 µs | gateway/platform | software + hardware timestamps |
| unassigned contingency | 1.0 µs | system | end-to-end minus attributed work |
| **total objective** | **7.0 µs** |  |  |

These numbers are invented for arithmetic, not recommendations. The budget states responsibility and where to measure. If end-to-end tail rises while all instrumented spans appear flat, suspect missing intervals, timestamp disagreement, queue discovery, device time, or correlation loss. If a stage meets its isolated benchmark but violates the integrated trace, shared resources or upstream burst shape matter.

Budgets should include normal, burst, recovery, and degraded-mode objectives. A recovery path may permit slower reaction but must have a maximum invalid-state duration and zero unsafe actions.

### Budget governance

A budget is maintained with the architecture:

1. Keep an unassigned contingency rather than allocating 100% to optimistic stage targets.
2. Attach an owner and measurement query to every line.
3. Treat queue residence separately from active service; optimizing service can leave waiting untouched.
4. Track sample coverage. Missing tail events are not successes.
5. Compare the same event IDs across external and internal measurements.
6. Rebaseline only after explaining the change; do not move the target to match a regression.
7. Version results by binary, configuration, reference data, kernel/firmware, hardware, and deployment.

Instrumentation has cost and can perturb the path. Measure that cost with controlled builds, but do not respond by removing all attribution. Sampling can work if selection is independent of observed latency and critical failure events remain recorded. A start timestamp stored only for “interesting” completions creates selection bias.

## 52.10 Worked end-to-end design

Consider a fictional two-venue strategy observing 4,000 instruments. It must react to eligible book changes, enforce account/product limits, send through two ordered venue sessions, process fills without loss, and stop actions from stale market state. Market-data bursts are skewed: a small group dominates during events.

### Step 1: choose truth and owners

```text
feed owner per input channel
  owns decode order and quality state

instrument shard
  owns normalized book + strategy state
  owns preallocated product risk reservation

gateway owner per outbound venue session
  owns session sequence, client IDs, live order truth

position/risk owner
  consumes canonical executions
  publishes bounded budgets/reservations to shards
```

The feed owner validates and produces ordered events; Chapter 53 defines recovery. It routes a compact native-ID/definition-version event to a stable instrument shard. Each shard applies the event and decision on one writer. Authorized intent crosses to the correct gateway owner because outbound session sequence cannot be written independently by arbitrary shards.

This creates two unavoidable handoffs: feed-to-shard and shard-to-gateway. Combining all work on one core would avoid them but cannot own both shared venue feeds/sessions and scale across the workload. Further splitting normalization, book, strategy, and risk would add boundaries without yet solving an observed capacity problem.

### Step 2: define queue and failure semantics

| Boundary | Capacity basis | Full/stale behavior |
|---|---|---|
| feed -> shard delta | measured burst plus recovery margin, with age limit | invalidate affected shard input and recover; never overwrite |
| shard -> gateway intent | bounded admissions and venue throttle headroom | reject new intent before ownership transfer |
| gateway -> shard order event | reserved for responses, separate from telemetry | mark state uncertain and reconcile if delivery cannot be preserved |
| position -> shard risk budget | versioned latest state | reject risk-increasing actions when expired |
| any owner -> telemetry | bounded sampled records | drop optional records, count loss, preserve mandatory audit path |

Queue capacity is derived from a burst trace and useful-age objective, then tested. It is not sized merely to avoid full conditions in one average test.

### Step 3: define the reaction and return paths

```text
tick-to-order:
RX -> feed quality -> shard queue -> book -> strategy -> local reservation
   -> gateway queue -> session admission/encode -> TX

order-to-state:
RX response -> gateway correlation/canonical transition
            -> position/risk event + strategy notification
```

The architecture timestamps both paths. It does not declare success when the order leaves: acknowledgment and execution capacity are part of safe operation. Cancels and kill commands have reserved/prioritized admission so a flood of new intent cannot exclude them.

### Step 4: test the failure matrix

Test a feed gap, one hot shard, full intent queue, gateway throttle, disconnect after send before acknowledgment, duplicate execution, slow position consumer, expired risk budget, telemetry stall, and reference-version change. Each must produce a named state, alarm, and smallest safe disable scope.

### Step 5: measure before changing topology

Collect per-event spans, queue age/high-water, owner utilization, event mix, and external timestamps. If one shard saturates, first revise the shard key or move correlated groups. If feed decoding is the shared bottleneck, add feed partitions only where protocol ordering permits. If gateway serialization is the bottleneck, venue/session topology may be the hard limit; adding workers behind one sequence owner may only add queues.

### Step 6: maintain a latency and correctness ledger

For each path revision, record:

| Change | Expected mechanism | Latency evidence | Correctness/capacity evidence | Rollback |
|---|---|---|---|---|
| move hot instruments to another shard | reduce service utilization and queue age | per-event spans and external tail | identical replay decisions; no cross-shard skew violation | restore shard map |
| compact feed-to-shard event | reduce copied cache lines | handoff span and cache profile | decoded fields/checksums identical | restore old envelope |
| opportunistic gateway drain batch | amortize submission work already queued | first/last-item latency by batch size | ordering and throttle conformance | batch size one |
| add derived-state conflation | bound optional-reader lag | reader age and skip count | version skips explicit; no event consumer uses it | restore event stream |

The rollback is part of the design because an optimization can shift cost to a percentile or failure mode the initial benchmark missed. Replay checks establish deterministic functional equivalence for covered inputs; live canary and external timestamps establish deployment behavior.

## 52.11 The obvious optimization that loses

Suppose profiling shows normalization consumes 20% of an instrument shard’s CPU. The obvious proposal is:

```text
before:
feed -> [queue] -> shard: normalize + book + strategy + risk -> [queue] -> gateway

after:
feed -> [queue] -> normalizer pool -> [queue] -> shard
     -> book + strategy + risk -> [queue] -> gateway
```

An isolated normalization benchmark becomes faster because several cores work in parallel. End-to-end p99.9 becomes worse and gap recovery becomes harder.

Why?

1. Every event gains another enqueue, dequeue, cache transfer, and discovery delay.
2. Pool workers can complete events out of order, so a reorder buffer or per-key serialization is required.
3. Reference-data version changes must coordinate with more in-flight work.
4. A burst creates queue residence before the state owner; the “optimized” result is stale on arrival.
5. Average CPU capacity improved, but the critical dependency chain grew.
6. Failure ownership is unclear: does a worker error invalidate the feed, one instrument, or one transformed message?

Better candidates are to normalize once during the feed-to-shard transfer, precompute reference conversions, reduce the event representation, repartition hot instruments, or add a normalizer per stable shard only after measurement shows the shard remains capacity-bound. If a pool is still necessary, partition it by the same ordering key and make version/failure semantics explicit.

Another common wrong optimization is waiting to fill a transmit batch to reduce calls. It improves calls per order but adds a timer to the first order. Opportunistically batch orders already pending; do not assume deliberate delay meets the latency objective.

## 52.12 Overload and graceful degradation

Overload exists when offered work exceeds timely service capacity, even before a queue fills. Detect it with:

- queue age and high-water marks;
- per-owner service time and event rate;
- rejected/admission-limited work;
- stale-state and expired-budget counts;
- feed gap/recovery activity;
- external and internal latency histograms;
- CPU scheduling/device counters relevant to the deployment.

The policy should protect safety and freshness:

1. shed or sample optional analytics/telemetry;
2. stop work for unsubscribed/non-actionable instruments where protocol architecture permits;
3. conflate only published derived state with version-gap indication;
4. reject new order intent before accepting ownership;
5. prioritize cancels, kill/control, acknowledgments, and executions;
6. invalidate and recover ordered state after unavoidable event loss;
7. disable the smallest scope whose safety prerequisites are unknown.

Priority lists are design inputs, not universal business policy. For example, an execution stream cannot be dropped, but a system also cannot promise infinite buffering. It must reserve capacity, monitor leading indicators, and possess an authoritative reconciliation path for a failure that exceeds design bounds.

Every shed/reject/invalidation has a reason counter and an event for operators. Silent degradation makes incident reconstruction impossible.

## 52.13 Reference: architecture review checklist

This section is skippable on a first reading.

### System and boundaries

- What user/venue outcome defines success?
- Which paths are tick-to-order, order-to-ack, fill-to-position, and control-to-effect?
- What timestamp defines each endpoint and what is its uncertainty?
- Are events classified so distributions compare like with like?
- Are requirements given for normal, burst, recovery, and degraded modes?

### State and ordering

- Is every mutable state assigned one authoritative owner?
- What is each event’s ordering domain?
- Are derived copies versioned with explicit freshness?
- Can reference/config versions change with in-flight work?
- What truth reconstructs state after restart or ambiguity?

### Dataflow costs

- Mark every copy, queue, serialization, syscall, wakeup, atomic/fence, lock, and device boundary.
- For shared storage, who owns lifetime and reclamation?
- Does a new stage shorten the critical path, increase capacity, or merely move CPU?
- Is payload conversion performed once?
- Are optional readers capable of delaying an authoritative writer?

### Queues and overload

- What is the unit, capacity, byte bound, and maximum useful age?
- What happens at warning, high, full, and expired-age thresholds?
- Is the payload state, ordered delta, or independent event?
- Can the true producer receive backpressure?
- Which actions are rejected, invalidated, conflated, sampled, or reconciled?
- Are cancel/control and response capacities protected from new work?

### Latency and capacity evidence

- Is there external end-to-end measurement plus correlated internal attribution?
- Are percentiles computed per event rather than added across unrelated samples?
- Does load reproduce burstiness, event mix, skew, and recovery?
- Is the throughput–latency knee measured for this build/deployment?
- Are missing samples, dropped traces, and coordinated omission accounted?

### Failure and operations

- What is the smallest safe disable scope for each failure?
- Are ambiguous order states reconciled rather than guessed?
- Can a feed/version failure cause an order on stale data?
- Are rollback and deployment compatibility defined?
- Can flight-recorder/audit evidence survive the failure without blocking it?

## 52.14 Common traps

- Quoting latency without boundaries, load, event class, percentile, or clock.
- Treating an internal cycle span as wire-to-wire latency.
- Adding stage p99s and calling the result end-to-end p99.
- Optimizing throughput of a box while lengthening the dependency chain.
- Creating one thread per diagram box without measuring handoffs.
- Calling a queue “lock-free” as if it has no coherence or scheduling cost.
- Moving payload by pointer without defining lifetime and reclamation.
- Giving mutable state several authoritative writers.
- Publishing an unversioned book or risk view to another owner.
- Dropping/conflating incremental deltas before applying them.
- Silently dropping new orders, cancels, acknowledgments, or fills.
- Making telemetry reliable by letting it block a critical owner.
- Using an unbounded queue to “handle bursts.”
- Sizing to average traffic or a uniform synthetic generator.
- Applying \(1/(1-\rho)\) without the M/M/1 assumptions.
- Waiting to fill a batch on a latency-sensitive path without budgeting the wait.
- Starving gateway responses while draining an unlimited market-data burst.
- Disabling all trading for an instrument-scoped data failure—or continuing within the affected scope.
- Moving mandatory risk off-path because it is slow instead of redesigning its ownership.
- Measuring only successful/fast events and excluding rejects, recovery, or missing samples.

## 52.15 Recall card

```text
REQUIREMENTS
correctness + latency boundaries/distribution + burst capacity
+ freshness + availability/recovery + risk + audit/operations

PATHS
tick -> quality -> state -> decision -> risk -> gateway -> order
order -> venue -> ack/fill -> canonical order -> position/risk

OWNERSHIP
one authoritative writer per mutable truth
derived readers get versions and freshness
single writer removes write races, not all coordination

CRITICAL PATH
only correctness dependencies before the external action
name copies, queues, syscalls, serialization, coordination,
scheduling, memory, device/network, and work variance

TOPOLOGY
shard complete ownership paths when state partitions
pipeline only for measured capacity/isolation need
every stage boundary adds queue, lifetime, and failure semantics

QUEUES
unit + capacity + byte bound + useful age + full policy + recovery
snapshot state may conflate; ordered deltas/events may not
backpressure ends explicitly; external UDP does not cooperate

BATCHING
opportunistically batch work already present
waiting to fill adds latency; bounded drains prevent starvation

MEASUREMENT
correlate stages for the same event
percentiles are not additive
architecture != deployment != measurement != objective

OVERLOAD
protect correctness and freshness
reject before ambiguous ownership; reserve cancel/response capacity
invalidate/recover after ordered loss; count every degradation
```

## 52.16 Questions

1. Define wire-to-wire tick-to-order, userspace reaction, decision latency, and order-to-ack. What does each omit?
2. Draw the critical dependency chain for an eligible market update that produces an order. Which evidence must exist before sending?
3. Assign owners to market state, strategy state, risk reservations, gateway session state, live orders, and positions. Where are derived copies allowed?
4. Compare complete-path sharding with stage pipelining. What measurement would justify an extra stage?
5. For an internal market-data delta, latest book snapshot, new order, cancel, fill, and metric, define a full-queue response.
6. Why can per-stage p99s neither be summed nor substituted for an end-to-end p99?
7. State the assumptions behind \(W/S=1/(1-\rho)\). How would you obtain the real throughput–latency curve?
8. When can batching improve latency, and when does it necessarily add waiting?
9. A pointer queue removes a copy but increases tail latency. Which ownership, topology, and cache effects do you inspect?
10. During overload, how do you preserve cancel/fill processing while rejecting new intent and invalidating stale market state?

## 52.17 Puzzle and exercise

### Puzzle: the faster stage and slower system

Architecture A processes decode, book, and strategy on one owner in 3.0 fictional time units. Architecture B moves decode to a worker that takes 1.4 units while book/strategy take 1.8; the team claims the path is now 1.8 units because the stages run in parallel.

For one event whose strategy decision depends on its decode and book update, the work is not parallel on the dependency chain. Before queueing, B requires at least \(1.4+1.8=3.2\) units. Add enqueue/dequeue, discovery, ordering, and version coordination, and it is slower for reaction latency. B may still raise steady-state throughput by overlapping different events. The architecture decision depends on whether capacity benefit outweighs per-event latency and complexity under the actual objective.

### Exercise: review and break a miniature system

Design a system with two market-data channels, two instrument shards, one risk authority, and one ordered gateway session. Produce:

1. a component/ownership table;
2. tick-to-order and order-to-state critical-path diagrams;
3. queue contracts with capacity, age, and full behavior;
4. an eight-span latency schema with correlation identity;
5. a synthetic burst and skew load profile;
6. failure responses for feed gap, shard stall, risk expiry, full intent queue, disconnect, and telemetry stall;
7. a latency budget with explicit contingency;
8. one sharding and one pipeline alternative.

Then inject a hot-instrument burst while delaying gateway responses. Verify that market-data draining cannot starve acknowledgments, new intents fail before ambiguous acceptance, cancels retain admission, queue-age alarms lead capacity failure, and affected stale market state stops new actions. Report end-to-end distributions alongside correctness outcomes; a faster run with a silent loss fails.

## Prerequisite for Chapter 53

You are ready for market-data correctness when the architecture gives feed quality one authoritative owner, ordered deltas cannot be silently lost or conflated, state consumers receive version/freshness information, a gap invalidates the smallest honest scope, and recovery traffic has explicit capacity and latency behavior. Chapter 53 implements those promises.
