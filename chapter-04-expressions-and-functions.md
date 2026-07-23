# Chapter 4 — Expressions and Functions

Expressions are where C++’s type system, lifetime rules, and optimizer contract meet. A single line may perform conversions, create a temporary, mutate an object, and select one function from dozens of candidates. If any two of those events are ordered incorrectly—or not ordered at all—the result can change between builds or become undefined.

For a low-latency engineer, this is not language-lawyer decoration. Value categories decide whether a call copies, moves, or constructs directly in place. Lookup and overload resolution decide whether a hot call is visible to the optimizer. Undefined behavior lets the optimizer discard paths that source-level intuition says should execute. The calling convention then determines which source-level abstractions survive at a non-inlined binary boundary.

This chapter builds three decision procedures:

1. classify and sequence an expression before predicting its result;
2. perform lookup, viability checking, and overload ranking before naming the called function;
3. separate standard C++ call semantics from compiler, ABI, and processor costs.

**Prerequisites:** Chapter 2’s conversions and `decltype`; Chapter 3’s object representation. Chapter 5 owns the full object-lifetime model.

## 90-second screen

- Every expression has a type and a value category. A named variable expression is an lvalue even when the variable’s declared type is `T&&`.
- Precedence and associativity determine parsing, not runtime order. `f() + g()` does not promise that `f` runs first.
- Two conflicting accesses to the same memory location are undefined when they are unsequenced and at least one modifies it. Since C++17, function-argument evaluations are indeterminately sequenced, but their order remains unspecified.
- Undefined behavior imposes no requirements. Unspecified behavior chooses among permitted outcomes without documentation. Implementation-defined behavior chooses and documents an outcome.
- A function call is resolved in stages: name lookup, candidate construction, viability, conversion ranking, then tie-breakers. Return type alone cannot overload a function.
- ADL augments an unqualified call with functions from namespaces and classes associated with its arguments. Qualification disables that customization route.
- `constexpr` permits constant evaluation; it does not require it. `consteval` requires it. `constinit` applies to static or thread storage and requires static initialization.
- Templates preserve a callable’s concrete type and therefore give inlining the best chance. `std::function` owns a copyable target behind type erasure and may allocate.
- **Decision:** isolate side effects into statements when evaluation order matters. A clearer expression normally generates the same code and removes an entire correctness question.
- **Decision:** judge parameter passing twice—first by source semantics and ownership, then by measured code at the actual inlining and ABI boundary.

---

## 4.1 Expressions, Operators, and Operands — Core

An **expression** is a computation that has a type and a value category and may have side effects. Operators combine operand expressions; function calls and conversions are expressions too. The reliable way to read a dense expression is:

```
tokens
  │ precedence + associativity
  ▼
expression tree
  │ type rules + conversions + overload resolution
  ▼
typed operations
  │ sequencing rules
  ▼
permitted runtime evaluations
```

Do not skip a layer. In particular, the shape of the tree does not generally impose a traversal order.

### Parse first; order later

Precedence answers which operator owns which operand. Associativity resolves operators at the same precedence level.

```cpp
#include <cassert>

int main() {
    int a = 2;
    int b = 3;
    int c = 4;

    assert(a + b * c == 14);        // parsed as a + (b * c)

    int x = 0;
    int y = 0;
    x = y = 7;                      // parsed as x = (y = 7)
    assert(x == 7 && y == 7);
}
```

This says nothing about whether arbitrary operands are evaluated left-to-right. Multiplication binds more tightly than addition, but in `f() + g() * h()` the language does not generally require `f`, `g`, and `h` to run in textual order.

Parentheses change grouping, not the sequencing rules of the grouped operator:

```cpp
auto result = (f() + g()) * h();   // f() versus g() is still not ordered
```

### Built-in and overloaded operators

Before applying most built-in operators, C++ performs conversions: lvalue-to-rvalue conversion, array/function decay, integral promotions, and the usual arithmetic conversions. Those conversions help explain surprising types:

```cpp
#include <cstdint>
#include <type_traits>

int main() {
    std::uint8_t a = 200;
    std::uint8_t b = 100;
    auto sum = a + b;

    static_assert(std::is_same_v<decltype(sum), int>);
    return sum == 300 ? 0 : 1;
}
```

Both small integers are promoted to `int`; the addition is not eight-bit arithmetic. The eventual assignment back to `uint8_t`, if any, is a separate conversion.

An operator may instead name an overloaded function. Candidate construction and overload resolution then choose that function. Operator notation retains the sequencing rule associated with that operator. Function notation follows call rules:

```cpp
// Assuming operator<<(Stream&, Value) is overloaded:
stream << make_value();             // left operand is sequenced before right
operator<<(stream, make_value());   // ordinary function-call argument ordering
```

These forms can call the same function yet offer different ordering guarantees.

### Operator rules worth keeping active

| Construct | Governing rule | Likely cost | Interview trap |
|---|---|---|---|
| `a + b`, `a * b` | Usual conversions; operands generally unsequenced | Depends on type; overloaded forms are calls | Reading textual order as evaluation order |
| `a && b`, `a \|\| b` | Left first; right conditionally evaluated | A branch or branchless code chosen by compiler | Expecting overloaded `&&`/`\|\|` to short-circuit |
| `cond ? a : b` | Condition first; only selected arm evaluated | Control dependency; type formed from both arms | Assuming unselected arm’s type is irrelevant |
| `a, b` | Built-in comma sequences left before right | Usually none beyond operands | Confusing comma operator with commas separating call arguments |
| `p[i]` | Defined as `*(p + i)` for built-in operands | Address calculation and load/store | `i[p]` is also valid built-in syntax |
| `a = b` | Right operand before left operand since C++17 | Store plus operand work | Believing right associativity itself supplies the order |
| `a && b` when overloaded | A function call; no short-circuit | Call/inline cost and both arguments evaluated | Transferring built-in short-circuit semantics to overloads |

Overloaded `operator&&`, `operator||`, and `operator,` do not acquire the built-in operators’ conditional evaluation behavior. Avoid them when a reader could infer short-circuiting.

### A low-latency reading rule

Count mechanisms, not punctuation. `book[lookup(symbol)].update(parse(packet))` may contain two unpredictable searches, bounds policy, a temporary, several conversions, and an allocation hidden in an overload. Split the line while investigating:

```cpp
const auto id = lookup(symbol);
const auto update = parse(packet);
book[id].update(update);
```

This establishes explicit full-expression boundaries. It also makes profiling and disassembly attribution easier. Compilers can inline and reschedule across these statements when the as-if rule permits; readability need not add runtime work.

---

## 4.2 Value Categories — Core

A value category describes how an expression relates to an object or function. The useful interview model has two axes: does the expression identify something, and may its resources be reused?

```
                         has identity?
                    yes                  no
             ┌────────────────┬────────────────┐
may be moved │    xvalue      │    prvalue     │
from         │  std::move(x)  │  T{}, a + b    │
             ├────────────────┼────────────────┤
not treated  │    lvalue      │   no named     │
as expiring  │  x, *p, a[i]   │   category     │
             └────────────────┴────────────────┘
                 glvalue ─────┘
             └──────── rvalue row ─────────────┘
```

