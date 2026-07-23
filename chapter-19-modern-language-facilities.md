# Chapter 19 — Modern Language Facilities

*The post-C++17 facilities most likely to change how real code is expressed, built, or executed—and the boundaries where their concise syntax hides lifetime, ordering, storage, or toolchain constraints.*

---

## Why this matters in an HFT interview — Core
Modern syntax is useful only when its hidden model is understood. Range-`for` and structured bindings can borrow or copy more than their surface syntax suggests. `<=>` can generate a coherent comparison family—or propagate an unordered floating-point domain. Constant evaluation moves work and validation to translation, while `constinit` controls initialization rather than constness. Modules change build dependencies and name ownership. Coroutines split one function across resumptions and introduce a frame whose lifetime must be owned.

For low-latency work, none of these features is automatically faster. The useful questions are concrete: does this form copy an element, extend an object's lifetime, add a branch chain, instantiate work in every importer, allocate a coroutine frame, or remove dynamic initialization? Chapter 10 owns move and elision mechanics; Chapter 20 owns asynchronous composition and cancellation.

## 90-second screen — Core
1. Select a language mode with the build, then test individual facilities with standard feature-test macros. A value of `__cplusplus` alone does not prove library availability.
2. In C++23, a range initializer extends the lifetime of its temporary objects through the loop, with an important exception for by-value parameters destroyed inside a callee. A view still cannot extend the lifetime of what it observes.
3. A structured binding first initializes a hidden object or reference, then binds names to its pieces. Plain `auto` can copy the whole source; `auto&` and `const auto&` borrow.
4. A defaulted `<=>` compares bases and members lexicographically and also declares a matching `==`. A hand-written `<=>` does not create equality. Floating members can make the result a `partial_ordering`.
5. `constexpr` permits constant evaluation when requirements are met; `consteval` requires it. `constinit` instead requires constant initialization of a static or thread-storage object and does not make that object immutable.
6. A coroutine is stackless and uses a separately managed state containing its promise, parameter state, and locals that survive suspension. The return type or runtime must define ownership; application design must not assume frame allocation is elided.

Two decisions: choose a feature from its semantic benefit rather than its age, and verify both compiler/library support and generated behavior on the deployed build before making a latency claim.

---

## 19.1 Language Baselines and Feature-Test Macros — Core

A standard mode is a contract with the implementation, not a claim that every optional header is deployed. A build flag such as `-std=c++23` selects a language mode; `__cplusplus` reports the active language level. For a particular feature, prefer its standard feature-test macro from `<version>` or the facility's own header.

| Facility | Standard | Feature-test macro | Priority | Deployment status to verify | Runtime implication |
|---|---:|---|---|---|---|
| range-`for` init-statement | C++20 | `__cpp_range_based_for` | Core | Broad language support | Syntax over iterator operations |
| C++23 range lifetime extension | C++23 | `__cpp_range_based_for >= 202211L` | Core correctness | Exact compiler mode | Prevents a class of dangling temporaries |
| structured bindings | C++17 | `__cpp_structured_bindings` | Core | Broad language support | Copy or borrow follows the declaration |
| three-way comparison | C++20 | `__cpp_impl_three_way_comparison`, `__cpp_lib_three_way_comparison` | Core | Compiler plus `<compare>` | Generated comparison control flow |
| immediate functions | C++20 | `__cpp_consteval` | Core | Compiler syntax | Work is required during translation |
| modules | C++20 | `__cpp_modules` | Conceptual core | Compiler, scanner, build system, library packaging | Changes build graph and name ownership |
| coroutines | C++20 | `__cpp_impl_coroutine`, `__cpp_lib_coroutine` | Role-specific | Compiler plus `<coroutine>` | May create a separately owned frame |
| `constinit` | C++20 | `__cpp_constinit` | Core | Compiler syntax | Rejects dynamic initialization |
| explicit object parameters | C++23 | `__cpp_explicit_this_parameter` | Core | Exact compiler version | Consolidates overloads; no inherent runtime mechanism |
| `std::generator` | C++23 | `__cpp_lib_generator` | Role-specific | Standard-library header | Lazy single-pass coroutine range |

Macro values matter because a macro name can survive a later revision. Guard the smallest affected interface:

```cpp
#include <version>

#if defined(__cpp_lib_generator) && __cpp_lib_generator >= 202207L
// expose the std::generator-based overload
#else
// expose a documented fallback, or omit the facility
#endif
```

Do not invent project copies of standard macros. A compiler can implement language syntax before its standard library provides the associated header, which is why coroutine language and library macros are distinct. Conversely, a vendor may backport a library facility to an older language mode. The build matrix and a compile probe are the final evidence.

This chapter uses standard C++ through C++23. Feature availability still varies by compiler, standard library, and build system; implementation tables age quickly, so the macros and a small CI compile test are more durable than version folklore.

---

## 19.2 Range-Based For Loops — Core

```cpp
for (auto&& x : expr) body;
```

expands, from C++17, to roughly:

```cpp
{
    auto&& __range = expr;                 // lifetime extension applies here
    auto __begin = begin-expr;
    auto __end   = end-expr;               // C++17: __end may differ in type (sentinels)
    for (; __begin != __end; ++__begin) {
        auto&& x = *__begin;
        body;
    }
}
```

For a class range, member lookup is used when it finds both a declaration named `begin` and one named `end`; otherwise non-member `begin(__range)` and `end(__range)` are found by argument-dependent lookup. Ordinary unqualified lookup is not added. Arrays are special-cased. Since C++17, the end expression may have a different sentinel type from the iterator (Chapter 14).

