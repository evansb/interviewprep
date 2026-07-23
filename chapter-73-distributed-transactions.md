# Chapter 73 — Distributed Transactions

The cheapest distributed transaction is the one a partitioning scheme keeps local. When one logical operation must update independently failing shards, the design must coordinate not only durability but also one durable outcome. Two-phase commit (2PC) provides atomic commitment, but a prepared participant that cannot discover the decision may have to wait. Sagas and transactional outboxes make a different promise: visible local steps, durable retries, and semantic compensation rather than one globally atomic instant.

This optional-track chapter starts with sharding because placement creates the transaction boundary. It then derives 2PC from its invariants, traces its failure windows, and compares consensus-backed recovery, deterministic execution, sagas, outboxes, idempotence, and coordination avoidance. Sections through §73.10 are the core. §73.11 is a skippable protocol and product reference.

---

## 73.1 The 90-Second Screen

### Five facts

1. A **data partition** or **shard** is an ownership boundary. A transaction contained by one shard can use one local commit mechanism; a cross-shard transaction needs a protocol relating several failure domains.
2. Atomic commit and isolation are separate. **2PC decides commit versus abort**; locks, MVCC, validation, timestamps, or deterministic ordering decide which interleavings are legal.
3. In classic 2PC, a participant durably records `PREPARED` before voting yes. It has promised that it can later commit, so a timeout cannot authorize it to abort. If it cannot learn the decision, it is **in-doubt**.
4. The commit point depends on the design. In a classic durable single-coordinator model it is the coordinator’s durable `COMMIT` decision; in consensus-backed or primary-record designs it is a different explicitly defined durable event.
5. A saga is not ACID rollback spread over services. Local steps may become visible, compensations are new business actions, messages may repeat, and irreversible effects require workflow-specific handling.

### Two decisions

- First choose the shard key and co-location rules that make high-value operations local. Rebalancing ease is not enough; secondary indexes, uniqueness constraints, fan-out reads, and cross-tenant workflows determine transaction cost.
- Use atomic commit when observers must never see a partial outcome and participants can support prepare/recovery. Use a saga/outbox when the business process tolerates visible intermediate states and compensation. Use invariant-specific coordination avoidance only after proving the invariant survives concurrent execution and merge.

### One mental model

```text
placement decides participants
        │
        ├── one participant ── local transaction
        │
        └── several participants
                 │
                 ├── atomic visibility required
                 │      └── isolation + atomic commit + recovery
                 │
                 └── intermediate states acceptable
                        └── saga + outbox/inbox + idempotent effects
```

The key interview question is not “does this system support transactions?” It is:

> What is the invariant, what event commits it, which states survive a crash, and what may a node do when it cannot communicate?

---

## 73.2 Claim Labels and System Model

Distributed-systems claims are meaningless without their model. This chapter labels them:

- **[T] Theorem/model:** a result under stated timing, failure, and communication assumptions.
- **[P] Protocol:** a property of the described protocol when its storage and network assumptions hold.
- **[PV] Product/version/configuration:** behavior that must be checked for a named release and deployment.
- **[D] Derived:** arithmetic from assumptions shown here.

The core 2PC model assumes:

- processes can crash and later recover;
- messages can be lost, duplicated, reordered, or delayed;
- stable storage preserves acknowledged durable records across the covered crashes;
- process identities, transaction IDs, and the participant set are unambiguous;
- nodes are non-Byzantine: they may fail, but do not forge contradictory votes;
- retry and recovery messages can eventually reach the required authority for liveness.

Safety and liveness are different:

- **Safety:** nothing bad happens—no two participants decide differently, and commit is not chosen after a veto.
- **Liveness:** something good eventually happens—nonfailed participants eventually decide and release resources.

Classic 2PC preserves safety when the coordinator is unavailable by allowing liveness to fail. It **blocks** in a particular uncertainty state. “2PC always blocks on coordinator failure” is too broad: it blocks only when a participant is prepared and cannot obtain authoritative decision evidence. A crash before any yes vote, or after the decision is recoverable, has a different outcome.

Timeouts are failure suspicions, not proofs. Before a participant votes yes, local policy may let it abort. After it votes yes, timeout alone does not erase the promise. Similarly, a coordinator may abort while no durable commit decision exists, but it may not overwrite an already durable commit decision.

---

## 73.3 Core — Partitioning Creates the Coordination Boundary

### 73.3.1 Local versus distributed work

Suppose a transfer debits account `A` and credits account `B`.

```text
co-located                           cross-shard
┌──────── shard 7 ────────┐         ┌── shard 2 ──┐  ┌── shard 9 ──┐
│ A -= 10; B += 10        │         │ A -= 10     │  │ B += 10     │
│ one local transaction   │         │ local WAL   │  │ local WAL   │
└─────────────────────────┘         └─────────────┘  └─────────────┘
                                              one outcome must cover both
```

The local transaction can establish atomicity and isolation with one storage engine’s commit and recovery machinery. The cross-shard transaction must identify both participants, keep provisional effects isolated, and make their decisions agree despite independent failures.

“Distributed” is not synonymous with “replicated.” A single logical shard may itself be a replicated consensus group. A transaction touching one such shard is single-partition at the transaction layer, even though replicas communicate internally. A transaction touching two shard groups requires cross-group coordination.

Also distinguish:

- **data partition/shard:** an application data-ownership unit;
- **network partition:** a communication failure separating nodes.

The first is a design choice. The second is a failure the design must survive.

