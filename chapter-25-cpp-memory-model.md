# Chapter 25 — C++ Memory Model

The memory model is the contract between a C++ program, the optimizer, and the machine that executes it. Correctness is proved in the C++ abstract machine; instruction mappings and costs are separate implementation facts.

---

## 25.1 Why This Matters — Core

Every concurrent queue, counter, and published configuration snapshot depends on this contract. Too little ordering can make a program undefined or allow an unwanted execution; too much can constrain optimization and generate unnecessary instructions. The durable method is to identify conflicting accesses, draw the required happens-before edges, and only then choose the weakest order that supplies them.

---

## 25.2 The 90-Second Screen — Core

Five facts:
1. A **data race** — two conflicting accesses, at least one non-atomic, unordered by happens-before — is undefined behavior, not a stale read. The compiler is entitled to assume none exist, and optimizes accordingly.
2. `std::atomic<T>` removes the data race for accesses to that atomic. `relaxed` also supplies per-object modification order; acquire/release can create cross-thread edges; `seq_cst` adds one total order for sequentially consistent operations.
3. **Synchronizes-with** requires an acquire to read the value a release wrote (or a value in its release sequence). No observed value, no edge, no guarantee.
4. **Happens-before** includes sequenced-before, synchronizes-with, and their transitive consequences. Unordered conflicting non-atomic accesses form a data race; unordered atomic accesses are permitted but may observe surprising values.
5. Every atomic object has its own **modification order**, agreed by all threads under every memory order. It does not impose one order across different atomic objects.

Two decisions to be able to defend:
- Relaxed vs acquire/release vs seq_cst for a given access, justified by what other thread needs to observe and when — not by "seq_cst is always safe so just use it."
- Ordered atomic operation vs standalone fence, justified by whether you are amortizing one barrier over several accesses or ordering exactly one access.

---

## 25.3 The Abstract Machine, Memory Locations, and Data Races — Core

The standard describes an **abstract machine**. Its observable behavior includes I/O, accesses to volatile objects, and the values and ordering constraints imposed by synchronization. A compiler may transform a program aggressively if the result is one of the abstract machine's permitted executions. Source order and assembly order are therefore evidence, not the correctness definition.

A **data race** occurs when two potentially concurrent actions on the same *memory location* conflict — at least one modifies the location or starts/ends an overlapping lifetime — at least one action is non-atomic, and neither happens-before the other (§25.7). A data race is undefined behavior.

**Memory location** is a scalar object, or a maximal run of adjacent bit-fields of non-zero width. Two threads writing distinct members of a struct is not a race: the model guarantees separate scalar members are separately addressable, so the compiler cannot implement `s.a = 1` as a read-modify-write of a wider word containing `s.b`. Two threads writing *adjacent bit-fields*, by contrast, are writing one memory location and do race.

```cpp
struct S { char a; char b; };                  // a and b: distinct locations, no race
struct T { unsigned a : 4; unsigned b : 4; };   // one location — RACE
struct U { unsigned a : 4; unsigned : 0; unsigned b : 4; };  // :0 splits them — no race
```

### Why it is UB, not "torn"

Because the compiler may assume race-freedom, it can perform transformations that are unsound in the presence of a race:

- **Load hoisting out of a loop.** `while (!flag) {}` on a non-atomic `flag` may legally become `if (!flag) for(;;);` — an infinite loop, and the most common real-world manifestation of this rule.
- **Race-free assumptions affect transformation.** The standard constrains introduced stores for well-defined concurrent programs, but once the source has a data race there is no requirement to preserve a source-level interleaving model. Do not treat those constraints as a fallback guarantee for racy code.
- **Register promotion.** Two reads of a shared non-atomic variable can yield different values, or the same stale value forever — there is no requirement that a write ever becomes visible.

### The running example: a message-passing race

This chapter tracks one example, `data`/`ready`, through three versions as it gains each guarantee in turn. Version 1 is racy:

```cpp
// v1 — RACY. Do not write this.
int data = 0;
bool ready = false;

void producer() { data = 42; ready = true; }
void consumer() { while (!ready) {} ; use(data); }
```

`ready` is a plain `bool`, so its read conflicts with the writer and the whole execution has undefined behavior. Load hoisting can turn the polling loop into an infinite loop, but once the race exists it is invalid to enumerate “allowed stale values” as though the program merely lacked freshness. §25.5 removes the races; §25.6 supplies the intended ordering.

The minimal fix for a flag whose value alone matters is `std::atomic<bool>`; `memory_order_relaxed` removes the race. If seeing the flag must publish other data, release/acquire is also required (§25.6). `volatile` is not a substitute (§25.20).

### DRF-SC

The **data-race-free sequential-consistency guarantee** is the foundation for ordinary mutex-based C++: if a program has no data races and uses only sequentially consistent atomics, its behavior can be explained by an interleaving that respects each thread's sequenced-before order. Weaker atomics deliberately admit additional executions, but they do not turn atomic accesses into data races. This is why race freedom is the first proof obligation and order selection is the second.

### Tooling

ThreadSanitizer (`-fsanitize=thread`, Ch. 44 §44.4) dynamically tracks happens-before and reports unordered conflicting accesses on executions it observes. It has substantial overhead and cannot prove a program race-free; pair it with focused concurrency tests (Ch. 57 §57.7). It also cannot infer synchronization hidden in arbitrary assembly or in code that incorrectly uses `volatile` as an atomic.

---

## 25.4 Atomicity and Lock Freedom — Core

`std::atomic<T>` (C++11, `<atomic>`) makes operations on `T` indivisible and adds an ordering parameter. For the primary template, `T` must be cv-unqualified, trivially copyable, copy- and move-constructible, and copy- and move-assignable (Ch. 3 §3.5). Floating-point specializations gained `fetch_add`/`fetch_sub` in C++20.

```cpp
std::atomic<int> a{0};              // C++17: brace-init works
a.store(1, std::memory_order_release);
int v = a.load(std::memory_order_acquire);
a += 1;                              // operator overloads are ALL seq_cst
```

Every operator overload on `std::atomic` (`++`, `+=`, `=`, implicit conversion to `T`) uses `memory_order_seq_cst`. A target may map an SC and relaxed RMW to the same instruction, but the RMW itself can still be costly, especially under contention. Prefer named operations with an explicit order when the proof calls for a weaker one.

### Lock freedom

An atomic operation is **lock-free** when its implementation does not rely on a blocking lock. This is a progress property, not a latency promise: under contention, an individual operation may still starve. Implementations may use an internal lock when no suitable lock-free sequence is available.

