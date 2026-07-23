# Chapter 20 — Modern Asynchronous C++

Asynchronous code separates starting an operation from observing its completion. Correctness depends on four contracts: who owns the operation state, how completion communicates a value/error/cancellation, where continuation code runs, and when every referenced object may be destroyed.

This chapter uses standard C++23. Futures, promises, packaged tasks, `std::async`, stop tokens, and `std::jthread` are standard. C++23 has no standard executor, scheduler, sender/receiver library, event loop, or asynchronous socket API; those sections explain transferable models and label framework pseudocode explicitly. Chapter 19 owns coroutine language mechanics. Chapter 24 owns mutexes, condition variables, blocking waits, and worker-pool synchronization.

---

## Why this matters — Core

“Asynchronous” does not mean parallel, non-blocking, or low latency. Deferred work may execute synchronously in the waiter. A future may block its caller. A coroutine suspends only if its awaiter says so. An event loop can resume a continuation inline and let one long handler delay every operation behind it.

The most damaging failures are lifetime failures: a callback captures a dead object, a promise disappears without producing a value, cancellation destroys a coroutine frame while the kernel still owns its buffer, or shutdown stops the executor before queued completions run. The performance model follows the same flow. Each handoff can allocate state, enqueue work, wake a thread, cross into the kernel, transfer cache lines, or wait behind earlier tasks. A sound design names those boundaries and bounds the queues before trying to optimize them.

---

## 90-second screen — Core

Five facts:

1. A `promise`/`future` pair refers to a one-shot shared state that becomes ready with a value or exception. The standard specifies behavior, not a mutex, condition variable, refcount layout, or fixed allocation count.
2. `future::get()` waits, returns or rethrows, and invalidates that `future`. Calling it without a valid state violates a precondition. `shared_future::get()` can be called repeatedly.
3. Destroying or otherwise releasing the last reference to a shared state created by `std::async` may wait for an unfinished associated thread. Ordinary promise- and packaged-task-created future states do not gain that special wait-on-release rule.
4. Cancellation in standard C++ is cooperative. `request_stop()` publishes a request; the operation must poll it or register a callback and still define what happens to partial work and in-flight I/O.
5. Blocking a thread, suspending a coroutine, and describing work are different. A future wait blocks; `co_await` may suspend; a sender-like description does nothing until connected and started.

Two decisions:

- Use futures for coarse, one-shot result transfer when blocking retrieval and weak composition are acceptable. Use a callback/reactor or coroutine framework when many operations must wait without dedicating one thread each.
- Before permitting cancellation or timeout, choose an ownership protocol: exactly one terminal completion, no use after cancellation, and no destruction until the external operation has either completed or acknowledged cancellation.

---

## 20.1 Synchronous, concurrent, and asynchronous execution — Core

A synchronous function completes before returning:

```text
caller ── call ──► operation ── value/error ──► caller continues
```

An asynchronous initiation function returns before the operation completes:

```text
caller ── start ──► operation state ── submit ──► execution context / OS
   │                                                        │
   └── continues or waits ◄── completion queue ◄── result ──┘
```

Concurrency means lifetimes overlap. Parallelism means work actually executes at the same time on different processing resources. An asynchronous operation can have neither: `std::launch::deferred` starts only when a waiter forces it, on that waiting thread.

| Model | Caller after initiation | Where work runs | Typical use | Main failure |
|---|---|---|---|---|
| Direct call | Continues after result | Calling thread | Short local computation | Caller latency includes all work |
| Future + worker | May block later | Worker chosen separately | Coarse one-shot task | Shared-state and wait lifetime |
| Callback event loop | Returns to loop | Loop or worker context | Many I/O operations | Callback lifetime/reentrancy |
| Coroutine I/O | Returns when suspended | Resumption context chosen by awaiter/framework | Blocking-shaped async flow | Frame and in-flight operation lifetime |
| Sender-like description | Nothing until started | Scheduler/execution context in composition | Structured async composition | Operation-state ownership and completion contract |

### The three verbs

Keep these distinct:

- **Block:** the current thread cannot do useful work until a condition changes. `future::get`, `future::wait`, and `jthread::join` can block.
- **Suspend:** a coroutine saves enough state to continue later and returns control to its caller/executor. Suspension is governed by the awaiter and is not guaranteed at every `co_await`.
- **Describe:** a lazy operation graph records what should happen. No resource is committed until the graph is started, unless a particular framework says otherwise.

There is also **polling**: repeatedly check readiness while retaining the thread. Busy polling trades a core and memory traffic for avoiding a park/wake transition. Periodic polling adds detection delay. Chapter 24 owns the spin-versus-park mechanics.

### Completion is a protocol

Every asynchronous API needs answers to:

1. What owns the operation state?
2. How many terminal completions are permitted?
3. Can initiation complete inline before it returns?
4. On which execution context does the callback/continuation run?
5. What happens when the operation is cancelled?
6. How are overload and queue saturation reported?
7. Which objects must remain alive through completion?

An API that says only “calls you later” is incomplete. “Later” might be inline due to cached data, on a worker, on a reactor, or never if shutdown discards the queue.

---

## 20.2 Tasks, shared state, and result channels — Core

A **task** is a unit of work plus a completion contract. The completion can carry:

- a value, possibly no value for `void`;
- an error, commonly an `exception_ptr` or error value;
- cancellation/stopped as a distinct outcome or a designated error.

