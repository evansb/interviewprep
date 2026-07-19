# Chapter 7 — Raw Allocation

*Interview-focused revision notes. The theme: every allocation is a data-structure operation on a shared mutable graph, and the cost you pay is set by which graph, under which lock, on which cache line — so the winning move on a hot path is almost always to pick a cheaper allocator, not a faster general one.*

---

## 7.1 `new` and `delete`

`new` is not one thing. A **new-expression** (`new T(args)`) is a language construct that performs *two* steps, and separating them is the single most useful thing to know here:

1. Call an **allocation function** — `operator new(size_t)` — to obtain raw storage.
2. **Construct** a `T` in that storage (the same act as placement new, Ch. 5 §5.2).

`delete p` inverts it: run `p->~T()`, then call the **deallocation function** `operator delete(void*)`.

```
new T(args)          ==  T* p = (T*)operator new(sizeof(T));   // allocation function
                         new (p) T(args);                       // construction
delete p             ==  p->~T();                               // destruction
                         operator delete(p);                    // deallocation function
```

`operator new`/`operator delete` are ordinary (implicitly `static`) functions you can replace or overload (§7.3). New-expressions are language syntax you cannot.

**Exception safety of the pair.** If the constructor throws, the runtime automatically calls the matching `operator delete` to release the storage — so `new T` never leaks storage on a throwing constructor. This is why the *matching* deallocation function must exist and be accessible; if you declare a class-level `operator new` with no matching `operator delete`, a throwing constructor leaks and compilers warn.

**Failure.** The default `operator new` never returns null: it throws `std::bad_alloc` (§7.6). `new (std::nothrow) T` selects the `nothrow` overload, which returns null instead — but note that the *new-expression* then also returns null without constructing, so a null check is mandatory.

**Value vs default initialization** is a common trip-up and is really Ch. 5 §5.4 material, but it bites hardest with `new`:

```cpp
int* a = new int;      // default-init: INDETERMINATE value
int* b = new int();    // value-init: zero
int* c = new int{};    // value-init: zero
Foo* d = new Foo;      // default-init: calls Foo's default ctor if non-trivial,
                       //   leaves members indeterminate if trivial
```

**Cost model.** A default `operator new` on glibc goes to `malloc` (§7.5). The best case — a fastbin/tcache hit — is on the order of 15–30 ns and touches a thread-local free list. The bad cases are far worse: arena lock contention, `brk`/`mmap` growth (a syscall, §Ch. 34), and a page fault on first touch (§Ch. 32) costing microseconds. The *variance* is the problem for low latency, not the mean. Additionally, freshly returned memory is cold in cache and its first write may trigger a read-for-ownership (Ch. 29).

`delete` also has non-obvious cost: it must find the chunk header (a load immediately before the pointer, usually a cache miss for a long-lived object), may coalesce with neighbors, and may return memory to the OS via `madvise`/`munmap`, which is a syscall and a TLB shootdown.

**Sized deallocation** (C++14) lets the compiler call `operator delete(void*, size_t)` when it statically knows the size, letting the allocator skip the size lookup. Clang needs `-fsized-deallocation` in some modes; libstdc++/tcmalloc use it. This is a real win for size-classed allocators.

**Rules that matter:** `delete` on a pointer not from `new` is UB; `delete` twice is UB (and a classic exploitation primitive); `delete` on a null pointer is well-defined and a no-op — so null checks before `delete` are noise. Mixing `new`/`free` or `malloc`/`delete` is UB even though it usually "works" on glibc.

---

## 7.2 Array `new` and `delete`

`new T[n]` and `delete[] p` are a separate pair of functions (`operator new[]`, `operator delete[]`) and a separate set of rules. They are the part of the language most likely to be simply banned in a modern codebase.

**The cookie.** For a `T` with a non-trivial destructor, `delete[]` must know `n` to run `n` destructors. Nothing carries that count in the pointer, so the implementation stores it — the **array cookie** — in extra bytes ahead of the returned pointer:

```
operator new[](n*sizeof(T) + cookie)
   ↓
[ cookie: n ][ T[0] ][ T[1] ] ... [ T[n-1] ]
             ^
             pointer you get back
```

Consequences, all of them interview-worthy:

- `new T[n]` requests **more** than `n * sizeof(T)` bytes when a cookie is needed. Under the Itanium ABI the cookie is `max(sizeof(size_t), alignof(T))` bytes, so for an over-aligned type it can waste an entire alignment quantum.
- For a trivially destructible `T`, there is **no cookie** on Itanium ABI — so `new int[n]` really is `n*4` bytes. MSVC's rules differ.
- The returned pointer is offset from the true allocation start, which breaks naive interop with anything expecting the raw block.

**`delete` vs `delete[]` is UB, both directions**, and not merely "leaks the rest." `delete p` on an array pointer passes the *cookied* pointer to `operator delete`, i.e. a pointer the allocator never handed out — heap corruption, not a leak. Compilers cannot generally diagnose this because the static type is just `T*`.

```cpp
int* p = new int[10];
delete p;        // UB (works by accident on some ABIs since no cookie)
Foo* q = new Foo[10];
delete q;        // UB, corrupts heap: wrong pointer, and 9 destructors skipped
```

**Arrays and polymorphism do not mix.** `Base* b = new Derived[10]; delete[] b;` is UB even with a virtual destructor, because `delete[]` strides by `sizeof(Base)`. This is the array analogue of slicing (Ch. 6).

**Exception safety.** If element *k*'s constructor throws, elements 0..*k*-1 are destroyed in reverse and the storage is released. Correct, but there is no way to recover partial state.

**`std::unique_ptr<T[]>`** (Ch. 9 §9.1) has an array specialization that calls `delete[]` and provides `operator[]` but not `operator*`. It's the correct wrapper if you must own a raw array. `std::make_unique<T[]>(n)` **value-initializes** all elements (zeroing), which for a large buffer means touching every page — a hidden multi-millisecond cost. C++20's `std::make_unique_for_overwrite<T[]>(n)` skips it, and is the right call for I/O buffers.

**The verdict:** in production C++, `new[]`/`delete[]` should not appear. Use `std::vector` (heap, growable), `std::array` (fixed, stack), `std::unique_ptr<T[]>` (rare, non-growable owned buffer), or an arena (§7.7). The only reason to know the mechanics is that you will read them in old code and be asked about them.

---

## 7.3 Overloading Allocation Functions

You can replace or overload allocation functions at two scopes, with different rules.

### Global replacement

Defining `void* operator new(std::size_t)` and `void operator delete(void*) noexcept` at global scope **replaces** the standard library's. There is no header to include and no opt-in; the linker simply resolves to yours (they are *replaceable* functions, not overloads — this is a special dispensation in the ODR, Ch. 1 §1.6). This is how tcmalloc/jemalloc/mimalloc integrate when linked statically.

