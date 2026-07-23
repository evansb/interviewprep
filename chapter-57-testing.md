# Chapter 57 — Testing

## Why This Matters — Core

A test is useful only when it names a risk, controls or records the stimulus, and has an oracle that can distinguish correct from incorrect behavior. Running production-like traffic without an oracle is a demo. Running random inputs without a reproducible artifact is a bug lottery. Running a stress test until it passes does not prove concurrency correctness.

For native, protocol-driven, time-dependent systems, the testing objective is:

> Make the important behavior a deterministic function of explicit inputs, then attack it with examples, generated sequences, malformed bytes, alternate schedules, faults, recorded traffic, and realistic load.

Correctness comes first. A performance comparison is invalid if the implementations do not produce equivalent outcomes. Reproducibility comes next: a failure must preserve enough input, time, schedule, configuration, and binary identity to rerun it. Coverage is supporting evidence, not a proof that unexecuted—or executed—behavior is correct.

The target is not the largest suite. It is the smallest layered portfolio that detects each important failure early, explains it precisely, and retains a durable regression.

Chapter 44 owns framework, sanitizer, benchmark, and CI mechanics. This chapter uses tool names only to identify capability and limitations. Tool behavior and platform support are version/build-specific; check the compiler/runtime documentation used by the project.

## 90-Second Screen — Core

Before accepting a test plan, ask:

1. **Risk:** Which defect or violated invariant is this test intended to expose?
2. **Boundary:** What is real, simulated, mocked, or outside scope?
3. **Stimulus:** Exact example, generated case, event sequence, schedule, fault, replay, or offered-load trace?
4. **Oracle:** Invariant, reference model, differential result, protocol vector, ledger reconciliation, or external observation?
5. **Determinism:** Which clock, RNG, input ordering, scheduler, and environment are controlled?
6. **Artifact:** Are seed, shrunk input, event/fault trace, build/configuration, and actual/expected output retained?
7. **Limit:** What can a pass not prove?
8. **Failure quality:** Does the smallest reproducer explain the defect, or just say “flaky”?
9. **Portfolio:** Which cheaper layer catches this before integration, replay, or hardware testing?
10. **Regression:** Does the failure become a permanent test at the smallest useful boundary?

The portfolio is a pyramid of feedback cost, not a mandated percentage:

```text
                    hardware / venue certification
                 failover, wire replay, full performance
              deterministic system and integration tests
         model, property, differential, fuzz, scheduler tests
               focused unit and invariant tests

        many cheap deterministic cases -> fewer costly realistic cases
```

Some risks invert the picture. A NIC timestamp path needs hardware. A parser needs millions of fuzz cases. A state machine benefits from both a tiny model and an end-to-end replay. Choose by risk and oracle.

## 57.1 Goals, Boundaries, and Correctness Oracles — Core

### Start from invariants

Examples verify known cases. Invariants describe every allowed state:

- quantity and monetary conservation;
- sequence continuity or explicit invalid state;
- no illegal order transition;
- no duplicate economic effect from a duplicate message;
- price levels sorted and aggregate quantities consistent;
- risk exposure includes all accepted/live/fill state required by the model;
- at most one active failover epoch can cause external action;
- queue output contains no invented, duplicated, or reordered event beyond its contract.

An invariant should state scope and timing. “Position equals fills” is incomplete if busts, corrections, initial positions, or settlement adjustments exist. “No duplicate orders” needs an identity and ownership boundary.

### Oracle families

| Oracle | Strength | Typical blind spot |
|---|---|---|
| exact expected output | clear for a small example/vector | author may omit an edge case |
| invariant | applies across many inputs | may be too weak to choose one correct output |
| reference model | compares with simpler semantics | model can share a misunderstood requirement |
| differential | compares independent implementations | agreement can be jointly wrong |
| metamorphic relation | checks how output changes after transformed input | relation itself may not cover full semantics |
| round trip | encode/decode or serialize/parse consistency | two directions may share the same bug |
| external authority | venue vectors, ledger/drop-copy, standard corpus | coverage and version/scope can be limited |

Use more than one oracle for high-consequence state. A fast order book can match a slow model, preserve conservation, and reproduce an authoritative venue snapshot. Independence matters: generating protocol “goldens” with the decoder’s own encoder proves self-consistency, not wire conformance.

### Boundaries and the test pyramid

A **unit test** isolates one policy or state transition with dependencies supplied explicitly. An **integration test** checks contracts between real components. An **end-to-end test** crosses the deployed path and external interfaces. The larger boundary catches configuration and interaction defects but makes localization, control, and reproduction harder.

A unit should not need a real wall clock, production socket, DNS, random device, unjoined background thread, or machine-global configuration unless that dependency is the subject. Inject interfaces or pass data at the natural boundary. Testability does not require virtual dispatch on the production hot path; templates, function objects, immutable inputs, and link/build seams are alternatives.

### Select techniques by defect class

Every technique has a characteristic reach:

