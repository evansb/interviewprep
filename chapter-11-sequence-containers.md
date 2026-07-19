# Chapter 11 — Sequence Containers

*Interview-focused revision notes. The theme: every sequence container is a different answer to one question — where do the elements live relative to each other in memory — and on modern hardware that single choice dominates asymptotic complexity, iterator stability, and allocation behavior alike.*

---

## 11.1 `std::array`

`std::array<T, N>` is an **aggregate** wrapping a raw `T[N]`. It has no constructors, no allocator, no dynamic storage, and — critically — no indirection: the elements *are* the object.

```cpp
template <class T, size_t N>
struct array {
    T __elems[N];        // the entire representation
    // ... member functions, no data
};
static_assert(sizeof(std::array<int, 8>) == 32);
static_assert(std::is_trivially_copyable_v<std::array<int, 8>>);
static_assert(std::is_standard_layout_v<std::array<int, 8>>);
```

Because it is an aggregate with a public array member, `std::array` is standard-layout and trivially copyable whenever `T` is (Ch. 3 §3.5, §3.6). It can go in shared memory, be `memcpy`'d, be an NTTP in C++20, and be used in `constexpr` code end to end.

### What it buys over `T[N]`

| Property | `T arr[N]` | `std::array<T,N>` |
|---|---|---|
| Decays to a pointer | **Yes** (Ch. 2 §2.15) | No |
| Knows its size after passing | No | `size()` |
| Assignable / copyable | No | Yes (element-wise) |
| Returnable from a function | No | Yes |
| Comparison operators | Pointer comparison (a bug) | Lexicographic (`<=>` in C++20) |
| Works with range-for, `begin`/`end` | Yes (via ADL `std::begin`) | Yes |
| Bounds-checked access | No | `at()` throws |
| Zero-size case | Ill-formed (`T x[0]` is a GNU extension) | `array<T,0>` is valid, `empty()`, `data()` may return null, **`begin()==end()`**, `front()`/`back()` are UB |

### Initialization traps

```cpp
std::array<int, 3> a;         // DEFAULT-init: elements are INDETERMINATE for trivial T
std::array<int, 3> b{};       // value-init: all zero
std::array<int, 3> c{1};      // {1, 0, 0} — remaining elements value-initialized
std::array<int, 3> d = {1,2,3};
std::array<std::array<int,2>,2> e{{{1,2},{3,4}}};   // the double-brace question
```

The double brace is because `array` has one member (the inner C array), so brace elision applies but is not always deducible; `{{...}}` is always correct. C++17 CTAD gives `std::array a{1,2,3};` → `array<int,3>`, and `std::to_array` (C++20) handles the cases CTAD cannot, notably `to_array("hi")` → `array<char,3>` and arrays of non-copyable types from a braced list.

### Structured bindings and tuple protocol

`std::array` models the tuple protocol (`tuple_size`, `tuple_element`, `get<I>`), so `auto [x, y, z] = a;` works and `std::get<I>(a)` is compile-time bounds-checked — unlike `a[i]`, which is unchecked, and `a.at(i)`, which throws.

### Low-latency notes

- **Zero indirection**: iterating `array<T,N>` is iterating a contiguous block; the hardware prefetcher (Ch. 28) handles it perfectly. Contrast `vector`, where the data is one pointer dereference away and typically on a different page from the container object.
- **`alignas` composes**: `alignas(64) std::array<double, 8> v;` gives you a cache-line-aligned, SIMD-friendly block (Ch. 42).
- **Large `array` as a member is a stack-size hazard.** `std::array<char, 1<<20>` as a local blows an 8 MB default stack in 8 frames and can skip the guard page on older compilers (`-fstack-clash-protection` mitigates; Ch. 32).
- **Passing by value copies all N elements.** Take `const std::array&`, or better `std::span<const T>` (Ch. 13) to accept any contiguous range.
- `std::array` is the natural element type for fixed-shape market-data messages and for lookup tables that you want in `.rodata` (`constexpr std::array` is a compile-time table with no static initialization order concerns — Ch. 5).

---

## 11.2 `std::vector`

`std::vector<T>` is a contiguous, dynamically-sized array. Every mainstream implementation stores **three pointers**:

```
struct vector {
    T* begin_;      // start of the buffer
    T* end_;        // one past the last constructed element   → size()     = end_ - begin_
    T* cap_;        // one past the allocated buffer            → capacity() = cap_ - begin_
};
sizeof(std::vector<int>) == 24 on x86-64 (libstdc++, libc++)
```

libstdc++ and libc++ both use pointer triples; MSVC also uses three pointers. A size/capacity pair of `size_t` would be the same 24 bytes but requires an extra add per dereference, which is why pointers won.

