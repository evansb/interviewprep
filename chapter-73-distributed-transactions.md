# Chapter 73 — Distributed Transactions

*Interview-focused revision notes. The theme: a single-node transaction gets atomicity for free — one WAL, one `fsync`, one fate. Spread that transaction across nodes that fail independently and atomicity becomes a coordination problem with a proven cost. This chapter is the story of paying that cost: Two-Phase Commit and its fatal blocking window, why Three-Phase Commit's cure is worse than the disease under real networks, and how Spanner, Calvin, Percolator, and CockroachDB each buy their way out — by backing the coordinator with consensus, by fixing the order up front, by leaning on a clock, or by refusing to coordinate at all. PostgreSQL is the reference: its `PREPARE TRANSACTION` is textbook 2PC, and its coordinator problem is exactly the one the theory predicts.*

---

## 73.1 The Problem: Atomicity Across Independent Failures

A transaction is **atomic** when it is all-or-nothing: every write lands or none does, and no observer ever sees a partial result. On a single node this is a solved problem (Ch. 65 §65.4). The storage engine appends a **commit record** to one write-ahead log and `fsync`s it; that single durable byte is the *commit point*. Before it, recovery rolls the transaction back; after it, recovery rolls it forward. Atomicity reduces to the atomicity of one log write on one device.

Now partition the data across nodes — because it no longer fits on one machine, or because you shard for throughput (§73.19). A transaction that debits an account on **node A** and credits an account on **node B** must still be all-or-nothing. But there is no longer a single log, a single `fsync`, or a single fate. Each node has its own WAL, decides its own durability, and — the crux — **fails independently**. Node A can commit and acknowledge while node B's power supply dies a microsecond before its own commit record reaches the platter. The money vanishes. The network between them can drop, reorder, duplicate, or arbitrarily delay messages (Ch. 68 §68.2); a node can be merely *slow* in a way indistinguishable from *dead*.

The goal is a protocol that makes N independent nodes reach **the same** all-or-nothing decision about one transaction, and reach it *durably*, despite any subset of them (and the links between them) failing at the worst possible instant. That protocol is an **atomic commitment protocol**, and the canonical one is Two-Phase Commit. Everything in this chapter is either that protocol, an attempt to remove its worst weakness, or an attempt to avoid needing it.

```
Single node (Ch. 65)                Distributed (this chapter)
┌───────────────┐                   ┌────────┐        ┌────────┐
│  txn: A -= 10 │                   │ node A │        │ node B │
│       B += 10 │                   │ A -= 10│  ????  │ B += 10│
│  one WAL      │                   │ own WAL│◀──────▶│ own WAL│
│  one fsync ✓  │                   │ own    │ network│ own    │
│  atomic       │                   │ fate   │        │ fate   │
└───────────────┘                   └────────┘        └────────┘
 commit = 1 byte                    commit = agreement among N logs
```

The interview framing: **single-node atomicity is a durability problem; distributed atomicity is an agreement problem.** The moment two logs must commit together, you have left the storage engine and entered distributed consensus's poorer, older cousin.

---

## 73.2 Atomic Commitment Is Not Consensus (But Is Related)

A frequent conflation — and a discriminating interview question — is whether atomic commitment *is* consensus (Ch. 74). They are cousins, not twins.

**Consensus** (Paxos, Raft) lets a group of nodes agree on *one value* proposed by *some* participant, and it is designed to make progress as long as a **majority** is alive. Any proposed value may win; the safety property is only that everyone agrees on *the same* value and that value was proposed by someone.

**Atomic commitment** is more constrained in its outcome but weaker in its liveness:

- **The decision is not free.** The outcome must be **commit** only if *every* participant voted to commit, and **abort** if *any* participant voted to abort (or is presumed to have). Consensus lets a majority impose a value; atomic commitment gives every single participant a **veto**. One "no" — one constraint violation, one deadlock victim, one dead cohort — forces global abort.
- **The liveness is worse.** Consensus tolerates a minority failing and still terminates. The classic atomic-commitment protocol (2PC) **blocks** if the coordinator fails at the wrong moment — it does *not* tolerate that single failure. This is not an implementation defect; a foundational result (Skeen and Stonebraker) shows **no atomic commitment protocol can be non-blocking in an asynchronous system with even one crash failure**, the atomic-commitment analogue of the FLP impossibility result (Ch. 74).

The relationship: you can *build* a non-blocking atomic commitment protocol by running the commit/abort decision *through a consensus group* rather than trusting one coordinator (§73.14). That is exactly what Spanner and CockroachDB do — consensus supplies the fault-tolerant agreement, and the commit/veto semantics are layered on top. So the honest one-liner is: **atomic commitment needs agreement, and consensus is the fault-tolerant way to get agreement, but atomic commitment adds a unanimity requirement and a veto that plain consensus does not have.**

| | Consensus (Ch. 74) | Atomic commitment (2PC) |
|---|---|---|
| Decision rule | any proposed value; majority wins | commit iff **all** vote yes; any veto ⇒ abort |
| Who can force outcome | a majority | every participant can force *abort* |
| Failure tolerance | terminates if majority alive | classic 2PC **blocks** on coordinator loss |
| Impossibility bound | FLP (no deterministic async consensus) | Skeen (no non-blocking async atomic commit) |

---

## 73.3 Making Operations Appear Atomic: The Problem Statement

State the problem precisely, because the vocabulary recurs. A set of **participants** (also *cohorts*, *resource managers*, *RMs*) each hold part of a transaction's state. A **coordinator** (also *transaction manager*, *TM*) drives the protocol. Every participant reaches, and durably records, one of two **decisions** for the transaction: **COMMIT** or **ABORT**. A correct atomic commitment protocol guarantees:

1. **Agreement (uniform).** No two participants decide differently. If any participant commits, none aborts. *Uniform* means this holds even for a participant that decides and then crashes — its decision, once made durable, constrains everyone.
2. **Validity / integrity.** Commit is the outcome **only if all** participants voted yes. A single node cannot be forced to commit work it rejected (integrity constraint violated, serialization failure, out of disk).
3. **Stability / non-triviality.** If there are no failures and all vote yes, the decision is commit (the protocol cannot trivially always-abort).
4. **Termination (liveness).** Every non-failed participant eventually decides. This is the property 2PC sacrifices; it is only guaranteed under extra assumptions (a live coordinator, or a consensus backing).

The subtle word is **uniform** agreement. It is not enough that live nodes agree; a node that commits, acknowledges a client, and *then* crashes has exposed the committed state to the outside world. When it recovers it must decide *commit* — anything else violates uniformity and, worse, durability. This is why every participant writes its vote and the final decision to *its own* WAL (Ch. 65 §65.3) **before** acting on them: the protocol's correctness rests on the same recoverable-log machinery as single-node transactions, now run N times and cross-checked.

---

## 73.4 Two-Phase Commit: The Protocol

**Two-Phase Commit (2PC)** is *the* atomic commitment protocol — the one every relational database, XA transaction manager, and message broker implements. As the name says, it has two round trips, a **voting (prepare) phase** and a **decision (commit) phase**, driven by a single coordinator.

**Roles.** One **coordinator** (often the node where the transaction originated, or a dedicated transaction manager). Several **cohorts** (the participants holding data touched by the transaction).

**Phase 1 — Prepare / Voting.**
1. The coordinator sends `PREPARE` (a.k.a. `CanCommit?`) to every cohort.
2. Each cohort does everything needed to guarantee it *can* commit if told to: it validates constraints, acquires and **holds all locks** (Ch. 65 §65.7), writes its changes and a **`prepared`** record to its WAL, and `fsync`s. It has now surrendered its autonomy: it may no longer unilaterally abort. It replies **`YES`** (vote-commit) or, if anything failed, **`NO`** (vote-abort). A cohort that has voted YES is **in-doubt** / **prepared**: it must await the coordinator's verdict and cannot release its locks.

**Phase 2 — Commit / Decision.**
3. The coordinator collects votes. If **all** are `YES`, it writes a **`commit`** record to *its own* WAL and `fsync`s — this durable write is the **global commit point** — then sends `COMMIT` to all cohorts. If **any** vote is `NO` (or a timeout expires waiting for one), it writes `abort` and sends `ABORT`.
4. Each cohort, on receiving the decision, writes a `commit`/`abort` record to its WAL, releases its locks, and replies `ACK`. The coordinator, once all `ACK`s arrive, writes an `end` record and forgets the transaction.

The two phases map to two questions: *"can everyone commit?"* (phase 1 collects a unanimous promise) and *"then do it"* (phase 2 broadcasts the now-inevitable outcome). The genius and the flaw are the same: after phase 1, the outcome is **fixed but not yet everywhere-known**, and any cohort that voted YES is stuck holding locks until it learns the verdict. That gap is where all of 2PC's pain lives (§73.8).

---

## 73.5 2PC: The Happy Path

The complete no-failure timeline, with the WAL writes that make it recoverable:

```
Coordinator (C)                Cohort A                 Cohort B
      │                           │                        │
      │──── PREPARE ─────────────▶│                        │
      │──── PREPARE ──────────────┼───────────────────────▶│
      │                    validate, lock,          validate, lock,
      │                    WAL: prepared, fsync      WAL: prepared, fsync
      │◀──── YES ─────────────────│                        │   ◀── in-doubt:
      │◀──── YES ─────────────────┼────────────────────────│       locks HELD
      │                           │                        │
 all YES →                        │                        │
 WAL: COMMIT, fsync ◀── GLOBAL COMMIT POINT (the transaction is now committed)
      │                           │                        │
      │──── COMMIT ──────────────▶│                        │
      │──── COMMIT ───────────────┼───────────────────────▶│
      │                   WAL: commit, fsync        WAL: commit, fsync
      │                   release locks             release locks
      │◀──── ACK ─────────────────│                        │
      │◀──── ACK ─────────────────┼────────────────────────│
      │                           │                        │
 WAL: end (forget txn)            │                        │
```

