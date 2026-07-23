# Chapter 51 — Exchange Protocols

An exchange protocol is more than a list of fields. It defines where messages begin and end, how bytes become values, which side owns each identifier, what sequence and session state mean, and which malformed inputs must never reach trading state.

A fast parser that reads beyond a frame is wrong. A safe parser that applies message 104 while message 103 is missing may also be wrong. The useful design unit is therefore:

> framed bytes → validated schema → sequence decision → semantic event → state transition

This chapter develops that pipeline. Chapter 53 owns market-data recovery, snapshots, redundant feeds, and replay. Chapter 54 owns gateway connection lifecycle, order correlation, and production FIX/OUCH sessions. Here, recovery and sessions appear only far enough to define their protocol contracts.

## The 90-second version

For every protocol, write down:

1. **Transport unit:** byte stream, datagram, or another record.
2. **Frame rule:** fixed size, delimiter, length prefix, or schema-derived size.
3. **Schema discriminator:** message type, template ID, version, and session/product identity.
4. **Integer rules:** field width, signedness, byte order, alignment, scale, null sentinel, and valid range.
5. **Sequence rule:** scope, granularity, reset/wrap behavior, duplicate semantics, and gap action.
6. **Lifetime rule:** how long decoded views remain valid.
7. **Failure rule:** wait for more bytes, reject a frame, terminate a session, quarantine a channel, or request recovery.

The safe hot path is:

```text
receive bytes
  → establish one bounded frame
  → validate fixed header and schema/version
  → validate every count and variable region
  → verify integrity field if the contract has one
  → classify sequence: expected / ahead / behind / reset
  → decode semantic event
  → apply exactly once to the correct state generation
  → release the receive buffer
```

Never:

- cast network bytes to a C++ message struct;
- trust a length because the transport delivered it;
- multiply an untrusted count before checking division bounds;
- retain a `span` or `string_view` after its ring slot is recycled;
- treat an unknown enum as a familiar value;
- publish state before sequence and semantic validation complete;
- quote protocol behavior without naming the venue, product, and version.

### Label the source of truth

The same protocol name can describe a standard, a family, or one venue dialect. Use explicit labels:

- **Protocol guarantee:** behavior required by a named normative specification, such as FIX TagValue’s `BodyLength(9)` definition.
- **Venue rule:** a venue’s rules of engagement, including required fields, disconnect policy, throttles, and session schedule.
- **Product/version:** the exact feed or order-entry product, interface revision, schema, and effective date.
- **Transport/session product:** framing, login, heartbeat, sequencing, and replay envelope paired with the application messages.
- **Implementation choice:** buffering, dispatch, data structures, and optimizations selected by your software.
- **Measured:** a result tied to exact bytes, build, compiler, CPU, workload, sample count, and statistic.

“ITCH messages are big-endian” is too broad. “The integer encoding in the named TotalView-ITCH specification revision is big-endian” is auditable. “SBE is native-endian” is wrong as a generalization: the schema declares byte order and generated codecs implement that contract.

## Core: wire design to state integration

## 51.1 Separate transport, session, and application roles

Three layers often travel together but answer different questions:

| Layer | Questions it answers | Examples |
|---|---|---|
| Transport/framing | Where are the bytes and message boundaries? | TCP byte stream, UDP datagram, length-prefixed session envelope |
| Session | Who is connected, alive, authenticated, and at which sequence? | FIX session, a venue login/heartbeat/replay envelope |
| Application | What business event or intent does the message represent? | Add order, trade, cancel, execution report |

TCP provides an ordered byte stream, not application message boundaries. One `recv()` may return half a header, one message, or several messages. UDP preserves datagram boundaries but a product may pack several length-prefixed messages inside one datagram.

A session heartbeat proves only what its contract says. It may establish that the peer or channel emitted a liveness record; it does not prove that every application message arrived, that downstream state is current, or that the peer’s business logic is healthy.

Application handlers should receive typed, validated events rather than raw frames. A session engine should not infer order state, and an order book should not parse transport lengths. The separation permits independent fuzzing, replay, and failure handling.

### Text versus binary

Text and binary are design choices, not synonyms for slow and fast.

| Property | Delimited/tag-value text | Fixed/schema-driven binary |
|---|---|---|
| Human inspection | Often direct | Usually needs schema/tool |
| Unknown fields | Can sometimes be skipped by tag | Depends on frame/schema evolution rules |
| Integer conversion | Digit scan, sign/range checks | Fixed-width load, byte-order conversion |
| Missing/duplicate fields | Requires schema validation | Often structural or bitmap-driven |
| Size | Depends on values and tags | Often compact and predictable |
| Random field access | Tag index or scan | Fixed offsets for fixed block |
| Evolution | New tags can be ignorable under rules | Version/block-length/template mechanisms |
| Failure risk | Ambiguous delimiters, duplicate tags, invalid digits | Length/count overflow, wrong schema, alignment assumptions |

Text can be appropriate for lower-rate, flexible, operationally visible order flow. Binary can be appropriate for high-rate, stable-schema data. Measure the named implementation. A binary decoder with branches, copies, and allocation can lose to a carefully indexed text decoder; a text protocol’s semantic flexibility can be worth its parse cost.

## 51.2 Framing is the first security boundary

Four common frame designs are:

1. **Fixed size:** message type or channel implies a constant frame length.
2. **Length prefix:** a fixed header contains the frame/body length.
3. **Delimiter:** a sentinel terminates a message or field.
4. **Schema-derived:** header identifies a template whose fixed and variable regions determine total length.

A robust length-prefixed stream parser has two states:

