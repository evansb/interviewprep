# Chapter 7 — Raw Allocation

**Language baseline:** standard C++23. Platform and allocator behavior is labelled
explicitly where it matters.

## 7.0 Why This Matters in an HFT Interview — Core

Every dynamic object starts as suitably sized, suitably aligned storage before its
lifetime begins as a `T`. Allocation questions test whether you can keep those
two events separate, match every acquisition with the correct release, and turn
known workload bounds into a simpler mechanism than a general-purpose
allocator.

A system allocator must handle many sizes, lifetimes, and threads. A particular
implementation may have a thread-local constant-time fast path, but cache
misses, synchronization, operating-system interaction, and page faults can
appear on slower paths. A bounded arena or pool removes most of those mechanisms
from its allocation path by giving up generality. That does not make it
universally faster or concurrent; it makes its costs easier to reason about.

This chapter owns allocation mechanisms and their correctness boundaries.
Chapter 8 owns allocator-aware containers, propagation, and `std::pmr`.

---

## 7.1 90-Second Screen — Core

Five facts:

1. A new-expression is two steps: call an allocation function for storage, then construct in place. `delete` inverts it: destroy, then deallocate. Only the allocation/deallocation functions are replaceable — the language syntax is not.
2. A pointer must return through the matching family and form: `new`/`delete`, `new[]`/`delete[]`, `malloc`/`free`, and aligned allocation with its required aligned release. A mismatch is undefined behavior.
3. C++17 standardized an over-aligned allocation path, `operator new(size_t, align_val_t)`. A custom arena or pool must still enforce every requested size and alignment itself.
4. `malloc`/`free` and `new`/`delete` are separate families with separate contracts (initialization, failure signaling, matching deallocator). Mixing them is undefined behavior even when it happens to work.
5. Arenas, pools, and slabs trade generality for bounded metadata work and predictable layout. They are not automatically thread-safe, lock-free, or immune to exhaustion.

Two decisions to make explicit for any allocator you design or discuss:

- **Where does this allocation happen?** If measurements show allocation or its
  slow paths matter on a hot path, consider preallocation and a workload-shaped
  arena or pool. Keep the general allocator when its flexibility is worth more
  than tighter latency bounds.
- **What happens on exhaustion?** Fail fast (return null / throw) or fall back (allocate more upstream)? State it. A silent fallback reintroduces exactly the tail latency the specialized allocator was built to remove.

---

## 7.2 Storage, Duration, and Object Lifetime — Core

Allocation obtains storage; initialization begins an object's lifetime in that
storage. Storage duration describes how long the storage exists, not whether the
object is initialized or who owns it.

| Storage duration | Typical source | Storage becomes available | Storage ceases to be available | Allocation-path concern |
|---|---|---|---|---|
| automatic | local variable | control enters its block | control leaves its block | usually fixed stack-frame adjustment; no general heap search |
| static | namespace-scope object, function-local `static` | before `main` or on first guarded use | program termination | initialization order and first-use guard can matter |
| thread | `thread_local` object | per-thread, before first odr-use or thread start depending on form | thread exit | per-thread footprint and initialization |
| dynamic | new-expression, allocation function, C allocator, arena | explicit request succeeds | matching release or arena backing storage ends | failure, fragmentation, locality, synchronization |

The table describes language lifetime at a high level; a compiler may optimize
away storage or keep an automatic object entirely in registers. “Stack” and
“heap” are common implementation terms, not C++ storage-duration categories.

```cpp
#include <cstddef>
#include <memory>

struct Quote {
    int bid;
    int ask;
};

int main() {
    Quote automatic{100, 101};
    static Quote static_storage{99, 102};

    alignas(Quote) std::byte raw[sizeof(Quote)]; // storage exists; no Quote yet
    Quote* placed = std::construct_at(
        reinterpret_cast<Quote*>(raw), Quote{automatic.bid, static_storage.ask});
    std::destroy_at(placed);                     // Quote lifetime ends
                                                    // raw storage still exists
}
```

`raw` has automatic storage duration for the whole block. The `Quote` within it
exists only between `construct_at` and `destroy_at`. That distinction is the
foundation of arenas, pools, and containers: storage can outlive many successive
objects.

### “Free store” and “heap”

The **free store** conventionally means storage managed by C++ allocation
functions and new-expressions. The **heap** usually means the process memory
managed by a runtime allocator. The standard does not require `operator new` to
call `malloc`, nor does it prescribe a heap data structure. A global replacement
`operator new` could draw from a static buffer; a `malloc` implementation could
use several arenas and direct virtual-memory mappings.

In an interview, name the API contract first and the likely implementation
second: “The object has dynamic storage duration because it came from a
new-expression. On this build, the allocation function is implemented by the
process heap allocator.” This avoids deriving language rules from one runtime.

### The decision boundary

```
Need a T?
  ├─ lifetime is lexical and size is modest/known ──> automatic object
  ├─ one object for program/thread lifetime ─────────> static/thread storage
  └─ lifetime or count is dynamic
       ├─ ordinary ownership and flexible sizes ─────> RAII owner + general allocator
       └─ bounded phase, size, or object count
            ├─ all die together ─────────────────────> arena
            └─ individual reuse, fixed class ────────> pool/slab
```

The choice is driven by lifetime and workload shape before microbenchmark
results. Ownership wrappers are Chapter 9 material; raw `new` below is used to
explain mechanics, not as the default application-level ownership tool.

---

## 7.3 `new` Expression vs `operator new` — Core

A new-expression (`new T(args)`) performs two steps:

1. Call an allocation function — `operator new(size_t)` — for raw storage.
2. Initialize a `T` in that storage, beginning its lifetime.

`delete p` inverts it: run `p->~T()`, then call the deallocation function `operator delete(void*)`.

