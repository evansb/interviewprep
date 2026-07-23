# Chapter 9 — Ownership

Ownership is a lifetime contract, not a spelling preference. The best design makes one owner obvious, makes borrowing visible at interfaces, and performs no runtime ownership bookkeeping on the latency-critical path. `unique_ptr`, `shared_ptr`, and `weak_ptr` are useful because they encode different contracts; substituting one for another changes program semantics.

A smart pointer does not make an object thread-safe, prevent all dangling references, or make allocation cheap. It answers who participates in destruction. Correctness starts by separating that question from access synchronization and from storage allocation.

## 90-Second Screen

Retain these facts:

1. A raw pointer or reference normally borrows. It does not extend an object's lifetime. The caller must keep the referent alive for every use.
2. `unique_ptr<T>` means exclusive ownership. Move it to transfer the obligation to destroy; pass `T&` or `T*` to borrow.
3. `shared_ptr<T>` means shared lifetime, not shared synchronization. Independent handles may safely update the shared ownership bookkeeping, but concurrent access to `T` still follows the ordinary data-race rules.
4. A `shared_ptr` control block has two logical lifetime milestones: last strong owner destroys the object; last weak observer permits the control block to be reclaimed.
5. `weak_ptr::lock()` performs an atomic test-and-acquire of ownership. `expired()` followed by another operation is not a safe check-then-use sequence.
6. Reference counting can leak cycles and can put deallocation or a destructor cascade on the thread that drops the last reference.

Be ready to defend two decisions:

- If one component can own the object, use `unique_ptr` and borrow from it. Do not choose `shared_ptr` merely to avoid writing down the lifetime relation.
- If lifetime is genuinely shared, decide where copies, last-release destruction, cycles, and weak retention can occur. Measure count contention and tail latency under the real thread topology before allowing ownership traffic on a hot path.

---

## 9.1 Ownership Vocabulary — Core

An ownership design answers three separate questions:

- **Object lifetime** — when does the pointed-to object's destructor run?
- **Control-block lifetime** — for `shared_ptr`/`weak_ptr`, when is the bookkeeping (counts, deleter) itself freed? This can outlive the object.
- **Synchronization of object state** — is it safe for one thread to read or write `*p` while another thread holds a handle to the same object? Reference counting says nothing about this by itself.

The first two are lifetime questions. The third is a memory-model question. A mutex, atomic member, immutability, or another synchronization protocol can make shared access valid; owning handles alone cannot.

### Owner, object, storage, and borrower

An **owner** is responsible for eventually ending a resource's lifetime. A **borrower** may access the resource for a bounded interval but does not participate in deciding when it dies. RAII ties ownership to an object's lifetime: acquiring a resource establishes a class invariant, and the destructor releases it on every normal scope exit and during exception unwinding.

For a dynamically allocated `T`, distinguish the `T` object's lifetime from the storage that contains it. Destruction ends the object's lifetime. Releasing the allocation returns its storage. These usually happen together for `unique_ptr`, but they can be separated by a `shared_ptr` control block, a pool, an arena, placement construction, or a long-lived weak observer.

```
owner handle ─────────owns────────▶ object ─────occupies────▶ storage
     │                                  ▲
     └── borrower T* / T& ──────────────┘

Required invariant: every borrower stops using the object before its lifetime ends.
```

The pointer value does not carry proof that the invariant holds. It may remain numerically unchanged after destruction, yet dereferencing it is invalid. Reusing the same address for another object does not generally repair old references; lifetime and pointer-provenance rules still matter (Chapter 3).

Four roles cover most interface decisions:

| Role | Type | Meaning |
|---|---|---|
| Exclusive owner | `unique_ptr<T>` | Exactly one owner; destruction is deterministic |
| Shared owner | `shared_ptr<T>` | Lifetime ends when the last owner releases it |
| Non-owning shared-lifetime observer | `weak_ptr<T>` | Refers to a control block; call `lock()` to obtain temporary ownership |
| Borrower, lifetime guaranteed externally | `T*`, `T&`, `span`, or a view | No ownership machinery; can dangle if the guarantee is broken |

Default to `unique_ptr` and raw observers. Reach for `shared_ptr` only when lifetime is genuinely shared and unpredictable — no single party can be named the owner. If you can name the owner, do.

### Raw pointers and references are views

Raw pointers and references are the normal vocabulary for borrowing. A reference expresses that the function requires an object; a pointer can express optionality with `nullptr`. Neither says how the object was allocated or who will destroy it.

```cpp
#include <memory>
#include <string>

struct Order {
    std::string symbol;
};

void validate(const Order& order) {             // required borrow
    (void)order.symbol;
}

void maybe_validate(const Order* order) {       // optional borrow
    if (order != nullptr) {
        validate(*order);
    }
}

void route(std::unique_ptr<Order> order) {       // ownership enters
    validate(*order);                            // borrow inside the scope
}                                               // destruction unless moved onward

int main() {
    route(std::make_unique<Order>(Order{"EURUSD"}));
}
```

The signatures make the contract readable without inspecting a comment. `route` may store, destroy, or transfer the order. `validate` cannot extend the lifetime unless it deliberately creates some separate owning relationship. `const` restricts mutation through that access path; it does not imply ownership and does not make concurrent mutation elsewhere safe.

Borrowing requires an explicit bound:

