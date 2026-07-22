# Chapter 69 — Failure Detection

*Interview-focused revision notes. The theme: in a distributed system you can never observe that a node has crashed — you can only observe that you have not heard from it, and those are not the same thing. Every failure detector is therefore a machine for turning silence into a bounded, tunable guess. The whole design space is the choice of what to measure, how long to wait, and how confidently to accuse. PostgreSQL's own HA tooling (Patroni) leans on exactly this machinery — a TTL lease in etcd/Consul — so the abstract theory has a very concrete Postgres payoff.*

---

## 69.1 The Problem: Crash, Slow, or Partitioned?

A distributed algorithm — replication, leader election, sharding, distributed locking — must eventually decide that some participant is gone and route around it. But there is no primitive that reports "node B has crashed." The only primitive available is a **message that did or did not arrive by some local deadline**. From node A's vantage point, three completely different physical situations produce the *identical* observation "I sent B a request and heard nothing back":

1. **B has crashed** (halted, power-cut, kernel panic, process killed).
2. **B is slow** (overloaded, mid-GC pause, swapping, CPU-starved) but perfectly alive and will answer in 12 seconds.
3. **B is partitioned** — B is fine and doing useful work, but the network between A and B is dropping packets. B may even be reachable by *other* nodes.

This is the central result recapped from the synchrony and failure models of the previous chapter (Ch. 68 §68.2–68.4): in an **asynchronous system** — no bound on message delay, no bound on relative processing speed, no synchronized clocks — a *crashed* node and an *arbitrarily slow* node are **indistinguishable**. There is no timeout large enough to be certain, because "slow" has no upper bound by definition. If you wait 10 s and give up, the node might have answered at 10.001 s. If you wait an hour, you have built a system that tolerates failures with an hour of latency.

The consequence, which every remaining section elaborates: **failure detection is not a measurement, it is a decision under uncertainty.** You are choosing a point on a curve where waiting longer buys accuracy and waiting less buys speed, and no amount of engineering removes the curve — it only lets you pick your point on it more intelligently.

```
A sends to B          heard nothing by deadline
     │                          │
     ▼                          ▼
 ┌────────┐   silence    ┌──────────────┐
 │ node A │◀─────────────│  ????        │  A cannot tell which:
 └────────┘              │  crashed?    │    - B halted
                         │  slow?       │    - B in a 12s GC pause
                         │  partitioned?│    - link A↔B dropping packets
                         └──────────────┘
```

---

## 69.2 A Failure Detector Is Suspicion, Not Fact

Because the three cases collapse into one observation, the output of a failure detector is intrinsically a **suspicion**, not a ground-truth fact. Petrov's framing (and the classical literature's) is precise about this: a failure detector is a **local, unreliable oracle** that each node runs, producing at any moment a set of processes it *currently suspects* have failed. It can be — and routinely is — **wrong in both directions**:

- **False positive** (a *mistake*): suspecting a node that is actually alive. The node was just slow or briefly unreachable. The cost is real: the cluster may fence a healthy primary, trigger an unnecessary failover, reshuffle data, or drop a node that was about to answer.
- **False negative** (a *missed/late detection*): failing to suspect a node that is actually dead, or taking a long time to. The cost is that requests keep being routed to a black hole, locks stay held by a corpse, and progress stalls.

The word **"unreliable"** is a term of art here, not a criticism — it means the detector may make mistakes but is still useful, because the algorithms built on top (consensus, leader election in Ch. 70) are designed to *tolerate* a bounded rate of detector mistakes. A detector that occasionally cries wolf does not corrupt a correctly-designed consensus protocol; it only costs it liveness (extra elections, retries), never safety. That separation — the detector may be wrong, but the safety of the system does not depend on it being right — is the reason the whole approach works, and it recurs as a theme through leader election and consensus.

Interview framing: **"A failure detector never tells you a node is dead. It tells you it has given up waiting."** Everything else is how well-calibrated that giving-up is.

---

## 69.3 Formal Properties: Completeness and Accuracy

Chandra and Toueg (1996) gave the field its vocabulary by defining a failure detector abstractly through two families of properties. Every practical detector is an attempt to approximate these; naming them separates a deep answer from a shallow one.

**Completeness** — *does every real failure eventually get suspected?* (A liveness property: something good eventually happens.)

- **Strong completeness:** every process that crashes is *eventually permanently suspected by every* correct process.
- **Weak completeness:** every process that crashes is eventually permanently suspected by *some* correct process.

**Accuracy** — *do we avoid suspecting live nodes?* (A safety property: nothing bad happens.)

- **Strong accuracy:** *no* correct process is *ever* suspected (by anyone, at any time).
- **Weak accuracy:** *some* correct process is *never* suspected by anyone.
- **Eventual strong accuracy (◇):** after some unknown finite time, no correct process is suspected — mistakes may happen early but eventually stop.
- **Eventual weak accuracy (◇):** after some finite time, some correct process is never suspected.

The two axes are (almost) independent, which is the key insight. **Completeness is trivial in isolation** — a detector that suspects *everyone, all the time* is perfectly complete (it never misses a real failure) and utterly useless (it is maximally inaccurate). Symmetrically, a detector that suspects *no one, ever* is perfectly accurate and never complete. The engineering is entirely in getting *both* at once, and the asynchrony result of §69.4 says you cannot get both perfectly.

```
                 Accuracy (safety: no false suspicion)
                 weak ───────────────────────▶ strong
Completeness  ┌───────────────┬───────────────┐
(liveness:    │      W        │       S       │  perpetual
detect real   │  (weak-strong)│  (perfect-ish)│  accuracy
failures)     ├───────────────┼───────────────┤
strong ─────▶ │      ◇W       │      ◇P        │  eventual
              │               │ (Chandra-Toueg│  accuracy
              │               │  Eventually   │
              │               │  Perfect)     │
              └───────────────┴───────────────┘
```

Chandra–Toueg's headline detector classes name the corners: **P (Perfect)** = strong completeness + strong accuracy; **◇P (Eventually Perfect)** = strong completeness + eventual strong accuracy; **S / ◇S (Strong / Eventually Strong)** use weak accuracy; **W / ◇W (Weak / Eventually Weak)** use weak completeness + weak accuracy.

Two facts worth memorizing:

- **Weak completeness can be boosted to strong completeness** by a simple gossip transformation: if any correct node suspects B, it tells everyone, so eventually all correct nodes suspect B. This is why the literature often works with the weaker class and why gossip (§69.15, Ch. 72) is so natural a substrate for failure detection.
- **◇W is the *weakest* failure detector that can solve consensus** (Chandra, Hadzilacos, Toueg 1996). This is a celebrated result: it identifies the *minimum* synchrony you must smuggle into an asynchronous system to make agreement possible. Everything stronger (◇S, ◇P) also solves consensus; anything weaker cannot. Consensus in Ch. 70 is built precisely on a ◇S/◇P-class detector.

---

## 69.4 Why a Perfect Detector Is Impossible in an Asynchronous System

