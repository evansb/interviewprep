# Chapter 26 — Lock-Free Programming

*Interview-focused revision notes. The theme: lock-free is a progress guarantee, not a speed guarantee. Everything here is the consequence of two facts — you cannot atomically touch two words, and you cannot free memory another thread might still be reading — and every technique in the chapter is a way of paying for one of them.*

---

## 26.1 Obstruction-Free, Lock-Free, and Wait-Free Progress

These are **progress guarantees**: statements about what is true when threads are suspended arbitrarily, not about throughput.

| Guarantee | Definition | Implication |
|---|---|---|
| **Blocking** | A suspended thread can prevent all others from progressing | A mutex. Preemption while holding the lock stalls everyone. |
| **Obstruction-free** | A thread makes progress if it runs *in isolation* for long enough (all others paused) | Weakest non-blocking class. Permits livelock. Basis of STM and of some seqlock writers. |
| **Lock-free** | *Some* thread makes progress in a bounded number of steps, system-wide | No deadlock, no priority inversion, no convoying. Individual threads may starve. |
| **Wait-free** | *Every* thread completes in a bounded number of its own steps | Strongest. Bounded worst case per thread. Usually costs throughput. |
| **Wait-free population-oblivious** | Bound is independent of thread count | The strongest practical form (e.g. `fetch_add` on a slot array). |

Hierarchy: wait-free ⊂ lock-free ⊂ obstruction-free ⊂ non-blocking; blocking is outside all of them.

**The definitional test:** kill a thread at any instruction. If the structure is still usable, it is at least lock-free. A CAS retry loop passes (the failed thread's CAS simply never lands and someone else's does); a mutex fails.

Key clarifications, all commonly examined:

- **A CAS loop is lock-free, not wait-free.** Each failure implies some other thread succeeded, so the *system* progresses; but one unlucky thread can retry indefinitely. `fetch_add` is wait-free because it cannot fail.
- **Lock-free does not mean fast.** Under heavy contention a lock-free stack can be *slower* than a well-implemented mutex, because every CAS retry costs a cache-line transfer and the failed work is pure waste, whereas a futex-backed mutex parks the loser and stops generating coherence traffic (Ch. 24).
- **"Lock-free" is not "no `std::mutex` in the source."** A `std::atomic<T>` that is not `is_always_lock_free` has a mutex inside it (Ch. 25 §25.2). So does a hidden allocation (`operator new` takes a lock, or at least a per-thread cache with a slow path), and so does any I/O or syscall. **Lock-free code must not allocate on the hot path.**
- **What lock-freedom actually buys you** in trading systems: immunity to the failure modes of locks — a thread preempted by the scheduler, a page fault, or a SIGSTOP in the critical section cannot stall the pipeline. That is a *tail-latency* argument, not a mean-latency one. On an isolated, pinned core with no preemption (Ch. 31), a spinlock's tail is often fine and the lock-free version buys little.

**Herlihy's consensus hierarchy** is worth naming: atomic read/write has consensus number 1; test-and-set, fetch-add and swap have 2; **CAS has ∞**, which is why CAS is the universal primitive and why every hardware vendor ships it. A wait-free implementation of any sequential object exists given CAS (the universal construction) — it is just impractically slow, which is why real wait-free structures are hand-designed.

---

## 26.2 Linearizability and Linearization Points

**Linearizability** (Herlihy & Wing, 1990) is the correctness condition for concurrent objects: every operation appears to take effect **instantaneously at some single instant between its invocation and its response**, and the resulting sequential history matches the object's sequential specification.

The **linearization point** is that instant — almost always a specific atomic instruction in the implementation.

```cpp
bool push(T v) {
    Node* n = new Node{v};
    n->next = head.load(relaxed);
    while (!head.compare_exchange_weak(n->next, n,
                                       std::memory_order_release,
                                       std::memory_order_relaxed))
        ;                 // ← LINEARIZATION POINT: the successful CAS
    return true;
}
```

Why the concept matters:

- **It is compositional.** A composition of linearizable objects is linearizable. Sequential consistency is *not* compositional, which is why linearizability is the standard for data structures and SC is the standard for the memory model.
- **It tells you what you may claim.** A queue whose `size()` is a relaxed load of a counter is *not* linearizable with respect to `size()`; the value may correspond to no state the queue ever had. Same for `empty()`. This is why `std::queue`-style APIs cannot be safely lock-free: `front()` then `pop()` is two operations with a gap, so lock-free queues must expose a single `try_pop(T&)`.
- **Linearization points can be in another thread's code.** In the Michael–Scott queue, a dequeuer may "help" by completing an enqueuer's tail update; the enqueue linearizes at the CAS that links the node, which may be executed by a different thread. Recognizing this is a strong signal.
- **Weaker conditions exist and are sometimes what you want.** *Sequential consistency* (no real-time ordering constraint), *quiescent consistency*, and *serializability* are all weaker. A relaxed statistics counter is only quiescently consistent, and that is fine.

**Practical implication for interviews:** when asked "is your queue correct?", answer by naming the linearization point of each operation and showing that the memory ordering makes the data written before it visible to whoever observes it after it. That is the whole proof obligation, and it ties directly to the release/acquire edge of Ch. 25 §25.11.

---

## 26.3 SPSC Queues

Single-producer / single-consumer is the special case where lock-free is *easy, wait-free, and genuinely fast* — and it is the workhorse of low-latency systems (feed handler → strategy, strategy → order gateway, hot path → logger).

```cpp
template <class T, size_t N>          // N a power of two
class SpscQueue {
    static_assert((N & (N-1)) == 0);
    alignas(64) std::atomic<size_t> head_{0};   // consumer writes
    alignas(64) std::atomic<size_t> tail_{0};   // producer writes
    alignas(64) size_t cached_head_ = 0;        // producer-private
    size_t cached_tail_ = 0;                    // consumer-private
    alignas(64) std::array<T, N> buf_;

  public:
    bool push(const T& v) {
        size_t t = tail_.load(std::memory_order_relaxed);   // we are the only writer
        size_t next = (t + 1) & (N - 1);
        if (next == cached_head_) {                          // maybe full — refresh
            cached_head_ = head_.load(std::memory_order_acquire);
            if (next == cached_head_) return false;          // really full
        }
        buf_[t] = v;
        tail_.store(next, std::memory_order_release);        // publishes buf_[t]
        return true;
    }
    bool pop(T& out) {
        size_t h = head_.load(std::memory_order_relaxed);
        if (h == cached_tail_) {
            cached_tail_ = tail_.load(std::memory_order_acquire);
            if (h == cached_tail_) return false;             // empty
        }
        out = buf_[h];
        head_.store((h + 1) & (N - 1), std::memory_order_release);
        return true;
    }
};
```

Everything important is in the details:

- **No CAS anywhere.** Each index has exactly one writer, so plain load/store suffices. Both operations are **wait-free**.
- **The release/acquire pair is the entire correctness argument.** `tail_.store(release)` publishes `buf_[t]`; the consumer's `tail_.load(acquire)` that observes it establishes happens-before (Ch. 25 §25.17).
- **Cached indices are the single biggest performance win.** Without them, every `push` loads `head_` — a line the *consumer* owns and dirties — costing a coherence miss (~40–100 ns) per operation. With caching, the producer only touches the consumer's line when it believes the queue is full. This routinely doubles or triples throughput and is the detail interviewers look for.
- **Padding.** `head_` and `tail_` must be on separate cache lines (§26.16), and `alignas(64)` on the buffer prevents the first elements from sharing a line with `tail_`.
- **Power-of-two capacity** turns modulo into a mask (`&`), a 1-cycle `and` versus a ~20–40-cycle `div`.
- **One slot is wasted** in the "next == head means full" formulation. The alternative — free-running counters that never wrap and are masked only for indexing (§26.7) — uses the whole buffer and makes `size()` a subtraction.
- **`T` should be trivially copyable and the buffer preallocated**; no allocation, no exceptions on the hot path.

**Cost.** An uncontended SPSC push/pop is ~2–5 ns in cache. The theoretical floor for cross-core handoff is one cache-line transfer, ~30–60 ns same-socket. Batching (§26.8) amortizes this. `boost::lockfree::spsc_queue`, `folly::ProducerConsumerQueue`, and `rigtorp::SPSCQueue` are the reference implementations; the last is the one to cite for the cached-index technique.

---

## 26.4 MPSC Queues

Multi-producer / single-consumer. The single consumer removes half the difficulty; the producers must agree on where to write.

**Design A — Vyukov intrusive MPSC (the classic).** Producers `exchange` the head; the consumer walks the list.

```cpp
struct Node { std::atomic<Node*> next; /* payload */ };
std::atomic<Node*> head_;         // producers
Node* tail_;                      // consumer-private

void push(Node* n) {
    n->next.store(nullptr, std::memory_order_relaxed);
    Node* prev = head_.exchange(n, std::memory_order_acq_rel);   // wait-free!
    prev->next.store(n, std::memory_order_release);              // link
}
```

- `exchange` never fails, so **`push` is wait-free** — a major advantage over CAS-loop designs, and the reason this is the standard choice for a logging queue where producers must never stall.
- The window between the `exchange` and the `next` store is the design's one flaw: the consumer can see a node whose `next` is not yet linked and must spin or report "temporarily empty" even though a producer is mid-push. So the queue is **not linearizable for `empty()`** and `pop` is only lock-free, not wait-free.
- Needs a dummy/stub node to avoid a null tail.

**Design B — ticketed ring.** Producers claim a slot with `fetch_add` on a sequence counter, write it, then mark it ready.

```cpp
size_t seq = tail_.fetch_add(1, std::memory_order_relaxed);   // wait-free claim
Slot& s = buf_[seq & mask];
// wait for slot to be free (consumer has drained the previous lap)
s.data = v;
s.ready.store(seq + 1, std::memory_order_release);            // publish
```
Bounded, allocation-free, cache-friendly, and the claim is wait-free — but a producer that is preempted between claiming and publishing **blocks the consumer at that slot**, so overall it is only obstruction-free at the queue level. This is the fundamental MPSC trade-off: *unbounded and wait-free with a linking window* (A) versus *bounded and cache-friendly with a stall window* (B).

**Low-latency notes.** Both designs concentrate all producer contention on a single cache line (`head_` or `tail_`), so throughput saturates at ~1 op per cache-line transfer, roughly 40–100 ns under real contention regardless of core count. If producers are many and rate is high, prefer **per-producer SPSC queues** with the consumer round-robining or merging by timestamp: contention disappears entirely, the consumer's poll loop becomes N cheap checks, and you gain per-producer backpressure. This "shard the queue instead of scaling the queue" answer is what senior candidates give.

---

## 26.5 MPMC Queues

The hardest case. The canonical practical design is the **Vyukov bounded MPMC queue**, and you should be able to sketch it.

```cpp
struct Cell { std::atomic<size_t> seq; T data; };
alignas(64) Cell buf_[N];                 // N power of two
alignas(64) std::atomic<size_t> enq_{0};
alignas(64) std::atomic<size_t> deq_{0};
// init: buf_[i].seq = i

bool try_push(const T& v) {
    Cell* c; size_t pos = enq_.load(std::memory_order_relaxed);
    for (;;) {
        c = &buf_[pos & (N-1)];
        size_t s = c->seq.load(std::memory_order_acquire);
        intptr_t diff = (intptr_t)s - (intptr_t)pos;
        if (diff == 0) {                                   // cell is free for this lap
            if (enq_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed))
                break;                                     // we own the cell
        } else if (diff < 0) return false;                 // full
        else pos = enq_.load(std::memory_order_relaxed);   // someone beat us; retry
    }
    c->data = v;
    c->seq.store(pos + 1, std::memory_order_release);      // publish to consumers
    return true;
}
```

Why it works: **each cell carries its own sequence number**, which encodes both "whose turn is it" and "which lap". `seq == pos` means the cell is ready for the producer of ticket `pos`; `seq == pos + 1` means it holds data for the consumer of ticket `pos`; the consumer sets `seq = pos + N` to release it for the next lap. The per-cell sequence is what eliminates ABA (§26.10) *and* removes the need for memory reclamation (§26.12) entirely — nothing is ever freed.

Properties:

- **Lock-free, not wait-free.** A preempted thread between winning the CAS and storing `seq` blocks exactly one cell, which blocks consumers at that position — the queue stalls behind it. Under preemption this is the dominant failure mode, which is why MPMC queues want pinned, non-preempted threads.
- **Bounded, allocation-free, no ABA, no reclamation.** These four together are why this design beats Michael–Scott in practice.
- **Two hot lines** (`enq_`, `deq_`) plus per-cell traffic. Throughput is bounded by CAS contention on the head counters, ~O(1 cache-line transfer) per operation.

**Michael–Scott queue** (unbounded, linked, 1996) is the textbook alternative: two CAS'd pointers, a dummy node, and *helping* (a dequeuer advances a lagging `tail` on an enqueuer's behalf). It is linearizable and lock-free, but it needs an allocation per node and a full reclamation scheme (§26.12), which is where all the difficulty moves. Ask in an interview: "unbounded means allocation, allocation means a lock and a reclamation problem — do we actually need unbounded?" The answer in trading is almost always no.

Reference implementations: `moodycamel::ConcurrentQueue` (fast, but only *approximately* FIFO — it uses per-producer sub-queues), `folly::MPMCQueue` (ticket-based, blocking and non-blocking variants), `boost::lockfree::queue` (Michael–Scott with freelist + tagged pointers).

---

## 26.6 Bounded Lock-Free Ring Buffers

The ring buffer is the substrate under §26.3–26.5, and its own design choices are examinable.

**Slot state encodings**, in increasing order of quality:

| Scheme | Mechanism | Problem |
|---|---|---|
| Index comparison (`head == tail`) | Two counters | Cannot distinguish full from empty without wasting a slot or a flag |
| Per-slot `bool ready` | One byte per slot | ABA across laps: a stale reader can see `ready` from the previous lap |
| **Per-slot sequence number** | `seq` encodes ticket + lap | Correct, no ABA, no reclamation — the Vyukov scheme (§26.5, §26.7) |

**Memory layout.** Allocate the buffer with the control block on separate cache lines, size it to a power of two, and consider huge pages (Ch. 7, Ch. 32) — a 1 MB ring touched randomly costs a TLB miss per access with 4 KB pages, and `MAP_HUGETLB` or THP removes it. Prefault and `mlock` the region so no page fault lands on the hot path.

**Prefetching.** In a consumer draining a ring, `__builtin_prefetch(&buf_[(h + D) & mask])` with a distance `D` of a few slots hides the L1/L2 miss on the next elements. This matters when slots are larger than a cache line (Ch. 28). Hardware prefetchers pick up the sequential stride automatically for large elements but are defeated by the wraparound.

**Element size.** Storing `T` inline avoids a pointer chase (one cache miss instead of two) and avoids reclamation, but makes the copy cost proportional to `sizeof(T)`. For market-data messages of 32–128 bytes, inline wins decisively. For large payloads, store an index into a preallocated slab, never a `new`-ed pointer.

**The single-writer principle.** The best-performing ring designs give every mutable word exactly one writer (as in §26.3). Where you can restructure a system so that each cache line has one writer, you eliminate CAS entirely and get wait-free operations. This is the LMAX Disruptor's central claim, and it generalizes: *contention is a design property, not an implementation detail.*

**The Disruptor** itself is worth naming: a single ring shared by multiple consumers, each with its own cursor, producers claiming via `fetch_add`, consumers waiting on published sequence numbers, and batching that emerges naturally (a consumer that falls behind catches up by processing everything published so far, so throughput *rises* under load). Its wait strategies span busy-spin → yield → block, exactly the spin-then-park ladder of Ch. 24.

---

## 26.7 Queue Wraparound and Sequence Counters

**Never store wrapped indices in the shared counters.** Store free-running, monotonically increasing 64-bit sequence numbers and mask only when indexing:

```cpp
size_t idx = seq & (N - 1);        // N power of two
size_t used = tail_ - head_;       // correct even across wrap, if unsigned
bool full = (tail_ - head_) == N;
```

Reasons:

1. **`size()` becomes a subtraction** that is correct without a branch. With wrapped indices you need `(tail - head + N) % N` and a full/empty ambiguity.
2. **Unsigned wraparound is well-defined** (Ch. 2 §2.4) and the subtraction stays correct across the `2^64` boundary, so the counter never needs special handling. At 100 M ops/s, `uint64_t` overflows in ~5,800 years. A `uint32_t` counter overflows in 43 seconds — this is a real bug, not a theoretical one.
3. **ABA is structurally prevented.** A monotonic sequence number can never repeat, so a stale observer that compares sequence numbers always detects staleness (§26.10). This is why the Vyukov per-cell `seq` works, and it is the general principle: *ABA is defeated by monotonicity*.

The per-cell sequence protocol, stated precisely for a capacity-`N` ring:

```
cell[i].seq == pos            → free, awaiting producer with ticket pos
cell[i].seq == pos + 1        → full, awaiting consumer with ticket pos
consumer sets seq = pos + N   → free for the next lap
```
The comparison must be `(intptr_t)(seq - pos)` — a **signed difference of unsigned values** — so that it remains correct when the counters straddle the wrap point. Writing `seq < pos` directly is the classic bug; this is the same idiom as Linux's `time_after()` macro and TCP sequence-number comparison (Ch. 38).

**Power-of-two capacity is effectively mandatory.** Non-power-of-two forces either a `%` (20–40 cycles, and a data dependency that stalls the pipeline) or a conditional subtract (`if (++i == N) i = 0;`) which is branchy but often fine for a single-writer index. For a masked design the compiler folds the mask into the addressing mode, making the index computation free.

**False-sharing note:** in a multi-producer ring, the per-cell sequence numbers are written by both producers and consumers. If slots are small, several cells share a line and the sequence stores bounce it. Padding each cell to a cache line trades memory for throughput and is usually worth it when slots are hot.

---

## 26.8 Queue Backpressure Policies

A bounded queue must decide what happens when it is full. This is a *system design* question that interviewers use to separate people who have run production systems from people who have read papers.

| Policy | Behavior | When |
|---|---|---|
| **Block / park** | Producer waits on a condition variable or `atomic::wait` | Throughput-oriented pipelines; never on a tick-to-trade path (introduces a syscall and unbounded latency) |
| **Spin** | Producer busy-waits | Pinned, isolated cores, short expected stalls; burns a core |
| **Fail fast** (`try_push` returns false) | Caller decides | The right default for a hot path — makes the policy explicit at the call site |
| **Drop newest** | Discard the incoming item | Logging, metrics, non-critical telemetry |
| **Drop oldest** | Overwrite the tail | Market-data snapshots where only the latest matters; a "conflating queue" |
| **Overwrite unconditionally** | No backpressure at all; readers detect staleness | Seqlock-style broadcast (§26.9) |
| **Grow** | Reallocate | Never on a hot path: allocation, copy, and unbounded memory |

Principles:

- **Always account for drops.** A silent drop is a correctness bug in a trading system. Maintain a per-queue relaxed drop counter and alarm on it (Ch. 59).
- **Backpressure must reach the source or it is not backpressure.** If a full queue causes the feed handler to drop packets rather than the strategy to shed work, you have moved the failure, not handled it. Push the decision to where the business logic is (Ch. 52).
- **Queue depth is a latency budget, not a memory budget.** A queue that is routinely non-empty is a queue that is adding latency: by Little's law, `latency = depth / throughput`. A 1024-slot queue that runs half full at 1 M msg/s is adding 512 µs. In HFT the correct steady-state depth is *zero or one*; the ring exists to absorb microbursts, not to buffer. **Alarm on watermarks**, not just on overflow (Ch. 56).
- **Batching interacts with backpressure.** Draining N items per wakeup amortizes the cache-line transfer and the wakeup cost, so throughput rises under load — but it raises the latency of the *first* item in the batch. On a latency path, batch only opportunistically (take whatever is available, never wait to accumulate).

---

## 26.9 Seqlocks

A **seqlock** is the right answer for *one writer, many readers, small fixed-size data, reads vastly outnumber writes* — the exact shape of "publish the current best bid/offer to N strategies".

```cpp
struct Seqlock {
    std::atomic<uint64_t> seq{0};
    Data data;                      // accessed via atomic_ref or as atomics

    void write(const Data& d) {                       // single writer
        seq.store(seq.load(relaxed) + 1, std::memory_order_relaxed);  // now ODD
        std::atomic_thread_fence(std::memory_order_release);
        data = d;                                      // "racy" bulk copy
        seq.store(seq.load(relaxed) + 1, std::memory_order_release);  // now EVEN
    }
    bool read(Data& out) const {                       // many readers, wait-free? no — lock-free
        uint64_t s0 = seq.load(std::memory_order_acquire);
        if (s0 & 1) return false;                      // writer in progress
        out = data;
        std::atomic_thread_fence(std::memory_order_acquire);
        return seq.load(std::memory_order_relaxed) == s0;   // unchanged → valid
    }
};
```

