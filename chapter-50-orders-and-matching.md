# Chapter 50 — Orders and Matching

## Why This Matters — Core

An order is not merely “buy 100 at 42.” It is a stateful instruction whose
meaning depends on side, price constraint, quantity, time in force, execution
constraints, market phase, and a venue's versioned rulebook. The matching
engine must turn those instructions into one deterministic sequence of
acceptances, rejections, book changes, and executions. A trading system must
then reduce the resulting reports without inventing or losing exposure.

Three boundaries prevent most reasoning errors:

1. **Client intent is not venue state.** Sending a cancel does not cancel an
   order; only the venue's ordered outcome establishes what happened.
2. **A book representation is not a matching rule.** A FIFO queue can implement
   price-time priority, but another product may use pro-rata, size priority,
   hidden-order rules, or an auction allocation.
3. **A familiar rule is not a universal rule.** Post-only handling, stop
   triggers, peg repricing, modification priority, trade price, auction
   tie-breaks, and supported TIFs vary by venue, segment, product, phase, and
   rulebook/protocol version.

This chapter builds the state and invariants first, then applies them to order
types, book structures, continuous matching, and auctions. Chapter 51 owns wire
encoding and market-data recovery. Chapter 54 owns gateway/session mechanics,
reconnect, throttling, and reconciliation.

## 90-Second Screen — Core

Five facts:

1. Represent price and quantity as validated integer units. A market order has
   no limit price; do not encode it with a dangerous maximum-price sentinel.
2. Track immutable client intent separately from mutable venue facts:
   acknowledged quantity, cumulative fills, leaves, venue order ID, price,
   status, and replace generation.
3. Cancel/replace races are resolved by venue processing order, not by the
   client's send time. A fill after a cancel request can be correct.
4. For a price-time model, maintain prices in side order and FIFO orders within
   each price. Also maintain an ID index, exact aggregate quantity, and a BBO
   that references nonempty levels.
5. Continuous matching and auction uncrossing are different algorithms.
   Continuous trading consumes eligible resting liquidity in priority order;
   an auction selects a clearing price and allocates matched volume under
   venue-specific tie-breaks.

Two decisions to defend:

- Which venue/product/phase rule defines eligibility, priority, execution
  price, residual handling, and modification priority?
- Which invariant detects a duplicate, late, stale, or impossible event before
  it corrupts positions or the book?

## 50.1 The Order State Model — Core

Start with facts, not status strings. A useful client-side order record separates
three identities:

| Identity | Purpose | Lifetime/scope |
|---|---|---|
| Client order ID | Names the submitted intent; used to correlate early responses | Unique in the scope required by the venue/session |
| Venue order ID | Names the accepted venue object | Assigned on acceptance; may change on replace |
| Execution ID | Makes each fill/economic event idempotent | Unique only in the documented venue/protocol scope |

A replace may form a chain of client IDs or versions. Keep the root intent and
generation so a response for generation 2 cannot mutate generation 3. Never
reuse an ID merely because a response is late.

### Immutable Intent and Mutable Venue Facts

Immutable intent normally includes instrument, side, submitted quantity, order
type, TIF, limit/stop/peg parameters, account, and client ID. Venue facts may
include:

- accepted price and quantity;
- venue order ID;
- cumulative executed quantity;
- leaves quantity;
- current displayed/hidden attributes;
- venue status and reject/cancel reason;
- last accepted replace generation.

The basic quantity invariant is:

\[
0 \le Q_{\text{cum}} \le Q_{\text{accepted}},
\qquad
Q_{\text{leaves}} = Q_{\text{accepted}} - Q_{\text{cum}}
\]

A venue may report both cumulative and leaves. Check their relationship under
that protocol's definition rather than overwriting one with the other. Replace,
bust/correct, corporate action, and special product semantics can require a
more explicit ledger.

### Lifecycle State Machine

This client-side model assumes reports have first been normalized into venue
sequence order. Session sequencing belongs to Chapter 54.

```
                     reject
Created → PendingNew ───────▶ Rejected
              │
              │ accept
              ▼
           Working ──full fill──────────────▶ Filled
              │
              │ cancel request
              ▼
        PendingCancel ──cancel accepted─────▶ Cancelled
              │    │
              │    ├─partial fill───────────▶ PendingCancel
              │    ├─full fill──────────────▶ Filled
              │    └─cancel rejected────────▶ Working or reconcile
              │
              └─replace outcome is a venue-defined transition/version
```

`PendingCancel` is a local fact: cancellation was requested, but exposure still
exists. A timeout is also a local fact. Neither is a terminal venue outcome.

Some gateways allow a cancel intent to be recorded while `PendingNew`, then
send the actual cancel when the venue identifier/acceptance becomes available.
That is safer than pretending the original order disappeared. The exact
message choreography belongs to Chapter 54; the state invariant here is that
uncertainty does not become zero exposure.

### Transition Checks

