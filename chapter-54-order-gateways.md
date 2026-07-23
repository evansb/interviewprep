# Chapter 54 — Order Gateways

## Why this matters

An order gateway is the last component under the firm’s control before an instruction can create venue exposure. It owns more than serialization and a socket. It must decide whether the session may send, assign durable identities, correlate every response, survive duplicates and gaps, preserve uncertainty after a disconnect, and reconcile its model with external evidence.

The central difficulty is an information boundary. After bytes may have left the process but before an authoritative venue response arrives, the gateway cannot infer whether an order was accepted, rejected, filled, or never received. A timeout does not resolve that ambiguity. Correct gateways represent it, fence new exposure when necessary, and recover through protocol-defined replay, queries, drop copy, and reconciliation.

Chapter 50 owns order types, matching, and venue lifecycle semantics. Chapter 51 owns framing, parsing, encoding, and schema evolution. This chapter assumes both and owns **gateway session and order correctness**: state machines, identifiers, idempotence, races, reconnect, throttling, and reconciliation.

All protocol names in this chapter are examples, not portable contracts. “FIX” means the FIX Session Layer plus the counterparties’ rules of engagement. “OUCH 5.0” means the named Nasdaq specification revision. Native binary and FIXP-based venues define different sequence, recovery, identifier, and cancel behavior. Pin the venue, market, session type, schema/version, and effective date in every implementation decision.

---

## 90-second screen — Core

- Session state answers **whether and how messages may flow**. Order state answers **what the venue may have done**. Reconnecting a session does not make orders known.
- A successful socket write is not venue acceptance. An acknowledgement is not proof that an order is still live: it may already have partially or fully filled.
- Assign a stable internal order handle and protocol idempotency key before any send attempt. Never recycle either until the venue’s replay, late-message, correction, and reconciliation windows are closed.
- Model the venue lifecycle separately from outstanding commands. An order can be working while a cancel is pending, fill while that cancel is pending, and finish before a cancel reject arrives.
- Process delivery as at least once: classify session duplicates, deduplicate business events by their specified identity, and make every state mutation and downstream side effect idempotent.
- After disconnect, preserve each order’s last confirmed facts and mark unresolved effects unknown. Resume/replay where the protocol supports it; query and reconcile where it does not.
- Rate limits and cancel-on-disconnect are venue/session/version contracts. A local cancel reserve cannot bypass an exchange quota, and cancel-on-disconnect does not prove that no fill occurred.

Be ready to defend:

1. At which exact event does the gateway promise the strategy “accepted locally,” “sent,” “accepted by venue,” and “no longer live”?
2. What safe action follows a disconnect at each point from “definitely not sent” through “execution may already have occurred”?

---

## 54.1 Gateway responsibilities, trust boundaries, and invariants — Core

The gateway sits between internal intent and an external authority:

```text
strategy
   |
   | order intent + risk authorization
   v
order gateway
   |  admission -> identity -> encode -> sequence -> send
   |  receive -> validate -> correlate -> reduce -> publish
   v
venue order-entry session
   |
   +---- independent evidence: drop copy / status / trade files
```

The strategy owns desired behavior. The risk service owns the firm’s authorization policy. The venue owns whether an order exists and what traded. The gateway owns an auditable translation between them; it must not turn transport success into venue truth or local timeout into rejection.

### Non-negotiable invariants

1. **One owner mutates a session’s protocol state.** This gives a total order for outbound sequence assignment, inbound processing, throttling, and order transitions.
2. **Every send attempt is correlatable before bytes may leave.** The internal handle and client request identifier already exist and are recorded.
3. **Confirmed facts never become guesses.** A known fill remains a fill across disconnect; an unacknowledged new remains unknown until authoritative evidence resolves it.
4. **Quantities reconcile.** For ordinary execution flow, `0 <= cumulative <= accepted quantity`; remaining quantity and terminal status must agree with the venue’s protocol semantics.
5. **Duplicate input cannot duplicate a business effect.** Position, risk reservation, strategy notification, and journal publication are covered—not only the in-memory order object.
6. **No new exposure while recovery is incomplete unless a documented degraded mode authorizes it.** The decision belongs to risk policy, not a reconnect callback.
7. **External evidence is never discarded because it contradicts memory.** An unknown-order fill is a critical reconciliation event, not a log line to ignore.

### Commit points, not vague “success”

Use distinct acknowledgements internally:

| Gateway event | Defensible statement | Statement not yet defensible |
|---|---|---|
| Intent rejected before admission | Gateway will not send this intent | Nothing about prior related orders |
| Intent admitted and ID allocated | Gateway owns a request record | Venue received it |
| Bytes queued/written to transport | A send attempt occurred | Venue parsed or accepted it |
| Venue new-order acceptance | Venue accepted according to that report | Order is still unfilled/live now |
| Venue execution report | Reported quantity traded | Every independent feed has observed it |
| Venue cancel confirmation | Venue reports cancellation effective under its rules | No earlier execution can arrive late |
| Reconciliation closes the window | Named authorities agree for named scope/time | Future corrections are impossible |

The precise local durability point is architectural. A gateway may synchronously journal before send, replicate an admitted command to another process, or rely on venue recovery plus an asynchronous journal. Each choice creates a different crash window. Document the guarantee instead of calling all three “persisted.”

---

## 54.2 Two state machines, one owner — Core

