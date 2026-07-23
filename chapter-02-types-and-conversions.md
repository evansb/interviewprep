# Chapter 2 — Types and Conversions

## 2.1 Why This Matters — Core

A low-latency program can execute the wrong operation at full speed because C++
quietly changed an operand's type first. A negative sequence delta compared with
an unsigned size becomes a large positive number. Two `std::uint8_t` values add
as `int`, not as bytes. An array parameter is really a pointer, so its bound has
already disappeared. `auto` may copy where `auto&` aliases. A floating-point
reduction may change both its answer and its latency after a compiler flag
permits reassociation.

These are not isolated tricks. They follow one governing model:

> Every expression has a type and a value category. Before an operator runs,
> C++ may transform and convert its operands. After it runs, another conversion
> may occur at the destination.

For interview code, predict those stages in order. For production code, make
domain boundaries explicit: validate before narrowing, choose signedness for
the algebra rather than for documentation, preserve bounds at interfaces, and
do not trade away floating-point semantics globally to improve one hot loop.

The standard specifies legal program behavior, not register sizes, instruction
counts, ABI layouts, or IEEE 754 support on every implementation. This chapter
states the language rule first and labels common implementation behavior where
it affects low-latency engineering. Its language ceiling is C++23.

## 2.2 The 90-Second Screen — Core

Five facts to retain:

1. Built-in integer widths are mostly minimum guarantees. Exact-width
   `std::intN_t` types exist only when the implementation provides a suitable
   type; `long` is commonly 64 bits under LP64 and 32 bits under LLP64.
2. Integral promotions happen before most arithmetic. A `char`, `short`, or
   small fixed-width alias commonly becomes `int`.
3. The usual arithmetic conversions choose a common operand type. Mixed
   signed/unsigned arithmetic can convert a negative value to unsigned before
   the operator runs.
4. Signed integer overflow is undefined behavior. Unsigned arithmetic is
   modulo \(2^N\). A narrowing conversion is a different operation from
   overflow and must be analyzed separately.
5. By-value `auto` drops references and top-level cv-qualification and decays
   arrays/functions. `decltype` preserves more information and is sensitive to
   parentheses.

Two decisions to defend:

- Use a type whose range and algebra match the domain. Exact-width integers are
  appropriate for wire formats and defined bit layouts; they are not a blanket
  replacement for `int`, `std::size_t`, or a strong domain type.
- At an interface, preserve the facts the callee needs. Prefer `std::span` to a
  naked pointer when bounds matter, `nullptr` to integer null constants, and a
  checked conversion to an unexplained narrowing cast.

## 2.3 Core Mental Model: Predict the Expression in Five Steps — Core

For an expression such as `lhs + rhs`, use this procedure:

```text
declared operands
      |
      v
value transformations
(lvalue-to-rvalue, array/function decay when applicable)
      |
      v
promotions
(small integers and some enums)
      |
      v
common type
(usual arithmetic conversions for many binary operators)
      |
      v
operation in that type
      |
      v
destination conversion
(initialization, assignment, argument, return)
```

Do not jump directly from source spelling to result. Consider:

```cpp
#include <cstdint>
#include <type_traits>

int main() {
    std::uint8_t bid = 250;
    std::uint8_t add = 10;

    auto sum = bid + add;
    static_assert(std::is_same_v<decltype(sum), int>);

    std::uint8_t stored = sum;
    return stored; // 4 on an implementation that provides uint8_t
}
```

`bid` and `add` are lvalues. Lvalue-to-rvalue conversion reads them, then both
undergo integral promotion. On implementations that provide `std::uint8_t`,
`int` can represent all of its values, so both promote to `int`. Addition
produces the `int` value 260. Only initialization of `stored` converts that
value to `std::uint8_t`; because the destination is an unsigned 8-bit type, the
result is congruent to 260 modulo 256, namely 4.

The operation itself did not overflow. This distinction—operand conversion,
operation, destination conversion—is the highest-yield mental habit in the
chapter.

| Stage | Question | Common interview trap |
|---|---|---|
| Source type | What are the exact types and cv/ref qualifiers? | Assuming an alias name implies unique behavior |
| Transformation | Is a value read, or does an array/function decay? | Calling an array parameter an array |
| Promotion | Does a small integer become `int`? | Expecting byte arithmetic |
| Common type | Which operand converts, and to what? | Comparing a negative `int` with `size_t` |
| Destination | Is the result narrowed, copied, or bound? | Blaming the operator for assignment truncation |

## 2.4 The Type System and Type Categories — Core

C++ types determine which expressions are valid, how objects are represented,
which conversions are available, and which operations have defined behavior.
The compiler performs most type checking at translation time. At run time,
ordinary built-in values generally carry no universal type tag; RTTI for
polymorphic classes is a separate facility, and its representation is an ABI
choice.

A useful map combines the standard's fundamental/compound taxonomy with the
object/function/reference distinction:

```text
types
├── fundamental
│   ├── void
│   ├── nullptr_t
│   └── arithmetic
│       ├── integral: bool, character, signed/unsigned integers
│       └── floating-point
└── compound
    ├── references                    (not object types)
    ├── function types                (not object types)
    ├── pointers and member pointers  (object types)
    ├── arrays                        (object types)
    ├── enumerations                  (object types)
    └── classes/unions                (object types)

cv-qualification may produce cv-qualified variants where the rules permit it.
```

References are types but are not object types: a reference denotes another
object or function. Functions also are not objects. This matters because
operations such as `sizeof`, object storage, object lifetime, `void*`
conversion, and arrays of elements are defined in terms of object types.

Several orthogonal classifications answer different questions:

| Classification | Meaning | Why it matters |
|---|---|---|
| Complete/incomplete | Whether size and layout are known at that point | A pointer to an incomplete class is valid; an object of it is not |
| Scalar | Arithmetic, enum, pointer, pointer-to-member, or `nullptr_t` | Many initialization and zero-initialization rules group these |
| Trivially copyable | Bytes may be copied with `memcpy` and restored under the rules | Enables serialization building blocks, not automatic wire portability |
| Standard-layout | Meets layout restrictions intended for interoperation | Does not eliminate padding or define an ABI |
| Literal type | Can participate in constant evaluation under its rules | Enables `constexpr` objects and compile-time work |

```cpp
#include <type_traits>

struct Quote;

using Handler = void(int);          // function type
using HandlerPtr = void (*)(int);   // object type: a pointer

static_assert(std::is_function_v<Handler>);
static_assert(std::is_object_v<HandlerPtr>);
static_assert(std::is_object_v<Quote*>);
static_assert(!std::is_object_v<Quote&>);
```

The source type does not by itself promise a cost. A reference parameter may be
implemented as a pointer under a common ABI, optimized into a register, or
eliminated entirely. A small class may be passed in registers or memory.
Inspect the target ABI and generated code when those details affect latency.

## 2.5 Fundamental Types and Fixed-Width Integers — Core

