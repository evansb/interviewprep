# Chapter 53 — Market-Data Correctness

Fast wrong data is worse than no data.

An incremental market-data book is a replica of venue state. Its truth depends on message identity, order, schema, session generation, and every recovery decision. A receiver that notices a gap but continues publishing the old book has not “degraded gracefully”; it has converted known uncertainty into confident output.

The central invariant is:

> Every published market state is derived from one contiguous, validated history in one declared product/session/version—or is explicitly labeled non-current.

This chapter owns feed recovery: redundant-channel arbitration, duplicate suppression, gap detection, retransmission, snapshots, bounded catch-up, stale-state detection, and deterministic replay. Chapter 37 owns multicast protocol mechanics, Chapter 39 owns switch behavior, Chapter 46 owns the Linux receive path, Chapter 48 owns timestamp placement and packet capture, and Chapter 51 owns safe wire parsing.

## The 90-second version

Model the feed before optimizing it:

1. Define message identity: product/version, session epoch, channel/partition, sequence unit, message index, and instrument/event identity.
2. Normalize each valid wire message into an ordered key without guessing reset or wrap behavior.
3. Let one logical arbiter accept the first valid representation of the next expected identity.
4. Treat another identical representation as a duplicate; treat conflicting bytes/semantics for one identity as a correctness incident.
5. On an ahead-of-expected message, stop publishing current state, bound pending storage, and begin the product-defined recovery action.
6. Accept retransmitted data only if it closes the exact missing interval.
7. Accept a snapshot only after validating its session, completeness, depth, and precise inclusive/exclusive sequence anchor.
8. Build recovered state privately, apply a contiguous suffix, validate invariants, and publish one new generation atomically.
9. Condition every consumer output on quality: `LIVE`, `GAP`, `RECOVERING`, `STALE`, or `DISABLED`.
10. Replay raw A/B/recovery/snapshot traffic with a virtual clock and fault injection until every transition is deterministic.

The safety order is:

```text
bytes valid
  → identity valid
  → sequence relation known
  → history contiguous
  → semantic invariants hold
  → state generation published
```

Latency work begins after that chain is true. Skipping a check because the normal path is common does not make the abnormal path impossible.

### Label the contract

Use these labels in design notes and incident reports:

- **Protocol:** normative meaning of fields, sequence scope, reset/wrap, snapshot anchor, and recovery messages.
- **Venue:** rules of engagement, channel topology, recovery limits, schedules, and exceptional market states.
- **Product/version:** exact feed name, schema revision, effective date, partition map, reference-data version, and session identifier.
- **Implementation:** local buffering, timeout, arbitration, queue, state ownership, and publication choices.
- **Measured:** observed skew, loss, recovery duration, capacity, or latency tied to topology, clock, workload, run count, and statistic.

Never promote a local threshold into a protocol guarantee. Never infer a venue rule from another product with a similar message name.

## Core: one history, explicit quality

## 53.1 Identity, ordering, and state invariants

An application-level sequence integer is not a complete identity. A useful normalized identity may contain:

```text
FeedKey {
    product_version,
    trading_session_or_epoch,
    channel_or_partition,
    normalized_sequence,
    message_index_within_packet
}
```

The raw sequence may count packets, messages, events, or per-instrument reports. A packet can contain several messages. A message can affect several instruments. Some products expose both a channel packet sequence and a per-instrument sequence; validate both according to their different scopes.

Add semantic identity where available:

- order reference for order-level feeds;
- report/event ID;
- instrument plus per-instrument report sequence;
- source timestamp and match/event identifier;
- snapshot cycle and fragment number.

Do not deduplicate by timestamp or payload hash alone. Two legitimate updates can have equal timestamps or equal payloads.

### Normalize reset and wrap at the adapter

Raw sequence comparison requires protocol rules:

- width;
- initial value;
- reserved values;
- reset event and session boundary;
- whether wrap is permitted;
- whether comparison uses modular half-range ordering;
- whether sequence covers packets or messages.

Map raw identity into an internal `(epoch, ordinal)` or another total key in the product adapter. The recovery core should not see “sequence went backward” and guess whether that means duplicate, wrap, reset, or a new session.

An explicit reset/session transition invalidates pending data from the old epoch unless the product specifies a bridge. Record old and new identities. A reconnect, channel failover, or date change is not automatically a reset.

### Incremental state

Incremental feeds publish events rather than complete state:

- add/modify/delete an order;
- insert/change/delete a price level;
- execute quantity;
- change instrument or market status;
- publish a trade or statistic.

Semantics are product/version-specific. Quantity may be absolute or a delta. A trade-report message may or may not alter displayed liquidity. A replacement may create a new reference. Chapter 51 explains how to bind a decoder to the exact schema.

The replica is history-dependent:

\[
S_n = apply(S_{n-1}, E_n)
\]

If \(E_n\) is missing, duplicated, decoded under the wrong version, or applied twice, later \(S\) values have no general claim to correctness.

### Structural and business invariants

Validate invariants after each event or transaction:

- referenced order/level exists when required;
- add does not reuse a live unique reference unless specified;
- quantities remain within declared ranges;
- price scale and tick rules match reference-data version;
- side and action enums are known;
- depth and group indexes are valid;
- sequence continuity holds in every required scope;
- market-status transitions are legal for the venue/product state machine.

A locked or crossed book can be suspicious, but it is not universally impossible. Consolidated books, auctions, indicative prices, implied liquidity, locked-market rules, and transient venue states vary. Encode the exact product/market-state exceptions; do not use one universal `best_bid < best_ask` assertion.

### Quality is part of every output

Use an explicit state:

