# Chapter 9 — Ownership

*Interview-focused revision notes. The theme: ownership is a compile-time question wherever possible and a runtime one only when you cannot answer it statically — and every step down that ladder (unique → intrusive refcount → `shared_ptr` → `weak_ptr`) buys flexibility with atomics, indirections, and cache lines.*

---

## 9.1 Unique Ownership with `unique_ptr`

`std::unique_ptr<T, D>` (C++11) is a move-only RAII handle: exactly one owner, deterministic destruction, no reference count, no atomics.

```cpp
template <class T, class D = std::default_delete<T>>
class unique_ptr {
    T* ptr_;
    [[no_unique_address]] D del_;   // conceptually; libstdc++ uses a tuple with EBO
};
```

**The size guarantee that matters:** with a *stateless* deleter, `sizeof(unique_ptr<T>) == sizeof(T*)` via EBO / `[[no_unique_address]]` (Ch. 3 §3.4). A stateful deleter (a lambda with captures, a function pointer) makes it larger — a function-pointer deleter doubles the size and adds an indirect call. Prefer a stateless function-object deleter (§9.2).

### Cost analysis

`unique_ptr` is *zero-overhead in storage and in operations* — construction, dereference, and reset compile to the same code as a raw pointer plus one branch on destruction (`if (p) delete p;`, and the branch is usually elided or predicted perfectly). But it is **not zero-overhead at ABI boundaries**:

> Because `unique_ptr` has a non-trivial destructor, it is not trivially copyable, so under the System V AMD64 ABI it is passed **by invisible reference in memory**, not in a register (Ch. 3 §3.5, Ch. 41). A raw `T*` argument goes in `rdi`. Passing `unique_ptr` by value across a non-inlined function boundary therefore costs a store and a load that a raw pointer does not.

This is the standard answer to "is `unique_ptr` really zero cost?" — yes for storage and semantics, no at the ABI. In practice it never matters because the calls inline; say both halves.

Also non-obvious: the destructor emits a branch and a `delete` call, which the optimizer must keep unless it can prove non-null. In a hot loop that creates and destroys many `unique_ptr`s the real cost is the `delete` (Ch. 7), not the wrapper.

### Semantics

```cpp
auto p = std::make_unique<Foo>(args);       // C++14; single allocation, exception-safe
auto q = std::move(p);                       // p is now null
Foo* raw = q.get();                          // observe, do not own
Foo* esc = q.release();                      // give up ownership, YOU must delete
q.reset(new Foo);                            // delete old, adopt new
if (q) { /* explicit operator bool */ }
```

- **Move-only.** Copy is deleted, which is exactly what makes ownership statically checkable — a `unique_ptr` in a signature is self-documenting.
- **`reset()` order:** the standard requires the old pointer be saved, the member assigned, then the old deleted — so self-reset (`p.reset(p.get())`) doesn't double-delete… but it does delete what you just adopted. Don't.
- **`make_unique` (C++14)** exists for exception safety: `f(std::unique_ptr<A>(new A), g())` had unspecified evaluation order pre-C++17, so `g()` could throw between the `new` and the constructor, leaking. C++17 fixed the sequencing (Ch. 4 §4.2), but `make_unique` remains the idiom, avoids repeating the type, and never mentions `new`. Its limitation: it cannot use a custom deleter and cannot do brace-init of aggregates before C++20.
- **`make_unique_for_overwrite`** (C++20) default-initializes instead of value-initializing — the fix for `make_unique<char[]>(1<<20)` needlessly zeroing (and page-faulting) a megabyte (Ch. 7 §7.2).
- **Array specialization** `unique_ptr<T[]>` calls `delete[]`, offers `operator[]`, and forbids derived→base conversion (which would be a stride bug).
- **Incomplete types are allowed** — the essential property for PIMPL (Ch. 44 §44.14). The catch: the destructor must be defined where `T` is complete, so the enclosing class's destructor must be declared in the header and *defined in the .cpp*. Omitting it produces the classic "invalid application of `sizeof` to an incomplete type" error inside `default_delete`.

### Interface guidance

| Signature | Meaning |
|---|---|
| `void f(std::unique_ptr<T>)` | **Sink** — takes ownership |
| `std::unique_ptr<T> f()` | **Source** — transfers ownership out (the default factory shape) |
| `void f(T*)` / `void f(T&)` | **Observe** — no ownership; use raw pointer/reference |
| `void f(const std::unique_ptr<T>&)` | Almost always wrong — take `T*`/`T&` instead |
| `void f(std::unique_ptr<T>&)` | "May replace the caller's pointer" — rare and worth a comment |

`unique_ptr` should be the default smart pointer. Reach for `shared_ptr` only when lifetime is genuinely dynamic and unownable by a single party (§9.3).

---

## 9.2 Custom Smart-Pointer Deleters

The deleter is `unique_ptr`'s second template parameter and part of its type; for `shared_ptr` it is **type-erased into the control block** (§9.3), so `shared_ptr<T>` with any deleter is one type. That asymmetry is a standard question.

```cpp
// 1. Stateless function object — BEST: EBO, size == sizeof(T*), inlined call
struct FileCloser { void operator()(std::FILE* f) const noexcept { std::fclose(f); } };
using FilePtr = std::unique_ptr<std::FILE, FileCloser>;

// 2. Function pointer — 16 bytes, indirect call, not inlinable
using FilePtr2 = std::unique_ptr<std::FILE, int(*)(std::FILE*)>;
FilePtr2 f{std::fopen("x","r"), &std::fclose};

// 3. Capturing lambda — size grows by the capture; type is unnameable without decltype
auto del = [&pool](Node* n){ pool.release(n); };
std::unique_ptr<Node, decltype(del)> n{pool.acquire(), del};
```

