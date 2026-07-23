# Chapter 74 — Consensus

This chapter completes the optional storage and distributed-systems track.
Chapter 68 established partial failure, synchrony models, safety/liveness, FLP,
and quorum intersection. Chapters 69–73 supplied failure suspicion, authority,
replication semantics, repair, and cross-partition transactions. Here those
ideas become one replicated state machine whose participants agree on an
ordered log despite crashes, delay, duplication, reordering, and partitions
within a stated model.

The Core outcome is practical and proof-oriented: define consensus, explain why
quorums preserve a chosen value, trace Paxos’s prepare/accept rules, and walk a
Raft log through election, replication, commitment, leader failure, repair,
snapshot, and membership change. Broadcast families, Paxos variants, ZAB, and
Byzantine agreement are skippable Reference material.

For a general HFT systems role, retain the failure trace, commitment rule, and
client/read boundaries; protocol implementers should also complete the state
model and reconfiguration exercise. The chapter does not require memorizing
paper lineage or product defaults. It requires defending every acknowledgement
with durable quorum evidence and every progress claim with explicit operating
conditions.

## 90-second screen — Core

1. **Consensus** chooses one value for one instance under agreement, validity,
   and termination conditions. Fault/timing assumptions are part of the claim.
2. **State-machine replication (SMR)** uses repeated agreement to place
   deterministic commands in the same ordered log, then applies the same
   committed prefix at every replica.
3. Consensus protects protocol state. It does not automatically make client
   retries unique, side effects transactional, reads linearizable, disks
   durable, or deployments correctly configured.
4. In a fixed crash-fault membership, majority quorums intersect. Intersection
   becomes safety only when participants persist and obey rules about what they
   may promise, vote for, accept, overwrite, and report.
5. Paxos Phase 1 obtains promises and discovers prior accepted values. Phase 2
   proposes the highest-numbered previously accepted value, or a new value if
   none exists. That carry-forward rule preserves an already choosable choice.
6. Multi-Paxos amortizes Phase 1 with a stable leader and runs agreement for log
   slots. Raft packages similar replicated-log work into terms, elections, and
   an explicit log-repair protocol.
7. In Raft, voters grant at most one vote per term and reject candidates whose
   logs are less up-to-date. Leaders append; followers check the previous
   index/term and delete conflicting suffixes.
8. A Raft leader advances `commitIndex` using majority replication of an entry
   from its **current term**. Committing that entry also establishes preceding
   entries; simply counting replicas of an older-term entry is insufficient.
9. Snapshotting removes a committed log prefix only after retaining the state
   and boundary metadata required for recovery. Membership change is a
   consensus problem; canonical joint consensus requires majorities of both old
   and new configurations during the joint phase.
10. Safety should survive arbitrary delay and partition within the model.
    Liveness needs enough non-faulty members, eventual timely communication,
    stable enough leadership, storage capacity, and bounded offered load.

The review sequence is:

```
specification → persistent state → quorum rule → message transition
              → commit rule → failure trace → recovery → client semantics
```

---

## Problem, state machine, and proof obligations

## 74.1 The Consensus Problem — Core

For one consensus instance, processes propose values and may decide one. A
typical crash-fault specification contains:

- **agreement:** no two correct processes decide different values;
- **validity:** a decided value satisfies the protocol’s proposal-validity
  rule—often that it was proposed by some participant;
- **integrity/nontriviality:** a process decides at most once and does not invent
  an invalid value;
- **termination:** every correct process eventually decides under the stated
  fault, fairness, and timing conditions.

Definitions differ. Uniform agreement may constrain faulty processes that decide
before failing; Byzantine validity is stronger and application-specific. Always
state the formulation instead of relying on the label.

Consensus also needs a model:

| Dimension | Core model used for Paxos/Raft discussion |
|---|---|
| Participants | Authenticated identities in a known configuration |
| Faults | Crash-stop or crash-recovery with required protocol state durable |
| Messages | May delay, duplicate, reorder, or be lost/retried; not forged |
| Timing | Safety does not depend on a fixed delay; liveness needs a sufficiently timely period |
| Storage | Persistent promises/votes/log survive the failures claimed |
| Quorum | Majorities of a fixed configuration unless reconfiguration protocol says otherwise |

This is not Byzantine fault tolerance. A node that lies, equivocates, corrupts
its durable term, or acknowledges before required persistence can violate the
model and invalidate the guarantee.

### Safety and liveness are separate

For a replicated log, useful safety invariants include:

- **election safety:** at most one Raft leader is elected in a term;
- **log matching:** if two Raft logs contain entries with the same index and
  term, their prefixes through that index are identical;
- **leader completeness:** an entry committed in a term is present in leaders
  elected in later terms;
- **state-machine safety:** no two replicas apply different commands at the same
  log index.

Liveness might say that a submitted command eventually commits when a quorum is
non-faulty, communication and processing remain timely enough, leadership
stabilizes, storage accepts writes, and load does not permanently exceed
capacity.

When the network partitions, a minority should lose progress before safety. A
protocol that remains “available” by letting two isolated leaders commit
conflicting entries has changed its guarantee, not improved consensus.

## 74.2 From One Decision to State-Machine Replication — Core

One consensus decision is not yet a database. SMR agrees on a sequence of
commands:

```
log index:       1          2            3
command:      put(x,4)   add(y,2)   compare_set(z,0,8)
                    │ committed prefix │
                    ▼                  ▼
replica state = apply(apply(apply(S0, cmd1), cmd2), cmd3)
```

If every replica starts from equivalent state, applies the same committed
commands in the same order, and transitions deterministically, their logical
states remain equivalent.

The application state machine must control nondeterminism:

- include generated IDs, chosen timestamps, randomness, or external results in
  the agreed command/result;
- use deterministic serialization, comparison, and arithmetic;
- define behavior across software/schema versions;
- avoid invoking an uncoordinated external side effect during replay;
- retain client operation identities/results if duplicate requests must be
  suppressed.

Replicas can have different uncommitted suffixes and different apply progress.
The safety boundary is the **committed prefix**, not byte-identical files at
every instant.

### Commit, apply, respond

These events are distinct:

1. a leader appends an entry locally;
2. followers replicate it;
3. protocol evidence makes it committed;
4. each state machine applies it in index order;
5. the leader returns a result to the client.

An implementation chooses when acknowledgement is safe. A command-dependent
result normally requires local application after commitment. A lost response can
leave the client uncertain even though the command committed. Stable client and
operation IDs plus a replicated result table can make retry return the original
outcome.

Consensus orders commands inside its log. It cannot atomically include an email,
exchange packet, file in another system, or payment at an unrelated service
unless that effect participates in a larger transactional/idempotent workflow.

## 74.3 FLP Boundary and Practical Progress — Core

FLP says that deterministic consensus cannot guarantee termination across every
admissible execution in a fully asynchronous message-passing model with even one
possible crash while retaining agreement and validity. It does not say that
agreement is generally impossible or that deployed protocols never terminate.

Paxos and Raft keep safety independent of configured timeout values. Timeouts
and randomized election delays help select a leader and obtain progress when
communication becomes timely enough. During a long partition or repeated
election collision, the system may make no progress without choosing conflicting
values.

There is no universal election timeout. It must relate to measured end-to-end
heartbeat/election paths, pauses, storage stalls, deployment topology, and the
trade-off between detection speed and false elections. A product’s actual rules,
defaults, and lease/read behavior must be verified for its version and
configuration.

---

## Quorum and log foundations

## 74.4 Majority Intersection and Durability — Core

For fixed membership \(N\), a majority size is:

\[
q = \left\lfloor \frac{N}{2} \right\rfloor + 1
\]

Two majorities intersect because \(2q>N\). With five voters, \(q=3\). Any two
sets of three share at least one voter, and a quorum can form with at most two
unavailable voters.

The intersection member is useful only if it retains and obeys protocol state.
For crash-recovery, an acceptor’s Paxos promises/accepted proposal, or a Raft
server’s current term/vote/log, must survive the faults included in the
guarantee before the server sends an acknowledgement that relies on it.

| Fact | What it gives | What it does not give alone |
|---|---|---|
| \(2q>N\) | Any two size-\(q\) sets intersect | Correct value selection |
| Durable quorum acknowledgement | Evidence survives modeled restarts | Linearizable client reads |
| One vote per term | Two majorities cannot elect different leaders in one term | A leader with every committed entry unless log voting rule applies |
| Matching log prefixes | Safe suffix repair | Eventual progress |

Quorums are sets, not always physical fault domains. Five replicas spread as
three on one power domain and two on another have a numerical majority
concentrated in one failure domain. Placement determines which correlated faults
remain live.

### Compact availability calculation

Under an **illustrative independent-failure model** where each of five voters is
available with probability \(p\), quorum availability is:

\[
P(Q) = \binom{5}{3}p^3(1-p)^2
     + \binom{5}{4}p^4(1-p)
     + p^5
\]

For \(p=0.99\):

\[
P(Q) \approx 0.9999901494
\]

This is not a production availability promise. Real failures share racks,
networks, software, load, and operators; quorum formation also needs timely
communication and functioning storage. The calculation merely distinguishes
component count from failure correlation.

## 74.5 A Replicated Log Is More Than Replicated Entries — Core

A log entry typically has at least:

```
(index, ballot-or-term, command)
```

Correctness also depends on:

- who may append at a position;
- how a new leader discovers prior accepted/logged values;
- when an entry becomes chosen/committed;
- which conflicting suffix may be removed;
- what metadata persists across restart;
- how membership at that position is determined;
- how commit knowledge reaches followers;
- when an entry may be applied or exposed to a read.

Index alone is not a globally unique version. In Raft, `(index, term)` identifies
the provenance relevant to log matching. A follower may hold entry 8 from an old
term while the new leader holds a different uncommitted entry at index 8. The
repair protocol finds a matching prefix and replaces only the conflicting
uncommitted suffix.

---

## Paxos: the value-carrying quorum proof

## 74.6 Single-Decree Paxos Roles and State — Core

Paxos separates conceptual roles:

- **proposer:** attempts to get a value chosen;
- **acceptor:** persists promises and accepted proposals;
- **learner:** discovers a chosen value.

One process can perform several roles. For one instance, proposal/ballot numbers
are totally ordered and unique across proposers, often constructed from a local
counter plus proposer identity.

Each acceptor persistently records:

```text
promised_ballot
accepted_ballot, accepted_value   // or none
```

