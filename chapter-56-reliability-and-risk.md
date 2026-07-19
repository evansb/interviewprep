# Chapter 56 — Reliability and Risk

*Interview-focused revision notes. The theme: these are the controls that must be simultaneously on the critical path and never wrong. Every other chapter optimizes for speed subject to correctness; this one designs for correctness subject to a nanosecond budget, and the interesting engineering is entirely in that inversion.*

---

**Terminology.** **Pre-trade risk** is validation applied to an order *before* it leaves the firm; **post-trade risk** is monitoring after the fact. A **position** is the signed net quantity held in an instrument; **exposure** or **notional** is position × price, the monetary magnitude at stake. **Credit** or **buying power** is the capital a venue or clearing firm permits you to commit. A **kill switch** is a control that halts order entry and cancels working orders. **Fail-closed** means a control that cannot evaluate blocks the action; **fail-open** means it permits it. **Active-passive redundancy** runs one live instance and one hot standby; **failover** is promoting the standby. **Split-brain** is two instances both believing they are live.

The recurring structural insight: reliability mechanisms are *state machines with durable state*, and every one of them is a variation on the same three questions — what is written before what, what happens if the process dies between those two writes, and what does a second process do if it thinks the first is dead but is wrong.

---

## 56.1 Write-Ahead Trading Journals

A **journal** (or write-ahead log, WAL) is an append-only durable record of every input the system consumed and every externally-visible action it took, written *before* the action. The invariant it establishes is: **anything the outside world can observe was durably recorded first.** That invariant is what makes crash recovery a matter of replay rather than of guesswork, and it is the foundation of §56.2 and §56.3.

What must be journaled, and why:

| Record | Reason |
|---|---|
| Every inbound market-data and session message, raw bytes + sequence + receive TSC | Replay determinism; reconciliation (Ch. 54 §54.15) |
| Every outbound order/cancel/replace, raw bytes + `ClOrdID` | "Did we send this?" must be answerable after a crash |
| Every risk-state change (limit updates, kill-switch toggles) | Reconstruct the control state that permitted an action |
| Non-deterministic inputs: timer fires, RNG draws, config reads | Replay must reproduce them exactly (Ch. 57 §57.12) |

That last row is the one candidates miss. A system is replayable only if every source of nondeterminism is *captured*, not re-derived. If the strategy reads the clock, the clock reading must be in the journal; if it consults a config file, the value used must be recorded. Otherwise replay diverges silently and the journal becomes decorative.

**The ordering rule, stated precisely.** For outbound actions: append, make durable, *then* send. If the process dies between durability and send, recovery replays and re-sends — a duplicate, which the exchange rejects on `ClOrdID` (Ch. 54 §54.16). If you send first and die before appending, you have a live order the system does not know about, which is the unrecoverable direction. **Prefer duplicates to losses** is the same rule as Ch. 54 §54.16, and it derives from this asymmetry.

**Making it fast enough to be on the critical path.** Naive durability means `write()` + `fsync()` — a syscall plus 50 μs–10 ms of device latency, wholly incompatible with a hot path. The techniques:

```cpp
// mmap'd append-only segment, preallocated and prefaulted (Ch. 55 §55.1)
struct Journal {
    std::byte* base;              // mmap(MAP_SHARED, fd), MAP_POPULATE, mlock
    uint64_t   head;              // byte offset, owned by the single writer
    inline void append(const void* p, uint32_t n) noexcept {
        std::memcpy(base + head + 4, p, n);
        // publish length last, with release ordering: a reader/recovery sees a
        // complete record or no record — never a partial one.
        std::atomic_ref<uint32_t>(*(uint32_t*)(base + head))
            .store(n, std::memory_order_release);
        head += 4 + n;
    }
};
```

An `mmap`'d, prefaulted, `MAP_SHARED` file gives an append that is a `memcpy` plus a release store — **20–60 ns**, no syscall, no allocation. The pages are dirty in the page cache and the kernel flushes them asynchronously. This is *visible* durability (another process reading the file sees it immediately) but not *durable-on-power-loss* durability (Ch. 32 §32.27) — the distinction matters enormously and is a favourite question. For process-crash survival, `mmap` is sufficient: the page cache survives the process. For machine-crash or power-loss survival, you need `msync`/`fsync` or a replicated write to another host, and the pragmatic answer in trading is that **replication to a second machine is both faster and more useful than `fsync`** — a network round trip on a 10G cross-connect is ~10–20 μs versus an NVMe `fsync` at 50–200 μs, and it also survives the machine burning down.

**Length-last publication** is the crash-consistency primitive: because the length word is written with a release store after the payload, a recovery reader that sees a nonzero length is guaranteed to see the complete payload. Writing the header first and the payload after produces torn records that recovery cannot distinguish from valid ones. Add a per-record CRC (Ch. 51 §51.13) if the storage may tear at a sub-record granularity.

---

## 56.2 Crash-Consistent Sequence Checkpoints

Replaying an entire trading day's journal takes minutes; replaying from a **checkpoint** takes seconds. A checkpoint is a serialized snapshot of the application's full state, tagged with the journal position at which it is valid. Recovery then loads the checkpoint and replays only the journal suffix.

The correctness condition is exact and it is where implementations go wrong:

> A checkpoint tagged with journal offset **P** must equal the state produced by processing every record strictly before **P** and none at or after it.

Violating it in either direction is silent corruption: a checkpoint that includes effects of records after P double-applies them on replay; one that misses effects of records before P loses them. The failure surfaces days later as a position discrepancy with no obvious cause.

**Achieving it without stopping the world.** The single-writer architecture (Ch. 52 §52.6) makes this tractable, because there is exactly one thread mutating state and therefore one point at which state is quiescent:

1. At a record boundary — never mid-record — the writer thread records `P = journal.head` and marks a snapshot epoch.
2. Copy-on-write: either `fork()` and let the child serialize (the kernel gives you a consistent snapshot for free via COW page faults, Ch. 31 §31.3, at the cost of fault latency in the parent on subsequent writes), or double-buffer the state so the writer continues into buffer B while a warm thread serializes buffer A.
3. Write the snapshot to a **temporary file**, `fsync` it, then `rename()` it into place. `rename()` within a filesystem is atomic, so a reader sees either the old complete checkpoint or the new complete one — never a partial one. This is the standard atomic-publish idiom and the expected answer.

```
write tmp → fsync(tmp) → rename(tmp, final) → fsync(dir)
```

The `fsync` on the *directory* is the detail that separates candidates: without it, the rename may not be durable even though the file contents are, and a power loss can leave the old name pointing at nothing.

**`fork()` for snapshotting** deserves the caveat. It is elegant — the child sees a frozen address space — but it is dangerous on a latency-critical process: the fork itself takes hundreds of microseconds to milliseconds for a large address space (page-table copy), and every subsequent write in the parent takes a COW fault (~2–3 μs each). With huge pages the COW fault copies 2 MB, which is far worse. Trading systems usually prefer explicit double-buffering or checkpointing from a *replica* rather than the primary, precisely to keep this cost off the live process.

**Checkpoint cadence** is a recovery-time-objective decision: checkpoint every N seconds or M records such that worst-case replay of the suffix fits the recovery budget. Keep at least two checkpoints — the newest may be corrupt, and a recovery that discovers this with no fallback has become a full-day replay at the worst possible moment.

**Validation.** Every checkpoint must carry a version, a schema hash, the journal offset, a record count, and a checksum, and recovery must verify all of them before trusting it. A checkpoint written by a previous binary with a changed struct layout, loaded by `memcpy` into the new layout, is silent corruption of the risk state — which is why checkpoint formats follow Ch. 3 §3.12's wire-layout rules, not "just dump the structs."

---

## 56.3 Startup and Replay Recovery

Recovery is the composition of the previous two sections plus reconciliation with the outside world. The sequence, in strict order:

```
1. Load newest valid checkpoint  ──► in-memory state, journal offset P
2. Replay journal records from P to end, through the SAME code path as live
3. Reconstruct in-flight order set from replayed state
4. Query the exchange: OrderMassStatusRequest / session resend  (Ch. 54 §54.10)
5. Reconcile: exchange truth vs replayed belief; resolve every difference
6. Reconcile positions against drop copy / start-of-day file      (Ch. 54 §54.14)
7. Load and verify risk limits; recompute utilization from positions
8. Enter a NO-NEW-ORDERS state; permit cancels only
9. Operator or automated policy enables order entry
```

Steps 8 and 9 are the ones under-specified in most designs, and they are the difference between a system that recovers and one that compounds an incident. **A recovering system must never begin sending new orders automatically before reconciliation has completed and been verified.** Cancels are safe (risk-reducing, idempotent by `ClOrdID`); new exposure is not.

**"Through the same code path as live"** (step 2) is the load-bearing requirement. If replay uses a different code path — a simplified loader, a different parser, a "recovery mode" — then recovery reconstructs a state the live system would never have produced, and every bug in the recovery path is invisible until the day it runs. The design that makes this achievable is a deterministic, side-effect-free core: the event loop calls `apply(event)` which mutates state only; outbound sends are *outputs* of `apply`, buffered and dispatched by the caller. In replay mode the caller discards outputs instead of sending them. Same function, same state transitions, provably identical results (Ch. 57 §57.12).

**Idempotent replay of outputs.** Replay regenerates outbound messages that were already sent. The rule is to suppress sends for records at or before the last journaled *send confirmation*, and for the ambiguous tail — records journaled but possibly not sent — to resolve by query rather than by re-sending (Ch. 54 §54.10). This is where "prefer duplicates to losses" meets its exception: a duplicated new order is real exposure.

