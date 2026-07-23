# Chapter 70 — Leader Election

## Why this matters — Core

A leader is a temporary authority to perform a role: assign sequence numbers, accept writes, schedule work, or coordinate failover. Election chooses that authority; it does not by itself replicate data, commit writes, make clocks trustworthy, or stop an old leader from touching an external resource.

That boundary explains most split-brain incidents. A node loses contact with the electorate, pauses, or becomes isolated. Another node wins a newer election. The old node can still believe it leads, and a delayed operation can still reach storage. Safe systems therefore constrain actions rather than trying to make every node’s belief change simultaneously:

- votes and intersecting quorums authorize at most one winner in a term and configuration;
- monotonically ordered epochs distinguish newer authority from stale authority;
- the protected resource enforces a fencing token;
- failover does not advertise the new leader until fencing, data readiness, and routing are complete.

This optional-track chapter develops those election prerequisites. Chapter 69 owns failure detection: suspicion triggers an election but never proves a crash. Chapter 71 owns replication and consistency after failover. Chapter 74 owns full Raft, Paxos, log commitment, and membership consensus; this chapter uses only the voting and term facts needed to reason about elections.

## 90-second screen — Core

Retain these facts:

1. An **epoch** or **term** orders leadership attempts. It must survive restart, be compared on every relevant message, and never be confused with wall-clock time.
2. In one fixed configuration, two election quorums that intersect cannot elect two candidates in the same term if every voter durably votes at most once in that term.
3. That theorem does not prevent an old-term node from still believing it leads. Every side effect needs current authorization; external resources need fencing.
4. A fencing token works only when the resource atomically rejects tokens below its highest accepted token. The new leader must establish the higher fence before becoming ready.
5. A lease is authority limited by a timing model. Monotonic clocks prevent wall-clock jumps, but not unbounded drift, process pause, VM suspend, delayed I/O, or an unspecified grantor protocol.
6. Election success is only one failover stage: detect → elect → fence → verify/catch up state → publish routing → reconcile clients.
7. Reconfiguration changes the quorum universe. Majority intersection proves safety only within the same membership; safe transitions need joint/overlapping authorization.

Be ready to defend two decisions:

- Use a quorum-backed service when leadership protects durable or externally visible state. Bully/ring/priority schemes are teaching tools unless the environment supplies equivalent membership, partition, epoch, and fencing guarantees.
- Choose election and lease timing from measured distributions and an explicit failure model. Timeouts affect liveness and churn; they must not be the sole safety mechanism.

## 70.1 Terms, Roles, and the State Model — Core

### Why have a leader?

Leaders reduce coordination by making one participant the serialization point. Common roles include:

| Leader role | Exclusive decision | What election does not guarantee |
|---|---|---|
| replicated-log leader | proposes an order | that a proposal is committed or durable |
| database primary | accepts writes | that it has every committed write |
| scheduler/controller | assigns work | that an old assignment cannot still execute |
| shard owner | serves a key range | that clients stopped using the prior owner |
| maintenance coordinator | runs one cleanup | that a duplicated cleanup is harmless |

A leader is useful when single-writer coordination, a total order, or one coordinator simplifies the system. It can become a throughput bottleneck and a failover dependency. Sharding creates multiple leaders for disjoint scopes; leaderless replication accepts different conflict/reconciliation costs. Those consistency choices belong to Chapter 71.

Define the scope in the election identity. “Leader” without `(service, shard, configuration)` is ambiguous. A node can lead shard 7 in configuration 12 while following shard 8.

### Election versus consensus

Leader election asks, “who is currently authorized to attempt the role?” Consensus asks replicas to agree on durable values/order despite failures. They are related but not interchangeable:

- a consensus protocol often elects a leader to make repeated agreement efficient;
- a leader-election service is often implemented by a consensus system;
- choosing a process does not prove that its data is current;
- publishing a leader key is not the same as committing application writes.

This chapter assumes the electorate has a durable mechanism for terms, votes, and configuration changes. Chapter 74 explains how Raft/Paxos-like protocols provide that mechanism and how log freshness constrains candidacy.

### Durable and volatile state

The smallest useful election state is:

```text
durable:
    configuration_id
    current_term
    voted_for[current_term]       // none or one candidate
    product-specific freshness metadata

volatile:
    role = follower | candidate | leader
    observed leader
    campaign/lease deadlines
    votes received in current attempt
```

`current_term` and `voted_for` must be durably recorded before granting a vote. If a voter replies “yes,” crashes, forgets, and votes again after restart, two candidates can each collect a quorum in the same term.

A term is a logical monotonic number within an agreed history, not a timestamp. Messages carrying a higher valid term make a participant advance and step down according to the protocol. Messages carrying a lower term are stale. Counter exhaustion, restore-from-old-snapshot, storage loss, and configuration identity are real design cases; “use a 64-bit integer” reduces frequency but does not define recovery.

### Compact C++23 state model

This model demonstrates term/vote transitions, not a full consensus protocol. `eligible` stands for the replication protocol’s candidate-freshness rule.

