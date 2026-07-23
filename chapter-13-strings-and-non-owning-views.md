# Chapter 13 — Strings and Non-Owning Views

## Why this matters in an HFT interview — Core
Every parser, market-data decoder, and order-book key must answer two questions before it interprets a byte: **who owns this storage, and how long will its address remain valid?** `std::string` owns its characters and may allocate. `std::string_view` and `std::span` borrow storage and never extend its lifetime. A view into a receive buffer can make parsing allocation-free; the same view stored after that buffer is recycled becomes a cleanly compiling use-after-free or stale-data bug.

The interview-level skill is not reciting the APIs. It is tracing ownership and invalidation, separating a counted character range from a null-terminated C string, and defending when a copy is necessary. This chapter establishes those correctness rules before discussing allocation, copying, scanning, or cache behavior.

**Baseline:** C++23. Implementation and ABI observations are labeled; no C++26 facility is assumed.

## The 90-second screen — Core
Five facts:

1. `std::string` owns; `string_view`, `span`, and `mdspan` borrow. A view neither keeps its source alive nor detects invalidation.
2. A C string is a character sequence terminated by `'\0'`; a view is pointer plus count. `data()` from a view is not evidence of termination, and embedded zero bytes are valid view contents.
3. `string::substr` creates and copies into a new owning string and may allocate. `string_view::substr` and `span::subspan` only adjust view metadata.
4. Small-string optimization (SSO) is common but not required. Its capacity, representation, and performance consequences are implementation details, never API contracts.
5. `from_chars` and `to_chars` parse and format within explicit pointer bounds without locale, allocation, or exceptions; success still requires checking both the error code and how much input was consumed.

Two decisions:

1. **Parameter type:** prefer `string_view` / `span<const T>` over `const string&` / `const vector<T>&` unless the callee must store the argument past the call.
2. **Retention policy:** borrow for synchronous processing; copy into owned or arena-backed storage before the source can die, move, reallocate, or be recycled.

---

## Ownership vs. view semantics — Core
A view type conceptually stores a starting address and enough metadata to describe a range. It has no ownership operation tied to the elements. The view object can remain alive after its source, but using it then is invalid. The language does not connect the two lifetimes.

Binding a temporary to a view does **not** extend the temporary's lifetime. Lifetime extension applies in specific reference-binding contexts (Chapter 5); constructing a separate object that happens to retain a pointer is not one of them. The governing rule is:

> Before dereferencing a view, prove that its owner is alive and that no intervening operation invalidated the borrowed range.

That proof has two parts. **Lifetime** asks whether the owning object or static storage still exists. **Address stability** asks whether an alive owner moved or replaced its storage. `vector::push_back` and `string::append`, for example, can invalidate views by reallocating even though the container remains alive.

```text
owning receive buffer
┌───────────────────────────────────────────────┐
│ 8=FIX.4.4 | 35=D | 55=AAPL | ...             │
└───────┬──────────────┬────────────────────────┘
        │              │
  string_view       string_view
   "35=D"            "55=AAPL"

The views contain no ownership arrows back to the buffer.
Destroy, move-from, reallocate, or recycle the buffer → re-prove validity.
```

### Lifetime table

| Construction or event | Storage owner | Validity rule |
|---|---|---|
| `std::string_view v = "ABC";` | String literal, static storage | Characters remain alive for the program; the pointer-taking constructor determines length by looking for `'\0'` |
| `using namespace std::literals; auto v = "ABC"sv;` | String literal, static storage | Valid for the program; the literal operator receives the length directly |
| `std::string s = ...; std::string_view v = s;` | `s` | Valid while `s` lives and no invalidating mutation occurs |
| `std::string_view v = make_string();` | Temporary returned `string` | Dangles after the full expression |
| `return std::string_view{local};` | Local `string` | Dangles when the function returns |
| `auto part = v.substr(pos, n);` | Same owner as `v` | Subview cannot outlive the original storage; destroying `v` itself is harmless if the owner remains valid |
| `std::span sp = vector; vector.push_back(x);` | `vector`'s allocation | All views dangle if insertion reallocates; otherwise old elements remain addressable subject to the container's invalidation rules |
| `s.reserve(larger);` after a view of `s` | `s` | If capacity changes, all pointers, references, iterators, and views into its characters are invalid |
| Return a view into a caller-owned argument passed by reference | Caller | Potentially valid, but the API must make the lifetime relationship apparent; a caller can still pass unsuitable storage |
| Store a view in a record or asynchronous callback | External, undocumented unless designed | Safe only when an explicit owner outlives every stored view and remains address-stable |

Destroying or modifying the **view object** does not affect its source. Destroying or invalidating the **source storage** affects every view, whether or not the original view object still exists.

### Value parameters versus borrowed parameters

Passing a view by value is normal: copying two small metadata fields does not copy characters. Passing an owner by value is different. A function that returns a view into its by-value `std::string` parameter always returns a dangling view:

```cpp
#include <string>
#include <string_view>

std::string_view bad_prefix(std::string text) {
    return std::string_view{text}.substr(0, 4); // text dies on return
}

std::string good_prefix(std::string_view text) {
    return std::string{text.substr(0, 4)};      // returned object owns the copy
}
```

Changing `bad_prefix` to take `const std::string&` is not a complete API fix: `bad_prefix(std::string{"TEMP"})` can still return a view whose source dies at the end of the call expression. Safe designs either consume the result strictly inside a documented scope, return ownership, or return a view tied to an owner object that the caller must retain.

### Canonical dangling tests with AddressSanitizer

Both examples below have undefined behavior. They are test cases, not patterns to copy. Build separately with `-std=c++23 -O1 -g -fsanitize=address -fno-omit-frame-pointer`; a typical AddressSanitizer build reports a use-after-free. Sanitizers are diagnostic tools, not proof that unsanitized code is safe.

