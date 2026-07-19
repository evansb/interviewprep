# Chapter 13 — Strings and Non-Owning Views

*Interview-focused revision notes. The theme: the standard library's answer to "who owns these bytes, and how many indirections stand between you and them" — `string` owns and may allocate, the view types own nothing and cost nothing, and every bug in this chapter is a lifetime bug or an allocation you didn't intend.*

---

## 13.1 `std::string`

`std::string` is `std::basic_string<char, std::char_traits<char>, std::allocator<char>>`: a contiguous, null-terminated, dynamically-sized sequence of `char` with an amortized-O(1) `push_back`. It is a container in the formal sense (Ch. 11) but with three properties no other container has: guaranteed null termination, a traits class controlling comparison, and a mandated small-buffer optimization in every real implementation (§13.2).

**Guarantees worth stating precisely:**

- **Contiguity** — `&s[0]` through `&s[size()]` is a valid range; this has been guaranteed since C++11 (C++03 left it open, and pre-C++11 libstdc++ used copy-on-write, which is why the GCC 5 ABI break happened).
- **Null termination** — `s[s.size()]` is a valid read yielding `'\0'`, since C++11. `data()` and `c_str()` are the same pointer and both are non-const since C++17.
- **`size()` excludes the terminator.** `capacity()` also excludes it; the implementation allocates `capacity()+1`.
- **Comparison goes through `char_traits::compare`**, which is `memcmp` for `char`. This means comparison is *unsigned* byte comparison regardless of whether `char` is signed on your platform (Ch. 2 §2.9) — a genuine portability subtlety.

### Cost model

| Operation | Cost |
|---|---|
| Construction from a string literal ≤ SSO capacity | Zero allocations, one inline copy |
| Construction from a longer literal | One allocation + `memcpy` |
| `operator+` chain (`a + b + c`) | One allocation per `+` in the naive case; libstdc++/libc++ do *not* fuse these |
| `append` / `push_back` past capacity | Geometric growth (×2 libstdc++, ×2 libc++), realloc + copy |
| `substr` | **Always allocates** (returns a new `string`) — the single most common accidental allocation on a parse path |
| `operator==` | `size` compare then `memcmp`; the length check makes unequal-length compares free |
| `find` | Naive O(n·m) in libstdc++ for the general case; no Boyer-Moore unless you use `std::search` with `boyer_moore_searcher` (C++17) |

`reserve()` is the standard preemption. Note **C++20 made `reserve(n)` with `n < capacity()` a no-op** — it no longer shrinks; use `shrink_to_fit()` (non-binding) if you need that.

### Low-latency angle

The hot-path rule is: **a `std::string` on a critical path is a bug unless you can prove it stays in the SSO buffer**. A market-data parser that builds symbol strings allocates once per message, and the allocator is a shared, lock-taking, cache-cold structure (Ch. 7). The standard alternatives, in order of preference:

1. `std::string_view` over the receive buffer (§13.3) — zero copy, zero allocation.
2. A fixed-capacity char array plus a length, or `std::inplace_vector<char, N>` (C++26, Ch. 11).
3. `std::pmr::string` with a monotonic buffer resource (Ch. 8) — keeps the `string` interface but moves the allocation to a bump pointer.

Also note `std::string` is **not trivially copyable** (Ch. 3 §3.5): it has a user-provided copy constructor and destructor, so it is passed by invisible reference at ABI boundaries and cannot be `memcpy`'d in container reallocation. It *is* trivially relocatable in practice (folly and BSL exploit this), which is why `vector<string>` growth is fast in those libraries and a move-loop in the standard ones. C++26 trivial relocatability standardizes the trait, but SSO strings that store a pointer into their own buffer would not qualify — implementations deliberately avoid that layout so relocatability holds.

`std::string`'s comparison operators became `<=>`-based in C++20 (Ch. 19), and heterogeneous comparison against `string_view` is free because `string_view` has an implicit converting constructor from `string`.