### The dangling-reference trap

Before C++23, `__range` extended the top-level range temporary but not every temporary nested in the range initializer. Assuming `name()` returns a reference to a member, this intentionally unsafe fragment demonstrates the bug:

```cpp
for (char c : get_object().name())   // pre-C++23: UB. get_object()'s temporary is destroyed
    ...                              // after the range initializer; name() then dangles
```

C++23 extends the lifetime of temporaries within the for-range-initializer through the loop. The rule has a boundary: a by-value parameter object destroyed inside a called function is still destroyed there. A function that accepts a range by value and returns a reference to that parameter is already returning a dangling reference; range-`for` cannot repair it.

For code that must also compile as C++20, or where ownership is visually unclear, use the init-statement to name the owner:

```cpp
for (auto obj = get_object(); char c : obj.name()) {
    /* ... */
}
```

The C++23 rule also does not turn a non-owning view into an owner. If a temporary owner is converted to `string_view` or `span` and destroyed before the loop, the view dangles. Compiler lifetime warnings and AddressSanitizer catch some—but not all—instances; an explicit owner is the stronger design.

### Choosing the loop variable

| Form | Meaning |
|---|---|
| `for (auto x : r)` | Initializes a new `x` from each dereference; intentional for small values or snapshots. |
| `for (const auto& x : r)` | Read-only borrow when dereference yields a bindable object. |
| `for (auto& x : r)` | Mutable lvalue binding; unsuitable when dereference yields a prvalue proxy. |
| `for (auto&& x : r)` | Generic form: binds proxies, prvalues from views, and real references alike. |

`auto&&` is the flexible choice in generic code because dereference may produce a proxy or prvalue. It does not mean read-only: mutating `x` may mutate the range, a proxy target, or only a temporary depending on the iterator contract. Use the narrowest form matching the algorithm.

A C++20 init-statement (`for (auto vec = make(); const auto& x : vec) { ... }`) sidesteps the whole dangling question structurally and predates the C++23 fix.

### Low-latency note

The desugaring adds no required abstraction beyond obtaining iterators and applying their operations. Cost comes from those operations and the range representation: contiguous iteration supports spatial locality, while node-based iteration adds pointer dependencies. Range-`for` hides that distinction syntactically; Chapters 11 and 12 own container selection.

---

## 19.3 Structured Bindings — Core

C++17. Decomposes an object into names for its parts.

```cpp
auto [a, b] = std::pair{1, 2.0};
auto& [x, y] = some_pair;
const auto& [k, v] = *map_iterator;
```

The compiler introduces a hidden variable `e`, copy- or reference-initialized from the right-hand side per the `auto`/`auto&`/`const auto&` qualifier written. Each name is not a new variable — it names a piece of `e` (or the result of `get<i>(e)` in the tuple-like case). This is why `decltype(a)` yields the member's own type, not a reference type: it reports what `a` logically is, not how it is implemented.

Three decomposition protocols, tried in order:

1. **Array** — names bind to elements; the number of names must match the bound.
2. **Tuple-like** — if `std::tuple_size<E>` is a complete type with a `::value` member: name `i` is initialized from `e.get<i>()` if a member `get` exists, else from `get<i>(e)` via ADL. Types come from `std::tuple_element<i, E>::type`. Implement those three customization points to make a type decomposable.
3. **Data-member decomposition** — all non-static data members must live in the same class (not split across base and derived) and must be accessible at the point of use. Ordinary accessibility rules apply, so a `friend` function can decompose an object with private members even though outside code cannot.

```cpp
struct S { int a; double b; };
auto [i, d] = S{1, 2.0};                        // case 3, direct member binding
for (const auto& [key, val] : my_map) { /* */ }  // case 2, via pair
```

### Rules that surprise

- Attributes and declaration specifiers apply to the structured-binding declaration, not independently to each introduced name. C++23 has no discard placeholder; a name such as `_` is still an ordinary identifier.
- C++17 did not permit capturing a structured binding in a lambda. C++20 permits capture, subject to the ordinary restrictions of the entity it denotes; for example, a bit-field cannot be captured by reference.
- With an lvalue source, `auto [a, b] = expr;` copy-initializes the hidden `e`; a prvalue can initialize it directly. Decomposing lvalue elements with plain `auto` in a loop can therefore copy each element; borrow with `const auto&` when that is the intent.
- Lifetime extension applies normally to `e`: `auto&& [a, b] = f();` extends the temporary through `e`.

The canonical use is the map-insert idiom:

```cpp
if (auto [it, inserted] = cache.try_emplace(key, value); !inserted) { it->second = value; }
```

---

## 19.4 Three-Way Comparison — Core

C++20's `operator<=>` returns a comparison-category object rather than a `bool`; the compiler synthesizes the four relational operators from it.

```cpp
struct Point {
    int x, y;
    auto operator<=>(const Point&) const = default;   // lexicographic, member-wise
    // == is not synthesized from <=> in general, but a DEFAULTED <=> also
    // implicitly defaults operator==.
};
```

### The three categories

| Category | Means | Example |
|---|---|---|
| `std::strong_ordering` | Total ordering result; equality is intended to imply substitutability | `int`, `std::string`, built-in pointer `<=>` result type |
| `std::weak_ordering` | Total order; equivalent values may still be distinguishable | case-insensitive string, sort-by-one-field |
| `std::partial_ordering` | Some pairs are unordered | `double` (NaN) |

