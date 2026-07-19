# Chapter 51 — Exchange Protocols

*Interview-focused revision notes. The theme: an exchange protocol is a negotiated trade between human readability, schema flexibility, and nanoseconds — and every wire format in this chapter is a different point on that curve, with session semantics and sequence numbering as the invariant substrate underneath.*

---

## 51.1 FIX Session Layer

**FIX** (Financial Information eXchange) is the lingua franca of electronic trading: an ASCII, tag-value protocol dating from 1992. It is split into a **session layer** (reliable, ordered, recoverable message delivery over a TCP connection) and an **application layer** (§51.2, the business messages). The session layer is the part worth understanding deeply, because every binary order-entry protocol in existence reimplements some subset of it.

### Wire format

A FIX message is a sequence of `tag=value` pairs delimited by **SOH** (`0x01`), conventionally written `|`:

```
8=FIX.4.2|9=112|35=D|34=17|49=CLIENT|56=EXCH|52=20260719-13:45:01.123|
11=ORD00001|55=AAPL|54=1|38=100|40=2|44=185.50|10=093|
```

| Tag | Name | Role |
|---|---|---|
| 8 | BeginString | Protocol version. **Must be first.** |
| 9 | BodyLength | Byte count from after `9=…|` to the `10=` field, exclusive. **Must be second.** |
| 35 | MsgType | Message discriminator. **Must be third.** |
| 34 | MsgSeqNum | Per-session, per-direction sequence number (§51.14) |
| 49/56 | SenderCompID / TargetCompID | Session identity |
| 52 | SendingTime | UTC timestamp |
| 10 | CheckSum | 3-digit modulo-256 sum (§51.13). **Must be last.** |

Tags 8, 9, 35 first and 10 last is what makes FIX **self-framing** over TCP: read until you have `9=`, parse the length, consume exactly that many bytes plus the 7-byte trailer (§51.7). Everything else is order-independent.

### Session state machine

```
        ┌──────────────┐  Logon(A) sent/recv, seqnums agree
        │ DISCONNECTED │ ─────────────────────────────────►┌────────────┐
        └──────────────┘                                   │ LOGGED_ON  │
               ▲  ▲                                        └────────────┘
               │  │ Logout(5) / TCP reset                    │   │    │
               │  └──────────────────────────────────────────┘   │    │
               │                          gap detected ──────────┘    │
               │                                ▼                      │
               │                        ┌───────────────┐   heartbeat  │
               └────────────────────────│ RESEND_PENDING│   timeout ───┘
                                        └───────────────┘
```

Session-level message types: **Logon (A)**, **Logout (5)**, **Heartbeat (0)**, **TestRequest (1)**, **ResendRequest (2)**, **SequenceReset (4)**, **Reject (3)**.

- **Logon** carries `HeartBtInt(108)`, the heartbeat interval in seconds, and optionally `ResetSeqNumFlag(141)=Y` to restart both sides at 1.
- **Heartbeat** must be emitted whenever `HeartBtInt` elapses with no other outbound traffic. If nothing arrives for `HeartBtInt + reasonable transmission time` (typically 20%), the receiver sends **TestRequest** with a `TestReqID(112)`; the peer must echo it in a Heartbeat. No reply → disconnect. This is application-level liveness detection because TCP keepalive (Ch. 38 §38.16) operates on minute-to-hour timescales and cannot detect a hung-but-connected peer.
- **ResendRequest** asks for `BeginSeqNo(7)`–`EndSeqNo(16)` (0 or 999999 meaning "infinity") — covered in §51.15.

### Sequence-number semantics

Each direction has an independent, monotonically increasing counter starting at 1, persisted across reconnects. The core rules:

- **Received seqnum > expected** → gap. Issue ResendRequest; do **not** discard the message (queue it).
- **Received seqnum < expected** and `PossDupFlag(43)` is not `Y` → **fatal**. The correct action is Logout and human intervention: the peer has lost state, and silently continuing risks acting on stale orders.
- **Received seqnum < expected** with `PossDupFlag=Y` → an administrative replay; ignore if already processed.

The **persistence requirement** is the operationally painful part: seqnums must survive process crash, so a FIX engine writes them to disk (or a journal, Ch. 56) before acknowledging. This is a synchronous durability point on the order-entry path and a primary motivation for binary protocols that push recovery semantics elsewhere.

---

## 51.2 FIX Application Messages

Application messages carry business intent. The order-entry subset maps onto the order lifecycle state machine of Ch. 50 §50.9.

| MsgType | Name | Direction | Purpose |
|---|---|---|---|
| `D` | NewOrderSingle | client → exchange | Submit an order |
| `F` | OrderCancelRequest | client → exchange | Cancel |
| `G` | OrderCancelReplaceRequest | client → exchange | Amend (price/qty) |
| `8` | ExecutionReport | exchange → client | **Everything**: ack, fill, cancel, expiry, reject |
| `9` | OrderCancelReject | exchange → client | Cancel/replace failed |
| `AF`/`AG` | OrderMassStatus / MassQuote | both | Bulk operations |
| `q`/`r` | OrderMassCancelRequest / Report | client → exchange | Mass cancel (Ch. 56) |

### The ExecutionReport is the whole protocol

Nearly all exchange→client state transitions arrive as an `8`. Two fields disambiguate:

- **`ExecType(150)`** — what *this message* reports: `0` New, `4` Canceled, `5` Replaced, `8` Rejected, `F` Trade, `C` Expired.
- **`OrdStatus(39)`** — the order's *current aggregate state*: `0` New, `1` PartiallyFilled, `2` Filled, `4` Canceled, `8` Rejected.

Conflating the two is a classic bug: after a partial fill you get `ExecType=F, OrdStatus=1`. A handler keyed on `OrdStatus` alone cannot tell a new fill from a re-sent status snapshot, and will double-count position.

### Identifier discipline

| Tag | Name | Owner | Lifetime |
|---|---|---|---|
| 11 | ClOrdID | **client** | Unique per *message*, not per order |
| 41 | OrigClOrdID | client | The ClOrdID being cancelled/replaced |
| 37 | OrderID | **exchange** | Stable for the order's life |
| 17 | ExecID | exchange | Unique per ExecutionReport |

The non-obvious rule: **a cancel/replace mints a new `ClOrdID`** and references the old one in `OrigClOrdID`. The chain `ClOrdID₁ → ClOrdID₂ → ClOrdID₃` must be tracked, because a fill may arrive referencing an *older* ClOrdID that was in flight when the replace was sent — the cancel/replace/fill race of Ch. 50 §50.10. Correlation tables keyed on both ClOrdID and OrderID are covered in Ch. 54.

### Quantity fields and the reconciliation identity

```
OrderQty(38)   = original quantity
CumQty(14)     = cumulative filled
LeavesQty(151) = remaining working quantity
LastQty(32)    = quantity of THIS fill
AvgPx(6)       = average fill price
```

The invariant, which every gateway should assert on each report:

```cpp
// Holds for a live order; after cancel, LeavesQty == 0 and CumQty < OrderQty.
assert(cum_qty + leaves_qty == order_qty - canceled_qty);
assert(cum_qty >= prev_cum_qty);          // CumQty is monotonic
last_qty = cum_qty - prev_cum_qty;        // derive fills from CumQty, not LastQty
```

Deriving the fill increment from `CumQty` deltas rather than trusting `LastQty` makes the handler **idempotent** against duplicate ExecutionReports (Ch. 54) — a re-delivered report has the same `CumQty`, so the delta is zero. This is the single most valuable design rule in FIX application handling.

### Repeating groups

FIX encodes arrays as a count field followed by that many repetitions, e.g. `NoPartyIDs(453)=2|448=…|447=…|452=…|448=…|447=…|452=…`. The first tag of the repetition delimits entries. Parsing requires the schema, since nothing on the wire says where a group ends — this is why FIX cannot be parsed generically without a data dictionary, and why the count field is a prime input-validation target (§51.12).

### Why FIX is slow