---

## 13.2 Small-String Optimization

**SSO** stores short strings inline in the `string` object itself, avoiding any allocation. It is not mandated by the standard — the standard only forbids allocation on default construction — but every mainstream implementation does it, and the *capacity* differs, which matters when you're counting cache lines.

| Implementation | `sizeof(std::string)` | Inline capacity (chars, excl. NUL) |
|---|---|---|
| libstdc++ (GCC) | 32 | 15 |
| libc++ (Clang) | 24 | 22 |
| MSVC | 32 | 15 |

### The two layout strategies

**libstdc++** uses a straightforward layout: pointer, size, then a union of a 16-byte inline buffer and a capacity field. The pointer *always* points at the data — inline or heap — so `data()` is a single load with no branch. Cost: 32 bytes, and the pointer is redundant when short.

```
libstdc++:  [ char* ptr (8) ][ size_t size (8) ][ union { char buf[16]; size_t cap; } ]
            ptr points to buf when short, to heap when long.  sizeof == 32
```

**libc++** packs harder. It uses the **low bit of the first byte** (little-endian) as the long/short flag and overlays a 23-byte inline buffer on the {pointer, size, capacity} triple:

```
libc++ short: [ size<<1 (1 byte, LSB=0) ][ char buf[23] ]                sizeof == 24
libc++ long:  [ cap<<1 | 1 (8) ][ size_t size (8) ][ char* ptr (8) ]     sizeof == 24
```

Consequence: libc++ gets 22 inline chars in 24 bytes — nearly every symbol, ticker, order ID, and short key fits — but `data()` requires a **branch (or a `cmov`) on the flag bit** on every call. libstdc++ trades 8 bytes for a branchless `data()`. Neither is universally better; the libc++ layout wins when strings are short and numerous (better cache density, `vector<string>` holds 33% more per line), the libstdc++ layout wins on pointer-chasing-heavy code.

### Consequences you should be able to state

- **A moved-from short string still copies its buffer.** Move construction of an SSO string is not free — it's a `memcpy` of the inline buffer plus zeroing the source. There is no "steal the pointer" fast path when short. This is why `std::move` on a short string saves nothing.
- **SSO makes `std::string` non-trivially-relocatable in the naive analysis** — but as noted, implementations keep the inline buffer self-contained (no self-pointer in libc++'s short form; libstdc++'s pointer *is* a self-pointer, which is why libstdc++ strings are **not** trivially relocatable by memcpy and folly special-cases them).
- **`sizeof(std::string)` is ABI.** Mixing libstdc++ and libc++ objects, or GCC's pre-5 and post-5 ABIs (`_GLIBCXX_USE_CXX11_ABI`), is a link-time or, worse, silent-corruption hazard (Ch. 1 §1.10).
- **Benchmarks lie about strings** if your test data is all under the SSO threshold. A parser benchmarked with 8-char symbols and deployed on 30-char ISINs falls off a cliff.

The interview question is usually "why is `sizeof(std::string)` 32?" and the strong answer names the layout, the capacity, the branch trade-off, and the fact that it differs across implementations.

---

## 13.3 `std::string_view`

`std::string_view` (C++17) is `{const char* data; size_t size;}` — 16 bytes, trivially copyable, no null-termination guarantee, no ownership. It exists to kill the two classic wastes: `substr` allocations and the `const char*` / `const std::string&` overload explosion.

```cpp
void parse(std::string_view s);      // accepts string, const char*, char array, another view
parse("literal");                     // no allocation, no strlen at runtime (size from the array)
parse(some_string);                   // implicit, free
parse(buffer.substr(4, 8));           // ALLOCATES — use buffer_view.substr(4,8) instead
```

`string_view::substr` returns a `string_view` and is O(1) pointer arithmetic. `remove_prefix`/`remove_suffix` mutate the view in place, which makes tokenizing a message header essentially free.

