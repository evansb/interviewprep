# Chapter 35 — Time and Low-Latency Tuning

**Baseline:** C++23 on Linux. CPU, kernel, daemon, and device behavior is
versioned and labelled; none is a portable C++ guarantee.

## 35.0 Why This Changes the Decision — Core

A latency number is meaningful only when its timestamps share a defined clock
domain and capture points. A host-tuning change is useful only when it removes a
mechanism visible in the before/after distribution. These are the same
discipline: identify the state that produced an observation, change one cause,
and preserve enough evidence to explain the result.

This chapter therefore has two passes:

1. choose clocks, interpret timestamps, and understand how Linux keeps and
   synchronizes time;
2. qualify and tune a Linux host through hypotheses, controlled changes,
   rollback, and distributions.

Chapter 31 owns scheduling and affinity mechanisms, Chapter 32 owns virtual
memory and huge pages, Chapter 29 owns NUMA, Chapter 43 owns benchmark design,
and Chapter 46 owns the Linux packet path. This chapter applies those mechanisms
without reteaching them.

### Claim labels

- **[C++23]** is guaranteed by the C++ standard.
- **[POSIX]** is a POSIX API contract.
- **[Linux]** is Linux behavior and can depend on kernel/configuration.
- **[x86]** is an x86 architectural property; other architectures differ.
- **[Vendor]** is firmware, driver, CPU, NIC, or tool behavior to verify.
- **[Measured]** must name the host, versions, workload, sample count, and
  statistic. No unlabeled cycle or nanosecond figure in this chapter is a
  promise.

---

## 35.1 90-Second Screen — Core

Five facts:

1. Use a monotonic clock for elapsed time and deadlines. Wall time can be
   administratively stepped; a duration computed across two timestamp domains
   is meaningless without a measured conversion.
2. Linux time is a mapping from a hardware clocksource to clock IDs such as
   `CLOCK_MONOTONIC` and `CLOCK_REALTIME`. Clocksource, clock ID, timestamp
   capture point, and synchronization state are different concepts.
3. `constant_tsc`, `nonstop_tsc`, cross-core synchronization, and instruction
   ordering are separate TSC properties. `RDTSCP` is ordered after earlier
   instructions but does not by itself prevent later work moving before the
   measurement; it also does not guarantee prior stores are globally visible.
4. NTP and PTP estimate offset over paths with delay and asymmetry. Hardware
   timestamping moves the capture point out of scheduler/driver noise, but it
   does not erase path asymmetry or establish application timestamp semantics.
5. Host tuning is an experiment, not a checklist. Every change needs a
   hypothesis, workload, before/after distribution, side-effect metric,
   rollback, and verification that the setting remained active.

Two decisions to defend:

- **What does this timestamp mean?** State clock/domain, producer, capture point,
  synchronization chain, uncertainty, and whether values may be ordered or
  subtracted.
- **What jitter source are you removing?** Name its observable signature and
  explain why the benefit outweighs power, throughput, thermal, operational, or
  isolation cost on this workload.

---

## 35.2 The Linux Timekeeping Stack — Core

The shortest useful model has four layers:

```
hardware counter           kernel mapping              exposed clock
TSC / arch counter /  ──>  multiplier + offset  ──>  CLOCK_MONOTONIC
paravirtual counter        discipline state            CLOCK_REALTIME
        │                                              CLOCK_BOOTTIME
        └─ clocksource                                 CLOCK_TAI

NIC oscillator ──> PTP hardware clock (/dev/ptpN) ──> explicit synchronization
```

A Linux **clocksource** is a counter used by kernel timekeeping. Candidates and
selection are platform-dependent. On a typical x86 host, inspect:

```bash
cat /sys/devices/system/clocksource/clocksource0/available_clocksource
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
dmesg | grep -iE 'clocksource|tsc'
```

**[Linux]** The kernel converts counter deltas with a multiplier/shift and
maintains offsets for its clock IDs. On supported architectures and clock IDs,
the vDSO lets `clock_gettime` read shared kernel state and a user-readable
counter without a syscall. This is not “TSC only”: ARM architectural counters
and paravirtual clocks can also support user-space paths. CPU-time clocks,
dynamic PTP clocks, unsupported IDs, or a platform without a suitable vDSO path
may enter the kernel.

The clocksource watchdog may reject an unstable source and select another.
That can change read cost and jitter, but “timestamp reads got slower” is not
proof of a TSC-to-HPET switch. Check the selected source, kernel log, syscall
rate, and generated/vDSO path. Do not force `tsc=reliable`, disable a watchdog,
or remove fallback sources until the hardware and virtualization behavior has
been validated; those boot parameters trade detection for trust.

`clock_getres` reports nominal clock resolution, not read cost, accuracy to UTC,
or wake-up precision. Measure those separately.

### Clock-read failure signatures

| Observation | Plausible mechanism | Discriminating evidence | Unsafe shortcut |
|---|---|---|---|
| read latency distribution shifts after boot | selected clocksource/vDSO/kernel/firmware changed | sysfs, `dmesg`, `strace` sample, binary and kernel identity | forcing `tsc=reliable` from the latency graph alone |
| rare large reads | preemption, interrupt, SMI, migration, page state, measurement harness | CPU ID, scheduling/IRQ trace, SMI/firmware counters where supported | calling every outlier “clocksource instability” |
| time appears to go backward across workers | mixed clocks, TSC offsets, wall-time step, bad conversion | domain tags, CPU/host IDs, sync logs | clamping negative values to zero |
| resolution is fine but timer wakes late | scheduling/power/IRQ contention after expiry | wake-up trace and cyclictest-style histogram | changing clocksource |
| PHC and system time diverge | missing/wrong PHC↔system discipline or holdover | linuxptp topology/status and cross-timestamps | restarting daemons without preserving evidence |

For a read-cost experiment, pin the thread, record migrations, warm the code/data
path, measure an empty bracket, and retain the whole distribution. `strace` is
useful only as a short diagnostic for syscall presence; ptrace changes timing.

### Storage of a timestamp is a contract

A timestamp record that crosses a module or machine should carry, directly or
through schema metadata:

| Field | Why it is needed |
|---|---|
| value and unit | prevents scale errors |
| clock/domain ID | says which values are comparable |
| producing host/device | identifies oscillator and synchronization chain |
| capture point | wire/PHY, NIC, driver, application receive, business event |
| sync status and uncertainty | bounds interpretation rather than pretending exactness |
| sequence/event identity | orders business events when time is tied or uncertain |

An integer called `timestamp_ns` supplies only two of these fields.

---

## 35.3 Choosing a Clock — Core

**[Linux]** Common `clock_gettime` clocks have different semantics:

| Clock | Administrative step? | Frequency disciplined? | Includes suspend? | Appropriate use |
|---|---:|---:|---:|---|
| `CLOCK_REALTIME` | yes | yes | wall time advances | UTC-like civil timestamp; never elapsed-time arithmetic |
| `CLOCK_MONOTONIC` | no backward step | yes | no | intervals and process-lifetime deadlines |
| `CLOCK_MONOTONIC_RAW` | no | no kernel time discipline | no | oscillator/TSC characterization |
| `CLOCK_BOOTTIME` | no backward step | yes | yes | deadlines that must include system suspend |
| `CLOCK_TAI` | can follow administrative correction | yes | wall time advances | leap-free timescale when TAI offset is correctly configured |
| process/thread CPU-time clocks | n/a | n/a | counts execution time | CPU consumption, not wall latency |

“Monotonic” means it does not run backward; it does not mean constant raw
frequency. Linux disciplines `CLOCK_MONOTONIC` so its seconds track the system's
estimate of elapsed SI time. `CLOCK_MONOTONIC_RAW` exposes an undisciplined rate,
so it can drift relative to synchronized clocks. `CLOCK_TAI` avoids UTC leap
insertions but is not magically accurate: its kernel TAI offset and underlying
wall clock still require correct administration.

**[C++23]** `std::chrono::steady_clock::is_steady` is true and it is appropriate
for intervals. `system_clock` represents system wall time and may be adjusted.
`high_resolution_clock` is implementation-defined and may alias either; inspect
`is_steady` rather than trusting its name. Mapping these clocks to particular
Linux clock IDs is a library implementation choice, not a C++ guarantee.

### A compact clock-reading example

```cpp
#define _POSIX_C_SOURCE 200112L
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>

timespec read_clock(clockid_t id) {
    timespec t{};
    if (::clock_gettime(id, &t) != 0) {
        std::perror("clock_gettime");
        std::exit(EXIT_FAILURE);
    }
    return t;
}

std::chrono::nanoseconds elapsed(timespec begin, timespec end) {
    using namespace std::chrono;
    return seconds{end.tv_sec - begin.tv_sec}
         + nanoseconds{end.tv_nsec - begin.tv_nsec};
}

int main() {
    const timespec begin = read_clock(CLOCK_MONOTONIC);
    // work whose process elapsed time is being measured
    const timespec end = read_clock(CLOCK_MONOTONIC);
    std::printf("%lld\n",
        static_cast<long long>(elapsed(begin, end).count()));
}
```

The helper accepts only timestamps whose caller knows share a clock. A
production timestamp type should encode the domain in its type or data rather
than relying on that comment.

### Timeout traps

- A relative sleep loop schedules the next period after the delayed wake-up, so
  work and wake-up delay accumulate. Use absolute deadlines for periodic work.
- POSIX condition variables use a configured clock. Initialize the condition
  attribute with `pthread_condattr_setclock(..., CLOCK_MONOTONIC)` when waits
  must survive wall-clock changes.
- A clock read around a region includes the read/ordering overhead and any
  preemption. Chapter 43 owns subtraction, distributions, warm-up, and
  benchmark controls.

---

## 35.4 TSC: Four Separate Questions — Core

On x86, the Time Stamp Counter is useful only after answering four questions.
Do not compress them into “invariant TSC.”

1. **Rate invariance.** **[x86/Vendor]** Does the counter advance at a constant
   reference rate rather than current core P-state/turbo frequency? Linux's
   `constant_tsc` flag is relevant evidence.
2. **Continuity.** Does it continue through the idle/sleep states the deployment
   uses? Linux may expose `nonstop_tsc`. Rate invariance and continuity are not
   synonyms.
3. **Cross-CPU synchronization.** Are offsets aligned across cores, sockets,
   boot/resume, and virtual-machine migration? A constant, nonstop counter can
   still have a different offset.
4. **Read ordering.** Did the timestamp bracket the intended instructions, and
   could the thread migrate between reads?

Inspecting `/proc/cpuinfo` is a starting point, not a proof:

```bash
grep -m1 -oE 'constant_tsc|nonstop_tsc|rdtscp|tsc_adjust|hypervisor' \
    /proc/cpuinfo | sort -u
dmesg | grep -iE 'tsc|clocksource'
```

**[Linux/x86]** Linux tests synchronization and can use per-CPU adjustment
facilities on supported systems. Virtualization may offset or scale TSC values;
live migration adds another boundary. Validate the actual hypervisor and
migration policy. If endpoints can migrate, capture `TSC_AUX` with `RDTSCP` or
record `sched_getcpu()` separately, then reject/mend migrated samples.

### Correct ordering language

`RDTSC` is not serializing. A common x86 benchmark pattern is:

```cpp
#include <cstdint>
#include <x86intrin.h>

struct TscStamp {
    std::uint64_t ticks;
    unsigned aux;
};

std::uint64_t tsc_begin() {
    _mm_lfence();
    const std::uint64_t t = __rdtsc();
    _mm_lfence();
    return t;
}

TscStamp tsc_end() {
    unsigned aux{};
    const std::uint64_t t = __rdtscp(&aux);
    _mm_lfence();
    return {t, aux};
}
```

**[x86]** `RDTSCP` waits until earlier instructions have executed and earlier
loads are globally visible before reading the counter. It is not fully
serializing for following instructions, hence the trailing `LFENCE`. It does
not promise that earlier stores are globally visible; a measurement whose end
means “stores visible to other cores/devices” needs the appropriate store fence
and a precise memory/I/O completion definition. Fences also add measured work.