```
new T(args)   ≈   void* raw = operator new(sizeof(T)); // obtain storage
                   T* p = construct T at raw;          // begin lifetime
delete p      ≈   destroy T at p;                      // end lifetime
                   operator delete(p);                 // release storage
```

This is a mental model, not a source-to-source expansion: overload lookup,
alignment, arrays, constructor failure, and deallocation-function selection add
rules. Global allocation functions are ordinary free functions. Class-specific
allocation functions are implicitly `static`. The functions can be customized;
the language syntax cannot.

**Exception safety of the pair.** If initialization throws after allocation,
the new-expression invokes a matching deallocation function when one is found.
Define the corresponding deallocation form whenever you add a class-specific
allocation form; otherwise constructor failure can leave the storage
unreleased.

**Failure.** The ordinary throwing allocation function either returns a
non-null pointer or throws `std::bad_alloc` (§7.7). `new (std::nothrow) T`
selects the nothrow allocation form; if allocation fails, the new-expression
returns null without constructing. Exceptions from `T`'s constructor still
propagate.

**Default vs value initialization** (Ch. 5 §5.4) bites hardest with `new`:

```cpp
struct Counters { int accepted; int rejected; };

int main() {
    int* a = new int;          // default-initialized: indeterminate value
    int* b = new int();        // value-initialized: zero
    int* c = new int{};        // value-initialized: zero
    Counters* d = new Counters;   // members have indeterminate values
    Counters* e = new Counters{}; // members are zero

    delete a; delete b; delete c; delete d; delete e;
}
```

### Overloading allocation functions

You can replace or overload allocation functions at two scopes.

At global scope, a program may provide definitions for the standard's
**replaceable** allocation and deallocation functions. This is how an allocator
library can intercept ordinary dynamic allocation when linked appropriately.
The forms include scalar and array, sized deallocation, nothrow, and C++17
alignment-aware overloads. A program need not replace every form, but every form
it does replace must interoperate correctly with the forms its program can pair
with. In practice, an allocator integration supplies a coherent family rather
than assuming that a library fallback will understand private metadata.

The ordinary global throwing replacement must be thread-safe, satisfy the
required default alignment, honor the `new_handler` contract, and return
non-null or throw. Alignment-aware replacements must honor the explicit
alignment as well. Avoid allocating or taking allocator-dependent locks while
instrumenting these functions; recursion and lock-order inversion are common
failure modes.

Class-scope operators let one type route through a custom allocator without changing call sites:

```cpp
#include <cstddef>
#include <cstdlib>
#include <new>

struct Node {
    static void* operator new(std::size_t n) {
        if (void* p = std::malloc(n)) return p; // replace with a real pool
        throw std::bad_alloc{};
    }
    static void operator delete(void* p) noexcept { std::free(p); }

    int payload{};
};

int main() {
    Node* p = new Node{42}; // finds Node::operator new
    delete p;               // destroys Node, then Node::operator delete
}
```

Class-scope operators are implicitly `static`, so allocation runs before
construction and deallocation after destruction. With a virtual destructor, a
delete-expression can select deallocation using the dynamic final overrider.
Without one, deleting a derived object through a base pointer is undefined
behavior and lookup starts from the static type. The diagnosis in §7.15 shows
why that is dangerous for a size-classed pool.

Extra parameters after `size_t` make a placement form, selected by `new (args) T`. A placement `operator delete` with matching parameters is called only if the constructor throws; there's no syntax to call it directly otherwise, so releasing storage for a manually destroyed object is your responsibility.

**Rules that matter:** `delete` on a pointer not from `new` is UB; double `delete` is UB; `delete nullptr` is a defined no-op, so null checks before `delete` are unnecessary. Mixing `new`/`free` or `malloc`/`delete` is UB even though it usually "works" on a given implementation.

---

## 7.4 Arrays and Matching Delete — Core

`new T[n]` and `delete[] p` are a separate function pair (`operator new[]`, `operator delete[]`) with a separate set of rules, and are the part of this material most likely to be banned outright in a modern codebase.

**The cookie.** For a `T` with a non-trivial destructor, `delete[]` must know `n` to run `n` destructors, so the implementation commonly stores that count in extra bytes ahead of the returned pointer:

```
operator new[](n*sizeof(T) + cookie)
   ↓
[ cookie: n ][ T[0] ][ T[1] ] ... [ T[n-1] ]
             ^
             pointer you get back
```

This is a common ABI approach, not a language guarantee — the standard says
nothing about how `delete[]` recovers `n`. Some ABI cases omit the cookie for a
trivially destructible element type; other cases require overhead whose size
depends on element alignment and the selected deallocation function. Treat
cookie presence, layout, and size as implementation details to inspect on the
actual ABI.

**`delete` vs `delete[]` mismatch is UB in both directions, and not merely "leaks the rest."** `delete p` on a cookied array pointer passes the allocator a pointer it never handed out — heap corruption, not a leak, and compilers generally can't diagnose it because the static type is just `T*`.

```cpp
// Intentionally undefined examples; do not run.
struct Item { ~Item() {} };

int* p = new int[10];
delete p;             // UB: scalar delete for an array allocation
Item* q = new Item[10];
delete q;             // UB: wrong form; element destruction is also wrong
```

**Arrays and polymorphism don't mix.** `Base* b = new Derived[10]; delete[] b;` is UB even with a virtual destructor, because `delete[]` strides by `sizeof(Base)`. This is the array analogue of slicing (Ch. 6).

**Exception safety.** If element *k*'s constructor throws, elements `0..k-1` are destroyed in reverse and the storage released.

**Preferred replacements.** `std::vector` (dynamic contiguous sequence),
`std::array` (fixed extent), `std::unique_ptr<T[]>` (non-growable owned array),
or an arena (§7.8). `std::make_unique<T[]>(n)` value-initializes each element.
For a large trivial buffer that will immediately be overwritten,
`std::make_unique_for_overwrite<T[]>(n)` (C++20) avoids requiring
value-initialization. Whether that improves the measured path depends on page
state and the subsequent writer.

