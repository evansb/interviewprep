# Chapter 24 — Threads and Synchronization

Thread-safe code needs two proofs: a lifetime proof that every thread stops using an object before it is destroyed, and an ordering proof that conflicting accesses are synchronized. Locks, condition variables, semaphores, latches, barriers, and atomic waits package common ordering and progress protocols, but none chooses ownership, queue capacity, or shutdown policy for you.

This chapter uses C++23. It presents the observable standard guarantees before implementation cost models. Chapter 20 owns stop-token theory and asynchronous composition. Chapter 25 owns the formal memory model and atomic memory orders. Chapter 26 owns lock-free data structures and reclamation.

---

## Why this matters — Core

Concurrency failures rarely reproduce on demand. A missing join can become a use-after-free; a condition-variable wait without a predicate can sleep forever; an AB–BA lock order can deadlock only under one interleaving. Because data-race behavior is undefined, a plausible result in a test is not evidence of correctness.

Low latency adds a different constraint. An uncontended synchronization path may remain in user space, while contention can transfer cache lines, enqueue waiters, enter the kernel, and depend on scheduler decisions. Busy waiting removes park/wake delay but consumes execution capacity and can stop the lock holder from running on an oversubscribed system. The right primitive follows from ownership, wait duration, contention, fairness, and overload—not from a universal timing table.

---

## 90-second screen — Core

Five facts:

1. A joinable `std::thread` must be joined or detached before destruction; otherwise the destructor calls `std::terminate`. A joinable `std::jthread` destructor requests stop and joins.
2. A mutex protects an invariant, not merely one variable. Unlocking in one thread synchronizes with a later successful lock on the same mutex, making protected writes visible.
3. A condition variable has no memory of notifications. Mutate the predicate under its mutex and wait in a predicate loop to handle notifications that arrive early, spurious wakeups, and another consumer stealing the condition.
4. Acquire several mutexes with one `std::scoped_lock`/`std::lock` call or obey a global lock order. The standard guarantees deadlock avoidance for the group operation but does not specify its acquisition algorithm or fairness.
5. `atomic::wait(old)` returns only after observing a value representation different from `old`; implementation-level spurious wakes are hidden by rechecking. A transient change back to `old` can still be missed.

Two decisions:

- Park for long or unpredictable waits and on shared/oversubscribed machines. Spin only when the expected wait is short, the owner is guaranteed execution capacity, and burning a core is acceptable; use spin-then-park when the distribution spans both cases.
- Prefer ownership designs that remove sharing: one writer, sharded state, immutable publication, or message passing. Optimize a mutex only after measuring contention, hold time, queueing, context switches, and tail latency.

---

## 24.1 Concurrency, parallelism, processes, threads, and tasks — Core

**Concurrency** means activities have overlapping lifetimes and can make progress independently. **Parallelism** means activities execute simultaneously. A single-core event loop is concurrent but not parallel; two compute threads on separate cores can be both.

| Unit | Address space | Scheduling/ownership | Communication | Failure boundary |
|---|---|---|---|---|
| Process | Normally isolated | OS process | IPC, shared memory, files, sockets | Stronger isolation |
| Thread | Shared process memory | OS thread; C++ handle owns join obligation | Shared objects, synchronization | Data races can corrupt process |
| Task | Library/application abstraction | Executor, pool, inline call, coroutine, or other policy | Result state/queue/callback | Depends on task system |

A task is not necessarily a thread. Thousands of tasks can run on a small worker pool; a task can also execute inline. `std::packaged_task` captures a result channel but does not schedule itself, as Chapter 20 explains.

### The shared-state rule

Two actions conflict when they access the same memory location, at least one modifies it, and they are performed by different threads. If conflicting non-atomic actions are not ordered by happens-before, the program has a **data race**, and its behavior is undefined. Chapter 25 gives the formal model.

The practical choices are:

- confine mutable state to one thread;
- make the state immutable after safe publication;
- protect every access participating in an invariant with the same mutex/protocol;
- use atomics with a proved memory-order protocol;
- communicate through a queue whose implementation already supplies the proof.

`volatile` is not thread synchronization. It neither makes compound operations atomic nor creates inter-thread ordering.

```text
Thread A                         Thread B
lock(m)                         lock(m)  ← cannot succeed yet
write object invariant
unlock(m) ── synchronizes-with ─► successful lock(m)
                                 read consistent invariant
                                 unlock(m)
```

The protected non-atomic fields need not themselves be atomic because the mutex orders access. Mixing locked and unlocked access to the same field reintroduces the race.

### Race conditions versus data races

A data race is a C++ memory-model violation. A race condition is broader: the result depends on timing even if every access is synchronized. “Check balance under lock, unlock, then withdraw under a later lock” can be data-race-free yet logically wrong because another transaction can interleave. Keep the entire invariant-preserving transaction in one critical section or use a versioned protocol.

### Diagnose from the threatened invariant

| Symptom | Likely violated invariant | Evidence | First repair |
|---|---|---|---|
| Counter occasionally loses updates | Non-atomic read-modify-write races | ThreadSanitizer report; conflicting stacks | Confinement, mutex, or proved atomic operation |
| Container metadata corrupts | Structural mutation overlaps access | Crash in allocator/container; race report | Protect all container access or single owner |
| Values individually valid but inconsistent together | Transaction split across lock scopes | Event trace showing interleaving | Lock the compound invariant |
| Consumer hangs despite produced work | Predicate/notification protocol broken | Waiter stack plus state snapshot | Same mutex, predicate loop, notify |
| Shutdown uses freed members | Worker outlives owner state | ASan stack; destructor timeline | Stop/wake/join before member destruction |

