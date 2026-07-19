# Chapter 53 — Market-Data Correctness

*Interview-focused revision notes. The theme: a market-data system's hardest problem is not speed but truth — an incorrect book produces confident, fast, wrong decisions, and every mechanism in this chapter exists to make "I do not know the state of this instrument" a state the system can represent and act on.*

---

## 53.1 Incremental Market-Data Feeds

An **incremental feed** transmits changes to the order book rather than its full state. Each message says "add this order", "reduce this level by 300", "delete this order" — and the receiver applies them in sequence to a locally maintained replica of the exchange's book (Ch. 50 §50.13).

### Why incremental

| | Incremental | Full-state (snapshot) per update |
|---|---|---|
| Bandwidth | ~50–100 bytes/update | Kilobytes per update |
| Receiver CPU | O(1) per message | O(book depth) per message |
| Recovery from loss | **Impossible without external help** | Trivial — the next message is complete |
| Latency | Minimal | Serialization delay of a large message |

The bandwidth argument is decisive: a busy equity name generates hundreds of thousands of updates per day, and a full-depth book is tens of kilobytes. Incremental encoding is the only viable design, and it purchases that efficiency by making the receiver **stateful and history-dependent** — which is precisely the source of every hazard in this chapter.

> **The fundamental property:** an incremental feed receiver's state is a function of *every* message it has ever processed. A single lost, duplicated, reordered, or misapplied message corrupts the state permanently and silently.

### The two granularities, again

Ch. 52 §52.4 introduced these; the correctness implications differ sharply.

**Order-by-order** (ITCH-style): messages reference individual orders by an exchange-assigned reference number. Applying an update requires a lookup of that reference. A message for an unknown reference is unambiguous evidence of a gap — you have proof of corruption. This **self-checking property** is a real advantage.

**Price-level aggregated** (CME MDP, many futures feeds): messages carry `(price_level_index, price, quantity, action)` where action is New / Change / Delete. Levels shift: a `New` at level 2 pushes the old levels 2..N down by one.

```
Before:              Incremental: New, level=2, price=100.02, qty=500
  L1: 100.03  200
  L2: 100.01  300     After:
  L3: 100.00  700       L1: 100.03  200
                        L2: 100.02  500   ← inserted
                        L3: 100.01  300   ← shifted down
                        L4: 100.00  700   ← shifted down
```

The hazard is that the level index is **positional and relative**, so a lost message means every subsequent level index is applied to the wrong level. The book stays structurally valid — prices ordered, quantities positive — while being entirely wrong. There is no self-check. This is why price-level feeds always carry an explicit per-instrument sequence (`RptSeq`) and why validating it is mandatory rather than optional.

### The message set and its subtleties

| Action | Meaning | Hazard |
|---|---|---|
| Add / New | Insert an order or level | Duplicate add for an existing reference = leaked entry |
| Modify / Change | Change quantity (and possibly price) | Whether quantity is **absolute** or a **delta** is venue-specific; getting it backwards silently doubles or zeroes sizes |
| Delete | Remove | Delete of an unknown reference = evidence of a prior gap |
| Execute | Reduce by traded quantity, emit a trade | Must reduce the book; a **trade print** message must not (Ch. 51 §51.4) |
| Replace | Delete + Add, usually with a new reference | Queue priority is lost; retaining the old reference leaks |
| Implied | Derived from a spread instrument's book | Must be tracked separately from outright liquidity |

The **absolute-versus-delta** ambiguity is the single most common normalization bug. CME sends new absolute quantities; ITCH `Order Cancel` sends the shares *removed*. A handler that assumes the wrong convention produces a book that is wrong in a direction that correlates with activity — quantities drifting toward zero or growing without bound — and the diagnostic signature is a book that diverges from the exchange's periodic checksum within seconds of market open.

---

## 53.2 Snapshot Feeds

A **snapshot** is a complete statement of an instrument's book at a point in time: every price level (or every order), with an associated sequence number saying "this state includes all incremental messages up to and including N."

### The three delivery models

| Model | Mechanism | Recovery latency | Cost |
|---|---|---|---|
| **Cyclic multicast snapshot channel** | A separate multicast group continuously cycling through all instruments | Up to one full cycle: 100 ms – 30 s depending on universe size | Constant bandwidth, shared by all subscribers, no per-client state |
| **Request/reply snapshot** | Unicast TCP request for a specific instrument | 1 RTT + service time (ms) | Per-client state; rate-limited; can be overwhelmed at open |
| **Start-of-day / reference file** | Downloaded before the session | n/a | Only useful at startup |

The **cyclic multicast model dominates** for the same reason multicast dominates for incrementals: the exchange's cost is independent of subscriber count, and it degrades gracefully — a thousand clients recovering simultaneously (after a network event) impose no more load than one. A request/reply snapshot service, by contrast, is exactly the resource that saturates during the incident that made everyone need it. This asymmetry is a good point to raise unprompted.

### The critical field

Every snapshot must carry the sequence number it is consistent with:

```
Snapshot for instrument 4711:
   LastMsgSeqNumProcessed = 1,048,213    ← the incremental sequence this reflects
   RptSeq                 = 8,201        ← per-instrument sequence (CME-style)
   levels: [ (100.03, 200), (100.02, 500), (100.01, 300), ... ]
```

