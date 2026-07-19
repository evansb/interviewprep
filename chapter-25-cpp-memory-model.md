# Chapter 25 — C++ Memory Model

*Interview-focused revision notes. The theme: the memory model is a contract that lets the compiler and the CPU reorder everything they like, while giving you a small, precise vocabulary — happens-before — for the places where you need them not to. Every ordering primitive in this chapter is a purchase of that guarantee, and every one has a price on the machine.*

---

## 25.1 Data Races

A **data race** occurs when two accesses to the same *memory location* from different threads conflict — at least one is a write — and neither happens-before the other (§25.11), and neither is an atomic operation. A data race is **undefined behavior**, full stop. Not "an unspecified value"; UB, with the usual time-travelling consequences.

**Memory location** is a term of art (Ch. 3 §3.4): a scalar object, or a maximal sequence of adjacent bit-fields of non-zero width. Two threads writing distinct members of a struct is *not* a race — the memory model guarantees that separate scalar members are separately addressable, which forbids the compiler from implementing `s.a = 1` as a read-modify-write of a wider word containing `s.b`. That guarantee cost real work in compilers; pre-C++11, GCC would happily widen a byte store on some targets and silently corrupt an adjacent field. But two threads writing *adjacent bit-fields* **is** a race, because they share one memory location.

```cpp
struct S { char a; char b; };            // a and b are distinct memory locations — no race
struct T { unsigned a : 4; unsigned b : 4; };  // one memory location — RACE
struct U { unsigned a : 4; unsigned : 0; unsigned b : 4; };  // :0 splits them — no race
```

### Why it is UB and not merely "torn"

Because the compiler is permitted to assume race-freedom, it can perform transformations that are visibly insane in the presence of a race:

- **Load hoisting out of a loop.** `while (!flag) {}` with a non-atomic `flag` legally becomes `if (!flag) for(;;);` — an infinite loop, the single most common real-world manifestation.
- **Speculative stores / store-to-load forwarding across branches.** A compiler may write a value to a location and then write back the original, which is invisible in a single-threaded program and catastrophic in a racy one. C++11 explicitly banned *introducing* writes to objects that would not otherwise be written, precisely to make this safe — but only for objects that were not going to be written anyway.
- **Register promotion.** Two reads of a shared variable can yield different values, or the same stale value forever.

### The interview framing

"What exactly is wrong with `bool done;` polled by one thread and set by another?" The weak answer is "you might not see the update." The strong answer: it is a data race, therefore UB, therefore the compiler may hoist the load and produce an infinite loop; the fix is `std::atomic<bool>` (even `memory_order_relaxed` removes the UB), not `volatile` (§25.20).

### Tooling

**ThreadSanitizer** (`-fsanitize=thread`, Ch. 44) is the only practical detector. It is a *dynamic* happens-before tracker: it maintains vector clocks per thread and shadow state (typically 4 shadow words) per 8 bytes of application memory, and reports a race when two conflicting accesses are unordered. Costs ~5–15× CPU and ~5–10× memory. Crucially it reports races on *executed, interleaved* code only — it finds no race if the schedule never interleaves — so pair it with stress testing (Ch. 57). It also does not understand inline assembly or hand-rolled atomics via `volatile`, which is another reason not to write them. Helgrind is the Valgrind equivalent and much slower; `-fsanitize=thread` is incompatible with ASan in the same binary.

---

## 25.2 Atomic Types and Lock Freedom

`std::atomic<T>` (C++11, `<atomic>`) makes operations on `T` indivisible and gives them an ordering parameter. Requirements on `T`: **trivially copyable**, copy-constructible, and copy-assignable (Ch. 3 §3.5). Since C++20 it must also not be a reference or a function type, and `std::atomic<T>` for floating-point gained `fetch_add`/`fetch_sub`.

```cpp
std::atomic<int> a{0};          // C++17: brace-init works, and atomic_int a = 0 is fine
a.store(1, std::memory_order_release);
int v = a.load(std::memory_order_acquire);
a += 1;                          // operator overloads are ALL seq_cst — a common accidental cost
```

That last line is worth internalising: every operator overload on `std::atomic` (`++`, `+=`, `=`, implicit conversion to `T`) uses `memory_order_seq_cst`. Writing `counter++` on a hot statistics counter buys you a `lock xadd` *with* full-fence semantics on x86 (which is the same instruction, so free there) but a `ldaxr/stlxr` loop with full barriers on ARM (which is not free). Use `fetch_add(1, std::memory_order_relaxed)` explicitly.

### Lock freedom

An atomic is **lock-free** if operations on it are implemented without a mutex. When the hardware has no suitable instruction, the implementation falls back to a **lock table**: a static array of mutexes indexed by a hash of the object's address.

| Query | Kind | Meaning |
|---|---|---|
| `a.is_lock_free()` | member, runtime | Is *this object* lock-free (may depend on alignment) |
| `std::atomic<T>::is_always_lock_free` | static `constexpr` (C++17) | Lock-free for every object of this type, on this platform. Usable in `static_assert`/`if constexpr`. |
| `ATOMIC_INT_LOCK_FREE` etc. | macro | 0 = never, 1 = sometimes, 2 = always. Preprocessor-usable. |

Consequences of the lock-table fallback, all interview-grade:

- **It is not async-signal-safe.** A signal handler that touches a non-lock-free atomic can deadlock against the interrupted code holding the same table mutex. `std::atomic_signal_fence` and lock-free atomics are the only safe options in handlers (Ch. 33).
- **It provides no cross-process atomicity.** In shared memory the lock table lives in each process's own address space (Ch. 3 §3.12). `static_assert(std::atomic<T>::is_always_lock_free)` is mandatory for any shared-memory structure.
- **It is not "wait-free" or even predictable** — you inherit mutex tail latency on a supposedly lock-free path.

On x86-64, lock-free sizes are 1, 2, 4, 8 bytes always, and 16 bytes via `cmpxchg16b` — but only if the compiler emits it. GCC and Clang historically made `std::atomic<16-byte>` **not** lock-free by default because `cmpxchg16b` performs a *write* even on a pure load, which breaks `atomic<T>` loads from read-only memory; they call `libatomic` instead. `-mcx16` (and, on newer Clang, `-mcx16` plus the `__atomic_always_lock_free` path) restores it. On AArch64 you need LSE (`-march=armv8.1-a` or `+lse`) for `casp` to make 16-byte atomics lock-free. This mismatch — `is_lock_free()` returning false on a machine that clearly has the instruction — is a classic "have you actually shipped this?" question.

**Cost model.** A lock-free atomic RMW is a cache-coherence operation: it requires the line in **Exclusive/Modified** state (Ch. 28), so an uncontended one costs roughly an L1 hit plus pipeline serialization (~20 cycles on x86 for a `lock` prefix), and a contended one costs a cache-line transfer (~40–100 ns cross-socket). Contention cost is dominated by the coherence traffic, not by the instruction.

---

## 25.3 `std::atomic_ref`

`std::atomic_ref<T>` (C++20) applies atomic operations to an object that is *not* declared `std::atomic`. It solves the problem that `std::atomic<T>` changes the type — you cannot put `std::atomic<double>` in an array you also want to `memcpy`, hand to BLAS, or DMA to a NIC.

```cpp
alignas(64) double data[N];              // plain array; bulk-copyable, vectorizable
{
    std::atomic_ref<double> r{data[i]};  // for this scope, accesses through r are atomic
    r.fetch_add(x, std::memory_order_relaxed);
}
// outside any atomic_ref, plain non-atomic access is legal again
```

Rules that matter:

- **While any `atomic_ref` to an object exists, all accesses to that object must go through an `atomic_ref`.** A plain read concurrent with an `atomic_ref` write is still a data race. The type does not protect you; the discipline does.
- The referenced object must be aligned to `std::atomic_ref<T>::required_alignment`, which can be **stricter than `alignof(T)`**. For `atomic_ref<long double>` or a 16-byte struct this bites. Misalignment is UB, and on x86 a misaligned atomic RMW triggers a **split lock** — a bus lock that stalls every core for microseconds (Ch. 3 §3.3, Ch. 29).
- `atomic_ref` is trivially copyable and cheap; constructing one emits no code.
- It does not extend lifetime and does not own anything. Dangling `atomic_ref` is the same hazard as a dangling reference.

