# Chapter 68 — Distributed Systems: Introduction and Overview

*Interview-focused revision notes. The theme: a distributed system is not one program spread across machines but many programs that can only learn about each other by exchanging messages over a network that loses, delays, duplicates, and reorders them — and, crucially, can leave one node unable to tell whether a peer has crashed or is merely slow. Part I asked how one node turns rows into durable bytes; Part II asks what breaks when the data, and the very mechanisms that manage it, are scattered across nodes that fail independently. This chapter builds the vocabulary — links, clocks, synchrony, failure models, the two great impossibility results — that Chapters 69–74 stand on. The single fact under everything: there is no shared memory and no global clock, so all coordination is communication, and communication can fail.*

---

## 68.1 Why Distribute at All

Distributing a system is expensive in complexity, latency, and reasoning effort. Nobody does it for fun; they do it because a single node cannot meet one of four requirements, and it is worth naming them because they pull in different directions.

- **Scale beyond one machine.** A dataset larger than the biggest available disk, or a write rate higher than one machine's CPU/IO can sustain, forces **partitioning** (sharding): split the data across nodes so each holds a fraction (Ch. 72). Vertical scaling — a bigger box — hits hard ceilings (a single server tops out in the low-terabyte RAM, dozens-of-cores range) and gets superlinearly expensive at the top end. Horizontal scaling adds commodity nodes.
- **Availability despite failures.** A single node is a single point of failure: when it dies, the service is down. **Replication** — keeping copies of the data on multiple nodes (Ch. 69) — lets the system survive the loss of a node, a rack, or a whole datacenter. Availability is the *reason replication exists*, and it is different from scale.
- **Geographic locality.** Users in Tokyo talking to a database in Virginia pay ~150–200 ms round-trip (Ch. 30) on every request. Placing replicas near users cuts read latency to single-digit milliseconds. Geo-distribution is also a regulatory requirement (data-residency laws).
- **Fault isolation and elasticity.** Independent nodes let you upgrade, restart, or lose parts of the system without taking down the whole; cloud deployments add and remove nodes to track load.

These goals are not free and not independent. Replication improves availability but forces you to keep copies consistent; partitioning improves scale but makes multi-key transactions cross nodes; geo-distribution improves locality but multiplies the latency of any coordination. The rest of Part II is largely the study of these tensions, and **the CAP and PACELC framing (Ch. 70)** is the formal statement of the first of them.

---

## 68.2 Why Distribution Is Fundamentally Hard

A single-node program enjoys guarantees so basic they are invisible: memory it wrote stays written, a function call either runs or does not, the clock moves forward monotonically, and when a subroutine fails it fails *here*, where the caller can see it. A distributed system loses every one of these. Petrov frames the difficulty as the combination of three properties that a single machine does not have:

1. **No shared memory.** Nodes share nothing by default. The only way one node learns anything about another is to receive a message. State must be *communicated*, and communication is slow, lossy, and takes time during which the state can change (§68.3).
2. **No global clock.** There is no single authoritative "now." Each node has its own physical clock, and these clocks drift apart; "event A happened before event B" is not even well-defined across nodes without extra machinery (§68.6, §68.7).
3. **Independent partial failure.** Any subset of nodes and network links can fail at any time, independently, and — the defining difficulty — **a healthy node cannot distinguish a crashed peer from a slow one or a broken link** (§68.9). In a single process, a crash takes down everything at once, so there is nothing to disagree about; in a distributed system, some parts keep running with a stale or partial view.

The consequence is that facts that are trivially true locally become *agreements that must be negotiated*: which node is the leader, whether a transaction committed, what the current value of a key is. Negotiating agreement over an unreliable network, with nodes that fail silently, is exactly what the impossibility results (§68.17, §68.18) say you cannot always do — and what consensus algorithms (Ch. 74) achieve under carefully weakened assumptions.

---

## 68.3 Concurrent Execution and Shared State

On one machine, threads coordinate through **shared memory** protected by locks, atomics, and memory barriers (Ch. 24, Ch. 29): a writer stores a value and, given the right fences, a reader on another core sees it within nanoseconds. The hardware cache-coherence protocol makes "shared state" real and cheap.

Across machines there is no cache coherence, no shared address space, and no hardware that propagates a store. If node A updates a value and node B needs to know, A must **send a message** and B must **receive and apply** it. This has consequences that recur throughout Part II:

- **State is always a delayed, possibly-stale copy.** By the time B receives A's message, A may have moved on. B's view is A's *past*. This is why replicas are described by how stale they may be (replication lag, Ch. 69) rather than as exact mirrors.
- **There is a window in which observers disagree.** Between A's update and B's receipt, A and B hold different values. Whether clients are ever allowed to *observe* that disagreement is precisely the **consistency model** (Ch. 70): strong consistency hides the window at the cost of coordination; eventual consistency exposes it for the sake of availability and latency.
- **Coordination is the scarce resource.** Every guarantee that hides disagreement (a lock, a quorum, a commit) costs at least one network round trip. Where a mutex on one machine costs tens of nanoseconds, its distributed analogue costs microseconds-to-milliseconds (§68.8) — a factor discussed next that reorders every performance intuition you brought from single-node programming.

The mental model to carry forward: **in a distributed system, shared state is an illusion maintained by messages, and every message costs time during which reality can change underneath you.**

---

## 68.4 The Fallacies of Distributed Computing

In the 1990s Sun engineers (Peter Deutsch, James Gosling, and others) catalogued eight false assumptions that developers new to distributed systems keep making. They are worth memorizing verbatim because interviewers use them as a checklist and because each names a real, recurring production failure.

| # | Fallacy | Reality | A failure it causes |
|---|---|---|---|
| 1 | **The network is reliable** | Packets are lost, links flap, switches reboot | An RPC library that never retries drops writes on a transient blip |
| 2 | **Latency is zero** | A remote call is 10⁵–10⁶× a local one (§68.8) | A loop making one RPC per row (N+1) that is instant in tests and dies over the WAN |
| 3 | **Bandwidth is infinite** | Links have finite capacity; big payloads queue and drop | Shipping full result sets across regions saturates a link and induces loss + latency |
| 4 | **The network is secure** | Networks are hostile; traffic is sniffed, spoofed, MITM'd | Trusting the network perimeter; no TLS/auth between services |
| 5 | **Topology doesn't change** | Nodes, routes, and DNS change constantly (cloud autoscaling) | Hardcoding IPs/hosts; caching an address that has since moved |
| 6 | **There is one administrator** | Many teams/orgs own pieces; configs diverge | A firewall or MTU change by another team silently breaks a path |
| 7 | **Transport cost is zero** | Serialization, syscalls, TLS, and copies cost CPU and money | Assuming "just send it" is free; ignoring egress bandwidth billing |
| 8 | **The network is homogeneous** | Mixed hardware, MTUs, protocols, and versions coexist | An MTU mismatch causing fragmentation/black-holing on one path only |

The through-line of all eight: **the network is a hostile, lossy, changing, finite, insecure, heterogeneous medium administered by people you don't control** — the opposite of the reliable function-call abstraction that RPC frameworks tempt you to believe in. Fallacies 1 and 2 are the load-bearing ones for storage systems: unreliability forces the link and consensus machinery of the rest of this chapter, and latency forces the cost-asymmetry reasoning of §68.8. Ethernet/IP (Ch. 36) and TCP (Ch. 38) are the concrete media these fallacies describe; TCP masks *some* unreliability (retransmission, ordering within a connection) but cannot mask a partition, a crash, or unbounded delay.

---

## 68.5 Processing Models

How does a distributed system organize *who does what*? Petrov distinguishes a few coordination shapes, and the choice determines where failures hurt and how much coordination is needed.

