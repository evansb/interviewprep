# Chapter 71 — Replication and Consistency

Replication creates several physical copies of one logical service. That sounds like copying, but the hard questions are about order:

- Which operations belong in the replicated history?
- When may the system acknowledge an operation?
- Which copy may answer a read?
- What happens when copies cannot communicate?
- Which state may become authoritative after failover?

A replica can have received a write without making it durable, and can have made it durable without applying it. A client can receive success before every replica knows the write. Consistency models specify which observable histories are legal; replication protocols produce those histories under stated assumptions.

> **Optional-track contract.** The Core path ends at §71.16. The PostgreSQL 18 material beginning at §71.17 is a skippable implementation and operations reference.

## 71.1 The 90-Second Screen — Core

If you remember only one page, remember this:

- Replicate for fault tolerance, read locality/throughput, geographic placement, or recovery options. Replication does not automatically improve write throughput, availability, or correctness.
- A common pipeline is **snapshot/state transfer + ordered log tail**. A new replica must install a consistent snapshot and then apply every required log entry after the snapshot position.
- Single-leader replication gives one proposed write order. Multi-leader and leaderless designs can accept concurrent writes and therefore need conflict detection, ordering, or merge rules.
- “Synchronous” is incomplete. Name the acknowledgement point: received, written to an OS, durably flushed, applied, or visible.
- **Linearizability** gives each operation one point between invocation and response and respects real-time precedence. **Sequential consistency** preserves each client's program order but not cross-client real time. **Causal consistency** preserves cause before effect while allowing concurrent operations to be ordered differently. **Eventual consistency** promises convergence only under its delivery/quiescence assumptions.
- Session guarantees—read-your-writes, monotonic reads, monotonic writes, and writes-follow-reads—repair specific client experiences without promising a global total order.
- A vector clock can distinguish “causally before” from “concurrent.” A Lamport scalar cannot infer concurrency from its order alone.
- `R + W > N` proves set intersection. It does **not**, by itself, prove that a read returns the latest value or that the register is linearizable.
- Failover safety needs both data freshness and authority. A fully caught-up old leader is still unsafe if it is not fenced; a newly elected but stale replica can lose acknowledged writes.
- CAP is a theorem about a particular asynchronous model, linearizable read/write objects, availability, and partitions. It is not “pick any two,” a normal-operation latency rule, or a product taxonomy.

```text
write path

client → accept/order → append → durable → replicate → remote durable → apply
           protocol       log      point      bytes       point          state
              │                                                       │
              └──────────── acknowledgement may be here ─────────────┘

read path

client → choose replica → wait for required watermark/order → read visible state
```

### Claim labels

- **[Theorem]** A formal result under named assumptions.
- **[Protocol]** A mechanism whose guarantee follows only when all stated steps hold.
- **[Product/version]** Behavior tied to an implementation, release, configuration, or platform.
- **[PostgreSQL 18]** Behavior documented for PostgreSQL 18; verify the deployed release.
- **[Measured]** A performance or availability result to establish on the target system.

**Core path begins here.**

---

## 71.2 Why Replicate?

Replication can serve several goals:

| Goal | What another copy can provide | What it does not prove |
|---|---|---|
| fault tolerance | service after a node or device fails | safe automatic promotion |
| durability | survival of selected failure domains | independence if copies share power, software, or credentials |
| read scale | more read-serving capacity | fresh or monotonic reads |
| locality | lower latency near readers | low-latency globally ordered writes |
| maintenance | switchover, upgrade, backup source | zero-risk operations |

Every added copy also adds:

- propagation bandwidth and storage;
- lag and additional failure states;
- configuration and upgrade compatibility;
- the possibility of stale reads or conflicting writes;
- a larger security and operational surface.

Replica count alone proves no availability: copies can share rack, software, credentials, or automation failure domains. Replication is not backup; deletion or corruption can replicate faithfully.

Safe replica routing can raise read throughput. Required log processing and synchronous acknowledgement can reduce write throughput. Multi-leader or sharding moves admission work but adds conflict or transaction costs. Sharding is Chapter 73.

## 71.3 Replicas, Logs, and State Transfer

The most reusable model is a replicated deterministic state machine:

```text
state S0
  apply entry 41 → S41
  apply entry 42 → S42
  apply entry 43 → S43
```

If two replicas start from equivalent state and apply the same deterministic entries exactly once in the same logical order, they reach equivalent state. Real systems must handle duplicates, crashes during apply, nondeterminism, schema versions, and side effects, so “replay the log” is a contract, not an implementation detail.

### Progress positions

A replica can report several positions:

| Position | Meaning | Survives process crash? | Visible to reads? |
|---|---|---:|---:|
| received | bytes arrived in memory | not necessarily | no |
| written | OS accepted bytes | maybe process crash; not necessarily OS/power loss | no |
| flushed | storage contract says log prefix durable | yes for covered failures | no |
| applied | state machine replayed prefix | depends on local recovery design | usually eligible |
| visible | reader's snapshot/routing can observe it | not a durability claim | yes |

These are logical categories. Exact I/O semantics are **[Product/version]**. A remote “ACK” is meaningless until its stage and failure model are named.

