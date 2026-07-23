# Chapter 5 — Object Lifetime and Initialization

*Storage and lifetime are different things. Most hard bugs in C++ live in the gap between them: bytes that exist without an object, objects that outlive their bytes, initialization that runs in an order nobody chose.*

---

## Why This Matters in an HFT Interview — Core
Lifetime questions are how interviewers check whether a candidate reasons about the abstract machine or just recites syntax. "When does an object start existing?", "why did my constructor's virtual call not dispatch?", "why does deleting through this base pointer corrupt the heap?" all have precise answers, and getting them wrong in production means a leaked file descriptor, a corrupted allocator, or a crash at process shutdown. This chapter owns storage duration, lifetime, initialization, and destruction; allocation chapters (7, 8) and ownership chapters (9, 10) link back here rather than re-deriving it. The payoff is a small number of rules — construction order, RAII, reference extension, static-init ordering — that explain almost every dangling-pointer and use-after-free bug you will be asked to spot.

## 90-Second Screen — Core

Five facts:

1. An object's lifetime begins after storage is obtained **and** initialization completes; it ends when the destructor starts or the storage is reused. Storage duration and lifetime are separate axes.
2. `T x;` (default-init) leaves scalars indeterminate; `T x{};` (value-init) zeroes them — except when a user-*provided* constructor intervenes.
3. Members and bases construct in declaration order, not initializer-list order; destruction is the exact reverse.
4. Lifetime extension belongs to particular binding syntax, not to a reference that happens to receive the result later. Local direct bindings usually extend; returned references and bindings through calls do not. Aggregate reference members are a braces-versus-parentheses trap.
5. Deleting a derived object through a non-virtual base destructor is undefined behavior: the derived destructor is skipped and `operator delete` can receive the wrong address and size.

Two decisions:

- **Braces or parens?** Default to braces (narrowing checks, no most-vexing-parse) unless an `initializer_list` constructor would hijack the call, or a large aggregate's implicit zero-fill is unwanted.
- **Virtual destructor or not?** Virtual if the type is ever deleted through a base pointer; otherwise non-virtual and, if the type is a polymorphic-but-not-owned base, `protected`.

---

## 5.1 Storage and Object Lifetime — Core

Storage duration (Ch. 1 §1.8) is how long the *bytes* exist. Lifetime is how long the *object* exists.

| Storage duration | Bytes live | Typical location |
|---|---|---|
| Automatic | Enclosing block | Stack |
| Static | Program duration | `.data`/`.bss` |
| Thread | Thread duration | TLS block (Ch. 24 §24.9) |
| Dynamic | Between allocation and deallocation | Heap |

For an ordinary object, lifetime **begins** when suitably sized and aligned storage exists and initialization is complete. Vacuous initialization of a trivial type still counts. For a class object, lifetime **ends** when its destructor call starts; lifetime also ends when storage is released or reused by an object not nested within it. Constructors and destructors have additional rules for the object currently under construction or destruction; the practical rule is not to publish `this` before the invariant exists and not to let another thread observe the object without synchronization.

```
storage obtained ──▶ [ construction ] ──▶ LIFETIME ──▶ [ destruction ] ──▶ storage released
                     ▲                                                     ▲
                     └─ before this: bytes exist, object does not ─────────┘
```

Outside the lifetime, a pointer may still represent the storage address. It can be copied, compared in the ways valid for that pointer, or converted to `void*`; the underlying object representation can be inspected through `unsigned char`, `char`, or `std::byte` when the surrounding rules permit. It cannot be used to access a `T` object or call a non-static member function, because no live `T` is there.

```cpp
#include <new>

struct S { int x; void f() {} };

int main() {
    S* p = static_cast<S*>(::operator new(sizeof(S))); // storage only, no object
    p->x = 1;      // UB: no S object exists yet
    p->f();        // UB: outside lifetime
    new (p) S{};   // now the object exists
    p->~S();
    ::operator delete(p);
}
```

**Reusing storage.** A same-type complete object can normally replace a non-`const` complete object at exactly the same address. The old name, pointer, and references then automatically denote the replacement once its lifetime starts. This is **transparent replacement**. The corresponding rules for subobjects are stricter: base-class subobjects and `[[no_unique_address]]` members are potentially overlapping, so an old pointer does not automatically retarget in all reuse patterns. Different types also fail transparent replacement. Use the pointer returned by placement construction when possible; `std::launder` is the specialist escape hatch when a correctly created same-type object exists but an old pointer cannot automatically denote it.

```cpp
#include <new>

struct Quote { int px; };

int main() {
    Quote q{100};
    Quote* old = &q;
    q.~Quote();
    Quote* fresh = new (&q) Quote{101};
    int a = old->px;                // OK: transparent same-type replacement
    int b = fresh->px;              // also OK, and the clearest style
    return a == b ? 0 : 1;
}
```

If you manually end the lifetime of an automatic, static, or thread-local object with a non-trivial destructor, another object of the original type must occupy the storage when the implicit destructor call would occur. Otherwise scope exit tries to destroy an object that is no longer there, which is undefined behavior. Raw-storage owners avoid that implicit second destruction by managing bytes rather than declaring a `T` object in the slot.

---

## 5.2 Initialization Forms — Core

| Syntax | Name | For a class | For a scalar | For an aggregate |
|---|---|---|---|---|
| `T x;` | default-initialization | default ctor | **indeterminate** (automatic/dynamic); zero (static) | members default-init'd |
| `T x{};` | value-initialization, or list-init for an aggregate | default ctor; zero-init first if that ctor is not user-provided | zero | omitted elements use defaults, then empty-list/value-init |
| `T x = v;` | copy-initialization | converting ctor, `explicit` excluded | conversion | — |
| `T x(v);` | direct-initialization | any ctor incl. `explicit` | conversion | — |
| `T x{v...}` | direct-list-initialization | `initializer_list` preferred if viable; else ctor; no narrowing | no narrowing | aggregate init (§5.3) |
| `T x = {v...}` | copy-list-initialization | same, but a selected `explicit` ctor is an error | same | aggregate init |