### 73.3.2 Range, hash, and directory placement

| Placement | Useful property | Transaction and operational cost |
|---|---|---|
| Range by ordered key | local ordered scans; related ranges can co-locate | sequential keys can hotspot; splits and boundaries need management |
| Hash by key | tends to spread a suitable key population | destroys order; related records scatter unless hash input encodes affinity |
| Directory/lookup table | arbitrary placement and explicit affinity | routing metadata becomes critical state |
| Consistent-hash family | membership changes can move a fraction of hash space | actual balance/movement depends on tokens, replication, capacity, and transition protocol **[PV]** |

Naive `hash(key) mod N` changes the mapping for a large fraction of keys when `N` changes. In an idealized equal-capacity consistent-hash placement, adding one node to `N` existing nodes moves approximately the new node’s `1/(N+1)` share **[D]**. Real systems use virtual nodes, weighted tokens, replication, topology constraints, or bounded-load variants, so neither movement nor balance is a universal `1/N` fact **[PV]**.

Consistent hashing solves a placement problem, not an atomic handoff problem. During a move, old and new owners can disagree about:

- which routing epoch is current;
- which writes were accepted before the cutover;
- how prepared transactions are recovered;
- whether reads must consult one owner or both;
- when the old owner may delete state.

Section §73.10 returns to this reconfiguration protocol.

### 73.3.3 Co-location is a transaction optimization

Choose a shard key from the operations that must be atomic. If most operations update one customer’s orders, payments, and reservations, a customer/tenant key may keep them local. The costs can include tenant skew, large tenants, cross-tenant queries, and global constraints.

Hidden cross-shard participants often come from:

- globally unique usernames or order numbers;
- secondary indexes;
- foreign-key checks;
- counters and quotas;
- audit or ledger records;
- asynchronous message publication;
- schema metadata or timestamp services.

Before choosing a protocol, write the transaction’s participant-discovery rule. A protocol cannot safely prepare “all participants” if the set can grow after the commit decision.

### 73.3.4 Isolation goals before commit mechanics

Atomic commitment answers: **do all participants commit or all abort?** It does not by itself prevent write skew, lost updates, dirty reads, or cycles in a serialization graph.

A distributed transaction design must name both:

1. **commit guarantee:** atomic commit, atomic visibility, saga completion, or another contract;
2. **isolation/order guarantee:** read committed, snapshot isolation, serializability, strict serializability/external consistency, or an application-specific rule.

Possible concurrency-control mechanisms include distributed two-phase locking, optimistic validation, MVCC timestamps, serialization-graph checking, and deterministic ordering. Their interaction with 2PC determines when locks or versions are retained. “Uses 2PC” is not an isolation level.

---

## 73.4 Core — Atomic Commitment Goals and Invariants

A transaction has coordinator `C` and fixed participant set `P = {A, B, ...}`. Each participant can vote **yes** only after making a durable promise that it can commit. The final decision is `COMMIT` or `ABORT`.

### 73.4.1 Required properties

Terminology varies across papers, so state the properties rather than relying on names:

1. **Agreement:** no two correct or recovering participants decide differently.
2. **Commit validity:** commit requires a yes vote from every required participant.
3. **Abort validity:** a durable no vote prevents commit.
4. **Decision stability:** once a final decision is durable, recovery cannot replace it with the opposite decision.
5. **Nontriviality:** in a failure-free admissible execution where all vote yes, commit is possible; the protocol is not “always abort.”
6. **Termination under stated assumptions:** participants eventually decide when the authorities and communication required by the protocol remain available.

Atomic commitment is related to, but not identical with, consensus. Consensus chooses one proposed value under its validity rule; atomic commit gives each participant a veto over `COMMIT`. Consensus can replicate the state needed to recover a commit decision, but it does not remove participant validation or the veto.

Impossibility and nonblocking claims are model-dependent **[T]**. Fully asynchronous execution provides no sound timeout that distinguishes a crashed node from a slow one. Three-phase protocols gain liveness only under stronger timing and failure assumptions. Consensus-backed designs make progress only while the required quorums and leaders can make progress. Avoid “protocol X never blocks” without its failure model.

### 73.4.2 The six invariants to mark in a trace

For the 2PC protocol developed next:

```text
I1  participant set is fixed before the decision
I2  COMMIT requires durable YES from every participant
I3  YES means the participant can survive and later honor COMMIT
I4  PREPARED cannot unilaterally abort or expose conflicting work
I5  the final decision is durable before behavior depends on it
I6  retries cannot create a second transaction or reverse a terminal state
```

I4 explains blocking. I5 identifies the commit point. I6 requires globally unique transaction identifiers and idempotent protocol handlers.

### 73.4.3 Commit point versus client acknowledgement

The **commit point** is the first irreversible event that fixes `COMMIT` under the protocol’s recovery rules. The **acknowledgement point** is when the client learns success. They need not be the same.

In a classic single-coordinator durable-log design **[P]**:

- before the coordinator durably records `COMMIT`, recovery may choose abort;
- after it durably records `COMMIT`, recovery must drive every prepared participant to commit;
- the client may be acknowledged immediately after that record, after decisions reach participants, or after acknowledgements, depending on API semantics **[PV]**.

In a replicated design, the commit point might be a decision committed to a consensus log. In a primary-record protocol, it might be an atomic change to one designated record. Every design review should circle that exact event.

---

## 73.5 Core — Two-Phase Commit as State Machines

### 73.5.1 Phase 1: prepare and vote