### Bootstrapping a replica

Copying a live database while writes continue can combine pages from different moments. The usual solution is a consistent state transfer plus a log position:

1. create or identify a snapshot/checkpoint representing log position `s`;
2. transfer and validate the snapshot;
3. retain the log from `s` onward;
4. replay entries after `s` in protocol order;
5. verify identity, schema/protocol compatibility, and checksums;
6. admit the replica to reads, voting, or promotion only after its required readiness test.

```text
leader log:      ... 100 101 102 103 104 105 ...
snapshot covers: --------^
replica install: [ state through 101 ]
catch-up:                    102 103 104 105
```

The invariant is:

```text
installed state = snapshot(s) + every required entry in (s, applied_position]
```

A gap silently corrupts the logical history; a duplicate must be detected or idempotent. Retention must cover the entire catch-up interval. Chapter 72 studies how divergent replicas discover and repair missing state after ordinary propagation fails.

## 71.4 Replication Topologies

Topology answers who can accept writes and how orders are formed.

### Single leader

```text
             ordered log
clients → leader ─────────→ follower A
                └────────→ follower B
```

One leader accepts writes for a key, partition, or database and proposes a single log order. Followers replay it. This simplifies conflict handling, but not authority: after a partition, an old leader must be prevented from continuing to commit.

A single-leader topology does not itself imply linearizable reads. A follower can be stale; even a leader may serve an unsafe read if leadership is not current. The read protocol must establish authority and freshness.

### Multi-leader

```text
clients → leader A ⇄ leader B ← clients
                  conflicts
```

Several leaders accept writes, often in different regions or disconnected environments. Concurrent writes to the same logical object require a policy:

- reject one after coordination;
- choose one by a deterministic order;
- preserve siblings for application resolution;
- merge through a datatype whose operations converge.

Multi-leader does not inherently increase total useful write throughput: hot keys, cross-region constraints, indexes, and reconciliation can dominate. Its core benefit is local write admission under selected failures, paid for with conflict semantics.

### Leaderless

```text
          ┌→ replica A
client ───┼→ replica B
          └→ replica C
```

A coordinator contacts a replica set and completes after a configured number of responses. Replica versions may diverge. Reads compare returned versions and may reconcile them.

“Leaderless” does not mean “no coordination” or “no primary concept anywhere.” Membership, placement, per-request coordinators, repair, and reconfiguration still need protocols. “Tunable consistency” is product shorthand for choosing response counts or read protocols per operation; those knobs are not consistency proofs by themselves.

### Topology is not a guarantee

| Topology | Natural ordering point | Main failure question | Needed proof |
|---|---|---|---|
| single leader | leader log | can two leaders commit? | election/fencing plus commit durability |
| multi-leader | per-leader order | how are concurrent writes represented? | detection/resolution/convergence |
| leaderless | tags plus read/write protocol | which replica sets and versions count? | quorum, version, repair, reconfiguration |

## 71.5 Synchronous and Asynchronous Are Commit Policies

Consider one leader and two followers. A write can pass these stages:

```text
L: append → local flush
             ├──send→ F1 write → F1 flush → F1 apply
             └──send→ F2 write → F2 flush → F2 apply
```

Possible acknowledgement policies include:

- after local memory append;
- after local durable flush;
- after one remote receipt or write;
- after one or more remote durable flushes;
- after a quorum durably accepts an entry under an agreement protocol;
- after remote apply or visibility.

“Asynchronous replication” usually means the leader acknowledges before a remote stage. This creates a loss window if the leader and every copy containing the acknowledged suffix become unavailable. “Synchronous replication” waits for some remote stage, increasing latency and coupling progress to remote health.

Neither word alone proves zero data loss:

- waiting for remote receipt may not survive remote power loss;
- waiting for one arbitrary follower is insufficient if failover can promote a different, stale follower;
- two durable copies in the same failure domain are not independent;
- a durable record not included in the next authoritative history can still be discarded;
- a response can be lost after the operation commits, leaving the client uncertain.

### Commit point versus acknowledgement point

Define:

- **protocol commit point:** the transition after which the operation must remain in every legal future authoritative history;
- **durability point:** the stage at which selected failures cannot erase the record from selected copies;
- **acknowledgement point:** when success is returned;
- **visibility point:** when a particular read protocol may return the effect.

A well-defined durable synchronous API usually acknowledges no earlier than its promised commit and durability points. Visibility may be earlier or later depending on the protocol, but its behavior must be documented.

## 71.6 Invariants and Failure Windows

Core replication invariants:

1. **Prefix/order:** a replica applies only a valid ordered history, or uses a conflict model that explicitly permits a partial order.
2. **No gap:** applying entry `k` requires every dependency and required predecessor.
3. **Commit preservation:** once committed, an entry appears in every later legal authoritative history.
4. **Single authority:** at most one unfenced authority may commit conflicting entries for the same epoch/key range.
5. **Monotonic epoch:** a participant rejects operations from an older authority epoch after learning a newer one.
6. **Read rule:** a read returns only state satisfying the advertised consistency and session watermark.
7. **Reconfiguration:** old and new replica configurations overlap or transfer authority according to a protocol that preserves committed state.
8. **State-transfer integrity:** snapshot identity, position, and log tail form one consistent history.