Standard futures use a shared state with value-or-exception readiness. They do not have a distinct cancelled result. A library may represent cancellation by an exception, error code, or separate channel.

```text
producer handle                 shared state                 consumer handle
promise / packaged_task ─────► [not ready]
                                  │
                     set_value ───┤──► [value, ready] ─────► future::get
                 set_exception ───┤──► [exception, ready] ─► future::get rethrows
                  producer dies ──┘──► [broken_promise] ───► future::get rethrows
```

The state has a lifetime independent of either handle. A producer may die while a consumer remains; the broken-promise rule makes that abandonment observable. A future may be moved to another scope while the state remains alive.

### Standard guarantee versus implementation

| Property | C++23 guarantee | Common but not guaranteed |
|---|---|---|
| One state holds readiness and value/exception | Yes | Exact object layout |
| Producer and waiter can synchronize through readiness | Yes | Mutex + condition variable |
| `promise` supports uses-allocator construction | Yes | One heap allocation |
| `packaged_task` owns a callable and state association | Yes | Separate allocation for each |
| Waiting may block | Yes | Particular OS primitive such as futex |

The allocator-aware `promise` constructors allow the shared-state allocation strategy to use a supplied allocator. `std::packaged_task` allocator support was removed in C++17 and is absent in C++23. None of this gives a portable allocation count: an implementation can combine or split internal state, and a supplied allocator can itself choose any storage strategy.

```cpp
#include <cassert>
#include <future>
#include <memory>

int main() {
    std::promise<int> promise{
        std::allocator_arg, std::allocator<int>{}
    };
    auto future = promise.get_future();
    promise.set_value(42);
    assert(future.get() == 42);
}
```

For latency reasoning, instrument the actual implementation. Typical costs include state allocation, atomic/reference-state traffic, a producer-to-consumer cache transfer, and a park/wake if the consumer waits. A ready result can avoid parking but still pays state access and indirection.

---

## 20.3 Futures and promises — Core

`std::promise<T>` is the producer handle; `std::future<T>` is the one-consumer handle:

```cpp
#include <cassert>
#include <future>
#include <thread>

int main() {
    std::promise<int> promise;
    std::future<int> future = promise.get_future();

    std::thread producer{[p = std::move(promise)]() mutable {
        p.set_value(42);
    }};

    assert(future.get() == 42);
    assert(!future.valid());
    producer.join();
}
```

The synchronization associated with making the state ready and successfully waiting for it makes producer-side effects sequenced before readiness visible after the wait. Chapter 25 owns the happens-before derivation.

### Retrieval and validity

`future::valid()` reports whether the handle refers to a shared state. These operations require a valid state:

- `get()` waits if necessary, returns/moves the value or rethrows the stored exception, then releases the future's state;
- `wait()` blocks until ready;
- `wait_for(duration)` and `wait_until(time_point)` return a readiness status.

Calling `get()` a second time violates the `valid()` precondition. The standard does not require a `future_error` diagnostic for that misuse, though an implementation may provide one. This differs from `promise::get_future()` called twice: that operation is specified to throw `future_error` with `future_errc::future_already_retrieved`.

`std::shared_future<T>` is copyable and permits multiple `get()` calls. For non-reference `T`, `get()` returns `const T&`; consumers must not use that reference after the shared state dies. Sharing a future enables multiple readers but adds shared ownership and does not make the referred-to `T` safe for mutation.

### Waiting, polling, and deferred status

`wait_for`/`wait_until` can report:

- `ready`: a value or exception is stored;
- `timeout`: the deadline elapsed before readiness;
- `deferred`: the state represents deferred `std::async` work that has not been forced.

A zero-duration wait is a poll. Polling in a tight loop consumes execution capacity and repeatedly touches shared state. Sleeping between polls reduces traffic but adds detection latency. A blocking wait yields execution to the implementation/OS but pays wake-up and scheduling delay. Choose from the latency budget and core-ownership model; do not infer a universal winner.

Deferred status requires special handling. Repeated `wait_for(0s)` does not start deferred work. Call `get()` or `wait()` to execute it on the calling thread, or avoid a deferred launch policy when polling semantics are required.

### Errors and abandonment

```cpp
#include <cassert>
#include <future>
#include <system_error>

int main() {
    std::future<int> future;
    {
        std::promise<int> promise;
        future = promise.get_future();
    } // promise abandoned its state

    try {
        (void)future.get();
        assert(false);
    } catch (const std::future_error& error) {
        assert(error.code() ==
               std::make_error_code(
                   std::future_errc::broken_promise));
    }
}
```

Destroying a promise before satisfying its state stores a broken-promise exception and makes the state ready. This prevents an otherwise permanent wait.

Other one-shot errors are distinct:

| Misuse/event | Specified result |
|---|---|
| `promise::get_future()` twice | `future_already_retrieved` |
| `promise::set_value` or `set_exception` after satisfaction | `promise_already_satisfied` |
| Producer promise abandoned before readiness | Consumer receives `broken_promise` |
| `future` operation requiring a state when `valid()==false` | Preconditions violated; some operations specify/encourage diagnostics, but do not rely on one for second `get()` |
| Task callable throws through packaged task or async | Exception stored and rethrown by `get()` |

`set_value_at_thread_exit` and `set_exception_at_thread_exit` store the result but make the state ready only when the producing thread exits. They are specialized lifetime tools, not lower-latency variants.