**Why low-latency people care.** It lets you keep a hot structure in its natural, cache-friendly, ABI-stable layout and reach for atomicity only where needed. Typical use: a sequence counter embedded in a market-data slot (Ch. 26 §26.9), or a per-core statistics array that is aggregated non-atomically at shutdown. Before C++20 the same effect required `__atomic_load_n`/`__atomic_fetch_add` GCC builtins, which is still what you will find in older codebases and is exactly equivalent.

`std::atomic_ref<T*>` and const-ness: `atomic_ref<const T>` is ill-formed pre-C++26 discussion; you need a mutable object. Also note `atomic_ref` on a *subobject* is fine, but two `atomic_ref`s to adjacent sub-`int` fields are still one memory location if they are bit-fields (§25.1).

---

## 25.4 Atomic Read-Modify-Write Operations

An **RMW** reads, computes, and writes back as one indivisible step, with the critical extra guarantee that it reads **the last value in the modification order** preceding its own write (§25.12) — there is no gap in which another thread's write can be lost.

| Operation | x86-64 | AArch64 (LSE) | AArch64 (pre-LSE) |
|---|---|---|---|
| `fetch_add` | `lock xadd` | `ldadd` | `ldxr`/`add`/`stxr` retry loop |
| `exchange` | `xchg` (implicitly locked) | `swp` | `ldxr`/`stxr` loop |
| `compare_exchange` | `lock cmpxchg` | `cas` | `ldxr`/`cmp`/`stxr` loop |
| `fetch_or/and/xor` | `lock or` (no return value) / `cmpxchg` loop (with) | `ldset`/`ldclr`/`ldeor` | `ldxr`/`stxr` loop |
| `fetch_max/min` (C++26) | `cmpxchg` loop | `ldsmax`/`ldumax` | loop |

Details that separate candidates:

- **`fetch_or` whose result is discarded** compiles to a single `lock or` on x86; if you use the returned old value the compiler must emit a `cmpxchg` loop, because `lock or` does not return the old value. Same for `and`/`xor`. Writing `if (flags.fetch_or(BIT) & BIT)` is meaningfully more expensive than `flags.fetch_or(BIT);`. Test-and-set of a single bit is better expressed with `bts`-style intrinsics or `exchange` on a dedicated byte.
- **`lock` prefix is a full barrier on x86** — `mfence`-equivalent. So on x86, `fetch_add(1, relaxed)` and `fetch_add(1, seq_cst)` emit *identical* code. Relaxed is still correct to write: it documents intent and costs less on ARM/POWER. This is the "x86 gives you sequential consistency for free on RMWs" point.
- **On pre-LSE ARM, an RMW is a retry loop** (`ldxr`/`stxr`), which can *livelock* under heavy contention because the exclusive monitor keeps getting cleared. LSE (ARMv8.1) atomics (`ldadd`, `cas`, `swp`) are single instructions executed at the point of coherence, which is why they scale dramatically better on many-core ARM (Graviton, Ampere). Compile with `-march=armv8.2-a+lse` or `-moutline-atomics` (GCC 10+, which runtime-dispatches).
- **`atomic_flag`** is the only type guaranteed lock-free on every implementation, with `test_and_set`/`clear` (and `test` since C++20). It is the primitive a spinlock is built on.
- **Contention behaviour.** All RMWs on the same line serialize: N threads incrementing one counter is O(N) cache-line transfers, and throughput *decreases* with core count. The fix is per-core sharded counters aggregated on read (Ch. 59), not a cleverer atomic.

---

## 25.5 Compare-Exchange Loops

`compare_exchange_weak/strong(expected, desired, success_order, failure_order)` atomically compares the atomic's value against `expected`; on match it stores `desired` and returns `true`; on mismatch it **writes the actual current value into `expected`** and returns `false`. That in-out parameter is what makes the canonical loop free of a redundant reload:

```cpp
// Atomic fetch-and-apply for an arbitrary function
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

Rules and traps:

- **`success_order` must be no weaker than `failure_order`** (this was a hard error pre-C++17; C++17 relaxed the requirement so the failure order merely may not be `release`/`acq_rel`). Failure is a *load*, so `release` on failure is meaningless.
- **The failure order is what applies on the load when the CAS fails.** People routinely write `compare_exchange_weak(e, d, acq_rel)` with a single argument, which silently gives `acq_rel` on failure too — legal, but on ARM that means paying an acquire barrier on every failed spin.
- **Comparison is by object representation, not `operator==`.** Padding bytes break CAS permanently (Ch. 3 §3.2); a `struct{char;int;}` in an atomic can loop forever. C++20 requires implementations to zero padding on atomic stores and to ignore padding in compare-exchange for some cases, but the guarantee is thin — assert `std::has_unique_object_representations_v<T>`.
- **Floating point breaks CAS too**: `+0.0` and `-0.0` compare equal but differ bitwise, and NaN never compares equal to itself yet CAS may succeed on identical bits. CAS on floats is bit-comparison; reason about bits.
- **The loop is not wait-free** (Ch. 26 §26.1). It is lock-free: some thread always makes progress, but any *given* thread can starve.

### Backoff

Under contention, a naked CAS loop generates maximum coherence traffic. The standard pattern is *test-then-CAS with backoff*: spin on a relaxed load until the value looks winnable (a plain load keeps the line in Shared state and generates no invalidations), then attempt the CAS; on repeated failure, exponential backoff with `_mm_pause()` / `__builtin_ia32_pause` (x86 `PAUSE`, ~30–140 cycles depending on microarchitecture — Skylake lengthened it dramatically) or `__yield()` (`YIELD` on ARM, effectively a hint), then `std::this_thread::yield()`, then park via `atomic::wait` (Ch. 24). `PAUSE` also avoids the memory-order-violation machine clear on x86 when exiting a spin loop, which is its original purpose.

---

## 25.6 Spurious Compare-Exchange Failure

`compare_exchange_weak` may return `false` **even when the comparison succeeded**. `compare_exchange_strong` may not.

The reason is the **LL/SC** (load-linked / store-conditional) implementation used by ARM (pre-LSE), POWER, RISC-V, and MIPS. `ldxr` establishes an exclusive monitor on the address; `stxr` succeeds only if no other core wrote the line, *and* is permitted to fail for unrelated reasons:

- Any other write to the same **cache line** (false sharing, §26.16) — the monitor granularity is typically a line, not a word.
- A context switch, interrupt, or page fault between the LL and SC.
- Some implementations clear the monitor on any `ldxr` to a different address, or on certain instructions.

`compare_exchange_strong` on such a machine must wrap the LL/SC in an *extra* retry loop to filter out spurious failures. Therefore:

| Use | Choose |
|---|---|
| Inside a loop you were going to retry anyway | **`weak`** — the outer loop absorbs spurious failure for free |
| A single, non-looping attempt whose result you branch on | **`strong`** — otherwise you must hand-write the filtering loop |
| x86-64 | Identical code either way (`lock cmpxchg` cannot fail spuriously); the distinction is portability-only |

The performance difference is real only on LL/SC targets, where `weak` inside a loop saves one branch and one nested loop per iteration. Getting this right is cheap and is a standard interview probe: *"Why does `compare_exchange_weak` exist?"* — because on LL/SC hardware, `strong` costs an extra loop, and most callers are already in a loop.

A related subtlety: after a *spurious* failure, `expected` is still updated (to the value read), so a loop written as above is correct in either case. And note that a spurious failure is indistinguishable from a real one at the API level, which is precisely why you must not put side effects in the failure branch.

---

## 25.7 Sequential Consistency

**Sequential consistency (SC)** — Lamport, 1979 — means the execution behaves as if there were a **single total order** over all operations, consistent with each thread's program order. `memory_order_seq_cst` is the default for every `std::atomic` operation and every operator overload.

Formally, C++ guarantees a single total order **S** over all `seq_cst` operations, and that order is consistent with happens-before and with each object's modification order. Every `seq_cst` load reads either the last `seq_cst` write to that object in S, or some non-`seq_cst` write that does not happen-before it.

The canonical demonstration is **Store Buffer / Dekker**:

```cpp
std::atomic<int> x{0}, y{0}; int r1, r2;
// T1:  x.store(1);  r1 = y.load();
// T2:  y.store(1);  r2 = x.load();
```
With `seq_cst`, `r1 == 0 && r2 == 0` is **impossible**. With `release`/`acquire` — or `relaxed` — it is **possible**, on real hardware, on x86. This is the litmus test that proves acquire/release is strictly weaker than SC and is not merely a compiler-barrier distinction (§25.19).

### Cost

| Platform | `seq_cst` store | `seq_cst` load | acq/rel store/load |
|---|---|---|---|
| x86-64 | `xchg` (or `mov`+`mfence`) — **~20–40 cycles** | plain `mov` — **free** | plain `mov` both ways — free |
| AArch64 (v8.0) | `dmb ish; str; dmb ish` or `stlr` | `ldar` + trailing `dmb` in some mappings | `stlr` / `ldar` — cheaper |
| AArch64 (v8.3 RCpc) | `stlr` | `ldapr` | `ldapr`/`stlr` |
| POWER | `hwsync` (`sync`) — expensive | `sync; ld; cmp; bc; isync` | `lwsync` — much cheaper |

The asymmetry on x86 is the single most quoted fact in this area: **SC loads are free, SC stores cost a fence**. x86-TSO (Ch. 29) already forbids all reorderings except store→load, so only the store side needs a barrier to drain the store buffer. GCC and Clang put the fence on the *store* (using `xchg`, which is a locked instruction and therefore a full barrier, and is faster than `mov;mfence` on most microarchitectures). This mapping choice is ABI-visible: you may not mix objects compiled with a store-fence mapping and a load-fence mapping.

**When to actually use `seq_cst`:** when you need multi-variable, multi-thread agreement on ordering — Dekker-style mutual exclusion, or "at least one of us must see the other's flag" handoffs. Almost every producer/consumer, reference count, and publication pattern needs only release/acquire. Default to `seq_cst` while writing correct code; downgrade with measurement and a proof. On x86 the downgrade often buys nothing except on stores.

---

## 25.8 Acquire and Release Ordering

The workhorse pair. Definitions first:

- **Release store** (`memory_order_release` on a store or RMW): no memory operation *preceding* it in program order may be reordered *after* it. It is a **one-way barrier downward** — later operations may move up past it.
- **Acquire load** (`memory_order_acquire` on a load or RMW): no memory operation *following* it may be reordered *before* it. A **one-way barrier upward**.

```
     T1 (producer)                 T2 (consumer)
  data = 42;              ─┐
  ready.store(1, release); │ release   while(!ready.load(acquire));  ─┐ acquire
                           │ ...................................      │
                                                    read data == 42  ─┘