| Failure window | What may happen | Required response |
|---|---|---|
| leader accepts, crashes before local durability | operation can vanish | do not claim durable success |
| local durable, before any remote copy | failover can lose suffix | async RPO includes suffix |
| remote received, not flushed | remote process may retain it; OS/power crash may not | match ACK to failure contract |
| enough replicas accepted, before client response | operation may be committed though client sees timeout | idempotency/status lookup |
| follower flushed, not applied | durable but stale read | wait for apply watermark or route elsewhere |
| leader isolated but alive | split-brain risk | revoke/fence before new authority commits |
| promotion chooses stale replica | acknowledged entries can disappear | freshness/commit eligibility rule |
| rejoining old leader has divergent suffix | stale writes can contaminate history | fence, truncate/reconcile under protocol |

## 71.7 Worked Replication Trace

Assume log positions are monotonic LSNs. Entry `80` changes `x` from 4 to 5.

```text
time      leader L          follower F1       follower F2
t1        append 80
t2        flush 80
t3        send 80           receive/write 80
t4                          flush 80
t5        ACK client
t6                                             receive/write 80
t7        L loses power
```

At `t5`:

- L has durable 80;
- F1 has durable 80 but may not have applied it;
- F2 has not yet received 80.

Three different policies produce different reasoning:

1. **Local-durable ACK.** The acknowledgement was valid at `t2`. If L is permanently lost and F2 is promoted, entry 80 disappears. The advertised RPO must allow this, or promotion is wrong.
2. **One-remote-flush ACK.** The acknowledgement was valid at `t4`, but only if future authority selection preserves F1's committed prefix. Promoting F2 without synchronization violates commit preservation.
3. **Remote-apply ACK.** This trace lacks evidence that F1 applied 80, so the leader must not yet promise that an immediate F1 read sees `x=5`.

Suppose the client timed out instead of receiving the `t5` response. Entry 80 may still be committed. Retrying `increment x` can produce `x=6`. A transactionally recorded request ID lets the system return the original result instead.

Suppose L later restarts while F1 is leader in epoch 12. L's copy of entry 80 may be perfectly fresh, but L's epoch 11 authority is stale. Storage nodes and request paths must reject epoch 11 writes. Freshness cannot substitute for fencing.

## 71.8 Consistency Models Are Sets of Histories

A consistency model declares which invocation/response histories are legal. Begin with a read/write register whose sequential specification is:

- `write(v)` replaces the register value and returns;
- `read()` returns the value of the latest preceding write, or the initial value.

Operations have intervals:

```text
client A:  |------ write(1) ------|
client B:            |--- read() → ? ---|
```

Overlapping operations can often be ordered either way. A completed operation followed by a later invocation creates a real-time precedence edge.

### Linearizability

**[Theorem/model]** A history is linearizable when each completed operation can be assigned a single linearization point between its invocation and response such that:

1. the resulting total order satisfies the object's sequential specification;
2. if operation A responds before B is invoked, A precedes B.

Pending invocations that took effect may be completed in an extension; the rest may be discarded.

Linearizability is per operation/object and respects real time. It does not imply a multi-object transaction. A system can provide linearizable operations on `x` and `y` while a client observes a mixed pair because no atomic two-key read exists.

Implementations typically need an authoritative leader, quorum protocol, or other coordination to rule out stale reads. A lease read is linearizable only with the lease's timing and fencing assumptions. Consensus mechanics are Chapter 74.

### Sequential consistency

A sequentially consistent history has one total order satisfying:

- each client's operations appear in program order;
- the object specification holds.

It need not respect real-time order between clients. If A's `write(1)` completes and only later B begins `read()` and receives 0, that history violates linearizability but can be sequentially consistent by placing B's read before A's write—provided no program-order or reads-from constraints forbid it.

Sequential consistency is therefore not “linearizability with slightly more staleness”; it removes a particular real-time constraint. It is also a global-history property, unlike the local composition property for linearizable objects.

### Causal consistency

Causality includes at least:

- each client's program order;
- reads-from: observing a write makes later operations depend on it;
- transitive closure of those edges.

Causal consistency requires every observer to respect the order of causally related writes. Concurrent writes may be observed in different orders, subject to the datatype and convergence protocol.

```text
A: write(post="hello")
B: read(post) → "hello"; write(reply="welcome")
C: read(reply) → "welcome"; read(post) → absent
```

C has observed an effect before its cause, so this violates the intended causal guarantee. A system can avoid it by carrying dependency metadata and delaying the reply until the post dependency is available at C.

### Eventual and strong eventual consistency

A basic eventual-consistency claim usually says that, if updates stop and communication/recovery assumptions eventually hold, replicas converge. It says little about interim reads, conflict preservation, latency to convergence, or session behavior.

Strong eventual consistency (SEC) adds strong convergence: replicas that have incorporated the same set of updates have equivalent state. CRDTs are one way to build SEC under their delivery and merge assumptions. Eventual consistency is not a conflict-resolution algorithm.

