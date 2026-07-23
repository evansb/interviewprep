# Chapter 31 — Processes, Threads and Scheduling

## Why this matters

Linux exposes each user thread as a task that the scheduler places and accounts. Everything from `fork` to core isolation becomes a policy decision about what tasks share, when they may run, and what can delay them. For a latency-sensitive service, code execution time is only part of the result: you must also ask what can preempt or block the task, for how long, and how you would know. This chapter ends with the part many treatments skip—verifying that the applied configuration is actually effective.

## 90-second screen — Core

Five facts:

1. Linux schedules tasks. Threads in one process are tasks that deliberately share resources; process and thread are user-space groupings, not two scheduler object types.
2. `R` means *running or runnable*. Run-queue competition is one component of wakeup latency, not the whole interval.
3. A context switch has direct kernel work and workload-dependent after-effects from displaced microarchitectural state. Neither has a universal duration.
4. Fair scheduling targets proportional service over time, not a hard upper bound on runnable waiting.
5. Real-time policies can take precedence over fair-class work, but add starvation, throttling, inversion, and recovery hazards.

Two decisions:

- For each thread in the system: which core, which policy, and whether it polls or blocks — with a stated reason for each.
- For the deployment: which cores are isolated, where the displaced kernel work runs, and what measurement proves the isolation is real.

Latency values belong to Chapter 30. NUMA belongs to Chapter 29; virtual memory, page faults, and locking pages to Chapter 32; IPC and signals to Chapter 33; measurement method to Chapter 43; time sources and the wider host-tuning workflow to Chapter 35.

**Claim labels.** POSIX specifies portable process, pthread, and scheduling interfaces but leaves many policy details implementation-defined. C++23 specifies `std::thread`, synchronization, and atomics without Linux task IDs, affinity, scheduler classes, or futexes. Linux user-space APIs are a kernel ABI; `/proc`, `/sys`, tracepoints, scheduler algorithms, kernel configuration, and internal task fields are Linux/version/configuration behavior. A vendor topology or cache-sharing claim is architecture behavior. Keep those layers separate.

---

## 31.1 Tasks, Sharing, and States — Core

The kernel's unit is `struct task_struct`. It holds pointers to resource structures, and what a task shares determines whether userspace calls it a thread or a process:

```
task_struct
 ├── mm_struct*      → address space          [shared by threads]
 ├── files_struct*   → descriptor table       [shared by threads]
 ├── sighand_struct* → signal handlers        [shared by threads]
 ├── signal_struct*  → process-wide signal state, rlimits  [shared by threads]
 ├── thread_struct   → saved registers, FPU state          [private]
 └── kernel stack    → private; size is architecture- and config-dependent
```

Each task needs a kernel execution stack, but its size and allocation scheme vary with architecture, kernel configuration, and features such as virtually mapped stacks. Do not quote one size as a fact about “Linux.”

At the Linux ABI level, clone-family operations can select which resources a new task shares. The following is **schematic**, not the glibc source or a stable promise that these wrappers make exactly this syscall:

```
fork():            clone-like creation + SIGCHLD           — new process resources
pthread_create():  clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND
                       |CLONE_THREAD|CLONE_SETTLS|..., ...) — thread-group sharing
```

Two consequences follow. There is no separate “thread scheduler”: both kinds of task can be runnable on CPU run queues and each can have affinity and policy attributes. Sharing an address space can reduce some switch work, but the actual cost depends on architecture, address-space tagging, working sets, and mitigations. Containers use namespaces, cgroups, capabilities, and filesystem setup around ordinary tasks; reducing them to one clone flag is misleading.

The naming is genuinely confusing and worth stating once: in a multithreaded Linux process, `getpid()` returns the thread-group ID (TGID), while `gettid()` returns the caller's kernel task ID. `/proc/<tgid>/task/<tid>/` exposes members. Many scheduling APIs select one task when passed a TID, but process-wide tools and library APIs differ; read each interface rather than applying a single PID rule universally.

Choose a process boundary for failure containment, privilege separation, independently replaceable lifecycles, or an explicit IPC contract. Choose threads when direct shared-memory access and a common lifetime are the intended ownership model.

| Decision | Separate processes | Threads in one process |
|---|---|---|
| Address isolation | Hardware-enforced mappings and explicit sharing | Same address space; any thread can corrupt shared state |
| Communication | IPC protocol, handles, copies or shared mappings (Ch. 33) | Ordinary objects plus synchronization |
| Failure | Many faults/signals stay within one process, subject to supervisor design | A fatal process-wide failure normally ends every thread |
| Deployment | Can exec/restart/credential-separate components | One image and process-wide resources |
| Scheduling | Tasks still receive individual policy and affinity | Tasks still receive individual policy and affinity |
| Cost question | Creation, IPC, mappings, and working sets | Stack/TLS, synchronization, and shared-resource contention |

Neither column is “faster” without a workload. The scheduler sees tasks; the software architecture decides which resources and failures should be shared.

### States, and the two that matter

| Code | Meaning |
|---|---|
| `R` | Running **or runnable** — on a run queue |
| `S` | Interruptible sleep — the normal blocked state |
| `D` | Uninterruptible sleep — typically I/O or a kernel lock |
| `T` / `t` | Stopped by a signal / by a debugger |
| `Z` | Terminated, exit status not yet reaped |

**`R` is the trap.** If more tasks are runnable than eligible CPUs can execute, some wait. That queueing delay contributes to the wake-to-run interval in §31.4. Linux load average includes runnable tasks and tasks in uninterruptible sleep, which is why heavy I/O can raise load while CPUs are not saturated.