The full replaceable set — you should replace all of them or none, since mixing yours and the library's causes mismatched free:

```cpp
void* operator new(std::size_t);                                   // throwing
void* operator new(std::size_t, std::align_val_t);                 // C++17 aligned
void* operator new(std::size_t, const std::nothrow_t&) noexcept;
void* operator new[](std::size_t);                                 // + aligned/nothrow variants
void  operator delete(void*) noexcept;
void  operator delete(void*, std::size_t) noexcept;                // C++14 sized
void  operator delete(void*, std::align_val_t) noexcept;           // C++17
void  operator delete(void*, std::size_t, std::align_val_t) noexcept;
// ... and the [] and nothrow variants of each
```

Constraints on a global `operator new`: it must return storage suitably aligned for any type with fundamental alignment (`alignof(std::max_align_t)`), it must be thread-safe, and it must either return non-null or throw `std::bad_alloc` (the throwing form). Deallocation functions are implicitly `noexcept`.

Calling anything that allocates from inside your `operator new` is a recursion hazard; so is calling `printf` (which allocates buffers). Instrumenting allocators typically need a thread-local reentrancy guard.

### Class-scope overload

```cpp
struct Node {
    static void* operator new(std::size_t n)   { return pool().alloc(n); }
    static void  operator delete(void* p, std::size_t) noexcept { pool().free(p); }
    static void* operator new(std::size_t, void* p) noexcept { return p; } // placement
};
```

Class-scope operators are implicitly `static` (so no `this`, and they run before construction / after destruction). They are found by name lookup on the *static* type in the new-expression and on the **dynamic** type in `delete` — but only if the destructor is virtual. Without a virtual destructor, `delete basePtr` calls `Base::operator delete` with `sizeof(Base)`, which is wrong for a derived object. Another argument for virtual destructors (Ch. 6).

Class-scope allocation is the classic way to give a hot node type a pool (§7.10) without touching call sites — the code still reads `new Node`, but goes to a free list.

**Placement forms.** Any extra parameters after `size_t` make a **placement new**, selected by `new (args) T`. The standard placement `new (void*)` is the identity function used for in-place construction. Every placement `operator new` should have a matching placement `operator delete` with the same trailing parameters — it is called *only* if the constructor throws, and there is no syntax to call it explicitly (you must call the destructor manually and release storage yourself).

**Tooling angle:** `LD_PRELOAD` of a shared library defining these symbols is how you swap in jemalloc/tcmalloc without relinking, and how heap profilers (heaptrack, gperftools) instrument. With `-static` or with `-fvisibility=hidden` and internal calls inlined, the interposition may fail — a real deployment trap (Ch. 1 §1.12).

---

## 7.4 Aligned Allocation

Before C++17, `operator new` guaranteed only `alignof(std::max_align_t)` (16 on x86-64 SysV). Requesting a 64-byte-aligned type via `new` was silently broken:

```cpp
struct alignas(64) Line { std::atomic<uint64_t> v; };
Line* p = new Line;   // pre-C++17: alignment NOT honored — UB on use, SIMD faults
```

**C++17** added `std::align_val_t` and the aligned overloads. When `alignof(T) > __STDCPP_DEFAULT_NEW_ALIGNMENT__`, the compiler emits a call to `operator new(size_t, align_val_t)` automatically. Nothing changes in your source; the fix is a language-level change in overload selection. Requires `-faligned-new` on older GCC/Clang in pre-17 modes, and note that `__STDCPP_DEFAULT_NEW_ALIGNMENT__` is 16 on most 64-bit targets, 8 on 32-bit.

The C-level tools:

| API | Standard | Constraints | Free with |
|---|---|---|---|
| `posix_memalign(&p, align, size)` | POSIX | `align` = power of 2 **and** multiple of `sizeof(void*)`; returns errno, not sets it | `free` |
| `aligned_alloc(align, size)` | C11 / C++17 | `size` **must be a multiple of** `align` (relaxed in C23, but assume the strict rule) | `free` |
| `memalign` | glibc, legacy | — | `free` |
| `_aligned_malloc` | MSVC | — | **`_aligned_free` only** |
| `std::aligned_alloc` | C++17 `<cstdlib>` | Same as C11; **not provided by MSVC** | `free` |
| `operator new(n, align_val_t{a})` | C++17 | Must pair with the aligned `operator delete` | aligned `operator delete` |

Two portability traps live in that table: `aligned_alloc`'s size-multiple rule, and MSVC's asymmetric `_aligned_free`. Both are standard interview probes.

### Why alignment matters beyond correctness

- **SIMD**: `vmovaps`/`vmovdqa` fault on misaligned addresses. Even where unaligned loads are allowed, a load that **straddles a cache line** costs roughly double; one that straddles a 4 KB page boundary is far worse (Ch. 28).
- **Atomics**: a misaligned atomic RMW on x86 asserts a bus lock — a **split lock** that stalls every core for microseconds (Ch. 3 §3.3). Aligned allocation is not an optimization here, it's a system-stability requirement.
- **False sharing**: `alignas(64)` on per-thread counters, allocated through the aligned path, is the standard fix (Ch. 3 §3.3).
- **Huge pages**: an arena aligned to 2 MB is a precondition for `MADV_HUGEPAGE` to actually back it with a huge page (§7.14).

### Manual over-alignment

When you must align inside a block you already own (an arena, a `char` buffer):

```cpp
void* p   = raw;
std::size_t sz = cap;
void* al  = std::align(64, sizeof(T), p, sz);  // <memory>; advances p, shrinks sz, null on failure
```

`std::align` is the standard, portable version of the `(addr + a - 1) & ~(a - 1)` idiom. The manual form is fine and faster to read, but do the arithmetic on `uintptr_t` and be aware of the provenance caveat (Ch. 3 §3.10): derive the final pointer by *offsetting the original pointer*, not by casting an integer back.

`std::assume_aligned<64>(p)` (C++20) tells the optimizer about alignment it can't prove, which is what actually unlocks aligned SIMD codegen.

---

## 7.5 `malloc`, `calloc`, `realloc`, and `free`

The C allocator underlies `operator new` on every mainstream implementation, and its semantics leak upward.

| Function | Semantics | Traps |
|---|---|---|
| `malloc(n)` | `n` bytes, **indeterminate** content, `max_align_t`-aligned | `malloc(0)` may return null *or* a unique freeable pointer — both conforming |
| `calloc(n, sz)` | `n*sz` zeroed bytes, **overflow-checked multiply** | Zeroing may be free (fresh pages from the kernel are already zero) or a real `memset` (recycled memory) |
| `realloc(p, n)` | Grow/shrink; may move; contents preserved up to `min(old,new)` | **Returns null on failure without freeing `p`** — `p = realloc(p, n)` leaks |
| `free(p)` | Release; `free(nullptr)` is a no-op | Double free / invalid pointer = UB, and the primary heap-exploitation primitive |

