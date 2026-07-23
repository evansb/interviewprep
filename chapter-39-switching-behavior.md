# Chapter 39 — Switching Behavior

## 39.0 Why This Changes the Decision — Core

An Ethernet switch is not a fixed-delay cable. It learns forwarding state,
classifies frames, moves them through a finite-capacity fabric, and serializes
them onto shared egress links. With no contention, pipeline behavior dominates.
During a burst, the egress service rate and available queue dominate. During a
failure, control-plane convergence, hash remapping, flooding, and stale state can
dominate.

The useful interview model is therefore:

```
ingress → parse/classify → learn/lookup → fabric/replicate
        → select egress queue → schedule → serialize → link
```

Chapter 36 owns Ethernet frame fields and packet-rate arithmetic. Chapter 37
owns multicast transport and IGMP behavior. Chapter 46 owns the Linux packet
path. Chapter 53 owns A/B feed arbitration, gap recovery, and snapshot
correctness. This chapter introduces only the switching behavior those owners
consume.

### Claim labels

- **[Protocol]** follows an IEEE/IETF protocol definition.
- **[Architecture]** is a design property such as input queueing or cut-through,
  not a guarantee of every product using that label.
- **[Switch/vendor]** depends on ASIC, line card, firmware, or feature set.
- **[Configuration]** is an operator-selected policy: VLAN membership, hash,
  trust boundary, queue mapping, scheduler, thresholds, or timers.
- **[Measured]** requires the exact topology, frame mix, offered load, switch
  version/configuration, timestamp points, sample count, and distribution.

---

## 39.1 90-Second Screen — Core

Five facts:

1. A bridge learns a source MAC on the ingress port and looks up the destination
   in a forwarding database scoped by VLAN/bridge domain. Unknown unicast,
   broadcast, and some multicast are replicated or flooded only within that
   domain, subject to control-plane and security features.
2. Store-and-forward waits for the complete frame before eligible forwarding;
   cut-through may start after enough header has arrived. Product features,
   speed changes, congestion, path through the chassis, and errors determine the
   mode actually observed.
3. Serialization is `bits / egress_rate`; propagation is `distance /
   propagation_speed`; unloaded processing is a device-path property; queueing
   is `bytes_ahead / egress_byte_rate`. Queueing is the variable term.
4. A microburst overflows a queue when accumulated arrivals minus departures
   exceed available buffer. Low long-window utilization does not constrain a
   short-window burst.
5. LAG/ECMP usually preserves a flow on one member/path, but hashing,
   membership changes, unequal paths, or per-packet policies can create
   imbalance and reordering. Never infer physical disjointness from logical
   redundancy.

Two decisions to defend:

- **Can this egress absorb the burst?** State arrival shape, drain rate, initial
  occupancy, usable queue limit, scheduling class, and required loss/delay
  outcome.
- **What evidence identifies the hop?** Correlate per-queue occupancy/drop/pause
  counters, member utilization, forwarding state, and timestamped packets.
  Average port utilization and a datasheet latency are insufficient.

---

## 39.2 A Frame’s Journey: VLAN, Learning, and Forwarding — Core

A Layer-2 switch is a multiport bridge. For an ordinary data frame it performs
three logically separate operations:

1. determine the ingress bridge domain/VLAN and whether the frame is admissible;
2. learn or refresh the source MAC's location;
3. look up the destination and choose zero, one, or several egress ports.

```
frame from port 3, VLAN 120
  source 02:aa:... ──> learn FDB[(120, 02:aa:...)] = port 3
  destination 02:bb:...
      ├─ known unicast ──> one selected egress
      ├─ local/control ──> switch CPU/control pipeline
      └─ unknown/broadcast/multicast ──> replication set in VLAN 120
```

**[Protocol]** A VLAN identifies a Layer-2 broadcast domain. **[Switch/vendor]**
hardware commonly keys forwarding entries by `(VLAN or bridge-domain, MAC)`,
not MAC alone. The same MAC can therefore be learned in different VLANs.

### Access, trunk, and tag handling

An ingress port maps untagged or tagged traffic into a VLAN according to port
mode and policy. Egress policy decides whether the transmitted frame is tagged.
Terms such as access, trunk, native VLAN, allowed VLAN list, QinQ, and VLAN
translation are vendor/configuration interfaces around that model.

Two correctness traps follow:

- An unintended native/untagged VLAN mismatch can place a frame in a different
  bridge domain at the far end.
- Allowing a VLAN on one trunk but not the return path creates asymmetric
  reachability that resembles stale FDB state.

Verify effective ingress classification and egress membership on both ends,
including MLAG peers or chassis line cards. Do not diagnose VLAN behavior from a
server's tag alone.

### MAC learning, movement, and aging

**[Architecture]** Dynamic learning observes a valid source MAC and associates
it with the ingress logical port. A later frame from that source refreshes the
entry. If the source appears on a different port, the entry moves; rapid moves
can indicate a host migration, active/active attachment, a Layer-2 loop,
mis-cabling, or spoofing.

Dynamic entries age after inactivity. Aging time, learning limits, sticky/static
entries, move dampening, port security, EVPN control-plane learning, and
hardware/software table placement are configuration/product facts. After an
entry ages, the next destination lookup may be unknown and flooded until the
source is relearned. “The FDB always contains every active host” is not a
protocol guarantee.

| Event | Forwarding consequence | Evidence |
|---|---|---|
| destination known and port forwarding | unicast to selected port | FDB entry plus VLAN/port state |
| destination unknown/aged | flood within eligible domain | unknown-unicast counters, FDB age/event |
| source moves | later traffic changes egress | MAC-move log and topology |
| egress blocked/down | drop or alternate control-plane result | STP/LAG state and discard reason |
| table/resource limit | flood, trap, reject, or software path by product | capacity/alarm/resource counters |

