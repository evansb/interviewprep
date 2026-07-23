# Chapter 68 — Distributed Systems: Introduction and Overview

Chapter 61 opened an optional specialization in storage and distributed state.
Chapters 62–67 asked how one recovery authority organizes durable local bytes.
This chapter crosses the boundary to **multiple independently executing
authorities**. They have no shared memory, learn about one another through
messages, and may observe different failures and different prefixes of history.

The chapter has one outcome: given a distributed protocol, state its assumptions
and separate what must never happen from what is promised eventually. That skill
is prerequisite to failure detection, election, replication, repair,
distributed transactions, and consensus.

This is a 30–40 minute Core chapter. The mathematical and historical sidebars
are marked Reference. Readers taking the short HFT-to-distributed bridge should
read the Core path here, Chapter 71 on replication and consistency, and Chapter
74 on consensus. Specialists continue sequentially through Chapters 69–74.

## 90-second screen — Core

1. A distributed system consists of nodes/processes with local state that
   communicate by messages. A message is an event, not shared memory.
2. Distribution can provide capacity, locality, administrative separation, and
   tolerance of specified faults. It also creates coordination, failure, and
   operations costs. “Scalable,” “available,” and “fault-tolerant” are different
   claims.
3. **Partial failure** means some components continue while others stop, pause,
   disconnect, lose messages, or recover. Silence does not identify which event
   occurred.
4. A timeout is local evidence that a deadline passed without an expected
   event. Whether that warrants retry, suspicion, failover, or rejection depends
   on the protocol and failure model.
5. Physical clocks are local and uncertain. Monotonic clocks measure local
   elapsed time; causal order comes from program order and message send/receive.
6. **Safety** says a bad state never occurs. **Liveness** says a desired event
   eventually occurs under stated conditions. Loss of timeliness should usually
   cost progress before it costs safety.
7. Failure models include crash-stop, crash-recovery, omission, timing, and
   arbitrary/Byzantine behavior. A protocol proved for one model does not
   inherit guarantees in a stronger one.
8. Synchrony models specify bounds on processing and communication. Real
   protocols commonly preserve safety without timing bounds but need a
   sufficiently timely period for progress.
9. FLP does not say “consensus is impossible.” It rules out guaranteed
   termination for deterministic consensus in a fully asynchronous model with
   even one possible crash, across all admissible executions.
10. Quorum intersection is useful arithmetic, not a complete protocol.
    Versions, membership, read/write rules, recovery, and fencing still matter.

The interview habit is:

```
assumptions → state machine → safety property → liveness conditions
            → failure trace → recovery/observability
```

---

## Distributed execution and assumptions

## 68.1 Nodes, Processes, Messages, and State — Core

A **node** is a failure/placement unit named by a design: perhaps a host, virtual
machine, container, or device. A **process** is an executing program with local
memory and durable state. Several processes may share a node and therefore a
power supply, kernel, network path, and fate. A protocol that counts processes
as independent replicas while placing them on one host has confused logical
participants with failure domains.

A useful abstract process is a state machine:

```
local state S
  + one input event
  ─────────────────► transition(S, event)
                     = new state S' + zero or more output events
```

Input events include client requests, message arrivals, local timer events,
storage completions, recovery records, and administrative changes. Outputs
include messages, durable writes, responses, metrics, and new timers. A
distributed **execution** is an interleaving of these local transitions plus the
network’s delivery choices.

This model deliberately omits a shared heap. If process A changes `balance`,
process B learns only through an explicit message, a shared external service, or
recovery from some mutually accessible durable medium. Even then B observes a
representation at a particular point in a protocol—not A’s current memory.

Name three kinds of state:

- **volatile local state:** lost on a process/node restart;
- **durable local state:** intended to survive faults included in the storage
  contract;
- **replicated state:** copies whose agreement, lag, and failure-domain
  placement are defined by a protocol.

“Durable” and “replicated” are orthogonal. Three memory-only copies can all lose
power; one synchronized local log can survive a process crash but not its
device. Chapter 61 established the local durability contract. Chapters 71 and 74
establish replicated acknowledgement and agreement.

### State is knowledge, not omniscience

At time \(t\), A’s local state records what A has observed so far. It cannot
directly include an undelivered event at B. Two nodes can therefore be correct
and disagree because their histories differ:

```
A: write x=7 ── send update ─────────────────────────►

B: read x=6 ─────────────────── receive x=7 ── read x=7
```

Whether B’s first read is legal depends on the promised consistency model, not
on the word “replica.” Chapter 71 owns those histories. Here, retain the
mechanical fact: information moves no faster than the messages carrying it.

## 68.2 Why Distribute, and What Exactly Is Promised? — Core

Distribution is justified by a requirement that one authority cannot or should
not meet:

| Goal | Mechanism often used | New cost/question |
|---|---|---|
| Data or throughput scale | Partition keys/work across nodes | Skew, routing, rebalancing, cross-partition operations |
| Fault tolerance | Replicate across failure domains | Agreement, lag, failover, repair, extra capacity |
| Geographic locality | Place service/state near users or venues | Long coordination paths, residency, divergent partitions |
| Administrative/security separation | Isolate tenants, teams, or trust domains | Authentication, policy/version drift, cross-domain failure |
| Elasticity/maintenance | Add, remove, upgrade nodes online | Membership transitions and mixed-version compatibility |

