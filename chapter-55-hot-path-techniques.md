# Chapter 55 — Hot-Path Techniques

*Interview-focused revision notes. The theme: the hot path is defined by what it is forbidden to do. Every technique here removes one source of unbounded delay — the allocator, the scheduler, the kernel, the branch predictor, the power manager — and each must be justified by a measurement, because a technique that costs jitter to save cycles is a net loss at the tail.*

---

**Terminology.** The **hot path** (or *critical path*) is the code executed between the arrival of the market-data packet that triggers a decision and the departure of the resulting order packet — **tick-to-trade** (Ch. 52 §52.1). Everything else is **warm** (must keep up, not on the decision path: journaling, drop copy, metrics) or **cold** (startup, configuration, recovery). The governing metric is not the mean but the **tail** — p99, p99.9, and the maximum — because a strategy that is fast 99% of the time and 50 μs slow the other 1% loses money precisely on the 1%, which correlates with the busiest moments. The engineering consequence: *predictability beats speed*. A technique that lowers the mean by 20 ns while introducing a once-per-minute 100 μs stall is a regression.

Rough cost model to keep in mind throughout (Ch. 30):

| Operation | Typical cost |
|---|---|
| L1 hit | ~1 ns (4–5 cycles) |
| L2 / L3 hit | ~4 ns / ~15–40 ns |
| DRAM, local / remote NUMA | ~80 ns / ~130 ns |
| Branch mispredict | ~15–20 cycles (~5 ns) |
| `rdtsc` / `rdtscp` | ~7 ns / ~10 ns |
| Uncontended atomic RMW (L1) | ~7–20 ns |
| Contended atomic / cache-line bounce | ~40–100 ns |
| `clock_gettime` via vDSO | ~20–25 ns |
| Minimal syscall (post-Spectre mitigations) | ~250 ns–1 μs |
| `malloc`/`free`, small, fast path | ~15–30 ns; tail unbounded |
| Minor page fault | ~1–3 μs |
| Context switch | ~2–5 μs plus cache/TLB refill |
| Thread wakeup from futex | ~2–10 μs |

---

## 55.1 Hot-Path Preallocation

**Preallocation** means every byte the hot path will ever touch is allocated, faulted in, and warmed before the first message arrives. The goal is not to make allocation fast; it is to make it *absent*, because the allocator's cost distribution has an unbounded tail that no amount of tuning removes.

Why dynamic allocation is disqualified on the critical path, in order of severity:

1. **Tail latency.** `malloc`'s fast path (a thread-cache pop in tcmalloc/jemalloc) is 15–30 ns and perfectly acceptable. Its slow paths are not: refilling a size-class cache from the central heap takes a lock and hundreds of nanoseconds; extending the heap calls `mmap`/`brk` (a syscall, ~1 μs); and the returned pages are unfaulted, so the *first touch* of each 4 KB page is a minor fault (~1–3 μs each). Allocating 1 MB at an unlucky moment costs 256 faults ≈ 300 μs. This is the shape of the problem: p50 fine, p99.99 catastrophic.
2. **Unpredictable locality.** Freshly allocated memory is cold in cache and TLB, and its address is unpredictable, so hardware prefetchers cannot help.
3. **Fragmentation drift.** Long-running processes see the allocator's behaviour change over hours as fragmentation accumulates (Ch. 7 §7.13). A benchmark that runs for 30 seconds never sees this; production does.
4. **Hidden allocations.** `std::string`, `std::function`, `std::vector::push_back` past capacity, `std::shared_ptr` construction, exceptions, `std::map` insertion, and any `std::stringstream` all allocate. Most hot-path allocation bugs are hidden inside an innocent-looking line.

**The discipline.**

```cpp
struct HotState {
    Order            orders[kMaxOrders];        // fixed capacity, one cache line each
    OrderIdx         free_list[kMaxOrders];
    BookLevel        levels[kMaxInstruments][kBookDepth];
    std::byte        tx_buffer[kMaxInstruments][kMaxMsgLen];
    SpscRing<Event, 1<<16> to_journal;          // capacity is a compile-time constant
};
static HotState g_state;   // or one instance per thread, NUMA-local
```

Capacity is a *compile-time constant* wherever possible: it lets the compiler fold bounds arithmetic into mask operations (power-of-two capacities), removes a load of the capacity field from every access, and makes overflow a design question answered at startup rather than a runtime branch.

**Faulting it in.** Allocation is not residency. Reserve, then commit, then touch, then lock:

```cpp
void* p = mmap(nullptr, bytes, PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS|MAP_POPULATE|MAP_HUGETLB, -1, 0);
mlock(p, bytes);                                  // never swapped, never reclaimed
std::memset(p, 0, bytes);                         // first-touch on the OWNING thread (NUMA, Ch.29 §29.18)
```

`MAP_POPULATE` prefaults; `mlock` (or `mlockall(MCL_CURRENT|MCL_FUTURE)`) keeps it resident against memory pressure; the `memset` must run **on the thread that will use the memory**, because Linux's first-touch policy assigns the physical page to the touching thread's NUMA node, and a remote access costs ~50 ns extra forever (Ch. 32 §32.26). Huge pages (Ch. 32 §32.9) reduce TLB pressure: a 1 GB working set needs 262,144 4 KB TLB entries (far beyond the ~1500-entry L2 TLB) but only 512 2 MB entries. Use *explicit* huge pages (`hugetlbfs`/`MAP_HUGETLB`), not transparent ones — THP's `khugepaged` compaction causes multi-millisecond stalls (Ch. 35 §35.18), the classic "our p99.99 has spikes every few minutes" bug.

**Verification, not faith.** Assert the property rather than assuming it:

- Override `operator new` to `abort()` (or increment a counter and log) once the hot phase begins. This is the single most effective test in this chapter, and it belongs in the production build behind a flag, not just in tests.
- `perf stat -e page-faults,minor-faults` on the hot thread: the steady-state count must be **exactly zero**.
- `/proc/self/status`: `VmLck` should equal your locked size; `VmRSS` should be flat.

```cpp
// Hot-phase allocation tripwire.
inline std::atomic<bool> g_hot{false};
void* operator new(size_t n) {
    if (g_hot.load(std::memory_order_relaxed)) __builtin_trap();
    return std::malloc(n) ?: throw std::bad_alloc{};
}
```

**When preallocation is wrong.** If the working set genuinely exceeds memory, or the capacity bound is unknowable, preallocation converts a latency problem into a correctness problem (you drop messages when the fixed buffer fills). The answer is not dynamic allocation but an explicit, measured, alarmed overflow policy (Ch. 52 §52.16) — you decide what to shed, and you count it.

---

## 55.2 Hot-Path Object Pools

An **object pool** is a preallocated array of objects plus a free list, handing out and reclaiming slots in O(1) with no allocator involvement. It is the mechanism by which §55.1's static capacity becomes usable for objects with dynamic lifetimes — orders, in-flight requests, event records.