Unknown-unicast flooding can multiply traffic and expose frames to ports that
were not expected to receive them. Security and scale designs may suppress it,
but suppression then converts missing forwarding state into a drop. State the
chosen failure policy.

### Forwarding state is eventually applied

The control plane and data plane are not one atomic table. A bridge process,
EVPN controller, STP instance, LAG manager, or operator changes desired state;
hardware then programs one or more ASIC tables. **[Switch/vendor]** Programming
can be incremental across chips/line cards. During a transition, different
ports may briefly use old and new state, and queued frames retain decisions
already made.

When diagnosing a transient, preserve:

- the control-plane event and its timestamp;
- the programmed hardware entry, not only the controller's desired entry;
- VLAN/bridge-domain and logical-port identifiers;
- whether the entry was dynamic, static, remote, or locally learned;
- table/resource programming failures;
- ingress and egress packet timestamps around the change.

“The route/FDB was correct when I checked later” does not explain the failure
window. Conversely, one flooded frame after a long idle may be expected aging
behavior, not evidence of a loop.

Learning is also an attack surface. Source-MAC churn can exhaust table capacity
or force useful entries to age, while spoofing can redirect traffic. Port
security, learning limits, control-plane learning, storm control, and unknown
unicast policies constrain the blast radius, but each changes failure behavior:
an overload may become flooding, trapping, logging, or dropping. Capacity and
security settings belong in the topology artifact.

---

## 39.3 Forwarding Modes and the Latency Equation — Core

### Store-and-forward

**[Architecture]** A store-and-forward path receives the complete frame before
starting egress transmission. It can validate the received FCS before
forwarding and naturally handles a pipeline that requires complete-frame state.
Its earliest forwarding time includes full ingress serialization:

```
t_start_egress ≥ frame_bits / ingress_rate + processing/fabric eligibility
```

Complete-frame buffering does not imply a particular total buffer depth,
scheduler, or product latency.

### Cut-through

**[Architecture]** A cut-through path becomes eligible to transmit after enough
header bytes have arrived to make the required forwarding/classification
decision. In an idle, compatible path, ingress reception and egress transmission
overlap. The switch cannot know the received FCS before it has already forwarded
part of the frame; how it marks, truncates, counts, or propagates a late-detected
error is product-specific.

Cut-through is not “never buffer.” A busy egress queues the frame. A speed
change may require an initial threshold or complete buffering to avoid egress
underrun/overflow, depending on direction, frame size, and implementation.
Cross-chip traversal, mirroring, ACL/tunnel features, timestamping, or congestion
can select a different internal path. Measure the configured feature set.

| Question | Store-and-forward | Cut-through |
|---|---|---|
| When can egress begin? | after complete frame | after sufficient header/pipeline state |
| FCS known before forwarding? | can be | no |
| unloaded latency vs frame length | includes full ingress serialization | may be largely header/path dependent |
| contention behavior | queues | also queues |
| speed/feature support | generally flexible | product/path dependent |

“Fragment-free” historically waits for an initial minimum-frame region before
forwarding. The term may still appear in product documentation; its exact
behavior must be verified rather than inferred from the name.

### Four latency terms

For one hop, keep costs separate:

```
t_hop =
    t_ingress_required       // full frame or header threshold
  + t_processing_and_fabric  // lookup, arbitration, internal path
  + t_queue                  // variable backlog/scheduler delay
  + t_egress_serialization   // frame occupancy on egress
  + t_propagation            // medium length / propagation speed
```

The terms can overlap in a pipeline, so blindly adding each full duration can
double-count. Define timestamp points: first-bit-in to first-bit-out,
last-bit-in to first-bit-out, or complete-frame-to-complete-frame.

### Serialization and propagation

At MAC line rate `R` bits/s:

```
serialization_seconds = on_wire_bits / R
propagation_seconds   = path_length / medium_velocity
queue_seconds         = on_wire_bits_ahead / R
```

Chapter 36 owns what bytes count as Ethernet frame versus preamble/SFD and
interpacket gap; Chapter 48 owns wire-rate calculations. For one bounded
example, a 1,518-byte Ethernet frame plus 8 bytes preamble/SFD and 12 bytes
interpacket gap occupies 1,538 byte-times. At 10 Gb/s:

```
1,538 × 8 / 10,000,000,000 = 1.2304 microseconds
```

This is arithmetic, not a switch-latency claim. VLAN tags, physical coding,
frame preemption, rate, and timestamp convention must match the actual link.
Propagation velocity depends on medium; use cable/optic specifications or a
measured calibrated path rather than a universal nanoseconds-per-metre constant.

An urgent frame can also wait for the frame currently being serialized.
Without applicable frame preemption, residual blocking ranges from almost zero
to nearly one maximum-frame serialization time. MTU policy therefore changes a
strict-priority queue's worst non-preemptive blocking, but “jumbo frames are
always wrong” ignores throughput, CPU, and storage-network requirements.

### Speed changes and timestamp conventions

Consider ingress at `Ri` and egress at `Ro`:

- `Ri == Ro`: once cut-through starts, ingress and egress can advance together
  if the internal path keeps pace.
- `Ri > Ro`: the frame's tail arrives faster than it departs, so occupancy grows
  even with cut-through.
- `Ri < Ro`: egress can catch the arriving tail and underrun unless the switch
  waits for enough data; the threshold can approach full-frame storage.

This explains why “any speed mismatch forces store-and-forward” and “a
cut-through switch is always frame-size independent” are both too broad.
Products may advertise a mode per port pair, speed combination, feature, or
chassis path.