### The models are not one marketing ladder

Under conventional definitions, linearizability strengthens sequential consistency with real time, and sequential consistency strongly constrains order. Causal and session models express different dependency scopes; eventual/SEC additionally discuss convergence. Product phrases such as “strong consistency” are not formal names. Ask for legal histories.

## 71.9 Worked History: Classify the Guarantee

Initial value is `x=0`.

### History A

```text
A: write(x=1) returns
                         B: read(x) → 0
```

The write completed before the read began.

- not linearizable: real time requires write before read;
- potentially sequentially consistent: place B's read before A's write, because cross-client real time is ignored;
- violates read-your-writes only if B is the same logical session as A and the session guarantee spans that handoff.

### History B

```text
B: read(x) → 1
B: read(x) → 0
```

With no intervening write of 0, B has moved backward. This violates monotonic reads. It also cannot be sequentially consistent for this register history: B's first read forces `write(1)` before it, and B's program order puts the second read later.

### History C

```text
A: write(x=1) overlaps B: write(x=2)
C: read(x) → 1
D: read(x) → 2
```

The read results alone do not decide linearizability because the writes overlap and may be ordered either way; the intervals and later reads matter. If `write(2)` overlaps C's read, and C's read completes before D begins, returning 1 then 2 is compatible with order `write(1), read C, write(2), read D`. If both writes complete before both reads begin, the two later reads cannot disagree in a linearizable register with no further write. History classification requires complete intervals, not a slogan such as “replicas disagreed.”

### History D

```text
A: write(post=P)
B: read(post)→P; write(reply=R)
C: read(reply)→R; read(post)→absent
```

This violates the stated causal relationship. It may still satisfy a weak eventual claim if, after propagation stops, C eventually receives both.

## 71.10 Session Guarantees

Session guarantees constrain one client's experience across replicas:

| Guarantee | Required order/watermark |
|---|---|
| read-your-writes | a read includes the session's prior writes |
| monotonic reads | each read includes at least the writes included by earlier reads |
| monotonic writes | the session's writes are incorporated in issue order |
| writes-follow-reads | a write is ordered after writes observed by prior reads |

A practical implementation gives a session a dependency token or watermark:

```text
token = greatest required log position / version frontier
read(replica, token):
    wait until replica covers token, route to a fresher replica, or fail
```

Sticky routing can provide monotonic reads only while the chosen replica itself does not roll back and the session remains pinned. It does not automatically provide read-your-writes if writes went elsewhere and have not arrived. LSN gating, causal version frontiers, or leader routing provide stronger evidence.

Session guarantees are often an excellent latency/UX trade: a user should not see their profile revert merely because the next request reached a different replica. But another session may remain stale, so these are not global linearizability.

## 71.11 Logical Clocks and Conflict Detection

Physical timestamps are useful operational data, but clock skew and uncertainty make naive last-write-wins unsafe for preserving concurrent intent.

### Lamport clocks

Each process increments a scalar counter; on receive it advances beyond the received counter. If event `a` causally precedes `b`, then `L(a) < L(b)`. The converse is false. Scalar order can break ties, but it cannot prove that two events were concurrent.

### Vector clocks

For participants A, B, and C, a version vector might be:

```text
VA = [2, 0, 0]
VB = [2, 1, 0]   // includes VA, then B update
VC = [2, 0, 1]   // includes VA, then C update
```

Define `X ≤ Y` when every component of X is no greater than the corresponding component of Y.

- `VA < VB`: VA causally precedes VB.
- `VA < VC`: VA causally precedes VC.
- neither `VB ≤ VC` nor `VC ≤ VB`: VB and VC are concurrent siblings.

A later merge can carry `[2,1,1]`, causally succeeding both. Vector metadata can grow with writers or replica-set changes, so production systems use dotted versions, compact causal contexts, or bounded schemes with explicit tradeoffs.

Conflict **detection** is not conflict **resolution**. After detecting siblings, a system can:

- return both to the application;
- choose by a deterministic rule, losing one intent;
- merge domain state;
- use a CRDT designed for the operation.

Last-write-wins supplies deterministic convergence only if every replica agrees on a total timestamp/tie-break order. It can discard a concurrent write, and skew can make an intuitively older write win. That may be correct for a cache and unacceptable for a shopping cart or ledger.

## 71.12 Quorums: The Set Proof

Let a key have `N` home replicas. A write waits for `W`; a read waits for `R`.

For any read set `Qᵣ` and write set `Q𝓌`:

```text
|Qᵣ ∩ Q𝓌| ≥ max(0, R + W - N)
```

Therefore `R + W > N` proves every size-`R` set intersects every size-`W` set.

Example with `N=5`, `R=3`, `W=3`:

```text
minimum intersection = 3 + 3 - 5 = 1
```

That is the entire arithmetic proof. To turn overlap into a read guarantee, a protocol additionally needs:

- stable, agreed membership for this operation;
- write completion on the claimed `W` home replicas;
- reads from the corresponding home set;
- comparable, authenticated version tags;
- a rule for incomplete and concurrent writes;
- a read algorithm that selects or repairs an appropriate version;
- reconfiguration that preserves quorum intersection across configurations.

