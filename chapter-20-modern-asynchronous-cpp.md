# Chapter 20 — Modern Asynchronous C++

*Interview-focused revision notes. The theme: the standard library's asynchrony story is three generations deep — `future`/`promise` (allocating, blocking, un-composable), senders/receivers (structured, allocation-free, composable), and coroutines gluing them to the kernel's async I/O. Knowing why each generation exists is the interview.*

---

## 20.1 Futures and Promises

A **future** is a handle to a value that does not exist yet; a **promise** is the write end that will eventually supply it. Together they form a one-shot, thread-safe, single-producer/single-consumer channel carrying either a value or an exception.

```cpp
std::promise<int> p;
std::future<int> f = p.get_future();          // exactly once per promise
std::thread t([&p]{ p.set_value(compute()); });
int v = f.get();                              // blocks until ready; RETHROWS if set_exception
t.join();
```

### The shared state

The mechanism is a heap-allocated **shared state** holding: the value or `exception_ptr`, a ready flag, a mutex and condition variable, and a reference count (the promise and the future each hold one). This structure is the source of every criticism of the design:

- **One allocation per operation.** `std::promise`'s constructor allocates; there is no allocator support that any implementation honours meaningfully (the allocator-taking constructors were removed in C++17).
- **Synchronization on every access.** `get()`/`wait()` take a lock and wait on a condvar — a futex round trip and a park/unpark (Ch. 24 §24.16) when the value is not ready, ~1–5 µs. Even the ready case pays an atomic and a lock.
- **`get()` blocks.** There is no way to attach a continuation. `then`, `when_all`, `when_any` were specified in the Concurrency TS and never merged; that gap is what senders/receivers (§20.5) exist to fill.

### Semantics worth knowing precisely

- `future::get()` is **one-shot** and *moves* the value out; calling it twice throws `std::future_error(future_already_retrieved)`. `std::shared_future` allows multiple retrievals and copies, returning `const T&`.
- **Destroying a `promise` without setting it** stores a `broken_promise` exception, so the waiting `get()` throws rather than hanging. This is the correct design and worth citing.
- `wait_for`/`wait_until` return `future_status::{ready, timeout, deferred}`. `deferred` only ever appears for `std::async(launch::deferred)` (§20.3) and is a classic quiz item: a deferred future's `wait_for(0s)` returns `deferred` immediately and *never* becomes ready without a `get()`.
- `set_value` and `set_exception` may be called only once; a second call throws `promise_already_satisfied`. `set_value_at_thread_exit` defers the release until TLS destructors have run — a rarely-used but correct tool when the produced value references thread-local state.
- The `future`/`promise` pair establishes a **happens-before** edge (Ch. 25 §25.11): everything sequenced before `set_value` is visible after `get()` returns.

### When to use it

| Use | Avoid |
|---|---|
| One-shot handoff between threads at a low rate (startup, shutdown, RPC-like request) | Anything on a hot path — the allocation plus futex cost dwarfs the work |
| Propagating an exception across a thread boundary | Streams of events — futures are single-shot; use a queue (Ch. 26) |
| Simple fan-in with a small fixed number of results | Composition/continuation — the standard `future` has none |

Low-latency practice: replace with a preallocated slot plus an atomic flag and, if a wait is genuinely needed, `std::atomic<T>::wait`/`notify_one` (C++20) — which is futex-backed but with no allocation and no mutex — or a spin-then-park (Ch. 24 §24.15). Folly's `Future`/`SemiFuture` and Seastar's `future` are the production alternatives that add continuations and, in Seastar's case, allocation-free chaining on a thread-per-core reactor.

---

## 20.2 Packaged Tasks

`std::packaged_task<R(Args...)>` wraps a callable so that invoking it stores the result into an associated shared state instead of returning it.

```cpp
std::packaged_task<int(int,int)> task([](int a, int b){ return a + b; });
std::future<int> f = task.get_future();
task(2, 3);                      // runs HERE, on whatever thread calls it
assert(f.get() == 5);
```

It is precisely `promise` + callable, with the exception plumbing done for you: if the callable throws, the exception is captured into the shared state via `set_exception`. That is its whole value proposition — it is the adapter between "a thing to run" and "a thing to wait on".

### The canonical use — a thread pool

