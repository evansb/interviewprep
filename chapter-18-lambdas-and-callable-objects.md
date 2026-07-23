# Chapter 18 — Lambdas and Callable Objects

*A lambda expression creates a closure object with a generated call operator. Reason from that object's stored state, call-operator qualifiers, and lifetime—not from the brevity of the syntax.*

---

## Why this matters in an HFT interview — Core

Lambdas are the default callable in modern C++: algorithm predicates, event callbacks, task-queue entries, and comparator template arguments. The interview problem is rarely syntax. It is whether a closure still refers to live objects when invoked, whether storing it introduces allocation or indirection, and whether a generic callable multiplies code across many instantiations.

The two failure classes must remain separate. A reference capture can dangle even when the wrapper performs no allocation. An owning capture can be lifetime-safe while `std::function` still allocates during registration. Correctness comes first; only then choose storage and dispatch.

Type erasure itself—the mechanism used to hide a concrete type—is Chapter 6's topic; this chapter only applies it to callables. Perfect forwarding inside generic lambdas is Chapter 17's topic; this chapter uses it, not re-derives it.

**Baseline:** C++23. Non-standard callable views and fixed-capacity wrappers are labeled as such.

## 90-second screen — Core

Five facts:

1. Each lambda expression has a unique unnamed closure type. Copy captures correspond to stored state; the representation of reference captures is unspecified.
2. The generated `operator()` is `const` by default. `mutable` permits mutation of stored value captures; it does not repair a dangling reference or provide synchronization.
3. `[this]` stores the pointer. `[*this]` stores a snapshot of the object. Neither automatically gives the intended asynchronous ownership policy.
4. Immediate callbacks may borrow when completion is guaranteed before the borrowed objects die. Returned, stored, queued, or cross-thread callbacks must make every captured lifetime explicit.
5. A captureless lambda can convert to a matching function pointer. Owning wrappers such as `std::function` and `std::move_only_function` add type-erased storage and indirect invocation; their inline-storage thresholds are not portable contracts.

Two decisions:

- **Capture decision:** borrow only under a synchronous completion contract; otherwise copy the needed value, transfer ownership, capture a strong/weak handle, or redesign around an ID.
- **Storage decision:** use a template when the callable type can remain static; use an owning erased wrapper for genuine runtime heterogeneity; use a measured fixed-capacity wrapper when storage must be bounded.

---

## 18.1 The closure model — Core

A lambda expression produces a closure object of a unique, unnamed, non-union class type generated at that point in the source:

```cpp
#include <utility>

auto f = [x = 1](int y) mutable noexcept -> int { return x + y; };

// A useful mental model for this copy capture:
class __lambda_N {
    int x;
public:
    explicit __lambda_N(int x_) : x(x_) {}
    int operator()(int y) noexcept { return x + y; }
};
```

This hand-written class is explanatory, not a promised transformation. A copy capture produces an unnamed non-static data member whose type follows the capture rules. For a reference capture, the implementation may or may not use a data member; the closure's size and layout remain unspecified.

| Property | Rule |
|---|---|
| `operator()` | Public and inline; `const` unless `mutable`; may be `noexcept`, constrained, templated, or have an explicit return type |
| Copy/move construction | Implicitly declared under the ordinary member rules; a move-only capture makes the closure move-only |
| Assignment/default construction | A closure with a non-empty capture list—including a capture default—has no default constructor and has deleted copy assignment; `[]` closures gain default construction and assignment in C++20 |
| Capture member order/layout | Unspecified; do not serialize, compare representations, or infer offsets |
| Object size | Nonzero as a complete object; empty-base and `[[no_unique_address]]` optimizations can eliminate storage overhead in enclosing types |
| Conversion to function pointer | Only if captureless (§18.5) |

Every lambda **expression** has its own type. Two adjacent expressions with identical text still have different types. A lambda expression inside a function template also yields a closure type dependent on that instantiation. Normal inline-definition and one-definition-rule machinery makes lambdas usable in headers; do not invent a per-translation-unit mismatch rule. The practical consequence is simpler: use `auto` or `decltype(expression)` locally, and use a named function object when a public API needs a stable, readable type.

The C++20 default-constructibility and copy-assignability of captureless closures unlock using a lambda directly as a comparator type:

```cpp
#include <set>

using Descending =
    decltype([](int a, int b) noexcept { return a > b; });

std::set<int, Descending> values;
```

A container implementation can exploit empty-base or no-unique-address storage for a stateless comparator. Inlining is an optimizer decision, but preserving the concrete comparator type gives the optimizer direct visibility that erased `std::function` does not normally provide.

### Function objects and callable concepts

A **function object** is any object usable with call syntax, usually because its type defines `operator()`. A lambda creates one kind of function object; a named class is often better when behavior needs documentation, multiple constructors, shared use, or a stable API name.

```cpp
#include <concepts>
#include <functional>
#include <utility>

struct Above {
    int threshold;
    constexpr bool operator()(int value) const noexcept {
        return value > threshold;
    }
};

template <class F>
requires std::predicate<F&, int>
constexpr bool any_of_three(F&& pred) {
    return std::invoke(pred, 1) ||
           std::invoke(pred, 2) ||
           std::invoke(pred, 3);
}

static_assert(any_of_three(Above{2}));
```