C++ defines minimum ranges and relative size ordering for its built-in integer
types. A byte is `CHAR_BIT` bits and `sizeof(char) == 1`; `CHAR_BIT` is at least
8. The standard does not require every byte to be eight bits.

| Type | Standard minimum range or property | Common 64-bit desktop/server width |
|---|---|---|
| `bool` | values `false` and `true` | 8 bits of storage, ABI-dependent |
| `char`, `signed char`, `unsigned char` | at least 8 bits; three distinct types | 8 |
| `short` / `unsigned short` | at least 16 bits | 16 |
| `int` / `unsigned int` | at least 16 bits | 32 |
| `long` / `unsigned long` | at least 32 bits | 64 in LP64; 32 in LLP64 |
| `long long` / unsigned counterpart | at least 64 bits | 64 |
| `float`, `double`, `long double` | implementation-defined formats meeting minimum requirements | commonly IEEE binary32/binary64; `long double` varies |

The required ordering is:

```text
sizeof(char) <= sizeof(short) <= sizeof(int)
             <= sizeof(long) <= sizeof(long long)
```

The signedness of plain `char` is implementation-defined. Use `char` for narrow
text/code units, `signed char` or `unsigned char` for explicitly signed small
integers, and `std::byte` when the value is raw storage rather than a number.
`std::byte` supports bitwise operations but not ordinary arithmetic, which
makes byte-oriented intent visible.

`<cstdint>` provides families for different contracts:

| Family | Contract | Typical use |
|---|---|---|
| `std::intN_t`, `std::uintN_t` | Exactly N bits, no padding; optional | Protocol fields, specified object representation |
| `std::int_leastN_t` | Narrowest available type with at least N bits | Portability where minimum range matters |
| `std::int_fastN_t` | Implementation's fastest type with at least N bits | Rarely choose without measurement |
| `std::intmax_t`, `std::uintmax_t` | Widest signed/unsigned integer type | Generic integer conversion code |
| `std::intptr_t`, `std::uintptr_t` | Optional integer type able to round-trip `void*` | Low-level pointer representation work |
| `std::size_t` | Unsigned type of `sizeof` and object sizes | Sizes and standard-library interfaces |
| `std::ptrdiff_t` | Signed result type of pointer subtraction | Distances within one array |

Exact width does not specify endianness, alignment, structure padding, calling
convention, or wire byte order. A struct made only of `std::uint32_t` members is
still not automatically a portable packet format.

Use `int` for ordinary local arithmetic when its range is sufficient. Use an
exact-width type when width is part of the invariant. Use `std::size_t` where
the standard library requires it, but do not let that force a domain quantity
such as a signed price delta to become unsigned.

## 2.6 Literals and Literal Types — Core

A literal's spelling determines its type before contextual conversions occur.
Wrong literal types can therefore change the entire usual-arithmetic-conversion
path.

| Spelling | Type selection |
|---|---|
| `42` | First fitting type among `int`, `long`, `long long` |
| `42u`, `42U` | First fitting unsigned candidate beginning with `unsigned int` |
| `42L`, `42LL` | Candidate sequence begins with `long` or `long long` |
| Decimal unsuffixed too large | Tries signed candidates; ill-formed if none fit |
| Hex/octal/binary unsuffixed | Candidate sequence also includes unsigned types |
| `3.14` / `3.14f` / `3.14L` | `double` / `float` / `long double` |
| `'A'`, `u8'A'`, `u'A'`, `U'A'`, `L'A'` | `char`, `char8_t`, `char16_t`, `char32_t`, `wchar_t` |
| `"A"`, `u8"A"` | arrays of `const char` and `const char8_t`, including a null terminator |
| `true`, `false`, `nullptr` | `bool`, `bool`, `std::nullptr_t` |

Digit separators and bases improve reviewability without changing type:

```cpp
constexpr auto mask = 0b1111'0000u;
constexpr auto timeout_ns = 2'000'000LL;
static_assert(mask == 240u);
```

Use a suffix that expresses the arithmetic you intend, not merely the storage
destination. For a mask, `1u << bit` avoids signed-left-shift problems provided
`bit` is in range for `unsigned int`. For a `std::uint64_t` constant, the
portable macro `UINT64_C(...)` exists because `unsigned long` and
`unsigned long long` differ across data models. `std::uint64_t{value}` provides
an explicit checked-at-compile-time brace conversion for a constant expression.

List initialization rejects narrowing that ordinary assignment accepts:

```cpp
double ratio = 3;        // value-preserving conversion
int truncated = 3.9;     // valid, value becomes 3
// int rejected{3.9};    // ill-formed: narrowing in list-initialization
```

A **literal type** is a type that can have values used in constant expressions
when the other constant-evaluation requirements are met. Arithmetic, pointer,
reference, enumeration, and suitably defined class types can be literal types.
The term does not mean “a type that has a built-in token literal.”

```cpp
#include <compare>
#include <cstdint>

struct Price {
    std::int64_t ticks;
    constexpr auto operator<=>(const Price&) const = default;
};

constexpr Price bid{12'345};
static_assert(bid.ticks > 0);
```

Constant evaluation can remove run-time work, but `constexpr` is primarily a
semantic guarantee: an expression must be evaluable at compile time only when
used in a context that requires a constant expression.

## 2.7 Object Types, Function Types, and `void` — Core

An **object** is a region of storage with a type, value, lifetime, and possibly a
name. Object types exclude references, functions, and `void`. An object can be
created in storage only when its type is complete and its size is known.

```text
storage obtained
      |
      v
object lifetime begins
      |
      v
typed access is permitted
      |
      v
lifetime ends (destruction or storage reuse)
      |
      v
old glvalue may no longer designate a live object
```

Chapter 3 owns the detailed lifetime and object-representation rules. The type
lesson here is that converting an address does not create an object, start its
lifetime, or make an otherwise-invalid access legal.

A function type describes parameters, return type, and qualifiers permitted
for that kind of function. A function is not an object: there are no arrays of
functions, and a function pointer does not portably convert to `void*`. A
function name often undergoes function-to-pointer conversion when used as a
value.

`void` is an incomplete type that cannot be completed or instantiated. A
function returning `void` returns no value. `void*` is different: it is an
object pointer type that can hold a converted pointer to any object type and
round-trip it back to the original pointer type.

```cpp
struct Event;

void consume(Event const&);       // function declaration; Event may be incomplete
using Callback = void (*)(Event const&);

void* raw = nullptr;              // object pointer
Callback callback = &consume;     // function pointer; not portably convertible to void*
```

Common POSIX APIs such as `dlsym` bridge object and function pointers as a
platform extension. That behavior is useful on those platforms but is not a
portable C++ guarantee.

## 2.8 `const` and `volatile` Qualification — Core

Cv-qualification constrains access through a type. Top-level `const` qualifies
the object itself; low-level `const` qualifies a pointed-to or referred-to type.

```cpp
int value = 7;
int const* pointer_to_const = &value;
int* const const_pointer = &value;

// *pointer_to_const = 8; // error through this access path
*const_pointer = 8;       // valid; the pointer cannot be reseated
```

