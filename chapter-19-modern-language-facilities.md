# Chapter 19 — Modern Language Facilities

*Interview-focused revision notes. The theme: the post-C++11 language features that changed what the compiler is obliged to do — elide, deduce, suspend, synthesize — and what each one actually costs at the instruction level.*

---

## 19.1 Move Semantics

(Ch. 10 §10.1–§10.4 covered move mechanics from the resource-management side; here it is as a *language* feature — what the rules are and where the model leaks.)

A **move** is not an operation the language performs. It is overload resolution selecting a constructor or assignment operator taking `T&&` rather than `const T&`. `std::move` is a cast — `static_cast<remove_reference_t<T>&&>` — and generates zero instructions. Everything else is a library convention: the move constructor is expected to leave the source in a **valid but unspecified state**, meaning you may destroy it or assign to it, but you may not assume anything about its value.

```cpp
template <class T>
constexpr std::remove_reference_t<T>&& move(T&& t) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(t);   // a cast. Nothing more.
}
```

**Rvalue references bind to rvalues; the reference itself is an lvalue.** This is the single most common confusion:

```cpp
void sink(std::string&& s) {
    consume(s);              // COPY — `s` is a named lvalue of type string&&
    consume(std::move(s));   // move
}
```

Named `T&&` parameters must be re-`move`d. A **forwarding reference** (`T&&` on a deduced template parameter, Ch. 17 §17.3) is different again and requires `std::forward`.

| Expression | Type of expression | Value category |
|---|---|---|
| `std::string s;` → `s` | `std::string` | lvalue |
| `std::move(s)` | `std::string&&` | xvalue |
| `f()` returning `string` | `std::string` | prvalue |
| `f()` returning `string&&` | `std::string&&` | xvalue |
| parameter `string&& p` → `p` | `std::string` | **lvalue** |

### Where the model leaks

- **`const` kills moves silently.** `const std::string` binds to `const T&`; the copy constructor is chosen with no diagnostic. Returning `const T` by value (a pre-C++11 idiom to prevent assigning to temporaries) is now actively harmful — it defeats both moves and NRVO.
- **A throwing move constructor is not used by `vector` reallocation.** `std::move_if_noexcept` falls back to copying to preserve the strong exception guarantee, so a missing `noexcept` on your move constructor silently converts an O(n) pointer shuffle into an O(n) deep copy. Mark move operations `noexcept`; `static_assert(std::is_nothrow_move_constructible_v<T>)` on hot types.
- **Declaring a destructor suppresses the implicit move operations** (Ch. 6 §6.1); the class then falls back to copying. This is the rule-of-five trap and the most expensive one-line performance regression in C++.
- **Moving does not imply cheapness.** `std::array<T, N>` moves element-wise. A moved `std::string` under SSO copies the buffer for short strings — the "move" of a 15-char string is a 32-byte copy, identical to the copy path.

### Low-latency angle

The right question is rarely "move or copy" but "why is there an object to move at all". Moves still touch two objects' storage, still run a destructor on the source, and still consume ABI slots (a move-only type is not trivially copyable, so it is passed in memory rather than a register, Ch. 3 §3.5). On a hot path prefer constructing in place (`emplace_back`, `std::optional::emplace`) or handing out indices into a preallocated slab. **Trivial relocatability** (P2786, C++26) is the missing primitive: it would let `vector` `memcpy` a `vector<std::string>` during growth instead of running N move constructors and N destructors.

---

## 19.2 Guaranteed Copy Elision

Before C++17, `T t = T{};` conceptually created a temporary and copied it; the copy was *permitted* to be elided but a usable copy or move constructor still had to exist. C++17 changed the **value-category model** itself rather than adding an optimization.

**The C++17 model:** a prvalue is no longer an object. It is an *initializer* — a recipe for producing an object. An object comes into existence only at **temporary materialization**, the point at which a prvalue is bound to a reference, has a member accessed, or is used to initialize a named object. If the prvalue is used to initialize an object of the same type, no temporary is ever materialized and no constructor beyond the one you wrote is called.

```cpp
struct NonMovable {
    NonMovable(int);
    NonMovable(const NonMovable&) = delete;
    NonMovable(NonMovable&&) = delete;
};
NonMovable make() { return NonMovable(42); }   // OK in C++17, ill-formed in C++14
NonMovable n = make();                          // OK — one construction, at n's address
```

This is *mandatory*, not an optimization: it applies at `-O0`, it is observable through deleted constructors, and it is why factory functions for immovable types (mutexes, `std::atomic`, lock guards) work in C++17.

### RVO vs NRVO vs guaranteed elision

| | Trigger | Guaranteed? | Copy/move ctor required to exist? |
|---|---|---|---|
| **Guaranteed elision (C++17)** | `return T{...};` — returning a **prvalue** | Yes, mandated | No |
| **NRVO** | `T t; ...; return t;` — returning a **named local** | No — permitted, not required | Yes |
| **Implicit move on return** | `return t;` where `t` is a local | Yes (overload resolution first treats `t` as rvalue) | Move ctor required |