Compiler intrinsic ordering is toolchain behavior. Inspect generated assembly
for the exact compiler/version, and use a compiler barrier where the benchmark
harness requires one. Prefer `steady_clock`/`clock_gettime` for application
deadlines; direct TSC is for controlled measurement or timestamp paths whose
calibration, migration, and ordering contracts are explicit.

A TSC delta is **reference ticks**, not necessarily executed core cycles.
Turbo, throttling, and power states change the amount of work completed per TSC
tick. Convert only with a validated counter frequency, preferably using integer
multiply/shift, and preserve raw ticks for later audit.

---

## 35.5 Timers and Periodic Work — Core

Timer resolution is not wake-up latency. Expiry becomes runnable work through
interrupt, softirq/thread, scheduler, power-state, and contention paths:

```
deadline reached
   └─ timer interrupt / kernel expiry
        └─ task made runnable
             └─ scheduler chooses it
                  └─ CPU resumes user instructions
```

| Facility | Delivery model | Important semantic |
|---|---|---|
| `clock_nanosleep` | blocking thread | `TIMER_ABSTIME` prevents periodic drift |
| `timerfd` | readable fd | composes with `epoll`; read returns expiration count |
| POSIX timer | signal/thread notification | notification choice adds its own hazards |
| `epoll`/`poll` timeout | wait returns | timeout is not an exact execution appointment |
| busy wait | thread polls counter/state | consumes execution resources and can affect SMT, heat, power |

This absolute-deadline loop is Linux/POSIX code. It retries the same deadline
after a signal rather than scheduling from the late wake-up:

```cpp
#define _POSIX_C_SOURCE 200112L
#include <cerrno>
#include <cstdlib>
#include <ctime>

void add_ns(timespec& t, long period_ns) {
    t.tv_nsec += period_ns;
    while (t.tv_nsec >= 1'000'000'000L) {
        t.tv_nsec -= 1'000'000'000L;
        ++t.tv_sec;
    }
}

int main() {
    timespec next{};
    if (::clock_gettime(CLOCK_MONOTONIC, &next) != 0) return EXIT_FAILURE;

    for (int i = 0; i != 100; ++i) {
        add_ns(next, 1'000'000L); // policy: 1 ms scheduled period
        int rc{};
        do {
            rc = ::clock_nanosleep(
                CLOCK_MONOTONIC, TIMER_ABSTIME, &next, nullptr);
        } while (rc == EINTR);
        if (rc != 0) return EXIT_FAILURE;
        // bounded periodic work
    }
}
```

The period is an example policy, not a latency claim. A late iteration does not
shift all future deadlines; the application must separately decide whether to
catch up, skip missed periods, or fail.

**[Linux] Timer slack** allows the kernel to coalesce some timer expiries to save
power. Its value is per task and can be inspected through
`/proc/PID/timerslack_ns` or controlled with `prctl(PR_SET_TIMERSLACK, ...)`
subject to kernel rules. Do not copy a universal “zero slack” prescription:

- condition: a non-RT sleep/wait is delayed by coalescing and the deadline
  matters;
- benefit: a narrower eligible coalescing window;
- cost: more wakeups and power/housekeeping work;
- prerequisite: identify the affected timer and task, not merely a slow request;
- rollback: restore the recorded task policy/value;
- success: the timer-delay component changes without worsening system-wide
  interference.

Busy waiting exchanges wake-up machinery for continuous CPU consumption. It can
keep code/data warm and avoid scheduler delay, but competes with an SMT sibling,
raises power/temperature, and still suffers interrupts, SMIs, and cache/memory
stalls. A hybrid sleep-then-spin needs an empirically chosen handoff window and
must handle late wakeups. “Spin for sub-microsecond precision” is not a portable
guarantee.

### Timer wheels

A timer wheel maps deadlines into time buckets. Insert/cancel can be constant
metadata work for bounded ranges, while expiry processes the current bucket.
Hierarchical wheels add coarser levels for distant deadlines. Resolution,
maximum horizon, cascade work, bucket bursts, and cancellation bookkeeping are
explicit trade-offs.

**[Linux]** Linux uses high-resolution timers and lower-resolution timeout
structures for different needs; exact wheel levels and implementation evolve by
kernel version. The durable design decision is:

| Structure | Insert | Earliest expiry | Cancellation | Best condition |
|---|---:|---:|---:|---|
| ordered heap/tree | logarithmic | precise minimum | index/hook needed | precise, moderate timer count |
| timer wheel | usually constant bucket operation | bucket resolution | constant with intrusive hook | many coarse timeouts, bounded horizon |

An order gateway with many seconds-long cancel timers may prefer a millisecond
wheel; a sub-millisecond scheduling facility may not. A bucket containing many
simultaneous expiries creates a burst even when insertion is O(1).

---

## 35.6 Synchronization and Timestamp Domains — Core

Suppose host A captures event send time `A`, and host B captures receive time
`B`. The reported one-way value is:

```
B - A = path time
      + (clock offset_B - clock offset_A)
      + (capture delay_B - capture delay_A)
```

Synchronization estimates offsets; timestamp placement controls capture delay.
Neither is optional. If the two offset uncertainties are `uA`, `uB`, and path
asymmetry contributes bound `ua`, a conservative interpretation needs those
terms in its uncertainty budget. Printing more decimal places does not narrow
it.

### NTP measurement

NTP exchanges four timestamps:

```
client send t1 ───────────────> server receive t2
client receive t4 <──────────── server send t3

round-trip delay = (t4 - t1) - (t3 - t2)
offset estimate  = ((t2 - t1) + (t3 - t4)) / 2
```

The offset estimator assumes symmetric forward and reverse delay. Queueing
asymmetry appears as clock error. NTP implementations filter sources and
discipline clock frequency/phase over time; daemon algorithms, step thresholds,
startup behavior, and hardware timestamp support are product/version
configuration, not protocol constants.

For a chrony deployment, useful read-only evidence includes:

```bash
chronyc tracking
chronyc sources -v
chronyc sourcestats -v
timedatectl show-timesync --all
```

