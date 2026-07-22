# Chapter 70 — Leader Election

*Interview-focused revision notes. The theme: leader election is the art of getting a set of unreliable, asynchronous nodes to agree on one of themselves — and the deep lesson is that you can never guarantee exactly one leader at a time, so every correct system stops trying. Instead it makes leadership cheap to lose and impossible to abuse: monotonic epochs reject the stale, majorities block the isolated, and fencing tokens neuter the paused. A leader is not a crown; it is a lease with a version number.*

---

## 70.1 Why Elect a Leader at All

An enormous fraction of distributed-systems machinery exists to avoid coordinating on every operation. The cheapest way to make a set of nodes agree on the *order* of events is to nominate one node — the **leader** (also *primary*, *master*, *coordinator*) — and route every decision through it. The leader serializes: it assigns each write a position in a total order, and the others (the **followers** / *replicas* / *secondaries*) simply apply that order. This is the backbone of single-leader replication (Ch. 71) and of the leader-driven consensus protocols Raft and Multi-Paxos (Ch. 74).

The benefits are concrete:

- **Simplicity.** With one writer there is one authoritative history. Concurrency control collapses from "reconcile conflicting concurrent writes across N nodes" to "the leader decides." No write-write conflict resolution, no vector clocks, no last-writer-wins ambiguity.
- **A single point of serialization.** The leader can hand out monotonically increasing sequence numbers (log indices, transaction ids, timestamps) without further agreement, because it alone issues them.
- **Efficiency for reads.** A leader that knows it is still leader can serve linearizable reads from local state (with caveats — see leases, §70.12), avoiding a round of consensus per read.
- **Locality of policy.** Schema changes, partition assignment, and compaction scheduling are naturally centralized. Kafka's *controller* (§70.17) is exactly this: one broker elected to own cluster metadata decisions.

The costs are equally concrete, and every interview probes whether you can name them:

- **A single point of failure.** If the leader dies, no progress is possible until a new one is elected. Availability now depends on how fast you can detect the failure (Ch. 69) and run an election.
- **Election overhead and a write pause.** During an election there is *no* leader and therefore no writes. The window from "old leader failed" to "new leader serving" is unavailability the client sees.
- **A throughput ceiling.** All writes funnel through one node; you cannot scale writes past what one machine can serialize (the motivation for sharding, Ch. 72, and for leaderless designs).
- **The split-brain hazard.** If detection is wrong and two nodes both believe they are leader, they can both accept writes and corrupt the data (§70.9). This single failure mode is why leader election is hard rather than trivial.