| Query | Kind | Meaning |
|---|---|---|
| `a.is_lock_free()` | member, runtime | Is *this object* lock-free (can depend on alignment) |
| `std::atomic<T>::is_always_lock_free` | static `constexpr` (C++17) | Lock-free for every object of this type on this platform; usable in `static_assert`/`if constexpr` |
| `ATOMIC_INT_LOCK_FREE` etc. | macro | 0 = never, 1 = sometimes, 2 = always; preprocessor-usable |

Code with nonblocking, signal-handler, or process-shared requirements must verify more than the C++ type alone. `is_lock_free()` and `is_always_lock_free` describe this implementation's atomic operations; they do not by themselves specify async-signal safety or interprocess semantics. For process-shared memory, also follow the operating system and ABI contract. Treat lock freedom as a build-target property and test it on the actual toolchain and flags (§25.18).

**Cost model.** A lock-free atomic RMW commonly requires exclusive ownership of the cache line (Ch. 28 §28.3). Contention can add transfers between cores or sockets and dominate the instruction's nominal cost. Measure on the target hardware.

### `std::atomic_ref` (C++20)

`std::atomic_ref<T>` applies atomic operations to an object that is *not* declared `std::atomic`, solving the problem that `std::atomic<T>` changes the type when a plain representation is required for bulk copying or an external library interface.

```cpp
#include <atomic>
#include <cstddef>

struct alignas(std::atomic_ref<double>::required_alignment) Sample {
    double value{};
};

Sample data[1024]; // every element has the required alignment

void add(std::size_t i, double x) {
    std::atomic_ref<double> r{data[i].value};
    r.fetch_add(x, std::memory_order_relaxed);
}
```

Rules that matter:

- **While any `atomic_ref` to an object exists, all accesses to that object must go through an `atomic_ref`.** A plain read concurrent with an `atomic_ref` write is still a race. The type does not enforce this; discipline does.
- The referenced object must be aligned to `std::atomic_ref<T>::required_alignment`, which can be **stricter than `alignof(T)`**. Violating the construction precondition is UB; the machine-level consequence is target-specific (§25.20).
- `atomic_ref` is trivially copyable; construction is normally cheap but has no mandated code-generation cost.
- It does not extend lifetime and does not own anything — a dangling `atomic_ref` is the same hazard as a dangling reference.

Typical use: a sequence counter embedded in a market-data slot (Ch. 26 §26.10), or a per-core statistics array aggregated non-atomically after worker threads have joined. Before C++20, code often used implementation-specific atomic builtins; their exact contract belongs to that compiler.

---

## 25.5 Relaxed Ordering — Core

`memory_order_relaxed` guarantees **atomicity and per-object modification-order consistency, and nothing else**. There is no ordering relative to any other memory operation on any other object.

What relaxed still guarantees:

- The operation is indivisible: no tearing.
- Each atomic object has one modification order that all threads agree on, and relaxed operations respect it (§25.8).
- No UB — a "relaxed race" is not a race.
- It supplies no bounded-time visibility, scheduling, or progress guarantee.

### The running example, version 2

```cpp
// v2 — relaxed. Fixes the UB, not the ordering bug.
std::atomic<int> data{0};
std::atomic<bool> ready{false};

void producer() { data.store(42, std::memory_order_relaxed); ready.store(true, std::memory_order_relaxed); }
void consumer() { while (!ready.load(std::memory_order_relaxed)) {} ; use(data.load(std::memory_order_relaxed)); }
```

This removes the data race — both objects are now atomic, so the UB is gone, and the loop cannot be legally collapsed the way a non-atomic spin can (see below). But it does not fix the actual bug: nothing stops the CPU or compiler from making `ready`'s new value visible to `consumer` before `data`'s new value is. A relaxed-only consumer can observe `ready == true` and `data == 0`. §25.6 fixes this with release/acquire.

### What a relaxed spin loop actually does

A relaxed-atomic spin loop is not equivalent to a non-atomic one. The source evaluates an atomic load on every iteration; replacing the loop with one initial load would not preserve the permitted executions of those repeated atomic operations. This does **not** promise that another thread will be scheduled, that a write will arrive within a deadline, or that the waiting thread will make progress.

That does not make the loop good code. It consumes execution resources, and each writer update can trigger coherence traffic. Add a pause or use a spin-then-park policy:

```cpp
while (!stop.load(std::memory_order_relaxed)) {
    std::this_thread::yield();      // or _mm_pause() / a spin-then-park scheme, Ch. 24 §24.10
}
```

Relaxed gives no ordering with other objects; progress is a separate question.

### Legitimate uses

```cpp
// 1. Statistics/counters read only after joining, or aggregated non-atomically at shutdown.
packets.fetch_add(1, std::memory_order_relaxed);

// 2. Reference-count INCREMENT — you already hold a reference, so there is nothing to order.
refcount.fetch_add(1, std::memory_order_relaxed);

// 3. A stop flag polled where the exact iteration observed doesn't matter.
while (!stop.load(std::memory_order_relaxed)) { work(); }

// 4. Sequence-number allocation in a ring buffer, where a separate release/acquire
//    on the slot state (not shown) carries the data (Ch. 26 §26.4 and §26.8).
auto pos = head.fetch_add(1, std::memory_order_relaxed);
```