`W + W > N` makes any two write sets overlap, but an overlapping storage node does not automatically serialize them. A linearizable quorum register such as an ABD-style protocol uses ordered tags and a read/write-back phase; `R+W>N` alone is not that protocol.

### Incomplete write counterexample

`N=3, W=2, R=2`. Writer A sends version `(7,A)` to replica 1 and pauses before reaching a second replica, so A has not completed. Writer B completes version `(7,B)` on replicas 2 and 3. A read of replicas 1 and 2 sees both versions. “Choose the largest version” works only if tags have an agreed total order and the write/read protocol makes that choice safe. If clients use unsynchronized wall clocks or treat equal counters as identical, overlap gives no answer.

Sloppy quorums further weaken the simple proof: a write stored on temporary non-home nodes may not intersect a read from home nodes even when the response counts satisfy `R+W>N`. Hinted handoff and anti-entropy repair this later; they are Chapter 72 mechanisms, not proof that the immediate read is fresh.

### Compact validated calculation

This C++23 model exhaustively enumerates small quorum sets. It validates only intersection, exactly matching the theorem used here.

```cpp
#include <cassert>
#include <cstdint>

constexpr int bits(std::uint32_t x) {
    int count = 0;
    for (; x != 0; x >>= 1U) {
        count += static_cast<int>(x & 1U);
    }
    return count;
}

constexpr bool every_pair_intersects(int n, int r, int w) {
    const auto limit = std::uint32_t{1} << static_cast<unsigned>(n);
    for (std::uint32_t reads = 0; reads < limit; ++reads) {
        if (bits(reads) != r) {
            continue;
        }
        for (std::uint32_t writes = 0; writes < limit; ++writes) {
            if (bits(writes) == w && (reads & writes) == 0U) {
                return false;
            }
        }
    }
    return true;
}

constexpr int minimum_intersection(int n, int r, int w) {
    const int overlap = r + w - n;
    return overlap > 0 ? overlap : 0;
}

int main() {
    static_assert(every_pair_intersects(5, 3, 3));
    static_assert(minimum_intersection(5, 3, 3) == 1);
    static_assert(!every_pair_intersects(5, 2, 3));

    assert(every_pair_intersects(3, 2, 2));
    assert(!every_pair_intersects(4, 2, 2));
}
```

The model says nothing about freshness, crashes, tags, concurrency, or linearizability. Its small scope is the correction to the usual overclaim.

## 71.13 Conflicts, CRDTs, and Convergence

Conflict resolution should preserve application meaning, not merely make replicas equal.

### Strong eventual consistency

For a state-based CRDT, states form a join-semilattice and merge computes a least upper bound. The merge must be:

- commutative: `merge(a,b) = merge(b,a)`;
- associative: grouping does not matter;
- idempotent: `merge(a,a) = a`.

A grow-only counter stores one nondecreasing component per replica:

```text
A state [3,1]   B state [2,4]
merge by componentwise max → [3,4]
value = sum = 7
```

Reordering and duplicate state delivery do not change the result. Decrement, removal, uniqueness, and bounded resources require richer datatypes and semantics. Operation-based CRDTs instead need delivery assumptions such as causal order and duplicate suppression appropriate to the design.

SEC guarantees convergence for replicas that incorporate the same updates. It does not automatically guarantee:

- referential or numeric invariants;
- that every update is eventually delivered;
- bounded metadata/tombstones;
- intuitive conflict intent;
- atomicity across several objects.

This chapter stops at the merge contract. Gossip, hinted handoff, read repair, Merkle comparison, and repair scheduling belong to Chapter 72.

## 71.14 Failover: Freshness Plus Authority

Failover has two independent questions:

1. **Which candidate contains every committed operation it must preserve?**
2. **How is every old writer prevented from committing afterward?**

Freshness may be measured by committed log position, not wall-clock time. Authority is represented by an epoch/term, lease plus assumptions, or fencing token. The election/consensus protocol that installs authority belongs to Chapters 70 and 74; this chapter consumes its result.

```text
epoch 11: leader A isolated, still running
epoch 12: leader B elected with committed prefix through 900

safe storage rule:
    reject write(epoch < highest_seen_epoch)
```

Routing alone is weak fencing: an old leader may retain clients, queued work, or storage access. A downstream system should reject stale epochs or the old process should be forcibly isolated.

### Promotion invariants

- The promoted history contains the previous committed prefix.
- Divergent uncommitted suffixes are not mistaken for committed state.
- Old authority cannot commit after new authority begins.
- Reconfiguration itself preserves quorum/commit intersection.
- Clients can resolve operations whose responses were lost around failover.

RPO is the maximum acceptable committed/acknowledged data loss under a named failure. RTO is the target service-restoration time. They are workload objectives, not protocol properties unless the failure, detection, election, catch-up, and dependency budgets are included.

Synchronous replication reduces an RPO only when acknowledgement and promotion use compatible sets. Requiring “one of three followers” to flush but later promoting an arbitrary follower is not sufficient. The election must choose a candidate containing the committed prefix or first bring it up to date.

## 71.15 CAP Without the Slogan

