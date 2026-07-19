# Chapter 8 — Allocator-Aware C++

*Interview-focused revision notes. The theme: the standard library's allocator model is two incompatible designs stacked on each other — a compile-time, type-baked-in one from C++98 and a runtime, polymorphic one from C++17 — and knowing which one to reach for, and what each costs, is the whole subject.*

---

## 8.1 C++ Allocator Requirements

An **allocator** in the standard library sense is a policy object that supplies and releases raw storage for a container, and (historically) constructs and destroys objects in it. It is a *template parameter*, so it is part of the container's type.

### The minimal C++11-and-later allocator

`std::allocator_traits<A>` supplies defaults for almost everything, so a conforming allocator needs remarkably little:

```cpp
template <class T>
struct MyAlloc {
    using value_type = T;                                   // the ONLY required typedef

    MyAlloc() noexcept = default;
    template <class U> MyAlloc(const MyAlloc<U>&) noexcept {}   // rebinding converter — required

    T*   allocate(std::size_t n);                           // returns storage for n objects
    void deallocate(T* p, std::size_t n) noexcept;          // n MUST match the allocate call

    bool operator==(const MyAlloc&) const noexcept { return true; }   // C++20 gives != free
};
```

Everything else — `pointer`, `size_type`, `construct`, `destroy`, `max_size`, `rebind`, the propagation traits — has a default in `allocator_traits`. **Never call an allocator's members directly; always go through `std::allocator_traits<A>`.** That is the entire point of the traits class, and containers are required to do so.

| Member | `allocator_traits` default if absent |
|---|---|
| `pointer` | `T*` |
| `const_pointer`, `void_pointer` | derived via `pointer_traits` |
| `size_type` / `difference_type` | `make_unsigned_t<difference_type>` / `ptrdiff_t` |
| `rebind_alloc<U>` | `A<U, Args...>` if `A` is a class template |
| `construct(a,p,args...)` | `::new ((void*)p) T(args...)`, or `a.construct(...)` if it exists |
| `destroy(a,p)` | `p->~T()` |
| `max_size(a)` | `numeric_limits<size_type>::max() / sizeof(T)` |
| `select_on_container_copy_construction(a)` | returns `a` |
| `propagate_on_container_copy/move/swap_assignment` | `false_type` |
| `is_always_equal` | `is_empty<A>` |

### Rebinding

A container almost never allocates `T`. `std::list<T, A>` needs `Node<T>`; `std::map` needs a tree node; `unordered_map` needs both nodes and a bucket array. So it takes `A` for `T` and internally uses `allocator_traits<A>::rebind_alloc<Node>`. This is why the converting constructor template is mandatory and why a non-template allocator class cannot be used directly with node-based containers. `std::vector` is the exception — it really does allocate `T[]`.

### What `allocate` must guarantee

- Storage suitably aligned for `T` — including over-alignment. C++17's `std::allocator` handles `alignas(64)` types correctly; a hand-written allocator forwarding to `malloc` does **not**, and this is a common latent bug.
- Throw on failure (`std::bad_alloc` or anything else) — returning null is not permitted, because containers do not check.
- `deallocate(p, n)` must receive the **same `n`** as the matching `allocate`. This is the standard's version of sized deallocation (Ch. 7 §7.1), and it's why allocators need no size header at all — a genuine advantage over `malloc`.

### Historical baggage to recognize

- C++98 required `pointer`, `reference`, `rebind`, `address`, `max_size`, and a `construct` taking `const T&`. Reading old allocators, you'll see all of it.
- `std::allocator<T>::pointer` etc. were deprecated in C++17 and **removed in C++20**; `construct`/`destroy` on `std::allocator` are gone too. Code calling `alloc.construct(p, x)` on `std::allocator` breaks in C++20 — use `allocator_traits`.
- `std::allocator<void>` was a special case for the `void_pointer` typedef; deprecated C++17, removed C++20.
- C++23 added `allocate_at_least`, returning `{ptr, count}` where `count >= n`, so `vector` can use the allocator's actual size-class rounding instead of wasting it. Small but real: a request for 100 `int`s in a 512-byte class yields 128 usable.
- `std::allocator` is **stateless and always equal**, which is what makes `vector<T>` movable in O(1) and `swap` trivial.

---

## 8.2 Allocator-Aware Containers

A container is **allocator-aware** if it stores an allocator, exposes `allocator_type`, and accepts one in its constructors. All standard containers except `std::array` (no allocation) and `std::inplace_vector` (C++26, fixed capacity) are allocator-aware. `std::function` was allocator-aware in C++11 and the support was **removed in C++17** because it was unimplementable correctly — a good trivia question.

```cpp
std::vector<int, MyAlloc<int>> v(MyAlloc<int>{});
std::pmr::vector<int> w{&resource};                 // = std::vector<int, std::pmr::polymorphic_allocator<int>>
```