`std::invocable<F, Args...>` checks whether `std::invoke` can form the call. `std::regular_invocable` adds a semantic expectation that invocation is equality-preserving and does not modify the function object or arguments; the compiler cannot verify that semantic promise. `std::predicate` additionally requires a Boolean-testable result. Concepts improve diagnostics and state intent, but they do not guarantee `noexcept`, thread safety, allocation behavior, or lifetime.

`std::invoke` unifies ordinary function objects, function pointers, and pointers to members. Overload-resolution fundamentals belong to Chapter 4; the interview point here is that a generic callable API should constrain the operation it performs rather than require a particular callable spelling.

| Callable form | Carries state | Static type visible at call | Ownership/lifetime | Typical trade-off |
|---|---:|---:|---|---|
| Named function object | In object members | Yes | Value semantics chosen by the class | Clear reusable type; can inline; may add template instantiations |
| Lambda closure | In captures | Yes unless erased | Closure owns copy captures and borrows reference captures | Local and concise; unnamed type |
| Function pointer | No context beyond code address | Signature visible, target often runtime | Does not own external state | C-compatible; indirect unless optimized through |
| `std::reference_wrapper<F>` | Refers to external `F` | Wrapper type visible | Non-owning | Copyable reference semantics; can dangle |
| `std::function<Sig>` | Yes, erased | No concrete target type | Owns a copyable target | Uniform copyable storage; possible allocation and indirection |
| `std::move_only_function<Sig>` | Yes, erased | No concrete target type | Owns a movable target | Supports move-only captures; possible allocation and indirection |

---

## 18.2 Capture modes and init-capture — Core

```cpp
void capture_examples() {
    int a = 1;
    int b = 2;
    auto f1 = []         { return 0; };
    auto f2 = [a]        { return a; };
    auto f3 = [&b]       { b = 3; };
    auto f4 = [=]        { return a + b; };
    auto f5 = [&]        { a = b; };
    auto f6 = [=, &b]    { return a + b; };
    auto f7 = [&, a]     { return a + b; };

    f3();
    f5();
    (void)f1; (void)f2; (void)f4; (void)f6; (void)f7;
}
```

Rules that matter:

- **Only automatic-storage-duration variables of the enclosing function can be captured.** Globals, `static` locals, and `thread_local`s are referenced directly, not captured — `[=]` does not make a shared `static` counter thread-safe, because every closure still refers to the same object.
- **A capture default does not eagerly copy the entire scope.** An entity is implicitly captured when the lambda body requires capture under the language rules. “Only what the body uses” is a sound working model; details involving dependent expressions, discarded statements, and constant expressions belong to language-lawyer reference material, not closure-layout prediction by inspection.
- **Value capture copies at closure creation, not at call.** Mutating `a` afterward does not change what `f2` returns.
- **Reference-capture representation is unspecified.** The standard does not require a reference member to be implemented as a pointer; treat it as an opaque reference with pointer-like lifetime risk, not literally a pointer you can reason about at the ABI level.
- **Capture syntax does not change the source object's lifetime.** `[&x]` does not retain `x`; `[p = raw_pointer]` copies the pointer, not the pointee; `[view = span]` copies a view, not its backing storage.
- With a `=` default, an additional named variable capture must use `&`; C++20 also permits explicit `this`. Thus `[=, &x]` and `[=, this]` are valid, while `[=, x]` is redundant and ill-formed. With a `&` default, a named exception is captured by value, so `[&, x]` is valid and `[&, &x]` is ill-formed.
- C++20 permits capturing structured bindings. Their lifetime consequences follow what they name: copying the bound value differs from retaining a reference to an element.

```cpp
struct Counter {
    int value{};
    auto reader() {
        return [=, this] { return value; };
    }
};
```

### Init-capture (C++14)

Init-capture declares a new closure member with its own initializer, decoupled from any enclosing variable's name:

```cpp
#include <memory>
#include <utility>

auto make_reader(std::unique_ptr<int> p) {
    return [owned = std::move(p)] { return *owned; };
}

auto make_counter(int initial) {
    return [n = initial]() mutable { return n++; };
}
```

`auto`-style deduction applies to a value init-capture, so `[n = some_const_reference]` normally produces a plain value member. A reference init-capture such as `[&r = object.member]` continues to borrow the referenced subobject and is safe only while that subobject exists at the same address.

Init-capture is how a closure takes ownership of a move-only object or stores a computed result under a useful name. Evaluation occurs when the closure is created. If creating the closure happens per event, the initializer's construction, allocation, and reference-count costs also happen per event.

C++20 permits pack expansion in init-capture:

```cpp
#include <tuple>
#include <utility>

template <class... Args>
auto bind_all(Args&&... args) {
    return [...xs = std::forward<Args>(args)]() mutable {
        return std::tuple{std::move(xs)...};
    };
}
```
The forwarding mechanism is owned by Chapter 17. Here the important consequence is storage: each expanded `xs` is state inside the closure.

A move-captured member is observed through a `const operator()` unless the lambda is `mutable`, so moving from or resetting that member normally requires `mutable`. A lambda that owns a `unique_ptr` is move-only and cannot be stored as a `std::function` target; C++23's `std::move_only_function` is the standard owning wrapper for that signature when the deployment library implements it. Check `__cpp_lib_move_only_function` in toolchains that predate complete C++23 library support.

### Capture cost is object cost