The formal CAP result is narrower and more useful than “pick two.”

**[Theorem, Gilbert–Lynch model]** In an asynchronous network where messages may be lost/delayed by a partition, there is no implementation of an atomic/linearizable read-write object that is also available in every allowed execution. Their availability condition requires every request received by a non-failing node eventually to return a response.

The proof intuition uses two sides that cannot communicate. If both must answer, a read side cannot distinguish “no write occurred” from “a write completed on the unreachable side.” Returning the old value can violate linearizability; waiting for knowledge can violate availability.

What CAP does not say:

- It does not say a system permanently chooses two of three adjectives.
- “Partition tolerance” is not a feature bought independently; the theorem considers executions with communication loss.
- CAP consistency is the paper's atomic/linearizable register property, not ACID invariant preservation and not every consistency model.
- Formal availability is not an SLO percentage, bounded latency, or degraded response.
- The result does not prescribe which operations, keys, or users to reject.
- It does not analyze normal-operation latency.

Real systems make granular choices: a minority may reject writes but serve bounded-staleness reads; one operation may require coordination while another merges; an application may return cached partial data. State the operation and legal history.

### PACELC and harvest/yield

PACELC is a design mnemonic: during a Partition, choose the desired Availability/Consistency behavior; Else, normal operation trades Latency against Consistency/coordination. It is not the CAP theorem and not a proof. Strong reads sometimes use a local lease or safe timestamp and avoid a WAN round trip; the protocol assumptions still pay elsewhere.

Harvest/yield is another operational lens:

- **yield:** fraction of requests completed;
- **harvest:** fraction or freshness/completeness of desired data represented.

A search page may return fewer shards to preserve yield. A balance check may reject rather than return partial data. These metrics must be defined for the application; they do not replace a consistency model.

## 71.16 Choosing a Replication Contract

Work backward from observable requirements:

| Requirement | Likely mechanism | Failure/latency cost |
|---|---|---|
| latest single-key read | linearizable leader/quorum read | coordination or validated authority |
| user sees own write | session watermark, leader route, or wait-for-apply | routing/wait on lag |
| causally ordered feed | dependency metadata and causal apply | metadata and dependency stalls |
| accept disconnected writes | siblings or mergeable datatype | conflict semantics and repair |
| no acknowledged loss on one-node failure | compatible synchronous commit and failover sets | remote durability latency |
| local low-latency reads | bounded staleness/session guarantees | weaker global recency |

Then specify:

1. object/key/transaction scope;
2. topology and membership;
3. write order or conflict representation;
4. commit, durability, acknowledgement, and visibility points;
5. read protocol and session token;
6. crash, partition, and correlated-failure assumptions;
7. promotion eligibility and fencing;
8. state transfer and repair;
9. client behavior for timeout, retry, and conflicts;
10. measurable lag, RPO, RTO, and saturation budgets.

Isolation of multi-operation transactions is Chapter 65. Cross-shard atomic commit is Chapter 73. The consensus protocol that commits a log and changes membership is Chapter 74. This chapter defines the replication and read contracts those layers must provide.

---

**Skippable PostgreSQL 18 reference begins here.**

## 71.17 Physical Streaming Replication

**[PostgreSQL 18]** Physical streaming replication sends PostgreSQL WAL from a primary's WAL sender to a standby's WAL receiver. The standby writes the stream and its startup process replays WAL. A base backup plus subsequent WAL provides the initial state-transfer relationship described in §71.3.

Progress positions visible on the primary include:

- `sent_lsn`: sent toward the standby;
- `write_lsn`: standby reported written;
- `flush_lsn`: standby reported durably flushed under its I/O contract;
- `replay_lsn`: standby reported applied.

Lag is multidimensional. Byte distance shows backlog volume; time-oriented fields show recent measured delay but can be misleading when the primary is idle or clocks/measurement windows differ. Diagnose send, write/flush, and apply separately.

A warm standby does not serve queries; a hot standby can serve read-only queries while recovery applies WAL. Queries see a consistent PostgreSQL snapshot at the standby's replay state, not necessarily the primary's latest state. Recovery can conflict with long standby queries—for example, WAL replay may need to remove row versions still visible to a standby snapshot. Configuration determines whether replay waits, cancels conflicting queries, or feedback delays cleanup on the primary. Each choice moves pain between query cancellation, apply lag, and primary bloat.

Physical compatibility and upgrades are product/version constraints. Follow matching documentation rather than inferring portability from “byte-identical.”

## 71.18 PostgreSQL Commit Wait Levels

**[PostgreSQL 18]** `synchronous_commit` determines how far commit processing waits. Its behavior also depends on whether synchronous standbys are configured.

| Value | Local behavior / remote wait |
|---|---|
| `off` | return without waiting for local WAL flush; recent acknowledged transactions can be lost after a crash without database inconsistency |
| `local` | wait for local WAL flush; do not wait for synchronous standby |
| `remote_write` | wait for local flush and synchronous standby report that WAL reached its filesystem; not necessarily durable across standby OS/power failure |
| `on` | wait for local flush and synchronous standby durable flush |
| `remote_apply` | wait for synchronous standby durable flush and replay so the commit is visible to queries there |

