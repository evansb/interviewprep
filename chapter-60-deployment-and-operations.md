# Chapter 60 — Deployment and Operations

**Why this matters.** A release is not complete when files reach a host. It is complete when a known artifact, known configuration, compatible state, recovered session, and authorized process reach a defined operating state—and when the reverse path is still safe.

Trading systems make this boundary sharp. A process can be alive while its book is incomplete, its risk configuration is stale, or its old peer still owns the order session. A rollback can be impossible after a state-format migration or external order. A supervisor can turn a dependency outage into a crash loop. Operations must therefore be designed as state transitions with evidence, commit points, and bounded failure windows.

## 90-Second Screen — Core

Five facts:

1. Identify a release by immutable artifact digest/build ID, resolved configuration digest, reference-data versions, state schema, and protocol/product versions. A source revision alone is insufficient.
2. “Started,” “live,” “ready,” “authorized to send,” and “actively handling traffic” are different states. Readiness is an application correctness predicate, not an orchestrator’s process-state guess.
3. A configuration update is one immutable validated generation published atomically. Safe publication also requires a lifetime rule for readers; atomic pointer replacement alone is incomplete.
4. Rollback is safe only while the prior binary can read current state/config and recover current external protocol state. After an irreversible migration or venue side effect, forward recovery may be safer.
5. Shutdown is a drain protocol: stop new risk, manage/cancel live work, continue receiving outcomes, reconcile external truth, commit required evidence, release authority, then exit.

Two decisions:

- Before rollout, name the commit point after which automatic rollback closes and the required recovery path changes.
- Before traffic enablement, prove artifact/config identity, dependency validity, warmed behavior, recovered state, effective fencing, and rollback/drain readiness.

---

## 60.1 The Release Lifecycle and Claim Labels — Core

The smallest useful lifecycle is:

```text
source + dependencies + toolchain
          │
          ▼
BUILD → VERIFY → STORE IMMUTABLY → STAGE → START → VALIDATE/RECOVER
                                                    │
                                                    ▼
                                           READY, NO AUTHORITY
                                                    │
                                           fence/traffic commit
                                                    ▼
                                                ACTIVE
                                                    │
                              QUIESCE → DRAIN → RECONCILE → STOP
```

Each arrow needs durable evidence. “Deploy” is too vague to be a state.

| State | Required evidence | External side effects allowed |
|---|---|---|
| Built | manifest and artifacts created | none |
| Verified | digest/signature/provenance and compatibility checks pass | none |
| Staged | exact verified bytes exist on target | none |
| Started | expected executable is running under expected supervisor identity | initialization only |
| Recovering/warming | dependencies, state, and hot paths are being prepared | no new trading exposure |
| Ready, no authority | all readiness predicates pass, but sender fence/traffic entitlement absent | shadow/read-only work only |
| Active | authority transfer and traffic-enable commit recorded | actions within policy |
| Draining | new risk fenced; outcomes and cancels continue | risk-reducing/required protocol work |
| Stopped | external work reconciled and authority released | none |

### Platform claims need labels

This chapter uses:

| Label | Meaning |
|---|---|
| **S — standard** | ISO C++23 language behavior |
| **OS — operating system** | Linux/POSIX/filesystem/process behavior with named version/context |
| **OR — orchestrator/supervisor** | systemd, Kubernetes, Nomad, or another named product/version/configuration |
| **PV — product/version** | service, venue protocol, library, driver, artifact format, or release-specific behavior |
| **R — regulatory** | jurisdiction/entity/activity/date-specific obligation |
| **M — measured** | result from a named rollout, fault, workload, and observation interval |

For example, `SIGTERM` delivery is an **OS** event; what a supervisor sends after a grace interval is **OR** behavior under a named configuration; whether the process cancels venue orders is a **PV** claim about that venue/product/version; and how long drain takes is **M**. Do not turn one layer’s default into a universal prescription.

### Correctness boundaries

Keep these commits distinct:

1. **Artifact commit:** immutable bytes and manifest accepted into the release store.
2. **Stage commit:** verified bytes are present on a target.
3. **Configuration commit:** one resolved generation is validated and published.
4. **State-schema commit:** new persistent representation becomes authoritative.
5. **Readiness commit:** application emits evidence that all current predicates pass.
6. **Authority/traffic commit:** this instance can produce accepted external effects.
7. **Drain commit:** no new work can enter and external work has reached the declared terminal/reconciled boundary.

A process restart, symlink change, load-balancer update, and venue-session transfer can each implement part of these commits, but none is synonymous with the whole transition.

### The release ledger

Maintain one append-only release ledger keyed by release and target. It is the control plane’s answer to “what can safely happen next?” rather than a second stream of application telemetry.

| Transition | Evidence recorded | Failure before commit | Failure after commit |
|---|---|---|---|
| Verify artifact | digest/signature/provenance and validator result | candidate cannot stage | exact bytes may stage |
| Publish config | resolved digest, schema, generation, target ACK state | old generation remains | decisions may use new generation |
| Activate state schema | source/destination versions, converter result, validation | old format authoritative | rollback compatibility follows migration policy |
| Transfer authority | old/new identities, fence generation, external/session evidence | old remains effective sender | new may create external side effects |
| First external effect | stable action/session identity | no accepted effect yet, but an authority/session change may still require reverse handoff | external reconciliation required |
| Complete drain | live/ambiguous work result and committed evidence | service remains contained | authority may be released and process stopped |