| Event | Precondition | State/data effect | Duplicate/late handling |
|---|---|---|---|
| Accept | Correlates to pending generation | Store venue facts; become working unless already terminal by authoritative recovery | Same facts are idempotent; conflict requires reconciliation |
| Reject | Pending new/replace as allowed | Terminal for that request; no new live quantity | Do not classify every business reject as transport failure |
| Partial fill | New execution identity; quantity within leaves | Increase cumulative; reduce leaves | Duplicate execution produces no second position change |
| Full fill | New execution consumes leaves | Leaves zero; terminal filled | Later cancel response cannot erase the fill |
| Cancel accepted | Correct live ID/generation | Remaining leaves become inactive; terminal cancelled | A duplicated cancel report is idempotent |
| Cancel rejected | Correlates to request | Order may remain working or already be terminal | Reason and current venue state decide |
| Replace accepted | Correct predecessor/version | Apply accepted fields and priority semantics | Stale predecessor response cannot mutate successor |

Terminal does not mean “ignore all later bytes.” Duplicated reports should be
recognized, corrections may exist, and recovery can reveal a different
authoritative state. Terminal means no ordinary live leaves under the
currently accepted facts.

### A Compact Lifecycle Reducer

The following C++23 model assumes normalized venue-sequence order and omits
replace, bust/correct, persistence, and protocol I/O. Its useful feature is that
a cancel requested before acceptance becomes an intent, not a fabricated
terminal state. A `true` return from `request_cancel()` or `on_accept()` tells
the gateway layer that a cancel may now be sent.

```cpp
#include <cstdint>
#include <stdexcept>
#include <unordered_set>

enum class State {
    PendingNew, Working, PendingCancel, Filled, Cancelled, Rejected
};

class OrderTracker {
    std::uint64_t accepted_{};
    std::uint64_t cumulative_{};
    State state_{State::PendingNew};
    bool cancel_wanted_{};
    std::unordered_set<std::uint64_t> executions_;

    void require(bool condition) const {
        if (!condition) throw std::logic_error("invalid order transition");
    }

public:
    [[nodiscard]] bool on_accept(std::uint64_t quantity) {
        require(state_ == State::PendingNew && quantity != 0);
        accepted_ = quantity;
        state_ = cancel_wanted_ ? State::PendingCancel : State::Working;
        return cancel_wanted_;
    }

    void on_new_reject() {
        require(state_ == State::PendingNew);
        state_ = State::Rejected;
    }

    [[nodiscard]] bool request_cancel() {
        if (state_ == State::PendingNew) {
            cancel_wanted_ = true;
            return false;
        }
        if (state_ == State::Working) {
            state_ = State::PendingCancel;
            return true;
        }
        return false; // already pending or terminal
    }

    [[nodiscard]] bool on_fill(std::uint64_t exec_id, std::uint64_t quantity) {
        if (executions_.contains(exec_id)) return false;
        require(state_ == State::Working || state_ == State::PendingCancel);
        require(quantity != 0 && quantity <= accepted_ - cumulative_);
        executions_.insert(exec_id);
        cumulative_ += quantity;
        if (cumulative_ == accepted_) state_ = State::Filled;
        return true;
    }

    void on_cancelled() {
        require(state_ == State::Working || state_ == State::PendingCancel);
        state_ = State::Cancelled;
    }

    void on_cancel_reject() {
        require(state_ == State::PendingCancel);
        state_ = State::Working;
    }

    [[nodiscard]] std::uint64_t leaves() const {
        return accepted_ - cumulative_;
    }
    [[nodiscard]] State state() const { return state_; }
};
```

The reducer rejects overfills before recording the execution identity and keeps
partial fills in `PendingCancel`. Production code should store a fingerprint
with each execution ID so a duplicate carrying conflicting price/quantity is
an error rather than a silent no-op. It should also persist the economic event
before acknowledging whatever durability boundary the system promises.

### Desired Quantity, Live Quantity, and Exposure

Strategy intent and venue exposure are separate ledgers. A strategy may desire
zero after deciding to cancel, while the venue still has live leaves. Risk must
use the conservative venue possibilities:

\[
Q_{\text{possible fill}} =
Q_{\text{working leaves}} + Q_{\text{uncertain pending-new/replace}}
\]

Subtract quantity only on an authoritative cancel/expire or execution. If a
replace could leave either predecessor or successor live during uncertainty,
reserve for the documented worst case until reconciliation resolves it. This
may temporarily overstate exposure, but pretending a pending action succeeded
can understate it precisely when message delay is highest.

## 50.2 Order Intent: Side, Quantity, Price, and Type — Core

### Side and Quantity

Buy and sell determine which contra prices are acceptable. Some markets also
distinguish sell-short, open/close, covered/uncovered, capacity, or position
effect. Those are venue/regulatory fields, not synonyms to infer from a signed
quantity.

Quantity is an integer in the product's order unit and must satisfy minimum,
increment, and maximum rules. A fill quantity must be positive and no greater
than current leaves. “100” may mean shares, contracts, lots, nominal amount, or
another product-specific unit.

### Price

Use an integer number of price units/ticks or a validated fixed-point value.
The instrument definition supplies scale, tick schedule, bands, and permitted
rounding. A tick schedule can vary by price range, so `price % tick == 0` is not
always sufficient.

A limit price is a worst-price constraint:

- a buy limit may execute at prices no greater than its limit;
- a sell limit may execute at prices no less than its limit.

Whether the trade occurs at the resting price, an auction price, midpoint, or
another permitted price is a matching rule. This chapter's worked continuous
model uses the resting order's price, but that model rule must not be exported
to every venue.

### Market and Limit Orders