**Leader-based vs leaderless.** The alternative is to have *no* distinguished node: any replica accepts any write, and consistency is reconciled after the fact via quorums and conflict resolution. **Dynamo-style** systems (Cassandra, Riak, DynamoDB's internal model) are leaderless: a write goes to `W` replicas, a read to `R`, and `R + W > N` gives overlap. Leaderless trades the leader's simplicity and single point of failure for the complexity of concurrent-write reconciliation (siblings, CRDTs, read-repair). The rule of thumb: **if you need a total order or a single writer, elect a leader; if you need write availability under partitions above all, go leaderless.** This chapter is about the first world.

---

## 70.2 Correctness Goals: Safety and Liveness

Leader election, like every distributed algorithm, is judged on two independent properties (Ch. 68 §68.2 introduced the safety/liveness split):

- **Safety — "nothing bad happens":** *at most one node acts as leader at any time.* Framed positively this is often stated as "at most one leader," and the honest, achievable form is **at most one leader per term/epoch** (§70.8). Violating safety is catastrophic: two active leaders means two divergent histories, i.e. split-brain (§70.9).
- **Liveness — "something good eventually happens":** *eventually some node becomes leader and the system makes progress.* A protocol that elects nobody is trivially safe and useless.

The tension between the two is the whole subject. You can trivially guarantee safety by never electing anyone (no progress) and trivially guarantee liveness by letting everyone declare themselves leader (no safety). A real algorithm must give safety *always* and liveness *when the network and nodes behave well enough*.

There is a hierarchy of what "one leader" can mean, and precision here separates strong candidates:

| Guarantee | Achievable? | Cost |
|---|---|---|
| Exactly one leader, continuously | **No** — impossible in an async system with failures (§70.3) | — |
| At most one leader at a time | Only with perfect failure detection or synchronous timing assumptions | Strong timing/fencing needed |
| At most one *active* leader (one that can commit) per epoch | **Yes**, via majority quorum + monotonic epochs | The design used by Raft/ZAB/etc. |
| Eventually at least one leader (liveness) | **Yes**, when the network is eventually stable | Randomized timeouts to break symmetry |

The practical target that real systems hit is the third row: **there may be several nodes that *think* they are leader, but at most one can actually commit a write, because committing requires a majority and majorities of a given epoch are unique.** Safety is enforced not by preventing the belief but by preventing the *action*. Hold that distinction; it recurs in every real system below.

---

## 70.3 Why "Exactly One Leader" Is Impossible

The reason you cannot guarantee a single continuously-correct leader traces directly to the **FLP impossibility result** (Fischer, Lynch, Paterson, 1985; Ch. 68 §68.6): in a fully asynchronous system, no deterministic protocol can guarantee consensus if even one node may crash. Electing a leader *is* a consensus problem — the nodes must agree on the identity of one value (the leader). So FLP applies directly.

The intuition is the **indistinguishability** argument (Ch. 69 §69.1). In an asynchronous network you cannot tell a *crashed* node from a *slow* node or a *partitioned* node — no bounded response means "dead," it only ever means "not heard from yet." Concretely:

```
Node A's view of leader L:
  ...heartbeat...heartbeat...[silence]...
                              │
              A cannot distinguish among:
                (a) L crashed                → A should elect a new leader
                (b) L is slow / GC-paused    → A must NOT elect (L is still leader)
                (c) network dropped L's msgs → A must NOT elect (L is still leader)
```

If A waits forever to be sure, it sacrifices liveness (L may really be dead). If A declares L dead after a timeout, it may be wrong (L was merely paused), and if A then elects itself while L revives, there are **two leaders** — a safety violation. This is not a bug to be fixed; it is a proven impossibility.

Systems escape FLP the same three ways every consensus protocol does (Ch. 74 §74.2):

1. **Partial synchrony / timeouts** — assume that *eventually* messages arrive within some (unknown) bound, so a failure detector is *eventually* accurate (Ch. 69 §69.7, the ◇S detector). This restores liveness while keeping safety unconditional.
2. **Randomization** — break the symmetry that FLP exploits with random election timeouts, so the probability of an indefinite tie goes to zero. Raft and Bully-in-practice both do this.
3. **A majority quorum** — make "acting as leader" require a majority vote, so two disjoint leaders cannot both be active (two majorities of the same set must intersect, §70.10).

The upshot for the interview: **the goal is never "exactly one leader." It is "safety unconditionally, liveness under partial synchrony," and you buy the gap between them with epochs, quorums, and fencing.** A system that claims to always have exactly one leader is either making a synchronous-timing assumption or is simply wrong about split-brain.

---

## 70.4 The Bully Algorithm

The **Bully algorithm** (Garcia-Molina, 1982) is the canonical textbook election. Every node has a unique, totally-ordered **id** (numeric priority), and the rule is dead simple: **the highest-id live node wins.** It is called "bully" because a higher-id node, on returning, forcibly seizes leadership from any lower-id incumbent.

There are three message types:

- **`ELECTION`** — "I am starting an election" (sent to all *higher*-id nodes).
- **`ANSWER`** (or `ALIVE`) — "I am alive and outrank you; stand down, I'll take over."
- **`COORDINATOR`** (or `VICTORY`) — "I am the new leader" (sent to all *lower*-id nodes).

The protocol, from the perspective of a node P that notices the leader is gone (via a failure detector, Ch. 69):

1. P sends `ELECTION` to every node with a **higher** id than itself.
2. If **no** higher node answers within a timeout, P wins: it sends `COORDINATOR` to all lower-id nodes and becomes leader.
3. If some higher node answers with `ANSWER`, P stands down and waits. That higher node now runs *its own* election (repeating from step 1). If P never hears a `COORDINATOR` after the `ANSWER` (the higher node died mid-election), P restarts the election.

### Worked walk-through

Five nodes, ids 1–5. Node 5 (the current leader) crashes. Node 2 is the first to notice (its next request to 5 times out).

```
Nodes: [1] [2] [3] [4] [5✗]     (5 is the dead leader)

Step 1: Node 2 detects 5 is gone, starts an election.
        2 ──ELECTION──▶ 3
        2 ──ELECTION──▶ 4
        2 ──ELECTION──▶ 5   (no reply; 5 is dead)

Step 2: 3 and 4 each ANSWER 2 ("we outrank you, stand down").
        3 ──ANSWER──▶ 2
        4 ──ANSWER──▶ 2
        Node 2 gives up and waits.

Step 3: 3 and 4, having answered, each start their OWN election
        (each pings only higher ids):
        3 ──ELECTION──▶ 4, 5
        4 ──ELECTION──▶ 5      (5 dead, no reply)

Step 4: 4 ANSWERs 3.  3 stands down.
        4 hears from nobody higher (5 is dead) → 4 WINS.

Step 5: 4 ──COORDINATOR──▶ 1, 2, 3   ("I, node 4, am leader")
        Everyone records 4 as leader.
```

The "bully" behavior: later, when node 5 recovers, it does **not** meekly accept node 4. It immediately sends `ELECTION` to higher ids (none exist), hears no answer, and sends `COORDINATOR` to everyone — bullying node 4 out of the job and reclaiming leadership because it has the highest id. This *deterministic re-preemption* is characteristic of Bully and, as we will see, is also a weakness: a flapping high-id node causes repeated churn (§70.18).

### Message complexity

Bully's cost depends on who starts. Worst case is when the **lowest-id** node initiates: it messages all `n − 1` higher nodes, each of which starts its own election messaging its higher nodes, cascading to **O(n²)** messages. Best case, the second-highest node starts and it is O(n). The count of `ELECTION` messages in the worst case is roughly `n(n−1)/2` plus answers and the final coordinator broadcast. Bully assumes a **synchronous, reliable** network with known timeouts — it needs a bounded `ANSWER` timeout to conclude "no higher node is alive," which is exactly the partial-synchrony assumption of §70.3.

---

## 70.5 Bully Variants and Refinements

The plain Bully algorithm is chatty and assumes reliable delivery and no partitions. Several refinements address these.

**Next-in-line / successor lists.** The elected leader proactively distributes an ordered **successor list** — "if I die, node 4 takes over, then node 3." A follower detecting the leader's death can jump straight to notifying the designated successor instead of running a full O(n²) election, collapsing the common case to O(n) or better. If the first successor is also down, it falls through to the next. This is the spirit of how many production systems avoid a full election on every failover: precompute the order.

**Candidate vs ordinary nodes.** Not every node need be electable. Partitioning nodes into **candidates** (can become leader) and **ordinary** members (can only follow) shrinks the election to the candidate set. This mirrors real deployments: ZooKeeper/etcd distinguish *voting members* from *learners/observers* (Ch. 74), and a 5-voter ensemble may have many read-only observers that never participate in election. Smaller electorate = fewer messages and a smaller quorum.

**The Invitation algorithm.** Plain Bully breaks under **network partitions** — each side would elect its own highest-id leader (split-brain, §70.9). The *Invitation algorithm* is designed for partition-tolerance: nodes form **groups**, each with a coordinator, and when partitions heal, coordinators *invite* each other to merge groups, deterministically choosing one surviving coordinator for the merged group. It tolerates arbitrary partitioning and merging at the cost of more state and complexity. The key idea it introduces — that after a partition heals you must *reconcile* competing leaders rather than assume one — is exactly what epochs (§70.8) formalize.

**The ring-based refinements** (next section) attack a different axis: avoiding the all-to-all messaging by imposing a topology.

---

## 70.6 The Ring Algorithm (Chang–Roberts)

The **ring algorithm** arranges nodes in a **logical ring**: each node knows only its successor (clockwise neighbor), and messages travel around the ring. The classic form is **Chang–Roberts (1979)**.

The election proceeds by circulating an `ELECTION` message that accumulates the ids it passes:

1. A node that notices the leader is gone builds an `ELECTION` message containing **its own id** and sends it to its successor.
2. Each node receiving an `ELECTION` message compares the id inside to its own:
   - Chang–Roberts optimization: it forwards the message only if the contained id is **higher** than its own; if its own id is higher, it substitutes its own id (or, in the "only forward if higher" variant, swallows the lower-id message and starts its own). Lower-id initiators' messages are absorbed, so only the eventual winner's id survives.
3. When a node receives an `ELECTION` message carrying **its own** id, it knows its id made it all the way around — it is the highest, and therefore the leader. It then circulates a `COORDINATOR` (elected) message around the ring so everyone records the winner.

### Worked walk-through

Ring order 1 → 2 → 3 → 4 → 5 → (back to 1). Say the leader was external and nodes 3 and 5 both notice and initiate simultaneously (the algorithm handles concurrent initiators).

```
Ring:  1 → 2 → 3 → 4 → 5 → (1)

Node 3 starts:  sends ELECTION(3) → 4
Node 5 starts:  sends ELECTION(5) → 1

At node 4: gets ELECTION(3); 4 > 3 → replace, send ELECTION(4) → 5
At node 5: gets ELECTION(4); 5 > 4 → replace, send ELECTION(5) → 1
At node 1: gets ELECTION(5); 5 > 1 → forward ELECTION(5) → 2
           (node 1's own initiated ELECTION(5) from node 5 also here)
At node 2: gets ELECTION(5); 5 > 2 → forward ELECTION(5) → 3
At node 3: gets ELECTION(5); 5 > 3 → forward ELECTION(5) → 4
At node 4: forward ELECTION(5) → 5
At node 5: gets ELECTION(5) == own id → 5 IS THE LEADER

Node 5 then circulates COORDINATOR(5) all the way around:
   5 → 1 → 2 → 3 → 4 → 5,  each records "leader = 5".
```

The Chang–Roberts optimization — forwarding only ids larger than your own — guarantees that concurrently-initiated elections collapse into a single survivor (the global maximum) rather than N independent winners, and it drops the message count. With that optimization the algorithm uses **O(n)** messages in the best case and **O(n²)** in the worst (many initiators arranged adversarially); a naive unoptimized ring is O(n²). The `COORDINATOR` lap adds another n.

Ring election's weakness is the same as any ring's: it assumes the ring stays intact. A single dead node breaks the ring unless nodes maintain knowledge of their successor's successor to route around failures — which reintroduces failure detection and complexity. Rings are elegant on paper and rare in production leader election precisely because a topology that a single failure can sever is fragile; real systems use quorum-based election instead.

---

## 70.7 Algorithm Comparison and Message Complexity

Consolidating the classic algorithms before turning to what real databases actually do:

| Algorithm | Topology | Winner | Msg complexity (worst) | Partition-safe? | Notes |
|---|---|---|---|---|---|
| **Bully** | all-to-all | highest id | O(n²) | No | re-preempts on high-id recovery; needs synchronous timeouts |
| **Bully + successor list** | all-to-all | highest live | O(n) common | No | precomputed failover order |
| **Invitation** | groups | deterministic on merge | higher | **Yes** (merges) | reconciles after partition heal |
| **Ring (Chang–Roberts)** | logical ring | highest id | O(n²), O(n) best | No | fragile to node death breaking ring |
| **Raft/ZAB election** | quorum (majority) | most up-to-date log, majority vote | O(n) per round | **Yes** (quorum) | epoch/term + randomized timeout; §70.14 |
| **ZooKeeper znode** | ephemeral seq znodes | lowest sequence number | O(n) with watches | **Yes** (via ZAB) | herd-effect-free "next-lowest watch" recipe; §70.13 |

The crucial column is **partition-safe**. Bully and ring elect the highest id *among nodes they can reach* — so under a partition each side reaches a different maximum and elects a different leader: split-brain. The quorum-based approaches (Raft, ZAB, and everything built on them) are partition-safe because election requires a **majority**, and a minority partition simply cannot assemble one (§70.10). This is *the* reason production systems abandoned the textbook algorithms: **highest-id-wins is not safe under partitions; majority-wins is.**

A second axis the table hides: the classic algorithms elect on **identity** (a static priority), whereas real replication systems elect on **freshness** — the winner must have the most up-to-date log, because an out-of-date leader would lose committed writes (Ch. 74 §74.6, Raft's election restriction). Electing the highest-id node is fine when nodes are interchangeable; electing a *replica* requires electing one whose data is current.

---

## 70.8 Epochs, Terms, and Fencing Tokens

Here is the single most important idea in the chapter, the one that makes leadership *safe* despite the impossibility of §70.3: **attach a monotonically increasing number to each leadership reign, and reject anything stamped with an old number.**

This number goes by many names — **epoch** (ZooKeeper/ZAB, Kafka), **term** (Raft), **ballot/proposal number** (Paxos), **view number** (viewstamped replication), **generation** (various), **configuration version**. They are the same idea:

- Every time a new election succeeds, the epoch counter increments: reign 1, reign 2, reign 3, ….
- The leader **stamps every message and every write with its epoch**.
- A follower **remembers the highest epoch it has ever seen** and **rejects any message from a lower epoch**.

The consequence: a leader from epoch 5 that was deposed and whose successor now runs epoch 6 becomes *harmless* the moment any node that has seen epoch 6 receives an epoch-5 message — it replies "your epoch is stale, I've moved on," and the old leader learns it must step down. Two nodes may *believe* they are leader, but only one holds the *current* epoch, and the current epoch is unique because a new epoch is minted only by a fresh majority election.

### The GC-pause / paused-leader scenario

Epochs alone protect *messages between cooperating nodes*, but the classic split-brain danger is a leader that acts on an **external resource** — a shared storage volume, a database, a lock file — while paused. The canonical story (from Ch. 69 §69.5 on the perils of process pauses):

```
t0  Leader L1 (epoch 5) holds the lease, is about to write to shared storage.
t1  L1 suffers a stop-the-world GC pause (or is descheduled) for 15 seconds.
t2  Followers' lease on L1 expires; they run an election.
t3  L2 (epoch 6) is elected, takes the lease, and starts writing to storage.
t4  L1's GC pause ends. L1 has NO IDEA time passed. It believes it is
    still the epoch-5 leader and completes its pending write to storage.
        ┌──────────────────────────────────────────────┐
        │  Now BOTH L1 (stale) and L2 (current) write.  │  ← corruption
        └──────────────────────────────────────────────┘
```

L1 never received an epoch-6 message — it went straight from "I'm leader" to "writing." The lease expiring on the *followers* does nothing to stop L1's write, because storage is a dumb third party that does not know about epochs.

### Fencing tokens

The fix is a **fencing token**: the lock/lease service hands each leader a monotonically increasing token (which *is* the epoch), and the **protected resource itself checks the token and rejects any operation carrying a token lower than the highest it has seen.**

```
Lock service issues tokens:   L1 gets token 33,  later L2 gets token 34.

  L2 ──write(token=34)──▶ storage   → storage records "highest seen = 34", accepts
  L1 ──write(token=33)──▶ storage   → 33 < 34 → storage REJECTS the stale write
```

Now L1's post-pause write is fenced off at the resource, not by trusting L1 to behave. The essential requirements:

- The token must be **monotonic** (each new leader's token strictly exceeds all previous). A fresh-majority-minted epoch satisfies this.
- The **resource must enforce it** — the check has to live at the storage/database/service that performs the side effect. A token nobody validates is decorative. This is why fencing needs cooperation from the downstream system (an object store that supports conditional writes, a database that rejects stale generations, a SAN that supports SCSI reservations).

**Real-world:** HDFS NameNode HA uses fencing to stop a deposed NameNode from writing to the shared edit log. Google's Chubby and ZooKeeper hand out monotonic sequence numbers precisely so clients can fence. etcd's `revision`/lease and Raft's `term` play the token role internally. The interview one-liner: **an epoch makes stale leaders reject-able by peers; a fencing token makes them reject-able by resources — you need both, because the dangerous action is often against a resource that does not speak your consensus protocol.**

---

## 70.9 Split-Brain

**Split-brain** is the failure where **two (or more) nodes simultaneously believe they are the legitimate leader and both act on that belief** — accepting writes, mutating shared state. It is the safety violation of §70.2 realized, and it is the reason leader election is a hard problem rather than a lookup.

The textbook trigger is a **network partition**:

```
        ┌─────────────── partition ───────────────┐
        │                                          │
   ┌────┴────┐                              ┌───────┴──────┐
   │ A  B  C │   ✗ no packets cross ✗       │   D    E     │
   │ (had    │                              │ (cut off from│
   │  leader │                              │  the leader) │
   │  A)     │                              │              │
   └─────────┘                              └──────────────┘

  Naive Bully/ring on each side:
    Left side: A is still reachable → A stays leader.
    Right side: D, E can't reach A → they elect a new leader (say E).
  Result: A and E both accept writes → two divergent histories.
```

When the partition heals, the two histories conflict: which writes are real? For an append-only log they diverge irreconcilably; for a key-value store you get last-writer-wins data loss. There is no clean automatic merge in general — split-brain often means **data loss or manual repair**.

The three lines of defense, in order of how much you should rely on them:

1. **Quorums / majorities (the primary defense, §70.10).** Require a majority to elect *and* to commit. In the picture above, `{A,B,C}` is a majority of 5 and can keep operating; `{D,E}` is a minority and *cannot* elect a leader that can commit. Split-brain-with-two-*active*-leaders is prevented because two majorities cannot be disjoint.
2. **Fencing / epochs (§70.8).** Even if a stale leader briefly believes it leads, its epoch/token is old, so peers and resources reject its actions.
3. **STONITH / infrastructure fencing (§70.11).** As a last resort, physically kill or isolate the suspected old leader so it *cannot* act at all.

The subtle point interviewers push on: **quorum prevents two nodes from both *committing*, but it does not by itself prevent two nodes from both *thinking* they are leader.** The minority-side node E may believe it is a leader candidate; what stops disaster is that it can never gather a majority to commit, and fencing stops it from mutating shared resources. Safety comes from constraining *action*, not *belief*.

---

## 70.10 Quorums and Majorities

A **quorum** is the minimum number of nodes that must participate in an operation for it to count. Leader election and commit both use a **majority quorum**: strictly more than half of the members, `⌊n/2⌋ + 1`.

The property that makes majorities work is **intersection**: any two majorities of the same set of `n` nodes **share at least one member**. Two subsets each of size `> n/2` cannot be disjoint, because disjoint would need `> n` members total. That single member is the linchpin:

- **Election safety.** A candidate becomes leader only after a majority *votes* for it in a given epoch. Each node votes for at most one candidate per epoch. If two candidates both won the same epoch, their two vote-majorities would intersect in a node that voted twice — contradiction. Therefore **at most one leader can win a given epoch.** (Ch. 74 §74.5 for Raft's exact rule.)
- **Commit safety across partitions.** A minority partition has `≤ n/2` reachable nodes and can never assemble a majority, so it cannot elect a committing leader or commit a write. Only the majority side (at most one exists) makes progress.

```
n = 5.  Majority = 3.
Any partition splits 5 into groups; at most ONE group has ≥ 3:
    5+0, 4+1, 3+2   → one side has a majority
    (never 3+3, impossible with 5 nodes)
Only the side with ≥ 3 can elect a leader and commit. The other side
is read-only-at-best and cannot cause split-brain writes.
```

Design consequences that show up in interviews:

- **Odd cluster sizes are preferred.** With `n = 4`, majority is 3, and you tolerate only 1 failure — the same as `n = 3` (majority 2), but with more nodes to coordinate and a *larger* chance of a 2-2 partition where *nobody* has a majority (loss of liveness). `n = 5` tolerates 2 failures. Fault tolerance is `⌊(n−1)/2⌋`, so add nodes in odd steps: 3 tolerates 1, 5 tolerates 2, 7 tolerates 3.
- **The even-split deadlock.** A 2-2 split of a 4-node cluster, or a data-center-vs-data-center split of a 2+2 deployment, leaves *no* majority and the whole system halts (safe but unavailable). Deploying across **three** failure domains, or using a lightweight tie-breaker (an arbiter / witness / voting-only member — MongoDB arbiters, ZooKeeper observers-turned-voters, an etcd node in a third AZ), avoids the symmetric split.
- **Quorum for reads too.** Serving a linearizable read from the leader assumes the leader is *still* leader; a partitioned old leader might not be. Either confirm leadership with a quorum round (ReadIndex, Ch. 74) or rely on a lease (§70.12).

The generalization is **flexible quorums**: reads use `R` nodes, writes use `W`, and any `R + W > N` guarantees a read overlaps every write. Leader election is the special case `W = R = majority`, and Raft/ZAB use exactly that.

---

## 70.11 Fencing at the Infrastructure Level: STONITH

Software fencing (epochs, tokens) assumes the deposed leader is *cooperative enough* to check its token or receive a rejection. When it might not be — buggy, hung at a layer below your code, or writing to a resource that cannot validate tokens — you fence at the **infrastructure** level. This is the domain of classic **HA clustering** (Pacemaker/Corosync, Linux-HA), and its blunt instrument is **STONITH**: *Shoot The Other Node In The Head.*

STONITH means the cluster, upon deciding a node is the *former* leader, **forcibly powers it off or isolates it** before promoting the new leader — via:

- **Power fencing** — an IPMI/iLO/DRAC out-of-band controller or a network-controlled PDU cuts power to the suspect machine.
- **Storage fencing** — SCSI-3 persistent reservations or fabric zoning revoke the node's access to the shared disk, so even if it is alive it cannot write.
- **Network fencing** — a switch port is disabled to cut the node off entirely.

```
Failover with STONITH (shared-storage HA):

  1. Cluster detects leader L1 unresponsive.
  2. BEFORE promoting L2, cluster STONITHs L1  ── power off / revoke SAN access ──▶ L1
  3. Only after L1 is confirmed dead/isolated does L2 take the shared volume.

  This guarantees L1 cannot wake from a pause and write to the volume,
  because there is no L1 anymore (or it has no path to the disk).
```

The reason STONITH exists: a **shared-storage** HA setup (one volume, active/standby database) has no epoch check *inside the volume* — the disk will happily accept writes from whichever host sends them. Since the resource cannot fence itself, the cluster must guarantee at most one writer by *destroying* the other. STONITH is the physical-world analog of a fencing token for resources too dumb to check one.

The trade-off: STONITH can itself cause an outage if the fencing device is unreachable (the cluster may refuse to promote until it can confirm the kill — "fence or freeze"), and a **fencing race** (both nodes try to STONITH each other) needs a delay/priority to avoid mutual shootout. Modern quorum-based systems (etcd/Raft) mostly *avoid* needing STONITH by never sharing mutable storage — each replica owns its own copy and safety comes from quorum + epoch — which is a big reason they displaced shared-storage HA.

---

## 70.12 Leases: Time-Bounded Leadership

A **lease** is leadership with an expiry: the leader holds the role only for a bounded time and must **renew** before it lapses. Leases convert the unbounded question "is the leader still alive?" into a bounded, local one: "has my lease expired on my own clock?"

The mechanism:

```
Leader acquires lease at t0 for duration D (e.g. 10 s).
   Leader must renew (heartbeat to the quorum / lock service) before t0 + D.

  Leader's timeline:  |--acquire--|--serve--|--renew--|--serve--|--renew--|...
  If a renew fails (or the leader is partitioned), the lease lapses at t0+D,
  and after that no one grants a NEW lease until the old one is known expired.
```

Leases give three things:

- **Automatic, timeout-based failover.** If the leader dies or is partitioned, its lease simply expires and a new election proceeds — no explicit "leader is dead" agreement needed beyond the clock.
- **Efficient reads.** A leader that holds a valid lease *knows* no other leader has been granted one (nobody else could get a lease while this one is outstanding), so it can serve reads locally without a quorum round — the **leader lease** / **leader lease read** optimization (Ch. 74 §74.8). This is a major throughput win and the main reason production Raft systems add leases.

But leases rest on a **clock-drift assumption**, and this is where they get dangerous (Ch. 35 on clocks). The follower and leader reason about the *same* duration D on *different* physical clocks:

- If the granter's clock and the holder's clock drift apart, the holder may believe its lease is still valid *after* the granter considers it expired and has handed leadership to someone else — reopening the two-leaders window.
- Correct lease protocols therefore require a **bounded clock drift** (e.g. "clocks drift by at most ε") and build in **safety margins**: the leader treats its lease as expiring *earlier* than the granter does, by more than the max drift plus max message delay. Using a **monotonic** clock for the renew interval (not wall-clock, which NTP can step; Ch. 35 §35.4) is essential.
- A leader that is *paused* (GC, §70.8) may resume believing its lease is still valid — which is exactly why **leases are not a substitute for fencing tokens.** A lease bounds the *common-case* window; a fencing token protects against the *pathological* one. Google's Chubby and Spanner (TrueTime) invest heavily in exactly this clock-uncertainty reasoning.

The interview framing: **a lease is a timeout you can reason about locally, bought with an assumption about clock drift; it makes failover automatic and reads cheap, but because clocks can lie and processes can pause, a lease must be backed by an epoch/fence for safety, never trusted alone.**

---

## 70.13 Real Systems I: ZooKeeper Ephemeral-Znode Election

**ZooKeeper** is the workhorse coordination service, and its election "recipe" is worth knowing cold because dozens of systems (older Kafka, HBase, Solr, Hadoop) delegate their leader election to it. ZooKeeper itself is a replicated state machine kept consistent by **ZAB** (ZooKeeper Atomic Broadcast), a leader-based protocol with epochs — so ZooKeeper *internally* elects its own leader by quorum, and *externally* offers primitives that clients use to elect *their* leaders.

The two primitives are **ephemeral** and **sequential** znodes plus **watches**:

- An **ephemeral znode** exists only while the session that created it is alive; if that client's session times out (its heartbeats stop), ZooKeeper **automatically deletes** the znode. This is a built-in, quorum-backed failure detector and lease rolled together.
- A **sequential znode** gets a monotonically increasing suffix appended by ZooKeeper (`leader-0000000001`, `leader-0000000002`, …) — a server-assigned, gap-monotone order that doubles as a **fencing token / epoch**.

### The election recipe

```
Each candidate creates an EPHEMERAL SEQUENTIAL znode under /election:
   /election/n_0000000003   (created by client C)
   /election/n_0000000004   (created by client D)
   /election/n_0000000005   (created by client E)

Rule: the candidate whose znode has the LOWEST sequence number is the LEADER.
   → n_0000000003 (client C) is leader.

When C's session dies, /election/n_0000000003 is auto-deleted (ephemeral).
The next-lowest (n_0000000004, client D) becomes leader.
```

The naive way for a follower to notice leadership change is to **watch the current leader's znode**. But if *all* followers watch the single leader znode, its deletion wakes *all* of them at once — the **herd effect** (a thundering herd, Ch. 33 §33.x): N clients simultaneously re-read `/election`, hammering the ensemble, when only one of them will actually become leader.

The **herd-free recipe** fixes this: each candidate watches **only the next-lower znode**, not the leader's:

```
   n_0003 (leader)   ◀── watched by n_0004
   n_0004            ◀── watched by n_0005
   n_0005            ◀── watched by n_0006

When leader n_0003 dies, ONLY n_0004's watch fires. n_0004 checks: am I now
the lowest? Yes → I am leader. Nobody else is woken.
If instead n_0004 (a middle node) dies, only n_0005 wakes, re-points its watch
to n_0003, and goes back to waiting. Exactly one watch fires per deletion.
```

This is the same construction as ZooKeeper's **distributed lock** recipe (a lock is just "leadership over a resource"). The properties it delivers: exactly-one leader as long as ZooKeeper's own quorum holds; automatic failover via ephemeral session expiry; a built-in fencing token (the sequence number, or the znode's `zxid`/version, which clients pass to resources); and no thundering herd. The cost is a dependency on a separate, correctly-sized (typically 3 or 5 node) ZooKeeper ensemble and sensitivity to **session timeout tuning** — too short and GC pauses cause spurious failovers (§70.18), too long and real failures take long to detect.

---

## 70.14 Real Systems II: etcd and Raft Leader Election

**etcd** (the coordination store behind Kubernetes) uses **Raft** (Ch. 74) directly, and Raft's leader election is the cleanest quorum-based election to know.

Raft divides time into **terms** (the epochs of §70.8), each beginning with an election. Every node is in one of three states: **follower**, **candidate**, **leader**. The mechanism:

1. **Heartbeats & timeout.** The leader sends `AppendEntries` heartbeats. Each follower runs a **randomized election timeout** (e.g. 150–300 ms). If a follower's timeout elapses without a heartbeat, it suspects the leader is dead.
2. **Become candidate.** The follower increments its term (`term → term+1`), votes for itself, and sends `RequestVote(term, lastLogIndex, lastLogTerm)` to all peers.
3. **Vote.** Each node grants at most **one** vote per term, and only to a candidate whose log is **at least as up-to-date** as its own (the *election restriction* — this guarantees the new leader has every committed entry; Ch. 74 §74.6). It also updates its own term if the candidate's is higher.
4. **Win.** A candidate that collects votes from a **majority** becomes leader for that term and immediately sends heartbeats to assert authority and suppress other candidates.
5. **Randomization breaks ties.** If two candidates split the vote (neither gets a majority), both time out again — but because timeouts are **randomly** chosen, one will almost surely fire first next round and win uncontested. This is the randomization escape from FLP (§70.3) made concrete.

```
Term 4 leader (node A) crashes.
  Node B's random timeout (170 ms) fires first.
  B: term 4→5, votes for self, RequestVote(term=5, ...) → C, D, E
  C, D each grant (B's log is current, they haven't voted in term 5) → 3 votes = majority of 5
  B becomes leader for term 5, sends heartbeats.
  If E had also timed out and become a candidate for term 5, it would see
  B's heartbeat with term 5 ≥ its own, recognize a leader exists, and revert
  to follower. At most one leader per term — guaranteed by majority voting.
```

**Safety** is unconditional: at most one leader per term (majority intersection, §70.10), and the leader has all committed entries (election restriction). **Liveness** holds under partial synchrony: as long as one node's timeout fires without contention, an election completes. The whole design is §70.2–§70.10 realized: monotonic terms, majority quorum, freshness-based winner, randomized timeouts.

**Patroni-relevant note:** etcd exposes this as a linearizable key-value store. Clients (like Patroni, next section) don't run Raft themselves; they use etcd's atomic **compare-and-swap** and **leases** on a key to elect *their* leader, riding on etcd's already-elected internal leader.

---

## 70.15 Real Systems III: PostgreSQL HA via Patroni

PostgreSQL has no built-in cluster leader election — a Postgres primary doesn't know about its replicas' health or coordinate failover. **Patroni** is the de-facto HA template that adds it, and it is a clean example of **election by lease on a consistent store** rather than by a peer-to-peer algorithm.

Patroni delegates the hard part — consensus — to a **Distributed Configuration Store (DCS)**: etcd, Consul, ZooKeeper, or Kubernetes. The design:

```
       ┌──────────── DCS (etcd, quorum-consistent) ────────────┐
       │   key /service/mycluster/leader = "node-A"  (TTL 30s) │
       └───────────────────────────────────────────────────────┘
            ▲ renew every ~10s            ▲ watch / poll
            │                             │
   ┌────────┴────────┐          ┌─────────┴─────────┐
   │ node-A  PRIMARY │          │ node-B  REPLICA   │
   │ Patroni agent   │          │ Patroni agent     │
   └─────────────────┘          └───────────────────┘
```

1. **Leader key + lease.** The primary holds a **leader key** in the DCS with a **TTL** (time-to-live, e.g. 30 s). Its Patroni agent **renews** the key every `loop_wait` (~10 s). The key is a lease (§70.12); the DCS's own consensus (etcd/Raft) guarantees only one holder.
2. **Failure → key expiry.** If the primary dies or is partitioned from the DCS, it stops renewing. After the TTL, the leader key **expires** and disappears.
3. **Election via atomic create.** Replica agents, seeing no leader key, **race to create it** using the DCS's atomic compare-and-set (create-if-absent). The DCS's linearizability ensures **exactly one** wins. Patroni also checks replica health/lag (WAL position) so it promotes the most up-to-date replica, echoing Raft's freshness rule (§70.14).
4. **Promotion.** The winner runs `pg_promote()` to turn its Postgres replica into a primary; the losers reconfigure to replicate from the new primary.

The safety hinges on the DCS: **because acquiring the leader key requires an atomic operation against a quorum-backed store, two Patroni nodes cannot both hold it.** Patroni also implements **fencing**: an optional `watchdog` (a hardware/software timer) reboots the old primary if its Patroni process fails to demote it in time — a STONITH-lite (§70.11) that stops a partitioned old primary from serving stale writes. Without the DCS quorum (e.g. if the etcd cluster loses its own majority), Patroni **refuses to promote** — availability is sacrificed for safety, the correct choice.

The lesson: **you can get correct leader election without implementing an election algorithm, by leaning on a lease in a linearizable store that already solved consensus internally.** This "elect via a lock service" pattern (Chubby's original purpose) is how most stateful services outside the consensus systems themselves do HA.

---

## 70.16 Real Systems IV: Redis Sentinel

**Redis Sentinel** provides HA for classic (non-cluster) Redis master-replica setups, and it is instructive because its election is **quorum-based but with a subtlety that has historically allowed data loss.**

Sentinels are separate processes that monitor Redis masters and replicas. The flow:

1. **Subjective down (SDOWN).** A sentinel that stops getting `PING` replies from the master marks it `SDOWN` — *its own* opinion (a local failure detector, Ch. 69).
2. **Objective down (ODOWN).** Sentinels gossip; when a configurable **quorum** of sentinels agree the master is down, it is declared `ODOWN`. The `quorum` parameter is *how many sentinels must agree to start a failover*.
3. **Leader sentinel election.** The sentinels then elect a **leader sentinel** to run the failover, using a Raft-like term/epoch vote requiring a **majority of all sentinels** (note: majority, distinct from the `quorum` in step 2). Only the elected leader sentinel performs the promotion, preventing multiple concurrent failovers.
4. **Promote a replica.** The leader sentinel picks the best replica (by replication offset — freshness again) and issues `REPLICAOF NO ONE` to promote it, then repoints the others.

Two quorums are in play and conflating them is a classic mistake: the **`quorum` value** authorizes *detecting* failure and *starting* a failover; the **majority of sentinels** is required to *elect the sentinel leader* that actually does it. You need at least 3 sentinels (typically across 3 hosts) so a majority survives one failure.

The important caveat, and a favorite trap: **Redis async replication means Sentinel failover can lose acknowledged writes.** A master acks a write to the client *before* replicating it; if the master fails before propagating, the promoted replica never saw that write and it is lost. Sentinel provides *availability* failover, not *consistency* — it does not do quorum writes, and there is no fencing token stopping the old master from accepting a few more writes during the failover window (`min-replicas-to-write` mitigates but does not eliminate this). Contrast with Raft-based systems where a write is committed only after a majority has it, so failover never loses committed data. The interview point: **Sentinel elects a leader safely (majority vote) but the underlying replication is asynchronous, so leadership is consistent while the data is not.**

---

## 70.17 Real Systems V: MongoDB and the Kafka Controller

**MongoDB replica-set election** is essentially **Raft** (its protocol version 1 is Raft-derived). A replica set has one **primary** and several **secondaries**:

- Members exchange heartbeats; if a secondary misses the primary's heartbeats beyond `electionTimeoutMillis` (default 10 s), it stands for election.
- A candidate needs votes from a **majority** of voting members and can win only if its **oplog is sufficiently up-to-date** (freshness restriction, §70.14). Each election bumps the **term**.
- **Priority** biases *which* eligible member tends to win (a config knob), and **arbiters** are voting-only members with no data, used to break even-split ties cheaply — a tie-breaker (§70.10) rather than a data replica.
- Because it requires a majority, a minority partition demotes its primary to secondary (it can't confirm it still has a majority) — **MongoDB steps down primaries that lose quorum**, preventing split-brain writes. Writes with `w:majority` are only acked once a majority has them, so failover doesn't lose majority-committed data.

**Kafka's controller** is a different flavor — electing a leader for a *management role*, not a data replica:

- Historically (pre-2.8), Kafka brokers used **ZooKeeper** to elect a single **controller** broker via the ephemeral-znode recipe (§70.13): the broker that successfully creates the `/controller` ephemeral znode is controller; if it dies the znode vanishes and brokers race to recreate it. The controller manages partition **leader election for the topic partitions themselves** (choosing an in-sync replica as each partition's leader) and cluster metadata.
- Kafka also has the **ISR (in-sync replica) list** and epoch concept: a partition leader is chosen from the ISR, and a **leader epoch** number fences stale leaders (a producer/consumer with an old leader epoch is rejected) — §70.8 in action at the partition level.
- Since **KRaft** (KIP-500, Kafka 2.8+/3.x), Kafka **replaced ZooKeeper with its own Raft implementation** for the controller quorum: a set of controller nodes run Raft to elect a controller leader and store metadata as a replicated log — folding the external dependency into a native quorum, exactly the etcd/Raft model of §70.14.

Two levels of election appear here and the interview reward is separating them: the **controller** election (who manages the cluster) and, beneath it, **per-partition leader** election (which replica serves each partition). The controller *runs* the per-partition elections; the controller itself is elected by ZooKeeper (old) or Raft (KRaft, new).

---

## 70.18 Election Storms, Flapping, and Damping

An **election storm** (or leader **flapping**) is repeated, rapid leadership change that starves the system of useful work — every election is a write pause (§70.1), so a cluster stuck electing is a cluster that is effectively down while looking "up." Causes and cures:

**Causes:**

- **Timeouts too aggressive relative to real latency.** If the election timeout is shorter than a normal GC pause, a network hiccup, or a `fsync` stall, healthy leaders are declared dead constantly. This is the failure-detector tuning problem of Ch. 69 §69.4 (the accrual detector and the timeout/accuracy trade-off) applied to election.
- **Symmetric timeouts.** If all followers time out at the same instant, they all become candidates, split the vote, no one gets a majority, everyone retries — livelock. (Raft's randomized timeouts, §70.14, exist precisely to prevent this.)
- **The Bully re-preemption churn (§70.4).** A flapping high-id node repeatedly returns, bullies its way to leader, dies, returns — thrashing. Priority-based schemes have the same pathology.
- **A partially-partitioned or overloaded leader** that can serve heartbeats intermittently, so it is alternately declared alive and dead.

**Damping techniques:**

- **Randomized (jittered) election timeouts** — the primary fix for symmetric livelock; spread out who becomes a candidate. (Raft, §70.14.)
- **Generous, well-tuned timeouts and phi-accrual detection** — set the timeout above the 99.9th-percentile of pause/latency so transient stalls don't trigger elections (Ch. 69). ZooKeeper session timeouts and etcd/Raft heartbeat intervals are tuned exactly here.
- **Leader stickiness / hysteresis** — bias toward keeping the current leader. Raft's *leader stickiness* (a follower that has recently heard from a leader rejects `RequestVote` even if it gets one — the *PreVote* extension) stops a partitioned node whose term kept incrementing from disrupting a healthy leader when it rejoins. **PreVote**: a candidate first checks it *could* win before bumping the term, so a flapping node doesn't force term inflation and needless re-elections.
- **Failback suppression / cooldowns** — after a failover, refuse to fail back to a recovered node for a cooldown period; don't let a node that just flapped immediately reclaim leadership. Patroni's `failover`/`switchover` distinction and `master_start_timeout` embody this.
- **Backoff on repeated elections** — exponentially increase timeouts if elections keep failing, so a persistently unstable cluster stops thrashing and gives the network time to settle.

The unifying principle: **stability beats optimality.** A slightly-slower-to-fail-over cluster that stays on one leader crushes a twitchy one that "optimally" re-elects on every microstall. Every knob above trades detection latency for stability, and production tuning lives on that curve.

---

## 70.19 Putting It Together: A Decision Checklist

When a design question asks "how do you elect a leader," a strong answer walks these axes rather than naming one algorithm:

1. **Do you even need a leader?** Total order / single writer → yes. Write-availability-under-partition above all → consider leaderless (Ch. 71). 
2. **What is the electorate and quorum?** Odd number of voters (3/5/7), across ≥3 failure domains to survive a data-center split; observers/arbiters as tie-breakers, not voters that add fault tolerance.
3. **How do you detect failure?** A tuned, jittered timeout / phi-accrual detector (Ch. 69) above your pause and latency tails.
4. **How is safety enforced?** Majority quorum for election *and* commit (intersection ⇒ one leader per epoch) + monotonic **epoch/term** on every message.
5. **How do you protect external resources?** **Fencing tokens** validated by the resource; STONITH/watchdog for resources too dumb to check.
6. **How do you make reads cheap and failover automatic?** **Leases**, with a bounded-clock-drift assumption and safety margins — backed by, never replacing, fencing.
7. **How do you stay stable?** Randomized timeouts, PreVote/stickiness, cooldowns to damp storms.
8. **Do you build it or borrow it?** Prefer leaning on an existing consensus store (etcd/ZooKeeper/Consul) via a leader key + lease (Patroni model) over hand-rolling a partition-unsafe Bully/ring.

Nearly every real system in this chapter is a different point in that space, but they all agree on the load-bearing parts: **majority quorum, monotonic epochs, fencing.**

---

## Summary

- A **leader** serializes decisions so followers need not coordinate on every write — buying simplicity, a single point of ordering, and cheap reads, at the cost of a single point of failure, an election-window write pause, a throughput ceiling, and the split-brain hazard.
- Correctness is **safety** (at most one *active* leader per epoch) and **liveness** (eventually some leader). "Exactly one leader, continuously" is **impossible** (FLP, Ch. 68) because a crashed node is indistinguishable from a slow/partitioned one; systems settle for safety-always, liveness-under-partial-synchrony.
- The **classic algorithms** — **Bully** (highest id wins, O(n²), re-preempts on recovery) and **Ring/Chang–Roberts** (id circulates, O(n)–O(n²)) — elect on static identity and are **not partition-safe**: each side of a partition elects its own leader.
- **Epochs/terms** (monotonic reign numbers stamped on every message; peers reject stale ones) plus **fencing tokens** (monotonic tokens the *resource* validates) are what make leadership safe despite paused/deposed leaders — the GC-pause two-writers scenario is fenced at the resource, not by trusting the old leader.
- **Split-brain** (two active leaders) is prevented primarily by **majority quorums**: two majorities of a set always intersect, so at most one leader can be elected per epoch and a minority partition can never commit. Odd cluster sizes and ≥3 failure domains avoid even-split deadlock.
- **Leases** give time-bounded leadership (automatic failover, local reads) but rest on a **bounded-clock-drift** assumption (Ch. 35) and must be backed by fencing, never trusted alone; **STONITH** physically fences resources too dumb to check a token.
- Real systems: **ZooKeeper** ephemeral-sequential znodes with next-lower watches (herd-free, ZAB-backed); **etcd/Raft** terms + randomized timeouts + majority + freshness restriction; **Patroni** leader key + TTL lease in a DCS; **Redis Sentinel** majority sentinel election over async replication (consistent leader, lossy data); **MongoDB** Raft-like majority election with steps-down-on-quorum-loss; **Kafka** controller (ZooKeeper znode → KRaft/Raft) plus per-partition leader-epoch fencing.
- **Election storms** come from over-aggressive or symmetric timeouts; damp with randomized timeouts, PreVote/stickiness, generous phi-accrual detection, and failback cooldowns — **stability beats optimality.**

---

## Key Interview Questions

1. **Why designate a leader at all?** — To serialize decisions: one node assigns a total order to writes so followers just replay it, giving simplicity (one authoritative history), a single source of monotonic sequence numbers, and cheap local reads. The costs are a single point of failure, an election-window write pause, a write-throughput ceiling, and the split-brain risk.
2. **What are the safety and liveness goals of leader election?** — Safety: at most one node acts as leader at a time (achievably: at most one *active* leader per epoch). Liveness: eventually some node becomes leader and progress resumes. Safety must hold unconditionally; liveness only under partial synchrony.
3. **Why is guaranteeing exactly one leader at all times impossible?** — By FLP, consensus (and electing a leader is consensus) can't be guaranteed in an asynchronous system with even one crash. You cannot distinguish a crashed leader from a slow/partitioned one, so any timeout-based decision can be wrong, producing two leaders. Systems target safety-always + liveness-under-partial-synchrony instead.
4. **How does the Bully algorithm work?** — A node that notices the leader is gone sends ELECTION to all higher-id nodes; if none answer it declares itself leader (COORDINATOR to all lower ids); if a higher node answers, it stands down and that node runs its own election. Highest live id always wins, and a returning higher-id node bullies the incumbent out.
5. **What is Bully's message complexity and its main weaknesses?** — O(n²) messages worst case (lowest-id initiator cascades). Weaknesses: assumes synchronous reliable delivery and known timeouts, is not partition-safe (each side elects its own max), and re-preempts on high-id recovery, causing churn.
6. **How does the Ring (Chang–Roberts) algorithm elect a leader?** — Nodes form a logical ring; an ELECTION message carrying the initiator's id circulates, each node substituting/forwarding the higher id (dropping lower ones). When a node sees its own id return, it's the max and becomes leader, then circulates a COORDINATOR lap. O(n) best, O(n²) worst; fragile because a dead node breaks the ring.
7. **Why did real databases abandon Bully and Ring for quorum-based election?** — Bully and ring elect the highest id *among reachable nodes*, so a partition makes each side elect a different leader — split-brain. Quorum election requires a majority, which a minority partition can never assemble, so at most one leader per epoch can be elected. Quorum is partition-safe; highest-id-wins is not.
8. **What is an epoch/term and what problem does it solve?** — A monotonically increasing number attached to each leadership reign (term in Raft, epoch in ZAB/Kafka, ballot in Paxos), stamped on every message. Nodes remember the highest epoch seen and reject anything older, so a deposed leader's messages are rejected as stale the moment a peer that has advanced receives them.
9. **What is a fencing token and why isn't an epoch enough?** — A fencing token is a monotonic number the *protected resource itself* validates, rejecting operations carrying a token lower than the highest it has seen. An epoch protects messages between cooperating nodes, but a paused leader may write to an external resource (storage, DB) without ever receiving a newer-epoch message; the resource must fence it.
10. **Walk through the GC-pause two-leaders scenario.** — Leader L1 (epoch 5) pauses for a stop-the-world GC; its lease expires, L2 (epoch 6) is elected and starts writing to shared storage; L1's pause ends and, unaware time passed, it completes its write — now two writers corrupt the data. Fencing tokens fix it: storage rejects L1's lower token.
11. **What is split-brain and how is it prevented?** — Two or more nodes simultaneously believing they're leader and both accepting writes, producing divergent histories (data loss / manual repair). Prevented primarily by majority quorums (two majorities intersect, so only one leader per epoch can commit), backed by epochs/fencing and, at the infra level, STONITH.
12. **Why do majority quorums prevent two active leaders?** — Any two majorities of the same node set share at least one member, and each node votes for at most one candidate per epoch. Two candidates both winning the same epoch would require a shared voter to have voted twice — impossible — so at most one leader wins per epoch; a minority partition can't form a majority at all.
13. **Why are odd cluster sizes preferred, and what is the even-split problem?** — Fault tolerance is ⌊(n−1)/2⌋, so 3 tolerates 1 and 5 tolerates 2; an even n (e.g. 4) tolerates the same failures as n−1 but adds even-split risk. A symmetric partition (2-2) leaves no majority and halts progress — safe but unavailable — so deploy across ≥3 failure domains or add an arbiter/witness.
14. **What is a lease and what does it buy you?** — Time-bounded leadership: the leader holds the role for a bounded duration and must renew before expiry. It makes failover automatic (a lapsed lease triggers re-election with no explicit agreement) and lets a leader serve linearizable reads locally, since no one else can hold a lease concurrently.
15. **What assumption do leases rest on, and why aren't they enough for safety?** — Bounded clock drift: the granter and holder reason about the same duration on different clocks, so a drifting or paused holder may think its lease is valid after the granter reassigned it — reopening the two-leaders window. Leases need safety margins and monotonic clocks, and must be backed by fencing tokens, never trusted alone.
16. **What is STONITH and when do you need it?** — "Shoot The Other Node In The Head": the cluster physically powers off, storage-fences, or network-isolates the former leader before promoting a new one. Needed when the shared resource can't validate a fencing token (e.g. a shared SAN volume in active/standby HA), so at-most-one-writer must be enforced by destroying the other node.
17. **How does ZooKeeper-based leader election work?** — Each candidate creates an ephemeral-sequential znode under an election path; the lowest sequence number is leader. If the leader's session dies, its ephemeral znode is auto-deleted and the next-lowest takes over. The sequence number doubles as a fencing token, and ZooKeeper's ZAB quorum backs it all.
18. **What is the herd effect in ZooKeeper election and how is it avoided?** — If every follower watches the single leader znode, its deletion wakes all of them at once (thundering herd), hammering the ensemble. The fix: each candidate watches only the *next-lower* znode, so exactly one watch fires per deletion and only the actual successor is woken.
19. **Describe Raft/etcd leader election.** — Time is divided into terms; a follower whose randomized election timeout elapses without a heartbeat becomes a candidate, increments its term, votes for itself, and requests votes. A node grants at most one vote per term and only to a candidate whose log is at least as up-to-date; a majority wins. Randomized timeouts break split-vote ties.
20. **Why must the elected leader have the most up-to-date log?** — Because an out-of-date leader would overwrite or lose committed entries. Raft's election restriction makes voters reject candidates whose log is behind theirs, guaranteeing the winner already holds every committed entry — so leadership can change without losing committed data.
21. **How does Patroni elect a PostgreSQL leader?** — It delegates consensus to a DCS (etcd/Consul/ZooKeeper): the primary holds a leader key with a TTL and renews it; if it stops (crash/partition) the key expires, and replicas race to atomically recreate it — the linearizable store guarantees exactly one winner, which then promotes via pg_promote(). A watchdog fences the old primary.
22. **Why can Redis Sentinel failover lose acknowledged writes?** — Redis replication is asynchronous: the master acks a write to the client before replicating it. If the master fails before propagating, the promoted replica never saw that write and it's lost. Sentinel provides availability failover (majority sentinel election), not quorum-durable consistency.
23. **In Redis Sentinel, distinguish the two quorums.** — The `quorum` parameter is how many sentinels must agree the master is down (ODOWN) to *start* a failover. Electing the single *leader sentinel* that actually performs the failover requires a *majority of all sentinels* — a separate, stricter condition that prevents concurrent failovers.
24. **How does MongoDB prevent split-brain on partition?** — Election requires a majority of voting members and a sufficiently up-to-date oplog; a primary that can't confirm it still has a majority (minority partition) steps down to secondary. With w:majority writes, only majority-acknowledged data is durable, so failover never loses committed writes.
25. **What are the two levels of election in Kafka?** — The *controller* election (which broker manages cluster metadata) and per-*partition* leader election (which in-sync replica serves each partition). The controller runs the per-partition elections; the controller itself was elected via a ZooKeeper ephemeral znode (classic) or via native Raft (KRaft). Leader-epoch numbers fence stale partition leaders.
26. **What causes election storms and how do you damp them?** — Over-aggressive timeouts (shorter than GC pauses / latency tails), symmetric timeouts (vote splits/livelock), and Bully-style re-preemption churn. Damp with randomized/jittered timeouts, PreVote and leader stickiness, generous phi-accrual detection, and failback cooldowns. Stability beats optimality.
27. **What is Raft PreVote and why does it help?** — Before incrementing its term and disrupting the cluster, a candidate first checks whether it *could* win an election; only then does it bump the term. This stops a partitioned node whose term kept climbing from forcing needless re-elections and term inflation when it rejoins a healthy cluster.
28. **Leader-based vs leaderless replication — when choose each?** — Leader-based (single writer, total order) when you need serialization, linearizable-ish semantics, or simple conflict handling — at the cost of a failure/election point. Leaderless (Dynamo-style, R+W>N) when write availability under partitions matters most, accepting concurrent-write reconciliation (siblings/CRDTs/read-repair).

---

## Common Traps

- **Claiming a system "always has exactly one leader."** Impossible by FLP; the real guarantee is at most one *active* leader per epoch (majority + fencing), with brief windows where two nodes *believe* they lead but only one can commit.
- **Thinking a majority quorum stops two nodes from *believing* they're leader.** It only stops two from both *committing*; a minority-side node can still think it's a candidate. Safety comes from constraining action (quorum + fencing), not belief.
- **Using Bully or ring election across a network that can partition.** Highest-id-wins elects a separate leader on each side of a partition — textbook split-brain. Production systems use majority quorum precisely because it's partition-safe.
- **Believing a lease alone prevents two leaders.** A GC pause or clock drift can make a lease-holder act after its lease was reassigned; leases must be backed by fencing tokens the resource validates, and require a bounded-clock-drift assumption.
- **Forgetting that fencing must be enforced by the resource.** An epoch/token that no downstream storage or database checks is decorative; the whole point is that the resource rejects operations carrying a stale token.
- **Assuming Redis Sentinel gives consistency.** It elects a leader safely by majority vote but sits on asynchronous replication, so failover can silently drop writes the old master already acknowledged.
- **Conflating Sentinel's `quorum` (start-failover threshold) with the sentinel-leader majority.** They are two different vote counts; only the majority elects the sentinel that performs the failover.
- **Deploying an even number of voters or two failure domains.** A symmetric split leaves no majority and halts the cluster; use odd voter counts and at least three failure domains, with arbiters/witnesses as tie-breakers.
- **Setting election timeouts shorter than real GC pauses or fsync stalls.** Healthy leaders get declared dead, causing election storms; tune timeouts above the pause/latency tail and use randomized timeouts to avoid vote-split livelock.
- **Electing the highest-id or highest-priority node when electing a data replica.** You must elect the most *up-to-date* replica (freshness restriction); a stale leader would lose committed writes regardless of its id or priority.
- **Assuming leader election scales writes.** All writes still funnel through one leader; leadership solves ordering, not write throughput — that needs sharding or a leaderless design.