The ledger is monotonic evidence, not a mutable status row that overwrites history. A derived “current state” view may be rebuilt from it. If two automation components disagree, they stop at the safer state and surface the conflicting transitions rather than choosing the newest wall-clock timestamp.

Idempotency matters. Retrying “stage digest X” or “request readiness for generation G” should retrieve the same transition. Retrying “transfer authority” must use an authority generation and downstream fence; a duplicated control message must not create a second active. Wall-clock time helps investigation but does not serialize commits across hosts.

The ledger does not replace the Chapter 56 trading journal or Chapter 59 incident telemetry. It records deployment/control decisions and references those systems by stable IDs and watermarks.

---

## 60.2 Immutable Artifacts, Configuration, and Secrets — Core

### Artifact identity

An operationally reproducible release lets an investigator recover the exact bytes and inputs that ran. Bit-for-bit reproducible builds are valuable, but traceability is mandatory even when a toolchain cannot reproduce bit identity.

A source revision does not capture:

- dirty or untracked source;
- compiler, linker, standard library, and flags;
- generated code and schemas;
- transitive dependencies;
- environment and build-system inputs; or
- post-link stripping/signing/packaging.

Store release directories or images by content digest and never mutate them in place. Retain debug information and symbol/log dictionaries keyed by the executable build ID or equivalent identity. A core or compact binary log decoded with a nearby build can produce plausible but wrong output.

A release bundle commonly needs more than the main executable:

| Item | Operational reason |
|---|---|
| Executable and loadable dependencies | exact runtime behavior and security patch identity |
| Separate debug symbols/unwind data | post-crash and optimized-stack reconstruction |
| Binary-log or event dictionaries | decode compact telemetry from that exact build |
| Config/reference-data schemas | consuming binary validates its own accepted inputs |
| State readers/converters | recover and, where supported, reverse a migration |
| Protocol descriptors/generated-code identity | prove wire compatibility |
| Manifest, dependency inventory, attestations/signatures | provenance and verification |
| Runbook/release notes | name compatibility gates, known risks, and rollback close |

Do not put live secrets, mutable host state, or “latest” pointers inside the immutable bundle. A mutable alias may select a digest, but evidence records the digest itself.

An illustrative, valid manifest shape is:

```json
{
  "manifest_schema": 1,
  "release_id": "gateway-2026-07-23.1",
  "source_revision": "0123456789abcdef",
  "artifact_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "build_id": "8f53d91c2a74",
  "toolchain": "clang-20.1.0",
  "config_schema": 7,
  "state_read_versions": [4, 5],
  "state_write_version": 4,
  "protocol_versions": {
    "venue_x_order_entry": "3.2"
  },
  "debug_bundle_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The values are illustrative; the fields express compatibility and identity. Signatures, attestations, SBOMs, and approval metadata depend on the organization’s threat and compliance model.

### Reproducible does not mean portable

Controls such as `SOURCE_DATE_EPOCH`, deterministic archive ordering, path-prefix remapping, and pinned toolchains can improve reproducibility. A container image helps pin inputs but does not automatically remove timestamps, path leakage, network-fetched dependencies, or nondeterministic generators. Verify by rebuilding independently and comparing, not by assuming the packaging tool is hermetic.

Dynamic dependencies belong in the identity. Static linking can reduce host variation but changes patching, NSS/plugin, licensing, and ABI trade-offs; it is not a universal low-latency rule. Record the actual dependency closure and validate it on the target.

### Immutable resolved configuration

Treat configuration as content:

```text
human sources/overrides
        │ parse + schema validation
        ▼
fully resolved canonical snapshot
        │ semantic/cross-source validation
        ▼
content digest + generation + provenance
        │
        └──► immutable object published to process/fleet
```

A useful snapshot includes:

- schema version and content digest;
- every effective value, including explicit schema defaults;
- source/provenance for each override;
- reference-data and secret *references*, not secret values;
- compatibility requirements for artifact/state/protocol versions;
- activation scope and generation; and
- author, approval, and reason metadata as policy requires.

Reject unknown keys unless the schema explicitly defines forward-compatible handling. Silent typos create false confidence. Defaults are not inherently wrong, but safety-sensitive defaults must be deliberate, visible in the resolved snapshot, and included in its digest. A missing risk limit must not silently become an unlimited value.

Layered configuration is acceptable only if tooling emits the final resolved object. During an incident, “which layer won?” should be answered from an artifact, not reconstructed from host files.

### Secrets have a separate lifecycle

Do not bake credentials into the artifact or ordinary resolved-config output. Secret handling must define:

- identity allowed to fetch/decrypt;
- version and rotation overlap;
- injection channel and filesystem/process permissions;
- redaction from logs, crash artifacts, diagnostics, and command lines;
- startup behavior when unavailable;
- revocation and emergency rotation; and
- whether a standby may acquire but not exercise a credential.

Environment variables, files, inherited descriptors, kernel keyrings, agents, and external secret services expose different surfaces. The right choice is **OS/OR/PV** specific. Rotation is a protocol transition: prove old/new overlap, session behavior, rollback, and revocation rather than replacing bytes and hoping reconnect works.

---

## 60.3 Validate and Publish Configuration Safely — Core

Validation moves from syntax to operational compatibility:

| Layer | Examples | Failure response |
|---|---|---|
| Schema | required fields, types, enums, unknown keys | reject generation |
| Local semantic | positive quantity, ordered thresholds, valid tick grid | reject generation |
| Referential | strategy symbols, venues, accounts, limits all exist | reject generation |
| Cross-field | risk bucket ≥ child allocations; drain timeout fits outer supervisor policy | reject generation |
| Compatibility | binary accepts schema; protocol/state versions supported | reject or require migration |
| Freshness/session | business date, expiry, schedule, source generation | hold not-ready pending approved resolution |
| Delta/sanity | unexpected instrument/limit/route changes | require policy-defined approval, never arbitrary tolerance |

Delta checks are useful because individually plausible values can be collectively wrong. Thresholds must be derived per dataset and market calendar; a corporate-action day or new listing can make yesterday an invalid baseline. Record overrides as new approved configuration, not a command-line escape that disappears.

Canonicalization itself is a specification. Decide how key ordering, whitespace, Unicode, number formatting, time zones, and included files resolve before hashing. Two semantically equal inputs may intentionally produce one canonical digest; two different provenance paths may still need distinct approval evidence even if the effective values match.

Reference data deserves identity at the granularity used by decisions. An instrument master may be current while a tick table or contract multiplier is stale. Readiness should name the missing/stale component and business/session context. A “fresh within 24 hours” rule is not meaningful across holidays, intraday corrections, or venues with different session boundaries.

### Atomic publication needs a lifetime rule

Publishing an immutable object through one atomic pointer gives readers a consistent generation, but the old object cannot be destroyed while any reader may still hold it. Choose and document one of:

- bounded retention until all worker threads stop;
- epoch/RCU reclamation after a grace period;
- reader-owned reference counting, accepting its hot-path cost; or
- a stop-the-world update outside critical operation.

The following C++23 model retains a bounded number of generations until worker threads have joined. Only one control thread calls `publish`; readers do an acquire load. Exceeding the bound rejects an update rather than freeing memory unsafely.

```cpp
#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

