# Chapter 49 — Market Fundamentals

## Why this matters

A financial market is a mechanism for bringing buying and selling interest together under published rules. For an engineer, the essential objects are instruments, venues, sessions, orders, quotes, trades, books, and reference data. The essential discipline is to know which facts are definitions and which belong to a particular jurisdiction, venue, protocol version, or trading day.

This chapter supplies the vocabulary used in Chapters 50–54. It is engineering context, not trading advice. It deliberately avoids a catalog of exchanges and products: venue rules change, instrument parameters have effective dates, and the same word can have different protocol meanings.

Use this label on every market claim:

| Label | Example | Where truth comes from |
|---|---|---|
| General mechanism | a limit order sets a worst acceptable price | market-model definition |
| Jurisdiction rule | which quotes receive protection | current regulation and scope |
| Venue rule | allocation, auction tie-break, modification priority | current venue rulebook |
| Protocol fact | field encoding, status code, sequence behavior | exact feed/order-entry specification |
| Reference datum | tick, multiplier, session calendar, symbol mapping | versioned, effective-dated source |
| Observation | spread, depth, fill rate, latency | a named data set and measurement method |

“Equities use FIFO,” “futures use pro-rata,” “the close is at 16:00,” and “one contract is worth 100 units” are not safe general statements. Some may describe a particular product on a particular venue today. None is a definition.

## The 90-second screen — Core

Given a market event or an unfamiliar feed, answer these questions before interpreting prices:

1. **What exactly is the instrument?** Include venue-native ID, listing/contract, currency, expiry, option terms or legs, and effective trading date.
2. **Which venue and market segment?** Exchange order book, dealer market, bilateral venue, auction facility, dark pool, or another mechanism?
3. **What session state is active?** Pre-open, auction call, continuous matching, halt, volatility interruption, post-close, or closed?
4. **What view does the data provide?** Best quote, market by price (MBP), market by order (MBO), trades, indicative auction data, or consolidated data?
5. **What are the units?** Price scale, tick table, quantity increment, lot convention, contract multiplier, and currency.
6. **Which ordering and allocation rules apply?** Price-time, pro-rata, a hybrid, hidden/display priority, or another documented algorithm?
7. **Which costs apply?** Venue fees/rebates, clearing and regulatory charges, commissions, financing, and market impact—each with its own scope.
8. **Is the state trustworthy?** Check sequence continuity, instrument definitions, session status, and cross/lock rules before acting on a suspicious book.

The compact market picture is:

```text
issuer / borrower / hedger / investor / dealer / arbitrageur
                         |
                 broker or direct member
                         |
       +-----------------+------------------+
       |                 |                  |
  exchange book      dealer/OTC        auction or other
       |                 venue              mechanism
       +-----------------+------------------+
                         |
          orders -> matching -> executions
                         |
       quotes / depth / trades / status / reference data
                         |
           feeds, clearing, positions, risk, reporting
```

Roles overlap. A firm may be an investor in one trade, liquidity provider in another, broker for a client, and clearing member operationally. Do not infer legal responsibility or economic intent from a packet field called “trader.”

## 49.1 Participants, venues, and instruments — Core

### Participants and infrastructure

A **buyer** acquires an instrument; a **seller** disposes of it. That describes one transaction, not a permanent class of firm. A participant may submit orders directly as a venue member or indirectly through a broker. Common roles include:

- **asset owner or investor**, allocating capital;
- **hedger**, reducing exposure to another price or cash flow;
- **speculator**, accepting price risk;
- **market maker or liquidity provider**, repeatedly quoting interest under a commercial or venue arrangement;
- **broker or agency algorithm**, handling another party’s order;
- **dealer**, trading as principal with customers or other dealers;
- **arbitrageur**, trading related instruments or venues;
- **exchange/venue operator**, applying entry, priority, matching, and publication rules;
- **clearing organization and clearing member**, managing obligations after execution;
- **market-data vendor/consolidator**, normalizing or combining venue data;
- **regulator or self-regulatory body**, defining and enforcing rules within a jurisdiction.

These are functional descriptions. Registration categories and duties are jurisdiction-specific and time-sensitive.

A **venue** is a place or system in which trading interest interacts. An order-driven exchange commonly maintains a central limit order book. A quote-driven dealer market exposes dealer prices. Some systems match bilaterally, periodically, conditionally, or without publicly displayed orders. A **lit** venue publishes specified pre-trade interest; a **dark** mechanism withholds some or all of it under its applicable rules. “Exchange,” “market,” “venue,” and “matching engine” are not interchangeable.

An **instrument** is the legal/economic object being traded. Major families include cash equities, debt, funds, currencies, commodities, futures, options, swaps, and multi-leg strategies. The same economic exposure can appear in several instruments with different settlement, expiry, margin, currency, trading hours, and contract sizes.

An **underlying** is the asset or reference from which a derivative derives value. A futures instrument normally has an expiry and contract specification. An option additionally has a strike, call/put kind, exercise style, and expiry. A spread or strategy instrument may have legs and ratios but still receive its own venue-native ID and order book. Never synthesize identity from a display symbol alone.

Several adjacent distinctions prevent category errors:

| Term | Meaning | Engineering consequence |
|---|---|---|
| Primary market | creation or issuance of a security or claim | workflow and pricing can differ from secondary trading |
| Secondary market | transfer among holders after issuance | the familiar order/quote/trade vocabulary applies here |
| Listing | admission of an instrument to a venue or segment | one security can have several listings or trading lines |
| Spot/cash | transaction for the market’s standard near settlement | settlement date and calendar remain product-specific |
| Forward/future | obligation referenced to a future date | expiry, settlement, and multiplier are part of identity |
| Fungible interest | positions can satisfy the same delivery obligation | do not infer fungibility from economic similarity |
| Outright | one instrument traded directly | contrast with a spread/strategy of several legs |
| Position | accumulated signed holdings after executions | distinct from live orders and displayed depth |

An **execution** creates contractual obligations; **clearing** determines and manages obligations between clearing participants; **settlement** completes delivery/payment under the product’s rules. A trade can be final for matching purposes while still subject to correction, cancellation, clearing rejection, or settlement-failure processes. Market-data consumers should not invent post-trade finality from a trade print.

### Instrument identity

A production identity should distinguish at least:

```text
(venue or market segment, venue-native instrument ID, definition version/session)
```

Human-readable symbols are labels, not durable primary keys. The same ticker can trade on multiple venues, be reused over time, or refer to different currencies or listings. Global identifiers can identify a security without identifying a specific venue listing. Derivative display codes often encode expiry, but encoding conventions and rollover rules vary.

The hot path normally maps a compact protocol identifier to prevalidated instrument state. The cold path maintains symbols, alternate identifiers, descriptions, calendars, and history. A feed’s numeric ID may be stable, session-scoped, or definition-version-scoped; that is a protocol/venue fact.

## 49.2 Sessions and market states — Core

A **trading session** is a venue-defined interval and state machine, not merely a wall-clock range. A common conceptual lifecycle is:

```text
CLOSED
  -> PRE_OPEN / AUCTION_CALL
  -> OPENING_UNCROSS
  -> CONTINUOUS
  -> CLOSING_CALL
  -> CLOSING_UNCROSS
  -> POST_CLOSE
  -> CLOSED

CONTINUOUS -> HALT or VOLATILITY_CALL -> REOPENING_UNCROSS -> CONTINUOUS
```

This is a model, not a universal transition diagram. Venues may have several daytime auctions, order-entry-only states, cancel-only windows, maintenance states, instrument-specific interruptions, or sessions crossing midnight. A venue status message should normally drive state; a calendar and clock predict expected state and detect missing messages, but should not fabricate an opening.

**Continuous trading** is the phase in which eligible incoming interest can interact immediately under the venue's matching rules, rather than waiting for a scheduled call auction. It does not imply uninterrupted matching: instrument halts, volatility interruptions, price controls, technical states, and closed sub-sessions remain venue-specific.

State changes what is valid:

| Property | Continuous book | Auction call | Halt/interruption |
|---|---|---|---|
| Matching | typically immediate when eligible interest crosses | interest accumulates until uncross | suspended or restricted |
| Crossed indicative interest | may violate continuous-book rules | often meaningful and expected | venue-specific |
| Accepted instructions | normal venue set | special/limited set | cancel, entry, and modification rules vary |
| Published data | book, quotes, trades, status | indicative price/volume/imbalance plus status | status and possibly frozen/purged/auction data |
| Existing orders | matched/cancelled normally | may participate subject to rule | retained, purged, suspended, or migrated by rule |

Session status is commonly per instrument or trading segment. One instrument can halt while others continue. Engineering systems should gate order intent by the exact venue state, preserve status sequence, reconcile resting orders after exceptional transitions, and distinguish “no messages” from an explicit halt.

**Venue-specific example, versioned:** Nasdaq’s U.S. equity Opening and Closing Crosses publish imbalance information and accept defined cross order types on published schedules. Those names, cutoffs, eligibility rules, and tie-breaks are Nasdaq rules, not generic auction definitions. Read the current rule and protocol documents before implementation.

## 49.3 Orders, quotes, and trades — Core

An **order** expresses an instruction to buy or sell. Its essential fields include instrument, side, quantity, and constraints. A **limit order** sets a worst acceptable execution price: a buy limit may execute at its limit or lower; a sell limit at its limit or higher. A **market order** seeks immediate execution under venue rules but does not guarantee a price. Exact order types and time-in-force constraints belong to Chapter 50 and the venue specification.

A **bid** is buy interest or its price. An **offer** or **ask** is sell interest or its price. In a book:

- the **best bid** is the highest-priced eligible displayed bid;
- the **best ask** is the lowest-priced eligible displayed offer;
- the **BBO** is the venue’s best bid and offer, normally with sizes;
- the **touch** or **top of book** is those best levels;
- the **last price** is the price of a selected most recent trade, under a stated trade-eligibility definition.

“Buy side” and “sell side” are overloaded. In an order-book discussion they mean bids and asks. In industry organization, “buy side” and “sell side” describe firm categories. State which meaning you intend.

An incoming order that immediately executes against resting interest is often called the **aggressor** or **taker**; the resting order is passive and often called the **maker**. To **hit the bid** is to sell into a bid. To **lift/take the offer** is to buy from an offer. These terms describe interaction with displayed/resting interest; a venue’s liquidity indicator is authoritative for fees.

A **quote** is published trading interest or an indicative price, depending on data context. A **trade**, **fill**, or **execution** reports that quantity changed hands at a price. One aggressing order can generate several executions. A trade message is not necessarily an order deletion, and a quote update is not necessarily a trade. Market-data feeds can publish them on different channels or with different sequence domains.

