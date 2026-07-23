# Chapter 43 — Measurement and Profiling

## Why this matters

Performance work begins with a question, not a stopwatch.

A timing result can be numerically precise and still answer the wrong question. A profile can identify where samples landed and still say nothing about why the program became slower. A hardware counter can count an event faithfully while its interpretation is wrong for the processor, workload, or measurement scope.

This chapter develops a disciplined path from question to causal conclusion:

> question → hypothesis → experiment → distribution → diagnosis → controlled change → remeasurement

The tools are secondary. Chapter 44 catalogs tools and their setup. Chapter 35 covers host and operating-system tuning, and Chapter 29 covers NUMA mechanisms. Here the focus is the reasoning that makes measurements credible.

## The 90-second version — Core

Before running anything, write down:

1. **Question:** What decision will this measurement support?
2. **Estimand:** Exactly what quantity are you trying to estimate—request latency, useful throughput, CPU time, allocations per operation, or something else?
3. **Population:** Which requests, machines, inputs, and operating conditions should the claim cover?
4. **Experimental unit:** What is independently repeated—a process run, request, machine, or deployment?
5. **Controls:** What stays fixed, and what changes?
6. **Statistic:** Which summary and uncertainty answer the question?
7. **Artifact:** Where are the raw observations, build identity, commands, and environment record?

Then follow three rules:

- Measure the workload the user experiences. Closed-loop load often hides pauses; averages often hide tails.
- Use profiles, counters, and traces to form hypotheses. Confirm a cause by changing one relevant factor and repeating the experiment.
- Attach context to every reported performance number: environment, workload, sample definition and count, and statistic.

A compact report might say:

> On host `bench-07` (processor model, memory configuration, OS and kernel recorded in `environment.txt`), build `9f31c6a` compiled with the recorded command processed the fixed 2 GiB corpus. Across 20 fresh-process paired runs in randomized A/B order, candidate B reduced the median per-run wall time from 1.84 s to 1.62 s; the paired median improvement was 11.7%, with a 95% bootstrap interval of 9.8%–13.1%. Raw run data and analysis code are attached.

The numbers in that example are illustrative. The form is the important part: there is no context-free “B is 12% faster.”

### Label the source of each claim

Performance discussions often fail because claims from different layers are blended together. Use these labels, explicitly in notes and mentally in prose:

- **Standard:** a language or library contract, such as `steady_clock::is_steady`. A Standard claim must not be inflated into a promise about a particular timer instruction or read cost.
- **OS:** an operating-system contract, such as the semantics of a Linux clock or scheduler tracepoint. It can change across operating systems and sometimes kernel versions.
- **Tool:** behavior documented by a specific tool and version, such as how a benchmark framework defines an iteration or how `perf` scales multiplexed counts.
- **Vendor:** a processor or product contract, such as an event encoding or timestamp-counter ordering rule for a named processor family.
- **Measured:** an observation from the recorded build, machine, workload, and sample. This is evidence about that population, not a portable guarantee.

Also distinguish **model-derived** values. A corrected histogram, simulated cache count, fitted regression coefficient, or bootstrap interval is computed under assumptions. It is neither a direct hardware observation nor “false”; its assumptions are part of its meaning.

When sources disagree, the narrowest applicable contract usually wins. A blog’s claim about “cycles” cannot override the event definition for the measured processor. A framework feature cannot make an unrepresentative workload representative. A measured result does not become a C++ guarantee because the code is portable.

## 43.1 Start with a falsifiable performance question

“Is this fast?” is not an experimental question. “Does replacing the tree lookup with a flat hash table reduce steady-state lookup latency for the production key distribution without increasing memory beyond the service budget?” is.

A useful hypothesis predicts an observable difference:

> For the recorded corpus and load, implementation B will reduce request latency because it performs fewer dependent cache-missing loads.

This statement separates two things:

- the **outcome hypothesis**: B changes latency;
- the **mechanism hypothesis**: fewer dependent misses explain the change.

The benchmark tests the first. Profiles and counters may support the second. A controlled intervention—for example, changing only the data layout while preserving the algorithm and workload—provides stronger causal evidence.

### Define the estimand

An *estimand* is the exact quantity the experiment intends to estimate. Common estimands include:

- elapsed time for one batch;
- service time for one operation;
- response latency from intended arrival until completion;
- completed useful operations per second;
- CPU time per request;
- bytes allocated per transaction;
- a distribution quantile over a specified request population.

The wording matters. “Latency” might mean:

- client-observed round-trip time;
- time spent queued plus time executing;
- time inside one server function;
- CPU time consumed by a request.

Those are different quantities. A server can have low function time and terrible client latency because requests wait in a queue. It can have stable CPU time but unstable wall time because it is descheduled.

### Specify the population and workload

A benchmark input is a sample from some population. Describe the intended population before choosing the sample:

- key-size and value-size distributions;
- success, miss, and error ratios;
- concurrency and arrival process;
- read/write mix;
- dataset size and locality;
- cold-start, warmed, or long-running state;
- dependency behavior and failure modes.