```cpp
#include <string>
#include <string_view>

std::string_view bad() {
    std::string temp(200, 'x'); // force storage beyond any plausible SSO
    return temp;
}

int main() {
    std::string_view v = bad();
    return v[0];                // undefined: temp's allocation was released
}
```

```cpp
#include <span>
#include <vector>

int main() {
    std::vector<int> v = {1, 2, 3};
    v.shrink_to_fit();          // non-binding; do not use it to force the test
    std::span<const int> s(v);
    const int* old = v.data();
    while (v.data() == old) {
        v.push_back(4);         // loop until reallocation is observed
    }
    return s[0];                // undefined: s points into the old allocation
}
```

The first test avoids relying on an implementation's SSO threshold. The second observes reallocation instead of assuming a growth factor. ASan cannot reliably diagnose every dangling access—for example, reuse of a live network buffer is semantically stale but not freed—so production designs still need explicit ownership contracts.

---

## Character arrays, C strings, and null termination — Core

A character array is an array whose elements have a character type. A **C string** is a sequence of characters terminated by the first zero character. Those are not synonyms: `char raw[4]` may contain four bytes and no terminator, while `char text[4] = "ABC"` contains `{'A','B','C','\0'}` and is a C string.

```cpp
#include <array>
#include <cstring>
#include <string_view>

int main() {
    char terminated[] = "ABC";              // extent 4, includes '\0'
    std::array<char, 3> raw{'A', 'B', 'C'}; // counted bytes, no terminator

    std::string_view a{terminated};          // scans to first '\0': size 3
    std::string_view b{raw.data(), raw.size()}; // explicit count: size 3

    return a == b && std::strlen(terminated) == 3 ? 0 : 1;
}
```

Calling `strlen(raw.data())` in that example would be undefined because the function keeps reading beyond the array while searching for zero. Conversely, counted ranges can contain embedded zeros:

```cpp
#include <string_view>

const char bytes[] = {'A', '\0', 'B'};
std::string_view all{bytes, 3}; // size 3
// strlen(bytes) is 1; all.size() is 3.
```

This distinction matters at every C boundary. `%s`, `strlen`, `strcmp`, `strtol`, and many operating-system interfaces consume terminator-delimited input. `write(fd, data, count)`, `memcmp`, and `from_chars(first, last, value)` consume counted ranges. Never substitute one convention for the other based only on the element type.

### Boundary patterns

| Need | Safe representation | Mechanism and cost |
|---|---|---|
| Read a compile-time literal as a C string | `const char*` or array reference | Terminator is part of literal storage |
| Read an arbitrary byte slice | `string_view` or `span<const char>` | Carries length; no scan or copy when built with pointer and count |
| Pass a whole `std::string` to a C API | `s.c_str()` | Terminator guaranteed at `s.size()`; pointer invalidated by relevant mutation |
| Pass a subview to a C API requiring termination | Materialize `std::string{subview}` or copy to a checked fixed buffer and append zero | Copy is required unless a separate invariant proves a zero immediately after the subview |
| Receive into writable storage | `span<char>` or `(char*, capacity)` | Track returned length; add a terminator only if capacity reserves a byte for it |
| Compare binary fields | Sizes plus `memcmp`, or equal-length views | C-string functions stop at embedded zero and are wrong for binary data |

`std::string::c_str()` does not create a second buffer. It returns a pointer into the string's current contiguous storage. The pointer is for observation; writing through it is invalid. Since C++17, non-const `data()` returns `char*`, but writes must remain within `[data(), data() + size())`, and code must preserve the string's invariants. Writing at `data()[size()]` to replace the terminator or through storage beyond `size()` is not a supported way to grow the string.

For a receiving API that writes at most `capacity` bytes, prefer a buffer whose size already represents writable elements:

```cpp
#include <array>
#include <span>

// A representative counted API; it returns bytes written.
std::size_t receive(std::span<char> out);

void read_message() {
    std::array<char, 1024> storage{};
    const std::size_t n = receive(storage);
    if (n > storage.size()) return; // defensive contract check
    std::span<const char> message{storage.data(), n};
    // Parse message synchronously; do not store the span past storage's lifetime.
}
```

If a legacy API requires writable `char*` plus a terminator, reserve one element, pass at most `size()-1`, validate its returned length, and set the zero yourself. The extra store is usually negligible; the correctness boundary is not.

### Encoding is a separate contract

`char`, `std::string`, and `string_view` store **code units**, not abstract characters. The standard containers do not validate UTF-8, normalize Unicode, fold case, or prevent slicing inside a multi-byte encoding. `size()` counts code units. `substr(0, 4)` means four `char` elements, not four user-perceived characters.

Wire protocols often deliberately specify ASCII for tags, digits, and symbols; then byte-wise parsing is both correct and efficient. If a field is UTF-8, state that contract and decide where validation occurs. Byte-wise equality is appropriate only when the protocol defines equality that way or when normalization has already been enforced. A malformed UTF-8 sequence can pass through `string_view` unchanged.

C++20's `char8_t` distinguishes UTF-8 code units at the type level, and `u8"..."` has type `const char8_t[N]`. It does not perform validation or transcoding, and a `std::u8string_view` is not implicitly interchangeable with `std::string_view`. At an external API boundary, perform an explicit, documented conversion or use a byte representation if the protocol defines bytes. Never recover interoperability with an unchecked cast and then claim encoding correctness.

Embedded zero is also an encoding/interface issue: U+0000 in a counted UTF sequence is representable, but a C-string consumer treats its zero code unit as the end. Length-delimited APIs avoid that ambiguity.

---

## 13.1 `std::string_view` — Core

`std::string_view` is a trivially copyable, read-only view of a contiguous character sequence. Conceptually it is a pointer plus a count; the standard does not mandate that exact physical layout or size. On a common 64-bit implementation it occupies two machine words. It owns nothing and makes no null-termination promise.

### Representation chooser