### The deleter must be callable with the stored pointer and should be `noexcept`

A deleter that throws during stack unwinding calls `std::terminate` (Ch. 10 §10.5). Mark deleters `noexcept`.

### `unique_ptr<void, D>` and non-pointer handles

`unique_ptr` requires `D::pointer` if present, otherwise `T*`. Defining a nested `pointer` type lets you own things that aren't pointers — file descriptors, handles, indices:

```cpp
struct FdDeleter {
    struct pointer {                       // NullablePointer: needs ==, !=, and construction from nullptr_t
        int fd = -1;
        pointer(std::nullptr_t = nullptr) {}
        explicit pointer(int f) : fd(f) {}
        explicit operator bool() const { return fd != -1; }
        friend bool operator==(pointer a, pointer b) { return a.fd == b.fd; }
    };
    void operator()(pointer p) const noexcept { ::close(p.fd); }
};
using Fd = std::unique_ptr<int, FdDeleter>;
```

This is legal and occasionally useful, but a purpose-built `class Fd` with the rule of five is usually clearer. Know it as a capability, not a recommendation.

### Practical patterns

**C API RAII** — the highest-value use:

```cpp
std::unique_ptr<FILE, decltype(&std::fclose)>            f{std::fopen(p,"r"), &std::fclose};
std::unique_ptr<void, decltype(&::free)>                 m{std::malloc(n), &::free};
std::unique_ptr<SSL, decltype(&SSL_free)>                s{SSL_new(ctx), &SSL_free};
```
The `decltype(&fn)` form is convenient but gives you the function-pointer cost (case 2). For anything hot, write the stateless functor.

**Pool return** (Ch. 7 §7.10) — the deleter returns the object to a pool rather than freeing it:

```cpp
template <class T> struct PoolDeleter {
    Pool<T>* pool;                                    // stateful: 8 bytes
    void operator()(T* p) const noexcept { pool->destroy(p); }
};
template <class T> using Pooled = std::unique_ptr<T, PoolDeleter<T>>;
```
If there's exactly one global pool per type, make the deleter stateless (reference a function-local static or a global) and get back to pointer-size.

**No-op / non-owning deleter** for a `unique_ptr` that must sometimes not own — a code smell; prefer two distinct types or a `variant`.

**`shared_ptr` deleters** are supplied at construction, not in the type:

```cpp
std::shared_ptr<FILE> f{std::fopen(p,"r"), &std::fclose};   // deleter stored in control block
std::shared_ptr<T>    borrowed{ptr, [](T*){}};              // non-owning shared_ptr (legal, rarely wise)
```
The trade: type uniformity and runtime flexibility, paid for with a control-block allocation and an indirect call (§9.3). Note `shared_ptr` has **no** array specialization pre-C++17; C++17 added `shared_ptr<T[]>` with correct `delete[]`.

---

## 9.3 Shared Ownership and Control Blocks

`std::shared_ptr<T>` implements shared ownership by reference counting. Its layout is the key to every question about it:

```
shared_ptr<T>                         Control block
┌────────────────┐                   ┌────────────────────────┐
│ T* ptr         │──▶ object         │ strong count  (atomic) │
│ ctrl* cb       │──────────────────▶│ weak count    (atomic) │
└────────────────┘                   │ deleter (type-erased)  │
   16 bytes                          │ allocator              │
                                     │ [+ object, if make_shared]
                                     └────────────────────────┘
```

**`sizeof(shared_ptr<T>) == 2 * sizeof(void*)`** — twice a raw pointer, twice a `unique_ptr`. The stored pointer is separate from the control block precisely to support the aliasing constructor (§9.8) and pointer-adjusting conversions to base classes.

### The counts

- **Strong count** — number of `shared_ptr`s. Reaches zero → the **object is destroyed** (deleter runs).
- **Weak count** — number of `weak_ptr`s, plus one held collectively by all strong owners. Reaches zero → the **control block is freed**.

Two counts, two events. That separation is why `weak_ptr` can safely check whether the object is alive: the control block outlives the object.

### The atomics, and what they cost

The counts are atomic; the **pointed-to object is not**. `shared_ptr` gives you thread-safe *reference counting*, never thread-safe *object access*, and never thread-safe access to the same `shared_ptr` instance (two threads doing `p = q` on the same `p` is a data race — §9.11).

| Operation | Cost |
|---|---|
| Copy construct / assign | `lock xadd` on the strong count (increment can be relaxed) |
| Destroy | `lock xadd` decrement with **acquire-release** semantics, plus a branch |
| **Move** | **No atomics** — pointer steal. Always move when you can. |
| Dereference | One load; the pointer is stored directly, so no extra indirection |
| `weak_ptr::lock()` | A **CAS loop**: increment strong only if non-zero |

An uncontended `lock xadd` is ~15–20 cycles. Under contention across cores it is far worse: the cache line holding the count bounces between cores (Ch. 28), so a `shared_ptr` copied by many threads is a **false-sharing-shaped serialization point** costing 100+ ns per operation. Copying a `shared_ptr` in a hot loop is one of the most common self-inflicted latency wounds in C++.

The decrement must be an acquire-release (or a release followed by an acquire fence on the zero path) because the destroying thread must see all writes made by every other owner before it runs the destructor — a textbook safe-publication problem (Ch. 25 §25.17). Implementations optimize the increment to `memory_order_relaxed` and use `release` + `acquire`-fence on the zero path.