Latency specifications also choose favorable timestamp points. Examples:

| Convention | Starts | Ends | What it includes |
|---|---|---|---|
| first-bit to first-bit | first ingress bit | first egress bit | forwarding start, not full delivery |
| last-bit to first-bit | complete ingress frame | first egress bit | can make cut-through appear negative without careful definition |
| first-bit to last-bit | first ingress bit | complete egress frame | includes egress serialization |
| host send to host receive | application/NIC boundary | application/NIC boundary | adds NIC, host, cable, and possibly clocks |

Compare devices or configurations only with the same convention, frame size,
rate, ingress/egress ports, and offered load. Hardware timestamp accuracy and
clock synchronization are Chapter 48/35 concerns.

---

## 39.4 Fabrics, Queues, and Head-of-Line Blocking — Core

A switch ASIC/chassis must move frames from ingress ports to egress queues.
Designs combine input buffering, output buffering, shared memory, crossbars,
central fabrics, line-card fabrics, and internal speedup.

### Pure input queueing

With one FIFO per ingress, its first frame can be blocked by a busy egress while
frames behind it target idle egresses:

```
input FIFO: [to busy E1][to idle E2][to idle E3]
              blocks head └──── both wait: HOL blocking
```

This is classic **switch head-of-line (HOL) blocking**. It is not TCP's
in-order-delivery HOL blocking.

### Virtual output queues and matching

An input-queued switch can maintain a **virtual output queue (VOQ)** for each
possible egress. A scheduler matches ingress/egress pairs each fabric timeslot,
so a blocked E1 queue does not prevent the same ingress serving E2. The arbiter,
fabric speedup, multicast, priorities, and fairness determine achieved
throughput and latency; VOQ is not a promise of zero blocking.

### Output and shared queues

An ideal output-queued design accepts simultaneous arrivals for each egress,
which may require internal memory bandwidth/speedup greater than line rate.
Practical ASICs use combinations of ingress admission, shared cells, VOQs, and
egress queues.

**[Switch/vendor]** Packet memory is often cell-based. A frame consumes rounded
cells plus metadata, so “buffer bytes” from a datasheet are not equal to usable
payload for every frame mix. Shared-buffer admission may include:

- per-port/per-queue reserved minimums;
- a shared pool governed by dynamic thresholds;
- lossless/PFC headroom;
- multicast replication accounting;
- limits for a queue, port, traffic class, or service pool.

A congested queue can therefore drop before total chip memory is exhausted, or
consume shared capacity and harm another port. Diagnose the actual admission
rule and occupancy unit.

### Residual HOL behavior

Even with VOQ, a frame can wait behind:

- an already-transmitting non-preemptible frame;
- older frames in the same egress/traffic-class queue;
- strict-priority traffic;
- a paused PFC priority;
- fabric arbitration or oversubscription;
- replication/resources shared with a congested multicast destination.

The phrase “non-blocking switch” usually describes a fabric capacity condition,
not absence of queues, HOL effects, or drops under arbitrary many-to-one load.

### Fabric and queue questions to ask

An interview-quality comparison avoids declaring one architecture “fastest.”
Ask:

| Axis | Why it changes behavior |
|---|---|
| same-ASIC vs cross-ASIC/line-card path | extra fabric hops, credits, buffering, and replication |
| internal speedup | determines whether simultaneous ingress can reach egress memory |
| cell size and memory bandwidth | controls rounding waste and peak enqueue/dequeue capacity |
| ingress admission vs egress admission | determines where drops/counters appear |
| shared vs dedicated buffer | couples or isolates congested ports/classes |
| unicast vs multicast | replication can consume descriptors/cells/fabric bandwidth differently |
| scheduler hierarchy | port, group, class, and queue arbitration can each add waiting |
| backpressure/credits | internal congestion can stop upstream pipeline stages |

Some chassis use virtual output queues at ingress line cards and credits from
egress line cards. If an egress card stalls, credits stop and frames accumulate
at ingress. A counter labelled “input discard” can therefore be caused by an
egress bottleneck elsewhere. Follow the credit/queue topology instead of
assuming counter direction identifies root cause.

Multicast can introduce another coupling. An implementation might retain a
shared payload until all replication descriptors are admitted, or let each
egress proceed independently. A slow destination might consume shared cells,
block only its replica, or affect the whole replication operation. All are
plausible designs; test the product under one congested subscriber rather than
asserting universal fan-out behavior.

Queue counters are often not one-to-one with physical memories. A displayed
“egress queue” may aggregate multiple hardware queues, report only sampled
watermarks, or exclude internal fabric/replication buffers. Vendor telemetry
documentation is part of the measurement contract.

---

## 39.5 Output Contention and Microbursts — Core

When arrivals to one egress exceed service, occupancy evolves as:

```
Q(t1) = max(0, Q(t0) + arrival_bytes(t0,t1) - departed_bytes(t0,t1))
queue_delay_for_new_tail ≈ Q / egress_byte_rate
drop when admission cannot allocate required cells/credits
```

If aggregate arrival rate is `Rin > Rout` for duration `T`, the idealized backlog
increase is:

```
ΔQ = (Rin - Rout) × T
```

Use consistent bits/bytes and include frame overhead when modeling line
occupancy. Real switches allocate discrete cells, reserve headroom, and schedule
classes, so the equation is a lower-level workload model, not the final buffer
threshold.

A **microburst** is simply a short interval whose arrival shape overloads an
egress or internal resource. It has no universal duration. Long-interval
utilization can remain low:

```
arrival
rate       ███       ████
Rout ──────┼─┼───────┼──┼────────
           └─ queue grows where arrival > Rout
time ──────────────────────────────>
```