`promised_ballot` prevents accepting an older proposal after responding to a
newer prepare. The accepted pair is the evidence a later proposer must carry
forward.

## 74.7 Phase 1: Prepare and Promise — Core

A proposer chooses ballot \(n\) and sends `PREPARE(n)` to acceptors.

An acceptor:

```text
on PREPARE(n):
    if n > promised_ballot:
        durably set promised_ballot = n
        reply PROMISE(n, accepted_ballot, accepted_value)
    else:
        reject or report the higher promise
```

After promises from a Phase-1 quorum, the proposer chooses:

- the value paired with the **highest accepted ballot** reported by that quorum,
  if any acceptor reports an accepted value;
- otherwise, any valid new proposal value.

This rule is the heart of Paxos. Phase 1 is not merely leader discovery; it
recovers evidence that constrains Phase 2.

## 74.8 Phase 2: Accept and Chosen — Core

The proposer sends `ACCEPT(n, v)`:

```text
on ACCEPT(n, v):
    if n >= promised_ballot:
        durably set promised_ballot = n
        durably set accepted = (n, v)
        reply ACCEPTED(n, v)
    else:
        reject or report the higher promise
```

When a Phase-2 quorum accepts \((n,v)\), value \(v\) is **chosen**. A learner may
discover this through the proposer, acceptors, or a protocol-specific learning
path. “The leader stored it” is not the chosen condition.

Some descriptions use strict/non-strict comparisons or combine fields
differently. Safety depends on the complete invariant, including durable atomic
updates—not copying pseudocode operators without the proof context.

### Worked Paxos trace: accepted versus chosen

Use five acceptors A–E; a quorum has three members.

**Case 1: a value was chosen, but the proposer did not learn that.**

1. Proposer P1 uses ballot 10, obtains promises from A/B/C, finds no accepted
   value, and proposes `red`.
2. A/B/C durably accept `(10, red)`. `red` is now chosen, even if every
   `ACCEPTED` response to P1 is delayed and P1 crashes.
3. P2 begins ballot 11 and obtains promises from C/D/E.
4. C reports `(10, red)`; D/E report no accepted value.
5. The highest accepted ballot reported is 10, so P2 must propose `red`, not its
   preferred `blue`.
6. If C/D/E accept `(11, red)`, the later chosen proposal has the same value.

The Phase-1 quorum C/D/E did not need to contain all prior acceptors. Its
intersection with the choosing quorum A/B/C supplied one durable witness.

**Case 2: a value was accepted but not chosen.**

1. P1 gets only A/B to accept `(10, red)` before it stops. Two acceptances are
   not a quorum.
2. P2’s Phase-1 quorum C/D/E reports no accepted value, so P2 may choose `blue`
   for ballot 11.
3. C/D/E promise 11 and then accept `(11, blue)`, choosing `blue`.
4. P1 cannot later complete ballot 10: every majority intersects C/D/E, whose
   members reject ballot 10 after promising 11.

It is safe that P2 missed A/B’s partial evidence because `red` was not chosen
and the higher promise closes the old ballot’s path to a future quorum. This
distinction—accepted by some versus chosen by a quorum—is essential when
debugging incomplete rounds.

## 74.9 Why the Carry-Forward Rule Is Safe — Core

Suppose value \(v\) is chosen at ballot \(m\), so a Phase-2 quorum \(Q_m\)
accepted it. Any later successful Phase-1 quorum \(Q_n\) intersects \(Q_m\).
At least one acceptor therefore reports evidence of \(v\) or of a later accepted
proposal already constrained by the same induction.

The proposer at \(n\) must select the value associated with the highest accepted
ballot found in \(Q_n\). By induction over ballots, any value proposed at a
successful later Phase 2 is compatible with the previously chosen value. Two
different values cannot both be chosen.

The slogan “quorums intersect” is insufficient on its own. The proof also uses:

1. promises that reject lower ballots;
2. durable reporting of accepted proposals;
3. selection of the highest accepted ballot’s value;
4. intersection between the relevant Phase-1 and Phase-2 quorums.

If an acceptor forgets state after restart or a proposer chooses its preferred
value despite reported accepted state, intersection contains no useful memory.

## 74.10 Paxos Failure and Liveness Windows — Core

Two proposers can repeatedly pre-empt one another:

```
P1 prepare 10 → quorum promises 10
P2 prepare 11 → quorum promises 11
P1 accept 10  → rejected
P1 prepare 12 → quorum promises 12
P2 accept 11  → rejected
...
```

Safety holds; progress can stall. A distinguished stable proposer/leader,
backoff, and eventual timely communication improve liveness. A proposer crash
after some accepts is safe: a later proposer’s Phase 1 discovers accepted
evidence and carries the value if required.

A response can be lost after the value is chosen. The client/proposer may not
know the outcome, but a later round cannot choose a conflicting value. Again,
protocol outcome and observer knowledge are distinct.

### Multi-Paxos mapping

SMR needs many log slots. Multi-Paxos uses a stable leader so an established
ballot can amortize Phase 1, then performs Phase 2-like replication for successive
slots. Leadership change performs recovery/preparation for the relevant log and
must preserve per-slot safety.

“One network round trip per command” is not a universal latency claim. It
depends on leader establishment, batching, persistence/ack policy, topology,
pipeline, learner path, and client-to-leader routing.

### Paxos and Raft: useful mapping, not equivalence of lines