Session state and order state interact, but neither should be encoded inside the other.

### Session state machine

```text
Disconnected
    |
    v
Connecting -> Authenticating -> Recovering -> Active
    |              |               |           |
    +--------------+---------------+-----------+
                       failure
                         |
                         v
                       Fenced

Active -> LogoutPending -> Disconnected
```

- **Disconnected:** no usable transport.
- **Connecting:** transport establishment is in progress.
- **Authenticating:** logon/establishment negotiation is incomplete.
- **Recovering:** authenticated, but sequence gaps and order uncertainty are unresolved.
- **Active:** application sends are permitted subject to risk and throttle.
- **LogoutPending:** graceful session closure is in progress; new application flow is stopped.
- **Fenced:** the gateway deliberately refuses new exposure because identity, sequence, authority, or recovery is unsafe.

Whether cancel messages are permitted during `Recovering` is a venue and risk-policy decision. Some venues accept them only after session synchronization; an alternate cancel facility may be required. “Not Active” therefore cannot be one Boolean used for every message class.

The session owner publishes a coarse state to producers, but only the owner decides admission after rechecking it. A producer can read `Active`, enqueue an intent, and race a disconnect. The consumer must validate the state and authorization again at the actual admission point.

### Trading-session logon and logout

**FIX Session Layer label:** a FIX session may span multiple transport connections. It maintains `NextNumIn` and `NextNumOut`; logon authenticates a new connection into that logical session. Sequence persistence and reset policy come from the FIX session profile and bilateral rules of engagement.

**FIXP/native label:** CME iLink 3 uses FIXP and SBE, while Nasdaq OUCH uses its own order-entry messages over a separately specified session transport. Do not copy FIX tag behavior into these protocols.

Logon must validate:

- expected peer/session identity and credentials;
- negotiated protocol/schema version;
- expected inbound/outbound sequence or recovery cursor;
- heartbeat/keepalive terms;
- trading date and environment;
- duplicate primary/secondary connection rules;
- whether the venue reports recovery complete.

The gateway remains `Recovering` until these checks and the order reconciliation gate pass. “TCP connected” and even “logon accepted” are too early for strategy order entry.

Graceful logout is a protocol exchange. For the FIX Session Layer, the initiator waits for the peer’s Logout response while resolving any required gaps before terminating the connection. Socket half-close details are transport implementation choices, not a universal FIX recipe. Logout also does **not** imply cancellation unless the venue’s rules explicitly make it do so.

### Heartbeats and liveness

Protocol keepalives detect a quiet or unresponsive peer; TCP alone may not detect a blackholed path promptly. Under FIX, outbound idleness leads to Heartbeat and inbound silence can lead to TestRequest followed by timeout, according to the configured session rules. Native protocols differ.

Use monotonic elapsed time, not wall-clock time, and track separately:

- last byte/message received;
- last valid application/session message processed;
- last message transmitted;
- outstanding test/keepalive challenge and deadline;
- local event-loop progress observed by an independent watchdog.

A heartbeat timeout identifies loss of timely communication, not its cause. The peer, network, NIC, kernel, or local thread may be responsible. Fence first; diagnose with timestamps and health evidence later.

---

## 54.3 Sequencing, sequence reset, resend, and replay — Core

Transport sequence and business identity solve different problems. A session sequence detects missing or repeated positions in one logical stream. A client order ID or execution ID determines whether a business effect is new.

### FIX Session Layer example

For FIX, each direction has an independent sequence space. The receiver compares `MsgSeqNum(34)` with `NextNumIn`:

| Comparison | Session interpretation | Safe action |
|---|---|---|
| equal | next expected message | Validate, process, then advance |
| greater | gap | Hold newer application effects; request recovery |
| lower with valid `PossDupFlag(43)=Y` | retransmission candidate | Determine whether already processed |
| lower without permitted duplicate/reset semantics | protocol error | Follow rules of engagement; usually logout/fence |

FIX retransmission uses the original sequence number and `PossDupFlag=Y`; fields such as current `SendingTime` are updated and `OrigSendingTime` identifies the original send time. `SequenceReset` with `GapFillFlag=Y` advances over a declared range. The FIX standard permits session messages—and, by counterparty agreement, application messages that will not be retransmitted—to be gap-filled. A hard reset (`GapFillFlag=N`) is exceptional because it can abandon recoverability.

`PossResend(97)` is application-layer, not session-layer, duplicate information. An application resend consumes a new session sequence and must be resolved by business identity according to the rules of engagement. Treating it as interchangeable with `PossDupFlag` is incorrect.

`NextExpectedMsgSeqNum(789)` on Logon can accelerate FIX resynchronization only when the negotiated session profile supports it. It is not a portable reconnect flag.

### Gap policy is a correctness policy

When message `N+2` arrives before missing `N+1`, do not mutate order state with `N+2` merely because parsing succeeded. Buffer within a fixed bound or stop processing and recover the range. If the bound is exceeded, fence and reconnect rather than silently drop.

When responding to a resend request:

1. retrieve the exact requested range from the outbound session store;
2. retransmit permitted application messages with protocol-correct duplicate fields;
3. gap-fill messages that the agreed profile does not retransmit;
4. keep ordinary new outbound sequencing independent from the old sequence values being replayed;
5. avoid recursive/unbounded resend work through an explicit recovery state and bounded queues.

