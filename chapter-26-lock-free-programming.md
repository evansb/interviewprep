# Chapter 26 — Lock-Free Programming

## Why this matters

Lock-free code is not ordinary code with atomics substituted for a mutex. Its contract has three independent parts:

1. **Safety:** operations preserve the abstract data structure and never access an object outside its lifetime.
2. **Visibility:** the memory orders establish the required happens-before edges.
3. **Progress:** suspending a participant has the claimed effect—or non-effect—on everyone else.

A queue can be race-free yet lose elements, linearizable yet blocking, or lock-free until its reclamation scheme is included. Performance is a fourth question. A compare-exchange loop may avoid scheduler blocking and still perform poorly when several cores repeatedly transfer the same cache line.

This chapter applies Chapter 25’s atomic and happens-before vocabulary. It does not reteach the memory-order taxonomy. The focus is how to review a concurrent structure: state its invariant, find each linearization point, classify each operation under thread suspension, and account for every object’s lifetime.

---

## 90-second screen — Core

- **Progress is not speed.** Obstruction-free, lock-free, and wait-free describe what completes under interference and suspension. They do not predict latency or throughput.
- **Linearizability is the safety target.** Each completed operation must appear to take effect once, between invocation and response, while respecting real-time order.
- **SPSC is special.** One producer owns the write index, one consumer owns the read index, and release/acquire transfers slot ownership. No CAS is required.
- **A successful CAS proves only that the compared value still matches.** It does not prove that a recycled pointer still denotes the same logical node, nor that dereferencing it is safe.
- **Unlinking is not reclaiming.** A node may leave a structure while another thread still holds a transient pointer. Hazard pointers, epochs, RCU, or a protocol that prevents reuse must close that lifetime gap.
- **Contention has a mechanism.** Failed CAS attempts, cache-line ownership transfers, false sharing, fences, and allocation are separate costs. Measure them separately.

Be ready to defend two decisions:

1. Why does the workload need non-blocking progress instead of a mutex or a partitioned set of SPSC queues?
2. What are the operation’s linearization point, progress class, publication edge, and reclamation rule?

---

## 26.1 Progress guarantees and the suspension test — Core

Progress belongs to an operation in an algorithm under stated assumptions. “The queue is lock-free” is incomplete unless enqueue, dequeue, allocation, reclamation, and any fallback path have all been considered.

| Class | Required progress | What one suspended thread may do |
|---|---|---|
| Blocking | No non-blocking guarantee | Prevent other operations from completing |
| Obstruction-free | An operation completes if it runs alone long enough | Interference may cause indefinite retries |
| Lock-free | In an infinite execution, operations complete system-wide; some participant makes progress | An individual operation may starve |
| Wait-free | Every operation finishes in a bounded number of its own steps | Cannot make another participant exceed its bound |

The non-blocking hierarchy is:

```text
wait-free  =>  lock-free  =>  obstruction-free

blocking is outside this hierarchy
```

Use an adversarial suspension test:

```text
1. Pause thread P after any shared-state change.
2. Let all other runnable threads continue.
3. Can some operation still complete?
4. Can every operation complete within its own fixed bound?
```

A mutex fails at step 3 when its owner is paused. A conventional CAS retry loop can be lock-free: a non-spurious failure implies another value was observed, so system-wide work can advance, although one thread may lose forever. Weak CAS can also fail spuriously, so the implementation’s atomic-progress guarantees remain part of the classification. A ticketed array queue can fail even the lock-free test if a producer reserves the next cell and is suspended before publishing it; later participants eventually reach that hole and cannot pass.

### Language guarantee versus implementation property

C++ exposes `is_lock_free()` and `is_always_lock_free`; it has no `is_wait_free()` query. A source-level call to `exchange` or `fetch_add` is one expression, but an implementation may use a load-linked/store-conditional retry loop. Do not infer wait-freedom from the absence of an explicit loop in C++.

Likewise, “uses `std::atomic`” is not enough. Check that the particular atomic representation is lock-free on the deployed build. Then include everything called by the operation:

- an allocator may synchronize or enter a slow path;
- reference-count destruction may invoke arbitrary user code;
- logging, system calls, page faults, and lazy initialization are outside the atomic algorithm;
- a reclamation scan can change both progress and latency bounds.

Preallocation can remove allocation from an operation, but it does not automatically make reuse safe. A pool slot must not be overwritten while another thread may still dereference its previous occupant.

### Blocking can be the correct choice

Non-blocking progress solves a specific failure mode: a delayed participant must not indefinitely hold exclusive ownership needed by others. If critical sections are short, contention is low, and threads may sleep, a mutex can be simpler, fairer, and easier to compose. A lock-free loop that spins under oversubscription spends CPU time and creates coherence traffic.

Choose with evidence:

| Workload fact | Candidate design |
|---|---|
| Exactly one producer and one consumer | Bounded SPSC ring |
| Many independent producers, one consumer | Per-producer SPSC rings, then merge |
| Rare access, blocking permitted | Mutex-protected bounded queue |
| Participant suspension must not stop system-wide progress | Reviewed lock-free algorithm including SMR |
| Every caller needs a step bound | Wait-free design with documented bounds |
| Capacity is genuinely unbounded | Revisit admission control; otherwise allocation and reclamation enter the contract |

The word “lock-free” is a conclusion after this audit, not a design objective by itself.

---

## 26.2 Linearizability, invariants, and composability — Core