Properties:

- **Readers never write shared state.** No cache-line invalidation from readers at all, so read throughput scales perfectly with core count. This is the seqlock's defining advantage over a reader-writer mutex, where every reader RMWs the shared count and destroys scalability (Ch. 24).
- **The writer is never blocked by readers.** Writes are wait-free; reads are lock-free (a reader can be starved by a continuous stream of writes).
- **No allocation, no reclamation, no ABA.** The data is in place.
- **The odd/even sequence** is the standard encoding: odd = write in progress, and a reader that sees the same even value before and after knows no write intervened.

**The formal problem:** the payload copy in `read` races with the writer's copy — by the letter of Ch. 25 §25.1, that is UB, and TSan will flag it. The value read is discarded when validation fails, but UB is UB and the compiler could in principle do something insane (e.g., if the torn read caused a trap representation, or if the compiler assumed race-freedom and reordered). The rigorous fixes:

1. Make the payload an array of `std::atomic<uint64_t>` (or use `std::atomic_ref` per word) with **relaxed** loads/stores, plus explicit fences. This is well-defined, and on x86/ARM emits exactly the same instructions as the plain copy for aligned words. It does block vectorization of the copy, which is the real cost.
2. Use `memcpy` and accept the technical UB (what the Linux kernel does, with `READ_ONCE`/`WRITE_ONCE`).
3. P1478 proposed `std::atomic_load_per_byte_memcpy` to make this legal; not yet standard as of C++23.

**Fence placement is the classic bug.** The reader's second `seq` load must not be hoisted above the payload copy — hence the acquire fence *between* them (Ch. 25 §25.15). Omitting it is invisible on x86 and broken on ARM.

**Low-latency use:** a seqlock over a 64-byte BBO struct gives readers a ~2–5 ns snapshot with zero coherence traffic beyond the initial line fetch, and lets the writer publish at full speed. Retries are rare when writes are short. If the payload exceeds a couple of cache lines, retry probability climbs and a double-buffer with an atomic index becomes better.

---

## 26.10 The ABA Problem

**ABA:** a thread reads value `A`, is delayed, and by the time it performs its CAS the value has changed to `B` and back to `A`. The CAS succeeds — but the *state* the thread reasoned about is gone.

The canonical break, a lock-free stack:

```
Stack: A -> B -> C
T1: pop() reads head = A, reads A->next = B. PREEMPTED before CAS.
T2: pop() A.   pop() B.   push(A).      Stack: A -> C   (B is freed or reused)
T1: resumes. CAS(head, A, B) SUCCEEDS — head is A, as expected.
    Stack is now: B -> ???   B was freed. Corruption.
```

The CAS compared a *pointer*, and pointer values are recycled by the allocator — often immediately, because allocators are LIFO for cache-friendliness, which makes ABA far more likely than intuition suggests.

**ABA is not a memory-ordering bug.** No amount of `seq_cst` fixes it. It is a failure of CAS to distinguish "unchanged" from "changed back". Similarly, it is not the same as **use-after-free** (§26.12), though the two travel together: reading `A->next` after `A` was freed is a separate, worse bug that ABA prevention alone does not fix.

**Where ABA does and does not appear:**

| Structure | ABA risk |
|---|---|
| Treiber stack, Michael–Scott queue (with recycling) | High — the textbook cases |
| CAS on a monotonically increasing counter | **None** — values never repeat (§26.7) |
| Vyukov bounded MPMC (per-cell sequence) | **None** — the lap is encoded in the sequence |
| Seqlock | None — odd/even plus monotonic sequence |
| CAS on a pointer into a slab, with a version tag | None if the tag is wide enough |

**Solutions**, in the order you should present them:

1. **Don't reuse the value** — monotonic sequence numbers instead of pointers (§26.7). Best answer whenever it applies.
2. **Tagged pointers / double-width CAS** (§26.11) — attach a version counter.
3. **Defer reclamation** so `A` cannot be recycled while anyone holds a reference (§26.12–26.14). This also fixes use-after-free, which the tag alone does not.
4. **Use indices into a fixed array** rather than pointers, with a generation counter — the same idea, but a 32-bit index plus a 32-bit generation packs into one 64-bit atomic and needs no `cmpxchg16b`.
5. **LL/SC hardware** (`ldxr`/`stxr`) is *immune* to ABA by construction: the store-conditional fails if the line was written at all, regardless of the value. This is a genuine architectural advantage of ARM/POWER over x86's CAS, and worth mentioning — though it also means algorithms verified on LL/SC can be subtly wrong when ported to CAS.

---

## 26.11 Tagged Pointers

The standard ABA fix on CAS machines: pair the pointer with a monotonically incrementing **tag** (ABA counter) and CAS both at once.

**Option A — packed into 64 bits.** Exploit unused address bits.

```cpp
// x86-64 canonical addresses use 48 bits (57 with 5-level paging).
// Alignment gives free LOW bits: a 16-byte-aligned pointer has 4 zero low bits.
struct Tagged {
    uint64_t v;
    Node* ptr() const { return reinterpret_cast<Node*>(v & 0x0000FFFFFFFFFFFFull); }
    uint16_t tag() const { return uint16_t(v >> 48); }
};
```
- **Fits in one 8-byte atomic → plain `lock cmpxchg`**, the cheapest option.
- **Fragile.** 5-level paging (57-bit addresses, Ice Lake+ under `MAP_HUGETLB`/hint) breaks the high-16 assumption. ARM's **top-byte-ignore (TBI)** and **MTE** actively use the top byte, so high-bit tagging on AArch64 can silently alias or trip a tag-check fault. Provenance is formally lost (Ch. 3 §3.10). Prefer the **low** bits, which alignment guarantees to be zero and which no hardware feature claims.
- A 16-bit tag wraps after 65 536 reuses. That is not "never"; it is "unlikely per unlucky-window", and the window is a preemption, so a hot loop plus a scheduler tick can hit it. Widen where you can.

**Option B — double-width CAS.** 128-bit atomic of `{pointer, uint64 tag}`.

```cpp
struct alignas(16) TaggedPtr { Node* p; uint64_t tag; };
std::atomic<TaggedPtr> head;   // needs -mcx16 (x86 cmpxchg16b) or +lse (ARM casp)
static_assert(std::atomic<TaggedPtr>::is_always_lock_free);   // MANDATORY
```
- 64-bit tag: never wraps in practice.
- Requires `cmpxchg16b` (x86-64, `-mcx16`) or `casp` (ARMv8.1 LSE). Without them, `std::atomic<TaggedPtr>` silently falls back to the **lock table** and your lock-free structure has a mutex in it (Ch. 25 §25.2) — hence the mandatory `static_assert`.
- `cmpxchg16b` costs more than `cmpxchg` (it clobbers `rbx`/`rcx`, needs 16-byte alignment, and is ~2× the latency), and 16-byte atomics on some ARM cores are notably slow. Measure.
- The `struct` must have **no padding** or CAS never succeeds (Ch. 3 §3.2).