### The consequences of allocator-as-template-parameter

This is the design flaw that motivated everything in §8.5.

1. **The allocator is part of the type.** `std::vector<int>` and `std::vector<int, ArenaAlloc<int>>` are unrelated types. They cannot be assigned to each other, passed to the same function, or stored in the same container. Every function that takes a vector must either be a template or fix one allocator.
2. **It leaks into every interface.** A single arena-allocated string in a struct forces the struct — and everything containing it — to be templated or to name the allocator explicitly.
3. **Code bloat.** Each allocator instantiates a separate copy of the container's code (Ch. 17 §17.22): more object code, more I-cache pressure, longer compiles.
4. **The upside**: the allocator's calls are statically bound and fully inlinable. A stateless allocator costs zero bytes (EBO / `[[no_unique_address]]`, Ch. 3 §3.4) and zero indirection.

### Where the allocator actually gets used

- `vector`: one allocation for the element array; on growth, allocate new, move/copy elements, deallocate old (Ch. 11 §11.3).
- `deque`: allocates fixed-size blocks plus the map of block pointers.
- `list`/`forward_list`/`map`/`set`: one **rebound** node allocation per element — the case where a pool allocator pays off most dramatically.
- `unordered_map`: node per element **plus** a bucket array reallocated on rehash.
- `string`: one allocation past the SSO threshold (Ch. 13 §13.2).

### Practical notes

- `vector`'s growth reallocation uses `move_if_noexcept`: a move constructor that isn't `noexcept` forces **copies** (Ch. 10 §10.3). Independent of the allocator, but it's the other half of "why is my vector slow."
- Containers are permitted to allocate on default construction, and some (libstdc++ `std::deque`, `std::map` in some implementations) do. An "empty container" is not always allocation-free — check before putting one on a hot path.
- Comparing containers with different allocator types requires the element types to match, not the allocators; `operator==` on `vector<T,A1>` and `vector<T,A2>` is not declared, so you compare ranges.
- Debug/tooling: `-D_GLIBCXX_DEBUG`, ASan, and heaptrack all see custom allocators as opaque unless you add poisoning hooks (Ch. 7 §7.11).

---

## 8.3 Allocator Propagation and Equality

The hardest part of the allocator model, and the highest-value interview material because almost nobody knows it.

**The problem:** if two containers have *different* allocators, and you assign or swap them, whose allocator ends up where — and can the destination free memory the source allocated?

**Allocator equality** answers the second half: `a1 == a2` means **storage allocated by `a1` can be deallocated by `a2`**. That is the entire semantic. Two arena allocators pointing at the same arena are equal; two pointing at different arenas are not.

### The three propagation traits

| Trait | Governs | Default |
|---|---|---|
| `propagate_on_container_copy_assignment` (POCCA) | `a = b` (copy) | `false` |
| `propagate_on_container_move_assignment` (POCMA) | `a = std::move(b)` | `false` |
| `propagate_on_container_swap` (POCS) | `swap(a, b)` | `false` |
| `select_on_container_copy_construction` (SOCCC) | `A a(b)` (copy ctor) | returns the same allocator |

`std::pmr::polymorphic_allocator` sets all three POC* traits to **false** and defines SOCCC to return a *default-constructed* allocator (i.e. the default resource) — the single most surprising behavior in the whole library (§8.5).

### The rules, case by case

**Copy construction.** `C b(a);` — `b` gets `SOCCC(a.get_allocator())`. For `std::allocator` that's the same thing. For `pmr`, it is **not**: the copy uses the *default* memory resource, not `a`'s. Deliberate: a copy is a new object with its own lifetime, and inheriting an arena that's about to be reset would be a dangling-memory bug.

**Move construction.** Always takes the source's allocator, always O(1) — it must, because there's no way to fail. This is the one case with no ambiguity.

**Copy assignment.** If POCCA is true, the destination's allocator is replaced by the source's — which means the destination must **first deallocate its existing storage with its old allocator**, because after propagation it couldn't. If POCCA is false, the destination keeps its allocator and copies elements into its own storage.

**Move assignment.** Three outcomes, and this is the classic question:

```
POCMA == true                  → steal the pointer, take the allocator.       O(1)
POCMA == false, allocators ==  → steal the pointer, keep own allocator.       O(1)
POCMA == false, allocators !=  → CANNOT steal (dest couldn't free it):
                                 element-wise MOVE into dest's own storage.   O(n) + allocation
```

That last line is the trap: **`std::pmr` move assignment between containers on different resources is O(n) and allocates.** A "move" that quietly becomes a copy-shaped operation is a real production surprise. `std::vector`'s move assignment is also therefore **not `noexcept`** for a `pmr::vector` — it may allocate — whereas `std::vector` with `std::allocator` is `noexcept` because `is_always_equal` is true.

