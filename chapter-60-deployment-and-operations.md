# Chapter 60 — Deployment and Operations

*Interview-focused revision notes. The theme: a trading system cannot be casually restarted, so every operational property — configuration, rollout, warmup, shutdown, capacity — must be designed into the binary rather than improvised by an operator at 09:29.*

---

## 60.1 Reproducible Deployment Artifacts

A **reproducible build** is one where the same source, at the same revision, with the same toolchain, produces a bit-identical binary. The operational goal is narrower but strictly necessary: given a running process, you must be able to recover *exactly* the source and configuration that produced it, and rebuild it to get an identical (or at least behaviourally identical) result.

### Why bit-identity matters here specifically

- **Symbolization.** A binary log (Ch. 59 §59.5), a flight-recorder dump (Ch. 59 §59.13), or a core file is decoded against a symbol table and a format-string dictionary. If you cannot reproduce the exact binary, the dump is undecodable — the single most common cause of "we have the crash and we can't read it."
- **Latency regressions are layout-sensitive.** A change in link order, an inlining decision, or a different `.text` layout shifts branch-predictor and I-cache behaviour by measurable microseconds (Ch. 42). "Same source, different binary, different p99" is real, and without reproducibility you cannot attribute it.
- **Audit and regulation.** Reconstructing what algorithm was live at a given instant (§60.11) requires the binary, not a git SHA.

### The sources of non-determinism, and their fixes

| Source | Fix |
|---|---|
| `__DATE__`/`__TIME__`, build timestamps | `SOURCE_DATE_EPOCH`; ban the macros (`-Wdate-time`) |
| Absolute paths embedded in debug info | `-ffile-prefix-map=/build=.` (covers `-fdebug-prefix-map` and `__FILE__`) |
| Filesystem readdir order in build globs | Sort explicitly; never glob sources |
| Parallel-build nondeterminism in archives | `ar D` / deterministic mode (default in modern binutils) |
| Environment variables leaking in | Hermetic build (container or Nix/Bazel sandbox) with a fixed env |
| ASLR / PIE affecting nothing at build time but everything at symbolization | Record the load bias; or build non-PIE for the hot binary |
| Toolchain drift | Pin compiler, linker, libc, and every dependency by content hash |
| Link-time nondeterminism (LTO partitioning, `-flto=auto`) | Fix the partition count (`-flto=N`), pin the plugin version |

Tooling: **Bazel** and **Nix** enforce hermeticity by construction (content-addressed inputs, sandboxed actions); **Docker with a pinned base digest** gets you most of the way with far less investment but does not by itself make builds reproducible. `diffoscope` is the tool for finding *why* two supposedly identical artifacts differ.

### What ships in the artifact

```
artifact-<build_id>/
  bin/trader              # stripped, but with .note.gnu.build-id preserved
  bin/trader.debug        # separated debug info, uploaded to a symbol server
  dict/logsites.bin       # binary-log format-string dictionary (Ch. 59 §59.5)
  manifest.json           # git sha, dirty flag, toolchain hashes, dep versions,
                          # compile flags, build_id, CI job id, signature
  config/schema.json      # config schema this binary accepts (§60.9)
```

The **GNU build id** (`.note.gnu.build-id`, a hash of the linked output, `readelf -n`) is the join key. The running process exposes it (Ch. 59 §59.10 heartbeats carry it), the core file contains it, the symbol server is indexed by it, and the log dictionary is stamped with it. `debuginfod` serves debug info by build id automatically and is worth naming.

**Separate debug info** (`objcopy --only-keep-debug` + `--add-gnu-debuglink`, or `-gsplit-dwarf`) so the deployed binary is small and the page cache isn't polluted, while symbols remain available. Never deploy a binary whose debug info you did not keep — you cannot symbolize a core afterwards.

**Statically link where you can.** A dynamically linked hot binary pays for PLT indirection and lazy binding (mitigate with `-Wl,-z,now` full RELRO plus prelinking considerations, Ch. 41), and — worse operationally — its behaviour depends on the host's shared libraries, which are not part of the artifact. A statically linked binary (or one with all non-libc dependencies static) makes the artifact self-describing. The counter-argument is glibc's NSS/dlopen requirements and security patching of the transitive closure; the usual compromise is static everything except glibc, with glibc pinned by the base image digest.

---

## 60.2 Immutable Configuration

**Immutable configuration** means that a configuration is a versioned, content-addressed, read-only object; you never edit the config of a running system, you deploy a new config version. The alternative — an editable file that a process rereads — makes the effective configuration of the fleet unknowable.

### The failure this prevents

Mutable config produces **configuration drift**: host A was hand-edited during an incident six weeks ago, host B was not, and the divergence is invisible until the two behave differently under load. In trading this manifests as two instances quoting different spreads or applying different risk limits, which is a financial and regulatory event, not an inconvenience.

### The properties

| Property | Mechanism |
|---|---|
| **Versioned** | Monotonic `config_version` (integer or content hash) |
| **Content-addressed** | The version *is* the hash of the canonicalized bytes — makes "same config" checkable |
| **Immutable at rest** | Read-only mount, object store with versioning, or a git-backed store |
| **Immutable in-process** | Load once into a `const` structure; hot path reads through a `const&` |
| **Observable** | Every process exports its `config_version` in heartbeats and logs (Ch. 59 §59.10) |
| **Auditable** | Every change is a reviewed, signed commit (§60.11) |

The observability requirement is the operational payoff: a single query — "show me the distinct config versions running in the fleet" — must return exactly one row per intended cohort. Any unexpected row is drift, detected in seconds rather than weeks.

### Layering and its dangers

Config layering (defaults → environment → venue → host → overrides) is convenient and is where most config bugs live: the effective value is the result of a resolution algorithm no one can execute mentally. Requirements:

- **Emit the fully resolved configuration** at startup, into the log and to disk, with per-key provenance (`risk.max_notional = 5000000 (from venue/xnas.yaml:12, overriding defaults.yaml:88)`). This turns a debate into a lookup.
- **Fail on unknown keys.** A typo'd key that is silently ignored means the setting you thought you applied is not applied. Strict schema validation (§60.9) with unknown-key rejection is non-negotiable.
- **Fail on shadowed-but-unused overrides.** A host override for a key that no longer exists is dead config; warn loudly.

### In-process representation

```cpp
struct Config {                            // POD-ish, trivially copyable where possible
    uint64_t max_notional;
    uint32_t max_order_rate;
    uint16_t venue_id;
    bool     quoting_enabled;
    // no std::string on the hot path: intern to ids at load time (Ch. 13)
};
// Loaded once; hot path holds a const pointer published via a single atomic (§60.10).
```
Parse text config exactly once, at startup, into a flat trivially-copyable struct. The hot path must never touch a `std::map<std::string, std::string>`, never parse, and never allocate. Strings become interned ids; enumerations become integers; anything variable-length becomes a preallocated array. **Config parsing is startup work; config *reading* is a load from a hot cache line.**

---

## 60.3 Staged Rollout and Rollback

You cannot A/B test a trading system by sending half the orders to the new version and comparing P&L: the sample size required to distinguish strategies is enormous, the market regime shifts underneath you, and a bad version loses real money for the duration of the experiment. Staging is therefore about **limiting blast radius and shortening time-to-detect**, not about statistical comparison.

### The standard ladder