**`D` is diagnostic evidence.** Signals may remain pending while a task is in an uninterruptible wait; the task normally acts on them only after the wait completes. With sufficient permission, `/proc/<pid>/stack` may show the kernel wait site. Persistent `D` points investigation toward I/O or a kernel wait, not toward scheduler priority.

For latency work the states matter less than the transitions: how long from wakeup to executing, and how often you leave `Running` involuntarily.

---

## 31.2 Context Switches — Core

A context switch replaces the running task on a CPU. Distinguish it from a privilege transition: a syscall can enter and leave the kernel without selecting another task. Either can trigger additional work, and their costs must be taken from a named platform and workload (Chs. 30 and 34).

Conceptually: enter scheduler context, account the outgoing task, choose an eligible task, change architectural execution context, switch address-space state when required, and resume. Exactly which registers are saved eagerly, how translation tags are used, and what mitigations run are architecture/kernel details.

| Cost component | Character |
|---|---|
| Direct scheduler work | Save/select/restore plus accounting and mitigation work |
| Address-space change | Architecture- and tagging-dependent translation effects |
| Extended register state | Depends on ISA, kernel strategy, and state used by the task |
| Cache, TLB, and predictor displacement | Workload-dependent degraded execution after resumption |
| Migration | Different caches and possibly different memory locality (Ch. 29) |

**Voluntary versus involuntary** is the distinction that turns this into a diagnostic:

- *Voluntary*: the task blocked. It had nothing to do.
- *Involuntary*: the scheduler preempted it mid-work. This is the one that costs you.

```bash
$ grep ctxt /proc/<pid>/status          # voluntary_ctxt_switches / nonvoluntary_ctxt_switches
$ perf stat -e context-switches,cpu-migrations -p <pid>
$ perf sched record -- sleep 5 && perf sched latency --sort max
```

For a continuously runnable, dedicated hot-path thread, a growing involuntary-switch count is a useful alarm. It means another schedulable task, policy action, throttle, or explicit control operation displaced it. Interrupt handlers can delay a task without causing a task-to-task context switch, so a zero counter does not prove an undisturbed CPU.

One subtlety: with SMT enabled, your thread does not need to be switched out to be slowed down. The sibling competes for the same private cache and execution ports continuously (Ch. 27), and no context-switch counter will show it.

---

## 31.3 Scheduling Classes — Core

Linux maintains per-CPU scheduling state and balances eligible tasks across topology domains. Internally, mainline kernels consult scheduling classes in an order broadly represented as:

```
stop class      (special stop-machine/CPU control work)
 → deadline class  (SCHED_DEADLINE)
 → real-time class (SCHED_FIFO, SCHED_RR: static priorities 1–99)
 → fair class      (SCHED_OTHER / SCHED_BATCH / SCHED_IDLE)
 → idle class
```

This is an internal Linux ordering, not a POSIX priority scale. Stopper work, interrupts, non-preemptible regions, and firmware activity are outside the simple “my numeric priority is larger” model. The policy and priority of visible per-CPU kernel threads can vary by kernel configuration and real-time patch level; do not memorize a migration-thread priority.

Each runnable task has an eligibility mask. Wake placement chooses an allowed run queue; periodic and idle balancing may migrate eligible tasks across **scheduling domains** that reflect topology. The scheduler weighs load, capacity, locality, and energy using an implementation that changes across kernels and hardware classes. Migration is therefore neither random nor forbidden by “last ran on CPU 4.” Affinity and cpusets constrain the candidate set; isolation can remove CPUs from ordinary balancing; neither stops all kernel execution on those CPUs.

### Fair scheduling

The default policy distributes CPU proportionally to weight, derived from nice value. Two implementations exist in kernels you will meet, and the details are version-gated:

- The classic CFS model tracks weighted virtual runtime and favors tasks that have received less service relative to their weight.
- Mainline Linux began transitioning the fair class to EEVDF in 6.6. EEVDF reasons about lag, eligibility, and virtual deadlines while retaining weighted-fairness goals.

This is explicitly **versioned Linux behavior**. Vendor kernels backport scheduler changes, exposed tunables change, and documentation describes a moving implementation. Record the kernel build and inspect the interfaces it actually exports before using advice for CFS or EEVDF. Nice values remain relative weights; they are not deadlines, fixed percentages, or real-time priorities.

Two mechanisms attached to fair scheduling cause more production tail latency than the policy itself:

- **cgroup CPU bandwidth.** On cgroup v2, `cpu.max` expresses quota and period. Exhausting the group's available runtime delays further service until replenishment. Inspect the documented fields in `cpu.stat`; field names and accounting detail are kernel-version facts. Aggregate host utilization can hide this local throttling.
- **Hierarchical grouping and autogrouping** can make a task's nice change behave differently from a naive global-share calculation.

**The conclusion that matters:** fair scheduling pursues weighted fairness, not a hard wakeup deadline. Runnable competitors, grouping, migration, and throttling can create tails well beyond a task's ordinary slice behavior. That is why policy must follow a stated service objective rather than a nice-value slogan.

### Real-time policies

| Policy | Selection rule |
|---|---|
| `SCHED_FIFO` | The highest-priority runnable task runs until it blocks, yields, or a higher-priority task wakes. No timeslice. |
| `SCHED_RR` | As FIFO, but equal-priority tasks round-robin with a quantum. |
| `SCHED_DEADLINE` | Earliest-deadline-first with admission control: you declare runtime, deadline, and period, and the kernel refuses an unschedulable set. Outranks FIFO and RR. |

```bash
$ chrt -p <tid>                 # query
# Mutation example; requires authority and an operational safety plan:
$ chrt -f 60 ./feed_handler
```

Permissions come from `CAP_SYS_NICE`, `RLIMIT_RTPRIO`, or the service manager's equivalent setting.

