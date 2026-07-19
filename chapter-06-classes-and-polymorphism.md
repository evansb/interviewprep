# Chapter 6 — Classes and Polymorphism

*Interview-focused revision notes. The theme: a class is a contract with the compiler about what it may generate for you and what it must dispatch at runtime. Every topic here is either "which function did the compiler write?" or "how much does the indirection cost?"*

---

## 6.1 Special Member Functions

Six functions the compiler can generate:

| Function | Signature | Generated when |
|---|---|---|
| Default constructor | `T()` | No other constructor is user-declared |
| Destructor | `~T()` | Not user-declared |
| Copy constructor | `T(const T&)` | No move operations user-declared; **deprecated** if a destructor or copy assignment is user-declared |
| Copy assignment | `T& operator=(const T&)` | Same |
| Move constructor | `T(T&&)` | **No** user-declared copy ctor, copy assign, move assign, or destructor |
| Move assignment | `T& operator=(T&&)` | Same condition |

Since C++20, `operator==` and `operator<=>` are also defaultable (§6.3, Ch. 19 §19.5) but are not "special members."

### The generation rules, precisely

The table's most consequential entry: **declaring a destructor suppresses the implicit move operations.** The class then falls back to copying — silently, with no diagnostic:

```cpp
struct Buffer {
    std::vector<char> data;
    ~Buffer() { log("destroyed"); }        // ← kills the move constructor
};
std::vector<Buffer> v;
v.push_back(Buffer{});                      // COPIES the vector<char>. Heap allocation per push.
```
This is the single most expensive accidental performance bug in modern C++ and the reason for the Rule of Five (§6.2). The copy operations remain generated (for backward compatibility) but their generation is **deprecated** when a destructor or the other copy operation is user-declared — a deprecation that has never been enforced.

Note "user-**declared**," not "user-defined": `~T() = default;` written in the class still suppresses the moves. Writing `= default` for a special member is not free of consequences.

### What the implicit versions do

- Default ctor: default-initializes bases and members (Ch. 5 §5.4). Does nothing for scalars.
- Copy/move ctor: **memberwise** copy/move of bases then members, in declaration order. Not `memcpy` — memberwise, though for a trivially copyable type the compiler emits `memcpy`.
- Copy/move assignment: memberwise assignment. **Not self-assignment-safe by construction**, but memberwise assignment of well-behaved members is.
- Destructor: destroys members in reverse declaration order, then bases.

A special member is **trivial** if it is not user-provided, the class has no virtuals or virtual bases, and every corresponding base/member operation is trivial (Ch. 3 §3.5). Triviality is what unlocks `memcpy`, register passing (Ch. 4 §4.17), and `std::atomic<T>`.

Implicit definitions are also **implicitly `noexcept`** if all the corresponding member operations are — which is why a move constructor that forwards to `std::vector`'s (which is `noexcept`) is itself `noexcept` for free, and why one `noexcept(false)` member poisons the whole class for `vector` reallocation (Ch. 10 §10.3).

### Move assignment and self-move

```cpp
T& operator=(T&& o) noexcept {
    if (this == &o) return *this;   // often needed; the standard only requires
    ...                             // "valid but unspecified" after self-move
}
```
The standard library's own types permit self-move-assignment to leave a valid-but-unspecified value, which means `v = std::move(v)` may legally empty `v`. Algorithms like `std::sort` and `std::remove` can self-move-assign. The copy-and-swap idiom is self-assignment-safe automatically; a hand-written move assignment usually is not.

---

## 6.2 Rule of Zero, Three, and Five

**Rule of Three (C++98):** if you need any of destructor, copy constructor, or copy assignment, you almost certainly need all three — because the reason you needed one (owning a raw resource) applies to all.

**Rule of Five (C++11):** add the move constructor and move assignment, because declaring any of the three suppresses their implicit generation.

**Rule of Zero (the target state):** design classes so you need *none* of them. Hold resources in types that already manage themselves (`std::vector`, `std::unique_ptr`, `std::string`, RAII wrappers — Ch. 5 §5.8), and the compiler generates correct, `noexcept`, optimal copies and moves for free.

```cpp
// Rule of Zero — no special members declared at all
class Session {
    std::unique_ptr<Connection> conn_;   // move-only ⇒ Session is move-only, automatically
    std::vector<Order> orders_;
    std::string venue_;
};
```
The class is automatically move-only (because `unique_ptr` is), correctly moving, correctly destroying, `noexcept`-move if the members are, and it costs zero maintenance.

### When you must write them

Exactly one situation: **you own a raw resource that isn't already wrapped** — an OS handle, a C library pointer, a slab offset, an intrusive list hook. And even then the correct move is usually to write a one-purpose RAII wrapper (a `unique_ptr` with a custom deleter, Ch. 9 §9.2, or a `unique_resource`-style class) and go back to the Rule of Zero for everything else.

### The Rule of Five checklist

```cpp
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
Points an interviewer looks for: `noexcept` on the moves (or `vector` copies instead — Ch. 10 §10.3), `std::exchange` to leave the source destructible, self-assignment handling, releasing the old resource in move-assignment, and explicitly deleting copies rather than leaving them implicit.

**Copy-and-swap** is the classic alternative: implement copy assignment as `T& operator=(T rhs) { swap(*this, rhs); return *this; }`. It is self-assignment-safe, strongly exception-safe (Ch. 10 §10.6), and handles both copy and move assignment in one function via the by-value parameter. Its cost: it always constructs a full copy even when assignment could reuse the existing buffer — for a `vector`-like class with sufficient capacity that's an unnecessary allocation. Idiomatic and safe for resource handles; wrong for containers on a hot path.

---

## 6.3 Defaulted and Deleted Functions

**`= default`** asks the compiler for the implicit definition. **`= delete`** makes the function participate in overload resolution and then makes selecting it a compile error.

### `= default` subtleties

```cpp
struct A { A() = default; };            // defaulted on FIRST declaration → not user-provided
struct B { B(); };  B::B() = default;   // defaulted OUT OF LINE → user-PROVIDED
```
Only the first keeps the type trivially default constructible and makes `B b{}` zero-initialize (Ch. 5 §5.4). Out-of-line defaulting is a legitimate technique — it keeps the definition out of the header (PIMPL, Ch. 44 §44.14) at the cost of triviality and inlining.

A defaulted function can be **implicitly deleted** if the implicit definition would be ill-formed (a const member, a reference member, a move-only member for the copy operations, an inaccessible base destructor). `= default` on such a function is not an error; the function is just deleted, silently. Since C++20 you can query with `std::is_copy_constructible_v` etc.

`= default` also cannot change the signature: `T(T&) = default` (non-const) is allowed only in narrow cases and is generally a mistake.

### `= delete` uses beyond suppressing copies

```cpp
class NonCopyable { 
    NonCopyable(const NonCopyable&) = delete; 
    NonCopyable& operator=(const NonCopyable&) = delete; 
};

void process(double);
void process(int) = delete;              // ban implicit int→double at call sites
void process(char) = delete;

struct T { void* operator new(std::size_t) = delete; };   // stack-only type

template <class T> void f(T);
template <> void f<char*>(char*) = delete;                // ban one specialization

// C++20: with a reason
void legacy() = delete("use modern_api() instead");        // C++26 gives the message form
```
Deleting is superior to the old "declare private and don't define" trick because the error is at the call site with a clear message, rather than a link error, and it applies to friends and members too.

**The dangling-reference guard** is the modern use worth naming:
```cpp
std::string_view trim(const std::string&&) = delete;       // reject temporaries
void set_name(std::string_view);
void set_name(std::string&&) = delete;
```
C++23 added exactly these deleted overloads to several standard functions (`std::format` with temporary `string_view` arguments, `std::regex` with temporaries) to turn dangling into a compile error.

**Deleted functions still participate in overload resolution** — that's the point. A deleted `f(int)` beats `f(double)` for an `int` argument and then errors, rather than silently converting.

---

## 6.4 Converting and Explicit Constructors

A constructor callable with one argument is a **converting constructor**: it defines an implicit conversion from the argument type to the class type. `explicit` disables that.

```cpp
struct Meters { Meters(double); };            // converting
struct Feet   { explicit Feet(double); };