Uniform random keys are not a substitute for a skewed production distribution. A dataset that fits in the last-level cache does not support a claim about a multi-gigabyte working set. A single-threaded loop does not establish service throughput under contention.

Keep a tiny deterministic workload for correctness and fast iteration, but use a representative workload for the performance claim. Record the generator and its seed.

### Distinguish latency from throughput

**Latency** is time per outcome. **Throughput** is completed useful work per unit time. They interact but are not interchangeable.

A throughput benchmark should define:

- what counts as a successful unit of work;
- how failures, retries, batching, and dropped work are counted;
- the measurement interval;
- offered load and concurrency.

A latency benchmark should define its start and end events. For an externally arriving request, the most useful start is often the intended arrival time, not the time at which a worker finally dequeues it.

Under stable conditions, Little’s law relates average number in the system \(L\), arrival/completion rate \(\lambda\), and average time in the system \(W\):

\[
L = \lambda W
\]

It is a consistency check, not permission to infer an entire latency distribution from an average. Near saturation, a small throughput change can accompany a large change in queueing latency.

## 43.2 Design the experiment before collecting data

Performance measurements are comparisons against controls. The simplest useful design has a baseline A, a candidate B, a declared workload, and repeated observations under comparable conditions.

### Choose the experimental unit

Thousands of operations inside one process are not necessarily thousands of independent experiments. They share:

- allocator and cache state;
- frequency and thermal history;
- JIT or dynamic-linker state, where applicable;
- background interference;
- the same process and operating-system scheduling episode.

If the treatment is a program build, a fresh process run is often the experimental unit. Per-operation observations within a run are still valuable for describing latency, but treating them as independent replicates can produce implausibly narrow confidence intervals.

For a service, an independent deployment window or isolated replay may be the unit. For a NUMA claim, repetition across memory and thread placements may be essential. State the unit explicitly.

### Pair, randomize, and interleave

Machine conditions drift. Running all A trials before all B trials confounds the implementation with time.

Useful designs include:

- randomized A/B order for fresh-process runs;
- paired A and B trials using the same input shard;
- interleaved measurements when switching is cheap and carry-over is controlled;
- blocked experiments, such as comparing A and B within each machine or dataset.

Pairing can remove variation due to a shared input or time block. Analyze the paired differences, not two unrelated piles of measurements.

Randomization does not make a noisy host quiet. It makes systematic time ordering less likely to masquerade as a treatment effect.

### Control what matters, record the rest

Typical controls include:

- source revision and uncommitted changes;
- compiler, standard library, optimization flags, link mode, and debug information;
- input bytes and random seed;
- process arguments, environment variables, and dependency versions;
- machine model, memory configuration, firmware, OS, and kernel;
- thread count, affinity, CPU frequency policy, SMT state, and NUMA placement;
- background load, container limits, and power/thermal state.

Isolation, CPU affinity, frequency control, and NUMA placement can reduce variation, but they can also create an environment unlike production. Chapter 35 owns the platform-specific tuning procedures. Report both the controlled setup and why it represents the target system.

Do not silently delete inconvenient runs. Predeclare invalidation rules such as “discard the entire paired block if the correctness check fails” or “repeat the run if the host monitor records another benchmark process in the reserved CPU set.” Ordinary jitter is part of the observed system.

### Correctness remains a gate

A faster program that does less work is not an optimization. Before interpreting timing:

- compare outputs or invariants;
- count completed and failed work;
- ensure input generation is outside the measured region unless it is part of the estimand;
- check that caching, memoization, or batching has not changed semantics;
- inspect optimized code when dead-code elimination or constant folding is plausible.

Correctness checks should preferably run outside the timed region. If they must remain inside, state that the measurement includes them.

## 43.3 Choose and validate the clock

The C++ standard provides clocks through `<chrono>`. For elapsed intervals, start with `std::chrono::steady_clock`. The Standard guarantees that a steady clock does not decrease and advances at a steady rate. It does **not** specify the epoch, hardware source, practical resolution, read cost, or mapping to a particular operating-system clock.

```cpp
const auto start = std::chrono::steady_clock::now();
run_workload();
const auto stop = std::chrono::steady_clock::now();

const auto elapsed =
    std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start);
```

`high_resolution_clock` is not automatically better. Its identity and steadiness are implementation choices. Check the properties you need instead of relying on the name.

### Resolution, precision, and read cost

These are different:

- **Resolution** is the smallest distinguishable step exposed by the clock.
- **Precision** describes repeatability of observations.
- **Accuracy** describes closeness to the intended physical or reference time.
- **Read cost** is the work and perturbation introduced by obtaining a timestamp.

The duration type’s nominal tick period is not proof of effective resolution. Measure an empty timing bracket on the target platform and inspect its distribution. If the work is close to the clock’s granularity or read cost, batch many operations:

\[
\text{time per operation} =
\frac{\text{batch elapsed} - \text{estimated harness contribution}}
     {\text{completed operations}}
\]

The subtraction is an experimental model, not exact bookkeeping. Report the batch size and the empty/control measurement. Prefer a batch large enough that the result is not dominated by subtracting two similar noisy values.

### Operating-system clocks