The coordinator sends `PREPARE(txid, participant_set, transaction_data)` to each participant.

Each participant either:

- cannot commit: durably or recoverably establishes `ABORTED` as required, releases provisional resources, and replies `NO`; or
- can commit: validates local constraints, preserves the needed writes and locks/versions, durably records `PREPARED`, then replies `YES`.

The ordering is essential:

```text
durable PREPARED ──before── YES leaves the participant
```

If a participant could send `YES` and then recover with no memory of the promise, the coordinator might commit while that participant aborts.

### 73.5.2 Phase 2: decide and disseminate

If every required participant votes yes, the coordinator durably records `COMMIT` and sends `COMMIT`. If any participant votes no, or the coordinator chooses abort before a commit decision exists, it records whatever recovery state its protocol requires and sends `ABORT`.

On receiving a valid decision, each prepared participant:

1. durably records or applies the decision according to its recovery design;
2. makes committed effects visible or removes aborted effects;
3. releases locks and other prepared resources;
4. acknowledges idempotently.

The coordinator retries decisions until participants acknowledge, then garbage-collects metadata only when doing so cannot strand recovery.

### 73.5.3 Happy-path timeline

```text
Coordinator C                 Participant A              Participant B
     │                              │                          │
     │──── PREPARE(tx7,A,B) ──────▶│                          │
     │──── PREPARE(tx7,A,B) ───────┼─────────────────────────▶│
     │                       validate, persist          validate, persist
     │                       PREPARED(tx7)              PREPARED(tx7)
     │◀─── YES(tx7) ───────────────│                          │
     │◀─── YES(tx7) ───────────────┼──────────────────────────│
     │                              │                          │
     │ persist COMMIT(tx7)          │                          │
     │ ★ classic commit point       │                          │
     │                              │                          │
     │──── COMMIT(tx7) ────────────▶│                          │
     │──── COMMIT(tx7) ─────────────┼─────────────────────────▶│
     │                       persist/apply commit       persist/apply commit
     │                       release resources         release resources
     │◀─── ACK(tx7) ────────────────│                          │
     │◀─── ACK(tx7) ────────────────┼──────────────────────────│
```

The star is specific to the stated classic model. Do not transplant it unchanged to consensus-backed, presumed-abort, or primary-record protocols.

### 73.5.4 Participant state machine

```text
             cannot prepare / local abort
        ┌─────────────────────────────────────┐
        ▼                                     │
     ABORTED ◀──── ACTIVE ── durable YES ──▶ PREPARED
        ▲                                      │  │
        │ authoritative ABORT                  │  │ authoritative COMMIT
        └──────────────────────────────────────┘  ▼
                                               COMMITTED
```

`COMMITTED` and `ABORTED` are stable terminal states. `PREPARED` has no timeout transition. Recovery may use an authoritative decision record or a termination protocol, but “I waited long enough” is not such evidence.

### 73.5.5 Compact validated model

This C++23 model deliberately captures only legal participant transitions and the happy-path application-message count:

```cpp
#include <cassert>
#include <cstddef>

enum class State { active, prepared, committed, aborted };

constexpr bool legal(State from, State to) {
    using enum State;
    return (from == active &&
            (to == prepared || to == aborted)) ||
           (from == prepared &&
            (to == committed || to == aborted)) ||
           from == to; // replay of an idempotent message
}

constexpr bool timeout_may_abort(State s) {
    return s == State::active; // not after a durable YES
}

constexpr std::size_t happy_path_messages(std::size_t participants) {
    return 4 * participants; // prepare, vote, decision, ack
}

static_assert(legal(State::active, State::prepared));
static_assert(!legal(State::prepared, State::active));
static_assert(!timeout_may_abort(State::prepared));
static_assert(legal(State::committed, State::committed));
static_assert(happy_path_messages(3) == 12);

int main() {
    assert(legal(State::prepared, State::committed));
}
```

The `4P` result is **[D]** for one-way application messages in this diagram, excluding client messages, discovery, retransmission, replication, and batching. It is not a latency formula.

### 73.5.6 Why there is no universal forced-log count

An all-yes execution needs enough durable state to preserve promises and the decision, but “2PC performs `2(N+1)` fsyncs” is not generally correct.

Counts change with:

- whether the coordinator is also a participant;
- presumed-abort or presumed-commit logging;
- whether participant commit records must be forced before acknowledgement;
- group commit combining many transactions in one barrier;
- replicated logs whose quorum acknowledgements replace one local `fsync`;
- storage engines that make provisional changes durable before `PREPARE`;
- read-only participants;
- client acknowledgement policy.

Report **durability barriers on the critical path**, not source-level calls or log-record count. One barrier may cover many records; one replicated log append may involve several device writes.

---

## 73.6 Core — Failure Windows and the Blocking State

### 73.6.1 Failure table

| Failure window | Recoverable evidence | Safe action |
|---|---|---|
| Participant fails before durable `PREPARED`/`YES` | no durable promise | it may recover aborted; coordinator cannot commit without its yes |
| Participant fails after durable `PREPARED`, before decision | prepared promise, no local decision | recover in-doubt and query authoritative recovery path |
| Participant fails after durable decision | terminal record/effect | replay decision idempotently |
| Coordinator fails before durable commit decision | no recoverable commit in classic model | recovered authority may choose abort |
| Coordinator fails after durable commit, before any send | commit decision exists | recovery must resend commit |
| Coordinator fails after only some participants learn commit | decision plus mixed knowledge | informed participants stay committed; recovery drives the rest |
| Network isolates a prepared participant | its vote, no decision evidence | wait or use supported termination protocol; timeout alone is insufficient |

