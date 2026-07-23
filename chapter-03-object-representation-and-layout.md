# Chapter 3 — Object Representation and Layout

C++ lets you reason about values, but low-latency code eventually meets their
bytes. A feed handler copies from a receive buffer, a ring stores objects in
preallocated slots, an intrusive container recovers an object from a member
address, and a shared-memory transport exposes data created by another process.
Each technique crosses at least one boundary between storage, object lifetime,
type, and representation.

The useful interview model is:

> **Storage supplies addresses and bytes. An object's lifetime and type make
> typed access legal. Its representation explains what bytewise operations
> preserve. The ABI and hardware determine the observed layout and cost.**

Confusing those layers creates bugs that survive testing and fail under a new
compiler, optimization level, process, or machine. Keeping them separate also
makes performance arguments testable: layout can reduce cache-line traffic, but
no layout trick repairs an invalid lifetime or aliasing violation.

## Why this matters — Core

Interviewers ask about padding, `memcpy`, `reinterpret_cast`, alignment, and
wire structs because one question tests several skills at once:

- Can you state the language rule before describing what x86-64 happens to do?
- Can you predict a struct's likely layout without claiming that one ABI's
  choices are universal?
- Can you identify undefined behavior that an optimizer may exploit?
- Can you defend a cache-layout change with a workload and a measurement?
- Can you design a binary boundary that remains valid across versions?

In production, the correctness failures are quiet. Bytewise equality may
observe padding. A pointer into reused storage may still denote the old object.
A packed member may be misaligned. A native struct written to a socket may
encode the host's endianness, padding, and data-model choices. The low-latency
costs are equally concrete: larger records touch more cache lines, poorly
placed writers cause coherence traffic, and field-by-field parsing creates
work that may or may not matter after measurement.

## 90-second screen — Core

Retain these facts:

1. **Storage is not automatically an object.** Typed access needs an object of
   a type whose lifetime has begun, although C++20 and C++23 provide important
   implicit-lifetime rules.
2. **Object representation is all `sizeof(T)` bytes.** Value representation is
   the bits that participate in representing a value. Padding belongs to the
   former, not the latter.
3. **`sizeof(T)` includes padding.** Array elements are exactly `sizeof(T)`
   bytes apart, so a complete type's size accommodates its alignment.
4. **Trivially copyable, standard-layout, and implicit-lifetime answer different
   questions.** Do not replace them with the vague word “POD.”
5. **Byte inspection and typed access are different permissions.** Character
   types and `std::byte` may inspect an object's representation; that does not
   make arbitrary type punning legal.
6. **A C++ pointer is not merely an integer address.** Arithmetic is bounded by
   an array object, and portable code preserves the pointer's connection to the
   object from which it was derived.
7. **A native struct is not a portable protocol.** Define field widths, byte
   order, offsets, validation, and versioning explicitly.

Be ready to defend two decisions:

- Reorder a hot in-process record only after measuring working-set or
  cache-line benefit; freeze a public binary layout instead of casually
  reordering it.
- Decode a foreign wire format field by field. Use a direct typed view only
  under a deliberately fixed ABI, alignment, lifetime, endianness, and version
  contract.

## 3.1 The four-layer mental model — Core

The smallest reliable model has four layers:

```text
storage         bytes at an address; size and alignment are available
   │ begin lifetime
   ▼
object          a typed entity exists in that storage
   │ inspect/copy representation under the language rules
   ▼
representation  value bits plus any padding bits
   │ implementation chooses concrete layout and instructions
   ▼
ABI + hardware  offsets, calling convention, cache lines, load/store costs
```

These layers answer different questions.

| Question | Governing layer | Typical trap |
|---|---|---|
| Is there enough suitably aligned space? | Storage | `sizeof(T)` bytes at an arbitrary byte address may be misaligned |
| May I dereference `T*` here? | Object lifetime and type accessibility | A cast changes a pointer expression, not the object that exists |
| Does `memcpy` preserve the value? | Representation and type category | Byte-copying a `std::string` copies internal pointers, not ownership |
| Is member `x` at offset 8? | Standard guarantee plus ABI | An observed build is mistaken for a portable format |
| Will denser records lower latency? | Hardware and workload | Smaller `sizeof` is celebrated without measuring cache misses or tails |

### Objects, bytes, and memory

An **object** is a region of storage with a type and lifetime. It may have a
name, but it need not: a dynamically allocated object and a temporary are still
objects. A subobject is an object nested within another object, such as a data
member, base-class subobject, or array element.

Storage alone is weaker. This declaration creates suitably aligned bytes:

```cpp
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>

struct Quote {
    std::uint64_t sequence;
    std::int64_t price;
};

alignas(Quote) std::byte slot[sizeof(Quote)];

Quote* first = ::new (static_cast<void*>(slot)) Quote{17, 10'025};
// Quote's lifetime has begun; typed access through first is valid.
std::destroy_at(first);
// The storage remains, but that Quote's lifetime has ended.
```

The object occupies the same addresses as `slot`, but “these addresses contain
bytes” and “a live `Quote` exists here” are distinct statements. This distinction
drives storage reuse, allocators, deserialization, and pointer validity later in
the chapter.

### Three registers for every claim

Use one of these labels mentally whenever you discuss layout:

| Register | What it can establish | Example |
|---|---|---|
| C++23 guarantee | Portable source-level correctness | `sizeof(char) == 1`; array elements are contiguous |
| Implementation or ABI contract | Binary compatibility for a named toolchain and target | SysV AMD64 member offsets and calling convention |
| Hardware observation | Cost on a named processor and workload | A load crossing a cache-line boundary costs more in a benchmark |

“My compiler prints 24” establishes only an observation. An ABI document can
strengthen that into a platform contract. Neither makes 24 a language
guarantee. Strong interview answers identify which register supports each
claim.

## 3.2 Object and value representation — Core

For a complete object of type `T`, the **object representation** is the sequence
of `sizeof(T)` `unsigned char` objects that occupy it. The **value
representation** is the set of bits in that representation that participate in
representing a value of `T`. Bits outside the value representation are padding
bits.

Consider a common 64-bit ABI:

```cpp
struct Event {
    std::uint8_t  kind;
    std::uint32_t sequence;
};
```

An implementation may produce:

```text
offset       0       1       2       3       4       5       6       7
object      kind   padding padding padding  sequence sequence sequence sequence
value?       yes      no      no      no       yes      yes      yes      yes
```

This drawing is an **annotated observation**, not a portable promise.
`std::uint32_t` itself is optional, though present on mainstream targets, and
the implementation chooses the alignment. Verify actual values with
`sizeof`, `alignof`, and `offsetof` on the supported target.

Multiple representations may denote values that compare equal. IEEE-754
`+0.0` and `-0.0`, on implementations using that format, compare equal but
have different sign bits. Conversely, some bit patterns for some types may not
represent a usable value. Therefore “same bytes,” “same C++ value,” and “equal
under this program's business rule” are three different predicates.

### A safe byte dump

`std::bit_cast` gives a compact byte snapshot when the source and destination
have equal size and are trivially copyable:

```cpp
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <type_traits>

template<class T>
void dump_bytes(const T& value) {
    static_assert(std::is_trivially_copyable_v<T>);
    const auto bytes =
        std::bit_cast<std::array<std::byte, sizeof(T)>>(value);

    for (std::byte byte : bytes) {
        std::cout << std::hex << std::setw(2) << std::setfill('0')
                  << std::to_integer<unsigned>(byte) << ' ';
    }
    std::cout << '\n';
}

int main() {
    dump_bytes(std::uint32_t{0x01020304});
}
```

On a little-endian machine this commonly prints `04 03 02 01`; on a
big-endian machine it commonly prints `01 02 03 04`. The program observes the
implementation rather than guessing it.

The alternative is to view a live object's representation through
`const char*`, `const unsigned char*`, or `const std::byte*`. Those types receive
a special type-accessibility permission. The permission is for bytes; it does
not grant permission to turn any byte sequence into an arbitrary typed object.

### Copying a representation

For a trivially copyable `T`, the standard provides a powerful round trip: its
underlying bytes may be copied into an array of `char`, `unsigned char`, or
`std::byte`, then copied back into the original complete object, and the object
recovers its original value. Copying between distinct live `T` objects with
`std::memcpy` also gives the destination the source value.

The guarantee does not make every representation valid, does not make a
non-trivially-copyable type byte-copyable, and has qualifications for
potentially overlapping subobjects such as base subobjects. Prefer ordinary
copy or move operations unless representation-level copying is the mechanism
you actually need.

## 3.3 Size, alignment, and member layout — Core

`sizeof(T)` is the number of bytes occupied by a complete `T`, including
internal and tail padding. `alignof(T)` is the alignment requirement for `T`.
The implementation defines the set of valid alignments; mainstream ABIs
normally use powers of two, but portable reasoning should not elevate that
practice into a universal C++ rule.

For an array `T values[N]`, elements are contiguous:

```text
&values[0]       &values[1]       &values[2]
     │<-- sizeof(T) -->│<-- sizeof(T) -->│
```

Every element must satisfy `T`'s alignment, so the complete-object size
includes enough tail padding for the next element. In practice, and as required
for arrays of `T`, `sizeof(T)` is a multiple of `alignof(T)`.

`alignas` can request a stricter valid alignment:

```cpp
#include <atomic>
#include <cstdint>

struct alignas(64) PublishedSequence {
    std::atomic<std::uint64_t> value{0};
};

static_assert(alignof(PublishedSequence) >= 64);
static_assert(sizeof(PublishedSequence) % alignof(PublishedSequence) == 0);
```

The number 64 is a design assumption here, not “the C++ cache-line size.”
`std::hardware_destructive_interference_size` provides an implementation value
intended to help avoid false sharing, but an ABI-visible layout based on that
constant can vary across builds. For a deployed system, choose a supported
hardware contract, isolate it in configuration, and measure.

### Predicting a struct layout

Since C++23, later-declared non-variant, non-zero-sized data members have higher
addresses, regardless of access control. Earlier language modes had weaker
rules involving access-control groups. The implementation does not silently
reorder ordinary members to minimize size.

A typical ABI lays out each member at the next address satisfying that member's
alignment, then rounds the complete size for the enclosing type's alignment:

```cpp
struct Unsorted {
    std::uint8_t  side;
    std::uint64_t order_id;
    std::uint16_t venue;
};

struct Sorted {
    std::uint64_t order_id;
    std::uint16_t venue;
    std::uint8_t  side;
};
```

Under an ABI where `uint64_t`, `uint16_t`, and `uint8_t` have alignments 8, 2,
and 1:

```text
Unsorted (likely 24 bytes)
0 side | 1..7 pad | 8..15 order_id | 16..17 venue | 18..23 tail pad

Sorted (likely 16 bytes)
0..7 order_id | 8..9 venue | 10 side | 11..15 tail pad
```

Confirm rather than assume:

```cpp
#include <cstddef>
#include <iostream>

int main() {
    std::cout << sizeof(Unsorted) << ' ' << alignof(Unsorted) << '\n';
    std::cout << offsetof(Unsorted, order_id) << '\n';
    std::cout << sizeof(Sorted) << ' ' << alignof(Sorted) << '\n';
}
```

Ordering by decreasing alignment is a useful starting heuristic, not a law.
Fields used together may deserve proximity even if a different order saves a
few bytes. A smaller array element can reduce cache lines and memory bandwidth;
splitting hot and cold fields can do more. Measure representative traversal,
cache misses, throughput, and a tail percentile under the production-sized
working set.

### Tail padding, empty state, and overlap

**Tail padding** lies after the last value-carrying member. It makes the next
array element align correctly. Some ABIs may reuse a base-class subobject's tail
padding in a derived object; the exact reuse is an ABI matter, and a base
subobject is a potentially overlapping subobject for byte-copy guarantees.

Empty complete objects still need nonzero size so distinct objects of the same
type can have distinct addresses. Implementations can remove that space for an
empty base through the Empty Base Optimization. Since C++20,
`[[no_unique_address]]` permits a potentially-overlapping member:

```cpp
struct StatelessTag {};

struct TaggedPrice {
    [[no_unique_address]] StatelessTag tag;
    std::int64_t price;
};
```

The attribute permits overlap; it does not promise a particular `sizeof`.
It can also allow reuse of a non-empty member's tail padding. Do not infer that
two declared members necessarily have distinct addresses when this attribute
is present, and do not expose such layout casually as a binary contract.

### Packed layout is not ordinary layout

`#pragma pack` and attributes such as `[[gnu::packed]]` are extensions, not
portable C++23. They can reduce holes, but a packed member may sit at an address
that does not satisfy its type's normal alignment. Forming or dereferencing a
misaligned typed pointer is outside the C++ contract even on hardware that
tolerates some unaligned loads.

For a foreign packed format, copy a field's bytes into an aligned scalar and
then convert byte order. This usually becomes an efficient unaligned load where
the target supports one, without lying to the compiler about alignment.

## 3.4 Padding and indeterminate values — Core

Padding is part of the object representation but not the value representation.
Its contents are not a stable semantic property of an object. Store operations
may write padding, assignment may preserve it or not, and two objects with
equal member values may carry different padding bytes.

Do not compress this into the inaccurate slogan “padding is always random.”
Zero-initialization has rules that can initialize padding bits to zero in
particular cases, and implementations often clear whole objects. The durable
rule is narrower:

> **Unless the type's representation contract proves otherwise, do not use
> padding as input to equality, hashing, ordering, serialization, or a protocol.**

This comparison has defined byte-reading mechanics but the wrong semantics:

```cpp
#include <cstdint>
#include <cstring>

struct Key {
    std::uint8_t venue;
    std::uint32_t instrument;
};

bool wrong_equal(const Key& left, const Key& right) {
    return std::memcmp(&left, &right, sizeof(Key)) == 0;
}

bool value_equal(const Key& left, const Key& right) {
    return left.venue == right.venue &&
           left.instrument == right.instrument;
}
```

`wrong_equal` can report unequal for equal member values because it compares the
whole object representation. The same defect appears in raw-byte hashes.
Writing complete object representations to an external sink can additionally
expose stale storage through padding on real implementations.

### Indeterminate is a use rule, not a synonym for padding

Bytes or objects that have not received a value may have an **indeterminate
value**. In C++23, most evaluations that produce an indeterminate value have
undefined behavior. The detailed exceptions for ordinary `unsigned char` and
`std::byte` in specific expressions exist so raw storage can be manipulated;
they do not make an uninitialized scalar safe to read as its scalar type.

```cpp
void bad() {
    int sequence;          // no initialization
    if (sequence == 0) {   // undefined behavior: lvalue-to-rvalue conversion
        // ...
    }
}
```

Bytewise library operations can copy representations without interpreting each
byte as a scalar value. A later typed read still requires that the resulting
representation be valid for the type.

### `memset` is not a constructor

All-bits-zero is not a portable spelling of every type's zero or null value,
and it says nothing about a class invariant. It is commonly correct for
protocol records consisting only of selected unsigned integer fields, but
“trivially copyable” alone does not prove that a zero-filled representation is
valid and meaningful.

Use member initialization or a constructor to establish values. If a fixed
binary record requires explicit reserved bytes, make them real members and
initialize them:

```cpp
struct Header {
    std::uint32_t sequence{};
    std::uint16_t length{};
    std::uint8_t  flags{};
    std::uint8_t  reserved{};  // protocol byte, not hidden padding
};
```

`std::has_unique_object_representations_v<T>` is a useful conservative test.
When true, `T` is trivially copyable and two objects with the same value have
the same object representation; padding bits are therefore absent. The trait
may be false for reasons other than padding, such as multiple floating-point
representations of equal values. It also knows nothing about business-level
equality—for example, whether two instrument identifiers should compare after
normalization.

### Atomic comparison

`std::atomic<T>` requires `T` to be trivially copyable. Since C++20, atomic
compare-exchange is specified in terms of the **value representation**, so
padding bits that never participate in any value are ignored. Multiple value
representations for the same logical value can still matter; NaN encodings and
union representations deserve care. `compare_exchange_weak` may also fail
spuriously by design.

The interview answer “CAS compares all padding and can therefore loop forever”
is outdated for C++23. The better design question is whether a composite atomic
has a canonical, well-understood value representation and whether the
implementation is lock-free for the deployment target.

## 3.5 Type properties: ask the right question — Core

The old label “POD” blurred several independent properties. C++23 code should
name the property that supports the operation.

| Property | Governing question | What it does **not** promise |
|---|---|---|
| Trivially copyable | May complete object values be copied through their bytes? | Fixed offsets, no padding, portable wire layout |
| Trivial | Is the type trivially copyable and trivially default constructible? | Zero-initialized default state |
| Standard-layout | Does the class obey restrictions enabling layout-oriented interoperation? | Trivial copying, same layout on every ABI |
| Implicit-lifetime | Can specified storage-producing operations implicitly begin its lifetime? | Validity of arbitrary incoming bytes |
| Unique object representations | Do equal values have identical representations? | The program's semantic equality rule |

None of the first three implies the other two in general.

### Trivial and trivially copyable

A **trivially copyable** class has only trivial or deleted eligible copy/move
constructors and assignments, has at least one eligible copy/move operation,
and has a trivial non-deleted destructor. Scalar types and arrays of trivially
copyable types are also trivially copyable. Use the library trait rather than
reimplementing the wording:

```cpp
#include <string>
#include <type_traits>

struct Price {
    long value;
};

struct NamedPrice {
    long value;
    std::string name;
};

static_assert(std::is_trivially_copyable_v<Price>);
static_assert(!std::is_trivially_copyable_v<NamedPrice>);
```

The meaningful guarantee is byte copying for a live complete object, subject
to the representation rules already discussed. It does not mean “contains no
pointers”: a raw pointer is trivially copyable, but its copied address may be
meaningless in another process. It also does not mean “safe to relocate any
object with `memmove`.” C++23 has no general standard trait granting arbitrary
bytewise relocation for library containers.

A **trivial type** is trivially copyable and has at least one eligible trivial
default constructor. A member initializer or user-provided default constructor
can make default construction non-trivial while copying remains trivial:

```cpp
struct Counter {
    std::uint64_t value = 0;
};

static_assert(std::is_trivially_copyable_v<Counter>);
static_assert(!std::is_trivial_v<Counter>);
```

At the ABI layer, trivial special members can influence whether a small object
is passed in registers or indirectly, but the exact classification belongs to
the named calling convention. Inspect generated code at the real interface
instead of generalizing from “small.”

### Standard-layout

Standard-layout is a structural category designed for restricted
layout-oriented interoperability. Among its conditions, a class has:

- no non-static data member of non-standard-layout class type or reference type;
- no virtual functions or virtual base classes;
- the same access control for all non-static data members;
- no non-standard-layout base class;
- at most one base-class subobject of any given type;
- all non-static data members and bit-fields first declared in one class in the
  hierarchy;
- no base class of a type forbidden by the first-member rule.

The complete formal predicate has edge cases; use
`std::is_standard_layout_v<T>` as the gate.

```cpp
struct PublicPair {
    std::uint32_t first;
    std::uint32_t second;
};

class MixedAccess {
public:
    std::uint32_t first;
private:
    std::uint32_t second;
};

static_assert(std::is_standard_layout_v<PublicPair>);
static_assert(!std::is_standard_layout_v<MixedAccess>);
```

For a standard-layout object with non-static data members, a pointer to the
object is pointer-interconvertible with a pointer to its first member, subject
to the rules for unions and base classes. `offsetof` is conditionally supported
only for non-standard-layout types, which means portability is no longer
guaranteed.

Standard-layout does **not** make C++ and C declarations automatically
compatible, does not fix widths or endianness, and does not prevent
implementation-chosen padding. Cross-language compatibility still requires the
two implementations' ABI and type contracts.

## 3.6 Implicit lifetime and storage reuse — Core

Allocation, construction, lifetime, and initialization are related but not
synonyms:

```text
obtain storage ──► begin lifetime ──► establish a usable value ──► use object
                         │
                         └────────────► end lifetime ──► reuse/release storage
```

Ordinary declarations and `new` often perform several arrows together. Custom
allocators, arenas, packet buffers, and shared memory force you to reason about
them separately.

### Implicit-lifetime types

C++20 repaired an important mismatch between raw-storage practice and the
formal object model. An **implicit-lifetime type** is:

- a scalar type;
- an implicit-lifetime class type;
- an array of an implicit-lifetime type; or
- a cv-qualified version of one.

An implicit-lifetime class is an aggregate whose destructor is not
user-provided, or a class with at least one trivial eligible constructor and a
trivial non-deleted destructor. The category is broader than “trivial” and is
not the same as “trivially copyable.”

Specified operations can implicitly create suitable implicit-lifetime objects
in a storage region if doing so makes the program's subsequent operations
defined. These include `std::malloc`/`std::calloc`/`std::realloc`, allocation
functions named `operator new` or `operator new[]`, and
`std::allocator<T>::allocate`. `std::memcpy` and `std::memmove` can implicitly
create suitable objects in their destination region. Beginning the lifetime of
an array of `unsigned char` or `std::byte` can also provide storage for nested
objects.

```cpp
#include <cstdint>
#include <cstdlib>
#include <new>

struct Header {
    std::uint32_t length;
    std::uint32_t sequence;
};

void example() {
    void* raw = std::malloc(sizeof(Header));
    if (raw == nullptr) {
        throw std::bad_alloc{};
    }

    // C++20+: malloc may implicitly create a Header here.
    auto* header = static_cast<Header*>(raw);
    header->length = 32;
    header->sequence = 7;

    std::free(raw);
}
```

Implicit creation does not run a constructor, does not initialize the bytes,
and does not recursively rescue a subobject whose type is not itself eligible.
It also does not decree that arbitrary network bytes form a valid `Header`.

### `std::start_lifetime_as` in C++23

When bytes already exist, C++23's `std::start_lifetime_as<T>` can explicitly
start the lifetime of an implicit-lifetime complete object in suitably sized
and aligned storage while preserving the bytes as its representation.

```cpp
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

struct Header {
    std::uint32_t length;
    std::uint32_t sequence;
};

alignas(Header) std::array<std::byte, sizeof(Header)> bytes{};

// Assume bytes now contain a valid native Header representation.
Header* view = std::start_lifetime_as<Header>(bytes.data());
```

This is a lifetime operation, not a parser. `bytes` must have suitable
alignment and extent; `Header` must meet the function's requirements; and the
representation must yield values that are valid to read. Host byte order and
native padding remain unchanged. For a foreign packet, explicit decoding is
usually the correct operation.

Support for this C++23 library API arrived unevenly across standard libraries.
That is a toolchain availability issue, not permission to substitute a
dereferenced `reinterpret_cast`.

### Reusing storage

Placement construction begins a new lifetime at an existing address. The
previous object's lifetime must be handled correctly:

```cpp
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>

struct Quote {
    std::uint64_t sequence;
    std::int64_t price;
};

void reuse() {
    alignas(Quote) std::byte storage[sizeof(Quote)];

    Quote* old = ::new (static_cast<void*>(storage)) Quote{1, 10'000};
    std::destroy_at(old);

    Quote* current =
        ::new (static_cast<void*>(storage)) Quote{2, 10'025};
    auto sequence = current->sequence;
    (void)sequence;
    std::destroy_at(current);
}
```

Use the pointer returned for the new object. Under the
**transparent-replaceability** rules, some names and pointers to the old object
automatically refer to the replacement after its lifetime begins. The
conditions exclude cases such as a complete `const` object and potentially
overlapping subobjects. `std::launder` obtains a pointer to a newly created
object in cases where an old pointer cannot transparently retarget, provided an
object of the requested type really exists at that address and the reachability
requirements hold.

`std::launder` does not begin a lifetime, repair alignment, convert bytes, or
waive aliasing. If no new `T` exists, laundering a `T*` invents nothing.

Storage reuse has two practical traps:

- Explicitly destroying a non-trivial automatic object and then allowing scope
  exit without reconstructing the expected type can cause a second destructor
  call on a non-live object.