```text
NEED_HEADER
  if fewer than header bytes: wait
  else decode length without unaligned/native cast
       reject length outside protocol bounds
       transition to NEED_BODY(length)

NEED_BODY(length)
  if fewer than length bytes: wait, subject to buffer/time limit
  else narrow to exactly one frame
       parse it
       consume exactly its encoded size
       return to NEED_HEADER and continue
```

Always loop: one read may contain many frames. Bound incomplete-frame buffering and time. On a stream, an impossible length may destroy synchronization; searching for a plausible next header can transform attacker-controlled payload bytes into a fake message. Unless the product defines a resynchronization marker and algorithm, terminate the session.

### Length semantics must be written as an equation

“Length” might mean:

- bytes after the length field;
- bytes including the header;
- application payload only;
- bytes from a fixed-block start through variable data;
- number of messages rather than bytes.

For each envelope, state:

\[
\text{total encoded bytes} =
\text{prefix bytes} + \text{declared region} + \text{trailer bytes}
\]

Then test minimum, maximum, zero, one-byte-short, one-byte-long, and concatenated frames.

The frame length is not proof that inner counts fit. Every nested group and string needs its own validation against the already-bounded parent.

### Datagrams can contain an inner stream

UDP supplies one datagram boundary, but that boundary may contain:

```text
packet header {session, first_sequence, message_count}
  + length-prefixed message 0
  + length-prefixed message 1
  + ...
```

Validate both levels. The outer datagram length bounds the entire cursor. The declared message count must be possible within the remaining bytes. Each inner length must fit, and after the declared count the cursor must end exactly where the product permits. Decide explicitly whether padding or trailers are legal.

Do not read beyond the datagram to “finish” an inner message. Unlike a TCP partial frame, a truncated UDP datagram cannot be completed by the next datagram under normal datagram semantics. It is malformed or lost according to the product.

If a packet header gives the first sequence and a message count, derive per-message sequences only after proving the count and every inner frame. Avoid advancing channel state from the header before the messages validate. A valid header surrounding a corrupt third message may require the whole packet to be rejected or only that message to be quarantined; that is a product rule.

## 51.3 Endianness, alignment, and object representation

A wire integer has explicit width, signedness, and byte order. Decode those bytes into a C++ value. Do not make the buffer pretend to contain a C++ object.

Unsafe:

```cpp
auto* message = reinterpret_cast<const WireMessage*>(bytes.data());
```

That can fail because:

- the address may not meet `WireMessage` alignment;
- padding may differ from the wire;
- member byte order may differ;
- no suitable C++ object may exist there;
- a packed struct can still create misaligned member accesses;
- compiler aliasing and lifetime rules do not become network rules.

Properties such as trivial copying or unique object representations do not prove that native object bytes are a correct serialization. They say nothing about wire byte order, schema offsets, protocol padding, validation, or lifetime.

Safe decoders use one of:

- explicit byte accumulation;
- `std::memcpy` into an integer followed by a declared byte swap;
- generated accessors that implement the schema;
- carefully verified vectorized loads into local values.

C++23 `std::byteswap` is useful after a valid load, but the protocol—not the host—selects whether swapping is required. `std::endian::native` describes the implementation’s scalar byte order, not the wire.

Alignment is an optimization after correctness. A receive ring can align its frame starts, but a variable-length preceding frame may leave an inner field unaligned. If an optimized path requires alignment, prove it from the complete envelope and schema, assert it in debug/testing, and retain a safe fallback.

## 51.4 Schema and version evolution

Every frame needs enough context to select the correct schema. That may include:

- session or product identity;
- message type/template ID;
- schema ID;
- schema version;
- fixed-block length;
- negotiated feature set;
- effective date or channel configuration.

An unknown message type is not padding. The product may permit skipping it using a trustworthy frame length, or require disconnect/recovery. An unknown enum must become `Unknown(raw_value)` or a protocol error; mapping it to a default business action is unsafe.

Useful evolution rules include:

- never change the meaning, width, scale, or signedness of an existing field in place;
- append fixed fields when the version mechanism supports it;
- reserve and document identifiers without reusing retired meanings;
- make new optional data skippable with a bounded length;
- keep golden vectors for every supported version;
- deploy decoders before encoders that emit the new form;
- record schema identity with captures and journals.

Maintain an explicit compatibility matrix:

| Encoder | Decoder | Expected result |
|---|---|---|
| old | old | Golden baseline |
| new, old fields only | old | Identical semantics |
| new, new optional fields | old | Safely skipped or explicitly rejected |
| old | new | Missing new fields become specified null/default |
| unknown future type | current | Skip or reject exactly as envelope contract states |

Test byte vectors, not only round trips generated by the same library. An encoder and decoder can share the same bug and pass a round-trip test. Golden vectors should include values at signed/unsigned limits, scale boundaries, null sentinels, empty/max groups, unknown enums, and truncated data.

Schema rollout also changes operations. Generated codec version, schema hash, negotiated version, and product effective time belong in logs and capture metadata. A rolling deployment needs an explicit point at which the encoder may begin emitting the new form. Rollback must not reuse a session whose peer now expects incompatible state.

### SBE as a versioned binary example

Simple Binary Encoding is a schema and codec model, not an exchange session. A common SBE message header identifies:

- `blockLength`: encoded length of the root fixed block;
- `templateId`: message template;
- `schemaId`: schema family;
- `version`: acting schema version.

The exact header type and integer widths are schema choices. Generated decoders use the acting block length/version to decide which fields are present. The encoded order is the root fixed block, repeating groups in schema order, then variable data in schema order. Access order matters for streaming flyweights.

SBE can make fixed-field access predictable, but the outer transport still needs framing unless its record boundary supplies it. Generated code must still receive the correct buffer limit, schema, and acting values. “Generated” does not mean hostile-input validation can be skipped.