- **Leaderless / symmetric.** Every node is equal; there is no distinguished coordinator. Clients (or a coordinator chosen per-request) talk to multiple replicas and use quorums to reconcile. **Dynamo-style** systems — Amazon Dynamo, Apache Cassandra, Riak — are leaderless (Ch. 69, Ch. 73). No single node's failure is special, but there is no natural place to order writes, so conflict resolution (last-write-wins, vector clocks, CRDTs) is pushed onto reads.
- **Leader-based / master-slave.** One node is the **leader** (primary) that orders all writes; others are **followers** (replicas) that apply the leader's stream. **PostgreSQL streaming replication**, MySQL, MongoDB, and Raft-based systems (etcd, ZooKeeper's ZAB) are leader-based. A single ordering point makes strong consistency and transactions natural, but the leader is a bottleneck and its failure requires **leader election / failover** (Ch. 74).
- **Multi-leader.** Several leaders accept writes (often one per region) and replicate to each other. Good for write locality and regional availability, but concurrent writes to the same key on different leaders create **write conflicts** that must be resolved.

Cross-cutting these is the **communication style**: synchronous request/response (RPC, blocking until a reply or timeout) versus asynchronous messaging (fire-and-forget into a queue, decoupling sender and receiver in time). Asynchronous messaging tolerates the receiver being temporarily down at the cost of harder-to-reason-about ordering and end-to-end acknowledgment. Whatever the model, the primitives underneath are the same: unreliable links (§68.12) carrying messages between nodes that can fail (§68.20).

---

## 68.6 Clocks and Time: There Is No "Now"

Distributed systems reason constantly about *order* — which write is newer, whether a lease has expired, when a timeout fires — and order needs time. The trap is assuming a single, shared, accurate clock. There is not one.

Each node has its own **physical clock** (a quartz oscillator feeding a counter). No two clocks agree exactly, and each drifts relative to true time. There is no instant that all nodes can point to and call "now"; the concept of a globally simultaneous "now" is not just hard to obtain, it is **physically ill-defined** across separated nodes exchanging signals that take time to travel. This forces two different notions of time:

- **Physical (wall-clock) time** — what a node's real-time clock reports (`CLOCK_REALTIME`). Useful for humans, TTLs, and coarse timestamps, but *not trustworthy for ordering events across nodes*, because clock skew (§68.7) can make a later event carry an earlier timestamp. Comparing wall-clock timestamps from two machines to decide "who wrote last" is a classic bug.
- **Logical time** — order derived from causality, not from any clock. If event A *could have caused* B (A sent a message that B received, or A and B ran on the same node with A first), then A precedes B. **Lamport clocks** and **vector clocks** (developed fully in **Ch. 71**) capture this "happened-before" relation with counters, sidestepping physical clocks entirely. Logical clocks can tell you A→B or "concurrent," which is exactly what conflict resolution needs.

```
Node A:  a1 ──── a2 ──────────── a3
            \                         (a2 sends msg m to B)
             \────────► m
Node B:              b1 ── b2(recv m) ── b3

Causality (happened-before, →):
   a1 → a2 → a3      (same node, program order)
   b1 → b2 → b3      (same node, program order)
   a2 → b2           (message send → receive)
   therefore a1 → b3, a2 → b3, ...
   a1 and b1 are CONCURRENT (neither could have caused the other)

Wall clocks may disagree: B's clock could read EARLIER at b2 than
A's did at a2, even though a2 → b2. Never order across nodes by wall time.
```

The interview takeaway: **"which event happened first?" has two answers — physical (unreliable across nodes) and logical (reliable but only a partial order).** Most correct distributed algorithms use logical time for ordering and treat physical time only as an optimization or a failure-detection heuristic (timeouts).

---

## 68.7 Clock Skew, NTP, and the Limits of Synchronized Time

Since physical clocks drift, systems synchronize them, but synchronization is bounded and imperfect — and understanding *how* imperfect is the difference between a correct design and a data-loss bug.

- **Clock drift** is the rate at which a clock diverges from true time. Commodity quartz drifts on the order of tens of parts per million — roughly a few seconds per day if left alone, and worse under temperature swings.
- **Clock skew** is the instantaneous difference between two clocks at a moment. It is what matters when comparing timestamps.
- **NTP (Network Time Protocol)** disciplines clocks against upstream time servers, correcting drift. In practice NTP holds skew to **~1–50 ms** on a LAN and worse across the internet; **PTP (Precision Time Protocol)** with hardware timestamping reaches sub-microsecond in a datacenter (Ch. 35 covers the tuning). Crucially, NTP can also step a clock *backward* to correct it, so `CLOCK_REALTIME` is **not monotonic** — a naive "get current time" can go down, which breaks duration measurements (use `CLOCK_MONOTONIC` for elapsed time, Ch. 35).

The design lesson: because skew is bounded but nonzero and never guaranteed to be small, **you cannot use wall-clock timestamps for correctness unless you account for the uncertainty**. Two responses illustrate the spectrum:

- **Cassandra's last-write-wins** uses wall-clock timestamps to order conflicting writes. If two nodes' clocks skew, a *logically later* write can be silently discarded because it carries a smaller timestamp — a real, documented data-loss mode that motivates monotonic-clock discipline and, better, logical clocks.
- **Google Spanner's TrueTime** confronts the uncertainty head-on: it exposes time as an *interval* `[earliest, latest]` with a bound (a few milliseconds) enforced by GPS and atomic clocks, and it **waits out the uncertainty** (`commit-wait`) before releasing a commit, guaranteeing external consistency. It buys correctness by paying the skew bound in latency on every commit. Spanner is the proof that tight, *bounded* clocks are valuable — but note it never claims skew is *zero*, only bounded and known.

Bottom line: NTP shrinks skew, it does not eliminate it; correctness must come from either logical clocks (§68.6, Ch. 71) or explicitly bounded physical time (Spanner), never from an assumption that two machines' clocks agree.

---

## 68.8 Local vs Remote Execution: The Cost Asymmetry

The most consequential number in distributed systems is the gap between a local operation and a remote one, because it silently invalidates the performance intuitions engineers bring from single-node code. Using the reference numbers from Ch. 30:

| Operation | Order of magnitude |
|---|---|
| L1 cache reference | ~1 ns |
| Main-memory (DRAM) reference | ~80–100 ns |
| Mutex lock/unlock (uncontended) | ~20 ns |
| Same-rack network round trip (kernel bypass) | ~3–6 µs |
| Same-datacenter round trip (kernel TCP) | ~100–500 µs |
| Cross-country round trip (Chicago↔NY fiber) | ~13 ms |
| Cross-continent round trip (NY↔London) | ~55–60 ms |
| Intercontinental round trip (trans-Pacific) | ~150–200 ms |

A remote call within a datacenter is roughly **10³–10⁴×** a local memory access; a cross-region call is **10⁵–10⁶×**. A function call that reads memory (~100 ns) versus the same logical call made as an RPC to another region (~50 ms) differ by **five to six orders of magnitude** — the difference between one second and one week.

The design consequences dominate distributed data systems:

- **Round trips, not bytes, are usually the cost.** Latency is set by the speed of light and switching hops, not payload size, until you hit bandwidth limits. So you *batch* (one request for 1000 rows, not 1000 requests) and avoid the **N+1 pattern** the second fallacy warns about. Chattiness kills.
- **Coordination is precious.** Every consensus round, quorum, or two-phase commit costs at least one round trip; strong consistency across regions costs tens of milliseconds *per operation that coordinates*. This is why systems work hard to avoid coordination on the fast path (Ch. 70, Ch. 73).
- **Timeouts must respect the fabric.** A timeout tuned for same-rack latency will fire spuriously across regions; a timeout tuned for cross-region will react slowly to a same-rack crash. Since you cannot distinguish slow from dead (§68.9), timeout choice is a genuine trade-off, not a detail.

The asymmetry also explains data placement: you replicate near readers, partition to keep related data co-located, and treat every cross-node hop as a cost to be minimized or hidden.

