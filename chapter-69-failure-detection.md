# Chapter 69 — Failure Detection

## Why This Matters — Core

In the asynchronous model, silence does not distinguish a crashed process from a slow process or an unreachable path. A failure detector therefore emits suspicion under stated timing and statistical assumptions, not proof of death. Protocol theorems, measured behavior, and product defaults are separate claims throughout this chapter.

---

## The 90-Second Screen — Core

1. A remote crash is not directly observable. “No reply yet” is compatible with crash, delay, overload, packet loss, and partition.
2. A detector reports **suspicion**. Completeness asks whether crashed processes are eventually suspected; accuracy asks whether correct processes avoid suspicion.
3. In a purely asynchronous system, no finite timeout can provide both perfect completeness and perfect accuracy.
4. Heartbeat interval and timeout trade detection delay, message cost, and false suspicion. Measure elapsed time with a monotonic clock.
5. Adaptive detectors estimate current delay behavior; they still fail when the future distribution differs from the sample.
6. Phi accrual reports `φ(t) = -log10(P_model(T > t))`: surprise under a fitted inter-arrival model. It is not a calibrated probability that the node is dead or that an accusation is wrong.
7. SWIM samples members, uses indirect probes for path diversity, and gossips membership transitions. `alive → suspect → dead` is protocol state, not proof of physical death.
8. Operational action needs a separate safety mechanism. A lease limits a grant in one authority's state; a fencing token must be checked by the protected resource.
9. Chapter 70 consumes suspicion for leadership. Failure detection alone neither elects a leader nor prevents split brain.

---

## 69.1 Why Failures Cannot Be Observed Directly — Core

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

## 69.2 A Failure Detector Is Suspicion, Not Fact — Core

Because the three cases collapse into one observation, the output of a failure detector is intrinsically a **suspicion**, not a ground-truth fact. Petrov's framing (and the classical literature's) is precise about this: a failure detector is a **local, unreliable oracle** that each node runs, producing at any moment a set of processes it *currently suspects* have failed. It can be — and routinely is — **wrong in both directions**:

- **False positive** (a *mistake*): suspecting a node that is actually alive. The node was just slow or briefly unreachable. The cost is real: the cluster may fence a healthy primary, trigger an unnecessary failover, reshuffle data, or drop a node that was about to answer.
- **False negative** (a *missed/late detection*): failing to suspect a node that is actually dead, or taking a long time to. The cost is that requests keep being routed to a black hole, locks stay held by a corpse, and progress stalls.

The word **unreliable** is a term of art, not a criticism. A protocol preserves safety despite detector mistakes only when suspicion controls attempts or liveness while quorums, epochs, leases, or resource-checked fencing prevent conflicting actions. A system that promotes or destroys data solely because of one suspicion can violate safety.

---

## 69.3 Completeness and Accuracy — Core

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

- Under reliable eventual dissemination among correct members, suspicions observed by one correct process can spread to all correct processes, strengthening completeness. The dissemination assumptions are part of the proof.
- Eventual accuracy is enough for important consensus constructions because temporary false suspicions can disrupt progress without deciding conflicting values. The eventual-leader detector `Ω` is the standard “weakest detector for consensus” result in the general theory; do not replace that theorem with a blanket claim that every practical timeout detector is `◇P`. Chapter 70 develops the leadership side.

---

## 69.4 Why a Perfect Detector Is Impossible — Core

A **Perfect** detector (class P: never misses a failure, never makes a mistake) is **impossible to implement in a purely asynchronous system**, and this is not an engineering limitation — it is a mathematical one, a corollary of the same asynchrony that makes §69.1's three cases indistinguishable.

The argument is a one-liner once §69.1 is granted: strong accuracy requires that you *never* suspect a live-but-slow node, which requires knowing an upper bound on message delay; but "asynchronous" *means* there is no such bound. Any deadline you pick can be exceeded by a live node, producing a mistake and violating strong accuracy; refusing to ever give up violates completeness. So P is unachievable. This connects to the deeper **FLP impossibility** (Fischer, Lynch, Paterson 1985): in an asynchronous system, deterministic consensus is impossible if even *one* process may crash, precisely because you cannot distinguish a crashed process from a slow one.

