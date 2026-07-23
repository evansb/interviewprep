# Chapter 55 — Hot-Path Techniques

A hot path is not “code that runs often.” It is the causally necessary work
between a latency-sensitive input and its required output. Optimizing it begins
by writing a contract: what work is allowed, what work is bounded, who owns each
object, what happens at capacity, and how a regression is detected and rolled
back.

This chapter applies mechanisms owned elsewhere:

- object layout and safe byte representation: Chapter 3;
- polymorphism choices: Chapter 6;
- allocation and pools: Chapter 7;
- formatting and asynchronous logging: Chapter 16;
- templates and specialization: Chapter 17;
- memory ordering and lock-free structures: Chapters 25–26;
- CPU, cache, and NUMA mechanisms: Chapters 27–29;
- system calls and I/O waiting: Chapter 34;
- CPU placement, power, and timekeeping: Chapter 35;
- compiler optimization and profiling: Chapters 40 and 43;
- end-to-end architecture and budgets: Chapter 52;
- production telemetry: Chapter 59.

The job here is policy and enforcement, not reteaching those mechanisms.

## Why this matters — Core

An optimization that removes a predictable branch but adds code footprint can
worsen instruction-cache tails. A pool that falls back to the heap preserves
functionality while hiding overload until the busiest moment. Moving logging to
another thread removes formatting but can introduce dangling pointers or an
unbounded queue. “No allocation” and “no syscall” are slogans until a build or
test fails when they are violated.

A defensible hot-path design has four properties:

1. the measured path boundary corresponds to a business outcome;
2. correctness, capacity, and ownership invariants are explicit;
3. each prohibited behavior has an automated detector;
4. every optimization has an exception and rollback process.

Examples use C++23. Compiler hints, generated code, Linux tracing, and hardware
behavior are labeled as such; none is a C++ performance guarantee.

## 90-second screen — Core

1. Define the path from an observable input timestamp to an observable output
   timestamp. Include queueing and hand-offs that the outcome actually depends
   on; exclude unrelated background work.
2. Correctness and bounded work precede speed. Every array, parser, queue, retry,
   batch, and pool needs a capacity or iteration bound plus an exhaustion policy.
3. Preallocation removes allocator calls, not first-touch faults, remote NUMA
   placement, cache misses, or object-lifetime bugs.
4. Prefer single-writer ownership to “faster locks.” A queue crossing an ownership
   boundary needs a full policy, lifetime rule, and measurable high-water mark.
5. Fixed layout is useful only when encoded explicitly. Native struct bytes,
   packed-member loads, and `reinterpret_cast` stores do not define a portable
   wire format.
6. Move formatting, I/O, and aggregation off the path, but capture a bounded
   self-contained record. A pointer into stack or mutable storage is not a log
   record.
7. Compile-time specialization trades optimizer visibility for build time and
   code size. Avoiding a virtual call is valuable only when dispatch or blocked
   inlining is an observed cost.
8. CI can enforce allocation/syscall/fault/blocking budgets and performance
   regression limits, but only on controlled hosts with stored artifacts and a
   noise policy.

Two decisions to defend:

- What happens when a hot-path resource is exhausted: reject, shed, coalesce,
  degrade, block, or fail closed?
- Which evidence authorizes an exception, how is it time-bounded, and what metric
  triggers rollback?

### Evidence labels used in this chapter

Performance discussions become misleading when language rules and measurements
are mixed together. Keep these labels active:

| Label | Meaning | Example |
|---|---|---|
| **Standard C++23** | Portable semantic requirement | `memcpy` copies object representation; atomics obey the memory model |
| **Compiler** | A result to inspect for a named compiler/flags/target | Fixed-size `memcpy` became scalar stores; a call was devirtualized |
| **OS/runtime** | Platform/version/configuration behavior | Linux affinity, page locking, fault and syscall tracepoints |
| **Hardware** | Microarchitecture/topology-dependent mechanism | Cache-line transfer, predictor behavior, idle/frequency response |
| **Measured** | Result for a named artifact and workload | A change improved a stated percentile within the experiment’s noise rule |

“Zero-cost abstraction,” “one cache miss,” and “the compiler will inline it” are
not Standard labels. A review should ask which label supports every performance
claim and whether its prerequisites match production.

---

## Part I — Define the path and its policy

## 55.1 Boundary, Budget, and Invariants — Core

Start from a causal event graph. A trading example might be:

```
input becomes visible
        │
        ▼
validate → update owned state → decide → risk gate → encode → publish output
               │                                     │
               ├── bounded telemetry record ─────────┘
               └── warm-path journal hand-off
```

The hot interval is not automatically “packet arrival to send call.” Hardware
timestamp domains, kernel/bypass queues, batching, and publication semantics may
move both endpoints. Chapter 52 owns the complete tick-to-trade budget; this
chapter requires the chosen endpoints to be reproducible and tied to the service
objective.

Classify work by consequence:

| Class | Meaning | Typical policy |
|---|---|---|
| Hot | Output cannot be produced correctly without it | Bounded, resident, owned, continuously measured |
| Warm | Must keep up but is not causally required for this output | Bounded hand-off with explicit lag/full policy |
| Cold | Startup, configuration, recovery, analysis | May allocate/block, but must finish before readiness or stay isolated |

“Move it off the hot path” is valid only if the output does not require its
result. Pre-trade risk cannot be deferred merely because it is expensive.
Formatting a diagnostic usually can. Journaling depends on the acknowledgement
and recovery contract owned by Chapter 56.

### Path invariants