```

When an acquire load **reads the value written by** a release store (or a value later in that store's *release sequence*, §25.13), the two operations **synchronize-with** (§25.11), and everything sequenced before the store in T1 happens-before everything sequenced after the load in T2. That is the whole mechanism of safe publication.

Critical correctness points:

1. **Synchronization requires the read to observe the write.** A release store that nobody reads synchronizes with nothing. An acquire load that reads a *different, older* value synchronizes with nothing — which is why the `while(!ready)` loop is not optional decoration; the acquire only "fires" on the iteration that sees `1`.
2. **`acq_rel`** applies both to a single RMW: it acquires from the value it reads and releases to whoever reads its write. Use it for `fetch_sub` on a reference count, or for a lock's `exchange`.
3. **Release/acquire is pairwise and transitive** through the happens-before graph, but it is **not** globally ordered like `seq_cst`: IRIW (Independent Reads of Independent Writes) allows two observers to disagree about the order of two independent release stores. On x86 and ARMv8 this is actually not observable (both are multi-copy-atomic), but POWER permits it and the standard permits it.

### Cost

| Platform | Acquire load | Release store |
|---|---|---|
| x86-64 | plain `mov` (free — TSO already gives it) | plain `mov` (free) |
| AArch64 | `ldar` (or `ldapr` with RCpc) | `stlr` |
| POWER | `ld; cmp; bc; isync` or `lwsync` after | `lwsync` before `st` |
| RISC-V | `fence r,rw` after load / `lr.aq` | `fence rw,w` before store |

On x86, acquire/release is **free at the instruction level** — the only effect is on the *compiler*, which must not reorder across it. This is why x86-only benchmarks show no difference between relaxed and acquire/release and lull people into false confidence: the same code deadlocks or corrupts on ARM. Always reason about ordering as if you were on ARM; validate on ARM if you ship there.

**AArch64 detail worth knowing:** `stlr` is a *sequentially consistent* release in ARMv8 (it orders against subsequent `ldar` too), so on AArch64 the gap between `release` and `seq_cst` stores is smaller than on POWER. `ldapr` (ARMv8.3 RCpc) is the true "acquire only" load and is cheaper than `ldar`; compilers emit it under `-march=armv8.3-a`.

---

## 25.9 Relaxed Ordering

`memory_order_relaxed` guarantees **atomicity and modification-order consistency, and nothing else**. There is no ordering with respect to any other memory operation. The compiler and CPU may reorder relaxed operations freely relative to surrounding code (subject only to data/control dependencies and to the per-object rules of §25.12).

What relaxed *does* still guarantee:

- The operation is indivisible: no tearing, no half-written values.
- Each atomic object has a single **modification order** that all threads agree on, and relaxed operations respect it: you never see a value "go backwards" for a *single* object in a single thread (coherence, §25.12).
- No UB — a relaxed race is not a race at all.
- Reads eventually see writes ("should become visible in a finite period of time" — a *recommendation*, not a requirement, and unenforceable; in practice hardware cache coherence makes it microseconds).

Legitimate uses:

```cpp
// 1. Statistics / counters whose value is only read after joining.
packets.fetch_add(1, std::memory_order_relaxed);

// 2. Reference-count INCREMENT — you already hold a reference, so nothing to order.
refcount.fetch_add(1, std::memory_order_relaxed);

// 3. A "stop" flag polled in a loop where the exact iteration doesn't matter.
while (!stop.load(std::memory_order_relaxed)) { work(); }