void f(Meters); void g(Feet);
f(3.0);          // OK — implicit conversion
g(3.0);          // ERROR
g(Feet{3.0});    // OK
```

### Where implicit conversion bites

- **Silent unit and semantic errors** — `Meters m = 3.0;` where 3.0 was feet.
- **`std::vector<int> v(10);`** — the size constructor is `explicit` precisely so `v = 10;` doesn't compile.
- **A single-argument template constructor** becomes a conversion from *everything*, which is how forwarding-constructor hijacking (Ch. 4 §4.6) causes ambiguous or wrong overload resolution.
- **At most one user-defined conversion applies** in a sequence (Ch. 4 §4.6), which is why `std::string s = "x"` works (`const char*` → `string`, one conversion) but a function taking `const std::string&` called with a `char` array via two user conversions does not.

### Rules

- `explicit` applies to **multi-argument constructors too** (since C++11 it matters, because of brace-init):
  ```cpp
  struct P { explicit P(int, int); };
  P p{1,2};        // OK — direct-list-init
  P q = {1,2};     // ERROR — copy-list-init rejects explicit
  ```
- **`explicit` conversion operators** (C++11): `explicit operator bool() const` is the standard idiom for `optional`, `unique_ptr`, streams, and `expected`. Explicit `operator bool` is still usable in *contextual conversion* contexts — `if (p)`, `while`, `!`, `&&`, `?:` — but not in `int x = p;` or `p + 1`. Before C++11 the "safe bool idiom" (returning a pointer-to-member) existed for exactly this.
- **`explicit(bool)` (C++20)** — conditional explicitness, used pervasively in the standard library so that e.g. `std::pair`'s converting constructor is explicit iff either element's conversion is:
  ```cpp
  template <class U>
  explicit(!std::is_convertible_v<U, T>) Wrapper(U&& u);
  ```

**Guidance:** make every single-argument constructor `explicit` unless the conversion is genuinely value-preserving and semantically free (e.g. `std::string_view` from `const char*`, `std::chrono::seconds` to `milliseconds`). Default to `explicit`; opt out deliberately. `clang-tidy`'s `google-explicit-constructor` enforces this.

---

## 6.5 Delegating and Inherited Constructors

### Delegating constructors (C++11)

One constructor can call another of the same class in its member-initializer list:

```cpp
class Socket {
    int fd_; std::chrono::milliseconds timeout_;
public:
    Socket(int fd, std::chrono::milliseconds t) : fd_(fd), timeout_(t) { validate(); }
    Socket(int fd) : Socket(fd, std::chrono::milliseconds{100}) {}   // delegates
};
```
Rules and consequences:
- A delegating constructor **may not also initialize members** — the delegation is the entire mem-init-list.
- **The object's lifetime begins when the *target* constructor completes.** So if the delegating constructor's body then throws, the **destructor runs** — unlike a throw from a non-delegating constructor. This is a genuinely non-obvious difference and a good interview detail.
- Delegation cycles are UB (in practice, infinite recursion; compilers usually diagnose direct cycles).
- Default arguments (Ch. 4 §4.8) are the alternative and produce less code, but delegation allows different logic per arity and works for virtuals.

### Inherited constructors (C++11, fixed in C++17)

```cpp
struct Base { Base(int); Base(int, int); };
struct Derived : Base { using Base::Base; int extra_ = 0; };
Derived d{1};      // uses Base(int); extra_ gets its NSDMI
```
`using Base::Base;` makes all of the base's constructors usable to construct `Derived`.

- **The default, copy, and move constructors are never inherited** — they're always generated (or not) for `Derived` itself.
- Derived members are **not** initialized by the inherited constructor — only NSDMIs apply. A derived member without an NSDMI is left default-initialized (indeterminate for scalars). This is the main hazard.
- **C++17 (P0136) rewrote the semantics**: inherited constructors are no longer "new constructors declared in Derived" but are found by name lookup and invoke the base constructor directly. This fixed accessibility, `explicit`, and default-argument bugs, and changed observable behaviour between C++14 and C++17 — worth knowing when a codebase's standard version moves.
- With multiple inheritance, inheriting two constructors of the same signature is ambiguous at the point of use.

Use inherited constructors for thin wrappers (exception hierarchies deriving from `std::runtime_error` is the canonical case) and avoid them when the derived class adds state.

---

## 6.6 Member Initializer Lists

```cpp
class Order {
    const uint64_t id_;
    Symbol sym_;
    std::vector<Fill> fills_;
public:
    Order(uint64_t id, Symbol s) : id_(id), sym_(s), fills_{} {}   // initialization
};
```

### Why the list rather than the body

The mem-init-list performs **initialization**; the constructor body performs **assignment**. For a member of class type, body-assignment means default-construct-then-assign — two operations instead of one, and a wasted allocation for a `std::string` or `std::vector`.

```cpp
Order(Symbol s) { sym_ = s; }      // default-constructs sym_, then assigns. 
```
And it is **mandatory** for:
- `const` members,
- reference members,
- base classes and members without a default constructor,
- members whose default construction is expensive or impossible.

### The rules that trip people

1. **Members are initialized in declaration order**, not the order written in the list (Ch. 5 §5.9). `-Wreorder`.
2. **NSDMIs (C++11) and mem-init-list entries interact**: the list wins; the NSDMI applies only when the member isn't in the list. Prefer NSDMIs for defaults shared across all constructors — it eliminates duplication and prevents "I added a member and forgot one constructor," which is a real bug class.
   ```cpp
   class C { int a = 0; int b = 0; C(int x) : a(x) {} };   // b still 0 — NSDMI applies
   ```
   Caveat: an NSDMI makes the class non-trivially-default-constructible and non-aggregate before C++14 (Ch. 3 §3.5, Ch. 5 §5.5).
3. **You may initialize a member from another member**, but only one earlier in declaration order — and the compiler won't stop you from using a later one.
4. **A member cannot be initialized in a delegating constructor's list** (§6.5).
5. **Virtual bases are initialized by the most-derived class**, so an intermediate class's mem-init for a virtual base is ignored when it isn't most-derived (§6.16).
6. **Function-try-blocks** on a constructor can catch exceptions from member initialization but cannot access the members and must (implicitly does) rethrow.

**Low-latency angle:** the mem-init list is where "one construction instead of construct-plus-assign" lives, and for a struct of PODs the difference is between a single stored constant and a store followed by a reload. It also determines whether the constructor is trivial at all — which decides register passing (Ch. 4 §4.17) and container `memcpy` paths (Ch. 3 §3.5).

---

## 6.7 Ref-Qualified Member Functions

C++11 lets a member function be qualified by the value category of the object it's called on — the same way `const` qualifies it:

```cpp
class Buffer {
    std::vector<char> data_;
public:
    const std::vector<char>& get() const&  { return data_; }              // lvalue: return a ref
    std::vector<char>        get() &&      { return std::move(data_); }   // rvalue: steal
};
Buffer b;
auto a = b.get();                 // copy — b still owns its data
auto c = Buffer{}.get();          // MOVE — no allocation
```

The implicit object parameter participates in overload resolution like any other argument (Ch. 4 §4.6):

| Qualifier | Binds to |
|---|---|
| (none) | lvalues, and rvalues (legacy) |
| `const` | const and non-const lvalues and rvalues |
| `&` | **lvalues only** |
| `const&` | anything (const lvalue ref binds to rvalues too) |
| `&&` | **rvalues only** |
| `const&&` | rvalues (rare; used to *ban* a case) |

**You cannot mix**: if any overload of a name is ref-qualified, all must be.

### Uses

1. **Move-out optimization** as above — `std::optional::value() &&` returns `T&&`, `std::move(opt).value()` moves the contained object out. Same for `std::variant`, `std::get` on tuples, and `std::expected`.
2. **Preventing assignment to a temporary:**
   ```cpp
   class Value { public: Value& operator=(const Value&) & = default; };
   Value{} = other;      // ERROR — this is legal for built-in types' class analogues without &
   ```
   Built-in types already reject `int{} = 3`; ref-qualifiers let class types match that.
3. **Banning dangling accessors:**
   ```cpp
   std::string_view view() const&  { return s_; }
   std::string_view view() const&& = delete;      // reject Temp{}.view()
   ```
   This is the systematic fix for the `string_view`-into-a-temporary family (Ch. 5 §5.7, Ch. 13 §13.3).

C++23's **deducing `this`** (Ch. 19 §19.11) subsumes much of this: one templated `template <class Self> auto&& get(this Self&& self)` handles const/non-const/lvalue/rvalue in a single function, eliminating the four-overload boilerplate and the code bloat that came with it.

---

## 6.8 Static Class Members

A **static data member** is a namespace-scope variable scoped to the class: one instance per program (or per thread with `thread_local`), no `this`, not part of the object's layout.

```cpp
struct Counter {
    static inline std::atomic<uint64_t> total{0};   // C++17 — definition IN the header
    static constexpr int kMax = 1000;               // implicitly inline since C++17
};
```

### The definition rules — a chronology worth knowing

| Standard | How to define a static data member in a header |
|---|---|
| C++98/03 | Declare in class, **define in exactly one .cpp**. `static const int` with an in-class initializer still needed an out-of-line definition if ODR-used (address taken, bound to a reference). |
| C++11/14 | Same. `constexpr` static members needed the out-of-line definition too. |
| **C++17** | **`static inline`** — define in the class, in the header, no .cpp needed (Ch. 1 §1.9). `constexpr` static data members are **implicitly inline**, so the out-of-line definition is no longer required (and is deprecated). |

The pre-C++17 "undefined reference to `Foo::kMax`" link error — from passing a `constexpr` static to a function taking `const int&`, which ODR-uses it — is a classic. `static inline` is the modern answer to *any* "how do I put a global in a header?" question.

### Static member functions

No `this`, no `virtual`, no `const`/ref-qualifiers. They can be called via an object (`obj.static_fn()`) or the class (`T::static_fn()`), and their address is a plain function pointer, not a pointer-to-member (Ch. 4 §4.10) — which is exactly why they are used as **C callback trampolines**:

```cpp
struct Handler {
    void on_event(Event&);
    static void trampoline(void* ctx, Event& e) { static_cast<Handler*>(ctx)->on_event(e); }
};
register_callback(&Handler::trampoline, this);
```

### Low-latency considerations

- A `static inline` non-const member with a dynamic initializer reintroduces the initialization-order fiasco (Ch. 5 §5.10) and a thread-safe-statics guard if function-local. Use `constinit` where possible.
- Static members are in `.data`/`.bss`, not with the object — so touching one from a hot loop that's otherwise cache-resident is a separate cache line and a potential **false sharing** source if multiple threads write different statics that landed adjacently (Ch. 3 §3.3). `alignas(64)` on hot mutable statics.
- **`static constexpr` arrays** land in `.rodata` and are the right way to build compile-time lookup tables (Ch. 4 §4.12). C++23 permits `static constexpr` locals inside `constexpr` functions, which previously forced them to namespace scope.

---

## 6.9 Bit-Fields, Packing, and Alignment

(Introduced in Ch. 3 §3.4; here is the complete treatment.)

```cpp
struct Flags {
    unsigned ready    : 1;
    unsigned priority : 3;
    unsigned          : 0;    // zero-width unnamed: force alignment to the next unit
    unsigned seq      : 20;
};
```

### What is implementation-defined

| Property | Status |
|---|---|
| Allocation direction within a unit | Implementation-defined (LSB-first on x86 SysV; MSB-first on many big-endian ABIs) |
| Whether a field may straddle a storage unit | Implementation-defined (SysV allows it; MSVC does not, and starts a new unit) |
| Signedness of `int b:1` | Implementation-defined — it may hold only 0 and **-1**. Always write `signed`/`unsigned` explicitly. |
| The type allowed | `int`, `unsigned`, `bool`, and (implementation-defined) other integral/enum types |
| Effect on `sizeof` / alignment | Determined by the declared type of the field |

`unsigned x : 1;` holding `1` and comparing to an enum value is a routine source of surprises; `bool b : 1;` is safe and clear.

### Costs

- **Read** = load, shift, mask. **Write** = load, mask, or, store — a **read-modify-write** of the whole storage unit.
- **You cannot take the address of a bit-field** and cannot bind a non-const reference to one. Passing one to a function takes a copy.
- **Adjacent bit-fields are one memory location** (C++11 memory model). Two threads writing `ready` and `priority` concurrently is a **data race**, because each write RMWs the shared unit. A zero-width unnamed field between them (or `alignas` separation) splits the memory locations. This is a superb concurrency question because the code looks race-free.
- Bit-fields defeat many optimizations: no vectorization across them, and the RMW creates a store-to-load-forwarding dependency chain (Ch. 29 §29.8).

### Packing and manual bit manipulation

`#pragma pack(1)` / `[[gnu::packed]]` remove padding entirely. Consequences (Ch. 3 §3.3): members can be misaligned, taking their address is UB, ARM may fault, `-Waddress-of-packed-member` warns, and the compiler emits byte-wise loads for misaligned members — often *slower* than the padded version despite the smaller footprint.