Do not treat the nouns as interchangeable:

- **Scalability** describes how useful capacity or performance changes as
  resources/load change. It requires a workload, metric, range, and bottleneck.
- **Availability** may mean an operational fraction of successful requests, a
  per-request response property in a formal model, or simply readiness. State
  which.
- **Fault tolerance** means preserving named properties despite a specified
  number/type/placement of faults. “Survives one replica loss” says more than
  “highly available.”
- **Reliability** often concerns correct continuous service over time, but its
  exact metric and failure boundary must be stated.

Availability can be measured operationally as:

```
successful eligible requests
────────────────────────────
total eligible requests
```

That ratio is meaningless until “successful,” “eligible,” observation window,
and excluded maintenance are defined. It also does not reveal whether returned
answers were fresh or correct. Correctness and responsiveness need separate
properties.

A design should say why it is distributed and which new failure cases are worth
the cost. A capture service might partition by instrument for throughput yet
keep each partition within one low-latency site. A reference-data service might
replicate across sites for read locality. A risk-limit service might accept
higher coordination latency to prevent concurrent grants from exceeding a
global limit. “Use microservices” is an organization choice, not evidence of a
distributed-data requirement.

### Concurrent execution without cache coherence

Local concurrency tools still matter inside each process, but they do not cross
the network boundary. A release store by A cannot publish memory to B; a mutex
held by A cannot prevent B from entering its own critical section. A distributed
lock is a protocol involving remote state, ownership generations, expiry or
release rules, and failure handling—not a slower `std::mutex`.

Concurrent messages also have no unique natural interleaving:

```
Client X ── update k=1 ──► A
Client Y ── update k=2 ─────────► B

           no causal edge between the two sends
```

If A and B both accept, a later mechanism must define their order, preserve both
as concurrent versions, merge them, reject one, or reconcile. Arrival order at A
can differ from arrival order at B. The scheduler in a test run is only one
possible execution.

The shared-state illusion is constructed at a cost:

- replication messages propagate versions;
- consistency rules constrain which versions clients may observe;
- transactions coordinate groups of operations;
- consensus can select a common ordered log;
- fencing prevents an authority from acting after ownership moved.

Each mechanism needs a state machine and failure model. None recreates
instantaneous cache coherence across nodes.

### The fallacies as an audit, not a recital

The traditional fallacies of distributed computing are useful when translated
into design questions:

| Unsafe assumption | Audit question |
|---|---|
| Network is reliable | What does loss/reset/partition do to operation outcome? |
| Latency is zero | How many sequential round trips and fan-out tails exist? |
| Bandwidth is infinite | What queues or degrades at sustained and burst rates? |
| Network is secure | How are peers authenticated and messages protected/replayed? |
| Topology does not change | How are address, route, placement, and membership changes handled? |
| There is one administrator | Which teams/providers control dependencies and policy? |
| Transport cost is zero | What are serialization, encryption, copy, CPU, and egress costs? |
| Network is homogeneous | Which MTU, protocol, hardware, region, and version differences matter? |

The list is not a failure model by itself. A link protected by authentication
can still omit messages; an ordered transport can still terminate ambiguously;
a redundant route can still share a hidden failure domain. Convert each relevant
assumption into a testable contract.

## 68.3 An Assumption Ledger — Core

Every theorem and protocol guarantee is conditional. Record assumptions before
choosing an algorithm:

| Dimension | Questions to answer |
|---|---|
| Participants | Fixed or changing membership? Which identities are authenticated? |
| State | Volatile or durable? Can a restart recover identity, term, vote, or dedup state? |
| Links | Can messages be lost, duplicated, delayed, reordered, corrupted, or forged? |
| Timing | Known bounds, eventual bounds, or none? Which clock drives local deadlines? |
| Faults | Crash-stop, crash-recovery, omission, timing, Byzantine? How many and where? |
| Network | Can it partition asymmetrically? Are routes/failure domains correlated? |
| Client | May it retry concurrently, forget state, move sessions, or reuse identifiers? |
| Guarantee | Safety, liveness, consistency, durability, availability, latency under what conditions? |

The ledger is part of the design, not paperwork after it. For example, a node
that “crashes and comes back” is not crash-stop. If it forgets a prior vote or
operation ID, a proof requiring stable memory may fail. A network can also be
asymmetric: A reaches B while B’s replies cannot reach A. A diagram that models
only symmetric partitions may omit a real execution.

Use labels to keep abstraction levels honest:

| Label | Meaning |
|---|---|
| **Model** | Defined environment: processes, events, links, timing, faults |
| **Property/theorem** | Mathematical claim under explicit model assumptions |
| **Protocol** | State machines and message rules intended to provide properties |
| **Implementation** | Concrete code, storage, timers, threading, and recovery choices |
| **Product/version/configuration** | Behavior of a named deployed release and settings |
| **Measured** | Result for named topology, load, failures, and observation method |