// 4. Sequence-number allocation in an SPSC/MPMC ring, where a separate
//    release/acquire on the slot state carries the data (Ch. 26 §26.6).
auto pos = head.fetch_add(1, std::memory_order_relaxed);
```

Case 2 has the famous asymmetry: the increment is relaxed, the **decrement must be `acq_rel`** (or release + an acquire fence before destruction), because the thread that drops the count to zero must see all writes made by every other owner before it destroys the object. `libstdc++`'s `shared_ptr` does exactly this (Ch. 9 §9.3).

### The trap

Relaxed does not mean "eventually ordered" or "ordered on x86 so who cares." Two relaxed operations on *different* objects have no cross-thread ordering whatsoever, and compilers do exploit it: a relaxed load may be hoisted out of a loop (it is not `volatile`), CSE'd with an earlier relaxed load, or sunk past unrelated stores. The `while (!stop.load(relaxed)) work();` pattern above is only safe because `work()` is opaque to the compiler; if the loop body were empty, the compiler could hoist the load and spin forever — legally.

The other subtlety is **out-of-thin-air (OOTA) values**. The C++11 wording technically permitted a self-justifying cycle where two relaxed loads each read a value that only exists because the other wrote it. No implementation produces this, and C++ has since added a prohibition on such cycles (informally: relaxed atomics must not manufacture values from nowhere), but the formal model remains an open research problem. Mentioning OOTA signals real depth.

---

## 25.10 Consume Ordering

`memory_order_consume` was designed as a cheaper acquire for **pointer-chasing publication**. Where acquire orders the load against *all* subsequent operations, consume orders it only against operations that are **data-dependent** on the loaded value — the *carries-a-dependency* relation.

```cpp
std::atomic<Config*> cfg;
// Producer:
auto* p = new Config{...};
cfg.store(p, std::memory_order_release);
// Consumer:
Config* q = cfg.load(std::memory_order_consume);
int v = q->field;    // data-dependent on q → ordered by consume
int w = other;       // NOT dependent → NOT ordered
```

The motivation is hardware: on every architecture except the long-dead Alpha, a load whose address depends on a previous load is *automatically* ordered by the CPU — the second load cannot issue before it has the address. So consume should compile to **zero barriers** on ARM and POWER, exactly matching acquire's semantics for the dependent case at zero cost. This is precisely what the Linux kernel's `rcu_dereference` exploits (§26.14).

**Why it failed.** Tracking dependency chains through arbitrary optimized code is beyond what compilers can do: the compiler must not break the chain via value-range propagation (`if (q == known) use(known)` destroys the dependency), CSE, or branch conversion. Rather than implement it, **every mainstream compiler promotes `consume` to `acquire`**, which is correct but throws away the entire benefit. C++17 formally *discourages* its use (P0371), and P0750/P0190 proposed replacements (`[[carries_dependency]]`-free "dependency-preserving" types) have not landed. As of C++23/26 the status is unchanged.

**Interview answer:** consume exists to make RCU-style pointer publication free on weakly ordered hardware, but no compiler implements it — they all upgrade it to acquire — so use `acquire` and know why. If you need the real thing (kernel RCU), you get it with a relaxed load plus a hand-maintained dependency chain and a compiler barrier, plus the knowledge that only Alpha needed a real fence (and Alpha is gone).

---

## 25.11 Happens-Before and Synchronizes-With

This is the definitional core of the chapter. Build it up in order:

**Sequenced-before** — intra-thread program order as constrained by evaluation rules (Ch. 4 §4.2). Not a total order within a thread, because some subexpressions are unsequenced.

**Synchronizes-with** — a cross-thread edge. Created when:
- An **acquire** operation reads a value written by a **release** operation on the same atomic (or a value in its release sequence, §25.13).
- Fence-based variants (§25.15).
- `std::thread` construction synchronizes-with the start of the new thread's execution; the thread's completion synchronizes-with the return from `join()`.
- Mutex `unlock()` synchronizes-with a subsequent `lock()` that acquires it (Ch. 24).
- `promise::set_value` synchronizes-with `future::get`; `call_once` completion with subsequent `call_once` returns; latch `count_down` with `wait`; semaphore `release` with `acquire`.

**Dependency-ordered-before** — the consume analogue (§25.10).

**Inter-thread happens-before** — the transitive closure combining synchronizes-with, dependency-ordered-before, and sequenced-before across threads.

**Happens-before** — sequenced-before ∪ inter-thread happens-before. If A happens-before B and they conflict, there is no data race and B sees A's effect (or a later one).

```
Thread A                        Thread B
--------                        --------
data = 42;          ┐ sequenced-before
flag.store(1, rel); ┘   ───── synchronizes-with ─────► flag.load(acq) == 1  ┐ sequenced-before
                                                       read data           ┘
      ⇒ (data = 42)  happens-before  (read data)   ⇒  reads 42
```

### The three things people get wrong

1. **Happens-before is not a time relation.** It says nothing about wall-clock order. Two operations can be unordered by happens-before yet strictly ordered in time, and that is exactly the racy case. Conversely, "it always happens first in practice" gives you nothing.
2. **Happens-before is a partial order, not a total one**, and it is *not transitive through unrelated atomics* the way people assume. If T1 releases on `x` and T2 acquires `x` then releases `y`, and T3 acquires `y`, then T1's writes are visible to T3 — that *is* transitive, because the chain is release→acquire→release→acquire on the same objects. But two independent release stores with no chaining give you nothing.
3. **`seq_cst` adds a total order S over seq_cst operations, on top of happens-before**, not instead of it. The famous defect (fixed by P0668, C++20) was that the original wording made SC and acquire/release interact incorrectly, and implementations were unsound on POWER; C++20 tightened it.

### Why this matters for interviews

Every ordering question reduces to: *"draw the happens-before edge."* If you cannot name the release, the acquire, and the fact that the acquire read the release's value, there is no edge and the code is racy. That framing answers double-checked locking, safe publication, seqlocks, and hazard pointers uniformly.

---

## 25.12 Modification Order and Coherence

Every atomic object has a **modification order**: a total order over all writes to *that object*, agreed upon by all threads. This exists even for `relaxed` operations and even in the absence of any happens-before edge. It is the hardware cache-coherence guarantee lifted into the language.

From it derive four **coherence rules**, all guaranteed regardless of memory order:

| Rule | Statement |
|---|---|
| **Write-write coherence** | If write A happens-before write B, A precedes B in the modification order. |
| **Read-read coherence** | If read A happens-before read B (same object), B reads the same or a later write in the modification order. No "going backwards in time" for one object in one thread. |
| **Read-write coherence** | If read A happens-before write B, A reads a write earlier than B in the modification order. |
| **Write-read coherence** | If write A happens-before read B, B reads A or a later write. |

Consequences worth stating out loud:

- A thread that reads `1` from a counter and then reads again cannot see `0`, ever, for *that single atomic object* — with any memory order. Monotonic per-object visibility is free.
- But there is **no such guarantee across two objects**. Thread T can see `x == 1, y == 0` while thread U sees `x == 0, y == 1`, with relaxed or even release/acquire (this is IRIW; forbidden only under `seq_cst`).
- **RMWs read the immediately preceding value in the modification order**, which is the property that makes `fetch_add` a correct counter with `relaxed`: no increment can be lost, even with zero ordering. This is the single best justification for relaxed counters and is worth stating precisely.

The distinction people miss: **atomicity + coherence ≠ ordering**. Relaxed gives you the first two completely. Ordering is what you pay for.

Hardware note: modification order per location is exactly what MESI/MOESI provides (Ch. 28) — a line has one owner in Modified state at a time, so writes to it are serialized by the coherence fabric. The C++ model is a faithful abstraction of that, which is why per-object coherence is free and cross-object ordering is not.

---

## 25.13 Release Sequences

A subtle but load-bearing rule. Synchronizes-with requires an acquire to read *the value written by* a release store. But what if other threads perform RMWs on that atomic in between? Without a special rule, a consumer that reads a *later* value would get no synchronization, and every counter-based handoff would break.

The **release sequence** headed by a release store A on atomic M is the maximal contiguous subsequence of M's modification order starting at A consisting of:
- writes performed by **the same thread** as A (C++11; **removed in C++20** by P0982 — see below), and
- **atomic read-modify-write operations by any thread**.

An acquire load that reads *any* value in this sequence synchronizes-with A.

```cpp
std::atomic<int> count{2};
// Producer thread T0:
data = 42;
count.store(0, std::memory_order_release);        // A: heads a release sequence