A **Perfect** detector (class P: never misses a failure, never makes a mistake) is **impossible to implement in a purely asynchronous system**, and this is not an engineering limitation — it is a mathematical one, a corollary of the same asynchrony that makes §69.1's three cases indistinguishable.

The argument is a one-liner once §69.1 is granted: strong accuracy requires that you *never* suspect a live-but-slow node, which requires knowing an upper bound on message delay; but "asynchronous" *means* there is no such bound. Any deadline you pick can be exceeded by a live node, producing a mistake and violating strong accuracy; refusing to ever give up violates completeness. So P is unachievable. This connects to the deeper **FLP impossibility** (Fischer, Lynch, Paterson 1985): in an asynchronous system, deterministic consensus is impossible if even *one* process may crash, precisely because you cannot distinguish a crashed process from a slow one.

The practical escape hatch — and the reason distributed systems work in the real world despite FLP — is that **real systems are not purely asynchronous; they are *partially synchronous*** (Dwork–Lynch–Stockmeyer, recap Ch. 68 §68.3). Most of the time the network delivers messages within some bound; occasionally it does not. In this model you *can* build an **Eventually Perfect (◇P)** detector: one that may make mistakes during bad periods (a partition, a GC storm) but stops making them once the system returns to synchronous behavior, by *adapting* its timeouts upward each time it is proven wrong. Every production failure detector in this chapter — timeout-based, phi-accrual, SWIM — is an engineering approximation of ◇P: strongly complete, and accurate *eventually*, once conditions stabilize.

The takeaway sentence: **you cannot buy a perfect detector; you can only buy an eventually-perfect one, and its "eventually" is exactly as long as your worst network/GC hiccup.**

---

## 69.5 The Three-Way Tension: Completeness, Accuracy, and Speed

The completeness/accuracy pair is really a *three*-way tension once you add the dimension every operator actually cares about: **detection time** — how long between a crash and its suspicion. Chen, Toueg, and Aguilera (2002) formalized failure-detector quality of service with three metrics that are worth carrying into an interview:

| Metric | Symbol | Meaning | Want |
|---|---|---|---|
| Detection time | T_D | Time from a crash to it being suspected | small |
| Mistake recurrence time | T_MR | Average time between consecutive false suspicions | large |
| Mistake duration | T_M | How long a false suspicion lasts before it is corrected | small |

These three cannot all be optimized at once, and the coupling is the crux of every tuning decision:

- **Detection time vs accuracy.** Shorter timeouts → faster detection (smaller T_D) but more false positives (smaller T_MR, worse accuracy). Longer timeouts → fewer mistakes but you notice real crashes later. You are sliding one knob and both quantities move in opposite directions.
- **Completeness vs accuracy.** Suspect aggressively → you never miss a real failure but you falsely accuse the slow (complete but inaccurate). Suspect conservatively → you rarely accuse the innocent but you are slow to catch the dead.

```
  false-positive rate
        ▲
   high │*                         aggressive: fast T_D, many mistakes
        │ *
        │   *
        │      *  *
        │            *  *  *              the frontier — you pick a point,
   low  │                    * * * *      you don't escape the curve
        └────────────────────────────────▶ detection time  T_D
        fast                          slow
```

Everything from §69.6 onward is a technique to *bend this curve inward* — to get a better accuracy-for-a-given-detection-time trade than a naive fixed timeout gives — never to eliminate it.

---

## 69.6 Timeouts: The Crude Baseline

The simplest possible detector: A pings B (or expects periodic traffic from B), starts a timer, and if no response arrives within a fixed **timeout** Δ, A suspects B. This is what a bare TCP connection with `SO_KEEPALIVE` gives you (Ch. 38 §38.x): the kernel sends keepalive probes and tears the connection down after a fixed number of unanswered ones. It is the baseline against which everything else is measured, and it is genuinely bad.

The pathology is that a **single fixed timeout is a binary threshold over a continuous, noisy, drifting quantity** (network + processing latency). Consider a link whose round-trip time is normally 2 ms but occasionally spikes to 300 ms under load:

- Set Δ = 50 ms → fast detection, but every load spike produces a false positive. The detector flaps.
- Set Δ = 5 s → no false positives from spikes, but a genuinely crashed node goes unnoticed for 5 s, during which every request to it stalls.

There is no single Δ that is both fast and quiet, because the latency distribution is *wide* and its tail is *fat*. The fixed timeout has to be set for the worst case it will tolerate, which makes it slow for the common case. Worse, a static Δ chosen for today's load is wrong tomorrow: it does not adapt to a datacenter getting busier, a link degrading, or diurnal traffic patterns.

The classic mistake in interviews is to propose "just use a timeout" and stop. The follow-up — *how do you pick it, and what happens when the network's latency distribution shifts?* — is the whole subject.

---

## 69.7 Choosing a Timeout, and Adaptive Timeouts

If you must use a timeout, base it on **observed** round-trip times, not a hard-coded constant. The standard approach — borrowed straight from TCP's retransmission timer (RFC 6298, Ch. 38 §38.x) — is to maintain an exponentially-weighted moving average of the RTT and its variation, and set the timeout a few deviations above the mean:

```
SRTT   ← (1 − α)·SRTT   + α·RTT_sample          (smoothed RTT,   α ≈ 1/8)
RTTVAR ← (1 − β)·RTTVAR + β·|SRTT − RTT_sample|  (variation,      β ≈ 1/4)
RTO    = SRTT + 4·RTTVAR                          (retransmit timeout)
```

The `4·RTTVAR` term is the crucial part: the timeout floats *above the mean by a multiple of the observed jitter*, so a link that is steady gets a tight timeout and a link that is jittery gets a loose one — automatically. This is an **adaptive timeout**, and it already bends the §69.5 curve inward compared to a fixed Δ, because it stops paying the worst-case penalty on quiet links.

The remaining weakness is that the output is still **binary** — the moment the timer fires, B goes from "fully trusted" to "fully suspected" with nothing in between. A momentary blip that crosses the threshold produces a full-blown, all-or-nothing accusation. Two ideas fix the two remaining problems:

- Make the output **continuous** rather than binary → the phi-accrual detector (§69.12).
- Make the accusation **provisional and correctable** rather than final → suspicion + refutation (§69.11, §69.16).

Jacobson's algorithm is the ancestor of both: it is where "measure the distribution, don't hard-code the timeout" comes from, and phi-accrual is its logical conclusion.

---

## 69.8 Heartbeats and Pings: Push vs Pull

The other half of the design is *who initiates the liveness check*. Two dual patterns:

**Heartbeats (push).** Each node *proactively* and *periodically* announces "I am alive" to those monitoring it, every interval T_hb. The monitor resets a countdown on each heartbeat; if it fires (no heartbeat for some multiple of T_hb), it suspects. The monitored node drives the traffic. This is what Cassandra, Akka, and most gossip systems use.

**Pings (pull).** The monitor *proactively* probes: it sends "are you alive?" and waits for an ack. The monitor drives the traffic. This is what SWIM's core protocol does, and what a health-check load balancer does.