FLP is a theorem, not a product outage prediction. “At-least-once” is a delivery
contract, not proof that a business operation applies once. A vendor’s
“quorum” setting is not meaningful without its membership, version, and read/
write semantics.

---

## Partial failure, communication, and retry

## 68.4 Partial Failure and Indistinguishability — Core

In a local function call, caller and callee normally share a process fate. A
remote interaction has independent state transitions:

```
client A        network          service B        B's durable state
   | request ──────?────────────────► |                  |
   |                                  | apply ─────────► |
   |                                  | reply ───?       |
   | ... local deadline expires ...   |                  |
```

If A observes no reply by its deadline, several histories are compatible with
that observation:

1. the request was lost before B;
2. B received it but has not scheduled it;
3. B paused or crashed before applying it;
4. B applied it and crashed before replying;
5. B replied but the reply was lost or delayed;
6. B is healthy on the other side of a partition;
7. A itself was paused, so its local observation arrived late.

From A’s current local history, these executions may be
**indistinguishable**. Yet their correct business outcomes differ. A blind retry
might be necessary in cases 1–3 and duplicate an effect in cases 4–6. Giving up
avoids duplication but may report failure for committed work.

This is not a claim that a remote failure can never be learned. Later evidence
may arrive; another authority may provide a committed record; a failure detector
may become accurate under stronger timing assumptions. The precise claim is
local and temporal: silence alone at A’s deadline does not determine B’s state.

### Timeouts are policy inputs, not truth

A timeout establishes:

> By local monotonic elapsed time \(D\), this process did not observe the
> expected event.

It does not establish “B is dead,” “the request failed,” or “the network is
partitioned.” The application may still use the event to bound waiting:

- return an **unknown/pending** outcome and let the client query by operation ID;
- retry a safely idempotent operation;
- mark a peer **suspect** and gather more evidence;
- stop accepting work whose safe authority cannot be established;
- begin an election whose votes/terms, rather than the timeout itself, prevent
  split authority.

There is no universal correct timeout. The value depends on the intended
detection/latency objective, delay distribution, overload behavior, topology,
and cost of a false suspicion. Chapter 69 owns detector design and tuning.

## 68.5 Link and Delivery Contracts — Core

An application sees a link abstraction supplied by several layers: network,
transport, RPC/messaging library, and its own retry/dedup protocol. Define its
contract rather than saying “the network is unreliable.”

Potential effects include:

- **loss:** a sent message is never delivered;
- **delay:** delivery occurs after an arbitrary or bounded interval;
- **duplication:** the receiver observes the same logical message more than
  once;
- **reordering:** messages arrive in a different order from sends;
- **corruption/forgery:** bits or identities are wrong unless detected or
  authenticated;
- **connection reset:** an ordered byte stream ends without resolving the
  application operation.

TCP provides an ordered, duplicate-suppressed byte stream while one connection
is usable. It does not tell an application whether a framed request whose
connection failed was durably applied. Reconnecting creates another stream; the
application must recover its operation semantics.

Common delivery labels are:

| Contract | Receiver-side observation | Cost/risk |
|---|---|---|
| At-most-once delivery/invocation | Receiver observes zero or one scoped invocation | May omit an operation after loss/ambiguity |
| At-least-once delivery/invocation | Receiver observes one or more if retry conditions eventually succeed | Receiver may see duplicates |
| Deduplicated/effectively-once operation | Stable identity plus atomic apply/dedup state within a defined scope | Retention, recovery, race, and transaction-boundary complexity |

An unqualified “exactly once” claim is too broad. It may legitimately describe a
product’s scoped processing guarantee, but ask:

- exactly one delivery, handler invocation, committed state transition, or
  externally visible effect?
- between which endpoints and within which failure/recovery boundary?
- where is the operation identity durably retained, and for how long?
- are state update and dedup record atomic?
- what happens when the operation calls an external system outside that atomic
  boundary?

### Idempotence and deduplication

An operation \(f\) is idempotent if:

\[
f(f(S)) = f(S)
\]

for relevant state \(S\). “Set status to cancelled” may be idempotent; “add 10
to balance” is not. A request ID can make a non-idempotent business operation
safe to retry if the receiver atomically stores:

```
(client_id, operation_id) → completed result
```

with the state transition, then returns the stored result for duplicates.
Atomicity matters. Recording the ID before applying may lose work after a crash;
recording it after applying may repeat work. Retention matters too: reuse or
expiry of an ID can make an old duplicate appear new.

## 68.6 Worked Failure: Reserve a Risk Limit Once — Core

Suppose a trading gateway asks a risk service to reserve USD 2 million under a
limit. The unsafe implementation sends:

```
reserve(account=42, amount=2_000_000)
```

and retries on timeout. If the first request committed but its response was
lost, the retry can reserve twice.

Use a stable operation:

```
Reserve {
    account: 42,
    amount: 2_000_000,
    operation_id: (gateway_7, session_epoch_91, sequence_1842)
}
```

The risk service’s conceptual transition is:

```
if operation_id exists:
    return stored_result
else if remaining_limit >= amount:
    atomically:
        remaining_limit -= amount
        store operation_id → GRANTED(new_remaining_limit)
    return stored_result
else:
    atomically store operation_id → REJECTED(current_remaining_limit)
    return stored_result
```

