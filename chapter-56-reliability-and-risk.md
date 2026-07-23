# Chapter 56 — Reliability and Risk

**Why this matters.** A trading system can be fast, available, and wrong. The dangerous failures are not always crashes: a gateway may be alive with stale risk state, a standby may promote while the old active still sends, a local journal may say “prepared” while the venue has already filled, or two individually valid orders may exceed one shared credit limit together.

Reliability and risk are therefore one problem: preserve explicit invariants while state crosses threads, processes, hosts, storage, networks, and venues. The design must say what is committed, what is merely visible, which actions are ambiguous, how exposure is bounded during uncertainty, and which authority permits trading to resume.

**90-second screen.**

Five facts:

1. Start with failure states and safety invariants, not an availability slogan. “The process is up” does not mean its market, order, risk, or neighbor state is valid.
2. Risk checks must reserve aggregate capacity **before** an order can escape. Working, partially filled, pending, and outcome-unknown orders remain exposure until authoritative evidence releases them.
3. A release store can publish a complete record to memory readers; it does not flush a page cache, order storage writes, or survive power loss. Durability needs an explicit OS/storage or replication contract.
4. A journal and a network send cannot form one atomic transaction with an external venue. A crash can leave an order outcome unknown; stable identities, fencing, replay, and venue reconciliation close that window.
5. A missed heartbeat is suspicion, not proof of death. Promotion is safe only when the old sender is fenced at a resource that can reject it and the new sender has reconciled external truth.

Two decisions:

- For every control dependency, classify actions as risk-increasing, risk-reducing, or observational, then choose fail-closed/open behavior for that specific action.
- For every acknowledgement, state the commit point and failure domain: memory-visible, locally crash-recoverable, replicated, accepted by the venue, or durably recorded by an external authority.

---

## 56.1 Failure Model, Invariants, and Claim Labels — Core

A **failure model** states what can go wrong and which combinations the design intends to tolerate. Without it, “high availability” means whatever failure did not happen in the last demo.

| Failure | State that becomes uncertain | Invariant under threat | Safe first response |
|---|---|---|---|
| Process crash | in-memory orders, reservations, sequence state | external actions remain reconstructable | recover committed prefix; mark tail ambiguous |
| Host/power loss | page cache and local process state | acknowledged records survive stated failure domain | use the declared durable/replicated commit point |
| Storage error or torn tail | journal/checkpoint suffix | replay never accepts corrupt partial state | validate record/commit metadata; stop at known prefix |
| Network partition | peer and venue reachability | at most one authorized sender | fence before promotion; enter cancel-only/recovery |
| Stale market/reference data | price and strategy decisions | no new exposure from invalid inputs | block affected risk-increasing actions |
| Lost/delayed order response | live-order outcome | unknown is not treated as rejected | reserve worst case; query/reconcile |
| Overload | queues, clocks, feed/order freshness | stale work does not create uncontrolled exposure | degrade by policy; prioritize risk reduction |
| Bad config/operator action | limits, symbols, credentials | one validated policy version governs a decision | atomic versioned activation and audit trail |
| Software defect | all replicated instances | redundancy does not multiply the defect | independent controls, canaries, and external limits |

### The invariants

An interview-quality design names safety properties that can be tested:

1. **No unauthorized exposure:** every risk-increasing outbound action passed the controls and configuration version recorded for that decision.
2. **Conservative aggregate risk:** current position plus worst-case working, pending, and ambiguous exposure does not exceed its approved bound.
3. **Single effective sender:** at most one instance can make the venue accept actions for a logical session/authority.
4. **Recoverable intent:** every externally attempted action has a stable identity and enough committed intent to reconcile it.
5. **Prefix recovery:** restart applies one validated checkpoint plus one validated, ordered journal prefix—never selected records after a corrupt gap.
6. **Risk-reduction availability:** cancel, mass-cancel, or halt paths do not depend on the failed component they are intended to mitigate.
7. **Controlled resume:** a halt or failover does not return directly to normal trading; reconciliation and explicit readiness precede new exposure.

Safety is distinct from liveness. A system that rejects every order preserves many safety invariants but provides no trading service. Recovery-time objective (RTO) and recovery-point objective (RPO) are scoped liveness/data-loss targets, not proofs:

- **RPO:** how much committed information may be lost under a named failure, such as process crash versus total-site loss?
- **RTO:** how long until a named service returns to a named safe state, such as cancel-only versus full trading?

Measure them under the declared fault. Do not advertise one RTO for process restart, host loss, venue outage, and regional disaster.

### Label the source of every rule

| Label | Scope |
|---|---|
| **S — standard** | ISO C++23 semantics, such as atomic visibility; no persistence guarantee |
| **O — OS/storage** | filesystem, system-call, block-device, and error-reporting contract |
| **P — protocol** | session/order protocol rule for a named specification and version |
| **V — venue** | venue rulebook, session configuration, and operational behavior |
| **R — regulatory** | jurisdiction, entity, product, and activity-specific obligation |
| **PV — product/version** | implementation release, deployment configuration, and feature behavior |
| **M — measured** | result with a fault, workload, topology, version, and statistic |

“Duplicate client IDs are rejected,” “disconnect cancels orders,” “one login fences another,” and “mass cancel is atomic” are never generic guarantees. They require **P/V/PV** evidence. Regulatory examples in §56.11 are orientation, not legal advice or a substitute for a firm’s compliance interpretation.

