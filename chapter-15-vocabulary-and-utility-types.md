# Chapter 15 — Vocabulary and Utility Types

## Why this matters — Core

A vocabulary type makes an interface's possible states visible in its type. `std::optional<Price>` says that a price may be absent. `std::variant<Add, Cancel>` says that exactly one member of a closed alternative set is active. `std::chrono::nanoseconds` says both that a value is a duration and what its unit is. These types prevent callers from inventing meanings for null pointers, integer sentinels, untagged unions, or unitless counters.

The type does not remove the need for a contract. An empty optional must have a defined meaning. A variant visitor must account for every alternative and for any possible valueless state. A `reference_wrapper` does not extend an object's lifetime. A time point is meaningful only with its clock and epoch. Correct use therefore starts with semantics and lifetime, then considers representation and cost.

This chapter's Core covers products, nullable values, closed sums, and clocks. Error-policy selection belongs to Chapter 10, non-owning string and range views to Chapter 13, and callable/type-erasure machinery to Chapter 18. The later sections on `any`, reference wrappers, bits, randomness, calendars, time zones, and SIMD are independent Role-specific modules.

The language and library baseline is C++23. In particular, C++23 does **not** contain `std::simd` or `std::optional<T&>`; later-standard facilities are not presented as available here.

---

## 90-second screen — Core

1. `pair` and `tuple` are **products**: all component objects exist. `optional<T>` is nullable: either one `T` exists or none does. `variant<Ts...>` is a **closed sum**: one listed alternative normally exists. These are lifetime statements, not byte-layout promises.
2. Never serialize the object representation of `tuple`, `optional`, `variant`, `any`, or `bitset`. Their padding, discriminants, element arrangement, and small-object choices are not portable formats.
3. `optional` means “value or absence.” It cannot explain the absence. Use `expected<T, E>` when a caller needs an error value, and keep the full error-policy decision in Chapter 10.
4. `optional::value()` and `get<T>(variant)` throw on the wrong state; unchecked `*optional`/`optional->` require engagement; `get_if` reports variant mismatch with a null pointer.
5. Moving an `optional` does not disengage the source. A variant can become `valueless_by_exception` during a throwing state transition. Design and test those states explicitly.
6. `variant` is for a closed set known at compile time; `any` is for an open set discovered at run time. `any` may allocate and provides no operations beyond type query/cast.
7. Use `steady_clock` for intervals and deadlines, `system_clock` for civil/wall timestamps. `high_resolution_clock` has implementation-defined identity and monotonicity; its name is not a selection criterion.

Two decisions to defend:

- Prefer a named result struct over a long tuple once component names are part of the contract.
- Prefer the narrowest state model that is honest: plain `T`, then `optional<T>`, then `expected<T,E>` or `variant<...>` according to whether the alternatives are errors or domain states.

---

## 15.1 The state model: product, nullable, sum, and erasure — Core

The important distinction is not syntax; it is which objects are alive:

```text
pair<A, B> / tuple<A, B, C>
    [ A alive ][ B alive ][ C alive ]       product: all components

optional<T>
    disengaged | [ T alive ]                nullable: zero or one T

variant<A, B, C>
    tag A + [ A alive ]
    tag B + [ B alive ]                     closed sum: one listed type
    tag C + [ C alive ]
    possibly valueless after an exception

any
    empty | [ run-time type identity + value ]  open erased set
```

An implementation needs enough storage and state to provide these semantics, but the standard generally does not prescribe a struct layout. “Enough storage for the largest variant alternative plus a tag” is a useful cost model, not permission to calculate the tag's offset.

### Match the semantic role

| Interface meaning | Type | What the caller must handle |
|---|---|---|
| Two or more values always returned | Named struct, `pair`, or `tuple` | Every component |
| Value may legitimately be absent | `optional<T>` | Engaged and disengaged |
| Value or explained failure | `expected<T, E>` | Success and error; Chapter 10 |
| Exactly one of a known set of domain alternatives | `variant<Ts...>` | Every alternative, plus exception state if reachable |
| Heterogeneous value from an open extension set | `any` | Run-time type mismatch and possible allocation |
| Non-owning, copyable alias to an object | `reference_wrapper<T>` | Referent lifetime |
| Elapsed quantity with a unit | `chrono::duration` | Conversion and rounding |
| Reading from a particular clock | `chrono::time_point` | Clock identity and epoch |

Do not use a richer state type merely to avoid writing a contract. `optional<bool>` has three states—absent, false, true—which is correct only when the domain has three meanings. A `variant` containing semantically overlapping alternatives can be harder to reason about than a named enum plus payload.

### Cost follows the state model

For a concrete implementation and target, inspect:

- `sizeof` and `alignof` of the complete vocabulary type;
- whether copying or moving invokes component operations;
- whether construction or transition can throw;
- whether dispatch is inlined or branched indirectly;
- whether the held type itself allocates;
- object density when stored in a large sequence.

The contained value of an optional or variant is nested within the wrapper rather than separately heap-allocated by the wrapper. A contained `std::string`, however, may allocate. `bitset` has a fixed extent, but its exact storage representation is unspecified. Saying “variant never allocates” without separating wrapper machinery from alternative behavior hides the cost that matters.

### Contract checklist

Before selecting a wrapper, complete these sentences:

- **State:** empty means ___; each variant alternative means ___.
- **Ownership:** the returned object owns ___ and borrows ___.
- **Lifetime:** a retained pointer/reference remains valid until ___.
- **Failure:** callers observe absence, mismatch, or error by ___.
- **Exception:** if construction or transition throws, the wrapper is left ___.
- **Cost boundary:** allocation, dispatch, clock access, or conversion may occur at ___.