Without an applicable synchronous standby configuration, remote-oriented values do not magically add a remote durability copy. Check the deployed `synchronous_standby_names` and active synchronous state.

`synchronous_standby_names` supports priority selection (`FIRST`) and quorum selection (`ANY`). For example, `ANY 2 (...)` waits for any two eligible named standbys at the selected `synchronous_commit` stage. This is a primary-centric commit wait, not a Dynamo-style read quorum.

Three subtleties:

1. `remote_apply` concerns the synchronous standbys that satisfied the commit wait; a load balancer can still route a later read to a different lagging standby.
2. Remote flush protects only the failure domains represented by those standbys and only if failover preserves that committed history.
3. A client disconnect or cancellation while a backend waits for synchronous replication does not imply the transaction was rolled back; commit outcome can be uncertain. Use idempotency/status resolution.

PostgreSQL configuration defaults and exact wait behavior are version facts. This chapter intentionally does not turn current defaults into design advice.

## 71.19 Slots, Retention, and Failover Readiness

A physical replication slot can retain WAL required by its consumer. A logical slot can additionally retain catalog/tuple horizons needed for decoding. This improves resumability but moves backpressure to the primary:

```text
consumer stalls
  → restart_lsn stops advancing
  → retained WAL grows
  → storage pressure
  → slot invalidation or primary incident
```

Monitor slot activity, restart/confirmed positions, retained bytes, invalidation state, and relevant visibility horizons. Retention caps limit damage by allowing a lagging slot to become unusable; they do not make the consumer magically catch up.

PostgreSQL 18 supports logical failover-slot synchronization, but synchronization is asynchronous. Documentation requires verifying that required slots are present, synced, non-temporary, and not invalidated, and that the standby is sufficiently ahead of subscribers before promotion. “Failover enabled” is not the same as “ready now.”

## 71.20 Logical Replication

**[PostgreSQL 18]** Logical replication normally:

1. takes an initial table snapshot/copy;
2. decodes subsequent WAL changes on the publisher;
3. sends publication changes to a subscriber;
4. applies them in publisher order within a subscription.

It supports selected tables and documented cross-version/platform paths. Replica identity controls update/delete matching. Subscribers remain writable; local or multi-source writes can conflict, DDL and sequences are restricted, and independent subscriptions provide no global order. PostgreSQL 18 logs several conflict types; verify per-type behavior and own the repair procedure.

## 71.21 Read-Replica Session Guarantees

PostgreSQL gives the raw progress positions needed to implement routing policies, but an external router/application must preserve the contract.

For read-your-writes:

1. commit on the primary and capture a suitable commit/replay watermark through an application-supported mechanism;
2. route to the primary, or choose a standby whose replay covers the watermark;
3. wait or fail rather than silently read an older replica.

For monotonic reads, retain the greatest observed watermark and never route to a replica behind it. Sticky sessions approximate this only while topology and replay remain monotonic; after failover, the router must compare the new authority's timeline/position rather than reuse an incompatible raw number.

`remote_apply` can make a commit visible on the synchronous standby that acknowledged apply. It does not make every standby current and does not replace session-aware routing.

## 71.22 Product Audit Checklist

Before declaring a PostgreSQL replication deployment “synchronous,” “zero-loss,” or “strongly consistent,” record:

- exact PostgreSQL major/minor versions;
- local and standby durability settings and storage guarantees;
- active `synchronous_commit` and `synchronous_standby_names` behavior;
- which standbys are eligible for acknowledgement and promotion;
- send/write/flush/replay lag distributions;
- failure-domain placement;
- failover controller, election source, and fencing mechanism;
- slot retention limits and alerting;
- hot-standby cancellation/feedback tradeoff;
- logical replication conflict and DDL procedures;
- client timeout/idempotency and read-routing rules;
- tested RPO/RTO for node, zone, network, storage, and operator failures.

The labels describe mechanisms only when this evidence exists.

---

## 71.23 Recall Card

```text
REPLICATION
Snapshot at s + complete ordered log tail after s.
received ≠ written ≠ flushed ≠ applied ≠ visible.
Topology chooses writers; protocol proves the guarantee.

CONSISTENCY
Linearizable: legal total order + real-time precedence.
Sequential: legal total order + per-client program order.
Causal: every observer respects cause before effect.
Session: RYW, monotonic reads/writes, writes-follow-reads.
Eventual: convergence under stated delivery/quiescence assumptions.

QUORUM
R + W > N proves intersection only.
Fresh/latest/linearizable needs membership, tags, completion,
read selection/write-back, concurrency, and reconfiguration rules.

FAILOVER
Freshness + authority + fencing.
Synchronous ACK helps only if promotion preserves its replica set.
Timeout near commit means unknown outcome.

BOUNDARIES
Repair dissemination → Ch72.
Cross-shard transactions → Ch73.
Consensus/membership agreement → Ch74.
```

## 71.24 Questions