| Type | Intent | Residual | Principal risk |
|---|---|---|---|
| Market | Execute available eligible quantity without a limit price | Normally does not rest; exact cancel/auction behavior is venue-specific | Unbounded price slippage within venue protections |
| Limit | Execute only within the stated worst price | May rest if TIF permits | No execution if the market moves away |
| Marketable limit | Limit currently crosses eligible contra liquidity | Matches, then rests or cancels according to TIF | Snapshot may be stale; realized depth differs |

An aggressive limit plus IOC often expresses “take now, but not beyond this
price.” It is not semantically identical to a market order: its limit can leave
quantity unexecuted.

Market orders need special handling when no liquidity exists, during auctions,
or under price collars. A venue may reject, cancel residual, convert/protect the
order, or carry it into an auction under documented rules. Record the exact
venue behavior.

## 50.3 Time in Force and Execution Constraints — Core

Time in force answers how long eligible residual quantity remains active.
Execution constraints answer how it may execute. Names are common; details are
not universal.

| Instruction | Core intent | May partially execute? | May rest? | Versioned questions |
|---|---|---:|---:|---|
| DAY | Active through a defined trading day/session | Usually | Yes | Which session boundary and phases? |
| IOC | Execute immediately; cancel residual | Yes | No | Does “immediate” include an auction or routing? |
| FOK | Execute full quantity immediately or none | No | No | Which displayed/hidden liquidity counts? |
| GTC | Persist until cancel or venue expiry | Usually | Yes | Cross-session handling, maximum age, corporate events |
| GTD/GTT | Persist until date/time | Usually | Yes | Time zone, inclusivity, phase transition |
| Auction-only | Participate in named auction/phase | Rule-specific | Until auction handling | Carry, cancel, or roll to continuous? |

An IOC may legitimately produce zero or several fills followed by a terminal
cancel/expire of residual. FOK external semantics are atomic with respect to
the order: no partial execution if the full permitted quantity is unavailable.
A matching engine can preflight eligible volume before mutation, reserve it, or
use another atomic algorithm; “two loops” is an implementation option, not a
venue guarantee.

Minimum quantity, all-or-none, display quantity, and self-trade prevention can
alter eligibility or allocation. Treat each as an independent constraint. A
resting all-or-none instruction, where supported, is harder than FOK because it
can block or skip otherwise matchable size according to special rules.

### Post-Only

Post-only expresses “do not remove liquidity.” If the order would execute on
arrival, a venue may reject it, cancel it, or reprice/slide it to a permissible
price. The accepted price can therefore differ from the submitted price. Some
venues expose multiple post-only variants.

Consequences:

- classify “would take liquidity” as the documented business outcome;
- update state from the accepted venue price, not the sent value;
- model interaction with locked/crossed states, hidden liquidity, self-trade
  prevention, and market phase;
- version the behavior by venue/product/protocol.

Post-only is useful protection against an unintended take, but it is not proof
that the client's market view was current.

## 50.4 Stop, Pegged, and Derived Orders — Core

These types contain a rule for creating or changing an effective executable
order. Their event ordering matters as much as their fields.

### Stop Orders

A stop is dormant under the venue's matching rules until a trigger condition
becomes true. On trigger, a stop-market becomes market-like; a stop-limit
becomes a limit order with its own limit price.

Common directional intent is:

- sell stop below the current market, triggered by a downward move;
- buy stop above the current market, triggered by an upward move.

But the trigger reference—last sale, bid, offer, midpoint, mark/index price, or
a qualified sequence—is venue/product-specific. So are equality, phase,
session, price-band, and halt rules. Some venues do not host stop orders; a
broker or client may implement a synthetic stop from market data. A synthetic
stop adds feed and submission latency and has different disconnect/recovery
semantics.

A stop-market controls trigger price but not execution price. A stop-limit
controls execution price but can trigger and remain unfilled. Cascades are a
capacity case: executions trigger stops, newly aggressive orders move the
market, and more stops become eligible. The engine must define whether all
triggered orders enter in one ordered batch and how their relative priority is
assigned.

### Pegged Orders

A pegged order derives an effective price from a reference plus an offset,
usually bounded by a limit/cap:

\[
P_{\text{effective}} =
\operatorname{clamp}_{\text{side}}(P_{\text{reference}} + \text{offset},
                                  P_{\text{limit}})
\]

References can include same-side best, opposite-side best, midpoint, last
trade, or an external value. The rulebook defines rounding, locking/crossing
prevention, stale/absent references, and market phases.

When the reference changes, the venue may reprice, suspend, cancel, or leave the
order unchanged under special conditions. Repricing can lose, retain, or
receive defined priority depending on the venue rule. Midpoint and hidden pegs
can execute at prices not displayed in the lit book and, where regulations
permit, at increments different from displayed quoting increments.

One reference event can reprice many pegs, so a matching engine must define
whether it reprices them before or after matching the triggering event. That
ordering is observable and versioned; never infer it from the word “peg.”

## 50.5 Acceptance, Acknowledgement, and Lifecycle Races — Core

### Accepted Does Not Mean Resting

Acceptance means the venue admitted the instruction under a defined state. An
accepted aggressive order may immediately fill; an IOC may immediately expire;
a post-only slide may rest at a different price; an auction order may wait in
an auction pool. Protocols can represent acceptance and execution as separate
reports, one composite event, or a sequence with specific guarantees.

A rejection should identify the failed request and reason. It means no new
venue state was created by that request, but it does not automatically cancel a
predecessor in a failed replace. Model “new reject,” “replace reject,” and
“cancel reject” separately.

