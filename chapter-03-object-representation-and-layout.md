# Chapter 3 — Object Representation and Layout

*Interview-focused revision notes. The theme: C++ objects are abstractions over bytes, and this chapter is the contract between the two — what the bytes are, what you may legally do with them, and what the hardware charges you for the arrangement.*

---

## 3.1 Object and Value Representation

An **object** is a region of storage with a type, a lifetime, and (optionally) a name. Two distinct byte-level views of it matter:

- **Object representation** — the `sizeof(T)` bytes of storage the object occupies. Formally: the sequence of `unsigned char` objects making up the object.
- **Value representation** — the subset of those bits that participate in determining the object's *value*.

For `int` on x86-64 these coincide: 4 bytes, 32 value bits. They diverge whenever there are **padding bits** or **padding bytes**:

```cpp
struct S { char c; int i; };   // sizeof == 8
// object representation:  [c][pad][pad][pad][i][i][i][i]   ← 8 bytes
// value representation:   [c]                [i][i][i][i]  ← 5 bytes' worth of value
```

Padding bytes have **unspecified values** — and worse, *indeterminate* ones (§3.2). They are not required to be preserved by assignment: `s1 = s2` copies the value, and the compiler is free to copy or not copy the padding. In practice `memcpy`-style struct assignment copies everything, but a compiler that copies member-by-member does not — and both are conforming. This single fact invalidates a startling amount of real code (`memcmp` on structs, hashing structs by bytes, writing structs to disk).

Other cases where the two representations differ:

- **`bool`** — typically 1 byte of storage but only 1 value bit. The other 7 bits are padding. A `bool` whose object representation is `0x02` has **no valid value**, and reading it is UB. This is exactly how `bool b; if (b && !b)` can be true after a bad `memcpy` or type-pun: the compiler tests different bits in different places, or assumes `b` is 0 or 1 and branches on stale reasoning.
- **`long double`** on x86 — 80 bits of value in 128 bits (or 96) of storage. 48 padding bits.
- **Pointers on some architectures** — high bits unused, or tagged.
- **Unions** — the object representation is that of the largest member; only the active member's bytes are value-carrying.

### Accessing the object representation

The **only** legal way is through a pointer to one of the aliasing-exempt types: `char*`, `unsigned char*`, or `std::byte*` (§3.8).

```cpp
template <class T>
void hexdump(const T& v) {
    auto* p = reinterpret_cast<const std::byte*>(&v);   // legal
    for (size_t i = 0; i < sizeof(T); ++i) printf("%02x ", std::to_integer<int>(p[i]));
}
```
Note `signed char*` is *not* on the exemption list for object representation purposes in the same way — the standard's aliasing rule permits `char`, `unsigned char`, and `std::byte`; the "object representation is a sequence of `unsigned char`" wording is what makes `unsigned char` the canonical choice.

**Interview framing:** "What's the difference between `sizeof(T)` and the number of bits that matter?" — the gap is padding, padding is indeterminate, and therefore any operation that treats an object as its bytes (comparison, hashing, serialization, atomic CAS) must account for it. Everything in §3.2 and §3.12 follows from this.

---

## 3.2 Padding and Indeterminate Values

**Indeterminate value** is stronger than "unspecified value." An unspecified value is *some* valid value of the type you just don't know; an **indeterminate** value is not a value at all, and reading it is **undefined behavior** — with the sole exception of reading it through `unsigned char`/`std::byte` (which yields an unspecified value, not UB).

Sources of indeterminate bytes:
1. Uninitialized automatic storage (`int x;` in a function).
2. Freshly allocated dynamic storage (`new char[n]`, `malloc`).
3. **Padding bytes inside any struct**, even a fully-initialized one.
4. The non-active bytes of a union.

Point 3 is the one that surprises people:

```cpp
struct S { char c; int i; };
S a{};             // value-initialization zeroes members — padding is UNSPECIFIED
S b = {'x', 1};
memcmp(&a, &b, sizeof(S));   // reads padding; result is garbage-dependent
```

### Why `memcmp` on structs is a bug

```cpp
bool operator==(const S& a, const S& b) { return memcmp(&a, &b, sizeof a) == 0; }  // WRONG
```
Two structs with identical member values can compare unequal because their padding differs (one came from the stack, one from a zeroed buffer). The failure is intermittent and load-dependent — the worst kind. The same applies to:

- **Hashing a struct by its bytes** — same values, different hash, so your `unordered_map` gets duplicate keys.
- **`std::atomic<S>::compare_exchange_strong`** — this one is genuinely notorious. CAS compares *object representations*, so a struct with padding can fail its CAS forever in a loop even when the values match. `std::atomic_ref` and `atomic<T>` for padded `T` are hazardous; C++20 added wording letting implementations zero padding on atomic stores, but you should not rely on it. Fix: pad the struct explicitly so there are no padding bytes, or CAS on an integer.
- **Writing structs to disk/network** — you leak the contents of padding, which is an **information disclosure vulnerability** (uninitialized stack memory containing pointers, keys, or other users' data). CVE-worthy; this is why the Linux kernel is meticulous about `memset`-ing structs before `copy_to_user`.

### Defusing padding

| Technique | Effect |
|---|---|
| `= {}` / `{}` value-init | Zeroes *members*, not padding (though compilers commonly emit a full zeroing `memset` for large aggregates — not guaranteed) |
| `memset(&s, 0, sizeof s)` before use | Zeroes everything including padding. Legal, and the standard fix for the serialization/CAS cases. Only valid for trivially-copyable types. |
| `static_assert(sizeof(S) == expected)` | Catches accidental padding at compile time |
| `static_assert(std::has_unique_object_representations_v<S>)` | **The precise tool** (C++17): true iff the type has no padding bits and equal values always have equal object representations. If this holds, byte-comparison and byte-hashing are legal. |
| Explicit padding members (`char _pad[3];`) | Makes the layout visible and initializable |
| `#pragma pack` / `[[gnu::packed]]` | Removes padding entirely — at a cost (§3.3) |
| `-Wpadded` | Warns wherever the compiler inserts padding (noisy but useful for hot structs) |

`std::has_unique_object_representations_v<T>` is the single best answer to "how do I know if I can `memcmp` this type?" and is worth memorizing. Note it is false for anything containing a `float`/`double` (because `+0.0` and `-0.0` are equal values with different representations, and NaNs have many representations), which correctly rules out byte-comparing floats.

**C++26 note:** erroneous behavior (P2795) reclassifies reading uninitialized automatic variables from UB to "erroneous" — a diagnosable, non-time-travelling wrong value. Padding remains indeterminate.

---

## 3.3 Size and Alignment

**Alignment** is a requirement that an object's address be a multiple of some power of two, `alignof(T)`. It exists because hardware load/store units fetch naturally-aligned words; misaligned access costs an extra cycle to several hundred, or faults outright.

```cpp
alignof(char)        // 1
alignof(int)         // 4
alignof(double)      // 8
alignof(void*)       // 8   (x86-64)
alignof(long double) // 16  (x86-64 SysV — 16 even though only 10 bytes are used)
alignof(std::max_align_t)  // 16 — the strictest fundamental alignment
```

**Core invariants:**

1. `alignof(T)` is always a power of two.
2. `sizeof(T)` is always a **multiple of `alignof(T)`**. This is what forces tail padding (§3.4) and is *the* reason `struct { int; char; }` is 8 bytes: so that in `T arr[N]`, every element stays aligned. Array contiguity (`&a[i+1] - &a[i] == 1` in units of `sizeof(T)`, with no gaps) demands it.
3. `sizeof(T) >= 1` always — even for an empty class (§3.4), so that distinct objects have distinct addresses.
4. Alignment of a struct = max alignment of its members (before any attributes).

### Overaligned types

`alignas(N)` requests stricter alignment:

```cpp
struct alignas(64) CacheLine { std::atomic<int> counter; };
static_assert(sizeof(CacheLine) == 64);   // size rounds up to satisfy invariant 2
```

This is the standard **false sharing** fix and the most likely low-latency question in this chapter. Two atomics on the same 64-byte cache line cause the line to ping-pong between cores under the MESI protocol — each write invalidates the other core's copy — turning independent operations into a serialized, ~100ns-per-op disaster. Separating them onto distinct lines fixes it.

```cpp
struct alignas(64) PaddedCounter {
    std::atomic<uint64_t> v{0};
    char pad[64 - sizeof(std::atomic<uint64_t>)];
};
```
C++17 gives `std::hardware_destructive_interference_size` (min offset to avoid false sharing) and `std::hardware_constructive_interference_size` (max size to promote true sharing). Caveat: they're compile-time constants, and using them in an ABI-visible struct means your ABI depends on the compiler's guess — GCC warns about exactly this. Many shops hardcode 64 (or 128 on Apple Silicon / Intel with adjacent-line prefetch, where the effective granularity is two lines).

**Alignment cannot be *weakened* by `alignas`** — `alignas(1) int` is ill-formed. To pack, you need `#pragma pack` or `[[gnu::packed]]`, which are *not* the same thing as `alignas` and carry a serious cost: a pointer or reference to a misaligned member is UB to dereference, and on ARM taking `&packed.member` and passing it around can fault. GCC warns via `-Waddress-of-packed-member`. Packed structs are for parsing wire formats in place, and even then `memcpy`-ing fields out is safer (§3.12).

### Overaligned allocation

Before C++17, `new` could not honor `alignas` beyond `max_align_t` — a real bug for SIMD types. C++17 added aligned `operator new`:

```cpp
auto* p = new alignas(64) Foo;          // uses aligned operator new
void* q = std::aligned_alloc(64, 128);  // C11/C++17; size MUST be a multiple of alignment
// std::aligned_storage is deprecated in C++23 — use alignas + std::byte[] instead
```
`std::aligned_alloc`'s "size must be a multiple of alignment" requirement is a classic trap (and MSVC doesn't provide it at all; use `_aligned_malloc` + `_aligned_free`, which must be paired).

### Misaligned access in practice

| Platform | Misaligned scalar load |
|---|---|
| x86-64 | Works; ~free if within a cache line, penalty if it **straddles** a line (~2× latency) or a 4 KB page (much worse) |
| ARMv8 | Works for normal memory; **faults** for device memory and for exclusive/atomic instructions |
| SIMD (`movaps`, and atomics anywhere) | **Faults / loses atomicity** if misaligned |

Regardless of hardware tolerance, **misaligned access is UB in C++** — the compiler may assume alignment and emit aligned SIMD, so "x86 allows it" is not a defense. UBSan's `-fsanitize=alignment` catches it.

**Split-lock** is the low-latency detail worth knowing: an atomic RMW that straddles a cache line on x86 forces the CPU to assert a **bus lock**, stalling *every core* for microseconds. Modern kernels detect and can trap on it (`split_lock_detect`). Never let an atomic be misaligned.

---

## 3.4 Member Layout and Tail Padding

Within an **access-control section** (a run of members with the same `public`/`private`/`protected` label), members are laid out in **increasing address order**. Across sections, the order is unspecified — in practice every mainstream ABI still uses declaration order, but the standard permits reordering, so a struct with mixed access labels formally has unspecified layout.

The compiler **may not reorder members** to save space (unlike Rust). Layout is therefore determined by a simple algorithm:

```
offset = 0
for each member m:
    offset = round_up(offset, alignof(m))     ← internal padding inserted here
    place m at offset;  offset += sizeof(m)
sizeof(S) = round_up(offset, alignof(S))      ← TAIL padding inserted here
```

### The ordering lesson

```cpp
struct Bad  { char a; double b; char c; int d; };   // 24 bytes
// a[1] pad[7] b[8] c[1] pad[3] d[4]  → 24, with 11 bytes wasted

struct Good { double b; int d; char a; char c; };   // 16 bytes
// b[8] d[4] a[1] c[1] pad[2]         → 16, with 2 bytes wasted
```

**Declare members in decreasing order of alignment.** This is a free ~33% memory reduction here, and in a data structure that's hot in cache it's a real throughput win — fewer cache lines touched per object, more objects per line. `pahole` (from `dwarves`) is the tool: it prints struct layouts with holes annotated, and is the standard answer to "how would you find layout waste in a large codebase?"