- A synchronous function call commonly borrows until it returns.
- An object member such as `Engine* engine_` may borrow until the containing object is destroyed, but construction and teardown must enforce that `Engine` outlives it.
- An iterator, `span`, `string_view`, callback capture, or pointer into a container borrows from underlying storage and is additionally subject to invalidation.
- A queued callback crosses time. Capturing `this` is safe only if cancellation/joining or another structural rule guarantees the object survives execution. Otherwise capture an owning `shared_ptr`, a `weak_ptr`, a stable ID, or copied data according to the intended semantics.

Returning a view into a local object is the canonical failure:

```cpp
#include <string>
#include <string_view>

std::string_view bad_symbol() {
    std::string local = "EURUSD";
    return local;                    // compiles; returned view dangles
}
```

This function is intentionally wrong. `string_view` is pointer-and-length-like; it does not preserve `local`. The same reasoning catches a returned `T*` to a local, a lambda capturing a local by reference and escaping, or a member pointer into a vector invalidated by reallocation.

There is no standard `std::observer_ptr` in C++23. A project-specific observer wrapper can document intent, but unless it carries a real lifetime mechanism it has the same safety boundary as `T*`. Conversely, a raw owning pointer is sometimes forced by a C interface; wrap it into RAII immediately at the boundary so exceptional exits cannot leak it.

### A decision procedure

Ask these questions in order:

1. Can the object have automatic storage duration or be a direct member? Prefer that: there is no separate allocation and lexical lifetime is visible.
2. If dynamic lifetime is needed, can one owner be named? Use `unique_ptr`.
3. If several components must keep it alive independently and no owner can dominate the others, use `shared_ptr`.
4. Does an observer need to notice that a shared object may have expired? Use `weak_ptr`.
5. Is the lifetime bounded structurally by an arena, session, event-loop turn, or pool epoch? Use non-owning pointers, indices, or handles whose generation/lifetime rule is enforced elsewhere.

Do not begin with “which smart pointer?” Begin with “what event ends this lifetime, and which component is responsible for that event?”

---

## 9.2 `unique_ptr`: Exclusive Ownership — Core

`std::unique_ptr<T, D>` is a move-only RAII handle: one owner, deterministic destruction, no reference count, and no synchronization traffic. Its destructor invokes `D` if it holds a non-null pointer.

```cpp
#include <memory>

struct Foo {
    explicit Foo(int) {}
};

int main() {
    auto p = std::make_unique<Foo>(42); // one allocation for Foo
    auto q = std::move(p);              // p is now null
    Foo* raw = q.get();                 // observe, do not own
    (void)raw;

    Foo* esc = q.release();             // caller must now delete
    delete esc;
    q.reset(new Foo(7));                // adopt another allocation
    if (q) { /* explicit operator bool */ }
}
```

- **Move-only.** Copy is deleted, which makes ownership statically checkable — a `unique_ptr` in a signature is self-documenting.
- **`release()` does not destroy.** It returns the stored pointer and leaves the handle empty. Use it only when transferring to an API that assumes the destruction obligation.
- **Self-reset is invalid usage.** `p.reset(p.get())` leaves `p` holding the pointer value while deleting the object. A later access dangles and a later destruction may delete the same address again.
- **`make_unique`** (C++14) exists mainly for readability and to avoid a bare `new`; pre-C++17 it also closed an exception-safety gap when another function argument threw before a raw allocation had been adopted. Since C++17, each argument evaluation is indeterminately sequenced relative to the others, closing that particular leak (Chapter 4). `make_unique` remains the default, though it cannot supply a custom deleter and could not use parenthesized aggregate initialization before C++20.
- **`make_unique_for_overwrite`** (C++20) default-initializes instead of value-initializing — avoids zeroing (and page-faulting) a large buffer, e.g. `make_unique_for_overwrite<char[]>(1<<20)`.
- **`unique_ptr<T[]>`** calls `delete[]`, offers `operator[]`, and forbids derived→base conversion (which would silently apply the wrong stride).
- **Incomplete types are allowed**, which is the basis of PIMPL (Ch. 44). With `default_delete`, `T` must be complete where deletion is performed. The usual PIMPL class declares its destructor in the header and defines it in the `.cpp` after the implementation type is complete; defaulting it inline commonly triggers a completeness diagnostic in `default_delete`.

**Size.** Implementations commonly make `unique_ptr<T>` with a stateless deleter the size of one pointer, using empty-base or equivalent storage optimization. The standard does not require that representation. A stateful deleter — a function pointer or capturing lambda — normally makes the handle larger.

**Cost.** Dereference needs no reference-count operation, and a move transfers the stored pointer and deleter state. Destruction adds the deleter call when non-null; for the default deleter, allocation/deallocation usually dominates wrapper overhead. Calling convention details can also differ from a raw pointer because `unique_ptr` is a non-trivial class. Check generated code if a non-inlined ownership boundary is material; no portable rule promises register passing or pointer-sized storage.

### Interface guidance

| Signature | Meaning |
|---|---|
| `void f(std::unique_ptr<T>)` | Sink — takes ownership |
| `std::unique_ptr<T> f()` | Source — transfers ownership out |
| `void f(T*)` / `void f(T&)` | Observe — no ownership |
| `void f(const std::unique_ptr<T>&)` | Almost always wrong — take `T*`/`T&` instead |
| `void f(std::unique_ptr<T>&)` | May replace the caller's pointer — rare, comment it |