ThreadSanitizer is useful for dynamic data-race detection but does not prove absence of races, and its scheduling/overhead changes timing. AddressSanitizer catches some resulting lifetime errors but does not understand synchronization intent. Combine tools with code review around ownership and invariants.

---

## 24.2 Thread ownership, arguments, joining, and structured shutdown — Core

`std::thread` is a movable handle to one thread of execution. It is not the thread's return-value channel and does not automatically join:

```cpp
#include <cassert>
#include <thread>

int main() {
    int result = 0;
    std::thread worker{[&] { result = 42; }};

    worker.join();
    assert(result == 42); // thread completion synchronizes with join return
}
```

The reference capture is safe because `result` outlives the thread and is read only after `join`. Reading it before joining or otherwise synchronizing would race.

### State transitions

```text
default/moved-from thread: not joinable
          │ successful construction/move assignment target
          ▼
       joinable
        ├─ join()   ─► not joinable; caller waited for completion
        └─ detach() ─► not joinable; execution continues independently

destroy while joinable ─► std::terminate
```

`join()` can block and throws `std::system_error` for errors such as joining a non-joinable thread or attempting to join oneself. `detach()` relinquishes the C++ handle's ability to synchronize with completion. The implementation reclaims thread resources when the detached thread exits, but the program now needs some other ownership protocol for every object it touches.

Detach is rarely suitable for service-owned work. It makes orderly shutdown, result collection, and lifetime auditing harder. If detached behavior is required, move all state into independently owned storage and design process-shutdown behavior explicitly.

Moving a joinable thread transfers the join obligation. Move-assigning into an already joinable `std::thread` terminates the process, so join or otherwise resolve the destination first. `swap` is often clearer when exchanging owners.

Thread construction can throw `std::system_error` if it cannot start a thread. Arrange strong ownership before construction: materialize required state in RAII objects, then start. If starting several workers, a partially constructed pool must stop/join those already created when a later construction fails.

### Arguments and ownership

Thread construction materializes owned argument values unless wrappers or pointer-like values request reference semantics:

```cpp
std::thread a{consume, object};             // worker owns a copied/moved value
std::thread b{consume_ref, std::ref(object)}; // worker refers to object
```

`std::ref` does not extend lifetime. A pointer, reference wrapper, `span`, `string_view`, or captured `this` is safe only if its owner outlives all uses. Move a `unique_ptr` into the thread to transfer ownership; use a promise/future or caller-owned result object for return values.

Exceptions must not escape the thread's initial function; an uncaught exception calls `std::terminate`. Catch inside the thread and communicate through a result/error channel.

### `std::jthread`

`std::jthread` is movable, automatically joins, and can supply a stop token when the callable accepts one:

```cpp
#include <atomic>
#include <thread>

int main() {
    std::atomic<unsigned> iterations{0};
    {
        std::jthread worker{[&](std::stop_token stop) {
            while (!stop.stop_requested()) {
                iterations.fetch_add(1);
                std::this_thread::yield();
            }
        }};
    } // if joinable: request_stop(), then join()
}
```

Automatic join is still potentially unbounded. The worker must reach a stop point; a blocking external call may need a stop callback or API-specific cancellation. Chapter 20 owns that cancellation protocol.

### Correct member lifetime

Members are destroyed in reverse declaration order. A worker thread member that accesses other members should normally be declared after them, so its destructor stops/joins before their destruction:

```text
construction: mutex → queue → condition variable → jthread
destruction:  jthread(stop/join) → condition variable → queue → mutex
```

An explicit destructor can also stop, wake, and join before member teardown. Relying on comments without checking declaration order is a common use-after-free.

Thread creation is a resource operation. The standard does not specify stack size, kernel calls, affinity, startup latency, or reuse. Create long-lived workers when repeated creation appears in a measured hot path, but do not infer an ideal worker count from `hardware_concurrency()`; it is a hint, may return zero, and may not reflect quotas or affinity.

---

## 24.3 Mutexes, critical-section invariants, and RAII — Core

A mutex establishes exclusive ownership of a critical section. Define the invariant in words before choosing lock scope:

> While `m` is not held, `queue_size <= capacity`, indices identify constructed elements, and the accounting total equals the sum of queued quantities.

Every operation that can observe or change those related fields must use the same protocol. Protecting each field with a different lock can preserve individual values while breaking the cross-field invariant.

```cpp
#include <cassert>
#include <mutex>
#include <thread>
#include <vector>

int main() {
    std::mutex mutex;
    int counter = 0;

    auto increment = [&] {
        for (int i = 0; i < 1000; ++i) {
            std::lock_guard lock{mutex};
            ++counter;
        }
    };

    std::vector<std::jthread> workers;
    for (int i = 0; i < 4; ++i) workers.emplace_back(increment);
    workers.clear(); // joins jthreads before checking

    assert(counter == 4000);
}
```

### Mutex family

| Type | Capability | Main caution |
|---|---|---|
| `mutex` | Exclusive lock | Recursive lock by owner is undefined behavior |
| `timed_mutex` | Exclusive plus timed attempts | Timeout is not transaction rollback |
| `recursive_mutex` | Same thread may acquire repeatedly | Can hide unclear reentrancy/invariants |
| `shared_mutex` | Shared readers or one exclusive writer | Fairness/starvation policy unspecified |
| `shared_timed_mutex` | Shared/exclusive timed attempts | Same policy uncertainty |

Destroying a locked mutex or unlocking one not owned by the calling thread violates its requirements. Prefer non-recursive mutexes; split a locking public operation from a private “lock already held” helper instead of relying on recursive entry.