Systems expose additional choices. On Linux, for example, monotonic, raw monotonic, process CPU-time, thread CPU-time, and boot-time clocks have different semantics. Whether suspend time, clock adjustment, or CPU consumption should count depends on the question.

These are operating-system contracts, not C++ guarantees. Record the selected clock and why it matches the estimand:

- use elapsed monotonic time for user-visible duration;
- use process or thread CPU time when the question is consumed CPU rather than waiting;
- use tracing timestamps when correlating events across the system, after validating their clock domain.

### TSC timing is platform-specific

On x86, `RDTSC` and `RDTSCP` expose a timestamp counter. They are ISA-level facilities, not Standard C++. Correct use depends on processor and operating-system properties:

- whether the TSC is invariant and synchronized across relevant logical CPUs;
- instruction ordering around the measured region;
- migration between CPUs;
- conversion from ticks to time;
- virtualization behavior;
- the distinction between counter frequency and current core frequency.

`RDTSCP` has ordering properties different from `RDTSC`, but neither name is a universal benchmarking recipe. Fences, dependencies, and serialization requirements depend on what must be ordered. Validate against vendor documentation for the exact processor and against a known-duration clock on the measured system. Pinning a thread may address migration but does not solve every ordering or calibration issue.

For most application benchmarks, a well-designed batched measurement using `steady_clock` is easier to defend. TSC timing belongs in specialized low-level experiments whose calibration and ordering protocol is part of the report.

## 43.4 Summarize distributions without erasing them

Suppose observations are \(x_1, \ldots, x_n\).

The arithmetic mean is:

\[
\bar{x} = \frac{1}{n}\sum_{i=1}^{n}x_i
\]

The sample variance is:

\[
s^2 = \frac{1}{n-1}\sum_{i=1}^{n}(x_i-\bar{x})^2
\]

The median is the middle order statistic, with a conventional interpolation rule when required. A sample \(p\)-quantile is likewise based on ordered observations, but software packages use several interpolation conventions. Record the convention or retain the raw data so it can be recomputed.

Each summary answers a different question:

- the **mean** describes total time divided by count and matters for capacity and aggregate cost;
- the **median** describes a central observation and resists a small number of large values;
- **variance** or standard deviation describes spread when those moments are informative;
- **quantiles** describe positions in the observed distribution;
- a **histogram** shows shape, modes, gaps, and tails.

Report a distribution, not a winner chosen from whichever statistic looks favorable. At minimum, show count, central tendency, useful tail points, minimum/maximum or a plot, and the exact population represented.

### Tail percentiles are order statistics, not magic

The p99 is a point below which approximately 99% of the represented observations fall under the chosen convention. It does not mean “the slowest 1% are all explained,” nor does one sample p99 establish a population guarantee.

Tail estimates need enough relevant observations and enough independent coverage of operating conditions. There is no universal rule such as “N samples makes p99.9 valid.” Uncertainty depends on:

- sample count;
- tail probability;
- dependence among observations;
- distribution shape;
- stationarity;
- quantile convention;
- required confidence and decision tolerance.

Use an interval for the quantile where practical. A binomial order-statistic interval can avoid strong distributional assumptions for independent observations. Bootstrap methods can be useful, but resampling individual requests is wrong when dependence occurs at the run level; resample the independent units or use a block method justified by the data-generating process.

Always show the raw tail count. If 10,000 requests were observed, only about ten observations occupy the upper 0.1% region. That statement follows from the defined count and percentile; it is not a claim that those observations are independent or sufficient.

### Never average percentiles

The p99 of Monday and the p99 of Tuesday do not average to the p99 of both days. Quantiles are nonlinear, and differently sized groups make the error worse.

To obtain an aggregate quantile:

- merge raw observations and compute the quantile once; or
- merge compatible histograms/sketches whose ranges, precision, and semantics are recorded; or
- combine empirical distributions with correct weights.

Do not merge histograms with different units, clipping ranges, or definitions of latency. Do not report a quantile above the recorder’s maximum range as if it were observed.

### Histograms and HDR Histogram

Histograms make distributions inspectable without storing every observation. Their bucket layout determines precision and range. Record:

- unit;
- lowest and highest trackable values;
- bucket or significant-digit configuration;
- overflow and underflow counts;
- reset/rotation interval;
- whether concurrent recording is supported by the selected implementation.

HDR Histogram is a family of implementations and configurations designed for a wide dynamic range with controlled relative precision. Complexity, allocation, synchronization, and lock-free properties are implementation-specific. Treat them as measured/vendor claims, not properties guaranteed by the idea of an HDR histogram.

If exact reanalysis matters, preserve raw samples where feasible. If volume requires sketches or histograms, version the encoding and test merge behavior.

### Confidence and repeatability

A confidence interval quantifies uncertainty under a sampling model; it does not prove the benchmark is unbiased or representative. More iterations inside one flawed run narrow the interval around the wrong target.

For A/B comparisons, report an effect size:

- absolute difference;
- ratio or percentage change;
- uncertainty interval;
- the independent sample count.

Repeat on fresh processes, and when the intended population spans machines, repeat across machines. If results differ materially by machine, that interaction is part of the conclusion.