**`calloc` is not just `malloc` + `memset`.** For large requests the allocator gets fresh anonymous pages from `mmap`, which the kernel guarantees are zero, so `calloc` can skip the write entirely and return instantly. But the pages are not yet *faulted in* — the zeroing cost is deferred to first touch, one page fault per 4 KB (Ch. 32). A benchmark that `calloc`s a 1 GB buffer and reports 20 ns has measured nothing. For low latency, `calloc` + prefault (`MAP_POPULATE` or an explicit touch loop) is the correct pattern, not `calloc` alone.

**`realloc`'s in-place path** is the reason `std::vector` cannot use it: `realloc` may `memcpy` the bytes, which is only valid for trivially copyable types, and `vector` must run move constructors. This is a favorite question — "why doesn't `vector` use `realloc`?" — and the trivial-relocatability work (Ch. 3 §3.5, P2786) is precisely the machinery that would let it.

### glibc malloc internals (enough to answer questions)

glibc's allocator (ptmalloc2, descended from dlmalloc) organizes free chunks into bins:

```
tcache      per-THREAD, 64 size classes ≤ 1032B, 7 chunks each — LOCK-FREE, the fast path
fastbins    per-arena LIFO singly-linked, small sizes, no coalescing
unsorted    staging bin, scanned once on the next request
smallbins   exact size classes < 512B, FIFO doubly-linked
largebins   size ranges, sorted, best-fit
top chunk   the arena's frontier; grown via brk (main arena) or mmap
mmap        requests ≥ M_MMAP_THRESHOLD (default 128 KB, DYNAMIC) go straight to mmap
```

Points that separate strong candidates:

- **tcache** (glibc 2.26+) makes the common small-alloc path a thread-local array pop, ~15 ns, no atomic. Beyond 7 chunks per class it falls back to the arena, which takes a **mutex** — a latency cliff.
- **Arenas** are per-thread-ish (up to `8 * ncores` by default), assigned on first allocation and sticky. This bounds contention but causes **memory blowup** with many threads, and is why RSS can be several times live-heap size.
- **`M_MMAP_THRESHOLD` is dynamic**: it grows when a large `mmap`ed block is freed, so the same allocation size can go to `mmap` early in a run and to the heap later. Nondeterministic latency; pin with `mallopt(M_MMAP_THRESHOLD, ...)`.
- **Freeing an `mmap`ed block calls `munmap`** — a syscall plus a TLB shootdown IPI to every core running the process. A loop that allocates and frees 1 MB buffers can be dominated by shootdowns.
- **`M_TRIM_THRESHOLD`** controls returning heap memory to the OS via `brk`, another latency source. `mallopt(M_TRIM_THRESHOLD, -1)` and `mallopt(M_MMAP_MAX, 0)` are common trading-system settings: never give memory back.
- **`malloc_usable_size(p)`** returns the actual usable size, often more than requested. Useful for instrumentation; not portable.

**Mixing is UB**: `free` on `new`ed memory, `delete` on `malloc`ed memory. Even where the underlying allocator is the same, the *replaceable* `operator new` may have been swapped (§7.3).

---

## 7.6 Allocation Failure Handling

### The mechanism

The throwing `operator new` loops:

```
loop:
   p = allocate(size)
   if (p) return p
   h = current new_handler
   if (!h) throw std::bad_alloc{}
   h()                      // must free memory, install a different handler, or terminate
   goto loop
```

`std::set_new_handler(f)` installs a global (not thread-local) handler; it returns the previous one. A handler that returns without freeing anything produces an **infinite loop** — the standard requires it to do one of: make more memory available, install a different handler, `std::abort`/`std::exit`, or throw `bad_alloc` (or something derived). This is the mechanism behind emergency memory reserves: allocate a slab at startup, release it in the handler so the program has room to log and shut down cleanly.

```cpp
std::unique_ptr<char[]> reserve = std::make_unique<char[]>(1 << 20);
std::set_new_handler([]{
    reserve.reset();                  // free the emergency block
    std::set_new_handler(nullptr);    // next failure throws
});
```

`new (std::nothrow) T` returns null instead of throwing — but it still runs the new-handler loop first, so `nothrow` does *not* mean "fail fast." Also, `nothrow` only suppresses `bad_alloc`; if `T`'s constructor throws, that exception still propagates.

### Why "handling OOM" is mostly a fiction on Linux

Linux **overcommits** by default (`vm.overcommit_memory = 0`): `mmap`/`brk` succeed against address space, not physical memory, so `malloc` rarely returns null. The failure surfaces later as a **page fault the kernel cannot satisfy**, and the OOM killer sends `SIGKILL` to a process chosen by `oom_score`. Your `new_handler` never runs and your `bad_alloc` catch block is dead code (Ch. 32).

Therefore:
- On a 64-bit Linux server, `bad_alloc` in practice signals a *bogus size* (an unvalidated length field from the wire — Ch. 51 — or an integer-overflowed size computation), not genuine exhaustion. Treat it as a bug indicator, not a resource condition.
- Real defenses are `RLIMIT_AS`/cgroup memory limits (making allocation fail deterministically before the machine dies), `vm.overcommit_memory = 2` with a tuned ratio, `mlockall(MCL_CURRENT|MCL_FUTURE)` to prefault and pin, and `oom_score_adj = -1000` on the critical process.
- `MAP_POPULATE` / touch-every-page at startup converts a later, unhandleable failure into an immediate, handleable one.

### The low-latency position

Hot paths should not allocate at all (Ch. 8 §8.8, Ch. 55). If they cannot allocate, they cannot fail to allocate, and the entire question evaporates. Everything is preallocated at startup, where `bad_alloc` is a clean fatal error. This is the answer interviewers want: *"I don't handle allocation failure on the hot path; I make it unreachable."*

Note that `std::vector::reserve` and `push_back` beyond capacity can throw `bad_alloc` **and** `length_error` (when `n > max_size()`), and that a `noexcept` function which allocates will `std::terminate` on failure rather than propagate — sometimes exactly what you want for a fail-fast design (Ch. 10).

---

## 7.7 Arena and Bump Allocators

An **arena** (region, bump, linear allocator) owns one large block and satisfies allocations by advancing a cursor.

```cpp
class Arena {
    std::byte* cur_; std::byte* end_; std::byte* base_;
public:
    Arena(std::byte* p, std::size_t n) : cur_(p), end_(p + n), base_(p) {}

    void* allocate(std::size_t n, std::size_t align) noexcept {
        auto addr = reinterpret_cast<std::uintptr_t>(cur_);
        auto aligned = (addr + align - 1) & ~(align - 1);
        auto* p = cur_ + (aligned - addr);            // offset the POINTER (provenance, Ch.3 §3.10)
        if (p + n > end_) return nullptr;             // or chain a new block
        cur_ = p + n;
        return p;
    }
    void deallocate(void*, std::size_t) noexcept {}   // no-op
    void reset() noexcept { cur_ = base_; }           // O(1) release of EVERYTHING
};
```