```cpp
template <class F>
auto ThreadPool::submit(F&& f) -> std::future<std::invoke_result_t<F>> {
    using R = std::invoke_result_t<F>;
    auto task = std::make_shared<std::packaged_task<R()>>(std::forward<F>(f));
    auto fut  = task->get_future();
    queue_.push([task]{ (*task)(); });    // std::function needs a COPYABLE callable
    return fut;
}
```

The `shared_ptr` in that snippet is the detail interviewers look for: `packaged_task` is **move-only**, and pre-C++23 `std::function` requires a copy-constructible target, so the task must be wrapped to be storable in a `std::function`-based queue. C++23's **`std::move_only_function`** removes the need (and `std::copyable_function`, C++26, is the copyable counterpart with fixed const-correctness). Using `std::move_only_function<void()>` in the queue eliminates one `shared_ptr` allocation and one atomic refcount pair per task.

### Cost accounting for that submit path

Per submitted task, the naive implementation pays: one `make_shared` (control block + task), one shared-state allocation inside `packaged_task`, one lambda-to-`std::function` allocation if the closure exceeds the SOO buffer (Ch. 18 §18.10), a mutex acquisition on the queue, and a condvar notify — easily 200–500 ns before any work happens, plus the wakeup latency of the worker. That is why HFT thread pools do not look like this: they use a bounded lock-free MPMC ring (Ch. 26 §26.5) of fixed-size POD task descriptors, workers busy-poll on isolated cores, and results are written into caller-owned preallocated slots. `packaged_task` is a correctness convenience, not a latency tool.

| | `packaged_task` | `promise` directly | `move_only_function` + manual slot |
|---|---|---|---|
| Allocation | Shared state (+ wrapper) | Shared state | Optional/none |
| Exception capture | Automatic | Manual `set_exception` | Manual |
| Where it runs | Wherever it is invoked | Wherever you call `set_value` | Wherever invoked |
| Composability | None | None | Yours to define |

Two further specifics: `packaged_task::reset()` creates a *fresh* shared state so the task can be run again (the old future is not reused), and `make_ready_at_thread_exit` mirrors `set_value_at_thread_exit`. Also note `packaged_task<void()>` is legal and common.

---

## 20.3 `std::async`

`std::async` runs a callable and returns a `std::future` for its result. It is the highest-level facility and the one with the most sharp edges.

```cpp
auto f = std::async(std::launch::async, work, arg);   // ALWAYS specify the policy
```

### The launch policies

| Policy | Behavior |
|---|---|
| `launch::async` | **Must** run on a new thread of execution, starting eagerly. |
| `launch::deferred` | Lazy: nothing runs until `get()`/`wait()`, and then it runs **on the calling thread**. |
| Default (`async \| deferred`) | Implementation chooses — and may choose deferred based on load. |

**Never use the default.** With `async|deferred` the implementation may defer, in which case:

- Your "parallel" code runs sequentially on the consumer thread.
- If you never call `get()`, the work **never runs at all**.
- `wait_for(0s)` returns `future_status::deferred` forever, so a polling loop spins without progress. The correct idiom for polling is to check for `deferred` explicitly and force execution.

### The destructor that blocks

The most notorious behavior in the standard library: a `future` returned by `std::async` has a destructor that **blocks until the task completes** (it joins). Futures from `promise::get_future` and `packaged_task::get_future` do *not*.

```cpp
std::async(std::launch::async, slow_work);   // temporary future destroyed at the ';'
                                             // → this line BLOCKS until slow_work finishes
{
    auto f1 = std::async(std::launch::async, a);   // runs
    auto f2 = std::async(std::launch::async, b);   // runs
}   // ~f2 blocks, then ~f1 blocks — but a and b DID overlap
```
The first form is the killer: an unnamed `std::async` result is fully synchronous. Scott Meyers' *Effective Modern C++* Item 38 covers the asymmetry; the rationale is that without it, a task could outlive objects it referenced. This inconsistency (only `async`'s futures join) is widely regarded as a design defect, and P0701-era proposals to fix it went nowhere.

### Other hazards

