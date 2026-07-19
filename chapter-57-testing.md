# Chapter 57 — Testing

*Interview-focused revision notes. The theme: in a trading system correctness and latency are both requirements, so the test suite must pin down behaviour a normal suite cannot reach — nondeterministic schedules, adversarial inputs, real wire bytes, and the timing of the system under load — while never becoming the thing that dictates the design of the hot path.*

---

## 57.1 Unit Testing

A **unit test** exercises one component with its dependencies replaced or elided, deterministically, in-process, in milliseconds. The interesting question in low-latency C++ is not "which framework" but **where the seam goes**, because the mechanism you use to create the seam usually costs latency.

The conventional seam is a virtual interface: `struct IClock { virtual uint64_t now() = 0; };`. That puts an indirect call on the hot path (Ch. 6 §6.11, Ch. 55 §55.9). The low-latency alternatives:

| Seam mechanism | Runtime cost | Test cost |
|---|---|---|
| Virtual interface | Indirect call, no inlining | Trivial: pass a mock |
| Template policy parameter | Zero; fully inlined | Must instantiate the SUT twice; longer compile (Ch. 17 §17.22) |
| Link-time substitution (separate `.o`) | Zero | Fragile; per-test-binary linkage |
| Free function + `if constexpr` on a config tag | Zero | Combinatorial instantiation |
| No seam: feed real bytes at the boundary | Zero | Test is coarser but far more honest |

The mature answer in this domain is **templates for the hot path, virtuals for the cold path**, plus a strong preference for testing at *data* boundaries rather than *object* boundaries. A feed handler tested by feeding it a `std::span<const std::byte>` of real ITCH bytes and asserting on the emitted book (Ch. 51 §51.4, Ch. 50 §50.13) needs no seam at all, and does not ossify the internal class structure.

**Naming the unit vs integration boundary.** A useful operational definition: a test is a unit test if it (a) touches no clock other than an injected one, (b) opens no socket, file, or shared-memory segment, (c) starts no thread it does not join, and (d) is order-independent under `--gtest_shuffle`. Anything violating one of these belongs in a separate target that CI may run less often and with different timeouts. Enforce mechanically — a `LD_PRELOAD` shim or a seccomp filter that aborts on `socket()`/`clock_gettime` in the unit target catches drift far better than convention.

**Framework specifics worth knowing.** GoogleTest's `TEST_F` fixtures run a fresh fixture object per test; static state leaks across tests and is the usual cause of order-dependent failures (`--gtest_shuffle --gtest_repeat=10` exposes it). Death tests (`EXPECT_DEATH`) `fork()`, which is unsafe if the parent holds locks or has threads — hence `--gtest_death_test_style=threadsafe`, which re-execs the binary instead. Catch2's `SECTION`s re-run the whole test body per leaf, so expensive setup in the body multiplies. `EXPECT_*` continues, `ASSERT_*` returns — an `ASSERT` inside a helper function returns from the *helper*, not the test, which is a classic source of tests that appear to pass after a failed precondition.

**What unit tests structurally cannot find**, and why the rest of this chapter exists: memory-ordering bugs (§57.9–57.11), input the author did not imagine (§57.2, §57.6), disagreements with the exchange's actual semantics (§57.3), timing and overload behaviour (§57.16), and anything whose failure requires a specific interleaving or a specific packet arriving late.

---

## 57.2 Property-Based Testing

**Property-based testing** (PBT) replaces "for this input, expect this output" with "for all inputs satisfying a precondition, this invariant holds." The framework generates inputs from a *generator*, checks the property, and on failure **shrinks** the counterexample to a minimal form.

```cpp
// RapidCheck
RC_GTEST_PROP(Book, BestBidNeverCrossesBestAsk, (std::vector<BookEvent> evts)) {
    OrderBook b;
    for (auto& e : evts) b.apply(e);
    RC_ASSERT(!b.has_both() || b.best_bid() < b.best_ask());
}
```

The value is entirely in the **choice of property**. Weak properties ("doesn't crash") are nearly free to satisfy. The productive categories:

| Property class | Form | Example in this domain |
|---|---|---|
| Round-trip | `decode(encode(x)) == x` | SBE/FIX codecs (Ch. 51 §51.6) |
| Invariant | `P(state)` after any op sequence | Book levels sorted, no crossed book, sum of level quantities equals sum of order quantities |
| Metamorphic | `f(t(x)) == t'(f(x))` | Applying events in two orders that commute yields identical books |
| Idempotence | `f(f(x)) == f(x)` | Duplicate-message suppression (Ch. 54 §54.9) |
| Oracle / model | `f(x) == model(x)` | See §57.3 and §57.4 |
| Postcondition on internals | Capacity, allocation count | "no allocation occurs after warm-up" as a property over random op sequences |

**Shrinking is the feature.** A 400-event random sequence that crashes is nearly useless; shrunk to three events it is a bug report. Shrinking requires the generator to be *structured* — RapidCheck and Hypothesis shrink integers toward zero and containers toward empty, preserving generator constraints. If you generate by consuming raw bytes yourself (the libFuzzer style, §57.6) you get poor shrinking unless you also run `-minimize_crash=1`.

**Generator design is where PBT succeeds or fails.** Uniform random `BookEvent`s almost never produce a cancel for an order that exists, so the interesting paths are never reached. You need a **stateful generator** that draws from the current model state: pick an existing order id to cancel, pick a price near the current touch. This is the point at which PBT converges with model-based testing (§57.4) — `rc::state::check` in RapidCheck exists precisely for this.

**Practicalities.** Fix and log the seed (§57.5). Bound the input size or the suite's runtime becomes unpredictable in CI. Distinguish *discards* (precondition failed, `RC_PRE`) from passes; a high discard rate means your generator is wrong, and frameworks abort after too many. And beware properties that merely re-implement the code under test in the assertion — a round-trip property where `encode` and `decode` share a buggy field-offset table passes happily.

---

## 57.3 Differential Testing

**Differential testing** runs two independent implementations on the same input and asserts that they agree. It sidesteps the oracle problem: you don't need to know the right answer, only that two things that should agree do.

Productive pairings in this domain:

- **Fast path vs reference path.** The SIMD/branchless parser (Ch. 42 §42.3, §42.6) versus a straightforward scalar one. The scalar version is the specification; the fast one is the optimization. This is the single highest-value differential test in a trading stack, because hand-vectorized parsers fail on exactly the rare inputs (message straddling a buffer boundary, maximum-length field, zero-length repeating group) that hand-written tests omit.
- **Your book builder vs the exchange's published snapshot.** Replay a full day's incremental feed, and at each snapshot boundary compare your constructed book to the snapshot bytes (Ch. 53 §53.3). Any divergence is a real defect, dated and reproducible.
- **Your matching/fill logic vs the venue's drop copy** (Ch. 54 §54.14). Differences reveal misunderstood priority rules (Ch. 49 §49.4) far better than reading the spec again.
- **Two feeds of the same market** — A/B redundant feeds (Ch. 53 §53.6) already give you two byte streams that must decode to identical logical events.
- **Optimized build vs `-O0`, or GCC vs Clang, or sanitizer build vs release.** A differential failure here is almost always UB in your code, not a compiler bug (Ch. 4 §4.5).
- **Fixed-point arithmetic vs a decimal/rational reference** for price math (Ch. 23 §23.10).

```
        random / recorded input
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   fast impl            reference impl
        │                   │
        └──── compare ──────┘   ← must define "equal" precisely
```

**The hard part is defining equality.** Timestamps, iteration order of an unordered container, `-0.0` vs `+0.0`, NaN payloads, and the order of simultaneous events at the same price will differ innocently. Canonicalize both sides before comparison, and make the canonicalizer itself simple enough to trust. Where floating point is involved, compare with an explicit ULP or absolute-epsilon rule (Ch. 23 §23.8) — and prefer to have removed floats from the wire path entirely (Ch. 3 §3.12).

**Differential + fuzzing is the strongest combination available.** A libFuzzer harness that decodes a mutated buffer with both parsers and asserts structural equality explores far more of the input space than either technique alone, and every failure is automatically minimized. The harness must handle "both reject the input" as a pass, and "one rejects, one accepts" as a failure — the accept/reject boundary is where parser bugs live.

---

## 57.4 Model-Based Testing

