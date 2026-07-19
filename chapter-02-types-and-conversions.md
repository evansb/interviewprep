# Chapter 2 — Types and Conversions

*Interview-focused revision notes. The theme: C++ applies silent, rule-driven conversions everywhere, and most "impossible" bugs are a conversion you didn't see.*

---

## 2.1 Fundamental Types and Fixed-Width Integers

C++ specifies **minimum ranges and relative ordering**, not exact sizes. The only guarantees:

```
sizeof(char) == 1                        (by definition — 1 byte, whatever a byte is)
1 == sizeof(char) <= sizeof(short) <= sizeof(int) <= sizeof(long) <= sizeof(long long)
char        ≥ 8 bits     short ≥ 16     int ≥ 16     long ≥ 32     long long ≥ 64
CHAR_BIT    ≥ 8          (8 on every mainstream platform; some DSPs use 16 or 32)
```

Note **`int` is only guaranteed 16 bits**, though it's 32 everywhere you'll realistically work. The real portability landmine is `long`:

| Model | `int` | `long` | `long long` | pointer | Where |
|---|---|---|---|---|---|
| **LP64** | 32 | **64** | 64 | 64 | Linux, macOS, most Unix |
| **LLP64** | 32 | **32** | 64 | 64 | Windows x64 |
| ILP32 | 32 | 32 | 64 | 32 | 32-bit systems |

So `long` is 64-bit on Linux and 32-bit on Windows — the single most common source of cross-platform integer bugs. Never use `long` in a portable interface; use `int64_t` or `std::size_t`.

### Fixed-width types (`<cstdint>`)

| Family | Guarantee |
|---|---|
| `int8_t … int64_t` | **Exactly** N bits, two's complement, no padding. **Optional** — only exist if the platform has such a type (universally present on mainstream hardware) |
| `int_least8_t …` | Smallest type with **at least** N bits. Always present. |
| `int_fast8_t …` | Fastest type with at least N bits. Always present; definition of "fast" is a vendor guess and often wrong in practice (frequently 64-bit, wasting cache) |
| `intmax_t` / `uintmax_t` | Widest supported integer |
| `intptr_t` / `uintptr_t` | Integer able to round-trip a `void*`. Optional. |
| `size_t` | Unsigned; result of `sizeof`; can hold any object size |
| `ptrdiff_t` | Signed; result of pointer subtraction |

**`int8_t` is almost always `signed char`**, which means `std::cout << int8_t{65}` prints `A`, not `65`. Same for the unsigned version. This surprises everyone once.

### Signedness of `char`

There are **three distinct types**: `char`, `signed char`, `unsigned char`. Plain `char` has implementation-defined signedness — signed on x86/x86-64 Linux and Windows, **unsigned on ARM and PowerPC Linux**. This makes `char c = 0xFF; if (c == 0xFF)` platform-dependent, and makes `char` a poor choice for arithmetic or byte manipulation. Use `unsigned char` or `std::byte` for raw bytes, `char` only for text.

`std::byte` (C++17) is a scoped enum over `unsigned char` — it supports only bitwise ops, no arithmetic, forcing intent to be explicit. It also inherits `unsigned char`'s special aliasing permission (§2.12).

### Other fundamentals

- `bool` — `sizeof` is typically 1 but not required to be; only values `true`/`false`. Reading an uninitialized or type-punned `bool` holding, say, `2` is UB and really does produce `if (b && !b)` being true under optimization.
- `wchar_t` — 32-bit on Linux (UTF-32), **16-bit on Windows** (UTF-16). Useless for portability.
- `char8_t` (C++20), `char16_t`, `char32_t` — distinct types for UTF-8/16/32 (§2.9).
- `float`/`double`/`long double` — `long double` is 80-bit extended on x86 Linux (with 10 or 16 bytes of storage), but **identical to `double` on MSVC**.
- `void` — incomplete type that can never be completed; `void*` is the generic object pointer.
- `std::nullptr_t` — the type of `nullptr` (§2.11).

**Practical rule:** use `int` for ordinary loop counters and small arithmetic (it's the platform's natural word and signed overflow being UB actually helps the optimizer), `std::size_t`/`ptrdiff_t` for sizes and indices matching the standard library, and explicit `int32_t`/`uint64_t` for serialization, hardware registers, and protocol structs where exact width is semantically required.

---

## 2.2 Integer Promotions and Usual Arithmetic Conversions

Almost every arithmetic bug in C++ traces to these two rule sets, applied invisibly.

### Integral promotion

**Any type of lower rank than `int` is promoted to `int` before arithmetic** — provided `int` can represent all its values; otherwise to `unsigned int`.

Promoted: `bool`, `char`, `signed char`, `unsigned char`, `short`, `unsigned short`, `char8_t/16_t/32_t`, `wchar_t`, and unscoped enums (to their promoted underlying type). **Not** promoted: scoped enums (§2.10).

```cpp
uint8_t a = 200, b = 100;
auto  x = a + b;          // x is int, value 300 — NOT wrapped to 44
uint8_t y = a + b;        // now truncated back to 44

unsigned short s = 0xFFFF;
int t = s * s;            // s promoted to int; 65535*65535 overflows int → UB!
```
That last example is a genuine and famous trap: promoting *unsigned* short to *signed* int converts a well-defined wraparound into undefined behavior.

```cpp
char c = 'A';
sizeof(c)       // 1
sizeof(c + 0)   // 4 — promotion
sizeof(+c)      // 4 — unary + promotes
```

### Usual arithmetic conversions (UAC)

Applied to binary operators after promotion, to bring both operands to a common type:

```
1. If either is long double  → both long double
2. else if either is double  → both double
3. else if either is float   → both float
4. else (both integral, after promotion):
   a. same signedness           → convert to the higher rank
   b. unsigned rank ≥ signed rank        → convert signed operand to UNSIGNED
   c. signed type can represent all unsigned values → convert to SIGNED
   d. otherwise                 → both to the UNSIGNED version of the signed type
```

Step **4b is where programs break.** On LP64:

```cpp
int      i = -1;
unsigned u = 1;
i < u                 // false! i converts to 4294967295u
                      // -Wsign-compare warns; enable it and treat as error

size_t   n = 0;
for (int k = 0; k < n - 1; ++k)   // n-1 is size_t → 0-1 wraps to SIZE_MAX
                                  // k converts to unsigned → loop runs ~4 billion times
```

Rank ordering: `bool` < `char` < `short` < `int` < `long` < `long long` (signed and unsigned of the same base have equal rank). Note step 4c: on LP64, `unsigned int` vs `long` → `long` wins (64-bit signed represents all 32-bit unsigned values), so this doesn't blow up; on LLP64 Windows where `long` is 32-bit, it becomes `unsigned long`. Same expression, different signedness on two platforms.

### Defences

- `-Wsign-compare -Wsign-conversion -Wconversion` (be prepared for volume in legacy code).
- `std::ssize()` (C++20) returns a signed size, letting `for (auto i = 0; i < std::ssize(v); ++i)` be sign-clean.
- `std::cmp_less`, `cmp_greater`, `cmp_equal` (C++20, `<utility>`) compare integers **mathematically correctly** across signedness — the right tool when you truly must compare mixed types.
- `gsl::narrow_cast` / a checked `narrow` for deliberate narrowing.

---

## 2.3 Signed and Unsigned Arithmetic

The representational facts first. **Since C++20, signed integers are guaranteed two's complement** (previously sign-magnitude and one's complement were permitted, though extinct in practice). Two's complement means:

```
 int8_t:  0111'1111 = 127
          1000'0000 = -128        (asymmetric: no positive counterpart)
 -x == ~x + 1;   INT_MIN == -INT_MIN (overflow!);  abs(INT_MIN) is UB
```

**Bit patterns for add/subtract/multiply are identical for signed and unsigned** — the hardware doesn't care. What differs is (a) comparison, (b) right shift, (c) division, and (d) what the *language* says about overflow.

| | Signed | Unsigned |
|---|---|---|
| Overflow | **Undefined behavior** | **Defined**: wraps mod 2ⁿ |
| `>>` | Arithmetic shift (sign-extending) — implementation-defined pre-C++20, guaranteed since | Logical shift (zero-fill) |
| Division by negative | Truncates toward zero (`-7/2 == -3`, `-7%2 == -1`) | N/A |
| Comparison instruction | `jl`/`jg` (SF/OF) | `jb`/`ja` (CF) |

### Why signed overflow is UB (and why that's useful)