**Swap.** If POCS is true, allocators swap along with the contents. If POCS is false **and the allocators are unequal, swapping is undefined behavior.** Not "slow", not "a copy" — UB. `std::swap` on two `pmr::vector`s with different resources is UB, and there is no diagnostic. This is arguably the sharpest edge in the standard library and an excellent question to raise unprompted.

### `is_always_equal`

`allocator_traits<A>::is_always_equal` (defaults to `std::is_empty<A>`) tells the container it never needs a runtime comparison, enabling the `noexcept` specifications above and letting the compiler delete the unequal-allocator branch entirely. Set it on any stateless allocator.

### The design rule

Do not mix allocators within a value's lifetime. Pick one resource per logical region of the program, construct everything there, and move only within that region. If you must cross regions, copy explicitly — then at least the cost is visible in the source.

---

## 8.4 `scoped_allocator_adaptor`

**The problem it solves:** allocator-aware containers do *not* propagate their allocator into their elements. Given

```cpp
std::pmr::vector<std::pmr::string> v{&arena};
v.emplace_back("a string long enough to defeat SSO");
```

the vector's element array comes from `arena`, but each `string`'s character buffer comes from the **default resource** (`new`/`delete`) — because `pmr::string`'s default-constructed allocator is the default resource, and nothing told it otherwise. You have allocated the container in your arena and every payload on the global heap. Half a fix is worse than none, because it looks correct.

`std::scoped_allocator_adaptor<Outer, Inner...>` (C++11, `<scoped_allocator>`) fixes it by making `construct` **uses-allocator aware**: when constructing an element, it detects whether the element type can accept an allocator and passes the inner allocator down, recursively.

```cpp
using Alloc = std::scoped_allocator_adaptor<std::pmr::polymorphic_allocator<std::pmr::string>>;
std::vector<std::pmr::string, Alloc> v{Alloc{&arena}};
v.emplace_back("...");    // BOTH the vector's array and the string's buffer come from arena
```

### Uses-allocator construction

The mechanism is a protocol, standardized as `std::uses_allocator_v<T, A>` (true if `T::allocator_type` is convertible from `A`) plus two conventions:

```
if !uses_allocator_v<T,A>              → T(args...)
else if constructible T(allocator_arg_t, A, args...)   → leading-allocator convention
else if constructible T(args..., A)                    → trailing-allocator convention
else ill-formed
```

`std::allocator_arg` is the tag disambiguating the leading form, needed because `T(A, args...)` would be ambiguous with a real first argument. `std::pmr` containers use the **trailing** convention. C++20 exposed the machinery directly as `std::make_obj_using_allocator<T>(alloc, args...)` and `std::uses_allocator_construction_args`, which is what you use for `pair`, `tuple`, and your own types.

### Making your own type allocator-aware

```cpp
struct Order {
    using allocator_type = std::pmr::polymorphic_allocator<>;

    std::pmr::string symbol;
    std::pmr::vector<int> legs;

    explicit Order(allocator_type a = {}) : symbol(a), legs(a) {}
    Order(const Order& o, allocator_type a) : symbol(o.symbol, a), legs(o.legs, a) {}   // extended copy ctor
    Order(Order&& o, allocator_type a)      : symbol(std::move(o.symbol), a), legs(std::move(o.legs), a) {}
    allocator_type get_allocator() const { return symbol.get_allocator(); }
};
```

The **extended copy/move constructors** (taking an extra allocator) are mandatory for the type to work inside an allocator-aware container — without them, `uses_allocator_v` is true but the construction fails to compile, or silently falls back.

### The verdict

`scoped_allocator_adaptor` is correct, standard, and almost universally avoided: the type names are unreadable, the failure modes are inscrutable template errors, and getting `pair`/`tuple` right requires the `uses_allocator_construction_args` machinery. In practice, teams either (a) use `pmr` everywhere and accept that nested `pmr` types must be constructed with an explicit resource argument, or (b) avoid nested allocating types on hot paths entirely — which is the better answer anyway, since a `vector<string>` in an arena is usually a signal you should be using a flat buffer with offsets.

Know it exists, know precisely what problem it solves, and know why it's rare. That combination is what's being tested.

---

## 8.5 Polymorphic Memory Resources

C++17's `<memory_resource>` inverts the C++98 design: instead of the allocator being a *template parameter* (static dispatch, type-infecting), it becomes a *pointer to an abstract base* (dynamic dispatch, type-uniform).