Passing by value is intentional for a sink. The call site must write `std::move(p)`, exposing the transfer. A sink can then move the handle into storage. Passing `unique_ptr&&` can also express a sink, but it remains a reference to the caller's handle until moved from; taking by value gives the callee its own owner immediately.

### Custom deleters

The deleter is `unique_ptr`'s second template parameter and part of its type. `shared_ptr` type-erases the deleter into the control block instead (§9.3), so a `shared_ptr<T>` with any deleter is a single type. That asymmetry — deleter-in-type vs. deleter-erased — is a common point of confusion.

The following fragment assumes the corresponding declarations for `pool` and `Node`; it illustrates representation choices rather than a complete program:

```cpp
#include <cstdio>
#include <memory>

// Stateless function object: commonly no footprint; the call can be inlined
struct FileCloser { void operator()(std::FILE* f) const noexcept { std::fclose(f); } };
using FilePtr = std::unique_ptr<std::FILE, FileCloser>;

// Function pointer: commonly adds a pointer-sized field and an indirect call
using FilePtr2 = std::unique_ptr<std::FILE, int(*)(std::FILE*)>;
FilePtr2 f{std::fopen("x", "r"), &std::fclose};

// Capturing lambda: size grows with the capture; the type is unnameable without decltype
auto del = [&pool](Node* n){ pool.release(n); };
std::unique_ptr<Node, decltype(del)> n{pool.acquire(), del};
```

A deleter must be callable with the stored pointer. Treat it as a non-throwing cleanup operation: `unique_ptr`'s destructor is `noexcept`, so an escaping exception terminates the program.

`unique_ptr` can be adapted to non-pointer handles by giving the deleter a nested `pointer` type. This POSIX-only sketch wraps a file descriptor:

```cpp
#include <memory>
#include <unistd.h> // POSIX close

struct FdDeleter {
    struct pointer {                       // NullablePointer: needs ==, construction from nullptr_t
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

This is legal and occasionally useful; a purpose-built `class Fd` with the rule of five is usually clearer. Know it as a capability rather than a default.

The highest-value use of a custom deleter is wrapping a C API. This fragment assumes `p` and `n` are already defined:

```cpp
std::unique_ptr<FILE, decltype(&std::fclose)> f{std::fopen(p, "r"), &std::fclose};
std::unique_ptr<void, decltype(&::free)>      m{std::malloc(n), &::free};
```

`decltype(&fn)` is convenient but pays the function-pointer cost above; write a stateless functor for anything hot. The same idea works for returning an object to a pool instead of freeing it — a `PoolDeleter<T>` holding a `Pool<T>*` and calling `pool->destroy(p)` in `operator()`.

`shared_ptr` deleters are supplied at construction, not chosen via the type:

```cpp
#include <cstdio>
#include <memory>

struct SharedFileCloser {
    void operator()(std::FILE* file) const noexcept {
        if (file != nullptr) {
            std::fclose(file);
        }
    }
};

constexpr const char* p = "ownership-example.txt";
std::shared_ptr<FILE> f{std::fopen(p, "r"), SharedFileCloser{}};
```

The null check matters: a `shared_ptr` constructed from a null pointer and a deleter still has a control block and eventually invokes that deleter. A `unique_ptr` invokes its deleter only when its stored pointer is non-null. The `shared_ptr` trade is type uniformity and runtime flexibility, paid for with control-block state and type-erased deletion (§9.3). `shared_ptr<T[]>` (C++17) added a correct array specialization; before that there was none.

---

## 9.3 `shared_ptr`: Control Block and Construction — Core

`std::shared_ptr<T>` implements shared ownership through a **control block** associated with a managed object. Implementations commonly store two pointer-sized fields in each handle — a stored pointer used by `get()` and a pointer to the control block — but the standard specifies behavior, not this representation. Keeping the stored pointer conceptually separate from ownership is what permits the aliasing constructor (§9.7).

```
shared_ptr<T>                         Control block
┌────────────────┐                   ┌────────────────────────┐
│ T* ptr         │──▶ object         │ strong count  (atomic) │
│ ctrl* cb       │──────────────────▶│ weak count    (atomic) │
└────────────────┘                   │ deleter (type-erased)  │
                                      │ allocator              │
                                      │ [+ object, if make_shared]
                                      └────────────────────────┘
```

### The two logical counts

- **Strong count** — number of `shared_ptr`s. Reaches zero → the object is destroyed (the deleter runs).
- **Weak ownership count** — tracks `weak_ptr`s and whatever bookkeeping the implementation needs while strong owners exist. Once no strong or weak handles remain, the control block can be reclaimed.

The precise counter encoding is implementation detail; the two observable events are portable. Last strong release destroys the managed object. Destroying the last remaining weak observer later permits control-block deallocation. This separation lets `weak_ptr` determine safely whether ownership can still be acquired.

### What the atomics order, and what they don't

Operations on distinct `shared_ptr` instances that share a control block can occur concurrently without corrupting the ownership bookkeeping. The pointed-to object is not thereby atomic. Nor may two threads perform conflicting non-const operations on the same ordinary `shared_ptr` variable without synchronization; use `atomic<shared_ptr<T>>` when the handle itself is shared for atomic publication (§9.6).

Do not use reference-count activity as publication or as a substitute for synchronizing object state. If one thread initializes an object and another consumes it, the transfer still needs a release/acquire edge, a lock, thread-start synchronization, or an equivalent protocol. If two owners concurrently mutate ordinary members, that is still a data race. Chapter 25 owns the detailed memory-order argument.

Copy construction must add an owner and destruction must release one; implementations normally use atomic operations on the control block. A move transfers the handle without adding an owner. Under contention — many cores copying handles that share a control block — the cache line containing the count can migrate among cores, raising both typical and tail cost. Any cycle or nanosecond figure is platform- and workload-specific, so benchmark the deployed standard library with the production sharing pattern.

### `make_shared` vs. `new` + `shared_ptr`

```cpp
#include <memory>