It permits the optimizer to assume arithmetic doesn't wrap:
- `x + 1 > x` folds to `true`.
- `for (int i = 0; i <= n; ++i)` is provably finite, enabling vectorization and induction-variable widening (promoting a 32-bit counter to a 64-bit register without re-truncating each iteration).
- `(a * 2) / 2` folds to `a`.

With unsigned, none of these hold, so unsigned loop counters can generate *worse* code on 64-bit targets — the compiler must emit an explicit 32-bit truncation each iteration to preserve wrapping semantics.

### The case against unsigned for quantities

The "unsigned means non-negative, which documents intent" argument fails in practice because:
1. Subtraction wraps to a huge number instead of going negative — the error becomes invisible rather than obvious.
2. Mixed comparisons silently convert the signed side (§2.2).
3. `for (size_t i = v.size() - 1; i >= 0; --i)` **never terminates**, and on an empty vector immediately reads `v[SIZE_MAX]`.

The C++ committee has publicly called `size_t` for `std::vector::size()` a historical mistake (Stroustrup, Sutter, Carruth all on record). Use unsigned for: bit manipulation, hashing, modular arithmetic, and interoperating with the standard library. Use signed for quantities and indices.

### Shifting rules

```cpp
1 << 31       // int is 32-bit: UB (signed overflow via shift) — use 1u << 31
1u << 32      // UB: shift count >= width of promoted type
x >> -1       // UB
int(-8) >> 1  // -4, arithmetic shift (guaranteed C++20)
```
Shift count ≥ operand width is UB, not "zero" — x86 masks the count to 5/6 bits, so `1u << 32` frequently yields `1`, while ARM yields `0`. Perfect demonstration that UB is not "implementation-defined."

`std::rotl`/`std::rotr` (C++20, `<bit>`) exist precisely because the hand-rolled `(x << n) | (x >> (32-n))` is UB when `n == 0`.

---

## 2.4 Integer Overflow

**Signed overflow is UB. Unsigned overflow wraps.** The consequences of the first are non-local and non-intuitive.

```cpp
bool willOverflow(int a, int b) { return a + b < a; }   // BROKEN
```
The compiler reasons: signed overflow can't happen, therefore `a + b < a` ⟺ `b < 0`. Your check compiles to a sign test. Real CVEs have this shape. Similarly:

```cpp
if (idx + len > size) return error;   // if these are ints and idx+len overflows,
                                      // the check can be optimized away entirely
```

### Correct detection

**Builtins (best):**
```cpp
int r;
if (__builtin_add_overflow(a, b, &r)) return error;   // GCC/Clang; also sub/mul
// MSVC: <intsafe.h>, or use the C++26 std::add_sat / <numeric> saturating ops
```
C++20 gives `std::in_range<T>(v)` and the `cmp_*` family; C++26 adds `std::add_sat`/`sub_sat`/`mul_sat` and `std::saturate_cast`.

**Manual, UB-free (pre-check, never post-check):**
```cpp
if (b > 0 && a > INT_MAX - b) return error;   // additive overflow
if (b < 0 && a < INT_MIN - b) return error;
```

**Cast to unsigned for defined wrapping:**
```cpp
int wrapping_add(int a, int b) {
    return static_cast<int>(static_cast<unsigned>(a) + static_cast<unsigned>(b));
}
```
The final unsigned→signed narrowing conversion was implementation-defined before C++20 and is now guaranteed to be modular. This is the portable way to *want* wrapping.

### Overflow-adjacent traps

- `INT_MIN / -1` and `INT_MIN % -1`: UB, and on x86 the `idiv` instruction raises **SIGFPE** — an actual crash, not a wrong value.
- `std::abs(INT_MIN)` is UB.
- **Allocation size overflow**: `malloc(n * sizeof(T))` where `n * sizeof(T)` wraps → tiny allocation, huge writes. This is the archetypal heap-overflow CVE. `new T[n]` is required to check since C++11 and throws `std::bad_array_new_length`.
- Narrowing conversions on assignment: `int8_t x = 300;` is implementation-defined pre-C++20, modular after. Brace initialization `int8_t x{300}` makes it a **compile error** — a strong reason to prefer braces.

### Tooling

- **UBSan**: `-fsanitize=signed-integer-overflow` (and `unsigned-integer-overflow`, which flags *defined* wrapping — noisy, only useful when you assert no wrapping is intended).
- `-ftrapv` traps on signed overflow (older, slower); `-fwrapv` **defines** signed overflow as wrapping, sacrificing the optimizations in §2.3 for predictability. Both are escape hatches, not fixes.

---

## 2.5 IEEE 754 Floating Point

C++ does not mandate IEEE 754, but every mainstream platform provides it (`std::numeric_limits<double>::is_iec559` tells you).

```
binary32 (float):   [S:1][ Exponent:8 ][ Mantissa:23 ]   bias 127
binary64 (double):  [S:1][ Exponent:11][ Mantissa:52 ]   bias 1023

value = (-1)^S × 1.mantissa × 2^(E - bias)        for 0 < E < max   (normal)
      = (-1)^S × 0.mantissa × 2^(1 - bias)        for E == 0        (subnormal)
```

The leading `1.` is **implicit** — not stored — buying one free bit of precision. Hence `double` has 53 bits of significand from 52 stored bits.

| | `float` | `double` |
|---|---|---|
| Significand bits | 24 (23 stored) | 53 (52 stored) |
| Decimal digits (round-trip) | 9 (`max_digits10`); 6 fully reliable (`digits10`) | 17; 15 reliable |
| Max / min normal | ~3.4e38 / ~1.18e-38 | ~1.8e308 / ~2.2e-308 |
| Exact integers up to | 2²⁴ = 16,777,216 | 2⁵³ ≈ 9.007e15 |

**Key structural facts:**