---

## 7.5 C Allocation — Core

The C allocator underlies `operator new` on mainstream implementations, and its semantics leak upward.

| Function | Semantics | Traps |
|---|---|---|
| `malloc(n)` | `n` bytes, indeterminate content, aligned for `max_align_t` | `malloc(0)` may return null *or* a unique freeable pointer — both conforming |
| `calloc(n, sz)` | array storage with all bits zero; fails if the requested total cannot be represented/allocated | all-bits-zero is not a portable constructed value for arbitrary C++ object types |
| `realloc(p, n)` | resize C-allocated storage; may move; preserves bytes up to `min(old, new)` | on ordinary failure, returns null without freeing `p`; avoid the special `n == 0` case |
| `free(p)` | Release; `free(nullptr)` is a no-op | Double free / invalid pointer is UB and a common heap-exploitation primitive |

**`calloc` is not necessarily implemented as `malloc` plus an eager
`memset`.** On an operating system that supplies zero-filled anonymous virtual
memory, a large fresh mapping can satisfy the zero requirement without writing
every user page immediately. First access may then incur page faults. That is
implementation and OS behavior, not a C++ guarantee; benchmark allocation,
first touch, and steady reuse separately.

**Why a general `std::vector` implementation cannot rely on `realloc`.**
`realloc` belongs to the C allocation family, while a vector must use its
allocator's allocate/deallocate contract. Its element type may require move
construction and destruction rather than bytewise relocation, and a custom
allocator may not expose any in-place-resize operation. An implementation can
optimize special cases under the as-if rule, but portable vector code cannot
assume `realloc` semantics.

### How a general allocator finds free memory (qualitative)

Many current general-purpose allocators use some version of this shape; none of
it is required by the C++ standard:

- A **thread-local or per-CPU fast path** keeps recently freed small blocks in
  size classes, often avoiding a shared lock.
- Refill, cross-thread free, or cache imbalance reaches a **shared or remote
  path**, introducing synchronization and extra cache-line transfers.
- Large or unusual requests may obtain virtual memory from the operating
  system. Returning it can also involve kernel work.
- Background purging and per-thread caches trade lower allocation-path work
  against memory footprint and delayed reclamation.

Exact bins, thresholds, and behavior differ by allocator version and
configuration. Compare candidates with the real size distribution,
producer/freeing-thread relationship, warm-up state, and latency percentiles;
do not promote one microbenchmark's mean into a portable fact.

**Mixing is UB**: `free` on `new`ed memory, `delete` on `malloc`ed memory —
even where the underlying allocator happens to be the same, the replaceable
allocation function (§7.3) may have been swapped for something incompatible.

---

## 7.6 Alignment — Core

Object representation, `alignof`, and padding are Chapter 3 material — see Ch. 3 §3.2 for the theory. This section covers only the allocation-specific consequences.

C++17 standardized allocation for **over-aligned** types: types whose alignment
exceeds `__STDCPP_DEFAULT_NEW_ALIGNMENT__`. A new-expression for such a type
selects an overload taking `std::align_val_t`, and its delete-expression selects
the corresponding aligned deallocation form. Before C++17, extended alignment
support for dynamically allocated objects depended on implementation extensions
or a class-specific/manual scheme; the ordinary global form did not provide the
C++17 guarantee.

```cpp
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>

struct alignas(64) Line {
    std::uint64_t sequence{};
};

int main() {
    Line* automatic_route = new Line{7}; // aligned overload selected as needed
    delete automatic_route;

    void* raw = ::operator new(sizeof(Line),
                               std::align_val_t{alignof(Line)});
    Line* placed = std::construct_at(static_cast<Line*>(raw), Line{8});
    std::destroy_at(placed);
    ::operator delete(raw, std::align_val_t{alignof(Line)});
}
```

The explicit pair demonstrates the contract: use the same alignment and aligned
deallocation form. In manual-lifetime code where construction can throw, keep
the raw block in an RAII guard until construction succeeds.

| API | Standard | Constraints | Free with |
|---|---|---|---|
| `posix_memalign(&p, align, size)` | POSIX | `align` a power of 2 and a multiple of `sizeof(void*)` | `free` |
| `std::aligned_alloc(align, size)` | C++17 `<cstdlib>` | `size` must be a multiple of `align`; implementation availability matters | `free` |
| `_aligned_malloc` | Microsoft CRT | platform API | `_aligned_free` |
| `operator new(n, align_val_t{a})` | C++17 | Must pair with the aligned `operator delete` | aligned `operator delete` |

The first two rows are platform/C-library interfaces, not interchangeable C++
allocation-function forms. Their release columns are part of the contract.

**Manual over-alignment inside a block you already own** (an arena, a `char` buffer):

```cpp
#include <cstddef>
#include <memory>

int main() {
    alignas(std::max_align_t) std::byte buffer[256];
    void* candidate = buffer;
    std::size_t space = sizeof buffer;
    void* aligned = std::align(64, 64, candidate, space);
    if (aligned == nullptr) {
        return 1; // documented exhaustion path
    }
}
```

`std::align` adjusts `candidate` and `space` only when the requested object fits.
It avoids hand-written address rounding and its overflow traps. The alignment
must be a valid power of two. `std::assume_aligned<N>(p)` (C++20) is different:
it tells the optimizer that an already-valid pointer has alignment `N`; a false
precondition is undefined behavior and does not repair storage.

Alignment can affect instruction validity, atomic requirements, vectorization,
and cache-line placement, but those effects are target-specific. Chapter 3 owns
the hardware and object-layout mechanisms.

---

## 7.7 Allocation Failure Handling — Core

### The mechanism