### Cancel Versus Fill

Suppose a working buy has 10 leaves:

```
client sends CANCEL ───────────────▶ venue input sequencer
marketable sell arrives ──────────▶ venue input sequencer

Case A venue order: sell, cancel
    fill 6 → cancel accepts remaining 4

Case B venue order: cancel, sell
    cancel accepts 10 → later sell cannot match that order
```

The client's timestamps do not decide which case occurred. The engine's
authoritative order does. While cancel is pending, risk must include the leaves
that can still fill. A full fill can make the cancel reject as too late or
unknown; that is a normal race outcome.

### Replace Versus Fill and Priority

A replace can be implemented as an atomic modification, cancel-and-new, or a
protocol-specific chain. Increasing quantity, changing price, reducing
quantity, or changing display attributes may have different priority effects.
Many price-time systems preserve priority for a pure quantity reduction and
lose it for price changes/increases, but this is not universal.

The safe local representation keeps:

- predecessor and successor client IDs/generations;
- cumulative fills for the economic intent;
- accepted quantity/price for each venue generation;
- whether old and new versions can both be live during uncertainty;
- the exact priority outcome reported or implied by the rulebook.

If a fill applies to the predecessor while a replace is pending, allocate it to
that predecessor, then recompute remaining intent. Do not subtract it from the
successor blindly; venues differ on how replacement quantity is interpreted.

### Late Acknowledgements

“Late” can mean after a local timeout, after a cancel intent, or after recovery
began. It does not mean invalid. Never reuse the client ID or send a duplicate
new order merely because an acknowledgement missed an SLA. Mark the state
uncertain, preserve worst-case exposure, and reconcile through the Chapter 54
session/gateway process.

### Duplicate Executions

Apply an execution exactly once to order state, position, cash, fees, and risk.
Deduplicate using the documented execution identity and scope; if the protocol
supports corrections/busts, those are new economic events referencing an
earlier execution, not duplicates to discard.

Maintain an append-only execution ledger before derived aggregates where the
system's durability contract requires it. On duplicate:

- verify immutable fields agree;
- do not change cumulative quantity or position again;
- count and diagnose the replay source;
- retain enough identity across restart to remain idempotent.

## 50.6 Limit-Order-Book Invariants — Core

An authoritative matching-engine book contains eligible resting orders. A
market-data replica may instead expose aggregate levels, displayed orders, or a
venue-specific subset. Do not require a public replica to contain hidden
liquidity it was never told about.

For a simple continuous price-time book, check after every input event:

1. all resting quantities are positive and all prices are valid for the
   instrument/phase;
2. bid levels are ordered best/highest first; ask levels best/lowest first;
3. every order is linked to exactly one side and price level;
4. every ID-index entry points to that same live order, and every live order is
   indexed;
5. a level's aggregate quantity equals the sum of its live orders;
6. FIFO links at a level reflect the model's priority sequence;
7. empty levels are removed or excluded from BBO discovery;
8. best bid and best ask equal the first nonempty eligible levels;
9. after a continuous event finishes, no mutually matchable orders remain
   under this model's eligibility rules;
10. emitted executions conserve quantity: aggressor decrement equals the sum
    of resting-order decrements.

Invariant 9 needs qualification. A visible market can appear locked or crossed
because of feed timing, separate venues, auction state, protected/hidden order
rules, or missing data. Even an engine can intentionally maintain separate
pools that are not mutually eligible. State the book domain before declaring a
cross impossible.

### Event Accounting

For one order generation without bust/correct semantics:

\[
Q_{\text{accepted}} =
Q_{\text{cum fill}} + Q_{\text{live leaves}} + Q_{\text{cancelled/expired}}
\]

The terms must not become negative. At the book level, an ADD increases live
quantity, EXECUTE decreases it and creates traded quantity, CANCEL decreases it
without a trade, and MODIFY applies venue-defined deltas/priority. A DELETE can
mean cancel of all remaining quantity or a feed-specific removal event.

## 50.7 Book Representation and Price Levels — Core

A matching engine usually needs four operations:

- find the best eligible contra level;
- insert/remove a price level;
- append/unlink an order within a level;
- find an order by identifier for cancel/modify.

No single container optimizes every price domain:

| Price-level index | Best lookup | Level insert/remove | Strength | Cost |
|---|---:|---:|---|---|
| Dense array by tick | Constant/direct or bitmap-assisted | Constant | Bounded dense price range; predictable memory | Large/sparse range wastes space; rebasing complexity |
| Ordered tree/map | First element | Logarithmic | Sparse/unbounded prices; simple correctness | Pointers, allocation, cache misses |
| Sorted flat vector | Constant at end/front depending layout | Linear movement | Few stable levels; compact traversal | Expensive churn |
| Hash map + best-price heap/bitmap | Heap/bitmap dependent | Amortized constant plus maintenance | Fast ID/price access | Stale heap entries or more invariants |

Big-O is only the start. Measure active level count, price locality, allocation,
cache lines, branch behavior, and cancel/modify rate. Product sharding can make
a straightforward ordered container fast enough and easier to verify.

### Orders at a Price

For price-time priority, a level needs a FIFO sequence and aggregate quantity.
An intrusive doubly linked list gives constant-time unlink when the ID index
stores a node handle. A `std::deque` is convenient for a small simulator but
does not provide constant-time arbitrary erase from a saved iterator under all
mutations.

