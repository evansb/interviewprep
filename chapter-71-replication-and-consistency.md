# Chapter 71 — Replication and Consistency

*Interview-focused revision notes. The theme: the moment there is more than one copy of the data, "the value of x" stops being a fact and becomes a negotiation. Replication buys you availability, read throughput, geographic locality, and durability; the bill is paid in consistency — every copy that lags is a reader that can be lied to. This chapter is the distributed analogue of the hardware memory model (Ch. 25): there, cores disagree about the order of writes and `happens-before` is the vocabulary that pins down when they must agree; here, nodes disagree about the order of writes and the consistency models are that same vocabulary, one network hop up. PostgreSQL streaming replication anchors the mechanism; Dynamo-style quorums, Spanner/CockroachDB, and CRDTs anchor the model.*

---

## 71.1 Why Replicate, and What It Costs

**Replication** is keeping a copy of the same data on more than one node. There are exactly four reasons to do it, and every replication design is a weighting of them:

- **Availability.** If one node dies, another can serve. A single node has an availability ceiling set by its hardware MTBF; N independent replicas raise it combinatorially (all N must be down simultaneously to lose service).
- **Read scaling.** Reads can be spread across replicas, multiplying read throughput roughly linearly. Writes cannot be scaled this way — every replica must eventually apply every write — which is why replication helps read-heavy workloads far more than write-heavy ones. (Scaling writes needs **partitioning/sharding**, Ch. 73.)
- **Geographic locality.** A replica near the client cuts read latency from a cross-continent ~150 ms round trip to a same-region ~1 ms one, and keeps a region serving during a network partition from the others.
- **Durability.** A write that lives on k independent nodes survives the loss of k−1 of them. Replication is durability against *whole-machine* loss, the layer above WAL/`fsync` durability against *process/power* loss (Ch. 61 §61.5).

The cost is a single sentence you should be able to produce cold: **the only hard part of replication is keeping the copies consistent while the network and nodes fail underneath you.** Copying bytes is trivial; agreeing on *what the current bytes are* when messages are delayed, reordered, duplicated, or dropped (Ch. 68) is the entire discipline. Every model in the second half of this chapter is a different answer to "how much may the copies disagree, and for how long?"

There is a second, quieter cost: replication does not remove the single-writer bottleneck for writes, it can *add* latency to them (waiting for replicas to acknowledge), and it multiplies the surface area for failure (more nodes, more links, more clocks that can skew — Ch. 68 §68.x).

---

## 71.2 Replication Topologies

Who is allowed to accept a write, and how does it propagate? Three topologies, and essentially every system is one of them or a hybrid.

```
SINGLE-LEADER (primary/replica, master/slave, active/passive)

        writes          reads
          │               │
          ▼               ▼
      ┌────────┐  WAL   ┌────────┐  ┌────────┐
      │ leader │──────▶ │replica │  │replica │
      │ (R/W)  │──┐     │ (R/O)  │  │ (R/O)  │
      └────────┘  └────────────────▶└────────┘
   one node orders all writes; replicas replay the same stream

MULTI-LEADER (multi-master)

     ┌────────┐◀───────────────▶┌────────┐
     │leader A│                  │leader B│   each accepts writes,
     │ (R/W)  │◀───────────────▶ │ (R/W)  │   ships them to the others,
     └────────┘                  └────────┘   CONFLICTS are possible
     (typically one leader per region/datacenter)

LEADERLESS (Dynamo-style)

        client ──put──▶ ┌──┐ ┌──┐ ┌──┐   writes go to several nodes at once;
                        │N1│ │N2│ │N3│   reads query several and reconcile;
        client ◀─get──  └──┘ └──┘ └──┘   no node is "the" leader
             quorum overlap gives consistency (§71.22)
```

**Single-leader** (Postgres streaming replication, MySQL, MongoDB replica sets, Kafka partitions). One node — the **leader/primary** — accepts all writes and defines *the* order of writes. That order is shipped as a log (Postgres: the WAL) to **followers/replicas**, which replay it. Reads may go to the leader (always current) or to replicas (possibly stale). The single point of write-ordering is what makes strong consistency *achievable* here — there is one authoritative sequence — and the single point of write-*acceptance* is the availability weakness: if the leader dies, no writes happen until a new leader is chosen (failover, Ch. 68).

**Multi-leader.** Several nodes accept writes, usually one per datacenter, and asynchronously exchange them. It removes the single write bottleneck and survives a leader loss locally, but two leaders can accept **conflicting** writes to the same key concurrently, and now you *must* have a conflict-resolution policy (last-write-wins, application merge, CRDTs — §71.24). Multi-leader is a conflict-generation machine; use it only when you can tolerate or resolve conflicts.

**Leaderless** (Amazon Dynamo, Cassandra, Riak, DynamoDB, ScyllaDB). No node is special. A write is sent to several replicas at once; a read queries several and reconciles divergent answers. Consistency is a property of **quorum overlap** and client-tunable (§71.22), not of a fixed leader. This is the availability-first design: as long as *enough* nodes respond, the system serves, even during a partition.

| Topology | Write bottleneck | Conflicts? | Failover | Typical consistency |
|---|---|---|---|---|
| Single-leader | leader | none (one order) | needed, disruptive | strong on leader, lag on replicas |
| Multi-leader | none | **yes** | local, graceful | eventual + conflict resolution |
| Leaderless | none | resolved on read/write | none (no leader) | tunable via R/W/N |

---

## 71.3 Synchronous, Asynchronous, and Semi-Synchronous Replication

Orthogonal to topology is **when the write is acknowledged to the client** relative to replica propagation. This single choice sets the durability-vs-latency trade, and it is the most-asked replication question.

```
ASYNCHRONOUS                          SYNCHRONOUS
 client        leader   replica        client        leader   replica
   │  write      │         │             │  write      │         │
   ├────────────▶│         │             ├────────────▶│         │
   │   ACK       │ ship    │             │             │  ship   │
   │◀────────────┤────────▶│             │             ├────────▶│
   │             │  (later)│             │             │  ACK    │
   ▼             ▼         ▼             │             │◀────────┤
  fast; may lose the last                │   ACK       │         │
  writes if leader dies                  │◀────────────┤         │
  before they ship                       ▼             ▼         ▼
                                        durable on ≥2 nodes;
                                        pays one replica round trip
```

- **Asynchronous.** The leader acknowledges the client as soon as *it* has the write durable locally, then ships to replicas in the background. Lowest write latency (no replica wait). Risk: if the leader crashes before a write reaches any replica, that acknowledged write is **lost** on failover. This is the default for Postgres streaming replication and for most read-scaling deployments.

- **Synchronous.** The leader waits for one or more replicas to confirm before acknowledging the client. The write is durable on ≥2 nodes, so a single-node loss is survivable with **zero data loss** (RPO = 0). Cost: every write pays a replica round trip, so write latency ≥ network RTT to the slowest required replica, and — critically — if the required replica is *down*, writes **stall** unless you have a fallback. Naive fully-synchronous single-replica replication *reduces* availability for writes: you now need *both* nodes up.

- **Semi-synchronous.** The pragmatic middle: replicate synchronously to one replica (durability) and asynchronously to the rest (scaling). MySQL's `rpl_semi_sync` and Postgres's `synchronous_standby_names` with one standby both do this. The interview framing: semi-sync gives you RPO ≈ 0 for a single failure without paying a round trip to *every* replica.

The trade compresses to: **async optimizes latency and accepts a data-loss window on failover; sync optimizes durability and accepts higher write latency plus a write-availability dependency on the synced replica.** There is no free lunch; you choose your RPO.

---

## 71.4 PostgreSQL Streaming Replication (Physical WAL)

Ground the mechanism in Postgres, the reference for the replication half. Postgres's primary form of replication is **physical streaming replication**: it ships the **write-ahead log** (WAL, Ch. 61 §61.5, Ch. 65) byte-for-byte from primary to standby.

The WAL is the same append-only redo log the primary uses for its own crash recovery — records of physical page changes ("on block X, at offset Y, these bytes changed"). Replication reuses it: a standby is a node perpetually performing **crash recovery**, replaying an endless WAL stream instead of a finite one.

```
PRIMARY                                   STANDBY (hot standby)
 ┌───────────────┐                        ┌───────────────────┐
 │ backends      │ emit WAL records       │ startup process   │
 │   ↓           │                        │   replays WAL ───▶│ applied to
 │ WAL buffers ──┼── wal sender ══════════┼▶ wal receiver     │ its own pages
 │   ↓ fsync     │   TCP stream (libpq)   │   ↓ writes WAL    │
 │ WAL segments  │                        │ WAL segments      │
 └───────────────┘                        └───────────────────┘
        LSN = Log Sequence Number: a monotonically increasing
        byte offset into the WAL; the universal clock of replication.
```

Key facts:

- **LSN (Log Sequence Number).** A 64-bit monotonically increasing position in the WAL. Every WAL record has one. Replication progress is measured entirely in LSNs: `sent_lsn`, `write_lsn`, `flush_lsn`, `replay_lsn` on the primary's `pg_stat_replication` view tell you exactly how far each standby has received, fsynced, and *applied* the stream. Replication lag is `primary_lsn − standby_replay_lsn` (in bytes) or the wall-clock `replay_lag`.
- **`walsender` / `walreceiver`.** The primary spawns one `walsender` process per connected standby; the standby runs a `walreceiver` that streams WAL over the libpq protocol and hands it to the **startup process** for replay.
- **Physical = byte-identical.** Because it replays physical block changes, a physical standby is an exact block-for-block copy of the primary — same page layout, same everything. This is efficient but rigid: the standby must be the same major version and architecture, and it replicates the *whole cluster* (all databases), not a subset. It cannot replicate *into* a differently-structured database. (Logical replication, §71.8, lifts these limits.)
- **Hot standby.** A physical standby can serve **read-only** queries while it replays (`hot_standby = on`). This is how read replicas are built. Queries on the standby see a consistent snapshot but a *lagging* one (§71.9).

The four LSN checkpoints on each standby — `write`, `flush`, `replay` — are the hooks the durability levels in §71.5 attach to.

---

## 71.5 synchronous_commit Levels

Postgres exposes the async/sync spectrum not as a binary but as a five-position dial: `synchronous_commit`, settable per-transaction. This is a favorite precise-knowledge question. Each level says **how far a commit must propagate before `COMMIT` returns to the client.**

```
      commit path:  local WAL write → local fsync → send → remote write → remote fsync → remote apply
                    └──────────── on the primary ─────────┘└──────────── on the standby ─────────────┘

  synchronous_commit value   returns after ...
  ────────────────────────   ─────────────────────────────────────────────────────
  off                        local WAL written to buffers only (NOT fsynced).
                             Async even locally; a small window of committed-but-
                             lost-on-crash txns. Never loses consistency, only
                             durability. Fastest.
  local                      local WAL fsynced. Full LOCAL durability, but does
                             NOT wait for any standby (this is async replication).
  remote_write               standby has WRITTEN the WAL to its OS (not fsynced).
                             Survives standby postgres crash, not standby OS/power loss.
  on   (default)             standby has FSYNCED the WAL to disk. Survives standby
                             crash+power loss. Zero data loss on primary failover.
  remote_apply               standby has REPLAYED (applied) the WAL, so the commit
                             is VISIBLE to reads on that standby. Enables read-your-
                             writes across a read replica (§71.26). Slowest.
```

The two subtleties interviewers dig for:

1. **`off` is not "no durability at the cost of correctness."** It only defers the local `fsync`; a crash may lose the last few committed transactions, but the database is never left *inconsistent* — WAL ordering guarantees a torn-free, prefix-consistent recovery. It trades a bounded RPO for throughput, exactly like group commit (Ch. 61 §61.5). `local` restores full local durability.

2. **`remote_apply` is the only level that guarantees a standby will *show* your write to a subsequent read.** `on` guarantees the WAL is *on disk* at the standby but not yet *applied to its pages* — a read routed there immediately after commit can still miss the write. This gap is the entire subject of §71.9 and §71.26.

The dial is per-transaction: bulk-load a report table with `synchronous_commit = off` for speed, and commit a financial transfer with `remote_apply` for correctness, in the same session.

---

## 71.6 Quorum-Based Synchronous Replication

Waiting for *one specific* standby is fragile — if that standby is down, writes stall. Postgres 9.6+ generalizes to **quorum synchronous replication** via `synchronous_standby_names`, so the primary waits for **any k of a set** to confirm.

```
synchronous_standby_names = 'ANY 2 (s1, s2, s3, s4)'
   → commit waits until ANY 2 of the 4 named standbys confirm.
     Survives loss of up to 2 standbys without stalling writes,
     while every commit is durable on primary + 2 standbys.

synchronous_standby_names = 'FIRST 2 (s1, s2, s3)'
   → priority-based: wait for the 2 highest-priority AVAILABLE standbys
     (s1, s2 preferred; s3 promoted into the sync set if one drops).
```

- **`ANY k (...)`** is a genuine quorum: any k confirmations suffice, so any (n−k) standbys can be down and writes still proceed with guaranteed durability on primary + k. This decouples durability from any single named node — the availability fix that plain single-standby sync lacks.
- **`FIRST k (...)`** is priority-based, not a quorum: it always wants the top k available in list order.
- The confirmation level (`remote_write`/`on`/`remote_apply`) still comes from `synchronous_commit`; the quorum clause chooses *which and how many* standbys, the commit level chooses *how far* on each.

The interview point: quorum sync in Postgres is the primary-centric analogue of Dynamo's write quorum W (§71.22), but note the asymmetry — **Postgres reads still go to the primary or to a chosen standby; there is no read quorum.** Postgres gets strong reads from the single leader, not from R+W>N overlap. Do not conflate the two mechanisms.

---

## 71.7 Replication Slots and Cascading Replicas

Two operational features that recur in real deployments.

**Replication slots.** A standby streaming WAL can fall behind or disconnect. If the primary recycles (deletes) a WAL segment the standby hasn't consumed yet, the standby is broken and must be rebuilt. A **replication slot** is server-side state on the primary that records how far a specific consumer has progressed, and *guarantees the primary retains WAL* (and, for logical slots, the relevant system catalog rows) until that consumer has acknowledged it.

```
  Without a slot: primary recycles WAL on its own schedule;
                  a lagging/absent standby can miss segments → broken.
  With a slot:    primary keeps every WAL segment past the slot's
                  restart_lsn → standby can always resume.
                  DANGER: a dead/forgotten slot pins WAL forever →
                  pg_wal fills the disk → primary DOWN.
```

The double-edged nature is a classic gotcha: slots prevent standbys from breaking, but an **abandoned slot** (a consumer that left and never came back) makes the primary retain WAL indefinitely, filling `pg_wal` and eventually taking the *primary* down. `max_slot_wal_keep_size` (PG 13+) caps the damage by invalidating a slot that gets too far behind.

**Cascading replication.** A standby can itself feed *other* standbys, forming a tree rather than a star. The primary streams to a first-tier standby, which re-streams to second-tier standbys, offloading the primary's `walsender` fan-out.

```
        primary
          │
      ┌───┴───┐
   standby   standby ── cascades to ──▶ standby, standby (2nd tier)
```

Cascading reduces load and cross-region bandwidth on the primary (ship once to a regional hub, fan out locally) at the cost of *additional* replication lag: second-tier replicas lag the first tier, which lags the primary. Lag is additive down the tree.

---

## 71.8 Logical Replication and Logical Decoding

Physical replication ships opaque block changes. **Logical replication** ships *row-level change events* — "INSERT into table `orders` these column values," "UPDATE row with PK 42 to …" — decoded from the WAL by **logical decoding**.

```
  WAL (physical records) ──▶ logical decoding plugin (pgoutput)
                              ──▶ stream of logical changes (INSERT/UPDATE/DELETE
                                  with column values, keyed by replica identity)
                              ──▶ subscriber APPLIES them as ordinary SQL
```

Because it operates at the row level, logical replication lifts every rigidity of physical replication:

| | Physical (streaming) | Logical (decoding) |
|---|---|---|
| Unit | WAL block changes | row change events |
| Granularity | whole cluster | selected tables (a **publication**) |
| Cross-version | same major version | across major versions |
| Cross-architecture | no (byte-identical) | yes |
| Subscriber writable? | no (read-only replica) | **yes** (own tables, own indexes) |
| Multi-source into one | no | yes (many publishers → one subscriber) |
| DDL replicated? | yes (it's blocks) | **no** (schema changes not decoded) |

Uses: **major-version upgrades with near-zero downtime** (logically replicate from old to new, then cut over), selective replication of a few tables, consolidating shards into one analytics database, and feeding change-data-capture (CDC) pipelines (Debezium reads the logical decoding stream). The primary limitation to name: **DDL is not replicated** (you must apply schema changes to both sides), and conflict handling is the subscriber's problem, because a logical subscriber is writable and thus effectively a second leader for those rows (§71.2 multi-leader hazards).

Logical decoding requires a **logical replication slot** (§71.7) with `wal_level = logical`, which retains extra information in the WAL so row values can be reconstructed.

---

## 71.9 Read Replicas and Replication Lag

The headline use of replicas is **read scaling**: route read-only queries to hot standbys, reserve the primary for writes. The universal caveat is **replication lag** — a standby's view trails the primary by the time it takes to ship, fsync, and *apply* WAL.

```
  t0  primary commits X = 5   (LSN 1000)
  t0+Δ  X=5 shipped, fsynced on standby   (on / remote_write satisfied)
  t0+Δ' X=5 APPLIED on standby, now visible to reads   (remote_apply)

  A read routed to the standby in [t0, t0+Δ') sees the OLD value X = 4.
  Lag = replay_lag; under load or long recovery conflicts it can be
  seconds to minutes, not milliseconds.
```

Lag has three components, each measurable via LSNs: **send lag** (network), **write/flush lag** (standby I/O), and **replay lag** (apply CPU, plus stalls from **recovery conflicts** — a long read query on the standby can block WAL replay, or be canceled, governed by `max_standby_streaming_delay` and `hot_standby_feedback`). Under a heavy report query, replay lag can balloon.

The anomalies lag produces are the *client-visible* face of weak consistency, and they map one-to-one onto the session guarantees of §71.20:

- **Read-your-writes violation.** You POST an update (to the primary), then GET (routed to a lagging replica) and don't see your own change. The most common real bug in read-replica deployments.
- **Monotonic-reads violation.** Two successive reads hit two replicas with different lag; the second is *older* than the first — time appears to go backwards.
- **Causal violation.** You read a reply before the message it replies to, because they landed on differently-lagged replicas.

The fixes are §71.26: route read-your-writes traffic to the primary or a `remote_apply` standby, pin a session to one replica for monotonic reads, or gate reads on an LSN watermark.

---

## 71.10 Achieving Availability: Harvest and Yield

Availability is not binary. Fox and Brewer's **harvest and yield** reframes a partition or failure as a chance to *degrade gracefully* instead of returning an error.

- **Yield** = the probability that a request completes (roughly, classic availability: fraction of requests answered).
- **Harvest** = the *fraction of the data* reflected in a completed response — completeness/fidelity. Harvest 1.0 = the answer reflects all data; harvest 0.7 = it reflects 70% (some nodes/shards were unreachable and their data was skipped).

The insight: when nodes fail, a system can hold **yield high by lowering harvest** rather than failing outright. A search over 100 shards with 3 unreachable can return the results from 97 shards — a *slightly incomplete* answer, harvest 0.97, yield preserved — instead of a 500 error. Conversely a system can hold **harvest at 1.0 and lower yield**: refuse to answer unless all data is present (this is what a strongly-consistent read does — it would rather fail than return an incomplete/stale answer).

```
   Failure of some replicas/shards ─┬─▶ lower HARVEST, keep YIELD:
                                    │     answer from what's reachable
                                    │     (search, analytics, recommendations)
                                    └─▶ lower YIELD, keep HARVEST:
                                          refuse unless complete/consistent
                                          (financial ledger, inventory)
```

This is the practical, per-request expression of the CAP choice (§71.11): *which* requests can tolerate reduced harvest (return best-effort) versus which must reduce yield (fail closed) is an application decision, not a system-wide one. It also generalizes the "degrade, don't die" principle — the same instinct as returning cached/stale data during a backend outage.

---

## 71.11 The CAP Theorem, Stated Precisely

Now the consistency half. The **CAP theorem** (Brewer's conjecture, proved by Gilbert and Lynch, 2002) is the most cited and most *misquoted* result in distributed systems. State it exactly.

Of these three properties, a distributed data store can guarantee at most two **at the same time**:

- **C — Consistency** (here meaning **linearizability**, §71.17): every read sees the most recent write, as if there were a single copy.
- **A — Availability**: every request to a *non-failed* node receives a (non-error) response, eventually.
- **P — Partition tolerance**: the system keeps working despite the network dropping or delaying arbitrary messages between nodes.

The precise, non-slogan statement — the one that separates a strong answer from folklore:

> **When a network partition occurs, a distributed system must choose between consistency and availability. It cannot have both. When there is no partition, it can have both.**

```
   No partition (normal operation):  you can have BOTH C and A.
   Partition happens:  a node cut off from its peers must choose:
     ┌─ CP: refuse to answer (or answer only on the majority side)   → sacrifice A
     └─ AP: answer from local state, risk returning stale/divergent  → sacrifice C
```

Why P is not really optional: on any real network, partitions *will* happen (a switch reboots, a link saturates, GC pauses a node past its timeout, Ch. 68). You cannot choose to "not tolerate partitions" any more than you can choose for packets never to drop. So CAP is really a **binary choice made only during a partition**: be **CP** (consistent, refuse service on the minority side) or **AP** (available, serve possibly-stale data). "Pick 2 of 3" is a teaching simplification; the honest statement is "P is forced, so pick C or A *when partitioned*."

- **CP systems**: Spanner, CockroachDB, ZooKeeper, etcd, HBase, a single-leader Postgres cluster that refuses stale reads. During a partition the minority side stops serving.
- **AP systems**: Cassandra, Riak, DynamoDB (at low consistency levels), Dynamo. During a partition all sides keep serving and reconcile later (§71.21, §71.24).

---

## 71.12 Using CAP Carefully

CAP is abused constantly. The traps, each of which an interviewer may bait you with:

1. **"You must give up one of the three permanently."** No — the choice between C and A is made *only during a partition*, and only on the affected nodes. A CP system is fully available when the network is healthy; an AP system is fully consistent when there is no divergence. CAP says nothing about the common case.

2. **The C in CAP is linearizability specifically, not "consistency" in general and not the C in ACID.** ACID's C is "transactions preserve invariants" (a single-node integrity property); CAP's C is a *replication* property about seeing the latest write across copies (§71.27). Using one word for both is the field's original sin.

3. **CAP's A is an all-or-nothing definition** ("every request to a live node gets a non-error response"), which is stricter and less useful than real-world availability. A system can be "not A" by CAP's letter (it slows down, or the minority side errors) yet be entirely acceptable in practice. This weakness is exactly what PACELC (§71.13) and harvest/yield (§71.10) were introduced to repair.

4. **CAP ignores latency entirely.** It is a statement about partitions (an infinite-delay message) versus no partition, with nothing in between. But in practice a "slow" replica and a "partitioned" replica are indistinguishable until a timeout fires, and the *latency* cost of consistency during *normal* operation is often the real design driver — which, again, is what PACELC adds.

5. **"NoSQL beat CAP" / "we're AP so we don't need consistency."** No system escapes CAP; AP systems still owe you a consistency model (eventual, causal, session — §71.19–71.21) and usually offer *tunable* consistency per request (§71.22). "AP" is not "anything goes."

The disciplined framing: CAP tells you what happens *at the partition boundary*; it is a corner case, not a design philosophy. Use it to reason about failover and split-brain, and use PACELC for the everyday latency/consistency trade.

---

## 71.13 PACELC

**PACELC** (Abadi, 2012) extends CAP to cover the case CAP ignores — the normal, non-partitioned state — because that is where systems actually spend 99.9% of their time.

> **If** there is a **Partition** (P), choose between **Availability** (A) and **Consistency** (C); **Else** (E), in normal operation, choose between **Latency** (L) and **Consistency** (C).

The "else" clause is the contribution: **even with no partition, there is a standing trade-off between latency and consistency.** To guarantee linearizable reads, a node must coordinate with others (wait for a quorum, contact the leader, verify it is still leader) on *every* operation — that coordination is latency. To be fast, skip the coordination and risk staleness. This trade exists all the time, partition or not.

```
                    Partition?
                   ┌─────┴─────┐
                  yes          no (Else)
                   │            │
              A  vs  C      L  vs  C
           (CAP choice)  (the everyday choice)

  Classified by the pair (partition behavior / normal behavior):
    PA/EL  — Dynamo, Cassandra, Riak, DynamoDB: available under
             partition, low-latency (weak consistency) normally.
    PC/EC  — Spanner, CockroachDB, VoltDB, HBase: consistent under
             partition, consistent (pay latency) normally.
    PA/EC  — rarer; consistent when healthy, available when partitioned.
    PC/EL  — MongoDB (tunable), some configs: consistent under
             partition, but low-latency (weaker) reads normally.
```

The value of PACELC in interviews: it explains why two "AP" databases still differ (Cassandra tuned to `ONE` is PA/EL; tuned to `QUORUM` it shifts toward EC), and it names the *cost of Spanner-style strong consistency* — Spanner is PC/EC, and its `EC` is why every read pays coordination (or a TrueTime commit-wait, Ch. 68 §68.x) even when nothing is wrong. Strong consistency is not free in the common case; PACELC is where that bill is written down.

---

## 71.14 The Shared-Memory Register Model

To reason about consistency precisely, model a distributed store as an *emulation of a single shared register* — a memory cell that supports `read` and `write`. This is deliberately the Ch. 25 hardware mental model lifted one level: there, many cores share one memory and disagree on ordering; here, many nodes emulate one register and disagree on ordering. The vocabulary is identical because the problem is identical.

An execution is a set of operations, each an interval `[invocation, response]` on some client's timeline. Operations on different clients may **overlap** in real time (concurrent) or be **non-overlapping** (one strictly before the other).

```
   client 1:   ├──write(x,1)──┤        ├──read(x)──┤
   client 2:            ├──read(x)──┤
                        └ overlaps write → may see 0 OR 1
   real time ───────────────────────────────────────▶

   The consistency model is the rule for which return values are LEGAL
   given the real-time layout and the program order of the operations.
```

A consistency model is a **contract**: given the operations and their real-time/program-order layout, it specifies the set of *legal* return-value assignments. A **stronger** model permits *fewer* executions (fewer surprises, more coordination); a **weaker** model permits *more* (more anomalies, less coordination, lower latency). The registers come in strengths too — **safe** (a read overlapping a write may return any value), **regular** (returns the old or new value), **atomic/linearizable** (behaves as an indivisible instantaneous operation) — mirroring Lamport's register hierarchy. The rest of the chapter walks this contract from strongest to weakest.

---

## 71.15 The Consistency-Model Hierarchy

Consistency models form a **partial order** (a lattice) from strong to weak. Stronger = closer to "one copy, no anomalies," costlier in coordination and latency. This is the distributed twin of the memory-ordering lattice in Ch. 25 (`seq_cst` ⊃ acquire/release ⊃ relaxed).

```
   STRONGER (more coordination, fewer anomalies, higher latency)
   ▲
   │   Strict consistency          (real-time + instantaneous — unattainable)
   │        │
   │   Linearizability             (real-time order of a single register)   ← CAP's C
   │        │
   │   Sequential consistency      (a global order respecting program order,
   │        │                        but NOT real time)
   │   ┌────┴─────────────┐
   │   Causal consistency  Session guarantees   (causally related ops ordered;
   │        │              (RYW, MR, MW, WFR)     concurrent ops may differ)
   │        └──────┬───────┘
   │   Strong eventual consistency (CRDTs: same updates ⇒ same state, no conflicts)
   │        │
   │   Eventual consistency        (replicas converge... eventually)
   ▼
   WEAKER (less coordination, more anomalies, lower latency)
```

Two families sit side by side rather than strictly stacked: **data-centric** models (linearizability, sequential, causal — properties of the store as seen by *all* clients) and **client-centric / session** models (read-your-writes, monotonic reads, … — properties guaranteed to *one* client's session). Session guarantees are weaker than causal globally but can be layered on top of an eventually-consistent store cheaply, which is why they are the practical sweet spot (§71.20).

---

## 71.16 Strict Consistency

**Strict consistency** is the strongest imaginable model: every read returns the value of the most recent write, where "most recent" is defined by a **single global real-time clock**, instantaneously, with *zero* propagation delay. A write at time t is visible to every node for any read at time t+ε.

Strict consistency is **physically unattainable** in a distributed system, and knowing *why* is the point of introducing it: it requires instantaneous propagation of writes, which violates the speed of light, and a single global clock, which does not exist (clocks skew, Ch. 68 §68.x). It is the idealization that a *single-threaded, single-node* program enjoys for free — reads always see the latest write because there is only one copy and no propagation. The moment there is a network, strict consistency is gone.

Its purpose is as the yardstick: **linearizability is the best *achievable* approximation of strict consistency** — it keeps the real-time ordering guarantee but abandons the fiction of zero propagation delay, allowing an operation to "take effect" at a single point *somewhere within* its interval rather than instantaneously.

---

## 71.17 Linearizability

**Linearizability** (Herlihy & Wing, 1990) is the strongest *achievable* single-object consistency model, and it is exactly the **C in CAP** (§71.11). The definition, which you should be able to state:

> Every operation *appears* to take effect **atomically at a single instant** — its **linearization point** — some time between its invocation and its response, and this instant is **consistent with real time**: if operation A completes before operation B begins (in real, wall-clock time), then A's effect is ordered before B's.

The two clauses do the work: (1) each operation has a single point where it happens (atomicity — no partial visibility), and (2) those points respect **real-time order** for non-overlapping operations. Overlapping (concurrent) operations may be ordered either way, but once a write's response has returned, *every* subsequent read (that starts after that response) must see it or a later value.

```
   client 1:  ├─write(x,1)─┤
   client 2:                    ├─read(x)→ MUST be 1 (or later)─┤
                                 (read STARTS after write's response)

   client 1:  ├─write(x,1)─┤
   client 2:      ├─read(x)→ 0 OR 1, both legal (overlaps the write)─┤

   Linearization points (●) must fall inside each interval and form a
   single sequential order consistent with real time:
     write(x,1)●        read●(=1)
     ─────────────────────────────▶ real time
```

The property that makes linearizability special is **composability (locality)**: a system is linearizable *iff each object individually is* — you can reason object by object. No weaker model composes this way.

**Cost.** Linearizability requires that a read reflect writes that completed anywhere before it started, which forces coordination on *every* operation: contact the leader (and confirm it is still leader), or read from a quorum and repair. Under PACELC it is the `EC` choice — you pay latency for it even with no partition — and under CAP it is the `C` you must surrender during a partition. Systems that provide it: Spanner, CockroachDB, etcd/ZooKeeper (for their consensus-backed operations), a single-leader system that routes *all* reads to the leader. A quorum store is **not** automatically linearizable (§71.25) — R+W>N gives you a recent value, not a real-time-ordered one, without extra machinery (read-repair on the read path, or blocking).

**Linearizability ≈ sequential consistency (§25) of the hardware world's `seq_cst`, plus the real-time constraint.** The analogy to hold: linearizable : distributed store :: `memory_order_seq_cst` : shared memory — the strongest, most intuitive, most expensive option, the one you assume by default and pay for.

---

## 71.18 Sequential Consistency

**Sequential consistency** (Lamport, 1979 — originally a *hardware* memory model, Ch. 25) is one notch weaker than linearizability. The definition:

> There exists a single total order over all operations such that (1) it is consistent with each individual client's **program order**, and (2) every read returns the value of the most recent write *in that total order*. The total order need **not** respect real time.

The single dropped word versus linearizability is **real-time**. Sequential consistency demands a global order that respects each client's own sequence, but it may freely reorder operations *across* clients even if wall-clock time says otherwise. A write by client 1 that finished (in real time) before client 2's read began may nonetheless be ordered *after* it, as long as some consistent global interleaving exists.

```
   client 1:  ├─write(x,1)─┤
   client 2:                    ├─read(x)→ 0 ─┤

   Under LINEARIZABILITY: illegal (read started after write completed → must see 1).
   Under SEQUENTIAL consistency: LEGAL — a valid global order is
        [ read(x)=0 , write(x,1) ] as long as it respects each client's
        own program order. Real time is not binding.
```

The consequences: sequential consistency is **not composable** — two individually sequentially-consistent objects together may not be — and it permits a read to return a "stale" value even after a later write has *completed in real time*, as long as no single client observes the contradiction within its own program order. It is the model most closely matching a naive multithreaded programmer's mental model ("everyone agrees on *an* order, and I see my own operations in order"), which is exactly why Ch. 25's `seq_cst` is the C++ default: intuitive, but it forbids the real-time-based reasoning that linearizability's locality enables. Few distributed stores target sequential-but-not-linearizable as their headline guarantee; it mostly matters as the precise midpoint of the lattice.

---

## 71.19 Causal Consistency and Vector Clocks

**Causal consistency** is the strongest model that stays **available during a partition** (it is achievable in an AP system), which makes it the most important *practical* strong-ish model. The definition:

> Operations that are **causally related** must be seen in the same order by every node. Operations that are **concurrent** (causally independent) may be seen in different orders by different nodes.

"Causally related" is precisely the **happens-before** relation — the *same* relation as Ch. 25's `happens-before`, lifted from threads to nodes. Operation A happens-before B (`A → B`) if: A and B are on the same client and A precedes B (program order); or B reads a value A wrote (read-from); or there is a chain A → C → B (transitivity). If neither `A → B` nor `B → A`, they are **concurrent** (`A ∥ B`).

Causal consistency guarantees the intuitive things — you never see an effect before its cause — without the global-agreement cost of linearizability:

- A reply is never visible before the message it replies to.
- If you write x then write y (having read x), everyone sees x-before-y.
- But two *independent* edits to different keys can be applied in either order on different replicas, and that is *fine* — no one's causality is violated.

**Vector clocks** are the mechanism that detects causality vs concurrency, and are the direct generalization of the single-thread happens-before tracking that ThreadSanitizer does with per-thread vector clocks (Ch. 25 §25.1 — literally the same data structure). A **vector clock** is a map from node id to a counter, one entry per node:

```
   Rules (N nodes → vector of N counters):
     • on a local event/write at node i:  V[i] += 1
     • on send: attach the whole vector to the message
     • on receive of message with vector W: V = elementwise-max(V, W); V[i] += 1

   Comparison of two vectors A, B:
     • A ≤ B  iff  A[k] ≤ B[k] for ALL k     → A happens-before B
     • A < B  (A ≤ B and A ≠ B)              → A causally precedes B
     • neither A ≤ B nor B ≤ A               → A ∥ B  (CONCURRENT — a conflict!)

   Evolution example (nodes A, B, C):
     A writes:        [A:1, B:0, C:0]
     A→B ships it, B writes: max then bump → [A:1, B:1, C:0]   (B's write AFTER A's: A:1<B's A:1... causally later)
     C writes independently: [A:0, B:0, C:1]
       compare [A:1,B:1,C:0] vs [A:0,B:0,C:1]:
         neither ≤ the other  → CONCURRENT → the system must detect
         and resolve the conflict (LWW, merge, sibling, CRDT — §71.24)
```

The single scalar **Lamport clock** (`max(local, received)+1`) is cheaper (one integer) but weaker: it gives a total order consistent with causality (if `A → B` then `L(A) < L(B)`), but the converse fails — `L(A) < L(B)` does **not** imply causality, so a Lamport clock *cannot detect concurrency*. Vector clocks can, at the cost of O(N) space per timestamp (which is why they are pruned/bounded in practice — Riak's dotted version vectors, DynamoDB's approach). Detecting concurrency is the whole point: a concurrent pair is a **conflict** that some resolution policy must handle.

---

## 71.20 Session (Client-Centric) Guarantees

Full causal/linearizable consistency is expensive; **session guarantees** (Terry et al., Bayou) are weaker, *per-client* promises that are cheap to layer on an eventually-consistent store and that eliminate the most jarring anomalies a single user experiences. There are four, and they are a frequent quiz target.

| Guarantee | Promise (within one client session) | Anomaly it prevents |
|---|---|---|
| **Read-your-writes** (read-my-writes) | A read reflects all writes *this session* has done | POST then GET missing your own update |
| **Monotonic reads** | Successive reads never go *backward* in time | Refresh shows older data than before |
| **Monotonic writes** | This session's writes are applied in the order issued | Write B applied before write A you sent first |
| **Writes-follow-reads** (session causality) | A write is ordered after any writes this session *read* | Replying before the message you read exists |

```
   Read-your-writes:  W(x=1) ─── later ── R(x) MUST see 1 (or newer), same session
   Monotonic reads:   R(x)=1 ─── later ── R(x) MUST NOT return an older value
   Monotonic writes:  W(x=1) then W(x=2) ⇒ every replica applies 1 before 2
   Writes-follow-reads: R(y=reply)  then  W(z) ⇒ z ordered after 'reply' everywhere
```

The crucial property: these are **client-centric**, guaranteed only *within one session*, so they are implementable without global coordination — e.g. by pinning a session to one replica (gives monotonic reads and read-your-writes trivially), or by having the client track the LSN/version of what it has written/read and refusing to read from a replica behind that watermark (§71.26). Combining all four session guarantees within a session approximates causal consistency *for that client*, which is why they are the workhorse of real read-replica deployments: you rarely need global causal consistency, you need *your users* not to see time run backwards. The trade is that two *different* clients still get no cross-session ordering guarantee — that is the line between session models and true causal consistency.

---

## 71.21 Eventual Consistency

**Eventual consistency** is the weakest useful model, and the base guarantee of every AP system:

> If no new writes are made, **eventually** all replicas converge to the same value. There is no bound on *when*, and *no guarantee about what is read in the meantime* — reads may return stale values, values may go backwards, concurrent writes may be seen in different orders.

It is a **liveness** guarantee ("something good eventually happens") with essentially *no safety* guarantee about intermediate states. "Eventually" is unbounded — usually milliseconds, but under partition it can be minutes or hours. The two things eventual consistency is silent about, which weaker readers miss:

1. **It does not say replicas will *ever* agree if writes never stop** (there is always new divergence in flight); the promise is conditional on quiescence.
2. **It does not resolve conflicts by itself.** Two concurrent writes to the same key need a resolution rule to converge on *one* value. The default is usually **last-write-wins (LWW)** — keep the write with the highest timestamp — which is simple but **silently discards data** (the loser's write vanishes) and depends on clock synchronization (Ch. 68 §68.x): a skewed clock can make an *older* write win. This LWW data-loss hazard is a classic Cassandra/Dynamo gotcha.

Eventual consistency is what you get from Dynamo/Cassandra at low consistency levels, DNS, and multi-leader replication without conflict handling. Its appeal is pure availability and latency (write to any reachable node, read from any reachable node, never block); its price is that the application must tolerate — or repair — divergence. **Strong eventual consistency** (§71.24) removes the conflict-resolution hazard by construction.

---

## 71.22 Tunable Consistency: Dynamo Quorums

Dynamo-style leaderless systems (Cassandra, Riak, DynamoDB, ScyllaDB) make consistency a **per-operation dial** via three numbers. This is the single most important quantitative result in the chapter — be able to derive it.

- **N** — the **replication factor**: how many replicas store each key.
- **W** — the **write quorum**: how many replicas must acknowledge a write before it is considered successful.
- **R** — the **read quorum**: how many replicas must respond to a read before it returns.

```
   The quorum overlap condition for "strong" (read-latest) behavior:

                 R + W > N

   Why: any set of W writers and any set of R readers, both drawn from
   the same N replicas, MUST share at least one node if R+W>N (pigeonhole).
   That shared node has the latest write → the read sees it.

   N=3 example, W=2, R=2  →  R+W = 4 > 3  ✓ overlap guaranteed
        write goes to ≥2:  ●●○        (nodes 1,2 have new value)
        read queries ≥2:   ○●●        (nodes 2,3 answered)
        node 2 is in both → read observes the latest write.

   Pick the highest version among the R responses (version vectors / timestamps).
```

The quorum equation `R + W > N` is the leaderless analogue of a single leader: the intersection node plays the role the leader plays in ordering. Tuning the three numbers trades read latency, write latency, and consistency:

| Setting (N=3) | R + W > N? | Character |
|---|---|---|
| W=3, R=1 | 4 > 3 ✓ | fast reads, slow/fragile writes (all replicas must ack); good for read-heavy |
| W=1, R=3 | 4 > 3 ✓ | fast writes, slow reads; good for write-heavy |
| W=2, R=2 | 4 > 3 ✓ | balanced; the common "QUORUM" setting |
| W=1, R=1 | 2 > 3 ✗ | pure eventual consistency — fastest, may read stale |
| W=3, R=3 | 6 > 3 ✓ | max overlap, zero fault tolerance for reads or writes |

Cassandra exposes this as per-query **consistency levels** (`ONE`, `QUORUM`, `LOCAL_QUORUM`, `ALL`, `EACH_QUORUM`), DynamoDB as `eventually consistent` vs `strongly consistent` reads. `QUORUM` = ⌈(N+1)/2⌉, so for N=3 it is 2; `QUORUM` reads + `QUORUM` writes satisfy R+W>N. The point interviewers probe: **W>N/2 also guarantees no two write quorums overlap** without an intersection, preventing two concurrent writes from both "winning" on disjoint node sets — write quorum overlap (`W + W > N`) is what serializes writes, read/write overlap (`R + W > N`) is what makes reads see them. `LOCAL_QUORUM` restricts the quorum to the local datacenter, trading cross-region consistency for latency (a PACELC `EL` lean).

---

## 71.23 Sloppy Quorums, Hinted Handoff, and Witness Replicas

The strict quorum of §71.22 fails writes when fewer than W of the *home* replicas are reachable. Dynamo relaxes this to preserve availability, at a cost to the overlap guarantee.

**Sloppy quorum + hinted handoff.** If some of a key's N home replicas are down, the write is accepted by the first W *reachable* nodes in the ring — even nodes that don't normally own the key. The stand-in node stores a **hint** ("this really belongs to node 5") and, when node 5 recovers, performs **hinted handoff**: it forwards the stored write to the rightful owner.

```
   Home replicas for key K: {n1, n2, n3}.  n3 is DOWN, W=3.
   Strict quorum: write FAILS (only n1,n2 reachable).
   Sloppy quorum: write goes to {n1, n2, n7}; n7 holds a HINT for n3.
                  When n3 returns, n7 hands the write off to it.
```

Sloppy quorums keep writes *available* during failures, but they **break the R+W>N guarantee**: the readers query the *home* replicas, which may not overlap the stand-in nodes that took the write, so a read can miss a just-acknowledged write until handoff completes. Sloppy quorum buys availability by *weakening* the consistency the strict quorum promised — a deliberate AP lean.

**Witness / voting replicas.** A **witness replica** participates in the quorum *vote* (counts toward W/R for agreement) but stores **little or no data** (only metadata/version info), or stores it more cheaply. It exists to break ties and maintain quorum availability without paying full storage for another complete copy. Spanner uses witnesses; CockroachDB and some Cassandra deployments use similar "non-voting" or lightweight replicas. The idea: you need an *odd* number of voters to avoid split-brain, but you don't need every voter to hold a full replica — a cheap witness supplies the vote. (This is the storage-cost dual of §71.10's harvest/yield: pay for votes, not for redundant bytes.)

---

## 71.24 Strong Eventual Consistency and CRDTs

Eventual consistency's flaw is that convergence requires a conflict-resolution step that can lose data (§71.21). **Strong eventual consistency (SEC)** fixes this:

> **Strong eventual consistency**: any two replicas that have received the **same set** of updates are in the **same state** — *immediately*, with **no conflict resolution and no consensus**. Convergence is guaranteed by the *structure of the data type*, not by a coordinator.

The data structures that achieve this are **CRDTs — Conflict-free Replicated Data Types** (Shapiro et al.). A CRDT's merge operation is designed so that concurrent updates *always* combine deterministically. The mathematical requirement is that the state forms a **join-semilattice** and the merge is the **least-upper-bound (join)** operation, which is **commutative, associative, and idempotent**:

```
   merge(a, b) = merge(b, a)            (commutative — order of merges irrelevant)
   merge(a, merge(b, c)) = merge(merge(a,b), c)   (associative — grouping irrelevant)
   merge(a, a) = a                      (idempotent — duplicate delivery harmless)

   ⇒ Because messages can be reordered, duplicated, and redelivered
     (Ch. 68), a merge with these three properties ALWAYS converges to
     the same state regardless of delivery order — no coordination needed.
```

Two implementation styles:

- **State-based (CvRDT).** Replicas exchange their *entire state*; the receiver merges via the join. Robust to lost/duplicated messages (idempotent + commutative), but sends the whole state.
- **Operation-based (CmRDT).** Replicas broadcast *operations*; each applies them locally. Cheaper on the wire, but requires the delivery layer to deliver each op exactly once (or ops must themselves be idempotent) and in causal order.

The canonical CRDTs to name:

| CRDT | What it is | Merge / trick |
|---|---|---|
| **G-Counter** | grow-only counter | vector of per-node counts; merge = elementwise max; value = sum |
| **PN-Counter** | increment *and* decrement | two G-Counters (P for +, N for −); value = sum(P) − sum(N) |
| **G-Set** | grow-only set | union (adds only; can't remove) |
| **OR-Set** | observed-remove set | tag each add with a unique id; remove only cancels *observed* adds → add-wins on concurrent add/remove |
| **LWW-Register** | last-write-wins register | keep value with max timestamp (still lossy, but deterministic) |

CRDTs power multi-leader/leaderless stores that must never lose updates: **Riak** data types, **Redis** CRDTs (Active-Active), **Azure Cosmos DB** multi-master, and collaborative editors (**Automerge**, **Yjs** — the "Google Docs" use case). Their limitation: not every problem has a CRDT (anything needing a global invariant like "balance ≥ 0" or "unique username" needs consensus, not a CRDT), and metadata (tags, tombstones) can grow. But where they fit, they give the holy grail — **availability *and* convergence with no coordination** — by moving the hard part into the algebra of the datatype.

---

## 71.25 Quorum Overlap Math and Its Limits

Return to `R + W > N` and state precisely what it *does not* buy, because over-claiming for quorums is a classic trap.

What overlap **guarantees**: a read quorum and a write quorum share ≥1 node, so a read *can see* the latest completed write (the shared node holds it, and the reader picks the highest version among responses). What it **does not** guarantee:

1. **Not linearizability, by itself.** Overlap ensures a read *observes* a value at least as new as the last *completed* write — but writes *in flight* (not yet reaching W replicas) create a window where two overlapping reads can see *different* values, and a later read can even see an *older* value than an earlier one (a monotonic-read violation). Without **read-repair on the read path** (writing the newest value back to lagging replicas before returning) or blocking, a bare quorum is *not* linearizable. Dynamo-style stores add read-repair (Ch. 72) precisely to tighten this.

2. **No isolation, no atomicity across keys.** A quorum is a *per-key* mechanism. It says nothing about multi-key transactions: two keys each read at quorum can reflect *different* points in time. There are no ACID transactions, no serializability (Ch. 65) from quorums alone — isolation is a different axis entirely (§71.27).

3. **Partial writes are visible.** A write that reaches some but not W replicas is neither committed nor rolled back — there is no atomic commit across the replicas. A later read may or may not see it, and it is not cleanly undone. (Full atomic commit needs consensus — Paxos/Raft — as in Spanner/CockroachDB.)

4. **Sloppy quorums void even the overlap** (§71.23).

```
   What R+W>N gives:   a read sees the latest COMPLETED write (one key).
   What it does NOT give:
      • real-time ordering across reads  → not linearizable w/o read-repair
      • ordering/atomicity across keys   → no transactions, no isolation
      • clean commit/abort of a write    → partial writes linger
```

The disciplined statement: **quorums give you tunable, per-key *recency*, not consistency in the transactional sense.** For linearizability you add read-repair/blocking or a leader; for cross-key isolation you add a transaction protocol (consensus + 2PC, Ch. 74). Strong-consistency systems (Spanner, CockroachDB) *do* provide both, but they do it with **consensus (Paxos/Raft) per shard plus a global timestamp/2PC**, not with bare Dynamo quorums — which is the architectural fork between the AP quorum world and the CP consensus world.

---

## 71.26 Replication Lag Anomalies and How Session Guarantees Fix Them

Tie the mechanism (Postgres lag, §71.9) to the theory (session guarantees, §71.20) — the payoff section for a read-replica deployment.

Every lag anomaly of §71.9 is a *named* session-guarantee violation, with a concrete fix:

| Anomaly (from lag) | Violated guarantee | Fix |
|---|---|---|
| POST then GET misses your write | read-your-writes | route the read to the primary, or to a `remote_apply` standby, or gate on LSN |
| Refresh shows older data | monotonic reads | pin the session to one replica (sticky routing) |
| See reply before message | writes-follow-reads / causal | LSN/version watermark carried by the client |
| Two writes reorder | monotonic writes | route a session's writes through one path/order |

Concrete Postgres tactics:

- **`synchronous_commit = remote_apply`** for the writing transaction guarantees the chosen standby has *applied* (not merely fsynced) the change before `COMMIT` returns, so an immediately following read on that standby sees it — a server-side read-your-writes for that replica (at the cost of the slowest apply, §71.5).
- **LSN watermarking.** After a write, the client reads the commit LSN (`pg_current_wal_lsn()` on the primary). Before reading from a replica, it checks `pg_last_wal_replay_lsn()` and only uses the replica if `replay_lsn ≥ watermark`; otherwise it waits, retries another replica, or falls back to the primary. This implements read-your-writes and causal reads *across* replicas without forcing synchronous replication globally — you pay only when a session actually needs its own write.
- **Sticky sessions** (route a client to the same replica for its session) trivially give monotonic reads and read-your-writes *for that replica*, at the cost of losing that replica's load-balancing benefit and breaking on replica failover.

The overarching lesson: **you rarely need global strong consistency; you need a specific client not to observe an anomaly.** Session guarantees are the cheap, targeted tool — pay for consistency per session, per operation, exactly where a user would notice, and let everything else run at eventual-consistency speed. This is the same "pay for ordering only where you need it" discipline as choosing `memory_order_relaxed` by default and `acquire/release` only on the synchronizing accesses (Ch. 25).

---

## 71.27 Isolation vs Consistency: Two Different Axes

The final and most-confused distinction, and a favorite senior-level probe: **ACID isolation (Ch. 65) and distributed consistency models are orthogonal axes, and the word "consistency" means different things in each.**

```
   AXIS 1 — ISOLATION (ACID, Ch. 65):  how CONCURRENT TRANSACTIONS interleave
      about: dirty reads, non-repeatable reads, phantoms, write skew
      levels: read-uncommitted → read-committed → repeatable-read → serializable
      question: "can transaction T see T2's uncommitted / partial effects?"
      a SINGLE-NODE property (MVCC, locks) — exists with zero replication.

   AXIS 2 — CONSISTENCY (replication, this chapter):  how COPIES agree on VALUES
      about: staleness, real-time order, causality, convergence
      levels: eventual → causal → sequential → linearizable
      question: "does my read reflect writes that happened on other nodes?"
      a REPLICATION property — exists with zero transactions (a single register).

   The three "C" words:
     • ACID's C  = a transaction preserves invariants (integrity constraints).
     • CAP's C   = LINEARIZABILITY (a replication/recency property).
     • "consistency model" = the AXIS-2 hierarchy above.
   All three are DIFFERENT. Conflating them is the field's most common error.
```

Why they are independent: you can have **serializable isolation but stale reads** (a single-leader Postgres with async replicas: transactions on the primary are perfectly serializable, yet a read replica is not linearizable — it lags). You can have **linearizable single-object reads but no isolation** (a Dynamo quorum with read-repair gives per-key recency but zero multi-key transactions). The two dials are set separately.

The model that unifies them — **strict serializability** (a.k.a. external consistency, one-copy serializability) — is *both* serializable *and* linearizable: transactions appear to execute in a single serial order that is *also* consistent with real time. That is the gold standard Spanner and CockroachDB target, and it requires *both* a transaction protocol (serializability) *and* a real-time-respecting timestamp mechanism (linearizability — Spanner's TrueTime, Ch. 68 §68.x). It is expensive precisely because it must satisfy both axes at once; most systems deliberately relax one.

The interview-ready statement: **"consistency" is overloaded — in ACID it is invariant preservation, in CAP it is linearizability, and as a "consistency model" it is the staleness/ordering hierarchy. Isolation is about transaction interleaving on one logical copy; consistency (the CAP sense) is about agreement across physical copies. A system chooses a level on each axis independently, and only strict serializability maxes out both.**

---

## 71.28 Read Repair and Anti-Entropy

A leaderless store's replicas drift apart — dropped writes, sloppy-quorum stand-ins, nodes down during a write. Two background mechanisms pull them back together; both are developed in detail in Ch. 72, but name them here because they are what makes a bare quorum (§71.25) approach the consistency it promises.

**Read repair** happens on the *read* path. When a read contacts R replicas and they return *different* versions (detected by comparing timestamps or version vectors), the coordinator returns the newest to the client *and* writes it back to the stale replicas, repairing them lazily.

```
   read(key) → coordinator queries R=3 replicas:
       n1: v=5 (ts 100)   n2: v=5 (ts 100)   n3: v=4 (ts 80)  ← stale
   coordinator: return v=5 to client, and WRITE v=5 back to n3 (repair)
```

Read repair fixes *frequently read* keys cheaply (the read traffic pays for it) but never touches keys nobody reads — so it is necessary but not sufficient.

**Anti-entropy** is the background sweep that repairs *everything*, read or not. Replicas periodically compare their full datasets and exchange differences. Doing this naively means shipping whole datasets; the efficient mechanism is a **Merkle tree** (a hash tree over key ranges): two replicas compare root hashes, and only where hashes differ do they descend and exchange the differing ranges — O(differences), not O(dataset). Cassandra's `nodetool repair` and Dynamo/Riak anti-entropy both use Merkle trees.

The division of labor: **read repair keeps hot data consistent in the foreground; anti-entropy guarantees *all* data eventually converges in the background.** Together they are the machinery behind "eventual" in eventual consistency — without them, a dropped write on a rarely-read key could diverge forever. The full treatment (hint replay, Merkle-tree construction, repair scheduling, gossip) is Ch. 72.

---

## 71.29 Leader Failover and Split-Brain

Single-leader replication's Achilles' heel is the moment the leader dies: no node accepts writes until a new leader is chosen, and choosing wrong corrupts data. **Failover** is that promotion process, and it is where the CAP choice (§71.11) becomes operationally concrete.

The steps, each with a failure mode:

1. **Detect** the leader is dead — usually a timeout (no heartbeat for T seconds). But a timeout cannot distinguish a *dead* leader from a *slow* or *network-partitioned* one (Ch. 68 §68.x). Too short → false failovers on a GC pause; too long → extended write outage.
2. **Choose** a new leader — the most up-to-date replica (highest LSN/replay position), ideally via a consensus protocol (Raft/Paxos, Ch. 74) so all survivors agree on exactly one.
3. **Reconfigure** — clients and remaining replicas must start following the new leader; the old leader, if it returns, must step down.

The catastrophic failure is **split-brain**: two nodes both believe they are leader (a partition isolated the old leader, which kept accepting writes, while the majority side promoted a new one). Now there are two divergent write histories, and merging them means *losing* one side's acknowledged writes.

```
   Partition:  [ old leader | ... ] ══╳══ [ ... | new leader ]
                   still accepts writes      promoted, accepts writes
                   (minority side)           (majority side)
   → two divergent histories → data loss on heal.  This is SPLIT-BRAIN.
```

The defenses, all interview-relevant:

- **Quorum/majority for promotion.** Only the side holding a *majority* of nodes may elect a leader; the minority side (including a partitioned old leader) must refuse writes. This is the CP choice — the minority sacrifices availability to prevent split-brain. Consensus protocols (Raft) build this in: a leader needs a majority to commit.
- **Fencing (STONITH — "shoot the other node in the head").** Forcibly power off or network-isolate the old leader before promoting, so it *cannot* keep serving. A **fencing token** (a monotonically increasing epoch number attached to every write) lets storage reject writes from a deposed leader carrying a stale token.
- **Async replication makes failover *lossy*.** If the old leader had acknowledged writes not yet shipped (§71.3), promoting a replica silently drops them (the RPO window). Synchronous/quorum replication (§71.6) shrinks or closes this.

The through-line: failover is where "choose C or A during a partition" stops being theory. A CP system (etcd, Spanner, a properly-fenced Postgres+Patroni cluster) refuses writes on the minority side and never splits its brain; an AP system keeps both sides writing and reconciles later (§71.24). Choosing consistency here means accepting a write outage during the election; choosing availability means accepting divergence you must merge.

---

## Summary

- **Replication** buys availability, read scaling, geo-locality, and durability; its only hard problem is keeping copies consistent while nodes and the network fail. It does not scale *writes* (that is partitioning, Ch. 73).
- **Topologies**: single-leader (one write order → strong consistency achievable, leader is the write bottleneck and failover point), multi-leader (no bottleneck but conflicts), leaderless/Dynamo (quorum overlap, availability-first).
- **Sync vs async** sets the durability/latency trade: async acks locally (fast, data-loss window on failover), sync waits for replicas (RPO 0, higher latency, write-availability dependency), semi-sync is the middle. Postgres exposes it as `synchronous_commit` = off/local/remote_write/on/remote_apply, and quorum sync via `ANY k (...)`.
- **Postgres streaming replication** ships physical WAL (LSN-addressed) to hot standbys; **logical replication** decodes row-level changes for selective, cross-version, writable, multi-source replication. **Replication slots** retain WAL for consumers (and can fill the disk if abandoned); **read replicas** lag, producing read-your-writes / monotonic-read anomalies.
- **CAP**: during a partition, choose consistency (CP, refuse) or availability (AP, serve stale); it says *nothing* when there is no partition, and its C is **linearizability**, not ACID's C. **PACELC** adds the everyday trade: Else, Latency vs Consistency — strong consistency costs coordination even with no partition.
- The **consistency lattice** from strong to weak: strict (unattainable) → linearizable (real-time single-register order, CAP's C) → sequential (program order, no real time) → causal (happens-before ordered, concurrent ops free; detected by **vector clocks**) → session guarantees → strong-eventual (CRDTs) → eventual.
- **Tunable quorums**: `R + W > N` guarantees read/write overlap so a read sees the latest *completed* write per key — but not linearizability (without read-repair), not isolation, not cross-key atomicity. **Sloppy quorums** trade the overlap for availability; **CRDTs** give convergence with no coordination via commutative/associative/idempotent merges (join-semilattice).
- **Isolation ≠ consistency**: isolation (ACID, Ch. 65) is single-node transaction interleaving; consistency (this chapter) is cross-copy agreement. Only **strict serializability** (Spanner, CockroachDB) maxes out both axes.

---

## Key Interview Questions

1. **What are the four reasons to replicate, and which one does replication *not* help?** — Availability, read scaling, geographic locality, and durability. It does *not* scale writes: every replica must apply every write, so write throughput is bounded by the slowest required set. Scaling writes needs partitioning (Ch. 73).
2. **What is the single hard problem of replication?** — Keeping the copies consistent while messages are delayed, reordered, duplicated, or dropped and nodes fail. Copying bytes is trivial; agreeing on the current value under failure is the entire discipline, and every consistency model is a different answer to "how much may copies disagree, and for how long?"
3. **Compare single-leader, multi-leader, and leaderless replication.** — Single-leader: one node orders all writes (strong consistency achievable, but it is the write bottleneck and needs failover). Multi-leader: several accept writes and can conflict, needing resolution. Leaderless (Dynamo): writes/reads hit several replicas, consistency comes from quorum overlap and is client-tunable, no leader to fail over.
4. **Synchronous vs asynchronous replication — what is the trade?** — Async acks the client once the leader is locally durable, then ships in the background: low latency but a data-loss window if the leader dies before shipping. Sync waits for replica(s) to confirm: zero data loss (RPO 0) but write latency ≥ replica RTT and writes stall if the synced replica is down. Semi-sync (one sync replica, rest async) is the middle.
5. **What does PostgreSQL stream in physical replication, and how is progress measured?** — The write-ahead log (WAL), byte-for-byte, from a `walsender` on the primary to a `walreceiver`+startup process on the standby, which replays it. Progress is measured in LSNs (Log Sequence Numbers); replication lag is primary LSN minus standby `replay_lsn`, exposed in `pg_stat_replication`.
6. **Explain the five `synchronous_commit` levels.** — `off`: local WAL buffered, not fsynced (async even locally). `local`: local fsync, no wait for standbys. `remote_write`: standby has written WAL to its OS. `on` (default): standby has fsynced WAL. `remote_apply`: standby has *applied* the WAL, so reads there see the commit. It is per-transaction.
7. **Which `synchronous_commit` level gives read-your-writes on a read replica, and why?** — Only `remote_apply`. `on` guarantees the WAL is fsynced on the standby but not yet applied to its pages, so a read routed there immediately after commit can still miss the write. `remote_apply` waits for the standby to replay it, making it visible — at the cost of the slowest apply.
8. **What is quorum synchronous replication in Postgres, and how does it differ from Dynamo quorums?** — `synchronous_standby_names = 'ANY k (...)'` waits for any k of the named standbys, so up to (n−k) can be down without stalling writes, each commit durable on primary+k. Unlike Dynamo, there is **no read quorum**: Postgres reads go to the primary or a chosen standby, getting strong reads from the single leader, not from R+W>N overlap.
9. **What is a replication slot, and what is its danger?** — Server-side state on the primary that records a consumer's progress and forces the primary to retain WAL (and catalog rows, for logical slots) until acknowledged, so a lagging standby never misses recycled segments. Danger: an abandoned slot pins WAL forever, filling `pg_wal` and taking the *primary* down; `max_slot_wal_keep_size` caps it.
10. **Physical vs logical replication in Postgres?** — Physical ships opaque WAL block changes: whole cluster, same major version/architecture, read-only standby. Logical decodes row-level change events: selective tables, cross-version, cross-architecture, writable subscriber, multi-source — used for near-zero-downtime upgrades and CDC. Logical does not replicate DDL.
11. **What is replication lag and what anomalies does it cause?** — A standby's view trails the primary by the send + flush + replay time. It causes read-your-writes violations (miss your own update), monotonic-read violations (successive reads go backward), and causal violations (see a reply before its message) when reads hit differently-lagged replicas.
12. **What is harvest and yield?** — Yield is the probability a request completes (availability); harvest is the fraction of the data reflected in the response (completeness). Under failure a system can keep yield high by lowering harvest (answer from reachable shards, e.g. search) or keep harvest at 1.0 by lowering yield (refuse unless complete, e.g. a ledger). It is the per-request expression of the CAP choice.
13. **State the CAP theorem precisely.** — During a network partition, a distributed store must choose between consistency (linearizability) and availability; it cannot have both. When there is no partition, it can have both. Since partitions are unavoidable on real networks, CAP is a binary choice — CP (refuse on the minority side) or AP (serve possibly-stale data) — made *only during a partition*.
14. **What are the most common CAP misinterpretations?** — That you permanently give up one of three (the C/A choice is only during a partition); that CAP's C is general "consistency" (it is linearizability specifically, not ACID's C); that CAP's strict all-or-nothing A matches real availability; that CAP addresses latency (it does not — PACELC does); and that "we're AP" means no consistency model is owed.
15. **What does PACELC add to CAP?** — The "else" clause: if Partitioned, choose A or C; Else (normal operation) choose Latency or Consistency. It captures that strong consistency costs coordination *even with no partition*. Cassandra is PA/EL; Spanner/CockroachDB are PC/EC — their EC is why every read pays coordination when nothing is wrong.
16. **Define linearizability.** — Every operation appears to take effect atomically at a single instant (its linearization point) between its invocation and response, and those instants respect real time: if A completes before B begins, A is ordered before B. It is CAP's C, the strongest *achievable* model, and it composes (a system is linearizable iff each object is).
17. **Linearizability vs sequential consistency?** — Both require a single global order respecting each client's program order. Linearizability *also* requires that order respect real time (a write that completed before a read began must be visible). Sequential consistency drops the real-time constraint, so a completed write may be ordered after a later read. Linearizability composes; sequential consistency does not.
18. **Why is strict consistency unattainable?** — It requires instantaneous propagation of every write (violating the speed of light) and a single global real-time clock (which does not exist — clocks skew). It is the free property of a single-node program. Linearizability is the best achievable approximation: it keeps real-time ordering but lets an operation take effect at a point within its interval rather than instantaneously.
19. **What is causal consistency, and why is it important?** — Causally related (happens-before) operations are seen in the same order by every node; concurrent operations may be seen in different orders. It is the strongest model that stays available during a partition, so it is the practical strong-ish ceiling for AP systems — you never see an effect before its cause, without paying linearizability's global-agreement cost.
20. **How do vector clocks detect concurrency?** — Each node keeps a vector of per-node counters, bumping its own on each event and taking elementwise max on receive. For two vectors, if one is ≤ the other elementwise they are causally ordered; if neither is ≤ the other they are concurrent — a conflict. It is the same structure ThreadSanitizer uses for happens-before (Ch. 25).
21. **Why can't a scalar Lamport clock detect concurrency?** — A Lamport clock gives a total order consistent with causality (A → B implies L(A) < L(B)), but the converse fails: L(A) < L(B) does not imply A → B. So it cannot tell whether two operations are causally ordered or concurrent. Vector clocks can, at O(N) space per timestamp.
22. **Name and define the four session guarantees.** — Read-your-writes (a read reflects this session's writes), monotonic reads (reads never go backward), monotonic writes (a session's writes apply in issue order), writes-follow-reads (a write is ordered after writes this session read). They are per-session, so implementable without global coordination, and together approximate causal consistency for one client.
23. **What is eventual consistency, and what are its two silent assumptions?** — If writes stop, replicas eventually converge; nothing is promised about reads in the meantime. It is silent that replicas ever agree while writes continue (convergence is conditional on quiescence), and it does not resolve conflicts by itself — the usual default, last-write-wins, silently discards the losing write and depends on clock sync.
24. **Derive the quorum condition R + W > N.** — With N replicas per key, a write quorum of W and a read quorum of R must share at least one node whenever R + W > N (pigeonhole), and that shared node holds the latest completed write, so the read sees it (picking the highest version among R responses). W=2, R=2, N=3 gives 4 > 3.
25. **What does R + W > N *not* guarantee?** — Not linearizability by itself (in-flight writes let overlapping reads diverge and reads go backward without read-repair); no isolation or cross-key atomicity (it is per-key, so two keys can reflect different times, no transactions); and partial writes linger (no atomic commit). Quorums give per-key recency, not transactional consistency.
26. **What are sloppy quorums and hinted handoff?** — When fewer than W home replicas are reachable, a sloppy quorum accepts the write on the first W *reachable* nodes; a stand-in stores a hint and forwards it (hinted handoff) when the rightful owner recovers. It keeps writes available during failures but breaks R+W>N (readers may query home replicas that lack the write) — an AP lean.
27. **What is a witness replica?** — A replica that votes in the quorum (counts toward agreement/availability) but stores little or no data — only metadata/version info. It supplies the odd vote needed to avoid split-brain without paying full storage for another complete copy, used by Spanner and CockroachDB-style systems.
28. **What is strong eventual consistency, and how do CRDTs achieve it?** — SEC: any two replicas that received the same set of updates are in the same state immediately, with no conflict resolution or consensus. CRDTs achieve it by making merge a join-semilattice least-upper-bound that is commutative, associative, and idempotent, so reordered/duplicated/redelivered messages always converge to the same state.
29. **Give examples of CRDTs.** — G-Counter (per-node counts, merge = elementwise max, value = sum); PN-Counter (two G-Counters for + and −); G-Set (union, adds only); OR-Set (tag adds with unique ids so remove cancels only observed adds — add-wins); LWW-Register (keep max-timestamp value). Used in Riak, Redis Active-Active, Cosmos DB, and collaborative editors (Automerge, Yjs).
30. **How do session guarantees fix read-replica lag anomalies concretely in Postgres?** — Read-your-writes: route to the primary or a `remote_apply` standby, or gate reads on a commit-LSN watermark (read a replica only if its `replay_lsn` ≥ the write's LSN). Monotonic reads: pin the session to one replica. This pays for consistency only per session where a user would notice, not globally.
31. **Isolation vs consistency — are they the same axis?** — No. Isolation (ACID, Ch. 65) governs how concurrent transactions interleave on one logical copy (dirty reads, phantoms, serializability). Consistency (this chapter) governs how physical copies agree on values (staleness, causality, linearizability). You can have serializable isolation with stale reads, or linearizable per-key reads with no isolation.
32. **What do the three "C" words mean?** — ACID's C: a transaction preserves invariants/integrity constraints (single-node). CAP's C: linearizability (a cross-copy recency property). "Consistency model": the eventual→causal→sequential→linearizable staleness/ordering hierarchy. All three differ; conflating them is the field's most common error.
33. **What is strict serializability, and what does it require?** — Both serializable *and* linearizable: transactions appear in a single serial order that also respects real time. It maxes out both the isolation and consistency axes, so it needs a transaction protocol (consensus + 2PC) *and* a real-time timestamp mechanism (e.g. Spanner's TrueTime). It is the gold standard of Spanner and CockroachDB, and expensive for exactly that reason.
34. **How does Postgres quorum sync relate to the CAP/durability trade?** — `ANY k` makes a commit durable on primary + k of n standbys, surviving loss of any (n−k) without stalling writes (availability for writes) while guaranteeing RPO 0 for a single failure. It is primary-centric CP-leaning durability; it does not provide leaderless read quorums, so read staleness on async standbys is a separate concern handled by routing or LSN gating.

---

## Common Traps

- **Saying CAP means "pick 2 of 3" permanently.** The C/A choice is made *only during a partition*, and P is not optional on a real network; when healthy you get both C and A.
- **Treating CAP's C, ACID's C, and "consistency model" as the same thing.** CAP's C is linearizability, ACID's C is invariant preservation, and the consistency model is the staleness hierarchy — three different concepts sharing one word.
- **Claiming R + W > N gives linearizability.** It gives per-key recency (a read sees the latest *completed* write), but without read-repair or blocking it is not linearizable, and it never provides cross-key isolation or atomic commit.
- **Forgetting that sloppy quorums break the R+W>N overlap.** Accepting writes on stand-in nodes for availability means readers querying home replicas can miss a just-acknowledged write until hinted handoff completes.
- **Assuming `synchronous_commit = on` makes a read replica show your write.** `on` only fsyncs the WAL on the standby; it is not yet *applied*. Only `remote_apply` makes the commit visible to reads there.
- **Thinking async replication is "safe" because the primary fsynced.** If the primary dies before shipping the write, an acknowledged-but-unshipped write is lost on failover — that is the async RPO window.
- **Believing last-write-wins loses no data.** LWW silently discards the losing concurrent write and depends on clock sync; a skewed clock can make an older write win. Use vector clocks/CRDTs when updates must not vanish.
- **Confusing a Lamport clock with a vector clock.** A scalar Lamport clock cannot detect concurrency (L(A)<L(B) does not imply causality); only vector clocks distinguish causal from concurrent, at O(N) space.
- **Leaving a replication slot abandoned.** A dead consumer's slot pins WAL forever, fills `pg_wal`, and takes the primary down — cap it with `max_slot_wal_keep_size`.
- **Thinking causal consistency requires a leader or blocks under partition.** Causal is the strongest model that stays *available* during a partition; concurrent ops may be ordered differently on different nodes, which is exactly what avoids the coordination.
- **Assuming linearizability is free when there is no partition.** Under PACELC it is the `EC` choice — every operation pays coordination (leader confirmation or quorum + repair, or a TrueTime commit-wait) even in perfect health.
- **Conflating isolation levels with consistency models.** Serializable isolation on a single leader still gives *stale* (non-linearizable) reads on async replicas; the two axes are set independently, and only strict serializability maxes out both.
- **Expecting CRDTs to solve every conflict.** They converge without coordination only for datatypes whose merge is commutative/associative/idempotent; global invariants like "balance ≥ 0" or "unique username" still need consensus.
- **Saying witness replicas improve read throughput.** A witness supplies a *vote* to preserve quorum/avoid split-brain while storing little or no data — it is a cost optimization for agreement, not an extra full copy to read from.