Without it the snapshot is unusable, because you cannot know which incremental messages it already includes and which must still be applied. A snapshot with no sequence anchor can only be used by discarding all buffered incrementals and hoping — which loses every update in the window, silently.

### Snapshot construction hazards on the exchange side

Two properties a strong candidate knows to ask about:

1. **Is the snapshot atomic?** A snapshot assembled while the book is changing may reflect level 1 at sequence N and level 5 at sequence N+3. Real feeds guarantee point-in-time consistency, but the *cycle* is not atomic across instruments — instrument A's snapshot and instrument B's snapshot in the same cycle correspond to different times. Cross-instrument strategies must not assume a synchronized view after recovery.
2. **Is the snapshot depth-limited?** Many snapshot channels publish only the top N levels. If your book maintains full depth, recovering from a top-10 snapshot leaves you with a *truncated* book, not a correct one. The correct handling is to mark depth beyond N as unknown rather than as empty — an empty level and an unknown level are different, and treating unknown as empty makes the book appear thinner than reality.

---

## 53.3 Snapshot-Plus-Delta Recovery

The composition of §53.1 and §53.2: the standard algorithm by which a receiver establishes or re-establishes a correct book. This is the most-asked mechanism in this chapter and the one to be able to write on a whiteboard.

### The algorithm

```
1. Begin buffering incremental messages for the instrument.
   Record the sequence number of the first buffered message, F.

2. Await a snapshot S with LastMsgSeqNumProcessed = X.

3. If X < F − 1:
       The snapshot predates our buffer; there is a hole between X and F.
       DISCARD the snapshot, keep buffering, wait for the next cycle.

4. Otherwise (X >= F − 1):
       Install S as the book state.
       Discard buffered messages with seq <= X   (already reflected in S).
       Apply buffered messages with seq  > X     (in order).
       Mark the instrument LIVE.

5. Continue applying incrementals from the live feed.
```

```
 seq:  ...  1000 1001 1002 1003 1004 1005 1006 1007 1008  →
                  │                                    │
 buffered:        F=1001 ────────────────────────────► 1008
 snapshot X=1004:      ▲ covers everything through 1004
                       └─► discard 1001..1004, apply 1005..1008, go LIVE
                           (X=1004 >= F−1=1000  ✓)

 snapshot X=999:  ✗  X=999 < F−1=1000 → messages 1000 was never buffered
                     and is not in the snapshot → HOLE → discard, retry
```

### The conditions that trip people

- **The comparison is `X >= F − 1`, not `X >= F`.** A snapshot at exactly `F − 1` is perfect: it covers everything before the buffer and the buffer covers everything after, with no overlap and no hole. Off-by-one here produces a system that discards perfectly good snapshots and takes an extra cycle to recover — or, in the other direction, silently accepts a one-message hole.
- **Buffering must start before the snapshot request/wait.** Reverse the order and you have a race: messages arriving between "snapshot taken" and "buffering started" are lost forever, and nothing detects it.
- **The buffer must be bounded.** If the snapshot cycle is 5 seconds and the instrument does 50,000 messages/second, the buffer needs 250,000 entries — or a policy for what to do when it fills (Ch. 52 §52.15). Exceeding the buffer means abandoning this recovery attempt and restarting it, which is correct but must be explicit and counted.
- **Per-instrument, not per-channel.** A gap on a channel carrying 500 instruments does not necessarily affect all of them; the message you missed concerned one instrument. Exchanges that provide a per-instrument sequence (`RptSeq`) let you recover only the affected instrument and keep trading the rest. Exchanges that provide only a channel sequence force you to treat the whole channel as suspect — a materially worse operational position, and a real difference between venues.
- **The book is NOT tradeable during recovery.** Between detecting the gap and completing step 4, the instrument's state is unknown. It must be flagged (§53.8) and the strategy must stop quoting it. Continuing to quote from a partially-recovered book is the canonical way a correctness bug becomes a loss.

### Startup is the same algorithm

Cold start is just recovery with `F` being the first message ever seen. The same code path should serve both, which is a good design argument: the recovery path is then exercised on every single startup rather than only during rare incidents, so it cannot rot.

---

## 53.4 Feed Sequence-Gap Recovery

The end-to-end decision procedure when a sequence number does not match expectation. Ch. 51 §51.14 covered the sequence-number state machine; this is the recovery policy layered on it.

### Detection

```cpp
// Per channel. Returns the action to take.
Action FeedState::on_packet(std::uint64_t seq, std::uint16_t count) noexcept {
    if (seq == expected_) { expected_ = seq + count; return Action::Process; }
    if (seq <  expected_) {                                  // duplicate or B-feed copy
        if (seq + count <= expected_) return Action::Drop;   // wholly old
        return Action::PartialOverlap;                        // rare; process the tail
    }
    gap_ = seq - expected_;                                   // seq > expected_
    return Action::Gap;
}
```

The `PartialOverlap` case is real and frequently missed: a retransmitted or B-feed packet can begin before `expected_` and extend past it. Dropping it wholesale re-creates the gap you were trying to fill; processing it wholesale double-applies messages. The correct handling processes only messages with `msg_seq >= expected_`, which requires per-message sequence derivation (`packet_seq + index`) — one of the concrete reasons MoldUDP64-style per-message numbering is superior to packet-only numbering.

### The recovery ladder