Per message: variable-length ASCII fields, integer/decimal parsing from text, a linear scan for each tag (or a hash), no fixed offsets, and a full-message checksum pass. A tuned FIX parser costs **1–5 µs**; SBE or a native binary protocol costs **50–200 ns**. FIX survives on order entry (where a few microseconds against exchange matching-engine latency is tolerable and schema flexibility is valuable) and is essentially extinct on high-rate market data.

---

## 51.3 FAST Encoding

**FAST** (FIX Adapted for STreaming) is a compression layer that preserves FIX semantics while attacking bandwidth. It was designed for multicast market data in the mid-2000s, when 100 Mbit links were the constraint. CME's legacy FIX/FAST feed and several European venues used it; most have since migrated to SBE.

### The three mechanisms

**1. Presence map (PMAP).** Each message begins with a bitmap — one bit per schema field that *may* be omitted. A `0` bit means "field absent, derive it from the operator." This eliminates the tag from the wire entirely: fields are positional per the schema.

**2. Field operators.** Each field carries a schema-declared operator describing how to reconstruct the value from prior state:

| Operator | Semantics | Wire cost when unchanged |
|---|---|---|
| `constant` | Always the schema value | 0 bits, 0 bytes |
| `default` | Schema default unless present | 1 PMAP bit |
| `copy` | Same as previous message's value | 1 PMAP bit |
| `increment` | Previous value + 1 | 1 PMAP bit |
| `delta` | Previous value + encoded signed delta | delta bytes, **no PMAP bit** |
| `tail` | Replace only the string suffix | length + suffix |

`delta` is the workhorse for prices and sequence numbers: consecutive quotes differ by a tick, so a 64-bit price becomes one byte. `copy` handles symbol IDs in a per-instrument stream.

**3. Stop-bit encoded integers.** Variable-length base-128: seven data bits per byte, the high bit set on the *final* byte.

```
value 0x7F (127)          →  [1111 1111]                  1 byte
value 0x80 (128)          →  [0000 0001][1000 0000]       2 bytes
signed −1                 →  [1111 1111]                  sign-extended from bit 6
```

Note this is the opposite convention from protobuf varints (continuation bit on all but the last). Decimals are encoded as an exponent/mantissa pair, each independently operator-controlled — so a price whose exponent never changes costs one PMAP bit for the exponent forever.

### The latency verdict

FAST achieves 3–5× compression, which mattered enormously on constrained links. Its cost is that decoding is **inherently serial and stateful**:

- Field *n*'s byte offset depends on the decoded length of fields 0…*n*−1. No fixed offsets, no zero-copy, no SIMD, no branch-free parse.
- The decoder must maintain a **per-template dictionary** of previous field values. A gap in the stream (§51.14) invalidates the dictionary, so recovery requires either a `reset` message or waiting for the next dictionary-resetting boundary.
- Stop-bit loops are unpredictable branches (Ch. 27 §27.8), typically 1–2 mispredictions per field.

Measured decode cost is **0.5–2 µs per message**. FAST is the canonical example of the bandwidth-vs-latency trade: it was a correct engineering decision when links were the bottleneck and is the wrong one when 10/25/100 GbE is cheap. Its historical importance in interviews is exactly this — being able to explain *why* the industry moved to fixed-layout binary encodings.

**Failure signature:** a FAST decoder that silently produces plausible-but-wrong prices after a packet loss. Because the dictionary is stateful, a dropped message corrupts every subsequent `copy`/`delta` field until reset. The diagnostic is prices that drift by a constant offset or freeze at a stale value while the sequence numbers advance normally.

---

## 51.4 ITCH Market Data

**ITCH** is Nasdaq's binary market-data protocol, and the archetype for "full order depth over UDP multicast." Variants (TotalView-ITCH, BX/PSX ITCH, and ITCH-derived feeds at Cboe, LSE, and others) share the design. It is **broadcast-only**: no requests, no per-client state, one stream for all subscribers.

### Design principles

1. **Fixed-length messages** discriminated by a one-byte type code. Every field is at a compile-time-known offset.
2. **Big-endian** integers (a legacy of network byte order; §51.10).
3. **No padding, no alignment** — fields are packed to byte boundaries.
4. **Order-by-order granularity**: the feed reports individual orders with exchange-assigned reference numbers, so the receiver can rebuild the exact book including queue position (Ch. 49 §49.3).

### Message layout

```
Add Order (type 'A'), 36 bytes, big-endian, no padding:

off  size  field
  0    1   MessageType   = 'A'
  1    2   StockLocate         ← index into the symbol directory
  3    2   TrackingNumber
  5    6   Timestamp           ← 48-bit nanoseconds since midnight
 11    8   OrderReferenceNumber
 19    1   BuySellIndicator    ← 'B' or 'S'
 20    4   Shares
 24    8   Stock               ← 8 ASCII chars, space-padded
 32    4   Price               ← fixed-point, 4 implied decimals
```

Note `sizeof` this as a naive C struct would be 40 bytes with padding (Ch. 3 §3.4) — the wire layout is 36. This is why in-place struct overlay requires `#pragma pack` plus unaligned-safe access (§51.10), or field-by-field extraction.

### The message set is a state machine over orders

| Type | Message | Effect on book |
|---|---|---|
| `S` | System Event | Session start/end, market open/close |
| `R` | Stock Directory | Symbol ↔ StockLocate mapping, tick size, lot size |
| `H` | Stock Trading Action | Halt / resume (Ch. 49 §49.13) |
| `A` / `F` | Add Order (without / with MPID) | Insert order at price level |
| `E` | Order Executed | Reduce order by shares; emit trade |
| `C` | Order Executed With Price | Execution at a price ≠ display price |
| `X` | Order Cancel | Partial reduce |
| `D` | Order Delete | Full removal |
| `U` | Order Replace | Delete old ref, add new ref — **new reference number** |
| `P` | Trade (non-cross) | Hidden/off-book print; **does not touch the book** |
| `Q` | Cross Trade | Auction print |
| `B` | Broken Trade | A previously reported trade is void |

Two non-obvious points that separate candidates:

- **`P` (Trade) must not modify the book.** It reports executions against non-displayed liquidity. A book builder that decrements displayed size on every trade message will corrupt the book. Conversely `E`/`C` *do* modify it.
- **`U` (Replace) changes the order reference number.** The old reference is dead; queue priority is lost. A handler that reuses the old reference leaks entries in the order-reference hash map — the diagnostic signature is unbounded memory growth over a trading day with no corresponding book depth increase.

### Transport and framing

ITCH is carried over UDP multicast (Ch. 37) inside **MoldUDP64**, which prepends a session identifier, a 64-bit sequence number, and a message count, then packs multiple ITCH messages into one datagram with 2-byte length prefixes (§51.7). Sequencing, gap detection, and recovery live entirely in MoldUDP64 — ITCH itself has no sequence number. This separation is the design lesson: **the framing/sequencing layer is protocol-agnostic and reusable**, and the payload layer is pure business semantics.

### Why it is fast

Parsing is a `switch` on one byte followed by loads at constant offsets. No length fields to consume, no state to maintain, no allocation. A tuned ITCH decoder runs **20–60 ns per message**, dominated by the byte swaps and the hash lookup for the order reference number.

---

## 51.5 OUCH Order Entry

**OUCH** is Nasdaq's binary order-entry protocol, the counterpart to ITCH. Where FIX is flexible and text-based, OUCH is a minimal fixed-layout binary protocol optimized for one thing: submitting and cancelling orders in the fewest possible nanoseconds and bytes.

### Message set

Inbound (client → exchange):

| Type | Message | Size |
|---|---|---|
| `O` | Enter Order | 47 bytes |
| `U` | Replace Order | 47 bytes |
| `X` | Cancel Order | 19 bytes |
| `M` | Modify Order (side/qty) | 20 bytes |

Outbound (exchange → client):