**For wire formats, do not use bit-fields.** Allocation order is ABI-defined and not portable (Ch. 3 §3.9). Use explicit shifts and masks over a fixed-width integer:

```cpp
constexpr uint32_t kSeqMask = 0x000FFFFFu;
uint32_t seq   = raw & kSeqMask;
uint32_t prio  = (raw >> 20) & 0x7u;
```
This is portable, endianness-explicit, and compiles to the same instructions. C++20's `<bit>` (`std::popcount`, `std::countl_zero`, `std::rotl`, `std::has_single_bit`, `std::bit_width`) covers the common manipulations with single-instruction lowering (`POPCNT`, `LZCNT`, `TZCNT`) — Ch. 15 §15.7.

**When bit-fields are right:** compact in-memory structures within one TU where density drives cache behaviour — e.g. an order-book level packing price offset, quantity, and flags into 8 bytes so a whole book side fits in L1. Measure: the RMW cost has to be smaller than the miss cost you saved.

---

## 6.10 Access Control and Inheritance

**Access specifiers** control *visibility*, not layout or lifetime, and are checked at compile time only.

| | `public` | `protected` | `private` |
|---|---|---|---|
| The class itself | ✓ | ✓ | ✓ |
| Derived classes | ✓ | ✓ | ✗ |
| Friends | ✓ | ✓ | ✓ |
| Everyone else | ✓ | ✗ | ✗ |

`class` defaults to `private` members and private inheritance; `struct` defaults to `public` for both. That is the *only* difference between them.

### Inheritance access

```cpp
struct D1 : public  Base { };   // "is-a" — Base's public members stay public
struct D2 : protected Base { };  // rare
struct D3 : private Base { };   // "implemented-in-terms-of"
```
The inheritance specifier caps the accessibility of inherited members. Critically, **a `Derived*` → `Base*` conversion is only accessible where the base is accessible** — so private inheritance does not permit outside code to convert, which is what makes it "composition with extra powers" rather than subtyping.

**Private inheritance vs composition:**