**Single-threaded builds:** libstdc++ selects a non-atomic refcount policy when the program isn't linked with pthreads (`__gthread_active_p()`), which is why `shared_ptr` benchmarks can look free in a toy program and cost 10× in a real one.

### The two-allocation problem

```cpp
std::shared_ptr<Foo> p{new Foo};          // TWO allocations: Foo, then the control block
auto q = std::make_shared<Foo>();         // ONE allocation: object and control block together
```
See §9.4. The `shared_ptr(T*)` constructor must also handle the case where allocating the control block throws — it deletes the pointer, so no leak, but it's another reason to prefer `make_shared`.

### When shared ownership is actually right

Genuinely shared, dynamic, unpredictable lifetime: an object referenced from several independent subsystems where none can be designated the owner, or a callback that may outlive its registrar. If you can name the owner, use `unique_ptr` plus raw observers. `shared_ptr` is frequently a design smell meaning "I didn't decide who owns this."

---

## 9.4 `make_shared` Allocation Behavior

`std::make_shared<T>(args...)` performs **one** allocation holding both the control block and the object:

```
make_shared:  [ strong | weak | deleter/alloc | T object ]   ← one block
new + ctor:   [ strong | weak | deleter | T* ]  ...  [ T ]   ← two blocks, far apart
```

### Advantages

1. **One allocation instead of two.** Roughly halves construction cost (Ch. 7).
2. **Locality.** The count and the object are on the same or adjacent cache lines, so incrementing the refcount and touching the object is one cache miss instead of two. In a pointer-chasing structure this is the dominant effect.
3. **Exception safety** — historically the main argument (see the `make_unique` discussion in §9.1); largely moot since C++17's sequencing rules, but still true.
4. `make_shared` uses `::operator new` for the combined block; `allocate_shared<T>(alloc, args...)` uses your allocator (Ch. 8) — the hook for arena-backed shared objects.

### Disadvantages — the interview material

1. **Weak-pointer retention** (§9.9): the object's *storage* cannot be freed until the **weak** count also reaches zero, because the control block and the object are one allocation. A long-lived `weak_ptr` to a 10 MB object holds 10 MB. With separate allocations, the object's memory is freed at strong-zero.
2. **No custom deleter.** `make_shared` always destroys via `p->~T()` and frees the combined block. If you need a custom deleter, you must use the `shared_ptr(ptr, deleter)` constructor and accept two allocations.
3. **`private`/`protected` constructors don't work** — `make_shared` isn't a friend. The workaround is the "passkey" idiom:

```cpp
class Widget {
    struct Key { explicit Key() = default; };     // only Widget can construct a Key
public:
    Widget(Key, int x);                           // public but unconstructible externally
    static std::shared_ptr<Widget> create(int x) { return std::make_shared<Widget>(Key{}, x); }
};
```

4. **Value-initialization.** `make_shared<T>()` value-initializes; C++20's `make_shared_for_overwrite` skips it. `make_shared<T[]>(n)` (C++20) covers arrays.
5. **Over-aligned types**: implementations must honor `alignof(T)` in the combined block; older libraries got this wrong.

### The decision rule

Default to `make_shared`. Switch to `shared_ptr(new T, deleter)` when you need a custom deleter, or when the object is large *and* long-lived `weak_ptr`s are expected (a cache of weak handles to big objects is the canonical case).

---

## 9.5 Weak Ownership

`std::weak_ptr<T>` observes a `shared_ptr`-managed object **without** contributing to its lifetime. It holds the same two pointers (16 bytes) and increments the *weak* count.

You cannot dereference it. The only way to use it is `lock()`, which atomically produces a `shared_ptr` — null if the object is gone:

```cpp
if (auto sp = wp.lock()) {      // atomic: CAS-increments strong only if it's non-zero
    sp->use();                  // now guaranteed alive for the duration of sp
}                               // ...and use it through sp, not through wp
```

**Why `lock()` and not `expired() + use`:** `expired()` is a *racy snapshot*. Between `if (!wp.expired())` and any subsequent use, another thread can drop the last strong reference. `lock()` is the only atomic test-and-acquire. `expired()` is useful only for hints (pruning a cache, metrics), never as a guard. This is a favorite question.

`use_count()` is likewise approximate and thread-racy; it exists for debugging.

### Uses

- **Breaking cycles** (§9.6) — the defining use.
- **Caches**: a `map<Key, weak_ptr<V>>` keeps entries only while someone else uses them; `lock()` returns null for evicted entries, which you then prune. Note the control blocks accumulate until you prune, and with `make_shared` the *objects'* memory accumulates too (§9.9).
- **Observers / callbacks**: a subscriber list of `weak_ptr` automatically drops dead subscribers; the publisher `lock()`s before invoking, so a subscriber destroyed concurrently is skipped instead of dangling.
- **Safe `this` in async callbacks** — combined with `enable_shared_from_this` (§9.7): capture a `weak_ptr` in the lambda, `lock()` on entry, and the callback becomes a no-op if the object died. This is the standard pattern for asynchronous I/O in C++ (Ch. 20) and is worth being able to write from memory.

```cpp
timer.async_wait([w = weak_from_this()](auto ec) {
    if (auto self = w.lock()) self->on_timer(ec);      // else the object is gone; do nothing
});
```

Capturing a `shared_ptr` instead would keep the object alive until the callback fires — sometimes what you want (a "keep-alive" capture in a completion handler), sometimes a leak. Choosing consciously between the two is the skill.

### Cost