```cpp
#include <cstddef>
#include <cstdint>
#include <optional>

using Term = std::uint64_t;
using Node = std::uint32_t;

struct DurableElection {
    std::uint64_t configuration = 0;
    Term term = 0;
    std::optional<Node> voted_for;
};

struct VoteRequest {
    std::uint64_t configuration;
    Term term;
    Node candidate;
};

struct VoteReply {
    Term term;
    bool granted;
};

VoteReply consider_vote(DurableElection& state,
                        const VoteRequest request, bool eligible) {
    if (request.configuration != state.configuration)
        return {state.term, false};
    if (request.term < state.term)
        return {state.term, false};
    if (request.term > state.term) {
        state.term = request.term;
        state.voted_for.reset();
        // Persist term/reset atomically before any reply.
    }
    const bool available =
        !state.voted_for || *state.voted_for == request.candidate;
    if (eligible && available) {
        state.voted_for = request.candidate;
        // Persist the vote before sending granted=true.
        return {state.term, true};
    }
    return {state.term, false};
}

constexpr std::size_t majority(std::size_t voters) {
    return voters / 2 + 1;
}

constexpr bool quorums_must_intersect(std::size_t members,
                                      std::size_t a, std::size_t b) {
    return a <= members && b <= members && a > members - b;
}
```

The comments are part of the correctness contract. C++ assignment is not durable persistence; a product needs a transactional metadata store or log and recovery rules. Concurrent calls also need synchronization. Integer types, encoding, and storage atomicity are implementation choices, not properties of the election theorem.

Useful checks:

```cpp
static_assert(majority(1) == 1);
static_assert(majority(5) == 3);
static_assert(quorums_must_intersect(5, 3, 3));
static_assert(!quorums_must_intersect(6, 3, 3));
```

### State-transition invariants

The state machine needs more than a `leader` Boolean:

| Event | Required transition |
|---|---|
| receive valid higher term | durably advance term, clear prior-term vote, stop old-term authority |
| receive lower term | reject/redirect; never move durable term backward |
| start campaign | choose/persist new term and self-vote before counting it |
| grant vote | persist candidate identity before replying success |
| collect quorum | enter elected-but-not-yet-fenced state |
| lose lease/quorum/eligibility | stop initiating work and enter step-down path |
| restart | reconstruct durable term/vote/configuration before sending messages |

Advancing to a higher term does not mean the observer elected the sender. A malformed or unauthenticated packet must not be allowed to force unbounded term increases; membership, identity, and message authentication are part of the threat model.

Leadership state should be scoped and monotonic:

```text
authority_new > authority_old
accepted_configuration is known
role=SERVING implies:
    election won
    resource fenced
    data/state readiness verified
    publication completed
```

Use one owner or synchronized transitions for volatile role state. In C++, callbacks from timers, RPC completion, storage completion, and shutdown cannot race on `term`/`role` without a data-race-free design. A mutex, event-loop ownership, or carefully designed atomics solves memory safety; it does not solve durability.

## 70.2 Quorum Election — Core

### Triggers, candidates, and votes

A participant becomes a candidate after a protocol trigger: loss of valid leader contact, an explicit administrative transfer, or startup without a known leader. A failure detector supplies suspicion, not truth. The candidate:

1. moves to a term greater than any term it has durably observed;
2. durably votes for itself if allowed;
3. requests votes from the current configuration;
4. includes configuration, term, identity, and required freshness evidence;
5. becomes elected only after a quorum of valid grants;
6. steps down on evidence of a higher term or another protocol-defined disqualifier.

Retries need symmetry breaking under eventual stable communication, but no timeout value proves safety. A short timeout may cause needless campaigns; a long one increases detection delay. Randomization/backoff can improve liveness by reducing repeated tied campaigns. The safe voting and fencing rules must remain correct for every timeout outcome.

### The same-term safety theorem

For a fixed member set `C`, let every winning quorum have size greater than `|C|/2`. Assume each voter durably grants at most one candidate in term `t`.

Suppose candidates `A` and `B` both win term `t`. Their quorums `QA` and `QB` are both majorities, so `QA ∩ QB` is nonempty. A voter in the intersection must have voted for both `A` and `B` in term `t`, contradicting one durable vote per term. Therefore at most one candidate can win that term/configuration.

The general condition is not “majority” but quorum intersection:

```text
for every two election quorums Q1, Q2:
    Q1 ∩ Q2 ≠ ∅
and shared voters cannot authorize conflicting winners
```

Weighted or geographically structured quorums can satisfy this, but their proof and failure availability must be explicit.

### What the theorem does not prove

It does not prove:

- that some candidate eventually wins;
- that a winner has the newest committed data;
- that the old-term leader immediately learns it lost;
- that a leader remains connected to a quorum after election;
- that an external database/storage system rejects the stale leader;
- that elections under two different configurations intersect;
- that writes acknowledged by a prior leader survive failover.

The replication protocol supplies candidate eligibility and commit rules. Fencing supplies external side-effect safety. Reconfiguration supplies cross-membership intersection. Liveness needs a sufficiently stable period with a reachable quorum and retry behavior that eventually produces one viable candidate.