Write invariants as properties a test can falsify:

- **semantic:** validation and risk decisions are identical to the reference
  implementation for every accepted input;
- **ordering:** state publication and output preserve the required sequence;
- **ownership:** one component owns each mutable object at every instant;
- **bounded work:** no input can trigger an unbounded scan, retry, recursion, or
  queue drain;
- **bounded resources:** pool, queue, parser, and output capacities have explicit
  maximums;
- **failure:** exhaustion and malformed input select documented transitions;
- **measurement:** timestamp overhead and missing samples are known.

An “O(1)” operation can still violate bounded work if its constant depends on a
runtime probe chain, page fault, allocator refill, or unbounded retry. Conversely,
a bounded scan over eight entries may be the clearest and most predictable
choice.

### Establishing the baseline

Measure the unoptimized but correct path before setting component budgets. The
baseline record should contain:

- exact source/build ID, compiler, flags, and linked libraries;
- host model, topology, firmware, kernel, tuning profile, and process placement;
- input corpus and temporal shape, including bursts and quiet-to-busy changes;
- queue/pool starting state and background consumers;
- timestamp points, clock domains, and measurement overhead;
- raw latency samples, loss/rejection counts, and mechanism counters.

End-to-end latency is the acceptance metric. Stage timings are diagnostic and
can perturb the path, so use them selectively. A stage budget is not obtained by
dividing the total evenly: serial stages, queue waits, and shared resources have
different variability.

For a serial path with stage times `T_i` and queue/hand-off delay `Q`, one useful
identity is:

```
T_path = T_input + Σ T_i + Q + T_output
```

Percentiles do not add: the p99 of the sum is not generally the sum of each
stage’s p99. Preserve per-event correlation IDs or synchronized samples when
attributing a tail. Also distinguish service time from response time. A decoder
may take the same CPU time while its response latency grows because it waited
behind older events.

Load generation must not omit the delay caused by saturation. A closed-loop
generator that waits for each response can stop sending during a stall and then
report an artificially healthy distribution. Chapter 43 owns coordinated
omission and statistical treatment; the hot-path policy records which load model
was used.

Budget both latency and capacity:

| Budget | Question |
|---|---|
| End-to-end tail | Does the business-visible output meet the target? |
| Per-stage service | Which mechanism consumes CPU or blocks optimization? |
| Queue age/depth | Is waiting moving between stages? |
| Resource high-water | How close did pools/buffers come to exhaustion? |
| CPU/memory footprint | Did specialization/preallocation displace another path? |
| Loss/degradation | Did the system meet latency by dropping required work? |

### A policy record

Each hot path should have a version-controlled policy similar to:

| Rule | Scope | Detector | Failure action | Exception owner |
|---|---|---|---|---|
| No dynamic allocation | Input-to-output thread after ready gate | Allocation tripwire + soak counter | Test fails; production alarms | Component owner |
| No blocking waits | Same thread | Off-CPU/context-switch trace | Test fails; degrade/stop per runbook | Runtime owner |
| Syscall allowlist empty in steady state | Named thread and phase | `sys_enter` tracepoint by TID | CI failure | Platform owner |
| Zero page faults after warm-up | Named mappings/phase | Per-thread fault counters | Readiness gate or test fails | Memory owner |
| Bounded queue | Named edge | High-water/full counter | Edge-specific shed/reject policy | Product/risk owner |
| Latency regression budget | Named workload and host class | Controlled benchmark | Block release or roll back | Performance owner |

The table must distinguish a correctness requirement from a performance target.
Queue corruption is never waived; a syscall may be allowed temporarily if
evidence shows it stays within the service budget and the exception is visible.

## 55.2 Exception and Rollback Process — Core

Blanket rules eventually collide with real requirements. An exception is an
engineering change, not a hallway agreement. Record:

1. **condition:** exact call site, traffic mode, and configuration where it
   applies;
2. **benefit:** correctness or measured performance it enables;
3. **cost:** added tail, capacity, code size, CPU, memory, and maintenance;
4. **prerequisite:** host/compiler/kernel/version assumptions;
5. **guard:** counter, trace, or assertion proving the exception stays scoped;
6. **expiry:** owner and review date;
7. **rollback:** feature flag, artifact, and state compatibility;
8. **success measure:** before/after distributions and confidence/noise rule.

For example, allowing one vDSO clock read is not “syscalls are fine.” The policy
can permit a named clock API, verify that no kernel entry occurs on supported
hosts, record fallback behavior, and roll back to a reused ingress timestamp if
the added measurement worsens the budget.

Rollbacks must preserve correctness and state format. A template-specialized
decoder and its generic fallback should pass the same corpus. A new object-pool
capacity can roll back only if outstanding handles and snapshots remain
compatible. A performance switch that changes order semantics is a new feature,
not a safe rollback.

---

## Part II — Memory, layout, and code shape

## 55.3 Preallocation, Residency, and Pools — Core

The policy objective is not “use a custom allocator.” It is:

> During the measured phase, the hot thread performs no unapproved allocation,
> deallocation, page fault, or capacity growth.

Reserve all bounded storage before the readiness gate. Construct objects and
metadata needed by the path. Touch pages according to the intended NUMA
placement, then verify residency behavior on the deployment host. `reserve` on a
`vector` prevents reallocation only while size stays within capacity; strings,
exceptions, callable wrappers, container nodes, and library initialization can
still allocate.

Preallocation requires an arithmetic capacity argument:

```
required slots
  ≥ maximum admitted live work
  + maximum hand-off backlog
  + cancellation/recovery holdback
  + explicit safety margin
```