**Model-based testing** builds a deliberately slow, obviously-correct **model** of the system's state, drives both the model and the real system with the same random sequence of commands, and asserts equivalence after each command.

```cpp
// Shape (RapidCheck rc::state):
struct Model { std::map<Price, std::map<OrderId, Qty>> bids, asks; };

struct Cancel : rc::state::Command<Model, OrderBook> {
    OrderId id;
    void checkPreconditions(const Model& m) const { RC_PRE(m.contains(id)); }
    void apply(Model& m) const { m.erase(id); }                       // model transition
    void run(const Model& m, OrderBook& sut) const {
        sut.cancel(id);
        RC_ASSERT(sut.best_bid() == model_best_bid(m));               // equivalence check
    }
};
```

The model for an order book is `std::map<Price, std::map<OrderId, Qty>>`: obviously correct, hopelessly slow, and therefore a perfect oracle for the real implementation (an array of price levels with intrusive order lists, Ch. 50 §50.14–§50.15). The same pattern applies to a lock-free ring buffer (model: `std::deque` plus a capacity check), an order-state machine (model: a `std::map<ClOrdId, State>` plus the transition table from Ch. 50 §50.9), and a risk engine (model: recompute all limits from scratch each time, Ch. 56 §56.15).

**Why it outperforms hand-written tests here.** Real book bugs are *sequence* bugs: cancel-the-last-order-at-a-level then immediately add at the same price; modify that reduces quantity (keeps priority) versus increases it (loses priority, Ch. 50 §50.17); an execute that fully consumes the top order while a cancel for it is in flight. Enumerating these by hand is a memory test; generating thousands of random command sequences against a model finds them and shrinks them to four commands.

**Command generation must be state-aware** — a generator that emits cancels for nonexistent orders spends all its budget on discards. Draw ids and prices from the model's current state, with a small probability of drawing an invalid one so error paths are covered too.

**Equivalence granularity is a design decision.** Checking the full book after every command is `O(n)` per step and limits sequence length; checking only the touch (BBO) after every command plus the full book every *k* commands is the usual compromise. Check the *full* state at the end unconditionally — bugs that only manifest deep in the structure (a leaked price level with zero orders, a stale free-list entry) are otherwise invisible.

**Related formalism worth naming.** If you write the model as an abstract state machine and derive tests by traversing its transition graph (all states, all transitions, or all pairs), that is classic model-based test *generation*; tools like TLA+/TLC or Alloy can generate the traces. In practice, randomized command sequences against an executable model get most of the value for a fraction of the effort, and TLA+ is reserved for genuinely subtle distributed protocols — failover and leader fencing (Ch. 56 §56.4–§56.6) being the canonical candidates.

---

## 57.5 Deterministic Random Seeds and Reproducers

Every randomized technique in this chapter is worthless unless a failure can be replayed exactly. The discipline is small and non-negotiable.

**1. One seed, sourced once, logged always.**

```cpp
uint64_t seed = env_or("TEST_SEED", std::random_device{}());
std::fprintf(stderr, "TEST_SEED=%llu\n", (unsigned long long)seed);
std::mt19937_64 rng{seed};
```
Print the seed on *every* run, not only on failure — CI truncates output, and a passing run that later needs re-examination is common. GoogleTest already does this (`--gtest_random_seed`, echoed in the header line).

**2. One RNG, threaded explicitly.** Global RNGs, `rand()`, and per-object `random_device` calls destroy reproducibility the moment thread scheduling changes the order of draws. Pass the generator by reference; give each thread a **deterministically derived** sub-stream (`SplitMix64(seed ^ thread_index)`), never a shared engine.

**3. Beware sources of nondeterminism that are not the RNG.** These break replay even with a fixed seed:

| Source | Fix |
|---|---|
| `std::unordered_map` iteration order | Sort before iterating, or use an ordered/flat map in tests (Ch. 12 §12.2) |
| Pointer values used as tiebreakers or hash inputs | Never; use stable ids |
| ASLR (address-dependent behaviour) | `setarch -R`, or eliminate the dependence |
| Wall-clock and `std::chrono::steady_clock` | Virtual clock (§57.13) |
| Thread scheduling | Deterministic simulation (§57.12) or single-threaded model |
| `std::random_device` inside the SUT | Inject the engine |
| Hash seeds randomized per process (Abseil `absl::Hash`) | Fix the seed in tests |
| Filesystem/`readdir` order | Sort |

**4. The reproducer must be a committed artifact, not a seed.** A seed reproduces only against *that build* of *that generator*. Once a failure is found and shrunk, serialize the minimal input into the repository as a regression corpus entry — a byte file for fuzz targets, a literal command list for model-based tests. This is what "shrink, then pin" means, and it survives refactors of the generator.

**5. Bisecting a nondeterministic failure.** A test that fails 1 in 200 runs cannot be `git bisect`ed with a single run per commit. Wrap it: `git bisect run bash -c 'for i in $(seq 400); do ./test || exit 1; done'`, and compute the number of repeats from the observed failure rate — for a per-run failure probability *p*, *n* repeats miss the bug with probability (1−*p*)ⁿ, so *n* ≈ 3/*p* gives ~95 % detection. Getting this arithmetic right in an interview is a strong signal.

---

## 57.6 Fuzzing Native Code

**Fuzzing** feeds generated inputs to a program while instrumentation observes which code paths execute, mutating inputs that reach new coverage. It is the most cost-effective bug finder for anything that parses untrusted bytes — which, in a trading system, is every feed handler and every exchange session decoder.

**In-process coverage-guided fuzzing** is the modern form. libFuzzer:

```cpp
extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < sizeof(Header)) return 0;
    ItchDecoder d;
    d.consume(std::span{reinterpret_cast<const std::byte*>(data), size});  // must not crash
    return 0;                                     // non-zero return values are reserved
}
```
```
clang++ -g -O1 -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer \
        fuzz_itch.cc decoder.cc -o fuzz_itch
./fuzz_itch corpus/ -max_len=1500 -rss_limit_mb=2048 -jobs=8 -workers=8
./fuzz_itch -runs=1000000 corpus/          # CI mode: bounded, no new corpus writes
```

Key flags and their purpose: `-max_len` bounds input size (set it to your MTU or max message size — otherwise the fuzzer wastes its budget on 1 MB inputs); `-dict=itch.dict` supplies message-type tokens so the mutator finds valid headers quickly; `-merge=1` prunes a corpus to a minimal coverage-equivalent set; `-minimize_crash=1` shrinks a crashing input; `-fork=1` survives OOMs and timeouts. AFL++ (`afl-clang-fast`, persistent mode via `__AFL_LOOP`) is the out-of-process alternative and generally better on targets that cannot be made reentrant.

**Instrumentation is what makes it work.** `-fsanitize=fuzzer` inserts `__sanitizer_cov_trace_pc_guard` at every edge and `__sanitizer_cov_trace_cmp` at comparisons; the latter is why the fuzzer can guess a 4-byte magic number that brute force would never find — it learns the comparison operands. `memcmp`/`strcmp` are intercepted for the same reason. Consequently: **do not obscure comparisons in the code under test** with checksums computed before the branch, and consider a `#ifdef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION` that disables CRC validation (Ch. 51 §51.13) so the fuzzer can reach past the checksum gate.

**Always fuzz with a sanitizer.** Without ASan/UBSan/MSan the fuzzer only finds inputs that crash outright; with them it finds every out-of-bounds read, use-after-free, integer overflow (`-fsanitize=integer` isn't in UBSan's default set), and misaligned load (Ch. 44 §44.2–§44.5). MSan requires *all* dependencies rebuilt instrumented or it drowns in false positives.

**Structure-aware fuzzing.** For a length-prefixed binary protocol, raw byte mutation spends most of its time producing inputs rejected at the framing layer. `FuzzedDataProvider` lets you carve typed values out of the input; `libprotobuf-mutator` mutates a protobuf that you then serialize into wire format. The tradeoff: structured fuzzing reaches deep logic but can no longer find framing bugs, so run both harnesses.

**What a "crash" means.** Non-zero exit, sanitizer report, assertion, timeout (`-timeout=`), or OOM (`-rss_limit_mb=`) — the last two catch algorithmic blowup and unbounded allocation from an attacker-controlled length field, which is a real availability bug in a feed handler. Add explicit `assert`s for domain invariants so the fuzzer has something to violate; a fuzz target with no assertions only finds memory-safety bugs.

**Operationally**: seed the corpus with real captured packets, keep the corpus in version control (or a bucket) so coverage is not rediscovered each run, run a bounded number of iterations plus the full regression corpus in CI on every commit, and run continuous long-form fuzzing (OSS-Fuzz style, or a nightly job) separately.

---

## 57.7 Protocol-Vector Tests

A **protocol vector** is a fixed byte string with an expected decoded meaning, committed to the repository. It is the lowest-tech and highest-value test for any exchange interface.

```cpp
// itch_vectors.cc — bytes are the specification
constexpr std::uint8_t kAddOrder[] = {
  0x00,0x24, 'A', 0x00,0x01, 0x00,0x02, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01, /*...*/ };