Do not reduce status to “stratum is low.” Inspect selected source, offset,
frequency estimate, dispersion/uncertainty, reachability, sample age, and
holdover behavior. Test loss of the reference and restart convergence.

### PTP and hardware clocks

PTP uses timestamped event messages, a grandmaster-selection mechanism, and
ordinary/boundary/transparent clock roles. Its advantage is not the acronym:
hardware timestamps can be captured near the MAC/PHY, and PTP-aware network
elements can control or report residence/path effects. Software timestamping,
non-PTP switches, asymmetric routes, poor oscillator holdover, or a wrong
profile can still dominate error.

**[Linux/Vendor]** A NIC may expose a PTP Hardware Clock (PHC) as `/dev/ptpN`.
Check device/driver capabilities and association:

```bash
ethtool -T eth0
ethtool -i eth0
readlink -f /sys/class/net/eth0/device/ptp/ptp*
```

linuxptp commonly uses `ptp4l` to discipline a PHC or another selected clock and
`phc2sys` to synchronize between PHC and system clocks. Direction, profile,
domain number, transport, timestamp mode, and servo options are configuration.
Never assume “`ptp4l` is running” means `CLOCK_REALTIME` is synchronized.
Inspect `pmc`/linuxptp status, daemon logs, PHC-system offset samples, grandmaster
identity, port state, and time-properties data.

A PHC and `CLOCK_REALTIME` are distinct domains even on one host. Reading them
back-to-back includes scheduling/read delay. Linux PTP cross-timestamp ioctls
and supported hardware facilities can estimate the relationship more tightly;
availability and accuracy are driver/device-specific. Application data should
record whether a timestamp came from NIC RX/TX hardware, socket software
timestamping, PHC read, or system clock.

### Build an uncertainty budget

Synchronization health is not one offset field. A useful budget names:

| Term | Typical source | How to constrain it |
|---|---|---|
| source/reference uncertainty | grandmaster/GNSS/atomic or upstream NTP source | source status, holdover model, independent reference |
| path asymmetry | different routes, queueing, PHY/cable direction | network design, transparent/boundary clocks, calibration |
| timestamp placement | application, kernel, driver, MAC/PHY | use comparable capture points and document them |
| servo estimation error | finite/noisy samples, oscillator drift | offset/frequency/skew statistics over time |
| PHC↔system conversion | sequential reads and scheduler delay | supported cross-timestamp mechanism and sampled bounds |
| holdover age | reference loss while oscillator drifts | alarm on source loss and grow uncertainty with age |
| administrative event | step, daemon restart, GM change, leap policy | event log and epoch/status in timestamp metadata |

If host A and B each advertise an uncertainty interval around a common
timescale, a one-way measurement should propagate both intervals plus capture
and path terms. The exact combination depends on whether terms are hard bounds,
correlated errors, or statistical estimates; blindly adding “±100 ns” fields or
root-sum-squaring unknown errors is unjustified.

Clock-comparison tools can lie when their own reads are widely separated.
Prefer a sequence of cross-timestamp samples and use the tightest surrounding
system-time interval only under the kernel API's documented model. Reject
samples across clock steps, grandmaster changes, suspend/resume, or device
reset unless the conversion epoch explicitly handles them.

### Steps, slews, and leap seconds

- A **step** changes a wall-clock offset discontinuously. `CLOCK_REALTIME` and
  clocks derived from that wall-time state can jump. Never use them for elapsed
  time.
- A **slew/discipline** changes clock rate to absorb offset/frequency error.
  `CLOCK_MONOTONIC` does not step backward, but its rate can be disciplined.
  `CLOCK_MONOTONIC_RAW` is intended to expose the raw rate.
- UTC contains leap-second semantics; TAI does not. Kernels, daemons, and fleets
  may step, repeat, smear, or otherwise map civil time according to policy.
  Smear is not interoperable unless every producer/consumer agrees on the same
  mapping.

Sequence numbers remain the authority for exchange-event order. Time is useful
for correlation, deadlines, and audit, but synchronized clocks have uncertainty
and simultaneous values.

---

## 35.7 Measure → Tune → Verify — Core

Host tuning begins with a service-level symptom: for example, a second mode in
receive-to-decision latency after idle, periodic outliers, or correlation with a
particular IRQ. “Use an isolated core” is not a hypothesis.

### The experiment record

For every candidate change, record:

1. exact hardware, firmware, kernel/config, microcode, driver, daemon, and
   application build;
2. topology, CPU set, workload generator, traffic/load shape, warm-up, duration,
   and sample count;
3. timestamp domains and capture points;
4. baseline distribution (not only mean): histogram, selected percentiles,
   maximum with context, throughput, drops, and CPU;
5. mechanism evidence: interrupts, migrations, C/P-state residency, throttling,
   faults, reclaim, temperatures, or trace;
6. one change, expected signature, side effects, and rollback;
7. repeated before/after runs and post-change configuration snapshot.

Chapter 43 owns statistical comparison and benchmark hygiene. This chapter's
rule is operational: a knob without mechanism evidence and rollback is not
ready for production.

### Jitter source map

```
firmware/SMI ─┐
IRQ/softirq ──┼─> removes CPU from application
scheduler ────┘
idle/frequency/thermal ─> changes wake and execution rate
fault/reclaim/THP ──────> blocks on memory-management work
remote device/memory ───> adds interconnect and queue dependencies
cgroup quota ───────────> makes runnable work ineligible
clock/domain error ─────> changes the measurement, not the work
```

The last branch is why clock correctness comes first.

---

## 35.8 Conditional Tuning Matrix — Core

Each entry is a proposal template, not a default.