### RAII wrappers

| Wrapper | Use |
|---|---|
| `lock_guard<M>` | One mutex, lock now, unlock at scope exit |
| `scoped_lock<Ms...>` | One or several mutexes; grouped deadlock avoidance |
| `unique_lock<M>` | Movable ownership, defer/try/timed locking, explicit unlock; needed by `condition_variable` |
| `shared_lock<M>` | RAII shared ownership of a reader-writer mutex |

Always name the guard:

```cpp
std::lock_guard<std::mutex> lock{mutex};
```

The expression `std::lock_guard<std::mutex>{mutex};` is well-formed but creates an unnamed temporary destroyed at the semicolon, so it protects no following statement. Parenthesized CTAD spellings such as `std::lock_guard(mutex);` can parse as declarations and be ill-formed; do not teach them as a reliably compiling “temporary guard” trap.

Keep critical sections free of unbounded calls where practical: blocking I/O, a future wait, callbacks into unknown code, and allocation can extend hold time or introduce an unknown lock order. Copy/move the required work description out under the lock, release it, then perform slow work—provided doing so preserves the invariant.

Exception safety matters inside the section. A named guard releases the mutex during unwinding, but that only prevents a permanently locked mutex. If several field updates establish one invariant, use operations that cannot fail after mutation begins, prepare potentially throwing values before locking, or provide rollback. “RAII unlocked it” does not mean the protected data is consistent.

`try_lock` reports immediate acquisition failure without blocking. It is useful only when the caller has meaningful alternative work or an explicit failure path. Retrying it in a hot loop is spinning and needs the same scheduling analysis as §24.10.

### Reader-writer mutexes

A `shared_mutex` permits several shared owners:

```cpp
{
    std::shared_lock read_lock{mutex};
    read_protected_state();
}
{
    std::unique_lock write_lock{mutex};
    mutate_protected_state();
}
```

It is not a universal improvement for read-heavy data. Shared acquisition still modifies synchronization state in common implementations, and reader/writer bookkeeping can exceed a plain mutex's cost. Long concurrent reads may benefit; short reads can lose to overhead and cache-line contention. The standard gives no reader/writer preference or starvation bound and no upgrade operation.

Benchmark the target library with actual reader count, write frequency, section duration, NUMA placement, and fairness requirement. Alternatives include immutable snapshots, sharding, or single-writer ownership; their atomic/reclamation details belong to Chapters 25–26.

### Cost path

The standard gives no syscall or instruction-count guarantee. A common mutex has:

```text
uncontended:
  user-space atomic state transition → enter

contended:
  failed atomic transition
  → possibly bounded spin
  → register/park waiter in OS
  → owner unlock/wake
  → scheduler runs waiter
  → waiter reacquires
```

Even without a syscall, a contended lock word moves between cores. Measure acquisition wait, hold time, failed attempts, park/wake counts, context switches, and tail distribution. Reducing contention probability through partitioning often matters more than shortening an already tiny section.

---

## 24.4 Multi-locking and deadlock — Core

Deadlock is a cycle of threads waiting for resources held by others:

```text
Thread A: owns Accounts, waits for Ledger
Thread B: owns Ledger, waits for Accounts

Accounts ──► Ledger
    ▲           │
    └───────────┘
```

The four Coffman conditions are mutual exclusion, hold-and-wait, no preemption, and circular wait. Breaking circular wait with a global order is the common solution.

### Acquire a known group

```cpp
#include <mutex>

struct Account {
    std::mutex mutex;
    int balance = 0;
};

void transfer(Account& from, Account& to, int amount) {
    if (&from == &to) return;
    std::scoped_lock lock{from.mutex, to.mutex};
    from.balance -= amount;
    to.balance += amount;
}
```

`std::scoped_lock` delegates grouped acquisition to deadlock-avoidance semantics. The mutexes must be distinct; passing the same non-recursive mutex twice is not a valid shortcut. The standard does not specify whether the implementation locks in address order, rotates attempts, uses `try_lock`, or backs off. It does not guarantee fairness or freedom from starvation.

`std::lock(m1,m2,...)` provides grouped locking without RAII; adopt the successfully acquired mutexes immediately with named guards, or prefer `scoped_lock`.

### Global order

For locks acquired across different functions/times, assign a total order:

```text
Session lock → OrderBook lock → Audit lock
```

Every path may move only forward. A debug lock-level checker or static thread-safety annotations can make violations observable. Ordering by object address works for one dynamic group but does not describe semantic ordering across subsystems as clearly as named levels.

### Deadlock sources beyond two explicit locks

- holding a lock while invoking a callback that reenters;
- waiting on a future while holding a lock needed by its producer;
- acquiring an allocator/internal-library lock inside a section while another path reverses the order;
- joining a worker while holding a lock the worker needs to exit;
- self-locking a non-recursive mutex;
- waiting on one condition while holding an unrelated resource.

Timeouts detect or escape some waits but do not restore partially changed invariants. “Try and retry” can turn deadlock into livelock. Prefer structural ownership and one lock where a transaction truly spans both objects.

---

## 24.5 Condition variables: predicate, lost wakeups, and shutdown — Core

A condition variable is a waiting mechanism, not the condition itself. Shared state under a mutex is the condition:

```text
producer under mutex: change predicate state
producer: notify one/all

consumer under same mutex:
  while predicate false:
      atomically unlock mutex and wait
      wake, relock mutex
  consume state while lock proves predicate
```

`cv.wait(lock,pred)` is equivalent to a loop around `wait(lock)`. The wait operation atomically releases the mutex and blocks with respect to condition-variable notification ordering, then reacquires before returning.