### FAST as a stateful encoding example

FIX Adapted for STreaming uses templates, presence maps, stop-bit entities, and field operators such as constant, default, copy, increment, delta, and tail. Some values are reconstructed from prior dictionary state rather than appearing in full.

That reduces wire redundancy for suitable streams but creates a dependency:

\[
\text{decoded value}_n =
f(\text{wire value}_n,\text{template},\text{dictionary}_{n-1})
\]

A missing message, wrong template state, or incorrect reset can corrupt later decoding even when later bytes are intact. The surrounding product must define template distribution, reset, sequencing, and recovery. Chapter 53 covers how a feed returns to a trustworthy state.

Do not attach a universal compression ratio or decode latency to FAST or SBE. Schema, values, generator, CPU, branch behavior, and memory layout determine measured results.

## 51.5 Representative market-data and order-entry families

Names such as ITCH and OUCH refer to versioned venue products, not one eternal wire contract.

### ITCH-style market data

A named TotalView-ITCH product revision can illustrate an order-level incremental feed:

```text
session/transport envelope
  → message length
  → one-byte application type
  → fixed-layout fields in product byte order
  → application event: add / execute / cancel / delete / replace / trade / state
```

The feed represents a state machine. A parser should produce events such as:

```text
Add(order_ref, instrument, side, price, quantity)
Execute(order_ref, executed_quantity, match_id)
Cancel(order_ref, canceled_quantity)
Delete(order_ref)
Replace(old_ref, new_ref, price, quantity)
```

Which message types affect displayed book state is a **product/version rule**. A trade-report message may describe non-displayed activity and not mutate the displayed book. A replace may allocate a new order reference. Implement from the exact specification and golden traces, not from the family name.

Market-data application messages may rely on a separate transport/session envelope for sequence numbers and message counts. Keep envelope sequence from application timestamps or order references; they serve different invariants.

### OUCH-style order entry

A named OUCH revision can illustrate compact request/response order entry:

- client-to-venue messages express enter, replace, cancel, or related intent;
- venue-to-client messages report acceptance, execution, cancellation, rejection, and system events;
- fixed-width identifiers permit correlation;
- an outer session product can provide login, heartbeats, framing, sequence/resume, and replay.

Whether input, output, or both directions are sequenced; whether tokens can be reused; and which fields identify replacement chains are venue/product/version rules. The key design lesson is the separation between a minimal binary application message and the session envelope around it.

### Comparison without a vendor catalog

| Family | Primary role | Encoding/state characteristic | Context required before parsing |
|---|---|---|---|
| FIX TagValue | Session plus broad application vocabulary | Delimited tag-value; dictionary-driven validation | FIX/FIXT version, application version, venue rules |
| FAST | Compression/encoding for templated streams | Presence maps, stop-bit values, stateful operators | Template set, dictionary/reset context, framing |
| ITCH-style | Venue market-data application feed | Product-specific fixed binary messages | Product revision, envelope/channel, byte order |
| OUCH-style | Venue order-entry application protocol | Product-specific compact binary messages | Product revision and paired session product |
| SBE | Schema-driven binary encoding | Fixed root block plus ordered groups/variable data | Schema ID/version, template, block length, outer frame |

The families solve different layers. Comparing “FIX versus SBE” without saying whether the topic is session behavior, business vocabulary, or encoding is a category error.

## 51.6 FIX as the text/session contrast

FIX TagValue encodes `tag=value` fields separated by SOH (`0x01`). Human-readable examples often replace SOH with `|`, but a production parser must use the actual delimiter.

```text
8=FIXT.1.1|9=...|35=D|34=...|49=...|56=...|...|10=...|
```

Under the FIX TagValue encoding:

- `BeginString(8)` is first;
- `BodyLength(9)` is second;
- `MsgType(35)` begins the standard header after those framing fields;
- `CheckSum(10)` is last.

`BodyLength(9)` counts octets from immediately after the SOH terminating field 9, through and including the SOH terminating the field immediately before field 10. It does not count `8=...<SOH>`, `9=...<SOH>`, or `10=ddd<SOH>`.

`CheckSum(10)` is the modulo-256 sum of every octet from the start of the message through the SOH immediately before field 10, encoded as three decimal digits. It is an accidental-corruption check, not cryptographic authentication and not a substitute for field, length, or sequence validation.

### Bounded FIX framing and field parsing

A stream decoder:

1. validates the exact `8=` and `9=` placement under its negotiated encoding;
2. scans only within a small configured header bound for the SOH ending field 9;
3. parses BodyLength as bounded decimal with overflow checks;
4. waits for exactly the calculated body plus the fixed TagValue checksum field;
5. verifies field 10 placement and checksum;
6. parses fields anchored on SOH boundaries—never substring-searches for `55=` inside `1055=`;
7. validates required, duplicate, repeating-group, type, scale, and range rules from the correct dictionary/version.

Repeating groups are not parseable from delimiters alone. A count field and dictionary define the first tag and field order of each entry. The count is hostile input and must be bounded by both a product maximum and remaining fields.

Text values still need binary-grade bounds. For an unsigned decimal:

```text
value = 0
for each digit d:
    reject non-digit
    reject if value > (maximum - d) / 10
    value = value * 10 + d
```

Signed values must handle the negative limit without first negating a value that cannot be represented. Fixed-point price fields need a declared scale and rounding rule; avoid routing through floating point unless the protocol and application explicitly accept that conversion.

A duplicate tag can mean error, repeating data, or a dialect-defined override. Do not silently use “first wins” or “last wins.” Required-tag presence and conditional requirements are schema rules. For performance, one pass can build a fixed-size tag index for the subset needed by the hot handler, but it must still detect prohibited duplicates and malformed fields.

