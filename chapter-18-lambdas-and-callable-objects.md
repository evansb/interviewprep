# Chapter 18 — Lambdas and Callable Objects

*Interview-focused revision notes. The theme: a lambda is a compiler-generated class with an `operator()`, so every question about capture, mutability, cost, and lifetime is really a question about that class's members, qualifiers, and storage.*

---

## 18.1 Lambda Capture Modes

A **lambda expression** creates an unnamed **closure type** (§18.4) and a closure object of that type. The capture list declares which enclosing automatic variables become **members** of that class.

```cpp
int a = 1, b = 2;
auto f1 = [ ]        { };            // captures nothing
auto f2 = [a]        { return a; };  // a by VALUE — a copy stored as a member
auto f3 = [&b]       { b = 3; };     // b by REFERENCE — a reference member (or pointer)
auto f4 = [=]        { return a+b; };// default capture by value: only ODR-USED variables
auto f5 = [&]        { a=b; };       // default capture by reference
auto f6 = [=, &b]    { };            // value default, b by reference
auto f7 = [&, a]     { };            // reference default, a by value
auto f8 = [a, a]     { };            // ERROR — duplicate
auto f9 = [=, a]     { };            // ERROR pre-C++20; LEGAL in C++20 (redundancy allowed
                                     //   for explicitness; still an error with `&` default)
```

### The rules that matter

- **Only automatic-storage-duration variables of the enclosing function can be captured.** Globals, `static` locals, `thread_local`s, and `constexpr` variables are *not* captured — they are simply referenced. This is why `[=]` does not make a `static` counter thread-safe: every closure refers to the same object. It is also why a lambda that "captures" only globals is still captureless (§18.5).
- **Default captures capture only what is odr-used.** A variable read in a discarded `if constexpr` branch, or used only in an unevaluated `decltype`/`sizeof`, is not captured. Conversely, an integral `constexpr` local used by value is generally not odr-used and thus not captured — until you bind a reference to it, which requires capture.
- **Capture by value copies at the point the lambda is *created*, not when it is called.** Mutating `a` afterwards does not change what `f2` returns.
- **Capture by reference is a dangling risk** the moment the closure outlives the frame (§18.9).
- **A capture-by-value member is `const`** unless the lambda is `mutable` (§18.6), because `operator()` is `const` by default.
- **Structured bindings** could not be captured in C++17 (a defect); C++20 permits capturing them by value or reference.
- **Parameter packs** may be captured in C++20 via init-capture pack expansion (§18.2).
- **`[=]` capturing `this` is deprecated in C++20** (see §18.3) because it silently captures a pointer, not the object.

### What the capture list is not

Capture is **not** an overload set, **not** lazy, and **not** a name-lookup mechanism: `[x = y]` introduces a *new* variable in the closure's scope (§18.2), while `[y]` copies `y` under its own name. Names in the body are looked up in the enclosing scope first; a capture does not shadow anything at namespace scope.

### Cost model

Each captured value adds a member; the closure's size and alignment follow the ordinary layout rules of Ch. 3 §3.4 (order is implementation-defined for default captures, declaration order for explicit ones — the standard leaves it unspecified either way). A closure capturing three `int`s by value is 12 bytes and lives on the stack; passing it to a template parameter inlines completely and costs nothing at `-O2`. The cost only appears when it must be *stored*: a closure larger than the SBO buffer of `std::function` heap-allocates (§18.10). **Capturing by reference keeps the closure small (one pointer per capture) but converts a copy into an indirection** — a genuine trade-off in a callback stored in a container, where the extra pointer chase is a cache miss.

---

## 18.2 Init-Capture

C++14 **init-capture** (also "generalized lambda capture") declares a new closure member with an initializer, decoupling the member's name and value from any enclosing variable:

```cpp
auto f = [n = 42]              { return n; };
auto g = [p = std::move(uptr)] { p->run(); };            // MOVE into the closure
auto h = [c = compute()]       { return c; };            // compute ONCE at creation
auto k = [&r = obj.member]     { r++; };                 // capture a sub-object by reference
auto m = [self = shared_from_this()] { self->tick(); };  // extend lifetime for an async callback
```

The declared type is deduced with `auto` rules (Ch. 2 §2.16), so `[n = expr]` deduces by value and `[&n = expr]` by reference. `auto` semantics mean top-level cv and references are stripped: `[n = someConstRef]` gives a non-const, non-reference copy.

### Why it exists

1. **Move-capture.** Before C++14 there was no way to move a `unique_ptr` into a closure; the workaround was a `shared_ptr` or a hand-written functor class. `[p = std::move(p)]` is the reason `unique_ptr` can be captured at all, and is what makes lambdas usable as move-only task types in a thread pool (Ch. 24 §24.4).
2. **Capturing an expression, not a variable.** `[len = v.size()]` avoids storing a reference to `v` just to call `size()`.
3. **Capturing a member without capturing `this`.** `[m = this->member]` or `[&m = this->member]` gives you the sub-object with an explicit lifetime relationship, rather than a `this` pointer that dangles when the object dies (§18.3).
4. **Renaming for clarity**, and capturing a `const` view of a mutable variable: `[&cr = std::as_const(v)]`.