| Technique | Strongest use | A passing test cannot establish |
|---|---|---|
| example/unit | exact boundary and transition semantics | behavior outside enumerated examples |
| property/generator | broad algebraic/state input space with shrinking | requirements not expressed by properties |
| differential | regression between independent paths/versions | which side is correct without another oracle |
| executable model | long stateful command sequences | correctness of the model or omitted production effects |
| fuzzing | parser/memory-safety and malformed-input exploration | unexecuted semantic states or full protocol conformance |
| deterministic simulation | system logic under controlled order/time/faults | real scheduling, device behavior, or latency |
| race detector | dynamic conflicts in instrumented execution | absence of races or higher-level correctness |
| stress/soak | manifestations under real concurrency/time/resource pressure | exhaustive interleavings or memory-model legality |
| model checker | allowed executions of a small formalized skeleton | whole-program behavior or fidelity of abstraction |
| replay | realism of recorded event/byte sequences | cases absent from the recording |
| load/performance | capacity, degradation, distributions on a deployment | functional correctness without outcome oracle |
| HIL/certification | device/deployment and external conformance | broad logical state-space coverage |

Layer them so the same invariant appears at multiple boundaries. For example, “a duplicate execution has one economic effect” belongs in a unit transition test, a generated gateway model, a deterministic disconnect/replay scenario, and ledger reconciliation after failover. Repetition at different boundaries is defense in depth, not duplicate effort.

Tests also differ by **authority**. A unit model can inspect private state; a black-box conformance test should use only public input/output; an operational canary may use external venue/drop-copy or ledger facts. Avoid weakening the production contract merely to expose internal details. Prefer stable diagnostic snapshots and event histories designed for testing and observability.

### Integration and end-to-end contracts

An integration test should name the seam it validates:

| Seam | Stimulus | Oracle |
|---|---|---|
| decoder -> normalizer | versioned native vectors | exact normalized identity, units, quality flags |
| feed state -> book | ordered/gapped/recovered events | quality state plus model-equivalent book |
| strategy -> risk | intents at limit boundaries | decision/reservation model and no bypass |
| risk -> gateway | accepted/rejected/expired reservation | no wire output without valid admission |
| gateway -> venue emulator | session/reconnect/throttle sequences | canonical order transitions and transcript |
| fills -> positions | duplicate/correct/bust events | authoritative signed ledger |

Prefer a small faithful fake or protocol emulator over mocks that merely return the answer the caller expects. A strict mock can verify call order while missing wire bytes, retries, buffering, and state semantics. Conversely, a giant emulator can become an unreviewed second production implementation. State its supported subset and validate it with independent vectors.

An end-to-end test should assert more than “received a response.” Capture the input identity, decision/risk evidence, exact outbound intent, acknowledgment/execution correlation, final position/order state, and alarms. Include a no-action oracle: forbidden outputs must be absent during gaps, stale state, kill state, expired configuration, and rejected risk.

End-to-end failures are expensive to localize, so preserve the event transcript and stage state digests needed to replay at smaller boundaries. Do not make the whole suite wait for an external environment when the same logic can gate commits deterministically; reserve external tests for the contracts only that environment can validate.

### Coverage and mutation evidence

Source-line, branch, edge, transition, state, and requirement coverage answer different questions. Report the denominator and instrumentation/version. “95% coverage” without the kind, scope, exclusions, and oracle quality is not actionable.

Mutation testing deliberately changes expressions or control flow and asks whether tests fail. Surviving mutations can reveal weak assertions, unreachable code, equivalent mutations, or behavior outside the test boundary. Mutation score is tool/operator/version-specific evidence, not a correctness probability. Use it selectively on domain policies and arithmetic where mutants are interpretable; do not optimize a score by adding assertions that merely mirror implementation details.

The most valuable coverage artifact for a state machine is often a matrix of states, commands, transitions, rejects, duplicates, and faults linked to named tests. It is reviewable against the specification and survives compiler instrumentation changes.

## 57.2 Test the Domain State Machines First — Core

Chapters 50, 53, 54, and 56 define critical state machines. Each needs an adversarial matrix before broad system tests:

| Owner | Core invariant | Adversarial sequences | Oracle |
|---|---|---|---|
| order lifecycle (Ch. 50) | every event causes one legal transition; quantities conserve | fill before cancel response, partial fill then replace reject, late ack, duplicate execution | executable order model plus quantity ledger |
| market data (Ch. 53) | state is healthy only after complete ordered input/recovery | gap, duplicate, reset, snapshot/delta overlap, A/B reordering, stale timer | feed-quality model and canonical book/checksum |
| gateway (Ch. 54) | client/venue identity and session sequence remain consistent | disconnect after send, resend, duplicate response, throttle, restart with live orders | venue-session model and reconciliation ledger |
| risk (Ch. 56) | no accepted action exceeds defined limits; fills always affect exposure once | concurrent intents, stale reservation, reject release, duplicate fill, kill during backlog | slow authoritative exposure model |

For every transition test:

```text
pre-state + input event + relevant version/time
 -> expected output events
 -> expected post-state
 -> invariant check
```

Check after each command, not just final state. A system can enter an illegal intermediate state, emit an unsafe order, and later converge to the correct total.

### Minimal examples before generators

Begin with named examples:

- smallest valid message/order;
- boundary quantity/price/sequence value;
- each legal transition once;
- each illegal transition and its rejection;
- duplicate of every externally repeatable event;
- reordering of each pair that can race;
- failure immediately before and after each state-changing side effect.

These become readable specifications and seeds for later generators. They also separate a requirements disagreement from a generator bug.

### A concrete order-transition matrix

Suppose the model has `PendingNew`, `Live`, `PartFilled`, `PendingCancel`, `Filled`, `Cancelled`, and `Rejected`. Do not test only the happy path:

| Pre-state | Event | Expected output/state | Key oracle |
|---|---|---|---|
| `PendingNew` | new acknowledgment | `Live` | venue/client IDs bound once |
| `PendingNew` | fill before acknowledgment | venue-specific modeled state | fill affects exposure exactly once |
| `Live` | partial fill | `PartFilled` | cumulative + leaves conserves quantity |
| `PartFilled` | cancel intent then fill | state reflects fill while cancel outstanding | cancel does not erase execution |
| `PendingCancel` | cancel acknowledgment | `Cancelled` if leaves remain | final leaves/cancel quantity reconcile |
| any live state | duplicate execution ID | unchanged economic state | diagnostic duplicate count may rise |
| terminal | contradictory new fill | reject/escalate per protocol model | never silently reopen terminal order |
| disconnect after send | no response | `Unknown/PendingReconcile` as designed | no blind retry with new economic identity |

The table deliberately leaves one result “venue-specific modeled state.” The test must encode the applicable protocol rather than inventing a universal lifecycle. Repeat the pattern for feed quality, session sequencing, and risk reservations.

Transition coverage is more meaningful than line coverage here, but it is still not proof. Cover legal transitions, illegal transitions, event pairs that race, and failures around side effects. If a state has no defined recovery or terminal path, the design—not just its tests—is incomplete.

## 57.3 Unit, Property, Differential, and Model Tests — Core

### Property-based testing

Property-based testing generates many inputs or command sequences and checks a general property. High-value property forms include:

- **invariant:** total remaining plus executed equals original quantity;
- **model equivalence:** optimized book equals a slow `std::map`/list model;
- **round trip:** decoding an independently valid encoding preserves semantic fields;
- **metamorphic:** splitting one valid chunk into arbitrary transport fragments does not change decoded messages;
- **idempotence:** applying an explicitly duplicate administrative event twice has the documented effect;
- **monotonicity:** increasing an accepted limit cannot reduce a purely monotonic allowance, when the domain rule truly is monotonic.

Generators must be state-aware. Uniform bytes are useful for parser robustness but rarely create a valid order lifecycle. A command generator should choose from actions legal or deliberately illegal in the current model state, and record why an action was chosen.

**Shrinking** reduces a failing generated case to a smaller input/sequence. Preserve the minimized case as a normal regression artifact. A seed alone is fragile: generator code, library version, iteration order, and distribution changes can map it to different inputs.

### Differential testing

Differential tests feed the same input to two independently useful implementations:

```text
scalar decoder       vs vectorized decoder
simple book model    vs optimized book
old release          vs candidate release
venue/reference file vs internal normalized form
```

Define equivalence carefully. Internal layout, timestamps, diagnostic ordering, and acceptable nondeterminism may differ. Normalize only fields declared irrelevant. When changing intended behavior, review and version the oracle rather than automatically blessing new output.

### Model-based testing

A model-based test maintains a small executable specification and sends the same commands to model and system under test:

```text
generate command valid for model state
 -> apply to model
 -> apply to SUT
 -> compare outputs and observable state
 -> assert invariants
 -> repeat
```

The model should optimize clarity, not share production data structures. It can use slow containers, arbitrary-precision arithmetic, and direct state inspection. Keep the state small enough to diagnose. Model-based and property-based testing overlap when a property generator becomes stateful.

No model proves the requirement is right. Validate the model against protocol/venue examples and domain review.

### Generator and shrinker design

A stateful generator can choose among:

```text
70% legal progress commands
15% duplicate/replay commands
10% deliberately illegal commands
 5% fault/time/control commands
```

Those weights are illustrative and should be tuned from coverage of model states/transitions, not copied. Bias toward hard-to-reach states such as partially filled plus cancel pending, recovery plus snapshot buffered, or throttle plus disconnect. Record command preconditions so a shrinker can preserve validity.

Shrinking stateful traces is harder than shrinking bytes. Removing an early command may make every later identifier invalid. Useful strategies include:

- remove contiguous command ranges and replay from the model;
- replace quantities/prices/IDs with canonical small values;
- replace a command with a simpler command preserving its postcondition;
- repair dependent identifiers through a symbolic mapping;
- shrink time gaps while preserving event ordering/timer triggers;
- minimize fault position after minimizing logical commands.

The smallest trace is not necessarily the most explanatory. Preserve a human-readable named regression after automatic shrinking, and retain the original artifact if it demonstrates a distinct load or timing context.

## 57.4 Protocol Vectors and Fuzzing — Core

### Protocol-vector tests

A protocol vector is an input byte sequence plus expected parse/encode result under an exact specification version. A useful corpus includes:

- authoritative/captured examples with provenance and permission;
- minimum/maximum field values and scales;
- absent versus zero/empty distinctions;
- byte order, alignment, padding, and optional fields;
- one message split at every transport boundary relevant to the framing API;
- several coalesced messages;
- unknown or newly added message types under the compatibility policy;
- encode results compared byte-for-byte where canonical encoding is defined.

Tag each vector with protocol/template version and expected policy. A parser can correctly reject a vector from an unsupported future version; calling every rejection a defect erases compatibility semantics.

### Coverage-guided fuzzing

A native fuzz target should be:

- in-process and fast;
- deterministic for an input;
- bounded in allocation, recursion, and runtime;
- free of external network/time dependencies;
- checked by sanitizers and semantic assertions;
- seeded with a small valid corpus;
- able to emit a standalone reproducer.