“Repeatable” means another investigator can use the recorded artifacts and obtain results compatible with the stated uncertainty—not that every run prints the same digits.

## 43.5 Warmup, state, and coordinated omission

### Warmup is a workload property

Programs change state during execution:

- code and data enter caches;
- pages are faulted and mappings established;
- branch predictors acquire history;
- allocators grow arenas and caches;
- dynamic linking or one-time initialization completes;
- CPU power, frequency, and temperature change;
- adaptive algorithms alter internal structure.

There is no portable “discard the first N iterations” rule. Decide which state is relevant:

- **cold/startup** performance: include initialization and cold state;
- **steady-state** performance: define and justify a stability criterion;
- **mixed lifecycle** performance: reproduce the actual sequence.

Plot observations against time or iteration. Predeclare a warmup rule based on observable state, not on deleting slow points until the curve looks flat. Run long enough to detect late transitions. If users experience both startup and steady operation, report both.

Multiple fresh-process repetitions are still needed. A million post-warmup operations from one process do not reveal process-to-process variation.

Google Benchmark supports minimum warmup time, repetitions, aggregate reporting, randomized interleaving, and custom contexts. These are useful controls, not substitutes for defining the target state.

### Coordinated omission

Coordinated omission occurs when the load generator’s request schedule pauses in response to a slow system, so requests that should have arrived during the pause are never represented.

Consider a closed-loop generator:

```text
send request
wait for response
send next request
```

If one response stalls, the generator stops offering work. It records one slow request, while a real independent arrival stream might have accumulated many delayed requests. The observed service-time distribution can therefore conceal overload and queueing.

An open-loop schedule instead defines intended arrival times independently:

```text
for each intended arrival:
    wait until its scheduled time
    submit or record inability to submit
```

For response latency, record:

\[
\text{response latency} =
\text{completion time} - \text{intended arrival time}
\]

This includes delay caused by a saturated generator or queue. Also record offered, accepted, completed, rejected, timed-out, and dropped request counts. A throughput number that silently omits rejected work is misleading.

Some histogram libraries offer coordinated-omission correction by synthesizing missing observations using an expected interval. That correction is model-based: it assumes an arrival interval and cannot reconstruct arbitrary real arrivals. Report the interval and algorithm. Prefer an independently scheduled load generator when it represents the target system.

Coordinated omission is not a reason to ban closed-loop tests. A closed-loop test is correct when the real user waits before issuing the next operation and that behavior is the population of interest. The error is using it to support an open-loop service-level claim.

## 43.6 A compact measurement harness

The following C++23 program emits one raw duration per operation and a checksum. It demonstrates data capture, not a universal nanobenchmark:

```cpp
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string_view>
#include <system_error>
#include <vector>

using Clock = std::chrono::steady_clock;

std::uint64_t mix(std::uint64_t x) noexcept {
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebULL;
    return x ^ (x >> 31);
}

std::size_t parse_count(std::string_view text) {
    std::size_t value{};
    const auto [end, error] =
        std::from_chars(text.data(), text.data() + text.size(), value);
    if (error != std::errc{} || end != text.data() + text.size()) {
        throw std::runtime_error("invalid iteration count");
    }
    return value;
}

int main(int argc, char** argv) {
    const std::size_t count =
        argc == 2 ? parse_count(argv[1]) : 100'000;
    std::vector<Clock::duration> samples;
    samples.reserve(count);

    std::uint64_t state =
        static_cast<std::uint64_t>(Clock::now().time_since_epoch().count());

    for (std::size_t i = 0; i < count; ++i) {
        std::atomic_signal_fence(std::memory_order_seq_cst);
        const auto begin = Clock::now();
        state = mix(state + i);
        std::atomic_signal_fence(std::memory_order_seq_cst);
        const auto end = Clock::now();
        samples.push_back(end - begin);
    }

    for (const auto sample : samples) {
        std::cout
            << std::chrono::duration_cast<std::chrono::nanoseconds>(sample)
                   .count()
            << '\n';
    }
    std::cerr << "checksum=" << state << '\n';
}
```

Build and run with commands recorded in the experiment:

```sh
c++ -std=c++23 -O3 -DNDEBUG bench.cpp -o bench
./bench 100000 > samples-ns.txt 2> run-metadata.txt
```

The standard `atomic_signal_fence` constrains some compiler motion with respect to signal handlers; it is not a hardware fence and is not a general guarantee that arbitrary benchmark code remains intact. The checksum makes the result observable, but compilers may still transform computations when semantics allow it. Inspect optimized assembly and test a control harness.

This program measures each operation together with two clock reads and harness effects. If `mix` is shorter than or comparable to those effects, measuring batches is more appropriate. It also allocates the sample vector before the loop but writes into it during measurement; for extremely small operations, even that independent work can perturb caches and execution. Production-quality harnesses separate or account for such effects.

### Google Benchmark barriers

Google Benchmark provides `benchmark::DoNotOptimize(value)` and `benchmark::ClobberMemory()` as implementation-specific compiler barriers:

```cpp
static void BM_lookup(benchmark::State& state) {
    Table table = make_table(static_cast<std::size_t>(state.range(0)));
    std::uint64_t key = seed_from_runtime();

    for (auto _ : state) {
        key = next_key(key);
        benchmark::DoNotOptimize(key);
        const auto result = table.lookup(key);
        benchmark::DoNotOptimize(result);
    }
}
BENCHMARK(BM_lookup)->Arg(1 << 16);
```

`DoNotOptimize` does not promise that the expression used to produce its argument cannot be optimized. `ClobberMemory` does not automatically model every hardware memory effect. Read the installed library’s documentation and inspect the generated code. Keep fixture construction outside the timed loop unless construction is the estimand.

Framework features help with timing and reporting, but the experiment still needs:

- representative inputs;
- explicit warmup semantics;
- fresh-process or otherwise independent repetitions;
- randomized or paired comparisons;
- raw or sufficiently rich distribution output;
- environment and build records.

## 43.7 Profiling asks where; experiments ask why

A benchmark establishes that a behavior exists under specified conditions. Profiling helps locate associated work or waiting.

Three broad observation modes are:

- **Sampling:** periodically interrupt or observe execution and attribute samples to instruction pointers or stacks.
- **Instrumentation:** add events at function entry/exit or selected points.
- **Tracing:** record timestamped events and relationships across threads, processes, or devices.

Sampling usually has lower data volume and can estimate where CPU time is spent. Instrumentation can count calls and durations but may perturb short or frequent functions substantially. Tracing reveals sequences, queueing, wakeups, and off-CPU intervals, at potentially high volume and overhead.

Choose based on the hypothesis. Do not begin by collecting every available event.

### CPU sampling and flame graphs

A CPU sample profile estimates the distribution of sampled on-CPU instruction locations. With stack collection, it can attribute samples through call paths.

A flame graph aggregates stacks:

- vertical position represents stack depth;
- horizontal width represents sample weight for a function and its descendants;
- horizontal order generally does not represent time.

Width is not the duration of one invocation. A wide frame may be called often, run for a long time, or inherit work from descendants. Missing frames can result from unwinding limitations, inlining, stripped symbols, tail calls, or sampling bias.

Compare profiles only when sample period, event, stack method, workload, and normalization are compatible. Record unresolved-frame rates and total samples.

### Allocation profiling

Use allocation profiling when the hypothesis involves allocation rate, size distribution, lifetime, fragmentation, or allocator contention. Useful questions include:

- Which call paths allocate the most bytes?
- Which allocate most frequently?
- Which allocations remain live at a chosen point?
- Which paths contend on allocator state?

Bytes allocated and live bytes are different estimands. Sampling profilers may miss small or rare allocation classes depending on their sampling policy. Instrumented allocation tracing can alter timing and contention. Validate with application counters or allocator statistics where possible.

### Lock contention

CPU profiles can make blocked threads disappear because blocked time is not on-CPU time. To investigate contention, collect evidence such as:

- blocked duration attributed to lock or call path;
- wait and hold-time distributions;
- owner/waiter relationships;
- runnable delay and scheduler wakeups;
- retries or failed acquisitions.

Instrumenting every lock operation may itself change contention. Start with sampling or coarse tracing, then narrow the scope.

### Off-CPU profiling

An off-CPU profile attributes time when a thread is not executing:

- sleeping for I/O or timers;
- blocked on locks or condition variables;
- waiting for page faults;
- descheduled while runnable;
- waiting in runtime or kernel queues.

“Off CPU” is not synonymous with “blocked by the kernel,” and different tools define intervals differently. Scheduler traces are often needed to distinguish voluntary sleep from runnable-but-not-scheduled delay.

For latency investigations, align client request identifiers, application spans, queue events, scheduler events, and I/O completion in a compatible clock domain. This is tracing’s strength: it can expose a causal sequence that an aggregate profile erases.

### Probe effect

Every observer changes the observed system:

- sampling interrupts consume CPU;
- stack unwinding touches memory;
- instrumentation changes code layout and branch behavior;
- trace buffers allocate memory and generate I/O;
- debug builds change optimization;
- hardware-event groups may alter scheduling or multiplexing.

Measure the probe effect with a control:

1. run the workload without the tool;
2. run it with the selected collection mode;
3. compare the same outcome metrics and correctness counters;
4. report the tool configuration and observed difference.

There is no universal acceptable overhead. A diagnostic run may tolerate substantial slowdown if event relationships remain meaningful; a capacity claim may not.

## 43.8 Hardware counters and Linux `perf`

Performance-monitoring units (PMUs) count or sample processor events. Examples include cycles, retired instructions, branches, cache-related events, and model-specific stalls. Their names may look universal while their definitions are not.

Treat a counter as:

> a model-specific event, observed over a defined scope, with documented counting conditions

Record:

- processor model and microcode;
- event name and raw encoding when relevant;
- user/kernel/hypervisor inclusion;
- thread, process, CPU, or system scope;
- SMT and CPU placement;
- `time_enabled` and `time_running`, or equivalent multiplexing data;
- tool and kernel versions;
- workload interval and repetition design.