- **No thread pool is mandated.** `launch::async` requires a new *thread of execution*; libstdc++ and libc++ create a fresh `std::thread` per call — roughly 10–30 µs of `clone()`, stack mmap, and TLS setup, plus a page fault on first stack touch. MSVC uses the Windows thread pool. So `std::async` per work item is a throughput disaster on Linux.
- **Arguments are decay-copied** into the shared state (like `std::thread`), so references require `std::ref`, and a `std::ref` to a stack object plus a deferred policy is a dangling recipe.
- **No cancellation, no continuation, no executor.** You cannot say where it runs, nor stop it.
- Exceptions propagate through `get()`, which is genuinely convenient and is `async`'s one clear advantage over raw `std::thread` (where an escaping exception calls `std::terminate`).

**Interview position:** `std::async` is acceptable for a handful of coarse, independent, blocking operations in non-latency-critical code (parallel config loading, a startup warmup). For anything else use a real pool (`std::jthread` workers, TBB, Taskflow, or a hand-rolled pinned pool), and for parallel *algorithms* use execution policies (Ch. 14 §14.12), which target a proper scheduler.

---

## 20.4 Cooperative Cancellation

C++20 added `<stop_token>`: `std::stop_source`, `std::stop_token`, `std::stop_callback`, integrated with `std::jthread`.

**Cooperative** is the operative word. There is no way to preemptively kill a thread in standard C++ (`pthread_cancel` exists but leaves C++ objects undestroyed and is effectively unusable with RAII, exceptions, or any allocator holding a lock). Cancellation is a *request* that the target polls or reacts to.

```cpp
std::jthread t([](std::stop_token st) {
    while (!st.stop_requested()) { do_work(); }
});
// t's destructor calls request_stop() then join() — this is why jthread exists
```

### The pieces

- **`std::stop_source`** — the requesting end. `request_stop()` is idempotent, thread-safe, and returns whether *this* call performed the transition.
- **`std::stop_token`** — the observing end. `stop_requested()`, `stop_possible()`. Copyable, cheap, shares a refcounted control block with the source.
- **`std::stop_callback`** — an RAII object registering a callback fired on `request_stop()`. This is the mechanism for waking a *blocked* thread rather than a polling one:

```cpp
std::stop_callback cb(st, [&]{ cv.notify_all(); });     // or write to an eventfd / close a socket
```

The subtle rules: if stop was *already* requested when the `stop_callback` is constructed, the callback runs **immediately on the constructing thread**; the `stop_callback` destructor blocks if the callback is concurrently executing on another thread (but returns immediately if it is executing on *this* thread, preventing self-deadlock); and callbacks run on whatever thread calls `request_stop()`, so they must be short and non-blocking.

### Condition variables

`std::condition_variable_any::wait(lock, token, pred)` is the stop-aware overload — it returns `false` if stop was requested, and internally uses a `stop_callback` to notify. Plain `std::condition_variable` has **no** stop-token overload; that asymmetry (`_any` works with any lockable and takes the token) is a common gotcha.

### `jthread` vs `thread`

| | `std::thread` | `std::jthread` (C++20) |
|---|---|---|
| Destructor if joinable | `std::terminate()` | `request_stop()` then `join()` |
| Stop token | None | Passed as first argument if the callable accepts one |
| Detach | Yes | Yes (then the destructor does nothing) |

`jthread` should be the default: the `std::thread`-terminates-on-destruction rule is a landmine, and the automatic stop-then-join gives a correct shutdown sequence for free.

### Beyond C++20

`std::stop_token` is the cancellation vocabulary for **senders/receivers** (§20.5): `std::execution::get_stop_token(receiver)` retrieves the token from the receiver's environment, so cancellation propagates down an operation graph without threading a parameter through every layer. C++26 generalizes it with `std::inplace_stop_source`/`inplace_stop_token` — the same semantics with **no allocation and no atomic refcount**, intended for exactly the case where a stop source is owned by a structured scope and cannot outlive it. That distinction (shared/refcounted vs in-place/borrowed) is the low-latency answer here.

For I/O, the practical cancellation mechanisms are: `io_uring`'s `IORING_OP_ASYNC_CANCEL`, closing/shutting down the descriptor, an `eventfd` in the readiness set, or a timeout on the wait — a `stop_callback` is the C++ glue that triggers one of them.

---

## 20.5 Senders and Receivers

`std::execution` (P2300, **C++26**) is the standard's asynchronous execution model, developed as `stdexec`/libunifex. It replaces the future model with a *lazy, composable, allocation-free* description of work.

