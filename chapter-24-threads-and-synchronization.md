# Chapter 24 — Threads and Synchronization

*Interview-focused revision notes. The theme: every synchronization primitive is a policy layered on two mechanisms — an atomic operation on a shared word, and a decision about whether to spin or ask the kernel to sleep. Understanding the second decision is what separates people who use `std::mutex` from people who can explain its latency.*

---

## 24.1 `std::thread` and `std::jthread`

A **thread of execution** is an independent instruction stream sharing the process's address space (heap, globals, file descriptors) while owning its own stack and register state. `std::thread` (C++11) is a thin, non-owning-of-lifetime RAII handle over a native thread — `pthread_t` on POSIX, a `HANDLE` on Windows.

```cpp
std::thread t([]{ work(); });
t.join();                       // MUST join or detach before destruction
```

**The destructor rule is the defining hazard:** if a `std::thread` is destroyed while still *joinable* (neither joined nor detached), it calls `std::terminate()`. Not a leak, not a wait — immediate process death. The committee chose this deliberately: silently joining would introduce a hidden blocking point in a destructor (and thus in exception unwinding), and silently detaching would leave a thread running with dangling references to the destroyed scope. Termination is the least-bad default, and it makes the bug loud.

The consequence is that any exception between construction and `join()` kills the process:

```cpp
std::thread t(work);
may_throw();                    // if this throws, ~thread() → std::terminate()
t.join();
```

### `std::jthread` (C++20)

`std::jthread` fixes both problems: its destructor **requests stop and then joins**.

```cpp
std::jthread t([](std::stop_token st) {           // optional first parameter
    while (!st.stop_requested()) { do_work(); }
});
// ~jthread(): t.request_stop(); t.join();
```

| | `std::thread` | `std::jthread` |
|---|---|---|
| Destructor while joinable | `std::terminate()` | `request_stop()` then `join()` |
| Cancellation | None | Built-in `std::stop_token` / `stop_source` |
| Callable signature | `f(args...)` | `f(stop_token, args...)` if it accepts one, else `f(args...)` |
| Exception safety | Manual guard needed | RAII by construction |

`std::jthread` should be the default in C++20 code. The one caveat: its destructor *blocks*, so a `jthread` member in a long-lived object makes that object's destructor a synchronization point — fine, but it must be visible in your shutdown ordering (Ch. 60).

### Mechanics and cost

- **Arguments are copied/moved into the thread's storage**, then passed as rvalues to the callable. A function taking `T&` will not bind — you need `std::ref`. This is a very common compile error and the fix is worth knowing cold.
- An **exception escaping the thread function calls `std::terminate()`**. There is no propagation to the parent; to transport an exception you need `std::promise::set_exception`, `std::packaged_task`, or a manual `std::exception_ptr` (Ch. 20).
- `std::thread::hardware_concurrency()` is a *hint*, may return 0, and — critically — reports the machine's logical CPU count, **not the cgroup/container CPU quota**. In a container limited to 2 CPUs on a 64-core host it returns 64, and a thread pool sized from it will thrash. Read `/sys/fs/cgroup/cpu.max` or use `sched_getaffinity` instead. This is a genuinely common production bug worth raising unprompted.
- `native_handle()` is the escape hatch for `pthread_setaffinity_np`, `pthread_setschedparam`, and `pthread_setname_np` — all of which matter in low-latency systems and none of which the standard exposes (Ch. 31).

---

## 24.2 Joining and Detaching Threads

**Joining** blocks the caller until the target thread finishes and reclaims its resources. **Detaching** severs the handle: the thread runs independently and its resources are reclaimed by the runtime at exit.

```cpp
t.join();      // t.joinable() becomes false; blocks
t.detach();    // t.joinable() becomes false; does NOT block
```

`joinable()` is true from successful construction until either call. Calling `join()` or `detach()` on a non-joinable thread throws `std::system_error`; calling neither and destroying terminates.

### Why detach is almost always wrong

A detached thread has no synchronization point with anything, which produces three failure modes:

1. **Dangling references.** The detached thread may capture locals or `this` from a scope that exits immediately. There is no mechanism to discover this.
2. **Racing with static destruction.** At `main()`'s return, static destructors run and then the process exits — while detached threads are still running. They may touch already-destroyed globals, or be killed mid-critical-section holding a lock or a half-written file. Neither is diagnosable after the fact.
3. **No way to know it finished.** You cannot wait for it, so graceful shutdown and draining (Ch. 60) become impossible.

The correct pattern is essentially always **structured lifetime**: own the thread, signal it to stop, join it.

```cpp
class Worker {
    std::jthread t_;
public:
    Worker() : t_([this](std::stop_token st){ run(st); }) {}
    // ~Worker(): jthread dtor requests stop and joins — before members are destroyed?
};
```
**Declare the thread member last** so it is destroyed *first* (reverse declaration order, Ch. 5 §5.9), which stops and joins the thread before the members it uses are torn down. Getting this backwards is the classic use-after-free in worker classes, and it is a favourite interview trap.

### Cooperative cancellation (C++20)

`std::stop_source` / `std::stop_token` / `std::stop_callback` provide a standard cancellation channel. `stop_requested()` is a relaxed atomic load — essentially free in a loop. `std::stop_callback` registers a function that runs on the requesting thread when stop is requested, which is how you interrupt a blocking wait:

```cpp
std::condition_variable_any cv;                       // _any accepts a stop_token
cv.wait(lk, st, [&]{ return ready; });                // returns on stop OR predicate
```
`condition_variable_any::wait` with a `stop_token` overload is the only standard way to wake a CV on cancellation; plain `std::condition_variable` has no such overload, so the manual pattern is a `stop_callback` that takes the lock and calls `notify_all()`. Taking the lock inside the callback is required to avoid a lost wakeup (§24.10).

There is **no `std::thread::kill`**, deliberately. Asynchronous thread termination cannot unwind safely (locks held, invariants broken, destructors skipped) — `pthread_cancel` exists and is a well-documented source of undefined state; `TerminateThread` on Windows is worse. Cancellation must be cooperative.

---

## 24.3 Thread-Local Storage

**Thread-local storage (TLS)** gives each thread its own instance of a variable with static storage duration.

```cpp
thread_local int counter = 0;              // C++11 keyword
static thread_local std::vector<Msg> scratch;
```

Semantics: one object per thread, constructed on first use in that thread (or before, for constant-initialized cases) and destroyed at thread exit in reverse construction order. `thread_local` at namespace scope implies `static`.

### Implementation and cost

The access mechanism depends on the **TLS model**, and the performance difference is large enough to matter:

| Model | Access cost | When |
|---|---|---|
| `initial-exec` | One load off `%fs` (x86-64) — ~1–2 cycles | Variable in the main executable or a `DT_INITIAL_EXEC` shared object; offset known at link time |
| `local-exec` | Same, fastest | Static executable |
| `general-dynamic` | Call to `__tls_get_addr` — **~20–40 cycles**, plus a possible lazy allocation | Variable in a `dlopen`-able shared library |

`-ftls-model=initial-exec` is a real low-latency tuning flag: a `thread_local` in a shared library defaults to `general-dynamic` and costs a function call on every access. The cost is invisible in source and obvious in the disassembly (`call __tls_get_addr`).

**Dynamic initialization is worse than the access.** A `thread_local` with a non-constant initializer requires a guard check on *every* access — "has this thread initialized it yet?" — which is a load, a compare, and a branch. `constinit thread_local` (C++20) forces constant initialization and eliminates the guard entirely. On a hot path this is the difference between 1 cycle and ~5.

**Destructors** on thread-locals register with `__cxa_thread_atexit`, which allocates. A `thread_local std::vector` therefore costs an allocation on first use per thread plus a registration — fine at startup, unacceptable inside a hot loop's first iteration if you have per-request threads.

### Legitimate uses

- **Per-thread scratch buffers and object pools** — the standard way to make a hot path allocation-free without contention (Ch. 55). This is the dominant use in trading systems.
- **Per-thread accumulators for metrics**, aggregated periodically by a reader — avoids the cache-line bouncing of a shared counter (Ch. 26 §26.15), turning a ~100 ns contended atomic into a ~1 ns local increment.
- **`errno`**, per-thread RNG state, per-thread logging buffers.
- **Per-thread arena allocators** — exactly how tcmalloc/jemalloc thread caches work (Ch. 7).

### Traps

- **TLS is per-thread, not per-task.** With coroutines (Ch. 19) or fibers, a task can resume on a *different* thread, so `thread_local` state does not follow it. This is a correctness bug, not a performance one, and it is subtle.
- **Thread pools reuse threads**, so thread-local state persists across unrelated work items. Stale state leaks between tasks; scratch buffers must be reset, not assumed empty.
- **TLS in a `dlopen`'d library** may be allocated lazily on first access, meaning the first access can allocate (and thus can fail, or take a lock inside the allocator) at an arbitrary point.
- **Memory footprint** scales with thread count — a 1 MB thread-local buffer × 64 threads is 64 MB of mostly-cold memory.
- `thread_local` does **not** imply atomicity or ordering for anything it points *to*: a thread-local pointer to shared data is still shared data.