- An **lvalue** is a glvalue that is not an xvalue: a named object, `*p`, `a[i]`, a string literal, or a call returning `T&`.
- An **xvalue** is a glvalue denoting an object whose resources may be reused: `std::move(x)`, a call returning `T&&`, or member access through an xvalue object.
- A **prvalue** initializes an object or computes an operand value: most literals, arithmetic results, `T{}`, and a call returning `T`.
- A **glvalue** (generalized lvalue) is an lvalue or xvalue; it identifies an object or function.
- An **rvalue** is a prvalue or xvalue; it participates in overloads that may consume resources.

“Has identity” is not exactly “its address can be taken.” A bit-field is an lvalue but cannot be the operand of ordinary address-of.

### Type and category are independent

The expression consisting of a variable’s name is normally an lvalue. This includes a variable declared as an rvalue reference:

```cpp
#include <string>
#include <utility>

void consume(const std::string&);  // observes
void consume(std::string&&);       // may take resources

void relay(std::string&& message) {
    consume(message);              // message is an lvalue expression
    consume(std::move(message));   // cast to an xvalue
}
```

`std::move` does not move anything. It is a cast that enables overload resolution to select operations accepting an rvalue. The selected constructor or function performs the transfer. Applying it to a `const T` produces `const T&&`, which usually cannot bind to a move constructor taking `T&&`; a copy overload may win instead.

This distinction is easy to test:

```cpp
#include <type_traits>
#include <utility>

int main() {
    int value = 1;
    int&& ref = 2;

    static_assert(std::is_lvalue_reference_v<decltype((value))>);
    static_assert(std::is_lvalue_reference_v<decltype((ref))>);
    static_assert(std::is_rvalue_reference_v<decltype((std::move(value)))>);
}
```

For an unparenthesized id-expression, `decltype(name)` reports the declared type. For a general expression, `decltype((expression))` reports `T&` for an lvalue, `T&&` for an xvalue, and `T` for a prvalue.

### Materialization and direct construction

Since C++17, class prvalues are used to initialize their result objects directly when the rules require guaranteed copy elision. In:

```cpp
struct Snapshot {
    int sequence;
};

Snapshot make_snapshot() {
    return Snapshot{42};
}

int main() {
    Snapshot s = make_snapshot();
}
```

the returned prvalue initializes `s` directly; the language does not first require a separate temporary and then a move. When a glvalue is needed—for example, to bind a reference—a **temporary materialization conversion** materializes a temporary and produces an xvalue denoting it. Chapter 5 treats the lifetime consequences in full.

### Category, rule, cost, trap

| Category | Typical source | What it enables | Low-latency consequence | Trap |
|---|---|---|---|---|
| lvalue | named object, `*p`, `T&` return | observation or mutation through identity | usually selects copy/borrow overload | declared `T&&` does not make a named expression an rvalue |
| xvalue | `std::move(x)`, `T&&` return | destructive transfer | may replace allocation/copy with handle transfer | moved-from object remains alive; its documented state still matters |
| prvalue | literal, `T{}`, by-value return | direct initialization/materialization | guaranteed elision may remove transfer entirely | saying “the optimizer might elide” understates guaranteed cases |

Use category reasoning to predict overloads, not machine instructions. A move of a fixed-size array wrapper may still copy every element. A move of a vector usually transfers a small control block, subject to allocator rules. Measure the selected operation’s implementation.

---

## 4.3 Expression Sequencing — Core

Sequencing is a partial order over evaluations. An evaluation includes value computations and initiation of side effects. The three relationships are:

- **sequenced before:** every relevant evaluation in A precedes every relevant evaluation in B;
- **indeterminately sequenced:** either A precedes B or B precedes A, but they do not interleave;
- **unsequenced:** neither is ordered before the other.

Within one thread, if a side effect on a memory location is unsequenced relative to another side effect on the same location, or relative to a value computation using an object occupying that location, the behavior is undefined. The safe interview test is: identify the same scalar, find the two accesses, and prove a sequencing edge.

### Sequencing map

| Construct | C++23 guarantee |
|---|---|
| one full-expression followed by the next | first is sequenced before second |
| built-in `&&`, `\|\|` | left before right; right may be skipped |
| built-in comma operator | left before right |
| conditional `?:` | condition before the selected arm |
| braced initializer clauses | left-to-right |
| assignment and compound assignment | right operand before left operand; store after operand value computations |
| subscript `a[b]` | `a` before `b` |
| shift/insertion expression `a << b`, `a >> b` | `a` before `b` |
| postfix expression in a call | before every argument and default argument |
| different function-argument initializations | indeterminately sequenced relative to one another |
| operands of most arithmetic/comparison operators | unsequenced |

The comma in `f(a(), b())` separates arguments; it is not the comma operator. No left-to-right guarantee follows.

### Compiler-prediction snippets

Predict the status before predicting the numeric result:

```cpp
int i = 0;
i = i++ + 1;          // defined since C++17
```

The right operand of assignment is evaluated before the left, including the post-increment’s side effect. The final value is `1`.

```cpp
int i = 0;
int x = ++i + i++;    // undefined: the two modifications are unsequenced
```

The operands of built-in `+` are unsequenced. Parentheses around either operand would not fix this; separate statements would.

```cpp
int i = 0;
record(i++, i++);     // defined since C++17; which parameter receives 0 is unspecified
```

Each argument initialization completes before the other begins, so the modifications do not conflict unsequenced. The implementation may choose either order.

```cpp
int i = 0;
buffer[i] = i++;      // defined since C++17: right operand before left operand
```

Even where modern C++ defines an expression, prefer two statements when a reviewer must remember the standard version to validate it.

### Full expressions are useful fences in the abstract machine

The end of an expression statement, a controlling expression, an initializer, and several other grammar contexts form a **full-expression** boundary. Evaluations of one full-expression are sequenced before the next:

```cpp
const auto slot = next_slot();  // full-expression 1
const auto now = read_clock();  // full-expression 2
publish(slot, now);             // full-expression 3
```

This does not create a hardware memory fence and says nothing about other threads. It provides single-thread abstract-machine order. The optimizer may rearrange instructions if no observable behavior changes.

---

## 4.4 Order of Evaluation — Core

Sequencing states legal relationships; **order of evaluation** asks which permitted relationship an implementation chooses. The key distinction is:

> “Not specified which goes first” is not the same as “unsequenced.”

Function arguments illustrate it:

```cpp
#include <array>

int next_id();
long read_timestamp();
void submit(int, long);

void send_one() {
    submit(next_id(), read_timestamp());
}
```

Both argument evaluations finish before the function body starts, and one finishes before the other starts. C++23 does not specify which one happens first. If the timestamp must correspond to the allocated ID, make the order explicit:

```cpp
const int id = next_id();
const long timestamp = read_timestamp();
submit(id, timestamp);
```

Do not infer argument order from register order in an ABI, from current disassembly, or from one compiler’s behavior. Inlining and optimization can change the chosen order without changing the ABI.

### Ordered alternatives

Braced initializer clauses are evaluated left-to-right:

```cpp
#include <array>

int first();
int second();

auto values() {
    return std::array{first(), second()};  // first() before second()
}
```