The practical escape hatch is an explicit synchrony assumption (recap Ch. 68): after some unknown stabilization time, processing and communication obey bounds that an adaptive detector can eventually exceed. That model can implement an eventually perfect detector. A production phi or SWIM deployment should not be assigned a formal detector class without proving its loss, scheduling, membership, and adaptation assumptions.

---

## 69.5 Detection Delay and False Suspicion — Core

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

## 69.6 Heartbeats, Timeouts, and Adaptation — Core

The simplest detector expects traffic or probes a peer, then suspects after a fixed timeout `Δ`. TCP keepalive can detect some broken connections, but OS settings, retransmission behavior, middleboxes, and application-level health make it different from a complete membership detector.

The pathology is that a **single fixed timeout is a binary threshold over a continuous, noisy, drifting quantity** (network + processing latency). Consider a link whose round-trip time is normally 2 ms but occasionally spikes to 300 ms under load:

- Set Δ = 50 ms → fast detection, but every load spike produces a false positive. The detector flaps.
- Set Δ = 5 s → no false positives from spikes, but a genuinely crashed node goes unnoticed for 5 s, during which every request to it stalls.

There may be no stable `Δ` that meets both objectives across workload regimes. A fixed timeout can still be appropriate for a bounded, measured environment or a low-consequence action; its assumptions must be stated and monitored.

The classic mistake in interviews is to propose "just use a timeout" and stop. The follow-up — *how do you pick it, and what happens when the network's latency distribution shifts?* — is the whole subject.

---

## 69.7 Adaptive Timeouts — Core

One adaptive pattern maintains exponentially weighted estimates of delay and variation. TCP's RFC 6298 estimator motivates the shape below, but a failure detector must choose samples and constants for its own heartbeat semantics:

```
SRTT   ← (1 − α)·SRTT   + α·RTT_sample          (smoothed RTT,   α ≈ 1/8)
RTTVAR ← (1 − β)·RTTVAR + β·|SRTT − RTT_sample|  (variation,      β ≈ 1/4)
RTO    = SRTT + 4·RTTVAR                          (retransmit timeout)
```

The variation term gives noisier observations more slack. Update order, initial values, minimum/maximum timeout, backoff, missing samples, and coordinated pauses all matter. This estimator follows past behavior; it provides no bound when the environment changes abruptly.

The remaining weakness is that the output is still **binary** — the moment the timer fires, B goes from "fully trusted" to "fully suspected" with nothing in between. A momentary blip that crosses the threshold produces a full-blown, all-or-nothing accusation. Two ideas fix the two remaining problems:

- Make the output **continuous** rather than binary → the phi-accrual detector (§69.12).
- Make the accusation **provisional and correctable** rather than final → suspicion + refutation (§69.11, §69.16).

Jacobson's algorithm is the ancestor of both: it is where "measure the distribution, don't hard-code the timeout" comes from, and phi-accrual is its logical conclusion.

---

## 69.8 Push Heartbeats Versus Pull Probes — Core

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

## 69.9 Interval, Misses, and Message Cost — Core

The heartbeat interval `H` and suspicion timeout determine detection phase. If the monitor suspects `nH` after the last received heartbeat and a crash occurs sometime in the next interval, idealized detection delay lies between roughly `(n-1)H` and `nH`; scheduling and network delay widen it.

- **Message load** scales as `1 / H` per monitored link before batching and piggybacking.
- **False-positive sensitivity** rises as `n` shrinks: `n = 1` (suspect after one missed beat) flaps on any single lost packet; larger `n` tolerates transient loss at the cost of slower detection.