// T1: count.fetch_add(1, relaxed);   → value 1, still in A's release sequence
// T2: count.fetch_add(1, relaxed);   → value 2, still in the sequence
// T3: if (count.load(acquire) == 2) { read data; }   ← synchronizes-with A. Sees 42.
```

Without release sequences, T3 read a value written by T2's relaxed RMW, not by A, and would have no ordering guarantee at all. The rule is what makes counting semaphores, reference counts, and multi-consumer queues composable.

**C++20 change (P0982):** the "writes by the same thread" clause was **removed**. It existed to allow a producer to do a plain release store followed by relaxed stores and still have consumers synchronize, but it was unimplementable on POWER without extra fences and was found to be unsound. Since C++20, only **RMWs** extend a release sequence. Practical impact: a pattern of `x.store(1, release); x.store(2, relaxed);` where a consumer reads `2` no longer synchronizes. Code relying on that was already broken on POWER.

**Interview probe:** *"A relaxed `fetch_add` by an unrelated thread sits between the release store and the acquire load. Does synchronization still happen?"* — Yes, because RMWs extend the release sequence. This is one of the few genuinely obscure rules that a strong candidate knows and a good one does not.

---

## 25.14 Atomic Fences

`std::atomic_thread_fence(order)` is a standalone barrier that orders *all* memory operations around it, not just one atomic object. `std::atomic_signal_fence(order)` orders only with respect to signal handlers on the same thread — a pure compiler barrier, zero instructions.

| Fence | Meaning |
|---|---|
| `atomic_thread_fence(acquire)` | No loads/stores after may move before it; pairs with a release fence or release store |
| `atomic_thread_fence(release)` | No loads/stores before may move after it |
| `atomic_thread_fence(acq_rel)` | Both; a full barrier except it does not join the seq_cst total order |
| `atomic_thread_fence(seq_cst)` | Full barrier **and** participates in the single total order S |
| `atomic_thread_fence(relaxed)` | **No-op.** Does nothing at all. |
| `atomic_signal_fence(...)` | Compiler barrier only — no CPU instruction emitted |

Instruction mapping: `seq_cst` fence → `mfence` on x86 (~30–100 cycles; a `lock or [rsp],0` is a commonly used faster equivalent), `dmb ish` on AArch64, `sync` on POWER. Acquire/release fences on x86 emit **nothing** (compiler barrier only), because TSO already forbids the reorderings they prohibit.

### Fence vs. operation ordering — when to prefer which

A fence is **strictly stronger** than an ordered operation, because it orders everything, not just the tagged access. Prefer the ordered operation: it lets the compiler and hardware apply the barrier precisely where needed (e.g., `stlr` on ARM is cheaper than `dmb; str`).

Use a standalone fence when:

1. **Amortizing across many atomics.** Publishing N slots then one fence beats N release stores on ARM.
2. **Conditional acquire.** Spin with relaxed loads, and execute the acquire fence only once, on exit:
   ```cpp
   while (flag.load(std::memory_order_relaxed) == 0) { _mm_pause(); }
   std::atomic_thread_fence(std::memory_order_acquire);   // pay the barrier once
   ```
   On ARM this replaces N `ldar`s with N `ldr`s and one `dmb`.
3. **Interfacing with hand-written assembly or hardware/DMA**, where the ordered-load form doesn't exist.
4. **Signal handlers and single-thread/interrupt interaction** — `atomic_signal_fence` costs literally nothing and prevents compiler reordering only, which is exactly right for a handler that runs on the same core.

The seq_cst fence has a genuinely useful property no ordered operation gives you: it is the only way to get **store-load ordering** without an RMW, which is what a hand-rolled Dekker or an asymmetric barrier (e.g., `membarrier(2)` in Linux) needs.

---

## 25.15 Fence-Atomic Synchronization

Fences and ordered operations interoperate, and the exact rules are frequently examined.

**Fence–fence.** A release fence F1 in T1 *sequenced-before* a store X (any order, even relaxed), and an acquire fence F2 in T2 *sequenced-after* a load Y (any order) that reads X (or its release sequence): then F1 synchronizes-with F2.

```cpp
// T1                                    // T2
data = 42;                               while (flag.load(relaxed) == 0) {}
std::atomic_thread_fence(release);       std::atomic_thread_fence(acquire);
flag.store(1, std::memory_order_relaxed);  read data;   // sees 42
```

**Fence–atomic.** A release *fence* before a relaxed store synchronizes with an *acquire load* that reads it. Symmetrically, a *release store* synchronizes with an acquire *fence* placed after a relaxed load that reads it. All four combinations work:

| Producer | Consumer | Synchronizes? |
|---|---|---|
| release fence + relaxed store | relaxed load + acquire fence | Yes |
| release fence + relaxed store | acquire load | Yes |
| release store | relaxed load + acquire fence | Yes |
| release store | acquire load | Yes (the base case, §25.8) |

The rule to remember: **the fence must be on the correct side.** A release fence goes *before* the store; an acquire fence goes *after* the load. Putting an acquire fence before the load orders nothing useful — a classic bug, and it silently works on x86 (where both are no-ops) and fails on ARM.

**The seq_cst fence is not the same as a seq_cst operation.** A `seq_cst` fence participates in the total order S, but two relaxed stores separated by seq_cst fences do *not* give you the same guarantee as two `seq_cst` stores in every litmus test. In particular, the Store Buffer test is fixed by placing a `seq_cst` fence between each store and load:

```cpp
// T1: x.store(1, relaxed); atomic_thread_fence(seq_cst); r1 = y.load(relaxed);
// T2: y.store(1, relaxed); atomic_thread_fence(seq_cst); r2 = x.load(relaxed);
// r1 == 0 && r2 == 0 is now impossible.
```
This is exactly what a full `mfence` does on x86 and is the standard "how do I get SC cheaply where I need it and nowhere else" answer.

---

## 25.16 Compiler Barriers and CPU Fences

Two independent sources of reordering; conflating them is one of the most common conceptual errors.

| | Compiler reordering | CPU reordering |
|---|---|---|
| Cause | Optimizer: scheduling, CSE, register promotion, loop hoisting, dead-store elimination | Store buffers, out-of-order execution, cache-coherence delays, speculative loads |
| Visible on x86? | **Yes** — this is the *only* source of trouble for acq/rel on x86 | Only store→load (x86-TSO) |
| Prevented by | `asm volatile("" ::: "memory")`, `std::atomic_signal_fence`, `std::atomic` with any order ≥ relaxed on *that* object | `mfence`/`lock`-prefixed / `dmb` / `sync` — emitted by `atomic_thread_fence` and by ordered atomic ops |
| `volatile` prevents? | Reordering of *volatile accesses with each other only*; not with non-volatile accesses on MSVC's non-`/volatile:ms` mode or on GCC | **No** |

```cpp
#define COMPILER_BARRIER() asm volatile("" ::: "memory")   // GCC/Clang; _ReadWriteBarrier() on MSVC (deprecated)
```

The `"memory"` clobber tells GCC that the asm may read or write any memory, forcing it to spill live values and reload afterwards. It emits **zero instructions**. This is the right tool for: ordering against a signal handler, ordering against an interrupt on the same core, preventing the compiler from moving a timestamp read (Ch. 43 — though `rdtscp`/`lfence` is needed for CPU-level ordering too), and benchmark barriers (`benchmark::DoNotOptimize`).

**x86 as a trap.** Because x86-TSO already provides load-load, load-store, and store-store ordering in hardware, `memory_order_acquire`/`release` compile to bare `mov`s on x86. The *entire* observable effect of writing `release` instead of `relaxed` on x86 is on the compiler. Consequently, code that is missing an acquire/release but happens to have a compiler barrier will pass every x86 test and break on ARM. Test on ARM, or use `-fsanitize=thread` plus a model checker (§25.19).

**The reverse trap:** a compiler barrier is *not* a CPU barrier. `asm volatile("" ::: "memory")` before a store does nothing to drain the store buffer. Kernel code that uses `barrier()` where it needs `smp_mb()` is a real and recurring bug class.

---

## 25.17 Safe Publication

**Publication** is the act of making a newly constructed object visible to other threads. Getting it right is the single most common real use of the memory model.

```cpp
// Correct
Widget* w = new Widget(args);            // (1) all constructor writes
ptr.store(w, std::memory_order_release); // (2) release: (1) cannot move after (2)

// Consumer
if (Widget* p = ptr.load(std::memory_order_acquire))  // (3) acquire
    p->use();                                          // (4) sees a fully constructed object