### Safety and liveness invariants

State the contract as properties over executions.

**Election safety:**

```text
for any configuration c and term t:
    at most one candidate has a valid election quorum
```

**Vote integrity:**

```text
after every crash/restart:
    a voter grants at most one candidate in (c, t)
```

**Authority monotonicity:**

```text
a participant/resource that accepts authority a
never later accepts authority b where b < a
```

**Side-effect safety:**

```text
after the new leader's fence commit point:
    no operation from an older authority can mutate the protected resource
```

**Readiness safety:**

```text
SERVING(c,t) implies election + fence + required state prefix + routing publication
```

These properties can hold during arbitrary message delay, duplication, reorder, crash, and recovery, subject to assumptions about Byzantine behavior, durable storage, and resource enforcement. If disks can lose acknowledged votes or nodes can forge identities, add replication/authentication assumptions rather than claiming crash-fault safety covers them.

Liveness is conditional:

```text
if eventually:
  a valid configuration has a mutually reachable quorum,
  durable metadata operations complete,
  at least one eligible candidate can communicate,
  campaigns are retried without permanent collision,
then eventually one candidate reaches SERVING.
```

In a fully asynchronous period, silence cannot distinguish a crash from delay. The system may remain unavailable rather than violate safety. Timers create attempts and randomization can break symmetry once conditions stabilize; neither turns silence into proof. This is the practical impossibility boundary relevant here. Chapter 74 treats the fuller consensus results.

### Quorum calculations and cost

For `n` equal voters, majority is `floor(n/2) + 1`, and the configuration tolerates at most `floor((n - 1)/2)` crash-unavailable voters while retaining a majority.

| Voters | Majority | Crash-unavailable voters tolerated |
|---:|---:|---:|
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 6 | 4 | 2 |
| 7 | 4 | 3 |

Adding one voter can add latency/operational cost without increasing crash tolerance; failure-domain placement matters more than oddness as a slogan. A witness may vote without storing full data, which can preserve election availability but not data durability; its safety depends on the replication design.

Under a stable network, an election attempt needs request/response with enough voters plus durable vote writes. A latency decomposition is:

```text
Telection-attempt
  ≈ candidate term persistence
  + q-th fastest (request + durable voter decision + response)
  + leader activation work
```

Failover includes more:

```text
Tfailover
  = Tsuspicion
  + Σ failed campaigns
  + Tsuccessful election
  + Tfence
  + Tcatch-up/verification
  + Tpublish/reroute
```

These are random variables with correlated tails. There is no universal timeout or election duration. Measure pause, storage, network, overload, and recovery distributions in the target failure domains.

### Candidate freshness boundary

Quorum votes authorize identity; the replication layer must constrain which identity is eligible. A static priority or highest node ID cannot prove that a replica contains committed state.

Suppose the prior leader acknowledged log position 900 under the advertised durability rule. Candidate `A` has through 900 and candidate `B` only through 870. If voters choose `B` because it responds first, positions 871–900 may disappear from the new history. Election safety—one winner—can hold while durability is violated.

The vote request therefore carries product-specific freshness evidence: last accepted/committed log metadata, database timeline and replay position, or another history identifier. A voter grants only if the candidate satisfies the replication protocol’s eligibility predicate. Two numeric offsets from divergent histories are not necessarily comparable; include the history/term information that gives them meaning.

A witness without full data can contribute to quorum availability only under rules that still ensure some winning candidate has the required state. “Three votes” is not equivalent to “three data copies.” After election, replay/catch-up and corruption checks may still be required before fencing readiness.

This chapter treats `eligible` as a predicate because its proof is protocol-specific. Chapter 71 explains replication lag and acknowledged-write loss; Chapter 74 explains consensus log-election restrictions. The reusable boundary is: **election chooses among eligible candidates; it must never redefine stale as current.**

## 70.3 Epochs and Fencing — Core

### Terms reject stale protocol messages

Every leadership action carries an authority version such as:

```text
Authority = (configuration_epoch, election_term)
```

ordered lexicographically under a protocol-defined transition. Recipients remember the greatest valid authority they have accepted and reject lower values. This lets peers recognize stale leaders even if messages are delayed or reordered.

Terms alone constrain cooperating protocol members. They do not stop:

- a paused process from resuming before it reads a newer term;
- a queued device command already outside the process;
- a client with a cached route sending to an old leader;
- an external resource that does not know terms;
- two configurations minting incomparable terms.

### A fencing token is enforced at the side effect

A fencing token is a monotonically ordered authority presented with every protected operation. The resource performs an atomic rule:

```text
if token < highest_token_seen:
    reject as stale
else:
    highest_token_seen := token
    apply operation according to its own transaction/idempotency rules
```

Some resources require strictly greater token for a leadership-open operation and equal token for later operations in that session. The exact API can be a conditional write, compare-and-swap generation, lock generation, reservation key, or transactional metadata row. The required properties are:

1. token order is unique across every authority that can reach the resource;
2. the resource durably and atomically records/enforces the high-water mark;
3. every side effect includes the token—there is no unfenced escape path;
4. the new leader advances/establishes the fence before advertising readiness;
5. restored snapshots and disaster recovery cannot silently move the fence backward.

A token in a log line or request header that no resource checks is not fencing.

### Worked split-brain trace

Five voters elect `L1` in authority `(config 8, term 21)`. `L1` writes to shared storage with token 21.

```text
t0  L1 is leader, token 21; client request X begins.
t1  L1 pauses after preparing X but before storage accepts it.
t2  L1 cannot communicate. A quorum elects L2 in term 22.
t3  L2 sends FENCE(22) to storage.
t4  storage durably records highest_token=22 and acknowledges.
t5  L2 verifies/catches up state, then becomes READY.
t6  L1 resumes and sends delayed WRITE(X, token=21).
t7  storage rejects 21 < 22. No stale side effect occurs.
```

The **fencing commit point** for failover is `t4`, not election at `t2`. Before `t4`, the old token may still be accepted. The new leader must not serve conflicting work until it has established the higher fence and incorporated every operation that could legally precede that point.

If `L1`’s write reached storage at `t2.5`, before token 22, storage may correctly accept it. `L2` must discover that write during catch-up/recovery before becoming ready. Fencing orders authority; it does not erase work that legally committed before the fence advanced.

If storage cannot validate tokens, use infrastructure fencing: revoke a storage reservation, disable a switch port, isolate the host, or power it off—often called **STONITH**. Promotion must wait for confirmed fencing, and the fencing controller itself needs authentication, redundancy, and idempotent recovery. “We sent a power-off request” is weaker than “the old writer can no longer reach the resource.”

### Fencing design boundaries

Token comparison must match the authority domain. A per-process counter is unsafe after process restart; a per-node counter is unsafe when another node takes over; a term without configuration identity can collide after membership restore. A common representation is a tuple or a monotonically allocated revision from the same durable authority that serializes elections.

The resource’s equality rule matters. If token 22 opens a session, later writes with 22 should be accepted from the authenticated owner but another client must not be able to copy the number. Combine the token with principal/session identity, and make “advance fence” an authenticated conditional operation.

Fencing does not make a multi-resource workflow atomic:

```text
leader 22 updates resource A
leader 22 crashes before updating resource B
leader 23 fences both resources
```

The system can be correctly fenced and still have a partial business transaction. Use a transaction protocol, idempotent workflow, or reconciliation. Similarly, fencing rejects old authority; it does not deduplicate two retries by the current authority. Request identity remains necessary.

Disaster restore is a dangerous boundary. Restoring the coordination store and resource from different snapshots can regress the token source or the resource high-water mark. Recovery needs an authority epoch outside the restored snapshot, a coordinated restore, or an operator procedure that advances/fences every resource before service.

### Failure-window diagnosis

When two primaries appear, collect:

- configuration ID, term, and durable vote records;
- the quorum each winner claims;
- lease grant/renew/revoke records and clock source;
- resource high-water fencing token;
- exact readiness/publication times;
- client routing/cache state;
- replication position at fence and promotion;
- infrastructure-fence acknowledgement.

Classify the violation:

| Observation | Likely broken boundary |
|---|---|
| two winners, same term/config | double vote, nonintersecting quorum, or lost durable vote |
| winners from different configurations | unsafe reconfiguration |
| old term performs external write after higher fence | missing/bypass/non-atomic resource validation |
| old write accepted before higher fence, new leader misses it | catch-up/readiness ordering bug |
| two nodes believe leader but only current token commits | expected overlap of belief; safety preserved |

## 70.4 Leases Without Clock Folklore — Core

### What a lease promises

A lease grants authority for a bounded interval under a stated timing model. It can:

- let authority expire without a revocation message;
- bound how long failover may need to wait when the old holder is unreachable;
- support local actions such as reads only when integrated with replication and clock assumptions;
- reduce repeated coordination during the valid interval.

A lease is not merely a TTL field. Define:

- who grants and renews it;
- which quorum or consensus state authorizes the grant;
- whether time is measured by grantor, holder, or absolute timestamps;
- maximum clock-rate error/skew assumed;
- behavior across process pause, host suspend, clock-source change, and restart;
- whether renewal response can be delayed/reordered;
- the conservative holder stop time and grantor regrant time;
- how the resource is fenced.

### Clock assumptions

Wall-clock synchronization is not sufficient. NTP/PTP can adjust civil time and cannot prevent arbitrary process pauses. A monotonic clock avoids ordinary backward wall-clock jumps, but its behavior across suspend/VM migration is platform-specific and its rate can differ from another clock.

Two broad lease designs illustrate the proof obligations:

1. **Grantor-timed lease:** the grantor refuses to issue a conflicting lease until its own recorded interval expires. The holder uses a conservatively shorter interval based on a bounded clock-rate error and message/processing policy.
2. **Quorum/term lease:** a leader infers temporary authority from recent quorum contact under a bound on timing/clock behavior. Read safety also depends on commit state and membership.