```text
COLD       no trustworthy base
BUILDING   snapshot/base under construction
LIVE       contiguous and within freshness contract
GAP        missing identity; old state must not be presented as current
RECOVERING base and/or suffix being reconciled
STALE      continuity may hold, but liveness/freshness contract failed
DISABLED   automatic recovery exhausted or invariant conflict
```

An instrument view should include:

```text
{book_generation, applied_through, quality, product_version, session_epoch}
```

Consumers must declare which quality values permit quoting, valuation, routing, or monitoring. A bare pointer to a book without quality metadata invites misuse.

### Channel quality and instrument quality

Keep the evidence scopes separate:

```text
channel quality: continuity, session, liveness, receive health
instrument quality: base completeness, per-instrument continuity,
                    semantic invariants, freshness, market state
```

A channel-level packet gap makes every instrument potentially affected when the missing packet’s contents are unknown. After recovery identifies the missing messages, some instruments may be proven unaffected—but that proof must come from recovered identities, not hope.

Conversely, one instrument can become invalid while channel sequence remains contiguous: an unknown order reference, illegal level index, wrong reference-data version, incomplete instrument snapshot, or instrument-level report-sequence gap can do it. Do not clear a semantic instrument failure merely because the next channel packet arrived.

Quality composition should be conservative:

\[
Q_{\text{published instrument}} =
Q_{\text{channel}} \land Q_{\text{instrument}} \land
Q_{\text{reference data}} \land Q_{\text{freshness}}
\]

This is logical notation, not a claim that quality is Boolean. Preserve the reasons so operators and automated policy can distinguish a recoverable packet gap from wrong schema or disabled reference data.

Status changes are themselves ordered events. Publish the transition to `GAP` before any consumer can observe later data. When several instruments share one immutable book generation, avoid publishing a mixture in which some entries carry new state but the generation-level channel quality still says live.

## 53.2 Redundant A/B arbitration and duplicate suppression

Redundant feeds provide two or more representations of a logical stream through paths chosen by the venue/product. They are not necessarily simultaneous, byte-identical at the packet level, or statistically independent. They may share a publisher, switch, fibre, clock, or receiver bottleneck.

The correctness goal is not “prefer A” or “always take the earliest timestamp.” It is:

> Apply each logical message once, in protocol order, from any valid source, and detect disagreement.

### Logical merge

```text
A ingress ─ validate/frame ─┐
                            ├─► identity arbiter ─► contiguous event stream
B ingress ─ validate/frame ─┘
```

For normalized key \(K\):

- \(K = expected\): the first valid copy may be applied.
- \(K < expected\): it is old, duplicate, replay, or old-epoch traffic; classify using epoch/product rules.
- \(K > expected\): expected data is absent so far; retain within a bound and enter gap/arbitration handling.
- same \(K\), same semantics: duplicate; count by source/path.
- same \(K\), different semantics: conflict; do not choose by arrival time. Capture both and fail closed or follow an explicit venue rule.

Deduplicate after enough parsing to establish identity and integrity, but before expensive semantic work when possible. If packet envelopes carry several messages and overlap partially, deduplicate per logical message. Dropping an entire packet because its first message is old can discard later missing messages.

### Arrival is an observation, not truth

First arrival can reduce latency when copies are equivalent, but arrival order is nondeterministic. State order comes from normalized protocol identity. Record source and arrival time as metadata; do not let them change book semantics.

The implementation needs one **logical owner** of `expected`, pending identities, and state transitions. That can be one thread polling both sources, or multiple ingress threads feeding a deterministic bounded arbiter. Same-thread polling is not a protocol requirement. Multi-threaded ingress must preserve buffer ownership and avoid arrival-race semantics.

### The arbitration wait is a failure window

After observing \(K>expected\), an implementation may briefly wait for another path, request retransmission immediately while still waiting, or move directly to snapshot recovery. The correct choice depends on:

- product recovery semantics and rate limits;
- measured inter-path skew distribution in the exact topology;
- event rate and pending capacity;
- freshness deadline;
- probability and cost of a needless request;
- whether the missing data can still arrive from another source;
- current source health and common-mode failure evidence.

There is no universal microsecond threshold or percentile. Predeclare the policy, measure it, and bound the interval during which state is non-current.

### Health evidence

Track per source:

- valid, malformed, duplicate, winning, late, and conflicting identities;
- last valid packet/message/heartbeat time;
- sequence high-water mark;
- loss and reorder evidence;
- capture/NIC/application drops from Chapter 48;
- timestamp domain and observed skew;
- session/product/version identity.

A changing “win rate” can indicate path drift, but its expected value is not universally equal across feeds. It depends on topology and batching. Alert from a measured baseline plus other evidence, not a fixed 50/50 expectation.

### Common-mode and asymmetric failure

Redundancy only helps for failures not shared by every copy. Compare evidence:

| Observation | Possible explanation | Next evidence |
|---|---|---|
| Only A misses one identity, B supplies it | A path loss/reorder or A-side capture loss | Per-source capture, NIC, and switch counters |
| A and B both omit the same identity | Shared publisher/upstream loss, or local loss after convergence | External capture and venue status |
| A and B arrive, application misses both | Shared host queue, parser, or consumer failure | Ring/application counters and replay |
| A and B same identity conflict | Publisher/path corruption, wrong product/session join, decoder error | Raw bytes, schema/version, independent decoder |
| One source slowly lags | Route/queue/clock/batching change | Calibrated timestamp distribution and path telemetry |

This table generates hypotheses, not proof. A single host capture can create a false appearance of common loss. Correlate at observation points from Chapter 48.