### `perf stat`

On Linux, a compact first pass might be:

```sh
perf stat \
  -e task-clock,cycles,instructions,branches,branch-misses \
  -- ./bench 100000
```

This syntax is tool- and OS-specific. Event availability and meaning depend on the PMU, kernel, permissions, virtualization, and `perf` version. Run the same controlled repetitions as the wall-time benchmark; one counter invocation is not a statistical study.

Derived ratios can be useful:

\[
\text{instructions per cycle} =
\frac{\text{retired instructions}}{\text{cycles}}
\]

but they inherit both events’ definitions and measurement errors. “IPC increased” is a description, not a cause. It might accompany less stalling, more speculative work, a different instruction mix, or changed frequency behavior.

### Multiplexing

The PMU has a limited number of programmable counters. If too many events are requested, the tool may rotate groups over time and scale observed counts.

Scaling estimates a full-interval count under assumptions about representativeness. It cannot remove temporal bias when phases differ and an event was scheduled mainly during one phase. Prefer small, hypothesis-driven event groups, inspect enabled/running time, repeat groups over comparable runs, and use fixed counters where documented.

Event grouping can preserve simultaneous measurement of related events but may make a group unschedulable. Check tool output rather than assuming the requested set ran.

### Sampling skid and bias

Overflow-based sampling records an instruction pointer after an event threshold. The recorded instruction may be displaced from the instruction that caused the event; this is **skid**. Precise-event mechanisms such as PEBS or IBS can improve attribution for supported events on supported processors, but their availability and semantics are vendor- and model-specific.

Sampling also has other biases:

- fixed-period sampling can synchronize with periodic work;
- frequency-based sampling changes the period;
- interrupt latency affects attribution;
- short functions may receive few samples;
- stack unwinding can fail systematically;
- lost records can distort hot paths.

Vary the sampling period or use randomized periods where supported, report lost samples, and corroborate important findings with another observation or an intervention.

### `perf record`, `report`, and `annotate`

A typical Linux CPU-profile sequence is:

```sh
perf record -g -- ./service --replay workload.bin
perf report --stdio
perf annotate --stdio
```

The exact call-graph mode, event, frequency, symbol files, and permission requirements must be recorded. `perf report` aggregates samples by symbols and call paths. `perf annotate` maps samples to source or instructions when symbols and mapping are adequate. Neither establishes that the hottest instruction is the best optimization target; it may be unavoidable work or merely where delayed samples land.

### Top-down analysis

Top-down microarchitectural analysis classifies pipeline slots into broad categories and, on supported processors, refines them into subcategories such as retiring, bad speculation, frontend bound, and backend bound.

Use the event formulas and collection method documented for the exact processor family and tool version. Category names do not make thresholds portable. A large backend-bound fraction is a direction for investigation, not proof that “memory is the bottleneck.” Correlate it with the algorithm, dependency chains, cache/TLB events, bandwidth measurements, and a controlled change.

## 43.9 A worked diagnosis

The following is a deliberately complete *illustrative record*, not a transferable benchmark result.

### Question and design

Question: Does replacing per-request construction of a temporary vector with reuse of reserved thread-local storage reduce end-to-end decode latency without reducing completed throughput?

Hypothesis: the candidate reduces allocator activity and allocator-lock waiting, which reduces both central and tail latency under concurrent load.

Recorded environment for every number below:

- one specified AMD EPYC server, processor model and memory population in the artifact;
- Linux 6.8.12, firmware and microcode identifiers recorded;
- GCC 14.1, C++23, exact `-O3` build and link commands recorded;
- fixed CPU set and NUMA placement recorded; no other benchmark job admitted;
- fixed 8 GiB request corpus, SHA-256 and generator seed recorded;
- 16 worker threads;
- open-loop offered rate of 120,000 requests/s for each 60 s measured interval;
- 10 s startup phase recorded separately;
- 20 fresh-process paired A/B blocks, order randomized within each block;
- one paired block is the independent unit;
- client latency is completion minus intended arrival;
- offered, accepted, completed, rejected, and timed-out counts retained.

Those details belong beside the data. Without them, the following numbers have no defensible scope.

### Outcome

Across the 20 paired measured intervals:

- baseline A’s median of per-run median latencies was 84 µs;
- candidate B’s median of per-run median latencies was 70 µs;
- the median paired change in per-run median latency was −14 µs;
- a 95% bootstrap interval, resampling the 20 paired blocks, was −17 µs to −11 µs;
- A’s aggregate p99.9 was 4.8 ms and B’s aggregate p99.9 was 1.6 ms, computed once from each variant’s merged raw request observations, not by averaging run percentiles;
- each variant had 144,000,000 intended arrivals across its 20 intervals; exact completed, rejected, and timed-out counts were included in the data;
- completed useful throughput was reported per run and showed no material loss under the predeclared tolerance.

Again, these values are invented to demonstrate reporting. Every value is tied to the stated environment, sample, interval, and statistic.

### Diagnosis