**Linearizability** means every completed operation can be placed at one instant between its invocation and response so that the resulting sequential history obeys the object’s specification. The chosen instant is the **linearization point**.

Consider two calls:

```text
time ------------------------------------------------------------>

P:  invoke push(7) ---- initialize slot ---- publish tail ---- return
                                            ^
                                            push linearizes

C:                     invoke pop ---- observe tail ---- read 7 ---- retire slot
                                             ^
                                  successful pop can now observe push
```

If one call returns before another is invoked, their linearized order must match that real-time order. Overlapping calls may be ordered either way if the sequential specification permits it.

For a bounded `try_push`, outcomes usually have different points:

- success linearizes when the new element becomes part of the abstract queue;
- failure linearizes at an observation that establishes “full” for some instant during the call.

Similarly, successful `try_pop` removes exactly one element; an empty result needs an observation at which no element was available. A method that reads two independent counters may produce a useful estimate but not a linearizable `size()`. Label approximate observations as approximate instead of silently expanding the object’s contract.

### A proof template

Review every operation in this order:

1. **Sequential specification:** What result would a single-threaded stack, queue, or snapshot produce?
2. **Representation invariant:** Which states encode empty, full, owned, published, retired, and reusable?
3. **Ownership:** Which thread may write each field or slot in each state?
4. **Linearization point:** Which atomic event changes the abstract state?
5. **Visibility:** Which release/acquire or stronger edge makes preceding initialization visible?
6. **Lifetime:** Why can every dereference occur before reuse or destruction?
7. **Progress:** What happens if a thread stops before and after each shared-state event?

The order matters. A fence cannot repair a broken ownership invariant, and a tag cannot repair an unsafe dereference.

### Linearization diagram for a stack push

A Treiber-style push prepares a private node and publishes it with CAS:

```text
Thread A                                Thread B
--------                                --------
n->next = observed_head
CAS(head, observed_head, n) succeeds
        |  linearization
        |  release
        +------------------------------> acquire load(head) reads n
                                         read n->value

private initialization
    sequenced-before release CAS
    happens-before B's reads after the acquire
```

The failed CAS path must update the observed head and rebuild `n->next` before retrying. The successful CAS can publish initialization, but it says nothing about when a popped node may be deleted. Publication and reclamation are different proofs.

### Why linearizable objects compose—and operations may not

Linearizability is local: if each object is linearizable, their histories can be combined while respecting real time. That does not make a multi-object transaction atomic.

```cpp
if (!queue.empty()) {       // state can change after this call
    return queue.pop();     // a second operation, not one transaction
}
```

A concurrent queue should usually offer `try_pop()` as one operation. Composing `empty()` and `pop()` creates a check-then-act race even if each method is individually linearizable. The same problem appears when moving an item between two lock-free queues: the remove and insert linearize separately unless a higher-level protocol supplies atomicity or compensation.

Good interfaces expose the atomic decision the caller needs. Avoid references into mutable structures, split check/use methods, and exact `size()` promises that the representation cannot support cheaply.

---

## 26.3 Compare-exchange retry loops and contention — Core

Chapter 25 established the mechanics of `compare_exchange_weak`: on failure it writes the observed value back into `expected`, and weak CAS may also fail spuriously. Here the important question is what the loop means for correctness and cost.

```cpp
#include <atomic>
#include <cassert>

bool raise_to(std::atomic<unsigned>& value, unsigned desired) {
    auto current = value.load(std::memory_order_relaxed);
    while (current < desired) {
        if (value.compare_exchange_weak(
                current, desired,
                std::memory_order_relaxed,
                std::memory_order_relaxed)) {
            return true;
        }
        // Failure refreshed current; re-check the predicate.
    }
    return false;
}

int main() {
    std::atomic<unsigned> high{4};
    assert(raise_to(high, 9));
    assert(!raise_to(high, 7));
    assert(high.load() == 9);
}
```

The successful call linearizes at the successful CAS. The false result linearizes at the load or failed CAS observation that established `current >= desired`. Relaxed ordering is sufficient because this object carries only a number; it does not publish other memory.

If the atomic operations provide lock-free progress and weak CAS does not fail indefinitely without interference, the loop is lock-free: repeated contention means other updates are succeeding. It is not wait-free because one caller can lose indefinitely. If the atomic is implemented with a lock, the surrounding algorithm cannot claim lock-freedom.

### The physical cost of a retry

Several mechanisms can dominate:

- a successful read-modify-write requests exclusive ownership of the cache line;
- competing writers transfer that ownership among cores;
- failed iterations redo loads, comparisons, and dependent work;
- exponential backoff reduces request rate but increases an individual operation’s delay;
- fairness is not implied, so one core can repeatedly win.

Do not quote a universal retry cost. Record attempts per success, throughput, latency percentiles, CPU utilization, and cache-coherence events on the target machine. Vary thread count, affinity, socket placement, and the work between updates.

Reduce contention before tuning the instruction:

1. assign one writer per shard;
2. batch several logical updates behind one shared publication;
3. replace a shared MPSC/MPMC queue with per-producer SPSC queues;
4. add backoff only after measuring the remaining collision pattern.

A CAS loop with substantial work between load and CAS increases the invalidation window. Compute immutable or thread-local work before the loop when possible, but recompute anything derived from `expected` after failure.

---

## 26.4 A bounded SPSC ring with a complete proof — Core

Single-producer/single-consumer permits a strong ownership partition:

```text
producer alone writes tail and slots not yet published
consumer alone writes head and reads published slots

producer-owned line: [ tail | cached head ]
consumer-owned line: [ head | cached tail ]
buffer lines:        [ slot 0 | slot 1 | ... ]
```

The cached remote indices remain on the local writer’s line. Putting `cached_head` next to the consumer-written `head` would make every producer cache update invalidate the consumer’s line—the layout would manufacture false sharing.

The following C++23 example uses wrapped indices and reserves one slot to distinguish full from empty. `Capacity` is a power of two only so wrapping can use a mask; modulo or a conditional reset would also be correct.

```cpp
#include <array>
#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <thread>
#include <type_traits>

template<class T, std::size_t Capacity>
requires (std::is_trivially_copyable_v<T> &&
          std::is_trivially_default_constructible_v<T>)
class SpscRing {
    static_assert(Capacity >= 2);
    static_assert((Capacity & (Capacity - 1)) == 0);
    static_assert(std::atomic<std::size_t>::is_always_lock_free);
    static constexpr std::size_t mask = Capacity - 1;
    static constexpr std::size_t cache_line = 64; // target build setting

    struct alignas(cache_line) ProducerState {
        std::atomic<std::size_t> tail{0};
        std::size_t cached_head{0};
    } producer_;

    struct alignas(cache_line) ConsumerState {
        std::atomic<std::size_t> head{0};
        std::size_t cached_tail{0};
    } consumer_;

    alignas(cache_line) std::array<T, Capacity> slots_{};

public:
    bool try_push(T value) noexcept {
        const auto tail = producer_.tail.load(std::memory_order_relaxed);
        const auto next = (tail + 1) & mask;
        if (next == producer_.cached_head) {
            producer_.cached_head =
                consumer_.head.load(std::memory_order_acquire);
            if (next == producer_.cached_head) return false;
        }
        slots_[tail] = value;
        producer_.tail.store(next, std::memory_order_release);
        return true;
    }

    std::optional<T> try_pop() noexcept {
        const auto head = consumer_.head.load(std::memory_order_relaxed);
        if (head == consumer_.cached_tail) {
            consumer_.cached_tail =
                producer_.tail.load(std::memory_order_acquire);
            if (head == consumer_.cached_tail) return std::nullopt;
        }
        T value = slots_[head];
        consumer_.head.store((head + 1) & mask,
                             std::memory_order_release);
        return value;
    }
};

int main() {
    SpscRing<std::uint64_t, 1024> queue;
    constexpr std::uint64_t count = 100'000;
    std::atomic<bool> ordered{true};

    std::thread producer([&] {
        for (std::uint64_t x = 0; x < count; ++x)
            while (!queue.try_push(x)) std::this_thread::yield();
    });
    std::thread consumer([&] {
        for (std::uint64_t expected = 0; expected < count;) {
            if (auto value = queue.try_pop()) {
                if (*value != expected) ordered.store(false);
                ++expected;
            } else {
                std::this_thread::yield();
            }
        }
    });

    producer.join();
    consumer.join();
    assert(ordered.load());
}
```

`cache_line = 64` is a deployment choice for the tested target, not a C++ guarantee. A project can supply a configured destructive-interference size. Changing it changes layout and possibly ABI. Verify the actual layout and coherence behavior on each supported machine.

The test harness spins only to drive the test. Each queue API call itself is a bounded `try_` operation and never waits for capacity or data.

### Representation invariant

Let `head` identify the next readable slot and `tail` the next writable slot:

```text
empty: tail == head
full:  next(tail) == head
usable capacity: Capacity - 1
published interval: circular range [head, tail)
```

Only the producer mutates `tail`, its cached head, and an unowned slot. Only the consumer mutates `head`, its cached tail, and consumes an owned slot. A stale cache can cause a conservative false full/empty result until refreshed; the code refreshes before returning failure, so each failure has a current observation.

### Publication and reuse happen-before diagram

```text
Producer                              Consumer
--------                              --------
slots[tail] = value
tail.store(next, release)  ---------> tail.load(acquire) sees next
                                       read slots[head]

Producer                              Consumer
--------                              --------
head.load(acquire) sees next <------- head.store(next, release)
write the recycled slot                 prior slot read is complete
```

The first edge publishes the payload. The second edge prevents the producer from overwriting a slot before the consumer’s read completes. The producer’s own load of `tail` and the consumer’s own load of `head` are relaxed because each has a single writer and needs no cross-thread visibility from that load.

Cached remote positions do not weaken the proof. A cached tail value was acquired from a release publication and proves all preceding slots up to that position are readable. A cached head value was acquired from a release retirement and proves those slots are reusable.

### Linearization and progress

| Operation | Result | Linearization point |
|---|---|---|
| `try_push` | success | release store to `tail` |
| `try_push` | full | refreshed acquire load of `head` |
| `try_pop` | value | release store to `head` after copying |
| `try_pop` | empty | refreshed acquire load of `tail` |

There are no algorithmic retry loops inside the methods. They are wait-free only on an implementation where the atomic loads/stores used here have the necessary bounded-progress property; C++ exposes lock-freedom, not a wait-freedom guarantee. The `static_assert` prevents a build where the index atomic is known not to be always lock-free, but it still does not create a language-level wait-free promise.

The template restricts `T` so slot access is a non-throwing, fixed-lifetime copy in the intended uses. A general queue for nontrivial objects must manage construction, destruction, failed moves, and shutdown. Those concerns can invalidate both the progress bound and the lifetime proof.