struct Foo {};

std::shared_ptr<Foo> p{new Foo};    // normally separate object/control-block allocations
auto q = std::make_shared<Foo>();   // normally one combined allocation
```

`make_shared<T>(args...)` normally obtains one allocation containing both the object and control-block state. The standard specifies that user replacement of `operator new` for `T` is not used for this construction; the exact layout remains an implementation choice. `allocate_shared<T>(alloc, args...)` obtains the storage through the supplied allocator (Chapter 8).

**Advantages.** One allocation rather than the usual object allocation plus control-block allocation means fewer allocator calls and less allocation metadata. Locality can improve when the implementation places frequently touched control-block data near `T`, but it can also create interference between refcount writes and read-mostly object data. Measure rather than assuming colocation is a cache win. Construction is exception-safe: if object construction throws, the allocated state is reclaimed.

**Disadvantages.**

1. **No custom deleter argument.** `make_shared` uses the library's allocator-aware destruction path. A custom deleter requires a direct `shared_ptr(ptr, deleter)` construction.
2. **Access checks occur in library construction machinery.** Making a factory a friend does not by itself let `make_shared` call a private constructor. A public constructor with a private passkey is one workaround, shown in §9.5.
3. **Weak-pointer retention.** Because object and control block are one allocation, the object's *storage* cannot be released until the *weak* count also reaches zero — see §9.4.
4. `make_shared_for_overwrite<T>()` (C++20) uses overwrite-oriented default initialization, which can avoid zero-initializing scalar buffers that will immediately be filled. `make_shared<T[]>(n)` (C++20) covers arrays.

When shared ownership is necessary, start with `make_shared`. Use a direct `shared_ptr` constructor when a custom deleter is required or when separating a large object allocation from a control block avoids material weak-retention cost. Do not construct two independent `shared_ptr`s from the same raw pointer.

---

## 9.4 `weak_ptr`, Cycles, and Retention — Core

`std::weak_ptr<T>` observes a `shared_ptr` control block without contributing a strong owner. It cannot be dereferenced directly.

```cpp
if (auto sp = wp.lock()) {   // atomically increments the strong count only if it is nonzero
    sp->use();                // alive for the duration of sp
}
```

`lock()` is the safe test-and-acquire operation: it atomically returns a new `shared_ptr` if the object has not expired, otherwise an empty one. `expired()` is a snapshot that can become stale immediately if another thread drops the last strong reference. It is fine for pruning or metrics, but it must not justify a later dereference. Implementations commonly need a conditional refcount update for `lock()`, which can be more expensive than a handle move and can contend. Measure before placing it in a per-message loop.

Common uses: breaking ownership cycles (below); a `map<Key, weak_ptr<V>>` cache whose values may expire and whose dead entries are pruned later; observer/subscriber lists that skip dead subscribers instead of dangling; and capturing `weak_ptr` in an async callback so the callback becomes a no-op if the object is already gone —

```cpp
timer.async_wait([w = weak_from_this()](auto ec) {
    if (auto self = w.lock()) self->on_timer(ec);
});
```

— versus capturing a `shared_ptr`, which keeps the object alive until the callback fires. Both are legitimate; picking between them is a lifetime decision, not a style choice (contrast with the I/O session in §9.5, which deliberately keeps itself alive).

### Cycles

Reference counting cannot collect cycles. Two objects holding `shared_ptr`s to each other keep each other's strong count at one forever:

```cpp
#include <memory>

struct Node { std::shared_ptr<Node> next; };

void create_cycle() {
    auto a = std::make_shared<Node>();
    auto b = std::make_shared<Node>();
    a->next = b;
    b->next = a;
} // both external owners leave; the cycle keeps both nodes alive
```

This is a real logical leak: neither destructor runs after external owners disappear. `use_count()` is not a design tool and cannot identify which edges are supposed to own. Detect cycles with destructor counters in focused tests, heap-growth observations, and a leak detector; then inspect the ownership graph.

Cycles show up as parent↔child trees where children point back at parents, observer/subject pairs holding each other, and a particularly easy-to-miss form: an object whose stored `std::function` captures `shared_from_this()`, so the object indirectly owns itself.

**Fixes, in order of preference:**

1. **Direction rule.** Decide which direction is ownership: owner→owned is `shared_ptr`, owned→owner is `weak_ptr` (or a plain raw pointer/reference when the owner is structurally guaranteed to outlive, e.g. a child never outlives its tree — cheaper and clearer than `weak_ptr` when that invariant holds).
2. **Break explicitly at teardown** with a `clear()`/`dispose()` that nulls the links, for graphs with genuine cycles that can't be redesigned away.
3. **Own the graph in an arena** (Chapter 8) and make edges raw pointers or indices. The whole graph dies together, cycles stop owning, and indices can be compact and independent of the arena's base address.

### Weak-pointer retention after `make_shared`

Because `make_shared` allocates the control block and the object together, dropping the last strong reference runs `~T()` but cannot free the block while any `weak_ptr` remains — the storage is shared with the still-live weak count.

```cpp
#include <array>
#include <memory>