A CPU sampling profile collected on separate diagnostic repetitions showed substantial sample weight under allocation paths in A and less in B. An allocation profile showed fewer allocation calls per completed request in B. A scheduler/lock trace associated long A requests with allocator-lock wait intervals.

Those observations support the mechanism but do not yet prove it:

- sampling weight is not elapsed time per call;
- allocation instrumentation may perturb the allocator;
- lock waits may correlate with some other workload phase;
- the diagnostic runs are not the primary outcome runs.

The causal check introduced two additional controls:

1. baseline A with capacity reserved once per worker but without the candidate’s other refactoring;
2. candidate B with reuse disabled while preserving its surrounding code layout.

Under the same 20-block paired design, the reserve-only control reproduced most of the latency change, while disabling reuse removed it. Allocation count and lock-wait time changed in the predicted direction. The conclusion can therefore be narrow:

> In the recorded environment and workload, reusing reserved per-worker storage caused the observed latency improvement; the evidence is consistent with reduced allocation and allocator-lock waiting.

It would still be wrong to claim “thread-local vectors are always faster,” that the allocator is universally slow, or that the result applies at another offered load. A rate sweep should test where queueing begins and whether the improvement persists.

### How the experiment could have failed

A closed-loop generator would have issued fewer requests during stalls and likely understated the tail. Averaging 20 p99.9 values would not produce the aggregate p99.9. Treating 144 million requests as independent experimental units would exaggerate certainty because requests share run-level conditions. Using only an on-CPU flame graph could miss lock waiting. Reading an allocation counter once without rerunning the outcome would show correlation, not causation.

## 43.10 From evidence to a causal conclusion

Use this ladder:

1. **Observe:** the outcome differs under a declared design.
2. **Localize:** a profile, counter, or trace identifies associated work or waiting.
3. **Predict:** the proposed mechanism predicts another observable change.
4. **Intervene:** change one mechanism-relevant factor while preserving other conditions.
5. **Repeat:** the outcome and diagnostic evidence change as predicted.
6. **Bound:** state the machines, workload, load range, and uncertainty to which the claim applies.

Counterfactual controls are powerful. If removing a suspected cache miss changes the counter but not latency, the miss may not be on the critical path. If a faster function leaves end-to-end latency unchanged, queueing or another stage may dominate.

Negative results are useful when the experiment has enough sensitivity to detect a decision-relevant effect. State the smallest effect the design could distinguish credibly; “no statistically significant difference” is not proof of equality.

### The reproducibility bundle

A performance change should carry:

- question, hypothesis, estimand, and acceptance criterion;
- source revision and patch;
- compiler and linker identities and exact commands;
- executable identity;
- machine, firmware, OS, kernel, runtime, and dependency record;
- workload, corpus hash, generator, seed, arrival model, and duration;
- isolation, affinity, frequency, SMT, NUMA, and container settings;
- clock and timing boundaries;
- repetition, pairing, randomization, and invalidation rules;
- raw observations and correctness counters;
- analysis script and package versions;
- profiler/counter/tracer commands and probe-effect control;
- plots or summaries with units, sample counts, statistics, and uncertainty;
- conclusion with explicit scope and remaining alternatives.

Store raw values in a simple versioned format. Include column definitions. A file named `latency.csv` without saying whether each row is a service time, client response, run summary, or corrected synthetic observation is not reproducible.

## 43.11 Skippable reference: match the tool class to the question

Chapter 44 owns installation, command catalogs, and tool selection details. This map keeps the experimental question in front:

| Question | First evidence | Useful tool class | Main caveat |
|---|---|---|---|
| Did end-to-end latency change? | Raw client timings and request counts | Benchmark/load generator | Arrival model and coordinated omission |
| Where is on-CPU work? | Sampled instruction pointers/stacks | Sampling profiler, flame graph | Skid, unwinding, sample bias |
| Where do threads wait? | Scheduler and blocking events | Off-CPU profiler/tracer | Clock correlation and trace overhead |
| Are allocations implicated? | Allocation count/bytes/lifetime by path | Allocation profiler | Sampling policy or instrumentation effect |
| Is lock contention implicated? | Wait/hold distributions and ownership | Contention profiler/tracer | Added synchronization and attribution |
| Which source/instruction receives samples? | Symbolized samples | `perf report`/`annotate`, VTune | Symbols, inlining, skid |
| Which microarchitectural direction merits testing? | Small compatible event group | `perf stat`, VTune, LIKWID, PCM | Model-specific semantics and multiplexing |
| How would an idealized cache behave? | Simulated cache accesses | Cachegrind | Simulation model differs from hardware |
| Which call relationships dominate in an instrumented model? | Call counts/cost attribution | Callgrind | Instrumentation and model overhead |
| What happened across components over time? | Timestamped related events | Tracing | Volume, loss, and probe effect |

Vendor tools such as Intel VTune and Intel PCM expose processor-specific analysis; LIKWID provides topology and counter workflows on supported systems; Valgrind’s Cachegrind and Callgrind use instrumentation/simulation rather than measuring the physical PMU. Their availability, event models, overhead, and license/version behavior can change. Record versions and consult their documentation rather than transferring assumptions between tools.