If any blank is ambiguous, changing `T*` to `optional<T>` or a union to `variant` has not completed the API design. The wrapper can enforce which states exist, but only the contract assigns domain meaning and establishes who keeps referenced objects alive.

For low-latency interfaces, also state whether the uncommon state is permitted on the critical path. “Usually engaged” does not make `value()` non-throwing, and “the variant normally holds `Add`” does not bound a throwing transition. Either arrange the phase so the exceptional state cannot arise, or include it in measurement and recovery.

---

## 15.2 Products: `std::pair`, `std::tuple`, `apply`, and `tie` — Core

`std::pair<T, U>` stores two components named `first` and `second`. `std::tuple<Ts...>` generalizes the product to any fixed number of heterogeneous components. Access is positional through `std::get<I>` or, when a type occurs exactly once, through `std::get<T>`.

```cpp
#include <cassert>
#include <string>
#include <tuple>
#include <utility>

int main() {
    std::pair<int, std::string> venue{7, "XSGX"};
    std::tuple<int, int, double> quote{101, 12, 101.5};

    auto& price = std::get<2>(quote);
    auto [id, name] = venue;

    assert(price == 101.5);
    assert(id == 7 && name == "XSGX");
    static_assert(std::tuple_size_v<decltype(quote)> == 3);
}
```

`std::get<I>` is compile-time indexed; an out-of-range index is ill-formed, not a run-time exception. Type-based `get<T>` is also ill-formed when `T` is absent or occurs more than once. Index access is often more robust for repeated scalar types, while named structs are more robust than either form when meanings matter.

### Representation and type traits are not inferred

The standard does not require tuple elements to appear in template-argument order in memory. It does not make a tuple layout-compatible with a struct containing the same types. Empty-component optimization, padding, and trivial copyability can vary with implementation and component properties.

`std::pair` exposes actual members in declaration order, but padding and standard-layout/triviality still depend on its specification, implementation, and component types. Neither pair nor tuple is a wire format. If a program requires a trait, ask for it:

```cpp
#include <type_traits>

struct MyRecord {
    int id;
    double value;
};

static_assert(std::is_trivially_copyable_v<MyRecord>);
```

Do not replace `MyRecord` with `tuple<int, double>` and assume the result inherits every representation property of `int` and `double`. Chapter 3 owns object representation and serialization.

Construction helpers also affect types. `make_pair` and `make_tuple` decay most arguments, so arrays become pointers and top-level references/cv-qualification are removed; `reference_wrapper` is deliberately unwrapped into a reference element. Class template argument deduction for direct `pair`/`tuple` construction is not a spelling-only replacement in every such case. Inspect the deduced type when references or arrays are involved.

Pair and tuple comparisons are lexicographic. They compare the first unequal component rather than combining hashes or comparing raw bytes. This makes `std::tie(lhs.price, lhs.sequence) < std::tie(rhs.price, rhs.sequence)` a concise strict ordering when those fields already have suitable comparison semantics. If comparison order is part of a public invariant, a named comparator can make that order harder to change accidentally.

### Tuple or named struct?

Use a short product type when the roles are local and conventional:

- an iterator and a success flag;
- a key and value;
- a temporary lexicographic comparison key;
- a short argument pack consumed generically.

Use a named struct when the result crosses an API boundary, gains invariants, or has several same-typed fields:

```cpp
struct FillSummary {
    int filled_quantity;
    int remaining_quantity;
    double average_price;
};
```

`tuple<int, int, double>` cannot communicate which integer is filled and which is remaining. Structured bindings still work with a suitably accessible aggregate, so naming the type does not sacrifice concise unpacking.

### `std::apply`: expand a product into arguments

`std::apply(f, product)` invokes a callable with the product's elements as arguments. C++23 supports the standard tuple-like product types. Callable ownership, captures, and `std::invoke` belong to Chapter 18; the relevant fact here is how element value categories and lifetimes reach that call.

```cpp
#include <cassert>
#include <tuple>

int main() {
    auto operands = std::tuple{4, 7, 3};
    int result = std::apply(
        [](int a, int b, int c) { return a + b * c; },
        operands);
    assert(result == 25);
}
```

Passing an lvalue tuple exposes lvalue elements; passing `std::move(tuple)` can expose rvalue elements. That distinction matters when the callable consumes move-only components.

### `std::tie` and reference-bearing tuples

`std::tie(a, b)` creates `tuple<A&, B&>`. It is useful for assignment into existing variables and concise lexicographic comparison:

```cpp
// Context: parse_header and the record types are application-defined.
std::tie(order_id, quantity) = parse_header();
return std::tie(lhs.symbol, lhs.sequence)
     < std::tie(rhs.symbol, rhs.sequence);
```

`std::ignore` discards a component during tuple assignment. Structured bindings are usually clearer for declaring new variables; `tie` remains useful when variables already exist.

`std::forward_as_tuple` is different. It preserves argument value categories and can therefore store rvalue references to temporaries. Those temporaries die at the end of the full expression:

```cpp
// Incorrect: the temporary string dies at the semicolon.
auto refs = std::forward_as_tuple(std::string{"temporary"});
// refs contains a dangling reference on the next statement.
```

That snippet is intentionally incorrect. A tuple containing references is non-owning; the tuple's lifetime does not extend any referent. Storing deferred arguments safely requires owning values or a separately proven lifetime, not merely a different tuple helper.

