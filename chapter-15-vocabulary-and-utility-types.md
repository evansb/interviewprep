# Chapter 15 — Vocabulary and Utility Types

*Interview-focused revision notes. The theme: the standard's small composable types — the ones that appear in every interface — each buy a specific abstraction with a specific representational cost, and the interview is about knowing which ones are free, which allocate, and which have a discriminant you're paying for.*

---

## 15.1 Pair and Tuple

`std::pair<T, U>` is a two-member aggregate-like struct with named members `first` and `second`; `std::tuple<Ts...>` generalizes it to N heterogeneous members accessed positionally by `std::get<I>` or (since C++14, when unambiguous) by type with `std::get<T>`.

```cpp
std::pair<int, double> p{1, 2.0};
std::tuple<int, double, std::string> t{1, 2.0, "x"};
auto& d = std::get<1>(t);          // by index
auto& s = std::get<std::string>(t); // by type — ill-formed if the type appears twice
static_assert(std::tuple_size_v<decltype(t)> == 3);
using Second = std::tuple_element_t<1, decltype(t)>;
```

### Layout and cost

`std::tuple` is **not** required to store elements in declaration order, and libstdc++ implements it by **recursive inheritance in reverse**, so `get<0>` lives at the highest address:

```
libstdc++ tuple<A,B,C>:  _Tuple_impl<0,A,B,C> : _Tuple_impl<1,B,C> : _Tuple_impl<2,C>
                          → memory order is roughly C, B, A
MSVC: also reverse.  libc++: uses a flat multiple-inheritance of indexed bases, declaration order.
```

Consequences: **a tuple is not layout-compatible with a struct of the same members** (Ch. 3 §3.11), you cannot `memcpy` a tuple into a wire format, `offsetof` is meaningless, and the padding may differ from the equivalent struct (though empty-base optimization means empty members cost nothing — a tuple of stateless functors is empty). `std::pair` *is* a plain struct in declaration order, but is still not guaranteed standard-layout in general.

A tuple is trivially copyable iff all its elements are, and small tuples of scalars do get passed in registers — but the SysV rules (Ch. 3 §3.5) cap that at 16 bytes for the general case.

### Where tuples are the right tool

- **Multiple return values** — though a named struct is usually better: `auto [ok, value] = f()` from a struct gives you names and documentation for free, and structured bindings (Ch. 19) work on both.
- **Comparison keys** — `std::tie(a.x, a.y) < std::tie(b.x, b.y)` gives lexicographic multi-key ordering with correct strict-weak-ordering semantics (Ch. 14 §14.8). `tuple`'s `operator<=>` (C++20) is lexicographic member-by-member.
- **Template metaprogramming** — a type list with storage.
- **Forwarding argument packs** into deferred calls (`std::apply`, §15.2), which is how `std::thread`, `std::bind`, and coroutine promise machinery store arguments.

### Traps

- **`std::pair`'s constructor is not `explicit` when both types are implicitly convertible** but *is* conditionally explicit otherwise (C++17 P0510-adjacent tidy-up); the conditional-explicit dance is a common source of confusing overload errors.
- **`std::tuple`'s converting constructors are greedy**, and pre-C++17 a `tuple<T>` could hijack copy construction. Fixed by conditional explicitness, but tuple error messages remain notorious.
- **`std::get<T>` is ill-formed with duplicate types**, which makes type-based access fragile under refactoring.
- **`std::make_pair`/`make_tuple` decay their arguments** (array-to-pointer, reference-stripping) and unwrap `reference_wrapper` into a real reference — subtle and deliberate. With CTAD (C++17), `std::pair p{a, b}` is usually preferable, but note **CTAD does not decay `reference_wrapper`**, so the two are not equivalent.
- **`std::tuple` compiles slowly.** Deep recursive instantiation costs real build time (Ch. 17 §17.22); libc++'s flat design is measurably faster to compile than libstdc++'s recursive one.

---

## 15.2 `std::apply` and `std::tie`

`std::apply(f, tuple)` (C++17) invokes `f` with the tuple's elements as separate arguments — the "unpack" operation. Internally it is `std::invoke(f, std::get<Is>(std::forward<Tuple>(t))...)` with `Is` from a `std::index_sequence`, which is *the* canonical pack-expansion idiom (Ch. 17 §17.15).

```cpp
auto t = std::make_tuple(1, 2.5, 'c');
std::apply([](int a, double b, char c){ /* ... */ }, t);

// Generic: call any function with a stored argument pack
template <class F, class... Args>
struct DeferredCall {
    F f; std::tuple<Args...> args;
    decltype(auto) operator()() { return std::apply(f, args); }
};
```

`std::apply` is how `std::thread` and `std::async` (Ch. 20) invoke your callable with the arguments they stored at construction, and how `std::make_from_tuple<T>(t)` (C++17) constructs a `T` from tuple elements — the standard's answer to piecewise construction, and the mechanism behind `std::map::emplace(std::piecewise_construct, ...)`.

`std::tie(a, b, c)` creates a `std::tuple<T&, U&, V&>` — a tuple of **lvalue references**. Two uses:

```cpp
// 1. Unpacking (the pre-C++17 idiom, now superseded by structured bindings)
int id; double px;
std::tie(id, px) = parse();
std::tie(std::ignore, px) = parse();   // std::ignore discards a component

// 2. Lexicographic comparison — still the best pre-C++20 idiom, and fine after
bool operator<(const K& a, const K& b) {
    return std::tie(a.x, a.y, a.z) < std::tie(b.x, b.y, b.z);
}
```

`std::ignore` is an object whose `operator=` does nothing; it exists solely for `tie` and was reused for `[[maybe_unused]]`-style discards.

### `tie` vs structured bindings vs `forward_as_tuple`

| Tool | Produces | Requires pre-declared variables | Can bind to rvalues |
|---|---|---|---|
| `std::tie(a,b)` | `tuple<A&,B&>` | Yes | No (lvalues only) |
| Structured bindings (C++17) | Declares new names | No | Yes |
| `std::forward_as_tuple(a,b)` | `tuple<A&&,B&&>` preserving value category | No | Yes |