void retain_storage() {
    using Big = std::array<char, 100 << 20>;
    auto big = std::make_shared<Big>();
    std::weak_ptr<Big> w = big;
    big.reset();   // Big's lifetime ends, but the combined allocation remains
    w.reset();     // now the allocation can be released
}
```

The destructor ran and the object's lifetime ended — using it would be UB — but its allocation remains. A `map<Key, weak_ptr<Entry>>` cache that never prunes can retain every combined allocation after its value expires. Process RSS may climb depending on allocator and operating-system page behavior; the portable statement is that the storage cannot yet be deallocated. This is retention, not a failure to run the destructor.

Remedies: prune the weak map periodically (`expired()` is fine here, since a stale answer just delays the prune by one cycle); use `shared_ptr<T>(new T)` for large objects with expected long-lived weak observers, so strong-zero frees the object immediately at the cost of a second allocation; or don't hold `weak_ptr`s longer than necessary — store a key/index instead when you can.

The control block itself is retained until weak-zero regardless of construction form. Its size is implementation- and deleter/allocator-dependent, so a large number of dead weak entries can cost material memory even for small objects.

---

## 9.5 `enable_shared_from_this` — Core

A member function sometimes needs to hand out a `shared_ptr` to its own object. Doing it naively creates a second, independent control block:

```cpp
struct Bad {
    std::shared_ptr<Bad> self() { return std::shared_ptr<Bad>(this); }   // second control block
};
auto p = std::make_shared<Bad>();
auto q = p->self();   // two control blocks, each with strong count 1 -> double free
```

Inheriting from `std::enable_shared_from_this<T>` fixes it. A suitable `shared_ptr` construction associates the base's hidden weak state with the existing control block. `shared_from_this()` can then return another owner of that same control block; it throws `std::bad_weak_ptr` if no association exists.

Consequences follow directly from "the weak member is set by the `shared_ptr` constructor":

- **The object must already be associated with a `shared_ptr` control block.** Calling `shared_from_this()` on an ordinary stack object or a solely `unique_ptr`-owned object throws `bad_weak_ptr`.
- **It cannot be called from the constructor** — the owning `shared_ptr` doesn't exist yet while the constructor is still running inside `make_shared`. The fix is a two-phase factory: construct, then call an `init()`/`start()` that may use `shared_from_this()`.
- **The base must be accessible and unambiguous, with the intended specialization.** Private or ambiguous inheritance prevents the expected association. Complicated hierarchies with multiple specializations deserve a simpler ownership design.
- **`weak_from_this()`** (C++17) returns a `weak_ptr` directly and does not throw when the object is unowned — it returns an empty `weak_ptr` instead. Prefer it in async callbacks where you'd `lock()` anyway.

The passkey idiom pairs naturally with a factory that also calls `start()`. The networking names below are placeholders for an asynchronous API; the important part is the construction order:

```cpp
class Session : public std::enable_shared_from_this<Session> {
    struct Key { explicit Key() = default; };   // only Session can construct a Key
public:
    Session(Key, Socket s);
    static std::shared_ptr<Session> create(Socket s) {
        auto p = std::make_shared<Session>(Key{}, std::move(s));
        p->start();                                    // shared_from_this() is now valid
        return p;
    }
    void start() {
        sock_.async_read([self = shared_from_this()](auto ec, auto n) {   // keep-alive capture
            self->on_read(ec, n);
        });
    }
};
```

`Key` makes the constructor unconstructible outside the class while still public (required for `make_shared` to call it), which solves the private-constructor problem from §9.3 at the same time. This shape — the Asio session pattern — deliberately captures `shared_ptr` rather than `weak_ptr`: a live I/O operation should keep the object alive until it completes, not be silently cancelled if the object goes out of scope elsewhere. Compare with the timer callback in §9.4, where the opposite choice is correct.

---

## 9.6 Hot-Path Alternatives — Core

No universal cheapest-to-most-expensive ordering exists: locality, contention, allocation strategy, and destruction work dominate. The table names mechanisms to measure on a typical 64-bit implementation.

| Construct | Handle footprint (typical) | Ownership traffic on copy | Main risk |
|---|---|---|---|
| Borrowed `T*` | one pointer | none | Dangling if the external lifetime rule fails |
| Pool index such as `uint32_t` | 4 bytes | none | Needs bounds/generation validation and stable pool lifetime |
| `unique_ptr<T>` with empty deleter | often one pointer | cannot copy; move has no count update | Last release performs destruction/deallocation |
| Intrusive handle (§9.8) | often one pointer | count update if thread-safe | Type intrusion; weak observation is not built in |
| `shared_ptr<T>` | often two pointers | shared-count update | Allocation, contention, cycles, last-release work |
| `weak_ptr<T>::lock()` result | a `shared_ptr` | conditional ownership acquisition | Expiry branch and possible count contention |

Sizes are what mainstream implementations produce, not a portable guarantee.

**Don't copy a `shared_ptr` into a function that only reads synchronously.** Pass `const T&` or `T*`; the caller's owner already keeps the object alive for the call. Passing by value adds and later releases an owner, which normally updates shared bookkeeping. Pass by value when the callee may retain ownership.

```cpp
void use(const std::shared_ptr<Foo>& p);   // implies you might copy — usually not what you want
void use(const Foo& f);                    // states you don't own; no refcount touched
void sink(std::shared_ptr<Foo> p);         // correct when you do take ownership
```

**Move when transferring an existing owner.** A move does not add an owner. Do not move merely to save a count update if the source must remain an owner.

**Contention, not the atomic instruction, is the real cost.** A `shared_ptr` to shared config copied by every thread on every message bounces the count's cache line between cores, and the cost grows with contention and core count (true sharing, Ch. 28). The fix is not a faster refcount; it's to stop refcounting on the hot path — hold one reference per thread hoisted out of the loop, or use RCU/hazard pointers (Ch. 26) for read-mostly shared state.

**`std::atomic<std::shared_ptr<T>>`** (C++20) provides atomic publication and replacement of a shared owner. The standard does not guarantee that the specialization is lock-free; query `is_lock_free()` on the target, but remember that lock-free says nothing about refcount cache-line traffic or destruction latency. An acquire load can safely publish an immutable object after a release store, yet every returned `shared_ptr` still owns. Compare it under load with RCU, hazard pointers, or versioned buffers when reads are frequent.

**`shared_ptr` is not thread-safe for a single instance.** Two threads copying *different* `shared_ptr`s to the same object is fine — the count is atomic. Two threads writing the *same* `shared_ptr` variable is a data race: the object pointer and control-block pointer are two ordinary, non-atomic words.

**Destruction can land on the hot thread.** Dropping the last reference to a large object graph runs its destructor cascade on that thread. One mitigation is a preallocated deferred-destruction queue: transfer a retiring owner to a housekeeping thread and let the final release occur there. The queue needs a defined bounded-capacity policy, and shutdown must drain it; otherwise the mitigation replaces a latency spike with a leak or an unbounded queue.

**Best of all: no runtime counting.** In a latency-sensitive hot path, objects often come from a preallocated pool (Chapters 8 and 55), handles are compact indices or raw pointers, and lifetime is bounded by an event-loop iteration or session. Reference counting exists for genuinely unpredictable lifetime; a structurally bounded lifetime does not need it.

### Worked diagnosis: publication is correct, retirement is not predictable

Suppose a pricing service publishes an immutable `Config` to eight worker threads:

```cpp
#include <atomic>
#include <memory>