Risk or protocol limits can bound admitted work. Backlog depends on producer and
consumer burst/service distributions, not just average rates. Export high-water
marks and time-at-capacity. A pool that is nearly full during normal load has
already consumed its margin.

### Pool policy

Chapter 7 owns allocator and pool mechanics. For a hot path, require:

- one owner for pool metadata, or a separately justified concurrent design;
- a handle/lifetime rule that detects stale reuse where necessary;
- no hidden heap fallback;
- a release rule for cross-thread completion;
- an exhaustion action visible to risk and operations.

A compact single-owner fixed pool can use dense handles:

```cpp
#include <array>
#include <concepts>
#include <cstdint>
#include <optional>
#include <type_traits>

template <class T, std::uint32_t N>
    requires std::default_initializable<T>
class FixedPool {
    static_assert(N > 0);
    std::array<T, N> slots_{};
    std::array<std::uint32_t, N> free_{};
    std::uint32_t available_ = N;

public:
    FixedPool() noexcept(std::is_nothrow_default_constructible_v<T>) {
        for (std::uint32_t i = 0; i < N; ++i) free_[i] = N - 1 - i;
    }

    [[nodiscard]] std::optional<std::uint32_t> acquire() noexcept {
        if (available_ == 0) return std::nullopt;
        return free_[--available_];
    }

    T& get(std::uint32_t handle) noexcept { return slots_[handle]; }

    void release(std::uint32_t handle) noexcept {
        // Precondition: handle is live, belongs to this pool, and is released once.
        free_[available_++] = handle;
    }
};
```

This C++23 example deliberately exposes preconditions. A production pool may add
debug-only live bits or generations, and must define how `T` is reset. It is
single-threaded: publishing a handle through a queue transfers object ownership
but does not make concurrent pool-metadata access safe. If construction and
destruction per checkout are required, apply explicit-lifetime rules from
Chapters 5 and 7 rather than assigning into storage whose object lifetime never
began.

LIFO reuse can improve locality for some workloads, but it is not a universal
win: it may repeatedly concentrate wear, conceal cold-slot faults, or interact
with generation reuse. Measure the access pattern instead of encoding folklore.

### Worked capacity derivation

Suppose the system admits at most `A` live requests by risk policy. A request can
remain allocated while cancellation or completion is outstanding, so reserve
`C` holdback slots. The producer may outrun the owner by a bounded burst of `B`
items. With operational margin `M`, a defensible initial capacity is:

```
N = A + C + B + M
```

Each term needs a source: configured risk limit, maximum in-flight cancellation
state, measured/admitted burst, and reviewed margin. Avoid multiplying one peak
percentile by another and calling it a proof. Test `N`, `N-1`, and `N+1` demand.
At `N+1`, the documented policy—not the allocator—decides whether to reject new
work, coalesce an older update, or enter a safe degraded state.

If the consumer can hold a reference after returning a queue slot, that object is
still live and belongs in `C`; queue depth alone undercounts capacity. If a
configuration raises `A`, the readiness gate recomputes the inequality before
accepting traffic.

### Residency is separate

Allocation success does not guarantee:

- pages have been faulted;
- pages remain resident;
- placement is local to the consuming CPU;
- translations fit the TLB;
- data is warm in cache.

Linux prefaulting, `mlock`/`mlockall`, NUMA placement, transparent huge pages,
and explicit huge pages are deployment mechanisms owned by Chapters 29 and 35.
They consume memory/locked-memory budgets and can fail due to privilege,
fragmentation, policy, or availability. Do not prescribe `MAP_HUGETLB`
universally. Compare normal pages, THP policy, and reserved huge pages under the
real working set; validate fault counts, NUMA locality, TLB behavior, startup
time, and failure fallback.

### Enforcing no allocation and no faults

Use more than one layer:

- an allocation counter/tripwire active only for the named thread and hot phase;
- allocator/library instrumentation that covers aligned, array, and indirect
  allocation forms;
- a steady-state workload that forces every message variant and overflow edge;
- per-thread minor/major-fault counters after a documented warm-up;
- RSS, locked-memory, and NUMA-placement checks at the readiness gate.

A global `operator new` override is a useful test but is incomplete unless all
allocation forms and linked libraries are covered. Sanitizers help find lifetime
bugs, but their performance is not a production latency measurement.

## 55.4 Cache-Friendly Layout and Fixed Serialization — Core

Chapter 3 owns C++ object representation; Chapter 28 owns cache mechanisms. The
hot-path policy is to make the frequently accessed set compact and to encode
external bytes explicitly.

Choose array-of-structures when most fields of one entity are consumed together.
Choose structure-of-arrays when loops touch a small field subset across many
entities. Split rarely used metadata from the hot record only if the added
indirection and lifetime complexity pay for reduced footprint. Validate with
cache/TLB counters and end-to-end latency; `sizeof` alone is not evidence.

False sharing is an ownership-layout bug: independently written fields sharing a
coherence line can bounce between cores. C++ exposes
`std::hardware_destructive_interference_size` when the implementation provides a
useful value, but hardware and ABI placement still require inspection.
Over-padding every object can make the working set worse. Separate independently
written producer/consumer metadata; keep read-together fields together.

### Safe fixed-layout serialization

Do not send native struct bytes as a protocol merely because the type is
trivially copyable. Padding, byte order, field widths, alignment, ABI, and
versioning remain part of the wire contract. Packing a struct removes some
padding but can create misaligned members; dereferencing them may be inefficient
or invalid on the target, and a `reinterpret_cast` into a byte buffer can violate
alignment and lifetime rules.

