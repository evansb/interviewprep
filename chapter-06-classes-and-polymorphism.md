# Chapter 6 — Classes and Polymorphism

A class is a user-defined type that combines state, operations, and invariants. Two questions recur through this chapter: *which operations did the compiler generate?* and *is a call selected at compile time or runtime, with what ownership and locality consequences?* Examples use standard C++23 unless a platform or ABI is named.

## Why This Matters in an HFT Interview — Core
Special-member rules can decide whether container growth moves elements or copies them, potentially adding allocations and wider tail latency. Polymorphism choice (virtual dispatch, CRTP, `variant`, or type erasure) appears directly in “design a strategy interface” questions. A strong answer reasons from extensibility, ownership, ABI, locality, call frequency, and code size instead of repeating that virtual calls are slow or templates are free. Slicing, dangling accessors, and unsafe base destruction are recurring bug classes worth diagnosing from symptoms.

## 90-Second Screen — Core
1. A user-declared destructor or copy operation prevents implicit **move** declaration. An rvalue may then bind to a copy constructor, so the regression can be silent.
2. Rule of Zero: hold self-managing members and declare no special members. Write custom operations only when ownership or value semantics require them.
3. The member-initializer list initializes; the constructor body assigns. For members without a trivial default, the list avoids a redundant construct-then-assign.
4. A base class deleted through a base pointer needs a virtual destructor, or destruction has undefined behavior. The first virtual function typically adds per-object dispatch state and makes the class non-trivial.
5. Copying a derived object into a base object slices off the derived data and the dynamic type — the sliced object is a genuine base, not a partial derived one.
6. Decide: use virtual dispatch or type erasure for an open runtime type set; use templates/CRTP when the concrete type reaches the caller; use `variant` for a closed set. Then measure the actual call site.
7. Decide: `explicit` by default on single-argument constructors; opt into implicit conversion deliberately.

---

## 6.1 Class Invariants and Special Members — Core

**Defining classes, objects, and instances.** An **object** is a region of storage in which an object’s lifetime has begun; an **instance** is ordinary informal shorthand for an object of a class type. Each non-static data member contributes state to each object. A non-static member function operates on an implicit object parameter, exposed inside the function as `this`.

```cpp
class PriceBand {
    int low_;
    int high_;

public:
    PriceBand(int low, int high) : low_(low), high_(high) {
        if (low > high) throw std::invalid_argument{"reversed band"};
    }

    [[nodiscard]] bool contains(int px) const noexcept {
        return low_ <= px && px <= high_;  // this->low_ is implicit
    }
};
```

The constructor establishes `low_ <= high_`; public operations preserve it. **Encapsulation, invariants, and access control** belong together: private access narrows the code allowed to mutate representation, but creates no runtime protection. **Class versus struct:** the two keywords have the same type-system capabilities. Their only language differences are defaults: `struct` members and bases are public; `class` members and bases are private. A common style uses `struct` for transparent records and `class` for invariant-bearing types.

```
PriceBand object
+--------------------+
| low_:  100         |  state, one copy per object
| high_: 110         |
+--------------------+
contains(&object, px)    conceptual implicit-object call
```

Constructors and destructors begin and end class-object lifetime; copy and move operations transfer value or state between live objects. C++ recognizes six **special member functions**. “Implicitly declared” and “usable” are different: a declaration can later be defined as deleted.

| Operation | Typical signature | Implicit-declaration rule |
|---|---|---|
| Default constructor | `T()` | No user-declared constructor or constructor template |
| Destructor | `~T()` | No user-declared destructor |
| Copy constructor | `T(const T&)` | No user-declared copy constructor; a declared move operation makes the implicit copy deleted |
| Copy assignment | `T& operator=(const T&)` | No user-declared copy assignment; a declared move operation makes the implicit copy deleted |
| Move constructor | `T(T&&)` | No user-declared copy/move operation or destructor |
| Move assignment | `T& operator=(T&&)` | No user-declared copy/move operation or destructor |

Since C++20, `operator==` and `operator<=>` are defaultable (§6.3, Ch. 19 §19.3) but are not classified as special members.

The consequential rule: **a user-declared destructor suppresses the implicit move operations.** The class falls back to copying, with no diagnostic.

```cpp
struct Buffer {
    std::vector<char> data;
    ~Buffer() { log("destroyed"); }   // suppresses the move constructor
};
void demonstrate_suppressed_move() {
    std::vector<Buffer> v;
    Buffer b;
    b.data.resize(4096);
    v.push_back(std::move(b));        // copy construction is still viable
}
```

Copying `b.data` normally requires storage for 4096 characters; moving it can normally transfer the allocation. The standard specifies the container’s semantics, not a particular allocation count. The implicit definition of a copy operation is deprecated when the class has a user-declared destructor or the other copy operation, though diagnostics are not required.

"User-**declared**" is not "user-defined": `~T() = default;` written inside the class still suppresses the moves.

### What the implicit versions do

- Default constructor: default-initializes bases and members (Ch. 5 §5.4).
- Copy/move constructor: memberwise copy/move of bases then members, in declaration order — logically memberwise, though for a trivially copyable type implementations commonly lower this to a single `memcpy`.
- Copy/move assignment: memberwise assignment, in declaration order. Not guaranteed self-assignment-safe in general, though memberwise assignment of well-behaved members usually tolerates it.
- Destructor: destroys members in reverse declaration order, then bases.

A special member is **trivial** only when its language conditions hold, including suitable base/member operations and no disqualifying virtual machinery (Ch. 3 §3.5). A trivially copyable type may be copied as bytes. Trivial copyability is necessary, but in C++20 and later not by itself sufficient, for the primary `std::atomic<T>` template; `T` must also meet its cv and copy/move construction/assignment constraints. ABI register passing is a separate, implementation-specific classification (Ch. 4 §4.20).

Implicit special members have a conditional exception specification derived from the corresponding base/member operations. A defaulted move constructor over a `std::vector` member is normally `noexcept`; one potentially throwing member move makes the enclosing move potentially throwing. During reallocation, `vector` can then prefer copy construction when copying is available so that it can preserve its exception guarantee (Ch. 10 §10.3).