`const` does not necessarily mean the underlying object can never change.
`int const& view = value` prevents mutation through `view`, while another
non-const path may still modify `value`. Conversely, modifying an object that
was actually defined as const after casting away constness is undefined
behavior.

Qualification conversions may add low-level cv-qualification:

```cpp
int* p = &value;
int const* cp = p; // permitted
// int* q = cp;    // rejected: would remove const
```

Top-level cv-qualification is ignored in several by-value contexts because a
copy is a new object. This is why `auto copy = const_object;` deduces a
non-const value type.

`mutable` permits a member to change in a `const` member function. It supports
logical constness—caches, counters, and mutexes—but does not add synchronization.
A mutable cache written by concurrent readers still needs a correct concurrency
design.

`volatile` tells the implementation that accesses through the volatile glvalue
are observable according to volatile semantics. Its exact usefulness for
memory-mapped I/O is implementation-defined and platform-specific. It does not
provide inter-thread atomicity, a C++ happens-before relation, or freedom from
data races. Use `std::atomic` for shared-memory concurrency. Low-latency code
ported from Java must not import Java's stronger `volatile` intuition into C++.

## 2.9 References — Core

A reference is an alias, not a nullable, reseatable object handle. It must bind
at initialization. Assignment through a reference assigns to the referred-to
object.

| Property | Reference | Pointer |
|---|---|---|
| Must designate a valid entity | Yes, while used | May be null |
| Reseatable | No | Yes |
| Pointer arithmetic | No | Within array rules |
| Syntax | Direct object syntax | `*` and `->` |
| Storage representation | Not specified | Pointer object with implementation-defined representation |

```cpp
int bid = 100;
int ask = 101;
int& selected = bid;

selected = ask; // copies 101 into bid; it does not rebind selected
```

Use `T&` when the callee requires a live `T`, takes no ownership, and null has no
meaning. Use `T*` when absence or reseating is part of the contract. Neither
encodes lifetime ownership.

An lvalue reference `T&` binds to lvalues. A const lvalue reference
`T const&` may bind to a temporary, and an rvalue reference `T&&` binds to an
rvalue of suitable type. Directly binding a local reference variable to a
temporary can extend that temporary's lifetime, but lifetime extension does not
generally “pass through” another reference:

```cpp
#include <string>

std::string const& bad() {
    return std::string{"expired"}; // intentionally wrong: returned reference dangles
}
```

Do not execute the example; returning the reference does not extend the
temporary to the caller. Reference members, views, and references returned from
subobjects need the same lifetime analysis.

In a deduced context, `T&&` can be a forwarding reference. Reference collapsing
uses the rule “an lvalue reference wins”:

```text
T&  &  -> T&       T&  && -> T&
T&& &  -> T&       T&& && -> T&&
```

A named rvalue-reference variable is itself an lvalue expression. `std::move`
does not move anything; it casts to an xvalue so a later overload may move.
`std::forward<T>` conditionally restores the caller's original value category.
The performance consequence is indirect: correct forwarding can avoid a copy,
but only the selected constructor/overload determines the work performed.

## 2.10 Pointers and Arrays — Core

An array is an object containing a fixed number of contiguous elements. A
pointer is a separate scalar object that may point to an element. They are not
the same type even though arrays often decay to pointers.

```cpp
#include <cstddef>
#include <type_traits>

int main() {
    int prices[4]{100, 101, 102, 103};
    int* p = prices;

    static_assert(sizeof(prices) == 4 * sizeof(int));
    static_assert(std::is_same_v<decltype(&prices), int (*)[4]>);
    static_assert(std::is_same_v<decltype(p), int*>);
}
```

Pointer arithmetic is defined only within one array object, including its
one-past-the-end position. A non-array object behaves as an array of one for
these rules. Forming a pointer farther outside that range is undefined
behavior, even if it is never dereferenced. Subtracting two pointers is defined
only when both point into the same array (or one past it), and the result type is
`std::ptrdiff_t`.

```text
prices:  [0] [1] [2] [3] | one-past
          ^               ^
          p               valid to form/compare, invalid to dereference
```

`int matrix[3][4]` is an array of three arrays of four `int`, contiguous in
row-major order. Its first conversion is to `int (*)[4]`, not `int**`.
An `int**` “matrix” points through a separate array of pointers and has a
different layout and locality profile.

At interfaces, prefer a type that preserves the contract:

| Need | Suitable type |
|---|---|
| Fixed-size owning value | `std::array<T, N>` |
| Non-owning contiguous view | `std::span<T>` |
| Dynamic owning sequence | `std::vector<T>` |
| Multidimensional non-owning view | `std::mdspan` (C++23) |
| Nullable single object | `T*` |

`std::span` is commonly represented as a pointer and size for dynamic extent,
but the standard specifies behavior, not register passing or exact layout.
It preserves bounds for algorithms; it does not own the data or prevent the
underlying storage from expiring.

## 2.11 Arrays and Array Bounds — Core

Built-in array bounds are part of the array type, but built-in subscripting does
not perform a run-time check. `a[i]` is defined as `*(a + i)`. An out-of-bounds
subscript therefore leads to invalid pointer arithmetic or dereference and
undefined behavior.

```cpp
#include <array>
#include <span>

int sum(std::span<int const> values) {
    int result = 0;
    for (int value : values) {
        result += value; // assume the mathematical sum fits in int
    }
    return result;
}

int main() {
    std::array<int, 3> values{1, 2, 3};
    return sum(values);
}
```

`std::span::operator[]` has the same precondition that the index is in range.
C++23 does not require it to throw or terminate on violation. `std::array::at`
and `std::vector::at` perform checked access and throw `std::out_of_range`, but
exception behavior may be unsuitable on a hottest path. The production choice
is not “bounds checks are slow”; it is where the invariant is established and
how it is verified.

A defensible low-latency design validates an untrusted message length once at
the boundary, constructs a bounded view, and lets inner code operate under that
documented precondition. Measure whether a repeated check remains after
optimization before removing it. Sanitizers and hardened library modes are
valuable in testing because an unchecked violation may otherwise corrupt data
far from its source.

## 2.12 Array-to-Pointer and Function-to-Pointer Decay — Core

Array-to-pointer conversion changes `T[N]` to `T*` pointing at the first
element. Function-to-pointer conversion changes a function lvalue to a pointer
to that function. These conversions happen in many value contexts, but not all.

| Expression/context | Array decays? | Result for `int a[4]` |
|---|---:|---|
| `int* p = a` | Yes | `int*` |
| Passing to a by-value template | Yes | template parameter deduces as `int*` |
| Binding `auto& r = a` | No | `int (&)[4]` |
| `sizeof(a)` | No | `4 * sizeof(int)` |
| `decltype(a)` | No | `int[4]` |
| `&a` | No | `int (*)[4]` |

The parameter spelling trap is fundamental:

```cpp
void consume(int values[64]); // adjusted to void consume(int* values)
void consume(int* values);    // same declaration
```

The `64` documents an intention but is not part of the function type and is not
checked. Use `std::span<int, 64>` if exactly 64 elements are required, or
`std::span<int>` if the size is dynamic.