“Coordinator failed” does not identify one behavior. The durable state at the crash boundary does.

### 73.6.2 Worked crash trace

Transaction `tx42` transfers 10 units between shards `A` and `B`.

```text
t0  C identifies participant set {A,B}.
t1  A persists PREPARED(tx42, debit 10), retains its lock, replies YES.
t2  B persists PREPARED(tx42, credit 10), retains its lock, replies YES.
t3  C receives both YES votes.
t4  C durably records COMMIT(tx42).              ← commit point in this model
t5  C sends COMMIT to A.
t6  A durably commits, releases its lock, ACKs.
t7  C crashes before sending COMMIT to B.
t8  B times out.
```

At `t8`:

- The transaction is globally committed even though `B` does not know it.
- `B` cannot abort: `A` has committed, and the coordinator’s durable decision requires commit.
- `B` remains prepared, retaining whatever isolation resources the protocol requires.
- When the coordinator recovers, it reads `COMMIT(tx42)` and resends. Duplicate `COMMIT` at `A` must be harmless.

Now move the crash to just before `t4`. Both participants are prepared, but the classic coordinator has no durable decision. A recovered coordinator may decide abort. The participants themselves still cannot infer that fact while the coordinator’s durable log is unreachable: from their viewpoint, the earlier execution (commit recorded but not delivered) is indistinguishable.

That indistinguishability is the **blocking window**:

```text
participant knows: "I promised YES"
participant does not know: "was COMMIT durably chosen?"
safe autonomous choice: none
```

### 73.6.3 Why asking peers only sometimes helps

A termination protocol may let participants exchange state:

- a participant with authoritative `COMMITTED` evidence can prove commit;
- a participant that durably voted no can prove commit was impossible;
- a participant that never prepared may support abort under the protocol’s rules.

But if every reachable participant is merely `PREPARED`, peer exchange cannot distinguish “coordinator committed but message is delayed” from “coordinator crashed before commit.” Cooperative termination narrows some failures; it does not erase the ambiguous all-prepared case **[P]**.

### 73.6.4 Locks, MVCC, and practical blocking

Textbook 2PC often says prepared participants “hold locks.” Some systems instead retain intents, provisional versions, write records, or transaction-status dependencies **[PV]**. The operational symptom remains: conflicting work cannot safely behave as if the prepared transaction aborted.

The blast radius depends on:

- keys/ranges/intents retained;
- isolation level and conflict rules;
- number of transactions queued behind them;
- whether reads can use an older MVCC snapshot;
- coordinator recovery time;
- deadlock detection across shards;
- whether operators can safely resolve an orphan.

Blocking is therefore both a liveness property and a tail-latency/availability incident.

---

## 73.7 Core — Replicating Recovery and Choosing a Commit Design

### 73.7.1 Consensus-backed commit

The single-coordinator weakness is not that 2PC messages have two phases. It is that the evidence needed to resolve the transaction may be available from only one failed authority.

A consensus-backed design replicates participant promises, transaction status, or the coordinator decision so another leader can recover it. Conceptually:

```text
classic:    one coordinator log ── failure may hide the decision

replicated: coordinator/record group
            [replica][replica][replica]
                    quorum commits decision
                    new leader can recover it
```

This improves liveness under the stated quorum and failure assumptions **[P]**. It does not make every partition available:

- each involved shard may need a quorum;
- a reconfiguration may delay progress;
- an unavailable participant can still veto or prevent preparation;
- transactions can wait on conflicts, clocks, or validation;
- the cross-shard protocol still needs a unique decision and idempotent recovery.

Consensus is developed in Chapter 74. Here the important separation is:

> 2PC relates the votes of several participants; consensus makes a participant or decision record fault-tolerant.

### 73.7.2 Protocol comparison

| Approach | Visibility/atomicity | Blocking and recovery | Main cost/fit |
|---|---|---|---|
| Classic durable 2PC | global atomic commit; isolation is separate | prepared state may wait for coordinator evidence | participants support prepare; bounded operational recovery |
| Consensus-backed commit | global atomic commit under quorum model | leader replacement can recover replicated decision; quorum loss still blocks | replicated shards, higher message/storage cost |
| Deterministic ordering | serial order established before execution **[P]** | recovery follows replicated input/order; unknown read sets complicate execution | predictable transactions and declared access sets |
| Primary-record/intent protocol | atomicity depends on one designated transactional record **[P]** | readers/helpers resolve secondaries from primary state | transactional underlying store and cleanup machinery |
| Saga | no single atomic instant across services | durable workflow retries and compensates | business process accepts intermediate states |
| Outbox/inbox | atomic local state plus durable message intent | relay and consumers tolerate duplicates | database-to-message integration |
| Coordination avoidance | invariant-specific, not generic serializability | no global commit when proof permits | operations whose merge preserves required invariants |

### 73.7.3 Worked design choice

Consider an order workflow:

- decrement inventory;
- authorize payment;
- create shipment;
- expose “confirmed” only when all succeed.

Ask in order:

1. **Can placement make it local?** Co-locate inventory reservations by warehouse and orders by customer may conflict; no single key may contain every high-volume path.
2. **Must intermediate state be invisible?** A financial ledger transfer may require atomic commit. An order may expose `PENDING` and converge through a workflow.
3. **Can every participant prepare?** An external payment provider usually cannot hold a database prepared transaction on your behalf.
4. **Are effects reversible?** Authorization may be voided; an email cannot be unsent; a shipped parcel needs a return process.
5. **What is the recovery authority?** A replicated transaction record, durable workflow state, primary intent, or operator runbook must answer after crashes.