Keep source identity through normalization and recovery so an incident can be localized. Removing it immediately after “first wins” makes state deterministic but destroys evidence.

## 53.3 Gap detection and bounded retransmission

A gap is established when protocol evidence shows an identity ahead of the next expected one:

```text
expected = 700
receive 703
missing normalized interval = [700, 703)
```

Silence alone is not a sequence gap. It may be an inactive instrument, halt, broken channel, or lost heartbeat. Liveness and staleness are separate quality signals.

### Gap state

On the first gap:

1. atomically mark affected output `GAP`;
2. record missing interval, first-detection time, high-water identity, and source evidence;
3. retain later valid events in a bounded pending structure;
4. keep deduplicating redundant/retransmitted copies;
5. choose the configured recovery method;
6. expose counters and deadlines without synchronous hot-path logging.

Do not apply ahead-of-gap updates to the published book. Doing so creates a state that is neither the old contiguous state nor a valid new state.

### Retransmission

A product may offer retransmission by exact sequence interval, packet interval, message count, or session cursor. The request and response may have different framing and throttles. Validate retransmitted messages through the same schema and semantic path as live messages.

Request only intervals representable by the protocol. Coalesce overlapping missing ranges without widening them beyond local memory/freshness policy. Respect venue request-rate and range limits. A response can:

- exactly fill the gap;
- overlap data already received;
- contain only part of the requested range;
- be stale or from another session;
- itself contain a discontinuity;
- arrive after snapshot recovery has superseded it.

Classify every message by normalized identity. Never “apply the retransmission response” as an opaque block.

### Recovery is a decision, not a universal ladder

Many systems can choose among another redundant copy, retransmission, a snapshot, or disabling the product. Their order is not universal.

Build a decision from:

- size and shape of the missing interval;
- whether missing identities are packet-, channel-, or instrument-scoped;
- whether another source already has the data;
- retransmission availability, response semantics, and rate limits;
- snapshot availability, anchor/depth/completeness, and expected wait;
- remaining pending count/bytes/age budget;
- consumer freshness deadline;
- current load and evidence that the receiver itself is overloaded;
- whether the state before the gap remains useful for any read-only consumer;
- operational escalation policy.

A small gap does not automatically imply retransmission. During a broad incident, request service may be constrained or a fresh snapshot may provide a safer bound. A large numerical gap can contain few application messages if the sequence unit is packets or spans administrative traffic. Conversely, one missing stateful encoding update can invalidate a long suffix.

The decision must be deterministic for the same explicit inputs. Record the reason, chosen method, attempt number, deadline, and outstanding ranges. Rate limiting belongs inside the state machine: a rejected recovery request is an input that changes the next safe action, not merely a log message.

### Bounded pending state

Pending memory has two bounds:

- a count/byte bound;
- an age/freshness bound.

When either is reached, transition deterministically—usually toward snapshot recovery or `DISABLED` according to the product and risk contract. Dropping arbitrary pending entries while remaining `LIVE` is never correct.

Use separate limits per channel/instrument where isolation is supported. A hot instrument should not consume the entire recovery budget and prevent unrelated state from recovering.

### Explicit failure windows

Record these timestamps or durations:

| Window | Begins | Ends | State consumers may trust |
|---|---|---|---|
| Undetected loss | Missing event should have arrived | Later identity/liveness evidence | Only state through last applied identity, not “current” |
| A/B arbitration | Ahead identity observed | Missing copy arrives or recovery action fires | `GAP` |
| Retransmit flight | Request issued | Required response validated | `GAP`/`RECOVERING` |
| Snapshot wait/build | Snapshot selected/requested | Complete candidate validated | `RECOVERING` |
| Catch-up | Snapshot anchor installed privately | Contiguous suffix reaches live high-water | `RECOVERING` |
| Publication | Candidate ready | New generation visible | Old generation remains labeled non-current |

The first window can be unbounded on a silent channel unless the product supplies heartbeat/liveness semantics. This is why “we detect gaps immediately” is usually an incomplete claim.

### Correctness before recovery latency

Optimize recovery duration only while preserving the same acceptance and publication invariants. A faster result is invalid if it:

- publishes ahead-of-gap events;
- accepts an older or incomplete snapshot;
- drops pending data without invalidating quality;
- narrows a gap by guessing which instrument was affected;
- chooses conflicting copies by arrival time;
- skips checksum/schema/semantic validation;
- declares currentness without live-edge evidence.

The primary service-level record for a recovery should include:

```text
product/session/channel/instrument scope
last contiguous identity
first observed ahead identity
quality transition times and clock
missing intervals over time
pending count/bytes/oldest age/high-water
recovery requests, responses, and venue result codes
snapshot candidates and rejection reasons
candidate catch-up identity
published generation and applied-through identity
consumer actions while non-live
raw capture reference and capture-loss counters
```

Aggregate metrics are useful only if the incident can still be reconstructed. Count transitions and outcomes by bounded reason codes; do not put raw instrument or sequence values into unbounded metric labels.

Useful distributions include detection delay where ground truth is available, arbitration duration, retransmission flight, snapshot wait/build, catch-up, total non-live duration, and pending high-water. State the environment, workload/incident population, sample count, and statistic. A median recovery time does not describe the tail or prove that any recovered book was correct.

Compare designs on at least:

- fraction of recoveries that returned to verified `LIVE`;
- fraction escalated or disabled;
- non-live duration distribution;
- maximum pending resource use;
- conflicting/stale/wrong-session evidence detected;
- publication-generation consistency checks;
- consumer exposure to non-live data, which should follow the declared policy.