Do not copy a duration formula without its clock model. If no finite drift/delay/pause bound is assumed, time alone cannot prove that two holders’ believed intervals do not overlap. Use fencing as the final side-effect guard even when leases are carefully implemented.

### A symbolic lease timeline

Avoid starting with milliseconds. Let:

- `G0` be the grantor’s real-time grant point;
- `Gend` be the earliest real time at which the grantor may regrant;
- `Hreceive` be when the holder learns of the grant;
- `Hstop` be the latest real time at which the holder can initiate protected work.

Non-overlap requires:

```text
Hstop < Gend
```

The implementation does not observe real time directly. It derives `Hstop` and `Gend` using local clocks, bounded clock-rate error, processing rules, and message timing. The safety margin must cover the worst allowed difference under that model. If a pause can occur after the last local check, the holder must check again immediately before work, yet queued/asynchronous work still needs fencing.

A renewal creates another uncertainty window:

```text
holder sends renew ───────────────► grantor
holder waits       ◄─────────────── reply
```

The holder cannot assume the lease extends from reply receipt unless the protocol defines that and the grantor enforces a compatible interval. A lost reply may mean “not renewed” or “renewed but acknowledgement lost.” The safe holder stops by its old conservative deadline; subsequent recovery can learn what the grantor recorded.

Lease liveness cost is also symbolic. If the old holder is unreachable and cannot be positively fenced, the grantor may have to wait until `Gend` before regranting. A longer interval reduces renewal load and sensitivity to short delays but can extend unavailable time; a shorter interval increases renewals and false expiry risk. Measure and choose within the proved clock model.

### Pause and delayed-operation trap

Suppose a holder checks “lease valid,” then pauses before issuing I/O. On resume it may recheck and stop, but a previously submitted asynchronous I/O may already be in the device/network path. A VM snapshot can also restore stale in-memory lease state. Fencing at the resource handles these cases; a local timestamp check cannot retract an operation already outside the process.

Lease renewal should not extend authority based solely on when a response is received; the grant’s start/expiry semantics must account for round-trip uncertainty. Failed renewal means “stop before the conservative local deadline,” not “continue until certain the grantor revoked me.”

### Leases and local reads

“Leader lease means linearizable local reads” is conditional. The leader must:

- be elected under the replication protocol’s safe term/configuration;
- know the state it serves includes the required committed prefix;
- know no conflicting leader can be authorized during the read interval under the lease proof;
- stop before its conservative expiry;
- handle reconfiguration and clock uncertainty.

Chapter 74 explains protocol-specific read-index/lease mechanisms. This chapter does not prescribe a lease timeout or claim that a monotonic clock alone makes reads linearizable.

## 70.5 Failover and Reconfiguration Boundaries — Core

### Election is a middle step, not the finish line

A production failover state machine is:

```text
FOLLOWING
  └─ suspicion/admin trigger → CAMPAIGNING
       └─ quorum won → ELECTED_NOT_FENCED
            └─ resource fence confirmed → FENCED_NOT_READY
                 └─ state caught up/validated → READY_NOT_PUBLISHED
                      └─ routing/catalog published → SERVING

any stage ─ higher term, lost authority, failed validation → STEPPING_DOWN
STEPPING_DOWN ─ stop intake, drain/reject, release/revoke → FOLLOWING
```

Only `SERVING` accepts the role’s external work. Separating states prevents “won election, immediately accept writes” bugs.

Candidate eligibility is role-specific. A database replica may need a minimum durable log position, timeline compatibility, no known corruption, and operator policy. A controller may reconstruct all assignments before acting. A scheduler may reclaim or fence jobs assigned by the prior term. Election priority can choose among eligible nodes but cannot make stale data current.

Client routing also carries an epoch. A response from an old leader should expose a stale-term/redirect signal; clients bound retries and attach idempotency keys. A connection remaining open does not preserve leadership.

### Client and operation ambiguity

Failover produces uncertain outcomes:

```text
client sends request R to old leader
old leader commits R
reply is lost during election
client discovers new leader
```

The election layer cannot tell the client whether `R` committed. Retrying without a stable request ID can duplicate the action. The serving protocol needs idempotency keys, deduplication retention, result lookup, or reconciliation. Terms help reject requests sent to an old leader; they do not answer an operation whose result was lost.

Publication should be monotonic too. DNS, load balancers, service discovery, connection pools, and proxies can retain old routes after the coordination store changes. The old endpoint must reject current work once deposed, and the new endpoint should return its authority so clients can discard stale responses. Routing TTL is not fencing.

Readiness has two audiences: the coordinator may know it is ready, while clients have not converged on the route. During this interval the new leader must tolerate retries to both endpoints without creating two accepted histories. Instrument `elected`, `fenced`, `caught_up`, `published`, and first-successful-client-operation separately.

### Membership is part of the safety proof

The majority-intersection theorem assumes one fixed member set. Consider:

```text
old configuration: {A, B, C}
new configuration: {C, D, E}

old majority {A, B}
new majority {D, E}
```