### FIX session semantics

Each direction has its own next outgoing and next expected incoming `MsgSeqNum(34)`. Persistence, reset negotiation, and behavior across reconnects follow the FIX session specification plus venue rules.

For a received sequence \(S\) and expected sequence \(N\):

- \(S=N\): validate/process under the normal state.
- \(S>N\): a gap exists; issue the specified resend behavior and enter a gap state.
- \(S<N\): apply the FIX rules for `PossDupFlag(43)`, `OrigSendingTime(122)`, and Sequence Reset exceptions; a too-low original message normally terminates the session under the current FIX session specification.

The standard describes alternative strategies for messages arriving beyond a gap. Do not invent “always buffer” or “always discard”; implement the named session specification, rules of engagement, resource bound, and idempotence contract.

Administrative messages include Logon, Logout, Heartbeat, TestRequest, ResendRequest, Reject, and SequenceReset. `HeartBtInt(108)` is negotiated in Logon; heartbeat/test timing and disconnect tolerances are session/version/venue behavior, not a universal percentage.

On replay, FIX application messages use original sequence numbers with `PossDupFlag(43)=Y` and `OrigSendingTime(122)` as specified. Administrative messages that are not replayed can be represented by a `SequenceReset(35=4)` gap fill. Gap fill and unconditional reset have different safety implications; never treat a reset as an ordinary missing message.

### FIX application semantics

Representative application messages include NewOrderSingle, cancel/replace requests, ExecutionReport, and cancel reject. Exact required/allowed fields depend on FIX application version and venue rules.

For ExecutionReport:

- `ExecType(150)` describes what the report communicates;
- `OrdStatus(39)` describes aggregate order state;
- `ClOrdID(11)` is client-assigned;
- `OrderID(37)` is venue-assigned;
- `ExecID(17)` identifies an execution/report event under the dialect;
- `CumQty(14)`, `LeavesQty(151)`, `LastQty(32)`, and related fields have version/dialect semantics.

Do not derive fills from one field without the venue’s correction/bust/restate rules. Idempotence may use ExecID, cumulative-quantity transitions, session sequence, and business dates together. Chapter 54 owns the production order-state integration.

## 51.7 Sequence classification before state mutation

A sequence number is meaningful only after defining:

- scope: connection, channel, partition, instrument, or session;
- unit: packet, message, event, or byte;
- direction;
- width and wrap arithmetic;
- initial/reset point;
- whether heartbeats consume numbers;
- duplicate and replay flags;
- recovery semantics.

Do not impose “64-bit monotonic forever” on a venue protocol with a 32-bit daily sequence. Implement the specified modular/reset rules. Locally normalize into a wider epoch-plus-sequence identity if that simplifies replay, but preserve raw values.

### Minimal state machine

```text
expected = N

receive frame with sequence S
  if S == N:
      validate semantics
      apply exactly once
      expected = next(S)
      drain any already-validated contiguous pending frames

  if S is ahead of N under the protocol's ordering rule:
      mark state NOT_CURRENT
      record missing interval [N, S)
      retain or reject S according to bounded policy
      signal recovery coordinator

  if S is behind N:
      classify duplicate/replay/reset using protocol flags and epoch
      do not apply as a new event

  if explicit reset/session change:
      transition generation under product rules
      never infer reset merely from a smaller integer
```

The parser should not own an unbounded pending map. It returns a sequence classification and immutable event/view. A channel coordinator owns bounded pending storage and recovery state. Chapter 53 develops that coordinator for feeds.

### Heartbeats and quiet channels

Sequence gaps are observable only when a later sequence arrives. A quiet channel cannot distinguish silence from a disconnected source using sequence comparison alone. Session heartbeats, product liveness messages, transport health, and staleness timers address this, each at a named layer.

A heartbeat with no application event should not be manufactured into a book update. Record liveness and sequence behavior separately.

## 51.8 A bounded C++23 binary parser

This parser decodes a deliberately small teaching protocol, **BookWire v1**. It is not a venue format.

```text
offset  size  field
0       2     body_length, big-endian; bytes after this prefix
2       1     version = 1
3       1     type = 'A' (snapshot rows) or 'D' (delete rows)
4       8     channel sequence, big-endian
12      2     row_count, big-endian
14      ...   row_count rows: instrument u32 + quantity u32, big-endian
```

The body is at least 12 bytes and at most 4,096 bytes. Its exact size must be `12 + row_count × 8`. The outer stream parser may pass partial bytes; `NeedMore` is not a malformed frame.

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

enum class ParseError {
    none,
    need_more,
    body_too_small,
    body_too_large,
    unsupported_version,
    unknown_type,
    count_mismatch
};

class Cursor {
public:
    explicit Cursor(std::span<const std::byte> bytes) : bytes_(bytes) {}

    bool u8(std::uint8_t& out) {
        if (remaining() < 1) return false;
        out = std::to_integer<std::uint8_t>(bytes_[position_++]);
        return true;
    }

    bool be16(std::uint16_t& out) {
        if (remaining() < 2) return false;
        out = static_cast<std::uint16_t>(
            (value(position_) << 8) | value(position_ + 1));
        position_ += 2;
        return true;
    }

    bool be32(std::uint32_t& out) {
        if (remaining() < 4) return false;
        out = (value(position_) << 24) |
              (value(position_ + 1) << 16) |
              (value(position_ + 2) << 8) |
              value(position_ + 3);
        position_ += 4;
        return true;
    }