A comma fold is also ordered because it uses the built-in comma operator:

```cpp
template<class... Actions>
void run_in_order(Actions&&... actions) {
    (actions(), ...);                      // left-to-right
}
```

Use these guarantees because they express the intended structure, not as tricks to compress side effects.

### Fluent calls and stream chains

Since C++17, the postfix expression in a call is sequenced before its arguments. Combined with operator sequencing, this gives intuitive behavior to chains such as:

```cpp
builder.set_price(read_price()).set_size(read_size());
stream << header() << payload();
```

The first member call completes before evaluation of the second call’s argument. In the stream expression, the left insertion is sequenced before the right operand of the next insertion. This guarantee applies to operator notation; spelling the overloaded operation as an ordinary function call reintroduces ordinary argument-order rules.

### Why unspecified order exists

The freedom can help a compiler manage register pressure or schedule independent work. That does not make it a dependable optimization. If two argument expressions communicate through mutable state, their order is part of program logic and must be expressed explicitly.

For low-latency code, unspecified order is especially dangerous around sequence counters, timestamp reads, logging, allocator state, and enqueue operations. Bugs may survive tests because a particular compiler consistently chooses one order until an unrelated change alters inlining.

---

## 4.5 Undefined, Unspecified, and Implementation-Defined Behavior — Core

These labels define different contracts. A strong answer states what the standard requires, whether documentation is required, and what code may assume.

| Category | Standard’s contract | Must implementation document it? | May a program rely on one outcome? | C++23 example |
|---|---|---:|---:|---|
| **undefined behavior** | imposes no requirements after the program violates the rule | no | no | signed overflow, out-of-bounds access, data race |
| **unspecified behavior** | permits one of a stated set of possibilities | no | no | order of function arguments; which identical string literals share storage |
| **implementation-defined behavior** | permits a choice and requires documentation | yes | only for the documented implementation | signedness of plain `char`; sizes/ranges of fundamental integer types |
| **ill-formed, diagnostic required** | program violates a diagnosable rule | compiler must issue at least one diagnostic | no executable meaning follows from the standard | ambiguous overload |
| **ill-formed, no diagnostic required** | program is invalid but diagnosis is not required | no | no | many cross-translation-unit ODR violations |

Unspecified behavior is not a weaker form of UB. Every permitted unspecified outcome remains within the language contract. The optimizer cannot use it as proof that a supposedly impossible path never occurs. Implementation-defined behavior is also valid behavior; portability requires checking the implementation’s documentation.

### Why UB changes apparently earlier code

Consider this intentionally invalid function:

```cpp
int load_or_default(const int* p) {
    const int value = *p;       // UB if p is null
    if (p == nullptr) {
        return -1;
    }
    return value;
}
```

The abstract machine reaches the dereference before the check. A conforming execution cannot take the null path without already encountering UB, so an optimizer may reason that `p` is non-null and remove the check. This is not the compiler reordering a hardware fault past a branch. It is the compiler optimizing only the executions for which the language gives the program meaning.

The repair is to validate before the operation:

```cpp
int load_or_default(const int* p) {
    if (p == nullptr) {
        return -1;
    }
    return *p;
}
```

### Common sources of undefined behavior

Most production UB falls into a small number of families:

| Family | Examples | Why low-latency code is exposed | Useful defense |
|---|---|---|---|
| lifetime | dangling reference, use-after-free, view into a temporary | pools, intrusive structures, async callbacks | ownership review; ASan; lifetime-focused tests |
| bounds | bad pointer arithmetic, invalidated iterator, `v[v.size()]` | unchecked access and hand-written parsers | span-based APIs; fuzzing; ASan/UBSan |
| arithmetic | signed overflow, divide by zero, invalid shift count | fixed-width counters and bit manipulation | range proofs; checked arithmetic; UBSan |
| alignment/aliasing | misaligned typed access, invalid type punning | packed wire formats and SIMD buffers | `memcpy`, `std::bit_cast`, alignment contracts |
| initialization | reading an indeterminate value | reused buffers and partial decoding | value initialization; definite-write checks |
| control flow | falling off a value-returning function | warning suppressed in “impossible” path | treat warnings as errors; explicit unreachable policy |
| concurrency | data race, invalid mutex use | busy polling and shared state | atomics/locks with documented protocol; TSan |
| library precondition | invalid comparator, empty-container `front()`, invalid iterator | unchecked standard algorithms | encode preconditions; debug libraries; tests |

Two nearby cases are often mislabeled:

- A moved-from standard-library object is generally valid but in an unspecified state unless a stronger postcondition is documented. Reading it is not automatically UB; assuming a particular value may be a logic error.
- Unsigned integer arithmetic wraps modulo \(2^N\). Signed overflow is UB. Converting a signed value to an unsigned type is defined modulo \(2^N\), but that does not make a preceding signed overflow valid.

### Optimizer flags and sanitizers

Sanitizers are diagnostic implementations, not changes to the standard contract:

- AddressSanitizer catches many out-of-bounds and use-after-free errors.
- UndefinedBehaviorSanitizer instruments selected arithmetic, alignment, bounds, and type rules.
- ThreadSanitizer detects many data races.

They do not prove absence of UB, and sanitizer builds materially perturb layout and timing. Run them in tests and CI, not as a latency benchmark.

Compiler switches such as GCC/Clang `-fwrapv` or `-fno-strict-aliasing` are implementation options that alter or restrict optimization assumptions for that build. They are not portable C++ language rules. If a system adopts one, record it in the build contract and test every production configuration.

---

## 4.6 Function Declarations, Definitions, and Calls — Core

A function declaration introduces its name and type. A definition supplies its body. A call performs lookup and overload resolution, initializes parameters from arguments, executes the body, and initializes the result from the return operand.

```cpp
#include <cstdint>

namespace feed {

struct Message {
    std::uint32_t sequence;
};

bool valid(const Message&) noexcept;       // declaration

bool valid(const Message& m) noexcept {    // definition
    return m.sequence != 0;
}

} // namespace feed
```

Declarations for the same function must agree on the function type and relevant specifiers. Parameter names need not match and are not part of the function type. Top-level cv-qualification on a by-value parameter does not distinguish overloads:

```cpp
void inspect(int);
void inspect(const int);  // redeclaration of the same function, not an overload
```

By contrast, `const` inside a pointed-to or referred-to type matters:

```cpp
void inspect(int*);
void inspect(const int*); // distinct overload
```

`noexcept` is part of a function type since C++17, which matters to pointers and templates, but two otherwise identical non-template functions cannot be overloaded solely on `noexcept`. Return type alone also cannot distinguish overloads because a call’s context does not generally participate in choosing the function.

### Definitions, `inline`, and the ODR

A non-inline function normally has one definition in the program. An `inline` function or function template may be defined identically in multiple translation units, which is why definitions appear in headers. The `inline` keyword is primarily an ODR/linkage facility; it does not command machine-code inlining. Conversely, compilers may inline functions that lack the keyword.

At a call site, the optimizer can only inline a body it can see or recover through link-time optimization. That affects performance, not source semantics. A direct non-inlined call has an ABI boundary; an inlined call has no calling convention at runtime.

### The call sequence