```
                        gap of N messages detected
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
    B-feed already has it?   N small & retransmit    N large, or retransmit
    (§53.6 — the common      available & not         unavailable/rate-limited
     case; costs nothing)    rate-limited                    │
              │                     │                        ▼
              ▼                     ▼              ┌──────────────────────┐
        apply from B          request retransmit   │ snapshot resync      │
        continue LIVE         (~0.5–5 ms)          │ (§53.3, 100 ms–30 s) │
                                    │              └──────────────────────┘
                              still missing? ──────────────┘
```

Thresholds are a policy decision with a clear rationale: retransmission is faster than a snapshot for small gaps, but a large gap means a large retransmission response, which is slow, may itself be lossy, and consumes a shared exchange resource. A snapshot's recovery time is bounded by the cycle regardless of gap size, so it wins beyond some N — typically in the hundreds to low thousands of messages.

### The rules that matter

- **Do not discard the messages that arrived after the gap.** Buffer them. They are valid and will be needed at step 4 of §53.3. A handler that drops everything until recovery completes turns a 10-message gap into a full resync.
- **Rate-limit outbound retransmission requests, hard.** The exchange's retransmission service is shared and will disconnect an abusive client. Also, a request storm during a network event makes a recoverable incident unrecoverable for everyone. Cap requests per second, cap the window per request, and back off exponentially on failure.
- **Beware the recovery-induced gap.** Requesting retransmission while the live feed continues means the recovery traffic and live traffic compete for the same NIC, the same core, and the same buffers. A recovery that causes further packet loss is a well-documented failure mode; it is one reason the snapshot channel (which is a passive multicast subscription, not a request) is safer under duress.
- **A gap during the open is qualitatively different.** Message rates at the open can be 50–100× the daily average. A gap there is most likely caused by your own receive-ring overflow, not by the network — and requesting retransmission adds load precisely when you have none to spare. The right response at the open is usually to resync from snapshot and accept the loss of the first seconds, rather than to fight.

### Diagnostic signatures

| Observation | Likely cause |
|---|---|
| Gaps on A and B simultaneously, same sequences | Upstream: the exchange or a shared path. Not you. |
| Gaps on A only, B clean | Path-specific: one switch, one link, one NIC port |
| Gaps correlated with message-rate spikes | **Your receive ring overflowing** — check `rx_missed_errors`, ring size (Ch. 48 §48.13), poll-loop cost |
| Gaps in single-message increments, scattered | Genuine sporadic loss; usually a switch buffer (Ch. 39 §39.6) |
| Large contiguous gaps at fixed intervals | A periodic stall in your process: THP compaction, page fault, GC-like allocator behaviour, a cron job on a shared core |
| Gaps immediately after startup | Joining the multicast group late, or IGMP not converged |

The A-versus-B correlation is the first question to ask, always: it separates "our problem" from "their problem" in one step.

---

## 53.5 Market-Data Packet Duplicate Suppression

Duplicates are not exceptional. With redundant A/B feeds (§53.6) **every message arrives twice by design**, so the duplicate path executes on roughly half of all received packets and must be as cheap as the primary path.

### Sources of duplicates

1. **Redundant feeds** — the intended, dominant source.
2. **Retransmissions** overlapping messages already received live.
3. **Network-level duplication** — a misconfigured LAG/ECMP path, a loop, or a switch replicating multicast to two paths that reconverge (Ch. 39 §39.9).
4. **Snapshot overlap** — a snapshot including messages you already applied (handled structurally in §53.3, not by dedup).

### The suppression mechanisms

**Sequence-based (the correct default).** Maintain `expected_`; anything with `seq < expected_` is a duplicate and is dropped in one comparison. This is O(1), stateless beyond a single integer, and exact — provided sequence numbers are unique and monotone, which is the whole point of §51.14.

```cpp
// The hot path. One predictable branch, no memory beyond a register.
if (seq < expected_) [[likely]] return;    // B-feed arrived second: the common case
```

Note the `[[likely]]`: on a two-feed setup, the second copy of every message hits this branch, so it is taken ~50% of the time overall and nearly 100% on whichever feed is consistently slower. Getting the branch hint right is worth a few cycles per packet at millions of packets per second.

**Content-hash-based (a fallback, not a design).** Where no sequence number exists, hash the payload and keep a bounded set of recent hashes. This is strictly worse: it is probabilistic (hash collisions cause silent message loss), it costs a hash and a lookup per message, the window bound is arbitrary, and it cannot distinguish a genuine repeated message (two identical trade prints) from a duplicate. Mention it only to reject it — a protocol without sequence numbers is the actual defect.

### The pitfalls

- **Do not log duplicates.** At half of all packets, logging each one is a self-inflicted denial of service. Count them in a relaxed per-core counter and export the rate (Ch. 59 §59.3). A *change* in the duplicate rate is informative; the duplicates themselves are not.
- **Deduplicate per channel, not globally.** Sequence spaces are per channel (and sometimes per instrument). A single global `expected_` across channels is meaningless.
- **Do not deduplicate at the packet level when the protocol sequences messages.** A packet can partially overlap (§53.4). Dedup must operate at the granularity the sequence numbers describe.
- **The dedup check must precede all other work**, including decoding. Decoding a message you are about to discard doubles your decode cost — which, at 50% duplicates, is a 33% reduction in feed-handler throughput for free.
- **Duplicate suppression is not idempotence.** It protects the feed handler. Downstream consumers (position, risk, order state) need their own idempotence (Ch. 54), because their duplicate sources are different.