### Order-intent vocabulary

Order names describe constraints, not guaranteed outcomes. Chapter 50 develops their lifecycle, but the vocabulary is needed here:

| Intent | Generic meaning | Why the venue specification still matters |
|---|---|---|
| Market | seek immediate execution without a stated limit price | protection bands, conversions, rejection, and remainder handling vary |
| Limit | execute only at the limit or better | may take immediately, rest, partially fill, or expire |
| Immediate-or-cancel | execute eligible quantity now, cancel remainder | “now,” eligible liquidity, and auction availability are venue-defined |
| Fill-or-kill | execute the required quantity immediately or none | pre-check scope and supported sessions vary |
| Post-only | avoid taking liquidity under a specified rule | venue may reject, cancel, or reprice a marketable instruction |
| Pegged | derive price from a named reference plus constraints | reference, rounding, update priority, and protection vary |
| Stop/triggered | activate after a defined trigger | trigger source, side, session, and resulting order differ |
| Auction-specific | participate in an opening, close, or other call | cutoffs, imbalance effect, and rollover are venue rules |

A limit is a price constraint, not a statement that the order is passive. A buy limit above the current ask can remove liquidity. A market order is not a promise of immediate complete execution: available liquidity, controls, state, and venue behavior determine the result.

### Bid, ask, mid, and spreads

For best bid \(b\), best ask \(a\), and positive sizes:

\[
\text{quoted spread}=a-b,\qquad
\text{mid}=\frac{a+b}{2}
\]

The mid is a reference, not necessarily an executable or tick-valid price. When one side is absent, neither spread nor mid is normally defined. Avoid sentinel arithmetic such as subtracting “no ask” from a real bid.

For an execution price \(p\), quantity \(q\), and side sign \(s=+1\) for a buyer and \(-1\) for a seller, one common transaction-cost convention is:

\[
\text{signed cost per unit}=s(p-m)
\]

\[
\text{effective spread}=2s(p-m)
\]

where \(m\) is a clearly timestamped reference midpoint, commonly at order receipt or execution in a specified analysis. Definitions used for regulatory reports may prescribe the reference, exclusions, and timestamp; do not substitute this generic formula blindly.

A **realized spread** compares the execution with a later midpoint to separate short-horizon price movement from the immediate execution concession. Its horizon and sign convention must be stated. A **markout** is a related signed change after a selected horizon. None is meaningful without clock alignment, data source, and side.

### Worked spread and execution cost

Suppose this illustrative book is denominated in dollars and the tick is $0.01:

```text
                 quantity   price
bids                 700    100.00
                   1,200     99.99

asks                 200    100.02
                     500    100.03
                   1,000    100.05
```

The quoted spread is \(100.02-100.00=\$0.02\), and the midpoint is $100.01. An immediate buy of 600 units walks the asks:

```text
200 @ 100.02 = 20,004
400 @ 100.03 = 40,012
total cost    = 60,016
VWAP          = 60,016 / 600 = 100.026666...
```

The arrival-price slippage relative to the best ask is about $0.006667 per unit, or $4 total. Signed cost relative to the initial midpoint is about $0.016667 per unit, or $10 total. The effective-spread convention gives about $0.033333 per unit. These answer different questions; calling all three “spread cost” creates reconciliation errors.

If this buyer later sells 600 at $100.04 and pays $0.30 total entry fees plus $0.30 exit fees:

\[
\text{cash P\&L}=600(100.04)-60{,}016-0.60=\$7.40
\]

This is a deliberately simple cash calculation. A derivative may require a multiplier; a cross-currency trade needs FX translation; positions held across time may incur financing, margin, settlement, and corporate-action effects.

## 49.4 Limit-order books, levels, and liquidity — Core

A **limit-order book** organizes currently active eligible interest by price. A **price level** contains all interest at one price. Bids sort from highest to lowest; asks sort from lowest to highest:

```text
             BIDS                         ASKS
price       quantity                price       quantity
100.00          700   <- best       100.02          200 <- best
 99.99        1,200                100.03          500
 99.98          300                100.05        1,000
```

**Market by price (MBP)** publishes aggregate quantity at each level. **Market by order (MBO)** publishes individual orders or order-like entries with identifiers. These names are clearer than “Level 2/Level 3,” whose usage varies. A feed can be depth-limited, omit hidden interest, conflate order types, or publish implied/synthetic entries. “Full depth” must be defined by the feed specification.

**Depth** is available displayed quantity at specified price levels in the observed view. **Liquidity** is broader:

- **tightness:** quoted or effective spread;
- **depth:** displayed/executable size near relevant prices;
- **immediacy:** ability to transact a desired quantity promptly;
- **resilience:** how quickly prices and depth recover after consumption;
- **breadth/fragmentation:** where substitutable liquidity exists;
- **stability:** how long displayed interest remains available.

Displayed depth is not a promise of execution. It may change before an order arrives. Hidden or reserve interest may make actual execution larger than display. Another participant may consume it first. A consolidated view can be older than a direct venue view. A price may be indicative, protected, firm, non-firm, or executable only for certain participants or quantities under the applicable rules.

Distinguish these frequently conflated quantities:

| Quantity | What it answers | What it omits |
|---|---|---|
| displayed size | what this feed currently publishes at a price | hidden interest and later changes |
| executable size | what a particular order could interact with under current rules | latency before arrival and market response |
| order quantity | what a participant requested | fills, cancels, and venue adjustments after submission |
| leaves quantity | live unexecuted remainder according to an order state | executions not yet received or reconciled locally |
| traded volume | qualifying executions accumulated over an interval | live liquidity and cancelled interest |
| open interest | outstanding derivative contracts under its reporting definition | intraday order-book depth |

Volume is a flow; depth is a state. A market can report high daily volume and have little displayed depth at a particular instant. Conversely, a deep book can trade little if interest never crosses.

The **VWAP** of a book walk is:

\[
\operatorname{VWAP}=\frac{\sum_i p_iq_i}{\sum_iq_i}
\]

Use fixed-point/integer units and a widened intermediate. Stop at the order’s limit price, desired quantity, or exhausted eligible liquidity. The book snapshot is only a counterfactual: submitting the order can change the market, and the observed depth can disappear.

A common descriptive imbalance is:

\[
I=\frac{Q_b-Q_a}{Q_b+Q_a}
\]

for defined bid and ask quantities \(Q_b,Q_a\), perhaps at the touch or over \(N\) levels. It is undefined when the denominator is zero. Level count, weighting, hidden-interest treatment, and sampling timestamp must accompany the value. It is a measurement, not a universal predictor.

## 49.5 Ticks, quantities, lots, and multipliers — Core

The **tick size** or minimum price increment is the permitted price step under the applicable rule. A **price scale** says how an encoded integer maps to a quoted price. They are not the same:

```text
protocol integer 1000234 with scale 10^-4 -> quoted 100.0234
tick 0.0050                               -> valid prices differ by 50 encoded units
```

A tick can be fixed, depend on price bands, depend on an instrument classification, or change on an effective date. Some instruments use fractional display conventions while protocols still encode integers. A grid may have a nonzero base. The order-entry rule may also distinguish display increment from execution increment.

**Jurisdiction example, versioned:** European equity tick regimes under MiFID-related technical standards use prescribed tables and liquidity/price inputs. **Venue/product example:** some derivatives use product-specific fixed or fractional increments. Neither supports hard-coding “all stocks tick by one cent.”

Use fixed-point integers:

```cpp
#include <cstdint>
#include <optional>

struct Grid {
    std::int64_t base;
    std::int64_t tick;
};

std::optional<bool> on_tick_grid(std::int64_t price, Grid g) {
    if (g.tick <= 0) {
        return std::nullopt;
    }
    auto price_remainder = price % g.tick;
    auto base_remainder = g.base % g.tick;
    if (price_remainder < 0) price_remainder += g.tick;
    if (base_remainder < 0) base_remainder += g.tick;
    return price_remainder == base_remainder;
}
```

This validates membership without overflowing `price - base`; rounding is a separate, side- and intent-sensitive policy. Negative prices are possible for some instruments, and C++ remainder truncates toward zero, which is why both remainders are normalized.

Quantity concepts also differ:

- **quantity increment:** smallest allowed quantity step;
- **minimum order quantity:** smallest accepted instruction;
- **round lot:** jurisdiction/venue-defined standard unit for specified purposes;
- **odd lot:** a quantity outside that round-lot convention;
- **contract multiplier/point value:** converts a quoted price movement into monetary value;
- **tick value:** tick size multiplied by the applicable contract multiplier and, where appropriate, currency conversion.

For a linear illustrative contract:

\[
\text{notional}=p\times M\times q,\qquad
\text{tick P\&L}=\Delta\text{ticks}\times \text{tick value}\times q
\]

If tick size is 0.25 currency units and multiplier is 40 currency units per price point, tick value is 10 currency units per contract. A three-contract move of five ticks changes value by \(5\times10\times3=150\) currency units. Whether “notional” is the right risk measure depends on the instrument; options and nonlinear products require more than this linear formula.

Price, scale, multiplier, currency, and quantity must be effective-dated reference data. Use a widened integer/rational or decimal representation for intermediate monetary arithmetic, and define rounding at accounting boundaries.

## 49.6 Matching priority and queue position — Core

When an incoming instruction can execute against several resting orders at the same eligible price, the venue needs an **allocation rule**. Price usually constrains which level is eligible; the within-level allocation can be price-time/FIFO, pro-rata, size/time, participant priority, displayed-before-hidden, a hybrid, or another published algorithm.

Under **price-time priority**, better price wins, then earlier venue priority within a price:

```text
resting bids
100.00: A 300 (first), B 500 (second)
 99.99: C 900 (older in wall-clock time than A)

incoming eligible sell quantity 600
-> A fills 300
-> B fills 300
-> C fills 0 because price outranks time
```

The matching engine’s accepted event order—not a client timestamp—defines venue priority. A natural representation is an ordered price map with a FIFO-like structure per level, but the protocol may expose less information than the venue internally uses.

**Queue position** is an order’s place under an ordering rule, often summarized as quantity ahead. If the MBO view shows:

```text
100.00 bid, front -> [A 300] [B 500] [YOU 200] [D 100]
quantity ahead of YOU = 800
```

an eligible sell execution of 850 would consume A and B, then 50 of YOU, assuming strict FIFO and no other event intervenes.