The standard global throwing allocation path follows this loop:

```
loop:
   p = allocate(size)
   if (p) return p
   h = current new_handler
   if (!h) throw std::bad_alloc{}
   h()                      // must free memory, install a different handler, or terminate
   goto loop
```

`std::set_new_handler(f)` installs a process-wide handler and returns the
previous one. After an allocation attempt fails, that standard allocation path
calls the current handler and retries. A useful handler must change the
situation: release an emergency reserve, install/remove a handler, throw
`std::bad_alloc` (or a derived exception), or terminate. Returning without
making progress causes repeated calls.

An emergency-reserve design allocates a fixed block during startup. On the first
failure, its handler releases that block and removes itself; the next retry
either succeeds with the recovered memory or throws. The reserve buys shutdown
headroom, not continued normal operation. The handler must avoid ordinary
allocation, unbounded logging, and locks whose owners may themselves be waiting
for memory.

The standard global nothrow allocation form still uses the new-handler path
before returning null: `nothrow` suppresses `bad_alloc`, not the retry
mechanism, and does not mean “fail fast.” A class-specific allocation overload
can define a different policy. In either case, the nothrow argument applies to
allocation; if `T`'s constructor throws, that exception still propagates.

### Failure starts before the allocator

Untrusted counts and size arithmetic must be checked before a pointer or request
size is formed. Wraparound can turn a huge logical request into a small physical
allocation followed by an out-of-bounds write.

```cpp
#include <cstddef>
#include <limits>
#include <optional>

std::optional<std::size_t>
checked_bytes(std::size_t count, std::size_t element_size) noexcept {
    if (element_size != 0 &&
        count > std::numeric_limits<std::size_t>::max() / element_size) {
        return std::nullopt;
    }
    return count * element_size;
}
```

This check distinguishes **invalid request size** from **resource exhaustion**.
The former should normally reject input; retrying it or invoking a fallback
allocator cannot make it valid.

| Observation | Threatened invariant | Detection | Appropriate policy |
|---|---|---|---|
| checked multiplication fails | requested bytes represent the logical count | validate before allocation | reject request; do not allocate |
| specialized pool/arena is full | live demand stays within engineered capacity | high-water counter and explicit null result | drop/reject/fail fast, or invoke a declared cold fallback |
| throwing allocation reports `bad_alloc` | required dynamic storage was obtained | catch only at a recovery boundary | shed work, release reserve, or shut down |
| process dies on later page touch | virtual-memory commitment differs from allocation success | OS metrics and fault testing | OS deployment policy; see Chapter 32 |

Operating systems may reserve address space before committing physical backing,
so successful allocation need not mean every later page touch can succeed.
Overcommit, resource limits, prefaulting, and process-kill policy belong to the
OS-memory chapters. At the C++ layer, do not promise recovery that the deployed
OS configuration cannot deliver.

For a hot path, preallocate only after measuring and bounding demand. If a
bounded allocator exhausts, its documented result should propagate directly to
a business decision such as reject, drop, or stop. A `noexcept` function that
lets `bad_alloc` escape calls `std::terminate`; that is fail-stop behavior, not
an implicit allocation policy.

---

## 7.8 Arenas and Bump Allocators — Core

An **arena** (region, bump, or linear allocator) draws storage from one backing
block and satisfies requests by advancing an offset. The key invariant is
`used <= capacity`; request sizes are validated before any result pointer is
formed.

```cpp
#include <cstddef>
#include <memory>

class Arena {
    std::byte* base_;
    std::size_t capacity_;
    std::size_t used_{};

public:
    Arena(std::byte* p, std::size_t n) noexcept
        : base_(p), capacity_(p == nullptr ? 0 : n) {}

    void* allocate(std::size_t n, std::size_t align) noexcept {
        if (n == 0 || align == 0 || (align & (align - 1)) != 0) {
            return nullptr; // this arena rejects zero-size/invalid-alignment requests
        }

        // Integer checks happen before base_ + used_ is formed.
        if (used_ > capacity_ || n > capacity_ - used_) return nullptr;
        std::size_t remaining = capacity_ - used_;
        std::byte* cursor = base_ + used_; // inside the backing array
        void* candidate = cursor;
        std::size_t space = remaining;

        if (std::align(align, n, candidate, space) == nullptr) return nullptr;
        auto* result = static_cast<std::byte*>(candidate);
        const std::size_t padding = static_cast<std::size_t>(result - cursor);

        // Keep the invariant explicit rather than relying only on std::align.
        if (padding > remaining || n > remaining - padding) return nullptr;
        used_ += padding + n; // sum is <= capacity_, so it cannot overflow
        return result;
    }

    void reset() noexcept { used_ = 0; } // invalidates all outstanding results
    std::size_t used() const noexcept { return used_; }
};
```

The caller must supply a non-null pointer to an actual array of at least `n`
bytes when constructing a non-empty arena. The implementation never computes
`candidate + requested` and then checks it: such a version may form a pointer
beyond the one-past endpoint, which is already undefined behavior even if never
dereferenced. It first subtracts within known bounds, compares integer sizes,
and lets `std::align` adjust a pointer already inside the backing array.

```
[####used####|>cursor          free            ]
 base                                          end
```

**Ownership, lifetime, thread-safety, exhaustion — state these for every allocator you show:**

- *Ownership*: this `Arena` borrows the block; the caller owns it and must keep it
  alive. A production wrapper can own the block with RAII.
- *Lifetime*: objects built in arena storage are only as long-lived as the arena. `reset()` invalidates every outstanding pointer into the block without notice — no destructors run (see below).
- *Thread-safety*: none. `allocate` has no synchronization; sharing one `Arena` across threads without an external lock is a race.
- *Exhaustion*: `allocate` returns `nullptr` and does nothing else — a fail-fast policy. A caller wanting a fallback (chain a new, larger block from an upstream allocator) must implement that explicitly and should treat it as a rare, logged path, not silent behavior, because the first allocation after exhaustion becomes a full `malloc`/page-fault event — the tail-latency spike the arena exists to avoid.

