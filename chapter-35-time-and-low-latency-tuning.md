# Chapter 35 — Time and Low-Latency Tuning

*Interview-focused revision notes. The theme: a low-latency box is not fast by default — it is fast because every source of jitter between the packet and your code has been individually identified and disabled, and because you can prove which clock you are measuring with.*

---

## 35.1 Linux Clock Sources

A **clocksource** is a monotonically increasing hardware counter the kernel reads to advance its notion of time. The kernel selects one at boot, ranked by a quality score, and every `clock_gettime` ultimately derives from it.

```
$ cat /sys/devices/system/clocksource/clocksource0/available_clocksource
tsc hpet acpi_pm
$ cat /sys/devices/system/clocksource/clocksource0/current_clocksource
tsc
$ echo hpet > /sys/devices/system/clocksource/clocksource0/current_clocksource   # switch at runtime
```

| Clocksource | Access | Read cost | Resolution | Notes |
|---|---|---|---|---|
| **`tsc`** | `rdtsc` instruction, **core-local register** | **~5–8 ns** (15–25 cycles) | Sub-ns | The only one usable from the vDSO. Quality 300. |
| `hpet` | MMIO, shared platform device | **~250 ns–1 µs** | 10–100 ns (typically 14.318 MHz) | Uncached MMIO read; **serializes across all cores** contending for it |
| `acpi_pm` | Port I/O to the PM timer | **~800 ns–2 µs** | 3.579545 MHz, 24-bit (wraps ~4.7 s) | Last resort |
| `kvm-clock` / `xen` | Paravirtual shared page | ~20–40 ns | ns | The VM equivalent of TSC; still cheaper than trapping |
| `arch_sys_counter` | ARM `CNTVCT_EL0` | ~10–20 ns | Typically 24–100 MHz | The ARM64 equivalent of TSC |

**The decisive property is that only `tsc` can be read from user space**, which is what makes the vDSO fast path possible (Ch. 34 §34.4). If the kernel demotes the clocksource, `clock_gettime` stops being a ~20 ns user-space computation and becomes a ~250 ns syscall reading a *single shared MMIO register* — so under multi-threaded load the HPET also becomes a contention point, and timestamping cost can rise by more than an order of magnitude with a superlinear component. **A demotion from `tsc` to `hpet` is one of the most recognizable production latency incidents in this area**, and the first diagnostic anyone should run is the `current_clocksource` cat above.

**Why the kernel demotes.** A watchdog (`clocksource_watchdog`) periodically cross-checks the TSC against a known-reliable reference (HPET or `acpi_pm`). If the TSC drifts beyond a tolerance, the kernel logs:

```
clocksource: timekeeping watchdog on CPU3: Marking clocksource 'tsc' as unstable because
             the skew is too large:
clocksource: 'hpet' wd_nsec: 499999999 ...
clocksource: Switched to clocksource hpet
```

Real causes: SMIs (System Management Interrupts) stealing time invisibly, deep C-state exit latency perturbing the measurement, a genuinely non-invariant TSC on old hardware, VM migration, or a buggy BIOS. Mitigations: `tsc=reliable` or `tsc=nowatchdog` to disable the cross-check (defensible on validated hardware — and dangerous if the TSC is *actually* unstable, since it silently corrupts all timestamps), and `nohpet`/`hpet=disable` to remove the fallback. Always confirm invariance first (§35.3). Since Linux 6.x the watchdog is skipped automatically on parts advertising `TSC_ADJUST` plus a locked, verified TSC.

**The interview framing:** "your `clock_gettime` calls got 10× slower overnight and nothing was deployed" — the answer is a clocksource demotion, visible in `dmesg` and in `/sys`, and traceable to an SMI storm or a C-state configuration change.

---

## 35.2 Monotonic, Realtime, and Raw Clocks

Linux exposes several distinct clock IDs to `clock_gettime`, and choosing wrongly is a correctness bug, not a style issue.

| Clock ID | Steps? | Slews (NTP)? | Counts suspend? | Use for |
|---|---|---|---|---|
| `CLOCK_REALTIME` | **Yes** — `settimeofday`, NTP steps, leap seconds | Yes | Yes | Wall-clock timestamps, log lines, exchange session times |
| `CLOCK_MONOTONIC` | **Never** | **Yes** — rate is disciplined by NTP | No | **Timeouts, intervals, elapsed time — the default** |
| `CLOCK_MONOTONIC_RAW` | Never | **No** — raw hardware rate, undisciplined | No | Measuring the oscillator itself; TSC calibration |
| `CLOCK_BOOTTIME` | Never | Yes | **Yes** | Uptime-relative deadlines across suspend |
| `CLOCK_*_COARSE` | as base | as base | as base | ~1–4 ms granularity (one `jiffy`), **~5 ns** read — logging |
| `CLOCK_PROCESS/THREAD_CPUTIME_ID` | — | — | — | CPU time consumed; **syscall, ~1 µs** |
| `CLOCK_TAI` | Never (no leap seconds) | Yes | Yes | Realtime + 37 s offset; the correct clock for PTP-aligned systems |

**The core rule: never measure a duration with `CLOCK_REALTIME`.** An NTP step during your measurement can make elapsed time negative or hours long. This is a real bug in production code, it is trivially avoidable, and interviewers ask it because it separates people who have debugged a "negative latency" alert from those who have not.

```cpp
// WRONG — a realtime step corrupts the measurement
auto t0 = std::chrono::system_clock::now();  ...  auto dt = system_clock::now() - t0;

// RIGHT
auto t0 = std::chrono::steady_clock::now();  ...  auto dt = steady_clock::now() - t0;
```

**C++ mapping** (Ch. 15 §15.11): `std::chrono::system_clock` → `CLOCK_REALTIME`; `std::chrono::steady_clock` → `CLOCK_MONOTONIC`; `high_resolution_clock` is an **alias for one of the two, implementation-defined** — libstdc++ aliases it to `system_clock`, which means the badly-named "high resolution" clock is the one that steps. Never use `high_resolution_clock`. C++20 adds `utc_clock`, `tai_clock`, `gps_clock`, and `file_clock` with defined conversions, which is the correct way to handle leap seconds in a standards-conformant way.

**MONOTONIC vs MONOTONIC_RAW.** `CLOCK_MONOTONIC` is NTP-disciplined: its *rate* is continuously adjusted (slewed) so it tracks true elapsed SI seconds. `CLOCK_MONOTONIC_RAW` reports the raw counter with no frequency correction, so it drifts against real time by the oscillator's error (typically 10–100 ppm — up to ~8 seconds per day at 100 ppm). Use `MONOTONIC` for anything measured in seconds; use `MONOTONIC_RAW` only when you are characterizing the oscillator, e.g. calibrating a TSC frequency (Ch. 43 §43.13), where NTP's adjustments would contaminate the measurement.

**`CLOCK_TAI` and leap seconds.** TAI has no leap seconds and advances uniformly; UTC inserts them. PTP grandmasters distribute TAI plus the current offset (37 s as of 2026), so a PTP-synchronized system should timestamp in TAI and convert for display. Systems that timestamp in UTC across a leap second produce duplicate or non-monotonic timestamps — a genuine problem for exchange sequencing, and the reason the industry has pushed to abolish leap seconds by 2035.

---

## 35.3 TSC Synchronization and Monotonicity

The **Time Stamp Counter** is a per-core 64-bit counter readable in one instruction. It is the foundation of all low-latency timing, and its three historical hazards are exactly what the CPU flags describe.

**The three generations:**

