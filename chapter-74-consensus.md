# Chapter 74 — Consensus

*Interview-focused revision notes. The theme: consensus is the single hardest thing a distributed system can ask for — get N machines that fail independently and communicate over an unreliable network to agree, irrevocably, on one value — and yet it is the primitive everything else is built on. Feed a consensus box an endless stream of decisions instead of one, and you have a replicated log; put a deterministic state machine behind that log, and you have a fault-tolerant database. This chapter is the capstone of Part II because every earlier tool — failure detection, leader election, replication, quorums, atomic commit — reappears here as a component of one algorithm.*

---

## 74.1 The Consensus Problem, Defined

**Consensus** is the problem of getting a set of *N* processes, each of which may **propose** a value, to **decide** on exactly one value from among those proposed — and to do so in a way that survives crashes, message loss, and delay. It sounds trivial ("just vote"), and it is provably one of the deepest results in the field: under the fully asynchronous model it is *impossible* to solve deterministically with even one faulty process (§74.3).

Fix the specification precisely, because interviewers probe it. A correct consensus protocol satisfies:

| Property | Statement | Class |
|---|---|---|
| **Agreement** (a.k.a. uniform agreement) | No two correct processes decide different values. | Safety |
| **Validity** (a.k.a. integrity/non-triviality) | If a process decides *v*, then *v* was proposed by some process. | Safety |
| **Integrity** | Each process decides at most once, and its decision is final (irrevocable). | Safety |
| **Termination** | Every correct (non-crashed) process eventually decides. | Liveness |

The split between **safety** and **liveness** is the axis the whole chapter turns on. **Safety** says "nothing bad happens" — you never disagree, never decide a value nobody proposed, never change your mind. **Liveness** says "something good eventually happens" — you don't hang forever. The genius of every practical consensus algorithm is that it makes safety **unconditional** (it holds even during arbitrary asynchrony and partition) and sacrifices only **liveness** when the network misbehaves. You may fail to *make progress* during a partition; you must never *disagree*.

**Uniform vs regular agreement.** *Regular* agreement constrains only correct processes. *Uniform* agreement additionally forbids a process that decides and then *crashes* from having decided differently from the survivors — it matters because a doomed process may have already externalized its decision (sent a reply to a client) before dying. Practical database consensus wants **uniform** agreement: a value a leader "decided" and acknowledged to a client must not be lost even if that leader immediately crashes.

**One decision, then many.** The definition above is **single-decree** consensus — agree on one value, once. Real systems need to agree on an unbounded *sequence* of values (the 5th command, the 6th command, …). That generalization — running consensus over and over on a growing log — is **state-machine replication** (§74.2), and the engineering of doing it efficiently is what separates Multi-Paxos and Raft from textbook single-shot Paxos.

---

## 74.2 Consensus and State-Machine Replication

The reason consensus is not an academic curiosity is a single equation:

```
   deterministic state machine  +  a consensus-ordered log  =  replicated state machine
```

**State-machine replication (SMR)** is the technique: model the service (a key-value store, a SQL database, a lock service) as a **deterministic state machine** that starts in a known state and transitions by applying **commands** in order. If every replica starts identically and applies the *same commands in the same order*, every replica ends in the *same state* — determinism guarantees it. The only distributed problem left is: **agree on the order of commands.** That is exactly a sequence of consensus decisions, one per log slot.

```
 Client cmds ─▶ ┌───────────────── replicated log (agreed order) ─────────────────┐
                │ slot1: SET x=1 │ slot2: SET y=2 │ slot3: DEL x │ slot4: INCR y   │
                └───────┬───────────────┬───────────────┬───────────────┬─────────┘
                        ▼               ▼               ▼               ▼
   Replica A:  apply in order ─────────────────────────────────────────▶  same state
   Replica B:  apply in order ─────────────────────────────────────────▶  same state
   Replica C:  apply in order ─────────────────────────────────────────▶  same state
```

Two invariants make SMR work:

1. **Determinism.** Commands must be deterministic. `SET x = rand()` or `SET t = now()` breaks replication — replicas diverge. Real systems resolve nondeterminism *before* the log: the leader evaluates `now()` and logs the concrete value, so replicas apply an already-deterministic command. (Postgres physical replication sidesteps this entirely by shipping the *byte effects* — the WAL — rather than the logical commands; see §74.30.)
2. **Consensus on order.** Every replica must see an identical, gap-free, totally-ordered prefix of commands. That is the job of consensus per slot, or equivalently **atomic broadcast** (§74.5).

This is why consensus is *the* foundation of consistent distributed databases. etcd, Consul, ZooKeeper, TiKV, CockroachDB, YugabyteDB, and Spanner are all, at their core, **replicated logs guarded by a consensus algorithm** with a deterministic state machine on top. The "database" part is the state machine; the "distributed" part is the consensus. Everything in this chapter serves that equation.

**Consistency payoff.** Because a replicated state machine applies the same commands in the same order, and reads can be served in that order, SMR delivers **linearizability** (Ch. 71 §71.2) — the strongest single-object consistency model — for the whole service, not just one register. Consensus is how you make an entire database behave as if it were a single machine that never fails.

---

## 74.3 FLP and How Consensus Sidesteps It

You cannot discuss consensus without confronting the **FLP impossibility result** (Fischer, Lynch, Paterson, 1985; Ch. 68 §68.4). It states:

> In an **asynchronous** system (no bound on message delay or relative process speed) where even **one** process may fail by crashing, there is **no deterministic** protocol that solves consensus guaranteeing **both** safety and termination.

The intuition: in a purely asynchronous world you **cannot distinguish a crashed process from a slow one or a slow network** (Ch. 68 §68.2). A protocol that waits for a possibly-dead process may wait forever (violating termination); a protocol that gives up on it may be wrong if it was merely slow (risking agreement). FLP constructs an adversarial scheduler that keeps the system perpetually in a "bivalent" (undecided) state, delaying the one decisive message forever.

FLP is about **determinism in full asynchrony**, and every real algorithm dodges it by weakening exactly one assumption while *never* weakening safety:

| Escape hatch | Mechanism | Used by |
|---|---|---|
| **Partial synchrony** | Assume the network is *eventually* synchronous — after some unknown "global stabilization time" (GST), messages arrive within a bound *Δ*. Safety always holds; **termination holds once the network behaves.** | Paxos, Raft, PBFT, Viewstamped Replication |
| **Failure detectors** | Assume an oracle (⋄S, "eventually strong") that eventually stops suspecting correct processes. Chandra–Toueg showed ⋄S is the *weakest* detector that solves consensus with a majority correct. | The theory underlying leader-based protocols |
| **Randomization** | Use coin flips so the adversary cannot fix a schedule that stalls forever; terminates with probability 1. | Ben-Or, and modern BFT (HoneyBadgerBFT) |

The practical embodiment of partial synchrony is a **leader plus randomized timeouts**. A single leader proposes so proposals don't collide (that is the *safety-preserving liveness* trick); **randomized election timeouts** (Raft, §74.20) ensure that when the leader dies, some follower's timer fires first and it becomes the new leader, breaking symmetry the way randomization breaks FLP's adversarial schedule. When the network is asynchronous, elections may repeatedly fail and no progress is made — **but no two nodes ever disagree.** FLP is not violated; it is *routed around* by conceding liveness precisely in the conditions FLP exploits.

The one-line answer to "how does Raft beat FLP?": **it doesn't** — it keeps safety unconditionally and gives up liveness during asynchrony, which is exactly what FLP says you must do.

---

## 74.4 Broadcast Abstractions: Best-Effort, Reliable, Uniform Reliable

Consensus is usually built from — and is equivalent to — **broadcast** primitives. A broadcast delivers a message from one sender to all members of a group. The abstractions form a strict hierarchy of guarantees; know all of them.

- **Best-effort broadcast.** If the sender is correct, every correct process delivers the message. If the sender crashes mid-broadcast, some may deliver and some may not. No atomicity — the weakest form, essentially "send to each member and hope."

- **Reliable broadcast.** Adds **agreement on delivery**: if *any* correct process delivers a message *m*, then *every* correct process delivers *m* — even if the original sender crashes partway through. Implemented by having the first receiver **re-broadcast** (echo) before delivering, so a message that reached anyone reaches everyone. It fixes the "sender dies halfway" hole but says **nothing about order**: two correct processes may deliver `m1` and `m2` in opposite orders.

- **Uniform reliable broadcast.** Strengthens the guarantee to *uniformity*: if *any* process delivers *m* (even one that then crashes), all correct processes deliver *m*. This matters for the same reason uniform agreement does — a process may act on a delivered message before dying.

- **FIFO / causal broadcast.** Orthogonal ordering constraints. FIFO: messages from the *same* sender are delivered in send order. Causal: if `m1` causally precedes `m2` (Ch. 69 vector-clock happened-before), no process delivers `m2` before `m1`. Neither imposes a *total* order across different senders.

```
Guarantee ladder (each row adds to the one above):
  best-effort  : correct sender ⇒ all correct deliver
  reliable     : + any correct delivers ⇒ all correct deliver (sender may crash)
  uniform      : + any process (even crashing) delivers ⇒ all correct deliver
  FIFO/causal  : + per-sender / causal ordering
  ATOMIC/TOTAL : + one global total order agreed by all (⇔ consensus, §74.5)
```

The top of the ladder — a single agreed **total order** — is the one that requires consensus, and it is the one databases need.

---

## 74.5 Atomic (Total-Order) Broadcast and Its Equivalence to Consensus

**Atomic broadcast** (equivalently **total-order broadcast**) is reliable broadcast plus a **total order** property: all correct processes deliver all messages, and they deliver them in the **same order**. Formally it adds:

- **Total order:** if processes *p* and *q* both deliver `m1` and `m2`, then *p* delivers `m1` before `m2` **iff** *q* delivers `m1` before `m2`.

This is precisely what SMR (§74.2) needs: feed every replica the same messages in the same order and their state machines stay identical. Atomic broadcast **is** the "agree on the order of commands" requirement.