Compiler-integrated libFuzzer, AFL++-style instrumentation, and sanitizers are toolchain capabilities, not C++ standard features. Availability, flags, supported targets, and interoperability are compiler/runtime-version-specific. Chapter 44 owns setup.

Malformed-message mutations with high yield include truncation at every byte, inconsistent length/count, integer overflow/underflow around header calculations, zero-length elements that prevent progress, excessive nesting/count, invalid enum/tag, duplicate fields, misalignment, trailing data, and concatenated frames.

The oracle is more than “did not crash”:

- accept/reject must match policy;
- accepted values must satisfy structural invariants;
- rejection must not advance state incorrectly;
- parser must make progress or return;
- no out-of-bounds, use-after-free, undefined behavior, or uncontrolled allocation;
- optimized and reference decoders must agree where both apply.

Coverage-guidance reports explored control flow under an instrumentation scheme. High line or edge coverage does not prove sufficient input-domain coverage or correct assertions. Low coverage can reveal unreachable harness paths; high coverage can coexist with a useless oracle.

### Resource and progress oracles

Native parsers often fail by consuming resources rather than memory corruption. For each fuzz input, bound:

- maximum bytes allocated and live allocations;
- output element count relative to validated input length;
- loop iterations or consumed offset;
- recursion/nesting depth;
- exception/error allocation policy;
- retained state after rejection;
- maximum execution time under a practical harness timeout.

A zero-length element that leaves the cursor unchanged can hang without violating memory safety. Assert that every successful loop iteration advances input or reaches a terminal state. If the format permits streaming `NeedMoreData`, repeated calls with no new bytes must not allocate or mutate indefinitely.

Use a fuzz-only adapter to isolate one message or stream chunk, but do not disable checks whose behavior is under test merely because they impede coverage. When bypassing a checksum to reach inner parsing, maintain a separate target that validates checksum policy and label the altered boundary.

Corpus management is part of reproducibility: keep small distinct seeds, deduplicate by meaningful coverage/behavior, preserve protocol version, and turn crashes/semantic mismatches into standalone regression vectors. A giant captured corpus can slow each campaign while adding little exploration.

## 57.5 Reproducibility: Seeds, Artifacts, and Virtual Time — Core

A deterministic random test uses one recorded root seed and derives named substreams:

```text
root seed
  -> command-generation stream
  -> payload/value stream
  -> scheduler-choice stream
  -> fault-injection stream
```

This prevents adding one random draw to payload generation from changing the scheduler sequence. Avoid global RNGs and hidden random devices.

A complete failure artifact records:

| Category | Required identity |
|---|---|
| input | minimized bytes or command/event sequence, not seed alone |
| randomness | root seed, generator/schema version, substream derivation |
| time | virtual-clock trace or timestamped input |
| scheduling | controlled choices/yield trace if relevant |
| faults | injection site/count/parameters |
| software | source revision, binary/build ID, compiler/options, dependencies |
| configuration | protocol/reference versions, feature flags, environment |
| platform | OS/kernel/runtime/architecture when behavior can differ |
| result | expected and actual state/output plus failed invariant |

Sources of accidental nondeterminism include real clocks, thread scheduling, address-derived hashes, unspecified/unordered iteration, filesystem enumeration, locale/timezone, process environment, and race-dependent logging. Fixing the RNG seed controls only the RNG.

### Virtual clocks

Time-dependent logic should receive a clock/scheduler abstraction:

```text
now()
schedule(deadline, stable_tiebreak, callback/event)
cancel(timer_id)
advance_to(time)
run_due_events_in deterministic order
```

Never sleep to test a 30-second timeout. Advance virtual time. Test equality at the deadline, multiple timers at one instant, cancellation, large jumps, wrap/range boundaries, monotonic versus civil-clock semantics, and clock steps only if the production requirement includes them.

Virtual time proves logic under the modeled clock. It does not measure real scheduler or timer latency.

## 57.6 Worked Deterministic System Test — Core

The following compact C++ program models one market-data quality state, one sent order, duplicate execution handling, and a virtual-time stale timer. The oracle checks externally meaningful state after every adversarial event.

```cpp
#include <cassert>
#include <cstdint>
#include <queue>
#include <set>
#include <vector>

enum class Quality { Healthy, Invalid };
enum class EventKind { Market, Recover, Fill, StaleTimer };

struct Event {
    std::int64_t at;
    std::uint64_t tie;
    EventKind kind;
    std::uint64_t value;
};

struct Earlier {
    bool operator()(const Event& a, const Event& b) const {
        return a.at > b.at || (a.at == b.at && a.tie > b.tie);
    }
};

struct System {
    Quality quality{Quality::Healthy};
    std::uint64_t next_market_seq{10};
    std::uint64_t orders_sent{0};
    std::int64_t position{0};
    std::set<std::uint64_t> executions;

    void apply(const Event& e) {
        switch (e.kind) {
        case EventKind::Market:
            if (e.value != next_market_seq) {
                quality = Quality::Invalid;
                return;
            }
            ++next_market_seq;
            if (quality == Quality::Healthy) ++orders_sent;
            return;
        case EventKind::Recover:
            next_market_seq = e.value;
            quality = Quality::Healthy;
            return;
        case EventKind::Fill:
            if (executions.insert(e.value).second) ++position;
            return;
        case EventKind::StaleTimer:
            quality = Quality::Invalid;
            return;
        }
    }
};

int main() {
    std::priority_queue<Event, std::vector<Event>, Earlier> events;
    events.push({100, 0, EventKind::Market, 10}); // sends one order
    events.push({110, 1, EventKind::Market, 12}); // gap: invalid
    events.push({110, 2, EventKind::Market, 11}); // ignored while invalid
    events.push({120, 3, EventKind::Fill, 700});  // fill still matters
    events.push({120, 4, EventKind::Fill, 700});  // duplicate: no effect
    events.push({130, 5, EventKind::Recover, 13});
    events.push({140, 6, EventKind::Market, 13}); // sends second order
    events.push({200, 7, EventKind::StaleTimer, 0});

    System system;
    while (!events.empty()) {
        system.apply(events.top());
        events.pop();
        assert(system.position >= 0);
        assert(system.orders_sent <= 2);
    }

    assert(system.orders_sent == 2);
    assert(system.position == 1);
    assert(system.quality == Quality::Invalid);
}
```