MBO can support deterministic queue reconstruction only when it exposes all priority-relevant events and identifiers. MBP generally cannot locate a particular order within a level. If an MBP level falls by 200, the decrease might be ahead of or behind the order. Separate trade data can reduce uncertainty if the venue rules make executions consume the visible FIFO, but hidden/reserve behavior and feed semantics still matter.

Modification priority is a venue rule:

| Action | Common FIFO treatment | Safe engineering stance |
|---|---|---|
| partial execution | remainder often retains priority | confirm venue rule |
| quantity decrease | often retains priority | confirm order type/venue |
| quantity increase | often loses priority | model exact replace semantics |
| price change | normally receives priority at new price | use venue acknowledgment/event |
| reserve replenishment | priority treatment varies | consume product specification |

Avoid “always” here. Even apparently ordinary changes can be represented as cancel/new by a protocol or receive special treatment by an order type.

## 49.7 Pro-rata and hybrid allocation — Core

Under a basic **pro-rata** model, first define eligible incoming quantity \(E=\min(Q,\sum_jq_j)\). Each resting order then receives a floor share proportional to its eligible displayed size:

\[
a_i=\left\lfloor E\frac{q_i}{\sum_j q_j}\right\rfloor
\]

For incoming quantity \(Q=100\) and resting sizes 60, 30, and 10, the exact shares are 60, 30, and 10. For \(Q=17\), floors yield 10, 5, and 1: one unit remains.

That residual proves why “pro-rata” is not a complete specification. A venue must define eligibility, minimum allocations, rounding, residual order, top-order or market-maker priority, displayed/hidden treatment, and whether earlier passes reduce the denominator. Hybrids may allocate part FIFO and part pro-rata.

Consider resting quantities `A=5`, `B=3`, `C=2`, with A, B, C also in arrival order, and incoming quantity 6. A floor pass gives:

```text
A: floor(6 * 5 / 10) = 3
B: floor(6 * 3 / 10) = 1
C: floor(6 * 2 / 10) = 1
allocated = 5; residual = 1
```

If the rule assigns residual FIFO, A receives the last unit and the result is `(4, 1, 1)`. If it assigns the largest fractional remainder, B’s fractional entitlement of 0.8 is largest and the result is `(3, 2, 1)`. Both conserve quantity and look “pro-rata”; only one can match a given venue rule. A minimum-allocation threshold or top-order pass can change the eligible set before these calculations.

An implementation should assert:

\[
0\le a_i\le q_i,\qquad
\sum_i a_i=\min(Q,\sum_i q_i)
\]

and apply each venue stage in a documented deterministic order. Property tests can verify conservation and bounds, but they cannot discover the venue’s intended residual rule.

**Venue-specific example, versioned:** CME Globex documents several product-assigned matching algorithms, including FIFO, pro-rata variants, and split algorithms. The algorithm can differ by product and can change by notice. “CME is pro-rata” is therefore wrong.

A deterministic integer calculation should widen before multiplication:

```cpp
#include <cstdint>
#include <optional>

std::optional<std::int64_t> floor_share(std::int64_t incoming,
                                        std::int64_t resting,
                                        std::int64_t total) {
    if (incoming < 0 || resting < 0 || total <= 0 || resting > total) {
        return std::nullopt;
    }
    const auto eligible = incoming < total ? incoming : total;
    const __int128 numerator =
        static_cast<__int128>(eligible) * resting;
    return static_cast<std::int64_t>(numerator / total);
}
```

This function only performs the floor share. It intentionally does not invent the residual rule. A simulator that matches the formula but not the exact venue stages can predict the wrong fills while preserving total quantity.

`__int128` is a GCC/Clang extension, not standard C++. A portable system needs a checked widened-integer, decimal, rational, or multiprecision alternative with explicit overflow behavior.

Allocation rules shape engineering incentives without determining them alone. FIFO makes earlier accepted priority valuable. Pro-rata makes displayed size relevant to allocation. Latency still affects reaction, cancellation, price selection, and whether an order is present at all. Product behavior should be measured rather than deduced from the algorithm name.

## 49.8 Fees, rebates, and P&L — Core

A venue may charge fees or pay rebates based on instrument, participant tier, order type, liquidity role, execution price/quantity, auction participation, routing, and effective date. **Maker-taker** commonly means charging liquidity removers and rebating providers; **inverted** or taker-maker pricing reverses that direction. Other schedules are flat, asymmetric, percentage-of-notional, per-contract, per-share/unit, capped, or bundled.

These labels do not determine a fill’s fee. Persist the venue’s execution/liquidity code and the schedule version. Do not infer “maker” merely because an order was a limit order: a marketable limit can remove liquidity, an order can rest before a later fill, and auctions use their own classifications.

For a simple linear trade:

\[
\text{gross cash P\&L}
=q(p_{\text{sell}}-p_{\text{buy}})M
\]

\[
\text{net P\&L}
=\text{gross P\&L}
-\text{fees}
+\text{rebates}
-\text{other costs}
\]

Signs should be explicit in storage. One robust ledger represents every cash movement as a signed amount rather than encoding “negative fee means rebate” inconsistently across reports.

Worked example: buy two contracts at 50.25 and sell at 50.75, with multiplier 20 currency units per point. Gross P&L is:

\[
2(50.75-50.25)20=20
\]