**Cost mechanism.** The code performs bounded arithmetic and updates one offset;
it has no size-class search, individual allocation header, or synchronization.
Objects are close in allocation order except for padding. Whether that improves
latency depends on access order, backing-page state, and contention avoided;
measure those conditions rather than assigning a universal time.

**Non-trivial destructors.** A reset that just moves the cursor back never runs destructors. Pick one discipline: restrict the arena to trivially destructible types (`static_assert` it), maintain a side list of destructor thunks run in reverse on reset, or accept the leak deliberately for types that own nothing external.

**Where it fits.** Per-request/per-tick scratch memory reset at the top of each event; parser/AST construction discarded as a unit; anywhere the whole structure dies together.

**Exercise:** extend `Arena` with a chained fallback. Before doubling, check
`old_capacity <= max_size / 2`; on first exhaustion, attach one separately
owned preallocated block and retry. Return null or terminate on a second
exhaustion rather than growing without bound. Pointers into the old block must
remain valid, so old blocks cannot move or be released before reset/destruction.

---

## 7.9 Fixed-Block Pools and Free Lists — Core

A **free list** threads a singly linked list through the free blocks themselves,
storing the `next` pointer *inside* each free block. It needs no separate
per-slot link allocation; the link temporarily occupies the block's payload
storage while that block is free.

```
free list head ──▶ [next]──▶ [next]──▶ [next]──▶ null
allocate: p = head; head = *(void**)head; return p;   // 2 loads, 1 store
free:     *(void**)p = head; head = p;                 // 1 load, 2 stores
```

Both operations are O(1). Two costs are non-obvious:

- **Pointer chasing.** Reading `next` is a dependent load into memory that, if the block hasn't been touched recently, is cold. A shuffled free list produces a near-random-access miss per allocation, on the critical path.
- **Order.** A freshly built list can be in address order; after reuse its links
  may become scattered. LIFO tends to return a recently touched block, while
  FIFO retains blocks longer. Which is better depends on the access pattern and
  should be measured with the real reuse distance.

### A correct fixed-block pool

The bug this section exists to fix: threading a `void*` free-list pointer through a slot that's smaller than a pointer, or less aligned than a pointer requires, writes outside — or misaligned into — that slot. A pool of `char` (`sizeof(char) == 1`) with one-byte slots is the sharpest example. The fix is to size and align every slot for the larger of `T` and `void*`:

```cpp
#include <cassert>
#include <cstddef>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>

template <class T, std::size_t N>
class Pool {
    static_assert(N > 0);
    static_assert(std::is_nothrow_destructible_v<T>,
                  "pool requires non-throwing destruction");
    static constexpr std::size_t SlotSize =
        sizeof(T) > sizeof(void*) ? sizeof(T) : sizeof(void*);
    static constexpr std::size_t SlotAlign =
        alignof(T) > alignof(void*) ? alignof(T) : alignof(void*);

    struct alignas(SlotAlign) Slot {
        std::byte bytes[SlotSize];
    };
    static_assert(sizeof(Slot) >= SlotSize);
    static_assert(alignof(Slot) >= SlotAlign);

    Slot storage_[N];
    void* free_ = nullptr;
    std::size_t live_{};

    static void** raw_link(void* p) noexcept {
        return reinterpret_cast<void**>(p);
    }

public:
    Pool() noexcept {
        for (std::size_t i = N; i-- > 0;) {
            void* s = storage_[i].bytes;
            std::construct_at(raw_link(s), free_); // begin lifetime of link
            free_ = s;
        }
    }

    ~Pool() { assert(live_ == 0 && "destroy live objects before the pool"); }

    template <class... A>
    T* create(A&&... a) {
        if (free_ == nullptr) return nullptr; // deterministic fail-fast

        void* slot = free_;
        void** link = std::launder(raw_link(slot));
        free_ = *link;
        std::destroy_at(link);                // end link object's lifetime
        try {
            T* result = std::construct_at(
                reinterpret_cast<T*>(slot), std::forward<A>(a)...);
            ++live_;
            return result;
        } catch (...) {
            std::construct_at(raw_link(slot), free_); // restore free-list invariant
            free_ = slot;
            throw;
        }
    }

    void destroy(T* p) noexcept {
        // Precondition: p is a live object obtained from this pool.
        std::destroy_at(p);
        void* slot = p;
        std::construct_at(raw_link(slot), free_); // begin link object's lifetime
        free_ = slot;
        --live_;
    }
};
```

The slot is at least `max(sizeof(T), sizeof(void*))` bytes and at least
`max(alignof(T), alignof(void*))` aligned. The nested `Slot` array also makes the
compiler choose a valid stride between slots. A free slot contains a live
`void*` link object; allocation ends that lifetime before constructing `T`, and
destruction ends `T` before reconstructing the link. Constructor failure
restores the slot to the free list.

Test the small-type case (`T = char`), an over-aligned type, exhaustion,
constructor failure, destroy/reuse, and all-live-objects-returned before pool
destruction. Without the size/alignment maximum, a one-byte slot would receive a
pointer-sized write and corrupt adjacent slots. Sanitizers help with surrounding
memory, but custom allocators can hide use-after-return unless they integrate
the sanitizer's poison/unpoison interface.

**Ownership, lifetime, thread-safety, exhaustion:**

- *Ownership*: the `Pool` owns its fixed backing array; `create`/`destroy` are the only valid ways to get and return a `T*` into it.
- *Lifetime*: a `T*` returned by `create` is valid until the matching `destroy`.
  Every live object must be destroyed before the pool.