`double`'s `<=>` yields `partial_ordering` because `NaN <=> x` is `unordered`: comparisons with zero can all be false. Built-in pointer `<=>` has result type `strong_ordering`, but that type alone does not promise a stable address order for unrelated objects: when the language's pointer order does not determine a direction, the result is unspecified. The library function object `std::compare_three_way` supplies a strict total order for pointers when the built-in result is unspecified. An address order is still process-specific and rarely belongs in persistent business semantics.

### Rewriting rules

For `a < b`, the compiler considers `a < b` (normal lookup) and the rewritten candidates `(a <=> b) < 0` and `0 < (b <=> a)`; whichever wins overload resolution is used.

- One `<=>` participates in rewritten candidates for `<`, `>`, `<=`, and `>=`, including reversed-argument candidates.
- `==`/`!=` rewrite separately from `operator==`. Equality may have a cheaper implementation than ordering; a *defaulted* `<=>` is the special case that also declares a defaulted `==`.
- Reversed candidates can make a pre-C++20 heterogeneous `operator==(const A&, const B&)` plus a member `operator==` ambiguous. This, plus `operator==` becoming const-sensitive, is the most common C++17→20 comparison migration break.

```cpp
struct Version {
    int major, minor;
    std::strong_ordering operator<=>(const Version& o) const {
        if (auto c = major <=> o.major; c != 0) return c;
        return minor <=> o.minor;
    }
    bool operator==(const Version&) const = default;
};
```

`std::strong_order` and `std::weak_order` are customization-point objects that provide specified ordering semantics for floating point, including signed zero and NaNs. Use the operation whose equivalence semantics match the domain rather than assuming built-in `<=>` is total.

### Low-latency angle

A defaulted `<=>` expresses lexicographic member order; an implementation commonly emits short-circuit comparisons. That can be ideal when early fields usually differ, or branch-sensitive when prefixes are often equal. Packing fields into one integer is valid only if the encoding preserves the intended order, widths, signedness, and overflow policy. Benchmark representative key distributions and inspect code generation before replacing the clearer defaulted comparison.

**Trap:** do not expect a hand-written `<=>` to create `==`, and do not assume a defaulted `<=>` gives a total order on a struct containing a `double`; its common comparison category becomes `partial_ordering`.

---

## 19.5 Constant Evaluation: `constexpr`, `consteval`, and `if consteval` — Core

Constant evaluation is an execution mode of the abstract machine. It can prove invariants and produce data during translation, but the keywords make different promises.

| Form | Promise | May also run at runtime? | Typical use |
|---|---|---:|---|
| `constexpr` variable | initializer is a constant expression; object is `const` | No mutation of that object | named constant or precomputed table |
| `constexpr` function | function is eligible for constant evaluation when called with suitable arguments | Yes | one algorithm usable at translation and runtime |
| `consteval` function | every potentially evaluated immediate invocation must produce a constant expression | No ordinary runtime call | validation or compile-time-only construction |
| `if consteval` | selects a branch according to whether evaluation is manifestly constant-evaluated | The other branch handles runtime | different implementation for the two modes |

`constexpr` does not mean “the compiler will precompute this call.” Context decides:

```cpp
#include <array>
#include <cstdint>

constexpr std::uint32_t hash(std::uint32_t x) noexcept {
    x ^= x >> 16;
    x *= 0x7feb352dU;
    x ^= x >> 15;
    return x;
}

constexpr auto fixed = hash(42);  // required constant evaluation

std::uint32_t runtime(std::uint32_t input) {
    return hash(input);            // ordinary runtime call is permitted
}

static_assert(fixed == hash(42));
```

The implementation may constant-fold the runtime call when its input becomes known, but that is optimization under the as-if rule, not the `constexpr` contract. Conversely, a `constexpr` call in a required constant-expression context must satisfy the constant-evaluation restrictions or compilation fails.

### Immediate validation with `consteval`

An immediate function is useful when accepting an invalid value at runtime would be a design error. This complete C++20 example converts a four-character protocol tag into a stable big-endian integer:

```cpp
#include <cstdint>
#include <string_view>

consteval std::uint32_t tag(std::string_view s) {
    if (s.size() != 4) throw "tag must contain four bytes";
    std::uint32_t result = 0;
    for (unsigned char c : s)
        result = (result << 8) | c;
    return result;
}

constexpr auto order_tag = tag("ORDR");
static_assert(order_tag == 0x4f524452U);

int main() {
    return order_tag == 0 ? 1 : 0;
}
```

The `throw` is not a runtime error channel here. If that path is taken during immediate invocation, the expression is not constant and the program is ill-formed. Diagnostics point to the bad call. Inputs learned from a socket or configuration file cannot call `tag`; they need an ordinary checked parser.

A pointer or reference to an immediate function may exist transiently during constant evaluation, but cannot escape as a permitted constant-expression result. This prevents smuggling a `consteval` function into an ordinary runtime callback.

### `if consteval` in C++23

`std::is_constant_evaluated()` (C++20) reports whether evaluation is manifestly constant-evaluated. C++23's `if consteval` expresses the same architectural split without relying on a normal condition:

```cpp
#include <optional>

constexpr std::optional<int> square(int x) {
    if (x > 46'340 || x < -46'340) {
        if consteval {
            throw "square overflows int";
        } else {
            return std::nullopt;
        }
    }
    return x * x;
}

static_assert(square(12).value() == 144);
```

