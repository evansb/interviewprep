# Chapter 54 — Order Gateways

*Interview-focused revision notes. The theme: a market-data feed can drop a message and you lose an opportunity; an order gateway can drop a message and you lose money you did not know you had spent. This chapter is about the session, sequencing, and identity machinery that makes an unreliable duplex link carry legally binding instructions exactly once.*

---

**Terminology used throughout.** An **order gateway** (or *order entry gateway*, OE) is the component that owns the outbound connection to an exchange or broker and translates internal trading intents into protocol messages, and exchange responses back into internal events. A **session** is one authenticated, sequenced logical connection over that link — usually one TCP connection, but the session concept outlives the connection. An **order** is an instruction to buy or sell a quantity of an instrument at a price; once **acknowledged** by the exchange it is **live** (also *working*, *resting*) and can trade. An **execution** or **fill** is a report that some quantity traded. **Cancel** removes a live order; **cancel/replace** (also *modify*, *amend*) changes price or quantity. An **exchange session** typically runs one trading day; sequence numbers usually reset at a defined boundary.

---

## 54.1 Trading-Session Logon and Logout

A session begins with a **logon**: an authentication and negotiation handshake carried inside the protocol, above TCP. In FIX (Ch. 51 §51.1) this is `MsgType=A` carrying `SenderCompID`, `TargetCompID`, optional `Username`/`Password` or a signed credential, `HeartBtInt` (heartbeat interval in seconds), `EncryptMethod`, and critically `MsgSeqNum` — the logon is itself a sequenced message. In binary protocols like OUCH or SBE-framed native gateways, logon is a fixed-layout `LoginRequest` with account, password, and a *requested sequence number* field. The exchange replies with a logon accept (echoing the negotiated heartbeat interval, which may be *lower* than requested) or a reject with a reason code.

Two negotiation outcomes matter and they are the source of most first-day-on-the-desk incidents:

| Field | Meaning | Hazard |
|---|---|---|
| `HeartBtInt` | Idle interval before a heartbeat is required | Exchange may impose its own; honor the *response*, not your request |
| `ResetSeqNumFlag` (141=Y) | "Start both directions at 1" | Discards the exchange's memory of what it sent you — including fills you never processed |
| `NextExpectedMsgSeqNum` (789) | "I expect your next outbound to be N" | Makes recovery declarative; if supported, always use it |

The logon is the last point at which the two sides agree cheaply about state. After it, every disagreement costs a resend or a manual reconciliation.

**Logout** (`MsgType=5`, or `LogoutRequest`) is a *graceful* termination: the initiator sends logout, the responder echoes it, then either side closes TCP. The half-close ordering matters (Ch. 38 §38.20): if you close the socket immediately after writing the logout, data the exchange already sent may be discarded by your kernel and RST'd back, and the exchange records an abnormal disconnect — which, depending on venue configuration, may trigger cancel-on-disconnect (§54.13) when you intended an orderly end-of-day. The correct sequence is: send logout, `shutdown(fd, SHUT_WR)`, keep reading until EOF or a short timer expires, then `close`.

A logout is *not* a cancel. Live orders survive logout unless the venue's session configuration says otherwise (many venues persist GTC orders across sessions and cancel day orders at close). Candidates who assume "disconnect means flat" are wrong at most venues and dangerously wrong at the rest, because the assumption is silently correct in staging environments where they had no resting orders.

**Engineering shape.** Logon is a *cold-path* operation (Ch. 52 §52.7) — it runs once, it can allocate, it can log verbosely, it can take milliseconds. Keep it entirely out of the hot-path code so that its parsing generality and error handling never appear in the steady-state instruction stream. The session state machine, however, must be visible to the hot path as a single atomically-read enum, because every outbound order must check "am I logged on?" in a few nanoseconds.

```cpp
enum class SessionState : uint8_t {
    Disconnected, Connecting, LogonSent, Established, LogoutSent, Failed
};
// hot path reads one relaxed atomic; no lock, no branch to the session module
std::atomic<SessionState> state_{SessionState::Disconnected};
```

Legal transitions form a small graph; encode it as a table and reject illegal transitions loudly rather than tolerating them, because a gateway that silently accepts `Established → LogonSent` is a gateway that will one day send orders on a socket the exchange has already forgotten.

---

## 54.2 Session Heartbeats

A **heartbeat** is a periodic no-op message whose sole purpose is to prove the session is alive in both directions. TCP alone cannot do this: a peer that has crashed, or a path that has silently blackholed, produces no error on an idle socket. `SO_KEEPALIVE` defaults are measured in hours (Ch. 38 §38.16) and are useless here. The protocol-level heartbeat gives you a liveness detector with a bound you control.

The standard mechanism (FIX, and structurally identical in binary protocols):

- If you have sent nothing for `HeartBtInt` seconds, send a heartbeat.
- If you have *received* nothing for `HeartBtInt` seconds, send a **test request** (`MsgType=1`) carrying a `TestReqID`.
- If no response (a heartbeat echoing that `TestReqID`) arrives within roughly another interval, declare the session dead and disconnect.

Two subtleties separate strong candidates. First, **any** outbound message resets the outbound timer — a heartbeat is only needed on idle, so a busy session sends none, and the absence of heartbeats is not evidence of trouble. Second, the receive-side detector must be armed against a *slow reader*, not just a dead peer: if your own event loop is stalled (a page fault, a GC-equivalent stall from an allocation, a `write()` blocking on a full socket buffer), you will fail to send your heartbeat and the exchange will drop *you*. Heartbeat failures are therefore a leading indicator of local latency pathology, not only of network trouble, and this is the diagnostic signature worth memorizing: **exchange-initiated disconnects clustered on the same host with no packet loss on the wire means your process stalled.**

Implementation discipline for a busy-spin gateway (Ch. 55 §55.3):

```cpp
// Called from the spin loop; no syscall unless a heartbeat is actually due.
inline void poll_timers(uint64_t now_tsc) noexcept {
    if (now_tsc - last_tx_tsc_ >= hb_interval_tsc_) send_heartbeat();
    if (now_tsc - last_rx_tsc_ >= hb_interval_tsc_ && !test_req_outstanding_)
        send_test_request();
    if (test_req_outstanding_ && now_tsc - test_req_tsc_ >= hb_interval_tsc_)
        fail_session(Reason::HeartbeatTimeout);
}
```

Use TSC deltas (Ch. 43 §43.12), not `clock_gettime`, so the timer check costs a compare rather than a vDSO call. The comparison against a precomputed `hb_interval_tsc_` avoids a division. Note the check is *unconditional* per loop iteration — a predictable, always-not-taken branch costs essentially nothing, whereas a timerfd (Ch. 33 §33.10) costs an epoll wakeup you do not want on an isolated core.