Linux `perf` behavior is an OS/tool contract. PMU event meaning is a processor/vendor contract. C++ clock behavior beyond the Standard’s stated properties is an implementation/platform fact. Measured overhead applies only to the recorded configuration.

## 43.12 Recall card

- Define the **question, estimand, population, and experimental unit** before measuring.
- Latency needs explicit start/end events; throughput counts completed useful work.
- Pair and randomize A/B trials; repeat independent units.
- Use a steady elapsed clock, validate effective resolution and harness cost, and batch tiny work.
- Keep raw distributions. Report counts, units, uncertainty, and tail observations.
- Never average percentiles; merge compatible observations or distributions.
- Warmup has no universal iteration count. Define cold, steady, or lifecycle state.
- Closed-loop generation can omit delays that an independent arrival stream would experience.
- Profiles and counters localize correlations. Interventions test causes.
- Counter semantics, multiplexing, skid, and tool overhead are part of the result.
- CPU profiles miss off-CPU waiting; traces can expose queues, locks, and scheduling.
- Every performance number needs environment, workload, sample definition/count, and statistic.

## Review questions

1. Why can a million operation timings from one process still represent only one independent experimental unit?
2. Define service time and response latency for a queued request. Which one exposes queueing?
3. Why is the average of per-host p99 values not the fleet p99? What data can be merged correctly?
4. What evidence would distinguish a cold-start effect from ordinary random jitter?
5. How does a closed-loop load generator create coordinated omission?
6. Why can scaled multiplexed counter values remain biased?
7. What does the width of a flame-graph frame mean, and what does it not mean?
8. Give one control that measures profiler probe effect.
9. Why does a hardware-counter correlation not by itself establish a causal mechanism?
10. What information must accompany a claim that candidate B is 8% faster?

## Exercise: design and audit a benchmark

Choose one operation from an existing program. Write a one-page experiment plan containing:

1. the decision, hypothesis, estimand, and target population;
2. a correctness oracle;
3. baseline and candidate treatments;
4. workload distribution, seed, and arrival/concurrency model;
5. timing boundary and clock;
6. experimental unit, independent repetition count, pairing, and randomization;
7. warmup or lifecycle semantics;
8. summaries and uncertainty;
9. one profiler, counter, or trace selected from the hypothesized mechanism;
10. a probe-effect control and a causal intervention.

Run the plan and publish raw data plus an environment record. Then ask another person to audit it for:

- dead-code elimination or changed work;
- unrepresentative inputs;
- hidden queueing or coordinated omission;
- pseudoreplication;
- averaged percentiles;
- unreported exclusions;
- counter multiplexing or profile bias;
- conclusions broader than the measured population.

## Puzzle

Variant B has a lower median and p99 service time than A in a closed-loop test. Under an open-loop replay at the production arrival rate, B has a worse p99 response latency even though its mean CPU time per request is lower. How can all statements be true?

One possible explanation is that B occasionally pauses all workers—for example through synchronized reclamation or a contended global resource. The closed-loop clients stop issuing during the pause, omitting would-be queued requests. Mean CPU time falls because ordinary requests do less work, and recorded service times look good. Under independent arrivals, requests accumulate during the global pause, so queueing makes response latency worse. A scheduler/lock trace aligned with intended arrivals can test this hypothesis.

## Common traps

- Timing a debug build or accidentally comparing different correctness behavior.
- Letting the compiler remove, hoist, precompute, or combine the work.
- Measuring setup when the claim concerns steady operation—or deleting setup when users pay for it.
- Reporting the timer’s nominal period as its measured resolution.
- Using CPU time to answer an elapsed-latency question.
- Treating requests within one run as independent replications.
- Running all baseline trials before all candidate trials.
- Removing outliers without a predeclared, externally justified rule.
- Reporting a mean alone for a multimodal or heavy-tailed distribution.
- Averaging percentiles or merging incompatible histograms.
- Claiming a tail quantile without showing the observation count.
- Using a closed-loop generator for an independent-arrival service claim.
- Treating synthetic coordinated-omission correction as observed data.
- Choosing a fixed warmup count without defining target state.
- Reading PMU event names as portable hardware facts.
- Ignoring counter multiplexing, event scope, SMT, or kernel inclusion.
- Treating sampled instruction addresses as exact event locations.
- Reading flame-graph width as duration per call.
- Looking only at on-CPU profiles when latency is dominated by waiting.
- Assuming a profiler’s overhead is negligible without a control.
- Concluding causation from a single hot function or correlated counter.
- Publishing a percentage without raw data, environment, sample count, and statistic.

## Prerequisite check

You are ready to apply this chapter when you can:

- compile an optimized C++ program and preserve its exact build command;
- explain wall time versus CPU time;
- distinguish a request, a run, and an independent experimental unit;
- compute a mean and identify a sample quantile;
- state why correlation from a profile or counter needs an intervention;
- preserve raw measurements and enough metadata to reproduce their meaning.

If any item is unfamiliar, practice with the compact harness first. Measure an empty bracket, a batched operation, and several fresh-process runs. The goal is not the smallest number. It is a claim whose meaning survives scrutiny.