| Type | Message | Meaning |
|---|---|---|
| `S` | System Event | Session lifecycle |
| `A` | Accepted | Order acknowledged, exchange order ref assigned |
| `U` | Replaced | Amend accepted |
| `C` | Canceled | With a reason code |
| `E` | Executed | Fill: shares, price, match number |
| `J` | Rejected | With a reason code |
| `P` | Cancel Pending / `I` Cancel Reject | Async cancel outcomes |

```
Enter Order ('O'), 47 bytes:

off  size  field
  0    1   'O'
  1   14   OrderToken        ← CLIENT-assigned, 14 ASCII bytes, must be unique
 15    1   BuySellIndicator
 16    4   Shares
 20    8   Stock
 28    4   Price
 32    4   TimeInForce
 36    4   Firm
 40    1   Display
 41    1   Capacity
 42    4   MinQty
 46    1   CrossType
```

### The design decisions that matter

**Client-assigned tokens.** `OrderToken` is the client's identifier and appears on every response. There is no round-trip needed to learn an exchange ID before you can cancel — a cancel can be sent immediately after the enter, before the ack arrives. Contrast with protocols requiring the exchange's OrderID for cancellation, which serialize cancel behind the ack and add a full RTT to your worst-case cancel latency. Structuring the token as a monotonically increasing counter rendered into 14 ASCII bytes lets the client index its correlation table with an array subscript instead of a hash lookup.

**No session-level sequence numbers on the inbound side.** OUCH runs over **SoupBinTCP**, which supplies login, heartbeats, sequenced outbound delivery, and unsequenced inbound delivery. Inbound messages are unsequenced because the client's TCP connection already provides ordering, and the *exchange* is the authority on what was received — the client learns the fate of every order from the sequenced outbound stream, which it can replay after reconnect from the last sequence number it saw. This is the crucial asymmetry: **outbound is a durable, replayable log; inbound is fire-and-forget.**

```
SoupBinTCP framing:
  [ uint16 length BE ][ uint8 type ][ payload (length-1 bytes) ]

  type 'S' = Sequenced Data     (outbound, consumes a sequence number)
  type 'U' = Unsequenced Data   (inbound)
  type 'R' = Debug
  type '+' = Login Accepted     (carries session id + next sequence number)
  type 'H' = Heartbeat          (both directions, 1/sec)
  type 'Z' = End of Session
```

Login Request carries the requested session and the **sequence number to resume from**; the exchange replays everything from there. Requesting `0` means "start from the next new message" — the correct choice for a strategy that has already reconciled elsewhere, and the wrong choice if you need the day's history.

**Fixed layout with no optional fields.** Every Enter Order is exactly 47 bytes, so serialization is a struct store and framing is trivial. Latency contribution: single-digit nanoseconds of encoding, which is why OUCH-style protocols are what FPGA order-entry paths (Ch. 48 §48.2) implement — the message can be built and pushed to the MAC in a fixed number of clock cycles with no branching.

**Interview framing:** *"Why would an exchange offer both FIX and OUCH?"* — FIX for broad connectivity, complex order types, and firms whose latency budget is measured in milliseconds; OUCH for the latency-sensitive tier that needs deterministic, minimal encoding and does not need FIX's extensibility. The protocols encode different customers, not different eras.

---

## 51.6 Simple Binary Encoding

**SBE** is the FIX Trading Community's standard binary encoding, and the current mainstream answer for low-latency exchange protocols (CME, Eurex/ETI-adjacent, B3, several crypto venues). It was designed explicitly against a latency objective, and its design choices are the best single case study in this chapter.

### Design principles, stated