Both are valid majorities of their own configurations and are disjoint. They can elect conflicting leaders unless the transition itself is safely agreed.

Common solutions include joint consensus, in which transition decisions require quorums from both old and new configurations, or a staged add/catch-up/promote/remove sequence committed by the existing consensus protocol. The exact algorithm belongs to Chapter 74. Election code must at least:

- include configuration ID in requests, votes, terms/tokens, and persisted state;
- reject votes from the wrong configuration;
- prevent two independent administrators from publishing competing memberships;
- ensure new voters are caught up enough for their vote role;
- preserve fencing-token order across the transition.

Do not change multiple voters ad hoc during an outage. Reconfiguration is itself a consensus decision, not a local configuration-file edit.

### Planned transfer versus unplanned failover

A planned transfer can reduce risk:

1. stop or redirect new work;
2. catch the target up;
3. commit/record transfer intent in the current authority;
4. obtain a newer term/token for the target;
5. establish fencing and publish it;
6. step down the source and verify routing.

An unplanned failover cannot trust cooperation from the old leader and must rely on quorum, fencing, catch-up, and conservative recovery. Products often expose “switchover” and “failover” separately for this reason.

### Availability boundary

In a partition, safety can require the minority side to stop. A three-voter system split 2–1 can elect/continue only where the required quorum and data conditions exist. If the external resource is reachable from both sides, fencing remains mandatory.

No election algorithm creates data copies or failure domains. A quorum distributed poorly across power/network zones can lose availability despite enough healthy machines elsewhere. Model correlated failures, not only `n`.

## 70.6 Classical Election Algorithms — Reference

These algorithms are useful for comparing assumptions and message costs. They are not production split-brain solutions unless augmented with durable epochs, safe membership, quorum authorization, and fencing.

### Bully algorithm

Every participant has a total priority. A detector starts an election by contacting higher-priority nodes. If none responds under the assumed timing model, it announces itself; a higher participant can take over, and the highest reachable priority wins.

Worst-case cascaded campaigns send `O(n²)` messages; a favorable initiator uses `O(n)`. The crucial weakness is not message count: in a partition, each component can choose its own highest reachable participant. Silence cannot safely prove that higher nodes are dead in an asynchronous network.

Priority can still be a candidate preference inside a quorum protocol, but it must not override freshness or quorum rules. Automatic failback to a flapping high-priority node can cause churn.

### Next-in-line and invitation variants

A **next-in-line** or successor list precomputes preferred failover order, reducing discovery work in the common case. It does not prove the successor has exclusive authority; it still needs a current term/quorum and fencing.

Invitation/group-merging variants let partitioned groups discover one another and reconcile coordinators when communication returns. Deterministic merge preference helps convergence but does not retroactively make conflicting side effects safe. The groups need compatible epochs/history and a rule for discarding or reconciling work.

### Ring election

In Chang–Roberts-style election, candidates circulate identities around a logical ring; lower identities are suppressed/replaced, and the maximum identity that returns to itself announces leadership. Cost ranges from `O(n)` in favorable cases to `O(n²)` with multiple/adversarial initiators, plus an announcement traversal.

A failed ring successor requires repair or bypass knowledge. More importantly, each partition can form or perceive a different ring and elect a leader. Ring topology reduces neighbor knowledge; it does not supply partition safety.

### Comparison

| Approach | Selection basis | Typical message shape | Partition-safe authorization by itself? | Main teaching value |
|---|---|---|---|---|
| Bully | highest reachable priority | all higher peers; up to `O(n²)` | no | failure-detector and priority assumptions |
| next-in-line | fixed successor order | common case near `O(n)` | no | planned preference is not authorization |
| invitation/group merge | group coordinator | merge/reconciliation messages | not without history/fencing rules | healing requires reconciliation |
| ring | highest ID in perceived ring | ring traversal, `O(n)`–`O(n²)` | no | topology/message trade-off |
| quorum-backed election | term, eligibility, intersecting votes | usually `O(n)` per attempt | same-term/config winner safety | production authorization prerequisite |

## 70.7 Real-System Patterns — Role-specific

Product APIs and defaults change. Treat these as architectural patterns and verify the deployed version’s documentation, membership rules, lease behavior, and operational fencing.

### ZooKeeper client election

Applications commonly implement election with ephemeral sequential znodes under a parent:

1. create an ephemeral sequential candidate node;
2. list candidates;
3. the lowest sequence is leader;
4. otherwise watch the immediate predecessor;
5. if the predecessor disappears before the watch is established, re-list;
6. on session loss/expiry, stop acting and rejoin with new identity.

Watching only the predecessor reduces a herd when the leader disappears. Watches are notifications, not durable queues; code must re-read state and handle one-shot/race semantics.

The sequential suffix can help order contenders, but calling it a fencing token is safe only if the protected resource validates a suitable monotonic value and parent/recreation semantics cannot reset the order unexpectedly. ZooKeeper’s own server leader election and ZAB agreement are separate internals owned by consensus material.

### etcd coordination