**NRVO is still not guaranteed** and is the detail interviewers probe. It fails when the function has multiple return statements returning different objects, when the returned variable is a parameter (parameters live in the caller's frame per the ABI, so they cannot be constructed in the return slot), or when the return type differs from the variable's type. When NRVO fails, C++11's **implicit move on return** kicks in — the return operand is first treated as an rvalue — so you get a move rather than a copy. C++20 (P1825) widened this to cover more cases, including `return` of a by-value parameter and `throw` of a local.

```cpp
std::string f(bool b) {
    std::string a, c;
    return b ? a : c;        // NRVO impossible; implicit move applies
}
std::string g(std::string s) {
    return s;                // NRVO impossible (parameter); implicit move applies
}
std::string h() {
    std::string s;
    return std::move(s);     // PESSIMIZATION — the explicit move DISABLES NRVO
}
```

`return std::move(local);` is a real bug: it turns a returned-in-place object into a move construction. `-Wpessimizing-move` (Clang/GCC) and `-Wredundant-move` catch it.

### Mechanics — the return slot

Under the SysV AMD64 ABI (Ch. 3 §3.5), a class type that is not trivially copyable, or that exceeds 16 bytes, is returned via a hidden pointer to caller-allocated storage in `RDI`. Guaranteed elision means the constructor's `this` *is* that hidden pointer: the object is built directly in the caller's frame. NRVO is the compiler proving that a named local can also be given that address. This is why elision is an ABI-level phenomenon, not a peephole optimization, and why it cannot cross a function-pointer or virtual boundary the compiler cannot see through.

---

## 19.3 Range-Based For Loops

```cpp
for (auto&& x : expr) body;
```

expands (C++17 form) to roughly:

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

`begin-expr`/`end-expr` are member `begin()`/`end()` if the class has *either*, otherwise ADL-found free `begin`/`end` (with `std::begin`/`std::end` in scope). Arrays are special-cased. The C++17 relaxation allowing `__end` to have a different type is what made **sentinels** — and therefore ranges (Ch. 14 §14.9) — usable in the language's own loop.

### The dangling-reference trap

`__range` is a reference. Lifetime extension applies to the *full expression's* temporary, but **not to temporaries inside it that are not the top-level prvalue**:

```cpp
for (char c : get_object().name())   // UB before C++23 — get_object()'s temporary dies
    ...                              // at the end of the init-statement; name() dangled
```

This was the single most reported C++ defect of the last decade. **C++23 (P2718) fixed it**: all temporaries in the range initializer now have their lifetime extended to the end of the loop. Until you are on C++23 with a conforming library, hoist:

```cpp
auto obj = get_object();
for (char c : obj.name()) ...
```

Note the trap survives in C++23 if the range expression is a `string_view` or `span` over a temporary — lifetime extension binds objects, not views. `-Wdangling` and Clang's `[[clang::lifetimebound]]` help; ASan catches it at runtime.

### Choosing the loop variable

| Form | Meaning |
|---|---|
| `for (auto x : r)` | Copy each element. Correct for `int`, a bug for `std::string`. |
| `for (const auto& x : r)` | Read-only, no copy. The default. |
| `for (auto& x : r)` | Mutate. Fails to compile for proxy references (`vector<bool>`). |
| `for (auto&& x : r)` | **Generic form.** Binds proxies, prvalues from views, and real references alike. |

`auto&&` is the correct default in generic code precisely because `std::vector<bool>::reference` and `views::transform`'s prvalue results are not lvalues.

### C++20 init-statement

```cpp
for (auto vec = make(); const auto& x : vec) { ... }   // C++20
```
This solves the dangling problem structurally and is the idiomatic pre-C++23 workaround.

### Low-latency note

The desugaring is exact and the compiler sees a plain iterator loop; there is no inherent cost. What *does* cost: iterating a `std::map` or `std::list` (pointer chasing, one cache miss per node, no prefetcher traction) versus a `vector` (sequential, prefetched, vectorizable). Range-`for` hides that distinction at the syntax level — the container choice (Ch. 11, Ch. 12) is what determines throughput, not the loop form.

---

## 19.4 Structured Bindings

C++17. Decomposes an object into named references to its parts.

```cpp
auto [a, b] = std::pair{1, 2.0};
auto& [x, y] = some_pair;
const auto& [k, v] = *map_iterator;
```

**Mechanically**, the compiler introduces a hidden variable `e` initialized from the initializer, then makes each name refer to a piece of `e`. Crucially, `a` and `b` are *not variables* — they are **names for subobjects** (or, in the tuple case, for the result of `get<i>`). The `auto&`/`auto&&`/`const auto&` qualifiers apply to `e`, not to the individual names.

Three decomposition protocols, tried in order:

1. **Array** — `T a[N]`; names bind to elements. `N` must match.
2. **Tuple-like** — if `std::tuple_size<E>::value` is a complete type: each name `i` is initialized from `e.get<i>()` if a member `get` exists, else `get<i>(e)` via ADL. Types come from `std::tuple_element<i, E>::type`. This is the customization point — implement those three to make your type decomposable.
3. **Public data members** — all non-static data members must be in the *same* class (no split across base and derived) and all accessible. Bit-fields are permitted here.

```cpp
struct S { int a; double b; };
auto [i, d] = S{1, 2.0};        // case 3, direct member binding
for (const auto& [key, val] : my_map) { ... }   // case 2 via pair
```

### The details that separate candidates

- **You cannot apply `static`, `constexpr`, or attributes to individual names**, and you cannot ignore one — there is no `_` placeholder (P2169 proposes `_` for C++26; until then, name it and add `[[maybe_unused]]` to the whole declaration).
- **Structured bindings could not be captured by lambdas** in C++17 (they are not variables). C++20 (P1091) permits capturing them **by reference**, and by copy for the member/array cases; implementations vary and MSVC lagged. This is a genuine portability trap.
- **`auto [a,b] = expr;` copies.** The hidden `e` is a copy of the whole object. Decomposing a large struct in a loop with plain `auto` copies every element. Use `const auto&`.
- **They are always references to `e`'s subobjects**, so `sizeof(a)` and `decltype(a)` behave surprisingly: `decltype(a)` yields the *referenced type* (e.g. `int`), not a reference type — unlike everything else about them. This is deliberate, so `decltype` reports the logical type.
- **No lifetime-extension surprises**: `auto&& [a,b] = f();` extends the temporary's lifetime through `e`, which is the ordinary rule.

### C++20/C++26 extensions

- C++20 allows structured bindings to have `static`/`thread_local` storage class in some contexts and fixes lambda capture.
- **C++26 structured bindings in conditions** (P0963): `if (auto [ok, val] = try_get(); ok)` already worked, but `if (auto [it, inserted] = m.insert(...))` contextually converting the *pack* did not; P0963 allows a structured binding declaration as a condition when the underlying object converts to `bool`.
- **C++26 pack structured bindings** (P1061): `auto [...parts] = tup;` decomposes into a pack, closing the gap that forced `std::apply` (Ch. 15 §15.2) for arity-generic code.

The canonical use is the map insert idiom, which reads far better than `.first`/`.second`:

```cpp
if (auto [it, inserted] = cache.try_emplace(key, value); !inserted) { it->second = value; }
```

---

## 19.5 Three-Way Comparison

C++20's `operator<=>` ("spaceship") returns a *comparison category* object rather than a bool, and the compiler synthesizes the six relational operators from it.

```cpp
struct Point {
    int x, y;
    auto operator<=>(const Point&) const = default;   // lexicographic, member-wise
    // == is NOT synthesized from <=>; but `= default` on <=> implicitly declares
    // a defaulted operator== as well when <=> is defaulted.
};
```

### The three categories

| Category | Means | Example |
|---|---|---|
| `std::strong_ordering` | Total order; `a == b` implies substitutability (indistinguishable) | `int`, `std::string` |
| `std::weak_ordering` | Total order; equivalent values may be distinguishable | case-insensitive string, sorting by one field |
| `std::partial_ordering` | Some pairs are **unordered** | `double` (NaN), pointers into different objects |

`double`'s `<=>` yields `partial_ordering` because `NaN <=> x` is `unordered`. This is the correct model and it is why `std::partial_ordering::unordered` exists: `(a <=> b) == 0`, `< 0`, and `> 0` can *all* be false.

### Rewriting rules — the mechanism

For `a < b`, the compiler considers `a < b` (normal lookup) **and** the rewritten candidates `(a <=> b) < 0` and `0 < (b <=> a)` (the reversed form). Whichever wins overload resolution is used. Consequences:

- **One `<=>` gives you `<`, `>`, `<=`, `>=`** — four operators from one function, plus reversed argument order for free, killing the boilerplate of writing 6 (or 12, with heterogeneous comparison) operators.
- **`==` and `!=` are rewritten separately**, from `operator==` only. `<=>` never generates `==`, because equality is frequently much cheaper than ordering (comparing `std::string` sizes first short-circuits) and the committee refused to make you pay ordering cost for equality. The exception: a *defaulted* `<=>` also implicitly declares a defaulted `==`.
- **Reversed candidates can break existing code.** A pre-C++20 `operator==(const A&, const B&)` plus a member `operator==` can become ambiguous in C++20 because the reversed candidate is now viable. This is the most common C++17→C++20 migration failure, along with `operator==` becoming implicitly `const`-sensitive.

### `<=>` on non-defaulted types

```cpp
struct Version {
    int major, minor;
    std::strong_ordering operator<=>(const Version& o) const {
        if (auto c = major <=> o.major; c != 0) return c;
        return minor <=> o.minor;
    }
    bool operator==(const Version&) const = default;   // declare separately
};
```

`std::compare_three_way` is the function object; `std::compare_three_way_result_t<T>` the trait; `std::strong_order`/`std::weak_order` are the **customization-point objects** that impose a *total* order even on floating point (ordering `-0.0 < +0.0` and placing NaNs at the ends) — the correct tool for sorting doubles deterministically.

### Low-latency angle

A defaulted `<=>` on a multi-member struct compiles to a chain of compares and branches, each a potential mispredict. For a hot comparator (an order book's price-time key, Ch. 50) prefer packing the key into a single integer and comparing that — one `cmp`, one branch, and the sort's inner loop becomes branch-predictable and vectorizable. Also note that `<=>` returning a class type is trivially copyable and lowered to an `int` in registers; the abstraction itself is free at `-O1` and above, but at `-O0` it materializes an object per comparison, which distorts debug-build benchmarks.

---

## 19.6 Modules

C++20 modules replace textual `#include` (Ch. 1 §1.2) with a compiled, semantic interface.

```cpp
// math.ixx / math.cppm — a module interface unit
export module math;
import std;                       // C++23 standard-library module

export int add(int a, int b);     // exported: visible to importers
int helper();                     // internal linkage to the module, NOT visible
export namespace geo { struct Point { int x, y; }; }

// consumer.cpp
import math;
int main() { return add(1, 2); }
```

### What actually changes

| | `#include` | `import` |
|---|---|---|
| Mechanism | Textual paste, re-parsed per TU | Compiled BMI (binary module interface) read once |
| Macros | Leak in **and** out | Do **not** propagate across `import` (only via header units) |
| ODR | Fragile — divergent macro state per TU silently changes definitions (Ch. 1 §1.6) | Enforced; one definition, one compilation |
| Order sensitivity | Include order can change meaning | Order-independent |
| Internal names | `static`/anonymous-namespace only | Non-exported names are **module-local**, invisible even to the linker's name lookup |
| Build graph | Any order, trivially parallel | **Must build interfaces before consumers** — a real dependency scan is required |

The compile-time win comes from parsing a template-heavy header once instead of once per TU. Real-world reports on large codebases show 2–5× improvement on parse-bound builds; the win shrinks when instantiation, not parsing, dominates.

### Structure

- **Module interface unit** — `export module M;`. Exactly one primary per module.
- **Module implementation unit** — `module M;` (no `export`). Can see everything in the interface without importing it; changing it does **not** force recompilation of importers. This is the modules answer to PIMPL (Ch. 44).
- **Module partitions** — `export module M:part;` internal decomposition, invisible outside.
- **Header units** — `import <vector>;` treats an existing header as a module. A migration bridge; macros *do* export from header units.
- **The global module fragment** — `module;` … `#include <legacy.h>` … `export module M;`. Where you put includes that must remain textual.

### Status and traps

- Toolchain support is the practical blocker: MSVC is furthest along, Clang 17+ and GCC 14+ are usable, and **build-system support** (CMake 3.28+ with `FILE_SET CXX_MODULES`, Ninja 1.11+ dyndeps) arrived only recently. `import std;` (C++23, P2465) requires very recent toolchains.
- **BMIs are not portable** — not across compilers, versions, or even flags. They are a build artifact, never a distribution artifact. Distribute source.
- **`export`ing a template does not pre-instantiate it**; instantiation still happens in the importer, so template-heavy code retains its instantiation cost (Ch. 17 §17.22).
- **Modules do not change ABI or linkage of exported entities** in a way that removes the need for the ODR — but internal-linkage-like module-local names get mangled with the module name, so two modules may define the same class name without collision.
- **No incremental adoption without effort**: a module cannot `#include` a header *after* the module declaration; everything textual goes in the global module fragment.

Interview framing: *"Do modules make templates faster to compile?"* — They eliminate re-*parsing*, not re-*instantiation*; `extern template` (Ch. 17 §17.10) remains the tool for instantiation cost.

---

## 19.7 Coroutines

A C++20 **coroutine** is a function whose execution can be suspended and resumed. Any function containing `co_await`, `co_yield`, or `co_return` is a coroutine. There is no `coroutine` keyword and no coroutine *type* in the language — the compiler transforms the function against a **customization protocol** and hands the result to a library type you (or the standard library) provide. This is why C++20 coroutines are described as "unfinished": the language ships the transformation, C++23 shipped the first user-facing type (`std::generator`).

### The transformation

For a coroutine returning `R` with parameters `Args...`:

```
promise_type P = std::coroutine_traits<R, Args...>::promise_type;

allocate the coroutine frame  (via P::operator new if present, else ::operator new)
copy/move parameters into the frame
construct P promise (using args if P has a matching ctor)
R ret = promise.get_return_object();       // returned to the CALLER
co_await promise.initial_suspend();
try   { <function body> }
catch (...) { promise.unhandled_exception(); }
final_suspend:
co_await promise.final_suspend();          // must be noexcept
destroy the frame (unless final_suspend suspends, then the owner destroys it)
```

Three keywords:

- **`co_await e`** — suspend until `e` completes. Rewritten via the awaitable protocol (§19.9).
- **`co_yield v`** — `co_await promise.yield_value(v)`. Produces a value to the consumer.
- **`co_return v`** — `promise.return_value(v)` (or `return_void()`), then jump to `final_suspend`.

**Stackless.** The frame holds only the coroutine's own locals and state, not a call stack. A coroutine can therefore suspend only in its own body — never from inside a function it calls. This is the crucial contrast with fibers/green threads (Ch. 31), which are stackful and can suspend anywhere at the cost of a full stack per task (typically 8 KB–1 MB versus tens to hundreds of bytes).

| | Stackless (C++20 coroutines) | Stackful (fibers, ucontext) |
|---|---|---|
| Memory per task | Frame only, often < 200 B | Whole stack, 8 KB+ |
| Suspend depth | Only in the coroutine body | Anywhere in the call tree |
| Switch cost | A few loads + indirect jump | Save/restore registers + stack switch, ~100–200 ns |
| Compiler knowledge | Full — can inline and elide the frame | Opaque |
| Debuggability | Poor stack traces across suspends | Normal stacks |

### Why it matters

Coroutines let you write asynchronous code in straight-line form without the callback state machine, and — unlike threads — without a kernel stack, a scheduler, or a context switch. In a trading system the canonical uses are protocol parsers that need to yield on partial messages, and I/O pipelines over `io_uring` (§20.6). The canonical *misuse* is putting a coroutine on the tick-to-trade critical path where a plain function would do: even a fully elided coroutine costs an indirect jump through the resume pointer, which the branch predictor handles worse than a direct call.

---

## 19.8 Coroutine Promise Types and Frames

### The promise

The **promise type** is the coroutine's controller, found via `std::coroutine_traits<ReturnType, Args...>::promise_type` (which by default is `ReturnType::promise_type`). It is constructed inside the frame and lives as long as it. Required members:

```cpp
struct promise_type {
    Task get_return_object();            // builds the object handed to the caller
    std::suspend_always initial_suspend();  // or suspend_never
    std::suspend_always final_suspend() noexcept;   // MUST be noexcept
    void return_void();                  // XOR return_value(T) — never both
    void unhandled_exception();          // called if the body throws
    // optional:
    auto yield_value(T);                 // enables co_yield
    auto await_transform(X);             // intercepts every co_await in the body
    static void* operator new(size_t);   // custom frame allocation
    static void operator delete(void*, size_t);
    static Task get_return_object_on_allocation_failure();  // enables nothrow new
};
```

**`initial_suspend`** decides *lazy* vs *eager*: `suspend_always` means the body does not run until the caller resumes (correct for generators and for structured concurrency — nothing happens until awaited); `suspend_never` means the body runs immediately up to the first real suspend (correct for fire-and-forget tasks).

**`final_suspend` returning `suspend_always` is the standard idiom** for anything whose result must be read after completion: if you do not suspend at the end, the frame self-destroys immediately and the caller cannot retrieve the return value or check `done()`. If you *do* suspend, **you own the frame and must call `handle.destroy()`** — usually from the return object's destructor. Getting this wrong is the #1 coroutine leak.

**Symmetric transfer** is the essential detail: `final_suspend`'s awaiter can return a `coroutine_handle` from `await_suspend`, and the compiler performs a *tail call* to resume it. Without symmetric transfer, a chain of A awaits B awaits C returning up the chain grows the *machine* stack on each resume and eventually overflows. `std::noop_coroutine()` is the terminator when there is no continuation. Any interview about coroutine task types should reach this point.

```cpp
struct final_awaiter {
    bool await_ready() noexcept { return false; }
    std::coroutine_handle<> await_suspend(std::coroutine_handle<promise_type> h) noexcept {
        return h.promise().continuation ? h.promise().continuation
                                        : std::noop_coroutine();   // tail-resume
    }
    void await_resume() noexcept {}
};
```

### The frame

The coroutine frame (activation record) contains:

1. The promise object.
2. Copies of the parameters — **by value parameters are copied into the frame; reference parameters are not**, which is the dangling-reference trap below.
3. Locals whose lifetime spans a suspend point (the compiler proves which; short-lived locals stay in registers or on the real stack).
4. The resume and destroy function pointers (or a single pointer plus an index).
5. The suspend-point index.

`std::coroutine_handle<P>` is a type-erased pointer to the frame: `resume()`, `destroy()`, `done()`, `promise()`, `address()`, `from_promise()`. It is a **non-owning, trivially copyable pointer** — copying it does not duplicate anything, and using it after `destroy()` is UB. `coroutine_handle<>` erases the promise type, which is how schedulers store heterogeneous coroutines uniformly.

**The reference-parameter trap:**

```cpp
Task process(const std::string& s) { co_await something(); use(s); }  // DANGLING
process(std::string("temp"));   // temporary dies at the end of the full-expression;
                                // the coroutine resumes later holding a dangling ref
```
Coroutine parameters should be taken **by value** (the copy goes into the frame). The same applies to lambdas: a coroutine lambda's closure is *not* in the frame, so `[&]` captures — and even `[=]`/`[this]` — dangle across suspension. Take state by value as parameters, or keep the lambda alive explicitly.

---

## 19.9 Coroutine Suspension and Allocation

### The awaitable protocol

`co_await expr` is rewritten as:

```
1. if the promise has await_transform:  e = promise.await_transform(expr)   else e = expr
2. if e has operator co_await:          awaiter = e.operator co_await()     else awaiter = e
3. if (!awaiter.await_ready()) {
       <suspend: spill live registers/locals into the frame, record resume index>
       awaiter.await_suspend(handle);       // three legal return types, below
       <return to the resumer>
   }
4. result = awaiter.await_resume();
```

`await_suspend`'s return type is the control-flow lever:

| Return type | Effect |
|---|---|
| `void` | Suspend; return control to whoever resumed this coroutine. |
| `bool` | `true` = suspend; **`false` = resume immediately** (do not suspend). Useful when the operation completed synchronously. |
| `coroutine_handle<>` | **Symmetric transfer**: tail-resume that handle without growing the stack. The high-performance form. |

`std::suspend_always` and `std::suspend_never` are the two trivial awaiters in `<coroutine>`.

**`await_transform`** is a powerful hook: defining it makes *every* `co_await` in the body go through the promise, letting you reject illegal awaits (`= delete` on the general overload) or inject a scheduler/allocator/cancellation token. This is how sender/receiver frameworks (§20.5) and cancellation (§20.4) plumb context through without extra parameters.

### Allocation — the real cost

The frame is heap-allocated by default via `::operator new` (size known only to the compiler, passed as the first argument; a promise-static `operator new` overrides it, and the coroutine's arguments are also passed to it if a matching overload exists). For a hot path this is a per-invocation allocation — unacceptable at HFT latencies.

**Halo — coroutine frame elision** (Heap Allocation eLision Optimization) is the compiler optimization that removes it. It applies when the compiler can prove the frame's lifetime is strictly nested within the caller's — i.e. the coroutine is inlined into its caller, does not escape, and is destroyed before the caller returns. Then the frame becomes ordinary stack storage (or is scalarized into registers entirely). Requirements in practice:

- The coroutine must be **inlinable** — its definition visible, `-O2` or better, and the ramp function not too large.
- The handle must not escape into an opaque call (storing it in a scheduler queue defeats elision immediately).
- Clang implements HALO most aggressively (`-Rpass=coro-elide` reports it); GCC's implementation is weaker. **This is the mandatory question to ask about your toolchain before putting coroutines on a hot path.**

Deterministic alternatives when elision is not guaranteed:

```cpp
struct promise_type {
    static void* operator new(std::size_t n) { return frame_pool::allocate(n); }
    static void  operator delete(void* p, std::size_t n) { frame_pool::deallocate(p, n); }
};
```
A pool or monotonic resource (Ch. 8 §8.6) sized to the maximum frame gives O(1), allocation-free-in-steady-state behavior. Frame sizes are compiler-determined and can be inspected via `-fdump-...`/`__builtin_coro_size`-style intrinsics or simply by instrumenting `operator new`; they change when you add a local that spans a suspend, so `static_assert`-style budgeting requires runtime checks.

**Other cost sources:** each suspend/resume is a store of the index, spills of live values, and an indirect jump through the resume pointer — typically 5–20 ns, dominated by the indirect branch and any cache misses on the frame. Frames are heap objects and thus poorly co-located; a pool that keeps frames on the same pages materially helps. Compared to a thread context switch (1–3 µs including the scheduler and TLB effects, Ch. 31) coroutines are two orders of magnitude cheaper, which is the entire argument for them in I/O-bound servers.

---

## 19.10 `std::generator`

C++23's `<generator>` provides the first standard coroutine type: a **synchronous, lazy, single-pass range**.

```cpp
std::generator<int> fib() {
    int a = 0, b = 1;
    while (true) { co_yield a; std::tie(a, b) = std::pair{b, a + b}; }
}
for (int x : fib() | std::views::take(10)) std::print("{} ", x);
```

`std::generator<Ref, V = void, Alloc = void>` models `input_range`. `initial_suspend` is `suspend_always` (fully lazy — no body runs until the first `++`/`begin()`), `final_suspend` suspends, and the generator object owns and destroys the frame. Exceptions thrown in the body propagate out of the consumer's iterator operations.

### `co_yield elements_of(r)` — the recursion fix

Naive delegation is quadratic: a generator yielding from a nested generator forwards each value up through every level, so yielding N values from a depth-D chain costs O(N·D) resumes. `std::generator` solves it with `elements_of`:

```cpp
std::generator<const Node&> traverse(const Node& n) {
    if (n.left)  co_yield std::ranges::elements_of(traverse(*n.left));
    co_yield n;
    if (n.right) co_yield std::ranges::elements_of(traverse(*n.right));
}
```
The implementation maintains an explicit **stack of active handles** inside the generator and resumes the innermost one directly, restoring O(1) amortized per element. That design detail — that recursive generators need a handle stack, not a chain of forwarding awaits — is a strong interview point.

### Reference vs value type

`std::generator<T>` yields `T&&` (a reference into the coroutine frame), which avoids a copy per element but means the reference is invalidated by the next `++`. `std::generator<const T&>` is explicit about that. `std::generator<T, T>` (specifying the value type) makes it a proper `range` whose `range_value_t` is `T` — needed for algorithms that name the value type.

### Cost and when to use it

Per element you pay: an indirect jump into the coroutine, restoring live state from the frame, running to the next `co_yield`, and an indirect jump back — commonly 3–10 ns, versus ~0 for an inlined loop or a `views::iota` pipeline that the compiler fuses. So:

| Use a generator when | Prefer something else when |
|---|---|
| The producing logic is genuinely stateful/recursive (tree walk, parser, decompressor) | The sequence is a simple transform/filter — use `ranges` views (Ch. 14 §14.10), which fuse and vectorize |
| The consumer may stop early and you want no work done past that point | You need a `forward_range` — generators are single-pass, so `sort`, `size`, multi-pass algorithms don't apply |
| The alternative is materializing a large intermediate `vector` | You are on a nanosecond-budget hot path — the indirect resume defeats inlining |

Pre-C++23, `cppcoro::generator` and Lewis Baker's `cppcoro` in general are the reference implementations, and are what most production code used; `std::generator` is essentially that design standardized. `std::generator` also accepts an allocator (via a leading `std::allocator_arg` parameter), which is the standard-sanctioned way to control frame allocation (§19.9).

---

## 19.11 Deducing `this`

C++23 (P0847). An **explicit object parameter** replaces the implicit `this`:

```cpp
struct S {
    void f(this S& self);          // like void f() &
    void g(this const S& self);    // like void g() const&
    void h(this S self);           // BY VALUE — new capability
    template <class Self>
    auto&& value(this Self&& self) { return std::forward<Self>(self).v; }  // deduced
    int v;
};
```
The parameter must be first, the function cannot be `static` or `virtual`, and inside it there is **no implicit `this`** — members must be accessed through `self`.

### What it solves

**1. The quadruple-overload problem.** A getter that correctly propagates const-ness and value category previously required four near-identical bodies:

```cpp
// Before: 4 overloads
T&        get() &       { return v; }
const T&  get() const&  { return v; }
T&&       get() &&      { return std::move(v); }
const T&& get() const&& { return std::move(v); }
// After: 1
template <class Self> auto&& get(this Self&& self) { return std::forward<Self>(self).v; }
```
`Self` deduces as `S&`, `const S&`, `S`, or `const S` following forwarding-reference rules (Ch. 17 §17.3), and `std::forward<Self>(self).v` yields the right category. This alone justifies the feature for library authors — `std::optional`, `std::expected`'s monadic operations, and `std::variant` all shrink dramatically.

**2. Recursive lambdas without a Y-combinator.**

```cpp
auto fact = [](this auto&& self, int n) -> int { return n <= 1 ? 1 : n * self(n - 1); };
```
Previously this required `std::function` (type erasure + allocation) or a hand-rolled fixed-point combinator.

**3. CRTP without CRTP.** Instead of `template<class D> struct Base { void f() { static_cast<D*>(this)->impl(); } };` and the derived class passing itself as a template argument (Ch. 6 §6.19):

```cpp
struct Base { template <class Self> void f(this Self&& self) { self.impl(); } };
struct Derived : Base { void impl(); };
```
No template parameter on the base, no `static_cast`, no possibility of the classic CRTP bug where `struct A : Base<B>`.

**4. Pass-by-value `this`.** For a small trivially copyable type (an iterator, a `string_view`, a handle), `void f(this S self)` lets the object arrive in a register instead of via a pointer — removing a load-and-indirect from every call. This is a genuine, if narrow, low-latency win: iterator increment on a pointer-sized iterator becomes register-to-register.

### Traps

- **`self` is not `*this`, and there is no `this` at all.** Writing `v` unqualified inside such a function is ill-formed; you must write `self.v`. Existing macros and code that reference `this` break.
- **Cannot be virtual**, and an explicit-object member function does not participate in the vtable — so this is a *static* polymorphism tool only.
- **Shadowing/recursion hazard**: a deduced `Self` in a base class deduces to the *derived* type, so calling `self.f()` inside `f` where `Self` is derived can recurse infinitely if the derived class inherits rather than overrides. Constrain with concepts.
- Support: GCC 14+, Clang 18+, MSVC 19.32+. Older Clang had significant bugs with lambdas plus explicit object parameters.

---

## 19.12 Constant Initialization and `constinit`

Ch. 5 §5.10 covered the static initialization order fiasco; this is the language-level guarantee that prevents it.

**Static initialization** happens before any code runs (the values are baked into `.data` or `.rodata` by the compiler/linker). **Dynamic initialization** runs at program startup, in an order that is unspecified across translation units. The fiasco is dynamic initialization reading an object from another TU that has not been initialized yet.

**Constant initialization** is the subset of static initialization where the initializer is a constant expression. `constinit` (C++20) *asserts* it:

```cpp
constinit int counter = 42;                        // guaranteed static init
constinit std::atomic<int> flag{0};                // OK — constexpr ctor
constinit Config cfg = make_config();              // ERROR if make_config isn't constexpr
constinit thread_local Buffer* tls_buf = nullptr;  // also removes the TLS guard (below)
```

| Keyword | Guarantees | Mutable after init? | Usable in constant expressions? |
|---|---|---|---|
| `const` | Nothing about initialization timing | No | Only if also constant-initialized and of integral/enum type (or `constexpr`) |
| `constexpr` (on a variable) | Constant initialization | **No** — implies `const` | Yes |
| `constinit` | Constant initialization | **Yes** | No (it's still a runtime-mutable object) |

`constinit` is the missing middle: "initialize me at compile time, but let me change at runtime." That is exactly what a global counter, a mutable configuration singleton, or a lock-free queue's static instance needs.

### Why it matters at low latency

1. **Eliminates dynamic initialization** — no startup ordering hazard, no code in `.init_array`, and the object lives in `.data` with its final value already there.
2. **Eliminates the guard variable on function-local statics.** A Meyers singleton (`static Foo& get() { static Foo f; return f; }`) is thread-safe by C++11 mandate, implemented via `__cxa_guard_acquire`/`__cxa_guard_release`. After initialization the fast path is a single load-acquire and a predictable branch — cheap, but not free, and it is an **acquire load on every call plus a branch the compiler cannot remove**. A `constinit` namespace-scope object has no guard at all.
3. **Same for `thread_local`.** A `thread_local` with a non-trivial constructor requires a TLS initialization check (and, in dynamic libraries, a call to `__tls_get_addr`) on *every* access. `constinit thread_local` with a trivial destructor reduces access to an `fs:`-relative load on x86-64 — often a 20–30 ns difference per access in a logging hot path. Adding `-ftls-model=initial-exec` (or `local-exec` for the main executable) removes the `__tls_get_addr` call; see Ch. 31 and Ch. 41.

**Constant-initialization is not the same as `constexpr` evaluation of the whole object's lifetime.** A `constinit` object with a non-trivial destructor still registers with `__cxa_atexit`, and destruction order at exit remains reverse-of-construction — a shutdown-crash source. `constinit` + trivially destructible (or a deliberately leaked object) is the robust pattern for globals in long-running processes.

C++20 also added **`constexpr` destructors**, `constexpr` allocation (transient only — memory allocated during constant evaluation must be freed before it ends), and `std::is_constant_evaluated()` / C++23 `if consteval`, which let one function take different paths at compile and run time.

---

## 19.13 Contracts

Contracts are C++26's (P2900) facility for preconditions, postconditions, and assertions as *language* constructs.

```cpp
// C++26 syntax
int divide(int a, int b)
    pre  (b != 0)                    // precondition, checked on entry
    post (r : r * b <= a)            // postcondition, naming the result
{
    contract_assert(a >= 0);         // assertion, checked where written
    return a / b;
}
```

### The model

- **Evaluation semantics** are chosen per translation unit, not by the source: `ignore` (not evaluated), `observe` (evaluated; on violation call the handler and *continue*), `enforce` (evaluate; on violation call the handler and then terminate), `quick_enforce` (terminate with minimal machinery — no handler, suitable for release builds where you want a trap instruction).
- A **contract-violation handler** receives a `std::contracts::contract_violation` describing the location, kind, and detected semantic. A program may replace it; the default terminates.
- Predicates must be **side-effect free in principle** — the standard permits the implementation to evaluate a predicate zero, one, or more times, and any observable side effect makes the program's behavior unspecified.

### Why this is more than `assert`

| | `assert` (C) | Contracts (C++26) |
|---|---|---|
| Granularity | On/off per TU via `NDEBUG` | Four semantics, per TU, chosen by build config |
| Position | Only in the body | On the **declaration** — visible to callers and to tooling |
| Optimizer | Removed entirely under `NDEBUG` (no information given) | Semantics are specified; the standard deliberately does **not** license assuming a checked predicate |
| Composition | None | Inherited by overriding virtual functions (a well-known design fight) |
| Tooling | None | Static analyzers and documentation generators can read the declaration |

**The "assume" question is the crux.** Early contract designs (the C++20 proposal, pulled at the last minute) allowed the compiler to *assume* preconditions in `ignore` mode, meaning a wrong contract turned into UB and a build-mode change could alter program semantics. That is why contracts were removed from C++20 — the single most instructive committee episode to be able to narrate. P2900 avoids it: contracts do not, by themselves, grant assumption. C++23's `[[assume(expr)]]` is the separate, explicitly-UB-if-false tool for that.

### Practical status and low-latency angle

C++26 contracts landed in the working draft; expect early implementations (GCC 15+ experimental, a Clang fork) but not production-ready toolchains at time of writing. Until then the working equivalents are `assert`, custom `EXPECT`/`CHECK` macros, `[[assume]]` (C++23) for the optimizer, and `__builtin_unreachable()` for the same effect pre-C++23.

For hot paths, the intended usage pattern is: build the risk/validation tier with `enforce`, the trading engine's inner loop with `ignore` or `quick_enforce`, and rely on the fact that the *declaration* still documents the contract for callers. Beware: `observe` mode's handler call is a full function call the optimizer cannot see through, and a predicate that touches memory (`pre(v.size() > i)`) costs a load and a branch per call — the same discipline as any assertion applies.

---

## 19.14 Static Reflection

C++26's reflection (P2996 and companions) makes the program's own structure available as constant-expression data.

```cpp
// C++26
constexpr std::meta::info r = ^^int;                 // reflect a type ("^^" = reflect operator)
typename [:r:] x = 0;                                // splice it back into a type

template <class E>
constexpr std::string_view enum_name(E value) {
    template for (constexpr auto e : std::define_static_array(std::meta::enumerators_of(^^E)))
        if (value == [:e:]) return std::meta::identifier_of(e);
    return "<unknown>";
}
```

### The model

- **`^^X`** — the *reflect* operator. Yields a `std::meta::info`, an opaque constant-expression handle to a type, namespace, variable, member, expression, etc.
- **`[: r :]`** — the *splice* operator. Turns an `info` back into a grammatical construct (a type with `typename [:r:]`, an expression, a template argument).
- **Queries** are ordinary `consteval` functions over `info`: `members_of`, `enumerators_of`, `type_of`, `identifier_of`, `offset_of`, `is_public`, `nonstatic_data_members_of`. Because they are constexpr functions, you manipulate reflections with normal `std::vector`/algorithms at compile time — a much better ergonomic story than template metaprogramming (Ch. 17).
- **`template for`** (P1306, expansion statements) iterates a compile-time sequence with the loop body instantiated per element. Essential, because `members_of` returns a runtime-shaped `vector` at constant-evaluation time that must be lifted into distinct instantiations.
- **Code injection** (P3294 and successors) — generating new declarations — is the follow-on work, partially targeted at C++26/29.

### What it replaces

| Problem | Today's hack | With reflection |
|---|---|---|
| Enum ↔ string | X-macros, `magic_enum` (parses `__PRETTY_FUNCTION__`), hand-written tables | `enumerators_of` + `identifier_of`, exact and fast to compile |
| Struct serialization / wire codecs (Ch. 51) | Boost.PFR (structured-binding tricks, arity limits), macros, an IDL + codegen step | `nonstatic_data_members_of` and `offset_of`, no external toolchain |
| Struct-of-arrays generation (Ch. 42) | Macros, code generators | Injection over reflected members |
| Universal `operator==`/hash/print | `= default`, then hand-write anything non-trivial | Generated from members |
| Compile-time schema validation | `static_assert` walls (Ch. 3 §3.12) | Programmatic checks over the reflected layout |

For a trading codebase, the significant consequence is that **binary protocol encode/decode and struct-to-log-record mapping can be generated in the language**, eliminating the code-generation build step, the macro layer, and the drift between schema and struct that causes production incidents. The generated code is still ordinary C++ and optimizes identically to hand-written code — reflection has **zero runtime cost by construction**; everything happens during constant evaluation.

### Caveats

- Compile-time cost is real: reflection queries run in the constant evaluator, which is an interpreter. Large reflective loops can be slower to compile than the template metaprogram they replace, though generally much simpler to read and to *debug*.
- The `^^` token (rather than a single `^`) was chosen to avoid a clash with Objective-C/C++ blocks.
- Implementation status at time of writing: an EDG-based prototype and Bloomberg's Clang fork; not production toolchains. `magic_enum`, Boost.PFR, and `nameof` remain the practical answers today, and knowing their mechanisms (parsing compiler-specific `__PRETTY_FUNCTION__` strings; abusing structured bindings to count members) is itself a good interview answer.

---

## Key Interview Questions

1. **What does `std::move` do?** — Nothing at runtime; it is a cast to an xvalue that changes overload resolution. Moving is entirely a library convention on top of that.
2. **Why must you `std::move` a named `T&&` parameter?** — A named rvalue reference is an lvalue; without the cast, the copy constructor is selected.
3. **What is guaranteed copy elision and how is it different from RVO?** — C++17 redefines prvalues as initializers, so `T t = T{};` never materializes a temporary; it works for types with deleted copy *and* move. NRVO (returning a named local) is still merely permitted.
4. **Why is `return std::move(local);` wrong?** — It turns a prvalue/NRVO candidate into an xvalue, disabling NRVO and forcing a move construction. `-Wpessimizing-move`.
5. **When does NRVO fail, and what happens then?** — Multiple returned objects, returning a parameter, mismatched types. Implicit move on return (C++11, widened in C++20) then applies.
6. **What was the range-`for` dangling bug and when was it fixed?** — Temporaries in the range initializer other than the top-level one were not lifetime-extended; C++23 P2718 extends all of them.
7. **Why is `for (auto&& x : r)` the generic default?** — It binds proxy references (`vector<bool>`) and prvalues produced by views, which `auto&` cannot.
8. **How do structured bindings work, and what are the three protocols?** — A hidden object `e` is initialized, names alias its parts: arrays, `tuple_size`/`get<i>` tuple-like, or all-public-members-in-one-class.
9. **Why doesn't `<=>` generate `operator==`?** — Equality is often much cheaper than ordering (string length check first); the committee refused to force ordering cost. A *defaulted* `<=>` does implicitly declare a defaulted `==`.
10. **When is the comparison category `partial_ordering`?** — When some pairs are unordered — floating point with NaN, or pointers into unrelated objects.
11. **What breaks when migrating C++17 code to C++20 comparisons?** — Reversed candidates make previously-unambiguous heterogeneous `operator==` overloads ambiguous.
12. **What do modules actually improve, and what don't they?** — They remove re-parsing and macro leakage and enforce the ODR; they do not remove template *instantiation* cost, and BMIs are non-portable build artifacts.
13. **Are C++20 coroutines stackless or stackful, and why does it matter?** — Stackless: only the coroutine's own frame is saved, so suspension is only possible in its own body, but per-task memory is tens of bytes rather than kilobytes.
14. **What is in a coroutine frame?** — The promise, by-value copies of parameters, locals that live across a suspend point, the resume/destroy pointers, and the suspend index.
15. **Why must coroutine parameters be taken by value?** — References are not copied into the frame, so a temporary argument dangles once the coroutine suspends and the caller's full-expression ends.
16. **What is symmetric transfer and what problem does it solve?** — `await_suspend` returning a `coroutine_handle` causes a tail-call resume, preventing unbounded machine-stack growth in a chain of awaiting coroutines. `noop_coroutine()` terminates the chain.
17. **How can a coroutine avoid heap allocation?** — HALO frame elision when the coroutine is inlined and does not escape (Clang most reliably), or a promise-level `operator new`/`operator delete` backed by a pool.
18. **Why does `final_suspend` usually return `suspend_always`?** — Otherwise the frame self-destroys at completion and the caller cannot read the result; the price is that the owner must call `handle.destroy()`.
19. **What does `elements_of` fix in `std::generator`?** — Naive recursive delegation is O(N·depth); the generator keeps an explicit stack of handles and resumes the innermost directly.
20. **What problems does deducing `this` solve?** — Collapsing const/ref-qualified overload sets into one forwarding function, recursive lambdas without `std::function`, CRTP without the template parameter, and passing small objects by value in a register.
21. **Difference between `const`, `constexpr`, and `constinit` on a variable?** — `constexpr` = constant-initialized and immutable and usable in constant expressions; `constinit` = constant-initialized but mutable; `const` says nothing about initialization time.
22. **How does `constinit` help latency?** — No dynamic initialization, no `__cxa_guard` on function-local statics, and for `thread_local` it removes the per-access initialization check and can avoid `__tls_get_addr`.
23. **Why were contracts pulled from C++20?** — The design let the compiler *assume* unchecked predicates, so build mode could silently change semantics into UB. P2900 (C++26) separates checking from assumption; `[[assume]]` is the explicit assumption tool.
24. **What does static reflection replace?** — `magic_enum`, Boost.PFR, X-macros, and IDL codegen for serialization; it is entirely constant-evaluation, so runtime cost is zero and compile-time cost is the trade.

---

## Common Traps

- **Forgetting to re-`move` a named `T&&` parameter** — silent copy.
- **`const T` return type** — defeats moves and NRVO.
- **Missing `noexcept` on the move constructor** — `vector` growth silently deep-copies.
- **Declaring a destructor** — suppresses implicit move operations; the class copies forever after.
- **`return std::move(x)`** — disables NRVO; pessimization warning exists for a reason.
- **Assuming NRVO is guaranteed** — only prvalue returns are; named locals are not.
- **Range-`for` over a temporary's subobject** — dangles pre-C++23.
- **`for (auto x : big_container)`** — copies every element; and `auto&` fails outright on `vector<bool>`.
- **`auto [a,b] = big_struct;` in a loop** — copies the whole struct into the hidden object each iteration.
- **Expecting `_` or per-name attributes in structured bindings** — not available before C++26 (P2169).
- **Capturing a C++17 structured binding in a lambda** — ill-formed; fixed in C++20 with uneven implementation support.
- **Expecting `<=>` to give you `==`** — it doesn't, unless the `<=>` is defaulted.
- **Comparing doubles with defaulted `<=>` and assuming a total order** — NaN makes it `partial_ordering`; use `std::strong_order` for deterministic sorting.
- **Shipping BMIs** — non-portable across compilers, versions, and flags.
- **Expecting modules to speed up template-heavy code** — parsing improves, instantiation does not.
- **Coroutine parameters by reference** — dangling across suspension. Same for `[&]` and `[this]` in coroutine lambdas.
- **Using a `coroutine_handle` after `destroy()`**, or leaking it because `final_suspend` suspends and nobody destroys.
- **`final_suspend` not marked `noexcept`** — ill-formed.
- **Awaiting a chain without symmetric transfer** — stack overflow at depth.
- **Assuming HALO removes the coroutine allocation** — verify with `-Rpass=coro-elide` or by instrumenting `operator new`; storing the handle anywhere defeats it.
- **Treating `std::generator` as multi-pass** — it is an input range; the reference is invalidated by `++`.
- **Writing an unqualified member name inside a deducing-`this` function** — there is no implicit `this`.
- **Making a deducing-`this` function virtual** — ill-formed; it is a static-polymorphism tool.
- **Assuming `constinit` prevents destruction-order problems** — it doesn't; you also need a trivial destructor or a deliberate leak.
- **Relying on contracts or reflection in production today** — C++26 features with prototype-level implementations.

---

## Compact Recall Summary

**Moves.** `std::move` is a cast; moving is a library convention. Named rvalue references are lvalues. `const`, a user-declared destructor, and a throwing move each silently degrade to copying. Moved-from means valid-but-unspecified. Trivial relocatability (C++26) is the missing primitive that would let containers `memcpy` instead of move-and-destroy.

**Elision.** C++17 made prvalues initializers rather than objects: returning a prvalue constructs directly in the caller's return slot, works with deleted copy *and* move, and is mandatory even at `-O0`. NRVO (named local) remains optional; when it fails, implicit move on return applies. `return std::move(x)` disables NRVO.

**Range-`for`.** Desugars to `auto&& __range` plus a `begin`/`end` (possibly heterogeneous, C++17 — the sentinel enabler). Temporaries inside the range expression dangled until C++23 P2718; `auto&&` is the correct loop variable because of proxies and view prvalues.

**Structured bindings.** A hidden `e` plus names for its parts; array / `tuple_size`+`get<i>` / all-public-members-in-one-class. Qualifiers apply to `e`, not the names; `decltype(name)` gives the referenced type. C++26 adds packs (P1061) and `_` (P2169).

**`<=>`.** One function synthesizes `< > <= >=` plus reversed candidates. `==` is separate on purpose (equality is cheaper), except that a defaulted `<=>` also declares a defaulted `==`. Categories: strong (substitutable) / weak (equivalent but distinguishable) / partial (NaN, unrelated pointers). Reversed candidates are the main C++20 migration break.

**Modules.** BMIs instead of textual inclusion: no macro leakage, ODR enforced, order-independent, module-local names invisible. Costs a build-order dependency scan; BMIs are non-portable. Fixes parsing, not instantiation.

**Coroutines.** Stackless; the compiler transforms the body against the promise protocol. Frame = promise + by-value parameters + cross-suspend locals + resume/destroy pointers + state index. `initial_suspend` picks lazy vs eager; `final_suspend` (must be `noexcept`) returning `suspend_always` preserves the result and transfers frame ownership to you. `await_suspend` returning a handle is **symmetric transfer**, required to avoid stack growth. Allocation is a heap call unless HALO elides it (needs inlining and non-escape) or the promise supplies a pooled `operator new`. Suspend/resume ≈ 5–20 ns versus ~1–3 µs for a thread switch. Parameters by value, always.

**`std::generator`** (C++23) is the first standard coroutine type: lazy, single-pass, owns its frame, `elements_of` gives O(1) recursive delegation via an internal handle stack. Use it for genuinely stateful production; use `ranges` views for transforms that should fuse.

**Deducing `this`** (C++23) collapses four cv/ref overloads into one forwarding function, gives recursive lambdas, replaces CRTP without a base template parameter, and enables by-value `this` in a register. No implicit `this`, never virtual.

**`constinit`** (C++20) asserts constant initialization while allowing mutation — killing the static-init-order fiasco, the `__cxa_guard` on function-local statics, and per-access `thread_local` initialization checks. Pair with a trivial destructor to avoid `__cxa_atexit` shutdown ordering.

**Contracts** (C++26 P2900): `pre`/`post`/`contract_assert` with per-TU semantics (ignore/observe/enforce/quick_enforce) and a replaceable violation handler; deliberately does **not** grant the optimizer permission to assume — that is `[[assume]]` (C++23). The C++20 removal was precisely about that conflation.

**Reflection** (C++26 P2996): `^^X` reflects, `[:r:]` splices, `consteval` queries walk members and enumerators, `template for` expands. Replaces `magic_enum`, Boost.PFR, X-macros, and IDL codegen for wire formats — zero runtime cost, compile-time cost paid in the constant evaluator.