1. A follower reports “write,” “flush,” and “replay” positions. Which failure and read guarantees does each support, and what remains unknown?
2. In the worked trace, why is promoting F2 unsafe after a one-remote-flush acknowledgement? What promotion rule repairs the proof?
3. Construct a history that is sequentially consistent but not linearizable. Which real-time edge does it violate?
4. A user writes on the leader, then reads from two followers and sees new then old. Which session guarantees fail, and what watermark rule fixes them?
5. For `N=7, W=4, R=4`, calculate the minimum intersection. List four additional assumptions needed before claiming a latest-value read.
6. Why can vector clocks detect concurrency while Lamport clocks cannot? Compare `[3,1,0]` and `[2,2,0]`.
7. Two replicas receive the same CRDT updates and disagree. Name at least three violated implementation assumptions that could explain it.
8. State CAP using its network, object, consistency, and availability definitions. Then explain why a 99.99% SLO is a different claim.

## 71.25 Puzzle

`N=3`, `W=2`, `R=2`, so `R+W>N`. A completed read returns an older value than a completed write.

Must the quorum arithmetic be wrong?

No. Possible causes include:

- write and read used different/sloppy replica sets;
- membership changed without joint intersection;
- the “completed write” reached fewer than `W` home replicas;
- version tags were incomparable or selected incorrectly;
- a newer incomplete/concurrent write confused the selection rule;
- a node acknowledged volatile rather than required durable state;
- the system advertised overlap counts but did not run a linearizable read protocol.

The arithmetic proves an overlapping node exists. It does not prove what that node stores, which version the read chooses, or that histories respect real time.

## 71.26 Exercise: Build a History Checker

Extend the quorum C++ model in two independent directions:

1. Enumerate every read/write quorum pair for `N≤8`; compute the actual minimum intersection and compare it with `max(0,R+W-N)`.
2. Represent a small register history with invocation/response indices, writes, and returned read values. Search all total orders that:
   - place each operation inside its interval;
   - respect real-time precedence;
   - satisfy the register specification.

If one order exists, the history is linearizable. Remove the real-time edges but retain each client's program order to check sequential consistency. Test Histories A–C from §71.9.

Finally simulate a client watermark across two replicas. Assert that routing only to `applied ≥ watermark` prevents the demonstrated read-your-writes and monotonic-read violations.

## 71.27 Common Traps

- **“Replication means high availability.”** Promotion, routing, quorum, dependencies, and fencing determine availability.
- **“A replica ACK means durable.”** Name received, written, flushed, applied, and failure domain.
- **“Single leader means linearizable.”** Stale follower reads and stale-leader reads can violate it.
- **“Synchronous means zero loss.”** Acknowledgement and promotion sets must preserve the same committed prefix.
- **“The freshest node should win.”** Freshness needs committed-log semantics; authority still needs an epoch and fencing.
- **“`R+W>N` gives the latest value.”** It gives set intersection; the rest is protocol.
- **“Vector clocks resolve conflicts.”** They detect causal order/concurrency; the application or datatype resolves it.
- **“CRDT means arbitrary invariants without coordination.”** Convergence and invariant preservation are different proofs.
- **“Sticky reads always give monotonicity.”** Rollback, failover, or session movement can break the assumption.
- **“PostgreSQL `remote_apply` updates every replica.”** It waits for the configured synchronous acknowledgement set, not all read targets.
- **“Logical replication is transparent multi-leader.”** Local writes, constraints, DDL, sequences, and independent subscriptions create conflict/ordering concerns.

## 71.28 Prerequisite Check

Before Chapter 72, verify that you can:

- distinguish snapshot state transfer from incremental log shipping;
- name receive/write/flush/apply/visibility positions;
- state a replication commit point and enumerate its crash windows;
- classify a complete history as linearizable, sequential, causal, or only eventual;
- implement all four session guarantees with a conceptual watermark;
- compare vector timestamps for causal order and concurrency;
- derive quorum intersection without claiming freshness;
- explain why failover needs both committed-prefix selection and fencing;
- state formal CAP without using “pick two.”

If those are solid, Chapter 72 can focus narrowly on how missing updates are disseminated and repaired rather than reteaching the consistency contract.

## 71.29 Primary References

- M. Herlihy and J. Wing, [“Linearizability: A Correctness Condition for Concurrent Objects”](https://www.cs.cmu.edu/~wing/publications/HerlihyWing90.pdf), *ACM TOPLAS* 12(3), 1990.
- S. Gilbert and N. Lynch, [“Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services”](https://www.comp.nus.edu.sg/~gilbert/pubs/BrewersConjecture-SigAct.pdf), *SIGACT News* 33(2), 2002.
- D. Terry et al., [“Session Guarantees for Weakly Consistent Replicated Data”](https://doi.org/10.1109/PDIS.1994.331722), PDIS 1994.
- G. DeCandia et al., [“Dynamo: Amazon's Highly Available Key-value Store”](https://www.amazon.science/publications/dynamo-amazons-highly-available-key-value-store), SOSP 2007.
- PostgreSQL 18, [High Availability, Load Balancing, and Replication](https://www.postgresql.org/docs/18/high-availability.html), [WAL configuration](https://www.postgresql.org/docs/18/runtime-config-wal.html), and [Logical Replication](https://www.postgresql.org/docs/18/logical-replication.html).