- Reusing storage occupied by a complete `const` object with static, thread, or
  automatic storage duration is undefined behavior.

An arena avoids allocation and can improve locality, but it assumes ownership
of these lifetime transitions. Validate it with sanitizers where applicable,
tests that exercise destruction paths, and profiles showing allocation or
locality was material.

## 3.7 Type accessibility, aliasing, and legal punning — Core

A glvalue used to access an object's stored value must have a
**type-accessible** type. The allowed families include:

- a type similar to the object's dynamic type;
- the corresponding signed or unsigned type;
- a signed or unsigned type corresponding to a cv-qualified dynamic type;
- an aggregate or union type that includes one of the permitted types;
- a base-class type of the dynamic type; or
- `char`, `unsigned char`, or `std::byte`.

This rule underlies what programmers call **strict aliasing**. It lets an
optimizer reason that stores through unrelated typed pointers do not change one
another's objects:

```cpp
float broken(std::uint32_t bits) {
    // Undefined behavior: no float object is type-accessible through this
    // dereference merely because the sizes happen to match.
    return *reinterpret_cast<float*>(&bits);
}
```

`reinterpret_cast` can change a pointer's static type. It does not create a
`float`, start a lifetime, prove alignment, or grant type accessibility.

### `std::bit_cast` is the value-punning default

For equal-size trivially copyable source and destination types,
`std::bit_cast<To>(from)` creates a `To` value whose representation corresponds
to the source bits:

```cpp
#include <bit>
#include <cstdint>

float decode_ieee_binary32(std::uint32_t bits) {
    static_assert(sizeof(float) == sizeof(bits));
    return std::bit_cast<float>(bits);
}
```

This code is structurally legal C++23. Its application-level meaning still
assumes the received bits use the implementation's `float` representation. If
the protocol says IEEE-754 binary32 and the implementation does not, a real
conversion is required.

`std::memcpy` remains the portable pre-C++20 idiom and is still useful when
sizes are known only in ordinary code:

```cpp
#include <cstdint>
#include <cstring>

float decode_with_memcpy(std::uint32_t bits) {
    float result;
    static_assert(sizeof(result) == sizeof(bits));
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}
```

Optimizing compilers recognize fixed-size `memcpy`; benchmark or inspect code
generation before replacing it with undefined behavior for presumed speed.

### Byte inspection is one-way permission

Reading a live `T` through `const std::byte*` can inspect its object
representation. Starting with a `std::byte` buffer and dereferencing a
`reinterpret_cast<T*>` is a different direction: it additionally needs a live
`T`, correct alignment, enough storage, and a valid representation. Use
construction, an applicable implicit-creation rule, `std::start_lifetime_as`,
or decode into a real object.

General union punning—write one member, read an unrelated inactive member—is
not portable C++. Some compilers document extensions. The standard common
initial sequence permission, covered later, is narrower. A compiler extension
can be a deliberate project choice, but name the compiler contract and test the
flags that enable it.

### Worked diagnosis: “works at `-O0`, fails at `-O2`”

Suppose a decoder does this:

```cpp
std::uint32_t read_word(const std::byte* input) {
    return *reinterpret_cast<const std::uint32_t*>(input); // broken
}
```

Diagnose it in order:

1. **Lifetime:** the buffer contains byte objects; no argument establishes a
   live `uint32_t` there.
2. **Alignment:** `input` may not satisfy `alignof(uint32_t)`.
3. **Type accessibility:** byte-inspection permission does not reverse into
   typed access.
4. **Byte order:** even a legal native load would interpret host order, which
   may differ from the protocol.
5. **Bounds:** the function does not prove four readable bytes exist.

A correct fixed-width big-endian reader avoids all five:

```cpp
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>

std::uint32_t read_u32_be(std::span<const std::byte> input) {
    if (input.size() < 4) {
        throw std::runtime_error("short field");
    }

    return (std::to_integer<std::uint32_t>(input[0]) << 24) |
           (std::to_integer<std::uint32_t>(input[1]) << 16) |
           (std::to_integer<std::uint32_t>(input[2]) << 8)  |
            std::to_integer<std::uint32_t>(input[3]);
}
```

The shifts define byte order, byte access has the right type, and `span`
expresses bounds. On a supported target, inspect optimized assembly and
benchmark representative message batches; compilers often combine the
operations into efficient loads and swaps.

At this point the interview-critical core is complete. The remaining sections
add pointer-model depth and binary-boundary design.

## 3.8 Pointer arithmetic and provenance — Deep dive

Pointer arithmetic is defined within an array object. A pointer may range from
the first element through the one-past-the-end position; the one-past pointer
may be compared or subtracted appropriately but not dereferenced. A non-array
object behaves like an array of one for these rules.

```cpp
int values[4]{};

int* begin = values;
int* end = values + 4;  // valid one-past pointer
auto count = end - begin;

// *end = 1;            // undefined behavior: one-past is not an element
// int* bad = values+5; // undefined behavior: outside the permitted range
```

Subtracting pointers is defined when both point into, or one past, the same
array object and the result fits `std::ptrdiff_t`. Built-in relational
comparison outside the defined object relationships does not provide the
portable address ordering people often expect. Library comparators such as
`std::less<T*>` provide a strict total order suitable for standard containers.

### Provenance as a working model

Through C++23, the standard's pointer rules are distributed across object
lifetime, pointer values, arithmetic, casts, and reachability rather than
presented as one complete “provenance model.” Still, provenance is a useful
engineering term: a pointer retains a connection to the storage instance and
object from which it was derived, not merely a numeric address.

That model explains why adjacent arrays do not become one array:

```cpp
int left[4]{};
int right[4]{};

int* left_end = left + 4;
// Even if an implementation places right at the same numeric address as
// left_end, left_end is not a pointer to right[0] and cannot access it.
```

It also explains lifetime-sensitive reuse. An allocator can return the same
address for a new object, yet a pointer to the old storage instance may be
invalid. Placement replacement follows its own transparent-replaceability and
laundering rules; numeric equality is not enough.

### Pointer–integer conversions