    bool be64(std::uint64_t& out) {
        if (remaining() < 8) return false;
        out = 0;
        for (int i = 0; i < 8; ++i) {
            out = (out << 8) | value(position_ + static_cast<std::size_t>(i));
        }
        position_ += 8;
        return true;
    }

    [[nodiscard]] std::size_t remaining() const {
        return bytes_.size() - position_;
    }

private:
    std::uint32_t value(std::size_t index) const {
        return std::to_integer<std::uint8_t>(bytes_[index]);
    }

    std::span<const std::byte> bytes_;
    std::size_t position_{};
};

struct MessageView {
    std::uint8_t type{};
    std::uint64_t sequence{};
    std::uint16_t row_count{};
    std::span<const std::byte> encoded_rows{};
    std::size_t consumed_bytes{};
};

struct ParseResult {
    ParseError error{ParseError::none};
    MessageView message{};
};

struct Row {
    std::uint32_t instrument{};
    std::uint32_t quantity{};
};

std::optional<Row> row_at(const MessageView& message, std::size_t index) {
    constexpr std::size_t row_size = 8;
    if (index >= message.row_count) return std::nullopt;
    const auto row_bytes = message.encoded_rows.subspan(index * row_size,
                                                         row_size);
    Cursor cursor(row_bytes);
    Row row;
    if (!cursor.be32(row.instrument) || !cursor.be32(row.quantity)) {
        return std::nullopt;
    }
    return row;
}

ParseResult parse_one(std::span<const std::byte> input) {
    constexpr std::size_t prefix_size = 2;
    constexpr std::size_t fixed_body_size = 12;
    constexpr std::size_t row_size = 8;
    constexpr std::size_t maximum_body_size = 4'096;

    if (input.size() < prefix_size) {
        return {.error = ParseError::need_more};
    }

    Cursor prefix(input.first(prefix_size));
    std::uint16_t body_size{};
    if (!prefix.be16(body_size)) {
        return {.error = ParseError::need_more};
    }
    if (body_size < fixed_body_size) {
        return {.error = ParseError::body_too_small};
    }
    if (body_size > maximum_body_size) {
        return {.error = ParseError::body_too_large};
    }
    if (input.size() - prefix_size < body_size) {
        return {.error = ParseError::need_more};
    }

    const auto body = input.subspan(prefix_size, body_size);
    Cursor cursor(body);
    std::uint8_t version{};
    std::uint8_t type{};
    std::uint64_t sequence{};
    std::uint16_t count{};
    if (!cursor.u8(version) || !cursor.u8(type) ||
        !cursor.be64(sequence) || !cursor.be16(count)) {
        return {.error = ParseError::body_too_small};
    }
    if (version != 1) {
        return {.error = ParseError::unsupported_version};
    }
    if (type != static_cast<std::uint8_t>('A') &&
        type != static_cast<std::uint8_t>('D')) {
        return {.error = ParseError::unknown_type};
    }

    // Divide before multiplying: an untrusted count cannot overflow the check.
    if (count > cursor.remaining() / row_size ||
        static_cast<std::size_t>(count) * row_size != cursor.remaining()) {
        return {.error = ParseError::count_mismatch};
    }

    return {
        .error = ParseError::none,
        .message = {
            .type = type,
            .sequence = sequence,
            .row_count = count,
            .encoded_rows = body.last(cursor.remaining()),
            .consumed_bytes = prefix_size + body_size
        }
    };
}

int main() {
    constexpr std::array valid{
        std::byte{0x00}, std::byte{0x14}, // body = 20
        std::byte{0x01}, std::byte{'A'},
        std::byte{0x00}, std::byte{0x00}, std::byte{0x00}, std::byte{0x00},
        std::byte{0x00}, std::byte{0x00}, std::byte{0x00}, std::byte{0x2A},
        std::byte{0x00}, std::byte{0x01}, // one row
        std::byte{0x00}, std::byte{0x00}, std::byte{0x00}, std::byte{0x07},
        std::byte{0x00}, std::byte{0x00}, std::byte{0x00}, std::byte{0x64}
    };

    const auto parsed = parse_one(valid);
    assert(parsed.error == ParseError::none);
    assert(parsed.message.sequence == 42);
    const auto row = row_at(parsed.message, 0);
    assert(row.has_value());
    assert(row->instrument == 7);
    assert(row->quantity == 100);

    assert(parse_one(std::span{valid}.first(valid.size() - 1)).error ==
           ParseError::need_more);

    auto forged_count = valid;
    forged_count[13] = std::byte{0x02};
    assert(parse_one(forged_count).error == ParseError::count_mismatch);

    constexpr std::array oversized{
        std::byte{0x10}, std::byte{0x01} // 4,097 > configured maximum
    };
    assert(parse_one(oversized).error == ParseError::body_too_large);
}
```

Why it is safe:

- every read checks `remaining()` before indexing;
- the prefix is decoded before any body access;
- subtraction is performed only after proving the prefix exists;
- the declared body is capped before buffering/decoding;
- the count is checked by division before multiplication;
- the parser narrows to exactly one body;
- unknown version/type does not enter semantic logic;
- no allocation, exception, cast overlay, or unaligned typed load occurs.

`MessageView::encoded_rows` borrows the input. It dies when the receive buffer is reused. An event crossing a queue must either keep ownership of that buffer, copy the required fields into an owning event, or use a pool/reference protocol that prevents recycle.

This toy protocol has no checksum and no sequence-reset message; claiming otherwise would be schema invention. A production parser adds exactly the integrity and session rules in its named specification.

## 51.9 Integrate parser, sequence, and state safely

The fastest safe boundary is often an owning, compact semantic event:

```text
receive-ring view
  → validate/decode
  → sequence classifier
  → copy required scalar fields into Event
  → bounded SPSC queue
  → state owner applies Event