Three cases require the loop:

1. The predicate may already be true before notification/wait; checking avoids sleeping.
2. The standard permits a wait to unblock spuriously.
3. Another consumer can acquire the mutex first and consume the state; the woken thread must check again.

### Broken then fixed

Broken:

```cpp
// ready is accessed without a consistent mutex protocol: data race and
// possible lost wakeup.
if (!ready) {
    cv.wait(lock);
}
```

Fixed:

```cpp
std::unique_lock lock{mutex};
cv.wait(lock, [&] { return ready; });
```

Producer:

```cpp
{
    std::lock_guard lock{mutex};
    ready = true;
}
cv.notify_one();
```

Both checking and mutation use the same mutex. A notification that occurs before the consumer waits is harmless because `ready` remains true. Notification can occur while holding or after releasing the mutex; both are legal. Notifying after unlock often avoids immediately waking a thread that then blocks on the mutex, but lifetime/protocol considerations can favor notification before release.

Use `notify_one` when one state transition can enable one interchangeable waiter. Use `notify_all` when shutdown enables every waiter or waiters have different predicates and any could have become true. Waking all can create a thundering herd, so separate condition variables can improve a multi-predicate design.

### Correct bounded queue

```cpp
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <utility>

template<class T>
class BoundedQueue {
public:
    explicit BoundedQueue(std::size_t capacity)
        : capacity_{capacity} {
        if (capacity_ == 0) {
            throw std::invalid_argument{"capacity must be positive"};
        }
    }

    bool push(T value) {
        std::unique_lock lock{mutex_};
        not_full_.wait(lock, [&] {
            return closed_ || queue_.size() < capacity_;
        });
        if (closed_) return false;
        queue_.push_back(std::move(value));
        lock.unlock();
        not_empty_.notify_one();
        return true;
    }

    std::optional<T> pop() {
        std::unique_lock lock{mutex_};
        not_empty_.wait(lock, [&] {
            return closed_ || !queue_.empty();
        });
        if (queue_.empty()) return std::nullopt;
        T value = std::move(queue_.front());
        queue_.pop_front();
        lock.unlock();
        not_full_.notify_one();
        return value;
    }

    void close() {
        {
            std::lock_guard lock{mutex_};
            closed_ = true;
        }
        not_empty_.notify_all();
        not_full_.notify_all();
    }

private:
    std::mutex mutex_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
    std::deque<T> queue_;
    std::size_t capacity_;
    bool closed_ = false;
};
```

The constructor rejects zero capacity; otherwise every open `push` would wait forever. `close()` wakes producers and consumers. Consumers drain existing elements, then receive `nullopt`; producers fail after close. That is an explicit shutdown/overload contract.

`condition_variable_any` accepts lock types beyond `unique_lock<mutex>` and has C++20 stop-token-aware waits. Stop theory belongs to Chapter 20. A stop callback may notify without acquiring the mutex; any mutation of the predicate still needs the mutex.

### Timed waits

Prefer predicate overloads for timed waits too:

```cpp
bool became_ready =
    cv.wait_until(lock, deadline, [&] { return ready; });
```

The boolean says whether the predicate became true, not why every underlying wake occurred. A timeout can race with publication; after reacquiring the mutex, the predicate result determines the state visible to this call.

Repeated `wait_for(relative_duration)` inside a manual loop can accidentally extend a total deadline after every spurious/stolen wake. Compute one absolute deadline and use `wait_until`, or use the predicate overload whose contract manages the loop against the supplied timeout.

Clock choice matters. Use a monotonic clock such as `steady_clock` for elapsed deadlines. Chapter 15 owns clock properties. Even then, timed waiting is not a real-time guarantee: a thread can become eligible at the deadline and run later due to scheduling.

### Cost model

Condition-variable implementations commonly keep uncontended state in user space and park through an OS primitive when necessary. The standard does not mandate a syscall, futex, fairness, wake order, or latency. Measure:

- time from predicate publication to waiter running;
- context switches and migrations;
- number of waiters woken per useful item;
- mutex reacquisition delay;
- queue depth and shutdown drain time.

---

## 24.6 Semaphores, latches, and barriers — Core

These C++20 primitives encode state that condition-variable notifications do not.

### Counting semaphores

`counting_semaphore<LeastMaxValue>` stores a count. `release(n)` adds permits; `acquire()` waits for and consumes one. A permit released before a waiter arrives remains available.

```cpp
#include <cassert>
#include <semaphore>
#include <thread>

int main() {
    std::binary_semaphore ready{0};
    int value = 0;

    std::jthread producer{[&] {
        value = 42;
        ready.release();
    }};

    ready.acquire();
    assert(value == 42);
}
```

The successful acquire synchronizes with the release that supplied its permit, so the non-atomic value is visible. Chapter 25 formalizes the edge.

The template argument is a least maximum; `max()` can be larger. Increasing the count beyond the implementation's maximum violates the semaphore precondition. Semaphores have no thread ownership: one thread can acquire and another can release. That makes them useful for resource permits and signaling, but not a drop-in mutex where ownership matters.

Use a semaphore when the state is naturally a count: N buffers, N in-flight slots, or accumulated work permits. A semaphore alone does not protect a multi-producer container index; pair it with a mutex or a proved concurrent queue.

### Latch

A `latch` is one-shot. Threads count down a fixed initial count and wait for zero:

```cpp
#include <cassert>
#include <latch>
#include <thread>

int main() {
    int left = 0;
    int right = 0;
    std::latch initialized{2};

    std::jthread a{[&] { left = 20; initialized.count_down(); }};
    std::jthread b{[&] { right = 22; initialized.count_down(); }};

    initialized.wait();
    assert(left + right == 42);
}
```

Use it for one-time fan-in such as startup. It cannot be reset.

### Barrier

A `barrier` repeats phases. Each participating thread arrives; when the expected count reaches zero, one phase-completion step runs, then the next phase begins. `arrive_and_drop` permanently reduces later expected counts.

```cpp
#include <cassert>
#include <atomic>
#include <barrier>
#include <thread>

int main() {
    std::atomic<int> phases{0};
    std::barrier sync{2, [&]() noexcept { ++phases; }};

    std::jthread a{[&] { sync.arrive_and_wait(); }};
    std::jthread b{[&] { sync.arrive_and_wait(); }};
    a.join();
    b.join();
    assert(phases.load() == 1);
}
```

The completion function must meet the nothrow-invocable requirement. A barrier makes each phase wait for its slowest participant, so load imbalance appears directly in phase latency. This suits bulk-synchronous work; it can create unnecessary coupling in a streaming pipeline.

| Primitive | State remembered | Ownership | Reusable |
|---|---|---|---|
| Condition variable | No; predicate stored separately | Wait uses mutex ownership | Yes |
| Semaphore | Permit count | No owner | Yes |
| Latch | Remaining arrivals | No owner | No |
| Barrier | Phase and expected arrivals | Participants/tokens | Yes |

Implementations may use atomics and OS waiting internally, but C++ does not specify their layout, lock freedom, syscalls, or fairness.

---

## 24.7 One-time initialization and atomic wait — Core

### Function-local static

Initialization of a block-scope static is thread-safe. Concurrent callers wait for one initialization attempt; if it throws, a later call can retry:

```cpp
Config& config() {
    static Config value = load_config();
    return value;
}
```

The standard does not expose the guard representation or steady-state instruction sequence. Recursive reentry into the declaration while initialization is in progress has undefined behavior.

### `call_once`

Use `std::once_flag` and `std::call_once` when the action is not naturally one object's construction:

```cpp
#include <cassert>
#include <mutex>
#include <thread>
#include <vector>

int main() {
    std::once_flag flag;
    int calls = 0;
    auto initialize = [&] {
        std::call_once(flag, [&] { ++calls; });
    };

    std::vector<std::jthread> threads;
    for (int i = 0; i < 4; ++i) threads.emplace_back(initialize);
    threads.clear();
    assert(calls == 1);
}
```

If the selected callable throws, that execution is exceptional and another call can attempt initialization. Successful completion synchronizes with returning calls as specified.

`constinit` requires static/thread-storage variables to be constant-initialized; when the initializer is truly constant, runtime one-time synchronization is unnecessary. It does not make a mutable object thread-safe after initialization.

### Atomic wait and notification

C++20 atomics provide value-based waiting:

```cpp
#include <atomic>
#include <cassert>
#include <thread>

int main() {
    std::atomic<int> state{0};
    int payload = 0;

    std::jthread producer{[&] {
        payload = 42;
        state.store(1, std::memory_order_release);
        state.notify_one();
    }};

    state.wait(0, std::memory_order_acquire);
    assert(state.load(std::memory_order_acquire) == 1);
    assert(payload == 42);
}
```

Memory-order derivation belongs to Chapter 25. Operationally, `wait(old)` repeatedly checks the atomic value and blocks as needed until it observes a value representation different from `old`. The standard call does not return merely because an underlying OS wait woke spuriously; the library rechecks.

Notification is a hint to unblock waiters, not stored state. Correctness comes from the atomic value. If the value changes from 0 to 1 and back to 0 before the waiter observes 1, `wait(0)` may continue waiting: value-based waiting does not count transitions. Use a monotonic generation counter or queue when every event matters, while accounting for counter wrap.

Compared with a condition variable, atomic wait can avoid a separate mutex for a single atomic predicate. It does not make a compound non-atomic invariant safe, promise fairness, or guarantee a futex implementation.

---

## 24.8 Worked design: a worker that stops, wakes, and drains — Core

Requirements:

- producers can enqueue while open;
- shutdown rejects new work;
- the worker drains accepted work;
- no thread touches members after destruction begins;
- the worker does not remain asleep after close.

```cpp
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

class Worker {
public:
    Worker() : thread_{[this] { run(); }} {}

    bool submit(int value) {
        {
            std::lock_guard lock{mutex_};
            if (closed_) return false;
            queue_.push_back(value);
        }
        ready_.notify_one();
        return true;
    }

    ~Worker() {
        {
            std::lock_guard lock{mutex_};
            closed_ = true;
        }
        ready_.notify_all();
        thread_.join();
    }

private:
    void run() {
        for (;;) {
            std::unique_lock lock{mutex_};
            ready_.wait(lock, [&] {
                return closed_ || !queue_.empty();
            });
            if (queue_.empty() && closed_) return;
            int value = queue_.front();
            queue_.pop_front();
            lock.unlock();
            process(value);
        }
    }

    static void process(int);
    std::mutex mutex_;
    std::condition_variable ready_;
    std::deque<int> queue_;
    bool closed_ = false;
    std::thread thread_; // declared last, joined before earlier members die
};
```

The destructor first changes the predicate under the mutex, then notifies, then joins. The worker exits only when closed and drained. It processes outside the lock, so producers do not wait for `process`.

The class assumes no other thread calls `submit` concurrently with object destruction; public-method lifetime is a caller ownership requirement. If destruction can race with calls, the object itself needs shared external lifetime management.