---

## 26.5 Worked queue choice and failure diagnosis — Core

Suppose a market-data decoder feeds three independent strategies. Each strategy must see every accepted update in order. The decoder is pinned; strategies can occasionally be preempted.

### Step 1: define the semantics

This is broadcast, not work distribution. A single MPMC queue would let only one strategy consume each update. The topology is one SPSC queue per strategy, or one multi-reader broadcast ring with a cursor per consumer.

### Step 2: choose the suspension behavior

If one slow strategy must not stop delivery to the other two, a broadcast ring whose producer waits for the slowest cursor violates the requirement. Independent SPSC rings isolate the backlogs. They also make the full policy explicit per strategy.

### Step 3: make capacity policy part of correctness

For each ring:

- **reject and disconnect/disable the lagging strategy** preserves the other consumers and makes data loss explicit;
- **drop updates** is valid only if the domain protocol can reconstruct state from a later snapshot;
- **overwrite oldest** is invalid when every delta matters;
- **block producer** couples all strategies through the decoder and violates isolation.

Capacity should cover a measured burst and detection/recovery interval, not serve as an unbounded latency reservoir. Queue occupancy is queued work. Under stable throughput, Little’s law connects average depth, arrival rate, and waiting time; it does not predict burst tails by itself.

### Step 4: diagnose an observed regression

Assume throughput falls when the second core is enabled, while correctness tests still pass:

```text
Observation                          Candidate mechanism
-----------                          -------------------
head and tail share an address line  false sharing
many CAS failures                    true contention
low CAS failures, remote reads high  polling/cached-index layout
periodic long stalls                 preemption, faults, reclamation scan
growing occupancy                    downstream service deficit
```

First inspect field offsets and cache-to-cache/coherence events. If `head` and `tail` share a line, separate the writer-owned states. If the line is truly shared because all producers CAS the same counter, padding cannot help; shard the producer path. If occupancy grows, optimizing the queue may hide rather than fix a slower consumer.

### Step 5: state the resulting contract

For each SPSC ring:

- one fixed producer and one fixed consumer for its lifetime;
- `try_push` and `try_pop` never block;
- capacity is fixed and one slot is reserved;
- failure is reported to the caller;
- shutdown begins only after producers stop and remaining elements are drained or deliberately discarded;
- no object outlives the ring, and no thread accesses it after destruction.

This contract is more important than the class name. Changing producer identity or letting two consumers “occasionally” call `try_pop` destroys the ownership proof even if a stress test appears to pass.

---

## 26.6 Cache lines, false sharing, and fences — Core

**False sharing** occurs when cores write different objects that occupy the same coherence unit. The language sees independent atomics; the cache-coherence protocol sees one line repeatedly changing ownership.

```text
bad:
line X [ producer tail | consumer head ]
          Core P writes   Core C writes

better:
line P [ producer tail | producer cached head | padding ]
line C [ consumer head | consumer cached tail | padding ]
```

Padding fixes false sharing, not true sharing. Multiple producers updating the same reservation counter genuinely contend on one object. That requires sharding, batching, or another topology.

`std::hardware_destructive_interference_size` may help express an implementation’s compile-time estimate when available, but it is not a runtime discovery mechanism and can affect ABI. A hard-coded value is also a target assumption. In either case, validate:

- actual field offsets and object stride;
- throughput and latency as participating cores increase;
- cache-to-cache or modified-line transfer events;
- same-socket versus cross-socket placement;
- working-set growth caused by padding.

Padding every cell can reduce destructive sharing and simultaneously enlarge the ring enough to cause more cache or TLB misses. The trade is workload-dependent.

Fences have a different cost. They constrain ordering and may drain or serialize parts of the memory pipeline depending on the target. Use the weakest ordering justified by the proof, but do not “weaken until the benchmark improves.” First write the happens-before edge, then test the exact build and hardware. Chapter 25 owns ISA mappings and fence synchronization rules.

---

## 26.7 Producer-consumer topologies — Role-specific

The letters describe ownership, not an implementation:

| Topology | Shared writers/readers | Typical design pressure | Often simpler alternative |
|---|---|---|---|
| SPSC | one of each | publication and wrap | Direct bounded ring |
| MPSC | many producers, one consumer | reservation contention; producer holes | SPSC per producer plus merge |
| SPMC | one producer, many consumers | distribution versus broadcast semantics | SPSC per consumer |
| MPMC | many of each | reservation, ordering, reclamation, fairness | Shard by key or worker |

Clarify whether multiple consumers distribute items or each consumer sees every item. “Queue” usually means distribution; broadcast needs independent consumer positions and a rule for slow readers.

### Intrusive MPSC link window

A common intrusive MPSC shape lets a producer atomically exchange a head pointer and then link itself from the previous node:

```text
P1: previous = head.exchange(my_node)
    ---- may be suspended here ----
P1: previous->next.store(my_node, release)

C:  follows previous->next
```

This is pseudocode, not a complete C++ queue. It needs a stub node, exact empty semantics, node ownership, and a lifetime protocol.

The gap matters. If P1 is suspended after the exchange, the consumer can reach `previous` but cannot follow the missing link. The enqueue code path may use a fixed number of atomic operations, yet the queue as a whole does not acquire a lock-free progress guarantee. “No mutex” and “lock-free” are not synonyms.