Cost accounting, which interviewers probe: **two network round trips** and, on the critical path, **2·(N+1) forced log flushes** — each cohort `fsync`s twice (prepared, then commit) and the coordinator `fsync`s once (commit); plus the final `end`. Latency is bounded below by *two* WAN round trips plus the slowest cohort's two `fsync`s. This is why 2PC is a throughput and tail-latency killer over a wide area, and why systems either avoid distributed transactions, batch them, or push the whole protocol onto low-latency intra-datacenter links.

The other structural cost: **locks are held from phase-1 prepare until the phase-2 decision arrives**. That window spans a full round trip minimum, and *unbounded* if the coordinator stalls (§73.8). Every row a distributed transaction touches is unavailable to conflicting transactions for that entire window — a contention amplifier that single-node transactions never suffer.

The two roles as state machines makes the in-doubt window explicit — it is the shaded state a cohort cannot leave on its own:

```
   COHORT                              COORDINATOR
   ┌──────────┐                        ┌──────────┐
   │  ACTIVE  │  recv PREPARE          │  ACTIVE  │  send PREPARE to all
   └────┬─────┘  ─ vote NO ─▶ ABORTED  └────┬─────┘
        │ vote YES (log prepared)           │ collect votes
        ▼                                    ▼
   ┌══════════┐  ◀── cannot decide      ┌──────────┐  any NO / timeout
   ║ PREPARED ║      alone; locks HELD  │ WAIT     │ ───────────▶ ABORT
   ║ (IN-DOUBT)║     until decision      │ (votes)  │  all YES
   └════╤═════┘                         └────┬─────┘ (log COMMIT = commit pt)
    ┌───┴────┐  recv decision                │
    ▼        ▼                                ▼
 COMMITTED  ABORTED  (log, release locks)  COMMITTED/ABORTED ─▶ (collect ACKs) END
```

The **PREPARED / IN-DOUBT** state is the whole story of this chapter: a cohort that enters it has surrendered the right to decide and can only wait. Every mechanism from §73.8 onward is about shrinking, escaping, or replicating away the risk of getting stuck there.

---

## 73.6 The Log Records and Recovery

2PC is correct only because both roles persist their state to a recoverable log (Ch. 65 §65.3) at exactly the right moments. The rule: **write the log record, `fsync`, *then* send the message that depends on it.** The forced records:

| Written by | Record | Written when | If lost, what breaks |
|---|---|---|---|
| Cohort | `prepared` (+ the changes) | before replying `YES` | cohort could forget it promised, then unilaterally abort a committed txn |
| Coordinator | `commit` / `abort` | before sending the decision | the global decision could be forgotten — no source of truth on recovery |
| Cohort | `commit` / `abort` | before releasing locks / ACK | cohort could re-acquire wrong state on recovery |
| Coordinator | `end` | after all ACKs | (optimization only) lets coordinator garbage-collect |

**Recovery of a cohort.** On restart it scans its WAL. For a transaction with a `prepared` record but no decision record, it is **in-doubt**: it may not abort (it promised YES) and may not commit (it never heard the verdict). It must **re-establish contact with the coordinator** and ask "what was the outcome?" This is the *recovery* or *termination* protocol, and its existence is the whole problem — an in-doubt cohort holds its locks until it gets an answer.

**Recovery of the coordinator.** On restart it scans its WAL. If it finds a `commit`/`abort` but not `end`, it re-sends the decision to cohorts until all ACK (cohorts must treat re-delivered decisions **idempotently**). If it finds only per-transaction state with no decision, it may safely **abort** (no cohort could have committed, because the coordinator never flushed `commit`).

The commit point is unambiguous and singular: the coordinator's `commit` `fsync`. Before that instant the transaction is abortable; after it, it is committed and every cohort *will* eventually commit, no matter how many times anyone crashes and recovers. The protocol never loses a decision — it can only **fail to deliver** one in bounded time.

---

## 73.7 Failure Analysis: Cohort Failures

Walk the failures methodically; interviewers love "what if node X dies *here*." A cohort can fail in three windows.

**(a) Cohort crashes before receiving PREPARE, or before voting.** The coordinator times out waiting for that cohort's vote. Missing vote is treated as **NO** → the coordinator **aborts** the whole transaction and tells the cohorts that *did* vote to abort. Safe: nothing committed. The crashed cohort, on recovery, finds no `prepared` record and treats the transaction as never-happened. This is the benign case — **timeout in phase 1 is safe because the default is abort.**

**(b) Cohort crashes after writing `prepared` and voting YES, before receiving the decision.** The transaction's fate is decided by the *other* votes and the coordinator, independent of this cohort. On recovery the cohort finds `prepared` with no decision → it is **in-doubt** and runs the recovery protocol: it asks the coordinator (or, in a cooperative variant, its peers) for the outcome and applies it. Its locks are held across the crash-and-recovery — the data it prepared stays inaccessible until it reconnects. Safe but potentially slow.

**(c) Cohort crashes after receiving and logging the decision.** It already recorded `commit`/`abort` durably; on recovery it simply completes locally (releases locks, re-applies if needed) and re-ACKs. Safe.

The pattern: **cohort failures are survivable** because either the default-abort covers them (phase 1) or the coordinator remains the authoritative oracle they can query on recovery (phase 2). The coordinator is the single source of truth — which is precisely why *its* failure (§73.8) is the one that has no clean answer.

---

## 73.8 Coordinator Failure and the Blocking Problem

Here is 2PC's original sin. Consider the coordinator crashing at the worst instant: **after at least one cohort has voted YES (and is thus in-doubt), but before the coordinator has flushed and distributed the decision.**

```
C: send PREPARE ─▶ A votes YES (prepared, locks held, in-doubt)
                   B votes YES (prepared, locks held, in-doubt)
C: ✗✗✗ CRASHES before writing/sending the COMMIT decision ✗✗✗
                   │
      A and B are prepared. They may NOT abort (they promised YES).
      They may NOT commit (they never heard a decision, and the
      coordinator may have decided ABORT because of some other cohort).
      They can only WAIT — holding all their locks — until C recovers.
                   │
      ▶ BLOCKED. Indefinitely. Locks held. Rows unavailable.
```

The in-doubt cohorts are **stuck**. They cannot decide unilaterally:

- They cannot **commit**: perhaps some cohort they can't see voted NO and the coordinator (had it lived) would have aborted. Committing might violate agreement.
- They cannot **abort**: they already promised YES; perhaps every cohort voted YES and the coordinator flushed `commit` and told one now-crashed cohort, which committed and told a client. Aborting would violate agreement (uniformity — §73.3).

So they **block**: they hold their locks and wait for the coordinator to come back and tell them the answer. Meanwhile every transaction that conflicts on those locked rows also stalls. **This is the fundamental blocking problem of 2PC**, and it is not fixable within 2PC's structure: with a single coordinator, its failure at this point has genuinely erased the only knowledge of the decision-in-progress, and the safe response is to wait.

**Can the cohorts ask each other?** In the **cooperative termination protocol**, an in-doubt cohort asks its peers. This *sometimes* unblocks: if any peer already received the decision, it relays it; if any peer had *not yet voted* (or voted NO), everyone can safely abort. But if *all* reachable cohorts are in-doubt (all voted YES, none heard back), they are collectively stuck — none can tell whether the coordinator got to flush `commit` before dying. Peer cooperation narrows the window but does **not** eliminate blocking. Only the coordinator's recovery (or a consensus-backed coordinator, §73.14) resolves the all-in-doubt case.

The interview soundbite: **2PC blocks because the coordinator is a single point of failure for the *decision*, and an in-doubt cohort holding locks cannot safely guess.** The Skeen result (§73.2) says this is unavoidable for *any* commit protocol under one coordinator and asynchrony — which motivates 3PC (§73.12) and, more usefully, consensus-backed 2PC (§73.14).

---

## 73.9 Presumed-Abort and Presumed-Commit