The store’s retention, capacity, durability, and corruption policy are part of session correctness. A wrapped or missing range means the gateway cannot claim ordinary recovery; it must use the protocol’s supervised reset/reconciliation path.

### Journal, resend store, and application replay

Do not collapse three artifacts:

- **session resend store:** exact outbound wire messages indexed by session sequence;
- **gateway event journal:** admitted intents, sends, reports, and decisions used for audit/restart;
- **application replay log:** normalized events used to rebuild deterministic internal state.

They can share storage, but their contracts differ. Raw wire bytes answer “what did we send/receive?” Normalized events answer “what state transition did we apply?” A recovery procedure needs both when a parser or schema bug is possible.

For inbound messages, record enough information before acknowledging irreversible internal consumption. Applying the business effect and advancing a durable cursor need either one transaction or idempotent replay across the crash window. For outbound messages, allocate identity and record the attempted effect before the first operation that may expose bytes externally. A synchronous disk flush per order is not universally required, but the chosen persistence/replication boundary must make the remaining ambiguity recoverable.

---

## 54.4 Identity, correlation, and effective-once processing — Core

Every order needs identities for three different scopes:

```text
stable internal order handle
    |
    +-- client new-order/request IDs created by the gateway
    |
    +-- venue order ID(s) learned from responses
    |
    +-- execution/correction IDs learned from reports
```

The internal handle identifies the firm’s logical order across replacements and reconnects. A client request ID identifies one new/cancel/replace attempt. The venue order ID identifies the venue object under that protocol; it may be absent before acceptance and may or may not survive replace. Execution identity identifies one trade event or revision.

### Protocol labels

- **FIX application layer:** `ClOrdID(11)`, `OrigClOrdID(41)`, `OrderID(37)`, and `ExecID(17)` are common fields, but uniqueness scope, reuse, correction semantics, and query support come from the application version and venue rules of engagement.
- **Nasdaq OUCH 5.0 example:** `UserRefNum` is used for uniqueness/duplicate detection in that version; older OUCH versions used an Order Token. This is exactly why field names must be versioned.
- **Other native protocols:** some use a monotonic client sequence, an exchange-assigned order identifier, or a composite partition/session key. Implement the published scope exactly.

“Never reuse an ID” is a safe internal default only after defining the domain: venue, account/firm, session, trading day, protocol version, and message type. Generate enough namespace to survive failover without collision. Persist or partition ID allocation so two active gateways cannot issue the same key.

### Correlation table

The hot lookup is normally:

```text
(venue, session generation, client ID) -> internal handle
(venue, partition, exchange order ID)  -> internal handle
(venue, execution-ID scope)            -> applied execution
```

A counter-derived direct index can be excellent when the protocol permits it: mask/index, then compare the complete stored ID and generation to reject wraparound and stale traffic. Otherwise use a preallocated flat table with a measured maximum probe bound. `std::unordered_map` is not forbidden by correctness, but its node allocation, rehashing, and pointer locality are usually poor fits for a bounded single-writer hot path.

Do not recycle a terminal order immediately. Keep its identities resolvable through:

- the venue’s maximum retransmission/status window;
- the firm’s late-report and correction policy;
- drop-copy reorder delay;
- post-trade reconciliation closure;
- any outstanding cancel/replace request.

The duration is not a guessed number of seconds. It is a capacity calculation from the venue contract and observed tail, with an overflow policy that fences rather than aliases a new order onto an old identifier.

### At least once, not magical exactly once

After a send attempt and lost response, retransmitting may duplicate an accepted effect while not retransmitting may lose an unaccepted one. Transport acknowledgement alone cannot decide which occurred. Gateway correctness therefore uses:

1. stable idempotency keys recognized according to venue rules;
2. session recovery or application query;
3. exact duplicate detection where the protocol provides event identity;
4. idempotent state reduction and downstream publication;
5. external reconciliation.

Some transactional systems advertise exactly-once effects within a defined boundary. That does not make an exchange order-entry socket and the firm’s local database one atomic transaction. State the boundary rather than arguing from a slogan.

---

## 54.5 Outbound lifecycle and failure windows — Core

The outbound path is a series of commitments:

```text
intent
  -> validate/risk-authorize
  -> admit and reserve local exposure
  -> allocate stable IDs
  -> encode and journal/send-store
  -> attempt transport write
  -> receive venue response(s)
  -> reconcile reservation with accepted/fill/cancel facts
```

The gateway must publish which stage was reached. A single `bool send_order()` forces callers to guess.

| Failure window | What is known | Required posture |
|---|---|---|
| Before admission | This intent was not accepted by gateway | No venue action from this intent |
| After admission, before any possible send | Local request exists; venue cannot have this attempt if boundary is proven | Retry locally with same intent policy or reject |
| During/after send attempt, before venue response | Venue effect unknown | Keep ID reserved; do not create replacement exposure by assumption |
| New accepted, no later report | Venue accepted; current live/fill state may have advanced | Treat exposure as live/unknown until recovered |
| Cancel sent, no cancel response | Original may still be live, partly filled, canceled, or already terminal | Continue counting possible leaves; query/recover |
| Replace sent, no response | Old or new terms may govern according to venue semantics | Preserve both requested and last-confirmed terms |
| Execution reported | Quantity traded is a confirmed venue fact | Update position/risk exactly once; later bust/correct may revise it |