**Recovery-time budget.** State it as a number and design to it. If a gateway must be back in a known state within, say, 30 seconds of a crash, then checkpoint cadence, journal read throughput (an `mmap`'d sequential read is ~2–5 GB/s), reconciliation round trips, and venue mass-status latency must all sum below it. Measure recovery time in a test that kills the process with `SIGKILL` under load (Ch. 57 §57.16) — not a graceful shutdown, which exercises an entirely different path.

**Failure signatures.** Recovery that produces a state differing from the pre-crash state indicates: an unjournaled nondeterministic input (clock, RNG, `unordered_map` iteration order, thread interleaving), a checkpoint offset off by one record, or a replay path diverging from the live path. Differential testing — run live and replay in parallel and compare state hashes continuously (Ch. 57 §57.3) — catches all three in development instead of during an incident.

---

## 56.4 Active-Passive Redundancy

**Active-passive** (primary/standby) runs one instance handling traffic and one or more instances kept ready. Contrast with **active-active**, where multiple instances trade simultaneously — which in trading is usually wrong for order entry, because two instances sharing a position and a risk budget must coordinate on every decision, and that coordination is a distributed consensus problem on the critical path.

The standby's warmth is a spectrum with very different recovery times:

| Model | Standby state | Failover time | Cost |
|---|---|---|---|
| **Cold** | Not running | Minutes (start, load, reconcile) | Cheapest |
| **Warm** | Running, state loaded from checkpoint, not consuming live feed | Seconds | Moderate |
| **Hot** | Running, consuming the same market-data feed and the drop copy, state continuously current, not sending | Sub-second | A full duplicate of the machine, feed, and cross-connect |
| **Hot + shadow** | As hot, plus computing decisions and comparing against the primary's journal | Sub-second, plus continuous verification | Highest; also the best bug detector |

The hot standby's crucial property is that **it derives its state from the same inputs, not from the primary.** It subscribes to the identical multicast market-data feed (Ch. 37 §37.14) and to the drop copy (Ch. 54 §54.14), so its book and position are current without any replication channel from the primary. This is far more robust than shipping state: there is no replication lag to bound, no serialization format to version, and a primary that is corrupt cannot corrupt the standby. The standby is *deterministically derived*, which is the same property that makes replay work (§56.3).

What the standby cannot derive from public inputs is the primary's *intent* — orders it sent that have not yet acked, and internal strategy state. Those must come from the journal, either shipped over the network (journal replication: the primary multicasts its journal records, the standby applies them) or read from shared storage. Journal replication is the standard design because it reuses the recovery machinery: the standby is simply a process permanently in replay mode, and promotion means "stop replaying, start acting."

**Promotion must be a distinct, explicit state transition** with its own preconditions: the standby verifies it has consumed the journal to the primary's last known offset, that it holds a valid fence token (§56.5), and that it has completed exchange reconciliation. Promotion that skips reconciliation inherits every ambiguity of §56.3 while also racing a possibly-alive primary.

**Session-level constraints.** Exchange sessions are usually bound to credentials and often to a source IP or port. A standby cannot simply take over an active session; it must log on (Ch. 54 §54.1) with the correct sequence numbers, which requires the journal to have replicated the outbound sequence state. Some venues offer session-level failover facilities; most do not, and the standby's logon with `NextExpectedMsgSeqNum` is what recovers the exchange's pending resend.

---

## 56.5 Leader Fencing

**Fencing** is preventing a *deposed or presumed-dead* primary from continuing to act. It is the control that makes failover safe, and it is required because the failure detector is imperfect: a primary that stopped responding to heartbeats may be alive and merely stalled — swapping, GC-equivalent pause, a long page fault, a network partition — and it may resume at any moment with no knowledge that it was replaced.

Naive designs fail here: "the standby waits 5 seconds and then takes over" is not fencing, because the old primary can wake up at second 6 and send orders.

**The fence token** is the standard mechanism: a monotonically increasing integer issued by whatever authority grants leadership. Every action is tagged with the holder's token, and every *resource* rejects actions carrying a token lower than the highest it has seen.

```
Lease authority issues:  primary A gets token 7
A stalls; authority expires A's lease; standby B gets token 8
A wakes, sends order tagged 7  ──► resource sees 7 < 8, REJECTS
```

The essential property is that fencing is enforced **at the resource, not at the client**. A client that checks "am I still leader?" and then acts has a window between the check and the act — an unavoidable time-of-check/time-of-use race, and the stall can land exactly in that window. Only the resource, which sees the token on every request, can enforce the invariant.

For trading, the resources that can enforce fencing are limited, and this is the practical crux:

| Fencing point | Mechanism | Availability |
|---|---|---|
| Exchange session | Only one session may be logged on with given credentials; the second logon disconnects the first | Venue-dependent, but common and effective |
| Sequence numbers | The exchange rejects out-of-sequence messages from a stale primary | Automatic, partial |
| Shared journal file | `flock`/`fcntl` exclusive lock, or an epoch written into a header the writer re-checks | Local storage only |
| Network switch / ACL | Revoke the primary's port or ACL before promotion | Operationally heavy but decisive |
| Power (STONITH) | IPMI power-off of the old primary before promoting | Slow (seconds), absolutely decisive |

Exchange-enforced single-session logon is the most commonly relied-upon fence in practice: because the venue permits only one live session per credential, the standby's successful logon *is* the fence, and the old primary's writes fail on a dead socket. Knowing to name this — rather than reaching for a generic distributed-systems answer — is what a trading interviewer is listening for.

**Leases with clocks.** A lease grants leadership for a bounded time; the holder must renew before expiry. Safety requires the holder to *stop acting* before the authority considers the lease expired, which means accounting for clock error and message delay: `stop_acting_at = lease_start + lease_duration - max_clock_skew - max_message_delay`. If those bounds are wrong, the lease provides no safety at all — which is precisely why fence tokens, which need no clock assumptions, are preferred wherever a resource can check them.

---

## 56.6 Split-Brain Avoidance

**Split-brain** is two instances simultaneously believing they are primary. In trading the consequence is direct and expensive: both send orders, so the firm takes double the intended position, both compute risk against their own view so neither sees the true exposure, and the position limits (§56.15) are each satisfied while the aggregate is not.

Split-brain arises because a **network partition is indistinguishable from a crash** from the observer's side. A standby that has stopped hearing from the primary knows only "I cannot reach it," never "it is dead."

The avoidance strategies, in order of decisiveness:

1. **Single point of enforcement (preferred in trading).** Do not try to solve the general distributed-consensus problem; delegate the decision to the resource that already serializes access — the exchange session. If only one session per credential can be logged on, split-brain at the level that matters (order entry) is structurally impossible regardless of what the two hosts believe. Two processes may both *think* they are primary; only one can *trade*. This is a far stronger guarantee than any heartbeat scheme and requires no additional infrastructure.
2. **Quorum.** An odd-numbered set of arbiters (etcd, ZooKeeper, Raft) grants leadership only to a candidate holding a majority; a partitioned minority cannot obtain leadership and must stop. Correct, well-understood, and used for the control plane — but leadership acquisition takes tens to hundreds of milliseconds, and a quorum service is a runtime dependency on the trading path, so it is used to decide *who may be primary*, never consulted per order.
3. **STONITH / fencing the loser** (§56.5). Power off or network-isolate the old primary before promoting. Decisive; slow; requires out-of-band access that must itself be tested.
4. **Redundant, independent heartbeat paths.** Heartbeat over two physically separate networks plus a shared-storage or serial channel, so that a single network failure does not look like a host failure. Reduces the *frequency* of false failover but never eliminates it.
5. **Manual promotion.** For systems where the cost of a wrong automatic failover exceeds the cost of downtime — which for many order gateways is genuinely the case — require a human. This is a legitimate engineering answer, not an admission of defeat, and stating the reasoning (asymmetric cost of the two errors) is the point.

**The asymmetry argument** is the thing to articulate. Automatic failover trades availability against the risk of split-brain. For a market-data distributor, unavailability is the worse error and aggressive automatic failover is right. For an order gateway holding positions, a duplicate trading instance is far worse than a few seconds of not trading — so the bias should be toward *stopping*, and the standby's default on losing contact should be to remain passive and alarm, promoting only when it can prove exclusivity (a successful fenced logon) rather than merely infer the primary's death.

---

## 56.7 State Convergence After Failover

After promotion, the new primary's belief about the world must be reconciled with reality before it can trade. Its state has three defects: it may lag the journal, it does not know the outcome of the old primary's in-flight actions, and it cannot know whether the old primary acted between its last journal record and its death.

**Convergence sequence:**

1. **Drain the replicated journal** to its end, applying every record. Establish the highest journal offset the old primary durably wrote — anything beyond that was never durably intended.
2. **Establish exclusivity** (§56.5, §56.6): fenced logon to the exchange.
3. **Query authoritative state.** `OrderMassStatusRequest` returns every live order the exchange holds for the session — the definitive answer to "what am I actually exposed to." Positions come from the drop copy plus start-of-day, not from the failed primary's memory.
4. **Three-way reconcile** exchange truth against replayed belief:

| Exchange says | Replay says | Action |
|---|---|---|
| Live order X | Live order X, matching | Adopt; nothing to do |
| Live order X | Unknown | **Adopt as unmanaged** — cancel it, or bring it under management by `ClOrdID`. Never ignore. |
| Nothing | Live order X | The order died (rejected/cancelled/COD) or never existed. Mark terminal. |
| Live X, qty differs | Live X | A fill occurred that we did not replay. Update position from exchange truth. |

5. **Recompute all risk utilization** from reconciled positions — never carry forward a cached utilization figure across a failover (§56.22).
6. **Cancels first.** Enter a cancel-only state and flatten anything unrecognized before enabling new order entry.

The "exchange says live, we don't know it" case is the dangerous one: an **orphaned order**, live in the market and outside your model, unmanaged and unhedged. It arises whenever the old primary sent an order and died before its journal record was replicated — which is exactly why journal replication must be synchronous with respect to *sending*, i.e. the primary waits for the standby's acknowledgement of the journal record before transmitting the order. That wait costs a network round trip (~10–20 μs on a cross-connect), and whether to pay it is one of the genuine latency-versus-safety trade-offs in the system. The alternative — asynchronous replication plus mass-status reconciliation on failover — accepts a small window of orphans in exchange for the microseconds, and is a defensible choice provided the reconciliation is real and tested.

**Convergence must be verifiable.** Emit a structured reconciliation report on every failover: orders adopted, orders orphaned, position deltas applied, and the time taken. A failover that produces zero discrepancies every time is either well-built or not actually reconciling; inject faults (Ch. 57 §57.14) to confirm the path detects what it should.

---

## 56.8 Heartbeats and Watchdogs

A **heartbeat** is a liveness signal sent to an observer; a **watchdog** is a timer that fires an action if it is not reset. They are duals — the heartbeat proves you are alive to someone else, the watchdog acts when someone fails to prove it to you — and a reliable system needs both at several levels.

| Level | Detects | Typical period | Action on failure |
|---|---|---|---|
| Exchange session heartbeat (Ch. 54 §54.2) | Session/network death | 1–30 s | Disconnect, reconnect, COD |
| Internal thread watchdog | A stalled hot thread | 1–10 ms | Alarm; cancel-all; kill process |
| Inter-process heartbeat | A dead component | 10–100 ms | Failover, degrade |
| Market-data staleness (Ch. 53 §53.8) | Feed death or silent market | 100 ms–1 s | Widen or pull quotes |
| Host-level (hardware watchdog) | Kernel hang | 1–10 s | Reset the machine |

**The essential design rule: the watchdog must observe *progress*, not existence.** A thread that is alive but wedged — spinning on a value that never changes, blocked on a lock, or looping without processing — passes an "is the process running" check and fails the system. Implement the heartbeat as a **monotonic counter incremented in the work loop**, with the observer checking that it advanced:

```cpp
// Hot thread: a plain relaxed store, ~1 ns, no syscall, no allocation.
inline void beat() noexcept { hb_.store(hb_.load(rlx) + 1, std::memory_order_relaxed); }

// Watchdog thread, on a housekeeping core:
if (hb == last_hb_) {                      // no progress since last check
    if (++stalls_ >= threshold_) on_stall();   // cancel-all, alarm, escalate
} else { last_hb_ = hb; stalls_ = 0; }
```

Publish a *timestamp* alongside the counter if you need stall duration; a counter alone tells you it stopped but not when. Use `rdtsc` (Ch. 55 §55.6) so the hot side pays ~7 ns and never enters the kernel.

**The watchdog must not share fate with what it watches.** A watchdog thread in the same process dies with a `SIGSEGV`; a watchdog on the same core is preempted by the same event that stalled the worker; a watchdog whose alarm path allocates will itself stall under memory pressure. Layer them: an in-process watchdog on a housekeeping core (fastest, detects stalls), an out-of-process supervisor (survives crashes), and a hardware watchdog (survives kernel hangs).

**False positives are the real design risk.** A watchdog that cancels all orders because of a 5 ms GC-equivalent pause converts a minor stall into a trading outage. Tune thresholds from the *measured* distribution of loop intervals (Ch. 43 §43.4) — set the threshold well above the observed maximum over weeks, not at an intuited round number — and make the first escalation cheap (alarm, stop quoting) with the expensive one (kill process) requiring sustained failure.

**What the watchdog does on firing** must itself be pre-allocated and syscall-minimal, because it runs when the system is already unhealthy. Pre-build the mass-cancel message at startup (§56.19); do not construct it during the incident.

---

## 56.9 Fail-Open Versus Fail-Closed Behavior

Every control must define its behaviour when it cannot evaluate — when its input is stale, its dependency is down, or its state is uncertain. **Fail-closed** blocks; **fail-open** permits. Choosing wrongly, or worse, not choosing and inheriting whatever the code happens to do, is a leading cause of incidents.

The governing principle: **fail in the direction that reduces exposure.** For pre-trade risk this almost always means fail-closed, because the cost of blocking an order is a missed opportunity while the cost of permitting an unchecked one is unbounded loss. But the principle is about *exposure*, not about blocking, and that distinction generates the exceptions:

| Control | Uncertain state | Correct behaviour | Why |
|---|---|---|---|
| Position limit check | Position unknown (feed down) | **Closed** — reject new orders | Cannot bound exposure |
| Cancel path | Risk service down | **Open** — always allow cancels | Cancelling reduces exposure |
| Mass cancel / kill switch | Anything at all | **Open** — always allow | It is the last resort |
| Price collar (§56.13) | Reference price stale | **Closed** for aggressive orders | A stale reference is exactly when collars matter |
| Duplicate filter (Ch. 54 §54.9) | Filter saturated | **Open** — process the message | Dropping a real fill corrupts position silently |
| Market-data gap | Book incomplete | **Closed** — pull quotes | Quoting off a wrong book is adverse selection |
| Reference-data lookup miss | Unknown instrument | **Closed** — reject | Unknown tick size, multiplier, limits |

Note the pattern: controls that *authorize new exposure* fail closed; controls that *remove exposure* fail open; controls that *classify already-received information* fail toward processing it. Being able to state that taxonomy compactly is a strong answer.

**Fail-closed must be implementable without a code path that can itself fail.** The idiom is to make "permitted" require an affirmative, freshly-valid signal rather than the absence of a denial:

```cpp
// WRONG: a crashed risk thread leaves `blocked` false forever ⇒ fails OPEN silently.
if (risk_.blocked) return reject();

// RIGHT: permission is a positive, timestamped assertion that decays.
inline bool may_send(uint64_t now_tsc) const noexcept {
    return ok_.load(rlx) && (now_tsc - ok_tsc_.load(rlx)) < max_staleness_tsc_;
}
```

The decaying-permission pattern turns *any* failure of the risk evaluator — crash, stall, deadlock, partition — into fail-closed automatically, with no explicit error detection. It costs two relaxed loads and a compare, ~2 ns, and it is one of the highest-value idioms in this chapter.

**Where fail-closed is dangerous** is when it is *global and automatic on a noisy signal*: a control that halts all trading whenever a metric exceeds a threshold, on a metric that spikes spuriously, produces outages. Fail-closed should be scoped as narrowly as the uncertainty is — this instrument, this venue, this strategy — with global halts reserved for controls whose signals are unambiguous.

---

## 56.10 Burst Capacity Planning

Systems are sized by average rate and killed by bursts. Market-data bursts are extreme and structural: quiet-period rates of a few thousand messages/second give way to opening auctions, macroeconomic releases, and cascading events with **10–100× instantaneous peaks** lasting microseconds to seconds. The relevant number is not messages per day but messages per microsecond during the worst 10 ms of the year.

**Where bursts hurt**, in the order they bite:

1. **NIC ring** (Ch. 46 §46.3, Ch. 48 §48.13). If descriptors are exhausted before software drains them, packets are dropped in hardware — visible only in `ethtool -S` counters (`rx_missed_errors`, `rx_no_buffer`), not in application logs. Diagnostic signature: a market-data sequence gap with no loss anywhere on the network.
2. **Inter-stage queues** (Ch. 52 §52.10). Fill up, then either block the producer (backpressure propagating to the network) or drop.
3. **Compute.** Per-message cost that was fine at 100k/s is not at 5M/s; a 200 ns handler saturates a core at 5 M/s.
4. **Order gateway throttle** (Ch. 54 §54.12). A burst of market data produces a burst of orders, which meets the venue's rate limit.
5. **Warm-path consumers** — journal writer, logger, metrics — which fall behind and either backpressure or drop.

**Sizing methodology.** Queues must absorb `peak_rate × burst_duration` beyond what the consumer can drain: `capacity ≥ (λ_peak − μ) × T_burst`. With λ_peak = 5 M msg/s, μ = 2 M msg/s, and T_burst = 10 ms, capacity must exceed 30,000 messages. At 64 bytes per entry that is ~2 MB — trivial memory, and vastly cheaper than the alternative. **Queues are cheap; drops are not.** Size generously, then alarm on watermarks (§56.11) rather than sizing tightly and hoping.

The counter-argument, which must be acknowledged: an over-deep queue converts loss into *latency* (bufferbloat, Ch. 38 §38.19). A gateway that queues 30,000 messages and processes them 15 ms late has produced stale decisions, which for a trading system may be worse than dropping. The resolution is **deep buffers with a staleness policy**: absorb the burst, but discard entries older than a threshold at dequeue, and count them. That way a transient burst is absorbed losslessly while a sustained overload sheds deterministically rather than trading on history.

**Measure the true peak.** Application-level counters undercount because they never see hardware drops. The credible measurement is a hardware-timestamped capture (Ch. 48 §48.4) bucketed at microsecond granularity — a feed averaging 200k msg/s routinely shows 10 μs windows at an instantaneous rate above 5 M/s, because messages arrive in wire-rate bursts, not smoothly. Sizing to the average is how systems drop packets on days that matter.

**Headroom.** Plan the steady-state hot path to run below ~50% of a core's capacity. Above that, queueing theory guarantees the tail explodes (Ch. 52 §52.14): at 80% utilization mean queueing delay is 4× the service time and the p99.9 far worse. Utilization headroom *is* tail-latency budget.

---

## 56.11 Queue-Watermark Alarms

A queue's depth is the earliest quantitative signal that a system is losing the race. Latency percentiles report the problem after it has happened; queue depth reports it while there is still headroom.

**Instrumentation that costs nothing.** The producer and consumer sequence numbers already exist in any ring buffer (Ch. 26 §26.5); depth is their difference, computed by an observer, so the hot path pays nothing:

```cpp
// Observer thread; producer/consumer never do this work.
uint64_t depth = ring.write_seq.load(rlx) - ring.read_seq.load(rlx);
hwm_ = std::max(hwm_, depth);          // high-water mark since last export
```

Record and export, per queue, per interval: **current depth, high-water mark, count of times each watermark was crossed, time spent above each watermark, and drops**. The high-water mark is the important one — a queue that touched 90% for 200 μs and drained shows an average depth near zero and is invisible in every metric except HWM. Reset HWM on export so each interval reports its own peak.

**Three thresholds with three different responses** is the standard structure:

| Watermark | Meaning | Response |
|---|---|---|
| ~50% | Consumer falling behind | Metric only; investigate trends |
| ~75% | Sustained overload approaching | Degrade (§56.12): shed optional work, stop non-essential processing |
| ~90% | Loss imminent | Shed load explicitly, alarm, and if it is the order path, stop quoting |
| 100% | Drops occurring | Count every drop; never drop silently |

**Alarm on the right statistic.** Alarming on instantaneous depth produces noise (any burst crosses it); alarming on *time spent above* a watermark within a window separates a healthy 50 μs burst from a genuine 5 ms overload. The rate of change matters too: depth rising monotonically over several intervals indicates the consumer is structurally too slow and will not recover, which is a different incident from a burst.

**Drop accounting is mandatory.** Every drop must be counted and attributed by queue and reason. A system that drops silently produces the worst diagnostic situation in this book: a downstream inconsistency (a missing fill, a stale book) with no evidence of its cause. The counter costs one increment on a path that is already failing.

**Watermarks on the producer side too.** A bounded queue that applies backpressure does not drop — it stalls the producer, which for a feed handler means the NIC ring fills and *hardware* drops. Monitoring only the software queue therefore shows a healthy system while packets vanish. Correlate software queue depth against NIC drop counters; the pair identifies exactly where the bottleneck sits.

---

## 56.12 Graceful Degradation

Graceful degradation is the design of *pre-planned* reduced modes of operation, so that overload or partial failure produces a defined, safe, reduced service rather than an undefined one. The alternative — a system that behaves correctly until it does not — fails in whatever manner the first exhausted resource dictates, which is never the manner you would have chosen.

**The degradation ladder**, from cheapest to most drastic, each triggered by a specific measured signal:

| Level | Trigger | Action | Preserved |
|---|---|---|---|
| 0 | Normal | Full operation | Everything |
| 1 | Queue > 50%, CPU > 60% | Drop metrics sampling, reduce logging verbosity, coarsen histograms | Trading unaffected |
| 2 | Queue > 75% | Stop processing non-essential instruments/feeds; suspend analytics | Core instruments |
| 3 | Queue > 90%, or feed gap (Ch. 53 §53.4) | Stop quoting; cancels and risk-reducing orders only | Risk management |
| 4 | Stale market, risk service down, watchdog stall | Mass cancel (§56.19); order entry disabled | Flat/known state |
| 5 | Unrecoverable | Kill switch (§56.18); halt | Nothing but safety |

Two properties make a ladder work rather than merely exist:

**Hysteresis.** Entering level 3 at 90% and leaving at 90% produces oscillation — the system flaps between quoting and not, which is worse than either state. Use separate thresholds (enter at 90%, exit at 60%) and a minimum dwell time. This is the same design as a Schmitt trigger and the reasoning is identical.

**Degradation must not allocate, block, or depend on the failing resource.** The path into level 4 runs when the system is already sick: its messages are preallocated, its code is warm (exercised in test, and ideally periodically in production), and it must not require the component that failed. A degradation path that calls into the risk service to ask permission to cancel is not a degradation path.

**Shed the right work.** Load shedding must be *selective and deterministic*, not "process whatever fits." Rank work by value: risk-reducing actions first, core instruments next, ancillary feeds last. Random shedding produces a partially-updated book, which is worse than a knowingly-stale one, because you cannot tell which parts are wrong — this is the same argument as Ch. 53 §53.8: **known-stale beats unknown-partial.**

**Exercise it.** A degradation mode that has never run in production is a hypothesis. Trigger levels 1–3 deliberately during quiet periods, in production, on a schedule. Firms that do this discover the preallocated cancel message was never initialized; firms that do not discover it during an incident.

---

## 56.13 Pre-Trade Price Collars

A **price collar** (or price band, price check) rejects orders whose limit price is too far from a reference price. It is the control that catches a decimal-point error, a corrupted book, a unit mismatch, or a strategy that computed a nonsense price — before it becomes a trade at an absurd level.

**Reference-price selection is the entire design problem**, because the collar is only as good as its reference:

| Reference | Strength | Weakness |
|---|---|---|
| Current best bid/offer (Ch. 49 §49.1) | Most current | Can itself be corrupt or crossed; unavailable in a gap |
| Last traded price | Real, confirmed | Lags; absent in illiquid instruments |
| Previous close / official reference | Stable, exchange-published | Stale intraday during real moves |
| Exchange price band (Ch. 49 §49.13) | Authoritative — the venue will reject outside it anyway | Wide; a backstop, not a control |
| Rolling median of recent trades | Robust to single bad prints | Requires state and a window |

The robust construction uses a **primary reference with fallbacks and an explicit staleness bound**: use the BBO midpoint if the book is valid and fresh; else the last trade if within N seconds; else the previous close; and if all are stale, **fail closed** for aggressive orders (§56.9). The staleness check is essential — a collar computed against a reference frozen 30 seconds ago during a fast move will reject every legitimate order (an outage) or, if the market moved the other way, permit exactly the bad ones.

**Band shape.** Bands are usually expressed as a percentage of reference, plus a floor in ticks (Ch. 49 §49.7) so that low-priced instruments are not banded to zero width, and are widened for volatile instruments and around events (open, close, halts and their resumptions). Asymmetry matters: a buy order priced far *below* the market is harmless (it will not trade); one priced far *above* is the fat-finger case. Collaring both directions equally rejects benign passive orders and generates noise; collar aggressively in the direction that can trade immediately.

**Implementation on the critical path.** This must cost a few nanoseconds:

```cpp
// Per-instrument, one cache line, updated by the book builder, read by the order path.
struct Collar { int64_t lo_ticks, hi_ticks; uint64_t stamp_tsc; };

inline bool price_ok(const Collar& c, int64_t px, uint64_t now) noexcept {
    return (now - c.stamp_tsc) < kMaxStale
        && px >= c.lo_ticks && px <= c.hi_ticks;      // two compares, integer
}
```

Precompute the *bounds* rather than the percentage: the book builder recomputes `lo_ticks`/`hi_ticks` when the reference moves (off the order path), so the order path performs integer comparisons only — no multiplication, no floating point, no division. All arithmetic is fixed-point in ticks (Ch. 23 §23.10); floating-point comparison here would introduce rounding at exactly the boundary the control defines.

**Failure signature.** Collars rejecting a burst of legitimate orders during a fast move means the reference is stale or the band is too tight for the regime; collars never firing over months means they are too wide to catch anything and give false assurance. Both require the same instrumentation: log every rejection with the price, reference, and band, and review the distribution.

---

## 56.14 Fat-Finger and Notional Limits

A **fat-finger check** bounds the *size* of a single order — quantity, notional value, or both — to catch magnitude errors: an extra zero, a quantity in shares where the API expected lots, a size computed from an uninitialized variable, or a strategy scaling bug.

**Notional** is `quantity × price × contract_multiplier` (Ch. 49 §49.8), and getting that arithmetic right is half the control:

```cpp
// Fixed point throughout. price_ticks × tick_value gives price in scaled currency.
inline bool notional_ok(int64_t qty, int64_t px_ticks,
                        const Instrument& i, int64_t limit) noexcept {
    __int128 n = __int128(qty) * px_ticks * i.tick_value_scaled * i.multiplier;
    return n <= __int128(limit) * i.scale;
}
```

The details that matter:

- **Overflow.** `quantity × price` overflows `int64_t` for large notionals in scaled units. A silent overflow produces a *small* result that passes the check — the failure mode is exactly inverted from what you want. Use `__int128`, or checked arithmetic (Ch. 23 §23.12), or bound the inputs first so the product cannot overflow. This is the single most commonly probed detail in this section.
- **Never floating point.** A `double` has 53 bits of mantissa and silently loses precision above 2^53; worse, comparisons at the boundary become non-deterministic across compilers and optimization levels (Ch. 2 §2.8). Every risk comparison must be exact integer arithmetic.
- **Multiplier and unit errors are the point of the check**, so the check must not itself use the suspect conversion. Validate `contract_multiplier` and tick value at reference-data load time (Ch. 60 §60.9), assert their plausibility, and fail closed on a missing instrument (§56.9).

**Layered limits.** A single limit is either too tight for the largest legitimate order or too loose to catch a 10× error. The standard construction is several independent bounds, each cheap:

| Limit | Catches |
|---|---|
| Max quantity per order (§56.16) | Extra digit, unit confusion |
| Max notional per order | Large quantity in an expensive instrument |
| Max notional per second / per interval | Many individually-legal orders from a runaway loop (§56.17) |
| Max aggregate open notional | Cumulative build-up |
| Percentage of average daily volume | Orders too large for the instrument's liquidity |

Each is a compare against a preloaded per-instrument value; the whole battery costs perhaps 5–15 ns and fits in one or two cache lines if the limits are stored contiguously per instrument. **Lay them out as a struct-of-limits indexed by instrument ID**, so one cache line load serves the entire check set — this is data-oriented design (Ch. 42 §42.1) applied to risk.

**Configuration is the weak point.** Limits arrive from a config file or a risk database, and a mistyped limit is a control that does not control. Validate at load: every limit positive, within a plausible range, and no instrument missing. Make limit changes journaled (§56.1), audited (Ch. 60 §60.11), and applied atomically (§56.22) — a limit change that is partially visible allows an order that neither the old nor the new configuration permits.

---

## 56.15 Position and Credit Limits

A **position limit** bounds the signed net quantity (or notional) held in an instrument, an instrument group, or overall. A **credit limit** (buying power) bounds the capital committed, usually imposed by a clearing firm or the venue and shared across all of a firm's activity.

Position limits are harder than fat-finger checks because they are **stateful and shared**: the check depends on a quantity that changes with every fill, and multiple strategies or gateways may consume the same budget.

**The exposure equation** — and the reason a naive implementation is wrong:

```
exposure = filled_position
         + working_buy_qty          (orders that could fill and increase long)
         + in_flight_buy_qty        (orders sent, not yet acked — MIGHT be live)
```

Checking against `filled_position` alone permits sending orders whose *aggregate potential* fills far exceed the limit. The check must reserve against **potential** exposure, not realized: increment the reservation when an order is *sent*, decrement when it is rejected, cancelled, or expires, and convert reservation to position when it fills. This is a two-sided accounting problem where every state transition of the order state machine (Ch. 54 §54.8) must adjust exactly one counter exactly once — which is precisely why that state machine must be idempotent, because a double-applied fill also double-counts the position.

```cpp
// Reservation on send; the ONLY place exposure can grow.
inline bool reserve(InstrPos& p, int64_t qty, int64_t limit) noexcept {
    int64_t proposed = p.net + p.pending_buy + qty;   // signed; symmetric for sells
    if (proposed > limit || proposed < -limit) return false;
    p.pending_buy += qty;
    return true;
}
```

**Conservatism at the boundaries.** Long and short must be bounded independently, not netted, when the risk is directional: `+1000/−1000` nets to zero but is two live positions with basis risk. Compute both a net and a gross (sum of absolute values) exposure and limit both.

**Single-writer or exact atomics.** If one thread owns the position for an instrument, the check and reservation are plain non-atomic reads and writes — a few nanoseconds. If multiple threads share it, the check-and-reserve must be **atomic together**, or two threads each pass a check that only one should: the classic TOCTOU race, and in this domain it means exceeding a limit. A CAS loop on a packed 64-bit `{net, pending}` word is the standard fix; better still, shard the limit — give each gateway a fixed sub-budget so no cross-thread coordination is needed on the hot path, with rebalancing done off it. Sub-budgeting trades a little capital efficiency for the removal of a contended atomic and is the usual production answer.

**Credit limits** are typically venue- or broker-enforced in addition to your own, and their rejection arrives as an order reject at the worst moment. Shadow them locally at a stricter threshold (the same reasoning as rate limits, Ch. 54 §54.11): you cannot read the authoritative counter, so run below it. Credit consumption also depends on margin rules that are not linear in position — offsetting positions may reduce requirement — so the local shadow must be conservative, i.e. assume no offset unless proven.

**Recomputation after any uncertainty.** After a failover, a reconnect, or a reconciliation break, positions must be recomputed from authoritative sources (drop copy plus start-of-day) rather than carried forward (§56.7, §56.22). A cached utilization figure that survived an incident is a limit that no longer limits.

---

## 56.16 Maximum Order Quantity

A maximum-order-quantity check is the simplest control in the chapter and worth a section because it is the archetype of "cheap, absolute, always on."

It is a single unsigned comparison against a per-instrument constant:

```cpp
if (__builtin_expect(qty > limits[instr].max_qty, 0)) return reject(Reason::MaxQty);
```

One load (already in the cache line holding the instrument's other limits, §56.14) and one predictable compare: **under 1 ns amortized**. There is no latency argument against it, which is exactly why it is the control that should never be disabled, bypassed, or made conditional. Interviewers use it to probe whether a candidate reflexively resists all checks on the hot path or reasons about their actual cost.

The design details that are not obvious:

- **Units.** The limit and the order must be in the same unit — shares, contracts, or lots — and the venue's unit is not necessarily yours (Ch. 49 §49.8). A limit expressed in lots compared against a quantity in shares is off by the lot size, typically 100×, and fails open. Encode the unit in the type, not in a comment:

  ```cpp
  struct Shares   { uint64_t v; };   // distinct types; no implicit conversion
  struct Lots     { uint64_t v; };
  ```
  Strong typedefs cost nothing at runtime and eliminate an entire bug class at compile time. This is a good place to mention them, because they are cheap, obviously correct, and rarely used.
- **Zero and negative.** Quantity must be strictly positive. A zero-quantity order is a protocol error at most venues; a negative quantity reaching an unsigned field wraps to an enormous value, which the max check then catches — but only if the check happens after the conversion, not before. Validate at the boundary where the value enters, in its signed form.
- **Replace semantics.** A cancel/replace that *increases* quantity must be re-checked against the limit and against position reservations (§56.15). Systems that check only on new orders are bypassed by replace, and this is a real, recurring bug.
- **Per-instrument, not global.** A single global maximum is either too large for liquid instruments or too small for illiquid ones. Store limits per instrument, contiguously, indexed by dense instrument ID so the lookup is an array index and the whole limit set shares a cache line.
- **Interaction with venue limits.** Venues impose their own maximum order size; exceeding it is a reject, which costs a round trip and consumes rate-limit budget (Ch. 54 §54.11). Load the venue's published maximum as an upper bound on your own, so you never send an order that is certain to be rejected.

---

## 56.17 Runaway-Strategy Detection

A **runaway** is a component emitting orders at a rate or in a pattern that no correct operation would produce — a loop that resubmits on every tick, a feedback cycle where the strategy reacts to its own orders in the market-by-order feed, a state machine stuck in a resubmit-cancel cycle, or a mispriced quoter repeatedly filled and re-quoting. Individually each order may pass every limit in §56.13–§56.16; the aggregate is the problem.

Detection is therefore about **rates and ratios over windows**, not per-order checks:

| Signal | What it catches | Typical window |
|---|---|---|
| Orders per second per strategy/instrument | Loops, runaway quoting | 1 s, 10 s |
| Order-to-trade ratio (Ch. 54 §54.11) | Churn without economic activity | Minutes |
| Cancel-to-new ratio | Modify/cancel cycling | 1 s |
| Repeated identical orders (same price/qty/side) | Idempotency or retry bug | Rolling N |
| Position change rate | Rapid accumulation | 1 s |
| Realized loss rate | Systematically wrong pricing | 1 s, 1 min |
| Self-trade attempts (§56.20) | Two components of the same firm fighting | Any occurrence |

**Implementation cost.** These are counters and ring-based windows, all on the hot path, all a few nanoseconds:

```cpp
// Fixed-window rate counter: one branch, one increment. No allocation, no lock.
inline bool rate_ok(RateWin& w, uint64_t now_tsc) noexcept {
    if (now_tsc - w.window_start >= w.window_len) { w.window_start = now_tsc; w.count = 0; }
    return ++w.count <= w.limit;
}
```

Use a sliding window (a ring of timestamps, Ch. 54 §54.12) where the fixed-window's 2× boundary burst is unacceptable. Both are allocation-free and single-writer.

**Escalation, not a binary.** A runaway detector wired directly to a full kill switch will eventually fire on a legitimate burst and cause an outage. The standard ladder mirrors §56.12: first alarm, then throttle the offending component specifically, then disable *that* strategy's order entry while leaving others running, then kill-switch globally. Scope the response as narrowly as the evidence supports.

**The self-referential trap.** The most instructive runaway class is a strategy reacting to its own activity: it places an order, sees it in the market-by-order feed, interprets it as new external interest, and responds — a positive feedback loop that can go from normal to thousands of orders per second in milliseconds. The structural defence is to **tag and filter your own orders out of the market-data view** by exchange `OrderID` or participant identifier before the strategy sees them, which is a data-plumbing fix, not a risk-check fix, and is the better answer.

**Time constants.** A runaway can exhaust a rate limit or build a large position in **tens of milliseconds**. A detector polling once a second is too slow. The checks must be inline on the order path, evaluated per order, and the response must be executable in the same thread — pre-built cancel messages, no allocation, no cross-process call. A detector implemented as a monitoring dashboard is not a control.

---

## 56.18 Trading Kill Switches

A **kill switch** is the control that stops all order entry and cancels working orders. It is the last line of defence and it is judged entirely by whether it works when everything else has failed.

**Requirements, each of which excludes a common implementation:**

| Requirement | Excludes |
|---|---|
| Must work when the trading process is stalled or wedged | An in-process flag checked only in the event loop |
| Must work when the risk service is down | A kill that requires querying anything |
| Must not allocate, block, or need a healthy heap | Anything constructing messages on demand |
| Must be triggerable by a human in seconds, without a deploy | Config-file changes requiring a restart |
| Must be triggerable automatically | A purely manual button |
| Must be idempotent and safe to trigger spuriously | Anything with side effects beyond stopping |
| Must be testable in production | Anything whose only test is a real incident |

**Layered implementation**, because no single layer satisfies all of them:

1. **In-process flag.** A single relaxed atomic checked on the order-send path — ~1 ns, and it is the fastest path to stopping. Use the decaying-permission pattern (§56.9) so that a stalled risk evaluator also trips it.
2. **Out-of-process supervisor.** A separate process that can signal, and if necessary `SIGKILL`, the trading process. Survives a wedged trading process; combined with venue cancel-on-disconnect (Ch. 54 §54.13), killing the process cancels the orders — this is why COD semantics must be known and tested (a venue that does *not* cancel on disconnect makes `SIGKILL` a way to orphan every order).
3. **Venue-side controls.** Most exchanges offer a risk-management interface — a port disable, a self-imposed halt, or a broker-level kill — which works regardless of the state of anything in your building. This is the only layer that survives a total loss of your infrastructure and it should be part of the runbook.
4. **Network-level.** Disabling the switch port or applying an ACL stops order flow with certainty and no cooperation from the application. Blunt, decisive, and it leaves working orders in the market — so it is a containment tool, not a flattening tool.

**Scope.** A single global kill is too blunt for routine use. Provide kill switches per strategy, per instrument, per venue, and globally, sharing one mechanism, so that the response can match the fault (Ch. 60 §60.4). Each scope is an index into a preallocated bitmap checked with one load and one test.

**Cancel-on-kill.** Stopping new orders is not enough — working orders remain live and can fill. A kill must also mass-cancel (§56.19). Sequence it correctly: **disable new order entry first, then cancel**, or the cancel races new orders being sent and you cancel into a stream of replacements.

**Restart is the hard part.** Re-enabling after a kill must go through the full reconciliation of §56.3 — the state at the moment of the kill is by definition suspect. Make re-enable deliberate, audited, and two-person where policy requires; an automatic re-enable after a timeout can restart the exact condition that caused the kill.

**Test it in production**, on a schedule, in a controlled window. A kill switch verified only in staging is verified against a different network, different venue configuration, and different process state.

---

## 56.19 Mass Cancel

**Mass cancel** removes many or all working orders with a single instruction. It matters because cancelling orders individually is bounded by the rate limit: 500 working orders at a 200 messages/second cap takes 2.5 seconds — an eternity during the event that made you want to cancel.

Three mechanisms, in decreasing preference:

| Mechanism | Latency | Coverage | Notes |
|---|---|---|---|
| **Venue mass-cancel message** (`OrderMassCancelRequest`, `MsgType=q`; native equivalents) | One message, venue-side execution | Per session, instrument, group, or all | Preferred; usually exempt from or cheap against rate limits |
| **Venue "cancel-on-disconnect"** by deliberately dropping the session (Ch. 54 §54.13) | Venue detection interval (up to its heartbeat timeout) | Session scope; GTC often exempt | Blunt backstop; loses the session |
| **Iterated individual cancels** | Bounded by rate limit | Complete and precise | Fallback; must use reserved throttle budget |

**Engineering the fast path.** The mass-cancel message must be **preallocated and pre-encoded at startup** (Ch. 55 §55.10), sitting in a warm buffer with only a `ClOrdID` and a sequence number to fill in. The trigger path — from watchdog, kill switch, or risk breach — must be: set flag, patch two fields, write to the NIC. No allocation, no formatting, no lock, no lookup. Measured, this should be **under a microsecond** from decision to wire.

```cpp
struct MassCancelReady {
    std::byte buf[kMassCancelLen];   // pre-encoded at startup, resident, warm
    uint32_t  clordid_off, seq_off;  // the only fields that change
};
```

**Semantics to verify per venue**, because they differ and the differences are consequential:

- **Scope.** Does it cancel across all sessions for the firm, or only this session's orders? Orders placed on another session may survive.
- **Acknowledgement.** Does it return one ack, or an individual cancel report per order? The latter is a burst of inbound messages arriving precisely when the system is stressed — your receive path must absorb it (§56.10).
- **Race with in-flight orders.** Orders sent before the mass cancel but not yet acked at the venue may be accepted *after* it and survive. This is why order entry must be disabled first (§56.18) and why a mass cancel must be followed by a **verification pass**: query working orders (`OrderMassStatusRequest`) and confirm the set is empty, cancelling any stragglers individually.
- **Partial failure.** A mass cancel may fail for some orders (in a crossing state, mid-auction, halted instrument). The response must be inspected, not assumed successful.

**Mass cancel is not flattening.** It removes *working orders*; it does not close *positions*. A firm that mass-cancels still holds everything it has already traded, and reducing that requires sending new orders — which the kill switch has just disabled. Resolving that tension is a policy decision, but the engineering requirement is that the two capabilities be independently controllable: a kill switch that blocks the hedge is a control that increases risk.

---

## 56.20 Self-Trade Prevention

A **self-trade** (wash trade) occurs when two orders from the same firm, or the same designated entity, match against each other. It is prohibited or restricted at most venues because it creates the appearance of activity without a change in beneficial ownership; it also produces real costs — exchange fees on both sides, distorted internal position accounting, and regulatory attention.

Two layers of prevention, and both are needed:

**1. Venue-side self-trade prevention (STP / self-match prevention).** Most modern venues accept a **self-match prevention identifier** (a trading group or MPID) on each order; when two orders bearing the same identifier would match, the venue applies a configured instruction:

| Instruction | Effect | Choose when |
|---|---|---|
| Cancel newest (CN) | The incoming aggressive order is cancelled | Protecting resting queue position (Ch. 49 §49.3) |
| Cancel oldest (CO) | The resting order is cancelled; the aggressor trades | The new order's intent is more current |
| Cancel both (CB) | Both removed | Simplest; loses both |
| Decrement and cancel | Reduce both by the overlap | Preserves residual size |

The choice is not incidental: cancel-oldest destroys a queue position that may have taken minutes to earn, while cancel-newest may block an urgent risk-reducing order. Configure per strategy pair, not globally, and know which of your orders can be silently cancelled by another of your strategies — a strategy that does not model this sees unexplained cancels and may retry, producing a loop (§56.17).

**2. Internal prevention**, which is strictly better where it is possible because it never reaches the venue at all. Before sending an aggressive order, check the firm's own working orders on the opposite side at crossing prices:

```cpp
// Per instrument: best own bid and best own ask, maintained by the order manager.
struct OwnBook { int64_t best_bid_ticks, best_ask_ticks; };

inline bool would_self_trade(const OwnBook& o, Side s, int64_t px) noexcept {
    return (s == Side::Buy)  ? px >= o.best_ask_ticks
                             : px <= o.best_bid_ticks;
}
```

Two integer comparisons against a per-instrument cache line — a few nanoseconds. Maintaining `best_bid`/`best_ask` of your own orders costs an update per order state change, off the check path.

**The hard cases** that separate a real implementation:

- **Scope of "self."** Legal entity, trading group, MPID, and account are different scopes with different rules, and the venue's definition governs. Two strategies in the same firm may be permitted to trade with each other under some regimes and not others; this is a compliance input to the engineering, not an engineering choice.
- **The race.** Between your check and the venue's match, the market moves; an order you thought was passive becomes crossing. Internal prevention reduces incidence but cannot be exact, which is why venue-side STP is the authoritative layer and the internal check is an optimization that saves fees and round trips.
- **Interaction with mass cancel and failover.** After a failover, the new primary's `OwnBook` must be rebuilt from reconciled working orders (§56.7) before it can perform this check — another control that must fail closed while state is unknown.

---

## 56.21 Duplicate-Order Protection

Duplicate *orders* are distinct from duplicate *messages* (Ch. 54 §54.9): a duplicate message is a repeated transmission the exchange deduplicates by `ClOrdID`, whereas a duplicate order is a second, genuinely distinct order with a fresh `ClOrdID` that the firm did not intend to place. The exchange cannot detect the latter — every duplicate order is, to the venue, a valid new order — so the control must be entirely yours.

Sources, each with a different defence:

| Source | Defence |
|---|---|
| Retry after a timeout on an unacked order | Never resend; query by `ClOrdID` (Ch. 54 §54.10) |
| Recovery replay re-emitting a journaled send | Suppress sends for records already confirmed sent (§56.3) |
| Split-brain: two primaries both acting | Fencing and exclusive session (§56.5, §56.6) |
| Strategy loop re-deciding the same thing each tick | Intent deduplication (below) |
| Operator submitting twice | UI-level and gateway-level dedup |

**Intent deduplication** is the general mechanism: hash the *semantic content* of the order — instrument, side, price, quantity, strategy, and a time bucket — and reject a second order with the same fingerprint within a short window, unless it is explicitly marked as an intended repeat.

```cpp
inline uint64_t fingerprint(const OrderReq& r) noexcept {
    uint64_t h = 0xcbf29ce484222325ull;
    for (uint64_t v : { uint64_t(r.instr), uint64_t(r.side),
                        uint64_t(r.px_ticks), uint64_t(r.qty), uint64_t(r.strategy) })
        h = (h ^ v) * 0x100000001b3ull;
    return h;
}
// Reject if seen within window; open-addressed preallocated table, ~5 ns (Ch. 54 §54.9).
```

This deliberately catches some legitimate cases — a strategy that genuinely wants two identical orders (splitting a large order, replenishing a quote) — so it must be **opt-out per strategy** with an explicit intent flag, and the window must be short (tens to hundreds of milliseconds). A dedup window that is too long converts a safety control into a trading bug, and this trade-off is the substance of the design.

**The failure-direction question**, which an interviewer will ask, inverts relative to Ch. 54 §54.9: message deduplication fails *open* because dropping a real fill silently corrupts position, while order deduplication fails *closed* because sending a duplicate order creates real, unintended exposure. Same word, opposite bias, and the reason is the same principle — **fail in the direction that reduces exposure** (§56.9). Being able to state both cases and reconcile them under one rule is a strong answer.

**Detection after the fact.** No prevention is complete, so monitor for duplicates continuously: identical orders within a window, an order count that exceeds the strategy's decision count, and reconciliation breaks with matching quantities but differing execution counts (Ch. 54 §54.15). The last signature specifically names a duplication bug and is worth remembering.

---

## 56.22 Risk-State Consistency

Every control in this chapter depends on state — positions, utilization, limits, kill-switch flags, collar bounds — and that state is read on the hot path by one thread while being updated by others. **Consistency is the property that a check never evaluates against a mixture of old and new values**, and it is where subtle risk failures live, because an inconsistent check silently permits what neither the old nor the new state would have.

**The three hazards:**

1. **Torn reads.** A limit expressed as `{min, max}` across two words, updated non-atomically, can be read as old-min with new-max — a range neither configuration ever defined. Any multi-field risk value must be published atomically.
2. **Stale reads.** A cached position that is 50 ms old is a limit that permits 50 ms of unlimited trading, which at hot-path rates is a large number of orders.
3. **Check-then-act races.** Two threads each read utilization, each find room, each send — and the aggregate exceeds the limit. Correct only if check and reserve are one atomic operation, or if a single thread owns the counter (§56.15).

**The publication mechanisms**, matched to update frequency:

| State | Frequency | Mechanism |
|---|---|---|
| Kill-switch flags | Rare | Single relaxed atomic; ~1 ns read |
| Limits and collar bounds | Rare (config, or per book update) | **Seqlock** (Ch. 55 §55.5) or atomic pointer swap to an immutable snapshot |
| Position and utilization | Every fill | Single-writer plain fields, or sharded sub-budgets |
| Whole risk configuration | Rare, must be all-or-nothing | Build a new immutable image off the hot path; publish with one release store of the pointer |

**Atomic configuration swap** is the general solution for grouped state and is worth writing out:

```cpp
// Cold thread: build an entirely new image, then publish with one store.
auto* next = pool_.acquire_image();          // preallocated, no allocation
build(*next, new_config);
current_.store(next, std::memory_order_release);
// Hot thread: one acquire load; the image it holds is internally consistent forever.
const RiskImage* img = current_.load(std::memory_order_acquire);
```

The old image cannot be freed immediately — a hot thread may still hold a pointer to it. Reclaim with epoch-based reclamation, hazard pointers, or, simplest and entirely adequate here, a deferred free after a bound comfortably exceeding the maximum hot-path iteration time (Ch. 26 §26.11–§26.13). This gives **all-or-nothing configuration updates at a cost of one acquire load** on the hot path, and it removes the entire class of partially-applied-config bugs.

**Consistency across processes.** When risk state is shared between the gateway, a risk service, and a monitor, the rules of Ch. 3 §3.12 apply: no pointers, no vtables, fixed layout, and `std::atomic<T>::is_always_lock_free` asserted or you get no cross-process atomicity at all. The single-writer discipline extends naturally — one process owns each piece of risk state and others read it through a seqlock in shared memory.

**Reconstruct rather than carry forward.** After any event that makes state suspect — crash, failover, reconnect, reconciliation break — utilization must be **recomputed from authoritative positions**, never restored from a cached figure. A carried-forward utilization is the mechanism by which an incident's risk error survives the incident's resolution.

**Verification.** Continuously recompute risk state from first principles on a warm thread and compare against the hot path's incremental values; any divergence is a bug in the incremental accounting and is otherwise invisible until it matters. This is differential testing (Ch. 57 §57.3) applied in production, and it is the single most effective way to catch accounting errors in a system where the incremental path must stay fast.

---

## Key Interview Questions

1. **Why must the journal be written before the order is sent?** — A crash between journaling and sending yields a duplicate, which the exchange rejects on `ClOrdID`; the reverse yields a live order the system does not know about, which is unrecoverable.
2. **How do you make a durable journal append fast enough for the hot path?** — `mmap` a preallocated, prefaulted, `mlock`ed `MAP_SHARED` segment; append is a `memcpy` plus a release store of the length, 20–60 ns, no syscall. Publish the length *last* so recovery never sees a torn record.
3. **Does `mmap` give you durability?** — Visible durability (survives process crash via the page cache), not power-loss durability. For the latter use `msync`/`fsync` — or better in trading, replicate to a second host: a 10–20 μs network round trip beats a 50–200 μs NVMe `fsync` and survives more failure modes.
4. **State the exact correctness condition for a checkpoint.** — A checkpoint tagged with journal offset P must equal the state produced by processing every record before P and none at or after it. Violation in either direction is silent corruption.
5. **How do you publish a checkpoint atomically?** — Write to a temp file, `fsync` the file, `rename()` into place, then `fsync` the directory. The directory `fsync` is the part usually missed.
6. **Why is `fork()`-based snapshotting risky in a latency-critical process?** — The fork copies page tables (hundreds of μs to ms for a large address space) and every subsequent parent write takes a COW fault (~2–3 μs, or a 2 MB copy with huge pages).
7. **Why must replay run through the same code path as live processing?** — Otherwise recovery reconstructs a state the live system would never produce, and every bug in the recovery path is invisible until it runs. Requires a deterministic, side-effect-free core with sends as outputs.
8. **What must be journaled besides messages?** — Every nondeterministic input: clock reads, RNG draws, timer fires, config values used. Replay that re-derives them diverges silently.
9. **Why does a hot standby derive state from the market-data feed rather than from the primary?** — No replication lag to bound, no serialization format to version, and a corrupt primary cannot corrupt the standby. Only intent (in-flight orders, strategy state) needs journal replication.
10. **What is fencing and why is a client-side leadership check insufficient?** — Fencing prevents a deposed primary from acting, via a monotonic token checked *at the resource*. A client that checks then acts has a TOCTOU window, and the stall that caused failover can land in it.
11. **What is the most practical fence in a trading system?** — The exchange's single-session-per-credential rule: the standby's successful logon *is* the fence, and the old primary's writes fail on a dead socket.
12. **Why bias order-gateway failover toward not promoting?** — The costs are asymmetric: split-brain doubles position and defeats every limit, while a few seconds of not trading is bounded. Promote only on proven exclusivity, not on inferred death.
13. **What is an orphaned order and how does it arise?** — A live exchange order outside your model, created when the old primary sent before its journal record replicated. Prevented by synchronous replication before send (~10–20 μs), or detected by mass-status reconciliation on failover.
14. **Why must a watchdog observe progress rather than existence?** — A wedged thread is alive; a monotonic counter incremented in the work loop distinguishes running from progressing at a cost of ~1 ns.
15. **Give the rule that decides fail-open versus fail-closed.** — Fail in the direction that reduces exposure: controls authorizing new exposure fail closed, controls removing exposure (cancels, kill switches) fail open, and classification of already-received data fails toward processing it.
16. **How do you make fail-closed robust against the risk evaluator crashing?** — Make permission a positive, timestamped assertion that decays: `ok && (now - ok_tsc) < max_stale`. Any failure of the evaluator becomes fail-closed automatically, at ~2 ns.
17. **How do you size a queue for bursts?** — `capacity ≥ (λ_peak − μ) × T_burst`, measured from hardware-timestamped captures bucketed at microsecond granularity, not from average rates. Queues are cheap; drops are not — then bound the resulting latency by discarding stale entries at dequeue and counting them.
18. **Why is queue high-water mark more useful than average depth?** — A queue that hit 90% for 200 μs and drained is invisible in averages and percentiles of depth, but it is the leading indicator of loss.
19. **Why does a degradation ladder need hysteresis?** — Identical entry and exit thresholds cause flapping between modes, which is worse than either mode. Separate thresholds plus a minimum dwell time.
20. **What is the overflow hazard in a notional check?** — `qty × price` in scaled integer units overflows `int64_t` and produces a *small* result that passes the limit — the failure inverts. Use `__int128` or checked arithmetic, never floating point.
21. **Why is checking a position limit against filled position alone wrong?** — It ignores working and in-flight orders, so aggregate potential exposure can far exceed the limit. Reserve on send, release on reject/cancel, convert on fill.
22. **How do you avoid a contended atomic on the position check?** — Shard the limit into per-gateway sub-budgets rebalanced off the hot path, so the check-and-reserve is single-writer and non-atomic.
23. **Why must a kill switch not construct its cancel message when it fires?** — It runs when the system is already unhealthy; allocation, formatting, or a lookup may be exactly what is broken. Pre-encode at startup and patch two fields — under a microsecond to the wire.
24. **Why disable order entry before mass-cancelling?** — Otherwise the cancel races new orders still being sent, and you cancel into a stream of replacements. Follow with a mass-status verification pass.
25. **Does mass cancel flatten your position?** — No. It removes working orders only; reducing position requires new orders, which the kill switch may have just blocked. The two capabilities must be independently controllable.
26. **Message dedup fails open but order dedup fails closed. Reconcile.** — Both follow "fail in the direction that reduces exposure": dropping a real fill corrupts position silently, while sending a duplicate order creates real unintended exposure.
27. **How do you update a whole risk configuration atomically?** — Build a new immutable image off the hot path into preallocated storage and publish it with one release store of a pointer; the hot path does one acquire load. Reclaim the old image with deferred free or epoch-based reclamation.
28. **How do you catch errors in incremental risk accounting?** — Recompute from first principles on a warm thread and continuously compare against the hot path's incremental values; divergence is otherwise invisible until it matters.

---

## Common Traps

- **Sending before journaling** — a live order the system has no record of.
- **Writing a record header before its payload** — torn records indistinguishable from valid ones on recovery. Publish the length last, with release ordering.
- **Believing `mmap` gives power-loss durability** — it gives process-crash durability only.
- **Omitting the directory `fsync` after `rename`** — the rename may not survive power loss.
- **A checkpoint that includes effects of records after its tagged offset** — double-application on replay, discovered days later as a position break.
- **Keeping only one checkpoint** — a corrupt newest checkpoint forces a full-day replay at the worst moment.
- **`memcpy`-loading a checkpoint written by a different binary** — silent risk-state corruption; version and checksum it, and follow wire-layout rules.
- **A separate "recovery mode" code path** — every bug in it is invisible until it runs.
- **Replaying without journaling nondeterministic inputs** — silent divergence.
- **Auto-enabling order entry after recovery before reconciliation** — duplicate orders or trading on top of an unknown position.
- **Failover on inferred death without a fence** — split-brain: double position and every limit satisfied twice.
- **Checking leadership in the client rather than at the resource** — a TOCTOU window that the stall lands in.
- **Carrying forward cached risk utilization across a failover** — the incident's error outlives the incident.
- **A watchdog that checks process existence** — a wedged thread passes.
- **A watchdog sharing fate with what it watches** — same process, same core, same allocator.
- **Watchdog thresholds set by intuition** — false-positive cancel-alls turn a 5 ms stall into an outage.
- **`if (blocked) reject()`** — a crashed evaluator leaves it false and the control fails open silently. Use decaying positive permission.
- **Global automatic fail-closed on a noisy signal** — scope fail-closed as narrowly as the uncertainty.
- **Sizing queues from average message rates** — real feeds burst 10–100× within microsecond windows.
- **Monitoring only software queues** — the drops are in the NIC ring, visible only in `ethtool -S`.
- **Dropping silently** — a downstream inconsistency with no evidence of its cause.
- **Degradation thresholds with no hysteresis** — flapping.
- **A degradation path that allocates or calls the failed component** — it runs when the system is already sick.
- **Random load shedding** — an unknown-partial book is worse than a known-stale one.
- **A price collar against a stale reference** — rejects everything during a real move, or permits exactly the bad orders.
- **Floating point anywhere in a risk comparison** — precision loss above 2^53 and boundary behaviour varying with optimization level.
- **`int64_t` notional arithmetic** — overflow yields a small value that passes the check.
- **Quantity limits in the wrong unit (lots vs shares)** — off by the lot size and failing open; use strong typedefs.
- **Not re-checking limits on a quantity-increasing cancel/replace** — a bypass of every size control.
- **A runaway detector implemented as a dashboard** — runaways build in tens of milliseconds; the check must be inline per order.
- **A strategy reacting to its own orders in market-by-order data** — positive feedback; filter your own orders out upstream.
- **A kill switch that only sets an in-process flag** — useless when the process is wedged; layer with a supervisor, venue controls, and network isolation.
- **Killing the process to cancel orders at a venue without cancel-on-disconnect** — every order orphaned.
- **Automatic re-enable after a kill** — restarts the condition that caused it.
- **Assuming mass cancel is atomic with respect to in-flight orders** — disable entry first, then cancel, then verify with mass status.
- **Ignoring the burst of individual cancel acks a mass cancel produces** — arrives exactly when the system is stressed.
- **Configuring self-trade prevention globally as cancel-oldest** — silently destroys queue position earned over minutes, and unmodelled cancels can drive a retry loop.
- **An order-dedup window too long** — converts a safety control into a trading bug.
- **Multi-field risk values published non-atomically** — a range neither configuration ever defined.
- **`std::atomic<T>` risk state in shared memory without `is_always_lock_free`** — no cross-process atomicity at all.

---

## Compact Recall Summary

**Durability.** Journal every input, every output, and every nondeterministic value, *before* acting — the asymmetry (duplicate vs orphan) is the whole argument. Append into a preallocated, prefaulted, `mlock`ed `mmap` segment: `memcpy` plus a release store of the length last, 20–60 ns, crash-consistent by construction. `mmap` survives process crash; replication to a second host beats `fsync` for machine crash. Checkpoints are tagged with a journal offset and must equal exactly the state at that offset; publish by `write → fsync → rename → fsync(dir)`; keep two; version, checksum, and schema-hash them.

**Recovery.** Checkpoint, replay through the *same* code path with outputs suppressed, reconstruct in-flight orders, query the exchange for truth, reconcile, recompute risk from authoritative positions, then cancel-only, then enable. Never auto-enable order entry before reconciliation. Measure recovery time under `SIGKILL`, not graceful shutdown.

**Redundancy.** Hot standby derives state from the same market-data feed and drop copy — no replication lag, no format versioning, no corruption channel — and takes only *intent* from the replicated journal. Fence with a monotonic token checked at the resource; in trading the practical fence is the venue's single-session-per-credential rule. Avoid split-brain by delegating to that single point of enforcement rather than solving consensus; bias toward not promoting, because a duplicate trading instance costs more than a pause. Convergence after failover: drain journal, fence, mass-status query, three-way reconcile, adopt or cancel orphans, recompute utilization, cancel-only, then trade.

**Liveness.** Watchdogs observe *progress* — a counter incremented in the work loop, ~1 ns — not existence, and must not share fate with the watched. Layer in-process, out-of-process, and hardware. Threshold from measured distributions; escalate cheaply first.

**Failure direction.** Fail in the direction that reduces exposure: authorization of new exposure fails closed, removal of exposure fails open, classification of received data fails toward processing. Implement fail-closed as decaying positive permission (`ok && now − ok_tsc < max_stale`) so any evaluator failure trips it automatically at ~2 ns.

**Capacity.** Size for the worst 10 ms, not the daily average — feeds burst 10–100× in microsecond windows, and hardware drops are invisible outside `ethtool -S`. `capacity ≥ (λ_peak − μ) × T_burst`; queues are cheap, drops are not; bound the resulting latency by discarding stale entries at dequeue and counting them. Keep steady-state utilization near 50% — headroom *is* tail budget. Alarm on high-water marks and time-above-watermark, never on instantaneous depth, and account every drop. Degrade along a pre-planned ladder with hysteresis, with paths that neither allocate nor depend on the failed component, shedding by rank rather than at random.

**Pre-trade controls.** Price collars compare precomputed integer bounds against a reference with an explicit staleness bound, failing closed when stale, banded asymmetrically toward the aggressive side. Fat-finger checks bound quantity and notional with `__int128` arithmetic — `int64_t` overflow fails *open* — never floating point, layered across per-order, per-interval, and aggregate limits, laid out contiguously per instrument so one cache line serves the whole battery at 5–15 ns. Position limits reserve against filled *plus working plus in-flight*, are bounded gross and net independently, and are sharded into per-gateway sub-budgets so check-and-reserve stays single-writer. Maximum order quantity is one predictable compare under a nanosecond — never disabled, per instrument, unit-safe via strong typedefs, and re-checked on quantity-increasing replaces.

**Stopping.** Runaway detection is rate and ratio windows evaluated inline per order, escalating from alarm to per-strategy disable to global kill; the archetypal runaway is a strategy reacting to its own orders, fixed by filtering them out of market data upstream. Kill switches are layered — in-process atomic, out-of-process supervisor, venue-side controls, network isolation — scoped per strategy, instrument, venue, and globally, and tested in production. Disable entry, then mass cancel from a pre-encoded warm buffer (sub-microsecond to wire), then verify with a mass-status pass; mass cancel removes working orders but does not flatten, so kill and hedge must be independently controllable.

**Consistency.** Self-trade prevention runs venue-side (choose the cancel instruction per strategy pair, knowing cancel-oldest destroys queue position) with a cheap internal pre-check of your own best bid/ask. Order-level duplicate protection fingerprints intent within a short window and fails *closed* — the mirror of message dedup, under the same exposure rule. All risk state is published atomically: relaxed atomics for flags, seqlocks for read-mostly values, and an immutable image swapped with one release store for grouped configuration, with deferred reclamation. Recompute utilization from authority after any uncertainty, never carry it forward, and continuously diff an independently-recomputed risk state against the incremental one — the only way to see an accounting error before it matters.