`std::make_tuple` normally decays arguments and recognizes `reference_wrapper`. This can deliberately produce a reference element with `std::make_tuple(std::ref(x))`; it can also surprise code that expected an independent value. State ownership at the declaration.

`tuple_cat` concatenates tuple-like products, preserving or constructing element types according to its arguments. It is not a lifetime escape hatch: concatenating reference-bearing tuples produces another product whose references need valid referents. It can also move or copy owning components, so do not treat a chain of tuple helpers as guaranteed run-time no-ops without checking the instantiated types and generated code.

---

## 15.3 Nullable values: `std::optional` — Core

`std::optional<T>` contains either a live `T` or no `T`. It does not use a caller-visible sentinel and does not independently allocate storage for its state. `T` must be an object type that satisfies the optional requirements; C++23 does not permit `optional<T&>`.

### Access defines the failure contract

| Operation | Empty behavior | Use when |
|---|---|---|
| `has_value()` / contextual `bool` | Reports false | Branching explicitly |
| `operator*`, `operator->` | Precondition violated; behavior undefined | Engagement already proved |
| `value()` | Throws `bad_optional_access` | Throwing access is part of API |
| `value_or(fallback)` | Returns converted fallback | Fallback expression is cheap/eager |
| `and_then`, `transform`, `or_else` | Propagate or handle absence | Composing C++23 operations |

```cpp
#include <cassert>
#include <optional>

std::optional<int> top_quantity(bool book_has_level) {
    if (!book_has_level) {
        return std::nullopt;
    }
    return 17;
}

int main() {
    auto doubled = top_quantity(true)
        .transform([](int quantity) { return quantity * 2; });

    assert(doubled && *doubled == 34);
    assert(top_quantity(false).value_or(0) == 0);
}
```

`value_or(expr)` is a normal function call, so `expr` is evaluated before `value_or` begins—even when the optional is engaged. The conversion from the fallback to `T` is used only on the empty path, but an expensive function call used to produce that argument has already happened. C++23 `or_else` takes a callable and is lazy:

```cpp
// Context: lookup and load_fallback return compatible optionals.
auto value = lookup(id).or_else([] {
    return load_fallback();
});
```

`and_then` expects a callable returning another optional-like result of the required form and flattens it. `transform` wraps the callable's result. These members improve local composition; the decision between absence, error values, and exceptions remains Chapter 10's responsibility.

### State transitions and lifetime

An optional's contained `T` begins its lifetime when the optional becomes engaged and ends when it is reset, destroyed, assigned to `nullopt`, or replaced as required by an operation.

Important consequences:

- `reset()` destroys the contained object if present.
- `emplace(args...)` destroys any old value and constructs a new one in place. If construction throws, the optional is disengaged.
- Copying an engaged optional copies its value; copying an empty optional produces an empty optional.
- Moving an engaged optional move-constructs or move-assigns the destination value but does **not** require the source optional to become empty. The source remains engaged with a valid but possibly moved-from `T`.
- A reference or pointer to the contained `T` becomes invalid when that `T` is destroyed or replaced.

```cpp
#include <cassert>
#include <optional>
#include <string>
#include <utility>

int main() {
    std::optional<std::string> source{"ABC"};
    std::optional<std::string> destination{std::move(source)};

    assert(destination.has_value());
    assert(source.has_value());  // its string is valid but moved-from
}
```

The last assertion is often missed. “Move transfers engagement” is not optional's contract.

### Representation-neutral cost model

The standard specifies state and operations, not a separate `bool`, a pointer-niche optimization, or an exact `sizeof(optional<T>)`. An implementation may use padding or another representation so long as behavior is correct. Portable code can rely on:

- the contained object being nested within the optional object;
- no independent dynamic allocation by optional itself;
- conditional triviality guarantees for relevant special members when `T` meets their conditions;
- the address of a contained value remaining stable until an operation destroys or replaces it.

Measure `sizeof`, alignment, generated branches, and copy/move behavior on the actual type. Do not claim that `optional<T*>` has a universal size or that an engaged flag always occupies a separate byte. Do not serialize optional's raw bytes.

In a large array, padding can make optional storage amplification material. A separate bitmap plus dense values can be better when presence is sparse or scanned independently. That is a data-layout transformation with more complex indexing, not a reason to hide absence behind an unexplained sentinel.

Optional comparisons treat disengagement as a state. Two disengaged optionals compare equal, and a disengaged optional orders before an engaged one in the ordinary relational ordering. Sorting optionals can therefore move missing values to the front even if the domain wanted “unknown last.” Supply the domain comparator instead of inheriting a library state order accidentally.

Nested nullable state deserves suspicion. `optional<bool>` distinguishes absent, false, and true; `optional<optional<T>>` distinguishes an outer absence from an inner absence. Both are valid when all states have stable names in the domain. Otherwise an enum, variant, or named state structure is clearer.

### What optional should mean

Good uses include “lookup found no element,” “message omitted an optional field,” and “configuration has no override.” If absence violates a precondition, returning optional may merely defer a bug. If callers need to distinguish malformed input, unavailable data, and permission denial, `expected<T,E>` or another explicit result belongs at the boundary.

An optional reference in C++23 is normally represented by `T*` with a non-owning contract, or by `optional<reference_wrapper<T>>` when optional-style operations are useful. Both forms can dangle; Section 15.8 makes that lifetime explicit.

---