The hardest distinction is **definitely not sent** versus **send outcome unknown**. Proving the former requires the single session owner to record that no API capable of exposing bytes was reached. Queue residence alone is not enough if another thread can concurrently drain it.

### Risk handoff

Risk approval can go stale between check and send. The gateway should receive a bounded authorization containing enough context—account, instrument, side, quantity/notional, strategy, policy generation, and expiry—or perform the last-mile check in the same single-writer admission step.

Exposure reservation needs one owner and explicit release events:

- reserve when the gateway commits to possible new exposure;
- convert reservation into live/filled exposure on venue facts;
- release on an authoritative new-order reject;
- reduce on fills/cancels according to the risk model;
- retain conservative exposure while outcome is unknown.

A session-level reject, malformed response, or timeout is not automatically an authoritative order reject. The protocol/venue specification must identify which response proves that the business instruction was not accepted.

---

## 54.6 A race-aware order model — Core

Chapter 50 explains venue order semantics. The gateway representation must preserve them under duplicated and reordered delivery.

### Separate confirmed lifecycle from outstanding command

```text
confirmed venue lifecycle:
  PendingNew -> Working/PartFilled -> Terminal
       |              |
       +-> Rejected   +-> Terminal by fill or cancel

outstanding command:
  None <-> CancelPending
  None <-> ReplacePending
```

These axes are orthogonal. `CancelPending` does not replace `Working`; it means “last confirmed working state plus an unresolved cancel attempt.” A partial fill can update cumulative quantity while the cancel remains pending. A cancel reject resolves the command but does not by itself prove the order is working: it may say “too late,” “unknown order,” or another venue-specific reason requiring a status report.

Likewise, `ReplacePending` must preserve last-confirmed price/quantity and requested price/quantity. Venues differ on whether replace is atomic, whether it gets a new client or exchange ID, whether priority changes, and which state applies during a race. Never overwrite the confirmed terms at send time.

### Response/race table

| Observed event | Common but unsafe shortcut | Correct reduction |
|---|---|---|
| Fill before new ack | “Unknown order; drop” | Correlate by available client/venue key; a fill proves acceptance/effect |
| Duplicate fill report | Add `LastQty` again | Deduplicate by specified execution identity; use cumulative checks as defense |
| Fill while cancel pending | Cancel won, ignore fill | Apply fill; cancel effectiveness occurs only at its venue-defined commit |
| Cancel confirmation after partial fill | Restore original leaves or assume zero fills | Preserve cumulative fills; set remaining according to report semantics |
| Cancel reject | Return unconditionally to Working | Resolve reason/status; order may be filled, canceled, unknown, or working |
| Replace ack after fill | Apply requested quantity blindly | Validate cumulative/remaining quantities and venue replace rules |
| Late old ack after terminal event | Move state backward | Keep terminal/current facts; record response as duplicate/late evidence |
| Trade bust/correction | Reject because cumulative decreased | Apply the venue’s referenced revision as a first-class event |

Ordinary fills often expose `LastQty`, cumulative quantity, and leaves quantity. Cumulative values provide a strong invariant and make exact duplicates harmless, but `max(cumulative)` is not a complete execution ledger: busts and corrections can legitimately revise prior effects. Keep execution identity and reference relationships long enough to reverse or correct the exact business event.

### Compact C++23 reducer

This complete model covers new, ordinary fills, cancel, and their duplicates. Exact execution-ID deduplication happens before this reducer. Replace and trade-correction handlers are deliberately separate because their contracts are venue-specific.

```cpp
#include <cstdint>

enum class Life : std::uint8_t {
    PendingNew, Working, Filled, Canceled, Rejected, Unknown
};
enum class Pending : std::uint8_t { None, Cancel };
enum class Kind : std::uint8_t { Accepted, Fill, Canceled, NewRejected, CancelRejected };
enum class Result : std::uint8_t { Applied, Duplicate, Invalid };

struct Order {
    std::uint32_t quantity{};
    std::uint32_t cumulative{};
    std::uint32_t leaves{};
    Life life{Life::PendingNew};
    Pending pending{Pending::None};
};

struct Report {
    Kind kind{};
    std::uint32_t cumulative{};
    std::uint32_t leaves{};
};

constexpr Result apply(Order& o, Report r) noexcept {
    if (r.cumulative < o.cumulative || r.cumulative > o.quantity ||
        r.leaves > o.quantity - r.cumulative)
        return Result::Invalid;

    switch (r.kind) {
    case Kind::Accepted:
        if (o.life != Life::PendingNew && o.life != Life::Unknown)
            return Result::Duplicate;
        o.life = Life::Working; o.leaves = r.leaves; return Result::Applied;
    case Kind::Fill:
        if (r.cumulative == o.cumulative) return Result::Duplicate;
        o.cumulative = r.cumulative; o.leaves = r.leaves;
        o.life = r.leaves == 0 ? Life::Filled : Life::Working;
        if (o.life == Life::Filled) o.pending = Pending::None;
        return Result::Applied;
    case Kind::Canceled:
        if (o.life == Life::Canceled && r.cumulative == o.cumulative)
            return Result::Duplicate;
        if (o.life == Life::Filled) return Result::Invalid;
        o.cumulative = r.cumulative; o.leaves = 0;
        o.life = Life::Canceled; o.pending = Pending::None;
        return Result::Applied;
    case Kind::NewRejected:
        if (o.life == Life::Rejected) return Result::Duplicate;
        if (o.life != Life::PendingNew || o.cumulative != 0) return Result::Invalid;
        o.life = Life::Rejected; o.leaves = 0; return Result::Applied;
    case Kind::CancelRejected:
        if (o.pending != Pending::Cancel) return Result::Duplicate;
        o.pending = Pending::None; return Result::Applied;
    }
    return Result::Invalid;
}

constexpr bool cancel_race() {
    Order o{100, 0, 100};
    if (apply(o, {Kind::Accepted, 0, 100}) != Result::Applied) return false;
    o.pending = Pending::Cancel;
    if (apply(o, {Kind::Fill, 40, 60}) != Result::Applied) return false;
    if (apply(o, {Kind::Fill, 40, 60}) != Result::Duplicate) return false;
    return apply(o, {Kind::Canceled, 40, 0}) == Result::Applied &&
           o.life == Life::Canceled && o.cumulative == 40;
}
static_assert(cancel_race());
```