---

## 56.2 Pre-Trade Risk Is a Reservation State Machine — Core

Pre-trade risk is not a list of pure predicates. It is a transaction over shared capacity:

```text
PROPOSED
   │ validate inputs, policy, limits
   ▼
RESERVED ── local failure before send ──► OUTCOME_UNKNOWN
   │ send attempt
   ▼
SENT_UNKNOWN ── venue reject ───────────► TERMINAL / release
   │              │
   │              └─ cancel ack ────────► TERMINAL / release remainder
   ▼
ACKED_LIVE ── partial fills ────────────► LIVE_REMAINDER
   │                                        │
   └──────── full fill / cancel / expiry ───┘──► TERMINAL
```

The reservation is the critical commit point. Two gateways that both read “60 units available” and each send 60 can consume 120 unless the check and reservation are serialized, atomically combined, or backed by disjoint budgets. A later asynchronous risk service cannot undo an execution.

The state for a decision includes more than filled position:

\[
\text{worst-case exposure}
=\text{filled position}
+\text{working exposure}
+\text{pending exposure}
+\text{ambiguous exposure}
\]

The exact aggregation depends on side, instrument, product, offsetting rules, contract multipliers, currencies, and credit agreement. Conservative does not mean “add every absolute value forever”; it means the netting model is explicit, approved, and never assumes a favorable unconfirmed outcome.

### A bounded control pipeline

Order checks should be local, deterministic, bounded, and ordered from cheapest structural rejection to state mutation:

1. **Authority and mode:** session authorized; strategy/instrument enabled; not killed.
2. **Shape:** side, order type, time-in-force, quantity, tick alignment, and protocol fields valid.
3. **Data validity:** instrument metadata and reference price have the required version and freshness.
4. **Per-order bounds:** maximum quantity, price collar, order notional, and venue/product constraints.
5. **Aggregate bounds:** position, working quantity/notional, credit/capital, strategy/account/firm limits.
6. **Behavioral bounds:** message rate, order/cancel ratio, repeated executions, and duplicate identity.
7. **Reservation:** atomically consume the approved capacity and record the policy generation.
8. **Journal/send:** enter the reliability state machine in §§56.5–56.7.

The ordering is not a license to omit later checks for latency. It avoids expensive shared-state work for malformed input and makes rejection attribution stable.

### Controls and failure behavior

| Control | Threat | Required input | If input is uncertain |
|---|---|---|---|
| Maximum order quantity | unit/decimal/fat-finger error | normalized quantity and instrument units | reject new order |
| Price collar | absurd or stale strategy price | fresh approved reference, tick table, side | reject or restrict risk-increasing order |
| Order notional | large price × quantity exposure | price, quantity, multiplier, currency/FX policy | reject if value cannot be bounded |
| Position/open-order limit | aggregate exposure | fills plus reservations and ambiguous tail | retain worst-case reservation |
| Credit/capital limit | firm/customer financial exposure | aggregate authoritative allocation | reject when unavailable or exhausted |
| Message/rate limit | runaway strategy or venue throttle | monotonic event/window state | stop/throttle new actions by policy |
| Duplicate protection | replay/retry emits same intent twice | stable client identity and protocol semantics | do not invent a new ID until reconciled |
| Self-trade prevention | own orders cross | common ownership/group and working-order view | apply local policy plus named venue feature |

Venue-side controls are defense in depth, not a substitute for firm controls. Their scope, latency, identifiers, netting, and reject behavior are **V/PV**. A venue may protect its market while still allowing a firm to exceed an internal strategy or portfolio limit.

### Price collars need a validity state

A price collar is only as trustworthy as its reference. A useful reference object contains:

```text
price | source | market-state | receive sequence | as-of time | validity
```

The policy must say which market states are valid, how staleness is measured, whether a crossed/locked book is accepted, what fallback source is allowed, and whether buys and sells use symmetric bands. A passive buy far below the market and an aggressive buy far above it do not create the same immediate-execution risk.

Avoid floating-point percentages on the critical path when exact tick/fixed-point policy is required. Convert approved parameters into integer ticks or fixed-point units before activation. Chapter 55 owns hot-path enforcement mechanics; this chapter owns the invariant and state transition.

---

## 56.3 Compact C++23 Reservation Model — Core

This example is intentionally single-writer. It uses positive integer price ticks and quantities, checks multiplication before computing notional, and mutates state only after all predicates pass. `Limits` is assumed to have been validated off-path as nonnegative and internally consistent, while `RiskState` must already satisfy its invariants. It is a model, not a complete portfolio margin engine.