Sources include synchronized senders, fan-in/incast, market events, speed
step-down, sender batching/offloads, replication, and traffic released after a
pause. Chapter 46 owns host offload/coalescing mechanisms.

### Worked microburst calculation

Four 25 Gb/s ingress sources simultaneously offer full-rate traffic for
50 microseconds to one 25 Gb/s egress. Assume all traffic maps to one queue,
initial occupancy is zero, and ignore cell rounding:

```
Rin  = 4 × 25 = 100 Gb/s
Rout = 25 Gb/s
ΔQ   = (100 - 25) Gb/s × 50 µs
     = 3,750,000 bits
     = 468,750 bytes
```

If the queue can admit only 384 KiB under the current shared-buffer state,
idealized excess is about 75 KiB and some frames drop. If it could admit the
whole 468,750 bytes, the last byte's queueing delay at 25 Gb/s would be:

```
468,750 × 8 / 25,000,000,000 = 150 microseconds
```

The buffer did not remove congestion; it selected delay instead of loss. A real
calculation must add initial occupancy, wire overhead, cell rounding, concurrent
queues, scheduler service, headroom, and the switch's admission thresholds.

Compact C++23 arithmetic:

```cpp
#include <cassert>
#include <cstdint>

struct Burst {
    std::uint64_t backlog_bytes;
    std::uint64_t drain_nanoseconds;
};

constexpr Burst burst(std::uint64_t in_bps,
                      std::uint64_t out_bps,
                      std::uint64_t duration_ns) {
    if (in_bps <= out_bps) return {0, 0};
    const auto excess_bits = (in_bps - out_bps) * duration_ns / 1'000'000'000;
    const auto bytes = (excess_bits + 7) / 8;
    return {bytes, bytes * 8 * 1'000'000'000 / out_bps};
}

int main() {
    constexpr auto r = burst(100'000'000'000, 25'000'000'000, 50'000);
    static_assert(r.backlog_bytes == 468'750);
    static_assert(r.drain_nanoseconds == 150'000);
}
```

The multiplication can overflow for untrusted/general values; a production
calculator should use checked arithmetic or a wider intermediate.

### Detecting a microburst

Average SNMP/telemetry counters may miss short occupancy. Prefer, in descending
specificity:

1. per-queue occupancy watermark/histogram or threshold event;
2. per-queue enqueue/discard/ECN/pause counters with fine timestamps;
3. hardware-timestamped ingress/egress capture to reconstruct arrivals/service;
4. port counters and host gaps/drops for correlation.

A drop counter is lagging evidence; a rising queue watermark shows latency
before loss. Counter width, clear-on-read behavior, polling interval, sampling,
and shared-pool units are product facts.

### Incast and burst synchronization

**Incast** is many senders converging on one receiver/egress, often because one
request releases synchronized responses. Even if every sender obeys its own
rate limit, their phases can align. The key parameters are fan-in, response
size, sender pacing, egress rate, round-trip/control feedback, and buffer.

For TCP, drops/ECN alter sender congestion state; Chapter 38 owns those
mechanics. For UDP, there may be no sender feedback at all. A larger queue can
make the incast appear lossless while delaying every response behind the burst.
An application timeout can then synchronize retries and amplify the next burst.

Mitigation entries should be conditional:

| Change | Condition | Benefit | Cost / rollback | Verify |
|---|---|---|---|---|
| faster/more egress capacity | legitimate peak exceeds service | reduces backlog slope | capacity/cabling cost; restore topology only via change plan | same burst has lower occupancy/loss |
| sender pacing/desynchronization | controllable sources create synchronized burst | spreads arrivals | increases completion time; disable pacing | arrival histogram smooths without missed deadline |
| separate queue/port/path | unrelated traffic contends | isolates service | more resources; possible new bottleneck | per-queue/path contention moves as predicted |
| admission/policing | excess traffic may be rejected | protects bounded critical load | deliberate loss; restore policy | protected class meets target and drops are attributable |
| buffer increase | finite burst must survive and delay is acceptable | absorbs transient | larger tail/footprint; restore threshold | no loss and queue delay remains within contract |
| ECN/AQM | responsive endpoints and standing queue | signals congestion before overflow | endpoint/tuning dependency; restore thresholds | marks drive response and reduce occupancy |

Apply one change to the same burst distribution. “No drops” is not success if
latency moved beyond the business deadline or throughput fell.

---

## 39.6 Shallow, Deep, and Dynamic Buffers — Core

“Shallow” and “deep” are relative to burst size and drain rate, not stable
product categories. Convert usable bytes to **drain time at the congested
egress**:

```
buffer_time = usable_queue_bits / egress_rate
```

A large buffer can absorb a transient fan-in without loss. It also permits a
larger standing queue and therefore a larger worst delay. A small buffer bounds
stored backlog more tightly but drops earlier. Neither is universally correct.

| Workload condition | Buffer can help | Buffer can hurt |
|---|---|---|
| transient burst followed by idle drain | masks loss/retransmission | adds bounded delay |
| sustained overload | delays inevitable loss | hides overload and builds stale work |
| throughput-oriented TCP/storage | avoids costly loss/recovery | creates bufferbloat if senders do not respond |
| time-sensitive UDP | may cover tiny bursts | stale delivery can be worse than explicit loss |
| mixed priorities | protects a class with reservation | shared pool can couple unrelated classes |

For market feeds, business semantics decide whether delayed data or a detectable
gap is preferable. Chapter 53 owns A/B selection and recovery; do not assume a
second feed makes drops free or independent.

Mitigations should target the mechanism:

- add egress capacity or reduce oversubscription;
- separate incompatible traffic/ports/queues;
- pace or desynchronize sources;
- correct classification/scheduling/admission;
- bound offered load with policing where dropping is the intended policy;
- add buffer only when the required burst envelope and acceptable delay justify
  it.