`std::uintptr_t` exists only on implementations that provide an unsigned
integer type capable of holding converted object-pointer values. A pointer
converted to an integer of sufficient size and back to the same pointer type is
guaranteed to recover the original pointer value. The reverse direction and
arithmetic on the integer have fewer portable guarantees.

Low-bit pointer tagging is common in allocators and lock-free structures:

```text
aligned pointer bits:  ...xxxxxxxxxx000
tagged integer bits:   ...xxxxxxxxxx101
```

It can be valid under a named implementation contract, but C++23 does not give
a general portable recipe saying arbitrary mask/or operations preserve every
property needed for dereference. Hardware features such as tagged addresses,
capability pointers, pointer authentication, or memory tagging make the
address-is-an-integer assumption increasingly fragile.

A defensible design states:

- the exact supported ABI and pointer representation;
- which alignment supplies tag bits;
- where tags are removed before forming a usable pointer;
- how sanitizers and target hardware treat the scheme;
- the measured memory or synchronization benefit; and
- a non-tagged rollback implementation.

Prefer indices or offsets when they naturally represent ownership inside an
arena. They serialize and validate more cleanly than process addresses.

## 3.9 Endianness and byte swapping — Role-specific

**Endianness** is the byte order used for a multi-byte scalar's object
representation. For the value `0x01020304`:

```text
lowest address                                      highest address
little-endian:       04          03          02          01
big-endian:          01          02          03          04
```

C++20 exposes the implementation order through `std::endian`. It permits
implementations whose scalar types do not all use a single pure little- or
big-endian order:

```cpp
#include <bit>

if constexpr (std::endian::native == std::endian::little) {
    // native integral representation is little-endian
}
```

C++23 adds `std::byteswap` for integral values:

```cpp
#include <bit>
#include <cstdint>

constexpr std::uint32_t reversed =
    std::byteswap(std::uint32_t{0x01020304});
static_assert(reversed == 0x04030201);
```

The function expresses an integer byte reversal. It does not by itself say
whether swapping is required. Protocol code should name the conversion:
“read big-endian field into host value,” not “swap,” because on a big-endian
host the correct conversion is no swap.

Two good decoder shapes are:

- Shift from bytes, as in `read_u32_be`; it is alignment-safe and
  endianness-independent by construction.
- `memcpy` into an aligned fixed-width integer, then conditionally
  `std::byteswap` according to `std::endian::native`.

Measure both on the target compiler and processor. For scalar packet fields the
compiler often emits comparable code. For large batches, vectorized shuffle
instructions may improve throughput, but they add complexity and can hurt
small-message latency. Report message sizes, batch size, cache state, and
percentiles rather than calling byte swapping “free.”

Bit-fields are not a wire-order solution. Allocation direction, allocation
unit, and other details are implementation-defined. Use masks and shifts on a
defined integer field.

## 3.10 Layout compatibility and `offsetof` — Reference

`offsetof(T, member)` reports a member's byte offset. It is defined by the
standard library for standard-layout `T`; support for other classes is
conditional. The result still belongs to the current implementation:

```cpp
#include <cstddef>
#include <cstdint>
#include <type_traits>

struct Record {
    std::uint32_t sequence;
    std::uint16_t length;
};

static_assert(std::is_standard_layout_v<Record>);
static_assert(offsetof(Record, sequence) == 0);
// Assert other offsets only when this implementation layout is the contract.
```

Offsets enable intrusive structures, memory-mapped layouts, device interfaces,
and foreign-function bindings. Each use must also establish lifetime,
alignment, and ownership. Subtracting an offset from an arbitrary member-like
address does not prove that a live enclosing object exists.

### Layout-compatible types

C++ defines **layout-compatible** types narrowly. Two standard-layout class
types are layout-compatible when their corresponding entities and
alignment requirements satisfy the standard's layout-compatibility rules.
Layout-compatible enumerations share an underlying type. This concept does not
generally grant permission to alias one complete object through the other
class type.

The most useful permission is the **common initial sequence** of
standard-layout struct types in a union. The common initial sequence is the
longest leading run of layout-compatible members that also satisfies the
alignment and attribute conditions:

```cpp
#include <cstdint>

struct TradeMessage {
    std::uint8_t kind;
    std::uint32_t sequence;
    std::uint64_t price;
};

struct CancelMessage {
    std::uint8_t kind;
    std::uint32_t sequence;
    std::uint64_t order_id;
};

union Message {
    TradeMessage trade;
    CancelMessage cancel;
};

Message message{.trade = {1, 7, 10'025}};
std::uint8_t tag = message.cancel.kind; // common initial sequence: permitted
```

Access beyond the common sequence through the inactive member is not permitted.
General inactive-member punning remains non-portable. In new code, a separate
tag plus `std::variant`, or an explicitly decoded payload, often makes lifetime
and active-member state clearer. A hand-written union can still be appropriate
when measurement proves dispatch or footprint matters, but it owns the manual
lifetime rules.

## 3.11 ABI-safe wire and shared-memory layouts — Role-specific

“ABI-safe” is meaningful only after naming the boundary. There are three
different designs:

| Boundary | Reasonable contract | Main risk |
|---|---|---|
| Portable wire/file format | Explicit bytes, widths, order, version | Parser validation and conversion cost |
| Fixed-ABI in-process or same-build image | Compiler/target/layout assertions | Rebuild silently changes layout |
| Cross-process shared memory | OS ABI plus offsets and process-shared synchronization | Pointers, lifetime, recovery, atomics |

The portable default is explicit serialization. A direct native layout is an
optimization for a deliberately narrower compatibility envelope.

### Why a native struct is not a protocol

Even a standard-layout, trivially copyable struct leaves these choices open:

- widths of types such as `int`, `long`, `size_t`, pointers, and enums;
- padding and alignment;
- byte order;
- floating-point representation and exceptional values;
- compiler and ABI layout decisions;
- meaning of pointers and virtual-table pointers;
- format evolution and validation.

`#pragma pack` removes only some padding under one implementation. It does not
solve byte order, type widths, lifetime, versioning, or misaligned access.

### A portable 23-byte order message

Define the bytes first:

| Offset | Width | Field | Encoding |
|---:|---:|---|---|
| 0 | 8 | order id | unsigned, big-endian |
| 8 | 8 | price ticks | signed two's-complement bit pattern, big-endian |
| 16 | 4 | quantity | unsigned, big-endian |
| 20 | 2 | symbol id | unsigned, big-endian |
| 22 | 1 | side | `1 = buy`, `2 = sell` |

The format is 23 bytes because the protocol says so, not because a C++ struct
happens to have that size.

```cpp
#include <bit>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

struct DecodedOrder {
    std::uint64_t order_id;
    std::int64_t price_ticks;
    std::uint32_t quantity;
    std::uint16_t symbol_id;
    std::uint8_t side;
};

std::uint64_t read_u64_be(std::span<const std::byte, 8> bytes) {
    std::uint64_t result = 0;
    for (std::byte byte : bytes) {
        result = (result << 8) | std::to_integer<std::uint64_t>(byte);
    }
    return result;
}

std::optional<DecodedOrder>
decode_order(std::span<const std::byte> bytes) {
    if (bytes.size() < 23) {
        return std::nullopt;
    }

    auto u16 = [](std::span<const std::byte> field) {
        return static_cast<std::uint16_t>(
            (std::to_integer<std::uint16_t>(field[0]) << 8) |
             std::to_integer<std::uint16_t>(field[1]));
    };
    auto u32 = [](std::span<const std::byte> field) {
        return (std::to_integer<std::uint32_t>(field[0]) << 24) |
               (std::to_integer<std::uint32_t>(field[1]) << 16) |
               (std::to_integer<std::uint32_t>(field[2]) << 8)  |
                std::to_integer<std::uint32_t>(field[3]);
    };

    const auto id = read_u64_be(
        std::span<const std::byte, 8>{bytes.data(), 8});
    const auto price_bits = read_u64_be(
        std::span<const std::byte, 8>{bytes.data() + 8, 8});
    const auto side = std::to_integer<std::uint8_t>(bytes[22]);
    if (side != 1 && side != 2) {
        return std::nullopt;
    }

    return DecodedOrder{
        id,
        std::bit_cast<std::int64_t>(price_bits),
        u32(bytes.subspan(16, 4)),
        u16(bytes.subspan(20, 2)),
        side
    };
}
```

The code validates length before access, validates the enum-like field, does
not require input alignment, and defines byte order. The signed field is
specified as a two's-complement bit pattern; C++20 and later require the
standard signed integer representation used here, and `bit_cast` preserves the
bits without an out-of-range unsigned-to-signed conversion.

For a real feed, validate every reserved bit, range, and message-type-specific
length required by the protocol. Decide whether malformed input drops the
packet, increments a counter, disconnects the session, or stops the process.
That policy affects tail latency and operational safety more than the syntax of
the four-byte load.

### Controlled native layouts

Sometimes two endpoints are built together for one target, and avoiding decode
copies is worth the narrower contract. Make the assumptions executable:

```cpp
struct alignas(8) NativeOrder {
    std::uint64_t order_id;
    std::int64_t price_ticks;
    std::uint32_t quantity;
    std::uint16_t symbol_id;
    std::uint8_t side;
    std::uint8_t reserved;
};

static_assert(std::is_trivially_copyable_v<NativeOrder>);
static_assert(std::is_standard_layout_v<NativeOrder>);
static_assert(sizeof(NativeOrder) == 24);
static_assert(alignof(NativeOrder) == 8);
static_assert(offsetof(NativeOrder, quantity) == 16);
static_assert(offsetof(NativeOrder, side) == 22);
```

These assertions reject an incompatible build; they do not create portability.
Also pin compiler/ABI options, endianness, format version, and initialization of
`reserved`. Add a golden-byte test produced and consumed by every supported
build.

The benefit condition is that decoding or copying is measurable on the target
path. The cost is a frozen ABI and a harder rollout. The rollback is the
explicit decoder. Measure end-to-end throughput and latency percentiles with
real message sizes; a saved copy may disappear in noise while the operational
coupling remains.

### Shared memory is more than layout

Raw pointers, references, vtable pointers, and standard containers containing
process-local pointers are not portable across mappings. Prefer relative
offsets or validated indices:

```text
segment base + checked uint32 offset ──► object within this mapping
```

The reader must validate that an offset is in range, suitably aligned, and
points to the expected object/version before typed use. An offset also needs a
sentinel convention and overflow-safe addition.

C++ itself specifies threads in one program, not a complete cross-process
shared-memory ABI. An `std::atomic<T>` being
`is_always_lock_free` is useful evidence that the implementation will not
silently route operations through an ordinary process-local lock, but it is
not sufficient to prove cross-process correctness. The operating system,
compiler, standard library, hardware memory type, mapping attributes, object
initialization protocol, and crash-recovery design must jointly guarantee the
scheme. Platform process-shared primitives may be the appropriate contract.

Shared-memory design must answer:

- Which process creates and initializes each object, and how do readers learn
  initialization is complete?
- Are all participants built for the same data model, ABI, and atomic
  implementation?
- What happens if a writer dies halfway through a record?
- How are version upgrades coordinated?
- How are offsets and lengths validated against a corrupt segment?
- What synchronization gives the required publication and visibility?

Zero-copy is not zero-cost. It trades copies for validation, alignment
constraints, synchronization, page faults, cache coherence, and lifecycle
coupling. Measure the full handoff, including tail latency during contention
and process restart.

## 3.12 Worked design choice: hot record or frozen record? — Role-specific

Suppose an order table holds ten million records. Profiling shows lookup misses
the last-level cache frequently, and a likely ABI layout reports:

```cpp
struct Before {
    std::uint8_t state;
    std::uint64_t id;
    std::uint32_t quantity;
    std::uint16_t venue;
}; // observed size: 24

struct After {
    std::uint64_t id;
    std::uint32_t quantity;
    std::uint16_t venue;
    std::uint8_t state;
}; // observed size: 16
```

Reason through the decision:

1. **Condition:** Records are held densely in a private in-process array, and
   traversals touch most fields. No external format depends on offsets.