### Pack expansion in init-capture (C++20)

```cpp
template <class... Args>
auto bind_all(Args&&... args) {
    return [...xs = std::forward<Args>(args)] () mutable { target(std::move(xs)...); };
}
```
Before C++20 the standard workaround was to capture a `std::tuple` and unpack with `std::apply` (Ch. 15 §15.2) — still the pattern in C++14/17 code, and worth being able to write:

```cpp
return [t = std::make_tuple(std::forward<Args>(args)...)] () mutable {
    std::apply([](auto&&... xs){ target(std::forward<decltype(xs)>(xs)...); }, std::move(t));
};
```

### The `mutable` interaction

A move-captured `unique_ptr` used in a way that modifies it (moving out of it, resetting it) requires `mutable`, because the closure member is `const` in a non-`mutable` lambda (§18.6). `[p = std::move(p)] { return std::move(p); }` compiles but *copies*... except `unique_ptr` has no copy, so it fails to compile — a common confusion whose real answer is "the member is `const`, add `mutable`."

Init-capture is also the reason a lambda can be **non-copyable**: capturing a move-only type makes the closure move-only, which is exactly why `std::function` (which requires copyability) cannot hold it and `std::move_only_function` (C++23) was added (§18.10).

---

## 18.3 Capturing `this` and `*this`

Inside a non-static member function, the lambda body may name members. It does so through a captured **`this` pointer**:

```cpp
struct Session {
    int timeout;
    auto make_checker() {
        return [this]  { return timeout > 0; };   // captures the POINTER
        return [=]     { return timeout > 0; };   // ALSO captures `this` — deprecated in C++20
        return [&]     { return timeout > 0; };   // ALSO captures `this` (as a pointer)
        return [*this] { return timeout > 0; };   // C++17: captures a COPY of the object
        return [t = timeout] { return t > 0; };   // captures just the member, by value
    }
};
```

**The critical fact: `[=]` does not copy the object.** It captures `this` by value — the *pointer* by value — so every member access is an indirection through a pointer that dangles as soon as the `Session` is destroyed. The lambda looks self-contained and is not. This is the single most common lambda lifetime bug in asynchronous code:

```cpp
void Session::start() {
    io.async_read(buf, [=](auto ec, size_t n) { handle(ec, n); });  // `this` may be gone
}
```

Because the misleading appearance of `[=]` is so damaging, **C++20 deprecates implicit `this` capture via `[=]`** (P0806); `[=, this]` is the explicit form, and compilers emit `-Wdeprecated-this-capture`. `[&]` still captures `this` implicitly and is not deprecated, on the grounds that `[&]` never suggested independence.

### `[*this]` (C++17)

Captures a *copy of the whole object* as a closure member. Members are then accessed on that copy, and the closure is self-contained.

| | `[this]` / `[=, this]` | `[*this]` | `[m = member]` |
|---|---|---|---|
| Stored | 8-byte pointer | Full copy of `*this` | Just the members used |
| Lifetime safety | Dangles if the object dies | Safe | Safe |
| Sees later mutations | Yes | No — snapshot at creation | No |
| Cost | 1 pointer + an indirection per access | `sizeof(*this)` copy | Minimal |
| Requires | Nothing | Copy-constructible object | Copyable members |
| Const-ness | Members are const iff the enclosing member function is const | Copy is a const member unless `mutable` | Member is const unless `mutable` |

`[*this]` is not a general fix — copying a large object per callback is expensive, and copying an object that owns resources changes semantics. For asynchronous work the idiomatic answer is `[self = shared_from_this()]` (Ch. 9 §9.7), which keeps the *same* object alive rather than snapshotting it. That requires `enable_shared_from_this` and a `shared_ptr`-owned object; calling `shared_from_this()` on a stack object or during the constructor throws `std::bad_weak_ptr`.

For a **cancellable** callback, `[weak = weak_from_this()]` plus a `lock()` check is better still: the callback becomes a no-op if the object died, rather than keeping a dead object alive (Ch. 9 §9.5).

**Deducing this** (C++23, Ch. 19 §19.11) gives a related tool: an explicit object parameter on `operator()` lets a lambda recurse without `std::function` or the Y-combinator trick:

```cpp
auto fib = [](this auto&& self, int n) -> int { return n < 2 ? n : self(n-1) + self(n-2); };
```
This is the modern answer to "how do you write a recursive lambda," superseding `std::function<int(int)> f = [&f](int n){…};` (which allocates and indirects) and the `y_combinator` pattern.

---

## 18.4 Lambda Closure Types

The closure type is a **unique, unnamed, non-union class type** generated at the point the lambda expression appears. Its properties are fully specified:

```cpp
auto f = [x = 1](int y) mutable noexcept -> int { return x + y; };

// approximately equivalent to:
class __lambda_N {
    int x;                                                    // captures become members
public:
    explicit __lambda_N(int x_) : x(x_) {}
    int operator()(int y) noexcept { return x + y; }           // non-const because `mutable`
    __lambda_N(const __lambda_N&) = default;
    __lambda_N(__lambda_N&&) = default;
    __lambda_N& operator=(const __lambda_N&) = delete;         // pre-C++20
};
```

| Property | Rule |
|---|---|
| Class kind | Unique unnamed non-union class, at the smallest enclosing scope |
| `operator()` | Public inline; `const` unless `mutable`; `constexpr` if it qualifies (§18.8); may be `noexcept`, may have a trailing return type, may be a template (§18.7) |
| Copy/move constructors | Defaulted; the closure is copyable iff all captures are |
| Copy assignment | **Deleted** in C++11/14/17; **defaulted for captureless lambdas in C++20** |
| Default constructor | **Deleted** pre-C++20; **defaulted for captureless lambdas in C++20** |
| Destructor | Implicitly declared, defaults from members |
| `sizeof` | ≥ 1; captureless lambdas are empty classes, so EBO / `[[no_unique_address]]` shrinks them to zero as members (Ch. 3 §3.4) |
| Layout | Order of members is **unspecified**; not standard-layout in general |
| Conversion to function pointer | Only if captureless (§18.5) |

### The C++20 change and why it matters

C++20 (P0624) makes **captureless** closure types default-constructible and copy-assignable. That unlocks:

```cpp
auto cmp = [](const Order& a, const Order& b) { return a.px < b.px; };
std::map<Order, int, decltype(cmp)> m;                  // C++20: no need to pass cmp
std::set<int, decltype([](int a, int b){ return a > b; })> s;   // lambda in an unevaluated context
```
Two further C++20 relaxations enable that second line: **lambdas in unevaluated contexts** (inside `decltype`, `sizeof`, template arguments) and **lambdas in constant expressions**. Before C++20 you had to name a functor struct to use it as a comparator template argument.

Note the **stateless-comparator size win**: `std::map<K,V,Cmp>` stores the comparator; if `Cmp` is a captureless lambda (an empty class) it costs zero bytes via EBO, whereas `std::function<bool(K,K)>` costs 32 bytes plus an indirect call per comparison. Passing comparators as *types*, not as `std::function`, is the standard low-latency practice (Ch. 12 §12.1, Ch. 14 §14.8).

### Uniqueness consequences

Every lambda expression yields a *distinct* type, even textually identical ones — including in different instantiations of the same template. Therefore:
- Two lambdas never have the same type; you cannot declare a variable of "the lambda type" without `auto`/`decltype`.
- A lambda in a header used as a default template argument produces a different type in each TU, which can be an **ODR violation** (this is why lambdas in inline functions and in NTTPs have careful special rules; C++20 P0315 permits lambdas in unevaluated operands but requires them to be the same entity across TUs when in an inline function).
- Storing heterogeneous lambdas in one container requires erasure (§18.10) or `std::variant`.

---

## 18.5 Captureless Lambda Conversion

A lambda with an **empty capture list** has an implicit, `constexpr` (since C++17), non-explicit conversion operator to a **plain function pointer** with the same signature:

```cpp
auto f = [](int x) { return x * 2; };
int (*fp)(int) = f;                            // implicit conversion
::qsort(p, n, sz, [](const void* a, const void* b) { … });   // C API callback
std::signal(SIGINT, [](int) { g_stop = 1; });                // C callback
```
The mechanism: the closure type gets a static member function with the lambda's body plus `operator T(*)(Args...)` returning its address. `noexcept` lambdas convert to `noexcept` function pointers; C++17 added conversion to pointers with other calling conventions on implementations that need it (`__stdcall` etc.).

**Why the restriction is fundamental:** a function pointer is a bare code address with no room for state. A capturing lambda's `operator()` needs the closure object as its implicit `this`, and there is nowhere in a raw function pointer to put it. This is exactly the same reason a non-static member function pointer is not a function pointer (Ch. 4 §4.10), and it is the reason C callback APIs universally take a `void* user_data` alongside the function pointer.

### The idiomatic C-callback bridge

```cpp
template <class F>
void register_cb(F&& f) {
    static auto stored = std::forward<F>(f);          // or store in a context struct
    c_api_register(+[](void* ud) { (*static_cast<decltype(&stored)>(ud))(); }, &stored);
}
// or, the standard trampoline shape:
c_api_register([](void* ud) { (*static_cast<F*>(ud))(); }, &f_object);
```
The trampoline pattern: pass a *captureless* lambda as the function pointer and the closure's address as `void* user_data`; the trampoline casts it back and invokes. This is how every C++ wrapper over `pthread_create`, `epoll` user data, `libuv`, and DPDK callbacks works, and being able to write it on demand is a common interview task.