**Option C — index + generation.** `uint32_t index` into a preallocated slab plus `uint32_t generation`, packed in a `uint64_t`. Single-word CAS, 4 billion generations, no address-bit assumptions, no allocation, better cache locality (the slab is contiguous), and portable. **This is the answer to give for a trading system**: it converts the pointer problem into an array problem and eliminates both ABA and reclamation in one move.

Note that tagging fixes ABA but **not use-after-free**: T1 may still dereference `A->next` after `A` was freed, before it ever reaches the CAS. Tagged pointers therefore need a *type-stable* allocator (memory that, once used for a `Node`, is only ever reused for a `Node` and never unmapped) — the classic "type-stable memory" requirement. A slab of nodes provides exactly that, which is another argument for Option C.

---

## 26.12 Memory Reclamation

The central unsolved-in-hardware problem of lock-free programming: **when is it safe to free a node that has been unlinked?** Some thread may have loaded a pointer to it a nanosecond before you unlinked it, and there is no way to ask.

Under a mutex the answer is trivial (nobody can be reading). Lock-free, you need a **safe memory reclamation (SMR)** scheme. The options:

| Scheme | Reader cost | Memory bound | Complexity | Notes |
|---|---|---|---|---|
| **Leak / never free** | 0 | Unbounded | None | Legitimate for bounded, preallocated structures — the best answer when it applies |
| **Reference counting** (in-node) | 2 atomic RMWs per traversal | Tight | Low | Contended line per node; defeats the point on read-heavy paths. Cannot safely load the pointer *and* increment atomically without DCAS. |
| **Hazard pointers** (§26.13) | 1 store + fence per protected pointer | **Bounded**: O(threads × HPs) | Medium | Wait-free reads, bounded memory. The robust choice. |
| **Epoch-based / QSBR** (§26.14) | ~1 relaxed store per critical section | **Unbounded** if a thread stalls | Medium | Fastest reads. A blocked thread pins the epoch and memory grows without limit. |
| **RCU** (§26.15) | 0 on QSBR-style readers | Unbounded | Medium | Kernel's answer; user-space via `liburcu` or `membarrier(2)` |
| **Type-stable memory / slab** | 0 | Fixed at startup | Low | Prevents use-after-free-of-*type*, not stale reads; combine with generations |
| **Deferred free with a grace period** | 0 | Bounded by rate × period | Low | "Free after 100 ms" is crude but ships; used more than admitted |

**The key trade-off to state:** hazard pointers give **bounded memory at a per-read cost**; epochs/RCU give **near-zero read cost with unbounded memory under a stalled reader**. Choose by which failure you can tolerate. In a trading process with pinned, non-preempted, always-progressing reader threads, epochs are excellent. In a general server with thread pools and blocking, hazard pointers are safer.

**C++ status:** `std::hazard_pointer` and `std::rcu_domain`/`rcu_obj_base` were voted into **C++26** (P2530, P2545). Before that, `folly::hazptr`, `libcds`, `crossbeam-epoch`-style designs, `liburcu`, and `seastar`'s RCU are what people use.

**The design-level answer that wins interviews:** the cheapest reclamation scheme is the one you never run. Preallocate a fixed pool of nodes at startup, index them with 32-bit handles, and encode a generation counter (§26.11 Option C). No `new`, no `delete`, no epochs, no hazard pointers, bounded memory by construction, and no ABA. Most HFT lock-free structures are built this way; the academic schemes exist because general-purpose libraries cannot assume a bounded working set.

---

## 26.13 Hazard Pointers

A **hazard pointer** is a single-writer, multi-reader announcement: "I am currently dereferencing this address; do not free it."

```
Global: an array of per-thread hazard slots (atomic<void*>), one or a few per thread.

Reader (protect):
  do {
      p = head.load(acquire);         // 1. read the pointer
      hp.store(p, seq_cst);           // 2. announce it  ← needs STORE-LOAD ordering
  } while (p != head.load(acquire));  // 3. re-validate: still linked?
  use(p);                             // safe: any retire-er will see our hazard
  hp.store(nullptr, release);

Retirer:
  unlink(p);
  retired_list.push(p);
  if (retired_list.size() > threshold) {          // amortize
      scan all hazard slots into a set H;         // O(threads)
      free every retired node not in H;           // O(retired log threads)
  }
```

**Why the loop and the `seq_cst` store are both mandatory.** Between reading `p` and announcing it, another thread may unlink and retire `p`. The re-validation closes that window: if `head` still equals `p`, then the retirer either has not yet scanned (and will see our hazard) or unlinked after our announcement. This argument requires **store→load ordering** between the hazard store and the re-read — the one reordering x86 permits (Ch. 25 §25.19). So the hazard store must be `seq_cst` (an `mfence`/`xchg`, ~20–40 cycles), or you need an asymmetric barrier.

**The asymmetric-barrier optimization** is the detail that marks an expert: instead of paying a fence on every *read*, use `membarrier(MEMBARRIER_CMD_PRIVATE_EXPEDITED)` on Linux (Ch. 33) in the *retirer*, which forces a barrier on every other core. Readers then use a plain relaxed store. Since retires are rare and reads are hot, this moves the cost from the common path to the rare one — the same trick as `sys_membarrier`-based RCU and Windows' `FlushProcessWriteBuffers`. Folly's `hazptr` and Java's `Thread.onSpinWait`-era code both do this.

Properties:

- **Reads are wait-free** (bounded retries in practice; the standard formulation is lock-free, and wait-free variants exist).
- **Memory is bounded**: at most `R + N×K` unreclaimed nodes, where `N` = threads, `K` = hazard pointers per thread, `R` = the retire threshold. This is the property epochs lack.
- **Cost per protected pointer:** one store + a fence (or a relaxed store with asymmetric barriers) + one re-validating load. For a linked-list traversal you need a hazard pointer per node *and* hand-over-hand protection, which makes hazard pointers expensive for long traversals and cheap for "grab the head and use it".
- **Retire scanning is O(threads)** and amortized over the threshold; use a hash set or sorted array of hazards.

**C++26** standardizes `std::hazard_pointer`, `std::hazard_pointer_obj_base<T>` (which supplies `retire()`), and `std::make_hazard_pointer()`. The API protects via `hp.protect(atomic_ptr)`, which encapsulates the load-announce-revalidate loop.

---

## 26.14 Epoch-Based Reclamation

EBR replaces per-object announcements with a **global epoch counter** and per-thread participation.