Both families use ordered leadership/ballot epochs, quorum intersection, and
durable evidence to preserve chosen log values. A rough comparison helps:

| Paxos/Multi-Paxos idea | Raft expression | Important difference |
|---|---|---|
| Ballot number | Term | Raft term also structures roles/elections and labels log entries |
| Phase-1 promise | Higher-term transition and vote/log restrictions | A Raft vote is not literally a Paxos promise carrying arbitrary per-slot accepted pairs |
| Accepted value for an instance | Log entry at an index/term on a server | Raft constrains logs to matching prefixes and leader-appended suffixes |
| Stable distinguished proposer | Elected leader | Raft makes the election and up-to-date-log check explicit |
| Phase-2 quorum chooses value | Majority replication plus Raft commit rule | Raft’s older-term/current-term commitment distinction is essential |
| New ballot recovers accepted evidence | New leader preserves committed prefix and repairs suffixes | Recovery mechanics and proof vocabulary differ |

It is fair to say Raft and Multi-Paxos solve the same broad replicated-log
problem under related crash-fault assumptions. It is unsafe to translate one
implementation by renaming fields. Compare full invariants, persistence,
reconfiguration, and read protocols.

---

## Raft: terms, log, and recovery

## 74.11 Raft State and Core Invariants — Core

Raft servers are followers, candidates, or leaders. Time is divided into
monotonically increasing **terms**. A term may have no leader; at most one leader
can be elected in a term under the voting rules.

Conceptual persistent state:

```text
currentTerm
votedFor
log[]          // entries include term and command
```

Conceptual volatile state includes `commitIndex`, `lastApplied`, role, and leader
replication indices such as `nextIndex[]` and `matchIndex[]`. Exact persistence
choices and recovery rules are implementation-specific; fields whose loss would
permit a second vote or corrupt the acknowledged log must satisfy the model’s
durability contract.

Servers receiving an RPC with a higher term update their term and become
followers. Stale-term requests cannot reassert old authority.

## 74.12 Election: Terms, Votes, and the Up-to-Date Rule — Core

A follower that receives no valid leader/candidate activity before its election
timer may:

1. increment and persist `currentTerm`;
2. become candidate;
3. vote for itself and persist `votedFor`;
4. request votes, including its last log term and index.

A voter grants at most one vote per term and only to a candidate whose log is at
least as up-to-date as its own under Raft’s lexicographic rule:

```
higher lastLogTerm wins;
if terms equal, at least as large lastLogIndex is up-to-date.
```

A majority elects the candidate. One-vote-per-term plus majority intersection
gives election safety for a fixed configuration. The log restriction supports
leader completeness: a candidate missing a committed entry cannot collect the
needed votes under the protocol invariants.

Election timeout randomization reduces repeated ties but is a liveness
technique, not the source of safety. Pauses and partitions can create candidates
without violating correctness; a server that sees a higher term steps down even
if it believed itself leader.

## 74.13 AppendEntries, Matching, and Suffix Repair — Core

The leader sends followers an `AppendEntries` request containing:

```text
term
leaderId
prevLogIndex, prevLogTerm
entries[]
leaderCommit
```

The follower accepts appended entries only if its log contains the matching
previous index/term (or the snapshot boundary supplies the match). On conflict,
it rejects so the leader can search backward—often with optimized conflict
hints—or, once the prefix matches, removes conflicting uncommitted entries and
appends the leader’s suffix.

This yields the log-matching property:

> If two logs contain entries with the same index and term, they contain the same
> prefix through that index.

Heartbeat messages are empty `AppendEntries` calls and still carry term,
previous-log/commit information. They are protocol messages, not proof that a
process cannot fail immediately afterward.

Leader state:

- `nextIndex[f]`: next index expected to send follower \(f\);
- `matchIndex[f]`: highest index known replicated on \(f\).

These are leader observations and may lag reality. Rejections and successful
responses update them; a new leader reconstructs progress rather than trusting a
previous leader’s volatile arrays.

## 74.14 Commitment Rule, Exactly — Core

For a leader in term \(T\), Raft advances `commitIndex` to an index \(N\) when:

1. a majority’s `matchIndex` is at least \(N\);
2. `log[N].term == T`;
3. \(N\) is greater than the previous `commitIndex`.

The leader then communicates `leaderCommit`; followers advance their own
`commitIndex` to the minimum of that value and their last new/matching index.
State machines apply committed entries in increasing index order.

The current-term condition matters. An older-term entry stored on a majority is
not committed merely by counting replicas in a later term. Once the leader
commits a current-term entry, the matching prefix commits preceding entries
indirectly. This rule closes a failure window in which old entries may appear on
different majorities across terms.

Client acknowledgement should follow the implementation’s documented durable
commit and application rule. A leader that replies after local append but before
quorum commitment can lose that entry on failover.

### The Raft invariant chain

Raft safety is a composition, not “majority means correct”:

1. **Election safety.** Each voter persists at most one vote per term. Two
   candidates would each need a majority; the intersecting voter cannot vote
   twice, so two leaders cannot both be elected in that fixed term.
2. **Log matching.** Leaders create at most one entry at an index in their term.
   Followers accept a suffix only after matching `prevLogIndex/prevLogTerm`.
   Equal `(index, term)` entries therefore have equal preceding logs.