The vector object itself is 24 bytes on the stack (or wherever it lives); the **elements are elsewhere**, so `v[i]` costs a load of `begin_` plus the element load — two dependent loads, potentially two cache misses. This is the fundamental difference from `std::array` and the reason a hot inner loop should hoist `v.data()` into a local.

### Guarantees

- **Contiguity** is guaranteed since C++03/C++11 wording clarifications: `&v[n] == v.data() + n`, so `v.data()` can be handed to `read()`, `memcpy`, or a C API.
- `operator[]` is unchecked (UB out of range); `at()` throws `std::out_of_range`.
- `vector<bool>` is a **specialization that is not a container**: it packs bits, `operator[]` returns a proxy `reference`, `data()` does not exist, `&v[0]` does not give a `bool*`, and it breaks generic code. Universally regarded as a mistake. Use `std::vector<char>`, `std::vector<uint8_t>`, `std::bitset` (Ch. 15), or `boost::dynamic_bitset`.

### Complexity

| Operation | Complexity | Notes |
|---|---|---|
| `operator[]`, `front`, `back`, `data` | O(1) | one indirection |
| `push_back` / `emplace_back` | **Amortized O(1)** | O(n) on reallocation |
| `pop_back` | O(1) | never shrinks capacity |
| `insert`/`erase` at position `p` | O(n − index) | shifts the tail by move-assignment |
| `erase` at the end | O(1) | |
| `clear` | O(n) destructors, O(1) for trivially destructible | **capacity unchanged** |
| `resize` down | O(n) destructors | capacity unchanged |
| Iterating | O(n), maximally cache-friendly | |

### `push_back` vs `emplace_back`

`emplace_back(args...)` forwards to a placement-new in the buffer, avoiding a temporary. `push_back(T&&)` requires an already-constructed `T`. For `vector<std::string>`, `v.emplace_back("abc")` constructs in place; `v.push_back("abc")` builds a temporary and moves it (which for SSO strings is nearly the same, since a short-string move is a copy of the inline buffer).

Two non-obvious points: `emplace_back` uses **direct-initialization**, so it can invoke `explicit` constructors that `push_back` cannot (`std::vector<std::unique_ptr<T>> v; v.emplace_back(new T);` compiles and is a leak hazard — prefer `emplace_back(std::make_unique<T>())`). And `emplace_back` returns a `T&` since C++17, `push_back` returns `void`.

### Reference invalidation from self-referencing arguments

```cpp
v.push_back(v[0]);      // safe — the standard requires implementations to handle it
v.insert(v.begin(), v.back());   // also required to work
```
Implementations construct the new element before deallocating the old buffer precisely for this. But `v.push_back(v.data()[0])` after you cached `T* p = v.data()` is *not* safe — your own cached pointer dangles (§11.8).

### Low-latency posture

`vector` is the default sequence container and the right answer to "which container?" absent a specific reason. The hot-path concerns are: (a) the reallocation `malloc` (Ch. 7) — fix with `reserve`; (b) the extra indirection versus `array`/`inplace_vector`; (c) destructor loops on teardown for non-trivially-destructible `T`; (d) `vector<vector<T>>` being a pointer-chasing disaster — flatten to one `vector` plus an offset array, or use `mdspan` (Ch. 13). For a preallocated hot path, a `vector` `reserve`d once at startup with a custom or monotonic allocator (Ch. 8) behaves like a fixed array with a size.

---

## 11.3 Vector Growth and Capacity

**Size** is the number of constructed elements; **capacity** is how many fit before reallocation. `push_back` when `size == capacity` performs: allocate a new buffer of `growth(capacity)`, transfer elements (move-if-noexcept, Ch. 10 §10.3), destroy the old elements, deallocate the old buffer, then construct the new element.

### The growth factor

The standard requires only **amortized constant** `push_back`, which forces *geometric* growth (any constant factor > 1). Actual factors:

| Implementation | Factor |
|---|---|
| libstdc++ (GCC) | 2 |
| libc++ (Clang) | 2 |
| MSVC | 1.5 |
| folly `fbvector` | 1.5 |

Amortized analysis: with factor `k`, inserting `n` elements moves `n·k/(k−1)` elements total — 2n for k=2, 3n for k=1.5 — so both are O(1) amortized, and k=2 does *fewer* total moves.

The argument for 1.5 is **allocator memory reuse**: with k=2, the sum of all previously freed blocks (1+2+4+…+2^(i−1) = 2^i − 1) is always strictly less than the next request (2^i), so a freed-block coalescing allocator can never reuse the old blocks for the new one. With k < φ ≈ 1.618, the sum of previous blocks eventually exceeds the next request, so reuse is possible and the address space is not walked forward indefinitely. This is the standard interview question about growth factors and the golden ratio, and the correct answer includes the caveat that it only helps with allocators that coalesce, and that k=2 is cheaper in move count.