A lambda expression by itself performs no hidden allocation. Its closure contains stored captures, subject to ordinary object layout and padding. Capturing a `std::string` by value copies or moves a string; that operation may allocate according to the string's state. Capturing a `shared_ptr` changes a reference count. Capturing an `array<char, 64>` copies 64 characters into the closure. The allocation belongs to the captured type or later wrapper, not to “lambda syntax.”

```text
[seq, symbol = std::move(name), &stats]
┌──────────────── closure object ────────────────┐
│ seq value │ owned std::string │ borrowed stats │
└────────────────────────────────────────────────┘
   copy          move/copy cost       lifetime risk

Exact offsets, padding, and reference representation are unspecified.
```

Measure `sizeof(closure)` only as a target-specific observation. The more durable question is which resources each capture owns, borrows, or shares.

---

## 18.3 Capturing `this` and lifetime — Core

```cpp
struct Session {
    int timeout;
    auto check_by_pointer() {
        return [this] { return timeout > 0; };
    }
    auto check_by_copy() {
        return [*this] { return timeout > 0; };
    }
    auto check_by_member() {
        return [t = timeout] { return t > 0; };
    }
};
```

`[this]` stores the pointer, not the object. An implicit member access under `[=]` also captures that pointer; C++20 deprecates this implicit `[=]` spelling because it looks like an independent copy. `[&]` can also capture `this` implicitly, but the pointer is still captured by value—the `&` does not turn it into a reference-to-pointer capture.

Every later member access goes through the stored pointer. If the original object dies before invocation, the closure dangles. If another thread mutates the live object without synchronization, keeping it alive does not prevent a data race.

Write `[this]` or `[=, this]` when pointer semantics are intentional. A warning for deprecated implicit `this` capture can catch the `[=]` spelling, but it cannot decide whether the object's lifetime is adequate.

### `[*this]` (C++17)

Captures a copy of the whole object as a closure member; the closure becomes self-contained.

| | `[this]` / `[=, this]` | `[*this]` |
|---|---|---|
| Stored | pointer | full copy of `*this` |
| Dangles when object dies | Yes | No |
| Sees later mutations of the original | Yes | No — snapshot at creation |
| Const-ness of the copy | n/a | const **iff the enclosing member function is const**, regardless of whether the lambda is `mutable` |

In a `const` member function, the captured object is const; `mutable` removes the closure call operator's implicit const qualification but cannot remove const from the captured object. In a non-const member function, a mutable lambda can modify its private snapshot. Neither case modifies the original.

`[*this]` is not a general asynchronous fix. Copying a large object adds work and produces snapshot semantics. Copying an object that contains raw pointers still copies those pointers, so transitive pointees can dangle. For an object managed by `shared_ptr`, `[self = shared_from_this()]` keeps the same object alive; `[weak = weak_from_this()]` plus `lock()` avoids extending lifetime and permits cancellation when the object is gone. Chapter 9 owns the smart-pointer contracts, including the precondition that `shared_from_this()` has an established shared owner.

An explicit object parameter (C++23) lets a lambda recurse without erasure:

```cpp
auto fib = [](this auto&& self, int n) -> int {
    return n < 2 ? n : self(n - 1) + self(n - 2);
};
```
This removes the need to capture a wrapper merely for recursion. It does not imply that an alternative `std::function` formulation must allocate; wrapper storage remains implementation-dependent.

### The stored-vs-immediate checklist

The chapter's one governing rule:

- **An immediate callback may borrow.** If the receiving API guarantees all invocations finish before it returns, the creating frame outlives invocation. Ordinary standard algorithms have that completion shape. With parallel execution, lifetime may still be adequate while unsynchronized access remains a data race.
- **A stored or cross-thread callback must make lifetime explicit.** If the closure is queued, handed to another thread, or returned, capture values, ownership, or a weak handle with a liveness check. Thread bodies, timers, I/O callbacks, and continuations are stored unless their API explicitly proves otherwise.
- Ask, for every capture: does this closure's lifetime end before or after the thing it references? If you cannot answer confidently, it does not go by reference.

Before accepting a callback API, write down the contract:

| Question | Why it changes capture design |
|---|---|
| Can the receiver retain or copy the callable? | A call-scoped borrow may become an escaping reference |
| Can invocation begin after the registering call returns? | Locals and by-value parameters from that frame are gone |
| Can callbacks overlap or run concurrently? | Mutable captures and referenced objects need synchronization |
| How is cancellation acknowledged? | Destroying the owner is unsafe until in-flight invocation is excluded |
| Which thread destroys captured owners? | Destructors can perform reclamation or release the last shared reference on a latency-sensitive thread |
| Does the receiver move its stored entries? | A C `void*` pointing at an entry can become invalid even though the entry's value remains alive |
| What happens on queue rejection? | Moved captures may already have transferred ownership; retry semantics must be explicit |

“Asynchronous” is not the only danger word. A synchronous API that stores the callable for a later phase is an escaping API; a worker API that joins before returning can permit borrowing, subject to data-race rules.

### Dangling-capture failure trace

```text
producer frame          task queue                 worker
──────────────          ──────────                 ──────
int sequence = 42
enqueue([&sequence]) ──► stores closure
return; sequence dies
                                                  pop closure
                                                  read sequence → undefined behavior
```

The queue may correctly own the closure while the closure incorrectly borrows its state. Copying the `std::function` or moving the task does not repair that inner reference.