The reducer does not infer whether a cancel reject means Working; it only clears the outstanding request. A status/recovery event must establish any missing venue fact. In production, invalid transitions fence the affected order or session and preserve raw evidence; they do not disappear behind an assertion compiled out.

### Publication is part of the transition

Updating `Order` is only half the commit. A newly applied execution normally changes position, consumes or releases risk reservation, notifies the strategy, and enters audit/reconciliation streams. If a crash can occur between those effects, each downstream consumer needs a stable gateway event ID and its own idempotent cursor, or the effects need one transactional boundary.

A useful owner sequence is:

```text
classify session position and business identity
  -> validate transition against current order
  -> append/publish one stable internal event
  -> apply event to owner state and risk accounting
  -> advance the recoverable inbound cursor
```

The exact order depends on the journal/queue design; the invariant is that every crash point replays to the same result without losing a confirmed fill or publishing it twice. Do not emit a strategy callback before knowing how restart will detect that callback’s event. Sequence numbers on the internal event stream also let risk, strategy, and reconciliation consumers report precisely which prefix they have applied.

---

## 54.7 Worked trace: fill, disconnect, duplicate, cancel — Core

Assume protocol `V1` defines:

- unique client request IDs within `(firm, session generation, trading day)`;
- replayable sequenced execution reports;
- cumulative and remaining quantity on fills;
- cancel-on-disconnect enabled for day orders, with no guarantee of immediate cancellation;
- a separate drop-copy execution stream.

The order is a day limit for 100 units.

```text
t0 gateway admits New C101, reserves exposure 100
t1 gateway records send attempt and writes New C101
t2 venue accepts C101 as exchange order X77
t3 venue executes 40; order leaves 60
t4 connection fails before ack/fill reaches gateway
t5 gateway marks session Fenced; C101 outcome Unknown
t6 drop copy reports execution E9, cumulative 40, leaves 60
t7 venue detects disconnect and cancels remaining 60
t8 gateway reconnects, authenticates, enters Recovering
t9 replay delivers new ack, E9 fill, and cancel report
t10 gateway reconciles live-order/status evidence and returns Active
```

Reason through each transition:

1. At `t1`, transport success cannot promote `C101` to Working. It remains `PendingNew` with an external-effect uncertainty window.
2. At `t4`, the gateway retains the maximum plausible exposure of 100 until external evidence arrives. It must not release the risk reservation or reuse `C101`.
3. At `t6`, the independently received fill is valid even though the order-entry ack was absent. Correlation maps `C101` or `X77` to the stable handle; exact key `(venue, execution scope, E9)` makes the position change once.
4. Cancel-on-disconnect at `t7` removes the remaining quantity only when the venue processes it. It does not invalidate the earlier 40-unit fill.
5. Replay at `t9` may deliver the ack after the drop-copy fill. The ack cannot move cumulative quantity backward. Replayed `E9` is detected as the same business execution and does not publish another position change.
6. The cancel report makes remaining quantity zero while preserving cumulative 40. Only after the session gap is complete, outstanding IDs resolve, and independent evidence agrees does the gateway reopen.

Now change one fact: drop copy is also disconnected between `t4` and `t9`. The correct model is still safe because it retains unknown exposure. Recovery latency grows, but correctness does not rely on one feed being continuously available.

This trace also distinguishes **message order** from **business order**. Ack, fill, and cancel reports can be observed in a different order across the primary and drop-copy paths. The reducer uses identities, cumulative facts, and venue semantics rather than arrival order alone.

---

## 54.8 Disconnect, reconnect, and reconciliation — Core

Disconnect recovery begins by fencing, not by reconnecting as quickly as possible.

### Recovery sequence

1. Stop admission of new exposure; preserve risk-reducing paths that the policy and venue still make usable.
2. Snapshot session cursors, send-attempt records, outstanding commands, and last-confirmed order facts.
3. Establish transport with bounded retry/backoff appropriate to the venue’s login limits and operational runbook.
4. Authenticate and resume the existing logical session where supported. Do not reset sequences merely to make logon succeed.
5. Complete session replay/gap recovery before applying newer messages out of order.
6. Resolve every ambiguous new/cancel/replace through the venue’s supported status, mass-status, replay, or operator facility.
7. Reconcile executions and live orders against drop copy and other named authorities.
8. Have the risk owner approve the resulting exposure and release the fence.