`lock()` is a **CAS loop**, not a plain increment: it must increment the strong count only if it's currently non-zero, and there is no atomic "increment if non-zero" primitive. So it is more expensive than a `shared_ptr` copy and can spin under contention. Do not `lock()` on a hot path; hoist it outside the loop.

---

## 9.6 Shared-Ownership Cycles

Reference counting cannot collect cycles. Two objects holding `shared_ptr`s to each other keep each other's strong count at 1 forever — a leak that no destructor runs for, invisible to `use_count`-based reasoning, and a leak that LeakSanitizer *does* report (the memory is still reachable from the objects themselves, but not from any root — LSan's reachability analysis catches it; Valgrind reports it as "still reachable" and may not flag it, which is why LSan is the better tool here).

```cpp
struct Node { std::shared_ptr<Node> next; };
auto a = std::make_shared<Node>();
auto b = std::make_shared<Node>();
a->next = b; b->next = a;
// a and b go out of scope: both counts drop 2→1. Neither destructor ever runs.
```

### Where cycles appear in real code

- **Parent ↔ child** trees where children point back at parents.
- **Observer patterns** where the subject holds subscribers and subscribers hold the subject.
- **Callbacks capturing `shared_ptr<this>`** stored in a member of `this` — the self-cycle, and the most common form. An object that owns a `std::function` which captures a `shared_ptr` to that same object never dies.
- **Doubly-linked lists** with `shared_ptr` in both directions.
- **Coroutines and async chains** where a completion handler holding a keep-alive is stored on the object it keeps alive.

### The fixes

1. **Direction rule.** Decide which direction is *ownership* and which is *reference*: owner→owned is `shared_ptr`, owned→owner is `weak_ptr` (or a raw pointer/reference if the owner is guaranteed to outlive). Parents own children; children weakly reference parents.
2. **Raw pointer back-edges.** When the back-referenced object is structurally guaranteed to outlive (a child never outlives its tree), a raw `Parent*` is cheaper and clearer than `weak_ptr` — no weak count, no `lock()`. Prefer this when you can justify the lifetime invariant.
3. **Break explicitly at teardown.** For a graph with genuine cycles, an explicit `clear()`/`dispose()` that nulls the links. Fragile but sometimes unavoidable.
4. **Arena ownership.** Own every node in an arena or pool (Ch. 7 §7.7), and let the graph edges be raw pointers or indices. The whole graph dies at once. This is what a low-latency system does, and it makes cycles a non-issue by construction — plus indices are 4 bytes rather than 16, and are relocation-safe.

**Interview framing:** "Reference counting can't collect cycles; tracing GC can. What's the C++ answer?" — `weak_ptr` for back-edges, or better, don't use refcounting for graph structure at all: use an arena and non-owning edges.

---

## 9.7 `enable_shared_from_this`

**The problem:** a member function needs to hand out a `shared_ptr` to its own object. Doing it naively creates a *second, independent* control block:

```cpp
struct Bad {
    std::shared_ptr<Bad> self() { return std::shared_ptr<Bad>(this); }   // DISASTER
};
auto p = std::make_shared<Bad>();
auto q = p->self();    // two control blocks, each with count 1 → DOUBLE FREE
```

**The fix:** inherit from `std::enable_shared_from_this<T>` (CRTP, Ch. 6 §6.19):

```cpp
struct Good : std::enable_shared_from_this<Good> {
    std::shared_ptr<Good> self() { return shared_from_this(); }
};
```

### How it works

The base contains a `std::weak_ptr<T>`. When a `shared_ptr` is constructed from a `T*`, the constructor detects (via SFINAE/`is_convertible` on the base) that `T` derives from `enable_shared_from_this<T>` and **initializes that weak member** to point at the newly created control block. `shared_from_this()` then simply does `weak.lock()` and throws `std::bad_weak_ptr` if empty.

The consequences follow directly from "the weak member is set by the `shared_ptr` constructor":

- **The object must already be owned by a `shared_ptr`.** Calling `shared_from_this()` on a stack object, a `unique_ptr`-owned object, or a raw `new`ed object throws `bad_weak_ptr` (C++17; **UB** before C++17). This is the number-one gotcha.
- **You cannot call it in the constructor.** The `shared_ptr` doesn't exist yet — the constructor is running *inside* `make_shared`, before the control block is wired up. Throws `bad_weak_ptr`. The fix is a two-phase `create()` factory that constructs, then calls an `init()` which may use `shared_from_this()`.
- **Inherit publicly and with the right `T`.** `struct D : enable_shared_from_this<B>` (wrong template argument) or private inheritance breaks the detection silently.
- **Only one `enable_shared_from_this` base** in a hierarchy; multiple inheritance of it is ambiguous and broken.
- **`weak_from_this()`** (C++17) returns the `weak_ptr` directly and, crucially, **does not throw** when unowned — it returns an empty `weak_ptr`. Prefer it in async callbacks (§9.5) where you'd `lock()` anyway.

### The idiomatic factory

```cpp
class Session : public std::enable_shared_from_this<Session> {
    struct Key { explicit Key() = default; };
public:
    Session(Key, Socket s);
    static std::shared_ptr<Session> create(Socket s) {
        auto p = std::make_shared<Session>(Key{}, std::move(s));
        p->start();                                   // now shared_from_this() is valid
        return p;
    }
    void start() {
        sock_.async_read([self = shared_from_this()](auto ec, auto n) {  // keep-alive capture
            self->on_read(ec, n);
        });
    }
};
```