### Shared ownership does not mean shared mutation

Converting with `future.share()` transfers the state into a `shared_future`; the original future becomes invalid. Copies of the shared future can wait independently and repeatedly observe the same result. This is useful for a startup value consumed by several threads:

```cpp
#include <cassert>
#include <future>

int main() {
    std::promise<int> promise;
    std::shared_future<int> shared =
        promise.get_future().share();
    std::shared_future<int> second = shared;

    promise.set_value(42);
    assert(shared.get() == 42);
    assert(second.get() == 42);
    assert(shared.get() == 42); // repeatable
}
```

For `shared_future<T>`, repeated `get()` returns a reference to the stored value (except for `void` and reference-specialized details). The shared state keeps that value alive, but it does not serialize writes through a mutable object reachable from `T`. Publish immutable results or provide separate synchronization for mutable state.

The same distinction applies to exceptions. Every observer rethrows the stored exception from its own `get()`. Catching in one consumer does not consume it for the others.

Moving handles also matters during shutdown. A moved-from promise or future has no state; destruction of that empty handle does not abandon the state. The handle that received the move now owns the corresponding producer or consumer responsibility. Review moves as ownership transfers, not as copies of a channel endpoint.

### When futures fit

Futures fit coarse one-shot handoffs, startup work, and exception transport where a blocking collection point is natural. They fit streams poorly: a state is one-shot, standard `future` has no continuation API, and repeated task submission typically repeats state management and queueing.

For a high-rate path, compare against a bounded, preallocated queue or result slot owned by the participating threads. Chapter 26 owns non-blocking queue protocols; Chapter 24 owns blocking worker coordination.

---

## 20.4 Packaged tasks — Core

`std::packaged_task<R(Args...)>` associates a callable with a future shared state. Invoking the task runs the callable on the invoking thread and stores either its return value or thrown exception.

```cpp
#include <cassert>
#include <future>

int main() {
    std::packaged_task<int(int, int)> task{
        [](int a, int b) { return a + b; }
    };
    std::future<int> result = task.get_future();

    task(20, 22); // synchronous invocation here
    assert(result.get() == 42);
}
```

The wrapper does not schedule itself. A thread pool can enqueue the packaged task, but the pool, queue, wake-up, and shutdown policy are separate components.

`packaged_task` is move-only. A queue storing `std::function<void()>` cannot directly own a move-only packaged task because `std::function` requires a copyable target. C++23 `std::move_only_function<void()>` can represent a move-only queued callable:

```cpp
#include <cassert>
#include <deque>
#include <future>
#include <utility>

int main() {
    std::deque<std::packaged_task<int()>> queue;
    queue.emplace_back([] { return 42; });
    auto result = queue.front().get_future();

    auto work = std::move(queue.front());
    queue.pop_front();
    work();
    assert(result.get() == 42);
}
```

C++23 `std::move_only_function<void()>` is another possible queue element when heterogeneous move-only callables need one erased type. It removes the need to make the callable artificially copyable through `shared_ptr`, but it does not remove the future shared state, queue node/storage, or wake-up costs. `move_only_function` itself may allocate depending on target and implementation; it has no standard small-buffer guarantee. Shipping-library support for this C++23 facility must be checked independently of compiler language mode.

Calling `get_future()` more than once on one packaged task throws `future_already_retrieved`. Calling an invalid or already-invoked task without a reset throws `future_error` as specified for no state or already-satisfied state. `reset()` abandons the old state if it was not ready and gives the task a fresh state; an old consumer can then observe `broken_promise`. It does not reuse the old future.

### Submission-path accounting

A packaged-task worker design may include:

```text
submitter
  ├─ construct callable
  ├─ create shared result state
  ├─ allocate/reserve queue storage
  ├─ publish queue entry (cache-line transfer)
  └─ notify/doorbell worker
worker
  ├─ wait or poll
  ├─ dequeue
  ├─ invoke callable
  └─ publish result / wake waiter
```

No standard facility bounds that queue. A latency-sensitive pool needs an overload policy: reject, block submitter, drop, or apply backpressure upstream. Unbounded queues convert overload into growing queueing delay and memory consumption.

---

## 20.5 `std::async` and launch policies — Core

`std::async` combines callable storage, a shared state, and an implementation-selected execution mechanism:

```cpp
#include <future>

int compute();

std::future<int> result =
    std::async(std::launch::async, compute);
```

| Policy | C++23 semantics | Consequence |
|---|---|---|
| `launch::async` | Invokes on a new thread of execution | Eager concurrency; resource acquisition can fail |
| `launch::deferred` | Stores work until a non-timed wait/get forces it on that caller thread | No concurrency unless caller creates it elsewhere |
| Default policy | Permits implementation to select async or deferred | Timing and resource behavior are not fixed |

Specify a policy when correctness, progress, or latency depends on it. The default can be reasonable only when either permitted behavior is acceptable.

The function and arguments are materialized into owned state according to the C++23 `async` rules. Use `std::ref`/`std::cref` to request reference semantics, and then prove the referred object outlives execution—including deferred execution that may happen much later.

### The last-release wait

A precise model is:

- an invocation using the async policy has an associated thread;
- completion of that thread synchronizes with the first successful wait on the shared state or with the last function that releases the shared state, whichever occurs first;
- therefore releasing the last reference to an unfinished async-created state may wait for the associated thread.