This example gives the modes different failure transport but the same valid results: an invalid static call fails translation, while an invalid runtime call returns an empty `optional`. Such a split can improve diagnostics, but avoid silently giving the modes different mathematics.

### Cost and correctness

Constant evaluation can remove runtime parsing, branching, or table construction and can fail the build on an invalid static configuration. It can also increase compile time and place a large result in the binary, affecting instruction or data-cache footprint. A generated lookup table is not “free”: its construction moved to the compiler, while its storage and memory traffic remain at runtime.

C++20 permits dynamic allocation during constant evaluation only when the allocated storage is released within that evaluation; ordinary heap storage cannot persist into the resulting program through C++23. Compile-time interpreters also have step and recursion limits. Measure build time, object-section size, and the runtime path before choosing a large `constexpr` computation over a compact runtime algorithm.

Decision rule: use `constexpr` when one pure implementation should serve both modes, `consteval` when runtime use would be nonsensical, `constinit` (§19.9) when initialization timing—not immutability—is the requirement, and a normal function when inputs and failures are inherently runtime concerns.

---

## 19.6 Modules — Core

C++20 modules provide a semantic interface that can replace many textual inclusions. They do not make headers obsolete: C interoperability, configuration macros, and libraries not packaged as modules still need header-based boundaries.

```cpp
// math.cppm: module interface unit
export module math;

export int add(int a, int b);     // exported: visible to importers
int helper();                     // not exported; attached to module math
export namespace geo { struct Point { int x, y; }; }

// consumer.cpp: separate translation unit
import math;
int main() { return add(1, 2); }
```

| | `#include` | `import` |
|---|---|---|
| Mechanism | Textual replacement, then parsing in each TU | Consume a compiler-generated semantic interface artifact |
| Macros | Can affect and escape a header | Named-module imports do not export macros; header units can import macros |
| ODR exposure | Macro state can produce divergent definitions | Named-module ownership removes many textual divergence paths, not every ODR bug |
| Order sensitivity | Include order can change meaning | Order-independent between imports |
| Non-exported names | External or internal linkage according to the declaration | A name attached to a named module can have module linkage |
| Build graph | Consuming TUs are largely independent once headers exist | Interfaces must build before consumers—requires dependency scanning |

Module linkage is distinct from internal linkage. When a declaration with module linkage is reachable in another unit of the same named module, it denotes the same entity; it is not reachable to importers merely because they import the module. “Same module” does not remove the need for declarations and partition imports. Names can still have internal linkage inside a module.

### Structure

- **Module interface unit** — `export module M;`, exactly one primary per module.
- **Module implementation unit** — `module M;` (no `export`). It implicitly imports the primary interface. An implementation-only change need not alter the interface artifact, though the build system decides what is rebuilt.
- **Module partitions** — interface or implementation units named `M:part`; only units of module `M` may import them directly.
- **Header units** — `import <vector>;` or an importable project header; a migration bridge with semantics different from named modules, including macro import.
- **Global module fragment** — `module;` then `#include <legacy.h>` then `export module M;` — where textual includes that must remain textual go.

### Status and traps

- Toolchain and build-system support—dependency scanning, artifact naming, caching, and standard-library packaging—is the practical adoption constraint. `import std;` is standardized in C++23, but availability still depends on how the selected standard library is built and exposed.
- BMIs (compiled module interfaces) are not portable across compilers, versions, or even flags. Treat them as cache/build artifacts tied to a compatible toolchain rather than as a portable distribution format.
- Exporting a template does not generally pre-instantiate every specialization; importers still request specializations, so modules do not erase template-instantiation cost (Chapter 17).
- An `#include` directive is syntactically possible in module purview, but declarations it introduces become attached to that module and may conflict with their use elsewhere. Legacy headers intended for global ownership normally belong in the global module fragment.

**Trap:** modules can reduce repeated parsing and make ownership explicit; they do not guarantee faster clean builds, stable binary-module artifacts, or one-time template instantiation. Measure clean and incremental builds with the actual dependency scanner and cache.

---

## 19.7 Coroutines — Role-specific

Skip this section on a first pass if you are not touching async I/O, generators, or a scheduler; come back before Chapter 20, which builds on it.

A C++20 coroutine is a function whose execution can be suspended and resumed. Any function containing `co_await`, `co_yield`, or `co_return` is one. There is no `coroutine` keyword and no coroutine type in the language: the compiler transforms the function against a customization protocol and hands the result to a library type you or the standard library supplies. C++20 shipped only the transformation; C++23 shipped the first user-facing type, `std::generator`.

This deliberately small lazy result type is complete enough to show frame ownership. It is an educational mechanism, not an async framework:

```cpp
#include <coroutine>
#include <exception>
#include <utility>

class Once {
public:
    struct promise_type;
    using handle_type = std::coroutine_handle<promise_type>;

    explicit Once(handle_type h) noexcept : h_(h) {}
    Once(Once&& other) noexcept
        : h_(std::exchange(other.h_, {})) {}
    Once(const Once&) = delete;
    ~Once() { if (h_) h_.destroy(); }

    int get();

    struct promise_type {
        int value{};
        std::exception_ptr error;

        Once get_return_object() noexcept {
            return Once{handle_type::from_promise(*this)};
        }
        std::suspend_always initial_suspend() const noexcept { return {}; }
        std::suspend_always final_suspend() const noexcept { return {}; }
        void return_value(int v) noexcept { value = v; }
        void unhandled_exception() noexcept { error = std::current_exception(); }
        template<class T>
        void await_transform(T&&) = delete;  // Once supports no user co_await
    };

private:
    handle_type h_;
};

int Once::get() {
    if (!h_.done()) h_.resume();
    if (h_.promise().error) std::rethrow_exception(h_.promise().error);
    return h_.promise().value;
}

Once answer() { co_return 42; }

int main() {
    auto result = answer();
    return result.get() == 42 ? 0 : 1;
}
```