---

## 68.9 The Defining Feature: Partial Failure

Here is the property that most sharply separates distributed systems from everything else. In a single program, failure is **total**: a crash, a segfault, an out-of-memory kill takes down the whole process at once. Everything is either working or gone, and the two states are easy to tell apart.

In a distributed system, failure is **partial**: some nodes and links fail while others keep running, and — the sharp edge — **a surviving node cannot reliably distinguish a failed peer from a slow one or a broken link.** When node A sends a request to node B and hears nothing back within its timeout, A cannot know which of these happened:

```
   A sends request to B, then waits... and hears nothing.
   Which of these actually happened?

   (1) B crashed before receiving the request.        → request lost
   (2) B received it, crashed before processing.       → request lost
   (3) B processed it, crashed before replying.        → EFFECT HAPPENED, no reply
   (4) B replied, the reply was lost in the network.   → EFFECT HAPPENED, no reply
   (5) B is alive but slow (GC pause, overload); reply → EFFECT WILL HAPPEN, late
       is still coming.
   (6) The network is partitioned; B is fine and still → EFFECT HAPPENED on B's side
       processing on the other side.

   From A's vantage point, all six look IDENTICAL: silence.
```

A's only observable is *silence*, and silence is ambiguous across at least six scenarios that demand opposite responses. If A **retries**, it risks executing the operation twice (cases 3, 4, 6). If A **gives up**, it risks abandoning an operation that succeeded (also cases 3, 4, 6) or was about to. There is no local information that resolves the ambiguity — resolving it requires *more communication with a party that may itself be unreachable*.

This single fact — **you cannot tell "dead" from "slow"** — is the root of an astonishing amount of distributed-systems machinery:

- It is why **exactly-once delivery is impossible** at the network layer and must be simulated with idempotence + dedup (§68.15).
- It is why **failure detectors are approximate** (§68.21) and consensus needs partial-synchrony assumptions (§68.19) to make progress.
- It is why the **FLP result** (§68.18) says deterministic consensus can't be guaranteed asynchronously — a slow node is indistinguishable from a crashed one, so no algorithm can safely decide when to stop waiting.

Everything downstream in Part II is, in one way or another, a strategy for living with partial failure you cannot diagnose.

---

## 68.10 Network Partitions

A **network partition** is the failure mode where the network splits into groups of nodes that can each communicate internally but cannot reach the other group(s) — while every node in every group is still running and processing.

```
   Healthy:                      Partitioned:
   ┌───┐   ┌───┐   ┌───┐         ┌───┐   ┌───┐ ┊ ┌───┐
   │ A │───│ B │───│ C │         │ A │───│ B │ ┊ │ C │
   └───┘   └───┘   └───┘         └───┘   └───┘ ┊ └───┘
     all can talk                 {A,B}    ┊    {C}
                                  can talk  ┊  isolated
                                            ┊
                              C thinks A,B are dead.
                              A,B think C is dead.
                              All three are ALIVE.
```

Partitions are the most dangerous failure because they combine the ambiguity of §68.9 with *independent continued operation*: both sides are up, both think the other is down, and both may keep accepting reads and writes. If the two sides both keep serving writes, they **diverge**, and the system now has two conflicting versions of reality that must eventually be reconciled or one side must lose data. This is precisely the dilemma **CAP (Ch. 70)** formalizes: during a partition you must choose between **consistency** (refuse to serve on at least one side, staying correct but unavailable) and **availability** (keep serving on both sides, staying up but risking divergence). You cannot have both while partitioned; the only free choice is what you sacrifice.

Partitions are not exotic. They are caused by switch failures, misconfigured firewalls, BGP mistakes, overloaded links that drop enough packets to look like a cut, and long GC pauses that make a node *appear* partitioned from the outside. A "partition" from the algorithm's point of view is simply *messages not arriving in time*, which is why in the partial-synchrony model a partition and extreme slowness are the same event. The practical defenses are **quorums** (require a majority to act, so at most one side of a partition can make progress — Ch. 69, Ch. 74) and **fencing** (Ch. 74), which prevent a wrongly-presumed-dead node from causing damage when it comes back.

---

## 68.11 Cascading Failures

Partial failure is bad; **cascading failure** is how a small partial failure becomes a total outage. The pattern: one component fails or slows, the load it was handling is redistributed to its peers, the extra load pushes those peers over their limit, they fail or slow, and the failure front propagates until the whole system is down.

```
   Node X slows (or dies)
        │  load X handled is retried / rerouted to Y, Z
        ▼
   Y, Z now over capacity ──► they slow ──► their clients time out
        │                                        │
        │  clients RETRY (amplifying load) ◄──────┘
        ▼
   retry storm + queue buildup ──► more nodes tip over ──► total outage
```

The accelerants are worth naming because interviewers probe mitigations:

- **Retry storms.** A timeout triggers a retry; retries multiply the load on an already-struggling system exactly when it can least afford it. Mitigation: **exponential backoff with jitter**, and **retry budgets** that cap the fraction of traffic that is retries.
- **Unbounded queues.** A slow downstream lets requests pile up in queues; latency climbs, memory grows, and clients that have already timed out are still being served (work amplification). Mitigation: **bounded queues + load shedding** — drop excess work fast rather than queue it.
- **Thundering herds / synchronized clients.** Caches expiring together, or all clients reconnecting at once after a blip, create a spike. Mitigation: jittered timers, request coalescing.
- **Positive-feedback loops** generally: anything where "system is slow → clients do more work → system is slower." **Circuit breakers** (fail fast when a dependency is unhealthy, giving it room to recover) and **backpressure** break the loop.

The deep point connecting this to §68.9: because you cannot tell slow from dead, the *natural* reaction (retry, reroute) is exactly what turns a localized slowdown into a system-wide collapse. Robust distributed systems are designed to *degrade* rather than amplify — shedding load and failing fast instead of retrying into the ground.

---

## 68.12 Abstractions: Links and the Fair-Loss Foundation

To reason about all this precisely, distributed-systems theory builds a hierarchy of **link abstractions** — models of a communication channel between two nodes, each stronger than the last, each built from the one below. This layered construction (from Cachin/Guerraoui/Rodrigues, which Petrov follows) is the standard vocabulary; know the ladder.

The weakest useful model is the **fair-loss link**, which captures what a raw IP/UDP datagram channel (Ch. 36) actually gives you. Its three properties:

1. **Fair loss.** If you send a message infinitely often, it is delivered infinitely often. (A message *may* be lost, but the link cannot lose *every* copy of a message you keep retransmitting — losses are not adversarial-forever.)
2. **Finite duplication.** The link may deliver a message more than once, but only finitely many times.
3. **No creation.** The link does not invent messages; every message delivered was actually sent by someone.

Fair-loss is deliberately weak: it can drop and duplicate freely, promising only that persistence eventually pays off. Everything stronger — reliable, ordered, exactly-once — is *built on top* of fair-loss by adding retransmission, acknowledgments, sequence numbers, and deduplication. The reason to start here is honesty: this is genuinely all the physical network guarantees, so any stronger guarantee your application relies on is *software you (or TCP) must implement*, and it is worth knowing that machinery so you understand its limits (§68.15).

---

## 68.13 Acknowledgments, Retransmits, and the Duplicate Problem

To climb from fair-loss toward reliability, you add two mechanisms — and immediately inherit a new problem.

- **Acknowledgments (ACKs).** The receiver, on getting a message, sends back a small confirmation. The sender now has *evidence* of delivery. But an ACK is itself a message on a fair-loss link, so it too can be lost — the absence of an ACK does not mean the message was not delivered (this is §68.9 in miniature).
- **Retransmission.** If the sender does not receive an ACK within a timeout, it **resends** the message. Retransmission is what converts "may be lost" into "eventually delivered": keep resending until acknowledged, and fair-loss guarantees the message (and its ACK) eventually get through.