The result—including rejection—is retained so the same operation cannot change
outcome after another trade changes the balance. This design resolves duplicate
delivery at the service’s durable transaction boundary.

It does **not** solve every failure:

- If two replicas accept independently without an agreement/partition rule,
  each may grant against stale remaining capacity.
- If a gateway reuses its `(epoch, sequence)`, dedup can suppress a new request.
- If dedup records expire before delayed duplicates, the effect can recur.
- If grant triggers a non-transactional external side effect, that effect needs
  its own identity/reconciliation protocol.
- If the client times out, its immediate result remains **unknown** until it
  reads the stored outcome or another authoritative protocol resolves it.

The key distinction is between **operation outcome** and **client knowledge**.
The server may have exactly one durable outcome while the client temporarily
does not know which. A truthful API exposes `PENDING/UNKNOWN` rather than
inventing certainty from a timeout.

---

## Time, order, and properties

## 68.7 Physical Time, Monotonic Time, and Causal Order — Core

Each node has local clocks. A wall/real-time clock estimates civil time and can
be disciplined or corrected. A monotonic clock is intended for measuring local
elapsed intervals and deadlines. Neither automatically provides a globally
agreed event order.

Separate three questions:

1. **Local duration:** did this process’s deadline pass? Use an appropriate
   monotonic clock and account for suspension/clock semantics.
2. **Civil timestamp:** when should humans/auditors interpret an event? Record
   wall time with source/uncertainty where material.
3. **Causal order:** could event \(a\) have influenced event \(b\)? Derive this
   from execution, not raw cross-node timestamps.

Define Lamport’s happened-before relation \(\rightarrow\):

- if \(a\) and \(b\) occur in one process and \(a\) precedes \(b\), then
  \(a \rightarrow b\);
- if \(a\) sends a message received by \(b\), then \(a \rightarrow b\);
- it is transitive: \(a \rightarrow b\) and \(b \rightarrow c\) imply
  \(a \rightarrow c\).

If neither \(a \rightarrow b\) nor \(b \rightarrow a\), the events are
**concurrent** in this model. That does not require simultaneous wall time; it
means the observed execution contains no causal path between them.

```
Process A:  a1 ── a2(send m) ───────── a3
                    \
                     \ m
                      ▼
Process B:  b1 ───────────── b2(receive) ── b3

a2 → b2 → b3
a1 → b3 by transitivity
b1 and a2 may be concurrent
```

Clock readings could show B’s `b2` timestamp numerically earlier than A’s `a2`
timestamp if their physical clocks differ. That does not overturn the causal
edge. Conversely, `timestamp(a) < timestamp(b)` does not by itself prove
\(a \rightarrow b\).

Logical clocks assign metadata consistent with causal order. A Lamport-clock
rule can ensure:

\[
a \rightarrow b \implies L(a) < L(b)
\]

but the converse is not guaranteed; numeric order can compare events that were
concurrent. Vector clocks can expose more causal/concurrent structure at greater
metadata cost. Chapter 71 owns logical-clock and consistency applications.

### Ordering contracts are distinct

“Ordered messages” needs a scope:

| Contract | What is constrained | What remains unordered |
|---|---|---|
| Per-sender FIFO | One receiver observes one sender’s messages in send order | Other senders; reconnections unless protocol preserves sequence |
| Causal order | Delivery respects known happened-before edges | Concurrent events may appear in different orders |
| Total order | Participants observe one protocol-defined order | The order need not reveal causality unless specified |

A single TCP byte stream preserves byte order within that connection; it does
not merge multiple connections into one order, and reconnect/retry requires
application sequence rules. Causal delivery requires causal metadata or a
mechanism with equivalent knowledge. Total-order broadcast/atomic broadcast
requires participants to agree on an order and is closely related to consensus.

Do not ask for the strongest label by default. A per-instrument market-data
stream may need sequence order within an instrument but no global order between
unrelated instruments. A risk ledger may need a single order for grants against
one limit. Scoping order by key/partition can reduce coordination, while
cross-scope invariants reintroduce it.

Physical time can support correctness only through an explicit model of
uncertainty/bounds and a protocol that uses it safely. Time synchronization
reduces uncertainty; it does not make independent clock readings a proof of
causality. Product-specific time guarantees must name service, version,
topology, hardware, and configuration.

## 68.8 Safety, Liveness, and Progress Conditions — Core

A distributed protocol should state properties over executions.

A **safety property** says a forbidden event/state never occurs. A finite bad
prefix demonstrates violation:

- two different values are decided for one consensus instance;
- the same operation ID reduces a limit twice;
- two authorities hold valid fencing generations for the same resource;
- an acknowledged durable write disappears under a fault the contract claims
  to tolerate.

A **liveness property** says a desired event eventually occurs:

- every accepted request eventually receives a terminal outcome;
- an available message is eventually processed;
- after failures stop and communication becomes timely, a leader is eventually
  elected;
- a submitted proposal eventually decides.

Liveness always needs conditions. “Eventually replies” cannot hold if every
participant remains crashed, messages are delayed forever, or new work
permanently exceeds capacity. State fairness, fault count, network/timing,
membership stability, and load assumptions.