### The null-termination trap

**A `string_view` is not null-terminated.** Passing `sv.data()` to any C API (`open`, `strtod`, `printf("%s")`, `atoi`) reads past the end. There is no `c_str()`, deliberately. The workarounds are: copy into a stack buffer, use a length-taking C API (`strtod` has none; `std::from_chars` does — §13.6), or keep a `const char*` when you know termination holds.

### The lifetime trap

`string_view` is a **borrow**, and C++ has no borrow checker. The canonical failures:

```cpp
std::string_view bad() { return std::string("temp"); }        // dangling on return
std::string_view v = s + "x";                                  // dangles at end of statement
std::map<std::string_view, int> m;  m[compute_key()] = 1;      // key dangles

// Subtle: a string_view member outliving its source
struct Row { std::string_view name; };   // fine ONLY if the backing buffer outlives every Row
```

Lifetime extension does **not** apply: binding a temporary to a `string_view` extends nothing, because the view is not a reference to the temporary (Ch. 5). `-Wdangling-gsl` (Clang) and `-Wdangling` (GCC 13+) catch the easy cases; ASan catches the rest at runtime. C++26's lifetime-safety annotations and P2748 (`[[lifetimebound]]`, already available as a Clang attribute) are the direction of travel.

**Rule of thumb:** `string_view` is a *parameter* type and a *local* type. Storing one in a long-lived structure requires you to name and document the owner.

### Other sharp edges

- **`string_view` has no `operator+`.** Concatenation requires materializing a `string`.
- **Comparison is by content**, via `char_traits::compare`, so it interoperates with `string` correctly. But `sv == "abc"` compares content while `sv.data() == "abc"` compares pointers.
- **Hashing:** `std::hash<string_view>` and `std::hash<string>` are *required* to produce the same value for the same characters, which is what makes heterogeneous lookup in `unordered_map` (Ch. 12) correct.
- **Heterogeneous lookup** requires opting in: `std::map<std::string, V, std::less<>>` (C++14) or `std::unordered_map<std::string, V, StringHash, std::equal_to<>>` (C++20). Without it, `m.find(sv)` constructs a temporary `std::string` — an allocation on your lookup path, and one of the highest-yield fixes in real codebases.
- `std::string_view` from a `nullptr` `const char*` is UB; the `(nullptr)` constructor was explicitly deleted in C++23.

---

## 13.4 `std::span`

`std::span<T, Extent>` (C++20) generalizes `string_view` to any contiguous range of any element type, and adds **mutability**: `span<T>` grants write access, `span<const T>` does not. It is the correct parameter type for "a contiguous block of N `T`s I do not own."

```cpp
void process(std::span<const Order> orders);   // takes vector, array, C array, inplace_vector...
void fill(std::span<std::byte> buf);           // mutable view
```

**Static vs dynamic extent** is the design point:

| | `std::span<T>` (dynamic) | `std::span<T, N>` (static) |
|---|---|---|
| `sizeof` | 16 (pointer + size) | 8 (pointer only) |
| Size known | Runtime | Compile time |
| Loop bounds | Runtime trip count | Constant — enables full unrolling and vectorization without a remainder loop |
| Conversion | From static → dynamic implicit | Dynamic → static requires explicit `span<T,N>(p, N)` or C++26 `.to_static()` |

Static extent is the low-latency variant: a fixed-size message body becomes `span<const std::byte, 48>`, and the compiler sees a constant trip count. This is a genuine codegen difference, not a stylistic one.

### Mechanics and traps