```cpp
#include <cassert>
#include <cstdint>

enum class Side { buy, sell };
enum class Result { accepted, disabled, shape, price, notional,
                    position, aggregate };

struct Order {
    Side side;
    std::int64_t qty, price_ticks, reference_ticks;
};
struct Limits {
    std::int64_t max_qty, max_price_move, max_order_notional;
    std::int64_t max_open_notional, max_abs_position;
};
struct RiskState {
    std::int64_t position{}, open_notional{};
    std::uint64_t policy_generation{};
    bool new_orders_enabled{true};
};

constexpr Result reserve(const Order& o, const Limits& l,
                         RiskState& s) noexcept {
    if (!s.new_orders_enabled) return Result::disabled;
    if (s.open_notional < 0 || s.open_notional > l.max_open_notional ||
        s.position < -l.max_abs_position ||
        s.position > l.max_abs_position) return Result::aggregate;
    if (o.qty <= 0 || o.price_ticks <= 0 || o.reference_ticks <= 0 ||
        o.qty > l.max_qty) return Result::shape;

    const auto move = o.price_ticks >= o.reference_ticks
        ? o.price_ticks - o.reference_ticks
        : o.reference_ticks - o.price_ticks;
    if (move > l.max_price_move) return Result::price;

    if (o.qty > l.max_order_notional / o.price_ticks)
        return Result::notional;
    const auto notional = o.qty * o.price_ticks;
    if (notional > l.max_order_notional)
        return Result::notional;
    if (notional > l.max_open_notional - s.open_notional)
        return Result::aggregate;

    if (o.qty > l.max_abs_position) return Result::position;
    if (o.side == Side::buy &&
        s.position > l.max_abs_position - o.qty) return Result::position;
    if (o.side == Side::sell &&
        s.position < -l.max_abs_position + o.qty) return Result::position;

    s.open_notional += notional; // reservation commits here
    return Result::accepted;
}

int main() {
    constexpr Limits limits{1'000, 10, 100'000, 200'000, 2'000};
    RiskState state{0, 0, 42, true};
    assert(reserve({Side::buy, 100, 100, 95}, limits, state)
           == Result::accepted);
    assert(state.open_notional == 10'000);
    assert(reserve({Side::buy, 1'001, 100, 100}, limits, state)
           == Result::shape);
}
```

Production code needs checked addition/subtraction for every unit, contract multipliers, currency conversion, side-specific working quantities, and policy validation. It must also return a reservation identity. Venue rejects and confirmed cancels release the appropriate remainder; fills convert reserved working exposure into filled position/exposure without creating a gap. An ambiguous order keeps its reservation.

Concurrency changes the proof. A mutex can make check-plus-reserve atomic but may add contention. A single-writer gateway can serialize decisions naturally. Partitioned sub-limits remove coordination from the hot path but can strand capacity and require a safe rebalance protocol. A centralized atomic counter may serialize cache traffic and still be insufficient for multi-dimensional limits. Choose from the aggregate invariant outward, then measure.

### Risk-state generations

Every reservation should carry:

- stable order/intent identity;
- policy generation and instrument-data generation;
- quantity, price, multiplier/currency inputs;
- consumed limit buckets; and
- lifecycle state and last authoritative event.

Changing a limit is not an in-place edit of unrelated fields. Build and validate a complete immutable policy generation, then activate it atomically. Existing orders retain their original decision evidence but are evaluated against the new aggregate policy for remediation. Whether a lowered limit grandfatheres existing orders, triggers cancels, or enters cancel-only is a documented product/compliance decision.

---

## 56.4 Runtime Controls, Kill States, and Venue Features — Core

Pre-trade checks bound individual decisions. Runtime controls detect behavior that is locally valid but globally dangerous:

- order, cancel, replace, reject, and execution rates;
- position and notional velocity;
- repeated identical decisions;
- fill ratio, reject ratio, and cancel-to-order behavior;
- market-data staleness/gaps and reference divergence;
- loss, drawdown, and strategy-specific model-health signals; and
- queue depth and risk-decision latency.

Thresholds require an owner, scope, observation window, market-state treatment, and response. No universal “orders per second” or drawdown value is safe across products and firms.

### Kill is a state machine, not a Boolean

```text
RUNNING
  │ operator/control trigger
  ▼
CANCEL_ONLY ── send scoped cancels/mass-cancel ──► HALTED
  ▲                                                  │
  │ more fills/cancel rejects                        │ reconcile venue,
  └──────────────────────────────────────────────────┤ position, journal,
                                                     │ risk/config
                                                     ▼
                                                RECOVERING
                                                     │ authorized resume
                                                     └────────► RUNNING
```

At the transition to `CANCEL_ONLY`, new risk-increasing actions stop before cancellation begins. Cancels and other approved risk-reducing actions remain permitted. `HALTED` does not mean flat: fills can race cancels, cancel requests can be rejected, a venue may be unreachable, and hidden/conditional orders may have venue-specific behavior. The system must continue consuming executions and updating risk while halted.

A kill operation needs explicit scope: one order, strategy, instrument, account, session, venue, or firm. The trigger path should be independent of the strategy process when practical, authenticated and authorized, observable, and repeatedly exercised. Resume is a separate privilege and transition; clearing an alarm must not resume trading automatically.

### Mass cancel

Mass cancel is a protocol command or a set of individual cancels, depending on **P/V/PV**. Define:

- scope selection and exclusions;
- whether the venue acknowledges receipt, acceptance, or completion;
- how partial failures are reported;
- whether new orders can race the operation;
- what happens on disconnect;
- how working orders are enumerated afterward; and
- the fallback when the mass-cancel channel is unavailable.

Never state “disconnect cancels all” unless the named venue/session has cancel-on-disconnect configured and tested. Even then, reconcile; a network partition can make the local side believe it disconnected before the venue detects it.

### Self-trade and duplicates