---

## 53.6 Redundant A/B Feed Arbitration

Exchanges publish market data on **two independent multicast groups** — conventionally "A" and "B" — carrying identical message streams over physically disjoint network paths (separate switches, separate NIC ports, sometimes separate feed publishers at the exchange). **Arbitration** is the receiver-side merge of the two into one gap-free stream.

### Why it works

The two paths fail independently. A single lost packet on A is very likely present on B, because loss is dominated by path-specific events: a congested switch port, a bad optic, a NIC ring overflow on one port. Empirically, A/B arbitration eliminates the large majority of gaps at zero recovery latency — it is by far the cheapest reliability mechanism available, and it is the reason retransmission requests should be rare in a healthy system.

It also provides **latency improvement, not just reliability**: taking whichever copy arrives first gives you the minimum of two path latencies. On a well-built network the paths differ by hundreds of nanoseconds to a few microseconds, and which one wins varies packet to packet.

### The arbitration algorithm

```cpp
// Single-writer (Ch. 52 §52.8). Both feeds are polled by the same thread,
// so no synchronization is needed and the merge is deterministic.
void Arbitrator::on_packet(Feed f, std::uint64_t seq, std::uint16_t count,
                           std::span<const std::byte> payload) noexcept {
    ++stats_[f].packets;
    if (seq + count <= expected_) { ++stats_[f].dupes; return; }   // wholly old (§53.5)

    if (seq <= expected_) {                       // contiguous or overlapping: deliver the tail
        deliver_from(payload, expected_ - seq);   // skip already-processed messages
        expected_ = seq + count;
        drain_reorder_buffer();                   // messages that arrived early
        return;
    }
    // seq > expected_ : a gap on THIS feed at this instant. Do not declare a gap yet —
    // the other feed may still deliver the missing packets. Buffer and set a timer.
    reorder_.insert(seq, count, payload);
    if (!gap_timer_.armed()) gap_timer_.arm(now() + kArbitrationWindow);
}
```

### The arbitration window

The single most important tuning parameter, and a favourite question.

```
  A: ─────●────────●──────────●─────────●─────►   seq 100,101,   103,104
  B: ───────●────────●───────────●────────●──►    seq 100,101,102,103,104
                                 ▲
              A lost 102. B delivers it Δ later.
              If we declare a gap before Δ elapses → needless recovery.
              If we wait too long → recovery starts late; latency added to a real gap.
```

- **Too short**: every ordinary inter-feed skew is misread as a gap, triggering retransmission requests that arrive after the B copy already resolved it. Symptom: a high retransmission-request rate with almost all responses discarded as duplicates.
- **Too long**: real gaps sit undetected, and the recovery clock starts late. During the wait the book is stale but not flagged.
- **The right value** is derived from the measured inter-feed arrival-time distribution — typically the p99.9 of |t_A − t_B| plus a margin. In a colocated setup this is usually **100 µs – 2 ms**. It must be measured, not guessed, and re-measured after any network change.

### Non-obvious points

- **Both feeds must be polled by the same thread.** Splitting them across threads requires synchronizing the merge state, which reintroduces locks or atomics into the hottest path and destroys determinism. One thread, two rings, one `expected_`.
- **Never round-robin or prefer a designated primary.** Take whichever arrives first, per packet. A "primary with failover" design gives up the latency benefit and adds a failover decision that can flap.
- **Track per-feed health separately.** Per-feed packet counts, gap counts, and "wins" (times this feed delivered a message first) are the diagnostic. A feed whose win rate drops from 50% to 5% is degrading — a leading indicator visible long before it starts losing packets. This metric is cheap and disproportionately useful.
- **A/B arbitration does not protect against exchange-side loss or corruption.** If the exchange's publisher drops a message, both feeds lack it. Gaps appearing simultaneously on A and B with identical sequence numbers are upstream by definition (§53.4).
- **Some venues offer more than two feeds**, or A/B per channel across separate physical infrastructure. The algorithm generalizes to N feeds unchanged — `expected_` is still a single integer.

---

## 53.7 Deterministic Feed Merge Rules

Beyond arbitrating duplicate copies of one stream, systems frequently merge *semantically distinct* streams: incremental plus snapshot, multiple channels for one instrument, implied plus outright books, or several venues into a consolidated view. Every such merge must be **deterministic**: the same inputs must produce the same output regardless of arrival timing, thread scheduling, or which copy arrived first.

### Why determinism is the requirement

Without it, three things break:

1. **Replay does not reproduce production** (§53.9), so post-incident analysis is guesswork and regression tests are unreliable.
2. **Two instances of the same system disagree** — the primary and its hot standby (Ch. 56 §56.4) diverge, so failover produces a different book and state convergence becomes impossible.
3. **Bugs become unreproducible**, which in practice means unfixable.

### The rules

**1. Order by an explicit key, never by arrival time.** Sequence number first; where two streams have independent sequence spaces, use exchange timestamps with a documented, total tie-break (e.g. channel id, then instrument id). Arrival time is a property of the network, not of the data, and must never determine semantics.