**Treat `SCHED_FIFO` as a hazardous operational policy, not a performance flag.** It is the right tool in a narrow case and a reliable way to make a machine unreachable outside it. §31.9 enumerates the failure modes; the two that must be understood before enabling it are:

*Starvation.* A FIFO task that spins without blocking prevents lower-priority tasks eligible only on that CPU from running. If critical recovery or kernel work is affected, the host can become unmanageable. Prerequisites include protected housekeeping capacity, bounded/error-tested task behavior, and out-of-band recovery.

*Runtime limiting.* Linux can reserve part of CPU time for non-real-time work through real-time bandwidth controls such as `sched_rt_period_us` and `sched_rt_runtime_us`. Defaults and cgroup interactions depend on the distribution and configuration. A CPU-bound real-time task that exhausts its permitted runtime can show periodic throttling aligned with replenishment. Disabling a safety limit removes recovery margin and can make the host unmanageable; it requires an explicit starvation analysis, housekeeping capacity, rollback, and out-of-band access.

`SCHED_DEADLINE` declares runtime, deadline, and period and uses admission control. It is not “FIFO but better”: affinity/root-domain constraints, bandwidth enforcement, fork behavior, permissions, and the `sched_setattr` ABI all matter. Use it only when the workload has a defensible reservation model and the deployment can validate admission and overrun behavior.

---

## 31.4 Wakeup Latency — Core

Wakeup latency is the interval from the event that makes a task runnable to that task executing its first user instruction. For any design that blocks, it is the number that sets your tail.

```
event (interrupt, futex wake, timer)
   │  interrupt entry, handler, wake-up path
   ▼
choose a target CPU  ──► may require an inter-processor interrupt
   │
   ▼
enqueue on that CPU's run queue; request rescheduling
   │  delay depends on preemptibility, eligible competitors, policy, and throttling
   ▼
context switch in, then execute with cold caches
```

| Condition | Character of the latency |
|---|---|
| Idle target CPU | Dispatch can begin after wakeup, interrupt, idle-exit, and scheduler work |
| Higher-class wakee eligible | It can request preemption, subject to non-preemptible and interrupt context |
| Fair wakee behind competitors | Delay reflects eligibility, weights, grouping, and current service |
| Throttled cgroup or policy | Runnable does not imply eligible for immediate CPU time |
| Migrated wakee | Add placement and cold-state effects |

Two mechanisms are worth naming. *Wake placement* may trade an idle CPU against locality to the waker and previous CPU; details evolve with the scheduler. Affinity narrows that choice but does not eliminate IRQs, throttling, or kernel activity. *Preemptibility* determines where kernel execution can be displaced. Mainline configurations have included non-preemptible, voluntary, full/dynamic preemption, and PREEMPT_RT variants; available names and semantics are kernel-version/configuration facts.

```bash
$ cyclictest --help                    # select flags for the installed rt-tests version
$ perf sched record -- sleep 5 && perf sched latency --sort max
```

`cyclictest` measures a timer-wakeup workload, not the worst case of every application and not the end-to-end latency of a feed handler. Report kernel build/configuration, CPU and firmware, duration, load, histogram/tail definition, policy, affinity, and clock. Chapter 43 owns the experiment design. The durable conclusion is narrower: blocking adds a scheduler-mediated wake path whose tail must fit the budget; polling removes that path by spending CPU continuously.

---

## 31.5 Affinity and Topology — Core

Affinity is the set of CPUs a task may run on.

```cpp
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <cerrno>
#include <sched.h>
#include <stdexcept>
#include <system_error>

void pin_current_thread(unsigned cpu) {
    if (cpu >= CPU_SETSIZE) throw std::out_of_range("CPU_SETSIZE");
    cpu_set_t set{};
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    // Linux: pid 0 selects the calling task.
    if (sched_setaffinity(0, sizeof set, &set) == -1)
        throw std::system_error(errno, std::generic_category());
}
```

This is a Linux-specific function, not standard C++. Fixed-size `cpu_set_t` is sufficient only within its representable range; GNU dynamic CPU-set macros exist for larger configured CPU spaces. For an existing multithreaded process, applying a task-level affinity interface to one TID does not configure every peer; set policy as each thread starts or enumerate deliberately. Effective affinity is also intersected with online CPUs, cpusets, and other restrictions.

If memory placement matters, establish affinity before the workload initializes its working set, then verify locality using Chapter 29's method. Do not turn “pin before first touch” into a claim that every page remains forever on one node: policy, migration, reclaim, and explicit placement can change it.

Why pin: stable cache locality, controlled topology, fewer task migrations, and a match between an isolated CPU and its intended task. The size of any benefit belongs to measurement.

What pinning costs: the scheduler cannot balance the task outside its mask, a failed or overloaded CPU set has less spare capacity, and static layouts require topology-aware deployment. Placing hot threads on SMT siblings creates workload-dependent contention rather than a universal “half throughput.” An empty intersection with cpuset or online constraints can make affinity fail.

**Logical CPU numbers do not encode portable topology.** Enumeration depends on firmware and kernel discovery; assuming adjacency or a fixed offset can place two hot threads on one physical core.

```bash
$ lscpu -e=CPU,NODE,SOCKET,CORE,MAXMHZ         # inspect discovered topology
$ cat /sys/devices/system/cpu/cpu7/topology/thread_siblings_list
$ cat /sys/devices/system/cpu/cpu7/cache/index3/shared_cpu_list
$ cat /sys/class/net/eth0/device/numa_node
```

The placement rules, each with its reason:

| Rule | Reason |
|---|---|
| Avoid co-locating two independently saturated threads on SMT siblings unless measured | They compete for core resources (Ch. 27) |
| Compare nearby producer/consumer placement with separated placement | Local handoff may benefit from shared cache; competition may offset it |
| Include device locality in the polling-thread placement decision | Device and memory topology can affect the data path (Ch. 29) |
| Allocate buffers from the thread that will consume them, after pinning | First touch |
| On chiplet parts, inspect actual cache-sharing IDs | Product topology cannot be inferred from package marketing |
| Consider keeping boot/default-housekeeping CPUs out of the hot set | Default kernel work often accumulates there; verify on the host |
| Account for every SMT sibling of an isolated CPU | Sibling activity is invisible to task migration counters |

A realistic layout for a two-socket machine with the NIC on node 0:

```
node 0: cpu 0        housekeeping, interrupts, logging      (not isolated)
        cpu 2        feed handler / NIC polling             (isolated)
        cpu 4        book build + strategy                  (isolated)
        cpu 6        order gateway transmit                 (isolated)
        cpu 1,3,5,7  SMT siblings of the above — isolated and left idle
node 1: metrics, journal writer, control plane
```

That layout is illustrative, not a prescription. Leaving siblings idle trades throughput capacity for reduced interference; firmware SMT disable is a different, host-wide rollback decision. Chapter 27 owns the underlying contention.

---

## 31.6 Isolation, Housekeeping, and Polling — Core

### Isolation

Isolation is a collection of controls that reduce selected sources of work on selected CPUs. No single flag makes a CPU silent.

| Mechanism | What it removes |
|---|---|
| `isolcpus=domain,...` | Boot-time scheduler-domain isolation; the kernel documentation discourages it in favor of cpusets for reversible domain control |
| `nohz_full=` | Suppresses eligible scheduling ticks while a suitable single user task runs; constraints apply |
| `rcu_nocbs=` | Offloads RCU callbacks; current `nohz_full` setups may imply this for selected CPUs |
| `irqaffinity=` and per-IRQ affinity | Device interrupt handling |
| cgroup v2 isolated cpuset partition | Runtime partitioning of scheduler load balancing, subject to cgroup rules |
| Firmware SMT disable, or offlining siblings | Sibling interference (Ch. 27 — offlining may be weaker than a firmware disable) |

`nohz_full` is commonly misunderstood. Current kernel documentation describes constraints including a compatible kernel configuration, a stable clock source, a single task in userspace, avoidance of POSIX CPU timers, and limited kernel entry. Accounting and RCU work move elsewhere or become more expensive at kernel boundaries. Treat the exact behavior as versioned Linux behavior and verify rather than assume:

```bash
$ cat /sys/devices/system/cpu/nohz_full
$ cat /sys/devices/system/cpu/isolated
$ cat /proc/cmdline
$ test -d /sys/kernel/tracing/events/sched && echo "sched tracepoints available"
```

Even a well-isolated CPU can receive interrupts, inter-processor calls, exceptions, and firmware activity. Some device interrupts are managed by drivers and expose limited affinity control. Firmware stalls may not appear in ordinary scheduler traces. Use Chapter 35's host-tuning runbook and Chapter 43's layered measurements rather than assigning every unexplained gap to the scheduler.

Other frequently-applied boot settings — disabling deep idle states, fixing the frequency governor, choosing a clock source, disabling speculation mitigations, configuring huge pages — belong to Chapter 35's tuning workflow and Chapter 32's memory policy, and each needs its own hypothesis, cost, and rollback. Copying someone else's kernel command line is the definition of cargo cult.

| Change | Expected benefit | Cost / prerequisite | Rollback and success measure |
|---|---|---|---|
| Narrow a task's affinity | Fewer migrations and known placement | Capacity plan and correct topology | Restore mask; compare migrations and application tail |
| Create an isolated cpuset partition | Less scheduler competition | Reserved CPUs and cgroup-v2 support | Move tasks back/destroy partition; trace runnable competitors |
| Enable full dynticks for a CPU set | Fewer eligible scheduler ticks | Boot/config support and mostly user-space single-task workload | Remove boot setting/reboot; compare timer/scheduler traces |
| Move device IRQs | Remove device-handler interference | Know queue-to-IRQ mapping; some IRQs are managed | Restore masks/irqbalance; compare per-CPU interrupt deltas |
| Offload RCU callbacks | Move callback execution | Housekeeping capacity | Restore boot/config setting; compare RCU and application tails |
| Use real-time policy | Preempt lower classes | Authority, bounded runtime, no unsafe blocking, recovery path | Restore `SCHED_OTHER`; compare wake/switch tail and starvation alarms |

### Housekeeping

The work removed from isolated cores still has to run somewhere. Housekeeping cores should have capacity for the work deliberately directed there: selected device interrupts, offloaded RCU callbacks, unbound kernel work, reclaim and compaction threads, timer callbacks, and the application's logging, metrics, and control plane. Some work remains per-CPU, driver-managed, or otherwise difficult to move, so inventory the actual host rather than assuming complete displacement.

Start with read-only inventory:

```bash
$ systemctl is-active irqbalance
$ cat /sys/devices/virtual/workqueue/cpumask
$ grep -H . /proc/irq/*/smp_affinity_list
$ systemctl show system.slice -p AllowedCPUs
```

Do not mutate every IRQ mask with a shell loop: IRQ numbering changes, some affinities are driver-managed, and moving a storage or control-path IRQ can damage recoverability. Build a queue/IRQ ownership map, change one class at a time through deployment configuration, and retain a housekeeping CPU set large enough for observed interrupt, RCU, workqueue, logging, and control-plane load. There is no portable core count.

### Busy polling versus blocking