Neither is mandated. Do not write code that depends on capacity values; only on `capacity() >= size()` and the invalidation rules.

### Controlling capacity

```cpp
v.reserve(n);        // capacity >= n; reallocates once if needed; NEVER shrinks
v.resize(n);         // changes SIZE, value-initializing or destroying elements
v.shrink_to_fit();   // NON-BINDING request; may reallocate, may do nothing
v.clear();           // size = 0, capacity UNCHANGED
std::vector<T>().swap(v);            // the pre-C++11 idiom to actually free
v = std::vector<T>{};                // modern equivalent (move-assign frees the old buffer)
```

`reserve` is the single most valuable vector optimization: it converts n allocations and O(n) total moves into one allocation and zero moves.

Two traps:
- **`reserve` does not create elements.** `v.reserve(10); v[0] = x;` is UB. Use `resize` if you want elements.
- **`reserve` in a loop is quadratic.** `for (...) { v.reserve(v.size()+1); v.push_back(x); }` reallocates every iteration because `reserve` grows to *exactly* `n`, defeating geometric growth. Reserve once, up front.
- **`resize` grows geometrically? No** — `resize(n)` where `n > capacity` typically allocates exactly `n` in libstdc++ (actually `max(2*capacity, n)` in some paths; libc++ allocates exactly `n` for `resize`). Repeated `resize(size()+k)` can therefore be quadratic. Prefer `reserve` + `push_back`, or `resize` once.

### `assign`, `insert`, and bulk operations

`v.assign(first, last)` and range `insert` compute the distance for forward iterators and allocate once — strictly better than a `push_back` loop. C++23 adds **`append_range`, `assign_range`, `insert_range`, and `std::ranges::to<std::vector>`**, which do the same for any range and size the allocation from `ranges::size` when available.

### Memory footprint reality

After growth, the allocation is the *new* buffer while the old one is still live during the transfer — so peak RSS during a `vector` grow is ~1.5× (k=1.5) to 3× (k=2, both buffers) the final size. For a multi-gigabyte vector that is a real OOM risk and an argument for `deque` or a chunked structure.

**`shrink_to_fit` is non-binding**, and even when honored it allocates a new buffer and copies, so it can *increase* peak memory momentarily and it invalidates everything. It is also a poor fit for a hot path.

---

## 11.4 `std::deque`

`std::deque<T>` ("double-ended queue") gives O(1) `push_front`, `push_back`, `pop_front`, `pop_back`, and O(1) random access — but is not contiguous.

### Structure

```
  map (a dynamically-allocated array of pointers, itself reallocated occasionally)
  +----+----+----+----+
  | p0 | p1 | p2 | p3 |
  +--|-+--|-+--|-+--|-+
     v    v    v    v
   [chunk][chunk][chunk][chunk]      each chunk holds K elements contiguously
```

Random access is `map[i / K][i % K]` — a division (usually a shift, since K is a power of two in element count only if `sizeof(T)` cooperates; libstdc++ uses a *byte* size of 512, so K = max(1, 512/sizeof(T)) which is often not a power of two, making `operator[]` a real integer division or a multiply-by-reciprocal).

Chunk sizes: **libstdc++ 512 bytes**, **libc++ max(4096/sizeof(T), 16) elements** (so 4 KB per chunk for small T), **MSVC 16 bytes or 1 element** — a notoriously bad choice that makes MSVC's `deque` allocate roughly one block per element for anything larger than a pointer, giving it a reputation the other implementations don't deserve.

### Guarantees that vector cannot give

**Inserting or erasing at either end invalidates iterators but NOT references or pointers to existing elements.** This is `deque`'s unique property and its main reason to exist:

```cpp
std::deque<Order> d;
Order& o = d.front();
d.push_back(x);          // &o still valid!  (vector would have invalidated it)
d.push_front(y);         // still valid
d.erase(d.begin()+3);    // NOW everything may be invalidated (middle erase)
```

Contrast: `list` keeps references valid through *any* operation; `vector` invalidates on any reallocation.

### Trade-offs

| | `vector` | `deque` |
|---|---|---|
| Contiguous / `data()` | Yes | **No** |
| `push_front` | O(n) | **O(1)** |
| Reference stability on end insert | No | **Yes** |
| Random access cost | 1 indirection | 2 indirections + div/mod |
| Iteration cost | Optimal | ~1.5–3× slower; iterator holds 4 pointers and must check chunk boundaries |
| Memory overhead | ≤ (k−1)·size wasted | Chunk granularity + map |
| Allocations to build n elements | O(log n) | O(n/K) but each is small |
| Empty container allocations | **Zero** | libstdc++ allocates one chunk + map eagerly (~512 B) |
| Peak memory during growth | Up to 2–3× | ~1× (only the map is reallocated) |