**2. Every tie must have a defined winner.** Two messages with identical timestamps must be ordered by a deterministic rule, not by whichever `poll()` saw first. A stable, documented comparator is the deliverable:

```cpp
// Total order over merged events. No arrival time, no pointer identity, no hash order.
constexpr bool before(const Event& a, const Event& b) noexcept {
    if (a.seq        != b.seq)        return a.seq        < b.seq;
    if (a.exch_ts_ns != b.exch_ts_ns) return a.exch_ts_ns < b.exch_ts_ns;
    if (a.channel    != b.channel)    return a.channel    < b.channel;
    return a.instrument < b.instrument;
}
```

**3. No iteration-order dependence.** Iterating an `unordered_map` to publish updates yields an order that depends on insertion history, hash seed, and capacity. If the output order is observable, use an ordered structure or an explicit sorted index. This is a genuinely common source of non-determinism that survives every unit test and appears only when comparing two live instances.

**4. No wall-clock reads on the processing path.** Timeouts must be driven by a virtual clock derived from the input stream (Ch. 57 §57.13) or, if real time is unavoidable, the timing decision must be recorded as an input so replay can reproduce it. A staleness timeout (§53.8) that fires at a different message during replay produces a different book.

**5. No dependence on batching.** Whether four messages arrive in one datagram or four is a network artifact. Processing must yield the same result either way, which means no per-packet state leaking into per-message semantics.

**6. Snapshot/incremental composition must be deterministic** — the §53.3 algorithm is, because the decision depends only on sequence numbers, not on when the snapshot arrived relative to the buffer.

### Verifying determinism

The mechanism is **differential replay** (Ch. 57 §57.3): run the same capture through the same build twice, and through two builds, and compare a canonical hash of the book state at every sequence number.

```cpp
// Emitted after every applied message during replay. Any divergence localizes
// to the exact message that caused it.
std::uint64_t Book::state_hash() const noexcept;   // over sorted (price, qty) pairs
```

Hashing at every message rather than at the end is what makes this a debugging tool rather than a pass/fail signal: the first differing sequence number is the bug's location.

---

## 53.8 Stale-Market Detection

**Staleness** is the condition of holding book state that no longer reflects reality. It is dangerous precisely because it is invisible from inside: the book looks structurally perfect and the code has nothing to complain about.

### The causes, and why each is silent

| Cause | Why nothing errors |
|---|---|
| Multicast group silently unsubscribed (IGMP snooping timeout, querier election, Ch. 37 §37.9) | The socket is open and healthy; packets simply stop |
| Upstream feed publisher stalled | Same |
| Network path down with no routing failover | Same |
| Your poll loop stalled (page fault, THP compaction, preemption) | Recovers and continues; the backlog is processed late |
| Unrecovered gap | You know, but only if you propagate that knowledge |
| Instrument genuinely quiet | Indistinguishable from all of the above without heartbeats |
| Trading halt (Ch. 49 §49.13) | The book legitimately stops updating |

The last two are why staleness detection cannot be a single global timer: a quiet instrument and a broken feed look identical at the instrument level.

### The detection mechanisms, layered

**1. Channel-level heartbeat monitoring (the primary mechanism).** Market-data protocols emit heartbeats on idle channels precisely so silence is detectable (Ch. 51 §51.7 — MoldUDP64 `count == 0`). A channel that has produced neither data nor heartbeat within `k × heartbeat_interval` is down.

```cpp
// Checked once per poll iteration against a TSC deadline — no syscall.
if (now_tsc - last_rx_tsc_[ch] > stale_threshold_tsc_) [[unlikely]]
    mark_channel_stale(ch);          // fans out to every instrument on the channel
```

**2. Instrument-level activity thresholds.** Per-instrument, an expected update interval derived from that instrument's own history — a liquid future updating 1,000×/second going silent for 100 ms is anomalous; an illiquid option quiet for an hour is not. A fixed global threshold produces both false positives on illiquid names and false negatives on liquid ones.

**3. Cross-feed corroboration.** If A is silent and B is flowing, it is a path problem, not a market condition. If both are silent while a *different* channel on the same infrastructure is flowing, it is upstream. This two-dimensional check (feed × channel) localizes the fault immediately.

**4. Exchange-time versus local-time skew.** With both timestamps recorded (Ch. 52 §52.5), `local_recv_ts − exchange_ts` is the one-way latency plus clock offset. A steadily growing value means data is arriving progressively later — you are falling behind, and this leads packet loss by seconds. This is the single best early-warning metric a feed handler has, and it costs one subtraction.