```cpp
class std::pmr::memory_resource {
public:
    void* allocate(size_t bytes, size_t align = alignof(max_align_t));
    void  deallocate(void* p, size_t bytes, size_t align = alignof(max_align_t));
    bool  is_equal(const memory_resource& o) const noexcept;
    virtual ~memory_resource();
private:
    virtual void* do_allocate(size_t, size_t) = 0;
    virtual void  do_deallocate(void*, size_t, size_t) = 0;
    virtual bool  do_is_equal(const memory_resource&) const noexcept = 0;
};
```

`std::pmr::polymorphic_allocator<T>` is a thin, **stateless-except-for-one-pointer** allocator holding a `memory_resource*`. Therefore:

```cpp
namespace std::pmr {
    template <class T> using vector = std::vector<T, polymorphic_allocator<T>>;
    // likewise string, map, set, unordered_map, deque, list, ...
}
```

**Every `std::pmr::vector<int>` is the same type regardless of resource.** That is the entire payoff: allocation strategy becomes a runtime value, functions take `std::pmr::vector<int>&` without templates, and you can swap arena→pool→heap without recompiling call sites.

### Global resources

| Function | Behavior |
|---|---|
| `new_delete_resource()` | Forwards to `operator new`/`operator delete`. The initial default. |
| `null_memory_resource()` | Throws `bad_alloc` on any allocation. Use as upstream to **forbid** heap fallback. |
| `get_default_resource()` / `set_default_resource(r)` | The resource used when a `polymorphic_allocator` is default-constructed. Global, and the setter is **not** thread-safe against concurrent allocation. Set it once at startup or not at all. |

### The costs, honestly

- **One virtual call per allocation and deallocation.** Indirect call through a vtable, unpredictable if resources vary at the site, ~2–5 ns plus a potential BTB miss (Ch. 27). Against a bump allocator's 2 ns of inline arithmetic, that's a 2–3× overhead on the operation — but against `malloc`'s 20 ns it's noise. The virtual call is only a problem if it's the dominant cost, which it is only for arenas.
- **The allocator is one pointer**, so `pmr::vector` is 32 bytes rather than 24. It also means `is_always_equal` is false, so move assignment carries the runtime allocator comparison and its unequal branch (§8.3).
- **Not inlinable across the boundary**, so the compiler cannot fold allocation into surrounding code. LTO and devirtualization help when the resource type is statically known, which it usually isn't (that's the point).

### The traps

- **`set_default_resource` is a global.** A library that sets it changes behavior for the whole process. Prefer passing resources explicitly.
- **Copy construction uses the default resource**, not the source's (§8.3, SOCCC). `pmr::vector<int> b = a;` puts `b` on the heap even though `a` is in an arena. Write `pmr::vector<int> b{a, &arena};`.
- **Swap with unequal resources is UB** (§8.3).
- **Dangling resource.** The container holds a raw `memory_resource*` and never extends its lifetime. A `pmr::vector` outliving its `monotonic_buffer_resource` — trivially achieved by declaring them in the wrong order in a function — is a use-after-free on destruction. **Declare the resource before the containers that use it**, so destruction order (Ch. 5 §5.9) is right.
- Deallocation must pass the **same size and alignment** as allocation; `polymorphic_allocator` handles this, hand-written resources must not assume otherwise.

`std::pmr` is the right default for allocation-shaped problems in modern C++: use it to confine allocation to a region, and drop to a hand-rolled static allocator only where profiling shows the virtual call matters.

---

## 8.6 Monotonic Memory Resources

`std::pmr::monotonic_buffer_resource` is the standard bump allocator (Ch. 7 §7.7): **allocation advances a pointer; `deallocate` does nothing; everything is released when the resource is destroyed or `release()`d.**

```cpp
std::byte buffer[64 * 1024];
std::pmr::monotonic_buffer_resource mr{
    buffer, sizeof buffer,                  // initial buffer (may be stack, static, or arena memory)
    std::pmr::null_memory_resource()        // upstream: NONE — throw instead of touching the heap
};
std::pmr::vector<int> v{&mr};
std::pmr::unordered_map<int, std::pmr::string> m{&mr};
// ... work ...
mr.release();     // O(1): resets the cursor. Destructors already ran (containers went out of scope).
```

### Behavior

- **Initial buffer optional.** Without one, the first allocation goes upstream.
- **Geometric upstream growth.** On exhaustion it requests a larger block from upstream (implementation-defined growth, typically ×1.5 or ×2) and chains it. Blocks are freed only at destruction/`release`.
- **`deallocate` is a no-op**, so memory usage is monotonically non-decreasing until release — hence the name. A loop that repeatedly fills and clears a `pmr::vector` on a monotonic resource **grows without bound**: `clear()` deallocates, the resource ignores it, the next `push_back` sequence allocates again.
- **Not thread-safe.** One resource per thread, or wrap it.
- **Destruction does not destroy your objects.** The resource frees memory; the containers' destructors must have already run. Get the declaration order wrong and you have UB.

### The idiomatic uses