That last row matters: growing a huge `deque` never doubles memory, which is why it is the right container for very large sequences where you cannot afford the reallocation spike, and why `std::stack` and `std::queue` default to `deque`.

**`deque` iterators are fat** — typically four pointers (cur, first, last, node) — so passing them around and comparing them is more expensive, and `std::sort` on a deque is measurably slower than on a vector even though both are random-access.

### Low-latency verdict

`deque` is rarely the right hot-path answer. If you need a FIFO, a **fixed-capacity ring buffer** (Ch. 21, Ch. 26) is contiguous, allocation-free, and cache-friendly, and it is what real trading systems use. `deque` is appropriate when you need unbounded growth with reference stability and O(1) both ends and cannot bound the size — for example a growable staging queue outside the critical path. Note also that `std::queue`/`std::stack` are **container adaptors**, and `std::stack<T, std::vector<T>>` is usually faster than the `deque` default.

---

## 11.5 `std::list` and `std::forward_list`

`std::list<T>` is a doubly-linked list; `std::forward_list<T>` (C++11) is singly-linked.

```
list node:          [prev][next][T]        24 + sizeof(T) bytes, one allocation each
forward_list node:  [next][T]              8 + sizeof(T) bytes
```

`std::list` is a **circular** doubly-linked list with a sentinel node embedded in the container object, which is how `end()` works and why `sizeof(std::list<T>)` is 24 in libstdc++ (two pointers plus a size — `size()` became O(1) and required in C++11).

`std::forward_list` is deliberately minimal: `sizeof == 8`, **no `size()`**, no `back()`, no `push_back`, and its mutating operations are `_after` variants (`insert_after`, `erase_after`, `emplace_after`) because a singly-linked list cannot reach the predecessor. `before_begin()` provides the handle for inserting at the front position.

### The guarantees

- **Every reference, pointer, and iterator remains valid across every operation except erasure of that element.** No other standard container is this stable.
- **O(1) `splice`**: moving a range of nodes between lists (or within one) is pure pointer surgery, no allocation, no element moves. `list::splice` for a single element is O(1); the range overload is O(1) if the lists are the same, O(distance) otherwise because `size()` must be maintained.
- `sort`, `merge`, `reverse`, `unique`, `remove` are **member functions** because the free algorithms require random access (`std::sort`) or would be O(n) moves. `list::sort` is a bottom-up merge sort operating on links — it never moves elements, so it works for immovable types and is stable.
- `remove_if` and `unique` return the count erased since C++20.

### Why it is almost always the wrong choice

| Cost | Detail |
|---|---|
| One allocation per element | `malloc` per `push_back` (Ch. 7); catastrophic without a pool allocator |
| 16–24 bytes overhead per element | A `list<int>` is 3–6× the memory of `vector<int>` |
| Pointer chasing | Every `++it` is a **dependent load**: the address of the next node is unknown until the current one arrives. The hardware prefetcher (Ch. 28) cannot help, memory-level parallelism (Ch. 29) is zero, and each step is a potential full ~80 ns cache miss. |
| Traversal to a position is O(n) | So "O(1) insert" is only true if you already hold the iterator |

Benchmarks consistently show `vector` beating `list` for insert-in-middle workloads up to tens of thousands of elements, because the O(n) `memmove` runs at many GB/s with perfect prefetching while the O(1) list insert requires an O(n) pointer-chasing traversal to find the position plus an allocation. Bjarne Stroustrup's demonstration of this is a standard interview reference.

### When a linked list *is* correct

1. **You hold the iterator already** and must splice, not copy — e.g. an LRU cache (Ch. 21): `std::list` + `unordered_map<K, list::iterator>` gives O(1) promote-to-front with stable iterators. This is the canonical legitimate use.
2. **Reference stability is a hard requirement** and the elements are large or immovable.
3. **Intrusive lists** (Ch. 21) — the node hooks live *inside* the element, so there is no per-element allocation, no separate node cache miss, and O(1) erase given only the element pointer. `boost::intrusive::list` and the Linux kernel's `list_head` are the model. **For low-latency work, an intrusive list is the answer and `std::list` is not** — the object is allocated once from a pool, the hook is a member, and the container never allocates.

`std::forward_list` exists for the memory-constrained case and is genuinely 8 bytes per node cheaper; it is rare in practice.

---

## 11.6 `std::inplace_vector` and Fixed-Capacity Vectors

`std::inplace_vector<T, N>` (**C++26**, P0843) is a sequence container with `vector`'s dynamic-size interface and `array`'s storage: capacity `N` fixed at compile time, elements stored **inline in the object**, no allocator, no allocation ever.

```
inplace_vector<T, N>:  [ aligned uninitialized storage for N T's ][ size_type size_ ]
```