This is the Asio session pattern: the object keeps itself alive exactly as long as an operation is outstanding, and dies when the last handler completes. Note it deliberately uses a `shared_ptr` capture (keep-alive) rather than `weak_ptr` — a live I/O operation should not be cancelled by the object going out of scope elsewhere. Contrast with §9.5, where a timer callback on a possibly-dead object should use `weak_ptr`. Being able to articulate *which* one and *why* is the discriminating answer.

---

## 9.8 `shared_ptr` Aliasing Constructor

```cpp
template <class Y> shared_ptr(const shared_ptr<Y>& r, element_type* p) noexcept;
```

It creates a `shared_ptr` that **shares `r`'s ownership** (same control block, refcount incremented) but **points at `p`**, which need not be `r`'s object at all. No new control block, no ownership of `p`.

This is why `shared_ptr` stores the pointer separately from the control block — the aliasing constructor is the reason for the 16-byte layout.

### The canonical use: a member of a shared object

```cpp
struct Config { std::string host; int port; };
std::shared_ptr<Config> cfg = std::make_shared<Config>();

std::shared_ptr<std::string> host{cfg, &cfg->host};   // keeps the WHOLE Config alive
// host.use_count() == 2; cfg.reset(); host still valid; ~Config runs when host dies
```

You hand out a handle to a subobject; the enclosing object stays alive as long as any subobject handle does. This is the correct, standard way to expose part of a shared structure without exposing (or copying) the whole.

Other uses:

- **Views into a shared buffer**: `shared_ptr<const std::byte>` pointing into a `shared_ptr`-managed receive buffer, so a parsed message can outlive the parse loop without copying (Ch. 51). Zero-copy with correct lifetime.
- **Non-owning aliases with keep-alive semantics** — a `shared_ptr<Base>` aliasing a `shared_ptr<Derived>` where the conversion isn't a simple upcast (multiple inheritance with offset adjustment; the compiler does this automatically for real base conversions, but aliasing handles arbitrary cases).
- **`shared_ptr<void>` as a keep-alive token**: `shared_ptr<void> keepalive{owner, nullptr}` — a type-erased "hold this alive" handle. C++17 allows a null stored pointer with a live control block.
- The C++20 addition `shared_ptr(shared_ptr&& r, element_type* p)` gives a move-based aliasing constructor, avoiding the refcount bump.

### The hazards

- `use_count()` reflects the **shared** control block, so a `shared_ptr<string>` aliasing a `Config` reports counts that look wrong for a string.
- The aliased pointer's validity is entirely your responsibility: `shared_ptr<T>(owner, some_unrelated_pointer)` compiles and dangles happily. Nothing checks that `p` is inside `r`'s object.
- **Memory retention**: keeping one `int` member alive pins a 100 MB parent object. A common cause of unexplained RSS.
- Reseating the parent (`cfg = make_shared<Config>()`) does *not* update the alias — the alias still points at the old object, which it keeps alive. Correct, but surprising.

**Interview framing:** "How would you return a `shared_ptr` to a member of a shared object without a second allocation or a dangling risk?" — the aliasing constructor. Recognizing the question is most of the answer.

---

## 9.9 Weak-Pointer Retention After `make_shared`

The most-asked non-obvious `shared_ptr` question, and it follows mechanically from §9.4.

```
make_shared:     ONE allocation = [ counts | deleter | T object ]
                 strong→0: ~T() runs; MEMORY IS NOT FREED
                 weak→0:   the whole block is freed

new + shared_ptr: TWO allocations = [ counts | deleter | T* ]   and   [ T ]
                 strong→0: ~T() runs AND the T block is freed
                 weak→0:   the control block is freed
```

So with `make_shared`, **`sizeof(T)` bytes stay resident for as long as any `weak_ptr` exists**, even though the object has been destroyed. The destructor ran, the object's lifetime ended (accessing it is UB), but the storage cannot be returned because it's the same allocation as the control block still being observed.

### Why this matters

```cpp
auto big = std::make_shared<std::array<char, 100 << 20>>();   // 100 MB
std::weak_ptr<...> w = big;
big.reset();            // destructor runs; 100 MB STILL RESIDENT
                        // freed only when w is destroyed or reset
```

Realistic version: a `std::unordered_map<Key, std::weak_ptr<Entry>>` cache that never prunes. Every evicted entry's *full object storage* stays allocated because the weak entry keeps the block alive. RSS climbs, the heap profiler shows the memory attributed to `make_shared`, and nothing looks like a leak because it isn't one.

### The remedies

1. **Prune the weak map.** Periodically erase entries whose `expired()` is true. `expired()` is fine here — a stale answer just means you prune next cycle (§9.5).
2. **Use `shared_ptr<T>(new T)`** for large objects with expected long-lived weak observers: two allocations, but strong-zero frees the object's memory immediately. This is *the* legitimate reason not to use `make_shared`.
3. **Don't hold `weak_ptr`s longer than necessary** — scope them, or store an index/key instead.

**Interview framing:** "Give me a reason *not* to use `make_shared`." Two correct answers: custom deleters, and weak-pointer retention of large objects. A third partial credit answer: private constructors.

A related detail: the *control block* itself (typically 24–32 bytes with a type-erased deleter and allocator) is retained in both schemes until weak-zero, so a million dead weak entries is tens of megabytes even for small objects.

---

## 9.10 Intrusive Reference Counting

**Intrusive** means the reference count lives *inside* the object rather than in a separate control block.

```cpp
template <class Derived>
class RefCounted {
    mutable std::atomic<uint32_t> rc_{0};
public:
    void add_ref() const noexcept { rc_.fetch_add(1, std::memory_order_relaxed); }
    void release() const noexcept {
        if (rc_.fetch_sub(1, std::memory_order_acq_rel) == 1)
            delete static_cast<const Derived*>(this);
    }
};
// paired with a handle type calling add_ref/release in its copy ctor/dtor
```