### The three concepts

- **Sender** — a *description* of asynchronous work that has not started. Composing senders builds a graph; nothing executes.
- **Receiver** — the continuation, with exactly three completion channels: `set_value(vs...)`, `set_error(e)`, `set_stopped()`.
- **Operation state** — the object produced by `connect(sender, receiver)`, holding all the storage the operation needs. It is **immovable**, created in place by the caller, and `start(op)` begins the work.

```cpp
using namespace std::execution;
sender auto s = just(42)
              | then([](int x){ return x * 2; })
              | continues_on(pool.get_scheduler())
              | then([](int x){ return process(x); });
auto [result] = std::this_thread::sync_wait(s).value();   // the only blocking point
```

The key architectural claim: because the whole graph is known before `start`, the operation state for the *entire* pipeline is one composed object whose size the compiler computes at compile time. It can be a member, a stack object, or slab-allocated. Contrast `std::future`, where every `then` is a separate heap-allocated shared state with its own atomics.

| | `std::future` model | Sender/receiver model |
|---|---|---|
| When work starts | Eagerly at creation | On `start(op)` — lazy |
| Allocation | One shared state per stage | Zero required; state is one composed object |
| Synchronization | Mutex + condvar per stage | None required if the graph is single-threaded |
| Composition | Absent from the standard | `then`, `let_value`, `when_all`, `upon_error`, `into_variant`, … |
| Error channel | `exception_ptr` only | Typed errors, plus a distinct **stopped** channel |
| Cancellation | None | `get_stop_token` from the receiver environment |
| Where it runs | Unspecified/implementation choice | Explicit via **schedulers** |

### Schedulers and structure

A **scheduler** is a lightweight handle to an execution context; `schedule(sched)` returns a sender that completes on that context. `starts_on`/`continues_on` place work. Standard contexts include `run_loop` and (C++26) `std::execution::parallel_scheduler`. Custom schedulers are where the low-latency value is: a pinned single-thread-per-core reactor, or a busy-polling `io_uring` context, plugs in as a scheduler and the rest of the code is unchanged.

Two further pieces to name:

- **`sync_wait`** is the only sanctioned blocking bridge from sender-land back to ordinary code; it is what a `main()` or a test uses.
- **Customization via `get_env`/queries** rather than ADL: receivers carry an *environment* answering queries like `get_stop_token`, `get_scheduler`, `get_allocator`. This is how cancellation and allocator propagation reach deep into a graph without changing signatures. P2300 moved away from `tag_invoke` to member-function customization late in the process — worth mentioning if asked about the design history.
- **`counting_scope`/`async_scope`** (companion papers) provide *structured concurrency*: a scope that guarantees all spawned work has completed before it exits, making lifetimes provable rather than hoped-for.

### Honest assessment for interviews

The model's compile-time type composition means excellent codegen — a fully synchronous pipeline can optimize to straight-line code — but also large types, slow compiles, and error messages that were the loudest objection during standardization. Implementations: NVIDIA's `stdexec` (production-usable today, header-only, C++20), Meta's `libunifex` (the predecessor), and Boost.Asio's very different but conceptually related completion-token/executor design. Knowing that Asio's `awaitable`/`use_awaitable` and P2300's senders solve the same problem with different vocabularies is the level of familiarity expected.

---

## 20.6 Coroutine-Based Asynchronous I/O

The synthesis: coroutines (Ch. 19 §19.7–§19.9) give you suspendable functions; an I/O reactor gives you a reason to suspend. Together they let you write blocking-shaped code that never blocks a thread.

```cpp
task<void> handle(Socket sock) {
    char buf[4096];
    for (;;) {
        std::size_t n = co_await sock.async_read(buf, sizeof buf);   // suspends, no thread blocked
        if (n == 0) co_return;
        co_await sock.async_write(buf, n);
    }
}
```

### How the awaiter connects to the kernel

The awaiter for `async_read` is where all the machinery lives:

```cpp
struct ReadAwaiter {
    bool await_ready() const noexcept { return false; }             // or true, if data is already buffered
    void await_suspend(std::coroutine_handle<> h) {
        op_.handle = h;                                              // remember who to resume
        io_uring_sqe* sqe = io_uring_get_sqe(&ring);
        io_uring_prep_recv(sqe, fd_, buf_, len_, 0);
        io_uring_sqe_set_data(sqe, &op_);                            // user_data carries the handle
        // submission happens here or is batched by the loop
    }
    std::size_t await_resume() { if (op_.res < 0) throw std::system_error(-op_.res, ...); return op_.res; }
};
```

The event loop then drains completions and resumes:

```cpp
while (running) {
    io_uring_submit_and_wait(&ring, wait_nr);          // or peek, for busy-polling
    unsigned head; io_uring_cqe* cqe;
    io_uring_for_each_cqe(&ring, head, cqe) {
        auto* op = static_cast<Op*>(io_uring_cqe_get_data(cqe));
        op->res = cqe->res;
        op->handle.resume();                            // returns when the coroutine suspends again
    }
    io_uring_cq_advance(&ring, count);
}
```

Two structural points: `await_ready()` returning `true` for an already-satisfiable read is the **fast path** that avoids the suspend entirely (data already in a user-space buffer, or a completed `io_uring` op), and `handle.resume()` runs the continuation *inline on the loop thread*, so a long-running continuation stalls every other connection — the standard event-loop hazard.

### Model comparison

| Model | Thread cost | Latency profile | Complexity |
|---|---|---|---|
| Thread per connection (blocking) | 8 KB–8 MB stack + kernel task each | Good at low counts; scheduler and context-switch bound (1–3 µs) at high counts | Lowest |
| Callback reactor (`epoll` + callbacks) | One thread per core | Very good | Callback hell; state machines by hand |
| Coroutine reactor (`epoll`/`io_uring`) | One thread per core, ~100–300 B frame per connection | Same as callbacks plus ~5–20 ns resume | Linear code, hard debugging |
| Busy-poll + kernel bypass (Ch. 47) | One pinned core, 100% CPU | Sub-microsecond, no syscall | Highest |

### Getting it right

- **Lifetime.** The coroutine frame must outlive the in-flight kernel operation. If the coroutine is destroyed while an `io_uring` SQE references its buffer or its handle, the completion resumes a dead frame. Cancellation therefore requires `IORING_OP_ASYNC_CANCEL` plus waiting for the cancellation *completion* before destroying — this is the single hardest correctness issue in coroutine I/O, and it is what structured concurrency (`async_scope`, §20.5) exists to enforce.
- **Buffers must be stable across suspension**: locals that live across a `co_await` are in the frame and stable; anything captured by reference is not (Ch. 19 §19.8). `io_uring` **registered buffers** and registered files (`IORING_REGISTER_BUFFERS`, Ch. 34) remove the per-op pinning cost.
- **`await_transform` on the task's promise** is how a framework injects the scheduler and the stop token, so `co_await` in user code carries context automatically.
- **Batching.** The `io_uring` submission queue is the natural batching point: submit once per loop iteration rather than per operation, turning N syscalls into one. With `IORING_SETUP_SQPOLL` a kernel thread polls the SQ and the syscall disappears entirely; with `IORING_SETUP_IOPOLL` completions are polled rather than interrupt-driven. That trade — burning a core to eliminate a ~1–2 µs syscall (Ch. 34 §34.5) — is the standard low-latency question here.
- **Allocation.** Every connection handler is a coroutine frame; HALO will not elide it because the handle escapes into the ring. Use a promise-level `operator new` over a pool sized to the frame (Ch. 19 §19.9) so the steady state is allocation-free and frames stay page-local.

**Ecosystem:** Boost.Asio (`awaitable<T>`, `co_spawn`, `use_awaitable`) is the mature production answer; `liburing` directly for the lowest level; `libunifex`/`stdexec` for the sender-based version; Seastar and Folly's coroutines for whole-application frameworks. For genuinely latency-critical trading paths, note the honest conclusion: coroutine I/O is a *throughput and clarity* win for many connections, while the tick-to-trade path is typically a single busy-polling loop over a kernel-bypass ring (Ch. 47) with no coroutines at all — because the indirect resume, the frame's cache footprint, and the loss of inlining are measurable at that scale.

---

## Key Interview Questions