Encode each field at a specified offset:

```cpp
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

template <class UInt>
    requires (std::is_unsigned_v<UInt>)
void store_be(std::byte* out, UInt value) noexcept {
    if constexpr (std::endian::native == std::endian::little) {
        value = std::byteswap(value);
    } else {
        static_assert(std::endian::native == std::endian::big);
    }
    std::memcpy(out, &value, sizeof value);
}

void encode_order(std::byte* out, std::uint64_t id,
                  std::uint32_t price, std::uint32_t quantity) noexcept {
    store_be(out + 0, id);
    store_be(out + 8, price);
    store_be(out + 12, quantity);
}
```

The caller must first prove the output span is at least 16 bytes. `memcpy` makes
alignment and aliasing safe; compilers commonly lower fixed-size copies to
ordinary stores, but generated code is a compiler result to inspect, not a
standard guarantee. Decode symmetrically into integers only after validating
message length and version. Chapter 51 owns protocol validation.

Pre-encoding invariant bytes can reduce work when the output buffer is
single-owner and every variable field is overwritten before publication. The
invariant is testable: poison variable fields in debug builds and compare encoded
bytes against the reference encoder.

## 55.5 Branches, Indirection, and Specialization — Core

The policy is not “no unpredictable branches.” Validation and state transitions
need branches. The questions are:

- Is the branch’s outcome distribution actually hard to predict on the target?
- Can data be partitioned so each loop sees stable behavior?
- Does branch removal add instructions, loads, or code footprint?
- Does specialization preserve identical semantics and fit the instruction
  working set?

`[[likely]]` and `[[unlikely]]` are C++ attributes that may influence code layout
and compiler decisions. They do not train the hardware predictor and can hurt
when production distributions differ from the developer’s guess. Profile-guided
optimization and post-link layout are owned by Chapter 40; both require
representative profiles.

Compile-time policies and `if constexpr` can expose constants, remove irrelevant
code, and enable inlining. They can also multiply functions across venue,
message, side, and feature dimensions. Track text size, build time, instruction
cache/TLB counters, and tail latency. Specialize the dimensions that unlock a
measured optimization, not every runtime enum.

A useful boundary pattern pays runtime selection once:

```cpp
template <class Policy>
void run_session(Session& session, Policy policy);

void dispatch_session(Session& session, Venue venue) {
    switch (venue) {
        case Venue::alpha: return run_session(session, AlphaPolicy{});
        case Venue::beta:  return run_session(session, BetaPolicy{});
    }
    fail_unsupported_venue();
}
```

The hot loop inside an instantiation sees a concrete policy; the outer dispatch
remains readable and checked. This is appropriate when sessions are long-lived.
It is wrong if the selected behavior changes per event or if duplicated loops
overflow the instruction budget.

Virtual dispatch is similar. A predicted indirect call can be cheap; the larger
loss may be blocked inlining or scattered object layout. Compilers can
devirtualize known or `final` types, especially with LTO. Chapter 6 owns the
choice among virtuals, templates, `variant`, and type erasure. Require a profile
showing dispatch/inlining is material before replacing an open interface with
template coupling.

---

## Part III — Ownership, queues, kernel, and logging boundaries

## 55.6 Single-Writer Ownership, Locks, and Queues — Core

Lock avoidance starts with architecture. Assign mutable state to one writer and
send commands or immutable snapshots across boundaries:

```
feed owner ── update command ──► strategy owner ── action ──► output owner
    │                                  │
    └── immutable snapshot/version ────┘
```

This reduces simultaneous mutation and makes ordering visible. It does not make
communication free. A hand-off adds publication memory ordering, coherence
traffic, queueing, and another scheduling domain.

Use a mutex when the critical section is cold and its blocking behavior meets
the budget; correctness beats a fragile lock-free rewrite. On a hot path, inspect
not only uncontended acquisition but contention, owner preemption, priority
inversion, convoying, and cache-line movement. `std::shared_mutex` is not
automatically read-scalable because reader acquisition still updates shared
metadata.

Chapters 25–26 own memory ordering and queue algorithms. A queue policy must
state:

- exact topology: SPSC, MPSC, SPMC, or MPMC;
- object lifetime and when ownership transfers;
- capacity and high-water alarm;
- producer behavior on full;
- consumer behavior on empty;
- ordering and batching guarantees;
- shutdown/cancellation behavior;
- whether producer or consumer may disappear.

Do not reuse SPSC measurements for an MPSC queue or for a different placement.
Atomic cost depends on cache-line ownership, topology, contention, and hardware.
“Lock-free” describes progress guarantees, not bounded latency, fairness, memory
reclamation, or absence of retry.

Moving work to a consumer helps only while it keeps up. If arrival rate exceeds
service rate, a bounded queue reaches its full policy; an unbounded queue turns
the incident into memory growth and stale work. Measure queue age as well as
depth: a modest-depth queue can still contain work too old to be useful.

Fairness also bounds hot loops. Drain at most a configured number of events or
time slice from one source before checking risk, timers, control messages, and
output. The bound is part of correctness if starvation can delay a kill switch.

### Ownership timeline for one queued object

“The queue contains a pointer” is not a lifetime proof. Write the states:

```
producer-owned
    │ fill object completely
    │ successful publish
    ▼
queue-owned / immutable to producer
    │ successful consume
    ▼
consumer-owned
    │ process; publish completion or return handle
    ▼
owner pool may reset/reuse
```