### Self-move

```cpp
class ResourceOwner {
    int id_ = -1;
public:
    ResourceOwner& operator=(ResourceOwner&& o) noexcept {
        if (this == &o) return *this;   // one possible documented policy
        id_ = std::exchange(o.id_, -1);
        return *this;
    }
};
```

Standard-library types generally permit self-move-assignment to leave a valid-but-unspecified value, so `v = std::move(v)` may legally empty `v`. A custom move assignment may use an identity check, or it may deliberately implement self-move as a valid destructive operation. State the postcondition and test it; do not assume memberwise code is safe.

---

## 6.2 Rule of Zero, Three, and Five — Core

**Rule of Three (C++98):** needing any one of destructor, copy constructor, or copy assignment usually means you need all three, because the reason you needed one — owning a raw resource — applies to all.

**Rule of Five (C++11):** add move constructor and move assignment, because declaring any of the first three suppresses their implicit generation.

**Rule of Zero — the target:** design classes that need none of them. Hold resources in types that already manage themselves (`std::vector`, `std::unique_ptr`, `std::string`, and RAII wrappers — Ch. 5 §5.8), and member semantics determine the enclosing class semantics automatically.

```cpp
class Session {                          // Rule of Zero — no special members declared
    std::unique_ptr<Connection> conn_;   // move-only, so Session is move-only automatically
    std::vector<Order> orders_;
    std::string venue_;
public:
    Connection* connection() const noexcept { return conn_.get(); }
    std::size_t order_count() const noexcept { return orders_.size(); }
    std::string_view venue() const noexcept { return venue_; }
};
```

### When you must write them

Custom operations are justified when the default memberwise semantics are wrong: manual resource ownership, intrusive membership, identity-preserving objects, or instrumentation that itself changes generation. Prefer isolating manual ownership in a single-purpose RAII wrapper and returning surrounding classes to the Rule of Zero.

```cpp
// POSIX example: ::close is a platform API, not standard C++.
class Handle {
    int h_ = -1;
public:
    explicit Handle(int h) noexcept : h_(h) {}
    ~Handle() { if (h_ != -1) ::close(h_); }
    Handle(Handle&& o) noexcept : h_(std::exchange(o.h_, -1)) {}
    Handle& operator=(Handle&& o) noexcept {
        if (this != &o) { if (h_ != -1) ::close(h_); h_ = std::exchange(o.h_, -1); }
        return *this;
    }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
```

What an interviewer checks for: `noexcept` on the moves (otherwise `vector` can prefer copying when copying is available, Ch. 10 §10.3), `std::exchange` to leave the source in a destructible state, self-assignment handling, releasing the old resource before taking the new one, and copies deleted explicitly rather than left implicit.

**Copy-and-swap** is a standard alternative for assignment: `T& operator=(T rhs) { swap(*this, rhs); return *this; }`. With a non-throwing `swap`, it is self-assignment-safe and can provide the strong exception guarantee (Ch. 10 §10.6). The by-value parameter is copied from an lvalue and moved from an rvalue. Either way it constructs a replacement object instead of reusing capacity already held by `*this`, which can be wasteful for a container-like class.

---

## 6.3 Defaulted and Deleted Functions — Core

`= default` asks the compiler for the implicit definition. `= delete` makes the function participate in overload resolution and then makes selecting it a compile error.

### `= default` subtleties

```cpp
struct A { A() = default; };            // defaulted on first declaration — not user-provided
struct B { B(); };  B::B() = default;   // defaulted out of line — user-provided
```

Only the first form can remain trivially default-constructible. Value-initialization with `A a{};` first zero-initializes `A`, whereas `B b{};` calls a user-provided default constructor without that preceding zero-initialization (Ch. 5 §5.4). Out-of-line defaulting can keep a definition out of a header (PIMPL, Ch. 44 §44.14), but changes triviality and reduces optimizer visibility unless link-time optimization recovers it.

A defaulted function can be implicitly deleted if the implicit definition would be ill-formed — a `const` member, a reference member, a move-only member for the copy operations, an inaccessible base destructor. `= default` on such a function is not an error; the function is simply deleted. `std::is_copy_constructible_v` and friends (available since C++17) let you query this.

### `= delete` beyond suppressing copies

```cpp
void process(double);
void process(int) = delete;              // ban implicit int→double at call sites

struct Rate {
    explicit Rate(double);
    Rate(bool) = delete;                    // reject a suspicious conversion
};

template <class T> void f(T);
template <> void f<char*>(char*) = delete;                // ban one specialization
```

Deleting beats the old "declare private, don't define" trick: the error surfaces at the call site, not as a link error, and it applies to friends and members too. Deleted functions still participate in overload resolution—a deleted `process(int)` beats `process(double)` for an `int` argument and then fails to compile rather than silently converting.

**Dangling-reference guard**, a common modern use:

```cpp
void set_name(std::string_view);
void set_name(std::string&&) = delete;   // reject a temporary that would dangle
```

Library APIs sometimes use deleted overloads or constraints to turn dangling patterns into compile errors. Such protection is API-specific; it does not make all `string_view` construction lifetime-safe.

---

## 6.4 Converting and Explicit Constructors — Core

A non-`explicit` constructor callable with one argument is a **converting constructor**: it can define an implicit conversion from the argument type to the class type. `explicit` requires callers to request the construction directly.

The next block is intentionally non-compiling at the line marked `error`:

```cpp
struct Meters { Meters(double); };            // converting
struct Feet   { explicit Feet(double); };

void f(Meters); void g(Feet);
void examples() {
    f(3.0);          // OK — implicit conversion
    g(3.0);          // error
    g(Feet{3.0});    // OK
}
```

Where implicit conversion bites: silent unit errors (`Meters m = 3.0;` where `3.0` was feet); `std::vector<int> v(10)` uses an `explicit` size constructor precisely so `v = 10;` does not compile; a generic forwarding constructor can out-rank a copy constructor; and only one user-defined conversion applies per implicit sequence (Ch. 4 §4.9).