A **shaper** queues traffic to enforce a rate and intentionally adds delay. A
**policer** drops or remarks traffic beyond a contract. Neither is inherently
correct for a hot path; state whether the goal is smoothing, protection, or
admission.

### Translate datasheet buffer into usable burst budget

A defensible estimate walks through:

1. total physical packet memory;
2. memory assigned to the relevant service pool/slice;
3. reserved minima and PFC headroom for all active ports/classes;
4. dynamic-threshold share available at the current pool occupancy;
5. per-queue/per-port caps;
6. cell rounding and metadata for the actual frame-size mix;
7. multicast/shared-copy accounting;
8. occupancy already present when the burst begins.

Only the remainder is available to the target queue. If the switch reports cells
rather than bytes, multiply by the documented cell size and account for how a
frame spans cells. A 65-byte frame can consume two cells on one architecture;
another architecture can pack or account differently.

Dynamic threshold schemes often let a queue consume a fraction of remaining
shared space, not a fixed byte amount. Two identical bursts can therefore have
different results when unrelated queues are active. This is why a successful
isolated-port lab test does not qualify the shared production workload.

Buffer occupancy also needs a time axis. A queue reaching 200 KiB for one sample
could be rising, draining, or aliased by polling. Hardware watermarks reveal the
maximum since last reset but not duration; threshold events or in-band telemetry
can supply a timeline. Pair occupancy with enqueue/dequeue rate and exact
counter-reset semantics.

---

## 39.7 Classification, QoS, and Multicast Delivery — Core

### From markings to queues

**[Protocol]** VLAN PCP supplies three priority bits; IP DSCP supplies a larger
Layer-3 marking space. **[Configuration]** A switch decides whether to trust,
rewrite, or ignore those markings, maps them to internal traffic classes/queues,
and selects scheduling/drop behavior.

```
PCP/DSCP/port/ACL
      ↓ classify
internal traffic class
      ↓ queue map
egress queue
      ↓ scheduler + admission/drop/mark
wire
```

End-to-end QoS fails if any hop maps differently. Verify at each trust boundary:
ingress classification, internal class, egress rewrite, queue counters, and
scheduler.

| Policy | Mechanism | Benefit | Failure mode |
|---|---|---|---|
| strict priority | always serve highest eligible queue | protects one class from queued lower classes | starvation; still blocked by in-flight frame/higher class |
| weighted/deficit round robin | allocate service by weights/deficits | shares bandwidth across active classes | cycle/quantum adds delay; weights may not match burst |
| tail drop | reject at limit | simple bounded occupancy | synchronized losses; no early signal |
| WRED/AQM | probabilistic/managed early action | signals before full queue for suitable congestion control | thresholds/model can harm short bursts |
| ECN marking | mark instead of drop when endpoints react | end-to-end congestion signal | useless if transport/application ignores marks |

QoS protects service only while higher-priority offered load fits capacity.
Strict priority cannot manufacture bandwidth and can starve control,
recovery, or operational traffic needed for liveness.

### A QoS configuration is an end-to-end state machine

For one test packet, write a worksheet:

```
ingress port/VLAN
  → observed PCP/DSCP
  → trust or ACL classifier
  → internal class/drop precedence
  → egress queue
  → queue admission/WRED/ECN threshold
  → scheduler level and weight/priority
  → egress marking
```

Then generate packets for every intended class and confirm queue counters move.
A policy name in the configuration database is not evidence that the hardware
entry was installed or attached to the correct port direction.

Strict priority has a useful local bound only under assumptions: the high queue
has bounded load, no higher queue interferes, and frames are not preempted. A
new high-priority frame can still wait for the currently transmitting frame.
If high-priority input remains above egress capacity, its own queue grows and
lower queues receive no service. Reserve minimum bandwidth or watchdog traffic
for recovery/control paths that keep the critical service alive.

WRED thresholds expressed in bytes, cells, packets, percentages, or time are
not interchangeable. ECN marking needs an ECN-capable transport/controller; a
UDP market feed that ignores ECN does not slow merely because a switch marks it.
Policing/remarking may also change which downstream queue the packet enters.

### Multicast replication

**[Architecture]** A switch derives an egress replication set from VLAN state,
multicast control state (for example IGMP snooping), and policy. Unknown
multicast may be flooded, suppressed, or sent to a router/control path according
to configuration.

Payload storage, replication descriptors, fabric copies, and egress enqueue
order are ASIC/chassis details. Do not claim all subscribers receive equal or
simultaneous copies. Different egress queue occupancy, port rate, line-card path,
and replication order create skew. A Layer-1 fan-out device has a different
electrical/optical replication model, but output latency equality and skew are
still product specifications to measure, not properties implied by “Layer 1.”

Broken/missing snooping state can turn subscribed delivery into flooding or
drops. Correlate group membership/querier state, replication entries, per-port
traffic, NIC filters, and host receive counters. Chapter 37 owns IGMP join and
transport semantics.

---

## 39.8 LAG, ECMP, Hashing, and Reordering — Core

**LAG** combines Layer-2 links into one logical link. **ECMP** selects among
equal-cost Layer-3 next hops. Both commonly hash selected packet fields to keep
a flow on one member/path:

```
member = configured_hash(extracted_fields, seed) → bucket/member table
```

**[Switch/vendor/configuration]** Extracted fields can include MAC/VLAN,
ethertype, IP addresses, protocol, transport ports, MPLS labels, tunnel outer
or inner headers, and symmetric-hash transformations. The algorithm, seed,
bucket table, resilient hashing, and fallback for fragments/non-IP packets vary.

Consequences:

- One ordinary flow is usually limited to one member's service rate; aggregate
  bandwidth appears across many sufficiently diverse flows.
- A few elephant flows can collide on one member while other members are idle.
- Identical low-entropy flow keys can polarize multiple stages.
- Adding/removing a member can remap flows. Resilient/consistent schemes aim to
  limit remapping but do not promise zero reordering.
- Per-packet load balancing can use all paths for one flow but exposes it to
  delay differences and reordering.

Packet ordering can also change because parallel internal paths, a link/member
failure, unequal serialization/queueing, routing convergence, or receiver-side
processing changes. Ethernet provides no end-to-end in-order guarantee across
arbitrary topology changes.

For TCP, reordering may trigger duplicate acknowledgments/retransmission and
congestion responses; Chapter 38 owns that state machine. For sequenced UDP,
measure reorder depth and lateness separately from loss; Chapter 53 owns feed
reorder/gap policy.

### Worked ECMP diagnosis

Symptom: eight links show 35% average utilization, yet one flow loses packets
and its selected member reaches line rate during bursts.

1. Confirm member-specific fine-grained utilization/drop/queue counters; the
   bundle average is not the service rate seen by the flow.
2. Capture the affected flow's actual outer and inner headers. Determine which
   fields the configured ASIC/firmware hashes for that packet type.
3. Query or simulate the hash/bucket-to-member mapping with the vendor-supported
   tool. Verify both directions; symmetric routing is not implied.
4. Check whether a recent member state change rebalanced buckets and whether
   packets reordered during convergence.
5. Compare other elephant keys for collision/polarization. More physical links
   do not help a single per-flow-hashed elephant.
6. Choose a mechanism-specific remedy: diversify flow keys where protocol
   permits, redistribute elephants, increase member rate, alter a validated hash
   profile/seed, or avoid ECMP on the critical flow. Do not enable per-packet
   hashing without accepting reorder semantics.

Success means member occupancy and end-to-end loss/latency improve under the
same flow/burst distribution, with no new reordering or path-disjointness
failure.

### Hash changes are state transitions

The simplest conceptual mapping `hash % N` remaps many buckets when `N`
changes. Production switches often use an indirection table: hash selects a
bucket, and the bucket points to a member. **Resilient hashing** tries to
reassign only buckets that used a failed/removed member. Exact balancing and
update atomicity remain product-specific.

During a member failure, packets already queued on the old member may depart
after newer packets sent on the replacement, or be dropped while later packets
succeed. Control-plane withdrawal, hardware bucket programming, and remote-hop
convergence need not be simultaneous. Per-flow hashing preserves ordering only
while a stable flow maps to a stable path with stable delays.

Hash evidence must use the packet as seen at the hashing stage. Tunnels can make
all outer headers identical unless inner-field hashing is enabled; fragments may
lack transport ports; NAT can change keys between directions; symmetric hashing
can normalize address/port order. A vendor's generic “5-tuple” statement is not
enough for these cases.

For redundancy, two logical paths can still share a physical member because
their hashes collide or a failure converges them. Validate link, device, line
card, conduit, and upstream fate sharing. Chapter 53 applies this physical
evidence to A/B feed correctness.

---

## 39.9 Ethernet Flow Control and PFC — Specialist

**[Protocol] 802.3x PAUSE** is link-local flow control. A receiver requests that
its directly connected peer pause transmission for a number of pause quanta.
It stops the link's traffic rather than one transport flow. Whether a NIC/switch
generates, honors, forwards, or counts PAUSE depends on negotiation and
configuration.

PAUSE can prevent immediate buffer overflow but propagates backpressure to
unrelated traffic on that link. On a latency path it may convert a downstream
congestion event into an upstream stall. Do not prescribe “always off” without
checking whether the network relies on lossless behavior; do not leave it on
without pause-counter alarms and a congestion plan.

**[Protocol] Priority Flow Control (PFC, IEEE 802.1Qbb)** applies pause state to
selected priorities. It is used in some lossless Ethernet/RDMA designs.

PFC introduces specialist failure modes:

- **congestion spreading:** unrelated flows in the same priority stall upstream;
- **PFC deadlock:** cyclic buffer/channel dependencies can remain mutually
  paused;
- **headroom consumption:** each port/priority reserves capacity for data still
  in flight after pause generation;
- **priority mismatch:** inconsistent PCP→priority/PFC mapping breaks the
  lossless design;
- **pause storms:** a receiver or fault propagates widespread backpressure.

Headroom depends on link rate, cable/path propagation, device reaction,
pipeline, maximum in-flight frames, and safety margin. It is not a universal
byte constant. Watchdogs that force progress by dropping paused traffic are
vendor/configuration mechanisms and deliberately exchange losslessness for
liveness.

ECN/end-to-end congestion control can reduce reliance on hop-by-hop pause, but
only if queues mark appropriately and endpoints respond. Chapter 47 owns RoCE
and bypass design.

---

## 39.10 Redundancy, Loops, and Failure Behavior — Core

### Why Layer-2 loops are destructive

Ethernet frames have no general hop limit at Layer 2. A forwarding loop can
circulate broadcast, unknown-unicast, or multicast frames, multiplying copies,
consuming links/CPU, and causing MAC addresses to flap between ports. Symptoms
include rapidly rising broadcast traffic, MAC moves, control-plane stress,
queue drops, and loss of management access.

**[Protocol]** Spanning Tree variants elect a loop-free active topology and
place some ports in non-forwarding roles. RSTP/MSTP improve or partition the
control behavior relative to classic STP, but convergence time is topology,
timer, implementation, and failure-detection dependent. Do not memorize one
universal number.

During topology change:

- ports transition state;
- FDB entries may flush/age/relearn;
- traffic can briefly drop, flood, or take a different path;
- queued/in-flight frames may reorder.

### Other redundancy mechanisms

LAG, multi-chassis LAG, EVPN multihoming, first-hop redundancy, and L3 ECMP solve
different failure scopes. MLAG peer-link/orphan-port/split-brain behavior is
vendor design, not an IEEE consequence. A fast physical link-down differs from
a silent unidirectional failure detected by BFD/keepalive/control timers.

For each redundant design, write a failure matrix:

| Failure | Detection | State change | Data-plane window | Evidence |
|---|---|---|---|---|
| member link down | PHY/LACP or platform | remove member/remap | drop/reorder/queue shift | member events and hash state |
| switch/line card down | peer/control protocols | alternate node/path | convergence-dependent | control logs and forwarding state |
| silent path failure | BFD/hello/upper-layer timeout | withdraw/recompute | timer-dependent black hole | probe/control timestamps |
| loop/peer split brain | protocol/guard/vendor logic | block or isolate | duplicate/loop/drop risk | role/guard and MAC-move logs |

Market-data A/B networks should be physically and operationally disjoint, but
switching redundancy is only one input. Chapter 53 owns duplicate arbitration,
sequence gaps, recovery, and snapshot correctness; this chapter does not assume
independent loss merely because paths are labelled A and B.

### Convergence is a timeline, not one number

Break failover into:

```
fault occurs
  → detection
  → protocol/controller decision
  → hardware programming
  → neighbor/remote convergence
  → FDB/hash/queue stabilization
```

A physical carrier loss can shorten detection. A black-holed forwarding path
with link still up waits for a protocol or application detector. A fast local
repair can forward before the wider control plane converges, producing a
temporary alternate path. Measure loss window, duplicate window, reorder depth,
and post-failure queue redistribution separately.

Loop-protection tools—BPDU guard/filter, root guard, loop guard, storm control,
UDLD-like unidirectional detection, and MAC-move limits—are not interchangeable.
A misapplied BPDU filter can hide the very control packets that prevent a loop;
aggressive storm control can drop a legitimate market burst. For each guard,
state trigger, protected failure, action (block/error-disable/drop/alarm), and
recovery.

Failure testing must include restoration. Re-adding a member or recovering a
preferred path can rehash flows, relearn MACs, and create a second reorder/loss
window. “Failover passed” is incomplete if failback was never exercised under
load.

---

## 39.11 Measurement and Operational Runbook — Core

Start at the symptom's timestamp and narrow to a queue/path/state transition.

### Evidence to capture

1. topology: physical ports, speed/FEC, VLAN, LAG/ECMP membership, line card/ASIC;
2. forwarding state: FDB, multicast group, STP/EVPN/LAG state;
3. queue policy: classification/trust, queue map, scheduler, admission/shared
   pool, drop/ECN/PFC thresholds;
4. counters before and after the interval: ingress/egress errors, per-queue
   occupancy/discards/marks, pause, fabric, member/link events;
5. packet evidence: sequence/flow key, size, hardware timestamp points,
   reordering and loss;
6. exact switch/ASIC/firmware/configuration and counter semantics.

Host-side commands are useful boundary evidence:

```bash
ip -s -d link show dev eth0
ethtool eth0
ethtool -S eth0 | grep -iE 'drop|discard|miss|pause|crc|error'
bridge fdb show br br0
bridge vlan show
```

These do not expose an external switch's egress queue. Switch CLIs/APIs are
vendor-specific; use placeholders in a runbook:

```text
show interface <port> counters/errors
show queue <port> occupancy/watermark/discards/ecn
show forwarding-database <vlan> <mac>
show vlan <id> ports
show lag/ecmp members and hash/bucket mapping
show spanning-tree/control-plane events
show multicast replication/group state
```

Validate command meaning/version. Counters may be sampled, delayed, shared,
wrapped, cleared, or counted in cells/packets/bytes. Save raw outputs and time
bounds.

### Measurement traps

- SPAN/mirror sessions can oversubscribe the mirror destination, drop, reorder,
  or use a different internal path.
- Host software timestamps include host scheduling and packet-path delay.
- NIC hardware timestamps locate an event at a NIC capture point, not
  automatically at switch ingress/egress.
- Packet generators must reproduce concurrent burst shape, not only average
  packets per second.
- Unloaded port-to-port latency says nothing about queueing under fan-in.
- One maximum without sample count/distribution/configuration is not a
  qualification result.

For an unloaded forwarding-mode test, sweep frame sizes at fixed rate below
contention and plot latency against bytes. A full-frame serialization slope is
evidence consistent with store-and-forward at the chosen timestamp points; a
flat line suggests overlap/cut-through. Feature/path changes must be tested
separately.

### Before/after switch experiment

For a buffer, QoS, hash, or flow-control change:

1. **Hypothesis:** name the queue/path and expected counter/distribution change.
2. **Baseline:** replay the same frame sizes, flows, fan-in phases, and duration;
   preserve raw configuration and counters.
3. **Mutation:** change one attached hardware policy and read back effective
   state. Record commit/programming errors.
4. **Verification:** repeat workload and compare latency histogram, loss,
   reorder, queue watermark/time, member utilization, pause/ECN, and throughput.
5. **Side effects:** test lower classes, recovery/control traffic, other shared
   pools/ports, CPU/control plane, power if relevant.
6. **Rollback:** restore and repeat a short control to show the behavior returns.

Chapter 43 owns statistical technique. Here, matched traffic matters because
switch queues are driven by phase: two generators with the same rates but
different start alignment can produce different maxima. Synchronize the
generators or intentionally sweep phase.

### Distinguish loss locations