Authentication failure, duplicate-primary rejection, missing resend-store range, sequence state behind the venue, and contradictory order evidence are different failures. Give each a bounded retry policy and an escalation action. Unbounded immediate login retries can worsen a venue incident or trigger controls.

### Safe action by disconnect point

| Last proven point | Gateway classification | Safe default |
|---|---|---|
| Intent not admitted | Not sent | Caller may create a new request |
| Admitted but provably before send boundary | Local-only | Re-drive under same ID/policy or reject locally |
| Send may have begun, no venue response | Unknown new | Query/recover; do not submit replacement exposure |
| New accepted | Possibly live/filled | Count leaves as exposed until newer evidence |
| Cancel may have been sent | Cancel unknown | Assume remaining quantity can trade |
| Replace may have been sent | Terms unknown | Preserve old confirmed and new requested terms |
| Partial fill confirmed | Filled amount known; leaves uncertain | Position includes fill; remaining maximum stays exposed |
| Full fill confirmed | Execution known | Do not cancel/recreate; await corrections/reconcile |
| Cancel confirmed | No remaining order under report semantics | Still accept earlier/late-delivered fills and corrections |

Not every venue offers an order-status query by client ID, and “unknown order” may mean wrong scope, expired retention, pending processing, or genuinely absent depending on its specification. A status response is definitive only to the extent the venue contract says it is. If no online mechanism resolves the ambiguity, keep the gateway fenced and use drop copy, alternate risk/cancel tools, venue operations, and post-trade files.

### Cancel on disconnect

Cancel on disconnect (COD) is an external risk control, not a local state transition. Record:

- whether it is enabled and how configuration is verified;
- trigger: involuntary disconnect, logout, heartbeat expiry, port close, or another condition;
- scope: session, user, port, firm, product, and order types;
- excluded time-in-force/order types;
- venue detection and cancellation timing;
- reports produced and recovery behavior;
- interaction with primary/backup connections.

**Venue example, not a universal rule:** current CME documentation describes COD for an involuntary lost iLink connection and excludes GTC/GTD orders. Another venue may define different scope and exclusions. Therefore the gateway moves orders to “COD expected, outcome unknown,” not Cancelled, until reports/status confirm them.

Test abrupt process death, network blackhole, transport reset, primary/secondary failover, and graceful logout separately. They can invoke different venue behavior.

---

## 54.9 Rate limits, throttling, and the risk path — Core

Exchange limits are protocol facts, not generic token-bucket facts. A venue may enforce:

- messages per second over a fixed or rolling window;
- per-session, per-firm, per-user, or per-partition budgets;
- separate administrative and application limits;
- weighted costs by message type;
- outstanding-order or in-flight-request caps;
- order-to-trade or cancel ratios over longer periods;
- reject, delay, disconnect, or administrative action on breach.

Pin the current rule and test boundary behavior in certification. Do not invent “safe headroom” as a universal percentage.

### Local throttle model

A token bucket is appropriate only when it matches the venue’s semantics closely enough. A rolling-window venue may require a timestamp ring; a fixed-window rule needs boundary-aware accounting. The local counter shadows an external counter that may include messages the gateway classified differently, so rejects and venue-provided utilization must feed monitoring.

Use one owner per budget. Precompute fixed-point refill parameters, handle timer discontinuities and integer overflow, and test burst boundaries. Chapter 55 owns the micro-optimization; this chapter owns which messages may proceed when capacity is scarce.

| Message class | Typical local policy | Required qualification |
|---|---|---|
| New exposure | Reject or boundedly defer | Delayed intent may be stale; risk authorization may expire |
| Replace increasing exposure | Treat like new exposure | Venue may count/cost it differently |
| Replace reducing exposure | Prefer over new flow | Still consumes whatever venue quota applies |
| Single cancel | Highest usable priority | Cannot bypass exchange enforcement |
| Mass cancel/disable | Dedicated emergency path if offered | Must be authenticated, tested, and rate-limit aware |
| Recovery/status | Reserved recovery budget or paced queue | Flooding queries can prevent recovery |

A “cancel reserve” means local new orders stop before consuming capacity expected to be needed for cancels. It does **not** authorize transmission above the venue limit. If cancels share an exhausted venue bucket, use any documented mass-cancel, cancel-on-behalf, kill, or operator facility and keep exposure conservative.

### Queueing policy

Never turn throttling into an unbounded FIFO:

- new/quote intents expire or are rejected when their market context is stale;
- multiple unsent replaces for one order can often be coalesced to the latest desired state, but only before any earlier request crosses the send boundary;
- cancels are deduplicated by order/request state, not dropped blindly;
- recovery queries are paced and bounded;
- overflow fences affected flow and alerts rather than overwriting a live request.

Record admission-to-send delay separately from network/venue acknowledgement latency. Otherwise local throttle queueing looks like venue latency.

---

## 54.10 Drop copy and post-trade reconciliation — Core

A drop copy is an independently delivered view of order/execution activity for an agreed account/session scope. It is valuable because it can reveal a fill missing from the order-entry path. It is not automatically complete, instantaneous, or infallible: it has its own session, sequence gaps, schema, duplicate behavior, account coverage, and operational outages.

Keep its consumer isolated from the latency-critical order-entry process where practical, but route urgent discrepancies to risk. Correlate using the full execution identity scope—not a bare `ExecID` unless the venue guarantees global uniqueness.