```

That is one deliberate copy, not a failure of “zero copy.” It breaks the receive-buffer lifetime dependency and can simplify thread ownership.

If the same thread parses and applies before recycling the ring slot, a borrowed view may be safe. Document:

- who owns the backing bytes;
- which operation releases them;
- whether nested strings/groups are views;
- whether callbacks may retain them;
- what happens on gap buffering.

### State publication invariant

Use a two-phase rule:

1. **Validate without mutation:** framing, schema, values, integrity, sequence classification, and semantic invariants.
2. **Commit once:** apply the event to a single owner’s state and then advance/publish the applied sequence.

Never advance `expected` before the state transition succeeds. Never publish the new book pointer and later discover that a nested count was invalid. For multi-field updates, apply to private state or an undo-safe transaction boundary, then publish the generation.

On malformed input, retain:

- channel/session/product/version;
- raw sequence and frame offset;
- bounded byte sample or capture reference;
- exact parse error;
- expected parser state;
- action taken.

Logging must be rate-limited and off the critical path. An attacker or corrupt channel can otherwise turn error reporting into overload.

### Failure actions are part of the parser API

Do not reduce every failure to `false`. The caller needs to distinguish:

| Result | Meaning | Possible caller action |
|---|---|---|
| `need_more` | Valid prefix so far on a byte stream | Retain bounded partial bytes and read again |
| malformed frame | Complete bytes violate framing/schema | Reject, count, capture bounded evidence |
| unsupported version/type | Structurally valid but no decoder | Skip only if the protocol permits; otherwise terminate/quarantine |
| integrity failure | Covered bytes do not match trailer | Reject and mark sequence/channel consequences |
| sequence ahead | Valid frame reveals missing range | Mark not current and notify recovery coordinator |
| duplicate/replay | Valid old identity under declared semantics | Deduplicate/idempotently reconcile |
| resource limit | Frame/pending/group exceeds local contract | Apply declared backpressure or fail closed |

The transport caller owns `need_more`; the sequence coordinator owns gap states; the business-state owner owns semantic rejection. Keeping errors typed prevents a malformed frame from masquerading as network loss and prevents an unsupported version from being “recovered” forever.

## 51.10 Cost models: copies, branches, bounds, and queues

Optimization begins with a model and a measurement boundary.

### Copies

For \(N\) bytes and measured effective copy bandwidth \(B_{\text{eff}}\):

\[
T_{\text{copy}} \approx C_{\text{fixed}} + \frac{N}{B_{\text{eff}}}
\]

This is a model, not a universal latency. Cache state, alignment, write allocation, non-temporal stores, NUMA, and overlap change \(B_{\text{eff}}\). Copying a few needed scalars can be cheaper than retaining a large receive buffer or bouncing ownership across cores.

Count copies by boundary:

```text
NIC DMA → receive storage        device transfer, not a CPU memcpy
receive storage → parser        often a view
parser → owning event            selected-field copy
event → state                    scalar stores
journal/capture                  separate durability/observability path
```

“Zero copy” must name which copy was removed. It does not mean zero data movement.

### Allocation-free is a resource contract

An allocation-free steady-state parser should state what was provisioned:

- maximum frame and partial-stream buffer;
- maximum group count;
- pending-gap capacity;
- event pool/queue capacity;
- fixed tag-index size;
- capture/error-record budget.

Avoiding `new` inside the decode function is insufficient if an error string, map insertion, callback, metrics label, or queue growth allocates. Test with a counting memory resource or allocator hook around the declared hot path. A local fixed-capacity structure must report exhaustion; overwriting an older order or pending sequence is not a safe fallback.

Preallocation shifts failure to startup or admission, which is often desirable, but configured maxima must follow the venue schema and workload. A protocol maximum can still be too large for a local latency budget; in that case reject the session/product configuration explicitly rather than accepting it and failing midstream.

### Branches

For message types \(i\) with probability \(p_i\), path cost \(C_i\), and a measured misprediction contribution:

\[
E[C] \approx \sum_i p_i C_i + C_{\text{mispredict}}
\]

A `switch` can compile as a jump table, decision tree, or comparisons. A table of function pointers can trade branch prediction for an indirect branch and instruction-cache behavior. Measure with the real type distribution. Put common valid cases on the straight path, but keep malformed checks mandatory.

Branchless code is not automatically faster or safer. Computing all paths can add work and can access data that should have remained behind a bounds check.

### Bounds

Bounds checks can be cheap when they narrow the domain:

1. prove fixed header available;
2. decode and cap frame length;
3. create a `span` of exactly that frame;
4. prove count using `count <= remaining / element_size`;
5. create a subspan for exactly the repeated region.

After inlining, compilers can eliminate repeated checks implied by the narrowed spans. Inspect optimized code, but never delete a check merely because a benchmark used trusted input.

Fuzz and sanitizer runs should exercise the same boundary function, not a simplified “safe parser” compiled only for tests. Useful properties include:

- the parser never reads or writes outside the supplied span;
- it always terminates for every finite input;
- `need_more` occurs only for a prefix that could become valid;
- success consumes a positive, bounded number of bytes;
- decoding then re-encoding canonical messages matches golden bytes where canonicalization is defined;
- malformed input cannot mutate application state;
- allocation and logging stay within their declared budgets.

Differential tests against an independently implemented reference decoder can find endian, null, and group-order mistakes. Treat disagreement as an investigation, not automatic proof that the faster decoder is wrong.

### Queues

A queue adds ownership transfer, possible cache-line movement, capacity policy, and waiting. With \(n\) items ahead and sustainable service rate \(\mu\), the FIFO waiting lower-bound model is:

\[
W_{\text{queue}} \gtrsim \frac{n}{\mu}
\]

Real waiting includes service-time variation, batching, scheduling, and contention. Measure enqueue-to-dequeue timestamps under representative load.

Define overflow behavior:

- block/backpressure;
- reject/drop newest;
- overwrite/drop oldest;
- mark state invalid and recover;
- terminate session.

The correct policy differs for order intent, execution reports, and stale market data. Silent overwrite is not a generic low-latency solution.

## 51.11 Checksums, CRCs, and validation layers

Integrity checks protect different scopes:

| Mechanism | Scope | Does not establish |
|---|---|---|
| Ethernet FCS | One link/frame under Ethernet rules | End-to-end application identity or sequence completeness |
| IP/UDP/TCP checksum | Named network/transport packet semantics | Business validity, freshness, cryptographic authenticity |
| FIX CheckSum | FIX TagValue encoded message | Strong corruption detection or authentication |
| Product CRC | Bytes covered by its exact polynomial/init/reflection/final-XOR contract | Correct schema or sequence |
| MAC/signature | Authenticated bytes and key identity | Application semantic correctness |
| Sequence number | Missing/duplicate/order evidence in its scope | Byte integrity inside a received frame |

“CRC-32” and “CRC-32C” are different algorithms. Record polynomial convention, initial value, reflection, final XOR, byte coverage, and test vectors. Hardware instructions support only particular variants and platforms; select the implementation at build/runtime without changing the wire result.

Verify integrity before publishing semantics. Still validate lengths before checksum traversal so a corrupt length cannot drive an out-of-bounds read.

## 51.12 Worked parser and sequence trace

Assume BookWire v1 from §51.8. The channel starts with `expected=42`, empty state, and a pending capacity of two frames. The product contract for this exercise permits bounded buffering while a separate coordinator recovers a gap.

```text
arrival  frame result                  sequence result        state/action
------   ---------------------------   ---------------------  --------------------------
1        valid A, seq=42, one row      expected               apply (7 → 100); expected=43
2        valid A, seq=44, one row      ahead: missing [43,44) mark NOT_CURRENT; retain 44
3        valid A, seq=44, one row      duplicate pending      ignore; duplicate_count++
4        body length valid, count=2,
         only one encoded row          parse error            reject; state unchanged