- *Thread-safety*: none, as written. A pool shared across threads needs a mutex
  (adding synchronization and possible waiting), a proved concurrent free list
  (including safe ABA/reclamation handling; Ch. 26), or one pool per thread
  with a cross-thread return path. “Allocate on A, free on B” must be included in
  the workload model.
- *Exhaustion*: `create` returns `nullptr`. Silent fallback to `new` would reintroduce the tail latency the pool exists to remove; size the pool from measured worst case and monitor the high-water mark instead.

**Low-latency application: fixed-size message buffers.** A block size derived
from the largest accepted message and a count derived from maximum in-flight
demand give a measurable capacity model. Moving a block pointer between stages
can avoid payload copies, but cross-thread return then becomes part of the
design. Hardware registration and kernel-bypass constraints are Chapter 47
material; they are not implied by using a pool.

### Bitmap vs free-list bookkeeping

An alternative to threading `next` through the block is a bitmap: one bit per slot, scanned for the first free (or cleared) bit.

| | Free list | Bitmap |
|---|---|---|
| Allocate | pop head, O(1) | scan for a set bit, O(n/word) worst case, faster with a hierarchical summary |
| Free | push head, O(1) | clear one bit, O(1), no write into the block itself |
| Touches the freed block | yes — a cache miss on a cold block | no |
| Detects double free | no | yes (bit already clear) |
| Contiguous multi-block alloc | no | yes (scan for a run) |

The bitmap can free without writing into the payload, so returning a cold buffer
need not fetch that payload's cache line solely for the link. Compilers often
map `std::countr_zero` (Ch. 15) to a target bit-scan instruction. A summary
bitmap bounds how many words must be inspected, at the cost of extra metadata
updates.

**Object pools proper.** A variant that resets rather than destroys objects — keeping them constructed between uses — avoids constructor/destructor cost entirely, at the price of an explicit `reset()` and a requirement that the object's invariants survive being idle. Prefer this only when construction cost is measured and material; it adds a state-management burden that a plain destroy/recreate pool doesn't have.

---

## 7.10 Stack Allocators and `alloca` — Role-specific

A **stack allocator** is an arena with LIFO deallocation via a marker/scope discipline, useful when an arena-wide reset is too coarse.

```cpp
#include <cassert>
#include <cstddef>
#include <memory>

class StackArena {
    std::byte* base_;
    std::size_t capacity_;
    std::size_t used_{};

public:
    struct Marker { std::size_t offset; };

    StackArena(std::byte* p, std::size_t n) noexcept
        : base_(p), capacity_(p == nullptr ? 0 : n) {}

    Marker mark() const noexcept { return {used_}; }
    void release(Marker m) noexcept {
        assert(m.offset <= used_);
        used_ = m.offset;
    }

    void*  allocate(std::size_t n, std::size_t align) noexcept {
        if (n == 0 || align == 0 || (align & (align - 1)) != 0 ||
            used_ > capacity_ || n > capacity_ - used_) {
            return nullptr;
        }
        std::byte* cursor = base_ + used_;
        void* candidate = cursor;
        std::size_t space = capacity_ - used_;
        if (std::align(align, n, candidate, space) == nullptr) return nullptr;
        auto* result = static_cast<std::byte*>(candidate);
        const std::size_t padding =
            static_cast<std::size_t>(result - cursor);
        if (padding > capacity_ - used_ ||
            n > capacity_ - used_ - padding) return nullptr;
        used_ += padding + n;
        return result;
    }
};

struct Scope {
    StackArena& arena;
    StackArena::Marker marker;
    explicit Scope(StackArena& x) : arena(x), marker(x.mark()) {}
    ~Scope() { arena.release(marker); }
};
```

The scope restores an offset, so every later allocation is invalidated together.
As with the arena, object destructors remain the caller's responsibility. The
snippet's `Scope` member names are intentionally ordinary state, not magic
stack unwinding by the allocator.

`alloca` and C++ variable-length arrays are not standard C++23. Common
`alloca` extensions reserve bytes in the current call frame until the function
returns, but provide no portable failure result; repeated calls in a loop
accumulate, and an input-sized request can exhaust or jump through stack guard
regions. Toolchain stack probing mitigates some platform attacks but does not
turn unbounded input into a safe design. Prefer a fixed `std::array<std::byte,
N>` backing a bounded arena, or use Chapter 8's `std::pmr` facilities with an
explicit upstream policy.

---

## 7.11 Slab Allocators — Deep dive

A **slab** groups a backing extent into equal-stride slots for one object type or
one size class. A cache tracks slabs that are full, partially used, or empty:

```
cache "Order"  ──┬─▶ slab (full)      [O][O][O][O][O][O]
                 ├─▶ slab (partial)   [O][O][ ][O][ ][ ]  ──▶ freelist
                 └─▶ slab (empty)     [ ][ ][ ][ ][ ][ ]
```

- Any free slot in the same cache can satisfy another request in that class, so
  there is no external fragmentation *between those equal-size slots*.
  Alignment/stride rounding, slab headers, unused tail bytes, and partly empty
  slabs still consume memory.
- A C++ object cache may keep idle objects alive and call a type-specific
  `reset()` on checkout. If it destroys them on return, later code must construct
  a new object before accessing it; allocator folklore does not override C++
  lifetime rules.
- Optional per-thread/per-CPU magazines put a small pointer cache before shared
  slab metadata. They reduce common-path synchronization but complicate
  cross-thread return, capacity accounting, and reclamation.
- Cache coloring is a platform-specific layout technique that varies starting
  offsets across slabs to avoid systematic cache-set conflicts. It is not a
  defining slab property and should be justified by hardware-counter evidence.

### Allocator-shape comparison