struct Config {
    std::uint64_t generation;
    std::uint32_t max_order_quantity;
    bool order_entry_enabled;
};

constexpr bool valid(const Config& c) noexcept {
    return c.generation != 0 && c.max_order_quantity != 0;
}

class ConfigStore {
    std::vector<std::unique_ptr<Config>> retained_; // control thread only
    std::atomic<const Config*> active_{nullptr};
    const std::size_t max_generations_;

public:
    explicit ConfigStore(std::size_t max_generations)
        : max_generations_(max_generations) {}

    bool publish(Config next) {
        const Config* old = active_.load(std::memory_order_acquire);
        if (!valid(next) || retained_.size() >= max_generations_ ||
            (old && next.generation <= old->generation)) return false;

        auto owned = std::make_unique<Config>(next);
        const Config* raw = owned.get();
        retained_.push_back(std::move(owned));
        active_.store(raw, std::memory_order_release);
        return true;
    }

    const Config* load() const noexcept {
        return active_.load(std::memory_order_acquire);
    }
};

int main() {
    ConfigStore store{4};
    assert(store.publish({1, 100, false}));
    const Config* first = store.load();
    assert(store.publish({2, 80, true}));
    assert(first->generation == 1); // retained, therefore still alive
    assert(store.load()->max_order_quantity == 80);
}
```

The store must be destroyed only after readers stop. Memory use is bounded by configuration size × maximum generations; if updates can be frequent or unbounded, use a real reclamation scheme. Chapter 25 owns acquire/release mechanics and Chapter 26 owns reclamation algorithms.

Some settings cannot change live because they determine pool sizes, thread topology, memory layout, protocol login, or privilege acquisition. Mark them `restart_required` and reject live publication. For fleet-wide changes, generation publication may be atomic per process but not simultaneous across hosts; the rollout plan must tolerate mixed cohorts or use an explicit activation barrier.

### Cohort activation

A multi-process configuration change benefits from its own state machine:

```text
PROPOSED → VALIDATED → DISTRIBUTED → PREPARED → ACTIVE
                    └──────── failure ────────► ABORTED
```

`PREPARED` means each target has the bytes and has validated compatibility, but no decision uses them. `ACTIVE` is a named event/generation, not “whenever each process notices a file.” If simultaneous activation is unnecessary, mixed generations must be an explicit supported state, with aggregate limits and inter-process messages remaining compatible.

A target that misses activation cannot silently join later with stale state. It remains not-ready, catches up under policy, or is removed from the cohort. Activation acknowledgements should distinguish received, validated, published, and observed by the decision loop.

---

## 60.4 State and Protocol Migration Define Rollback — Core

Rollback is a compatibility operation, not “run the previous executable.” Before release, build a matrix:

| Candidate writes/uses | Previous release can read/recover? | Rollback status |
|---|---|---|
| Same config/state/protocol | yes, if verified | mechanically possible |
| New additive config ignored safely by old schema | only if explicitly supported | possible with evidence |
| New persistent state while old reads both | depends on migration phase | conditional |
| New-only state format | no | automatic rollback closed |
| New external protocol action/identifier | venue/session dependent | reconcile before any rollback |
| Irreversible external side effect | no local binary can undo it | containment/forward recovery |

### Expand, migrate, contract

For a persistent state format:

```text
OLD_ONLY
  → reader supports old+new, writer still old
  → backfill/convert with validation
  → writer new, reader old+new
  → observe and prove rollback path
  → NEW_ONLY (old reader retired)