```
global std::atomic<uint64_t> epoch;          // advances 0,1,2,...
per-thread: atomic<uint64_t> local_epoch;    // 0 = quiescent, else the epoch it entered

Reader:
  local_epoch.store(epoch.load(relaxed), memory_order_seq_cst);   // enter
  ... traverse freely, no per-pointer cost ...
  local_epoch.store(0, memory_order_release);                     // exit

Retirer:
  retire p into bucket[epoch % 3];
  if (all active threads' local_epoch == current epoch)
      e = epoch.fetch_add(1);
      free everything in bucket[(e - 2) % 3];    // two epochs old ⇒ nobody can hold it
```

**Why three buckets.** A thread that entered at epoch `e` can only hold pointers unlinked at epoch `e` or later; advancing twice guarantees every reader that could have seen the pointer has exited. Two generations of grace plus the current one = three.

Trade-offs versus hazard pointers:

| | Hazard pointers | Epoch-based |
|---|---|---|
| Per-read cost | 1 store + fence **per pointer** | 1 store + fence **per critical section** |
| Traversal of K nodes | O(K) announcements | O(1) |
| Memory bound | **Bounded** | **Unbounded** — one stalled reader blocks all reclamation forever |
| Blocking readers | Safe | Catastrophic (never take a lock, allocate, or do I/O inside an epoch section) |
| Complexity | Higher per-structure | Lower — reclamation is orthogonal to the structure |

The unbounded-memory failure is real and severe: a reader that page-faults, gets preempted, or blocks on a syscall inside its critical section pins the epoch, and every retired object accumulates. Mitigations: keep critical sections tiny and non-blocking, run readers on isolated non-preemptible cores (Ch. 31), and add a watchdog that alarms when the epoch has not advanced.

**Variants.** *QSBR* (quiescent-state-based) removes the enter/exit stores entirely: threads periodically declare a quiescent state (e.g., at the top of their event loop, where they provably hold no references). Reads then cost **literally zero** — the fastest possible reclamation, and the natural fit for a busy-poll event loop (Ch. 55), which has an obvious quiescent point every iteration. This is the design to propose for a trading hot path. *Interval-based* and *hazard-eras* schemes hybridize the two to get bounded memory with epoch-like read cost.

---

## 26.15 Read-Copy-Update

**RCU** is the discipline built on epochs/QSBR: readers never write, writers copy.

```
Update:  new = copy(old); modify(new);
         ptr.store(new, release);        // publish (Ch. 25 §25.17)
         synchronize_rcu();              // wait for a grace period
         free(old);                      // now provably unreferenced

Read:    rcu_read_lock();                // often a no-op (QSBR)
         p = rcu_dereference(ptr);       // consume-style load
         use(p);
         rcu_read_unlock();
```

- **`rcu_read_lock()` is free** in QSBR/kernel-preemptible-off builds — it is a compiler barrier, or literally nothing. This is RCU's headline property: reader-side cost of *zero*, perfect scalability, no cache-line contention.
- **A grace period** is the interval after which every pre-existing reader has finished. `synchronize_rcu()` blocks for it (milliseconds in the kernel); `call_rcu()` defers the free to a callback instead, which is what you use when the updater must not block.
- **`rcu_dereference`** is exactly `memory_order_consume` (Ch. 25 §25.10) — the dependency-ordered load that is free on real hardware. In user space it is written as a relaxed load plus a compiler barrier, with the dependency chain hand-maintained.
- **Writers are not lock-free** — they serialize among themselves, usually with a plain mutex. RCU optimizes *reads* absolutely and accepts slow writes. That asymmetry is the whole design.

**When RCU is the right answer:** read-mostly data with rare updates and where readers tolerate a slightly stale view — routing tables, configuration, symbol/reference data, permission sets, a subscription list. In a trading system, "reload the instrument reference data without stalling the strategy" is the textbook use (Ch. 49, Ch. 60).

**User-space implementations.** `liburcu` offers QSBR (fastest, requires explicit quiescent points), memory-barrier (portable, a fence per read section), and signal-based flavors. Linux's `membarrier(MEMBARRIER_CMD_PRIVATE_EXPEDITED)` gives an asymmetric barrier so readers pay nothing and the writer pays an IPI — the modern basis for fast user-space RCU. **C++26** standardizes `std::rcu_obj_base`, `std::rcu_retire`, `std::rcu_synchronize`, and `std::rcu_domain` (P2545).

**The comparison to state:** RCU/epochs give zero-cost reads and unbounded memory under a stalled reader; hazard pointers give bounded memory and a small per-read cost; `atomic<shared_ptr>` (Ch. 25 §25.22) gives simplicity and a contended refcount that scales negatively. Pick by whether you can bound reader duration.

---

## 26.16 False Sharing

**False sharing** is two logically independent variables occupying the same cache line, so that a write by one core invalidates the other core's copy, forcing a coherence transfer that the algorithm never asked for (Ch. 28).

```cpp
struct Bad  { std::atomic<uint64_t> a, b; };   // 16 bytes, ONE cache line
// Core 0 increments a in a loop; Core 1 increments b.
// Every increment invalidates the other core's line: ~40-100 ns each,
// versus ~1 ns if they were separate. 10-100x slowdown, with no logical sharing.
```

Diagnosis:

- The signature is **throughput that gets worse as you add cores**, with no lock contention visible in a profiler.
- `perf c2c` (cache-to-cache) is the tool: it attributes HITM (hit-modified) events to specific cache lines and offsets, and names the sharing pair. `perf stat -e mem_load_l3_hit_retired.xsnp_hitm` (Intel) is the coarse counter. Ch. 43.
- `pahole` shows which fields land on the same line (Ch. 3 §3.4).

Distinguish it from **true sharing** — genuine contention on one variable — which padding does *not* fix. True sharing needs sharding (per-core counters), a different algorithm, or batching.

| | False sharing | True sharing |
|---|---|---|
| Cause | Unrelated data on one line | Same variable |
| Fix | Padding / alignment / reordering fields | Sharding, batching, or a different algorithm |
| `perf c2c` shows | Two different offsets in one line | The same offset |

Non-obvious sources:

- **Adjacent elements of an array of per-thread state** — `counters[tid]++` with `uint64_t counters[N]` puts 8 threads on one line. The single most common instance.
- **A hot mutable field next to a hot read-only field.** Readers of the const field are invalidated by every write to its neighbour. Split hot-write and hot-read data into separate lines (Ch. 42, data-oriented design).
- **The head and tail of a queue** (§26.3).
- **Dynamically allocated objects** — the allocator may place two small objects from different threads on one line; a per-thread arena or a cache-line-sized allocation fixes it.
- **`std::vector<bool>`** and bitsets: adjacent bits are the same *byte*, which is true sharing at the memory-location level and a data race (Ch. 25 §25.1), not merely false sharing.

---

## 26.17 Cache-Line Padding

The mechanical fix for §26.16, plus the cases where it is the wrong fix.

```cpp
// C++17
struct alignas(std::hardware_destructive_interference_size) Counter {
    std::atomic<uint64_t> v{0};
};
static_assert(sizeof(Counter) == 64);          // alignas rounds sizeof up (Ch. 3 §3.3)

// Explicit, ABI-stable, and what most shops actually write:
struct alignas(64) PaddedCounter {
    std::atomic<uint64_t> v{0};
    char pad[64 - sizeof(std::atomic<uint64_t>)];
};
```

