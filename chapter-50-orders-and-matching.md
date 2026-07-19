# Chapter 50 — Orders and Matching

*Interview-focused revision notes. The theme: an order is a state machine racing an exchange's state machine over a lossy, reordering channel — this chapter defines every order type precisely, then builds the book and the matching engine that resolve them.*

---

## 50.1 Market Orders

A **market order** is an instruction to execute immediately at the best available price, with no price limit. It expresses urgency: it trades whatever the book offers, walking successive price levels (Ch. 49 §49.2) until the requested quantity is filled or the book is exhausted.

```
Asks:  100.03 × 800 | 100.04 × 300 | 100.05 × 1500
BUY 1500 @ MARKET  →  800 @ 100.03, 300 @ 100.04, 400 @ 100.05
                      VWAP 100.0385
```

**Semantics on exhaustion** differ by venue and are the substance of the topic:

| Venue behaviour | Effect if the book cannot fill the order |
|---|---|
| **Cancel remainder** | The unfilled part is cancelled (a market order behaves as market-IOC). Most common on futures. |
| **Rest at the last traded price** | Remainder rests as a limit order — CME's "market with protection" converts to a limit at the protection price. |
| **Reject entirely** | Some venues reject market orders in thin or halted books. |
| **Convert to limit at the band edge** | Under price banding (Ch. 49 §49.13) it becomes a limit at the band. |

**Market orders are dangerous in a way engineers must internalize.** They contain no price information, so any book state — including a book emptied by a spike, or a stale book of your own construction — is accepted. The canonical incident is a market order sent into a thin book that walks twenty levels and executes at a price nobody intended. Consequences for design:

1. **Pre-trade price collars are mandatory** (Ch. 56 §56.13). Most firms convert market orders into aggressive limit orders internally: take the far touch and add a bounded number of ticks. This preserves near-certain immediacy while capping the damage.
2. **Market orders are usually forbidden on the hot path** of an automated strategy for exactly this reason; the marginal immediacy over a marketable limit priced several ticks through is negligible, and the tail risk is unbounded.
3. **They cannot be simulated accurately** in a backtest without full depth, because the fill price depends on the whole book, not the touch.

**"Market with protection"** (CME) is worth naming precisely: the order executes as a market order but only within a configured number of ticks from the reference price; the remainder rests as a limit at the protection boundary rather than sweeping arbitrarily deep. It is the venue implementing the collar you should have implemented yourself.

**Auction context.** A market-on-open / market-on-close order (Ch. 49 §49.12) participates in the auction with no limit and executes at the single uncross price. Here the unbounded-price concern is different: the auction price is determined collectively, so a market order in an auction cannot walk a book, but it can execute at a surprising uncross price if the auction is imbalanced.

**Representation note.** Do not encode a market order as a limit at `INT64_MAX` / `INT64_MIN` unless you have audited every arithmetic path that touches price — the sentinel will overflow the moment someone computes `price × multiplier × qty` or `price + ticks` (Ch. 23 §23.13 on sentinel hazards). Carry an explicit `OrderType` discriminant and make price optional.

---

## 50.2 Limit Orders

A **limit order** specifies a worst acceptable price: a buy executes at or below its limit, a sell at or above. It is the fundamental order type — everything in the limit order book (§50.13) is a resting limit order.

**The two behaviours in one type.** Whether a limit order is passive or aggressive is not a property of the order; it is determined by the book at the moment it arrives:

```
Book: bid 100.01 × 500 | ask 100.03 × 800

BUY 200 @ 100.00  →  no cross; RESTS on the bid at 100.00 (passive / maker)
BUY 200 @ 100.03  →  crosses; EXECUTES against the ask (aggressive / taker)
BUY 200 @ 100.05  →  crosses; executes at 100.03 — the RESTING price, not yours
BUY 2000 @ 100.04 →  takes 800 @ 100.03, then RESTS 1200 at 100.04
```