`explicit` applies to multi-argument constructors too, because of brace-init:

The next block is intentionally non-compiling at the line marked `error`:

```cpp
struct P { explicit P(int, int); };
P p{1, 2};        // OK — direct-list-init
P q = {1, 2};     // error — copy-list-init rejects explicit
```

`explicit` conversion operators (C++11): `explicit operator bool() const` is the idiom for `optional`, `unique_ptr`, streams, `expected`. An explicit `operator bool` still works in *contextual conversion* contexts (`if (p)`, `while`, `!`, `&&`, `?:`) but not in `int x = p;`.

`explicit(bool)` (C++20) makes explicitness conditional, which the library uses so a converting constructor like `std::pair`'s is explicit exactly when a contained conversion is:

```cpp
template <class T>
class Wrapper {
    T value_;
public:
    template <class U>
    explicit(!std::is_convertible_v<U, T>)
    Wrapper(U&& u) : value_(std::forward<U>(u)) {}

    const T& get() const noexcept { return value_; }
};
```

**Guidance:** default single-argument constructors to `explicit`; opt out only when the conversion is genuinely value-preserving and cheap. `std::chrono::seconds` to `milliseconds` qualifies; `const char*` to `std::string_view` does not — it is cheap relative to a `std::string` allocation, but it still runs a length scan (`traits::length`), so "free" overstates it. `clang-tidy`'s `google-explicit-constructor` enforces the default.

---

## 6.5 Member Initializer Lists and Delegating Constructors — Core

```cpp
class Order {
    const uint64_t id_;
    Symbol sym_;
    std::vector<Fill> fills_;
public:
    Order(uint64_t id, Symbol s) : id_(id), sym_(s), fills_{} {}
    uint64_t id() const noexcept { return id_; }
    const Symbol& symbol() const noexcept { return sym_; }
    const std::vector<Fill>& fills() const noexcept { return fills_; }
};
```

The mem-init-list **initializes**; the constructor body **assigns**. For a class-type member, body-assignment means default-construct then assign—two semantic operations. Whether either operation allocates depends on the member type and value:

```cpp
class AssignedSymbol {
    Symbol sym_;
public:
    explicit AssignedSymbol(Symbol s) {
        sym_ = std::move(s);     // default-constructs sym_, then assigns
    }
    const Symbol& symbol() const noexcept { return sym_; }
};
```

The list is mandatory for `const` members, reference members, and bases or members with no default constructor.

Rules that trip people up:

1. **Members initialize in declaration order**, not the order written in the list (Ch. 5 §5.5) — `-Wreorder` catches the mismatch.
2. **NSDMIs (C++11) apply only when the member is absent from the list**; the list wins when both are present. Prefer NSDMIs for defaults shared across constructors — it removes duplication and prevents the "added a member, forgot a constructor" bug.
   ```cpp
   class C {
       int a = 0;
       int b = 0;
   public:
       explicit C(int x) : a(x) {}
       int sum() const noexcept { return a + b; }   // b is still 0
   };
   ```
3. An initializer may name a later-declared member, but reading that member before it has been initialized can produce an indeterminate value or undefined behavior. `-Wreorder` and related warnings catch many such mistakes.
4. Virtual bases are initialized by the most-derived class, so an intermediate class's mem-init entry for a virtual base is ignored unless it is the most-derived type (§6.14).

### Delegating constructors (C++11)

One constructor can call another of the same class in its mem-init-list:

```cpp
class Socket {
    int fd_; std::chrono::milliseconds timeout_;
    void validate() const {
        if (fd_ < 0 || timeout_.count() < 0)
            throw std::invalid_argument{"invalid socket settings"};
    }
public:
    Socket(int fd, std::chrono::milliseconds t) : fd_(fd), timeout_(t) { validate(); }
    Socket(int fd) : Socket(fd, std::chrono::milliseconds{100}) {}   // delegates
};
```

A delegating constructor may not also initialize members — delegation is the entire mem-init-list. The object's lifetime begins when the *target* constructor completes, so if the delegating constructor's own body then throws, **the destructor runs** — unlike a throw from a non-delegating constructor, where no destructor runs because the object never finished construction. Delegation cycles are ill-formed, no diagnostic required (not classic runtime UB); compilers typically catch a direct self-cycle at compile time but are not required to catch indirect ones.

---

## 6.6 Ref-Qualified Member Functions — Core

A member function can be qualified by the value category of the object it is called on, the same way `const` qualifies it:

```cpp
class Buffer {
    std::vector<char> data_;
public:
    const std::vector<char>& get() const&  { return data_; }              // lvalue: return a ref
    std::vector<char>        get() &&      { return std::move(data_); }   // rvalue: steal
};
auto a = Buffer{}.get();   // selects the rvalue overload and moves the member
```

| Qualifier | Binds to |
|---|---|
| (none) | lvalues and rvalues allowed by the function’s cv-qualification |
| `&` | lvalues allowed by its cv-qualification |
| `const&` | non-volatile lvalues and rvalues |
| `&&` | non-const rvalues (`const&&` is a distinct form) |

An unqualified and a ref-qualified non-static member cannot be overloaded when their parameter-type lists are otherwise the same. Distinct parameter lists are a separate overload question.

Uses: move-out accessors (`std::optional::value() &&` returns `T&&`); banning assignment to a temporary (`Value& operator=(const Value&) &`); and rejecting a dangling view —

```cpp
class Named {
    std::string s_;
public:
    std::string_view view() const&  { return s_; }
    std::string_view view() const&& = delete;   // reject Named{}.view()
};
```

— a useful guard against returning a view into a temporary (Ch. 13 §13.1). C++23 explicit object member functions (“deducing `this`,” Ch. 19 §19.6) can consolidate families of const and value-category overloads; ordinary ref-qualified overloads remain valid and often clearer.

---

## 6.7 Access Control and Inheritance — Core