Self-trade prevention (STP) may reject the aggressor, cancel the resting order, cancel both, decrement quantity, or apply another venue-specific rule. It may be scoped by account, group, session, or identifier. Local STP can react earlier and use the firm’s ownership model; venue STP remains defense in depth. Neither replaces position/credit controls.

Duplicate-order protection begins with a stable intent/client order identity that survives retries and replay. Whether a venue rejects reuse, for how long, and across which session reset is **P/V**. Locally, a duplicate identity should retrieve the existing lifecycle rather than allocate a new identity and send a second order.

### Fail-open versus fail-closed

“Fail closed” is too coarse unless the action is named:

| Dependency uncertainty | New exposure | Cancel/risk reduction | Received execution |
|---|---|---|---|
| Risk state unavailable | block | permit through independent safe path | process and reserve conservatively |
| Market/reference stale | block affected strategy/instrument | permit | process |
| Logger/telemetry impaired | follow approved audit/degradation policy | permit | never discard silently |
| Duplicate cache saturated | block or reconcile new intent | permit identified cancel | process; do not drop a possible fill |
| Venue status unavailable | cancel-only or halt | attempt and retain ambiguity | consume any authoritative channel available |

Risk-reducing is not synonymous with “sell.” A sell can increase a short position; a buy can reduce one. Classify against current and ambiguous exposure.

---

## 56.5 Commit Points: Visible, Durable, Replicated, External — Core

The word **committed** is meaningless without a failure domain.

| Point | What it establishes | What it does not establish |
|---|---|---|
| C0: record bytes copied | writer memory changed | complete publication or crash recovery |
| C1: length/status release-published | an acquiring memory reader can observe initialized bytes under the C++ memory model (**S**) | page-cache flush, persistent ordering, power-loss survival |
| C2: OS/storage sync reports success | durability promised by the named OS/filesystem/device contract (**O/PV**) | survival of unmodeled firmware/device faults or another host failure |
| C3: replica acknowledges according to protocol | named replica/quorum has reached its specified state (**P/PV**) | local disk durability unless protocol says so |
| C4: venue accepts protocol message | venue session has accepted/processed a named message stage (**P/V**) | local recoverability or execution outcome unless response says so |
| C5: execution/cancel state reconciled | external authoritative state incorporated locally | permanence of that evidence unless journaled to the required point |

A release store of record length is useful for an in-memory single-writer/multiple-reader protocol. It prevents a conforming acquire reader from seeing the published marker before earlier initialized bytes. It says nothing about storage-controller order, filesystem metadata, or power failure.

Likewise, a buffered `write()` can make data visible through the page cache without placing it in the intended persistence domain. On Linux, `fsync`/`fdatasync` and block-layer flush/FUA behavior participate in persistence, but filesystem, device cache, error reporting, file creation, and directory-entry semantics matter. Check return values and delayed writeback errors. A checkpoint published by temporary-file rename commonly needs data sync before rename and directory sync afterward on Linux; confirm the exact filesystem contract instead of treating the recipe as ISO C++.

### Local sync versus replication

Neither is universally superior:

| Choice | Failure domain addressed | Cost/complexity introduced | Question to answer |
|---|---|---|---|
| Batched local sync | process/OS crash and, under contract, host power loss | storage latency, batching window, device/filesystem reliance | which records may be acknowledged before the batch sync? |
| Synchronous replica | selected host/device failure | network/replica latency, fencing, replica consistency | what exact state does replica ACK mean? |
| Local sync + replica | broader combined failures | both paths and correlated-failure analysis | must both complete before acknowledgement? |
| Asynchronous replica | improves recovery options | nonzero replication lag | how are orphan/ambiguous actions reconciled? |

The answer is a policy with an RPO, acknowledgement boundary, and measured distribution. “The network is faster than storage” is not a correctness argument and is not consistently true across products/configurations.

---

## 56.6 Journal, Checkpoint, and Replay Recovery — Core

A trading journal is an append-only sequence of facts needed to reconstruct decisions and external ambiguity. It is not automatically an audit record satisfying every regulatory retention rule; that is **R/PV** scope.

Useful records include:

- inbound protocol events with session sequence and raw/normalized identity;
- order intents, risk reservations, and policy generation;
- outbound send attempts with stable client identity;
- acknowledgements, rejects, fills, cancel events, and reconciliation facts;
- limit/config activation, kill transitions, and operator/control identity; and
- nondeterministic inputs that affect decisions, such as approved clock events or random draws.

Do not journal every derived object if deterministic replay can reconstruct it; do journal every input that would otherwise be re-read differently.

### Record and batch structure

A recoverable format typically contains:

```text
record: magic | format version | type | length | logical sequence
        | policy/session generation | payload | record CRC

batch commit: first sequence | last sequence | record count
              | byte count | batch digest/CRC | commit marker
```

CRC detects accidental corruption; it is not a cryptographic authenticity guarantee and has a residual collision probability. Lengths are bounded before allocation or indexing. Sequence must be monotonic according to the journal’s ordering model. Recovery stops at the first incomplete, invalid, or uncommitted tail. Skipping a bad middle record and applying later state destroys prefix semantics.

The recoverable prefix is not “everything the scanner can parse.” It is the last batch whose records and commit metadata validate and whose required persistence/replication acknowledgement completed. Keep the durable watermark separately observable.

### Checkpoint invariant

A checkpoint at logical sequence \(P\) must equal the state produced by applying every committed event through the documented boundary at \(P\), and none after it. Store:

- format and schema version;
- logical sequence/journal offset and policy/session generations;
- complete risk, order, position, and strategy state needed for replay;
- length/count and checksum/digest; and
- creation and commit metadata.

Write a new checkpoint without overwriting the last known-good copy. Validate it before making it current. Keep a fallback according to recovery policy. Snapshot mechanics—copy, double-buffer, COW, or replica-generated—have different latency and consistency costs; Chapter 60 owns deployment/storage lifecycle, not this chapter.

### Recovery state machine

```text
OFFLINE
  ▼
LOAD_CHECKPOINT ── invalid ──► try approved fallback / remain halted
  ▼
REPLAY_PREFIX ── corrupt gap ─► remain halted with evidence
  ▼
MARK_AMBIGUOUS_TAIL
  ▼
FENCE_OLD_SENDER
  ▼
RECONCILE_VENUE + DROP COPY/POSITION + SESSION
  ▼
RECOMPUTE_RISK
  ▼
CANCEL_ONLY
  ▼ authorized readiness
RUNNING
```

Replay should feed the same deterministic state reducer used live, while suppressing external effects. A separate “simplified recovery mutation” path will eventually diverge. Outputs generated during replay are evidence to compare, not instructions to resend blindly.

Startup time depends on checkpoint age, journal volume, validation, session recovery, and authoritative queries. Set RTO separately for “state reconstructed,” “cancels possible,” and “new orders permitted.” Chapter 57 owns the deterministic and fault-injection test mechanics.

---

## 56.7 Worked Failure: The Venue Filled During the Crash — Core

Assume a gateway has stable client order ID `C123`, a single-writer risk state, and a journal policy requiring local durable batch commit before send. The venue protocol does not provide a transactional “write journal and place order” operation.

### Timeline

```text
t0  Strategy proposes Buy 100.
t1  Risk reserves worst-case 100 and records policy generation 42.
t2  PREPARED(C123, qty=100, generation=42) reaches local durable commit.
t3  Gateway invokes network send for C123.
t4  Venue accepts and immediately fills 60; 40 remains live.
t5  Execution response is in flight.
t6  Host loses power before response or SEND/FILL state reaches durable journal.
```

On restart, the journal proves intent and reservation. It does **not** prove whether the send crossed the network, whether the venue accepted it, or whether it filled. Re-sending as a new ID could double exposure. Releasing the reservation could understate exposure. Assuming the venue rejected is unsafe.

Recovery does this:

1. Load a validated checkpoint and replay the committed prefix.
2. Reconstruct `C123` as outcome-unknown and keep all 100 units reserved.
3. Fence the previous sender using a mechanism effective at the venue/session or network resource.
4. Recover protocol sequence state according to the named session version.
5. Query/open-order status and consume an authoritative execution/drop-copy source.
6. Learn that 60 filled and 40 remains working.
7. Journal that reconciliation fact to the required commit point.
8. Convert 60 reserved units to filled position, retain 40 as working exposure, and remain cancel-only until all differences are resolved.

### Failure-window table

| Crash window | Local evidence | Possible external state | Recovery rule |
|---|---|---|---|
| Before reservation/journal commit | no committed intent | no send if program obeyed ordering | do not generate order from absent intent |
| After commit, before send code | prepared intent | normally unsent, but use exact state marker carefully | replay as prepared; policy decides whether to abandon/query |
| During/after send, before venue response | prepared/send-attempt evidence | absent, rejected, live, partial, or filled | mark ambiguous; query/reconcile |
| Response received, before durable journal | local memory may know more than journal | venue state ahead of recovery state | external authority repairs journal/state |
| After durable terminal record | committed terminal evidence | should match, but venue corrections remain possible | replay, then reconcile/correct |

A `SEND_ATTEMPT` record before the system call proves that a send might occur; one after it proves only that the call returned, not that the venue accepted. A stable ID can make retry safer only under the named venue’s duplicate semantics. There is no universal exactly-once guarantee across this boundary.

### Sequence checkpoints

Protocol inbound/outbound sequence numbers and journal logical sequence solve different ordering problems. Persist them with the event that makes them meaningful. A checkpoint claiming outbound session sequence \(N\) must include exactly the order/session state through that boundary. After recovery, negotiate/resend according to **P/V**, not by setting a counter to the peer’s apparent value and continuing.

---

## 56.8 High Availability, Fencing, and Convergence — Core

Active-passive redundancy reduces recovery work only when the passive is valid, current enough for the declared RPO, and unable to trade until promotion preconditions hold. “Hot standby” has no universal lag or failover time.

### Node state machine

```text
OFFLINE → RECOVERING → STANDBY → CANDIDATE → FENCING → RECONCILING
                                                       │
                                                       ▼
                                                    ACTIVE
                                                       │
                                  fault/kill ──────────┴─► CANCEL_ONLY/FENCED
```

Promotion requires all of the following:

- a validated checkpoint/journal prefix and known replication watermark;
- current approved risk/config generation;
- an effective fence against the old sender;
- recovered protocol/session sequence state;
- authoritative order/execution/position reconciliation;
- acceptable market/reference-data validity; and
- an explicit transition through cancel-only/readiness before new exposure.

A heartbeat timeout can move `STANDBY` to `CANDIDATE`; it cannot move it directly to `ACTIVE`.