The problem retransmission creates is **duplicates**. Consider the message delivered but the ACK lost:

```
   Sender                         Receiver
     │  msg #1  ──────────────────►│  (delivered, processed)
     │                             │  ACK #1 ──┐
     │  ◄─────────  X  (ACK lost) ─┘           
     │  (timeout, no ACK)                       
     │  msg #1  ──────────────────►│  (delivered AGAIN — duplicate!)
```

The receiver has now processed message #1 **twice**. If the message was "transfer $100," the account is debited twice. Retransmission — the very mechanism that gives reliability — inevitably produces duplicates, because the sender cannot distinguish "message lost" from "ACK lost" (partial failure again). This is why the next layers need **sequence numbers**: tag each message with a unique/monotonic id so the receiver can recognize and discard a re-delivery. TCP (Ch. 38) does exactly this internally — its sequence numbers and cumulative ACKs implement retransmission-with-dedup over IP's fair-loss datagrams — but TCP's guarantee ends at the connection boundary (§68.15).

---

## 68.14 Stubborn Links and Perfect Links

Two more rungs complete the classic ladder.

- **Stubborn link.** Built on fair-loss by **retransmitting forever**: the sender keeps resending every message periodically, without end. This guarantees eventual delivery (property: if a correct process sends a message to a correct process, it is delivered infinitely often) but does nothing about duplicates — the receiver sees each message endlessly. Stubborn links are a stepping stone, not something you use directly; they isolate "guaranteed delivery" from "no duplicates."

- **Perfect link (reliable link).** Built on a stubborn link by adding **deduplication**: the receiver tracks which message ids it has already delivered and discards repeats, delivering each message to the application exactly once. Its guarantees:
  1. **Reliable delivery** — if a correct process sends to a correct process, the message is eventually delivered.
  2. **No duplication** — no message is delivered more than once (to the application).
  3. **No creation** — only sent messages are delivered.

```
   Fair-loss link      (may lose, may duplicate, no creation)
        │  + infinite retransmission
        ▼
   Stubborn link       (delivered infinitely often; still duplicates)
        │  + sequence numbers / dedup at receiver
        ▼
   Perfect link        (delivered exactly once, no dups) — the abstraction
                        higher-level algorithms assume
```

The crucial fine print: the "perfect link" guarantee holds **only between correct (non-crashing) processes**. If either endpoint crashes, all bets are off — a message in flight or not yet retransmitted is simply lost, and the perfect-link abstraction says nothing. That caveat is exactly why perfect links are *not* the same as exactly-once end-to-end delivery, which is the subject of the next section, and why higher-level protocols (consensus, replication) still need their own retry and idempotence logic on top.

---

## 68.15 Why Exactly-Once Delivery Is a Myth

"Exactly-once delivery" is the most-requested and most-misunderstood guarantee in distributed messaging. As a *network-transport* property it is **impossible**, and understanding why is a rite of passage.

The impossibility follows directly from §68.9 and §68.13. A sender must decide whether to retransmit, and it decides based on whether it got an ACK. But "no ACK" is ambiguous — the message may have been delivered (ACK lost) or not (message lost). So the sender's only two strategies are:

- **At-most-once:** send and never retry. No duplicates, but messages can be silently lost. (Fewer than one delivery.)
- **At-least-once:** retry until acknowledged. No loss, but duplicates are inevitable (§68.13). (One or more deliveries.)

There is no third option at the transport layer, because to get *exactly* one you would need to know whether the previous attempt succeeded, which is exactly the information partial failure denies you. Add crashes — the receiver can crash after processing but before ACKing, or the sender can crash mid-retry — and no amount of protocol closes the gap.

What real systems mean by "exactly-once" is **effectively-once processing**, achieved by combining at-least-once delivery with **idempotence at the receiver**:

- **At-least-once delivery** ensures nothing is lost (retransmit until ACK).
- **Idempotent operations or deduplication** ensure that duplicates have no additional effect. Either the operation is naturally idempotent (`SET x = 5` applied twice equals once, unlike `x += 5`), or the receiver assigns each request a unique id and **remembers which ids it has already applied**, discarding repeats. Kafka's "exactly-once semantics," for example, is idempotent producers (sequence numbers per partition) plus transactional atomic commits — dedup and atomicity, not a magic network.

The interview formulation: **exactly-once *delivery* is impossible; exactly-once *effect* is achievable = at-least-once delivery + idempotence/dedup.** Anyone selling exactly-once at the wire level is either wrong or quietly doing dedup for you. This is why designing operations to be idempotent (§68 and Ch. 69's replication, Ch. 74's log application) is a recurring discipline, not a nicety.

---

## 68.16 Message Ordering

Beyond delivery, algorithms care about the *order* in which messages arrive, and there is a hierarchy of ordering guarantees, each more expensive than the last.

- **No ordering.** Messages may be delivered in any order regardless of when sent. This is what raw datagrams give.
- **FIFO order (per link/sender).** Messages from the *same sender* are delivered in the order that sender sent them. A single TCP connection (Ch. 38) provides FIFO for its two endpoints via sequence numbers. FIFO says nothing about messages from *different* senders.
- **Causal order.** If message m1 *happened-before* m2 (§68.6 — m1's send causally precedes m2's send, possibly through a chain of other messages), then every recipient delivers m1 before m2. Causal order respects the happened-before relation across all senders; it is implemented with **vector clocks** (Ch. 71). It is strictly stronger than FIFO (FIFO is causal order restricted to one sender).
- **Total order.** *All* nodes deliver *all* messages in the *same* single order, even messages that are causally concurrent. This requires the nodes to *agree* on an order for concurrent events — which is **consensus** (Ch. 74). Total-order broadcast (atomic broadcast) is equivalent in power to consensus, which is why it is the expensive top of the ladder and why systems avoid it on the fast path.

```
   Strength / cost:
     none  <  FIFO  <  causal  <  total
                                    │
                          requires agreement on a single order
                          for concurrent events  ⇒ consensus (Ch. 74)
```

The reason ordering matters: a replicated state machine (Ch. 74) that applies the same operations in the same **total order** on every node ends up in the same state — this is the foundation of strongly-consistent replication. Weaker orders are cheaper and suffice for weaker consistency (causal consistency, Ch. 70, needs only causal order). Choosing the weakest ordering that still makes your application correct is a core design skill, because each step up the ladder costs coordination.

---

## 68.17 The Two Generals' Problem

The first of the two great impossibility results, and the cleanest illustration of why an unreliable link defeats guaranteed agreement.

Two generals, on opposite hills, must **attack simultaneously** to win; if only one attacks, it loses. Their only means of communication is a messenger who must cross the enemy valley and **may be captured** (the message may be lost). Can they reach *certain* mutual agreement on a time to attack?

```
   General A  ──msg: "attack at dawn"──►  General B     (may be captured)
   General A  ◄──ACK: "confirmed"───────  General B     (may be captured)
   General A  ──ACK of the ACK──────────►  General B     (may be captured)
   ...

   Whoever sends the LAST message can never be sure it arrived,
   so can never be sure the other will act. No finite exchange ends
   with both sides CERTAIN. Agreement over a lossy link is impossible.
```

The proof is an infinite-regress argument. Suppose there is a shortest sequence of messages that guarantees agreement. The *last* message in that sequence must have been unnecessary for the sender to reach its decision (the sender decided before sending it, since that message might be lost). But then the receiver cannot rely on it either, so a shorter sequence would also work — contradicting minimality. Hence **no finite protocol guarantees agreement over a link that can lose messages**, no matter how many acknowledgments you stack, because the last sender can never be certain its final message arrived.

The lessons carried forward:

- **Certain agreement over a lossy channel is impossible.** You cannot achieve guaranteed two-party consensus with a fixed number of round trips over an unreliable link.
- **Therefore, aim for high probability, not certainty.** Real systems retransmit to make the probability of disagreement negligibly small, and design so that residual disagreement is *safe* (idempotence, timeouts, reconciliation) rather than catastrophic.
- **This is the two-party special case that motivates the general result** (§68.18) and everything about why distributed commit (Ch. 74's two-phase commit) is a blocking, failure-sensitive protocol rather than a clean guarantee.

---

## 68.18 FLP Impossibility

The **FLP result** (Fischer, Lynch, Paterson, 1985) is the theoretical cornerstone of distributed systems, and stating it precisely — with its exact assumptions — separates people who have read the theory from people who have heard of it.

> **In an asynchronous system where even a single process may fail by crashing, there is no deterministic algorithm that is guaranteed to solve consensus (reach agreement) in bounded time.**

Unpack every clause, because the assumptions are the whole point:

- **Consensus** here means all correct processes agree on one value, satisfying three properties: **agreement** (no two decide differently), **validity** (the decided value was proposed by someone), and **termination** (every correct process eventually decides). FLP shows you cannot guarantee **termination** while keeping agreement and validity.
- **Asynchronous** means *no bound* on message delay or relative process speed — messages arrive eventually but there is no timeout you can trust, and a process can be arbitrarily slow. This is the crux: with no time bound, a slow process is **indistinguishable** from a crashed one (§68.9).
- **Even one crash failure** (fail-stop, the mildest failure model, §68.20) is enough to defeat any deterministic protocol. The result is not about many failures or malice; a single silent crash suffices.
- **Deterministic** matters: the impossibility is about deterministic algorithms.

The intuition: because a non-responding process might be dead *or* just slow, any deterministic algorithm faces moments where it must either wait (and risk waiting forever for a crashed process, violating termination) or proceed (and risk being wrong when the "dead" process was merely slow and now disagrees, violating agreement). There always exists an adversarial schedule of message delays that keeps the system perpetually undecided — a "bivalent" configuration it can never be forced out of.

**Why FLP does not doom real systems** — this is the part interviewers want, because FLP sounds like it forbids etcd, ZooKeeper, and Spanner, which manifestly work:

- **Partial synchrony (§68.19).** Real networks are not adversarially asynchronous forever; they are *usually* timely. Algorithms like **Paxos** and **Raft** (Ch. 74) guarantee **safety** (agreement, validity) *always*, and guarantee **liveness** (termination) only during periods when the network behaves synchronously enough. FLP is dodged by giving up guaranteed *bounded-time* termination while never giving up correctness.
- **Randomization.** FLP forbids *deterministic* solutions; randomized consensus algorithms terminate with probability 1, escaping the deterministic assumption.
- **Failure detectors (§68.21).** Augmenting the async model with an (even unreliable) failure detector — essentially, a source of timing hints — restores solvability. Chandra–Toueg showed the weakest failure detector (◇W) that makes consensus solvable.

The precise takeaway: **FLP says a deterministic async protocol cannot guarantee it will always terminate; it does *not* say consensus is unachievable in practice.** Practical consensus keeps safety unconditionally and accepts that it may stall (not decide wrongly, just not decide) during network misbehavior — exactly the CAP trade-off (Ch. 70) seen from the consensus angle.

---

## 68.19 System Synchrony Models

FLP's teeth come from the *asynchronous* assumption, so the timing model you assume is a first-class design decision. There are three, and knowing which one the real world resembles is essential.

| Model | Message delay | Process speed / clocks | Consensus? | Realism |
|---|---|---|---|---|
| **Synchronous** | Known upper bound on delivery time | Known bounds on relative speed; bounded clock skew | Solvable, even simply | Unrealistic — no real network guarantees a hard bound |
| **Asynchronous** | No bound; messages arrive eventually | No bound on relative speed; no useful clocks | **Impossible** (FLP) | Too pessimistic — real networks are usually timely |
| **Partially synchronous** | Bounded, but the bound is *unknown* and/or holds only *after some unknown time* | Bounds exist but are not known a priori | Solvable (safety always; liveness when timely) | **The practical model** |

- **Synchronous model.** Every message arrives within a known Δ, and processes take steps at bounded relative rates. In this model you *can* build a perfect failure detector (if no reply in Δ, the process is definitely dead) and consensus is easy. But no real network offers a Δ that is never violated — a GC pause, a queue buildup, or a congested link breaks it — so building for the synchronous model is fragile.
- **Asynchronous model.** The opposite extreme: nothing about timing can be assumed. It is the model in which FLP holds and in which timeouts are meaningless (any timeout can fire on a live-but-slow process). It is a useful *worst case* to prove impossibility against, but too weak to build progress on.
- **Partially synchronous model (Dwork–Lynch–Stockmeyer).** The middle ground and the one that describes reality: the network *is* eventually well-behaved — after some unknown **"global stabilization time" (GST)**, delays are bounded — but you never know when you are in a good period or what the bound is. This is exactly enough to build correct systems: design so that **safety never depends on timing** (agreement holds even during the async period) and **liveness only requires an eventual synchronous window** (progress happens once the network calms down). Raft and Paxos are engineered precisely to this model: they never decide wrongly no matter how the network misbehaves, and they make progress whenever it is timely enough for a leader's heartbeats to be believed.

The one-line summary: **assume partial synchrony — timeouts are heuristics that are usually right, so use them for liveness/failure-detection but never let correctness depend on them.**

---

## 68.20 Failure Models

To reason about what an algorithm tolerates, you must specify *how* nodes are allowed to fail. Failure models form a hierarchy from benign to malicious; each stronger model subsumes the weaker ones, and tolerating a stronger one costs more.

| Failure model | What a faulty node may do | Example cause | Cost to tolerate |
|---|---|---|---|
| **Crash / fail-stop** | Halt permanently; before halting it behaved correctly; never sends wrong messages | Power loss, kernel panic, `kill -9` | Cheapest; majority quorum (2f+1 for f failures) |
| **Omission** | Fail to send or receive *some* messages, but otherwise correct | Dropped packets, full buffers, overload | Similar to crash, plus retransmission |
| **Timing** | Respond correctly but too late (or too early) — violate timing bounds | GC pause, clock skew, scheduling delay | Handled by partial-synchrony designs / timeouts |
| **Arbitrary / Byzantine** | Anything: send wrong, contradictory, or malicious messages; lie to different peers differently | Bugs, corruption, compromise, malice | Most expensive; needs **3f+1** nodes, signatures, BFT protocols |

- **Crash (fail-stop)** is the mildest and the assumption most database systems make. A fail-stop node simply stops; it never lies, never sends a corrupt message, and (in the strict *fail-stop* variant) others can eventually detect the halt. Systems like Raft/Paxos, PostgreSQL replication, and most quorum systems assume crash failures and tolerate up to **f** failures with **2f+1** nodes (a majority survives).
- **Omission** failures sit just above crash: the node is up but silently drops some messages. From a peer's view an omission and a crash can look the same (silence), which is why crash-tolerant protocols usually handle omissions too, via retransmission and quorums.
- **Timing** failures are the province of the synchrony discussion (§68.19): the node computes correctly but misses deadlines. In the partially-synchronous model these are absorbed as "temporarily slow," and the danger is only that a timing failure can be *mistaken* for a crash (§68.9), triggering unnecessary failover.
- **Arbitrary / Byzantine** failures are the worst case — a node may behave in any way at all, including actively adversarial behavior: sending different (contradictory) answers to different peers, forging data, or colluding. Tolerating Byzantine faults requires **3f+1** nodes to survive f faulty ones, plus cryptographic signatures and specialized protocols (PBFT, and the BFT consensus underlying blockchains). It is expensive and reserved for adversarial settings (public blockchains, cross-organization trust); **the vast majority of datacenter databases assume crash/omission, not Byzantine, faults**, because inside a trusted datacenter the cost is not justified.

The practical stance: name your failure model explicitly. Most of Part II — replication (Ch. 69), consensus (Ch. 74) — lives in the **crash/omission + partial-synchrony** world. Assuming a weaker failure model than reality bites you (silent corruption is a real, non-crash failure that motivates checksums, Ch. 63); assuming a stronger one than you need (Byzantine when a datacenter is trusted) wastes resources.

---

## 68.21 Failure Detectors

If you cannot distinguish dead from slow (§68.9), how does any system make progress? Through **failure detectors**: components that *suspect* nodes of having failed, based on timing heuristics, accepting that they will sometimes be wrong. Failure detectors are how practical systems buy their way around FLP.

A failure detector is characterized by two properties, which trade off against each other:

- **Completeness** — every actually-crashed node is *eventually suspected* by correct nodes. (Don't miss real failures.)
- **Accuracy** — a correct (live) node is *not wrongly suspected*. (Don't cry wolf.)

You cannot have both perfectly in an asynchronous system — that would be a perfect failure detector, which would let you solve consensus and contradict FLP. So real detectors weaken one. The important class is **◇P (eventually perfect)** and **◇W (eventually weak)**: they may make mistakes for a while (wrongly suspect a slow node) but become accurate *eventually* (during synchronous periods). Chandra and Toueg proved ◇W is the **weakest failure detector that makes consensus solvable** — the precise bridge from FLP-impossible to practically-possible.

In practice, failure detectors are implemented with:

- **Heartbeats.** Each node periodically pings its peers; a missed heartbeat for longer than a timeout marks the peer "suspected." The timeout embodies the completeness/accuracy trade-off: **short timeout → fast detection but many false positives** (a GC pause looks like death, triggering needless failover — a real cause of outages); **long timeout → few false positives but slow reaction to real crashes.**
- **Adaptive detectors** like the **φ-accrual failure detector** (used in Cassandra and Akka) don't output a boolean; they output a *suspicion level* φ that rises as a heartbeat is overdue, letting the application pick its own threshold and adapt to observed network variance rather than a fixed timeout.

The connection to everything above: heartbeat timeouts are the concrete embodiment of the partial-synchrony assumption (§68.19). They are *usually* right, they can be wrong during a bad network period, and the whole system is designed so that a wrong suspicion costs **liveness** (a spurious failover, some churn) but never **safety** (never two leaders committing conflicting data — that is what fencing and quorums in Ch. 74 guarantee).

---

## 68.22 RPC: The Leaky Abstraction

A **remote procedure call** dresses a network request as an ordinary function call: `result = service.method(args)` that happens to run on another machine. The abstraction is seductive and, in the ways that matter, a lie — every fallacy of §68.4 leaks through it, and pretending otherwise is the single most common source of distributed bugs.

A local call and a remote call differ in ways no syntax can hide:

- **A local call cannot partially fail.** It runs or the whole process dies with it (§68.9). A remote call has the six-way ambiguity of §68.9: it may complete, complete-but-lose-the-reply, or never run, and the caller sees only a timeout.
- **A local call has predictable, nanosecond latency.** A remote call is 10³–10⁶× slower (§68.8) and its latency has a long tail — the 99.9th percentile can be orders of magnitude above the median because of queuing, retransmits, and GC pauses.
- **A local call passes arguments by reference in shared memory.** A remote call must **serialize** arguments to bytes, ship them, and deserialize — costing CPU, forbidding pointers, and requiring schema/version compatibility across two independently-deployed programs (the eighth fallacy, heterogeneity).
- **A local call needs no failure-mode design.** A remote call forces the caller to choose delivery semantics, which map exactly onto the impossibility of exactly-once (§68.15):

```
   RPC delivery semantics (caller's retry policy):

   at-most-once   : send, never retry on timeout
                    → no duplicate execution, but a lost request just... vanishes
                    (safe for non-idempotent ops; may silently drop work)

   at-least-once  : retry until a reply arrives
                    → never lose the request, but the server may execute it twice
                    (safe ONLY if the operation is idempotent — §68.23)
```

The interview point: RPC does not remove the network; it hides it, and hidden networks fail in ways the caller has not planned for. Mature RPC frameworks (gRPC, Thrift) surface deadlines, retries, backoff, and status codes precisely because the "just a function call" framing is dangerous. Treat every RPC as a message send that may not arrive, may arrive twice, and will be slow — and design its semantics deliberately.

---

## 68.23 Idempotence and Deduplication in Practice

Because at-least-once is the only delivery strategy that never loses work, and it inevitably duplicates (§68.13, §68.15), **idempotence** — the property that applying an operation more than once has the same effect as applying it once — is the workhorse that makes retries safe. It is the practical resolution of the exactly-once myth, so know how it is actually built.

An operation is **naturally idempotent** if its effect does not depend on prior state:

```
   Idempotent (safe to retry):        Non-idempotent (unsafe to retry):
     SET balance = 500                  balance = balance + 100   (each retry adds again)
     DELETE key k                       INSERT new row (dup rows)
     PUT object at path p               "increment counter"
     assign leader = node3              "append to log" (dup entries)
```

When an operation is not naturally idempotent, you make it idempotent by attaching an **idempotency key** (a unique request id, often a UUID or a client-sequence number) and having the receiver **remember which keys it has already applied**:

1. Client generates a stable id for the logical operation (the *same* id is reused across retries of that operation — this is the crucial detail).
2. Server, on receiving the request, checks a **dedup table** keyed by that id. If seen, it returns the *stored prior result* without re-executing. If new, it executes, records the id and result atomically with the effect, then replies.
3. Retries therefore hit the dedup table and become no-ops that still return success.

This is exactly how Stripe's payment API (`Idempotency-Key` header), Kafka's idempotent producer (per-partition sequence numbers), and TCP's own duplicate suppression (sequence numbers) all work — the same pattern at three different layers. The costs and caveats interviewers probe:

- **The dedup state must be durable and atomic with the effect.** If the server records "applied" but crashes before the effect commits (or vice versa), the guarantee breaks. Recording the id and the effect in one atomic transaction is what closes the gap.
- **The dedup table cannot grow forever.** It is bounded by a time window or a per-client sequence high-water mark; ids older than the window are forgotten, so retries must fall inside it.
- **Idempotence is per-operation, not free.** `x += 5` is not idempotent; rewriting it as "set x to 5 more than its value *as of version v*" (a conditional/compare-and-set write) makes a retry detect it already ran. Conditional writes and version checks are the general tool.

The mantra: **at-least-once delivery + idempotent apply = effectively-once**, and idempotence is engineered, most often by a durable dedup table or a naturally state-independent operation.

---

## 68.24 Backpressure, Flow Control, and Graceful Degradation

Section 68.11 showed how retries and unbounded queues turn a slowdown into a cascade. The defenses deserve their own treatment because "how would you keep this from cascading?" is a standard design-interview follow-up, and the answers are a small, memorable toolkit.

- **Backpressure.** When a consumer cannot keep up, it must *signal upstream to slow down* rather than silently queue without bound. TCP's receive window (Ch. 38) is backpressure at the transport layer; reactive-streams and bounded channels are backpressure at the application layer. The alternative — accepting work faster than you can process it — is an unbounded queue, which converts a throughput problem into a latency-and-memory catastrophe.
- **Bounded queues + load shedding.** Cap every queue. When it is full, **shed load** — reject or drop excess work *fast* (return a 503, drop a low-priority request) instead of admitting it. Fast rejection lets clients back off; slow admission serves requests whose callers have already timed out (pure waste). Shedding the least-valuable work first (priority-aware) preserves the most important traffic under overload.
- **Circuit breakers.** When a dependency is failing, stop calling it. A circuit breaker trips after a failure threshold, fails fast for a cooldown, then lets a trickle through to test recovery (half-open). This gives the struggling dependency room to recover instead of hammering it with retries, breaking the positive-feedback loop of §68.11.
- **Exponential backoff with jitter.** Retries must space out geometrically and add randomness, or synchronized clients retry in lockstep and create a thundering herd. Jitter de-correlates them.
- **Timeouts and deadlines, propagated.** Every remote call needs a timeout, and in a call chain the deadline should be *propagated* so downstream services do not work on a request whose caller has already given up (deadline propagation, as in gRPC).

```
   Overload response, good vs bad:

   BAD:  accept everything → queue grows → latency climbs → clients time out
         → clients retry → MORE load → collapse   (positive feedback)

   GOOD: bounded queue full → shed load (fast 503) + backpressure upstream
         → clients back off (jittered) → circuit breaker protects deps
         → system DEGRADES (serves less) instead of COLLAPSING (serves nothing)
```

The unifying principle, and the connection back to §68.9: because you cannot tell slow from dead, the *reflexive* reactions (retry, reroute, queue) are exactly what amplify a local problem into a global one. A well-built system is engineered to **degrade gracefully** — shed, fail fast, back off — rather than amplify, so that partial failure stays partial.

---

## 68.25 Putting It Together: The Road Through Part II

Every mechanism in the coming chapters is a response to the constraints laid out here. It is worth seeing the map before diving in.

- **No shared memory + stale copies (§68.3)** → you replicate state by shipping a stream of changes. **Replication (Ch. 69)** — synchronous vs asynchronous, leader-based (PostgreSQL streaming replication) vs leaderless (Cassandra), and quorum reads/writes — is the study of keeping copies useful despite lag.
- **Partitions force a choice (§68.10)** → **CAP and PACELC, and the consistency models (Ch. 70)** formalize what you give up (consistency or availability under partition; and latency vs consistency even without one). Linearizability, causal, and eventual consistency are points on that spectrum.
- **No global clock (§68.6, §68.7)** → **logical time (Ch. 71)**: Lamport clocks, vector clocks, and version vectors give you causality and conflict detection without trusting wall clocks.
- **Scale beyond one node (§68.1)** → **partitioning/sharding (Ch. 72)**: hash vs range partitioning, rebalancing, and routing, plus how transactions and joins survive being split across shards.
- **Leaderless conflict resolution (§68.5)** → **anti-entropy and dissemination (Ch. 73)**: Merkle trees, read-repair, hinted handoff, and gossip protocols that let symmetric nodes converge.
- **The impossibility results and failure detectors (§68.17–68.21)** → **consensus (Ch. 74)**: Paxos, Raft, and atomic broadcast, which achieve agreement by keeping safety unconditional and requiring only eventual synchrony for progress — plus leader election, fencing, and two-phase/three-phase commit.

The unifying discipline: **name your assumptions.** What failure model (crash vs Byzantine)? What synchrony model (you should almost always answer "partial")? What consistency guarantee, and what does it cost in round trips? Every good distributed-systems answer, in an interview or a design doc, starts by pinning those three down — because, as this chapter has shown, the guarantees you can offer are entirely determined by the assumptions you are willing to make about time, failure, and the network.

---

## Summary

- Systems are distributed for **scale** (partition), **availability** (replicate), **geo-locality**, and **fault isolation** — goals that pull against each other, since every mechanism that hides disagreement costs coordination.
- Distribution is hard because of three things a single machine has for free: **shared memory**, a **global clock**, and **total (not partial) failure**. Distributed systems have none: state is communicated by messages, time is local and skewed, and components fail independently.
- The **defining feature is partial failure**: a node cannot distinguish a **crashed** peer from a **slow** one or a **broken link** — silence is ambiguous. This single fact underlies exactly-once impossibility, approximate failure detectors, and FLP.
- The **eight fallacies** (network reliable / zero latency / infinite bandwidth / secure / static topology / one admin / zero transport cost / homogeneous) are the checklist of false assumptions.
- A **remote call is 10³–10⁶× a local memory access** (µs–ms vs ~100 ns); round trips, not bytes, dominate, so batch and minimize coordination.
- **No global "now":** physical clocks drift; NTP bounds skew to ~ms but never to zero and can step backward, so order events with **logical clocks** (Ch. 71) or explicitly bounded time (Spanner TrueTime), never raw wall-clock comparison.
- **Link hierarchy:** fair-loss (raw IP) → stubborn (retransmit forever) → perfect (dedup, exactly-once *between correct processes*). **Exactly-once *delivery* is a myth**; you get effectively-once via **at-least-once + idempotence/dedup**.
- **Message ordering** ladder: none < FIFO < causal < total; total order requires agreement = consensus.
- **Two Generals'**: certain agreement over a lossy link is impossible. **FLP**: no deterministic algorithm guarantees consensus in an asynchronous system with even one crash — dodged in practice by **partial synchrony**, randomization, and **failure detectors**, keeping safety always and liveness when timely.
- **Synchrony models:** synchronous (unreal), asynchronous (FLP-cursed), **partially synchronous** (the practical one). **Failure models:** crash ⊂ omission ⊂ timing ⊂ Byzantine; datacenters assume crash/omission, needing **2f+1** nodes; Byzantine needs **3f+1**.

---

## Key Interview Questions

1. **Why distribute a system at all, given the complexity cost?** — To exceed one machine's capacity (scale via partitioning), survive node/rack/datacenter loss (availability via replication), reduce latency for distant users (geo-locality), and isolate faults / scale elastically. Scale and availability are distinct reasons that pull in different directions.
2. **What three guarantees does a single machine have that a distributed system loses?** — Shared memory (state is instantly visible), a single global clock (a well-defined "now"), and total failure (everything fails at once). Distributed systems have no shared memory, no global clock, and independent partial failure.
3. **What is partial failure, and why is it the defining difficulty?** — Some nodes/links fail while others keep running, and a survivor cannot tell a crashed peer from a slow one or a broken link — silence is ambiguous across at least six scenarios demanding opposite responses. It underlies nearly all distributed-systems machinery.
4. **List the eight fallacies of distributed computing.** — The network is reliable; latency is zero; bandwidth is infinite; the network is secure; topology doesn't change; there is one administrator; transport cost is zero; the network is homogeneous. Each is false and each names a real production failure.
5. **How much slower is a remote call than a local one, and why does it matter?** — A same-datacenter round trip is ~10³–10⁴× a ~100 ns memory access; cross-region is ~10⁵–10⁶× (tens of ms). It means round trips (not bytes) dominate cost, coordination is precious, and chatty N+1 patterns that pass tests locally die over the network.
6. **Why is there no meaningful global "now" in a distributed system?** — Each node has its own drifting physical clock, and a globally simultaneous instant is physically ill-defined for separated nodes exchanging finite-speed signals. "Which event happened first" across nodes must come from causality (logical time), not wall clocks.
7. **Physical vs logical clocks — when do you use each?** — Physical (wall-clock) time is for humans and TTLs but is unreliable for cross-node ordering because of skew. Logical clocks (Lamport, vector — Ch. 71) capture happened-before/causality and give a reliable partial order for conflict resolution. Order across nodes with logical time.
8. **What are clock drift and clock skew, and how well does NTP fix them?** — Drift is the rate a clock diverges from true time (tens of ppm); skew is the instantaneous difference between two clocks. NTP disciplines clocks to ~1–50 ms skew on a LAN (worse on the internet), never to zero, and can step a clock backward, so CLOCK_REALTIME is not monotonic.
9. **Why can't you order writes across nodes by comparing wall-clock timestamps?** — Because skew can make a logically later write carry a smaller timestamp, so last-write-wins can silently discard the newer write (a documented Cassandra data-loss mode). Correctness needs logical clocks or explicitly bounded time (Spanner's TrueTime commit-wait).
10. **What is a network partition and why is it uniquely dangerous?** — A split where groups of live nodes can talk internally but not across the divide; each side thinks the other is dead while both keep running. If both keep serving writes they diverge, forcing the CAP choice between consistency and availability.
11. **State the CAP dilemma in terms of partitions.** — During a partition you must choose: refuse to serve on at least one side (consistency, but unavailable) or keep serving on both (available, but risking divergence). You cannot have both while partitioned; the only choice is what you sacrifice (Ch. 70).
12. **What is a cascading failure and how do you prevent it?** — A localized failure/slowdown whose load shifts to peers, overloading them in a spreading front, amplified by retry storms and unbounded queues. Prevent with exponential backoff + jitter, retry budgets, bounded queues + load shedding, circuit breakers, and backpressure.
13. **Describe the link hierarchy from fair-loss to perfect links.** — Fair-loss (raw IP: may lose/duplicate, no creation, but infinite retransmission eventually delivers) → stubborn (retransmit forever; delivered infinitely often, still duplicates) → perfect (add dedup: reliable, no duplication, no creation — but only between correct/non-crashing processes).
14. **Why does adding retransmission for reliability create duplicates?** — Because the sender retransmits when it gets no ACK, but "no ACK" is ambiguous — the message may have been delivered and only the ACK lost. Resending then delivers the message twice. Sequence numbers + dedup at the receiver are needed to fix it.
15. **Why is exactly-once delivery impossible, and what do systems do instead?** — The sender can't tell "message lost" from "ACK lost," so it must choose at-most-once (may lose) or at-least-once (may duplicate); there is no exactly-once at the transport layer. Systems achieve effectively-once = at-least-once delivery + idempotent operations / dedup by request id.
16. **Give the message-ordering hierarchy and its cost.** — None < FIFO (per-sender order, e.g. one TCP connection) < causal (respects happened-before across senders, via vector clocks) < total (all nodes agree one order for all messages, including concurrent ones). Total order requires agreement, i.e. consensus, and is the most expensive.
17. **What is the Two Generals' Problem and its lesson?** — Two parties needing coordinated action over a lossy link cannot reach certain mutual agreement with any finite message exchange, because the last sender can never be sure its final message arrived (infinite regress). Lesson: aim for high probability + safe residual disagreement, not certainty.
18. **State FLP impossibility precisely.** — In an asynchronous system where even one process may crash, no deterministic algorithm can guarantee consensus (agreement + validity + termination) in bounded time. It sacrifices guaranteed termination; the crux is that a slow process is indistinguishable from a crashed one.
19. **If FLP forbids async consensus, how do etcd, ZooKeeper, and Spanner work?** — They assume partial synchrony: keep safety (agreement/validity) unconditionally and require only eventual timeliness for liveness/termination. Randomization and failure detectors are the other escape hatches. FLP forbids guaranteed bounded-time termination, not practical consensus.
20. **Contrast the three synchrony models.** — Synchronous: known bound on delay/speed — consensus easy but unrealistic. Asynchronous: no bounds — FLP-impossible, too pessimistic. Partially synchronous: bounds exist but are unknown / hold only after some unknown time — the practical model; design safety independent of timing, liveness needing eventual synchrony.
21. **List the failure models from benign to malicious.** — Crash/fail-stop (halts, never lies) ⊂ omission (silently drops some messages) ⊂ timing (correct but late) ⊂ arbitrary/Byzantine (anything, including malicious/contradictory). Each subsumes the previous; tolerating stronger models costs more.
22. **How many nodes to tolerate f failures under crash vs Byzantine faults?** — Crash/omission: 2f+1 (a majority quorum survives f losses). Byzantine: 3f+1, plus signatures and BFT protocols, because faulty nodes may lie differently to different peers. Datacenter databases usually assume crash and use 2f+1.
23. **What failure model do most databases assume, and why not Byzantine?** — Crash/omission under partial synchrony. Byzantine tolerance (3f+1, cryptographic protocols) is expensive and justified only in adversarial/cross-trust settings like public blockchains; inside a trusted datacenter it wastes resources, though silent corruption is handled with checksums.
24. **What is a failure detector, and what two properties define it?** — A component that suspects nodes of having crashed from timing heuristics. Completeness: every crashed node is eventually suspected. Accuracy: live nodes aren't wrongly suspected. You can't have both perfectly in async (that would beat FLP); eventually-perfect (◇P/◇W) detectors are the practical class.
25. **How does a heartbeat timeout embody the completeness/accuracy trade-off?** — A short timeout detects real crashes fast but false-positives on slow nodes (GC pause looks like death → needless failover); a long timeout avoids false positives but reacts slowly. The φ-accrual detector outputs a suspicion level instead of a boolean to adapt to network variance.
26. **What does Spanner's TrueTime do differently from NTP?** — It exposes time as a bounded interval [earliest, latest] enforced by GPS + atomic clocks and waits out the uncertainty (commit-wait) before releasing a commit, guaranteeing external consistency. It never assumes skew is zero — only bounded and known — paying the bound in latency per commit.
27. **Why is coordination the scarce resource in distributed systems?** — Every guarantee that hides observer disagreement (lock, quorum, commit, consensus round) costs at least one network round trip — µs to tens of ms — versus tens of ns for a local mutex. So strong consistency is expensive and systems avoid coordination on the fast path.
28. **What does it mean that "safety" and "liveness" are separated in practical consensus?** — Safety (never decide wrongly / two leaders) is guaranteed unconditionally, regardless of network behavior; liveness (eventually decide / make progress) is only guaranteed during synchronous-enough periods. A bad network costs progress, never correctness — the engineering answer to FLP.

---

## Common Traps

- **Assuming a timeout tells you a node is dead.** A timeout only tells you a node is unreachable *in time*; it cannot distinguish crash, slow node, or partition — treat suspicion as a heuristic, never a fact.
- **Comparing wall-clock timestamps from two machines to decide event order.** Clock skew can invert them; use logical clocks (Lamport/vector) or bounded time, or you silently lose the newer write.
- **Believing a message broker gives true exactly-once delivery at the wire level.** It is impossible; "exactly-once" is always at-least-once delivery plus idempotence/dedup somewhere — know where.
- **Thinking TCP's reliability makes the network reliable end-to-end.** TCP masks loss only within a connection; it cannot mask a partition, a crashed peer, unbounded delay, or a dropped connection, so application-level retries and idempotence are still required.
- **Treating a remote call like a local function call.** It is 10³–10⁶× slower and can fail independently; a loop of per-item RPCs (N+1) that is instant in tests collapses over the WAN.
- **Stating FLP as "consensus is impossible."** FLP forbids only *deterministic, guaranteed-bounded-time* consensus in a *fully asynchronous* model with a crash; partial synchrony, randomization, and failure detectors make real consensus work while keeping safety always.
- **Assuming the synchronous model when reasoning about correctness.** Real networks are partially synchronous — bounds exist but are unknown and violated during pauses/congestion — so never let correctness depend on any fixed timing bound.
- **Retrying aggressively into a struggling system.** Retries multiply load exactly when the system is weakest, turning a local slowdown into a cascading outage; use backoff+jitter, retry budgets, and circuit breakers.
- **Calling Cassandra's last-write-wins "safe" for concurrent writes.** It orders by wall-clock timestamp and can discard the logically newer write under clock skew — a real data-loss mode, not a theoretical one.
- **Designing for Byzantine faults inside a trusted datacenter (or ignoring crash-vs-Byzantine entirely).** Byzantine tolerance needs 3f+1 and cryptography and is wasteful when nodes only crash; conversely, assuming crash-only where corruption occurs misses silent data faults that checksums catch.
- **Forgetting that a network partition means both sides stay alive.** It is not "half the nodes died"; both halves keep running and can diverge, which is why quorums and fencing, not just retries, are required.