One missing application sequence can result from source omission, ingress CRC
drop, VLAN/ACL discard, fabric/admission drop, egress queue overflow, link error,
NIC ring drop, kernel drop, or application overrun. No single switch counter
covers all of them.

Use conservation where possible:

```
source packets
  ≈ switch ingress accepted + ingress rejects
  ≈ egress transmitted + internal/egress rejects
  ≈ NIC received + link/NIC rejects
  ≈ application delivered + host/application drops
```

Replication and sampling complicate equality, and counters may count frames at
different stages. Still, a bounded interval with before/after deltas narrows the
first stage where counts diverge.

---

## 39.12 Common Traps — Core

- Treating the FDB as global rather than VLAN/bridge-domain scoped.
- Calling unknown-unicast flooding a broadcast protocol guarantee; switches may
  suppress, limit, trap, or drop it.
- Assuming “cut-through” means no buffering, no FCS consequences, or fixed
  product latency.
- Adding full ingress, processing, and egress times without checking which
  pipeline stages overlap.
- Planning from average bundle/port utilization instead of short-window
  per-egress/per-queue arrivals.
- Comparing advertised buffer bytes without cell rounding, reservations,
  shared-pool thresholds, multicast accounting, or drain rate.
- Believing strict priority removes blocking or creates bandwidth; it can starve
  lower classes and waits for an in-flight frame.
- Assuming DSCP/PCP maps to the intended queue at every hop without verifying
  trust and rewrite policy.
- Expecting a single flow to consume all LAG/ECMP members, or enabling
  per-packet balancing without modeling reordering.
- Treating PAUSE/PFC as lossless end-to-end flow control; both are hop-local and
  can spread congestion.
- Quoting a universal STP/failover convergence time or assuming a logical A/B
  label proves physical disjointness.
- Trusting a mirror capture or drop counter without understanding where it can
  lose information.

---

## Recall Card — Core

- Learn source, look up destination, and scope both forwarding and flooding to
  the effective VLAN/bridge domain.
- Store-and-forward waits for a complete frame; cut-through overlaps ingress and
  egress only when the actual product path, feature set, rate, and contention
  allow it.
- Serialization is bits/rate; propagation is distance/velocity; queueing is
  bytes ahead/egress rate. Define timestamp points before adding terms.
- Microburst backlog grows by arrivals minus departures; buffer trades loss for
  delay and cannot repair sustained overload.
- Input FIFO HOL is addressed by VOQ/matching, but same-queue, in-flight-frame,
  priority, PFC, fabric, and replication blocking remain.
- QoS is a chain from markings/ACL to internal class, queue, scheduler, and
  admission. Verify every hop.
- LAG/ECMP hashing balances flows, not necessarily bytes. Member changes and
  unequal paths can reorder.
- PAUSE/PFC, STP, MLAG, and redundant paths have failure windows and blast
  radii; protocol names do not provide universal latency or loss guarantees.

## Questions — Core

1. A destination ages out of the FDB. Trace the next frame through VLAN
   classification, lookup, flooding, and relearning. What changes if unknown
   unicast suppression is enabled?
2. How would frame-size sweep data distinguish store-and-forward from
   cut-through, and which alternative explanations could mimic the slope?
3. Derive backlog and tail queue delay for three 100 Gb/s sources bursting into
   one 100 Gb/s egress. Which switch-specific terms make the ideal model wrong?
4. Explain classic input HOL blocking, how VOQ helps, and three forms of
   blocking VOQ does not remove.
5. Why can a “deep-buffer” switch drop sooner than expected even when aggregate
   free memory remains?
6. A packet is marked high priority at the server but uses the default queue at
   egress. List every classification/rewrite mapping to inspect.
7. Why can an eight-member ECMP group be congested at 35% average utilization?
   What evidence distinguishes an elephant collision from total capacity
   shortage?
8. Compare global PAUSE, PFC, ECN, shaping, and policing by scope, feedback
   target, delay, and failure mode.
9. During a link failure, why can packet reordering occur even with per-flow
   hashing? What does resilient hashing improve, and what does it not guarantee?
10. Design evidence that distinguishes a Layer-2 loop, multicast flooding,
    output microburst, and host receive drop when all appear as sequence gaps.

## Applied Exercise and Puzzle — Core

Given a leaf switch with four 25 Gb/s source ports, two 25 Gb/s LAG uplinks, and
a 25 Gb/s receiver:

1. Specify two burst shapes with identical one-second average utilization but
   different required queue depth.
2. Calculate ideal backlog, drain time, and overflow for each. Then add frame
   cell rounding, initial occupancy, one in-flight maximum frame, scheduler
   share, and a configurable shared-buffer limit.
3. Propose a VLAN/QoS mapping and explain its starvation/liveness risk.
4. Choose flow keys that demonstrate LAG polarization. Predict behavior when a
   member fails under ordinary modulo hashing and resilient hashing.
5. Write the counter/timestamp capture plan needed to validate the prediction.
6. State rollback and success criteria for one change.

**Puzzle:** after moving market data to strict priority, its p99 improves but
gap recovery and management traffic periodically stop; eventually the market
queue also drops. Explain how strict priority starved the traffic needed for
recovery/control, why the first metric looked better, and how admission,
capacity, and weighted minimum service can restore liveness without pretending
the egress has more bandwidth.

## Prerequisites for Chapter 40 — Core

Chapter 40 does not require switch internals. For later networking chapters,
retain the forwarding journey, queue arithmetic, classification chain, and
protocol-versus-product distinction. Review Chapter 36 for exact Ethernet byte
accounting, Chapter 37 for multicast transport, Chapter 46 for host packet-path
mechanisms, and Chapter 53 for A/B feed correctness.