```cpp
#include <cstddef>

template<std::size_t N>
constexpr std::size_t count(int const (&)[N]) noexcept {
    return N;
}

static_assert([] {
    int values[7]{};
    return count(values) == 7;
}());
```

A function name similarly converts to a function pointer when a value is
needed:

```cpp
int compare(int lhs, int rhs) { return (lhs > rhs) - (lhs < rhs); }
using Comparator = int (*)(int, int);
Comparator c = compare;
```

Overloaded function names need a target type or an explicit cast to select one
overload. A captureless lambda has a conversion to a compatible function
pointer; that is not the function-to-pointer conversion applied to a function
name, though it enables similar C callback interoperation.

## 2.13 Scoped and Unscoped Enumerations — Core

An unscoped enum injects enumerator names into the surrounding scope and may
implicitly convert to an integer type. A scoped enum (`enum class` or
`enum struct`) keeps names scoped and does not implicitly convert to an integer.

```cpp
#include <cstdint>
#include <utility>

enum Side { buy, sell };
enum class State : std::uint8_t { idle, live, halted };

int side_code = buy; // implicit conversion from unscoped enum
State state = State::live;
auto raw = std::to_underlying(state); // C++23; uint8_t here
```

| Property | Unscoped enum | Scoped enum |
|---|---|---|
| Enumerator qualification | Optional in many cases | Required |
| Implicit conversion to integer | Yes | No |
| Default underlying type | Implementation-selected subject to rules | `int` |
| Fixed underlying type | Optional | Optional |
| Forward declaration | Requires fixed underlying type | Permitted; underlying type known |

A fixed underlying type defines storage width and conversion behavior, which is
useful for protocols and compact state. It still does not define serialization
endianness or validate arbitrary incoming bytes.

Converting an integer to an enum does not guarantee that the result names an
enumerator. If the value is outside the enum's representable range, behavior
can be undefined; the exact range rules depend on whether the underlying type
is fixed. Validate external data in an integer type before converting.

Scoped enum bit flags need explicitly defined operators. The small amount of
boilerplate prevents accidental arithmetic and mixing unrelated flag domains.
For exhaustive `switch` checking, omitting a `default` can let compiler warnings
identify sites that need updating when a new enumerator is added.

## 2.14 Character Types and Encodings — Role-specific

A character type stores a **code unit**. An encoding maps sequences of code
units to Unicode code points or another character repertoire. A user-perceived
character may contain multiple code points, so byte count, code-unit count,
code-point count, and grapheme count are different questions.

| Type/literal | Intended role | Portable warning |
|---|---|---|
| `char`, `"text"` | Narrow execution encoding; often UTF-8 by convention | Plain `char` signedness is implementation-defined |
| `char8_t`, `u8"text"` | UTF-8 code units | Distinct from `char` since C++20 |
| `char16_t`, `u"text"` | UTF-16 code units | One code point may require a surrogate pair |
| `char32_t`, `U"text"` | UTF-32 code units | Does not solve grapheme segmentation |
| `wchar_t`, `L"text"` | Implementation-defined wide character model | Commonly 16 bits on Windows, 32 on many Unix-like ABIs |

`std::string::size()` counts `char` elements, not Unicode characters. UTF-8 is
commonly chosen for storage and wire interchange because it is byte-oriented
and ASCII-compatible, but the standard does not declare every ordinary
`std::string` to contain valid UTF-8.

The `<cctype>` functions have a notorious conversion precondition. Except for
`EOF`, their input must be representable as `unsigned char`. Passing a negative
plain `char` is undefined behavior:

```cpp
#include <cctype>

bool is_space(char c) {
    return std::isspace(static_cast<unsigned char>(c)) != 0;
}
```

Unicode validation, normalization, locale-sensitive comparison, and grapheme
segmentation require a deliberate library and policy. On a low-latency parsing
path, establish whether the protocol is ASCII, validated UTF-8, or arbitrary
bytes; each contract permits different validation and vectorization strategies.

## 2.15 Implicit and Explicit Conversions — Core

An implicit conversion occurs where the language expects another type:
initialization, assignment, argument passing, returning, conditions, operators,
and overload resolution. A user-defined conversion sequence may also invoke a
converting constructor or conversion function, but at most one user-defined
conversion participates in a standard implicit conversion sequence.

`explicit` prevents constructors and conversion functions from participating
in ordinary implicit conversions, with special contextual rules such as
`explicit operator bool`.

```cpp
struct Quantity {
    explicit Quantity(int value) : value{value} {}
    int value;
};

void submit(Quantity);

// submit(7);             // rejected: constructor is explicit
submit(Quantity{7});      // intent is visible
```

Classify built-in conversions by their consequence:

| Conversion | Typical result | Risk |
|---|---|---|
| Promotion | Usually value-preserving | Changes the type in which arithmetic occurs |
| Widening integer conversion | Value-preserving only if destination covers source range | Signedness may still change |
| Integer narrowing | Result is the unique destination value congruent modulo \(2^N\) | Plausible but unintended values |
| Floating-to-integer | Truncates fractional part; UB if truncated value is not representable | NaN, infinity, and large values are dangerous |
| Integer-to-floating | Rounds if not exactly representable | Large IDs/timestamps can lose low bits |
| Floating narrowing | Rounds; out-of-range behavior follows floating conversion rules | Precision loss, infinity |
| Pointer qualification | May add cv-qualification | Removing it requires `const_cast` |
| Derived-to-base pointer/reference | Adjusts to base subobject | ABI may require nonzero pointer adjustment |

Integer narrowing itself is not signed arithmetic overflow. Since C++20, the
destination integer is the unique value congruent to the source modulo
\(2^N\), where N is the destination width. Brace initialization rejects many
narrowing conversions at compile time, but a cast explicitly requests one.

For run-time values, check representability before converting:

```cpp
#include <optional>
#include <utility>

template<class To, class From>
std::optional<To> checked_integer(From value) {
    if (!std::in_range<To>(value)) {
        return std::nullopt;
    }
    return static_cast<To>(value);
}
```

`std::in_range` is for integer-like comparisons covered by its constraints. A
domain conversion may need stricter rules—for example, rejecting negative
quantities even when the storage type could represent them.

## 2.16 Boolean Conversions and Null Pointers — Core

In conditions, C++ performs contextual conversion to `bool`. Zero arithmetic
values, null pointers, and null pointer-to-member values become `false`;
nonzero arithmetic values and non-null pointers become `true`. Floating NaN is
true because it is not zero. An `explicit operator bool` is considered in a
contextual conversion, which permits `if (handle)` without enabling arbitrary
implicit arithmetic.

```cpp
struct Handle {
    explicit operator bool() const noexcept { return address != nullptr; }
    void* address{};
};

if (Handle h{}; !h) {
    // invalid handle
}
```

`nullptr` is a null pointer literal of type `std::nullptr_t`. It implicitly
converts to any pointer or pointer-to-member type but not to an integer. Prefer
it to `0` and `NULL`, particularly with overloads:

```cpp
void select(int);
void select(char*);

select(0);       // select(int)
select(nullptr); // select(char*)
```

A null pointer value is a semantic value; the C++ standard does not require its
object representation to be all-zero bits. Mainstream ABIs commonly use zero,
but `memset` is not the portable way to value-initialize arbitrary C++ objects.

Dereferencing a null pointer is undefined behavior, not a guaranteed trap. A
compiler may remove a later null check after an earlier dereference because
defined executions already require the pointer to be non-null. Validate before
use. A one-past pointer is not null and is valid to form and compare within its
array, but not to dereference.

## 2.17 Integer Promotions and the Usual Arithmetic Conversions — Core

Integral promotion applies to `bool`, character types, `short`, and some
enumerations. If `int` can represent every value of the original type, the
value promotes to `int`; otherwise it promotes to `unsigned int` under the
relevant rules. The fixed-width aliases follow the rules of their underlying
built-in types.

```cpp
#include <cstdint>
#include <type_traits>

std::uint8_t left = 200;
std::uint8_t right = 100;
auto total = left + right;

static_assert(std::is_same_v<decltype(total), int>);
// total is 300, not 44, on implementations providing uint8_t.
```

After promotions, many binary arithmetic and comparison operators apply the
usual arithmetic conversions (UAC). This compact flowchart covers the common
interview path:

```text
After lvalue-to-rvalue and integral promotions:

Is either operand floating-point?
  |
  +-- yes --> choose a common floating type by conversion rank/subrank rules;
  |           convert the other operand; perform the operation there
  |
  +-- no --> integral operands
              |
              +-- same type? ------------------------> use it
              |
              +-- same signedness? ------------------> higher conversion rank
              |
              +-- mixed signedness
                    |
                    +-- unsigned rank >= signed rank
                    |       -> corresponding unsigned type
                    |
                    +-- signed type represents every unsigned value
                    |       -> signed type
                    |
                    +-- otherwise
                            -> unsigned counterpart of signed type
```

The floating rules gained more formal rank/subrank wording in C++23; the
ordinary result remains intuitive for standard types: `long double` dominates
`double`, which dominates `float`, subject to the specified conversion rules.
Do not generalize this casually to implementation-specific extended types.

Prediction examples, assuming 32-bit `int` and `unsigned int`:

```cpp
static_assert((-1 < 1u) == false); // -1 converts to unsigned int

std::uint8_t x = 255;
auto y = x + 1;                   // int 256

double d = 1.5;
auto z = d + 2;                   // double 3.5
```

On LP64, `long` can represent every value of 32-bit `unsigned int`, so mixing
those two chooses `long`. On LLP64, both are commonly 32 bits, so the result
chooses `unsigned long`. The language procedure is portable; the widths feeding
it are implementation properties.

When signed and unsigned values genuinely must be compared, C++20's
`std::cmp_equal`, `std::cmp_less`, and related functions compare mathematical
values without the surprising UAC result. `std::ssize` supplies a signed size
for many ranges. Compiler conversion warnings are useful, but warnings are not
a substitute for choosing one coherent domain type.

## 2.18 Signed and Unsigned Arithmetic — Core

Unsigned arithmetic is performed modulo \(2^N\), where N is the number of value
bits. Signed arithmetic must produce a representable result; signed overflow is
undefined behavior. Since C++20, signed integers use two's-complement
representation, but that does not make signed overflow wrap.

| Operation/property | Signed integer | Unsigned integer |
|---|---|---|
| Addition overflow | Undefined behavior | Modulo \(2^N\) |
| Subtraction below zero | Undefined only if result unrepresentable | Wraps modulo \(2^N\) |
| Division | Truncates toward zero; `min / -1` can overflow | Ordinary integer division |
| Right shift | Sign-propagating result under current rules | Zero-filling |
| Best semantic use | Quantities with meaningful negative values | Bit sets, modulo arithmetic, library sizes |

Unsigned is not a validation mechanism:

```cpp
#include <cstddef>

std::size_t remaining(std::size_t capacity, std::size_t used) {
    return capacity - used; // huge value if used > capacity
}
```

The invariant `used <= capacity` must be checked or established before the
subtraction. The type alone does not enforce it.

Bit shifts deserve their own check. After promotions, a negative shift count or
a count greater than or equal to the width of the promoted left operand gives
undefined behavior. For an unsigned left operand, left shift is defined modulo
the unsigned representation rules when the count is valid. Prefer `<bit>`
operations such as `std::rotl` when rotation is the intent; hand-written rotate
expressions often fail at a shift count of zero or the type width.

Signed arithmetic can enable stronger optimizer reasoning because the compiler
may assume undefined overflow never occurs. That is a consequence, not a reason
to rely on overflow. Choose the type from the domain, then inspect code
generation and measure the target workload.

## 2.19 Integer Overflow: Failure Trace and Defences — Core

The threatened invariant in size arithmetic is usually:

> The computed byte count must represent the full requested allocation and must
> be at least as large as every later write.

An overflow can break it before allocation:

```text
untrusted element count
        |
        v
count * sizeof(Element)
        |
        +-- wraps (unsigned) or invokes UB (signed)
        v
small byte count passes a limit check
        |
        v
small allocation
        |
        v
loop writes count elements
        |
        v
out-of-bounds memory corruption
```

This post-check is intentionally wrong:

```cpp
bool overflowed(int a, int b) {
    return a + b < a; // wrong: a + b already has UB if it overflows
}
```

Once an execution has signed overflow, the program has no defined fallback
answer. Optimizers may reason that overflow does not happen and simplify the
check accordingly. Check before the operation, widen into a type proven large
enough, or use a checked-arithmetic facility.

For unsigned multiplication:

```cpp
#include <cstddef>
#include <limits>
#include <optional>

std::optional<std::size_t> bytes_for(std::size_t count,
                                     std::size_t element_size) {
    if (element_size != 0 &&
        count > std::numeric_limits<std::size_t>::max() / element_size) {
        return std::nullopt;
    }
    return count * element_size;
}
```

| Symptom | Violated invariant | Detection | Mitigation/recovery |
|---|---|---|---|
| Tiny allocation for large request | Product representable in size type | Boundary tests, checked multiply | Reject request before allocation |
| Loop unexpectedly continues | Counter/bound arithmetic remains ordered | UBSan, warnings, edge tests | Rewrite condition; validate bound |
| Negative quantity becomes huge | Compared common type preserves meaning | Sign-conversion warning, code review | Use one domain type or `std::cmp_*` |
| Release differs from debug | No signed overflow UB | UBSan and optimized tests | Eliminate overflow; do not depend on `-O0` |
| Counter intentionally wraps | Modulo behavior is explicit | Tests across wrap boundary | Use unsigned and document modulus |

GCC and Clang provide `__builtin_add_overflow`,
`__builtin_mul_overflow`, and related extensions; other toolchains provide
different intrinsics. They are not C++23 standard facilities, so wrap them
behind a small portability layer when needed. UBSan can detect signed overflow
during tests, but test coverage determines which executions it observes.