| Type | Owns elements? | Carries length? | Guarantees trailing zero? | Mutable elements? | Typical use |
|---|---:|---:|---:|---:|---|
| `const char*` used as a C string | No | No | Required by the consuming convention | No | Legacy C interface |
| `char[N]` | The array object contains elements | Extent is available before decay | Only if initialized/proven so | Yes unless array is const | Fixed storage, C interop |
| `std::string` | Yes | Yes | Yes, at `size()` | Yes | Retained or constructed text |
| `std::string_view` | No | Yes | No | No | Borrowed contiguous character range |
| `std::span<char>` | No | Yes | No | Yes | Writable borrowed character or byte range |
| `std::span<const T>` | No | Yes | Not applicable | No | Borrowed contiguous typed range |

The table suggests an API rule: choose a type for the contract, not for the caller's current container. A parser that needs read-only characters and will not retain them should accept `string_view`. A decoder that accepts arbitrary bytes should accept `span<const std::byte>`. A function that needs ownership should take or return an owner.

```cpp
#include <string>
#include <string_view>

void parse(std::string_view text);     // borrows for this call

void example(const std::string& buffer) {
    parse(buffer);                     // no character copy
    parse(std::string_view{buffer}.substr(4, 8)); // view arithmetic
    parse(buffer.substr(4, 8));        // constructs a new owning string first
}
```

The last call creates an owning substring and copies characters; it may or may not request heap storage because SSO is an implementation detail. `string_view::substr` is constant-time metadata adjustment. `remove_prefix` and `remove_suffix` mutate the view, not the characters, which supports allocation-free tokenization.

### The literal-construction scan

In `std::string_view sv = "abc";`, overload resolution selects the constructor taking `const char*`; its specified behavior obtains the length with `char_traits<char>::length`. The semantic operation is a linear terminator search. A compiler can constant-fold it for a visible literal, so this does not imply a runtime loop in every build. When the pointer is selected dynamically, however, the scan can be real and can touch every cache line up to the terminator.

To avoid the scan, supply the length explicitly:

```cpp
#include <iterator>
#include <string_view>

using namespace std::string_view_literals;

constexpr char literal[] = "abc";
std::string_view a = literal;                       // length operation
constexpr std::string_view b = "abc"sv;             // length supplied
constexpr std::string_view c{literal, std::size(literal) - 1};
```

### The null-termination trap

`string_view` is not null-terminated. Passing `sv.data()` to a C API such as `atoi`, `printf("%s", ...)`, or `strtod` can read beyond the view. This remains wrong when the view happens to be a prefix of a larger terminated string: the C API sees the suffix too. There is no `c_str()`, deliberately. Copy into owned or fixed storage with a terminator, use a length-taking API, or retain an independent invariant proving termination at exactly `data() + size()`.

For output, a counted function avoids a copy and preserves embedded zeros:

```cpp
#include <cstdio>
#include <string_view>

void print(std::string_view v) {
    if (v.empty()) return;
    std::fwrite(v.data(), 1, v.size(), stdout);
}
```

If an interface offers only `printf`, `%.*s` can bound the read, but its precision has type `int`, and `%s` still stops at an embedded zero. Validate the narrowing and the text contract rather than using an unchecked cast.

### Other sharp edges

- **No `operator+`.** Concatenation requires materializing a `string`.
- **Content comparison versus pointer comparison.** `sv == "abc"` compares lengths and content; `sv.data() == other_pointer` compares addresses.
- **Heterogeneous lookup needs explicit support.** `std::map<std::string, V, std::less<>>` can find with a compatible non-owning key. A map using the default `std::less<std::string>` has no heterogeneous `find`; `find(sv)` generally fails to compile because conversion from `string_view` to `string` is explicit. Explicitly writing `find(std::string{sv})` creates an owner and may allocate. An unordered container needs a transparent hash and equality predicate. Chapter 12 owns the full design.
- `string_view` constructed from a `nullptr` `const char*` is UB; the `(nullptr)` overload was explicitly deleted in C++23.
- Empty views require care: `data()` is permitted to be null for a default-constructed empty view, but `[data(), data() + size())` is still the conceptual empty range. Do not dereference it and do not hand it to an API that rejects null even when the count is zero.

Compiler lifetime warnings can catch some temporary-binding mistakes; warning names and coverage vary by toolchain. AddressSanitizer catches some accesses to freed or poisoned storage. Neither catches every stale view, particularly when a receive buffer remains allocated but is overwritten by the next packet.

### Returning and storing views

“Use `string_view` for parameters” is a useful default, not a complete rule. A view is also an appropriate return type when the owner is clear and stable:

```cpp
#include <string>
#include <string_view>

class Instrument {
    std::string symbol_;

public:
    explicit Instrument(std::string symbol) : symbol_(std::move(symbol)) {}
    std::string_view symbol() const noexcept { return symbol_; }
};
```

The returned view is valid only while the `Instrument` remains alive and until a non-const operation changes `symbol_`'s storage. Document that contract. For concurrent use, lifetime alone is insufficient: unsynchronized mutation and reading can be a data race.

Storing views can be excellent when ownership is structural—for example, all parsed fields point into an immutable message block retained beside them:

```cpp
#include <string>
#include <string_view>

struct ParsedMessage {
    std::string storage;       // declare owner before dependent views
    std::string_view symbol;
    std::string_view venue;
};
```

But default copy and move are dangerous for such a self-referential type. After copying, the copied views still point into the original object's `storage`; after some moves, representation-specific behavior can do the same. The type needs custom copy/move operations that rebase views, or a design where storage has a stable external address, such as shared immutable backing storage plus offsets. **Offsets are often safer than pointers when the owner itself may move.**

---

## 13.2 `std::span` — Core

`std::span<T, Extent>` generalizes a counted contiguous view to any element type. `span<T>` grants access consistent with `T`; `span<const T>` is read-only. It is a good parameter type for “a contiguous block of `T` that this call does not retain.”