| Property | Example | Violation evidence |
|---|---|---|
| Safety | At most one grant per operation ID | Two committed grants are a finite counterexample |
| Liveness | A valid request eventually completes while quorum and timely links persist | Requires an infinite/nonprogress execution under the stated conditions |
| Bounded latency | 99.9% complete within a stated deadline under named load/faults | Measured distribution exceeds bound/SLO |
| Operational availability | Eligible requests succeed over a window | Measured success ratio, scoped to definition |

Safety and liveness can conflict operationally. During uncertainty, refusing
writes may preserve a single-writer invariant while reducing availability.
Allowing every isolated side to write may preserve local responsiveness while
violating a strong consistency property. A mature protocol states which
property remains unconditional and which depends on a stable/timely period.

### Availability is not one universal property

In everyday engineering, availability often measures useful successful service.
In theoretical results, it can have a specific quantification, such as every
request received by a non-failing node eventually obtaining a response.
Returning a stale value, an explicit error, or an `UNKNOWN` result may count
differently across definitions.

Therefore do not jump from a theorem’s “availability” to a product SLO. Translate:

```
model property
  → client-visible behavior
  → eligible operations and failure scope
  → measurement and alert
```

## 68.9 A Small Latency and Fan-out Model — Core

Remote work is not a local call with a larger constant. It adds serialization,
queues, transport, independent scheduling, retries, and ambiguous completion.
Avoid universal latency ratios; calculate the actual critical path.

For sequential stages:

\[
T_{\text{request}} \approx
\sum_i (T_{\text{queue},i} + T_{\text{service},i} + T_{\text{transport},i})
\; T_{\text{coordination}} + T_{\text{retry}}
\]

Parallel fan-out reduces sum-of-latencies but couples success to many branches.
For a deliberately simplified illustration, if each of \(k\) independent
branches succeeds within deadline with probability \(p\), then:

\[
P(\text{all succeed}) = p^k
\]

With \(p=0.999\) and \(k=20\):

\[
0.999^{20} \approx 0.9802
\]

Thus individually “three-nines” branches yield only about 98.02% all-branch
deadline success in this independence model. Real failures are often correlated
by shared network, host, dependency, or load, so this is not a production
prediction. It is a warning to define whether all branches are required and to
measure end-to-end tails.

### How a partial slowdown becomes a cascade

Partial failure is sometimes a slow component rather than a stopped one. A
simple positive-feedback loop is:

```
dependency slows
  → callers retain work longer
  → queues and concurrent requests grow
  → callers time out and retry
  → dependency receives more work
  → service time and failure rate grow again
```

Rerouting can spread the same overload to previously healthy replicas. Large
queues hide admission failure until requests are too old to matter, consuming
capacity after callers abandoned them. Correlated client retries can synchronize
into a new burst.

The correctness connection is subtle: an overloaded node may be falsely
suspected, an acknowledgement may arrive after a retry, and failover may overlap
the old authority. Backpressure and circuit breakers manage load, but terms,
quorums, and fencing must still manage authority.

Bounded queues, admission control, retry budgets, exponential backoff with
jitter, circuit breaking, and deadline propagation are owned by Chapters 52 and
56. Their role here is to keep a local slowdown from multiplying the number of
ambiguous in-flight operations. No fixed retry count or timeout is universally
safe; budget attempts from the end-to-end objective and make overload behavior
explicit.

Bounded concurrency, batching, admission control, load shedding, deadline
propagation, and retry budgets belong to Chapters 52 and 56. Here the model
serves one point: distribution changes the number and dependence of possible
failure events, not merely average execution time.

---

## Failure and synchrony models

## 68.10 Failure Models — Core

A **failure model** defines behavior the protocol must tolerate. Models are not
diagnoses; a real incident may cross several.

| Model | Allowed faulty behavior | State question |
|---|---|---|
| Crash-stop | Process halts and does not resume in that execution | Can others progress without it? |
| Crash-recovery | Process halts and later restarts | Which identity/protocol state survives durably? |
| Omission | Expected sends, receives, or deliveries may be absent | Can retry/dedup/reconciliation preserve properties? |
| Timing | Responses occur outside required timing bounds | Does lateness affect safety or only liveness? |
| Arbitrary/Byzantine | Process may send inconsistent or adversarial messages | What authentication, quorum, and protocol assumptions constrain it? |

**Fail-stop** is sometimes used for a crash that other participants can reliably
detect. That is stronger than crash-stop in an asynchronous network; avoid using
the terms interchangeably without a definition.

Storage corruption, software bugs, operator mistakes, credential compromise,
and correlated power/network loss do not disappear because a consensus proof
assumes crash faults. Systems frequently combine a crash-fault protocol with
checksums, validation, authentication, fault-domain placement, backups, and
independent recovery controls. Those mitigations do not automatically make the
protocol Byzantine-fault tolerant.

Fault counts are also conditional. “Tolerates \(f\) faults” must state:

- participant count and current membership;
- simultaneous or lifetime faults;
- placement/failure-domain independence;
- whether failed participants recover with valid durable state;
- which property survives—safety, liveness, reads, writes, or durability.