```

The step that first writes state the old binary cannot consume is a migration commit point. Record it and disable automatic rollback beyond it. A down-converter may restore rollback only if it preserves every invariant and is tested against real state.

State includes more than files: order/session sequence numbers, stable IDs, checkpoint/journal schemas, risk generations, live orders, and external protocol capabilities. Chapter 56 owns replay, fencing, and ambiguous order reconciliation. This chapter invokes those gates during deployment.

Avoid combining unrelated changes when separation materially improves attribution, but “one variable at a time” is not universally possible. A binary and schema may need coordinated activation. In that case treat them as one versioned release transaction with compatible phases, not as independent manual edits.

---

## 60.5 Startup, Readiness, and Traffic Enablement — Core

An application state machine prevents the supervisor from inventing readiness:

```text
CREATED
  → VERIFY_SELF
  → LOAD_CONFIG/SECRETS
  → RECOVER_STATE
  → CONNECT/SYNCHRONIZE
  → WARM
  → READY_NO_AUTHORITY
  → ACQUIRE_FENCE/AUTHORITY
  → ACTIVE
```

Failure before `ACTIVE` leaves new order entry disabled. Failure after authority acquisition enters containment/drain/recovery; it must not restart into `ACTIVE` merely because the executable launches.

Startup ordering is a partial order of application predicates, not a sequence of
fixed sleeps. For example, the accepted schema/config generation may constrain
state decoding; recovered state and session sequence constrain reconciliation;
and synchronization plus warmup constrain readiness. Independent work may run
in parallel, but each edge needs versioned evidence and bounded retry behavior.
Supervisor unit ordering can arrange process starts; it does not prove that an
upstream service has the required data generation or protocol state. Cycles and
temporarily unavailable dependencies should normally leave the application
not-ready with observable progress. Permanently invalid inputs may fail startup
under product policy, but supervisor backoff and failure classification must
prevent an unbounded restart loop.

### Readiness is a conjunction

For an illustrative order gateway, readiness may require:

- running artifact digest/build ID matches the release manifest;
- one accepted resolved config/reference-data generation;
- secrets/credentials available without exposing them;
- resource/privilege setup completed as required;
- time synchronization satisfies the product/regulatory timestamp policy;
- market data or reference state is synchronized and fresh;
- journal/checkpoint replay and external order/position reconciliation completed;
- order-entry session sequence recovered;
- warmup acceptance criteria passed;
- kill/risk state permits the requested mode; and
- independent fence/authority is available but not yet exercised.

The exact list is a **PV/R** contract. Publish failed predicate names and generations, not only a Boolean.

### Liveness, readiness, and safety state

- **Liveness:** is the process/event loop making internal progress? Failure may justify restart.
- **Readiness:** can it perform the requested role correctly now? Failure removes new work or enters a degraded mode.
- **Safety/authority:** may it create external exposure? This remains false until the explicit authority commit.

External dependency failure should generally affect readiness/safety rather than liveness. Otherwise one upstream outage can trigger fleet-wide restart loops and erase warm state. A process managing live orders may need to remain connected and consume fills while not ready for new work; simply removing it from a service endpoint is insufficient.

Orchestrators expose startup, readiness, and liveness features with product/version-specific semantics. Use them for supervision and routing, but keep correctness predicates inside the application. A supervisor knowing that a PID exists or a socket accepts connections does not know the book is synchronized.

### Supervision does not own trading state

A process supervisor should:

- establish executable identity, user/group, namespace/cgroup, resource limits, environment, working directory, and permitted capabilities;
- capture stdout/stderr or connect the defined logging path;
- deliver start/stop requests and enforce the configured outer deadline;
- observe process exit and application liveness;
- apply a versioned restart/backoff policy; and
- preserve enough status to diagnose a crash loop.

It should not decide that a restarted gateway may trade. Recovery, fencing, session state, and readiness remain application/control-plane predicates.

Classify exits. A clean planned stop, configuration rejection, unrecoverable state incompatibility, repeated crash, and transient dependency failure should not all trigger the same immediate restart. Repeatedly restarting a binary that cannot read its state consumes evidence, capacity, and operator attention while never improving the condition.

Startup deadlines also need two layers. The supervisor prevents a permanently wedged start from occupying the service slot forever. The application reports structured progress—validating artifact, waiting for secret, replaying to sequence, synchronizing feed, warming—so a slow but healthy recovery is distinguishable from no progress. Values are measured and release-specific.

Privilege acquisition and resource setup happen before readiness. If the service requires a CPU set, locked memory, device queue, realtime policy, or file descriptor limit, verify the effective result after the OS/orchestrator applies it. “Requested” is not “obtained.” Chapters 31–35 own the mechanisms and tuning choices.

### Warmup is an acceptance test

Invoke Chapters 35 and 55 for host tuning and hot-path policy. Operationally:

1. allocate and touch the intended working set;
2. exercise representative real code paths with external sends independently fenced;
3. establish required network/session state without creating unapproved exposure;
4. measure first-use faults/misses and latency distribution; and
5. mark warm only when release-specific acceptance criteria pass.

Do not prescribe a universal iteration count or keep-warm interval. Warmth decays under competing workloads and idle time; validate it in the target topology. Shadow execution consumes CPU, cache, NIC, and feed capacity and can perturb the incumbent, so include it in capacity planning.

---

## 60.6 Staged Rollout and Authority Transfer — Core

A rollout limits blast radius while proving the next transition. Its stages depend on whether the service is read-only, feed-processing, risk-authoritative, or order-sending.

```text
VERIFIED
  → OFFLINE VALIDATION
  → STAGED TARGET
  → STARTED / READY_NO_AUTHORITY
  → SHADOW OR CONFORMANCE
  → LIMITED AUTHORITY COHORT
  → EXPAND
  → COMPLETE