```cpp
#include <array>
#include <span>
#include <vector>

struct Order { int id; };

void process(std::span<const Order> orders);
void fill(std::span<std::byte> buffer);

void calls(std::vector<Order>& dynamic, std::array<Order, 8>& fixed) {
    process(dynamic);
    process(fixed);
    process(std::span{fixed}.first<4>());
}
```

**Static vs. dynamic extent** is the design axis:

| Property | `span<T>` (`dynamic_extent`) | `span<T, N>` |
|---|---|---|
| Range length | Stored or otherwise available at run time | Part of the type |
| Construction | Accepts compatible contiguous ranges | Construction must establish exactly `N` elements |
| Type compatibility | One type can represent many lengths | Different `N` means a different type |
| Optimization opportunity | Compiler may infer a constant from context | Constant bound is explicit in the type; unrolling is possible, not guaranteed |

The standard does not mandate `span`'s physical layout. Common implementations store a pointer and size for dynamic extent and only a pointer for static extent, but code must not depend on those measurements. Static extent communicates a precondition and can expose a constant loop bound; it does not guarantee unrolling or faster code.

A fixed-size message body as `span<const std::byte, 48>` makes the required length part of the interface. Construction from a dynamic span is explicit and carries a runtime precondition: if the source does not have the required size, behavior is undefined in C++23. Validate the dynamic size before constructing the fixed-extent view.

```cpp
#include <cstddef>
#include <optional>
#include <span>

std::optional<std::span<const std::byte, 48>>
body48(std::span<const std::byte> bytes) {
    if (bytes.size() != 48) return std::nullopt;
    return std::span<const std::byte, 48>{bytes};
}
```

### Mechanics and traps

- **`span` does not propagate const.** `const std::span<T>` still lets you write through it — const applies to the span's own pointer/size, not the elements. Use `std::span<const T>` when you mean read-only. This mirrors raw-pointer const behavior and is easy to get backwards.
- **No standard checked indexing in C++23.** `operator[]` out of range is undefined. Library hardening modes may diagnose it in test builds, but their names and coverage are implementation-specific.
- **`subspan`, `first<N>`, `last<N>`** are O(1); the templated forms preserve static extent where possible.
- **Same dangling hazard as `string_view`, plus mutation.** A `span` over a `vector` is invalidated by reallocation. Erase and insertion can invalidate only part of a range even without reallocation; use Chapter 11's container-specific table.
- **`as_bytes` and `as_writable_bytes`** expose an object's representation as bytes. This access is allowed, but interpreting or overwriting arbitrary bytes is not automatically valid serialization: padding, endianness, invariants, trap representations, and object lifetime still matter (Chapter 3).
- **Contiguous is required.** A `deque`, linked list, or arbitrary pair of iterators cannot be represented by one span.
- **No ownership from a range constructor.** Constructor constraints are not a borrow checker. In particular, `span<const T>` can be constructed from some temporary contiguous ranges; `std::span<const int>{std::vector<int>{1, 2}}` dangles at the end of that full expression. Compilers may warn, but the type system does not retain the vector.

Pass spans by value. This expresses the borrow and lets callers use arrays, vectors, and subranges without constructing an owning container. Whether the metadata travels in registers is target-ABI and optimizer dependent; it is not a portable performance guarantee.

### `string_view` or `span`?

Use `string_view` when operations such as `find`, prefix removal, comparison, and character traits match the domain. Use `span` when element type or mutability matters. A binary protocol should usually be `span<const std::byte>`, not `string_view`, because the type then rejects accidental text operations. A writable text buffer can be `span<char>`, while immutable text is usually clearer as `string_view`.

Converting from `span<const char>` to `string_view` is explicit pointer-and-count construction. That conversion does not validate encoding or add termination:

```cpp
#include <span>
#include <string_view>

std::string_view as_text(std::span<const char> bytes) {
    return {bytes.data(), bytes.size()};
}
```

This function is appropriate only when its caller and callee already agree that the bytes use the expected text encoding.

---

## 13.3 String storage: `std::string` and SSO — Core

`std::string` is an owning, dynamically sized, contiguous sequence of `char`. Use it when characters must survive independently of an input buffer, when an operation constructs new text, or when an API requires stable ownership. Ownership buys simpler lifetime reasoning at the cost of copying and possible allocation.

The portable storage contract is:

- `[s.data(), s.data() + s.size())` is the contiguous character range.
- `s.data()[s.size()]` is a readable zero terminator.
- `size()` is the number of characters excluding that terminator.
- `capacity()` is the number of characters the string can hold before it must obtain more capacity; it also excludes the terminator.
- A non-const `data()` is writable within the existing element range. It is not permission to write past `size()` or manually change the logical length.

Do not infer an implementation's allocation size as exactly `capacity()+1`; inline storage and allocator bookkeeping make that model non-portable.

Comparisons inspect lengths and character values according to `char_traits`. The standard constrains observable results, not whether an implementation calls `memcmp`, emits a scalar loop, or vectorizes. Comparisons and searches are byte/code-unit operations for `std::string`; they do not implement locale-sensitive or Unicode-aware collation.

### Cost model

| Operation | Standard-level mechanism | Latency concern |
|---|---|---|
| Construct/copy `n` characters | Copies `n` elements into owned storage | May allocate; work scales with input |
| Move construction | Transfers or reconstructs representation according to allocator rules | Often cheaper than copy, but do not assume zero character copies for short strings |
| `append`/`push_back` within capacity | Writes new characters | No capacity growth; still copies/writes content |
| Growth past capacity | Obtains larger storage and moves/copies existing characters | Allocation plus traffic proportional to existing size; allocator and page effects can affect tails |
| `reserve(n)` | Ensures capacity of at least `n` | Up-front allocation can move cost out of a repeated-growth path |
| `substr(pos, n)` | Constructs an independent `string` and copies selected characters | May allocate; unlike a view, lifetime is independent |
| `operator==` | Length check and, when needed, content comparison | Early mismatch may exit quickly; equal long strings require scanning all content |
| `find` | Searches a character sequence | Cost depends on haystack, needle, and implementation; benchmark representative mismatch positions |
| Concatenation | Constructs/appends characters into an owner | Intermediate strings and growth may add allocations and copies |