etcd provides linearizable transactions, leases, and higher-level concurrency election APIs. A client can campaign under a prefix, observe a leader value, and resign; lease loss removes associated authority according to API semantics. etcd revisions can help order updates, but an external resource must still enforce the chosen token.

etcd’s internal leader election is Raft and belongs to Chapter 74. Client code must handle watch compaction, lease loss, session replacement, and uncertain RPC results. Library/API and server-version compatibility are product concerns.

### Patroni and database failover

Patroni coordinates PostgreSQL HA through a distributed configuration store such as etcd, Consul, ZooKeeper, or Kubernetes mechanisms. A leader lock/lease participates in primary selection, while PostgreSQL replication position, timeline/history, promotion, client routing, and optional watchdog/infrastructure fencing determine safe service.

The DCS deciding one lock holder does not make asynchronous PostgreSQL replicas equally current, and a paused old primary may retain network/storage reachability. Safe configuration is product/version and topology specific; verify failover-lag policy, synchronous mode, watchdog/fencing, DCS quorum, and routing behavior. A planned switchover has stronger coordination than emergency failover.

### Other product lessons

- Redis Sentinel coordinates failover around asynchronous replication; election of a failover coordinator does not imply zero acknowledged-write loss. Exact quorum and majority concepts are Sentinel configuration/version behavior.
- Kafka has cluster/controller leadership and partition leadership; modern and legacy deployment modes use different coordination internals. Leader epochs fence stale partition leaders within the protocol.
- Kubernetes coordination leases are records in an API backed by its consistency system. Client-side leader-election libraries reduce duplicate controllers but side effects still need idempotency/fencing where overlap is dangerous.

The reusable lesson is to separate coordinator election, replicated-data safety, external fencing, and client readiness rather than advertising a product name as the proof.

## 70.8 Liveness, Churn, and Operations — Core

### Election storms

Repeated campaigns can be caused by:

- failure-detection thresholds below normal pause/storage/network tails;
- correlated candidates choosing the same retry schedule;
- overloaded leader heartbeats competing with work;
- a partitioned node repeatedly increasing authority on rejoin;
- flapping priority/failback policy;
- quorum storage too slow to persist votes/renewals.

Mitigations include randomized campaign timing, pre-vote-like checks, leader stickiness, backoff, workload isolation, and planned failback. These are liveness/stability techniques, not substitutes for term, vote, quorum, and fencing safety. Their exact settings come from measurement; “heartbeat every X, timeout after Y” is not a portable recipe.

Track:

- terms/elections per hour and reason;
- failed/split campaigns and candidate identities;
- durable vote latency and q-th response latency;
- leader-contact/renewal latency distributions;
- time in each failover state;
- fence acknowledgement and catch-up lag;
- step-down reason and time to stop external work;
- client redirects/stale-term rejections;
- configuration changes and quorum reachability by failure domain.

### Model checking and fault injection

Unit tests of the happy campaign are insufficient. The state space is small enough to explore:

- two candidates in the same term;
- duplicate and reordered vote requests;
- lost granted replies;
- crash between persisting term and persisting vote;
- crash after persistence but before reply;
- restart from deliberately stale metadata;
- delayed old-leader operations before and after resource fence;
- membership transition with both configurations active.

A small exhaustive simulator can enumerate message choices and assert the invariants in §70.2. Formal tools such as TLA+/PlusCal are well suited to terms, votes, quorums, leases, and reconfiguration, but the model’s storage and clock assumptions must match implementation. Model checking proves the model, not the RPC library, disk, or fence API.

End-to-end fault injection should pause processes rather than only kill them, partition nodes asymmetrically, delay one direction, fill disks, stall vote persistence, suspend VMs, alter permitted clock behavior, and make fence RPC outcomes uncertain. The safety oracle belongs at the protected resource: list accepted `(token, request_id)` operations and assert no older token is accepted after a newer fence.

For liveness, do not assert a fixed completion time under arbitrary faults. Establish a stable suffix of the execution—quorum connected, storage completing, clocks within the assumed model—then assert eventual election and readiness. Report the full latency distribution and failed campaign count.

### Operational decision procedure

Before deploying:

1. Name the leadership scope and side effects.
2. Define durable term, vote, and configuration storage.
3. Prove election-quorum intersection and one vote per term.
4. Define candidate freshness with the replication layer.
5. Identify every external side-effect path and its fencing enforcement.
6. Specify lease timing assumptions or avoid lease-dependent safety.
7. Define failover readiness and client publication boundaries.
8. Define safe membership transition and disaster-restore behavior.
9. Test pauses, partitions, delayed packets, storage stalls, clock behavior, and fencing failure.
10. Instrument the failure-window timeline before tuning liveness.

### Fault-injection matrix