- **`span` does not propagate const.** `const std::span<T>` still lets you write through it — const applies to the span's own pointer and size, not the elements. You want `std::span<const T>`. This is the single most misunderstood thing about `span`, and it mirrors the same behavior in raw pointers.
- **No bounds checking by default.** `operator[]` out of range is UB. There is no `at()` (C++26 adds `at()`). libstdc++ and libc++ have hardening modes (`_GLIBCXX_ASSERTIONS`, `_LIBCPP_HARDENING_MODE`) that check it; enable them in test builds.
- **`subspan`, `first<N>`, `last<N>`** are free; the templated forms preserve static extent.
- **Same dangling hazards as `string_view`**, plus iterator-invalidation hazards: a `span` over a `vector` is invalidated by any reallocation (Ch. 11 §11.8), silently.
- **`as_bytes` / `as_writable_bytes`** convert a `span<T>` to `span<const std::byte>` / `span<std::byte>` — the standard, aliasing-legal way to get at an object's bytes for serialization (Ch. 3 §3.8).
- **C++26 adds `std::span` over `std::initializer_list`** and fixes several CTAD gaps; C++23 already added the `ranges::to`-friendly constructors and made `span` constructible from any `contiguous_range` with matching element type.

`span` is passed in **two registers** under the SysV ABI (it's trivially copyable and 16 bytes), so it is strictly cheaper than `const std::vector<T>&` — which passes one register but then requires a load to reach the data pointer, and constrains the caller to actually own a `vector`.

---

## 13.5 `std::mdspan`

`std::mdspan<T, Extents, LayoutPolicy, AccessorPolicy>` (C++23) is a **multidimensional** non-owning view: a pointer plus a compile-time/runtime mix of extents, plus a policy describing how index tuples map to offsets. It is the standard's answer to "I have a flat buffer and I want to index it as a matrix without writing the arithmetic."

```cpp
double buf[12];
std::mdspan m{buf, 3, 4};              // 3×4, dynamic extents, layout_right
m[1, 2] = 3.0;                          // C++23 multidimensional subscript
static_assert(m.rank() == 2);

using Ext = std::extents<size_t, 3, std::dynamic_extent>;   // mixed static/dynamic
std::mdspan<double, Ext> fixed_rows{buf, 4};
```

### The four template parameters

- **`Extents`** — `std::extents<IndexType, E...>`, where each `E` is a constant or `std::dynamic_extent`. Static extents cost zero storage and turn index arithmetic into constant-folded shifts; dynamic ones are stored. `dextents<size_t, 2>` is the all-dynamic shorthand.
- **`LayoutPolicy`** — the index mapping.
  - `layout_right` (default): row-major, last index varies fastest — C convention.
  - `layout_left`: column-major, first index fastest — Fortran/BLAS/LAPACK convention.
  - `layout_stride`: arbitrary per-dimension strides, which is how you express a **submatrix, a transposed view, or a slice** without copying.
  - Custom layouts are allowed — tiled/blocked layouts for cache locality (Ch. 42) are the motivating example.
- **`AccessorPolicy`** — how an offset becomes a reference. `default_accessor` does `p[i]`. Custom accessors implement non-temporal loads, `assume_aligned` (Ch. 3 §3.10), atomic access, or checked access.

`std::submdspan` (C++26; shipped alongside in most implementations) slices: `submdspan(m, std::full_extent, 2)` extracts a column as a strided 1-D `mdspan`.

### Why it matters and when it doesn't

The whole type is a compile-time computation: for static extents with `layout_right`, `m[i,j]` compiles to exactly `p[i*4+j]` with the 4 constant-folded — **identical codegen to hand-written arithmetic**, but with the dimensions checked and documented. `sizeof(mdspan)` is just the pointer plus the dynamic extents (an all-static `mdspan` is pointer-sized).

Where it goes wrong: **`layout_right` vs `layout_left` chosen wrongly is a cache-locality disaster**, not a correctness bug. Iterating the fast axis in the outer loop turns unit-stride streaming (prefetcher-friendly, one cache line per 8 doubles) into a stride-N walk (one line per element, TLB pressure, prefetcher defeated) — an easy 10× on large matrices. This is the same lesson as loop interchange in Ch. 42, and it is the reason `mdspan` makes the layout an explicit type parameter rather than a convention.

Also note `mdspan` has **no bounds checking** by default and, like `span`, does not propagate const. Its multidimensional `operator[](i, j)` requires C++23; before that, implementations exposed `operator()`. The reference implementation (Kokkos `mdspan`) is available as a C++17 backport, which is how most production code uses it today.

---

## 13.6 Character Conversion with `from_chars` and `to_chars`

`<charconv>` (C++17) provides the only conversion functions in the standard library that are **locale-independent, non-allocating, non-throwing, and take a length rather than a null terminator**. For a parser on a hot path this is the entire point.

```cpp
#include <charconv>

int64_t price;
auto [ptr, ec] = std::from_chars(begin, end, price);       // integer
if (ec == std::errc{}) { /* ptr points past the last consumed char */ }
else if (ec == std::errc::invalid_argument) { /* no digits at begin */ }
else if (ec == std::errc::result_out_of_range) { /* overflow; price UNMODIFIED */ }

char buf[32];
auto [out, ec2] = std::to_chars(buf, buf + sizeof buf, 3.14159, std::chars_format::fixed, 4);
// ec2 == std::errc::value_too_large if the buffer is too small; nothing written
```

### Comparison with the alternatives

| Facility | Allocates | Locale-aware | Throws | Length-taking | Round-trip exact |
|---|---|---|---|---|---|
| `std::from_chars` | No | **No** | No | **Yes** | **Yes** |
| `std::to_chars` | No | **No** | No | Yes (out range) | **Yes** (shortest round-trip) |
| `std::stoi` / `stod` | Yes (takes `string`) | Yes (`stod`) | **Yes** | No | No |
| `strtol` / `strtod` | No | **Yes** (`LC_NUMERIC`) | No | **No** (needs NUL) | No |
| `std::stringstream` | Yes | Yes | Configurable | No | No |
| `std::format` / `to_string` | Yes | `format` is locale-free by default | Yes | — | Yes (`format` uses `to_chars`) |

**Locale-independence is the headline.** `strtod("3.14")` returns 3.0 under `LC_NUMERIC=de_DE` because the decimal separator is a comma — a real production incident class, and it means `atof`/`strtod`/`iostream` are unsafe for parsing protocol data unless you pin the locale. `from_chars` has no locale, ever. It also accepts no leading whitespace and no `+` sign for integers (deliberately minimal), so `from_chars(" 42")` fails where `strtol` succeeds.

### Performance

`to_chars` for floating point implements the **shortest round-trip** representation (Ryū / Grisu-derived; Steele & White's guarantee: the shortest decimal that parses back to the identical `double`). It is 5–20× faster than `snprintf("%g")` and, unlike `%.17g`, produces `0.1` rather than `0.10000000000000001`. `from_chars` for `double` is typically an Eisel–Lemire fast path, several times faster than `strtod`.

**Availability caveat that gets asked:** floating-point `from_chars`/`to_chars` landed late — GCC 11 and MSVC 19.24 have full support; **libc++ only completed float support in LLVM 20**, so portable code from that era used `fast_float` or Abseil. Integer support has been universal since C++17.

### Low-latency usage pattern

```cpp
// Fixed-point price parse from a wire buffer, no allocation, no locale, no NUL:
std::string_view field = msg.substr(off, len);
int64_t mantissa{};
auto r = std::from_chars(field.data(), field.data() + field.size(), mantissa);
if (r.ec != std::errc{}) return reject();
```

Note this pairs naturally with `string_view` (§13.3): `from_chars` is the C-API-adjacent function that does *not* require null termination, which is precisely why it is the correct partner for views over receive buffers. For fully known field widths, a hand-rolled SIMD or unrolled digit parse still beats `from_chars` (Ch. 42), because `from_chars` must handle arbitrary length — but `from_chars` is the correct default and the correct interview answer.

C++23 adds `std::to_chars` `constexpr`-ness for integers (P2291), so compile-time formatting works; C++26 continues extending `constexpr` coverage to the floating-point paths.

---

## Key Interview Questions

1. **Why is `sizeof(std::string)` 32 on libstdc++ but 24 on libc++?** — Different SSO layouts: libstdc++ keeps an always-valid data pointer (branchless `data()`, 15 inline chars); libc++ overlays the buffer on the pointer/size/capacity triple with a flag bit (22 inline chars, branch on `data()`).
2. **Does moving a `std::string` allocate or copy?** — Long strings steal the pointer; **short (SSO) strings copy the inline buffer**, so `std::move` on a short string saves nothing.
3. **Why does `s.substr(0, 4)` allocate but `sv.substr(0, 4)` not?** — `string::substr` returns a new `string`; `string_view::substr` is pointer arithmetic on a borrowed range.
4. **Is `std::string_view::data()` null-terminated?** — No. Passing it to a C API is a read past the end; there is deliberately no `c_str()`.
5. **Why does `map<string,V>::find(string_view)` allocate, and how do you fix it?** — The key type is `string`, so a temporary is constructed; opt into heterogeneous lookup with `std::less<>` (C++14) or a transparent hash + `equal_to<>` (C++20).
6. **Does `const std::span<T>` prevent writing through it?** — No. Const applies to the span's pointer/size; you need `std::span<const T>`.
7. **Static vs dynamic extent on `span` — what changes?** — Static extent is pointer-sized and gives a compile-time trip count (full unroll, no remainder loop); dynamic carries a runtime size.
8. **Why is `span<const T>` a better parameter than `const vector<T>&`?** — It accepts arrays, `array`, `inplace_vector`, subranges; it's trivially copyable and passed in two registers; and it doesn't force the caller to own a `vector`.
9. **What does `std::mdspan`'s layout policy control, and why does it matter for performance?** — The index-to-offset mapping (`layout_right` row-major, `layout_left` column-major, `layout_stride` for slices). Choosing the wrong one turns unit-stride streaming into strided access, defeating the prefetcher.
10. **What is `submdspan` for?** — Zero-copy slicing/transposition, producing a `layout_stride` view of the same buffer.
11. **Why is `from_chars` preferred over `strtod` in a parser?** — No locale (so `LC_NUMERIC` can't change the decimal separator), no null terminator required, no allocation, no throw, and it's several times faster.
12. **What does `to_chars` guarantee for `double`?** — The shortest decimal string that round-trips to the identical value, faster than `snprintf`.
13. **How do you report errors from `from_chars` without exceptions?** — `from_chars_result{ptr, ec}`: `invalid_argument` for no parse, `result_out_of_range` for overflow (and the output is left unmodified in both cases).
14. **Is `std::string` trivially copyable? Trivially relocatable?** — Not trivially copyable (user-provided copy/dtor, so it's passed in memory at ABI boundaries). Trivial relocatability depends on the layout: libc++'s short form is self-contained; libstdc++'s always-valid pointer is a self-pointer, which blocks naive `memcpy` relocation.
15. **How do you hash a `string_view` and look up in an `unordered_map<string, V>`?** — `std::hash<string_view>` and `std::hash<string>` are required to agree, so a transparent hasher plus `equal_to<>` gives allocation-free lookup.
16. **What replaces `std::string` on an allocation-free hot path?** — `string_view` over the receive buffer, a fixed-capacity char array / `inplace_vector`, or `pmr::string` over a monotonic resource.
17. **Why can `std::string_view` not be lifetime-extended?** — Lifetime extension applies to references and to temporaries bound directly; a view is an independent object holding a pointer, so the temporary dies at the end of the full expression.

---

## Common Traps

- **Returning a `string_view` to a local or temporary `string`** — dangles immediately; `-Wdangling-gsl` catches only the obvious forms.
- **`std::string_view sv = a + b;`** — the concatenated temporary dies at the semicolon.
- **Passing `sv.data()` to a C API** — no null terminator, reads past the end.
- **`string::substr` in a parse loop** — an allocation per token; use `string_view::substr`.
- **Non-transparent heterogeneous lookup** — `m.find(sv)` silently constructing a `std::string`.
- **Assuming `std::move` on a string is free** — SSO strings copy.
- **Benchmarking strings entirely inside the SSO threshold** — hides the allocation cliff.
- **Mixing `_GLIBCXX_USE_CXX11_ABI` values, or libstdc++ and libc++ objects** — `sizeof(std::string)` is ABI; the failure is a link error at best, corruption at worst.
- **`const std::span<T>` believed to be read-only** — it isn't; use `span<const T>`.
- **A `span` outliving a `vector` reallocation** — silent use-after-free with no iterator-invalidation diagnostic.
- **Out-of-range `span`/`mdspan` indexing** — no bounds checks by default; enable `_LIBCPP_HARDENING_MODE` / `_GLIBCXX_ASSERTIONS` in tests.
- **Wrong `mdspan` layout policy for the loop order** — a correctness-silent, order-of-magnitude cache disaster.
- **`strtod`/`atof`/`iostream` for protocol parsing** — locale-dependent decimal separator.
- **Expecting `from_chars` to skip whitespace or accept a leading `+`** — it does neither for integers.
- **Assuming `from_chars` for `double` exists everywhere** — libc++ only completed float support in LLVM 20.
- **Reading `result_out_of_range` output** — the value is left unmodified, not clamped.
- **Assuming `string` comparison uses the platform's `char` signedness** — `char_traits::compare` is `memcmp`, i.e. unsigned.

---

## Compact Recall Summary

**`std::string`.** Contiguous, null-terminated (both guaranteed since C++11), geometric growth, comparison via `char_traits::compare` = `memcmp`. `substr` allocates; `reserve` no longer shrinks (C++20). Not trivially copyable, so it never travels in registers. On a hot path, replace with a view, a fixed buffer, or `pmr::string` over a monotonic resource.

**SSO.** Not mandated, universal in practice. libstdc++: 32 bytes, 15 inline chars, always-valid pointer, branchless `data()`. libc++: 24 bytes, 22 inline chars, flag bit in the first byte, branch on `data()`. Short-string moves are `memcpy`s, not pointer steals. `sizeof(std::string)` is ABI.

**`string_view`.** 16 bytes, trivially copyable, borrows, **not null-terminated**, O(1) `substr`/`remove_prefix`. The right parameter type; the wrong member type unless the owner is named. Hash agrees with `std::hash<string>`, enabling allocation-free heterogeneous lookup once you opt in with `less<>` / transparent hash + `equal_to<>`.

**`span`.** `string_view` generalized, plus mutability. Const does **not** propagate — use `span<const T>`. Static extent is pointer-sized and yields compile-time trip counts; dynamic carries a size. `as_bytes`/`as_writable_bytes` is the aliasing-legal route to an object's bytes. No bounds checks outside hardened modes.

**`mdspan`.** Pointer + `extents` (static extents are free and constant-fold) + layout policy (`layout_right` row-major, `layout_left` column-major, `layout_stride` for slices/transposes) + accessor policy (alignment, non-temporal, atomic). Codegen matches hand-written index arithmetic. `submdspan` slices without copying. The layout choice is a cache-locality decision, not a style one.

**`<charconv>`.** `from_chars`/`to_chars`: locale-free, allocation-free, throw-free, length-taking, and the fastest conversions in the standard library. `to_chars` for floats gives the shortest round-trip form; `from_chars` returns `{ptr, errc}` with `invalid_argument` / `result_out_of_range` and leaves the output untouched on failure. The natural partner for `string_view` over a wire buffer, and the reason `strtod`'s locale dependence never has to reach a parser.