| | Blocking | Busy polling |
|---|---|---|
| Response | Includes wakeup latency (§31.4) | Detection at a polling iteration |
| Jitter | Scheduler and idle-state effects enter the distribution | Avoids sleeping, but not IRQ/firmware/interference effects |
| CPU cost | Low while blocked | Up to one logical CPU continuously |
| Power and thermals | Low | High, and it reduces turbo headroom for neighbours |
| Scales to many flows | Yes | No — one core per polled source |
| Cache state on arrival | Cold | **Hot**, which is an underrated second benefit |

Polling can avoid scheduler wakeup and keep some working state warm. The benefit depends on arrival pattern and interference; it is not a guarantee that every access hits nearby cache.

The spectrum between them is pure blocking; adaptive spin-then-park; kernel-side socket polling (Ch. 45); and user-space polling of a device ring (Ch. 47). A spin budget must be derived from the arrival distribution, power/core budget, and measured park/wake distribution—not one universal crossover (Ch. 24).

```cpp
// Schematic only: queue semantics and cancellation are application-specific.
while (!stop_requested && !queue.try_pop(msg))
    cpu_relax();   // target-specific spin-loop hint
```

Use the target's documented spin-loop hint where appropriate; its latency and power effect are microarchitecture-specific (Ch. 27). It does not fix an overloaded design. `sched_yield()` changes scheduler state and has policy-dependent semantics; it is not a short hardware pause.

Prefer blocking for control-plane work, when runnable flows substantially exceed available cores, or when measured wakeup tails fit the budget. Polling a sparse source can waste capacity and thermal headroom, eventually forcing harmful co-scheduling elsewhere.

---

## 31.7 Choosing and Validating a Policy: A Worked Case — Core

The chapter's actual skill. A feed handler must consume market data from one multicast group and hand parsed messages to a strategy thread on the same socket. Decide its scheduling configuration.

**Step 1 — state the requirement as a distribution, not a number.** "p99.9 of handler wake-to-parse under 5 µs, no outlier above 50 µs in a trading session." Without this you cannot tell whether a change helped.

**Step 2 — choose polling or blocking, and say why.** The arrival rate is high and the stated wake-to-parse tail budget is tight. The hypothesis is that the measured blocking wake path consumes too much of that budget, so compare it with polling under a production-shaped arrival trace. Choose polling only if the tail improvement pays for a reserved logical CPU, power, and thermal impact.

**Step 3 — choose the policy.** A polling thread on a core that nothing else can run on does not need a real-time priority to avoid preemption; isolation already provides that. Prefer the *lowest*-privilege configuration that meets the requirement:

- Isolated CPU plus default fair policy: avoids real-time starvation and bandwidth hazards while removing known fair-class competitors, if the isolation is verified.
- Add `SCHED_FIFO` only when the remaining schedulable competition is understood and evidence shows class priority addresses it; then design for §31.9's hazards.

That ordering is the opposite of the folklore ("set FIFO 99 for low latency"), and it is the defensible answer.

**Step 4 — place it.** Use host topology and device locality to choose candidate CPUs, account for SMT siblings, and compare producer/consumer placements. Establish affinity before workload initialization. Chapter 29 owns the NUMA placement and verification details.

**Step 5 — remove hidden blocking.** A polling thread can still enter allocation, synchronous logging, or fault paths. Prove which operations remain on the hot path. Chapter 32 owns any prefault/locking policy and its failure limits; Chapter 59 owns asynchronous logging design.

**Step 6 — verify, and keep verifying.** This is what distinguishes a configuration from a claim:

```bash
$ ps -eLo pid,tid,cls,rtprio,psr,stat,comm
$ taskset -pc <tid>
$ chrt -p <tid>
$ grep ctxt /proc/<tid>/status
$ perf list | grep -E 'context-switches|cpu-migrations'
$ grep -H . /proc/irq/*/smp_affinity_list
```

These commands are read-only inventory. Capture before/after deltas and use scheduler tracepoints to name the displaced and incoming tasks; event availability and tracing syntax depend on the installed kernel and tools. Correlate task switches, IRQ deltas, throttling, and application latency. A nonzero count is a lead, not proof that it caused the tail. Wire stable checks into startup validation (Ch. 60).

---

## 31.8 Wait/Wake and Kernel Contexts — Reference

Skippable on a first pass. User code does not acquire kernel spinlocks directly, but these mechanisms explain why a blocked thread wakes, why a nominally local syscall can be delayed, and why one observation rarely identifies the root cause.

### Futexes, wake queues, and inheritance

A futex is a Linux facility for blocking on a user-space word. A typical mutex fast path uses user-space atomics; it enters the kernel only when it must wait or wake contended peers. The essential wait protocol is:

```
user space: observe contended state
kernel:     atomically compare futex word with expected value
            mismatch → return; user space retries
            match    → enqueue waiter and sleep
waker:      publish user-space state, then wake a bounded number of waiters
```

The compare-before-sleep closes the lost-wakeup race: a state change between the user's first observation and the syscall becomes a mismatch rather than an indefinite sleep. Futex wake does not transfer ownership by itself; the user-space synchronization protocol defines ownership and memory ordering. C++ does not require `std::mutex`, `std::atomic::wait`, or condition variables to use futexes, although Linux standard libraries commonly build blocking slow paths on them.

`FUTEX_REQUEUE` can wake a limited number of tasks and move other waiters to another futex queue. Condition-variable implementations use this kind of mechanism to avoid waking every waiter only to have them contend on one mutex. Waking more tasks than can make progress creates a **thundering herd**: runnable count, context switches, and cache-line contention all rise while useful completion does not.