### Diagnosis: “shutdown sometimes hangs”

Suppose the destructor sets `closed_` without the mutex or forgets `notify_all`. Possible traces:

- worker checks `closed_ == false`, begins waiting, destructor writes without synchronization: data race and possible permanent wait;
- destructor writes correctly but does not notify: predicate is true, but a sleeping worker has no reason to recheck;
- destructor joins while holding `mutex_`: worker wakes but cannot acquire the mutex to observe close, so destructor waits for worker while worker waits for destructor.

The repair is the ordered protocol shown above. The condition variable does not replace the predicate, and join must happen without holding a lock the worker needs.

### Performance and overload

This queue is unbounded. A production version needs capacity and a full-queue policy. Processing outside the lock reduces hold time, but one worker still serializes service and queue wait grows under sustained overload. Record acceptance/rejection, queue depth, oldest-item age, handler duration, wake count, and shutdown drain time.

---

## 24.9 Thread-local storage and thread pools — Role-specific

### Thread-local storage

`thread_local` gives each thread a distinct object instance with thread storage duration. Initialization may be static or dynamic; destruction of a constructed nontrivial instance occurs at thread exit.

```cpp
thread_local unsigned local_count = 0; // linkage is not implied by thread_local
```

At namespace scope, `thread_local` alone does **not** give internal linkage. Add `static`, use an unnamed namespace, or otherwise choose linkage according to the ordinary rules. In a header, careless definitions can still create ODR/linkage problems; an inline thread-local variable is one C++17 solution when one entity is intended.

TLS removes sharing for per-thread counters, scratch buffers, allocator caches, and batching state. It also duplicates memory per thread, complicates aggregation, and can make destructor order/plugin lifetime difficult. An address or reference to one thread's TLS object may be passed elsewhere, but then the owner thread's exit can invalidate it.

Access cost depends on platform ABI, linkage model, executable/shared-library placement, and compiler optimization. Do not assign a universal “one instruction” or fixed-cycle cost; inspect generated code for the deployed build if it matters.

### Thread pools

A pool amortizes worker creation and maps many tasks onto a bounded set of threads. Its semantics depend on design axes:

| Axis | Choices | Consequence |
|---|---|---|
| Queue capacity | Bounded/unbounded | Backpressure versus memory/latency growth |
| Wait policy | CV, semaphore, atomic wait, spin, hybrid | CPU use versus wake latency |
| Placement | Global queue, per-worker queue | Contention versus balance |
| Distribution | Work sharing, work stealing, static assignment | Locality, fairness, complexity |
| Task representation | Inline fixed descriptor, type erasure, pointer | Allocation/code-size/indirection |
| Shutdown | Drain, cancel queued, immediate stop | Completion and ownership semantics |
| Error/result | Callback, future, result slot | Allocation and blocking behavior |

**Work sharing** lets producers or workers push tasks to a common/target queue. It balances simply but creates a contended coordination point. **Work stealing** gives workers local deques and lets idle workers steal from peers; local work improves locality, but steals add synchronization and make scheduling less deterministic. The exact deque algorithm belongs to Chapter 26 if lock-free.

Do not size a CPU pool solely from `hardware_concurrency()`. Consider affinity, process quota, SMT, blocking fraction, other services, NUMA, and task dependency. Measure runnable threads, queue time, migrations, steals, context switches, and throughput/tail latency.

For a latency-critical pipeline, static ownership—one long-lived thread per stage/core and bounded SPSC handoff—can trade flexibility and core utilization for locality and predictable scheduling. It is not a universal pool replacement; batch and mixed workloads often value utilization and balancing more.

### Pool shutdown and dependency traps

A pool needs an explicit state machine:

```text
running ── stop admission ──► draining
draining ── queue empty + workers idle ──► stopped/joined

or:
running ── cancel queued ──► cancelling
cancelling ── running tasks finish/stop ──► stopped/joined
```

Destroying the queue before workers exit is a lifetime bug. Joining workers before waking them is a shutdown deadlock. Cancelling queued tasks must complete their futures/callbacks with an error or stopped outcome; silently deleting task records can leave consumers waiting forever.

A task that submits child work to the same bounded pool and then blocks waiting for it can deadlock when every worker does the same: all workers wait, while children remain queued. Remedies include helping execute queued work while waiting, structured nonblocking continuation, reserving capacity for dependencies, or rejecting blocking waits inside workers.

For queue policy, distinguish:

- **global FIFO:** simple/fair-ish arrival ordering, shared contention;
- **per-worker LIFO:** recently spawned work is cache-local, but external ordering changes;
- **stealing from the opposite end:** balances idle workers, but steals and victim choice add variance;
- **static routing:** strongest ownership/locality, weakest dynamic balance.

No choice gives capacity, fairness, cancellation, or exception transport automatically.

---

## 24.10 Spin, park, and adaptive waiting — Deep dive

Waiting strategy chooses where to spend delay:

| Strategy | Short wait | Long wait | Main risk |
|---|---|---|---|
| Spin | Avoids park/wake transition | Burns CPU and coherence traffic | Holder may be descheduled; starvation/interference |
| Park | Gives up CPU | Scheduler/OS must wake waiter | Wake delay and context switch |
| Spin-then-park | Captures some short completions | Eventually yields CPU | Tuning and duplicate complexity |

Spinning is not made correct by pinning, nor incorrect by oversubscription; correctness comes from the atomic/lock protocol. Scheduling conditions determine whether it is sensible. If the holder cannot run because waiters consume all execution capacity, spinning increases the wait.