Details:

- **`alignas(N)` also rounds `sizeof` up to a multiple of `N`** (Ch. 3 §3.3), so aligning a struct usually pads it automatically — you do not always need explicit `pad[]`. You *do* need it when the object is embedded in a larger struct whose next member would otherwise share the tail.
- **`std::hardware_destructive_interference_size`** (C++17) is the minimum offset to avoid false sharing; `hardware_constructive_interference_size` is the maximum size to promote sharing. Both are compile-time constants, so using them in an ABI-visible type makes your ABI depend on the compiler's guess — GCC warns (`-Winterference-size`) for exactly this reason and defaults to 64. libc++ omitted them for years.
- **64 is not always right.** Intel's **adjacent-line prefetcher** pulls pairs of lines, making the effective granularity 128 bytes for some workloads; Apple Silicon uses 128-byte lines; some IBM POWER cores use 128. Padding to 128 costs memory and can hurt if it evicts useful data. Measure with `perf c2c`.
- **The cost of padding is cache footprint.** An array of 64-byte-padded per-thread counters uses 64× the memory of packed `uint64_t`s and 64× the cache lines. For 8 threads that is trivial; for 10 000 objects it is a working-set disaster. Pad the *contended* things, not everything.
- **Padding does not help true sharing.** If all threads increment the *same* counter, padding changes nothing; shard into per-core counters (aligned and padded) and sum on read (Ch. 59).
- **Layout ordering is the free version.** Grouping all read-mostly fields together and all hot-write fields together often removes false sharing without any padding, and improves density at the same time. Do this first.

**The standard structure for a lock-free queue's control block:**
```
| cacheline 0: producer index + producer-private cached consumer index |
| cacheline 1: consumer index + consumer-private cached producer index |
| cacheline 2..: the ring buffer itself, itself 64-byte aligned        |
```
Getting this layout right is worth more than any micro-optimization inside the push/pop bodies, and it is exactly what an interviewer wants you to draw.

---

## Key Interview Questions