A priority-inheritance (PI) futex addresses one specific inversion: a high-priority waiter is blocked by a lower-priority owner. The kernel can temporarily propagate priority through the PI-aware lock chain. It does not make critical sections bounded, cure deadlock, or give `std::mutex` portable real-time semantics. POSIX mutex attributes can request `PTHREAD_PRIO_INHERIT` where supported; all participants must use the compatible protocol and error handling.

### Restartable sequences

Linux restartable sequences (`rseq`) register per-thread user-space state with the kernel so a short critical sequence can operate on per-CPU data. If migration, preemption with scheduling, or signal delivery disrupts the sequence, control is redirected to an abort path and user space retries. This can avoid a heavyweight atomic read-modify-write for operations such as updating a per-CPU counter.

`rseq` is a Linux ABI, not a general transaction and not protection against concurrent access on the same CPU. Registration details and newer optimized modes are versioned; libraries may already own the per-thread registration. Prefer a library abstraction unless implementing a runtime or allocator, and test migration and signal abort paths. The official kernel documentation and selftests are the source of truth for the deployed ABI.

### Context determines which synchronization is legal

| Context / primitive | May sleep? | Purpose and trap |
|---|---:|---|
| Hard interrupt context | No | Urgent device handling; defers substantial work |
| Softirq context | No | Deferred networking/timer work; can delay user tasks without a task switch |
| Process context | Usually, subject to current state | Syscalls and kernel threads can block where permitted |
| Raw spinlock / spinlock | No while held | Protect short kernel critical regions; PREEMPT_RT can change ordinary spinlock implementation semantics |
| Kernel mutex / semaphore | Yes | Sleeping mutual exclusion or counting resource |
| Wait queue / completion | Yes for waiter | Event wait/wake patterns; condition must still be checked correctly |
| Sequence counter | Readers retry; writer synchronization external | Fast consistent snapshots; long/preempted writers can starve readers |
| RCU read-side section | Flavor-dependent restrictions | Cheap reads; reclamation waits for a grace period, callbacks run later |

Interrupt, softirq, and process context are execution contexts, not scheduler classes. A packet may be handled partly in interrupt/softirq context and later wake a user task. Moving that task's priority does not automatically move the interrupt work or eliminate backlog. Under load, networking work can also run in per-CPU kernel threads depending on configuration.

RCU offloading moves callback execution; it does not eliminate grace periods or all RCU bookkeeping. A sequence counter provides consistency, not mutual exclusion. A completion represents an event, not ownership. These distinctions matter when a trace names a kernel wait site: diagnose the actual protocol before suggesting a priority change.

For kernel development, establish a global lock order and use lockdep-enabled test kernels to detect circular dependency patterns, invalid context use, and some IRQ-state mistakes. Lockdep is dynamic coverage, not a proof: an unexecuted path remains unchecked, and production kernels may disable it because of overhead. User-space race detection and the C++ memory model remain Chapters 24–26.

---

## 31.9 Real-Time Failure Modes — Role-specific

If you do adopt a real-time policy, these are the failure modes to design against. Each has been a real outage.

1. **Kernel lockout.** A continuously runnable real-time task can starve lower-class work on an eligible CPU. Keep recovery and housekeeping capacity outside the real-time set and retain out-of-band access.
2. **Runtime throttling.** If configured real-time bandwidth is exhausted, service can pause until replenishment. A period-aligned gap suggests this hypothesis; confirm the configured controls and throttle accounting before changing them.
3. **Priority inversion.** A high-priority task blocks on a lock held by a low-priority task that is itself preempted. Priority inheritance (`PTHREAD_PRIO_INHERIT`) and priority-ceiling protocols address defined cases—neither is exposed portably by `std::mutex`. Avoiding cross-class ownership is often simpler, but may require redesign.
4. **Inversion inside the kernel.** Blocking on a kernel resource can reproduce the problem below the API. PREEMPT_RT changes many locking and interrupt-context behaviors, but not every raw/non-preemptible region; use documentation for the exact kernel.
5. **Hidden blocking on a “lock-free” algorithm.** Allocation, synchronous logging, page faults, and container growth can invoke locks, syscalls, or faults even when the application queue is lock-free. Voluntary-switch and syscall/fault traces provide evidence, not a universal zero-switch assertion.
6. **Frequency and idle-state interaction.** Polling, policy, power control, and thermals interact in platform-specific ways. Chapter 35 owns the hypothesis and rollback; do not prescribe a fixed governor here.
7. **Unexpected faults.** A fault can block or invoke substantial kernel work regardless of task priority. Chapter 32 owns locking, prefaulting, limits, and failure policy.
8. **Hostile debugging.** A spinning high-priority thread can make a machine unresponsive to the tools you would use to diagnose it. Develop at a lower priority; raise it only in the production configuration.

---

## 31.10 Threads in Practice: Stacks, Attributes, and Alternatives — Role-specific

**What standard C++ does not expose.** C++23 does not standardize stack size, CPU affinity, Linux scheduling policy, or priority-inheriting mutex attributes. A Linux standard library commonly implements `std::thread` using pthreads and may expose a native handle, but code using it is platform-specific.

```cpp
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <pthread.h>
#include <sched.h>
#include <cstddef>
#include <exception>
#include <stdexcept>
#include <system_error>

using Entry = void* (*)(void*);

pthread_t start_pinned(Entry entry, void* arg,
                       unsigned cpu, std::size_t stack_bytes) {
    if (cpu >= CPU_SETSIZE) throw std::out_of_range("CPU_SETSIZE");

    pthread_attr_t attr{};
    int ec = pthread_attr_init(&attr);
    if (ec) throw std::system_error(ec, std::generic_category());

    cpu_set_t set{};
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if (!(ec = pthread_attr_setstacksize(&attr, stack_bytes)))
        ec = pthread_attr_setaffinity_np(&attr, sizeof set, &set);

    pthread_t tid{};
    if (!ec) ec = pthread_create(&tid, &attr, entry, arg);
    const int destroy_ec = pthread_attr_destroy(&attr);
    if (ec) throw std::system_error(ec, std::generic_category());
    if (destroy_ec) std::terminate(); // initialized attributes should destroy
    return tid; // caller must join or detach
}
```