TEST(Itch, AddOrderVector) {
    auto msg = decode(std::as_bytes(std::span{kAddOrder}));
    ASSERT_EQ(msg.type, MsgType::AddOrder);
    EXPECT_EQ(msg.order_id, 1u);
    EXPECT_EQ(msg.price, Price::from_ticks(1234500));   // exact integer, never a double
}
```

**Where the vectors come from, in descending order of trustworthiness:** a live/UAT capture (`tcpdump -w`, Ch. 48 §48.7) of the venue's own traffic; the venue's published conformance-test file; the venue's spec examples typed in by hand; your own encoder's output (worthless as a decoder test — it only proves self-consistency, the failure mode of §57.2's round-trip property).

**What the vector set must cover**, because these are exactly what hand-written happy-path tests omit:

- The **minimum and maximum** value of every field, and the value one past the maximum.
- Every optional-field present/absent combination, and empty repeating groups.
- Fields whose meaning changes with a preceding discriminator (message type, order-book side).
- Encoded null/absent sentinels — SBE uses type-specific null values, FIX uses field absence; conflating "absent" with "zero" is a real and expensive bug (Ch. 51 §51.11, Ch. 23 §23.13).
- **Message boundaries**: two messages in one TCP segment; one message split across two segments; a partial trailing message (Ch. 38 §38.20, Ch. 51 §51.7). Feed the decoder byte-by-byte in one test variant — a decoder that only works when the whole message arrives at once is a production incident waiting for a busy day.
- Endianness (Ch. 3 §3.9) and alignment: SBE is little-endian, FIX/FAST and most legacy binary feeds are big-endian; a vector caught by `htonl` confusion is caught once and never again.
- Round-trip: decode the vector, re-encode, assert **byte equality** with the original. This catches lost padding bytes, dropped optional fields, and normalization the encoder performs silently.

**Golden-file discipline.** Store vectors as raw binary plus a small text manifest, not as C string literals with escapes (escaping errors become "spec bugs"). Never auto-update golden files from current behaviour on failure — a `--update-golden` flag is convenient and will eventually be used to bless a regression. Regenerate deliberately, review the diff as a hexdump.

The complementary technique is version-evolution testing: decode last year's vectors with this year's decoder (Ch. 51 §51.10). A schema change that breaks old vectors is either a genuine incompatibility or an intentional break that must be dated and gated.

---

## 57.8 Malformed-Message Fuzzing

Protocol vectors prove you handle correct input. **Malformed-message testing** proves you survive incorrect input — and in a market-data handler, "incorrect" is not hypothetical: a truncated UDP datagram, a corrupted multicast packet, a mid-upgrade venue emitting a message length that doesn't match its own spec, or a replay/gap-fill stream with a stale schema (Ch. 51 §51.14).

The high-value mutation classes, each with a characteristic defect:

| Mutation | Defect it exposes | Diagnostic signature |
|---|---|---|
| Truncate to *n* bytes for every *n* | Read past the buffer end | ASan heap-buffer-overflow READ, small overflow, in the decode function |
| Length field > actual payload | Trusting the wire length | ASan overflow, or a huge `memcpy` and SIGSEGV |
| Length field = 0 or 1 | Infinite loop advancing by `len` | Timeout / 100 % CPU with no progress; watchdog fires (Ch. 56 §56.8) |
| Count field = `UINT32_MAX` | Unbounded allocation or loop | OOM kill, or `bad_alloc` on a path with no handler |
| `length - header_size` where length < header | **Unsigned underflow** → giant size | ASan overflow with a ~2⁶⁴ size; the single most common protocol bug |
| Unknown message type byte | Missing default in `switch`; falls through | Silent misparse, or UBSan "load of value not a valid enum" |
| Non-ASCII/embedded NUL in a text field | `strlen` past the field, unterminated copy | ASan read overflow in `strlen`/`strcpy` |
| Nested repeating group depth | Stack overflow via recursion | SIGSEGV with a huge, uniform stack; guard page hit (Ch. 32 §32.20) |
| Misaligned message start | Misaligned load of `uint64_t` | UBSan alignment report; SIGBUS on ARM (Ch. 3 §3.3) |
| Sequence number wrap / out-of-order / duplicate | Gap-detection arithmetic | Wrong recovery decision; caught by a model (§57.4) |

The unsigned-underflow row deserves emphasis because it is both the most common and the most elegant to explain: `remaining = hdr.length - sizeof(Header)` with a `size_t` result and `hdr.length == 2` yields ~1.8×10¹⁹, which then passes `remaining <= buffer_size`? No — it fails that check, *if* you wrote one. The bug lands when the check is `bytes_consumed + remaining <= buffer_size`, which itself overflows and wraps back into range. **Validate before subtracting, and compare with subtraction on the known-good side**: `if (hdr.length < sizeof(Header) || hdr.length > avail) reject;` (Ch. 51 §51.11, Ch. 23 §23.12).

Build the malformed corpus two ways: **systematically**, by writing a mutator that walks each field of a valid vector and substitutes boundary values (this gives a deterministic, reviewable suite), and **stochastically**, by seeding libFuzzer with the valid vectors and letting coverage guidance find the rest (§57.6). The systematic suite is the regression gate; the fuzzer is the discovery engine.

**Assert the policy, not just the absence of a crash.** For each malformed input the decoder must do a *specified* thing: reject and resynchronize at the next framing boundary, increment a named counter, and continue — or, if the stream is unrecoverable, declare a gap and request replay (Ch. 53 §53.4). A test that only asserts "no crash" lets a decoder silently drop the rest of the packet, which in a market-data feed means a stale book with no alarm — strictly worse than crashing.

---

## 57.9 Concurrency Stress and Soak Testing

Start with the theory, because it is the point interviewers probe: **an ordinary test cannot find a memory-ordering bug.** Three independent reasons.

1. **The bug requires an interleaving your machine will not produce.** On x86-64 (TSO, Ch. 29 §29.13) the only reordering the hardware performs is store→load. Code that is incorrect under acquire/release but relies on store→store or load→load ordering runs correctly on x86 forever and fails on the first ARM server. Store buffer drain windows are also tiny — the racy window may be a handful of cycles out of every million.
2. **The compiler's reordering is fixed at build time.** A missing `memory_order_acquire` may be harmless at `-O0` and fatal at `-O3` with inlining, or vice versa, and *the same binary* always behaves the same way. Running the test a million times explores schedules but not compilations.
3. **A passing test proves nothing about the specification.** Even if the interleaving occurs, the outcome may be benign on this microarchitecture. The C++ memory model (Ch. 25) is about what is *permitted*, not what is *observed*; only a tool that reasons over the model can tell you (§57.11).

What stress testing *is* good for: finding races that are frequent enough to hit, shaking out lifetime bugs, and — crucially — providing a workload for TSan.

**ThreadSanitizer is the primary tool.** TSan maintains vector clocks per thread and shadow state for every memory word, and reports a race whenever two accesses to the same location, at least one a write, are not ordered by happens-before (Ch. 25 §25.11). It finds the race even when the interleaving is benign *on this run*, because it reasons about happens-before rather than about the observed order — that is why it beats a million-iteration stress loop.

```
clang++ -fsanitize=thread -g -O1 -fno-omit-frame-pointer app.cc
TSAN_OPTIONS="halt_on_error=1 history_size=7 second_deadlock_stack=1" ./app
```
Limits worth knowing, because "just run TSan" is an incomplete answer:
- ~5–15× slowdown and ~5–10× memory; it changes timing so much that some races become unreachable.
- It tracks the **last N accesses** per location (`history_size`); with heavy traffic the second stack is lost.
- It reports races only on code paths actually executed — coverage is still your problem, hence stress workloads.
- **Inline assembly and intrinsics are invisible to it.** A hand-rolled `lock cmpxchg` or a `_mm_*` load is not instrumented, so a lock-free structure built from intrinsics silently reports nothing. Build lock-free code from `std::atomic` (Ch. 25 §25.2) if you want it checkable.
- Atomics are understood; `volatile` is not synchronization and TSan will (correctly) report races on it (Ch. 25 §25.21).
- It cannot be combined with ASan; you need separate build configurations.
- False negatives from unannotated custom synchronization are common — annotate with `__tsan_acquire`/`__tsan_release` if you have a hand-built lock or a seqlock (Ch. 26 §26.9), which TSan otherwise flags as a torn read.

**Stress test structure.** Many threads, small shared state (so collisions are likely), randomized per-thread delays, and a *checkable invariant* — not just "didn't crash." For an SPSC queue (Ch. 26 §26.3): producer writes a monotonically increasing sequence with a checksum; consumer asserts strict monotonicity, no duplicates, no gaps, and checksum match. That converts a memory-ordering bug into an immediate, localized assertion. Add `std::this_thread::yield()`, `sched_yield()`, or a random spin at plausible-interleaving points; better, use the systematic approach in §57.10.

**Soak testing** is the same workload run for hours or days at production rates. It finds what stress does not: slow leaks (RSS drift, Ch. 32 §32.23), fragmentation in a custom allocator (Ch. 7 §7.13), counter and sequence-number wraparound (a 32-bit sequence at 500 k msg/s wraps in ~2.4 hours — the reason soak duration must be justified arithmetically), timer-wheel drift (Ch. 35 §35.4), file-descriptor and buffer-pool leaks (Ch. 60 §60.12), TSC/clock drift (Ch. 35 §35.3), and tail-latency degradation that only appears after the allocator's steady state changes. Track RSS, allocation counts, queue depths, and p99.9 over time; a soak test whose only assertion is "still running" wastes the hardware.

---

## 57.10 Randomized Scheduler Testing

Stress testing samples interleavings by accident. **Randomized scheduler testing** samples them on purpose, by taking control of when threads run.

**Preemption-bounded / PCT-style scheduling.** The insight behind PCT (Probabilistic Concurrency Testing) is that most concurrency bugs have a small **bug depth** *d* — the number of ordering constraints that must hold to trigger them (typically 1–3). If a scheduler with *n* threads and *k* instrumented points inserts *d−1* random priority-change points, it triggers a depth-*d* bug with probability at least 1/(n·k^(d−1)) *per run*, which is a lower bound you can multiply by run count. That's a genuine probabilistic guarantee, unlike stress testing's "hope."

Implementations and equivalents:

| Tool | Mechanism | Notes |
|---|---|---|
| Coyote / Chess (research lineage) | Systematic + PCT schedule enumeration | Original PCT work; .NET-centric today |
| `relacy` | Replaces threads/atomics with a simulated scheduler | C++, header-only, explores schedules *and* memory-model relaxations (§57.11) |
| rr chaos mode (`rr record --chaos`) | Randomized scheduling under record/replay | Any binary; failures are then replayable and reverse-debuggable (Ch. 58 §58.4) |
| TSan + `TSAN_OPTIONS=...` yields | Timing perturbation only | Weak but free |
| Custom yield injection | `sched_yield`/`nanosleep` at instrumented points | Cheap; controlled by the deterministic seed (§57.5) |
| `stress-ng`, thread oversubscription | Forces preemption by contending for cores | Blunt; useful with isolated cores disabled |

**A cheap and effective in-house version**: compile a test build with an injection macro at every atomic operation and lock acquisition.

```cpp
#ifdef SCHED_FUZZ
  #define YIELD_POINT()  sched_fuzz::maybe_yield()   // consults the seeded RNG