A well-designed spin loop usually reads shared state without issuing a write/RMW every iteration, then attempts acquisition only when it appears available. Repeated RMWs contend for exclusive ownership of the cache line. C++23 has no standard portable CPU pause intrinsic; platform code can use an architecture/compiler hint behind a qualified abstraction.

### Choose from the wait distribution

Use these inputs:

- expected and tail wait duration;
- whether the owner runs on a dedicated core;
- oversubscription and virtualization;
- number of waiters and cache-line topology;
- power/thermal budget;
- cost of delayed wake versus cost of a burned core;
- fairness requirement.

Measure on the deployment system. A spin iteration count is not portable across CPU generations, clock policy, standard-library implementation, or VM scheduling. Adaptation based on observed hold times can help, but changes feedback under load and needs stability tests.

### Futex/adaptive implementations

Linux futexes, Windows wait-on-address mechanisms, and Darwin userspace locks can support a user-space fast path plus kernel parking. A typical shape is:

```text
try user-space state transition
  ├─ success → continue without kernel wait
  └─ failure → optionally spin
                → kernel wait only if state still matches
unlock/change state
  └─ wake waiter if implementation tracks one
```

The kernel-side compare-before-sleep closes the race between observing an old value and actually sleeping. Exact lock words, waiter states, requeue operations, fairness, adaptive counts, and syscall behavior are implementation/version details. Do not infer them from `std::mutex`'s interface.

### Choose-spin-or-park scenario

A feed thread on a dedicated core consumes a queue that is usually nonempty but occasionally pauses for a burst gap. A background compactor shares a core pool and waits seconds between jobs.

- For the feed, compare pure polling with a bounded spin followed by `atomic::wait`; measure empty-period distribution, CPU budget, and producer interference.
- For the compactor, park immediately; burning a core cannot improve useful latency enough to justify the wait length.
- If the feed shares a virtual CPU, pure spinning may prevent or delay the producer/owner from running. Hybrid waiting is safer.

Rollback criterion: if spinning does not improve the target latency percentile or causes throughput/power/interference regressions, reduce the budget or park.

---

## 24.11 Progress pathologies — Deep dive

### Deadlock

Threads are blocked in a circular wait. Diagnose with thread dumps and lock-order graphs. Prevent with ownership, global ordering, grouped locking, and never joining/waiting while holding a needed lock.

Deadlock may involve resources other than mutexes: queue capacity, thread-pool workers, file locks, or callbacks. Build a wait-for graph whose nodes include threads/tasks and resources. A cycle shows a reachable deadlock if all edges can coexist. A watchdog heartbeat detects lack of progress but cannot repair inconsistent work; capture stacks and ownership state before restarting.

### Livelock

Threads execute but repeatedly undo progress. Symmetric `try_lock`, release, and immediate retry can make two threads move in lockstep. Add asymmetric/randomized backoff or use a grouped acquisition primitive. Backoff reduces probability; a protocol proof should still identify progress assumptions.

High CPU with little completed work distinguishes it operationally from deadlock. Retry counters and failed-CAS/try-lock metrics expose it. Randomization is a performance/progress technique, not a deterministic completion bound.

### Starvation

The system progresses while one participant repeatedly loses access. Standard mutexes and shared mutexes generally do not promise FIFO fairness. Measure per-thread wait distributions rather than only aggregate throughput.

A throughput-optimized barging lock may let a running thread reacquire while a parked waiter is being scheduled. That can preserve cache locality yet create a severe outlier. If fairness is a requirement, use a primitive/protocol with documented fairness on the deployment platform or route work through an explicit queue.

### Priority inversion

A high-priority thread waits for a lock held by a low-priority thread; a medium-priority thread can preempt the holder and extend the high-priority wait. Priority inheritance/ceiling protocols are OS-specific; standard `mutex` exposes no portable control. Avoid shared locks across incompatible scheduling classes or use platform real-time primitives with a verified protocol.

A semaphore has no owner, so owner-based priority inheritance does not naturally apply to it. That matters when it is misused as a mutex in priority-scheduled code.

Priority inheritance raises the holder while a higher-priority waiter is blocked; a priority ceiling raises a holder according to a preassigned resource ceiling. Both require OS support and correct configuration. They do not shorten an overlong critical section, remove nested lock cycles, or control unrelated I/O delays.

### Lock convoy

Many threads repeatedly block behind one lock, and each handoff depends on wake/scheduling. A preempted holder or waiter can serialize progress around scheduler latency. Symptoms include long off-CPU lock waits, high context-switch counts, growing queues, and sometimes falling useful CPU utilization.

Shortening the protected computation helps, but the larger fixes are reducing the number of contenders, sharding state, batching under one acquisition, or keeping the holder runnable. Spinning can avoid parking for genuinely short waits but worsens overload when the holder is descheduled.

### Thundering herd

`notify_all` wakes many waiters for work only one can consume. They contend for the mutex and most sleep again. Use `notify_one` for interchangeable one-item waiters, separate predicates/CVs, permits, or an implementation/framework with targeted wakeup.

| Pathology | Threads executing? | System progress? | Primary evidence |
|---|---|---|---|
| Deadlock | Usually blocked | None | Wait-for cycle |
| Livelock | Yes | None | High CPU, repeated failed retries |
| Starvation | Some | Yes, victim does not | Per-thread wait outlier |
| Convoy | Intermittently | Slow | Off-CPU waits/context-switch chain |
| Priority inversion | Medium/holder scheduling dependent | Delayed | Priority trace and ownership |

Fixes should start structurally: reduce sharing, shard, shorten ownership duration, avoid blocking inside locks, bound queues, and align scheduling policy with ownership. Replacing one lock type without measuring can move the pathology rather than remove it.