On a failed publish, ownership remains with the producer, which applies the
queue-full policy. On successful publish, the producer must not mutate or
release the object merely because it has advanced to other work. On shutdown,
either the consumer drains accepted items or the protocol explicitly
returns/cancels them before pool teardown.

Cross-thread release needs another ownership edge. A common design returns a
dense handle to the pool owner through a second bounded SPSC queue. If that
return queue can fill, its policy matters as much as the forward queue’s;
leaking handles until restart is not a bounded system.

Queue memory order proves publication visibility, not higher-level sequencing.
If events from two producers require one domain order, an MPSC structure alone
does not define it. Add a sequencer or make the owner assign order, and test
wrap, gaps, duplicates, and producer failure.

### Configuration publication

Configuration belongs off the hot path, but its *use* often does not. Parse,
allocate, validate cross-field invariants, and derive lookup tables on a cold
thread. Publish only a complete immutable snapshot with a generation. One event
should observe one generation for every related decision; reloading individual
fields independently can create a combination that never existed in any valid
configuration.

Publication and reclamation are separate:

```
build generation G+1 → validate → publish pointer/version
                                      │
hot readers stop acquiring G          │
                                      ▼
                      wait for quiescence/epoch → reclaim G
```

An atomic pointer swap can publish, but deleting the old snapshot immediately
can race readers. `shared_ptr` can solve lifetime but adds reference-count
updates and may run destruction on an undesirable thread. An epoch/quiescent
protocol, double buffer with acknowledged generation, or fixed trivially
copyable snapshot under an appropriate publication scheme may fit better.
Chapters 25–26 own the memory-order and reclamation proof.

The policy records:

- maximum snapshot size and update rate;
- which thread allocates and later reclaims;
- whether an event may span generations;
- behavior when validation or publication times out;
- generation ID included in replay/telemetry;
- test that stalls a reader across several attempted updates.

“Lock-free config reload” is incomplete unless old memory has a safe lifetime.
Likewise, copying a large snapshot per event may be race-free but violate the
path budget. Measure the chosen read-side operation and make configuration
activation an observable state transition.

## 55.7 Syscalls, Busy Polling, Placement, and Power — Core

Chapter 34 explains syscall and wake-up mechanisms; Chapter 35 owns Linux CPU
isolation and power tuning. This chapter turns them into conditional policies.

| Technique | Removes/reduces | Gives up | Enforce/verify |
|---|---|---|---|
| Syscall-free steady state | Kernel entry and hidden kernel work | API simplicity; may require bypass/shared queues | Trace `sys_enter` by TID and phase |
| Busy polling | Sleep/wake and cold resume | A CPU, power, fairness | Off-CPU time, loop progress, thermals |
| CPU affinity | Migration | Scheduler flexibility | Migration counter and actual CPU |
| Core isolation/IRQ routing | Unrelated interference | Host capacity and operational simplicity | Scheduler/IRQ traces on target CPU |
| NUMA-local ownership | Remote memory access | Placement flexibility | Page placement and memory counters |
| Power-state policy | Idle/frequency transition variance | Energy/turbo behavior/thermal headroom | Residency, actual frequency, temperature, latency |

A strict syscall policy is phase- and thread-specific. Startup may open files,
map memory, register resources, and create threads. The ready gate then enables
the tripwire. Remember that page faults and vDSO execution are not necessarily
visible as `sys_enter`; track faults and clock behavior separately.

Busy spinning is justified when the measured sleep/wake distribution violates
the target and a dedicated CPU/power budget is available. A spin loop must still:

- make bounded progress across every source;
- check shutdown and safety controls;
- avoid accidental blocking calls;
- expose iteration/progress counters;
- have a deployment-safe scheduling policy.

Do not prescribe `_mm_pause` universally. It is an x86 compiler intrinsic whose
effect depends on CPU and spin purpose; other architectures have different
wait/yield instructions. A contention wait and a device/event polling loop can
need different strategies. Inspect generated code and benchmark with the actual
producer placement, including SMT sibling effects.

Pinning a thread does not isolate a CPU. Kernel work, interrupts, timers, RCU
callbacks, firmware events, and SMT siblings may still interfere. Linux boot
parameters and IRQ affinity are version/deployment controls with safety
consequences. Treat them as a tested host profile maintained with Chapter 35,
not as source-code folklore.

Power policy is likewise workload- and processor-specific. Disabling turbo can
reduce one form of frequency variability but also lengthen service time and
increase queueing; leaving turbo enabled can be stable when thermal and package
load are controlled. Wide-vector frequency effects vary by microarchitecture.
Record firmware, governor/driver, frequency limits, idle policy, SMT, cooling,
and instruction mix; verify actual residency/frequency/temperature rather than
assuming a knob took effect.

## 55.8 Logging and Observability Boundary — Core

Chapter 16 owns formatting/I/O; Chapter 59 owns production telemetry. The hot
side should capture the smallest self-contained event needed by the consumer:

```cpp
#include <array>
#include <cstdint>
#include <type_traits>

struct LogRecord {
    std::uint64_t timestamp;
    std::uint32_t call_site;
    std::uint16_t severity;
    std::uint16_t argument_count;
    std::array<std::uint64_t, 4> arguments;
};
static_assert(std::is_trivially_copyable_v<LogRecord>);
```

Use a compile-time call-site ID or pointer to static immutable metadata, scalar
arguments, and an existing path timestamp where its clock semantics fit. Do not
enqueue a pointer to a stack buffer, temporary string, mutable object, or storage
that the producer immediately reuses. Copying an arbitrary `string_view` into a
deferred record copies only pointer and length, not the characters.