`std::abs(INT_MIN)` and `INT_MIN / -1` are also unrepresentable for a typical
two's-complement signed type and lead to undefined behavior under their
respective rules. These boundary values belong in conversion and arithmetic
tests.

## 2.20 IEEE 754 Floating Point — Core

C++ permits implementation-defined floating-point representations. On most
current low-latency server platforms, `float` and `double` use IEC 60559/IEEE
754 binary32 and binary64. Query
`std::numeric_limits<T>::is_iec559`; do not present IEEE layout as a universal
C++ guarantee.

For the common formats:

```text
binary32: [sign:1][exponent:8 ][fraction:23]  -> 24 bits of precision
binary64: [sign:1][exponent:11][fraction:52]  -> 53 bits of precision
```

| Common IEEE format | Precision | Reliable decimal digits (`digits10`) | Round-trip digits (`max_digits10`) | Exact consecutive integers |
|---|---:|---:|---:|---:|
| binary32 (`float`) | 24 binary digits | 6 | 9 | through \(2^{24}\) |
| binary64 (`double`) | 53 binary digits | 15 | 17 | through \(2^{53}\) |

Most decimal fractions do not have a finite binary representation. A literal
such as `0.1` is rounded to the nearest representable binary value. Spacing is
not uniform across the entire range: within each power-of-two interval the
spacing is regular, then doubles at the next interval.

```cpp
#include <cstdint>

double id = 9'007'199'254'740'992.0; // 2^53
double next = id + 1.0;
// id == next on IEEE binary64: there is no representable value between.
```

Floating addition and multiplication are not associative because each
operation rounds. `(a + b) + c` can differ from `a + (b + c)`. A reduction's
order is therefore part of its numerical behavior. Accuracy, reproducibility,
throughput, and tail latency are separate requirements.

An epsilon comparison needs a scale and a domain error budget:

```cpp
#include <algorithm>
#include <cmath>

bool close(double a, double b, double relative, double absolute) {
    double difference = std::fabs(a - b);
    return difference <= absolute ||
           difference <= relative * std::max(std::fabs(a), std::fabs(b));
}
```

There is no universal epsilon. Exact equality is correct for values whose exact
representation and computation are part of the contract, and often wrong for
independently rounded computations. Prices expressed in discrete ticks are
usually better modeled as checked integers or a strong fixed-point type than as
binary floating point.

## 2.21 Subnormal Floating-Point Values — Deep dive

In IEEE binary formats, **subnormal** values use the minimum exponent encoding
and no implicit leading significand bit. They fill the gap between the smallest
normal magnitude and zero, providing gradual underflow.

```text
normal values ... smallest normal | subnormals ... | zero
                                  continuous spacing toward zero
```

The C++ interface exposes relevant properties through
`std::numeric_limits<T>::has_denorm` and `denorm_min()`, and
`std::fpclassify` can identify `FP_SUBNORMAL`. Exact availability and behavior
remain implementation properties.

Some, not all, processors or execution units handle subnormal inputs/results
with higher latency or lower throughput than normal values. The penalty varies
substantially by microarchitecture and instruction class; a timeless cycle
count is not defensible. Measure the actual kernel with representative data,
CPU affinity, compiler flags, and both typical and tail-latency distributions.

Platforms may offer flush-to-zero (subnormal results become zero) and
denormals-are-zero (subnormal inputs are treated as zero) controls. These are
not portable C++ semantics and change numerical behavior. On x86 SSE they are
commonly thread-local control-register state. If enabled, define who owns that
state, initialize every relevant thread, test dependent libraries, and retain a
rollback flag. The success measure is a latency distribution improvement
without exceeding the application's numerical error budget.

## 2.22 NaN and Infinity — Core

On IEC 60559 implementations, floating overflow or certain operations may
produce infinity, and invalid operations may produce NaN. C++ library functions
expose portable queries such as `std::isfinite`, `std::isinf`, and `std::isnan`,
subject to the implementation's floating environment and compiler options.

NaN is unordered:

```cpp
#include <cmath>
#include <limits>

double n = std::numeric_limits<double>::quiet_NaN();
bool a = (n == n);       // false
bool b = (n < 0.0);      // false
bool c = (n >= 0.0);     // false
bool d = std::isnan(n);  // true under ordinary IEEE-aware semantics
```

Therefore `!(x < y)` is not equivalent to `x >= y` when NaN is possible. A
comparator used by sorting or ordered containers must establish a strict weak
ordering over the actual input domain; ordinary floating `<` does not do so for
a domain containing NaNs. Reject NaNs at the boundary or define and test a total
ordering policy.

Infinity compares beyond finite values and supports useful limit-like
arithmetic, but indeterminate forms such as infinity minus infinity produce
NaN. `std::numeric_limits<double>::max()` is the largest finite value;
`infinity()` is different.

`std::max` is comparison-based and does not supply a consistent NaN policy:
operand order can affect whether a NaN is returned. `std::fmax` has specified
floating behavior that returns the numeric operand when exactly one operand is
NaN. Choose propagation, rejection, or suppression deliberately.

Floating exceptions are commonly sticky status flags rather than language
exceptions. `<cfenv>` provides facilities to inspect and alter the floating
environment when the implementation supports them. Trapping is
platform-specific. A hot-path design often validates finite inputs once and
then keeps the core loop free of repeated classification, but only if no inner
operation can introduce a non-finite result.

## 2.23 Fast-Math Optimizations — Role-specific

“Fast math” is not one C++23 language mode. It is a compiler-specific bundle of
permissions that may include reassociation, reciprocal approximations,
contracting multiply-add, ignoring signed zero, assuming no NaN/infinity, and
changing treatment of the floating environment. GCC, Clang, and MSVC expose
different flags and details.

The mechanism can improve throughput by enabling SIMD reduction, shortening
dependency chains, or replacing costly operations. It can also invalidate
checks such as `std::isnan`, change results, remove reproducibility, and alter
exception or `errno` behavior.

| Proposed permission | Possible benefit | Correctness cost | Evidence required |
|---|---|---|---|
| Reassociate additions | Vector reduction, more instruction-level parallelism | Different rounding and NaN propagation | Error distribution plus throughput/tail benchmark |
| Reciprocal approximation | Lower division latency | Bounded accuracy loss | Worst-case relative error on real inputs |
| Assume finite values | Remove checks, unlock transforms | NaN/Inf behavior no longer reliable | Proven boundary validation and generated-code review |
| Contract to FMA | One instruction, often more accurate | Different result from two roundings | Cross-build reproducibility tests |
| Flush subnormals | Avoid a target-specific slow path | Underflow becomes zero earlier | Numerical budget and target-CPU latency measurement |

A defensible rollout is local: establish an input invariant, apply the narrowest
compiler option to one translation unit or function if supported, benchmark on
the deployment CPU, compare numerical output against a reference, monitor tail
latency and error bounds, and keep a build-time rollback. A global
`-ffast-math` switch is difficult to reason about because validation and
reconciliation code may silently inherit the same assumptions.