## 15.4 Closed alternatives: `std::variant` and visitation — Core

`std::variant<Ts...>` manages the lifetime of one alternative from a compile-time list. It is the standard closed-sum type: adding a new alternative changes the type and forces code that requires exhaustive invocability to account for it.

### Access and exhaustive dispatch

```cpp
#include <cassert>
#include <string>
#include <variant>

struct Add {
    int quantity;
};
struct Cancel {
    int order_id;
};
struct Reject {
    std::string reason;
};

template <class... Fs>
struct overloaded : Fs... {
    using Fs::operator()...;
};

int main() {
    using Event = std::variant<Add, Cancel, Reject>;
    Event event = Cancel{42};

    int code = std::visit(overloaded{
        [](const Add& add) { return add.quantity; },
        [](const Cancel& cancel) { return cancel.order_id; },
        [](const Reject&) { return -1; }
    }, event);

    assert(code == 42);
    assert(std::holds_alternative<Cancel>(event));
}
```

`std::get<T>(v)` returns the active `T` or throws `std::bad_variant_access`. `std::get_if<T>(&v)` returns a pointer or null and is the natural non-throwing probe. Index-based access handles duplicate alternative types; type-based access is ill-formed unless the type occurs exactly once.

`std::visit` requires its callable to be invocable for every possible alternative combination and to satisfy its return-type rules. The specific overload set above is exhaustive. A generic fallback such as `[](const auto&) { ... }` deliberately makes future alternatives compile, so it trades compile-time exhaustiveness for a default policy.

`std::monostate` is an empty, regular alternative often placed first when a meaningful alternative is not default-constructible or when an explicit “none” domain state is required. `variant<monostate, T>` resembles optional structurally, but optional communicates nullable intent more directly.

A default-constructed variant default-constructs its first alternative, so alternative order affects more than the numeric result of `index()`. Reordering alternatives can change default behavior and every index. Never persist or transmit `index()` without a separate versioned protocol mapping. Prefer type-based access in source where alternative types are unique, while still treating the variant declaration as an ordered type.

Every `visit` invocation must produce a valid call for each active-type combination, and the deduced overload requires compatible result types and value categories. A visitor whose arms return unrelated types can fail even though every alternative has a syntactically plausible handler. Give `visit<R>` an explicit result in C++20-and-later code when a deliberate common conversion is part of the contract.

### State transitions and `valueless_by_exception`

Changing alternatives can require destroying the old object and constructing a new one. If construction or movement throws after the old alternative can no longer be retained, the variant may become `valueless_by_exception()`:

- `index()` returns `variant_npos`;
- `get` and `visit` cannot produce an alternative and throw `bad_variant_access`;
- assignment or emplacement can later give it a value again.

Do not describe the variant as “always exactly one alternative” without this qualification. Nothrow moves and constructions reduce the transitions that can produce a valueless state, but an `emplace` of an alternative with a throwing constructor still deserves analysis. Either handle `valueless_by_exception`, constrain alternatives and operations so it is unreachable in the relevant path, or treat it as a fatal invariant violation explicitly.

### Representation and dispatch are implementation concerns

A useful capacity estimate is:

```text
storage ≳ max(sizeof(each alternative)), aligned for the strictest alternative
       + state needed to identify the active alternative
```

Exact size, padding, tag type, and tag position are unspecified. One very large alternative makes every variant object large; if that alternative is rare, indirection for that alternative or a different event representation may improve object density at the cost of allocation/ownership complexity.

The standard specifies `visit` behavior and complexity requirements, not a mandatory function-pointer table or switch. Implementations and optimizers can use branches, tables, inlining, or other equivalent lowering. Multi-variant visitation must instantiate valid calls for combinations of alternatives, so compile time and code size can grow combinatorially even when run-time dispatch remains efficient.

For a hot event loop, measure:

- alternative frequency and transition pattern;
- generated code with the production optimizer and LTO settings;
- instruction footprint and branch behavior;
- object size and cache density;
- cost of alternative constructors/destructors.

A hand-written tag and union can expose a switch more directly, but then the application owns lifetime, exception, and exhaustive-state correctness. Use it only when measurement justifies that responsibility. General callable and virtual-dispatch trade-offs stay in Chapters 6 and 18.

### Closed set versus open hierarchy

Choose variant when producers and consumers share a finite domain set such as feed events or parser tokens. Adding an alternative should trigger coordinated rebuilds and visitor updates. Choose a virtual interface or other erased abstraction when third parties add types independently and operations are stable. This is an extensibility decision before it is a dispatch benchmark.

---

## 15.5 Durations, time points, and clocks — Core

`std::chrono::duration<Rep, Period>` stores a count whose unit is encoded by a compile-time ratio. A `time_point<Clock, Duration>` is a duration since a clock's epoch and carries the clock type. Units and clock domains therefore participate in type checking.

### Conversion and rounding

```cpp
#include <cassert>
#include <chrono>

int main() {
    using namespace std::chrono;
    using namespace std::chrono_literals;

    nanoseconds fine = 1500us;                 // exact conversion
    microseconds truncated =
        duration_cast<microseconds>(1500500ns);

    assert(fine == 1'500'000ns);
    assert(truncated == 1500us);
    assert(round<milliseconds>(1500us) == 2ms);
    assert(floor<milliseconds>(-1500us) == -2ms);
}
```

Conversion to a duration that can represent every source tick without loss can be implicit when representation conversions allow it. Potentially lossy period conversion requires `duration_cast`. For integral representations, `duration_cast` truncates toward zero. `floor`, `ceil`, and `round` express other boundary policies; `round` resolves exact halves toward the even result.