**The equivalence (Chandra–Toueg, 1996):** atomic broadcast and consensus are **reducible to each other** — solving one solves the other, so they are equally hard and neither is solvable in pure asynchrony:

- **Consensus ⇒ atomic broadcast.** Run a sequence of consensus instances, one per log slot. Instance *k* decides the *k*-th message to deliver. Every process delivers in slot order; total order follows because every process agrees on each slot's value. (This is literally Multi-Paxos and Raft.)
- **Atomic broadcast ⇒ consensus.** To decide one value, each participant atomically broadcasts its proposal; every correct process delivers the same first message; decide that. Same order ⇒ same decision ⇒ agreement.

The interview takeaway: **atomic broadcast, total-order broadcast, and consensus-over-a-log are the same problem wearing different names.** When someone says "we need a totally ordered replicated log," they are saying "we need consensus." ZAB (§74.7) is explicitly framed as atomic broadcast; Paxos and Raft are framed as consensus; they solve the identical underlying problem.

---

## 74.6 Virtual Synchrony and View-Synchronous Communication

Before Paxos dominated, the **virtual synchrony** model (Birman's ISIS, ~1987; later Horus, Ensemble, and Spread) approached the same territory through **group membership** rather than a replicated log. It is worth knowing both as history and because its ideas recur (ZooKeeper sessions, Kafka's ISR).

The core object is a **view**: the current agreed-upon membership of the group. The system installs a sequence of views `V0, V1, V2, …` as processes join, leave, or are suspected. **View-synchronous communication** guarantees that **messages are delivered relative to view changes consistently**: all processes that survive from view `Vi` to `Vi+1` agree on the *set* of messages delivered in `Vi` before the new view is installed. Informally, everyone "sees the same messages between the same membership changes," as if message delivery and membership changes happened at synchronized instants — hence *virtual* synchrony.

Key distinction from atomic broadcast: virtual synchrony's default (`fbcast`) provides FIFO/causal, not total, order; total order (`abcast`) is a stronger, more expensive mode. Its strength is efficient reliable multicast within a stable membership; its weakness is that **membership changes are a heavyweight, blocking event**, and the model historically struggled with partitions (primary-partition vs partitionable variants). Modern consensus systems fold membership *into* the log (Raft joint consensus, §74.24) rather than treating it as a separate protocol, which is generally cleaner. Still, the mental model — "state is replicated within a view, and view changes are agreement points" — is exactly how you should think about a ZooKeeper ensemble or a Kafka ISR set.

---

## 74.7 ZooKeeper Atomic Broadcast (ZAB)

**ZAB** is the consensus protocol underneath **Apache ZooKeeper** — the coordination service that, for a decade, was the de-facto lock/config/leader-election store behind Hadoop, HBase, Kafka (pre-KRaft), Solr, and countless others. ZAB is *leader-based atomic broadcast*, engineered specifically so ZooKeeper's replicated state machine (a small in-memory tree of "znodes") stays consistent.

ZAB's structure resembles Multi-Paxos/Raft but predates the latter and uses its own vocabulary:

- **Epochs.** Time is divided into **epochs**, each with a single **leader** (Raft's "term," Paxos's "ballot"). A monotonically increasing epoch number tags every leader's reign.
- **zxid (ZooKeeper transaction id).** Every proposed state change gets a 64-bit **zxid** = `(epoch << 32) | counter`: the high 32 bits are the epoch, the low 32 bits a per-epoch monotonically increasing counter. This makes zxids **totally ordered** and encodes which leader created each transaction — the basis of ordering and recovery.
- **Two-phase, leader-driven broadcast.** In steady state the leader broadcasts each update: **PROPOSE** (send the transaction with its zxid to followers) → followers persist and **ACK** → once a **quorum** (majority) has ACKed, the leader sends **COMMIT** and applies it. This is a normal-case two-round-trip agreement, identical in spirit to Multi-Paxos Phase 2.

```
ZAB broadcast (steady state):
  Leader                 Followers (quorum = majority)
    │  PROPOSE(zxid, txn) │────────────▶  persist to log
    │  ◀─────── ACK ──────│
    │  (wait for majority ACK)
    │  COMMIT(zxid)       │────────────▶  apply to state (deliver)
```

The subtlety is **recovery / leader activation**, which enforces two ZAB-specific properties beyond generic atomic broadcast:

- **Primary order (causal per-leader order):** transactions from one leader are delivered in the order that leader proposed them.
- **A new leader must not "forget" committed history.** On election, ZAB runs a **discovery + synchronization** phase: the prospective leader collects followers' latest zxids, adopts the most up-to-date history (the follower with the highest zxid wins, like Raft's election restriction, §74.22), establishes a new epoch, and **synchronizes** all followers to that history before serving. This guarantees the new epoch's log is a superset of everything previously committed — ZAB's answer to the same problem Raft solves with leader completeness.

Practical notes interviewers like: ZooKeeper writes go through the leader (linearizable writes); **reads are served locally by any follower and are therefore NOT linearizable by default** — a client can read stale data. ZooKeeper offers `sync()` to force a read to see all prior writes. Watches, ephemeral znodes, and sessions are built on top of this ordered log; a leader election recipe (smallest-sequential-ephemeral-znode wins) is a classic ZooKeeper pattern (Ch. 70 §70.6).

---

## 74.8 Paxos: Roles and the Big Picture

**Paxos** (Lamport, "The Part-Time Parliament" 1998, "Paxos Made Simple" 2001) is the archetypal asynchronous consensus algorithm — the one every other is compared to. It solves **single-decree** consensus (agree on one value) safely under crash faults and arbitrary asynchrony, and terminates once the network is well-behaved. It is famously subtle; the payoff for grinding through it is that Raft and every Paxos variant become obvious afterward.

Paxos assigns three **roles** (one physical node typically plays several):

- **Proposer.** Advocates a value and drives the two-phase protocol. Proposals are tagged with a **ballot number** (a.k.a. proposal number / round number) — a globally unique, monotonically increasing identifier, usually `(counter, server-id)` so ties break deterministically and every proposer draws from a disjoint sequence.
- **Acceptor.** The "memory" of the protocol. A majority of acceptors constitute a **quorum**; acceptors vote on ballots and remember what they have promised and accepted. Safety lives in the acceptors' durable state.
- **Learner.** Learns the chosen value once a quorum of acceptors has accepted it, and acts on it (applies it to the state machine, replies to the client).

The single most important structural fact: Paxos uses **majority quorums**, and its entire safety argument rests on the fact that **any two majorities of the same set intersect in at least one node** (§74.11). That one node is the bridge that carries a chosen value forward across ballots.

The protocol runs in **two phases**, each a round-trip between a proposer and the acceptors (§74.9, §74.10). Phase 1 is "establish authority and discover any value that might already be chosen." Phase 2 is "get a value accepted by a majority." A value is **chosen** the instant a majority of acceptors have *accepted* it in some ballot — even if no one has yet *learned* it.

---

## 74.9 Paxos Phase 1 — Prepare / Promise

A proposer that wants to get a value chosen begins by picking a ballot number **b** higher than any it has used, and sends **Prepare(b)** to (at least) a majority of acceptors. It does **not** yet include a value — Phase 1 is about acquiring the right to propose and learning what may already be in flight.

An acceptor receiving **Prepare(b)** does the following, and this rule is the heart of Paxos safety:

- If **b** is **greater** than any ballot it has already promised, it responds with **Promise(b)** — a commitment to **reject all future messages with a ballot < b** (both Prepares and Accepts). Along with the promise it returns the **highest-numbered proposal it has already accepted**, if any: the pair `(accepted_ballot, accepted_value)`. If it has accepted nothing, it returns "none."
- If **b** is **not** greater than a ballot it already promised, it **ignores or NACKs** the Prepare (it has already promised to a higher ballot).

```
Phase 1 (Prepare / Promise):

 Proposer                     A1        A2        A3   (majority = 2 of 3)
    │  Prepare(b=5)  ───────▶  │         │         │
    │                          │ promise b=5, return highest accepted (v?, ba?)
    │  ◀── Promise(5, ⟨none⟩) ─┤         │         │
    │  ◀── Promise(5, ⟨v=x, ba=3⟩) ──────┤         │
    │  (got a majority of promises)
```

When the proposer has collected **Promise(b)** from a **majority**, it moves to Phase 2. Crucially it inspects the accepted values returned in those promises:

- If **any** acceptor reported a previously-accepted value, the proposer **must** propose the value with the **highest accepted ballot** among the responses — it is not free to propose its own value. This is the **"adopt the highest previously-accepted value"** rule, and it is what prevents two different values from ever being chosen.
- If **no** acceptor reported an accepted value, the proposer is free to propose **its own** value.

The mnemonic: **Phase 1 is a leadership claim plus a "what did I miss?" query.** By promising, a majority locks out lower ballots; by returning their accepted values, they force any new leader to respect whatever might already be chosen.

---

## 74.10 Paxos Phase 2 — Accept / Accepted

With a majority of promises in hand and a value chosen per the Phase-1 rule (its own, or the highest previously-accepted), the proposer sends **Accept(b, v)** to a majority of acceptors — a request to actually accept value **v** in ballot **b**.

An acceptor receiving **Accept(b, v)**:

- If it has **not** promised to any ballot **> b**, it **accepts**: it durably records `(b, v)` as its latest accepted proposal and replies **Accepted(b, v)** (typically also informing the learners).
- If it *has* promised to a higher ballot (because some other proposer ran Phase 1 with a bigger number in between), it **rejects** — its earlier Promise forbids accepting the now-stale **b**.

```
Phase 2 (Accept / Accepted):

 Proposer                     A1        A2        A3
    │  Accept(b=5, v=x) ────▶  │         │         │
    │                          │ accept (5,x) if no promise > 5
    │  ◀──── Accepted(5, x) ───┤         │         │
    │  ◀──── Accepted(5, x) ───────────┤           │
    │  (majority accepted ⇒ x is CHOSEN)
    │
    │  learners observe a majority of Accepted(5,x) ⇒ learn x, apply it
```