`boost::intrusive_ptr` provides the handle; COM's `IUnknown::AddRef`/`Release`, Qt's implicit sharing, LLVM's `IntrusiveRefCntPtr`, and virtually every game engine use the same design.

### Intrusive vs `shared_ptr`

| | `std::shared_ptr` | Intrusive |
|---|---|---|
| Handle size | **16 bytes** (ptr + control block ptr) | **8 bytes** (just the pointer) |
| Allocations | 1 (`make_shared`) or 2 | 0 extra — count is in the object |
| Cache lines touched on copy | 2 (object + control block), unless `make_shared` | **1** — the count is in the object you're already touching |
| Weak references | Yes, built in | Requires extra machinery |
| Works with existing types | Yes, non-intrusively | **No** — the type must be modified |
| Raw pointer → handle | Unsafe (new control block, §9.7) | **Safe** — the count is in the object |
| Custom deleter | Type-erased in the control block | Fixed by the type (or a virtual `destroy()`) |
| Thread safety of counting | Yes | Yours to implement |
| Type erasure across deleters | `shared_ptr<T>` is one type | Same |

The two decisive advantages for low-latency code are **8 bytes instead of 16** (halving the size of any structure holding many handles, which halves cache footprint) and **one cache line instead of two** on every refcount operation. A `shared_ptr` copy touches the control block, which with `new`-constructed pointers is an entirely separate cache line from the object — an extra miss per copy.

The third advantage is subtler: you can construct a handle from a raw `T*` **safely**, because the count travels with the object. That means functions can take and return raw pointers on the hot path and re-adopt ownership at the boundary, which `shared_ptr` structurally cannot do (§9.7 exists only to work around this).

### Memory ordering — the detail that separates candidates

- **Increment: `memory_order_relaxed`.** You already hold a reference, so the object cannot die; no ordering is needed, only atomicity.
- **Decrement: `memory_order_acq_rel`** (or `release` plus an `acquire` fence on the zero path, which is the classic Boost formulation and is cheaper on architectures where a full acq_rel RMW is expensive):

```cpp
if (rc_.fetch_sub(1, std::memory_order_release) == 1) {
    std::atomic_thread_fence(std::memory_order_acquire);   // Ch.25 §25.14
    delete this;
}
```
The **release** ensures every write this thread made to the object happens-before the decrement; the **acquire** on the destroying thread ensures it sees every other thread's writes before running the destructor. Getting `relaxed` on increment and the release/acquire-fence pattern on decrement right — and being able to say *why* — is a strong signal (Ch. 25).

- The count may be non-atomic entirely for single-threaded or thread-confined objects, which is free. `boost::intrusive_ptr` lets you supply the `intrusive_ptr_add_ref`/`intrusive_ptr_release` overloads, so a non-atomic version is a two-line change.

**Weak references** require either a separate side structure or a "count of counts" scheme; most intrusive designs simply do without them, which is another reason they suit systems where cycles are avoided by design (§9.6).

---

## 9.11 Smart-Pointer Costs on Hot Paths

The synthesis section. Ordered from cheapest to most expensive:

| Construct | Size | Copy cost | Notes |
|---|---|---|---|
| Raw `T*` / `T&` (non-owning) | 8 / 0 | free | Correct for observation |
| Index into a pool (`uint32_t`) | **4** | free | Smallest; relocation-safe; validates cheaply |
| `unique_ptr<T>` (stateless deleter) | 8 | move only | Free, except ABI passing |
| Intrusive handle | 8 | 1 relaxed atomic, 1 cache line | Best refcounted option |
| `shared_ptr<T>` (`make_shared`) | 16 | 1 atomic RMW, 1–2 cache lines | Object and count colocated |
| `shared_ptr<T>` (`new`) | 16 | 1 atomic RMW, **2 cache lines** | Extra miss per copy |
| `weak_ptr::lock()` | 16 | **CAS loop** | Can spin under contention |

### The rules for hot code

**1. Never copy a `shared_ptr` on the hot path.** Pass `const T&` or `T*` to functions that merely use the object; the caller's `shared_ptr` already guarantees the lifetime for the duration of the call. Passing `shared_ptr<T>` by value into a function that only reads is the single most common performance error with smart pointers, and it costs two atomic RMWs (up and down) plus the ABI's memory passing (§9.1).

```cpp
void use(const std::shared_ptr<Foo>& p);   // ok but implies you might copy
void use(const Foo& f);                    // BEST — states you don't own, no refcount
void sink(std::shared_ptr<Foo> p);         // correct when you DO take ownership
```

**2. Move, don't copy.** A move is a pointer steal with no atomics. `return std::move(p)` is unnecessary (NRVO, Ch. 10 §10.1), but `sink(std::move(p))` matters.

**3. Contention is the real cost, not the atomic.** An uncontended `lock xadd` is ~20 cycles. A contended one — a `shared_ptr` to a shared config copied by every thread on every message — bounces a cache line between cores at 100+ ns each, and it *degrades with core count*. This is a **true sharing** problem (Ch. 28 §28.8), and the fix is not a faster refcount: it is to stop refcounting on the hot path (hold one reference per thread, hoisted out of the loop, or use RCU/hazard pointers — Ch. 26 §26.12 — for read-mostly shared state).