---

## 24.4 Thread Creation and Thread Pools

Thread creation is expensive: `clone(2)` plus stack allocation (default 8 MB of *virtual* address space, populated lazily), TLS setup, and scheduler bookkeeping. **Typical cost is 10–50 µs**, versus ~1 µs for a context switch and ~50 ns to hand work to an existing thread through a queue. Creating a thread per unit of work is therefore viable only when the work is milliseconds long.

A **thread pool** amortizes this by creating N long-lived workers that pull from a queue.

### Design axes

| Axis | Options | Trade |
|---|---|---|
| Queue | Single shared MPMC vs per-worker queues | Shared: simple, contended. Per-worker: scalable, needs work stealing |
| Work distribution | Push (dispatcher assigns) vs pull (workers take) | Pull load-balances naturally; push allows affinity control |
| Blocking discipline | Condition variable vs busy-spin vs spin-then-park | Latency vs CPU burn (§24.15) |
| Sizing | ~cores for CPU-bound; higher for I/O-bound | Oversubscription causes context-switch thrash |
| Stealing | None / random victim / LIFO-own-FIFO-steal | Stealing fixes imbalance at the cost of contention on the deque |

**Work stealing** (Cilk, TBB, Java's ForkJoinPool) gives each worker a double-ended queue: the owner pushes and pops at one end (LIFO — hot in cache, good locality) while thieves steal from the other end (FIFO — takes the oldest, largest task). The Chase–Lev deque is the canonical lock-free implementation. The LIFO-own/FIFO-steal asymmetry is the design insight worth stating.

**Sizing.** For CPU-bound work, threads ≈ cores; more only adds context switches. For blocking I/O, the classic formula is `threads = cores × (1 + wait/compute)`. Remember `hardware_concurrency()` ignores cgroup quotas (§24.1).

### The low-latency answer is different

A general-purpose thread pool is the *wrong* architecture for a trading hot path. The production pattern is:

- **One thread pinned per isolated core** (Ch. 31), not a pool sized to a queue.
- **Busy-spin on an SPSC queue** (Ch. 26) rather than a condition variable — a CV wakeup costs 1–10 µs of scheduler latency, which is an eternity when the budget is single-digit microseconds.
- **Single-writer discipline**: each piece of state has exactly one owning thread, so most synchronization disappears rather than being optimized (Ch. 52).
- **No dynamic work distribution**: the pipeline stage assignment is static, so there is no scheduler, no stealing, and no variance from it.

The trade is explicit: you burn a full core per thread at 100% utilization to remove wakeup latency and its jitter. That is the correct trade at the top of the book and the wrong one for a batch analytics tier, and being able to articulate both sides is the point.

C++26's `std::execution` (senders/receivers, Ch. 20) standardizes a scheduler abstraction with `static_thread_pool`, letting the execution context be a parameter rather than a hard-coded assumption.

---

## 24.5 Mutexes

A **mutex** (mutual exclusion) enforces that at most one thread at a time executes a critical section. It provides both *exclusion* and *memory ordering*: `unlock()` on one thread **synchronizes-with** a subsequent `lock()` on another, so everything written before the unlock is visible after the lock (Ch. 25 covers the formal happens-before relation).

That second property is what people forget. A mutex is not just a gate; it is a release/acquire pair, and it is why data protected by a mutex needs no `volatile`, no fences, and no atomics.

### The standard family

| Type | Standard | Property |
|---|---|---|
| `std::mutex` | C++11 | Non-recursive, non-timed. The default |
| `std::recursive_mutex` | C++11 | Same thread may lock N times; must unlock N times |
| `std::timed_mutex` | C++11 | `try_lock_for` / `try_lock_until` |
| `std::recursive_timed_mutex` | C++11 | Both |
| `std::shared_mutex` | C++17 | Reader-writer (§24.6) |
| `std::shared_timed_mutex` | C++14 | Reader-writer with timeouts |

All are **non-copyable, non-movable**, and satisfy the *Lockable* requirements (`lock`, `try_lock`, `unlock`) — which is what lets them plug into `std::lock_guard`, `std::unique_lock`, and `std::scoped_lock`.

Key rules: locking a `std::mutex` recursively is **undefined behaviour** (not a deadlock guarantee — UB); unlocking a mutex you do not own is UB; destroying a locked mutex is UB.

**`std::recursive_mutex` is a design smell.** It is usually reached for because a public method calls another public method that also locks. The correct fix is to split each operation into a locking public wrapper and a non-locking private implementation, which also makes the locking discipline explicit. Recursive mutexes additionally hide the fact that your invariants may be observed mid-update by the re-entrant call, and they are measurably slower (an owner-thread check and a count on every operation).

### Cost

| Operation | Approximate cost |
|---|---|
| Uncontended `lock`/`unlock` | **~20 ns** — a `lock cmpxchg` (~20 cycles) plus an uncontended `unlock` store |
| Contended, short wait | ~1 µs — spin then futex wait |
| Contended, park and wake | **~1–10 µs** — syscall + scheduler wakeup latency |
| Cache-line transfer of the lock word between cores | ~40–100 ns each way |

The headline: an uncontended mutex is cheap, but *contention is 50–500× worse*, and the cost is dominated by scheduler wakeup, not by the atomic. That asymmetry is why "reduce the critical section" matters less than "reduce the probability of contention" — shard the data, use per-thread state, or use a single-writer design.

The atomic RMW itself also **bounces the lock's cache line** between cores, so even a `try_lock` that fails costs a coherence transaction (Ch. 28). A "lock-free fast path" that still touches the shared word gains less than people expect.

---

## 24.6 Reader-Writer Mutexes

A **shared (reader-writer) mutex** allows either many concurrent readers or one exclusive writer.

```cpp
std::shared_mutex m;                        // C++17
{ std::shared_lock lk(m);  read(); }        // shared ownership — many readers
{ std::unique_lock lk(m);  write(); }       // exclusive ownership — one writer
```

The intuition — "reads are common, so let them run in parallel" — is correct far less often than people assume, and this is one of the highest-value contrarian answers in the topic.

### Why `shared_mutex` frequently loses to `std::mutex`

1. **Shared acquisition is still a write.** Taking a read lock increments a shared reader count, which is an atomic RMW on a shared cache line. Every reader therefore **invalidates every other reader's copy of that line** — the readers do not scale; they contend on the bookkeeping even though they contend on nothing else. Ten reader threads on one `shared_mutex` can be slower than ten threads on a plain `std::mutex`.
2. **It is a bigger, slower object.** Acquisition is roughly 2–3× the instruction count of `std::mutex`, so under low contention it is strictly worse.
3. **Fairness and writer starvation.** With a reader-preferring policy, a continuous stream of readers can starve a writer indefinitely. Writer-preferring policies fix that but block new readers behind a waiting writer, degrading toward exclusive. libstdc++'s `shared_mutex` on Linux is a `pthread_rwlock_t` wrapper whose policy is glibc's (writer-preferring only if `PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP` is set; the default prefers readers).
4. **No standard upgrade.** There is no `shared_lock` → `unique_lock` promotion, and for good reason: two threads both attempting to upgrade deadlock. `boost::upgrade_mutex` provides a third "upgradeable" state where at most one thread may hold the upgrade right.

The rule of thumb: `shared_mutex` pays off only when the critical section is **long** (microseconds, not nanoseconds) and reads massively dominate. For a short read of a few fields, `std::mutex` wins.

### What to use instead

| Alternative | Mechanism | When |
|---|---|---|
| **Seqlock** (Ch. 26 §26.9) | Version counter; readers retry on a torn read; **readers perform no writes at all** | Small, trivially-copyable payloads read very frequently — the classic market-data snapshot |
| **RCU** (Ch. 26 §26.14) | Readers are wait-free with zero synchronization; writers copy, publish, and defer reclamation | Read-mostly structures with rare updates |
| **Atomic pointer swap to an immutable snapshot** | Writer builds a new version, `store(release)`; readers `load(acquire)` | Config, reference data, instrument tables |
| **Per-thread copies** | No sharing at all | Small state, updated rarely |

The atomic-snapshot pattern is the workhorse for reference data in trading systems: readers do a single acquire load of a `shared_ptr` or a hazard-pointer-protected raw pointer and then read freely with no synchronization on the data itself. Note `std::atomic<std::shared_ptr<T>>` (C++20) is convenient but is typically **not lock-free** and uses an internal spinlock — check `is_lock_free()` before trusting it on a hot path (Ch. 25).

---

## 24.7 RAII Lock Wrappers

Manual `lock()`/`unlock()` pairs are unsafe under exceptions and early returns. The standard wrappers apply RAII (Ch. 5 §5.8).

| Wrapper | Standard | Capability | Size/cost |
|---|---|---|---|
| `std::lock_guard<M>` | C++11 | Lock on construct, unlock on destruct. Nothing else | One reference; zero overhead |
| `std::scoped_lock<Ms...>` | C++17 | Same, but **variadic with deadlock-avoiding acquisition** | Zero overhead |
| `std::unique_lock<M>` | C++11 | Movable, deferrable, timed, manually unlockable, required by `condition_variable` | Extra `bool` for ownership state; a branch in the destructor |
| `std::shared_lock<M>` | C++14 | `unique_lock` semantics for shared ownership | Same |

```cpp
std::lock_guard  lk(m);                          // CTAD (C++17) — no <std::mutex> needed
std::scoped_lock lk(m1, m2);                     // deadlock-free multi-lock (§24.8)
std::unique_lock lk(m, std::defer_lock);         // not locked yet
std::unique_lock lk(m, std::try_to_lock);        // try; check lk.owns_lock()
std::unique_lock lk(m, std::adopt_lock);         // already locked by this thread; adopt
```

**Prefer `scoped_lock` as the default in C++17**: it is a strict superset of `lock_guard` (zero args = no-op, one arg = identical, many args = ordered acquisition). Use `unique_lock` only when you need its extra power — condition variables require it, because `wait()` must unlock and relock.

### The traps

**The unnamed-temporary bug.** This is the single most common concurrency typo and it compiles cleanly:

```cpp
std::lock_guard(m);          // WRONG — a temporary; destroyed at the semicolon.
                             // Also parses as declaring a variable named `m`!
std::lock_guard lk(m);       // correct
std::lock_guard<std::mutex>{m};  // also wrong — locks and immediately unlocks
```
`-Wunused-variable` does *not* catch it because the object has a non-trivial destructor. Clang-tidy's `bugprone-unused-raii` does, and `[[nodiscard]]`-style detection is why some codebases wrap the guards.

**Scope creep.** A `lock_guard` at the top of a long function holds the lock across I/O, allocation, and callbacks. Narrow the scope with an explicit block, or with `unique_lock` + `unlock()` at the point you are done. Holding a lock across a **callback** into user code is the standard recipe for deadlock (the callback may re-enter and lock something).

**Never hold a lock across a blocking operation** — a syscall, an allocation that may hit `mmap`, a `future::get`, or a `notify` on a CV whose waiter needs the same lock.

`std::lock_guard` and `scoped_lock` are non-movable by design (a movable lock makes ownership unclear); `unique_lock` is movable, which is how you return a lock from a factory function to implement a "locked accessor" idiom.

---

## 24.8 Deadlock-Free Multi-Locking

Acquiring two mutexes in inconsistent orders across threads is the textbook deadlock (§24.17). Three disciplines eliminate it.

**1. Global lock ordering.** Define a total order on all mutexes (by address, by a hand-assigned level, by name) and require every thread to acquire in that order. This is the only approach that scales to arbitrary code, and it is enforced by convention plus tooling (a debug-build "lock level" assertion, or clang's thread-safety analysis annotations).

**2. `std::scoped_lock` / `std::lock`.** For a *known set* of mutexes acquired together, the standard provides an all-or-nothing algorithm.

```cpp
void transfer(Account& a, Account& b, int amount) {
    std::scoped_lock lk(a.m, b.m);          // deadlock-free regardless of argument order
    a.balance -= amount;  b.balance += amount;
}
```
`std::scoped_lock` (C++17) and `std::lock` (C++11) implement a **try-and-back-off** algorithm: lock the first, `try_lock` the rest, and on any failure release everything and retry starting from the one that failed. It is deadlock-free but **not starvation-free** — livelock is possible in principle (§24.18), though the implementations back off in a way that makes it vanishingly unlikely in practice.

To adopt already-held locks: `std::lock(m1, m2); std::lock_guard g1(m1, std::adopt_lock); std::lock_guard g2(m2, std::adopt_lock);` — the C++11 form that `scoped_lock` replaced.

**3. Lock hierarchies.** Assign each mutex a numeric level and assert that a thread only ever acquires strictly-decreasing levels. A `hierarchical_mutex` is a classic interview implementation exercise:

```cpp
class hierarchical_mutex {
    std::mutex m_;
    const unsigned level_;
    unsigned prev_ = 0;
    static thread_local unsigned this_thread_level_;   // starts at UINT_MAX
public:
    explicit hierarchical_mutex(unsigned l) : level_(l) {}
    void lock() {
        if (this_thread_level_ <= level_) throw std::logic_error("hierarchy violation");
        m_.lock();
        prev_ = std::exchange(this_thread_level_, level_);
    }
    void unlock() {
        if (this_thread_level_ != level_) throw std::logic_error("out of order unlock");
        this_thread_level_ = prev_;
        m_.unlock();
    }
    bool try_lock();     // same check, returns false instead of blocking
};
```
The value is that it converts a latent, timing-dependent deadlock into a **deterministic exception on the first violating call path**, in testing, on a single thread. That "turn a race into a deterministic failure" framing is what interviewers are listening for.

### The better answer

The strongest response is usually **avoid needing two locks**. Options: coarsen to a single lock covering both objects; restructure so the operation is owned by a single thread (single-writer, Ch. 52); use a lock-free structure; or make the second acquisition unnecessary by copying the needed data out under the first lock. Multi-lock protocols are a last resort, and saying so before demonstrating `scoped_lock` scores better than demonstrating it alone.

---

## 24.9 Condition Variables

A **condition variable** lets a thread wait efficiently until another thread signals that some *predicate* over shared state may have become true. It is not a signal; it carries no state of its own. The state is yours, protected by the mutex; the CV only manages the sleep.

```cpp
std::mutex m; std::condition_variable cv; std::queue<Job> q; bool done = false;

// Consumer
std::unique_lock lk(m);
cv.wait(lk, [&]{ return !q.empty() || done; });     // predicate form — mandatory
if (!q.empty()) { auto j = std::move(q.front()); q.pop(); lk.unlock(); run(j); }

// Producer
{ std::lock_guard lk(m); q.push(job); }             // mutate UNDER the lock
cv.notify_one();                                    // notify outside is fine and often better
```

### The mechanics of `wait`

`cv.wait(lk, pred)` is exactly:

```cpp
while (!pred()) cv.wait(lk);
```
and `cv.wait(lk)` atomically (a) unlocks the mutex and (b) blocks, then (c) reacquires the mutex before returning. The atomicity of unlock-and-block is the entire reason a condition variable exists rather than a plain sleep — without it, a notify landing between "check predicate" and "sleep" would be lost (§24.10).

**The predicate overload is not optional.** It defends against both spurious wakeups and stolen wakeups (§24.10). Writing the raw `wait(lk)` without a loop is the archetypal condition-variable bug.

`std::condition_variable` works only with `std::unique_lock<std::mutex>` — that restriction lets implementations use the futex fast path directly. `std::condition_variable_any` works with any *BasicLockable*, including `std::shared_mutex` and custom locks, at the cost of an internal mutex (so it is slower); it is also the one with the `stop_token` overload (§24.2).

### `notify_one` vs `notify_all`

| | `notify_one` | `notify_all` |
|---|---|---|
| Wakes | One arbitrary waiter | All waiters |
| Cost | One futex wake | N wakes; **thundering herd** — all wake, contend for the mutex, all but one sleep again |
| Correct when | All waiters are interchangeable and each notify makes exactly one waiter's predicate true | Waiters have different predicates, or one event satisfies many |

Using `notify_one` when waiters have *different* predicates is a real bug: the woken thread's predicate may be false, so it sleeps again while the thread that could have proceeded is never woken. This is the "lost wakeup by wrong recipient" failure and it hangs the system. When in doubt, `notify_all` — correctness first — or use separate condition variables per predicate, which is the scalable fix.

**Notify inside or outside the lock?** Both are correct. Notifying *outside* avoids the woken thread immediately blocking on the mutex the notifier still holds (the "hurry up and wait" pattern), and is usually marginally faster; notifying *inside* is required if the CV or the waiter might be destroyed concurrently. The mutation must always happen under the lock.

### Cost and the low-latency verdict

A CV wait/notify round trip is **1–10 µs** — a futex syscall plus scheduler wakeup latency, plus a cold-cache restart of the woken thread. For a hot path with a single-digit-microsecond budget, that is disqualifying. Producer-consumer on a trading critical path uses a **busy-spin on a lock-free SPSC queue** (Ch. 26), or spin-then-park (§24.15) when the core cannot be dedicated. Condition variables belong on control paths, background workers, and shutdown — where 10 µs is free and burning a core is not.

---

## 24.10 Spurious and Lost Wakeups

Two distinct failure modes that get conflated.

### Spurious wakeup

`cv.wait()` may return **without any notification**. Causes: the underlying futex returning `EINTR` on signal delivery; implementations permitting a wake when a waiter is migrated between queues; and, more fundamentally, the standard permits it so that implementations can be simpler and faster on all platforms.

The consequence is that the predicate must be re-checked in a loop. That is the whole defence, and the predicate overload of `wait` writes the loop for you.

```cpp
cv.wait(lk, pred);          // safe
while (!pred()) cv.wait(lk);// identical, explicit
if (!pred()) cv.wait(lk);   // BROKEN — an `if` is not a loop
```

### Stolen wakeup

Even without spuriousness, a *third* thread can acquire the mutex between the notify and the woken waiter's reacquisition, consume the item, and leave the predicate false again. `std::condition_variable` provides no atomicity between "notified" and "runs". So the loop is required regardless of spuriousness — which is the deeper answer to "why the loop?" and the one that distinguishes candidates who have merely memorized "spurious wakeups exist".

### Lost wakeup

A notification delivered when no thread is waiting is **discarded** — condition variables are stateless. The classic race:

```cpp
// Thread A (consumer)                 // Thread B (producer)
if (!ready) {          //  1
                                       ready = true;      // 2
                                       cv.notify_one();   // 3  ← nobody is waiting yet
    cv.wait(lk);       //  4  ← sleeps forever
}
```
Two disciplines prevent it, and both are required:

1. **Mutate the shared state while holding the same mutex** the waiter uses. Then the state change cannot interleave between the waiter's predicate check and its sleep, because the waiter holds the lock across both (the unlock is part of `wait`'s atomic step).
2. **Always check the predicate before waiting** — again, the predicate overload does this.

Together they make the state, not the notification, the source of truth. A notification that arrives "too early" is harmless because the predicate is already true and the waiter never sleeps.

### Contrast with other primitives

| Primitive | Stateful? | Early signal |
|---|---|---|
| `std::condition_variable` | **No** | Lost |
| `std::counting_semaphore` | **Yes** (a count) | Remembered; a later `acquire` succeeds immediately |
| `std::latch` / `std::barrier` | Yes (a count) | Remembered |
| `std::atomic<T>::wait/notify` | Compares against a value, so it is state-based | Cannot be lost in the same way — the wait rechecks the value |
| Windows Event (manual reset) | Yes | Remembered |

That table is the crisp answer to "when would you use a semaphore instead of a condition variable": when you want the signal to be *remembered*.

---

## 24.11 C++ Semaphores

A **counting semaphore** is an atomic non-negative counter with two operations: `acquire()` (wait until the count is > 0, then decrement) and `release(n)` (increment by n and wake waiters). Unlike a condition variable it is **stateful** — a release with no waiter is remembered.

```cpp
std::counting_semaphore<8> sem(0);       // C++20; template arg = LEAST max value
std::binary_semaphore ready(0);          // alias for counting_semaphore<1>

sem.release();                           // producer: count++
sem.acquire();                           // consumer: blocks until count > 0, then count--
sem.try_acquire();
sem.try_acquire_for(10ms);
sem.try_acquire_until(deadline);
```

The template parameter is the **least** maximum value the implementation must support; `counting_semaphore<1>` permits a small, efficient representation. `max()` reports the actual bound. Exceeding it is UB.

### Semaphore vs mutex

| | `std::mutex` | `std::binary_semaphore` |
|---|---|---|
| Ownership | **Owned by the locking thread**; only the owner may unlock | **No ownership** — any thread may release |
| Recursive lock | UB | N/A (it is a counter) |
| Priority inheritance | Possible (§24.19) | Impossible — no owner to boost |
| Use | Protecting shared data | **Signalling** between threads |

The ownership distinction is the interview answer. Because a semaphore has no owner, the OS cannot apply priority inheritance, so a semaphore used as a mutex is vulnerable to unbounded priority inversion. Conversely, because a mutex has an owner, it cannot be used for cross-thread signalling (thread A cannot unlock a mutex thread B locked).

### Uses

- **Resource pools** — `counting_semaphore<N> slots(N);` bounds concurrent access to N connections, N buffers, N in-flight requests. This is the canonical use.
- **Bounded producer-consumer** — two semaphores (`empty_slots`, `filled_slots`) plus a mutex give the textbook bounded buffer without any condition variable.
- **One-shot handoff** — `binary_semaphore` for "worker, wake up", where the signal must not be lost if the worker has not yet started waiting. This is precisely the case where a CV would drop the notification.

### Implementation and cost

C++20 semaphores are specified to be usable in a **lock-free fast path**: `release()` on an uncontended semaphore with no waiters is a single atomic increment (~20 ns) with no syscall, and libstdc++/libc++ implement the blocking path on `atomic::wait`/futex with a spin phase first (§24.15). That makes them measurably cheaper than a mutex+CV pair for pure signalling — typically 2–5× on the wake path — and they are the right default for handoff in C++20 code.

Note `release(n)` waking n waiters is one syscall rather than n, which is a real advantage over `notify_all` on a CV.

---

## 24.12 Latches and Barriers

Both (C++20, `<latch>` and `<barrier>`) coordinate a group of threads reaching a common point. The distinction is reusability.

| | `std::latch` | `std::barrier` |
|---|---|---|
| Reusable | **No** — single use, counts down to zero and stays there | **Yes** — resets each phase |
| Count | Fixed at construction, decrements | Fixed per phase; `arrive_and_drop()` reduces it permanently |
| Completion function | None | **Yes** — runs once per phase, on one arriving thread, before any thread is released |
| Participants | Any thread may `count_down`; any may `wait` | The participating set |

```cpp
// latch: fan-out then join, or "wait until initialization completes"
std::latch ready(n_workers);
// worker: ...init...; ready.count_down();
ready.wait();                                    // main: proceeds when all n are done
ready.arrive_and_wait();                         // == count_down(); wait();

// barrier: iterative phase synchronization
std::barrier sync(n, []() noexcept { swap_buffers(); });   // completion fn is noexcept
for (int step = 0; step < steps; ++step) {
    compute_my_chunk(step);
    sync.arrive_and_wait();                      // all threads meet; completion fn runs once
}
```

**The completion function is the feature that matters.** It runs exactly once per phase, after all threads have arrived and before any is released, on one of the arriving threads. That gives a guaranteed-exclusive point to swap double buffers, aggregate per-thread partials, or advance a simulation clock — without any additional lock. Implementing that correctly by hand (with a CV and a generation counter) is fiddly; getting `std::barrier` for free is a good thing to know.

The completion function must be `noexcept`; an exception escaping it calls `std::terminate`.

`arrive_and_drop()` removes the calling thread from all *subsequent* phases, decrementing the expected count — the mechanism for threads that finish early in an unbalanced workload.

### Implementation notes

Both are built on `std::atomic::wait`/futex with a spin phase, so an uncontended `count_down` is an atomic decrement with no syscall. A barrier internally uses a **phase/generation counter** so that a fast thread arriving at phase k+1 cannot be mistaken for a straggler still in phase k — the "reset race" that hand-rolled barriers get wrong.

**Low-latency angle.** A barrier's cost is bounded below by the *slowest* participant, so it converts N independent latency distributions into their maximum — barrier-synchronized pipelines have p99 equal to the worst stage's p99, which is why staged trading pipelines prefer queues with backpressure (Ch. 52) over barriers. Barriers belong in bulk-synchronous parallel compute (simulations, batch risk), not on the tick-to-trade path.

Pre-C++20 the equivalents are `boost::barrier`, `pthread_barrier_t` (POSIX, not on macOS), or a hand-rolled CV + generation counter.

---

## 24.13 One-Time Initialization

Running an initializer exactly once, safely, under concurrency.

### The four mechanisms

**1. Function-local static (the "magic static", C++11).** The best default.

```cpp
Config& config() {
    static Config c = load();      // thread-safe initialization guaranteed since C++11
    return c;
}
```
The standard requires that concurrent callers block until initialization completes, and that the initialization happens exactly once. The Itanium ABI implements this with a **guard variable**: an acquire load of a byte, and — on the initialized path — nothing else. So the steady-state cost is one predictable load and branch, near zero. Only the first call touches `__cxa_guard_acquire`, which takes a lock.

Caveats: if the initializer throws, the object is not initialized and the *next* call retries. Recursive entry during initialization is UB (GCC deadlocks by design, which is at least diagnosable). `-fno-threadsafe-statics` removes the guard and the safety — sometimes used in embedded single-threaded builds, never appropriate otherwise.

Magic statics also solve the **static initialization order fiasco** (Ch. 5 §5.10) by deferring construction to first use, which is why the "construct on first use" idiom is expressed this way.

**2. `std::call_once` / `std::once_flag` (C++11).**

```cpp
std::once_flag flag;
void init_once() { std::call_once(flag, []{ heavy_init(); }); }
```
Use when the initialization is not tied to a single object's construction — e.g. one flag guarding several related setups, or when the initializer needs arguments determined at call time. If the callable throws, the flag remains unset and the next call retries (this "exception does not consume the flag" semantics is explicitly specified and is a common exam question).

`call_once` is somewhat slower than a magic static in the fast path on some implementations (an atomic load plus a call), and glibc's `pthread_once` had a well-known `fork` interaction. Prefer the magic static when it applies.

**3. `constinit` (C++20) / constant initialization.** If the value can be computed at compile time, there is no runtime initialization at all and thus no race:

```cpp
constinit static Table t = make_table();   // guaranteed static initialization, no guard
```
`constinit` asserts that the variable is constant-initialized — a compile error if not — eliminating both the guard check and any initialization-order concern. This is the strongest option and the right one for lookup tables in a hot path (Ch. 22 §22.20).

**4. Double-checked locking.** Historically the hand-rolled version, and historically *broken* in pre-C++11 C++ because the language had no memory model. It is correct today with `std::atomic` and acquire/release ordering, but there is almost no reason to write it — Ch. 25 §25.18 covers it in full as a memory-model exercise. In an interview, the correct move is to state that the pattern is a memory-model landmine and that `static`/`call_once` exist precisely so you never write it.

| Mechanism | Fast-path cost | Use when |
|---|---|---|
| `constinit` / `constexpr` | **Zero** | Value is compile-time computable |
| Function-local `static` | One acquire load + predicted branch | Object-scoped lazy init (default) |
| `std::call_once` | Atomic load + call | Flag not naturally tied to one object |
| Manual DCLP | Same as above, plus your bugs | Never |

---

## 24.14 Atomic Wait and Notification

C++20 added `wait`, `notify_one`, and `notify_all` to `std::atomic<T>` and `std::atomic_flag` — a standard, portable interface to the futex mechanism that previously required platform code.

```cpp
std::atomic<int> state{0};

// Waiter: blocks while the value EQUALS `old`.
state.wait(0, std::memory_order_acquire);   // returns when state != 0 (or spuriously)

// Notifier:
state.store(1, std::memory_order_release);
state.notify_one();                          // or notify_all()
```

### The semantics that matter

`x.wait(old)` blocks **while `x.load() == old`**. It is value-based, not event-based, and it rechecks the value after waking. That property makes it immune to the classic lost-wakeup race of a condition variable (§24.10): if the store happens before the wait, the value already differs and `wait` returns immediately without blocking. There is no window in which a notification is dropped, because the state *is* the signal.

Spurious wakeups are still permitted, so the standard usage is a loop:

```cpp
while (state.load(std::memory_order_acquire) == expected) state.wait(expected);
```

**`notify_one`/`notify_all` are cheap when there are no waiters** — implementations track a waiter count (or use the futex's own "no waiters" fast path), so an uncontended notify is a load and a predicted branch, not a syscall. This is what makes it viable to call `notify` unconditionally after every store on a hot path.

### Implementation

On Linux this maps to `futex(FUTEX_WAIT_PRIVATE)` / `FUTEX_WAKE`; on Windows to `WaitOnAddress`/`WakeByAddressSingle`; on macOS to `__ulock_wait`. For types wider than the platform's futex word (4 or 8 bytes), libstdc++ and libc++ fall back to a **hash table of proxy futex words keyed by address**, which means unrelated atomics can share a proxy and produce spurious wakeups — harmless given the loop, but it explains why `wait` on a large `atomic<T>` is less efficient.

Implementations insert a **spin phase** before the syscall (§24.15), typically a few hundred cycles, so short waits never enter the kernel at all.

### Why it matters

This is the primitive on which C++20's semaphores, latches, barriers, and `jthread` stop-token waits are built, and it is the standard replacement for hand-rolled futex code. It gives you a blocking wait with:

- No mutex required (unlike a condition variable).
- No lost wakeups by construction.
- A lock-free fast path.
- Portable behaviour.

**Low-latency use:** the natural building block for spin-then-park (§24.15) and for a wakeup on an SPSC queue that is *usually* non-empty — spin for the common case, `wait` when the queue has been empty long enough that burning the core is not worth it. Ch. 26 covers the queue side.

---

## 24.15 Spin-Then-Park Synchronization

The central engineering trade in all blocking synchronization.

| Strategy | Wait cost when short | Cost when long | CPU used while waiting |
|---|---|---|---|
| **Pure spin** | ~50–200 ns — optimal | Burns a core indefinitely; may prevent the holder from running on an oversubscribed system | 100% |
| **Pure park** (futex/CV) | ~1–10 µs — syscall + scheduler wakeup | Optimal | ~0% |
| **Spin-then-park** | ~50–200 ns for short waits | Falls back to park | Bounded burn |

**Spin-then-park** (adaptive waiting) spins for a bounded interval, then blocks in the kernel. It is what every production mutex, `atomic::wait`, semaphore, and Java's `ReentrantLock` do.

```cpp
// The shape. Spin count is empirical; ~40–1000 iterations is typical.
bool acquire(std::atomic<bool>& f) {
    for (int i = 0; i < kSpin; ++i) {
        if (!f.exchange(true, std::memory_order_acquire)) return true;
        while (f.load(std::memory_order_relaxed))          // TEST before test-and-set
            _mm_pause();                                   // or __builtin_ia32_pause / YIELD
    }
    // park: futex wait / f.wait(true)
}
```

### The details that get asked

**Test-and-test-and-set.** Spinning on `exchange` issues an atomic RMW every iteration, each of which takes the cache line in **exclusive** state (RFO, Ch. 29) and invalidates every other spinner's copy. Spinning on a plain relaxed *load* keeps the line **shared**, so all spinners read from their own L1 with zero coherence traffic, and only the eventual successful acquisition writes. On 8 contending threads this is the difference between saturating the interconnect and near-zero bus traffic. This is the highest-value detail in the section.

**`PAUSE` / `YIELD`.** The `PAUSE` instruction (x86; `YIELD` on ARM, `isb`/`wfe` variants) hints to the CPU that this is a spin loop. It (a) de-pipelines the loop so the memory-order-violation machine clear on exit is avoided, (b) frees execution resources on the sibling SMT thread, and (c) on Skylake+ costs ~140 cycles rather than ~10, which is deliberately a longer back-off. Omitting it makes a spin loop actively harmful to the hyperthread sibling.

**Exponential back-off** between spins reduces contention further, at the cost of latency for the lucky winner.

**Spin count selection.** The theoretical optimum spins for approximately the cost of a park+wake (~1–10 µs, i.e. thousands of cycles) — that is a 2-competitive strategy: you never do worse than 2× optimal. Real implementations spin far less (glibc's adaptive mutex tries ~100 iterations) because burning a core hurts every *other* runnable thread.

**Never spin on an oversubscribed system.** If the lock holder is descheduled and you spin on its core, you spin for a full scheduler quantum (milliseconds) while the holder cannot run. This is the fundamental reason spinlocks are unsafe in user space without pinning — and why kernel spinlocks disable preemption. In a virtualized environment it is worse (the vCPU itself may be descheduled), which is what **paravirtualized spinlocks** and the `PAUSE`-loop-exiting VM feature exist to mitigate.

**The low-latency conclusion:** pure spinning is correct **only** on an isolated, pinned core with no other runnable threads (Ch. 31) — which is exactly the trading hot-path configuration. Everywhere else, spin-then-park.

---

## 24.16 Futex-Backed and Adaptive Mutexes

A **futex** ("fast userspace mutex", Linux) is the kernel primitive underneath every modern blocking synchronization object. The design insight: *the uncontended path should never enter the kernel*.

```
futex(uaddr, FUTEX_WAIT, val, timeout)   // atomically: if (*uaddr == val) sleep;
futex(uaddr, FUTEX_WAKE, n)              // wake up to n waiters on uaddr
```
The `*uaddr == val` comparison is performed **by the kernel while holding the futex hash-bucket lock**, which closes the race between "userspace saw the lock held" and "the owner released it before we slept". That atomic compare-and-sleep is the whole reason a futex cannot be built from `sleep()` and a flag.

### How `std::mutex` uses it

The classic three-state lock word (Drepper's design):

| Value | Meaning |
|---|---|
| 0 | unlocked |
| 1 | locked, no waiters |
| 2 | locked, **possibly** waiters |

```
lock():   if CAS(0 -> 1) succeed → done, NO syscall
          else: set state to 2; futex_wait(&state, 2); retry
unlock(): if state was 1 and CAS(1 -> 0) → done, NO syscall
          else store 0 and futex_wake(1)
```
The "2" state exists so that `unlock` can skip the `FUTEX_WAKE` syscall when no one ever waited. Result: **an uncontended lock/unlock pair is two atomic operations and zero syscalls** (~20 ns), while the contended path costs a syscall each way. That asymmetry is the answer to "how can a mutex be cheap?"

### Variants

| Kind | Mechanism | Note |
|---|---|---|
| Normal futex mutex | As above | glibc default |
| **Adaptive** (`PTHREAD_MUTEX_ADAPTIVE_NP`) | Spins briefly before `FUTEX_WAIT` | Good for short critical sections; NP = non-portable |
| **`PTHREAD_PRIO_INHERIT`** | `FUTEX_LOCK_PI` — kernel boosts the holder's priority | Bounds priority inversion (§24.19); required for RT |
| **Robust** (`PTHREAD_MUTEX_ROBUST`) | Kernel marks the lock `EOWNERDEAD` if the owner dies | **Essential for shared-memory IPC mutexes** — otherwise a crashed process leaves the lock held forever |
| **Process-shared** (`PTHREAD_PROCESS_SHARED`) | Futex on shared memory | The futex key is the physical page, so it works across address spaces |
| `FUTEX_WAKE_OP`, `FUTEX_REQUEUE` | Move waiters between futexes without waking them | Used by CV implementations to avoid the thundering herd on `notify_all` |

`FUTEX_REQUEUE` is worth naming: when a CV's `notify_all` fires, glibc requeues waiters directly onto the *mutex's* futex rather than waking them all to immediately contend — turning an N-wakeup stampede into one wakeup plus N−1 requeues.

**Cross-process note (Ch. 3 §3.12):** a `std::mutex` in shared memory is **not** guaranteed to work — the standard says nothing about process-shared semantics, and an implementation may embed process-local pointers. Use `pthread_mutex_t` with `PTHREAD_PROCESS_SHARED` **and** `PTHREAD_MUTEX_ROBUST`, or avoid cross-process locks entirely with a lock-free SPSC ring (Ch. 26, Ch. 33).

`futex2` / `FUTEX_WAITV` (Linux 5.16+) adds waiting on multiple futexes at once, which is what game runtimes and Wine wanted and which C++ does not yet expose.

---

## 24.17 Deadlock

**Deadlock** is a state in which a set of threads each waits for a resource held by another, so none can proceed. Coffman's four **necessary and jointly sufficient** conditions:

1. **Mutual exclusion** — the resource cannot be shared.
2. **Hold and wait** — a thread holding one resource requests another.
3. **No preemption** — a resource cannot be forcibly taken from its holder.
4. **Circular wait** — a cycle exists in the wait-for graph.

Breaking any one prevents deadlock. In practice you break **circular wait** (lock ordering, §24.8) or **hold-and-wait** (acquire everything at once with `std::scoped_lock`, or acquire nothing while holding something). Preemption-breaking means `try_lock` with back-off — which trades deadlock for potential livelock (§24.18).

### The forms you will actually hit

- **AB-BA lock ordering.** Two mutexes, two orders.
- **Self-deadlock.** Recursively locking a non-recursive `std::mutex` — formally UB, in practice a hang.
- **Lock across a callback.** You hold lock A and call user code that takes lock B; elsewhere, B is held while calling into you. This is why libraries must document whether callbacks run with locks held, and why the answer should be "no".
- **Lock across a blocking wait.** Holding a mutex while calling `future::get()`, a CV wait on a *different* condition, a socket read, or `join()`.
- **The allocator.** Holding a lock and allocating: the allocator has its own internal locks, and if a signal handler or another path allocates while holding your lock in the opposite order, you deadlock. This is one reason hot paths preallocate (Ch. 55).
- **`fork()` in a multithreaded process.** Only the calling thread survives, but all mutexes are copied in whatever state they were in. If another thread held the malloc lock at fork time, the child deadlocks on its first allocation. This is why only async-signal-safe functions are legal between `fork` and `exec` (Ch. 31, Ch. 33), and why `pthread_atfork` exists.
- **Signal handler taking a lock** the interrupted thread already holds (Ch. 33).

### Detection and prevention tooling

| Tool | What it does |
|---|---|
| **ThreadSanitizer** (`-fsanitize=thread`) | Detects lock-order inversions **even when the deadlock does not occur**, by tracking the acquisition order graph. ~5–15× slowdown, ~5–10× memory. The single most valuable tool here. |
| Clang thread-safety analysis (`-Wthread-safety`, `GUARDED_BY`, `REQUIRES`) | Compile-time, zero runtime cost, annotation-based. Catches missing locks and (with `ACQUIRED_BEFORE`) ordering. |
| Helgrind / DRD (Valgrind) | Dynamic lock-order and race detection; slower than TSan |
| `gdb thread apply all bt` | Post-hoc: every thread blocked in `__lll_lock_wait` is your cycle (Ch. 58) |
| `/proc/<pid>/task/*/stack`, `pstack`, `eu-stack` | Same, without attaching a debugger |
| Lock hierarchies (§24.8) | Turns a latent deadlock into a deterministic exception |

Deadlock is **not** detected by the C++ runtime and produces no error — the process simply stops making progress while appearing alive. This is why a **watchdog** that asserts forward progress (a heartbeat counter per thread, checked externally, Ch. 59) is standard in production trading systems: it converts a silent hang into an alert and a core dump.

---

## 24.18 Livelock

**Livelock** is the state where threads are executing — consuming CPU — but making no forward progress, because each repeatedly reacts to the others in a way that undoes progress. Deadlock is threads stopped; livelock is threads spinning. Livelock is worse operationally: CPU is at 100%, the process looks busy and healthy, and it will not show up in a "blocked threads" check.

### Canonical causes

**Try-lock with symmetric retry.** The naive fix for deadlock:

```cpp
while (true) {
    lock(a);
    if (try_lock(b)) break;     // got both
    unlock(a);                  // back off... and immediately retry, in lockstep
}
```
Two threads with mirrored orders can release and retry in perfect synchrony indefinitely. The fix is **randomized exponential back-off** — desynchronize the retries. This is exactly what Ethernet's CSMA/CD does and why the analogy is worth citing.

`std::lock` / `std::scoped_lock` use a try-and-back-off scheme and are formally susceptible, though implementations vary the starting mutex which makes sustained livelock practically unobservable.

**CAS loops under heavy contention.** A lock-free compare-exchange loop where every thread's CAS fails because another thread wins is *technically* lock-free (system-wide progress is guaranteed — someone always succeeds) but individual threads can starve indefinitely. This is the precise difference between **lock-free** and **wait-free** (Ch. 26 §26.1), and the distinction is a standard question.

**Retry storms.** Application-level: N clients time out, retry simultaneously, overload the server, time out again. The fix is jittered exponential back-off plus a circuit breaker — and the "add jitter" point is the one people omit.

### Livelock vs starvation vs deadlock

| | Threads running? | Progress? | Cause |
|---|---|---|---|
| **Deadlock** | No — all blocked | None | Circular wait |
| **Livelock** | Yes — 100% CPU | None | Symmetric mutual reaction |
| **Starvation** | Yes | System progresses, **one thread** does not | Unfairness: barging locks, reader-preferring RW locks, priority scheduling |

Starvation is the mildest and most common: an unfair ("barging") mutex lets a thread that just released re-acquire immediately because its cache line is hot, while a woken waiter loses the race. That is *good* for throughput (it is why unfair locks are faster) and bad for tail latency — the same throughput-vs-tail trade that runs through Ch. 43 and Ch. 52. A **ticket lock** or an MCS lock provides FIFO fairness at a throughput cost.

### Mitigations

Randomized back-off; bounded retry counts with a fallback to a blocking lock (the standard hybrid: try lock-free K times, then take a real mutex); fair/queued locks where tail latency matters; and back-pressure so the system sheds load rather than retrying into collapse (Ch. 52 §52.16).

---

## 24.19 Priority Inversion

**Priority inversion** occurs when a high-priority thread is blocked waiting on a resource held by a low-priority thread, effectively running at the low thread's priority.

**Unbounded priority inversion** — the dangerous form — adds a *medium*-priority thread that preempts the low-priority holder. The high-priority thread now waits for the low thread, which cannot run because the medium thread is running. The delay is bounded only by the medium thread's runtime, which may be unbounded.

```
H (high):   ────── blocked on M_lock ───────────────────────────► (starved)
M (medium):        ██████ runs, preempts L ███████████████
L (low):    ██ holds lock ──── preempted ──────────────────
```

**Mars Pathfinder, 1997** is the canonical case: a high-priority bus-management task blocked on a mutex held by a low-priority meteorological task, which was preempted by a medium-priority communications task. The watchdog fired and reset the spacecraft repeatedly. The fix — enabling priority inheritance on the mutex — was uploaded to Mars. It is worth knowing because it is the standard reference and it names the mechanism.

### The protocols

| Protocol | Mechanism | Cost |
|---|---|---|
| **Priority inheritance (PI)** | While H waits on a lock held by L, L is temporarily boosted to H's priority | Bookkeeping per lock/unlock; supported by `PTHREAD_PRIO_INHERIT` / `FUTEX_LOCK_PI` |
| **Priority ceiling (PCP)** | Each mutex has a ceiling = max priority of any thread that can take it; a holder is immediately raised to the ceiling | Requires static analysis of which threads take which locks; **prevents deadlock too** |
| **Disable preemption** in the critical section | Kernel-style | Not available to user space (except via RT scheduling tricks) |
| **Avoid sharing** | Single-writer, lock-free, per-thread data | The structural fix |

```cpp
pthread_mutexattr_t attr;
pthread_mutexattr_init(&attr);
pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);
pthread_mutex_init(&m, &attr);
```

**C++ has no standard interface for this.** `std::mutex` gives no control over the protocol, so real-time code drops to `pthread_mutex_t` directly. That gap is a legitimate criticism of the standard threading library and a good thing to name.

### Where it bites in low-latency systems

Priority inversion is a real-time problem, and it becomes a trading problem the moment you use `SCHED_FIFO`/`SCHED_RR` (Ch. 31). A `SCHED_FIFO` thread that spins on a lock held by a preempted `SCHED_OTHER` thread will **spin forever on that core** — the holder can never be scheduled because the FIFO thread never yields. This is not merely slow; it is a hard hang, and it is the most common way an RT-scheduling change takes down a system.

Consequences for design:
- Never share a lock between an RT-priority thread and a normal-priority thread without PI.
- Prefer **no shared locks at all** on the hot path: single-writer ownership, SPSC queues, and seqlocks (Ch. 26) have no holder to invert.
- Note that a **semaphore has no owner**, so priority inheritance is impossible on it (§24.11) — another reason not to use semaphores as mutexes in RT code.

---

## 24.20 Lock Convoys

A **lock convoy** occurs when threads repeatedly acquire and release the same lock in a way that forces every thread through a full sleep/wake cycle, so the system's throughput collapses to the rate of context switches rather than the rate of useful work.

The mechanism:

1. Thread A holds lock L and is preempted (quantum expiry, page fault, syscall).
2. Threads B, C, D request L, fail, and **block in the kernel**.
3. A resumes, releases L, and wakes B.
4. B must be scheduled — 1–10 µs — during which the lock sits **free but unavailable**.
5. B does its short critical section and releases; now C must be woken, and so on.

The critical section might be 100 ns, but each handoff costs a full wakeup. Throughput drops by 10–100×, and — the diagnostic signature — **CPU utilization falls while the lock is contended**, because everyone is sleeping. A convoy is self-sustaining: the queue never drains, so every acquisition is contended, so every acquisition parks.

### Related pathologies

- **Thundering herd.** `notify_all` wakes N threads; all contend; one wins; N−1 sleep again. N wakeups of wasted work. Mitigations: `notify_one` when waiters are interchangeable, per-predicate condition variables, or `FUTEX_REQUEUE` (§24.16).
- **Sleeping barber / handoff latency.** Any strict-FIFO ("fair") lock forces a wakeup per handoff by construction, which is exactly why fair locks have worse throughput than barging locks.

### Why unfair locks help

An **unfair (barging)** mutex lets a thread that requests the lock right now take it ahead of a queued waiter that has not yet been scheduled. The barger's cache lines are already hot and it does not need a wakeup, so throughput improves substantially. The cost is potential starvation of the queued waiter (§24.18) and worse tail latency. Glibc's default mutex barges; Java's `ReentrantLock` defaults to unfair for exactly this reason.

The general trade, stated cleanly: **fairness improves the tail and hurts the throughput; barging does the reverse.** Knowing which one your system needs is the point.

### Diagnosis and cures

Diagnosis: high context-switch rate (`perf stat -e context-switches,sched:sched_switch`, or `vmstat`'s `cs` column), *falling* CPU utilization under load, `perf record` showing time in `futex_wait`/`__lll_lock_wait`, and off-CPU profiling (Ch. 43) showing long blocked intervals on one lock.

Cures, in order of preference:
1. **Remove the shared lock** — shard the data, use per-thread state with periodic aggregation, or adopt a single-writer design (Ch. 52).
2. **Shorten the critical section** so preemption inside it is unlikely, and never allocate, log, or syscall while holding it.
3. **Spin before parking** (§24.15) so short waits never enter the kernel — this alone dissolves most convoys.
4. **Pin threads and isolate cores** so the holder is not preempted at all (Ch. 31). On an isolated core with no other runnable threads, step 1 of the convoy mechanism never happens.
5. **Replace the lock with a lock-free queue** (Ch. 26) so there is no handoff to convoy on.

---

## Key Interview Questions

1. **What happens if a joinable `std::thread` is destroyed?** — `std::terminate()`. Silently joining would hide a blocking point in a destructor; silently detaching would leave dangling references.
2. **What does `std::jthread` add?** — A destructor that requests stop and joins, plus a built-in `std::stop_token` cancellation channel; the callable may take the token as its first parameter.
3. **Why is there no `thread::kill`?** — Asynchronous termination cannot unwind safely: locks stay held, invariants are broken, destructors are skipped. Cancellation must be cooperative.
4. **What is wrong with `hardware_concurrency()` in a container?** — It reports host logical CPUs, not the cgroup quota; use `sched_getaffinity` or read `cpu.max`.
5. **Why must a thread member be declared last in a class?** — Members are destroyed in reverse declaration order, so declaring it last makes it stop and join *before* the state it uses is destroyed.
6. **What does `thread_local` cost?** — One `%fs`-relative load under `initial-exec`; a `__tls_get_addr` call (~20–40 cycles) under `general-dynamic` in a shared library; plus a guard check per access unless it is `constinit`.
7. **Why is `thread_local` dangerous with coroutines or thread pools?** — Tasks can resume on a different thread, and pooled threads carry stale state between unrelated work items.
8. **Why does a mutex not need `volatile` on the data it protects?** — `unlock` synchronizes-with a later `lock`, establishing happens-before; the mutex is a release/acquire pair, not just a gate.
9. **How expensive is an uncontended mutex, and why?** — ~20 ns: one `lock cmpxchg` and a store, with no syscall thanks to the futex three-state design. Contended is 1–10 µs, dominated by scheduler wakeup.
10. **Why is `std::recursive_mutex` a design smell?** — It usually papers over a public-method-calls-public-method structure; split into locking wrappers and non-locking implementations. It also hides mid-update invariant observation and is slower.
11. **When does `std::shared_mutex` lose to `std::mutex`?** — Almost always for short critical sections: shared acquisition is still an atomic RMW that bounces the cache line between readers, and the object is 2–3× more expensive to acquire. It wins only for long, read-dominated sections.
12. **Why is there no lock upgrade in the standard?** — Two threads simultaneously upgrading deadlock. `boost::upgrade_mutex` adds a distinct single-holder upgradeable state.
13. **What is `std::lock_guard(m);` and why is it a bug?** — An unnamed temporary that unlocks at the semicolon (and parses as declaring a variable `m`); `-Wunused-variable` misses it, clang-tidy `bugprone-unused-raii` catches it.
14. **How does `std::scoped_lock` avoid deadlock?** — Try-and-back-off: lock one, `try_lock` the rest, release everything and retry from the failure point. Deadlock-free, not starvation-free.
15. **Design a `hierarchical_mutex`.** — A thread-local current level; `lock()` throws if the new level is not strictly lower; save and restore the previous level around lock/unlock. It turns a timing-dependent deadlock into a deterministic single-threaded exception.
16. **Why must condition-variable waits use a predicate loop?** — Spurious wakeups *and* stolen wakeups: another thread can take the mutex between the notify and your reacquisition and invalidate the predicate.
17. **How do you avoid a lost wakeup?** — Mutate the shared state under the same mutex the waiter uses, and check the predicate before waiting. The state, not the notification, is the source of truth.
18. **`notify_one` vs `notify_all`?** — `notify_one` is cheaper but is wrong when waiters have different predicates (the wrong thread wakes and sleeps again). `notify_all` risks a thundering herd; per-predicate CVs are the scalable fix.
19. **When is a semaphore better than a condition variable?** — When the signal must be remembered: a semaphore is stateful, so a release before any waiter arrives is not lost.
20. **Semaphore vs mutex?** — A mutex is *owned* by its locker (so it supports priority inheritance and cannot be unlocked by another thread); a semaphore is an unowned counter suited to signalling and resource pools.
21. **Latch vs barrier?** — Latch is single-use; barrier is reusable per phase and runs a `noexcept` completion function exactly once between phases, before releasing anyone.
22. **How is a function-local `static` made thread-safe, and what does it cost?** — A guard variable: an acquire load and a predicted branch in the steady state; only the first call takes the guard lock.
23. **What happens if a `call_once` callable throws?** — The flag stays unset and the next call retries.
24. **What makes `atomic::wait` immune to lost wakeups?** — It is value-based: it blocks only while the value still equals the expected one, so a store that precedes the wait causes it to return immediately.
25. **Why spin on a load rather than on `exchange`?** — Test-and-test-and-set keeps the line in shared state so all spinners read from their own L1; spinning on an RMW takes the line exclusive every iteration and saturates the interconnect.
26. **What does `PAUSE` do?** — Hints a spin loop: avoids the memory-order machine clear on exit, frees SMT sibling resources, and (Skylake+) back-off of ~140 cycles.
27. **Why is a pure spinlock unsafe in user space?** — If the holder is preempted you spin for a full quantum while it cannot run. Safe only on an isolated, pinned core.
28. **Explain the futex three-state lock word.** — 0/1/2 for unlocked / locked-no-waiters / locked-maybe-waiters; the 2 state lets `unlock` skip the `FUTEX_WAKE` syscall when nobody ever waited, so the uncontended path is syscall-free.
29. **List Coffman's conditions.** — Mutual exclusion, hold-and-wait, no preemption, circular wait; break any one.
30. **Why can `fork()` in a multithreaded program deadlock the child?** — Only the calling thread survives, but mutexes are copied in whatever state they held; the malloc lock held by a vanished thread hangs the child's first allocation. Hence async-signal-safe-only between `fork` and `exec`.
31. **Deadlock vs livelock vs starvation.** — Blocked and stopped / running at 100% with no progress / system progresses but one thread never does.
32. **What is unbounded priority inversion and how is it fixed?** — H waits on L's lock while a medium-priority thread preempts L indefinitely; fixed by priority inheritance (`PTHREAD_PRIO_INHERIT`) or priority ceilings. Mars Pathfinder is the reference case.
33. **Why is mixing `SCHED_FIFO` with a shared spinlock catastrophic?** — The FIFO thread never yields, so a preempted lower-priority holder can never be scheduled to release the lock — a hard hang, not a slowdown.
34. **What is a lock convoy and how do you spot it?** — Every acquisition parks and every release requires a scheduler wakeup, so throughput collapses to the context-switch rate; the signature is *falling* CPU utilization with high context-switch counts under contention.
35. **Why are unfair mutexes faster?** — A barging thread has hot cache lines and needs no wakeup, eliminating the handoff latency — at the cost of starvation risk and worse tail latency.

---

## Common Traps

- **Destroying a joinable `std::thread`** — `std::terminate()`, including on any exception between construction and `join()`.
- **Passing a reference to a thread function without `std::ref`** — arguments are copied and passed as rvalues.
- **Letting an exception escape a thread function** — `std::terminate()`; there is no propagation to the parent.
- **Sizing a pool from `hardware_concurrency()` inside a container** — ignores the cgroup quota.
- **Declaring a thread member before the state it uses** — destroyed in reverse order, so the state dies while the thread runs.
- **`detach()`** — dangling captures, racing with static destruction, and no way to shut down cleanly.
- **`thread_local` in a `dlopen`'d library** — `general-dynamic` model, a `__tls_get_addr` call per access.
- **Non-`constinit` `thread_local`** — a guard check on every access.
- **Assuming `thread_local` follows a coroutine or a pooled task.** It does not.
- **Recursively locking `std::mutex`** — undefined behaviour, not a guaranteed deadlock.
- **Reaching for `std::recursive_mutex`** instead of splitting locking and non-locking layers.
- **Assuming `shared_mutex` scales with readers** — shared acquisition is a write to a shared cache line.
- **Expecting to upgrade a `shared_lock`.** No standard mechanism; two upgraders deadlock.
- **`std::lock_guard(m);`** — unnamed temporary, unlocks immediately, and is not caught by `-Wunused-variable`.
- **Holding a lock across a callback, an allocation, a syscall, or a `future::get`.**
- **Acquiring two mutexes in different orders** instead of using `scoped_lock` or a hierarchy.
- **`if (!pred) cv.wait(lk);`** — an `if` is not a loop; spurious and stolen wakeups break it.
- **Mutating shared state outside the mutex before `notify`** — lost wakeup.
- **`notify_one` with heterogeneous waiter predicates** — wakes the wrong thread, which sleeps again while the right one never wakes.
- **Using a condition variable where the signal must be remembered** — use a semaphore.
- **Exceeding `counting_semaphore`'s `max()`** — UB.
- **An exception escaping a `std::barrier` completion function** — it is `noexcept`; `std::terminate()`.
- **Using a barrier on a latency-critical pipeline** — p99 becomes the slowest participant's p99.
- **Recursively entering a function-local static's initializer** — UB (GCC deadlocks).
- **Hand-rolled double-checked locking** — a memory-model landmine; use a magic static or `call_once`.
- **`atomic::wait` without a re-check loop** — spurious wakeups are permitted, and proxy-futex hashing makes them real.
- **Spinning on an atomic RMW** rather than on a relaxed load.
- **Spinning without `PAUSE`/`YIELD`** — starves the SMT sibling and eats a machine clear on exit.
- **Spinning on an oversubscribed or virtualized core** — you spin for a whole quantum while the holder cannot run.
- **A `std::mutex` in shared memory** — no standard process-shared guarantee; use a robust, process-shared `pthread_mutex_t` or avoid locks across processes.
- **A shared-memory mutex without `PTHREAD_MUTEX_ROBUST`** — a crashed owner leaves it locked forever.
- **`fork()` while another thread holds the allocator lock.**
- **Symmetric try-lock retry without randomized back-off** — livelock.
- **Confusing lock-free with wait-free** — a CAS loop guarantees system progress, not per-thread progress.
- **Sharing a lock between `SCHED_FIFO` and normal-priority threads without priority inheritance** — a hard hang.
- **Using a semaphore as a mutex in real-time code** — no owner, so no priority inheritance.
- **Diagnosing a convoy as "not enough CPU"** — utilization *falls* during a convoy; the fix is fewer handoffs, not more threads.

---

## Compact Recall Summary

**Threads.** `std::thread`'s destructor terminates if joinable — an exception before `join()` kills the process. `std::jthread` (C++20) requests stop and joins in its destructor and accepts a leading `std::stop_token`; make it the default, and declare thread members **last** so they stop before the state they use is destroyed. Arguments are copied and forwarded as rvalues (`std::ref` for references); an escaping exception terminates; `hardware_concurrency()` ignores cgroup quotas. Detach is almost always wrong: dangling captures, races with static destruction, no shutdown. Cancellation is cooperative by design — `condition_variable_any::wait` takes a `stop_token`, plain CVs need a `stop_callback` that locks and notifies.

**TLS and pools.** `thread_local` costs one `%fs` load under `initial-exec`, a `__tls_get_addr` call under `general-dynamic` (shared libraries — hence `-ftls-model=initial-exec`), plus a per-access guard unless `constinit`. Use it for scratch buffers, per-thread pools, and per-thread metric accumulators (avoiding contended-counter line bouncing); beware pooled-thread state leakage and coroutine migration. Thread creation is 10–50 µs, so pools amortize; work stealing uses LIFO-own/FIFO-steal deques. The low-latency architecture is not a pool: one pinned thread per isolated core, busy-spinning on an SPSC queue, single-writer state ownership.

**Mutexes.** A mutex provides exclusion *and* release/acquire ordering — that is why protected data needs no atomics. Uncontended ~20 ns (futex three-state word 0/1/2 makes both fast paths syscall-free); contended 1–10 µs dominated by scheduler wakeup, so reducing contention probability beats shortening critical sections. `recursive_mutex` is a smell; `shared_mutex` usually loses because shared acquisition is still an atomic RMW bouncing one line among readers, and there is no upgrade path — prefer seqlocks, RCU, or an atomic pointer swap to an immutable snapshot. RAII: `scoped_lock` as the default (variadic, deadlock-free via try-and-back-off), `unique_lock` when you need deferral, timing, movability, or a condition variable; never write `std::lock_guard(m);`.

**Multi-locking and deadlock.** Coffman: mutual exclusion, hold-and-wait, no preemption, circular wait — break one. In practice: a global lock order, `std::scoped_lock` for a known set, or a `hierarchical_mutex` that converts a latent deadlock into a deterministic exception. Best of all, avoid needing two locks. Real sources: AB-BA, self-deadlock on a non-recursive mutex, locks held across callbacks/allocations/syscalls, the allocator lock, `fork()` in a multithreaded process, and signal handlers. ThreadSanitizer detects lock-order inversions that have not yet deadlocked; clang thread-safety annotations catch them at compile time; a forward-progress watchdog converts a silent hang into an alert.

**Condition variables.** Stateless: the mutex-protected predicate is the truth, the CV only manages sleeping. `wait` atomically unlocks-and-blocks, which is the whole point. Always use the predicate overload — spurious *and* stolen wakeups make the loop mandatory. Mutate under the lock to avoid lost wakeups. `notify_one` only when waiters are interchangeable; `notify_all` risks a thundering herd (glibc mitigates with `FUTEX_REQUEUE`). Round-trip cost 1–10 µs — control paths only.

**Stateful primitives.** `counting_semaphore` (C++20) is an unowned counter: signals are remembered, any thread may release, so no priority inheritance is possible — use it for resource pools, bounded buffers, and one-shot handoff. `latch` is single-use; `barrier` is per-phase reusable with a `noexcept` completion function that runs exactly once before release — ideal for double-buffer swaps, wrong for latency pipelines since p99 becomes the slowest participant's. One-time init: `constinit` (zero cost) > function-local `static` (one acquire load) > `call_once` (flag survives a throwing initializer) > never hand-rolled DCLP.

**Waiting policy.** `atomic::wait/notify` (C++20) is value-based, so lost wakeups are impossible by construction; it maps to futex/`WaitOnAddress`/`__ulock_wait`, with proxy-futex hashing for wide types and an implementation spin phase. Spin ~50–200 ns, park 1–10 µs, so spin-then-park is the universal answer: spin on a **relaxed load** (test-and-test-and-set keeps the line shared) with `PAUSE`/`YIELD`, back off exponentially, then futex-wait. Pure spinning is correct only on an isolated pinned core; anywhere else a preempted holder costs you a full quantum. Futex variants worth naming: adaptive, `PRIO_INHERIT`, robust (mandatory for shared-memory IPC), process-shared, and `REQUEUE`.

**Pathologies.** Deadlock = blocked with a wait-for cycle. Livelock = 100% CPU, no progress, from symmetric retry — fix with randomized back-off; a contended CAS loop is lock-free but not wait-free. Starvation = the system progresses but one thread does not, typically from barging locks or reader-preferring RW locks. Priority inversion is bounded by PI or priority ceilings; unbounded inversion (Mars Pathfinder) needs a medium-priority thread, and mixing `SCHED_FIFO` with a lock held by a preemptible thread is a hard hang. Lock convoys collapse throughput to the wakeup rate with the signature of *falling* CPU utilization under contention — cure by removing the shared lock, shortening the section, spinning before parking, pinning to isolated cores, or replacing the lock with a lock-free queue.