One possible engine layout:

```text
OrderId index ───────────────▶ OrderNode
                                  │ prev/next
                                  ▼
bid level P: head ⇄ node ⇄ node ⇄ tail, total_qty
ask level Q: head ⇄ node ⇄ node ⇄ tail, total_qty

side index: price → PriceLevel
BBO cache: best eligible bid/ask, validated after level changes
```

Node pools can avoid hot-path allocation and make handles stable. Generation
tags catch use-after-recycle. The price level, ID index, aggregate, and BBO must
be updated as one logical transaction; an exception or partial update cannot
leave them disagreeing.

### Priority Is an Engine Sequence, Not a Wall Clock

“Time priority” normally means the venue-assigned order of eligible events, not
comparison of participant timestamps. Two orders can carry equal timestamps,
clocks can differ, and published timestamps can have coarser resolution than
the input sequencer. A deterministic model therefore stores a monotonic
priority sequence or an equivalent stable queue position assigned by the
engine.

Modification rules update that key only when the venue says priority changes.
An in-place quantity reduction might retain the node and sequence; a price
change might unlink it from the old level, assign a new sequence, and append it
to the destination. Another venue may treat both as cancel/new. Replay must
apply the rule version that was effective for the event, because retaining the
wrong key can produce the correct aggregate depth but allocate the next fill to
the wrong participant.

For pro-rata matching, a FIFO list may still be useful for deterministic
rounding or residual allocation, but it no longer defines the primary quantity
split. Store the data required by the allocator—eligible size, priority class,
display status, and tie-break sequence—rather than forcing every algorithm into
one timestamp field.

### Best Bid and Offer

With ordered maps, BBO may be the first level. With arrays, a bitmap or tracked
index can locate the next nonempty tick. Caching best prices is useful only if
every level transition updates the cache:

- adding inside the spread can create a new best;
- removing the final order at best must advance to the next nonempty level;
- partial execution changes size but not price;
- modify/reprice may remove one best and create another;
- market phase/eligibility can change which pool contributes.

Expose “no bid” and “no ask” explicitly. Sentinel prices tend to leak into
spread, midpoint, and notional arithmetic.

## 50.8 Matching Rules and Execution Reports — Core

### Eligibility Before Priority

For each incoming order, decide:

1. Is the order valid and accepted in the current phase?
2. Which resting orders are eligible considering price, type, display status,
   self-trade prevention, participant constraints, minimum quantity, and other
   venue rules?
3. Among eligible orders, which has priority?
4. At what price and quantity does execution occur?
5. What happens to the residual?

Price-time priority is one allocation rule:

- better prices before worse prices;
- within one price, earlier priority timestamp/sequence before later.

Other venues/products may use pro-rata, size-time, participant allocation,
randomized or parity mechanisms, special market-maker priority, or separate
displayed/hidden precedence. A book can still use price levels while the
per-level allocator is not FIFO.

### Execution Price

The continuous model in the next section executes at the resting price. That is
common for a simple price-time central limit order book, but auctions clear at a
single auction price, midpoint pools use a reference price, and other matching
mechanisms can improve or determine price differently. Quote the exact venue
rule, product, phase, and effective version.

### Execution Reports Versus Market-Data Events

One match can create:

- private execution reports for the aggressor and resting participant;
- order-status/leaves updates;
- public trade event(s);
- public level/order deletes or quantity changes;
- fee/liquidity indicators.

These are not necessarily one-to-one or delivered on the same channel. A
private fill is authoritative for the participant's order; a public trade is
not a substitute for it. Conversely, a public order-book event must be applied
according to the market-data feed specification, not reconstructed from one's
private orders.

A useful execution report contains or lets the client derive: order identity,
execution identity, last quantity/price, cumulative quantity, leaves, status,
liquidity/fee attributes, and correction references where supported.

## 50.9 A Validated Price-Time Simulation — Core

This small C++23 program implements one deliberately narrow rule:

- asks are ordered by ascending integer price;
- orders at a price are FIFO;
- an incoming buy limit executes at each resting ask's price;
- the caller supplies the residual policy;
- there are no hidden orders, self-trade rules, minimum quantities, replace,
  auction, persistence, or concurrency.

It is a teaching model, not a venue implementation.

```cpp
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <deque>
#include <map>
#include <utility>
#include <vector>

using Price = std::int64_t;
using Qty = std::uint64_t;

struct Resting { std::uint64_t id; Qty leaves; };
struct Fill {
    std::uint64_t resting_id;
    Price price;
    Qty quantity;
    friend bool operator==(const Fill&, const Fill&) = default;
};

class AskBook {
    std::map<Price, std::deque<Resting>> levels_;
public:
    void add(std::uint64_t id, Price price, Qty quantity) {
        assert(quantity > 0);
        levels_[price].push_back({id, quantity});
    }

    std::pair<std::vector<Fill>, Qty> buy(Price limit, Qty quantity) {
        std::vector<Fill> fills;
        while (quantity != 0 && !levels_.empty()) {
            auto level = levels_.begin();
            if (level->first > limit) break;
            auto& order = level->second.front();
            const Qty traded = std::min(quantity, order.leaves);
            fills.push_back({order.id, level->first, traded});
            quantity -= traded;
            order.leaves -= traded;
            if (order.leaves == 0) level->second.pop_front();
            if (level->second.empty()) levels_.erase(level);
        }
        return {std::move(fills), quantity};
    }

    [[nodiscard]] Qty quantity_at(Price price) const {
        const auto level = levels_.find(price);
        if (level == levels_.end()) return 0;
        Qty total = 0;
        for (const Resting& order : level->second) total += order.leaves;
        return total;
    }
};

int main() {
    AskBook asks;
    asks.add(1, 100, 4);
    asks.add(2, 100, 3);
    asks.add(3, 101, 5);

    auto [fills, residual] = asks.buy(101, 8);
    assert(residual == 0 && fills.size() == 3);
    assert((fills[0] == Fill{1, 100, 4}));
    assert((fills[1] == Fill{2, 100, 3}));
    assert((fills[2] == Fill{3, 101, 1}));
    assert(asks.quantity_at(100) == 0);
    assert(asks.quantity_at(101) == 4);
}
```