### Fencing is enforced by the resource

A monotonically increasing fencing epoch works only if every action reaches a resource that remembers the highest epoch and rejects stale epochs. Checking “am I leader?” inside the old process leaves a pause between check and send.

Trading resources do not all accept application fencing epochs. Alternatives include:

- a venue/session rule that enforces one effective login, if the named protocol and configuration guarantee it;
- gateway/network ACL or credential revocation;
- an intermediary risk/order service that validates epochs;
- storage ownership for journal writers, which does not by itself fence venue traffic; or
- decisive host isolation/power fencing under an operational runbook.

Leases and quorum election belong to Chapters 68–74. This chapter’s requirement is the interface: promotion supplies exclusive authority that the side-effecting resource can enforce. A lease without bounded clock/delay assumptions or a downstream fence is not proof.

### Heartbeats detect lack of progress

Observe a monotonic progress sequence or completed-work watermark, not merely process existence. The observer must not share every failure mode with the worker. Thresholds come from measured progress distributions and required reaction time; there is no universal millisecond setting. Define false-positive behavior: a watchdog that kills a healthy active can create the failover it was meant to prevent.

Layer watchdogs by failure domain:

- an in-process observer can detect a stalled event loop quickly but dies with the process;
- an external supervisor can detect process exit or lost progress but may share the host/kernel;
- a remote control plane can observe host or network loss but must not infer which side of a partition failed; and
- a hardware watchdog may reset a wedged host, but reset is not proof that venue orders were cancelled.

The watched value should represent meaningful progress, such as “highest input sequence fully applied and risk state published,” not a timer callback that can run while the trading loop is deadlocked. Publish enough context to distinguish idle-by-design from unable-to-progress.

Escalation is a separate policy:

```text
progress late → mark unhealthy / stop new risk
              → attempt independent cancel or fence
              → preserve evidence
              → restart or promote only through recovery state
```

Avoid a watchdog action that depends on the stalled queue, allocator, logger, or risk service. Pre-establish the control channel and authorization. A missed threshold can be noisy; fencing and cancel state must be idempotent because multiple watchdog layers may fire for one incident.

### Convergence

After fencing:

1. drain/validate the committed or replicated journal prefix;
2. recover the venue session under protocol rules;
3. obtain live orders and authoritative executions/positions from available venue/drop-copy/clearing sources;
4. compare external truth with replayed belief;
5. adopt and conservatively reserve unknown live orders;
6. apply missing fills/corrections;
7. cancel or take ownership of unmanaged exposure;
8. recompute aggregate risk from base facts; and
9. produce a reconciliation report before controlled resume.

The passive may share the active’s software defect, bad input, or configuration. Redundancy improves only the failure domains actually separated—power, host, network, software release, data source, operator authority, or site. State those domains in every HA claim.

---

## 56.9 Capacity, Watermarks, and Graceful Degradation — Core

A bounded queue turns unbounded memory growth into an explicit decision. Capacity must be derived from burst shape and service rate, while maximum acceptable age limits how much queueing is useful.

For a single stage over a time interval:

\[
\Delta Q=\max(0,(\lambda-\mu)T)
\]

where \(\lambda\) is arrival rate, \(\mu\) is service rate, and \(T\) is burst duration. This fluid approximation ignores per-event variance and scheduling but gives a first bound.

### Worked burst

Illustrative assumptions:

- consumer capacity \(\mu=400{,}000\) events/s;
- burst arrivals \(\lambda=550{,}000\) events/s for 40 ms;
- bounded queue capacity 8,192 events; and
- post-burst arrival rate 200,000 events/s.

Backlog added:

\[
(550{,}000-400{,}000)\times0.040=6{,}000
\]

The queue retains 2,192 slots. If the excess rate continued, nominal time to exhaustion would be:

\[
2{,}192/150{,}000\approx14.6\text{ ms}
\]

After the burst, net drain rate is 200,000/s, so the 6,000-event backlog takes about 30 ms to drain. If decisions are invalid when 10 ms old, an 8,192-slot queue is not a safety solution: the product needs staleness rejection or earlier degradation.

Choose a warning threshold from response time:

\[
Q_{\text{alarm}}
\le C-(\lambda-\mu)T_{\text{reaction}}-\text{margin}
\]

Percentages such as 75% or 90% are presentation choices, not universal thresholds.

Monitor current depth, high-water mark, time above thresholds, age of oldest item, enqueue/dequeue rates, and drops/rejections by reason. Correlate software queues with NIC, transport, venue, and downstream counters so backpressure is not mistaken for losslessness.

### Degradation state machine

```text
NORMAL → GUARDED → CANCEL_ONLY → HALTED → RECOVERING → NORMAL
```

Each transition has entry criteria, allowed actions, exit criteria, authority, and minimum evidence. Examples:

| Mode | Allowed | Suppressed | Key invariant |
|---|---|---|---|
| Normal | approved trading | none by mode | full controls valid |
| Guarded | selected strategies/instruments, cancels | optional analytics or lower-priority new risk | critical freshness preserved |
| Cancel-only | cancels and explicitly risk-reducing actions | all new risk | exposure cannot intentionally grow |
| Halted | state ingestion, reconciliation, emergency controls | outbound trading except approved emergency action | system remains aware of fills |
| Recovering | replay, query, validation, cancels as allowed | new exposure | no resume before convergence |