Real implementations (XA, and Postgres's prepared transactions) reduce 2PC's logging and messaging cost with **presumption** optimizations. The idea: pick a **default outcome** so that the *absence* of information can be interpreted, letting the coordinator forget completed transactions and skip some forced writes.

**Presumed Abort (the common default, and Postgres's behavior).** If a cohort asks the coordinator about a transaction the coordinator has **no record of**, the coordinator answers **ABORT**. Consequences:

- The coordinator need **not** force-log anything about an *aborting* transaction, and need not collect ACKs for aborts — it just discards. If it crashes and forgets, an in-doubt cohort's query hits "no record" ⇒ presumed abort ⇒ correct.
- It still must force-log `commit` and collect commit ACKs (a cohort that committed and then queries must get `commit`, not a wrong presumed-abort).
- Net saving: aborts are cheap; the common read-only or single-participant cases shortcut.

**Presumed Commit.** The mirror: absence ⇒ COMMIT. Now the coordinator must force-log *before* the voting phase (so it never "forgets" a transaction that might have committed and answer a wrong presumed-abort), making commits cheaper but aborts costlier and adding a pre-vote log write. Presumed commit wins only when commits vastly dominate; presumed abort is the usual choice and the one the SQL/XA ecosystem standardized on.

A related shortcut: **read-only optimization.** A cohort that did no writes replies `READ-ONLY` (not `YES`) to PREPARE; it holds no commit-time locks and drops out — the coordinator need not send it a phase-2 message at all. And the **single-participant** (or last-participant) case collapses to a one-phase commit, since with one cohort the coordinator can delegate the decision entirely.

**XA and heuristic decisions.** The **X/Open XA** standard is the industry interface for 2PC — it defines the `xa_prepare` / `xa_commit` / `xa_rollback` calls a **transaction manager** (JTA/JTS, Tuxedo, Postgres's own prepared transactions) uses to drive **resource managers** (databases, message queues). XA also formalizes the escape hatch for 2PC's blocking problem: a **heuristic decision**. When an in-doubt resource manager has blocked too long (an operator or a timeout gives up waiting for the coordinator), it may **unilaterally** commit or roll back its part — `XA_HEURCOM` / `XA_HEURRB` — to release its locks. This trades the blocking for a *possible atomicity violation*: the RM guessed, and if the coordinator's real decision differs, the transaction is now **heuristically mixed** (`XA_HEURMIX`) — some resources committed, others rolled back. XA requires the RM to *remember* the heuristic outcome and report it so a human can reconcile the damage. Heuristic decisions are the practical admission that §73.8's blocking is unfixable within 2PC: given long enough, operators break the deadlock manually and *accept* the risk of inconsistency. This is exactly what a Postgres operator does when they `ROLLBACK PREPARED` an orphaned transaction whose coordinator never returned.

---

## 73.10 Why 2PC Is Not Partition-Tolerant

Frame 2PC against CAP (Ch. 71 §71.x). During a network **partition** that isolates the coordinator from in-doubt cohorts, those cohorts must **block** (§73.8) — they hold locks and refuse service on the affected rows until the partition heals. 2PC therefore chooses **C over A**: it preserves consistency (never a split decision) at the cost of availability (blocked, locked rows) under partition. It is emphatically **not partition-tolerant** in the sense of continuing to serve.

Worse than mere unavailability: the blocking is **unbounded** and it **holds locks**, so a partition doesn't just stall the distributed transaction — it stalls *every* transaction that conflicts with the in-doubt rows, and it stalls them for as long as the partition (or the coordinator outage) lasts. A single stuck 2PC transaction can cascade into a widening pool of blocked work. This is the operational nightmare DBAs know: a coordinator crash leaves `prepared` transactions holding locks, and until an operator manually resolves them (`COMMIT PREPARED`/`ROLLBACK PREPARED` in Postgres — §73.11), throughput on those keys is zero.

The deeper point tying back to §73.2: 2PC is not partition-tolerant because its coordinator is a **single, un-replicated decision-maker**. The fix is not a cleverer message pattern (3PC tries that and fails — §73.13); it is to **replicate the coordinator's decision through consensus** so the decision survives the loss of any minority, including the original coordinator (§73.14). Partition tolerance for atomic commitment *is* consensus.

---

## 73.11 PostgreSQL 2PC: PREPARE TRANSACTION and COMMIT PREPARED

PostgreSQL implements textbook 2PC at the SQL level, and it is the cleanest concrete reference for the mechanics above. Postgres is a **cohort/resource manager**; it deliberately provides **no coordinator** — that is the application's or an external transaction manager's job.

```sql
BEGIN;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;
PREPARE TRANSACTION 'txn-42';   -- phase 1: writes state to pg_twophase/,
                                 -- fsyncs, HOLDS LOCKS, session detaches.
-- ... coordinator collects this and other cohorts' votes ...
COMMIT PREPARED 'txn-42';        -- phase 2: commit  (or)
ROLLBACK PREPARED 'txn-42';      -- phase 2: abort
```

Key facts the mechanics illuminate:

- **`PREPARE TRANSACTION 'gid'`** is exactly the phase-1 `prepare`: Postgres persists the transaction's state to disk under `pg_twophase/` with a global identifier (`gid`), `fsync`s, and — critically — the transaction becomes **dissociated from the session**. It survives client disconnect *and server restart*, still **holding all its locks**. It is now an in-doubt/prepared transaction in the §73.4 sense.
- **`COMMIT PREPARED 'gid'` / `ROLLBACK PREPARED 'gid'`** are phase 2, issued by whoever plays coordinator, possibly from a different session or after a crash.
- **`max_prepared_transactions`** must be set > 0 (default **0**, i.e. 2PC is *off* by default) — it sizes the shared-memory slot array for prepared transactions and, like `max_connections`, is a hard cap.
- **The coordinator problem is Postgres's problem too.** Postgres will faithfully hold a prepared transaction's locks *forever* if no one issues the phase-2 command. A crashed or buggy external coordinator leaves **orphaned prepared transactions** that pin locks, bloat by holding back VACUUM (their `xmin` stays live, blocking cleanup and risking XID-wraparound — Ch. 65), and require manual cleanup by querying `pg_prepared_xacts` and issuing `ROLLBACK PREPARED`. This is §73.8's blocking problem made painfully operational, which is why the Postgres docs warn that 2PC needs a *reliable* transaction manager and why casual use is discouraged.

The lesson interviewers want: **Postgres gives you the cohort half of 2PC perfectly and none of the coordinator half.** A robust distributed Postgres deployment must supply a fault-tolerant coordinator — which is exactly what Citus and FDW-based schemes bolt on (§73.24), and what the theory says must ultimately be consensus-backed to avoid blocking.

---

## 73.12 Three-Phase Commit (3PC)

**Three-Phase Commit** is the classic attempt to make atomic commitment **non-blocking**. Its diagnosis of 2PC is precise: cohorts block because, when the coordinator vanishes, an in-doubt cohort cannot tell whether the coordinator had *decided* commit before dying. 3PC's cure: insert a third phase — **pre-commit** — that acts as a buffer between "everyone voted yes" and "commit," so that the decision becomes *inferable* from the state cohorts are in.

**Phase 1 — CanCommit? (voting).** As 2PC: coordinator asks, cohorts vote YES/NO. No locks-forever commitment yet.

**Phase 2 — PreCommit.** If all voted YES, the coordinator sends `PRE-COMMIT`. Cohorts acknowledge and enter a **prepared-to-commit** state. The meaning of this new state is the whole point: *"everyone has agreed to commit; commit is now inevitable; I am just waiting for the go signal."* If a cohort receives `PRE-COMMIT`, it **knows** every cohort voted YES.

**Phase 3 — DoCommit.** Coordinator sends `DO-COMMIT`; cohorts commit and release locks.

```
        Phase 1            Phase 2              Phase 3
   CanCommit?/vote     PreCommit/ack        DoCommit/ack
   ┌───────────┐      ┌────────────┐       ┌───────────┐
C  │ collect   │─────▶│ all voted  │──────▶│  commit   │
   │ YES/NO    │      │ yes → PRE  │       │  everyone │
   └───────────┘      └────────────┘       └───────────┘
Cohort states: uncertain → prepared-to-commit → committed
                          (this middle state is what breaks the tie)
```

**Why the extra phase unblocks (under its assumptions).** If the coordinator dies, a recovering set of cohorts runs an election and a **termination protocol** that reasons from their states:

- If **any** cohort reached `prepared-to-commit`, then *all* cohorts voted YES (that's what pre-commit certifies), so the surviving cohorts can safely **commit** — no cohort could have aborted.
- If **no** cohort reached `prepared-to-commit`, then the coordinator had not yet decided to commit, so the survivors can safely **abort**.

The middle state removes the ambiguity that made 2PC block: the *presence or absence of pre-commit among survivors* determines the outcome without needing the coordinator. Under a **synchronous, fail-stop** model (bounded message and processing delays, crashed nodes are reliably detected and stay down), 3PC is provably **non-blocking**: any surviving quorum can terminate.

---

## 73.13 Why 3PC Fails Under Real Asynchrony

3PC is a beautiful proof and a bad protocol, and knowing *why* separates a textbook answer from an operational one.

3PC's non-blocking guarantee rests on two assumptions that **real networks violate**:

1. **Bounded delays / accurate failure detection (synchronous model).** 3PC's termination protocol must reliably tell "crashed" from "slow." Real networks are **asynchronous**: a node that is merely partitioned or GC-paused is indistinguishable from a dead one (Ch. 68 §68.3). When 3PC's failure detector is wrong, its reasoning breaks.

2. **No network partitions (fail-stop, not partition).** This is the killer. Consider a partition that splits the cohorts into two groups during phase 2, right as the coordinator is also lost:

```
   Partition splits cohorts while coordinator is down:
   ┌─────────────── group X ───────────────┐   ┌──── group Y ────┐
   │ cohorts that DID receive PRE-COMMIT    │ ✗ │ cohorts that did │
   │ → their termination rule: COMMIT       │ ✗ │ NOT get PRE-     │
   │                                        │ ✗ │ COMMIT → their   │
   │                                        │   │ rule: ABORT      │
   └────────────────────────────────────────┘   └──────────────────┘
        group X commits            group Y aborts   ⇒ SPLIT BRAIN
```

Group X (saw pre-commit) applies "some cohort is prepared-to-commit ⇒ commit." Group Y (didn't) applies "no one is prepared-to-commit ⇒ abort." Each group, reasoning correctly under 3PC's rules but seeing only *its side* of the partition, terminates **differently**. The result is a violation of **agreement** — some nodes commit, others abort the same transaction. 3PC traded *blocking* (a liveness failure — you get stuck but stay correct) for a potential *safety* failure (you make progress but disagree) under partition. That is a strictly worse bargain for a database.

So the verdict, which is the whole reason 3PC is a footnote in practice: **3PC is non-blocking only in a synchronous, partition-free model that real datacenters do not provide; under genuine asynchrony and partitions it can violate atomicity, and it adds a third round trip (more latency, more `fsync`s) for the privilege.** No mainstream production database uses 3PC. The industry route to non-blocking commit went through consensus instead.

---

## 73.14 Paxos Commit: Consensus-Backed 2PC

The productive fix for 2PC's blocking is not a third phase — it is to stop trusting a **single** coordinator. **Paxos Commit** (Gray & Lamport) and its practical descendants replace the fragile single-point decision with a **fault-tolerant, replicated** one, using consensus (Ch. 74) as the substrate.

The key reframing: 2PC blocks because *one* node (the coordinator) holds the *one* copy of the in-progress decision, and losing it strands everyone. Two independent moves fix this:

1. **Replicate each cohort's vote via consensus.** Instead of a cohort sending its YES/NO to one coordinator, the vote is recorded in a **consensus instance** (a Paxos/Raft group). One instance per cohort captures that cohort's vote durably across a *majority* of acceptors, so no single failure loses it.
2. **Replicate the coordinator itself.** The commit decision — "did all cohorts vote yes?" — is itself decided by a consensus group rather than one process. The decision now survives the failure of any minority, including the original leader; a new leader is elected and reads the committed votes.

```
        2PC (single coordinator)          Paxos Commit (consensus-backed)
        ┌───────────┐                     ┌───────────────────────────┐
        │coordinator│ ← dies ⇒ block      │ decision decided by a     │
        └─────┬─────┘                     │ Paxos/Raft group (majority)│
        ┌──┴──┬──┴──┐                     │ survives any minority loss │
      cohortA  cohortB                    └────────────┬──────────────┘
                                          each cohort's vote also
                                          in its own consensus instance
```

The result is an atomic commitment protocol that **does not block on the loss of any single node** (or any minority), because both the votes and the decision are majority-replicated: a recovering or newly-elected coordinator can always reconstruct the outcome from the consensus logs. It restores *termination* (liveness) without sacrificing *agreement* (safety) — the exact bargain 3PC failed to strike — because consensus, not a synchronous-model assumption, provides the fault tolerance. The cost is more messages and the latency of consensus rounds, but it is the price of a genuinely partition-tolerant commit.

**This is what real systems do.** Spanner (§73.17), CockroachDB, and YugabyteDB (§73.22) all run **2PC where each participant is not a single node but a Paxos/Raft replication group**, and the transaction coordinator's state is likewise replicated. The single-coordinator 2PC of §73.4 is the *shape* of what they run; consensus underneath each role is what makes it non-blocking. When an interviewer asks "how do modern distributed SQL databases avoid 2PC's blocking problem," this — **2PC layered over per-shard consensus groups** — is the answer.

---

## 73.15 2PC vs 3PC vs Paxos Commit

The consolidated comparison to memorize:

| Property | 2PC | 3PC | Paxos Commit (consensus-backed 2PC) |
|---|---|---|---|
| Round trips (phases) | 2 | 3 | 2 (each over a consensus round) |
| Blocking on coordinator failure | **Yes** — in-doubt cohorts stuck holding locks | No, *if* synchronous & no partition | **No** — decision is majority-replicated |
| Safe under network partition | Yes (blocks, stays correct) | **No** — can split-brain / violate atomicity | Yes (minority blocks, majority proceeds) |
| Failure model required | works, but blocks | synchronous, fail-stop, no partition | asynchronous with a majority alive |
| Extra `fsync`s / latency | baseline | +1 round, more logging | +consensus overhead per decision |
| Used in practice | ubiquitous (XA, Postgres 2PC) | essentially **never** | Spanner, CockroachDB, YugabyteDB |
| Coordinator | single point of failure | single, with peer recovery | replicated (Paxos/Raft) |

The narrative arc: 2PC is correct but blocks; 3PC tries to un-block by adding a phase and *breaks safety* under partition, so nobody uses it; consensus-backed 2PC un-blocks *without* breaking safety by replacing the single coordinator with a majority, at the cost of consensus latency — and that is the design the industry converged on. **The right way to make 2PC non-blocking is more replication, not more phases.**

---

## 73.16 Deterministic Transactions with Calvin

**Calvin** (and its commercial embodiment **FaunaDB**) takes a radically different route: **eliminate the need to agree on the *outcome* by agreeing on the *order* up front.** If every node executes the same transactions in the same order deterministically, they cannot diverge — so there is nothing to 2PC-vote about.

The architecture has three layers:

1. **Sequencing layer.** All incoming transactions are fed through a **global sequencer** that establishes a single, total order — an epoch-batched log of transactions, replicated via consensus (Paxos/Raft). This is the *only* place agreement happens: agree on the order, once, in batches, for many transactions at once (amortizing consensus cost).
2. **Scheduling layer.** Given the agreed order, each node's scheduler acquires locks in that deterministic order and executes.
3. **Execution / storage layer.** Deterministic execution: because every replica processes the *same* ordered log with the *same* deterministic logic, they all reach the *same* state — no commit-time agreement, no coordinator, **no 2PC**.

```
       ┌──────── Sequencer (agree total order via Paxos) ────────┐
   T1,T2,T3,... ─▶ [ epoch batch: T1 T2 T3 ] ─▶ replicated log
       └────────────────────────────────────────────────────────┘
                              │  (same log to every replica)
        ┌───────────┬─────────┴──────────┬───────────┐
      replica 1   replica 2            replica 3   ...
      execute the SAME order deterministically ⇒ SAME state
      (no per-transaction commit vote — order already decided)
```

**Why this removes 2PC.** In 2PC the uncertainty is *outcome* (commit or abort, unknown until votes are in). Calvin front-loads *ordering* so outcome becomes a deterministic function of order and input — every replica computes it independently and identically. Failures don't cause blocking: a crashed replica just replays the ordered log to catch up; there is no in-doubt state because there is no separate voting round to be caught between.

**The price — the key trade-off.** Determinism requires the system to know each transaction's **read/write set in advance** (which keys it will touch) so it can order and schedule lock acquisition before executing. Transactions whose access set depends on data read *during* execution (e.g. "update the row whose id we compute from another row") need a **reconnaissance / OLLP** (optimistic lock-location prediction) pre-run to discover the set, then re-validate. Interactive, open-ended transactions that hold a connection and decide next steps based on prior reads fit poorly. Calvin trades **flexibility** (arbitrary interactive transactions) for **coordination-freedom** (no 2PC, cheap replication, no distributed deadlock — locks are granted in a global order so cycles cannot form).

The interview contrast: **Spanner agrees on outcome per-transaction (2PC over Paxos); Calvin agrees on order once and derives outcome deterministically.** One pays commit-time coordination; the other pays an up-front known-access-set constraint.

---

## 73.17 Spanner: TrueTime and Commit-Wait

**Google Spanner** is the canonical globally-distributed SQL database, and its defining trick is turning **time itself** into a coordination primitive so it can offer **external consistency** (linearizability, Ch. 71 §71.x) across the planet.

**The problem Spanner solves.** With MVCC (Ch. 65 §65.9), a transaction commits at a **timestamp**, and reads see the snapshot as of a timestamp. For **external consistency**, if transaction T1 commits before T2 *starts* (in real, wall-clock time), then T1's commit timestamp must be **less than** T2's. But wall clocks on different machines disagree by unknown amounts (clock skew), so you cannot just read the local clock and trust it — you might assign T2 a timestamp *earlier* than T1 despite T2 happening later, and readers would see them out of order.

**TrueTime.** Spanner's clock API, `TrueTime`, does not return a single instant; it returns an **interval** `[earliest, latest]` guaranteed to contain the true absolute time, with a bounded uncertainty **ε** (epsilon):

```
   TT.now() = [ t_earliest , t_latest ],   with t_latest − t_earliest = 2ε
   guarantee: true time ∈ [t_earliest, t_latest]
```

Spanner keeps ε small (single-digit milliseconds, typically ~1–7 ms) by deploying **GPS receivers and atomic clocks** in every datacenter and having a time-master infrastructure discipline server clocks tightly. ε is not zero — it is the *honestly advertised* uncertainty, and the system's correctness comes from *respecting* it rather than pretending clocks are perfect.

**Commit-wait.** To guarantee external consistency, Spanner assigns a commit timestamp `s` and then **waits out the uncertainty** before releasing locks / acknowledging the client:

```
   commit sequence for a write transaction:
   1. pick commit timestamp s = TT.now().latest   (upper bound: s is
      guaranteed ≥ true time at this moment)
   2. do the 2PC/Paxos commit work
   3. COMMIT-WAIT: block until TT.now().earliest > s
      i.e. until the clock is CERTAIN that absolute time has passed s.
   4. only then release locks and acknowledge the client
```

```
   time ──────────────────────────────────────────▶
        pick s = now.latest
        │                          wait until now.earliest > s
        ▼                          ▼ (≈ 2ε later)
   [====== commit-wait ≈ 2ε ======]  then reply to client
   effect: any transaction that STARTS after this reply is guaranteed
   to get a timestamp > s ⇒ commit order matches real-time order.
```

By waiting until `TT.now().earliest > s`, Spanner ensures that by the time the client hears "committed," the *true* time is definitely past `s`. Any later transaction, timestamped from its own (later) TrueTime interval, gets a strictly larger timestamp. External consistency holds. **The cost is latency: every read-write transaction pays a commit-wait of roughly 2ε** (a few milliseconds) before it can acknowledge. This is the fundamental **clock-uncertainty ↔ latency trade**: tighter clocks (smaller ε) mean shorter commit-wait and lower latency, which is exactly why Google spends money on GPS and atomic clocks — ε is a latency floor you *buy down* with hardware.

---

## 73.18 Spanner: 2PC over Paxos and MVCC Reads

TrueTime is the headline, but Spanner's transaction engine is a concrete instance of the §73.14 pattern — **2PC where each participant is a Paxos group** — and its read path is timestamped MVCC.

- **Data is sharded** into **splits** (key ranges). Each split is replicated across datacenters as a **Paxos group** with a leader; writes to a split go through Paxos so the split's state survives minority failure.
- **A read-write transaction that spans splits runs 2PC across the split leaders**, with one leader acting as **coordinator**. But — the §73.14 point — because each participant *and* the coordinator are Paxos groups (not single nodes), the coordinator's failure does **not** block: a new leader is elected and the 2PC decision, having been Paxos-logged, is recovered. Spanner thus gets 2PC's atomic-commitment semantics **and** non-blocking behavior. Two-phase locking (Ch. 65 §65.7) provides serializable isolation within this; commit-wait (§73.17) upgrades serializable to *externally consistent* (linearizable).
- **Read-only transactions** are the payoff. A read-only transaction picks a read timestamp `s_read` and reads the **MVCC snapshot** as of `s_read` at *any* sufficiently up-to-date replica — **no locks, no 2PC, no coordinator**. Because timestamps are globally meaningful (thanks to TrueTime), a snapshot read at timestamp `s_read` is consistent across all splits, and it can be served by a nearby follower replica (a replica just waits until it has applied all writes with timestamp ≤ `s_read`). This is why Spanner reads scale: they are lock-free, timestamped, and locally servable.

The synthesis: **Spanner = 2PC (atomicity across splits) over Paxos (non-blocking, durable) + 2PL (serializable isolation) + TrueTime commit-wait (external consistency) + MVCC (lock-free timestamped reads).** Each mechanism from earlier chapters slots in, and TrueTime is the one genuinely novel ingredient that turns a serializable system into a linearizable, globally-consistent one.

**Distributed deadlock — the lurking cost of cross-shard 2PL.** Because a spanning transaction holds locks on *multiple* shards from prepare until the decision (§73.5), two transactions grabbing the same rows in opposite orders can deadlock *across nodes* — a wait-for cycle where no single node sees the whole loop. Single-node deadlock detection (Ch. 65 §65.8) does not see it. Systems handle this two ways: (1) **timeout-based** abort — a transaction that waits too long for a lock assumes deadlock and aborts (simple, used by CockroachDB and many others, at the cost of false positives and tuning); or (2) **distributed deadlock detection** — nodes exchange local wait-for graphs and stitch them into a global graph to find real cycles (accurate but chatty). Deterministic systems like Calvin (§73.16) sidestep the problem entirely: because locks are acquired in the single global order, wait-for cycles *cannot form*, so there is no distributed deadlock to detect. This is a quiet but real advantage of ordering-up-front over coordinate-at-commit.

---

## 73.19 Database Partitioning and Sharding

Distributed transactions exist *because* data is partitioned; understand the partitioning to understand why transactions must cross nodes. **Partitioning (sharding)** splits a dataset across nodes so each holds a subset, for capacity and throughput beyond one machine. The central design question is the **partitioning function**: given a key, which node owns it?

**Range partitioning.** Assign contiguous key ranges to nodes (`A–H` → node 1, `I–P` → node 2, …). Kept sorted, so **range scans stay efficient** (a scan hits few adjacent partitions). But it is **skew-prone**: sequential keys (timestamps, auto-increment ids) create **hotspots** — all recent writes hammer the last partition. Requires choosing split points and rebalancing as ranges grow. Used by HBase, Bigtable, CockroachDB, YugabyteDB, Spanner (splits).

**Hash partitioning.** Apply a hash to the key and place by hash value (`node = hash(key) mod N`). **Spreads load uniformly** (a good hash destroys skew), which is great for point access and write distribution. But it **destroys order** — a range scan must touch *every* partition — and the naive `mod N` has a fatal flaw for elasticity: **changing N (adding/removing a node) remaps almost every key**, forcing a near-total data reshuffle. Used by Cassandra, DynamoDB, and others — but via *consistent* hashing, not `mod N`, precisely to dodge that reshuffle (§73.20).

```
   Range:  [A–H]→n1  [I–P]→n2  [Q–Z]→n3    ordered, scans cheap, skew risk
   Hash:   hash(k) mod 3 → node             uniform, scans hit all, remap on ΔN
```

The connection to transactions: with **hash** partitioning, related rows (a user and their orders) scatter across nodes, so a transaction touching them is *always* distributed → 2PC. With **range** partitioning, or deliberate **co-location** (Citus's colocated distribution, Spanner's interleaved tables), related rows can share a partition, keeping many transactions *single-node* and 2PC-free. **The cheapest distributed transaction is the one you turned into a local transaction by co-locating its data** — a recurring optimization theme.

---

## 73.20 Consistent Hashing

**Consistent hashing** is the technique that makes hash partitioning *elastic* — adding or removing a node reshuffles only a small fraction of keys instead of nearly all of them. It underpins **Amazon Dynamo, Cassandra, Riak, ScyllaDB** and countless caches (memcached clients).

**The construction.** Hash the key space onto a **ring** (a circle of hash values, e.g. `[0, 2^128)` wrapping around). Hash each **node** to a position on the same ring. A key is owned by the **first node encountered walking clockwise** from the key's position. That's it.

```
                  hash ring (clockwise ownership)
                         0 / 2^m
                          ●  ── node N1 at 0
              key k3 ────▶│        (k3 walks CW to N2)
                  N4 ●    │    ● N2   ← owns (N1, N2]
                     │    │    │
        (k1→N1)  ────●────┼────●──── key k1 walks CW to N1
                     │    │    │
                  N3 ●────┴────● key k2 (→ N3)
                       node N3 owns arc (N2, N3]
   Each node owns the arc from the previous node up to itself.
```

**Why membership change is cheap.** Add a node **N5** somewhere on the ring: it inserts between two existing nodes and takes over only the arc between its predecessor and itself — **only the keys in that one arc move**, and they move *from a single neighbor*. Every other key stays put. Remove a node: its arc is absorbed by its clockwise successor; again only that arc's keys move. The fraction remapped is ≈ **1/N** (one node's share), versus `mod N`'s near-**100%**. This is the whole reason consistent hashing exists: **O(1/N) data movement on membership change instead of O(1).**

**Virtual nodes (vnodes).** Naive consistent hashing has two problems: (1) with few nodes, random ring positions produce **uneven arc sizes** → load imbalance; (2) when a node joins/leaves, *one* neighbor bears all the transfer. The fix: give each physical node **many (e.g. 128–256) random positions** on the ring (virtual nodes / tokens). Now each physical node owns many small scattered arcs, so:

- **Load evens out** — the law of large numbers smooths arc sizes across hundreds of tokens.
- **Rebalancing spreads** — a departing node's many small arcs are absorbed by *many* different successors in parallel, not dumped on one neighbor. A joining node steals a little from *many* nodes at once.
- **Heterogeneity** — a beefier machine can be assigned proportionally more vnodes.

Cassandra calls these **tokens** (`num_tokens`, default 256 historically, lowered to 16 with allocation-aware placement in newer versions); Dynamo introduced the vnode idea. Replication rides on top: the replicas of a key are the **next R distinct physical nodes** clockwise (the *preference list*), skipping vnodes of nodes already chosen — which is how Dynamo/Cassandra place N replicas without extra coordination.

The quantitative punchline, adding a 5th node to a 4-node cluster of 1 M keys:

```
   scheme            keys that move when N: 4 → 5      why
   ─────────────────────────────────────────────────────────────
   hash(k) mod N     ~800,000  (≈ 80%, near-total)     mod changes for
                                                        almost every key
   consistent hash   ~200,000  (≈ 1/5 = 20%)           only one new arc's
                                                        keys relocate
   ─────────────────────────────────────────────────────────────
   asymptotically: mod N → O(keys);  ring → O(keys/N)
```

---

## 73.21 Percolator: Snapshot Isolation on Bigtable

**Google Percolator** (built to incrementally update Google's search index) is a landmark design: it layers **cross-row, cross-table transactions with snapshot isolation** on top of **Bigtable**, which itself offers only single-row atomicity — **without any classic transaction coordinator process**. It's the reference for how many later systems (TiDB's transaction model is directly Percolator-derived) do distributed transactions on a KV store.

**Ingredients.**
- A **timestamp oracle (TSO)**: a single, logically-centralized service handing out strictly monotonically increasing timestamps. Each transaction gets a `start_ts` at begin and a `commit_ts` at commit.
- **Multiple versions per cell**, keyed by timestamp (Bigtable already stores timestamped versions), giving MVCC snapshot reads: a transaction reads the latest version with timestamp ≤ `start_ts`.
- **Per-transaction locks stored *as data*** in special Bigtable columns (`lock`, `write`, `data`), using Bigtable's single-row atomic read-modify-write to place them. There is no lock *manager* — locks live in the rows.

**The primary-lock trick (the clever part).** Percolator commits with a 2PC-like structure but designates **one written row as the *primary***; all other written rows hold locks that *point to* the primary. The primary's lock is the **atomic commit point** — the analogue of the coordinator's `commit` `fsync` in §73.6, but stored in a data row instead of a coordinator's log.

```
   Prewrite phase (like 2PC prepare):
     - pick one cell as PRIMARY; others are SECONDARY (point to primary)
     - for each written cell: check for write conflicts since start_ts,
       then atomically write data@start_ts AND a lock (secondaries point
       to primary) via Bigtable single-row transaction. Abort if any
       cell is already locked or has a newer write.
   Commit phase:
     - COMMIT POINT: atomically replace the PRIMARY's lock with a
       write record @commit_ts (single-row atomic op). This one op
       decides the whole transaction: primary committed ⇒ committed.
     - then asynchronously (lazily) roll forward the SECONDARIES:
       replace each secondary lock with a write @commit_ts.
```

**Why no coordinator, and lazy cleanup.** The transaction's outcome is defined solely by whether the **primary lock** was converted to a write record. If a client crashes mid-commit, there is no coordinator to block; instead, **any *other* transaction that later stumbles on a leftover lock performs cleanup lazily**: it looks at the lock, finds the primary it points to, and checks the primary's state — if the primary is committed, it **rolls the secondary forward** (commits it); if the primary's lock is still there and stale (past a TTL), it **rolls the transaction back** (removes the lock). Cleanup is **on-read and lazy**, driven by whoever encounters the mess, not by a dedicated recovery process. This is how Percolator gets crash-resilient distributed commit without a running coordinator: the commit decision is atomically embodied in one row, and everyone agrees to consult that row.

**Costs.** The TSO is a potential bottleneck and single point of failure (mitigated by making it a small, fast, replicated service). Snapshot isolation — not serializability — means it is vulnerable to **write skew** (Ch. 65 §65.9). Latency is higher than single-row ops (multiple Bigtable round trips per transaction). But it made cross-shard ACID-ish transactions practical on a KV store, and its DNA is in TiDB, and conceptually in CockroachDB's lock representation.

---

## 73.22 CockroachDB and YugabyteDB

**CockroachDB** and **YugabyteDB** are open-source "distributed SQL" (NewSQL) databases that assemble the pieces from this chapter into wire-compatible-with-Postgres systems, and they're worth contrasting because they make slightly different choices.

**Common architecture (both):**
- **Range/tablet sharding** of the keyspace, each shard replicated by **Raft** (Ch. 74) — the §73.14 pattern: consensus per shard makes each participant a fault-tolerant group.
- **Distributed transactions via 2PC over those Raft groups**, so commit is **non-blocking** on any single node's failure (the coordinator's state is Raft-replicated / recoverable).
- **MVCC** with per-key timestamped versions; reads take a timestamp and see a consistent snapshot.
- **Postgres wire protocol** compatibility (YugabyteDB literally reuses the PostgreSQL query layer on top of a distributed storage engine).

**Where they differ — the clock story:**
- **CockroachDB** has **no TrueTime hardware**, so it cannot do Spanner's commit-wait cheaply. Instead it uses **HLCs (Hybrid Logical Clocks)** and a configured **maximum clock offset** (`max_offset`, default 500 ms). Rather than *waiting out* uncertainty, it handles it reactively: a read that encounters a value within the **uncertainty window** (a value whose timestamp is close enough that clock skew could reorder it) triggers a **read restart / uncertainty restart** at a higher timestamp. It provides **serializable** isolation but *not* strict external consistency/linearizability in the Spanner sense — it's serializable with a bounded-staleness caveat, and it relies on clocks staying within `max_offset` (a node whose clock drifts beyond the bound must **self-terminate** to preserve safety).
- **YugabyteDB** similarly uses HLCs and an offset bound, and can optionally integrate more precise clocks; it defaults to snapshot/serializable isolation with analogous clock-skew handling.

The interview point: **CockroachDB/YugabyteDB are "Spanner without the atomic clocks."** They replicate the 2PC-over-consensus + MVCC design, but substitute **software clocks (HLC) + a max-offset assumption + read restarts** for TrueTime's GPS/atomic-clock commit-wait. The trade is: no special hardware, but weaker real-time guarantees and correctness that depends on clocks staying within the configured offset — which is why clock synchronization (NTP/PTP) is an operational requirement, and a badly-drifted clock is a safety hazard, not just a performance one.

---

## 73.23 Coordination Avoidance: I-Confluence, CRDTs, RAMP

The cheapest distributed transaction is **no coordination at all**. A body of work — Bailis et al.'s **coordination avoidance** — asks: *when can operations run without any cross-node coordination and still keep the database's invariants?* The answer reframes when you actually *need* 2PC/consensus.

**Invariant confluence (I-confluence).** An invariant `I` (e.g. "balance ≥ 0", "username is unique", "foreign key exists") is **I-confluent** with respect to a set of operations if, whenever two states each satisfy `I`, **merging** them also satisfies `I`. Formally: operations can execute concurrently on divergent replicas and be merged **without coordination** *if and only if* the invariant is I-confluent under those operations.

- **I-confluent (no coordination needed):** appending to a set, incrementing a counter with only-increases invariants, inserting rows that don't violate a *per-partition* constraint. Merging preserves the invariant, so replicas can diverge and reconcile freely.
- **NOT I-confluent (coordination required):** **uniqueness** (two replicas each independently assign the same username — merge violates uniqueness), **bounded/non-negative constraints** under concurrent decrements ("balance ≥ 0" with two concurrent withdrawals that individually pass but together overdraw), **foreign-key + delete** races. These genuinely need coordination (2PC/consensus) to be safe.

The value of I-confluence is a **principled dividing line**: it tells you *exactly* which invariants force you to pay for coordination and which let you run coordination-free — instead of blanket-serializing everything. Serializability is *sufficient* but usually *overkill*; I-confluence identifies the minimum.

**Mechanisms that exploit coordination-freedom:**
- **CRDTs (Conflict-free Replicated Data Types, Ch. 71).** Data types (counters, sets, registers, maps) whose merge is commutative, associative, and idempotent, so concurrent replicas **always** converge without coordination. They are I-confluent by construction — the merge *is* the invariant-preserving operation. Great for I-confluent invariants; they cannot manufacture coordination-freedom for a non-I-confluent invariant like uniqueness.
- **RAMP transactions (Read Atomic Multi-Partition).** A weak but coordination-light transaction model giving **read atomicity** across partitions — a reader sees either all or none of a transaction's writes — *without* locks or 2PC blocking, using **multi-versioning + metadata** so a reader that catches a partial write can fetch the missing sibling versions. It guarantees atomic visibility without the coordination cost of 2PC, trading away serializability.
- **Escrow / reservation.** For a bounded resource ("100 tickets"), pre-**partition the budget** across nodes (each node gets 25 tickets to sell locally). Nodes sell from their local escrow **without coordination** until their slice runs low, coordinating only to rebalance the escrow — converting a globally-coordinated constraint into mostly-local decisions. This is how high-throughput inventory/ticketing systems avoid a global lock on the counter.

The unifying motivation is **performance**: coordination (2PC, consensus, commit-wait) costs round trips, `fsync`s, and lock-hold time, and it caps throughput and inflates tail latency. Coordination avoidance says: **coordinate only for the invariants that provably require it (non-I-confluent ones), and run everything else coordination-free.** It is the theoretical counterweight to this whole chapter — the discipline of *not* using the expensive machinery unless the invariant leaves you no choice.

---

## 73.24 Distributed PostgreSQL: Citus and FDW-Based 2PC

Bring it home to Postgres. Core Postgres gives the **cohort** side of 2PC (§73.11) but no coordinator; distributed-Postgres solutions supply the missing coordinator and the sharding, building directly on `PREPARE TRANSACTION`.

**Citus** (a Postgres extension, now maintained by Microsoft) turns Postgres into a **sharded, distributed** database:
- **Distributed tables** are hash-partitioned into **shards** spread across **worker** nodes; a **coordinator** node holds metadata and routes/plans queries. (This is a *query* coordinator; note the terminology overlap with the *transaction* coordinator.)
- **Colocation.** Tables sharded on the same key with the same shard count are **colocated** — rows that join on the distribution key live on the same worker, so joins and (crucially) transactions touching them stay **local, single-node, 2PC-free**. This is the §73.19 co-location optimization made a first-class feature.
- **Multi-shard writes use 2PC.** When a transaction genuinely spans workers, Citus's coordinator runs **2PC using Postgres's own `PREPARE TRANSACTION` / `COMMIT PREPARED`** on each worker (hence Citus requires `max_prepared_transactions > 0` on workers). The Citus coordinator is the transaction coordinator, and it maintains a **`pg_dist_transaction`** record of prepared transactions so that, after a coordinator crash, a background daemon can **recover** in-doubt prepared transactions on the workers (commit or roll back the orphans) rather than leaving them holding locks forever. This is Citus's answer to §73.8's blocking problem — not true non-blocking consensus-backed commit, but an automated recovery daemon that resolves in-doubt transactions when the coordinator returns.

**FDW-based 2PC.** Postgres's **Foreign Data Wrappers** (`postgres_fdw`) let one Postgres instance query others as foreign tables. Historically a transaction spanning local + foreign servers was **not** atomic (the foreign modifications could commit while the local one aborted). Work on **`postgres_fdw` + 2PC** (a long-running community effort, with an `atomic commit for FDW` patch series) wires the foreign servers as 2PC cohorts via `PREPARE TRANSACTION`, with the local server as coordinator and a resolver process to complete/recover prepared foreign transactions — again, Postgres's cohort-side 2PC plus an added coordinator with a recovery mechanism.

The through-line for interviews: **every distributed-Postgres system is Postgres-the-cohort (`PREPARE TRANSACTION`) plus a bolted-on coordinator, and the quality of a solution is largely the quality of its coordinator's *recovery* story** — how it resolves orphaned prepared transactions after a crash. Citus uses a recovery daemon + `pg_dist_transaction`; the theoretically strongest answer (Spanner/CockroachDB) is to make the coordinator itself consensus-replicated so there are no orphans to recover in the first place (§73.14). Postgres's own 2PC is the atom; the whole chapter's spectrum of solutions is different ways to make the coordinator around it not be a single point of failure.

---

## Summary

- **Single-node atomicity is a durability problem** (one WAL, one `fsync` = commit point); **distributed atomicity is an agreement problem** — N independently-failing logs must reach one all-or-nothing decision.
- **Atomic commitment ≠ consensus** but is related: it adds a **unanimity/veto** rule (commit iff *all* vote yes) and has *worse* liveness — the Skeen result says no async commit protocol is non-blocking under one crash, mirroring FLP. Consensus is the fault-tolerant way to *get* the agreement it needs.
- **2PC** = prepare/vote then commit/decide, driven by one coordinator; correctness rests on forced WAL records (`prepared`, `commit`) written **before** the messages that depend on them. Cost: 2 round trips, ~2(N+1) `fsync`s, and locks held from prepare to decision.
- **Cohort failures are survivable** (default-abort in phase 1; coordinator is the oracle in phase 2). **Coordinator failure is the blocking problem**: in-doubt cohorts that voted YES can neither commit nor abort and **block holding locks** until it recovers. 2PC is therefore **not partition-tolerant** (chooses C over A) and blocks *unboundedly*.
- **Presumed-abort** (Postgres's default) lets absence-of-record mean abort, saving logging on aborts. **3PC** adds a pre-commit phase to be non-blocking — but only under a synchronous, partition-free model; under real asynchrony/partition it can **split-brain and violate atomicity**, so nobody uses it.
- The real fix is **consensus-backed 2PC (Paxos Commit)**: replicate votes and the coordinator's decision via Paxos/Raft so no single (minority) failure blocks. This is what **Spanner, CockroachDB, YugabyteDB** run — 2PC over per-shard consensus groups.
- **Calvin/FaunaDB** avoid outcome-agreement by agreeing on a **global order** up front (deterministic execution ⇒ no 2PC), at the cost of needing known read/write sets.
- **Spanner** = 2PC over Paxos + 2PL + MVCC + **TrueTime commit-wait**: it waits out clock uncertainty **ε** (GPS+atomic clocks) to guarantee **external consistency**, paying ~2ε latency per write. **CockroachDB** is "Spanner without atomic clocks" — HLC + max-offset + read restarts, serializable but weaker real-time guarantees.
- **Partitioning** (range: ordered, skew-prone; hash: uniform, order-destroying) forces distributed transactions; **consistent hashing** (ring + **virtual nodes**) makes hash sharding elastic, moving only ~1/N of keys on membership change (vs ~100% for `mod N`) — the basis of Dynamo/Cassandra.
- **Percolator** does snapshot-isolation transactions on Bigtable with a **timestamp oracle** and a **primary lock** stored *as data* as the commit point, with **lazy on-read cleanup** — no running coordinator.
- **Coordination avoidance** (I-confluence, CRDTs, RAMP, escrow) coordinates **only** for invariants that provably require it (uniqueness, non-negative balances) and runs everything else coordination-free.
- **Distributed Postgres** = Postgres-the-cohort (`PREPARE TRANSACTION`/`COMMIT PREPARED`, gated by `max_prepared_transactions`) plus a bolted-on coordinator (**Citus**, FDW-2PC); its quality is its coordinator's crash-recovery story for orphaned prepared transactions.

---

## Key Interview Questions

1. **Why is a distributed transaction harder than a single-node one?** — On one node, atomicity is the atomicity of one WAL `fsync` — a durability problem. Across nodes there is no single log or fate; each node has its own WAL and **fails independently**, so N logs must be made to reach the *same* all-or-nothing decision despite worst-case crashes and network faults. That is an agreement problem, not a durability one.
2. **Is atomic commitment the same as consensus?** — No. Consensus agrees on any proposed value and terminates with a majority alive. Atomic commitment adds a **unanimity/veto** rule (commit iff *all* vote yes; any participant can force abort) and has worse liveness — classic 2PC blocks on a single coordinator failure. Skeen's result (the FLP analogue) says no async commit protocol is non-blocking under one crash. Consensus is how you *make* commit fault-tolerant.
3. **Walk through the two phases of 2PC.** — Phase 1 (prepare/vote): coordinator sends PREPARE; each cohort validates, acquires locks, force-logs `prepared`, and votes YES/NO, becoming in-doubt if YES. Phase 2 (decide): if all YES, coordinator force-logs `commit` (the global commit point) and broadcasts COMMIT; else ABORT. Cohorts log the decision, release locks, and ACK.
4. **What is the "commit point" in 2PC and why does its location matter?** — The coordinator's forced `commit` WAL write. Before it the transaction is abortable; after it, every cohort *will* eventually commit regardless of further crashes. It is singular and unambiguous — the protocol can only *fail to deliver* the decision in bounded time, never lose it.
5. **Why must each participant write its log record before sending the corresponding message?** — Because recovery reconstructs state from the log. A cohort that voted YES but crashed before logging `prepared` could wrongly abort a committed transaction; a coordinator that decided but crashed before logging `commit` would lose the only record of the outcome. Log-then-send is what makes the protocol recoverable.
6. **What happens if a cohort crashes after voting YES but before the decision?** — It is **in-doubt**: on recovery it finds `prepared` with no decision, may neither commit nor abort unilaterally, and must run the recovery protocol — ask the coordinator (or peers) for the outcome — holding its locks across the crash until it gets an answer.
7. **What is the blocking problem in 2PC?** — If the coordinator crashes after some cohorts voted YES but before distributing the decision, those in-doubt cohorts cannot commit (some cohort might have voted NO) nor abort (some cohort might already have committed), so they **block holding locks** until the coordinator recovers. It is a fundamental limitation, not a bug — Skeen proved no single-coordinator async protocol avoids it.
8. **Does cooperative termination (cohorts asking peers) fix blocking?** — Only partially. If any reachable peer already knows the decision, or any peer hasn't voted / voted NO, the group can proceed. But if *all* reachable cohorts are in-doubt (all voted YES, none heard back), they still cannot tell whether the coordinator flushed `commit` before dying — so they remain blocked. It narrows the window but doesn't eliminate it.
9. **Why is 2PC not partition-tolerant?** — During a partition isolating the coordinator from in-doubt cohorts, those cohorts block holding locks (choosing consistency over availability), and the blocking is unbounded and cascades to every conflicting transaction. Its coordinator is a single un-replicated decision-maker; partition tolerance for commit requires replicating the decision via consensus.
10. **What is presumed abort, and why is it the default?** — If a cohort asks about a transaction the coordinator has no record of, the answer is ABORT. This lets the coordinator skip force-logging and ACK-collection for aborts (forgetting is safe, since a forgotten transaction is presumed aborted). It optimizes the common abort/read-only cases; it still must force-log commits. Presumed commit is the mirror and is rarely worth it.
11. **How does PostgreSQL expose 2PC?** — `PREPARE TRANSACTION 'gid'` is phase 1: it persists the transaction under `pg_twophase/`, `fsync`s, holds all locks, and detaches from the session (surviving disconnect and restart). `COMMIT PREPARED 'gid'` / `ROLLBACK PREPARED 'gid'` are phase 2. It requires `max_prepared_transactions > 0` (default 0). Postgres is the cohort; it provides no coordinator.
12. **What goes wrong with an orphaned prepared transaction in Postgres?** — Postgres holds its locks *forever* until someone issues phase 2, and its live `xmin` blocks VACUUM (bloat, XID-wraparound risk). It is §73.8's blocking problem operationalized; you must find it via `pg_prepared_xacts` and manually `ROLLBACK PREPARED`. This is why 2PC needs a reliable transaction manager.
13. **What does `max_prepared_transactions` control?** — The size of the shared-memory slot array for concurrently-prepared (phase-1) transactions. It defaults to 0, which disables `PREPARE TRANSACTION` entirely; distributed-Postgres systems like Citus require it be set on workers.
14. **How does 3PC try to be non-blocking?** — It inserts a **pre-commit** phase between voting and commit. A cohort in the prepared-to-commit state *knows* everyone voted YES, so if the coordinator dies, survivors reason from their states: if any reached pre-commit, commit; if none did, abort. The middle state removes the ambiguity that blocks 2PC — under a synchronous, fail-stop model.
15. **Why doesn't anyone use 3PC?** — Its non-blocking guarantee assumes bounded delays (accurate failure detection) and *no partitions*. Under a real partition during phase 2, the side that saw pre-commit commits while the side that didn't aborts — a **split-brain / atomicity violation**. 3PC trades 2PC's *blocking* (safe but stuck) for a possible *safety* violation (progress but disagreement), plus a third round trip. That's a worse deal for a database.
16. **How do modern distributed SQL databases make 2PC non-blocking?** — **Consensus-backed 2PC** (Paxos Commit): replicate each cohort's vote and the coordinator's decision through Paxos/Raft groups, so the loss of any minority (including the original coordinator) doesn't lose the decision — a new leader recovers it from the consensus log. It restores liveness without breaking safety. Spanner, CockroachDB, YugabyteDB all run 2PC over per-shard consensus groups.
17. **How does Calvin avoid 2PC?** — It agrees on a **global total order** of transactions up front via a replicated sequencer, then executes that order **deterministically** on every replica. Since all replicas process the same order with the same logic, they reach the same state — no per-transaction outcome vote, no coordinator, no in-doubt state. The cost is needing each transaction's read/write set known in advance.
18. **What is TrueTime and why does Spanner need it?** — TrueTime returns a time *interval* `[earliest, latest]` guaranteed to contain true time, with bounded uncertainty ε (kept to a few ms via GPS + atomic clocks). Spanner needs it because assigning globally-comparable commit timestamps across skewed clocks is otherwise impossible; TrueTime makes the uncertainty explicit and bounded so the system can respect it.
19. **What is commit-wait and what does it buy?** — After picking commit timestamp `s = TT.now().latest`, Spanner **waits until `TT.now().earliest > s`** (about 2ε) before releasing locks and acking. This guarantees true time has passed `s` by the time the client hears "committed," so any later transaction gets a larger timestamp — yielding **external consistency** (linearizability). The cost is ~2ε of added latency per write; smaller ε (better clocks) means less waiting.
20. **Describe Spanner's full transaction stack.** — Data sharded into splits, each a Paxos group; read-write transactions run **2PC across split leaders** (non-blocking because each role is Paxos-replicated); **2PL** gives serializability; **TrueTime commit-wait** upgrades it to external consistency; **MVCC** lets read-only transactions read a consistent snapshot at a timestamp with no locks/2PC, servable by nearby replicas.
21. **How is CockroachDB "Spanner without atomic clocks"?** — Same 2PC-over-Raft + MVCC design, but no TrueTime hardware. It uses **Hybrid Logical Clocks** and a configured **max clock offset**; instead of commit-wait it does **read restarts** when a read hits a value inside the uncertainty window. It's serializable but not strictly linearizable like Spanner, and correctness depends on clocks staying within the offset (a drifted node must self-terminate).
22. **Range vs hash partitioning — trade-offs?** — Range: ordered, so range scans are cheap, but skew-prone (sequential-key hotspots) and needs split-point management. Hash: uniform load and no hotspots, but destroys order (range scans hit all partitions), and naive `mod N` remaps almost everything when N changes. Range/co-location keeps related rows together, turning distributed transactions back into local ones.
23. **Why does consistent hashing beat `hash mod N`?** — Both hash keys to nodes, but `mod N` remaps ~100% of keys when N changes. Consistent hashing places keys and nodes on a ring; a joining/leaving node only affects the arc between it and one neighbor, so only ~1/N of keys move. That elasticity is why Dynamo/Cassandra use it.
24. **What problem do virtual nodes solve?** — With few nodes, random ring positions give uneven arcs (load imbalance) and dump all of a departing node's data on one neighbor. Giving each physical node many vnodes/tokens evens out load (law of large numbers), spreads rebalancing across many nodes in parallel, and lets heterogeneous machines carry proportional shares.
25. **How does Percolator commit a distributed transaction without a coordinator?** — It uses a timestamp oracle and stores locks *as data* in Bigtable rows. It designates one written row as the **primary**; committing = atomically converting the primary's lock to a write record via a single-row Bigtable transaction — that one op is the commit point. Secondaries point to the primary and are rolled forward **lazily** by whatever later transaction encounters their stale locks.
26. **What isolation does Percolator provide, and what's the catch?** — **Snapshot isolation** (reads at `start_ts`, MVCC versions), which permits **write skew**, not full serializability. Additional costs: the timestamp oracle is a potential bottleneck/SPOF, and each transaction needs multiple Bigtable round trips.
27. **What is I-confluence (invariant confluence)?** — An invariant is I-confluent under a set of operations iff merging any two invariant-satisfying states also satisfies it. If so, replicas can execute concurrently and merge **without coordination**; if not, coordination is required. It's the precise dividing line: uniqueness and non-negative-balance-under-concurrent-decrement are *not* I-confluent (need coordination); set-insert and increment often are.
28. **Give an invariant that forces coordination and one that doesn't.** — **Forces it:** username uniqueness (two replicas independently assign the same name; merge violates it) or "balance ≥ 0" under concurrent withdrawals. **Doesn't:** appending to a set or incrementing a counter whose invariant only cares that it grows — merging preserves the invariant, so CRDTs handle it coordination-free.
29. **What are RAMP transactions?** — Read Atomic Multi-Partition transactions: they guarantee a reader sees all-or-none of a transaction's writes across partitions **without locks or 2PC blocking**, using multi-versioning plus metadata so a reader that catches a partial write fetches the missing sibling versions. They provide atomic visibility cheaply, trading away serializability.
30. **How do distributed-Postgres systems like Citus handle multi-shard transactions?** — They shard tables across workers (co-locating related rows to keep most transactions local) and, for genuinely multi-shard writes, run **2PC using Postgres's own `PREPARE TRANSACTION`/`COMMIT PREPARED`** on the workers. Citus's coordinator records prepared transactions in `pg_dist_transaction` and runs a recovery daemon to resolve orphaned prepared transactions after a crash — an automated answer to the blocking problem short of full consensus-backed commit.
31. **Why do 2PC's locks hurt so much more than single-node locks?** — Locks are held from phase-1 prepare until the phase-2 decision — at minimum a full round trip, unbounded if the coordinator stalls or a partition hits. Every conflicting transaction on those rows blocks for that whole window, so one stuck distributed transaction can cascade into a widening pool of blocked work. Single-node transactions release at their local commit instantly.
32. **What's the relationship between co-location and distributed-transaction cost?** — The cheapest distributed transaction is one you avoided by co-locating its data. If related rows share a partition (Citus colocation, Spanner interleaving, range partitioning), transactions over them stay single-node and skip 2PC entirely. Hash partitioning scatters related rows and forces 2PC — which is why partitioning strategy is a transaction-performance decision, not just a storage one.

---

## Common Traps

- **Saying "atomic commitment is just consensus."** It adds a unanimity/veto requirement (any participant forces abort) and has *worse* liveness — classic 2PC blocks on one coordinator failure, which consensus tolerates. They are related but not interchangeable.
- **Claiming 2PC "loses" the decision when the coordinator crashes.** It never loses a decision (it's force-logged); it fails to *deliver* it in bounded time, leaving in-doubt cohorts blocked holding locks. Loss vs non-delivery is the whole distinction.
- **Thinking the blocking problem is fixed by cohorts asking each other.** Cooperative termination helps only if some reachable peer knows the outcome or hasn't committed; if all reachable cohorts are in-doubt, they stay blocked. Peer chatter narrows, never closes, the window.
- **Believing 3PC solves blocking in practice.** It's non-blocking only under a synchronous, partition-free model; under real partitions it can split-brain and violate atomicity, which is strictly worse than blocking. No production database uses it.
- **Assuming PostgreSQL does distributed transactions out of the box.** It provides only the *cohort* side (`PREPARE TRANSACTION`), disabled by default (`max_prepared_transactions = 0`), and *no* coordinator; you must supply a reliable transaction manager or use Citus/FDW-2PC.
- **Forgetting orphaned prepared transactions hold locks and block VACUUM forever.** A crashed external coordinator leaves prepared transactions pinning locks and holding back cleanup (XID-wraparound risk) until manually resolved via `pg_prepared_xacts`.
- **Confusing TrueTime's ε with an error you can ignore.** ε is the *honestly advertised* clock uncertainty; Spanner's correctness comes from *waiting it out* (commit-wait ≈ 2ε), not from pretending clocks are exact. Shrinking ε with better hardware directly lowers write latency.
- **Saying CockroachDB has external consistency like Spanner.** Without atomic clocks it uses HLC + max-offset + read restarts, giving serializability but weaker real-time guarantees, and its safety depends on clocks staying within the configured offset (a drifted node must self-terminate).
- **Using `hash(key) mod N` for a sharded, elastic cluster.** Changing N remaps almost every key. Consistent hashing (ring + virtual nodes) moves only ~1/N of keys on membership change — that's the entire reason it exists.
- **Thinking virtual nodes are just for load balancing.** They also parallelize rebalancing (a departing node's arcs spread across many successors, not one) and enable heterogeneous capacity — not only smoothing arc sizes.
- **Assuming Percolator needs a running coordinator process for recovery.** The commit point is the primary lock stored as data; crash recovery is *lazy and on-read*, performed by whatever later transaction stumbles on a stale lock and consults the primary — no dedicated coordinator.
- **Serializing everything "to be safe."** Coordination avoidance shows serializability is usually overkill; I-confluence identifies exactly which invariants (uniqueness, non-negative balances) require coordination, letting the rest run coordination-free via CRDTs/RAMP/escrow for far higher throughput.
- **Treating partitioning as only a storage decision.** It's a transaction-performance decision: hash partitioning scatters related rows and forces 2PC, while co-location/range keeps them local and 2PC-free. The cheapest distributed transaction is the one you turned local.
- **Believing snapshot isolation (Percolator) equals serializability.** It permits write skew; two transactions can each read a valid snapshot and write disjoint keys that jointly violate an invariant, which serializability would prevent.