Per-producer SPSC queues remove producer contention and the link window. They add a merge policy, more cursors, and possibly O(number of producers) polling work. If global FIFO order across producers is required, define the ordering key and tie-break rule; arrival at independent rings does not provide one global real-time order for free.

---

## 26.8 Bounded MPMC rings and per-cell sequences — Role-specific

A practical bounded MPMC ring commonly uses:

- a producer reservation counter;
- a consumer reservation counter;
- one sequence value per cell;
- inline payload storage.

For capacity `N`, ticket `p` maps to `p % N`. A conceptual cell protocol is:

```text
sequence == p       : cell is free for producer ticket p
producer owns cell  : payload is being initialized
sequence == p + 1   : payload is published for consumer ticket p
consumer owns cell  : payload is being copied out
sequence == p + N   : cell is free for its next lap
```

The sequence encodes both state and lap. A Boolean `ready` cannot distinguish a delayed observation from the same state on a later lap.

### Ownership and happens-before

```text
producer reserves ticket p
producer writes cell.data
producer cell.sequence.store(p + 1, release)
                     |
                     +---- consumer acquire load observes p + 1
                           consumer reads cell.data
                           consumer cell.sequence.store(p + N, release)
                                                   |
                          next producer acquire load observes free
```

The global counters assign candidates; the per-cell sequence transfers ownership. A complete algorithm must also define how a caller distinguishes full/empty from “another thread is between reservation and publication.”

### Honest progress classification

Consider a producer suspended after reserving ticket `p` but before publishing the cell. Other operations may complete temporarily, but FIFO consumers eventually reach `p` and cannot pass the hole. Once finite remaining capacity is exhausted, the entire queue can stop. Therefore this reservation protocol is not lock-free under the suspension test. The widely used bounded MPMC algorithm associated with this shape is explicitly not lock-free in the formal sense.

That does not make it useless. It remains bounded, allocation-free during operation, cache-conscious, and effective when participants are controlled and long suspension inside the reservation window is excluded operationally. State that scheduling assumption instead of upgrading the progress guarantee.

### Linearization points need the complete variant

Reservation and publication are distinct. In a typical successful enqueue, the release store that publishes the cell is the first event at which a consumer can obtain the value. The reservation CAS establishes ticket order but does not publish initialized payload. A successful dequeue reserves the corresponding published ticket before copying it; releasing the cell later permits reuse.

Failed `try_` operations are subtler: a sequence mismatch can mean genuinely full/empty or an in-flight owner. The exact algorithm’s additional counter observations determine whether failure is permitted and where it linearizes. Do not assign linearization points to a four-line protocol sketch; review the complete source and its documented semantics.

### Wraparound is a proof obligation

Unsigned counters wrap modulo `2^w`, which is defined. Correctness does not follow merely from choosing `std::uint64_t`. The proof must bound the number of simultaneously distinguishable tickets and exclude a participant retaining an observation long enough for the same encoded sequence to recur.

A safe design documents an assumption such as:

```text
live ticket distance is always less than half the counter range
and no outstanding operation survives enough complete laps to alias its tag
```

Use modular comparisons whose preconditions are explicit. Avoid converting a wrapped subtraction to a signed type unless the code and standard-version analysis establish the intended result. Tests should seed counters near their maximum and cross wrap; waiting for natural wrap is not a test plan.

Power-of-two capacity permits masking, but it is not required for correctness. `% N` is well-defined for any positive `N`, and a compile-time constant divisor may be optimized by the compiler. Choose capacity from workload and representation constraints, then inspect generated code if index arithmetic matters.

---

## 26.9 Queue backpressure and bounded failure — Role-specific

A bounded queue must specify what full means to the system:

| Policy | Semantic effect | Principal risk |
|---|---|---|
| Return failure | Caller chooses recovery | Callers may ignore it |
| Spin/retry | Preserve item while consuming CPU | Unbounded latency; oversubscription |
| Park/block | Preserve item without busy polling | Scheduler latency; no longer non-blocking |
| Drop newest | Preserve queued history | Lose current event |
| Drop oldest/overwrite | Preserve freshness | Lose history; unsafe for deltas |
| Conflate by key | Keep latest state per key | Extra indexing; not FIFO |
| Grow | Delay overload decision | Allocation, copying, unbounded memory |

The queue method should usually be `try_push`; policy belongs at the boundary with domain knowledge. A logger may drop and count low-priority records. An order gateway generally must reject upstream work or enter a safe state rather than silently drop an order.

Measure high-water marks, time spent non-empty, failed pushes, retry duration, and recovery time. A large ring can convert overload into old data and poor tail latency. Backpressure is effective only if it eventually changes admission or production; otherwise it is buffering followed by failure.

Shutdown is also backpressure. Define who stops producing, whether the queue drains, how the consumer detects completion, and when storage may be destroyed. A relaxed `done` flag that does not publish preceding payload or coordinate object lifetime is not a shutdown protocol.

---

## 26.10 Seqlocks without payload data races — Role-specific

A seqlock publishes a small snapshot from one writer to many readers. The writer makes a sequence odd, updates fields, then makes it even. A reader accepts values only when it observes the same even sequence before and after copying.

The familiar implementation with a plain `Data data;` read concurrently with a plain writer is undefined in standard C++. Discarding a torn snapshot afterward does not erase the data race. Kernel code relies on platform-specific primitives such as read-once operations and compiler barriers; portable C++ must make the conflicting payload accesses atomic or use another scheme.

This conservative C++23 version uses sequentially consistent atomics throughout. It favors a short, auditable proof over minimum fence cost:

```cpp
#include <atomic>
#include <cassert>
#include <cstdint>
#include <optional>

struct Quote {
    std::uint64_t bid;
    std::uint64_t ask;
};

class QuoteSnapshot {
    std::atomic<std::uint64_t> version_{0}; // even means stable
    std::atomic<std::uint64_t> bid_{0};
    std::atomic<std::uint64_t> ask_{0};

public:
    void publish(Quote q) noexcept { // exactly one writer
        const auto v = version_.load();
        assert((v & 1U) == 0);
        version_.store(v + 1);       // odd: update in progress
        bid_.store(q.bid);
        ask_.store(q.ask);
        version_.store(v + 2);       // even: snapshot published
    }

    std::optional<Quote> try_read() const noexcept {
        const auto before = version_.load();
        if (before & 1U) return std::nullopt;
        Quote result{bid_.load(), ask_.load()};
        const auto after = version_.load();
        if (before != after) return std::nullopt;
        return result;
    }
};

int main() {
    QuoteSnapshot snapshot;
    snapshot.publish({101, 103});
    const auto quote = snapshot.try_read();
    assert(quote && quote->bid == 101 && quote->ask == 103);
}
```

All participating operations are in one sequentially consistent order consistent with program order. If a writer’s odd/version or payload operations fall between the reader’s two version loads, the reader cannot accept the old equal even value. Payload accesses are atomic, so even a rejected mixed read is defined.

The code assumes one writer. Multiple writers could both read the same even version and overlap payload stores. External writer serialization or a CAS-based writer protocol is required.

`try_read` is a bounded attempt. A convenience `read()` that loops until success may starve under frequent writes, so it is not wait-free. `publish` has a bounded source path, but its formal progress still depends on the atomic implementations. Version wrap creates an ABA-like acceptance risk if one read spans an entire counter cycle; the deployment must rule that out or use a wider/version-reset protocol.

Sequential consistency can impose more ordering cost than a carefully proven implementation-specific seqlock. An optimized version may use atomic payload words and weaker orders/fences, but each fence must be justified in the C++ model and validated on every target. For larger snapshots, immutable double buffers plus an atomic index, or RCU-style pointer publication, may be easier to prove.

---

## 26.11 ABA and tagged state — Deep dive

ABA occurs when CAS sees the same representation after the logical state changed:

```text
initial stack: A -> B -> C

T1: reads head=A and A->next=B; pauses
T2: pops A, pops B, pushes storage at address A again
T1: CAS(head, A, B) can succeed because the bits equal A
```

The pointer representation returned to `A`; the node lifetime and links did not. Stronger memory ordering does not help because CAS correctly compared the bits it was asked to compare.

Separate two failures:

- **ABA:** a stale CAS succeeds after the compared state cycles back.
- **Unsafe reclamation:** T1 dereferences `A` after its lifetime ended.

A version tag can make T1’s CAS fail, but T1 may already have evaluated `A->next`. Tagging the head therefore does not by itself make dereferencing a removed node safe.

### Tagged choices

| Representation | Benefit | Remaining obligation |
|---|---|---|
| Pointer + counter in a wider atomic | Direct versioning | Verify representation is lock-free and padding/value rules |
| Pointer bits reused as a tag | One machine word on a specific ABI | Alignment, address rules, provenance, tag wrap |
| Slab index + generation in one integer | No raw address encoding; compact | Prevent reuse while readers access the slot |
| Monotonic per-cell sequence | Natural for fixed rings | Prove wrap-distance assumptions |

Low pointer bits are available only to the extent guaranteed by allocation alignment. High-bit tagging is ABI- and architecture-specific and may conflict with address-width growth or memory-tagging features. Integer-pointer round trips and canonical-address reconstruction need a platform contract; they are not portable C++ data-structure techniques.

For a double-width atomic, check `is_always_lock_free` for the exact type and build. Do not assume an instruction exists because the CPU family can support one; compiler flags, ABI, alignment, and library fallback matter. Also avoid padding or multiple object representations in compared aggregate state unless the representation-level CAS behavior has been reviewed.

Generation width is a capacity decision, not magic. A `g`-bit tag aliases after `2^g` reuse events. The proof must bound reuse during the longest stale-observer window or treat wrap as a controlled failure.

---

## 26.12 Memory reclamation: the lifetime proof — Deep dive

Unlinking removes a node from the abstract structure. Reclamation ends its lifetime or permits its storage to be reused. Between those events, another thread may hold a pointer loaded before the unlink.

```text
Reader R                         Remover W
--------                         ---------
p = head.load()
                                 CAS unlinks p
                                 p is retired, not deleted
R announces/proves protection
R validates p is still usable
R dereferences p
R releases protection
                                 grace/scan proves no protection
                                 delete or reuse p
```

If `delete p` occurs immediately after unlink, the first and last columns can form a use-after-free even when every atomic order is `seq_cst`.

### One canonical comparison