3. **Leader completeness.** A committed current-term entry is on a majority.
   Any later election quorum intersects it, and the candidate up-to-date rule
   prevents a candidate missing the relevant committed prefix from winning.
   The proof extends through the current-term commitment rule to older entries
   committed indirectly.
4. **State-machine safety.** Leaders never replace committed entries; followers
   repair only suffixes inconsistent with the valid leader prefix; replicas
   apply committed entries in index order. Consequently, two state machines do
   not apply different commands at the same index.

Breaking any link breaks the conclusion. A double vote after restart defeats
election safety. Comparing only last index and ignoring last term defeats the
election restriction. Treating an older-term majority count as commitment
defeats the leader-completeness proof. Applying before commitment exposes a
suffix that later leaders may legally replace.

## 74.15 Worked Leader-Failure Trace — Core

Use five voters A–E. Entries 1–3 are committed everywhere, ending in term 3.

### Uncommitted suffix

1. A is leader in term 4 and appends command `x` at `(index=4, term=4)`.
2. A replicates `x` only to B. Two copies are not a majority, so A must not
   commit or report a committed outcome.
3. A and B become isolated. C, D, and E can communicate.
4. C’s timer expires, it starts term 5, receives votes from C/D/E, and becomes
   leader. Their last entry remains `(3,3)`.
5. C appends `y` at `(4,5)`, replicates it to C/D/E, and commits it because a
   majority stores this current-term entry.
6. The partition heals. A observes term 5 and steps down. C finds that A/B match
   through `(3,3)`, removes their conflicting uncommitted `(4,4)` suffix, and
   installs `(4,5)`.

No committed command was overwritten. The client that submitted `x` had an
unknown/uncommitted outcome and may retry with a stable operation ID.

### If `x` had reached a majority

Suppose A replicated `(4,4)` to A/B/C and committed it before failing, but its
client response was lost. Any term-5 candidate must win a majority. The
up-to-date voting rule prevents a candidate whose log ends at `(3,3)` from
obtaining a vote from an up-to-date intersecting voter needed for election. C,
which has `(4,4)`, can lead and preserve `x`.

The proof uses both quorum intersection and the log voting rule. Counting
replicas without election restrictions would not give leader completeness.

### Failure-window table

| Failure point | Safe outcome |
|---|---|
| Before leader local persistence | Entry may be absent; client cannot assume commit |
| After leader append, before quorum | Entry may survive or be replaced |
| After quorum current-term commitment, before response | Entry survives later valid leaders; client may be uncertain |
| After response lost | Retry must deduplicate or query original operation |
| During suffix repair | Matching prefix/term checks prevent committed-prefix replacement |
| Follower restart | Persistent term/vote/log restore before protocol participation |

## 74.16 Snapshots and Log Compaction — Core

An ever-growing replicated log is not an operational design. After applying a
committed prefix through index \(i\), a replica can capture a snapshot containing:

- deterministic application state at \(i\);
- `lastIncludedIndex = i` and `lastIncludedTerm`;
- configuration/membership state effective at that point;
- client deduplication/session state needed after replay;
- format/schema/checksum/version metadata.

The replica may discard log entries covered by the installed snapshot only when
recovery can atomically select a valid snapshot plus remaining suffix. A crash
during snapshot creation must leave either the old recovery path or a complete
new one.

A far-behind follower can receive an install-snapshot operation rather than the
entire old log. It validates and installs the snapshot, aligns its log boundary,
then resumes replication. Snapshot transfer needs chunk identity, integrity,
restart/resume behavior, and resource limits.

### Snapshot publication failure windows

A local snapshot pipeline can be modeled:

```
choose committed/applied index i
  → serialize state and protocol/application metadata
  → finalize checksum, format, and length
  → make required snapshot bytes durable
  → atomically publish/select snapshot generation
  → retain log suffix after i
  → reclaim older snapshot/log only when rollback path is safe
```

If the process crashes while serializing, recovery should ignore the incomplete
generation. If bytes are complete but publication did not become durable, the
old snapshot plus log must still recover. If publication is durable, the new
snapshot’s included index/term must join to the retained suffix. Reclamation
must occur last; deleting the old log before a usable snapshot is selected can
destroy recovery despite consensus having committed every command.

Installation on a follower has another transition. The receiver must not expose
partially installed state, must reject chunks from a stale term or transfer
where appropriate, and must coordinate application so no command is applied
both through the snapshot and through a stale pending log task. After
installation, `lastApplied` and `commitIndex` must be consistent with the
snapshot boundary under the implementation’s state rules.

Snapshotting is not the same as backup. Consensus can replicate accidental
deletion or corruption consistently; an independently retained, tested backup
serves a different recovery objective.

## 74.17 Membership Change — Core

Changing voters changes which quorums intersect. Replacing configuration
\(C_{\text{old}}\) with \(C_{\text{new}}\) as an out-of-band switch can allow one
majority of each, with no common participant, to act on divergent logs.

Canonical Raft joint consensus places configuration changes in the log:

1. enter a joint configuration \(C_{\text{old,new}}\);
2. decisions/elections require separate majorities of both old and new voter
   sets;
3. once the joint entry is committed, commit a new-only configuration
   \(C_{\text{new}}\).

This overlaps authority across the transition. Learners/non-voters can catch up
before promotion, reducing availability risk. Removing a current leader,
multiple simultaneous changes, and failed members during transition need the
specific protocol’s rules.