“May allocate” is the correct portable statement. An implementation can keep a short result inline, and an allocator can satisfy requests differently. Conversely, a result that currently fits inline is not guaranteed to do so on another standard library.

### Capacity and invalidation

Views, pointers, references, and iterators into a string are observations of its current storage. Mutations that change capacity invalidate all of them. Other mutating operations can invalidate positions or are specified conservatively enough that code should reacquire views unless the exact operation's guarantee is relied upon and tested against the standard version in use.

```cpp
#include <string>
#include <string_view>

void invalidation() {
    std::string s = "ABCD";
    s.reserve(128);             // establish room before borrowing
    std::string_view v = s;

    s.push_back('E');           // capacity is known sufficient here
    // Do not casually use v: mutation changes the represented sequence,
    // and APIs should establish a fresh view after mutation.
    v = s;                      // reacquire current data and size

    s.reserve(1024);            // can reallocate
    v = s;                      // old v must not be used
}
```

The conservative discipline—**finish mutation, then create views**—is easier to audit than depending on operation-by-operation exceptions. When code deliberately relies on stable capacity, assert the precondition before mutation and still refresh the view's size afterward.

Important consequences:

- A view is not updated when `string::size()` changes. Even without reallocation, it retains its old pointer and count.
- `clear()` changes the logical sequence but generally retains capacity; an old view must not be treated as a view of the cleared string's former characters.
- `shrink_to_fit()` is a non-binding request. If it changes capacity, old views are invalid.
- `swap` and move operations can transfer which object owns which storage. Reason from the post-operation owners; do not attach semantic identity to a raw pointer.
- Passing a string to an unknown function by non-const reference means that function may perform an invalidating mutation.

`std::string` is not trivially copyable. Copying its object representation with `memcpy` does not create another valid independent string, and byte-wise relocation is not a standard property of `std::string`. Use its constructors and assignments. Any library-specific relocation optimization must be justified against that exact implementation and ABI; it cannot leak into portable application logic.

### Build once, not by repeated temporary concatenation

When the final size can be estimated, reserve once and append:

```cpp
#include <string>
#include <string_view>

std::string make_key(std::string_view venue,
                     std::string_view symbol) {
    std::string out;
    out.reserve(venue.size() + 1 + symbol.size());
    out.append(venue);
    out.push_back(':');
    out.append(symbol);
    return out;
}
```

This design bounds growth to one capacity acquisition in ordinary implementations and performs one copy of each input range into the result. The standard does not promise a particular allocator call count, so verify it with an allocation-counting resource or profiler if the count is an acceptance criterion.

C++23's `resize_and_overwrite` helps when a producer writes directly into a string buffer and can report the actual output length. It can avoid value-initializing a final range and then resizing it again:

```cpp
#include <string>

// Writes at most capacity characters and returns a count <= capacity.
std::size_t encode_into(char* out, std::size_t capacity);

std::string encoded(std::size_t maximum) {
    std::string result;
    result.resize_and_overwrite(maximum, [](char* p, std::size_t n) {
        return encode_into(p, n);
    });
    return result;
}
```

The callback must return a length no greater than the supplied count and must obey its exception and write contract. This is a construction tool, not permission to retain `p` after the callback.

### Small-string optimization

SSO is a representation technique in which a `string` stores some short contents inside the string object rather than in a separate allocation. Major implementations use it, but the C++23 standard does not require it, set a threshold, or expose a query such as `is_small()`.

Therefore none of these is a valid portable precondition:

- “Our symbols have at most 15 characters, so construction cannot allocate.”
- “Moving this short string is a pointer swap.”
- “`sizeof(std::string)` is two or three words.”
- “Crossing from length N to N+1 is the allocation boundary.”

On a chosen production toolchain, SSO can still be a useful measured fact. Determine the object size and observed capacities in a small diagnostic, then measure allocation counts for the actual distribution of lengths. Repeat after library upgrades and build-mode changes. Include inputs below, at, and above every observed threshold.

SSO trades allocation avoidance for a larger string object and representation-dependent branches or moves. For dense arrays of strings, the larger object affects cache footprint even when most strings are long. For short strings, moving may copy inline bytes rather than steal an external pointer. Neither direction is universally preferable.

The practical conclusion is modest: SSO can improve common short-string cases, but **“fits SSO” is neither an API guarantee nor a correctness argument**.

### Low-latency alternatives

Choose storage from the lifetime and maximum-size contract:

| Requirement | Candidate | Benefit | Cost or risk |
|---|---|---|---|
| Parse synchronously from immutable input | `string_view` | No copy; no allocation by the view | Cannot outlive or survive reuse of input |
| Retain a field with a small protocol maximum | `array<char, N>` plus length | Fixed footprint and no dynamic allocation | Must define overflow policy; object always reserves `N` bytes |
| Build variable strings within a request/packet epoch | `pmr::string` with a suitably scoped resource | Centralized allocation policy and cheap bulk reclamation with a monotonic resource | Every object must die before resource storage is released; memory retained until epoch reset |
| Retain arbitrary independent text | `std::string` | Simple ownership and interoperability | Allocation and copying depend on size/capacity |
| Stable backing shared by many parsed fields | Immutable owner plus offsets/views | One payload copy, many cheap slices | Owner lifetime and move/copy semantics need explicit design |

A fixed-capacity representation must say what happens on overflow: reject, truncate with an explicit status, route to a slow-path owner, or terminate according to a hard protocol invariant. Silent truncation can merge distinct symbols or keys and is usually unacceptable.