`answer()` allocates or otherwise obtains a frame, constructs its promise, and returns a handle-owning `Once` while initially suspended. This teaching type rejects user-written `co_await`, so one resume reaches `co_return`; `final_suspend` keeps the completed frame alive, and `Once` destroys it. A production type also needs a policy for repeated result access, concurrent access, cancellation, continuation ownership, and allocation failure.

**Stackless.** The frame holds only the coroutine's own locals and state, not a call stack, so a coroutine can suspend only from its own body—never from inside a function it calls. Contrast with stackful coroutines/fibers (Chapter 31 §31.9), which can suspend from a nested call but require a stack per task.

| | Stackless (C++20 coroutines) | Stackful (fibers, ucontext) |
|---|---|---|
| Memory per task | Compiler-sized frame for this coroutine | Reserved/committed stack plus control state |
| Suspend depth | Only in the coroutine's own body | Anywhere in the call tree |
| Optimization boundary | Compiler can analyze the transformed function; frame elision remains conditional | Context switch is typically opaque to ordinary inlining |
| Diagnostic shape | Logical async chain is not an ordinary machine stack | Suspended call chain remains on the fiber stack |

### The transformation (schematic — not compilable)

```
promise_type P = std::coroutine_traits<R, Args...>::promise_type;

obtain storage for the coroutine frame
copy/move parameters into the frame
construct P
R ret = promise.get_return_object();       // returned to the caller
co_await promise.initial_suspend();
try   { <function body> }
catch (...) { promise.unhandled_exception(); }
co_await promise.final_suspend();          // final-suspend path must not throw
destroy the frame now, or later through an owning handle
```

Three keywords: `co_await e` suspends until `e` completes (the awaitable protocol, below); `co_yield v` is `co_await promise.yield_value(v)`; `co_return v` calls `promise.return_value(v)` (or `return_void()`) and jumps to `final_suspend`.

**Everything below is framework-level scaffolding.** A promise type is normally plumbing supplied by a task or generator abstraction. Treat the code in this section as illustrating the mechanism, not as a template to paste into a trading system.

### The promise and the frame

```cpp
// Pseudocode: the shape a promise type must have, not a working type on its own.
struct promise_type {
    Task get_return_object();
    std::suspend_always initial_suspend();          // or suspend_never
    std::suspend_always final_suspend() noexcept;    // must be noexcept
    void return_void();                              // xor return_value(T)
    void unhandled_exception();
    // optional:
    auto yield_value(T);              // enables co_yield
    auto await_transform(X);          // intercepts every co_await in the body
    static void* operator new(size_t);
    static void  operator delete(void*, size_t);
};
```

`initial_suspend` helps choose lazy versus eager start: `suspend_always` returns control before the body runs; `suspend_never` starts the body immediately and returns at a later suspension or completion. Neither choice alone defines ownership or “fire-and-forget” semantics. If the final awaiter does not suspend, the state is destroyed as execution completes and any outstanding handle dangles. Result-bearing task types commonly suspend at the end, transfer or expose the result, and require one owner eventually to call `destroy()`.

The coroutine state contains the promise object, copies of by-value parameters, reference state for reference parameters, and local objects whose lifetimes cross suspension. Implementations commonly add a resume discriminator and code pointers; their exact frame layout is not standardized.

```
┌──────── coroutine state (separate storage, or embedded when elided) ───────┐
│ promise_type                                                              │
│ parameter copies (by value only — references are NOT copied here)         │
│ locals live across a suspend point                                        │
│ implementation bookkeeping for resume and destruction                     │
└─────────────────────────────────────────────────────────────────────────┘
     ^                                                    ^
     |  coroutine_handle<P> — non-owning, trivially        |
     |  copyable pointer to this frame                     |
  caller holds one via get_return_object()          scheduler/continuation
                                                       may hold another
```

`std::coroutine_handle<P>` is that non-owning, trivially copyable pointer: `resume()`, `destroy()`, `done()`, `promise()`, `from_promise()`. Copying it copies the pointer, not the frame; using it after `destroy()` is UB. The type-erased `coroutine_handle<>` (no promise type) is how a scheduler stores heterogeneous coroutines uniformly.

**Reference-parameter trap:**

```cpp
Task process(const std::string& s) { co_await something(); use(s); }  // dangling
process(std::string("temp"));   // temporary dies at the end of the full-expression;
                                 // the coroutine resumes later holding a dangling ref
```

Take a coroutine parameter by value when the coroutine must own that value across suspension. Borrowing by reference is valid only when an external lifetime protocol keeps the referent alive until completion. A coroutine lambda's captures remain members of its closure object; the coroutine invocation can retain only the implicit object reference rather than a copy of that closure. Calling a temporary capturing coroutine lambda can therefore leave the frame referring to a destroyed closure. Prefer a non-coroutine lambda that passes owned values into a named coroutine, or keep the closure alive explicitly.

### The awaitable protocol and symmetric transfer

`co_await expr` is rewritten as:

```
1. e = promise.await_transform(expr) if applicable, else e = expr
2. obtain awaiter via member/free operator co_await if found, else use e
3. if (!awaiter.await_ready()) {
       <spill live locals into the frame, record resume index>
       awaiter.await_suspend(handle);     // return type controls what happens next
       <return to whoever resumed this coroutine>
   }
4. result = awaiter.await_resume();
```

`await_suspend`'s return type is the control-flow lever:

| Return type | Effect |
|---|---|
| `void` | Suspend; return control to the resumer. |
| `bool` | `true` suspends; `false` resumes immediately (the operation completed synchronously). |
| `coroutine_handle<>` | Transfer execution to the returned coroutine handle. |

Returning a handle enables **symmetric transfer**: implementations can transfer directly to the next coroutine without recursively calling `resume()` from user code and retaining each resumer's machine frame. This is the mechanism used to avoid unbounded stack growth in long await chains. `std::noop_coroutine()` is a handle whose resume and destroy operations have no effect, useful when no continuation exists:

```cpp
struct final_awaiter {
    bool await_ready() noexcept { return false; }
    std::coroutine_handle<> await_suspend(std::coroutine_handle<promise_type> h) noexcept {
        return h.promise().continuation ? h.promise().continuation
                                         : std::noop_coroutine();
    }
    void await_resume() noexcept {}
};
```

`await_transform`, when present and applicable, customizes user-written `co_await` expressions in the body. A task framework can use it to expose execution context, but Chapter 20 owns cancellation and composition policy.

### Allocation

The coroutine state is obtained through an allocation function: a suitable promise-type `operator new` is considered before the global allocation function. If the promise supplies `get_return_object_on_allocation_failure`, allocation uses a non-throwing form and can return a failure object; otherwise failure normally propagates as `std::bad_alloc`.

The standard permits allocation elision when the coroutine state's lifetime is strictly nested within the caller's and the frame size is known at the call site. The state may then be embedded in caller storage. Meeting those conditions permits elision; it does not require it. Handle escape, separate compilation, and opaque scheduling commonly make the proof harder, but no single source pattern is a portable “elision off” switch.

When allocation-free steady state is required, use an explicit ownership and storage policy rather than relying on elision. A promise-specific allocator can route frames to a pool:

```cpp
// Pseudocode — frame_pool is an application-supplied fixed-block allocator (Ch. 7/8).
struct promise_type {
    static void* operator new(std::size_t n) { return frame_pool::allocate(n); }
    static void  operator delete(void* p, std::size_t n) { frame_pool::deallocate(p, n); }
};
```

Frame size and alignment are compiler-determined and can change when a parameter, promise member, awaiter, or cross-suspend local changes. A pool must accept the actual size/alignment request, reject exhaustion explicitly, and be validated on each supported build. Fixed blocks waste space when coroutine shapes vary; segregated size classes add metadata and branches. Chapter 7 owns allocator design.

### `std::generator` (C++23)

`<generator>` is the first standard coroutine type: a synchronous, lazy, single-pass range.

```cpp
#include <version>

#if defined(__cpp_lib_generator) && __cpp_lib_generator >= 202207L
#include <generator>
std::generator<int> fib() {
    int a = 0, b = 1;
    while (true) { co_yield a; int t = a; a = b; b = t + b; }
}
#endif
```

`std::generator<Ref, V = void, Alloc = void>` models an `input_range`: iteration is single-pass and begins lazily. Its references can designate values held in coroutine state, so do not retain them across increment or destruction without a stronger type-specific guarantee. The second template argument can specify a value type when the default derived from `Ref` is unsuitable.

Naively forwarding every nested yield through every recursive level makes resume work scale with nesting depth. `co_yield std::ranges::elements_of(nested)` is the standard delegation form; `generator` tracks the active coroutine stack so iteration resumes the innermost generator directly.

Use a generator when production is naturally stateful or recursive and the consumer may stop early. Prefer a range view for a simple transformation over an existing range: it avoids a separately owned coroutine state and offers different inlining opportunities. On a constrained path, compare frame allocation, resume dispatch, branch behavior, and early-termination benefit against a hand-written iterator or state machine.

**Trap:** a generator is single-pass — no `sort`, no `size`, no second iteration.

---

## 19.8 Explicit Object Parameters (“Deducing `this`”) — Core

C++23 explicit object member functions write the object parameter in the parameter list:

```cpp
struct S {
    void f(this S& self);          // like void f() &
    void g(this const S& self);    // like void g() const&
    void h(this S self);           // by value — new capability
    template <class Self>
    auto&& value(this Self&& self) { return std::forward<Self>(self).v; }
    int v;
};
```

The explicit object parameter comes first, and the declaration has no trailing cv- or ref-qualifiers. Such a function cannot be `static` or `virtual`, and its body has no implicit `this`; members are reached through the named object parameter. “Deducing `this`” is the common nickname for the templated form, but the parameter can also have a concrete type.

### What it solves

**The quadruple-overload problem.** A getter that propagates const-ness and value category correctly used to need four near-identical bodies:

```cpp
T&        get() &       { return v; }
const T&  get() const&  { return v; }
T&&       get() &&      { return std::move(v); }
const T&& get() const&& { return std::move(v); }
// vs. one:
template <class Self> auto&& get(this Self&& self) { return std::forward<Self>(self).v; }
```

`Self` deduces as `S&`, `const S&`, `S`, or `const S` by forwarding-reference rules (Ch. 17), and `std::forward<Self>(self).v` yields the matching category.