struct Config {
    // Read-only after publication. Real payload omitted.
    int venue_count;
};

std::atomic<std::shared_ptr<const Config>> current;

void publish(std::shared_ptr<const Config> next) {
    current.store(std::move(next), std::memory_order_release);
}

int read_venue_count() {
    auto snapshot = current.load(std::memory_order_acquire);
    return snapshot ? snapshot->venue_count : 0;
}
```

The correctness argument is sound: construction and initialization are sequenced before the release store; an acquire load that observes that value makes those writes visible to the reader. Immutability removes later member races. The local `snapshot` keeps the selected version alive even if the publisher replaces `current`.

Yet a latency trace shows occasional worker spikes immediately after configuration updates. Diagnose from mechanisms, not from the word “atomic”:

1. **Separate publication from reclamation.** The atomic operation can publish correctly while the last reader of the old version performs its destructor.
2. **Instrument object versions.** Record version ID and thread ID in a lightweight retirement hook or test destructor. Correlate spike samples with old-version destruction; do not add heavy logging to the measured path.
3. **Measure the right distribution.** Compare p50, p99, and maximum per-message latency before and after updates. Run with the production worker count and pinning because count contention depends on which cores share the control block.
4. **Inspect the object graph.** A `Config` that owns maps, strings, plug-ins, or other shared objects can cause many deallocations on final release. The refcount update may be modest while teardown is large and input-dependent.
5. **Confirm rather than guess.** A controlled build can give `Config` a destructor that enqueues only an ID and timestamps its start/end outside the critical benchmark. Allocator profiling can count frees during the spike.

The first redesign is to keep one snapshot owner per processing batch rather than load/copy per message. That reduces count traffic while preserving the simple publication proof. If final destruction still reaches a worker, publish a wrapper whose deleter transfers the retired payload to a bounded housekeeping queue, or have the publishing thread retain old versions until a grace condition says readers have advanced.

For a higher read rate, an RCU-style scheme can make each read a cheap read-side critical section and reclaim retired versions after a grace period. It gives up the automatic, per-object lifetime of `shared_ptr` and requires a rigorously implemented reclamation protocol. A two- or three-buffer scheme with an atomic index is smaller still, but only if the writer can prove it never overwrites a buffer still in use. The success measures are no lifetime violations, lower tail latency during update bursts, bounded retired memory, and clean shutdown. Keep the `atomic<shared_ptr>` version if it already meets those targets; it is a legitimate baseline, not an automatic performance bug.

---

## 9.7 Deep Dive: Aliasing Constructor — Deep dive
```cpp
template <class Y> shared_ptr(const shared_ptr<Y>& r, element_type* p) noexcept;
```

Creates a `shared_ptr` that shares `r`'s control block (refcount incremented, no new allocation) but points at `p`, which need not be part of `r`'s object at all. This is the reason the pointer is stored separately from the control block (§9.3).

```cpp
#include <memory>
#include <string>

struct Config { std::string host; int port; };
std::shared_ptr<Config> cfg = std::make_shared<Config>();