- **Density is non-uniform.** Floats are evenly spaced *within* a binade and the spacing doubles at each power of two. Near 1.0 the gap for `double` is 2⁻⁵² ≈ 2.2e-16 (**machine epsilon**); near 2⁵³ the gap is 1.0; beyond that, consecutive integers are not representable. Hence `(double)(2^53) + 1 == (double)(2^53)`.
- **The ordering trick:** for non-negative floats, the IEEE bit pattern reinterpreted as an integer is monotonically increasing. This is why you can compare floats with integer instructions and why ULP-based comparison works.
- **`0.1` is not representable in binary** (it's a repeating fraction, like 1/3 in decimal), so `0.1 + 0.2 != 0.3`. This is not a bug; it's base conversion.
- **Rounding**: default mode is *round-to-nearest, ties-to-even*. Each individual operation (`+ - * / sqrt`) is **correctly rounded**: computed as if with infinite precision then rounded once. Transcendentals (`sin`, `exp`) are *not* required to be correctly rounded, hence results can differ across libm versions.
- **`+0.0` and `-0.0`** are distinct bit patterns that compare **equal**. `1/+0.0 == +inf`, `1/-0.0 == -inf`. `std::signbit` distinguishes them; `==` does not.

### Consequences for code

- **Never compare with `==`.** Use an absolute epsilon for values near zero, a relative epsilon otherwise, or ULP distance:
  ```cpp
  bool close(double a, double b, double rel = 1e-9, double abs = 1e-12) {
      double d = std::fabs(a - b);
      return d <= abs || d <= rel * std::max(std::fabs(a), std::fabs(b));
  }
  ```
  There is no universally correct epsilon; the right one depends on the magnitudes and the accumulated error of your computation.
- **Addition is not associative.** `(a+b)+c != a+(b+c)`. This is why parallel reductions give run-to-run–varying results with different thread counts, and why the compiler may not reorder FP additions without `-ffast-math` (§2.8).
- **Catastrophic cancellation**: subtracting nearly equal numbers annihilates significant digits. `sqrt(x+1) - sqrt(x)` for large `x` loses everything; rewrite as `1/(sqrt(x+1)+sqrt(x))`. Similarly the naive quadratic formula and the naive variance formula (`E[x²] - E[x]²`) are numerically catastrophic — use Welford's algorithm.
- **Summation error accumulates** as O(n) naively, O(√n) statistically; **Kahan compensated summation** reduces it to O(1) at ~4× the arithmetic cost. `std::accumulate` does neither.
- **`float` on x87** was historically computed in 80-bit registers and rounded on spill, so the *same* expression produced different results depending on register pressure (`-ffloat-store` was the workaround). SSE2 killed this on x86-64; it survives in 32-bit builds and is worth mentioning as the origin of "excess precision" (`FLT_EVAL_METHOD`).

---

## 2.6 Subnormal (Denormal) Floating-Point Values

When the exponent field is all zeros, the implicit leading bit becomes **0** instead of 1, and the exponent is fixed at the minimum. These are **subnormals** (older name: denormals).

```
normal min (double):  1.0 × 2^-1022 ≈ 2.2250738585072014e-308
subnormal:            0.mantissa × 2^-1022,  down to 2^-1074 ≈ 4.94e-324
```

**Why they exist — gradual underflow.** Without them, the gap between 0 and the smallest normal would be enormous relative to the gap between adjacent normals, and crucially `a - b == 0` would no longer imply `a == b`. Subnormals preserve that invariant: any two distinct normals differ by at least one representable subnormal.

**The cost.** Subnormals are usually not handled by the fast datapath. On many Intel microarchitectures, an operation producing or consuming a subnormal triggers a microcode assist costing **~100+ cycles** versus ~4. A hot loop that drifts into subnormal territory can slow down by **50–100×** with no change in code — the classic symptom is an audio filter or physics simulation whose CPU usage spikes as values decay toward zero.

**Mitigations:**

| Mechanism | Effect |
|---|---|
| **FTZ** (flush-to-zero) | Results that would be subnormal become ±0 |
| **DAZ** (denormals-are-zero) | Subnormal *inputs* are treated as ±0 |
| `_MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON)` + `_MM_SET_DENORMALS_ZERO_MODE(...)` | Set the MXCSR bits explicitly |
| `-ffast-math` | Implicitly enables FTZ/DAZ by linking `crtfastmath.o` |
| Add a tiny DC offset / periodically zero small values | Portable, application-level |

FTZ/DAZ are **not IEEE-conformant** and break the `a-b==0 ⟹ a==b` invariant. They are set per-thread in the MXCSR register, and — a genuinely nasty trap — **a library compiled with `-ffast-math` silently changes FP behavior for the entire process** when its static initializers run, because the flags are global to the thread, not to the code.

`std::fpclassify(x) == FP_SUBNORMAL` and `std::numeric_limits<T>::denorm_min()` are the standard queries. `has_denorm` reports support.

---

## 2.7 NaN and Infinity

Both are encoded with the exponent field **all ones**.

```
exponent = all 1s, mantissa == 0  →  ±Infinity
exponent = all 1s, mantissa != 0  →  NaN
    mantissa's top bit set        →  quiet NaN (qNaN)   — propagates silently
    mantissa's top bit clear      →  signaling NaN (sNaN) — raises FE_INVALID on use
```

### Infinity

Produced by overflow (`1e308 * 10`), by division of a nonzero by zero, and by `std::log(0)` (→ `-inf`). Arithmetic behaves as a mathematical limit: `inf + 1 == inf`, `1/inf == 0`, `inf > x` for all finite `x`. Indeterminate forms produce NaN: `inf - inf`, `inf * 0`, `inf / inf`, `0 / 0`.

`std::numeric_limits<double>::infinity()` is the portable way to get one. `max()` is *not* infinity — a common mistake when writing "initialize to a very large value" code; use `infinity()` if you want correct comparison semantics, or `max()` if you need a finite value.

### NaN

Produced by `0.0/0.0`, `sqrt(-1)`, `log(-1)`, `inf - inf`, `0 * inf`. Then it **propagates**: any arithmetic operation with a NaN operand yields NaN. This is the point — one bad value poisons the result rather than silently producing a plausible number.

**The comparison rule everyone gets asked about:** NaN is **unordered** with everything, including itself.

```cpp
double n = std::nan("");
n == n            // false   ← the canonical NaN test
n != n            // true
n <  1.0          // false
n >= 1.0          // false   ← note: !(n < 1.0) is NOT the same as (n >= 1.0)
std::isnan(n)     // true    ← the correct, readable test
```

Consequences that bite in real code:

1. **`std::sort` with NaN in the range is UB.** `operator<` on NaN violates strict weak ordering (irreflexivity is fine, but transitivity of incomparability fails), and libstdc++'s introsort will run off the end of the buffer — a real out-of-bounds write, not just a bad ordering. Same for `std::map` keys and any `std::set`.
2. **`std::max(a, b)` returns `b` if either is NaN or if they're unordered** — it's `a < b ? b : a`. `std::fmax`/`std::fmin` explicitly ignore a NaN operand and return the other, which is usually what you want.
3. A NaN in an accumulator silently destroys an entire aggregation, and the *location* of the origin is lost. `-ffinite-math-only` will happily optimize your `isnan` check away (§2.8).
4. NaN payload bits are preserved (mostly) by moves and by some operations, allowing "NaN boxing" — encoding pointers or type tags in the mantissa, used by JavaScript engines and LuaJIT.

**Floating-point exceptions** (`<cfenv>`): `FE_INVALID`, `FE_DIVBYZERO`, `FE_OVERFLOW`, `FE_UNDERFLOW`, `FE_INEXACT` are *sticky flags*, not traps, by default. `std::fetestexcept` reads them; `feenableexcept` (glibc, non-standard) turns them into SIGFPE, which is the best debugging tool for "where did this NaN come from" — enable `FE_INVALID` and run under a debugger.

---

## 2.8 Fast-Math Optimizations

`-ffast-math` is a bundle of flags that permit the optimizer to treat FP arithmetic as if it were real arithmetic. It is fast, and it is a loaded gun.

| Sub-flag | Permits |
|---|---|
| `-fno-signed-zeros` | Ignore the +0/−0 distinction (`x + 0.0 → x`, which is wrong for `x = -0.0`) |
| `-fno-trapping-math` | Assume no FP exceptions are observed; enables free reordering |
| `-ffinite-math-only` | **Assume no NaNs or infinities** |
| `-fassociative-math` | Reassociate: `(a+b)+c → a+(b+c)`, enabling vectorized reductions |
| `-freciprocal-math` | `x/y → x * (1/y)` — one reciprocal for a loop, but loses accuracy |
| `-fno-math-errno` | Don't set `errno` in math functions — lets `sqrt` become a single instruction instead of a call |
| `-funsafe-math-optimizations` | Umbrella for associative + reciprocal + others |
| (implicit) FTZ/DAZ | Links `crtfastmath.o`, setting MXCSR at startup (§2.6) |

**The showstopper:** `-ffinite-math-only` makes `std::isnan(x)` fold to `false` and `x != x` fold to `false`. **Your NaN checks disappear.** Code that defensively validates inputs stops validating them. This is the number-one reason not to apply `-ffast-math` globally.

**The gains are real** where they apply: reduction loops become vectorizable (a serial `sum += a[i]` chain cannot be SIMD'd without reassociation, so this alone can be a 4–8× speedup), `sqrt` becomes an instruction, and division becomes multiplication by a reciprocal.

**Better-scoped alternatives, in order of preference:**
1. Enable **only the flag you need**, e.g. `-fno-math-errno` (essentially always safe in C++, since nobody checks `errno` after `sqrt`) or `-fassociative-math` on a specific file.
2. Use `#pragma omp simd reduction(+:sum)` or `std::reduce` (which is explicitly permitted to reassociate, unlike `std::accumulate`) to authorize reassociation *at the call site* rather than globally.
3. `[[gnu::optimize("fast-math")]]` on a single function, or per-file compilation flags, so the blast radius is bounded. (Note: function-level attributes for FP flags are historically buggy in GCC — per-TU flags are more reliable.)
4. `-ffp-contract=fast` (often on by default) allows `a*b+c` to fuse into an **FMA**, which is *more* accurate (one rounding instead of two) but changes results. `-ffp-contract=off` for bit-reproducibility.
5. C++23's `#pragma STDC FP_CONTRACT` and `<cfloat>`'s `FLT_EVAL_METHOD` give standard-ish control.

**Reproducibility.** If your domain requires bit-identical results (finance, regression-tested simulation, distributed consensus), fast-math is off the table, and you additionally need fixed thread counts for reductions, `-ffp-contract=off`, and a fixed libm version. State this explicitly in an interview — recognizing the *reproducibility* dimension, not just the accuracy one, is what distinguishes a good answer.

---

## 2.9 Character Types and Encodings

C++ separates the **character type** (a storage unit) from the **encoding** (an interpretation).

| Type | Size | Intended encoding | Literal |
|---|---|---|---|
| `char` | 1 | Execution charset (narrow); implementation-defined signedness | `'a'`, `"abc"` |
| `signed char` / `unsigned char` | 1 | Raw bytes | — |
| `char8_t` (C++20) | 1 | UTF-8 code unit | `u8"abc"` |
| `char16_t` | 2 | UTF-16 code unit | `u"abc"` |
| `char32_t` | 4 | UTF-32 code point | `U"abc"` |
| `wchar_t` | 4 (Unix) / 2 (Windows) | Implementation-defined | `L"abc"` |

**Three charsets in the standard:** the *source* charset (how your file is encoded on disk — declare with `-finput-charset`), the *execution* charset (how narrow literals are stored at runtime, `-fexec-charset`), and the *wide execution* charset. Conversion between them happens in translation phase 5 (Ch. 1 §1.4).

### The key distinctions

- **Code unit** — one element of the encoded sequence (a `char` in UTF-8, a `char16_t` in UTF-16).
- **Code point** — one Unicode scalar value, `U+0000`–`U+10FFFF`.
- **Grapheme cluster** — what a user perceives as a character (`é` may be one code point or two; a flag emoji is two; 👨‍👩‍👧 is five with ZWJs).

`std::string::size()` counts **code units**, i.e. bytes. It is not the number of characters in any user-meaningful sense, and there is no standard-library way to get grapheme clusters — you need ICU. Saying this explicitly is a strong signal in an interview.

### UTF-8

Variable width, 1–4 bytes. ASCII is a subset (byte-compatible), it is self-synchronizing (continuation bytes are `10xxxxxx`, so you can always find a boundary), and it has no endianness. It is the correct default for storage and interchange.

```
U+0041 'A'   → 41
U+00E9 'é'   → C3 A9
U+20AC '€'   → E2 82 AC
U+1F600 '😀' → F0 9F 98 80
```

**`char8_t` was a breaking change in C++20**: `u8"hi"` changed type from `const char[3]` to `const char8_t[3]`, so `std::string s = u8"hi";` stopped compiling. The motivation was type-safety — a `char*` says nothing about encoding, `char8_t*` asserts UTF-8 — but the ecosystem cost was high and `std::u8string` remains poorly supported. C++23 relaxed some of this.

### UTF-16 and Windows

Windows APIs are UTF-16 (`wchar_t`, `WCHAR`). UTF-16 is **also variable width** — characters outside the BMP use *surrogate pairs* (two `char16_t`). The pervasive bug is treating UTF-16 as fixed-width UCS-2, which breaks on emoji, historical scripts, and rare CJK. Best practice: keep UTF-8 internally, convert at the Windows API boundary (`MultiByteToWideChar`), or use the `_UNICODE`+wide entry points consistently.

### What to avoid

`std::codecvt` and `<locale>`-based conversion (`std::wstring_convert`) were **deprecated in C++17** and removed in C++26 — they were unsalvageably broken (locale-dependent, non-thread-safe, error-prone). Use ICU, `simdutf`, or platform APIs. C++26 begins adding real Unicode support (`std::text_encoding`, and the `<format>` machinery is already encoding-aware for width estimation).

Also note the locale-dependence trap: `std::toupper`/`isalpha` take an `int` that must be representable as `unsigned char` — passing a negative `char` directly is **UB**, so always write `std::toupper(static_cast<unsigned char>(c))`. And they're per-code-unit, so they cannot correctly case-fold anything non-ASCII (German ß → SS changes length; Turkish dotless ı is locale-specific).

---

## 2.10 Scoped and Unscoped Enumerations

### Unscoped (`enum E { A, B }`) — the C-compatible legacy form

Three problems, all fixed by `enum class`:

1. **Enumerators leak into the enclosing scope.** `enum Color { Red, Green };` and `enum Fruit { Apple, Red };` collide at namespace scope.
2. **Implicit conversion to integer.** `if (color == 3)` compiles. `Color c = Red; int x = c * 2;` compiles. Type safety is nil.
3. **Underlying type is implementation-defined** (unless fixed), so `sizeof(E)` varies and forward declaration is impossible without a fixed type.

The underlying type is chosen by the implementation as one that can hold all enumerators — often `int`, but `unsigned int` if any enumerator exceeds `INT_MAX`, and possibly larger. Since C++11 you can fix it: `enum E : uint8_t { ... };` which also makes `enum E : uint8_t;` a legal forward declaration.

**Range of values.** For an unscoped enum without a fixed underlying type, the valid value range is not the enumerator list but the smallest bit-field that can hold all enumerators — so `enum Flags { A=1, B=2, C=4 };` legitimately holds values 0–7, which is what makes bitmask enums well-defined. Casting an out-of-range value into an enum is UB, and the optimizer does exploit this (a `switch` over an enum need not handle values outside the range).

### Scoped (`enum class E { A, B }`) — C++11

```cpp
enum class Color : uint8_t { Red, Green, Blue };
Color c = Color::Red;          // must qualify
int  i = c;                    // ERROR — no implicit conversion
int  j = static_cast<int>(c);  // explicit only
if (c == 0)                    // ERROR — good
```
- Enumerators are scoped to the enum's name.
- **No implicit conversion to integer** in either direction (though *to* the enum still requires an explicit cast, and list-initialization from an integer `Color{1}` is allowed since C++17 if the underlying type is fixed).
- **Underlying type defaults to `int`**, so `sizeof` is predictable and forward declaration always works.
- Still comparable and orderable among themselves; still usable in `switch`.

`std::to_underlying` (C++23) replaces the `static_cast<std::underlying_type_t<E>>(e)` boilerplate.

### Trade-offs and idioms

Scoped enums are strictly better as *type-safe named constants*. The friction appears with **bitmask flags**, where you actually want `|` and `&`:

```cpp
enum class Perm : unsigned { Read = 1, Write = 2, Exec = 4 };
constexpr Perm operator|(Perm a, Perm b) {
    return Perm(std::to_underlying(a) | std::to_underlying(b));
}
constexpr bool has(Perm set, Perm bit) {
    return (std::to_underlying(set) & std::to_underlying(bit)) != 0;
}
```
Boilerplate, but it buys you a type that can't be confused with an `int` or with another flag enum. (`std::byte` is exactly this pattern applied to bytes.)

**No reflection.** There is no standard way to convert an enumerator to its name string; the options are a hand-maintained table, X-macros, `magic_enum` (compile-time parsing of `__PRETTY_FUNCTION__`, capped at a value range), or C++26 reflection. Expect this question if you mention serialization.

**Non-exhaustive `switch`.** `-Wswitch` warns when a `switch` over an enum omits an enumerator *and has no `default`*. Adding `default:` silences it — which is why the disciplined pattern is to omit `default` for closed enums, so adding an enumerator produces warnings at every site that must be updated.

---

## 2.11 Boolean Conversions and Null Pointers

### Contextual conversion to `bool`

`if`, `while`, `for`'s condition, `&&`, `||`, `!`, and `?:` **contextually convert** their operand to `bool`. Contextual conversion considers `explicit operator bool()` — which is why `explicit operator bool` is the right way to write a "is this valid" conversion: usable in `if (p)`, not usable in `int x = p;` or `p + 1`.

Zero (of any arithmetic type), null pointers, and null member pointers convert to `false`; everything else to `true`. Note `0.0` and `-0.0` are both `false`; NaN is **`true`** (it's not equal to zero).

The classic safe-bool idiom (pre-C++11: returning a pointer-to-member to avoid `if (stream1 == stream2)` compiling) is now obsolete — `explicit operator bool` does it properly. `std::optional`, `std::unique_ptr`, `std::function`, and the iostreams all use it.

Trap: `explicit operator bool` still permits comparisons *through* the conversion in contextual positions, and it makes `!!x` and `static_cast<bool>(x)` valid. It does not permit `x == true`.

### Null pointers: `NULL` vs `0` vs `nullptr`

```cpp
void f(int);
void f(char*);
f(0);        // calls f(int)      — 0 is an int
f(NULL);     // calls f(int) on most implementations (NULL is 0 or 0L) — ambiguous at best
f(nullptr);  // calls f(char*)    — unambiguous
```

`nullptr` has type `std::nullptr_t`, which:
- Converts implicitly to **any** pointer or pointer-to-member type.
- Does **not** convert to any integral type (so it can't be mistaken for `0`).
- Converts to `bool` (only in direct-initialization / contextual conversion contexts).

`NULL` is a macro — `0` in C++, or `__null` (a GCC extension that at least warns), or `((void*)0)` in C (which is *invalid* in C++, since `void*` doesn't implicitly convert to `T*`). Always `nullptr` in new code.

Template deduction is another reason: `template<class T> void g(T*)` cannot deduce from `0` or `NULL` (they deduce as `int`), but deduces fine from `nullptr` cast to a type, and `std::nullptr_t` is a real, deducible type.

### Null pointers themselves

- A null pointer is not required to be all-zero bits at the hardware level (the standard only requires the *literal* `0` to convert to it), though it is on every mainstream platform. `memset`-ing a struct of pointers to zero is therefore technically not guaranteed to produce null pointers, in practice always does, and is exactly the kind of pedantry to mention only once.
- **Dereferencing null is UB, not a guaranteed crash.** The optimizer assumes it doesn't happen, which produces the famous class of bugs where a null check *after* a dereference is deleted:
  ```cpp
  int v = p->x;          // compiler: p is non-null (else UB)
  if (!p) return -1;     // therefore this is dead code → removed
  ```
  This is the CVE-2009-1897 Linux kernel pattern. `-fno-delete-null-pointer-checks` exists for kernels; application code should just not dereference before checking.
- Arithmetic on null is UB (except `nullptr + 0`, made valid in C++20). Comparing unrelated pointers with `<` is unspecified; with `==` it is well-defined.
- **The "one-past-the-end" pointer** is valid to form and compare, but not to dereference — the foundation of `end()` iterators.

---

## 2.12 `const` and `volatile` Qualification

### `const`

`const` means **"this access path may not be used to modify."** It is a property of the *access path*, not necessarily of the object.

```cpp
int i = 0;
const int& r = i;   // r cannot modify, but i can change through other paths
i = 5;              // legal; r now reads 5
```

**Right-to-left reading is the reliable way to parse declarations:**
```cpp
const int* p;        // p: pointer to const int      — can retarget, can't write *p
int const* p;        // identical (prefer this form for consistency)
int* const p;        // p: const pointer to int      — can write *p, can't retarget
const int* const p;  // both
```

**Top-level vs low-level `const`** is the distinction that makes template deduction (§2.16) comprehensible: top-level const qualifies the object itself (`int* const`), low-level const qualifies what's pointed to (`const int*`). Top-level const is dropped in by-value deduction and by-value copies; low-level const is not, and is required to be preserved by conversions (you may add low-level const implicitly, never remove it).

**Modifying an object that was *declared* const is UB**, even via `const_cast`:
```cpp
const int  ci = 5;   int* p = const_cast<int*>(&ci);  *p = 6;   // UB
      int  i  = 5;   const int* cp = &i;  *const_cast<int*>(cp) = 6;   // legal
```
Declared-const objects may live in read-only memory (`.rodata`) and the compiler may constant-fold reads of them. `const_cast` is legitimate only for stripping const from a pointer/reference to a non-const object — i.e. adapting to a legacy API that isn't const-correct.

**`mutable`** exempts a member from a `const` member function's restriction — the correct tool for caches, memoization, and mutexes, since those don't change *logical* (observable) state. This is the **physical vs logical constness** distinction, a standard interview question.

**`const` and thread safety:** the standard library requires that `const` member functions be safe to call concurrently. `const` therefore effectively means "thread-safe to read," which is why a `mutable std::mutex` member is idiomatic and why a `mutable` cache without synchronization in a `const` method is a bug.

**`constexpr` vs `const`:** `const` = read-only through this path, possibly initialized at runtime. `constexpr` = usable in constant expressions, computed at compile time when the context demands. `constexpr` implies `const` on variables. `constinit` (C++20) = guaranteed *static* (compile-time) initialization without implying const — for mutable globals you need free of the initialization-order fiasco.

### `volatile`

`volatile` tells the compiler: **every read and write is an observable side effect; do not add, remove, reorder, or cache them.**

Legitimate uses, and there are only three:
1. **Memory-mapped I/O registers** — reading twice really is different from reading once.
2. **Variables modified by a signal handler** — specifically `volatile std::sig_atomic_t`.
3. `setjmp`/`longjmp`-live locals.

**`volatile` is not for threads.** It provides no atomicity (`v++` is still a non-atomic RMW), no memory ordering with respect to *other* variables, and no protection against tearing. Use `std::atomic`. This is one of the most reliably asked "do you actually understand this" questions, and the answer is: `volatile` constrains the *compiler* only; concurrency requires constraining the *hardware* too, which is what atomics' memory ordering does. (Java's `volatile` does mean the thread thing — a common source of confusion for Java-background candidates.)

Note also: `volatile` does not prevent the compiler from reordering volatile accesses relative to *non-volatile* ones, and most `volatile` compound operations were deprecated in C++20 (`v += 1`, `v++`) precisely because they read as atomic but aren't.

---

## 2.13 References

A reference is an **alias** for an existing object. Formally the standard says whether a reference occupies storage is unspecified; in practice a reference that must be materialized is a pointer, and one that can be resolved statically costs nothing.

| | Reference | Pointer |
|---|---|---|
| Null | Impossible (a null reference is UB to form) | `nullptr` is a normal value |
| Reseat | Never — assignment assigns *through* it | Freely |
| Initialization | Mandatory at declaration | Optional |
| Arithmetic | None | Yes |
| Syntax | Value syntax (`r.f()`) | `->`, `*` |
| Arrays of them | Illegal | Fine |

Because references cannot be null or reseated, they express "definitely refers to something, for its whole life" — use them for function parameters and returns where the callee doesn't take ownership and null is not a valid input. Use pointers (or `std::optional<T&>`-alikes, `T*`, `std::reference_wrapper`) when null/rebinding is meaningful. `std::reference_wrapper` exists because you can't put raw references in containers.

### Lvalue vs rvalue references and lifetime extension

```cpp
T&  lref = t;                       // binds lvalues
const T& cref = makeT();            // binds anything, INCLUDING temporaries
T&& rref = makeT();                 // binds rvalues (and xvalues)
```

**Lifetime extension:** binding a temporary to a `const T&` or a `T&&` extends the temporary's lifetime to the lifetime of the reference. Crucial limits:

- It does **not** apply through a function return. `const std::string& bad() { return std::string("x"); }` dangles.
- It does **not** apply to a reference *member* initialized in a constructor's member-init-list — the temporary dies at the end of the constructor. This is the standard `std::string_view`/`const T&` member dangling bug.
- It applies once, to the *first* reference the temporary binds to; passing that reference onward doesn't re-extend.
- **`auto&& ref = f().g();`** dangles if `g()` returns a reference into a temporary — one of the top C++ gotchas, and the reason range-`for` over `f().items()` was fixed only in C++23 (P2718).

```cpp
for (auto x : getObject().getVector())   // pre-C++23: temporary Object destroyed
                                          // before the loop body runs → UB
```

### Forwarding (universal) references

`T&&` where `T` is a **deduced** template parameter is not an rvalue reference — it's a *forwarding reference*, and **reference collapsing** governs it:

```
T& &   → T&        T& &&  → T&
T&& &  → T&        T&& && → T&&      ("lvalue wins")
```
So `f(lvalue)` deduces `T = U&` giving `U& &&` → `U&`; `f(rvalue)` deduces `T = U` giving `U&&`. `std::forward<T>(x)` uses exactly this to restore the original value category. `auto&&` is a forwarding reference too. A `T&&` in a *non-deduced* context (a member of a class template, or `std::vector<int>&&`) is a plain rvalue reference — the distinction is exactly whether deduction occurs.

Remember: **a named rvalue reference is an lvalue.** Inside `void f(T&& x)`, `x` is an lvalue; you must `std::move(x)` to pass it along as an rvalue. This is why `std::move` exists at all — it is just a `static_cast<T&&>` that costs nothing and moves nothing.

---

## 2.14 Pointers and Arrays

An array is **not** a pointer. `int a[10]` is an object of type `int[10]` with `sizeof(a) == 40`; a pointer is a separate object holding an address.

```cpp
int a[10];
sizeof(a)    // 40
int* p = a;  // decay (§2.15)
sizeof(p)    // 8
&a           // int(*)[10] — pointer to array, NOT int**
&a + 1       // advances 40 bytes
a + 1        // advances 4 bytes
```

The confusion arises from two facts: arrays decay to pointers in most contexts, and `a[i]` is *defined* as `*(a + i)` — which is commutative, so `3[a]` is legal C++ and a favorite trick question.

### Pointer arithmetic rules

Arithmetic is in units of the pointee type, and is **only defined within a single array object** (a scalar counts as an array of one), plus the one-past-the-end position. Computing (not just dereferencing) a pointer beyond that range is UB, which is why the optimizer may assume `p + n >= p` for a valid `p` and non-negative `n`, and why overflow checks written as pointer comparisons get deleted.

Subtracting pointers yields `ptrdiff_t` and is only defined within the same array.

### Multidimensional arrays

`int m[3][4]` is an array of 3 arrays of 4 `int` — **contiguous**, row-major, `sizeof == 48`. It decays to `int(*)[4]`, not `int**`. You cannot pass it to a function taking `int**`, and this incompatibility is the origin of endless C interop pain. A dynamically allocated "2D array" as `int**` is an array of pointers — a different memory layout with an extra indirection and worse locality.

### Modern replacements

| Instead of | Use |
|---|---|
| `T a[N]` local | `std::array<T,N>` — knows its size, no decay, copyable, works with algorithms |
| `T* p; size_t n;` parameter pair | `std::span<T>` (C++20) — non-owning view with bounds |
| `new T[n]` | `std::vector<T>` |
| C string `char*` | `std::string_view` / `std::string` |
| `int m[3][4]` | `std::mdspan` (C++23) for views, `std::vector` + index math for storage |

`std::span` is the single most valuable one for interviews: it eliminates the decay problem at API boundaries while remaining zero-overhead (pointer + size, passed in two registers). Its danger is the same as `string_view`'s: it's non-owning, so `std::span<int> s = getVector();` dangles.

### Pointers to members, function pointers

`int C::*` (pointer to data member) is an *offset*, not an address; `void (C::*)()` (pointer to member function) is typically a fat pointer (function address + `this`-adjustment + virtual flag), so `sizeof` can be 8, 16, or more, especially with multiple/virtual inheritance on MSVC. They do not convert to `void*`. Syntax: `(obj.*pm)()`, `(ptr->*pm)()`.

### Aliasing

**Strict aliasing:** an object may only be accessed through an lvalue of its own type, a cv-qualified version, a signed/unsigned variant, or **`char`/`unsigned char`/`std::byte`**. Violating it (the classic `*(float*)&someInt` type pun) is UB, and GCC/Clang at `-O2` genuinely miscompile it.

The correct tools: `std::bit_cast` (C++20, constexpr, zero-cost), or `memcpy` (which every compiler recognizes and optimizes to a register move). `-fno-strict-aliasing` is the escape hatch the Linux kernel uses. A union type-pun is legal in C, and formally UB in C++ (reading the non-active member), though GCC and Clang both support it as a documented extension.

---

## 2.15 Array-to-Pointer and Function-to-Pointer Decay

**Decay** is one of the *lvalue transformations* — implicit conversions applied when a value is needed rather than the object itself.

| Transformation | Effect |
|---|---|
| Array-to-pointer | `T[N]` → `T*` (pointer to first element) |
| Function-to-pointer | `R(Args...)` → `R(*)(Args...)` |
| Lvalue-to-rvalue | Read the value out of an object |

### When arrays decay — and when they don't

Decay happens almost everywhere an array is used as a value: passing to a function, assigning to a pointer, arithmetic, comparison, ternary, template argument deduction **by value**.

It does **not** happen for:
- `sizeof(a)` — yields the array size
- `&a` — yields `T(*)[N]`
- Binding to a **reference** to array: `T (&r)[N]`
- `decltype(a)`
- String literal initializing a char array: `char s[] = "hi";` (copies, `sizeof == 3`)
- Range-`for` (which uses `begin`/`end`, and for raw arrays those are defined via the array type)

### The parameter-decay trap

**Array parameters are always rewritten as pointers.** These three declarations are *identical*:
```cpp
void f(int a[10]);
void f(int a[]);
void f(int* a);
sizeof(a)   // inside f: 8, not 40. The size in the declaration is a lie.
```
This is why C-style APIs must always pass a length, and why the array-size bug is eternal. The fix that preserves size information:

```cpp
template <size_t N> void f(int (&a)[N]);         // N deduced, no decay
template <class T, size_t N>
constexpr size_t countof(T (&)[N]) { return N; }  // safe alternative to sizeof/sizeof
void f(std::span<int> a);                         // modern answer
```
Note `countof` written as a macro (`sizeof(a)/sizeof(a[0])`) silently returns `sizeof(ptr)/sizeof(elem)` when handed a decayed pointer — the template version is a compile error instead.

### Template deduction interaction

```cpp
template<class T> void byValue(T  x);   // int a[10] → T = int*   (decays)
template<class T> void byRef  (T& x);   // int a[10] → T = int[10] (no decay)
template<class T> void byRef  (T& x);   // "hello"   → T = const char[6]
```
This asymmetry is the mechanism behind `std::size`, `std::begin`/`std::end` for raw arrays, and the string-literal-length trick `template<size_t N> constexpr size_t len(const char (&)[N]) { return N-1; }`.

Also: `auto` decays (it uses by-value deduction rules), so `auto x = someArray;` gives a pointer, while `auto& x = someArray;` gives a reference to array. Same for function names: `auto f = someFunction;` gives a function *pointer*.

### Function-to-pointer decay

A function name used as a value becomes a pointer. `&f`, `f`, and `*f` all yield the same function pointer (dereferencing a function pointer gives a function, which decays again). Overloaded function names don't decay until the target type disambiguates them, which is why `std::for_each(b, e, std::toupper)` is ambiguous but `static_cast<int(*)(int)>(std::toupper)` works. Lambdas without captures also convert to function pointers, via a conversion operator, which is how they interoperate with C callbacks.

---

## 2.16 `auto` Type Deduction

`auto` uses **template argument deduction** rules (with one exception, below). Understanding it is understanding `template<class T> void f(T param)`.

### Three cases

**Case 1 — `auto` by value (or `auto*`): strips references, `const`/`volatile` (top-level), and decays arrays/functions.**
```cpp
const int  ci = 0;   auto a = ci;      // int      (const dropped)
const int& cr = ci;  auto b = cr;      // int      (ref and const dropped)
int arr[5];          auto c = arr;     // int*     (decay)
void fn(int);        auto d = fn;      // void(*)(int)
const char* const p = "x"; auto e = p; // const char*  (top-level const dropped,
                                       //               low-level const kept)
```

**Case 2 — `auto&` / `const auto&`: keeps everything, no decay.**
```cpp
const int  ci = 0;   auto& f = ci;     // const int&
int arr[5];          auto& g = arr;    // int(&)[5]
```

**Case 3 — `auto&&`: forwarding reference, reference collapsing applies.**
```cpp
int x = 0;
auto&& h = x;        // int&   (lvalue)
auto&& i = 42;       // int&&  (rvalue)
```

### The braced-init-list exception

This is the one place `auto` and template deduction disagree:
```cpp
auto x1 = 27;      // int
auto x2{27};       // int  (C++17; was std::initializer_list<int> in C++11/14)
auto x3 = {27};    // std::initializer_list<int>  — still, in all versions
auto x4 = {1,2,3}; // std::initializer_list<int>
template<class T> void f(T);
f({1,2,3});        // ERROR — templates never deduce initializer_list
```
C++17's N3922 fixed direct-init `auto x{27}`; copy-list-init `auto x = {27}` remains an `initializer_list`. Expect to be asked this.

### Where `auto` appears

- Variables, including `constexpr auto`.
- **Return type deduction** (C++14): `auto f() { return expr; }` — uses Case 1 rules, so it *strips references*; use `decltype(auto)` (§2.17) or a trailing return type if you mean to return a reference. Multiple `return` statements must deduce the same type. Recursive functions need at least one non-recursive return first. Also, a function with a deduced return type cannot be forward-declared usefully — the definition must be visible, which pushes it into headers.
- **Trailing return types**: `auto f(T a, U b) -> decltype(a + b)` — needed pre-C++14 and still needed when the return type depends on parameters.
- **Generic lambdas** (C++14): `[](auto x){}` — sugar for a templated `operator()`.
- **Abbreviated function templates** (C++20): `void f(auto x)` ≡ `template<class T> void f(T x)`.
- **`auto` non-type template parameters** (C++17): `template<auto V> struct S;`.
- **CTAD** interacts: `auto v = std::vector{1,2,3};`.

### Why and when to use it

Arguments for: impossible-to-spell types (lambdas, iterators, template expression types), guaranteed initialization (`auto x;` doesn't compile), avoiding **silent conversions**:
```cpp
std::unordered_map<K,V> m;
for (const std::pair<K,V>& p : m)     // BUG: elements are pair<const K,V>
                                      // → a temporary copy per iteration, and `&p`
                                      // binds to it, so mutations are lost
for (const auto& p : m)               // correct, no copies
```
That example is the strongest practical argument for `auto` and a frequent interview question.

Arguments against: loss of documentation at API boundaries, and `auto` hiding an expensive copy or a proxy type. The proxy trap:
```cpp
std::vector<bool> v;
auto b = v[0];        // std::vector<bool>::reference, NOT bool — dangles if v dies
auto b = bool(v[0]);  // "explicitly typed initializer idiom"
```
Same problem with Eigen and other expression-template libraries.

Guidance ("Almost Always Auto" vs "auto sparingly") is a genuine style split; the defensible answer in an interview is: always for iterators/lambdas/template-heavy code, explicit types where the concrete type is load-bearing documentation or where a proxy/conversion could hide.

---

## 2.17 `decltype` and `decltype(auto)`

`decltype` yields the **declared type** of an entity or the type-plus-value-category of an expression. Unlike `auto`, it does not decay, does not strip const, and does not strip references.

### The two rules — the whole question

1. If the operand is an **unparenthesized id-expression** (a variable name, a class member access), the result is that entity's **declared type**, exactly.
2. Otherwise, for any other expression of type `T`:
   - prvalue → `T`
   - lvalue → **`T&`**
   - xvalue → `T&&`

```cpp
int  x = 0;
const int cx = 0;
int& rx = x;
int arr[5];

decltype(x)     // int
decltype(cx)    // const int      (const preserved — unlike auto)
decltype(rx)    // int&           (reference preserved)
decltype(arr)   // int[5]         (no decay)
decltype((x))   // int&   ← ! parentheses make it an expression; x is an lvalue
decltype(x+1)   // int    (prvalue)
decltype(std::move(x))  // int&&  (xvalue)

struct S { int m; };
S s;
decltype(s.m)   // int    (rule 1 — member access is an id-expression)
decltype((s.m)) // int&   (rule 2)
```

**`decltype((x))` being `int&` is the single most-asked `decltype` question.** The lesson generalizes: extra parentheses change the meaning.

### `decltype(auto)` (C++14)

Deduce using `decltype` rules applied to the initializer, rather than `auto`/template rules. Its purpose is **perfect return-type forwarding**:

```cpp
template<class Container, class Index>
decltype(auto) at(Container&& c, Index i) {
    return std::forward<Container>(c)[i];   // preserves T& / T&& / T exactly
}
// with `auto` return, operator[]'s reference would be stripped → returns a copy,
// so `at(v, 0) = 10;` would fail to compile (or worse, modify a temporary)
```

Also useful for variables that must exactly mirror an expression's type: `decltype(auto) v = expr;`.

**The dangerous asymmetry:**
```cpp
decltype(auto) f() { int x = 0; return x;   }  // int   — fine
decltype(auto) g() { int x = 0; return (x); }  // int&  — DANGLING reference to a local
```
Adding parentheses to a return statement silently changes the return type and creates UB. Compilers warn (`-Wreturn-local-addr`), but this is exactly why `decltype(auto)` is a specialist tool, not a default.

### `decltype` in unevaluated contexts

`decltype`'s operand is **unevaluated**: no code runs, no side effects, and the function need not even be defined. This makes it the backbone of SFINAE and trait detection:

```cpp
template<class T>
auto has_size(int) -> decltype(std::declval<T>().size(), std::true_type{});
template<class T>
auto has_size(...) -> std::false_type;
```
`std::declval<T>()` produces a `T&&` "value" in unevaluated contexts without requiring a constructor — it's declared but never defined, so using it in evaluated code is a link error by design.

In C++20, **concepts** (`requires { t.size(); }`) replace most of this, but `decltype` remains essential for return types, trailing return types, and expression-type queries.

### Comparison

| | `auto` | `decltype(expr)` | `decltype(auto)` |
|---|---|---|---|
| Top-level const | Stripped | Preserved | Preserved |
| References | Stripped | Preserved | Preserved |
| Array/function decay | Yes | No | No |
| Needs an initializer | Yes | No (works on any expression) | Yes |
| Parenthesis-sensitive | No | **Yes** | **Yes** |

---

## 2.18 Explicit C++ Casts

C++ replaced the C cast with four named casts. The point is *searchability, intent, and restricted power* — a C-style cast can silently perform a `const_cast` when you meant a `static_cast`, and `grep` cannot find it.

### `static_cast<T>(e)`

Compile-time-checked conversions with a defined relationship: numeric conversions, `void*`→`T*`, enum↔integer, derived→base (upcast) and base→derived (**downcast, unchecked**), lvalue→rvalue (`std::move` is `static_cast<T&&>`), invoking explicit constructors and conversion operators, and `T`→`void` to discard.

```cpp
static_cast<int>(3.7)            // 3, truncation
static_cast<Derived*>(basePtr)   // NO runtime check — UB if it isn't a Derived
static_cast<void*>(p)            // fine
```
The downcast is the trade-off: faster than `dynamic_cast` (zero cost), unsafe if you're wrong. Use it only when you have an invariant guaranteeing the type (e.g. a type tag you checked, or CRTP).

`static_cast` cannot cast away const, cannot convert between unrelated pointer types, and cannot cross a virtual base going down.

### `dynamic_cast<T>(e)`

Runtime-checked conversion within a polymorphic hierarchy. Requires the source type to have **at least one virtual function** (so RTTI exists).

```cpp
if (auto* d = dynamic_cast<Derived*>(base)) { ... }   // nullptr on failure
Derived& r = dynamic_cast<Derived&>(*base);           // throws std::bad_cast
```
Also does **cross-casts** (sibling to sibling through a common complete object) and `dynamic_cast<void*>(p)` to get the address of the most-derived object — neither of which `static_cast` can do.

Cost: a runtime walk of the type_info graph, typically tens to hundreds of nanoseconds, and it can be pathological with deep/multiple inheritance. Requires RTTI to be enabled (`-fno-rtti` breaks it — common in game engines and embedded, which then hand-roll type tags). Cross-module RTTI identity issues from Ch. 1 §1.12 apply. Frequent `dynamic_cast` in hot code is usually a design smell pointing at a missing virtual function or a `std::variant`.

### `const_cast<T>(e)`

The **only** cast that can add or remove `const`/`volatile`. Legitimate use: passing to a legacy API that isn't const-correct, when the underlying object is genuinely non-const. Modifying a genuinely-const object through it is UB (§2.12). Also used in the "const-overload deduplication" idiom:
```cpp
const T& at(size_t i) const { /* real implementation */ }
      T& at(size_t i)       { return const_cast<T&>(std::as_const(*this).at(i)); }
```

### `reinterpret_cast<T>(e)`

Reinterprets bits. Almost nothing is guaranteed except pointer↔`uintptr_t` round-trips and `T*`→`U*`→`T*` round-trips. It does **not** make the resulting access legal: reading through the new type usually violates strict aliasing (§2.14). For type punning use `std::bit_cast` or `memcpy`; for pointer round-trips through integers use `uintptr_t`; for object-representation access use `unsigned char*`/`std::byte*` (the aliasing-exempt types).

Cannot cast away const — that's `const_cast`'s exclusive job, which is precisely the safety split C-style casts destroy.

### `std::bit_cast<To>(from)` (C++20)

Reinterpret the object representation with the same size, both types trivially copyable. `constexpr`, UB-free, compiles to nothing. This is the correct answer for `float`↔`uint32_t` punning and it obsoletes the union trick.

### C-style and functional casts

`(T)e` tries, in order: `const_cast`, `static_cast`, `static_cast + const_cast`, `reinterpret_cast`, `reinterpret_cast + const_cast`. It can therefore silently do a `reinterpret_cast` when your intended `static_cast` fails to compile after a refactor — the exact failure mode named casts exist to prevent. `T(e)` (functional notation) is the same thing, except with a single argument it's identical to a C cast, while `T{e}` is list-initialization and **prohibits narrowing** — which makes `T{e}` the safest "convert" syntax when you want narrowing to be a compile error.

**Summary of powers:**

| Cast | Const | Type change | Runtime check | Typical cost |
|---|---|---|---|---|
| `static_cast` | No | Related types | No | 0 (or a pointer adjust) |
| `dynamic_cast` | No | Polymorphic, down/cross | **Yes** | RTTI lookup |
| `const_cast` | **Yes** | No | No | 0 |
| `reinterpret_cast` | No | Anything | No | 0 (and UB-prone) |
| `bit_cast` | No | Same-size trivially-copyable | No | 0 |
| C-style | Yes | Anything | No | Whatever it silently chose |

---

## Key Interview Questions

1. **Why is `for (size_t i = v.size() - 1; i >= 0; --i)` an infinite loop, and what does `-1 < 1u` evaluate to?** — Unsigned wraparound and the usual arithmetic conversions converting the signed operand.
2. **Why is signed overflow UB and unsigned overflow defined? What does that buy the optimizer?** — Loop-bound reasoning, induction-variable widening, algebraic folding; unsigned must preserve wrapping so it can inhibit optimization.
3. **What does `uint8_t a = 200, b = 100; a + b` produce, and of what type?** — `int`, 300; integral promotion happens before the addition.
4. **Why does `0.1 + 0.2 != 0.3`, and how should you compare floats?** — Binary representation of decimal fractions; relative+absolute epsilon or ULP comparison, never `==`.
5. **What is a subnormal and why can it destroy performance?** — Gradual underflow with the implicit bit cleared; microcode assists costing ~100× on some hardware; FTZ/DAZ as the (non-conformant) fix.
6. **Explain NaN's comparison semantics. Why is sorting a range containing NaN undefined behavior?** — Unordered with everything including itself; breaks strict weak ordering, and introsort will run out of bounds.
7. **What exactly does `-ffast-math` break?** — Chiefly `-ffinite-math-only` deleting your `isnan` checks, plus reassociation changing results and process-wide FTZ/DAZ from a library's static init.
8. **`enum` vs `enum class`: name three concrete differences.** — Scoping, implicit integral conversion, and a defined default underlying type (hence forward-declarability).
9. **Why prefer `nullptr` over `NULL`/`0`?** — Overload resolution and template deduction; `nullptr_t` converts to pointers but not integers.
10. **Is `volatile` useful for multithreading?** — No: no atomicity, no ordering with respect to other objects. It constrains the compiler, not the hardware. Use `std::atomic`.
11. **What is the difference between physical and logical constness, and what is `mutable` for?** — Bitwise immutability vs observable immutability; `mutable` for caches and mutexes, and `const` implies thread-safe-to-read in the standard library.
12. **When does lifetime extension apply, and name two cases where it doesn't.** — Binding a temporary to `const&`/`&&`; not across a function return, not for reference members in a ctor init-list.
13. **What is a forwarding reference and how do reference collapsing rules work?** — `T&&` with deduced `T`; `& &`/`& &&`/`&& &` → `&`, `&& &&` → `&&`; "lvalue wins."
14. **`void f(int a[10])` — what is `sizeof(a)` inside `f`?** — 8 (a pointer); array parameters always decay, the bound is documentation only.
15. **What is `decltype((x))` when `x` is `int`, and why?** — `int&`; parentheses make it an expression, and lvalue expressions yield `T&`.
16. **When must you use `decltype(auto)` instead of `auto` for a return type?** — When the reference-ness and const-ness of the returned expression must be preserved, e.g. a forwarding `operator[]` wrapper.
17. **Why prefer named casts over C-style casts?** — Restricted power (a C cast may silently become a `reinterpret_cast` or `const_cast`), searchability, and explicit intent.
18. **How do you legally type-pun a `float` to a `uint32_t`?** — `std::bit_cast` or `memcpy`; `reinterpret_cast` violates strict aliasing and unions are formally UB in C++.
19. **Why is `std::string::size()` not the number of characters?** — It counts code units (bytes); code points and grapheme clusters are different things and the standard library models neither.

---

## Common Traps

- **Mixing signed and unsigned in comparisons** — `-1 < 1u` is false; `v.size() - 1` on an empty vector is `SIZE_MAX`.
- **Assuming small types wrap** — `uint8_t + uint8_t` is `int` arithmetic; `unsigned short * unsigned short` can be *signed* overflow UB.
- **Post-hoc overflow checks** (`a + b < a`) being optimized away.
- **`INT_MIN / -1`** → SIGFPE, and `abs(INT_MIN)` → UB.
- **`1 << 31`** on 32-bit `int` is UB; shift counts ≥ width are UB, not zero.
- **Comparing floats with `==`**, or using a fixed absolute epsilon at all magnitudes.
- **Assuming FP addition is associative** — parallel reductions won't reproduce.
- **`std::numeric_limits<T>::min()`** is the smallest *positive normal* for floats, not the most negative — use `lowest()`.
- **NaN in `std::sort`, `std::map`, or a `std::max` chain.**
- **`-ffast-math` in a library changing process-wide FP flags** and deleting NaN checks.
- **`std::cout << int8_t(65)`** prints `A`.
- **Assuming `char` is signed** (it isn't on ARM), or passing a negative `char` to `std::toupper` (UB).
- **`long` being 64-bit on Linux and 32-bit on Windows.**
- **Unscoped enums leaking enumerators** and implicitly converting to `int`.
- **`NULL` in an overload set** resolving to the integer overload.
- **Dereferencing before null-checking**, letting the optimizer delete the check.
- **`volatile` used as a threading primitive.**
- **`const_cast` + modification of a genuinely-const object.**
- **Dangling from lifetime-extension gaps** — returned `const&`, reference members, `auto&& x = f().g()`, pre-C++23 range-for over a temporary's subobject.
- **Named rvalue references are lvalues** — forgetting `std::move`/`std::forward`.
- **`sizeof(arr)/sizeof(arr[0])` on a decayed parameter.**
- **`int(*)[4]` vs `int**`** for 2D arrays.
- **`for (const std::pair<K,V>& p : map)`** silently copying every element.
- **`auto` capturing a proxy** (`std::vector<bool>::reference`, expression templates).
- **`auto x = {1};`** being an `initializer_list`.
- **`decltype(auto) f() { return (x); }`** returning a dangling reference.
- **C-style casts silently becoming `reinterpret_cast`.**

---

## Compact Recall Summary

**Sizes.** Only minimums and ordering are guaranteed. `long` = 64 on LP64, 32 on LLP64 — never use it portably. `char`'s signedness is implementation-defined. `<cstdint>` exact types are optional but universal; `int8_t` prints as a character.

**Conversions.** Promotion (`< int` → `int`) then UAC (float wins; else higher rank; else **unsigned wins at equal rank**). The unsigned-wins step is the root of most integer bugs. Defend with `-Wsign-conversion`, `std::ssize`, `std::cmp_*`.

**Overflow.** Signed = UB (enables optimization, defeats naive checks); unsigned = wraps mod 2ⁿ. Check *before* with `__builtin_*_overflow` or range pre-checks. `-fwrapv` / UBSan as escape hatches.

**IEEE 754.** sign/exponent/mantissa with an implicit leading 1; non-uniform density; ε ≈ 2.2e-16 for `double`; exact integers to 2⁵³. Not associative, correctly rounded per operation, `0.1` inexact. ±0 compare equal. Subnormals give gradual underflow at a ~100× performance cliff (FTZ/DAZ, non-conformant). NaN is unordered with itself — `x != x` is the test — and poisons sorts and reductions.

**Fast-math.** A bundle; `-ffinite-math-only` deletes NaN checks, `-fassociative-math` enables vectorized reductions, FTZ/DAZ is set process-wide at startup. Prefer per-flag, per-TU, or call-site (`std::reduce`) authorization.

**Text.** Code unit ≠ code point ≠ grapheme cluster. UTF-8 everywhere, convert at Windows boundaries; `char8_t` broke C++20 source compatibility; `<codecvt>` is deprecated/removed — use ICU or `simdutf`.

**Enums.** `enum class` gives scoping, no implicit int conversion, and `int` as the default underlying type. Fix the underlying type to enable forward declaration. No reflection; omit `default:` in switches to get warnings.

**Bool/null.** Contextual conversion honors `explicit operator bool`. `nullptr`/`nullptr_t` converts to pointers, never to integers — fixes overload resolution and deduction. Null deref is UB, so the optimizer deletes later null checks.

**cv.** `const` = this access path can't write; top-level vs low-level matters for deduction; modifying a declared-const object is UB; `mutable` for logical constness; `const` implies thread-safe-to-read. `volatile` = don't elide/reorder *this* access — MMIO and signal handlers only, never threading.

**References.** Alias, non-null, non-reseatable. `const&`/`&&` extend temporary lifetime, with critical exceptions (returns, ctor init-lists). `T&&` on a deduced `T` is a forwarding reference; collapsing makes lvalue win; a named rvalue reference is an lvalue.

**Arrays.** `T[N]` is a distinct type; decays in value contexts but not under `sizeof`, `&`, `decltype`, or reference binding. Function parameters always decay — the bound is a lie. Use `std::array`/`std::span`. Strict aliasing permits punning only via `char`/`unsigned char`/`std::byte`, `memcpy`, or `bit_cast`.

**Deduction.** `auto` = template by-value rules (strips ref/top-level-const, decays); `auto&` keeps everything; `auto&&` forwards. Braced-init is the one divergence. `decltype` preserves everything and is parenthesis-sensitive (`decltype((x))` is `T&`); `decltype(auto)` forwards return types exactly — and turns `return (x);` into a dangling reference.

**Casts.** `static_cast` (related, unchecked downcast), `dynamic_cast` (RTTI-checked, cross-casts, costs), `const_cast` (cv only), `reinterpret_cast` (bits, aliasing-hostile), `bit_cast` (the safe pun). C-style casts pick silently among them — that's the whole argument against them.