Case 2 has a well-known asymmetry: increment is relaxed, but **decrement needs acquire** (commonly `acq_rel`, or `release` plus a separate acquire fence before destruction — libstdc++'s `shared_ptr` uses the fence form). The reasoning is precise and worth stating precisely, because it is easy to over-claim:

The thread whose decrement takes the count to zero must see every write made by every *other owner* **before that owner's own decrement**, because those writes are what each owner did while it legitimately held a reference. Release-on-decrement / acquire-on-the-final-decrement is exactly the mechanism: each owner's writes are sequenced-before its own release decrement, and the final decrement's acquire synchronizes-with each of those decrements through the release sequence (§25.14), giving the destroying thread happens-before edges from every owner's writes.

This ordering is scoped to the *decrement itself* and the writes each owner made under its own ownership. It says nothing about writes some other, unsynchronized thread makes to the managed object outside of the refcounting protocol — for example, a thread that holds no reference and pokes the object through a raw pointer it captured earlier, or two owners that concurrently mutate the object through their own copies without any additional synchronization between themselves. The refcount protocol only orders "release my reference" against "destroy," not arbitrary concurrent access to the pointee. If two threads need to safely read and write the *managed object's contents* concurrently, that needs its own synchronization, independent of the control block.

### The trap

Relaxed does not mean “ordered enough on x86.” The language supplies no cross-object edge, even when one target's current instruction mapping happens to preserve the desired order. Correctness must survive another optimizer, ISA, and permitted abstract execution.

---

## 25.6 Release/Acquire and Safe Publication — Core

The workhorse pair is defined by the values atomic operations observe:

- A **release** operation can publish evaluations sequenced before it.
- An **acquire** operation can receive that publication when it reads the release's value, or a value in its release sequence.

“One-way barrier” is useful implementation intuition, but the synchronizes-with rule—not a guessed physical reordering—is the proof.

```
     T1 (producer)                 T2 (consumer)
  data = 42;              ─┐
  ready.store(1, release); │ release   while(!ready.load(acquire));  ─┐ acquire
                           │ ...................................      │
                                                    read data == 42  ─┘
```

When an acquire load **reads the value written by** a release store (or a value later in that store's release sequence, §25.14), the two operations **synchronize-with** each other, and everything sequenced before the store in T1 happens-before everything sequenced after the load in T2 (§25.7). That is the whole mechanism of safe publication.

### The running example, version 3

```cpp
// v3 — correct.
std::atomic<int> data{0};
std::atomic<bool> ready{false};

void producer() {
    data.store(42, std::memory_order_relaxed);      // atomic write; published by the release below
    ready.store(true, std::memory_order_release);
}
void consumer() {
    while (!ready.load(std::memory_order_acquire)) {}
    use(data.load(std::memory_order_relaxed));       // guaranteed to see 42
}
```

Two correctness points:

1. **Synchronization requires the read to observe the write.** A release store nobody reads synchronizes with nothing. An acquire load that reads a *different, older* value synchronizes with nothing either — the `while` loop is not decoration; the edge exists only on the iteration that observes the new value.
2. **`acq_rel`** applies both roles to one RMW: it acquires from the value it reads and releases to whoever later reads its write. A reference count's final `fetch_sub` is a common example; individual algorithms may need only one half.

Release/acquire is pairwise and transitive through the happens-before graph, but is **not** a global order the way `seq_cst` is: two independent release stores, observed by two independent acquire loads in two different threads, give no guarantee that both observers agree on the relative order of the stores (IRIW, §25.10).

### Pointer publication

```cpp
Widget* w = new Widget(args);            // (1) all constructor writes
ptr.store(w, std::memory_order_release); // (2) release: (1) cannot move after (2)

// Consumer
if (Widget* p = ptr.load(std::memory_order_acquire))  // (3) acquire
    p->use();                                          // (4) sees a fully constructed object
```

The chain: (1) sequenced-before (2); (2) synchronizes-with (3) because (3) reads (2)'s value; (3) sequenced-before (4). Therefore (1) happens-before (4). With a relaxed store or load, that edge does not exist. Reading the non-atomic object while its initialization is unordered can therefore be a data race, independent of what one machine happens to do.

**Application: double-checked locking.** The classic broken pattern:

```cpp
// BROKEN
if (instance == nullptr) {                  // non-atomic read races the write below
    std::lock_guard lk(m);
    if (instance == nullptr)
        instance = new Singleton();         // non-atomic write; may become visible before construction completes
}
return instance;
```

Two independent bugs: the outer read races the inner write, and nothing publishes the constructor's writes. `volatile` fixes neither defect.

```cpp
// CORRECT with atomics
std::atomic<Singleton*> instance{nullptr};
std::mutex m;
Singleton* get() {
    Singleton* p = instance.load(std::memory_order_acquire);
    if (!p) {
        std::lock_guard lk(m);
        p = instance.load(std::memory_order_relaxed);   // relaxed: the mutex already orders us
        if (!p) {
            p = new Singleton();
            instance.store(p, std::memory_order_release);
        }
    }
    return p;
}

// CORRECT and preferred: magic statics (C++11)
Singleton& get_static() { static Singleton s; return s; }
```

Function-local `static` initialization has been thread-safe since C++11; the implementation supplies the necessary synchronization. Eager initialization can remove a recurring initialization check when that matters, but its cost and code generation are implementation-dependent.

---

## 25.7 Happens-Before and Synchronizes-With — Core

The definitional core of the chapter, built up in order.

**Sequenced-before** — intra-thread program order, as constrained by evaluation rules (Ch. 4 §4.3). Not a total order within a thread, because some subexpressions are unsequenced.

**Synchronizes-with** — a cross-thread edge, created when:
- An acquire operation reads a value written by a release operation on the same atomic, or a value in its release sequence (§25.14).
- The fence-based variants (§25.15).
- `std::thread` construction synchronizes-with the start of the new thread's execution; the thread's completion synchronizes-with the return from `join()`.
- Mutex `unlock()` synchronizes-with a subsequent `lock()` that acquires it (Ch. 24).
- `promise::set_value` with `future::get`; `call_once` completion with a subsequent `call_once` return; latch `count_down` with `wait`; semaphore `release` with `acquire`.

**Inter-thread happens-before** — the transitive closure of synchronizes-with and sequenced-before across threads (the consume-based *dependency-ordered-before* relation, §25.13, also contributes but is not load-bearing in practice).

**Happens-before** — sequenced-before together with inter-thread happens-before. If a write happens-before a conflicting non-atomic read, there is no race and the read's value is constrained by the visible-side-effect rules.

```
Thread A                        Thread B
--------                        --------
data = 42;          ┐ sequenced-before
flag.store(1, rel); ┘   ───── synchronizes-with ─────► flag.load(acq) == 1  ┐ sequenced-before
                                                       read data           ┘
      ⇒ (data = 42)  happens-before  (read data)   ⇒  reads 42
```

### Three common mistakes

1. **Happens-before is not a time relation.** It says nothing about wall-clock order. Two operations can be unordered by happens-before yet strictly ordered in real time — that is exactly the racy case, and it is exactly what makes such bugs intermittent. "It always works in testing" is not evidence of an edge.
2. **Happens-before is a partial order**, but it does chain through repeated release→acquire hops on the *same objects*: if T1 releases `x`, T2 acquires `x` then releases `y`, and T3 acquires `y`, then T1's writes are visible to T3. What it does *not* do is connect two independent release stores with no such chain — synchronizing on `x` tells you nothing about `y` unless something links them.
3. **`seq_cst` adds a total order S over `seq_cst` operations, not a replacement for happens-before** (§25.10). The standard constrains S through its strongly-happens-before and coherence rules; mixed-order proofs must use those rules rather than assuming every non-SC operation joins S.

For a publication proof, name the release, name the acquire, and confirm the acquire reads from the release or its release sequence. Then connect the surrounding sequenced-before edges. Mutexes, thread start/join, and fences create other edges, but the graph method is the same.

---

## 25.8 Modification Order and Coherence — Core

Every atomic object has a **modification order**: a total order over all modifications of *that object*, agreed by all threads. This exists even for `relaxed` operations and even with no happens-before edge.

```
Modification order of `count` (one atomic object), agreed by every thread:
   0 ──write(T1)──► 1 ──write(T2)──► 2 ──write(T1)──► 5

A read by any thread, at any time, observes some point on this single line —
never two different threads disagreeing about which write came before which,
for THIS object.
```

Four coherence rules follow, guaranteed regardless of memory order:

| Rule | Statement |
|---|---|
| Write-write | If write A happens-before write B, A precedes B in the modification order. |
| Read-read | If read A happens-before read B (same object), B reads the same or a later write. |
| Read-write | If read A happens-before write B, A reads a write earlier than B. |
| Write-read | If write A happens-before read B, B reads A or a later write. |

**"Values never go backwards" needs a precise reading.** Read-read coherence says a thread's *successive reads* of one atomic cannot move backward in that object's modification order — if a thread reads `5` from a counter, a later read by that same thread (ordered by happens-before, which same-thread reads always are) cannot see `2`. This is a statement about **reads**, not about what gets written. A later **write** to the same object may legitimately store a numerically smaller value than an earlier write — `count.store(5, ...)` followed by `count.store(2, ...)` is completely ordinary and adds `2` after `5` in the modification order. Nothing about coherence prevents a value decreasing; it only prevents any one thread's reads from time-traveling backward through the sequence of writes that did happen.

Other consequences:

- There is **no such guarantee across two different objects.** Thread T can observe `x == 1, y == 0` while thread U observes `x == 0, y == 1`, with relaxed or even release/acquire ordering — this is IRIW (§25.10), forbidden only under `seq_cst`.
- **RMWs read the value immediately preceding their own write in the modification order** — no gap where another thread's write could be lost. This is what makes `fetch_add(1, relaxed)` a correct counter with no cross-object ordering: every increment is accounted for, even though nothing says *when* one thread's increment becomes visible to another.

Atomicity and per-object coherence are not cross-object ordering. On common coherent machines the cache protocol helps implement modification order, but the language rule is independent of cache-line layout or a particular protocol (Ch. 28 §28.3).

---

## 25.9 Read-Modify-Write and Compare-Exchange — Core

An **RMW** reads, computes, and writes back as one indivisible step, reading the value immediately preceding its own write in the modification order (§25.8).

| Operation | Typical x86-64 | Typical AArch64 with LSE | Typical AArch64 without LSE |
|---|---|---|---|
| `fetch_add` | `lock xadd` | `ldadd` | `ldxr`/`add`/`stxr` retry loop |
| `exchange` | `xchg` (implicitly locked) | `swp` | `ldxr`/`stxr` loop |
| `compare_exchange` | `lock cmpxchg` | `cas` | `ldxr`/`cmp`/`stxr` loop |
| `fetch_or/and/xor` | `lock or` (discarded result) / `cmpxchg` loop (result used) | `ldset`/`ldclr`/`ldeor` | `ldxr`/`stxr` loop |

This table describes common code generation on named toolchains, not a language guarantee — confirm on your target if the distinction matters. Points worth knowing:

- A discarded RMW result can permit cheaper code than consuming the old value on some targets. Inspect generated code when this distinction matters.
- A common x86 mapping uses the same locked instruction for relaxed and `seq_cst` RMWs; the operation is still expensive under contention. Writing the semantic minimum documents the proof and may matter elsewhere.
- AArch64 compilers may select a single LSE instruction or an exclusive-load/store retry loop according to architecture level, flags, and runtime dispatch. Do not infer the mapping from the source alone.
- **`atomic_flag`** is guaranteed lock-free (`test_and_set`/`clear`, and `test` since C++20). Ch. 24 §24.10 uses it to explain spinlocks.
- **Contention behavior.** RMWs on one line serialize: N threads incrementing one counter contend for one modification order and cache line, and throughput can fall as core count rises. A common alternative is per-owner sharded counters aggregated on read (Ch. 59 §59.3), not a different memory order.

### Compare-exchange loops

`compare_exchange_weak/strong(expected, desired, success_order, failure_order)` compares the atomic's value against `expected`; on match it stores `desired` and returns `true`; on mismatch it **writes the actual current value into `expected`** and returns `false`. That in-out behavior is what keeps the canonical loop free of a redundant reload:

```cpp
template <class T, class F>
T fetch_apply(std::atomic<T>& a, F f) {
    T old = a.load(std::memory_order_relaxed);
    while (!a.compare_exchange_weak(old, f(old),
                                    std::memory_order_release,   // success
                                    std::memory_order_relaxed))  // failure
        ;                                                        // `old` was refreshed for us
    return old;
}
```

`f` must be pure or otherwise safe to invoke again: contention and spurious failure can evaluate `f(old)` more than once before one CAS succeeds.

**Failure-order constraints (C++23).** Failure performs only a load, so its order may not be `release` or `acq_rel`, and it may not be stronger than the success order.

| Success | Permitted failure orders |
|---|---|
| `relaxed` | `relaxed` |
| `acquire` | `relaxed`, `acquire` |
| `release` | `relaxed` |
| `acq_rel` | `relaxed`, `acquire` |
| `seq_cst` | `relaxed`, `acquire`, `seq_cst` |

The single-order overload maps `release` failure to `relaxed` and `acq_rel` failure to `acquire`. Pass an explicit weaker failure order when retries need no ordering.

**Comparison is representation-based, not `operator==`.** Since C++20 the wording compares the value representation; padding bits that never participate in a value representation are ignored. Two consequences remain:

- Types with multiple value representations, including some unions, can still make CAS reasoning subtle because indeterminate bits may participate in the active value. `std::has_unique_object_representations_v<T>` is a useful sufficient check for a simple bitwise representation, but is not required for every valid CAS use.
- Floating point compares bitwise under CAS, so `+0.0`/`-0.0` (equal by `==`, different bit patterns) and NaN (never equal by `==`, but bit-identical NaNs compare equal under CAS) behave unintuitively. Reason about CAS on floats as bit comparison, not value comparison.

The retry loop is not wait-free: any given thread can starve under contention. Whether the atomic operation and the larger algorithm are lock-free must be established separately (Ch. 26 §26.1).

#### Backoff

Under contention, a naked CAS loop repeatedly seeks exclusive ownership of the same cache line. A common pattern first polls with relaxed loads, attempts CAS only when the state looks winnable, then escalates from a processor pause hint to yielding or parking. Ch. 24 §24.10 covers spin-then-park policy.

### Spurious compare-exchange failure

`compare_exchange_weak` may return `false` even when the comparison would have succeeded. `compare_exchange_strong` may not.

The distinction supports implementations built from load-linked/store-conditional instructions. The conditional store can fail even though the C++ value still compares equal; a strong CAS must internally filter such failures.

| Use | Choose |
|---|---|
| Inside a loop you were going to retry anyway | `weak` — the outer loop absorbs spurious failure for free |
| A single, non-looping attempt | `strong` — otherwise you must hand-write the filtering loop |
| A target mapping both forms to one CAS instruction | Often identical code; retain the portable semantic distinction |

On a mapping that uses one hardware CAS instruction, weak and strong commonly generate identical code. Source must nevertheless handle the standard's permitted spurious failure for `weak`.

After a spurious failure, `expected` is still refreshed to the value actually read, so a loop written as above is correct either way. A spurious failure is indistinguishable from a genuine mismatch at the API level — never put a side effect in the failure branch that assumes the value changed.

---

## 25.10 Sequential Consistency and Litmus Tests — Core

`memory_order_seq_cst` is the default for atomic operations. C++ places all `seq_cst` operations in one total order **S**, constrained by the standard's strongly-happens-before and per-object coherence requirements. This is not a claim that every operation in a mixed-order program is sequentially consistent.

### When to use it

Use it when multiple threads must agree on an order across multiple atomic objects—for example, “at least one thread must observe the other's flag.” Producer/consumer publication usually needs only release/acquire. Begin with a correctness proof; weaken an order only when the unwanted executions remain excluded.

### Cost

The standard assigns no instruction or latency. Common x86-64 mappings often make acquire loads and release stores plain loads/stores, while an SC store may require a locked instruction or fence. AArch64 and POWER mappings use different ordered instructions and barriers. Compilers, architecture revisions, memory types, and surrounding code all matter; §25.17 gives qualified examples.

### The four litmus tests

A litmus test is a minimal multi-threaded program plus a question about which final states are reachable. These four are the standard vocabulary; know the pattern, not just the name.

**SB — Store Buffer / Dekker** (store→load reordering):
```
x = y = 0
T1: x.store(1); r1 = y.load();     T2: y.store(1); r2 = x.load();
Can r1==0 && r2==0 ?
```
With relaxed stores and loads, yes. Release stores plus acquire loads also permit it when both loads read the initial values, because no synchronizes-with edge is formed. With `seq_cst` on all four operations, no: S cannot place both loads before both stores.

**MP — Message Passing** (the publication pattern of this chapter's running example):
```
x = f = 0
T1: x = 1; f.store(1, release);     T2: if (f.load(acquire) == 1) r = x;
Can r == 0 ?
```
If the acquire reads the release and `x` is non-atomic, `r == 0` is forbidden (§25.6). If `f` is relaxed, the accesses to non-atomic `x` are unordered and the execution has a data race; it is not a valid “stale value” outcome to enumerate. To study relaxed value combinations without UB, make `x` atomic too.

**LB — Load Buffer** (load→store reordering):
```
T1: r1 = x.load(); y.store(1);     T2: r2 = y.load(); x.store(1);
Can r1==1 && r2==1 ?
```
The C++ model permits the outcome with relaxed atomics, subject to its value-computation rules. Whether a physical machine exhibits it depends on the ISA model and compiler mapping; common x86-TSO mappings forbid it, while weaker mappings can permit it.

**IRIW — Independent Reads of Independent Writes** (multi-copy atomicity):
```
T1: x.store(1);                     T2: y.store(1);
T3: r1 = x.load(); r2 = y.load();   T4: r3 = y.load(); r4 = x.load();
Can T3 observe x-before-y while T4 observes y-before-x?
```
The C++ model permits disagreement with relaxed operations, and release/acquire does not by itself create a total order between independent publications. `seq_cst` forbids it. Hardware claims need more qualification: multi-copy atomicity, architecture revision, shareability and memory type, and the compiler's C++ mapping all affect whether a language-allowed result appears. Common x86 mappings are stronger than required; POWER is the classic weak-ordering example. Treat AArch64 as a model-specific question, not a universal one-line answer.

**Tooling.** `herd7`/`litmus7` (the diy suite) run these patterns against formal hardware models or hardware experiments. CDSChecker and GenMC explore C11/C++ atomic executions of small programs; Chapter 57 §57.7 discusses where model checking fits. TSan can report a data race caused by a missing edge, but it does not prove that an all-atomic algorithm excludes every unwanted value combination. Use an appropriate language model checker for that proof, and hardware litmus testing as target-specific evidence—not as exhaustiveness.

### Litmus practice

These four variants demonstrate the proof method.

**Q1 (SB shape).** Two flags are initialized to 0:
```
T1: a.store(1, release); r1 = b.load(acquire);
T2: b.store(1, release); r2 = a.load(acquire);
```
Can `r1 == 0 && r2 == 0`?

**Q2 (MP shape).** A producer writes an atomic payload with `relaxed`, then a sequence number with `release`; a consumer reads the sequence number with `acquire` and, after seeing the published value, reads the payload with `relaxed`. Can it read the old payload?

**Q3 (LB shape).** On x86-64 specifically:
```
T1: r1 = x.load(relaxed); y.store(1, relaxed);
T2: r2 = y.load(relaxed); x.store(1, relaxed);
```
Can `r1 == 1 && r2 == 1` be observed on real x86-64 hardware?

**Q4 (IRIW shape).** Two independent threads each `store(1, memory_order_seq_cst)` to two different atomics `x` and `y`. Two further threads each load both `x` and `y`, also `seq_cst`. Can the two reader threads disagree about which of the two stores happened first?

**Answers.**
- Q1: Yes. Both acquire loads may read the initial values, so neither reads a release and no cross-thread edge forms. (`acq_rel` is not even a valid order for a plain store.)
- Q2: No, provided the sequence number's store is `release` and the load is `acquire`, and the consumer only proceeds to read the payload *after* observing the updated sequence number in that same acquire load. The synchronizes-with edge from the sequence-number release to the sequence-number acquire (§25.6, §25.7) puts the payload write happens-before the payload read, even though the payload access itself uses `relaxed`. This is exactly the ring-buffer pattern in §25.5's case 4 and Ch. 26 §26.4/§26.8 — the ordering rides on the sequence number, not on the payload's own memory order.
- Q3: Under the usual x86-64 TSO mapping for suitably aligned atomics in ordinary write-back memory, no. This is a qualified hardware observation, not an extra C++ guarantee.
- Q4: No. Both stores and all four loads are `seq_cst`, so they belong to the single total order S; the contradictory IRIW observations cannot be embedded in that order. This is precisely what `seq_cst` buys over release/acquire. The usual x86-64 mapping under the conditions just stated is already stronger than the relaxed C++ requirement here, which is why an x86-only stress test is not a language proof.

---

## 25.11 Worked Diagnosis: Publication, Not Just Atomicity — Core

Suppose one writer periodically replaces a configuration:

```cpp
struct Config { int venue; int limit; };
std::atomic<Config*> current{nullptr};

void publish(Config* p) {
    current.store(p, std::memory_order_release);
}

Config const* snapshot() {
    return current.load(std::memory_order_acquire);
}
```

The design proof has four steps:

1. The writer fully initializes `*p` before calling `publish`, so those writes are sequenced-before the release store.
2. A reader is allowed to dereference only the exact non-null pointer returned by its acquire load.
3. If that load reads the pointer written by the release, the operations synchronize-with.
4. Initialization therefore happens-before the reader's non-atomic field reads.

Changing either atomic operation to `relaxed` removes the cross-thread edge. Making the pointer atomic prevents pointer tearing, but does not by itself publish the pointee. Conversely, making every field atomic would avoid races but would be a different, usually more expensive design with no single-snapshot guarantee.

Lifetime is a separate obligation: the ordering above does not say when an old `Config` may be deleted. If readers can retain snapshots while updates occur, use an ownership or reclamation scheme. `atomic<shared_ptr>` is summarized in §25.19; epochs and hazard pointers belong to Chapter 26.

---

## 25.12 Deep dive: Atomic Fences — Deep dive

`std::atomic_thread_fence(order)` is a standalone synchronization primitive that can order evaluations around it once the fence-pairing rules are satisfied. It is not attached to one atomic object. `std::atomic_signal_fence(order)` constrains compiler reordering with respect to a signal handler in the same thread and emits no runtime synchronization instruction on conventional implementations.

| Fence call | Abstract-machine role |
|---|---|
| `atomic_thread_fence(acquire)` | An acquire fence; can receive synchronization through a qualifying atomic read |
| `atomic_thread_fence(release)` | A release fence; can publish prior evaluations through a qualifying atomic write |
| `atomic_thread_fence(acq_rel)` | Both acquire- and release-fence roles; not an SC fence |
| `atomic_thread_fence(seq_cst)` | An SC acquire-and-release fence; participates in S |
| `atomic_thread_fence(relaxed)` | No-op |
| `atomic_signal_fence(...)` | Ordering only between a thread and a signal handler executed in that thread |

Representative compiler mappings include `mfence` on x86-64, `dmb ish` on AArch64, and `sync` on POWER for an SC fence. These are not language requirements, and surrounding operations may change code generation.

### Fence vs. ordered operation

Calling a fence “strictly stronger” than an ordered atomic operation with the same tag is misleading. A fence constrains surrounding evaluations once a formal fence-pairing rule is satisfied, but a bare fence establishes no synchronizes-with edge. An ordered operation also carries a specific value, making the read-from proof direct. Prefer an ordered operation for one publication point; use a fence when its wider placement or conditional execution is part of the proof, and measure the target mapping.

Use a standalone fence when:

1. **Amortizing ordering across several operations.** One release fence plus a relaxed publication store can replace several individually ordered operations when the pairing proof is correct.
2. **Conditional acquire on spin-loop exit.**
   ```cpp
   while (flag.load(std::memory_order_relaxed) == 0) { cpu_relax(); }
   std::atomic_thread_fence(std::memory_order_acquire);   // pay the barrier once, on exit
   ```
   This can replace repeated acquire loads with relaxed polling and one exit fence only when the successful relaxed load reads from a release operation (or its release sequence) on `flag`. Whether it is cheaper is target-dependent.
3. **Interfacing with implementation-specific code** only when the compiler and platform explicitly document how the fence orders that code; arbitrary inline assembly is not automatically part of a C++ fence proof.
4. **Standard signal-handler interaction** — `atomic_signal_fence` constrains only compiler reordering. It is not inter-thread or device synchronization.

An SC fence can participate in S without modifying an atomic object. Its exact effect still depends on the surrounding atomic accesses and the formal fence rules.

---

## 25.13 Deep dive: Consume Ordering — Deep dive

`memory_order_consume` was designed as a cheaper acquire for pointer-chasing publication: where acquire orders a load against *all* subsequent operations, consume orders it only against operations *data-dependent* on the loaded value.

```cpp
std::atomic<Config*> cfg;
Config* q = cfg.load(std::memory_order_consume);
int v = q->field;    // data-dependent on q → ordered by consume
int w = other;       // NOT dependent → NOT ordered
```

The motivation is that several weakly ordered ISAs preserve suitable address dependencies with less ordering than a general acquire. Whether that produces a cheaper instruction sequence depends on the ISA revision, memory type, compiler mapping, and the exact dependency.

Production GCC and Clang configurations have historically treated `consume` as `acquire` rather than tracking the standard's dependency relation through optimization; this is toolchain/version behavior, not a C++ guarantee. Portable C++23 code should normally use `acquire` and treat `consume` as specialist history.

Kernel-style RCU dependency disciplines rely on platform-specific compiler and ISA contracts. Chapter 26 §26.12 introduces RCU as a reclamation strategy; it does not make a relaxed C++ load plus an ad-hoc compiler barrier a portable replacement for `consume`.

---

## 25.14 Deep dive: Release Sequences — Deep dive

Synchronizes-with requires an acquire to read *the value written by* a release store. What if other threads perform RMWs on the same atomic in between? Without a special rule, a consumer reading a *later* value would get no synchronization at all, and every counter-based handoff would break.

The **release sequence** headed by release operation A on atomic M is, in C++20 through C++23, the maximal contiguous subsequence of M's modification order starting at A and followed by atomic **read-modify-write** operations by any thread. Earlier standards also included certain same-thread writes.

An acquire load that reads *any* value in this sequence synchronizes-with A.

```cpp
std::atomic<int> count{2};
// T0:
data = 42;
count.store(0, std::memory_order_release);        // A: heads a release sequence

// T1: count.fetch_add(1, relaxed);   → value 1, still in A's release sequence
// T2: count.fetch_add(1, relaxed);   → value 2, still in the sequence
// T3: if (count.load(acquire) == 2) { read data; }   ← synchronizes-with A. Sees 42.
```

Without release sequences, T3 read a value written by T2's *relaxed* RMW, not by A, and would get no ordering guarantee at all. This rule is what makes counting semaphores, reference counts, and multi-consumer queues composable.

**C++20 change.** The earlier same-thread plain-write clause was removed. Since C++20, **only RMWs** extend a release sequence. Practical effect: `x.store(1, release); x.store(2, relaxed);` followed by a consumer reading `2` does not synchronize with the release store under C++20–23. This is an abstract-machine rule; no hardware story can restore the missing C++ edge.

---

## 25.15 Deep dive: Fence-Fence and Fence-Atomic Synchronization — Deep dive

Fences and ordered operations interoperate, and the exact pairing rules are worth knowing precisely.

**Fence–fence.** A release fence F1 in T1, sequenced-before an atomic modification X (possibly relaxed), and an acquire fence F2 in T2, sequenced-after a non-RMW atomic load Y that reads X or a value in the hypothetical release sequence X would head if it were a release operation: then F1 synchronizes-with F2.

```cpp
// T1                                        // T2
data = 42;                                   while (flag.load(relaxed) == 0) {}
std::atomic_thread_fence(release);           std::atomic_thread_fence(acquire);
flag.store(1, std::memory_order_relaxed);    read data;   // sees 42
```

**Fence–atomic.** The common producer/consumer combinations are below. “Yes” assumes the consumer-side load reads the producer's write or the value required by the applicable release-sequence rule.

| Producer | Consumer | Synchronizes? |
|---|---|---|
| release fence + relaxed store | relaxed load + acquire fence | Yes |
| release fence + relaxed store | acquire load | Yes |
| release store | relaxed load + acquire fence | Yes |
| release store | acquire load | Yes (the base case, §25.6) |

The rule to remember: the fence must be on the correct side. A release fence goes *before* the publishing modification; an acquire fence goes *after* the receiving load. Moving the acquire fence before that load does not establish the required standard edge. Any success on a particular machine is target/compiler behavior, not a C++ proof.

**A `seq_cst` fence is not the same as a `seq_cst` operation.** It participates in the total order S, but two relaxed stores separated only by `seq_cst` fences do not give the same guarantee as two genuinely `seq_cst` stores in every litmus test, though it does fix Store Buffer specifically:

```cpp
// T1: x.store(1, relaxed); atomic_thread_fence(seq_cst); r1 = y.load(relaxed);
// T2: y.store(1, relaxed); atomic_thread_fence(seq_cst); r2 = x.load(relaxed);
// r1 == 0 && r2 == 0 is now impossible.
```
This is a language-level SC-fence pattern; do not justify it solely by naming one target instruction.

---

## 25.16 Deep dive: Compiler Barriers vs CPU Fences — Deep dive

There are two translation layers:

1. The optimizer must preserve every execution the C++ abstract machine requires, but may reorder or eliminate work that is not observably constrained.
2. The generated instructions execute under the target ISA's ordering rules.

A C++ atomic operation constrains the compiler and, where needed, causes it to emit ordered instructions or fences. A compiler-only barrier does not create a C++ synchronizes-with edge and does not necessarily constrain the processor. Conversely, a hardware instruction written in inline assembly is not automatically understood by the C++ optimizer.

`std::atomic_signal_fence` is the standard compiler-ordering facility for communication with a signal handler in the same thread. GCC/Clang `"memory"` clobbers and benchmark-specific barriers serve implementation-defined purposes, but they are not replacements for C++ inter-thread atomics. Timestamp ordering and MMIO also require their platform-specific contracts.

---

## 25.17 Deep dive: Representative ISA Mappings and Costs — Deep dive

The table shows common compiler strategies, not promises. Exact code depends on compiler, version, flags, object width and alignment, architecture revision, and surrounding operations.

| C++ operation | Common x86-64 shape | Common AArch64 shape | Possible POWER shape |
|---|---|---|---|
| Relaxed load/store | ordinary load/store | `ldr`/`str` | ordinary load/store |
| Acquire load | often ordinary load | often `ldar` | load plus ordering sequence |
| Release store | often ordinary store | often `stlr` | ordering sequence plus store |
| RMW | locked instruction | LSE instruction or exclusive loop | atomic instruction sequence |
| SC fence | often `mfence` or equivalent locked operation | often `dmb ish` | often `sync` |

Three cost rules survive across machines:

- An uncontended atomic load is usually much cheaper than an RMW.
- An RMW needs exclusive ownership of the cache line; contention and socket placement can dominate the instruction's nominal latency.
- Stronger source ordering may or may not add instructions. Measure the emitted code and the full workload on the deployed target.

No fixed cycle count is portable. Neither is a categorical “ARM does X” claim: AArch64 has multiple architecture revisions and mappings, while POWER and RISC-V have their own model details. Use the C++ proof for correctness and the relevant ABI/compiler documentation plus disassembly for performance.

---

## 25.18 Deep dive: Wide Atomics — Deep dive

Wide atomics expose the gap between ISA capability and library guarantees. A target may have a double-width compare-exchange instruction yet still implement `std::atomic<T>` through a library routine, depending on alignment, build flags, ABI policy, or the operation requested. Conversely, a library can implement an operation with a lock or an exclusive retry sequence even when the source type looks naturally aligned.

For any width that matters to a nonblocking design:

```cpp
template<class T>
constexpr void require_target_lock_freedom() {
    static_assert(std::atomic<T>::is_always_lock_free,
                  "this build requires lock-free atomic<T>");
}
```

Use such an assertion only when it is genuinely a deployment requirement. Otherwise query `is_lock_free()` and provide a valid fallback. Never infer a universal result from “16 bytes,” “x86-64,” or “AArch64” alone.

---

## 25.19 Atomic Shared Pointers — Role-specific

The control block of a `shared_ptr` supports concurrent operations on **distinct** pointer objects that share ownership. Concurrently reading and assigning the **same** `shared_ptr` object is still a data race.

C++20 provides `std::atomic<std::shared_ptr<T>>` and `std::atomic<std::weak_ptr<T>>`:

```cpp
#include <atomic>
#include <memory>

struct Config { int limit; };
#if defined(__cpp_lib_atomic_shared_ptr)
std::atomic<std::shared_ptr<Config const>> config;

void publish(std::shared_ptr<Config const> p) {
    config.store(std::move(p), std::memory_order_release);
}

int read_limit() {
    auto p = config.load(std::memory_order_acquire);
    return p ? p->limit : 0;
}
#endif
```

The feature-test guard accommodates standard libraries that have not shipped the specialization. Where available, the atomic operation includes the ownership update required for the returned pointer. Destruction and any associated deallocation are sequenced after the atomic update rather than necessarily occurring inside its indivisible step. `is_lock_free()` must be queried; the specialization is not guaranteed lock-free.

This solves safe publication and lifetime together, but it does not make concurrent mutation of the pointed-to `Config` safe. For read-mostly paths, measure the ownership traffic. Epoch and hazard-pointer designs are Chapter 26 applications, not alternate memory-model rules.

---

## 25.20 Alignment, Tearing, and `volatile` — Role-specific

### Tearing and alignment

**Tearing** is machine-level shorthand for observing pieces of different writes—for example, two halves of a wider value. In portable C++, conflicting plain accesses without happens-before already form a data race and are undefined; tearing is not one well-defined outcome to enumerate.

- A compiler may split a plain access for its own reasons (for example, when copying a structure). “Aligned word-sized accesses are atomic on x86” is insufficient C++ reasoning: it neither removes a language data race nor requires the compiler to emit one instruction.
- `std::atomic<T>` operations do not tear. When lock-free instructions are unavailable, an implementation can use locks or another conforming mechanism; the standard does not mandate a “lock table” (§25.4).
- Alignment is part of the implementation contract for hardware atomicity. `std::atomic<T>` supplies its required alignment; `atomic_ref<T>` instead requires the referenced object to satisfy `required_alignment`.
- A locked operation split across a cache-line boundary can be exceptionally expensive or trapped on some x86 systems (Ch. 29 §29.10). Other targets may fault or use slower sequences for unsupported alignments. The exact response is platform-specific.
- An `atomic_ref` cannot bind to a bit-field. A packed ordinary member can fail `required_alignment`; constructing an `atomic_ref` to such a member then violates its precondition.

```cpp
struct alignas(std::atomic_ref<std::uint64_t>::required_alignment) Counter {
    std::uint64_t value;
};
```
Express the required property rather than asserting a remembered numeric alignment.

### `volatile` is not synchronization

Accesses through volatile glvalues are observable side effects under the standard's volatile rules, but `volatile` is not inter-thread synchronization. Implementations commonly use it as part of an MMIO interface; the platform ABI defines the device semantics. `volatile sig_atomic_t` is the standard facility for limited communication with a signal handler.

| Property | `volatile` | `std::atomic` |
|---|---|---|
| Access has special observable/atomic semantics | Volatile-access rules | Atomic-operation rules |
| Creates inter-thread ordering | No | Yes, when the selected order and observed value establish it |
| May require CPU ordering instructions | Not for C++ thread synchronization | Yes, where the implementation needs them |
| Guarantees indivisibility (no tearing) | No | Yes |
| Makes an RMW (`v++`) atomic | No — load, add, store as separate steps | Yes |
| Removes the data race (UB) | No | Yes |

`volatile int x; x++;` is not an atomic RMW and races with conflicting inter-thread accesses. Compiler extensions can assign stronger semantics to `volatile`; code relying on them is not portable C++.

**`volatile atomic<T>` is not a portable device protocol.** C++ atomic ordering governs participating C++ threads, not DMA engines, cache coherency domains, or bus transactions. MMIO and DMA require the platform's prescribed accessors, cache maintenance, and device barriers. A platform may use volatile and atomic-looking types as ingredients, but the C++ qualifiers alone do not establish correctness.

Use `std::atomic<T>` rather than `volatile` for an inter-thread polling flag. Relaxed is sufficient when the flag carries no other data; publication needs acquire/release (§25.5–25.6).

---

## 25.21 Traps and Chapter Boundary — Role-specific

- Atomicity of a pointer does not publish the pointee without an ordering edge.
- Ownership synchronization in `shared_ptr` does not synchronize arbitrary pointee mutation.
- Lock-free does not mean wait-free, contention-free, or low latency.
- A passing x86 stress test does not prove a language-level ordering claim.
- TSan detects data races in observed executions; it does not prove that a relaxed-atomic algorithm has the intended outcomes.
- `volatile`, inline assembly barriers, and device barriers each have contracts different from C++ thread synchronization.

Chapter 26 applies these rules to queues, sequence locks, hazard pointers, epochs, and ABA mitigation. Those data-structure algorithms are intentionally not duplicated here.

---

## 25.22 Recall and Practice — Core

**Recall card**
- A data race is undefined behavior, not a stale read; the compiler may hoist a non-atomic spin loop into an infinite loop. `std::atomic` with any order, including `relaxed`, removes the UB.
- Relaxed gives atomicity and per-object modification-order coherence only — no cross-object ordering, and no license for the compiler to stop re-reading an atomic load either.
- Release/acquire creates a synchronizes-with edge only when the acquire actually reads the value the release wrote (or a value in its release sequence); happens-before is sequenced-before plus the transitive closure of that edge.
- Every atomic object has one modification order agreed by all threads; a thread's own reads cannot go backward in it, but a later write can legitimately store a smaller value.
- `compare_exchange_weak` may fail spuriously; `strong` filters spurious failure. Since C++20 the comparison is based on value representation, while types with multiple representations can still require care.
- `seq_cst` adds one global total order over `seq_cst` operations. With every operation SC, that order excludes the canonical SB both-zero and IRIW-disagreement outcomes that release/acquire alone still permits.
- A fence establishes nothing by itself; the surrounding atomic read-from relation is part of the proof.
- Alignment, lock freedom, signal handling, and process-shared memory are target contracts, not facts inferred from a C++ type name.

**Questions** (write your own answer before checking the body above)
1. What exactly is undefined about `while (!done) {}` on a non-atomic `bool done`, and what is the minimal fix?
2. State precisely what `memory_order_relaxed` guarantees and what it does not. Does an empty relaxed spin loop risk being collapsed into a single load the way a non-atomic one does?
3. Draw the happens-before chain for a correct pointer-publication pattern (construct → release-store → acquire-load → dereference), naming each edge.
4. A reference count's decrement uses `acq_rel`; the increment uses `relaxed`. Justify each choice, and state one thing this ordering does *not* guarantee about the managed object.
5. Why does `compare_exchange_weak` exist at all, given that `compare_exchange_strong` exists too? Under what circumstance is the distinction purely portability, with no performance difference?
6. What is a release sequence, and what changed about it in C++20? Give a concrete pattern that stopped synchronizing as a result.
7. What extra relation does `seq_cst` add, and which SB and IRIW outcomes does that relation exclude?
8. Why must an ISA-level claim about IRIW name the architecture revision, memory type, and compiler mapping?
9. Why is `volatile atomic<T>` not sufficient, by itself, for a memory-mapped device register touched by a DMA engine?
10. When would you reach for a standalone `atomic_thread_fence` instead of tagging the individual load/store with an order?

**Code-reading puzzle**

```cpp
std::atomic<int> ready{0};
int payload = 0;

void producer() {
    payload = 7;
    ready.fetch_add(1, std::memory_order_release);
}

void consumer() {
    while (ready.load(std::memory_order_relaxed) == 0) {}
    use(payload);
}
```
Does `consumer` reliably see `payload == 7`? Identify the exact operation that is missing an ordering tag, name the litmus-test shape this reduces to, and give the one-line fix.

**Implementation exercise**

Implement the three publication versions from §§25.3, 25.5, and 25.6 as small two-thread programs. Keep the racy version compile-only; run the relaxed all-atomic and release/acquire versions repeatedly. Draw each permitted edge before running them, then use ThreadSanitizer on a deliberately racy variant. Finally, change the published object to an immutable two-field struct and explain why acquire/release publishes both fields as one initialized snapshot but does not solve reclamation when configurations are replaced.

**Prerequisites for Chapter 26 (Lock-Free Programming)**

You should be able to draw a happens-before edge on sight, know why `relaxed` alone never publishes a pointer's pointee, and be comfortable with release sequences and the four litmus tests before Chapter 26's SPSC/MPMC queues and reclamation schemes—that chapter applies this one's vocabulary to build and reason about structures, and does not re-derive it.