```
source: process(make_message(), policy)
          │
          ├─ lookup "process"
          ├─ build and rank overload candidates
          ├─ evaluate postfix expression
          ├─ initialize arguments (relative order may be unspecified)
          ├─ initialize parameters
          ├─ execute selected body
          └─ initialize result object / bind result reference
```

Default arguments participate at the call site after a declaration is selected. They do not create extra overloads.

---

## 4.7 Parameters, Arguments, and Return Values — Core

An **argument** is an expression at the call site. A **parameter** is the function-local entity initialized from it. Pick a parameter form from ownership and mutation semantics first:

| Intent | Common parameter form | Caller-visible consequence |
|---|---|---|
| consume a small scalar/value | `T` | independent local value |
| read a large object without ownership | `const T&` | borrow; caller must keep object alive for call |
| mutate caller-owned object | `T&` | non-null borrow with visible mutation |
| optional borrow | `T*` / `const T*` | null can encode absence |
| take ownership | owning handle by value | transfer is explicit at call site |
| read contiguous sequence | `std::span<const T>` | pointer plus extent; no ownership |
| generic perfect forwarding | `T&&` in a deduced context | preserves argument category; template-only tool |

“Pass everything by `const&`” is not a performance policy. A small scalar passed by reference may force an address to exist, add an aliasing possibility, and inhibit optimization when the call does not inline. A large object passed by value may copy. The right threshold is ABI- and type-dependent, and ownership may dominate byte count.

### Sink parameters

If a function always stores a value, taking by value and moving into storage is often a clean interface:

```cpp
#include <string>
#include <utility>

class Order {
public:
    explicit Order(std::string symbol)
        : symbol_(std::move(symbol)) {}

private:
    std::string symbol_;
};
```

An rvalue caller can construct the parameter directly and then move once into the member; an lvalue caller copies into the parameter and moves once. Separate `const T&` and `T&&` overloads may save a move but increase interface and code size. Choose after measuring the actual type and call mix.

### Returning values and references

Return by value is the default for produced objects. Guaranteed copy elision applies when a prvalue of the return type initializes the result:

```cpp
struct Quote {
    int bid;
    int ask;
};

Quote make_quote(int bid, int ask) {
    return Quote{bid, ask};       // direct initialization of result object
}
```

Named return value optimization (NRVO) for `return local;` is permitted, not universally guaranteed:

```cpp
Quote make_quote(int bid, int ask) {
    Quote q{bid, ask};
    return q;                     // NRVO candidate
}
```

Do not write `return std::move(q);` merely to “help.” It prevents NRVO because the operand is no longer the name of the local. If elision does not happen, return rules already allow a move from eligible local objects.

Returning `T&`, `const T&`, `T&&`, pointer, view, or iterator returns a relationship to an existing object. The function must make the lifetime contract explicit:

```cpp
const Quote& bad_quote() {
    Quote q{100, 101};
    return q;                     // intentionally invalid: dangling reference
}
```

Reference returns can avoid copies, but they can also expose aliasing and make synchronization or lifetime someone else’s problem. A by-value result that is directly constructed is often both safer and cheaper.

### Exceptions and `noexcept`

`noexcept` is a promise: if an exception escapes, `std::terminate` is called. It can enable library choices such as moving rather than copying elements during some container reallocations, but it is not a generic speed annotation. Mark a function `noexcept` when its contract truly cannot propagate an exception. On a low-latency path, separately account for all potential throwing operations and any allocation they imply.

---

## 4.8 Namespaces and Name Lookup — Core

Lookup determines what a name denotes before overload ranking asks which candidate is best. The compiler does not search the whole program for a function that happens to accept the arguments.

### Unqualified and qualified lookup

An unqualified name such as `publish` is searched in the applicable scopes. Broadly, lookup starts locally and moves outward; once a declaration set is found in a scope, outer scopes do not simply merge in. A qualified name such as `market::publish` searches the named scope according to qualified-lookup rules.

```cpp
void route(double);

void example() {
    void route(int);   // hides the outer route during ordinary lookup
    route(1.5);        // calls route(int) after conversion
}
```

Class members show the same hiding effect:

```cpp
struct Base {
    void update(int);
    void update(double);
};

struct Derived : Base {
    using Base::update;
    void update(const char*);
};
```

Without the `using` declaration, the derived declaration named `update` hides the base overload set during lookup, regardless of parameter types.

### Namespace tools

- A namespace alias shortens a stable qualification: `namespace chrono = std::chrono;`.
- A using-declaration imports selected names: `using std::swap;`.
- A using-directive makes all names from a namespace available to lookup and is too broad for public headers.
- An unnamed namespace gives names internal linkage within a translation unit; it is suitable for implementation-only helpers in a `.cpp`.
- An inline namespace supports source-level versioning while allowing members to be found through the enclosing namespace. ABI effects depend on the implementation’s mangling and library policy.

Declarations must generally be visible before use in a translation unit. Headers, modules, and forward declarations control that visibility. Lookup does not wait for a later definition.

### Lookup is often the real bug

When a candidate says “overload resolution picked the wrong overload,” first ask whether the expected function entered the candidate set. Hiding, qualification, two-phase template lookup, and missing ADL are lookup problems. Ranking cannot select a function it never sees.

---

## 4.9 Function Overloading and Overload Resolution — Core

**Overloading** gives one name to distinct functions. **Overload resolution** selects the best viable function for a particular call. Keep the stages separate:

```
                    ┌────────────────────┐
unqualified name ──▶│ ordinary lookup    │
arguments ─────────▶│ + ADL if applicable│
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ candidate functions│
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │ viable?            │
                    │ arity, defaults,   │
                    │ conversions,       │
                    │ constraints        │
                    └──────┬───────┬─────┘
                         no│       │yes
                           ▼       ▼
                       discard   rank implicit
                                 conversion sequences
                                      │
                                      ▼
                           unique best candidate?
                              │              │
                             yes             no
                              ▼              ▼
                           selected       ill-formed
```

### What may be overloaded

Parameter-type differences can distinguish overloads. Top-level cv on by-value parameters, return type alone, default arguments, parameter names, and `noexcept` alone cannot.

Member functions can additionally be distinguished by cv/ref qualifiers:

```cpp
struct Cache {
    int& value() &;
    const int& value() const &;
    int value() &&;
};
```

The implicit object argument participates in viability and ranking. Here, an lvalue, const lvalue, and temporary select different interfaces.

### Viability and conversion ranking

A viable candidate has a suitable number of parameters, can initialize every parameter from its corresponding argument, and satisfies its associated constraints. For each argument, the compiler ranks an implicit conversion sequence:

| Broad rank | Typical examples |
|---|---|
| exact match | identity; qualification adjustment; array/function decay |
| promotion | `short` to `int`; `float` to `double` |
| conversion | `int` to `double`; `Derived*` to `Base*`; pointer to `bool` |
| user-defined conversion | converting constructor or conversion function plus allowed standard conversions |
| ellipsis | match through C-style `...` |

A candidate is better only when it is no worse for every argument and better for at least one, followed by detailed standard tie-breakers. There is no “add the conversion costs and choose the smallest total” rule.