**Recursive lambdas without a fixed-point combinator:**

```cpp
auto fact = [](this auto&& self, int n) -> int { return n <= 1 ? 1 : n * self(n - 1); };
```

Previously this required passing the closure to itself, a fixed-point helper, or type erasure. The explicit object form keeps the recursive call statically dispatched.

**CRTP without the CRTP template parameter:**

```cpp
struct Base { template <class Self> void f(this Self&& self) { self.impl(); } };
struct Derived : Base { void impl(); };
```

No `Base<Derived>`, and no possibility of the classic mistake `struct A : Base<B> {};`.

**By-value object parameters.** `void f(this S self)` asks for a copy or move of the object, which can be useful for small value-like handles. Whether it improves calling convention or code generation is ABI- and optimizer-specific; it also changes semantics by operating on a separate object.

### Traps

- `self` is not `*this`, and there is no `this`: an unqualified `v` inside such a function is ill-formed.
- Cannot be `virtual`; an explicit-object member function is not in the vtable — static polymorphism only.
- A deduced `Self` in a base class deduces to the *derived* type at the call site, so `self.f()` inside `f` can recurse infinitely if the derived class inherits rather than overrides — constrain with concepts if that matters.
- A forwarding getter called on a temporary can return a reference into that temporary. Category preservation does not extend lifetime; the caller must consume the result before the full-expression ends.
- Toolchain support varies by version; check the exact minimum your build uses, especially for lambdas combined with explicit object parameters, which lagged in some early implementations.

---

## 19.9 `constinit` and Constant Initialization — Core

Chapter 5 owns storage duration and the static-initialization-order problem. `constinit` addresses one part: it requires a variable with static or thread storage duration to undergo constant initialization.

Static initialization consists of constant initialization when applicable, otherwise zero-initialization. Dynamic initialization follows under rules that depend on the kind of variable and translation-unit dependencies. The familiar failure occurs when one dynamic initializer reads another object before that object's dynamic initialization. `constinit` (C++20) makes dynamic initialization ill-formed for that declaration:

```cpp
#include <atomic>

constinit int counter = 42;                        // guaranteed static init
constinit std::atomic<int> flag{0};                 // OK — constexpr constructor
constinit thread_local int tls_index = 0;
```

| Keyword | Guarantees constant init? | Implies constness? | Usable in constant expressions? |
|---|---|---|---|
| `const` | No | Yes | Not in general; `const` alone is insufficient |
| `constexpr` (variable) | Yes | Yes | Yes, subject to constant-expression rules |
| `constinit` | Yes | No | Not by virtue of `constinit` |

`constinit` is the middle case: require constant initialization without itself imposing constness, so a non-`const` object may later mutate. It cannot be combined with `constexpr`, which already implies constant initialization and constness. If a declaration uses `constinit`, a `constinit` declaration must be reachable from the variable's initializing declaration; violating that rule is ill-formed, with a diagnostic not required in the unreachable case.

### Why it matters at low latency

1. There is no dynamic initializer for that variable, so its initial value does not depend on startup code in another translation unit.
2. A function-local object that is constant-initialized needs no language-level first-use synchronization for initialization. Common ABIs therefore omit the dynamic-initialization guard used by a non-constant local static; inspect the target code before assigning a cycle cost.
3. For `thread_local`, `constinit` removes dynamic initialization of the object but does not select a TLS addressing model. Position independence, shared-library boundaries, visibility, and linker relaxation still determine whether access is direct or calls a resolver (Chapters 24 and 41).

`constinit` says nothing about destruction. An object with a non-trivial destructor still participates in static or thread-local destruction, whose ordering can create a separate shutdown hazard. Prefer trivially destructible global state where practical, or give process-lifetime ownership an explicit shutdown policy.

**Trap:** `constinit` does not remove the destruction-order hazard, only the construction-order one.

---

## Worked Feature Choice: A Market-Data Decode Boundary — Core

Suppose a decoder receives batches whose storage remains valid only until the batch object is released. Each message has a compile-time-known four-byte protocol tag, a runtime opcode, and a `(symbol, price, sequence)` key used for deterministic ordering. The process also maintains a mutable per-thread counter.

Start from semantics, not novelty:

| Requirement | Facility choice | Reason and boundary |
|---|---|---|
| Iterate message views safely | range-`for` init-statement naming the owning batch | Makes ownership visible and works before the C++23 lifetime extension too |
| Inspect fields without copying a message | `const auto& [header, payload]` if the message exposes a stable tuple-like decomposition | Plain `auto` could copy the hidden object; a binding cannot repair a dangling payload view |
| Encode fixed protocol tags | `consteval` validator | Invalid literals fail translation; runtime input still uses a checked parser |
| Order keys | defaulted `<=>` with members declared in semantic order | Correct lexicographic order first; packed representation only after proof and measurement |
| Initialize a mutable counter | `constinit thread_local` | Requires constant initialization; does not dictate TLS addressing cost |
| Hide decoder implementation | module implementation unit if the build supports modules | Adoption is a build/toolchain decision, not a runtime optimization |
| Decode each message | ordinary function/state machine | No suspension is required; a coroutine frame would add ownership machinery without a semantic benefit |

A compact core can look like this:

```cpp
#include <compare>
#include <cstdint>

struct QuoteKey {
    std::uint32_t symbol;
    std::int64_t price_ticks;
    std::uint64_t sequence;
    auto operator<=>(const QuoteKey&) const = default;
};

consteval std::uint32_t protocol_tag(char a, char b, char c, char d) {
    return (std::uint32_t{static_cast<unsigned char>(a)} << 24) |
           (std::uint32_t{static_cast<unsigned char>(b)} << 16) |
           (std::uint32_t{static_cast<unsigned char>(c)} << 8) |
            std::uint32_t{static_cast<unsigned char>(d)};
}

constexpr auto quote_tag = protocol_tag('Q', 'U', 'O', 'T');
constinit thread_local std::uint64_t decoded_messages = 0;

static_assert(QuoteKey{7, 100, 1} < QuoteKey{7, 101, 0});
```

The member order makes the comparison contract inspectable. Packing the key would need a proof that signed prices, widths, and sequence overflow preserve the same order; without that proof, “fewer comparisons” is an invalid optimization. The thread-local counter avoids dynamic initialization, but the deployed TLS model still determines access instructions. The batch loop should name its owner:

```cpp
for (auto batch = source.next_batch(); const auto& message : batch.messages()) {
    decode(message);
    ++decoded_messages;
}
```

This fragment assumes `next_batch()` returns an owning batch and `messages()` returns a view valid for that owner's lifetime. The success measures are specific: lifetime tests under sanitizers, comparison property tests, no dynamic initialization in object inspection, generated TLS access on each deployment target, and measured decoder latency. Feature choice follows the invariant each feature establishes.

---

## 19.10 Contracts and Static Reflection — Outside the C++23 Baseline — Reference

Standard C++ through C++23 has no language contracts facility and no general static-reflection facility. Do not write draft syntax or design an API around a proposal as though it were portable C++23. In this baseline, projects use ordinary functions and types, assertions or project-specific invariant checks for contracts, and templates, code generation, or narrowly scoped libraries for reflection-like tasks. `[[assume(expr)]]` is C++23, but it is an optimizer assumption whose violation causes undefined behavior—not a checked precondition.

Treat any later contracts or reflection facility as a separate language-baseline decision. Verify adopted wording, feature-test macros, compiler support, and operational semantics before use.

---

## Recall and practice — Core
### Recall card

- Use feature-test macros for individual facilities; language mode and compiler version alone do not prove matching library support.
- C++23 extends range-initializer temporaries through the loop, except objects such as by-value parameters destroyed inside a callee. A view does not own its referent.
- Structured bindings initialize a hidden object or reference first. Plain `auto` can copy it; member accessibility and tuple-like customization rules still apply.
- A defaulted `<=>` compares bases and members lexicographically and also declares equality. Floating-point members can propagate `partial_ordering`.
- `constexpr` permits compile-time evaluation, `consteval` requires immediate invocation, and `if consteval` selects by evaluation mode.
- Named modules change semantic ownership and the build graph; binary module artifacts and standard-library module packaging are toolchain-specific.
- Coroutine state contains the promise, parameters, and cross-suspend locals. One owner must eventually destroy a final-suspended state; allocation elision is permitted, not required.
- `constinit` requires constant initialization while allowing mutation. It guarantees neither constant-expression use, cheap TLS access, nor safe destruction order.

### Questions

1. Why are `__cplusplus`, a language feature macro, and a library feature macro three different pieces of evidence?
2. Which temporary lifetimes does C++23 range-`for` extend, and why can a returned view or reference still dangle?
3. Given `auto [a, b] = object;`, where can a copy occur, and how do `auto&` and `const auto&` change the model?
4. When does defaulted `<=>` yield `partial_ordering`, and why is result type alone insufficient for a portable unrelated-pointer order?
5. Choose among `constexpr`, `consteval`, and `constinit` for a runtime parser, a validated literal, and a mutable global initialized without startup code.
6. What must a build system learn before compiling a module importer, and why should a BMI not be distributed as a stable library artifact?
7. Draw the ownership transitions from a coroutine call through `initial_suspend`, completion, `final_suspend`, and `destroy()`.
8. What does an explicit object parameter remove from a four-overload getter, and what lifetime hazard remains when it forwards from a temporary?
9. When would a plain state machine be preferable to a coroutine even if both produce the same observable result?

### Code-reading puzzle

```cpp
struct Batch {
    std::vector<int> values;
    std::span<const int> view() const { return values; }
};

Batch make_batch();
std::span<const int> pass_through(Batch b) { return b.view(); }

for (int x : make_batch().view()) use(x);          // A
for (int x : pass_through(make_batch())) use(x);   // B
```

Under C++20 and C++23, which loop is well-defined? Identify the owner of each span, the exact destruction point that matters, and why C++23's range lifetime rule can help one expression but not a by-value parameter destroyed inside `pass_through`.

### Implementation exercise

Implement a C++23 `consteval make_dispatch` that accepts an array of `(opcode, function pointer)` entries, rejects duplicate opcodes during constant evaluation, and returns a 256-entry lookup table. The runtime `dispatch(byte, message)` must make absence explicit and must not allocate. Compare its object size, indirect-call behavior, and measured opcode distribution against a `switch`; do not assume the table wins. Add compile-fail coverage for a duplicate opcode and ordinary tests for missing and present handlers.

### Prerequisites for Chapter 20

Chapter 20 assumes you can distinguish a coroutine frame from a thread stack, identify who owns a `coroutine_handle`, explain `initial_suspend` and `final_suspend`, and reason about references that cross suspension. It applies those mechanics to result channels, cancellation, scheduling, and I/O without rebuilding the transformation. Revisit §19.7 if frame ownership or final destruction is unclear.