The rounding policy changes bucket assignment in latency histograms and deadline calculations. State it rather than relying on an incidental integer conversion.

The representation type still obeys ordinary arithmetic rules. A `duration<std::int64_t, std::nano>` gives unit safety, not saturation; signed overflow remains undefined behavior. Converting a floating duration containing an out-of-range or non-finite value to an integral representation has undefined behavior. Validate untrusted values before casting, and compute long deadlines in a representation whose range is sufficient.

Two time points from the same clock can be subtracted to produce a duration. A duration can be added to a time point. Adding two time points is meaningless and ill-formed. Time points from different clocks do not mix merely because their duration representations match; conversion needs a defined relationship between the clocks.

### Choose clocks by semantics

| Need | Standard clock/type | Reason |
|---|---|---|
| Measure elapsed time | `steady_clock` | Monotonic; `is_steady` is true |
| Express a timeout deadline | `steady_clock::time_point` | Wall-clock adjustment does not move the deadline |
| Record civil/wall time | `system_clock` | Represents system-wide real time; calendar conversion support |
| Interoperate with `time_t` | `system_clock` | Standard conversion functions |
| “Highest resolution” | Inspect chosen clock's `period` and measured implementation | `high_resolution_clock` identity is implementation-defined |

`high_resolution_clock` may be an alias for another clock or a distinct implementation clock. It does not portably promise monotonicity, useful accuracy, or lower call overhead. Select `steady_clock` or `system_clock` from semantics, then inspect resolution and implementation on the target.

A clock's `period` describes its tick period as a type-level ratio. It does not guarantee that successive `now()` calls change by one tick, that readings are accurate to that period, or that call overhead is smaller than the period. Measure effective resolution and overhead separately.

Since C++20, `system_clock` time points measure Unix time: time since 1970-01-01 00:00:00 UTC, excluding leap seconds. The clock can still be adjusted, so subtracting two system-clock readings is not the robust way to time work.

### `now()` is an observable cost

Duration arithmetic is ordinary arithmetic after unit conversions are resolved. Calling `Clock::now()` reaches an implementation and operating-system clock source whose mechanism and cost are outside the C++ abstract machine. It might use a user-space fast path, a system call, hardware counter conversion, or another platform facility.

For low-latency measurement:

1. use `steady_clock` unless a calibrated platform counter is an explicit requirement;
2. measure `now()` overhead and resolution on the deployed platform;
3. avoid placing two clock reads around work shorter than the measurement noise without batching;
4. keep wall-time formatting and zone conversion outside the critical interval;
5. report the clock, units, aggregation, and percentile method with results.

Chapter 35 owns clock-source synchronization and NTP/PTP behavior. The portable conclusion here is narrower: clock selection preserves semantic correctness, while clock-call cost must be measured.

---

## 15.6 Worked choice and diagnosis — Core

### Choose the vocabulary type

Consider five interfaces:

| Requirement | Choice | Rejected alternative and reason |
|---|---|---|
| Return bid price and quantity, always together | Named `TopOfBook` struct | Tuple hides component meaning at API boundary |
| Find an order; “not present” is normal and needs no reason | `optional<Order>` or non-owning handle according to ownership | Sentinel order ID mixes domain value with state |
| Parse a message; caller needs offset and error category | `expected<Message, ParseError>` | Optional loses the reason; details remain Chapter 10 |
| Process one of `Add`, `Cancel`, `Trade` known at build time | `variant<Add, Cancel, Trade>` | `any` discards compile-time exhaustiveness |
| Plugin attaches an arbitrary copyable metadata value | `any`, outside critical path | Variant would require central enumeration of plugin types |

The table is incomplete without lifetime:

- Returning `optional<Order>` owns/moves or copies an order.
- Returning `optional<reference_wrapper<const Order>>` borrows an order and can dangle.
- Returning a stable order handle can decouple identity from storage but needs a validation contract.

Chapter 9 owns general ownership handles; Chapter 13 owns non-owning views.

### Diagnose eager fallback work

```cpp
// Context: cache_lookup returns optional<string>.
std::optional<std::string> name = cache_lookup(id);
return name.value_or(fetch_default_name());
```

Even when `name` is engaged, `fetch_default_name()` is evaluated before `value_or` is called. The defect is not optional's storage or branch; it is ordinary argument evaluation. In C++23:

```cpp
// Context: fetch_default_name returns a compatible optional.
return cache_lookup(id)
    .or_else([] { return fetch_default_name(); })
    .value();
```

Here `fetch_default_name` must return a compatible optional. A direct `if` is often clearer and can avoid the throwing final `value()`:

```cpp
// Context: fetch_default_name_value returns string.
if (auto name = cache_lookup(id)) {
    return std::move(*name);
}
return fetch_default_name_value();
```

The correct choice depends on the actual return types and error contract, not a preference for one-liners.

### Predict a moved optional and a throwing variant

```cpp
// Context: a and b are examined after this state transition.
std::optional<std::string> a{"live"};
auto b = std::move(a);
```

Afterward, both `a` and `b` are engaged. `b` contains the transferred value; `*a` is a valid but unspecified moved-from string state.

For:

```cpp
// Context: event is a variant with LargeEvent as an alternative.
event.emplace<LargeEvent>(source);
```

if constructing `LargeEvent` throws, do not assume the previous alternative survives. Inspect the specified operation and design for a possible valueless variant. This prediction is about object lifetime and exception ordering, not representation.