**A value is chosen the moment a majority of acceptors have accepted it in the same ballot.** That may happen before any learner knows it; learning is just observing the majority. Once chosen, no other value can ever be chosen (§74.11), so the decision is final and irrevocable — satisfying agreement and integrity.

Counting messages: the happy path is **two round-trips** — Prepare/Promise then Accept/Accepted — i.e., **four message delays** from proposer to decision, or two if you count each phase as one RTT. Multi-Paxos (§74.13) exists precisely to amortize the Phase-1 round-trip away in steady state.

---

## 74.11 Why Paxos Is Safe: Quorum Intersection

Everything rests on one lemma. State it crisply because it is the most common Paxos interview question.

**Quorum intersection.** Any two majorities of the same *N* acceptors share at least one acceptor. Proof: two subsets each of size > N/2 have sizes summing to > N, so by pigeonhole they cannot be disjoint — they overlap in ≥ 1 node.

```
   N = 5 acceptors:   A1 A2 A3 A4 A5
   majority Q1 = {A1,A2,A3}      majority Q2 = {A3,A4,A5}
                     └──── overlap = {A3} ────┘   (guaranteed non-empty)
```

Now the safety argument. Suppose value **v** is chosen in ballot **b** — a majority `Q` accepted `(b, v)`. Consider any later proposer running ballot **b' > b**. To get its value accepted it must complete Phase 1 with some majority `Q'`. Because `Q ∩ Q' ≠ ∅`, at least one acceptor is in both. That acceptor **accepted `(b, v)`** and, having done so, will report `(b, v)` (or something with a ballot ≥ b) in its Promise to `b'`. Therefore the proposer of `b'` sees an accepted value with the highest ballot ≥ b and is **forced by the Phase-1 rule (§74.9) to propose `v`** — not its own value. By induction over every ballot > b, **every subsequent choice is also `v`.** Hence at most one value is ever chosen: **agreement holds.**

The elegance: safety needs **no synchrony, no failure detector, no leader.** Even with proposers dueling, messages reordered arbitrarily, and nodes crashing and recovering (with durable acceptor state), Paxos **never** lets two values be chosen. Ballot numbers give a total order on attempts; majority overlap carries the winner forward; the "adopt highest accepted" rule enforces it. Asynchrony can only stop *progress* (§74.12), never *correctness*.

The corollary for quorum sizing: with **N = 2f + 1** acceptors, a majority is **f + 1**, and the system tolerates **f** crash failures while still forming a quorum from the survivors. That is the crash-fault quorum arithmetic used by Paxos, Raft, and ZAB alike (§74.28).

---

## 74.12 Paxos Failure Scenarios: Dueling Proposers and Livelock

Paxos's safety is unconditional; its **liveness** is not — and the canonical failure is **dueling proposers** (a.k.a. **livelock**), the concrete face of FLP.

Two proposers, P1 and P2, each keep trying to get their value chosen:

```
  P1: Prepare(b=1)  ──▶ majority promises for b=1
  P2: Prepare(b=2)  ──▶ majority promises for b=2   (now b=1 is dead)
  P1: Accept(b=1,x) ──▶ REJECTED (acceptors promised b=2)
  P1: Prepare(b=3)  ──▶ majority promises for b=3   (now b=2 is dead)
  P2: Accept(b=2,y) ──▶ REJECTED (acceptors promised b=3)
  P2: Prepare(b=4)  ──▶ ...  and so on, forever
```

Each proposer's Prepare invalidates the other's in-flight Accept, so neither ever completes Phase 2. The protocol makes **no progress** even though no node has crashed — a pure liveness failure. **Note what does NOT happen: no value is ever chosen incorrectly, and no two values are chosen.** Safety is intact; only termination fails. This is FLP made concrete: in the bad schedule, the decisive message is forever preempted.

The fix is not in the core protocol (Paxos deliberately leaves it out) but in the deployment: **elect a single distinguished proposer (leader)** so that in the common case only one proposer runs Phase 1, eliminating the duel. Add **randomized backoff** on Prepare so that if a duel starts, one proposer probabilistically wins the next round. This is exactly the "leader + randomized timeout" partial-synchrony escape from §74.3, and it is why **Multi-Paxos** and **Raft** are built around a stable leader: not for correctness, but for liveness. Under a stable leader and a synchronous-enough network, Paxos terminates in one Phase-2 round-trip per decision.

---

## 74.13 Multi-Paxos: A Stable Leader and a Log

Single-decree Paxos agrees on **one** value at the cost of two round-trips. A database needs to agree on an unbounded **sequence** of values (log slots). Running full Paxos per slot would cost two RTTs each and invite constant dueling. **Multi-Paxos** is the practical protocol used by real systems — Google Chubby, Spanner, Megastore — and it rests on one optimization: **a stable leader amortizes Phase 1 across the whole log.**

The insight: **Phase 1 (Prepare/Promise) does not mention a value or a slot** — it is purely a claim to a ballot number. So a proposer can run Phase 1 **once** for a ballot **b**, and that promise applies to **all** log slots simultaneously. Having become the stable leader for ballot **b**, it then, for each incoming command, runs **only Phase 2** (Accept/Accepted) on the next open slot:

```
  Multi-Paxos steady state (leader established for ballot b):
    slot 3:  Accept(b, cmd_A) ─▶ majority Accepted ─▶ chosen  (1 RTT)
    slot 4:  Accept(b, cmd_B) ─▶ majority Accepted ─▶ chosen  (1 RTT)
    slot 5:  Accept(b, cmd_C) ─▶ majority Accepted ─▶ chosen  (1 RTT)
     ...  Phase 1 was paid ONCE, at leader election, for all slots.
```

The result: **one round-trip (one majority RTT) per decision** in steady state, plus batching and pipelining (§74.29). Phase 1 is re-run only when the leader changes (a new leader must Prepare a higher ballot to claim leadership and, via the returned accepted values, recover any half-finished slots the previous leader left).

Multi-Paxos brings real complications the papers gloss over — and interviewers love the gaps:

- **Leader election.** Multi-Paxos assumes a leader but "does not specify how to elect one." In practice you layer a leader-election/failure-detector mechanism (leases, §74.28) on top; this vagueness is one reason Raft was created.
- **Log holes / gaps.** With pipelining, slot 6 may be chosen before slot 5 (its Accept was lost). The state machine must apply **in order**, so slot 6 can't be applied until 5 is filled. The leader fills gaps by running Paxos for the missing slot (proposing a no-op if nothing is pending).
- **Recovery and catch-up.** A new leader must learn the highest chosen slot and re-propose any uncommitted tail; lagging followers must be caught up (snapshot + log tail).

Multi-Paxos is best understood as: **Paxos for safety, a stable leader for liveness, a log of instances for SMR.** Raft (§74.19) is essentially this same design with a stricter, more prescriptive packaging.

---

## 74.14 Fast Paxos

**Fast Paxos** (Lamport, 2005) attacks the *latency* of getting a value chosen. Classic Paxos, even with a stable leader (Multi-Paxos), needs the client to route its command **through the leader**: client → leader → acceptors → back, which is **two message delays** to the acceptors plus the client hop. Fast Paxos lets clients send proposals **directly to the acceptors**, saving the hop through the leader — reducing the common case from three message delays to **two**.

The cost of skipping the leader-as-serializer is that acceptors may receive **different** values concurrently (no leader ordered them first), so Fast Paxos needs **larger quorums** to keep safety. It distinguishes:

- **Classic quorums** for coordinator-driven ("slow") rounds: a simple majority, `⌊N/2⌋ + 1`.
- **Fast quorums** for leaderless ("fast") rounds: strictly larger. To resolve collisions safely, a fast quorum must be large enough that any two fast quorums intersect in a *classic* majority — commonly `⌈3N/4⌉`, and tolerating **f** faults requires `N ≥ 3f + 1` for fast rounds (vs `2f+1` for classic).

When two clients send different values in the same fast round, a **collision** occurs; no value gets a fast quorum, and Fast Paxos falls back to a **classic round** (coordinator picks a value and runs a normal Paxos round) to recover — adding latency back. So Fast Paxos wins when contention is **low** (collisions rare) and loses when it is high. In practice its larger quorums and collision recovery made it less popular than Multi-Paxos for general use, but the idea — trade quorum size for round-trips — recurs in EPaxos and in "fast path" optimizations throughout the literature.

---

## 74.15 Flexible Paxos (FPaxos)

**Flexible Paxos** (Howard, Malkhi, Spiegelman, 2016) is a beautiful late realization about Paxos's quorums: the two phases do **not** both need majorities. The only thing safety actually requires is that **every Phase-1 quorum intersects every Phase-2 quorum** — the phases must cross, but *same-phase* quorums need not.

Formally, let `Q1` be the Phase-1 (Prepare) quorum size and `Q2` the Phase-2 (Accept) quorum size. Safety holds as long as:

```
   Q1 + Q2 > N        (every leader-election quorum meets every replication quorum)
```

Classic Paxos sets `Q1 = Q2 = ⌊N/2⌋ + 1`, which satisfies `Q1 + Q2 = N + 1 > N` — so majorities are just *one* valid point in a whole design space. But you can trade:

| Configuration (N=5) | Q1 (Phase 1 / election) | Q2 (Phase 2 / replication) | Effect |
|---|---|---|---|
| Majority (classic) | 3 | 3 | Symmetric; tolerates 2 failures either phase |
| Write-optimized | 4 | 2 | **Every write needs only 2 acks** (fast, cheap replication); leader election needs 4 |
| Read/election-optimized | 2 | 4 | Cheap leader election; expensive replication |

The write-optimized case is the practical prize: since steady-state throughput is dominated by Phase 2 (§74.13), shrinking `Q2` to 2 makes every commit cheaper and lower-latency, at the price of a heavier (and rare) leader-election quorum. There is even a "grid quorum" variant where Phase-2 quorums are single rows and Phase-1 quorums are columns, so `Q2` quorums needn't intersect each other at all. FPaxos reframes the whole quorum question: **majorities are sufficient, not necessary; the necessary condition is cross-phase intersection.** It is a favorite "did you actually understand why quorums are majorities?" interview probe.