5        valid D, seq=43, one row      expected/recovered     apply delete 7; expected=44
6        retained valid A, seq=44      now contiguous         apply new row; expected=45
```

The important ordering is:

- arrival 4 never reaches sequence logic because structural validation fails;
- arrival 2 does not update visible book state while sequence 43 is absent;
- arrival 3 is a duplicate of pending data, not a second state event;
- sequence advances only after its semantic transition commits;
- the channel becomes current only after all required contiguous events are applied under the exercise contract.

### Hostile boundary trace

For arrival 4, the parser has a 20-byte declared body:

1. fixed body consumes 12 bytes;
2. 8 bytes remain;
3. untrusted `count=2`;
4. `2 > 8 / 8`, so `count_mismatch`;
5. no `2 × 8` address or subspan is formed;
6. no row, sequence, or book state is published.

That order prevents integer overflow, out-of-bounds access, and partial mutation.

### Reproducible parser benchmark record

If this parser is benchmarked, every result must include:

- exact valid/malformed/type distribution and frame bytes;
- whether inputs are hot, streaming, or larger than cache;
- compiler, flags, CPU, frequency policy, and source revision;
- whether `assert` self-tests are excluded from timing;
- independent run count and statistic/distribution;
- allocation count;
- bytes and messages per second;
- malformed-path result and fuzz/sanitizer status.

Do not publish a context-free “nanoseconds per message.” The named input mix and branch distribution are part of the parser.

## Skippable reference

## 51.13 Gap fill and replay boundary

This chapter classifies gaps; Chapter 53 owns feed recovery.

Typical protocol mechanisms include:

- redundant live channels;
- bounded retransmission request/response;
- snapshot plus queued incrementals;
- replay from a persisted session log;
- FIX ResendRequest and SequenceReset-GapFill.

The protocol defines request fields and sequence meaning. System design defines rate limits, pending capacity, trustworthy/untrustworthy state, escalation, and reconciliation. Never continue trading from known-incomplete state merely because the parser still accepts bytes.

## 51.14 Gateway-session boundary

Chapter 54 owns:

- reconnect/login orchestration;
- outbound sequence persistence;
- order identifier maps;
- cancel/replace/execution races;
- replay idempotence and drop copy;
- throttling and backpressure;
- reconciliation after ambiguous disconnect.

This chapter’s parser must preserve enough identity—session generation, raw sequence, application identifiers, version, and duplicate/replay flags—for that gateway logic to be correct.

## 51.15 Primary references

- FIX Trading Community, [FIX TagValue Encoding](https://www.fixtrading.org/standards/tagvalue-online/): field order, BodyLength, and CheckSum encoding.
- FIX Trading Community, [FIX Session Layer](https://www.fixtrading.org/standards/fix-session-layer-online/): sequence, resend, duplicate, reset, heartbeat, and session behavior.
- FIX Trading Community, [FAST specification](https://www.fixtrading.org/standards/fast-online/): templates, presence maps, field operators, dictionaries, and transfer encoding.
- Real Logic/Aeron project, [SBE C++ User Guide](https://github.com/aeron-io/simple-binary-encoding/wiki/Cpp-User-Guide): header, acting version/block length, group order, and variable data.
- The exact venue-published ITCH/OUCH product specifications and revision notices used by the deployment.

Archive specifications with captures and generated codecs. A current web page is not evidence for a historical session.

## Recall card

- Transport frames bytes; session manages identity/liveness/sequence; application carries business meaning.
- TCP is a byte stream. Parse zero, one, or many frames per read.
- Define total frame bytes as an equation and bound before buffering.
- Decode explicit widths/byte order; never cast wire bytes to a message struct.
- A C++ representation trait does not prove wire compatibility.
- Select schema by product, version, template/type, and session context.
- Unknown values remain unknown or cause the specified error; never map to a business default.
- FAST reconstruction depends on template and dictionary state.
- SBE uses acting block length/version and ordered groups/variable data.
- FIX BodyLength and CheckSum have exact octet boundaries.
- Sequence scope, unit, direction, reset, and duplicate semantics are one contract.
- Validate completely, classify sequence, then commit state once.
- Borrowed views expire with their backing receive buffer.
- Check `count <= remaining / size` before multiplication.
- Zero copy names a removed copy; an owning event copy can be the safer/faster boundary.
- Checksums, CRCs, sequence numbers, and authentication protect different invariants.
- Chapter 53 owns feed recovery; Chapter 54 owns gateway sessions.

## Review questions

1. Why can one TCP `recv()` not be treated as one exchange message?
2. What must a length-prefix specification say besides the field’s width?
3. Why is `reinterpret_cast<const Message*>(buffer)` unsafe even for a packed trivial type?
4. How do SBE acting block length/version support evolution?
5. Why can FAST decoding remain wrong after the missing packet has passed?
6. State FIX BodyLength’s start and end octets and FIX CheckSum’s byte coverage.
7. Which sequence properties must be known before comparing two values?
8. Why must structural parsing finish before sequence advancement or book mutation?
9. When is copying selected fields into an owning event preferable to a zero-copy view?
10. What evidence must accompany a parser-latency number?

## Exercise

Extend BookWire v1 with a version-2 optional 64-bit price:

1. design a framing/version rule that lets a v1 decoder skip v2 rows safely;
2. preserve old field meanings and declare byte order/scale/null behavior;
3. add parser cases for truncated price, unknown version, zero rows, maximum rows, forged count, concatenated frames, and a valid frame followed by a partial frame;
4. fuzz `parse_one` with arbitrary byte spans under AddressSanitizer and UndefinedBehaviorSanitizer;
5. integrate a sequence classifier without mutating state on malformed or ahead-of-gap input;
6. benchmark owning-event versus borrowed-view dispatch with exact environment, workload distribution, independent run count, and statistic.

Publish the schema, golden bytes, expected errors, and benchmark raw data.

## Puzzle

A decoder receives three length-valid frames with sequences 500, 502, and 501. It parses frame 502 into a borrowed view and stores that view while requesting recovery. Before 501 arrives, the receive loop reuses the ring slot. After 501 is applied, the decoder drains “502,” whose bytes now describe a different valid message. All checksums and lengths pass. Which invariant failed?

The retained view outlived its backing storage. Framing and checksums validated the original bytes but did not grant ownership. Pending messages must retain the buffer, copy an owning event/frame, or use a pool token that prevents recycling. Sequence correctness depends on memory lifetime correctness.

## Common traps

- Treating a protocol family name as a complete schema.
- Mixing protocol guarantees with venue rules or implementation policy.
- Assuming one read or datagram contains one application message.
- Reading the length field before all length bytes are present.
- Failing to cap an incomplete declared frame.
- Attempting heuristic stream resynchronization without a specified marker.
- Searching FIX text for `55=` without anchoring field delimiters.
- Miscounting FIX BodyLength or including field 10 in its checksum sum.
- Parsing repeating groups without the correct dictionary.
- Treating `ExecType` and `OrdStatus` as interchangeable.
- Assuming all ITCH or OUCH versions share fields, sizes, byte order, or sequencing.
- Treating SBE as a session protocol.
- Accessing SBE groups or variable data out of encoded order.
- Continuing FAST stateful decoding after dictionary state becomes untrustworthy.
- Reusing retired field/template/enum identifiers.
- Mapping an unknown side/order type to buy, sell, or cancel.
- Using native structs, bit-fields, `#pragma pack`, or unaligned typed loads as decoders.
- Using object-representation traits as serialization proof.
- Computing `count * element_size` before an overflow-safe division check.
- Forming an out-of-range pointer and then comparing it with `end`.
- Validating the outer frame but not inner counts and strings.
- Advancing expected sequence before the state transition commits.
- Treating a smaller raw sequence as a reset without epoch/session evidence.
- Applying an ahead-of-gap event to visible state.
- Letting pending storage grow without a hard limit.
- Retaining `span`/`string_view` after receive-buffer recycle.
- Calling DMA, views, or parsing “zero copy” without naming the removed copy.
- Removing bounds branches because a friendly-data benchmark made them visible.
- Sending parser error logs synchronously on a corrupt high-rate channel.
- Treating a checksum, CRC, or sequence number as authentication.
- Quoting decoder latency without input mix, environment, samples, and statistic.
- Implementing feed recovery here instead of maintaining the Chapter 53 boundary.
- Implementing order-session races here instead of maintaining the Chapter 54 boundary.

## Prerequisite check

You are ready to use this chapter when you can:

- distinguish a TCP byte stream from an application frame;
- explain unsigned overflow and why division validates `count × size`;
- read integers from bytes without alignment or aliasing assumptions;
- distinguish a borrowed view from owned storage;
- describe protocol/session/application layers separately;
- explain expected, ahead, behind, and reset sequence cases;
- identify which state must remain unpublished after a parse or sequence error.

If any item is unfamiliar, compile the BookWire parser and alter one byte at every offset. Predict the result before running it. Safe low-latency parsing begins with exact boundaries, not with removing checks.