Access specifiers control visibility, checked at compile time only — they say nothing about layout or lifetime.

| | `public` | `protected` | `private` |
|---|---|---|---|
| The class itself | yes | yes | yes |
| Derived classes | yes | yes | no |
| Everyone else | yes | no | no |

`class` defaults to private members and private inheritance; `struct` defaults to public for both—the only language difference between the two keywords.

```cpp
struct D1 : public    Base { };   // "is-a"
struct D3 : private   Base { };   // "implemented in terms of"
```

The inheritance specifier caps accessibility of inherited members. A `Derived*` → `Base*` conversion is accessible only where the base is accessible, so private inheritance does not provide a public subtype relationship.

### Composition versus inheritance

Composition says “has an implementation object”; public inheritance says “is substitutable for the base.” Prefer composition unless clients should be able to use the derived object wherever the base contract is accepted.

| Question | Composition | Public inheritance | Private inheritance |
|---|---|---|---|
| Expose component/base API? | Only through forwarding | Yes | No, except explicitly re-exposed names |
| Implicit `Derived*` → `Base*` for clients? | No | Yes | No |
| Override virtual customization? | Not directly | Yes | Yes |
| Couples representation to another type? | Member subobject | Base subobject | Base subobject |
| Typical use | Reuse implementation and control the surface | Model a substitutable interface | Niche implementation reuse requiring protected/virtual access |

A useful decision procedure is: first test substitutability and base invariants; if that fails, compose. If substitutability holds but no runtime-varying behavior is needed, a value member or template may still be simpler. Empty-base optimization and `[[no_unique_address]]` can affect layout, but neither should override the semantic choice (Ch. 3).

Details worth knowing:

- **Access is checked on the name, not the entity.** A private virtual function can still be called through public virtual dispatch — the basis of the **Non-Virtual Interface (NVI)** idiom: public non-virtual entry points that call private virtual customization points, giving the base control over pre/post conditions.
- Access does not affect overload resolution — an inaccessible overload can be selected and then reported as an access error, rather than skipped.
- `friend` grants full access; it is not inherited, not transitive, not reciprocal.
- Since C++23, later-declared non-variant, non-zero-sized members of one class have higher addresses regardless of access label. Padding and the separate standard-layout rules still matter (Ch. 3 §3.4).
- `protected` data members are effectively public to every future subclass — they freeze the representation. `protected` functions are fine.

---

## 6.8 Virtual Dispatch and Vtables — Core

**Dynamic polymorphism** means that a virtual call through a base pointer or reference selects the final overrider in the object’s dynamic type. The standard specifies that behavior; vtables and vptrs are common implementation machinery, not language-mandated objects. The following is a simplified single-inheritance sketch in an Itanium-family ABI; exact offsets, entries, and destructor slots vary by ABI and hierarchy.

```
Derived object:                Simplified vtable for Derived:
+----------+                   +--------------------------+
|  vptr*   | -------------->   | ABI metadata             |
+----------+                   +--------------------------+
|  member  |                   | type information*        |
+----------+                   +--------------------------+
|  member  |                   | &Derived::f              |
+----------+                   | &Base::g                 |  <- slot 1 (not overridden)
                                | destructor entries       |
                                +--------------------------+

*A primary vptr commonly appears at offset zero in this simple case; that is not
a portable layout rule.
```

- Common ABIs update dispatch state during base and derived construction. The language consequence is portable: a virtual call in a constructor or destructor dispatches no further than the class currently under construction or destruction (Ch. 5 §5.5).
- Changing virtual functions can change vtable layout and therefore break a binary interface, even when source still compiles. ABI-stable libraries require an explicit compatibility policy; “append only” is ABI-specific, not a universal guarantee (Ch. 44 §44.17).
- The Itanium ABI uses a *key function* to control vtable emission in common cases. Other ABIs make different choices, and linkers may merge duplicate definitions.

### The cost of a virtual call

When the compiler cannot devirtualize, a typical virtual call loads dispatch state and makes an indirect branch (Ch. 27 §27.6). A call site that repeatedly sees one target is often easier for branch prediction than one whose targets vary, but the result depends on processor, surrounding control flow, and target distribution. The larger opportunity cost may be the blocked inlining and consequent loss of constant propagation or loop optimization. It may instead be data locality: pointer-based polymorphic objects scattered across allocations can miss cache independently of dispatch. Measure call-site target distribution, cache misses, branch misses, and end-to-end latency rather than assigning a universal cycle count.

### Devirtualization

Compilers eliminate the indirection when they can prove the dynamic type: a local of known type, a `final` class or method (§6.10), or whole-program visibility under LTO (Ch. 40 §40.3). Profile-guided speculative devirtualization (Ch. 40 §40.9) emits a guarded fast path — `if (vptr == &Derived::vtable) { inlined body } else { indirect call }` — turning a mispredicted indirect branch into a predictable direct one for the common case. None of this is guaranteed; it depends on compiler, flags, and profile data.

The practical default: let a concrete type remain visible when the design naturally permits it, use `final` where it expresses a true leaf, and test LTO or profile-guided optimization before hand-rolling dispatch. Grouping work by type can improve prediction and locality only where reordering preserves semantics and latency requirements.

---

## 6.9 Abstract Classes and Pure Virtual Functions — Core

```cpp
struct Strategy {
    virtual void on_tick(const Tick&) = 0;   // pure virtual
    virtual ~Strategy() = default;
};
```

A class with at least one pure virtual function is abstract: it cannot be instantiated. Declarations can mention it by value in some contexts, but a definition or call that would create a by-value abstract object is ill-formed. Pointers and references are the normal interface forms, and pure virtual functions still occupy dispatch slots in common vtable implementations.

A pure virtual function may still have a definition, which a derived override can call with a qualified, non-virtual call:

```cpp
struct MyStrat final : Strategy {
    void on_tick(const Tick& t) override;
};

void Strategy::on_tick(const Tick&) { /* shared default logic */ }
void MyStrat::on_tick(const Tick& t) { Strategy::on_tick(t); /* ... */ }
```