A defensible choice:

> Keep ledger entries within an atomic database transaction where possible. Model the wider order as a saga. Store each local state change and its outbox event atomically, use a stable order/step ID as the provider idempotency key, and make `CONFIRMED` conditional on recorded inventory and payment outcomes. Shipping begins only after that barrier. Failed compensation moves to a visible intervention state rather than pretending the saga rolled back.

That design gives up one global atomic instant across the payment provider and shipping service. It gains compatibility with participants that cannot prepare and makes recovery explicit.

---

## 73.8 Core — Sagas and Compensating Actions

A **saga** decomposes a long business transaction into local transactions:

```text
T1 → T2 → T3 → ... → Tn
```

If `Ti` fails, the workflow invokes compensations for earlier completed steps in reverse logical order where appropriate:

```text
T1 → T2 → failure
          C2 → C1
```

A compensation is not a byte-for-byte rollback. It is a new action under current reality.

### 73.8.1 Order saga

| Forward step | Durable workflow state | Possible compensation |
|---|---|---|
| Create order | `PENDING` | mark `CANCELLED` |
| Reserve inventory | `INVENTORY_RESERVED` | release reservation |
| Authorize payment | `PAYMENT_AUTHORIZED` | void/refund authorization |
| Confirm order | `CONFIRMED` | business-specific cancellation |
| Request shipment | `SHIP_REQUESTED` | cancel if not dispatched; otherwise return process |

Intermediate states may be observed. Other workflows must understand that `PENDING` is neither confirmed nor absent. If payment authorization succeeds but the success response is lost, retry must not authorize twice.

### 73.8.2 Orchestration versus choreography

- **Orchestration:** one durable workflow component records state and commands each step. Recovery and observability are centralized, but the orchestrator must be highly available and its state machine carefully versioned.
- **Choreography:** services react to events and emit later events. Coupling looks looser, but the global flow, compensation order, and debugging can become implicit.

Neither removes the need for durable state, deduplication, and terminal failure policy. A choreography with no recorded workflow state can be harder to recover than a failed coordinator.

### 73.8.3 Compensation rules

A compensation should be:

- **retryable:** repeated attempts converge on the intended business state;
- **commutative where possible:** reordering independent compensations is harmless;
- **conditional:** release only the reservation created by this saga;
- **auditable:** retain why and by whom the reversal occurred;
- **bounded by policy:** after repeated failure, enter an explicit manual/intervention state.

Some actions are irreversible or only approximately reversible: sending information, executing a market trade, charging a nonrefundable fee, or shipping goods. Move irreversible steps after a confirmation barrier, redesign the contract, or accept a forward-recovery process. Do not label an apology email “rollback.”

### 73.8.4 Isolation anomalies in sagas

Because steps commit independently, another workflow can observe and act on partial state. Sagas may need:

- reservations rather than immediate consumption;
- semantic locks such as `PENDING_CANCELLATION`;
- version checks on transitions;
- commutative operations;
- escrowed capacity;
- explicit deadlines.

These are application-level concurrency controls. Sagas replace global atomicity with a workflow protocol; they do not remove races.

---

## 73.9 Core — Transactional Outbox, Inbox, and Idempotence

### 73.9.1 The dual-write failure

A service updates its database and publishes `OrderCreated`:

```text
database commit succeeds → process crashes → message never published
message publishes         → database aborts → consumer sees nonexistent order
```

Reversing the order does not solve the atomicity gap. Without a distributed transaction spanning database and broker, the service cannot make two independent commits one event.

### 73.9.2 Transactional outbox

Write business state and an outbox row in one local transaction:

```text
BEGIN
  INSERT order(..., state='PENDING');
  INSERT outbox(event_id, aggregate_id, type, payload);
COMMIT
```

A relay later publishes pending outbox rows. If it crashes after publish but before marking the row delivered, it publishes again. Therefore the baseline contract is usually **at-least-once delivery** **[P]**, not exactly-once effects.

Deletion or compaction of outbox rows must preserve recovery and audit needs. Change-data-capture based relays have different ordering and offset semantics **[PV]**, but the same proof obligation: a committed business change has a recoverable publication intent.

### 73.9.3 Consumer inbox/deduplication

A consumer uses a stable `event_id`:

```text
BEGIN
  if event_id absent from inbox:
      apply local business transition
      insert inbox(event_id)
COMMIT
ACK broker message
```

The inbox insert and local effect must be in the same local transaction. Otherwise a crash can record “processed” without the effect, or apply the effect without the dedup record.

Deduplication has a retention horizon. If an event can be retried after the inbox entry expires, the duplicate can reappear. Retention must cover broker replay, disaster recovery, producer retry, and backup restore assumptions.

### 73.9.4 Idempotence is about meaning

An operation is idempotent when repetition has the same relevant effect as one execution. Techniques include:

- unique operation/event IDs with a uniqueness constraint;
- conditional transitions such as `UPDATE ... WHERE state='PENDING'`;
- compare-and-swap on a version;
- provider idempotency keys;
- natural set semantics;
- fencing tokens that reject commands from an obsolete workflow owner.