Validated locally with:

```bash
clang++ -std=c++23 -O2 -Wall -Wextra -Werror -pedantic \
  deterministic_system_test.cpp -o deterministic_system_test
./deterministic_system_test
```

The example is deliberately a model, not production feed logic. It demonstrates:

- stable `(time, tie)` event ordering;
- a gap immediately invalidates decision input;
- later deltas do not silently heal invalid state;
- an execution remains economically relevant while market data is invalid;
- duplicate execution identity is idempotent;
- recovery explicitly sets the next expected sequence;
- virtual time triggers stale state without sleeping.

A real system test would also compare emitted intents, order transitions, risk reservations, alarms, and replay artifacts. Chapter 53 defines valid feed recovery; Chapter 54 defines execution identity and reconciliation.

## 57.7 Concurrency Testing — Core

Concurrency defects fall into different categories:

- C++ data races and lifetime errors;
- incorrect memory ordering despite race-free atomics;
- deadlock, livelock, starvation, and missed wakeups;
- violated queue/order invariants under legal interleavings;
- false assumptions about scheduling or progress;
- shutdown/restart races.

No one technique covers them all.

### Stress and soak

An invariant-checking stress harness runs many operations across real threads and validates unique sequence IDs, checksums, conservation, ordering, and progress. Vary:

- core count and producer/consumer ratios;
- pinned and unpinned execution;
- oversubscription/preemption;
- empty/full boundary contention;
- startup/shutdown and thread failure;
- allocation pressure and background interference;
- supported architectures and compiler optimization levels.

A pass proves only that no checked failure manifested in those executions. Timing sleeps and “run it longer” are not correctness oracles. Preserve operation histories around failure.

### Dynamic race detectors

ThreadSanitizer is a compiler/runtime tool that observes instrumented executions and reports happens-before conflicts. It can find many ordinary data races. It cannot prove race freedom, enumerate unexecuted schedules, validate higher-level atomic protocols, or necessarily understand uninstrumented code, inline assembly, custom synchronization, devices, or every library/runtime. Support and limitations are toolchain/platform-version-specific.

Address/undefined-behavior sanitizers target different risks and are commonly separate configurations. A sanitizer-clean run is evidence for executed paths, not a certificate.

### Controlled scheduler testing

Randomized scheduler testing inserts test-only yield/block choices at meaningful transition points. Record the seed and exact schedule trace. Better, let a deterministic controller choose which logical task runs next:

```text
ready tasks + model state
 -> choose task from seeded schedule
 -> execute one bounded step
 -> check invariant
 -> repeat
```

This explores races more directly than arbitrary sleeps. The inserted points define the schedules reachable by the harness; a missing point leaves a blind spot.

### Memory-model checking — role-specific

For a small extracted synchronization algorithm, a C++ concurrency model checker or litmus tool can explore allowed executions under a specified memory model. This is appropriate for an SPSC index protocol, reference publication, or tiny lock-free state machine—not a whole trading process. State-space explosion requires few threads, values, and steps.

Verify that the model matches production atomic operations and memory orders. A model proof of the wrong abstraction is still wrong. Chapter 25 owns the C++ memory model; Chapter 44 covers available tools.

### Histories and linearization

For a concurrent object, record an operation history:

```text
operation ID, thread
invocation time/order
arguments
response time/order
result
```

An oracle can ask whether completed operations admit a legal sequential order that respects real-time precedence: if operation A returned before B began, A must precede B. This is the idea behind linearizability checking. It is stronger than checking that totals match at the end; duplicated/deleted values can cancel numerically.

Keep histories small for exact checking because candidate orders grow rapidly. Use generated short histories for the strong oracle and long stress runs for cheaper invariants/progress. Pending operations at shutdown need an explicit policy. For queues, also validate per-producer ordering, uniqueness, range/checksum, capacity behavior, and that no consumer reads storage after reclamation.

Progress properties need their own oracle: a thread completes within a bounded logical number of successful peer operations, a queue continues after one participant pauses, shutdown joins within a virtual or generous external deadline, and no retry counter grows without state change. Wall-clock deadlines in stressed CI are diagnostics, not formal lock-free/wait-free proofs.

## 57.8 Deterministic Simulation, Replay, and Faults — Core

### Deterministic simulation

In deterministic simulation, external effects become events:

```text
market packets/messages
order responses
timers
control/config changes
faults and restarts
```