Load shedding must preserve semantic consistency. Dropping arbitrary market updates creates an unknown partial book; dropping fills corrupts risk. Optional telemetry may be sampled only if product/regulatory audit requirements permit it. Prefer rejecting stale strategy work before it becomes an order, and preserve raw evidence needed for reconciliation.

Use hysteresis and dwell time where signals are noisy, but derive them from the control’s dynamics. The degradation path must avoid the failed dependency: a cancel-only transition that asks an unavailable risk service for permission is not a safe path.

---

## 56.10 Operational Safety and Change Control — Core

Reliability controls fail operationally when nobody can tell which state they are in, change them safely, or reconstruct who acted.

### Versioned control activation

A risk policy is an immutable validated object:

```text
policy generation
| instrument/reference-data generation
| limit units and scopes
| activation time/event
| author/approver identities
| reason/change ticket
| checksum/signature as required
```

Build off-path, validate cross-field invariants, distribute, verify receipt, and activate one generation atomically. A decision records the generation it used. Partial updates such as “new quantity limit with old multiplier” are invalid states.

Configuration authority, approval separation, emergency override, and retention are firm/regulatory decisions. Do not claim that two-person approval is universal; do make unauthorized or unaudited limit mutation impossible by design.

### Operational controls

- **Independent kill access:** responders can halt a strategy/session even if its main UI or process is unhealthy.
- **Scoped actions:** prefer the narrowest safe kill, but preserve a decisive firm/session-level control.
- **Acknowledged commands:** distinguish request issued, component received, venue accepted, and reconciliation complete.
- **Monotonic incident state:** a restart cannot clear a kill merely because memory reset.
- **Actionable alarms:** include scope, state generation, oldest queue age, ambiguous orders, and the next safe action.
- **Evidence preservation:** journal/checkpoint/config/reconciliation artifacts have stable identities and timestamps.
- **Resume checklist:** fence, external state, positions, orders, risk utilization, data freshness, config version, and authority all pass.

Deployment, rollback, draining, and artifact lifecycle belong to Chapter 60. Test portfolios, deterministic replay tests, fault injection, and hardware-in-loop mechanics belong to Chapter 57. This chapter supplies their state machines, failure points, and oracles.

### Regulatory and venue labels

Regulation depends on jurisdiction, entity role, product, and activity. Two primary examples illustrate why controls must be mapped rather than guessed:

- U.S. SEC Rule 15c3-5 guidance describes market-access controls for covered broker-dealers, including aggregate credit/capital thresholds and controls against erroneous price/size or duplicative orders. See the [SEC’s official FAQ](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/divisionsmarketregfaq-0). This is **R: U.S. securities market access**, not a universal specification for every trading firm.
- EU Commission Delegated Regulation (EU) 2017/589 includes requirements concerning algorithmic-trading limits and kill functionality for firms in its scope. See the [official EUR-Lex text](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32017R0589). This is **R: EU/MiFID II scope**, subject to current legal interpretation and firm circumstances.

Venue rulebooks and protocol specifications then define available mass-cancel, duplicate, STP, drop-copy, session, and cancel-on-disconnect behavior. Record venue, market, protocol version, session configuration, and effective date. A product feature helps satisfy a control objective only after its semantics and failure modes are mapped to that obligation.

---

## 56.11 Reference Tables — Skippable

### Acknowledgement policy worksheet

For each message or state transition, fill every column:

| Event | Identity | Memory publish | Local durable point | Replica point | External point | Allowed acknowledgement | Recovery if tail is missing |
|---|---|---|---|---|---|---|---|
| Risk reservation | order intent ID | generation/sequence | policy-defined journal commit | optional/required by design | none | to strategy only after named point | recreate reservation from committed intent |
| Order send | stable client ID | send state | before/after attempt as defined | named replica watermark | venue session response | never call “executed” without execution evidence | mark ambiguous and reconcile |
| Fill | venue execution ID | position update | journal commit per policy | replica/drop copy as designed | venue/drop-copy truth | downstream update at named point | replay/deduplicate by execution identity |
| Kill transition | incident/control ID | mode visible | persistent control state | independent control plane if used | cancel acknowledgements are separate | report requested/active/reconciled separately | restart remains killed |
| Limit activation | policy generation | atomic pointer/generation | config/audit commit | distribution acknowledgement | regulatory/venue approval if applicable | activate only after validation policy | load last approved complete generation |

This worksheet exposes vague words. “Acked” must identify the column.

### Recovery discrepancy matrix

| Replayed belief | External evidence | Conservative action |
|---|---|---|
| working order | matching live order | adopt and retain reservation |
| working order | no live order, no terminal evidence | keep ambiguity until protocol/venue resolution |
| unknown order | live external order | adopt as unmanaged; reserve and cancel/manage |
| terminal reject/cancel | live order | incident: external truth wins; reserve and remediate |
| no fill | execution/drop-copy fill | deduplicate, journal, update position/risk |
| fill locally | missing from one external query | do not reverse from absence alone; use authoritative correction process |
| limits differ | approved generation identified | remain cancel-only until one complete policy is selected |

### Control ownership matrix