```
$ pahole -C Bad ./a.out
struct Bad {
        char   a;                 /*  0   1 */
        /* XXX 7 bytes hole, try to pack */
        double b;                 /*  8   8 */
        ...
        /* size: 24, cachelines: 1, members: 4 */
        /* sum members: 14, holes: 2, sum holes: 10 */
```

### Tail padding

Tail padding is the rounding at the end that keeps arrays aligned. Its subtlety is that **it can be reused by a derived class** — but only for non-standard-layout types.

```cpp
struct Base { int i; char c; };           // sizeof 8: i[4] c[1] pad[3]
struct Derived : Base { char d; };        // sizeof 8! d goes INTO Base's tail padding
```
The Itanium ABI reuses tail padding when the base is not a POD/standard-layout type. Consequences:

- **`sizeof(Derived) == sizeof(Base)`** is possible and legal, and confuses people.
- **`memcpy(&derivedAsBase, &otherBase, sizeof(Base))` corrupts `Derived::d`** — because `sizeof(Base)` bytes now overlap a derived member. This is why copying through a base-class pointer with `memcpy` is dangerous and why slicing bugs can be worse than losing data.
- `std::is_standard_layout` being false is the flag; standard-layout types (§3.6) do not have their tail padding reused, which is part of what makes them C-compatible.
- **C++20 `[[no_unique_address]]`** applies the same reuse idea to *members*, letting empty members occupy zero bytes.

### Empty classes and EBO

An empty class has `sizeof == 1` (a padding byte), so distinct objects get distinct addresses. But as a **base class** it can occupy zero bytes — the **Empty Base Optimization**:

```cpp
struct Empty {};
struct A { Empty e; int i; };          // sizeof 8 — e takes a byte + padding
struct B : Empty { int i; };           // sizeof 4 — EBO
struct C { [[no_unique_address]] Empty e; int i; };   // sizeof 4 (C++20)
```
EBO is why `std::vector` with a stateless allocator is 24 bytes (three pointers) rather than 32, why `std::unique_ptr<T, StatelessDeleter>` is the same size as `T*`, and why pre-C++20 libraries inherit from allocators/comparators instead of storing them. `[[no_unique_address]]` finally makes composition as efficient as inheritance — a very common modern-C++ interview point. (MSVC needs `[[msvc::no_unique_address]]` for ABI reasons.)

### Bit-fields

```cpp
struct Flags { unsigned a : 1; unsigned b : 3; int c : 28; };
```
Almost everything about bit-fields is implementation-defined: allocation order within a unit (LSB-first on x86 SysV, MSB-first elsewhere), whether a field may straddle a storage unit, and the signedness of a plain `int` bit-field. A zero-width unnamed field (`unsigned : 0;`) forces alignment to the next unit. **You cannot take the address of a bit-field**, and — critically for concurrency — **adjacent bit-fields are one memory location**, so two threads writing to `a` and `b` without synchronization is a data race even though the fields are logically independent. (A zero-width field between them separates the memory locations.) Bit-fields are fine for compactness within one TU; never use them for wire formats.

---

## 3.5 Trivial and Trivially-Copyable Types

These traits define what the compiler and library may do with an object *as bytes*, which is what unlocks `memcpy`, relocation, and whole-container optimizations.

### The definitions