#else
  #define YIELD_POINT()  ((void)0)
#endif
```
`maybe_yield()` draws from a per-thread stream derived from the global seed, and with small probability calls `sched_yield()` or spins for a randomized number of nanoseconds. Because it is seeded, a failure replays. Because it compiles to nothing in release, the hot path is unaffected. This is a very good answer to "how would you make your queue's rare bug reproducible?"

**Oversubscription matters.** With one thread per isolated core (Ch. 31 §31.17–§31.19) the OS never preempts, so preemption bugs never occur in testing and appear only when a housekeeping thread lands on the wrong core in production. Run the concurrency suite deliberately **oversubscribed** (more threads than cores, no pinning, `nice`-differentiated priorities) to force preemption in the middle of critical sections. The classic bug this finds is a spinlock held across a preemption — a lock convoy (Ch. 24 §24.19) or a priority inversion (Ch. 24 §24.18) that never manifests on a quiet machine.

**Weak-memory emulation.** On x86 you cannot observe store→store or load→load reordering, so run the concurrency suite on **AArch64** hardware as a standing CI job. It is the cheapest available approximation of a weak-memory model checker and finds real missing-acquire/release bugs that x86 masks. If ARM hardware is unavailable, `relacy` or `herd7` fill the gap (§57.11).

---

## 57.11 Memory-Model Model Checking

A **model checker** enumerates *all* executions permitted by a formal memory model, rather than sampling the ones your hardware happens to produce. For a small lock-free algorithm this converts "we ran it a billion times" into a proof over the model.

**The tools, and what each is for:**

| Tool | Model | Scope | Use |
|---|---|---|---|
| **CDSChecker** | C/C++11 memory model, exhaustive with partial-order reduction | Whole small programs using `<atomic>` | Verify an SPSC/MPMC queue's orderings |
| **relacy** (rrd) | C++11 model, simulated scheduler, header-only | Drop-in replacement for `std::thread`/`std::atomic` in a test build | Easiest to adopt; the practical default |
| **GenMC** / **Nidhugg** | Stateless model checking over C11 / LLVM IR | Larger programs, better reduction | Modern successors to CDSChecker |
| **herd7 / litmus7 (diy)** | Axiomatic models for x86-TSO, ARMv8, RISC-V, C11 | Litmus tests, not whole programs | Answer "is this reordering allowed on ARM?" (Ch. 25 §25.19) |
| **TLA+ / PlusCal** | Abstract state machines, not the C++ model | Protocols, failover, recovery | Ch. 56 §56.4–§56.7 |
| **CBMC / ESBMC** | Bounded model checking of C/C++ | Loops must be bounded | Assertions, overflow, some concurrency |

**How relacy is used**, because it is the one most likely to come up as "did you actually do this":

```cpp
struct spsc_test : rl::test_suite<spsc_test, 2> {   // 2 threads
    rl::atomic<int> flag;  rl::var<int> data;       // rl:: types, not std::
    void before() { flag($) = 0; }
    void thread(unsigned idx) {
        if (idx == 0) { data($) = 42; flag($).store(1, rl::mo_release); }
        else { if (flag($).load(rl::mo_acquire) == 1) RL_ASSERT(data($) == 42); }
    }
};
int main() { rl::simulate<spsc_test>(); }
```
relacy replaces the threads with cooperative fibers and the atomics with model-aware objects, then explores schedules *and* the memory-model-permitted store visibility choices. Changing `mo_release` to `mo_relaxed` makes it report a data race on `data` immediately — that is the demonstration that separates a candidate who has used these tools from one who has read about them.

**The fundamental limit: state-space explosion.** Exhaustive checking is feasible for two or three threads and a handful of operations each; it is not feasible for your whole feed handler. The methodology is therefore: extract the synchronization skeleton into a tiny standalone harness, verify *that*, and keep the harness in the repository next to the real implementation so the two are edited together. Partial-order reduction (treating executions that differ only in the order of independent operations as equivalent) is what makes even the small cases tractable.

**A pragmatic hierarchy** to state in an interview: `std::atomic` with `seq_cst` first (correct by default, Ch. 25 §25.7); weaken orderings only with a written justification; TSan on every concurrency test; a relacy/CDSChecker harness for any hand-written lock-free structure; AArch64 CI; and never ship a hand-rolled lock-free container when a proven one (or a well-understood SPSC ring, Ch. 26 §26.3) will do.

---

## 57.12 Deterministic Simulation

**Deterministic simulation testing** (DST) runs the entire system — event loop, timers, network, disk — inside a single-threaded simulator with an injected clock and injected I/O, so that a whole run is a pure function of the seed. It is the technique behind FoundationDB's reputation for reliability and is directly applicable to a trading stack.

The requirements are structural and must be designed in:

1. **All I/O behind an interface** that has a real and a simulated implementation: `send`, `recv`, `now`, `set_timer`, `read_file`, `fsync`.
2. **All time from the injected clock** (§57.13). No `clock_gettime`, no `rdtsc` in application logic — one stray call and determinism is gone. Enforce with a link-time check (`nm -u | grep clock_gettime`) or an `LD_PRELOAD` abort shim in the simulation build.
3. **No real threads.** Components are state machines or coroutines (Ch. 19 §19.7) driven by the simulator's event queue. A single-writer event-loop architecture (Ch. 52 §52.5) makes this natural — which is the strongest testability argument for that architecture.
4. **All randomness from the seeded RNG**, including the simulator's own scheduling and fault choices (§57.5, §57.15).

```
        seed ──► RNG ──► scheduler + fault injector
                          │
   [feed handler] ─┐      │ picks next event, advances virtual clock
   [strategy]      ├──► event queue (ordered by virtual time)
   [order gateway] ┘      │
                          └─► simulated network: reorders, drops, delays, duplicates