Allocation matters because it can introduce allocator metadata access, synchronization under some allocators/workloads, cache misses, page faults, and variable execution time. Which mechanism dominates depends on allocator, thread count, object lifetime, and warm-up. Measure at least allocation count, bytes allocated, median latency, a high percentile meaningful to the service, and the input-length distribution. Chapter 8 owns memory-resource design; Chapter 43 owns benchmark methodology.

---

## 13.4 `<charconv>`: `from_chars` and `to_chars` — Core

`<charconv>` converts numbers directly between values and bounded character ranges. The operations are locale-independent, do not allocate, and do not throw. They are deliberately low-level: no whitespace skipping, no stream state, and no automatic requirement that the whole input field was valid.

```cpp
#include <charconv>
#include <cstdint>
#include <string_view>
#include <system_error>

struct ParsedInt {
    std::int64_t value;
    bool ok;
};

ParsedInt parse_integer(std::string_view field) {
    if (field.empty()) return {0, false};
    std::int64_t value{};
    const char* last = field.data() + field.size();
    auto [ptr, ec] = std::from_chars(field.data(), last, value);

    if (ec != std::errc{} || ptr != last) {
        return {0, false};
    }
    return {value, true};
}

std::string_view format_integer(std::int64_t value,
                                char* first, char* last) {
    auto [ptr, ec] = std::to_chars(first, last, value);
    return ec == std::errc{} ? std::string_view{first, ptr} :
                              std::string_view{};
}
```

Returning a view of the caller's output buffer is valid only while that buffer remains alive and unchanged. The function makes the dependency visible in its parameters, but the language does not enforce it.

### Reading the result correctly

`from_chars` returns `{ptr, ec}`:

- `ec == std::errc{}` means at least a valid prefix was converted.
- `ptr` points one past the last consumed character.
- `invalid_argument` means no pattern matched; `ptr == first`, and the output value is unmodified.
- `result_out_of_range` means the matched value was not representable; the output value is unmodified.

For a protocol field that must contain exactly one integer, success is `ec == std::errc{} && ptr == last`. Checking only `ec` wrongly accepts `"123XYZ"` as `123`. Prefix parsing can intentionally use `ptr` to continue with a delimiter.

Integer parsing does not skip leading whitespace and does not accept a leading `+`. A leading minus is accepted for signed targets. The optional base is from 2 through 36; unlike `strtol` with base zero, prefixes such as `0x` are not automatically consumed. These restrictions make wire grammar explicit:

```cpp
#include <charconv>
#include <string_view>
#include <system_error>

unsigned value{};
std::string_view hex = "2A";
auto [ptr, ec] =
    std::from_chars(hex.data(), hex.data() + hex.size(), value, 16);
// Success with value == 42 only if ec is clear and ptr reaches the end.
```

`to_chars` returns `{ptr, ec}`. On success, `[first, ptr)` is the output and no terminator is appended. If the destination is too small, `ec` is `value_too_large` and `ptr == last`; do not use the buffer contents as a valid representation. Supplying enough space is normally easiest for fixed numeric types—for example, a signed 64-bit decimal representation needs at most 20 characters including a possible minus sign, not including a terminator.

### Comparison with the alternatives

| Facility | Input boundary | Locale | Error model | Allocation concern | Best fit |
|---|---|---|---|---|---|
| `from_chars` / `to_chars` | Pointer pair | None | Error code + pointer | Specified non-allocating | Protocol and hot-path conversion |
| `strtol` / `strtod` | Null-terminated | C locale state | End pointer + `errno` | No string owner required | C APIs and grammars that want their whitespace/prefix rules |
| `stoi` / `stod` | `std::string` | C conversion rules | Exceptions + position | Caller may need to materialize a string | Convenience outside constrained paths |
| String streams | Stream buffer | Locale-aware | Stream state or exceptions | Buffering/facets may add allocation and indirect work | Rich formatted input, not minimal protocol parsing |
| `std::format` / `format_to` | Format grammar | Locale only when requested | Format errors; output-iterator contract | Depends on destination/API | Rich output formatting |

This table avoids a common false dichotomy. `charconv` is the focused bounded conversion API; it is not the only way in the standard library to produce locale-independent output. Choose it when its minimal grammar and explicit bounds match the protocol.

### Floating-point conversion

The floating overloads support `chars_format` choices such as `fixed`, `scientific`, `hex`, and `general`. Grammar details differ from `printf` and C-library parsing, so tests must cover signs, exponent forms, infinity/NaN policy, overflow, and trailing characters required by the target protocol.

The overload `to_chars(first, last, value)` chooses the shortest representation such that recovery by a matching `from_chars` implementation yields the same value, after rounding according to `round_to_nearest`. Overloads that specify a format or precision have different formatting rules; do not generalize the shortest-representation guarantee to all overloads.

Floating `from_chars` and `to_chars` are part of standard C++23, but older standard-library versions shipped them later than their integer counterparts. Check the exact deployment library, not merely the compiler's `-std` switch. If a compatibility library is needed, make that dependency explicit and test its grammar against the same corpus.

No standard API has a universal latency multiplier. Compare `charconv`, any selected compatibility library, and a specialized parser with representative values, malformed rates, compiler flags, and the production standard library. Measure output buffer failures and error paths separately; rare malformed input can dominate tail behavior if it takes a much longer path.

---

## Worked diagnosis and design: a wire-message parser — Core

Assume a feed handler receives this ASCII payload into a buffer owned by a ring slot:

```text
seq=184467;symbol=EURUSD;price=108735;
```

The slot is reused after the callback. The first implementation splits into `vector<string>`, calls `stoll`, and places `string_view symbol` into an outbound event. Profiling shows allocator calls, while rare corrupted symbols appear only under load.

### Diagnose correctness before latency

Trace each representation:

1. `vector<string>` owns its tokens, but building it copies fields and may allocate for both vector growth and string storage.
2. `stoll` requires a `string` and uses exception-based failure. The grammar may accept prefixes unless the returned position is checked.
3. The outbound `string_view` borrows a token. When the local token vector is destroyed, the event dangles.
4. Pointing the outbound view directly at the ring slot removes one temporary lifetime but still fails: slot reuse changes the bytes while the event is queued.

The corruption is therefore not “a race in `string_view`.” It is a missing ownership rule. The allocation problem is separate and should be optimized only after the retained field owns stable storage.

### Choose the lifetime boundary

The parser can borrow every field during the callback. The sequence and price become values, so they need no string lifetime. The symbol crosses the callback boundary, so it must either:

- be copied into the event's fixed-capacity symbol field;
- be interned into stable reference-data storage and represented by an ID;
- or keep shared/pooled ownership of the whole message block until consumers finish.

For a protocol whose symbol maximum is eight ASCII bytes, a fixed field is the simplest bounded design. Overflow is rejected, not truncated. If symbols are already mapped to numeric instrument IDs, resolving synchronously and queueing the ID is even smaller and avoids carrying text through the pipeline.

### Parse counted fields without allocation

The following complete example parses a signed integer field. It rejects empty input, overflow, and trailing garbage:

```cpp
#include <charconv>
#include <cstdint>
#include <string_view>
#include <system_error>

struct ParseResult {
    std::int64_t value{};
    bool ok{};
};

ParseResult parse_i64(std::string_view field) {
    if (field.empty()) return {};
    std::int64_t value{};
    const char* last = field.data() + field.size();
    const auto [ptr, ec] =
        std::from_chars(field.data(), last, value);
    if (ec != std::errc{} || ptr != last) {
        return {};
    }
    return {value, true};
}
```

The parser's contract determines whether a leading minus is legal; a sequence number would instead target an unsigned type. For a decimal price such as `108.735`, financial protocols often avoid binary floating point by specifying a scale and parsing into an integer mantissa. That policy belongs to the protocol: reject too many fractional digits, define whether `108.7` means `108700`, and detect overflow before multiplication.

Here is the ownership shape of the corrected design:

```text
ring slot (owner during callback)
        │
        ├── borrowed field views ──► from_chars ──► integer values
        │
        └── borrowed symbol ──checked copy──► Event::symbol[8] + length
                                                │
callback returns; ring slot may be reused        │
                                                └── event remains self-contained
```

### Bound the retained copy

```cpp
#include <algorithm>
#include <array>
#include <cstdint>
#include <string_view>

struct Event {
    std::uint64_t sequence{};
    std::array<char, 8> symbol{};
    std::uint8_t symbol_size{};
};

bool set_symbol(Event& event, std::string_view symbol) {
    if (symbol.size() > event.symbol.size()) return false;
    std::ranges::copy(symbol, event.symbol.begin());
    event.symbol_size = static_cast<std::uint8_t>(symbol.size());
    return true;
}

std::string_view symbol_of(const Event& event) {
    return {event.symbol.data(), event.symbol_size};
}
```

`symbol_of` returns a view tied to the event. Moving or copying an `Event` is safe because the function creates the view on demand rather than storing a self-pointer. A consumer must not retain that view beyond the event's lifetime.

### Estimate and measure the trade-off

Suppose the callback processes 500,000 messages per second and the original parser materializes three strings per message. That is 1.5 million string constructions per second, but it is **not** automatically 1.5 million heap allocations: SSO and capacity reuse affect the actual count. Instrument the allocator to learn the count instead of multiplying folklore.

The corrected parser scans delimiters once, parses numeric fields in place, and copies at most eight symbol bytes into the event. Its relevant mechanisms are:

- no owning token vector, so no vector growth and no per-token lifetime;
- no null-termination scan when views are formed with known pointer bounds;
- no locale access or exceptions in numeric conversion;
- one bounded copy for data that must outlive the input;
- an explicit rejection path for field-length and numeric errors.

Benchmark end-to-end callback latency with the production message-size distribution. Include malformed messages, ring-slot reuse, queue backpressure, and cold-start conditions. A microbenchmark that parses the same hot 40-byte literal says little about cache misses, allocator state, or tail latency in the actual handler.

### When a specialized parser is justified

If measurement shows numeric conversion is the remaining bottleneck and the protocol has a narrower grammar than `from_chars`, a fixed-width or SIMD parser can exploit that grammar. The trade is more code and a larger verification burden. Differential-test it against a clear reference implementation over valid values, boundaries, overflows, every malformed byte position, and randomized inputs. Keep `from_chars` as the rollback path until the specialized parser demonstrates a meaningful workload-level improvement.

---

## 13.5 `std::mdspan` — Role-specific / optional (C++23)

`std::mdspan<T, Extents, LayoutPolicy, AccessorPolicy>` is a non-owning multidimensional view: a pointer plus extents plus a policy mapping index tuples to offsets. Skip this section unless your role involves matrix/tensor-shaped data (order-book grids, signal buffers, numerical kernels).

```cpp
#include <mdspan>

int main() {
    double buffer[12]{};
    std::mdspan matrix{buffer, 3, 4};
    matrix[1, 2] = 3.0;
    static_assert(decltype(matrix)::rank() == 2);
}
```

The four template components are the element type, extents, layout mapping, and accessor. Extents choose which dimensions are compile-time constants. `layout_right` makes the rightmost index contiguous, `layout_left` makes the leftmost index contiguous, and `layout_stride` represents explicit strides. The accessor defines how a mapped offset accesses an element.

Like every view in this chapter, `mdspan` does not own or extend the lifetime of `buffer`. Bounds checking is not provided by ordinary element access. The mapping must be valid for the backing allocation, and mutation requires appropriate synchronization.

Layout is a locality decision. With `layout_right`, changing the last index in the inner loop gives unit-stride access. Reversing loop order can turn sequential access into a strided walk, increasing cache-line and translation pressure. The magnitude depends on dimensions, element size, cache state, vectorization, and hardware prefetching; measure rather than promising an order-of-magnitude result.