It is `boost::container::static_vector`, `folly::small_vector<T,N,NoHeap>`, `absl::FixedArray`'s cousin, and EASTL's `fixed_vector` — an idiom so common it was standardized.

### Semantics

```cpp
std::inplace_vector<Order, 32> book;
book.push_back(o);                 // throws std::bad_alloc if size() == 32
book.try_push_back(o);             // returns pointer or nullptr — NO exception
book.unchecked_push_back(o);       // UB if full — the hot-path form
static_assert(book.capacity() == 32);
```

The three-way `push_back` / `try_push_back` / `unchecked_push_back` split is the design point worth naming: it lets a hot path opt out of both the branch and the exception after the caller has proven capacity.

Key properties:
- **Trivially copyable and trivially destructible when `T` is** — a deliberate specification requirement (via conditionally trivial special members, C++20). So `inplace_vector<int, 8>` can be `memcpy`'d, put in shared memory (Ch. 3 §3.12), and passed in registers when small.
- **`constexpr`-usable** throughout when `T` is trivial.
- **`inplace_vector<T, 0>` is valid and empty**, and is trivially everything.
- Iterators and references are invalidated only by operations that shift elements — and *never* by capacity growth, because there is none.

### Why it matters for low latency

| Property | `vector` | `inplace_vector<T,N>` | `array<T,N>` |
|---|---|---|---|
| Allocation | Heap, on growth | **None, ever** | None |
| Indirection to elements | 1 | **0** | 0 |
| Dynamic size | Yes | Yes | No |
| Overflow behavior | Grows | Throws / null / UB (your choice) | N/A |
| `sizeof` | 24 | `N*sizeof(T)` + size field | `N*sizeof(T)` |
| Suitable inside a message struct | No | **Yes** | Yes |

Zero indirection is the headline: the elements are in the same cache line(s) as the container, so a small collection is one cache miss instead of two, and the object can be embedded in a market-data message, an order struct, or a lock-free queue slot (Ch. 26) with no pointer at all.

The cost is that `sizeof` is always `N` elements even when empty, so it is unsuitable for large `N` or for containers-of-containers, and moving one is O(size) element moves rather than a pointer steal — a `vector`'s move is O(1), an `inplace_vector`'s is O(n).

**Availability today:** C++26. Before that, `boost::container::static_vector` (identical semantics, throws `std::bad_alloc` on overflow) is the drop-in.

---

## 11.7 Small-Vector Optimization

**Small-vector optimization (SVO)**, also called small-buffer optimization (SBO), stores up to `N` elements inline in the container object and falls back to a heap allocation beyond that. It is the same idea as small-string optimization (Ch. 13) generalized to arbitrary `T`, and it is *not* in the standard library for vectors — `llvm::SmallVector<T,N>`, `folly::small_vector`, `absl::InlinedVector<T,N>`, `boost::container::small_vector`, and EASTL's `fixed_vector` are the implementations.

### Layout

```
small_vector<T, N>:
    union {
        T inline_storage[N];
        struct { T* heap; size_t capacity; };
    };
    size_t size;                 // plus a flag/encoding for which arm is active
```

Implementations encode the "is inline" flag cleverly — `llvm::SmallVector` compares `data()` against the address of the inline buffer (`isSmall()` is `BeginX == getFirstEl()`), costing no extra byte; `folly::small_vector` can steal a high bit of the size field.

### The trade-off

| | Win | Cost |
|---|---|---|
| No allocation for ≤ N elements | Removes a `malloc`/`free` pair (~50–100 ns each, plus lock contention) and a cache miss | |
| Elements co-located with the container | 1 fewer indirection; usually the same cache line | |
| | | `sizeof` grows by `N*sizeof(T)` — bad in a container-of-containers, bad on the stack |
| | | Every access needs the small/large discrimination (usually free after inlining, since `data()` returns the right pointer either way) |
| | | **Move is O(n) when small** — you must move elements individually, not steal a pointer. `std::swap` on two small vectors is O(N). |
| | | The type is **not trivially relocatable** in general (Ch. 3 §3.5) — a small-mode buffer has interior pointers in some designs, breaking `memcpy`-based reallocation of a `vector<small_vector<...>>` |

That last point is the sharp one: `llvm::SmallVector` deliberately avoids self-pointers so it *is* relocatable, and `folly` tags its types with `IsRelocatable`. A naive SVO that stores `T* data_ = inline_buf_` is self-referential and cannot be `memcpy`'d — the classic SVO implementation bug.

### Choosing N