**Worked tradeoff.** Let `H = 1 s`, `n = 3`, and let a healthy process pause immediately after its heartbeat at `t = 10`. The monitor suspects at `t = 13`. If the process resumes and its heartbeat arrives at `t = 13.2`, the detector made a false suspicion lasting at least 0.2 s, plus dissemination/recovery time. Raising `n` to 5 avoids this particular mistake but moves suspicion of a crash just after `t = 10` from `t = 13` to `t = 15`. Lowering `H` to 0.5 s with `n = 5` can regain delay at roughly twice the base message rate. This arithmetic is deterministic; which gaps occur in production is empirical.

For all-to-all monitoring, `n` nodes generate `n(n-1)` directed probes or heartbeats per round before retries and acknowledgements. Sampled protocols reduce expected per-node probe work, but retransmissions, indirect checks, dissemination, joins, and correlated failure bursts still contribute. Never copy a heartbeat interval or missed-beat count from another product without its version and failure budget.

---

## 69.10 Timeout-Free Signal, Not Timeout-Free Decision — Deep dive

A shared detector mechanism can avoid one global timeout while pushing timed
decisions to consumers. This is not a timeout-free end-to-end failure
decision. Instead of declaring “B is dead,” the mechanism **maintains and
disseminates a heartbeat counter per node**, and each consumer applies its own
freshness policy.

The mechanism: every node keeps a **vector (or map) of heartbeat counters**, one per member. Each node periodically increments its own counter and gossips the vector. A receiver merges counters by element-wise maximum and records the local **monotonic** receipt time of a new maximum. This resembles version-vector merging, though restart identity and membership still require their own protocol.

```
Node A's table after merging gossip:
 member │ max heartbeat counter │ local time last increased
   B    │        4021           │      t = 10.2 s
   C    │        3999           │      t =  9.8 s
   D    │         512           │      t =  3.1 s   ← D's counter is stale
```

Now the detector proper never times anything out. It exposes the table; the application decides. If a member's counter has not increased for "too long" *by the consumer's own definition*, that consumer treats it as failed. The advantages:

- **No global timeout to mis-tune.** Different consumers can apply different thresholds to the same liveness data (a lock service can be aggressive; a metrics collector can be lax).
- It composes with gossip, but a full counter vector is `O(n)` payload and merge work. Sparse deltas, digests, or sampled membership change that tradeoff.

The heartbeat-counter approach is the conceptual bridge from crude timeouts to accrual: it says *separate the raw liveness signal (counters, arrival times) from the accusation decision (thresholds)*, which is exactly what phi-accrual then formalizes with a probability distribution instead of a hand-picked threshold.

---

## 69.11 Indirect Probing (`ping-req`) — Core