For a compact example, let:

```
C_old = {A, B, C}       old majority = 2
C_new = {C, D, E}       new majority = 2
```

An unsafe instant switch could allow old quorum `{A,B}` and new quorum `{D,E}`
to act without intersection. In the joint phase, one decision needs at least two
old voters **and** two new voters. `{B,C,D}` qualifies: `{B,C}` is an old
majority and `{C,D}` a new majority. Another joint quorum must intersect it
through the majority property within both configurations. Only after the
new-only entry is committed under the joint rules may `{D,E}` form authority
without A/B.

Joint configuration can temporarily reduce liveness because both component
majorities are required. That is the price of preserving authority while the
quorum universe changes. Operational tooling should show which phase is active
and which voter prevents completion, rather than inviting an unsafe manual
shortcut.

Raft implementations may use constrained single-server changes or other
verified reconfiguration methods. Product behavior must be checked by version;
do not combine fragments from different reconfiguration protocols.

---

## Reads, clients, and operations

## 74.18 Consensus Does Not Automatically Linearize Reads — Core

A former leader can remain unaware of a newer term during a partition. Serving
its local state as “latest” can return stale data even though all committed log
writes are safe.

Common read approaches include:

- **log the read/barrier:** order a no-op or read command through consensus;
- **quorum/read-index confirmation:** confirm current leadership with a quorum
  under the protocol—including any required current-term commitment/barrier—
  then wait until the local state machine has applied the required commit index;
- **leader lease:** use bounded-clock/delay assumptions so leadership remains
  valid for a lease interval;
- **explicit stale/follower read:** expose a weaker, documented freshness or
  session contract.

The exact Raft read-index/lease mechanism and its safe prerequisites are
implementation/product details. Merely contacting “the leader” or reading a
majority does not automatically establish linearizability.

### Client sessions and duplicate commands

A client can time out after commitment but before receiving the result. Retrying
as a new log command can apply twice. A common state-machine pattern tracks:

```text
(client_id, sequence) → last applied result
```

Replicate this table as application state, include it in snapshots, and define
session expiry/reuse. The leader can then return the stored result for a
duplicate. This provides scoped exactly-once effects inside the replicated state
machine, not universal exactly-once external behavior.

## 74.19 Latency, Throughput, and Backpressure — Core

The normal leader write path includes client routing, leader processing/durable
append, follower communication and persistence, quorum acknowledgement,
commit/apply, and response. Critical-path time depends on topology, persistence
policy, batching, queueing, and load:

\[
T_{\text{commit}} \approx
\max_{f \in \text{quorum path}}
(T_{\text{send},f}+T_{\text{persist},f}+T_{\text{reply},f})
+T_{\text{leader work}}
\]

This schematic is not a universal one-round-trip or `fsync` count. Pipelines
overlap entries; batches amortize headers and synchronization; group commit
trades waiting for throughput; slow followers outside the selected quorum need
not delay one commit but still consume catch-up resources.

Unbounded proposals can grow leader memory, follower lag, log retention, and
snapshot transfer debt. Bound in-flight entries/bytes, apply admission control,
expose backpressure, and reserve resources for heartbeats/elections/recovery.
Consensus cannot make progress if its own control messages starve behind
unbounded client work.

## 74.20 Operations and Failure Drills — Core

Observe both safety evidence and liveness risk:

| Signal | Question |
|---|---|
| Current term/role/leader changes | Are elections frequent, stuck, or correlated with pauses/storage? |
| Commit and applied indices | Is replication or application lag growing? |
| Per-follower match/next index | Which member is slow/divergent and how much catch-up remains? |
| Proposal queue and commit latency distribution | Is overload threatening progress or SLO? |
| Persistent-log/snapshot errors | Can members safely acknowledge and recover? |
| Snapshot age/size/install progress | Is compaction bounded; can a new member join? |
| Configuration state | Is a joint change stuck or unsafe manual membership present? |
| Client duplicate/unknown outcomes | Do retry/session semantics work through failover? |

Drill at least:

- leader process crash before and after current-term commitment;
- response loss after commit;
- asymmetric partition with an old leader still serving traffic;
- follower crash/restart with stale suffix;
- disk full or durable-write error on leader and follower;
- all minority nodes unavailable, then one quorum member unavailable;
- snapshot interruption/corruption and far-behind catch-up;
- membership change interrupted in each phase;
- mixed-version rollout/rollback with log and snapshot compatibility.

Manual “force leader” or membership edits can bypass proofs. Recovery tools need
explicit preconditions, audit records, fencing, and a tested method to determine
the authoritative committed prefix.

## 74.21 Labels and Deployment Boundaries — Core

Keep claims at the right level:

| Label | Example |
|---|---|
| **Theorem/property** | Majority sets intersect; FLP’s conditional nontermination result |
| **Protocol** | Paxos promise rule; Raft current-term commit rule |
| **Implementation** | Persistent record layout, batching, conflict hints, snapshot chunks |
| **Product/version/configuration** | Read mode, lease behavior, default timeout, membership API |
| **Measured** | Commit tail under named topology, hardware, load, and injected fault |

Consensus supplies agreement under its model. A complete service additionally
needs:

- transport authentication/authorization;
- storage ordering, checksums, and recovery;
- deterministic state/version evolution;
- client retry/dedup semantics;
- admission control and bounded resources;
- backups and disaster recovery;
- monitoring, rollout, membership, and certificate/key lifecycle.

Do not infer these from the protocol name.

### Limits: what the agreed log cannot decide for you

Consensus answers an ordering/choice question among configured participants. It
does not choose the right application invariant or partition key. It does not
prove a command is authorized, make nondeterministic code deterministic, or
decide whether an external venue accepted a packet. It cannot provide liveness
without a quorum and timely-enough resources, and it cannot preserve data against
faults outside its storage/protocol model.

A single consensus group also has one ordered commit path. Sharding into many
groups raises placement, routing, rebalancing, and cross-group transaction
questions from Chapter 73. Replicating every business event through one global
group may simplify order but create an avoidable latency, throughput, or failure
domain. Use consensus around authority and invariants that require agreement,
not as a blanket replacement for queues, caches, databases, or reconciliation.

Finally, a protocol proof does not certify its implementation. Serialization,
integer overflow, concurrent callbacks, torn persistent metadata, snapshot/log
format evolution, stale RPC responses, incorrect membership APIs, and operator
actions can violate modeled transitions. Model checking, deterministic
simulation, fault injection, storage recovery tests, and staged operations are
complementary evidence.

---

## Optional families and mappings

## 74.22 Atomic Broadcast and Virtual Synchrony — Reference

**Atomic/total-order broadcast** provides a common delivery order with agreement
and integrity properties under a stated model. Consensus and atomic broadcast
can be reduced to one another under suitable definitions: use successive
consensus instances to choose delivery batches, or decide the first delivered
proposal. This is a conceptual equivalence, not proof that every messaging
product implements consensus semantics.

**Virtual synchrony** coordinates message delivery with agreed membership views
so surviving members reason about messages delivered within view transitions.
It has its own model/properties and is not merely “TCP plus membership.”
Broadcast taxonomy is useful for recognizing specifications; the Core path does
not require memorizing every abstraction.

## 74.23 ZAB and Paxos Variants — Reference

ZooKeeper Atomic Broadcast (ZAB) is a leader-based atomic-broadcast protocol with
epochs, discovery/synchronization, and broadcast phases. Its leader recovery
must establish an appropriate history before new proposals; it should not be
reduced to “elect the node with the largest counter.” ZooKeeper client read and
`sync` semantics are product/version/API topics, not consequences of the name
ZAB.

Selected Paxos-family variants move particular costs:

| Variant | Main idea | Proof/operations burden |
|---|---|---|
| Multi-Paxos | Stable leader amortizes preparation across slots | Leader recovery and per-slot/log state |
| Flexible Paxos | Relax same-phase quorum requirements while preserving required cross-phase intersection | Correct quorum-family configuration |
| Fast Paxos | Allow some values to bypass a classic leader round | Larger/different quorums and collision recovery |
| Generalized Paxos | Agree on equivalence classes/orders of commuting commands | Application commutativity and dependency reasoning |
| EPaxos-style | Exploit command dependencies to avoid one fixed leader in favorable cases | Dependency recovery, conflicts, wider message paths |

These are skippable unless a role owns such a protocol. Do not reuse a quorum
formula from one variant inside another without its proof assumptions.

## 74.24 Byzantine Agreement and PBFT — Reference

Crash-fault Paxos/Raft assume participants follow the protocol until they stop.
A Byzantine participant may equivocate, forge if identities are unprotected, or
send inconsistent state. Byzantine consensus therefore needs a different model,
authentication assumptions, quorum thresholds, and protocol.

Classical PBFT-style reasoning is often summarized with \(N \ge 3f+1\) replicas
to tolerate \(f\) Byzantine faults in its model, using intersecting quorums large
enough that honest overlap remains. The threshold is not a universal BFT law:
signatures, synchrony, client rules, reconfiguration, and newer protocols alter
mechanisms and costs.

Treat PBFT, HotStuff-family protocols, and other research variants as specialist
study. Checksums, TLS, and crash consensus are valuable but do not compose into
Byzantine consensus automatically.

---

## Recall and practice

## Common Traps — Core

- Saying “consensus means every replica has identical bytes now.”
- Giving agreement/termination without validity and fault/timing assumptions.
- Treating FLP as “consensus is impossible.”
- Using quorum intersection as a complete safety proof without durable
  promises/votes/log rules.
- Saying an entry is committed because the leader appended or sent it.
- In Raft, committing an older-term entry merely because it appears on a
  majority, instead of applying the current-term commitment rule.
- Allowing a less-up-to-date candidate to win votes after a leader failure.
- Deleting any conflicting suffix without first establishing a matching prefix
  and preserving committed entries.
- Serving a former leader’s local reads as linearizable without a valid read
  protocol.
- Forgetting operation IDs/results in snapshots, causing retries to apply again.
- Switching membership out of band or assuming old/new majorities intersect.
- Treating snapshotting as backup.
- Choosing a universal timeout or quoting “one RTT/one fsync” without topology,
  persistence, batching, and acknowledgement scope.
- Naming a product that uses Raft/Paxos and assuming every API operation has the
  strongest possible semantics.
- Applying crash-fault quorum thresholds to Byzantine or mixed-trust systems.

## Recall Card — Core