This uses the GNU `pthread_attr_setaffinity_np` extension. Every pthread function returns its own error number; it does not necessarily report through `errno`. A production wrapper also defines ownership if later setup fails. If policy and priority are set through attributes, `PTHREAD_EXPLICIT_SCHED` is required to use them instead of inheriting the creator's settings. Creating with affinity avoids an initial run on an arbitrary eligible CPU.

**Stacks.** Linux pthread stacks normally use bounded mappings with configurable size and guard region, while the initial thread follows process stack/resource-limit behavior. Pages need not be resident merely because virtual space is reserved. If fault-free steady state is required, Chapter 32 owns the stack-touch, memory-locking, resource-limit, and failure plan.

Guard regions are necessary and not sufficient against jumping over a guard with a large frame. Compiler stack-clash protection adds probing according to target/compiler rules and has a workload-dependent cost. Stack mapping, guard size, residency, and fault behavior belong to Chapter 32.

**Thread-local storage** is reached through per-thread runtime state. ELF TLS models permit different access sequences depending on whether the linker can assume static placement. Forcing a restrictive TLS model may improve a named binary but constrains dynamic loading and is a compiler/linker/ABI decision, not a portable fix. Inspect the generated code before treating TLS as a bottleneck.

**Fibers and coroutines.** A user-space stackful fiber can switch without asking the kernel scheduler, but it is cooperative, a blocking syscall blocks the carrier thread, and tooling must understand the extra stacks. C++20 coroutines are stackless state machines; their frame storage may be dynamically allocated or elided depending on lifetime and compiler proof. Neither has a universal switch cost (Chs. 19–20).

For a hot path, compare explicit state machines, coroutines, fibers, and kernel threads by blocking behavior, ownership, cancellation, frame allocation, observability, and tail measurements. Fibers or coroutines can make many logically waiting flows manageable, but only if carrier-thread blocking and allocation are controlled.

---

## 31.11 Process Lifecycle — Reference

Skippable unless you are writing a supervisor or debugging process management. The latency-relevant conclusions are stated first; the mechanics follow.

**What matters for a latency-sensitive service:** move process launch out of the measured hot interval. `fork` duplicates process metadata and establishes copy-on-write mappings; work scales with the address-space shape and later writes can fault in either parent or child. Chapter 32 owns page-table and copy-on-write mechanics. In a multithreaded process, only the calling thread exists in the child, while inherited library state may reflect locks held by vanished threads. POSIX sharply restricts what the child may safely call before `exec`. `posix_spawn` offers a higher-level launch contract, but its implementation and cost are libc/platform facts—measure if launch latency matters.

The rest, compressed:

- **`exec`** replaces the image while preserving the process ID and specified process attributes. Open descriptors without close-on-exec survive; caught signal dispositions reset, while details such as masks and pending signals follow POSIX/Linux rules. Prefer atomic close-on-exec creation interfaces where available (`O_CLOEXEC`, `SOCK_CLOEXEC`, `accept4`, `pipe2`, `epoll_create1`) because a later `fcntl` can race with concurrent process creation.
- **Reaping.** A terminated task is retained as a zombie until its parent collects the status with a `wait`-family call, or until the parent arranges automatic reaping. Standard signals do not queue, so a `SIGCHLD` handler must loop with `WNOHANG` and must preserve `errno`. An orphan is reparented to the nearest subreaper, which is how supervisors track double-forked daemons.
- **Process groups and sessions** exist for terminal signal delivery: terminal-generated signals go to the foreground process *group*, and losing a controlling terminal sends `SIGHUP`. The classic double-fork daemonization sequence (fork, `setsid`, fork again, chdir, umask, redirect the standard descriptors) exists to permanently foreclose acquiring a controlling terminal.
- **Modern practice inverts that.** Under a service manager, a service should stay in the foreground so the supervisor can track its main process directly, capture its output, apply cgroup limits, and restart it deterministically. Daemonizing under a supervisor breaks process tracking. Knowing both the sequence and why it is obsolete is the complete answer.
- **`clone3` and pidfds.** Linux `clone3` passes a sized argument structure and can request a pidfd for the child. A pidfd is a stable kernel handle that avoids races caused by numeric PID reuse when signaling or polling child state. Feature availability depends on kernel and libc versions; use runtime error handling rather than a version-string guess.
- **NPTL and thread runtime state.** On mainstream glibc/Linux, NPTL implements POSIX threads over Linux tasks. Each user thread also has a user-space stack, thread-control block, TLS state, cancellation state, and library bookkeeping. Those are implementation/ABI details above `task_struct`.
- **Kernel threads** often appear with bracketed names in `ps`, but display convention is not an ABI. Workers, RCU callback threads, migration/control threads, reclaim, and threaded interrupt handlers can compete with application tasks. Their policy, affinity, and movability depend on function, kernel configuration, and driver; inventory before changing them (§31.6).

---

## 31.12 Deployment Verification Runbook — Reference

Skippable until operating a Linux host. Run this read-only sequence before and after a scheduling change; adapt paths and events to the deployed kernel.