The assertions validate price order, FIFO at 100, partial consumption at 101,
and removal of the empty level. A production engine also needs overflow-safe
aggregates, an ID index, arbitrary cancel, allocation policy, event emission,
recovery, and venue rules.

## 50.10 Worked Book and Matching Trace — Core

Use the same explicitly named model: continuous trading, price-time priority,
resting-price execution, visible orders only, DAY residuals rest, IOC residuals
cancel, and no self-trade or special priority.

Initial book:

```
BIDS                              ASKS
99 × 6 : B1                       100 × 7 : A1(4), A2(3)
                                  101 × 5 : A3(5)
```

Event 1: `BUY 8 @ 101 IOC`, order `X`.

| Step | Eligible resting order | Execution | Aggressor leaves | Book mutation |
|---:|---|---|---:|---|
| 1 | A1, first at best ask 100 | X/A1: 4 @ 100 | 4 | Remove A1; level 100 has A2(3) |
| 2 | A2, next FIFO at 100 | X/A2: 3 @ 100 | 1 | Remove A2 and empty level 100 |
| 3 | A3 at 101, within limit | X/A3: 1 @ 101 | 0 | A3 leaves 4 |

The order is fully filled. The resulting BBO is bid 99 × 6, ask 101 × 4.
Aggregate traded quantity is 8 and resting quantity fell by 8.

Event 2: `SELL 8 @ 99 DAY`, order `Y`.

`Y` matches B1 for 6 at the resting price 99. It has 2 leaves. No more bids are
eligible, so the residual rests as a new ask at 99. The book becomes:

```
BIDS                              ASKS
empty                             99 × 2 : Y(2)
                                  101 × 4 : A3(4)
```

That is not an invalid crossed book: there is no bid. If a new bid at 100
arrives, it must match Y before it can rest under this model.

### Edge Cases the Trace Hides

- If X were FOK for 9, this book has 12 available through 101 and can fill it;
  if X were FOK for 13, it must execute none.
- If X were post-only, it would be handled before matching because it crosses.
  Reject, slide, or cancel depends on the named venue rule.
- If A1 belonged to the same participant as X, self-trade policy could cancel
  one side, decrement both, or skip it; each changes the trace.
- If A2 were hidden and displayed orders had priority, A3 or another displayed
  order could allocate differently despite price.
- If the market were in an auction phase, no continuous walk need occur; X may
  enter the auction pool.
- If a cancel for A1 was sequenced before X, A1 would not be eligible. If after
  X, its cancel would apply only to remaining leaves, which are zero.

This is why replay inputs must include venue sequence, market phase, and rule
version—not only order fields.

## 50.11 Add, Cancel, Modify, and Execute Events — Core

Both matching engines and reconstructed books can be described as event
reducers, but their inputs differ.

| Event | Required lookup | Invariants affected | Failure response |
|---|---|---|---|
| Add | New unique order ID, valid level | ID index, FIFO/priority, aggregate, BBO | Reject/flag duplicate or invalid input |
| Cancel/delete | Existing live ID or feed-defined tolerance | Leaves, aggregate, unlink, possibly BBO | Gap/reconcile on impossible reference |
| Modify | Existing ID plus version/rules | Quantity, price, priority, aggregates, BBO | Apply venue semantics atomically |
| Execute | Existing eligible order or feed-defined execution form | Leaves, trade ledger, aggregate, unlink/BBO | Deduplicate; reject negative/impossible leaves |

An order-level market-data feed may send a replace as delete-plus-add. A
price-level feed may send only a new aggregate. A trade feed may not identify
resting orders. Do not invent per-order FIFO state from aggregate messages.

### Atomic Book Mutation

For a cancel of the final best ask:

1. find the order by ID;
2. validate generation and cancellable leaves;
3. subtract its leaves from level aggregate;
4. unlink it and remove ID mapping;
5. remove the empty level;
6. advance best ask;
7. emit/persist the resulting event as required.

If an engine can throw or allocate in the middle, preallocate or stage the
mutation so observers never see a half-updated book. A single-writer event loop
often simplifies this invariant; it is a design choice, not proof that the
whole system is single-threaded.

### Feed Gaps and Impossible Events

A cancel for an unknown ID, execution beyond leaves, repeated add, or negative
aggregate may indicate:

- an actual implementation bug;
- duplicate/replayed data;
- an unhandled replace generation;
- market-data loss or wrong snapshot boundary;
- a permitted feed behavior not represented by the model.