```

The happens-before chain: (1) sequenced-before (2), (2) synchronizes-with (3) because (3) read (2)'s value, (3) sequenced-before (4). Therefore (1) happens-before (4).

What breaks without the pair:

- **Relaxed store**: the CPU (on ARM) or compiler may make the pointer visible before the constructor's writes. The consumer dereferences a pointer to uninitialized memory. On x86 the *hardware* won't reorder the stores, but the compiler still can — and will, if the constructor is inlined.
- **Relaxed load**: on Alpha (only) the dereference could see stale data; on other hardware the address dependency saves you, but the *compiler* can still hoist `p->field` speculatively or use value-range info to break the dependency. This is the §25.10 consume story.

### Variants

- **Publishing through a `shared_ptr`**: `std::atomic<std::shared_ptr<T>>` (C++20, §25.21) does the right thing. A plain `shared_ptr` copy is **not** thread-safe against concurrent reassignment — the control block's refcount is atomic, but the pointer pair in the `shared_ptr` object itself is not.
- **Publishing an index instead of a pointer** into a preallocated slab is the low-latency form: no allocation on the hot path (Ch. 7), no ABA from address reuse (Ch. 26 §26.10), and a 32-bit atomic instead of 64.
- **Publish-once, read-many**: consider `std::call_once` or a `constinit` table instead; the cheapest publication is the one that happened before any thread started.
- **Unpublication** is the hard direction: removing a pointer is easy, knowing when the last reader is done is §26.12–26.14.

**The mental model to state in an interview:** "the release store is a commit; everything I wrote before it is included in the commit, and any reader who observes the commit observes all of it." That framing generalizes to seqlocks, ring buffers, and RCU.

---

## 25.18 Double-Checked Locking

The canonical broken-then-fixed pattern. The intent: avoid taking a mutex on every access to a lazily initialized singleton.

```cpp
// BROKEN (pre-C++11 idiom, still seen)
if (instance == nullptr) {                  // race: non-atomic read
    std::lock_guard lk(m);
    if (instance == nullptr)
        instance = new Singleton();         // race: non-atomic write, and reordering
}
return instance;
```

Two independent bugs: (a) the outer read races with the inner write — UB; (b) even without UB, `new Singleton()` involves *allocate, construct, assign pointer*, and nothing forbids the compiler or CPU from making the pointer visible before the constructor completes. A second thread passes the outer check and returns a pointer to a half-built object. Scott Meyers and Andrei Alexandrescu's 2004 "C++ and the Perils of Double-Checked Locking" showed no amount of `volatile` fixes it, which is what motivated C++11's memory model.

```cpp
// CORRECT with atomics
std::atomic<Singleton*> instance{nullptr};
std::mutex m;
Singleton* get() {
    Singleton* p = instance.load(std::memory_order_acquire);
    if (!p) {
        std::lock_guard lk(m);
        p = instance.load(std::memory_order_relaxed);   // relaxed: mutex already orders us
        if (!p) {
            p = new Singleton();
            instance.store(p, std::memory_order_release);
        }
    }
    return p;
}
```

```cpp
// CORRECT and preferred: magic statics (C++11)
Singleton& get() { static Singleton s; return s; }
```

**Magic statics** — function-local `static` initialization is guaranteed thread-safe since C++11; the compiler emits a guard variable and calls `__cxa_guard_acquire`/`__cxa_guard_release` (Itanium ABI). The fast path after initialization is a **single relaxed load of the guard byte and a predictable branch** — essentially free, and it is what you should write. `-fno-threadsafe-statics` removes the guard (and the safety); it appears in embedded and some HFT builds where initialization is known to be single-threaded.

**Low-latency angle:** the fast path of correct DCL is one acquire load plus a well-predicted branch (~1–2 cycles on x86, since acquire is free). That is cheap, but not free: on the truly hot path, eliminate the check entirely by initializing eagerly at startup with `constinit`/`call_once` (Ch. 19, Ch. 24) and holding a plain pointer. The best DCL is no DCL.

`std::call_once` is the portable alternative; note it is not necessarily faster than magic statics (libstdc++ historically used a pthread_once path with a function call), so measure.

---

## 25.19 Memory-Model Litmus Tests

A **litmus test** is a minimal multi-threaded program plus a question about which final states are allowed. Memorize these four; they are the standard vocabulary.

**SB (Store Buffer / Dekker)** — the store→load reordering.
```
x=y=0
T1: x.store(1); r1=y.load();     T2: y.store(1); r2=x.load();
Q: r1==0 && r2==0 ?
relaxed/acq-rel: ALLOWED (and observable on x86 — this is the ONE x86 reordering)
seq_cst:          FORBIDDEN
```

**MP (Message Passing)** — the publication pattern.
```
x=f=0
T1: x=1; f.store(1,rel);        T2: while(!f.load(acq)); r=x;
Q: r==0 ?   FORBIDDEN with rel/acq.  ALLOWED with relaxed on ARM/POWER (not on x86).
```

**LB (Load Buffer)** — load→store reordering.
```
T1: r1=x.load(); y.store(1);     T2: r2=y.load(); x.store(1);
Q: r1==1 && r2==1 ?
relaxed: ALLOWED on POWER/ARM.  FORBIDDEN on x86 (TSO keeps loads before stores).
```

**IRIW (Independent Reads of Independent Writes)** — multi-copy atomicity.
```
T1: x.store(1);  T2: y.store(1);
T3: r1=x.load(); r2=y.load();    T4: r3=y.load(); r4=x.load();
Q: can T3 see x-then-y while T4 sees y-then-x?
rel/acq: ALLOWED by the C++ model, and on POWER.  Not observable on x86 or ARMv8 (both multi-copy atomic).
seq_cst: FORBIDDEN.
```

Also worth knowing: **CoRR** (read-read coherence — always forbidden to go backwards on one object, §25.12), and the **dependency-ordered MP** variant that motivates consume.

| Reordering | x86-TSO | ARMv8 | POWER | RISC-V (WMO) |
|---|---|---|---|---|
| Load → Load | No | Yes | Yes | Yes |
| Load → Store | No | Yes | Yes | Yes |
| Store → Store | No | Yes | Yes | Yes |
| Store → Load | **Yes** | Yes | Yes | Yes |
| Multi-copy atomic | Yes | Yes (v8) | **No** | Yes |
| Dependent loads ordered | Yes | Yes | Yes | Yes (Alpha: no) |

**Tooling.** `herd7`/`litmus7` from the diy suite run these against a formal model or real hardware. **CDSChecker** and **GenMC** are stateless model checkers for C11/C++11 atomics that exhaustively explore executions of a small program — the right tool for validating a lock-free queue (Ch. 26, Ch. 57). `relacy` is the older header-only alternative. TSan finds races but *not* missing-ordering bugs that only manifest on weak hardware; a model checker does.

---

## 25.20 Atomic Tearing and Alignment

**Tearing** is a read or write observing a partially-updated value — a 64-bit store seen as two 32-bit halves from different values.

Facts:

- **Non-atomic accesses may tear**, and the compiler may split them for its own reasons (e.g., storing a 64-bit constant as two 32-bit `mov`s to avoid a `movabs`, or vectorizing a struct copy). "Aligned word-sized accesses are atomic on x86" is true of the *hardware* and irrelevant, because the compiler is not required to emit a single instruction.
- **`std::atomic<T>` never tears** — that is its defining property. When `T` is larger than the widest lock-free width, the implementation uses the lock table (§25.2), which prevents tearing at the cost of lock-freedom.
- **Alignment is the precondition for hardware atomicity.** x86 guarantees atomicity only for accesses that do not cross a cache line; `std::atomic` therefore over-aligns: `alignas(8)` for `atomic<int64_t>` even on 32-bit x86 where `alignof(int64_t)` is 4, and `alignas(16)` for 16-byte atomics.
- **A misaligned `lock`-prefixed instruction on x86 causes a split lock**: the CPU cannot use cache-line locking and asserts a **bus lock**, serializing the entire system for microseconds. Linux exposes `split_lock_detect=warn|fatal` (kernel 5.7+) and a `#AC` trap for it; on a trading box a single split lock can blow a tail-latency budget by orders of magnitude. This is the highest-severity alignment bug in this chapter.
- **AArch64 faults outright** on misaligned exclusives/atomics rather than silently degrading.
- **Bit-fields and packed structs** are where misaligned atomics come from in practice — `atomic_ref` on a member of a `#pragma pack(1)` struct is UB.

```cpp
static_assert(alignof(std::atomic<uint64_t>) == 8);
static_assert(std::atomic<Slot>::is_always_lock_free);
static_assert(std::has_unique_object_representations_v<Slot>);   // no padding → CAS works
```

**Wide atomics.** A 16-byte atomic (pointer + tag, §26.11) needs `cmpxchg16b` on x86 (`-mcx16`) or `casp` on ARM with LSE. Note `cmpxchg16b` requires the operand to be 16-byte aligned and clobbers `rbx`/`rcx`, which is why it is expensive to inline. If `is_always_lock_free` is false, you have a mutex hiding in your "lock-free" queue.

---

## 25.21 `volatile` Is Not Synchronization