One event scheduler controls order and virtual time. Network sends become captured outputs; RNG is injected; no production thread or wall clock decides logical ordering. For a fixed artifact, the run should produce byte- or structure-comparable decisions, transitions, and final state.

Simulation validates logic under modeled conditions, not real latency, kernel/NIC behavior, or uncontrolled concurrency. Keep the same domain transition code where practical so the simulator does not test a separate implementation.

The scheduler needs explicit semantics:

1. Events are ordered by virtual time, then a stable tie-break recorded in the artifact.
2. A handler runs as one modeled step or emits further scheduled steps; it cannot block the simulator.
3. External output is appended to an oracle-visible journal before another event can depend on it.
4. Timers use the declared clock domain; wall/civil time conversion is a separate input.
5. Faults are events at defined before/after-side-effect points.
6. The run has step, output, allocation, and virtual-time bounds to catch nonprogress.

Determinism does not require only one event order. Generate many deterministic orders, each identified by a schedule artifact. For events declared causally independent, metamorphic tests can permute them and assert equivalent results. For events sharing an instrument, order, session, or risk budget, reordering may correctly change outcomes; the model must state the ordering domain.

Keep an append-only simulation journal:

```text
step | virtual time | input/fault | pre-state digest
     | outputs | post-state digest | invariant results
```

On failure, binary-search or shrink the prefix. State digests accelerate comparison but are not sufficient oracles unless collision risk and serialization are acceptable; retain structured state around the mismatch.

### Recorded replay

Replay can operate at several boundaries:

| Replay | Preserves | Omits/changes |
|---|---|---|
| decoded logical events | domain sequence | parser, packetization, kernel/NIC |
| captured packets into parser | real byte/message mix | original delivery timing unless modeled |
| timed socket/wire replay | packet timing and stack path | venue response unless emulated; hardware may differ |
| full venue emulator | interactive protocol/order behavior | fidelity limited by emulator model |

Record capture provenance, timestamp clock, interface, filters, snap length, protocol/reference versions, and capture-drop counters. A capture with missing packets is either an intentional gap test or an invalid “golden” healthy session.

Golden outputs should be reviewed and versioned. Never auto-update them because a candidate differs.

### Fault injection

Inject at semantic boundaries:

- fail the \(n\)-th allocation/read/write/send/append;
- truncate or duplicate the \(n\)-th protocol event;
- disconnect before send, after send before ack, or during recovery;
- delay one consumer or one clock domain;
- crash before/after durable state commit;
- corrupt/checksum/reject a selected record;
- expire a risk/reference version;
- pause a primary or partition communication.

Systematically failing the \(n\)-th operation gives bounded reproducible coverage of observed call sites. Random fault timing complements it but does not replace artifacts.

The oracle must include safe degradation: invalidation scope, no unsafe new action, preserved fill/cancel handling, alarms/counters, bounded recovery, and final reconciliation.

For durability, enumerate crash points around the intended commit protocol:

```text
construct record
 -> append/write
 -> flush/synchronize as required
 -> publish in-memory state
 -> acknowledge ownership
```

Crash immediately before and after each step, restart from the persisted bytes, and compare with the recovery model. Simulate short writes, torn/corrupt trailing records if the storage model permits them, stale metadata, full storage, and repeated recovery. Do not claim `write()` or a userspace buffer implies durable media; the persistence contract is OS/filesystem/device-specific.

For network side effects, distinguish:

```text
not submitted
submitted locally, remote outcome unknown
acknowledged/rejected
executed, report delayed/duplicated
reconciled from authoritative source
```

A retry safe in the first state may duplicate economic intent in the second. The fault oracle is the gateway’s explicit uncertainty and reconciliation behavior, not merely eventual process availability.

### Failover

Test clean stop, crash, long pause, slow primary, symmetric/asymmetric partition, and failure during failover. Assert fencing/epoch authority, absence of dual external action, state convergence, handling of working orders, and idempotent repeated recovery. Exact fencing and venue-session behavior belong to Chapters 54 and 56.

## 57.9 Load, Soak, and Performance Regression — Core

### Load and burst tests

Use a realistic offered-load trace with event mix, size, key skew, burst correlation, recovery work, and response traffic. Averages erase the hard part. Test below, near, and beyond the measured throughput–latency knee.

An open-loop generator schedules work at intended times even when the system slows. A closed-loop generator that waits for each completion reduces offered load during stalls and can hide coordinated omission. Record intended arrival, actual injection, start, completion, rejection, and missing outcome.

Oracles include:

- all accepted events reconcile;
- no silent loss/duplicate/invention;
- queue age/capacity and overload policies match design;
- stale state prevents forbidden action;
- cancels/responses/control are not starved by bulk input;
- latency distributions include slow/rejected/timed-out outcome classes;
- generator/replayer has capacity headroom and reports its own drops.

### Soak tests

A soak targets cumulative/time-bound defects: leaks, fragmentation, counter wrap, timer/calendar rollover, descriptor exhaustion, stale mappings, log/disk growth, and gradual queue or latency drift. Duration follows the suspected mechanism. “Ran overnight” is not an oracle.

Track resource slopes and high-water marks, not only final RSS or “process alive.” Inject state transitions and faults during the soak so it exercises more than steady idle.

### Performance regression

Compare performance only after functional equivalence. A credible regression test records:

- dedicated or characterized hardware/software deployment;
- build/config/reference identity;
- warmup and measurement protocol;
- input trace and seed;
- multiple independent runs or sufficiently stable samples;
- latency histograms and throughput/correctness outcomes;
- machine/environment counters useful for diagnosis;
- baseline policy, practical effect threshold, and noise estimate.

Do not average percentiles from separate histograms; merge compatible raw histograms/samples or report run distributions. A fixed “fail if p99 rises 5%” threshold can be noisy on shared CI and blind on very stable hardware. Use effect size plus uncertainty and rerun/triage policy. Tool mechanics belong to Chapters 43 and 44.

Performance tests should also enforce deterministic budgets where possible: zero allocations after warmup, bounded syscalls per batch, no page faults in a measured region, or maximum queue age under a trace. These are often less noisy than tiny wall-time differences, but remain deployment/tool-specific measurements.

### Regression decisions and diagnosis

Separate three questions:

1. **Did the distribution change beyond run-to-run/environment noise?**
2. **Is the effect large enough to violate a practical objective?**
3. **Which stage or resource explains it?**

Use identical raw input and configuration when comparing revisions. Randomize or alternate candidate/baseline run order to reduce thermal or time drift. Retain per-run summaries rather than pooling incompatible environments. A statistically detectable change can be operationally irrelevant; an objective violation is important even if noisy.

When a regression fires, compare correlated stage spans, queue ages, batch sizes, outcome mix, instructions/branches/cache or scheduler/device counters as appropriate, and build/layout/config diffs. Avoid selecting whichever noisy counter moved most and declaring causation. Form a mechanism, run a controlled reversal, and confirm the end-to-end effect.

Performance golden numbers age with hardware, compiler, kernel, firmware, mitigations, and topology. Version them by environment and use them as regression baselines, not universal facts. Functional goldens should be portable where the specification is portable; performance baselines usually are not.

## 57.10 Hardware-in-the-Loop and Loopback — Role-specific

Hardware-in-the-loop (HIL) runs production-relevant NICs, switches, kernel/bypass/FPGA components, clocks, and host configuration against a venue emulator or controlled peer. It can expose DMA/ring behavior, offload/configuration differences, hardware timestamping, switch buffering, physical failover, firmware, and deployment mistakes that logical simulation cannot.

HIL is costly and narrower than it appears:

- an emulator implements only modeled venue behavior;
- a certification/UAT venue may not match production load or latency;
- a port mirror can alter timestamp/capture interpretation;
- one hardware revision does not cover all deployments;
- an in-process timestamp still omits unmeasured device/wire segments.

Use external or hardware timestamps with defined boundaries for wire-path measurements. Preserve exact firmware, driver, kernel, BIOS, NIC, topology, clock, and emulator versions.

**Loopback** uses one clock and can isolate portions of a path. In-process, inter-thread, OS network loopback, NIC/PHY loop, cable loop, and switched round trips exercise different layers. Report the path as measured. `127.0.0.1` does not exercise a physical NIC/wire path; RTT/2 is not a measured one-way latency when directions differ.

HIL and loopback complement deterministic suites. They do not replace the small oracle-rich tests that explain a failure.

Use a ladder so a failure can be localized:

```text
pure transition/model
 -> logical simulator
 -> socket/process integration
 -> same-host loop
 -> NIC/cable controlled peer
 -> switched HIL
 -> venue certification/UAT
 -> guarded production canary
```

At each rung, keep the prior oracle and add only the new boundary’s assertions. If a test first appears at the most expensive rung, reduce it to the cheapest layer that still reproduces after diagnosis. Certification may establish acceptance against a venue-provided suite for a stated protocol version; it does not certify all client logic, performance, recovery, or future protocol versions.

## 57.11 Portfolio and Release Gates — Reference

This section is skippable on a first pass.

### Risk-to-test map

| Risk | Cheapest strong test | Additional layer |
|---|---|---|
| illegal domain transition | table/unit + executable model | deterministic system replay |
| arithmetic/conservation | property tests with wide/reference arithmetic | historical ledger reconciliation |
| parser memory safety | fuzz + sanitizer | packet/HIL replay |
| protocol conformance | independent authoritative vectors | venue certification |
| sequence/recovery error | stateful model/property test | captured replay and injected gaps |
| order ambiguity/reconnect | deterministic gateway simulation | failover/emulator test |
| data race | dynamic race detector + invariant stress | controlled schedules |
| weak-memory protocol error | extracted model check | multi-architecture stress |
| timeout/calendar logic | virtual-clock examples/properties | clock/HIL integration |
| overload degradation | deterministic queue policy test | open-loop burst/load |
| deployment/device latency | micro/integration attribution | HIL external measurement |

### Suggested gates

**Per change:** focused units, invariant/property regressions, protocol vectors, sanitizer configurations, bounded fuzz smoke, deterministic system scenarios.

**Continuous/nightly:** longer fuzzing, replay corpus, randomized schedules, stress/soak slices, performance on a controlled worker.

**Pre-release:** full replay matrix, load/overload, restart/failover, configuration/reference migration, HIL/certification where applicable, rollback rehearsal.

**Post-deployment/canary:** outcome reconciliation, latency/capacity comparison against the same definitions, and automatic rollback/disable criteria. Production experimentation requires safety controls and authorization; tests do not broaden operational permission.

### Failure triage contract

Every automated failure should yield:

```text
test and invariant name
source/build/config/platform identity
seed plus minimized concrete artifact
event/schedule/time/fault trace
expected versus actual
logs/counters around the bounded failure
one-command or documented replay
```