**Trivially copyable** — every copy constructor, move constructor, copy assignment, move assignment, and the destructor is either **trivial** (compiler-generated, not user-provided, non-virtual, and every base/member's corresponding operation is trivial) or **deleted**, and at least one of the copy/move operations is not deleted. No virtual functions, no virtual bases.

> **The guarantee:** for a trivially copyable `T`, `memcpy`-ing the object representation into another `T` object produces an object with the same value. This is the *only* type category with that promise.

**Trivially default constructible** — the default constructor is trivial: no user-provided ctor, no NSDMIs (`int x = 0;` in-class), no virtuals, all members/bases trivially default constructible. Means: construction is a no-op; the object starts with indeterminate values.

**Trivial type** — trivially copyable **and** trivially default constructible.

```cpp
struct A { int x; };                          // trivial, trivially copyable
struct B { int x = 0; };                       // NOT trivially default constructible (NSDMI)
                                               // but IS trivially copyable
struct C { C(const C&) {} int x; };            // NOT trivially copyable (user-provided copy)
struct D { std::string s; };                   // NOT trivially copyable
struct E { virtual void f(); };                // NOT trivially copyable (vptr)
struct F { F(int){} int x; };                  // trivially copyable, not trivial
```

Note `B`: adding `= 0` to a member costs you triviality of default-construction but *not* trivial copyability. People conflate these constantly.

Traits: `std::is_trivial_v` (deprecated in C++26 as too coarse), `std::is_trivially_copyable_v` (the one that matters), `std::is_trivially_destructible_v`, `std::is_trivially_default_constructible_v`.

### Why it matters — the performance story

- **`std::copy`/`std::vector` growth** dispatch to `memmove` for trivially copyable types. A `vector<int>` reallocation is a single `memcpy`; a `vector<std::string>` is a loop of moves.
- **`std::vector` reallocation uses move-if-noexcept**, so a throwing move constructor forces *copies* — the classic "why is my vector slow" answer, fixed with `noexcept` on your move constructor.
- **Trivially destructible** means the container can skip the destructor loop entirely at teardown.
- **`std::atomic<T>` requires trivially copyable `T`**, because it implements load/store as byte copies. (Padding still bites — §3.2.)
- Passing a small trivially-copyable type by value goes in registers under the SysV ABI; a type with a non-trivial copy ctor or destructor must be passed **by invisible reference (in memory)**, even if it's tiny. This is the hidden cost of adding a destructor to a 8-byte type, and it is a great interview answer: *"a `unique_ptr` is not zero-overhead at ABI boundaries because it isn't trivially copyable, so it can't be passed in a register."*

### Trivial relocatability

Moving an object and destroying the source is *conceptually* a `memcpy` for almost every type — but the standard doesn't say so, so `std::vector` can't `memcpy` a `vector<std::string>` during reallocation even though it would be correct on every real implementation. This is what **P1144 / P2786 trivial relocatability** (C++26) addresses, and folly/BSL ship their own `IsRelocatable` traits to get the optimization today. Knowing this distinguishes candidates: *trivially copyable* ⊄ *relocatable*; `std::string` with SSO is relocatable but not trivially copyable, and a self-referential type (a node with a pointer to itself, or an intrusive list hook) is neither.

---

## 3.6 Standard-Layout Types

**Standard layout** is about *C compatibility and predictable offsets*, orthogonal to triviality (which is about *byte-copyability*).

A class is standard-layout if:
1. All **non-static data members have the same access control** (all public, or all private).
2. **No virtual functions and no virtual base classes.**
3. All non-static data members and base classes are themselves standard-layout.
4. **At most one class in the hierarchy has non-static data members** — i.e. data lives in exactly one class of the inheritance chain.
5. No base class of the same type as the first non-static data member (prevents an address collision under EBO).
6. No reference members.

```cpp
struct SL   { int a; int b; };                        // standard-layout
struct NSL1 { public: int a; private: int b; };        // NOT — mixed access
struct NSL2 { virtual void f(); int a; };              // NOT — vptr
struct SLd  : SL { };                                  // standard-layout (base has the data)
struct NSLd : SL { int c; };                           // NOT — data in two classes
```

### What standard layout guarantees

- **Members are laid out in declaration order at ascending offsets**, with no reordering.
- **`offsetof` is well-defined** (§3.11). It's conditionally-supported UB otherwise.
- **A pointer to the object is interconvertible with a pointer to its first member:**
  ```cpp
  struct S { int first; double d; };
  S s;
  int* p = reinterpret_cast<int*>(&s);       // legal; points to s.first
  S* back = reinterpret_cast<S*>(p);         // legal round trip
  ```
  This is the formal basis for the C idiom of "inheritance" by embedding a base struct as the first member, and for casting a `struct sockaddr_in*` to `struct sockaddr*`.
- **The common initial sequence rule** for unions (§3.11) — you may read the common leading members of any standard-layout struct in a union regardless of which is active.
- **No tail-padding reuse** by derived classes (§3.4), so `sizeof` behaves predictably.

### The four-way matrix

|  | Trivially copyable | Standard layout |
|---|---|---|
| **Concerns** | Can I `memcpy` it? | Where are the bytes, and is it C-compatible? |
| Virtual functions | Disqualifies | Disqualifies |
| Mixed access control | Fine | **Disqualifies** |
| User-provided copy ctor / dtor | **Disqualifies** | Fine |
| `std::string` member | Disqualifies | Fine (string is standard-layout in practice, but a member with a user-provided ctor doesn't break standard layout) |
| Reference member | Disqualifies (no assignment) | **Disqualifies** |

**POD** ("plain old data") was the old term meaning *trivial **and** standard-layout*. It was deprecated in C++20 (`std::is_pod` deprecated) precisely because it conflated two independent properties, and the interview answer to "what is a POD?" is now: *an obsolete conjunction; ask which property you actually need — `is_trivially_copyable` for `memcpy`, `is_standard_layout` for `offsetof` and C interop.* That decomposition is exactly the point the committee was making, and stating it scores well.

---

## 3.7 Implicit-Lifetime Types

This section resolves a long-standing gap between what C++ formally said and what every C and C++ programmer actually wrote.

### The problem

Object lifetime formally begins when a constructor completes (or, for trivial types, when storage is obtained *and* the object is "created"). But this was UB:

```cpp
void* buf = malloc(sizeof(int));
*static_cast<int*>(buf) = 42;      // pre-C++20: UB — no int object was ever CREATED here
```
There is storage, and there are bytes, but no `int` *object* — and you may not access an object that doesn't exist. By the letter of the standard, essentially every allocator, every ring buffer, every deserializer, and `std::vector` itself were undefined. Compilers of course made it work; the standard was simply wrong.

### The fix (C++20, P0593, retroactively applied)

**Implicit-lifetime types** are: scalar types, arrays, aggregates of implicit-lifetime types, and class types with at least one trivial eligible constructor and a trivial (non-deleted) destructor. Roughly: types that need no constructor to be meaningful.

Certain operations **implicitly create objects** of implicit-lifetime types in the storage they touch, choosing whichever set of objects would make the program well-defined:

- `malloc`, `calloc`, `realloc`, `operator new`, `operator new[]`, `std::allocator::allocate`
- `memcpy` and `memmove` into a region
- `std::bit_cast`
- Starting the lifetime of an array of `unsigned char` or `std::byte` (its bytes may implicitly host other objects)

So the `malloc` example above is now well-defined: `malloc` implicitly created an `int` there.

### `std::start_lifetime_as` (C++23)

The remaining hole: you have bytes from *somewhere else* — `read()` into a buffer, `mmap`, shared memory, a DMA region — and no implicitly-creating operation ever ran on them.

```cpp
// C++23
char buf[sizeof(Header)];
::read(fd, buf, sizeof buf);
const Header* h = std::start_lifetime_as<Header>(buf);   // no code emitted; formally creates the object
uint32_t v = h->field;                                    // now legal
```
It compiles to **nothing** — it is purely a statement to the abstract machine, like `std::launder`. Requirements: `Header` must be implicit-lifetime, and the storage must be suitably sized and aligned.

Compare the three tools, a favorite disambiguation question:

| Tool | Purpose | Cost |
|---|---|---|
| `std::start_lifetime_as<T>(p)` | Declare that existing bytes *are* a `T`. No value change. | Zero |
| `std::bit_cast<T>(x)` | Produce a **new** `T` object with `x`'s bytes. Copies. | Zero (optimized) |
| `std::launder<T>(p)` | Refresh a pointer after the object at that address was replaced, defeating the compiler's assumption that it's still the old object | Zero |
| Placement `new (p) T{...}` | Actually run a constructor at `p` | Constructor cost |

`std::launder` deserves a sentence: it exists because the compiler may cache the value of `const` members or the vptr across an in-place replacement (`new (&obj) T{...}` where `T` has const members or is polymorphic). Using the *old* pointer afterwards is UB; `std::launder(&obj)` yields a usable one. It is not a general aliasing tool and it does not make `reinterpret_cast` legal.

**Interview framing:** *"Was `std::vector` undefined behavior before C++20?"* — Formally yes; implicit object creation was added to legalize what allocators, containers, and every C-style buffer had always done. That's a strong signal of standards literacy.

---

## 3.8 Type Punning and Strict Aliasing

(Ch. 2 §2.14 introduced the rule; here is the full mechanism and the correct toolkit.)

### The rule

An object may be accessed only through a glvalue of:
- its own dynamic type, or a cv-qualified version;
- the signed or unsigned variant of its type;
- a type that is an aggregate/union containing it;
- a base class of it;
- **`char`, `unsigned char`, or `std::byte`**.

Anything else is UB. The compiler exploits this by assuming that a `float*` and an `int*` **never refer to the same memory**, which lets it keep values in registers across stores and reorder loads.

```cpp
void f(int* i, float* g) {
    *i = 1;
    *g = 2.0f;      // compiler assumes this can't touch *i
    // may reload nothing; *i is known to still be 1
}
```
That assumption is the entire value of the rule: without it, every store through any pointer would invalidate every cached load, and C++ would lose most of its optimization advantage over dynamically typed languages. Fortran's lack of aliasing is why it beat C at numerics for decades, and why `restrict` exists.

### The classic broken pun

```cpp
float fast_inv_sqrt(float x) {
    int i = *(int*)&x;                 // UB — accessing a float through int lvalue
    i = 0x5f3759df - (i >> 1);
    return *(float*)&i;                // UB again
}
```
At `-O2`, GCC and Clang genuinely produce wrong results for code shaped like this. "It worked for years" means the optimizer hadn't gotten around to it yet.

### The correct toolkit

| Method | Standard | Cost | Notes |
|---|---|---|---|
| **`std::bit_cast<To>(from)`** | C++20 | Zero (single `mov`) | Requires same size + both trivially copyable. `constexpr`. **The right default.** |
| **`memcpy`** | Always | Zero (every compiler recognizes it) | Works pre-C++20; the idiomatic legacy answer |
| `unsigned char*` / `std::byte*` | Always | Zero | Legal for *reading the object representation*, byte by byte |
| Union punning | **C: legal; C++: formally UB** | Zero | GCC and Clang document it as a supported extension; MSVC too. Common in practice, not portable by the standard. |
| `reinterpret_cast` and dereference | Never legal (except the exempt types) | — | Compiles, works sometimes, breaks under optimization |
| `-fno-strict-aliasing` | Compiler flag | Loses optimizations | What the Linux kernel does. A legitimate engineering choice, not a fix. |

```cpp
uint32_t bits = std::bit_cast<uint32_t>(3.14f);   // correct, constexpr, free
float f = std::bit_cast<float>(bits);
```

### Nuances worth having ready

- **The exemption is one-directional.** You may read *any* object's bytes through `char*`. You may **not** take a `char` array and read it as an `int` — that's the `start_lifetime_as` case (§3.7).
- **`std::byte` is the modern choice** over `char*` because it forbids accidental arithmetic.
- **`restrict`** (`__restrict` in C++; not standard C++) is the opposite promise: "nothing else aliases this pointer." It enables vectorization in numeric kernels; violating it is UB with no diagnostic.
- **Aliasing and inlining:** the classic `void add(int* a, int* b, int* out)` cannot be vectorized without either `__restrict` or a runtime overlap check, which is exactly what compilers emit (a "vectorize if no overlap, else scalar loop" pair). Recognizing that duplicated-loop pattern in generated assembly is a nice thing to mention.
- `char*`'s exemption means it can alias everything, which *pessimizes* code using `char*` heavily. This is a real reason to use `uint8_t`-typed... no — `uint8_t` is usually `unsigned char`, so it also aliases everything. Use a distinct type or `std::byte` and be aware the aliasing cost remains.

---

## 3.9 Endianness and Byte Swapping

**Endianness** is the order in which the bytes of a multi-byte scalar are stored.

```
uint32_t v = 0x12345678;

little-endian (x86, ARM default, RISC-V):  78 56 34 12   ← LSB at lowest address
big-endian    ("network order", SPARC,      12 34 56 78   ← MSB at lowest address
               s390x, older MIPS/PowerPC)
```

Little-endian is dominant today; big-endian survives in network protocols, some mainframes and embedded targets, and file formats. ARM and PowerPC are **bi-endian** (switchable at boot/per-page), so "ARM is little-endian" is a default, not a guarantee.

### Detection and conversion

```cpp
// C++20 — the correct way
if constexpr (std::endian::native == std::endian::little) { ... }
static_assert(std::endian::native == std::endian::little || 
              std::endian::native == std::endian::big);   // mixed-endian is possible in theory
```
Pre-C++20 the union trick was the standard hack. Never detect endianness at runtime in a hot path — it's a compile-time property.

**Swapping:**
```cpp
// C++23
uint32_t s = std::byteswap(v);
// pre-C++23: compiler intrinsics, which map to a single BSWAP/REV instruction
__builtin_bswap16/32/64      // GCC/Clang
_byteswap_ushort/ulong/uint64 // MSVC
htonl/htons/ntohl/ntohs      // POSIX, only 16/32-bit, and named for network order
```
A hand-written shift-and-mask swap is usually recognized and folded to `BSWAP` by GCC/Clang, but the intrinsic is guaranteed and clearer. Byte swapping is essentially free (1 cycle, and often folded into the load on x86 via `MOVBE`).

### The design lesson

**Do not `memcpy` structs across a network or into a file.** The failure modes stack up: endianness, padding (§3.2), `sizeof(long)` differences (Ch. 2 §2.1), alignment, and struct layout changes between versions. The correct pattern is explicit field-by-field serialization to a defined byte order:

```cpp
void write_u32_be(std::byte* p, uint32_t v) {
    p[0] = std::byte(v >> 24); p[1] = std::byte(v >> 16);
    p[2] = std::byte(v >> 8);  p[3] = std::byte(v);
}
uint32_t read_u32_be(const std::byte* p) {
    return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 
         | uint32_t(p[2]) << 8  | uint32_t(p[3]);
}
```
This shift-based form is **endianness-independent by construction** — it never depends on the host's layout, so there's no `#ifdef`, and compilers optimize it to a load plus `BSWAP`. It is strictly better than `ntohl(*(uint32_t*)p)`, which is both an aliasing violation and a potentially misaligned load.

**Low-latency caveat:** in trading systems, the exchange protocol's byte order is fixed and the swap is on the critical path. Little-endian binary protocols (SBE, ITCH variants) exist precisely to avoid the swap on x86; where you must swap, do it as part of the parse with `MOVBE` or SIMD `PSHUFB` for bulk conversion.

**Bit-fields are not endianness-portable** either — bit allocation order within a unit differs between ABIs, so a bit-field struct that parses a protocol correctly on x86 will parse it wrongly on a big-endian target. Use explicit shifts and masks for wire formats.

---

## 3.10 Pointer Arithmetic and Provenance

### The formal rules (recap and sharpening)

Pointer arithmetic is defined only **within a single array object**, including the one-past-the-end position; a non-array object counts as an array of one.

```cpp
int a[10];
int* p = a + 10;   // legal — one past the end
*p;                // UB
int* q = a + 11;   // UB — merely COMPUTING it is undefined
int* r = a - 1;    // UB — no "one before the beginning"
```
Note the asymmetry: one-past-the-end is blessed (so `end()` iterators work), one-before-the-beginning is not (so reverse iteration must be written with care — this is why `std::reverse_iterator` stores the *next* position and dereferences `*(it-1)`).

Comparing pointers into **different** objects with `<` is unspecified; with `==` it's well-defined. `std::less<T*>` is guaranteed to give a total order even across objects, which is why it's what you use for pointer keys in ordered containers.

### Provenance

**Provenance** is the idea that a pointer carries not just an address but an invisible tag identifying *which object it was derived from*, and that it may only be used to access that object.

The consequence is genuinely counterintuitive:

```cpp
int a[10], b[10];
int* p = a + 10;                 // one-past-end of a
int* q = b;                      // start of b
// Suppose the allocator placed b immediately after a, so p and q hold the SAME address.
if (p == q) {                    // may be true!
    *p = 1;                      // still UB — p's provenance is `a`, not `b`
}
```
Same bit pattern, different provenance, different legality. This is why "I checked the addresses are equal" does not license access.

Provenance also breaks the round-trip intuition:
```cpp
uintptr_t addr = reinterpret_cast<uintptr_t>(&x);
int* p = reinterpret_cast<int*>(addr);   // round trip through the SAME value: OK
int* q = reinterpret_cast<int*>(addr ^ 0 );  // laundering through arithmetic: murky
```
The standard guarantees the direct round-trip. Reconstructing a pointer from an integer computed some other way (XOR-linked lists, pointer tagging, hashing an address and rebuilding it) is formally undefined — provenance was lost. **XOR-linked lists are the canonical example of a data structure that cannot be written in standard C++.**

Practical implications and mitigations:

- **Pointer tagging** (stuffing flags in the low alignment bits or the unused high 16 bits on x86-64) is ubiquitous in high-performance code and formally UB-adjacent. It works because compilers don't currently exploit provenance aggressively for integer round-trips, but ARM's **top-byte-ignore** and **MTE (memory tagging)** make the high-bit variant actively dangerous on modern hardware. If you tag, use the low bits (guaranteed zero by alignment) and mask before dereferencing.
- **`std::assume_aligned`** (C++20) lets you tell the compiler a pointer is over-aligned without a cast, recovering the vectorization you'd otherwise lose.
- The C committee's **PNVI** provenance models and C++'s P2434 are the ongoing formalization work; the pragmatic summary is: *derive pointers from pointers, not from integers.*

**Interview framing:** "Two pointers compare equal — can you use either one interchangeably?" The expected shallow answer is yes; the correct answer is no, because of provenance, and the one-past-the-end example demonstrates it concretely.

---

## 3.11 Layout Compatibility and `offsetof`

### `offsetof`

```cpp
#include <cstddef>
static_assert(offsetof(Packet, length) == 4);
```
`offsetof(type, member)` yields the byte offset of `member`. It is defined for **standard-layout** types (§3.6); for others it is *conditionally supported* — compilers accept it and generally give the right answer, but there's no guarantee, and it genuinely breaks with virtual bases (where a member's offset isn't a compile-time constant at all).

`offsetof` implementations use `((T*)0)->member` tricks, which is why they historically warned; modern compilers have a `__builtin_offsetof`.

The **container_of** idiom — recovering the enclosing struct from a pointer to a member — is the reason `offsetof` exists and is the backbone of intrusive data structures (the Linux kernel's `list_head`, Boost.Intrusive):

```cpp
template <class T, class M>
T* container_of(M* member_ptr, size_t offset) {
    return reinterpret_cast<T*>(reinterpret_cast<std::byte*>(member_ptr) - offset);
}
```
Intrusive containers matter for low latency: the node is embedded in the object, so insertion allocates nothing, removal is O(1) without a lookup, and there's one cache miss instead of two (no separate node indirection). The cost is that an object can belong to a fixed set of lists and the container doesn't own lifetime.

### Layout compatibility

Two types are **layout-compatible** if they have the same layout, meaning you can (in limited, defined ways) treat one as the other:

- Two **enumerations** are layout-compatible if they have the same underlying type.
- Two **standard-layout structs** are layout-compatible if their members, pairwise in order, have layout-compatible types (and, since C++14, the same bit-field widths).
- `signed T` and `unsigned T` are **not** layout-compatible (they're only aliasing-compatible).

### The common initial sequence rule

The one place layout compatibility gives you a real permission — reading through the "wrong" union member:

```cpp
struct A { int type; int x; };
struct B { int type; double y; };
union U { A a; B b; };

U u; u.a = {1, 42};
if (u.b.type == 1) { ... }    // LEGAL — `type` is in the common initial sequence
                              // reading u.b.y would be UB (not the active member)
```
The **common initial sequence** is the longest run of leading members with layout-compatible types. Both structs must be standard-layout, and the union must be visible. This is the standard-blessed foundation of **tagged unions** in C and C++, and it's the mechanism behind the `struct sockaddr` family.

Caveat: GCC and Clang implement this correctly, but it interacts badly with strict aliasing in older compilers, and it's easy to accidentally step outside the common initial sequence. In modern C++, prefer **`std::variant`**, which gives you the same tagged-union semantics with type safety and correct lifetime management — at the cost of an index byte, a jump-table dispatch on `std::visit`, and the never-valueless-guarantee complexity. For a *hot* dispatch path, a hand-rolled tagged union or a virtual call may still beat `std::visit`, and knowing when to reach past `variant` is a legitimate low-latency answer.

---

## 3.12 ABI-Safe Wire and Shared-Memory Layouts

The synthesis section: what do you actually do when bytes must be read by *another program, another compiler, another machine, or a later version of yourself*?

### The threat model

| Hazard | Source |
|---|---|
| Padding differs / leaks data | §3.2 |
| Alignment requirements differ | §3.3 |
| Member order / tail padding reuse | §3.4 |
| `sizeof(long)` differs (LP64 vs LLP64) | Ch. 2 §2.1 |
| Endianness differs | §3.9 |
| `bool`/`enum` size unspecified | Ch. 2 §2.10 |
| Bit-field allocation order | §3.4 |
| Pointers are meaningless in another address space | — |
| Virtual functions: the vtable pointer is process-local | §3.5 |

The last two are the killers for **shared memory**: a `std::string`, `std::vector`, `std::map`, or any polymorphic type placed in shared memory stores pointers valid only in the writing process. Mapping the segment at a different base address in the reader makes every one of them garbage. This is why Boost.Interprocess provides offset pointers and its own allocators.

### The rules

**1. Fix every width and sign.** `int32_t`, `uint64_t`. Never `int`, `long`, `size_t`, `bool`, or a plain `enum`. For booleans use `uint8_t`; for enums use a fixed underlying type and serialize the integer.

**2. Eliminate padding by construction.** Order members largest-alignment-first and add explicit padding members so the struct is naturally packed, then assert it:

```cpp
struct alignas(8) Order {
    uint64_t id;          // 0
    int64_t  price;       // 8   (fixed-point; never float on the wire)
    uint32_t quantity;    // 16
    uint16_t symbol_id;   // 20
    uint8_t  side;        // 22
    uint8_t  _reserved;   // 23  explicit, initialized, not "padding"
};
static_assert(sizeof(Order) == 24);
static_assert(alignof(Order) == 8);
static_assert(std::is_standard_layout_v<Order>);
static_assert(std::is_trivially_copyable_v<Order>);
static_assert(std::has_unique_object_representations_v<Order>);
static_assert(offsetof(Order, quantity) == 16);
```
That block of static_asserts is the deliverable. It converts every hazard above into a compile error, it documents the format, and it's exactly what an interviewer wants to see you write. `has_unique_object_representations_v` is the strongest single assertion — it fails if any padding exists anywhere in the type.

**3. Prefer `#pragma pack` only for parsing foreign formats you don't control** — and even then, `memcpy` fields out rather than dereferencing misaligned members (§3.3), because taking the address of a packed member is UB and faults on strict-alignment targets.

**4. Fix endianness explicitly** with shift-based read/write helpers (§3.9), not `memcpy` + conditional swap.

**5. Never put floating point on the wire** unless the format demands it — use fixed-point integers (price in ticks, or scaled by 10⁴). Avoids NaN/subnormal representation questions entirely, and is exact.

**6. Version the format.** A leading `uint16_t version` and never reordering or reusing fields. Additive-only evolution, or a real IDL.

### Reading bytes into a struct, legally

```cpp
// The portable, always-correct pattern:
Order o;
std::memcpy(&o, buffer, sizeof o);        // implicit object creation + no aliasing violation
                                          // also fixes alignment: buffer need not be aligned

// C++23 zero-copy in-place, when the buffer is aligned and lifetime is right:
const Order* o = std::start_lifetime_as<Order>(buffer);
```
`memcpy` is not a performance concern — for a small struct it's a couple of loads and stores, and the compiler elides it into direct register loads. The zero-copy `start_lifetime_as` path matters only for large messages or when parsing millions per second, and it requires you to guarantee alignment yourself.

### Shared memory specifics

- Use `offsetof`-style **relative offsets** or indices into the segment, never raw pointers. `boost::interprocess::offset_ptr` does this; a hand-rolled `uint32_t` index into a slab array is faster and simpler.
- Map at a fixed address (`MAP_FIXED`) only if you fully control both sides — it's fragile with ASLR.
- Anything with a vtable, a `std::string`, or a heap-allocating container is disqualified.
- Synchronization across processes needs `PTHREAD_PROCESS_SHARED` mutexes or lock-free structures built on `std::atomic` — and `std::atomic<T>` in shared memory requires `is_always_lock_free`, otherwise the implementation uses a lock table that is **process-local** and provides no cross-process safety at all. `static_assert(std::atomic<T>::is_always_lock_free)` is mandatory here.

That last point is a superb interview detail: a `std::atomic<MyStruct>` in shared memory can silently be *not* atomic across processes.

---

## Key Interview Questions

1. **What is the difference between object representation and value representation?** — All `sizeof(T)` bytes vs the bits that determine the value; the gap is padding, which is indeterminate.
2. **Why is `memcmp` on two structs an unreliable equality test?** — Padding bytes are indeterminate and need not be preserved by assignment; use `has_unique_object_representations_v` to know when it's safe.
3. **Why is `sizeof(struct{char c; int i;})` 8 and not 5?** — Internal padding for `int`'s alignment plus tail padding so `sizeof` is a multiple of `alignof`, which keeps array elements aligned.
4. **How would you reduce the size of a hot struct without changing its members?** — Reorder members in decreasing alignment order; verify with `pahole` and `static_assert`.
5. **What is false sharing and how do you fix it?** — Independent variables on one cache line causing MESI ping-pong; `alignas(64)` / `hardware_destructive_interference_size`.
6. **Difference between trivially copyable and standard layout?** — `memcpy`-ability vs C-compatible predictable offsets; independent properties, and their conjunction was the deprecated "POD".
7. **Why can adding a destructor to an 8-byte type make it slower?** — It stops being trivially copyable, so the SysV ABI passes it in memory instead of a register.
8. **Why is `sizeof(Derived)` sometimes equal to `sizeof(Base)`?** — Tail-padding reuse for non-standard-layout bases.
9. **What is the Empty Base Optimization and what replaced it in C++20?** — Zero-size empty bases; `[[no_unique_address]]` extends it to members.
10. **Was `std::vector` technically UB before C++20?** — Yes; implicit object creation (P0593) retroactively legalized building objects in raw allocated storage.
11. **What is `std::start_lifetime_as` for, and how does it differ from `bit_cast` and `launder`?** — Declaring that existing bytes are an object (zero cost, no copy) vs producing a new object from bytes vs refreshing a pointer after in-place replacement.
12. **How do you legally type-pun a `float` to `uint32_t`, and why is `*(int*)&f` wrong?** — `std::bit_cast`/`memcpy`; the cast violates strict aliasing, which the optimizer relies on to keep values in registers.
13. **Why does strict aliasing exist at all?** — Without it every store invalidates every cached load; it's the foundation of C++'s optimization model.
14. **Two pointers compare equal — may you use them interchangeably?** — No: provenance. One-past-the-end of `a` and the start of `b` can be equal yet only one may access `b`.
15. **How do you safely send a struct over the network?** — Fixed-width types, explicit padding, explicit byte order via shifts, no floats, no pointers, versioned, and a wall of `static_assert`s.
16. **What goes wrong with `std::atomic<T>` in shared memory?** — If it isn't `is_always_lock_free`, the implementation uses a process-local lock table and provides no cross-process atomicity.
17. **When is `offsetof` well-defined, and what is it used for?** — Standard-layout types; the `container_of` idiom underpinning intrusive containers.
18. **What is the common initial sequence rule?** — For a union of standard-layout structs, you may read the shared leading members regardless of the active member — the formal basis of tagged unions.

---

## Common Traps

- **`memcmp`/byte-hashing structs with padding** — intermittent inequality for equal values.
- **`std::atomic<Padded>::compare_exchange` looping forever** because CAS compares padding.
- **Writing structs to disk or the network** — leaks uninitialized padding (a security bug) and is not portable.
- **Assuming `= {}` zeroes padding.** It zeroes members.
- **Assuming members are laid out in declaration order across access-control sections.** Formally unspecified.
- **Expecting the compiler to reorder members for you.** C++ never does; you must.
- **`alignas` cannot reduce alignment** — packing needs `#pragma pack`, which then makes member addresses unsafe.
- **Taking the address of a packed member** — UB, faults on ARM, warned by `-Waddress-of-packed-member`.
- **Misaligned atomics** → split lock → whole-machine stall.
- **`std::aligned_alloc` with a size that isn't a multiple of the alignment.**
- **Forgetting `sizeof(Derived) == sizeof(Base)` is possible** and `memcpy`-ing `sizeof(Base)` bytes over a `Derived`.
- **Conflating trivially copyable with trivially default constructible** — an NSDMI kills the latter, not the former.
- **Assuming trivially copyable implies relocatable** (or vice versa) — self-referential types are neither; `std::string` is relocatable but not trivially copyable.
- **`*(int*)&floatVar` type punning** — breaks at `-O2`.
- **Union punning in C++** — legal in C, formally UB in C++ (though a documented GCC/Clang extension).
- **Bit-fields in wire formats** — allocation order is ABI-defined.
- **Adjacent bit-fields are one memory location** — writing two "independent" fields from two threads is a data race.
- **Reconstructing a pointer from an integer computed by arithmetic** (XOR lists, tagged pointers in high bits) — provenance loss, and MTE/TBI make high-bit tagging actively break.
- **`a - 1` for an array `a`** — UB even without dereferencing.
- **Putting `std::string`/`std::vector`/polymorphic types in shared memory.**
- **Assuming `bool` is 1 byte with only 0/1** — a type-punned `bool` holding 2 makes `b && !b` true.

---

## Compact Recall Summary

**Representation.** Object representation = all `sizeof(T)` bytes; value representation = the bits that matter. The difference is padding, which is **indeterminate** and not required to be copied. Access bytes only through `char`/`unsigned char`/`std::byte`. `std::has_unique_object_representations_v<T>` is the gate for `memcmp`/byte-hashing/CAS.

**Alignment.** `alignof` is a power of two; `sizeof` is always a multiple of `alignof` (hence tail padding, hence array contiguity). `alignas` can only strengthen. Overalignment fixes **false sharing** (`alignas(64)`); misalignment costs a straddle penalty, or a **split lock** that stalls every core for an atomic.

**Layout.** Members ascend in declaration order within an access section; the compiler never reorders. Order members by decreasing alignment (`pahole` to verify). Tail padding may be reused by derived classes for non-standard-layout bases. Empty bases cost zero (EBO); `[[no_unique_address]]` extends that to members. Bit-fields are ABI-defined and adjacent ones share a memory location.

**Categories.** *Trivially copyable* → `memcpy` preserves value → `std::atomic<T>`, register passing, `memmove` in containers. *Standard layout* → predictable offsets, `offsetof`, first-member interconvertibility, common initial sequence, C interop. Independent axes; "POD" was their deprecated conjunction. Trivial relocatability is a *third*, non-standard-yet axis (C++26).

**Lifetime.** Implicit-lifetime types are implicitly created by `malloc`/`new`/`memcpy`/`bit_cast` (C++20, retroactive — this is what legalized `std::vector`). `std::start_lifetime_as` (C++23) covers bytes from `read`/`mmap`. `launder` refreshes pointers after in-place replacement. All three cost nothing.

**Aliasing.** Access an object only through its own type, a signed/unsigned variant, a base, or `char`/`unsigned char`/`std::byte`. The rule exists so stores don't invalidate cached loads. Pun with `std::bit_cast` or `memcpy`; `reinterpret_cast`-and-dereference breaks at `-O2`; union punning is a C feature and a C++ extension.

**Endianness.** Little-endian dominant; `std::endian::native`, `std::byteswap`. Serialize with explicit shifts — endianness-independent by construction and still one `BSWAP` after optimization.

**Provenance.** A pointer is (address + origin object). Equal addresses do not imply interchangeable pointers. Arithmetic is legal only within one array, plus one-past-the-end (never one-before). Derive pointers from pointers, never from computed integers.

**Wire/shm.** Fixed-width types, no `bool`/`long`/plain-`enum`, explicit padding members, explicit byte order, fixed-point instead of float, no pointers, no vtables, versioned — then lock it down with `static_assert` on `sizeof`, `alignof`, `is_standard_layout`, `is_trivially_copyable`, `has_unique_object_representations`, and `offsetof`. In shared memory, additionally require `atomic<T>::is_always_lock_free` or you get no cross-process atomicity at all.