**Per-event scratch.** The canonical low-latency pattern: one monotonic resource over a preallocated, prefaulted, huge-page-backed buffer (Ch. 7 §7.14), reset at the top of each message/tick.

```cpp
for (;;) {
    auto msg = recv();
    mr.release();                       // O(1), reuses the same warm pages every iteration
    std::pmr::vector<Level> book{&mr};
    process(msg, book);
}
```

Every iteration touches the **same physical pages**, which stay in L2 and in the TLB. That cache-residency effect is usually a bigger win than the allocation speed itself, and it's the point to make in an interview.

**Stack-buffer small-object optimization.** With a stack array as the initial buffer and `null_memory_resource` upstream, you get a `SmallVector`-equivalent out of standard components — and, critically, a *loud* failure if you exceed the budget rather than a silent heap fallback.

**Parsing / deserialization.** Build a message tree in a monotonic resource, consume it, release. No destructor traversal, no per-node free.

### Cautions

- **Non-trivially-destructible elements still need their destructors.** The containers handle it if they're destroyed normally; raw objects placement-new'd into the resource do not. Restrict to trivially destructible types where possible and `static_assert`.
- **Alignment**: `do_allocate` honors the requested alignment by advancing the cursor, so over-aligned types work — but each aligned bump wastes up to `align-1` bytes. Allocating alternating 64-byte-aligned and small objects fragments internally.
- **Sizing.** Measure the high-water mark (`mr` gives no accessor; instrument by wrapping the resource) and size the initial buffer above the worst case, with `null_memory_resource` upstream so overflow is an immediate, loud failure in test.

---

## 8.7 Pool Memory Resources

Where monotonic resources can't free, **pool resources** can. `<memory_resource>` provides two, differing only in thread safety:

- `std::pmr::unsynchronized_pool_resource` — no locking, single-threaded.
- `std::pmr::synchronized_pool_resource` — internally synchronized; the default-resource-safe one.

### Structure

Each pool resource maintains a set of **pools**, one per size class, each holding chunks carved from blocks obtained from an upstream resource. Requests larger than the largest block size go directly upstream.

```
pool_resource
  ├─ pool[ 8B]: block ──▶ [free][free][used]...        (geometric block growth)
  ├─ pool[16B]: block ──▶ [used][free][free]...
  ├─ ...
  └─ oversized ──▶ upstream (new_delete_resource by default)
```

`std::pmr::pool_options` tunes it:

```cpp
std::pmr::pool_options opt;
opt.max_blocks_per_chunk = 1024;      // cap on chunk growth (0 = implementation default)
opt.largest_required_pool_block = 512; // above this, go straight upstream
std::pmr::unsynchronized_pool_resource pool{opt, &upstream};
```

Both are *hints*; implementations may ignore them.

### When a pool resource is right

The workload signature is: **many small allocations, individually freed, of a handful of recurring sizes, with an unbounded or interleaved lifetime pattern.** That is exactly a node-based container:

```cpp
std::pmr::unsynchronized_pool_resource pool;
std::pmr::map<int, Order>            orders{&pool};    // one node per insert, freed on erase
std::pmr::unordered_map<Id, Level*>  index{&pool};
```

Against `new`/`delete`, a pool resource wins because (a) allocation is a free-list pop with no global lock, (b) same-size nodes come from the same chunks so the container's nodes are spatially clustered — a large locality win for tree/list traversal — and (c) there is no external fragmentation within a size class (Ch. 7 §7.13).

If the lifetime is phase-structured, a **monotonic resource is strictly better** — it's faster and simpler. Reach for a pool only when you genuinely need individual deallocation.

### Composition

Resources chain, and that's the design's strength:

```cpp
std::pmr::monotonic_buffer_resource   arena{big_buffer, N, std::pmr::null_memory_resource()};
std::pmr::unsynchronized_pool_resource pool{&arena};   // pool draws chunks from the arena
std::pmr::list<Node> l{&pool};                          // nodes recycled, chunks from the arena,
                                                        // nothing ever touches the heap
```

Three lines that give you: no heap traffic ever (enforced), recycled fixed-size nodes, contiguous backing memory, and a loud failure on budget overrun.

### Honest performance notes

- The standard pool resources are **not** competitive with a hand-rolled single-type pool (Ch. 7 §7.10): a virtual call, a size-class lookup, then a free-list pop, versus one inlined pop. Expect 10–20 ns versus 2–5 ns.
- `synchronized_pool_resource` takes a lock (or per-thread caches, implementation-defined). Do not put it on a hot path; prefer one `unsynchronized_pool_resource` per thread.
- Neither returns memory to upstream until destruction (libstdc++ and libc++ both retain chunks), so RSS is high-water-mark shaped.
- Implementation quality varies significantly between libstdc++, libc++, and MSVC — benchmark, don't assume.