`std::reduce` permits reordering by its specification, while
`std::accumulate` follows a left fold. That semantic choice may be more
reviewable than globally authorizing arbitrary reassociation, though actual
parallelism and vectorization remain implementation and policy dependent.

## 2.24 `auto` Type Deduction — Core

`auto` variable deduction follows template argument deduction patterns, with
special rules for braced initializer lists. Choose the declarator form according
to whether the new name should own a value, alias an object, or forward a value
category.

| Declaration | Deduction behavior | Example result |
|---|---|---|
| `auto x = expr` | Drops references and top-level cv; arrays/functions decay | `const int&` expression becomes `int` |
| `auto& x = expr` | Preserves referred-to cv; no decay | const lvalue becomes `const T&` |
| `const auto& x = expr` | Binds broadly and observes as const | temporary lifetime may be extended locally |
| `auto&& x = expr` | Forwarding-reference deduction | lvalue gives `T&`, rvalue gives `T&&` |
| `auto* x = expr` | Deduces pointee qualifiers | `const int*` remains pointer to const |

```cpp
#include <type_traits>

int values[3]{};
int const limit = 3;

auto a = limit;       // int
auto& b = limit;      // const int&
auto c = values;      // int*
auto& d = values;     // int (&)[3]

static_assert(std::is_same_v<decltype(a), int>);
static_assert(std::is_same_v<decltype(b), int const&>);
static_assert(std::is_same_v<decltype(c), int*>);
static_assert(std::is_same_v<decltype(d), int (&)[3]>);
```

Brace deduction is a frequent screen question:

```cpp
auto one{1};        // int
auto list = {1};    // std::initializer_list<int>
auto many = {1, 2}; // std::initializer_list<int>
```

All elements in the copy-list form must deduce one element type. A bare braced
initializer is not an expression and ordinary function-template deduction
cannot generally deduce a parameter from it.

`auto` can prevent an unintended conversion caused by spelling the wrong
explicit type, as in a range loop over an associative container. It can also
hide an expensive copy or a proxy type such as `std::vector<bool>::reference`.
Use `auto&` or `const auto&` when aliasing is intended; explicitly materialize a
value when a proxy must not escape:

```cpp
#include <vector>

std::vector<bool> flags{true};
bool stable = static_cast<bool>(flags[0]); // independent bool value
```

The cost of `auto` is not run time—it is possible loss of review information.
At API and domain boundaries, an explicit strong type often communicates an
invariant better.

## 2.25 `decltype` and `decltype(auto)` — Core

`decltype` has two rules:

1. For an unparenthesized id-expression or unparenthesized class-member access,
   it yields the entity's declared type.
2. Otherwise, if the expression's type is `T`, an lvalue yields `T&`, an xvalue
   yields `T&&`, and a prvalue yields `T`.

```cpp
#include <type_traits>
#include <utility>

int x = 0;
int& alias = x;

static_assert(std::is_same_v<decltype(x), int>);
static_assert(std::is_same_v<decltype(alias), int&>);
static_assert(std::is_same_v<decltype((x)), int&>);
static_assert(std::is_same_v<decltype(std::move(x)), int&&>);
static_assert(std::is_same_v<decltype(x + 1), int>);
```

Parentheses move `x` from the first rule to the expression/value-category rule.
That difference is intentional and dangerous when overlooked.

`decltype` operands are unevaluated in this use: asking for the type does not
execute the expression. It remains central to generic return types and
constraints even though C++20 concepts replace many older detection idioms.

`decltype(auto)` requests deduction using `decltype` rules:

```cpp
template<class Container>
decltype(auto) first(Container& container) {
    return container[0]; // preserves the exact operator[] return type
}
```

If this function returned plain `auto`, a real reference returned by
`operator[]` would be copied. With `decltype(auto)`, parentheses in a return
statement can accidentally return a reference to a local:

```cpp
decltype(auto) wrong() {
    int local = 1;
    return (local); // intentionally wrong: deduces int&, which dangles
}
```

Use `decltype(auto)` only when exact type and value-category propagation are
part of the function contract. It can also preserve proxy return types, which
may be the opposite of what the caller needs.

| Feature | Top-level cv | Reference | Array/function decay | Parenthesis-sensitive |
|---|---|---|---|---|
| By-value `auto` | Drops | Drops | Yes | No |
| `auto&` | Preserves referred-to cv | Produces lvalue reference | No | No |
| `decltype(expr)` | Preserves | Follows its two rules | No | Yes |
| `decltype(auto)` | Preserves | Follows `decltype` | No | Yes |

## 2.26 Explicit C++ Casts — Core

Named casts constrain and advertise intent. A cast does not validate a value,
repair an object lifetime, grant ownership, or make an invalid aliasing access
legal.

| Cast | Purpose | Run-time work | Main trap |
|---|---|---|---|
| `static_cast` | Related type and numeric conversions; explicit constructors | Usually none beyond the conversion; pointer adjustment may occur | Narrowing and unchecked downcast |
| `dynamic_cast` | Checked navigation in a polymorphic hierarchy | Implementation-dependent RTTI lookup/adjustment | Hot-path cost and design dependence on RTTI |
| `const_cast` | Add/remove cv-qualification | None itself | Modifying an actually const object is UB |
| `reinterpret_cast` | Low-level reinterpretation allowed by its specific rules | Usually representation-preserving | Dereference may violate alignment, lifetime, or aliasing |
| `std::bit_cast` | Copy object representation between equal-size trivially copyable types | Commonly optimized away | Output value may be indeterminate/invalid under its detailed rules |

`static_cast` is appropriate when the language defines a relationship and the
precondition is already proved:

```cpp
double price = 101.75;
int whole = static_cast<int>(price); // explicit truncation to 101
```

Before converting floating point to integer, ensure the truncated value is
finite and representable; otherwise behavior is undefined.

A base-to-derived `static_cast` is not a run-time type check. `dynamic_cast` can
check a pointer or reference within a polymorphic hierarchy: pointer failure
returns null and reference failure throws `std::bad_cast`. Its exact algorithm
and latency are ABI/runtime properties. If it appears in a hot path, compare it
with a type tag, virtual dispatch, or `std::variant` design under the real class
shape and branch distribution.

`const_cast` is safe for mutation only when the underlying object was not
defined const:

```cpp
int value = 1;
int const* observed = &value;
*const_cast<int*>(observed) = 2; // valid: underlying object is non-const
```

`reinterpret_cast` between pointer types does not create a destination object
or permit reading an object through an unrelated type. Use `std::bit_cast` for
same-size, trivially copyable value representations:

```cpp
#include <bit>
#include <cstdint>

float value = 1.0F;
std::uint32_t bits = std::bit_cast<std::uint32_t>(value);
```

The numerical meaning of `bits` depends on the floating representation and
integer width; the cast itself is standard C++20.

C-style casts and one-argument function-style casts can attempt several named
cast categories, including combinations that remove constness. That breadth
makes refactoring failures less visible. Prefer named casts, and prefer
list-initialization when narrowing should be rejected rather than requested.