A producer operation should expose failure:

```cpp
bool record_decision(LogQueue& queue, std::uint64_t timestamp,
                     std::uint64_t order_id, std::uint64_t reason) noexcept {
    const LogRecord record{
        .timestamp = timestamp,
        .call_site = 0x31A2u,
        .severity = 1,
        .argument_count = 2,
        .arguments = {order_id, reason, 0, 0},
    };
    return queue.try_push(record); // false selects the documented full policy
}
```

`LogQueue` is an application type with a bounded, non-allocating `try_push`; the
snippet does not prescribe a queue algorithm. Passing the timestamp in avoids
silently adding another clock read and keeps a known event clock domain.

The producer API should make unsafe arguments unrepresentable through concepts
or overloads. The consumer on a housekeeping core resolves metadata, formats,
batches I/O, rotates files, and publishes counters. Its slowness must not feed
unbounded memory back into the producer.

Every telemetry edge needs a full policy:

| Event class | On full | Required evidence |
|---|---|---|
| Debug/diagnostic | Drop/sample/coalesce as configured | Per-call-site and total loss counters |
| Operational state transition | Reserve capacity or separate high-priority path | Gap/sequence detection |
| Audit/journal correctness record | Follow Chapter 56 acknowledgement contract | Recoverable ordering/durability proof |
| Safety alarm | Dedicated bounded path plus fallback signal | Delivery/failure state visible |

“Allocation-free logging” does not mean “loss does not matter.” Export dropped
counts without recursively logging the drop. Test the consumer stopped, slow,
and crashed. A flight recorder—an overwrite-capable fixed ring retained for
post-incident extraction—can be appropriate when continuous delivery is less
important than recent history, but overwrite semantics must be explicit.

---

## Part IV — Enforcement, measurement, and worked reasoning

## 55.9 CI and Runtime Enforcement — Core

Performance policy should fail automatically with useful artifacts.

### Functional tripwires

| Property | Test mechanism | Important limitation |
|---|---|---|
| No allocation | Thread/phase allocation hook; allocator counters; exhaust corpus | Interposition may miss custom/library allocators |
| No syscall | Linux syscall tracepoint filtered by TID and ready phase | vDSO and faults need separate checks |
| No page fault | Per-thread minor/major fault delta after warm-up | A short test may not touch every path/page |
| No blocking | Off-CPU trace, voluntary context switches, forbidden-call hooks | Preemption is not voluntary blocking |
| No migration | CPU/migration counters and in-loop CPU sampling | Sampling can miss a brief migration |
| Bounded work | Adversarial inputs, fuzzing, loop-iteration assertions | Bounds must reflect production configuration |
| Queue/pool policy | Forced slow consumer and exhaustion tests | Must verify business response, not only no crash |
| Safe serialization | Golden corpus, round trip, malformed lengths, cross-endian vectors | Native-only tests miss portability errors |

Run sanitizers and property tests to protect correctness, but do not compare
their latency to optimized production builds. Test both debug guards and the
actual release artifact.

On Linux, a focused validation run might collect:

```bash
perf stat -e page-faults,context-switches,cpu-migrations -- ./hot_path_soak
strace -f -c ./hot_path_soak
```

These are diagnostic commands, not a latency benchmark: `strace` perturbs the
program materially, and process-wide `perf stat` may include helper threads.
Production gates should filter by the named thread/phase using supported tracing
or in-process counters, save the trace, and run latency measurement separately
without heavy tracing. Chapter 34 owns syscall observability details.

A practical suite has layers:

1. **Fast functional test:** enable allocation/lifetime/bounds guards and run
   every message/configuration variant.
2. **Mechanism soak:** hold representative load long enough to exercise wrap,
   refill, full, quiet-to-burst, and consumer slowdown; assert policy counters.
3. **Controlled latency run:** use the release artifact without intrusive
   tracing on a reserved host.
4. **Adversarial run:** inject exhaustion, delayed consumers, affinity failure,
   cold pages, and malformed maximum-size input.
5. **Artifact audit:** inspect binary size, symbols, compiler remarks, and
   configuration provenance.

An allowlist must identify calls, not merely permit a count. One recurring
`write` may be a deliberate heartbeat; one unexpected `futex` can expose hidden
blocking. Baseline the ready phase only—startup registration and teardown would
otherwise make a legitimate program fail “zero syscall.”

### Performance regression gates

A useful gate has:

- a dedicated or strongly controlled host class;
- fixed artifact, compiler, flags, firmware/kernel, topology, and tuning metadata;
- representative input mix, bursts, queue pressure, and background interference;
- warm-up criteria stated in events and resource state, not arbitrary sleep time;
- a baseline distribution and an absolute safety ceiling;
- a statistical/noise policy that can declare the run inconclusive;
- stored raw samples, counters, profiles, build ID, and environment snapshot.

Chapter 43 owns benchmark statistics and coordinated omission. A CI gate should
not block a release on one noisy maximum, nor hide a real tail regression behind
an average. Compare relevant percentiles or quantiles with confidence/repetition
appropriate to the sample process, and preserve outliers for diagnosis.

Code size is a performance artifact. Track text size and per-symbol growth when
adding templates or inlining; inspect compiler optimization remarks and
representative assembly. Hardware counters are evidence only when the event is
supported and interpreted for the named CPU.

### Production enforcement