A final operational point: heartbeat intervals of 30 seconds are common by convention but are far too coarse for a low-latency system's own health monitoring. Run an internal watchdog (Ch. 56 §56.7) at millisecond granularity on the gateway thread independently of the protocol heartbeat; the protocol heartbeat exists to satisfy the exchange, the watchdog exists to satisfy you.

---

## 54.3 Session Sequence Reset

Every sequenced session protocol assigns each message an integer **sequence number** that increments by exactly one per direction. The invariant "the next message I receive has sequence `expected`" is the entire basis for detecting loss, duplication, and reordering above a byte stream that cannot itself lose data — because the *stream* is reliable, a sequence gap means something worse than packet loss: a message was generated and not delivered, i.e. the session was interrupted, or the peer's state does not match yours.

**Sequence reset** is the operation that moves the expected number without delivering the intervening messages. Two forms exist and confusing them is a classic interview discriminator:

| Form | FIX encoding | Meaning | When legitimate |
|---|---|---|---|
| **Gap fill** | `MsgType=4`, `GapFillFlag=Y`, `NewSeqNo=N` | "Messages up to N−1 were administrative; skip them" | During a resend, replacing heartbeats/logons that must not be replayed |
| **Hard reset** | `MsgType=4`, `GapFillFlag=N`, `NewSeqNo=N` | "Set your expected inbound to N unconditionally" | Recovery from an unrecoverable mismatch; operationally supervised |

A gap fill is itself sequenced and must arrive at the sequence number it claims to start from; a hard reset is *not* required to, which is precisely why it is dangerous. A hard reset discards the loss detector. If the exchange sends `SequenceReset` with `NewSeqNo` past a fill report you never saw, that fill is gone from the session and can only be recovered from a drop copy (§54.14) or the end-of-day file (§54.15).

The other reset is **logon-time reset** via `ResetSeqNumFlag=Y`, which sets both directions to 1. Firms use it at start-of-day because it removes any dependency on yesterday's persisted state. The hazard is using it *after an intraday disconnect*: you are telling the exchange to forget everything it was going to resend, and any execution report generated during the disconnect window is discarded. The rule to state in an interview: **`ResetSeqNumFlag=Y` is a start-of-day operation with no live orders and no unreconciled fills; intraday reconnects must resume, not reset.**

Persistence is what makes resumption possible. Both the last-sent and last-received sequence numbers must survive a process crash, which means they must be written durably *before* the corresponding message is acted upon. This is the write-ahead journal problem (Ch. 56 §56.1) in miniature:

```cpp
// Outbound: assign, journal, then send. Never send-then-journal.
uint64_t seq = ++next_out_;
journal_.append_and_sync(seq, msg);   // durable
transport_.send(msg);                 // if we crash after this, we replay a duplicate — safe
// Inbound: process, then advance. Never advance-then-process.
```

Ordering matters in opposite directions on the two sides: on send you must persist before transmitting (so a crash cannot lose the fact that a message *may* have gone out); on receive you must process before advancing (so a crash cannot lose an unprocessed message). Getting this backwards produces the two canonical failures — sending an order twice, or losing a fill — and being able to state the asymmetry crisply is a strong signal.

---

## 54.4 Resend and Replay

**Resend** is the recovery mechanism: when the receiving side detects that the incoming sequence number exceeds `expected`, it asks the peer to retransmit the range. In FIX this is `ResendRequest` (`MsgType=2`) with `BeginSeqNo` and `EndSeqNo` (0 or 999999 meaning "through the end"). The responder walks its outbound store and re-sends each message with `PossDupFlag=Y` (43=Y) and the *original* `MsgSeqNum` and `SendingTime`, plus `OrigSendingTime` (122) recording when it was first sent.

The mechanics that matter:

- **Administrative messages are not replayed.** Heartbeats, test requests, logons, and resend requests from the original stream are meaningless out of time. They are collapsed into a `SequenceReset`–`GapFill` covering their range (§54.3). A resend response is therefore a *mixture* of real application messages and gap fills.
- **The requester must not process the range twice.** Messages below `expected` arriving with `PossDupFlag=Y` are duplicates and must be suppressed (§54.9) — but they must be suppressed *at the application level*, because the session layer will happily hand you both copies during a range that overlaps what you already have.
- **A resend request received while you are already resending** is a recursion hazard; implementations queue or reject it.
- **The gap detector must not fire on the resend itself.** While resending, the responder's own outbound sequence continues from the high-water mark; the receiver must distinguish "replayed message with an old sequence number" from "new message" purely by `PossDupFlag` and the numeric comparison, not by arrival order.

The **outbound message store** is the data structure behind all of this: an append-only log of every message sent, indexed by sequence number, retained for the session's life. For a gateway sending 100k messages a day at ~200 bytes, that is 20 MB — trivially memory-resident. Preallocate it (Ch. 55 §55.1) as a fixed-capacity ring of offsets into a slab, and size it for the day's worst case plus margin; a store that wraps has silently lost the ability to answer a resend request.

```cpp
struct OutStore {
    std::byte* slab;                    // preallocated, huge-page backed (Ch. 32 §32.9)
    struct Rec { uint32_t off, len; };
    Rec index[kMaxSeqPerDay];           // seq -> slab slice; seq is dense from 1
    uint32_t used = 0;
};
```

**Replay** is the broader term: replaying the *inbound* stream into the application to rebuild state after a restart. This is distinct from a session resend — it reads your own journal, not the exchange's store — and it is the recovery path in Ch. 56 §56.3. The two must produce the same end state, which is exactly the property that makes a deterministic, side-effect-free application core (Ch. 52 §52.6, Ch. 57 §57.12) worth the design cost: replay is only trustworthy if replaying N messages yields bit-identical state to having processed them live.

Cost note: resend handling belongs on the cold path. It runs after a disruption, it may touch megabytes, and it must be correct rather than fast. Structuring the gateway so the resend responder shares no code with the steady-state send path — only the store — keeps the hot path free of the branches resend logic would otherwise introduce.

---

## 54.5 Reconnect Behavior

A **reconnect** is re-establishing the transport and resuming the session after an unplanned disconnect. The engineering questions are: how fast, how many times, and in what state does the application sit while it is down.

**Detection.** A TCP disconnect surfaces as `EPIPE`/`ECONNRESET` on write, `read()` returning 0 (orderly FIN), or nothing at all in the blackhole case — which is why the heartbeat detector (§54.2) is the real disconnect detector and the socket error is merely the fast path. Detection latency is bounded by `min(TCP error, heartbeat timeout)`, and for a system where cancel latency during an outage is a risk exposure, that bound is a design parameter, not an accident.

**Backoff.** Immediate unbounded retry is wrong for two reasons: exchanges rate-limit logon attempts and will lock out a session that hammers (typically 3–5 failures), and a reconnect storm across a fleet after a venue-side event turns a recoverable blip into a lockout. Standard shape: immediate first attempt (the common case is a transient socket error where reconnection succeeds instantly), then exponential backoff with jitter, capped, with a distinct much-longer backoff for *authentication* failures — because a bad password never fixes itself and retrying it locks the account.