| | Private inheritance | Member |
|---|---|---|
| Can override virtuals of the base | **Yes** | No |
| Empty base optimization | **Yes** (Ch. 5 §5.11) | Only with `[[no_unique_address]]` (C++20) |
| Access to protected members | **Yes** | No |
| Coupling | Tighter; can't hold two | Looser |

Post-C++20, `[[no_unique_address]]` removed the size motivation, so private inheritance is justified only by overriding a virtual or accessing protected members. That's a good modern answer.

### Details worth knowing

- **Access is checked on the name, not the entity.** A private virtual function can still be *called* through a public base's virtual dispatch — this is the **Non-Virtual Interface (NVI)** idiom: public non-virtual functions that call private virtual ones. It gives the base control over pre/post conditions while letting derived classes customize the middle, and it's the standard answer to "how do you enforce invariants around an overridable step?"
- **Access does not affect overload resolution** — an inaccessible overload can be *selected* and then produce an access error, rather than being skipped.
- **`friend`** grants full access; it is not inherited, not transitive, and not reciprocal. Hidden friends (Ch. 4 §4.7) are the preferred use.
- Members with **different access specifiers may be reordered** by the implementation (Ch. 3 §3.4), and mixed access makes a class non-standard-layout.
- **`protected` data members are a design smell** — they are effectively public to an unbounded set of future subclasses, so you cannot change the representation. Protected *functions* are fine.

---

## 6.11 Virtual Dispatch and Vtables

The standard specifies only the *behaviour*: a call through a pointer/reference to a base invokes the most-derived override. Every mainstream implementation uses **vtables**, and the Itanium C++ ABI (Linux/macOS, GCC/Clang) is the one to describe.

### Layout

```
Object:                        Vtable for Derived (in .rodata):
┌──────────┐                   ┌────────────────────────┐
│  vptr    │ ──────────────▶   │ offset-to-top (0)      │
├──────────┤                   ├────────────────────────┤
│  member  │                   │ typeinfo* (&RTTI)      │  ← dynamic_cast/typeid read this
├──────────┤                   ├────────────────────────┤
│  member  │                   │ &Derived::f            │  ← slot 0
└──────────┘                   │ &Base::g               │  ← slot 1 (not overridden)
                               │ &Derived::~Derived (D1)│
                               │ &Derived::~Derived (D0)│  ← deleting dtor (Ch. 5 §5.14)
                               └────────────────────────┘
```
- The **vptr is at offset 0** and is installed by the constructor of each stage as construction proceeds (Ch. 5 §5.9) — which is why virtual calls in constructors dispatch to the current stage.
- Slot assignment follows declaration order in the most-base class first; overriding reuses the base's slot. Adding a virtual function in the middle of a class **changes every subsequent slot index — an ABI break** (Ch. 44 §44.17). This is why stable-ABI libraries append virtuals at the end, or use PIMPL.
- One vtable per class, shared by all instances, emitted in the TU containing the first non-inline, non-pure virtual function (the **key function**) — which is why declaring all virtuals inline can cause the vtable to be emitted in every TU and merged by the linker as a weak symbol (Ch. 1 §1.12).

### The cost of a virtual call

```asm
mov  rax, [rdi]          ; load vptr        ← dependent load, may miss
call [rax + 16]          ; indirect call    ← BTB prediction
```
1. **Load the vptr** from the object — usually free if the object is in cache, since it shares the line with the first members.
2. **Load the function pointer** from the vtable — the vtable is in `.rodata` and typically hot, but a polymorphic workload touching many classes evicts them.
3. **Indirect call** — BTB-predicted. Monomorphic sites predict perfectly (~1–2 cycles extra); megamorphic sites mispredict at ~15–20 cycles (Ch. 27 §27.11).
4. **No inlining** — the real cost. The callee's body cannot be inlined, so no constant propagation, no cross-call CSE, and a function-call boundary that forces register spills (Ch. 4 §4.9).

Aggregate rule of thumb: a predicted virtual call is a handful of cycles; the *lost inlining* is often 10× more in a tight loop. That framing is what interviewers want, not "virtual calls cost 2 nanoseconds."

### Devirtualization

Compilers eliminate the indirection when they can prove the dynamic type:
- The object is a local of known type, or `final` applies (§6.14).
- **LTO** (Ch. 40 §40.3) sees the whole hierarchy; with `-fwhole-program-vtables` and `-fstrict-vtable-pointers` Clang can devirtualize aggressively.
- **Speculative devirtualization** (PGO, Ch. 40 §40.9): the compiler emits `if (vptr == &Derived::vtable) { inlined body } else { indirect call }` — turning a mispredicted indirect branch into a well-predicted direct one plus an inlined body. This is how a profiled build recovers most of the cost.

The low-latency answer: prefer templates/CRTP (§6.19) when the type is known at compile time, sort work by type to keep call sites monomorphic, use `final` liberally, and enable LTO+PGO. Only then consider hand-rolled dispatch.

---

## 6.12 Abstract Classes and Pure Virtual Functions

```cpp
struct Strategy {
    virtual void on_tick(const Tick&) = 0;    // pure virtual
    virtual ~Strategy() = default;
};
```
A class with at least one pure virtual function is **abstract**: it cannot be instantiated, cannot be a function parameter or return type by value, and cannot be the target of a `static_cast` from `void*`... but **can** be a pointer/reference type, and pure virtual functions still occupy vtable slots (filled with `__cxa_pure_virtual`).

### Details

- **A pure virtual function may have a definition**, and a derived class can call it explicitly:
  ```cpp
  void Strategy::on_tick(const Tick& t) { /* shared default logic */ }
  void MyStrat::on_tick(const Tick& t) override { Strategy::on_tick(t); ... }
  ```
  The most common use is a **pure virtual destructor**, which forces abstractness while still needing a body (the derived destructor always calls it):
  ```cpp
  struct I { virtual ~I() = 0; };  I::~I() = default;   // definition is MANDATORY
  ```
- **Calling a pure virtual from a constructor or destructor** invokes `__cxa_pure_virtual` and aborts, because at that stage the derived override doesn't exist (Ch. 5 §5.9). It is UB; the runtime just happens to diagnose it.
- A derived class that doesn't override every pure virtual is itself abstract.
- Abstract classes are the C++ spelling of an interface. C++20 **concepts** (Ch. 17 §17.13) are the compile-time alternative: same "required operations" contract, checked at compile time, with zero runtime cost and no vtable — and that comparison is a good answer to "how do you express an interface without virtual dispatch?"

### Interface design guidance

- Keep interfaces **narrow** — every virtual is a vtable slot and an ABI commitment.
- **`virtual ~T() = default;` publicly, or `protected: ~T();` non-virtually** (Ch. 5 §5.14).
- Delete or default the copy/move operations explicitly; an abstract base with implicit copy assignment invites slicing (§6.15).
- Consider the **NVI idiom** (§6.10): public non-virtual entry points, private virtual customization points.

---

## 6.13 Virtual Destructors

(Mechanism in Ch. 5 §5.14; here the decision framing.)

**The rule:** if an object may be deleted through a pointer to a base, that base needs a virtual destructor. Otherwise it is UB — the derived destructor is skipped and `operator delete` receives the wrong address and size.

```cpp
struct Base { virtual void f(); ~Base(); };   // BUG: virtual function but non-virtual destructor
```
**Heuristic:** *any class with a virtual function should have a virtual destructor*, because the presence of virtuals means it's used polymorphically, and someone will eventually `delete base_ptr`. `-Wnon-virtual-dtor` / `-Wdelete-non-virtual-dtor` should be errors.

### The four correct configurations

| Intent | Destructor |
|---|---|
| Polymorphic base, deleted through base pointer | `public: virtual ~T() = default;` |
| Polymorphic base, never owned via base pointer | `protected: ~T() = default;` (non-virtual, zero cost, compile-time enforced) |
| Abstract base needing no other pure virtual | `public: virtual ~T() = 0;` **with a definition** |
| Value type / `final` leaf | Non-virtual, ideally trivial |