| Shape | Allocation mechanism | Individual release | Fragmentation / footprint | Locality and variance | Best-fitting workload |
|---|---|---|---|---|---|
| arena / bump | align and advance offset | no; bulk reset | padding plus unused tail/capacity | contiguous allocation order; bounded metadata work | objects die as one phase |
| stack arena | arena plus marker rollback | LIFO groups | same as arena | bounded work if nesting is disciplined | nested scratch scopes |
| free list | pop/push link embedded in blocks | yes | depends on source blocks; fixed-size list has no between-slot external fragmentation | one dependent link load; order changes with reuse | reusable equal-size blocks |
| fixed object pool | free list/bitmap over `N` typed slots | yes, explicit destroy | capacity is reserved for that type; stride padding | no upstream call until exhaustion | bounded live count, repeated type |
| slab | choose partial slab, then free slot | yes | stride/header/tail plus partially empty slabs | optional local magazines; whole-slab refill is slower | many objects in a few stable classes |
| system/general heap | size class or large-block search, caches, OS refill | yes | headers, rounding, retained pages, holes | flexible; fast and slow paths depend on implementation/contention | varied sizes and lifetimes |

“O(1)” for an arena or free-list operation describes algorithmic metadata work,
not a latency guarantee. Cache misses, page faults in the backing region, and
synchronization added around it still matter.

---

## 7.12 Fragmentation — Deep dive

**Internal fragmentation** is memory allocated to a request but unused by it: size-class rounding, alignment padding, per-allocation headers, struct padding (Ch. 3 §3.2). **External fragmentation** is free memory that exists but can't satisfy a request because it isn't contiguous.

```
Internal:   request 100 → [ 100 used | 28 wasted ] in a 128-byte class
External:   [used][free 64][used][free 64][used]   ← 128 bytes free, a 128-byte request still fails
```

Finer size classes can reduce rounding waste but require more metadata and can
strand capacity across more partially occupied classes. Coarser classes simplify
reuse but waste more bytes per request. Measure requested bytes, usable/committed
bytes, live objects, and empty/partial slab counts over a representative burst.

**A general C++ allocator cannot transparently compact live objects** after raw
pointers have escaped: it cannot update every alias or relocate arbitrary
non-trivially movable objects. An application can design relocatable storage
behind indices/handles, but that changes its interface. Otherwise use structural
controls: equal-size pools, phase-reset arenas, bounded size classes, and
preallocation.

A process can retain a higher resident set after a burst even when live bytes
fall, because allocator caches and partially used pages are not immediately
returned to the OS. That observation does not prove either a leak or
fragmentation. Compare live/requested bytes, allocator-resident/committed bytes,
and process RSS over time; then inspect class occupancy and purge policy.

---

## 7.13 General-Purpose Allocators — Deep dive

General allocators combine several structures because no one structure handles
all sizes and lifetimes well:

- **Segregated size classes** round small requests to reusable slot sizes.
- **Spans/pages** provide batches of slots and a unit that can eventually return
  to an upstream virtual-memory provider.
- **Thread-local or per-CPU caches** reduce shared metadata traffic, while remote
  frees reconcile ownership between threads.
- **Coalescing lists or trees** manage larger variable-size free extents.
- **Direct mappings** may serve sufficiently large requests.

glibc's allocator, jemalloc, tcmalloc, and mimalloc are examples with different
versions of these ideas. Their exact size classes, thresholds, background
threads, and release policies change. Choose among them with an experiment that
matches:

1. request-size and lifetime distribution;
2. which thread allocates and which thread frees;
3. warm steady state plus burst/refill behavior;
4. median, high-percentile, and worst observed latency;
5. live bytes, retained/committed bytes, and CPU cost;
6. the exact allocator build, configuration, OS, and hardware.

A single-thread loop that allocates and immediately frees one size mostly tests
a cache hit. It says little about remote frees, refill, purge, or fragmentation.
Replacing a global allocator can be useful, but it is an empirical deployment
change with compatibility and observability risks, not a guaranteed win.

---

## 7.14 Operational Notes — Reference

C++23 has no standard huge-page allocation API. A **huge-page-backed arena**
is the same arena algorithm with backing storage obtained from a platform API
using a larger page size. Potentially greater TLB reach is exchanged for
platform dependence, availability/reservation constraints, coarser internal
waste, and different page-fault behavior. NUMA placement, locking, prefaulting,
and transparent versus explicit huge pages belong to Chapters 29 and 32.
Confirm backing page size and fault/TLB behavior with OS data; an allocation or
advice call alone is not proof that huge pages were used.

---

## 7.15 Worked Reasoning: Bound the Mechanism — Core

Suppose a single-threaded feed stage processes one datagram at a time. Protocol
validation caps a datagram at 1,000 decoded entries and 500 temporary parse
nodes. An entry needs 24 bytes aligned to 8; a node needs 40 bytes aligned to 8.
All temporaries die when that datagram finishes. Separately, up to 4,096 order
records of one C++ type may remain live across datagrams and are canceled
individually.

**Step 1: classify lifetimes.** The decoded entries and nodes have one phase
lifetime, so individual deallocation adds no value: use a per-datagram arena.
The order records need independent release and reuse: use a fixed object pool.
One mechanism cannot express both lifetime shapes as cleanly.

**Step 2: calculate a conservative arena bound.** For arbitrary starting
alignment, each 8-aligned allocation can consume at most 7 padding bytes.
Allocating every object separately therefore has the conservative bound

```
1,000 × (24 + 7) + 500 × (40 + 7) = 54,500 bytes
```

A 64 KiB arena covers that bound with room for small arena metadata. Better
layout could reserve two arrays and pay alignment padding twice rather than
1,500 times, but correctness does not depend on that optimization. Before any
allocation, validate both protocol counts and use checked multiplication/addition
to prove the byte calculation fits `size_t`.