std::shared_ptr<std::string> host{cfg, &cfg->host};   // keeps the whole Config alive
// host.use_count() == 2; cfg.reset(); host is still valid; ~Config runs when host is destroyed
```

This is the standard way to hand out a `shared_ptr` to part of a shared object without copying or exposing the whole thing. Other uses include a `shared_ptr<const std::byte>` view into a shared receive buffer, so a parsed message can outlive the parse loop without copying (Chapter 51), and `shared_ptr<void>{owner, nullptr}` as a type-erased keep-alive token. A handle can therefore have a null stored pointer while still owning through a nonempty control block. C++20 added a move-based aliasing overload that transfers `r` without first adding another owner.

Hazards: `use_count()` reflects the shared control block, so a `shared_ptr<string>` aliasing a `Config` reports the owner's count, not a count intrinsic to the string. Nothing validates that `p` points inside `r`'s object or has a compatible lifetime. An unrelated pointer can dangle while the control block remains live. Aliasing a small member of a large object pins the whole parent allocation. Reseating `cfg` does not update `host`; the alias still points at and keeps alive the old `Config`.

---

## 9.8 Deep Dive: Intrusive Reference Counting — Deep dive
Intrusive means the reference count lives inside the object rather than in a separate control block:

```cpp
#include <atomic>
#include <cstdint>

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
// paired with a handle type calling add_ref()/release() in its copy constructor/destructor
```

Libraries and object models provide handle types around this pattern. The essential contract is that every handle construction, copy, move, and destruction updates the embedded count correctly.

| | `std::shared_ptr` | Intrusive |
|---|---|---|
| Handle size, typical 64-bit implementation | two pointers | one pointer |
| Allocation shape | combined allocation with `make_shared`, otherwise object plus control block | no separate control-block allocation |
| Count location | control block | inside the object |
| Weak references | built in | needs extra machinery |
| Works with an existing type unmodified | yes | no — the type must carry the count |
| Recovering ownership from a raw `T*` | needs the original control block, normally via `enable_shared_from_this` | possible only under the handle's documented adopt/add-ref convention |

Intrusive ownership can reduce handle footprint and eliminate a separate control-block allocation. It also lets a subsystem place the count deliberately, choose a thread-confined non-atomic policy, or combine it with domain-specific reclamation. Those are not automatic cache wins: embedding a frequently written count can invalidate a cache line containing otherwise read-mostly object data. Alignment and field placement matter.

The sketch assumes `add_ref()` is called only while the caller already has a valid way to keep the object alive. Incrementing a count from zero through a stale raw pointer cannot resurrect a destroyed object. It also omits overflow handling, deletion-policy constraints, and weak observation. These omissions are why an intrusive pointer should be a reviewed library type, not copied into each domain class.

Atomic ordering must ensure that the zero-count path may safely run destruction, while a non-atomic count is valid only when the ownership protocol is thread-confined. Chapter 25 covers the derivation. As with `shared_ptr`, refcount ordering does not synchronize arbitrary concurrent member access.

Weak references are the major design cost. Once the embedded object is destroyed, its embedded count no longer exists, so safe weak observation needs separate storage or another lifetime layer. If the domain requires weak observers, aliasing, custom deleters, and arbitrary external types, `shared_ptr` may be the less risky choice despite its footprint.

---

## 9.9 Reference: Choosing an Ownership Model

Choose the weakest mechanism that truthfully represents the lifetime. “Weakest” means the fewest participants in destruction, not the least safe type.

| Situation | Representation | Why it fits | Primary failure/cost |
|---|---|---|---|
| Value fits directly in its parent or scope | Value member / automatic object | Lexical or enclosing lifetime; no separate owner | Copy/move size; enclosing object may become large |
| One subsystem owns a dynamic object | `unique_ptr<T>` | Transfer is explicit and statically exclusive | Allocation and final destruction still occur |
| Function observes a required live object | `T&` / `const T&` | Required borrow; no ownership traffic | Caller can violate lifetime; reference cannot express absence |
| Function observes an optional live object | `T*` / `const T*` | `nullptr` expresses absence | Same dangling boundary as any borrow |
| Contiguous borrowed sequence | `span<T>` / `span<const T>` | Carries pointer and extent | Underlying storage can expire or be invalidated |
| Independent components must prolong lifetime | `shared_ptr<T>` | Last owner decides destruction dynamically | Count traffic, control block, cycles, final-release work |
| Observer should not prolong shared lifetime | `weak_ptr<T>` | Safe conditional acquisition with `lock()` | Control-block retention and conditional count update |
| Many handles, type is under subsystem control | Intrusive handle | Smaller handle; count placement/policy is controllable | Invasive type, adoption rules, weak support |
| Objects die as a group | Arena plus pointer/index | Bulk reclamation; cycles among edges do not own | No individual destruction; arena must outlive all views |
| Stable preallocated slots | Index plus generation | Compact, relocation-independent, detects stale reuse | Lookup/validation; generation wrap and pool lifetime |

Three distinctions improve interview answers:

- **Transfer versus share.** A function accepting `unique_ptr<T>` takes the sole obligation. A function accepting `shared_ptr<T>` by value joins a shared obligation. A function accepting `T&` joins neither.
- **Optionality versus lifetime uncertainty.** `T*` can mean “maybe no object,” but it cannot safely discover that a formerly live object expired. `weak_ptr` can discover expiry because the control block remains.
- **Lifetime versus reclamation schedule.** `shared_ptr` identifies when destruction is allowed, not which thread or latency window performs it. Pools, epochs, queues, and arenas control reclamation schedule more explicitly.

A defensible low-latency decision states the condition, benefit, cost, and measurement. For example: “The parser borrows a `span<const std::byte>` because the caller owns the receive buffer through the synchronous parse. This avoids allocation and count traffic. The precondition is that no view escapes; an address-sanitized lifetime test and an API that returns owned decoded values enforce it.” That is stronger than “raw pointers are faster.”

---

## Recall Card — Core
- Ownership, storage, borrowing, and synchronization are separate contracts.
- A raw pointer, reference, `span`, or view does not extend lifetime. State the external lifetime invariant.
- `unique_ptr`: one owner, move-only, commonly pointer-sized with a stateless deleter. PIMPL requires deletion where the implementation type is complete.
- A `shared_ptr` conceptually separates its stored pointer from its control block. Last strong release destroys the managed object; last weak release permits control-block reclamation.
- `make_shared` normally uses one combined allocation, but that allocation cannot be released while weak observers remain.
- `weak_ptr::lock()` is the usual non-throwing, race-safe conversion to a temporary owner; `expired()` is a hint, not a check-then-use guard.
- Cycles are a real leak that reference counting can't collect; fix the ownership direction, or own the graph in an arena with non-owning edges.
- `enable_shared_from_this` reuses an established control block; never construct another `shared_ptr` directly from `this`.
- On a hot path, remove unnecessary owner copies and control where final destruction occurs. Measure contention and tails, not folklore.

## Common Traps — Core

- Returning a pointer, reference, `span`, or `string_view` into a local object.
- Capturing `this` in asynchronous work without a cancellation/join or keep-alive rule.
- Calling `release()` and forgetting that manual destruction responsibility escaped.
- Constructing two `shared_ptr`s independently from the same raw pointer.
- Treating `use_count() == 1` as a synchronization or uniqueness proof; another owner can appear concurrently, and the count says nothing about member access.
- Checking `expired()` and then assuming a later `lock()` must succeed.
- Capturing a `shared_ptr` to an object inside a callback stored by that same object.
- Assuming `make_shared` storage is reclaimed when the destructor runs despite long-lived weak observers.
- Publishing a `shared_ptr` through an ordinary shared variable instead of a lock or `atomic<shared_ptr<T>>`.
- Optimizing count operations while leaving an unbounded destructor cascade on the critical thread.

## Questions — Core
1. In what sense is `unique_ptr` zero-overhead, and in what sense is it not?
2. Why does a PIMPL class need its destructor defined in the `.cpp` file rather than defaulted in the header?
3. Why is a `unique_ptr` deleter part of the type, while a `shared_ptr` deleter isn't?
4. What are the two counts in a `shared_ptr` control block, and what does each one's reaching zero trigger?
5. Compare `make_shared<T>()` to `shared_ptr<T>(new T)`: name one advantage and one disadvantage of each.
6. Why can a `weak_ptr` keep megabytes of memory resident after the pointed-to object has already been destroyed?
7. Why is `if (!wp.expired()) use(wp)` unsafe, and what's the fix?
8. Give two independent fixes for a `shared_ptr` ownership cycle.
9. Why does calling `shared_from_this()` inside a constructor fail, and what's the standard workaround?
10. A producer initializes a `shared_ptr<T>` and assigns it to an ordinary global while a consumer reads that global. Why does reference counting not make this publication valid, and what publication mechanism would?

## Code-Reading Puzzle — Core
```cpp
struct Order {
    std::shared_ptr<Order> parent_leg;   // multi-leg order this one belongs to
};