## 68.11 Synchrony Models — Core

Synchrony describes timing assumptions, not whether code uses blocking APIs.

| Model | Processing/message-delay assumption | What it permits |
|---|---|---|
| Synchronous | Known finite bounds hold in the modeled execution | Time can distinguish lateness beyond the bound |
| Asynchronous | No known upper bounds; a correct process/message may be delayed arbitrarily long | Algorithms cannot use elapsed time as proof of failure |
| Partially synchronous | Bounds exist but are unknown, or hold only after an unknown stabilization time | Safety can be timing-independent; progress can wait for a timely period |

An implementation can set an illustrative 500 ms timeout in an asynchronous
model; the timer will fire, but its expiry proves only the local deadline
observation. Conversely, a synchronous model is not “fast”: its bound could be
large. The distinction is epistemic—what the algorithm may assume and infer.

Many practical coordination protocols are designed so that arbitrary delay,
reordering, or partitions cannot create two committed outcomes, while eventual
timeliness and enough non-faulty participants allow progress. Exact guarantees
depend on the protocol. Do not turn “partial synchrony is practical” into a
claim that all production networks eventually satisfy every configured timeout.

### Failure detectors: only the boundary here

A failure detector produces suspicion from observations such as missing
heartbeats or failed probes. Its useful properties are commonly described in
terms of:

- **completeness:** which crashed processes are eventually suspected;
- **accuracy:** which correct processes avoid false suspicion, and when.

In weak timing conditions, these cannot both be perfect at every moment.
Protocols therefore make safety depend on votes, generations, quorums, or
fencing—not merely on one detector’s suspicion. Chapter 69 owns timeouts,
heartbeats, accrual detectors, indirect probes, and their operational tuning.

## 68.12 Partitions and the CAP Boundary — Core

A **network partition** is an execution in which some messages between groups
are not delivered for a relevant interval while processes on more than one side
may remain active. Partitions can be asymmetric or selective; “the network split
cleanly in half” is only one diagram.

Consider two replicas A and B that both previously stored `x=0`:

```
Client 1 → A: write x=1     A  - - - partition - - -  B
                                           Client 2 → B: read x
```

If B must answer without communication, it lacks the information needed to
distinguish:

- execution E0: no write occurred at A;
- execution E1: A accepted `x=1`, but the partition hides it.

If the contract requires B’s read to reflect a completed write with real-time
semantics, the same immediate value cannot be correct in both executions. B can
wait/reject/return `UNKNOWN`, or answer under a weaker consistency/staleness
contract. This is an indistinguishability argument, not a slogan about product
categories.

The CAP theorem is treated properly in Chapter 71. For this overview, remember
its narrow shape:

- “C” is a specified consistency property, conventionally linearizability in
  the theorem’s common formulation—not generic ACID consistency;
- “A” is a formal response/availability condition, not a measured uptime
  percentage;
- partitions are allowed by the model;
- during such executions, a system cannot guarantee both of those properties
  for all requests.

“Choose two of consistency, availability, and partition tolerance” is
misleading. A deployed network cannot generally purchase away every partition,
and systems make per-operation choices with nuanced failure responses. Outside
partitions, latency, replica placement, and coordination still matter. Chapter
71 supplies the histories and consistency vocabulary.

---

## Impossibility and quorum foundations

## 68.13 Two Generals: Knowledge Has a Last Message — Reference

The Two Generals problem models two parties that must coordinate an action over
a channel that may lose messages. Suppose A sends “attack at dawn,” B
acknowledges, A acknowledges the acknowledgement, and so on.

Any finite protocol has a final message. If that final message may be lost, its
sender cannot know that the receiver obtained it. Removing the final message
therefore leaves a protocol with the same uncertainty one step earlier.
Repeating the argument shows that finite acknowledgements cannot create common
knowledge with certainty over the assumed lossy channel.

The result does not say useful coordination never occurs. Engineering changes
the requirement or assumptions:

- accept probabilistic confidence rather than certainty;
- use a durable third party or an agreed log;
- make unilateral action safe or reversible;
- choose a default on uncertainty;
- continue retry/reconcile later;
- require a quorum under a different link/failure model.

The lesson is to ask what each participant knows after the last possible lost
message and whether residual disagreement is safe.

## 68.14 Consensus and FLP, Precisely — Core

Binary consensus asks non-faulty processes to decide a value while satisfying
properties such as:

- **agreement:** no two correct participants decide different values;
- **validity:** the decided value obeys the proposal-validity rule;
- **termination:** every correct participant eventually decides.

Definitions vary in details, so name the chosen formulation.

The Fischer–Lynch–Paterson result applies to a specific model: deterministic
consensus in a fully asynchronous message-passing system, with reliable
communication as modeled and even one process allowed to crash. Across all
admissible executions, no algorithm can guarantee termination while retaining
the required agreement and validity.

What FLP does **not** establish:

- that agreement or physical time is universally impossible;
- that every execution fails to decide;
- that consensus cannot work well in deployed systems;
- that safety must be weakened;
- that adding more replicas alone restores guaranteed termination.

### Worked intuition: delay can preserve ambiguity