“Set balance to 90” may look idempotent but can overwrite a legitimate later change. “Debit 10” with no operation ID is not idempotent. The correct form often means “apply debit operation `d17` once if account version and business constraints permit.”

### 73.9.5 The duplicate-charge puzzle

```text
t0 local transaction records PAYMENT_REQUESTED and outbox event e9
t1 relay publishes e9
t2 payment consumer charges card
t3 consumer crashes before committing inbox(e9)
t4 broker redelivers e9
```

An inbox alone did not protect the external charge because the provider call was outside the consumer database transaction. The payment provider must accept a stable idempotency key such as `order42:authorize:v1`, or the workflow needs a query/reconciliation API that determines whether the charge occurred. If the provider offers neither, exactly-once charging cannot be manufactured by the broker consumer.

End-to-end “exactly once” is a contract across producer identity, broker semantics, consumer transaction, external effects, retention, and recovery. A product’s exactly-once mode covers only its documented boundary **[PV]**.

---

## 73.10 Core — Reconfiguration and Operations

### 73.10.1 Moving a shard is a protocol

A safe migration from owner `O` to owner `N` needs an ownership epoch or equivalent fencing:

```text
epoch 12: O owns range R
    │ copy/catch up while writes continue under a defined rule
    │ establish handoff barrier
    ▼
epoch 13: N owns range R; O rejects or forwards stale-epoch writes
```

The exact mechanism may be consensus reconfiguration, a metadata transaction, leases, dual writes, log catch-up, or stop-and-copy **[PV]**. Required invariants include:

1. at most one authority accepts an unfenced write for an epoch;
2. every acknowledged write appears at the new owner or remains recoverable;
3. routers detect stale mappings and retry without duplicating a transaction;
4. reads during transition have a defined source;
5. prepared transactions remain resolvable.

### 73.10.2 Transactions spanning a handoff

Suppose `tx42` prepares on old owner `O`, then range `R` moves. Deleting `O`’s prepared state or changing the participant identity can strand or split the transaction.

Safe choices include:

- drain cross-shard transactions before cutover;
- pin old ownership until prepared transactions resolve;
- transfer transaction records and locks under a protocol that preserves identity and durability;
- make the shard’s replicated logical identity stable while physical replicas change.

The last option is common conceptually: transactions name shard/group identities, while Chapter 74’s membership protocol changes their replicas. Product details vary **[PV]**.

### 73.10.3 Operational measurements

Observe the mechanism, not only transaction latency:

- local versus cross-shard transaction ratio;
- participants per transaction and participant-discovery failures;
- prepare, decision, and acknowledgement latency distributions;
- count, age, and resource footprint of prepared/in-doubt transactions;
- locks/intents/versions blocked behind prepared work;
- coordinator/transaction-record recovery time;
- decision retransmissions and duplicate protocol messages;
- deadlocks and abort reasons by phase;
- saga counts by state, age, compensation, and manual intervention;
- outbox lag, relay retries, inbox duplicates, and retention;
- idempotency-key conflicts and external reconciliation backlog;
- routing-epoch mismatches, migration backlog, and prepared transactions pinning old ownership;
- per-shard quorum/leader availability for consensus-backed designs.

A transaction can have good median latency while a tiny number of old prepared records blocks critical keys. Age and footprint are as important as count.

### 73.10.4 Failure drills

In an isolated environment, test:

1. participant crash before and after durable prepare;
2. coordinator crash before and after the commit point;
3. decision delivered to only a subset;
4. duplicate prepare, decision, outbox, and saga messages;
5. coordinator metadata loss and restoration;
6. long network isolation of one prepared participant;
7. shard move with active and prepared transactions;
8. saga compensation failure and operator takeover;
9. broker replay after dedup retention;
10. external API timeout after an effect may have occurred.

For each test, record the authoritative state, permitted next transitions, client-visible outcome, and resource-release condition. A runbook that says “restart it” without identifying the decision evidence is unsafe.

### 73.10.5 Manual resolution

Some products expose prepared transactions to operators **[PV]**. Manual `COMMIT` or `ROLLBACK` is not a generic timeout policy. The operator must reconstruct the global decision from authoritative records. Guessing abort to clear locks can violate atomicity; guessing commit can apply work after a veto.

If evidence is irretrievably lost, the system is outside the protocol’s promised failure model. The response becomes incident containment and business reconciliation, not a clever inference from participant state.

---

## 73.11 Skippable Reference — Selected Protocols and Systems

Skip this section on a first pass. It maps named designs to the core choices without turning the chapter into a product catalog.

### 73.11.1 Three-phase commit

Three-phase commit inserts an intermediate `PRECOMMIT` state so participants can distinguish more failure cases. Its nonblocking result relies on stronger synchrony and failure assumptions **[T/P]**—for example, bounds or failure detectors sufficient to avoid contradictory decisions across partitions.

It is useful as a lesson:

> Adding a state does not defeat uncertainty; the timing model makes the new transition safe.

Under an asynchronous partition, a timeout does not prove what the other side observed. Production designs generally prefer safe blocking plus replicated recovery over assuming a partition cannot occur. Do not claim “nobody uses 3PC” as a theorem; say why its assumptions rarely match the target system.

### 73.11.2 Deterministic transactions and Calvin

Calvin orders transactions through a replicated sequencing layer, then executes the known order deterministically. Agreeing on order before execution can remove the usual per-transaction distributed commit path for suitable transactions **[P]**.

Trade-offs include:

- read/write sets often need to be known or discovered through extra machinery;
- nondeterministic application behavior must be controlled;
- slow transactions can interfere with ordered execution;
- replicated sequencing and recovery still coordinate.