**Structured bindings replace `tie` for unpacking** and are strictly better: no pre-declaration, no default-construct-then-assign, and they work on structs and arrays too. `tie` survives for comparison chains and for assigning into *existing* variables (a structured binding always declares new ones).

`std::forward_as_tuple` is the perfect-forwarding variant, used to pass argument packs through layers without copies. **Its result must not outlive the full expression** — it holds references to (possibly temporary) arguments, so storing it dangles. That is the classic `forward_as_tuple` bug.

A performance note: `std::apply`, `tie`, and structured bindings are all pure compile-time constructs. After inlining they generate nothing — no runtime cost whatsoever. The cost is in compile time and diagnostics.

---

## 15.3 `std::optional`

`std::optional<T>` (C++17) is a **discriminated union of `T` and nothing**: aligned storage for a `T` plus a `bool`. It models "a value that may be absent" *without* allocation and without a sentinel.

```cpp
std::optional<Order> find(OrderId id);
if (auto o = find(id)) { use(*o); }          // operator bool + operator*
int q = o.value_or(0);                         // no throw
int r = o->qty;                                // UB if empty — no check
int v = o.value();                             // throws std::bad_optional_access if empty
o.reset(); o = std::nullopt;                   // disengage
o.emplace(args...);                            // construct in place, no move
std::optional<Big> b{std::in_place, a, b, c};  // in-place construction at the call site
```

### Representation and cost

```
sizeof(optional<T>) == sizeof(T) rounded up to alignof(T), plus one bool, rounded to alignof(T)
optional<int>    → 8 bytes   (4 value + 1 bool + 3 padding)
optional<double> → 16 bytes
optional<int*>   → 16 bytes  — the bool cannot be folded into the pointer's invalid values
```

**There is no niche optimization.** Unlike Rust's `Option<&T>`, `std::optional<T*>` is 16 bytes, not 8. This is a legitimate criticism and the reason hot data structures use a sentinel (`price == INT64_MIN`) or a domain-specific optional. C++26's `std::optional<T&>` (P2988) finally adds reference specialization, which *is* pointer-sized — but note it has **rebinding** assignment semantics (assigning rebinds the reference rather than assigning through it), which was the controversy that delayed it for a decade.

`optional` is **trivially copyable iff `T` is** (the implementations specialize on triviality), trivially destructible iff `T` is, and `constexpr`-usable throughout since C++17 (with full `constexpr` for non-trivial `T` arriving with C++20's constexpr-dynamic-allocation rules).

### Monadic operations (C++23)

```cpp
auto result = find(id)
            .and_then([](const Order& o) -> std::optional<Price> { return o.limit; })
            .transform([](Price p) { return p * 100; })
            .or_else([]{ return std::optional<Price>{default_px}; });
```
`and_then` (flatMap), `transform` (map), `or_else` (fallback). These eliminate nested `if (o)` pyramids and compose with `std::expected`'s identically-named members (Ch. 10).

### Design guidance and traps

- **`optional<bool>` is a three-state type** and almost always confusing. So is `optional<optional<T>>`.
- **`operator*` and `operator->` do not check.** Dereferencing a disengaged optional is UB, not an exception. `value()` throws; `value_or` doesn't. People assume `*` checks.
- **`value_or` always evaluates its argument** and always constructs a `T` — expensive if the fallback is costly. C++23's `or_else` is lazy.
- **`optional<T&>` did not exist before C++26.** Use `T*` for "optional reference" in older code; a raw pointer *is* the idiomatic optional reference.
- **Comparison with `nullopt` and with `T` is defined**, so `o == 5` works and a disengaged optional compares less than any value — occasionally surprising in sorts.
- **`optional` is not a replacement for error reporting.** It says "absent", not "why". Use `std::expected<T,E>` (C++23, Ch. 10) when the caller needs a reason.
- On the hot path, `optional<T>` for a large `T` costs a branch on every access plus the storage; for a POD result, returning a struct with an explicit status field often generates better code because the compiler can keep both in registers.

---

## 15.4 `std::variant` and Visitation

`std::variant<Ts...>` (C++17) is a **type-safe tagged union**: storage for the largest alternative plus an index, with lifetime management the raw union (Ch. 5) doesn't give you.

```cpp
std::variant<Add, Cancel, Execute> ev = Cancel{id};
std::size_t i = ev.index();
if (auto* c = std::get_if<Cancel>(&ev)) { ... }     // pointer, no throw
Cancel& c2 = std::get<Cancel>(ev);                   // throws std::bad_variant_access
std::visit([](auto&& e){ handle(e); }, ev);          // exhaustive dispatch

// The overload idiom (C++17 CTAD + inherited operator())
template <class... Fs> struct overloaded : Fs... { using Fs::operator()...; };
template <class... Fs> overloaded(Fs...) -> overloaded<Fs...>;   // unneeded in C++20
std::visit(overloaded{
    [](const Add& a)     { ... },
    [](const Cancel& c)  { ... },
    [](const Execute& x) { ... },
}, ev);
```

### Representation

`sizeof(variant<Ts...>)` ≈ `max(sizeof(Ts)...)` rounded to `max(alignof(Ts)...)`, plus the index (typically `unsigned int`, though implementations shrink it to `unsigned char` when there are few alternatives). No heap allocation, ever — which is the whole point versus a `unique_ptr<Base>` hierarchy.

### The valueless-by-exception state

If an alternative's move/copy constructor throws *during assignment*, the variant can end up holding nothing: `valueless_by_exception() == true`, `index() == variant_npos`, and any `get`/`visit` throws. This exists because the standard refused to require heap fallback or double buffering. Implementations avoid it entirely when all alternatives are nothrow-move-constructible — so **making every alternative `noexcept`-movable eliminates the state**, and every `visit` then skips the valueless check. That check is a real branch in generated code; removing it is a measurable win in dispatch-heavy code.

### `visit` dispatch cost

`std::visit` on a single variant compiles to a **jump table** (an array of function pointers indexed by `index()`), plus the valueless check. That is:

- an indirect call — **not inlinable**, and subject to indirect-branch misprediction (~15–20 cycles when wrong, Ch. 27);
- for N variants visited together, an N-dimensional table of size ∏|Ts|, which explodes in both code size and compile time. Two 5-alternative variants is a 25-entry table; three is 125.

Alternatives when dispatch is hot:
- **`if constexpr` chains on `get_if`** for ≤3–4 alternatives — the compiler emits predictable compare-and-branch and can inline each arm.
- **A hand-rolled tagged union with a `switch`** — the compiler generates a jump table it *can* inline into, unlike `visit`'s function-pointer table. This is the standard low-latency answer, and it is often faster than both `visit` and virtual dispatch.
- **Sorting/batching events by type** so the branch predictor sees runs of the same tag.

### Variant vs the alternatives

| | `variant` | Virtual base + `unique_ptr` | Raw tagged union |
|---|---|---|---|
| Allocation | None | One per object | None |
| Dispatch | Jump table, indirect call, valueless check | vtable indirect call | `switch`, inlinable |
| Adding a type | Edit the variant + every visitor (**compile error** — exhaustiveness) | Add a class, no visitor edits | Edit the enum + every switch |
| Adding an operation | Add a visitor, no type edits | Edit every class | Add a function |
| Cache | Contiguous, sized to the largest | Pointer chase per element | Contiguous |

This is the **expression problem**: `variant` makes adding operations cheap and adding types expensive; inheritance is the reverse. Say that sentence in an interview. For a closed set of message types in a feed handler — which is exactly a closed set — `variant` or a hand-rolled union is right, and the contiguity (no pointer chase, no allocation) is worth more than the dispatch difference.

Other details: `std::monostate` is the empty alternative you add to make a variant default-constructible when the first alternative isn't; `std::holds_alternative<T>` is the type-check; duplicate alternative types make type-based `get`/`holds_alternative` ill-formed; and converting-construction uses overload resolution, which historically did surprising things (`variant<string,bool> v = "x"` selected `bool` before P0608 fixed it in C++17's DR).