If total venue/clearing fees are 3.20, net is 16.80 before other costs. If the buys occurred at two prices, use actual fills, not an unweighted average. If the position remains open, a mark-to-market value is not realized cash P&L and must name its mark source.

Fee schedules are often tiered or reconciled after the fact, so an estimated real-time fee and final booked fee may legitimately differ. Store the inputs needed to reproduce both. A volume-proportional reconciliation difference isolated to one venue often indicates a wrong schedule version, unit, tier, liquidity code, or currency.

### Price, value, and return are different

For a signed position \(Q\), linear mark \(m\), and average entry \(e\), an unrealized mark-to-market expression is \(Q(m-e)M\). The sign of \(Q\) handles long versus short. But the mark could be midpoint, bid/ask liquidation value, official settlement, closing auction, last eligible trade, or a valuation model. Those choices serve different purposes.

**Return** normalizes a gain or loss by a stated capital, notional, price, or risk base. **P&L** is a monetary amount. **Notional** is an exposure scale and may not equal cash paid or maximum loss. **Market value** depends on position and mark. **Margin** is collateral required under a rule/model. Mixing them produces dashboards that appear numerically plausible but answer different questions.

## 49.9 Auctions, halts, and price bands — Core

In a **continuous double auction**, eligible incoming interest normally matches immediately against compatible resting interest. In a **call auction**, interest accumulates and is crossed at a designated event. An auction commonly chooses a single uncross price using objectives such as maximum executable volume, then venue-specific tie-breaks.

For candidate price \(p\):

\[
B(p)=\text{eligible buy quantity priced at or above }p
\]

\[
S(p)=\text{eligible sell quantity priced at or below }p
\]

\[
V(p)=\min(B(p),S(p))
\]

Maximum \(V(p)\) identifies volume-maximizing candidates. It does not finish the algorithm. Imbalance, market-order treatment, reference prices, collars, order-type priority, and tie-break order are venue rules.

### Worked auction snapshot

Illustrative call interest:

```text
buys                              sells
300 @ 101 or better              100 @  99 or better
400 @ 100 or better              500 @ 100 or better
200 @  99 or better              500 @ 101 or better
```

Cumulative candidates:

| Candidate | Buy quantity at/above | Sell quantity at/below | Executable |
|---:|---:|---:|---:|
| 99 | 900 | 100 | 100 |
| 100 | 700 | 600 | 600 |
| 101 | 300 | 1,100 | 300 |

Price 100 uniquely maximizes volume at 600, so no tie-break is needed. All auction executions normally use the selected uncross price under the assumed model. Real venue eligibility and tie-breaks can produce a different result from a naive cumulative table.

Venues may disseminate an **indicative match price**, paired volume, and buy/sell imbalance during a call. These values can revise as orders arrive and should not be applied as ordinary continuous-book executions. The uncross can produce a burst of trades and book/status changes, so consumers must size for event rate rather than daily average.

A **halt** or suspension stops or restricts matching. Causes can include news, volatility controls, venue operations, regulatory action, or market-wide rules. A **price band**, collar, or limit restricts order entry, display, or execution prices according to its own rule. “Outside the band” can mean reject, reprice, rest without execution, trigger an auction, or another state transition.

Do not memorize one jurisdiction’s thresholds as the definition. On a halt:

1. accept explicit status as data;
2. stop actions forbidden by the new state;
3. determine documented treatment of live orders;
4. continue sequence/recovery processing;
5. consume reopening-auction data separately;
6. reconcile orders and book state before resuming strategy actions.

A venue price band is not a participant’s risk control. It may be wider, use a different reference, or fail in a way the participant must handle.

The official opening, closing, or settlement price is a defined output, not necessarily “the first trade,” “the last trade,” or the auction price in every case. When an auction does not occur or fails validation, a venue may use a fallback rule. Store the price type and source alongside the number. Historical bars that label one field `close` can conceal materially different definitions across venues and instruments.

## 49.10 Fragmentation, locks, crosses, and data views — Core

An instrument or equivalent exposure can trade on several venues. **Fragmentation** means no single venue view necessarily contains all accessible liquidity. A **consolidated** view combines selected quotes/trades under a defined eligibility and timing policy. In U.S. equities, terms such as NBBO, protected quotation, round lot, and trade-through have regulatory definitions with changing implementation dates; do not treat “best across my feeds” as a regulatory NBBO.

For one observed view:

- **normal/positive spread:** best bid \(<\) best ask;
- **locked:** best bid \(=\) best ask;
- **crossed:** best bid \(>\) best ask.

These arithmetic definitions are general. Whether a state is permitted or expected depends on view and session. Crossed auction interest can be normal before an uncross. Independent venue quotes can temporarily form a locked or crossed consolidated view because of propagation, eligibility, or rule interactions. Some feeds include implied or non-firm prices with different semantics.

Within a continuous central book whose rules immediately match marketable interest, a persistent crossed reconstructed book is suspicious. It is not proof of one particular bug. Investigate:

- sequence gap or packet loss;
- snapshot/incremental handoff error;
- duplicate or out-of-order application;
- wrong instrument/session mapping;
- stale status or mixed auction/continuous state;
- price-scale, sign, or endian error;
- hidden/implied/order-type semantics;
- protocol-version mismatch;
- a legitimate venue rule or administrative event.

Fail closed at the smallest safe scope while recovering. “A cross is always a feed bug” is too strong; “keep trading because markets sometimes cross” is unsafe.