C++23 provides `mdspan` itself. Do not assume later slicing additions such as `submdspan` are available in a C++23 library. Toolchain support for `<mdspan>` also arrived incrementally, so a project that targets older libraries needs a feature check or an explicitly selected compatibility implementation.

---

## Recall card — Core
1. `string` owns and may allocate; `string_view`/`span`/`mdspan` never own and never extend anyone's lifetime — name the owner.
2. A C string is terminator-delimited; a view is count-delimited. `data()` does not imply a terminator at the view boundary.
3. Pointer-only `string_view` construction obtains a length; a literal suffix or pointer-and-count construction supplies it. A visible literal's length operation may be constant-folded.
4. `string::substr` creates and copies into a new owner and may allocate; `string_view::substr`/`span::subspan` adjust metadata.
5. SSO capacity, layout, move behavior, and `sizeof(std::string)` are implementation observations, never portability or correctness guarantees.
6. `const span<T>` does not make the elements read-only; use `span<const T>`.
7. Capacity change, owner destruction, and buffer reuse can all invalidate a view with no diagnostic.
8. `from_chars`/`to_chars` are bounded, allocation-free, locale-free conversions; check `ec`, pointer consumption, and destination capacity.
9. Text containers count code units. They do not validate UTF-8, preserve character boundaries when slicing, or normalize Unicode.
10. Borrow during synchronous work; copy, intern, or retain backing ownership before data crosses its source's lifetime boundary.

## Questions — Core
1. A parser receives a `string_view` and queues a record containing it. Which ownership questions must be answered before that design can be correct?
2. Explain why a three-byte `char` array is not necessarily a C string, and give two safe ways to pass a three-byte slice across different API conventions.
3. Compare `std::string{s}.substr(0, 4)` with `std::string_view{s}.substr(0, 4)` in ownership, lifetime, copying, and allocation guarantees.
4. Why can `std::string_view{"abc"}` require a length operation while `"abc"sv` receives its length directly, and why might optimized machine code still show no scan?
5. A map keyed by `std::string` cannot call `find(view)` with its current comparator. What container configuration removes the need to materialize an owning lookup key?
6. Does `const std::span<int>` prevent element mutation? Explain the two independent places where `const` can appear.
7. Give three ways an alive container can make an earlier view unusable or semantically stale.
8. For `from_chars("123x", ...)`, distinguish prefix success from whole-field success. Which result fields must a protocol parser check?
9. Design storage for an eight-byte symbol that crosses an asynchronous queue. Compare a fixed-capacity copy, interning to an ID, and retaining the input block.
10. Why can slicing UTF-8 by `string_view::substr` preserve memory safety yet produce invalid text?

## Common traps — Core

| Trap | Why it fails | Better decision |
|---|---|---|
| Return a view into a local or by-value parameter | Owner dies on return | Return an owner, or borrow caller storage under an explicit lifetime contract |
| Store views into a ring receive buffer | Allocation remains live but bytes are overwritten | Copy retained fields, retain the slot, or resolve to stable IDs |
| Pass `view.data()` as a C string | No terminator is guaranteed at the view boundary | Use a counted API or materialize terminated storage |
| Assume short input means no allocation | SSO threshold is not a standard contract | Use fixed/arena storage for a hard allocation policy and measure |
| Keep a view while mutating its source | Reallocation, size changes, or overwritten content make it invalid or stale | Complete mutation first, then reacquire the view |
| Check only `from_chars.ec` | Valid prefixes such as `"12x"` appear successful | Also require `ptr == last` when the whole field must match |
| Treat `string::size()` as character count | It counts code units | Make encoding and segmentation policy explicit |
| Copy a self-referential owner-plus-views struct | Copied views may still point into the old owner | Store offsets or write copy/move operations that rebase views |
| Benchmark only tiny hot strings | Hides allocation thresholds, long scans, cache misses, and error paths | Use the production length/error distribution and report percentiles |

## Code-reading puzzle — Core

The following code compiles, but using its result is invalid:

```cpp
#include <cctype>
#include <string>
#include <string_view>
#include <vector>

std::vector<std::string_view> tokenize(std::string_view line) {
    std::vector<std::string_view> out;
    std::string upper(line);
    for (char& c : upper) {
        c = static_cast<char>(
            std::toupper(static_cast<unsigned char>(c)));
    }
    std::size_t pos = 0;
    while (pos < upper.size()) {
        std::size_t next = upper.find(' ', pos);
        out.push_back(std::string_view(upper).substr(pos, next - pos));
        if (next == std::string_view::npos) break;
        pos = next + 1;
    }
    return out;
}
```

At what exact event does every returned view become dangling? Compare three repairs: return `vector<string>`, return one owned uppercase string plus token offsets, or accept caller-owned writable storage. Which repair best fits a parser whose consumer needs all tokens after the call?

## Implementation exercise — Core
Write `parse_header(std::span<const std::byte> packet)` for a fixed 12-byte header: a 4-byte big-endian message length, a 4-byte big-endian sequence number, and a 4-byte ASCII symbol. Validate the packet length before indexing; decode integers without alignment assumptions; reject non-ASCII symbol bytes; and make the returned symbol's ownership unambiguous.

Then write a deliberately invalid variant that returns a view into a `vector<std::byte>` parameter taken by value. Run its use under AddressSanitizer and explain why a report is likely but not guaranteed for every dangling-view pattern. Add tests for an 11-byte packet, maximum integer values, embedded zero, and input-buffer reuse.

## Prerequisites for Chapter 14 — Core
Chapter 14 treats `span` and `string_view` as contiguous ranges. It assumes you can identify the owner behind a range, predict invalidation, and distinguish a borrowed range from an owning result. Review Chapter 11's container-invalidation rules if reallocation and mutation effects are not yet automatic.