The destructor of a temporary future is the common trap:

```cpp
#include <chrono>
#include <future>
#include <thread>

void work() {
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
}

int main() {
    static_cast<void>(std::async(std::launch::async, work));
    // The temporary future is the last owner at the semicolon, so this
    // statement does not finish until the associated work is complete.
}
```

Do not universalize this into “every future destructor blocks.” States produced by a promise or packaged task have no async-associated-thread last-release rule. A deferred task has no running associated thread to join. A ready async task needs no remaining wait. A state converted to `shared_future` can have several owners, so the relevant event is release of the last reference, not the spelling of one particular destructor.

This rule also defeats a naive timeout-and-abandon design:

```cpp
auto future = std::async(std::launch::async, slow_operation);
if (future.wait_for(deadline) == std::future_status::timeout) {
    return; // destruction may now wait for slow_operation anyway
}
```

`std::async` offers no cancellation handle. If bounded shutdown is a requirement, design the operation around `jthread`/stop tokens, an explicit executor task with owned state, or an I/O API that supports cancellation. A timed wait alone does not bound destruction.

### Exceptions and resources

An exception escaping the callable is stored in the shared state and rethrown by `get()`. If an async-only launch cannot start the new thread, `async` can throw `std::system_error` with the specified resource-unavailable condition. With both async and deferred permitted, the implementation has more freedom.

No pool, affinity, queue, or thread reuse is mandated. A common implementation creates a thread for async launch, but that is not a portable scheduling contract. Measure thread creation, stack/TLS setup, queueing, and interference on the deployment library.

Use `async` for a small number of coarse independent tasks when its lifetime semantics are acceptable. It is a poor substrate for high-rate task submission, continuation graphs, bounded queues, or cooperative cancellation.

---

## 20.6 Callbacks, event loops, and continuations — Core

A callback API stores a callable and invokes it when an operation reaches a terminal state:

```cpp
// Framework-neutral shape, not a standard C++ async API.
async_read(socket, buffer,
           [state](error_code error, std::size_t bytes) {
               state->on_read(error, bytes);
           });
```

C++23 supplies the language and callable wrappers, but not `async_read` or an event loop. The framework contract must say whether the callback can run inline, which thread/context invokes it, and whether it is invoked exactly once.

### Lifetime first

A callback stored beyond the initiating call must not capture automatic variables by reference unless another invariant keeps them alive. Common ownership choices are:

- move values into the callback;
- retain shared state with `shared_ptr`, accepting allocation/refcount traffic and possible cycles;
- store operation records in a context-owned pool and identify them with stable handles;
- use structured parent-child ownership that destroys children only after completion.

Capturing `this` does not extend the object's lifetime. Capturing a `shared_ptr<this>` does, but a callback stored by the same object can form a cycle. Chapter 18 owns capture mechanics; Chapter 9 owns ownership handles.

### Inline completion and reentrancy

An operation may already be complete when initiated. If the API invokes the callback inline, user code can reenter before the initiating function restores its invariants:

```text
object::start()
  ├─ sets state = starting
  ├─ async_op(callback)
  │    └─ callback runs inline → object::on_complete()
  └─ sets state = pending       ← overwrites completed state
```

Either the API guarantees deferred delivery, or the caller must establish a callback-safe state before initiation. A “never inline” guarantee costs at least an enqueue/context turn even for immediately available results. That is a semantic/latency trade-off, not merely style.

### Event-loop queueing

An event loop typically:

1. accepts operation submissions;
2. waits for I/O/timers or polls them;
3. enqueues completions;
4. invokes callbacks/continuations.

If callbacks run inline on the loop thread, they must complete within the loop's service budget. One long callback creates head-of-line blocking: later ready operations wait in the completion queue. Offloading work to workers adds another queue, wake-up, cache transfer, and return path.

Track queue depth, age of oldest item, handler duration, overload drops/rejections, and wakeups. Average handler duration is insufficient when one outlier delays all peers.

### Continuations and composition

A continuation says “after A completes, start B using A's result.” Standard `future` in C++23 has no `.then`, `when_all`, or `when_any`. Composition therefore requires explicit callbacks, blocking waits, coroutines supplied by a framework, or a nonstandard sender/task library.

Callback nesting can be flattened by named state-machine steps. The essential invariant is exactly one transition from pending to one terminal channel:

```text
pending ── success ──► value
   ├────── failure ──► error
   └── cancellation ─► stopped

No terminal state may transition again.
```

Cancellation racing with normal completion must arbitrate this transition. The loser still may need to release kernel or queue resources, but must not invoke user completion twice.

### Worked completion race

Suppose a timer expires while a socket read becomes ready:

```text
reactor thread                         timeout thread
read completion dequeued              request cancellation
        │                                      │
        ├── tries pending → value              ├── tries pending → stopped
        │                                      │
        └── exactly one transition succeeds ───┘

after user delivery:
  drain/cancel any remaining external record
  release buffer and operation state only when no external reference remains
```

Exactly-once delivery and safe reclamation are separate. A state flag can decide which user outcome wins, but the losing kernel completion may still carry an operation pointer. Reusing that slot immediately creates an ABA-like stale-completion bug: an old event can be mistaken for a new operation. A reactor may use generations, reference ownership, or a quarantine/drain phase; the chosen mechanism must match the external API.