**Step 3: size the pool from C++ types, not a guessed byte constant.** For
`Order`, compute the slot size and alignment exactly as in §7.9, including the
embedded free link. Check that `4096 * sizeof(Slot)` fits `size_t` before
obtaining the backing block. The 4,096 count is a capacity contract, not an
average.

**Step 4: state policies.**

- Both allocators are owned by the feed stage and are not shared.
- Arena objects are restricted to trivially destructible scratch types; reset
  occurs only after processing completes.
- Pool records must be returned individually before pool destruction.
- Invalid wire counts reject the datagram. Arena exhaustion also rejects it and
  increments a fault counter. Pool exhaustion prevents accepting a new order
  and triggers the service's configured risk/fail-stop path. Neither silently
  falls back to the system heap.

**Step 5: define evidence.** Record validated counts, arena high-water bytes,
pool high-water objects, and exhaustion count. Benchmark from prefaulted steady
state and separately exercise cold startup. This confirms both the capacity
proof and any latency benefit.

### Code diagnosis

Now inspect this intentionally broken allocation pair:

```cpp
#include <cstddef>
#include <cstdlib>

struct Packet {
    Packet();
    ~Packet();
    int sequence;
};

Packet* acquire(std::size_t count) {
    void* raw = std::malloc(count * sizeof(Packet));
    return static_cast<Packet*>(raw);
}

void release(Packet* packets) {
    delete[] packets;
}
```

Three boundaries are violated. The multiplication can wrap before `malloc`.
Successful `malloc` obtains storage but does not run any `Packet` constructors,
so returning it as an array of live non-trivial objects is invalid. Finally,
`delete[]` cannot release storage obtained from `malloc`; the family is
mismatched. The ordinary fix is `new Packet[count]` paired with `delete[]`
behind an RAII owner after validating `count`. A manual-storage design must
construct each element, roll back already-constructed elements if a later
constructor throws, destroy in reverse, and call `free`—which is exactly why
application code normally delegates that machinery to a container or ownership
type.

---

## Recall Card — Core
- A new-expression is allocation function + construction; `delete` is destruction + deallocation function. A throwing constructor auto-calls the matching `operator delete`.
- `new T[n]` may use hidden bookkeeping to recover the element count;
  `delete`/`delete[]` mismatch is undefined behavior and can corrupt allocator
  state.
- C++17 routes over-aligned new-expressions through alignment-aware allocation
  and deallocation forms; custom allocators must enforce alignment themselves.
- `malloc`/`free` and `new`/`delete` are separate contracts; never mix them, even where they happen to interoperate on one implementation.
- Arenas give bounded bump work and constant-time bulk reset, but no individual
  free and no destructor calls unless you add that machinery.
- A fixed-block pool's slot must be sized and aligned for `max(sizeof(T), sizeof(void*))`/`max(alignof(T), alignof(void*))` if it threads a free-list pointer through the slot — undersizing corrupts neighboring slots.
- Every allocator you present should state ownership, lifetime, thread-safety, and exhaustion behavior; silent fallback on exhaustion defeats the purpose of a specialized allocator.
- A general allocator cannot transparently compact escaped C++ objects; use
  pools/arenas or design handles explicitly when relocation is required.

## Questions — Core
1. What are the two steps a new-expression performs, and which one is replaceable?
2. Why is `delete p` on a pointer returned by `new T[n]` undefined, and what
   allocator metadata can it damage on a cookie-based ABI?
3. Why may the allocation function for `new T[n]` receive more than
   `n * sizeof(T)`? Which parts of your answer are standard guarantees?
4. What contracts must a global replacement throwing `operator new` honor, and
   why does a production allocator integration usually supply a coherent family
   of allocation/deallocation forms?
5. Why must a pool's slot use at least `max(sizeof(T), sizeof(void*))` and the
   corresponding maximum alignment? What lifetime transition occurs when the
   slot changes from free link to `T`?
6. In a bump allocator's `allocate(n, align)`, what goes wrong if you form the candidate result pointer before checking it's still inside the arena, instead of checking sizes first?
7. Why can a portable general `std::vector` implementation not rely on
   `realloc`, even when some element types are trivially copyable?
8. What does "deterministic exhaustion policy" mean for a pool or arena, and why does silent fallback to the general allocator undermine the reason to use one?
9. Why can a general allocator not compact arbitrary live C++ objects after raw
   pointers escape? How could an index/handle-based design change that answer?
10. Design an allocator benchmark for a producer-allocates/consumer-frees
    workload. Which latency and memory metrics prevent a misleading conclusion?

## Implementation Exercise — Core
Implement two allocators end to end, each with a short comment block stating ownership, lifetime, thread-safety, and exhaustion policy:

1. A bounded fixed-block pool for fixed-size network receive buffers. Its slot
   size/alignment must be at least the maxima for the payload type and `void*`;
   `acquire()` returns null when full. Test a one-byte type and an over-aligned
   type as well as the intended buffer.
2. A per-request arena with a primary block and one secondary block supplied at
   construction. On first exhaustion it may chain the secondary block; on later
   exhaustion it returns null or terminates according to your declared policy.
   Check multiplication, addition, and remaining-capacity integers before
   forming result pointers. Never double a capacity without first proving the
   result fits `size_t`.

Compile both as C++23 with strict warnings and, where supported,
AddressSanitizer/UndefinedBehaviorSanitizer. Tests must cover exact fit,
one-byte-over exhaustion, invalid alignment, constructor failure, reuse, and the
documented second-exhaustion path. Track high-water capacity.

## Prerequisites for Chapter 8 — Core
Chapter 8 assumes this chapter's vocabulary — allocation versus construction,
matching deallocation forms, alignment, arena/pool/slab shapes, and the
ownership/lifetime/thread-safety/exhaustion questions. It adds container
allocator requirements, propagation through copy/move/swap, and
`std::pmr::memory_resource`. Review Chapter 5's object-lifetime rules before
continuing.