Imagine participants proposing 0 or 1. Before a decision, the global
configuration may be **bivalent**: some future admissible schedules decide 0,
others decide 1. A decisive next message/event would move it to a **univalent**
configuration.

In a fully asynchronous model, the scheduler can delay a relevant process or
message without revealing whether that process crashed. The FLP proof shows
there is an execution in which events can be chosen so the system remains
bivalent indefinitely. No participant sees a definitive fault; it simply never
gets the event that forces progress.

This is an existence result over schedules. A normal run with prompt messages
may decide quickly. But a protocol cannot promise termination for *every*
admissible asynchronous run with a possible crash.

Practical protocols alter the conditions:

- assume partial synchrony/eventual timely communication for liveness;
- use failure-detector abstractions with stated properties;
- use randomized choices and probabilistic termination;
- preserve agreement independent of timing while allowing elections/rounds to
  repeat until conditions improve.

Chapter 74 develops consensus and states its actual fault, quorum, persistence,
and timing assumptions.

## 68.15 Quorum Intersection: Arithmetic, Not a Protocol — Core

For a fixed membership of \(N\) participants, two quorums of size \(q\) must
intersect when:

\[
2q > N
\]

A majority chooses:

\[
q = \left\lfloor \frac{N}{2} \right\rfloor + 1
\]

For \(N=5\), \(q=3\). Any two three-member sets intersect because
\(3+3>5\). If participants are crash-stopped and communication among the others
is timely, a three-member quorum can still form with two unavailable
participants.

But “quorums overlap” is only a set fact. Safety also needs protocol rules about:

- which values/terms/versions an intersecting member reports or accepts;
- whether state survives crash-recovery;
- whether two configurations are active during membership change;
- how incomplete writes and reads are repaired;
- whether faulty participants can equivocate;
- how a stale authority is fenced;
- which acknowledgement constitutes commit.

Classic replicated-register arithmetic may use read size \(R\) and write size
\(W\):

\[
R + W > N
\]

so each read set intersects the last write set, plus often:

\[
2W > N
\]

so write sets intersect. These inequalities do not alone provide
linearizability. The protocol still needs version ordering, correct handling of
concurrent/incomplete writes, membership, and repair. Chapters 70, 71, and 74
show how election, replicated storage, and consensus use quorum intersection
differently.

Thresholds such as “\(2f+1\)” for crash-fault majorities or “\(3f+1\)” in
certain Byzantine consensus models are conditional on their protocol and model.
Do not transfer them to arbitrary systems by mnemonic.

## 68.16 The Protocol Review Frame — Core

For any algorithm, write one table:

| Review item | Example question |
|---|---|
| State | What persists across restart: term, vote, log, request IDs? |
| Messages | Can each be lost, delayed, duplicated, reordered, or replayed? |
| Authority | What evidence permits a write, and how is stale authority fenced? |
| Safety | Give a finite trace that would violate the invariant |
| Liveness | Under what faults/timeliness/load must progress resume? |
| Ambiguity | After timeout, which outcomes remain indistinguishable? |
| Membership | Who counts, and how does a configuration change safely? |
| Recovery | How does a returning node reject stale state and catch up? |
| Operations | What metric reveals loss of progress before queues/cascades grow? |
| Version scope | Which implementation/product release/configuration was verified? |

Then test transitions, not only steady state:

```
normal
  → delayed/duplicated message
  → one process pauses or crashes
  → partition
  → recovery with old durable state
  → membership/configuration change
  → mixed-version deployment
```

A proof may abstract storage as stable; implementation must still make the
required term/vote/log durable under Chapter 61’s crash contract. A proof may
assume authenticated identities; deployment must maintain keys and reject stale
credentials. Correctness lives at the seam between model and mechanism.

---

## Ownership map and practice

## 68.17 What Later Chapters Own — Reference

This chapter intentionally stops at foundations:

| Chapter | Owner |
|---|---|
| 69 — Failure Detection | Timeout/heartbeat evidence, completeness/accuracy, accrual and indirect detection |
| 70 — Leader Election | Candidates, terms/epochs, votes, leases, quorums, split authority, fencing |
| 71 — Replication and Consistency | Topologies, sync/async acknowledgement, CAP histories, consistency models, logical clocks, read/write quorums, CRDT overview |
| 72 — Anti-Entropy and Dissemination | Digests, Merkle comparison, read repair, hinted handoff, gossip convergence |
| 73 — Distributed Transactions | Atomic commit, 2PC/3PC boundaries, sagas, isolation across partitions |
| 74 — Consensus | Paxos/Raft-family reasoning, replicated logs, commit, snapshots, membership |

Short reminders here are vocabulary, not substitutes for those chapters. There
is no promised standalone partitioning chapter: partition placement/routing
appears where it affects replication, repair, transactions, and consensus.

## Common Traps — Core

- Treating a timeout as proof of death or proof that an operation failed.
- Saying “the network is unreliable” without naming loss, delay, duplication,
  reordering, corruption, authentication, and link scope.
- Assuming TCP resolves whether an application request committed.
- Retrying a non-idempotent effect without a stable identity and atomic dedup
  record.