The most common use is a pure virtual destructor, which forces abstractness while still requiring a body — the derived destructor always calls it:

```cpp
struct I { virtual ~I() = 0; };
I::~I() = default;   // definition is mandatory
```

Making a virtual call to a pure virtual function for the class currently under construction or destruction has undefined behavior. A direct qualified call instead names the definition and therefore requires one. Depending on call form and implementation, a bad call may become a link failure, a runtime handler, or something less diagnosable; do not rely on a trap (Ch. 5 §5.5). A derived class that leaves any pure virtual without a final overrider is itself abstract.

C++20 concepts (Ch. 17 §17.7) express a required-operations contract at compile time. Concept checking does not introduce runtime dispatch, though each selected implementation still has its ordinary runtime and code-size costs.

Interface guidance: keep interfaces narrow — each virtual is a vtable slot and an ABI commitment. Make the destructor `virtual ~T() = default;` public, or non-virtual and `protected:` (§6.11). Consider the NVI idiom (§6.7) for controlling an overridable step.

---

## 6.10 `override` and `final` — Core

Both are contextual keywords (C++11), valid only in this position.

The next block is intentionally non-compiling for `E`, demonstrating the diagnostic that `override` requests:

```cpp
struct B { virtual void f(int) const; };
struct D : B { void f(int) const override; };     // checked
struct E : B { void f(int)       override; };     // error — missing const, doesn't override
```

Without `override`, `E::f` would silently *hide* rather than override, and calls through `B*` would still reach `B::f`. Mismatch sources include `const`, ref-qualifiers, parameter types, return type, and `noexcept` — part of the function's type since C++17, so a `noexcept` override of a non-`noexcept` virtual is allowed but not the reverse. Write `override` on every overriding function; `-Wsuggest-override` enforces it.

`final` on a function prevents further overriding; on a class, prevents derivation.

```cpp
struct Base {
    virtual int f() { return 0; }
protected:
    ~Base() = default;   // this example does not permit ownership through Base*
};
struct Impl final : Base { int f() override { return 42; } };
void g(Impl& i) { i.f(); }   // may be devirtualized and inlined — the dynamic type can't be anything else
```

`final` can provide a proof useful to devirtualization (§6.8), but does not guarantee that a particular call is inlined. It also records a design constraint: the class cannot be a base. That may remove subclass-based test seams, so apply it to genuine implementation leaves rather than as decoration.

---

## 6.11 Virtual Destructors — Core

**The rule:** if an object may be deleted through a pointer to a base, that base needs a virtual destructor. Otherwise deleting a derived object through that base pointer has undefined behavior.

The following declaration compiles but is intentionally unsafe for base-pointer ownership; `-Wnon-virtual-dtor` diagnoses it:

```cpp
struct Base { virtual void f(); ~Base(); };   // bug: has a virtual function, non-virtual destructor
```

Heuristic: a class with virtual functions deserves an explicit destruction policy. Give it a public virtual destructor if clients own derived objects through the base; otherwise make a non-virtual destructor protected to prevent such deletion. Compiler warnings such as `-Wnon-virtual-dtor` help enforce the policy.

| Intent | Destructor |
|---|---|
| Polymorphic base, deleted through base pointer | `public: virtual ~T() = default;` |
| Polymorphic base, never owned via base pointer | `protected: ~T() = default;` — prevents client deletion through the base |
| Abstract base needing no other pure virtual | `public: virtual ~T() = 0;` with a definition |
| Value type / `final` leaf | non-virtual, ideally trivial |

Adding the first virtual function commonly adds a vptr and makes the class non-standard-layout and non-trivially-copyable. A virtual destructor is non-trivial, so destruction has semantic work per element, although an optimizer may eliminate empty calls when it can prove that is observable-equivalent. If the class is already polymorphic, the destructor usually reuses existing dispatch state rather than adding another pointer.

`shared_ptr`'s exception is worth stating precisely: its control block stores a type-erased deleter captured from the *constructing* expression, so `shared_ptr<Base> p = std::make_shared<Derived>();` destroys the `Derived` correctly even through a non-virtual `~Base` (Ch. 9 §9.3). The default deleter of `unique_ptr<Base>` deletes a `Base*` and cannot recover the original pointer type. Relying on the `shared_ptr` behavior is fragile: `shared_ptr<Base> p{new Derived}` captures `Derived*`, but `shared_ptr<Base> p{static_cast<Base*>(new Derived)}` captures `Base*` and has undefined behavior when destroyed.

---

## 6.12 Object Slicing — Core

Copying a derived object into a base-typed value copies only the base subobject — the derived part is sliced off.

```cpp
struct Base { int a; virtual void f(); virtual ~Base() = default; };
struct Derived : Base { int b; void f() override; };

void g(Base);
void demonstrate_slicing(Derived& d) {
    Base b = d;          // sliced — only a copied; b's vptr is Base's
    b.f();               // calls Base::f

    g(d);                // sliced at the call
    std::vector<Base> v;
    v.push_back(Derived{});  // sliced on insertion
}
```

The copy constructor invoked is `Base::Base(const Base&)`; the new complete object has dynamic type `Base`, so its virtual calls select `Base` final overriders. Slicing loses the derived data members **and** the dynamic type, not just the data.

Where it happens: passing a polymorphic type by value; storing one by value in a container; `base = derived` assignment (arguably worse — it can leave a mixed-state object if `operator=` only touches the base part); returning a base by value from a function that constructs a derived; catching an exception by value (`catch (std::exception e)` slices away the derived `what()`).

| Prevention | Effect |
|---|---|
| Pass/store by reference or pointer | The default fix |
| `std::vector<std::unique_ptr<Base>>` | Polymorphic container; one indirection per element |
| `Base(const Base&) = delete;` | Slicing becomes a compile error |
| Make the base abstract | Cannot be instantiated by value at all |
| `protected: Base(const Base&) = default;` | Derived classes can still copy themselves |
| `catch (const std::exception&)` | Always catch by `const&` |