| Scheme | Reader announcement | When reuse is allowed | Failure under a stalled reader | Typical fit |
|---|---|---|---|---|
| Never reuse bounded storage | None | Never, or only at whole-structure shutdown | Fixed memory remains occupied | Fixed-lifetime tables/rings |
| Hazard pointers | Per protected pointer | Scan finds no hazard protecting retired node | Stalled reader protects a bounded number of nodes under bounded-registration assumptions | Short pointer traversals, general threads |
| Epoch-based reclamation | Enter/exit read-side epoch | Every reader that could have seen node passed quiescence | One stalled active reader can delay an unbounded retired stream | Short non-blocking critical sections |
| QSBR/RCU family | Explicit quiescent states or read-side protocol | A grace period ends | Missing/stalled quiescence delays callbacks and reuse | Read-mostly data, controlled event loops |
| Reference-counted ownership | Successful protected ownership increment | Last owner releases | Counter traffic; acquiring ownership from a concurrently removed raw pointer is itself hard | Simpler publication APIs, not automatically lock-free |

C++23 has no standard hazard-pointer, epoch, or RCU facility. Use a reviewed library or platform facility with a documented C++ memory-model interface. Future-standard API names are not part of the C++23 toolbox.

### Hazard pointers

A hazard slot announces “this thread may dereference `p`.” The essential protect loop is:

```text
repeat:
    p = source.load()
    my_hazard.store(p)
until p == source.load()       // validate after announcing

use *p
my_hazard.store(nullptr)
```

This is protocol pseudocode, not a drop-in memory-order recipe. A simple implementation can use sequentially consistent hazard publication, validation, and scanning; optimized libraries may use other orderings plus fences. The necessary rule is that a remover cannot both miss the announcement and reclaim the node while a reader validates and proceeds.

The first load alone is unsafe: the node can be removed before the announcement. Publishing alone is also insufficient: if the source changed during the window, the reader must abandon the pointer without dereferencing it. The revalidation closes that window.

A remover:

1. unlinks a node;
2. appends it to a private retired list;
3. periodically scans registered hazard slots;
4. reclaims retired nodes absent from the protected set.

Hazard pointers can bound unreclaimed nodes only with explicit assumptions: the number of registered participants and hazard slots is bounded, retire lists are scanned after a bounded threshold, and collectors themselves continue making progress. A stalled thread may indefinitely protect its few announced nodes, but should not pin every subsequently retired node.

The data structure’s progress and the reclamation implementation’s progress must be combined. A lock-free stack using a blocking global registry is not lock-free as a complete operation.

### Epoch-based reclamation

Epoch schemes announce a read-side critical section rather than each pointer:

```text
reader enters epoch e
reader may traverse nodes visible in e
writer unlinks node and retires it in a later bucket
reader exits / reports quiescence
reclaimer observes that all relevant readers advanced
node becomes reusable
```

The entry protocol must prevent a reader from accessing a node while appearing quiescent to the reclaimer. A sketch that separately scans participant epochs and advances a global epoch without a proven synchronization protocol is unsafe. Use a reviewed implementation.

EBR makes traversal cheap because one announcement covers many pointers. Its central failure mode is memory retention: a preempted, blocked, or forgotten reader pins an old epoch while retirement continues. Data-structure operations may still complete, yet the process can accumulate memory until another resource limit fails. Monitor oldest active epoch, grace-period duration, and retired bytes—not only operation latency.

Do not block, perform unbounded work, or call unknown code inside an epoch guard unless the implementation explicitly tolerates it. Cancellation and thread exit must unregister or report quiescence correctly.

### RCU and QSBR

Read-copy-update publishes a replacement and defers destruction of the old version:

```text
old = pointer.load()
new = copy_and_modify(old)
pointer.store(new, release)
wait/defer until a grace period completes
reclaim old
```

Readers load the published pointer under the library’s read-side protocol. Writers may serialize with a mutex; RCU primarily optimizes readers and is not a claim that updates are lock-free.

QSBR—quiescent-state-based reclamation—works well when each event-loop iteration has an explicit point at which the thread holds no protected references. Read-side overhead can be very small, but a thread that never reports quiescence stalls grace periods. RCU also commonly allows stale-but-valid reads; the domain must accept versioned observation.

### Preallocation is useful, not magical

A fixed ring whose slot state prevents overwrite until the consumer releases it needs no general-purpose node reclamation. A slab that immediately recycles an unlinked slot does. Index-plus-generation makes stale validation fail, but cannot stop a reader that validated and then races with reuse.

Three safe alternatives are:

- never reuse slots until all worker threads stop;
- put reuse behind a hazard/epoch/grace protocol;
- design ownership so the prior reader’s release is observed before the next writer can acquire the slot, as in the SPSC ring.

State which one applies.

---

## 26.13 Testing and review strategy — Reference

Concurrent testing supplies evidence; it does not replace the proof. Use layers:

1. **Sequential model:** compare randomized operations with a simple reference container where histories are serialized.
2. **Boundary tests:** empty, full, one slot, wrap, shutdown, failed operations, and counter values seeded near maximum.
3. **Stress:** vary producer/consumer counts, affinity, yields, injected pauses, and operation mixes.
4. **Sanitizers:** ThreadSanitizer for non-atomic data races; AddressSanitizer for use-after-free; UndefinedBehaviorSanitizer for arithmetic, alignment, and lifetime symptoms it supports.
5. **Schedule exploration/model checking:** enumerate small histories and verify linearizability and invariants. Stress testing samples schedules; it cannot cover them.
6. **Performance counters:** attempts/success, occupancy, cache-line transfers, faults, context switches, and retired-memory backlog.

ThreadSanitizer does not report a bad abstract history made entirely of atomic operations. It also does not prove that a clean run is race-free for every schedule. AddressSanitizer can expose a reclamation bug only if the tested schedule reaches it. An algorithm that passes both can still have a wrong linearization point or progress classification.