`N` should be chosen so the common case fits and `sizeof` stays reasonable — typically so the whole object is one or two cache lines. LLVM's convention is `SmallVector<T, 0>` when the size is unknown (giving a plain vector with LLVM's API) and small powers of two otherwise. Measure the size distribution; an SVO sized for the p99 wastes memory on every instance, and one sized below the median gives you the allocation you were trying to avoid plus the inline bloat.

### Where it pays in trading systems

- Per-order fill lists, per-message field lists, per-symbol subscriber lists — collections that are almost always 0–4 elements.
- Anything constructed and destroyed inside the hot path, where the allocation is the entire cost.
- Note the alternative: if the maximum is *bounded*, `inplace_vector` (§11.6) is strictly better — no branch, no heap path, trivially copyable. SVO is for "usually small, occasionally unbounded."

**`std::function`'s SBO** (Ch. 18) is the same idea for callables, with the same trap: exceeding the inline buffer silently allocates, and the buffer size is implementation-defined (libstdc++ 16 bytes, libc++ 24, MSVC 64), so a lambda capturing three pointers allocates on GCC and does not on MSVC.

---

## 11.8 Container Iterator Invalidation

An iterator (or pointer, or reference) is **invalidated** when the operation may have moved or destroyed the element it designates. Using an invalidated iterator is UB — commonly a use-after-free, and one of the highest-yield interview tables.

### The master table

| Container | Insert / emplace | Erase | Notes |
|---|---|---|---|
| `array` | — | — | Never invalidated |
| `vector` | **All** iterators/pointers/refs if reallocation; otherwise those **at or after** the insertion point | Those **at or after** the erased element; `end()` always | Reallocation is the killer |
| `deque` | **All iterators**; **references stay valid** if insert at either end. Middle insert invalidates everything. | At an end: only the erased element's iterators/refs. In the middle: **all**. | The reference/iterator asymmetry is the exam question |
| `list` / `forward_list` | **None** | Only the erased element | Total stability |
| `set`/`map`/`multiset`/`multimap` | **None** | Only the erased element | Node-based |
| `unordered_*` | **All iterators if rehash occurs** (i.e. if `size+1 > max_load_factor*bucket_count`); **references/pointers never** | Only the erased element's | See Ch. 12 |
| `string` | Like `vector` | Like `vector` | SSO transition also invalidates |

Two rules compress most of it:
1. **Node-based containers (`list`, `forward_list`, `map`, `set`, `unordered_*`) never invalidate references or pointers to elements that still exist.** The element never moves; only the links change.
2. **Contiguous containers invalidate on reallocation, and from the modification point onward otherwise.**

`end()` is invalidated by essentially every size-changing operation on every container — a `for (it = v.begin(); it != v.end(); ...)` loop that caches `end()` is a classic bug.

### The erase idioms

```cpp
// WRONG — erase invalidates it, then ++it is UB
for (auto it = v.begin(); it != v.end(); ++it) if (pred(*it)) v.erase(it);

// Right: erase returns the next valid iterator
for (auto it = v.begin(); it != v.end(); )
    it = pred(*it) ? v.erase(it) : std::next(it);

// Better for vector/deque/string: erase-remove, O(n) instead of O(n^2)
v.erase(std::remove_if(v.begin(), v.end(), pred), v.end());

// C++20: std::erase / std::erase_if — one call, correct for every container
std::erase_if(v, pred);       // free functions for vector, deque, list, string, map, set, unordered_*
```
`std::erase_if` (C++20) is the modern answer and dispatches to the efficient form per container (`remove_if`+`erase` for sequence containers, node-wise iteration for associative ones). It returns the number erased.

Note that **`remove_if` does not erase** — it partitions and returns the new logical end, leaving the tail in a moved-from state (Ch. 10 §10.2). Calling `remove_if` without `erase` is the second-most-common container bug.

For **node-based containers**, the pre-C++11 idiom `m.erase(it++)` is correct (post-increment yields the old value, which is then erased). Since C++11, `it = m.erase(it)` works because the associative `erase` returns an iterator.

### Reference-stability requirements as a design driver

If the design says "another thread/component holds a pointer to this element," you have eliminated `vector` and `deque`-middle-insert from consideration. The options are:
- Node-based container (accept the allocation and pointer chasing).
- **Stable indices into a preallocated slab**: an index is not invalidated by anything, is 4 bytes instead of 8, is trivially serializable and shareable across processes (Ch. 3 §3.12), and can carry a generation counter to detect stale handles. This is the standard low-latency answer and is what an "indexed free list" (Ch. 21) provides.
- `std::deque` when only end-insertion happens (references survive).
- `inplace_vector`/`array` with a fixed slot layout.

**Interview framing:** *"You have a `vector` of orders and other components hold pointers to them. What goes wrong and what do you do?"* — the first `push_back` past capacity dangles every pointer; the answer is generational indices into a preallocated pool, not `deque` and not `list`.

### Special cases worth knowing