```cpp
void send(int);
void send(double);

void examples() {
    send(1);       // exact match: send(int)
    send(1.0f);    // promotion to double beats conversion to int
    // send(1u);   // may be ambiguous: both are conversions of the same rank
}
```

When equally good conversion sequences remain, rules involving non-template functions, template partial ordering, and constraints may select a winner:

```cpp
#include <concepts>

template<class T>
void encode(T);

template<std::integral T>
void encode(T);

void encode(int);

void use() {
    encode(1);       // non-template exact match wins
    encode(1L);      // constrained template is more specialized here
}
```

Constraints do not repair a worse conversion sequence. First compare conversions under the overload rules; use constraint subsumption and other tie-breakers where applicable.

### User-defined conversions and constructor hijacking

Only one user-defined conversion is permitted in an implicit conversion sequence. A generic forwarding overload can be unexpectedly competitive:

```cpp
#include <concepts>
#include <type_traits>
#include <utility>

class Token {
public:
    Token(const Token&) = default;

    template<class T>
        requires (!std::same_as<std::remove_cvref_t<T>, Token>)
    explicit Token(T&& value) {
        initialize(std::forward<T>(value));
    }

private:
    template<class T>
    void initialize(T&&);
};
```

Without the constraint, a non-const `Token` lvalue can match `T&&` as `Token&` exactly, potentially beating `const Token&`. Constrain forwarding constructors so they do not absorb copy/move or unrelated operations.

### Interview decision procedure

For any puzzling call, write:

1. the declarations found by ordinary lookup;
2. candidates added by ADL;
3. why each candidate is or is not viable;
4. the conversion sequence for every argument;
5. the first tie-breaker that distinguishes the survivors.

If no unique best candidate exists, the program is ill-formed. Compilers do not choose arbitrarily.

---

## 4.10 Argument-Dependent Lookup — Core

Argument-dependent lookup (ADL) augments ordinary lookup for an **unqualified function call**. It searches namespaces and classes associated with the argument types. This lets an operation live beside the type it customizes:

```cpp
#include <utility>

namespace orderbook {

struct Level {
    int price;
};

void swap(Level& a, Level& b) noexcept {
    std::swap(a.price, b.price);
}

} // namespace orderbook

void rebalance(orderbook::Level& a, orderbook::Level& b) {
    using std::swap;
    swap(a, b);     // ADL finds orderbook::swap; std::swap is the fallback
}
```

Writing `std::swap(a, b)` would disable ADL and therefore bypass the custom overload. The two-step pattern supplies a standard fallback while allowing a type-local customization.

### Associated entities and hidden friends

Associated sets are derived from argument types, including relevant class, base-class, template-argument, and enclosing-namespace information. The exact rules are detailed, but the design rule is compact: define non-member operations in the same namespace as their types.

A friend defined inside a class can be found by ADL even when ordinary namespace lookup would not find it:

```cpp
struct Price {
    int ticks;

    friend bool operator==(Price, Price) = default;
    friend void normalize(Price& p) {
        if (p.ticks < 0) p.ticks = 0;
    }
};

void clean(Price& p) {
    normalize(p);   // found through ADL
}
```

This **hidden friend** technique keeps an overload from entering unrelated calls while preserving natural syntax for the associated type.

### ADL traps

- A qualified call such as `orderbook::swap(a, b)` does not use ADL.
- ADL only helps with unqualified function-call syntax; it is not a general “search near the type” rule.
- Certain ordinary-lookup results, including a class member, a block-scope function declaration, or a non-function declaration, suppress ADL.
- Adding an unconstrained function in a type’s namespace can affect distant call sites because it joins their candidate sets.

ADL is compile-time machinery and has no direct runtime cost. Its performance consequence is indirect: it selects the implementation that may or may not allocate, inline, or satisfy `noexcept`.

---

## 4.11 Default Arguments — Core

A default argument is substituted at the call site using declarations visible there. It is not part of the function type and does not create a second function.

```cpp
namespace risk {

bool accept(int quantity, int limit = 100);  // declaration seen by caller

bool accept(int quantity, int limit) {       // no repetition needed
    return quantity <= limit;
}

} // namespace risk
```

Defaults normally appear on trailing parameters. Declarations in the same scope can add defaults to an accumulated set, but a visible default cannot be redefined, even to the same token sequence. A default expression is evaluated each time the call omits that argument.

### Static binding with virtual dispatch

Default selection uses the static type and declaration visible at the call site; virtual dispatch then chooses the final overrider:

```cpp
struct Base {
    virtual int sample(int depth = 1) = 0;
};

struct Derived : Base {
    int sample(int depth = 4) override {
        return depth;
    }
};

int read(Base& source) {
    return source.sample();    // calls Derived::sample with argument 1
}
```

This split is legal and surprising. Avoid default arguments on virtual functions. Put a non-virtual wrapper with the default in the base interface, then delegate to a virtual implementation with an explicit argument.

### Defaults versus overloads

Prefer a default when omitted and explicit forms mean one stable operation and the default is cheap to express at the call site. Prefer overloads when the omitted case needs different construction, when ABI evolution matters, or when the default expression would expose details in every caller.

Changing a default in a shared-library header requires recompiling callers; old binaries retain the old argument because it was embedded at their call sites.

---

## 4.12 Return-Type Deduction — Core

Three related syntaxes solve different problems:

```cpp
template<class T, class U>
auto add(T a, U b) -> decltype(a + b) {  // trailing return type
    return a + b;
}

auto by_value() {                         // auto deduction
    static int x = 0;
    return x;                             // returns int
}

decltype(auto) exactly() {                // decltype rules
    static int x = 0;
    return (x);                           // returns int&
}
```

- A **trailing return type** lets the type refer to parameters and can make template signatures easier to parse.
- An `auto` return uses template-deduction-like rules and normally drops top-level references and cv-qualification.
- `decltype(auto)` applies `decltype` rules to the return expression and can preserve a reference.

Parentheses matter for `decltype(auto)`:

```cpp
decltype(auto) a() {
    static int x = 0;
    return x;       // decltype(x) is int
}

decltype(auto) b() {
    static int x = 0;
    return (x);     // decltype((x)) is int&
}
```

Use `decltype(auto)` for a generic forwarding wrapper only when returning exactly the underlying result—including a reference—is the intended lifetime contract:

```cpp
#include <functional>
#include <utility>

template<class F, class... Args>
decltype(auto) call(F&& f, Args&&... args) {
    return std::invoke(
        std::forward<F>(f),
        std::forward<Args>(args)...
    );
}
```

All non-discarded `return` statements participating in `auto` deduction must deduce a compatible single type under the deduction rules; the compiler does not invent a common type for `int` and `double` returns. A function with a deduced return type generally must have its definition available before a use that needs the type. Virtual functions cannot have deduced return types.

Explicit return types are often better at API and ABI boundaries: they document the contract, avoid accidental reference/value changes, and let declarations stand independently of definitions.

---

## 4.13 Compile-Time Function Evaluation — Role-specific

The core distinction is obligation:

| Facility | Meaning through C++23 | Does every call run at compile time? |
|---|---|---:|
| `constexpr` function | may participate in constant expressions | no |
| `consteval` function | every potentially evaluated call must produce a constant expression | yes |
| `constinit` variable | static/thread-storage variable must have static initialization | not a function; no constness implied |
| `if consteval` | selects code depending on manifest constant evaluation | only the chosen branch for that evaluation |