**4. `atomic<shared_ptr<T>>`** (C++20; previously the free `std::atomic_load/store(shared_ptr*)` overloads, deprecated in C++20) is **not lock-free** on any mainstream implementation — it uses a spinlock or mutex table, because updating two words (pointer + control block) atomically requires a DWCAS the standard can't assume. `is_lock_free()` returns false. Do not use it for a hot read path; use RCU, hazard pointers, a seqlock, or double-buffering with an atomic index (Ch. 26).

**5. Prefer ownership structures that don't need runtime counting at all.** In a trading hot path, the standard answer is: objects come from a preallocated pool (Ch. 7 §7.10), handles are 4-byte indices or raw pointers, lifetime is bounded by the event loop iteration, and nothing is reference counted. Reference counting is a mechanism for *unpredictable* lifetime, and a well-designed hot path has predictable lifetime by construction.

**6. `shared_ptr` is not thread-safe for the *same object***. Two threads copying *different* `shared_ptr`s to the same object is fine (the count is atomic). Two threads writing the *same* `shared_ptr` instance is a data race — the pointer and control-block pointer are two separate non-atomic words. This distinction is asked constantly.

**7. Destruction cost is real and can be tail-latency-shaped.** Dropping the last reference to a large object graph runs a cascade of destructors and frees on whatever thread happens to hold it — potentially the hot thread. The mitigation is a **deferred-destruction queue**: move the last `shared_ptr` onto an SPSC queue and let a housekeeping thread destroy it (Ch. 55). This is a genuinely good answer that few candidates give.

---

## Key Interview Questions

1. **Is `unique_ptr` zero-overhead?** — In storage and operations, yes (EBO makes it pointer-sized with a stateless deleter). At ABI boundaries, no: its non-trivial destructor forces memory passing instead of a register (SysV).
2. **What makes `unique_ptr` larger than a pointer?** — A stateful deleter: a function pointer doubles it and adds an indirect call; a capturing lambda adds the capture.
3. **Why does PIMPL require the destructor in the .cpp?** — `unique_ptr` allows an incomplete type, but its destructor needs a complete type; declaring `~X();` in the header and defining it where the impl is complete fixes it.
4. **Why does `make_unique` exist if `new` works?** — Pre-C++17 evaluation-order exception safety, no repeated type name, no bare `new`. `make_unique_for_overwrite` (C++20) avoids needless zeroing of large buffers.
5. **Why is a `unique_ptr` deleter part of the type but a `shared_ptr` deleter isn't?** — `shared_ptr` type-erases it into the control block, buying type uniformity at the cost of an allocation and an indirect call.
6. **What is `sizeof(shared_ptr<T>)` and why?** — Two pointers: the object pointer is stored separately from the control block pointer to support the aliasing constructor and pointer-adjusting conversions.
7. **What are the two counts in a control block?** — Strong (zero → destroy the object) and weak (zero → free the control block); weak counts one collective reference from all strong owners.
8. **What memory ordering does a refcount need?** — Relaxed increment (you already hold a reference); release decrement plus an acquire fence on the zero path, so the destroying thread sees every other owner's writes.
9. **`make_shared` vs `shared_ptr(new T)` — give both directions.** — One allocation and colocated counts vs the ability to use a custom deleter and to free the object's memory at strong-zero rather than weak-zero.
10. **Why can a `weak_ptr` retain 100 MB after the object is destroyed?** — `make_shared` puts object and control block in one allocation; the storage is only freed at weak-zero.
11. **Why is `expired()` then use a bug?** — It's a racy snapshot; only `lock()` atomically tests and acquires a strong reference.
12. **Why is `lock()` more expensive than a `shared_ptr` copy?** — It's a compare-exchange loop (increment only if non-zero), not a plain fetch_add.
13. **How do you break a `shared_ptr` cycle?** — Make back-edges `weak_ptr` (or raw pointers when the lifetime invariant is structural); better, own the graph in an arena and make all edges non-owning.
14. **What does `enable_shared_from_this` do and when does it throw?** — It holds a `weak_ptr` filled in by the `shared_ptr` constructor; `shared_from_this()` throws `bad_weak_ptr` if the object isn't already `shared_ptr`-owned — including inside the constructor (UB before C++17). `weak_from_this()` returns empty instead.
15. **What's wrong with `shared_ptr<T>(this)` in a member function?** — It creates a second, independent control block → double free.
16. **What is the aliasing constructor for?** — A `shared_ptr` to a subobject that shares the parent's control block, keeping the parent alive with no extra allocation.
17. **Intrusive refcount vs `shared_ptr` — the two decisive wins?** — 8 bytes instead of 16, and one cache line instead of two per refcount operation; plus safe re-adoption from a raw pointer.
18. **Is `std::atomic<std::shared_ptr<T>>` lock-free?** — No, on any mainstream implementation; it needs to update two words atomically, so it uses a spinlock. Use RCU, hazard pointers, or a seqlock instead.
19. **Is `shared_ptr` thread-safe?** — The refcount is; the object isn't; and the same `shared_ptr` *instance* written by two threads is a data race.
20. **What's the biggest smart-pointer mistake on a hot path?** — Copying `shared_ptr` into functions that only observe: two atomic RMWs, memory-passed ABI, and a contended cache line that degrades with core count. Pass `const T&`.
21. **How would you keep destruction off the hot thread?** — Move the last `shared_ptr`/owning handle onto an SPSC queue and destroy it on a housekeeping thread.

---

## Common Traps