If an optimization shortens recovery but increases unverified publication, it is a correctness regression. If it delays recovery slightly while eliminating an ambiguous cutover window, it may be the better low-latency system because downstream strategies no longer need to unwind decisions made from uncertain state.

## 53.4 Snapshot-plus-delta recovery

A snapshot is useful only with a precise consistency anchor and completeness contract.

Possible anchor meanings include:

- **inclusive last applied:** snapshot contains increments through \(A\); next required is `successor(A)`;
- **exclusive next expected:** snapshot contains increments before \(N\); next required is \(N\);
- **per-instrument anchor:** snapshot aligns with instrument report sequence, not channel packet sequence;
- **cycle/fragment boundary:** multipart snapshot becomes valid only at an explicit end marker;
- **transaction boundary:** snapshot is consistent at a venue-defined update transaction, not each packet.

Normalize the product’s anchor into `snapshot_next_expected`. Do not hard-code `X >= F-1`: that expression assumes inclusive integer sequences, no underflow, no wrap, and a particular meaning for `F`. Those assumptions are not universal.

### Safe algorithm

```text
on startup or unrecoverable gap:
    quality = BUILDING or RECOVERING
    begin bounded capture of valid incrementals immediately
    remember session/product and observed high-water

for each snapshot candidate:
    validate schema/version/session/instrument
    validate all fragments, counts, depth, and integrity
    convert product anchor → snapshot_next_expected
    reject if older than already committed state in the same epoch
    reject if required post-anchor incrementals are no longer available

    construct candidate book privately from snapshot
    discard pending events strictly before snapshot_next_expected
    apply pending events contiguously from snapshot_next_expected
    if a hole remains:
        keep candidate private and continue recovery
    else if candidate reaches declared live high-water/freshness boundary:
        validate semantic invariants
        publish one new generation with quality LIVE
```

Begin retaining incrementals before or atomically with snapshot acquisition. Otherwise an update can fall between snapshot anchor and the start of buffering.

### Snapshot acceptance

Validate:

- exact product/schema/reference-data version;
- session/epoch and instrument/partition;
- anchor semantics and normalization;
- completeness/end marker and fragment order;
- declared versus received entry counts;
- depth scope: full order book, fixed levels, or another subset;
- duplicate/conflicting entries;
- market-state and price/quantity invariants;
- freshness relative to already committed and observed live identities.

A depth-limited snapshot cannot reconstruct unknown deeper state unless the product’s semantics make that depth complete for the consumer. Mark depth outside the snapshot as unknown, or publish a deliberately limited-depth product. Unknown is not empty.

Snapshots for different instruments need not represent one simultaneous market instant. Cross-instrument consumers must not infer an atomic global cut merely because snapshots appeared in one cycle.

### Multipart snapshots

A multipart snapshot requires a state machine of its own:

```text
EMPTY
  → BEGIN(session, instrument, snapshot_id, anchor, declared_scope)
  → PART(index, entries...)
  → ...
  → END(part_count, entry_count, integrity)
  → COMPLETE_CANDIDATE
```

Reject or restart on wrong session, snapshot ID, duplicate-conflicting fragment, impossible count, missing part, overlapping range, or unsupported scope. A timeout leaves no partial book eligible for publication.

Fragments can interleave with incrementals and, in some products, with snapshots for other instruments. Keep candidate identity explicit. “Last fragment received” is not equivalent to “all fragments received” unless the protocol says ordering plus last marker proves it.

Apply the snapshot into private empty state, not on top of the old book, unless the protocol explicitly defines a delta snapshot. Otherwise entries absent from the new snapshot can leak from the old generation.

If a newer snapshot candidate appears while an older one is incomplete, the product and memory policy determine whether to abandon the old candidate or track both. Bound the number of candidates and make the choice deterministic.

### Stale snapshot rejection without arithmetic traps

Compare normalized keys within the same epoch:

```text
if snapshot_next_expected < minimum_acceptable_next:
    reject stale candidate
```

`minimum_acceptable_next` comes from what state is already committed and which buffered suffix still exists. It is not universally “first buffered minus one.” Use ordered keys and successor operations supplied by the product adapter, so minimum raw values and wrap do not underflow.

### Catch-up and late recovery traffic

After snapshot installation, replay only events at or after `snapshot_next_expected`, in contiguous normalized order. If a retransmission response arrives for identities already covered by the snapshot, it is duplicate evidence. If it conflicts, disable/escalate; do not overwrite snapshot state by arrival order.

Do not publish the candidate merely because pending storage is empty. Establish that it reached the live high-water/freshness boundary. An empty buffer can mean the receiver failed to capture live data.

## 53.5 Staleness, semantic failure, and publication

Continuity proves only that no detectable sequence was skipped. A perfectly contiguous stream can be stale, decoded under the wrong schema, or semantically invalid.

### Staleness signals

Use layered evidence:

- product heartbeat/system-event deadlines;
- source/channel last-valid-message time;
- per-instrument activity compared with declared market state;
- redundant-source divergence;
- exchange/source timestamp versus correctly synchronized receive timestamp;
- upstream status/reference channels;
- local backlog and high-water lag;
- venue notices and session transitions.

Thresholds must be product, instrument class, market state, and time-of-day aware. A quiet instrument and a broken feed can look identical without a heartbeat or corroborating channel.

Clock comparisons inherit the timestamp-placement and synchronization error from Chapter 48. A growing source-to-receive delta can mean path delay, clock drift, batching, or backlog; diagnose before assigning cause.

### Scope quality narrowly but safely

If sequence is per channel, a channel gap may make every instrument on that channel non-current even if the missing event’s instrument is unknown. If the protocol supplies trustworthy per-instrument continuity and message identity, recovery may be scoped more narrowly.