If minimization changes the failure category, retain both artifacts. A crash and a semantic mismatch triggered by the same original input can be separate bugs.

## 57.12 Common Traps — Core

- Writing tests before defining the oracle.
- Treating line/edge coverage as a correctness percentage.
- Testing only final state and missing unsafe intermediate output.
- Building protocol goldens with the implementation under test.
- Using only valid protocol messages or only uniform random bytes.
- Fuzzing without semantic assertions or bounded resource policy.
- Recording only a seed rather than the minimized input and generator version.
- Assuming a fixed RNG seed controls clocks, threads, iteration order, and environment.
- Sleeping for timeouts instead of using virtual time.
- Letting deterministic simulation call a real clock or perform hidden I/O.
- Treating a stress pass or TSan pass as a proof.
- Injecting arbitrary sleeps and calling the resulting failure reproducible.
- Model-checking a skeleton that differs from production memory orders.
- Replaying a capture without checking capture loss and version provenance.
- Auto-updating golden output after any behavioral change.
- Fault-injecting only clean shutdown, not pause/partition/ambiguous send.
- Closed-loop load generation and coordinated omission.
- Letting the generator, capture path, or oracle become the bottleneck.
- A soak whose only assertion is “still running.”
- Performance comparison before output equivalence.
- Averaging percentiles or comparing noisy single runs.
- Quoting loopback or in-process timing as a physical wire result.
- Depending only on expensive HIL tests for logic that a small model can cover.

## 57.13 Recall Card — Core

```text
TEST = risk + boundary + stimulus + oracle + artifact + limitation

ORACLES
example | invariant | reference model | differential
metamorphic | round trip | external authority
combine independent oracles for critical state

ORDER OF ATTACK
domain examples/invariants
-> property/differential/model
-> protocol vectors/fuzz
-> deterministic simulation/replay
-> concurrency/fault/load
-> role-specific HIL/certification

REPRODUCE
minimized input + seed/generator version + virtual time
+ schedule + faults + build/config/platform + expected/actual

TIME
inject clock; stable tie-break; never sleep for logical time
simulation proves modeled logic, not real latency

CONCURRENCY
stress finds manifestations; TSan observes executed instrumented paths
controlled scheduler explores modeled points
model-check only a small faithful synchronization skeleton
no passing technique proves the whole concurrent program

PROTOCOL
independent versioned vectors + malformed fuzzing
oracle includes policy, progress, state, and resource bounds

REPLAY/FAULT
capture provenance and loss; golden changes reviewed
inject before/after side effects; assert safe degradation/reconciliation

PERFORMANCE
correctness equivalence first
realistic open-loop burst; include missing/rejected outcomes
controlled baseline, distributions, effect size, environment identity
```

## 57.14 Reasoning Questions — Core

1. For an order lifecycle, define the risk, boundary, stimulus, oracle, artifact, and limitation of a model-based test.
2. Why are round-trip encoding and differential agreement insufficient protocol oracles by themselves?
3. Design three properties and a state-aware generator for a limit-order book or risk reservation model.
4. What must be stored besides a random seed to reproduce a generated failure after the generator changes?
5. Explain what ThreadSanitizer, invariant stress, controlled scheduling, and memory-model checking can and cannot establish.
6. How would you test a 30-second stale-market timer, simultaneous fill, and recovery without sleeping or using real threads?
7. Compare logical event replay, packet replay, wire replay, and a venue emulator. Which boundary does each omit?
8. Design fault points and oracles for disconnect-after-send-before-ack and failover during recovery.
9. Why does a closed-loop load test understate latency during stalls, and what outcomes must an open-loop test record?
10. Which tests gate each change, nightly builds, release, and deployment for a parser plus order gateway?

## 57.15 Puzzle and Exercise — Core

### Puzzle: the passing but unsafe replay

A captured session replays twice with identical final books and positions. The team calls the system deterministic and correct. During both runs, a feed gap briefly marks the book invalid, but the strategy emits an order before recovery; the order is later rejected, so final positions remain unchanged.

The final-state oracle is too weak. Correctness includes intermediate outputs: no order may be emitted while its market-state precondition is invalid. Determinism merely makes the same bug repeat. Add per-event invariant checks and an output oracle, retain the gap/recovery trace, and shrink the replay to the smallest sequence that emits the unsafe intent.

### Exercise: build an adversarial portfolio

Choose one state machine from each of Chapters 50, 53, 54, and 56. For each:

1. state its authoritative owner and invariants;
2. write five named transition examples, including illegal and duplicate events;
3. build a slow executable model;
4. define a state-aware command generator and shrinkable artifact;
5. add a virtual-clock timeout;
6. inject a fault immediately before and after one external side effect;
7. compose all four in one deterministic simulation;
8. replay the same artifact twice and compare every output/state transition;
9. run an open-loop burst that forces the designed overload boundary;
10. document what the complete portfolio still cannot prove.

Finish by committing each minimized failure as a deterministic regression and adding it to the cheapest layer that retains its oracle.

## Prerequisites for Chapter 58 — Core

You are ready for native debugging when failing tests preserve the binary/build identity, exact input, time/schedule/fault trace, expected and actual outcome, and enough bounded evidence to reproduce the symptom. Chapter 58 begins where the oracle has proved something is wrong and asks how to locate and explain the native-code failure.