1. **Original TSC** — counts *core clock cycles*. Frequency changes with P-states, so the counter's meaning changes when the CPU throttles or turbos. Useless as a clock.
2. **`constant_tsc`** — the counter runs at a fixed rate (the CPU's nominal/base frequency) regardless of the current P-state. Fixes frequency scaling.
3. **`nonstop_tsc`** (a.k.a. *invariant TSC*, `CPUID.80000007H:EDX[8]`) — additionally keeps counting through C-states, including deep package C-states, and across cores. **This is the property you require.**

```bash
$ grep -o 'constant_tsc\|nonstop_tsc\|tsc_reliable\|rdtscp\|tsc_adjust' /proc/cpuinfo | sort -u
constant_tsc
nonstop_tsc
rdtscp
tsc_adjust
```

**Cross-core synchronization.** Each core has its own TSC register. At reset they start together, but they can diverge: BIOS may write different values via `IA32_TIME_STAMP_COUNTER`, a socket may be powered down and resume, or (on multi-socket systems) the sockets may not be reset simultaneously. Linux measures cross-core skew at boot (`tsc: Marking TSC unstable due to check_tsc_sync_source failed`) and modern CPUs expose `IA32_TSC_ADJUST` (the `tsc_adjust` flag), which lets the kernel correct a per-core offset without disturbing the raw counter — a substantial reliability improvement.

**Practical consequences of skew.** If thread A on core 0 timestamps a message and thread B on core 8 timestamps its handoff, a few hundred nanoseconds of TSC offset makes the measured latency wrong — potentially **negative**. Within one socket, modern Intel and AMD parts are typically synchronized to within tens of nanoseconds; **across sockets, skew of 100 ns to microseconds is realistic**, and it is why cross-socket latency measurements are untrustworthy without either an explicit per-core offset calibration or pinning both endpoints to the same socket. Reporting a negative one-way latency is the diagnostic signature.

**Ordering: `rdtsc` vs `rdtscp` vs fences.** `rdtsc` is not a serializing instruction, so out-of-order execution can hoist it above or sink it below the code you are timing — producing measurements that are systematically too small.

```cpp
// Measurement discipline
static inline uint64_t tsc_begin() {                 // prevent LATER work from moving earlier
    _mm_lfence();                                    // and prior loads from moving later
    uint64_t t = __rdtsc();
    _mm_lfence();
    return t;
}
static inline uint64_t tsc_end() {
    unsigned aux;
    uint64_t t = __rdtscp(&aux);   // waits for all PRIOR instructions to retire; aux = CPU id
    _mm_lfence();                  // still needed: rdtscp does not stop LATER instructions
    return t;
}
```

`rdtscp` additionally returns `IA32_TSC_AUX`, which Linux populates with the CPU and NUMA node number — so you get "which core produced this timestamp" for free, and can detect that your thread migrated mid-measurement. Costs: `rdtsc` ~15–25 cycles, `rdtscp` ~25–35, `lfence` adds a few cycles plus the pipeline-drain cost, which for a short measured region can be a significant fraction of what you are measuring (Ch. 43 §43.12).

**Converting cycles to nanoseconds.** The TSC frequency is *not* the current core frequency; it is the invariant base rate. Read it from `dmesg | grep "tsc: Detected"` (`tsc: Detected 2999.999 MHz processor`), from `CPUID` leaf 0x15/0x16 on modern Intel, or calibrate against `CLOCK_MONOTONIC_RAW` over ~100 ms. Then convert with a precomputed multiply-and-shift rather than a floating-point divide (Ch. 43 §43.13).

**In virtual machines**, `rdtsc` may be configured to trap to the hypervisor (~1–3 µs), or be offset/scaled per-VM. `kvm-clock` exists because of this. Live migration can step the TSC. Never assume raw TSC semantics in a VM; check `/sys/hypervisor` and the `hypervisor` CPUID flag.

---

## 35.4 Timer Facilities

Linux offers several timer APIs over one underlying mechanism.

| API | Delivery | Pollable | Clock choice | Notes |
|---|---|---|---|---|
| `sleep`/`usleep`/`nanosleep` | Return from the call | No | MONOTONIC | Relative; **restarts short on `EINTR`** with a remaining-time argument |
| `clock_nanosleep(clk, TIMER_ABSTIME, …)` | Return | No | Any | **The correct sleep**: absolute deadline, no drift, no `EINTR` recomputation |
| `alarm` / `setitimer` | `SIGALRM`/`SIGVTALRM`/`SIGPROF` | No | — | One timer of each type per process; obsolete |
| `timer_create` (POSIX) | Signal or a spawned thread | No | Any | Many timers; `SIGEV_THREAD` spawns a thread **per expiry** — expensive |
| **`timerfd_create`** | fd becomes readable | **Yes** | Any | The event-loop timer (Ch. 33 §33.10) |
| `epoll_pwait2` / `ppoll` timeout | Return value | n/a | MONOTONIC | ns granularity (`epoll_wait` alone is ms) |
| `io_uring` `IORING_OP_TIMEOUT` | CQE | via ring | MONOTONIC/BOOTTIME | Timers as ordinary completions; linkable to other SQEs |

**The hrtimer subsystem** underlies all of them. Timers live in a per-CPU red-black tree ordered by expiry; the earliest expiry is programmed into the **local APIC timer in TSC-deadline mode** (a single `wrmsr` to `IA32_TSC_DEADLINE`, which fires an interrupt when the TSC reaches that value — no divider, no periodic tick). On expiry, the interrupt handler runs the callback in hard-IRQ context or defers it to a softirq (§35.15).

**Achieved resolution and jitter (typical modern x86-64 Linux server):**

| Condition | Wakeup jitter above the requested deadline |
|---|---|
| Untuned server, loaded, deep C-states enabled | **50–500 µs**, with multi-ms outliers |
| Untuned server, idle | 20–100 µs |
| `SCHED_FIFO` thread, isolated core, C-states ≤ C1 | **2–20 µs** |
| PREEMPT_RT, fully tuned (§35.17) | **1–10 µs**, tight distribution |
| Busy-wait on `rdtsc` | **< 100 ns** |

The floor for any *sleep-based* timer is set by the interrupt delivery path plus the scheduler wakeup: roughly **10 µs** even when everything is right. Below that you must busy-wait:

```cpp
// Sub-microsecond wait: spin on TSC. Costs a core; gives ~50 ns accuracy.
void spin_until(uint64_t deadline_tsc) {
    while (__rdtsc() < deadline_tsc) _mm_pause();   // PAUSE: yields SMT sibling, saves power
}
// Hybrid: sleep until ~50 µs before, then spin. Bounded CPU burn, ns accuracy.
```

**The `nanosleep` drift trap.** A loop of `nanosleep(1ms)` does not fire at 1 kHz: each iteration sleeps *at least* 1 ms plus the wakeup latency plus the work, so the period is 1 ms + jitter and errors accumulate without bound. `clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next)` with `next += period` computed from the *scheduled* time, not the actual wake time, is drift-free — the same absolute-deadline principle as `TFD_TIMER_ABSTIME` (Ch. 33 §33.10). This is the standard cyclic-task skeleton and the one `cyclictest` implements.

**`timer_slack`.** Linux coalesces timer expiries within a per-task slack window (default **50 µs**, `PR_SET_TIMERSLACK`, or `/proc/PID/timerslack_ns`) to batch wakeups and save power. `SCHED_FIFO`/`SCHED_RR` tasks get zero slack automatically. On a latency-critical `SCHED_OTHER` thread, that default 50 µs is a silent, invisible addition to every timeout — set it to 0 explicitly or use a real-time policy.

---

## 35.5 Timer Wheels

A **timer wheel** is a hashed, bucketed data structure giving **O(1)** insertion, deletion, and expiry-scan for large numbers of timers, at the cost of resolution — the classic alternative to a heap or a balanced tree.

```
Single wheel: an array of N buckets, each a list of timers, plus a rotating cursor.
    insert(t): bucket = (now + delay) % N        → O(1)
    tick():    cursor = (cursor+1) % N; fire everything in buckets[cursor]   → O(fired)
Limitation: cannot express a delay ≥ N ticks.

Hierarchical (Varghese & Lauck) — the Linux design:
  wheel 0: 256 buckets × 1 tick        → 0..255 ticks
  wheel 1:  64 buckets × 256 ticks     → up to 16K ticks
  wheel 2:  64 buckets × 16K ticks     → ...
  ...
A timer inserted into a higher wheel is CASCADED down into a finer wheel as its
expiry approaches. Insertion O(1); cascading amortizes to O(1) per timer.
```

**Two distinct subsystems in Linux, and the distinction is the point:**

| | **Timer wheel** (`timer_list`, "legacy timers") | **hrtimer** (high-resolution) |
|---|---|---|
| Structure | Hierarchical wheel, jiffy-granular | Per-CPU **red-black tree**, nanosecond-granular |
| Insert cost | **O(1)** | O(log n) |
| Resolution | 1 jiffy = 1–10 ms (`CONFIG_HZ`) | Nanoseconds (APIC TSC-deadline) |
| Accuracy | Deliberately imprecise; expiries are **batched** | Precise |
| Used for | Kernel timeouts that usually never fire (TCP retransmit, keepalive, watchdogs) | `timerfd`, `nanosleep`, `posix-timers`, scheduler bandwidth |

The design rationale is that most kernel timers are **cancelled before they fire** — a TCP retransmission timer is armed for every segment and almost always cancelled by the ACK — so insertion and cancellation cost dominates, and O(1) with poor resolution is exactly the right trade. Timers that must actually fire on time go to the hrtimer tree, which pays O(log n) for precision.

**Application relevance.** A trading system managing 100,000 order-timeout timers faces the same choice. A `std::priority_queue` or `std::map` keyed by deadline gives O(log n) insert and O(log n) cancel (and cancellation in a binary heap is awkward — you either need an index or you tombstone). A timer wheel with 1 ms buckets gives O(1) for both and is trivially cancellable if each timer holds an intrusive list hook (Ch. 21 §21.5): unlinking is O(1) with no search. For timeouts measured in seconds where millisecond precision suffices, the wheel wins decisively, and this is a common systems-design question. The refinement worth naming is the **timing wheel with a "far future" overflow list** for the rare long timer, which avoids unbounded wheel depth.

---

## 35.6 NTP Synchronization

**NTP** (Network Time Protocol) disciplines a machine's `CLOCK_REALTIME` to a set of servers over ordinary UDP port 123, using software timestamps taken in the kernel or the application.

**The measurement.** Four timestamps per exchange — client transmit `T1`, server receive `T2`, server transmit `T3`, client receive `T4`:

```
offset = ((T2 - T1) + (T3 - T4)) / 2        delay = (T4 - T1) - (T3 - T2)
```

The offset formula **assumes the path is symmetric** — that the outbound and return delays are equal. Every error in that assumption translates directly into a clock error of half the asymmetry. Since real networks have asymmetric queueing, and since the timestamps are taken in software subject to interrupt and scheduler jitter, NTP's practical accuracy is:

| Deployment | Typical accuracy |
|---|---|
| Public internet servers | **1–50 ms** |
| Good LAN, local stratum-1 | **100 µs – 1 ms** |
| chrony on a quiet LAN, tuned | **10–100 µs** |
| **PTP with hardware timestamping** | **sub-microsecond, often < 100 ns** (§35.7) |

**Clock discipline.** NTP does not simply write the clock. It runs a control loop (a PLL/FLL) that adjusts the kernel's `tick` and frequency correction via `adjtimex`/`ntp_adjtime`, so `CLOCK_REALTIME` and `CLOCK_MONOTONIC` are *slewed* — their rate is changed slightly until the error is absorbed (§35.9). It only **steps** the clock when the offset exceeds a threshold (128 ms by default for ntpd; `chrony makestep` is configurable, typically allowing steps only during the first few updates after boot).

**chrony vs ntpd**, a fair interview question: chrony converges far faster (seconds vs tens of minutes), handles intermittent connectivity and virtual machines much better, can discipline using a much wider range of correction rates, supports hardware timestamping, and includes `chronyc tracking`/`sources`/`sourcestats` as excellent diagnostics. It is the default on modern distributions and the correct answer unless there is a specific reason otherwise. systemd-timesyncd is an SNTP client only — no discipline loop, no serious accuracy — and should not be used where accuracy matters.

```bash
$ chronyc tracking
Reference ID    : C0A80001 (ptp-gm.internal)
Stratum         : 2
System time     : 0.000002134 seconds fast of NTP time     ← the number that matters
Frequency       : 12.345 ppm slow                          ← your oscillator's error
Skew            : 0.021 ppm                                ← stability of that estimate
Root dispersion : 0.000104 seconds                         ← accumulated uncertainty bound
```

**Why NTP is insufficient for trading.** Regulatory regimes (MiFID II RTS 25, and exchange requirements) demand timestamp accuracy of **100 µs** for HFT relative to UTC, with divergence documented — and 1 ms or 1 s for less latency-sensitive activity. NTP over a general LAN cannot reliably deliver 100 µs, and it certainly cannot deliver the sub-microsecond figures needed to compare timestamps across venues. The industry answer is PTP with hardware timestamping, with NTP retained only as a coarse fallback and sanity check.

---

## 35.7 PTP Synchronization

**PTP** (IEEE 1588, "Precision Time Protocol") achieves sub-microsecond accuracy by doing two things NTP does not: **timestamping in hardware at the PHY**, and **compensating for switch residence time**.

**The message exchange (delay-request mechanism):**

```
GM ──Sync (t1 taken in HW as the frame leaves the PHY)──▶ Slave (t2 in HW on arrival)
GM ──Follow_Up (carries the precise t1)─────────────────▶      (two-step mode; one-step
                                                                embeds t1 in Sync itself)
GM ◀──Delay_Req (t3 in HW on departure)───────────────── Slave
GM ──Delay_Resp (carries t4, HW receive time)───────────▶ Slave

offset = ((t2 - t1) - (t4 - t3)) / 2       mean_path_delay = ((t2 - t1) + (t4 - t3)) / 2
```

Structurally the same algebra as NTP — the accuracy comes entirely from *where* the timestamps are taken and from removing network variability.

**The two mechanisms that make it work:**

1. **Hardware timestamping at the PHY.** The NIC stamps the frame as its start-of-frame delimiter crosses the wire, eliminating driver latency, interrupt latency, softirq scheduling, and every source of software jitter — hundreds of microseconds of noise removed.
2. **Transparent clocks.** A PTP-aware switch measures how long the packet spent inside it and writes that **residence time** into the packet's correction field. The slave subtracts it, so switch queueing — the dominant source of asymmetry and variance — is cancelled. A **boundary clock** instead terminates PTP on each port and re-originates it, isolating each segment.

Without PTP-aware switches, PTP degrades to roughly NTP-class accuracy under load, because switch queueing reintroduces exactly the asymmetry the protocol was designed to remove. "Do you have transparent clocks in the path?" is the right first question when PTP accuracy is disappointing.

**The clock hierarchy** is chosen by the **Best Master Clock Algorithm** (BMCA), which ranks candidates by priority1, clock class (traceability to a primary reference such as GPS), accuracy, variance, priority2, and finally clock identity as a tiebreak. Grandmaster → boundary/transparent clocks → ordinary slave clocks.

**Profiles matter operationally:** the default IEEE 1588 profile, the **802.1AS/gPTP** profile (Ethernet-layer, used in AVB/TSN and by some exchanges), the telecom profiles (G.8265.1/G.8275.1), and the **SMPTE** profile in broadcast. Multicast vs unicast, one-step vs two-step, and E2E vs P2P delay measurement are configured per profile and both ends must agree.

**Software stack on Linux** — `linuxptp`:

```bash
ptp4l -i eth0 -m -s -H          # discipline the NIC's PHC from the network (-H = HW timestamps)
phc2sys -s eth0 -c CLOCK_REALTIME -w -m   # copy the PHC to the system clock, waiting for ptp4l
pmc -u -b 0 'GET CURRENT_DATA_SET'        # query offsetFromMaster / meanPathDelay
ethtool -T eth0                            # DOES THIS NIC SUPPORT HARDWARE TIMESTAMPING?
```

The `ethtool -T` check is the first thing to run: `SOF_TIMESTAMPING_TX_HARDWARE`, `RX_HARDWARE`, and `RAW_HARDWARE` must be present, along with a `PTP Hardware Clock: N` line. Without them you are doing software PTP and none of the accuracy claims apply.

**Achieved accuracy:** **< 100 ns** (often 10–50 ns) with a GPS-disciplined grandmaster and transparent clocks throughout; **1–10 µs** with hardware timestamping but non-PTP-aware switches; **tens of µs** with software timestamping. `ptp4l -m` prints the servo's `master offset` each second, and a well-behaved system shows it oscillating within tens of nanoseconds of zero — a rising or sawtoothing offset means a servo problem, an asymmetric path, or a grandmaster change.

---

## 35.8 PTP Hardware Clocks

A **PHC** (PTP Hardware Clock) is a free-running, adjustable oscillator on the NIC itself, exposed as `/dev/ptp0`, `/dev/ptp1`, …. It is the physical clock PTP disciplines, and it is a **separate time domain from the system clock**.

```
   ┌─────────────────────────┐        ┌──────────────────────────┐
   │  NIC PHC  (/dev/ptp0)   │        │ System clock (CLOCK_*)   │
   │  disciplined by ptp4l   │──────▶ │ disciplined by phc2sys   │
   │  timestamps packets     │        │ used by clock_gettime    │
   └─────────────────────────┘        └──────────────────────────┘
        ptp4l  (network → PHC)             phc2sys (PHC → system)
```

**This two-stage structure is the single most-missed operational detail.** `ptp4l` synchronizes the *PHC* to the grandmaster. It does not touch `CLOCK_REALTIME`. A system running `ptp4l` alone will have perfectly synchronized packet timestamps and a system clock that drifts freely — application logs and packet captures disagree by seconds. `phc2sys` is what bridges them, and forgetting it is the classic PTP deployment error.

**API:**

```c
int fd = open("/dev/ptp0", O_RDWR);
clockid_t phc = FD_TO_CLOCKID(fd);        // ((~(clockid_t)fd << 3) | 3)
clock_gettime(phc, &ts);                  // ~1-5 µs: this is a PCIe MMIO read, NOT a TSC read
clock_adjtime(phc, &tx);                  // frequency/offset adjustment
ioctl(fd, PTP_SYS_OFFSET_PRECISE, &o);    // cross-timestamp PHC and system clock ATOMICALLY
```

`clock_gettime` on a PHC costs **1–5 µs** because it crosses PCIe to read a device register — three orders of magnitude more than a TSC read. Never call it on a hot path; use it only for calibration.

**`PTP_SYS_OFFSET_PRECISE`** is the important ioctl: on hardware supporting **PCIe PTM** (Precision Time Measurement) or an equivalent cross-timestamp mechanism, it returns a PHC reading and a system-clock reading captured *atomically*, eliminating the read-latency uncertainty that otherwise limits how well you can relate the two domains. Without it, `PTP_SYS_OFFSET` takes N interleaved reads and estimates, giving microsecond-class uncertainty.

**Packet timestamping.** With `SO_TIMESTAMPING` and the hardware flags, the NIC stamps each packet from the PHC and delivers the value as ancillary data on `recvmsg` (Ch. 45 §45.9, Ch. 48 §48.9):

```c
int flags = SOF_TIMESTAMPING_RX_HARDWARE | SOF_TIMESTAMPING_TX_HARDWARE |
            SOF_TIMESTAMPING_RAW_HARDWARE;
setsockopt(fd, SOL_SOCKET, SO_TIMESTAMPING, &flags, sizeof flags);
// arrives as SCM_TIMESTAMPING in msg_control: three timespecs, [2] = raw hardware
```

**Why this matters commercially.** A hardware receive timestamp measures when the packet actually arrived at your NIC — before the driver, the softirq, the socket queue, and your thread. Comparing it to the timestamp at which your application processed the message decomposes your latency into "network" and "stack + application," which is the only honest way to measure a feed handler. And because all participants' PHCs are disciplined to the same grandmaster, hardware timestamps are **comparable across machines**, making genuine one-way latency measurement possible — something impossible with unsynchronized clocks, where only round-trip times are meaningful (Ch. 48 §48.10).

**Residual error budget** to be able to recite: grandmaster to UTC (10–100 ns with GPS), grandmaster to NIC PHC (10–100 ns with transparent clocks), PHC to system clock via `phc2sys` (100 ns – 1 µs, better with PTM), and system clock read jitter (~20 ns). Total achievable timestamp uncertainty relative to UTC: **roughly 200 ns – 1 µs**, comfortably inside MiFID II's 100 µs requirement and adequate for cross-venue sequencing.

---

## 35.9 Clock Steps, Slews, and Leap Seconds

**Stepping** sets the clock discontinuously (`clock_settime`, `settimeofday`). Time can jump forwards or **backwards**. **Slewing** changes the clock's *rate* so the error is absorbed gradually (`adjtime`, `adjtimex`, `ntp_adjtime`), preserving monotonicity at the cost of a temporarily wrong rate.

```
Step:  ────────────╱────────  (discontinuity; duration measurements corrupted, possibly negative)
Slew:  ──────╱╱╱───────────   (rate briefly 1±ε; monotonic; ~500 ppm max, so 1 s of error
                               takes ~33 minutes to absorb)
```

Linux's default slew rate is bounded (classically 500 ppm, i.e. 0.5 ms per second), which is why chrony steps rather than slews when the offset is large — slewing a 10-second error would take days.

**What each affects:**

| | Step | Slew |
|---|---|---|
| `CLOCK_REALTIME` | Jumps | Rate adjusted |
| `CLOCK_MONOTONIC` | **Unaffected** | **Rate adjusted** (it is disciplined too) |
| `CLOCK_MONOTONIC_RAW` | Unaffected | **Unaffected** |
| `TFD_TIMER_ABSTIME` REALTIME timer | Fires early/late; `TFD_TIMER_CANCEL_ON_SET` → `ECANCELED` | Slight shift |
| `pthread_cond_timedwait` (default REALTIME) | **Wakes early or hangs** | Slight shift |

That last row is a real, hard-to-find bug: `pthread_cond_timedwait` takes an absolute `CLOCK_REALTIME` deadline by default, so a backwards step of one hour makes a 1-second wait hang for an hour. The fix is `pthread_condattr_setclock(&attr, CLOCK_MONOTONIC)` — and the corresponding C++ rule is that `std::condition_variable::wait_until` with a `system_clock` time point has the same hazard, while `wait_for` is specified in terms of a steady clock. Prefer `wait_for`, or a `steady_clock` deadline.

**Leap seconds.** UTC inserts a leap second to keep within 0.9 s of the Earth's rotation; the last was 2016-12-31, and the practice is scheduled for abolition by 2035. Linux's kernel handling repeats 23:59:59 — `CLOCK_REALTIME` goes **backwards by one second**, breaking the assumption of monotonic wall-clock timestamps and famously causing the 2012 and 2015 outages (a kernel hrtimer/futex deadlock in 2012; widespread application failures both times).

Approaches, all worth naming:

| Strategy | Behaviour |
|---|---|
| **Kernel step** (default) | 23:59:59 repeats; `CLOCK_REALTIME` non-monotonic |
| **Slewing / "leap smear"** (Google, AWS, and now standard practice) | Spread the extra second over ~24 hours as a ~11.6 ppm rate change; the clock stays monotonic and no application sees a discontinuity — **but the machine is up to 0.5 s away from true UTC during the smear**, and smearing servers must not be mixed with non-smearing ones |
| **`CLOCK_TAI`** | No leap seconds at all; the right internal timebase for a PTP-synchronized system, converted to UTC only for display |
| `STA_INS`/`STA_DEL` via `adjtimex` | How the kernel is told a leap is pending; `chronyc` and `ntpq` report it |

**The trading-system rule** follows directly and is the answer interviewers want: **timestamp internally in `CLOCK_MONOTONIC` or `CLOCK_TAI`, correlate to wall-clock once at a known point, and never compute a duration from two `CLOCK_REALTIME` readings.** Then a step, a slew, or a leap second is a display-layer concern rather than a correctness bug — and your sequence numbers, not your timestamps, are what establish event order (Ch. 59 §59.8).

---

## 35.10 Sysctl, procfs, and sysfs Tuning

Three kernel interfaces, routinely conflated:

- **procfs** (`/proc`) — per-process information (`/proc/PID/…`) plus legacy system information (`/proc/cpuinfo`, `/proc/interrupts`, `/proc/meminfo`).
- **sysfs** (`/sys`) — the device model: one value per file, hierarchically organized by bus/device/driver. Where hardware-adjacent knobs live.
- **sysctl** (`/proc/sys`, `sysctl(8)`) — tunable kernel parameters, persisted in `/etc/sysctl.d/*.conf`.

**The tuning knobs that actually matter for a low-latency host**, with the reasoning:

```bash
# --- Scheduling / preemption ---
kernel.sched_rt_runtime_us = -1        # remove the RT throttle (default: 950000 of 1000000 µs,
                                       #  i.e. RT tasks capped at 95%). A busy-spinning SCHED_FIFO
                                       #  thread WILL be throttled without this — and the symptom
                                       #  is a 50 ms stall every second. Removing it means a runaway
                                       #  RT thread can wedge the box: pair with a watchdog.
kernel.numa_balancing = 0              # stop automatic page migration (§35.16); it unmaps pages and
                                       #  forces NUMA hinting faults on a pinned, first-touched heap
kernel.watchdog = 0                    # disable the NMI soft-lockup detector's periodic work
kernel.timer_migration = 0             # don't migrate timers onto other CPUs

# --- Memory ---
vm.swappiness = 0                      # never swap the trading process
vm.zone_reclaim_mode = 0               # do not reclaim locally instead of allocating remotely
vm.stat_interval = 120                 # vmstat accounting sweep; default 1 s touches every CPU
vm.max_map_count = 1048576             # many mmaps
vm.nr_hugepages = N                    # explicit 2 MiB pages (Ch. 32 §32.10)

# --- Network (for the non-bypass path) ---
net.core.busy_poll = 50                # µs of driver polling inside a blocking socket call
net.core.busy_read = 50
net.core.rmem_max = 134217728          # allow large SO_RCVBUF for burst absorption
net.ipv4.udp_mem / net.core.netdev_max_backlog = 250000
net.ipv4.tcp_low_latency = 1           # (no-op on modern kernels; know that it was removed)

# --- Misc jitter ---
kernel.randomize_va_space = 0          # ASLR off: reproducible layout for perf/BOLT (security cost)
```

**sysfs knobs**, the hardware-adjacent half:

```bash
/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor          # performance (§35.11)
/sys/devices/system/cpu/cpu*/cpuidle/state*/disable            # per-C-state disable (§35.13)
/sys/devices/system/cpu/intel_pstate/no_turbo                  # turbo on/off (§35.12)
/sys/devices/system/clocksource/clocksource0/current_clocksource  # §35.1
/sys/kernel/mm/transparent_hugepage/enabled                    # THP policy (§35.19)
/sys/class/net/eth0/queues/rx-*/rps_cpus                       # RPS steering (Ch. 46 §46.13)
/proc/irq/N/smp_affinity                                       # IRQ pinning (§35.14)
```

**`tuned`** is the distribution-level orchestrator: `tuned-adm profile latency-performance` (or `network-latency`, or the more aggressive `realtime` profile from `tuned-profiles-realtime`) sets governor, C-state limits (via a `force_latency` PM QoS request), `sched_min_granularity`, THP, and more in one step. Knowing that `tuned` exists and what its profiles change is a practical answer; knowing that you should still verify each knob afterwards (because profiles silently no-op on unsupported hardware) is a better one.

**PM QoS** deserves its own mention because it is the *programmatic* way to bound wakeup latency without disabling C-states globally:

```c
int fd = open("/dev/cpu_dma_latency", O_WRONLY);
int32_t target_us = 0;
write(fd, &target_us, sizeof target_us);   // keep the fd OPEN — the constraint lifts on close
```

Writing 0 requests that no C-state with an exit latency above 0 µs be entered — effectively pinning cores to C0/C1. This is exactly what `cyclictest` does internally, and it explains why `cyclictest` results can look better than your application's: it silently applied a PM QoS constraint that your application did not.

---

## 35.11 CPU Frequency Governors

The **cpufreq** subsystem selects the operating frequency (P-state). The governor is the policy.

| Governor | Behaviour | Latency impact |
|---|---|---|
| `performance` | Always the maximum non-turbo frequency (and turbo when available) | **Correct choice.** No transition latency |
| `powersave` | With `intel_pstate`, this is *not* "minimum" — it is the HWP-driven adaptive mode, and it is the default | Ramp-up latency of 10s of µs; the first packets after idle run slow |
| `ondemand` / `conservative` | Legacy `acpi-cpufreq` governors, sampling-based | Sampling period 10–100 ms; badly wrong for bursty work |
| `schedutil` | Driven by scheduler utilization signals; the modern default | Faster to react than `ondemand`, still reactive |
| `userspace` | Explicit frequency setting | For pinned experiments |

```bash
cpupower frequency-info                 # driver, governor, available frequencies, current
cpupower frequency-set -g performance   # set everywhere
echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
grep MHz /proc/cpuinfo                  # per-core CURRENT frequency — the ground truth
turbostat --interval 1                  # per-core Bzy_MHz, C-state residency, package power
```

**Why a reactive governor is a latency bug, quantified.** A core idling at 800 MHz that receives a packet must (a) notice the load, which takes a sampling interval or a scheduler utilization update, and (b) ramp the frequency, which costs a voltage transition. During that window your handler runs at **a quarter of full speed**. The measured effect is that the first message after an idle period takes 2–4× as long as the steady-state case — visible as a bimodal latency distribution correlated with idle gaps, which is one of the most distinctive jitter signatures there is. A busy-polling thread partially masks this by never letting the core idle, which is a real, under-appreciated secondary benefit of busy-polling.

**`intel_pstate` vs `acpi-cpufreq`.** `intel_pstate` is a driver that bypasses the generic governor framework and only exposes `performance` and `powersave`. On modern parts it runs in **HWP** (Hardware P-states / Speed Shift) mode where the *hardware* picks the frequency at ~1 ms granularity rather than the kernel at ~10 ms — much better, but still reactive. `intel_pstate=disable` on the kernel command line reverts to `acpi-cpufreq` with the full governor set; `intel_pstate=passive` keeps the driver but uses generic governors. For a trading box: `performance` governor, plus `/sys/devices/system/cpu/intel_pstate/min_perf_pct=100` to pin the floor.

**Additional frequency traps worth naming:**

- **AVX/AVX-512 licence-based downclocking**: heavy 512-bit code on some Intel generations drops the core (and sometimes package) frequency by 15–40%, and the transition itself stalls for ~10–50 µs. This can make a SIMD "optimization" a net loss in a latency-sensitive mixed workload (Ch. 42 §42.13).
- **Thermal and power (RAPL) throttling**: a hot or power-limited package silently drops frequency. `turbostat` shows `PkgWatt` and throttle reasons; `/sys/class/thermal` and MSR `IA32_THERM_STATUS` report it.
- **Uncore frequency** is separate from core frequency and governs L3/mesh/memory-controller speed; it also scales down when idle, adding memory latency to the first accesses after idle. It can be pinned via MSR on server parts.

---

## 35.12 Turbo Boost

**Turbo Boost** (Intel) / **Precision Boost** (AMD) opportunistically raises frequency above the base clock when thermal, current, and power budgets allow. The achievable frequency depends on **how many cores are active**:

```
Example server part:  base 2.5 GHz
   1–2 active cores : up to 3.9 GHz      ← the single-threaded turbo bin
   3–8 active cores : up to 3.4 GHz
   all cores active : up to 2.9 GHz
Sustained AVX-512 all-core: possibly BELOW base
```

**The tension for low latency:** turbo gives you 20–50% more single-thread performance — which is exactly what a serialized hot path needs — but it is **not deterministic**. Frequency depends on the activity of *other* cores, on package temperature, and on power budget, all of which change over the trading day. Two identical messages can take measurably different times purely because a neighbouring core woke up.

The two defensible positions, and being able to argue both is what an interviewer wants:

| Turbo **on** | Turbo **off** |
|---|---|
| Lower mean and lower p50 latency | **Lower variance**; p99/p99.9 tighter |
| Frequency varies with neighbours' activity | Fixed frequency, fully reproducible |
| Benchmarks are noisy and non-reproducible | Benchmarks are comparable across runs and machines |
| Requires cooling headroom to sustain | Sustainable indefinitely |

Most HFT shops **run with turbo enabled but engineer for determinism around it**: isolate cores so neighbours are quiet, keep the box cool and well below power limits, pin the AVX licence level by avoiding heavy 512-bit code on latency cores, and — critically — **disable turbo for benchmarking** so that A/B comparisons are meaningful (Ch. 43 §43.9). The failure mode of leaving it on for measurement is that a code change appears to help because the run happened to be cooler.

```bash
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo     # intel_pstate
echo 0 > /sys/devices/system/cpu/cpufreq/boost             # acpi-cpufreq / AMD
turbostat --show Core,Bzy_MHz,TSC_MHz,PkgWatt --interval 1 # verify what you actually got
```

**A crucial measurement subtlety:** the TSC ticks at the **invariant base frequency**, not the current core frequency (§35.3). So a cycle count derived from `rdtsc` is really a *time* measurement, and if the core is turboing you executed more instructions than the "cycle" count suggests. Comparing `rdtsc` deltas against `perf`'s `cycles` counter (which counts actual core clocks) reveals the ratio — `turbostat`'s `Bzy_MHz` vs `TSC_MHz` columns show it directly. Mixing the two units is a common and embarrassing benchmarking error.

**SMT interaction:** hyperthreading siblings share the core's frequency and execution resources. On a latency core, SMT is normally disabled entirely (`nosmt`, or offlining the sibling) both to remove resource contention (Ch. 27 §27.17) and to remove the sibling's activity as a variable in the turbo calculation.

---

## 35.13 CPU C-States and P-States

Two orthogonal power-management axes, and conflating them is a reliable interview tell.

- **P-states** (performance states) — the frequency/voltage operating point of a *running* core. P0 is the highest. Governed by §35.11.
- **C-states** (idle states) — how deeply a core sleeps when it has *nothing to run*. C0 means executing. Higher C-states progressively shut down more: clocks, then core caches (L1/L2 flushed), then the core's voltage, then package-level resources including the L3 and memory controller.

**Exit latencies are the entire story:**

| C-state | What is powered down | **Exit latency** | Residual effect on wakeup |
|---|---|---|---|
| C0 | Nothing — running | 0 | — |
| C1 / C1E | Core clock gated (`hlt`) | **~1–2 µs** | Negligible |
| C3 | L1/L2 flushed, clocks off | **~30–100 µs** | Cold L1/L2 — re-warm cost on top |
| C6 | Core voltage removed; core state saved to L3/SRAM | **~50–150 µs** | Cold caches, register restore |
| C7–C10 (package) | L3 flushed, memory controller partly down | **150 µs – 1 ms** | Cold L3 and TLB; DRAM in self-refresh |

A **C6 exit costs more than everything else in a tick-to-trade budget combined.** A trading process that receives a packet every few milliseconds and is otherwise idle will find its core in C6 on nearly every packet, adding 50–150 µs to a path budgeted at 2 µs. This is by a wide margin the most common cause of "our latency is 100× worse in production than in the benchmark," because a benchmark loop keeps the core in C0 and production does not.

**Inspection and control:**

```bash
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name      # POLL C1 C1E C6 ...
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/latency   # exit latency in µs
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/usage     # how often each was entered — THE
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/time      # diagnostic: nonzero C6 usage on a
                                                          # "busy-polling" core means you are wrong
turbostat --show Core,CPU%c1,CPU%c6,CPU%c7,PkgWatt

# Disable per-state (surgical, preferred):
echo 1 > /sys/devices/system/cpu/cpu5/cpuidle/state3/disable
# Global, at boot:
#   intel_idle.max_cstate=1   processor.max_cstate=1   idle=poll
# Programmatic, per-process, dynamic:
#   write 0 to /dev/cpu_dma_latency and HOLD THE FD OPEN (PM QoS, §35.10)
```

**`idle=poll` vs limiting C-states.** `idle=poll` makes the idle loop spin in C0 rather than executing `mwait`/`hlt` — zero exit latency, maximum power draw, significant heat. The heat matters: a hotter package has less turbo headroom (§35.12), so `idle=poll` on all cores can *reduce* peak frequency. The better configuration is `intel_idle.max_cstate=1` (allowing C1, whose ~1 µs exit is usually acceptable) plus a PM QoS constraint, or per-core state disabling on the latency cores only, leaving housekeeping cores free to sleep.

**Why busy-polling solves this for free:** a thread spinning on `recvmsg` or on a shared-memory sequence number never lets the core idle, so it never enters a C-state and never pays an exit. This is a *second* major justification for busy-polling, independent of the wakeup-cost argument of Ch. 34 §34.3 — and it also keeps the core at a stable turbo frequency and keeps the caches, TLB, and branch predictors warm. Being able to enumerate all four benefits (no wakeup, no C-state exit, no frequency ramp, warm caches) is the complete answer to "why do you burn a core?"

**BIOS matters too.** Many of these are gated by firmware settings that Linux cannot override: C-state enablement, package C-state limits, "OS controls EIST," C1E promotion, and the SMI-generating features below. A proper low-latency box has a documented, version-pinned BIOS profile — typically: power profile = maximum performance, C-states limited, C1E off, turbo on, SMT off, patrol scrub and memory power-down off, and **all** the BMC/health-monitoring features that generate SMIs disabled.

**SMIs (System Management Interrupts)** deserve a final word because they are the invisible jitter source: firmware traps into System Management Mode, freezing *all* cores for anywhere from microseconds to milliseconds, entirely opaque to the OS and to `perf`. Caused by thermal monitoring, memory error handling, USB legacy emulation, and BMC polling. Detect them with `turbostat`'s `SMI` column or the MSR `MSR_SMI_COUNT` (0x34); a rising count correlated with your latency outliers is conclusive, and the fix is a BIOS change, not a software one.

---

## 35.14 IRQ Affinity

A hardware interrupt is delivered to a specific CPU, which then runs the hard-IRQ handler and schedules softirq work (§35.15). **Where that happens determines both whose cache is polluted and how long the receive path takes.**

```bash
cat /proc/interrupts                     # per-CPU counts per IRQ — the primary diagnostic
cat /proc/irq/145/smp_affinity           # hex CPU mask
cat /proc/irq/145/smp_affinity_list      # human-readable
echo 4 > /proc/irq/145/smp_affinity_list # pin IRQ 145 to CPU 4
cat /proc/irq/default_smp_affinity
```

**`irqbalance` must be dealt with.** The daemon periodically redistributes IRQs across CPUs for thermal and throughput balance, and it will happily move your NIC interrupt onto an isolated core, or move it away from the core you carefully chose — silently, minutes after boot, producing latency that changes without a deploy. Either stop it (`systemctl disable --now irqbalance`) or constrain it (`IRQBALANCE_BANNED_CPUS` mask in `/etc/sysconfig/irqbalance`). Note that `isolcpus` alone does **not** stop irqbalance from targeting a core; `irqaffinity=` on the kernel command line sets the default mask for all IRQs at boot, which is the durable fix.

**The placement decision, with reasoning:**

1. **Never on an isolated application core.** An interrupt on your busy-polling core preempts it, pollutes L1/L2, and adds microseconds. This is the primary rule.
2. **On a core on the same NUMA node as the NIC.** `cat /sys/class/net/eth0/device/numa_node` gives the node; an IRQ handled on the wrong node means the sk_buff and packet data are written to remote memory and then read across the interconnect — adding ~100 ns per access and consuming interconnect bandwidth (Ch. 29 §29.19).
3. **On a core that shares L3 with the consuming application core** if possible, so the DDIO-placed packet data (Ch. 29 §29.24) is in a shared last-level cache rather than requiring a cross-socket transfer.
4. **One RX queue per consuming thread**, with the queue's IRQ pinned to a core adjacent to that thread (Ch. 46 §46.15). Combined with RSS or flow steering (Ch. 46 §46.12–46.14), this makes the entire receive path for a given flow stay on one core and one NUMA node.

```bash
# Multi-queue NIC: pin each queue's IRQ deliberately
for irq in $(grep 'eth0-TxRx' /proc/interrupts | cut -d: -f1); do ... done
# The vendor script (Intel's set_irq_affinity.sh, Mellanox's mlnx_affinity) automates this
ethtool -l eth0                    # queue counts
ethtool -L eth0 combined 4         # reduce queues to match your thread count
ethtool -c eth0                    # coalescing settings
ethtool -C eth0 rx-usecs 0 rx-frames 1 adaptive-rx off    # LATENCY: interrupt per packet
```

**Interrupt coalescing** is the direct latency/CPU trade (Ch. 46 §46.6): `rx-usecs 50` means the NIC waits up to 50 µs to batch interrupts, adding up to 50 µs of latency to save CPU. For low latency you set `rx-usecs 0 rx-frames 1` and disable adaptive coalescing — accepting an interrupt per packet, which at high packet rates costs enormous CPU. NAPI mitigates this by switching to polling under load (Ch. 46 §46.5), which is the kernel's own admission that polling beats interrupts when the rate is high. Kernel bypass takes the idea to its conclusion: no interrupts at all.

**Diagnostic signature.** `watch -n1 'cat /proc/interrupts'` with counts climbing on an isolated core means something is wrong: either irqbalance moved an IRQ, or a device (often the local timer, a management NIC, or an NVMe queue) defaults to that CPU. On a properly isolated core, the only interrupts that should appear are the rescheduling IPI (which should be near-zero) and, unless `nohz_full` is working, the local timer.

---

## 35.15 Softirqs and Kernel Workqueues

Interrupt handling is split into a **top half** (hard IRQ, runs with interrupts disabled, must be short) and a **bottom half** (deferred work). Linux has three deferral mechanisms with materially different scheduling properties.

| Mechanism | Context | Can sleep | Concurrency | Latency |
|---|---|---|---|---|
| **softirq** | Interrupt/atomic context | **No** | Same type runs in parallel on different CPUs | Lowest — runs on IRQ return |
| **tasklet** | Built on softirq (`TASKLET_SOFTIRQ`) | No | Same tasklet is **serialized** across CPUs | Low; deprecated in favour of workqueues |
| **workqueue** | Kernel thread (`kworker/N:M`) | **Yes** | Configurable pools, CPU-bound or unbound | Higher; schedulable and preemptible |
| **threaded IRQ** | Dedicated kthread (`irq/N-name`) | Yes | Per-IRQ | Higher, but **prioritizable and pinnable** — the RT approach |

**The ten softirq types**, in priority order: `HI`, `TIMER`, `NET_TX`, `NET_RX`, `BLOCK`, `IRQ_POLL`, `TASKLET`, `SCHED`, `HRTIMER`, `RCU`. `NET_RX` is where the entire kernel receive path lives — NAPI polling, GRO, IP and TCP/UDP processing, and the socket queue append (Ch. 46 §46.1).

**Where softirqs run, and why it hurts.** Softirqs execute on return from the hard IRQ, **on whichever CPU took the interrupt**, in the context of whatever was running there — meaning your application thread can be preempted for the duration of packet processing that has nothing to do with it. If the softirq load exceeds a budget (`net.core.netdev_budget`, default 300 packets, and 2 jiffies of time), the remainder is deferred to the per-CPU `ksoftirqd/N` kernel thread, which runs at normal priority and *competes with your application*.

```
$ cat /proc/softirqs        # per-CPU counts per softirq type
$ ps -eo pid,comm,psr | grep ksoftirqd
$ perf record -e irq:softirq_entry -a       # who is entering softirqs, and where
$ bpftrace -e 'tracepoint:irq:softirq_entry { @[args->vec] = count(); }'
```

**The diagnostic signature to recognize:** a `ksoftirqd/N` thread consuming meaningful CPU means CPU N is saturated with softirq work — usually a packet flood, sometimes an RCU callback backlog. If N is an isolated core, that is a misconfiguration (§35.14). If it is a housekeeping core, it is a capacity problem. Either way, latency on that core becomes unpredictable, and rising `netdev_budget` exhaustion (visible as the third column of `/proc/net/softnet_stat`) is corroborating evidence.

**Workqueue affinity.** Unbound workqueue workers (`kworker/u*`) can run on any CPU, including isolated ones. Constrain them:

```bash
echo 0-3 > /sys/devices/virtual/workqueue/cpumask                        # global default
echo 0-3 > /sys/devices/virtual/workqueue/writeback/cpumask              # per-workqueue
# Kernel command line: workqueue.unbound_cpus=0-3   (or rely on nohz_full/isolcpus, which
#   the kernel increasingly honours for unbound workqueue placement)
```

**Threaded IRQs and PREEMPT_RT.** `threadirqs` on the kernel command line converts most hard IRQ handlers into kernel threads, which PREEMPT_RT does by default (§35.17). The benefit is that interrupt handling becomes a *schedulable, prioritizable, pinnable* entity: you can give the NIC IRQ thread `SCHED_FIFO` priority 50 and pin it, and give a lower priority to a disk IRQ, so that a storage burst cannot delay network processing. The cost is an extra context switch per interrupt (~1–2 µs), which raises mean latency while dramatically improving the tail — the recurring RT tradeoff.

**RCU offload.** `rcu_nocbs=2-15` moves RCU grace-period callback processing off the listed CPUs onto `rcuo` kthreads elsewhere, removing a periodic, hard-to-predict source of work from your isolated cores. It is a standard companion to `nohz_full` and is frequently forgotten (§35.16).

---

## 35.16 Kernel Command-Line Isolation Options

The boot-time isolation set is the backbone of a low-latency box. Each option removes a distinct class of interference, and knowing *which* is the point.

```
isolcpus=domain,managed_irq,4-19  nohz_full=4-19  rcu_nocbs=4-19  rcu_nocb_poll
irqaffinity=0-3  intel_pstate=disable  processor.max_cstate=1  intel_idle.max_cstate=1
idle=poll  nosmt  mce=ignore_ce  audit=0  nmi_watchdog=0  skew_tick=1
tsc=reliable  nohpet  transparent_hugepage=never  default_hugepagesz=1G hugepagesz=1G
hugepages=32  iommu=pt  pcie_aspm=off  numa_balancing=disable
```

| Option | What it removes | Notes |
|---|---|---|
| **`isolcpus=4-19`** | The scheduler will not place any task on these CPUs unless explicitly affined | Deprecated in form but universally used; `domain` isolates from load balancing, `managed_irq` from managed device interrupts. **Does not stop kernel threads, timers, or IPIs.** |
| **`nohz_full=4-19`** | The **periodic scheduler tick** (100/250/1000 Hz), when exactly one runnable task is on the CPU | The single largest win after isolation. Requires `CONFIG_NO_HZ_FULL`; needs at least one housekeeping CPU excluded. If a second task becomes runnable, the tick **comes back silently** |
| **`rcu_nocbs=4-19`** | RCU callback invocation on those CPUs | Nearly always needed with `nohz_full`; otherwise RCU work reintroduces periodic activity |
| `rcu_nocb_poll` | The IPI used to wake the `rcuo` threads | The offload threads poll instead |
| **`irqaffinity=0-3`** | Default IRQ placement on isolated cores | Boot-time equivalent of §35.14; more durable than post-boot scripting |
| `nosmt` | The hyperthread sibling's resource contention | Also removes its influence on turbo bins |
| `skew_tick=1` | Simultaneous tick processing across all CPUs (a lock-contention storm) | Cheap, safe |
| `audit=0`, `nmi_watchdog=0`, `mce=ignore_ce` | Periodic auditing, watchdog, and corrected-error handling work | |
| `iommu=pt` | IOMMU translation on the DMA path (passthrough mode) | Keeps IOMMU for isolation but removes per-transfer translation cost (Ch. 29 §29.23) |
| `pcie_aspm=off` | PCIe link power-state exit latency (µs-class) on the NIC path | Frequently forgotten; matters for §35.22 |

**`nohz_full` deserves elaboration**, because it is the highest-value and most misunderstood option. Normally every CPU takes a timer interrupt at `CONFIG_HZ` to update time accounting, run the scheduler, and process RCU. On a 1000 Hz kernel that is an interrupt every millisecond costing 1–5 µs plus cache pollution — a hard floor on your jitter. `nohz_full` puts the CPU in "adaptive tick" mode: with exactly one runnable task, the tick is disabled entirely (in practice, reduced to 1 Hz for accounting). The conditions are strict — **one** runnable task, RCU callbacks offloaded, and at least one housekeeping CPU to absorb the deferred work — and the failure mode is silent: spawn a second thread on that core and the tick returns with no error message. Verify empirically:

```bash
# Before and after, with the workload running:
grep 'LOC' /proc/interrupts                       # local timer interrupt counts per CPU
perf stat -e irq_vectors:local_timer_entry -C 8 -- sleep 10
# A properly nohz_full core shows single-digit counts over 10 seconds, not 10,000.
```

**Verification generally is the theme.** Every one of these options can silently fail — an unsupported kernel config, a conflicting `cgroup` setting, a `tuned` profile applied later, irqbalance restarting. A production checklist ends with measurements, not with a command line: `/proc/interrupts` for LOC and device IRQs, `/proc/softirqs`, C-state `usage` counters, `turbostat` for frequency and SMI count, and `cyclictest` for the end-to-end number (§35.18).

**cpusets as the modern complement.** `isolcpus` is static and boot-time; **cgroup v2 `cpuset`** partitions dynamically, and `cpuset.cpus.partition = isolated` (5.17+) provides `isolcpus`-equivalent behaviour at runtime. The typical layout is a `system.slice` restricted to CPUs 0–3 and an isolated partition holding the trading process — which additionally catches everything systemd starts later.

---

## 35.17 PREEMPT_RT

The mainline Linux preemption models, in increasing order of responsiveness:

| Model | Behaviour | Typical worst-case latency |
|---|---|---|
| `PREEMPT_NONE` | Kernel code runs to completion or an explicit reschedule point | **10s of ms** |
| `PREEMPT_VOLUNTARY` | Extra `might_sleep` reschedule points | ~ms |
| `PREEMPT` (desktop) | Kernel is preemptible except in critical sections | **100s of µs** |
| **`PREEMPT_RT`** | Nearly fully preemptible kernel | **10s of µs, bounded** |
| `PREEMPT_DYNAMIC` | Runtime-selectable via `preempt=` | — |

**What PREEMPT_RT actually changes** — the four mechanisms, which is what a good answer enumerates:

1. **Spinlocks become sleeping mutexes** (`rt_mutex`, built on the same PI infrastructure as `FUTEX_LOCK_PI`, Ch. 33 §33.7). A kernel critical section no longer disables preemption, so a high-priority task can preempt kernel code holding a lock. `raw_spinlock_t` remains a true spinlock for the few genuinely atomic sites.
2. **Interrupt handlers become threads** by default (§35.15), so they are schedulable, prioritizable, and preemptible.
3. **Priority inheritance everywhere** in the kernel, bounding priority inversion (Ch. 24 §24.18).
4. **Softirqs are threaded and accounted** to the tasks that raised them, removing the "arbitrary work stolen from your CPU" problem of §35.15.

Merged into mainline in **Linux 6.12** (2024) after two decades out of tree — worth knowing as a currency check.

**The tradeoff, stated honestly:** PREEMPT_RT reduces the **worst case** and increases the **mean**. Every former spinlock acquisition is now a potentially-sleeping operation with more bookkeeping; every interrupt costs an extra context switch. Throughput typically drops **5–15%** and mean latency rises measurably. For a control system that must never miss a 100 µs deadline, that is an obvious win. For an HFT system optimizing p50 and p99 in the *single-digit microseconds*, it is usually a **loss** — because a busy-polling thread on an isolated `nohz_full` core with no syscalls in the hot path is never in the kernel to be preempted in the first place, so PREEMPT_RT's guarantees apply to a code path you do not execute.

**The honest interview answer** is therefore: *PREEMPT_RT is the right tool when you cannot avoid the kernel and need a bounded worst case; HFT instead avoids the kernel entirely (kernel bypass, isolated cores, busy polling) and gets a better mean and a better tail without paying the throughput cost.* Some shops do use RT kernels for order-management components with hard deadlines while running the market-data path on a tuned standard kernel. Recognizing that the two approaches solve different problems is the substance.

**Real-time scheduling policies** are available on any kernel and are the part you *do* use (Ch. 31 §31.15):

```bash
chrt -f 80 -p PID              # SCHED_FIFO priority 80: runs until it yields or is preempted
chrt -r 80 -p PID              # SCHED_RR: FIFO plus a round-robin timeslice among equals
chrt -d --sched-runtime 1000000 --sched-deadline 10000000 --sched-period 10000000 -p 0 PID
                               # SCHED_DEADLINE: EDF with admission control — the strongest guarantee
```

The mandatory companions: `kernel.sched_rt_runtime_us = -1` (§35.10) or a busy-spinning FIFO thread is throttled for 50 ms out of every second — a spectacular and confusing failure; `mlockall(MCL_CURRENT|MCL_FUTURE)` so a page fault cannot inject milliseconds; and a watchdog, because a runaway `SCHED_FIFO` thread on an isolated core with the throttle removed will render that core unusable and can wedge the machine if it holds a resource.

---

## 35.18 cyclictest

`cyclictest` (from `rt-tests`) is the standard instrument for measuring **scheduling wakeup latency**: the difference between when a timer should have fired and when the woken thread actually ran.

```
Loop:  t_expected = now + interval
       clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, t_expected)
       latency = clock_gettime() - t_expected      ← histogram this
```

It measures the sum of: timer interrupt delivery, hard IRQ handling, softirq/hrtimer callback, scheduler wakeup, context switch, and C-state exit. That is precisely the path a blocking application takes, which is why it is the industry's canonical tuning benchmark.

```bash
cyclictest -m -p 99 -i 200 -h 400 -q -D 24h -t 4 -a 4-7
#  -m  mlockall (no page-fault noise)        -p 99  SCHED_FIFO priority 99
#  -i 200  200 µs interval                   -h 400 histogram to 400 µs
#  -t 4 -a 4-7  four threads pinned to CPUs 4–7
#  -D 24h  RUN IT FOR A DAY — the tail is the whole point
```

**Reading the output:** the mean is nearly meaningless; the **Max** column is the deliverable, and a single 800 µs outlier in 24 hours is a finding, not noise. `-h` produces a histogram you should plot on a log scale, where a well-tuned system shows a tight primary mode and a clean absence of secondary modes. A **secondary mode is a fingerprint**: a cluster around 50–150 µs is C-state exit (§35.13); one around 1–5 ms is a periodic kernel activity (writeback, THP compaction, vmstat); one correlated with network load is softirq preemption (§35.15).

**Reference figures (typical modern x86-64 server):**

| Configuration | Max latency over hours |
|---|---|
| Stock distro kernel, default settings, idle | **200 µs – 5 ms** |
| Stock kernel, tuned (isolcpus, nohz_full, C1, performance governor) | **20–80 µs** |
| PREEMPT_RT, tuned | **10–30 µs** |
| PREEMPT_RT, fully tuned, quality hardware, no SMIs | **< 10 µs** |
| Under load (`-l`, or with `stress-ng`/`hackbench` running) | Add 2–10× if tuning is incomplete |

**Always run it under load.** An idle box measures nothing; the interference you care about is precisely what a loaded box produces. The standard method is `cyclictest` plus `stress-ng --cpu N --io N --vm N` or `hackbench` in a loop, and the tuning is finished when loading the box does not move the maximum.

**The critical caveat, and the reason this section is not the last word:** `cyclictest` measures the *sleep-and-wake* path. A busy-polling HFT thread never sleeps, so cyclictest's number is **not** your application's jitter. What it does measure is the box's susceptibility to interference — SMIs, C-states, unexpected interrupts, unpinned kernel threads — all of which affect a busy-polling thread too, just through preemption rather than through wakeup. So use it as a **box qualification test** (does this machine have hidden jitter sources?), and measure your actual hot path separately with `rdtsc` histograms (Ch. 43 §43.4) and hardware timestamps (§35.8). Two related tools complete the picture: **`hwlatdetect`**, which disables interrupts and looks for time gaps that can only be explained by SMM — the direct SMI detector — and **`oslat`**, which measures how long a *busy-spinning* thread is stolen from, which is much closer to what an HFT thread experiences.

---

## 35.19 Transparent-Huge-Page Latency Spikes

**THP** automatically backs anonymous mappings with 2 MiB pages, reducing TLB pressure substantially (Ch. 32 §32.11). The benefit is real — a 1 GB working set needs 262,144 4 KiB PTEs but only 512 2 MiB PMDs, which fits comfortably in the TLB. The **cost is unpredictable, unbounded stalls**, which for a latency-sensitive process is disqualifying.

**The three mechanisms that cause spikes:**

1. **Synchronous compaction at fault time.** With `enabled=always` and `defrag=always`, a page fault that needs a huge page but finds no free 2 MiB-aligned contiguous block triggers **direct compaction**: the faulting thread migrates pages to build one. This can take **microseconds to hundreds of milliseconds**, in your thread, on your critical path, with no warning. It is the single worst tail-latency source in the memory subsystem.
2. **`khugepaged`.** A background kernel thread scans for runs of 4 KiB pages to collapse into huge pages. Collapsing requires holding `mmap_lock` for write and issuing a **TLB shootdown IPI to every CPU with that mm mapped** (Ch. 32 §32.9), stalling all of your threads for the duration. Tunable via `scan_sleep_millisecs` and `pages_to_scan`, but not eliminable while enabled.
3. **Memory bloat and reclaim.** Allocating a 2 MiB page for a 4 KiB need wastes memory; a program with a sparse access pattern can multiply its RSS several-fold, pushing the system into reclaim — which brings its own stalls.

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled    # [always] madvise never
cat /sys/kernel/mm/transparent_hugepage/defrag     # always defer defer+madvise [madvise] never
grep -i 'AnonHugePages\|ThpPmdMapped' /proc/meminfo /proc/PID/smaps_rollup
grep 'thp_\|compact_' /proc/vmstat                 # thp_fault_alloc, thp_collapse_alloc,
                                                   # compact_stall  ← THE smoking gun
```

**`compact_stall` in `/proc/vmstat` incrementing while your p99.9 spikes is the diagnostic**, and it is directly attributable.

**The recommendation, with the reasoning that makes it more than a rule of thumb:**

| Setting | When |
|---|---|
| `transparent_hugepage=never` | **Latency-critical processes.** The default for trading systems, and what MongoDB, Redis, Cassandra, Couchbase, and Oracle all recommend |
| `enabled=madvise` + `defrag=madvise` | You want huge pages *only* where you explicitly asked with `madvise(MADV_HUGEPAGE)`, and only with synchronous compaction there |
| **Explicit huge pages** (`hugetlbfs`, `vm.nr_hugepages`, `MAP_HUGETLB`) | **The correct answer.** Reserved at boot, guaranteed available, never compacted, never collapsed, never reclaimed |

The key insight to articulate: **you want huge pages, you do not want *transparent* huge pages.** The TLB benefit is real and worth having for a large order book or a market-data ring. What you cannot tolerate is the kernel deciding, at an arbitrary moment on your critical path, to go and manufacture one. Reserving huge pages at boot with `default_hugepagesz=1G hugepagesz=1G hugepages=32` and mapping them explicitly gives you the entire benefit with none of the variance — and 1 GiB pages eliminate TLB misses for the working set almost entirely. `mlockall(MCL_CURRENT|MCL_FUTURE)` at startup plus prefaulting (`MAP_POPULATE` or touching every page) completes the picture, guaranteeing no fault of any kind occurs after initialization.

---

## 35.20 cgroups and Namespaces

**Namespaces** virtualize *what a process can see*; **cgroups** limit *what it can use*. Containers are the combination, plus a filesystem image. Both have specific and frequently-underestimated latency consequences.

**Namespaces:** `mnt`, `pid`, `net`, `ipc`, `uts`, `user`, `cgroup`, `time` (5.6+, virtualizes `CLOCK_MONOTONIC`/`BOOTTIME` offsets — notably **not** `CLOCK_REALTIME`).

The latency-relevant one is `net`. A container in its own network namespace reaches the host through a `veth` pair plus a bridge — **adding 10–50 µs and a full extra pass through the network stack per packet**, plus additional softirq work. For a trading container the answer is `--network host` (share the host namespace entirely), or SR-IOV / macvlan to give the container a real NIC function, or a passed-through device for kernel bypass. Running a feed handler behind `veth` and then wondering about latency is a recognizable mistake.

**cgroup v2 controllers and their hazards:**

| Controller | Knob | Latency hazard |
|---|---|---|
| `cpu` | `cpu.max = "50000 100000"` (50 ms per 100 ms) | **CFS bandwidth throttling**: exhaust the quota and every thread is stopped until the period ends — **up to 100 ms of dead time**. The classic Kubernetes latency bug |
| `cpu` | `cpu.weight` | Relative share only; safe |
| `cpuset` | `cpuset.cpus`, `cpuset.mems`, `cpuset.cpus.partition=isolated` | The *right* way to pin; `cpuset.mems` also constrains NUMA allocation |
| `memory` | `memory.max`, `memory.high` | Hitting `memory.high` throttles the allocator with a **sleep**; hitting `memory.max` triggers reclaim or OOM |
| `io` | `io.max` | Blocks I/O submission — fine for journals, fatal if on a hot path |
| `pids`, `hugetlb`, `rdma` | | |

**CFS quota throttling deserves emphasis** because it is so commonly encountered and so poorly understood. With `cpu.max` set, the cgroup's threads share a quota refilled each period. A multi-threaded process can exhaust a 4-core quota in 25 ms of wall time using 16 threads, then be **frozen for 75 ms**. The signature is unambiguous:

```bash
$ cat /sys/fs/cgroup/<path>/cpu.stat
nr_periods 12000
nr_throttled 3400          ← nonzero means you ARE being throttled
throttled_usec 89000000    ← 89 seconds of enforced stoppage
```

The remedies are to remove the quota entirely for latency-critical workloads (use `cpuset` pinning and `cpu.weight` instead), or to raise it well above the true need. `cpu.max` on a trading container is essentially always wrong.

**Other container gotchas worth naming:** `cpuset.cpus` interacts with `isolcpus` — systemd creates `system.slice`/`user.slice` with cpuset masks that can silently re-admit tasks to isolated cores, so set `CPUAffinity=` in `/etc/systemd/system.conf` to confine everything systemd starts; seccomp filters add a BPF program evaluation to **every syscall** (~50–100 ns, and it defeats some `io_uring` configurations); AppArmor/SELinux add LSM hook costs on the I/O path; and the default container `RLIMIT_NOFILE` and `RLIMIT_MEMLOCK` are usually too small for huge pages and registered buffers.

**The workable conclusion:** containers are fine for packaging and deployment of low-latency software, provided you use host networking, `cpuset` rather than `cpu.max`, no memory limit that can trigger reclaim, `IPC_LOCK` capability for `mlockall` and huge pages, and verification that the isolation you configured at boot survives whatever the orchestrator did afterwards.

---

## 35.21 eBPF, ftrace, and bpftrace

The Linux tracing stack, in order of increasing capability, with the essential distinction: **all of these aggregate in the kernel**, which is why their overhead is 1–10% rather than strace's 100–500× (Ch. 34 §34.6).

**Event sources**, which is the vocabulary to have:

| Source | What it instruments | Cost | Stability |
|---|---|---|---|
| **Tracepoints** | Static, maintained instrumentation points in the kernel (`/sys/kernel/tracing/events/`) | **~50–100 ns** each | Stable API |
| **kprobes / kretprobes** | Dynamic breakpoint on any kernel symbol | ~1 µs (int3) or ~100 ns (optimized jmp) | Unstable — symbol-dependent |
| **fentry/fexit (BPF trampolines)** | Modern kprobe replacement using the ftrace `__fentry__` hook | **~30–50 ns** | Preferred where available |
| **uprobes / USDT** | User-space functions; USDT are static markers | ~1–2 µs (a trap into the kernel) | uprobes unstable, USDT stable |
| **perf events / PMU** | Hardware counters, sampling | Depends on frequency | Stable |

**ftrace** — built into the kernel, no compiler, no dependencies:

```bash
cd /sys/kernel/tracing
echo function_graph > current_tracer         # call graph WITH per-function durations
echo 'tcp_*' > set_ftrace_filter
echo 1 > tracing_on;  cat trace_pipe
# The killer feature for tuning:
echo wakeup_rt > current_tracer              # traces the MAXIMUM RT wakeup latency and
                                             # shows the full call path that caused it
echo preemptirqsoff > current_tracer         # longest interrupts/preemption-disabled region
```

`trace-cmd` is the usable front end. The `preemptirqsoff` and `wakeup_rt` tracers are the tools that actually *explain* a cyclictest outlier — they tell you which kernel code path held preemption off for 300 µs, which no amount of sysctl guessing will.

**eBPF** runs a verified, JIT-compiled program in kernel context at an attach point, with maps for aggregation. **bpftrace** is the awk-like front end and the right default for exploration:

```bash
# Syscall latency histogram for one process — the shape, not just the mean
bpftrace -e 'tracepoint:raw_syscalls:sys_enter /pid==$1/ { @t[tid]=nsecs; }
             tracepoint:raw_syscalls:sys_exit  /@t[tid]/  { @us=hist((nsecs-@t[tid])/1000);
                                                            delete(@t[tid]); }'

# WHO is stealing my isolated core? (the single most useful jitter query)
bpftrace -e 'tracepoint:sched:sched_switch /args->prev_pid && cpu==8/
             { @[args->prev_comm, args->next_comm] = count(); }'

# Off-CPU time: where does the thread actually block, with a kernel stack?
bpftrace -e 'kprobe:finish_task_switch { @[kstack] = count(); }'

# Run-queue latency: how long between "runnable" and "running"
/usr/share/bcc/tools/runqlat -p PID

# Hard IRQ durations by handler
bpftrace -e 'tracepoint:irq:irq_handler_entry { @s[cpu]=nsecs; }
             tracepoint:irq:irq_handler_exit /@s[cpu]/ { @[str(args->name)]=hist(nsecs-@s[cpu]); }'
```

**The BCC toolkit** provides ready-made versions of the important ones and they are worth naming individually: `runqlat` (scheduler queueing latency), `offcputime` (blocked-time flame graphs), `hardirqs`/`softirqs` (interrupt time by source), `biolatency` (block I/O latency histogram), `cachestat`, `tcpretrans`, `execsnoop`, and `funclatency`.

**Overhead and limits.** A tracepoint plus a map update is 50–100 ns; a uprobe is ~1–2 µs and therefore too expensive to leave on a hot function in production. The verifier bounds loops and memory access, so programs terminate. `perf` sampling has **skid** — the recorded instruction pointer is not exactly the one that caused the event — which PEBS/IBS mitigate (Ch. 43 §43.19).

**The methodology point that ties this chapter together:** when latency is bad, the sequence is (1) `cyclictest`/`oslat` to establish whether the *box* is clean, (2) `turbostat` and the C-state usage counters plus `MSR_SMI_COUNT` to rule out power management and SMM, (3) `/proc/interrupts` and `/proc/softirqs` to find interference on your cores, (4) `bpftrace` on `sched:sched_switch` to identify *by name* what preempted you, and (5) `ftrace`'s `preemptirqsoff`/`wakeup_rt` to get the causal kernel path. Being able to state that ordered procedure is worth more in an interview than any individual command.

---

## 35.22 PCIe Topology for Device Locality

On a multi-socket server, every PCIe device — NIC, NVMe, FPGA — is physically attached to **one** socket's root complex. Traffic to or from a device on the other socket crosses the inter-socket interconnect (UPI/Infinity Fabric), and everything about that is worse.

```
  ┌────────── Socket 0 ──────────┐        UPI        ┌────────── Socket 1 ──────────┐
  │ cores 0-19   L3   IMC  DRAM0 │◀════════════════▶│ cores 20-39  L3  IMC  DRAM1  │
  │        Root Complex          │                   │        Root Complex          │
  │           │                  │                   │            │                 │
  │        [ NIC ]  ← node 0     │                   │        [ NVMe ] ← node 1     │
  └──────────────────────────────┘                   └──────────────────────────────┘

  A thread on socket 1 reading from the NIC pays: DMA writes into node-0 memory
  (or node-0 L3 via DDIO), then every access crosses UPI.  +100-200 ns per access,
  +0.5-2 µs on a full packet path, plus contention with all other UPI traffic.
```

**Discovering the topology** — the commands to have memorized:

```bash
cat /sys/class/net/eth0/device/numa_node       # which node owns the NIC (-1 = unknown/single)
lspci -vv -s 65:00.0 | grep -i 'LnkCap\|LnkSta\|NUMA'
lstopo-no-graphics                             # hwloc: the full picture — cores, caches,
                                               # NUMA nodes, and PCIe devices in one diagram
lspci -tv                                      # tree: which root port, which switch
numactl --hardware                             # node distances matrix
cat /sys/class/net/eth0/device/local_cpulist   # which CPUs are local to this NIC
```

`lstopo` is the tool to name; it renders exactly the diagram above for the actual machine.

**The placement rules that follow:**

1. **Pin the application thread to a core on the NIC's NUMA node.** Use `local_cpulist`, not guesswork.
2. **Pin the NIC's IRQs to that node** (§35.14).
3. **Allocate packet buffers, rings, and the order book on that node** — `numactl --membind`, or rely on first-touch from the correctly-pinned thread (Ch. 29 §29.18).
4. **In a dual-NIC redundant-feed setup, either put both NICs on the same socket, or run two complete instances, one per socket** — never let one process straddle.
5. **Check the PCIe link itself.** `LnkSta` showing x4 when `LnkCap` says x8, or Gen3 when the card is Gen4, means the card is in the wrong slot or the slot is bifurcated. That halves your bandwidth and is a surprisingly common physical-installation error.

**PCIe latency components, so the numbers are derivable:** a PCIe round trip (a device register read from the CPU, an **MMIO read**) costs **1–2 µs** because it is a non-posted transaction requiring a completion — which is why you never poll a NIC register on a hot path and why doorbell *writes* (posted, fire-and-forget, ~100–200 ns) are the mechanism poll-mode drivers use. A DMA write from the device to host memory is posted and does not stall the device. Per-hop switch latency adds ~100–150 ns each way, so a NIC behind a PCIe switch behind a root port is measurably worse than one directly attached.

**Intel DDIO** (Data Direct I/O, Ch. 29 §29.24) is the reason the locality argument is even stronger than the DRAM latency numbers suggest: on server parts, inbound DMA writes land **directly in the L3 of the local socket**, not in DRAM. A local core then reads the packet at L3 latency (~40 ns) instead of DRAM latency (~80 ns) — but a *remote* core must pull the line across UPI, converting a 40 ns hit into a 150–300 ns cross-socket transfer and burning interconnect bandwidth. DDIO makes correct socket placement worth more, not less. (Its downside, worth mentioning: DDIO writes evict application data from a limited number of L3 ways, so a high packet rate can thrash the L3 — tunable on some parts via the IIO LLC ways MSR.)

**The related knobs:** `pcie_aspm=off` (§35.16) removes PCIe Active State Power Management, whose L0s/L1 link states cost microseconds to exit — a genuine and frequently-missed latency source on an idle link; `iommu=pt` puts the IOMMU in passthrough so DMA does not pay per-transfer translation (Ch. 29 §29.23); MSI-X ensures each queue gets its own interrupt vector routable to its own core; and Max Payload Size / Max Read Request Size in the PCIe config affect large-transfer efficiency but not small-packet latency.

---

## Key Interview Questions

1. **Your `clock_gettime` calls became 10× slower with no deploy. What happened?** — The kernel demoted the clocksource from `tsc` to `hpet` (watchdog detected skew, usually SMIs or C-state effects), so the vDSO fast path is gone and every call is a syscall reading a shared MMIO register. Check `current_clocksource` and `dmesg`.
2. **What is invariant TSC and why do you need it?** — `nonstop_tsc`: the counter runs at a fixed rate independent of P-states and keeps counting through C-states, so `rdtsc` is a valid clock. Without it the counter's meaning changes when the CPU throttles or sleeps.
3. **`rdtsc` vs `rdtscp` vs `lfence`?** — `rdtsc` is not serializing and can be reordered, giving measurements that are too small. `rdtscp` waits for prior instructions to retire and returns the CPU id in `IA32_TSC_AUX`, but does not stop later instructions — so you still need a trailing `lfence`.
4. **Can you compare TSC timestamps taken on different cores?** — Within a socket on modern parts, generally yes (tens of ns skew, and `IA32_TSC_ADJUST` corrects offsets). Across sockets, skew of 100 ns to µs is realistic; the signature of getting it wrong is a negative measured latency.
5. **Which clock for measuring a duration, and why?** — `CLOCK_MONOTONIC`/`steady_clock`. `CLOCK_REALTIME` steps on NTP corrections and leap seconds, producing negative or hours-long intervals. Never `high_resolution_clock` — it is an implementation-defined alias, often to `system_clock`.
6. **MONOTONIC vs MONOTONIC_RAW?** — `MONOTONIC` is NTP rate-disciplined and tracks true SI seconds; `MONOTONIC_RAW` is the undisciplined hardware rate, correct only for characterizing the oscillator (e.g. TSC calibration).
7. **Why does a `nanosleep(1ms)` loop not run at 1 kHz?** — Each iteration sleeps *at least* the interval plus wakeup latency plus the work, and the error accumulates. Use `clock_nanosleep(TIMER_ABSTIME)` with deadlines computed from the schedule, not from the wake time.
8. **What is `timer_slack` and when does it bite?** — A default 50 µs coalescing window added to every timer for non-RT tasks. It is invisible and it is added to all your timeouts; RT policies get zero slack.
9. **Why does Linux have both a timer wheel and hrtimers?** — Most kernel timers (TCP retransmit) are cancelled before firing, so O(1) insert/cancel with poor resolution is the right trade; timers that must fire on time go to the O(log n) hrtimer red-black tree with nanosecond precision.
10. **Why can NTP not meet MiFID II's 100 µs requirement?** — Software timestamping subject to interrupt and scheduler jitter, plus an offset formula that assumes symmetric paths. Practical accuracy is 100 µs–1 ms on a LAN. PTP with hardware timestamping gives sub-microsecond.
11. **What makes PTP accurate?** — PHY-level hardware timestamping (removing all software jitter) and transparent clocks that subtract switch residence time (removing path asymmetry). Without PTP-aware switches, PTP degrades toward NTP accuracy.
12. **You run `ptp4l` and your application timestamps are still wrong. Why?** — `ptp4l` disciplines the NIC's PHC, not the system clock. You also need `phc2sys` to bridge PHC → `CLOCK_REALTIME`.
13. **Step vs slew, and which clocks are affected?** — A step is a discontinuity in `CLOCK_REALTIME` (monotonic is untouched); a slew changes the *rate*, affecting both REALTIME and MONOTONIC but not MONOTONIC_RAW. Slew rate is bounded (~500 ppm), which is why large errors are stepped.
14. **How should a trading system handle leap seconds?** — Timestamp internally in `CLOCK_MONOTONIC` or `CLOCK_TAI`, order events by sequence number, and convert to UTC only for display. Smearing is the operational alternative but must be consistent fleet-wide.
15. **Why does `pthread_cond_timedwait` sometimes hang for an hour?** — It uses an absolute `CLOCK_REALTIME` deadline by default; a backwards clock step extends the wait. Set `pthread_condattr_setclock(CLOCK_MONOTONIC)`.
16. **Why is the `performance` governor mandatory?** — Reactive governors ramp frequency only after observing load, so the first messages after an idle gap run at a fraction of full speed — a bimodal latency distribution correlated with idle time.
17. **Turbo on or off for a trading box?** — Enabled in production for the single-thread gain, with cores isolated and the box kept cool so it is stable; disabled for benchmarking so A/B comparisons are reproducible.
18. **Why does `rdtsc`-derived "cycles" disagree with `perf`'s cycle count?** — The TSC ticks at the invariant base frequency; `perf cycles` counts actual core clocks. Under turbo you execute more real cycles than TSC ticks suggest.
19. **Difference between C-states and P-states, and which matters more?** — P-states are the frequency while running; C-states are idle depth. C-states matter more for latency: a C6 exit costs 50–150 µs, dwarfing an entire tick-to-trade budget.
20. **Give four independent reasons busy-polling reduces latency.** — No sleep/wakeup path, no C-state exit, no frequency ramp-up, and warm L1/L2/TLB/branch predictors.
21. **Why must `irqbalance` be disabled or constrained?** — It relocates IRQs at runtime, including onto isolated cores, changing your latency minutes after boot with no deploy. `isolcpus` alone does not stop it; use `irqaffinity=` at boot.
22. **Where should a NIC's IRQ be pinned?** — On a housekeeping core on the NIC's own NUMA node, ideally sharing L3 with the consuming thread; never on an isolated application core.
23. **What is `ksoftirqd` and what does it mean when it is busy?** — The per-CPU fallback thread for softirq work that exceeded its budget. Busy `ksoftirqd/N` means CPU N is saturated with (usually network) bottom-half processing and its latency is now unpredictable.
24. **What does `nohz_full` do and when does it silently stop working?** — It disables the periodic scheduler tick on a CPU running exactly one task. A second runnable task on that CPU brings the tick back with no diagnostic; verify with local-timer interrupt counts in `/proc/interrupts`.
25. **What does PREEMPT_RT change, and would you use it for HFT?** — Sleeping spinlocks, threaded IRQs, kernel-wide priority inheritance, threaded softirqs. It reduces the worst case and increases the mean and reduces throughput 5–15%. HFT usually declines it, because a busy-polling thread on an isolated core is never in the kernel to be preempted.
26. **Why must you set `kernel.sched_rt_runtime_us = -1`?** — Otherwise RT tasks are throttled to 95% of each second, so a busy-spinning `SCHED_FIFO` thread stalls for 50 ms every second.
27. **What does cyclictest measure, and what does it not?** — Timer-wakeup latency: interrupt, softirq, scheduler wakeup, context switch, C-state exit. It does not measure a busy-polling thread's jitter; use it as a box qualification test, plus `oslat` and `hwlatdetect`.
28. **Why disable transparent huge pages while still wanting huge pages?** — THP can trigger synchronous compaction on your critical path (hundreds of ms) and `khugepaged` collapse with TLB-shootdown IPIs. Reserve explicit huge pages at boot instead: same TLB benefit, no variance. `compact_stall` in `/proc/vmstat` is the diagnostic.
29. **Why is `cpu.max` on a container a latency bug?** — CFS bandwidth throttling freezes every thread in the cgroup until the period ends — up to 100 ms. Check `nr_throttled` in `cpu.stat`; use `cpuset` pinning and `cpu.weight` instead.
30. **Why does a container's network namespace hurt?** — `veth` plus a bridge adds a full extra pass through the network stack, 10–50 µs per packet. Use host networking or SR-IOV.
31. **Why is `bpftrace` usable in production when `strace` is not?** — eBPF aggregates in the kernel (a map update, ~50–100 ns per event) with no per-event user-space wakeup; `strace` stops the process twice per syscall via ptrace.
32. **How do you find out what preempted your isolated thread?** — `bpftrace` on `tracepoint:sched:sched_switch` filtered to that CPU gives you the offender by name; `ftrace`'s `preemptirqsoff` and `wakeup_rt` tracers give the causal kernel path for an outlier.
33. **Why does PCIe device locality matter more because of DDIO, not less?** — Inbound DMA lands in the local socket's L3, so a local core reads at ~40 ns; a remote core must pull the line across UPI, turning that into a 150–300 ns transfer plus interconnect contention.
34. **You have unexplained microsecond-to-millisecond stalls invisible to `perf`. What are they?** — SMIs: firmware traps into SMM and freezes all cores, opaque to the OS. Confirm with `MSR_SMI_COUNT` (0x34) or `turbostat`'s SMI column and `hwlatdetect`; fix in BIOS.

---

## Common Traps

- **Measuring elapsed time with `CLOCK_REALTIME` / `system_clock`** — NTP steps produce negative or absurd durations.
- **Using `std::chrono::high_resolution_clock`** — an implementation-defined alias, often to the stepping clock.
- **Assuming the clocksource is `tsc`** — a silent demotion to HPET makes every timestamp a syscall on a contended shared device.
- **Setting `tsc=reliable` without verifying `nonstop_tsc`** — silently corrupts all timestamps if the TSC really is unstable.
- **Comparing `rdtsc` values across sockets** — skew produces negative latencies.
- **`rdtsc` without fencing** — reordered out of the measured region; results too small.
- **Treating `rdtsc` deltas as core cycles** — the TSC ticks at the invariant base rate, not the turbo frequency.
- **Calling `clock_gettime` on a PHC (`/dev/ptp0`) in a hot path** — 1–5 µs, it is a PCIe MMIO read.
- **Running `ptp4l` without `phc2sys`** — perfect packet timestamps, freely drifting system clock.
- **Deploying PTP without transparent or boundary clocks** — switch queueing reintroduces the asymmetry PTP exists to remove.
- **`pthread_cond_timedwait` / `wait_until(system_clock)` without a monotonic condattr** — a backwards step hangs the wait.
- **Relative periodic timers (`nanosleep` loops, relative `timerfd`)** — unbounded drift; use absolute deadlines.
- **Leaving `timer_slack` at its 50 µs default** on a latency-sensitive non-RT thread.
- **Leaving the default `powersave`/`schedutil` governor** — the first message after idle runs at a fraction of full speed.
- **Benchmarking with turbo enabled** — thermal state, not your change, determines the result.
- **Leaving deep C-states enabled** — 50–150 µs added to the first packet after an idle gap; the single most common "production is 100× the benchmark" cause.
- **`idle=poll` on every core** — heat reduces turbo headroom and can lower peak frequency.
- **Leaving `irqbalance` running** — it moves IRQs onto isolated cores minutes after boot.
- **Believing `isolcpus` stops interrupts, kernel threads, or irqbalance** — it does not; you need `irqaffinity=`, `nohz_full`, `rcu_nocbs`, and workqueue masks too.
- **`nohz_full` with two runnable tasks on the core** — the tick silently returns; verify with local-timer counts.
- **`nohz_full` without `rcu_nocbs`** — RCU callbacks reintroduce periodic work.
- **`SCHED_FIFO` busy-spin without `sched_rt_runtime_us = -1`** — throttled 50 ms out of every second.
- **Removing the RT throttle without a watchdog** — a runaway RT thread wedges the core or the box.
- **RT priority without `mlockall`** — a page fault injects milliseconds into a "real-time" path.
- **NIC IRQ on a different NUMA node from the consuming thread** — cross-interconnect packet data on every message.
- **A PCIe card in a bifurcated or wrong-generation slot** — check `LnkSta` against `LnkCap`.
- **Leaving `pcie_aspm` enabled** — microsecond link-state exit latency on an idle NIC.
- **THP set to `always`** — synchronous compaction stalls on the critical path; watch `compact_stall`.
- **`cpu.max` (CFS quota) on a latency-critical container** — up to 100 ms of enforced freeze; check `nr_throttled`.
- **Container `veth` networking for market data** — 10–50 µs and an extra stack traversal.
- **Trusting `cyclictest` as your application's latency** — it measures the sleep/wake path, which a busy-poller never takes.
- **Running `cyclictest` on an idle box, or for five minutes** — the tail is the point; run it for a day, under load.
- **Ignoring SMIs** — invisible to `perf`, freeze all cores, only fixable in BIOS.
- **Tuning without verifying** — every knob can silently no-op; end with measurements from `/proc/interrupts`, `/proc/softirqs`, C-state usage, `turbostat`, and `cyclictest`.

---

## Compact Recall Summary

**Clocksources.** `tsc` (~5–8 ns, vDSO-capable), `hpet` (~250 ns–1 µs, shared MMIO, contended), `acpi_pm` (worse). Only `tsc` supports the vDSO fast path, so a watchdog demotion turns every `clock_gettime` from a 20 ns computation into a 250 ns syscall. Check `current_clocksource` first, always.

**Clock IDs.** `CLOCK_MONOTONIC` for every duration (never `REALTIME`); `MONOTONIC_RAW` only for calibrating the oscillator; `COARSE` variants (~5 ns, ms granularity) for logging; `TAI` for a leap-second-free internal timebase. `steady_clock` = MONOTONIC, `system_clock` = REALTIME, `high_resolution_clock` = don't.

**TSC.** Need `constant_tsc` + `nonstop_tsc` (invariant). Per-core counters can skew: tens of ns within a socket, 100 ns–µs across sockets, corrected where `IA32_TSC_ADJUST` exists. Fence around `rdtsc`; `rdtscp` retires prior work and returns the CPU id but still needs a trailing `lfence`. TSC ticks at the base rate, so cycle counts under turbo are misleading. VMs may trap or offset it.

**Timers.** hrtimers in a per-CPU RB-tree programmed into the APIC TSC-deadline timer; legacy `timer_list` uses an O(1) hierarchical wheel because most kernel timers are cancelled before firing. Achieved wakeup jitter: 50–500 µs untuned, 2–20 µs tuned, ~10 µs floor for anything sleep-based, <100 ns for a TSC spin. Use absolute deadlines (`clock_nanosleep(TIMER_ABSTIME)`, `TFD_TIMER_ABSTIME`) to avoid drift; zero the 50 µs `timer_slack`.

**NTP vs PTP.** Same offset algebra; the difference is timestamp placement and path symmetry. NTP: software timestamps, 100 µs–1 ms on a LAN, chrony over ntpd, `chronyc tracking` for diagnosis. PTP: PHY hardware timestamps plus transparent clocks subtracting switch residence, <100 ns achievable, BMCA for hierarchy, `ptp4l` + **`phc2sys`** (forgetting the second is the classic error), `ethtool -T` to verify hardware support. PHC reads cost 1–5 µs (PCIe); `PTP_SYS_OFFSET_PRECISE`/PTM for atomic cross-timestamping. Hardware receive timestamps are what make one-way latency measurable across machines. MiFID II requires 100 µs for HFT; the achievable budget is ~200 ns–1 µs.

**Steps and slews.** Steps are discontinuities in REALTIME only; slews change the rate of both REALTIME and MONOTONIC but not RAW, bounded at ~500 ppm. Leap seconds repeat 23:59:59 in the kernel default; smear or use TAI. `pthread_cond_timedwait` defaults to REALTIME — set a monotonic condattr.

**Governors and turbo.** `performance` always; reactive governors cost a ramp on the first message after idle. `intel_pstate` exposes only performance/powersave and runs HWP. Turbo bins depend on active core count, temperature, and power; enable in production, disable for benchmarking. Beware AVX-512 licence downclocking, RAPL/thermal throttling, and uncore frequency scaling.

**C-states.** C1 ~1–2 µs exit, C3 ~30–100 µs, C6 ~50–150 µs, package C7+ up to 1 ms — plus cold caches on top. Limit with `intel_idle.max_cstate=1`, per-state `disable` files, or a held-open `/dev/cpu_dma_latency` PM QoS write. Verify with the per-state `usage` counters. Busy-polling avoids C-states, wakeups, frequency ramps, and cold caches simultaneously.

**IRQs and softirqs.** Pin IRQs to a housekeeping core on the NIC's NUMA node, ideally sharing L3 with the consumer; disable or constrain `irqbalance`; set `irqaffinity=` at boot. `rx-usecs 0 rx-frames 1` for latency, at high CPU cost. Softirqs (`NET_RX`) run on whichever CPU took the IRQ, stealing time from whatever ran there; overflow goes to `ksoftirqd/N`, whose CPU usage is the diagnostic. Constrain unbound workqueue cpumasks; `threadirqs` makes interrupt handling schedulable at the cost of a context switch.

**Boot isolation.** `isolcpus` (no scheduler placement) + `nohz_full` (no periodic tick, but only with exactly one runnable task) + `rcu_nocbs` (offload RCU) + `irqaffinity` (keep IRQs off) + `nosmt` + C-state and governor settings + explicit huge pages + `iommu=pt` + `pcie_aspm=off`. Every one can silently fail; verify with local-timer interrupt counts, `/proc/softirqs`, and C-state usage. cgroup v2 `cpuset.cpus.partition=isolated` is the dynamic equivalent.

**PREEMPT_RT.** Sleeping spinlocks, threaded IRQs, kernel-wide PI, threaded softirqs; mainline since 6.12. Bounds the worst case (10s of µs) at 5–15% throughput and a higher mean. Right for hard deadlines; usually declined for HFT, which avoids the kernel entirely instead. `SCHED_FIFO`/`RR`/`DEADLINE` are available on any kernel and require `sched_rt_runtime_us=-1`, `mlockall`, and a watchdog.

**cyclictest.** Measures timer wakeup latency end to end. Run for 24 h, under load, with `-m -p99` and pinning; read the Max and the histogram's secondary modes (50–150 µs = C-states, ms-scale = periodic kernel work). Targets: 20–80 µs tuned stock, <10 µs tuned RT. It does not describe a busy-poller — pair with `oslat` and `hwlatdetect` (the SMI detector).

**THP.** Real TLB benefit, unacceptable variance: synchronous direct compaction on the fault path, `khugepaged` collapse with mm-wide TLB shootdown IPIs, and RSS bloat. Set `transparent_hugepage=never` and reserve explicit huge pages (`hugepagesz=1G`) plus `mlockall` and prefaulting. `compact_stall` in `/proc/vmstat` is the proof.

**Containers.** Namespaces hide, cgroups limit. `veth` costs 10–50 µs — use host networking or SR-IOV. `cpu.max` freezes the whole cgroup for up to 100 ms (`nr_throttled` in `cpu.stat`); use `cpuset` plus `cpu.weight`. Watch `memory.high` throttling, systemd's slice cpusets re-admitting tasks to isolated cores, seccomp's per-syscall cost, and default `RLIMIT_MEMLOCK`.

**Tracing.** Tracepoints ~50–100 ns, fentry/fexit ~30–50 ns, kprobes ~100 ns–1 µs, uprobes ~1–2 µs. eBPF aggregates in-kernel, which is why it is production-safe and `strace` is not. `bpftrace` on `sched:sched_switch` names your preemptor; `runqlat` gives scheduler queueing; `offcputime` gives blocked-time stacks; ftrace's `preemptirqsoff` and `wakeup_rt` give the causal kernel path for an outlier. Methodology: qualify the box (cyclictest/oslat/hwlatdetect) → rule out power management and SMIs (turbostat, C-state usage, `MSR_SMI_COUNT`) → find interference (`/proc/interrupts`, `/proc/softirqs`) → name the offender (bpftrace) → get the causal path (ftrace).

**PCIe topology.** Every device belongs to one socket's root complex. Pin threads, IRQs, and memory to the NIC's node (`local_cpulist`, `lstopo`, `numactl`). MMIO reads are non-posted and cost 1–2 µs; doorbell writes are posted at ~100–200 ns, which is why poll-mode drivers write doorbells and never read registers. DDIO lands inbound DMA in the local L3 (~40 ns for a local core, 150–300 ns cross-socket), making socket placement matter more. Verify `LnkSta` against `LnkCap`, and turn off ASPM.