```
 PUSH (heartbeat)                    PULL (ping / ack)
 B ──hb──▶ A   (B initiates)         A ──ping──▶ B   (A initiates)
 B ──hb──▶ A                         A ◀──ack─── B
 B ──hb──▶ A   A suspects if the     A ──ping──▶ B   A suspects if the
   (silence)   heartbeat stops          (no ack)     ack does not come
```

The practical differences:

| | Push (heartbeat) | Pull (ping) |
|---|---|---|
| Who sends | monitored node | monitor |
| Detects | node stopped emitting | node fails to respond |
| Round trips | one-way (0.5 RTT signal) | full RTT |
| A silent monitor learns | nothing extra needed | must actively probe |
| Distinguishes send vs recv failure | poorly | better (tests both directions) |

Push is cheaper per check (one-way message, no request needed) and is a natural fit for gossip, where the heartbeat piggybacks on membership traffic anyway. Pull tests the *full round trip* and so catches asymmetric failures (B can receive but not send) that a pure push scheme misses. Real systems mix them; SWIM is pull at its core but disseminates state via push-style gossip.

---

## 69.9 Heartbeat Interval and the Cost/Detection-Time Trade

Whatever the pattern, the heartbeat **interval** T_hb is the master knob, and it sets a hard floor on detection time. If a node emits a heartbeat every T_hb and you declare it dead after missing `n` consecutive beats, then:

- **Detection time** is bounded below by roughly `n · T_hb` (you must wait for `n` missed intervals).
- **Message load** scales as `1 / T_hb` per monitored link — halving the interval doubles the traffic.
- **False-positive sensitivity** rises as `n` shrinks: `n = 1` (suspect after one missed beat) flaps on any single lost packet; larger `n` tolerates transient loss at the cost of slower detection.

The exact numbers matter and interviewers ask for them. Cassandra gossips (and thus heartbeats) **once per second**. Akka's cluster default heartbeat interval is **1 s** with an acceptable pause allowance layered on top. ZooKeeper clients ping at **1/3 of the negotiated session timeout**, so a 6 s session → 2 s pings → two chances to be heard before expiry. etcd's Raft tick and Patroni's `loop_wait` are on the order of **1 s** and **10 s** respectively.

The scaling problem is that **all-to-all heartbeating is O(n²) traffic**: if every one of n nodes heartbeats every other, the cluster carries n·(n−1) heartbeats per interval. At n = 1000 with a 1 s interval that is ~10⁶ messages/second of pure liveness overhead, and it grows quadratically. This O(n²) wall is the single biggest reason large clusters abandon all-to-all heartbeating for the gossip and indirect schemes of §69.11 and §69.15, which reduce per-node load to O(1).

---

## 69.10 Timeout-Free Failure Detectors

A subtle and elegant idea from the literature (and Petrov calls it out): you can decouple the *failure-detection logic* from *timeouts entirely*, pushing all timing decisions to the application. Instead of the detector deciding "B is dead," it just **maintains and disseminates a heartbeat counter per node**, and lets each consumer apply its own freshness policy.

The mechanism: every node keeps a **vector (or map) of heartbeat counters**, one per member. Each node periodically increments *its own* counter and gossips the whole vector to a few neighbors. When node A receives node C's vector, A merges it by taking the **element-wise maximum** — for each member m, A keeps the largest counter value it has seen from anyone, along with the local wall-clock time at which A first saw that new maximum. This is the same **version-vector merge** used in gossip dissemination (Ch. 72 §72.x).

```
Node A's table after merging gossip:
 member │ max heartbeat counter │ local time last increased
   B    │        4021           │      t = 10.2 s
   C    │        3999           │      t =  9.8 s
   D    │         512           │      t =  3.1 s   ← D's counter is stale
```

Now the detector proper never times anything out. It exposes the table; the application decides. If a member's counter has not increased for "too long" *by the consumer's own definition*, that consumer treats it as failed. The advantages:

- **No global timeout to mis-tune.** Different consumers can apply different thresholds to the same liveness data (a lock service can be aggressive; a metrics collector can be lax).
- **It composes with gossip naturally** — the counter vector *is* the gossip payload, so failure detection is free-riding on membership dissemination, and detection is O(1) load per node (§69.17).

The heartbeat-counter approach is the conceptual bridge from crude timeouts to accrual: it says *separate the raw liveness signal (counters, arrival times) from the accusation decision (thresholds)*, which is exactly what phi-accrual then formalizes with a probability distribution instead of a hand-picked threshold.

---

## 69.11 Outsourced Heartbeats and Indirect Probing (SWIM's ping-req)