```cpp
#include <cstdint>

constexpr std::uint32_t mix(std::uint32_t x) noexcept {
    x ^= x >> 16;
    x *= 0x7feb352dU;
    x ^= x >> 15;
    return x;
}

consteval std::uint32_t protocol_tag(std::uint32_t version) {
    return mix(version);
}

static_assert(mix(7) != 0);
constexpr auto tag = protocol_tag(3);
```

Calling `mix(runtime_value)` at runtime is valid. Calling `protocol_tag(runtime_value)` is ill-formed.

Constant evaluation rejects an evaluation that would perform a forbidden operation, including UB on the evaluated path. That makes it useful for validated lookup tables and protocol constants, but it is not a general proof that runtime inputs are safe.

### Cost model

Compile-time computation can remove startup work, guarantee static initialization, and expose constants to optimization. It also consumes compiler time and memory, may enlarge object files when tables are emitted, and can multiply across template instantiations. Measure clean-build time and binary size as well as runtime latency.

`constinit` is valuable for global or thread-local state that must avoid dynamic initialization:

```cpp
#include <cstdint>

constinit std::uint64_t packets_seen = 0;  // mutable, but statically initialized
```

It does not make concurrent access safe and does not make the variable `const`.

---

## 4.14 Standard Attributes — Role-specific

Standard attributes attach narrowly specified information to declarations or statements. They are not a portable replacement for profiling, contracts, or control flow.

| Attribute | Since | Practical meaning |
|---|---:|---|
| `[[noreturn]]` | C++11 | function does not return normally; returning is UB |
| `[[deprecated("reason")]]` | C++14 | implementation should diagnose a use |
| `[[fallthrough]]` | C++17 | documents intentional switch fallthrough |
| `[[nodiscard]]` | C++17 | implementation should diagnose a discarded result |
| `[[maybe_unused]]` | C++17 | suppresses unused diagnostics for a legitimate entity |
| `[[likely]]`, `[[unlikely]]` | C++20 | hints which execution path is likely |
| `[[no_unique_address]]` | C++20 | permits a member to overlap other storage where rules allow |
| `[[assume(expr)]]` | C++23 | optimizer may assume expression is true at that point |

`[[nodiscard]]` is useful on error- or status-bearing results:

```cpp
enum class PublishResult { sent, queue_full };

[[nodiscard("queue_full must be handled")]]
PublishResult publish() noexcept;
```

`[[likely]]` and `[[unlikely]]` may influence code layout and static branch-probability decisions. They do not program the processor’s dynamic branch predictor. Profile-guided optimization uses measured behavior and is usually stronger evidence.

`[[assume]]` is a correctness boundary:

```cpp
int lookup(const int* table, int index) {
    [[assume(table != nullptr)]];
    [[assume(index >= 0)]];
    return table[index];
}
```

The assumption expressions are not evaluated. If an assumption is false where the statement is reached, behavior is undefined. Use it only after a separately enforced invariant, and keep debug/test assertions that validate that invariant. Replacing a necessary check with `[[assume]]` trades correctness margin for optimization opportunity.

Vendor attributes and calling-convention annotations are implementation extensions. Isolate them behind portability macros and verify generated code on each supported compiler.

---

## 4.15 Function Pointers — Core

A function pointer stores the address of a function with a compatible type:

```cpp
#include <cstdint>

using Handler = void (*)(std::uint32_t) noexcept;

void on_trade(std::uint32_t) noexcept {}

void dispatch(Handler handler, std::uint32_t sequence) noexcept {
    handler(sequence);
}

int main() {
    dispatch(&on_trade, 42);
}
```

The address-of operator is optional because a function expression converts to a pointer in this context, but writing `&on_trade` makes intent visible. `noexcept` participates in the pointer type; a pointer to a non-throwing function converts to a corresponding potentially-throwing function pointer, not vice versa.

An overloaded name needs a target type or cast to select one overload:

```cpp
void parse(int);
void parse(double);

using Parser = void (*)(int);
Parser p = &parse;       // target type selects parse(int)
```

### Runtime consequence

A call through a runtime function pointer is an indirect call unless optimization proves the target. Indirection can prevent inlining and can be harder for the processor’s branch predictor when targets vary. The real comparison must name the workload:

- one stable target may predict well;
- many data-dependent targets can produce indirect-branch misses;
- a small `switch` may inline bodies but increase code size and instruction-cache pressure;
- link-time optimization may constant-propagate a pointer and remove the indirection.

Measure cycles or time distributions together with branch-miss and instruction-cache evidence on the deployment target. A function pointer itself neither allocates nor owns context. C APIs therefore commonly pair one with `void* context`; the programmer must enforce the context’s type and lifetime.

---

## 4.16 Pointers to Members — Deep dive

A pointer to member is not an ordinary address. It identifies a member relative to an object of a compatible class, and its representation is implementation-defined.

```cpp
#include <functional>

struct Level {
    int quantity;

    int value() const noexcept {
        return quantity;
    }
};

int main() {
    int Level::* data = &Level::quantity;
    int (Level::*method)() const noexcept = &Level::value;

    Level level{12};
    int a = level.*data;
    int b = (level.*method)();

    Level* p = &level;
    int c = p->*data;
    int d = (p->*method)();

    return a + b + c + d == 48 ? 0 : 1;
}
```

Parentheses around a member-function-pointer call are required by the grammar. Inheritance can require adjustment of the object pointer, which is one reason member-function pointers may be larger than plain function pointers on common ABIs. Do not serialize them, cast them to integers as an interchange format, or assume a byte layout.

`std::invoke` hides the syntactic split between ordinary callables, member-function pointers, and data-member pointers.

---

## 4.17 Callable Wrappers and `std::invoke` — Core

A **callable** may be a function, function pointer, pointer to member, lambda closure, or class with `operator()`. The wrapper determines ownership, type erasure, allocation risk, and inlining opportunity.

| Form | Owns callable? | Type erased? | Allocation | Inlining opportunity |
|---|---:|---:|---|---|
| template parameter `F` | according to how stored | no | none imposed | strongest; concrete type visible |
| function pointer | no context ownership | yes, to signature | none | indirect unless target proven |
| `std::reference_wrapper<F>` | no | no | none | good when template sees `F` |
| `std::function<R(Args...)>` | yes, copyable target | yes | may allocate; small-object strategy is not guaranteed | generally indirect through wrapper |
| `std::move_only_function<R(Args...)>` | yes, target may be move-only | yes | may allocate | generally indirect through wrapper |
| project-specific non-owning function view | no | yes | normally none by design | generally indirect; lifetime external |

`std::move_only_function` is C++23. A `function_ref`-style view is not a standard-library facility through C++23; several libraries provide one. Its main risk is dangling because it borrows the callable.

### `std::invoke` as the common call operation

```cpp
#include <functional>
#include <utility>

template<class F, class... Args>
decltype(auto) invoke_once(F&& f, Args&&... args) {
    return std::invoke(
        std::forward<F>(f),
        std::forward<Args>(args)...
    );
}
```