Stop applying uncertain deltas when correctness requires it. Mark the book
stale, recover according to Chapter 51, and prevent strategies from treating
the corrupt replica as authoritative.

## 50.12 Auctions and Market-Phase Events — Core

Continuous trading matches each incoming instruction against the current book.
A call auction accumulates eligible interest and chooses an uncrossing price at
a scheduled or triggered event.

At candidate price \(p\):

\[
V(p) = \min(\text{buy quantity eligible at or above }p,
            \text{sell quantity eligible at or below }p)
\]

A common family of algorithms first maximizes \(V(p)\), then applies
venue-specific tie-breakers such as minimizing imbalance, minimizing distance
from a reference price, or choosing a side-favoring price. This is a teaching
pattern, not a universal tie-break order.

### Phase State Machine

```
Closed
  │ session start
  ▼
Pre-open/auction accumulation ──uncross event──▶ Continuous
         ▲                                           │
         │ reopen                                    │ halt trigger
         └──────── Halt/auction accumulation ◀───────┘
                          │
                          └─close auction──▶ Closed
```

For each phase, version:

- accepted order types and TIFs;
- whether market orders, stops, and pegs are accepted, suspended, or converted;
- whether orders may cancel/modify during freeze/no-cancel periods;
- which quantity is displayed in indicative price/imbalance messages;
- allocation priority at the clearing price;
- residual carry, cancel, or conversion into continuous trading;
- price-band, extension, halt, and no-cross behavior.

Auction execution commonly gives all matched quantity one clearing price, but
even that must be checked for the product and auction. Priority at the clearing
price may use time, pro-rata, imbalance-side rules, market-order precedence, or
special allocations. A continuous FIFO queue is not enough to simulate it.

### Worked Uncross Reasoning

Suppose an illustrative auction contains:

```
Buys:  8 @ 101, 7 @ 100
Sells: 5 @  99, 6 @ 100, 9 @ 101
```

At 99, eligible buys total 15 and eligible sells total 5, so `V(99)=5`.
At 100, eligible buys total 15 and sells total 11, so `V(100)=11`.
At 101, eligible buys total 8 and sells total 20, so `V(101)=8`.

Maximizing executable volume selects 100 uniquely; no tie-break is needed.
Eleven units execute at the model's clearing price 100. Allocation of the 15
eligible buy units is still unspecified. A pro-rata auction and a
market/time-priority auction can produce the same price and volume but different
participant fills.

Market-phase changes are ordered events. A late pre-open add processed before
the uncross can participate; one processed after it cannot, regardless of
client send time.

## 50.13 Matching-Engine Design — Core

A matching engine's central promise is deterministic state transition:

```text
validated ordered input
        ↓
instrument/phase state
        ↓
eligibility + priority + allocation
        ↓
atomic book/order mutation
        ↓
ordered private reports + public events + durable recovery record
```

### Single Writer and Sharding

A common architecture assigns each instrument or partition to one logical
writer. This removes locks from the state transition and gives a clear total
order. Parallelism comes from sharding instruments/partitions and moving
encoding, persistence, risk preparation, or publication to carefully ordered
stages.

The trade-offs:

- a hot instrument can dominate one shard;
- cross-instrument orders/auctions require coordination;
- moving reports to another thread needs bounded queues and preserved order;
- recovery must replay the same rules and version to reproduce state.

Multi-threaded matching is possible, but the design must define serialization
for conflicting orders. “Lock-free” is not a matching semantic.

### Critical-Path Discipline

Likely hot operations are ID lookup, best-level lookup, head allocation,
quantity decrement, unlink, level removal, and event creation. Candidate
techniques include preallocated order nodes/events, integer fields, stable
handles, compact levels, and predictable single-writer mutation.

Correctness gates come first:

- validation completes before book mutation;
- arithmetic checks prevent quantity/notional overflow;
- events are emitted from committed state;
- partial failure cannot publish half a match;
- deterministic replay uses the same reference data, phase, and rule version;
- overload has a defined reject/backpressure policy rather than silent loss.

Do not claim a nanosecond budget without a named CPU, compiler, data set, active
level distribution, order mix, persistence mode, and percentile. Measure
throughput, per-event distributions, queueing, cache behavior, allocation, and
replay equivalence.

## 50.14 Venue-Rule Checklist — Reference

*Skippable on a first pass. This is a specification-review checklist, not a
catalog of current venue defaults.*

| Area | Questions to version |
|---|---|
| Price/quantity | Scale, tick schedule, lot/minimum, bands, rounding |
| Market/limit | Empty-book behavior, collars, residual, execution-price rule |
| IOC/FOK | Eligible pools, hidden size, MinQty, routing/auction scope |
| Post-only | Reject/cancel/slide; accepted price; locked/crossed handling |
| Stop | Native/synthetic, trigger source, equality, phase and conversion |
| Peg | Reference, offset units, cap, rounding, absent reference, reprice priority |
| Modify | In-place versus cancel/new; ID and priority changes by field |
| Allocation | Price-time, pro-rata, display/hidden, participant/special priority |
| Self-trade | Which order cancels/decrements; execution/report behavior |
| Auction | Candidate price, tie-breaks, freeze, allocation, residual |
| Lifecycle | Acceptance/fill ordering, execution-ID scope, bust/correct semantics |
| Sessions | Supported phases/TIFs, expiry boundary, halt/reopen behavior |