```
attempt 1: 0 ms      (transient errors dominate)
attempt 2: 100 ms ± 50
attempt 3: 400 ms ± 200
attempt n: min(100 * 2^(n-1), 30000) ± 50%
auth reject: stop; require operator intervention
```

**Sequence continuity.** On reconnect, send logon with `ResetSeqNumFlag=N` and, if the venue supports it, `NextExpectedMsgSeqNum` set to your expected inbound. This turns recovery into a single declarative statement: the exchange immediately begins its resend from that number without a round-trip `ResendRequest`. Without tag 789 the flow is logon → detect gap → `ResendRequest` → replay, which is three round trips of exposure.

**Application state during the gap.** This is the part candidates underestimate. While disconnected you have *in-flight uncertainty*: orders you sent whose acks you never received, and orders that may have filled. The correct posture is:

| Order state at disconnect | Posture while down | On reconnect |
|---|---|---|
| Acked, live | Assume live and exposed | Reconcile; it may have filled |
| Sent, unacked | **Unknown** — may be live | Must be resolved before reuse of its ID |
| Cancel sent, unacked | Assume still live | Re-query or re-cancel |
| Filled | Position is real | Verify against drop copy |

The unknown states are why the gateway must not simply "resend everything" — a resend of a new-order message the exchange already accepted creates a second order if the venue keys on nothing, or is rejected as a duplicate if it keys on client order ID (§54.6). Idempotency is what makes reconnect safe, and it is designed in at the identifier layer, not bolted on at reconnect time.

**Multiple sessions.** Firms usually hold several concurrent sessions to a venue for throughput and failover. Two hazards: an order must be cancelled on the *same* session that created it at many venues (session-scoped order IDs), and a failover that moves order flow to a second session leaves the first session's live orders unmanageable if it cannot be restored. Design for "session down ⇒ its orders are frozen but visible", not "session down ⇒ its orders vanish from my model."

---

## 54.6 Client and Exchange Order Identifiers

Every order carries two identities and confusing them causes an entire class of bugs.

- **Client order ID** (`ClOrdID`, tag 11; `Token` in OUCH) — assigned by *you*, before the order leaves the building. It is the only identifier that exists at the moment of send, and it is therefore the only key you can use to correlate a response with a request that may never have been acknowledged.
- **Exchange order ID** (`OrderID`, tag 37) — assigned by the *exchange* on acceptance. It is stable for the order's life and is the identifier used in market-by-order feeds and in the exchange's own records.

Uniqueness requirements are protocol-specific but the safe common denominator is: **`ClOrdID` must be unique per session per day, and must never be reused, including for orders that were rejected.** Many venues require global uniqueness across the firm; some require monotonicity. Reusing a `ClOrdID` after a reject is a common bug because the reject "feels like" the order never existed — but if the reject was generated by your own gateway due to a throttle (§54.12) while the message was already on the wire, it did exist.

The cancel/replace chain adds a third identifier: `OrigClOrdID` (tag 41), naming the order being replaced. A replace generates a *new* `ClOrdID`, so an order's identity is a chain:

```
ClOrdID=A  (new)          → exchange OrderID=X
ClOrdID=B, OrigClOrdID=A  (replace)  → still OrderID=X
ClOrdID=C, OrigClOrdID=B  (replace)  → still OrderID=X
```

The exchange `OrderID` is invariant across the chain at most venues (not all — some issue a new one per replace, which must be read from the ack). Your internal representation should therefore have a **stable internal order handle** — a dense `uint32_t` index into a preallocated array — that is *neither* of the protocol identifiers, with both mapped onto it. This is the single most important structural decision in the gateway:

```cpp
using OrderIdx = uint32_t;                 // dense, preallocated, cache-friendly
struct Order {
    OrderIdx     idx;
    uint64_t     cl_ord_id;                // current
    uint64_t     orig_cl_ord_id;           // previous link in the chain
    uint64_t     exch_ord_id;              // 0 until acked
    int64_t      price_ticks;              // fixed point (Ch. 23 §23.10)
    uint32_t     leaves_qty, cum_qty;
    OrderState   state;
    uint16_t     instrument_id;
    uint8_t      side, session_id;
};
static_assert(sizeof(Order) <= 64);        // one cache line
```

**Generating `ClOrdID` cheaply.** The hot path must not format strings or take a lock. The standard construction is a 64-bit integer partitioned into fields — session/gateway id, a per-day epoch marker, and a monotonically increasing counter incremented with a plain non-atomic `++` if the gateway is single-writer (Ch. 52 §52.6), or `fetch_add(1, relaxed)` if not. If the protocol requires an ASCII `ClOrdID` (FIX does), encode with a fixed-width base-36 or hex conversion into a preallocated field — never `std::to_string`, never `std::format` on the hot path (Ch. 16 §16.3). The encoding must be *reversible* so that an inbound response's `ClOrdID` maps back to the internal index by arithmetic rather than by a hash lookup:

```cpp
// 64-bit ClOrdID layout: [ gateway:8 | day:16 | counter:40 ]
inline uint64_t make_clordid(uint8_t gw, uint16_t day, uint64_t ctr) noexcept {
    return (uint64_t(gw) << 56) | (uint64_t(day) << 40) | (ctr & ((1ull<<40)-1));
}
```

If the counter *is* the array index (mod capacity), correlation becomes a mask and a load instead of a hash probe — the difference between ~2 ns and ~30 ns on the ack path, which is on the critical path for any strategy that reacts to its own fills.

---

## 54.7 Order-Correlation Tables

The **correlation table** maps inbound protocol identifiers to internal order state. Every response — ack, reject, fill, cancel ack, replace reject — arrives keyed by `ClOrdID` and/or `OrderID`, and must find its order in bounded, small time.

Three lookups exist and they have different requirements:

| Lookup | Frequency | Structure |
|---|---|---|
| `ClOrdID` → order | Every inbound message | Direct index if IDs are counter-derived; else open-addressed flat map |
| `OrderID` → order | Fills at some venues, market-by-order correlation | Open-addressed flat map (Ch. 12 §12.7) |
| internal index → order | Everything internal | Array index |