| Change | Condition / hypothesis | Expected benefit | Cost / risk | Prerequisite and rollback | Success measure |
|---|---|---|---|---|---|
| fixed/high-performance frequency policy | outliers correlate with frequency ramp after idle | remove reactive ramp from critical-core execution | power/heat, lower thermal/turbo headroom, driver-specific behavior | identify `scaling_driver`; save governors/min/max/EPP; restore saved values | outlier mode and frequency transition correlation disappear without thermal throttling |
| turbo enabled or disabled | enabled: single/few-core throughput helps; disabled: power/thermal variability creates modes | workload-dependent execution-rate improvement or stability | disabling can make every request slower; enabling can trigger power/thermal limits | stable cooling and power telemetry; rollback firmware/sysfs policy | better latency distribution at equal throughput with no new throttling |
| limit deep idle states / PM QoS | first work after idle correlates with deep-state residency | reduce wake-up path and cold-state contribution | idle power, heat, carbon, possible lower turbo headroom | observe residency; apply per critical CPU/process when possible; restore state/QoS | idle-correlated mode shrinks and power/temperature remain acceptable |
| move IRQ or queue affinity | application is preempted by unrelated IRQ, or data crosses an avoidable CPU/socket boundary | remove interference or improve handoff locality | moving IRQ away can add cache/inter-core handoff; wrong mask loses throughput | map IRQ→queue→device NUMA; save masks; stop/constrain irqbalance; restore | per-CPU IRQ counts and latency/drop distribution match hypothesis |
| isolate critical CPU / offload housekeeping | traces show migrations, tick, RCU, workqueue, or unrelated tasks | reduce runnable and kernel-work interference | stranded capacity, operational complexity, runaway task risk | Chapter 31 design; watchdog/housekeeping CPUs; rollback boot/cpuset config | zero unexpected tasks/migrations and reduced correlated outliers |
| real-time scheduling or PREEMPT_RT | blocked/wakeup deadline is harmed by kernel/scheduler preemption | tighter scheduling/wakeup upper tail | starvation, throughput/mean cost, priority design burden | privileges, lock/priority audit, watchdog; restore policy/kernel | deadline misses improve under adversarial load without starvation |
| THP policy change | traces/vmstat link outliers to compaction/collapse/fault behavior | remove synchronous or background VM interference | more TLB misses or memory waste under another policy | Chapter 32 page plan; prefer per-mapping `madvise` experiment; rollback mode | compaction/fault signature disappears and end-to-end distribution improves |
| cgroup quota/cpuset change | `cpu.stat` shows throttling or tasks escape intended CPUs | keep critical work eligible and placed | fairness/capacity isolation changes | capacity owner approval; save unit/cgroup config; restore | `nr_throttled`/throttled time stop growing and latency improves |
| workqueue/softirq placement | per-CPU softirq/workqueue activity aligns with stalls | move unrelated deferred work off critical CPU | remote processing and backlog may worsen packet latency | understand queue ownership; save masks; rollback | trace/counts move as expected with no drops/backlog regression |
| PCIe/device-local placement | device, memory, IRQ, and consumer span topology unnecessarily | reduce remote interconnect transfers | may concentrate load; NUMA placement constraints | map root complex and NUMA node; rollback affinity/memory policy | topology counters and application distribution improve |

Do not stack ten changes and compare only the final maximum. Interactions matter:
restricting idle states increases heat; heat may reduce turbo; moving a NIC IRQ
off the application CPU avoids preemption but adds a handoff; full CPU isolation
can hide capacity problems.

---

## 35.9 Host Inventory and Safe Mutation — Runbook

This read-only snapshot is intentionally compact:

```bash
uname -a
cat /proc/cmdline
lscpu
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
grep -H . /sys/devices/system/cpu/cpufreq/policy*/scaling_driver 2>/dev/null
grep -H . /sys/devices/system/cpu/cpufreq/policy*/scaling_governor 2>/dev/null
cat /sys/devices/system/cpu/nohz_full 2>/dev/null
cat /sys/devices/system/cpu/isolated 2>/dev/null
grep -E 'NET_RX|TIMER|RCU|SCHED' /proc/softirqs
cat /proc/interrupts
grep -E 'compact|thp|pgfault|pgmajfault' /proc/vmstat
```

**[Linux/Vendor]** Paths and available files depend on kernel configuration,
CPU-frequency driver, and device driver. Preserve raw snapshots in the
experiment artifact.

For any procfs/sysfs/sysctl write:

1. read and save the current value;
2. identify scope (CPU, policy, IRQ, device, namespace, or system);
3. apply during a maintenance-controlled experiment;
4. read it back;
5. run the workload and side-effect monitors;
6. restore the saved value, then verify restoration;
7. encode an approved persistent setting only after the experiment.

A write returning success can still be overridden later by irqbalance, a power
daemon, systemd, firmware, hotplug, container orchestration, or driver reset.

The interfaces have different persistence and scope:

- `/proc/sys/...` and `sysctl` expose many kernel runtime parameters. A file in
  `/etc/sysctl.d` persists selected values, but ordering with distribution and
  orchestration policy must be audited.
- sysfs usually exposes device/driver/kernel-object state. Paths can disappear
  on hotplug or change across drivers and kernels; persistence needs a
  device-aware service, not an unconditional boot-time echo.
- `/proc/PID/...` describes a task and may vanish/reuse its numeric PID.
- kernel command-line options require reboot and change the qualification
  artifact; save the prior boot entry and retain a bootable rollback.

Use `sysctl -n key` to capture and `sysctl -w key=value` to test only a
documented key on the installed kernel. Generic “low-latency sysctl” bundles
often mix scheduler, VM, network, security, and obsolete knobs. A setting whose
current value and consuming subsystem you cannot name should not enter the
experiment.

### Affinity inspection and a reversible example

```bash
taskset -pc PID
grep -i 'eth0' /proc/interrupts
cat /proc/irq/IRQ/smp_affinity_list

# privileged experiment after saving the old value:
printf '%s\n' 'HOUSEKEEPING_CPU_LIST' > /proc/irq/IRQ/smp_affinity_list
cat /proc/irq/IRQ/smp_affinity_list
```

`IRQ` and CPU lists are placeholders, not copy-paste values. MSI-X queues have
separate vectors. Some managed IRQs reject or constrain affinity. The correct
CPU can be an application CPU (fewer handoffs) or housekeeping CPU (less
preemption); Chapter 46 supplies the packet-path decision.