---

## 15.7 Open erased values: `std::any` — Role-specific

`std::any` holds either no value or one value of a run-time-selected copy-constructible type. It is useful when the set of types is genuinely open and no shared operation belongs in the container abstraction.

```cpp
#include <any>
#include <cassert>
#include <string>

int main() {
    std::any value = 7;
    assert(std::any_cast<int>(value) == 7);

    value = std::string{"metadata"};
    auto* text = std::any_cast<std::string>(&value);
    assert(text && *text == "metadata");
    assert(std::any_cast<int>(&value) == nullptr);
}
```

The value form of `any_cast<T>` throws `bad_any_cast` on a mismatch. The pointer form returns null and is preferable when mismatch is expected. `type()` returns the held type's `type_info`, or `typeid(void)` when empty. Build modes that disable or alter RTTI are compiler extensions; whether `any` remains usable there is a toolchain question, not an alternate standard guarantee.

Implementations may keep some suitably small values inside the `any` object and allocate for others, but the threshold and eligibility are unspecified. Code cannot use `sizeof(T)` alone to predict allocation. Measure the exact library/type combination or use an explicit allocator-aware erased design if allocation policy is contractual.

`any` cannot directly hold a move-only value such as `unique_ptr<T>` because its contained type must be copy-constructible. Wrapping ownership to make it copyable changes semantics and should be deliberate.

Good uses include plugin property bags and control-plane metadata. It is usually a poor hot-path event representation: run-time type checks replace exhaustive static handling, possible allocation affects tail latency, and consumers still need an out-of-band agreement about allowed types.

---

## 15.8 Reference wrappers — Role-specific

`std::reference_wrapper<T>` is a copyable, assignable object that refers to an existing `T`. `std::ref(x)` and `std::cref(x)` construct wrappers. The wrapper is guaranteed trivially copyable and can be stored where a raw C++ reference cannot, including containers and optional.

```cpp
#include <cassert>
#include <functional>
#include <optional>
#include <vector>

int main() {
    int bid = 100;
    int ask = 102;

    std::vector<std::reference_wrapper<int>> prices{bid, ask};
    prices[0].get() += 1;

    std::optional<std::reference_wrapper<int>> maybe_bid{std::ref(bid)};
    maybe_bid->get() += 1;

    assert(bid == 102);
}
```

Conversion to `T&` and `get()` access the referent. Assigning one wrapper to another **rebinds** the wrapper; it does not assign through to the old referent. Use `.get() = value` to assign through.

The wrapper owns nothing and does not extend lifetime. `std::ref` rejects direct binding to a temporary, which prevents one common error, but it cannot detect a wrapper returned from a function after a local referent dies or retained after a container relocates its elements.

For optional borrowing in C++23:

- `T*` is compact and conventional when null means absent;
- `optional<reference_wrapper<T>>` provides optional operations and a visibly non-owning component;
- an index/generation handle is better when storage can relocate or reuse slots.

Choose based on lifetime and identity, not surface syntax.

---

## 15.9 Fixed bits and `<bit>` utilities — Role-specific

### `std::bitset<N>`

`std::bitset<N>` is a fixed-size sequence of bits whose extent is part of the type. The standard specifies bit operations, conversions, and observable values—not a word-array representation, machine word size, or serialization order.

```cpp
#include <bit>
#include <bitset>
#include <cassert>
#include <cstdint>
#include <limits>

int main() {
    std::bitset<16> flags;
    flags.set(3);
    flags.flip(5);
    assert(flags.test(3));
    assert(flags.count() == 2);

    std::uint32_t mask = 0b10110000u;
    assert(std::popcount(mask) == 3);
    assert(std::countr_zero(mask) == 4);
    assert(std::countl_zero(std::uint32_t{0})
           == std::numeric_limits<std::uint32_t>::digits);
}
```

`test(pos)` checks its index and throws `out_of_range`; unchecked subscript access requires a valid position. Mutable `operator[]` returns a proxy because a bit is not a separately addressable C++ object. Capturing that proxy with `auto` can retain a reference into the bitset; use `bool bit = flags[i]` when a value is intended.

`to_ulong` and `to_ullong` throw `overflow_error` if set bits do not fit the destination. `to_string` returns an owning string and may allocate. For a fixed flag set, bitset provides dense storage and whole-set Boolean operations. It has no portable raw-word API, so specialized set-bit iteration may be better expressed with explicit unsigned words.

### Defined bit operations

C++20 `<bit>` includes:

- `popcount`, `countl_zero`, `countl_one`, `countr_zero`, `countr_one`;
- `rotl` and `rotr`;
- `has_single_bit`, `bit_width`, `bit_floor`, and `bit_ceil`;
- `bit_cast`, `endian`, and C++23 `byteswap`.

Most counting and power-of-two functions accept unsigned integer types. The zero cases are specified: for an unsigned type with `W` value bits, `countl_zero(0)` and `countr_zero(0)` return `W`. This differs from several older compiler intrinsics whose zero input had no defined result. `bit_ceil(x)` requires its result to be representable in the return type; exceeding that boundary is undefined behavior.

On x86, optimized code may use `POPCNT`, `LZCNT`, or `TZCNT` when the target enables the relevant feature. The names are not interchangeable: `POPCNT` has its own advertised feature, `LZCNT` is associated with AMD's ABM nomenclature, and `TZCNT` belongs to BMI1. Without those features, compilers use other instruction sequences. Source semantics remain those of `<bit>`, including zero handling.