Inject suspension at each protocol boundary:

```text
before reservation
after reservation, before initialization
after initialization, before publication
after unlink, before retirement
after retirement, before hazard/epoch scan
```

Then ask which other operations can complete. This single technique catches “mutex-free but blocking” designs and reclamation holes that throughput tests hide.

For any third-party queue, record:

- exact version and build flags;
- supported topology and element requirements;
- full/empty semantics and whether failure may be transient;
- operation-specific progress claims;
- reclamation/allocation behavior;
- counter-wrap and thread-registration assumptions;
- sanitizer and model-check coverage;
- measured behavior on the deployment topology.

---

## Recall card — Core

- Safety, visibility, progress, and performance are separate claims.
- Wait-free implies lock-free; lock-free implies obstruction-free; blocking is outside that hierarchy.
- Linearize each success and failure between invocation and response.
- A CAS loop is commonly lock-free, not wait-free; verify the atomic representation.
- SPSC works through single-writer indices and two release/acquire ownership transfers.
- Cache producer-owned state together and consumer-owned state together; padding cannot fix true sharing.
- A per-cell sequence encodes ownership and lap, but a reserved unpublished hole can make a bounded MPMC protocol blocking.
- ABA means “changed and changed back”; reclamation means “may I still dereference?”
- Tags detect reuse; they do not by themselves delay reuse.
- Hazard pointers protect individual pointers; epochs/RCU delay reuse until relevant readers pass quiescence.

---

## Common traps — Core

- Calling an algorithm lock-free because it contains no mutex.
- Calling a source-level `fetch_add` wait-free without a target-specific progress guarantee.
- Naming a successful reservation as publication when consumers cannot yet observe initialized payload.
- Using two linearizable calls as if their combination were atomic.
- Adding atomic indices around a ring while leaving slot ownership unspecified.
- Placing `head`, `tail`, and both cached copies on one cache line.
- Treating `%` as incorrect or a power-of-two capacity as universally required.
- Assuming unsigned wrap alone proves sequence correctness.
- Converting wrapped counters to signed values without documenting the distance bound and conversion semantics.
- Using a plain seqlock payload in portable C++ and hoping the version retry excuses its data race.
- Deleting a node immediately after a successful unlink CAS.
- Treating index-plus-generation as a complete reclamation scheme.
- Claiming a clean sanitizer run proves linearizability or lock-freedom.
- Omitting full, cancellation, shutdown, or participant-unregistration behavior from the contract.

---

## Reasoning questions

1. A CAS loop retries forever while other threads succeed. Which progress properties hold for the system and for the unlucky call?
2. A producer reserves cell 12 and is suspended before publishing. Trace what an MPMC ring can still complete and explain why finite temporary progress is not lock-freedom.
3. Identify the four SPSC linearization points for successful push/pop and full/empty results.
4. Why does the consumer’s release store to `head` protect a later producer overwrite of the same slot?
5. Two independent atomics share a cache line. What measurement distinguishes false sharing from contention on one atomic?
6. A pointer CAS uses a 32-bit generation tag. What two separate proofs are still required for wrap and dereference lifetime?
7. Why can a plain seqlock payload be undefined even when every rejected snapshot is discarded?
8. Compare hazard pointers and EBR when a registered thread is preempted indefinitely.
9. When would per-producer SPSC queues be a better MPSC design, and what ordering or polling cost do they introduce?
10. Which tests can reveal a data race, an ABA history, an incorrect linearization point, and a stalled reclamation epoch? Why is no single tool sufficient?

---

## Code-reading puzzle

The queue has one producer and one consumer, but its fields were “simplified.” This intentionally incomplete fragment shows only the state under review:

```cpp
struct State {
    std::atomic<std::size_t> tail{0};
    std::size_t cached_head{0};
    std::atomic<std::size_t> head{0};
    std::size_t cached_tail{0};
};
```

The memory orders and slot protocol are otherwise identical to Section 26.4. Is the program incorrect? If not, explain why it can still regress badly on two cores. Redraw the ownership layout, name every writer, and propose a target-configured alignment without claiming one universal cache-line size.

---

## Implementation exercise

Extend the SPSC ring with a free-running unsigned counter for each side so all `Capacity` slots are usable. Document:

1. the invariant that makes `tail - head` meaningful modulo the counter range;
2. the maximum permitted live distance and the counter-wrap assumption;
3. the success and failure linearization points;
4. every release/acquire ownership edge;
5. why a public `size()` formed from two independent loads is exact, approximate, or intentionally omitted.

Test a small capacity against a sequential FIFO model. Add a constructor used only by tests to seed counters near the maximum value, cross wrap, and exercise full/empty transitions. Run the test under ThreadSanitizer where the toolchain supports it and under AddressSanitizer plus UndefinedBehaviorSanitizer. Finally, inject a pause after each shared-state step and record the operation-specific progress result.

---

## Prerequisite for Chapter 27

This chapter assumes Chapter 25’s data-race, release/acquire, modification-order, and CAS rules; revisit that chapter if the happens-before diagrams are not immediate. Chapter 21 owns the single-threaded ring, heap, and slab invariants, while Chapter 24 owns blocking coordination.

Chapter 27 moves from the C++ abstract machine to CPU execution. Carry forward the distinction between a language guarantee and a measured implementation: “lock-free,” “one atomic expression,” and “release store” do not by themselves determine instruction count, cache-line transfers, fence cost, throughput, or tail latency.