```
[####used####|>cursor          free            ]
 base                                          end
```

**Why it is fast.** Allocation is an add, a mask, a compare, and a store — 2–5 ns, fully predictable, no locks, no metadata, no search. Objects are laid out **contiguously in allocation order**, so a traversal in that order is a perfect sequential prefetch stream (Ch. 28). Deallocation is free. There is no per-object header, so no space overhead and no cache line touched to find one.

**Why it is dangerous.** Individual deallocation is impossible; memory is reclaimed only in bulk. Lifetimes must be *phase-structured*: everything allocated in a phase dies at the end of the phase.

**Where it fits.**
- Per-request/per-tick/per-message scratch memory: reset the arena at the top of each event. This is the canonical low-latency pattern — allocation cost drops to near zero and there is no fragmentation drift over days of uptime.
- Compilers, parsers, and AST construction (LLVM's `BumpPtrAllocator`).
- Graph/tree building where the whole structure is discarded together.

**Non-trivial destructors.** A bump allocator that just resets its cursor **never runs destructors**. Three options: (a) restrict the arena to trivially destructible types and `static_assert` it; (b) maintain a side list of `void(*)(void*)` destructor thunks run in reverse on reset (what `std::pmr::monotonic_buffer_resource` does *not* do, but arena libraries often do); (c) accept the leak deliberately for types that own nothing. Option (a) is the right default in a trading system.

**Growth.** A fixed arena returning null on exhaustion is the deterministic choice. A **chained** arena allocates a new (usually geometrically larger) block from an upstream allocator and links it; this is what `monotonic_buffer_resource` does (Ch. 8 §8.6). Chaining trades determinism for convenience — the first chunk allocation after exhaustion is a `malloc` and possibly a page fault, i.e. exactly the tail-latency event you were trying to avoid. Size the initial block from measured worst case and assert on overflow in test builds.

**Backing storage** should be page-aligned, prefaulted, and — if large — huge-page backed (§7.14). Arena + huge pages + first-touch on the owning NUMA node (Ch. 29) is the standard hot-path memory stack.

---

## 7.8 Stack Allocators

A **stack allocator** is an arena with LIFO deallocation: you may free, but only in reverse order. The addition over §7.7 is a **marker/scope** discipline.

```cpp
class StackArena {
    std::byte* base_; std::byte* cur_; std::byte* end_;
public:
    using Marker = std::byte*;
    Marker mark() const noexcept { return cur_; }
    void   release(Marker m) noexcept { cur_ = m; }        // pops everything after m
    void*  allocate(std::size_t n, std::size_t a) noexcept;
};

struct Scope {                       // RAII (Ch. 5 §5.8)
    StackArena& a; StackArena::Marker m;
    explicit Scope(StackArena& x) : a(x), m(x.mark()) {}
    ~Scope() { a.release(m); }
};
```

This gives nested, reusable scratch regions at essentially zero cost — the dominant pattern for per-frame/per-message temporary buffers where an arena reset is too coarse.

### `alloca` and VLAs

`alloca(n)` allocates on the **real** call stack by adjusting the stack pointer; the memory dies when the function returns.

```cpp
void f(std::size_t n) {
    void* p = alloca(n);      // one SUB RSP; no bookkeeping
    int   vla[n];             // C99 VLA; a GNU extension in C++, NOT standard C++
}
```

Properties and hazards:

- Cost is a single register adjustment. Nothing beats it.
- **No failure indication.** Overflow silently walks past the guard page. With a guard page you get `SIGSEGV`; a sufficiently large `n` can *skip over* the guard page entirely and corrupt other memory — this is the classic "stack clash" vulnerability class. `-fstack-clash-protection` emits probing code to close it.
- `alloca` inside a loop accumulates until function exit.
- Returning the pointer is UB; passing it downward is fine.
- Interacts badly with inlining and with `setjmp`/exceptions; MSVC's `_alloca` differs.
- VLAs are **not standard C++** (proposed and rejected; `std::inplace_vector`, C++26, is the sanctioned answer — Ch. 11).

The safe modern form is a **small-buffer** pattern: a fixed on-stack array with heap fallback, which is exactly what `std::pmr::monotonic_buffer_resource` over a stack buffer gives you (Ch. 8 §8.6), or `boost::container::small_vector` / `llvm::SmallVector`.

```cpp
std::byte buf[4096];
std::pmr::monotonic_buffer_resource mr{buf, sizeof buf, std::pmr::null_memory_resource()};
std::pmr::vector<int> v{&mr};    // no heap traffic until 4 KB is exceeded, then THROWS
```

Using `null_memory_resource()` as upstream converts silent heap fallback into a loud `bad_alloc` — a good hot-path discipline, since silent fallback is precisely the thing that produces an unexplained tail-latency spike in production.

**Thread-stack sizing** matters here: the default 8 MB `RLIMIT_STACK` on Linux is virtual, so a large on-stack buffer costs address space and page faults, not RSS, until touched. Guard pages are one page by default (Ch. 31), which is what makes large `alloca` unsafe.

---

## 7.9 Free-List and Slab Allocators

### Free lists

A **free list** threads a singly linked list through the free blocks themselves, storing the `next` pointer *inside* the free block. This is why it has zero space overhead when in use:

```
free list head ──▶ [next]──▶ [next]──▶ [next]──▶ null
                   block A    block B    block C

allocate: p = head; head = *(void**)head; return p;     // 2 loads, 1 store
free:     *(void**)p = head; head = p;                  // 1 load, 2 stores
```

Both operations are O(1) and branch-free. The costs are non-obvious:

- **Pointer chasing.** Each `allocate` dereferences the block to read `next` — a dependent load into memory that is by definition cold (nothing has touched it). A free list that has been shuffled by usage produces a random-access miss per allocation, and the miss is on the *critical path* because the next allocation depends on it. This is the main reason free lists underperform their instruction count.
- **Order degradation.** A freshly built list is in address order and prefetches well; after a workload it is in death order, which is effectively random. Periodically rebuilding (or using an index-based free list — Ch. 21 — where `next` is a `uint32_t` index into a dense array) restores locality and halves the pointer size.
- **LIFO is right.** Pushing to the head means the next allocation returns the most recently freed block, which is the most likely to be cache-hot. FIFO free lists are measurably worse.

### Slab allocation

A **slab allocator** (Bonwick, SunOS 1994; the model for the Linux kernel's `kmem_cache`) allocates one or more pages — a **slab** — and carves it into fixed-size objects of a single type, keeping a free list per slab and a set of slabs per **cache**:

```
kmem_cache "Order"  ──┬─▶ slab (full)      [O][O][O][O][O][O]
                      ├─▶ slab (partial)   [O][O][ ][O][ ][ ]  ──▶ freelist
                      └─▶ slab (empty)     [ ][ ][ ][ ][ ][ ]
```

The design points that matter:

- **No fragmentation within a cache** — every object is the same size, so any free slot fits any request. Fragmentation is pushed out to whole-slab granularity.
- **Constructor caching.** Bonwick's original insight: objects in a slab retain their *constructed* state when freed, so re-allocation skips initialization of invariant fields. In C++ this maps to object pools (§7.10) that keep objects alive and merely reset them.
- **Cache coloring.** Successive slabs offset their first object by a different multiple of the cache-line size, so objects at the same index in different slabs do not map to the same cache set. Without it, a hot field at a fixed offset in many objects causes **conflict misses** on one set (Ch. 28). This is a genuinely non-obvious detail and a strong signal in an interview.
- **Per-CPU magazines** (later addition): a small per-CPU array of pointers acting as a cache in front of the shared slab list, so the common case takes no lock at all. glibc's tcache and tcmalloc's thread caches are the same idea.

### Comparison

| | Bump/arena | Free list | Slab |
|---|---|---|---|
| Allocate | pointer add | list pop (dependent load) | magazine pop → list pop |
| Free | no-op | list push | list push |
| Individual free | no | yes | yes |
| Sizes | any | one per list | one per cache |
| Internal fragmentation | alignment only | size-class rounding | none within cache |
| External fragmentation | none | none (fixed size) | whole-slab only |
| Locality | excellent (allocation order) | degrades with use | good (coloring) |

---

## 7.10 Object Pools

An **object pool** is a free list specialized to one C++ type, and the standard hot-path allocation strategy in trading systems. Two variants, and the distinction is the interview question:

**Storage pool** — holds raw, uninitialized slots; `acquire()` returns storage and you placement-new into it; `release()` runs the destructor and returns the slot.

**Object pool proper** — holds *constructed* objects that are reset rather than destroyed. Avoids constructor/destructor cost entirely but requires an explicit `reset()` and means the object's invariants must survive being idle.

```cpp
template <class T, std::size_t N>
class Pool {
    // storage: correctly sized and aligned, no T constructed yet
    alignas(T) std::byte storage_[N * sizeof(T)];
    T*  free_ = nullptr;                       // intrusive free list through the slots

public:
    Pool() noexcept {
        for (std::size_t i = N; i-- > 0; ) {   // build in reverse → list ends up in address order
            auto* slot = reinterpret_cast<T*>(storage_ + i * sizeof(T));
            *reinterpret_cast<T**>(slot) = free_;
            free_ = slot;
        }
    }
    template <class... A> T* create(A&&... a) {
        if (!free_) return nullptr;            // deterministic exhaustion, no fallback
        T* p = free_;
        free_ = *reinterpret_cast<T**>(p);
        return ::new (static_cast<void*>(p)) T(std::forward<A>(a)...);
    }
    void destroy(T* p) noexcept {
        p->~T();
        *reinterpret_cast<T**>(p) = free_;
        free_ = p;
    }
};
```

Details that matter:

- `sizeof(T) >= sizeof(T*)` is required to thread the list through the slot; `static_assert` it. For smaller `T`, use an index-based list.
- Building the free list in reverse leaves it in ascending address order, so the first N allocations are sequential and prefetch-friendly.
- **Deterministic exhaustion.** Returning null (or throwing) on empty is the point: a pool that silently falls back to `new` reintroduces the tail latency it exists to remove. Size the pool from the measured worst case and alarm on high-water mark.
- **Prefault and warm.** At startup, touch every slot (and ideally cycle the pool once) so pages are resident and the TLB/caches are primed. A pool whose pages fault on first use in production has moved the cost, not removed it.
- **Thread safety.** The single-threaded version above is the fast one. A shared pool needs either a mutex (defeats the purpose), a lock-free stack (which has the **ABA problem** — Ch. 26 §26.10 — requiring tagged pointers), or, best, **per-thread pools** with a cross-thread return path (an MPSC queue back to the owner). "Allocate on thread A, free on thread B" is the hard case and the one to raise unprompted.
- **Type erasure of the handle.** A pooled object handed out as `std::unique_ptr<T, PoolDeleter>` (Ch. 9 §9.2) gets RAII safety at zero size cost if the deleter is stateless, or one pointer if it must remember the pool.

**Comparison with `std::pmr::unsynchronized_pool_resource`** (Ch. 8 §8.7): the standard pool resource is size-class based, chains upstream on exhaustion, and is meaningfully slower than a hand-rolled single-type pool — but it's standard, allocator-aware, and correct. Use it where you'd otherwise write a mediocre pool; hand-roll on the critical path.

---

## 7.11 Fixed-Size Block Allocators

A **fixed-size block allocator** partitions a region into equal blocks and manages occupancy with a bitmap or a free list. It generalizes §7.10 to raw bytes, and it is the allocator underneath most message/packet buffer pools.

**Bitmap vs free list** is the design axis:

| | Free list | Bitmap |
|---|---|---|
| Allocate | O(1) pop | scan for a set bit — O(n/64) worst, O(1) with a hint or hierarchical summary |
| Free | O(1) push | clear bit: `bitmap[i>>6] &= ~(1ull<<(i&63))` — O(1), no pointer write into the block |
| Metadata | in-block (`next`) | out-of-band, 1 bit per block |
| Touches freed block | **yes** (cache miss) | **no** |
| Detects double free | no | yes (bit already clear) |
| Contiguous multi-block | no | yes (scan for a run) |
| Ordered/compact allocation | no | yes (lowest free index) |

The bitmap's key advantage for low latency is that freeing does **not write into the block**, so a cold freed buffer never has to be pulled into cache. `std::countr_zero` / `__builtin_ctzll` (Ch. 15) makes the scan a single `TZCNT`, and a two-level bitmap (a summary word whose bits mark non-full words) makes allocation O(1) up to 4096 blocks with two loads.

**Size classes.** A general allocator built from fixed-size blocks rounds each request up to the next class. Classes are typically powers of two, or a finer geometric series (tcmalloc uses ~88 classes with roughly 12.5% spacing) to reduce internal fragmentation. The trade-off is direct: fewer classes → more internal waste; more classes → more partially-used slabs, i.e. more external fragmentation and worse cache footprint of the allocator's own metadata.

```
request 100 bytes:
  power-of-two classes:   → 128-byte block, 28 wasted (28%)
  tcmalloc-style:         → 112-byte block, 12 wasted (12%)
```

**Trading-system shape.** Network/message buffers are almost always a fixed-size block allocator sized to MTU (1500 or 9000 bytes) or to the largest protocol message, with the block count set by the maximum in-flight depth. Because every block is identical, a buffer can be handed between the receive path, the parser, and the strategy without copying, and freed from any of them. Registering the whole region once with the NIC (Ch. 47, memory registration) is only possible because the region is contiguous and fixed — another reason the fixed-block design wins over general allocation for I/O.

**Guard/poison patterns.** In debug builds, writing `0xDEADBEEF` over a freed block and checking it on allocate catches use-after-free cheaply; a redzone byte before and after each block catches overruns. ASan (Ch. 44) does the industrial version, but a custom allocator must call `ASAN_POISON_MEMORY_REGION`/`ASAN_UNPOISON_MEMORY_REGION` manually or ASan sees nothing — pool allocators are a well-known blind spot for sanitizers, and saying so is a strong answer.

---

## 7.12 General-Purpose Allocator Implementations

You should be able to compare the four mainstream allocators and justify a choice.

| | glibc ptmalloc2 | tcmalloc | jemalloc | mimalloc |
|---|---|---|---|---|
| Thread caching | tcache (2.26+), 7 chunks × 64 classes | per-thread (now per-CPU) caches | tcache per thread | per-thread heaps, free lists sharded per page |
| Global structure | up to 8×ncores arenas, mutex each | central free lists + page heap | arenas + extents, size classes | segments (4 MB) → pages → blocks |
| Size classes | bins by size | ~88 classes | ~40 classes, 4 spacing groups | ~48 classes |
| Cross-thread free | goes to the freeing thread's cache | back to central list | remote free to owning arena | **separate "thread-free" list per page**, atomic push |
| Returning to OS | `M_TRIM_THRESHOLD`, `munmap` for big blocks | background release, `MADV_DONTNEED` | **decay-based purging**, tunable `dirty_decay_ms` | `MADV_FREE` |
| Profiling | `mtrace`, poor | built-in heap profiler | built-in, excellent (`prof`, `stats_print`) | basic |
| Fragmentation | worst; arena blowup | good | best (extent-based, decay purging) | good |
| Typical small-alloc latency | ~15–25 ns hot, cliff on arena lock | ~10–15 ns | ~10–20 ns | ~8–15 ns |

**How to choose.** For throughput servers with many threads, jemalloc or tcmalloc, chosen mostly on whether you value jemalloc's profiling and fragmentation behavior or tcmalloc's raw speed. For latency-sensitive single-writer processes, the allocator choice matters far less than *not allocating* — but jemalloc's tunable decay and `background_thread` control give you a way to stop purge-induced `madvise` syscalls from landing on your hot thread. Setting `dirty_decay_ms:-1,muzzy_decay_ms:-1` (never return memory) is a standard trading-system configuration, mirroring `mallopt(M_TRIM_THRESHOLD,-1)` on glibc.

**Non-obvious details worth having ready:**

- Allocator swaps are frequently **the** cheapest large win on a multithreaded service, and cost one `LD_PRELOAD` or one link flag.
- Thread caches are why allocation appears cheap in microbenchmarks: a single-threaded loop hits the thread cache every time and never exercises the central lock. Benchmarks that don't model cross-thread free are worthless (Ch. 43).
- **Cross-thread free** is the discriminator. A producer-allocates/consumer-frees pipeline (exactly the shape of a feed handler) is the pathological case for arena-based allocators, because the memory migrates and the freeing thread must synchronize. mimalloc's per-page thread-free list is a direct response.
- **Transparent huge pages** interact with allocators: THP can inflate RSS enormously when an allocator's sparse arenas get 2 MB backing (`khugepaged` collapsing), and can cause multi-millisecond stalls on fault (Ch. 32, Ch. 35). Many latency shops set `/sys/kernel/mm/transparent_hugepage/enabled = madvise` and let the allocator opt in explicitly.
- Every one of these is a *general* allocator: it must handle arbitrary sizes, arbitrary lifetimes, and arbitrary thread patterns. A special-purpose allocator that knows the size and the lifetime beats all of them by an order of magnitude, which is the whole argument of §7.7–§7.11.

---

## 7.13 Internal and External Fragmentation

**Internal fragmentation** — memory allocated to a request but unused by it. Sources: size-class rounding, alignment padding, per-allocation headers, and the object's own struct padding (Ch. 3 §3.2).

**External fragmentation** — free memory that exists but cannot satisfy a request because it is not contiguous.

```
Internal:   request 100 → [ 100 used | 28 wasted ]  in a 128-byte class
External:   [used][free 64][used][free 64][used]    ← 128 bytes free, 128-byte request FAILS
```

The distinction is not academic: they have opposite fixes. Internal fragmentation is reduced by *more* size classes; external fragmentation is reduced by *fewer* (so free blocks are interchangeable). Every allocator sits somewhere on that trade-off.

### Why C++ cannot compact

Garbage-collected runtimes solve external fragmentation by moving objects and updating references. C++ pointers are stable by contract — an address, once given out, must remain valid — so **compaction is impossible**. This is the fundamental reason a long-running C++ process can accumulate fragmentation indefinitely and the only real cures are structural.

Consequences and mitigations:

- **RSS grows without a leak.** A process whose live heap is constant at 2 GB can hold 8 GB RSS after a burst, because the peak allocated a wide spread of blocks and freeing them left holes the allocator retains. This is the most common "we have a memory leak" false alarm; the diagnostic is comparing live bytes (from `jemalloc`'s `stats_print` or a heap profiler) against RSS (Ch. 32).
- **Long-running trading processes** run for a full session or longer, so fragmentation is a *latency* risk too: a fragmented heap means more distinct pages touched per unit of live data, worse TLB behavior, and eventually a slow path in the allocator's search.
- **Structural fixes**: fixed-size pools (§7.10, §7.11) eliminate external fragmentation by construction; arenas (§7.7) eliminate it by bulk reset; preallocating everything at startup eliminates it by never allocating again.
- **Allocator-level mitigation**: jemalloc's extent-based design and decay purging keep fragmentation low and actively return dirty pages; `malloc_trim()` on glibc is the manual equivalent — but it walks the heap and is a latency event, so schedule it off the hot path if at all.
- **`MADV_FREE` vs `MADV_DONTNEED`**: `DONTNEED` returns pages immediately (next touch is a fresh zero page fault); `FREE` marks them reclaimable lazily, so RSS reporting looks high until pressure arrives. Knowing why RSS "doesn't go down" after a free is a good practical answer.

**Measurement**: `pmap -x`, `/proc/self/smaps_rollup` for RSS/PSS, `jemalloc`'s `malloc_stats_print`, heaptrack, and `massif`. Blowup is expressed as the ratio of RSS to live bytes; anything above ~1.5 warrants investigation.

---

## 7.14 Huge-Page-Backed Arenas

A **huge page** is a single page-table entry covering 2 MB (or 1 GB) instead of 4 KB. The benefit is almost entirely **TLB reach**.

```
Data-TLB (typical x86-64 core): ~64 L1 entries, ~1536-2048 L2 (STLB) entries

4 KB pages:  1536 × 4 KB   =    6 MB covered
2 MB pages:  1536 × 2 MB   = 3072 MB covered      ← 512× the reach
```

A working set larger than TLB reach takes a **page walk** on miss — up to four dependent memory accesses through the page tables, ~50–100 cycles even with paging-structure caches, and the walk itself pollutes the data cache (Ch. 32). For a random-access structure like a large hash map or an order book spread over hundreds of megabytes, TLB misses can be a double-digit percentage of runtime, and huge pages remove most of them. Secondary benefits: fewer page faults (one per 2 MB rather than 512) and less page-table memory.

### The two mechanisms

| | Explicit (hugetlbfs) | Transparent (THP) |
|---|---|---|
| Setup | Reserve at boot or via `nr_hugepages`; `mmap(MAP_HUGETLB)` or hugetlbfs file | On by default (`always`) or per-`madvise` |
| Guaranteed | **Yes** — reserved pool, no fallback | No — falls back to 4 KB silently |
| Swappable | No (a feature: never paged out) | Yes |
| Latency risk | Allocation fails loudly if pool is short | **`khugepaged` collapse stalls**, direct-compaction stalls on fault |
| Fragmentation | Pool is fixed | Can inflate RSS badly with sparse arenas |

**The low-latency verdict** is consistent across the industry: use `MADV_HUGEPAGE` explicitly on regions you have chosen, set the system policy to `madvise` rather than `always`, and set `defrag` to `defer+madvise` or `never` so a fault never triggers synchronous compaction. `always`+`defrag=always` is the configuration that produces mysterious multi-millisecond stalls in a busy-poll thread (Ch. 35).

### Building the arena

```cpp
constexpr std::size_t HP = 2 * 1024 * 1024;
std::size_t bytes = (want + HP - 1) & ~(HP - 1);          // round to 2 MB

void* p = ::mmap(nullptr, bytes, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS | MAP_POPULATE, -1, 0);
// or MAP_HUGETLB for guaranteed huge pages from the reserved pool
::madvise(p, bytes, MADV_HUGEPAGE);
std::memset(p, 0, bytes);        // prefault every page NOW, not on the hot path
::mlock(p, bytes);               // never swap; requires RLIMIT_MEMLOCK
Arena arena{static_cast<std::byte*>(p), bytes};
```

The three requirements that make this actually work, each a common omission:

1. **2 MB alignment.** THP will not back a region whose start is not 2 MB aligned; `mmap` returns page-aligned, not huge-page-aligned, so over-allocate and align manually, or use `MAP_HUGETLB` (which aligns).
2. **Prefault and lock at startup.** Otherwise the first touch in production takes the fault — and a huge-page fault zeroes 2 MB, which is *slower* than a 4 KB fault, not faster. Huge pages move cost to startup; they do not remove it.
3. **NUMA first-touch.** The thread that first touches a page determines its node (Ch. 29). Prefault from the thread (and CPU) that will use the arena, or set an explicit policy with `mbind`/`numactl --membind`, or you get a permanent remote-memory penalty on every access.

**Measurement**: `perf stat -e dTLB-load-misses,dtlb_load_misses.walk_active` before and after; `/proc/self/smaps` `AnonHugePages` to confirm the region is actually huge-page backed; `/proc/meminfo` `HugePages_*` for the explicit pool. Confirming with `smaps` matters — a large fraction of "we enabled huge pages" claims turn out to be unaligned regions silently getting 4 KB pages.

---

## Key Interview Questions

1. **What are the two steps of a new-expression?** — Call `operator new` for storage, then construct in place; `delete` inverts it. Only the allocation function is replaceable.
2. **What happens if a constructor throws in `new T`?** — The runtime calls the matching `operator delete` automatically, so storage isn't leaked; this is why a matching deallocation function must exist.
3. **Why is `delete p` on an array UB rather than just a leak?** — With a cookie, the pointer you hold is offset from the allocation start, so you hand the allocator a pointer it never issued: heap corruption plus skipped destructors.
4. **When does `new T[n]` allocate more than `n*sizeof(T)`?** — When `T` has a non-trivial destructor and an array cookie is needed to record the count.
5. **How do you make one class use a pool without changing call sites?** — Class-scope `operator new`/`operator delete`; note they're implicitly static and that correct dispatch on `delete basePtr` requires a virtual destructor.
6. **What did C++17 change about alignment and `new`?** — `alignas` beyond `__STDCPP_DEFAULT_NEW_ALIGNMENT__` now selects `operator new(size_t, align_val_t)`; before that, over-aligned `new` was silently broken.
7. **What's the trap in `aligned_alloc`?** — Size must be a multiple of alignment (pre-C23), and MSVC doesn't provide it — `_aligned_malloc` must be freed with `_aligned_free`.
8. **Why isn't `calloc` just `malloc` + `memset`?** — Fresh kernel pages are already zero, so the write is skipped; the cost reappears as one page fault per page on first touch.
9. **Why can't `std::vector` use `realloc`?** — `realloc` may `memcpy`, which is only valid for trivially copyable types; `vector` must run move constructors. Trivial relocatability (C++26) is the fix.
10. **What does `p = realloc(p, n)` do wrong?** — On failure `realloc` returns null without freeing, so the original block leaks.
11. **What is tcache and where's the latency cliff?** — glibc's per-thread free-list cache (7 chunks × 64 classes), lock-free; overflowing it drops to the arena mutex.
12. **Does `new_handler` ever run on Linux?** — Rarely: overcommit means allocation succeeds and the OOM killer `SIGKILL`s you later. `bad_alloc` in practice means a bogus size, not exhaustion.
13. **How do you get deterministic allocation failure?** — cgroup/`RLIMIT_AS` limits, `overcommit_memory=2`, `mlockall` + prefault, and preallocating everything at startup.
14. **Bump allocator: what do you gain and give up?** — 2–5 ns allocation, contiguous layout, zero fragmentation, free bulk release; you give up individual deallocation and destructor execution.
15. **How would you handle non-trivially-destructible types in an arena?** — Restrict to trivially destructible types with a `static_assert`, or record destructor thunks and run them in reverse on reset.
16. **Free list vs bitmap for a fixed-block allocator?** — Free list is O(1) but writes into (and cache-misses on) the freed block; bitmap keeps metadata out-of-band, detects double frees, and supports contiguous runs at the cost of a scan.
17. **What is cache coloring in a slab allocator?** — Offsetting each slab's first object so equally-indexed objects across slabs don't collide in the same cache set, avoiding conflict misses.
18. **Which is worse in a long-running C++ process, internal or external fragmentation, and why can't you compact?** — External, because pointers must stay stable so objects can't be moved; fix it structurally with pools and arenas.
19. **Why does RSS stay high after freeing a lot of memory?** — Allocators retain freed pages (`MADV_FREE` defers reclaim; trim thresholds keep the heap), and holes can't be compacted.
20. **When do huge pages help, and how do they hurt?** — They multiply TLB reach ~512× for large random-access working sets; they hurt via `khugepaged` collapse stalls, synchronous compaction on fault, and RSS inflation. Use `madvise` mode, prefault, and align to 2 MB.

---

## Common Traps

- **Mismatching `new`/`delete[]`, `new[]`/`delete`, `malloc`/`delete`, `new`/`free`** — all UB, all usually "work" until they corrupt the heap.
- **`delete` through a base pointer without a virtual destructor** — wrong deallocation function and wrong size passed to sized delete.
- **`new int` vs `new int()`** — the first leaves the value indeterminate.
- **Assuming `new (std::nothrow)` never throws** — it suppresses `bad_alloc`, not a throwing constructor.
- **A `new_handler` that returns without freeing anything** — infinite loop.
- **`p = realloc(p, n)`** — leaks the old block on failure.
- **`malloc(0)`** — may legally return null; treating null as failure misclassifies it.
- **Relying on `bad_alloc` as an out-of-memory strategy on Linux** — overcommit and the OOM killer make it unreachable.
- **Over-aligned types with pre-C++17 `new`** — alignment silently ignored, SIMD faults later.
- **`aligned_alloc` with a size that isn't a multiple of the alignment**; **`_aligned_malloc` freed with `free`**.
- **Arena reset without running destructors** — leaks anything the objects owned.
- **Arena or pool that silently falls back to `malloc` on exhaustion** — reintroduces exactly the tail latency it was built to eliminate. Use `null_memory_resource` or return null.
- **Large `alloca`/VLA** — no failure signal, can jump the guard page (stack clash); not standard C++.
- **Returning an `alloca` pointer** or calling `alloca` in a loop.
- **Free lists that thread through blocks smaller than a pointer** — silent corruption; `static_assert(sizeof(T) >= sizeof(void*))`.
- **FIFO free lists** — hands back the coldest block instead of the hottest.
- **Custom allocators without ASan poisoning hooks** — sanitizers see one big live region and miss every use-after-free.
- **Benchmarking an allocator single-threaded** — measures only the thread cache; cross-thread free is the real workload.
- **Assuming a huge-page `madvise` worked** — unaligned regions silently fall back to 4 KB; verify in `/proc/self/smaps`.
- **Prefaulting from the wrong thread** — NUMA first-touch pins the pages to the wrong node permanently.
- **Leaving THP at `always` with `defrag=always`** — synchronous compaction stalls in a busy-poll thread.

---

## Compact Recall Summary

**new/delete.** A new-expression is allocation function + construction; `delete` is destruction + deallocation function. A throwing constructor auto-calls the matching `operator delete`. Default `operator new` throws `bad_alloc` and never returns null; the `nothrow` overload returns null after still running the new-handler loop. C++14 sized delete lets size-classed allocators skip the size lookup. `delete nullptr` is a no-op; mismatched pairs are UB.

**Arrays.** `new T[n]` stores an **array cookie** ahead of the pointer when `T` has a non-trivial destructor, so the pointer you hold isn't the allocation start — that's why `delete` on an array corrupts rather than leaks. No polymorphic arrays. Prefer `vector`/`array`/`unique_ptr<T[]>`; use `make_unique_for_overwrite` (C++20) to skip value-initialization of large buffers.

**Overloading.** Global `operator new`/`delete` are *replaceable*, not overloadable — define them and the linker takes yours (this is how tcmalloc/jemalloc integrate, or via `LD_PRELOAD`). Replace the whole family, including sized and aligned forms. Class-scope operators are implicitly static and need a virtual destructor to dispatch correctly. Extra parameters make placement forms; the matching placement delete runs only on a throwing constructor.

**Alignment.** C++17 routes over-aligned `new` through `align_val_t`. `aligned_alloc` requires size to be a multiple of alignment; MSVC needs `_aligned_malloc`/`_aligned_free`. Alignment is correctness for SIMD and atomics (split lock = whole-machine stall), performance for cache-line straddles, and a precondition for huge pages. `std::align` and `std::assume_aligned` are the portable tools.

**C allocator.** `calloc` gets zeroing free from the kernel but defers the cost to page faults. `realloc` may move via `memcpy`, which is why `vector` can't use it, and returns null without freeing on failure. glibc: tcache (per-thread, lock-free, the fast path) → fastbins → bins → top chunk → `mmap` above a *dynamic* threshold. `mallopt(M_MMAP_THRESHOLD/M_TRIM_THRESHOLD)` to stop the allocator from returning memory and issuing `munmap`/TLB shootdowns.

**Failure.** `new_handler` must free memory, replace itself, or terminate — else infinite loop. On Linux overcommit makes genuine OOM arrive as `SIGKILL`, not `bad_alloc`; treat `bad_alloc` as a size-computation bug. Real control comes from cgroups/`RLIMIT_AS`, `mlockall`, and preallocation. Hot paths don't allocate, so they can't fail.

**Special-purpose allocators.** *Arena/bump*: pointer add, contiguous layout, O(1) bulk reset, no individual free and no destructors. *Stack*: arena + LIFO markers, RAII scopes; `alloca`/VLAs are faster still but have no failure signal (stack clash) and VLAs aren't standard C++. *Free list*: O(1) push/pop threaded through free blocks, but every allocation is a dependent cold load and order degrades with use; LIFO is right. *Slab*: per-type caches of fixed-size objects, no internal fragmentation, cache coloring to avoid conflict misses, per-CPU magazines to avoid locks. *Object pool*: free list + placement new, deterministic exhaustion, prefault and warm at startup, cross-thread free is the hard part. *Fixed-block*: bitmap metadata avoids touching the freed block, detects double frees, and supports contiguous runs; size classes trade internal against external fragmentation.

**General allocators.** ptmalloc2 (arena blowup, tcache), tcmalloc (fast, per-CPU caches), jemalloc (best fragmentation and profiling, decay purging), mimalloc (per-page thread-free lists, best cross-thread free). Swapping allocators is often the cheapest multithreaded win. Producer-allocates/consumer-frees is the pathological pattern.

**Fragmentation.** Internal = rounding/headers/padding waste inside a block; external = free-but-noncontiguous. Opposite fixes (more vs fewer size classes). C++ cannot compact because addresses are stable, so RSS ≫ live bytes is normal and not a leak; the structural cures are pools, arenas, and startup preallocation.

**Huge pages.** 2 MB pages multiply TLB reach ~512×, cutting page walks on large random-access working sets. Explicit hugetlbfs guarantees pages and never swaps; THP is convenient but can stall on compaction and inflate RSS. Correct recipe: 2 MB-aligned `mmap`, `MADV_HUGEPAGE`, prefault (`MAP_POPULATE`/memset) and `mlock` at startup, first-touch from the owning NUMA node, then verify `AnonHugePages` in `/proc/self/smaps`.