Store effective dates and rule/protocol versions with configuration and replay
artifacts. A venue can change behavior without changing the familiar order-type
name. Test certification cases at the boundary: equality at stop/limit, final
lot, one-tick lock, zero liquidity, price-band edge, last cancel before auction,
and replace concurrent with fill.

## 50.15 Common Traps — Core

- Encoding market orders with extreme limit-price sentinels that later enter
  arithmetic.
- Treating signed quantity as side and losing regulated/product side semantics.
- Confusing client intent, local pending state, and authoritative venue state.
- Reusing a client ID after timeout or allowing a stale replace generation to
  mutate the current order.
- Setting exposure to zero when a cancel is sent rather than accepted.
- Treating a fill after cancel request as impossible.
- Applying a duplicate execution twice, or discarding a bust/correction as a
  duplicate.
- Assuming acceptance means the order rested at the submitted price.
- Assuming every aggressive limit trades at resting price.
- Assuming IOC must fill something, FOK examines only displayed liquidity, or
  GTC persists indefinitely.
- Treating post-only as universally reject-on-cross.
- Assuming every price/quantity change loses priority, or every reduction keeps
  it.
- Triggering a stop from the wrong reference or equality rule.
- Assuming pegged orders always reprice before the event that changed the peg.
- Modeling an aggregate feed as if it exposed per-order FIFO.
- Updating level aggregate, order node, ID index, and BBO in separate visible
  steps.
- Leaving empty levels addressable as the best price.
- Declaring every locked/crossed observation corrupt without considering phase,
  feed ordering, hidden/eligibility rules, or multiple venues.
- Using one continuous price-time matcher for auctions.
- Choosing an auction price without specifying participant allocation.
- Publishing execution reports before the state mutation is committed.
- Optimizing the container while ignoring cancel rate, active price range,
  allocation policy, recovery, and rule-version correctness.
- Pulling gateway/session sequencing and reconnect logic into the book reducer;
  Chapter 54 owns that boundary.

## 50.16 Recall and Practice — Core

### Recall Card

- An order combines side, integer quantity, type, price/trigger/peg constraints,
  TIF, execution flags, instrument, account, and identifiers.
- Separate immutable client intent from mutable accepted venue facts.
- Client ID, venue order ID, execution ID, and replace generation solve
  different identity problems.
- Pending cancel/replace is live risk; venue event order resolves fill races.
- Deduplicate executions before updating positions, and treat corrections as
  explicit economic events.
- Market has no limit; limit sets a worst price; IOC cancels residual; FOK is
  all immediately or none; DAY/GTC/GTD lifetimes are venue-defined.
- Stop trigger and peg reference/repricing are versioned venue rules.
- A price-time book needs ordered levels, FIFO per level, ID lookup, exact
  aggregates, and a nonempty-level BBO.
- Eligibility comes before priority. Price-time is only one allocation rule.
- ADD/CANCEL/MODIFY/EXECUTE must update order, level, index, aggregate, and BBO
  as one logical transition.
- Continuous matching walks eligible liquidity; an auction chooses a clearing
  price and separately allocates volume.
- Replay must bind reference data, phase, protocol, and rule version.

### Reasoning Questions

1. A cancel was sent before a fill was received. Why can the fill still be
   correct, and what exposure should risk hold while cancel is pending?
2. Which identities make a replace chain and duplicate execution idempotent?
3. A post-only order is acknowledged at a different price. Name two valid
   venue behaviors and the client invariant that prevents a reprice loop.
4. Why can stop-market protect execution certainty but not price, while
   stop-limit protects price but not execution?
5. A price-time book's best ask is removed. Which structures and aggregates
   must change atomically?
6. When does a dense tick array beat an ordered map, and which workload
   measurements support the decision?
7. A quantity reduction retains priority on venue A but loses it on venue B.
   Where must that difference live in simulation and recovery?
8. Why are an aggressor's private fill and a public trade event not
   interchangeable?
9. Two auction prices maximize executable volume. Which additional rule is
   required before the result is deterministic?
10. What evidence would show that a matching-engine optimization preserved
    semantics, not merely final BBO?

### Code-Reading Puzzle

```cpp
void on_cancel_sent(Order& order) {
    order.state = State::Cancelled;
    risk.remove_open_quantity(order.leaves);
    ids.release(order.client_id);
}
```

Three minutes later, the venue sends a full fill followed by a cancel reject.
Identify the three false assumptions, explain the possible position/ID
corruption, and sketch the correct `PendingCancel` transition and idempotent
fill handling.

### Applied Exercise

Implement the worked model for both sides with:

- integer prices and quantities;
- price-time levels plus an ID index;
- DAY and IOC residual behavior;
- add, partial/full execute, cancel, and quantity-reduction events;
- invariant checks after every event.

Generate random valid events, replay them twice, and compare the full ordered
execution stream and final order/level state—not only BBO. Then introduce one
venue variation (pro-rata allocation, post-only slide, or modification priority)
behind an explicit rule-policy version and show which expected trace changes.

### Prerequisites for Chapter 51

Chapter 51 assumes you can distinguish client intent from venue state, reduce
ordered lifecycle and book events idempotently, maintain book invariants, and
name the venue rule/version that determines matching. It teaches how exchange
protocols frame, encode, sequence, validate, replay, and recover those events.
Gateway/session order management remains in Chapter 54.