Never infer narrow scope from decoded payload after losing the packet that would have identified the affected instrument.

### Atomic publication

Build mutable state under a single logical owner or private generation. Publish:

```text
PublishedView {
    immutable_book_or_generation,
    normalized_applied_through,
    quality,
    product_version,
    session_epoch,
    publication_time_and_clock
}
```

Readers must observe the book and metadata from the same generation. Publishing the book pointer and quality in unrelated atomics can expose a live label with an old or partial book.

A seqlock, RCU-style immutable generation, single-thread handoff, or mutex can implement the invariant. The mechanism is secondary; prove that readers cannot observe a partially recovered state.

On a new gap, either withdraw the current generation or keep it accessible with `GAP/STALE` and its last applied identity. Do not mutate it with ahead-of-gap messages.

### Consumer contracts during failure

Different consumers may use non-live data differently, but the feed handler should not silently decide for them:

| Consumer | Possible non-live policy |
|---|---|
| Order strategy | Suppress new decisions; cancel or hold under risk policy |
| Risk monitor | Retain last good values with age/quality, widen conservatively, or use independent source |
| Operations UI | Display last state visibly marked with reason and applied-through identity |
| Recorder | Continue capturing all sources and recovery decisions |
| Reference calculator | Refuse update or propagate `unknown` rather than substitute zero |

These are examples, not universal trading rules. The important interface is that stale/gap status cannot be accidentally erased by reading a numeric price.

Recovery completion also needs a memory-order/publication test. Pause a reader at every instruction boundary around generation publication and prove it sees either the entire old tuple or the entire new tuple. Unit tests that check only the writer’s final state miss this class of bug.

## 53.6 Deterministic merge and replay

Determinism means the same explicit inputs produce the same ordered events, quality transitions, and state hashes.

### Deterministic order

Use protocol identity as primary order. For records with the same identity:

1. validate equivalence;
2. choose a stable source-independent semantic representation;
3. retain source/timestamp metadata separately;
4. use a documented stable tie-break only where the protocol permits multiple events at the same key.

Do not use thread scheduling, receive-queue order, local timestamp, pointer address, or hash-map iteration as a semantic tie-break.

### Capture the actual inputs

Retain:

- raw traffic from every redundant source;
- capture timestamps with domains/placement;
- retransmission requests and responses;
- snapshot traffic and acquisition decisions;
- product specifications/schema hashes;
- reference data and session/partition maps;
- configuration and local recovery limits;
- timer/liveness inputs;
- software build and normalization rules;
- capture/drop counters.

Raw capture can reproduce decoder and framing bugs; normalized events alone cannot. But raw packets without loss metadata and configuration are not a complete experiment.

### Replay modes

- **Semantic replay:** feed captured bytes/events through the state machine as fast as possible.
- **Paced replay:** drive a virtual monotonic clock from recorded timing to test arbitration and staleness.
- **Fault-injected replay:** remove, duplicate, reorder, corrupt, delay, or conflict selected identities.
- **Differential replay:** compare production and independent/reference implementations.

Recovery traffic must be replayed too. A test that drops a live packet and then injects an ideal snapshot bypasses the real failure path.

Useful assertions:

- two equivalent A/B arrival permutations produce the same state hash;
- duplicates do not change applied sequence or state;
- conflicting duplicates never choose by arrival;
- ahead-of-gap messages never reach published state;
- every pending/snapshot limit has a deterministic transition;
- stale/wrong-session snapshots are rejected;
- live publication occurs only after contiguous catch-up;
- state hash and quality match at every applied ordinal.

### Hash the semantics, not memory layout

A deterministic state hash should encode canonical semantic fields:

- sorted instrument/order/level identities;
- fixed-width price and quantity values in declared byte order;
- market status and reference-data version;
- normalized applied-through key and quality;
- explicit unknown/truncated-depth markers.

Do not hash padding, pointer values, allocator order, raw `unordered_map` iteration, or platform-native object bytes. Version the hash format. A hash mismatch localizes divergence but does not explain it; retain per-ordinal hashes or periodic checkpoints so binary search can find the first differing transition.

Differential replay needs an independent oracle when possible. Two builds generated from the same incorrect normalizer can agree perfectly. Compare with venue-provided checks, a simpler reference book, or independently implemented invariants. When no oracle exists, metamorphic tests remain useful: inserting equivalent duplicates must not change state, swapping A/B arrival for identical identities must not change semantics, and splitting a capture into different receive batches must not change results.

Timers are inputs. Paced replay should record which timestamp domain drives arbitration and stale deadlines, what happens when equal-time events occur, and how clock discontinuity is handled. Using the replay machine’s wall clock makes recovery decisions non-reproducible.

## 53.7 A compact validated recovery model

The following C++23 model uses a **normalized monotonic ordinal** supplied by a product adapter. Raw wrap and reset never enter this core. It models one instrument, a fixed pending capacity, duplicate/conflict checks, an exclusive snapshot anchor (`next`), and quality-gated output.

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>

enum class Source { a, b, retransmit };
enum class Quality { live, gap, recovering, disabled };
enum class Result {
    applied,
    buffered,
    duplicate,
    snapshot_installed,
    stale_snapshot,
    wrong_generation,
    already_disabled,
    conflict,
    invalid_quantity,
    ordinal_exhausted,
    capacity_exhausted
};

struct Increment {
    std::uint64_t generation{};
    std::uint64_t ordinal{};
    std::int64_t quantity_delta{};
    Source source{};
};