1. **What is in a `std::future`'s shared state, and what does that cost?** — Value or `exception_ptr`, ready flag, mutex, condvar, refcount; one heap allocation per operation and a futex round trip to wait.
2. **What happens if a `promise` is destroyed without being satisfied?** — The shared state gets a `broken_promise` exception, so the waiting `get()` throws instead of hanging.
3. **Difference between `future` and `shared_future`?** — `future::get()` is one-shot and moves the value; `shared_future` is copyable and returns `const T&` to many consumers.
4. **Why did `future::then` never make it into the standard?** — Continuations require an executor/scheduler concept the standard lacked; the Concurrency TS design was superseded by senders/receivers (P2300).
5. **Why does a thread-pool `submit` often wrap the `packaged_task` in a `shared_ptr`?** — `packaged_task` is move-only and pre-C++23 `std::function` requires a copyable target; `std::move_only_function` (C++23) removes the wrapper.
6. **What does `std::async` with the default policy do wrong?** — It may defer, so "parallel" work runs serially on the consumer, never runs if `get()` is never called, and `wait_for` reports `deferred` forever.
7. **Why does `std::async(f);` as a statement block?** — The temporary future's destructor joins the task. Only `std::async`-produced futures behave this way.
8. **How many threads does `std::async(launch::async, ...)` create?** — Implementation-defined but on libstdc++/libc++ one fresh `std::thread` per call, roughly 10–30 µs of setup.
9. **Why is there no preemptive thread cancellation in C++?** — Killing a thread mid-stack leaves destructors unrun and locks held; cancellation must be cooperative via `stop_token`.
10. **How do you cancel a thread that is blocked rather than polling?** — A `std::stop_callback` that performs the wakeup: `notify_all`, write to an `eventfd`, `shutdown()` the socket, or submit an `io_uring` cancel.
11. **What are the `stop_callback` ordering rules?** — Runs immediately on the constructing thread if stop was already requested; its destructor blocks while it runs elsewhere but not when it is running on the same thread.
12. **Why does only `condition_variable_any` have a stop-token overload?** — The token integration needs a `stop_callback` around an arbitrary lockable; plain `condition_variable` is restricted to `unique_lock<mutex>` and was left alone.
13. **Why prefer `std::jthread`?** — Its destructor requests stop and joins, instead of `std::terminate`, and it injects the `stop_token`.
14. **What are the three receiver completion channels?** — `set_value`, `set_error`, `set_stopped` — cancellation is a first-class outcome, not an error.
15. **Why are senders lazy, and why does that eliminate allocation?** — Nothing runs until `start`, so the whole graph's storage is known at compile time and composes into one immovable operation state that can live on the stack.
16. **What is an operation state and why is it immovable?** — The storage `connect` produces for one execution; receivers and awaiters hold pointers into it, so moving it would invalidate them.
17. **How does cancellation propagate in the sender model?** — `get_stop_token(get_env(receiver))` — the environment carries it, so no signature threading; C++26 adds `inplace_stop_token` for the non-allocating case.
18. **What does `await_ready()` returning `true` buy you?** — It skips the suspend entirely — the fast path when data is already buffered or the operation completed synchronously.
19. **What is the hardest correctness problem in coroutine I/O?** — Frame lifetime versus in-flight kernel operations; you must cancel and wait for the cancellation completion before destroying the coroutine.
20. **How do you make a coroutine-based server allocation-free in steady state?** — A promise-level pooled `operator new`/`operator delete`, since HALO cannot elide a frame whose handle escapes into the completion ring.
21. **When does `io_uring` eliminate the syscall entirely?** — With `IORING_SETUP_SQPOLL`, where a kernel thread polls the submission queue — trading a core for the ~1–2 µs syscall cost.
22. **Would you put coroutines on the tick-to-trade path?** — Generally no: the indirect resume, frame cache footprint, and lost inlining are measurable; a single busy-poll loop over a kernel-bypass ring wins. Coroutines win on throughput and clarity for many connections.

---

## Common Traps