---

## 74.16 Egalitarian Paxos (EPaxos)

**Egalitarian Paxos (EPaxos)** (Moraru, Andersen, Kaminsky, 2013) removes the stable leader entirely. Multi-Paxos routes every command through one leader — a **bottleneck** and a **latency penalty** for clients far from it, and a single point whose failure stalls the system. EPaxos is **leaderless**: any replica can commit any command, and clients talk to their **nearest** replica.

The key idea is to exploit **command commutativity**. Two commands **interfere** if they don't commute (e.g., both write key *x*, or one reads what the other writes). EPaxos only needs to order **interfering** commands relative to each other; **independent** commands can be committed in parallel with no coordination on their mutual order.

- Each command is committed with a set of **dependencies** — the interfering commands it must be ordered after. Replicas build a **dependency graph** rather than a single linear log.
- **Fast path:** if a command has **no interfering concurrent commands**, a replica commits it in **one round-trip** to a fast quorum (`⌈3N/4⌉`-ish), like Fast Paxos.
- **Slow path:** if there is a conflict (dependencies disagree), it falls back to a second round-trip (a classic Paxos round) to agree on the dependency set.
- **Execution:** to apply commands, replicas **topologically sort** the dependency graph; strongly connected components (cycles) are ordered deterministically. Non-interfering commands need no global order at all.

```
Multi-Paxos:  all commands ─▶ single leader ─▶ one linear log   (leader = bottleneck)

EPaxos:       cmd A (key x) ─┐
              cmd B (key y) ─┼─ committed in parallel, any replica, 1 RTT if no conflict
              cmd C (key x) ─┘   C depends on A (both touch x) ⇒ ordered after A
```

Benefits: **no leader bottleneck**, optimal commit latency (nearest quorum, one RTT in the common low-conflict case), and even load. Costs: **substantial complexity** (dependency tracking, graph execution, cycle handling), and performance that **degrades under high conflict** (many commands touching the same keys force slow paths). EPaxos is the intellectual endpoint of "do the minimum ordering necessary," and it strongly influenced later designs (Accord in Cassandra, various "leaderless" SMR systems). It is the canonical answer to "how do you get consensus without a leader bottleneck?"

---

## 74.17 Generalized Paxos and Commuting Commands

**Generalized Paxos** (Lamport, 2005) is the conceptual parent of EPaxos's commutativity idea. Classic consensus agrees on a **totally ordered** sequence of commands. Generalized Paxos observes that a total order is **stronger than necessary**: if two commands **commute** (applying them in either order yields the same state — e.g., `INCR a` and `INCR b`), the replicas need not agree on their relative order at all. They need only agree on a **partial order** (technically, on a *command structure* / c-struct) that is consistent up to commutativity.

The payoff mirrors Fast Paxos: replicas can accept commuting commands via the **fast path** (direct-to-acceptor, one round-trip) and only invoke the slower coordinated round when **non-commuting** commands conflict and must be ordered. It generalizes Fast Paxos by treating "collision" not as "different values" but as "non-commuting commands" — commuting concurrent proposals are *not* a conflict and don't force a slow round.

The line to draw for interviews:

- **Fast Paxos** — fewer round-trips via larger quorums, but any two distinct concurrent values collide.
- **Generalized Paxos** — collisions only when commands **don't commute**; commuting commands proceed on the fast path.
- **EPaxos** — the same commutativity insight made fully **leaderless** via explicit per-command dependency graphs.

All three trade the simplicity of a single total order for lower latency by exploiting the semantic fact that most concurrent operations in real workloads **commute** (touch different keys). It is the deepest strand of Paxos research and the reason "does this command commute?" is a first-class question in modern SMR design.

---

## 74.18 Paxos Variants Compared

A consolidated table — the kind you should be able to sketch on a whiteboard.

| Variant | Leader? | Common-case latency | Quorum | Key idea | Trade-off |
|---|---|---|---|---|---|
| **Single-decree Paxos** | none (any proposer) | 2 RTT (Phase 1 + 2) | majority `f+1` of `2f+1` | Two-phase, ballot numbers, adopt-highest | One value only; dueling proposers livelock |
| **Multi-Paxos** | stable leader | 1 RTT / decision | majority | Amortize Phase 1 across all log slots | Leader = bottleneck & SPOF; election unspecified |
| **Fast Paxos** | optional | 2 message delays (skip leader) | fast quorum `~3N/4`, `N≥3f+1` | Clients → acceptors directly | Larger quorums; collisions ⇒ slow-path recovery |
| **Flexible Paxos** | stable leader | 1 RTT, small `Q2` | any `Q1 + Q2 > N` | Only cross-phase intersection is required | Small `Q2` ⇒ larger `Q1` election quorum |
| **Generalized Paxos** | optional | 1 RTT for commuting cmds | fast quorum | Agree on partial order up to commutativity | Complexity; conflicts still need slow path |
| **EPaxos** | **none (leaderless)** | 1 RTT (low conflict) | fast `~3N/4`, classic majority fallback | Per-command dependency graph; nearest replica | Complex; degrades under high conflict |

The through-line: **Multi-Paxos** trades latency for leader-side simplicity; **Fast/Generalized/EPaxos** trade complexity (bigger quorums, dependency tracking) for lower latency and load-balancing; **Flexible Paxos** trades quorum symmetry for cheaper writes. All keep the identical Paxos safety core — majority (or cross-)intersection carrying a chosen value forward.

---

## 74.19 Raft: Design for Understandability

**Raft** (Ongaro & Ousterhout, 2014, "In Search of an Understandable Consensus Algorithm") solves the same problem as Multi-Paxos but was designed with an explicit primary goal: **understandability**. The authors argued Paxos is so hard to grasp that engineers can't build correct systems from it, so Raft **decomposes** consensus into three relatively independent sub-problems and adds strong **structural constraints** to shrink the state space:

1. **Leader election** (§74.20) — how a new leader is chosen when the old one fails.
2. **Log replication** (§74.21) — how the leader accepts commands and replicates the log.
3. **Safety** (§74.22) — the constraints that guarantee correctness (log matching, election restriction, commitment rule).

Raft is a **strong-leader** protocol — even more so than Multi-Paxos. Its defining simplifications:

- **Log entries flow in one direction only: leader → followers.** A follower never overwrites the leader's entries with its own; conflicts are always resolved in the leader's favor. This makes the log much easier to reason about than Paxos's per-slot independent agreement.
- **A leader is never elected unless its log is at least as up-to-date as a majority** (the election restriction, §74.22), so a leader never needs to *fetch* missing committed entries — it already has them all. This eliminates a whole class of Multi-Paxos recovery complexity.