An important practical technique for suppressing false positives under
transient path loss is **not to trust one failed direct probe**. If A pings B
and gets no ack, the failure might be B (dead) *or* the specific path A↔B (a
dropped packet, a congested link, or an overloaded NIC on A's side). Before
accusing B, ask other nodes to check on A's behalf—outsource the heartbeat.

This is SWIM's **indirect probe** (`ping-req`). The protocol, per period T':

1. A picks a random member B and sends a direct `ping`. If B's `ack` returns within a timeout, B is healthy — done.
2. If the direct ping times out, A does **not** yet suspect B. Instead A picks a configured number `k` of other members and sends each a `ping-req(B)`.
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

Indirect probes add path and observer diversity. If failures were independent, several failed paths would be stronger evidence than one. Real failures are often correlated: a rack partition, overloaded target, shared switch, or local scheduler pause can defeat every path at once. Indirection also consumes time and messages. Measure its benefit under the correlation structure the deployment actually sees.

---

## 69.12 Phi Accrual: Suspicion as Model Surprise — Core

The phi-accrual detector (Hayashibara et al., 2004) separates measurement from policy. It emits a continuous value, phi (`φ`), that usually rises as a heartbeat becomes overdue. Consumers choose thresholds appropriate to their actions.

The mechanism, at a high level:

1. Record heartbeat inter-arrival times from B into a bounded history.
2. Fit or approximate a distribution of inter-arrival times from a bounded history. Distribution choice, minimum variance, pause allowance, and warm-up behavior are implementation policies.
3. At any query time `t_now`, let `Δt = t_now − t_last` be the time since the last heartbeat. Compute **P_later(Δt)** = the probability, under the fitted distribution, that a heartbeat would arrive *more than* Δt after the previous one.
4. Output **φ = −log₁₀(P_later(Δt))**.

`P_later` is a tail area under the detector's model. As the elapsed gap grows, that area normally shrinks and `φ` grows:

| φ value | Model tail area |
|---|---|---|
| 1 | `10^-1` |
| 2 | `10^-2` |
| 3 | `10^-3` |
| 8 | `10^-8` |

This table does **not** say that `φ = 8` means one false conviction in one hundred million decisions. That interpretation would require a correct stationary model, independent samples, a specified decision process, and calibration against real outcomes. GC pauses, correlated loss, overload, regime changes, and biased sampling violate those assumptions. Treat `φ` as model-derived surprisal and calibrate thresholds empirically against false-suspicion and detection-delay objectives.

---

## 69.13 Worked Phi Calculation and Simulation — Core

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

Read it as model surprise: under this fitted normal distribution, 1600 ms lies much farther into the modeled tail than 1200 ms. A threshold near 8 crosses around 1600 ms; a threshold near 2 crosses earlier. The table alone does not supply the real false-suspicion rate.

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

Widening the fitted `σ` to 300 ms changes `z` at 1600 ms to 2, so `φ ≈ 1.64`. The same silence is less surprising under a noisier fitted model. This is adaptation, not prophecy: a stale history window can react too slowly to a new latency regime.

A compact C++23 calculation:

```cpp
#include <algorithm>
#include <cassert>
#include <cmath>

double phi_normal(double elapsed, double mean, double stddev) {
    assert(stddev > 0.0);
    double z = (elapsed - mean) / stddev;
    double tail = 0.5 * std::erfc(z / std::sqrt(2.0));
    return -std::log10(std::max(tail, 1e-300));
}

int main() {
    double steady = phi_normal(1600.0, 1000.0, 100.0);
    double jittery = phi_normal(1600.0, 1000.0, 300.0);
    assert(steady > 8.9 && steady < 9.1);
    assert(jittery > 1.6 && jittery < 1.7);
}
```

For a false-suspicion experiment, replay recorded healthy inter-arrival gaps. At each decision instant compute `φ`; count threshold crossings before the next known heartbeat, and separately inject crash points to measure detection delay. Preserve temporal bursts rather than randomly shuffling samples, because correlated pauses are exactly what an independent model misses.

---

## 69.14 Product Knobs Are Versioned Evidence — Role-specific

Cassandra-family and Akka deployments have exposed phi-related thresholds and pause/variance controls, but names, defaults, admissible ranges, and semantics vary by product and release. Quote them only with a versioned configuration reference.

The durable operational questions are:

- What samples enter the history window, especially during startup or long pauses?
- Is there a minimum standard deviation or acceptable-pause offset?
- When is a peer merely suspected, and which component takes action?
- Are convictions local or disseminated?
- What observed healthy traces produced threshold crossings?
- What crash-injection traces produced acceptable detection delay?

A higher threshold usually delays crossing for the same fitted model, but it does not monotonically guarantee a particular real-world false-positive rate after the workload changes.

---

## 69.15 SWIM Membership and Dissemination — Core

SWIM — **S**calable **W**eakly-consistent **I**nfection-style process group **M**embership protocol (Das, Gupta, Motivala 2002) — is the other pillar, and it unifies three concerns that naive designs keep separate: **membership** (who is in the cluster), **failure detection** (who is alive), and **dissemination** (how everyone learns the answer). Its key architectural insight is to **separate the failure-detection traffic from the dissemination traffic**, so that each can be tuned independently and neither scales badly.

**Failure detection component:** in the base protocol, a member periodically selects a target, sends a direct ping, and may fall back to indirect `ping-req` probes. Target selection, time budgets, retransmission, and extensions vary.

**Dissemination component:** membership changes are piggybacked on protocol messages and retransmitted according to a dissemination policy. Under random mixing and bounded-loss assumptions, epidemic spread is fast in expectation; correlated loss, churn, message-size limits, and retransmit caps change the result. Piggybacking saves a separate broadcast but not bytes or processing.

```
 Protocol period T' on node A:
   1. pick random member B
   2. ping B            ── piggyback: recent membership updates
   3. if no ack: ping-req(B) to k random members  (§69.11)
   4. update B's state; piggyback the change on the NEXT period's messages
   ⇒ every message does double duty: liveness probe + gossip carrier
```

Many SWIM-family implementations add a suspicion stage: a failed probe produces `suspect`, the accused may refute it, and a timer can later confirm the membership state as `dead`. Base SWIM, suspicion extensions, and Lifeguard-style local-health awareness must be labeled by protocol or product version. Even `dead` means the membership protocol has finalized removal under its rules; it does not prove physical death.

---

## 69.16 Incarnation Numbers: Refuting a False Suspicion — Core

Gossip creates a problem timeouts do not: once a false `suspect B` rumor is loose in the cluster, how does B — who is perfectly alive — **kill the rumor** before it becomes a `dead B` and evicts it? The answer is **incarnation numbers**, and they are the single cleverest detail in SWIM.

Every node owns a monotonically increasing **incarnation number**, and — the load-bearing rule — **only the node itself may increment its own incarnation.** Membership records are tagged with the incarnation they refer to, and every node resolves conflicting rumors about member m by a fixed precedence over `{state, incarnation}`:

```
 Message about member m       Typical precedence principle
 ─────────────────────────    ─────────────────────────────────────
 Alive{m, inc}                newer incarnation supersedes older state
 Suspect{m, inc}              can supersede alive at that incarnation
 Confirm/Dead{m, inc}         terminal for that membership identity
```

The refutation flow: B at incarnation 7 receives `Suspect{B, 7}`, increments its own incarnation, and disseminates `Alive{B, 8}`. Newer self-state supersedes the older suspicion. Authentication, restart identity, wraparound, and terminal-death rules are protocol concerns; an unauthenticated network cannot rely on “only B can say this” merely because the message format contains B's name.

Incarnation numbers make a provisional suspicion correctable by the accused. They are logical version metadata, not evidence that clocks agree.

---

## 69.17 Scalability Under Stated Assumptions — Deep dive

The reason SWIM and gossip detectors dominate large clusters is a hard scaling argument that interviewers love, and it is worth stating quantitatively.

**All-to-all heartbeating:** if every node monitors every other, each node handles `O(n)` peer relationships and the cluster creates `O(n²)` directed heartbeat attempts per round. Practical limits depend on payload, interval, batching, topology, and resources; detection quality does not follow from asymptotics alone.

**Sampled probing:** if each node initiates a constant number of probes per period, initiated work is `O(1)` per node and `O(n)` cluster-wide in the failure-free expectation. Receive load, retransmissions, piggyback bytes, churn, and simultaneous failures can be uneven. Detection and dissemination bounds require random target selection and assumptions about loss and scheduling.

| Property | All-to-all heartbeats | SWIM / gossip |
|---|---|---|
| Messages per node per period | O(n) | **O(1)** |
| Cluster-wide messages | O(n²) | O(n) |
| Detection time vs n | policy-dependent | expectation depends on sampling/loss |
| Dissemination latency | direct | epidemic under mixing assumptions |
| Practical ceiling | workload/network dependent | workload/network dependent |

The one-liner, with assumptions attached: all-to-all creates `O(n)` monitoring
relationships per node, while sampled probing initiates `O(1)` probes per node
per failure-free period. Receive load, retransmission, churn, and dissemination
bytes remain separate costs; gossip does not make total membership work
universally constant.

---

## 69.18 Self-Reporting and Local Health — Role-specific

Petrov points out that the whole problem can be **turned inside out**. Everything above has monitors *inferring* a node's health from the *outside* by watching for silence. But the node itself is often in a far better position to know it is unhealthy — it can see its own disk errors, its own exhausted heap, its own failed dependency, its own inability to make progress — long before an external observer's timeout fires.

So flip it: instead of others deciding a node is dead, have each node **actively announce its own liveness (and health)** to a designated collector — a **"sink"** or health registry — and let the *absence* of that self-report, plus the *content* of the reports it does send, drive the decision. Variants:

- **Self-reporting to a sink.** Each node emits periodic "I am alive and here is my health" to a coordinator (or a shared store). This concentrates the decision, and lets a node **volunteer** that it is degraded ("my disk is failing, evict me") rather than waiting to be timed out.
- **Self-demotion / self-eviction.** A node that detects it cannot make progress can stop serving or remove itself rather than waiting for external suspicion. This reduces risk but is not strong fencing: a paused process may fail to run its demotion code.

The advantage is speed and richness: a node knows its own failure *modes* (not just "silent" but "disk full," "GC-thrashing," "partitioned from the quorum") and can report a *reason*, and it can act on that knowledge before any external detector's clock runs out. The catch — and why this does not *replace* outside monitoring — is the obvious one: **a node that has truly crashed cannot report that it crashed.** Self-monitoring catches the failures a node can observe about itself; external detection is still required for the failures that silence the node entirely. Production systems combine both: self-reporting for graceful/observable degradation, external heartbeats/gossip for the hard crash the node can never announce.

---

## 69.19 Leases, Fencing, and Safe Action — Core

Failure detection decides when to attempt recovery. It does not authorize conflicting writes. A **lease** is a time-bounded grant recorded by an authority; expiry means that authority may issue a new grant. The old holder can still be paused, partitioned from the authority, and able to reach the protected resource.

**Leases and sessions.** The authority can expire lease-attached metadata without determining why renewals stopped. This is a fact about its own state, not proof that the holder stopped executing.

- ZooKeeper sessions and ephemeral nodes, and etcd leases with attached keys, provide product-specific forms of expiry. Negotiation, keepalive cadence, grace behavior, and deletion semantics must be checked against the deployed version.

**Fencing token.** Each grant carries a monotonically increasing epoch/token. Every write to the protected resource includes that token, and the resource rejects tokens older than the greatest one it has accepted:

```
grant 41 to A        resource accepts token 41
A pauses
grant 42 to B        resource accepts token 42
A resumes            resource rejects stale token 41
```

A lease alone is **not** this token. Client-side self-demotion is valuable but can be delayed by the same pause or partition that caused expiry. Strong safety needs a resource-enforced epoch, storage fencing, watchdog/power fencing, quorum protocol, or another mechanism with equivalent effect.

Patroni uses a distributed configuration store and TTL-related policy as part of PostgreSQL HA. Its configuration defaults and behavior vary by Patroni and DCS version. Losing the leader key can trigger a leadership attempt; it does not by itself prove that an old primary cannot accept writes. Evaluate the complete deployment: DCS quorum, synchronous/async replication policy, watchdog or fencing, client routing, timeline/epoch checks, and operator procedures. Chapter 70 covers leader election and split-brain prevention.

---

## 69.20 Operational Policy: Flapping, Pauses, and Tuning — Core

The gap between the clean theory above and a system that does not page you at 3 a.m. is a handful of real-world pathologies.

**Process pauses look like silence.** Stop-the-world collection, scheduler starvation, page-fault storms, hypervisor suspension, and overloaded event loops can delay heartbeat work. Measure pause distributions on the deployed runtime. A threshold below an observed healthy pause can cause false suspicion, while simply setting it above the historical maximum gives no guarantee against a future regime change.

**Flapping.** A node oscillating between suspected and alive — because it sits right at the timeout boundary, or a link is intermittently lossy — produces a storm of membership changes, each of which triggers expensive reactions (rebalancing, elections, cache invalidation). Cures: **hysteresis** (require a healthy node to stay healthy for a while before re-admitting it, and use the suspect→dead delay of §69.15), **damping** (rate-limit membership churn), and the indirect probing of §69.11 (don't accuse on one lost packet).

**Clocks.** Measure local elapsed intervals with a monotonic source rather than a wall clock subject to civil-time adjustments (Ch. 35). Distributed lease algorithms must state which clock determines expiry and any drift/delay bound used by a holder. Resource-checked fencing remains necessary when a stale holder can act after expiry.

**Tuning is choosing a point on the §69.5 curve.** Compare the consequence of false suspicion with the cost of late recovery for this action. Split-brain safety must come from coordination and fencing, not from a conservative timeout.

---

## 69.21 Choosing a Detector — Core

A decision guide, since interviews often end with "what would you use?"

| Situation | Detector of choice | Why |
|---|---|---|
| Two nodes, simple TCP link | Adaptive application timeout; keepalive as supporting signal (§69.7) | Appropriate when measured assumptions justify it |
| Want continuous model surprise | Phi accrual (§69.12) | Separates fitted signal from policy threshold |
| Sampled membership at larger scale | SWIM-family protocol (§69.15) | favorable expected scaling under its assumptions |
| Leadership attempt | Consensus/coordination protocol consuming suspicion (Ch. 70) | Detector alone cannot elect safely |
| Stale-writer exclusion | Resource-checked fencing epoch (§69.19) | Rejects an old holder after a newer grant |
| PostgreSQL HA | Versioned Patroni/DCS design plus fencing policy | Evaluate the complete deployment |

The operational pipeline is: measure liveness signals, compute local suspicion, allow correction where the protocol supports it, and feed that evidence into a separate coordination policy. Safety comes from quorum/epoch/fencing rules, not from confidence alone. Whether a deployed detector satisfies a formal class requires a proof under explicit timing and loss assumptions.

---

## Recall Card — Core

- You cannot distinguish a **crashed**, **slow**, or **partitioned** node from a single vantage point (recap Ch. 68): all three produce the identical observation "I heard nothing." Failure detection is therefore inherently a **suspicion, not a fact**.
- A failure detector is an **unreliable local oracle** that can falsely suspect a correct process or detect a crash late. Safety survives only when the consuming protocol does not trust suspicion as authorization.
- Chandra–Toueg formalize detectors via **completeness** and **accuracy**, with strong, weak, and eventual variants. The general weakest-detector result for consensus is associated with eventual leadership (`Ω`).
- A **Perfect (P)** detector is impossible in a purely asynchronous system. Eventually perfect behavior requires explicit stabilization and adaptation assumptions.
- There is a **three-way tension** among detection time, mistake rate, and completeness; shorter timeouts detect faster but flap more. Every technique bends this curve inward without escaping it.
- **Timeouts** are the crude baseline; **adaptive timeouts** (EWMA of RTT + variance, à la TCP) and **phi-accrual** improve on them.
- **Phi accrual** outputs `φ = −log₁₀(P_model(T > t))`, a model-derived tail surprise. It is not a calibrated probability of death or false conviction.
- **SWIM-family protocols** combine sampled probing, indirect probes, membership dissemination, suspicion, and incarnation-based refutation. Scaling claims require random-mixing, loss, churn, and retransmission assumptions.
- **Reversing** the problem: nodes **self-report** health to a sink and **self-fence**, catching failures they can observe about themselves — but a truly crashed node cannot announce it, so external detection remains necessary.
- A **lease** expires authority state; it is not itself a fencing token. A protected resource must reject stale epochs, or an equivalent external fencing mechanism must stop an old holder.
- Runtime pauses, overload, and correlated loss masquerade as failure. Use monotonic elapsed time, replay healthy traces, inject failures, and tune from the costs of false suspicion and slow detection.

---

### Reasoning Questions

1. Why are crash, delay, overload, and partition indistinguishable from one observer before a message arrives?
2. Define strong completeness, strong accuracy, and eventual strong accuracy.
3. Draw the detection-delay/false-suspicion tradeoff for heartbeat interval, missed-beat count, and timeout.
4. What does `φ = 8` mean mathematically, and what does it **not** establish operationally?
5. How do direct probes, indirect probes, suspicion, and incarnation refutation interact in a SWIM-family protocol?
6. Which assumptions are required for `O(1)` expected per-node probing and epidemic dissemination claims?
7. Why can a lease expire while its former holder continues acting, and how does resource-checked fencing fix that?
8. Which measurements would justify changing a detector threshold in production?
---

### Code-Reading Puzzle

Heartbeat period is 1 s. A monitors B with a 2.5 s timeout. B's healthy heartbeat arrival times at A are:

```
1.0, 2.1, 3.0, 6.0, 7.0, 8.1 seconds
```

At 5.6 s, A suspects B; at 6.0 s, the next heartbeat refutes the suspicion. Draw the timeline and answer:

- What were detection latency and mistake duration?
- Which events could produce the 3-second gap without a crash?
- Would two independent paths actually be independent in each case?
- Which actions are safe to take on suspicion alone, and which require quorum or fencing?

Then suppose B really crashes immediately after 8.1 s. Compute the earliest timeout suspicion. Explain why this calculation is deterministic while the correctness of the suspicion is not.

### Applied Exercise

Extend the phi calculation in §69.13 into a trace-replay tool:

1. Read timestamped heartbeat arrivals and known healthy/crash intervals.
2. Fit a bounded rolling history with configurable minimum variance.
3. Emit `φ` at fixed decision instants for several thresholds.
4. Report healthy threshold crossings, mistake durations, and crash detection delays.
5. Preserve trace order, then compare with a shuffled trace to expose the effect of correlated bursts.
6. Inject a sudden latency-regime change and graph how quickly the estimator adapts.

Do not interpret `10^-φ` as the measured false-positive rate. Compare it with the empirical rate and explain the mismatch.

### Prerequisites for Chapter 70

You should be able to distinguish observation from suspicion, state completeness and accuracy assumptions, compute a phi value, trace SWIM suspicion/refutation, and explain why a lease without resource-checked fencing permits a stale actor. Chapter 70 uses these signals to drive election attempts and establishes leadership safety separately.

---

## 69.22 Common Traps — Core

- **Saying "the node is dead" instead of "the node is suspected."** A detector never establishes death; it establishes that it stopped waiting. Confident language about a fact you cannot observe is the core conceptual error.
- **Proposing a single fixed timeout and stopping there.** A static Δ cannot be both fast and quiet over a wide, fat-tailed latency distribution, and it is wrong the moment load shifts. The real answer is adaptive timeouts or accrual.
- **Claiming a perfect (never-wrong) detector is achievable with a big enough timeout.** It is provably impossible in an asynchronous system; you can only approximate Eventually Perfect (◇P). A bigger timeout just moves you along the curve, trading detection time for accuracy.
- **Confusing completeness with accuracy.** Suspecting everyone is perfectly complete and useless; suspecting no one is perfectly accurate and useless. The whole difficulty is getting both, and asynchrony forbids getting both perfectly.
- **Treating φ as a calibrated mistake probability.** `10^-φ` is a tail area under the fitted model, not a measured probability of death or false conviction.
- **Forgetting that a GC pause is indistinguishable from a crash.** A multi-second stop-the-world pause freezes heartbeats; if your conviction threshold is below the worst pause, you evict healthy nodes on every collection and can cascade.
- **Believing gossip/SWIM eliminates false positives.** Indirect probes and refutation can reduce some mistakes, while correlated loss and pauses remain.
- **Ignoring all-to-all scaling.** It creates `O(n²)` directed relationships per round; whether that is acceptable depends on cluster size and implementation.
- **Treating a raw failure detector as safe authorization.** Suspicion can trigger an attempt; quorum/epoch rules and resource-checked fencing protect the action.
- **Measuring heartbeat intervals or lease TTLs with wall-clock time.** An NTP step can instantly expire or extend everything; interval-based liveness must use a monotonic clock.
- **Calling a lease a fencing token.** Expiry does not stop a paused holder from resuming; the protected resource must reject an older epoch or equivalent external fencing must intervene.
- **Setting one detector threshold for the whole fleet.** The right detection-time-vs-stability point depends on the cost of a false positive for *that* workload — a payments primary and a cache tier want opposite settings.