The minimal correct form for a single-threaded hot path:

```cpp
template <class T, uint32_t N>
class Pool {
    static_assert((N & (N-1)) == 0);
    alignas(64) T        slots_[N];
    uint32_t             free_[N];
    uint32_t             head_ = 0;            // count of free entries
public:
    Pool() noexcept { for (uint32_t i = 0; i < N; ++i) free_[i] = i; head_ = N; }
    [[nodiscard]] T* acquire() noexcept {       // ~2 ns: load, decrement, index
        if (__builtin_expect(head_ == 0, 0)) return nullptr;
        return &slots_[free_[--head_]];
    }
    void release(T* p) noexcept {
        free_[head_++] = uint32_t(p - slots_);  // pointer difference: one shift
    }
    uint32_t index(const T* p) const noexcept { return uint32_t(p - slots_); }
};
```

Design points that distinguish a real implementation:

- **LIFO, not FIFO.** Popping the most recently freed slot returns the one most likely still in L1/L2. A FIFO free list cycles through all N slots and guarantees a cache miss per acquire. The measured difference on a pool larger than L2 is typically 40–80 ns per acquire.
- **Indices, not pointers.** `p - slots_` gives a dense `uint32_t` handle that is half the size of a pointer, is stable across processes for shared memory (Ch. 3 §3.12), and doubles as the correlation-table key (Ch. 54 §54.6). Storing 32-bit handles instead of 64-bit pointers in hot structures is a free halving of the pointer footprint.
- **Do not construct and destruct per use.** For trivially-destructible types (Ch. 3 §3.5), reset the fields you need and skip the rest; the pool's objects are constructed once at startup. If the type is non-trivial, use placement `new` and explicit destruction — but a hot-path pool holding non-trivially-destructible objects is a design smell, because it means the object owns something that itself allocates.
- **Exhaustion is a first-class outcome.** `acquire()` returning `nullptr` must be handled by a policy — reject the order, shed the event, alarm — never by falling back to `new`. A fallback allocator hides the capacity bug until the day it fires under peak load, which is the worst day for it to fire.
- **Padding and false sharing.** If two threads acquire from separate pools, ensure their `head_` fields are on distinct cache lines (Ch. 3 §3.3), or their independent operations serialize at ~100 ns per acquire.

**Multi-producer pools** are usually a design error: they reintroduce an atomic (or a CAS loop with an ABA hazard, Ch. 26 §26.9) into the acquire path. The single-writer architecture (Ch. 52 §52.6) makes per-thread pools the natural answer. Where an object must be produced on one thread and released on another — an event allocated by the feed handler and freed by the journal writer — use a per-thread pool plus an SPSC return ring, so the freeing thread pushes the index back and the owning thread drains it lazily. This keeps both sides free of atomics beyond the ring's single sequence counter.

**Sizing.** Capacity must exceed the maximum simultaneous live objects, which for orders is bounded by venue limits and internal risk limits, and for events by the deepest queue depth the system tolerates. Measure the observed high-water mark continuously and export it; a pool running at 90% of capacity is a production incident waiting for a burst.

---

## 55.3 Busy-Spin Event Loops

A **busy-spin** (or *poll-mode*) loop repeatedly checks for work without ever blocking, trading a fully occupied core for the elimination of wakeup latency. The number that justifies it: blocking on `epoll_wait` and being woken costs **2–10 μs** — kernel wakeup path, scheduler run-queue insertion, IPI to the target core if it is idle, context switch, and then a cold cache and TLB on resume. Spinning costs **0** on the wakeup path; the data is observed in the same instruction stream that will process it.

```cpp
[[noreturn]] void run() noexcept {
    for (;;) {
        if (const Packet* p = nic_.poll())      rx_path(p);       // ef_vi / DPDK: no syscall
        if (const Event*  e = strategy_in_.try_pop()) on_event(e);
        poll_timers(rdtsc());                                     // Ch. 54 §54.2
        // No sleep. No yield. No condition variable.
    }
}
```

The properties that make this correct rather than merely fast:

- **No syscall in steady state** (§55.6). This requires kernel bypass (§55.5) or busy-poll socket options; a spin loop calling `recvfrom()` in a tight loop is *worse* than blocking, because it pays a syscall per iteration and burns the core.
- **Deterministic instruction stream.** The same code runs every iteration whether or not there is work, so the I-cache, branch predictors, and BTB stay warm (§55.4, Ch. 28 §28.11). This is a real and underappreciated benefit: an event handler that runs once every 10 ms starts cold and costs 2–5 μs more than the same code in a warm loop.
- **`_mm_pause()` placement.** Inside a *contention* spin (waiting on another core's write), `PAUSE` (~35 cycles on Skylake+, ~5 on older) reduces memory-order-violation machine clears (Ch. 27 §27.16) and SMT sibling starvation. Inside a *polling* loop against a NIC descriptor or an SPSC ring where the producer is a different core, `PAUSE` adds latency without benefit and is usually omitted. Know which situation you are in.
- **Hyperthreading.** A spinning thread on one SMT sibling steals front-end bandwidth from the other (Ch. 27 §27.17). Either disable SMT on trading cores, or leave the sibling idle and account for it in capacity planning. Running a second latency-sensitive thread on the sibling of a spin loop is a common self-inflicted 20–50% throughput loss.

**The costs, stated honestly** — an interviewer will ask what spinning costs you:

| Cost | Magnitude | Mitigation |
|---|---|---|
| One core fully consumed | 100% of a core, per spinning thread | Capacity planning; core isolation (§55.4) |
| Power and heat | ~10–25 W per core; raises package temperature | Pin frequency (§55.11); adequate cooling |
| Frequency effects | A busy core may keep the package out of deep C-states — which is *desirable* here | Deliberate, see §55.11 |
| No fairness | The thread never yields; anything sharing the core starves | Isolate the core; `SCHED_FIFO` as a backstop |

**Hybrid spin-then-park** (Ch. 24 §24.15) — spin for N iterations, then block — is right for a warm-path thread that is idle most of the time (a journal writer), and wrong for the tick-to-trade path, because the parking transition happens exactly during a quiet market that is about to become busy. Choose per thread, not globally.

**Measurement.** Export loop iteration count and a histogram of *work-to-work* interval. A spin loop whose iteration count collapses is being preempted; a loop whose per-iteration time rises is suffering cache pollution from a co-resident process. Both are visible only if the loop counts itself.

---

## 55.4 Isolated-Core Thread Pinning

Pinning binds a thread to a specific CPU; isolation removes that CPU from everything else. Both are required — pinning alone leaves the kernel free to schedule other work on the same core, and isolation alone leaves your thread free to migrate.

**Why migration is expensive.** Moving a thread to another core loses its entire L1 (32–48 KB) and L2 (0.5–2 MB) working set, and if the move crosses a socket, its L3 and its NUMA locality: subsequent accesses to memory first-touched on the old node cost ~130 ns instead of ~80 ns, permanently (Ch. 29 §29.19). A migration costs 10–50 μs of degraded performance, and the scheduler's load balancer will do it for you at arbitrary times unless prevented.

**The full isolation stack**, in order of importance:

```
# 1. Kernel command line — take the cores away from the scheduler entirely
isolcpus=2-7,10-15  nohz_full=2-7,10-15  rcu_nocbs=2-7,10-15
        │                  │                    │
        │                  │                    └─ RCU callbacks offloaded to housekeeping cores
        │                  └─ tickless: no 1000 Hz timer interrupt on these cores
        └─ excluded from the scheduler's load balancer

# 2. IRQ affinity — move device interrupts off the isolated cores
echo 1 > /proc/irq/<n>/smp_affinity          # housekeeping core only

# 3. Application pinning
pthread_setaffinity_np(...)   or   sched_setaffinity(...)
```

`nohz_full` is the item most often missed. Without it, every isolated core still takes a scheduler tick — 1000 per second on a `CONFIG_HZ=1000` kernel — each costing 1–3 μs of interference including cache pollution. That is a p99.9 contribution you cannot see in a microbenchmark and cannot remove in userspace. `nohz_full` requires at least one housekeeping core to remain ticking, and it only takes effect when exactly one runnable task is on the core — a second thread re-enables the tick, which is another reason not to co-schedule.

**Topology awareness.** `lscpu -e` or `hwloc-ls` first, always. The pairing rules:

- Pin the NIC-facing thread to a core on the **same NUMA node as the NIC's PCIe root complex** (Ch. 29 §29.21). A cross-socket DMA plus a cross-socket read costs 50–100 ns on every packet, and Intel DDIO's cache injection only works into the local socket's L3.
- Pin producer/consumer pairs that share an SPSC ring to cores **sharing an L3** — the hand-off then happens in L3 (~15–40 ns) rather than over the interconnect (~100 ns+).
- Never pin two hot threads to sibling hyperthreads of the same physical core.
- Core numbering is **not** topologically ordered. `cpu0` and `cpu1` may be SMT siblings or may be on different sockets depending on BIOS enumeration. Hardcoding core numbers without reading topology is a common and silent misconfiguration.

**Scheduling policy.** With genuine `isolcpus`, `SCHED_OTHER` is adequate because nothing competes. `SCHED_FIFO` at a moderate priority is a defensible backstop against a stray process landing on the core, but it is dangerous: a `SCHED_FIFO` thread that spins and never yields will block kernel threads that legitimately need that core, and on a misconfigured system it can hang the machine (Ch. 31 §31.21). If you use it, keep priority below the kernel's critical threads and keep `sched_rt_runtime_us` at its default safety valve during development.

**Verification.** `/proc/<pid>/task/<tid>/stat` field 39 gives the last-run CPU; sample it and assert it never changes. `perf stat -e context-switches,cpu-migrations` on the hot thread must read **zero** in steady state — a nonzero migration count invalidates every latency measurement taken during that run.

---

## 55.5 Lock Avoidance

A mutex on the hot path is not merely slow; it is *unbounded*. An uncontended `pthread_mutex_lock` is ~20 ns (a single CAS), which is affordable. A contended one parks the thread in the kernel via futex and costs 2–10 μs to resume — plus, if the lock holder is preempted while holding it, the waiter's delay is bounded only by the holder's scheduling delay, which can be milliseconds. That is the **convoy** (Ch. 24 §24.19) and it is the reason the rule is categorical: *no locks on the critical path*, not *few locks*.

The avoidance hierarchy, best to worst:

| Technique | Cost | When |
|---|---|---|
| **No sharing** — thread-local / single-writer | 0 | Default. Restructure until this is true. |
| **SPSC ring** between two threads | ~20–40 ns hand-off | Pipeline stages (Ch. 26 §26.3) |
| **Seqlock** for a small, read-mostly snapshot | ~5 ns read, no write blocking readers | Reference data, risk limits (Ch. 26 §26.8) |
| **RCU / atomic pointer swap** for config | Read is a single relaxed load | Immutable config updates (Ch. 60 §60.10) |
| **Single relaxed atomic** counter/flag | ~1 ns load, ~7–20 ns RMW | Statistics, state flags |
| **Lock-free MPSC/MPMC queue** | 40–100 ns under contention | Only if genuinely multi-producer |
| Mutex | 20 ns – milliseconds | Cold path only |

**The single-writer principle is the actual answer.** Almost every lock on a hot path exists because two threads write the same data; almost every such case is removable by making one thread the sole writer and giving others a read-only view or a queue. This is the architectural point from Ch. 52 §52.6, and it eliminates not just the lock but the cache-line bouncing beneath it — which is often the larger cost. Two cores writing the same line trade it via the coherence protocol at ~100 ns per transfer regardless of what synchronization primitive you wrap around it.

**Seqlock** deserves specificity because it is the right tool for the very common "hot path reads a value another thread occasionally updates" case:

```cpp
struct SeqRiskLimits {
    std::atomic<uint32_t> seq{0};
    RiskLimits            data;                 // POD, one cache line
    // Writer (cold thread, single writer)
    void store(const RiskLimits& v) noexcept {
        seq.store(seq.load(rlx) + 1, rel);      // odd => in progress
        data = v;
        seq.store(seq.load(rlx) + 1, rel);      // even => stable
    }
    // Reader (hot path): no writes to shared memory, so no line ownership transfer
    RiskLimits load() const noexcept {
        RiskLimits out; uint32_t s0, s1;
        do { s0 = seq.load(acq);
             if (s0 & 1) continue;
             out = data;
             std::atomic_thread_fence(std::memory_order_acquire);
             s1 = seq.load(rlx);
        } while (s0 != s1);
        return out;
    }
};
```

The critical property: the reader performs **no stores**, so it never takes the cache line exclusively and never disturbs other readers — unlike a reader-writer mutex, whose shared-lock acquisition is itself a write to the lock word and therefore bounces the line between every reader. That makes `std::shared_mutex` slower than a plain mutex under read-heavy hot-path load, which is a favourite interview question.

**Where locks legitimately remain.** Startup, configuration reload, the cold half of a two-phase update, and any warm-path structure where the tail does not reach the trading decision. Do not perform ideological lock removal on the cold path — a lock-free structure is harder to prove correct, and correctness is cheaper there.

**Diagnostics.** `perf lock`, `mutrace`, or simply `perf record -e syscalls:sys_enter_futex`: any futex activity from a hot thread in steady state is a bug. Off-CPU profiling (Ch. 43 §43.24) shows the blocked time that on-CPU profiling cannot.

---

## 55.6 System-Call Avoidance

A system call is a mode switch (Ch. 34 §34.3), not a context switch, but post-Meltdown/Spectre mitigations made it dramatically more expensive: **KPTI** flushes or tags TLB entries on each transition, and retpoline/IBRS add indirect-branch overhead. A minimal `getppid()` costs ~250 ns with mitigations on modern kernels versus ~60 ns before them; a `sendto()` on a UDP socket costs 1–3 μs including the network stack. Beyond the direct cost, a syscall pollutes L1i, L1d, and the branch predictors, so the *next* few hundred instructions of your code run slower — an indirect cost that microbenchmarks of the syscall itself never capture.

The four categories of syscall on a naive hot path, and their eliminations:

| Syscall | Cost | Replacement |
|---|---|---|
| `sendto`/`recvfrom`/`write` | 1–3 μs | Kernel bypass: `ef_vi`, DPDK, TCPDirect (Ch. 47) |
| `epoll_wait` | 2–10 μs including wakeup | Busy-spin polling (§55.3) |
| `clock_gettime` | ~20–25 ns (vDSO, no mode switch) | `rdtsc` + calibration (~7 ns) |
| `write` to a log file | 1–5 μs, unbounded on I/O stall | Ring buffer + separate writer thread (§55.7) |
| `malloc` → `mmap`/`brk` | ~1 μs plus faults | Preallocation (§55.1) |
| Futex wake/wait | 2–10 μs | Lock avoidance (§55.5) |
| Page fault (not a syscall but a trap) | 1–3 μs | `MAP_POPULATE` + `mlockall` (§55.1) |

**`clock_gettime` is the nuance.** It is *not* a real syscall for `CLOCK_MONOTONIC` — the vDSO (Ch. 34 §34.4) maps kernel timekeeping data into userspace, so it is a function call that reads the TSC and applies a scaling factor, ~20–25 ns. That is acceptable once per event but not three times. `rdtsc` is ~7 ns (`rdtscp` ~10 ns, adding a partial serialization), and on a machine with `constant_tsc` and `nonstop_tsc` it is monotonic and consistent across cores (Ch. 35 §35.3). The hot-path pattern is: timestamp with `rdtsc` into a raw counter, convert to nanoseconds *off the hot path* using a calibrated ratio (Ch. 43 §43.13). Never call `clock_gettime` in a loop to measure per-iteration time — the measurement then dominates the measurand (probe effect, Ch. 43 §43.25).

**Kernel bypass is the big one.** Removing the kernel from send and receive eliminates the syscall, the `sk_buff` allocation and copy, the protocol stack traversal, the softirq handoff, and the wakeup — typically taking one-way UDP receive latency from ~5–10 μs to ~1–2 μs, and send similarly. See §55.5's neighbouring topic and Ch. 47 for the mechanisms; the point here is that it is a *syscall-avoidance* technique first and a copy-avoidance technique second.

**Hidden syscalls.** The ones that surface in production and not in review:

- **The first touch of any page** — a minor fault; `mlockall(MCL_FUTURE)` and prefaulting.
- **`std::chrono::system_clock::now()`** inside a logging macro that you believed was compiled out.
- **Thread creation, `std::async`, `std::thread`** anywhere reachable from the hot path.
- **`std::random_device`** — reads `/dev/urandom` (a syscall) per call.
- **Stack growth past the guard page** — a fault; prefault the stack by touching it at startup.
- **`std::filesystem`, `getenv`, `dlopen`** in a lazily-initialized code path.
- **Lazy PLT binding** on the first call to a shared-library function (Ch. 41 §41.12) — a dynamic-loader resolution costing microseconds. Fix with `LD_BIND_NOW=1` / `-Wl,-z,now`, or static linking.

**Verification.** `strace -c -p <pid>` for a minute of steady state, or better, `perf trace` or a bpftrace one-liner counting `raw_syscalls:sys_enter` per thread. On a correctly built hot thread the count in steady state is **zero**. This is a binary, checkable property and it belongs in the CI soak test.

---

## 55.7 Allocation-Free Logging

Logging is the most common way a hot path acquires all four forbidden costs at once: a `std::string` allocation, a mutex on the log sink, a `write()` syscall, and a `clock_gettime`. A single naive `LOG(INFO) << "order " << id << " sent at " << ts;` costs 1–10 μs and has an unbounded tail when the disk stalls.

The correct architecture separates **capture** (hot, ~10–30 ns) from **formatting and I/O** (warm, another thread):

```cpp
// Hot side: copy raw binary arguments into a preallocated SPSC ring. No formatting.
struct Rec {
    uint64_t     tsc;
    const char*  fmt;          // pointer to a static string literal — 8 bytes, not a copy
    uint32_t     n_args;
    uint64_t     args[6];      // scalars only, bit-cast in
};

template <class... A>
inline void log_hot(const char* fmt, A... a) noexcept {
    static_assert((std::is_trivially_copyable_v<A> && ...));
    static_assert(sizeof...(A) <= 6);
    if (Rec* r = ring_.try_claim()) {                 // no allocation; drop if full
        r->tsc = __rdtsc();
        r->fmt = fmt;
        r->n_args = sizeof...(A);
        uint32_t i = 0; ((r->args[i++] = to_u64(a)), ...);
        ring_.commit(r);                              // one release store
    } else {
        ++dropped_;                                   // counted, never silent
    }
}
```

The techniques stacked here:

1. **Store the format string as a pointer, not its characters.** A string literal has static storage duration, so the pointer is always valid; the consumer dereferences it later. This turns a 40-byte copy into 8 bytes. Taken further (NanoLog, Quill, Binlog), a compile-time registry assigns each call site an integer ID and the log file contains only IDs plus arguments — a 4–8 byte record, with a dictionary emitted at build time and applied by an offline decoder. Throughput reaches tens of millions of messages/second at ~7–15 ns per call.
2. **Binary, not text.** Formatting `%f` costs 50–200 ns (Ch. 16 §16.3). Defer it entirely.
3. **`rdtsc`, not `clock_gettime`** (§55.6). Convert offline.
4. **SPSC ring, not a mutex-protected queue** (§55.5, Ch. 26 §26.3). Producer and consumer touch disjoint cache lines except for the two sequence counters, which must be on separate lines or the ring itself false-shares (Ch. 3 §3.3).
5. **Bounded with an explicit drop policy.** The ring must never block the producer and never allocate. When full, drop and **count the drops** — a logging system that silently loses records under load loses them exactly when you needed them (Ch. 59 §59.7). Export the drop counter as a first-class metric.
6. **Consumer on a housekeeping core** (§55.4), writing with buffered or direct I/O, never sharing a core with a hot thread.

**The `const char*` lifetime trap.** Passing a `std::string`'s `c_str()`, a stack buffer, or a `std::string_view` into this API stores a pointer that dangles by the time the consumer formats it — producing garbage or a crash minutes later, in a different thread, with no relation to the original code. Enforce it at compile time: accept only `const char (&)[N]` for the format, and constrain arguments to arithmetic types and explicitly-registered fixed-size buffers. A `static_assert` here prevents an entire class of unreproducible production bugs.

**What to log on the hot path.** Almost nothing. The steady-state hot path should emit *events into the journal* (Ch. 56 §56.1) rather than log lines, because the journal is structured, replayable, and reconcilable. Reserve hot logging for exceptional branches. A **flight recorder** — a fixed-size ring holding the last N events, never written to disk unless a fault occurs (Ch. 59 §59.13) — gives you full-detail history at the cost of a ring store per event and zero I/O, and is the right default for the deepest hot path.

---

## 55.8 Compile-Time Hot-Path Specialization

Every runtime decision that could have been made at compile time costs a branch, a load, or an indirect call on every message. Specialization moves those decisions to instantiation time, where the cost is compile time and code size instead of latency.

**The tools, and what each buys:**

```cpp
// 1. if constexpr — removes the branch AND the dead code entirely.
template <Venue V>
inline void encode(const Order& o, std::byte* out) noexcept {
    if constexpr (V == Venue::Nasdaq) { encode_ouch(o, out); }
    else if constexpr (V == Venue::Cme) { encode_sbe(o, out); }
    // the untaken branch is not instantiated: no I-cache footprint, no branch
}

// 2. Non-type template parameters — capacity as a constant folds bounds checks into masks.
template <uint32_t N> class Ring { static_assert((N & (N-1)) == 0);
    uint32_t idx(uint64_t s) const noexcept { return s & (N - 1); } };  // AND, not DIV

// 3. Policy classes — behaviour injected without virtual dispatch (§55.9).
template <class RiskPolicy, class Encoder>
class Gateway { RiskPolicy risk_; Encoder enc_; };  // both inlined, both EBO'd to zero size

// 4. constexpr tables — computed at build time, in .rodata, no init cost.
constexpr auto kTickTable = make_tick_table();      // Ch. 4 §4.12
```

**Quantifying the benefit.** A branch that is *perfectly predicted* costs near zero, so the naive expectation is that `if constexpr` saves nothing. The real gains are elsewhere and are worth being able to enumerate:

- **Code size and I-cache.** Removing the untaken venue's encoder removes hundreds of bytes from the hot loop's footprint. The L1i is 32 KB; a hot path that fits has a materially lower front-end stall rate (Ch. 27 §27.15). This is usually the dominant effect.
- **Enabling downstream optimization.** A known constant propagates: bounds checks fold away, loops unroll, the compiler proves non-aliasing, and struct offsets become immediates. One `constexpr` capacity can eliminate a dozen instructions.
- **Removing the load.** A runtime config field read from a struct is a load that can miss; a template parameter is an immediate.
- **Division becomes masking.** `s % N` with runtime `N` is a 20–40 cycle `div`; with a power-of-two constant it is a 1-cycle `and`. This alone justifies the technique in ring buffers.

**The costs, which you must state to sound credible:**

| Cost | Detail |
|---|---|
| Compile time and code bloat | Each instantiation is a full copy (Ch. 17 §17.22); N venues × M policies explodes |
| I-cache pressure *reversed* | Over-specialization can make total footprint worse than one generic function |
| Debuggability | Deep template errors; harder to breakpoint |
| Late binding impossible | Venue chosen at runtime needs one dispatch at the boundary anyway |

The resolution is **dispatch once at the edge, then run specialized**. Select the instantiation at startup or at the top of the event loop with a single switch or one virtual call, then execute a fully monomorphic path with no further dispatch:

```cpp
// One indirect call per connection, not per message.
switch (venue) {
  case Venue::Nasdaq: run_loop<Venue::Nasdaq>(); break;
  case Venue::Cme:    run_loop<Venue::Cme>();    break;
}
```

**Branch hints and PGO.** Where a runtime branch is unavoidable, `[[likely]]`/`[[unlikely]]` (Ch. 40 §40.6) affect *layout* — the compiler places the likely path fall-through and pushes the cold path out of line, improving I-cache density. They do not train the predictor. Profile-guided optimization (Ch. 40 §40.9) does this automatically and better across the whole binary, and BOLT (Ch. 40 §40.11) does it post-link on the real layout; on large trading binaries PGO+BOLT commonly yields 5–15% on the hot path purely from layout and inlining decisions. If you can run either, do it before hand-annotating.

---

## 55.9 Avoiding Virtual Dispatch

A virtual call costs a load of the vptr, a load of the vtable entry, and an indirect call — roughly 2–5 ns when the branch-target buffer predicts correctly, and ~15–20 cycles when it does not. The direct cost is rarely the issue. The real cost is that **it is an optimization barrier**: the compiler cannot inline through it, so it cannot constant-fold, cannot vectorize across the call, must assume the callee clobbers memory, and must spill caller-saved registers (Ch. 41 §41.7).

The measured shape: in a loop calling a trivial virtual method, the virtual version is often 3–10× slower than the devirtualized one — not because the indirect call is 3–10× the cost of a direct one, but because the direct one *disappears entirely* into the caller.

**When it is genuinely fine.** A monomorphic call site — one where only one type is ever seen — is predicted perfectly by the BTB and costs ~2 ns. A single virtual call per message on a path with a 2 μs budget is noise. Say this in an interview; blanket "virtual is slow" is a weaker answer than knowing that *polymorphic* call sites with unpredictable targets are what hurt, and that the inlining loss usually dominates the dispatch.

**The alternatives, with their trade-offs:**

| Technique | Dispatch cost | Trade-off |
|---|---|---|
| **Templates / policy classes** (§55.8) | Zero, fully inlined | Type known at compile time; code bloat |
| **CRTP** (Ch. 6 §6.19) | Zero | Static hierarchy; no heterogeneous containers |
| **`std::variant` + `std::visit`** | Jump table, ~2–4 ns, inlinable bodies | Closed set of types; size = largest member |
| **Tagged union + `switch`** | Predictable jump table, bodies inline | Manual lifetime management (Ch. 3 §3.11) |
| **Function pointer** | Same as virtual, minus the vptr load | Still an inlining barrier |
| **`final` on class or method** | Enables *devirtualization* to a direct call | Free; costs nothing to apply |
| **Sorted/partitioned dispatch** | Amortizes to monomorphic | Requires batching |

**`final` is the cheapest win.** Marking a leaf class `final` lets the compiler prove the dynamic type at a call site whose static type is that class, and replace the indirect call with a direct, inlinable one. Applying `final` throughout a hierarchy costs nothing and enables speculative devirtualization even where the compiler cannot prove uniqueness. LTO (Ch. 40 §40.3) extends this across translation units by giving the optimizer whole-program visibility of which classes actually override.

**The structural answer.** Heterogeneous dispatch on a hot path usually indicates a design that should have been *partitioned* instead. If a feed handler holds `vector<unique_ptr<Handler>>` and calls `->on_message()` per packet, the call is polymorphic, the objects are scattered in memory (a cache miss per element, Ch. 42 §42.1), and nothing inlines. Replacing it with one array per concrete type, processed in homogeneous batches, converts a polymorphic call into a monomorphic (and usually inlined) one *and* makes the access pattern sequential and prefetchable. That is data-oriented design, and it is the answer interviewers are looking for when they ask how to remove virtual dispatch from a message handler.

**Type erasure without heap** — `std::function` is disqualified twice over: it may allocate for captures beyond its small-buffer (typically 16 bytes), and it dispatches indirectly. On a hot path use a captureless lambda converted to a function pointer, an `inplace_function`-style fixed-capacity callable, or a template parameter. Ch. 18 §18.10 covers the small-object optimization limits.

---

## 55.10 Fixed-Layout Serialization

Serialization sits directly on the critical path in both directions: parsing the inbound market-data message and encoding the outbound order. The technique is to make both operations *layout-identical to the wire*, so that encoding is a small number of stores into a preallocated buffer and decoding is a set of loads at known offsets — no parsing loop, no allocation, no intermediate representation.

Ch. 3 §3.12 gives the ABI rules; Ch. 51 §51.8–§51.10 give the protocol side. The hot-path synthesis:

```cpp
#pragma pack(push, 1)          // only for foreign formats you don't control
struct NewOrderMsg {
    uint16_t length;           // 0
    uint8_t  msg_type;         // 2
    uint8_t  side;             // 3
    uint64_t cl_ord_id;        // 4
    int64_t  price;            // 12  fixed point, never float (Ch. 23 §23.10)
    uint32_t quantity;         // 20
    uint16_t instrument_id;    // 24
    uint8_t  tif;              // 26
    uint8_t  _reserved;        // 27
};
#pragma pack(pop)
static_assert(sizeof(NewOrderMsg) == 28);
static_assert(std::is_trivially_copyable_v<NewOrderMsg>);
static_assert(std::has_unique_object_representations_v<NewOrderMsg>);
static_assert(offsetof(NewOrderMsg, price) == 12);
```

**Encode by field stores into a preallocated buffer**, not by constructing a temporary and copying:

```cpp
inline size_t encode(std::byte* __restrict out, const Order& o) noexcept {
    auto* m = reinterpret_cast<NewOrderMsg*>(out);   // buffer is ours, aligned, warmed
    m->length = sizeof(NewOrderMsg); m->msg_type = 'O';
    m->cl_ord_id = o.cl_ord_id;  m->price = o.price_ticks;
    m->quantity  = o.leaves_qty; m->instrument_id = o.instrument_id;
    m->side = o.side; m->tif = o.tif; m->_reserved = 0;
    return sizeof(NewOrderMsg);
}
```

The performance-relevant details:

- **Pre-encode the invariant prefix.** Session ID, account, sender fields, and the fixed header do not change per message. Write them into the per-instrument transmit buffer once at startup; the hot path overwrites only the varying fields. This can cut an encode from 30 stores to 6.
- **One buffer per instrument, pre-populated.** For quoting, most fields of the next message are already correct; you are editing 2–3 fields (price, quantity, `ClOrdID`) in a warm, resident, aligned buffer. Encode time drops to a handful of nanoseconds.
- **Alignment and straddles.** `#pragma pack(1)` removes padding but creates misaligned members; taking their address is UB and faults on strict-alignment targets (Ch. 3 §3.3). Prefer designing the message so it is naturally aligned with *explicit* reserved fields, and use packing only for foreign formats — where you should `memcpy` fields out rather than dereference. A field straddling a 64-byte cache line costs an extra access; a field straddling a 4 KB page costs far more. Lay the struct out so hot fields share one line.
- **Endianness.** If the venue's byte order matches the host's, the encode is free; if not, `std::byteswap`/`__builtin_bswap` is one instruction (`BSWAP`, or fused into the load via `MOVBE`), so the cost is ~1 cycle per field — negligible, but only if you do it with the intrinsic rather than shift-and-mask loops the compiler fails to recognize (Ch. 3 §3.9).
- **Decode by direct load, not by copy.** With a C++23 `std::start_lifetime_as` (Ch. 3 §3.7) or a `memcpy` into a stack struct — the latter compiles to the same loads for small messages, so use it and stop worrying. Do *not* build a `std::vector<Field>` or a map of tag→value; a table-driven FIX parser costs microseconds where a fixed-layout binary decode costs tens of nanoseconds. This is a substantial part of why binary protocols exist.
- **Validate before trusting.** Every length and count from the wire is attacker/error-controlled (Ch. 51 §51.12). Bounds-check the declared length against the received bytes *before* indexing. This check is a compare and a predictable branch — a handful of cycles — and skipping it is how a malformed message becomes an out-of-bounds read.

**The measurement.** A well-built fixed-layout encode of a 30–60 byte order message should measure **10–30 ns** including the `ClOrdID` generation, and a decode of a market-data update **5–20 ns**. If you measure hundreds of nanoseconds, look for: a `std::string` or `std::vector` in the path, `snprintf`, a tag-based parse loop, an unaligned buffer, or a cold destination page.

---

## 55.11 Reducing Power-State Jitter

The CPU's power management is a latency adversary. Its mechanisms are invisible in code and they act on exactly the timescale that matters.

**C-states** are idle states. When a core has nothing to run it enters progressively deeper states (C1, C1E, C3, C6…), each saving more power and costing more to exit. Exit latencies are published in `/sys/devices/system/cpu/cpu0/cpuidle/state*/latency` and are typically:

| State | Exit latency | What is lost |
|---|---|---|
| C1 | ~1–2 μs | Nothing significant |
| C1E | ~10 μs | Frequency drops too |
| C3 | ~30–50 μs | L1/L2 flushed |
| C6 | ~50–150 μs | Core power-gated; caches lost; full restore |

A core that sleeps in C6 and is woken by a packet pays up to 150 μs before it executes your first instruction — larger than the entire tick-to-trade budget by two orders of magnitude. **This is the strongest single argument for busy-spinning** (§55.3): a spinning core never enters a C-state at all. Where a thread must be able to idle, cap the depth:

```
# Boot: prevent deep states entirely
intel_idle.max_cstate=1  processor.max_cstate=1  idle=poll
# Or at runtime, per-core, via the PM QoS interface (hold the fd open):
fd = open("/dev/cpu_dma_latency", O_WRONLY); write(fd, &(int32_t){0}, 4);  // keep open!
```

The `/dev/cpu_dma_latency` trick is worth knowing precisely: writing a 32-bit microsecond bound requests that no core enter a state with a higher exit latency, and **the constraint is released when the file descriptor is closed** — so a program that writes and closes has done nothing. Candidates who know this detail have actually done the work.

**P-states and frequency.** Frequency transitions take 10–50 μs and the governor decides them from utilization heuristics. A core that has been idle sits at a low frequency, so the first burst of work runs at perhaps 1.2 GHz instead of 4.5 GHz — a 3–4× slowdown on the very first message after a quiet period, which is a systematic bias, not random jitter. Fixes: `cpupower frequency-set -g performance`, or better, pin the frequency by setting min = max via `scaling_min_freq`/`scaling_max_freq`, and disable the `intel_pstate` driver's opportunism if the workload is latency-critical.

**Turbo Boost** is a subtler decision. It raises single-core frequency above base when thermal and power headroom exist — good — but it is *opportunistic*: the achievable frequency depends on how many cores are active, package temperature, and the instruction mix, and it can drop mid-burst. Many low-latency shops disable Turbo and run at a fixed, always-achievable frequency, accepting a lower mean to obtain a *constant* one. The reasoning is the chapter's thesis: predictability beats speed. Where Turbo is kept, cooling and core-count planning must guarantee the boost bin is sustainable.

**AVX frequency licensing.** Heavy 256-bit and especially 512-bit vector instructions cause the core (and on some parts, the whole package) to drop to a lower frequency license, with a transition period of microseconds during which execution is throttled, and a recovery of ~2 ms after the last wide instruction (Ch. 42 §42.13). A single incidental AVX-512 instruction — often from a library `memcpy` or an auto-vectorized loop — can therefore downclock a latency-critical core. On affected microarchitectures, compile hot binaries with `-mprefer-vector-width=256` and check the generated code.

**Other jitter sources to name.** SMM (System Management Mode) interrupts are invisible to the OS and can cost tens to hundreds of microseconds; they are firmware-controlled and are disabled or minimized in BIOS on trading hosts. Disable also: BIOS power management/"energy efficient" profiles, C1E autopromotion, hardware P-state (HWP) if it overrides your settings, and ASPM on PCIe (which adds link-wakeup latency to NIC DMA).

**Verification.** `turbostat` shows per-core residency in each C-state and the actual average frequency — the definitive check that your settings took effect (`Busy%`, `Bzy_MHz`, `CPU%c1/c6`, `PkgTmp`). `cyclictest -p 99 -m -t1 -a <core>` (Ch. 35 §35.17) measures wakeup jitter directly; on a properly tuned isolated core the maximum should be single-digit microseconds over hours, and a maximum in the hundreds of microseconds points at C-states, SMIs, or THP compaction.

---

## Key Interview Questions

1. **Why is `malloc` banned on the hot path when its fast path is only 20 ns?** — Because the distribution has an unbounded tail: cache refill takes a lock, heap extension is a syscall, and fresh pages fault at 1–3 μs each. You optimize the tail, not the mean.
2. **You preallocated a 1 GB buffer at startup and still see multi-microsecond spikes. Why?** — Allocation is not residency. Without `MAP_POPULATE`/prefaulting you fault on first touch, and without `mlock` the pages can be reclaimed. Also check that the first touch happened on the owning thread's NUMA node.
3. **Why LIFO rather than FIFO for a pool's free list?** — LIFO returns the most recently freed slot, which is still cache-resident; FIFO cycles the whole pool and guarantees a miss per acquire.
4. **What should a pool do when exhausted?** — Return failure and let a policy decide (reject, shed, alarm). Never fall back to `new`, which hides the capacity bug until peak load.
5. **Quantify what busy-spinning buys and what it costs.** — Buys 2–10 μs of wakeup latency plus warm caches and predictors; costs a fully consumed core, ~10–25 W, and no fairness for anything sharing that core.
6. **When do you use `_mm_pause()` and when do you not?** — In a contention spin on another core's write (reduces machine clears and SMT starvation); not in a NIC/ring polling loop, where it only adds latency.
7. **What does `nohz_full` do and why does `isolcpus` alone not suffice?** — `isolcpus` removes the core from load balancing but the 1000 Hz scheduler tick still fires, costing 1–3 μs of interference per tick. `nohz_full` stops the tick when exactly one task is runnable.
8. **Why is `std::shared_mutex` often slower than a plain mutex for read-heavy hot paths?** — Acquiring a shared lock *writes* the lock word, so every reader bounces the cache line. A seqlock reader performs no stores at all.
9. **Explain a seqlock and its one hard requirement.** — Even/odd sequence counter around the write; readers retry if the counter changed or was odd. Requires the payload be trivially copyable and readers tolerate torn reads that are then discarded.
10. **Why did syscalls get more expensive after 2018?** — KPTI's page-table switching plus retpoline/IBRS indirect-branch mitigations; a minimal syscall went from ~60 ns to ~250 ns, and it also pollutes I-cache and predictors.
11. **Is `clock_gettime` a syscall?** — Not for `CLOCK_MONOTONIC`: it is served from the vDSO at ~20–25 ns. Still 3× the cost of `rdtsc`, so timestamp with `rdtsc` and convert offline.
12. **Design an allocation-free logger.** — Hot side copies `rdtsc`, a pointer to the static format string, and trivially-copyable scalar arguments into a preallocated SPSC ring; a warm thread on a housekeeping core formats and writes. Bounded, drop-on-full, drops counted.
13. **What is the dangerous API mistake in a deferred-formatting logger?** — Passing a pointer to non-static storage (`std::string::c_str()`, a stack buffer). It dangles before the consumer formats it. Constrain the API at compile time.
14. **`if constexpr` removes a perfectly-predicted branch worth ~0 ns. Where does the win come from?** — Code size and I-cache footprint, plus constant propagation enabling downstream optimization, plus turning `%` into `&` when capacities are compile-time powers of two.
15. **How do you get compile-time specialization with a runtime-chosen venue?** — Dispatch once at the loop boundary into a monomorphic instantiation; pay one indirect call per connection instead of per message.
16. **Why is a virtual call more expensive than its 2–5 ns dispatch cost suggests?** — It is an inlining and optimization barrier: no constant folding, no cross-call vectorization, forced register spills, and assumed memory clobber.
17. **What is the cheapest devirtualization technique?** — Marking leaf classes and overrides `final`, which lets the compiler prove the dynamic type and emit a direct, inlinable call. Free, and amplified by LTO.
18. **Why can a core take 150 μs to respond to a packet even though it is idle?** — C6 exit latency: the core is power-gated with caches lost. Busy-spin, or cap C-states via boot parameters or a held-open `/dev/cpu_dma_latency` descriptor.
19. **Why do some firms disable Turbo Boost?** — Turbo frequency is opportunistic and varies with active core count, temperature, and instruction mix, so it converts to jitter. A fixed lower frequency is more predictable, and predictability beats speed at the tail.
20. **How do you prove a hot thread makes no syscalls, no allocations, and no migrations?** — `perf stat -e page-faults,context-switches,cpu-migrations` reading zero, `perf trace`/bpftrace counting zero `sys_enter` on that TID, and an `operator new` tripwire that traps during the hot phase. All three belong in a CI soak test.

---

## Common Traps

- **Preallocating without prefaulting or locking** — the fault arrives on first touch, in production, under load.
- **First-touching preallocated memory on the wrong thread** — permanent remote-NUMA access, ~50 ns per access, forever.
- **Relying on transparent huge pages** — `khugepaged` compaction produces multi-millisecond stalls; use explicit `hugetlbfs`.
- **A pool that falls back to `new` when exhausted** — converts a visible capacity bug into an invisible latency bomb.
- **FIFO free lists** — a guaranteed cache miss per acquire.
- **Two threads' pool heads on the same cache line** — false sharing turning a 2 ns operation into 100 ns.
- **Spinning while calling `recvfrom()` every iteration** — pays a syscall per iteration and burns the core; worse than blocking.
- **Two hot threads on sibling hyperthreads** — 20–50% throughput loss from front-end contention.
- **Hardcoding core numbers without reading `lscpu -e`** — enumeration is not topological; you may pin across sockets.
- **`isolcpus` without `nohz_full` and IRQ affinity** — the tick and device interrupts still land on your core.
- **`SCHED_FIFO` on a non-yielding spin loop** — can starve kernel threads and hang a misconfigured machine.
- **`std::shared_mutex` for a read-heavy hot structure** — shared acquisition writes the lock word and bounces the line.
- **Any futex activity from a hot thread in steady state** — a lock you did not know you had.
- **`std::random_device`, `std::filesystem`, lazy PLT binding, `std::async`** — hidden syscalls on paths believed to be pure.
- **Logging a `std::string::c_str()` into a deferred-format ring** — dangling pointer, garbage or crash minutes later in another thread.
- **A logger that drops silently under load** — loses exactly the records you needed.
- **Formatting or `clock_gettime` on the logging hot side** — 50–200 ns and 25 ns respectively, per call.
- **Over-specializing templates** — code bloat that grows total I-cache footprint beyond the generic version.
- **`[[likely]]` believed to train the branch predictor** — it affects layout only; use PGO/BOLT.
- **`std::function` on a hot path** — may allocate for captures beyond its small buffer and blocks inlining.
- **Tag-based text parsing on the critical path** — microseconds where fixed-layout binary decode costs tens of nanoseconds.
- **Taking the address of a packed struct member** — UB, faults on ARM, warned by `-Waddress-of-packed-member`.
- **Trusting a wire-supplied length before bounds-checking it** — an out-of-bounds read for a few saved cycles.
- **Writing to `/dev/cpu_dma_latency` and closing the descriptor** — the constraint is released on close; nothing happened.
- **An incidental AVX-512 instruction from a library `memcpy`** — frequency licensing downclocks the core for milliseconds.
- **Benchmarking with the `powersave` governor or Turbo enabled** — measurements that do not reproduce.

---

## Compact Recall Summary

**The rule set.** No allocation, no locks, no syscalls, no page faults, no migrations, no unpredictable branches on the critical path. Each is banned because its *tail* is unbounded, not because its mean is large. Predictability beats speed: a technique that lowers the mean and adds a periodic stall is a regression.

**Memory.** Preallocate everything with compile-time capacities; `mmap` with `MAP_POPULATE|MAP_HUGETLB`, `mlockall`, and first-touch on the owning thread for NUMA locality. Explicit huge pages, never THP. Verify with zero steady-state page faults and an `operator new` tripwire. Pools are arrays plus a LIFO free list of dense 32-bit indices, ~2 ns per acquire, exhaustion is a policy decision and never a fallback to `new`, per-thread to avoid atomics, with an SPSC return ring for cross-thread frees.

**Scheduling.** Busy-spin to eliminate the 2–10 μs wakeup and to keep caches, TLB, and predictors warm; the price is a whole core and ~10–25 W. `_mm_pause` in contention spins, not in polling loops. Pin to isolated cores with `isolcpus` + `nohz_full` + `rcu_nocbs` + IRQ affinity — the tick alone is 1000 × 1–3 μs per second otherwise. Read topology before pinning; NIC-local NUMA node for the RX thread, shared L3 for SPSC pairs, never SMT siblings. Assert zero migrations and zero context switches.

**Synchronization.** Single-writer ownership removes both the lock and the cache-line bouncing under it. SPSC rings for hand-offs (~20–40 ns), seqlocks for read-mostly snapshots (readers issue no stores, so no line transfer — unlike `shared_mutex`), atomic pointer swap for config. Mutexes are cold-path only; contended ones cost 2–10 μs and can convoy without bound.

**Kernel.** Syscalls cost ~250 ns minimum post-KPTI plus predictor and I-cache pollution; network syscalls cost 1–3 μs. Eliminate via kernel bypass for I/O, spinning for readiness, `rdtsc` for time (7 ns vs 25 ns vDSO, convert offline), rings for logging, preallocation for memory. Hunt hidden ones: lazy PLT binding (`-Wl,-z,now`), `random_device`, stack growth, first-touch faults. Prove it: zero `sys_enter` on the hot TID.

**Logging.** Separate capture from formatting. Hot side stores `rdtsc`, a static format-string pointer, and trivially-copyable scalars into a preallocated SPSC ring — 10–30 ns, or 7–15 ns with compile-time call-site IDs. Bounded, drop-on-full, drops counted and exported. Never a pointer to non-static storage. On the deepest path prefer a flight-recorder ring with no I/O at all, and emit journal events rather than log lines.

**Code shape.** `if constexpr`, non-type template parameters, and policy classes move decisions to compile time; the win is I-cache footprint, constant propagation, and turning `%` into `&`, not branch elimination. Dispatch once at the edge into monomorphic code. Virtual calls cost ~2–5 ns predicted but block inlining — the real loss; fix with `final` (free), templates/CRTP, variant or tagged-union dispatch, and above all by partitioning heterogeneous collections into homogeneous batches. Fixed-layout serialization with pre-encoded invariant prefixes and per-instrument warm buffers puts encode at 10–30 ns and decode at 5–20 ns; validate wire lengths before indexing.

**Hardware state.** C6 exit costs up to 150 μs, which is why spinning cores never sleep; cap with boot parameters or a *held-open* `/dev/cpu_dma_latency` descriptor. Pin frequency (min = max, `performance` governor); many shops disable Turbo for a constant clock. Watch AVX frequency licensing from incidental wide instructions. Disable SMIs, BIOS power profiles, and PCIe ASPM. Verify with `turbostat` residency and `cyclictest` maxima — single-digit microseconds over hours, or your tuning did not take.

**Measurement discipline.** Every technique here must be justified against a before/after on the *tail*, measured on a production-representative machine with isolated cores, fixed frequency, and warm caches, using percentiles and HDR histograms rather than means (Ch. 43 §43.2–§43.5), and guarded against coordinated omission. Techniques adopted without measurement accumulate complexity and cost future engineers more than the nanoseconds they may or may not have saved.