struct Snapshot {
    std::uint64_t generation{};
    std::uint64_t next_ordinal{}; // exclusive: snapshot contains all before next
    std::int64_t quantity{};
};

class RecoveryModel {
public:
    RecoveryModel(std::uint64_t generation,
                  std::uint64_t expected,
                  std::int64_t initial_quantity)
        : generation_(generation),
          expected_(expected),
          quantity_(initial_quantity) {
        if (initial_quantity < 0) quality_ = Quality::disabled;
    }

    Result on_increment(const Increment event) {
        if (quality_ == Quality::disabled) {
            return Result::already_disabled;
        }
        if (event.generation != generation_) {
            return Result::wrong_generation;
        }
        if (event.ordinal < expected_) {
            return Result::duplicate;
        }
        if (!high_seen_ || event.ordinal > *high_seen_) {
            high_seen_ = event.ordinal;
        }

        if (event.ordinal == expected_) {
            const auto result = apply(event);
            if (result != Result::applied) return result;
            drain_contiguous();
            update_quality();
            return Result::applied;
        }

        for (const auto& slot : pending_) {
            if (slot && slot->ordinal == event.ordinal) {
                if (slot->quantity_delta == event.quantity_delta) {
                    return Result::duplicate;
                }
                quality_ = Quality::disabled;
                return Result::conflict;
            }
        }
        for (auto& slot : pending_) {
            if (!slot) {
                slot = event;
                if (quality_ == Quality::live) quality_ = Quality::gap;
                return Result::buffered;
            }
        }
        quality_ = Quality::disabled;
        return Result::capacity_exhausted;
    }

    Result on_snapshot(const Snapshot snapshot) {
        if (quality_ == Quality::disabled) {
            return Result::already_disabled;
        }
        if (snapshot.generation != generation_) {
            return Result::wrong_generation;
        }
        if (snapshot.quantity < 0) {
            quality_ = Quality::disabled;
            return Result::invalid_quantity;
        }
        if (snapshot.next_ordinal < expected_) {
            return Result::stale_snapshot;
        }

        quantity_ = snapshot.quantity;
        expected_ = snapshot.next_ordinal;
        for (auto& slot : pending_) {
            if (slot && slot->ordinal < expected_) slot.reset();
        }
        quality_ = Quality::recovering;
        drain_contiguous();
        update_quality();
        return Result::snapshot_installed;
    }

    [[nodiscard]] Quality quality() const { return quality_; }
    [[nodiscard]] std::uint64_t expected() const { return expected_; }

    [[nodiscard]] std::optional<std::int64_t> live_quantity() const {
        if (quality_ != Quality::live) return std::nullopt;
        return quantity_;
    }

private:
    Result apply(const Increment event) {
        if (expected_ == std::numeric_limits<std::uint64_t>::max()) {
            quality_ = Quality::disabled;
            return Result::ordinal_exhausted; // adapter must start a new epoch
        }
        if (event.quantity_delta < 0 &&
            (event.quantity_delta ==
                 std::numeric_limits<std::int64_t>::min() ||
             quantity_ < -event.quantity_delta)) {
            quality_ = Quality::disabled;
            return Result::invalid_quantity;
        }
        if (event.quantity_delta > 0 &&
            quantity_ > std::numeric_limits<std::int64_t>::max() -
                            event.quantity_delta) {
            quality_ = Quality::disabled;
            return Result::invalid_quantity;
        }
        quantity_ += event.quantity_delta;
        ++expected_;
        return Result::applied;
    }

    void drain_contiguous() {
        for (;;) {
            std::optional<Increment> next;
            for (auto& slot : pending_) {
                if (slot && slot->ordinal == expected_) {
                    next = *slot;
                    slot.reset();
                    break;
                }
            }
            if (!next) return;
            if (apply(*next) != Result::applied) return;
        }
    }

    void update_quality() {
        if (quality_ == Quality::disabled) return;
        const bool caught_up = !high_seen_ || expected_ > *high_seen_;
        quality_ = caught_up ? Quality::live : Quality::recovering;
    }

    static constexpr std::size_t pending_capacity = 4;
    std::uint64_t generation_{};
    std::uint64_t expected_{};
    std::int64_t quantity_{};
    std::optional<std::uint64_t> high_seen_;
    std::array<std::optional<Increment>, pending_capacity> pending_{};
    Quality quality_{Quality::live};
};