1. **Define lock-free, wait-free, and obstruction-free.** — Lock-free: some thread progresses system-wide in bounded steps. Wait-free: every thread finishes in bounded steps of its own. Obstruction-free: a thread progresses if run in isolation. The test is "suspend any thread arbitrarily; is the structure still usable?"
2. **Is a CAS retry loop wait-free?** — No, lock-free: each failure means someone else succeeded, but a given thread can starve. `fetch_add` and `exchange` are wait-free because they cannot fail.
3. **Is lock-free always faster than a mutex?** — No. Under high contention a CAS loop wastes work and generates a cache-line transfer per retry, while a futex mutex parks losers. Lock-freedom is a *tail-latency and robustness* argument (no stall from preemption, page faults, or priority inversion).
4. **What is a linearization point?** — The single instant at which an operation appears to take effect, almost always one atomic instruction. Naming it for each operation is the proof obligation for correctness, and linearizability (unlike sequential consistency) composes.
5. **Sketch an SPSC ring and name every ordering.** — Power-of-two buffer, one writer per index, `release` store on publish, `acquire` load on observe, relaxed loads of your own index, cached opposite index to avoid touching the other core's line, both indices on separate cache lines. Wait-free, no CAS.
6. **Why cache the opposite index in an SPSC queue?** — Otherwise every operation reads a line the other core dirties, costing a coherence miss (~40–100 ns) per op; caching makes that happen only near full/empty. Typically a 2–3× throughput win.
7. **What is ABA and does `seq_cst` fix it?** — Value changes A→B→A so a CAS succeeds despite the state having changed. Memory ordering is irrelevant; fixes are monotonic sequence numbers, tagged pointers/DCAS, index+generation, or deferred reclamation. LL/SC hardware is immune by construction.
8. **How do tagged pointers work and what breaks them?** — Version counter packed with the pointer, CAS'd together. High-bit packing breaks under 5-level paging, ARM TBI, and MTE; low bits (alignment-guaranteed) are safer; 16-byte DCAS needs `-mcx16`/`+lse`, and without it `std::atomic` silently uses a lock table.
9. **Why does the Vyukov MPMC queue need no reclamation and have no ABA?** — Each cell holds a monotonically increasing sequence number encoding ticket and lap; nothing is ever freed and no value ever repeats.
10. **Hazard pointers versus epoch-based reclamation?** — Hazard: per-pointer announce + fence, **bounded** memory, safe with blocking readers. Epochs/QSBR: ~zero read cost, **unbounded** memory if any reader stalls inside a critical section. Choose by whether reader duration is bounded.
11. **Why must the hazard-pointer store be `seq_cst`?** — The announce-then-revalidate protocol needs store→load ordering, the one reordering x86 permits. The optimization is an asymmetric barrier (`membarrier` expedited) in the rare retire path, letting readers use a relaxed store.
12. **What is RCU and what is `rcu_dereference`?** — Readers never write and pay nothing; writers copy, publish with a release store, wait a grace period, then free. `rcu_dereference` is `memory_order_consume` — dependency ordering, free on all real hardware, which is why no compiler implements consume properly.
13. **When is a seqlock the right structure, and what is technically wrong with it?** — One writer, many readers, small payload, read-dominated; readers never dirty a line so reads scale perfectly. The payload copy is formally a data race; fix with per-word relaxed atomics plus fences, or accept it as the kernel does.
14. **False sharing versus true sharing?** — False: unrelated data on one line, fixed by padding/alignment/field reordering. True: the same variable, fixed only by sharding, batching, or a different algorithm. `perf c2c` distinguishes them by offset within the line.
15. **What is wrong with `hardware_destructive_interference_size`?** — It is a compile-time constant, so putting it in an ABI-visible type ties your ABI to the compiler's guess; GCC warns. 64 is the usual value but Apple Silicon and some POWER cores use 128, and Intel's adjacent-line prefetcher makes the effective granularity 128.
16. **Why must lock-free code avoid allocation?** — `new` can take a lock, page-fault, or call `mmap`, destroying the progress guarantee and the latency bound. Preallocate a slab and use indices.
17. **How would you design an MPSC logging queue where producers must never block?** — Vyukov intrusive MPSC: a single `exchange` on the head makes `push` wait-free; the consumer tolerates the brief unlinked window. Or per-producer SPSC queues merged by the consumer, which removes contention entirely and gives per-producer backpressure.
18. **What backpressure policy do you choose for a bounded hot-path queue?** — `try_push` returning false, with a relaxed drop counter and a watermark alarm; never block or grow. Queue depth is a latency budget (Little's law), so the steady-state target depth is zero.
19. **How do you validate a lock-free structure?** — Model checking with GenMC/CDSChecker over the atomics (Ch. 25 §25.19), TSan for races, stress tests with randomized schedules on ARM as well as x86, and `perf c2c` for the layout. Reasoning about linearization points is what the tests confirm, not replace.

---

## Common Traps

- **Believing "lock-free" means "fast".** It is a progress guarantee; under contention it can be slower than a parking mutex.
- **Calling a structure lock-free while it allocates.** `new`, `std::function`, growing containers, and non-`is_always_lock_free` atomics all hide locks.
- **Assuming a CAS loop is wait-free.** One thread can starve indefinitely.
- **Ignoring ABA because "the pointer is the same".** That is exactly the bug; allocators recycle LIFO, so ABA is likely, not exotic.
- **Fixing ABA with a tag but not fixing use-after-free.** A stale thread can dereference the freed node before it ever reaches the CAS; you also need type-stable memory or real reclamation.
- **Tagging pointers in the high bits.** Broken by 5-level paging, ARM TBI, and MTE; use alignment-guaranteed low bits or an index+generation word.
- **Using a 16-byte atomic without `static_assert(is_always_lock_free)`** — silently becomes a lock table without `-mcx16`/`+lse`.
- **A tagged struct with padding** — CAS compares object representation and will never succeed (Ch. 3 §3.2).
- **A 32-bit sequence counter.** At 100 M ops/s it wraps in 43 seconds.
- **Comparing sequence numbers with `<` instead of a signed difference.** Breaks at the wrap point; use `(intptr_t)(a - b) < 0`.
- **Non-power-of-two ring capacity** — forces a `%` (20–40 cycles with a dependency stall) instead of a free mask.
- **Head and tail on the same cache line.** Turns a wait-free SPSC queue into a coherence-bound one.
- **Not caching the opposite index** in SPSC — a coherence miss per operation.
- **Blocking, allocating, or doing I/O inside an epoch/RCU read section** — pins the epoch and grows memory without bound.
- **Relaxing the hazard-pointer announce store** without an asymmetric barrier — the store→load window reopens and the node can be freed underneath you.
- **A seqlock reader without an acquire fence between the payload copy and the second sequence load** — works on x86, broken on ARM.
- **A seqlock with a large payload** — retry probability rises with write duration; use a double-buffer with an atomic index instead.
- **`size()`/`empty()` on a lock-free queue treated as authoritative** — not linearizable; the value may correspond to no state the queue ever had.
- **Padding everything.** 64× memory and cache-line inflation; pad only contended objects, and try field reordering first.
- **Padding to fix true sharing.** Does nothing; shard instead.
- **Testing only on x86 and only under low contention.** Missing barriers are invisible on TSO, and contention-dependent bugs need stress plus a model checker.
- **Relying on a mutex-free source file as proof.** `std::atomic<T>` for a non-lock-free `T` deadlocks in a signal handler and provides no cross-process atomicity in shared memory.

---

## Compact Recall Summary

**Progress.** Blocking ⊂ obstruction-free ⊂ lock-free ⊂ wait-free. Lock-free = *some* thread progresses; wait-free = *every* thread progresses in bounded steps. `fetch_add`/`exchange` are wait-free; CAS loops are lock-free. CAS has infinite consensus number, which is why it is the universal primitive. Lock-freedom buys tail-latency robustness against preemption, page faults, and priority inversion — not mean throughput.

**Correctness.** Linearizability: each operation takes effect at one instant between invocation and response; name the **linearization point** (usually one atomic instruction) and show the release/acquire edge that makes prior writes visible to whoever observes it. Linearizability composes; sequential consistency does not. `size()`/`empty()` are usually not linearizable, so expose `try_pop(T&)` rather than `front()` + `pop()`.

**SPSC.** One writer per index, no CAS, wait-free. `release` on publish, `acquire` on observe, relaxed on your own index. **Cache the opposite index** (avoids a coherence miss per op — the biggest single win). Power-of-two capacity for masking. Indices on separate cache lines. ~2–5 ns in cache; cross-core handoff floor is one line transfer.

**MPSC/MPMC.** MPSC: Vyukov intrusive (`exchange` head → wait-free push, brief unlinked window) or a ticketed ring (bounded, but a preempted producer stalls a slot). MPMC: Vyukov bounded ring with a **per-cell sequence number** encoding ticket + lap — bounded, allocation-free, no ABA, no reclamation, lock-free. Michael–Scott is the unbounded linked alternative and drags in allocation plus reclamation. Prefer **per-producer SPSC queues** over one contended MPSC when producers are many.

**Sequence counters.** Free-running monotonic 64-bit counters, masked only for indexing. `size` is a subtraction; unsigned wraparound is well-defined; monotonicity structurally defeats ABA. Compare with a signed difference `(intptr_t)(a-b)`, never `<`. 32-bit counters wrap in seconds at HFT rates.

**Backpressure.** `try_push` + drop accounting is the hot-path default; never block, never grow. Queue depth is a latency budget (Little's law): steady-state target is zero, the ring absorbs microbursts. Backpressure must reach the source. Batch opportunistically, never by waiting.

**Seqlocks.** One writer, many readers, small payload. Odd sequence = write in progress; a reader validates by re-reading the same even value. **Readers never write**, so reads scale perfectly — the key advantage over an `shared_mutex`. Writer wait-free, readers lock-free. The payload copy is formally racy; fix with per-word relaxed atomics plus fences. The acquire fence between the copy and the re-read is mandatory and invisible on x86.

**ABA.** A→B→A defeats CAS; ordering is irrelevant. Fixes: monotonic sequences (best), tagged pointers or DCAS, index+generation in one 64-bit word (the practical trading answer), or deferred reclamation. Tagging fixes ABA but not use-after-free — you also need type-stable memory. LL/SC is ABA-immune by construction. High-bit tagging is broken by 5-level paging, TBI, and MTE; `cmpxchg16b`/`casp` need `-mcx16`/`+lse` and a `static_assert(is_always_lock_free)`.

**Reclamation.** The core unsolved problem: you cannot ask whether a reader still holds a pointer. **Hazard pointers**: per-pointer announce + `seq_cst` store (store→load ordering is why), re-validate, retirer scans; **bounded memory**, safe with blocking readers, per-read cost — reduced to zero with `membarrier`-style asymmetric barriers. **Epochs/QSBR**: one store per critical section (zero for QSBR at an event-loop quiescent point), fastest reads, **unbounded memory** if any reader stalls. **RCU**: copy, release-publish, grace period, free; `rcu_dereference` is `consume`; writers serialize under a mutex. `std::hazard_pointer` and `std::rcu_*` land in **C++26**; today use folly, libcds, or liburcu. The best scheme is none: preallocate a slab, use 32-bit index + generation handles.

**Sharing.** False sharing = unrelated data on one line → coherence ping-pong, ~40–100 ns per access, throughput *falling* with core count and no visible lock contention. Diagnose with `perf c2c` (HITM by line and offset) and `pahole`. Fix with field reordering first, then `alignas(64)` (which also rounds `sizeof` up). `hardware_destructive_interference_size` is ABI-fragile (GCC warns); 64 usually, 128 on Apple Silicon and with adjacent-line prefetch. **Padding never fixes true sharing** — shard per core and aggregate on read. Pad the contended, not the many.