- **`reserve` invalidates everything if it reallocates**, even though it changes no element.
- **`shrink_to_fit` invalidates everything** if honored.
- **`std::vector::swap` swaps the buffers**, so iterators remain valid but now refer *into the other container*. Same for `list::splice`: spliced iterators remain valid and now belong to the destination list — a unique guarantee.
- **`resize` down** invalidates iterators to removed elements only; `resize` up may reallocate and invalidate all.
- **Sanitizers catch this**: AddressSanitizer with `-D_GLIBCXX_SANITIZE_VECTOR` / libc++'s `_LIBCPP_HARDENING_MODE_DEBUG` or `ASAN_OPTIONS=detect_container_overflow=1` detect use of invalidated vector iterators via container annotations. `-D_GLIBCXX_DEBUG` gives full checked iterators at a large runtime cost — a debug-build-only tool (Ch. 44).

---

## Key Interview Questions

1. **What is `std::array`'s representation, and why does it matter?** — An aggregate holding a raw `T[N]` and nothing else, so it is standard-layout and trivially copyable when `T` is, with zero indirection to the elements.
2. **`std::array<int,3> a;` vs `a{};`?** — Default-init leaves elements indeterminate; value-init zeroes them.
3. **What are the three data members of `std::vector`, and what is `sizeof`?** — `begin_`, `end_`, `cap_` pointers; 24 bytes on x86-64. The elements are a separate allocation, so `v[i]` is two dependent loads.
4. **Why is `vector<bool>` a mistake?** — It is a bit-packed specialization whose `operator[]` returns a proxy; no `data()`, no `bool*`, and it silently breaks generic code.
5. **Why do implementations disagree between growth factors 2 and 1.5?** — Factor 2 does fewer total moves (2n vs 3n); factor < φ lets a coalescing allocator reuse the sum of previously freed blocks for the next request. Neither is standardized.
6. **What does `clear()` do to capacity?** — Nothing. Use `vector<T>{}.swap(v)` or move-assign an empty vector to release memory; `shrink_to_fit` is non-binding.
7. **Why is `reserve` inside a push loop pathological?** — It grows to exactly `n`, defeating geometric growth and making the loop O(n²) allocations.
8. **What is `deque`'s structure and its unique guarantee?** — A map of pointers to fixed-size chunks; insertion at either end invalidates iterators but **not references or pointers** to existing elements.
9. **Why does `std::stack` default to `deque`?** — No reallocation spike and no element moves on growth; but `stack<T, vector<T>>` is usually faster in practice.
10. **Why is `std::list` almost always slower than `std::vector` even for middle insertion?** — One allocation and 16–24 bytes overhead per node, plus traversal by dependent loads that defeat prefetching and memory-level parallelism; a `memmove` of n elements runs at GB/s.
11. **When is a linked list genuinely correct?** — When you already hold the iterator and need O(1) splice with reference stability (LRU cache), or when it is *intrusive* so there is no per-node allocation and no extra indirection.
12. **What does `forward_list` give up and why?** — `size()`, `back()`, `push_back`, and all non-`_after` mutators, because a singly-linked node cannot reach its predecessor; in exchange, 8 bytes per node and `sizeof(container) == 8`.
13. **What is `std::inplace_vector` and what problem does it solve?** — C++26 fixed-capacity, inline-storage vector: dynamic size, zero allocation, zero indirection, trivially copyable when `T` is, with `try_push_back`/`unchecked_push_back` for hot paths.
14. **Small-vector optimization: what does it cost?** — `sizeof` grows by the inline capacity, moves become O(n) instead of pointer steals, and a naive implementation that stores a pointer to its own buffer is not trivially relocatable.
15. **Which containers never invalidate references to surviving elements?** — All node-based ones: `list`, `forward_list`, `map`/`set` family, and `unordered_*` (whose *iterators* are invalidated by rehash but whose references are not).
16. **What exactly does `vector::insert` invalidate?** — Everything if it reallocates; otherwise iterators/references at and after the insertion point, plus `end()` always.
17. **Why is `remove_if` without `erase` a bug?** — It only partitions and returns a new logical end; the container's size is unchanged and the tail holds moved-from elements. Use `std::erase_if` (C++20).
18. **Other components hold pointers into your `vector` of orders. What do you use instead?** — Generational indices into a preallocated slab; indices are 4 bytes, never invalidated, and shareable across processes.

---

## Common Traps