`std::invoke` handles ordinary call syntax and the special object syntax required by member pointers. `std::is_invocable`, `std::invocable`, and related facilities let generic code constrain that operation.

### Hot-path choice

Use a template when the call site can remain generic and code-size growth is acceptable:

```cpp
template<class Predicate>
int scan(const int* begin, const int* end, Predicate predicate) {
    int matches = 0;
    for (; begin != end; ++begin) {
        matches += predicate(*begin) ? 1 : 0;
    }
    return matches;
}
```

The predicate’s concrete type is visible, so its body can inline into the loop. The trade-off is one instantiation per relevant callable type, increasing build time and possibly `.text` size.

Use `std::function` when stored heterogeneous, copyable callables and a stable signature are worth type erasure. Its standard contract does not promise a particular small-buffer size or no allocation for a given lambda. If allocation is forbidden, enforce that with a wrapper whose capacity and overflow behavior are part of your project contract, then test allocation counts.

---

## 4.18 C Variadic Functions — Deep dive

C-style variadic functions use `...` and `<cstdarg>`. The callee receives no language-level type list or count for the variadic tail:

```cpp
#include <cstdarg>

int sum_ints(int count, ...) {
    va_list args;
    va_start(args, count);

    int result = 0;
    for (int i = 0; i < count; ++i) {
        result += va_arg(args, int);
    }

    va_end(args);
    return result;
}
```

The caller and callee must agree out of band on number and types. Supplying the wrong type to `va_arg` is generally UB. Default argument promotions apply: `float` is passed as `double`, and `bool`, `char`, and `short` undergo integral promotion, normally to `int`. Therefore retrieving those unpromoted types is wrong.

`va_list` may be an array or structured ABI object rather than a plain pointer. Use `va_copy` when a second traversal is needed, and pair every successful `va_start`/`va_copy` with `va_end`.

C variadics remain necessary at some C and operating-system boundaries. Keep them behind a typed C++ façade. For formatting, a mismatched format string can turn the same missing type information into memory corruption or a security vulnerability. Enable the compiler’s format diagnostics where supported; those diagnostics are an implementation feature layered over an unsafe language mechanism.

Do not use C variadics for a new internal interface. Variadic templates preserve types and can validate arity and constraints at compile time.

---

## 4.19 C++ Variadic Templates — Core

A parameter pack represents zero or more template arguments. A pack expansion repeats a pattern:

```cpp
#include <utility>

template<class F, class... Args>
decltype(auto) forward_call(F&& f, Args&&... args) {
    return std::forward<F>(f)(
        std::forward<Args>(args)...
    );
}
```

`Args` is a template parameter pack; `args` is a function parameter pack. `sizeof...(Args)` gives the count at compile time. The expansion forwards each element, but the argument evaluations of the resulting function call still have unspecified relative order.

### Fold expressions

Fold expressions reduce a pack with an operator:

| Form | Association | Empty-pack behavior |
|---|---|---|
| `(... op pack)` | unary left fold | only certain operators have defined identities |
| `(pack op ...)` | unary right fold | same restriction |
| `(init op ... op pack)` | binary left fold | yields `init` for empty pack |
| `(pack op ... op init)` | binary right fold | yields `init` for empty pack |

Only unary folds over `&&`, `||`, and comma have built-in empty-pack identities (`true`, `false`, and `void()`, respectively). Supply an initial value for arithmetic reductions:

```cpp
#include <utility>

template<class... Values>
auto sum(Values... values) {
    return (0 + ... + values);
}

template<class... Actions>
void run(Actions&&... actions) {
    (std::forward<Actions>(actions)(), ...); // comma sequences left-to-right
}
```

### Cost and correctness

Variadic templates are type-safe, but not automatically cheap:

- each distinct argument-type sequence can produce a separate instantiation;
- code size can harm instruction-cache locality;
- forwarding can preserve references that later dangle if a callee stores them;
- an unconstrained pack may absorb calls intended for a more specific overload;
- pack expansion into call arguments does not establish left-to-right order;
- zero-length packs are valid and must be handled intentionally.

Use a template pack in a thin hot layer when static types enable validation and inlining. Consider type erasure at a colder boundary to control code size. Confirm the trade-off with build-time measurements, binary section sizes, and representative instruction-cache behavior.

---

## 4.20 Calling Conventions and Parameter Passing — Deep dive

The C++ standard specifies parameter initialization and observable behavior. It does not specify argument registers, stack-frame shape, name mangling, or binary compatibility. Those belong to an **application binary interface** (ABI) selected by platform, compiler, architecture, and build options.

### Common implementation models, not language guarantees

| Property | x86-64 System V family | Microsoft x64 | AArch64 procedure-call family |
|---|---|---|---|
| early integer/pointer arguments | commonly six general registers | commonly four general registers | commonly eight general registers |
| early floating/vector arguments | separate vector-register classification | positional register rules | vector/floating registers with aggregate rules |
| caller-provided home/shadow area | not the Microsoft 32-byte rule | 32-byte shadow space | ABI-specific stack rules |
| red zone | commonly 128 bytes in user space | none | generally none |
| aggregate passing | classification by chunks/classes | size and type rules differ | includes homogeneous floating aggregates |

This table is orientation only. Operating systems may modify a base architecture ABI; compiler options and vector types add exceptions. Read the ABI document for the exact target and inspect generated code.

### Source semantics before register counting

At a non-inlined boundary, common ABIs often pass small trivial aggregates in registers and larger or non-trivial class objects indirectly or through memory. “Sixteen bytes or less always goes in registers” is not a portable rule: field types, alignment, triviality, and target classification matter.

Large or otherwise indirectly returned objects commonly use a hidden pointer to caller-provided result storage. This implementation technique aligns naturally with copy elision, but the language guarantee is direct initialization of the result object—not a particular hidden-register protocol.

References are commonly implemented as addresses, but the standard does not say a reference occupies storage or has pointer representation. Passing a small integer as `const int&` can therefore be worse than passing it by value at an uninlined boundary, while inlining may erase the distinction.

### Passing guidance with conditions

| Situation | Default source-level choice | Verify at the boundary |
|---|---|---|
| small scalar or small cheap value | by value | register use, alias freedom, code size |
| large read-only object | `const T&` | pointer chasing, lifetime, cache locality |
| function stores an owned value | by value then move, or explicit overloads | caller mix, move cost, allocation count |
| optional object | pointer or vocabulary type | null checks and ownership |
| contiguous borrowed input | span/view | lifetime and bounds representation |
| generic immediate callable | forwarding reference/template | inlining and instantiation growth |
| stable erased callback boundary | owning or borrowing wrapper by contract | allocation, indirect-branch behavior, lifetime |

The low-latency claim must name the boundary. “By value is faster” might be true for a two-word trivial type across a visible direct call. It may be false for a non-trivial type, a register-starved call, or an ABI that classifies the aggregate into memory. Benchmark with production optimization, inlining policy, and representative call-site distribution.

### Calling-convention extensions

Spelling such as `__vectorcall`, `__attribute__((sysv_abi))`, or vendor register-preservation attributes is implementation-specific. Such annotations can be necessary for foreign-function interfaces, JIT stubs, interrupts, or hand-written assembly. They are not standard C++23 and must be isolated, documented, and tested at both sides of the boundary.