| Symptom | Violated invariant | Detection | Repair |
|---|---|---|---|
| Intermittent wrong ID after queue delay | Captured local died before invocation | Delay/stress test; compiler lifetime warning where available | Capture ID by value |
| ASan stack-use-after-return | Closure dereferenced a dead frame | ASan with stack-use-after-return support | Copy/own the needed state |
| Callback accesses freed session | Stored `this` outlived object | Object-destruction race test; ASan may help | Strong owner, weak lock, or cancellation/join |
| Correct address but wrong packet bytes | Buffer stayed allocated but was reused | Generation counters and ownership assertions | Retain slot or copy retained fields |
| Race report on live object | Lifetime was valid; synchronization was not | ThreadSanitizer and review | Immutable snapshot, lock, atomics, or confinement |

Common bug shapes:

```cpp
#include <functional>

std::function<int()> bad_factory() {
    int x = 42;
    return [&x] { return x; }; // x dies on return
}

std::function<int()> good_factory() {
    int x = 42;
    return [x] { return x; };
}
```

Build the bad version under AddressSanitizer and invoke the result only as a diagnostic exercise. A report is likely on supported configurations, not guaranteed for every stale capture. Buffer reuse can remain entirely inside live storage and evade ASan.

`std::bind` has the same ownership questions: bound ordinary arguments are stored by decay-copy, while `std::ref` deliberately stores reference semantics. Lambdas usually make that decision more visible.

---

## 18.4 `mutable` and generic lambdas — Core

`operator()` is `const` by default, so a by-value capture is read-only inside the body. `mutable` removes that:

```cpp
auto counter = [n = 0]() mutable { return n++; };
const int first = counter();
const int second = counter(); // 0, then 1
auto copy = counter;
const int copy_value = copy(); // copy has independent state
```

- `mutable` affects only value captures; `[&x]{ x = 1; }` needs no `mutable` because `x` itself is not a closure member.
- A `mutable` lambda cannot be invoked through a `const` closure or `const F&` because its call operator is non-const.
- `mutable` says nothing about thread safety. Concurrent calls that mutate one closure object require synchronization.
- Standard algorithms generally receive function objects by value and may copy them. Do not observe accumulated predicate state from the original object or assume all calls use one physical copy. A state-changing predicate can also violate the semantic stability expected by predicate concepts. `std::for_each` is the deliberate exception for accumulation: it returns its function object after applying it, so inspect the returned object.
- `mutable` the lambda qualifier and `mutable` the class-member specifier share a keyword and nothing else.

Moving a captured owner out makes a closure naturally single-use:

```cpp
#include <memory>

auto make_consumer(std::unique_ptr<int> value) {
    return [p = std::move(value)]() mutable {
        return std::move(p);
    };
}
```

The first call transfers the pointer; later calls return an empty `unique_ptr`. Encode or document such state transitions instead of presenting the callable as a reusable predicate.

### Generic lambdas (C++14) and template parameter lists (C++20)

```cpp
auto plus = [](auto a, auto b) { return a + b; };

auto same_type_max = []<class T>(T a, T b) {
    return a < b ? b : a;
};

auto positive = []<class T>(T value)
    requires requires { value > 0; }
{
    return value > 0;
};
```
Each `auto` parameter invents a template parameter for `operator()`. C++20's explicit template parameter list lets the lambda name and constrain those types or require two parameters to have the same type. Chapter 17 owns deduction and constraints.

A forwarding generic lambda uses `decltype(parameter)` because the invented template parameter has no source-level name:

```cpp
#include <utility>

auto call_once = []<class F, class Arg>(F&& f, Arg&& arg)
    -> decltype(auto)
{
    return std::forward<F>(f)(std::forward<Arg>(arg));
};
```

This example is intentionally small; `std::invoke` is needed for the full family of pointer-to-member callables.

The standard `std::variant` visitor idiom often uses an overload helper:

```cpp
#include <variant>

template <class... Fs>
struct overloaded : Fs... {
    using Fs::operator()...;
};

struct Add { int quantity; };
struct Cancel { int quantity; };
struct Heartbeat {};

struct Book {
    void add(const Add&);
    void cancel(const Cancel&);
};

using Message = std::variant<Add, Cancel, Heartbeat>;

void dispatch(Book& book, const Message& message) {
    std::visit(overloaded{
        [&](const Add& add) { book.add(add); },
        [&](const Cancel& cancel) { book.cancel(cancel); },
        [](const Heartbeat&) {}
    }, message);
}
```
An `auto&&` fallback would silently absorb newly added alternatives; explicit alternatives make missed message types fail during compilation.

Each distinct argument-type combination can instantiate another call-operator specialization. The optimizer may merge identical generated code, but broad generic use can increase compile time, instruction-cache footprint, and binary size. Confirm with object-size reports, linker maps, or compiler time traces rather than assuming generic syntax is free.

---

## 18.5 Captureless conversion and the C bridge — Core / Role-specific

A lambda with an empty capture list has a conversion to a matching function pointer:

```cpp
#include <csignal>

volatile std::sig_atomic_t stop_requested = 0;

int main() {
    auto twice = [](int x) noexcept { return x * 2; };
    int (*fp)(int) noexcept = twice;
    std::signal(SIGINT, [](int) { stop_requested = 1; });
    return fp(3) == 6 ? 0 : 1;
}
```