The winner should usually enqueue or invoke one terminal continuation. It must not run both an error callback and a cancellation callback for the same logical operation. Metrics can still record the losing race, such as “timeout requested but operation completed first,” without producing a second user completion.

---

## 20.7 Cooperative cancellation — Core

Standard C++ does not provide safe preemptive thread termination. `std::stop_source`, `std::stop_token`, and `std::stop_callback` provide a shared cooperative request:

```cpp
#include <atomic>
#include <cassert>
#include <stop_token>

int main() {
    std::stop_source source;
    std::stop_token token = source.get_token();
    std::atomic<int> callbacks{0};

    std::stop_callback callback{
        token, [&] { callbacks.fetch_add(1); }
    };

    assert(source.request_stop());
    assert(token.stop_requested());
    assert(callbacks.load() == 1);
    assert(!source.request_stop()); // already requested
}
```

The standard specifies observable synchronization and callback behavior, not a public memory order or internal reference-count representation.

`request_stop()` succeeds only for the first effective request and invokes registered callbacks synchronously as part of the request. If a callback is registered after stop was already requested, construction invokes it before registration completes. A stop callback should therefore be short and safe on whichever thread requests stop. It must not let an exception escape: `request_stop()` is `noexcept`, so an escaping callback exception terminates the process.

Polling `stop_requested()` works for loops with natural checkpoints. A blocked operation needs a wake/cancel bridge: a stop callback can notify a condition variable, signal an event-loop wakeup, or call a framework cancellation function. Notification alone is not the predicate; Chapter 24 covers stop-aware condition-variable waiting.

### `jthread` lifetime

`std::jthread` joins in its destructor. If joinable, its destructor first requests stop and then joins:

```cpp
#include <atomic>
#include <thread>

int main() {
    std::atomic<int> iterations{0};

    {
        std::jthread worker{
            [&](std::stop_token stop) {
                while (!stop.stop_requested()) {
                    ++iterations;
                    std::this_thread::yield();
                }
            }
        };
    } // request_stop, then join
}
```

The join is still an unbounded blocking operation unless the worker is guaranteed to reach a cancellation point. A worker stuck in an uninterruptible external call can make `jthread` destruction hang. RAII prevents accidental detach/terminate; it does not prove prompt shutdown.

### Cancellation is not rollback

A stop request does not undo partial effects. Each operation needs a cancellation boundary:

- before publication, temporary state can often be discarded;
- after publishing an order/message, cancellation may require compensating action;
- during a file write, abandoning can leave a partial durable record;
- during I/O, the kernel may complete successfully while cancellation is being submitted.

Define whether cancellation means “do not start,” “best effort to interrupt,” or “suppress user delivery after completion.” These are different contracts.

### Shutdown order

A robust execution context normally shuts down in this order:

1. stop accepting new work;
2. request cancellation of owned operations;
3. keep the execution context alive;
4. drain normal and cancellation completions;
5. destroy operation/coroutine state only after external references are gone;
6. stop and join execution threads.

Stopping the loop before draining cancellation acknowledgements strands state that only the loop can release.

---

## 20.8 Execution contexts, schedulers, and backpressure — Core

An **execution context** owns resources that make progress: threads, an event loop, a timer structure, I/O registrations, and work queues. A **scheduler** is a handle or policy used to place work on a context. C++23 does not standardize a general scheduler/executor API, so exact vocabulary varies across libraries.

The placement question changes correctness:

- Does a continuation run inline on the completing thread?
- Is it queued onto a specific context?
- Can it migrate between threads?
- Does per-connection state require serialization?
- What happens after the context begins shutdown?

It also changes latency:

```text
producer
  │ enqueue + publish
  ▼
ready queue ── queue wait ──► worker wake/dequeue
                                  │
                                  ▼
                              user work
                                  │
                                  ▼
                           completion enqueue
```

End-to-end latency includes service time plus queueing at every stage. Adding workers can improve throughput while worsening cache locality and tail latency. A single-threaded reactor avoids data races for reactor-owned state but can suffer head-of-line blocking. Per-core contexts improve locality but require explicit cross-core routing and ownership.

### A compositional latency budget

For one submitted operation, reason in stages:

```text
Ttotal =
    Tstate/setup
  + Tsubmission_queue
  + Twake_or_poll
  + Tservice
  + Texternal_wait
  + Tcompletion_queue
  + Tcontinuation
```

This is an accounting identity, not a prediction that the terms are independent. Queueing grows with burst load; waking changes cache residency; external completions may arrive in batches; a continuation may enqueue more work. Measure timestamps at boundaries using a clock and instrumentation appropriate to the deployment, while accounting for the instrumentation overhead.

For an operation already ready in cache, queueing it to preserve non-reentrancy can dominate useful work. For a network operation, external wait may dominate typical latency while queue backlog dominates the tail during bursts. Optimizing `Tservice` alone cannot repair an overloaded completion queue.

Batching also cuts two ways. Processing several submissions or completions per loop turn amortizes doorbells/system calls and improves throughput. A large batch lets the first context monopolize the loop and increases wait time for other queues. Set a service quota or time budget, then verify fairness and tail behavior under asymmetric load.

### Backpressure is part of the API

When a queue is full, choose:

- reject and return an error;
- block the producer;
- drop according to a documented policy;
- coalesce replaceable work;
- propagate demand upstream.