int main() {
    RecoveryModel model{7, 100, 10};

    assert(model.on_increment({7, 100, -2, Source::a}) ==
           Result::applied);
    assert(model.live_quantity() == 8);
    assert(model.on_increment({7, 100, -2, Source::b}) ==
           Result::duplicate);

    assert(model.on_increment({7, 102, +5, Source::b}) ==
           Result::buffered);
    assert(model.quality() == Quality::gap);
    assert(!model.live_quantity());

    assert(model.on_increment({7, 101, -3, Source::a}) ==
           Result::applied);
    assert(model.expected() == 103);
    assert(model.live_quantity() == 10); // seq 102 drained once

    assert(model.on_increment({7, 105, +1, Source::a}) ==
           Result::buffered);
    assert(model.on_snapshot({7, 105, 20}) ==
           Result::snapshot_installed);
    assert(model.expected() == 106);
    assert(model.live_quantity() == 21);
    assert(model.on_snapshot({7, 104, 99}) ==
           Result::stale_snapshot);

    RecoveryModel conflict{8, 200, 0};
    assert(conflict.on_increment({8, 202, +1, Source::a}) ==
           Result::buffered);
    assert(conflict.on_increment({8, 202, +2, Source::b}) ==
           Result::conflict);
    assert(conflict.quality() == Quality::disabled);

    RecoveryModel hostile{9, 1, 0};
    assert(hostile.on_increment(
               {9, 1, std::numeric_limits<std::int64_t>::min(), Source::a}) ==
           Result::invalid_quantity);
    assert(hostile.on_increment({9, 1, +1, Source::b}) ==
           Result::already_disabled);
}
```

This is a model, not a production book:

- it handles one instrument and one semantic quantity;
- the adapter already validated bytes and normalized epochs/ordinals;
- equivalent duplicates compare semantics, not raw packet bytes;
- snapshot `next_ordinal` is explicitly exclusive;
- pending storage is fixed;
- output is available only when quality is `live`;
- a conflict disables rather than choosing the fastest source.

A deliberate limitation is that the model detects conflicting copies while an identity is pending, but does not retain fingerprints for identities already applied. A production arbiter that must detect late conflicting copies needs a bounded recent-identity fingerprint table sized from the permitted lateness/replay window. That table also has an exhaustion and epoch-reset policy.

A production version must preserve the same invariants across all book structures, snapshot fragments, product states, timers, and publication generations.

## 53.8 Worked recovery trace

Assume one product/version adapter has normalized session generation 12 into ordinals. The implementation’s configured pending capacity is six events. Its arbitration wait and retransmit limits were selected from venue rules and measurements recorded with the deployment; no values are implied here.

Initial published view:

```text
generation=41, applied_through=999, quality=LIVE
next_expected=1000
```

| Step | Input | Decision | Published quality/state |
|---:|---|---|---|
| 1 | B supplies valid 1000 | Apply; next=1001 | `LIVE`, generation 41 updated through 1000 |
| 2 | A supplies equivalent 1000 | Duplicate | Unchanged |
| 3 | A supplies 1002 | Missing `[1001,1002)`; retain 1002 | `GAP`; book through 1000 labeled non-current |
| 4 | B supplies equivalent 1002 | Duplicate pending | `GAP` |
| 5 | Retransmit supplies 1001 | Apply 1001, then retained 1002 | `LIVE`; contiguous through 1002 |
| 6 | B supplies 1005 | Missing `[1003,1005)`; retain | `GAP` |
| 7 | Recovery service returns only 1003 | Apply privately/contiguously; 1004 still absent | `RECOVERING`; no live publication |
| 8 | Complete snapshot says `next=1005` | Build state containing all events before 1005; retain 1005 | Candidate private |
| 9 | Apply retained 1005 to candidate | Candidate reaches observed high-water | Validate invariants; publish generation 42 `LIVE` |
| 10 | Late retransmit supplies 1004 | Covered by snapshot; duplicate/late evidence | Generation 42 unchanged |
| 11 | A supplies 1006 but B supplies different semantics for 1006 before commit | Identity conflict | `DISABLED`; capture both, publish no new live state |

### What each failure window exposed

- Between steps 3 and 5, the last book was known only through 1000.
- Step 7 did not become live merely because some recovery arrived.
- The snapshot at step 8 used an exclusive `next=1005`; no `F-1` arithmetic appeared.
- Step 10 was not applied after the snapshot because the snapshot already covered it.
- Step 11 did not select A or B by timestamp. Equal identity with unequal semantics is stronger evidence than path latency.

The public generation changed only when the candidate was contiguous and invariant-valid. Monitoring can still inspect the last good book during recovery, but trading consumers see its non-live quality.

## Skippable reference

## 53.9 Recovery decision table

| Evidence | Quality transition | Bounded action |
|---|---|---|
| Expected identity arrives | Remain/return `LIVE` after commit | Apply once; drain contiguous pending |
| Equivalent old identity | None | Count duplicate; release buffer |
| Ahead identity | `LIVE → GAP` | Record interval; retain within bound; start policy |
| Missing copy arrives from redundant path | `GAP → LIVE` if fully contiguous | Validate and apply exact suffix |
| Partial retransmission | `GAP/RECOVERING` | Apply only contiguous prefix; request/escalate per policy |
| Pending count/age limit | `GAP → RECOVERING/DISABLED` | Snapshot or fail closed |
| Valid current snapshot plus contiguous suffix | `RECOVERING → LIVE` | Publish one new generation |
| Stale/wrong-session snapshot | None | Reject and count |
| Semantic invariant failure | `* → DISABLED` | Withdraw/label output; capture evidence |
| Liveness deadline without sequence evidence | `LIVE → STALE` | Corroborate/recover under product rules |
| A/B same identity, conflicting semantics | `* → DISABLED` | Preserve both; escalate |
| Explicit session/reset | Product-defined transition | Flush/bridge only as specification says |

## 53.10 Testing matrix

For every supported product/version, test:

- first/last/minimum/maximum sequence values;
- explicit reset and wrong-session traffic;
- packet-level and message-level gaps;
- duplicate before and after apply;
- partially overlapping packets;
- A first, B first, only A, only B, neither, and conflicting A/B;
- retransmission exact, partial, overlapping, late, and discontinuous;
- snapshot inclusive/exclusive adapter conversion;
- multipart missing, duplicate, reordered, and conflicting fragments;
- stale, wrong-version, wrong-instrument, and depth-limited snapshots;
- pending count and age exhaustion;
- heartbeat silence versus quiet instrument;
- invariant failure during live apply and during catch-up;
- reader observation during every publication transition;
- deterministic replay under all permitted arrival permutations.

Each test should assert quality, applied-through identity, pending intervals, published generation, and state hash—not merely “no crash.”

## Recall card

- A published book is valid only for one product/version/session and one contiguous history.
- Normalize raw reset/wrap rules in the product adapter.
- Packet sequence, message index, per-instrument sequence, and event identity have different scopes.
- Redundant feeds are not guaranteed simultaneous or independent.
- Merge by protocol identity; arrival time is metadata.
- Equivalent same-identity input is duplicate; conflicting same-identity input is an incident.
- Deduplicate partially overlapping packets at message granularity.
- One logical owner controls expected identity and state, regardless of ingress thread count.
- Gap detection requires later sequence or liveness evidence; silence alone is not a sequence gap.
- On a gap, stop live publication and bound pending count and age.
- Retransmit responses are ordinary sequenced input, not trusted blocks.
- Normalize snapshot anchors to an explicit `next_expected`.
- Validate session, completeness, depth, counts, version, and freshness before snapshot use.
- Build privately, catch up contiguously, validate, then publish atomically.
- Empty pending storage does not prove arrival at the live edge.
- Continuity does not prove freshness or correct semantics.
- Every consumer sees quality with the book generation.
- Raw deterministic replay plus fault injection keeps rare recovery paths alive.

## Review questions

1. Why is a raw sequence integer insufficient as global message identity?
2. What must a product adapter define before the core compares wrapped or reset sequences?
3. Why should conflicting A/B copies not be resolved by first arrival?
4. When can a partially overlapping packet contain both duplicates and needed data?
5. What are the undetected-loss, arbitration, retransmit, snapshot, catch-up, and publication windows?
6. Why is `snapshot_sequence >= first_buffered - 1` not a universal rule?
7. What proves that a snapshot candidate has reached the live edge?
8. Why can a contiguous feed still be stale or wrong?
9. How can readers observe book data and quality from the same generation?
10. Which replay inputs are required to reproduce a recovery decision?

## Exercise

Extend the compact model in §53.7:

1. add an explicit `cold/building` startup state;
2. add multipart snapshots with fragment identity and an end marker;
3. add pending age driven by an injected virtual clock;
4. add a product adapter that maps a small wrapping raw sequence into `(epoch, ordinal)` only when an explicit session/reset event permits it;
5. add exact missing-interval reporting and bounded retransmit attempts;
6. make published state an immutable `{quantity, applied_through, quality, generation}` object;
7. generate every A/B arrival permutation for three ordinals and assert the same final state hash;
8. inject loss, duplicate, conflict, stale snapshot, wrong session, capacity exhaustion, and clock advancement.

Compile with warnings and sanitizers. Record every expected quality transition in a golden trace.

## Puzzle

A receiver has processed through sequence 900. It observes 902 from A and retains it. A snapshot arrives with a field value of 901. Is the snapshot exactly what recovery needs, stale, or too new?

There is not enough information. If the field is an inclusive “last applied,” the next required sequence may be 902 and the snapshot could abut the retained event. If it is an exclusive “next expected,” sequence 901 is still required. If it is a per-instrument report sequence while 902 is a channel packet sequence, they are not directly comparable. Session epoch, completeness, and depth must also match. Normalize the product’s documented anchor before deciding.

## Common traps

- Publishing a book without quality, session, version, and applied-through identity.
- Treating packet sequence as instrument/event identity.
- Comparing raw wrapped/reset sequences with ordinary integer ordering.
- Inferring reset from a backward number.
- Assuming A/B feeds are simultaneous, independent, equally fast, or byte-identical.
- Designating a universal primary without considering the product contract.
- Choosing duplicate winners by local timestamp.
- Ignoring same-identity semantic conflicts.
- Deduplicating an entire partially overlapping packet from its first sequence.
- Decoding both copies fully before identity dedup when the envelope permits earlier validation.
- Requiring A and B to be polled by the same thread instead of requiring one logical owner.
- Hard-coding an arbitration window copied from another topology.
- Claiming immediate gap detection on a silent channel.
- Continuing to publish `LIVE` after observing a gap.
- Applying ahead-of-gap data to the old book.
- Letting pending memory or age grow without a bound.
- Dropping arbitrary pending entries while staying live.
- Trusting retransmission blocks without per-message validation.
- Retrying recovery without venue rate/range limits.
- Starting incremental capture after requesting/waiting for a snapshot.
- Using a snapshot without an exact anchor and session.
- Assuming all snapshot anchors are inclusive.
- Using `F-1` at a minimum value or across wrap.
- Treating a depth-limited snapshot’s unknown tail as empty.
- Assuming snapshots across instruments are one simultaneous cut.
- Publishing a snapshot before contiguous catch-up.
- Treating an empty pending queue as proof of currentness.
- Accepting a stale/wrong-version/wrong-session snapshot.
- Assuming a crossed/locked book is impossible in every venue state.
- Using one staleness threshold for every product, instrument, and market state.
- Blaming network delay without accounting for timestamp clock error.
- Publishing book and quality through unrelated generations.
- Capturing normalized events but not raw recovery/snapshot traffic.
- Letting wall clock, thread scheduling, or arrival tie-breaks alter replay semantics.
- Testing only the normal live path.
- Optimizing duplicate/gap branches before proving every transition.

## Prerequisite check

You are ready to use this chapter when you can:

- distinguish packet, message, event, instrument, channel, session, and product identity;
- explain inclusive versus exclusive snapshot anchors;
- distinguish continuity, freshness, integrity, and semantic validity;
- describe why a view can remain readable while no longer being current;
- design a bounded pending structure and an exhaustion transition;
- replay a virtual-clock event sequence deterministically;
- state which quality values each trading consumer is permitted to use.

If any item is unclear, implement the compact model and reproduce the worked trace before adding networking, book depth, or performance optimizations.