any reversible stage ── failed gate ──► ABORT / ROLLBACK
after rollback closes ─ failed gate ──► CONTAIN / FORWARD RECOVERY
```

Possible stages include deterministic replay, venue conformance environment, production shadow, one independent session/account/strategy, or a small cohort. None is mandatory for every system. A “small symbol” may still have large risk; a single host may own the entire session; and a shadow can still overload shared resources.

Service role changes the safe blast-radius dimension:

| Service role | Candidate can usually do safely | Commit requiring extra care |
|---|---|---|
| Stateless/read-only decoder | consume copied input, compare outputs | becoming source of downstream truth |
| Market-data/book service | shadow feed and state hashes | publishing a book consumed for live decisions |
| Shared risk service | compute shadow decisions | reserving or releasing aggregate capacity |
| Order gateway | parse/encode with send fenced | session authority and first order/cancel |
| State/audit writer | write isolated candidate store | changing authoritative format or retention chain |

Canarying one instance is meaningful only when its failure remains isolated. A shared aggregate risk bucket, one venue session, one state store, or one multicast fan-out can couple the canary to the whole fleet.

### Shadow needs a hard side-effect fence

A boolean inside the candidate is insufficient if the candidate itself is what is under test. Enforce “no orders” at an independent gateway, credentials, ACL, protocol entitlement, or equivalent control. Compare decisions using Chapter 59’s telemetry and Chapter 57’s test oracles without teaching those mechanisms again.

### Authority transfer

For a single-sender order path, an illustrative handoff is:

1. old active enters quiescing; producer ingress is fenced by generation or new intents are durably buffered under an explicit handoff rule;
2. old active continues fills/cancels and reaches an agreed journal/state watermark;
3. new candidate catches up and proves `READY_NO_AUTHORITY`;
4. effective fence prevents the old sender from being accepted;
5. session/traffic authority transfers under documented **PV** semantics;
6. new active reconciles, enters cancel-only if required, then enables new risk; and
7. both sides record the authority generation and handoff evidence.

A missed heartbeat is not a handoff. Chapter 56 owns fencing and failover correctness.

### Gates and aborts

Define before rollout:

- invariant/correctness checks;
- latency and queue-age distributions;
- error/reject/drop changes;
- decision/output diffs;
- resource headroom in both normal and failed-cohort states;
- observation window and market/session states covered;
- abort authority; and
- whether the current state remains rollback-compatible.

Thresholds come from baseline variation, risk appetite, and the release’s hypothesis. “No errors for five minutes” is not universal evidence; rare message shapes, auctions, reopenings, and burst modes may require a different window.

Keep previous artifacts/config/state tools available for the documented rollback window. Availability on disk is not enough if startup, warmup, session recovery, and state conversion take longer than the incident budget.

---

## 60.7 Health Failure, Drain, and Rollback — Core

### Drain state machine

```text
ACTIVE
  → QUIESCING       stop accepting new risk
  → DRAINING        cancel/manage working orders; consume all outcomes
  → RECONCILING     compare local and external state
  → RELEASING       commit required journal/audit state; release authority
  → STOPPED