```text
order-entry executions        drop-copy executions
          \                         /
           \---- normalized IDs ---/
                       |
                 reconciler
                       |
         match / late / missing / conflicting
```

Classify differences:

| Difference | Possible explanation | Safe response |
|---|---|---|
| Drop copy only | missed primary report, coverage/manual activity, reorder | Update risk through controlled authority path; investigate |
| Order entry only | drop-copy lag/gap/scope, duplicate leak | Hold until reorder deadline; recover drop-copy gap |
| Same ID, different economics | parse/version bug, correction, identifier-scope collision | Fence affected scope and preserve raw bytes |
| Quantity matches, event count differs | duplicate/correction aggregation | Compare exact execution lineage |
| Live-order sets differ | missed cancel/new, COD, session ownership mismatch | Query authoritative live state; restrict new flow |

Continuous reconciliation uses a bounded lateness window derived from measured and contractual behavior. Post-trade reconciliation then compares the gateway journal, venue trade/order files, clearing or broker records, and internal positions. “Authoritative” is field-specific: the venue may own execution facts while clearing records own settlement state.

The gateway must retain:

- raw inbound/outbound bytes and protocol/schema version;
- session generation and sequence/cursor;
- internal handle and all client/venue identifiers;
- event/receive/send timestamps with clock domain;
- decision results, throttle/risk authorization generation, and reason codes;
- original execution plus correction/bust lineage.

Chapter 56 owns durable journaling and risk-control architecture. Here the invariant is that reconciliation can reconstruct every gateway decision and map it to external evidence.

---

## 54.11 Protocol and venue checklist — Role-specific

Complete this matrix per deployed session. “Unknown” is a release blocker, not a default:

| Contract area | Questions to answer |
|---|---|
| Identity | What scopes client IDs, venue IDs, and execution IDs? Can any change on replace or failover? |
| New duplicate | Is the repeated ID rejected, ignored, replayed, or treated as a new order? For how long? |
| Session sequence | Per direction or one stream? Persistent across connections? Reset boundary? |
| Recovery | Resend, snapshot, status query, failover cursor, or no online recovery? |
| Gap behavior | Buffer limit, request form, gap-fill meaning, unrecoverable action? |
| Heartbeat | Negotiation, idle definition, test/challenge, timeout, clock source? |
| Logout | Handshake and effect on working orders? |
| Ack/reject | Which response proves business acceptance or non-acceptance? |
| Fill | Can it precede ack? Cumulative fields? execution-ID scope? bust/correct model? |
| Cancel | Effectiveness point, too-late reason, cancel/fill ordering, mass cancel? |
| Replace | Atomicity, priority, quantity rules, identifiers, old/new terms during race? |
| Disconnect | Working-order persistence, COD trigger/scope/exclusions/timing? |
| Throttle | Exact window, scope, weights, emergency/recovery traffic, breach action? |
| Drop copy | Coverage, latency/reorder contract, sequence/recovery, correction messages? |
| Versioning | Schema/profile revision, effective date, certification cases, rollback? |

Three concrete labels illustrate why this work cannot be generalized:

- The FIX Session Layer defines persistent directional sequence numbers, resend requests, possible-duplicate handling, gap fill, and optional next-expected synchronization; bilateral rules select application replay behavior.
- Nasdaq OUCH 5.0’s current specification uses `UserRefNum` for uniqueness/duplicate checking and defines explicit accepted, executed, canceled, replaced, broken-trade, reject, and cancel-reject messages.
- CME iLink 3 uses FIXP session mechanics with SBE order messages; current CME COD documentation describes a configured session-level facility with stated order-type exclusions.

These examples are not interchangeable designs. A gateway adapter converts each one into the stable internal facts defined earlier while preserving venue-specific reason and lineage data for recovery.

Primary deployment references should be pinned in the adapter’s certification record: the FIX Trading Community’s **FIX Session Layer** specification, Nasdaq’s dated **OUCH 5.0 Order Entry Specification**, and the venue’s current session/COD/rate-limit rules. A web page remembered from the previous release is not a protocol contract; archive the approved revision and diff it before certification.

---

## 54.12 Observability and fault injection — Reference

### Minimum per-session telemetry

- connection/session state transitions with reason and duration;
- `NextNumIn`/`NextNumOut` or native cursor, gaps, replay ranges, duplicates;
- heartbeat/test timeouts and event-loop watchdog stalls;
- orders admitted, attempted, accepted, rejected, and unknown;
- outstanding new/cancel/replace counts and oldest age;
- acknowledgement latency split into local queue, write, network/venue, and recovery;
- throttle utilization/rejects/queue age by message class;
- COD configuration observed and COD-related recovery results;
- primary/drop-copy unmatched executions by age;
- correlation misses, invalid transitions, and identifier-capacity headroom.

Metrics must not mutate protocol state from another thread. Snapshot owner-written counters or publish bounded events. Raw logging must preserve evidence without blocking the session owner; Chapter 55 covers the hot-path mechanism.

### Fault matrix