An unbounded queue is not “no policy”; it is a policy that spends memory and latency until failure. Size a bounded queue from burst assumptions, service capacity, and recovery behavior, then measure occupancy and item age.

### Primitive decision table

| Need | Facility/model | Blocks, suspends, or describes | Important boundary |
|---|---|---|---|
| One result/exception | `promise` + `future` | Wait blocks | One-shot shared state |
| Callable producing a future | `packaged_task` | Invocation runs on caller/worker; retrieval blocks | Scheduling external |
| Coarse independent work | `async(launch::async, ...)` | Retrieval/last release may block | No cancellation/context control |
| Cooperative thread shutdown | `stop_token` + `jthread` | Request does not block; join does | Worker must reach stop point |
| Many I/O waits | Callback reactor | Callback delivery | Owner/context must survive |
| Blocking-shaped async I/O | Framework coroutine task | Coroutine may suspend | Frame survives external operation |
| Lazy composed work | Non-C++23 sender model | Describes until started | Operation state survives completion |
| Repeated hot-path handoff | Bounded queue/slot | Policy-dependent | Capacity and ownership explicit |

Latches, barriers, semaphores, mutexes, and condition variables are blocking synchronization tools covered in Chapter 24. Atomics and happens-before are covered in Chapter 25.

---

## 20.9 Worked diagnosis: a shutdown that times out but still hangs — Core

Consider:

```cpp
class Snapshotter {
public:
    void start() {
        future_ = std::async(std::launch::async, [this] {
            write_snapshot(); // may block in filesystem I/O
        });
    }

    bool shutdown(std::chrono::milliseconds timeout) {
        return future_.wait_for(timeout) == std::future_status::ready;
    }

private:
    void write_snapshot();
    std::future<void> future_;
};
```

The function can return `false` at the deadline, but destroying `Snapshotter` then destroys the last future referring to an unfinished async-associated thread. That release may wait for `write_snapshot`. The timeout did not bound shutdown.

There is a second bug: the callable captures `this`. If the object could be destroyed without waiting, the task would use a dangling pointer. The blocking last-release rule happens to mask that lifetime bug in some paths; it is not a sound ownership mechanism.

### Redesign

Move snapshot state into an operation object whose lifetime is independent of the service object. Run work on an owned `jthread` or executor that accepts a stop token. Make the I/O operation itself bounded or cancellable; a token cannot interrupt an arbitrary blocking filesystem call.

```text
Snapshotter owns OperationState
   ├─ immutable input / output handle
   ├─ stop_source
   ├─ terminal status: pending/value/error/stopped
   └─ worker/executor ownership

shutdown(deadline):
   1. stop new snapshots
   2. request_stop
   3. wait only until deadline
   4. if unfinished, retain OperationState in a shutdown owner
   5. keep executor alive until operation really completes
   6. report deadline miss without destroying referenced state
```

Step 4 is the key: bounded caller waiting and operation lifetime are separate. “Abandon” must transfer ownership somewhere that can finish cleanup; it cannot mean destroy live state.

If the filesystem API cannot cancel or bound its call, the system cannot guarantee a bounded process shutdown while also guaranteeing clean completion in-process. Options include accepting an unbounded join, isolating work in a process with an external termination/durability protocol, or choosing an I/O API with explicit cancellation. State that limit rather than hiding it behind `wait_for`.

### Latency accounting

For a snapshot off the trading path, measure:

- submission allocation and queue depth;
- delay until worker start;
- time in serialization versus system calls;
- cancellation-request-to-completion time;
- shutdown deadline misses;
- whether completion runs on a latency-sensitive core.

The benefit of asynchronous snapshotting is isolation of caller service time, not elimination of work. CPU, memory bandwidth, filesystem queues, and cache interference remain shared unless architecture isolates them.

---

## 20.10 Sender/receiver composition — Role-specific / Reference

C++23 does not contain standard senders, receivers, schedulers, `then`, `when_all`, or `sync_wait`. The model is still useful because several libraries use related ideas and because it exposes what futures lack.

A sender-like object describes possible completion signatures and how work will be connected. A receiver supplies terminal channels:

```text
sender description
      │ connect(receiver)
      ▼
operation state ── start ──► execution
                                ├─ set_value(...)
                                ├─ set_error(error)
                                └─ set_stopped()
```

The operation state must remain alive from `start` until one terminal completion finishes. Starting it and immediately destroying it is the sender equivalent of destroying a callback state too early.

Framework pseudocode:

```cpp
// Pseudocode: not a C++23 standard API.
auto pipeline =
    schedule(io_scheduler)
    | then(read_request)
    | then(parse_request)
    | let_value(query_service)
    | continues_on(reply_scheduler)
    | then(send_reply);

auto operation = connect(std::move(pipeline), receiver);
start(operation); // operation must remain alive through completion
```

Composition answers three questions absent from plain futures:

- where each continuation runs;
- how value, error, and stopped channels flow;
- how cancellation and environment information propagate through the graph.

Laziness can let a library represent the graph and operation state compactly. It does not guarantee zero allocation, immovable state, inlining, or a particular queue. Concrete sender types, captured values, scheduler implementation, and type erasure determine those costs. Measure the built operation, not the vocabulary.

For C++23 production code, use the documented API/version of the selected library. Do not paste future-standard examples under `std::execution` and assume a shipping C++23 standard library provides them.

---