- Consensus: agreement + validity/integrity + conditional termination for one
  decision under a model.
- SMR: agree on log order, apply committed prefix deterministically.
- Commit, apply, reply, and client knowledge are separate events.
- Majority: \(q=\lfloor N/2\rfloor+1\); intersection is memory only when members
  durably obey protocol rules.
- Paxos Phase 1 promises and reports accepted evidence; Phase 2 carries the
  highest accepted value and chooses it on an accept quorum.
- Raft: persistent term/vote/log; one vote/term; up-to-date candidate rule;
  matching-prefix append; current-term majority commit.
- A committed current-term Raft entry establishes prior prefix commitment.
- Uncommitted conflicting suffixes can be replaced; committed entries survive
  valid future leaders.
- Snapshot = state + included index/term + configuration + dedup/version data.
- Reconfiguration must preserve quorum overlap; joint consensus uses both
  old/new majorities.
- Consensus writes do not automatically linearize reads or deduplicate clients.
- Safety is timing-independent in the model; liveness needs a quorum, timely
  period, stable leadership, functioning storage, and capacity.

## Questions — Core

1. State consensus agreement, validity, and termination, including the fault and
   synchrony assumptions needed for your claim.
2. Why does deterministic SMR require replicas to control time, randomness,
   external calls, and software-version behavior?
3. For seven voters, calculate majority size and unavailable-voter tolerance.
   Why does the result not prove safety under crash-recovery?
4. Trace Paxos prepare/promise/accept. Why must a proposer carry the value with
   the highest accepted ballot returned by its Phase-1 quorum?
5. State Raft’s election restriction and explain how it combines with quorum
   intersection to preserve committed entries.
6. Why may a Raft leader not commit an older-term entry only by counting its
   replicas? How does a current-term entry commit the preceding prefix?
7. Replay the A–E failure trace. Which suffix is discarded, and what changes if
   `x` reached A/B/C before A failed?
8. What must a snapshot contain beyond application rows, and what crash window
   must snapshot installation handle?
9. Why is changing from old to new membership an agreement problem? State the
   joint-consensus quorum rule.
10. Give two ways to serve linearizable reads and one way to expose deliberately
    stale reads. What assumptions does each add?

## State-Trace Puzzle — Core

Five servers have these logs; `*` marks what the displaying server believes is
committed:

```text
A term 8 leader: [1:5 a*] [2:5 b*] [3:7 c] [4:8 d]
B:               [1:5 a*] [2:5 b*] [3:7 c] [4:8 d]
C:               [1:5 a*] [2:5 b*] [3:7 c]
D:               [1:5 a*] [2:5 b*] [3:6 x]
E:               [1:5 a*] [2:5 b*]
```

Assume A replicated `(4,8)` only to B. Then A is isolated with B, while C/D/E
can communicate.

1. Which of C, D, or E has the most up-to-date log under Raft’s voting rule?
2. Can that server win term 9 from C/D/E?
3. After it becomes leader, which suffixes may it repair on D and E?
4. Why may A not commit `(4,8)` with only A/B?
5. On healing, what causes A to step down?
6. Would your answer change if `(4,8)` had been durably replicated and committed
   on A/B/C? Explain using the election restriction, not “the majority remembers”
   as a slogan.

## Implementation Exercise — Core

Build a deterministic, single-threaded Raft simulator for three or five servers.
Use an explicit event queue so tests choose delivery, drop, duplication, crash,
restart, partition, and timer events.

Minimum persistent state:

```text
currentTerm, votedFor, log(index, term, command)
```

Minimum modeled volatile state:

```text
role, commitIndex, lastApplied, nextIndex[], matchIndex[]
```

Implement:

1. term changes and one durable vote per term;
2. RequestVote with the last-term/last-index rule;
3. AppendEntries previous-index/term validation and suffix repair;
4. current-term majority commitment and ordered apply;
5. crash/restart restoring only persistent state;
6. stable client operation IDs with replicated dedup results;
7. a snapshot boundary with included index/term and install event;
8. optionally, joint old/new configuration quorum checks.

Assert after every event:

- at most one elected leader per term;
- log matching for equal index/term entries;
- no two applied commands differ at one index;
- committed/applied indices never move backward;
- an operation ID changes application state at most once.

Reproduce the §74.15 trace and the puzzle. Then use randomized schedules only as
additional exploration; retain minimized deterministic counterexamples for every
bug. Document where the simulator assumes atomic durable writes or a central
omniscient scheduler stronger than the real protocol.

## Final Prerequisites and Track Exit — Core

This capstone assumes:

- Chapter 61’s distinction among visibility, local durability, and
  acknowledgement;
- Chapter 68’s partial-failure, synchrony, safety/liveness, FLP, and quorum
  foundations;
- Chapter 69’s suspicion-versus-truth boundary;
- Chapter 70’s terms, votes, leases, and fencing vocabulary;
- Chapter 71’s replication and consistency histories;
- Chapter 72’s repair/convergence boundary;
- Chapter 73’s distinction between atomic commit and consensus.

The optional track is complete when you can take an unfamiliar replicated
system, label its model/protocol/implementation/product claims, identify the
committed authority, prove one safety invariant using durable quorum evidence,
trace a leader failure without overwriting committed state, state the exact read
and retry semantics, and design recovery/operations tests for the gaps between
the proof and deployed code.