### What it costs

Adding `virtual` to a destructor (or any function) makes the class:
- 8 bytes larger (vptr),
- non-trivially-copyable and non-standard-layout with data (Ch. 3 §§3.5–3.6) → no `memcpy`, no `std::atomic<T>`, no shared memory, no register passing (Ch. 4 §4.17),
- non-trivially-destructible → containers must run a destructor loop,
- unable to be `constexpr`-constructed in some contexts pre-C++20.

So the reflex "always make destructors virtual" is wrong. **Make destructors virtual on polymorphic bases only.**

**The `shared_ptr` exception** (Ch. 9 §9.3) is worth restating precisely: `shared_ptr`'s control block stores a type-erased deleter captured from the *constructing* expression, so `shared_ptr<Base> p = std::make_shared<Derived>();` destroys the `Derived` correctly even with a non-virtual `~Base`. `unique_ptr<Base>` cannot — its deleter is a template parameter fixed at the pointer's type. This asymmetry is a recurring interview question, and the correct follow-up is that relying on it is fragile: `shared_ptr<Base> p{new Derived}` also works, but `shared_ptr<Base> p{static_cast<Base*>(new Derived)}` does not.

---

## 6.14 `override` and `final`

Both are **contextual keywords** (C++11), valid only in this position, so they don't break identifiers named `override`.

### `override`

```cpp
struct B { virtual void f(int) const; };
struct D : B { void f(int) const override; };     // checked
struct E : B { void f(int)       override; };     // ERROR — missing const, doesn't override
```
Without `override`, `E::f` would silently *hide* rather than override (Ch. 4 §4.18), and calls through `B*` would go to `B::f`. The mismatch sources: `const`, ref-qualifiers, parameter types, return type, and `noexcept` (which is part of the type since C++17 — a `noexcept` override of a non-`noexcept` virtual is allowed; the reverse is not).

**Always write `override`.** `-Wsuggest-override` / `-Winconsistent-missing-override` enforce it. Note `virtual` is redundant on an overriding function and writing both is a style choice; writing neither is a bug waiting to happen.

### `final`

On a **function**: prevents further overriding. On a **class**: prevents derivation.

```cpp
struct D final : B { void f(int) const final; };
```

**`final` is a performance tool, not just a design tool.** It lets the compiler devirtualize:

```cpp
struct Base { virtual int f(); };
struct Impl final : Base { int f() override { return 42; } };
void g(Impl& i) { i.f(); }        // devirtualized and INLINED — the dynamic type can't be anything else
void h(Base& b) { b.f(); }        // still indirect
```
Marking every leaf class `final` is a legitimate and cheap optimization, and it also enables the empty-base and layout optimizations that `final` unlocks in libraries. Clang's `-fstrict-vtable-pointers` plus `final` is a meaningful combination.