Tail-call optimization is also an implementation choice, not a C++ guarantee. Matching calling conventions, compatible return paths, and absence of pending cleanup commonly help. A destructor that must run after a call can prevent replacement of `call; return` with a jump.

---

## 4.21 Worked Reasoning: Predict, Select, Then Cost — Core

Consider a publication API:

```cpp
#include <cstdint>
#include <functional>
#include <utility>

namespace feed {

struct Update {
    std::uint64_t sequence;
};

void publish(const Update&, int channel);
void publish(Update&&, int channel);

} // namespace feed

int choose_channel();
feed::Update decode();

template<class Observer>
void process(Observer&& observer) {
    feed::Update update = decode();
    std::invoke(std::forward<Observer>(observer), update.sequence);
    publish(std::move(update), choose_channel());
}
```

Question: which `publish` is called, in what order are its argument expressions evaluated, and what latency claims are justified?

### Step 1: lookup

The call is unqualified. Ordinary lookup finds no local `publish` in the shown scopes. ADL examines `feed::Update`, finds namespace `feed`, and adds both `feed::publish` overloads.

### Step 2: viability and ranking

`std::move(update)` is an xvalue of type `feed::Update`. Both overloads are viable: an xvalue can bind to `const Update&` or `Update&&`. Binding to `Update&&` is the better reference binding, so the rvalue-reference overload wins. `std::move` itself transfers nothing; the selected `publish` decides what happens.

### Step 3: sequencing and order

The postfix expression denoting `publish` is sequenced before its arguments. The two argument initializations—`std::move(update)` and `choose_channel()`—are indeterminately sequenced relative to each other. Their order is unspecified.

`std::move(update)` is only a cast and has no mutation by itself, so the unspecified order is harmless in this version. If the first argument were `prepare(update)` and `choose_channel()` also read or modified `update`, explicit statements would be required to establish intended order.

### Step 4: lifetime

`update` remains alive until `process` exits. Passing it as an xvalue permits the callee to move from it. Any later use must respect the moved-from state. The observer received `update.sequence` by value before the call, so that scalar is independent of later moves.

### Step 5: cost

No defensible cycle count follows from the source:

- `decode()` may allocate or may construct directly into `update`;
- `Observer` is a template parameter, so `std::invoke` can inline if the body is visible;
- `publish` may inline, or may cross an ABI boundary;
- the move overload may transfer handles, copy bytes, enqueue by reference, or allocate;
- `choose_channel()` may dominate the call.

A defensible optimization experiment would record allocation count, inspect whether observer and publish calls inline, measure representative latency percentiles, and sample indirect-branch and instruction-cache events if callable dispatch is suspected. The rollback is the clearer untuned implementation if no stable improvement appears.

---

## Recall and Practice — Core

### Recall card

- Parse with precedence and associativity; predict execution with sequencing. They answer different questions.
- Type and value category are independent. Named variables are lvalue expressions; `std::move` casts to an xvalue.
- Since C++17, class prvalues can initialize result objects directly in guaranteed-elision cases.
- Conflicting unsequenced accesses to the same memory location are UB. Function arguments are indeterminately sequenced but have unspecified order.
- UB supplies no outcome to reason about. Unspecified behavior stays within a valid set. Implementation-defined behavior must be documented.
- Calls resolve as lookup/ADL → candidates → viability/constraints → conversion ranking → tie-breakers.
- Qualification disables ADL. Hidden friends deliberately depend on ADL.
- Defaults are inserted at call sites and bind statically; virtual dispatch remains dynamic.
- `auto` normally returns a value; `decltype(auto)` can preserve a reference and its lifetime hazard.
- `constexpr` permits compile-time execution; `consteval` requires it; `constinit` requires static initialization.
- Templates maximize visibility and specialization but can grow code. Type erasure controls interface shape but usually introduces indirect dispatch and may allocate.
- Registers and stack slots are ABI facts, never standard C++ guarantees.

### Common interview traps

1. “Left associative” does not mean “evaluated left-to-right.”
2. `std::move(const_object)` commonly copies because the move overload needs non-const `T&&`.
3. `f(i++, i++)` is not UB in C++17 and later, but which parameter gets which value is unspecified.
4. An unspecified outcome is not permission for arbitrary behavior.
5. A hidden base overload is absent from the candidate set; conversion ranking cannot recover it.
6. `std::function` does not promise a standard small-buffer capacity or allocation-free construction.
7. A default argument on a virtual call comes from the static type.
8. `return std::move(local);` can inhibit NRVO.
9. `[[assume]]` does not validate a condition; a false assumption creates UB.
10. ABI register counts do not dictate source-level argument evaluation order.

### Interview questions

1. For `a() + b() * c()`, separate parsing from evaluation order. What is guaranteed?
2. Why is a named `T&&` parameter an lvalue, and when should it be cast back to an xvalue?
3. Classify `x`, `std::move(x)`, `T{}`, `*p`, and a function call returning `T&`.
4. Explain why `f(i++, i++)` and `++i + i++` have different status in C++23.
5. Distinguish undefined, unspecified, implementation-defined, and ill-formed behavior using one example each.
6. Why may a compiler remove a null check that appears after a dereference?
7. Walk through lookup, viability, and ranking for overloads `f(int)`, `f(double)`, and `template<class T> f(T)`.
8. Why does `using std::swap; swap(a, b);` customize correctly while `std::swap(a, b)` may not?
9. How can a forwarding constructor hijack copying, and which constraint prevents it?
10. Why should virtual functions avoid default arguments?
11. When does `decltype(auto)` preserve a reference that `auto` would discard, and what lifetime obligation follows?
12. Compare a template callable, function pointer, `std::function`, and `std::move_only_function` for ownership, allocation, inlining, and code size.
13. Why is retrieving a `float` with `va_arg(args, float)` incorrect?
14. Does expanding a parameter pack into a function call evaluate elements left-to-right? How can a comma fold establish order?
15. Defend passing a two-word type by value without claiming that every ABI passes it in registers.

### Code-reading exercise

```cpp
#include <string>
#include <utility>

void use(const std::string&);
void use(std::string&&);

std::string make();

void test() {
    std::string a = make();       // A
    use(a);                       // B
    use(std::move(a));            // C

    const std::string b = make();
    use(std::move(b));            // D
}
```

Predict the selected overload at B, C, and D. Then state what can be concluded about object construction at A without seeing `make`’s body, and what cannot be concluded about allocation from the overload choices alone.

### Design exercise

Design a hot-path callback API that supports:

- immediate calls with inlinable lambdas;
- stored move-only handlers;
- a cold plugin boundary with a stable C-compatible signature;
- a strict no-allocation rule after initialization.

Choose a callable representation for each boundary. State ownership and lifetime, how capacity failure is reported, where indirect calls remain, how code-size growth is bounded, and which measurements would validate the design.

### Prerequisites for Chapter 5

Chapter 5 assumes you can classify lvalues, xvalues, and prvalues; explain temporary materialization and direct result construction; distinguish sequencing from evaluation order; and trace how parameter binding and return form affect an object’s lifetime.