---

## 6.13 Choosing a Polymorphism Strategy — Core / HFT Application — Core
C++ offers four ways to vary behavior over types, and an interview question like "design a strategy interface" is really asking which one fits the constraints.

**Runtime polymorphism (virtual dispatch, §6.8–§6.12).** An open, extensible type set cooperates through a common base. A call whose dynamic type remains unknown uses runtime dispatch; a compiler may still devirtualize when it proves the target.

**Static polymorphism (templates and CRTP).** A class can derive from a template instantiated with itself, so the base calls operations on the statically known derived type. CRTP introduces no virtual dispatch and makes inlining possible, but never mandatory.

```cpp
template <class Derived>
struct Strategy {
    void run(const Tick& t) {                     // ordinary direct call after instantiation
        static_cast<Derived*>(this)->on_tick(t);  // resolved at compile time
    }
    void on_tick(const Tick&) {}                  // default, hidden by Derived's own
};
struct MyStrat : Strategy<MyStrat> {
    void on_tick(const Tick&) { /* implementation */ }
};
```

The potential CRTP win is optimization across the call boundary—constant propagation, dead-code elimination, or vectorization—not merely avoiding an indirect call. The magnitude depends on the body and workload. The derived type is incomplete while the base specialization is being formed, so uses that require a complete type must be delayed until instantiation of a suitable member. If `A` correctly derives from `Strategy<A>`, another `struct B : Strategy<A>` can make the downcast’s precondition false at runtime; a private base constructor with `friend Derived` can prevent that misuse. C++23 explicit object members provide an alternative for many mixins:

```cpp
struct Strategy {
    template <class Self> void run(this Self&& self, const Tick& t) { self.on_tick(t); }
};
struct MyStrat : Strategy { void on_tick(const Tick&); };   // no template parameter on the base
```

**Closed-set variants.** `std::variant` plus `std::visit` represents a set of alternatives fixed where the variant is declared. The variant stores one alternative in its own object and does not require inheritance or RTTI; an alternative may, of course, own allocations. The dispatch strategy—branches, a table, or another transformation—is an implementation choice (Ch. 15 §15.4).

**Type erasure.** A wrapper captures a concrete type at construction and later exposes only a chosen operation set. The stored types need not inherit from a shared user-visible base. `std::function`, `std::move_only_function` (C++23), `std::any`, and `std::shared_ptr`’s stored deleter use forms of type erasure.

```cpp
class Drawable {
    struct Concept {
        virtual ~Concept() = default;
        virtual void draw(std::ostream&) const = 0;
        virtual std::unique_ptr<Concept> clone() const = 0;
    };
    template <class T>
    struct Model final : Concept {
        T obj_;
        explicit Model(T o) : obj_(std::move(o)) {}
        void draw(std::ostream& os) const override { obj_.draw(os); }
        std::unique_ptr<Concept> clone() const override {
            return std::make_unique<Model>(*this);
        }
    };
    std::unique_ptr<Concept> self_;
public:
    template <class T>
        requires (!std::same_as<std::remove_cvref_t<T>, Drawable>) &&
                 std::copy_constructible<std::decay_t<T>> &&
                 requires (const std::decay_t<T>& value, std::ostream& os) {
                     value.draw(os);
                 }
    Drawable(T&& x)
        : self_(std::make_unique<Model<std::decay_t<T>>>(std::forward<T>(x))) {}

    Drawable(const Drawable& o) : self_(o.self_ ? o.self_->clone() : nullptr) {}
    Drawable(Drawable&&) noexcept = default;
    Drawable& operator=(Drawable o) noexcept {
        self_.swap(o.self_);
        return *this;
    }

    explicit operator bool() const noexcept { return static_cast<bool>(self_); }
    void draw(std::ostream& os) const { self_->draw(os); }
};
std::vector<Drawable> shapes;   // value semantics over unrelated types
```

`T` needs no inheritance or virtual functions. This copyable wrapper constrains it to be copy-constructible and to provide `draw(std::ostream&) const`; a separate move-only erasure could accept move-only targets. This implementation gives value semantics, performs one dynamic allocation per non-empty construction/copy, and makes an indirect call. `draw` has the precondition that the wrapper is non-empty; a production API might throw, terminate, or make the empty state unrepresentable. Type erasure as a technique does not require allocation: a wrapper can use fixed inline storage or be a non-owning reference. Inline storage trades a size/alignment limit and larger wrapper objects for fewer allocations; moving an over-aligned, throwing-move, or oversized target needs an explicit policy.

### Decision table

| Axis | Virtual dispatch | Templates / CRTP | Closed-set `variant` | Type erasure |
|---|---|---|---|---|
| Type set | Open at runtime through derived classes | Extensible in source, fixed in each instantiation | Closed where alternatives are listed | Open at wrapper construction |
| ABI boundary | Usable only under a defined compiler/platform ABI contract | Usually exposes definitions and couples callers to instantiations | Layout includes every alternative; poor opaque boundary | Can hide concrete types, but wrapper ABI still needs a contract |
| Hot call site | Indirect unless devirtualized; pointer locality may dominate | Direct and optimization-visible; may multiply code | Runtime alternative test; objects remain inline | Usually indirect; allocation depends on wrapper/storage policy |
| Ownership | References, raw observers, or smart pointers must state lifetime | Often by value; caller knows the type | Owns one inline alternative | Can own inline/indirectly or observe; wrapper decides |
| Code-size pressure | Shared non-template implementations can be compact | Instantiation per used type/call pattern | Visitation combinations can grow rapidly | Model/manager code per stored type |
| Best fit | Cooperative open hierarchy and runtime substitution | Concrete type reaches performance-sensitive caller | Exhaustive operations over a fixed set | Unrelated types behind a value or reference boundary |

### HFT application

Suppose built-in strategies are known per build. A templated loop can keep each concrete strategy visible, while a `variant` can hold a closed runtime choice. If arbitrary plugins are loaded at startup, some runtime boundary is unavoidable: the host cannot statically inline code whose type it did not compile.