- **Calling `future::get()` twice** — throws `future_already_retrieved`; use `shared_future`.
- **Using `std::promise`/`future` in a hot loop** — an allocation plus mutex/condvar per handoff.
- **Storing a `packaged_task` in a `std::function`** — move-only; needs `shared_ptr` or C++23 `move_only_function`.
- **`std::async` with the default launch policy** — may defer, silently serializing or never running.
- **An unnamed `std::async(...)` expression statement** — the temporary future's destructor blocks; the call is synchronous.
- **Polling a deferred future with `wait_for(0s)`** — returns `deferred` forever; no progress.
- **Passing references to `std::async`/`std::thread` without `std::ref`** — arguments are decay-copied; and with `std::ref` plus deferral, they dangle.
- **Expecting `std::async` to use a thread pool** — it does not on Linux implementations.
- **Assuming `stop_requested()` interrupts a blocked call** — it does not; you need a `stop_callback` that performs a wakeup.
- **Long or blocking work inside a `stop_callback`** — it runs on the thread that called `request_stop()`.
- **Destroying a `stop_callback` while it runs on another thread** — the destructor blocks; a lock held across it can deadlock.
- **Using `std::thread` and forgetting to join** — `std::terminate` in the destructor.
- **Expecting a sender pipeline to have started** — senders are lazy; without `start`/`sync_wait`/`spawn` nothing runs.
- **Moving an operation state** — it is immovable by design.
- **Blocking inside a receiver's `set_value`** — it runs on the completing context, stalling the scheduler.
- **Destroying a coroutine with an in-flight `io_uring` operation** — the completion resumes a freed frame.
- **Buffers or state captured by reference in a coroutine** — not in the frame; dangling across suspension.
- **Doing long work in a resumed continuation on the event-loop thread** — head-of-line blocking for every other connection.
- **Assuming `epoll`/`io_uring` readiness means a full message** — short reads are normal (Ch. 34 §34.19); frame explicitly.

---

## Compact Recall Summary

**Futures/promises.** A heap-allocated shared state carrying a value or `exception_ptr` plus a mutex, condvar, and refcount. One-shot; `get()` moves and rethrows; `shared_future` for many consumers. Destroying an unsatisfied promise yields `broken_promise` rather than a hang. Establishes happens-before. No continuations, no cancellation, no allocator control — which is exactly why senders exist.

**`packaged_task`.** Callable + promise with automatic exception capture; move-only, so pre-C++23 pools wrap it in a `shared_ptr` to fit `std::function`. `std::move_only_function` (C++23) fixes that. The full naive submit path costs 200–500 ns before any work runs; real low-latency pools use a lock-free ring of POD descriptors and caller-owned result slots.

**`std::async`.** Always pass `launch::async`; the default may defer, serializing the work or never running it. The returned future's destructor **joins** — unique to `async` — so an unnamed result is a synchronous call. One OS thread per call on libstdc++/libc++ (~10–30 µs). Fine for a few coarse blocking tasks; wrong for anything else.

**Cancellation.** Cooperative only. `stop_source` requests, `stop_token` observes, `stop_callback` reacts — the callback is how you wake a *blocked* target (`notify_all`, `eventfd`, `shutdown`, `io_uring` cancel). Runs on the requesting thread, so keep it short. `condition_variable_any` has the stop-aware `wait`; plain `condition_variable` does not. `jthread` = stop-then-join destructor and automatic token injection. C++26 `inplace_stop_token` gives the same semantics allocation-free.

**Senders/receivers** (P2300, C++26). A sender describes work; `connect(sender, receiver)` yields an immovable operation state; `start` runs it. Three channels: value, error, **stopped**. Lazy composition means the entire pipeline's storage is a single compile-time-sized object — zero allocations, no per-stage mutex, explicit placement via schedulers, cancellation and allocators carried in the receiver's environment. `sync_wait` is the blocking bridge. Cost: large types, slow compiles, hostile diagnostics. `stdexec` and `libunifex` are the usable implementations today; Asio's executors/completion tokens solve the same problem differently.

**Coroutine I/O.** `await_suspend` stashes the handle in the operation's `user_data` and submits an SQE; the loop drains completions and calls `resume()` inline. `await_ready() == true` is the no-suspend fast path. Frame lifetime versus in-flight kernel ops is the central hazard — cancel and await the cancellation before destroying. Keep buffers in the frame (by value), batch submissions per loop iteration, use registered buffers/files, consider `SQPOLL` to erase the syscall, and pool frame allocation because HALO cannot elide an escaping handle. Coroutine reactors win on throughput and readability at high connection counts; the tick-to-trade path stays a busy-polling kernel-bypass loop.