struct Fill {
    std::shared_ptr<Order> order;
    std::function<void()> on_complete;
};

void attach(std::shared_ptr<Order> o, std::shared_ptr<Fill> f) {
    f->order = o;
    o->parent_leg = nullptr;                 // (a)
    f->on_complete = [f]{ f->order->parent_leg = f->order; };   // (b)
}
```

Neither line marked is the textbook `a->next = b; b->next = a;` cycle, but the function still leaks every `Order`/`Fill` pair it touches. Find the cycle — which line creates it — and give a one-line fix. Then state, in general terms, what kind of member is most likely to create this pattern outside of an obvious two-struct example.

## Design Exercise — Core
A market-data feed publishes a new order-book snapshot every few microseconds. Readers on other threads need to see a consistent, immutable snapshot — never a partially updated one — without blocking the writer.

Design the publication mechanism: state what "consistent" means here in happens-before terms, decide whether an owning handle (`shared_ptr<const Snapshot>`) held in an atomic variable is a legitimate candidate given what §9.6 says about `atomic<shared_ptr<T>>`, and name at least one alternative (double-buffering with an atomic index, RCU, hazard pointers) along with its trade-off against the `shared_ptr` approach. You don't need to write the full implementation — a short design note covering the synchronization argument and the chosen mechanism is enough.

As a smaller companion exercise, write the signatures only (no bodies) for three functions over an `Order` type: one that must take ownership and destroy or store the order, one that only inspects it and must not affect its lifetime, and one that wants to keep it alive alongside other owners.

## Prerequisites for Chapter 10 — Core
Chapter 10 covers move semantics, copy elision, and error transport. Before starting it, you should be able to explain why moving a `unique_ptr` or `shared_ptr` transfers a handle without adding an owner; state that a moved-from standard smart pointer is empty; and distinguish an ownership sink, source, shared owner, and borrower from their function signatures.