```

The simulator's power comes from **controlling every axis at once**: it can deliver the A-feed 40 µs before the B-feed, drop packet 17, deliver a fill before its acknowledgement, kill the process between the journal write and the `fsync` (Ch. 56 §56.1), and partition the primary from the sequencer — all chosen by the seed, all replayable. A single overnight run of ten thousand seeds explores more adverse conditions than a year of production.

**Simulation time runs as fast as the CPU allows.** With a virtual clock, an eight-hour trading session with an idle overnight period costs seconds of wall time, because the simulator jumps directly to the next scheduled event instead of sleeping. This is what makes it economical to run thousands of scenarios per commit.

**What DST cannot test:** anything about real latency. The simulator deliberately abolishes timing, so it validates *logic under adverse orderings* only. Latency is validated by §57.16, §57.19, and the CI benchmarks of §57.17's sibling discipline. Nor does it test the code paths that exist only in the real I/O implementation — the `epoll` edge-trigger handling, the `recvmmsg` batching, the kernel-bypass ring management (Ch. 47 §47.11). Those need a thin, separately-tested adapter layer and hardware-in-the-loop runs (§57.18). Keeping that adapter *thin* is the design consequence of adopting DST.

**Failure output.** A DST failure must print the seed, the virtual timestamp, and enough of the event log to reconstruct the scenario; the flight-recorder buffer (Ch. 59 §59.13) doubles as this log. The goal is that the entire bug report is one line: `SEED=0x9c3f... FAILED at t=+4.219s: book crossed`.

---

## 57.13 Virtual Clocks

A **virtual clock** is a time source under test control: it never advances on its own, only when the test or simulator advances it.

```cpp
struct VirtualClock {
    using duration = std::chrono::nanoseconds;
    using time_point = std::chrono::time_point<VirtualClock, duration>;
    static constexpr bool is_steady = true;
    time_point now() const noexcept { return tp_; }         // NOT static — injected
    void advance(duration d) { tp_ += d; fire_due_timers(); }
private:
    time_point tp_{};
};
```

Design points that separate a working virtual clock from a broken one:

- **It must satisfy the `Clock` requirements loosely enough to substitute for `steady_clock`, but `now()` cannot be `static`** if the clock carries state, so the SUT must take a clock *reference or template parameter*, not call `Clock::now()` on a type. Templating on the clock type and holding an instance is the usual resolution and costs nothing at runtime.
- **Advancing the clock must fire due timers, in timestamp order, and timers scheduled by those callbacks must be honoured within the same advance** if their deadline falls inside the window. Getting this wrong (firing only the timers due at the start of the window) hides cascading-timeout bugs.
- **Ties must break deterministically.** Two timers at the same virtual nanosecond need a stable secondary key (insertion sequence). Otherwise the simulation is nondeterministic despite the fixed seed.
- **Jump-ahead vs step.** `advance_to_next_event()` is what makes simulation fast; `advance(1ms)` in a loop is what you want when testing a busy-poll loop's behaviour. Provide both.
- **Model the hazards you care about.** A virtual `system_clock` should be able to step backwards or slew (Ch. 35 §35.9) so that leap-second and NTP-step handling is testable — code that computes `now() - then` with a wall clock and gets a negative duration is a real production bug class. A virtual clock that can only move forward monotonically cannot find it.
- **Multiple clock domains.** Real systems have a NIC hardware timestamp, a TSC-derived timestamp, and a system clock, each with its own offset and drift (Ch. 35 §35.3, Ch. 48 §48.11, Ch. 59 §59.9). A simulator that models them as one clock cannot test the correlation logic; give each domain its own virtual clock with a configurable, seed-chosen offset and drift rate.

**Testing timeouts without sleeping.** The direct payoff: a heartbeat-timeout test (Ch. 54 §54.2) becomes `clock.advance(29s); EXPECT_ALIVE(); clock.advance(2s); EXPECT_TIMEOUT();` — exact, instant, and free of flakiness. Every `std::this_thread::sleep_for` in a test suite is simultaneously a source of flakes (too short on a loaded CI box) and of slowness (too long everywhere else); a virtual clock eliminates both. "How do you test a 30-second timeout without waiting 30 seconds?" is a standard question and the expected answer is exactly this.

**The enforcement problem** is the recurring theme: one library that calls `std::chrono::steady_clock::now()` internally re-introduces real time. Audit with `nm`/`objdump` for `clock_gettime` and `__vdso_clock_gettime` references in the simulation binary (Ch. 34 §34.4), and fail the build if any appear outside the adapter layer.

---

## 57.14 Recorded Packet Replay

**Replay** drives the system with bytes captured from the real venue. It is the highest-fidelity input available short of connecting to the exchange, and it is the only way to test against the venue's *actual* behaviour rather than its documented behaviour.

**Capture.** `tcpdump -i eth0 -w feed.pcap -s 0 --time-stamp-precision=nano` for software timestamps; for anything latency-relevant, capture with **NIC hardware timestamps** (`-j adapter_unsynced`, or a dedicated capture appliance / port mirror) because software timestamps carry the capture host's scheduling jitter (Ch. 48 §48.4, §48.9). For multicast feeds, capture both the A and B feeds on separate interfaces with a common time base so arbitration logic (Ch. 53 §53.6) can be replayed faithfully. Store the pcap alongside the venue's session metadata (which multicast groups, which schema version, which trading date) — a pcap without that metadata is unreplayable a year later.

**Replay modes**, and what each is for:

| Mode | Mechanism | Answers |
|---|---|---|
| **Logical** | Feed decoded messages straight into the handler, ignoring pcap timestamps | Is the book correct? (Ch. 53 §53.9) — the deterministic, CI-friendly mode |
| **Paced (virtual)** | Advance the virtual clock to each packet's capture timestamp | Do timeouts, gap timers, and staleness detection behave? |
| **Wire, wall-clock-paced** | `tcpreplay --pps=` or `--multiplier=` onto a real NIC | Does the full stack including kernel/bypass path work? |
| **Wire, accelerated** | `tcpreplay --topspeed` | Overload behaviour, queue watermarks (Ch. 52 §52.16) |

**Determinism is the point of the logical mode.** Replay of a fixed pcap through a fixed build must produce a byte-identical output log — the same book snapshots, the same signals, the same orders. Diff the output against a golden run in CI; any diff is either an intended behaviour change (review it) or a regression. This turns a full trading day into a single, enormous, exact regression test, and it catches things no unit test will: a rare message type that appears twice a year, an auction transition (Ch. 49 §49.12), a halt, a mid-day symbol re-mapping (Ch. 49 §49.10).

**Pitfalls that make replay lie:**
- **Capture drops.** `tcpdump` reports `packets dropped by kernel`; a lossy capture produces phantom sequence gaps and trains your gap logic on fiction. Check the drop counters on every capture and reject lossy ones (Ch. 46 §46.16).
- **Timestamps are capture-point timestamps**, not the venue's send time; one-way latency conclusions from a single capture point are invalid (Ch. 48 §48.10).
- **Replayed TCP is not TCP.** A pcap of a TCP session cannot be replayed onto a live socket without a stack that reconstructs the session; `tcpreplay` replays *frames*. For order-entry sessions, replay at the message layer against a mock exchange instead.
- **Bytes are personally and commercially sensitive** — your own order flow appears in an order-entry capture. Retention and access rules apply.
- **The replay harness itself becomes the bottleneck** in accelerated mode; measure whether you are testing the system or the replayer.

---

## 57.15 Fault Injection

**Fault injection** deliberately makes dependencies fail so that error paths — which are otherwise the least-executed and least-reviewed code in the system — are exercised. Untested error handling is where outages come from: the recovery path runs for the first time during the incident.

**Levels, cheapest first:**

| Level | Mechanism | Injects |
|---|---|---|
| Interface | Simulated I/O layer returns errors (§57.12) | `EAGAIN`, short writes, `ECONNRESET`, timeouts |
| Library | `LD_PRELOAD` shim over `send`/`recv`/`malloc`/`write` | Syscall failures without touching the SUT |
| Allocator | Failing allocator after *n* allocations | `bad_alloc` on every allocation site in turn |
| Kernel/network | `tc netem`, `iptables -j DROP`, `nftables` | Loss, delay, reorder, duplication, partition |
| Process | `kill -9`, `SIGSTOP`, `kill -STOP` for *n* seconds | Crash-consistency, watchdog behaviour |
| Filesystem | `dm-flakey`, full disk, read-only remount | Journal write failures (Ch. 56 §56.1), log-retention failure (Ch. 60 §60.13) |
| Machine | Power-cut / VM reset | Durability vs visibility (Ch. 32 §32.28) |

```
# Network chaos on the market-data interface
tc qdisc add dev eth1 root netem loss 0.5% delay 200us 50us distribution normal \
   reorder 1% duplicate 0.1%