**Price improvement is a hard rule: the trade executes at the resting (maker's) price, not the aggressor's limit.** A buyer willing to pay 100.05 who crosses a 100.03 offer pays 100.03. This follows from time priority — the resting order was there first and set the terms — and it is why an aggressive limit priced deep through the book is a safe way to express urgency (§50.1). Candidates who say the trade happens "at the midpoint" or "at the aggressor's price" are revealing they have not read a matching engine.

**Marketable limit order** is the precise term for a limit order that crosses on arrival. The **residual** — quantity remaining after the crossing portion executes — rests at the order's limit price unless a time-in-force qualifier says otherwise (§50.6, §50.7).

**Fields a limit order carries** (the minimum viable order message, Ch. 51 §51.2):

| Field | Notes |
|---|---|
| Client order ID | Your unique identifier; the venue echoes it (Ch. 54 §54.6) |
| Instrument identifier | Venue-native numeric ID (Ch. 49 §49.9) |
| Side | Buy / Sell (and for some markets Sell-Short, which is a distinct regulated side) |
| Price | Integer, on the tick grid (Ch. 49 §49.7) |
| Quantity | Integer, a multiple of the lot increment (Ch. 49 §49.8) |
| Time in force | Day, IOC, FOK, GTC, GTD (§50.6–§50.8) |
| Order type | Limit, market, stop, pegged (§50.1–§50.4) |
| Flags | Post-only, display/hidden, minimum quantity, self-trade prevention (§50.5, Ch. 56 §56.20) |
| Account / capacity | Regulatory routing and clearing fields |

**Validation, all of which must happen before the wire** (fail closed, Ch. 56 §56.13–§56.17): price on the tick grid and within bands, quantity a valid multiple and within limits, instrument tradeable in the current session state (Ch. 49 §49.11), notional within credit limits, and the client order ID unique. A reject costs a round trip you cannot afford; every reject the venue sends you is a validation you should have done locally.

**Sell-short** deserves a note as a domain landmine: in US equities, short sales are a distinct side with locate requirements and, under Reg SHO Rule 201, a price test that activates after a 10% decline and restricts short sales to prices above the NBB. Encoding "sell" and "sell short" as the same value in your order type is a compliance defect, not an optimization.

---

## 50.3 Stop Orders

A **stop order** is an order that is not live in the book until a **trigger** (stop price) is reached; upon triggering it becomes a market order (**stop-market**) or a limit order at a specified price (**stop-limit**).

```
Instrument trading at 100.00.
SELL STOP 500 @ 99.50           → dormant. When the trigger condition fires,
                                  becomes SELL 500 @ MARKET.
SELL STOP-LIMIT 500, stop 99.50, limit 99.40
                                → on trigger, becomes SELL 500 @ 99.40 (may not fill).
```

**Direction convention.** A sell stop triggers when the market falls to or below the stop price; a buy stop triggers when it rises to or above. (Buy stops sit *above* the market, sell stops *below* — the inverse of limit orders, which is a reliable source of confusion.)

**The trigger reference is venue-specific and must be read from the spec:**

| Reference | Fires on |
|---|---|
| Last trade price | A trade at or through the stop |
| Best bid / best offer | The quote reaching the stop (protects against a single stray print) |
| Midpoint | Mid crossing the stop |
| Index or reference price | Derivative instruments tracking an underlying |

The choice matters: a last-trade trigger can be fired by one odd-lot print in a thin book; a BBO trigger cannot. Some venues require two consecutive qualifying prints.

**Where stop orders live.** Untriggered stops are held by the matching engine in a separate structure — normally a pair of priority queues (or price-indexed buckets) keyed by stop price, one for buy stops sorted ascending and one for sell stops descending, so that after each trade the engine pops all stops whose trigger has been reached in O(k log n) for k triggered. They are **not in the visible book** and contribute nothing to displayed depth (Ch. 49 §49.2).

**Cascade / stop-run dynamics** — a mechanical property, stated descriptively. Triggered stop-market orders are aggressive orders, which move the price further, which can trigger more stops. In thin books this produces a rapid one-directional move. The engineering consequences are what matter: a burst of triggered stops is a **capacity event** (thousands of orders entering the engine in one instant, Ch. 56 §56.10), and the resulting price move is exactly the condition under which volatility halts fire (Ch. 49 §49.13). Systems must be sized for it and must not treat the resulting book as anomalous.

**Synthetic (client-side) stops.** Many firms hold stops locally and submit an order when their own book triggers. Tradeoffs:

| Exchange-native stop | Client-side synthetic stop |
|---|---|
| Triggers at engine speed, zero latency | Triggers after feed latency + your reaction time |
| Survives your disconnect | Dies with your process (unless persisted) |
| Trigger logic fixed by the venue | Arbitrary trigger logic (multi-instrument, time-based) |
| Visible to the venue's risk systems | Invisible; your risk system must account for it |
| Not all venues support all variants | Uniform across venues |

**Failure modes.** Stop-limit orders that trigger during a fast move commonly do not fill, because the market has already passed the limit — the diagnostic signature is a triggered order resting untouched at a price far from the market, and a position that is not protected while everyone believes it is. Stop-market orders always fill but with no price control (§50.1). This is the exact tradeoff the two types encode, and interviewers ask it.

---

## 50.4 Pegged Orders

A **pegged order** has a price defined *relative to a reference*, which the matching engine recalculates and re-prices automatically as the reference moves. The client submits the peg definition once instead of continuously cancel/replacing.

**Peg types:**

| Peg | Reference | Typical use |
|---|---|---|
| **Primary peg** | The *same-side* best quote (bid for a buy) | Stay at the touch |
| **Market peg** | The *opposite-side* best quote (ask for a buy) | Aggressive positioning |
| **Midpoint peg** | (bid + ask) / 2 | Execute between the touch |
| **Peg to last / reference price** | Last trade, or an index | Derivative-linked |

**Offset and limit.** A peg carries an **offset** (in ticks or price units, e.g. primary peg minus 1 tick) and usually a **limit price** capping how far the peg will follow. The limit is the safety net: a pegged order with no cap follows the market anywhere.

```
Book: bid 100.01 / ask 100.03
BUY, primary peg, offset 0, limit 100.05   →  effective price 100.01
Bid moves to 100.02                        →  engine reprices to 100.02
Bid moves to 100.06                        →  capped at limit 100.05
```

**Mechanics the implementation must respect:**

1. **Repricing costs queue position.** Each reprice is a price change, and a price change loses time priority (Ch. 49 §49.4). A primary-peg order that follows a jittering bid ends up perpetually at the back of the queue. This is why pegs are not automatically better than a static limit — they trade priority for price tracking.
2. **Midpoint pegs can land off the tick grid.** With a one-tick spread the midpoint is a half-tick. Venues resolve this by allowing sub-tick execution for midpoint pegs (a common exception to tick rules) or by rounding in a defined direction. Your book model must accept a sub-tick execution price without asserting.
3. **Pegs are typically hidden** or partially displayed, so they contribute invisible liquidity — relevant to the "displayed depth ≠ available depth" point (Ch. 49 §49.2).
4. **The repricing cascade is a load event for the engine.** One BBO change can reprice thousands of pegged orders, each generating book updates. Venues that publish per-order updates emit that entire cascade onto the feed; your feed handler must absorb it. Signature: a single small quote change followed by a burst of hundreds of order updates at exactly the same timestamp.
5. **Peg evaluation order versus incoming aggressors** defines whether a repriced peg can be executed by the same event that moved the reference. This is venue-specific and observable only from the specification or from careful measurement — assume nothing.

**Discretionary orders** are the near relative: a displayed limit price plus a hidden *discretionary range* within which the order will execute aggressively if an opportunity arrives. Displayed at 100.01 with discretion to 100.03 means it shows as a 100.01 bid but will trade up to 100.03.

**Native peg vs client-side reprice** is the same tradeoff as §50.3: native pegs reprice at engine speed with no round trip and no message traffic; client-side repricing costs a full round trip per move, generates order-entry rate-limit consumption (Ch. 54 §54.11), and is always behind. Where a venue offers a native peg that matches your intent, it is strictly faster.

---

## 50.5 Post-Only Orders

A **post-only** order (also *add-liquidity-only*, *ALO*, *maker-only*, *participate-do-not-initiate*) instructs the venue: this order must not remove liquidity. If it would cross on arrival, the venue does something other than execute it.

**The three possible behaviours, which differ by venue and must be configured per venue:**

| Behaviour | Result on arrival at a crossing price |
|---|---|
| **Reject** | The order is rejected outright; you get a reject message and no position |
| **Reprice / slide** | The price is adjusted to the best non-crossing price (one tick behind the opposite touch) and it rests |
| **Cancel** | Accepted then immediately cancelled |

```
Book: bid 100.01 / ask 100.03
BUY 500 @ 100.03, post-only:
   reject venue   → Reject("would remove liquidity")
   slide venue    → rests at 100.02 (or 100.01, venue-dependent)
   cancel venue   → Accepted then Cancelled
```

**Why it exists.** Two reasons, both mechanical: (1) fee economics — the taker fee versus maker rebate difference (Ch. 49 §49.6) can invert the value of an accidental take; (2) protection against a stale book. If your book is behind and you compute a price that has become marketable, post-only converts what would be an unintended aggressive execution into a harmless reject. That second use is a genuine **safety mechanism** and is the more interesting answer.

**Consequences for the order state machine** (§50.9):

- A post-only reject is a *normal, expected* outcome, not an error. If your system treats every reject as an incident, post-only will generate constant false alarms. Classify reject reason codes and handle "would cross" as an ordinary state transition (Ch. 54 §54.9).
- On a **slide** venue, **the order rests at a price you did not specify.** Any code that assumes `order.price == what_I_sent` is now wrong — your position and quoting logic must read the price back from the acknowledgement. This is a classic and expensive bug: a system quoting a two-sided market whose bid silently slid a tick, causing it to re-quote in a loop.
- Post-only interacts with **self-trade prevention** (Ch. 56 §56.20): if your own resting order is the far touch, a post-only order may be rejected for crossing yourself, with a different reason code.

**Diagnostic signature of misconfigured post-only:** a burst of rejects at exactly the moments the spread narrows to one tick, because that is when your intended passive price becomes marketable. Rate correlates with volatility, not with volume.

---

## 50.6 Immediate-or-Cancel Orders

**Time in force (TIF)** specifies how long an order remains active. **Immediate-or-cancel (IOC)** means: execute whatever can be executed immediately against the resting book, then cancel any remainder. An IOC order never rests.

```
Book asks: 100.03 × 300 | 100.04 × 1000
BUY 1000 @ 100.04 IOC  →  fills 300 @ 100.03, 700 @ 100.04  (fully filled here)
BUY 1000 @ 100.03 IOC  →  fills 300 @ 100.03, cancels 700
BUY 1000 @ 100.02 IOC  →  fills 0, cancels 1000  (no execution at all)
```

**IOC permits partial fills** — this is the defining difference from fill-or-kill (§50.7). An IOC that fills nothing generates an immediate cancel/expire, not a reject: the order was valid, it simply found nothing to trade with.

**Why IOC is the workhorse of automated trading:**

1. **Bounded state.** An IOC either fills or is gone within one round trip. There is no resting order to track, no risk of a forgotten order, no exposure to a market that moves later. Your open-order table stays small and your reconciliation problem stays simple (Ch. 54 §54.7).
2. **No queue-position management.** It never rests, so time priority (Ch. 49 §49.4) is irrelevant.
3. **Deterministic risk.** Maximum exposure is the order's notional, resolved within microseconds.

**Comparison of the immediate TIFs:**

| TIF | Partial fills | Remainder | Resting |
|---|---|---|---|
| IOC | Allowed | Cancelled | Never |
| FOK | **Not allowed** (all-or-nothing) | Cancelled if not fully fillable | Never |
| Day / GTC | Allowed | Rests | Yes |
| **Minimum quantity (MinQty)** | Allowed above the minimum | Depends | Depends |

**Minimum quantity** is the underrated qualifier: `IOC with MinQty = N` executes only if at least N can be filled immediately, otherwise nothing. It sits between IOC and FOK and is the right tool when a tiny fill is worse than no fill (because it incurs fixed costs or reveals information) but you do not require the full size.

**Sweeping** is the standard use: an IOC priced through several levels takes all liquidity down to its limit. Because a marketable limit executes at resting prices (§50.2), a sweep priced aggressively takes only what is actually there at the prices that are there — it does not "pay" its limit price on every level. This is why the pattern "aggressive limit + IOC" is preferred over a market order in essentially all automated systems: it caps the worst price, permits partial execution, and leaves no residual state.

**Implementation detail worth knowing:** an IOC that arrives when a matching engine is mid-way through processing a batch still matches against the book *as of its own processing point* in the sequential order (§50.18). There is no "look ahead"; deterministic sequential processing means an IOC sees exactly the book left by the immediately preceding message, which is what makes fill simulation reproducible.

---

## 50.7 Fill-or-Kill Orders

**Fill-or-kill (FOK)** means: execute the entire quantity immediately, or cancel the entire order. No partial fills, no resting.

```
Book asks: 100.03 × 300 | 100.04 × 500   (800 available at ≤ 100.04)
BUY 1000 @ 100.04 FOK  →  KILLED. 1000 not available; zero executes.
BUY  800 @ 100.04 FOK  →  fills 300 @ 100.03 + 500 @ 100.04.
BUY  800 @ 100.03 FOK  →  KILLED. Only 300 available at ≤ 100.03.
```

**The engine must evaluate feasibility before executing anything.** That is the implementation point: matching for FOK is a two-pass operation — walk the book accumulating available quantity at acceptable prices without mutating state, and only if the total meets the full order quantity do you perform the actual execution pass. A single-pass "match as you go, roll back if short" design requires transactional rollback of book state and of any already-emitted executions, which is far worse. A candidate who describes the dry-run pass has thought about it.

```cpp
// Two-pass FOK against the ask side (buy order).
uint64_t available = 0;
for (auto& lvl : asks_from_best()) {
    if (lvl.price > limit_px) break;
    available += lvl.total_qty;
    if (available >= order_qty) break;
}
if (available < order_qty) { emit_cancel(order, Reason::FokUnfillable); return; }
execute_sweep(order);   // second pass, now guaranteed to complete
```

Note the early `break` once `available >= order_qty`: you need only prove sufficiency, not compute the total.

**AON (all-or-none)** is the related but distinct type: all-or-nothing like FOK, but it may **rest** in the book waiting for enough contra liquidity to arrive. AON orders are difficult for a matching engine because they break the simple "match top of book" invariant — a resting AON of 1000 cannot be filled by an incoming 400, so the engine must, on each incoming order, check whether any resting AON is now satisfiable. Many venues therefore do not support AON, or support it only as a hidden non-displayed type with lower priority. Being able to explain *why* AON is hard is a strong signal.

| | FOK | AON | IOC + MinQty |
|---|---|---|---|
| Partial fill | Never | Never | Above the minimum |
| Rests | No | **Yes** | No |
| Engine complexity | Two-pass, simple | High — breaks top-of-book matching | Two-pass, simple |
| Availability | Widely supported | Often unsupported | Common |

**When FOK is used:** situations where a partial position is worse than none — the classic being multi-leg or cross-venue execution where an unmatched leg leaves unwanted exposure. Note it is not a substitute for atomicity across venues: FOK on venue A guarantees nothing about venue B, and two FOKs sent simultaneously can both fill, both kill, or split. Genuine multi-leg atomicity requires a venue-supported **spread/combination instrument**, where the engine matches the legs as a unit.

**Failure mode.** FOK against a book with hidden liquidity (Ch. 49 §49.2) can be killed even though sufficient liquidity existed, because the engine's feasibility check may or may not consider non-displayed orders — venue-specific. Symptom: FOKs killing at rates inconsistent with displayed depth. Also: FOK evaluated against *displayed* size in an iceberg-heavy book systematically under-fills.

---

## 50.8 Good-Till-Cancelled and Dated Orders

TIF values for orders that persist beyond immediate execution:

| TIF | Lifetime |
|---|---|
| **DAY** | Until the end of the current trading session; cancelled by the venue at close |
| **GTC** (good-till-cancelled) | Until explicitly cancelled, across sessions — subject to venue maximum (commonly 30–90 days) |
| **GTD** (good-till-date) | Until a specified date, then auto-cancelled |
| **GTT / GTX** (good-till-time) | Until a specified time within the session |
| **OPG / ATO** | Opening auction only; cancelled if not executed at the open |
| **ATC / MOC / LOC** | Closing auction only |
| **GFA/GFX** (good-for-auction) | Auction phases only |

**Session-boundary semantics are the whole topic.** A DAY order is *purged by the venue* at session end; a GTC order is *carried over*. That difference creates real engineering obligations:

1. **Persistence.** A GTC order outlives your process. Your order state must be durable (a write-ahead journal, Ch. 56 §56.1) and reconstructable at startup — the venue believes the order exists whether or not you do. A GTC order you have forgotten is an unmonitored, unhedged position waiting to happen.
2. **Startup reconciliation is mandatory** (Ch. 54 §54.14, Ch. 60 §60.5). On connect, request the venue's open-order list and reconcile it against your journal. Three outcomes: matched (fine), venue-has-not-mine (adopt or cancel it — never ignore), mine-not-venue (resolve from drop copy or fills).
3. **Client order ID uniqueness must span sessions.** Many venues require order IDs unique per day; a GTC order's ID persists across days. Reusing an ID that a live GTC order holds is a reject at best and a mis-correlated fill at worst. Encode date or a monotonic epoch into the ID scheme (Ch. 54 §54.6).
4. **Corporate actions** (Ch. 49 §49.10) act on resting GTC orders overnight — usually cancelling them, sometimes adjusting price and quantity by the split ratio. Your recorded state is wrong until you re-reconcile after every corporate action.
5. **Cancel-on-disconnect does not cover GTC.** CoD (Ch. 54 §54.13) is usually configured to purge day orders on session loss; whether it touches GTC is venue- and configuration-specific, and assuming it does is how orders survive a failover you thought was clean.

**GTD date semantics.** The expiry date is interpreted in the *venue's* timezone with the venue's calendar, not yours. A GTD order dated "2026-07-19" expires at the close of that venue's session; if that day is a venue holiday the behaviour is venue-defined. Store expiry as an explicit (venue, local-date) pair, never as a UTC instant derived by your own timezone arithmetic (Ch. 15 §15.12 on the calendar/timezone library). Signature of getting this wrong: orders expiring exactly one session early or late, clustered in venues whose timezone offset crosses a date boundary relative to yours.

**Why automated low-latency systems rarely use GTC.** Persistent orders carry state across the one boundary — process restart — where your state is least trustworthy, and they must be revalidated against a market that has moved overnight. The dominant pattern is DAY or IOC orders with explicit re-establishment at session start, which makes the system's state derivable rather than inherited. GTC is a manual/institutional-workflow feature, and knowing why it is avoided is more valuable than knowing its syntax.

---

## 50.9 Order Lifecycle State Machine

Every order-management system is, at its core, one state machine per order driven by messages from the venue. Getting the states and their transitions right is the single most-tested design topic in trading-systems interviews.

**The canonical states** (FIX `OrdStatus` names, tag 39, are the lingua franca; Ch. 51 §51.2):

```
                 ┌──────────────┐
   [create] ───► │ PendingNew   │ ── Reject ──────────────► Rejected (terminal)
                 └──────┬───────┘
                        │ Ack (New)
                        ▼
                 ┌──────────────┐  partial fill   ┌──────────────────┐
                 │     New      │ ──────────────► │ PartiallyFilled  │
                 │  (working)   │ ◄───────────────┤                  │
                 └──┬────────┬──┘                 └────────┬─────────┘
       CancelReq    │        │ full fill                   │ full fill
            ▼       │        ▼                             ▼
   ┌────────────────┴─┐   ┌────────┐                  ┌────────┐
   │ PendingCancel    │   │ Filled │ (terminal)       │ Filled │
   └───┬──────────┬───┘   └────────┘                  └────────┘
       │ Ack      │ CancelReject (too late / unknown)
       ▼          ▼
  ┌──────────┐   back to previous state
  │ Canceled │ (terminal)          Also: Expired, DoneForDay, Replaced
  └──────────┘
```

**Terminal states**: `Filled`, `Canceled`, `Rejected`, `Expired`, `DoneForDay`. Once terminal, an order accepts no further transitions — *except* that late messages may still arrive (§50.11) and must be handled without corrupting state.

**The invariant to assert everywhere** (Ch. 49 §49.8):

```
order_qty == cum_qty + leaves_qty + canceled_qty
leaves_qty == 0  ⟺  state is terminal
cum_qty is monotonically non-decreasing
```

Violations of the monotonicity of `cum_qty` are the signature of duplicate or out-of-order execution processing (§50.12).

**Pending states exist because of latency, and this is the core insight.** Between sending a new-order message and receiving its acknowledgement, the order's true state is *unknown to you but known to the venue*. `PendingNew` and `PendingCancel` represent "I have requested a transition; the venue has not confirmed." During `PendingNew` the order may already be filling — a fill can and does arrive **before** the new-order acknowledgement, because the venue emits the execution as soon as it happens and message ordering across message types is not always guaranteed by your transport path.

**Therefore: never treat a fill for an unknown order ID as an error.** Design rule — the order record must be created *before* the message is sent, keyed by client order ID, so that any inbound message can be correlated regardless of arrival order (Ch. 54 §54.7). A system that creates the record on acknowledgement drops fills.

**Idempotency** (Ch. 54 §54.8). Every transition must be safe to apply twice, because the transport is effectively at-least-once (Ch. 54 §54.16). Two disciplines:

1. **Key executions by the venue's execution ID** and maintain a seen-set; a repeated execution ID is discarded, not re-applied.
2. **Prefer absolute over relative updates.** Venues that report `cum_qty` and `leaves_qty` (absolute) let you make application idempotent by assignment; venues that report only `last_qty` (relative) force you to depend on exactly-once delivery, which you do not have. Where both are present, reconcile: `assert(new_cum_qty == old_cum_qty + last_qty)` and treat a mismatch as a duplicate or a gap.

**Timeouts.** Every pending state needs a timer. A `PendingNew` with no response after N milliseconds is an unknown-state order — the *worst* state in trading, because you may or may not have a position. The correct response is to stop trading that instrument and query the venue (order status request, or drop copy, Ch. 54 §54.14), not to resend blindly, which risks a duplicate order.

---

## 50.10 Cancel, Replace and Fill Races

A **cancel** requests removal of a resting order. A **cancel/replace** (order modify, amend) requests a change to price and/or quantity. Both race against executions that are already in flight, and the resulting semantics are the most subtle part of order management.

**The fundamental race:**

```
  You                          Wire                       Exchange
   │ send Cancel(ord=X) ──────────────────────►│
   │                                            │ ← Fill(X) already emitted at t0
   │ ◄──────────────── Fill(X, 500) ────────────│
   │ ◄──────────────── CancelReject(X, "too late / already filled") ─┤
```

The cancel and the fill crossed on the wire. **A cancel request is never a guarantee**: until the venue acknowledges it, the order can still execute. This is why every risk model must treat a pending-cancel order as *fully live* — assuming a cancel succeeded is how firms exceed position limits.

**Cancel outcomes:**

| Outcome | Meaning |
|---|---|
| `CancelAck` (order status = Canceled) | Order removed; `leaves_qty` released |
| `CancelReject`, reason "too late to cancel" | The order filled (fully or the cancel arrived after the fill) |
| `CancelReject`, reason "unknown order" | The order never existed, already terminal, or your ID is wrong |
| Nothing (timeout) | Unknown state — query, do not resend |

**Cancel/replace semantics.** Two distinct venue models, and knowing the difference is a discriminator:

| Model | Behaviour |
|---|---|
| **Atomic modify** | The venue mutates the resting order in place. Priority preserved for quantity decreases, lost for price changes or increases (Ch. 49 §49.3). One order ID or a new one, venue-dependent. |
| **Cancel/replace as two operations** | The venue cancels the old and inserts a new one. There is a window in which *neither* is live — you can miss a fill you would otherwise have received. Some venues guarantee no such window. |

**Quantity reduction and the overfill hazard.** Replacing an order to reduce quantity from 1000 to 400 races with a fill:

```
Resting 1000.  You send Replace(qty 1000 → 400).
Meanwhile 700 executes.
Venue applies: cum_qty = 700 already; new order_qty 400 < cum_qty 700.
```
Venue behaviour here is defined and must be known: most venues **reject the replace** if the new quantity is less than or equal to `cum_qty`, and some treat it as an implicit cancel of the remainder. Under FIX semantics, a replace to a quantity below `cum_qty` is generally rejected and the original remains working — meaning your intended reduction did not happen. Assuming otherwise leaves you with more exposure than you believe.

**Never issue a replace based on a stale `leaves_qty`.** Compute the target as an absolute new `order_qty`, and be prepared for the replace to be rejected because reality moved.

**Ordering and the ChainedClOrdID discipline.** FIX cancel/replace uses `ClOrdID` (the new ID), `OrigClOrdID` (the ID being replaced), and the venue's `OrderID`. Chains form: X → X' → X''. Rules that keep this sane:

1. **One outstanding request per order at a time.** Do not send a second replace while the first is pending; venues may process them out of order, and the chain becomes ambiguous. Serialize per order.
2. **Correlate by the venue's `OrderID` for fills**, by `ClOrdID` for request/response. Fills reference the venue ID, which is stable across the chain.
3. **A replace that is rejected leaves the *original* order working** — not cancelled. Systems that optimistically mark the original as replaced then see fills for a "dead" order.

**Mass cancel** (Ch. 56 §56.19) is the escape hatch: a single message cancelling all orders for an instrument, session, or firm. It is the correct response to an unknown-state situation, and it is what a kill switch invokes. Every gateway must support it, must have it tested, and must not depend on the order table being correct in order to invoke it.

---

## 50.11 Late Acknowledgements

A **late acknowledgement** is a response that arrives after your system has already concluded — by timeout — that the request would not be answered. It is the hardest class of failure in order management because the correct action depends on information you do not have.

**Where lateness comes from:** exchange gateway queueing under load (auction bursts, §49.12), a TCP retransmission after loss (Ch. 38 §38.8), head-of-line blocking behind a large message (Ch. 38 §38.15), garbage in your own receive path, or a rate limiter throttling you (Ch. 54 §54.11–§54.12).

**The state space after a timeout on a new order:**

| Reality | Your belief if you assume "not sent" | Consequence |
|---|---|---|
| Never reached the venue | Correct | None |
| Reached, rejected | Correct outcome, wrong reason | Minor |
| Reached, resting | **Wrong** | Unmonitored live order |
| Reached, filled | **Wrong** | Unknown position |

Because two of four outcomes are dangerous, **the only safe posture is: on timeout, assume the order may be live.** Concretely:

1. Move the order to an `Unknown` state that risk treats as fully live (worst case).
2. Stop sending new orders for that instrument (fail closed).
3. Query: order status request, mass status request, or drop copy (Ch. 54 §54.14).
4. Only after positive confirmation do you resume.

**Never blindly resend.** A resend after a timeout is how you end up with two orders and double the position. If you must have retry semantics, they must be *idempotent by construction*: the same client order ID, so the venue's duplicate detection rejects the second (Ch. 54 §54.9) — which works only if the venue actually enforces uniqueness, which you must verify per venue rather than assume.

**Late acks after a terminal transition** are the specific case named by this section. You timed out, moved the order to `Unknown`/`Canceled`, and then the ack arrives:

```cpp
void on_ack(const Ack& a) {
    Order* o = by_clordid(a.clordid);
    if (!o) { record_orphan(a); alarm(); return; }   // never silently drop
    if (o->is_terminal()) {
        // A late ack for an order we already closed out.
        // Do NOT ignore it: it may mean the order is actually WORKING at the venue.
        metrics.late_ack++;
        reopen_as_unknown(o, a);   // resolve via status query / drop copy
        return;
    }
    o->apply(a);
}
```

**The rule: never silently discard an inbound message you cannot correlate.** Log it, count it, alarm on it. A silently dropped execution is an untracked position, and the discrepancy surfaces hours later in post-trade reconciliation (Ch. 54 §54.15) — by which time it is expensive.

**Timeout tuning.** Set the timeout from the measured distribution, not a round number: p99.99 of ack latency plus generous margin. Too short produces constant false unknowns (and a system that stops trading whenever the venue is briefly slow); too long delays detection of a genuinely lost order. Instrument the ack-latency histogram in production (Ch. 59 §59.4) and alarm on distribution shift, which is a leading indicator of a venue problem before any timeout fires.

**Cancel-on-disconnect as the backstop.** If you cannot resolve state, disconnecting the session triggers CoD (Ch. 54 §54.13) and the venue cancels your working orders. That is a blunt but sound emergency lever — provided CoD is actually enabled, covers the order types you use (§50.8), and you have tested it.

---

## 50.12 Duplicate Execution Messages

A **duplicate execution** is the same fill delivered more than once. Applied twice, it doubles your recorded position, which then propagates into risk, hedging, and P&L. Every order system must be idempotent against this.

**Sources of duplicates:**

| Source | Mechanism |
|---|---|
| Session-level resend | FIX resend request after a sequence gap replays messages you already got (Ch. 54 §54.4) |
| `PossDupFlag` / `PossResend` | The venue explicitly marks a message as possibly already sent |
| Your own reconnect | Reconnecting and requesting replay from a checkpoint that is behind your actual processing point |
| Redundant sessions | Primary and backup order sessions both delivering |
| Drop copy | Drop-copy feed carries the same fills as the order session by design (Ch. 54 §54.14) |
| Internal replay | Your own crash recovery replaying a journal past the last applied event (Ch. 56 §56.3) |

**The correct defence: dedupe on the venue's execution identifier.** Each execution report carries a venue-assigned unique ID (FIX `ExecID`, tag 17). Maintain a seen-set and discard repeats.

```cpp
// Bounded, allocation-free dedupe on the hot path.
// ExecIDs are typically monotonic per session; keep a ring of recent IDs
// plus a high-water mark so the set cannot grow without bound.
class ExecDedupe {
    uint64_t high_water_ = 0;
    absl::flat_hash_set<uint64_t> recent_;   // bounded; pruned below high_water - W
public:
    bool is_new(uint64_t exec_id) {
        if (exec_id <= high_water_ - WINDOW) return false;   // definitely old
        return recent_.insert(exec_id).second;
    }
};
```

Design notes: an unbounded set leaks; a pure high-water mark fails when execution IDs are not strictly ordered; the combination (high-water mark for pruning, exact set within a window) is the standard structure. Where the venue's `ExecID` is a string, hash it — but keep the raw value in the journal for reconciliation.

**`PossDupFlag` is a hint, not the answer.** A message marked `PossDupFlag=Y` may be a duplicate; a message *not* marked may still be one (your own reconnect logic, redundant sessions). Deduplicate on identity unconditionally and use the flag only for alarm classification.

**Reconciling relative vs absolute quantities.** Where the venue supplies both `LastQty` (this fill) and `CumQty` (total filled), the cross-check catches everything:

```
expected_cum = order.cum_qty + msg.last_qty
if (msg.cum_qty == order.cum_qty)            → duplicate; discard
if (msg.cum_qty == expected_cum)             → normal; apply
if (msg.cum_qty >  expected_cum)             → GAP: we missed a fill; recover
if (msg.cum_qty <  order.cum_qty)            → out-of-order/stale; discard but alarm
```
This four-way test is the single most useful piece of code in an execution handler, and reciting it is a strong interview answer. Note it detects *missed* fills too, not just duplicates — a gap is at least as dangerous.

**Idempotency must extend downstream.** Deduping in the gateway is insufficient if the position keeper, risk engine, and hedger each consume the fill stream independently. Either dedupe once at the boundary and publish a clean, sequenced internal stream, or make every consumer idempotent on `ExecID`. The former is far easier to reason about (Ch. 52 §52.5 on single-writer designs).

**Diagnostic signature.** Position drift that is always in the direction of your trading and always a clean multiple of individual fill sizes; it appears in bursts correlated with reconnects or venue resend requests, and reconciles exactly against the drop copy showing fewer executions than your internal count.

---

## 50.13 Limit-Order-Book Representation

The **limit order book (LOB)** is the set of all resting orders for one instrument, organized for two operations that must both be fast: **matching** (find the best contra price and consume it) and **update application** (add, cancel, modify, execute — §50.17).

**The logical model:**

```
Book {
  bids: price → level, ordered DESCENDING (best = highest)
  asks: price → level, ordered ASCENDING  (best = lowest)
}
Level {
  price
  total_qty        (maintained incrementally)
  order_count
  orders: FIFO of Order*    (time priority, §50.15)
}
Order { id, side, price, qty_remaining, level*, prev*, next*, owner }
```

**Operation frequency dictates the design.** Measured on real feeds, the mix is roughly: cancels ≫ adds ≫ executions, and the overwhelming majority of all activity is at or near the touch. Concretely:

| Operation | Frequency | Required complexity |
|---|---|---|
| Best bid / best ask read | Every decision | **O(1)** |
| Add order at an existing level | Very high | O(1) |
| Cancel a specific order | Highest | **O(1)** — requires an ID → order index |
| Execute at the touch | High | O(1) |
| Add order at a new level | Moderate | O(1) or O(log n) |
| Deep-level traversal | Rare | O(k) acceptable |

**The two indices you need.** A book is not one data structure but two:

1. **Price index** — price → level, ordered. (§50.14)
2. **Order index** — order ID → order node. (Required so that a cancel, which arrives with only an order ID, is O(1).)

An implementation that searches the price levels to find an order by ID is O(n) on the most frequent operation and is disqualifying. The order index is typically a flat hash map (Ch. 12 §12.7) or, better, a dense array indexed by a compact order ID if the venue provides one — and since orders are removed constantly, an intrusive doubly-linked list node embedded in the order object gives O(1) unlink with no lookup at all (Ch. 21 §21.5).

**Memory layout matters as much as complexity** (Ch. 42 §42.1). Orders should live in a preallocated pool (Ch. 7 §7.10, Ch. 55 §55.2), never individually heap-allocated: the book churns millions of nodes per session and any allocation on this path is both a latency spike and a fragmentation source. Levels near the touch should be contiguous so that traversing a few levels touches few cache lines.

**MBP versus MBO books** (Ch. 49 §49.2). If your feed is aggregated, there are no individual orders — a level is just `(price, total_qty)`, the order index disappears, and updates are absolute level replacements or deltas. MBP books are far simpler and far cheaper; build the MBO book only if you need queue position or per-order analytics.

**Multi-instrument scaling.** One book per instrument, held in a dense array indexed by the venue's numeric security ID (Ch. 49 §49.9). A `std::unordered_map<Symbol, Book>` on the hot path is the most common junior mistake in this area — hashing a string per message, plus a pointer chase, plus cache misses, for something that should be one array index.

---

## 50.14 Price-Level Data Structures

The price index maps price → level, ordered by price, with best-first access. The choice is the classic interview design question, and the correct answer is "it depends on the price distribution, and here is the tradeoff."

| Structure | Best price | Insert new level | Delete level | Deep traversal | Memory | Notes |
|---|---|---|---|---|---|---|
| **`std::map<Price, Level>`** | O(log n) (`begin()`) | O(log n) | O(log n) | O(k), ordered | Node per level, pointer-chasing | The baseline. Correct, portable, slow — a red-black tree walk is a cache miss per node (Ch. 21 §21.10). |
| **Sorted `std::vector`** | **O(1)** | O(n) memmove | O(n) memmove | O(k), contiguous | Compact, cache-friendly | Excellent when level count is small (tens) — the memmove is fast and cache-resident. Very common in production. |
| **Array indexed by price ("price ladder")** | O(1) with a maintained pointer | **O(1)** | **O(1)** | O(k) with holes | `(max−min)/tick` slots | The fastest. Requires a bounded, known price range. |
| **Hash map price → level + separate best tracking** | O(1) if best is cached | O(1) | O(1) | Requires sorting | Compact | Fine when you never traverse depth; best-price maintenance becomes the hard part. |
| **Skip list / B-tree** | O(1)/O(log n) | O(log n) | O(log n) | Ordered | Higher | Rarely justified over the vector or ladder. |

**The price ladder is the answer interviewers are usually fishing for.** Allocate a flat array of levels covering the plausible price range, indexed by `(price − base) / tick`:

```cpp
struct Ladder {
    std::vector<Level> slots;      // sized (max_px - min_px)/tick + 1, preallocated
    int64_t base_px, tick;
    int32_t best_bid_idx = -1;     // maintained incrementally
    int32_t best_ask_idx = -1;

    Level& at(int64_t px) { return slots[(px - base_px) / tick]; }
};
```

Every operation is a single array index: O(1) add, O(1) cancel, O(1) best access. The costs and their mitigations:

- **Memory.** An equity ranging $10–$1000 at a $0.01 tick needs 99,000 slots; at 32 bytes per level that is ~3 MB per instrument — too much for thousands of instruments. Mitigation: a **windowed ladder** covering only ±N ticks around the current market, with a slow-path fallback (a map) for far-away prices and a re-centring operation when the market moves out of the window. Re-centring is the tricky part: it must be O(window) and must not lose orders.
- **Wide price ranges / variable ticks** (Ch. 49 §49.7) break the uniform index. Use per-instrument tick tables or fall back to a vector.
- **Sparsity.** Most slots are empty; traversal to find the next non-empty level can be slow if the book is thin. Mitigation: a **bitmap of occupied levels** (one bit per slot) plus `std::countr_zero` / `_tzcnt` (Ch. 15 §15.7) to find the next occupied level in a handful of instructions — 64 levels per 64-bit word. This is the elegant trick worth knowing: best-price search becomes a bit scan.

**Choosing in an interview:** state the access pattern first (best-price reads dominate; cancels dominate mutations; depth traversal is rare and shallow), then pick. Sorted vector for a few tens of levels and unknown price ranges; price ladder with an occupancy bitmap for a bounded range and maximum speed; `std::map` only as a correctness reference implementation to differential-test against (Ch. 57 §57.3).

---

## 50.15 Order Queues at a Price Level

Within a price level under price-time priority (Ch. 49 §49.4), orders form a FIFO: insert at the tail, match from the head.

```
Level 100.01, FIFO:
  head → [A qty 500] ⇄ [B qty 300] ⇄ [C qty 900] ← tail
  match consumes from head; new arrivals append at tail
```

**Why an intrusive doubly-linked list is the standard choice** (Ch. 21 §21.5, Ch. 3 §3.11):

- Append at tail: O(1).
- Pop from head: O(1).
- **Cancel an arbitrary order: O(1)** — given a pointer to the node (from the order index, §50.13), unlink with no search. This is the decisive property, because cancels are the most frequent operation and they arrive by order ID, not by position.
- **Intrusive** (the list hooks are members of the order object, not separate nodes) means one allocation per order instead of two, one cache line instead of two, and no allocator traffic on the hot path.

```cpp
struct Order {
    uint64_t id;
    int64_t  price;
    uint64_t qty;          // remaining
    Order*   prev = nullptr;   // intrusive hooks
    Order*   next = nullptr;
    Level*   level = nullptr;
};
struct Level {
    int64_t price;
    uint64_t total_qty;    // maintained incrementally — never recomputed by walking
    uint32_t order_count;
    Order* head = nullptr;
    Order* tail = nullptr;
};
```

**Maintain `total_qty` incrementally.** Every add adds, every cancel subtracts, every execution subtracts. Recomputing it by walking the list is O(n) on a path that must be O(1), and a deep level can hold thousands of orders. The same applies to any aggregate you expose (order count, imbalance inputs).

**Alternative representations and when they win:**

| Structure | Cancel by ID | Cache behaviour | Notes |
|---|---|---|---|
| Intrusive doubly-linked list | O(1) | Pointer chasing on traversal | The default; traversal is rare |
| Ring buffer of order slots | O(1) with tombstones | Excellent (contiguous) | Deletions leave holes; needs compaction. Good when cancels are rare relative to fills — uncommon. |
| Vector of order IDs + index map | O(n) or O(1) with swap-remove | Good | Swap-remove **destroys FIFO order** — disqualifying under time priority. A classic trap. |
| Index-linked list into a pool array | O(1) | Better than pointers (32-bit indices, denser) | Best of both: `uint32_t` next/prev indices into a preallocated array halve node size and improve cache density |

That last row is the production refinement worth mentioning: replace `Order*` with `uint32_t` indices into a pooled array. Node size drops, more orders fit per cache line, and the pool gives you O(1) allocation with no fragmentation (Ch. 7 §7.10).

**Partial execution keeps the order at the head** with reduced quantity (Ch. 49 §49.4) — do not unlink and re-link, which would be both slower and semantically wrong.

**Iceberg / reserve orders** (Ch. 49 §49.2) complicate the queue: the displayed tranche is in the FIFO; when it is exhausted, a new tranche is appended **at the tail**, losing priority. Model this as: on exhaustion, unlink, decrement hidden reserve, re-append with the new display quantity. Systems that instead decrement in place silently give icebergs priority they do not have, which makes fill simulation optimistic in exactly the wrong direction.

---

## 50.16 Best-Bid-Offer Maintenance

The BBO (Ch. 49 §49.1) is read on essentially every decision, so it must be O(1), and it must be *correct* — a stale BBO is worse than a slow one.

**The invariant.** `best_bid` is the highest price with `total_qty > 0` on the bid side; `best_ask` the lowest such on the ask side. Both must be updated **incrementally**, never by scanning.

**The update rules, per event type** (§50.17):

| Event | BBO effect |
|---|---|
| Add at a price better than the current best | New best — O(1) update |
| Add at or worse than the best | No change (but level total changes) |
| Cancel/execute that does **not** empty the level | No BBO price change; size at BBO changes |
| Cancel/execute that **empties the best level** | **Must find the next best level** — the only non-trivial case |

**Finding the next best level** is the entire difficulty, and the answer depends on the price-index structure (§50.14):

- Sorted vector: `++it` — O(1) amortized, cache-friendly.
- `std::map`: `++it` — O(1) amortized but a pointer chase.
- Price ladder: scan for the next occupied slot — O(gap), which is unbounded in a thin book. **Use an occupancy bitmap**: `std::countr_zero` on the next 64-bit word finds the next occupied level in ~2 instructions per word scanned, turning an unbounded scan into a handful of cycles.

```cpp
// Ladder + occupancy bitmap: next occupied level at or below idx (bid side).
int32_t next_bid_below(int32_t idx) const {
    int32_t w = idx >> 6;
    uint64_t bits = occupancy_[w] & ((idx & 63) == 63 ? ~0ull : ((1ull << ((idx & 63) + 1)) - 1));
    while (w >= 0) {
        if (bits) return (w << 6) + (63 - std::countl_zero(bits));
        if (--w < 0) break;
        bits = occupancy_[w];
    }
    return -1;   // book side empty
}
```

**Emit BBO changes, not book states.** Downstream consumers (strategy, risk, logging) almost always want *a notification that the touch changed*, with the old and new values. Compute the BBO before and after applying a batch of updates and emit a delta only if it differs. This collapses enormous update volume — most updates are at depth and do not move the touch — into a small stream, and it is the standard structure of a feed handler's output (Ch. 52 §52.4).

**Batching and the atomicity problem.** A single exchange packet often contains multiple messages that collectively represent one logical transition (e.g. a cancel at the touch followed by an add at a better price). Emitting a BBO update after *each* message publishes transient, never-real states — including momentary crossed or empty books — which downstream logic will act on. **Apply all messages in a packet (or up to the venue's defined event boundary), then publish once.** Venues that provide an explicit end-of-event or "last message in packet" flag are telling you exactly where that boundary is; use it. Failing to do so is a common and subtle bug whose signature is transient crossed-book alarms (Ch. 49 §49.14) that always resolve within one packet.

**Empty side handling.** A book side can be legitimately empty (illiquid instrument, pre-open, post-halt purge). Represent this explicitly — a sentinel price of zero or `INT64_MAX` will be used in arithmetic somewhere and produce nonsense (Ch. 23 §23.13). Use an explicit `has_bid` / `has_ask` flag or an `std::optional`-like presence bit, and make every consumer handle it.

---

## 50.17 Add, Cancel, Modify and Execute Events

Market-data feeds and matching engines both speak in the same four primitives. Precise semantics for each, since this is what a feed handler implements (Ch. 52 §52.3, Ch. 53 §53.1).

**ADD (new order).** `(order_id, side, price, qty)` — insert a new resting order at the tail of the level's FIFO.
```
level = price_index.find_or_create(price)
order = pool.allocate(); order->init(...)
level.append(order); level.total_qty += qty; level.order_count++
order_index[order_id] = order
if (price improves BBO) update_bbo()
```

**CANCEL (delete).** `(order_id)` — remove the order entirely.
```
order = order_index.erase(order_id)          // O(1); must exist
level = order->level
level.unlink(order); level.total_qty -= order->qty; level.order_count--
if (level.empty()) price_index.remove(level) and possibly rescan BBO (§50.16)
pool.free(order)
```
**A cancel for an unknown order ID is a signal, not a no-op.** It means you missed the corresponding add — i.e. a sequence gap or a book divergence. Count it, and if it exceeds a threshold, force a re-sync (Ch. 53 §53.4). Silently ignoring unknown cancels is how a book quietly diverges for hours.

**MODIFY (replace / amend).** `(order_id, new_price, new_qty)`. Semantics depend on the venue's priority rules (Ch. 49 §49.3):
```
if (new_price != old_price || new_qty > old_qty):
    // priority LOST: remove and re-append at the tail of the (possibly new) level
else:
    // quantity decrease: modify in place, keep FIFO position
    level.total_qty -= (old_qty - new_qty); order->qty = new_qty
```
Some feeds do not have a modify message at all and express modifications as delete+add — which is unambiguous. Feeds that do have modify require you to encode the venue's priority rule correctly, or your queue-position model (Ch. 49 §49.3) is wrong.

**EXECUTE (trade / fill).** Two variants, and the distinction matters:

| Variant | Message content | Handling |
|---|---|---|
| **Order-executed** | `(order_id, executed_qty)` | Decrement that order and its level; remove the order if fully executed |
| **Order-executed-with-price** | Adds an explicit price | Used when the trade price differs from the order's display price (hidden/iceberg/price-improved) |
| **Trade message (no order ref)** | `(price, qty, side?)` | A print for the tape; does **not** necessarily modify the book — may refer to hidden liquidity, an auction, or an off-book trade |

The last row is a real trap: applying every trade message to your book double-counts, because the book change is usually already conveyed by the corresponding execute/delete messages. Read the venue spec to determine which trade messages are book-affecting. Signature of getting it wrong: level quantities that drift negative or that you have to clamp — clamping a negative quantity is always a bug being hidden.

**Ordering and atomicity.** Messages are strictly sequenced; apply them in sequence order and never reorder. Between the messages of one event the book can be transiently inconsistent (§50.16) — hence the packet-boundary publication rule.

**Defensive invariants** to assert after each event (cheap, and they catch divergence early):
```
level.total_qty >= 0            // and equals the sum of its orders, checked periodically
level.order_count == 0  ⟺  level.head == nullptr
best_bid < best_ask  (in continuous session only, Ch. 49 §49.14)
order_index.size() == Σ level.order_count
```
Run the expensive full-consistency check on a slow path (once per second, or on a background thread against a snapshot), not per message.

---

## 50.18 Matching-Engine Design

The matching engine is the venue's authoritative state machine: it accepts orders, applies the allocation rule (Ch. 49 §49.4–§49.5), produces executions, and publishes market data. Designing one is the capstone question for this material.

**The core loop.** A matching engine is a **single-threaded, deterministic, sequential state machine** per instrument (or per instrument group):

```
        ┌───────────┐   sequenced   ┌────────────────┐   ┌──────────────┐
 in ───►│ gateways  ├──────────────►│  sequencer     ├──►│ matching     │
        │ (parse,   │   inbound     │ (assigns the   │   │ core         │
        │  validate)│               │  total order)  │   │ (per-instr)  │
        └───────────┘               └────────────────┘   └──────┬───────┘
                                                                │
                                          ┌─────────────────────┼───────────────┐
                                          ▼                     ▼               ▼
                                    execution reports     market data feed   journal
                                    (to participants)     (multicast)        (durability)
```

**Why single-threaded.** Determinism is a *requirement*, not an optimization: the same input sequence must produce the same executions, so that (a) the engine can be replicated for failover by replaying the input sequence (Ch. 56 §56.4–§56.7), (b) disputes can be adjudicated, and (c) the state can be recovered from a journal (Ch. 56 §56.1). Concurrency inside one instrument's matching would make allocation order depend on thread scheduling. The scaling axis is therefore **partitioning by instrument**, not threading within an instrument (Ch. 52 §52.5).

**The sequencer** is the linearization point (Ch. 26 §26.2): it assigns a total order to all inbound messages. Everything downstream is a deterministic function of that sequence. This is what makes replay-based failover work and is the single most important architectural idea in the design.

**The match algorithm** for an incoming aggressive order:

```
match(incoming):
    contra = (incoming.side == BUY) ? asks : bids
    while incoming.leaves > 0 and contra not empty:
        best = contra.best_level()
        if not crosses(incoming.price, best.price): break     // limit reached
        for resting in best.fifo:                             // or allocate pro-rata
            if self_trade_prevention_applies(incoming, resting): apply_stp(); continue
            qty = min(incoming.leaves, resting.qty)
            emit_execution(incoming, resting, qty, best.price)  // ← RESTING price
            resting.qty -= qty; incoming.leaves -= qty; best.total_qty -= qty
            if resting.qty == 0: unlink and free
            if incoming.leaves == 0: break
        if best.empty(): contra.remove(best)
    if incoming.leaves > 0:
        apply TIF: IOC/FOK → cancel remainder;  else rest it (§50.2)
        trigger stop orders whose condition is now met (§50.3)
        reprice pegged orders referencing the changed BBO (§50.4)
```

Note the three post-match steps — TIF handling, stop triggering, peg repricing — which are where the "simple" matching loop becomes a real engine. Stop triggering in particular is recursive: a triggered stop is a new aggressive order that may trigger more stops, so the engine processes a work queue until quiescent, with a bound to prevent runaway.

**Self-trade prevention (STP)** (Ch. 56 §56.20). When an incoming order would match a resting order from the same firm/account/group, the engine applies a configured policy instead of executing:

| Policy | Action |
|---|---|
| Cancel newest | Cancel the incoming order (or its remainder) |
| Cancel oldest | Cancel the resting order; incoming continues |
| Cancel both | Both removed |
| Decrement-and-cancel | Reduce both by the overlapping quantity |

STP exists because self-trades are regulatorily problematic (they can resemble wash trading) and economically pointless. The engineering consequences: STP makes fills non-obvious to simulate, it can cancel *your own resting order* as a side effect of your own aggressive order (a genuinely surprising behaviour the first time it happens), and it must be applied per the venue's grouping key, which you configure.

**Non-functional requirements that shape the design:**

- **Determinism**: no wall-clock reads in the matching path (use the sequenced timestamp), no hash-map iteration order dependence, no floating point (Ch. 23 §23.10), no uninitialized reads.
- **Durability before acknowledgement**: journal the sequenced input before acting, or you cannot recover (Ch. 56 §56.1–§56.3).
- **Fairness**: the gateway-to-sequencer path must not systematically favour one participant, which is why venues equalize cable lengths and gateway paths.
- **Bounded work per message**: the matching loop is unbounded in principle (a sweep can consume the whole book), so engines cap the number of executions per order or the number of levels swept, rejecting or resting the remainder.
- **No allocation, no syscalls, no locks in the core** (Ch. 55 §55.1–§55.6); preallocated pools, single-writer ring buffers to the publishers (Ch. 26 §26.3), and a strictly bounded worst case.

**Publication ordering.** Executions must reach the participant and the public feed in a defined relationship. Venues differ on whether the private execution report or the public market-data update goes out first, and the answer has real consequences — a participant learning of their own fill before the market does has an advantage. Whatever the policy, it must be *consistent*, and knowing that this ordering is a deliberate design decision rather than an accident is the kind of detail that distinguishes a strong candidate.

---

## Key Interview Questions

1. **A buy limit at 100.05 crosses a resting offer at 100.03 — what price does it trade at?** — 100.03, the resting order's price. Price improvement accrues to the aggressor; the maker's price sets the terms.
2. **Why do automated systems prefer an aggressive limit + IOC over a market order?** — Same near-certain immediacy with a bounded worst price, partial fills allowed, and no residual state; a market order accepts any book, including a stale or emptied one.
3. **What happens to a market order's unfilled remainder?** — Venue-specific: cancelled, rested at the last/protection price, rejected, or converted to a limit at the price band.
4. **Buy stops sit above or below the market?** — Above; sell stops below — the inverse of limit orders. Trigger reference (last trade vs BBO vs mid) is venue-specific and determines whether a single stray print can fire them.
5. **Native exchange stop vs client-side synthetic stop?** — Native triggers at engine speed and survives your disconnect; synthetic allows arbitrary trigger logic and uniform cross-venue behaviour but is always a feed-latency-plus-reaction behind and dies with your process.
6. **Why doesn't a pegged order dominate a static limit?** — Every reprice is a price change, which forfeits time priority, so a peg following a jittery reference lives permanently at the back of the queue.
7. **What are the three post-only behaviours and which is most dangerous?** — Reject, slide/reprice, cancel. Slide is most dangerous because the order rests at a price you did not send, so any code assuming `order.price == sent_price` is wrong.
8. **IOC vs FOK vs AON?** — IOC allows partials and cancels the rest; FOK is all-or-nothing and never rests; AON is all-or-nothing but *rests*, which breaks top-of-book matching and is why many venues don't support it.
9. **How do you implement FOK in a matching engine?** — Two passes: a non-mutating feasibility walk that stops as soon as sufficiency is proven, then the execution sweep. Single-pass with rollback requires undoing book state and emitted executions.
10. **Why do low-latency systems avoid GTC?** — It carries state across process restart, the boundary where state is least trustworthy, and requires cross-session ID uniqueness, corporate-action handling and startup reconciliation; DAY/IOC with explicit re-establishment makes state derivable.
11. **Can a fill arrive before the new-order acknowledgement?** — Yes. Therefore the order record must be created before the message is sent, keyed by client order ID, and a fill for an "unknown" order must never be treated as an error.
12. **You send a cancel and get a fill instead. What went wrong?** — Nothing; they crossed on the wire. A cancel is a request, not a guarantee, so risk must treat a pending-cancel order as fully live.
13. **You replace an order down from 1000 to 400 and 700 has already filled. What happens?** — Most venues reject the replace because the new quantity is at or below `cum_qty`, leaving the *original* working — so your intended reduction silently did not happen.
14. **A new-order request times out. What do you do?** — Assume it may be live: move to Unknown (risk treats as fully live), stop trading that instrument, query via order-status or drop copy, and never blindly resend. Cancel-on-disconnect is the backstop.
15. **How do you make execution processing idempotent?** — Dedupe on the venue's `ExecID` with a bounded high-water-mark-plus-window set, and cross-check `cum_qty` against `old_cum + last_qty` — a four-way test that also detects *missed* fills.
16. **What are the two indices a limit order book needs, and why?** — Price → level (ordered) and order ID → order node, because cancels are the most frequent operation and arrive by ID; searching levels for an ID is O(n) and disqualifying.
17. **Compare `std::map`, sorted vector, and a price ladder for the price index.** — Map: correct, O(log n), cache-hostile — a reference implementation. Sorted vector: O(1) best, O(n) memmove insert, excellent when levels are few. Ladder: O(1) everything, needs a bounded price range, plus an occupancy bitmap and `countr_zero` to skip empty slots.
18. **Why an intrusive doubly-linked list at a price level, and what breaks the alternatives?** — O(1) append, pop, and *unlink by pointer*; one allocation and one cache line per order. Vector plus swap-remove is disqualifying because it destroys FIFO order and therefore time priority.
19. **Why must BBO updates be published at packet boundaries?** — A packet often carries several messages forming one logical transition; publishing per message emits transient never-real states, including momentary crossed books that downstream logic acts on.
20. **Why is a matching engine single-threaded per instrument?** — Determinism: identical input sequences must produce identical executions so the engine can be replicated by replay, recovered from a journal, and audited. Scale by partitioning instruments, not by threading within one.
21. **What is the sequencer's role?** — It is the linearization point that assigns the total order; everything downstream is a deterministic function of that sequence, which is what makes replay-based failover possible.
22. **What is self-trade prevention and what's the surprising consequence?** — A policy applied when a firm's order would match its own resting order (cancel newest/oldest/both, or decrement-and-cancel); the surprise is that your own aggressive order can cancel your own resting order.

---

## Common Traps

- **Encoding a market order as a limit at `INT64_MAX`** — the sentinel overflows in price arithmetic and notional calculations.
- **Believing a marketable order trades at the aggressor's limit or at the mid** — it trades at the *resting* price.
- **Sending market orders from an automated strategy** without a collar — a stale or thin book yields an unbounded fill price.
- **Encoding sell and sell-short identically** — a compliance defect (Reg SHO price test, locate requirements).
- **Assuming a stop-limit will fill** — in a fast move it triggers and rests untouched, leaving the position unprotected.
- **Assuming a peg keeps queue position across reprices** — every reprice is a price change and goes to the back.
- **Asserting that a fill price is on the tick grid** — midpoint pegs execute sub-tick by design.
- **Treating post-only rejects as incidents** — they are normal and cluster when the spread narrows to one tick.
- **Assuming the resting price equals the price you sent** on a slide-behaviour post-only venue.
- **Treating an IOC that fills nothing as a reject** — it is a normal cancel/expire.
- **Implementing FOK as match-then-rollback** instead of a feasibility pass.
- **Assuming FOK on two venues gives cross-venue atomicity** — it does not; only a venue-native combination instrument does.
- **Creating the order record on acknowledgement** — fills arrive before acks and get dropped.
- **Treating a pending cancel as already cancelled** in risk — it is still fully live.
- **Blindly resending after a timeout** — duplicate orders and double position.
- **Silently discarding an uncorrelatable inbound message** — an untracked position that surfaces at end-of-day reconciliation.
- **Deduping only on `PossDupFlag`** — duplicates arrive unflagged from reconnects and redundant sessions.
- **Applying a relative `LastQty` without checking `CumQty`** — no defence against duplicates or gaps.
- **Deduping only at the gateway** while position, risk, and hedging each consume the fill stream independently.
- **Searching price levels to cancel by order ID** — O(n) on the most frequent operation.
- **`unordered_map<string, Book>` on the hot path** — hash a string per message instead of indexing an array by numeric security ID.
- **Recomputing `level.total_qty` by walking the list** — O(n) where O(1) is required.
- **Swap-remove within a price level** — destroys FIFO and therefore time priority.
- **Heap-allocating order nodes** — allocation spikes and fragmentation on the churniest path in the system.
- **Ignoring a cancel for an unknown order ID** — it means you missed the add; the book is already diverging.
- **Applying every trade message to the book** — double-counts when the book change is already carried by execute/delete messages; the tell is level quantities you have to clamp at zero.
- **Publishing a BBO update per message rather than per packet** — transient crossed/empty books leak downstream.
- **Sentinel prices for an empty book side** — they get used in arithmetic; use an explicit presence flag.
- **Wall-clock reads, floating point, or hash iteration order inside a matching core** — all destroy determinism and therefore replay-based recovery.
- **Decrementing an iceberg in place** on replenishment — silently grants priority it does not have and biases fill simulation optimistic.

---

## Compact Recall Summary

**Order types.** *Market*: no price limit, walks the book, remainder handling is venue-specific (cancel, rest, reject, band) — always collar it or convert to an aggressive limit. *Limit*: worst acceptable price; passive or aggressive depending on the book at arrival; **executes at the resting price**, so price improvement goes to the aggressor. *Stop*: dormant until triggered (buy stops above, sell stops below), then market or limit; trigger reference is venue-specific; stop-limits may not fill; triggered bursts are a capacity event. *Pegged*: price tracks a reference (primary/market/midpoint) with offset and cap; every reprice forfeits queue position and can execute sub-tick. *Post-only*: reject, slide, or cancel if it would take — a fee mechanism *and* a stale-book safety net; slide means the resting price is not the price you sent.

**Time in force.** IOC = partial fills allowed, remainder cancelled, never rests — the workhorse, because state resolves in one round trip. FOK = all-or-nothing, never rests, implemented as a feasibility pass then an execution pass. AON = all-or-nothing but rests, which breaks top-of-book matching and is often unsupported. MinQty sits between IOC and FOK. DAY purges at close; GTC persists across sessions and drags durable state, cross-session ID uniqueness, corporate-action handling, and mandatory startup reconciliation with it.

**Lifecycle.** PendingNew → New → PartiallyFilled → Filled / Canceled / Rejected / Expired, with PendingCancel. Pending states exist because latency makes the true state unknown. Create the record before sending; fills can precede acks. Invariant: `order_qty = cum_qty + leaves_qty + canceled_qty`, `cum_qty` monotonic, `leaves_qty == 0 ⟺ terminal`. Every pending state needs a timeout, and the timeout outcome is *Unknown*, treated by risk as fully live.

**Races.** Cancel and fill cross on the wire — a cancel is a request, never a guarantee. Replace below `cum_qty` is typically rejected, leaving the original working. One outstanding request per order; correlate fills by venue OrderID, requests by ClOrdID. On timeout: fail closed, query, never resend; mass cancel and cancel-on-disconnect are the escape hatches.

**Duplicates.** Sources: FIX resend, PossDup, reconnect replay, redundant sessions, drop copy, journal replay. Dedupe on `ExecID` with a high-water mark plus a bounded window set. The four-way `CumQty` test (`==old` duplicate, `==old+last` normal, `>` gap, `<` stale) detects both duplicates and missed fills. Never silently discard an uncorrelatable message.

**Book.** Two indices: ordered price → level, and order ID → node. Price index: `std::map` (reference implementation only), sorted vector (few levels), or **price ladder** with an occupancy bitmap and `countr_zero` for O(1) everything within a bounded, re-centrable window. Level: intrusive doubly-linked FIFO with `total_qty` maintained incrementally, orders from a preallocated pool, ideally with `uint32_t` pool indices instead of pointers. Cancels are the most frequent op and arrive by ID — hence O(1) unlink is the design driver. Swap-remove destroys time priority.

**BBO.** Incremental, O(1); the only hard case is emptying the best level, solved by `++it` on ordered structures or a bitmap scan on a ladder. Publish deltas at packet/event boundaries, never per message, or transient crossed and empty states leak downstream. Represent an empty side explicitly, never with a sentinel price.

**Events.** ADD appends at tail; CANCEL unlinks in O(1) and an unknown ID means you missed an add (re-sync, don't ignore); MODIFY loses priority on price change or quantity increase and keeps it on decrease; EXECUTE decrements from the front. Distinguish book-affecting executions from tape-only trade prints, or you double-count — the tell is a level quantity you have to clamp.

**Matching engine.** Single-threaded, deterministic, sequential per instrument; scale by partitioning instruments. The **sequencer** is the linearization point and the basis of replay-based failover and journal recovery. The match loop: walk contra levels while crossing, allocate FIFO or pro-rata, emit at the resting price, then handle TIF, trigger stops (recursively, with a bound), and reprice pegs. Self-trade prevention (cancel newest/oldest/both, decrement-and-cancel) can cancel your own resting order. Non-negotiables: journal before acknowledging, no wall clock, no floating point, no hash-order dependence, no allocation, no syscalls, no locks, and a bounded worst case per message.