### Market data is a view, not the matching engine

The matching engine serializes events under venue rules. A market-data publisher transforms that internal state into one or more products. A recipient sees packets later:

```text
participant order
 -> venue gateway validation
 -> matching-engine event order
 -> executions/book changes
 -> publisher encoding and channels
 -> network delivery/recovery
 -> local reconstructed view
```

Order-entry acknowledgments and public market data can have different identifiers, timestamps, ordering domains, and publication policies. “My order is acknowledged” does not imply every public feed has published it. “I saw a trade” does not identify the aggressor unless the feed explicitly supplies or permits deriving that fact.

Common data products answer different questions:

| Product | Typical content | Cannot safely establish alone |
|---|---|---|
| instrument definitions | identifiers, scales, product/session parameters | current book or session state |
| status events | trading phase, halt, auction state | complete order book |
| top of book | best published prices and sizes | deeper liquidity or queue position |
| MBP depth | aggregate price levels | individual-order priority |
| MBO depth | order-level events under feed rules | hidden internal state not published |
| trades | reported executions and corrections | current resting depth |
| imbalance/indicative | auction estimate and paired/imbalance data | final uncross price |
| consolidated feed | eligible multi-venue data under its policy | fastest direct state at every venue |

Normalize only after preserving the native fields needed to explain behavior. A unified `price` field that discards whether it was indicative, executable, settlement, or trade data makes downstream errors unavoidable.

Chapter 51 covers protocols, Chapter 52 hot-path architecture, Chapter 53 market-data reconstruction, and Chapter 54 order gateways. This chapter owns the vocabulary that keeps those layers from being conflated.

## 49.11 Worked market-event reasoning — Core

At 09:29:59.900, an engineer’s book shows:

```text
session status: OPENING_CALL
best displayed bid: 100.05
best displayed ask: 100.01
indicative match: 100.03, paired quantity 80,000
```

At 09:30:00.020, the feed emits:

```text
auction execution burst at 100.03
session transition to CONTINUOUS
new BBO 100.02 x 100.04
```

At 09:30:00.025, an application records a long-position mark changing from yesterday’s close of 99.80 to 100.03.

Reason through it:

1. The pre-event negative arithmetic spread is not by itself a corrupted continuous book; session state says auction call.
2. The indicative 100.03 is neither guaranteed nor yet a trade. It is a venue-defined estimate.
3. The execution burst at one price is consistent with an uncross. Its capacity profile differs from continuous flow.
4. The new continuous BBO restores the continuous-book invariant for this venue model.
5. The mark change is 0.23 per unit relative to yesterday’s close, but it is not trading P&L unless position, multiplier, currency, costs, and mark policy are applied.
6. If the status transition packet were lost, a clock-based application might wrongly remain in call state. If the application instead forced continuous state at 09:30:00.000, it could reject valid late auction data. Status sequencing and recovery matter.

Now change one observation: the crossed book first appears at 10:17 during explicit continuous status and persists while the direct venue feed’s sequence number has a gap. That is a reconstruction incident until recovered, not an auction. Stop using the affected instrument view, obtain the venue-defined recovery/snapshot, and reconcile rather than trying to “uncross” locally by deleting a side.

This is the core engineering skill: combine arithmetic with instrument identity, state, data provenance, and venue rules.

## 49.12 Reference data and symbology — Reference

This section is skippable on a first pass, but production correctness depends on it.

Reference data includes:

| Domain | Typical fields |
|---|---|
| Identity | venue ID, market segment, native instrument ID, symbol, alternate IDs |
| Economics | currency, multiplier, face/contract value, settlement method |
| Price | encoding scale, tick/table, price limits, display convention |
| Quantity | encoding scale, increment, minimum, lot convention |
| Derivative | expiry, strike, option kind/style, underlying, legs and ratios |
| Trading | calendar, session group, permitted order types, allocation algorithm |
| Operations | feed channel, partition, protocol/template version |
| Fees | schedule/version inputs and liquidity-code mapping |
| Lifecycle | activation, expiration, suspension, corporate action, replacement |

Every record needs provenance and validity:

```text
source + source version + received/published time
+ effective-from + effective-to + trading-date interpretation
```

A reference-data change is an event, not an overwrite. New listings, expiries, symbol changes, corporate actions, tick-table changes, multiplier changes, session exceptions, and venue migrations can affect books, risk, orders, P&L, and historical joins differently.

Safe publication pattern:

1. load a candidate snapshot off the hot path;
2. validate uniqueness, scales, positive increments, referential integrity, ranges, and effective dates;
3. diff it against the active snapshot and alarm on unexpected breadth;
4. precompute hot-path forms such as native-ID indexing and integer tick parameters;
5. publish an immutable version at an explicit boundary;
6. retain the version used for each decision and fill;
7. fail closed for instruments missing mandatory fields.

Do not infer tick size from observed prices, multiplier from P&L, or session hours from yesterday’s traffic. Sparse markets and exceptional days make those guesses appear to work until the expensive case.

### Corporate actions and contract lifecycle

A split, merger, dividend, redenomination, option adjustment, expiry, or futures roll can change interpretation without changing every identifier. Treatment of positions, open orders, historical series, strikes, multipliers, and settlement is rule-specific. An exact ratio discontinuity can be evidence of an unhandled corporate action, but it can also expose a bad adjustment applied twice.