**The unary `+` trick:** `+[]{ … }` forces the conversion to a function pointer (the built-in unary `+` accepts a pointer, and the closure's only viable conversion is to a function pointer). It appears in code that needs to defeat template deduction of the closure type, or to make two lambdas in a ternary have a common type:

```cpp
auto p = cond ? +[]{ return 1; } : +[]{ return 2; };   // both convert to int(*)(); OK
auto q = cond ? []{ return 1; } : []{ return 2; };     // ERROR — unrelated closure types
```

**Latency note:** converting to a function pointer *discards the type* and therefore discards inlining — the call becomes an indirect branch that must be predicted by the BTB (Ch. 27 §27.9). Passing the lambda as a template parameter (`template <class F> void run(F f)`) keeps the type, inlines the body, and costs nothing. Convert to a function pointer only at a genuine C boundary.

---

## 18.6 Mutable Lambdas

`operator()` of a closure is **`const` by default**. Consequently, by-value captures are non-modifiable inside the body. `mutable` removes the `const`:

```cpp
auto counter = [n = 0]() mutable { return n++; };   // stateful; each CALL increments
counter(); counter();   // returns 0, then 1
auto copy = counter;    // copies the state — the copy continues from 2 independently
```

### The four subtleties

1. **`mutable` affects only value captures.** A reference capture refers to an object outside the closure, whose constness is its own; `[&x]{ x = 1; }` compiles without `mutable`.
2. **A `mutable` lambda cannot be invoked through a const reference.** `const auto f = [n=0]() mutable { return n++; };` — calling `f()` fails, because `operator()` is non-const. This bites when a closure is stored as a const member or passed as `const F&`.
3. **Algorithms may copy the functor.** `std::for_each`, `std::remove_if`, `std::sort` take the predicate **by value** and are permitted to copy it internally. A stateful mutable predicate therefore has **unspecified** accumulated state — the standard explicitly says predicates must not have state that affects the result. `std::for_each` is the exception: it *returns* the functor, so `auto f = std::for_each(b, e, Counter{});` recovers the final state. Using a stateful mutable lambda with `std::remove_if` (e.g. "remove every other element") is a classic bug: libstdc++ and libc++ can produce different results.
4. **`mutable` and `const` member functions.** In a `const` member function, `[*this]` captures a `const` copy, so `mutable` on the lambda does not make the captured members writable — the copy's type is `const Session`.

### When you actually want it

Genuinely useful for: a memoizing or accumulating closure passed to a template (not an algorithm), a one-shot move-out (`[p = std::move(p)]() mutable { return std::move(p); }`), and any closure that owns a move-only resource it must modify. In hot code, a mutable lambda held by value in a template parameter is fully inlined and its state lives in registers — it is not a "heavier" lambda in any runtime sense; `mutable` is purely a compile-time qualifier change.

A common misconception: `mutable` on a lambda has nothing to do with the `mutable` *storage-class specifier* on class members (which excepts a member from a const object's constness). They share a keyword and nothing else.

---

## 18.7 Generic Lambdas

C++14 **generic lambdas** allow `auto` parameters; each `auto` parameter makes `operator()` a template with an invented parameter (Ch. 17 §17.13):

```cpp
auto plus = [](auto a, auto b) { return a + b; };        // template<class T,class U> operator()(T,U) const
auto fwd  = [](auto&&... xs) { g(std::forward<decltype(xs)>(xs)...); };   // generic + variadic
```
Note the forwarding idiom: with `auto&&` you must write `std::forward<decltype(xs)>(xs)` because there is no named `T`.

### Template-parameter lambdas (C++20)

C++20 (P0428) adds an explicit template parameter list, recovering everything `auto` parameters lost:

```cpp
auto f = []<class T>(std::vector<T>& v) { v.reserve(1024); };      // constrain the SHAPE
auto g = []<class T, size_t N>(T (&arr)[N]) { return N; };         // deduce an NTTP
auto h = []<class T>(T a, T b) { return a + b; };                  // force the SAME type
auto i = []<std::integral T>(T x) { return x + 1; };               // concept-constrained
auto sum = []<class... Ts>(Ts... xs) { return (xs + ... + 0); };   // name the pack
```
With `auto` alone, `[](auto a, auto b)` allows mismatched types and gives you no name for `T` — you had to write `std::decay_t<decltype(a)>` everywhere. Explicit template parameters are strictly better whenever the body needs the type.

Constraints work on `auto` parameters too: `[](std::integral auto x){ … }` (abbreviated syntax) and a trailing `requires` clause are both legal.

### The overloaded-visitor idiom

Generic lambdas compose with pack expansion into the standard `std::variant` visitor (Ch. 15 §15.4, Ch. 17 §17.15):

```cpp
template <class... Fs> struct overloaded : Fs... { using Fs::operator()...; };
template <class... Fs> overloaded(Fs...) -> overloaded<Fs...>;   // unneeded in C++20

std::visit(overloaded{
    [](const Add& a)    { book.add(a); },
    [](const Cancel& c) { book.cancel(c); },
    [](auto&&)          { /* fallback */ }
}, msg);
```
The generic `[](auto&&)` arm is the catch-all, and it works because a non-template exact match beats a template (Ch. 17 §17.1). Omitting it makes the visit exhaustive at compile time — usually what you want for a message dispatcher, since adding a variant alternative then fails to build rather than silently falling through.

### `if constexpr` inside a generic lambda

```cpp
auto serialize = [](auto&& v, Buffer& b) {
    using T = std::remove_cvref_t<decltype(v)>;
    if constexpr (std::is_trivially_copyable_v<T>) b.raw(&v, sizeof v);
    else                                          v.serialize(b);
};
```
This inline type switch (Ch. 17 §17.19) is one of the most common modern patterns and is a natural thing to be asked to write.

**Cost:** generic lambdas instantiate one `operator()` body per argument-type combination — the same code-bloat exposure as any template (Ch. 17 §17.22). A generic lambda used across many types in a header multiplies accordingly.

---

## 18.8 Constexpr Lambdas

Since **C++17**, a lambda's `operator()` is **implicitly `constexpr`** whenever it satisfies the requirements for a `constexpr` function — you need not write the keyword. You may write it explicitly to get a hard error when the body is not in fact constexpr-eligible:

```cpp
auto square = [](int n) { return n * n; };                  // implicitly constexpr (C++17)
static_assert(square(4) == 16);
constexpr auto cube = [](int n) constexpr { return n*n*n; }; // explicit; diagnoses failure
constexpr int arr[square(3)] = {};                           // usable in a constant expression
```

Three distinct things are being qualified, and conflating them is a common error:

| Placement | Meaning |
|---|---|
| `constexpr auto f = [] { … };` | The closure **object** is a constant expression — requires the closure to be a literal type (captureless, or with literal-type captures) |
| `[] () constexpr { … }` | The **`operator()`** is constexpr — invocable at compile time |
| `[] () consteval { … }` (C++20) | `operator()` is an immediate function — *must* be evaluated at compile time |
| `constinit` | Not applicable to lambdas directly; see Ch. 19 §19.12 |

### Requirements and interactions

- A `constexpr` closure **object** must be a literal type: all captures must be literal types, and the closure must be trivially destructible. A captureless lambda always qualifies.
- Captures may be used in constant evaluation only if they are themselves constant: `constexpr int n = 4; auto f = [n]{ return n; }; static_assert(f() == 4);` works, but `int n = 4;` does not.
- **C++20 relaxations** that made constexpr lambdas far more usable: lambdas in unevaluated contexts, lambdas in constant expressions generally, `constexpr` virtual functions, `constexpr` allocation (transient, must be freed within the same evaluation), `constexpr` try/catch bodies, and `std::is_constant_evaluated()`.
- **C++23** added `constexpr` `std::unique_ptr`, more constexpr `<cmath>`, and the ability for a constexpr function to contain code that would be invalid at compile time provided it is not reached — softening the old "must be constexpr-evaluable for at least one argument set, else IFNDR" rule.
- A lambda inside a `consteval` function, or one marked `consteval`, cannot be called at runtime at all — useful for compile-time validation helpers (parsing a format string, checking a protocol table).

**Low-latency angle:** a lambda used as a compile-time table generator eliminates static-initialization order problems (Ch. 5 §5.10) and runtime setup cost:

```cpp
constexpr auto make_lut = [] {
    std::array<uint8_t, 256> t{};
    for (int i = 0; i < 256; ++i) t[i] = /* … */;
    return t;
}();                                        // IIFE evaluated at compile time
constexpr auto kLut = make_lut;             // lands in .rodata, zero startup cost
```
The immediately-invoked lambda expression (IILE) as a `constexpr` initializer is the idiomatic way to build a complex constant with imperative code, and also the standard way to initialize a `const` member that needs several statements.

---

## 18.9 Dangling Lambda Captures

The dominant lambda bug class: a closure outlives what it refers to. There is no lifetime tracking; the reference member is a raw reference or pointer.

### The four shapes

```cpp
// 1. Reference capture escaping the frame
std::function<int()> make() { int x = 42; return [&x]{ return x; }; }   // dangles immediately

// 2. Implicit `this` capture in an async callback
void Session::start() { timer.async_wait([=](auto){ retry(); }); }      // `this` may be freed

// 3. Reference to a temporary bound at the call site
auto f = [&s = get_string()] { return s.size(); };   // temporary dies at the end of the
                                                     // full-expression; lifetime extension
                                                     // does NOT apply to init-captures

// 4. Reference capture of a loop variable, deferred
for (auto& item : items) tasks.push_back([&item]{ process(item); });
// `item` is fine only while `items` lives AND is not reallocated/erased
```

Shape 3 deserves emphasis: **reference lifetime extension does not extend through a lambda capture.** `const T& r = f();` extends the temporary's life to `r`'s scope, but `[&r = f()]` does not — the init-capture is not the kind of reference binding that triggers extension. Compilers now diagnose the direct cases (`-Wdangling`, Clang's `-Wreturn-stack-address`), but not through indirection.

### Detection and prevention

| Tool / technique | Catches |
|---|---|
| `-Wdangling`, `-Wreturn-stack-address`, `-Wdangling-gsl` (Clang) | Directly returned/obvious cases |
| **AddressSanitizer** with `detect_stack_use_after_return=1` | The runtime workhorse for shapes 1 and 4 (Ch. 44 §44.2) |
| Clang `[[clang::lifetimebound]]` / C++26 lifetime annotations | API-level marking of returned references |
| `-Wdeprecated-this-capture` (C++20) | Implicit `this` via `[=]` |
| Convention: **never `[&]` or `[=]` in a closure that is stored** | All shapes — the highest-value rule |

### The discipline

- **`[&]` is safe for immediately-consumed closures only** — algorithm predicates, `std::sort` comparators, scope guards (Ch. 10 §10.13), parallel-algorithm bodies. It is fastest and it is the right default *there*, because the enclosing frame provably outlives the call.
- **Any closure that is stored, queued, or passed across a thread boundary must capture by value or by owning handle.** For a thread pool task, `std::thread`, `std::async`, or a coroutine's continuation, capture by value or `[self = shared_from_this()]`.
- **`std::thread`/`jthread` with `[&]` is a classic race** — the launching frame may return before the thread reads the reference. Detached threads make it certain.
- **Coroutines amplify this** (Ch. 19 §19.7): a lambda coroutine's *closure object* is destroyed at the first suspension unless it is kept alive, so a capturing lambda coroutine dangles its own captures. The fix is to pass state as coroutine parameters (which are copied into the frame) or to keep the closure alive explicitly.
- **`std::bind` has the same hazards** with the added confusion that it copies by default and `std::ref` opts into references — another reason lambdas superseded it.

**Interview framing:** "Your callback crashes intermittently after a reconnect" is nearly always shape 2 — `[=]` capturing `this` on an object destroyed by the reconnect path — and the expected answers are `shared_from_this`/`weak_from_this`, `[*this]` where a snapshot is acceptable, and the C++20 deprecation as the language's acknowledgement of the trap.

---

## 18.10 Small-Object Optimization in Callable Wrappers

A closure has a unique type, so storing heterogeneous callables requires **type erasure** (Ch. 6 §6.20). The standard wrappers apply a **small-object optimization (SOO/SBO)**: a fixed inline buffer holds small callables; larger ones heap-allocate.

```cpp
std::function<void()> f = [a, b, c] { … };   // fits the SBO buffer → no allocation
std::function<void()> g = [big_array] { … }; // exceeds it → operator new
```

### The wrappers

| Type | Since | Owns? | Copyable | Allocates | Notes |
|---|---|---|---|---|---|
| `std::function<R(A...)>` | C++11 | Yes | **Requires copyable target** | Yes, above SBO | The default; `target_type`/`target<T>` give RTTI-based access |
| `std::move_only_function<R(A...) cv ref noexcept>` | C++23 | Yes | No — move-only | Yes, above SBO | Holds move-only closures (`unique_ptr` captures); supports cv/ref/noexcept qualifiers in the signature, which `std::function` cannot |
| `std::copyable_function` | C++26 | Yes | Yes | Yes, above SBO | The intended replacement for `std::function`, with the qualifier support and without `target()` |
| `std::function_ref<R(A...)>` | C++26 | **No** | Trivially copyable | **Never** | Non-owning: two pointers (object + thunk). The correct parameter type for a callback that is only used during the call |
| Template parameter `F` | — | n/a | n/a | Never | Zero cost, full inlining — always preferable when the type can be static |

### SBO sizes and why they are not guaranteed

The standard does **not** mandate any inline buffer; it only says implementations "should" avoid allocation for small callables and that `std::function`'s constructor from a "small" object should not throw. Typical sizes:

| Implementation | `sizeof(std::function)` | Inline capacity |
|---|---|---|
| libstdc++ | 32 bytes | 16 bytes (one `union { void* ; char[16] }`), and **only for trivially-copyable / nothrow-move types** |
| libc++ | 32 bytes | ~16–24 bytes depending on version |
| MSVC | 64 bytes | ~40 bytes |

So `[this, id]` (16 bytes) generally fits; `[this, id, price, qty]` (32 bytes) generally does not, and you get a heap allocation per assignment plus a cache miss per invocation. **Capturing three or four small members is the crossover point at which `std::function` starts allocating** — worth stating precisely, because it is the practical rule.

### Cost of invocation

`std::function::operator()` is an **indirect call through a stored function pointer** (the invoker/thunk), preceded by a null check that may throw `std::bad_function_call`. Consequences:

- **Not inlinable** across the erasure boundary, so the callee's body is opaque; the optimizer cannot propagate constants or vectorize through it.
- **An indirect branch**, predicted by the BTB; a polymorphic call site with many distinct targets mispredicts (Ch. 27 §27.9–27.10) at ~15–20 cycles each.
- **An extra cache miss** if the target is heap-allocated, since the closure state lives elsewhere.
- Roughly: template parameter ≈ 0 ns (inlined); `function_ref` ≈ 1–2 ns (one indirect call, no miss); `std::function` inline-buffer ≈ 2–3 ns; `std::function` heap ≈ 5–15 ns with a miss.

### The low-latency prescription

1. **Hot path: template parameter.** `template <class F> void for_each_tick(F&& f)` inlines the body entirely.
2. **Callback parameter used only during the call: `function_ref`** (C++26; `tl::function_ref`/`absl::FunctionRef` today). It never allocates, never owns, is trivially copyable, and passes in two registers. Its hazard is that it is a *view* — storing one is the same dangling class as §18.9.
3. **Stored heterogeneous callbacks: preallocate.** Either use a fixed-capacity `inplace_function`-style wrapper (`sg14::inplace_function<void(), 64>`, `folly::Function` variants) with a compile-time-asserted capacity, or a hand-rolled vtable-plus-inline-storage struct sized to your workload. This gives you erasure without heap traffic — the standard trading-system pattern.
4. **Never a `std::function` in a per-message path.** If you must, pre-construct and reuse rather than assigning per event, since assignment is where the allocation happens.
5. **`std::move_only_function` (C++23) for task queues**, since tasks own `unique_ptr`s and promises and are moved, not copied — it also avoids the copyability requirement forcing `shared_ptr`.

---

## Key Interview Questions

1. **What is a lambda, precisely?** — An expression creating a unique unnamed closure class with an inline `operator()`, whose members are the captures.
2. **What can and cannot be captured?** — Only automatic-storage variables of the enclosing function; globals, statics, and `thread_local`s are referenced, not captured, so `[=]` does not make a static safe.
3. **Does `[=]` copy the object in a member function?** — No: it captures `this` by value, i.e. the pointer. Deprecated in C++20; `[*this]` (C++17) copies the object.
4. **Why is `operator()` const by default, and what does `mutable` change?** — So value captures are read-only; `mutable` drops the `const`, which is required to modify or move out of a value capture.
5. **Why is a stateful mutable lambda dangerous as an algorithm predicate?** — Algorithms take predicates by value and may copy them; accumulated state is unspecified. `std::for_each` returns the functor, which is the exception.
6. **How do you move a `unique_ptr` into a lambda?** — C++14 init-capture `[p = std::move(p)]`, plus `mutable` if you modify it; the closure becomes move-only and no longer fits `std::function`.
7. **Which lambdas convert to function pointers, and why the restriction?** — Captureless only; a function pointer has no room for state. Use the trampoline pattern with `void* user_data` for C APIs.
8. **What does `+[]{}` do?** — Forces conversion to a function pointer, e.g. to give two lambdas in a ternary a common type or to defeat closure-type deduction.
9. **What changed about closure types in C++20?** — Captureless closures became default-constructible and copy-assignable, and lambdas became usable in unevaluated contexts — so `std::set<int, decltype([](…){…})>` works.
10. **Why prefer a lambda comparator over `std::function` in a `std::map`?** — A captureless closure is an empty class, costing zero bytes via EBO and inlining fully; `std::function` costs 32 bytes and an unpredictable indirect call per comparison.
11. **How do you write a recursive lambda?** — C++23 `[](this auto&& self, int n){ … }` (deducing this); previously a `std::function` (allocating) or a Y-combinator.
12. **What do explicit template parameter lists on lambdas buy over `auto` parameters?** — A name for the type, the ability to force two parameters to the same type, deduction of array extents/NTTPs, pack naming, and direct concept constraints.
13. **When is a lambda `constexpr`?** — Implicitly since C++17 whenever `operator()` meets constexpr-function requirements; `constexpr` on the *object* additionally requires literal-type captures.
14. **What is the IILE pattern and why use it?** — An immediately-invoked lambda initializing a `constexpr`/`const` value with imperative code, moving table construction to compile time and eliminating static-init-order issues.
15. **Give four ways a lambda capture dangles.** — Reference capture escaping the frame; implicit `this` in an async callback; init-capture of a temporary (lifetime extension does *not* apply); reference to a container element that is later invalidated.
16. **What is the correct capture for an async callback on a `shared_ptr`-owned object?** — `[self = shared_from_this()]` to keep it alive, or `[weak = weak_from_this()]` plus a `lock()` check to make the callback a cancellable no-op.
17. **How big can a lambda be before `std::function` allocates?** — Unspecified by the standard; ~16 bytes in libstdc++/libc++ and only for nothrow-movable types, ~40 in MSVC. Practically: two pointers' worth.
18. **What does invoking through `std::function` cost?** — A null check, an indirect call that the optimizer cannot inline through, BTB pressure, and a possible extra cache miss for heap-stored state.
19. **When would you use `function_ref` instead of `std::function`?** — For a callback that is only invoked during the call: non-owning, never allocates, two registers, trivially copyable — at the price of view semantics and dangling risk if stored.
20. **What does `std::move_only_function` (C++23) solve?** — Holding move-only closures (e.g. `unique_ptr` or promise captures) in a task queue, and supporting cv/ref/`noexcept`-qualified call signatures that `std::function` cannot express.

---

## Common Traps

- **`[=]` in a member function believed to copy the object** — it copies the `this` pointer; the closure dangles when the object dies.
- **`[&]` or `[=]` in a stored, queued, or cross-thread closure** — the top lifetime bug class.
- **Init-capture of a temporary** — lifetime extension does not apply through a capture.
- **Capturing a `static` or global and expecting per-closure state** — they are not captured at all.
- **Forgetting `mutable`** when modifying or moving out of a value capture; the error message names constness, not the capture.
- **A `const` lambda object with a `mutable` `operator()`** — cannot be invoked.
- **Stateful mutable predicates in `remove_if`/`sort`** — the algorithm may copy the functor; results are unspecified and differ between libstdc++ and libc++.
- **Assuming closures of identical text share a type** — every lambda expression yields a distinct type.
- **Lambdas as default template arguments in headers** — distinct types per TU, an ODR hazard.
- **Expecting a capturing lambda to convert to a function pointer** — it cannot.
- **Converting to a function pointer on a hot path** — loses inlining, becomes an indirect branch.
- **`std::function` assignment in a per-message path** — that is where the heap allocation happens.
- **Assuming `std::function` never allocates for "small" lambdas** — the buffer is unspecified and libstdc++ additionally requires nothrow-movability.
- **Storing a `function_ref`** — it is a non-owning view.
- **Trying to put a move-only closure in `std::function`** — needs `std::move_only_function` (C++23).
- **`std::thread t([&]{ … })` in a returning function** — a race even before the frame dies.
- **A lambda coroutine with captures** — the closure is destroyed at the first suspension; pass state as parameters instead.
- **Believing lambda `mutable` relates to the `mutable` member specifier** — unrelated.
- **Non-exhaustive `overloaded` visitor with an `auto&&` fallback** — silently swallows new variant alternatives.

---

## Compact Recall Summary

**Captures.** A lambda is a unique unnamed class whose captures are members. Only automatic locals are captured; globals/statics/`thread_local`s are merely referenced. `[=]`/`[&]` capture only odr-used variables; value captures snapshot at *creation*. **`[=]` in a member function captures `this`, not the object** — deprecated in C++20 in favour of `[=, this]`, with `[*this]` (C++17) for a real copy and `[m = member]` for the minimal capture. Init-capture (C++14) enables move-capture, expression capture, renaming, and — with C++20 pack expansion — variadic capture; before C++20 the tuple + `std::apply` workaround served.

**Closure type.** Public inline `operator()`, `const` unless `mutable`, defaulted copy/move if the captures allow, deleted default construction and copy assignment **except for captureless closures in C++20**, unspecified member layout, `sizeof ≥ 1` but empty (hence zero-cost via EBO) when captureless. Captureless closures convert to a plain function pointer — the basis of the `void* user_data` trampoline for C APIs; `+[]{}` forces that conversion. Distinct types for every lambda expression, so heterogeneous storage needs erasure and header lambdas carry ODR risk.

**Qualifiers.** `mutable` drops the `const` on `operator()` and only affects value captures; algorithms may copy predicates, so stateful mutable predicates are unspecified outside `for_each`. `operator()` is implicitly `constexpr` since C++17 when eligible; a `constexpr` closure *object* additionally needs literal-type captures; C++20 permits lambdas in unevaluated and constant-expression contexts, and the constexpr IILE is the idiomatic compile-time table builder.

**Genericity.** `auto` parameters (C++14) make `operator()` a template — forward with `std::forward<decltype(x)>(x)`. Explicit template parameter lists (C++20) recover the type name, same-type enforcement, NTTP/extent deduction, pack naming, and concept constraints. `overloaded : Fs... { using Fs::operator()...; }` plus generic lambdas is the standard `std::visit` visitor; `if constexpr` inside a generic lambda is the inline type switch. Deducing this (C++23) gives allocation-free recursive lambdas.

**Lifetime.** No tracking exists: captures are raw references. `[&]`/`[=]` are correct for immediately-consumed closures (algorithm predicates, scope guards) and wrong for anything stored, queued, or crossing a thread. Use `[self = shared_from_this()]` to extend, `[weak = weak_from_this()]` to cancel, values otherwise. ASan with `detect_stack_use_after_return`, `-Wdangling`, and `-Wdeprecated-this-capture` are the tooling.

**Erasure and cost.** Template parameter → fully inlined, zero cost, the hot-path default. `function_ref` (C++26) → two pointers, never allocates, non-owning, correct for call-scoped callbacks. `std::function` → 32–64 bytes with an unspecified ~16-byte inline buffer (libstdc++ also demands nothrow-movability), heap-allocates above it, requires copyable targets, and invokes via an unpredictable, non-inlinable indirect call. `std::move_only_function` (C++23) and `copyable_function` (C++26) fix the move-only and qualifier gaps. For stored callbacks on a latency-sensitive path, use a fixed-capacity `inplace_function` with a `static_assert`ed size rather than accepting per-assignment allocation.