Some violations appear only after hours or under overload. Keep low-overhead
counters for allocation attempts, faults, migrations, queue age/high-water,
drops/rejections, loop-progress gaps, and configuration generation. Chapter 59
owns publication and merge semantics. Counters themselves must not introduce
shared-line contention on the path; prefer producer-local state with bounded
publication.

Readiness should fail closed when required preconditions are absent: memory
registration failed, pool capacity mismatches configuration, thread affinity is
wrong, or the required host profile is not active. Whether the entire service
stops or a slower safe mode starts is a product/risk decision recorded in the
exception process.

## 55.10 Worked Optimization: The Obvious Change Is Wrong — Core

Consider an input-to-output loop with a runtime-polymorphic decoder, state update,
risk gate, encoder, and synchronous-looking `log_debug` call. Median meets the
budget, but bursts produce a long tail. The team proposes template-specializing
every venue and message type to remove virtual calls.

### Step 1: preserve the reference behavior

Capture a replay corpus containing valid messages, malformed lengths, boundary
prices/quantities, queue-full conditions, and session transitions. Record
outputs, state hashes, rejection reasons, and telemetry-loss behavior. Any
optimized path must match these semantics before latency comparison.

### Step 2: instrument named mechanisms

During the ready phase, collect:

- allocation attempts and page faults by hot TID;
- syscalls and off-CPU intervals;
- branch misses, instruction-cache/ITLB misses, and cycles where reliable;
- log-queue depth/age and consumer service time;
- path latency correlated with message kind and call site.

Suppose evidence shows the decoder call target is stable and well predicted,
while `log_debug` builds a temporary string that occasionally grows and allocates.
During bursts the log consumer falls behind; queue-full handling formats a
warning synchronously. Allocation and log-queue saturation align with tail
events. This causal chain is stronger than a flat profile of mean CPU.

Record the reasoning as a change ledger:

| Observation | Candidate change | Expected confirming signal | New risk |
|---|---|---|---|
| Allocation aligns with tails | Fixed capture record | Hot allocation count becomes zero | Queue loss/lifetime bug |
| Queue age rises in bursts | Capacity/service/full-policy review | Age/high-water bounded under replay | More memory or deliberate drops |
| Dispatch target stable | Leave virtual call initially | Branch/indirect-call counters unchanged | Missed inlining opportunity |
| Text footprint already pressured | Avoid full Cartesian specialization | I-cache/ITLB behavior does not regress | Generic path retains some CPU cost |

This ledger prevents the team from claiming success merely because a preferred
technique was implemented.

### Step 3: evaluate the proposed specialization

Specializing venue × message type duplicates the decode-and-loop body. It may
enable inlining, but it does not remove the logging allocation. It can enlarge
text enough to add instruction-cache misses when traffic rotates among message
types. The obvious change attacks a small stable dispatch and risks a new tail.
Reject it for now.

### Step 4: repair the boundary

Replace hot-side formatting with a fixed `LogRecord`. Define:

- debug records drop on full and increment a producer-local counter;
- safety/audit events use their separately specified path;
- the logging consumer never calls back into the producer;
- temporary strings are rejected by the producer API;
- queue high-water and age are visible.

Preallocate and touch the ring before readiness. Run the same saturation test
with the consumer deliberately slowed. The hot path must keep its bounded work
and select the documented full action.

### Step 5: remeasure and consider narrower specialization

If dispatch/inlining is now material, dispatch once per long-lived session into a
small policy instantiation, or mark genuine leaf types `final` and test LTO.
Compare text size and instruction counters as well as latency. Roll back
automatically if semantics diverge, the tail budget regresses, or code-size
growth exceeds its approved budget.

The lesson is not that logging is always the culprit. It is the procedure:
preserve semantics, identify the mechanism correlated with tail events, make the
smallest reversible change, and verify both the removed cost and the new trade.

## 55.11 Hot-Path Review Checklist — Reference

### Boundary and semantics

- [ ] Input/output timestamps and clock domains are documented.
- [ ] Queueing and hand-offs causally required by the output are included.
- [ ] Reference behavior and malformed/overload cases have a replay corpus.
- [ ] Acknowledgement, journaling, and risk semantics are not deferred for speed.

### Work and capacity

- [ ] Every loop, scan, retry, batch, parser length, pool, and queue is bounded.
- [ ] Each capacity has a derivation, high-water metric, and full action.
- [ ] Shutdown and cancellation retain objects until ownership safely returns.
- [ ] Slow/stopped consumers and unavailable dependencies are tested.

### Memory and layout

- [ ] Allocation growth is impossible or detected after readiness.
- [ ] Pages are touched/placed according to the deployed NUMA policy.
- [ ] Huge-page/locking choices have budgets, failure fallback, and measurements.
- [ ] Independently written state does not accidentally share hot cache lines.
- [ ] External formats use explicit widths, offsets, byte order, and bounds.

### Code and dispatch

- [ ] Branch changes use production-like distributions.
- [ ] Specialization has a measured optimizer benefit and code-size budget.
- [ ] Indirect/virtual dispatch is changed only with evidence.
- [ ] Generated code claims name compiler, flags, and target.

### Ownership and boundaries

- [ ] Mutable hot state has a named writer.
- [ ] Queue topology and memory-order proof match actual producers/consumers.
- [ ] Telemetry records are self-contained for their full lifetime.
- [ ] Syscall, blocking, fault, and migration allowlists are phase-specific.
- [ ] Busy-poll/core/power choices match a tested host profile.

### Release and operations