A practical hybrid places an ABI-controlled virtual or C-function-table interface at plugin discovery and ownership boundaries, then calls a coarse operation such as `process_batch(span<const Tick>)`. The plugin’s concrete implementation can run a direct, inlinable loop inside that one runtime call. This amortizes dispatch; it does not make the boundary disappear. If requirements demand swapping an arbitrary plugin between individual messages, each message needs some runtime target selection. The design choices are then to accept and measure it, batch where latency constraints permit, or narrow the runtime set so a `variant`/tag dispatch is possible.

---

## 6.14 Deep Dive: Constructor History, Static Members, Bit-Fields, Multiple Inheritance, and Cross-DSO RTTI — Deep dive
This section is skippable on a first pass; it covers standardization history, ABI internals, and niche layout tools rather than material tested directly as often as §6.1–§6.13.

### Inherited constructors

```cpp
struct Base { Base(int); Base(int, int); };
struct Derived : Base { using Base::Base; int extra_ = 0; };
Derived d{1};   // uses Base(int); extra_ gets its NSDMI
```

`using Base::Base;` makes selected base constructors available when constructing `Derived`. Default, copy, and move constructors are not inherited; generation is considered for `Derived` itself. Derived members still use their default member initializers or default-initialization. With multiple bases, two viable inherited constructors can make a call ambiguous. Inheriting constructors fits thin wrappers; once the derived type owns invariants, writing a constructor makes those invariants visible.

### Static class members

A static data member is one instance per program (or per thread with `thread_local`), not part of object layout.

```cpp
struct Counter {
    static inline std::atomic<uint64_t> total{0};   // C++17 — definition in the header
    static constexpr int kMax = 1000;                // implicitly inline since C++17
};
```

Before C++17, a static data member had to be declared in the class and defined in exactly one `.cpp`; a `constexpr` static whose address was taken (ODR-used) needed the same out-of-line definition, producing the classic "undefined reference to `Foo::kMax`" link error. C++17's `static inline` puts the definition in the header with no `.cpp` needed, and makes `constexpr` static data members implicitly inline. Static member functions have no `this`, cannot be `virtual` or `const`-qualified, and their address is a plain function pointer rather than a pointer-to-member. They can be trampolines for callback APIs accepting a compatible plain function pointer; exact language-linkage and calling-convention requirements remain part of that API:

```cpp
struct Handler {
    void on_event(Event&);
    static void trampoline(void* ctx, Event& e) { static_cast<Handler*>(ctx)->on_event(e); }
};
```

A `static inline` non-const member with a dynamic initializer can participate in static-initialization-order failures (Ch. 5 §5.9); prefer constant initialization where possible and use `constinit` to require it. Static members occupy separate storage from class objects. Common object formats place suitable definitions in data or zero-initialized-data sections; if mutable objects share a cache line, concurrent writes can false-share.

### Bit-fields

Full treatment of alignment and object representation belongs to Chapter 3; this is the class-design angle.

```cpp
struct Flags {
    unsigned ready    : 1;
    unsigned priority : 3;
    unsigned          : 0;    // end the current allocation unit
    unsigned seq      : 20;
};
```

Allocation details—such as left-to-right versus right-to-left packing and whether a field may straddle an allocation unit—are implementation-defined. A one-bit signed field represents only `0` and `-1`; use `bool` or an explicitly unsigned type when those are the intended values. A bit-field is not independently addressable, so its address cannot be taken and a non-const reference cannot bind to it.

Adjacent non-zero-width bit-fields form one memory location under the C++ memory model, so concurrent non-atomic writes to different adjacent fields race. A zero-width unnamed field separates memory locations. Implementations commonly use load/mask/store sequences for writes, which can introduce dependency and contention costs; inspect generated code and measure the packed layout rather than assuming one instruction sequence.

Do not use native bit-field layout as a portable wire format. Use explicit shifts and masks over a fixed-width integer, together with specified byte order. Bit-fields can be defensible for compact in-memory structures controlled by one toolchain when measured cache-density gains exceed access costs.

### Multiple and virtual inheritance

```cpp
struct A { int a; virtual void f(); virtual ~A() = default; };
struct B { int b; virtual void g(); virtual ~B() = default; };
struct C : A, B { int c; };
```

Under the Itanium ABI, `C` gets two vptrs, one per base subobject. Converting `C*` to `B*` requires a pointer adjustment that the compiler emits automatically, so `(void*)` casts of a `B*` and the originating `C*` can legitimately differ. When `C` overrides `B::g`, `B`'s vtable slot cannot point directly at `C::g` (which expects a `C*` `this`), so the ABI emits a non-virtual **thunk** that adjusts `this` and jumps to `C::g` — visible in `nm` output as a `_ZThn`-prefixed symbol.

Diamond inheritance without `virtual` gives two copies of the shared base, making unqualified member access ambiguous. Virtual inheritance shares one base subobject. In common ABIs its offset depends on the most-derived type and is recovered through runtime layout metadata. The most-derived constructor initializes the virtual base, so adding or changing one may require updates throughout the hierarchy. A downcast from a virtual base cannot use `static_cast`; `dynamic_cast` can perform it when the source type is polymorphic. A class with a virtual base is neither standard-layout nor trivially copyable.

Multiple inheritance is easiest to reason about when combining state-free abstract interfaces. Pointer adjustment is normally a small arithmetic operation but may interact with thunks and dispatch. Virtual inheritance solves genuine shared-base semantics at the cost of more complex layout and construction rules; avoid it in latency-sensitive designs unless the semantics require it, then measure the actual access paths. Standard iostreams provide a familiar virtual-inheritance example.

### Covariant returns and the clone pattern

An override may return a pointer or reference to a more-derived type than the base's version — pointers and references only, not by-value and not smart pointers:

```cpp
struct Shape { virtual Shape* clone() const; virtual ~Shape() = default; };
struct Circle : Shape { Circle* clone() const override; };   // legal
```