| Fault | Safety assertion | Expected liveness behavior |
|---|---|---|
| candidate crashes after voter persists grant | voter never grants another candidate in same term | retry in later term |
| voter reply lost | no second same-term vote | candidate may fail and retry |
| old leader pauses through new election | old token rejected after fence | new leader serves after readiness |
| old write arrives before new fence | new leader catches it up or accounts for it | failover may wait |
| 2–1 partition in three voters | minority cannot win/commit | majority may progress |
| clock jumps/suspend during lease | no unfenced action relies on local expiry | lease may be abandoned/reacquired |
| member removed while partitioned | old config cannot independently authorize forever | joint transition or halt |
| DCS available but candidate data stale | ineligible candidate not promoted | wait for eligible node/operator recovery |

## 70.9 Recall and Practice — Core

### Recall card

- Election assigns temporary authority; consensus/replication determines durable history.
- Persist term and vote before granting. One vote per term is a crash-recovery invariant.
- Majority safety is an intersection proof for one configuration, not a universal magic number.
- Old and new terms can overlap in belief. Terms reject peer messages; fencing rejects stale side effects.
- Establish the higher resource fence before the new leader becomes ready.
- Leases require explicit clock-rate, pause, grantor, renewal, and regrant assumptions.
- Failover is detect → elect → fence → catch up → publish, with a failure window at each arrow.
- Membership change is itself agreement; include configuration in votes and tokens.
- Timeouts/randomization influence liveness and churn, not the fundamental safety proof.

### Interview questions

1. Prove that two majority candidates cannot both win the same term/configuration. Which durable assumption does the proof require?
2. Why can an old-term leader still be dangerous after a newer leader wins, and what exact resource rule fences it?
3. In the worked trace, why must the new leader catch up operations accepted before the higher fence rather than assume they never happened?
4. Compare term, lease, and fencing token: who issues each, who checks it, and which failure does it address?
5. A six-voter system has two groups of three. Why can neither win with majority rules, and what does adding/removing one voter change?
6. Why is a majority of an old configuration plus a majority of a new configuration not automatically safe? Give a disjoint-quorum example.
7. Decompose failover latency without proposing fixed heartbeat or election timeouts. Which components affect safety versus availability?
8. When does a ZooKeeper/etcd leader key fail to protect an external database, despite exactly one key holder?
9. Contrast Bully, ring, and quorum-backed elections under a network partition.
10. What evidence would distinguish harmless overlapping leader belief from an actual split-brain side-effect violation?

### Code-reading puzzle

This intentionally unsafe coordinator uses a TTL row:

```cpp
bool become_leader(Store& store, Clock& clock, Node me) {
    const auto expiry = clock.now() + 5s;
    if (!store.put_if_absent("leader", {me, expiry}))
        return false;
    start_accepting_writes();
    return true;
}
```

Find at least ten missing assumptions or bugs: duration recipe with no timing model; wall/monotonic clock unspecified; no term/configuration; no durable one-vote/quorum proof; expired rows may not be removed atomically; no fencing token at the write resource; readiness precedes fence/catch-up; pause after checking authority; no renewal/step-down protocol; uncertain store RPC outcome; snapshot restore can regress state; no client epoch/idempotency; no safe reconfiguration.

### Implementation exercise

Build a deterministic election simulator:

1. Model five voters with durable `(configuration, term, voted_for)` and volatile role.
2. Deliver, duplicate, delay, and drop vote requests/replies in arbitrary order.
3. Crash/restart voters while retaining or deliberately corrupting durable state.
4. Assert at most one winner per term/configuration and show the counterexample when votes are not persisted.
5. Add a resource with an atomic fencing high-water mark.
6. Pause an old leader, elect/fence a new one, then release delayed writes on both sides.
7. Add the old `{A,B,C}` to new `{C,D,E}` transition and demonstrate disjoint majorities before implementing joint authorization.
8. Record the detect/elect/fence/catch-up/publish timeline and calculate distributions across randomized schedules.

The simulator does not need log replication; use a freshness predicate stub. Full Raft/Paxos is Chapter 74.

### Common traps

- Claiming election guarantees exactly one process believes it is leader at every instant.
- Treating failure-detector suspicion or a missed heartbeat as proof of death.
- Counting volatile votes that disappear after restart.
- Applying majority intersection across different membership configurations.
- Electing by priority without data-freshness eligibility.
- Treating election completion as permission to serve before fencing and catch-up.
- Calling an unchecked epoch header a fencing mechanism.
- Allowing an unfenced maintenance, storage, or client path around the resource check.
- Assuming a higher token rejects an old operation before the resource has recorded that higher token.
- Treating monotonic clock as a bound on drift, pause, suspend, or network delay.
- Copying lease/heartbeat timeout ratios without the source protocol’s timing proof and measurements.
- Assuming a coordination-store lock makes asynchronous database failover lossless.
- Changing voters independently during a partition.
- Using Bully/ring as partition-safe because they eventually choose one ID after healing.
- Retrying an uncertain client write after failover without idempotency/reconciliation.

### Prerequisite for Chapter 71

Carry forward the authority tuple `(configuration, term, fencing token)` and the failover stages that make it usable. Chapter 71 assumes you can separate “a leader was elected” from “the leader has a sufficiently current replicated state” and “the leader’s writes satisfy the advertised consistency/durability guarantee.”