| Objective | Local gateway | Shared firm risk | Venue | Operations/compliance |
|---|---|---|---|---|
| Per-order shape/quantity | earliest bounded rejection | policy distribution | venue syntax/market limits | approval and review |
| Aggregate credit/position | local reservation or partition | cross-gateway authority | venue account controls may supplement | capital/credit ownership |
| Price collar | freshest approved reference | common policy | venue bands are backstop | reference/exception governance |
| Duplicate prevention | stable identity/lifecycle | cross-session correlation | named duplicate semantics | incident reconciliation |
| STP | firm ownership-aware check | cross-strategy view | venue feature per scope/version | ownership mapping |
| Kill/mass cancel | stop producer and send control | broad independent control | protocol action | authorization, verify, resume |

No single layer owns the whole safety property. Defense in depth is useful only when scopes overlap intentionally and discrepancies are observable.

---

## 56.12 Recall and Practice — Core

**Recall card.**

- Define failure model, RPO/RTO scope, and safety invariants before choosing HA machinery.
- Risk is check **plus reservation**; unknown orders remain worst-case exposure.
- Label claims: **S**, **O**, **P**, **V**, **R**, **PV**, or **M**.
- Memory publication, storage durability, replication, venue acceptance, and execution are different commit points.
- Recovery trusts a validated checkpoint plus a contiguous committed journal prefix.
- Journal-before-send narrows failure windows but cannot make venue side effects exactly once.
- Promotion requires a downstream-effective fence and external reconciliation; heartbeat loss alone is not authority.
- Kill means stop new risk, attempt cancellation, continue processing fills, reconcile, and require controlled resume.
- Queue capacity absorbs bursts only while queued decisions remain fresh.
- Regulatory and venue controls are scope/version-specific; document the mapping.

### Common traps

- Calling page-cache visibility or a release store “durable.”
- Publishing record length last and assuming that prevents storage tears after power loss.
- Saying replication is always faster/safer than `fsync` without defining ACK semantics and failure domains.
- Releasing risk reservation when an order times out locally; timeout means unknown, not rejected.
- Applying a position limit only to fills while ignoring working and ambiguous orders.
- Letting two gateways check one aggregate limit without atomic reservation or partitioned budgets.
- Promoting a standby on heartbeat timeout without fencing the old sender.
- Assuming successful standby login, duplicate rejection, cancel-on-disconnect, mass-cancel scope, or STP behavior across venues.
- Treating `HALTED` as flat and ignoring fills that race cancels.
- Dropping or delaying executions because logging, duplicate detection, or risk service is impaired.
- Using universal queue-watermark percentages, watchdog intervals, HA times, or risk limits.
- Resuming because the process restarted rather than because venue, risk, session, and data state reconciled.
- Updating related limit fields independently and creating a mixed policy generation.
- Treating venue controls as proof that firm-level regulatory or portfolio obligations are satisfied.

### Interview questions

1. What is the difference between memory-visible, locally durable, replicated, venue-accepted, and executed?
2. Why must risk checks reserve capacity before send, and how can partitioned sub-limits avoid a shared hot-path lock?
3. A send call returned but no venue response was journaled before a crash. List every possible external outcome and the safe recovery state.
4. What fields make a journal record prefix recoverable, and why must replay stop rather than skip after a corrupt middle record?
5. Why is a missed heartbeat insufficient for promotion, and where must a fencing token or equivalent control be enforced?
6. Explain why a sell order is not always risk-reducing and how that affects fail-open policy.
7. A kill switch was triggered and every cancel request was accepted. Why can the system still have exposure?
8. Derive the 6,000-event backlog and 14.6 ms exhaustion horizon in §56.9. Which assumptions make the model optimistic?
9. How should a policy-generation change interact with existing working orders and an in-progress failover?
10. Compare synchronous local durability, synchronous replication, and asynchronous replication without declaring one universally best.

### Puzzle: two safe gateways make an unsafe firm

The firm limit is 100 contracts. Gateways A and B each read aggregate usage 40 from a replicated risk snapshot. At the same instant, each approves a buy for 40 because \(40+40\le100\). Both orders fill, producing usage 120. Each gateway’s local check was internally correct.

Identify the violated invariant and at least three valid architectures:

- serialize check-plus-reserve through one authority;
- allocate disjoint sub-limits whose sum never exceeds 100; or
- use an atomic shared reservation service with defined partition behavior.

For each architecture, explain latency, stranded capacity, failure behavior, and how reservations are recovered after a gateway crash. “Replicate faster” is not sufficient because two stale reads can still race.

### Applied exercise

Choose one order gateway and write a failure-window ledger for:

1. strategy intent;
2. risk reservation;
3. journal publication;
4. required local/replica commit;
5. send attempt;
6. venue acknowledgement or execution;
7. local durable application; and
8. downstream position/risk publication.

At every boundary, kill the process conceptually and answer:

- what evidence survives the declared fault;
- what the venue might have done;
- which reservation remains;
- whether cancels are possible;
- which fence is required;
- which authoritative query repairs uncertainty; and
- what exact evidence permits transition from recovering to running.

Then map each invariant to a Chapter 57 test oracle and each operational transition to the Chapter 60 lifecycle that deploys, drains, rolls back, or resumes it.

**Prerequisite for Chapter 57.** Be able to express reliability and risk as explicit state machines with invariants, commit points, ambiguous windows, and authoritative recovery evidence. Chapter 57 turns those into model, replay, concurrency, and fault-injection tests.