### Default vs. value initialization

`int x;` at block scope has an indeterminate value; an ordinary evaluated read has undefined behavior in C++23. At namespace scope, or for a block `static`, zero-initialization happens before any other initialization, so `static int x;` starts as zero. Do not confuse the syntax with the storage duration.

For a class, whether `T x{}` zeroes members depends on exactly one thing: is the default constructor **user-provided**?

```cpp
struct A { int x; };                  // no user-declared ctor
struct B { B() {} int x; };           // user-PROVIDED ctor
struct C { C() = default; int x; };   // defaulted on first declaration — not user-provided
struct D { D(); int x; };
D::D() = default;                     // defaulted OUTSIDE the class — this IS user-provided

A a{};   // x == 0
B b{};   // x INDETERMINATE — B's ctor runs and does nothing to x
C c{};   // x == 0
D d{};   // x INDETERMINATE
```
Whether `= default` appears inside or outside the class body changes whether the constructor counts as user-provided, which changes whether value-init zero-fills first. This is a real bug source, not just trivia: a type gains a `.cpp`-file out-of-line `= default` (for PIMPL, say) and every `T{}` call site silently stops zeroing.

### Narrowing and `initializer_list` hijacking

Braces reject narrowing conversions:
```cpp
int  a(3.5);   // OK — truncates to 3
int  b{3.5};   // ERROR — narrowing
char c{300};   // ERROR — doesn't fit
```
But a type with any `initializer_list` constructor prefers it in brace-init whenever that constructor is viable, even when another constructor is a better match:
```cpp
std::vector<int> v1(10, 5);   // 10 elements, each 5
std::vector<int> v2{10, 5};   // 2 elements: 10 and 5
```
`std::vector<std::string> v{10}` does *not* hit this trap: the `initializer_list<string>` constructor is not viable (`10` doesn't convert to `string`), so it drops out of overload resolution and the size constructor is chosen instead. Hijacking only fires when the `initializer_list` constructor is viable — the trap is that "viable" is a wider net than most people expect.

### Most vexing parse

Anything that can be parsed as a declaration is a declaration:
```cpp
Widget w();                        // a FUNCTION declaration, not a default-constructed Widget
std::unique_lock<std::mutex>(gate); // can declare a default-constructed local named gate
```
If `gate` names an outer mutex, the second form can parse as a declaration that shadows it; a default-constructed `unique_lock` owns no mutex. Name the guard and pass the mutex as an unmistakable constructor argument. Braces fix the function-declaration ambiguity, but note `Widget w{};` and `Widget w;` are not always semantically identical — you are also choosing value/list initialization rather than default-initialization:
```cpp
std::lock_guard<std::mutex> lg(gate);  // name the lock
std::lock_guard lg2{gate};             // CTAD (C++17) + braces
```

### Recommendation

Braces are a good default because they reject narrowing and avoid the most-vexing parse. They are not a universal rule: use parentheses when the intended overload would lose to `initializer_list`, and make bulk initialization policy explicit for large buffers. `struct Buf { char data[65536]; }; Buf b{};` semantically zero-initializes every element; whether that becomes a `memset`, is fused with later stores, or disappears is an optimizer decision. Measure the generated work in the real overwrite pattern.

---

## 5.3 Aggregate Initialization — Core

An aggregate is a class or array with no user-declared or inherited constructors, no private or protected non-static data members, no virtual functions, and no virtual, private, or protected base classes.

| Standard | Aggregate change |
|---|---|
| C++11 | No brace-or-equal initializers (NSDMIs) allowed |
| C++14 | NSDMIs allowed |
| C++17 | Base classes allowed — aggregates can derive; the base is initialized with nested braces |
| C++20 | Any user-*declared* (not just user-provided) constructor disqualifies; designated initializers added; parenthesized aggregate init added |

```cpp
struct Base { int b; };
struct Agg : Base { int x; int y = 5; };   // C++17 aggregate with a base and an NSDMI
Agg a{{1}, 2};        // Base{1}, x=2, y=5
Agg c{.x = 2};        // C++20 designated init; c.b value-init'd, y = 5
```

Designated initializers must appear in declaration order — no skip-and-return, no nested (`.a.b = 1`) or array (`[3] = x`) designators as in C. Skipped members get their NSDMI or are value-initialized.

**Aggregate-ness says nothing about layout or copyability.** An aggregate can hold a `std::string` or a `std::vector`, which makes it neither trivially copyable nor safe to `memcpy`; a C++17 aggregate with a base can fail the standard-layout requirement that only one class in the hierarchy contribute non-static data members. Whether a given type is safe to `memcpy`, pass in registers, or place in shared memory depends on its *trivial-copyability* and *standard-layout* properties (Ch. 3 §§3.5–3.6), which you check independently — never infer them from "it's an aggregate."

What aggregate initialization does guarantee: each element is initialized in declaration order, and an omitted element uses its default member initializer or, if none exists, is initialized from an empty initializer list. For `struct Point { int x; int y; };`, `Point p{};` zeroes both members (but not padding between them, Ch. 3 §3.2), and `Point p{1};` sets `x` to 1 and zeroes `y`.

Adding a private member or a constructor silently turns a type into a non-aggregate, breaking every `T{a, b}` call site — a real API-stability hazard.

C++20's parenthesized aggregate initialization (`Agg a(1, 2)`) lets facilities such as `emplace_back`, `make_unique`, and allocator construction—which forward element arguments inside parentheses—construct an aggregate from those arguments. Before C++20, those parenthesized element-argument forms were ill-formed; default construction and construction from an existing aggregate were still possible.

---

## 5.4 Initialization Is Not Assignment — Core

Initialization creates an object's first state; assignment changes the value of an already-live object. The syntax can look similar, but the selected functions, admissible types, and resource work differ.

```cpp
#include <string>

struct Session {
    const int venue;
    std::string user;
};

int main() {
    Session a{7, "maker"};   // initializes both subobjects
    Session b{8, "taker"};
    a = b;                   // error: generated assignment cannot assign const venue
}
```

A constructor may initialize `const` members, references, and types with no default constructor. Assignment cannot reseat a reference or replace a `const` member. For resource-owning classes, construction usually acquires one clean resource; assignment must also handle the target's old resource, self-assignment, and failure partway through the change.

| Question | Initialization | Assignment |
|---|---|---|
| Does a live destination already exist? | No | Yes |
| Main operation for class `T` | constructor | `operator=` |
| Can establish `const`/reference members? | Yes | Cannot change or reseat them |
| Old resource to release? | No | Often |
| Failure obligation | destroy completed subobjects | preserve a documented assignment guarantee |
| Typical hot-path consequence | may acquire/allocate | may release old state and acquire/copy new state |

Worked choice: suppose a decoder emits an `Order` containing a dynamically allocated tag.

```cpp
Order next = decode(packet);       // construct the result directly
current = decode(packet);          // construct a temporary, then assign into current
```

The second line is not automatically slower: move assignment may transfer a buffer cheaply, and copy elision can remove construction moves. But it has a different obligation—`current`'s prior buffer must be released or reused. If this path is latency-sensitive, inspect allocations and generated code, then measure the distribution under realistic tag sizes. Prefer initialization when producing a new value. Prefer assignment when object identity and storage must remain stable, or expose a deliberate `reset`/`update` operation that can reuse capacity.

A useful decision flow is:

```
Need a new object identity? ── yes ─▶ initialize at the final destination
          │
          no
          ▼
Must preserve address/registration? ── yes ─▶ assign or update in place
          │
          no
          ▼
Compare reuse benefit against release/acquire work; measure both designs
```

---

## 5.5 Subobject Construction and Destruction Order — Core

```
Construction                            Destruction (exact reverse)
1. Virtual bases (most-derived first)   1. Body
2. Direct bases, declaration order      2. Members, reverse declaration order
3. Members, declaration order           3. Direct bases, reverse declaration order
   (NOT initializer-list order)         4. Virtual bases
4. Constructor body
```

Concretely, for `struct Widget : VBase, Base1, Base2 { Member1 m1; Member2 m2; };`:

```
time ──▶
  VBase()  Base1()  Base2()  m1()  m2()  { body }  ~Widget body  ~m2()  ~m1()  ~Base2()  ~Base1()  ~VBase()
  └──────────── construction, declaration order ────────┘        └──────── destruction, exact reverse ────────┘
```

Members initialize in **declaration order**, regardless of the order written in the member-initializer list:
```cpp
struct S {
    int a;
    int b;
    S(int x) : b(x), a(b) {}   // a is initialized FIRST; reading indeterminate b is UB
};
```
`-Wreorder` catches this.

The following trace program makes the rule observable without relying on an ABI:

```cpp
#include <iostream>
#include <string_view>

struct Trace {
    std::string_view name;
    explicit Trace(std::string_view n) : name(n) { std::cout << '+' << name << ' '; }
    ~Trace() { std::cout << '-' << name << ' '; }
};

struct Base { Trace base{"base"}; };
struct Book : Base {
    Trace bids{"bids"};
    Trace asks{"asks"};
    Book() { std::cout << "body "; }
    ~Book() { std::cout << "~body "; }
};

int main() { Book book; }
// +base +bids +asks body ~body -asks -bids -base
```

**During construction, the dynamic type for virtual dispatch is the class currently under construction.** A virtual call from a base constructor does not dispatch to a derived override because the derived subobject has not begun construction. The same restriction applies in reverse during destruction. The usual fix is a post-construction `init()` call, passing the needed behavior as a constructor parameter, or a design that does not require overridable behavior during construction (Chapter 6).

The language guarantee is the dispatch restriction; a vptr being installed in stages and a symbol such as `__cxa_pure_virtual` are common ABI mechanisms. A direct call to a pure virtual from its own constructor or destructor has undefined behavior and commonly fails at link time or terminates. Do not make the failure mode part of the design.

**If a constructor throws**, the complete object's destructor does not run, but every base and member subobject that had already finished constructing is destroyed in reverse order. For a `new`-expression, the matching deallocation function is invoked after construction fails. This is why acquiring two raw resources in one constructor body is a leak risk: no member destructor owns the first one when the second acquisition throws. Give each resource its own RAII member (§5.7).

### Across objects

| Category | Order |
|---|---|
| Automatic objects in a scope | Declaration order; destroyed in exact reverse |
| By-value function parameters | Initialization order is unspecified; destroyed after the function body, with destruction ordering governed by the call rules |
| Temporaries | Destroyed at end of full-expression, reverse creation order |
| Array elements | Ascending index; destroyed descending |
| Namespace-scope, within one TU | Declaration order; reverse at exit |
| Namespace-scope, across TUs | No usable relative-order guarantee in the general case — §5.9 |
| Function-local `static` | On first control flow through the declaration, thread-safely; destroyed in reverse of construction order at exit |
| `thread_local` | One instance per thread; dynamic initialization is tied to the thread and odr-use rules; destruction occurs at thread exit |

---

## 5.6 Destruction Through Base Pointers — Core

```cpp
#include <vector>

struct Base { ~Base() = default; };        // non-virtual
struct Derived : Base { std::vector<int> v; };

int main() {
    Base* p = new Derived;
    delete p;                              // UNDEFINED BEHAVIOR
}
```

Deleting a derived object through a base pointer whose destructor is non-virtual is UB. Common implementations may skip `Derived`'s destructor, leak `v`'s allocation, or pass unsuitable address/size information to deallocation—especially with multiple inheritance or sized deallocation. Because the behavior is undefined, none of those manifestations is guaranteed and “it only leaks” is not a valid risk assessment.

A virtual destructor supplies the dynamic dispatch needed to destroy the most-derived object and select its deallocation path. Under the Itanium C++ ABI, a class with a virtual destructor can have three destructor entry points:

| Symbol | Name | Purpose |
|---|---|---|
| `D1` | complete object destructor | destroys members, direct bases, and virtual bases for the complete object |
| `D2` | base object destructor | as `D1` but skips virtual bases |
| `D0` | deleting destructor | calls `D1`, then `operator delete` — this is the slot in the vtable |

`D0` is the deleting-destructor entry used by that ABI to reach the correct complete object and deallocation function. These names and exact mechanics are not C++ guarantees; MSVC uses a different ABI. The standard guarantee is that a valid polymorphic delete destroys the most-derived object and follows the selected deallocation path correctly.

### Decision rule

| Situation | Destructor |
|---|---|
| Type is ever deleted through a base pointer | `virtual ~T() = default;` |
| Base is polymorphic but always destroyed through the derived type, never through the base pointer | `protected: ~T();` — a compile error stops accidental `delete base_ptr;` |
| Value type, `final`, or no inheritance | non-virtual, keep it trivially destructible |
| Mixin / CRTP base | `protected:` non-virtual, no vtable at all |

A common heuristic is "any virtual function implies a virtual destructor," because most classes with virtuals *are* deleted polymorphically — but the actual rule is about ownership, not about virtuals in general: a class can have virtual functions and still be safe with a non-virtual protected destructor if nothing ever owns it through a base pointer.

Adding a virtual destructor is not free:

- If it is the type's first virtual function, implementations normally add a vptr and may increase size and alignment. If the type is already polymorphic, the vptr already exists.
- A virtual destructor makes the type non-trivially destructible. A class with virtual functions is not standard-layout. Neither property alone tells you its exact calling convention; Chapter 3 separates these questions.
- A delete through a base pointer normally involves virtual dispatch, although optimization may devirtualize a statically known dynamic type. Inspect the actual call site before making a latency claim.

**`std::shared_ptr` can preserve the original deleter; a default `std::unique_ptr<Base>` does not.** In `std::shared_ptr<Base> p = std::make_shared<Derived>()`, the control block knows how to destroy `Derived`, so that construction is safe without a virtual base destructor. This does not make every `shared_ptr<Base>` safe: constructing one from a `Base*` that has already lost concrete-type information can still delete incorrectly. A default `unique_ptr<Base>` applies `delete` to its stored `Base*`; it therefore requires valid polymorphic deletion or a custom deleter that retains the concrete type (Chapter 9).

---

## 5.7 RAII — Core

Resource Acquisition Is Initialization: bind a resource's lifetime to an object's lifetime so the destructor releases it deterministically. It is why C++ has no `finally`.

```cpp
class FileDesc {
    int fd_ = -1;
public:
    explicit FileDesc(const char* path) : fd_(::open(path, O_RDONLY)) {
        if (fd_ < 0) throw std::system_error(errno, std::system_category());
    }
    ~FileDesc() { if (fd_ >= 0) ::close(fd_); }
    FileDesc(FileDesc&& o) noexcept : fd_(std::exchange(o.fd_, -1)) {}
    FileDesc& operator=(FileDesc&& o) noexcept {
        if (this != &o) {
            if (fd_ >= 0) ::close(fd_);
            fd_ = std::exchange(o.fd_, -1);
        }
        return *this;
    }
    FileDesc(const FileDesc&) = delete;
    FileDesc& operator=(const FileDesc&) = delete;
    int get() const noexcept { return fd_; }
};
```

This example uses the POSIX `open`/`close` API (`<fcntl.h>`, `<unistd.h>`, and `<system_error>`). The lifetime pattern is C++23; the resource API is platform-specific.

Why it's more than convenience: during stack unwinding, every fully-constructed automatic object is destroyed in reverse order regardless of whether the scope was left by `return`, `break`, `goto`, or an exception (Ch. 10 §10.6), so exception safety comes without extra code. Release is deterministic — unlike a GC finalizer, a file descriptor or NIC ring slot is freed at a known point. And composability falls out for free: a class holding only RAII members needs no destructor of its own (Rule of Zero, Ch. 6 §6.2).

### The invariants

1. **Do not let exceptions escape a destructor.** A destructor with no explicit exception specification has the specification it would receive if implicitly declared; it is non-throwing when its potentially constructed subobjects have non-throwing destructors, but can be potentially throwing otherwise. An exception escaping a non-throwing destructor calls `std::terminate`; a second exception escaping any destructor during stack unwinding also terminates. If release can fail (`close()` returning `EIO`, a database commit), expose an explicit `close()` that reports errors and keep destructor cleanup non-throwing.
2. **A throwing constructor means the object's own destructor never runs** — but every already-constructed base and member is destroyed (§5.5). Give each resource its own RAII member rather than acquiring two raw resources in one constructor body.
3. **Move must leave the source releasable** — `std::exchange` to a sentinel value is the idiom, as in `FileDesc` above.
4. **Ownership must be unambiguous**; copy is usually deleted (Ch. 6 §6.3).

Standard RAII types include `std::unique_ptr` (with a custom deleter for C handles, Ch. 9 §9.2), `std::shared_ptr`, `std::lock_guard`/`std::unique_lock`/`std::scoped_lock`, `std::jthread` (requests stop and joins on destruction), `std::fstream`, and `std::vector`. Through C++23 there is no standard general-purpose scope guard; `scope_exit`, `scope_fail`, and `scope_success` remain in the Library Fundamentals v3 Technical Specification under `std::experimental`, while libraries also provide non-standard equivalents. Chapter 10 §10.13 covers the pattern.

**Cost at ABI boundaries.** A visible, non-virtual destructor is often inlined, but cleanup operations still have their own cost. Some ABIs classify types with non-trivial special members differently for parameter passing and return, and pending cleanup can inhibit a tail call because work remains after the callee returns (Chapter 4 §4.20). These are target-ABI and optimizer facts, not universal language rules: inspect code generation and measure the call path.

---

## 5.8 Temporary Materialization and Lifetime Extension — Core

Since C++17, a class prvalue describes initialization rather than necessarily naming a separate temporary object. A **temporary materialization conversion** turns a prvalue into an xvalue and creates a result object when a glvalue is needed—for example, to bind a reference or access a member. This deferred model enables guaranteed copy elision: `T x = T(T(f()));` initializes `x` directly when the applicable elision rules hold rather than requiring a chain of temporary `T` objects.

A temporary bound **directly** to a reference has its lifetime extended to that reference's scope:
```cpp
const std::string& r = make_string();   // extended to r's scope
std::string&& rr = make_string();       // also extended
```

The exceptions are where the bugs live:

| Case | Extended? |
|---|---|
| Local `const T&` / `T&&` bound to a prvalue | Yes — to the reference's scope |
| Reference member of a local aggregate object directly initialized with braces | Yes — to the aggregate object's lifetime |
| Aggregate reference member, initialized with C++20 parentheses | No — only to the end of that full-expression |
| Reference member bound to a temporary in a ctor-initializer | Ill-formed under the corrected C++ rule; some compilers historically accepted a dangling extension |
| A reference **returned** from a function and bound to its temporary | No — returned reference dangles |
| A function **parameter** `const T&` | Only until the end of the call's full-expression |
| Binding to a **subobject** of a temporary (`const int& r = f().member;`) | Yes — extends the whole temporary |
| Binding **through a function call** returning a reference (`const T& r = id(T{})`) | No — extension doesn't pass through function boundaries |
| Temporary in a range-for initializer | C++23 extends temporaries that would otherwise die at the end of that initializer; parameter-lifetime exceptions still apply |

A reference member in an object created by a `new`-expression is another exception: a temporary bound in the new-initializer lasts only to the end of the containing full-expression, not for the allocated object's lifetime. Prefer value members when an aggregate can own the value.

```cpp
template<class T>
const T& identity(const T& x) { return x; }

const std::string& a = std::string{"live"};             // extended
const std::string& b = identity(std::string{"dead"});   // dangles after this declaration

const std::string& bad() { return std::string("x"); }   // DANGLES — -Wreturn-local-addr catches this
```

Related dangling shapes with the same root cause: `std::string_view sv = std::string("x");` (Ch. 13 §13.1), a lambda that captures by reference and outlives the capture (Ch. 18), and generic wrappers (`auto&& x = f().g();`) where the extension outcome depends on what the wrapped call actually returns.

**Worked puzzle.** Which of these two C++20 initializations is safe after its declaration?

```cpp
struct Cents { long long v; };
struct Wrapper { const Cents& c; };

Wrapper braces{Cents{500}};
Wrapper parens(Cents{600});
```

Reason in three steps:

1. `Wrapper` is an aggregate, and `c` is a reference element.
2. Brace aggregate initialization follows the ordinary reference lifetime-extension rule. The `Cents{500}` temporary therefore lives as long as `braces`.
3. Parenthesized aggregate initialization has a specific exception: its bound temporary survives only to the end of the full-expression. `parens.c` dangles on the next statement.

The visual timeline is:

```
braces declaration:  construct Cents(500) ─────────────────▶ destroy with braces
parens declaration:  construct Cents(600) ─▶ ; destroy
                                               └─ parens.c dangles here
```

Prefer a value member unless the aggregate is explicitly a non-owning view whose caller must supply storage. If a reference member is intentional, avoid binding it to a temporary and test both brace and parenthesized call sites during review.

---

## 5.9 Static and Thread-Local Lifetime — Core

Namespace-scope objects initialize in two phases:

**Phase 1 — static initialization**, before dynamic initialization: constant initialization where the declaration meets its rules; otherwise zero-initialization. An implementation can realize this with loader-provided zeroed pages or data in the executable, but `.bss`/`.data` placement is not a language guarantee.

**Phase 2 — dynamic initialization** performs what static initialization did not. Ordered non-inline variables in one translation unit follow appearance order. Across translation units, the detailed rules distinguish ordered, partially ordered, and unordered initialization, but an ordinary program must not assume a usable relative order between two unrelated namespace-scope objects in different translation units.

```cpp
// a.cpp
extern Registry& reg();
Widget w("alpha");        // ctor calls reg().add(this)

// b.cpp
Registry g_registry;      // may be constructed AFTER w — using it from w's ctor is UB
```
*(Illustrative across two translation units — the bug is real, but its presence is not deterministic in any single build.)*

### Fixes, in order of preference

**`constinit` (C++20)** asserts the variable is constant-initialized, so it participates in phase 1 and cannot be part of the fiasco:
```cpp
constinit std::atomic<uint64_t> g_seq{0};   // no dynamic init, no ordering hazard, no guard variable
```

**Construct-on-first-use** (a function-local static) guarantees initialization happens before first use and, since C++11, is thread-safe — concurrent callers block until initialization completes ("magic statics"):
```cpp
Registry& reg() { static Registry r; return r; }
```
Implementations commonly use a guard check on calls after the first; after inlining it may be a load and a predictable branch, but this is an implementation detail to inspect and benchmark. Compiler options such as GCC/Clang's `-fno-threadsafe-statics` are non-standard and give up the C++ thread-safety guarantee. Recursive entry while the same local static is initializing has undefined behavior; deadlock or termination are possible manifestations.

**Deliberate process-lifetime allocation**: `static Registry& r = *new Registry;` avoids destruction-order dependencies, at the cost of intentionally unreclaimed storage and more difficult tests. Use it only under an explicit process-shutdown policy and annotate or suppress the expected sanitizer report narrowly.

**Explicit init phase**: a `void init_all()` called from `main`, with state unavailable until then. This often fits a trading process because it makes startup order, warm-up, and failure handling explicit and testable. The trade-off is an additional state machine: code must prevent access before initialization and coordinate shutdown.

### A concrete failure and its repair

```cpp
// Before: relies on unspecified cross-TU order.
struct PriceTable { std::vector<double> prices = load_defaults(); };
PriceTable g_table;                       // dynamic init — order relative to other TUs unspecified
double lookup(int i) { return g_table.prices.at(i); }   // may run before g_table exists

// After: construct-on-first-use removes the ordering question entirely.
PriceTable& table() {
    static PriceTable t;                  // constructed on first call, thread-safely
    return t;
}
double lookup(int i) { return table().prices.at(i); }
```
The repair doesn't just move the bug later — it changes the guarantee from "unspecified order" to "constructed before the first use, in any TU, by any thread."

### Related hazards

- Destruction at normal exit is the mirror problem: an object with static storage duration can outlive another static object its destructor uses. A deliberate process-lifetime allocation or an explicit shutdown phase can remove the dependency. `std::quick_exit` skips ordinary static destruction and invokes only registered quick-exit handlers; POSIX `_exit` is platform-specific and bypasses normal C++ teardown. Neither is a casual substitute for an orderly shutdown.
- A self-registering factory in a static library can silently never run: if no other symbol in that object file is referenced, the linker never pulls the file in, so the registrar's static initializer never executes. `--whole-archive` or an explicit reference fixes it (Ch. 1 §1.12).
- A dynamically initialized `thread_local` may require per-thread initialization bookkeeping. `constinit thread_local` rejects a declaration that cannot be constant-initialized and can therefore remove that dynamic-initialization requirement. The exact access sequence and TLS model are implementation and platform details (Chapter 24 §24.9).

---

## Empty Bases and `[[no_unique_address]]` — Reference

These are layout facilities, so Chapter 3 §3.3 owns the mechanics. The standard permits an empty base subobject to share an address under the empty-base optimization; it does not guarantee a particular `sizeof` for a library handle. `[[no_unique_address]]` (C++20) permits a non-static data member to overlap other members or tail padding when the implementation can do so. Such a member is a potentially-overlapping subobject, which matters to transparent replacement in §5.1. Verify the layout with `sizeof`, `alignof`, and the target ABI rather than assuming a stateless policy always costs zero bytes.

---

## HFT Application — A Preallocated Message Slab — Role-specific
A dispatch loop that cannot allocate on the hot path preallocates raw storage at startup and placement-constructs messages into it as they arrive, destroying them when processed:

```cpp
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>

struct Order { std::uint64_t id; double price; std::uint32_t qty; };

class OrderSlab {
    std::byte* storage_;
    std::size_t capacity_;
    std::size_t size_ = 0;

    static std::size_t bytes_for(std::size_t n) {
        if (n > std::numeric_limits<std::size_t>::max() / sizeof(Order)) {
            throw std::bad_array_new_length();
        }
        return n * sizeof(Order);
    }

public:
    explicit OrderSlab(std::size_t n)
        : storage_(static_cast<std::byte*>(
              ::operator new(bytes_for(n), std::align_val_t{alignof(Order)}))),
          capacity_(n) {}

    ~OrderSlab() {
        while (size_ != 0) {
            std::destroy_at(slot(--size_));
        }
        ::operator delete(storage_, std::align_val_t{alignof(Order)});
    }
    OrderSlab(const OrderSlab&) = delete;
    OrderSlab& operator=(const OrderSlab&) = delete;

    Order* slot(std::size_t i) noexcept {
        return reinterpret_cast<Order*>(storage_ + i * sizeof(Order));
    }

    Order& push(std::uint64_t id, double price, std::uint32_t qty) {
        if (size_ == capacity_) throw std::bad_alloc();      // explicit, testable exhaustion policy
        Order* p = std::construct_at(slot(size_), Order{id, price, qty});
        ++size_;
        return *p;
    }
    bool pop_back() noexcept {
        if (size_ == 0) return false;
        std::destroy_at(slot(--size_));
        return true;
    }
};
```
Correctness constraints: `construct_at` and `destroy_at` are the lifetime operations touching each slot, so `size_` must track the live count exactly. Construction increments `size_` only after success, and `pop_back()` checks emptiness before decrementing. The byte-count helper rejects multiplication overflow before allocation. The byte-offset calculation avoids pretending an array of `Order` objects exists before the individual lifetimes begin.

The latency benefit is conditional: after startup there is no allocator call in `push`, so allocator locks and allocator metadata misses are removed from that path. Pre-touching the allocation can reduce first-touch page faults, but it does not promise that pages can never fault or be evicted. Measure `push` latency percentiles under realistic capacity, NUMA placement, and exhaustion behavior. Chapter 55 §55.3 owns pool recycling, memory warm-up, and operational policy.

---

## Deep Dive — Placement Construction and Explicit Lifetime APIs — Deep dive
*Skippable on a first pass. Read this before implementing an allocator, a lock-free ring buffer, or wire-format parsing; not needed to answer most lifetime interview questions.*

### Placement new

Placement new constructs an object in storage you already own and performs no allocation:
```cpp
#include <cstddef>
#include <new>

alignas(T) std::byte buf[sizeof(T)];
T* p = new (buf) T{args...};   // calls operator new(size_t, void*), which just returns buf
p->~T();                       // you must destroy manually — there's no matching delete
```
`void* operator new(std::size_t, void* p) noexcept { return p; }` is defined by the standard, is not replaceable, and does nothing; all the real work is the constructor call.

Hazards:

- Storage must be sufficiently sized and aligned; misalignment is UB and faults for SIMD types and atomics.
- The destructor must be called explicitly; `delete p` is UB — it would call `operator delete` on storage that never came from `operator new`.
- Non-allocating placement `new[]` exists and returns the supplied pointer; it must not add allocation overhead. It still gives the raw-storage owner an awkward interface because there is no matching placement `delete[]` expression for normal teardown. Prefer `std::uninitialized_*` algorithms or scalar `construct_at` calls where the live count is explicit.
- If a constructor throws partway through a hand-written sequence of objects, the already-built ones must be destroyed. The standard uninitialized-memory algorithms provide rollback; a manual loop must do the same.

### `std::construct_at` and friends (C++20)

```cpp
std::construct_at(p, args...);   // constexpr-friendly placement new; direct-initialization only
std::destroy_at(p);
std::destroy(first, last);
std::uninitialized_value_construct_n(p, n);
std::uninitialized_move_n(src, n, dst);
```
Through C++23, `construct_at` is the relevant constexpr-capable primitive here; plain placement new cannot be used in a constant expression. It performs direct-initialization with parentheses, which can construct aggregates because C++20 added parenthesized aggregate initialization (§5.3).

`std::aligned_storage`/`std::aligned_union` are deprecated in C++23 — their buffer type invited `reinterpret_cast` mistakes. `alignas(T) std::byte[]` is the replacement.

### `std::launder`

`std::launder<T>(p)` returns a pointer to a live `T` at the same address when its preconditions hold. It is needed only when that object already exists but the old pointer cannot automatically denote it under transparent replacement. It is an optimization barrier in that narrow language sense, not a general instruction to discard cached memory.

```cpp
#include <new>

struct X { int n; };

int main() {
    const X* p = new const X{3};           // const object in dynamic storage
    new (const_cast<X*>(p)) const X{5};    // same address, new const complete object
    // int stale = p->n;                   // UB: old pointer did not retarget
    int current = std::launder(p)->n;      // OK: current == 5
    delete std::launder(p);
    return current == 5 ? 0 : 1;
}
```

The original object is a `const` complete object, so it is not transparently replaceable; dynamic allocation is important because reusing storage occupied by a `const` complete object with automatic, static, or thread storage duration is itself undefined. In normal raw-storage code, retaining the pointer returned by `construct_at` is clearer than laundering an older one. `launder` does not create an object, enlarge storage, repair alignment, legalize an aliasing violation (Chapter 3 §3.7), or synchronize threads.

### `std::start_lifetime_as` (C++23)

`launder` finds an object that already exists; `std::start_lifetime_as<T>` starts an implicit-lifetime `T` in existing allocated storage while preserving its object representation. The region must be large enough, reachable through the supplied pointer, and suitably aligned (Chapter 3 §3.6).

```cpp
#include <cstring>
#include <memory>
#include <type_traits>

static_assert(std::is_trivially_copyable_v<MsgHeader>);
static_assert(std::is_implicit_lifetime_v<MsgHeader>);
const MsgHeader* hdr = std::start_lifetime_as<MsgHeader>(rx_buffer);

// Copying to a real object also handles an under-aligned receive buffer:
MsgHeader copy;
std::memcpy(&copy, raw_bytes, sizeof copy);
```

For a trivially copyable header, `memcpy` is the more portable baseline and compilers often optimize a fixed small copy into loads; verify rather than asserting identical cost. Neither route validates the bytes as a protocol message: invalid enum values, endian conversion, padding, and untrusted lengths remain separate concerns. `start_lifetime_as` is useful when alignment and representation have already been established and avoiding a material copy matters in measurement.

---

## Deep Dive — Unions and Tagged Variants — Deep dive
*Skippable unless you're designing a wire-format union or comparing it against `std::variant`.*

A union has overlapping member storage and, in the ordinary case, one **active member** whose lifetime has begun. Its size is sufficient for its largest member but can include alignment padding. Reading an inactive member is undefined behavior except for the permitted common-initial-sequence inspection of standard-layout class members (Chapter 3 §3.10).

```cpp
union U { int i; float f; };
U u; u.i = 1;
float x = u.f;   // UB in C++ (legal in C; GCC/Clang document reading the inactive member as an extension)
```

For this simple union, assignment through the member access can implicitly create the implicit-lifetime member before assignment:
```cpp
u.f = 3.14f;      // f now active; i's lifetime ended
```
For **non-trivial** members you must destroy the old member and placement-new the new one:
```cpp
#include <new>
#include <string>
#include <vector>

union V {
    std::string s; std::vector<int> v;
    V() : s() {}
    ~V() {}         // must be user-provided — the union can't know which member to destroy
};

int main() {
    V x;
    x.s.~basic_string();
    new (&x.v) std::vector<int>{};
    x.v.~vector();   // destroy whichever non-trivial member is active before V ends
}
```
If any member has a non-trivial default constructor, copy/move constructor, destructor, or assignment, the union's corresponding special member is implicitly deleted, and you must write it yourself while tracking the active member externally. Raw unions of non-trivial types are almost always the wrong tool for this reason.

Anonymous unions with a tag byte are the standard wire-message shape:
```cpp
struct Message {
    std::uint8_t type;
    union { Add add; Cancel cancel; Trade trade; };   // members injected into Message's scope
};
```
This shape is easiest when every alternative is trivially copyable, but the tag must still agree with the active member and every access must validate it. Chapter 51 §51.3 applies the related object-representation and schema-discriminator rules to wire parsing.

### `std::variant` vs. a raw union

| | Raw union | `std::variant` |
|---|---|---|
| Tag | You maintain it | Built in |
| Wrong-member read | UB | `std::get` throws; `get_if` returns null |
| Non-trivial members | Manual ctor/dtor/assignment | Handled |
| Trivially copyable | If all members are | Also trivially copyable since C++17 if every alternative is |
| Dispatch | `switch` on your tag | `std::visit` |
| `valueless_by_exception` | n/a | A possible post-throw state; `visit`/`get` can report `bad_variant_access` |

`std::visit`'s cost is implementation-dependent: some standard library implementations build a table of function pointers and dispatch through it (an indirect call the compiler may not inline); others special-case small variants into a `switch`. A hand-rolled `switch (msg.type)` over a tagged union is a useful comparison baseline when the alternative set is small, fixed, and hot—but check code generation and measurements for the target toolchain before choosing.

C++20 permits unions in constant expressions, including switching the active member, which is what makes `constexpr std::variant`/`constexpr std::optional` possible.

---

## Deep Dive — Sized, Aligned, and Destroying `delete` — Deep dive
*Role-specific: relevant when writing or reasoning about custom allocators, not needed for general lifetime questions.*

**Sized deallocation (C++14)** adds forms such as `operator delete(void*, std::size_t)`, allowing a selected deallocation function to receive the size of the object being deleted. Do not memorize “sized always wins”: for class-specific deallocation, an otherwise equivalent unsized form is selected when both are available; for ordinary single-object global deletion, selection of a sized form can be implementation-dependent when multiple candidates remain. Provide a consistent family of replacement functions and verify which calls the target compiler emits. A size-segregated allocator can use a supplied size to avoid its own metadata lookup, but the resulting latency change is a benchmark question.

**Aligned allocation (C++17)** standardized `std::align_val_t` allocation and deallocation overloads. A `new`-expression for a type with new-extended alignment passes the alignment to overload resolution, and the matching aligned deallocation form must be used. Before C++17, portable standard code could not rely on this aligned-overload protocol for over-aligned dynamic objects; implementations offered differing support and extensions. Chapter 3 §3.3 owns alignment requirements.

**Destroying `delete` (C++20)**: normally `delete p` runs `p->~T()` and then calls `operator delete`. A class-specific destroying delete is invoked with the object *still alive* and is responsible for destroying it itself — useful when the deallocation size depends on data stored in the object, such as a trailing-array/flexible-array-member type:
```cpp
struct Node {
    std::size_t length;
    static void operator delete(Node* p, std::destroying_delete_t) {
        std::size_t n = p->length;   // still readable — the whole point
        p->~Node();
        ::operator delete(p, sizeof(Node) + n * sizeof(int));
    }
};
```
The point is not that every caller computes the size; it is that ordinary deletion destroys the object before invoking its deallocation function, while destroying delete lets the class-specific function inspect live state and then perform both actions.

Gotchas that apply across these facilities: mismatched pairs (`new[]`/`delete`, `malloc`/`delete`, placement-new/`delete`) are undefined behavior; deallocation lookup and overload selection depend on class scope, alignment, and whether destroying delete participates. Through C++23, deleting an incomplete class type is undefined if the complete class has a non-trivial destructor or a relevant deallocation function. That is why PIMPL owners declare `~Widget();` in the header and define it—even as `= default`—in the source file where the implementation type is complete (Chapter 44 §44.6).

---

## Recall and Practice — Core
### Recall card

- Lifetime begins after storage exists *and* initialization completes; it ends at the start of destruction or storage reuse. Storage duration and lifetime are separate.
- `T x;` leaves scalars indeterminate; `T x{}` zeroes them unless a user-*provided* constructor runs instead — and `= default` outside the class body counts as user-provided.
- Members and bases construct in declaration order regardless of initializer-list order; destruction is the exact reverse; a constructor's virtual calls dispatch to the currently-under-construction class, never a derived override.
- A non-virtual base destructor plus polymorphic `delete` is UB: the derived destructor is skipped and the allocator can receive the wrong address/size.
- RAII destructors must not throw; a throwing constructor destroys already-built subobjects but not the object itself.
- Lifetime extension follows the initializing expression: direct local bindings and brace-initialized aggregate reference members can extend; parenthesized aggregate reference members, returned references, and bindings through calls do not.
- Cross-TU dynamic initialization order is unspecified; `constinit`, construct-on-first-use, or an explicit init phase all remove the hazard.
- Placement construction, `launder`, and union/variant machinery are the toolkit for owning raw storage directly — reach for them only when RAII over a typed container isn't an option.

### Questions

1. When exactly does an object's lifetime begin and end, and how does that differ from storage duration?
2. What is legal to do with a pointer to storage that hasn't been constructed into yet?
3. Why does `struct B { B() {} int x; }; B b{};` leave `x` indeterminate while `struct C { C() = default; int x; }; C c{};` zeroes it?
4. Why does `std::vector<int> v{10, 5}` construct two elements instead of ten fives, and why doesn't `std::vector<std::string> v{10}` fall into the same trap?
5. In what order are bases and members constructed, and why does a virtual call inside a base constructor not reach a derived override?
6. What exactly goes wrong, mechanically, when a `Derived` is deleted through a non-virtual `Base*`?
7. Which temporaries get lifetime-extended and which don't? Give one case of each.
8. What causes the static initialization order fiasco, and rank the standard fixes by preference for a low-latency process.
9. When does `std::launder` apply, and what does it *not* fix?
10. Why does `shared_ptr<Base> p = make_shared<Derived>()` destroy `Derived` correctly without a virtual destructor, and how can a differently constructed `shared_ptr<Base>` still get this wrong?

### Common traps

- Treating allocated bytes as a live `T` before construction, or continuing to use `T` after destruction.
- Assuming the member-initializer list controls member order instead of matching declaration order.
- Applying “always use braces” without checking `initializer_list` overloads or parenthesized aggregate reference members.
- Storing a reference or view obtained from a temporary, even though a direct local reference would have extended that temporary.
- Adding a virtual destructor to every base without asking whether ownership through the base exists—or omitting it when such ownership does exist.
- Assuming placement construction allocates, `launder` creates an object, or `start_lifetime_as` validates external bytes.
- Relying on namespace-scope dynamic initialization order across translation units because one link order happened to work.

### Code-reading puzzle

```cpp
#include <cstdio>
#include <string>
#include <string_view>
#include <utility>

struct Logger {
    std::string prefix;
    explicit Logger(std::string p) : prefix(std::move(p)) {}
    void log(std::string_view msg) const { std::printf("%s: %.*s\n", prefix.c_str(),
                                                          (int)msg.size(), msg.data()); }
};

struct Session {
    const Logger& logger;
    explicit Session(const Logger& l) : logger(l) {}
    void run() const { logger.log("session started"); }
};

Session make_session() {
    Logger l{"session"};
    return Session{l};
}

int main() {
    Session s = make_session();
    s.run();
}
```
Identify the lifetime bug, name which rule from §5.8 it violates, and state the minimal change to `Session` that fixes it without changing `Logger`.

### Design exercise

Implement a fixed-capacity `RingSlab<T, N>`: raw aligned storage for `N` objects of `T`, with `push_back`/`pop_front` that placement-construct and `destroy_at` elements as the ring wraps. Requirements: no allocation after construction, correct behavior when `T`'s constructor throws (the slot must not be considered occupied), a destructor that destroys exactly the currently-live elements, and an explicit, testable policy for what `push_back` does when the ring is full (throw, return `false`, or overwrite — your choice, documented).

### Prerequisites for Chapter 6

Chapter 6 (Classes and Polymorphism) assumes: initialization versus assignment (§5.4), construction/destruction order (§5.5), the polymorphic-deletion rule (§5.6), and RAII (§5.7). It builds on them to cover special-member generation, the Rule of Zero, slicing, and choosing between virtual dispatch, CRTP, variants, and type erasure.