failure/timeout at any stage → CONTAINED, not “successful stop”
```

“Cancel request sent” is not drain completion. Orders can fill while cancels are in flight, cancels can reject, and venue state can remain unknown. Drain completion needs:

- ingress for new risk fenced;
- every accepted intent classified;
- working/ambiguous orders reconciled under Chapter 56;
- late executions applied;
- required state/audit records committed to their declared boundary;
- session/authority released or fenced; and
- a structured drain result recorded.

Flattening position is a risk decision, not a generic shutdown step. It may create market risk, violate strategy/client intent, or be impossible in a halted market.

### Signal and supervisor boundary

On Unix-like systems, a termination signal should request the state transition; complex drain work belongs in normal program context. Chapter 33 owns async-signal-safety and signal-delivery mechanics.

The application’s drain deadline and the supervisor’s forced-termination policy must be coordinated. A hard kill before the realistic drain boundary creates the failure being avoided. An infinite drain can block maintenance forever. Derive escalation from venue/session behavior, live-order risk, incident authority, and measured drain distributions.

Cancel-on-disconnect, if offered, is a named **PV** backstop, not a universal guarantee. Scope, delay, session configuration, and behavior during partitions must be verified. Continue external reconciliation after an ungraceful stop.

### Rollback is another deployment

Rollback repeats verification:

1. contain new exposure;
2. determine whether rollback compatibility remains open;
3. select exact prior artifact and compatible config/reference data;
4. convert or select state only through a validated path;
5. recover/fence/reconcile external session state;
6. warm and prove readiness;
7. transfer authority; and
8. observe with explicit gates.

If state or protocol has crossed an irreversible boundary, use a corrected forward release or recovery tool. Repeatedly restarting an incompatible old binary is not rollback.

---

## 60.8 Worked Failure: Rollback Closed Without Anyone Noticing — Core

Release A reads and writes checkpoint schema 4 and uses venue protocol 3.1 client IDs. Release B reads schemas 4 and 5, writes schema 5 after activation, and uses protocol 3.2 IDs. Both the binary and venue protocol changes are required for a new order feature.

The intended plan says “automatic rollback to A on reject-rate alarm.” It never states when schema 5 becomes authoritative or whether the venue session can return to 3.1 after a 3.2 order.

### Timeline

```text
t0  B artifact and config generation 18 are staged and verified.
t1  B starts in shadow, reads schema 4, and reaches READY_NO_AUTHORITY.
t2  Old A quiesces; venue-session authority transfers to B.
t3  B activates config 18 and writes the first schema-5 checkpoint.
t4  B sends protocol-3.2 order C123; venue accepts it.
t5  A separate message field is encoded incorrectly; reject alarm fires.
t6  Automation kills B and starts A.
t7  A cannot read schema 5 and its session sequence/protocol belief predates C123.
t8  Supervisor repeatedly restarts A while C123 may still be live or filled.
```

The reject alarm was useful. The automatic response was unsafe. Rollback compatibility closed at `t3`, and external ambiguity grew at `t4`.

### Failure windows

| Window | Safe automatic action | Why |
|---|---|---|
| Before B readiness | stop B; A remains authoritative | no authority/state commit |
| Ready, no authority | stop B or restage | shadow has no external side effects if fence is real |
| After authority transfer, before schema/protocol commit | controlled reverse handoff after reconciliation | session state changed even if no new order |
| After schema-5 write | A requires down-converter or old-compatible checkpoint | old binary cannot consume authoritative state |
| After C123 accepted | contain, reconcile venue, then choose forward/down migration | external state cannot be rolled back by replacing binary |

### Corrected design

1. B first deploys in a compatibility phase: reads both schemas, writes schema 4, and uses protocol 3.1.
2. Authority-transfer and reverse-transfer drills prove fencing, sequence recovery, and drain.
3. Protocol 3.2 activates as a separately recorded commit with venue conformance evidence.
4. Schema 5 writing activates only after the rollback policy changes from “run A” to “forward recover B or use validated converter.”
5. Reject alarm enters `CONTAINED/CANCEL_ONLY`; it does not kill the only process able to read current state.
6. An exact release ledger shows artifact, config, schema, protocol, authority generation, first side effect, and current recovery choices.

The lesson is not “never automate rollback.” It is “automation must know the compatibility state machine it is traversing.”

---

## 60.9 Incident and Operational State Machine — Core

Operations need one state model that survives process restarts:

```text
NORMAL ──────────► DEGRADED
  │                  │        service impaired; bounded safe work continues
  └─────────────┬────┘
                ▼
             CONTAINED        new risk stopped; kill/fence/drain underway
                ├──────────► RECOVERING ───► VALIDATING ───► NORMAL
                ▲                 │               │             explicit resume
                └──── failure ────┴───────────────┘

any state → HALTED when safety cannot be established
```

Restarting a process must not clear `CONTAINED` or `HALTED`. Persist the control state or hold it in an independent authority. Feature, strategy, venue, and global kill semantics belong to Chapter 56; deployment verifies that the expected kill generation is loaded, independent paths work, and resume requires reconciliation.

### Operational kill verification

For each release, verify the control chain rather than re-designing the risk policy:

```text
authorized request
  → control authority records generation
  → every ingress/sender observes killed mode
  → new-risk fence becomes effective
  → cancel/mass-cancel path is invoked as specified
  → venue outcomes are reconciled
  → status reports requested / effective / reconciled separately
```

The control path must survive the failure it addresses. A flag read only by a wedged strategy loop cannot be the sole venue kill. A remote UI that calls the unhealthy gateway is not out-of-band. An exchange-side feature helps only with documented **PV** scope and configuration.

Kill state and reason must survive restart. Re-enable is a new authorized transition after readiness and reconciliation; it is not the inverse write to the same Boolean. Regular drills are Chapter 57 test/operations work, while Chapter 56 defines the semantic oracle.

### Audit trail

Record lifecycle transitions with:

- artifact/build identity and dependency manifest;
- resolved configuration/reference-data/secret-reference generations;
- state and protocol schema versions;
- target/host, supervisor/orchestrator version, and service unit/spec digest;
- actor or automation identity, approval/reason, and incident/release ID;
- readiness predicates and failure reasons;
- authority/fence generation and external session evidence;
- rollout gates, abort/rollback decision, and timestamps/clock domain; and
- drain/reconciliation result.

Durability, tamper evidence, retention, clock accuracy, and accessible fields are **R/OS/PV** requirements. Scope claims by jurisdiction, entity, product, and effective date. Chapter 59 owns the bounded telemetry/flight-recorder mechanism; Chapter 56 owns durable trading recovery semantics.

An audit event should distinguish command from effect. “Deploy requested,” “artifact staged,” “authority transferred,” and “first external action accepted” are different facts, as are “kill requested,” “new orders blocked,” and “all venue orders reconciled.” Hash chaining or signed batches can make later alteration detectable, but integrity, durable storage, replication, access control, and retention still need a declared contract.

### Change control without paralysis

Every change has:

- hypothesis and affected invariant;
- compatibility/migration classification;
- blast-radius dimension;
- preconditions and gates;
- rollback-close commit;
- containment and recovery path;
- owner and authority; and
- post-change evidence.

Emergency changes can use a faster approval path, but they need stronger scope, observability, expiry, and retrospective review. An override that never expires becomes undocumented configuration.

---

## 60.10 Operational Runbook — Skippable Reference

This section is a checklist, not a universal host recipe. Values come from capacity tests, retention policy, failure model, and product requirements.

### Read-only Linux/systemd evidence collection

The following commands are **OS: Linux** and **OR: systemd**; available properties and output vary by version. They inspect rather than mutate:

```sh
set -eu
pid="$(systemctl show --property MainPID --value trader.service)"
test "$pid" -gt 0
systemctl show trader.service \
  --property FragmentPath,DropInPaths,ExecStart,EnvironmentFiles