Adoption reflects the design win: Raft is the consensus layer of **etcd** (and thus Kubernetes' backing store), **Consul**, **CockroachDB** and **TiKV** (per-range Raft groups — "multi-raft"), **YugabyteDB**, **RethinkDB**, **Kafka's KRaft** mode (replacing ZooKeeper), and MongoDB's replication (a Raft-like protocol). When a modern system says "we use Raft," it is choosing Multi-Paxos-equivalent guarantees in a package engineers can actually implement and test.

---

## 74.20 Raft Leader Election and Terms

Raft divides time into **terms**, its logical clock and the equivalent of Paxos ballots / ZAB epochs. Each term is a monotonically increasing integer with **at most one leader**; some terms have no leader (a failed election). Every message carries the sender's `currentTerm`, and **a node that sees a higher term immediately reverts to follower and adopts it** — terms are how stale leaders are detected and deposed.

A node is in one of three states:

```
        times out,          receives majority
        starts election        of votes
  ┌──────────┐  ─────────▶  ┌───────────┐  ─────────▶  ┌────────┐
  │ FOLLOWER │              │ CANDIDATE │              │ LEADER │
  └──────────┘  ◀─────────  └───────────┘              └────────┘
        ▲   discovers leader      │ discovers current            │
        │   or higher term        │ leader / higher term         │
        └─────────────────────────┴──────────────────────────────┘
```

- **Followers** are passive: they respond to leaders and candidates. If a follower hears nothing (no AppendEntries, no heartbeat) for its **election timeout**, it assumes the leader is dead.
- On timeout a follower becomes a **candidate**: it increments `currentTerm`, votes for itself, and sends **RequestVote** RPCs to all peers. A node grants its vote if (a) it hasn't voted this term (**at most one vote per term** — this is what prevents two leaders) and (b) the candidate's log is **at least as up-to-date** as its own (the election restriction, §74.22).
- A candidate that collects votes from a **majority** becomes **leader** and immediately sends heartbeats to assert authority and suppress further elections.

**Split votes** are Raft's dueling-proposers analogue: if several followers time out simultaneously and become candidates, the vote may split with no majority, and the term ends leaderless. Raft's fix is **randomized election timeouts** — each node picks its timeout randomly from a range (e.g., 150–300 ms). One node almost always times out first, wins the election before others start, and the randomization makes repeated splits exponentially unlikely. This is the concrete "randomized timeout" partial-synchrony mechanism from §74.3. The leader sends periodic heartbeats well within the election timeout so healthy followers never start elections.

---

## 74.21 Raft Log Replication and Commitment

Once elected, the leader serves all client requests (writes; §74.28 covers reads). Each command becomes a **log entry** tagged with the **term** in which it was created and its **index** (position). The leader appends the entry to its own log, then replicates it via **AppendEntries** RPCs.

```
Raft logs (index → [term | command]); leader replicates to followers:

  index:     1      2      3      4      5
  Leader:  [1|x=1][1|y=2][2|z=3][3|x=9][3|y=7]   ← leader for term 3
  Follower:[1|x=1][1|y=2][2|z=3][3|x=9]          ← lagging by one entry
                                        └ AppendEntries(index 5) in flight

  AppendEntries also carries (prevLogIndex, prevLogTerm) for the entry BEFORE the
  new ones; the follower rejects unless its log matches there → Log Matching (§74.22).
```

The **commitment** rule is central:

- An entry is **committed** once the leader has replicated it to a **majority** of the cluster (including itself). Commitment means the entry is durable and will never be lost — it is the point analogous to a Paxos value being "chosen."
- The leader tracks a **commitIndex** — the highest index known committed — and piggybacks it on AppendEntries so followers learn what has committed and can **apply** entries to their state machines in index order.
- **A leader only counts replication of entries from its OWN current term toward commitment.** It may **not** conclude that an entry from a *previous* term is committed merely because it now sits on a majority — a famous subtlety (Figure 8 of the Raft paper). It commits old entries only indirectly, by committing a new same-term entry above them. Ignoring this rule allows a committed entry to be overwritten — a safety violation. (See §74.23.)

Because entries flow only leader → follower and each AppendEntries includes `(prevLogIndex, prevLogTerm)`, followers can only extend the leader's log at the correct point; any divergent tail is detected and repaired (§74.23). Heartbeats are just empty AppendEntries, so the same RPC maintains authority and replicates data.

---

## 74.22 Raft Safety: Log Matching and the Election Restriction

Raft's correctness reduces to a chain of properties. Know the two that carry the argument.

**Log Matching Property.** If two logs contain an entry with the **same index and same term**, then (a) they store the **same command** at that index, and (b) the logs are **identical in all preceding entries**. This is maintained by two facts: the leader creates at most one entry per index per term, and AppendEntries' consistency check `(prevLogIndex, prevLogTerm)` refuses to append unless the previous entry matches — an inductive guarantee that a matching entry implies matching history. Consequence: logs never diverge in their committed prefix; a single (index, term) pair pins the entire preceding log.

**Leader Completeness / the Election Restriction.** *If an entry is committed in a given term, it is present in the logs of all leaders of higher terms.* Raft guarantees this by restricting **who can be elected**: RequestVote includes the candidate's `lastLogIndex` and `lastLogTerm`, and a voter grants its vote **only if the candidate's log is at least as up-to-date** as its own. "At least as up-to-date" means: higher last term wins; if equal terms, the longer log wins.

Why this works: a committed entry sits on a **majority**. Any winning candidate also needs a **majority** of votes. Those two majorities **intersect** (quorum intersection again, §74.11) in at least one node — and that node **will not vote** for a candidate whose log lacks the committed entry, because that candidate's log is *not* at least as up-to-date. Therefore **no candidate missing a committed entry can win.** Every new leader already contains all committed entries — which is why a Raft leader **never fetches** entries from followers; it only pushes. This is precisely ZAB's "highest-zxid follower leads" and the structural reason Raft is simpler than Multi-Paxos recovery.

The **State Machine Safety** property follows: if any node has applied an entry at a given index to its state machine, no other node applies a *different* entry at that index — the equivalent of consensus agreement, lifted to the whole log.

---

## 74.23 Raft Failure Scenarios and Log Repair

Raft's strong-leader model makes failures crisp. Walk the canonical ones.

**Leader crash.** Followers stop hearing heartbeats, election timeouts fire, a new leader is elected for a higher term (§74.20). By leader completeness (§74.22) the new leader holds every committed entry. Uncommitted entries from the dead leader may or may not survive — that's fine; they weren't acknowledged to any client.

**Log divergence / repair.** After crashes, a follower's log can diverge from the new leader's: it may have **extra** uncommitted entries (from an old leader) or be **missing** entries. Raft repairs purely via AppendEntries' consistency check:

```
  Leader (term 4):  [1|a][1|b][2|c][4|d]
  Follower X:       [1|a][1|b][2|c]                 (missing tail)
  Follower Y:       [1|a][1|b][3|e][3|f]            (divergent, uncommitted 3|e,3|f)

  Leader keeps a nextIndex per follower. On AppendEntries rejection it
  DECREMENTS nextIndex and retries, walking back until (prevLogIndex,
  prevLogTerm) matches. Then it OVERWRITES the follower's conflicting tail
  with its own entries. Follower Y's [3|e][3|f] are discarded; it becomes
  [1|a][1|b][2|c][4|d].  Entries only flow leader → follower.
```

The leader never modifies its own log to match a follower; the follower's divergent suffix is truncated and replaced. Because those discarded entries were never committed (they weren't on a majority under a leader that could commit them), no committed data is lost. An optimization sends the conflicting term's first index in the rejection so `nextIndex` can back up a whole term at a time instead of one entry per RTT.

**Split votes.** Covered in §74.20 — resolved by randomized timeouts; a term may simply produce no leader and the next election proceeds.

**The Figure-8 hazard (why the §74.21 commitment rule exists).** A subtle scenario: a leader replicates an old-term entry to a majority but crashes before committing anything in its *own* term; a later leader could then overwrite that entry, even though it briefly sat on a majority. Raft forbids treating that as committed — a leader commits a prior-term entry **only** by committing a current-term entry above it. This is the single most commonly missed Raft detail and a favorite senior-level interview trap.

---

## 74.24 Raft Membership Changes (Joint Consensus)

Changing the cluster's membership (adding/removing nodes) is dangerous: if different nodes switch from old config `Cold` to new config `Cnew` at different times, you can momentarily have **two disjoint majorities** — one under `Cold`, one under `Cnew` — that elect **two leaders** for the same term. That splits the cluster and violates safety. Membership change must itself go through consensus.

Raft's original solution is **joint consensus** — a two-phase transition through a combined configuration `Cold,new`:

```
  Phase 1: leader commits a config entry Cold,new to the log.
           While Cold,new is active, EVERY decision (elections AND commits)
           requires a majority of BOTH Cold and Cnew separately.
           ⇒ no decision can be made by Cold alone or Cnew alone
           ⇒ impossible to form two disjoint majorities ⇒ no split brain.

  Phase 2: once Cold,new is committed, leader commits Cnew.
           From then on only a Cnew majority is needed; old-only nodes retire.
```

Because configuration changes are ordinary log entries, they inherit consensus ordering and the log-matching guarantee. A node uses the **latest configuration in its log** (even if not yet committed) to decide quorums — so it starts obeying the new rules as soon as it *sees* the change, which is what makes the overlap safe.