| Injection | Invariant to verify |
|---|---|
| Disconnect before any write-capable call | Intent remains definitely unsent |
| Disconnect after partial/complete transport write | Request becomes unknown, ID retained |
| Drop new ack but deliver fill | Fill correlates and updates once |
| Duplicate every execution report | Position and downstream events remain single-effect |
| Reorder ack/fill/cancel across primary/drop copy | Confirmed quantities never regress |
| Reject cancel after full fill | Order stays terminal; command resolution is separate |
| Lose resend-store range | Session fences and takes supervised recovery path |
| Exhaust correlation capacity | No ID alias; admission stops safely |
| Exhaust new-order throttle budget | Cancel/recovery policy follows documented venue limits |
| Kill process with COD enabled/disabled | Observed venue outcomes match configured scope |
| Schema/version mismatch | Session rejects/fences before state mutation |
| Drop-copy gap | Reconciler alarms and recovers rather than declaring agreement |

Certification tests supplied by a venue are necessary but insufficient. Add deterministic model tests, duplicate/reorder property tests, crash-point tests around every local commit, and production-like capacity tests. Store the protocol revision and expected outcome beside each scenario so a venue upgrade produces an explicit review.

---

## Recall card — Core

- The venue owns order/execution truth; the gateway owns a recoverable, auditable model of it.
- Session `Active` permits flow; it does not prove any order state.
- Transport write is a send attempt, not acceptance. Timeout creates uncertainty, not rejection.
- Stable internal handle, client request ID, venue order ID, and execution ID have different scopes.
- Keep confirmed lifecycle separate from `CancelPending`/`ReplacePending`.
- A fill can precede ack and race cancel. Apply execution facts once; never let a late ack regress them.
- Session sequence detects gaps; business identity detects duplicate effects.
- Preserve unknown exposure across disconnect; resume, replay, query, and reconcile before reopening.
- COD and throttles are venue/session/version contracts. Local priority cannot override external enforcement.
- Drop copy is independent evidence with its own gaps; post-trade records close a wider reconciliation window.

---

## Common traps — Core

- Collapsing session state and order state into one enum.
- Returning “sent” as if it meant “accepted.”
- Converting an acknowledgement timeout into `Rejected`.
- Reusing a client ID after a local/ambiguous failure.
- Treating FIX `PossDupFlag` and `PossResend` as the same mechanism.
- Assuming gap fill skips only administrative messages under every agreement.
- Resetting sequence numbers on an intraday reconnect to avoid recovery.
- Modeling `PendingCancel` as a venue lifecycle state and losing working exposure.
- Ignoring a fill because the new-order acknowledgement has not arrived.
- Adding `LastQty` again on duplicate delivery.
- Using only `max(CumQty)` and losing trade-bust/correction lineage.
- Returning to Working on every cancel reject, regardless of reason.
- Replacing confirmed terms at replace-send time.
- Recycling terminal correlation entries before late/replay/correction closure.
- Assuming a status query exists or that “unknown order” always proves absence.
- Treating COD as immediate, universal, or equivalent to flat.
- Letting a local cancel reserve exceed the exchange rate limit.
- Queueing stale new orders without expiry or renewed risk authorization.
- Calling drop copy infallible or using an unscoped execution ID.
- Reopening after logon before sequence, order, and risk reconciliation complete.

---

## Reasoning questions

1. Why can a gateway be logged on successfully while every order remains unsafe to act on?
2. Define the exact boundary between definitely unsent and send-outcome unknown in a single-writer gateway.
3. How do FIX session retransmission and application resend differ, and which identity resolves each duplicate?
4. Why is `CancelPending` better represented beside Working than instead of Working?
5. A fill arrives before the new acknowledgement. Which facts does it establish, and which remain unknown?
6. A cancel reject says “too late.” Why is returning unconditionally to Working unsafe?
7. What must be retained before an internal order slot and its identifiers can be reused?
8. How should local throttling behave when new orders have exhausted the budget needed for cancels, but the venue’s shared quota is already full?
9. Which evidence is required before reopening order entry after an unrecoverable resend gap?
10. What can drop copy reveal that an internally consistent gateway journal cannot?

---

## Code-reading puzzle

```cpp
void on_cancel_timeout(Order& o) {
    o.life = Life::Working;
    o.pending = Pending::None;
    risk.release_cancel_reservation(o.leaves);
}
```

List at least four possible venue realities when this timer fires. Explain which assignment invents a fact, why releasing exposure can be dangerous, and what event should actually resolve the pending command. Then state what the gateway may do while the protocol provides no definitive query.

---

## Implementation exercise

Build a deterministic gateway simulator with:

1. one session state machine and one single-writer event queue;
2. stable internal handles plus scoped client, venue, and execution identifiers;
3. new, accept, reject, partial/full fill, cancel, cancel reject, replace, correction, and bust events;
4. a bounded session resend store and a separately replayable gateway journal;
5. primary and delayed drop-copy streams;
6. venue-configurable duplicate-ID, recovery, throttle, and COD policies.

Generate every crash point around admission, journal append, send attempt, acknowledgement, and publication. Duplicate and reorder inbound events within the protocol’s allowed rules. Assert that no send-outcome-unknown ID is reused, cumulative ordinary fills do not regress, every execution effect is applied once, possible exposure is conservative, and `Active` is reached only after reconciliation. Finish with capacity calculations for order retention, resend storage, gap buffering, throttle queues, and the drop-copy lateness window.

---

## Prerequisite for Chapter 55

Chapter 55 optimizes the gateway’s hot path. Before continuing, be able to identify its correctness boundaries: the single session owner, admission commit, send uncertainty window, correlation lookup, idempotent reducer, throttle decision, and publication point. An optimization that moves or weakens one of those boundaries must first reproduce this chapter’s state-machine and fault-injection results.