**Do not use `std::unordered_map`.** It is node-based: every lookup is a pointer chase into a separately allocated node, insertion allocates, and erasure frees — three properties that are individually disqualifying on the hot path (Ch. 12 §12.2, Ch. 8 §8.8). The measured difference against a flat open-addressed map with linear probing is typically 3–10× on lookup and unbounded on insert (the allocator's tail). If you must have a hash map, use a preallocated open-addressed table with power-of-two capacity, a cheap mixing function, and tombstone-free deletion by backward-shift.

The strictly better answer when you control identifier generation is **no hash at all**:

```cpp
// Counter-derived ClOrdID: the low bits ARE the slot.
inline Order* lookup(uint64_t clordid) noexcept {
    uint32_t slot = uint32_t(clordid) & (kCapacity - 1);
    Order* o = &orders_[slot];
    return (o->cl_ord_id == clordid) ? o : nullptr;   // verify to catch wrap/stale
}
```

The verification compare is essential: it turns a wrapped counter or a stale response from a previous session into a `nullptr` rather than a corrupted order. Size `kCapacity` above the day's peak *live plus recently-terminated* order count — terminated orders must remain resolvable for a grace period, because late acknowledgements (§54.10 territory; see Ch. 50 §50.10) arrive for orders you consider finished, and a lookup miss on a fill is a position error, the worst outcome in this chapter.

**Retention policy.** Orders cannot be recycled the instant they reach a terminal state. The safe rule is a **two-phase retirement**: on terminal state, move the order to a *retired* status but keep the slot occupied and resolvable; reclaim the slot only after a time bound exceeding the venue's maximum message latency (seconds, not milliseconds) *and* after any outstanding request on that order has been resolved. A free-list of slots with a timestamp-ordered reclaim queue implements this in O(1) with no allocation.

**Failure signature.** "Fill for unknown order" in the log is nearly always one of: slot recycled too early, `ClOrdID` reused after a reject, a response from a *previous* session (didn't include session id in the key), or a replace chain where you keyed on the original `ClOrdID` and the exchange responded with the new one. Each has a distinct fix; the shared prevention is that the correlation key must include everything that scopes the identifier — session and trading day — not just the counter.

---

## 54.8 Idempotent Order State Transitions

**Idempotent** here means: applying the same state transition twice produces the same result as applying it once, with no additional side effect. Because the link is at-least-once (§54.16) and because reconnects replay, the order state machine must be written so that duplicate application is harmless *by construction*, not by an upstream promise of exactly-once delivery that no real system provides.

The order lifecycle (introduced in Ch. 50 §50.9) as the gateway sees it:

```
                 ┌──────────────┐
                 │   PendingNew │──reject──▶ Rejected (terminal)
   send new ────▶│  (in flight) │
                 └──────┬───────┘
                        │ ack
                        ▼
   ┌──────────────▶ ┌────────┐ ──partial fill──▶ (stays Live, leaves↓)
   │  replace ack   │  Live  │ ──full fill─────▶ Filled (terminal)
   │                └───┬────┘
   │                    │ cancel sent          cancel reject
   │              ┌─────▼────────┐ ───────────────────┐
   │              │PendingCancel │                    ▼
   │              └─────┬────────┘             (back to Live)
   │                    │ cancel ack
   │                    ▼
   │              Cancelled (terminal)
   │
   └── PendingReplace ◀── replace sent (from Live)
```

Idempotency is achieved by making transitions **monotone in a well-order** and keyed on the message's own identity:

1. **Assign each state a rank.** `PendingNew(0) < Live(1) < PendingCancel/Replace(2) < Terminal(3)`. A transition that would move backwards in rank, or that targets a terminal state already reached, is *ignored*, not treated as an error. This single rule absorbs duplicate acks, duplicate cancel confirmations, and out-of-order replace responses.
2. **Make quantity updates absolute, not incremental.** Execution reports carry `CumQty` (cumulative filled) and `LeavesQty` (remaining), not just `LastQty`. Track `cum_qty` and apply `cum_qty = max(cum_qty, msg.cum_qty)`. A duplicated fill then contributes nothing, because the cumulative value is unchanged. If you accumulate `cum_qty += msg.last_qty` instead, a single duplicated execution report doubles a position — this is *the* canonical order-gateway bug, and stating the absolute-vs-incremental fix is the expected answer.
3. **Key the transition on `ExecID`.** Venues assign each execution report a unique `ExecID` (tag 17). Maintaining a small recently-seen `ExecID` set per order (or a global ring) gives exact duplicate detection where the cumulative-quantity trick is insufficient — notably for **trade busts/corrections**, which legitimately revise a prior fill and therefore *must not* be idempotently ignored.

```cpp
inline void apply_exec(Order& o, const ExecReport& e) noexcept {
    if (rank(e.state) < rank(o.state) && !is_correction(e)) return;   // stale/dup
    if (e.cum_qty <= o.cum_qty && !is_correction(e))      return;     // dup fill
    o.cum_qty    = e.cum_qty;
    o.leaves_qty = e.leaves_qty;
    o.state      = e.state;
}
```

The subtlety worth raising unprompted: **idempotence of state is not idempotence of side effects.** Ignoring a duplicate fill for position purposes is right; suppressing the *risk system's* observation of it may be wrong if the risk system counts messages rather than quantity. Every consumer of the fill stream must independently be idempotent, which is why the deduplication belongs at the gateway boundary (§54.9) and the internal event stream should carry a monotone sequence number that downstream stages can use to discard replays.

---

## 54.9 Duplicate Suppression

Duplicates arrive from four distinct sources, and a gateway needs a defence for each because they have different keys:

| Source | Marker | Detection |
|---|---|---|
| Session resend (§54.4) | `PossDupFlag=Y`, seq ≤ expected | Sequence number comparison |
| Exchange re-send after its own failover | `PossResend=Y` (tag 97) | Application-level: `ExecID` / `ClOrdID` + state |
| Your own retransmission after reconnect | none | `ClOrdID` uniqueness; exchange rejects the duplicate |
| Redundant drop-copy feed (§54.14) | none | `ExecID` set |

`PossDupFlag` (43) and `PossResend` (97) mean different things and interviewers ask. **`PossDupFlag=Y`** means "this is a session-layer retransmission of a message already sent with this sequence number" — same message, same content, safe to discard on sequence grounds alone. **`PossResend=Y`** means "this message may duplicate one sent earlier *under a different sequence number*" — it originates from the application layer (typically after an exchange-side failover), the sequence number is new, and the session layer cannot detect it. Only application-level identity (`ExecID`, or `ClOrdID` + state) resolves it. A gateway that treats `PossResend` as `PossDup` will discard legitimate messages; one that ignores it will double-count fills.

**The dedup structure.** A bounded, allocation-free, false-negative-free set of recently seen identifiers:

```cpp
// Open-addressed ring of ExecIDs; capacity >> max in-flight, power of two.
class DupFilter {
    static constexpr uint32_t kCap = 1u << 16;
    uint64_t seen_[kCap]{};                       // 0 = empty; preallocated, 512 KB
public:
    bool insert_is_new(uint64_t id) noexcept {
        uint32_t h = uint32_t(id * 0x9E3779B97F4A7C15ull >> 48) & (kCap - 1);
        for (uint32_t i = 0; i < 8; ++i, h = (h + 1) & (kCap - 1)) {
            if (seen_[h] == id) return false;     // duplicate
            if (seen_[h] == 0)  { seen_[h] = id; return true; }
        }
        return true;   // probe budget exhausted: fail OPEN (process it)
    }
};
```

The design decision embedded in that last line is worth calling out. When the filter is uncertain, it must **fail open and process the message**, because a false duplicate (dropping a real fill) corrupts your position silently, while a false new (processing a duplicate) is caught downstream by the idempotent state machine (§54.8). Layered defences with different failure directions is the correct architecture: cheap probabilistic dedup at the edge that never drops a real message, plus exact idempotence in the state machine.

Never use a Bloom filter here (Ch. 21 §21.19) — its error direction is false *positives*, i.e. it will claim a new message is a duplicate, which is exactly the unacceptable direction.

**Clearing.** The filter must be cleared per session/day, and its capacity must exceed the day's message count or it saturates and every lookup degrades to a linear probe. Sizing it to 4× peak daily executions and resetting at session start is simplest; the memory is negligible.

---

## 54.10 Disconnect Recovery

Recovery is the process of restoring a consistent picture of "what orders exist and what have they done" after any interruption. Its inputs are, in decreasing authority: the exchange's own state (via an order status request or mass status request), the drop copy (§54.14), your journal (Ch. 56 §56.1), and your in-memory model — which after a crash does not exist and after a disconnect is *stale by an unknown amount*.

The recovery sequence:

1. **Reconnect and resume sequence** (§54.5). Do not reset.
2. **Consume the resend.** Every execution report generated during the outage arrives here. Apply through the idempotent state machine (§54.8) with dedup (§54.9). This alone resolves most disconnects.
3. **Reconcile in-flight orders.** For each order in `PendingNew`, `PendingCancel`, or `PendingReplace` at disconnect time, its true state is unknown. Resolve by *querying*, not by guessing: `OrderStatusRequest` (`MsgType=H`) per order, or `OrderMassStatusRequest` (`MsgType=AF`) for the whole session, which returns an execution report per live order. Venues that support mass status make recovery a single round trip; venues that do not force per-order queries, which must be throttled (§54.12) or they trip the rate limit at exactly the worst moment.
4. **Reconcile positions** against the drop copy and, at end of day, the clearing file (§54.15).
5. **Only then** re-enable order entry. A gateway that starts sending before reconciliation completes can duplicate an order it already placed or, worse, believe it is flat and take a position on top of an existing one.

**The hard case: `PendingNew` at disconnect.** You sent a new order; you have no ack. Three possibilities: the message never reached the exchange; it reached and was accepted; it reached and was rejected. Guessing wrong in either direction is expensive — assume-not-sent and re-send, and you may have two orders; assume-sent and wait, and you may have no order when you believe you have one, so a subsequent cancel does nothing and a hedge is unhedged.

The resolution is structural: **because `ClOrdID` is unique and never reused, the query is always answerable.** `OrderStatusRequest` with the original `ClOrdID` returns either the order's state or "unknown order" — a definitive answer. This is the payoff for the identifier discipline in §54.6, and it is why "never reuse a `ClOrdID`, even for rejects" is not pedantry.

**Timeouts as a state, not an error.** Every in-flight request needs a deadline. When it expires, the order does not become `Rejected` — it becomes `Unknown`, a distinct state that permits *only* status queries and cancels, never new exposure. Systems that collapse `Unknown` into `Rejected` are the ones that end the day with a phantom position.

**Diagnostic signature.** If reconciliation regularly finds orders the exchange knows about that you do not, suspect journal-after-send ordering (§54.3). If it finds orders you know about that the exchange does not, suspect `ClOrdID` reuse or a throttle rejection that your model recorded as sent. The direction of the discrepancy names the bug.

---

## 54.11 Exchange Rate Limits

Venues limit the rate at which a session may send messages, for their own protection. The limits are contractual and enforced, and exceeding them results in rejects, session disconnection, or — at some venues — fines and a compliance conversation. There are several distinct limit shapes and a gateway must model whichever ones its venues impose:

| Limit shape | Typical form | Enforcement |
|---|---|---|
| **Fixed-window** | N messages per second, reset on the wall-clock second | Simple; permits a 2N burst across a boundary |
| **Sliding-window** | N messages in any trailing 1 s | Stricter; requires a timestamp ring |
| **Token bucket** | rate R, burst B | Most common in modern venues |
| **Order-to-trade ratio (OTR)** | messages ÷ executions over a period | Measured over minutes; a *quality* limit |
| **Message-type weighted** | new = 1, cancel = 0.5, mass cancel = 10 | Encourages cancels over news |
| **Per-instrument / per-port** | Independent budgets | Must be tracked separately |

Two structural facts drive the design. First, **the exchange's counter is authoritative and you cannot read it** — you are shadowing it. Clock skew, in-flight messages, and the venue's exact window boundary mean your estimate is approximate, so you must run your own limit strictly *below* the contractual one; a headroom of 5–15% is the usual engineering choice, and the reserve exists specifically so that cancels are never throttled.

Second, **cancels must be privileged.** If a single budget covers new orders and cancels and you exhaust it sending quotes, you cannot cancel — a risk exposure created by your own throttle. The standard fix is a reserved sub-budget: order entry may consume at most X% of the bucket, leaving the remainder permanently available for cancels and mass cancels. This is a risk control implemented in the gateway, and mentioning it unprompted is a strong signal.

**Order-to-trade ratio** deserves separate treatment because it cannot be enforced instantaneously. It is a ratio measured over a long window, so the control is a slow feedback loop: monitor the running ratio, and when it approaches the threshold, reduce quoting rather than block messages. Blocking messages to satisfy an OTR limit tends to block the wrong ones (cancels raise the numerator too at some venues — check whether the venue counts cancels).

**What happens when you exceed.** Responses vary: a business reject per message (cheap, recoverable), a session-level reject, forced logout (expensive — now you are in §54.10 recovery), or silent queuing at the venue's edge (worst, because your latency inflates without any error and your orders arrive late enough to be adversely selected). The last case has a distinctive signature: *ack latency rises smoothly with send rate and returns to normal when rate falls*, with no rejects. That is queuing, not congestion, and the fix is your throttle, not your network.

---

## 54.12 Message Throttling

Throttling is the local enforcement mechanism that keeps you inside §54.11's limits. It sits on the outbound path, which means it is **on the critical path** and must cost a handful of nanoseconds.

**Token bucket, branchlessly.** The canonical implementation refills continuously rather than on a timer, so there is no timer thread and no syscall:

```cpp
class TokenBucket {
    int64_t  tokens_;          // scaled fixed point: tokens * 2^16
    uint64_t last_tsc_;
    int64_t  per_tsc_;         // refill rate, same scale
    int64_t  cap_;
public:
    // Returns true if the message may be sent; consumes one token.
    inline bool try_consume(uint64_t now_tsc, int64_t cost = 1<<16) noexcept {
        tokens_ += (int64_t)(now_tsc - last_tsc_) * per_tsc_ >> 16;
        last_tsc_ = now_tsc;
        if (tokens_ > cap_) tokens_ = cap_;
        if (tokens_ < cost) return false;
        tokens_ -= cost;
        return true;
    }
};
```

Points that matter: `now_tsc` comes from `rdtsc` (Ch. 43 §43.12), ~20 cycles, not `clock_gettime`; the refill is a multiply-shift, not a division; the state is a single cache line owned by the sending thread, so there is no atomic and no contention (Ch. 52 §52.6's single-writer discipline pays off here); the `cost` parameter carries message-type weighting for free.

**Sliding window** when the venue enforces one exactly: keep a ring of the last N send timestamps; a send is permitted iff `now - ring[head] >= window`. This is exact, O(1), and uses `N * 8` bytes — for N=1000 that is 8 KB, two pages, worth locking (Ch. 32 §32.15).

**What to do when throttled** is the real design question, and the answer is *never block*. Blocking on a hot path is a syscall and a scheduling event; worse, it means the strategy thread stalls while the market moves. Three policies, chosen per message class:

| Policy | Applies to | Rationale |
|---|---|---|
| **Reject to caller** | New orders, quote updates | The intent is time-sensitive; a delayed order is often worse than none. Caller decides. |
| **Queue (bounded)** | Cancels, cancel/replace to reduce size | Risk-reducing actions must eventually go out |
| **Bypass reserve** | Mass cancel, kill-switch cancels (Ch. 56 §56.18) | Must never be throttled |

A bounded queue with a drop-oldest policy is wrong for cancels (the oldest cancel is the most urgent); drop-newest is wrong too. The right answer for the cancel queue is *never drop* — size it to the maximum possible number of live orders, which is itself bounded by the order count limit, so the bound is known at startup and can be preallocated.

**Observability.** Export, per session: tokens remaining, throttle-rejections by message class, time spent at zero tokens, and the ratio of your throttle rate to the venue limit. A throttle that never fires may be misconfigured (too loose) and a throttle firing constantly means the strategy is over-sending. Both are invisible without counters (Ch. 59 §59.1). Increment them with plain non-atomic adds on the owning thread and publish periodically.

---

## 54.13 Cancel on Disconnect

**Cancel on disconnect** (COD) is a venue-side facility: if the session drops, the exchange automatically cancels the session's live orders. It exists because a disconnected participant cannot manage risk, and orders resting in a market you cannot see or cancel are unbounded exposure.

The mechanics and their non-obvious edges:

- **Scope.** Usually per session, sometimes per port or per firm. Orders entered on session A are not necessarily cancelled when session B drops. If you spread orders across sessions for throughput, you have spread your COD protection too.
- **Order types excluded.** GTC (good-till-cancelled) and other multi-day orders are frequently *exempt* from COD, on the reasoning that their intent spans sessions. So COD does not imply "flat after disconnect."
- **Trigger definition.** COD typically fires on abnormal disconnect, and often *not* on a graceful logout — the venue treats logout as "I am done for now, keep my orders." Some venues invert this. Read the specification; do not assume.
- **Latency.** COD is not instantaneous. The venue must detect the disconnect (TCP error, or its own heartbeat timeout — which may be 30 s) and then cancel. Between the disconnect and the cancels, your orders are live and can trade. A fill during the COD window is legitimate and you must accept it on reconnect. Candidates who say "COD means I have no risk when disconnected" are wrong by exactly the detection interval, which is the interval during which markets often move (a venue-side event that disconnects you may be correlated with a price move).
- **Reconnect races.** If you reconnect quickly, the cancels may arrive *after* your new orders. The cancel messages are for the old orders by exchange `OrderID`, so they should not touch the new ones — but a gateway that keys internal state by slot and recycles aggressively (§54.7) can mis-attribute them.

**Client-side complement.** COD is a backstop, not a strategy. The gateway should also implement local cancel-on-disconnect: on detecting loss of the market-data feed, of a downstream risk service, or of its own heartbeat to the strategy, it should proactively cancel. Because that requires a working order session, it must run *before* the session dies — which is why stale-market detection (Ch. 53 §53.8) and internal watchdogs (Ch. 56 §56.7) are wired to the cancel path with the highest priority and a reserved throttle budget (§54.12).

**Testing.** COD behaviour is exactly the kind of thing that is never exercised until it matters. The test is a fault-injection exercise (Ch. 57 §57.14): place orders in the venue's test environment, `SIGKILL` the gateway (not a graceful shutdown — that path is different), reconnect, and assert the order states you observe match the specification. Do this for each venue and each order type, and re-run it after every venue software release, because COD semantics change quietly.

---

## 54.14 Drop Copy

A **drop copy** is a separate, read-only session from the venue that delivers a copy of all execution reports and order state changes for a firm's account(s), independent of the order-entry sessions that generated them. It exists so that risk, compliance, and back-office systems can observe trading activity without sitting on the latency-critical path, and so that a firm retains visibility when an order session is down.

Why it matters to a gateway engineer:

- **It is the authoritative cross-check.** The drop copy is generated by the exchange from its own books, on a different path, so agreement between your gateway's fill stream and the drop copy is genuine independent confirmation. Disagreement is a real problem and always investigated.
- **It survives your session failure.** During a disconnect (§54.10), the drop copy continues to deliver fills, so a risk system fed from drop copy sees exposure your gateway cannot.
- **It covers all sessions and often manual activity** — trades entered by a human via the venue's GUI, or corrections applied by the exchange, appear in drop copy and never in your order session.
- **It is slower.** Drop copy is deliberately not latency-optimized; delays of milliseconds to seconds are normal. Never use it on the trading path.

Architecturally, the drop copy consumer is a separate process on the warm path (Ch. 52 §52.7) with its own session state machine (all of §54.1–§54.5 applies — it is a full FIX session with logon, heartbeats, sequencing, and resend). It writes into the reconciliation engine, not into the trading model. Keeping it out-of-process matters: a bug in drop-copy parsing must not be able to stall or crash the order gateway.

**Reconciliation logic** is a three-way set comparison over `ExecID`:

```
gateway_execs  Δ  dropcopy_execs
  ├─ in both, matching qty/price      → OK
  ├─ in drop copy only                → gateway missed a fill  (SERIOUS: position wrong)
  ├─ in gateway only                  → gateway invented a fill (SERIOUS: dedup bug or replay leak)
  └─ in both, differing qty/price     → parsing bug or a correction/bust
```

The "drop copy only" case is the one that justifies the whole facility: it catches a lost fill, which no amount of internal consistency checking can find, because internally you are consistent — just wrong. Run the comparison continuously (a streaming match with a bounded reorder window, typically 30–60 s to absorb drop-copy delay) rather than only at end of day, and alarm on any unmatched execution older than the window.

**Sequence discipline.** Drop copy has its own sequence numbers and its own gap recovery; a gap in the drop copy is not a gap in trading, but it *blinds the reconciler*, so it must alarm rather than silently gap-fill past it.

---

## 54.15 Post-Trade Reconciliation

Post-trade reconciliation is the end-of-cycle verification that your recorded state matches every external authority. It is a batch, cold-path activity, but its design constrains the hot path: you can only reconcile what you recorded, and you can only record cheaply what you designed to be recordable cheaply.

The comparison set:

| Source | Authority | Timing |
|---|---|---|
| Gateway journal (Ch. 56 §56.1) | Yours | Real time |
| Drop copy (§54.14) | Exchange, real-time | Seconds |
| Exchange end-of-day trade file | Exchange, definitive for the session | After close |
| Clearing house / prime broker file | Definitive for settlement | T+0 evening to T+1 |
| Internal position/PnL system | Yours | Continuous |

Each pair must match on: execution count, per-instrument signed quantity, and notional. Mismatches are classified by their signature:

- **Quantity matches, execution count differs** → a duplicate was collapsed on one side. Usually a dedup (§54.9) or replay leak.
- **Count matches, quantity differs on one instrument** → fixed-point scale or lot-multiplier bug (Ch. 23 §23.10, Ch. 49 §49.8). Deterministic and reproducible.
- **One extra execution near a disconnect** → an order was duplicated across reconnect; identifier discipline failure (§54.6).
- **Everything matches except late corrections** → trade busts applied by the exchange after your snapshot. Expected; the reconciler must accept corrections as first-class, not as errors.
- **Off by exactly one fill, consistently at session start** → sequence reset (§54.3) discarded a message.

**What the gateway must record for this to be possible.** For every message, in and out: the sequence number, the full raw bytes, the hardware receive timestamp or TSC at send/receive (Ch. 48 §48.4), and the internal order handle. Raw bytes matter — a normalized record cannot answer "did we mis-parse this?", which is the question you will actually need. Writing raw bytes is cheap if it is done as an append into a preallocated mapped ring with the flush handled by a separate thread (Ch. 55 §55.7); it is ruinous if it is `fprintf`.

**Determinism is the multiplier.** If the gateway's processing is deterministic given its input byte stream (no wall-clock reads embedded in logic, no map iteration order dependence, no unordered thread interleaving in the core), then a reconciliation break can be reproduced offline by replaying the journal (Ch. 57 §57.12), and the investigation takes minutes instead of days. Non-deterministic gateways produce breaks that cannot be explained, which are then written off — and a written-off break is an unmonitored bug.

---

## 54.16 At-Least-Once Processing

The delivery-semantics taxonomy, stated precisely because interviewers probe it:

- **At-most-once** — a message is delivered zero or one times. Achieved by never retrying. Loses data on failure.
- **At-least-once** — a message is delivered one or more times. Achieved by retrying until acknowledged. Duplicates are possible.
- **Exactly-once** — delivered precisely once. **Not achievable** at the transport layer between two independently-failing parties; the two-generals result forbids it. What is achievable is *effectively-once processing*: at-least-once delivery plus idempotent, deduplicating consumers.

Order gateways are irreducibly at-least-once, and the reason is worth being able to derive on the spot. To be exactly-once, the sender must know whether the receiver processed a message before deciding to retransmit. That knowledge requires an acknowledgement, which can itself be lost; if the ack is lost, the sender must choose between retransmitting (risking a duplicate) and not (risking a loss). No protocol removes that choice — it can only move it. Every "exactly-once" system in practice is at-least-once delivery with an idempotency key, which is exactly what `ClOrdID` and `ExecID` are.

The design rules that follow:

1. **Every message carries an idempotency key that is stable across retransmission.** `ClOrdID` outbound, `ExecID` inbound. Never derive the key from anything that changes on retry (timestamps, sequence numbers, connection identity).
2. **Every consumer is idempotent** (§54.8), all the way down. The gateway dedups, the order state machine is monotone, the position keeper uses absolute cumulative quantities, the risk system dedups by `ExecID`. A single non-idempotent consumer anywhere in the chain defeats the whole design.
3. **Persist before acting, on the send side; act before advancing, on the receive side** (§54.3). This is the write-ahead rule and it is what makes crash-restart equivalent to a duplicate rather than to a loss.
4. **Prefer duplicates to losses at every ambiguous decision.** A duplicate is detectable and cancellable; a loss is invisible. This is why the dup filter fails open (§54.9), why unacked orders become `Unknown` rather than `Rejected` (§54.10), and why the journal is written before the send.

The one place this rule inverts is *order submission itself*: a duplicated new order is a real, tradeable second order, and cancelling it costs money if it fills first. That is why the idempotency key must be enforced by the **exchange** — venues reject a repeated `ClOrdID` — and why you must never resend a new order after a reconnect without a status query (§54.10). The general principle "prefer duplicates" applies to *processing*; for *transmission of new exposure*, prefer querying.

---

## Key Interview Questions

1. **Why do sequenced session protocols exist on top of TCP, which already guarantees delivery?** — TCP guarantees delivery *within a connection*; sessions span connections. Sequence numbers detect messages lost to a disconnect, a peer restart, or a state mismatch, none of which TCP sees.
2. **What is the difference between `PossDupFlag` and `PossResend`?** — `PossDup` is a session-layer retransmission at the same sequence number (detectable by sequence comparison); `PossResend` is an application-layer re-issue at a *new* sequence number, detectable only by application identity such as `ExecID`.
3. **When is `ResetSeqNumFlag=Y` safe?** — Start of day, no live orders, no unreconciled fills. Intraday it discards the exchange's pending resend, which can include execution reports you never saw.
4. **Why must `ClOrdID` never be reused, even after a reject?** — Because a reject may be locally generated while the message was already on the wire, and because `OrderStatusRequest` by `ClOrdID` is the only definitive way to resolve an unacknowledged order.
5. **How do you correlate an inbound execution report to internal state in a few nanoseconds?** — Derive `ClOrdID` from a counter whose low bits are the slot index in a preallocated array; mask, load, verify the full ID. No hashing, no allocation.
6. **Why not `std::unordered_map` for the order table?** — Node-based: pointer chase per lookup, allocation per insert, free per erase. Use a preallocated open-addressed flat map, or direct indexing.
7. **A duplicated execution report arrives. Why does `cum_qty += last_qty` break and `cum_qty = max(cum_qty, e.cum_qty)` not?** — Cumulative quantity is absolute and idempotent under repetition; incremental accumulation double-counts.
8. **Which direction should a duplicate filter fail?** — Open: process the message. Dropping a real fill corrupts position silently; processing a duplicate is caught by the idempotent state machine. Never use a Bloom filter — its errors are false positives.
9. **You disconnect with an order in `PendingNew`. What is its state?** — Unknown. Resolve by `OrderStatusRequest` on the original `ClOrdID`, never by resending or by assuming. Model `Unknown` as a distinct state that permits cancels but no new exposure.
10. **Why must the journal be written before sending, but the inbound message processed before advancing the sequence number?** — Send-side: a crash after journaling and before sending yields a duplicate (recoverable); the reverse yields an untracked live order. Receive-side: a crash after processing and before advancing yields a duplicate (recoverable); the reverse loses a fill.
11. **Does cancel-on-disconnect mean you are flat after a disconnect?** — No. It fires only after venue-side detection (up to the venue's heartbeat timeout), is often per-session, and typically excludes GTC orders. Fills during the detection window are real.
12. **Why reserve throttle budget for cancels?** — Otherwise exhausting the rate limit with new orders makes you unable to cancel, converting a throughput limit into an unbounded risk exposure.
13. **Ack latency rises smoothly with your send rate, with no rejects. Diagnosis?** — Venue-side queuing against a rate limit, not network congestion. Fix the throttle, not the network.
14. **What is a drop copy and why can't you use it for trading?** — An independent read-only feed of the firm's executions from the venue; authoritative for reconciliation, but deliberately not latency-optimized (ms to s of delay) and often covering multiple sessions.
15. **Is exactly-once delivery achievable?** — No, between independently-failing parties. Achievable is at-least-once delivery plus idempotent, deduplicating consumers keyed on a retransmission-stable identifier.
16. **What does a reconciliation break where quantities match but execution counts differ tell you?** — A duplicate was collapsed on one side: a dedup or replay-leak bug, not an arithmetic one.
17. **Why must an order's correlation slot not be recycled immediately on reaching a terminal state?** — Late acknowledgements and late fills arrive for orders you consider finished; a lookup miss on a fill is a position error. Retire, then reclaim after a bound exceeding maximum venue latency.
18. **Where does throttle state live in a multi-threaded gateway?** — On the single writer that owns the session, as plain non-atomic fields in one cache line. Sharing it across threads reintroduces contention on the critical path.

---

## Common Traps

- **`ResetSeqNumFlag=Y` on an intraday reconnect** — silently discards the exchange's queued execution reports.
- **Reusing a `ClOrdID` after a reject** — makes the unacked case unresolvable and can be rejected as a duplicate at the venue.
- **`cum_qty += last_qty`** — a single duplicated execution report doubles the position.
- **Treating `PossResend` like `PossDup`** — discards legitimate messages; ignoring it double-counts fills.
- **Bloom filter for duplicate suppression** — false positives drop real fills.
- **Recycling an order slot at terminal state** — late fills land on a reused or empty slot.
- **Keying correlation on `ClOrdID` alone across sessions/days** — a stale response from a previous session resolves to a live order.
- **Keying a replace on `OrigClOrdID` when the venue responds with the new `ClOrdID`** — every replace ack becomes an unknown-order error.
- **Assuming logout cancels orders** — most venues persist them; day orders die at close, not at logout.
- **Assuming cancel-on-disconnect is immediate** — you are exposed for the venue's detection interval.
- **Closing the socket immediately after sending logout** — RST, abnormal-disconnect classification, possible unintended COD.
- **Sending before reconciliation completes on reconnect** — duplicate orders or trading on top of an unknown position.
- **A single throttle budget shared by new orders and cancels** — throttling yourself out of risk reduction.
- **Blocking when throttled** — a syscall and a scheduling event on the hot path, while the market moves.
- **Sizing the outbound message store below the day's message count** — a wrapped store cannot answer a resend request.
- **Formatting `ClOrdID` with `std::to_string`/`std::format` on the send path** — allocation and hundreds of nanoseconds.
- **Feeding the risk system from the order session only** — it goes blind exactly when the session drops; drop copy exists for this.
- **Non-deterministic gateway processing** — reconciliation breaks that cannot be reproduced get written off.
- **Assuming the exchange `OrderID` is stable across a replace** — true at most venues, not all; read it from the ack.
- **Per-order status queries during recovery without throttling** — trips the rate limit at the worst possible moment.

---

## Compact Recall Summary

**Session.** Logon negotiates heartbeat interval and sequence policy; honor the *response*. Logout is graceful and does not cancel orders — send logout, `SHUT_WR`, drain, close. Heartbeats detect blackholed peers that TCP cannot; check them with TSC deltas in the spin loop, and treat exchange-initiated heartbeat disconnects as evidence of a *local* stall.

**Sequencing.** One integer per direction, increment by one, gap ⇒ something was generated and not delivered. Gap-fill replaces administrative messages during a resend; hard reset discards the loss detector and is supervised. `ResetSeqNumFlag=Y` is start-of-day only. Persist outbound *before* sending; process inbound *before* advancing — the asymmetry is what makes crash-restart a duplicate rather than a loss.

**Recovery.** Reconnect with backoff and jitter, long backoff on auth failures, resume rather than reset, use `NextExpectedMsgSeqNum` where available. Consume the resend, then resolve every `PendingNew`/`PendingCancel`/`PendingReplace` by *querying* (`OrderStatusRequest`, `OrderMassStatusRequest`), then reconcile, then enable sending. Unresolved in-flight orders go to a distinct `Unknown` state permitting cancels only.

**Identity.** `ClOrdID` is yours and exists before the send — the only key usable for an unacked order; `OrderID` is the exchange's and appears on the ack; replaces form a `ClOrdID` chain via `OrigClOrdID`. Never reuse a `ClOrdID`. Carry a dense internal `OrderIdx` distinct from both. Build `ClOrdID` from bit-packed fields with the counter's low bits as the array slot, so correlation is a mask, a load, and a verify — not a hash probe.

**Idempotence.** Rank states and ignore backwards transitions; apply `cum_qty` absolutely, never incrementally; dedup exactly by `ExecID`, and treat corrections/busts as legitimate revisions that must *not* be ignored. Dedup filters fail open; the state machine is the exact defence behind them.

**Rate control.** Venue limits are fixed-window, sliding-window, token-bucket, weighted, or order-to-trade ratios; you shadow an unreadable counter, so run 5–15% below the contractual limit. Token bucket refilled from `rdtsc`, single-writer, no atomics. Reserve budget for cancels. Never block on throttle: reject new orders to the caller, queue cancels in a bound sized to the maximum live-order count, and bypass entirely for mass cancel and kill switches.

**Cross-checks.** Cancel-on-disconnect is a venue backstop with a detection delay, per-session scope, and GTC exemptions — complement it with local proactive cancellation driven by watchdogs and stale-market detection. Drop copy is the independent authority: three-way `ExecID` set comparison catches the fill you missed, which internal consistency checking never can. Post-trade reconciliation against drop copy, exchange EOD, and clearing files classifies breaks by signature — count-vs-quantity mismatch names the bug class.

**Semantics.** Exactly-once delivery is impossible between independently failing parties; the achievable target is at-least-once delivery with idempotency keys and idempotent consumers end-to-end. Prefer duplicates to losses everywhere in *processing*; invert only for transmission of new exposure, where a duplicate is a real second order — there, query rather than resend.