- **`std::array<T,N> a;` at block scope** — elements are indeterminate for trivial `T`.
- **Passing `std::array` by value** — copies all N elements; take `const&` or `std::span`.
- **A large `std::array` as a local** — stack overflow past the guard page.
- **Caching `v.data()` or `&v[0]` across a `push_back`** — dangles on reallocation.
- **Caching `v.end()` in a loop that modifies `v`.**
- **`v.reserve(n); v[0] = x;`** — reserve creates no elements; that is UB.
- **`reserve` inside the insertion loop** — quadratic.
- **Expecting `clear()` or `pop_back()` to free memory** — capacity is retained.
- **Expecting `shrink_to_fit` to do anything** — non-binding, and it reallocates and invalidates when honored.
- **`vector<bool>` in generic code** — proxy references, no `data()`, `auto x = v[0]` gives a proxy, not a `bool`.
- **`emplace_back(new T)` into a `vector<unique_ptr<T>>`** — direct-init allows the explicit ctor; leaks if the vector's growth throws.
- **A non-`noexcept` move constructor on the element type** — vector growth copies everything (Ch. 10 §10.3).
- **Assuming `deque` references are invalidated by `push_back`** — they are not; the *iterators* are.
- **Using MSVC's `std::deque` for large elements** — a 16-byte block size means roughly one allocation per element.
- **`std::list` for anything performance-sensitive** — use an intrusive list plus a pool.
- **`forward_list::insert` (doesn't exist) instead of `insert_after`.**
- **`v.erase(it); ++it;`** — use `it = v.erase(it)`.
- **`std::remove_if` without the follow-up `erase`.**
- **Iterating an `unordered_map` while inserting** — a rehash invalidates all iterators.
- **A small-vector implementation that stores `data_ = inline_buffer_`** — self-referential, not relocatable, breaks `memcpy`-based container growth.
- **Sizing an SVO/SBO buffer by guess** — measure the distribution; oversizing bloats every instance, undersizing gives you the allocation anyway.

---

## Compact Recall Summary

**`array`.** An aggregate over `T[N]`; standard-layout and trivially copyable when `T` is, zero indirection, `constexpr`-friendly, no decay, comparison operators, tuple protocol, `array<T,0>` valid. Default-init leaves trivial elements indeterminate. CTAD and `std::to_array` (C++20) for construction. Large ones on the stack are a hazard; pass as `span`.

**`vector`.** Three pointers, 24 bytes, contiguous, `data()` guaranteed, elements one indirection away. Amortized O(1) `push_back`, O(n−i) insert/erase in the middle, unchecked `[]`, throwing `at()`. `vector<bool>` is a bit-packed non-container. `emplace_back` is direct-init (allows explicit ctors) and returns `T&`.

**Growth.** Geometric, factor 2 (libstdc++, libc++) or 1.5 (MSVC, folly). Factor 2 minimizes moves; factor < φ enables allocator block reuse. `reserve` once, never in the loop; `reserve` creates no elements; `clear`/`pop_back` retain capacity; `shrink_to_fit` is non-binding; peak RSS during growth is 2–3× the final size. C++23 `append_range`/`ranges::to` size the allocation up front.

**`deque`.** Map of pointers to chunks (libstdc++ 512 B, libc++ 4 KB, MSVC 16 B). O(1) at both ends, O(1) indexed access via two indirections plus div/mod, fat 4-pointer iterators, no contiguity. **End insertion invalidates iterators but not references** — its defining property. No reallocation spike; default for `stack`/`queue`. Rarely right on a hot path; use a ring buffer.

**`list`/`forward_list`.** Total reference/iterator stability, O(1) `splice`, member `sort`/`merge`/`unique` because the free algorithms need random access. One allocation and 8–16 bytes of links per node; traversal is a chain of dependent loads with zero prefetchability. Legitimate uses: LRU with an accompanying hash map, and — for real low-latency work — intrusive lists with pool-allocated objects, never `std::list`.

**Fixed-capacity.** `std::inplace_vector<T,N>` (C++26, ex-`boost::static_vector`): inline storage, no allocator, no allocation, zero indirection, conditionally trivially copyable, `push_back`/`try_push_back`/`unchecked_push_back`. Move is O(n). Embeddable in messages and queue slots.

**SVO.** Inline buffer for ≤ N elements, heap beyond: `llvm::SmallVector`, `folly::small_vector`, `absl::InlinedVector`, `boost::small_vector`. Removes the allocation and an indirection at the cost of `sizeof`, O(n) moves, and — if implemented with a self-pointer — trivial relocatability. Size N to the observed distribution. Same idea and same silent-allocation trap as `std::function`'s SBO.

**Invalidation.** Node-based containers never invalidate references to surviving elements; contiguous ones invalidate on reallocation and from the modification point onward. `deque` end-insert: iterators yes, references no. `unordered_*` rehash: iterators yes, references no. `end()` is invalidated by nearly everything. Use `it = c.erase(it)` or `std::erase_if` (C++20); `remove_if` alone erases nothing. When external code holds handles into a sequence, use generational indices into a preallocated slab rather than pointers.