---

## 8.8 Allocation-Free Hot Paths

The synthesis section, and the one most likely to be probed in a low-latency interview. The goal is not *fast* allocation; it is **no allocation between the packet arriving and the order going out**.

### Why allocation is disqualifying on a hot path

| Cost | Magnitude | Nature |
|---|---|---|
| Thread-cache hit (`malloc`) | 15–30 ns | Best case only |
| Arena lock contention | 100 ns – µs | Unbounded, load-dependent |
| `brk`/`mmap` growth | µs (syscall) | Rare, catastrophic for p99.9 |
| First-touch page fault | 1–5 µs | Per new page |
| `munmap` on free | µs + **TLB shootdown IPI to every core** | Affects other threads |
| `madvise` purge (jemalloc decay) | µs | Lands on whatever thread triggers it |
| Cache/TLB pollution from cold memory | 100s of ns | Diffuse, hard to attribute |

The mean is acceptable; the **tail is not**, and the tail is what a trading system is judged on. Allocation also makes latency *load-dependent*, which destroys the property you actually want: a latency distribution that doesn't change when the market gets busy.

### The techniques

**1. Preallocate at startup.** Every buffer, every pool, every container sized to the measured worst case, allocated and *touched* before the first packet (Ch. 7 §7.14). `reserve()` on every vector; `reserve()`/`rehash()` on every hash map; fixed-capacity queues.

**2. Reuse, don't recreate.** Keep objects alive and reset them. `v.clear()` preserves capacity — `v = {}` or `std::vector<T>{}.swap(v)` does not. A `std::string` member reused via `assign()` keeps its buffer.

**3. Fixed-capacity types.** `std::array`, `std::inplace_vector` (C++26), `boost::static_vector`, fixed-size ring buffers (Ch. 26). Capacity in the type means no allocation can occur, provable at compile time.

**4. Views, not copies.** `std::string_view`, `std::span` (Ch. 13) for parsing in place. Zero-copy deserialization over the receive buffer (Ch. 51 §51.9) rather than materializing objects.

**5. Object pools** for objects with request-scoped lifetime (Ch. 7 §7.10), handed out as `unique_ptr<T, PoolDeleter>` (Ch. 9 §9.2).

**6. Arena per event.** `monotonic_buffer_resource` over a preallocated buffer, released per message (§8.6).