### Frequency, turbo, C-states, and P-states

A **P-state** controls performance while running; a **C-state** describes idle
depth. Modern firmware/hardware-controlled performance means a governor name
does not uniquely determine actual frequency. Turbo availability depends on
active cores, workload instruction mix, temperature, electrical limits, and
firmware.

Read driver-specific state and observe behavior with supported tools such as
`turbostat`, `cpupower frequency-info`, or vendor telemetry. Report tool/version
and do not interpret an instantaneous “MHz” field as a complete frequency
history. If using `/dev/cpu_dma_latency` PM QoS, its request lasts only while the
file descriptor remains open; verify residency rather than assuming it worked.

### IRQs, softirqs, and workqueues

Hard IRQs, threaded IRQs, softirqs, NAPI processing, and `ksoftirqd` placement
depend on driver/kernel/load. `/proc/interrupts` and `/proc/softirqs` provide
counts, not duration or causality. A busy `ksoftirqd/N` suggests deferred work
on CPU N but does not by itself prove the source or application impact. Trace
before moving it.

Unbound workqueues expose cpumasks on supported kernels; bound workqueues follow
their worker placement. Changing a global mask can affect storage, networking,
and housekeeping across the host. Treat it as a system-level change with an
owner and rollback.

---

## 35.10 Isolation, Real-Time, and Wake-Up Tests — Role-specific

### Kernel command-line and cpuset isolation

`isolcpus`, `nohz_full`, `rcu_nocbs`, default IRQ affinity, managed IRQs,
workqueue masks, SMT siblings, and cgroup cpusets solve different interference
paths. Semantics and interactions are kernel-version/configuration dependent.
`nohz_full` reduces scheduling ticks only when its conditions are met; it does
not ban all interrupts or kernel work. `isolcpus` is not a security boundary and
does not replace explicit affinity.

Prefer a documented CPU partition:

```
housekeeping CPUs: daemons, timers, unbound work, management, selected IRQs
critical CPUs:     pinned application threads and only intentional device work
```

Verify after boot and under load: effective cpusets, thread affinities,
migrations, IRQ counts, scheduler ticks, RCU callbacks, workqueue activity, and
SMT sibling workload. A CPU list printed by sysfs is evidence of configuration,
not proof of zero interference.

### PREEMPT_RT

**[Linux, version-gated]** Mainline PREEMPT_RT integration reached a major
milestone in Linux 6.12, but availability and coverage still depend on
architecture, kernel config, distribution patches, and drivers. RT changes
preemption/locking and typically threads more interrupt work so priorities can
control it. It can improve worst-case wake-up behavior while adding overhead or
reducing throughput.

Do not claim regulatory compliance or a universal bound from the kernel name.
Test the exact image, firmware, drivers, priorities, CPU partition, and
adversarial load. A `SCHED_FIFO` thread can starve lower-priority work; removing
RT runtime safeguards or locking memory requires a watchdog, recovery channel,
and resource limits designed in Chapter 31/32.

### `cyclictest`

`cyclictest` measures scheduled timer wake-up latency, not application
packet-to-decision latency and not a permanently running busy-poll loop. Use it
to qualify a kernel/host path under representative interference.

Tool options change; inspect `cyclictest --help` for the installed rt-tests
version. A typical experiment pins threads, uses absolute periodic wakeups,
locks memory when permitted, records a histogram, runs long enough to encounter
maintenance activity, and applies controlled CPU/memory/network load. Store:

- exact command and rt-tests version;
- CPU and scheduling policy;
- histogram/sample count, not only “Max”;
- missed/overrun information;
- concurrent temperature, frequency, IRQ, fault, and throttle evidence.

Compare stock and candidate kernels/configurations with identical workloads.
If application outliers remain but cyclictest does not move, investigate a path
cyclictest does not exercise: device, queue, cache/memory, clock domain, or
application work.

Interpret correlation, not folklore:

| Histogram/trace observation | Next evidence | What it does not prove |
|---|---|---|
| mode appears after long idle | C-state residency, frequency, thermal, first-touch | that one particular C-state has a fixed exit time |
| periodic mode | timer/RCU/workqueue/daemon trace and period | that scheduler tick is the cause |
| load-dependent long tail | run queue, IRQ/softirq, lock/contention, throttling | that PREEMPT_RT will fix the application |
| all CPUs stall together | firmware/SMI or shared hardware evidence | that the kernel scheduled a task |
| only application moves, not cyclictest | device/application/clock path | that the host is “fully tuned” |

Run a control without `--mlockall` or RT priority only when that comparison is
part of the question; otherwise option changes confound kernel comparison.
Memory locking can fail because of limits, and requested RT priority can be
denied. Verify effective policy, affinity, and page-fault counts rather than
trusting the command line.

---

## 35.11 VM, cgroups, and Namespaces — Role-specific

### Transparent huge pages

**[Linux]** THP can reduce TLB pressure, but allocation, compaction, collapse,
split, and shootdown behavior can introduce work at inconvenient times. The
right policy is workload and kernel dependent:

- If outliers align with compaction/collapse/fault evidence, compare `madvise`
  policy, `MADV_NOHUGEPAGE` for the critical mapping, prefaulted explicit huge
  pages, or ordinary pages.
- If the working set is TLB-bound, disabling THP globally may make steady-state
  latency worse.
- Roll back the policy and compare faults, compaction, CPU, RSS, TLB counters,
  and end-to-end distributions.

Chapter 32 owns allocation, page locking, prefaulting, and huge-page mechanics.
This chapter's rule is to correlate VM evidence before prescribing a page size.

### cgroups and namespaces

**[Linux]** In cgroup v2, finite `cpu.max` quota can throttle a cgroup even when
the host has idle CPUs elsewhere; inspect `cpu.stat`. `cpuset.cpus.effective`
shows effective placement after hierarchy constraints. Memory controls can
introduce reclaim or throttling. Save the full ancestor hierarchy because a
parent, systemd unit, or orchestrator may impose the real limit.