## 20.11 Coroutine-based asynchronous I/O — Role-specific

Coroutines provide suspend/resume control flow; they do not provide I/O, scheduling, cancellation, or lifetime ownership. A framework must connect an awaiter to an event source and own the coroutine task appropriately. Chapter 19 explains frames and the awaiter protocol; this section follows the external operation.

Framework pseudocode:

```cpp
// Pseudocode: task and Socket are framework types, not C++23 facilities.
task<void> serve(Socket socket, std::stop_token stop) {
    std::array<std::byte, 4096> buffer;

    while (!stop.stop_requested()) {
        auto result = co_await socket.async_read(buffer);
        if (result.eof()) co_return;
        co_await process_and_reply(socket, buffer.first(result.size()));
    }
}
```

At a read suspension:

```text
coroutine frame
  ├─ socket/task state
  ├─ buffer
  ├─ stop token
  └─ continuation handle
         │ registered in operation state
         ▼
reactor/kernel operation
  ├─ buffer address/length
  ├─ completion identity
  └─ pending/completed/cancel state

Required lifetime:
[ frame and buffer [ submitted operation ... terminal completion ] ]
```

The frame cannot be destroyed merely because stop was requested. The kernel/reactor may still hold the buffer address and completion identity.

### Completion versus cancellation race

Suppose cancellation and read readiness occur concurrently:

1. stop callback submits cancellation;
2. read completes successfully before cancellation takes effect;
3. cancellation completion reports “not found” or equivalent;
4. user code must receive exactly one terminal outcome;
5. both external completions may still require bookkeeping before state destruction.

Use an operation-state machine or framework contract that arbitrates delivery:

```text
pending
  ├─ read wins ─────► delivered_value
  ├─ error wins ────► delivered_error
  └─ cancel wins ───► delivered_stopped

external references may reach zero only after all required completion records drain
```

Destroying on the first observed event can be too early if a second queued completion still points to the operation record. Reference ownership, generation-checked handles, or reactor-owned slots can solve this, but the proof is framework-specific.

### Resumption context

An I/O completion can:

- resume the coroutine inline on the reactor thread;
- enqueue it on the same context for later;
- transfer it to another scheduler.

Inline resume avoids a queue turn but permits reentrancy and lets a long continuation stall the reactor. Enqueueing adds queueing and cache-transfer cost but establishes a cleaner scheduling boundary. Cross-thread resume requires synchronized publication and often moves the coroutine frame's cache footprint.

### I/O correctness

Completion does not imply a whole protocol message. Reads and writes can be partial; EOF and errors need separate handling. Buffers must remain stable across suspension. Timeouts and cancellation are races with ordinary completion, not deletion commands.

Allocation is framework-dependent. A coroutine frame may be dynamically allocated, embedded, pooled, or in some cases elided under language rules. Do not promise allocation elision. A fixed operation pool can improve steady-state behavior but needs bounded capacity, exhaustion policy, stable handles, and proof that slots are not reused before late completions drain.

### Linux `io_uring` example — Deep dive

`io_uring` is Linux-specific and outside standard C++. A framework can place an operation pointer/index in submission user data and recover it from the completion queue. Cancellation uses additional asynchronous requests and completions; exact result codes and race handling are part of the Linux API contract.

SQPOLL can let a kernel thread poll submissions and can reduce application submission system calls in some states/configurations. It consumes CPU and does not erase completion processing, queueing, or all kernel transitions. Permissions, kernel version, ring flags, workload, and batching affect behavior. Measure syscall counts, polling CPU, queue occupancy, and end-to-end latency on the deployed kernel.

Do not place platform calls in a generic awaiter without defining:

- ownership of the frame, operation record, file/socket, and buffer;
- behavior for short results and retryable errors;
- exactly-once user completion;
- cancellation acknowledgement and late completion;
- context shutdown/drain order;
- bounded operation capacity.

---

## 20.12 One operation in four models — Reference

The same “read, parse, reply” workflow exposes different ownership:

| Model | Sketch | Composition | Waiting | State owner |
|---|---|---|---|---|
| Promise/future | worker sets promise; caller gets future | Manual, usually blocking between steps | `get` blocks | Shared state |
| Callback | `read(..., on_read)` then callback starts parse/reply | Explicit continuation chain/state machine | Event loop waits | Callback/operation record |
| Coroutine framework | `co_await read; co_await reply` | Structured control flow | Coroutine suspends | Task/frame + reactor op |
| Sender-like framework | `read | then(parse) | let_value(reply)` | Declarative graph | Lazy until start; optional blocking bridge | Connected operation state |

Illustrative shapes:

```cpp
// Standard promise/future shape.
std::promise<Result> promise;
auto future = promise.get_future();
submit([p = std::move(promise)]() mutable {
    try {
        p.set_value(read_parse_reply());
    } catch (...) {
        p.set_exception(std::current_exception());
    }
});
Result result = future.get(); // blocks
```

```cpp
// Callback-framework pseudocode.
async_read(socket, [state](error_code error, Bytes bytes) {
    if (error) return state->finish_error(error);
    async_reply(socket, parse(bytes),
                [state](error_code reply_error) {
                    state->finish(reply_error);
                });
});
```

```cpp
// Coroutine-framework pseudocode.
auto bytes = co_await async_read(socket);
auto reply = parse(bytes);
co_await async_reply(socket, reply);
```