Later Raft implementations (etcd, and the Raft thesis's own recommendation) prefer **single-server changes**: add or remove **one** node at a time. Adding/removing a single member cannot create two disjoint majorities (the old and new majorities always overlap when they differ by one node), so it needs no joint phase and is far simpler to implement correctly. A common practical wrinkle: a freshly added node with an empty log shouldn't count toward quorum until it has caught up, or availability can drop — so systems add new members as **non-voting learners** first, then promote them. Membership change is a notorious source of real-world consensus bugs; treat "how do you safely reconfigure a Raft cluster?" as a serious question.

---

## 74.25 Raft vs Multi-Paxos

The two are functionally equivalent — both are leader-based, log-replicating, majority-quorum crash-consensus for SMR — but they differ in emphasis. The comparison is a staple.

| Dimension | Multi-Paxos | Raft |
|---|---|---|
| Design goal | Minimal, general, provable | **Understandable**, implementable |
| Log-entry flow | Bidirectional in principle; a leader may fill any slot | **Strictly leader → follower**; followers never overwrite leader |
| Leader's log | May have **holes**; leader fetches/fills missing slots | **No holes**; contiguous; leader has all committed entries by construction |
| Leader election | **Unspecified** by the core algorithm (add your own) | **Fully specified**: terms + randomized timeouts + RequestVote |
| "Term/ballot/epoch" | Ballot number (per proposer) | Term (per election), strictly increasing |
| Recovery | New leader runs Phase 1, adopts highest accepted per slot | New leader already complete (election restriction); just repairs followers |
| Commit rule subtlety | Adopt-highest-accepted handles it uniformly | Special "only commit current-term entries directly" rule (Fig. 8) |
| Reconfiguration | Various (e.g., reconfigure via a special command) | Joint consensus or single-server change |
| Where used | Chubby, Spanner, Megastore, Azure | etcd, Consul, TiKV/CockroachDB, KRaft, Yugabyte |

The essential relationship: **Raft ≈ Multi-Paxos with a stronger-leader discipline that trades a little generality for a lot of clarity.** Raft's constraints (no log holes, leader completeness by election restriction, one-directional flow) eliminate exactly the parts of Multi-Paxos that are underspecified or subtle. Neither is "more correct"; both provide linearizable SMR under crash faults with `f+1`-of-`2f+1` majority quorums. If asked "which should I use?", the honest answer is: **use a well-tested Raft library (etcd/raft, TiKV raft-rs)** — the algorithm you pick matters far less than the implementation's maturity, because consensus code is where subtle bugs hide.

---

## 74.26 Byzantine Faults and the Byzantine Generals Problem

Everything so far assumes **crash-stop** (fail-stop) faults: a node either follows the protocol or halts. It never **lies**. **Byzantine faults** drop that assumption: a faulty node may behave **arbitrarily** — send conflicting messages to different peers, forge or corrupt data, collude with other faulty nodes, or act maliciously. This models compromised machines, malicious participants, and undetected hardware corruption.

Lamport's **Byzantine Generals Problem** (1982) frames it: several army divisions surround a city; generals communicate only by messenger; some generals (and messengers) may be **traitors** sending contradictory orders. The loyal generals must agree on a single plan (attack/retreat) despite the traitors. The classic result:

> With only **oral** (unsigned, forgeable) messages, Byzantine agreement is solvable **iff** the number of nodes `N > 3f`, i.e., **N ≥ 3f + 1** to tolerate `f` traitors. With `N ≤ 3f`, no algorithm exists. With **signed** (unforgeable) messages, `f+1` nodes suffice in principle, but practical signed-message protocols still use `3f+1` for liveness and to bound message complexity.

**Why crash-consensus (Paxos/Raft) fails under Byzantine faults:** they trust every message. A Byzantine leader in Raft can tell follower A "commit X" and follower B "commit Y," and since followers accept the leader's word and majorities only need `f+1`, the cluster diverges — there is **no cross-check** that the leader is telling everyone the same thing. Crash-fault quorums (`2f+1`) provide no defense because a liar counts as a valid vote. Byzantine tolerance requires **more redundancy** and **mutual verification** (§74.27).

The quorum arithmetic changes fundamentally:

| Fault model | Nodes for `f` faults | Quorum | Why |
|---|---|---|---|
| **Crash-stop** (Paxos, Raft, ZAB) | `N = 2f + 1` | `f + 1` (majority) | Two majorities intersect in ≥1 correct node |
| **Byzantine** (PBFT) | `N = 3f + 1` | `2f + 1` | Two quorums intersect in ≥ `f+1` nodes, so ≥1 correct node is in both |

The intuition for `3f+1`: a quorum of `2f+1` may contain up to `f` liars, leaving `f+1` honest — and any two quorums of `2f+1` out of `3f+1` intersect in at least `f+1` nodes, guaranteeing at least **one honest node in common** to carry the truth forward. You need enough honest nodes to outvote the liars *and* enough overlap to prevent equivocation.

---

## 74.27 PBFT: Practical Byzantine Fault Tolerance

**PBFT** (Castro & Liskov, 1999) was the first Byzantine consensus efficient enough for real systems (polynomial, not exponential, message complexity). It provides SMR tolerating `f` Byzantine faults with `N = 3f + 1` replicas, assuming partial synchrony for liveness. Its normal-case operation is a **three-phase** commit driven by a **primary** (leader); the extra phases (vs Raft's one) exist to detect a lying primary through mutual cross-checking.

```
PBFT normal case (N = 3f+1, e.g. f=1 ⇒ 4 replicas; quorum = 2f+1 = 3):

 Client  Primary(0)    Replica1    Replica2    Replica3(faulty?)
   │ req  │             │            │            │
   │─────▶│ PRE-PREPARE │────────────┼────────────┤   primary assigns seq n
   │      │────────────▶│            │            │
   │      │  PREPARE (all-to-all) — each replica multicasts PREPARE
   │      │◀───────────▶│◀──────────▶│            │   collect 2f matching PREPAREs
   │      │             │            │            │   ⇒ "prepared": agree on order n
   │      │  COMMIT (all-to-all) — each multicasts COMMIT
   │      │◀───────────▶│◀──────────▶│            │   collect 2f+1 matching COMMITs
   │◀─────┴─────────────┴────────────┘            │   ⇒ "committed"; execute; reply
   │  client waits for f+1 matching replies from different replicas
```

- **Pre-prepare:** the primary assigns a sequence number `n` to a request and multicasts `PRE-PREPARE⟨n, request, digest⟩`. This proposes the order.
- **Prepare:** every backup, if it accepts the pre-prepare, multicasts `PREPARE` to **all** replicas. When a replica has the pre-prepare plus **2f matching PREPAREs** from distinct replicas, it is **prepared** — it now knows a quorum agrees on order `n` *within this view*. (This all-to-all round is what a lying primary cannot fake: replicas compare what the primary told each of them.)
- **Commit:** each prepared replica multicasts `COMMIT`. When it collects **2f+1 matching COMMITs**, it is **committed-local**; it executes the request and replies to the client. The commit phase guarantees the order survives **across view changes** (a new primary can't undo it).
- **Client acceptance:** the client waits for **f+1 identical replies** from different replicas — since at most `f` are faulty, `f+1` matching replies include at least one honest replica, so the result is correct.

**View changes** handle a faulty/slow primary: if replicas time out waiting for progress, they broadcast `VIEW-CHANGE` to rotate to a new primary (`view v+1`, primary = `v+1 mod N`), carrying signed proof of their prepared state so the new primary can reconstruct a consistent order without losing committed requests — the Byzantine analogue of Raft leader election, but requiring cryptographic evidence because the old primary may lie about what happened.

**Checkpointing** bounds state: replicas periodically agree on a stable checkpoint (a `2f+1`-signed snapshot of the state at some sequence number), letting them **garbage-collect** the message log below it and giving lagging/recovering replicas a trusted point to sync from. Recovery in the Byzantine setting must assume a recovered replica's state may have been corrupted, so it re-fetches and re-verifies against the signed checkpoint.

**Cost:** PBFT's all-to-all rounds make message complexity **O(N²)** per request (vs Raft's O(N)), which limits it to small clusters. Modern BFT (Tendermint/CometBFT behind Cosmos, HotStuff behind Diem/Libra and used by many chains) reduces this to **O(N)** via threshold signatures and a rotating leader with linear communication — HotStuff's key contribution.

---

## 74.28 Consensus in Practice: Databases, Config Stores, and Leader Leases

How does all this theory show up in systems you'd actually name in an interview?

**Replicated log / SMR is the universal pattern.** etcd, Consul, ZooKeeper, TiKV, CockroachDB, Spanner, and Kafka's controller all run a consensus-ordered log with a deterministic state machine on top. The state machine differs (a KV tree, a set of SQL ranges, a topic-partition metadata map); the consensus core is the same handful of algorithms in this chapter.

**Configuration/coordination stores** are the most common consensus deployment: a small, highly-available, strongly-consistent KV store used for the metadata *other* systems depend on — service discovery, feature flags, distributed locks, and **leader election for the layer above**. etcd (Raft) backs Kubernetes; ZooKeeper (ZAB) backed the Hadoop ecosystem; Consul (Raft) does service mesh. These stores are deliberately **small and low-throughput**: you put *coordination state* in them, not your bulk data, because every write costs a majority round-trip.

**Sharded consensus ("multi-raft" / multi-paxos-per-range).** A single consensus group doesn't scale — throughput is capped by one leader and a majority RTT. So distributed databases **partition** the keyspace into ranges/shards and run an **independent consensus group per shard** (CockroachDB/TiKV: one Raft group per ~key range; Spanner: one Paxos group per tablet). This scales writes horizontally while keeping each key linearizable, and it's why "we use Raft" and "we scale to petabytes" aren't contradictory.

**Leader leases and consensus reads.** Naively, even a *read* must go through consensus to be linearizable (a stale leader that was partitioned out could serve stale data). Cheaper options:

- **ReadIndex:** the leader confirms it is still leader by exchanging one heartbeat round with a quorum, then serves the read locally once its state machine has applied up to the current commit index — a read without a full log append.
- **Leader leases:** the leader holds a **time-bounded lease** (granted by a quorum) during which it is guaranteed to be the only leader, so it can serve **local reads with no round-trip at all** for the lease duration. Correctness depends on **bounded clock drift** between nodes (a lease is a real-time guarantee); this is why Spanner invests in **TrueTime** (tightly bounded clocks) to make lease-based and externally-consistent reads safe. Get the clock assumption wrong and leases can serve stale reads — a subtle, dangerous bug.
- Contrast: **ZooKeeper follower reads are local but not linearizable** (§74.7) — a deliberate different point on the trade-off.

Consensus is also how systems get **fencing tokens** for locks: the consensus store issues a monotonically increasing token with each lock grant so a paused-then-resumed lock holder is detected and rejected (Ch. 70 §70.9) — a standard defense against the "process paused past its lease" failure.

---

## 74.29 The Latency Cost and How to Amortize It

Consensus is not free, and the cost is **fundamental**: every decision requires a **round-trip to a majority quorum**. You cannot commit faster than the time to reach and hear back from the `f+1`-th fastest node. This shapes everything.

- **One majority RTT per decision (minimum).** With a stable leader (Multi-Paxos/Raft) the steady-state cost is *one* round-trip — leader → followers → leader — plus the `fsync` each node does to durably log the entry. You pay the **network latency to the median-fastest follower** plus **disk sync latency** on every commit.
- **Geo-consensus is dominated by speed of light.** If replicas span continents, a majority RTT is tens to hundreds of milliseconds (e.g., us-east ↔ eu-west ≈ 80–90 ms one way). A cross-region Raft/Paxos group commits at *best* one such RTT per batch. **Replica placement is a latency decision:** put a majority close together for low commit latency, or spread them for failure independence — you can't fully have both. Spanner accepts multi-region commit latency as the price of global external consistency.

The two amortization techniques every implementation uses:

- **Batching.** Accumulate many client commands and agree on them as **one** log entry / one Accept round. The majority RTT is now amortized over hundreds of commands, so **throughput** rises even though per-command **latency** includes a small batching delay. This is the distributed cousin of group commit (Ch. 61 §61.5): one expensive sync, many operations.
- **Pipelining.** Don't wait for entry *k* to commit before proposing *k+1*; keep multiple AppendEntries/Accepts **in flight** concurrently. This decouples throughput from the RTT entirely — throughput becomes (batch size × in-flight window) / RTT rather than 1 / RTT. Raft/Multi-Paxos pipeline aggressively; the only constraint is that the state machine still **applies in index order**, so out-of-order *commit* is fine but out-of-order *apply* is not (§74.13 log holes).

```
  Naive (serial):   |--RTT k--||--RTT k+1--||--RTT k+2--|   throughput ≈ 1/RTT
  Pipelined:        |--RTT k----|
                       |--RTT k+1--|
                          |--RTT k+2--|                      throughput ≫ 1/RTT
```

Other levers: **follower/lease reads** (§74.28) remove the RTT for reads; **flexible-Paxos small write quorums** (§74.15) reduce how many acks you wait for; **EPaxos** (§74.16) lets clients hit the nearest replica to cut geographic latency. But the floor remains: **a durable, linearizable decision costs one majority round-trip.** That floor is why consensus stores hold coordination metadata, not bulk data, and why "just put it in etcd" is bad advice for a high-write-rate workload.

---

## 74.30 PostgreSQL, Patroni, and Consensus as an External Dependency

A crucial clarification, because it's a common interview misconception: **PostgreSQL does not implement a consensus algorithm.** Core Postgres replication is **primary/replica (leader/follower) log shipping**, not Paxos or Raft:

- The primary streams its **WAL** (the physical redo log, Ch. 65) to replicas — **physical/byte-level replication**, which neatly sidesteps the determinism problem of §74.2 (replicas replay byte effects, so `now()`/`random()` reproduce exactly).
- **Asynchronous replication** (the default) acknowledges the commit locally before the replica has it — fast, but a primary crash can **lose** acknowledged transactions (a window of data loss; not linearizable across the failover).
- **Synchronous replication** (`synchronous_commit = on` with `synchronous_standby_names`) waits for the standby to confirm before acking. But vanilla Postgres sync replication is **not** quorum consensus: with one sync standby, if that standby is down the primary **blocks** (availability loss), and Postgres itself has **no built-in automatic leader election or failover** — a crashed primary stays down until something outside promotes a replica. `synchronous_standby_names` does support quorum-style `ANY k (...)` sets, but there is still no automated, split-brain-safe failover in core.

**This is exactly where an external consensus store comes in.** High-availability Postgres uses a **cluster manager** — most commonly **Patroni** — that sits *on top of* Postgres and delegates the hard consensus/leader-election problem to a **dedicated consensus store**: **etcd (Raft)**, **Consul (Raft)**, or **ZooKeeper (ZAB)**.

```
      ┌─────────── Consensus store (etcd/Consul/ZooKeeper) ───────────┐
      │  Raft/ZAB-replicated KV: holds the "leader lease" key +       │
      │  cluster state; provides linearizable CAS + TTL leader lock.  │
      └───────▲───────────────────▲───────────────────▲──────────────┘
              │ leader lease (TTL) │ watch             │
       ┌──────┴─────┐       ┌──────┴─────┐      ┌──────┴─────┐
       │  Patroni   │       │  Patroni   │      │  Patroni   │
       │  + Postgres│       │  + Postgres│      │  + Postgres│
       │  PRIMARY   │       │  replica   │      │  replica   │
       └────────────┘       └────────────┘      └────────────┘
        streams WAL ───────────────▶ replicas (physical replication)
```

Patroni's design cleanly separates concerns:

- **Consensus / leader election** is done by etcd (Raft), **not** by Postgres. Exactly one Patroni node holds a **leader key with a TTL** in etcd; it must **renew** the lease within the TTL or lose it. This is a **fencing lease** (Ch. 70 §70.9): a partitioned old primary that can't renew its etcd lease **demotes itself**, and a new primary is only promoted after acquiring the leader key via etcd's linearizable compare-and-swap — which prevents **split brain** (two primaries).
- **Data replication** is still ordinary Postgres streaming WAL. Consensus orders the *control plane* (who is primary); Postgres handles the *data plane* (the WAL stream).

The interview-grade summary: **Postgres HA layers a consensus-backed control plane (etcd/Consul/ZooKeeper via Patroni) over Postgres's own non-consensus physical replication.** The consensus algorithm you learned in this chapter runs in the *coordination store*, ensuring there is exactly one primary and no split brain; Postgres itself remains a single-writer log-shipping system. This division — "the database ships its log; a Raft store elects its leader" — is the norm for systems that weren't born distributed, and contrasts sharply with a CockroachDB or TiKV, which bake Raft into the data path itself.

---

## Summary

- **Consensus** = N processes agree on one value, satisfying **agreement**, **validity/integrity** (safety) and **termination** (liveness). Practical algorithms make **safety unconditional** and sacrifice only **liveness** under asynchrony.
- **Consensus + a log + a deterministic state machine = state-machine replication**, the foundation of every consistent distributed database; it delivers linearizability (Ch. 71 §71.2).
- **FLP** forbids deterministic consensus in pure asynchrony with one crash; algorithms escape via **partial synchrony**, **failure detectors**, or **randomization** — concretely a **leader plus randomized timeouts**. They don't beat FLP; they concede liveness exactly where FLP bites.
- **Atomic (total-order) broadcast is equivalent to consensus**; both are unsolvable in pure asynchrony. ZAB (ZooKeeper) is leader-based atomic broadcast with epochs and zxids.
- **Paxos**: proposer/acceptor/learner; two phases (Prepare/Promise, Accept/Accepted); safety from **majority quorum intersection** and the **adopt-highest-accepted** rule; dueling proposers cause **livelock** (liveness only, never a safety break).
- **Multi-Paxos** amortizes Phase 1 via a stable leader → one RTT per decision. Variants: **Fast Paxos** (fewer hops, bigger quorums), **Flexible Paxos** (`Q1+Q2>N` suffices), **EPaxos** (leaderless, dependency graphs), **Generalized Paxos** (commuting commands).
- **Raft** = Multi-Paxos with a strong-leader discipline for understandability: **terms**, randomized-timeout **leader election**, **AppendEntries** log replication, **log matching** + **election restriction** (leader completeness) for safety, **joint consensus** for membership. Backs etcd, Consul, TiKV, CockroachDB, KRaft.
- **Byzantine faults** (nodes lie) need **N = 3f+1** and quorum **2f+1**; crash-consensus fails because it trusts every message. **PBFT** = three-phase (pre-prepare/prepare/commit) + view changes + checkpoints, O(N²) messages; modern BFT (HotStuff) makes it O(N).
- **In practice**: consensus backs config stores (etcd/ZooKeeper/Consul), sharded "multi-raft" data planes, and leader **leases/ReadIndex** for cheap reads. The irreducible cost is **one majority round-trip per decision**, amortized by **batching** and **pipelining**; geo-consensus is speed-of-light bound.
- **Postgres** doesn't implement consensus; HA (**Patroni**) puts a **consensus store (etcd/Consul/ZK)** on top for leader election/fencing while Postgres ships WAL — control plane consensus, data plane log-shipping.

**Part II wrap-up.** This chapter closes Part II, and the parts compose into one arc. **Failure detection** (Ch. 68) established what we can and cannot know about a remote node and why FLP forces us to guess. **Leader election** (Ch. 70) gave us a distinguished coordinator despite those unreliable suspicions. **Replication and consistency** (Ch. 71) defined *what* guarantee we want (linearizability) and the quorum machinery to approach it, while **anti-entropy** repaired the divergence weak replication permits. **Distributed transactions and atomic commit** (Ch. 73) coordinated all-or-nothing decisions across shards — and revealed why 2PC's blocking on coordinator failure demands something stronger. **Consensus** is that something stronger: it fuses failure detection, leader election, and quorum replication into a single primitive that agrees on an ordered log despite crashes and partitions — and a log plus a state machine is a fault-tolerant database. Everything in Part II was, in the end, a component of this final algorithm.

---

## Key Interview Questions

1. **Define consensus and its correctness properties.** — N processes each propose a value and must decide on one, satisfying agreement (no two correct nodes decide differently), validity (a decided value was proposed), integrity (decide at most once, irrevocably) — all safety — plus termination (every correct node eventually decides) — liveness.
2. **What is the safety/liveness split, and which do real algorithms sacrifice?** — Safety = "nothing bad happens" (never disagree); liveness = "something good eventually happens" (eventually decide). Practical algorithms keep safety **unconditional** (holds during any asynchrony/partition) and sacrifice only **liveness** when the network misbehaves. You may stall; you must never disagree.
3. **How does consensus give you a database?** — Consensus over a growing log agrees on command order; a deterministic state machine applying those commands in order stays identical across replicas. Consensus + log + deterministic state machine = state-machine replication, which yields a linearizable, fault-tolerant service.
4. **Why must state-machine commands be deterministic?** — Replicas must reach identical state from identical command sequences; `now()`/`rand()` would diverge. Systems resolve nondeterminism before logging (the leader logs the concrete value). Postgres avoids the issue by shipping physical WAL byte-effects rather than logical commands.
5. **State the FLP result and how algorithms sidestep it.** — In an asynchronous system with even one crash-fault, no deterministic protocol guarantees both safety and termination, because you can't distinguish a crashed from a slow node. Algorithms escape via partial synchrony (eventual timing bounds), failure detectors, or randomization — concretely a leader plus randomized timeouts — conceding liveness only during asynchrony.
6. **Does Raft/Paxos "beat" FLP?** — No. They keep safety unconditionally and give up liveness precisely during the asynchronous conditions FLP exploits. Under partial synchrony they terminate; during a partition they may make no progress but never disagree. FLP is routed around, not violated.
7. **What is atomic (total-order) broadcast and how does it relate to consensus?** — Reliable broadcast where all correct processes deliver all messages in the same total order. It is provably equivalent to consensus (each reduces to the other): a sequence of consensus instances is a total order, and vice versa. It's exactly what SMR needs.
8. **Explain the reliable-broadcast hierarchy.** — Best-effort (correct sender ⇒ all deliver); reliable (any correct delivery ⇒ all correct deliver, even if sender crashes, via echo); uniform reliable (any delivery even by a crashing node ⇒ all deliver); FIFO/causal add per-sender/causal order; atomic adds one global total order (needs consensus).
9. **What is ZAB and how does it order updates?** — ZooKeeper Atomic Broadcast: leader-based total-order broadcast with epochs and 64-bit zxids (epoch<<32 | counter) that totally order transactions. Steady state is PROPOSE → majority ACK → COMMIT. On election it picks the highest-zxid follower as leader and synchronizes histories so committed data is never lost.
10. **Describe Paxos roles and the two phases.** — Proposer (drives ballots), acceptor (votes, remembers, forms quorums), learner (observes chosen value). Phase 1: Prepare(b)/Promise — claim a ballot and learn any accepted value. Phase 2: Accept(b,v)/Accepted — get v accepted by a majority. A value is chosen once a majority accepts it in one ballot.
11. **In Paxos Phase 1, what must a proposer do with returned accepted values?** — If any promising acceptor reports a previously accepted value, the proposer must propose the value with the highest accepted ballot, not its own. Only if no acceptor reports an accepted value is it free to propose its own. This adopt-highest rule is what prevents two values being chosen.
12. **Why is Paxos safe — the quorum-intersection argument.** — Any two majorities of the same set share ≥1 node. If v is chosen (a majority accepted it), any later ballot's Phase-1 majority overlaps that majority in a node that reports v, forcing the new proposer to re-propose v. By induction only v is ever chosen — agreement holds with no synchrony assumption.
13. **What are dueling proposers and what do they break?** — Two proposers keep issuing higher Prepares that invalidate each other's Accepts, so neither completes Phase 2 — a livelock. It breaks **liveness only**; no value is ever chosen incorrectly and no two values are chosen. It's FLP made concrete; the fix is a single leader plus randomized backoff.
14. **What does Multi-Paxos optimize and how?** — Phase 1 doesn't reference a value or slot, so a stable leader runs it once per ballot to claim leadership across all log slots, then runs only Phase 2 per command — one majority round-trip per decision instead of two. Phase 1 re-runs only on leader change.
15. **Multi-Paxos leaves things unspecified — what, and why does it matter?** — It assumes but doesn't specify leader election, and must handle log holes (out-of-order commits) and new-leader recovery of uncommitted slots. This vagueness is a major reason Raft was designed with fully specified election and a hole-free, one-directional log.
16. **What does Flexible Paxos reveal about quorums?** — Only Phase-1 and Phase-2 quorums must intersect (Q1 + Q2 > N); same-phase quorums needn't. Majorities are sufficient but not necessary. You can shrink the write quorum (e.g., Q2=2, Q1=4 on N=5) for cheaper commits at the cost of heavier, rarer leader elections.
17. **How does Fast Paxos reduce latency and at what cost?** — Clients send proposals directly to acceptors, skipping the leader hop (two message delays instead of three). The cost is larger "fast quorums" (~3N/4, needing N≥3f+1) and collision recovery: concurrent different values get no fast quorum and fall back to a classic coordinated round. Wins only under low contention.
18. **What is EPaxos and what problem does it solve?** — A leaderless Paxos variant: any replica commits any command; clients use the nearest replica. It exploits commutativity — only interfering commands are ordered, via per-command dependency graphs executed by topological sort. One RTT under low conflict, no leader bottleneck; complex and degrades under high conflict.
19. **What are Raft terms and how do they prevent two leaders?** — Terms are a strictly increasing logical clock; each term has at most one leader. Each node casts at most one vote per term, so two candidates can't both win a majority in the same term. Any node seeing a higher term reverts to follower, deposing stale leaders.
20. **How does Raft handle split votes?** — Randomized election timeouts: each node picks its timeout from a range (e.g., 150–300 ms), so one node usually times out first, wins before others start, and repeated splits become exponentially unlikely. A split term simply produces no leader and the next election proceeds.
21. **What is Raft's commitment rule and the Figure-8 subtlety?** — An entry is committed once replicated to a majority, and applied in index order. A leader may count only entries from its **own current term** toward commitment; a prior-term entry on a majority is committed only indirectly, by committing a current-term entry above it. Violating this lets a committed entry be overwritten — a safety bug.
22. **Explain Raft's log-matching property and election restriction.** — Log matching: same (index, term) ⇒ same command and identical prior log, enforced by AppendEntries' prevLogIndex/prevLogTerm check. Election restriction: a voter grants a vote only if the candidate's log is at least as up-to-date, so — since committed entries are on a majority that intersects any winning vote majority — no leader can lack a committed entry.
23. **How does Raft repair a divergent follower log?** — Entries flow only leader→follower. The leader keeps a nextIndex per follower; on AppendEntries rejection it decrements nextIndex until prevLogIndex/prevLogTerm matches, then overwrites the follower's conflicting suffix with its own entries. Discarded entries were never committed, so no committed data is lost.
24. **How does Raft change membership safely?** — Via joint consensus: transition through a combined Cold,new config where every election and commit needs a majority of both old and new configs, making two disjoint majorities impossible; then commit Cnew. Simpler alternative: single-server changes (add/remove one node, whose majorities always overlap), often adding new nodes as non-voting learners first.
25. **Contrast Raft and Multi-Paxos.** — Same guarantees (leader-based, majority-quorum, linearizable SMR). Raft mandates one-directional log flow, hole-free logs, leader completeness via election restriction (no fetch needed), and a fully specified randomized-timeout election; Multi-Paxos is more general but underspecifies election and permits log holes and per-slot recovery. Raft trades generality for clarity.
26. **Why do crash-consensus algorithms fail under Byzantine faults?** — They trust every message. A Byzantine leader can tell different followers different things and, since majorities count liars as valid votes with no cross-check, the cluster diverges. Byzantine tolerance needs more redundancy (3f+1) and mutual verification (all-to-all rounds), not just 2f+1.
27. **What is the 3f+1 requirement and why?** — To tolerate f Byzantine faults you need N ≥ 3f+1 nodes with quorum 2f+1 (oral messages). Any two 2f+1 quorums of 3f+1 intersect in ≥ f+1 nodes, guaranteeing at least one honest node in common, and a quorum always contains a majority of honest nodes to outvote the liars.
28. **Walk through PBFT's normal case.** — Client → primary. Pre-prepare: primary assigns sequence n and multicasts it. Prepare: backups multicast PREPARE; 2f matching ⇒ "prepared" (order agreed in-view). Commit: replicas multicast COMMIT; 2f+1 matching ⇒ committed, execute, reply. Client accepts on f+1 identical replies. View changes rotate a faulty primary with signed proof.
29. **What's the cost of PBFT and how do modern BFT protocols improve it?** — PBFT's all-to-all prepare/commit rounds are O(N²) messages, limiting cluster size. HotStuff (Diem, many chains) and Tendermint reduce this to O(N) using threshold signatures and a rotating leader with linear, pipelined communication.
30. **What is the irreducible latency cost of consensus, and how is it amortized?** — Every durable, linearizable decision needs one round-trip to a majority quorum plus a disk sync — you can't commit faster than the f+1-th fastest node responds; geo-consensus is speed-of-light bound. Batching (many commands per agreement round) and pipelining (multiple rounds in flight) amortize it for throughput, though apply order must stay sequential.
31. **How can consensus systems serve reads without a full log round-trip?** — ReadIndex (confirm still-leader via one heartbeat quorum, then read locally after applying up to commit index) or leader leases (a time-bounded quorum-granted lease lets the leader serve local reads with no round-trip, relying on bounded clock drift — hence Spanner's TrueTime). ZooKeeper offers local follower reads but they're not linearizable.
32. **Does PostgreSQL implement Paxos or Raft?** — No. Core Postgres uses primary/replica physical WAL shipping (async or sync), with no built-in consensus, leader election, or split-brain-safe automatic failover. Sync replication can block if the standby is down.
33. **How does Postgres achieve consensus-backed high availability?** — A cluster manager like Patroni delegates leader election to an external consensus store (etcd/Consul/ZooKeeper). One Patroni holds a TTL leader key in etcd (a fencing lease); a partitioned old primary that can't renew demotes itself, and promotion requires etcd's linearizable CAS — preventing split brain. Consensus runs the control plane; Postgres ships WAL for the data plane.
34. **Why put only coordination metadata in etcd/ZooKeeper, not bulk data?** — Every write costs a majority round-trip plus fsync, so a single consensus group has low throughput and is unsuitable for high write rates. Config stores hold small coordination state (locks, leader keys, membership); scalable databases shard into many independent consensus groups (multi-raft) to spread that cost.

---

## Common Traps

- **Claiming Raft/Paxos "solves" or "beats" FLP.** They keep safety unconditionally and concede liveness during asynchrony — exactly what FLP mandates; they route around it, never violate it.
- **Thinking dueling proposers or a partition can make Paxos/Raft decide two different values.** Those are liveness failures only; quorum intersection guarantees agreement is never broken regardless of asynchrony.
- **Believing a Raft leader can commit a previous-term entry just because it now sits on a majority.** The Figure-8 rule forbids it; a leader commits old entries only by committing a current-term entry above them, or a committed entry could be overwritten.
- **Assuming majority quorums are required for Paxos safety.** Flexible Paxos shows only cross-phase intersection (Q1+Q2>N) is needed; majorities are one sufficient choice, not a necessity.
- **Using a crash-fault algorithm (Paxos/Raft) where nodes may be malicious.** Crash consensus trusts every message; Byzantine faults need 3f+1 nodes and mutual verification (PBFT), not 2f+1.
- **Confusing the fault thresholds:** crash tolerance is N=2f+1 (quorum f+1); Byzantine tolerance is N=3f+1 (quorum 2f+1). Mixing these up is an instant red flag.
- **Treating ZooKeeper follower reads as linearizable.** Reads are served locally and can be stale; use sync() or route through the leader for up-to-date reads.
- **Forgetting that consensus decisions need a state machine to apply IN ORDER.** Pipelining permits out-of-order commit but never out-of-order apply; a log hole blocks application until it's filled.
- **Saying PostgreSQL "uses Raft" or "does consensus" for HA.** Core Postgres does non-consensus physical WAL shipping; consensus (etcd/Consul/ZK via Patroni) runs the control-plane leader election, not Postgres itself.
- **Assuming synchronous Postgres replication is quorum consensus with automatic failover.** It waits for standbys but can block if one is down and has no built-in split-brain-safe leader election — that's what the external consensus store provides.
- **Ignoring the one-majority-round-trip floor.** No amount of tuning commits faster than reaching the f+1-th node plus fsync; batching/pipelining raise throughput, not per-decision latency, and geo-replication is speed-of-light bound.
- **Putting high-write-rate bulk data in a single etcd/ZooKeeper cluster.** Consensus stores are for small coordination state; scaling writes requires sharding into many independent consensus groups (multi-raft).
- **Believing leader leases are free and always safe.** They rely on bounded clock drift; if clocks skew beyond assumptions, a stale leaseholder can serve stale reads — the reason Spanner engineers TrueTime.
- **Confusing "chosen," "committed," and "applied/learned."** In Paxos a value is chosen the instant a majority accepts it (possibly before anyone learns it); in Raft committed (on a majority) precedes applied (to the state machine). They are distinct moments.