**5. Structural implausibility.** A crossed or locked book (§53.8's sibling below), a spread far outside its normal distribution, or a zero-size top of book are evidence that the book is wrong.

### Crossed and locked books

Ch. 49 §49.14 defines these at the market level; here they are a *correctness signal*.

- **Locked**: best bid == best ask.
- **Crossed**: best bid > best ask.

Within a single venue's book, a crossed state is **structurally impossible** — the matching engine would have executed those orders (Ch. 50 §50.18). So a crossed single-venue book is proof that your book is wrong, and it is the most valuable free assertion in the entire system:

```cpp
// Checked after every book update. In a correct single-venue book this never fires.
if (best_bid_ >= best_ask_) [[unlikely]] on_book_invariant_violation(instrument);
```

Legitimate exceptions that must be excluded before alarming: a *consolidated* book across venues can be genuinely crossed (Ch. 49 §49.14); auction and halt states (Ch. 49 §49.12) can produce locked or indicative crossed books; and some venues publish implied prices that legitimately cross the outright book. Encode those exceptions explicitly rather than weakening the assertion.

### The action, which is the point

Detection is worthless without a defined response. The correct response is a **per-instrument state**, not a global flag:

```
LIVE ──── gap detected / staleness timeout ────► SUSPECT
  ▲                                                 │
  │                                                 │ recovery started
  │                                                 ▼
  └──── snapshot applied, buffer drained ────── RECOVERING
                                                    │
        unrecoverable / halted / limits ────────► DISABLED (manual re-enable)
```

The strategy reads this state and must not quote an instrument that is not `LIVE`. Making "I don't know" a first-class representable state — rather than an absent update on a stale book — is the entire design idea of this section. A system that can only represent "here is the book" will always, eventually, act on a wrong one.

---

## 53.9 Deterministic Market-Data Replay

**Replay** is feeding a recorded input stream through the production code and obtaining bit-identical output. It is the foundation of testing, debugging, and post-incident analysis for market-data systems, and it is only possible if the system was designed for it.

### What must be captured

| Input | How | Why |
|---|---|---|
| Raw packets, both A and B feeds, with hardware timestamps | NIC hardware timestamping into a capture ring (Ch. 48 §48.4, §48.7) | The only complete record; decoded records already embed your decoder's bugs |
| Retransmission and snapshot channel traffic | Same | Recovery paths must replay too |
| Reference data, versioned | Snapshot at session start plus intraday deltas | The book depends on tick sizes and symbology (Ch. 52 §52.5) |
| Configuration | Immutable, versioned artifact (Ch. 60 §60.2) | A config change changes behaviour |
| Order-entry traffic and acks | Same capture | Needed for full-system, not just feed, replay |

**Capture raw, not decoded.** A capture of your normalized events cannot reproduce a decoder bug, cannot validate a decoder change, and cannot be re-processed by a fixed version. Raw packet capture with hardware timestamps is the only artifact with lasting value.

### What makes replay produce different results

Every one of these is a design defect, not a replay limitation:

| Non-determinism source | Fix |
|---|---|
| Wall-clock reads driving logic | Virtual clock advanced from packet timestamps (Ch. 57 §57.13) |
| Arrival-time-dependent merge | Deterministic total order (§53.7) |
| Thread scheduling / queue interleaving | Single-writer event loop (Ch. 52 §52.8); replay single-threaded |
| Hash-map iteration order | Ordered containers or explicit sorted output |
| Uninitialized memory read | Sanitizers (Ch. 44); it is UB regardless |
| Pointer values or addresses in output | Use indices (Ch. 52 §52.4) |
| Random number generation | Seeded and recorded (Ch. 57 §57.5) |
| Timeouts firing at different messages | Drive timers from the virtual clock |
| Floating-point differences across builds | Fixed-point arithmetic (Ch. 23 §23.10); no `-ffast-math` |

### Replay modes

| Mode | Timing | Use |
|---|---|---|
| **As-fast-as-possible** | Ignore inter-packet gaps | Regression testing, book validation — a trading day replays in minutes |
| **Paced to original timing** | Reproduce inter-packet deltas | Latency measurement, timeout and staleness behaviour |
| **Accelerated by a factor** | Compressed but proportional | Load testing (Ch. 57 §57.16) |
| **Injected at the wire** | Replay onto a real network into the real NIC | Full-stack validation including the transport (Ch. 57 §57.18) |

Wire-level injection is the most faithful and the most valuable for validating anything below the application: it exercises the NIC, the driver or bypass library, the ring, and the poll loop. Application-level injection bypasses all of that and cannot reproduce a receive-ring overflow or a timestamping bug.

### What replay is used for

1. **Book validation.** Replay a full day and compare the book at every sequence number against the exchange's published checksums or against a reference implementation (**differential testing**, Ch. 57 §57.3).
2. **Regression gating.** Every build replays a canonical capture set; the book state hash and the per-stage latency percentiles (Ch. 52 §52.11) must match within tolerance. This is the only reliable way to catch a change that quietly alters book semantics.
3. **Incident analysis.** Replay the exact capture from the incident window, with instrumentation added, as many times as needed. Without deterministic replay, a market-data bug that occurred once is essentially uninvestigable.
4. **Recovery-path exercise.** Replay with packets deliberately dropped (fault injection, Ch. 57 §57.15) to force gap detection, arbitration, retransmission, and snapshot resync. These paths otherwise run rarely in production and rot silently — this is the single highest-value use of replay infrastructure.
5. **Protocol version validation.** Replay old captures through a new decoder before an exchange cutover (Ch. 51 §51.11).

### The design constraint, stated once

> The feed handler and book builder must be **pure functions of (input byte stream, reference data version)**. Everything else — timestamps, timers, thread identity, memory addresses, hash order — must either be an explicit input or have no influence on output.

This is a strong constraint that shapes the whole architecture, and it is the reason single-writer event loops, virtual clocks, fixed-point arithmetic, index-based structures, and deterministic merge rules appear throughout these chapters. They are not independent good practices; they are the consequences of insisting on replay.

---

## Key Interview Questions

1. **Why are market-data feeds incremental rather than snapshot-per-update, and what does that cost?** — Bandwidth and receiver CPU: a full book is kilobytes and thousands of updates per second. The cost is that the receiver becomes stateful and history-dependent, so any lost, duplicated, or misapplied message corrupts state permanently and silently.
2. **What is the correctness difference between order-by-order and price-level feeds?** — Order-by-order is self-checking: an update for an unknown order reference is proof of a gap. Price-level indices are positional and relative, so a lost message shifts every subsequent level, leaving a structurally valid but entirely wrong book with no intrinsic error signal.
3. **Write the snapshot-plus-delta recovery algorithm.** — Start buffering (note first buffered sequence F); wait for a snapshot with `LastMsgSeqNumProcessed = X`; if `X < F − 1` discard it and wait for the next cycle; else install the snapshot, discard buffered messages `<= X`, apply those `> X`, and go LIVE.
4. **Why is the condition `X >= F − 1` and not `X >= F`?** — A snapshot at exactly `F − 1` abuts the buffer with no hole and no overlap. Getting it wrong either discards valid snapshots (slow recovery) or accepts a one-message hole (silent corruption).
5. **Why must buffering start before you wait for the snapshot?** — Otherwise messages arriving between the snapshot's cut-off and the start of buffering are lost with nothing to detect them.
6. **Why are cyclic multicast snapshots preferred over request/reply?** — Exchange cost is independent of subscriber count and it degrades gracefully; a request/reply service saturates during exactly the incident that makes everyone need it.
7. **What is A/B arbitration and why does it help?** — Two multicast copies over disjoint paths; take whichever packet arrives first. Loss is path-specific and therefore mostly independent, so it eliminates the majority of gaps at zero recovery latency, and it also gives min-of-two-paths latency.
8. **How do you choose the arbitration window?** — From the measured distribution of |t_A − t_B|: roughly p99.9 plus margin, typically 100 µs – 2 ms colocated. Too short causes needless retransmission requests whose responses are all discarded as duplicates; too long delays real recovery.
9. **Why must both feeds be polled by the same thread?** — The merge state (`expected_`, reorder buffer) is single-writer; splitting across threads adds synchronization to the hottest path and destroys determinism.
10. **What single metric best predicts a degrading feed path?** — Per-feed "win rate" (how often each feed delivers a message first). A drop from ~50% to a few percent precedes packet loss by a long margin. Runner-up: growing `local_recv_ts − exchange_ts` skew.
11. **Gaps appear on A and B with identical sequence numbers — what does that tell you?** — The loss is upstream of the path split: the exchange publisher or a shared segment. Nothing on your side will fix it, and retransmission is the only recovery.
12. **Why is a crossed book within one venue proof of a bug?** — The matching engine would have executed those orders, so the state is structurally impossible. It is the cheapest correctness assertion available. Exclude consolidated books, auction/halt states, and implied prices explicitly.
13. **Why can't you detect a stale feed by "no messages received"?** — A quiet instrument, a halt, and a broken feed are indistinguishable without heartbeats. Detection needs channel heartbeats, per-instrument activity baselines, cross-feed corroboration, and exchange-versus-local timestamp skew.
14. **What happens when a multicast join silently expires?** — Packets simply stop; the socket is healthy and nothing errors. Only a staleness timer detects it. IGMP snooping timeouts and querier elections are the usual causes.
15. **What should the system do while recovering an instrument?** — Represent it as a distinct non-LIVE state (SUSPECT/RECOVERING) and refuse to quote it. Making "I don't know" representable is the core design idea; a system that can only represent "here is the book" will eventually act on a wrong one.
16. **Why must duplicate suppression be the very first thing you do per packet?** — With A/B feeds roughly half of all packets are duplicates; decoding before dedup doubles decode cost for no benefit.
17. **What is a partially overlapping packet and why does it matter?** — A retransmitted or B-feed packet starting before `expected_` and extending past it. Dropping it recreates the gap; processing it whole double-applies. Handle per-message with `packet_seq + index`.
18. **What makes replay non-deterministic, and why does it matter?** — Wall-clock reads, arrival-time-dependent merges, thread interleaving, hash iteration order, addresses in output, unseeded randomness, floating point. Without determinism, standby instances diverge, incidents are uninvestigable, and regression tests are unreliable.
19. **Why capture raw packets rather than decoded events?** — A decoded capture already contains your decoder's bugs; it cannot validate a decoder change or reproduce a decode fault. Raw capture with hardware timestamps is the only durable artifact.
20. **What is the highest-value use of replay infrastructure?** — Fault injection to exercise gap detection, arbitration, retransmission, and snapshot resync. Those paths rarely run in production and rot silently, and they are exactly the code that must work during an incident.

---

## Common Traps

- **Assuming quantity semantics** — absolute versus delta is venue-specific; getting it backwards drifts every size silently.
- **Applying trade-print messages to the book** — off-book prints do not touch displayed liquidity (Ch. 51 §51.4).
- **Treating a price-level feed's level index as stable** — it is positional; one lost message shifts everything.
- **Using a snapshot with no sequence anchor** — you cannot know which incrementals it includes.
- **Treating unknown depth beyond a truncated snapshot as empty** — makes the book look thinner than reality.
- **Assuming a snapshot cycle is atomic across instruments** — different instruments in one cycle reflect different times.
- **Starting to buffer after requesting the snapshot** — a race that silently loses the intervening window.
- **Off-by-one in `X >= F − 1`** — either wasted cycles or a one-message hole.
- **Discarding messages received after a gap** — turns a small gap into a full resync.
- **Unbounded recovery buffers** — a 5 s snapshot cycle at 50 k msg/s is 250 k entries.
- **Declaring a gap before the arbitration window expires** — retransmission storms whose responses are all discarded.
- **Preferring a designated primary feed instead of first-arrival** — gives up the latency benefit and adds failover flapping.
- **Splitting A and B across threads** — synchronization in the hottest path, non-deterministic merge.
- **Ignoring partially overlapping packets** — recreated gaps or double-applied messages.
- **Logging every duplicate** — half of all packets; self-inflicted overload.
- **Deduplicating after decoding** — doubles decode cost.
- **A single global `expected_` across channels** — sequence spaces are per channel.
- **Unlimited retransmission requests** — exchange disconnection, and a recoverable incident made unrecoverable for everyone.
- **Requesting retransmission during the open** — adds load exactly when your ring is already overflowing; resync from snapshot instead.
- **Recovering the whole channel when only one instrument gapped** — use per-instrument sequences where the venue provides them.
- **A single global staleness threshold** — false positives on illiquid names, false negatives on liquid ones.
- **Treating silence as "no updates"** — an expired IGMP join and a quiet market look identical.
- **Weakening the crossed-book assertion instead of enumerating its legitimate exceptions.**
- **Quoting from a book in a non-LIVE state** — where a correctness bug becomes a financial one.
- **Wall-clock reads on the processing path** — timers fire at different messages during replay.
- **Publishing in `unordered_map` iteration order** — passes every unit test, diverges between instances.
- **Capturing decoded events instead of raw packets** — the capture inherits the decoder's bugs.
- **Never exercising the recovery paths** — they are the least-tested and most consequential code in the system.

---

## Compact Recall Summary

**Incremental feeds.** Deltas, not state: 50–100 bytes per update against kilobytes for a full book, at the price of a receiver whose state depends on every message it ever saw. Order-by-order feeds are self-checking (an unknown order reference proves a gap); price-level feeds use positional indices and fail silently, so their per-instrument `RptSeq` must be validated. Absolute-versus-delta quantity semantics is the most common normalization bug.

**Snapshots.** A complete book plus the sequence number it is consistent with — without that anchor it is unusable. Cyclic multicast beats request/reply because exchange cost is subscriber-independent and it survives mass recovery; request/reply saturates during the incident that triggers it. Watch for depth-truncated snapshots (unknown ≠ empty) and non-atomic cross-instrument cycles.

**Snapshot-plus-delta.** Buffer first (record F), wait for a snapshot with `X = LastMsgSeqNumProcessed`, require `X >= F − 1`, install, discard `<= X`, apply `> X`, go LIVE. Bound the buffer, recover per instrument where possible, and use the identical code path for cold start so it is exercised daily.

**Gap recovery.** Ladder: B-feed (free) → rate-limited retransmission (~0.5–5 ms, small gaps) → snapshot resync (100 ms – 30 s, bounded regardless of gap size). Buffer everything after the gap. Handle partially overlapping packets per-message via `packet_seq + index`. Diagnose by A/B correlation: both feeds gapping identically is upstream; one feed only is path-specific; gaps correlated with rate spikes are your own ring overflowing.

**Duplicates.** Normal, not exceptional — half of all packets with A/B. Suppress by sequence comparison (`seq < expected_`) as the very first operation, before decode, with the branch hinted. Count in relaxed per-core counters, never log. Per channel, at message granularity. Dedup protects the feed handler only; downstream consumers need their own idempotence.

**A/B arbitration.** Two disjoint paths, take first arrival per packet — eliminates most gaps at zero cost and yields min-of-two latency. One thread polls both; single `expected_`; never a designated primary. The arbitration window (p99.9 of inter-feed skew, typically 100 µs – 2 ms) must be measured. Per-feed win rate is the best leading indicator of path degradation.

**Deterministic merge.** Order by sequence, then exchange timestamp, then a total tie-break — never by arrival time. No hash-iteration-order dependence, no wall-clock reads, no batching sensitivity. Verify by hashing book state after every applied message across two runs and two builds; the first divergent sequence number localizes the bug.

**Staleness.** Silence is not an error and cannot be distinguished from quiet without heartbeats. Layer channel heartbeat deadlines, per-instrument activity baselines, cross-feed corroboration, and exchange-versus-local timestamp skew (the best early warning — it leads packet loss by seconds). A crossed single-venue book is structurally impossible and therefore the cheapest correctness assertion available, with consolidated books, auctions/halts, and implied prices as explicit exceptions. Model instrument state as LIVE / SUSPECT / RECOVERING / DISABLED and refuse to quote anything not LIVE.

**Replay.** Capture raw packets on both feeds with hardware timestamps, plus recovery channels, versioned reference data, and configuration. Determinism requires a virtual clock, deterministic merge, single-writer loops, ordered output, indices instead of addresses, seeded randomness, and fixed-point arithmetic. Modes: as-fast-as-possible for regression, paced for latency, accelerated for load, wire-injected for full-stack. The feed handler must be a pure function of (input stream, reference data version) — and the highest-value application is fault-injected replay that forces the recovery paths to run.