```cpp
// Sender-framework pseudocode; not standard C++23.
auto work = async_read(socket)
          | then(parse)
          | let_value([&](auto reply) {
                return async_reply(socket, reply);
            });
```

The promise form is the only sketch based solely on standard result-channel facilities, though `submit` is still an application executor. The other forms need a framework. Their performance cannot be ranked from syntax alone: count state allocation, queue turns, scheduling, system calls, buffer copies, and contention for the concrete implementation.

---

## 20.13 Common traps — Reference

| Trap | Violated contract | Repair |
|---|---|---|
| Calling `future::get()` twice | First get invalidates the future | Check ownership; use `shared_future` for repeated reads |
| Expecting second `get()` to throw a specific error | Invalid-state precondition violated | Do not make the call |
| Dropping an unsatisfied promise | Consumer receives broken promise | Complete value/exception or make abandonment intentional |
| Treating `packaged_task` as a scheduler | Invocation runs wherever task is called | Supply an explicit executor/worker |
| Ignoring `future_status::deferred` | Timed polling never starts work | Force with wait/get or choose policy explicitly |
| Timing out then destroying async future | Last release may still wait | Use cancellable owned operation state |
| Capturing a local/`this` in stored callback | Callback outlives referent | Move state, share ownership carefully, or use context-owned slots |
| Assuming callback is never inline | Reentrancy breaks initiating invariant | Establish state first or require queued-delivery contract |
| Unbounded executor queue | Overload becomes queueing delay/memory growth | Bound and define backpressure |
| Stop request treated as completed cancellation | Work/kernel reference may remain active | Wait for terminal completion/acknowledgement |
| Destroying `jthread` whose worker cannot stop | Destructor joins indefinitely | Make blocking operations interruptible/bounded |
| Destroying coroutine frame after submitting cancel | Late completion still references frame/op | Drain required completions before destruction |
| Resuming long coroutine inline on reactor | Head-of-line blocking | Budget continuation or enqueue/offload |
| Assuming lazy sender means no allocation | Representation is implementation/type dependent | Inspect and measure concrete pipeline |
| Using future sender APIs as C++23 standard | Facility does not exist in C++23 | Label framework/version and isolate dependency |

---

## Recall and practice

### Recall card

1. Async separates initiation from completion; it does not imply parallelism or absence of blocking.
2. Shared future state has specified value/exception/readiness semantics but unspecified storage and synchronization representation.
3. `future::get()` is one-shot; broken producer state becomes a ready `broken_promise` exception.
4. A packaged task captures callable results but does not schedule itself.
5. Explicit async/deferred policy controls progress; releasing the last unfinished async-associated state may wait.
6. Cancellation is cooperative and races with completion. Request, terminal delivery, external-reference drainage, and destruction are separate events.
7. Execution contexts own progress resources and queues; scheduler placement, queue capacity, and shutdown order are part of correctness.
8. Coroutine I/O requires the frame, buffer, and operation record to survive until the reactor/kernel no longer references them.

### Questions

1. Give an example of asynchronous execution that is not parallel, and one of blocking retrieval from asynchronously produced work.
2. Which properties of a future shared state are standard guarantees, and which common implementation details must be measured?
3. Contrast second `future::get`, second `promise::get_future`, producer abandonment, and second `set_value`.
4. Why does `packaged_task` solve exception/result capture but not scheduling or backpressure?
5. Under exactly which ownership/readiness conditions can release of an async-created shared state wait?
6. How does inline callback completion create reentrancy, and what two API designs avoid the broken invariant?
7. Why is `request_stop()` not evidence that an I/O buffer or coroutine frame can be destroyed?
8. Compare a single-threaded reactor and a worker pool using queueing, locality, head-of-line blocking, and data-race risk.
9. What does a sender-like operation state own between `connect/start` and terminal completion, and why is this not a C++23 standard API?
10. Redesign a timed async shutdown when the underlying system call cannot be cancelled or bounded.

### Code-reading puzzle

```cpp
std::future<void> launch(Service& service) {
    return std::async(std::launch::async, [&service] {
        service.flush(); // may block
    });
}

void stop(Service& service) {
    auto future = launch(service);
    if (future.wait_for(std::chrono::milliseconds{10}) ==
        std::future_status::timeout) {
        return;
    }
}
```

Can `stop` take longer than its stated wait duration? What lifetime prevents `service` from being destroyed too early in this exact function, and why does that accidental coupling fail as a general cancellation design?

### Design exercise

Design shutdown for a single-threaded I/O context with one coroutine-like operation per connection and a background snapshot worker:

1. stop admission of new work;
2. request cancellation of reads, writes, timers, and snapshot work;
3. define exactly-one value/error/stopped delivery under completion races;
4. keep buffers, operation records, and task frames alive through late completions;
5. drain the context and join owned threads;
6. report a deadline miss without destroying live state.

Draw the ownership graph and terminal-state transitions. State which steps block a thread, suspend a coroutine, enqueue work, or only request cancellation. Define queue capacity/exhaustion, the behavior of an uncancellable snapshot system call, and the measurements that validate queueing and cancellation latency.

### Next prerequisite

Chapter 21 assumes that queues, slots, and operation records are data structures with explicit ownership and capacity. Before continuing, be able to separate the logical task from its storage, result channel, execution context, and lifetime; those distinctions determine which representation is safe and cache-efficient.