A function pointer has no context slot for captured state. The empty capture list matters syntactically: `[=] { return 1; }` has a capture default and does not gain this conversion even if it happens to capture no entity. A `noexcept` call operator can convert to a pointer-to-`noexcept` function. A captureless generic lambda has a conversion-function template and can convert when the destination function-pointer signature selects a valid specialization:

```cpp
auto identity = [](auto value) { return value; };
int (*int_identity)(int) = identity;
double (*double_identity)(double) = identity;
```

C++23 permits `static` on a captureless lambda's call operator:

```cpp
auto add_one = [](int x) static noexcept { return x + 1; };
```

Conversion produces callable behavior equivalent to invoking a default-constructed closure. It does not retain a particular closure object's address or state.

### The C-callback bridge

Many C callback APIs pair a function pointer with `void*` user data. The function pointer is the **trampoline**; user data carries state:

```cpp
#include <utility>

using CCallback = void (*)(void*);
void c_register(CCallback callback, void* context);

template <class F>
struct CallbackContext {
    F callable;
    static void invoke(void* raw) {
        auto* self = static_cast<CallbackContext*>(raw);
        self->callable();
    }
};

template <class F>
void register_context(CallbackContext<F>& context) {
    c_register(&CallbackContext<F>::invoke, &context);
}
```

The API stores `&context`, so the caller must keep that exact object alive and at a stable address until unregistration and until all in-flight callbacks finish. Moving a containing vector can invalidate the context even if the callable itself is safely movable. Stable owner objects, nodes, or explicitly managed registration storage solve that address-stability problem.

### Why a function-local static is not per registration

A tempting adapter initializes a function-local static from the first callable:

```cpp
#include <utility>

template <class F>
void invoke_bad(F&& f) {
    static auto stored = std::forward<F>(f);
    stored();
}

void arm(int id) {
    invoke_bad([id] { (void)id; });
}
```

The lambda expression in `arm` has the same closure type on every call, so the template specialization and its static object are also the same. `arm(1)` initializes `stored`; later calls do not replace its captured ID. This is a storage-duration error, not type erasure. Store context per registration and give the callback API a pointer to that context.