1. **Fixed-length fields at fixed offsets** in the common case — direct field access, no scanning.
2. **Native endianness** (the schema declares it; almost always little-endian) — no byte swaps on x86/ARM (§51.10).
3. **Native alignment** where possible — no unaligned loads.
4. **Field order matches schema order**, so encoding and decoding are sequential writes/reads that stream through cache.
5. **No conditional branching** in the hot path of field access.
6. **Schema-driven code generation** — the codec is generated C++ (or Java/C#/Rust) from an XML schema, so all offsets are compile-time constants.

### Message structure

```
┌────────────────────────────────────────────────────────────────┐
│ MessageHeader (8 bytes, fixed)                                 │
│   uint16 blockLength   ← size of the fixed root block          │
│   uint16 templateId    ← which message                         │
│   uint16 schemaId                                              │
│   uint16 version                                               │
├────────────────────────────────────────────────────────────────┤
│ Root block: fixed-size fields, fixed offsets (blockLength B)   │
├────────────────────────────────────────────────────────────────┤
│ Repeating group 1: GroupSizeEncoding { uint16 blockLength;     │
│                                        uint16 numInGroup }     │
│   entry[0] … entry[n-1]  (each blockLength bytes)              │
├────────────────────────────────────────────────────────────────┤
│ Variable-length data: { uint32 length; uint8 data[length] }    │
└────────────────────────────────────────────────────────────────┘
```

The ordering is deliberate: **fixed → groups → var-length**. Everything with a compile-time offset comes first, so the common path touches only constant offsets. Variable-length data is last so it cannot shift anything.

### Generated accessor shape

```cpp
class NewOrderSingle {
    std::byte* buf_;  std::uint64_t offset_;
public:
    // Offsets are compile-time constants from the schema.
    std::int64_t price() const noexcept {
        std::int64_t v;
        std::memcpy(&v, buf_ + offset_ + 24, sizeof v);   // no swap: native LE
        return v;                                          // compiles to one mov
    }
    void price(std::int64_t v) noexcept {
        std::memcpy(buf_ + offset_ + 24, &v, sizeof v);
    }
};
```

`memcpy` here is the standards-correct way to avoid strict-aliasing UB (Ch. 3 §3.8) and compiles to a single instruction. This accessor is the entirety of "zero-copy deserialization" (§51.9): no object is constructed, no bytes are moved, and the message stays in the NIC receive buffer.

### Version evolution

`blockLength` in the header is the mechanism. A version-5 encoder writes a root block larger than a version-3 decoder expects; the decoder reads the fields it knows at their (unchanged) offsets and skips to `offset + blockLength` to find the groups. New fields are therefore **appended only**, and old decoders remain correct. Group entries carry their own `blockLength` for the same reason. See §51.11.

### Cost comparison

| Encoding | Bytes for a NewOrderSingle | Decode cost | Notes |
|---|---|---|---|
| FIX tag-value | ~120–200 | 1–5 µs | Text parse, tag scan, checksum |
| FAST | ~15–30 | 0.5–2 µs | Stateful, serial |
| SBE | ~60–80 | 20–50 ns | Fixed offsets, no swap |
| ITCH/OUCH-style | ~36–47 | 20–60 ns | Same class; big-endian costs a `bswap` |

SBE is *larger on the wire* than FAST and comparable to hand-rolled binary, and dramatically cheaper to process. Given 10 GbE, that is unambiguously the right trade.

---

## 51.7 Binary Message Framing

**Framing** is the mechanism by which a receiver determines where one message ends and the next begins. It is a distinct concern from encoding, and getting it wrong is the most common source of protocol bugs.

### Why it is needed at all

TCP is a **byte stream** with no message boundaries (Ch. 38 §38.1): a single `send()` of 100 bytes may arrive as one 100-byte `recv`, two 50-byte `recv`s, or coalesced with the next message into a 200-byte `recv`. UDP preserves datagram boundaries (Ch. 37 §37.1), so a single-message-per-datagram protocol needs no framing — but market-data protocols pack many messages per datagram for efficiency, reintroducing the problem inside the payload.

### The four framing strategies

| Strategy | Mechanism | Used by | Risk |
|---|---|---|---|
| **Length prefix** | Fixed-width length precedes payload | SoupBinTCP, SBE-over-TCP, most binary | Untrusted length (§51.12) |
| **Fixed size by type** | Type byte determines length via a table | ITCH inside MoldUDP64 | Unknown type byte is unrecoverable |
| **Delimiter** | Terminator byte/sequence | FIX (SOH + `10=xxx|`) | Delimiter must be escaped or forbidden in payload |
| **Self-describing length field** | Length is a payload field | FIX `BodyLength(9)` | Length and actual content can disagree |

### Two canonical wire pictures

```
MoldUDP64 (UDP multicast, Nasdaq):
┌──────────────┬─────────────┬───────────┬───────────────────────────┐
│ Session[10]  │ SeqNum u64  │ Count u16 │ [len u16][msg] [len u16]… │
└──────────────┴─────────────┴───────────┴───────────────────────────┘
  SeqNum = sequence of the FIRST message in this packet.
  Count = 0        → heartbeat (keeps gap detection alive on quiet symbols)
  Count = 0xFFFF   → end of session

SoupBinTCP (TCP, unicast):
┌────────────┬──────────┬──────────────────────┐
│ Length u16 │ Type u8  │ Payload (Length-1 B) │
└────────────┴──────────┴──────────────────────┘
  Length COUNTS the type byte. Off-by-one here is the classic bug.
```

### Implementing a correct TCP reassembler

```cpp
// Ring buffer of received bytes; returns spans of complete messages.
// Preconditions: hdr_size == 2, length excludes itself.
void FrameReader::on_bytes(std::span<const std::byte> in) {
    buf_.append(in);                                  // preallocated, never grows past cap
    for (;;) {
        if (buf_.size() < 2) return;                  // need the length
        std::uint16_t len;
        std::memcpy(&len, buf_.data(), 2);
        len = be16toh(len);
        if (len < kMinMsg || len > kMaxMsg) {         // §51.12 — validate BEFORE using
            fail_session(FramingError::BadLength);
            return;
        }
        if (buf_.size() < std::size_t(2) + len) return;   // partial; wait for more
        dispatch(buf_.subspan(2, len));               // zero-copy view into the buffer
        buf_.consume(2 + len);
    }
}
```

Non-obvious requirements:

- **The loop is mandatory.** One `recv` can deliver several messages; a reader that handles one per wakeup builds unbounded latency under load, and if it is edge-triggered on epoll (Ch. 34 §34.11) it will simply stall.
- **Partial-header handling.** The length field itself can straddle two `recv`s. Code that reads a 2-byte length without checking `size() >= 2` reads uninitialized memory.
- **The buffer must be bounded and preallocated.** `kMaxMsg` gives you the bound; a `std::vector` that `resize`s on the hot path allocates (Ch. 8 §8.8).
- **Compaction strategy.** After `consume`, either memmove the remainder to the front (cheap when the remainder is small, which it usually is) or use a ring with wraparound. Compacting every message on a mostly-empty buffer is free; compacting a nearly-full 1 MB buffer per message is not.

**Failure signature:** framing desynchronization presents as a burst of "unknown message type" errors followed by nonsense field values, all originating at one point in time and never recovering. Because the reader is now reading a length field out of the middle of a payload, the only correct response is to **tear down the session** — there is no way to resynchronize a length-prefixed stream. Attempting to "scan forward for a plausible message" is how you turn a framing bug into an incorrect trade.

---

## 51.8 Allocation-Free Parsing

A hot-path parser must not touch the allocator. The reasons compound: `malloc` is 20–100 ns even when it hits a thread cache, its worst case involves a lock and possibly `mmap` (Ch. 7), it destroys cache locality, and — most importantly for latency distributions — its cost is **bimodal and unbounded in the tail** (Ch. 43 §43.2).

### The rules

**1. Parse into views, not owned objects.**

```cpp
struct AddOrderView {                       // 0 bytes of ownership
    const std::byte* p;
    std::uint64_t ref()    const { return load_be<std::uint64_t>(p + 11); }
    std::uint32_t shares() const { return load_be<std::uint32_t>(p + 19); }
    std::string_view sym() const { return {reinterpret_cast<const char*>(p + 24), 8}; }
};
```

`std::string_view` and `std::span` (Ch. 13) are the vocabulary types. The lifetime contract must be explicit and documented: **the view is valid only until the receive buffer is recycled.** Anything that must outlive the callback copies into preallocated storage.

**2. Preallocate every container to its worst case.** Order-reference maps, price-level arrays, symbol tables — sized at startup from reference data, with `reserve()` called before the market opens. A rehash of a 10-million-entry `unordered_map` mid-session is a multi-millisecond stall.

**3. Fixed-capacity types for bounded data.** `std::inplace_vector` (Ch. 11), fixed char arrays for symbols, `std::array` for repeating groups whose max count is schema-bounded. Never `std::string` for a symbol — SSO (Ch. 13 §13.2) saves you only up to 15 chars and still costs a branch and a fatter object.

**4. Object pools for anything with a lifetime.** Order objects, book nodes: allocate a slab at startup, hand out indices, free-list the rest (Ch. 7 §7.9, Ch. 55 §55.2). Indices beat pointers — 4 bytes instead of 8, relocatable, and shared-memory-safe (Ch. 3 §3.12).

**5. No exceptions on the parse path.** A malformed message is an expected event, not an exceptional one. Return `std::expected<View, ParseError>` (Ch. 10 §10.11) or an error enum. Throwing costs microseconds on the unwind path and is unbounded (Ch. 10 §10.7).

### Verifying it

The strong-candidate answer is that you don't assert this by inspection, you enforce it mechanically:

```cpp
// Link-time or LD_PRELOAD interposition; trip a flag if called after warmup.
extern "C" void* malloc(std::size_t n) {
    if (g_hot_path_active.load(std::memory_order_relaxed)) __builtin_trap();
    return real_malloc(n);
}
```

Alternatives: heaptrack / a jemalloc profiling build under replay (Ch. 43 §43.23), or simply `perf stat` on page-faults and `brk`/`mmap` counts, which should be flat after warmup. A rising `minor-faults` count during steady-state trading is the diagnostic signature of an allocating hot path.

---

## 51.9 Zero-Copy Deserialization

**Zero-copy deserialization** means field access reads directly out of the network receive buffer, with no intermediate object materialized. It is the natural consequence of fixed-offset binary encodings and the reason SBE/ITCH/OUCH are shaped as they are.

### The copy count, end to end

| Path | Copies before field access |
|---|---|
| Kernel stack, `recv()` into user buffer, parse into POD struct | 3 (DMA→skb, skb→user, user→object) |
| Kernel stack with `recvmmsg` into a pool, view-based parse | 2 |
| `AF_XDP` / `PACKET_MMAP` zero-copy ring, view-based parse | 1 (DMA→ring) |
| Kernel bypass (ef_vi, OpenOnload, DPDK), view-based parse | 1 (DMA→ring), **and the parse reads the DMA'd bytes directly** |

Ch. 47 covers the transport half; the protocol half is that a view-based decoder makes the last copy disappear. The two must be designed together — a zero-copy NIC path feeding a parser that constructs a `std::vector<Field>` has gained nothing.

### The C++ mechanics

The naive approach — `reinterpret_cast<const AddOrder*>(buf)` — is undefined behavior on three counts: no object of that type was created there (Ch. 3 §3.7), the buffer may be misaligned (Ch. 3 §3.3), and the access violates strict aliasing (Ch. 3 §3.8). The correct options:

```cpp
// (a) memcpy per field — always correct, compiles to a single load, handles misalignment.
template <class T> T load_le(const std::byte* p) {
    T v; std::memcpy(&v, p, sizeof(T)); return v;      // no swap on LE hosts
}

// (b) C++23: declare that the bytes ARE the object. Requires implicit-lifetime type,
//     correct size, and CORRECT ALIGNMENT — which the caller must guarantee.
const Header* h = std::start_lifetime_as<Header>(buf);

// (c) std::bit_cast for whole fixed-size structs (copies, but the copy is elided).
auto msg = std::bit_cast<AddOrderWire>(raw_bytes);
```

Option (a) is the default; it is free after optimization and imposes no alignment precondition. Option (b) is for large messages where per-field `memcpy` would matter, and requires you to control buffer alignment — practical when you own the receive ring and can align each frame's payload.

### Alignment in the receive ring

An Ethernet frame's payload begins at offset 14 (Ethernet header) + 20 (IPv4) + 8 (UDP) = 42 from the frame start. If the ring buffer entry is 64-byte aligned, the protocol payload sits at a 2-mod-4 address — **every 4-byte field is misaligned**. Standard mitigations:

- Have the NIC/driver offset the DMA write by 2 bytes so the IP header is 4-aligned (the Linux `NET_IP_ALIGN` convention).
- Use `memcpy`-based accessors, which do not care.
- Design the protocol so hot fields are naturally aligned *relative to the message start* and ensure the message start is aligned — what SBE's alignment rules aim at.

On x86-64 misaligned scalar loads are nearly free unless they straddle a cache line or page (Ch. 29 §29.12); on ARM they are fine for normal memory but fatal for atomics and SIMD. The straddle case is the one that shows up as a tail-latency outlier: a 4-byte field crossing a 4 KB page boundary costs hundreds of cycles.

### The lifetime hazard

Views into the receive ring are invalidated when the entry is returned to the NIC. In a busy-poll loop (Ch. 47 §47.11) this happens at the end of each iteration. Any state retained across iterations — an order in a pending map, a symbol string, a book entry — must be **copied into owned storage before the loop advances**. The bug's diagnostic signature is book corruption that correlates with receive-ring pressure and disappears under light load, because at low rates the ring entry is not reused before the stale view is read.

---

## 51.10 Protocol Endianness and Alignment

### Endianness

Historically, "network byte order" is big-endian, and protocols designed before ~2005 (FIX's binary companions, ITCH, OUCH, MoldUDP64) are big-endian. Every field access on an x86 or ARM host therefore costs a byte swap.

The swap itself is cheap — one `BSWAP`/`REV` instruction, ~1 cycle latency, and x86 has `MOVBE` which folds the swap into the load. For a 36-byte ITCH message with four multi-byte fields, that is ~4 cycles. It is not the difference between a good and bad system, but it is unnecessary, and it is a dependency in the critical path of every field.

Modern protocols choose **little-endian** because every host that matters is little-endian:

| Protocol | Endianness | Rationale |
|---|---|---|
| FIX | ASCII (n/a) | Human-readable |
| ITCH / OUCH / MoldUDP64 | Big-endian | Network-order convention of its era |
| SBE | **Schema-declared, normally little** | Explicit design goal: no swap on the host |
| CME MDP 3.0 (SBE) | Little-endian | Same |
| Most crypto venue binary protocols | Little-endian | Same |

```cpp
// Correct, portable, and optimal — see Ch. 3 §3.9.
template <class T> T load_be(const std::byte* p) {
    T v; std::memcpy(&v, p, sizeof v);
    if constexpr (std::endian::native == std::endian::little) v = std::byteswap(v);
    return v;
}
```

`if constexpr` on `std::endian::native` compiles the branch away entirely. Never `ntohl(*(uint32_t*)p)` — that is both an aliasing violation and a potentially misaligned load.

The **48-bit timestamp** in ITCH is the awkward case: there is no `uint48_t`, so you load 8 bytes from `p - 2` (dangerous — may read before the buffer) or assemble from two loads. The clean form:

```cpp
std::uint64_t load_be48(const std::byte* p) {
    std::uint64_t hi = load_be<std::uint16_t>(p);
    std::uint32_t lo = load_be<std::uint32_t>(p + 2);
    return (hi << 32) | lo;
}
```

### Alignment

Wire formats are packed; C++ structs are padded (Ch. 3 §3.4). The three approaches:

| Approach | Correctness | Cost |
|---|---|---|
| `#pragma pack(1)` struct overlay + direct member access | Taking a member's address is UB; faults on strict-alignment targets; `-Waddress-of-packed-member` | Zero if it works |
| Per-field `memcpy` accessors | Always correct, alignment-agnostic | Zero after optimization |
| Schema-designed natural alignment (SBE) | Correct if the message start is aligned | Zero, and enables SIMD |

Per-field `memcpy` accessors are the professional default. The generated code is identical to a direct load on x86-64 and correct everywhere.

**SBE's alignment discipline** is worth stating precisely: the schema author is expected to order fields so that each is naturally aligned within the block, inserting explicit padding fields where needed, and to make `blockLength` a multiple of the strictest field alignment. This is exactly the wire-layout discipline of Ch. 3 §3.12, encoded in a schema language — and it is why SBE messages are slightly larger than a hand-packed equivalent.

---

## 51.11 Schema and Version Evolution

An exchange cannot upgrade all clients simultaneously. Protocol evolution rules therefore have to guarantee that **old decoders survive new encoders** (forward compatibility) and **new decoders survive old encoders** (backward compatibility) at the same time.

### The mechanisms, per protocol

| Protocol | Add a field | Remove a field | Old decoder behavior |
|---|---|---|---|
| **FIX** | New tag; unknown tags are ignored by conforming parsers | Mark deprecated, never reuse the number | Ignores unknown tag — inherently forward-compatible |
| **SBE** | Append to the end of the block; `blockLength` grows | Never remove; mark deprecated, keep the bytes | Reads known offsets, skips to `offset + blockLength` |
| **ITCH/OUCH** | New message type, or a longer variant with a new type byte | Never | Unknown type byte → **must be treated as fatal** unless the framing carries a length |
| **FAST** | New template version | Never | Template mismatch → decode garbage |

### The SBE contract, precisely

```
v3 encoder → v3 decoder:   [hdr blockLength=32][ 32 bytes ][groups…]
v5 encoder → v3 decoder:   [hdr blockLength=40][ 40 bytes ][groups…]
                                                ▲
                            v3 reads offsets 0..31 (unchanged), then skips
                            to offset 40 using blockLength from the HEADER,
                            NOT its compiled-in constant. Groups parse fine.
```

The rule this yields, and the one interviewers probe:

> **Never change the offset, size, or meaning of an existing field. Only append. Never reuse a retired field's bytes or a retired enum value.**

A field whose semantics change while its offset stays the same is the worst case: no decoder errors, and every downstream number is silently wrong.

### Enum and null-value handling

SBE requires each optional field to declare a **null value** (e.g. `INT32_MIN`, `UINT64_MAX`) rather than using a presence bitmap. Adding a new enum value is therefore a compatibility event: an old decoder that `switch`es on the enum hits its `default`. The correct discipline is that every generated `switch` has an explicit `default` that either ignores or fails loudly according to the field's criticality — never falls through to a wrong case.

### Operational protocol for a version cutover

1. **Deploy the new decoder first**, capable of reading both versions. Verify against captured production traffic (Ch. 57 §57.14).
2. Exchange enables the new version, typically on a parallel multicast group or a new session, in a test environment first.
3. Run both feeds in production, comparing decoded output message-for-message (**differential testing**, Ch. 57 §57.3) before cutting over.
4. Keep the old path deployable for rollback (Ch. 60 §60.3).

The non-obvious detail: **reference data changes are more dangerous than schema changes.** A new tick-size regime, a symbol reuse, or a new instrument type (Ch. 49 §49.10) arrives with no protocol version bump at all and can break a book builder that assumed a fixed tick grid or a fixed-width symbol identifier. Reference-data validation at startup (Ch. 60 §60.9) is the guard.

---

## 51.12 Untrusted Length and Count Validation

Every length and count on the wire is attacker-controlled input, and in a trading system the "attacker" need not be malicious — a buggy exchange gateway, a corrupted UDP payload that passed a weak checksum, or your own framing desynchronization (§51.7) produces the same effect.

### The four classes of bug

**1. Length exceeding the buffer.**

```cpp
std::uint16_t len = load_be<std::uint16_t>(p);
process(p + 2, len);                 // BUG: len can be 65535; buffer may hold 100 bytes
```

Every length must be checked against the **remaining bytes actually received**, not against the protocol maximum alone:

```cpp
if (len > remaining - 2) return Err::Truncated;
if (len < kMinPayload || len > kMaxPayload) return Err::BadLength;
```

Both checks are needed: the first prevents over-read, the second catches desynchronization early and bounds the buffer.

**2. Count times element size overflowing.**

```cpp
std::uint16_t n = load_le<std::uint16_t>(p);
if (2 + n * kEntrySize > remaining) return Err::Truncated;   // BUG: n * kEntrySize
                                                             // can overflow (Ch. 2 §2.4)
```

Correct form — divide instead of multiply, or use a wider type:

```cpp
if (n > (remaining - 2) / kEntrySize) return Err::Truncated;
```

**3. Length underflow.** SoupBinTCP's length counts the type byte, so `payload_len = len - 1`. If `len == 0`, this underflows to 65535 on a `uint16_t` or `SIZE_MAX` on a `size_t`, and the subsequent `span` covers the entire address space. `if (len == 0) return Err::BadLength;` — before the subtraction.

**4. Self-inconsistent nested lengths.** A repeating group whose entries collectively exceed the enclosing message's length. Each nesting level must be validated against the *already-narrowed* remaining span, not against the top-level buffer.

### The structural fix

Validate once, at the boundary, into a narrowed non-owning view; never hand raw pointer+length pairs deeper into the system.

```cpp
class Cursor {
    const std::byte* p_; const std::byte* end_;
public:
    // Returns nullopt rather than trapping — malformed input is expected, not exceptional.
    std::optional<std::span<const std::byte>> take(std::size_t n) noexcept {
        if (static_cast<std::size_t>(end_ - p_) < n) return std::nullopt;
        auto s = std::span(p_, n); p_ += n; return s;
    }
    template <class T> std::optional<T> take_le() noexcept {
        auto s = take(sizeof(T));
        if (!s) return std::nullopt;
        T v; std::memcpy(&v, s->data(), sizeof v); return v;
    }
};
```

The pointer-difference comparison is done in `size_t` after the subtraction of two pointers into the same buffer, which is well-defined (Ch. 3 §3.10); comparing `p_ + n <= end_` is not, because `p_ + n` can be computed past the end and is UB before the comparison ever runs. This is a genuinely non-obvious point and a good one to raise unprompted.

### Testing

Malformed-message fuzzing (Ch. 57 §57.8) with libFuzzer over the parse entry point, under ASan and UBSan (Ch. 44), is the standard mechanism. A parser with a `Cursor`-shaped interface is trivially fuzzable because the entry point is `parse(span<const byte>)`. The pass criterion is that no input produces a crash, a sanitizer report, or an unbounded loop — not that every input is rejected.

**Failure signature:** an over-read that lands in the same receive ring produces *plausible* garbage — a valid-looking symbol, an absurd price. An over-read past a page boundary produces a SIGSEGV whose faulting address is just past a mapped region. The former is far more dangerous because it can reach the risk layer.

---

## 51.13 Checksums and CRCs

### What each layer already gives you

| Layer | Check | Strength |
|---|---|---|
| Ethernet FCS | CRC-32 over the frame | Strong; corrupt frames dropped by the NIC, counted in `rx_crc_errors` |
| IPv4 header checksum | 16-bit one's complement, **header only** | Weak; not present in IPv6 |
| UDP checksum | 16-bit one's complement over pseudo-header + payload | Weak, and **optional in IPv4** (a zero checksum means "not computed") |
| TCP checksum | Same algorithm, mandatory | Weak |
| Application | FIX `CheckSum(10)`, or none | Varies |

The critical fact: the **16-bit one's-complement checksum used by IP/UDP/TCP is weak**. It cannot detect reordering of 16-bit words, cannot detect compensating errors in different words, and misses roughly 1 in 65536 random corruptions. Studies of long-haul TCP traffic found undetected corruption at rates around 1 in 10⁸–10¹⁰ segments. Ethernet's CRC-32 covers each *link*, but a store-and-forward switch (Ch. 39 §39.1) recomputes the FCS after buffering, so memory corruption inside a switch produces a frame with a *valid* FCS and corrupt contents.

This is why the application-level sequence number (§51.14) is the real integrity mechanism for market data: it catches loss and reordering, which are the failure modes that actually occur, at a cost of a comparison.

### FIX CheckSum

```cpp
// Sum of every byte from '8' through the SOH preceding "10=", mod 256,
// rendered as exactly three ASCII digits.
std::uint8_t fix_checksum(std::span<const std::byte> msg) {
    std::uint32_t s = 0;
    for (auto b : msg) s += std::to_integer<std::uint8_t>(b);
    return static_cast<std::uint8_t>(s);
}
```

It is a **modulo-256 additive checksum** — the weakest useful construct. It cannot detect byte transposition at all (addition is commutative), and detects only 255/256 of random corruptions. Its actual value is as a *framing* check: if the checksum fails, you are more likely mis-framed than corrupted. Validating it costs a linear pass over the message, roughly doubling FIX parse cost, which is why some low-latency FIX engines skip it on trusted cross-connects — a defensible decision only when the framing is independently validated.

### CRC choice, when you design a protocol

| CRC | Use | Property |
|---|---|---|
| CRC-32 (Ethernet polynomial) | General | Detects all burst errors ≤ 32 bits, all 2-bit errors up to length 2¹⁵ |
| **CRC-32C (Castagnoli)** | **The right default** | Better Hamming distance, and **hardware-accelerated**: x86 `crc32` instruction (SSE4.2), ~3-cycle latency, 1/cycle throughput on 8 bytes |
| CRC-64 | Very large payloads | Overkill for message-sized data |

```cpp
std::uint32_t crc32c(std::uint32_t crc, const std::byte* p, std::size_t n) {
    while (n >= 8) { crc = _mm_crc32_u64(crc, load_le<std::uint64_t>(p)); p += 8; n -= 8; }
    while (n--)    { crc = _mm_crc32_u8(crc, std::to_integer<std::uint8_t>(*p++)); }
    return crc;
}
```

At roughly 8 bytes/cycle, CRC-32C over a 64-byte message is ~10 cycles — cheaper than FIX's additive checksum over the same message, and vastly stronger. **A protocol that uses a weak additive checksum in 2026 has no excuse.** Note that CRCs detect *accidental* corruption only; they are not authentication, and an attacker who can modify the payload can recompute the CRC.

---

## 51.14 Protocol Sequence Numbers

A sequence number is the mechanism by which a receiver detects **loss**, **duplication**, and **reordering** without cooperation from the transport. It is the single most important field in any market-data protocol, and its semantics are subtler than they look.

### The design dimensions

| Dimension | Options | Consequence |
|---|---|---|
| **Scope** | Per-session / per-channel / per-instrument | Per-instrument gives fine-grained recovery but requires N counters; per-channel is the norm |
| **Granularity** | Per-packet vs per-message | Per-message allows exact resend of missing messages; per-packet is cheaper |
| **Width** | 32 vs 64 bit | 32 bits at 1 M msg/s wraps in 71 minutes — **use 64** |
| **Reset point** | Never / daily / per session | Daily reset is universal; the receiver must handle it explicitly |
| **Direction** | Independent per direction | FIX and SoupBinTCP both do this |

MoldUDP64 numbers **messages**, and the packet header carries the sequence of the first message plus a count — so a receiver derives each message's number as `header.seq + index`, and a gap of *k* messages is requestable exactly. FIX numbers messages per direction. SBE-based feeds (CME MDP 3.0) put a packet-level sequence in the binary packet header and a separate per-instrument `RptSeq` inside the incremental refresh messages, enabling per-instrument gap detection (Ch. 53 §53.4).

### The receiver state machine

```
                    ┌────────────────────────────────────────┐
                    │  expected = N                          │
                    └───────────────┬────────────────────────┘
                                    │ receive seq S
        ┌───────────────────────────┼───────────────────────────┐
        │ S == N                    │ S > N                     │ S < N
        ▼                           ▼                           ▼
   ┌─────────┐              ┌───────────────┐            ┌────────────┐
   │ process │              │ GAP of S-N    │            │ DUPLICATE  │
   │ N += 1  │              │ buffer msg,   │            │ discard    │
   └─────────┘              │ start recovery│            │ (silently) │
        │                   └───────┬───────┘            └────────────┘
        │                           │ recovery fills N..S-1
        │                           ▼
        │                   ┌───────────────────┐
        └───────────────────│ drain buffer while│
                            │ head == expected  │
                            └───────────────────┘
```

The three transitions map exactly to the three failure modes, and the *buffering* of out-of-order messages is what distinguishes a correct implementation from one that discards and re-requests everything.

### Non-obvious points

- **A duplicate is not an error.** With redundant A/B feeds (Ch. 53 §53.6) every message arrives twice by design; the dedup path is the *common* path and must be branch-predictor-friendly and allocation-free. Logging every duplicate is a self-inflicted denial of service.
- **Gap detection requires traffic.** A quiet channel cannot distinguish "no updates" from "everything is being dropped." This is why MoldUDP64 sends **heartbeat packets with count = 0** that still advance nothing but prove liveness, and why the receiver must run a staleness timer (Ch. 53 §53.8) independent of sequence checking.
- **Wraparound.** With 32-bit sequences you must compare using signed difference — `(int32_t)(a - b) > 0` — which is correct across wrap, rather than `a > b`, which is not. With 64-bit sequences wraparound is not reachable; use 64 bits and delete the problem.
- **Sequence resets.** A daily reset to 1, or a FIX `SequenceReset(4)` message, is an explicit, in-band event. Code that treats "sequence went backwards" as a gap will loop forever requesting retransmission of messages that no longer exist. Handle the reset transition explicitly and log it at a level someone reads.
- **Persistence.** Order-entry sequence numbers must survive a crash (§51.1). Market-data sequence numbers generally need not — on restart you take a snapshot (Ch. 53 §53.3) — but the *checkpoint* of what you last processed matters for deterministic replay (Ch. 53 §53.9, Ch. 56 §56.2).

---

## 51.15 Gap-Fill and Replay Protocols

When a gap is detected, the receiver must obtain the missing data. The mechanism differs fundamentally between the reliable-unicast and unreliable-multicast worlds.

### FIX: ResendRequest and SequenceReset

```
Client                                   Exchange
  │  recv seq 105, expected 101              │
  │─── ResendRequest(2) 7=101 16=104 ───────►│
  │                                          │  replay from its outbound log
  │◄── ExecutionReport 34=101 43=Y 122=… ────│  PossDupFlag=Y, OrigSendingTime=122
  │◄── SequenceReset(4) 36=104 123=Y ────────│  GapFill: "skip 101..103, next is 104"
  │◄── ExecutionReport 34=104 43=Y ──────────│
```

Two distinct forms of `SequenceReset(4)`:

| `GapFillFlag(123)` | Meaning | Legitimate use |
|---|---|---|
| `Y` — **Gap Fill** | "Messages up to `NewSeqNo(36)` were administrative; skip them." | Replacing session-level messages (heartbeats) that need not be replayed |
| `N` or absent — **Reset** | "Set your expected sequence to `NewSeqNo` unconditionally." | Recovering from unrecoverable state divergence; **operationally dangerous** |

A Reset (not GapFill) silently discards application messages, which on order entry can mean losing an ExecutionReport for a real fill. Most firms alarm on it and require reconciliation against drop-copy (Ch. 54).

Replayed application messages carry `PossDupFlag(43)=Y` and `OrigSendingTime(122)`. **The receiver must treat these idempotently** (§51.2's `CumQty`-delta rule) rather than assuming it has not seen them, because a resend can overlap messages already processed.

The pathological case: a **ResendRequest loop**. Both sides gap, both request, and the responses themselves gap. Mitigation is a rate limit on outbound ResendRequests, a cap on the request window, and escalation to Logout after N failed attempts.

### Multicast market data: three recovery channels

Because UDP multicast is unreliable and one-to-many, an exchange typically offers three mechanisms simultaneously:

| Mechanism | Transport | Latency to recover | Cost to exchange |
|---|---|---|---|
| **Redundant A/B feed** | Two multicast groups, independent paths | ~0 — the other copy usually arrives first | 2× bandwidth |
| **Retransmission service** | TCP or a request/reply UDP channel, per-client | 1 RTT + service latency (ms) | Per-client state, rate-limited |
| **Snapshot / recovery feed** | A separate multicast group cycling full book images | Up to one full cycle (100 ms – 30 s) | Constant, shared by all clients |

MoldUDP64's retransmission counterpart is **MoldUDP64 Request**, a unicast UDP request carrying `(session, first_seq, count)` answered with the missing packets. Rate limits are strict — an exchange will disconnect a client that requests aggressively, because the retransmission service is a shared resource and a client in a request storm can degrade it for everyone.

### The recovery decision

```cpp
// Gap of `n` messages detected on the live incremental feed.
if (n <= kSmallGap && other_feed_has_it()) use_b_feed();          // free
else if (n <= kRetransmitMax && !rate_limited())  request_retransmit();  // ~1 ms
else                                              resync_from_snapshot(); // ~1 s, book unusable meanwhile
```

The thresholds encode a judgment: retransmission is cheaper than a snapshot for small gaps, but a large gap means the retransmit response would itself be large and slow, and a snapshot bounds the recovery time. Crucially, **while recovering, the book for the affected instrument is not trustworthy** and must be marked as such (Ch. 53 §53.8) — continuing to quote from a book with a known gap is how a correctness bug becomes a financial one.

### Replay for testing and startup

The same replay machinery serves a second purpose: a captured multicast stream (Ch. 48 §48.7) replayed through the feed handler must produce a bit-identical book at every sequence number. This is the foundation of deterministic testing (Ch. 57 §57.12) and post-incident analysis, and it constrains the design — the feed handler must be a **pure function of (input stream, reference data)**, with no dependence on wall-clock time, thread scheduling, or hash iteration order. Ch. 53 §53.9 develops this.

---

## Key Interview Questions

1. **Why does FIX put BodyLength as the second field and CheckSum last?** — It makes the message self-framing over a TCP byte stream: read to the length, consume exactly that many bytes plus the fixed-size trailer.
2. **What does a FIX engine do when it receives a sequence number lower than expected without PossDupFlag?** — Treat it as fatal: logout and escalate. The peer has lost state, and continuing risks acting on stale order information.
3. **Why is FIX heartbeating needed when TCP has keepalive?** — TCP keepalive operates on minutes-to-hours and detects only dead connections, not a peer whose application is hung; FIX TestRequest/Heartbeat gives application-level liveness at second granularity.
4. **How do you make a FIX ExecutionReport handler idempotent?** — Derive the fill increment from the `CumQty` delta rather than trusting `LastQty`; a duplicate report yields a zero delta.
5. **What is the difference between ExecType and OrdStatus?** — ExecType describes what this message reports; OrdStatus is the order's current aggregate state. A partial fill is `ExecType=F, OrdStatus=1`.
6. **Why did the industry move away from FAST?** — FAST trades bandwidth for a stateful, serial, branch-heavy decode. When links stopped being the bottleneck, its 3–5× compression stopped paying for its 0.5–2 µs decode and its dictionary-corruption-on-loss failure mode.
7. **Why is SBE fast?** — Fixed offsets known at compile time, native endianness (no swap), native alignment, fixed-then-group-then-varlen ordering, and generated code with no branching on the field-access path.
8. **How does SBE achieve version compatibility?** — `blockLength` in the message header; new fields are appended and old decoders skip to `offset + blockLength`. Never change an existing field's offset, size, or meaning.
9. **Why does OUCH use a client-assigned OrderToken?** — So a cancel can be sent before the acknowledgement arrives, removing a full round trip from worst-case cancel latency; a monotonic token also allows array-indexed correlation instead of hashing.
10. **Why are OUCH inbound messages unsequenced while outbound is sequenced?** — TCP already orders inbound, and the exchange is the authority on outcomes; the sequenced outbound stream is a replayable log the client resumes from after reconnect.
11. **What does MoldUDP64 add to ITCH?** — Session ID, 64-bit message sequence number, and message count with per-message length prefixes: all sequencing, gap detection, and recovery, cleanly separated from the payload semantics.
12. **Why must an ITCH `P` (Trade) message not modify the book?** — It reports execution against non-displayed liquidity; decrementing displayed size on it corrupts the book. `E`/`C` do modify it.
13. **What breaks if you handle ITCH `U` (Replace) by keeping the old order reference?** — The reference number changes; retaining the old one leaks map entries. Diagnostic signature: unbounded memory growth over the day with no matching increase in book depth.
14. **Why is `reinterpret_cast<const Msg*>(buffer)` wrong, and what do you do instead?** — No object was created there, the buffer may be misaligned, and it violates strict aliasing. Use per-field `memcpy` accessors (free after optimization) or C++23 `std::start_lifetime_as` when you control alignment.
15. **How do you validate an untrusted length safely?** — Check against actually-received bytes *and* protocol bounds; guard subtraction against underflow; replace `n * size` with `n > remaining / size` to avoid overflow; compare with pointer differences, never `p + n <= end`.
16. **Why is the UDP checksum insufficient for market data?** — It is a weak 16-bit one's-complement sum, optional in IPv4, and store-and-forward switches recompute the Ethernet FCS after buffering. Application sequence numbers, not checksums, are the real integrity mechanism.
17. **Why CRC-32C rather than CRC-32?** — Better Hamming distance and a hardware instruction on x86 (SSE4.2) giving roughly 8 bytes per cycle — stronger and cheaper than a byte-wise additive checksum.
18. **How do you compare 32-bit sequence numbers across wraparound?** — Signed difference: `(int32_t)(a - b) > 0`. Better: use 64 bits and eliminate the case.
19. **What are the three multicast recovery mechanisms and when do you use each?** — B-feed arbitration (free, small gaps), per-client retransmission (~1 ms, bounded gaps, rate-limited), snapshot resync (~1 s, large gaps, bounds recovery time). The book is untrustworthy until recovery completes.

---

## Common Traps

- **Parsing FIX by scanning for a tag string** — `55=` also matches inside `1055=`; always anchor on the SOH delimiter.
- **Trusting `LastQty` instead of deriving from `CumQty`** — double-counts position on duplicate ExecutionReports.
- **Keying order state on `ClOrdID` alone** — a cancel/replace mints a new ClOrdID; fills can reference an older one.
- **Treating `OrdStatus` as the event** — conflating aggregate state with the transition that this message reports.
- **Continuing to decode FAST after a gap** — the dictionary is stale; every `copy`/`delta` field is silently wrong.
- **Decrementing book size on ITCH `P` messages** — off-book prints do not touch displayed liquidity.
- **Reusing an ITCH order reference after `U`** — map leak, unbounded memory growth.
- **SoupBinTCP off-by-one** — the length field counts the type byte; `len == 0` underflows the payload size computation.
- **Handling only one message per `recv`** — unbounded latency under load, and a permanent stall with edge-triggered epoll.
- **Reading a 2-byte length without checking two bytes are present** — headers straddle `recv` boundaries.
- **Attempting to resynchronize a desynchronized length-prefixed stream** — impossible; tear down the session.
- **`n * element_size` in a bounds check** — overflows; divide instead.
- **`p + n <= end`** — computing `p + n` past the end is UB before the comparison runs; use `end - p >= n`.
- **`ntohl(*(uint32_t*)p)`** — aliasing violation plus a possibly misaligned load.
- **`#pragma pack` struct overlay with member address-taking** — UB, faults on ARM, warned by `-Waddress-of-packed-member`.
- **Retaining a view into the receive ring across a poll iteration** — the entry is recycled; corruption correlates with load and vanishes when idle.
- **Allocating in the parser** — bimodal tail latency; enforce with a `malloc` interposer that traps during the hot path.
- **Throwing on malformed messages** — malformed input is expected; use `std::expected` or an error enum.
- **Reusing a retired field's offset or a retired enum value** — silent misinterpretation with no error anywhere.
- **Treating a sequence reset as a gap** — infinite retransmission requests for messages that no longer exist.
- **Logging every duplicate on a redundant A/B feed** — duplicates are the normal case; logging them is self-inflicted overload.
- **Quoting from a book with an unrecovered gap** — a correctness bug becomes a financial one.

---

## Compact Recall Summary

**FIX session.** ASCII `tag=value|`; tags 8, 9, 35 first, 10 last, making it self-framing. Per-direction monotonic `MsgSeqNum(34)`, persisted across crashes. Heartbeat/TestRequest for application liveness; ResendRequest for gaps; higher-than-expected is a gap, lower-than-expected without `PossDupFlag` is fatal. Parse cost 1–5 µs — survives on order entry, extinct on market data.

**FIX application.** ExecutionReport (`8`) carries almost all state transitions; `ExecType(150)` is the event, `OrdStatus(39)` is the aggregate state. `ClOrdID` is client-owned and changes on every cancel/replace with `OrigClOrdID` chaining; `OrderID` is exchange-owned and stable. Derive fills from `CumQty` deltas for idempotence. Repeating groups need the data dictionary to parse.

**FAST.** Presence map + field operators (`constant`/`default`/`copy`/`increment`/`delta`/`tail`) + stop-bit varints. 3–5× compression, stateful per-template dictionary, serial decode, 0.5–2 µs. A gap corrupts the dictionary until reset — prices freeze or drift while sequences advance.

**ITCH / OUCH.** Fixed-length, big-endian, unpadded messages with a one-byte type. ITCH is broadcast order-by-order depth over MoldUDP64 (session + u64 seq + count + per-message length prefixes); `P` prints do not touch the book; `U` changes the order reference. OUCH is minimal order entry over SoupBinTCP with a **client-assigned OrderToken** enabling cancel-before-ack; inbound unsequenced, outbound a sequenced replayable log.

**SBE.** Fixed offsets, native little-endian, natural alignment, header{blockLength, templateId, schemaId, version}, then root block → groups → var-length data. 20–50 ns decode. Evolution by appending only, with old decoders skipping via `blockLength`.

**Framing.** Length-prefix, fixed-size-by-type, delimiter, or self-describing length. TCP needs framing; UDP does not, but packed multi-message datagrams reintroduce it. Loop until the buffer is drained, handle partial headers, bound the buffer, and tear down on desynchronization.

**Parsing.** Views not objects (`span`/`string_view`), preallocated and reserved containers, fixed-capacity types, index-based object pools, `std::expected` not exceptions. Zero-copy means field access reads the DMA'd bytes; per-field `memcpy` accessors are correct, alignment-agnostic, and free after optimization. Views die when the receive ring entry is recycled.

**Endianness/alignment.** Big-endian is legacy convention costing one `BSWAP`/`MOVBE` per field; SBE and modern protocols use little-endian to eliminate it. `if constexpr (std::endian::native == …)` + `std::byteswap`. Wire formats are packed, C++ structs are padded — never assume `sizeof` matches the wire.

**Validation.** Check every length against bytes actually received and against protocol bounds; guard underflow; `n > remaining / size` not `n * size > remaining`; `end - p >= n` not `p + n <= end`. Narrow into a cursor at the boundary. Fuzz the parse entry point under ASan/UBSan.

**Integrity.** Ethernet CRC-32 is per-link and recomputed by store-and-forward switches; IP/UDP/TCP checksums are weak 16-bit sums and optional in IPv4-UDP. FIX's mod-256 additive checksum cannot detect transposition. CRC-32C via SSE4.2 is stronger and cheaper. Sequence numbers, not checksums, catch the failures that actually happen.

**Sequencing and recovery.** 64-bit, per-channel, per-message where possible; explicit handling of gap (buffer + recover), duplicate (silent discard), and reset (explicit event, never a gap). Heartbeats keep gap detection alive on quiet channels. Recovery ladder: B-feed → rate-limited retransmission → snapshot resync, with the book marked untrustworthy throughout. The feed handler must be a pure function of input stream and reference data so replay is bit-identical.