2. **Mechanism:** The measured implementation saves eight bytes per element.
   Ten million elements reduce nominal storage from about 240 MB to 160 MB.
   That can reduce cache lines and memory bandwidth during scans.
3. **Cost:** Source and debug layout changes; a hidden serializer that copies
   native bytes would break, revealing that it already had a faulty contract.
4. **Prerequisite:** Confirm `sizeof`, offsets, and member usage on every
   supported target; ensure concurrency does not rely on field separation.
5. **Success measure:** Benchmark representative lookups and scans with the
   production working set, reporting throughput, median, and high-percentile
   latency plus cache-miss counters.
6. **Rollback:** Restore the order or split hot fields into a separate
   structure if locality becomes worse.

Now change one fact: the record is mapped from a file used by two deployed
versions. Reordering is no longer a private optimization. The correct options
are to retain the frozen versioned layout, introduce a new version with a
conversion path, or stop mapping C++ records directly and adopt an explicit
format. The same eight bytes do not justify silently violating the boundary.

## Recall and practice — Core

### Recall card

- Storage provides bytes; lifetime and type make typed access legal.
- Object representation is all `sizeof(T)` bytes. Value representation excludes
  padding.
- Equal values need not have equal bytes. Compare and hash members unless a
  stronger representation contract proves bytewise semantics.
- C++23 preserves member declaration order, but the ABI still chooses padding,
  alignment, base layout, and many other details.
- Trivially copyable answers the byte-copy question; standard-layout answers a
  restricted layout-interoperation question; implicit-lifetime answers when
  specified operations can create objects in raw storage.
- `reinterpret_cast` does not create an object or fix lifetime, alignment,
  aliasing, representation, or endianness.
- Use `std::bit_cast` for equal-size trivially-copyable value punning and byte
  access for representation inspection.
- Pointer arithmetic stays within one array object. A numeric address alone is
  not a portable proof of object identity or access.
- `std::start_lifetime_as` is a C++23 lifetime tool, not a parser.
- Portable binary formats define widths, signed encoding, byte order, offsets,
  validation, and versioning independently of a native struct.

### Common interview traps

| Claim | Better answer |
|---|---|
| “`sizeof(T)` is only the sum of its members.” | It includes internal and tail padding. |
| “Alignment is always a power of two in C++.” | Mainstream ABIs do that; the language defines implementation-supported valid alignments. |
| “Padding is always uninitialized garbage.” | Its state depends on initialization and stores, but it is not a stable value property. |
| “`is_trivially_copyable` means no padding.” | It grants byte-copy semantics, not unique representations. |
| “`is_standard_layout` means portable wire format.” | It fixes a type category, not widths, padding, endianness, or versioning. |
| “`reinterpret_cast<T*>` creates a `T`.” | A cast changes the expression; lifetime must begin by a rule that actually creates the object. |
| “`memcpy` is slow, so cast the packet.” | Fixed-size copies are often optimized; the cast may violate lifetime, alignment, aliasing, and order. Measure legal alternatives. |
| “Lock-free atomics automatically work cross-process.” | C++ does not define the whole process-shared contract; require platform and implementation guarantees. |

### Interview questions

1. Draw the four layers from storage to hardware. Which layer answers whether a
   typed dereference is legal?
2. Explain object representation and value representation using a padded
   struct. Why can two equal objects have different bytes?
3. Given `struct X { uint8_t a; uint64_t b; uint16_t c; };`, predict a likely
   layout, then identify every assumption in the prediction.
4. Why does a complete type have tail padding? How can an ABI reuse padding in
   base subobjects, and why does that matter to byte copying?
5. Compare trivial, trivially copyable, standard-layout, implicit-lifetime, and
   unique-object-representation properties. Give an operation each one does or
   does not authorize.
6. A byte buffer came from `recv`. List the lifetime, alignment, aliasing,
   bounds, representation, and endianness questions before reading a
   `uint32_t`.
7. When does `std::memcpy` implicitly create an object? Why does that not make
   arbitrary packet bytes a valid object?
8. What problem does `std::start_lifetime_as` solve in C++23? What problems does
   it intentionally leave unsolved?
9. Why is a pointer one past an array valid but not dereferenceable? Can it
   access an adjacent object that happens to have the same address?
10. Design a benchmark to test whether changing an array-of-struct layout
    improves low-latency performance. Which counters and percentiles matter?
11. Why does `std::bit_cast<float>(bits)` avoid an aliasing violation? Which
    representation assumption can still make the decoded value non-portable?
12. What must a same-machine shared-memory layout specify beyond member
    offsets? Why is `is_always_lock_free` useful but insufficient?

### Code-reading exercise

```cpp
struct Packet {
    std::uint8_t kind;
    std::uint32_t sequence;
};

bool same(const Packet& a, const Packet& b) {
    return std::memcmp(&a, &b, sizeof(Packet)) == 0;
}
```

Answer in order:

1. Is reading the object representations with `memcmp` itself a typed-aliasing
   violation?
2. Can the result disagree with memberwise equality?
3. Would value-initializing both objects be a sufficient long-term semantic
   contract?
4. What changes if `Packet` becomes part of a wire format?

The expected conclusion is that the byte operation is not the main defect; the
defect is choosing whole-representation equality without proving that the
representation is canonical and matches the intended semantics.

### Implementation exercise

Extend the 23-byte order decoder with an encoder. Requirements:

- no cast from the byte buffer to a scalar or struct pointer;
- bounds checked before any access;
- exact big-endian output independent of native byte order;
- explicit validation for side, quantity, and reserved values;
- round-trip tests using golden byte arrays;
- one malformed-input test per rejected condition.

Then implement a second decoder using `memcpy` plus `std::byteswap`. Compare
optimized assembly and benchmark both with realistic message batches. Keep the
clearer implementation unless a repeatable target-specific difference matters
to the system's latency objective.

### What the next chapters may assume

You can now separate storage from object lifetime, reason about padding and
alignment, identify the correct byte-copy and type-punning tools, and reject a
native struct as a portable protocol. Later chapters can build on those
invariants when discussing initialization, allocators, atomics, cache-aware
data structures, and shared-memory queues.