The most impactful practical trick for suppressing false positives under transient loss is **not to trust your own single failed probe.** If A pings B and gets no ack, the failure might be B (dead) *or* the specific path A↔B (a dropped packet, a congested link, an overloaded NIC on A's side). Before accusing B, **ask other nodes to check on your behalf** — outsource the heartbeat.

This is SWIM's **indirect probe** (`ping-req`), and it is the mechanism that made SWIM production-viable (Serf, Consul, HashiCorp Memberlist, Nakama). The protocol, per period T':

1. A picks a random member B and sends a direct `ping`. If B's `ack` returns within a timeout, B is healthy — done.
2. If the direct ping times out, A does **not** yet suspect B. Instead A picks **k** other random members (k is a small constant, e.g. 3) and sends each a `ping-req(B)`.
3. Each of those k relays a `ping` to B on A's behalf; if B answers, the relay forwards B's `ack` back to A.
4. If B answers *any* of the indirect probes, A considers B healthy — the direct path A↔B was just faulty, B is fine.
5. Only if **all** probes (direct + k indirect) fail does A move B to *suspect*.

```
      direct ping fails
 A ─── ping ✗ ──▶ B          (A↔B link bad OR B dead?)
 A ─ping-req(B)─▶ C ─ping─▶ B ─ack─▶ C ─ack─▶ A   ← B answers via C
 A ─ping-req(B)─▶ D ─ping─▶ B                      ← D's path also tried
 A ─ping-req(B)─▶ E ─ping─▶ B
  if ANY indirect ack returns → B is alive, A's direct path was the problem
  if ALL k indirect probes fail too → A suspects B
```

Why it works: a false positive now requires **k + 1 independent paths to B to all fail simultaneously**. A single dropped packet or one bad link no longer produces an accusation; you need a genuine, multi-path failure — which is a far better proxy for "B is actually gone." Indirect probing dramatically improves accuracy (raises T_MR, the mistake-recurrence time) *without* lengthening the base detection time, because the k indirect probes happen in parallel within the same protocol period. It bends the §69.5 curve inward exactly where it matters.

---

## 69.12 The Phi-Accrual Failure Detector

The phi-accrual detector (Hayashibara, Défago, Yared, Katayama 2004) is the most important single idea in this chapter and a frequent interview topic. Its thesis: **do not output a boolean.** The detector's job is not to decide "alive/dead" — that couples the detection logic to one application's risk tolerance. Instead it outputs a **continuous, real-valued suspicion level, phi (φ)**, which *rises smoothly* the longer a heartbeat is overdue. Each application picks its own threshold on φ, so one detector serves consumers with wildly different needs (a lock manager that wants to be paranoid and a monitoring dashboard that wants to be relaxed) from the *same* stream of heartbeats.

The mechanism, at a high level:

1. Record the **arrival time of every heartbeat** from B into a sliding window (e.g. the last 1000 inter-arrival samples).
2. Treat the **inter-arrival times as samples from a probability distribution**, and estimate its parameters (mean μ and standard deviation σ) from the window. The original paper and Akka use a **normal** distribution; Cassandra historically used an **exponential** approximation.
3. At any query time `t_now`, let `Δt = t_now − t_last` be the time since the last heartbeat. Compute **P_later(Δt)** = the probability, under the fitted distribution, that a heartbeat would arrive *more than* Δt after the previous one.
4. Output **φ = −log₁₀(P_later(Δt))**.

The genius is in the meaning of φ. `P_later` is the probability that "a gap this long is normal." As Δt grows, P_later shrinks toward zero, and −log₁₀ of it grows without bound. The value of φ is directly interpretable as an *order-of-magnitude confidence*:

| φ value | P_later ≈ | Interpretation |
|---|---|---|
| 1 | 10⁻¹ = 10% | ~10% chance we're wrong to suspect |
| 2 | 10⁻² = 1% | 1% chance of a mistake |
| 3 | 10⁻³ = 0.1% | 0.1% chance of a mistake |
| 8 | 10⁻⁸ | ~1-in-100-million chance of a mistake |
| 12 | 10⁻¹² | astronomically confident |

So an application that can tolerate a 1% false-positive rate sets its threshold at φ = 2; one that needs 10⁻⁸ sets it at φ = 8. **The threshold *is* the mistake probability, expressed as a negative exponent.** And because φ is derived from the *measured* distribution, it **adapts automatically**: on a jittery link σ is large, P_later stays high for longer, φ rises slowly, and the detector is patient; on a rock-steady link σ is tiny, φ shoots up the instant a heartbeat is late, and detection is fast. One algorithm, self-tuning to the observed network — this is the ◇P approximation done right.

---

## 69.13 Phi-Accrual: The Math and a Worked Example

Make it concrete. Model inter-arrival times as normal with mean μ and standard deviation σ estimated from the sliding window. The probability that the next heartbeat is *later than* Δt after the last one is the upper tail of the normal CDF:

```
                            Δt − μ
P_later(Δt) = 1 − Φ(z),   z = ───────      (Φ = standard normal CDF)
                              σ

φ(Δt) = −log₁₀( P_later(Δt) ) = −log₁₀( 1 − Φ(z) )
```

**Worked example.** Heartbeats arrive on average every **μ = 1000 ms** with **σ = 100 ms** (a well-behaved link). Watch φ climb as the silence grows:

| Time since last HB, Δt | z = (Δt−μ)/σ | P_later = 1−Φ(z) | φ = −log₁₀(P_later) |
|---|---|---|---|
| 1000 ms (on time) | 0.0 | 0.500 | 0.30 |
| 1100 ms | 1.0 | 0.159 | 0.80 |
| 1200 ms | 2.0 | 0.0228 | 1.64 |
| 1300 ms | 3.0 | 0.00135 | 2.87 |
| 1400 ms | 4.0 | 3.17×10⁻⁵ | 4.50 |
| 1500 ms | 5.0 | 2.87×10⁻⁷ | 6.54 |
| 1600 ms | 6.0 | 9.9×10⁻¹⁰ | 9.00 |

Read it as a timeline: at 1200 ms the detector is barely worried (φ ≈ 1.6); by 1500 ms it is fairly sure (φ ≈ 6.5); by 1600 ms it is extremely sure (φ ≈ 9). An app with `threshold = 8` convicts B at ≈ 1600 ms of silence — 600 ms past the expected beat. An app with `threshold = 2` convicts at ≈ 1250 ms, much sooner but with a higher mistake rate.

```
 φ
 9 ┤                                              ●  convict @ threshold 8
 8 ┤                                          ╭───
 7 ┤                                      ╭───╯
 6 ┤                                  ╭───╯
 5 ┤                              ╭───╯
 4 ┤                          ╭───╯
 3 ┤                     ╭────╯  ← convict @ threshold 2 (~1250ms)
 2 ┤               ╭─────╯
 1 ┤      ╭────────╯
 0 ┤──────╯
   └┬────┬────┬────┬────┬────┬────┬──▶  Δt (ms)
   1000 1100 1200 1300 1400 1500 1600
```

Now the adaptivity is visible in the algebra: **widen σ to 300 ms** (a jittery link) and z at Δt = 1600 becomes (1600−1000)/300 = 2.0, so P_later = 0.023, φ ≈ 1.64 — the *same* 1600 ms of silence yields φ ≈ 1.6 instead of 9. The detector automatically tolerates far more delay on a link it has learned is noisy. No knob was turned; the distribution did the tuning.

---

## 69.14 Cassandra and Akka: phi_convict_threshold in Practice

Phi-accrual is not a paper curiosity; it is the production failure detector in Apache Cassandra, ScyllaDB, and Akka Cluster. The knobs are worth knowing by name.

**Cassandra** exposes `phi_convict_threshold` in `cassandra.yaml`, **default 8**, valid range **5–16**. Higher = more reluctant to convict = fewer false positives but slower detection. The operational guidance is directly from §69.5's trade: on flaky or cloud networks (EC2 cross-AZ, noisy neighbors), operators raise it to **10–12** to stop spurious node-down events from triggering unnecessary hinted-handoff and streaming; on a quiet, dedicated network they may lower it for faster detection. Cassandra feeds the detector the **gossip heartbeats** it already exchanges once per second (§69.9), so failure detection piggybacks on gossip at zero extra message cost.

**Akka Cluster** (`akka.cluster.failure-detector`) uses a phi-accrual detector with these defaults:

- `threshold = 8.0` (the φ conviction threshold).
- `heartbeat-interval = 1 s`.
- `acceptable-heartbeat-pause = 3 s` — a constant *added* to the expected interval before φ starts climbing steeply, which absorbs brief GC pauses and scheduling hiccups (§69.20) without penalty.
- `min-std-deviation = 100 ms` — a *floor* on σ, so that on an unrealistically steady link the detector does not become hair-trigger (a tiny σ would make φ explode on the slightest delay). This floor is a direct defense against the "too-accurate link" failure mode.

The `acceptable-heartbeat-pause` and `min-std-deviation` parameters are the practical lessons that pure theory omits: real heartbeats have a **noise floor** (the JVM will pause, the scheduler will preempt) that you must build a tolerance band around, or the detector flaps on healthy nodes. That is the bridge to §69.20.

---

## 69.15 Gossip-Based Detection: SWIM in Detail

SWIM — **S**calable **W**eakly-consistent **I**nfection-style process group **M**embership protocol (Das, Gupta, Motivala 2002) — is the other pillar, and it unifies three concerns that naive designs keep separate: **membership** (who is in the cluster), **failure detection** (who is alive), and **dissemination** (how everyone learns the answer). Its key architectural insight is to **separate the failure-detection traffic from the dissemination traffic**, so that each can be tuned independently and neither scales badly.

**Failure detection component** (the pull protocol of §69.8 + indirect probing of §69.11): each protocol period T', every node picks *one* random member, direct-pings it, and falls back to k indirect `ping-req`s if that fails (§69.11). That is the entire detection mechanism — one target per period, not all-to-all.

**Dissemination component** (infection-style gossip, Ch. 72 §72.x): membership changes (joins, leaves, and — crucially — suspicions and confirmations of failure) are **piggybacked on the ping/ack/ping-req messages** that the detection component is already sending. There is no separate broadcast. An update spreads like an epidemic: each carrier infects a few others per round, and the number of infected nodes grows exponentially, so a change reaches all n nodes in **O(log n)** rounds. Because the updates ride on existing traffic, dissemination costs essentially **zero extra messages**.

```
 Protocol period T' on node A:
   1. pick random member B
   2. ping B            ── piggyback: recent membership updates
   3. if no ack: ping-req(B) to k random members  (§69.11)
   4. update B's state; piggyback the change on the NEXT period's messages
   ⇒ every message does double duty: liveness probe + gossip carrier
```

The **suspicion subprotocol** (from the SWIM paper and hardened by HashiCorp's *Lifeguard* extensions) is what makes gossip-based detection accurate rather than trigger-happy. A failed probe does not immediately mark B `dead`; it marks B **`suspect`** and gossips *that*. The suspicion propagates; other nodes that can still reach B get a chance to refute it (§69.16). If no refutation arrives within a suspicion timeout, `suspect` is upgraded to `dead` and *that* is gossiped. This three-state lifecycle — **alive → suspect → dead** — is the gossip analogue of phi-accrual's continuous φ: it inserts a *correctable, provisional* stage between "seems gone" and "declared gone," which is where accuracy comes from.

---

## 69.16 Incarnation Numbers: Refuting a False Suspicion

Gossip creates a problem timeouts do not: once a false `suspect B` rumor is loose in the cluster, how does B — who is perfectly alive — **kill the rumor** before it becomes a `dead B` and evicts it? The answer is **incarnation numbers**, and they are the single cleverest detail in SWIM.

Every node owns a monotonically increasing **incarnation number**, and — the load-bearing rule — **only the node itself may increment its own incarnation.** Membership records are tagged with the incarnation they refer to, and every node resolves conflicting rumors about member m by a fixed precedence over `{state, incarnation}`:

```
 Message about member m       Overrides current record if...
 ─────────────────────────    ─────────────────────────────────────
 Alive{m, inc}                inc  >  current incarnation of m
                              (a strictly newer "I'm alive" wins)
 Suspect{m, inc}              inc >= current incarnation of m
                              AND current state is Alive
 Dead{m, inc}                 always wins for that incarnation
                              (death is final; only a NEWER
                               incarnation from m could precede it —
                               and a dead process can't emit one)
```

The refutation flow: node B, humming along at incarnation 7, receives a gossiped `Suspect{B, 7}` (someone's probe to B was lost). B **increments its own incarnation to 8** and floods `Alive{B, 8}`. Because 8 > 7, the `Alive{B, 8}` record *overrides* `Suspect{B, 7}` everywhere it propagates — the suspicion is extinguished and B stays in the cluster. Crucially, **no other node can forge this**: only B can produce `Alive{B, 8}`, because only B increments B's incarnation. So a live node can always out-argue a false suspicion about itself, while a genuinely dead node cannot (it emits nothing), and its `suspect` correctly ripens into `dead`.

This is the gossip counterpart of phi-accrual's provisional φ: incarnation numbers give the mechanism by which a **provisional accusation is correctable by the accused**, which is exactly the property §69.2 said a good detector needs. It is also a beautiful example of a monotonic, self-owned logical counter (cf. Lamport versions, Ch. 68/72) used to totally-order otherwise-conflicting rumors.

---

## 69.17 Scalability: O(1) vs O(n) Load per Node

The reason SWIM and gossip detectors dominate large clusters is a hard scaling argument that interviewers love, and it is worth stating quantitatively.

**All-to-all heartbeating**: every node monitors every other, so each node sends and receives **O(n)** heartbeats per interval, and the cluster carries **O(n²)** total. At n = 1000, that is ~10⁶ liveness messages per interval; at n = 10 000 it is 10⁸. The per-node network and CPU cost *grows with cluster size*, so the scheme has a ceiling — add nodes and eventually the heartbeat traffic alone saturates links. Worse, detection quality *degrades* as n grows because each node must process n timers.

**SWIM / gossip**: each node pings exactly **one** target per period plus **k** (a constant, ~3) indirect probes, and piggybacks dissemination on those. So each node's load is **O(1) — independent of n.** The cluster-wide message rate is O(n) (linear), not O(n²). Detection time stays *expected constant* (a crashed node is probed by *some* live node within a small constant number of periods, in expectation, regardless of n), and dissemination reaches everyone in O(log n) rounds.

| Property | All-to-all heartbeats | SWIM / gossip |
|---|---|---|
| Messages per node per period | O(n) | **O(1)** |
| Cluster-wide messages | O(n²) | O(n) |
| Detection time vs n | grows | **~constant (expected)** |
| Dissemination latency | — | O(log n) rounds |
| Scales to 10⁴+ nodes | no | yes |

The one-liner: **all-to-all makes every node's liveness cost proportional to the cluster size; gossip makes it constant.** That single asymptotic difference — O(1) vs O(n) per node — is why HashiCorp's Serf/Consul, and any membership layer expected to reach thousands of nodes, is gossip-based rather than heartbeat-based.

---

## 69.18 Reversing the Problem: Self-Monitoring and the Sink Approach

Petrov points out that the whole problem can be **turned inside out**. Everything above has monitors *inferring* a node's health from the *outside* by watching for silence. But the node itself is often in a far better position to know it is unhealthy — it can see its own disk errors, its own exhausted heap, its own failed dependency, its own inability to make progress — long before an external observer's timeout fires.

So flip it: instead of others deciding a node is dead, have each node **actively announce its own liveness (and health)** to a designated collector — a **"sink"** or health registry — and let the *absence* of that self-report, plus the *content* of the reports it does send, drive the decision. Variants:

- **Self-reporting to a sink.** Each node emits periodic "I am alive and here is my health" to a coordinator (or a shared store). This concentrates the decision, and lets a node **volunteer** that it is degraded ("my disk is failing, evict me") rather than waiting to be timed out.
- **Self-fencing / self-eviction.** A node that detects it cannot make progress — cannot reach a quorum of peers, cannot fsync, has lost its lease — **removes itself**, rather than waiting to be removed. A primary that notices it can no longer renew its lease steps down *proactively*. This is central to correct fencing (§69.19) and to avoiding split-brain in Ch. 70.

The advantage is speed and richness: a node knows its own failure *modes* (not just "silent" but "disk full," "GC-thrashing," "partitioned from the quorum") and can report a *reason*, and it can act on that knowledge before any external detector's clock runs out. The catch — and why this does not *replace* outside monitoring — is the obvious one: **a node that has truly crashed cannot report that it crashed.** Self-monitoring catches the failures a node can observe about itself; external detection is still required for the failures that silence the node entirely. Production systems combine both: self-reporting for graceful/observable degradation, external heartbeats/gossip for the hard crash the node can never announce.

---

## 69.19 Leases, Sessions, and Fencing: ZooKeeper, etcd, and Patroni

Failure detection becomes *actionable* — safe to build a leader election or lock on — only when it is wrapped in a **lease** (a time-bounded, self-expiring grant), because a lease converts an unreliable suspicion into a **safe, self-fencing timeout with a single authority**. This is where the theory meets PostgreSQL HA directly.

**Leases and sessions.** A lease is a grant that is valid only until a TTL expires unless actively renewed. The holder must keep renewing (heartbeating) before expiry; if it stops — crashed, slow, or partitioned — the lease **expires on its own**, and whatever it protected (a lock, a leadership role, a set of ephemeral keys) is released *without needing to confirm the holder is dead*. The lease turns "we suspect B" into "B's grant has provably expired," which is a fact, not a suspicion — because it is defined by *one* clock (the grantor's) rather than by agreement about B's state.

- **ZooKeeper sessions.** A client negotiates a **session timeout** (bounded by ZK's `tickTime`, typically between 2× and 20× a tick of ~2 s). The client pings at **1/3 of the timeout** to keep the session alive. If ZK hears nothing for the whole timeout, the session **expires** and all of that client's **ephemeral znodes are deleted** — which is exactly how ZK-based leader election and locks release automatically when a holder dies (Ch. 70). The failure detector *is* the session-expiry timer, centralized in the ZK quorum.
- **etcd leases.** A client creates a **lease with a TTL**, attaches keys to it, and calls **`KeepAlive`** to refresh it. Miss the refresh and the lease expires and **all attached keys are deleted atomically**. This is the etcd primitive for locks and leader keys.

**PostgreSQL angle — Patroni.** Postgres has no built-in cluster membership or failover; the dominant HA tool, **Patroni**, outsources liveness to a **DCS** (Distributed Configuration Store: etcd, Consul, or ZooKeeper) using exactly this lease/TTL machinery. The current primary holds a **leader key with a TTL** (default `ttl = 30 s`); every `loop_wait` (default **10 s**) each node runs its HA loop and the leader **updates (renews) the leader key**. If the primary crashes, hangs, or is partitioned from the DCS and fails to renew before the TTL elapses, the **leader key vanishes**, and the healthy replicas — seeing no leader key — hold an election and one promotes itself. The `ttl > loop_wait` relationship gives the primary several renewal attempts before losing leadership, trading failover speed for stability exactly as §69.5 predicts (raise `ttl` for fewer spurious failovers, lower it for faster ones). Critically, a primary that **loses contact with the DCS demotes itself** (self-fencing, §69.18) *before* the TTL expires, so it cannot keep accepting writes as a zombie primary while a new one is elected — this is how Patroni avoids **split-brain**. That last point is the whole reason leases beat bare failure detectors: a lease is a **fencing token** with a deadline, so even a detector mistake cannot produce two simultaneous primaries.

---

## 69.20 Practical Concerns: Flapping, GC Pauses, and Tuning

The gap between the clean theory above and a system that does not page you at 3 a.m. is a handful of real-world pathologies.

**GC pauses look exactly like crashes.** A stop-the-world garbage collection — a full GC on a large JVM heap, easily **multiple seconds**, historically 10+ seconds on a badly-tuned multi-gigabyte heap — freezes *every* thread, including the one that sends heartbeats. To every external monitor, a node in a 10 s GC pause is *indistinguishable from a crashed node* (it is §69.1's "slow" case in its purest form). If your conviction timeout is under the worst-case GC pause, you will **falsely evict healthy nodes every time they collect garbage**, triggering failovers, data streaming, and often a cascade (the reshuffle load induces more GC on the survivors). The same applies to any stop-the-world event: a page-fault storm / thrashing under memory pressure (Ch. 32 §32.x), a `fsync` stall on a busy disk, a hypervisor "steal" pause on a noisy-neighbor VM, or a runaway process starving the scheduler (Ch. 35 clocks/scheduling). This is the concrete reason Akka has an `acceptable-heartbeat-pause` (§69.14) and Cassandra operators raise `phi_convict_threshold`: **your conviction threshold must exceed your worst tolerable pause**, or the detector fights your own runtime.

**Flapping.** A node oscillating between suspected and alive — because it sits right at the timeout boundary, or a link is intermittently lossy — produces a storm of membership changes, each of which triggers expensive reactions (rebalancing, elections, cache invalidation). Cures: **hysteresis** (require a healthy node to stay healthy for a while before re-admitting it, and use the suspect→dead delay of §69.15), **damping** (rate-limit membership churn), and the indirect probing of §69.11 (don't accuse on one lost packet).

**Clocks.** Timeout- and lease-based detectors depend on *local* clock *intervals*, not absolute time, so they need a monotonic clock immune to NTP steps and wall-clock jumps (Ch. 35 §35.x) — never measure a heartbeat interval with `gettimeofday`/wall-clock, or an NTP correction can instantly expire or extend every lease. Lease safety further assumes bounded **clock drift** between grantor and holder; the holder must treat its lease as expiring *earlier* than the grantor does (a safety margin), so that clock skew cannot let a holder believe it still owns a lease the grantor has already reclaimed.

**Tuning is picking a point on the §69.5 curve, explicitly.** Detection time vs stability is a business decision: a payments primary might accept slower failover (`ttl = 30 s`) to *never* split-brain; a stateless cache tier might convict in 2 s because a wrong eviction is cheap. There is no universally correct setting — only a setting that matches the cost of a false positive against the cost of a slow true positive for *this* workload.

---

## 69.21 Putting It Together: Choosing a Detector

A decision guide, since interviews often end with "what would you use?"

| Situation | Detector of choice | Why |
|---|---|---|
| Two nodes, simple TCP link | Adaptive timeout / TCP keepalive (§69.7) | Cheap; distribution is narrow enough |
| Small–medium cluster, want continuous confidence | Phi-accrual (§69.12) | Self-tuning, per-consumer thresholds, absorbs jitter |
| Large cluster (10³–10⁴+ nodes) | SWIM / gossip (§69.15) | O(1) per-node load, O(log n) dissemination |
| Need *safe* leadership / locking on top | Lease + session (§69.19) | Turns suspicion into a fenced, self-expiring fact |
| PostgreSQL HA | Patroni + etcd/Consul TTL lease (§69.19) | Postgres has no native membership; DCS lease provides it |

The unifying mental model to walk out with: **a failure detector is a pipeline — measure a liveness signal (heartbeat arrivals, ping/ack), turn it into a suspicion (a timeout crossing, a rising φ, a failed multi-path probe), make the suspicion provisional and correctable (suspect state + incarnation refutation, or a continuous φ), and only then let a lease convert a sufficiently-confident suspicion into a safe, fenced action.** Every real system — Cassandra's phi-accrual over gossip, Consul's SWIM, ZooKeeper/etcd sessions, Patroni's TTL leases — is a specific instantiation of that pipeline, and every one of them is an *eventually-perfect* (◇P) approximation, because §69.4 guarantees a perfect one cannot exist.

---

## Summary

- You cannot distinguish a **crashed**, **slow**, or **partitioned** node from a single vantage point (recap Ch. 68): all three produce the identical observation "I heard nothing." Failure detection is therefore inherently a **suspicion, not a fact**.
- A failure detector is an **unreliable local oracle** that can make **false positives** (suspecting a live node) and **false negatives** (missing a dead one); correctly-designed algorithms tolerate its mistakes (costing liveness, never safety).
- Chandra–Toueg formalize detectors via **completeness** (every real failure eventually suspected — liveness) and **accuracy** (no false suspicion — safety), with strong/weak/eventual variants. **◇W is the weakest detector that can solve consensus.**
- A **Perfect (P)** detector is **impossible** in a purely asynchronous system; real systems are **partially synchronous** and target **Eventually Perfect (◇P)** — accurate once conditions stabilize.
- There is a **three-way tension** among detection time, mistake rate, and completeness; shorter timeouts detect faster but flap more. Every technique bends this curve inward without escaping it.
- **Timeouts** are the crude baseline; **adaptive timeouts** (EWMA of RTT + variance, à la TCP) and **phi-accrual** improve on them.
- **Phi-accrual** outputs a continuous suspicion **φ = −log₁₀(P_later)** from the fitted inter-arrival distribution; the threshold *is* the mistake probability (φ = 8 → 10⁻⁸). Cassandra's `phi_convict_threshold` (default 8) and Akka (threshold 8, `acceptable-heartbeat-pause`) use it.
- **SWIM** unifies membership + detection + dissemination: pull-based probing with **indirect `ping-req`** (outsourced heartbeats) for accuracy, **gossip** dissemination in O(log n), **suspect→dead** lifecycle, and **incarnation numbers** so a live node can refute a false suspicion. Load is **O(1) per node** vs **O(n)** for all-to-all heartbeating.
- **Reversing** the problem: nodes **self-report** health to a sink and **self-fence**, catching failures they can observe about themselves — but a truly crashed node cannot announce it, so external detection remains necessary.
- **Leases/sessions** (ZooKeeper session expiry, etcd lease TTL) convert suspicion into a **self-expiring, fenced fact**; **Patroni** gives PostgreSQL HA by holding a **TTL leader key in etcd/Consul**, self-demoting on DCS loss to avoid split-brain.
- **GC pauses** (and thrashing, fsync stalls, VM steal) masquerade as crashes; the conviction threshold **must exceed the worst tolerable pause**, and detectors must use **monotonic** clocks (Ch. 35).

---

## Key Interview Questions

1. **Why can't you tell a crashed node from a slow one?** — In an asynchronous system there is no upper bound on message delay or processing speed, so "no response by my deadline" is produced identically by a crash, an arbitrarily slow node, and a network partition. No finite timeout resolves the ambiguity, because a slow node might answer one microsecond after you give up.
2. **What does a failure detector actually output?** — A **suspicion**, not a fact: the set of processes it currently believes have failed. It is an unreliable local oracle that can be wrong in both directions, and the algorithms above it are designed to tolerate those mistakes.
3. **What is a false positive vs a false negative in failure detection?** — A false positive (a *mistake*) is suspecting a live node — cost: unnecessary failover/fencing/rebalancing. A false negative is failing to (promptly) suspect a dead node — cost: requests routed to a black hole and progress stalling. Tuning trades one against the other.
4. **Define completeness and accuracy.** — Completeness (liveness): every crashed process is eventually suspected — strong = by *every* correct node, weak = by *some*. Accuracy (safety): correct processes are not falsely suspected — strong = never by anyone, weak = some correct node is never suspected, eventual (◇) = mistakes stop after some finite time.
5. **Why is a perfect failure detector impossible?** — Strong accuracy (never suspect a live node) requires a known upper bound on delay, which asynchrony denies; refusing to ever give up violates completeness. This is a corollary of FLP. Real systems are partially synchronous and settle for **Eventually Perfect (◇P)**.
6. **What is ◇P (Eventually Perfect)?** — A detector that is strongly complete and *eventually* strongly accurate: it may make mistakes during bad periods (partitions, GC storms) but stops once the system behaves synchronously again, typically by adapting its timeouts upward each time it is proven wrong. Every production detector approximates ◇P.
7. **What is the weakest failure detector that solves consensus?** — ◇W (Eventually Weak): weak completeness plus eventual weak accuracy. Chandra–Hadzilacos–Toueg proved it is the minimal synchrony assumption under which asynchronous consensus becomes solvable; anything stronger (◇S, ◇P) also works.
8. **Describe the three-way tension in failure detection.** — Detection time (T_D), mistake recurrence time (T_MR), and mistake duration (T_M) cannot all be optimized together. Shortening timeouts lowers T_D (faster) but also lowers T_MR (more false positives). You pick a point on the curve; you cannot leave it.
9. **How do you choose a timeout, and what's an adaptive timeout?** — Base it on observed RTT, not a constant: maintain an EWMA of RTT (SRTT) and its variation (RTTVAR) and set the timeout to SRTT + 4·RTTVAR, exactly like TCP's RTO. It floats tight on steady links and loose on jittery ones, automatically.
10. **Push vs pull (heartbeat vs ping) — difference and trade-offs?** — Push: the monitored node periodically announces liveness; cheap (one-way), used by gossip/Cassandra/Akka. Pull: the monitor probes and awaits an ack; tests the full round trip and catches asymmetric (receive-but-not-send) failures; used by SWIM's core and health-check LBs.
11. **Why is all-to-all heartbeating a scalability problem?** — Each node monitors all others, so per-node load is O(n) and cluster-wide traffic is O(n²) — ~10⁶ messages/interval at n=1000, growing quadratically. It has a hard ceiling, which is why large clusters switch to gossip with O(1) per-node load.
12. **What is a timeout-free failure detector?** — One that never times anything out itself: it maintains per-node **heartbeat counters** in a vector, gossips it (merging by element-wise max plus local receipt time), and exposes the freshness data so each *application* applies its own threshold. It decouples the liveness signal from the accusation decision.
13. **What is indirect probing / outsourced heartbeats (SWIM's ping-req)?** — When A's direct ping to B fails, A does not accuse B; it asks k random other members to ping B on its behalf. B is only suspected if the direct probe *and* all k indirect probes fail. This requires k+1 independent paths to fail together, sharply reducing false positives from single lost packets without lengthening detection time.
14. **Explain the phi-accrual failure detector.** — Instead of a boolean, it outputs a continuous suspicion φ that rises as a heartbeat becomes overdue. It fits a distribution to observed inter-arrival times and computes φ = −log₁₀(P_later), where P_later is the probability a gap this long is normal. Each application sets its own φ threshold; the value equals the negative log of the mistake probability.
15. **What does a phi value of 8 mean, and how do you set the threshold?** — φ = 8 means P_later = 10⁻⁸, i.e. about a 1-in-100-million chance the suspicion is a mistake. The threshold *is* the tolerated mistake probability as a negative exponent: choose φ = 2 for a 1% mistake rate (fast, jumpy) or φ = 8–12 for very rare mistakes (slower, stable).
16. **How does phi-accrual adapt to a jittery network without retuning?** — φ is computed from the *measured* mean and standard deviation of inter-arrivals. On a jittery link σ is large, so P_later stays high longer and φ climbs slowly (patient); on a steady link σ is tiny and φ spikes the moment a beat is late (fast). The distribution does the tuning; no knob changes.
17. **What is `phi_convict_threshold` in Cassandra and when would you raise it?** — The φ threshold at which Cassandra convicts a peer as down; default 8, range 5–16. Raise it (to 10–12) on flaky or cloud networks to suppress false node-down events that trigger needless hinted-handoff/streaming; lower it on quiet dedicated networks for faster detection.
18. **What problem do Akka's `acceptable-heartbeat-pause` and `min-std-deviation` solve?** — `acceptable-heartbeat-pause` adds a tolerance band (default 3 s) so brief GC/scheduling pauses don't push φ up; `min-std-deviation` floors σ so an unrealistically steady link doesn't make the detector hair-trigger. Both encode that real heartbeats have a noise floor you must build tolerance around.
19. **What three things does SWIM combine, and how does it disseminate?** — Membership, failure detection, and dissemination. Detection is pull-based (one random target per period + k indirect probes); dissemination is infection-style gossip **piggybacked** on those probe messages, reaching all n nodes in O(log n) rounds at essentially zero extra message cost.
20. **What is SWIM's suspect→dead lifecycle for?** — A failed probe marks a node `suspect` (not immediately `dead`) and gossips that; other nodes may refute it, and only after a suspicion timeout does it become `dead`. The provisional, correctable middle state is where accuracy comes from — the gossip analogue of phi-accrual's continuous φ.
21. **What are incarnation numbers and why only self-incrementable?** — A per-node monotonic counter tagging membership records; only the node itself increments its own. To refute a false `Suspect{B,i}`, B floods `Alive{B,i+1}`, which overrides the suspicion because it is newer — and no other node can forge it. This lets a live node always out-argue a false suspicion while a dead node (which emits nothing) cannot.
22. **Why is SWIM O(1) per node while heartbeating is O(n)?** — SWIM has each node probe exactly one target plus a constant k indirect probes per period, independent of cluster size, so per-node load is O(1) and cluster-wide is O(n). All-to-all heartbeating makes each node's cost grow with n (O(n) per node, O(n²) total), which is why gossip scales to 10⁴+ nodes and heartbeating does not.
23. **What does "reversing the failure-detection problem" mean?** — Rather than outsiders inferring health from silence, each node self-reports its health to a sink and self-fences when it detects it cannot make progress. It catches richer, faster failure info (disk failing, quorum lost) that a node knows about itself, but cannot replace external detection because a truly crashed node cannot announce its own crash.
24. **How do leases/sessions turn suspicion into a safe action?** — A lease is a TTL grant the holder must renew; if it stops renewing (crash/slow/partition) the lease expires on its own and whatever it protected is released — a fact defined by one clock, not an agreement about the holder's state. ZooKeeper session expiry deletes ephemeral znodes; etcd lease expiry deletes attached keys.
25. **How does Patroni provide PostgreSQL HA, and how does it avoid split-brain?** — Postgres has no native membership, so Patroni stores a **leader key with a TTL** (default 30 s) in a DCS (etcd/Consul/ZooKeeper), renewed every `loop_wait` (10 s). If the primary can't renew, the key vanishes and replicas elect a new leader. The old primary **self-demotes** on losing DCS contact *before* its TTL expires, so two primaries never accept writes at once.
26. **Why do GC pauses cause false positives, and how do you defend against them?** — A stop-the-world GC (seconds, historically 10+ s) freezes the heartbeat thread, making a healthy node look crashed — the pure "slow" case. If the conviction timeout is below the worst pause you evict healthy nodes on every collection. Defense: set the threshold above the worst tolerable pause (Akka's `acceptable-heartbeat-pause`, higher `phi_convict_threshold`), and reduce pauses at the source.
27. **Why must failure detectors use a monotonic clock?** — They measure elapsed *intervals* (time since last heartbeat, lease TTL), not wall-clock instants. A wall-clock (NTP-steppable) source can jump forward or backward and instantly expire or extend every lease/heartbeat; a monotonic clock (Ch. 35) never goes backward and is immune to NTP corrections.
28. **How does clock drift affect lease safety?** — Lease correctness assumes bounded drift between grantor and holder. To stay safe, the holder must consider its lease expired *earlier* than the grantor does (a margin), so that skew can never let the holder still believe it owns a lease the grantor has already reclaimed and re-granted — which would be split-brain.

---

## Common Traps

- **Saying "the node is dead" instead of "the node is suspected."** A detector never establishes death; it establishes that it stopped waiting. Confident language about a fact you cannot observe is the core conceptual error.
- **Proposing a single fixed timeout and stopping there.** A static Δ cannot be both fast and quiet over a wide, fat-tailed latency distribution, and it is wrong the moment load shifts. The real answer is adaptive timeouts or accrual.
- **Claiming a perfect (never-wrong) detector is achievable with a big enough timeout.** It is provably impossible in an asynchronous system; you can only approximate Eventually Perfect (◇P). A bigger timeout just moves you along the curve, trading detection time for accuracy.
- **Confusing completeness with accuracy.** Suspecting everyone is perfectly complete and useless; suspecting no one is perfectly accurate and useless. The whole difficulty is getting both, and asynchrony forbids getting both perfectly.
- **Thinking phi-accrual outputs a boolean.** Its entire point is a *continuous* φ so each consumer picks its own threshold; φ = 8 encodes a 10⁻⁸ mistake probability, not a yes/no.
- **Forgetting that a GC pause is indistinguishable from a crash.** A multi-second stop-the-world pause freezes heartbeats; if your conviction threshold is below the worst pause, you evict healthy nodes on every collection and can cascade.
- **Believing gossip/SWIM eliminates false positives.** It reduces them (indirect probes, suspect state, incarnation refutation) but never removes them; it is still an eventually-perfect approximation, just a well-scaling one.
- **Assuming all-to-all heartbeating is fine because it's simple.** It is O(n²) cluster-wide and O(n) per node; it has a hard scaling ceiling, which is exactly why large systems adopt gossip's O(1)-per-node load.
- **Treating a raw failure detector as safe to act on directly.** Acting on a bare suspicion (evicting, promoting) risks split-brain; wrap it in a lease/fencing token so even a mistaken suspicion cannot produce two live primaries.
- **Measuring heartbeat intervals or lease TTLs with wall-clock time.** An NTP step can instantly expire or extend everything; interval-based liveness must use a monotonic clock.
- **Letting a node keep serving writes after it loses contact with the quorum/DCS.** A correct design self-fences (self-demotes) before its lease expires, so it cannot be a zombie primary while a new one is elected.
- **Setting one detector threshold for the whole fleet.** The right detection-time-vs-stability point depends on the cost of a false positive for *that* workload — a payments primary and a cache tier want opposite settings.