Set-bit iteration over an unsigned word:

```cpp
// Context: mask is an unsigned integer and consume accepts an index.
while (mask != 0) {
    const unsigned index = std::countr_zero(mask);
    consume(index);
    mask &= mask - 1;  // clear the lowest set bit
}
```

This performs work proportional to the number of set bits. The snippet is contextual because `mask` and `consume` belong to the caller. Chapter 22 owns larger bitmap algorithms; Chapter 3 owns `bit_cast`, byte order, and object representation.

---

## 15.10 Random engines and distributions — Role-specific

The random library separates:

1. a source of seed material;
2. an engine that deterministically generates unsigned values from state;
3. a distribution that maps engine output to a requested statistical distribution.

```cpp
#include <cassert>
#include <random>

int main() {
    std::mt19937 engine{12345};  // fixed seed: reproducible test
    std::uniform_int_distribution<int> side{0, 1};

    const int first = side(engine);
    assert(first == 0 || first == 1);
}
```

Named standard engines specify their algorithms and sequences, but distribution algorithms are not required to produce the same exact sequence across standard-library implementations. A portable test can assert the range or statistical properties as above. A project requiring bit-for-bit cross-platform output needs to own or pin the mapping from engine words to results.

`default_random_engine` is implementation-defined and should not anchor reproducibility. A fixed seed is valuable for repeatable tests and simulation replay. For independent streams, record the full seeding scheme, engine type, and library assumptions.

`std::random_device` is intended to provide nondeterministic values when the implementation has such a source, but it may use a pseudo-random engine and reports implementation-defined quality through `entropy()`. It is not a standard cryptographic API. Construct and seed engines during initialization rather than repeatedly on a critical path.

Distributions can have state, and some sampling algorithms use rejection, producing variable work per result. That variability matters for tail latency even when average cost is acceptable. Benchmark the chosen engine-distribution pair with the production parameter range. Never use `engine() % n` as a general replacement for `uniform_int_distribution`; modulo reduction is biased unless the engine range aligns appropriately with `n`.

Standard engines prioritize reproducibility and statistical roles, not cryptographic unpredictability or universally minimal state. Security-sensitive randomness requires a security-reviewed platform/library facility outside `<random>`.

---

## 15.11 Calendars and time zones — Role-specific

C++20 calendar types express civil dates without collapsing them immediately into strings or untyped integers:

```cpp
#include <cassert>
#include <chrono>

int main() {
    using namespace std::chrono;

    year_month_day date{year{2028}, February, day{29}};
    assert(date.ok());
    assert(date.year().is_leap());

    sys_days midnight = date;
    year_month_day round_trip{midnight};
    assert(round_trip == date);
}
```

`year_month_day` can represent an invalid combination, so call `ok()` when components come from input. `sys_days` is a system-clock time point with day precision. Calendar arithmetic distinguishes adding months/years from adding fixed-duration days; month-end policy must be explicit.

The C++20 time-zone interface includes the time-zone database, `locate_zone`, `zoned_time`, `sys_info`, and `local_info`. Its central distinction is:

- `sys_time<Duration>` identifies a system timeline instant;
- `local_time<Duration>` is a local-clock reading without a zone;
- a time zone maps between them and exposes ambiguous/nonexistent local times around offset transitions.

Converting a local reading during a repeated interval can be ambiguous; converting one in a skipped interval can be nonexistent. APIs let callers choose a policy or report the condition rather than silently guessing.

Time-zone support depends on the standard-library implementation and access to time-zone database data. Deployment images need the relevant data, and library support must be tested on every target. Zone lookup, transition search, and formatting are control-plane/reporting work, not operations to insert into a measured hot loop.

Store the timeline representation required by the system contract, retain enough information to interpret it, and convert to a civil zone at boundaries. Chapter 35 owns synchronization, leap-second operational policy, and exchange clock discipline; Chapter 16 owns formatting.

---

## 15.12 SIMD status in C++23 — Role-specific reference

There is no `std::simd` facility in the C++23 standard library. Code using `<simd>` as a standard header targets a later standard/library. `std::experimental::simd` belongs to a Parallelism Technical Specification and is non-standard; availability, namespace, ABI, and API depend on the implementation.

For C++23 production code, explicit SIMD intent is expressed through one of:

- compiler-specific vector types or intrinsics;
- a vetted third-party SIMD library;
- scalar code designed for auto-vectorization and verified in generated code.

These choices trade portability, control, tail handling, alignment requirements, numerical reproducibility, and code size. A vector API does not itself guarantee a particular instruction, and auto-vectorization does not guarantee that a loop remains vectorized after a source change.

Chapter 42 owns SIMD instruction sets, intrinsics, alignment, masks, tails, and frequency effects. The C++23 boundary is simple: a draft or later `std::simd` API is not a C++23 standard facility.

---

## 15.13 Low-latency measurement checklist — Role-specific

Vocabulary types often look costless because their syntax is compact. Test the mechanisms:

| Type/facility | Measure or inspect | Tail-risk question |
|---|---|---|
| `tuple`/named struct | Size, padding, copies, generated ABI passing | Did a refactor change layout or copying? |
| `optional` | Size amplification, engagement branch, contained operations | Does fallback execute eagerly? |
| `variant` | Largest alternative, dispatch code, constructor/destructor paths | Can a transition throw or instruction footprint grow? |
| `any` | Allocation by held type, casts, copies | Does a rare metadata type escape small storage? |
| `bitset`/`<bit>` | Generated instructions for target feature set | Is conversion/formatting entering the path? |
| `<random>` | Engine state locality, distribution iterations | Does rejection produce a long tail? |
| `chrono` | `now()` overhead/resolution, conversion placement | Can clock adjustment or formatting contaminate timing? |