---

## 15.5 `std::any`

`std::any` (C++17) holds a value of **any** copy-constructible type, with type recovery via `std::any_cast`. It is type-erasure (Ch. 6) with no interface at all.

```cpp
std::any a = 42;
a = std::string("hello");
int i = std::any_cast<int>(a);            // throws std::bad_any_cast — wrong type now
auto* p = std::any_cast<std::string>(&a); // pointer form, returns nullptr on mismatch
const std::type_info& t = a.type();        // requires RTTI
a.reset(); bool e = a.has_value();
```

### Cost

- **Small-object optimization is permitted but not required**, and its threshold is implementation-defined (libstdc++ and libc++ both inline types up to roughly 16 bytes that are nothrow-move-constructible). Anything larger **allocates**.
- `type()` requires **RTTI**; `-fno-rtti` builds cannot use `std::any` at all. `any_cast` compares `type_info`, which across shared-library boundaries can compare *addresses* of type_info objects and fail if symbols aren't merged (`-fvisibility=default` / `RTLD_GLOBAL`, Ch. 1 §1.12) — a genuinely nasty production failure.
- `any_cast` is a runtime type check plus a possible allocation on copy.

### When to use it (rarely)

`any` is right for genuinely heterogeneous, open-ended storage: plugin registries, property bags, configuration values, message-passing infrastructure that must forward unknown payloads. It is wrong whenever the set of types is closed — that's `variant` — and wrong whenever the operations are known — that's an interface or a concept.

| | `variant<A,B,C>` | `any` |
|---|---|---|
| Type set | Closed, compile-time | Open, runtime |
| Allocation | Never | When above the SOO threshold |
| Retrieval | `visit` (exhaustive, checked at compile time) | `any_cast<T>` (you must guess T) |
| RTTI | Not required | **Required** |
| Exhaustiveness | Compiler-enforced | None |

On a low-latency path, `std::any` is essentially never appropriate: an allocation, an RTTI comparison, and no inlining. It's a configuration-layer tool.

---

## 15.6 `std::bitset`

`std::bitset<N>` is a fixed-size sequence of N bits with a compile-time N, stored as an array of `unsigned long` words: `sizeof(bitset<N>) == ceil(N/64)*8` on LP64 (so `bitset<1>` is 8 bytes, `bitset<65>` is 16).

```cpp
std::bitset<64> b;
b.set(3); b.reset(3); b.flip(); b.test(3);   // test() throws out_of_range; operator[] doesn't
b.count();      // popcount — compiles to POPCNT with -mpopcnt/-march=haswell
b.any(); b.none(); b.all();
b <<= 1; b |= other;                          // whole-word ops
unsigned long v = b.to_ulong();               // throws overflow_error if it doesn't fit
std::string s = b.to_string();                // allocates
```

`operator[]` returns a **proxy reference** (`bitset<N>::reference`) for the mutable case — the same design as `vector<bool>` and the same consequence: `auto x = b[3];` captures a proxy, not a `bool`, and using it after `b` dies is a dangling reference. Write `bool x = b[3];`.

### Choosing among the bit containers

| | `std::bitset<N>` | `std::vector<bool>` | `uint64_t` | `std::array<uint64_t, K>` |
|---|---|---|---|---|
| Size | Compile-time | Runtime | 64 | Compile-time |
| Storage | Inline, no allocation | Heap | Register | Inline |
| Interface | Rich (`count`, `any`, shifts) | Container-ish, proxy refs, **not a real container** | Manual | Manual |
| Bulk ops | Word-at-a-time, often vectorized | Word-at-a-time internally, but API-hostile | — | Whatever you write |
| Hot path | Fine | Avoid | Best | Best for large fixed sets |

`bitset` is a good default for flag sets and fixed-size membership tests: no allocation, dense, and `count()`/`any()` compile to `POPCNT`/`OR`-reduce. Its weaknesses are that N must be a compile-time constant, `to_string`/`operator<<` allocate, and there's no way to iterate set bits efficiently — for that you want the `x & -x` / `countr_zero` loop (§15.7) over raw words.