Namespaces mainly change visibility and resource/data paths. A network
namespace often accompanies veth/bridge processing, but the namespace itself is
not a universal fixed latency tax; Chapter 46 owns that packet path. Compare
host networking, veth, SR-IOV, or bypass only with equivalent isolation,
security, observability, and failure handling.

---

## 35.12 Tracing and Device Topology — Reference Runbook

### eBPF, ftrace, and bpftrace

Tracing must answer a narrow question:

- Who ran on the critical CPU during an outlier?
- How long was the thread runnable but not running?
- Which IRQ/softirq/workqueue executed?
- Did reclaim, compaction, or a page fault occur?

Tracepoints are stable kernel event interfaces relative to ad-hoc probes;
kprobes/uprobes and function tracing are more version/build sensitive. eBPF can
filter and aggregate in-kernel, but it is not zero overhead. Maps, stacks,
uprobes, high event rate, and symbolization can perturb the workload. Measure a
tracing-off control and cap output.

Read-only discovery:

```bash
trace-cmd list -e | grep -E 'sched|irq|timer|power'
bpftrace -l 'tracepoint:sched:*'
cat /sys/kernel/tracing/available_tracers 2>/dev/null
```

A short, scoped scheduling trace:

```bash
sudo trace-cmd record -e sched:sched_switch -e sched:sched_wakeup \
    -e irq:irq_handler_entry -e irq:irq_handler_exit \
    -- taskset -c CPU ./workload
```

Validate event names and permissions on the installed kernel. Flight-recorder
design and production observability belong to Chapter 59; native debugging is
Chapter 58.

### PCIe topology for device locality

A PCIe device attaches beneath a root complex associated with a platform
topology. **[Linux/Vendor]** Sysfs may expose a NUMA node and local CPU list:

```bash
ethtool -i eth0
readlink -f /sys/class/net/eth0/device
cat /sys/class/net/eth0/device/numa_node
cat /sys/class/net/eth0/device/local_cpulist
lspci -tv
```

`numa_node == -1` means Linux has no node association, not “node zero.” Map
device queue, IRQ, consumer CPU, memory allocation, and SMT/cache topology
together. A remote placement can add interconnect transactions; a local
placement can also overload one socket. PCIe link state, ASPM, IOMMU mode, DMA
placement, and NIC cache behavior are platform/vendor facts. Do not disable
ASPM or IOMMU globally without measuring the implicated transition and accepting
power/security/isolation costs.

---

## 35.13 Worked Diagnosis: A Negative One-Way Latency — Core

Host A records `send = 12:00:00.000001200` using `CLOCK_REALTIME` immediately
before `sendto`. Host B records `receive = 12:00:00.000000900` from a NIC hardware
RX timestamp. The dashboard reports `-300 ns`.

**Wrong conclusion:** the clocks differ by 300 ns, so add 300 ns to host B.

**Step 1: reject the subtraction.** The A timestamp is a system-clock software
capture before a syscall. The B timestamp is in the NIC/PHC hardware domain at a
wire-adjacent point. Their values are not directly comparable.

**Step 2: enumerate terms.**

```
reported = network propagation/queueing
         + sender software-to-wire delay
         + receiver wire-to-hardware-capture delay
         + PHC_B - system_clock_A offset
         + synchronization and conversion error
```

A negative result can arise from clock offset, wrong PHC-to-system conversion,
different PTP domain/profile, a step during sampling, timestamp association with
the wrong packet, or capture-point mismatch. It does not identify one cause.

**Step 3: collect evidence.**

- record clock IDs, host/NIC identity, sequence number, and capture point;
- inspect grandmaster identity, port states, time properties, daemon logs, and
  last update age on both hosts;
- sample PHC↔system offsets using the supported cross-timestamp facility;
- confirm hardware timestamp capability/configuration and packet association;
- check for wall-clock steps and holdover;
- compare a round-trip or same-clock interval that does not need cross-host
  synchronization.

**Step 4: repair the design.** For wire-to-wire one-way latency, capture TX and
RX in hardware domains disciplined to the same PTP timescale and propagate
uncertainty. For application processing, use the same host monotonic clock at
entry and exit. Keep both metrics; they answer different questions. Use packet
sequence for order.

**Step 5: define acceptance.** A corrected dashboard rejects mixed domains,
shows synchronization health and uncertainty beside one-way values, and alarms
on domain/status changes. It never “fixes” negative samples with an unexplained
constant.

---

## 35.14 Worked Tuning Diagnosis: A Periodic Tail — Core

A pinned decision thread shows a narrow normal distribution plus a cluster of
outliers at an apparently regular interval. CPU utilization is low. The first
proposal is to disable deep C-states.

**1. Validate the measurement.** Entry and exit use the same
`CLOCK_MONOTONIC` domain on one host. Sequence-correlated packet captures show
that delay occurs after application entry, so this is not PTP offset or wire
capture placement. Sample count and traffic rate are stable.

**2. Test the idle hypothesis.** Partition samples by preceding idle duration
and record C-state residency/frequency. The outliers do not correlate with idle;
disabling a deep state in a short A/B run changes power but not the cluster.
Restore the saved state. The proposed cause is rejected.

**3. Align other evidence.** `/proc/interrupts` deltas show no matching hard IRQ.
A scoped scheduling/IRQ trace reveals an unbound maintenance worker on the
critical CPU at the same interval. The effective cpuset includes the critical
CPU because a parent systemd slice broadened it during deployment; the intended
partition existed only in a child unit.

**4. Make one change.** Fix the effective cpuset hierarchy and assign the worker
to housekeeping CPUs. Do not add `isolcpus`, alter turbo, or move the NIC IRQ:
the trace supplies no hypothesis for those changes. Save both old unit
properties and a rollback command; keep a housekeeping watchdog.

**5. Verify under matched load.** Confirm effective cpusets after daemon restart,
observe the worker on housekeeping CPUs, repeat the same traffic duration and
sample count, and compare the full latency distribution. Also compare
housekeeping utilization, maintenance completion time, packet drops, and
thermal state.

If the periodic cluster disappears but maintenance misses its own deadline, the
change moved rather than solved capacity contention. Add housekeeping capacity
or reschedule the work. The outcome is a causal explanation—“this worker ran
here”—not a box labelled “tuned.”