`final` on a class also implies the class cannot be a base, so `std::is_final_v` is used by libraries to decide between EBO-via-inheritance and storing a member (`std::function`, `unique_ptr`'s deleter, `boost::compressed_pair` all check it).

**The trade-off:** `final` breaks mocking frameworks (GoogleMock can't override a final method), test seams, and future extension. The usual policy: `final` on implementation leaf classes in hot paths, not on interfaces or anything tests need to substitute.

---

## 6.15 Object Slicing

Assigning or copy-constructing a derived object into a **base value** copies only the base subobject — the derived part is "sliced off."

```cpp
struct Base { int a; virtual void f(); };
struct Derived : Base { int b; void f() override; };

Derived d;
Base b = d;          // SLICED — only `a` copied; b's vptr is Base's, so b.f() calls Base::f
void g(Base);        
g(d);                // sliced at the call

std::vector<Base> v;
v.push_back(Derived{});   // sliced on insertion — the classic container bug
```
Note the vptr: the copy constructor being invoked is `Base::Base(const Base&)`, which sets the vptr to `Base`'s. So the sliced object is a genuine `Base` — polymorphism is lost, not merely the data.

### Where it happens

- Passing a polymorphic type **by value**.
- Storing polymorphic types in a container **by value**.
- Assigning `base = derived` (partial assignment — arguably worse, because it leaves a mixed-state object if the base's operator= only assigns the base part of an object whose dynamic type is derived).
- Returning a base by value from a function producing a derived.
- Catching an exception **by value** rather than `const&` — the canonical `catch (std::exception e)` bug, which slices away the derived exception's `what()`.

### Prevention

| Technique | Effect |
|---|---|
| Pass/store by reference or pointer | The default fix |
| `std::vector<std::unique_ptr<Base>>` | Polymorphic container; costs an indirection per element |
| Delete the base's copy operations: `Base(const Base&) = delete;` | Makes slicing a compile error; the standard recommendation for polymorphic bases |
| Make the base **abstract** | Cannot be instantiated by value at all |
| `protected: Base(const Base&) = default;` | Derived classes can still copy themselves; outsiders can't slice |
| `catch (const std::exception&)` | Always catch by const reference |
| `-Wextra` / clang-tidy `cppcoreguidelines-slicing` | Diagnostics |

**Interview framing:** *"What exactly is lost in slicing?"* — the derived data members **and** the dynamic type (the vptr is overwritten by the base's copy constructor), so virtual dispatch resolves to the base thereafter. Saying both parts is the complete answer.

---

## 6.16 Multiple and Virtual Inheritance

### Multiple inheritance layout

```cpp
struct A { int a; virtual void f(); };
struct B { int b; virtual void g(); };
struct C : A, B { int c; };

C object layout:   [ A::vptr | a | B::vptr | b | c ]
                     ▲              ▲
                  offset 0       offset 16
```
`C` has **two vptrs** and two vtables. Converting `C*` to `B*` requires a **pointer adjustment** (`+16`), which the compiler emits automatically:
```cpp
C* c = new C;
B* b = c;                          // b = (char*)c + 16
assert((void*)b != (void*)c);      // TRUE — the pointers differ!
delete b;                          // needs virtual dtor; the D0 thunk adjusts back
```
This is why `reinterpret_cast` between related pointer types is wrong where `static_cast` is right, and why comparing `void*` casts of the same object can be false.

**Thunks:** when `C` overrides `B::g`, the entry in `B`'s vtable can't point directly at `C::g` (which expects a `C*` `this`). The ABI emits a **non-virtual thunk** — a stub that adjusts `this` by −16 and jumps to `C::g`. It costs an extra `lea` and a `jmp`, plus an extra I-cache line. Visible in `nm` output as `_ZThn16_N1C1gEv`.

### The diamond and virtual bases

```cpp
struct Base { int x; };
struct L : Base {}; struct R : Base {};
struct D : L, R {};       // TWO copies of Base — D::x is ambiguous

struct L : virtual Base {}; struct R : virtual Base {};
struct D : L, R {};       // ONE shared Base
```

Virtual inheritance costs:
- The shared base's location is not a fixed offset from the derived object (it depends on the *most-derived* type), so access goes through a **vtable-stored offset (vbase offset)**: an extra load and an indirect add for every access to a virtual base member. `L::x` from an `L*` costs a vtable lookup.
- **The most-derived class initializes the virtual base**, so intermediate classes' mem-init entries for it are ignored (Ch. 5 §5.9, §6.6). Every class that could be most-derived must be able to construct the virtual base — which means adding a virtual base to a hierarchy breaks every derived class's constructor.
- `static_cast` from a virtual base to a derived class is **ill-formed**; you must use `dynamic_cast` (§6.18).
- Object size grows: virtual base pointers/offsets per subobject.
- The class is never standard-layout or trivially copyable.

### Guidance

The mainstream position: **use multiple inheritance only for combining interfaces (abstract classes with no data)**, which is free — no diamonds, no virtual bases, only the pointer adjustment. `std::basic_iostream` deriving virtually from `basic_ios` is the standard library's one prominent virtual-inheritance example, and it exists for historical reasons. In low-latency code, virtual inheritance is essentially disqualifying: unpredictable offsets, extra loads, and no layout guarantees.

---

## 6.17 Covariant Return Types

An override may return a **pointer or reference to a more derived class** than the base's version:

```cpp
struct Shape { virtual Shape* clone() const; };
struct Circle : Shape { Circle* clone() const override; };   // covariant — legal

Circle c;
Circle* p = c.clone();      // no cast needed at the static type
Shape*  q = static_cast<Shape&>(c).clone();  // dispatches to Circle::clone, returns Shape*
```

Rules:
- **Pointers and references only** — not by-value, not smart pointers. `std::unique_ptr<Circle> clone() const override` against a base returning `std::unique_ptr<Shape>` **does not compile**: they are unrelated class types, not covariant.
- The classes must be related by public, unambiguous, accessible inheritance, and the base class must be complete.
- Return-type cv-qualification may only be reduced, not added.

**Implementation:** when the covariant return requires a pointer adjustment (multiple inheritance, §6.16), the ABI emits a **covariant return thunk** (`_ZTch...`) that fixes up the returned pointer. Under single inheritance the adjustment is zero and the thunk disappears.

### The `unique_ptr` clone problem and its fix

Because smart pointers aren't covariant, the standard workaround is the NVI pattern (§6.10):
```cpp
class Shape {
    virtual Shape* do_clone() const = 0;         // covariant, private
public:
    std::unique_ptr<Shape> clone() const { return std::unique_ptr<Shape>(do_clone()); }
    virtual ~Shape() = default;
};
class Circle : public Shape {
    Circle* do_clone() const override { return new Circle(*this); }
public:
    std::unique_ptr<Circle> clone() const {      // shadows, non-virtual, exact type
        return std::unique_ptr<Circle>(do_clone());
    }
};
```
Being able to produce this on demand is a strong signal — it demonstrates covariance, NVI, and the smart-pointer limitation together.

**Parameters are never contravariant in C++.** An override must match parameter types exactly; a "wider" parameter type creates a *hiding* overload instead, which `override` correctly rejects.

---

## 6.18 RTTI and `dynamic_cast`

**RTTI** (run-time type information) is the vtable-adjacent data that lets a program query an object's dynamic type. It requires at least one virtual function (a polymorphic type).

### `typeid`

```cpp
const std::type_info& t = typeid(*base_ptr);    // DYNAMIC type — evaluates the operand
t.name();                                       // implementation-defined mangled name (c++filt it)
t.hash_code();                                  // usable as an unordered_map key
std::type_index idx{t};                         // copyable, comparable, hashable wrapper
```
- `typeid` on a **non-polymorphic** expression is evaluated at compile time and gives the *static* type.
- `typeid(*p)` with `p == nullptr` throws `std::bad_typeid`.
- Comparison across shared-library boundaries is the classic failure: with `-fvisibility=hidden` or `RTLD_LOCAL`, two copies of the same `type_info` exist and compare unequal (libstdc++ compares the name *pointers* first, then falls back to `strcmp` unless the name starts with `*`). Symptom: `dynamic_cast` returning null across a `dlopen`ed boundary. Fix: export the key function / typeinfo symbols and use `RTLD_GLOBAL`.

### `dynamic_cast`

```cpp
Derived* d = dynamic_cast<Derived*>(base_ptr);   // nullptr on failure
Derived& r = dynamic_cast<Derived&>(base_ref);   // throws std::bad_cast on failure
void* top  = dynamic_cast<void*>(base_ptr);      // pointer to the MOST-DERIVED object
```
It performs:
- **Downcast** (base → derived): requires the source to be polymorphic; walks the RTTI graph at runtime.
- **Cross-cast** (sibling → sibling in a multiple-inheritance hierarchy): only `dynamic_cast` can do this.
- **Upcast**: works, but `static_cast` is free and preferred.
- **From a virtual base**: only `dynamic_cast` works (§6.16).

**Cost:** the Itanium ABI implementation (`__dynamic_cast` in libstdc++) walks the inheritance graph comparing `type_info` pointers and names — it is a **function call with string comparisons and pointer chasing**, typically 30–100+ ns and unbounded for deep hierarchies. It is not a constant-time operation and its cost depends on hierarchy shape. This is why `dynamic_cast` is banned outright in most low-latency codebases.

### Alternatives, in order of preference

| Approach | Cost | Notes |
|---|---|---|
| **Virtual function** | one indirect call | The right answer 90% of the time — put the behaviour in the class |
| **Visitor pattern** | one or two virtual calls | Double dispatch without RTTI; closed hierarchy |
| **`std::variant` + `std::visit`** | table dispatch or `switch` | Closed set, no inheritance, no RTTI (Ch. 15 §15.4) |
| **Manual type tag** (`enum kind_` + `static_cast`) | one load + `switch` | What LLVM does (`isa<>`/`cast<>`/`dyn_cast<>`), and the standard hot-path answer |
| `dynamic_cast` | 30–100+ ns | Only in cold paths, plugin boundaries, or debugging |

`-fno-rtti` disables RTTI entirely, shrinking binaries (no `type_info` objects or names in `.rodata`) — Chromium, LLVM, and most game engines build this way. It breaks `dynamic_cast`, `typeid`, and any library depending on them (notably `boost::any`, some exception machinery interacts, and `std::function`'s `target_type()`). Exceptions still work; `-fno-exceptions` is a separate flag (Ch. 10 §10.8).

---

## 6.19 Static Polymorphism with CRTP

**CRTP** (Curiously Recurring Template Pattern): a class derives from a template instantiated with itself, so the base can `static_cast` to the derived type at compile time.

```cpp
template <class Derived>
struct Strategy {
    void run(const Tick& t) {                     // non-virtual, inlinable
        static_cast<Derived*>(this)->on_tick(t);  // resolved at compile time
    }
    void on_tick(const Tick&) { /* default */ }   // overridable by hiding
};

struct MyStrat : Strategy<MyStrat> {
    void on_tick(const Tick& t) { /* fully inlined into run() */ }
};
```

### What it buys and costs

| | Virtual dispatch | CRTP |
|---|---|---|
| Dispatch resolved | Runtime | **Compile time** |
| Inlining | No | **Yes** — the whole point |
| Object size | +8 (vptr) | **+0** |
| Trivially copyable | No | **Yes** (if members are) |
| Heterogeneous containers | `vector<unique_ptr<Base>>` | **Impossible** — each instantiation is a distinct type |
| Binary size | One copy | **One instantiation per derived class** (Ch. 17 §17.22) |
| Dynamic loading / plugins | Yes | No |
| Compile time | Fast | Slower |
| ABI stability | Manageable | Everything is in headers |

The performance argument is not "avoiding the indirect call" — it is **inlining across the dispatch boundary**, which enables constant propagation, dead-code elimination of unused branches, and vectorization of the combined body. On a hot loop this is routinely 2–10×, far more than the ~5 cycles of the call itself.

### Other CRTP uses

- **Mixins that inject behaviour**: `struct Counted : Counter<Counted> {}` giving instance counting, comparison operators from `operator<` (the pre-C++20 `boost::operators`), or `enable_shared_from_this` (which *is* CRTP — Ch. 9 §9.7).
- **Compile-time interface checking**: the base can `static_assert` that `Derived` has the required members.
- **Avoiding code duplication** in policy-based design.

Pitfalls: the derived type is **incomplete** inside the base's class body (so you can't use `sizeof(Derived)` or its members at class scope — only inside member function *bodies*, which are instantiated later); passing the wrong `Derived` (`struct B : Strategy<A>`) compiles and produces UB, fixable with a private constructor plus `friend Derived`; and error messages are notoriously bad.

**C++20 alternatives:** concepts (Ch. 17 §17.13) express the same constraints far more readably, and C++23's **deducing `this`** (Ch. 19 §19.11) supersedes CRTP for many mixins:
```cpp
struct Strategy {
    template <class Self> void run(this Self&& self, const Tick& t) { self.on_tick(t); }
};
struct MyStrat : Strategy { void on_tick(const Tick&); };   // no template parameter on the base!
```
Naming this as CRTP's successor is a strong modern-C++ signal.

---

## 6.20 Type Erasure

**Type erasure** provides runtime polymorphism for **unrelated types that share no base class**, by generating the dispatch machinery at the point where the concrete type is still known.

`std::function` (Ch. 4 §4.11), `std::any`, `std::shared_ptr`'s deleter (Ch. 9 §9.3), `std::pmr::memory_resource` (Ch. 8 §8.5), and `std::move_only_function` are all instances.

### The canonical implementation

```cpp
class Drawable {
    struct Concept {                                  // internal interface
        virtual ~Concept() = default;
        virtual void draw(std::ostream&) const = 0;
        virtual std::unique_ptr<Concept> clone() const = 0;
    };
    template <class T>
    struct Model final : Concept {                    // generated per concrete type
        T obj_;
        explicit Model(T o) : obj_(std::move(o)) {}
        void draw(std::ostream& os) const override { obj_.draw(os); }   // or a free fn / ADL
        std::unique_ptr<Concept> clone() const override { 
            return std::make_unique<Model>(*this); }
    };
    std::unique_ptr<Concept> self_;
public:
    template <class T> Drawable(T x) : self_(std::make_unique<Model<T>>(std::move(x))) {}
    Drawable(const Drawable& o) : self_(o.self_->clone()) {}
    void draw(std::ostream& os) const { self_->draw(os); }
};
std::vector<Drawable> shapes;   // VALUE semantics over unrelated types
```
The key property: `T` needs no inheritance, no `virtual`, no cooperation at all — it just needs the operations. This is **value semantics with runtime polymorphism** (Sean Parent's "inheritance is the base class of evil" talk is the canonical reference).

### The three implementation strategies

| Strategy | Mechanism | Cost |
|---|---|---|
| **Inheritance-based** (above) | Internal `Concept`/`Model` hierarchy | Heap allocation, vtable, indirect call |
| **Manual vtable** | A `struct VTable { void(*draw)(void*); }` built per type, stored as a static | Same call cost, no `dynamic_cast`/RTTI, smaller, works with `-fno-rtti`; what `std::function` implementations use |
| **Small-buffer optimized** | Store small objects inline, heap only for large ones | Avoids the allocation and one indirection; more code, and `noexcept` move needs care |

### Costs and mitigations

1. **Allocation** on construction — unless SBO applies. `std::function`'s buffer is ~16 bytes (libstdc++) / ~24 (libc++), so capturing three pointers already allocates. Ch. 18 §18.10.
2. **Indirect call, no inlining** — same as virtual dispatch (§6.11), plus a pointer chase to the heap-stored model, which is a likely **cache miss** the vtable approach doesn't have (the model is a separate allocation, cold).
3. **Code bloat** — a `Model<T>` instantiation per type.
4. **`const`-correctness holes** — `std::function::operator()` is const but calls a non-const target; `std::copyable_function` (C++26) fixes this.

**When it's right in low-latency code:** at genuine plugin/configuration boundaries, once per session rather than per message. On the hot path, prefer a closed set: `std::variant` + `switch` (Ch. 5 §5.13), CRTP (§6.19), or a manual tag dispatch. If you must type-erase in the hot path, use a **manual vtable with inline storage** — a fixed-size `alignas(8) std::byte buf[32]` plus a `const VTable*` — which is one indirect call with no allocation and no extra cache miss. That structure is exactly what a strong candidate sketches.

---

## Key Interview Questions

1. **Which special member declarations suppress which others?** — A user-declared destructor, copy ctor, or copy assignment suppresses the implicit **moves**; a user-declared move suppresses the copies (they're deleted). "Declared," not "defined" — `= default` counts.
2. **What is the practical damage of adding a logging destructor to a struct holding a vector?** — Moves are suppressed, so `vector::push_back` copies: a heap allocation and a `memcpy` per insertion, silently.
3. **State the Rule of Zero / Three / Five and when each applies.** — Zero: hold self-managing members and declare nothing. Three/Five: only when you own a raw resource; then write all five plus `noexcept` moves.
4. **Why does `= default` inside vs outside the class body matter?** — Inside, on the first declaration, the function is not *user-provided*, so the type stays trivial and `T x{}` zero-initializes.
5. **Give three uses of `= delete` besides suppressing copies.** — Banning specific overloads/conversions, banning rvalue arguments to prevent dangling, and deleting `operator new` for stack-only types.
6. **Why make single-argument constructors `explicit`?** — They otherwise define an implicit conversion; `explicit(bool)` (C++20) makes it conditional, as the library does for `std::pair`.
7. **What's different about an exception thrown in a delegating constructor's body?** — The object's lifetime began when the target constructor completed, so its **destructor runs** — unlike a normal constructor throw.
8. **What do inherited constructors not do?** — They don't initialize the derived class's own members (only NSDMIs apply), and default/copy/move are never inherited. Semantics changed materially in C++17.
9. **Why prefer the member-initializer list over assignment in the body?** — The body assigns to already-default-constructed members: two operations, and mandatory for const, reference, and non-default-constructible members. Order follows declaration, not the list.
10. **What are ref-qualified member functions for?** — Overloading on the object's value category: moving out of rvalues (`optional::value() &&`), preventing assignment to temporaries, and `= delete`-ing rvalue accessors that would dangle. C++23 deducing `this` collapses the boilerplate.
11. **How do you put a mutable global in a header?** — `static inline` (C++17); `constexpr` statics are implicitly inline. Pre-C++17 you needed an out-of-line definition, hence the classic "undefined reference to `Foo::kMax`" link error.
12. **Why are two threads writing adjacent bit-fields a data race?** — Adjacent bit-fields form one memory location, and each write is a read-modify-write of the shared unit. A zero-width field separates them.
13. **When is private inheritance justified after C++20?** — Only to override a base's virtual or reach protected members; `[[no_unique_address]]` removed the size argument.
14. **Describe the Itanium vtable layout and what the vptr costs.** — offset-to-top, `type_info*`, then function slots including two/three destructor variants; vptr at offset 0, installed per construction stage; adding a virtual mid-class shifts slot indices and breaks ABI.
15. **What is the real cost of a virtual call?** — Not the ~5 cycles of load-plus-indirect-call, but the **lost inlining** and the resulting loss of constant propagation and vectorization; plus a ~15–20 cycle mispredict at megamorphic sites.
16. **How do compilers devirtualize?** — Known-concrete types, `final`, LTO with `-fwhole-program-vtables`, and PGO-driven speculative devirtualization (guarded inline plus a fallback).
17. **Can a pure virtual function have a body, and when must it?** — Yes, for shared default logic; **mandatory** for a pure virtual destructor.
18. **Exactly what does slicing lose?** — The derived members *and* the dynamic type: the base's copy constructor writes the base's vptr, so virtual dispatch resolves to the base.
19. **Why is `dynamic_cast` slow, and what do you use instead?** — It calls `__dynamic_cast`, which walks the inheritance graph comparing `type_info` (pointer then `strcmp`); use a virtual function, a variant, or an LLVM-style manual kind tag.
20. **Why can `dynamic_cast` return null across a shared-library boundary?** — Duplicate `type_info` objects with hidden visibility compare unequal; fix with symbol visibility or `RTLD_GLOBAL`.
21. **Why is `std::unique_ptr<Derived> clone() override` not covariant?** — Covariance applies only to pointers and references to related classes, not to unrelated class templates; use NVI with a raw covariant `do_clone`.
22. **What does multiple inheritance cost at the machine level?** — Multiple vptrs, pointer adjustment on conversion (so `(void*)b != (void*)c`), and non-virtual thunks for overrides reached through the second base.
23. **Why is virtual inheritance disqualifying for low latency?** — The virtual base's offset isn't fixed, so access goes through a vtable-stored offset; construction is owned by the most-derived class; no standard layout, no trivial copyability.
24. **CRTP vs virtual dispatch — what's the actual win?** — Inlining across the dispatch boundary (constant propagation, DCE, vectorization), not saving the indirect call. Costs heterogeneity and binary size. C++23 deducing `this` replaces it for mixins.
25. **How does type erasure work and where does it cost you?** — A per-type `Model` behind an internal `Concept` (or a manual vtable): heap allocation past the small buffer, an indirect call, an extra cache miss to a cold heap block, and one instantiation per type.

---

## Common Traps

- **Declaring a destructor and losing the implicit moves** — silent copies in every container operation.
- **Assuming `= default` is free** — it still counts as user-declared, and outside the class it makes the function user-provided.
- **Missing `noexcept` on a move constructor** — `vector` reallocation falls back to copying (Ch. 10 §10.3).
- **Hand-written move assignment without self-assignment or old-resource release.**
- **Non-`explicit` single-argument constructors** — accidental implicit conversions and overload ambiguity.
- **Unconstrained `template<class T> C(T&&)`** hijacking the copy constructor (Ch. 4 §4.6).
- **Inherited constructors with new derived members** — those members are left default-initialized.
- **Member-initializer list written out of declaration order** — initialization order is declaration order (`-Wreorder`).
- **Initializing a member from a later-declared member.**
- **Assigning in the constructor body** what should be initialized — construct-then-assign, and impossible for const/reference members.
- **Mixing ref-qualified and unqualified overloads of the same name** — ill-formed.
- **`static constexpr` member ODR-used pre-C++17 without an out-of-line definition** — link error.
- **`int b : 1;`** — implementation-defined signedness; may hold only 0 and −1.
- **Bit-fields in a wire format** — allocation order is ABI-defined.
- **Concurrent writes to adjacent bit-fields** — one memory location, hence a data race.
- **`protected` data members** — freeze the representation forever.
- **Forgetting `override`** — silently hides instead of overriding when `const`/`noexcept`/parameters mismatch.
- **Virtual function without a virtual destructor** — UB on `delete base_ptr`; make `-Wnon-virtual-dtor` an error.
- **Reflexively making all destructors virtual** — costs a vptr, trivial copyability, register passing, and `memcpy` paths.
- **Calling a virtual (or pure virtual) function from a constructor or destructor** — dispatches to the current stage; pure virtual aborts.
- **Adding a virtual function in the middle of a class** — shifts vtable slots, breaking ABI for every compiled caller.
- **`catch (std::exception e)` by value** — slices the derived exception.
- **Storing polymorphic types in `std::vector<Base>`** — slicing on every insert.
- **`reinterpret_cast` between base and derived under multiple inheritance** — skips the pointer adjustment.
- **`static_cast` from a virtual base to a derived class** — ill-formed; needs `dynamic_cast`.
- **`dynamic_cast` on a hot path** — a graph walk with string comparisons, 30–100+ ns.
- **CRTP with the wrong derived type parameter** — compiles, then UB.
- **Using `sizeof(Derived)` or its members in a CRTP base's class body** — the derived type is incomplete there.
- **`std::function` on a hot path** — allocation past ~16 bytes of state, no inlining, and a cold-cache indirection to the erased model.

---

## Compact Recall Summary

**Special members.** Six generated functions; a user-**declared** destructor or copy operation suppresses the moves (silent copies), and a user-declared move deletes the copies. Implicit versions are memberwise, in declaration order, and implicitly `noexcept` if the members are. Triviality — no user-provided special members, no virtuals — is what unlocks `memcpy`, register passing, and `std::atomic<T>`.

**Rules of Zero/Three/Five.** Aim for Zero by holding self-managing members. Write all Five only when you own a raw resource: `noexcept` moves, `std::exchange` to a sentinel, release-then-take in move assignment, explicitly deleted copies. Copy-and-swap is safe and self-assignment-proof but always allocates.

**`= default` / `= delete`.** Defaulting on the first declaration keeps triviality; out of line makes the function user-provided. Deleted functions participate in overload resolution and then error — use them to ban conversions, rvalue arguments that would dangle, and heap allocation.

**Construction.** `explicit` on single-argument constructors by default, `explicit(bool)` (C++20) for conditional cases, `explicit operator bool` for contextual conversions. Delegating constructors run the object's destructor if the delegating body throws. Inherited constructors don't touch derived members and changed semantics in C++17. Initialize in the mem-init list, in declaration order; NSDMIs cover cross-constructor defaults.

**Object-level qualifiers.** Ref-qualified members overload on the object's value category — moving out of rvalues, banning assignment to temporaries, deleting dangling rvalue accessors; C++23 deducing `this` replaces the boilerplate. `static inline` (C++17) is how you put statics in headers; `constexpr` statics are implicitly inline.

**Bit-fields.** Almost everything is implementation-defined: allocation order, straddling, plain-`int` signedness. No addresses, read-modify-write on every write, and **adjacent fields are one memory location** — a data race between "independent" fields. Never in wire formats; use shifts and `<bit>`.

**Access.** `class`/`struct` differ only in defaults. Private inheritance is now justified only by virtual overriding or protected access, since `[[no_unique_address]]` covers size. NVI (public non-virtual → private virtual) is the idiom for controlling overridable steps; `protected` data freezes the representation.

**Virtual dispatch.** Itanium vtable: offset-to-top, `type_info*`, function slots, two/three destructor variants; vptr at offset 0, set per construction stage. A call is vptr load + slot load + indirect call, but the real cost is **lost inlining**. `final`, LTO with `-fwhole-program-vtables`, and PGO speculative devirtualization recover it. Adding a virtual mid-class is an ABI break.

**Destructors and slicing.** Virtual destructor iff deleted through a base pointer; `protected:` non-virtual otherwise; pure virtual destructors need a body. `shared_ptr` type-erases the deleter and survives a non-virtual base destructor, `unique_ptr` does not. Slicing removes the derived members *and* the dynamic type; prevent it by deleting the base's copy operations, making the base abstract, or storing `unique_ptr<Base>`. Always `catch (const E&)`.

**Multiple inheritance.** Multiple vptrs, pointer adjustment on conversion, non-virtual thunks for overrides through a secondary base. Virtual inheritance adds vtable-mediated base offsets, most-derived-initializes rules, and forbids `static_cast` from the virtual base — avoid it. Combine interfaces (data-free abstract classes) only. Covariant returns work for pointers/references only; smart pointers need NVI with a raw covariant helper.

**RTTI.** `typeid` gives the dynamic type for polymorphic operands, the static type otherwise. `dynamic_cast` calls into the runtime and walks the hierarchy comparing `type_info` — 30–100+ ns, hierarchy-dependent, and null across visibility boundaries with duplicated typeinfo. Replace with virtual functions, `std::variant`, or an LLVM-style kind tag; `-fno-rtti` removes it entirely.

**Static polymorphism.** CRTP resolves dispatch at compile time and, crucially, **inlines across it** — no vptr, trivially copyable, but no heterogeneous containers and one instantiation per type. The derived type is incomplete in the base's class body. C++20 concepts express the contract better and C++23 deducing `this` supersedes CRTP mixins. Type erasure (`std::function`, `any`, `shared_ptr`'s deleter) gives value semantics over unrelated types at the cost of an allocation past the small buffer, an indirect call, and a cold-cache hop; on a hot path use a manual vtable with inline storage, or a closed `variant`.