**The unary `+` trick.** `+[]{ … }` forces the function-pointer conversion (unary `+` requires an arithmetic/pointer operand, and the closure's only such conversion is to a function pointer). It is needed to give two lambdas in a ternary a common type:

```cpp
int select(bool first) {
    auto p = first ? +[]{ return 1; } : +[]{ return 2; };
    return p();
}
```

The source-level function-pointer call is indirect when the target value is only known at run time. If constant propagation, whole-program optimization, or profile information proves the target, an optimizer may devirtualize and inline it. Keeping a concrete callable type makes that optimization easier and avoids requiring it for direct dispatch.

---

## 18.6 Callable wrapper ownership and cost — Core

A closure has a unique type. When one variable must hold different callable types behind one signature, the program needs a closed sum such as `variant` or type erasure. Chapter 6 owns the erasure mechanism; this section chooses storage.

```cpp
#include <functional>

std::function<int(int)> transform =
    [offset = 7](int value) { return value + offset; };
```

### What the standard actually guarantees

`std::function` owns a copyable target. Its construction does not allocate when the target is a function pointer or `std::reference_wrapper`; implementations ordinarily provide inline storage for other small targets, but the standard exposes no capacity, alignment, or “fits inline” query. For a lambda target, allocation behavior is implementation-dependent even when `sizeof(lambda)` looks small.

Size is not the only condition an implementation may use. Alignment and whether a target can be relocated without throwing can affect inline-storage eligibility. Never derive a portable crossover from `sizeof(std::function)` or from one vendor's threshold.

### The wrappers

| Type | Since | Owns? | Copyable | Allocation | Notes |
|---|---|---|---|---|---|
| `std::function<R(A...)>` | C++11 | Yes | wrapper and target are copyable | Inline or dynamic; only limited targets have a no-allocation guarantee | Empty invocation throws `bad_function_call` |
| `std::move_only_function<Sig>` | C++23 | Yes | Move-only | Inline or dynamic; no portable inline threshold | Accepts move-only targets; signature can express cv/ref and `noexcept`; invoking an empty wrapper is undefined |
| Library-specific `function_ref<Sig>`-style view | Non-standard in C++23 | No | Usually cheap to copy | The view itself needs no target allocation | Borrowed callable; store only if external lifetime is proved |
| Fixed-capacity `inplace_function<Sig, N>`-style wrapper | Non-standard in C++23 | Usually yes | Design choice | No heap fallback when designed strictly | Rejects targets exceeding size/alignment/policy |
| Template parameter `F` | Language mechanism | Determined by caller/API | Determined by use | The abstraction itself adds no allocation | Concrete type visible; can increase instantiations and code size |

`std::move_only_function` is not merely “`std::function` without copying.” Qualifiers in its signature constrain invocation. For example, `std::move_only_function<void() &&>` represents a callable intended to be invoked on an rvalue wrapper, which can express consumption. Its empty-call precondition also differs from `std::function`; check before calling if emptiness is possible.

### Cost of invoking through erasure

An erased wrapper ordinarily invokes a thunk through an indirect function pointer. When the target is not proven, this blocks cross-boundary inlining and can create a branch-prediction problem if one call site sees many targets. Dynamically stored state can add pointer chasing and less-local memory. Optimizers can sometimes devirtualize when construction and use are visible, so “erasure always prevents inlining” is too strong.

Construction, copy, move, assignment, and destruction have separate costs from invocation. A system that constructs handlers once and calls them millions of times has a different bottleneck from a task queue that creates and destroys a wrapper per task. Measure:

- allocation count and bytes during wrapper construction/assignment;
- target distribution at each call site, not globally;
- typical and tail invocation latency with realistic cache state;
- binary size and instruction-cache behavior for the template alternative;
- destruction and reclamation on the thread where they actually occur.

### The low-latency prescription

1. **Concrete template parameter:** choose when the caller's type can remain part of the API and code-size multiplication is acceptable.
2. **Borrowed callable view:** choose only under a call-scoped completion contract. The view's non-allocation property does not make storing it safe.
3. **Fixed-capacity owning wrapper:** choose when runtime heterogeneity is required and a hard storage bound is part of the design. Reject excess size, alignment, or throwing-move policy explicitly.
4. **`std::function`:** choose for copyable, owning, heterogeneous callbacks when implementation-dependent allocation is acceptable or measured away.
5. **`std::move_only_function`:** choose for owning task/callback slots that transfer move-only state. Do not introduce `shared_ptr` solely to make a target copyable without considering the changed lifetime and atomic reference-count traffic.

### Small-object optimization: how to verify, not guess

The following closure sizes are valid only as observations on the build that prints them:

```cpp
#include <array>
#include <cstddef>

void observe_sizes() {
    auto empty = [] {};
    auto one = [x = 1] { return x; };
    auto larger = [data = std::array<std::byte, 64>{}] {
        return data.size();
    };

    static_assert(sizeof(empty) >= 1);
    (void)sizeof(one);
    (void)sizeof(larger);
}
```

To test wrapper allocation, intercept allocations only in a controlled test or use a test allocator/instrumented global allocation setup that accounts for startup and unrelated library work. Construct targets on both sides of observed thresholds, include over-aligned and non-trivially movable targets, and repeat for copy, move, and assignment. Do not infer a production guarantee from the result; pin it as a tested property of the selected standard-library build.

---

## Worked reasoning: queued work and handler storage — Core

Consider a feed callback that parses a packet in a ring slot and queues strategy work:

```cpp
#include <string_view>
#include <utility>

struct PacketView {
    int sequence() const;
    std::string_view symbol() const;
};

struct StrategyRef {
    void on_update(int, std::string_view);
};

struct QueueRef {
    template <class F>
    void push(F&&) {} // stand-in for a queue that stores the callable
};

extern StrategyRef strategy;
extern QueueRef queue;

void on_packet(PacketView packet) {
    int sequence = packet.sequence();
    queue.push([&] {
        strategy.on_update(sequence, packet.symbol());
    });
}
```

Assume `queue.push` stores the closure and returns before a worker invokes it. The code has two distinct dangling paths:

1. `sequence` belongs to the callback frame and dies on return.
2. `packet` is a view of the ring slot. Even if the view object were copied, its backing bytes can be reused for the next packet.

Changing the queue's slot from `std::function` to a fixed-capacity wrapper would remove possible wrapper allocation but preserve both bugs. The capture contract must be repaired first.

### Step 1: decide what crosses the boundary

`sequence` is small and immutable, so copy it. If the strategy needs only a resolved instrument ID, resolve synchronously and copy the ID rather than retaining symbol text. If text must cross the queue, copy it into bounded owned storage or retain ownership of the packet block.

```text
receive thread                     worker thread
──────────────                     ─────────────
ring slot owns packet bytes
parse sequence ──value copy────────────► task.sequence
resolve symbol ──integer ID─────────────► task.instrument
return / reuse ring slot
                                      invoke task using owned values
```

A value-only task can be expressed as a closure without hidden borrowing:

```cpp
#include <cstdint>
#include <functional>

struct Strategy {
    void on_update(std::uint64_t sequence, std::uint32_t instrument);
};

std::function<void()> make_task(
    Strategy& strategy,
    std::uint64_t sequence,
    std::uint32_t instrument)
{
    return [&strategy, sequence, instrument] {
        strategy.on_update(sequence, instrument);
    };
}
```

This is still correct only if `strategy` outlives every queued task. That may be a valid architectural invariant—for example, workers are joined and the queue drained before strategies are destroyed—but it must be stated and enforced. If dynamic strategy removal is allowed, capture a strong owner, a weak handle with a check, or an immutable strategy ID resolved by the worker.

### Step 2: choose the lifetime policy for `this`

For a `shared_ptr`-managed strategy, a weak capture gives cancellation semantics:

```cpp
#include <cstdint>
#include <functional>
#include <memory>

class Strategy : public std::enable_shared_from_this<Strategy> {
public:
    std::function<void()> task(std::uint64_t sequence) {
        return [weak = weak_from_this(), sequence] {
            if (auto self = weak.lock()) {
                self->on_sequence(sequence);
            }
        };
    }

private:
    void on_sequence(std::uint64_t);
};
```

The weak policy prevents a task from extending strategy lifetime, but `lock()` performs shared-ownership synchronization and adds a branch per invocation. A strong capture avoids cancellation while extending lifetime and changing destruction timing. A raw `this` capture avoids ownership traffic but requires a quiescence protocol. Choose semantics first, then measure their mechanisms.

| Policy | When object dies | Per-call mechanism | Operational requirement |
|---|---|---|---|
| `[this]` | External owner decides | Pointer dereference | Unregister, drain, and join before destruction |
| `[self = shared_from_this()]` | After last task/owner releases it | Reference-count operations on task copy/destruction | Cycles must be prevented |
| `[weak = weak_from_this()]` | Independent of queued tasks | `lock()` plus branch and temporary strong count | Expired callback policy |
| `[snapshot = *this]` | Snapshot dies with task | Object copy/move | Snapshot semantics must be correct; transitive pointers audited |
| `[id]` and registry lookup | Registry policy | Lookup plus missing-ID branch | Stable identity and concurrency-safe registry |

### Step 3: choose callable storage

Now suppose a dispatcher stores heterogeneous handlers registered during startup:

```cpp
#include <cstddef>
#include <cstdint>
#include <functional>
#include <utility>
#include <vector>

struct BookEvent {
    std::uint32_t instrument{};
};

using Handler = std::function<void(const BookEvent&)>;

class Dispatcher {
    std::vector<Handler> handlers_;

public:
    void reserve(std::size_t count) { handlers_.reserve(count); }
    void add(Handler handler) {
        handlers_.push_back(std::move(handler));
    }
    void dispatch(const BookEvent& event) {
        for (auto& handler : handlers_) {
            handler(event);
        }
    }
};
```

Registration can allocate in both the vector and individual wrappers. Reserving the vector controls only vector growth, not target storage inside each handler. If registration occurs before latency-sensitive processing and no later mutation is allowed, those allocations may be acceptable; invocation still pays erased dispatch. Replace `std::function` with `std::move_only_function` when handlers need move-only ownership rather than copyability; the storage threshold remains non-portable.

Three alternatives answer different workload facts:

- If the handler set is fixed at compile time, store named function objects in a tuple and dispatch statically. This improves optimizer visibility but instantiates code for each handler/type and complicates runtime reconfiguration.
- If handlers vary at startup but have a proven size/alignment bound, use a fixed-capacity move-only wrapper with no heap fallback. This keeps runtime heterogeneity and bounds storage while retaining indirect dispatch.
- If handlers can be arbitrarily large or plugins define them, `move_only_function` provides general ownership. Move allocation and destruction outside the critical phase where possible.

There is no universal ordering among these designs. A statically dispatched bank of many large handlers can harm instruction-cache locality more than one indirect call. Conversely, a call site cycling unpredictably among many erased targets can mispredict. Benchmark the actual number of handlers, target distribution, capture sizes, update frequency, and build configuration.

### Step 4: prove the storage policy

For a strict fixed-capacity wrapper, the acceptance condition should resemble:

```cpp
#include <cstddef>
#include <type_traits>

template <class F, std::size_t Capacity,
          std::size_t Alignment>
concept InlineStorable =
    sizeof(F) <= Capacity &&
    alignof(F) <= Alignment &&
    std::is_nothrow_move_constructible_v<F>;
```

The exact policy is a design choice. Requiring nothrow move simplifies exception safety when the wrapper itself moves. A copyable wrapper needs a clone thunk and must decide what copy failures mean. A heap fallback violates a hard no-allocation contract, so reject an oversized callable at compile time instead.

Validate the finished system at two levels:

1. Unit tests exercise destruction, move, empty state, over-aligned rejection, throwing targets, and every lifetime policy.
2. Workload tests count allocations during registration and steady state, then measure dispatch latency and binary/code-cache effects with the production handler mix.

---

## 18.7 `constexpr` lambdas — Deep dive

A lambda's call operator is implicitly `constexpr` when it satisfies the requirements of a constexpr function. Writing `constexpr` explicitly makes failure to meet those requirements a compile-time error.

```cpp
constexpr auto square = [](int n) { return n * n; };
static_assert(square(4) == 16);

constexpr auto cube =
    [](int n) constexpr { return n * n * n; };
static_assert(cube(3) == 27);
```

Three separate declarations are easy to conflate:

| Placement | Meaning |
|---|---|
| `constexpr auto f = [] { … };` | The closure object is a constant expression |
| `[]() constexpr { … }` | The call operator is eligible for constant evaluation |
| `[]() consteval { … }` | Every potentially evaluated call is immediate and must produce a constant expression |

For a captured closure object to be a constant expression, its captured subobjects and initializers must satisfy constant-expression rules. Capturing a runtime local by value remains legal for runtime use; it does not turn that value into a compile-time constant.

An immediately invoked lambda can build a table with ordinary control flow:

```cpp
#include <array>
#include <cstdint>

constexpr auto kLut = [] {
    std::array<std::uint8_t, 256> table{};
    for (std::size_t i = 0; i < table.size(); ++i) {
        table[i] = static_cast<std::uint8_t>(i);
    }
    return table;
}();

static_assert(kLut[42] == 42);
```

Constant evaluation establishes the table without dynamic initialization. Whether the emitted program places bytes in read-only data, folds accesses into instructions, or emits no storage is an implementation decision.

---

## Recall card — Core

1. Each lambda expression creates a unique closure type. Copy captures store values; reference-capture representation is unspecified but its lifetime risk is real.
2. `operator()` is `const` unless `mutable`; mutability does not repair lifetime, synchronization, or ownership.
3. `[this]` stores a pointer. `[*this]` stores a snapshot; transitive raw pointers inside that snapshot can still dangle.
4. Immediate callbacks may borrow only under a completion guarantee. Stored, returned, queued, and cross-thread callbacks need explicit lifetime policy per capture.
5. A lambda expression itself does not allocate. Captured types and owning wrappers can allocate during closure construction or storage.
6. An empty capture list enables conversion to a matching function pointer; a `void*` context carries state across a C callback boundary.
7. Algorithms can copy function objects. Do not use an original mutable predicate as a reliable record of accumulated calls.
8. `std::function` owns a copyable target; `move_only_function` owns movable targets. Both erase type and may use dynamic storage for ordinary lambdas.
9. A template preserves concrete type and optimizer visibility but may multiply code. Erasure centralizes code and runtime storage but adds indirect dispatch.
10. Fixed-capacity wrappers need explicit size, alignment, move/copy, overflow, empty-state, and exception policies.

## Questions — Core

1. For `[id, &book, p = std::move(owner)]`, classify each stored relationship and state the proof required before queued invocation.
2. Why does `[=]` inside a member function not copy the object, and how do `[this]`, `[*this]`, and `[value = member]` differ?
3. A live object is captured by pointer and used on another thread. Why is lifetime proof insufficient for correctness?
4. When can a mutable algorithm predicate produce misleading accumulated state even though every input result is correct?
5. Why does `[] {}` convert to a function pointer while `[=] {}` does not, even if the second closure captures no entity?
6. A C API stores both callback and `void*`. Which object must own the context, and which operations can invalidate its address?
7. Compare a template parameter, borrowed callable view, fixed-capacity wrapper, and `std::function` for a call-scoped callback and a stored callback.
8. Why is `sizeof(lambda) <= N` alone insufficient to prove acceptance by a fixed-capacity wrapper?
9. Under what shutdown protocol can a queued `[this]` capture be safer and cheaper than a `shared_ptr` capture?
10. Which measurements distinguish template code-size cost from erased-dispatch and wrapper-allocation cost?

## Common traps — Core

| Trap | Failed reasoning | Repair |
|---|---|---|
| `[=]` means self-contained | Member access captures the `this` pointer | Capture selected member values, an object snapshot, or an ownership handle |
| Copying a view capture owns bytes | The closure copies only pointer/count metadata | Copy required payload or retain its owner |
| Queue owns the closure, so captures are safe | Outer storage ownership does not extend borrowed inner objects | Audit every capture independently |
| `mutable` makes a captured object non-const | It removes const from `operator()`, not from referenced objects or a const `*this` snapshot | Reason about each captured type's own cv-qualification |
| Small closure guarantees wrapper SBO | Threshold, alignment, and relocation policy are implementation-specific | Measure the chosen library or use a strict fixed-capacity wrapper |
| Reserving a vector prevents handler allocation | It controls vector storage, not erased target storage | Instrument wrapper construction separately |
| Captureless function-pointer conversion is direct dispatch | Runtime function-pointer targets are ordinarily indirect | Keep concrete type where static dispatch matters; measure devirtualization |
| Weak capture is “free safety” | `lock()` and shared-count operations have cost and cancellation semantics | Choose it for semantics, then measure |
| Generic lambda is one function | Each argument combination can instantiate another specialization | Inspect compile-time traces, symbols, and binary size |
| Inline buffer aligned as `max_align_t` accepts everything | User types can be over-aligned | Reject excessive alignment or parameterize supported alignment |

## Code-reading puzzle — Core

```cpp
#include <cstdio>
#include <utility>

void log(int id) {
    std::printf("%d\n", id);
}

template <class F>
void register_cb(F&& f) {
    static auto stored = std::forward<F>(f);
    stored();
}

void arm(int id) {
    register_cb([id] { log(id); });
}

int main() {
    arm(1);
    arm(2);
    arm(3);
}
```
Predict the three lines. Then suppose a second function contains a different lambda expression passed to `register_cb`: explain why it gets another static object yet repeats the same first-registration-wins defect for that closure type. Redesign the registration around one stable context object per active callback.

## Implementation / design exercise — Core

Design a fixed-capacity callable wrapper, `inline_function<Sig, Capacity>`, usable as a member of a hot-path struct with no heap allocation ever:

- Store the callable in an in-place buffer of `Capacity` bytes with a matching alignment; `static_assert` at the call site that a given callable fits.
- Provide a small function-pointer/thunk table (construct-from, invoke, move, destroy) so the wrapper does not need RTTI or `std::function`'s allocator path.
- Decide and justify move-only versus copyable, empty-call behavior, supported alignment, nothrow-move requirements, and const/ref-qualified invocation.
- Reject a target that does not fit at compile time; do not silently add a heap fallback to a hard bounded-storage type.
- Test move construction and destruction with a non-trivial target, reject an over-aligned target, and use an allocation counter to confirm no wrapper allocation during construction and invocation.
- Compare generated size and steady-state invocation against `std::move_only_function` for a representative mixture of targets; do not optimize only an empty lambda.

## Prerequisites for the next chapter — Core

Chapter 19 assumes the value-category and lifetime model from Chapters 4–5, move/copy behavior from Chapter 10, and this chapter's distinction between owning and borrowing closure state. It applies the same lifetime vocabulary to range-for temporaries, explicit object parameters, and coroutine frames.