## 2.27 Worked Reasoning: Diagnose a Sequence-Gap Check — Core

Assume a feed handler stores the next expected sequence number as
`std::uint32_t` and receives a decoded `std::int32_t` sequence:

```cpp
#include <cstdint>

bool is_future(std::int32_t received, std::uint32_t expected) {
    return received > expected;
}
```

An interviewer asks what happens for `received == -1` and `expected == 10` on a
platform with 32-bit `int` and `unsigned int`.

Apply the five-step model:

1. Both lvalues undergo lvalue-to-rvalue conversion.
2. Neither type promotes: each has `int` rank.
3. The operands have equal rank and mixed signedness. The signed 32-bit type
   cannot represent every unsigned 32-bit value.
4. The UAC convert `received` to `std::uint32_t`; `-1` becomes
   \(2^{32}-1\).
5. The comparison is therefore true.

The bug is not integer overflow. It is a value-changing conversion before the
comparison. A cast to `std::int32_t` is not a general repair because `expected`
may exceed `INT32_MAX`.

First decide the invariant. If negative decoded sequences are invalid and the
valid protocol range is `uint32_t`, validate and convert once:

```cpp
#include <cstdint>
#include <optional>

std::optional<std::uint32_t> validate_sequence(std::int64_t decoded) {
    if (decoded < 0 || decoded > UINT32_MAX) {
        return std::nullopt;
    }
    return static_cast<std::uint32_t>(decoded);
}
```

Then the hot comparison uses one type:

```cpp
bool is_future(std::uint32_t received, std::uint32_t expected) {
    return received > expected;
}
```

This still assumes ordinary ordering. If sequence numbers intentionally wrap
modulo \(2^{32}\), “future” requires a protocol-specific serial-number
arithmetic rule, including how to treat distances of exactly half the range.
Unsigned types provide modulo arithmetic but do not define the protocol's
ordering.

The low-latency trade-off is favorable: move range validation to message decode,
keep the inner state machine monomorphic in one integer type, and count rejected
messages. Verify with boundary tests around `-1`, `0`, `INT32_MAX`,
`UINT32_MAX`, and the protocol wrap point, then measure the real handler rather
than the isolated cast.

## 2.28 Recall and Practice — Core

### Recall card

- Predict conversions in stages: source type, value transformation, promotion,
  common type, operation, destination conversion.
- Built-in integer widths are minimum guarantees. LP64/LLP64 are ABI data
  models, not C++ language rules.
- Small integer arithmetic commonly occurs in `int`.
- Mixed signed/unsigned operands may convert the signed value to unsigned.
- Signed overflow is UB; unsigned arithmetic is modulo \(2^N\); narrowing is a
  separate conversion.
- Arrays are objects with bounds, but most value uses decay to pointers.
  Function array parameters are adjusted to pointer parameters.
- `const` constrains an access path. `volatile` is not inter-thread
  synchronization.
- `nullptr` is a typed null pointer literal. Dereferencing null is UB, not a
  guaranteed fault.
- IEEE 754 is common, not universally mandated by C++. Floating-point
  arithmetic is rounded and non-associative.
- NaN is unordered. Fast-math flags may discard NaN, infinity, signed-zero, or
  ordering assumptions.
- By-value `auto` drops top-level cv/references and decays. `decltype((x))`
  reports an lvalue reference.
- Named casts expose intent; none can manufacture a missing precondition.

### Common traps

| Code shape | Wrong intuition | Correct question |
|---|---|---|
| `uint8_t + uint8_t` | “The result wraps at 8 bits” | What do both operands promote to? |
| `negative < size()` | “Negative is always smaller” | What common type does comparison choose? |
| `void f(int a[10])` | “The callee knows 10” | Was the parameter adjusted to `int*`? |
| `auto x = const_ref` | “`x` is another const reference” | Is deduction by value? |
| `return (local)` with `decltype(auto)` | “Parentheses are cosmetic” | Which `decltype` rule applies? |
| Post-operation overflow check | “I inspect whether wrap occurred” | Was the operation already UB? |
| NaN in sorting | “NaN will land at one end” | Does the comparator order the actual domain? |
| `reinterpret_cast<U*>(p)` | “The object is now a `U`” | Is there a live `U`, proper alignment, and legal access? |

### Interview questions

1. Predict the type and value of `std::uint8_t{250} + std::uint8_t{10}`.
   At what point would an 8-bit result appear?
2. Under what width/rank conditions does mixing a signed and unsigned integer
   select a signed common type?
3. Why can `a + b < a` fail as a signed-overflow check even when it appears to
   work in a debug build?
4. When is unsigned wrap a useful invariant, and when does it hide an invalid
   negative result?
5. Explain why `sizeof(array)` and `sizeof(parameter_spelled_as_array)` differ.
6. What facts does `std::span` preserve, and which lifetime fact does it not
   preserve?
7. Contrast `auto`, `auto&`, `decltype(x)`, and `decltype((x))`.
8. Why does `static_cast<Derived*>(base)` require a stronger invariant than
   `dynamic_cast<Derived*>(base)`?
9. Give a valid use of `const_cast` and explain the line at which it becomes
   undefined behavior.
10. Why is an epsilon not a universal solution to floating-point comparison?
11. How can subnormal values create a tail-latency problem, and what evidence
    would justify flushing them to zero?
12. What semantic promises might a compiler's fast-math mode remove? How would
    you bound the change to one workload?

### Conversion prediction drill

For each declaration, state the deduced type before considering its value:

```cpp
int const n = 4;
int data[4]{};

auto a = n;
auto& b = n;
auto c = data;
auto& d = data;
decltype(n) e = n;
decltype((data[0])) f = data[0];
```

Then predict these comparisons assuming 32-bit `int` and `unsigned int`:

```cpp
-1 < 1u
std::uint8_t{255} + 1 == 256
0.0 < std::numeric_limits<double>::quiet_NaN()
```

Answers: `a` is `int`; `b` is `const int&`; `c` is `int*`; `d` is
`int (&)[4]`; `e` is `const int`; `f` is `int&`. The comparisons are false,
true, and false respectively.

### Implementation exercise

Implement a packet boundary helper:

```cpp
template<class To, class From>
std::optional<To> checked_integer(From value);
```

Constrain it to integer types accepted by `std::in_range`, return
`std::nullopt` when the value is not representable, and otherwise return the
converted value. Test:

- negative signed to unsigned;
- `UINT32_MAX` to signed 32-bit;
- a value at each destination boundary;
- a same-signed narrowing success and failure.

Then use it while parsing a signed decoder result into a `std::uint32_t`
sequence number. Keep validation at the boundary and ensure the downstream hot
path uses one sequence type.

### What Chapter 3 Assumes

The next chapter assumes you can distinguish an object from its storage, know
that a pointer conversion does not begin an object lifetime, understand
cv-qualified access paths, and recognize `std::bit_cast` as a value conversion
over object representations rather than permission to violate lifetime or
aliasing rules.