---

## 35.15 The Obvious Optimization Is Wrong — Core

A team disables turbo and every deep C-state on all CPUs, boots with broad CPU
isolation, moves all NIC IRQs to one housekeeping CPU, and sees worse tail
latency under the real multi-feed load.

Reason from mechanisms:

1. Disabling turbo reduced single-thread service rate, lengthening queues during
   bursts.
2. Polling/idle restrictions raised package power and temperature, reducing
   sustainable frequency.
3. One housekeeping CPU became an IRQ/softirq bottleneck and dropped behind.
4. Broad isolation stranded capacity needed by noncritical parsers and logging.
5. Because all knobs changed together, the experiment cannot attribute the
   regression.

The rollback is the saved baseline, not another guessed tuning bundle. Restore,
then test one hypothesis at a time: IRQ distribution under burst; critical-core
idle mode only; turbo policy at matched thermal state; CPU partition at measured
capacity. Low latency comes from removing the current bottleneck, not maximizing
the number of disabled features.

---

## 35.16 Common Traps — Core

- Subtracting `CLOCK_REALTIME` values for elapsed time or subtracting a PHC
  timestamp from a system timestamp without a conversion epoch.
- Treating `clock_getres` as accuracy, read cost, or timer wake-up precision.
- Calling TSC “invariant” without checking rate, continuity, synchronization,
  virtualization, migration, and ordering separately.
- Assuming `RDTSCP` is fully serializing or that its completion means prior
  stores reached another core/device.
- Starting PTP daemons but failing to verify which clock is disciplined, which
  grandmaster/profile/domain is selected, and whether application capture uses
  that clock.
- Comparing a tuned run with lower throughput, fewer samples, different
  temperature, or different traffic and attributing the distribution change to
  the knob.
- Applying isolation, turbo, governor, idle, IRQ, THP, or RT settings as a
  bundle; silent no-ops and interactions then make the result unauditable.
- Trusting configured affinity instead of effective cpusets, post-hotplug IRQ
  masks, actual interrupt counts, migrations, and traces.
- Calling a host “deterministic” because an idle `cyclictest` run had a small
  maximum. Firmware, device, load, and maintenance paths remain.

---

## Recall Card — Core

- Use monotonic clocks for intervals; attach domain, host/device, capture point,
  and uncertainty to timestamps that cross boundaries.
- Clocksource, clock ID, vDSO path, PHC, and synchronization daemon are separate
  layers.
- TSC rate invariance, nonstop behavior, cross-CPU synchronization, and read
  ordering must each be validated.
- `RDTSCP` orders after prior execution/loads but needs a trailing barrier
  against later work; prior-store visibility is a separate requirement.
- Absolute periodic deadlines prevent accumulated drift; timer resolution does
  not guarantee wake-up latency.
- NTP/PTP offset estimates contain path-asymmetry error. Hardware timestamping
  improves capture placement but does not erase uncertainty.
- Every tuning change needs condition, benefit, cost, prerequisite, rollback,
  verification, and a before/after distribution.
- Turbo, C-states, IRQ placement, isolation, THP, PREEMPT_RT, and cgroup policy
  are conditional workload choices, never universal settings.

## Questions — Core

1. Why can `CLOCK_MONOTONIC` be rate-disciplined and still satisfy monotonic
   semantics? When would `CLOCK_MONOTONIC_RAW` be appropriate?
2. A `clock_gettime` benchmark changes after reboot. Which evidence separates a
   clocksource change, loss of vDSO use, CPU migration, and benchmark noise?
3. Distinguish `constant_tsc`, `nonstop_tsc`, synchronized TSC offsets, and
   instruction serialization. Which failure can produce a negative handoff?
4. Why is `RDTSCP; LFENCE` an incomplete claim if the measured event requires
   prior stores to be visible to another core or device?
5. Derive the NTP offset formula's sensitivity to forward/reverse path
   asymmetry. Which part can hardware timestamping remove?
6. `ptp4l` reports a healthy port, but application wall timestamps drift. What
   clocks and synchronization links do you inspect before changing the servo?
7. Design a periodic loop that reacts sensibly after missing three deadlines:
   catch up, skip, or fail. Which choice fits a market heartbeat?
8. An outlier mode appears only after idle. How would you distinguish C-state
   exit, frequency ramp, page fault, IRQ interference, and clock-domain error?
9. When can moving a NIC IRQ onto the application CPU improve latency, and when
   can moving it to a housekeeping CPU improve latency?
10. Why can disabling THP, turbo, SMT, and deep idle states together produce a
    persuasive but useless benchmark result?

## Applied Exercise — Core

Build a two-part qualification artifact:

1. A C++23 program that records paired `CLOCK_MONOTONIC`,
   `CLOCK_MONOTONIC_RAW`, and `CLOCK_REALTIME` samples; prints clock resolution;
   runs an absolute-deadline loop; detects late/missed periods; and stores clock
   IDs with values. Add a deliberately invalid cross-domain subtraction test
   that your timestamp type rejects.
2. A Linux host experiment for one observed jitter mode. Capture the inventory
   in §35.9, a before histogram, mechanism evidence, one reversible change, an
   after histogram, side effects (throughput, CPU, power/temperature, drops),
   and proof of rollback. State architecture/Linux/vendor/measured claims
   separately.

Puzzle: the after-run maximum is lower, but the p99.99 is higher and sample
count is half because throughput fell. Decide whether the change succeeded and
what matched-workload rerun is required.

Compile the program with strict warnings on the target Linux toolchains. Validate
shell syntax, tool versions, permissions, paths, and event names on the exact
host; commands in this chapter are templates, not a distribution-independent
installer.

## Prerequisites for Chapter 36 — Core

Chapter 36 assumes only that you can distinguish a packet's capture point and
clock domain from its transport semantics. Review Chapter 34 for syscall/I/O
crossings and Chapter 31 for affinity when those mechanisms appear in a
networking diagnosis. Ethernet framing, MTU, routing, and packet-rate arithmetic
begin in Chapter 36.