systemctl cat trader.service
readlink "/proc/$pid/exe"
sha256sum "/proc/$pid/exe"
cat "/proc/$pid/limits"
ls -1 "/proc/$pid/fd"
df -P
df -Pi
```

Capture output with timestamps and the service/unit digest. These reads are not
an atomic snapshot: the service can restart between commands, so re-read
`MainPID` afterward and discard or annotate evidence if the identity changed.
Treat unit text as sensitive because command lines or `Environment=` entries can
contain credentials; redact values without discarding the unit's identity.
A process executable may be shown with `"(deleted)"` after an in-place
replacement—another reason to use immutable release paths. `sha256sum` is a
GNU/Linux command, not a POSIX standard.

Artifact verification before start can use:

```sh
set -eu
release_dir=$1
cd "$release_dir"
sha256sum --check SHA256SUMS
test -r manifest.json
test -x bin/trader
bin/trader --validate-only --config resolved-config.json
```

`--validate-only` is an illustrative **PV** interface; the important property is that the consuming binary validates its own schema/compatibility without acquiring trading authority. Because the candidate itself is under test, run this step behind an independent side-effect fence rather than trusting the flag alone.

### Release/drain checklist

| Phase | Checks | Commit/evidence | Failure action |
|---|---|---|---|
| Build/store | immutable bytes, manifest, symbols, provenance | artifact digest accepted | reject release |
| Stage | target bytes match digest; dependencies/privileges compatible | stage record | restage, no traffic |
| Start | self-identity, config/refdata/secrets, resource setup | startup generation | remain not-ready |
| Recover/warm | replay/reconcile and warm criteria | ready-no-authority record | halt or retry with bounds |
| Enable | old sender fenced; session/traffic generation transferred | authority commit | contain/reconcile |
| Expand | gates and capacity hold per cohort | cohort decision | stop expansion or rollback if open |
| Drain | no new risk; orders/outcomes reconciled | drain result | escalate containment |
| Stop/retire | authority released; evidence retained | stop/retention record | keep artifact for incident/rollback |

### Resource and storage surfaces

| Surface | Evidence | Failure policy to define |
|---|---|---|
| File descriptors | current count, limit, growth rate, allocation sites | reserve emergency control path; reject/shed without spin |
| Memory/cgroup | resident/locked/committed memory, faults/reclaim/OOM events | whether reclaim makes service not-ready; restart/contain policy |
| Threads/processes | current vs permitted; creation failures | precreate critical workers; bounded fallback |
| CPU quota/affinity | effective masks/quotas after orchestration | readiness failure if required topology absent |
| Disk bytes/inodes | free capacity and projected time-to-full | protect journal/core/root separately; retention/escalation |
| Log/audit pipeline | backlog, oldest age, drops, durable watermark | which records may be sampled, blocked, or force halt |
| Socket/NIC queues | occupancy/drops and configured limits | degrade before correctness loss |
| Core-dump path | size limit, destination, available capacity, symbols | preserve crash evidence without filling critical volume |

Resource values must be applied where the process actually runs. A shell profile does not configure a service launched by an unrelated supervisor. systemd unit limits, container/cgroup limits, kernel ceilings, and application bounds can all constrain the same resource; record the effective minimum.

Descriptor exhaustion can disable both service and diagnostics. Use RAII in code, monitor trend, and ensure the emergency control channel does not require an unavailable descriptor. If an accept loop sees resource exhaustion, it must not spin; exact shedding behavior belongs to that service.

A full/slow storage path can stop journals, audit records, checkpoints, logs, and core dumps together. Separate failure domains where justified, enforce retention before exhaustion, monitor bytes and inodes, and project time-to-full from write rate. Whether losing an audit/durable journal path requires cancel-only or halt is an **R/PV** decision; define it before the incident. Never ignore short writes or deferred sync errors.

Storage failure has several distinct shapes:

- `ENOSPC` or quota rejection of a new write;
- inode exhaustion despite free byte capacity;
- a blocked or high-tail I/O path with no immediate error;
- delayed writeback or sync error reported after earlier writes appeared successful;
- log shipper backlog while local retention continues to grow;
- rotation/compression needing temporary space; and
- core/checkpoint creation failing because logs share the volume.

Runbooks must prioritize evidence. Deleting an unshipped audit segment to make room for ordinary logs may violate the very control the incident requires. A preallocated emergency reserve can buy response time, but releasing it is an incident action, not ongoing capacity management. Retention deletion occurs only after the destination’s required durability/integrity confirmation, according to scoped policy.

During storage impairment, keep blocking I/O away from latency-critical threads, but do not silently discard execution or control evidence. Chapter 59 defines bounded telemetry loss behavior; Chapter 56 defines journal/audit recovery boundaries. This chapter decides which service mode is permitted when either path is unavailable.

### Capacity headroom

Capacity is multi-dimensional: critical-core service time, queues and oldest age, NIC/transport loss, memory bandwidth, storage backlog, venue throttles, control-plane capacity, and post-failure redistribution.

Do not prescribe one utilization percentage. Establish:

1. production-like steady and burst arrival distributions;
2. service and tail distributions for the candidate release;
3. acceptable queue age, not only depth;
4. headroom after losing the declared host/link/shard;
5. shadow/canary overhead;
6. drain/mass-cancel/control capacity during overload; and
7. abort thresholds tied to measured baseline.

For replicated capacity, compute the failed-state denominator. If \(N>1\) equal instances each have service capacity \(C\) and total load \(L\) redistributes perfectly after one failure, nominal utilization becomes:

\[
\rho_{\text{failed}}=\frac{L}{(N-1)C}
\]

This is only a first check: routing may be uneven, sessions may not be movable, caches are cold, and the failure itself may increase message/cancel volume. Capacity reserved for shadow or standby work may share memory bandwidth or NIC queues even before promotion.

Drain and incident controls need capacity too. A mass-cancel burst, log flush, state reconciliation, and telemetry surge happen when the service is already impaired. Test the control plane under the post-failure data-plane load rather than assuming emergency traffic is small.

Chapter 30 owns reference latency scales, Chapter 43 owns benchmark statistics, Chapters 46–48 own packet-path/NIC measurement, and Chapter 59 owns production telemetry.

---

## 60.11 Recall and Practice — Core

**Recall card.**

- Release identity = artifact/build + resolved config/refdata + state schema + protocol/product versions.
- Lifecycle: verify → stage → start → recover/warm → ready without authority → fence/enable → active → drain/reconcile → stop.
- Label claims **S**, **OS**, **OR**, **PV**, **R**, or **M**.
- Atomic config publication is incomplete without safe object lifetime/reclamation.
- State/protocol compatibility determines whether rollback remains open.
- Liveness, readiness, and authority are distinct; a PID is not permission to trade.
- Shadow mode needs an independent side-effect fence and spare capacity.
- Drain completion means external work reconciled, not cancel requests sent.
- A restart does not clear a kill/contained incident state.
- Resource/capacity values are derived from the target and post-failure load, never universal defaults.

### Common traps

- Treating a git SHA, image tag, or mutable path as complete release identity.
- Discarding exact debug symbols or binary-log dictionaries before their incident-retention horizon.
- Assuming a container or pinned compiler alone makes a build reproducible.
- Logging secret values in a resolved-config dump, process command line, or crash record.
- Ignoring unknown configuration keys or hiding implicit defaults from the digest.
- Publishing a new config pointer and immediately freeing the old object.
- Updating multi-field configuration in place so readers observe mixed generations.
- Calling an orchestrator’s “started” state application readiness.
- Making external dependency health part of liveness and causing a crash loop.
- Letting a candidate shadow send merely because an internal Boolean says it will not.
- Running old and new order senders without an effective downstream fence.
- Saying “rollback” after the old binary lost state/protocol compatibility.
- Killing the only process that can read the new state format during an incident.
- Marking drain complete after sending cancels, without processing racing fills or reconciling.
- Assuming cancel-on-disconnect, session takeover, or mass-cancel behavior across venues.
- Making the supervisor’s force-kill deadline shorter than measured safe drain.
- Clearing a persistent kill/contained state because a process restarted.
- Applying resource limits in an interactive shell rather than the actual service boundary.
- Watching disk percentage but not write rate, inodes, or the durable/audit backlog.
- Sizing capacity for normal balance while ignoring failover and shadow overhead.

### Interview questions

1. Which identities are needed to reconstruct exactly what a trading service ran, beyond a source revision?
2. Distinguish stage commit, readiness commit, authority commit, state-schema commit, and drain commit.
3. Why is an atomic pointer publication unsafe if the old configuration object is deleted immediately?
4. Give a phased state migration that keeps rollback open, and identify the step that closes it.
5. Why should an external dependency normally affect readiness rather than liveness?
6. How do you prove a shadow process cannot send an order if the candidate binary itself is untrusted?
7. What must happen between “cancel requests sent” and “safe to exit”?
8. In the worked failure, why is restarting Release A after `t4` unsafe even though A was previously healthy?
9. Which capacity dimensions must be checked after losing one instance, and why is steady-state CPU insufficient?
10. How should an incident state survive process restart, and what evidence permits resume?

### Puzzle: green probes, two active senders

During a blue/green handoff, Green reports ready. Automation changes a service endpoint to Green and then asks Blue to drain. The endpoint affects strategy traffic but not Blue’s already-established venue session. Blue receives one final strategy intent from a direct shared-memory producer while Green opens a second permitted session. Both send valid orders.

Explain why readiness and service routing did not enforce single-sender authority. Redesign the handoff with:

- producer-ingress fencing;
- an authority generation enforced at the side-effecting gateway/venue boundary;
- Blue quiescing before Green activation;
- journal/session watermark transfer and reconciliation; and
- evidence that no intent crosses the gap or is applied twice.

State what changes if the venue permits only one login—and why that still requires **PV** verification rather than assumption.

### Applied exercise

Take one real service and build a release ledger with columns:

```text
artifact digest | config/refdata digest | state schema
protocol versions | target | process state | readiness reasons
authority generation | first external effect | rollback open?
drain/reconciliation result | actor/release/incident ID
```

For each transition, inject one conceptual failure: corrupt staged bytes, missing secret, stale data, replay mismatch, warmup regression, partition during authority transfer, state migration halfway, cancel timeout, disk full, and supervisor hard kill. Name the invariant, surviving evidence, safe state, and next authorized action. Then implement the test mechanics in Chapter 57 and the telemetry/evidence path in Chapter 59.

**Prerequisite for Chapter 61.** The database-internals track assumes you can distinguish in-memory visibility, application commit, filesystem/device durability, and recoverable state-format migration. Those same boundaries reappear in storage engines as buffer-cache, WAL, checkpoint, and page-format contracts.