Determinism moves coordination earlier; it does not make agreement free.

### 73.11.3 Percolator-style primary records

The Percolator paper builds snapshot-isolated transactions over Bigtable using timestamped data, locks/intents stored as data, and a designated primary. The primary’s transactional state determines whether helpers roll forward or roll back secondary intents **[P]**.

This avoids dependence on one continuously running coordinator process, but still needs:

- an atomic underlying row operation;
- timestamp allocation;
- stale-lock detection and cleanup;
- a clear primary state;
- acceptance of snapshot isolation rather than automatic serializability.

“No coordinator process” does not mean “no commit point or coordination.”

### 73.11.4 Spanner and TrueTime

The Spanner design combines replicated data partitions, cross-group 2PC for read-write transactions, concurrency control, MVCC, and TrueTime **[P]**. TrueTime returns an interval guaranteed to contain real time under its infrastructure assumptions. Commit wait delays acknowledgement until the selected commit timestamp is definitely in the past, supporting external consistency.

The wait is not a universal fixed `2ε`. It depends on the timestamp-selection rule, current uncertainty interval, and work elapsed before the wait. TrueTime bounds and product behavior are implementation/deployment claims **[PV]**. Use the current documentation or paper for the exact transaction path being discussed.

### 73.11.5 Coordination avoidance, I-confluence, escrow, and RAMP

Coordination can be omitted only relative to a stated invariant and operation set.

- **I-confluence:** if independently valid states produced by allowed operations merge to another valid state, coordination may be unnecessary for that invariant **[T/model]**.
- **Escrow:** preallocate rights—such as inventory units—to partitions so operations within local rights preserve a global bound.
- **CRDT-shaped operations:** use algebraic merge properties for a specific data type and invariant.
- **RAMP transactions:** provide read-atomic visibility across partitions with metadata and repair reads, while not promising general serializability **[P]**.

Examples:

- grow-only set insertion under “all inserted elements remain” can merge safely;
- global username uniqueness does not survive two independent assignments of the same name;
- “balance never below zero” does not survive unrestricted concurrent withdrawals, but escrowed withdrawal rights can avoid coordination until rights must move.

The proof obligation comes before the optimization.

### 73.11.6 PostgreSQL prepared transactions

PostgreSQL exposes `PREPARE TRANSACTION`, `COMMIT PREPARED`, and `ROLLBACK PREPARED` **[PV]**. It can serve as a participant in an external transaction manager’s protocol. Operational behavior, configuration, lock retention, restart recovery, and restrictions must be checked against the deployed major version.

The durable lesson is not a default setting. It is that enabling a participant-side prepare API does not supply a crash-recoverable global coordinator. Orphaned prepared transactions require authoritative resolution.

### 73.11.7 Primary references