- [ ] Functional tripwires run over the full message/configuration corpus.
- [ ] Performance gates store raw data and environment/build metadata.
- [ ] Every exception has owner, guard, expiry, success measure, and rollback.
- [ ] Production counters detect long-run drift without perturbing the path.

### Common traps

- Measuring only handler service time while queue age grows before the handler.
- Deferring a correctness-critical risk or journal step and still claiming the
  same acknowledgement semantics.
- Reserving container capacity without testing the exact maximum-size and
  exception paths.
- Letting a pool or bounded queue fall back to heap allocation on full.
- First-touching memory on a setup thread whose NUMA placement differs from the
  hot owner, then assuming preallocation established locality.
- Publishing a new configuration pointer and immediately reclaiming the old
  snapshot while a reader can still hold it.
- Calling a queue SPSC because there is usually one producer, while recovery or
  telemetry code creates a second producer.
- Moving logging off-thread but enqueueing `string_view`, `c_str()`, or object
  pointers whose storage changes before consumption.
- Treating packing, trivial copyability, or matching host endianness as a
  versioned wire-format specification.
- Removing branches through arithmetic that reads more data or expands the
  dependency chain.
- Specializing a Cartesian product of policies without tracking text growth and
  instruction-cache behavior.
- Testing “no syscall” across process startup/teardown rather than the ready
  phase, or forgetting that faults are not syscall events.
- Pinning a thread while interrupts, kernel callbacks, or an SMT sibling still
  interfere with the same physical core.
- Dropping telemetry to meet latency without surfacing loss, then losing the
  evidence needed to diagnose the overload.

## Recall Card — Core

- Define the hot path causally. “Runs often” and “hot” are not synonyms.
- Correctness, ownership, and bounded work are non-negotiable; performance rules
  can have measured, visible exceptions.
- Preallocation removes allocator variance only. Verify faults, residency, NUMA
  placement, and capacity separately.
- Pools never hide exhaustion with a heap fallback. The full action is part of
  product/risk behavior.
- Compact layout helps when it reduces the measured working set. Encode wire
  fields explicitly; do not reinterpret packed/native structs.
- Single-writer ownership is the first lock-avoidance tool. Queues add ordering,
  queueing, lifetime, and overload contracts.
- Busy polling and isolation spend CPU/host flexibility to reduce wake-up and
  interference. Turbo, huge pages, SMT, and pause instructions are conditional.
- Capture fixed self-contained telemetry records; format and write elsewhere.
- CI enforces no-allocation/no-syscall/fault/blocking policies on controlled
  artifacts, and performance changes remain reversible.

## Questions — Core

1. Draw the causal hot path for a decision loop. Which warm-path work can move
   out, and which risk/journal work cannot under its acknowledgement contract?
2. A vector is reserved at startup but the hot thread still faults and allocates.
   List distinct mechanisms and detectors for each.
3. Derive a pool capacity from admitted live work, backlog, cancellation
   holdback, and safety margin. What happens at exhaustion?
4. When can structure-of-arrays worsen latency despite a smaller field working
   set?
5. Why is a packed, trivially copyable C++ struct not automatically a wire
   format? Give a safe encode/decode procedure.
6. A predicted virtual call appears in a hot loop. What measurements justify
   templates, and what measurements could reject them?
7. Compare an uncontended mutex with an SPSC hand-off in ownership, ordering,
   queueing, full behavior, and tail risks—not only instruction count.
8. How do you enforce “no syscall” without confusing vDSO execution, page faults,
   or startup work with steady-state policy?
9. Design a logging full policy for debug, safety, and audit events. Why should
   they not share one loss rule?
10. What artifacts and noise controls make a latency-regression gate credible
    enough to block a release?

## Code-Reading Puzzle — Core

```cpp
struct WireOrder {
    std::uint16_t length;
    std::uint64_t id;
    std::uint32_t price;
};

void send_order(std::byte* tx, const Order& order) {
    auto* wire = reinterpret_cast<WireOrder*>(tx);
    wire->length = sizeof(WireOrder);
    wire->id = order.id;
    wire->price = order.price;
    log_async("sent", order.symbol.c_str(), wire);
}
```

Identify the missing contracts and possible failures: output capacity/alignment,
object lifetime, padding, byte order, protocol size, stale variable bytes,
`symbol` and `wire` lifetime across deferred logging, queue-full behavior, and
whether logging may allocate. Rewrite the encoder with explicit field stores and
define a self-contained log record.

## Implementation Exercise — Core

Write a hot-path policy for an event loop with one input owner, one strategy
owner, one output owner, and a warm logging consumer. Include:

1. the causal timestamp boundary and latency budget;
2. mutable-state ownership and queue topology;
3. pool/queue capacity derivations and full transitions;
4. allocation, syscall, fault, blocking, migration, and bounded-work detectors;
5. fixed-layout serialization validation;
6. logging lifetime/loss rules;
7. a controlled benchmark and production drift counters;
8. one justified exception with condition, benefit, cost, prerequisite, guard,
   expiry, rollback, and success metric.

Then inject a stopped consumer, malformed maximum-length input, pool exhaustion,
CPU migration attempt, page eviction before readiness, and a configuration that
selects every specialized path. The system must remain correct and choose the
documented degraded behavior.

## Prerequisite for Chapter 56 — Core

Chapter 56 assumes the hot-path policy never weakens safety to meet latency. Be
ready to distinguish publication from durability, define what is acknowledged,
and explain how queue-full, logging loss, restart, and kill-switch transitions
interact with resource ownership. Chapter 56 turns those boundaries into
recovery and risk invariants.