- **`shared_ptr<T>(this)` inside a member function** — second control block, double free. Use `enable_shared_from_this`.
- **`shared_from_this()` in a constructor** or on a non-`shared_ptr`-owned object — `bad_weak_ptr` (UB pre-C++17).
- **Inheriting `enable_shared_from_this` privately or with the wrong template argument** — detection fails silently.
- **`expired()` followed by use** — racy; only `lock()` is atomic.
- **Copying a `shared_ptr` into an observing function** — two atomic RMWs plus a contended line for nothing.
- **`shared_ptr` cycles** — parent↔child, observer↔subject, and especially a `std::function` member capturing `shared_from_this()`.
- **`weak_ptr` caches that are never pruned** — with `make_shared`, the full object storage is retained until weak-zero.
- **`make_shared` with a private constructor** — not a friend; use the passkey idiom.
- **`make_shared<T[]>` / `make_shared<T>()` zeroing large buffers** — use the `_for_overwrite` forms (C++20).
- **Assuming `atomic<shared_ptr>` is lock-free** — it isn't; it spinlocks.
- **Two threads writing the same `shared_ptr` instance** — data race on two non-atomic words.
- **`unique_ptr` to an incomplete type without an out-of-line destructor** — the PIMPL compile error.
- **Function-pointer deleters on hot types** — doubles the handle and prevents inlining; use a stateless functor.
- **A deleter that can throw** — `terminate` during unwinding.
- **`delete` vs `delete[]` mismatch via `unique_ptr<T>` on an array** — use `unique_ptr<T[]>`.
- **`release()` vs `reset()` confusion** — `release()` gives up ownership *without* deleting; leaking is the usual result.
- **Storing `unique_ptr` in a container and expecting copies** — move-only; `push_back(std::move(p))`.
- **Aliasing constructor pointing outside the owned object** — compiles, dangles, nothing checks.
- **Aliasing a small member of a huge object** — pins the whole parent; a common unexplained-RSS cause.
- **Using `shared_ptr` because ownership was never decided** — the design smell; `unique_ptr` plus raw observers is usually correct.
- **Destroying a large object graph on the hot thread** — a cascade of destructors and frees in the latency-critical path.

---

## Compact Recall Summary

**unique_ptr.** Move-only, one owner, pointer-sized with a stateless deleter (EBO), no atomics. Zero-overhead in storage and operations but *not* at the ABI: a non-trivial destructor forces memory passing under SysV. `make_unique` (C++14) for exception safety and no bare `new`; `make_unique_for_overwrite` (C++20) to skip zeroing. Supports incomplete types — the basis of PIMPL, with the destructor defined out of line. Signature grammar: by value = sink, returned = source, `T*`/`T&` = observe.

**Deleters.** Part of `unique_ptr`'s type (stateless functor → free; function pointer → 16 bytes and an indirect call; capturing lambda → bigger still), type-erased into `shared_ptr`'s control block. Mark them `noexcept`. Uses: C-API RAII, pool return, and — via a nested `pointer` type — non-pointer handles like file descriptors.

**shared_ptr.** Two pointers (object + control block); control block holds strong count, weak count, type-erased deleter and allocator. Strong-zero destroys the object, weak-zero frees the control block. Counting is atomic; the object is not, and the same instance written by two threads is a race. Copy = one atomic RMW (contended: 100+ ns of cache-line bouncing); move = free; `weak_ptr::lock()` = a CAS loop.

**make_shared.** One allocation, colocated counts and object → one cache miss instead of two. Costs: no custom deleter, private constructors need the passkey idiom, and the object's *storage* is retained until weak-zero (§9.9) — the two legitimate reasons to prefer `shared_ptr(new T)` are custom deleters and large objects with long-lived weak observers.

**weak_ptr.** Non-owning observation; `lock()` is the only safe use (`expired()` is a racy hint). Used for cycle-breaking, caches, observer lists, and the async pattern `[w = weak_from_this()]{ if (auto s = w.lock()) ... }` — versus a `shared_ptr` keep-alive capture when the operation must complete regardless.

**Cycles.** Refcounting cannot collect them. Ownership direction is the fix: owner→owned `shared_ptr`, back-edge `weak_ptr` or raw pointer. Self-cycles via a `std::function` member capturing `shared_from_this()` are the most common form. Best structural answer: arena-own the graph, non-owning edges.

**enable_shared_from_this.** A CRTP base holding a `weak_ptr` that the `shared_ptr` constructor fills in. Requires prior `shared_ptr` ownership: throws `bad_weak_ptr` otherwise, including from within the constructor (UB before C++17). Public inheritance, correct template argument, one base only. `weak_from_this()` (C++17) doesn't throw.

**Aliasing constructor.** `shared_ptr<U>(owner, ptr)` shares `owner`'s control block while pointing anywhere — a handle to a subobject, a view into a shared buffer, or a type-erased keep-alive token. This is why the object pointer is stored separately. Nothing validates the aliased pointer, and aliasing one member pins the whole parent.

**Intrusive.** Count inside the object: 8-byte handles, no separate allocation, one cache line per refcount op, and safe re-adoption from raw pointers — at the cost of modifying the type and having no built-in weak references. Ordering: **relaxed increment**, **release decrement + acquire fence on the zero path**.

**Hot paths.** Ranked: raw pointer/index (4–8 B, free) < `unique_ptr` < intrusive (8 B, relaxed atomic) < `shared_ptr` (16 B, atomic RMW, 1–2 lines) < `weak_ptr::lock()` (CAS loop). Never copy a `shared_ptr` into an observing function — pass `const T&`. Contention, not the atomic instruction, is the cost, and it worsens with core count. `atomic<shared_ptr<T>>` is not lock-free; use RCU, hazard pointers, or a seqlock. Push large-graph destruction onto a housekeeping thread. Best of all: preallocated pools, indices for handles, event-loop-bounded lifetime, and no runtime reference counting at all.