- Gray and Reuter, *Transaction Processing: Concepts and Techniques*, atomic commitment and recovery.
- Skeen, [*Nonblocking Commit Protocols*](https://doi.org/10.1145/319566.319574).
- Thomson et al., [*Calvin: Fast Distributed Transactions for Partitioned Database Systems*](https://cs.yale.edu/homes/thomson/publications/calvin-sigmod12.pdf).
- Corbett et al., [*Spanner: Google’s Globally-Distributed Database*](https://research.google/pubs/spanner-googles-globally-distributed-database-2/).
- Peng and Dabek, [*Large-scale Incremental Processing Using Distributed Transactions and Notifications*](https://research.google/pubs/large-scale-incremental-processing-using-distributed-transactions-and-notifications/).
- Bailis et al., [*Coordination Avoidance in Database Systems*](https://www.vldb.org/pvldb/vol8/p185-bailis.pdf).
- Bailis et al., [*Scalable Atomic Visibility with RAMP Transactions*](https://www.vldb.org/pvldb/vol7/p181-bailis.pdf).
- PostgreSQL, [current prepared-transaction documentation](https://www.postgresql.org/docs/current/sql-prepare-transaction.html).

Product documentation is versioned evidence, not a protocol specification.

---

## 73.12 Recall Card

```text
PLACEMENT
  partition key decides common transaction boundary
  co-locate invariants; account for indexes, uniqueness, quotas, fan-out
  consistent hashing changes movement, not handoff correctness

GOALS
  atomic commit ≠ isolation
  state commit guarantee + isolation/order guarantee + failure model

2PC
  phase 1: durable PREPARED before YES
  phase 2: durable final decision, then idempotent dissemination
  prepared participant cannot abort on timeout
  in-doubt means decision unknown locally, not necessarily undecided globally

INVARIANTS
  fixed participant set
  commit only after every durable YES
  YES survives recovery
  final decision stable
  retries preserve one terminal outcome

COMMIT POINT
  first irreversible durable event fixing COMMIT
  classic coordinator log, consensus record, or primary record—name it
  client acknowledgement may occur later

ALTERNATIVES
  consensus: replicate recovery evidence; quorum loss can still block
  deterministic: coordinate order before execution
  saga: visible local steps + semantic compensation
  outbox/inbox: atomic local intent + at-least-once relay + dedup
  avoidance: prove invariant survives concurrent execution/merge

OPERATIONS
  prepared age/footprint, decision recovery, retries, saga failures,
  outbox lag, dedup horizon, routing epochs, and migration pins
```

---

## 73.13 Review Questions

1. Why should partitioning and co-location be designed before selecting a distributed commit protocol? Give two hidden sources of cross-shard participation.
2. Distinguish atomic commitment from isolation. Can 2PC alone prevent write skew?
3. Draw the participant state machine. Why is there no timeout edge from `PREPARED` to `ABORTED`?
4. In the classic model, identify the commit point and the possible client acknowledgement points. How would a consensus-backed decision change the answer?
5. Replay the `tx42` crash immediately before and immediately after the coordinator’s durable commit decision. What may each participant safely do?
6. Why is a fixed forced-`fsync` formula for 2PC misleading? Name four implementation choices that change the durability barriers.
7. A cluster grows from 15 to 16 equal-capacity nodes. Under the idealized consistent-hash model, what share moves to the new node? Why can the production value differ?
8. Compare 2PC and a saga for an order that touches an internal ledger, external payment provider, and shipping service. Which effect should be delayed, and what is the recovery authority?
9. Trace an outbox relay crash after publish and an inbox consumer crash after an external effect. Which duplicates can local database transactions suppress, and which require provider idempotence or reconciliation?
10. During a shard move, an old owner holds a prepared transaction. Give three safe handling strategies and explain why deleting the old state is unsafe.

---

## 73.14 Puzzle and Applied Exercise

### Puzzle: the silent coordinator

Participants `A`, `B`, and `D` all show `PREPARED(tx9)`. The coordinator is unreachable. An operator says:

> “All three voted yes, so commit is safe.”

Construct two executions consistent with the visible participant state:

1. the coordinator durably committed but delivered no decision;
2. the coordinator crashed before durably committing.

The same participant view requires opposite recovery behavior if a decision exists. Therefore votes alone do not reveal whether the classic commit point occurred. What additional authoritative evidence would make progress safe?

### Applied exercise

Build a small deterministic simulator:

1. Model coordinator and participant states as enums.
2. Model stable records separately from volatile process state.
3. Deliver, drop, duplicate, and reorder `PREPARE`, `YES/NO`, `COMMIT/ABORT`, and `ACK`.
4. Crash/recover any process between events.
5. Assert after every transition:
   - no participant is both committed and aborted;
   - commit implies every participant durably voted yes;
   - terminal decisions never reverse;
   - a prepared participant does not autonomously abort.
6. Search short traces and print the smallest trace that leaves a participant in-doubt.
7. Replace the coordinator’s single durable record with a toy majority-replicated decision record. Re-run failures with and without a quorum.
8. Add a separate saga simulator with outbox IDs, duplicate delivery, compensation, and an irreversible external effect.

The exercise is successful when it finds blocking executions without finding a safety violation. If every run terminates because the simulator converts timeout into abort, the simulator has encoded the bug.

---

## 73.15 Common Traps

- **“A single-node transaction gets atomicity for free.”** It still needs logging, ordering, recovery, and storage assumptions. Distribution adds failure domains; it does not create the first correctness cost.
- **“2PC provides serializability.”** It provides atomic commitment. Concurrency control provides isolation/order.
- **“The coordinator always commits after all yes votes.”** It may fail before the commit point; recovered policy can then abort in the classic model.
- **“A prepared participant can abort after a long timeout.”** Timeout is not evidence that no commit decision exists.
- **“2PC loses decisions.”** Under its storage assumptions, a durable decision is recovered and retransmitted. The characteristic failure is inability to discover it in bounded time.
- **“2PC always requires two round trips and `2(N+1)` fsyncs.”** Message, acknowledgement, batching, replication, read-only participants, and logging policies change the path. State the exact accounting boundary.
- **“Consensus makes cross-shard transactions nonblocking.”** It removes selected single failures while required quorums progress. Quorum loss, participant veto, conflicts, and reconfiguration can still delay termination.
- **“Three-phase commit fixes 2PC.”** Its liveness relies on stronger synchrony/failure assumptions; a timeout in an asynchronous partition is not new knowledge.
- **“Consistent hashing moves exactly `1/N` keys.”** That is an idealized expected-share argument, not a product guarantee, and it says nothing about safe handoff.
- **“A saga rolls back.”** Compensation is a new visible business action and can fail.
- **“The outbox gives exactly-once processing.”** It closes the local database/publication-intent gap. Relay delivery can repeat, and external effects need their own idempotence boundary.
- **“An idempotency key lasts forever.”** Deduplication is only as durable and long-lived as the retained record and provider contract.
- **“Prepared state can be discarded during shard movement.”** It is a durable promise and must remain resolvable across ownership changes.
- **“Manual resolution means choose the least disruptive outcome.”** It must follow authoritative decision evidence; operational convenience cannot override atomicity.
- **“Every invariant requires serializable distributed transactions.”** Some operations admit escrow, commutative data types, or I-confluent execution—but only after a proof for the stated invariant.

---

## 73.16 Prerequisite for Chapter 74

Chapter 74 owns consensus and state-machine replication. Bring these distinctions:

1. Atomic commitment asks whether a fixed set of participants all accept one transaction; every participant can veto commit.
2. Consensus chooses one value while preserving agreement under its validity and quorum model.
3. 2PC can use consensus-replicated shards or a replicated decision record, but the layers keep different invariants.
4. A quorum is not “enough nodes” in the abstract; its intersection, membership epoch, durable log, and leader rules establish safety.

When Chapter 74 presents Raft or Paxos, ask exactly which Chapter 73 state they replicate: a participant’s prepare promise, the coordinator’s transaction record, a shard’s command log, or all three. “Uses consensus” is not yet a transaction design.