---

## 24.12 Primitive selection and traps — Reference

### Selection table

| Requirement | Candidate | Key precondition/trade-off |
|---|---|---|
| Protect compound invariant | `mutex` + named RAII guard | All accesses use protocol |
| Read concurrency on long sections | `shared_mutex` | Benchmark; fairness unspecified |
| Acquire known lock group | `scoped_lock` | Distinct mutexes; no fairness promise |
| Wait for predicate over compound state | Condition variable | Same mutex for predicate; loop |
| Count remembered permits/resources | Semaphore | Do not exceed max; no ownership |
| One-time fan-in | Latch | Not reusable |
| Repeated bulk phase | Barrier | Slowest participant gates phase |
| One atomic value change | `atomic::wait/notify` | ABA/change-back can be missed |
| One-time lazy initialization | Local static / `call_once` | Recursive initialization unsafe |
| Long-lived cancellable thread | `jthread` | Stop must reach worker; destructor joins |
| Many tasks | Explicit pool/executor | Capacity, placement, results, shutdown |

### Common traps

| Trap | Failure | Repair |
|---|---|---|
| Destroy joinable `thread` | `terminate` | Join or transfer ownership; detach only by design |
| Capture local by reference then detach | Use after lifetime | Move owned state or structured join |
| Read a “mostly locked” field unlocked | Data race | One consistent protocol |
| Guard only one field of a compound invariant | Logical race | Lock transaction/invariant |
| Unnamed brace `lock_guard` temporary | Unlocks at semicolon | Name guard |
| Hold A while future producer needs A | Deadlock | Release before wait/redesign dependency |
| CV predicate modified without same mutex | Race/lost wake | Mutate and check under same lock |
| Use `if` around CV wait | Spurious/stolen wake bug | Predicate loop/overload |
| Join worker while holding its mutex | Deadlock | Publish stop, unlock, notify, join |
| Assume `notify_one` wakes a suitable differing predicate | Possible permanent wait | Separate CVs or notify all |
| Treat semaphore as container protection | Index/data race | Add mutex/proved concurrent structure |
| Expect barrier to improve unbalanced pipeline | Phase waits for slowest | Queue/decouple stages |
| Expect `atomic::notify` to count events | Transient changes lost | Counter/queue protocol |
| Assume TLS implies internal linkage | ODR/linkage bug | Choose linkage explicitly |
| Assume `shared_mutex` is fair/faster | Starvation or overhead | Benchmark/choose ownership |
| Spin on oversubscribed holder | Wastes capacity, delays owner | Park or hybrid |

---

## Recall and practice

### Recall card

1. Thread lifetime is ownership: join/detach before `thread` destruction; `jthread` requests stop and joins but can still wait indefinitely.
2. A mutex protects an invariant and supplies inter-thread ordering; do not mix protected and unprotected accesses.
3. Name RAII guards, acquire lock groups together, and use a global order across dynamic call paths.
4. A CV notification carries no state. Predicate mutation/checking use one mutex, and waiting uses a loop.
5. Semaphores remember permits, latches count down once, and barriers repeat phases.
6. `atomic::wait` is value-based, hides spurious OS wakes, and can miss a change that returns to the old value.
7. `thread_local` controls storage duration per thread, not linkage; pools still need capacity, placement, and shutdown policies.
8. Spin/park is a scheduling and latency trade-off. Contention, owner execution, queueing, and fairness must be measured.

### Questions

1. Why is `join` both a lifetime operation and a visibility/synchronization operation?
2. Give a data-race-free race condition involving two separately locked steps of one transaction.
3. Which objects must outlive a thread started with `std::ref`, a pointer, or a `span`?
4. Why can `scoped_lock` prevent AB–BA deadlock without promising fairness or a particular acquisition order?
5. Give all three reasons a condition-variable predicate must be checked in a loop.
6. When is a semaphore a better representation than a condition variable, and what state does it not protect?
7. Why can `atomic::wait(0)` remain blocked after another thread briefly stored 1 and restored 0?
8. Compare a global thread-pool queue, per-worker work stealing, and static stage ownership for locality, balance, and tail latency.
9. Under which scheduling assumptions would you spin, park, or spin-then-park?
10. Distinguish deadlock, livelock, starvation, priority inversion, and convoy using observed progress.

### Code-reading puzzle

```cpp
std::mutex mutex;
std::condition_variable ready_cv;
bool ready = false;

void publish() {
    ready = true;
    ready_cv.notify_one();
}

void consume() {
    std::unique_lock lock{mutex};
    if (!ready) ready_cv.wait(lock);
    use_published_data();
}
```

Identify the data race, lost-wakeup window, spurious/stolen-wakeup problem, and missing publication invariant. Rewrite the protocol in words before rewriting the code.

### Design exercise

Design two bounded producer-consumer queues with the same close-and-drain semantics:

1. mutex plus `not_empty`/`not_full` condition variables;
2. `empty_slots`/`filled_slots` semaphores plus a mutex protecting indices/storage.

Specify capacity-zero handling, producer behavior after close, consumer drain behavior, exactly which notifications/permits unblock shutdown, and why semaphore permits alone do not serialize multiple producers. Then propose tests for full/empty races, close under load, conservation of items, blocked-thread release, and latency under contention.

### Next prerequisite

Chapter 25 formalizes data races, synchronizes-with, happens-before, atomics, and memory orders. Before continuing, be able to draw the ordering edge for mutex unlock/lock, thread completion/join, semaphore release/acquire, and the release/acquire atomic-wait example—without yet relying on hardware instruction folklore.