Use the production compiler, standard library, flags, and representative type distribution. A benchmark containing only the smallest variant alternative or only engaged optionals does not test the actual branch and object-density behavior. Report high percentiles as well as throughput, and retain a correctness test for every state.

---

## Recall card — Core

- **Product:** pair/tuple/named struct; every component is alive.
- **Nullable:** optional; zero or one `T`. Absence has one meaning and no error detail.
- **Closed sum:** variant; listed alternatives plus a possible valueless-by-exception state.
- **Open erased value:** any; run-time type, copyable payload, possible implementation-dependent allocation.
- **Representation:** do not infer tuple order, optional flags, variant tags, any small storage, or bitset words.
- **Access:** optional `value()` and variant `get` throw; `*optional` requires engagement; `get_if` reports mismatch.
- **Move:** moving optional leaves the source engaged; the contained `T` may be moved-from.
- **Lifetime:** tuple references and `reference_wrapper` borrow; neither extends referent lifetime.
- **Time:** duration carries unit; time point carries clock. `steady_clock` for intervals, `system_clock` for wall time.
- **C++23 boundary:** no standard `optional<T&>` and no standard `std::simd`.

---

## Common traps — Core

- Returning a tuple of several same-typed fields where a named result is part of the API contract.
- Assuming tuple is trivially copyable whenever every element is, or assuming its memory order.
- Storing a `forward_as_tuple` result that refers to a temporary.
- Forgetting that `make_tuple(std::ref(x))` stores a reference rather than an independent copy.
- Dereferencing an empty optional because `operator*` looks checked.
- Calling an expensive function as `value_or`'s argument and expecting lazy evaluation.
- Assuming moving an optional disengages the source.
- Using optional when callers need a failure reason.
- Ignoring `variant::valueless_by_exception` while allowing throwing state transitions.
- Adding a generic visitor fallback and still claiming compile-time exhaustiveness for new alternatives.
- Assuming `visit` must lower to a non-inlinable function-pointer table.
- Using `any` for a closed event set or expecting it to hold a move-only type directly.
- Keeping a `reference_wrapper` after its referent dies or relocates.
- Serializing bitset's raw object bytes.
- Treating `high_resolution_clock` as necessarily steady or cheaper.
- Timing very small work without accounting for the two `now()` calls.
- Expecting a standard distribution to reproduce identical values across libraries.
- Presenting `std::simd` as a C++23 facility.

---

## Reasoning questions

1. A result has three integer fields with distinct meanings. When is a tuple adequate, and what change in scope should trigger a named struct?
2. Why can `value_or(expensive())` perform expensive work when the optional is engaged, and which two rewrites make the laziness explicit?
3. After moving `optional<string>`, what can be said about source engagement and source contents?
4. What operations can leave a variant valueless, and how would an API either handle or rule out that state?
5. Why does a specific-lambda visitor help detect a new variant alternative while a generic `auto` fallback does not?
6. A plugin metadata system uses `variant` with 40 alternatives maintained centrally. What evidence would justify changing it to `any` or an interface?
7. Why is `reference_wrapper` safer than a raw reference for storage but no safer for lifetime?
8. Which clock should represent a five-second timeout deadline, and why can `system_clock` produce the wrong wait?
9. A simulation must replay bit-for-bit on three standard libraries. Which parts of `<random>` can it rely on, and which mapping may need project ownership?
10. Why is “bitset is an array of machine words” an unsafe serialization and ABI assumption even when every tested implementation currently behaves that way?

---

## Code-reading puzzle

```cpp
using Event = std::variant<Add, Cancel, Trade>;

void handle(const Event& event) {
    std::visit(overloaded{
        [](const Add& add) { process(add); },
        [](const Cancel& cancel) { process(cancel); },
        [](const auto& other) { log_unknown(other); }
    }, event);
}
```

The team adds `Amend` to `Event`, and this function still compiles. Why did the intended exhaustiveness check fail? Rewrite the visitor so adding a new alternative fails compilation until its policy is explicit. Then decide whether an intentional catch-all should log, reject, or be impossible for this domain.

---

## Design exercise

Design signatures for these five operations and defend the state and lifetime contract of each:

1. Return a venue's mandatory numeric ID and display name.
2. Look up an immutable order that remains owned by a stable repository and may be absent.
3. Parse a packet and return either a message or a structured error with byte offset.
4. Queue one of four closed market-data event types for single-threaded processing.
5. Attach extension-defined diagnostic metadata outside the critical path.

Use at least one named struct, one optional or optional reference-wrapper, one `expected`, one `variant`, and one `any`. For each, state whether it owns its payload, how the failure/empty state is observed, what can allocate, and which operation can invalidate a retained reference.

Finally add a fifth event alternative and compile the visitor. The exercise is complete only when the old visitor fails for the new type without relying on a run-time “unknown” branch.

---

## Prerequisite for Chapter 16

Chapter 16 assumes that durations and time points retain their units and clock domains until formatting; calendar/time-zone conversion happens at an I/O boundary; and a vocabulary wrapper's compact syntax does not prove that its contained value, erased storage, conversion, or formatting path is allocation-free. Formatting, buffering, and logging failure policy belong there.