```
1. Unit / property tests, sanitizers            (Ch. 44, 57)
2. Deterministic replay against recorded market data — bit-identical outputs vs baseline
3. Simulation / exchange test environment (venue conformance)
4. Shadow mode in production: real market data, real decisions, orders NOT sent
   → compare decisions against the incumbent; the only test with production physics
5. One instance, one low-risk symbol/venue, small size limits
6. Widening cohorts: 1 host → 1 venue → all
7. Full fleet
```

**Shadow mode is the highest-value stage** and the one to lead with. The new binary consumes the same live multicast feed on the same host class, produces orders, and drops them at the gateway — while logging every decision. You then diff the shadow's decision stream against production's. It exercises real feed pathologies, real latency, real cache behaviour, and real message volumes, with zero market risk. The cost is a second consumer of the feed (NIC and CPU capacity, §60.14) and the discipline to make the comparison automated rather than eyeballed.

### Deployment mechanics under market-hours constraints

- **Deploy between sessions.** The default and correct answer: most latency-critical systems deploy outside market hours, full stop. An interviewer asking "how do you do canary in HFT" is often checking whether you know that *the safest rollout is the one that doesn't happen during trading*.
- **Blue/green with an idle standby.** Start the new version, let it warm up (§60.7) and reach readiness (§60.6) fully in parallel, then flip the session/entitlement to it. The old process stays resident, warm, and instantly re-flippable for the rest of the day. This makes rollback a pointer flip rather than a start-up.
- **Rollback must be faster than roll-forward and must be the default reaction.** Time-to-rollback is the metric: if rolling back takes 4 minutes because the old artifact must be fetched and warmed, you will spend 4 minutes trading badly. Keep the previous artifact resident on disk (and ideally warm in a standby process) at all times.
- **Never deploy a new version simultaneously with a new config or a new venue change.** One variable at a time; otherwise attribution during an incident is guesswork.

### Detection

The rollout gate must be automated and must key on the signals from Ch. 59: p99/p99.9 latency vs the incumbent, reject rate, fill rate, drop counters, error-log rate, and a decision-diff rate against shadow. **A rollout with no automated abort criterion is not staged, it's just slow.** Define the abort thresholds before the deploy, not during.

**Failure signature of an inadequate stage ladder:** the new version passes every offline test and fails in production on a message shape that only occurs during the auction, or on a burst rate that only occurs at 09:30. Both are exactly what shadow mode catches and no simulator does.

---

## 60.4 Feature and Venue Kill Switches

A **kill switch** is a pre-built, tested control that removes functionality without a restart. It exists because the alternative — a code change, build, and deploy — takes minutes, and the loss rate of a malfunctioning automated trader is measured in tens of thousands of dollars per second (the canonical reference being Knight Capital, 2012: ~$460 M in 45 minutes, and the specific failure was a deployment that missed one of eight servers combined with the reuse of a repurposed flag — a config/rollout failure, not an algorithmic one).

### The hierarchy

| Level | Scope | Latency to effect | Mechanism |
|---|---|---|---|
| Strategy flag | One strategy stops quoting | µs (next loop) | In-process atomic flag |
| Symbol kill | One instrument | µs | Bitmap indexed by symbol id |
| **Venue kill** | All activity on one venue: pull quotes, cancel resting, block new | ms | In-process + gateway enforcement |
| Global kill | Whole process goes flat and stops | ms | As above, plus mode change |
| **Out-of-band kill** | Independent of the process | ms–s | Gateway/risk system blocks, or session drop |
| Physical | Network isolation, power | s | Last resort |

The essential design principle: **the kill switch must not depend on the health of the thing it kills.** If the switch is a flag read by a wedged trading loop, a wedged loop ignores it. Hence the out-of-band layer — an independent risk gateway that drops orders, or an exchange-side cancel-on-disconnect that triggers when you deliberately drop the session (Ch. 50). Dropping the session is the most reliable kill available because it engages the exchange's own machinery.

### Implementation on the hot path

```cpp
// One cache line, read every loop iteration; branch is trivially predicted.
struct alignas(64) KillState {
    std::atomic<uint64_t> venue_mask;     // bit per venue: 1 = killed
    std::atomic<uint32_t> global_halt;
    std::atomic<uint32_t> generation;     // increments on any change; used for audit
};
// Hot path:
if (kill.venue_mask.load(std::memory_order_relaxed) & (1ull << venue)) [[unlikely]] return;
```
Cost: one L1 hit and a predicted branch, ~1 cycle amortized. Relaxed ordering is correct — you need the value to become visible promptly, not to order other memory; on x86 a relaxed load is a plain `mov` and store visibility is on the order of tens of nanoseconds regardless.

**Symbol-level kills as a bitmap** indexed by dense symbol id (Ch. 59 §59.2) keeps the check to a load-and-test rather than a container lookup.

### The parts people forget

- **Killing must include cancelling.** "Stop sending new orders" leaves resting quotes exposed to a market that just moved. Define kill semantics precisely: *stop new + cancel resting + optionally hedge flat*. The cancel path must itself be tested and must work when the strategy is wedged.
- **The switch must be tested regularly.** An untested kill switch is a belief, not a control. Exercise it in production during quiet periods on a schedule.
- **State the re-enable procedure.** Re-enabling must be as deliberate as killing was urgent — with a human decision, a fresh risk check, and a warmup (§60.7), because the process has been idle and its caches are cold.
- **Persist and audit every toggle** (§60.11): who, when, from where, why, and the `generation` value, so the reconstruction is unambiguous.
- **Fail-safe defaults.** On any ambiguity — unreadable config, lost heartbeat from the risk system, unknown venue id — the safe state is *killed*, not *enabled*. This must be the default in code, because the default is what runs when the surprising thing happens.

---

## 60.5 Startup Dependency Ordering

A trading process depends on: reference data (instruments, tick sizes, expiries), risk limits, market-data feeds (with their sequence state), order-entry sessions, clock synchronization, shared-memory segments produced by other processes, and possibly a position/state snapshot from the previous session. Starting to trade before any of these is correct is a direct route to bad orders.

### The dependency graph and its enforcement

```
   PTP sync locked ──┐
   ref data loaded ──┼──▶ risk limits loaded ──▶ MD subscribed & in-sync ──┐
   shm segments up ──┘                                                     ├──▶ READY
                            OE session logged in & sequence-recovered ─────┘
```

Two enforcement styles:

| Style | Mechanism | Trade-off |
|---|---|---|
| **External ordering** | systemd `After=`/`Requires=`, or an orchestrator DAG | Declarative and visible, but "started" ≠ "usable" |
| **In-process readiness gating** | Each dependency has a predicate; trading enables only when all are true | Correct, self-describing, and survives restarts of dependencies |

The correct answer combines them: use the orchestrator for coarse ordering, but **never trust it for correctness** — the process must independently verify each precondition and refuse to trade until satisfied. systemd's `After=` only orders *start*, not *readiness*; `Type=notify` plus `sd_notify(READY=1)` is what actually communicates readiness, and a dependency using `Type=simple` is considered "started" the instant `fork` returns.

### Specific preconditions worth naming