`volatile` means exactly one thing in C++: **the compiler may not elide, duplicate, reorder-with-other-volatiles, or cache accesses to this object**. It exists for memory-mapped I/O, `setjmp`-surviving variables, and variables modified by a signal handler on the same thread (where `volatile sig_atomic_t` is the standard-blessed type).

What `volatile` does **not** provide:

| Property | `volatile` | `std::atomic` |
|---|---|---|
| Prevents compiler eliding/caching the access | Yes | Yes |
| Prevents reordering with **non-volatile** accesses | **No** | Yes (with order ≥ acquire/release) |
| Emits CPU memory barriers | **No** | Yes where needed |
| Guarantees indivisibility (no tearing) | **No** | Yes |
| Makes RMW (`v++`) atomic | **No** — it is load, add, store | Yes |
| Removes the data race (UB) | **No** | Yes |

`volatile int x; x++;` is three separate accesses and is a data race. On MSVC with `/volatile:ms` (the default for x86/x64, for legacy compatibility) volatile *does* imply acquire/release semantics — which is why so much Windows code "works" and is unportable. `/volatile:iso` gives standard behaviour; ARM MSVC defaults to `iso`.

**The legitimate combination** is `volatile std::atomic<T>` — used when a location is both concurrently accessed *and* externally modified (memory-mapped device registers shared with a DMA engine). Rare. Also legitimate: `std::atomic<T>` with `volatile`-qualified member functions, which the standard provides for exactly this.

**Low-latency note.** People reach for `volatile` in spin loops to force a reload. Use `std::atomic<T>` with `memory_order_relaxed` instead — it forces the reload, removes the UB, and on x86 emits the identical `mov`. There is no performance argument for `volatile` here. The one place a `volatile` cast survives in modern hot-path code is in benchmark barriers (`DoNotOptimize`), and even there the inline-asm form is preferred (Ch. 43).

C++20 deprecated several `volatile` uses (compound assignment on volatile scalars, volatile function parameters and return types) via P1152, precisely because they gave a false impression of atomicity. C++23 un-deprecated compound assignment for the embedded community.

---

## 25.22 Atomic Shared Pointers

Concurrent `shared_ptr` is the place where the memory model meets Ch. 9. The rules:

- The **control block's reference count is atomic**. Multiple threads may copy, destroy, and use *distinct `shared_ptr` objects* pointing to the same control block without synchronization.
- The **`shared_ptr` object itself is not atomic** — it is two pointers (object, control block). Concurrently reading one `shared_ptr` while another thread assigns to it is a data race: the reader may see a mismatched pair, or increment a control block that is being destroyed.

C++11 provided free-function overloads `std::atomic_load(&sp)`, `std::atomic_store(&sp, v)`, `std::atomic_compare_exchange_*`. These are **deprecated in C++20 and removed in C++26**. They were typically implemented with a **spinlock table** keyed on the `shared_ptr`'s address — not lock-free, and easy to misuse (nothing stopped a plain access to the same object).

**C++20:** `std::atomic<std::shared_ptr<T>>` and `std::atomic<std::weak_ptr<T>>` (P0718). Type-safe, supports `load`, `store`, `exchange`, `compare_exchange_*`, `wait`/`notify`. `is_lock_free()` is **almost always false** in practice: libstdc++ uses the low bits of the pointer as a spinlock; libc++ used a mutex. A genuinely lock-free implementation requires split reference counts or DCAS.

```cpp
std::atomic<std::shared_ptr<Config>> cfg;
// Writer (rare):
cfg.store(std::make_shared<Config>(newValues));   // release semantics by default
// Reader (hot):
auto snapshot = cfg.load();      // returns a shared_ptr with an incremented count
snapshot->field;                 // safe: the snapshot owns a reference
```

Why the read is expensive: `load()` must atomically read the pointer *and* increment the refcount — two words, no DCAS on most platforms — so it takes the internal spinlock, performs an atomic increment on a shared control block (a contended cache line), and releases. Under N readers this is O(N) cache-line bounces on a line all of them touch. Measured cost is often **50–200 ns per read under contention**, versus ~1 ns for a relaxed pointer load.

**Low-latency verdict.** Do not put `atomic<shared_ptr>` on a tick-to-trade path. Alternatives, in increasing order of complexity:

| Approach | Read cost | Notes |
|---|---|---|
| Immutable config published once at startup | 0 | Best answer when applicable |
| Double-buffer + `atomic<uint32_t>` index, readers pinned, writer waits a grace period | 1 relaxed load | Needs a quiescence scheme |
| RCU / epoch-based reclamation (§26.13–26.14) | 1 relaxed load + epoch bump | The production answer for read-mostly config |
| Hazard pointers (§26.12) | ~1 store + fence per read | Bounded memory, higher per-read cost |
| `atomic<shared_ptr>` | spinlock + contended RMW | Correct, simple, slow |

**Interview answer to "is `shared_ptr` thread-safe?":** the control block is; the `shared_ptr` object is not. Separate copies are fine; concurrent read/write of one instance needs `std::atomic<std::shared_ptr<T>>`, which is correct but usually not lock-free and is too slow for a hot path.

---

## Key Interview Questions

1. **What is a data race, precisely?** — Two conflicting accesses (≥1 write) to the same *memory location* from different threads, unordered by happens-before, at least one non-atomic. It is undefined behavior, not merely a stale read.
2. **Why can a non-atomic `while(!done);` loop hang forever?** — The compiler may hoist the load out of the loop because it is entitled to assume no data race; `if(!done) for(;;);` is a legal transformation.
3. **Are two threads writing adjacent struct members a race?** — No, distinct scalar members are distinct memory locations. Adjacent *bit-fields* are one location and do race; a `:0` field separates them.
4. **What does `memory_order_relaxed` actually guarantee?** — Atomicity plus per-object modification-order coherence (values never go backwards for one object in one thread); RMWs read the immediately preceding value so no update is lost. No cross-object ordering at all.
5. **Explain synchronizes-with.** — An acquire operation that *reads the value written by* a release operation (or a value in its release sequence) creates a cross-thread edge; combined transitively with sequenced-before it yields happens-before.
6. **What is a release sequence and why does it exist?** — The run of RMWs following a release store; an acquire reading any of them still synchronizes with the original store. Without it, counting semaphores and refcounts would not compose. C++20 removed the "same thread relaxed stores" clause.
7. **Cost of `seq_cst` versus `acquire`/`release` on x86 and ARM?** — On x86: acq/rel are free `mov`s; seq_cst loads are free but seq_cst *stores* cost an `xchg`/`mfence` (~20–40 cycles). On ARM: `ldar`/`stlr` for acq/rel, with seq_cst similar; POWER is where the gap is largest (`lwsync` vs `hwsync`).
8. **Why does `compare_exchange_weak` exist?** — LL/SC hardware can fail spuriously; `strong` must add a filtering loop. Use `weak` inside a retry loop, `strong` for a one-shot attempt.
9. **Why can a CAS on a struct loop forever?** — Comparison is by object representation, so padding bytes (or `±0.0`) that differ cause permanent mismatch. Assert `has_unique_object_representations_v`.
10. **Why is a refcount increment relaxed but the decrement `acq_rel`?** — Incrementing requires no ordering because you already hold a reference; the thread that decrements to zero must see all other owners' writes before destroying, so it needs acquire (and its own writes must be released to it).
11. **What is `memory_order_consume` for and why is it useless?** — Ordering only dependent operations, which is free on all real hardware (RCU pointer chasing); no compiler implements it, all promote it to acquire, and C++17 discourages it.
12. **What is wrong with double-checked locking without atomics, and what fixes it?** — The unlocked read races the write, and the pointer can become visible before the constructor's stores. Fix with acquire load / release store, or just use a function-local `static` (magic statics, C++11).
13. **Is `volatile` enough for a spin flag?** — No: it neither prevents tearing, nor emits barriers, nor prevents reordering with non-volatile accesses, nor removes the UB. Use `atomic<bool>` with relaxed; on x86 it emits the same instruction.
14. **When would you use a standalone fence rather than an ordered load/store?** — To amortize one barrier over many accesses, to pay an acquire only once on spin-loop exit, or when you need store-load ordering without an RMW. Otherwise prefer ordered operations — the compiler emits tighter code (`stlr` vs `dmb; str`).
15. **Which reorderings does x86 allow?** — Only store→load. Hence acquire/release is free and only `seq_cst` stores need a fence; hence the Store Buffer litmus test is the one x86 relaxation you can observe.
16. **What is a split lock and why does it matter?** — A misaligned `lock`-prefixed RMW crossing a cache line forces a bus lock, stalling every core for microseconds. Guard with alignment assertions and `split_lock_detect`.
17. **`std::atomic<T>::is_lock_free()` returns false on x86 for a 16-byte type — why?** — The compiler did not enable `cmpxchg16b` (`-mcx16`), partly because it writes even on a pure load. The fallback is a process-local lock table, which also silently breaks shared memory and signal safety.
18. **Is `shared_ptr` thread-safe?** — The control block's refcount is; the `shared_ptr` object is not. `std::atomic<std::shared_ptr<T>>` (C++20) is correct but typically spinlock-based; the deprecated `atomic_load(shared_ptr*)` overloads are removed in C++26.
19. **How would you test lock-free code for memory-model bugs?** — TSan for races, plus a stateless model checker (GenMC, CDSChecker) for missing-ordering bugs, plus running on ARM. TSan alone will not find a missing release on x86.

