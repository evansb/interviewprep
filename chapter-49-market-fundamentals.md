# Chapter 49 — Market Fundamentals

*Interview-focused revision notes. The theme: a market is a distributed system with unusual invariants — this chapter defines the vocabulary precisely and shows which parts of it are data-structure constraints, which are protocol state machines, and which are the source of your worst production bugs.*

---

## 49.1 Bid, Ask and Spread

An **order** is an instruction to buy or sell a specified quantity of an instrument. A **limit order** carries a price limit: a buy limit at 100 will not execute above 100; a sell limit at 101 will not execute below 101 (Ch. 50 §50.2). Resting limit orders are collected in the **limit order book** (§50.13).

Definitions, in the order they depend on each other:

- **Bid** — a resting buy order, or the price of one. The **best bid** (also *inside bid*, *top of book bid*, *BB*) is the **highest** price anyone is currently willing to buy at.
- **Ask** / **Offer** — a resting sell order, or its price. The **best ask** is the **lowest** price anyone is willing to sell at.
- **BBO** — Best Bid and Offer: the pair (best bid price, best bid size, best ask price, best ask size). In the US equities context, the **NBBO** (National Best Bid and Offer) is the best bid and ask across *all* exchanges.
- **Spread** — best ask minus best bid. Always ≥ 0 in a well-formed book (§49.14 covers when it isn't).
- **Mid** — (best bid + best ask) / 2. Note this is not necessarily a tradeable price and may fall between ticks (§49.7).
- **Touch** / **top of book** — the best bid and best ask levels.
- **Last** — the price of the most recent trade. Distinct from mid and from either side of the touch; conflating "last" with "current price" is a beginner's error.

```
        BOOK for XYZ                     spread = 100.03 - 100.01 = 0.02
  BIDS (buy)          ASKS (sell)        mid    = 100.02
  ─────────────────────────────────
  qty   price   │   price   qty
  1200  100.01  │  100.03   800          ← the TOUCH / BBO
   500  100.00  │  100.04   300
  2000   99.99  │  100.05  1500
   700   99.98  │  100.07   400
        ↑ descending          ↑ ascending
```

**Structural invariants** an implementation must maintain:

1. Bids are sorted **descending** by price; asks **ascending**. Both are "best first."
2. `best_bid < best_ask` during continuous trading (§49.11). Equality is a **locked** market, inversion is a **crossed** market (§49.14) — normally impossible within a single matching engine because incoming orders that would cross are matched instead of rested (§50.18).
3. Spread is bounded below by one **tick** (§49.7).

**Why the spread exists.** A resting limit order is a free option granted to the rest of the market: it can be executed at your price whenever someone else wants it, including when they know something you don't. The spread is compensation for that risk plus the cost of holding inventory and the venue's fees. This is descriptive microstructure, not a trading recommendation — the engineering consequence is what matters: spread width is the single most-watched signal for feed health (§53.8), because a suddenly enormous or inverted spread almost always means *your book is wrong*, not that the market moved.

**Sides and directions — the terminology that trips engineers up.** "Buy side of the book" means the bids. Someone who **hits the bid** is *selling* into a resting buy order. Someone who **lifts the offer** (or *takes the ask*) is *buying* from a resting sell order. **Aggressor**/**taker** is the incoming order that executes immediately; **passive**/**maker** is the resting order it executed against. Getting the aggressor side wrong flips the sign of every fee, every rebate, and every inferred trade direction in your analytics (§49.6).

**Representation.** Prices are never floating point (Ch. 2 §2.5, Ch. 23 §23.10). Store them as scaled integers — an `int64_t` in the instrument's minimum price increment, or in a fixed scale like 10⁻⁹. `100.01` becomes `10001` at scale 10⁻². Comparisons are then exact, which is a hard requirement: price-time priority (§49.4) depends on exact equality tests, and `0.1 + 0.2 != 0.3` in binary floating point makes an order book non-deterministic.

---

## 49.2 Market Depth and Liquidity

**Depth** (or *market depth*, *depth of book*) is the resting quantity available at each price level, beyond just the touch. **Market by price (MBP)** aggregates all orders at a price into one total; **market by order (MBO)** exposes each individual order.

| | Market by price (MBP / aggregated) | Market by order (MBO / full depth) |
|---|---|---|
| Unit of the feed | Price level with total quantity | Individual order with an order ID |
| Typical feed name | "Level 2", "depth of book", "price book" | "Level 3", "order book", "full order depth" |
| Message rate | Lower | Much higher (every order add/cancel) |
| Lets you compute queue position (§49.3) | No | Yes |
| Book data structure | Map price → aggregate qty | Map price → intrusive FIFO of orders (§50.15) |
| Example venue feeds | CME MBP-10, most equity depth feeds | Nasdaq ITCH, CME MBO |

**"Level 1 / 2 / 3"** is loose and venue-dependent vocabulary — Level 1 is the touch plus last trade, Level 2 is aggregated depth, Level 3 is per-order. Say what you mean (MBP vs MBO) in an interview; using the numbered terms imprecisely is a tell.

**Liquidity** is not one number. It has at least four measurable dimensions, and a strong candidate names them:

1. **Tightness** — the spread. Cost of an immediate round trip in zero size.
2. **Depth** — quantity available at or near the touch.
3. **Resilience** — how fast the book refills after being consumed.
4. **Immediacy** — how quickly a given size can be executed at all.

**Consuming depth — the walk.** An aggressive order larger than the top level executes against successive levels. Given asks `100.03 × 800`, `100.04 × 300`, `100.05 × 1500`, a buy of 1500 fills:

```
 800 @ 100.03
 300 @ 100.04
 400 @ 100.05
 ─────────────
 VWAP = (800×100.03 + 300×100.04 + 400×100.05) / 1500 = 100.0385
 slippage vs best ask = 100.0385 - 100.03 = 0.0085
```

**VWAP** = volume-weighted average price. **Slippage** here is the difference between the achieved average and the reference price you expected. Implementing this walk correctly — iterating levels in price order, decrementing, handling partial fills and exhaustion — is a very common coding-round exercise; the traps are integer overflow in the weighted sum (use `__int128` or scale carefully, Ch. 23 §23.12) and forgetting that a limit price may stop the walk mid-level.

**Book imbalance** is the standard derived statistic: `(bid_qty − ask_qty) / (bid_qty + ask_qty)` at the touch or over N levels. It is a signal input, and computing it cheaply is a hot-path concern: maintain running per-level totals incrementally rather than summing on demand (§50.14).

**The critical engineering caveat: displayed depth is not available depth.** Sources of divergence:

- **Hidden and iceberg orders.** An **iceberg** (or *reserve*) order displays only part of its quantity; when the displayed part fills, more is replenished — usually losing time priority on the replenished portion (§49.4). Fully **hidden** orders display nothing at all. Both mean you can execute more than the book shows.
- **Latency.** By the time you act, other participants have already acted on the same information. Your book is always a snapshot of the past (Ch. 53 §53.8).
- **Fragmentation.** In equities, liquidity is split across many venues plus off-exchange venues; one venue's depth is a fraction of the whole.
- **Fleeting orders.** A large fraction of resting quantity is cancelled within milliseconds and was never realistically available.

---

## 49.3 Queue Position

**Queue position** is where a specific resting order sits in the ordered list of orders at its price level. Under price-time priority (§49.4), the level is a FIFO: position 1 executes first.

```
Level 100.01 (bid), FIFO front → back:
  [A: 500] [B: 300] [YOU: 200] [C: 900]
   ↑ executes first
  Quantity ahead of you = 800.  A sell of 900 fills A(500), B(300), and 100 of YOU.
```

**Why it is the most important derived quantity in passive trading.** Whether your order fills before the price moves against you depends almost entirely on how much quantity is ahead of you. Two orders at the same price with the same size can have completely different outcomes.

**Computing it requires MBO data** (§49.2). With aggregated MBP data you know only the level total, and cannot tell where in it you are. This is a primary reason venues' per-order feeds are worth their bandwidth.

**Maintaining it incrementally** — the mechanics an engineer must get right:

| Event ahead of you at your price | Effect on quantity ahead |
|---|---|
| New order added at your price | None (it joins behind you) |
| Order ahead cancelled | Decreases by that order's remaining qty |
| Order ahead fully executed | Decreases |
| Order ahead partially executed | Decreases by the executed amount |
| Order ahead *modified* to increase quantity | Usually loses priority → goes behind you (§50.10) |
| Order ahead modified to decrease quantity | Usually keeps priority; decreases by the delta |
| New price level created inside the spread | Your level is no longer the touch; position unchanged but now further from the market |
| Your own order is cancel/replaced at a new price | You go to the **back** of the new level |

That last row is the operationally decisive one: **any price change forfeits queue position.** Improving your price by one tick puts you at the front of a new level, but any move — including moving away and back — loses your place at the original level.

**The ambiguity problem with aggregated feeds.** If you only see "level 100.01 dropped from 2000 to 1700," you cannot tell whether the 300 came from ahead of you or behind you. Conservative estimators assume the worst (all from behind, so your position didn't improve) and produce a *pessimistic* bound; optimistic ones assume the reverse. Real implementations track both and treat the gap as uncertainty. Note trade messages help: an execution consumes from the *front*, so quantity removed by trades definitively reduces the amount ahead of you, while cancels are ambiguous. Distinguishing trade-driven from cancel-driven decrements is the whole trick.

**Priority-preserving vs priority-losing modifications** vary by venue and must be read from the venue specification, never assumed. Typical rule: quantity *decrease* keeps priority; quantity *increase* or price change loses it. Some venues implement a decrease as cancel/replace internally and lose priority anyway. Encoding this per-venue in your order-state machine (§50.9) is required for correct queue-position modelling.

---

## 49.4 Price-Time Priority

**Price-time priority** (also FIFO allocation) is the allocation rule: among resting orders, execute in order of (1) best price, then (2) earliest time of arrival at that price.

```
Incoming SELL 600 @ market.  Bids:
  100.01: [A t=10, 500] [B t=25, 300]
  100.00: [C t=05, 900]              ← older than A and B, but WORSE PRICE
Result: A gets 500, B gets 100.  C gets nothing — price beats time, always.
```

**The two keys.** Priority is a lexicographic ordering on `(price, time)` where price uses side-dependent direction (descending for bids, ascending for asks) and time is ascending. The time key is normally a monotonically increasing sequence number assigned by the matching engine at the moment the order becomes *resting*, not the client's send time — otherwise priority would depend on clock synchronization across participants, which is unachievable (Ch. 48 §48.11).

**What resets time priority** (the discriminating detail):

| Action | Time priority |
|---|---|
| Order rests for the first time | Assigned |
| Partial execution | **Retained** — the remainder keeps its place |
| Quantity decrease (typical rule) | Retained |
| Quantity increase | **Lost** — goes to the back |
| Price change | **Lost** |
| Cancel then new order | Lost (obviously) |
| Iceberg display replenishment | **Lost** for the replenished tranche |

**Why partial fills retain priority** is worth understanding: otherwise a large resting order would be perpetually pushed to the back by small aggressors, and no one would post size.

**Implementation.** The natural structure is `price → FIFO queue of orders` (§50.14, §50.15). Insertion at a level is O(1) at the tail; matching pops from the head. Critically, **you never sort by time** — arrival order *is* time order, so a linked list or ring gives you priority for free. Any design that stores a timestamp and sorts is both slower and wrong (ties would be resolved arbitrarily).

**Consequences for system design.** Under strict FIFO, being one microsecond earlier can mean being ahead of thousands of shares. This is the direct economic driver behind everything in Chapters 47, 48, 52 and 55 — the entire latency arms race exists because the allocation rule is a race. Venues that use pro-rata (§49.5) or that deliberately randomize (speed bumps, frequent batch auctions) change that incentive; stating this connection between allocation rule and system architecture is exactly the kind of synthesis interviewers are probing for.

**Variants you should recognize:**

- **Price-display-time**: displayed orders get priority over hidden orders at the same price, then time. Common in equities.
- **Price-broker-time**: some venues give priority to orders from the same broker (internalization) before time.
- **Size-priority / price-size-time**: larger orders first at a price. Rare.
- **Top-of-book / market-maker priority**: the first order to establish a new best price gets a preferential allocation (see §49.5).

---

## 49.5 Pro-Rata Allocation

**Pro-rata** allocation distributes an incoming aggressive quantity across all resting orders at a price level *in proportion to their size*, ignoring time. It is standard on many futures markets, particularly short-term interest-rate contracts where books are extremely deep and thousands of lots rest at a single tick.

```
Level 100.01 (bid):  A=6000, B=3000, C=1000   (total 10000)
Incoming SELL 1000 @ 100.01

Pure pro-rata:  A = 1000 × 6000/10000 = 600
                B = 1000 × 3000/10000 = 300
                C = 1000 × 1000/10000 = 100
```

**Time priority is irrelevant** here — which changes the incentive completely. Under FIFO you race to be first; under pro-rata you post *size*, because your fill share is your share of the level.

**The mechanics that make it hard to implement.** Real venues use a multi-step algorithm, and the steps are the interview content:

1. **Top-order / priority allocation.** The order that first established the best price (or a designated market maker) receives an allocation first — a fixed percentage of the incoming quantity, capped at its size. This exists to reward price improvement, which pure pro-rata otherwise fails to incentivize.
2. **Pro-rata pass.** The remaining quantity is distributed in proportion, with a **minimum allocation threshold** (e.g. an order must be entitled to at least 1 lot, or 2 lots, to receive anything). Orders below the threshold get zero in this pass.
3. **Rounding.** Fractional entitlements are truncated (floor), not rounded, so the sum is less than the incoming quantity.
4. **Leftover / residual pass.** The undistributed remainder from truncation is allocated FIFO by time among eligible orders, or by largest-fractional-remainder. This is venue-specific and must be read from the spec.

```
Incoming SELL 1000, level = A(t1)=6000, B(t2)=3000, C(t3)=1000, D(t4)=150
Total 10150.  Suppose top-order allocation = 0, min allocation = 1 lot, floor rounding:
  A: floor(1000 × 6000/10150) = 591
  B: floor(1000 × 3000/10150) = 295
  C: floor(1000 × 1000/10150) =  98
  D: floor(1000 ×  150/10150) =  14
  sum = 998 → 2 lots residual → allocated FIFO: A gets 1, B gets 1
```

**Determinism is mandatory.** Two implementations of the same venue's algorithm must produce identical allocations from identical inputs, or your fill simulation and your reconciliation both break. The failure modes are all in the arithmetic: integer division order (`q * size / total`, never `q * (size/total)`), overflow in `q * size` (use 128-bit, Ch. 23 §23.12), and the residual rule. A candidate who says "just multiply by the fraction" without addressing rounding and residual has not implemented one.

**FIFO vs pro-rata, compared:**

| | Price-time (FIFO) | Pro-rata |
|---|---|---|
| Determines fill | Arrival order | Order size |
| Rewards | Speed | Displayed size |
| Latency sensitivity | Extreme | Lower for allocation; still matters for reacting |
| Typical books | Thin, many price levels | Very deep, few active levels |
| Typical venues | Equities, most futures | Short-term rates futures, some options |
| Implementation | FIFO list per level | Sum + proportional pass + residual rule |
| Queue position (§49.3) | Meaningful and critical | Meaningless; *size share* is the analogue |

**Hybrid ("split") allocation** is very common in practice: a configured percentage of each incoming order is allocated FIFO and the rest pro-rata, per instrument. Your engine must read this from reference data (§49.10), not hard-code it.

---

## 49.6 Maker-Taker Fees and Rebates

**Maker** = the resting order that provided liquidity. **Taker** = the incoming order that removed it (§49.1). A **maker-taker** fee schedule charges the taker a fee and pays the maker a **rebate**; **taker-maker** (or "inverted") does the reverse; **flat fee** schedules charge both sides the same.

```
Trade of 100 shares @ $100 on a maker-taker venue:
  taker fee   = $0.0030/share × 100 = $0.30   (paid by aggressor)
  maker rebate= $0.0020/share × 100 = $0.20   (received by resting order)
  venue keeps $0.10
```

**Why an engineer must care.** Fees are typically an order of magnitude smaller than a tick, but they are comparable to or larger than the *edge* on many trades, so any profit-and-loss calculation, backtest, or fill simulator that ignores them is wrong by more than the thing it is measuring. Correct fee attribution requires knowing, per fill: the venue, the liquidity flag (maker/taker/auction/routed), the instrument's fee tier, and your firm's volume tier.

**The liquidity flag is data you must capture.** Execution reports carry it (FIX tag 851 `LastLiquidityInd`, or venue-specific codes, Ch. 51 §51.2). Do not infer it — inference fails for auctions, for orders that partially rest then get taken, and for the important case of an aggressive order that *adds* liquidity because it improved the price without crossing. Store the exchange's flag verbatim in your fill record and derive everything from it (Ch. 54 §54.15).

**Fee structure complications:**

- **Tiered pricing.** Rates depend on monthly volume, computed across the firm. So the marginal fee on a fill is not knowable at fill time — attribution must be reconciled at month end against the venue's invoice (Ch. 54 §54.15).
- **Per-share vs per-trade vs basis points vs per-contract.** Equities are typically per-share, futures per-contract, options per-contract with different rates by class, and some venues charge basis points of notional. Your fee engine needs all four formulas.
- **Caps and floors.** Some schedules cap the fee per trade for low-priced securities.
- **Regulatory fees** (e.g. transaction fees on sales, clearing fees, exchange membership) are separate line items with their own rules.
- **Rebates can be negative-sum for you** in an inverted venue where taking is cheap and posting costs.

**Engineering implications, not strategy:**

1. **Fee schedules are reference data** (§49.10) with effective dates, and they change on published notice. Hard-coding them causes silent mis-attribution that surfaces at month-end reconciliation as a mismatch against the invoice — the diagnostic signature is a P&L discrepancy that is exactly proportional to volume on one venue.
2. **Post-only orders exist because of fees** (§50.5): if an order would take liquidity and pay the taker fee, the participant may prefer it be rejected or repriced. That is a protocol feature you must implement correctly.
3. **Fee-aware simulation** requires modelling *both* the fill and its liquidity flag, which means your simulator must model queue position (§49.3), because whether you were the maker depends on whether you were resting.

---

## 49.7 Tick Sizes

The **tick size** (minimum price increment, MPI) is the smallest permitted difference between two valid prices for an instrument. A price not on the tick grid is invalid and will be rejected.

```
Tick = 0.01:   100.00, 100.01, 100.02 valid;  100.005 rejected
Tick = 0.25:   4300.00, 4300.25, 4300.50 valid (e.g. an index future)
Tick = 1/32:   bond futures quoted 110'16 = 110 + 16/32 = 110.50
```

**Consequences that show up in code:**

- **The spread is bounded below by one tick.** A one-tick spread is a "tight" or "locked-tight" market; you cannot quote inside it.
- **Mid-price may not be a valid price.** With a one-tick spread, mid falls on a half-tick. Any code that computes a mid and then submits it as an order price must round to the tick grid, and must round in a side-aware direction (round a buy price *down*, a sell price *up*, so you never accidentally cross).
- **Tick is a per-instrument, per-time reference datum**, not a constant.

**Variable tick regimes** — the detail that catches people:

| Regime | Description | Example |
|---|---|---|
| Fixed | One tick for all prices | Most US equities ≥ $1.00: $0.01 |
| Price-banded | Tick depends on price level | US equities < $1.00: $0.0001 |
| Tick tables | Tick depends on price *and* liquidity band | MiFID II RTS 11 tick-size regime for EU equities |
| Fractional | Tick expressed as a fraction | Treasury futures: 1/32, 1/64, 1/128 |
| Reduced tick at touch | Tighter increment only for the front month or at the BBO | Some futures spreads |

The MiFID II regime is the one worth naming: tick size is a function of (price band × average daily number of transactions band), read from a published table. Your reference data must carry the table, and a price validation function must consult it. Hard-coding "tick = 0.01" is a guaranteed production reject storm on European instruments.

**Implementation.** Represent prices as integers *in ticks* where possible, or in a fine fixed scale with a tick-multiple validation:

```cpp
// price stored as int64 in units of 1e-9 (or venue scale); tick likewise
constexpr bool on_tick_grid(int64_t px, int64_t tick, int64_t base = 0) {
    return tick > 0 && (px - base) % tick == 0;   // note: base matters for grids not anchored at 0
}
// side-aware rounding toward passive (never crossing)
int64_t round_passive(int64_t px, int64_t tick, bool is_buy) {
    int64_t r = px % tick;                 // careful with negatives (Ch. 2 §2.3)
    if (r == 0) return px;
    return is_buy ? px - r : px + (tick - r);
}
```
Watch the sign behavior of `%` for negative prices — negative prices are real (some energy and spread instruments trade below zero), and C++'s truncation-toward-zero `%` gives a negative remainder, which breaks naive grid checks. Use a floor-division helper.

**Tick size and spread interact economically:** a tick that is large relative to the instrument's natural spread forces the spread wide and makes queue position (§49.3) extremely valuable, because everyone is at the same price and only time separates them. A tick that is very small lets participants gain priority by improving price by a trivially small amount, so queues are shallow and priority is cheap to buy. This is the standard explanation for why tick size determines whether a market is queue-driven or price-driven — and it is a microstructure fact, not advice.

---

## 49.8 Lot Sizes and Contract Multipliers

**Lot size** terminology, defined precisely because the words are used loosely:

- **Round lot** — the standard trading unit. US equities: 100 shares, historically; many venues now permit odd lots and some high-priced names use smaller round lots.
- **Odd lot** — a quantity less than one round lot. Historically odd-lot quotes were not part of the NBBO and odd-lot trades were not reported to the consolidated tape — a real source of "invisible" volume; rules have changed and continue to.
- **Mixed lot** — a quantity greater than a round lot but not a multiple of it.
- **Lot size / minimum quantity increment** — orders must be a multiple of this. For futures this is 1 contract; for some FX and crypto venues it is a fractional quantity with its own scale.
- **Minimum order quantity** — smallest acceptable order, may exceed the increment.
- **Block size** — threshold above which special rules (reporting delays, separate venues) apply.

**Contract multiplier** (also *contract size*, *point value*) converts a quoted price into a monetary notional. This is where sign and scale errors become expensive:

```
notional = price × multiplier × quantity

E-mini S&P 500 future:  multiplier = $50 per index point
   price 4300.25, qty 3  →  4300.25 × 50 × 3 = $645,037.50
Equity option (US):     multiplier = 100 shares per contract
   premium 2.35, qty 10 →  2.35 × 100 × 10 = $2,350
Treasury future:        $100,000 face, quoted in 32nds
   110'16 → 110.50 → 110.50/100 × 100,000 = $110,500 per contract
```

**Tick value** is the monetary value of one tick: `tick_size × multiplier`. For the E-mini, `0.25 × 50 = $12.50` per contract per tick. Risk limits (Ch. 56 §56.14–§56.16) are expressed in notional or tick value, so a wrong multiplier silently scales every limit by the same factor — the diagnostic signature is risk checks that never fire, or that fire on everything, uniformly across one product family.

**Fixed-point arithmetic is mandatory** (Ch. 23 §23.10). The multiplication chain `price × multiplier × quantity` must be done in integers with an explicit scale, and the intermediate can overflow 64 bits: a price scaled to 10⁻⁹ times a multiplier of 100,000 times a quantity of 10,000 is ~10²¹, past `int64_t`'s ~9.2×10¹⁸. Use `__int128` for the intermediate and reduce scale before narrowing.

**Quantity representation.** Prefer an integer count of the instrument's minimum increment, with the increment itself in reference data. Some venues (FX, crypto) require fractional quantities; represent those as scaled integers too, never as `double`. A `double` quantity introduces the possibility of a residual of 10⁻¹⁵ units remaining on an order that should be fully filled, which then sits in your book forever and never matches — a genuinely nasty failure mode whose signature is orders stuck in a partially-filled state with an absurdly small leaves quantity.

**Related quantities in the order state machine** (§50.9): `order_qty` (original), `cum_qty` (filled so far), `leaves_qty` (remaining live). The invariant `order_qty = cum_qty + leaves_qty + cancelled_qty` must hold at all times and is the single best assertion to put in your order manager.

---

## 49.9 Instrument Symbology

**Symbology** is the set of identifier schemes used to name instruments, and the mappings between them. It is the most under-appreciated source of production incidents in trading systems.

**Identifier families:**

| Scheme | Scope | Example | Notes |
|---|---|---|---|
| Exchange ticker / symbol | One venue | `AAPL`, `ESZ5` | **Not globally unique**; reused across venues and over time |
| ISIN | Global, 12 chars | `US0378331005` | Identifies the security, not the venue or currency |
| CUSIP | North America, 9 chars | `037833100` | Licensed data |
| SEDOL | UK-assigned, 7 chars | `2046251` | Per venue/country listing |
| RIC (Refinitiv) | Vendor | `AAPL.O` | Vendor-licensed |
| Bloomberg / FIGI | Vendor / open | `BBG000B9XRY4` | FIGI is openly licensed |
| MIC (ISO 10383) | The *venue* | `XNAS`, `XNYS` | Operating MIC vs segment MIC |
| Exchange numeric ID | One venue's protocol | `security_id = 12345` | What the binary feed actually carries |

**The key engineering point: binary feeds identify instruments by a compact numeric ID, not a string.** ITCH uses a stock locate code; CME MDP uses `SecurityID`; SBE-based protocols carry an integer (Ch. 51 §51.6). Your hot path must key off that integer with an O(1) array lookup — a direct-indexed array of instrument state, sized to the venue's ID space, is the standard design (Ch. 52 §52.3). String symbol lookup on the hot path is an immediate red flag.

```cpp
// Hot path: dense integer id → contiguous array. No hashing, no strings.
struct InstrumentState { /* book, params, risk limits ... */ };
std::vector<InstrumentState> by_id;          // indexed by venue security_id
// Cold path only: symbol strings → id, built at startup from reference data
std::unordered_map<std::string, uint32_t> by_symbol;
```
If the venue's ID space is sparse or huge, use a perfect hash or a two-level table built at startup — still no runtime string work.

**Derivatives symbology** adds structure. A futures contract is (root, expiry): `ES` + `Z5` = E-mini S&P December 2025, using month codes `F G H J K M N Q U V X Z` for January–December. An option is (root, expiry, strike, call/put), sometimes encoded in an OCC-style 21-character symbol. Spreads and combinations have their own composite identifiers and often their own outright books.

**Failure modes with diagnostic signatures:**

- **Ticker reuse after a delisting.** A ticker freed by one company can be reassigned to another. Your historical data now silently splices two unrelated instruments; the signature is an impossible price gap on a specific date.
- **Same ticker, different venue, different instrument.** Cross-listed and dual-listed names; keying by ticker alone merges two books. Signature: crossed or nonsensical spreads (§49.14) on a specific symbol.
- **ISIN is not a venue.** One ISIN trades on many venues in many currencies. An ISIN-keyed book is a category error.
- **ID reassignment across sessions.** Some venues reassign numeric security IDs daily. Caching yesterday's ID map and using it today points every message at the wrong instrument — the signature is a whole feed that parses cleanly and produces uniformly wrong books, which is far more dangerous than a parse error.

The rule that prevents most of this: **the internal key is (venue, venue-native instrument id, trading session)**, everything else is a mapping maintained in cold-path reference data, and the map is rebuilt from the venue's own definition messages at session start (§49.10).

---

## 49.10 Reference-Data Changes

**Reference data** (static data, instrument definitions) is the per-instrument configuration a trading system needs but does not receive in the real-time price stream: tick size, lot size, multiplier, currency, expiry, price bands, trading hours, allocation algorithm, fee schedule, and the symbology mappings of §49.9.

**Sources.** Venues publish it as (a) downloadable files before the session, (b) definition messages on the market-data feed itself (CME sends `SecurityDefinition` messages on a dedicated channel, replayed periodically), or (c) an API. Production systems normally load a file at startup and then apply intraday definition messages.

**Change classes and their handling:**

| Change | When | Handling |
|---|---|---|
| New instrument listed | Session start, or intraday | Must be added without restart if the venue allows intraday listing |
| Instrument delisted / expired | Session boundary | Retire, but keep history keyed by the old ID |
| Tick-size table change | Effective date, often quarterly (MiFID II) | Reject orders under the *new* rule from the effective session |
| Corporate action: split, dividend, merger | Overnight, effective at open | Historical prices and quantities must be adjusted; open orders are typically cancelled or adjusted by rule |
| Symbol change | Overnight | ID mapping updated; the numeric ID may or may not persist |
| Price-band / limit update | Intraday, dynamically (§49.13) | Must be consumed from the real-time feed |
| Fee schedule change | Effective date | Reload; affects attribution only |
| Contract roll (futures) | Scheduled | Front month changes; anything keyed on "the front month" must follow |

**Corporate actions are the classic trap.** A 4-for-1 split multiplies share count by 4 and divides price by 4 overnight. Consequences: your historical time series is discontinuous unless adjusted; your position and risk limits are wrong by 4× until updated; open GTC orders (§50.8) are handled by venue-specific rules (typically cancelled, sometimes adjusted); and your backtest silently shows a −75% return on the split date if unadjusted. The diagnostic signature is unmistakable — a clean 4× or 0.25× discontinuity on one date in one symbol.

**Engineering rules:**

1. **Validate reference data before the session, and fail closed.** A missing tick size must prevent trading that instrument, not default to a guess (Ch. 60 §60.9). Every default is a silent wrong answer.
2. **Reference data is versioned and immutable at runtime.** Publish a new immutable snapshot and swap the pointer atomically (Ch. 60 §60.10); never mutate a live table under a reader. The hot path reads it with no lock (Ch. 26 §26.14 for RCU-style publication).
3. **Diff and alarm.** Compare today's load to yesterday's and report every change. Most incidents are caught here, by a human looking at "3,412 tick sizes changed" and asking why.
4. **Never derive reference data from market data.** Inferring tick size from observed price differences works until it doesn't — a wide-spread illiquid instrument gives you a wrong tick and a reject storm.
5. **Keep the mapping bidirectional and historical.** Post-trade reconciliation (Ch. 54 §54.15) needs to resolve yesterday's IDs.

---

## 49.11 Continuous Trading

**Continuous trading** (continuous double auction) is the normal state of an order-driven market: orders arrive at arbitrary times and are matched immediately against the resting book when they cross (§50.18). "Continuous" contrasts with **call auctions** (§49.12), where orders accumulate and match at a single point in time at a single price.

**The session state machine** — every venue has one, and your gateway must model it:

```
   PRE_OPEN ──► OPENING_AUCTION ──► CONTINUOUS ──► CLOSING_AUCTION ──► POST_CLOSE
   (orders     (uncross at a       (immediate     (uncross)           (order
    accepted,   single price)       matching)                          cleanup)
    no match)          │                 │
                       │                 ├──► HALT ──► (re-opening auction) ──► CONTINUOUS
                       │                 └──► VOLATILITY_AUCTION ──┘
```

**What changes between states:**

| Property | Continuous | Auction / pre-open |
|---|---|---|
| Matching | Immediate on cross | Only at the uncross instant |
| Book may be crossed | No | **Yes** — bids above asks is normal and expected |
| Indicative price published | No | Yes (indicative uncross price and imbalance) |
| Which order types accepted | All | Restricted (market-on-open, limit; IOC/FOK usually rejected) |
| Trade messages | Continuous | One burst at the uncross |

**The crossed-book point is the one that breaks naive implementations.** During a pre-open or auction call phase, the book legitimately contains bids above asks — that is precisely what the auction will resolve. A book builder that asserts `best_bid < best_ask` will fire that assertion every single morning. The correct behaviour is to make the invariant conditional on session state (§49.14).

**Session-state sources.** Venues signal state via dedicated market-data messages (trading status / security status messages), and sometimes only implicitly by scheduled time. **Never drive session state purely from a wall clock.** Openings are delayed, halts are unscheduled, and a system that resumes quoting at 09:30:00.000 by the clock while the instrument is still halted will send orders into a rejecting or, worse, accepting venue. The correct design is event-driven from the venue's status messages, with the clock used only as a sanity check that raises an alarm on divergence.

**Auxiliary continuous-session mechanics worth naming:**

- **Trading pauses at open**: instruments open in staggered batches, not simultaneously; your "market is open" flag must be per-instrument.
- **Reopening after halt** goes through an auction, not straight into continuous (§49.13).
- **Intraday auctions** exist on some venues (e.g. a scheduled midday auction), which briefly suspend continuous trading.
- **Late/extended sessions** may have different tick rules, different order types, and much thinner books.

**Diagnostic signature of a session-state bug:** a burst of rejects with venue reason codes like "invalid state for order type" concentrated at exactly the same time each day, or orders that rest but never trade because they were submitted into a call phase.

---

## 49.12 Opening and Closing Auctions

A **call auction** (or *uncross*, *fixing*, *match*) collects orders over a call period and executes them all at a single **auction price** at one instant. Opening and closing auctions are the largest single liquidity events of the day on most equity venues — the closing auction in particular concentrates enormous volume because index funds must trade at the official close.

**The uncross algorithm.** Given all eligible orders, choose the price that maximizes executable volume; break ties by successive criteria. The standard cascade (Xetra, Euronext, Nasdaq and most others differ only in details):

1. **Maximum executable volume.** For each candidate price p, `executable(p) = min(cumulative buy qty at ≥ p, cumulative sell qty at ≤ p)`. Choose p maximizing this.
2. **Minimum surplus (imbalance).** If several prices tie, choose the one with the smallest `|buy − sell|` remaining unfilled.
3. **Surplus side.** If still tied, and the surplus is all on the buy side choose the highest such price; if all on the sell side choose the lowest.
4. **Reference price.** If still tied, choose the price closest to a reference (previous close, or last traded price).

```
Buy orders                Sell orders
qty  limit                limit  qty
200  ≥101                  ≤ 99  150
300  ≥100                  ≤100  250
400  ≥ 99                  ≤101  300

Cumulative buy at price p (buyers willing to pay ≥ p):
  p=101: 200      p=100: 500      p=99: 900
Cumulative sell at price p (sellers willing to accept ≤ p):
  p=99: 150       p=100: 400      p=101: 700

executable(99)  = min(900,150) = 150
executable(100) = min(500,400) = 400   ← maximum
executable(101) = min(200,700) = 200
→ auction price = 100, volume = 400.  Surplus = 100 on the buy side (unfilled).
```

**Allocation at the auction price** then follows the venue's priority rules (§49.4/§49.5), and — importantly — **all trades print at the single auction price**, including orders that were willing to pay far more. An order with limit 101 that fills at 100 received price improvement of 1.

**Order types specific to auctions:** market-on-open (MOO) / market-on-close (MOC) execute at the auction price regardless of level; limit-on-open/close (LOO/LOC) participate only within their limit; imbalance-only orders participate only to offset an imbalance. Venues impose cutoff times after which MOC orders cannot be entered or cancelled — a hard deadline your gateway must respect and alarm on.

**Indicative data during the call.** Venues disseminate an *indicative auction price*, *indicative volume*, and *imbalance* (side and quantity) at intervals during the call period. Consuming these requires a separate message handler and a separate state model — they are not book updates and must not be fed into your continuous book.

**Engineering implications:**

- **A crossed book is normal during the call** (§49.11, §49.14).
- **The uncross produces a burst** — thousands of executions in microseconds, plus a book that transitions instantly to a completely different state. Your gateway, risk system, and position tracker must absorb the burst without queueing collapse (Ch. 52 §52.16). Auction bursts are the standard capacity-planning worst case (Ch. 56 §56.10).
- **The official closing price** used for settlement, index calculation, and marking positions is the auction price, not the last continuous trade. Systems that mark to "last trade" produce a different P&L than everyone else, and the discrepancy appears only on days with a large auction.
- **Implementing the uncross is a common interview exercise.** Do it with cumulative sums over the sorted price levels in one pass in each direction, O(L) in the number of levels, not by trying every price against every order.

---

## 49.13 Trading Halts and Price Bands

A **halt** suspends trading in an instrument. A **price band** (limit, collar) restricts the prices at which trading may occur. Both are venue-enforced circuit breakers, and both change your system's legal actions.

**Halt types:**

| Type | Trigger | Typical resolution |
|---|---|---|
| **Regulatory / news pending** | Pending material announcement | Resumes after dissemination, via auction |
| **Volatility halt (LULD, single-stock circuit breaker)** | Price moves beyond a band for a sustained interval | Short pause (e.g. 5 min) then a reopening auction |
| **Market-wide circuit breaker (MWCB)** | Index falls by 7% / 13% / 20% | 15-minute halt; 20% halts for the day |
| **Operational halt** | Venue technical issue | Indeterminate |
| **Limit up / limit down (futures)** | Price reaches a daily limit | Trading may continue *within* the limit, or halt |

**LULD (limit up-limit down)** is the US equity mechanism worth knowing concretely: a reference price (rolling 5-minute average of trades) defines a band (a percentage varying by price and tier). Quotes outside the band are not executable; if the market's best bid or offer sits at the band edge for 15 continuous seconds, a **limit state** becomes a 5-minute **trading pause**, which is exited via a reopening auction.

**Price bands versus rejection.** Two distinct venue behaviours you must distinguish:

- **Price banding on entry** — an order priced outside the band is *rejected* at the gateway. Signature: rejects clustering at extreme prices during volatile periods.
- **Execution banding** — the order is accepted but cannot execute outside the band; it may rest silently. Signature: an order that never fills despite an apparently crossing price.

**Futures banding** works differently again: CME applies dynamic price banding around a reference price to reject fat-finger orders (Ch. 56 §56.13), separate from daily price limits which halt or bound trading.

**Engineering rules:**

1. **A halt is not "no data."** You continue to receive status messages, and the book may be purged or frozen depending on venue. Know which — a frozen book that you treat as live produces stale-price trading on resumption (Ch. 53 §53.8).
2. **Open orders during a halt** may be retained, cancelled by the venue, or cancelled at the reopen — per venue rules. Assume nothing; the reconciliation after a halt is a mandatory step, and "cancel on disconnect" semantics (Ch. 54 §54.13) do not cover halts.
3. **Reopening is an auction**, so your first post-halt fills come as an auction burst at a single price (§49.12), not as continuous trades.
4. **Your own price collars are still required.** Venue bands are a backstop, not your risk control. Pre-trade price collars (Ch. 56 §56.13) must reject an order whose price is implausible relative to your own book before it ever reaches the wire, because a venue that *accepts* a bad price is the expensive case.
5. **Halt state must be per-instrument and event-driven**, and must gate quoting. The classic incident: a halted instrument's stale book looks enormously attractive, and a strategy that does not check halt state fires orders into the reopening auction at yesterday's prices.

---

## 49.14 Locked and Crossed Markets

Two precisely defined abnormal states:

- **Locked market** — best bid **equals** best ask. Spread = 0.
- **Crossed market** — best bid is **greater than** best ask. Spread < 0.

```
Normal:   bid 100.01  |  ask 100.03      spread = +0.02
Locked:   bid 100.02  |  ask 100.02      spread =  0.00
Crossed:  bid 100.04  |  ask 100.02      spread = -0.02
```

**Within a single matching engine, neither can occur during continuous trading**, because an incoming order that would lock or cross is matched against the resting side instead of resting (§50.18). Therefore, if your book for one venue shows a lock or a cross during continuous trading, **the most likely explanation is a bug in your book**, not a market event. This inversion of instinct is the single most useful diagnostic heuristic in feed-handler work.

**Legitimate causes of a lock or cross:**

| Cause | Context |
|---|---|
| Auction / pre-open call phase | Normal and expected (§49.11–§49.12) |
| **Cross-venue** NBBO | Venue A's bid can exceed venue B's ask; this is a real, common, and regulated condition |
| Halted instrument | A frozen book can be crossed against another venue |
| Odd-lot or hidden liquidity | Prices not subject to the same protections |
| Different instrument versions | Two instruments merged by a symbology error (§49.9) — *this is a bug wearing a costume* |

**Bug causes, ranked by frequency — the real value of this section:**

1. **Missed or misapplied delete/cancel message.** A resting order that was cancelled but not removed leaves a phantom level, most visibly at the touch. Signature: the cross persists until the level is touched again.
2. **Sequence gap silently ignored** (Ch. 53 §53.4). You dropped messages and your book diverged. Signature: cross appears abruptly and never self-heals; the gap is visible in sequence-number accounting if you look.
3. **A/B feed arbitration bug** (Ch. 53 §53.6) — applying the same update twice, or applying B's update out of order relative to A's.
4. **Snapshot/delta race** (Ch. 53 §53.3) — applying deltas that predate the snapshot, or failing to discard deltas already reflected in it.
5. **Signed/unsigned or endianness error in price parsing** (Ch. 3 §3.9, Ch. 51 §51.10) — a negative price parsed as huge unsigned, or a byte-swapped price. Signature: absurd values, not merely inverted ones.
6. **Implied/synthetic prices mixed into the outright book** — futures venues publish implied prices derived from spreads; mixing them into the outright book without marking them creates apparent crosses.

**Required system behaviour:**

```cpp
// After every book update, in continuous session state:
if (session == Session::Continuous && book.has_both_sides()
    && book.best_bid_px() >= book.best_ask_px()) {
    metrics.crossed_book_events++;
    mark_instrument_unusable(id);          // fail closed: stop quoting THIS instrument
    request_recovery(id);                  // snapshot re-sync (Ch. 53 §53.3)
}
```

**Fail closed, per instrument.** A crossed book means your state is untrustworthy; continuing to quote against it is how firms lose money quickly. Stopping the world entirely is usually the wrong response — halt the affected instrument, recover it, and let the rest of the system continue (Ch. 56 §56.12).

**Regulatory dimension (US equities).** Reg NMS Rule 610 prohibits displaying quotations that lock or cross another venue's protected quotation, which is why routing systems must check the NBBO before posting; and Rule 611 (the order protection / trade-through rule) prohibits executing at a price inferior to a protected quotation on another venue. You do not need the rule numbers memorized, but you should know that *cross-venue locks are actively prevented by rule*, which is why an unexpected cross in a consolidated view is again more likely to be your data than the market.

---

## Key Interview Questions

1. **Define bid, ask, spread, and mid — and say which of them is always a tradeable price.** — Best bid is the highest resting buy, best ask the lowest resting sell, spread their difference, mid their average; mid is frequently *not* on the tick grid and therefore not tradeable.
2. **What does "hitting the bid" mean, and who is the aggressor?** — Selling into a resting buy order; the incoming seller is the aggressor/taker, the resting buyer is the maker.
3. **Why must prices be integers, not doubles?** — Priority and matching require exact equality and exact tick-grid arithmetic; binary floating point makes the book non-deterministic and produces unmatchable residual quantities.
4. **MBP vs MBO — what can you compute with one but not the other?** — Queue position; aggregated feeds give a level total with no information about your place in it.
5. **What are the dimensions of liquidity?** — Tightness (spread), depth (size), resilience (refill speed), immediacy; plus the caveat that displayed depth overstates available depth because of hidden/iceberg orders, fragmentation and fleeting quotes.
6. **How do you maintain queue position from an MBO feed?** — Track quantity ahead; executions consume from the front (unambiguously reduce it), cancels are ambiguous with aggregated data, quantity increases and price changes send an order to the back.
7. **Under price-time priority, what preserves and what destroys time priority?** — Partial fills and (usually) quantity decreases preserve it; quantity increases, price changes, and iceberg replenishment destroy it.
8. **Why is arrival order sufficient — why not sort by timestamp?** — Insertion order at a level *is* time order, so a FIFO gives priority for free; storing and sorting timestamps is slower and resolves ties arbitrarily.
9. **How does pro-rata allocation change system incentives versus FIFO?** — Fill share depends on displayed size rather than arrival time, so latency matters less for allocation (though still for reacting), and queue position is replaced by size share.
10. **What are the hard parts of implementing pro-rata correctly?** — Top-order allocation, minimum-allocation thresholds, floor rounding, the residual pass, integer division order, and 128-bit intermediates — determinism is mandatory or fill simulation and reconciliation both break.
11. **Maker vs taker, and why can't you infer the liquidity flag?** — Maker rests, taker aggresses; auctions, routed orders and partially-resting orders break inference, so you must persist the venue's own flag from the execution report.
12. **How does tick size shape a market's microstructure?** — A large tick relative to natural spread forces wide spreads and makes queue position valuable; a small tick makes priority cheap to buy by price improvement and produces shallow queues.
13. **What is a contract multiplier and where does it bite?** — Price-to-notional conversion; a wrong multiplier uniformly scales every risk limit for a product family, and the price×multiplier×quantity chain overflows 64 bits without a 128-bit intermediate.
14. **Why is a numeric security ID better than a symbol on the hot path?** — Binary feeds carry it natively and it indexes a dense array in O(1); string lookup on the hot path is a design error. Internal key should be (venue, native id, session).
15. **Name three symbology failure modes and their signatures.** — Ticker reuse after delisting (impossible price gap on one date), same ticker on different venues (crossed/nonsense spreads), daily ID reassignment (a whole feed parsing cleanly into uniformly wrong books).
16. **How should reference data be updated at runtime?** — Immutable versioned snapshot with an atomic pointer swap, validated and failed-closed before the session, diffed and alarmed against yesterday, never inferred from market data.
17. **Describe the auction uncross algorithm.** — Maximize executable volume = min(cumulative buy ≥ p, cumulative sell ≤ p); tie-break on minimum surplus, then surplus side, then nearest reference price; all trades print at that single price.
18. **Why will a naive book builder assert every morning?** — Because a crossed book (bids above asks) is legitimate during the pre-open call phase; the no-cross invariant is conditional on continuous session state.
19. **Your single-venue book shows bid > ask during continuous trading. What is it?** — Almost certainly your bug: a missed delete, an ignored sequence gap, an A/B arbitration error, a snapshot/delta race, or a price parsing error. Fail closed on that instrument and re-sync.
20. **What does LULD do and how does trading resume?** — A band around a rolling reference price; 15 seconds at the band edge triggers a pause, and the instrument reopens via an auction, not straight into continuous trading.

---

## Common Traps

- **Floating-point prices or quantities** — non-deterministic priority, and residual leaves-quantity of 10⁻¹⁵ that never fills.
- **Assuming `best_bid < best_ask` unconditionally** — false during pre-open, auctions, and across venues.
- **Treating a crossed single-venue book as a market event** — it is a bug until proven otherwise.
- **Inferring the liquidity flag** instead of persisting the venue's — breaks on auctions and partially-resting orders.
- **Inferring tick size from observed prices** — wrong on illiquid instruments, causes reject storms.
- **Hard-coding tick size, lot size, multipliers or fees** — MiFID II tick tables and tiered fees are data, with effective dates.
- **Ignoring negative prices** — C++ `%` truncates toward zero, breaking naive tick-grid checks below zero.
- **Overflow in `price × multiplier × quantity`** — needs `__int128` intermediates.
- **Keying instruments by ticker or ISIN** — not unique across venues, currencies, or time.
- **Caching a venue security-ID map across sessions** when the venue reassigns IDs daily — the feed parses perfectly and is entirely wrong.
- **Driving session state from a wall clock** rather than venue status messages — openings are delayed and halts are unscheduled.
- **Assuming the closing price is the last continuous trade** — it is the closing auction price.
- **Failing to size for the auction burst** — the uncross is the day's capacity worst case.
- **Assuming displayed depth is available depth** — hidden and iceberg quantity, fragmentation, fleeting quotes.
- **Assuming a price change keeps queue position** — it never does.
- **Assuming a quantity decrease keeps priority on every venue** — usually yes, but some implement it as cancel/replace.
- **Naive pro-rata (`qty * (size/total)`)** — integer division order destroys the allocation; rounding must floor with an explicit residual rule.
- **Treating a halt as "no data"** — status messages continue, and open-order handling during a halt is venue-specific.
- **Relying on venue price bands as your risk control** — you need your own pre-trade collars.
- **Mixing implied/synthetic prices into the outright book** — manufactures apparent crosses.
- **Unadjusted corporate actions** — a clean 4× discontinuity in history and risk limits wrong by the split ratio.

---

## Compact Recall Summary

**Touch and spread.** Best bid = highest resting buy, best ask = lowest resting sell, spread = ask − bid, mid = average (often off the tick grid, so not tradeable). Bids sort descending, asks ascending, best first. Aggressor/taker crosses; maker rests. Hitting the bid is selling. Prices are scaled integers, always.

**Depth and liquidity.** MBP aggregates a level; MBO exposes each order and is the only way to compute queue position. Liquidity = tightness + depth + resilience + immediacy. Walking the book gives VWAP and slippage; watch overflow in the weighted sum. Displayed depth overstates reality — icebergs, hidden orders, fragmentation, fleeting quotes.

**Queue position.** Quantity ahead of you in the level FIFO. Executions consume from the front (unambiguous); cancels from an aggregated feed are ambiguous, so track optimistic and pessimistic bounds. Price change always loses priority; quantity increase usually does; partial fill and quantity decrease usually don't.

**Priority rules.** Price-time is lexicographic (side-directed price, then arrival sequence assigned by the engine — never client time). Implement as `price → FIFO`, never sort. Pro-rata allocates by size share with top-order allocation, minimum thresholds, floor rounding, and a venue-specific residual pass — determinism is mandatory. Hybrids split a configured percentage FIFO/pro-rata per instrument. The allocation rule is what makes latency economically valuable.

**Fees.** Maker-taker pays the resting side and charges the aggressor; inverted venues reverse it. Persist the venue's liquidity flag; never infer it. Tiered, per-share/per-contract/bps, with effective dates — it's reference data, and mis-attribution shows up as a volume-proportional discrepancy at month-end invoice reconciliation.

**Ticks and lots.** Tick = minimum price increment, bounds the spread below, and may be a table function of price and liquidity band (MiFID II RTS 11). Round order prices toward passive. Lot size, minimum quantity, and contract multiplier convert quantity and price into notional; tick value = tick × multiplier. Use `__int128` intermediates.

**Symbology.** Venue ticker (not unique), ISIN/CUSIP/SEDOL/FIGI (security, not venue), MIC (venue), and the venue's numeric security ID — which is what the binary feed carries and what the hot path must index directly. Internal key = (venue, native id, session). Watch ticker reuse, cross-listing, and daily ID reassignment.

**Reference data.** Tick, lot, multiplier, bands, hours, allocation algorithm, fees, mappings. Load and validate pre-session, fail closed on anything missing, apply intraday definition messages, publish immutable snapshots with atomic pointer swap, diff-and-alarm daily, never infer from market data. Corporate actions produce clean N× discontinuities.

**Sessions.** Pre-open → opening auction → continuous → closing auction → post-close, with halts and volatility auctions branching off. Crossed books are legal in call phases. Drive state from venue status messages, per instrument, never from a clock.

**Auctions.** Uncross at the price maximizing executable volume = min(cumulative buy ≥ p, cumulative sell ≤ p); tie-break minimum surplus, then surplus side, then reference price. Single print price for all fills. Closing auction sets the official close and is the day's capacity worst case.

**Halts and bands.** Regulatory, volatility (LULD: band → 15 s limit state → 5 min pause → reopening auction), market-wide, operational, and futures daily limits. Entry banding rejects; execution banding silently prevents fills. Open-order treatment is venue-specific; reopening is always an auction; your own collars remain mandatory.

**Locked and crossed.** Locked = bid equals ask; crossed = bid above ask. Impossible within one engine in continuous trading, so on a single-venue book it means a missed delete, an ignored sequence gap, an A/B arbitration bug, a snapshot/delta race, or a parse error. Fail closed on that instrument, re-sync, and continue everything else. Cross-venue locks are real but rule-restricted (Reg NMS 610/611).