`std::unique_ptr<Circle> clone() const override` against a base returning `std::unique_ptr<Shape>` does not compile — smart-pointer class templates are unrelated types, not covariant, regardless of what they wrap. The standard workaround is NVI with a raw covariant helper:

```cpp
class Shape {
    virtual Shape* do_clone() const = 0;          // covariant, private
public:
    std::unique_ptr<Shape> clone() const { return std::unique_ptr<Shape>(do_clone()); }
    virtual ~Shape() = default;
};
class Circle : public Shape {
    Circle* do_clone() const override { return new Circle(*this); }
public:
    std::unique_ptr<Circle> clone() const {       // shadows, non-virtual, exact type
        return std::unique_ptr<Circle>(do_clone());
    }
};
```

Parameters are never contravariant in C++: an override must match parameter types exactly, or it declares a hiding overload instead, which `override` correctly rejects.

### RTTI, `dynamic_cast`, and cross-DSO pitfalls

`typeid` works for any type. Obtaining a glvalue expression’s dynamic type, or using checked runtime downcasts and side-casts, requires a **polymorphic** source type—one with at least one virtual function.

```cpp
const std::type_info& t = typeid(*base_ptr);   // dynamic type — evaluates the operand
std::type_index idx{t};                        // copyable, comparable, hashable wrapper
```

`typeid` on a non-polymorphic expression yields the static type and generally does not evaluate the expression. If `p` points to a polymorphic type, `typeid(*p)` evaluates the dereference and throws `std::bad_typeid` when `p` is null.

```cpp
Derived* d = dynamic_cast<Derived*>(base_ptr);   // nullptr on failure
Derived& r = dynamic_cast<Derived&>(base_ref);   // throws std::bad_cast on failure
```

`dynamic_cast` supports checked downcasts and cross-casts in a polymorphic hierarchy. A failed pointer cast returns null; a failed reference cast throws. The standard gives no general complexity or implementation algorithm: common ABIs consult runtime type metadata, and cost depends on hierarchy shape, cast direction, implementation, and cache state. Measure a representative success/failure mix before placing repeated casts in a latency budget. Often the operation belongs in a virtual function; a closed set can use `variant`, and a deliberately maintained kind tag can support a measured manual dispatch design. Flags such as GCC/Clang `-fno-rtti` are non-standard toolchain options and can affect libraries and binary interfaces.

Across dynamic-library boundaries, RTTI behavior depends on the platform ABI, symbol visibility, loader, and whether both sides use compatible definitions and toolchains. Duplicate or hidden type metadata can cause failures on some systems. Treat plugin RTTI as an ABI-design issue: test the supported build matrix and export exactly the symbols required by that platform rather than prescribing one portable loader flag.

---

## Recall Card — Core
- A user-declared destructor or copy operation suppresses the implicit moves; a user-declared move deletes the copies. "Declared," not "defined."
- Rule of Zero by holding self-managing members; customize special members when default memberwise ownership or value semantics are wrong.
- The mem-init list initializes; the body assigns. Declaration order governs initialization order regardless of list order.
- A base deleted through a base pointer needs a virtual destructor. A protected non-virtual destructor can prohibit that ownership model.
- Slicing removes the derived data **and** the dynamic type — the sliced object is genuinely base-typed.
- Choose virtuals for a cooperative open hierarchy, templates/CRTP when the concrete type reaches the caller, `variant` for a closed set, and type erasure for unrelated types behind one operation set.
- Dispatch cost includes optimizer visibility, target prediction, object locality, ownership, allocation policy, and code size. Measure the actual workload.

## Questions — Core
1. Which special-member declarations suppress which others, and does `= default` count?
2. A type holding a populated `std::vector` gains a logging destructor. What changes when an rvalue is inserted into another vector and when that outer vector reallocates?
3. When does the Rule of Five apply, versus the Rule of Zero?
4. Why does defaulting inside the class body differ from defaulting out of line?
5. Give two uses of `= delete` other than suppressing copy operations.
6. What does `explicit(bool)` let you express that plain `explicit` cannot?
7. What happens if the body of a delegating constructor throws, and why does that differ from a non-delegating constructor?
8. Why is a base class's virtual destructor sometimes the wrong default?
9. Walk through what a `Base b = derived;` assignment leaves behind, precisely.
10. Given a plugin architecture and a hot per-message strategy dispatch, which polymorphism mechanism fits which part, and why?

## Code-Reading Puzzle: Why Did Move Disappear? — Core
```cpp
class OrderBatch {
    std::vector<Order> orders_;
public:
    void add(Order o) { orders_.push_back(std::move(o)); }
    ~OrderBatch() { metrics::record("batch_destroyed", orders_.size()); }
};

std::vector<OrderBatch> batches;
for (int i = 0; i < 100'000; ++i) {
    auto batch = make_populated_batch();
    batches.push_back(std::move(batch));
}
```

Which implicit declarations disappear, why can the rvalue still bind to a copy constructor, and which copies can allocate? Give the smallest repair that retains the destructor and supports both copy and move. Then give the declarations for a move-only design, remembering that declaring a move constructor also prevents an implicit default constructor.

## Implementation Exercise — Core
Design a `MarketDataHandler` interface for a system that processes exchange feed messages. The concrete plugin is unknown until startup, handlers can be swapped without rebuilding the host, and message processing is latency-sensitive. Use the decision table in §6.13 to identify the unavoidable runtime boundary. Then sketch a hybrid that dispatches once per bounded batch and runs a concrete loop within the plugin. State the batching latency trade-off and the measurements that would decide whether per-message dispatch is already acceptable.

## Prerequisites for Chapter 7 — Core
Chapter 7 covers raw allocation—`operator new`/`operator delete`, alignment, arenas, and pools. Before continuing, be able to explain why `vector` may prefer a copy when move construction can throw (§6.1, Ch. 10 §10.3), distinguish storage allocation from object construction (Ch. 5 §5.1), and identify which properties permit bytewise copying (§6.1, Ch. 3 §3.5).