- **Clock sync.** Refuse to trade if PTP is not locked (check `phc2sys`/`ptp4l` offset and the PHC's state; Ch. 59 §59.9). Trading with an unsynchronized clock corrupts every timestamp you produce, including regulatory ones.
- **Market-data sequence recovery.** After subscribing you have a partial book. You must either replay a snapshot and apply the buffered incrementals, or wait for a natural refresh — and you must know you are in sync via the exchange's sequence numbers (Ch. 37, Ch. 50). Quoting from an incomplete book is the classic startup accident.
- **Reference data freshness.** A stale instrument file (yesterday's expiries, missing new listings, wrong tick size after a corporate action) produces orders the exchange rejects, or worse, accepts at a wrong price. Validate the file's business date against today's session (§60.9).
- **Position/state reconciliation.** After a restart mid-session, the process must recover its live orders and position from the exchange (order mass status request / drop copy) before deciding anything. **Never trust an internal snapshot alone**; reconcile against the venue.
- **Warmup completion** (§60.7) as an explicit gate, not a hope.

### Failure modes

- **Circular dependencies** — A waits for B's shared memory, B waits for A's heartbeat. Signature: two processes both in "waiting for dependency" forever. Break with a defined bootstrap order and a timeout that fails loudly rather than waiting silently.
- **Retry storms** — every process retries a downed reference-data service every 100 ms, and when it returns it is immediately overwhelmed. Use exponential backoff with jitter.
- **Silent partial readiness** — the process reports ready with three of four feeds connected. Readiness must be a conjunction over an explicitly enumerated set, with the *missing* items named in the log and in the health output.
- **Ordering that only works because of timing** — "it works if the feed handler starts two seconds earlier." Signature: fails on a faster machine, or after a startup optimization. Any dependency satisfied by a `sleep` is a bug.

---

## 60.6 Readiness Versus Liveness

**Liveness**: is the process alive and making progress? Failing liveness means *restart me*. **Readiness**: is the process currently able to do its job correctly? Failing readiness means *don't send me work*, but do **not** restart me.

Conflating them is one of the highest-consequence operational bugs, and the mechanism is worth stating precisely: if a readiness condition (e.g. the market-data feed is momentarily gapped, or a dependency is slow) is wired to the liveness probe, the supervisor kills a perfectly healthy process — and if the condition is fleet-wide, it kills *every* process, converting a degraded state into a total outage with cold caches everywhere.

| | Liveness | Readiness |
|---|---|---|
| Question | Am I progressing? | Can I trade correctly right now? |
| Evidence | Loop counter advanced within N ms (Ch. 59 §59.10) | All preconditions of §60.5 currently true |
| Failure action | Restart / escalate | Stop quoting, drain, alert |
| Should depend on external systems? | **No** | Yes |
| Frequency | 1–10 Hz | 1–10 Hz |
| Timeout | Several intervals | Immediate |

**Liveness must not depend on anything external.** This is the single rule that prevents cascading restarts: an exchange outage should make you *not ready*, never *not alive*.

A third state is worth having and is often omitted: **startup/warming**, distinct from both. A process that is alive, not yet ready, and legitimately still warming (§60.7) must not be reported as failed; otherwise deploy automation aborts every rollout. Kubernetes models this with a `startupProbe` that suppresses liveness until initial startup completes; systemd models it with `Type=notify` and `TimeoutStartSec`.

```cpp
enum class State { Starting, Warming, Ready, Degraded, Draining, Halted };
// Liveness  := last_loop_tsc is recent  (state-independent)
// Readiness := state == Ready
// Degraded  := alive, was ready, a precondition failed → stop quoting, keep the session
```
Exposing the *reason* alongside the state is what makes it operable: `Degraded: md_feed_b gapped since 09:41:03.221, seq 4,102,881`. A boolean readiness probe with no reason string forces an operator to go looking, and the looking happens during the incident.

**Diagnostic signatures.** Restart loops whose period equals the readiness timeout mean readiness is wired to liveness. A fleet-wide simultaneous restart at the moment an upstream dependency blipped is the same bug at scale. A process that is "ready" while its data is stale means readiness is asserting on the wrong evidence (Ch. 59 §59.10).

---

## 60.7 Startup Warmup and Cache Priming

A freshly started process is **cold** in every cache in the machine, and the first message through the critical path can be 10–100× slower than the steady-state path. The components:

| Cold resource | First-touch cost | Priming technique |
|---|---|---|
| I-cache / µop cache | Instruction fetch misses through the whole path | Run the real code path with synthetic input |
| **iTLB / dTLB** | Page walks, ~100+ cycles each | Huge pages (Ch. 32), pre-touch, keep the hot path compact |
| Branch predictors / BTB | Every branch mispredicts (~15–20 cycles) | Execute the path repeatedly with realistic branch outcomes |
| D-cache, order book structures | Misses to DRAM, ~80–100 ns each (Ch. 28) | Touch the working set; keep it resident |
| **Page faults on first write** | ~1–3 µs each; minor, but on the critical path | Pre-fault: allocate and `memset`, plus `mlockall(MCL_CURRENT\|MCL_FUTURE)` |
| Lazy symbol binding (PLT) | ~1 µs on first call per symbol | `-Wl,-z,now` (full RELRO) or `LD_BIND_NOW=1` |
| **Kernel/NIC state** | ARP, route cache, socket buffers, NIC descriptor rings | Send/receive real traffic |
| CPU frequency / C-states | Ramp from low frequency; C-state exit latency | Pin, disable deep C-states, keep a busy-poll loop (Ch. 35) |
| Allocator arenas | `mmap` on first allocation | Preallocate all pools at startup (Ch. 7, Ch. 8) |
| JIT-equivalent (none in C++) | — | — |

### The technique that actually works

Synthetic warmup means running the **real** code path end-to-end with fabricated input, with the actual order-send suppressed at the last possible point:

```cpp
// Warmup: identical code path; the gateway drops the message instead of writing to the socket.
for (int i = 0; i < 100'000; ++i) {
    MarketDataMsg m = synth.next();          // realistic shapes, realistic branch mix
    engine.on_market_data(m);                // parses, updates book, decides, encodes
}                                            // send path stubbed at the socket boundary
```

Two subtleties that separate strong answers:

1. **The warmup traffic must be representative of the branch mix**, not a single repeated message. Warming with 100 000 identical quotes trains the branch predictor to expect *that* message, and the first real, different message mispredicts anyway. Feed recorded market data.
2. **Warmup wears off.** After a quiet period — a lull, a lunch hour, an idle instrument — the caches are evicted by other work and the next real message is cold again. This is why systems run a continuous low-rate **keep-warm** loop: periodically push a synthetic message through the whole path (dropped at the gateway), keeping I-cache, TLB, predictors, and NIC descriptor rings hot. Doing this every few hundred microseconds costs a fraction of a percent of a core and removes the single largest source of tail latency in a quiet market.

### Also part of warmup

- **`mlockall(MCL_CURRENT | MCL_FUTURE)`** after preallocation, so nothing is ever swapped or reclaimed; combined with `vm.swappiness=0` and cgroup memory limits sized above the working set.
- **Pre-touch every page** of every pool, ring, and flight recorder (Ch. 59 §59.13) — allocation reserves address space, not physical pages; the fault happens on first *write*.
- **Prime the TCP/session path** by completing the login and any session-level handshake well before you need it; a first-message TLS handshake or a slow-start ramp is measured in milliseconds.
- **Warm the NIC path** with real packets so the ARP entry, the route, and the NIC's TX descriptors and any kernel-bypass state are established (Ch. 47).

**Diagnostic signature of missing warmup:** a latency histogram with a distinct high mode containing exactly the first few hundred samples after start or after each idle gap; `perf stat` on the early window shows elevated `iTLB-load-misses`, `branch-misses`, and `page-faults` relative to steady state. The "first trade of the day is 50 µs, the rest are 3 µs" report is this, every time.

---

## 60.8 Safe Shutdown and Draining

Killing a trading process leaves resting orders in the market with no one managing them. Shutdown is therefore a protocol, not a signal.

### The drain sequence

```
1. Enter Draining state → stop generating NEW orders (readiness false, §60.6)
2. Cancel all resting orders; wait for cancel acknowledgements
3. Optionally flatten position (hedge) — a policy decision, usually human-approved
4. Confirm zero live orders via the exchange's own view (mass status / drop copy)
5. Flush: log rings, flight recorder, metrics final scrape, state snapshot (§60.11)
6. Log out of the order-entry session cleanly
7. Unsubscribe from market data
8. Exit
```

Steps 2 and 4 are the ones candidates omit. **"I sent cancels" is not "my orders are cancelled"** — a cancel can be rejected (already filled, or in a state that disallows it), and a fill can arrive after your cancel was sent. You must reconcile against the venue's view before you may safely exit, and you must handle a fill arriving during the drain.

### Signals and their handling

`SIGTERM` must initiate the drain, not the exit. Signal handlers are async-signal-safe-only (Ch. 33), so the handler does exactly one thing:

```cpp
volatile std::sig_atomic_t g_shutdown = 0;
extern "C" void on_sigterm(int) { g_shutdown = 1; }      // async-signal-safe: a single store
// Main loop notices and drives the drain from normal context.
// Preferred: signalfd or an eventfd woken by the handler, so the poll loop handles it.
```
`signalfd`/`eventfd` integrates the signal into the event loop and avoids the entire class of signal-safety bugs. Never call `printf`, allocate, or take a lock in a handler.

**Timeouts matter in both directions.** The supervisor's `TimeoutStopSec` (systemd) or `terminationGracePeriodSeconds` (Kubernetes) must exceed the drain's realistic worst case, or `SIGKILL` arrives mid-drain and leaves orders resting — the exact outcome you were preventing. Conversely, the drain must have its own internal timeout: if cancels are not acknowledged within N seconds, escalate to dropping the session so **cancel-on-disconnect** fires (Ch. 50), and alert a human.

### Cancel-on-disconnect as the safety net

Most venues offer cancel-on-disconnect (COD): the exchange pulls your resting orders when your session drops. This is the backstop for `SIGKILL`, power loss, and network partition. Two cautions worth raising: COD semantics vary by venue (some cancel only day orders, some have a delay of seconds, some require explicit enablement per session), and **COD is not a substitute for a drain** — it fires on disconnect, which means a brief network blip cancels everything and you re-enter cold. Know which venues you have it on and with what delay.

### Restart-during-hours considerations

- **State must survive.** Persist enough (open orders, position, sequence numbers, config version) that a restart can reconcile rather than rediscover. Persist it *before* it's needed, on a path that cannot block the hot path — the flight recorder and a periodic snapshot to a memory-mapped file.
- **A restart is cold** (§60.7). Budget for warmup and for market-data resynchronization before re-enabling quoting.
- **Prefer flip-to-standby over restart** (§60.3, §60.13): a warm standby that takes over is strictly better than a cold restart, provided the handover cannot double-trade.

**Signature of a botched shutdown:** orders resting at the venue with no owning process; the drop copy shows fills after your process's last log line. This is a reportable event and the reason drain correctness gets scrutinized in interviews.

---

## 60.9 Configuration and Reference-Data Validation

Reference data — the instrument master, tick-size tables, lot sizes, expiries, corporate actions, holiday calendars, venue fee schedules, risk limits — changes daily and is produced by systems you do not control. It is the most common source of production incidents in trading systems that are otherwise well engineered, because a bad value is *accepted* rather than *rejected*: the system runs, and does the wrong thing at full speed.

### Validation layers

| Layer | Checks | When |
|---|---|---|
| **Schema** | Types, required keys, ranges, enums, **unknown-key rejection** | Parse |
| **Referential** | Every symbol referenced by a strategy exists; every venue id is known | Load |
| **Business** | Tick size divides the price grid; expiry ≥ today; lot size > 0; limits > 0 | Load |
| **Freshness** | File's business date == today's session date; generated within N hours | Load |
| **Sanity / delta** | Change vs yesterday within tolerance: symbol count ±2%, no price reference moving >20% | Load |
| **Cross-source** | Two independent feeds of the same data agree | Load |

The **delta check against yesterday is the highest-value single validation.** Absolute bounds cannot catch "the tick size for this instrument is 0.01 instead of 0.0001" — both are plausible values. But "3 400 instruments today vs 8 900 yesterday" or "this instrument's tick size changed by 100×" is unambiguously suspicious and is exactly the shape of a truncated file, a failed upstream job, or a units change. Refuse to start, and require an operator override with a recorded reason.

```cpp
// Fail-closed with a precise, actionable message. Never default silently.
if (auto n = instruments.size(); n < prev_count * 0.95 || n > prev_count * 1.05)
    fatal("instrument count {} deviates >5% from yesterday's {} — refusing to start "
          "(override with --accept-refdata-delta and a recorded reason)", n, prev_count);
```

### Rules

- **Fail closed, at startup, loudly.** A missing or invalid value must never fall back to a default. A default risk limit is how you get an unlimited one.
- **Validate before the artifact is deployed, not just at load.** Run the same validator in CI against the candidate reference data, so a bad file is caught at 05:00 by a job, not at 09:29 by a trader.
- **Validate on the *consuming* binary's schema.** The binary that will use the data must accept it; a validator built from a different version proves nothing. Ship the schema in the artifact (§60.1) and validate with the deployed binary itself (`--validate-only` mode).
- **Canonicalize before hashing** so that formatting-only changes don't churn the config version, and content changes always do.
- **Treat risk limits as reference data with extra scrutiny**: two-person review, separate approval path, and an independent enforcement point (§60.4) that does not trust the strategy's copy.

**Diagnostic signature of a reference-data bug:** a wave of exchange rejects with a consistent reason code (invalid price increment, unknown symbol, invalid lot size) starting exactly at session open, affecting a coherent subset of instruments. Contrast with a *code* bug, which typically affects instruments incoherently or correlates with a message shape rather than a symbol set.

---

## 60.10 Atomic Configuration Updates

Some parameters must change intraday — risk limits, spreads, enable flags, venue kills (§60.4). The requirement is that the hot path observes a **consistent snapshot**: never a mixture of old and new values, and never a torn read, with zero added cost in the common case.

### What goes wrong without atomicity

Two related fields updated separately (`min_spread` and `max_spread`) can be read in an inconsistent combination for a few microseconds — long enough to submit thousands of orders at an invalid spread. The bug is intermittent, load-dependent, and untestable by inspection: the classic reason "we just write both fields under a mutex" is wrong (the hot path must not take a lock) and "we write both fields and they're small" is wrong (no ordering guarantee, and no atomicity of the pair).

### The correct pattern: publish an immutable snapshot behind one atomic pointer

```cpp
struct Config { /* flat, trivially copyable, all fields (§60.2) */ };

std::atomic<const Config*> g_cfg;                          // the only mutable state

// Hot path: one relaxed/acquire load, then all reads from a consistent object.
const Config* c = g_cfg.load(std::memory_order_acquire);   // plain mov on x86
if (qty > c->max_qty) reject();                            // c never changes under us

// Update thread: build the new object completely, then publish with one release store.
auto* n = new Config(parse_and_validate(bytes));           // off the hot path
g_cfg.store(n, std::memory_order_release);                 // single atomic publish
retire(old);                                               // reclamation problem (below)
```
The acquire/release pair is what makes the fully-constructed `Config` visible before the pointer that names it (Ch. 25). Cost on the hot path: one load of a hot cache line, ~1 cycle amortized. Reading `c->field` repeatedly is free — it's an ordinary load from a resident line.

### Reclamation is the hard part

You cannot `delete` the old `Config` immediately: a hot thread may still hold the pointer. Options (Ch. 26):

| Scheme | Hot-path cost | Notes |
|---|---|---|
| **Never free** | 0 | Perfectly acceptable if updates are rare (a few KB per update, bounded by session length). **The right default.** |
| **RCU / epoch-based** | ~2 relaxed stores per loop | Reader marks a quiescent point; writer waits for a grace period |
| Hazard pointers | 1 store + fence per read | Fence cost is real on x86 (`mfence`/`lock`); usually too much |
| `shared_ptr` + atomic | Atomic RMW on refcount | **Wrong** — a contended RMW per read, plus `atomic<shared_ptr>` may use a lock |
| Seqlock (copy the struct) | Copy + 2 loads + retry | Good when the config is small and readers can copy |

For configuration specifically, "allocate a new one and never free" is usually correct and should be stated confidently — it converts a hard concurrency problem into a trivial memory-budget problem.

### Operational requirements around the update

- **Validate fully before publishing** (§60.9). A failed update must leave the old config in place; there is no partial application.
- **Bump and export a `config_version`** with every publish, and include it in every subsequent log record and heartbeat (Ch. 59 §59.10) so a decision can be attributed to a configuration.
- **Log the diff**, not the whole config: `risk.max_notional 5,000,000 → 2,000,000 (by alice, ticket OPS-8812)`.
- **Some parameters must not be hot-updatable.** Anything affecting preallocated sizes, thread pinning, or memory layout requires a restart; make the schema mark them `restart_required` and reject an attempted live change rather than half-applying it.
- **Ratchet dangerous directions.** Loosening a risk limit intraday should require a stricter approval path than tightening it; tightening should always be allowed instantly.

---

## 60.11 Audit Trails

An **audit trail** is a durable, tamper-evident record sufficient to reconstruct what the system did and why. In trading it is simultaneously an engineering tool (post-incident reconstruction), a business requirement (P&L attribution, client queries), and a legal obligation.

### What regulation actually demands

- **MiFID II RTS 25 / RTS 6** (EU): clock synchronization to within 100 µs of UTC for high-frequency algorithmic trading (1 ms for other activity), with traceability to UTC and recorded timestamp granularity of 1 µs or finer; retention of records for five years. This is why PTP is not optional (Ch. 59 §59.9) and why §60.5 gates trading on clock lock.
- **SEC Rule 613 (CAT)** and FINRA order-audit obligations (US): reportable order lifecycle events with prescribed timestamp granularity.
- **SEC Rule 15c3-5** (market access): pre-trade risk controls under the broker's exclusive control — the regulatory basis for an *independent* risk gateway (§60.4).
- **Retention**: multi-year, on WORM (write-once-read-many) or equivalently immutable storage, with demonstrable integrity.

Naming RTS 25's 100 µs and the five-year retention is a concrete, checkable detail that lands well.

### What to record

| Category | Content |
|---|---|
| Order lifecycle | New / modify / cancel / ack / reject / fill, with venue and internal timestamps |
| Decision context | The market state (top of book, sequence numbers) that triggered the decision, via trace id (Ch. 59 §59.8) |
| Configuration | `config_version` in force, and every change with actor, time, diff, and approval |
| Deployment | Artifact build id, deploy time, actor, rollout stage |
| Control actions | Every kill-switch toggle, limit override, manual cancel, with actor and reason |
| Reference data | Which files, their hashes, their business dates, and any override |
| Operator access | Logins to trading hosts, commands run |

### Engineering properties

- **Append-only and hash-chained.** Each record includes the hash of the previous record; the chain head is periodically published (to a separate system or signed). This makes retroactive alteration detectable without needing a special filesystem, and is cheap.
- **Written off the hot path.** The hot path writes to the binary ring (Ch. 59 §59.5); a backend thread durably persists. The audit record is derived from the same event stream, not produced by a second, divergent code path — **two independent recording paths will disagree, and the disagreement will surface during an investigation.**
- **Durability boundary must be explicit.** `write()` returns after copying to the page cache; the data is not on disk until `fsync`/`fdatasync` (Ch. 34), and a machine loss between them loses records. Decide deliberately: `fdatasync` per batch (milliseconds of latency, off the hot path, bounded loss) or replicate to a second host synchronously.
- **Timestamps must state their domain** (Ch. 59 §59.9). An audit record with an ambiguous clock is much weaker evidence.
- **Reconstruction must be tested.** An audit trail nobody has ever replayed is a hypothesis. Periodically rebuild a full session from the archive and diff it against the live record — this also validates that the binary-log dictionary and build ids are being retained correctly (§60.1).

---

## 60.12 Resource Limits and Descriptor Exhaustion

Resource limits are the boundary between "degraded" and "undefined." A latency-critical process should reach them never, and should fail comprehensibly when it does.

### The limit surfaces

| Resource | Limit | Symptom at exhaustion |
|---|---|---|
| File descriptors | `RLIMIT_NOFILE`, `/proc/sys/fs/file-max`, `fs.nr_open` | `accept`/`open`/`socket` → `EMFILE`/`ENFILE` |
| Memory | `RLIMIT_AS`, cgroup `memory.max` | `mmap` fails, or the **cgroup OOM killer** kills the process |
| Locked memory | `RLIMIT_MEMLOCK` | `mlockall` fails → pages swappable; also breaks RDMA/`io_uring` registration (Ch. 47) |
| Threads/processes | `RLIMIT_NPROC`, `pids.max` | `pthread_create` → `EAGAIN` |
| RT scheduling | `RLIMIT_RTPRIO`, `sched_rt_runtime_us` | `sched_setscheduler` → `EPERM`; or an RT thread throttled at 95% |
| Core dumps | `RLIMIT_CORE`, `core_pattern` | **No core file after a crash** — a silent loss of the only evidence |
| Socket buffers | `net.core.rmem_max`, `wmem_max` | `SO_RCVBUF` silently clamped → drops under burst (Ch. 46) |
| NIC ring size | `ethtool -g` | `rx_no_buffer`/`rx_missed_errors` under burst |
| Ephemeral ports | `ip_local_port_range` | `connect` → `EADDRNOTAVAIL` |
| Conntrack table | `nf_conntrack_max` | Silent drops; `nf_conntrack: table full` in dmesg |
| Inotify watches | `max_user_watches` | Config-watching silently stops working |

### Descriptor exhaustion in particular

`EMFILE` is the archetypal cascading failure because the consequences are far-reaching and the error is usually mishandled. When `accept()` returns `EMFILE`:

- A naive loop calls `accept()` again immediately, gets `EMFILE` again, and spins at 100% CPU while the connection stays in the accept queue — a level-triggered epoll storm. **Signature: 100% system CPU, no progress, `EMFILE` flooding the log.** The standard mitigation is to keep a "spare" fd open at startup, close it on `EMFILE`, `accept()` and immediately `close()` the connection to shed it, then reopen the spare.
- Every *other* subsystem fails simultaneously — you cannot open a log file, a core file, or a socket to the exchange. Diagnosis is hard precisely because the diagnostics are also failing.

Causes are almost always leaks: an error path that doesn't `close`, a `dup` without a matching close, timers/eventfds created per event, or `epoll_ctl(ADD)` without `DEL`. **Use RAII for every descriptor** (Ch. 9) — a `unique_fd` type with a custom deleter is the cheapest possible prevention and a good thing to mention. Diagnose with `ls /proc/<pid>/fd | wc -l`, `lsof -p`, and a monotonic trend on an fd-count gauge; the *trend* is what catches it before the outage.

### Configuration discipline

- **Set limits explicitly in the unit file** (`LimitNOFILE=`, `LimitMEMLOCK=infinity`, `LimitRTPRIO=`), not in a shell profile — a service started by systemd never reads your `.bashrc`, which is why "it works when I run it by hand" is a recurring confusion.
- **Set them as code** (§60.13), not by hand on the host.
- **Export current-vs-limit as gauges** for every resource you can (fds, RSS vs cgroup limit, thread count) and alert on the ratio, not on the failure.
- **cgroup v2 memory**: `memory.max` triggers the OOM killer; `memory.high` throttles by inducing reclaim, which shows up as multi-millisecond stalls in the hot path rather than a kill — a nastier failure. For a latency-critical process, size the cgroup above the fully-touched, `mlock`ed working set and treat any reclaim activity (`memory.stat` / `pgscan`) as an incident.
- **`RLIMIT_CORE` must be set and `core_pattern` must point somewhere with space.** The most galling operational failure is a rare crash that produces no core because the limit was 0 (Ch. 58).

---

## 60.13 Disk and Log-Retention Failures

A full disk turns a trading system into an unpredictable one. The failure is common because logging volume is bursty and correlates with the incidents during which you most need the logs.

### The direct effects

| Effect | Mechanism |
|---|---|
| Writes fail | `write` → `ENOSPC`; a logger that ignores the return code silently loses everything |
| **Writes block** | On some paths a full or slow disk blocks in `D` state — if a trading thread ever writes, it stalls for milliseconds or longer |
| Audit trail stops | Regulatory exposure (§60.11), and post-incident reconstruction becomes impossible |
| Cores cannot be written | A crash produces no evidence (§60.12) |
| Databases/state snapshots corrupt | Partial writes on `ENOSPC` if the writer isn't careful |
| Log rotation fails | `logrotate` needs space to copy; a full disk makes rotation fail, guaranteeing the disk stays full |

That last one is the trap: the mechanism that is supposed to reclaim space requires space. `copytruncate` mode is worse still — it copies the file and truncates the original, requiring a full duplicate of the file's size, and it loses any writes that land between the copy and the truncate.

### Also: filesystem-level latency effects

Even with space, the I/O path can inject latency into a supposedly isolated system:

- **Page-cache writeback** (`dirty_ratio`, `dirty_background_ratio`) can trigger synchronous writeback in the writing thread when the dirty limit is hit — a multi-millisecond stall in whatever thread happens to touch it. Tune `vm.dirty_bytes` to a small value so writeback is continuous and background rather than bursty and blocking.
- **`fsync` on ext4 with default journaling** can serialize far more than your file's data.
- **Any hot-path thread touching the filesystem is a design bug** (Ch. 34). Logging goes through the ring to a backend thread (Ch. 59 §59.6); the hot path issues no syscalls.
- **Filling the page cache with log data evicts nothing you care about directly** (your hot pages are `mlock`ed, §60.7) but does add kernel time in reclaim; `posix_fadvise(POSIX_FADV_DONTNEED)` after writing log data keeps the cache clean, and `O_DIRECT` avoids it entirely at the cost of alignment requirements.

### Operational controls

- **Separate filesystems** for logs, cores, state, and the OS. A full log volume must not be able to prevent a core dump or wedge the root filesystem. This is the single most effective structural fix.
- **Reserve headroom** (`tune2fs -m`, or simply a preallocated ballast file you can delete during an incident to buy time).
- **Alert on rate of change, not just level.** "Disk 85% full" at 09:00 is fine; "disk filling at 2 GB/min" gives you the twelve minutes you need. Project time-to-full and alert on that.
- **Retention as policy, enforced automatically**: compress after N hours, ship to object storage, delete locally after M days, with the regulatory retention (years, §60.11) satisfied by the remote copy, not the local disk.
- **Check `write` return codes and short writes.** A logger that ignores `ENOSPC` or a partial write silently corrupts the stream; the audit trail's hash chain (§60.11) will then fail to verify, which is at least a detectable signature.
- **Watch inode exhaustion** separately (`df -i`): many small files (per-connection logs, per-day cores) exhaust inodes while the volume shows free space — signature is `ENOSPC` with plenty of bytes free, which reliably confuses people.

---

## 60.14 Capacity Headroom

**Capacity headroom** is the margin between the load a system routinely handles and the load at which its latency distribution degrades. For a queueing system that margin is not linear, and this is the central quantitative point of the section.

### Why utilization is the wrong target

For an M/M/1 queue, mean waiting time scales as `ρ/(1-ρ)` where ρ is utilization:

```
 ρ = 0.50 → queue delay = 1.0 × service time
 ρ = 0.70 → 2.3 ×
 ρ = 0.80 → 4.0 ×
 ρ = 0.90 → 9.0 ×
 ρ = 0.95 → 19.0 ×
 ρ = 0.99 → 99.0 ×
```

Real market-data arrivals are far burstier than Poisson, so the real curve is worse. Two consequences:

1. **Latency degradation is a cliff, not a slope.** A system comfortable at 70% is catastrophic at 90%, and market-data rates routinely spike 10–50× on news, at the open/close, and during auctions. A design point of 50% *of peak observed* — not of average — is the usual target.
2. **Averages hide it entirely.** A 1-second average showing 30% CPU is consistent with 100% utilization for 300 ms bursts. Capacity planning must be done against burst rates measured at microsecond-to-millisecond granularity, from packet captures, not from 1-minute Prometheus samples. This is the single most common capacity-planning mistake.

### The dimensions that saturate

| Dimension | Metric | Practical ceiling |
|---|---|---|
| CPU on the critical core | Loop iterations vs message rate; time in the loop | Design for peak-burst < 50% duty |
| NIC / PCIe | pps and bps vs line rate; `rx_missed_errors` | Drops begin well below nominal line rate for small packets |
| Kernel/bypass RX ring | `rx_no_buffer`, ring occupancy | Sized in packets, so a burst of small messages fills it fast |
| Memory bandwidth | `perf stat` uncore counters | Shared with every other core on the socket (Ch. 29) |
| Order-entry rate limits | Venue-imposed messages/sec | Exceeding it → throttling or session drop |
| Internal queues | High-water marks | The true early-warning signal |
| Log/audit I/O | Bytes/sec vs disk throughput | §60.13 |

**Instrument queue high-water marks, not just averages.** A queue whose maximum depth over a 1-second window rose from 3 to 400 is the earliest and clearest signal of capacity pressure, well before latency moves. It is cheap (one compare-and-store per enqueue) and it is the metric to name when asked "what would you monitor for capacity."

### Failover and its capacity implication

- **Active/standby** is the norm for trading: a warm standby consumes the same market data, maintains the same book, and is fully warmed (§60.7), but does not send orders. Failover is a flip of the send entitlement. Cost: full duplicate capacity, permanently. Benefit: failover in milliseconds with warm caches and a live session.
- **The standby must be genuinely warm** — same feed, same code path, keep-warm loop — or failover moves you onto a cold process at the worst moment, which is the classic disappointment.
- **The hard part is preventing double-trading.** Two processes each believing they are primary will each send orders. Resolution requires a single authoritative arbiter (a lease with a bounded, monotonic term; or the exchange session itself as the token — only one session can be logged in, so the session *is* the mutex). Never rely on "the other one seems dead"; network partitions make that indistinguishable from "the other one can't see me."
- **N+1 across a fleet degrades badly.** If eight instances share the load at 70% each and one fails, the remaining seven need 80% — which, by the queueing curve above, roughly doubles queue delay. Headroom must be sized for the post-failure state, not the steady state. This is the argument that ties this section back to the queueing math and is worth making explicitly.

---

## Key Interview Questions

1. **Why does bit-reproducibility matter operationally, beyond purity?** — Symbolizing cores and binary logs requires the exact binary; latency is layout-sensitive so "same source, different binary" can mean different p99; and audit reconstruction needs the artifact, not a git SHA.
2. **What ties a running process, a core file, a symbol server, and a binary-log dictionary together?** — The GNU build id (`.note.gnu.build-id`), exposed in heartbeats, embedded in the core, indexing the symbol server (`debuginfod`), and stamped on the log dictionary.
3. **What is configuration drift and how does immutable config prevent it?** — Divergence from hand edits, invisible until behaviour differs. Content-addressed versions plus exporting `config_version` in every heartbeat makes "distinct versions in the fleet" a one-line query.
4. **How do you change a multi-field config atomically without a lock on the hot path?** — Build a complete new immutable `Config`, publish it with one release store into an `atomic<const Config*>`; readers do one acquire load and then read a consistent object. Reclamation: never free (correct default for rare updates), or RCU/epoch. Not `atomic<shared_ptr>` — that is an atomic RMW on a contended refcount per read, and may be lock-based.
5. **What is shadow mode and why is it the highest-value rollout stage?** — The new binary runs on live production data producing real decisions with orders dropped at the gateway; you diff its decision stream against the incumbent's. It has real feed pathologies, real volumes, and real cache behaviour with zero market risk.
6. **How do you roll out during market hours if you must?** — You mostly don't. If forced: blue/green with a fully warmed standby, flip the entitlement, keep the old process resident for instant rollback, one variable at a time, with pre-agreed automated abort criteria on latency, rejects, and drop counters.
7. **What is the essential property of a kill switch?** — It must not depend on the health of what it kills. Hence an out-of-band layer: an independent risk gateway, or deliberately dropping the session so exchange cancel-on-disconnect fires.
8. **Killing a strategy — what does "kill" have to include?** — Stop new orders *and* cancel resting ones (and possibly flatten). Stopping new orders leaves live exposure in a moving market.
9. **Difference between liveness and readiness, and what breaks when you conflate them?** — Liveness = making progress (restart me); readiness = able to work correctly (don't send me work). Wiring an external dependency into liveness converts a dependency blip into a fleet-wide restart with cold caches. Signature: restart loops with the readiness-timeout period.
10. **Why is a process 10–100× slower on its first message?** — Cold I-cache, iTLB/dTLB, branch predictors and BTB, D-cache, first-write page faults, lazy PLT binding, cold NIC/ARP/route state, and low CPU frequency. Signature: elevated `iTLB-load-misses`, `branch-misses`, and `page-faults` in the first window.
11. **How do you keep a system warm during a quiet market?** — A continuous low-rate keep-warm loop pushing synthetic messages through the entire real code path, dropped at the gateway. Warmup decays; a single startup warmup is insufficient. The traffic must be varied recorded data, not one repeated message, or you train the branch predictor for a shape that will not recur.
12. **Walk through a safe shutdown.** — Stop new orders → cancel resting → await acks → reconcile against the venue's own view → flush logs/recorder/state → clean session logout → exit. `SIGTERM` starts the drain (via signalfd), never the exit; supervisor grace period must exceed the drain's worst case, or `SIGKILL` leaves orders resting.
13. **What is cancel-on-disconnect and why isn't it sufficient?** — The venue pulls resting orders when your session drops; it is the backstop for `SIGKILL`/power loss. Insufficient because semantics and delays vary by venue and a transient network blip cancels everything, leaving you cold.
14. **What's the most valuable reference-data validation?** — A delta check against yesterday. Absolute bounds cannot distinguish a plausible-but-wrong tick size; a 100× change or a 60% drop in instrument count is unambiguously a broken upstream file.
15. **Why does `accept()` returning `EMFILE` cause 100% CPU?** — With level-triggered epoll the connection stays in the accept queue and the loop spins. Mitigation: hold a spare fd, close it, accept-and-close to shed the connection, then reopen.
16. **Why does `logrotate` fail exactly when you need it?** — Rotation needs free space to copy or compress; a full disk blocks the mechanism meant to free it. `copytruncate` needs a full duplicate and loses interleaved writes. Fix with separate filesystems, reserved headroom, and rate-of-change alerting.
17. **What's the right utilization target and why not 90%?** — Queue delay scales as ρ/(1−ρ): 4× service time at 80%, 9× at 90%, 19× at 95%, and real arrivals are burstier than Poisson. Target ~50% of *peak* burst, and size headroom for the post-failure state (N+1 failover pushes survivors up the steep part of the curve).
18. **What single metric best predicts capacity trouble?** — Queue high-water marks per interval. They move well before latency does and cost one compare-and-store per enqueue.
19. **How do you prevent double-trading during failover?** — A single authoritative arbiter with a bounded lease, or use the exchange session itself as the mutex (only one session can be logged in). Never infer primacy from "the other one looks dead" — that is indistinguishable from a partition.

---

## Common Traps

- **Deploying a binary whose debug info was discarded** — the crash you were waiting for is unsymbolizable.
- **Decoding binary logs or cores with a different build** — plausible-looking garbage; join everything on the build id.
- **Assuming a container makes the build reproducible** — a pinned digest helps, but timestamps, paths, and directory order still vary.
- **Editing config on a running host** — configuration drift, invisible until two instances behave differently.
- **Silently ignoring unknown config keys** — the setting you thought you applied is not applied.
- **Layered config with no resolved dump** — nobody can state the effective value during an incident.
- **Parsing config, hashing strings, or allocating on the hot path.**
- **Updating two related config fields separately** — the hot path observes an inconsistent pair for microseconds.
- **`atomic<shared_ptr>` for hot-path config** — an atomic RMW per read, possibly lock-based.
- **Live-updating a parameter that sizes preallocated memory or thread pinning** — mark it `restart_required` and reject.
- **Deploying a binary and a config change together** — attribution during the incident becomes guesswork.
- **A rollout with no pre-agreed automated abort criteria** — slow, not staged.
- **Rollback that requires fetching and warming an artifact** — you trade badly for the duration; keep the previous version resident and warm.
- **A kill switch read only by the loop it kills** — a wedged loop ignores it.
- **A kill that stops new orders but leaves resting quotes** — live exposure in a moving market.
- **An untested kill switch** — a belief, not a control.
- **Fail-open defaults** on unknown venue, unreadable config, or lost risk heartbeat — the safe default is killed.
- **Trusting the orchestrator's `After=` for readiness** — it orders start, not usability; `Type=simple` is "ready" the instant it forks.
- **Any dependency satisfied by a `sleep`** — fails on a faster machine or after an optimization.
- **Trading before PTP is locked** — every timestamp you produce, including regulatory ones, is wrong.
- **Quoting from an unsynchronized order book after startup** — reconcile via exchange sequence numbers first.
- **Restarting mid-session without reconciling live orders and position against the venue.**
- **Wiring an external dependency into the liveness probe** — a dependency blip restarts the whole fleet, cold.
- **No distinct "warming" state** — deploy automation aborts every rollout.
- **Warming with a single repeated message** — trains the predictor for the wrong thing.
- **Assuming warmup persists** — it decays over idle periods; run a keep-warm loop.
- **Allocating without pre-touching** — the page fault happens on first write, on the critical path.
- **`SIGTERM` handled by exiting** — leaves resting orders. And doing real work in the handler: `printf`/malloc/locks are not async-signal-safe.
- **Supervisor grace period shorter than the drain** — `SIGKILL` mid-drain.
- **Defaulting a missing risk limit** — a default limit is effectively no limit.
- **Validating reference data with a different binary than will consume it.**
- **`LimitNOFILE` set in a shell profile** — systemd services never read it; "works when I run it by hand."
- **`RLIMIT_CORE = 0` / unset `core_pattern`** — no evidence after the crash you have been chasing for months.
- **cgroup `memory.high` on a latency-critical process** — reclaim throttling produces millisecond stalls instead of a clean kill.
- **Ignoring `write` return codes** — `ENOSPC` and short writes silently corrupt the log and audit chain.
- **Sharing one filesystem for logs, cores, state, and root** — one full log volume takes out everything.
- **Alerting on disk percentage instead of fill rate** — no lead time.
- **Inode exhaustion** — `ENOSPC` with bytes free; check `df -i`.
- **Capacity planning from 1-minute averages** — 30% average is consistent with saturation for 300 ms.
- **Targeting 90% utilization** — queue delay is 9× service time there, and market bursts are 10–50×.
- **Sizing headroom for the steady state rather than post-failover.**
- **A "standby" that isn't warmed** — failover lands you on a cold process at the worst moment.
- **Inferring primacy from a missed heartbeat** — partitions look identical to death; double-trading follows.

---

## Compact Recall Summary

**Artifacts.** Same source must yield a recoverable, ideally bit-identical binary: kill timestamps (`SOURCE_DATE_EPOCH`), path leakage (`-ffile-prefix-map`), directory order, environment, and toolchain drift; Bazel/Nix for hermeticity, `diffoscope` to diagnose. The **GNU build id** joins process, core, symbol server (`debuginfod`), and binary-log dictionary — ship them together. Keep separated debug info; prefer static linking (minus glibc) so the artifact is self-describing. Latency is layout-sensitive, so binary identity is a performance concern, not just a hygiene one.

**Configuration.** Versioned, content-addressed, immutable, exported in every heartbeat so drift is a one-line query. Parse text exactly once at startup into a flat trivially-copyable struct with interned ids; the hot path does one load. Emit the fully resolved config with per-key provenance; reject unknown keys. **Atomic updates**: construct a complete new `Config`, publish with one release store into `atomic<const Config*>`, read with one acquire load; reclaim by never freeing (default) or RCU. Never `atomic<shared_ptr>`. Mark memory/pinning parameters `restart_required`; log diffs with actor and ticket; loosening limits needs a stricter path than tightening.

**Rollout.** Ladder: tests → deterministic replay → venue conformance → **shadow mode** (live data, real decisions, orders dropped at the gateway, decision-diff automated) → one host/symbol → widening cohorts. Deploy between sessions by default; in-hours use blue/green with a fully warmed standby and an entitlement flip. Rollback must be faster than roll-forward and the default reaction. One variable at a time, with abort thresholds defined before the deploy.

**Kill switches.** A hierarchy from a per-strategy flag to venue bitmaps to an independent gateway to session drop (engaging exchange cancel-on-disconnect). The switch must not depend on the health of the thing it kills. Kill = stop new **and** cancel resting. Hot-path cost is one relaxed load of a padded cache line plus a predicted branch. Test it on a schedule, fail safe to killed, audit every toggle.

**Startup.** Gate trading on an explicit conjunction: PTP locked, reference data fresh and validated, risk limits loaded, market data subscribed *and* sequence-recovered, order session logged in, position reconciled **against the venue**, warmup complete. Use the orchestrator for coarse ordering but verify independently — `After=` orders start, not readiness. Beware circular waits, retry storms (backoff + jitter), silent partial readiness, and any dependency satisfied by a `sleep`.

**Liveness vs readiness.** Liveness = progress, depends on nothing external, failure means restart. Readiness = able to trade correctly, depends on everything, failure means stop quoting. Add a distinct warming/startup state and always publish a *reason* string. Conflating them turns a dependency blip into a cold fleet-wide restart.

**Warmup.** Cold I-cache, iTLB/dTLB, BTB, D-cache, first-write faults, lazy PLT, cold NIC/ARP state, low frequency — first message 10–100× slow. Prime by running the real path with recorded, varied traffic and the send stubbed at the socket; `mlockall`, pre-touch every page, `-Wl,-z,now`, preallocate all pools, complete the session handshake early. Warmth decays: run a continuous **keep-warm** loop. Signature of omission is a distinct high mode covering the first samples after start or idle, with elevated iTLB/branch-miss/page-fault counters.

**Shutdown.** Drain: stop new → cancel resting → await acks → reconcile with the venue → flush rings, recorder, state → clean logout → exit. `SIGTERM` sets a flag (or wakes a signalfd); no work in the handler. Supervisor grace must exceed the drain, and the drain needs its own timeout escalating to a deliberate session drop so cancel-on-disconnect fires. COD varies by venue and is a backstop, not a plan. Prefer flip-to-warm-standby over cold restart.

**Validation.** Schema (with unknown-key rejection) → referential → business rules → freshness against today's session → **delta vs yesterday** → cross-source agreement. Fail closed and loudly; never default a missing risk limit. Validate in CI with the deployed binary's own `--validate-only`. Signature of a refdata bug: a coherent instrument subset rejected with one consistent reason code starting at open.

**Audit.** Order lifecycle with both venue and internal timestamps, decision context via trace id, config version, build id, every control toggle with actor and reason. Append-only, hash-chained, derived from the same event stream as the logs (never a second path), with an explicit durability boundary (`fdatasync` per batch or synchronous replication). MiFID II RTS 25 requires 100 µs UTC accuracy for HFT with 1 µs granularity and five-year retention; SEC 15c3-5 is why the risk gateway must be independent. Test reconstruction periodically.

**Limits.** `RLIMIT_NOFILE`, cgroup `memory.max`/`memory.high`, `RLIMIT_MEMLOCK`, `RLIMIT_RTPRIO`, `RLIMIT_CORE`, socket buffer caps, NIC ring sizes, ephemeral ports, conntrack. `EMFILE` on `accept` spins at 100% CPU under level-triggered epoll — hold a spare fd to shed connections; prevent leaks with RAII `unique_fd`. Set limits in the unit file as code, export used-vs-limit gauges and alert on the ratio and the trend. `memory.high` gives millisecond reclaim stalls rather than a clean kill.

**Disk.** `ENOSPC` fails writes, blocks threads in `D` state, stops the audit trail, prevents core dumps, and breaks `logrotate` (which needs space to free space; `copytruncate` is worse). Separate filesystems for logs/cores/state/root, reserve headroom or a ballast file, alert on fill *rate* and projected time-to-full, enforce retention by shipping remotely, check write return codes, and watch inodes separately.

**Capacity.** Queue delay ~ ρ/(1−ρ): 4× at 80%, 9× at 90%, 19× at 95%, and market bursts run 10–50× above average — so target ~50% of peak burst, measured from packet captures at sub-millisecond granularity, never from minute averages. Watch queue **high-water marks** as the earliest signal. Active/standby with a genuinely warm, keep-warmed standby gives millisecond failover at the cost of duplicate capacity; prevent double-trading with a bounded lease or the exchange session as the mutex, never with "the other one looks dead." Size headroom for the post-failover state, since N+1 pushes survivors up the steep part of the curve.