**7. Avoid the hidden allocators.** `std::function` allocates when the callable exceeds the SBO budget (~16 bytes in libstdc++; captures a `shared_ptr` and you're allocating — Ch. 18 §18.10). `std::any` likewise. Exceptions allocate the exception object (Ch. 10 §10.5). `std::thread` allocates. Coroutine frames allocate unless elided (Ch. 19 §19.9). `std::stringstream`, `std::to_string`, `printf` with `%f`, iostreams, and locale operations all allocate — use `std::format_to` into a fixed buffer, or `std::to_chars` (Ch. 13 §13.6).

### Enforcement — the part that separates candidates

Discipline decays; enforcement doesn't. Name at least one of these:

- **Override global `operator new`** to `abort()` (or increment a counter and log) when a thread-local "hot path" flag is set. A dozen lines, catches everything including the library internals you didn't know about.

```cpp
thread_local bool g_no_alloc = false;
void* operator new(std::size_t n) {
    if (g_no_alloc) __builtin_trap();           // or record a backtrace
    if (void* p = std::malloc(n)) return p;
    throw std::bad_alloc{};
}
struct NoAllocScope { NoAllocScope(){g_no_alloc=true;} ~NoAllocScope(){g_no_alloc=false;} };
```

- **`null_memory_resource()` upstream** on every hot-path arena, converting silent heap fallback into `bad_alloc` (§8.6).
- **Static assertions** on capacity types and on `sizeof` of anything on the path.
- **Continuous verification**: count `minor-faults` and `page-faults` via `perf stat` on the hot thread during a soak test — a steady-state hot loop should show *zero* after warmup. `mallocstats`/jemalloc counters, heaptrack, and `perf probe` on `malloc` also work (Ch. 43 §43.23).
- **`mlockall(MCL_CURRENT|MCL_FUTURE)`** so nothing can be paged out, plus prefaulting so nothing faults in.

### The one-sentence answer

*"On the hot path I don't optimize allocation, I remove it: everything is preallocated and prefaulted at startup, per-event scratch comes from a monotonic arena that's reset per message, objects with request lifetime come from fixed-capacity pools that fail loudly rather than falling back to the heap, and a trapping `operator new` plus a zero-page-fault assertion in the soak test keeps it that way."*

---

## Key Interview Questions

1. **What is the minimum a C++11 allocator must provide?** — `value_type`, a rebinding converting constructor, `allocate`, `deallocate`, and `operator==`; `allocator_traits` defaults everything else.
2. **Why must containers go through `std::allocator_traits`?** — It supplies defaults for optional members and is the only stable interface; calling allocator members directly breaks with minimal allocators and with C++20's removals.
3. **What is rebinding and why is it needed?** — Node-based containers allocate `Node<T>`, not `T`, so they need `rebind_alloc<Node>` — which is why the converting template constructor is mandatory.
4. **What does allocator equality actually mean?** — Memory from one can be freed by the other. Nothing else.
5. **What are the three propagation traits and what do they control?** — POCCA/POCMA/POCS govern whether the allocator follows the contents on copy-assign, move-assign, and swap; all default to false.
6. **When is container move assignment O(n)?** — POCMA false and allocators unequal: the destination can't free the source's memory, so it move-constructs element by element and allocates.
7. **What happens when you `swap` two containers with unequal, non-propagating allocators?** — Undefined behavior, with no diagnostic.
8. **Why is `pmr::vector`'s move assignment not `noexcept`?** — `is_always_equal` is false, so the unequal-resource path may allocate.
9. **What does copy-constructing a `pmr::vector` do with the allocator?** — `select_on_container_copy_construction` returns a default-constructed allocator, so the copy uses the *default resource*, not the source's — a very common surprise.
10. **What problem does `scoped_allocator_adaptor` solve?** — Containers don't propagate their allocator into elements, so a `pmr::vector<pmr::string>` in an arena puts its strings on the heap; the adaptor performs uses-allocator construction to push the allocator down.
11. **What are the leading and trailing allocator conventions?** — `T(allocator_arg, a, args...)` vs `T(args..., a)`; `uses_allocator_v<T,A>` selects; `pmr` containers use trailing.
12. **What does `pmr` buy and what does it cost?** — Allocation strategy becomes a runtime value and all `pmr::vector<int>`s are one type; costs a virtual call per allocate/deallocate, one pointer of state, and loss of inlining.
13. **How do you forbid heap fallback in an arena?** — `null_memory_resource()` as upstream; overflow throws `bad_alloc` instead of silently allocating.
14. **What is the lifetime trap with `pmr` containers?** — The container stores a raw `memory_resource*`; declare the resource *before* the containers so it outlives them.
15. **Why does a monotonic resource grow without bound in a clear/refill loop?** — `deallocate` is a no-op; `clear()` returns nothing, so each refill takes new memory. Call `release()`.
16. **When would you choose a pool resource over a monotonic one?** — When you need individual deallocation with interleaved lifetimes; if lifetimes are phase-structured, monotonic is faster and simpler.
17. **How do standard pool resources compare with a hand-rolled pool?** — Roughly 10–20 ns vs 2–5 ns: virtual call plus size-class lookup plus free-list pop versus a single inlined pop. Use `pmr` for correctness, hand-roll for the critical path.
18. **Name five things that allocate that people don't expect.** — `std::function` past its SBO, `std::any`, throwing an exception, coroutine frames, `std::thread`, iostreams/`to_string`/locale, and `std::map`/`deque` on default construction.
19. **How do you *prove* a hot path is allocation-free?** — A trapping global `operator new` under a thread-local scope flag, `null_memory_resource` upstream, and zero `page-faults`/`minor-faults` in `perf stat` on the hot thread during steady-state soak.
20. **Why is allocation disqualifying on a hot path even at 20 ns?** — The mean is fine; the tail (arena lock, syscall growth, page fault, `munmap` TLB shootdown, purge) is unbounded and load-dependent, which destroys tail-latency stability.

---

## Common Traps

- **Calling `alloc.construct`/`alloc.destroy`/`alloc.max_size` directly** — removed from `std::allocator` in C++20; go through `allocator_traits`.
- **A non-template allocator class** — cannot rebind, so node-based containers won't compile.
- **A hand-written allocator forwarding to `malloc`** — silently ignores over-alignment; breaks `alignas(64)` element types.
- **An allocator that returns null on failure** — containers don't check; must throw.
- **Passing a different `n` to `deallocate` than to `allocate`** — UB; allocators rely on it instead of storing a size header.
- **Assuming move assignment is always O(1)** — unequal non-propagating allocators make it O(n) plus an allocation.
- **`swap` on containers with unequal non-propagating allocators** — undefined behavior.
- **Assuming a copy inherits the source's `pmr` resource** — SOCCC returns the *default* resource. Pass the resource explicitly.
- **Declaring a `monotonic_buffer_resource` after the containers that use it** — destruction order makes the container's deallocation a use-after-free.
- **Letting a `pmr` container outlive its resource**, e.g. returning one by value from a function that owns the arena.
- **Reusing a monotonic resource via `clear()` instead of `release()`** — unbounded growth.
- **Expecting a monotonic resource to run destructors** — it frees memory only.
- **Nesting allocating types without `scoped_allocator_adaptor`** — the container is in the arena, the payloads are on the heap, and it looks correct.
- **Forgetting extended copy/move constructors** on a custom allocator-aware type — uses-allocator construction fails or silently ignores the allocator.
- **`set_default_resource` from a library** — a process-global side effect; the setter isn't thread-safe against concurrent allocation.
- **`synchronized_pool_resource` on a hot path** — takes a lock; use one unsynchronized resource per thread.
- **Assuming pool resources return memory to upstream before destruction** — they don't; RSS is high-water shaped.
- **Silent heap fallback from an arena** — the tail-latency spike you can't explain. Always use `null_memory_resource` upstream on hot paths.
- **`v = {}` instead of `v.clear()`** — throws away the reserved capacity you preallocated.
- **Benchmarking allocators single-threaded** — measures the thread cache, not the real cross-thread-free workload.

---

## Compact Recall Summary

**Requirements.** A conforming allocator needs only `value_type`, a converting template constructor (for rebinding), `allocate`, `deallocate`, and `==`. `std::allocator_traits<A>` supplies everything else and is the *only* interface containers may use. `deallocate` receives the same `n` as `allocate`, so allocators need no size header. C++20 removed `pointer`/`construct`/`destroy` from `std::allocator`; C++23 added `allocate_at_least` to recover size-class slack.

**Containers.** All standard containers except `array` (and C++26 `inplace_vector`) are allocator-aware; `std::function`'s support was removed in C++17. Because the allocator is a *template parameter*, it becomes part of the type — infecting every interface and duplicating code per allocator — but it inlines completely and costs zero bytes when stateless (EBO). Node-based containers allocate per element via a rebound allocator, which is where pools pay off most.

**Propagation.** Allocator equality means "memory from one is freeable by the other." POCCA/POCMA/POCS default to false; SOCCC defaults to identity but returns the *default* resource for `pmr`. Move assignment is O(1) if POCMA is true or the allocators are equal, and **O(n) plus an allocation otherwise** — which is why `pmr` move assignment isn't `noexcept`. **Swapping containers with unequal non-propagating allocators is UB.** `is_always_equal` (defaults to `is_empty`) is what enables the fast paths and the `noexcept`.

**Scoped adaptor.** Containers do not propagate allocators into elements, so `pmr::vector<pmr::string>` puts its element array in the arena and every string buffer on the heap. `scoped_allocator_adaptor` performs uses-allocator construction — leading (`allocator_arg, a, args...`) or trailing (`args..., a`) convention, selected by `uses_allocator_v` — recursively down the composition. Custom types need `allocator_type`, an allocator-taking constructor, and **extended copy/move constructors**. Correct, standard, and mostly avoided; know why.

**pmr.** `memory_resource` is an abstract base with `do_allocate`/`do_deallocate`/`do_is_equal`; `polymorphic_allocator<T>` wraps a pointer to one, so every `pmr::vector<int>` is one type and the strategy is a runtime value. Costs one virtual call per operation, one pointer of state, and inlining. Globals: `new_delete_resource`, `null_memory_resource` (throws — use as upstream to forbid heap fallback), `get/set_default_resource` (process-global, not thread-safe to set). The container holds a raw resource pointer: declare the resource first.

**Monotonic.** `monotonic_buffer_resource` = bump allocator: pointer advance, no-op deallocate, geometric upstream chaining, O(1) `release()`. Per-event scratch reset each message is the canonical hot-path pattern, and the biggest win is that every iteration reuses the *same warm pages*. `clear()` doesn't reclaim — `release()` does. Not thread-safe; doesn't run destructors.

**Pool.** `unsynchronized_`/`synchronized_pool_resource`: size-class free lists over upstream chunks, tuned by `pool_options`, oversized requests pass through. Right when lifetimes are interleaved and individual free is needed; monotonic is better whenever lifetimes are phase-structured. Composes: `monotonic(buffer, null_upstream)` ← `pool` ← node-based container gives recycled nodes, contiguous backing, and provably no heap traffic. Slower than a hand-rolled single-type pool by ~3–5×.

**Allocation-free hot paths.** Don't make allocation fast — make it absent. Preallocate and prefault at startup; `reserve` everything; reuse and reset rather than recreate; fixed-capacity types; views instead of copies; pools for request-lifetime objects; a per-event arena. Watch the hidden allocators: `std::function`/`std::any` past SBO, exceptions, coroutine frames, `std::thread`, iostreams and `to_string`. Enforce with a trapping global `operator new` under a thread-local scope flag, `null_memory_resource` upstream, and a zero-page-fault assertion under `perf stat` during soak. The tail — arena locks, `brk`/`mmap`, page faults, `munmap` TLB shootdowns, decay purges — not the mean, is why.