Preserve raw data and apply named adjustment versions for analytics. Trading state should consume the official effective definition, not an adjusted historical display series.

## 49.13 Common traps — Core

- Using a ticker as a globally unique, timeless instrument key.
- Treating a wall-clock schedule as authoritative session status.
- Assuming a crossed book is always invalid, including during auction calls.
- Accepting a persistent continuous-book cross without recovery.
- Calling last trade, midpoint, official close, mark, and fair value “the price.”
- Treating displayed depth as guaranteed executable quantity.
- Using floating point for priority-critical price or quantity equality.
- Confusing protocol price scale with tick size.
- Hard-coding lot, multiplier, tick, fees, or allocation from a product example.
- Inferring maker/taker from limit versus market order.
- Assuming MBO necessarily exposes every priority-relevant fact.
- Claiming MBP reveals exact queue position.
- Implementing pro-rata without eligibility, rounding, and residual rules.
- Applying continuous book invariants to auction data.
- Treating an indicative auction price as an execution.
- Assuming a halt means no messages or that all live orders were cancelled.
- Calling a locally consolidated best quote the jurisdiction’s official/protected quote.
- Computing P&L without multiplier, currency, fee signs, and mark provenance.
- Joining current reference data to historical events without versioning.

## 49.14 Recall card — Core

```text
IDENTITY
(venue/segment, native instrument ID, definition version/session)
Symbol is a label, not a primary key.

BOOK
bid = buy interest; ask/offer = sell interest
best bid = highest; best ask = lowest
quoted spread = ask - bid; mid = (ask + bid)/2
last trade and mid are not automatically executable prices

DATA
MBP = aggregate price levels
MBO = order-level view as defined by the feed
quote != trade; acknowledgment != public feed event

LIQUIDITY
tightness + depth + immediacy + resilience + stability
displayed depth is a stale, partial view—not a fill promise

UNITS
price scale != tick
quantity increment != round lot
tick value = tick x multiplier for a linear contract
use fixed-point and widened intermediates

ALLOCATION
price-time: better price, then venue priority
pro-rata: proportional share plus venue-specific stages/residual
modification priority and hidden treatment are venue rules

SESSIONS
status messages drive state; calendars predict/check
auction call may be crossed; indicative price is not a trade
halt/order treatment and reopening are venue-specific

ECONOMICS
cash P&L = signed fill cash flows - fees + rebates
state multiplier, currency, mark, horizon, and fee version

LABEL EVERY FACT
general | jurisdiction | venue | protocol | reference data | measured
```

## 49.15 Questions — Core

1. Distinguish instrument, listing, venue, market segment, session, order, quote, and trade.
2. Given a BBO and a multi-level execution, calculate quoted spread, midpoint, VWAP, slippage, and effective spread. Which inputs require timestamps?
3. Why can MBO support queue reconstruction while MBP usually supports only bounds? When might even MBO be insufficient?
4. Compare price-time and pro-rata. Which additional rules are required to make each deterministic?
5. Explain the difference among price scale, tick size, quantity increment, round lot, multiplier, and tick value.
6. Why is a crossed book normal in one state and a recovery trigger in another?
7. Walk through an opening auction from call interest to indicative values, uncross, execution burst, and continuous state.
8. How would you version and publish an intraday reference-data change without mutating hot-path state under readers?
9. A fee reconciliation is wrong by a constant amount per contract on one venue. Which stored fields and versions do you inspect?
10. For each statement—“the close is 16:00,” “size decreases preserve priority,” and “the best quote is protected”—name the required label and authority.

## 49.16 Puzzle and exercise — Core

### Puzzle: profitable or not?

An execution report says:

```text
BUY 3 contracts @ 125.10
later SELL 3 contracts @ 125.14
price tick = 0.01
contract multiplier = 25 currency units per price point
total fees = 4.00 currency units
```

A dashboard reports gross P&L of 12 and net P&L of 8. Is it correct?

No. The price move is 0.04, or four ticks. Gross P&L is:

\[
3\times0.04\times25=3
\]

and net P&L is \(3-4=-1\) currency unit. The dashboard likely treated ticks as currency units or used a wrong multiplier. If the two fills use different currencies or the product is nonlinear, even this corrected calculation is incomplete.

### Exercise: annotate a market day

Create a small event log containing:

1. instrument definition;
2. pre-open status;
3. three auction orders and two indicative updates;
4. an uncross;
5. continuous MBP updates and trades;
6. a volatility interruption;
7. a reference-data tick change effective at the reopening;
8. a reopening auction;
9. a fee-bearing fill.

For every event, record its venue sequence, local receive time, instrument-definition version, session before/after, and whether it is reference, status, quote, order, or trade data. Then compute the book, indicative auction quantities, one VWAP, queue-position bounds from MBP, and fill P&L.

Deliberately remove one status event and one market-data event. Define which invariants detect each omission, the smallest scope to fail closed, and the recovery data required. If the recovery logic relies on the wall clock or invents a missing allocation rule, revise it.

## Prerequisite for Chapter 50

You are ready for orders and matching when you can identify an instrument and session unambiguously; distinguish orders, quotes, and executions; compute spreads and book walks in correct units; explain price-time versus pro-rata without assuming a venue; and recognize that order acceptance, priority, modification, allocation, fees, and auction behavior come from effective venue rules and protocol state.