`std::vector<bool>` remains the standard's acknowledged design mistake: it is a bit-packed specialization that isn't a container (no `data()`, proxy references, `&v[0]` doesn't give you a `bool*`), breaking generic code. Use `std::vector<char>`, `std::vector<uint8_t>`, or `bitset` instead. C++26 discussions around deprecating it continue; the ship has not sailed.

---

## 15.7 Standard Bit-Manipulation Utilities

`<bit>` (C++20) standardized what everyone was doing with compiler intrinsics, with correct edge-case semantics and `constexpr` evaluation.

```cpp
#include <bit>
std::bit_cast<uint32_t>(3.14f);       // Ch. 3 §3.8 — the legal type pun
std::has_single_bit(x);                // is a power of two
std::bit_ceil(x); std::bit_floor(x);   // round to power of two (bit_ceil UB if result overflows)
std::bit_width(x);                     // 1 + floor(log2(x)); 0 for x==0
std::rotl(x, n); std::rotr(x, n);      // real rotates — n may be negative or > width
std::countl_zero(x); std::countl_one(x);
std::countr_zero(x); std::countr_one(x);
std::popcount(x);
std::endian::native;                   // Ch. 3 §3.9
```

All take **unsigned integer types only** (`unsigned char` through `unsigned long long` and extended types) — passing a signed value is ill-formed, deliberately, because shifts and counts on signed types are where UB lives.

| Function | Instruction (x86-64) | Note |
|---|---|---|
| `popcount` | `POPCNT` | Requires SSE4.2 (`-mpopcnt`); otherwise a ~12-op SWAR fallback |
| `countr_zero` | `TZCNT` / `BSF` | `BSF` is **undefined for 0**; `TZCNT` returns the width. `std::countr_zero(0)` is defined as the width. |
| `countl_zero` | `LZCNT` / `BSR` | Same 0-handling story; BMI1 for `LZCNT` |
| `rotl`/`rotr` | `ROL`/`ROR` | Hand-written `(x<<n)|(x>>(64-n))` is **UB when n==0** (shift by 64); `std::rotl` is not |
| `bit_width` | `BSR`-derived | |
| `bit_ceil` | `LZCNT` + shift | UB if the result isn't representable — a real trap |

The zero-input cases are the whole reason these functions exist: `__builtin_ctz(0)` is UB, `BSF` leaves the destination unmodified, and the shift-based rotate is UB at n==0 or n==width. `<bit>` defines all of them.

### Idioms worth having memorized

```cpp
x & (x - 1)        // clear lowest set bit
x & -x             // isolate lowest set bit  (== x & (~x + 1))
x | (x + 1)        // set lowest clear bit
(x & (x-1)) == 0   // power of two (plus x != 0) — or std::has_single_bit
// Iterate set bits:
while (mask) { int i = std::countr_zero(mask); use(i); mask &= mask - 1; }
```

That set-bit iteration loop is the canonical fast path for a bitmap-based order book level index or a ready-set in an event loop: one `TZCNT` and one `BLSR` per set bit, no branching over empty slots.

**Low-latency relevance:** bit tricks turn branches into data dependencies (Ch. 42). A bitmap of occupied price levels lets `countr_zero` find the best bid in one instruction instead of a loop. BMI2's `PDEP`/`PEXT` are extremely useful for bit-field packing but were **microcoded and catastrophically slow on AMD Zen 1–2** (~18–300 cycles vs 3 on Intel), fixed in Zen 3 — a classic "know your target microarchitecture" detail.

C++23 adds `std::byteswap` (Ch. 3 §3.9); C++26 adds saturating arithmetic (`add_sat`, `sub_sat`, `mul_sat`, `div_sat`, Ch. 23) and `std::bit_cast`-adjacent utilities.

---

## 15.8 `std::simd`

`std::simd` (C++26, from the Parallelism TS v2, formerly `std::experimental::simd`) is a **data-parallel vector type** with explicit width and element type, giving portable SIMD without intrinsics.

```cpp
#include <simd>                      // C++26
namespace stdx = std;
using V = std::simd<float>;           // native width for float on this target
V a = ..., b = ...;
V c = a * b + a;                       // elementwise; maps to MULPS/FMA
auto m = a < b;                        // std::simd_mask<float>
V d = std::simd_select(m, a, b);       // blend
float s = std::reduce(a);              // horizontal sum
```

Key pieces: `std::simd<T, Abi>` where the ABI tag selects `native` (widest efficient), `fixed_size<N>`, or `scalar`; `std::simd_mask<T, Abi>` for lane predicates; loads/stores with alignment flags; `simd_select` for branchless blending; and horizontal reductions.

### Why it matters and what it replaces

| Approach | Portability | Control | Pitfalls |
|---|---|---|---|
| Auto-vectorization | Total | None | Silently disabled by aliasing, non-unit stride, reductions on floats, unknown trip counts (Ch. 40) |
| `std::simd` | Across ISAs | Explicit width and ops | Width is target-dependent; tail handling is manual |
| Intrinsics (`_mm256_*`) | Per-ISA | Total | Rewritten per ISA; AVX/SSE transition penalties (Ch. 42) |
| Inline asm | None | Total | Blocks the optimizer |

The value proposition is **guaranteed vectorization**: auto-vectorization is a best-effort optimization that vanishes when you change an unrelated line, and `-fopt-info-vec-missed` exists because the failures are silent. `std::simd` makes the vector width part of the type system, so a regression is a compile error rather than a 4× slowdown.

### Practical points

- **Element order and reductions.** Horizontal reductions of floats reassociate, so results differ from a sequential sum (Ch. 23) — the same determinism concern as `std::reduce` (Ch. 14 §14.5).
- **Alignment.** Aligned loads/stores need the buffer aligned to `simd<T>::size() * sizeof(T)`; use `alignas` or `std::assume_aligned` (Ch. 3 §3.10). Misaligned vector loads that straddle cache lines cost extra, and older ISAs fault.
- **Tail handling** is yours: N elements rarely divide by the vector width. Masked loads (AVX-512, SVE) or a scalar remainder loop.
- **Frequency downclocking**: heavy AVX-512 use drops the core (and historically the package) clock on Skylake-SP-era Intel parts, which can make a "faster" kernel slow down the *rest* of the thread (Ch. 42). This is a real reason low-latency shops restrict AVX-512.
- **`simd_mask` is not `bool`.** Branching on it requires `any_of`/`all_of`/`none_of`; the whole point is to avoid branching via `simd_select`.

Availability: the Parallelism TS version has shipped in libstdc++ as `std::experimental::simd` since GCC 11; the C++26 `<simd>` header is landing now. In production, most shops use intrinsics, Highway, xsimd, or EVE today, and `std::simd` is the direction of travel.

---

## 15.9 Random Engines and Distributions

`<random>` (C++11) deliberately separates three things: a **seed source**, an **engine** (a deterministic PRNG producing raw bits), and a **distribution** (a shaping function mapping engine output to a target distribution).

```cpp
std::random_device rd;                       // non-deterministic seed source (see caveats)
std::mt19937_64 eng{rd()};                   // engine: deterministic given the seed
std::uniform_int_distribution<int> d{1, 6};
int roll = d(eng);
```

| Engine | Period | State | Speed | Quality |
|---|---|---|---|---|
| `minstd_rand` (LCG) | 2³¹−1 | 4 B | Very fast | Poor — fails statistical tests, low-bit correlation |
| `mt19937` / `mt19937_64` | 2¹⁹⁹³⁷−1 | **2.5 KB** | Moderate | Good but fails BigCrush's linear-complexity tests |
| `ranlux48` | Huge | Large | **Very slow** | Excellent |
| `xoshiro256++` / PCG (non-standard) | 2²⁵⁶ / 2⁶⁴ | 32 B / 16 B | Fastest | Excellent |

**The 2.5 KB state of `mt19937` is the low-latency headline**: it doesn't fit in L1 alongside your working set, and it's 312 `uint64_t`s regenerated in a batch every 312 draws — a periodic latency spike. For simulation on a hot path, a 16–32 byte PCG or xoshiro engine is both faster and cache-friendly. The standard has no such engine; C++26 adds `std::philox_engine` (a counter-based, vectorizable, parallel-friendly engine).

### Traps

- **`std::random_device` is not guaranteed non-deterministic.** libstdc++ on some targets and older MinGW returned a *fixed sequence*. Check `entropy()` (which itself may lie, returning 0 on libc++ even when it's real). For anything security-relevant use the OS directly.
- **Distributions are stateful.** `std::normal_distribution` generates pairs (Box–Muller/Marsaglia polar) and caches one; copying or `reset()`ing changes the sequence. Never assume a distribution object is a pure function.
- **Distributions are not portable.** The standard specifies the *distribution*, not the algorithm, so `uniform_int_distribution` gives different values across libstdc++/libc++/MSVC for the same engine and seed. **Engines are fully specified and portable; distributions are not.** For reproducible simulations across platforms (a testing requirement, Ch. 57), implement the distribution yourself or use a fixed-algorithm library.
- **`rand() % n` is biased** and low-quality; the modern equivalent trap is `eng() % n`, which is biased whenever `n` doesn't divide the engine range. `uniform_int_distribution` does rejection sampling correctly; Lemire's multiply-shift method is the fast unbiased alternative.
- **Seeding `mt19937` with a 32-bit value** explores only 2³² of its 2¹⁹⁹³⁷ states. Use `std::seed_seq` with multiple words for real seeding.
- **Determinism is a feature.** In backtesting and deterministic simulation (Ch. 57), you *want* a fixed seed logged with the run so failures are reproducible.

---

## 15.10 `std::chrono` Durations and Time Points

`<chrono>` (C++11, hugely extended in C++20) is a compile-time-dimensioned time library: the unit is part of the type, so unit-mismatch bugs are compile errors and conversions are constant-folded.

```cpp
using namespace std::chrono;
duration<int64_t, std::nano>  ns{5};       // duration<Rep, Period> — Period is a std::ratio
nanoseconds  a = 5ns;                       // literals: ns us ms s min h (C++14)
microseconds b = 3us;
auto sum = a + b;                            // common type = nanoseconds; NO conversion error
milliseconds m = duration_cast<milliseconds>(sum);   // truncating: EXPLICIT required
auto exact = duration_cast<seconds>(1500ms); // 1 — truncates toward zero
auto rounded = round<seconds>(1500ms);       // 2 — C++17 floor/ceil/round<> exist too
```

### The type system

- **`duration<Rep, Period>`** — a count (`Rep`) of a unit (`Period`, a `std::ratio` like `std::milli`). Implicit conversion is allowed only when it is **exact** (no truncation): `ns = ms` is implicit, `ms = ns` needs `duration_cast`. That asymmetry catches an entire class of unit bugs at compile time.
- **`time_point<Clock, Duration>`** — a duration since a clock's epoch, tagged with the clock type. **Time points from different clocks do not mix**, which prevents subtracting a `steady_clock` reading from a `system_clock` reading — a bug that used to be common and silent.
- Arithmetic: `time_point − time_point = duration`; `time_point ± duration = time_point`; `time_point + time_point` is **ill-formed**, correctly.

### Cost

All conversions between durations are compile-time ratio arithmetic — a multiply and/or divide by a constant, usually folded into a shift or a magic-number multiply. `duration_cast` generates **zero runtime overhead beyond the arithmetic**; there is no allocation, no virtual dispatch, no locale. `chrono` types are trivially copyable and pass in registers. Using `int64_t` nanoseconds internally (the default `Rep` for `nanoseconds`) gives ±292 years of range.

The one cost is `now()` itself (§15.11).

### Practice

- **Store durations, not raw integers.** `nanoseconds latency` is self-documenting and unit-safe; `int64_t latency_ns` is a comment.
- **Use `double`-based durations for averages** (`duration<double, std::milli>`) to avoid truncation, but never for timestamps — `double` has 53 bits of mantissa, so nanosecond timestamps since 1970 lose precision.
- **`duration_cast` truncates toward zero**; `floor`, `ceil`, `round` (C++17) do what they say. Latency histograms bucketed with `duration_cast` are systematically biased downward.
- C++20 added `<chrono>` formatting: `std::format("{:%H:%M:%S}", tp)`, plus `hh_mm_ss`.

---

## 15.11 Standard Clocks

Three clocks in C++11, several more in C++20, each with a different guarantee:

| Clock | Monotonic | Adjustable | Epoch | Use for |
|---|---|---|---|---|
| `steady_clock` | **Yes** | No | Unspecified (often boot) | **Measuring intervals** |
| `system_clock` | No | Yes (NTP, admin, DST-irrelevant) | Unix epoch (guaranteed since C++20) | Wall-clock timestamps, converting to/from `time_t` |
| `high_resolution_clock` | Implementation-defined | — | — | **Nothing — it's an alias** |
| `utc_clock` (C++20) | No | Yes | Unix epoch, **counts leap seconds** | Leap-second-correct arithmetic |
| `tai_clock`, `gps_clock` (C++20) | Yes | No | TAI/GPS epochs | Scientific/finance timing standards |
| `file_clock` (C++20) | — | — | Filesystem-specific | `std::filesystem` timestamps |

**`high_resolution_clock` is a trap.** It is an alias for `steady_clock` on libstdc++ and libc++, and for `steady_clock` on modern MSVC — but the standard permits it to alias `system_clock`, which means your interval measurement can go *backwards* when NTP steps the clock. Never use it. The correct answer to "how do you time a code section?" is `steady_clock`, and saying `high_resolution_clock` is a mild red flag.

**`system_clock` non-monotonicity is a production hazard**: an NTP step (or a `settimeofday`) can move it backwards by seconds, making a computed duration negative. NTP *slewing* (gradual rate adjustment) is gentler but still makes `system_clock` intervals wrong by up to 500 ppm (Ch. 35).

### The cost of `now()`

```
steady_clock::now()  →  clock_gettime(CLOCK_MONOTONIC)  →  vDSO  →  RDTSC + scaling
```
On Linux with a TSC clocksource, `clock_gettime` is served from the **vDSO** (Ch. 34) — no syscall, no mode switch, roughly **20–30 ns**. If the clocksource is `hpet` or `acpi_pm` (check `/sys/devices/system/clocksource/*/current_clocksource`), it becomes a real syscall at **hundreds of nanoseconds to microseconds**, and a hot loop calling `now()` collapses. This is a classic production surprise on VMs.

For sub-20 ns timestamping, use **`RDTSC`/`RDTSCP`** directly (Ch. 43): ~15–20 cycles, no ordering guarantee for `RDTSC` (it's not a serializing instruction, so out-of-order execution can move it; `RDTSCP` and `LFENCE;RDTSC` constrain it). Requirements: `constant_tsc` and `nonstop_tsc` in `/proc/cpuinfo` (invariant TSC — the counter runs at a fixed rate regardless of P-states and C-states), plus TSC synchronization across cores, plus a calibration to convert cycles to nanoseconds. Modern x86 has invariant TSC; older or virtualized systems may not.

**The measurement rule:** timestamp with `RDTSC` (or the vDSO `steady_clock`) on the hot path, convert to human time offline, and never call `system_clock::now()` inside a latency measurement.

---

## 15.12 Calendar and Timezone Library

C++20 absorbed Howard Hinnant's `date` library, giving `<chrono>` a full civil-calendar and IANA-timezone layer with no `<ctime>`, no `struct tm`, and no thread-safety hazards.

```cpp
using namespace std::chrono;
year_month_day ymd{2026y, July, 19d};              // calendar literals and types
sys_days sd = ymd;                                  // days since the Unix epoch
year_month_day back{sd};                            // round trip
bool leap = ymd.year().is_leap();
auto last = year_month_day_last{2026y/February/last};   // Feb 28/29 correctly

// Timezones (needs the IANA tzdb)
auto now = system_clock::now();
zoned_time zt{"America/New_York", now};
std::cout << std::format("{:%F %T %Z}", zt);
auto local = zt.get_local_time();                   // local_time<T> is a DISTINCT type

// Weekday arithmetic
weekday wd = weekday{sd};
auto third_friday = 2026y/March/Friday[3];          // options expiry, natively
```

### The type-safety design

`sys_time<D>` (a `system_clock` time point, UTC), `local_time<D>` (a wall-clock reading **with no timezone attached**), and `zoned_time` (a `time_zone*` plus a `sys_time`) are distinct types. This makes the classic timezone bug — treating a local reading as UTC, or vice versa — a compile error. `local_time` deliberately has no epoch meaning until you pair it with a zone.

Conversions that are genuinely ambiguous are surfaced rather than guessed: converting a `local_time` that falls in a DST gap throws `nonexistent_local_time`, and one in a DST overlap throws `ambiguous_local_time` unless you pass a `choose::earliest` / `choose::latest` policy. That is exactly the case that silently corrupts data in most other date libraries.

### Leap seconds

`utc_clock` counts leap seconds; `system_clock` does not (it follows Unix time, which repeats or smears the leap second). `clock_cast<utc_clock>(sys_time)` does the conversion using the tzdb's leap-second table, and `get_leap_second_info` reports whether a given point is inside one. For financial timestamping this matters: a UTC-labelled exchange timestamp during a leap second is genuinely ambiguous under Unix time. Google-style **leap smearing** (spreading the second over 24 hours) is what most infrastructure actually does, and it means your clock is up to 11.6 ppm off for a day (Ch. 35).

### Practical caveats

- **The tzdb is a runtime dependency.** libstdc++ needs the system `tzdata` (GCC 13+ for full support); libc++ shipped tz support in LLVM 19/20; MSVC uses ICU. In a container, forgetting `tzdata` gives a runtime exception, not a compile error. `std::chrono::get_tzdb()` loads and caches it; `reload_tzdb()` picks up updates.
- **Zone lookup is not free.** `zoned_time` construction does a string lookup and a binary search over transitions. Cache the `const time_zone*`; never do zone conversion on a hot path.
- **Formatting allocates.** `std::format` with chrono specifiers builds a string; use `format_to` into a fixed buffer (Ch. 16) for logging.
- All of this is `constexpr`-friendly for the calendar parts (not the tzdb), so `static_assert(2026y/February/last == 2026y/February/28d)` works.

The low-latency posture: keep everything internally as `int64_t` nanoseconds since epoch (or raw TSC), and convert to calendar/zoned representations only at the logging and reporting boundary.

---

## Key Interview Questions

1. **Is `std::tuple` laid out in declaration order?** — No. libstdc++ and MSVC store it in reverse via recursive inheritance; it is not layout-compatible with the equivalent struct and must never be `memcpy`'d to a wire format.
2. **`std::tie` vs structured bindings vs `forward_as_tuple`?** — `tie` makes a tuple of lvalue references (assign into existing variables, or compare lexicographically); structured bindings declare new names and work on structs and arrays; `forward_as_tuple` preserves value category and must not outlive the full expression.
3. **What does `std::apply` do and how is it implemented?** — Calls `f` with a tuple's elements as arguments, via `std::invoke` and an `index_sequence` pack expansion. It's how `std::thread` invokes with stored arguments.
4. **What is `sizeof(std::optional<int*>)`, and why?** — 16, not 8: the standard requires a separate `bool`, with no niche optimization into the pointer's invalid values.
5. **Does `*opt` check for emptiness?** — No; that's UB. `value()` throws `bad_optional_access`; `value_or` doesn't throw but always evaluates and constructs its fallback.
6. **What are `and_then`/`transform`/`or_else`?** — C++23 monadic operations on `optional` (and `expected`): flatMap, map, and lazy fallback.
7. **What is `valueless_by_exception`, and how do you eliminate it?** — A variant left holding nothing when an alternative's move/copy throws during assignment. Make every alternative nothrow-move-constructible; implementations then never enter the state and `visit` skips the check.
8. **How does `std::visit` dispatch, and what does it cost?** — A jump table of function pointers indexed by `index()`, plus a valueless check: an indirect, non-inlinable call subject to misprediction, and an N-dimensional table for multi-visit.
9. **`variant` vs virtual inheritance — when do you pick which?** — The expression problem: `variant` makes adding *operations* cheap and adding *types* expensive (and gives compile-time exhaustiveness plus no allocation and contiguity); inheritance is the reverse.
10. **When is `std::any` appropriate?** — Open-ended heterogeneous storage (plugin/property bags) only. It needs RTTI, may allocate above the SOO threshold, and `any_cast` across shared libraries can fail on `type_info` identity.
11. **Why is `std::vector<bool>` a problem, and what do you use instead?** — It's a bit-packed specialization that isn't a container (proxy references, no `data()`), breaking generic code; use `vector<char>`, `vector<uint8_t>`, or `bitset<N>`.
12. **Why does `<bit>` exist when compilers already had intrinsics?** — Defined behavior for the edge cases: `countr_zero(0)`, `rotl(x, 0)`, and `rotl` with n ≥ width are all UB in the hand-rolled/intrinsic forms and defined in `<bit>`. Plus `constexpr` and portability.
13. **How do you iterate the set bits of a mask efficiently?** — `while (m) { i = countr_zero(m); use(i); m &= m - 1; }` — one `TZCNT` and one `BLSR` per set bit, no branch per empty slot.
14. **What does `std::simd` give you over auto-vectorization?** — A guarantee. Auto-vectorization silently disappears under aliasing, non-unit stride, float reduction reassociation, or unknown trip counts; `std::simd` puts the width in the type system.
15. **Why is `mt19937` a poor choice on a latency-sensitive path?** — 2.5 KB of state (cache-hostile) and a batch regeneration every 312 draws (a periodic spike). Use a 16–32 byte PCG/xoshiro, or C++26's `philox_engine`.
16. **Are `<random>` results reproducible across platforms?** — Engines are fully specified and portable; **distributions are not** — the standard specifies the distribution, not the algorithm. Roll your own for cross-platform reproducibility.
17. **Why should you never use `high_resolution_clock`?** — It may alias `system_clock`, which is non-monotonic; an NTP step makes your measured interval negative. Use `steady_clock`.
18. **What does `duration_cast` cost, and what does it do at boundaries?** — Compile-time ratio arithmetic (no runtime overhead beyond a multiply/shift); it **truncates toward zero**, so use `round`/`floor`/`ceil` for histograms.
19. **Why can't you add two `time_point`s or mix clocks?** — Time points are tagged with their clock, and a point plus a point is meaningless; the type system enforces both, eliminating a whole bug class.
20. **How much does `steady_clock::now()` cost, and when does that change?** — ~20–30 ns via the vDSO when the clocksource is TSC; hundreds of ns to microseconds when it's HPET/ACPI-PM (common on VMs), because it becomes a real syscall.
21. **When would you use `RDTSC` instead?** — Sub-20-ns timestamping on the hot path, given invariant TSC (`constant_tsc`/`nonstop_tsc`), cross-core sync, and calibration. `RDTSC` isn't serializing — use `RDTSCP` or `LFENCE` to bound reordering.
22. **How does C++20 chrono prevent timezone bugs?** — `sys_time`, `local_time`, and `zoned_time` are distinct types; DST gaps and overlaps throw `nonexistent_local_time`/`ambiguous_local_time` instead of guessing.
23. **What's the difference between `system_clock` and `utc_clock`?** — `system_clock` follows Unix time and ignores leap seconds; `utc_clock` counts them, and `clock_cast` converts using the tzdb's leap table.

---

## Common Traps

- **Assuming `tuple` element order matches declaration order** — it usually doesn't; never serialize a tuple.
- **`std::get<T>` on a tuple with duplicate types** — ill-formed, and fragile under refactoring.
- **Storing the result of `std::forward_as_tuple`** — it holds references to temporaries.
- **`auto x = b[3]` on a `bitset` or `vector<bool>`** — captures a proxy reference, not a `bool`.
- **Dereferencing a disengaged `optional` with `*` or `->`** — UB; only `value()` throws.
- **`value_or(expensive())`** — always evaluated; use C++23 `or_else`.
- **Expecting `optional<T*>` or `optional<T&>` to be pointer-sized** — no niche optimization; `optional<T&>` only exists in C++26 and rebinds on assignment.
- **Ignoring `valueless_by_exception`** — reachable whenever an alternative has a throwing move.
- **`std::visit` on a hot dispatch path** — an indirect call that can't inline; a `switch` on a hand-rolled tag often wins.
- **Multi-visit over several variants** — combinatorial table size and compile time.
- **`std::any` with `-fno-rtti`, or `any_cast` across shared-library boundaries** — `type_info` identity depends on symbol visibility.
- **`__builtin_ctz(0)`, `x >> 64`, or `(x<<n)|(x>>(64-n))` with n==0** — all UB; `<bit>` defines them.
- **`std::bit_ceil` overflowing** — UB when the result isn't representable.
- **BMI2 `PDEP`/`PEXT` on AMD Zen 1–2** — microcoded, up to 300 cycles.
- **AVX-512 frequency downclocking** slowing down the surrounding non-vector code.
- **Trusting `std::random_device`** for entropy — it may be a fixed sequence, and `entropy()` may lie.
- **Assuming `<random>` distributions are portable** — only the engines are specified.
- **`eng() % n`** — modulo bias; use `uniform_int_distribution` or Lemire's method.
- **`high_resolution_clock` for measurement** — may be non-monotonic.
- **Using `system_clock` deltas across an NTP step** — negative durations.
- **`duration_cast` for latency histograms** — truncation biases every bucket downward.
- **Calling `clock_gettime` in a hot loop on a VM with an HPET clocksource** — a syscall per call.
- **Constructing `zoned_time` on a hot path** — string lookup plus a transition search; cache the `time_zone*`.
- **Missing `tzdata` in a container** — a runtime exception from `get_tzdb()`.

---

## Compact Recall Summary

**Pair/tuple.** Heterogeneous fixed-size aggregates. Tuple layout is implementation-defined and usually reversed — not layout-compatible with a struct, never serialize it. Trivially copyable iff the elements are; empty elements cost nothing via EBO. Best uses: multi-key comparison via `tie`/`<=>`, argument-pack storage, metaprogramming. `make_pair` decays and unwraps `reference_wrapper`; CTAD doesn't.

**apply/tie.** `apply` unpacks a tuple into a call via `invoke` + `index_sequence` — how `thread`/`async` invoke stored arguments; `make_from_tuple` constructs. `tie` builds a tuple of lvalue references for assignment and lexicographic comparison; structured bindings supersede it for unpacking; `forward_as_tuple` preserves value category and must die with the full expression. All zero runtime cost.

**optional.** `T` + `bool`, no allocation, no niche optimization (so `optional<T*>` is 16 bytes). `*`/`->` don't check, `value()` throws, `value_or` is eager. Monadic `and_then`/`transform`/`or_else` in C++23; `optional<T&>` with rebinding assignment in C++26. Says "absent", not "why" — that's `expected`.

**variant.** Tagged union, size = largest alternative + index, never allocates. `valueless_by_exception` is eliminated by nothrow-movable alternatives. `visit` is a function-pointer jump table plus a valueless check — an indirect, non-inlinable call; multi-visit is combinatorial. The expression problem: variant favors adding operations, inheritance favors adding types. For a closed message set, variant or a hand-rolled `switch` union wins on contiguity and inlining.

**any.** Open type set, RTTI-dependent, allocates above an implementation-defined SOO threshold, `any_cast` compares `type_info` (fragile across shared libraries). Configuration-layer only.

**bitset.** Fixed-size, inline, word-backed; `count()` → `POPCNT`, `any()`/`all()` are word reductions. `operator[]` returns a proxy. `vector<bool>` is the standard's acknowledged mistake — not a container.

**`<bit>`.** `bit_cast`, `popcount`, `countl/countr_zero/one`, `rotl/rotr`, `bit_width/ceil/floor`, `has_single_bit`, `endian`. Unsigned only, `constexpr`, and defined at the edges where intrinsics and hand-rolled shifts are UB. Set-bit iteration is `countr_zero` + `m &= m-1`. Know `PDEP`/`PEXT`'s Zen 1–2 penalty.

**simd.** C++26 portable data-parallel type: `simd<T,Abi>`, `simd_mask`, `simd_select`, reductions. Buys a *guarantee* where auto-vectorization is best-effort. Watch alignment, tail handling, reduction reassociation, and AVX-512 downclocking.

**random.** Seed source → engine → distribution. `mt19937`'s 2.5 KB state and batch refill make it wrong for hot paths; prefer PCG/xoshiro or C++26 `philox_engine`. `random_device` may be deterministic; engines are portable but **distributions are not**; distributions are stateful; `% n` is biased.

**chrono durations.** `duration<Rep, Period>` puts the unit in the type: exact conversions implicit, lossy ones require `duration_cast` (which truncates toward zero — use `round`/`floor`/`ceil`). Time points are clock-tagged and can't be mixed or added. All conversions are constant-folded ratio arithmetic.

**Clocks.** `steady_clock` for intervals, `system_clock` for wall time (Unix epoch guaranteed in C++20, non-monotonic), `high_resolution_clock` never. `now()` is ~20–30 ns through the vDSO with a TSC clocksource, and orders of magnitude worse on HPET/ACPI-PM. `RDTSC`/`RDTSCP` for sub-20-ns timestamps given invariant TSC, sync, and calibration.

**Calendar/tz.** `sys_time` / `local_time` / `zoned_time` are distinct types, so the UTC-vs-local bug is a compile error; DST gaps and overlaps throw rather than guess. `utc_clock` counts leap seconds, `system_clock` doesn't. The tzdb is a runtime dependency (`tzdata`) and zone lookup is not free — cache the `time_zone*` and keep the hot path on integer nanoseconds, converting only at the logging boundary.