1. **Freeze identity.** Record `uname -a`, `/proc/cmdline`, CPU/firmware identity, cgroup mode, service-manager unit, and relevant package versions. Vendor kernels can backport EEVDF, PREEMPT_RT, and isolation work, so a release number alone is insufficient.
2. **Map topology and eligibility.** Save `lscpu -e=CPU,NODE,SOCKET,CORE,ONLINE` and the topology `*_siblings_list` files. For each TID, record `taskset -pc`, `chrt -p`, cgroup membership, and effective cpuset. Confirm that the intended mask is nonempty and contains the CPU actually reported by `ps`.
3. **Inventory competing work.** List tasks by last CPU, class, state, and priority. Snapshot `/proc/interrupts`, per-IRQ affinity, workqueue masks, full-dynticks/isolated CPU lists, and SMT sibling activity. Do not infer “quiet” from task affinity alone.
4. **Check throttles and transitions.** Read the applicable cgroup `cpu.max` and `cpu.stat`, kernel real-time bandwidth controls, and per-task voluntary/nonvoluntary switch counters. Take deltas over the same interval as the application latency histogram.
5. **Trace the tail.** Trigger on an application-latency outlier and collect the minimum evidence needed: scheduler switch/wakeup tracepoints, IRQ/softirq activity, throttling, and application phase markers. Chapter 43 owns warm-up, controls, clocks, distributions, and causal experiment design.
6. **Change one mechanism.** State benefit, cost, prerequisite, rollback, and success metric before changing affinity, cpusets, IRQ routing, tick isolation, RCU offload, polling, or scheduling class. Keep the previous boot entry/unit configuration and a recovery CPU path.

The current official references are the kernel's [CPU isolation guide](https://docs.kernel.org/admin-guide/cpu-isolation.html), [EEVDF description](https://docs.kernel.org/scheduler/sched-eevdf.html), [PI-futex documentation](https://docs.kernel.org/locking/pi-futex.html), and [restartable-sequences ABI guide](https://docs.kernel.org/userspace-api/rseq.html). “Current” matters: archive the documentation matching the deployed build where operations depend on details.

---

## 31.13 Recall and Practice — Core

### Recall card

1. Linux schedules tasks; threads in one process are tasks sharing selected resources such as the address space and descriptor table. They are not a second scheduler object type.
2. `R` means running or runnable. Wakeup latency also includes event handling, placement, preemptibility, policy eligibility, and switch-in work.
3. Context-switch cost has direct kernel work and workload-dependent after-effects. Interrupt delay need not increment the context-switch counter.
4. Fair scheduling targets weighted service, not bounded waiting. cgroup CPU bandwidth can throttle a group even when host utilization looks low.
5. Numeric real-time priority does not outrank interrupts, non-preemptible regions, stopper work, firmware, or higher scheduler classes.
6. Period-aligned stalls suggest bandwidth throttling, but configuration and accounting must confirm the cause.
7. Affinity is a task mask intersected with system constraints. Establish placement before workload initialization, then verify CPU and memory locality separately.
8. Isolation is a bundle: scheduler domains/cpusets, ticks, RCU callbacks, IRQs, workqueues, SMT siblings, and housekeeping must be treated and measured separately.

### Common traps

- Treating a numeric PID as if every API necessarily targets the whole thread group.
- Reading `R` as proof a task was executing rather than eligible to execute.
- Raising priority before identifying the task, IRQ, throttle, or wait that caused delay.
- Applying an isolation boot flag without reserving and observing housekeeping capacity.
- Calling a source-level lock “a futex” or assuming every futex wake transfers mutex ownership.

### Reasoning questions

1. How does Linux represent process threads as tasks, and which resources remain shared or private?
2. Why does a machine with a high load average sometimes show low CPU utilization?
3. Decompose context-switch cost and explain why no component is universally dominant.
4. Why does fair scheduling not provide a hard wakeup deadline?
5. A containerized service shows multi-millisecond p99.9 spikes with CPU utilization under 40%. What do you check first and why?
6. A real-time task shows period-aligned gaps. What evidence would distinguish runtime throttling from an unrelated periodic interrupt?
7. Why can raising a thread to the highest real-time priority fail to prevent preemption?
8. Explain the lost-wakeup race that futex compare-and-sleep prevents, and why waking every waiter can reduce throughput.
9. Under what workload and kernel conditions can `nohz_full` suppress eligible ticks, and how would you verify behavior?
10. You isolated a CPU and still see outliers. Name four remaining mechanisms and one corroborating observation for each.

### Applied exercise

Specify the complete scheduling configuration for a three-thread trading process: a NIC-polling feed handler, a strategy thread, and a journal writer. For each thread, state: core assignment with a topology justification, scheduling policy with a reason for choosing the *least* privileged option that works, blocking versus polling, and memory placement. Then write the validation script — the exact commands and the expected output — that a deployment must run before the process is allowed to take traffic (Ch. 60). Finally, state which single configuration item you would remove first if measurement showed it was not helping, and what measurement would show that.

### Scenario puzzle: the obvious optimization is wrong

A team raises every trading thread to the same high `SCHED_FIFO` priority. The median improves slightly. It then observes replenishment-period-aligned stalls, a host that becomes unreachable when one thread spins, and strategy delays correlated with a journal writer holding a shared mutex. Form and verify three hypotheses: real-time bandwidth throttling, starvation of recovery/control work, and same-priority contention or priority inversion around the lock. Design a lower-privilege configuration using placement and isolation first; state the rollback and success measure for every remaining real-time setting.

### Prerequisites for the next chapter

Chapter 32 assumes you can state why a page fault on a runnable hot path is also a scheduling disturbance (§31.9), and what “establish affinity before workload initialization” means (§31.5). It owns page faults, translation, locking, and huge pages, all of which this chapter deferred.