---

## Common Traps

- **Treating a data race as "just a stale value."** It is UB; the compiler may hoist the load and produce an infinite loop.
- **Using `volatile` for synchronization.** No atomicity, no barriers, no reordering protection against non-volatile accesses, still UB. MSVC's `/volatile:ms` makes this appear to work.
- **Testing only on x86.** Acquire/release are free `mov`s there; a missing acquire is invisible until the code runs on ARM or POWER.
- **`counter++` on a `std::atomic`** — the operator overloads are all `seq_cst`. Use `fetch_add(1, relaxed)`.
- **Using the returned value of `fetch_or`/`fetch_and`** — turns a single `lock or` into a `cmpxchg` loop on x86.
- **CAS on a type with padding or floating-point members** — compares object representation; can loop forever.
- **Single-argument `compare_exchange_weak(e, d, acq_rel)`** — silently applies `acq_rel` on failure too, paying a barrier per failed spin.
- **Assuming a spurious CAS failure means the value changed.** It does not; never put side effects in the failure path.
- **Putting an acquire fence *before* the load** (or a release fence *after* the store). Wrong side; no-op on x86, broken on ARM.
- **`atomic_thread_fence(memory_order_relaxed)`** — does absolutely nothing.
- **Confusing a compiler barrier with a CPU barrier.** `asm volatile("" ::: "memory")` does not drain a store buffer.
- **Assuming release/acquire gives a global order.** It does not — IRIW and Store Buffer both remain possible; only `seq_cst` forbids them.
- **Relying on the pre-C++20 release-sequence rule** that relaxed stores by the same thread extend a release sequence. Removed by P0982.
- **Misaligned atomics** → split lock on x86 (system-wide stall), fault on ARM.
- **`std::atomic<T>` in shared memory without `is_always_lock_free`** — the lock table is process-local, so there is no cross-process atomicity.
- **Non-lock-free atomics in signal handlers** — deadlock against the interrupted code holding the same table mutex.
- **Assuming `is_lock_free()` is true because the hardware has the instruction** — `-mcx16`/`+lse` may be off.
- **`atomic<shared_ptr>` on a hot path** — usually spinlock-backed plus a contended refcount line; 50–200 ns under load.
- **Concurrently reading and writing one `shared_ptr` object** — the refcount is atomic, the two-pointer object is not.
- **Assuming relaxed loads in a spin loop will be re-read** — they will, but the compiler may still CSE two relaxed loads or reorder them with unrelated code; correctness must not depend on the schedule.
- **Believing `memory_order_consume` gives you cheap ordering** — every compiler upgrades it to acquire.

---

## Compact Recall Summary

**Races.** Conflicting unordered accesses to one *memory location* with ≥1 non-atomic write = UB, and the compiler exploits it (loop-hoisting, register promotion). Separate scalar members are separate locations; adjacent bit-fields are not. TSan is the detector; it finds executed interleavings only.

**Atomics.** `std::atomic<T>` needs trivially-copyable `T`; operator overloads are all `seq_cst`. Lock-freedom falls back to a process-local, signal-unsafe **lock table** — gate shared-memory and signal-handler use on `is_always_lock_free`. `atomic_ref` (C++20) applies atomicity to plain objects with stricter alignment, so the object keeps its native layout.

**RMW.** Reads the immediately preceding value in modification order, so no update is lost even when relaxed. x86 `lock`-prefixed ops are full barriers (so relaxed and seq_cst RMWs emit identical code); pre-LSE ARM uses `ldxr`/`stxr` loops that can livelock — LSE (`ldadd`, `cas`, `swp`) fixes it.

**CAS.** `expected` is updated in place on failure. `weak` may fail spuriously (LL/SC monitor cleared by an unrelated write to the line, an interrupt, a context switch); use it inside loops, `strong` for one-shots. Compares object representation — padding and `±0.0` break it.

**Orderings.** `relaxed` = atomicity + per-object coherence only. `acquire`/`release` = pairwise publication, one-way barriers, and the workhorse. `acq_rel` for RMWs. `consume` is dead (all compilers promote to acquire). `seq_cst` adds a single total order S over all seq_cst ops — needed only for multi-variable agreement (Store Buffer, IRIW).

**Happens-before.** sequenced-before ∪ (release→acquire synchronizes-with, transitively closed). The acquire must actually *read* the release's value (or its **release sequence**: the following run of RMWs by any thread; C++20 dropped the same-thread-relaxed-store clause). Every ordering question is "draw the edge."

**Coherence.** Every atomic object has a total modification order agreed by all threads, free with any ordering. Values never go backwards for one object in one thread. Nothing is guaranteed *across* objects without ordering.

**Fences.** Standalone, stronger than ordered ops, use to amortize barriers or pay an acquire once on spin exit. Release fence *before* the store, acquire fence *after* the load. `relaxed` fence is a no-op; `atomic_signal_fence` is a pure compiler barrier. `seq_cst` fence is the only non-RMW way to get store-load ordering.

**Cost model.** x86-TSO reorders only store→load: acq/rel are free `mov`s, seq_cst loads are free, seq_cst stores cost `xchg`/`mfence` (~20–40 cycles), `mfence` ~30–100. AArch64: `ldar`/`stlr`, `ldapr` with v8.3 RCpc, `dmb ish` for fences. POWER: `lwsync` for acq/rel, `hwsync` for seq_cst, and it is not multi-copy-atomic (IRIW is real). Contended RMW cost is dominated by cache-line transfer (~40–100 ns cross-socket), not the instruction.

**Publication.** Construct, then release-store the pointer; acquire-load, then dereference. That single pattern underlies DCL, seqlocks, ring buffers, and RCU. Prefer magic statics over hand-rolled DCL; prefer eager `constinit` initialization over both on a hot path.

**Alignment and tearing.** `std::atomic` never tears; plain accesses may (the compiler can split them). Atomics are over-aligned so hardware atomicity holds; misalignment gives a **split lock** (system-wide microsecond stall) on x86 and a fault on ARM.

**`volatile`.** Only prevents eliding/caching of that access. No atomicity, no barriers, no ordering against non-volatile accesses, still a data race. `volatile std::atomic<T>` is the legitimate combination for MMIO.

**Atomic `shared_ptr`.** Control block atomic, object not. `std::atomic<std::shared_ptr<T>>` (C++20) is correct but nearly always spinlock-backed; the C++11 free functions are removed in C++26. On hot read-mostly paths use RCU/epochs or a double-buffer with an atomic index instead.

**Litmus vocabulary.** SB (store→load; the one x86 relaxation; needs seq_cst or a seq_cst fence), MP (publication; needs rel/acq), LB (load→store; ARM/POWER only), IRIW (multi-copy atomicity; POWER only, and seq_cst forbids it). Validate with GenMC/CDSChecker and `herd7`, not TSan alone.