# Partition the order gateway from the venue for 5 seconds
iptables -A OUTPUT -d 10.1.2.3 -j DROP ; sleep 5 ; iptables -D OUTPUT -d 10.1.2.3 -j DROP
```

**The specific faults that matter in a trading system**, each mapping to a required behaviour:

- **Market-data gap** → gap detection, replay request, snapshot recovery, and a *stale-market* declaration if recovery is slow (Ch. 53 §53.4, §53.8).
- **Order-gateway disconnect mid-order** → the in-flight order's state is *unknown*; the system must not assume rejection. Cancel-on-disconnect (Ch. 54 §54.13) and reconciliation against drop copy (Ch. 54 §54.15) are the required behaviour, and this is the highest-consequence error path in the system.
- **Duplicate execution report** → idempotent state transitions (Ch. 54 §54.8).
- **Exchange rejects with an unexpected code**, or acknowledges a cancel twice.
- **Slow consumer** on an internal queue → backpressure or drop, per the declared policy (Ch. 52 §52.15–§52.16), never unbounded growth.
- **Crash between journal append and `fsync`** → replay recovery must reach a consistent state (Ch. 56 §56.3). Inject by `kill -9` at a randomized point, then run recovery and compare to the model.
- **Allocation failure** on a cold path. `bad_alloc` propagating through a `noexcept` function calls `std::terminate` (Ch. 10 §10.12) — that is a legitimate design choice, but it must be a *chosen* one.

**Systematic injection beats random injection for error paths.** The `n`-th-call-fails technique — run the scenario repeatedly, failing the 1st, 2nd, 3rd… fallible operation in turn, until *n* exceeds the number of operations — deterministically covers every error site with no randomness at all. It is the error-path analogue of coverage-guided fuzzing, and it composes with deterministic simulation (§57.12): the simulator picks the injection point from the seed, so every failure replays.

---

## 57.16 Load Burst and Soak Testing

Trading systems are not tested at average load; they fail at the **burst**. Market data arrives in microbursts — an open, a macro release, a halt lift — where instantaneous rate exceeds the daily average by one to two orders of magnitude (Ch. 39 §39.5).

**Design the load profile from measured production data**, not from a round number: take the maximum observed packets-per-second over a 1 ms window across the last year, apply the headroom factor from capacity planning (Ch. 56 §56.10, Ch. 60 §60.14), and test at that. A test at "10× average" is meaningless if the observed peak is 60× average over 1 ms.

**Measurement discipline is where load tests are usually wrong:**

- **Coordinated omission** (Ch. 43 §43.3) is the dominant error. A closed-loop harness that sends the next message only after the previous response arrives stops measuring exactly when the system is slow, and reports a p99 that is off by orders of magnitude. Use an **open-loop** generator that sends on a fixed schedule regardless of responses, and record latency against the *intended* send time. If a send is late because the harness itself stalled, that must be recorded, not hidden.
- **The load generator must be measurably faster than the SUT** and on separate hardware/cores, or you are measuring the generator (Ch. 43 §43.8).
- **Report the full distribution**: p50, p99, p99.9, p99.99, and max, via HDR histograms with correct quantile aggregation (Ch. 43 §43.4–§43.5). Never average percentiles across intervals.
- **Test the queueing region.** The interesting behaviour is at 70–95 % of capacity, where the throughput–latency curve turns (Ch. 52 §52.14) and small load increases produce large latency increases. Testing at 20 % and at 200 % tells you nothing about the knee.

**Overload behaviour is the assertion, not throughput.** Beyond capacity the system must degrade in the specified way: shed load, drop the oldest, widen quotes, or stop quoting (Ch. 52 §52.16, Ch. 56 §56.12) — with counters incremented and alarms raised (Ch. 59 §59.11). An unbounded queue that turns a burst into a growing backlog produces *stale* trading decisions, which is worse than dropping.

**Soak** (see also §57.9) is the long-duration counterpart, and its assertions are about *drift*: RSS, allocation counts, queue high-water marks, descriptor counts, and p99.9 must be flat over 24+ hours. A rising p99.9 with flat throughput indicates fragmentation, growing hash tables, or page-table/TLB pressure (Ch. 32 §32.7). Run soak at realistic load with realistic message mix — a soak of a single symbol misses the reference-data and symbol-churn paths entirely.

**Performance regression testing in CI** belongs here as a discipline. Microbenchmarks on shared CI runners are dominated by noise (frequency scaling, noisy neighbours, THP, Ch. 43 §43.7–§43.9). What works: a dedicated, tuned, isolated benchmark host (pinned cores, fixed frequency, C-states disabled, THP off, Ch. 35 §35.11–§35.14); compare against a rolling baseline rather than an absolute threshold; gate on a **statistical** criterion (e.g. Mann–Whitney U or a change in the median exceeding *k*σ of historical run-to-run variance) rather than a single-run delta; and track a stable **proxy metric** alongside wall time — instructions retired, cache misses, branch misses (Ch. 43 §43.16) — because those are far less noisy than nanoseconds and localize the regression to a code change immediately. A cheap and underrated gate: assert the *absence* of allocations, syscalls, and page faults on the hot path (via a counting allocator, `seccomp` counting, and `getrusage` minor-fault deltas), which is deterministic and never flaky.

---

## 57.17 Failover Testing

**Failover** is the transition from a failed primary to a standby (Ch. 56 §56.4). It is simultaneously the highest-consequence and least-exercised path in the system, and the only way to trust it is to trigger it deliberately and often.

**Test the fault classes separately**, because they produce different behaviour:

| Fault | Standby's observation | Danger |
|---|---|---|
| Clean shutdown | Explicit relinquish | Easiest; least representative |
| `kill -9` | Heartbeat stops | The realistic case |
| `kill -STOP` (or a long GC/page-fault stall) | Heartbeat stops, **process still alive and holding resources** | Split-brain: the frozen primary resumes and acts on stale state |
| Network partition | Heartbeat stops both ways | Both sides may claim primacy |
| Asymmetric partition (primary can send, not receive) | Standby sees heartbeats; primary sees nothing | Confuses naive quorum logic |
| Slow primary (not failed) | Heartbeats late, work still happening | Flapping if the timeout is too tight |

The `SIGSTOP` and partition cases are the ones that matter, and they are exactly what a "kill the process and see if it recovers" test omits.

**What to assert:**
1. **No double-trading.** The old primary must be fenced before the new one acts (Ch. 56 §56.5). A monotonic epoch/fencing token, checked by the exchange session or by a shared resource, is the standard mechanism; assert that a resumed old primary's orders are rejected.
2. **State convergence.** After failover, the standby's positions, working orders, and sequence checkpoints must match the model (Ch. 56 §56.7). Reconcile against drop copy (Ch. 54 §54.15) as part of the test.
3. **Bounded failover time**, measured, with a distribution — and specifically the market-data gap window during the transition.
4. **Idempotent recovery.** Failover during recovery, and failover twice in quick succession, must not compound the damage. Test the failover-during-failover case explicitly; it is where most designs break.
5. **Cancel-on-disconnect fired**, or that the standby adopted the working orders — never both, never neither.

**Mechanics.** Chaos-style random killing during a replay or simulation run (§57.12, §57.14) covers the space cheaply, and DST makes each failure replayable. Beyond that, schedule a **routine, non-emergency failover in production** — a weekly or per-session planned switch — because a failover path that is only exercised in tests will still have an environment-specific defect (a config file only present on the primary, a permission, a stale ARP entry). "We fail over on purpose every week" is a strong answer to "how do you know your failover works."

---

## 57.18 Hardware-in-the-Loop Testing

**Hardware-in-the-loop** (HIL) means the system under test runs on production-identical hardware, connected to real NICs, real switches, and — where applicable — real FPGAs, with a device or process on the other end emulating the venue. It exists because everything below the socket API is untestable in simulation.

**What only HIL can validate:**

- **NIC and driver behaviour**: ring sizing and overflow (Ch. 48 §48.13), interrupt coalescing (Ch. 46 §46.6), RSS/flow-steering hash distribution (Ch. 46 §46.12–§46.14), multicast filtering in the NIC (Ch. 37 §37.8) and whether a group is actually joined.
- **Kernel-bypass stacks**: OpenOnload/ef_vi/DPDK path behaviour, huge-page allocation, descriptor and completion-queue ownership rules (Ch. 47 §47.13) — a bypass path bug is invisible to any socket-level test.
- **FPGA logic and the FPGA/software handover** (Ch. 48 §48.1–§48.5), including the bypass-to-software failover path.
- **Switch behaviour**: microburst absorption, buffer depth, cut-through vs store-and-forward latency, ECMP hashing (Ch. 39).
- **PTP synchronization and hardware timestamping** accuracy (Ch. 35 §35.7, Ch. 48 §48.4).
- **True end-to-end latency** with hardware timestamps at both ends — the only trustworthy tick-to-trade number (Ch. 52 §52.1).
- **Environmental effects**: BIOS settings, C-state and turbo behaviour (Ch. 35 §35.12–§35.13), IRQ affinity, NUMA placement of the NIC relative to the thread (Ch. 29 §29.21).

**The venue emulator** is the other half. It must be a real, maintained component: it speaks the exact wire protocol, implements the venue's matching and priority rules well enough to produce realistic fills (Ch. 50 §50.18), emits the market-data feed derived from its own book (so the feed and the fills are consistent), enforces the venue's rate limits and throttles (Ch. 54 §54.11–§54.12), and can be told to misbehave: reject, respond late, drop a fill, send a duplicate, gap the feed. Many venues publish a certification/UAT environment — use it for conformance, but do not depend on it for latency or for adversarial behaviour, since it is shared, remote, and not production-representative.

**Measurement in HIL must be external.** In-process timestamps measure your software; a **passive tap or port-mirror capture with hardware timestamps** on both the market-data ingress and the order egress gives the wire-to-wire figure that includes everything you cannot see from inside (Ch. 48 §48.10). Any latency claim measured only in-process is understated by the driver, NIC, and PCIe time.

**Cost is the constraint.** A full HIL rig duplicates production hardware, so it is scheduled — nightly full runs, pre-release conformance runs, and post-change verification — while the fast, deterministic suites (§57.1–§57.15) gate every commit. Stating that split, and why, is the expected answer.

---

## 57.19 Loopback Latency Testing

**Loopback testing** measures the latency of a path by sending a message out and receiving it back, so that both timestamps come from the same clock and no cross-host clock synchronization error contaminates the result (Ch. 48 §48.11).

**The loopback variants form a ladder**, and the discipline is to measure each one so you can subtract:

| Loop | Path | Typical order of magnitude (x86 server, tuned) |
|---|---|---|
| In-process function call | No I/O at all | ns |
| Thread-to-thread SPSC queue | Cache-line transfer (Ch. 26 §26.3) | tens of ns |
| `AF_UNIX` / shared memory IPC | Kernel or shm (Ch. 33) | hundreds of ns – µs |
| `127.0.0.1` socket loopback | Full kernel stack, no NIC | ~10–30 µs RTT |
| NIC internal/PHY loopback | Through the driver and NIC, not the wire | µs |
| Cable loopback (port to port) | Real SerDes and PCIe both ways | µs |
| Through a switch to a second host and back | Adds two switch hops and a cable | µs, and the number that matters |

**The critical caveat: `127.0.0.1` is not representative.** Loopback traffic bypasses the driver, the NIC, and much of the offload path; it has no MTU-driven segmentation cost, no DMA, no interrupt, and different memory-copy behaviour. A kernel-bypass stack (Ch. 47) typically does not intercept loopback at all, so a "we measured 8 µs on loopback" claim tests a code path that does not exist in production. Use loopback for functional testing and for measuring *application* processing time; use a cable or a switch loop for anything you will quote.

**Round-trip halving is not one-way latency.** RTT/2 assumes a symmetric path, which is false whenever ingress and egress differ — different queues, different offloads, market data in on multicast and orders out on TCP (Ch. 48 §48.10). Quote RTT as RTT, and get one-way numbers from hardware timestamps at two synchronized points (PTP, Ch. 35 §35.7).

**Method, briefly.** Open loop at a fixed rate, one timestamp source (TSC with a calibrated conversion, or NIC hardware timestamps, Ch. 43 §43.12–§43.13), record every sample into a preallocated array and analyze offline — never compute statistics inside the loop. Warm the caches, branch predictors, and TLB first (Ch. 43 §43.6, Ch. 60 §60.7); pin to isolated cores; fix the frequency. Report percentiles, and expect a distinctly multi-modal distribution: the modes correspond to interrupt coalescing, C-state exit, page faults, and the occasional scheduler interference, and identifying *which* mode moved after a change is the actual diagnostic value of the test.

**Regression use.** A daily loopback latency run on the HIL rig, tracked as a time series with percentile bands, catches the slow accumulation of latency that no single commit's benchmark would flag — a driver update, a BIOS change, a kernel upgrade that re-enabled a mitigation (Ch. 27 §27.18). That is the operational reason this test exists as a standing job rather than a one-off measurement.

---

## Key Interview Questions

1. **Why can't a normal test find a memory-ordering bug?** — The buggy interleaving may be impossible on your hardware (x86 TSO hides store→store and load→load reordering), the compiler's reordering is fixed per build, and even an observed pass says nothing about what the model permits. TSan reasons over happens-before; model checkers enumerate the model.
2. **How do you test a lock-free queue?** — Invariant-checking stress harness (sequence + checksum, assert no gaps/duplicates/reordering) under TSan; randomized/PCT scheduling with a fixed seed; a relacy or CDSChecker harness for the synchronization skeleton; a model-based test against a `std::deque` model; and run it on AArch64.
3. **Why does TSan miss races in hand-rolled lock-free code?** — Inline asm and intrinsics are not instrumented, and custom synchronization is invisible unless annotated with `__tsan_acquire`/`__tsan_release`. Build from `std::atomic` if you want it checked.
4. **What is deterministic simulation testing and what does it require?** — Whole system single-threaded with injected clock, I/O, and RNG so a run is a pure function of the seed; requires all time and I/O behind interfaces and no real threads. It tests logic under adverse orderings, not latency.
5. **How do you test a 30-second timeout without waiting 30 seconds?** — Virtual clock injected into the SUT; `advance()` fires due timers in order. Eliminates both flakiness and slowness.
6. **What is coordinated omission and how does it break a load test?** — A closed-loop harness stops sending while the system is slow, so the slow period is under-sampled and p99 is understated by orders of magnitude. Fix: open-loop generation, latency measured from the *intended* send time.
7. **What makes a good property in property-based testing?** — Round-trip, invariant, metamorphic, idempotence, or model-equivalence — plus a *state-aware* generator, or the interesting paths are never reached. Shrinking is what turns a failure into a bug report.
8. **How would you find bugs in a hand-vectorized parser?** — Differential fuzzing against a scalar reference: mutate the input, decode with both, assert structural equality including accept/reject agreement.
9. **Why fuzz with a sanitizer, and what does `-fsanitize=fuzzer` actually instrument?** — Without a sanitizer you only find hard crashes. It inserts edge coverage (`trace_pc_guard`) and comparison tracing (`trace_cmp`), the latter letting the fuzzer solve magic-number and length checks.
10. **What are the highest-yield malformed-message mutations?** — Truncation at every offset, length/count fields exceeding the buffer, `length - header_size` unsigned underflow, zero-length elements causing non-advancing loops, unknown message types, and misaligned starts.
11. **How do you make a rare concurrency failure reproducible?** — Seeded yield injection at atomic/lock points compiled only in the test build, plus `rr record --chaos` for record/replay, plus committing the shrunk reproducer rather than just the seed.
12. **Why does replaying a captured trading day catch things unit tests never will?** — It contains the real venue's rare behaviours — infrequent message types, auctions, halts, symbol remaps — and produces a byte-comparable golden output for regression diffing.
13. **What's wrong with measuring latency over `127.0.0.1`?** — It bypasses driver, NIC, DMA, and interrupts, and kernel-bypass stacks don't intercept it; it measures a path that does not exist in production. Use a cable or switch loop.
14. **How do you run performance regression tests in CI without constant false alarms?** — Dedicated tuned isolated host, rolling baseline, statistical change detection rather than a fixed threshold, plus low-noise proxy counters (instructions, cache misses) and deterministic assertions on allocation/syscall/page-fault counts.
15. **Which failover fault is most often untested, and why does it matter?** — `SIGSTOP`/stall and asymmetric partition: heartbeats stop but the primary is alive and later resumes, producing split-brain. Fencing tokens and an assertion that a resumed old primary is rejected.
16. **When is model checking practical for C++ concurrency?** — Only on a small extracted synchronization skeleton (2–3 threads); state-space explosion rules out whole programs. relacy/CDSChecker/GenMC; herd7 for litmus questions about ARM vs x86.
17. **How does model-based testing differ from property-based testing?** — MBT maintains a simple executable model and asserts equivalence after each command in a random sequence; PBT asserts an invariant over generated inputs. They converge once your PBT generator becomes stateful.
18. **What does hardware-in-the-loop testing cover that simulation cannot?** — NIC rings and coalescing, kernel-bypass and FPGA paths, switch buffering and microbursts, PTP and hardware timestamping, BIOS/C-state effects, and genuine wire-to-wire latency measured by an external tap.
19. **Why systematically inject the n-th failure rather than random failures?** — It deterministically covers every error site with no randomness, converging in a bounded number of runs; it is the error-path analogue of coverage guidance.

---

## Common Traps

- **Believing a passing stress test proves memory-ordering correctness** — x86 TSO hides the reordering; the same binary always behaves the same way.
- **Running concurrency tests only on pinned, isolated cores** — no preemption ever occurs, so preemption bugs ship. Test oversubscribed too.
- **Using TSan and ASan together** — incompatible; needs separate builds. And neither sees inline asm.
- **Fuzzing without a sanitizer** — finds only hard crashes; misses every out-of-bounds read.
- **Fuzzing with checksum validation enabled** — the fuzzer never gets past the CRC gate; gate it behind a fuzzing-only macro.
- **A fuzz target with no assertions** — finds memory-safety bugs only, not logic bugs.
- **Testing a decoder only with whole messages** — it will fail on the first split TCP segment or coalesced pair.
- **Generating protocol vectors from your own encoder** — proves self-consistency, not conformance.
- **Auto-updating golden files on failure** — eventually blesses a regression.
- **Uniform-random generators in property/model tests** — nearly all inputs are discarded or trivially invalid; the interesting states are never reached.
- **Recording only the seed, not the shrunk reproducer** — the seed stops reproducing the moment the generator changes.
- **`git bisect` on a 1-in-200 flake with one run per commit** — needs ~3/p repeats per step.
- **Assuming a fixed seed gives determinism** — unordered-container iteration, pointer values, ASLR, and real clocks all leak nondeterminism.
- **One `steady_clock::now()` left in the SUT** — destroys deterministic simulation silently; enforce with a symbol check.
- **A virtual clock that cannot go backwards or slew** — leaves NTP-step and leap-second handling untested.
- **Closed-loop load generation** — coordinated omission; p99 understated by orders of magnitude.
- **Averaging percentiles across intervals** — mathematically meaningless; aggregate histograms instead.
- **Load testing only far below or far above capacity** — misses the knee of the throughput–latency curve, which is where the system actually operates.
- **Asserting throughput instead of overload behaviour** — the requirement is *how* it degrades, with counters and alarms.
- **Soak tests whose only assertion is "still running"** — track RSS, allocations, queue watermarks, and p99.9 drift, and justify the duration against wraparound periods.
- **Testing failover only with a clean kill** — misses `SIGSTOP`, asymmetric partition, and failover-during-failover.
- **Quoting RTT/2 as one-way latency** — paths are asymmetric.
- **Measuring latency in-process in a HIL rig** — understates by the driver, NIC, and PCIe time; measure with an external hardware-timestamped tap.
- **Replaying a pcap with kernel drops** — trains gap-recovery logic on fictional gaps.
- **Letting the load generator or replayer be the bottleneck** — you are measuring the harness.

---

## Compact Recall Summary

**Unit boundaries.** A unit test injects its clock, opens no socket, starts no unjoined thread, and is shuffle-independent — enforce mechanically. Prefer template policies or raw-byte data boundaries over virtual seams so testability doesn't cost an indirect call on the hot path.

**Generative techniques.** *Property-based*: for-all invariants with shrinking; the generator must be state-aware. *Differential*: two implementations, one input — fast vs scalar parser, your book vs the venue's snapshot, optimized vs `-O0`; the hard part is defining equality. *Model-based*: an obviously-correct slow model (`std::map` book, `std::deque` queue) driven by the same random command sequence, checked after every command. *Fuzzing*: coverage-guided in-process (libFuzzer/AFL++) with a sanitizer always on, `-max_len`, dictionaries, corpus in VCS, `-minimize_crash`; `trace_cmp` is why it defeats magic numbers.

**Protocol correctness.** Committed byte vectors from real captures, covering field extremes, absent-vs-zero, split and coalesced messages, endianness, and encode/decode byte-equal round trips. Then malformed input: truncation, oversized length/count, `length - header` unsigned underflow, zero-length non-advancing loops, unknown types — and assert the *policy* (reject, count, resynchronize), not merely the absence of a crash.

**Concurrency.** Normal tests cannot find ordering bugs: x86 TSO hides the reordering, compilation is fixed per build, and observation ≠ permission. TSan (happens-before, ~10× slow, blind to inline asm, incompatible with ASan) is the workhorse; PCT/randomized yield injection with a fixed seed makes rare interleavings reachable and replayable; oversubscribe to force preemption; run AArch64 CI; and model-check the extracted skeleton with relacy/CDSChecker/GenMC, with herd7 for litmus questions.

**Determinism.** One seed, logged every run; one RNG threaded explicitly with derived sub-streams; eliminate unordered iteration, pointer-derived values, ASLR, and real clocks; commit shrunk reproducers, not seeds. Deterministic simulation puts the whole system single-threaded behind injected clock/I/O/RNG so a run is a pure function of the seed — it validates logic under adverse orderings, never latency. Virtual clocks fire due timers on `advance`, break ties deterministically, model multiple clock domains, and can step backwards.

**Realism.** Replay hardware-timestamped captures logically (deterministic, golden-diffed in CI) and on the wire (`tcpreplay`) for the stack; watch for capture drops and remember `127.0.0.1` isn't the production path. Fault injection is systematic (fail the n-th operation) rather than random, and covers gap, disconnect-with-in-flight-order, duplicate fill, slow consumer, and crash-between-append-and-`fsync`. Load tests are open-loop, measured against intended send time, run at the knee of the curve, and assert graceful degradation; soak asserts flat RSS, allocations, watermarks, and p99.9. Failover tests must include `SIGSTOP` and asymmetric partition, assert fencing and convergence, and be exercised routinely in production. HIL covers NIC/bypass/FPGA/switch/PTP and is the only source of a trustworthy wire-to-wire number, measured by an external tap.