- Returning `FAILED` when the truthful result is temporarily `UNKNOWN`.
- Ordering causal events by raw wall-clock timestamps from independent nodes.
- Calling every numeric timestamp a logical clock, or assuming Lamport-clock
  order proves causality in both directions.
- Giving a liveness claim without fairness, fault, timing, membership, and load
  conditions.
- Using “available” without distinguishing formal responsiveness from useful
  successful service.
- Explaining CAP as “pick any two,” or using “consistency” without a history
  definition.
- Explaining FLP as “consensus is impossible.”
- Assuming quorum intersection alone establishes latest-value reads, exclusive
  leadership, or safe reconfiguration.
- Citing a product guarantee without release, configuration, topology, failure
  domain, and acknowledgement point.
- Modeling replicas as independent when they share a host, rack, power path,
  account, operator, or software defect.

## Recall Card — Core

- Nodes/processes own local state; messages create cross-node knowledge.
- Distribution serves named scale, locality, isolation, or fault goals and
  introduces coordination and operations costs.
- Write an assumption ledger: membership, durable state, links, timing, faults,
  client behavior, guarantee.
- Partial failure creates indistinguishable histories. Silence is evidence of no
  observed reply by a deadline, not the remote outcome.
- Scope delivery claims. Retriable effects need idempotence or stable IDs with
  atomic, durable deduplication.
- Wall time is local/uncertain; monotonic time measures local intervals; causal
  order follows program and message edges.
- Safety forbids bad outcomes. Liveness promises eventual progress under named
  conditions. Preserve safety when timeliness disappears.
- Failure model: crash-stop/recovery, omission, timing, or Byzantine.
- Synchrony model: known bounds, no bounds, or eventual/unknown bounds.
- CAP is a precise partition execution result, not “pick two.”
- FLP removes guaranteed termination in its asynchronous deterministic model;
  it does not ban practical consensus.
- \(2q>N\) guarantees set intersection only. Protocol state/version/membership
  rules turn intersection into a useful guarantee.

## Questions — Core

1. Model a three-node service as local state machines and message events. Which
   state must survive restart for request deduplication?
2. A client times out after sending a write. List four indistinguishable remote
   histories and give a truthful client-visible outcome.
3. Distinguish scalability, operational availability, formal availability, and
   fault tolerance with one concrete metric/property for each.
4. Given events on two processes and two messages, derive happened-before and
   identify concurrent events. Why can wall-clock order disagree?
5. State one safety and one conditional liveness property for a replicated risk
   limit. What finite trace disproves the safety property?
6. State FLP precisely enough to identify the algorithm type, timing model,
   possible fault, and property it prevents from being guaranteed.
7. For \(N=7\), calculate the majority quorum and maximum unavailable members
   while a quorum can still form. Why is the arithmetic insufficient for safe
   reads after reconfiguration?
8. Explain CAP using two executions indistinguishable to an isolated replica,
   without saying “pick two.”
9. Review an “exactly-once” product claim. Which boundary, identity, atomicity,
   retention, recovery, and external-side-effect questions must be answered?
10. What belongs in Chapters 69, 70, 71, and 74 rather than this foundations
    chapter?

## Protocol-Reading Puzzle — Core

The following pseudocode tries to provide a single active writer:

```text
on heartbeat_timeout(peer):
    if peer == current_leader:
        role = LEADER
        accept_writes = true

on client_write(command):
    if accept_writes:
        local_log.append(command)
        reply(COMMITTED)
```

Construct an execution in which the old leader is paused or partitioned, the
follower times out, and both acknowledge writes. Identify:

1. the observation that was mistaken for authority;
2. the violated safety property;
3. why lengthening the timeout cannot prove the property;
4. which evidence categories a real design needs—terms/votes, quorum commit,
   durable state, fencing, and recovery—without implementing Chapter 70 or 74
   here.

## Implementation Exercise — Core

Design a small simulator for the risk-limit operation in §68.6. It may be
single-threaded and deterministic; the goal is execution reasoning, not network
code.

Represent:

- two service replicas with volatile and durable state;
- a client with stable operation IDs;
- messages in an explicit queue;
- events for deliver, drop, duplicate, delay, process crash, and restart;
- an optional partition predicate.

First implement the unsafe retry. Generate a trace that applies one logical
reservation twice. Then implement atomic deduplication at one authority and show
that arbitrary duplicate delivery does not double-apply there. Finally split
the two replicas and demonstrate why local dedup does not prevent each replica
from independently granting.

Submit:

1. the model/failure assumptions;
2. the state transition table;
3. safety invariant and liveness conditions;
4. three minimized counterexample traces;
5. a statement of what later election/replication/consensus mechanism is still
   missing;
6. tests that replay each trace deterministically.

Mark simulator conveniences that are stronger than reality—for example, a
central event scheduler that knows which node crashed.

## Prerequisite for Chapter 69 — Core

Chapter 69 assumes you can distinguish remote truth from local suspicion,
explain why silence is compatible with crash, pause, loss, and partition, and
state the accuracy/completeness trade-off without treating any timeout as
universally correct. Carry forward the assumption ledger: detector guarantees
are meaningful only relative to a timing and failure model.
