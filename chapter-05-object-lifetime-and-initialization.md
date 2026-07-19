# Chapter 5 — Object Lifetime and Initialization

*Interview-focused revision notes. The theme: storage and lifetime are two different things, and almost every hard bug in C++ lives in the gap between them — bytes that exist without an object, objects that outlive their bytes, and initialization that happens in an order nobody chose.*

---

## 5.1 Storage and Object Lifetime

Ch. 1 §1.8 covered **storage duration** — how long the *bytes* exist. This chapter is about **lifetime** — how long the *object* exists. They are deliberately separable, and every low-level technique in C++ (allocators, pools, containers, unions, optional) exploits the gap.

| Storage duration | Bytes live | Typical location |
|---|---|---|
| **Automatic** | Enclosing block | Stack |
| **Static** | Program duration | `.data`/`.bss` |
| **Thread** | Thread duration | TLS block (Ch. 24 §24.3) |
| **Dynamic** | Between allocation and deallocation | Heap |

### The lifetime rules

An object's lifetime **begins** when:
1. Storage with the proper size and alignment is obtained, **and**
2. Its initialization (constructor, if non-trivial) is complete.

For a type with a **trivial** default constructor, the object's lifetime begins as soon as storage is obtained *and the object is created* — and since C++20, certain operations create such objects implicitly (Ch. 3 §3.7).

Lifetime **ends** when:
- The destructor call starts (for types with a non-trivial destructor), **or**
- The storage is released or reused by another object.

```
storage obtained ──▶ [ construction ] ──▶ LIFETIME ──▶ [ destruction ] ──▶ storage released
                     ▲                                                     ▲
                     └─ before this: bytes exist, object does not ─────────┘
```

### What you may do outside the lifetime

Before construction completes or after destruction begins, the pointer/reference to the object exists but is severely restricted. You may:
- Use the pointer value itself (compare it, pass it around).
- Access it as `void*` or read the bytes through `unsigned char*`/`std::byte*`.

You may **not**: dereference it as `T*`, call any member function (including non-virtual ones — a very common misconception; there is no "it works because it doesn't touch members" carve-out), bind a reference to it, or use `static_cast` to/from a base.

```cpp
struct S { int x; void f(); virtual void g(); };
S* p = static_cast<S*>(::operator new(sizeof(S)));   // storage only, no object
p->x = 1;      // UB pre-C++20 (no object); OK C++20 if S is implicit-lifetime — it isn't (virtual)
p->f();        // UB — outside lifetime
new (p) S{};   // NOW the object exists
```

### Transparent replacement and the `const` problem

If you destroy an object and construct a new one of the same type in the same storage, pointers to the old object are usable for the new one **only if**: the storage exactly overlays, the type is the same (ignoring top-level cv), and the object has **no const or reference non-static data members**, and it isn't a base subobject. Otherwise you need `std::launder` (§5.3).

```cpp
struct C { const int id; };
C c{1};
c.~C();
new (&c) C{2};
int v = c.id;                       // UB — c has a const member; the compiler may have cached 1
int w = std::launder(&c)->id;       // OK
```
This is exactly why `std::optional<T>::emplace` and `std::variant` internally launder, and why containers of types with const members are painful.

**Interview framing:** *"When exactly does an object's lifetime begin?"* — after storage is obtained **and** initialization completes; not at declaration, not at allocation. The follow-up — "what can you legally do in between?" — separates people who have read the standard from people who have read blog posts.

---

## 5.2 Placement New

**Placement new** constructs an object in storage you already own. It performs no allocation.

```cpp
#include <new>
alignas(T) std::byte buf[sizeof(T)];
T* p = new (buf) T{args...};    // calls operator new(size_t, void*), which just returns buf
p->~T();                        // you MUST destroy manually — there is no matching delete
```
The overload `void* operator new(std::size_t, void* p) noexcept { return p; }` is defined by the standard, is not replaceable, and is a no-op. All the work is the constructor call.

### Rules and hazards

- **The storage must be sufficiently sized and aligned.** Misalignment is UB (Ch. 3 §3.3) and faults for SIMD types and atomics.
- **You must call the destructor explicitly**; `delete p` is UB (it would call `operator delete` on storage that didn't come from `operator new`).
- **Placement new on an array** (`new (buf) T[n]`) is famously broken: an implementation may reserve an unspecified `y` bytes of overhead at the front, so `buf` must be larger than `n * sizeof(T)` by an unknowable amount. Never use array placement new; loop over scalar placement new, or use `std::uninitialized_*` / `std::construct_at`.
- **Exception safety:** if a constructor throws partway through building `n` objects, you must destroy the ones already built. `std::uninitialized_copy` and friends do this correctly; hand-rolled loops usually don't.
- The returned pointer, not the original `buf` pointer, is the one you should use (§5.3).

### The modern replacements (C++20)

```cpp
std::construct_at(p, args...);   // constexpr-friendly placement new; NO parentheses/brace choice
std::destroy_at(p);              // p->~T(), no-op-loops for arrays
std::destroy(first, last);
std::uninitialized_value_construct_n(p, n);
std::uninitialized_move_n(src, n, dst);
std::allocator_traits<A>::construct(a, p, args...);  // allocator-aware form
```
`std::construct_at` is the only form usable in a **constant expression** — plain placement new is not constexpr until C++26 — which is why C++20's constexpr `std::vector` is implemented with it. Note `construct_at` always performs direct-*non-list*-initialization, so it cannot do aggregate initialization pre-C++20 relaxations; that's a known wart.

### Where it's used

Every allocator, every container's uninitialized region, `std::optional`, `std::variant`, `std::any`, small-buffer optimizations, object pools (Ch. 7 §7.10), ring buffers, and in-place deserialization. In a trading system, the standard hot-path pattern is: preallocate a slab at startup, then placement-new messages into it and `destroy_at` them — zero allocations, no `malloc` lock, no page faults after warm-up (Ch. 55 §55.1).

```cpp
// Fixed-capacity storage without constructing anything
template <class T, std::size_t N>
class InlineStorage {
    alignas(T) std::byte buf_[N * sizeof(T)];
    std::size_t n_ = 0;
public:
    template <class... A> T& emplace(A&&... a) {
        T* p = std::construct_at(reinterpret_cast<T*>(buf_) + n_, std::forward<A>(a)...);
        ++n_; return *p;
    }
    ~InlineStorage() { std::destroy_n(reinterpret_cast<T*>(buf_), n_); }
};
```
Note `std::aligned_storage`/`std::aligned_union` are **deprecated in C++23** (they were unsafe by design — the buffer's type invited `reinterpret_cast` mistakes); `alignas(T) std::byte[]` is the sanctioned form.

---

## 5.3 `std::launder` and Explicit Lifetime APIs

These are all zero-code-generation facilities whose only job is to tell the **abstract machine** something it cannot otherwise infer. They exist because the compiler is allowed to make assumptions that in-place reconstruction violates.

### The problem `launder` solves

The compiler may cache, across an in-place replacement:
- the value of a `const` non-static data member,
- the value of a reference member,
- the **vptr** of a polymorphic object,
- the dynamic type used for devirtualization.

```cpp
struct Base { virtual int f() { return 1; } };
struct D1 : Base { int f() override { return 2; } };
struct D2 : Base { int f() override { return 3; } };

Base* b = new D1;
b->~Base();
new (b) D2;
b->f();                       // UB — the compiler may have devirtualized to D1::f
std::launder(b)->f();         // OK — but note `b` must point to the right storage
```

**`std::launder<T>(T* p)`** (C++17, `<new>`) returns a pointer to the object *currently* at `p`'s address, discarding the compiler's beliefs about what used to be there. It emits no instructions; it is a barrier for the optimizer's type/value reasoning only. Requirements: an object of type `T` must actually be within its lifetime at that address, and all the bytes must be reachable from the original pointer.

**Common misconceptions to correct in an interview:**
- `launder` does **not** make `reinterpret_cast` legal, does not fix strict-aliasing violations (Ch. 3 §3.8), and does not create objects.
- It is not a memory barrier and has nothing to do with threads.
- You do not need it if the type has no const/reference members and isn't polymorphic — the "transparently replaceable" rule (§5.1) already covers you. Reaching for it reflexively is a smell.

### The full toolkit

| Facility | What it does | Emits code? | Since |
|---|---|---|---|
| `std::launder(p)` | Refresh a pointer after in-place replacement | No | C++17 |
| `std::start_lifetime_as<T>(p)` | Declare that existing bytes *are* a `T` (implicit-lifetime types only) | No | C++23 |
| `std::start_lifetime_as_array<T>(p, n)` | Same, for arrays | No | C++23 |
| `std::bit_cast<T>(x)` | Produce a **new** `T` object from `x`'s bytes | No (folded) | C++20 |
| `std::construct_at(p, ...)` | Actually run a constructor | Yes | C++20 |
| Implicit object creation | `malloc`/`new`/`memcpy` create implicit-lifetime objects | No | C++20, retroactive |

`start_lifetime_as` (Ch. 3 §3.7) is the answer for bytes arriving from `read()`, `mmap`, shared memory, or a DMA ring — storage that no implicitly-creating operation ever touched. The distinction from `launder`: `launder` assumes an object already exists and only refreshes your pointer; `start_lifetime_as` *makes* it exist.

```cpp
// Wire parsing, C++23, zero copy
const auto* hdr = std::start_lifetime_as<MsgHeader>(rx_buffer);   // no code emitted
// Wire parsing, portable, always correct:
MsgHeader hdr;  std::memcpy(&hdr, rx_buffer, sizeof hdr);         // also fixes alignment
```
The `memcpy` form is not slower in practice for small headers — the compiler turns it into direct loads — and it additionally solves alignment. Reach for `start_lifetime_as` only when the message is large and you know the buffer is aligned.

---

## 5.4 Initialization Forms

C++ has an infamous number of initialization forms. The taxonomy that actually resolves interview questions:

| Syntax | Name | For a class | For a scalar | For an aggregate |
|---|---|---|---|---|
| `T x;` | **default-initialization** | default ctor | **indeterminate** (automatic/dynamic); zero (static) | members default-init'd |
| `T x{};` | **value-initialization** | default ctor; **zero-init first** if the ctor is implicit/defaulted-on-first-declaration | **zero** | zero-init'd |
| `T x = v;` | **copy-initialization** | converting ctor, `explicit` excluded | conversion | — |
| `T x(v);` | **direct-initialization** | any ctor incl. `explicit` | conversion | — |
| `T x{v...}` | **direct-list-initialization** | `initializer_list` preferred; else ctor; **no narrowing** | no narrowing | aggregate init (§5.5) |
| `T x = {v...}` | **copy-list-initialization** | same but `explicit` ctors are an error if chosen | same | aggregate init |
| `new T` / `new T()` / `new T{}` | default / value / value | | | |
| `static T x;` | zero-init then dynamic init | | | |

### The rules that matter

**1. Default-initialization of a scalar leaves it indeterminate** — the source of most uninitialized-read bugs. `int x;` at block scope is garbage; at namespace/static scope it is zero (static initialization, §5.9). In C++26 reading it is *erroneous behaviour* (P2795): a diagnosable wrong value rather than UB, and compilers gain `-ftrivial-auto-var-init`-style guaranteed patterns.

**2. `T x{}` is not always cheap.** Value-initializing a large aggregate emits a `memset`; on a hot path, `T x;` followed by explicit field writes may be faster — but only if you truly write every field. `struct Buf { char data[65536]; }; Buf b{};` is a 64 KB `memset` you may not have intended.

**3. Narrowing conversions are ill-formed in list-initialization:**
```cpp
int    a(3.5);   // OK — truncates to 3
int    b{3.5};   // ERROR — narrowing
char   c{300};   // ERROR — constant doesn't fit
uint32_t d{-1};  // ERROR
```
This is a genuine reason to prefer braces: it turns silent truncation (Ch. 2 §2.3) into a compile error.

**4. `initializer_list` hijacking** — the most-cited brace pitfall:
```cpp
std::vector<int> v1(10, 5);   // 10 elements, each 5
std::vector<int> v2{10, 5};   // 2 elements: 10 and 5
```
If a type has *any* `initializer_list` constructor, brace-init prefers it over every other constructor, even when another is a much better match — and even if it requires a narrowing that then errors. `std::vector<std::string> v{10}` fails to compile for exactly this reason (10 doesn't convert to string, but the `initializer_list<string>` ctor is still preferred and then rejected... actually it drops out and the size ctor wins — the subtlety is worth knowing: hijacking applies only when the `initializer_list` ctor is *viable*).

**5. Value-init vs default-init for classes with defaulted constructors** is genuinely subtle:
```cpp
struct A { int x; };                  // no user-provided ctor
struct B { B() {} int x; };            // user-PROVIDED ctor
struct C { C() = default; int x; };    // defaulted on first declaration

A a{};   // x == 0 (zero-initialized)
B b{};   // x INDETERMINATE — the user-provided ctor runs and does nothing
C c{};   // x == 0 — `= default` on first declaration is not "user-provided"
struct D { D(); int x; };  D::D() = default;   // user-provided (defaulted OUTSIDE the class)
D d{};   // x INDETERMINATE
```
Whether `= default` appears inside or outside the class changes the semantics. This is a top-tier trivia question and a real bug source.

**6. `new T` vs `new T()`** — the former leaves POD members indeterminate, the latter zero-initializes them. `new int` is garbage; `new int()` is 0.

### Recommendation

Use braces by default (narrowing protection, no most-vexing-parse), with two exceptions: constructors where `initializer_list` would hijack (containers with a size argument), and large aggregates where you do not want the implicit zeroing.

---

## 5.5 Aggregate Initialization

An **aggregate** is a class or array with no user-declared/inherited constructors, no private/protected non-static data members, no virtual functions, and no virtual/private/protected base classes. Note the evolution:

| Standard | Aggregate change |
|---|---|
| C++11 | No brace-or-equal initializers (NSDMIs) allowed |
| **C++14** | NSDMIs allowed (`struct S { int x = 1; };` is an aggregate) |
| **C++17** | **Base classes allowed** — aggregates can derive; init the base with nested braces |
| **C++20** | `explicit`/user-*declared* (not just user-provided) constructors disqualify; **designated initializers** added; parenthesized aggregate init added |
| C++26 | Aggregates gain some reflection interaction |

```cpp
struct Base { int b; };
struct Agg : Base { int x; int y = 5; };       // C++17 aggregate with a base and an NSDMI
Agg a{{1}, 2};            // Base{1}, x=2, y=5
Agg b{.x = 2};            // C++20 designated init; b.b value-init'd, y = 5
```

### Designated initializers (C++20)

```cpp
struct Config { int port = 0; int backlog = 128; bool nodelay = false; };
Config c{.port = 9000, .nodelay = true};
```
C++'s version is stricter than C's: **initializers must appear in declaration order**, you cannot skip and come back, no nested designators (`.a.b = 1` is C-only), and no array designators (`[3] = x` is C-only). Skipped members get their NSDMI or are value-initialized. This is the modern replacement for parameter-object builders and for long positional constructor calls where argument order is a bug waiting to happen.

### Why aggregates matter for performance and layout

- Aggregates are **standard-layout** and typically **trivially copyable** (Ch. 3 §§3.5–3.6), so they `memcpy`, go in registers (Ch. 4 §4.17), and are valid in shared memory.
- Aggregate initialization is **copy-initialization of each element in order, left to right, sequenced** (Ch. 4 §4.3) — unlike constructor arguments.
- If there are fewer initializers than members, the rest are **value-initialized** (so `Point p{};` zeroes everything; `Point p{1};` zeroes `y`). This is the cheap way to zero a struct without `memset` — but note it does **not** zero padding (Ch. 3 §3.2).
- Adding a private member or a constructor silently makes the type a non-aggregate, breaking every `T x{a,b}` at every call site. This is an API-stability consideration.

**C++20 parenthesized aggregate initialization** (`Agg a(1, 2)`) exists mainly so `emplace_back`, `make_unique`, and `allocator::construct` work with aggregates — they use parentheses internally and previously could not construct aggregates at all. That was a notorious gap; naming it is a good signal.

---

## 5.6 Most Vexing Parse

**The rule:** anything that *can* be parsed as a declaration *is* a declaration.

```cpp
Widget w();               // a FUNCTION declaration: w() returning Widget — not a default-constructed Widget
Widget w(Gadget());       // a FUNCTION taking a (pointer to) function returning Gadget, returning Widget
std::lock_guard<std::mutex>(m);   // declares a lock_guard named `m` — the lock is released IMMEDIATELY
Timer t(std::chrono::seconds(1)); // fine — the argument isn't parseable as a parameter declaration
```

The third line is the dangerous one in production: it compiles, it shadows the mutex name, and it provides **zero mutual exclusion**. `-Wvexing-parse` (Clang) and `-Wunused-variable` catch some cases; `[[nodiscard]]`-style discipline does not help because the object is named.

Related: `std::unique_lock<std::mutex> lk;` with the mutex forgotten, and `std::scoped_lock(m);` (C++17) which has the same failure and is why CTAD makes this *more* likely, not less.

### Fixes

```cpp
Widget w{};                          // braces — cannot be a function declaration
Widget w2{Gadget{}};
auto w3 = Widget();                  // copy-init form
std::lock_guard<std::mutex> lg(m);   // always name your lock
std::lock_guard lg{m};               // CTAD + braces (C++17)
```
Braces are the general answer, and this is the strongest single argument for uniform initialization. The one place braces cannot help: `Widget w{};` vs `Widget w;` differ (value- vs default-init, §5.4), so you are also making a semantic choice.

A related parse trap:
```cpp
struct S { S(int); };
S s = S();     // fine
int (x);       // declares int x — parentheses around a declarator are legal
int (*fp)();   // pointer to function
```

**Interview framing:** show the `lock_guard` case, not the `Widget w()` case. The former is a real outage; the latter is a textbook curiosity.

---

## 5.7 Temporary Materialization and Lifetime Extension

### Materialization

Since C++17, a **prvalue** is not an object (Ch. 4 §4.1); it is a recipe. A **temporary materialization conversion** turns a prvalue into an xvalue, creating the temporary object. It happens when you:

- bind a reference to a prvalue,
- access a member of a prvalue,
- subscript or convert an array prvalue,
- bind to a base-class reference,
- use it where a glvalue is required (e.g. `typeid`, `sizeof` does *not*).

This deferred model is what makes **guaranteed copy elision** work: `T x = T(T(f()));` creates exactly one object because the intermediate prvalues never materialize.

### Lifetime extension

A temporary bound directly to a **reference** has its lifetime extended to that of the reference:

```cpp
const std::string& r = make_string();      // extended to r's scope
std::string&& rr = make_string();          // also extended
```

**The exceptions are where the bugs are:**

| Case | Extended? |
|---|---|
| Local `const T&` / `T&&` bound to a prvalue | **Yes** — to the reference's scope |
| A **reference member** initialized in a ctor-init-list | **No** — dies at the end of the constructor |
| A reference **returned** from a function | **No** — dangles |
| A **function parameter** `const T&` | Only until the end of the full-expression of the call |
| Binding to a *subobject* of a temporary (`const int& r = f().member;`) | **Yes** — extends the whole temporary |
| Binding through a **function call** returning a reference (`const T& r = id(T{})`) | **No** — extension does not pass through function boundaries |
| `auto&& r = ...` in a range-for over a function returning a container | **Yes** for the range initializer; but not for nested temporaries pre-C++23 |

```cpp
struct Holder { const std::string& s; Holder(const std::string& x) : s(x) {} };
Holder h{std::string("temp")};    // DANGLES — extension doesn't apply to member binding
                                  // the temporary dies at the end of the full-expression

const std::string& bad() { return std::string("x"); }   // DANGLES — -Wreturn-local-addr

// The range-for trap (fixed in C++23, P2718):
for (char c : get_vector_of_strings()[0]) { ... }   // pre-C++23: the vector temporary dies
                                                    // before the loop body runs → UB
```
**C++23 P2718 ("Lifetime extension in range-based for")** extends *all* temporaries in the range-initializer to the loop's duration, closing that hole. Knowing this specific fix is a strong signal.

Related dangling families, all the same shape:
- `std::string_view sv = std::string("x");` — the view outlives the string (Ch. 13 §13.3). C++23 added deleted overloads for some of these; `-Wdangling-gsl` catches many.
- A lambda capturing by reference and stored (Ch. 18 §18.9).
- `std::optional<T&>` — deliberately absent until C++26 for exactly these reasons.
- `auto&& x = f().g();` where `g()` returns a reference into the temporary.

`decltype(auto)` and `auto&&` in generic wrappers can extend or fail to extend depending on what the wrapped call returns — which is why C++26's **`std::ranges::to`** and the reflection-era proposals care so much about lifetime annotations.

---

## 5.8 RAII

**Resource Acquisition Is Initialization**: bind a resource's lifetime to an object's lifetime, so the destructor releases it deterministically. It is the single organizing idea of C++ resource management and the reason C++ does not need `finally`.

```cpp
class FileDesc {
    int fd_ = -1;
public:
    explicit FileDesc(const char* p) : fd_(::open(p, O_RDONLY)) {
        if (fd_ < 0) throw std::system_error(errno, std::system_category());
    }
    ~FileDesc() { if (fd_ >= 0) ::close(fd_); }
    FileDesc(FileDesc&& o) noexcept : fd_(std::exchange(o.fd_, -1)) {}
    FileDesc& operator=(FileDesc&& o) noexcept { std::swap(fd_, o.fd_); return *this; }
    FileDesc(const FileDesc&) = delete;
    FileDesc& operator=(const FileDesc&) = delete;
    int get() const noexcept { return fd_; }
};
```

Why it is more than a convenience:
- **Exception safety comes for free** (Ch. 10 §10.6). During stack unwinding every fully-constructed automatic object is destroyed, in reverse order, so no path can skip the release. `goto`, early `return`, and `break` are equally covered.
- **Deterministic release** — unlike GC finalizers, the resource is freed at a known point, which matters for file descriptors, locks, and NIC ring slots.
- **Composability** — a class holding three RAII members needs no destructor at all (Rule of Zero, Ch. 6 §6.2).

### The critical invariants

1. **Destructors must not throw.** They are implicitly `noexcept` since C++11; throwing calls `std::terminate` if it escapes during unwinding. If release can fail (`close()` returning `EIO`, `fclose`, a database commit), provide an explicit `close()` that reports errors and have the destructor swallow or log.
2. **A constructor that throws means no destructor runs** for that object — but all fully-constructed members and bases *are* destroyed (§5.9). This is why acquiring two resources in one constructor body is a leak risk, and why each resource should be its own RAII member.
3. **Move must leave the source releasable** — `std::exchange` to a sentinel is the idiom.
4. **Ownership must be unambiguous**; the copy operations are usually deleted (Ch. 6 §6.3).

### Standard RAII types

`std::unique_ptr` (with a custom deleter for C handles — Ch. 9 §9.2), `std::shared_ptr`, `std::lock_guard`/`std::unique_lock`/`std::scoped_lock`, `std::jthread` (C++20, joins on destruction), `std::fstream`, `std::vector`. Scope guards (`ScopeExit`, Ch. 10 §10.13) generalize RAII to arbitrary cleanup lambdas; `std::experimental::scope_exit` never shipped, but `absl::Cleanup`, `folly::ScopeGuard`, and GSL's `finally` are ubiquitous.

**Low-latency note:** RAII is free in the sense that the destructor is inlined and often compiles to nothing, but it is *not* free at ABI boundaries — a non-trivial destructor forces memory-passing (Ch. 4 §4.17) and **disables tail-call optimization** because cleanup must run after the call returns. On a hot dispatch loop, an RAII timer object in scope can prevent the compiler from turning a dispatch into a `jmp`. That's a nice, non-obvious cost to name.

---

## 5.9 Construction and Destruction Order

### Within one object

```
Construction:                         Destruction (exact reverse):
1. Virtual bases (most-derived first) 1. Body
2. Direct bases, in DECLARATION order 2. Members, reverse declaration order
3. Members, in DECLARATION order      3. Direct bases, reverse declaration order
   (NOT initializer-list order!)      4. Virtual bases
4. Constructor body
```

**Members are initialized in declaration order, regardless of the order you write them in the member-initializer list.** Writing them out of order is a bug generator and `-Wreorder` warns:

```cpp
struct S {
    int a;
    int b;
    S(int x) : b(x), a(b) {}     // a is initialized FIRST, from an uninitialized b — garbage
};
```

**During construction, the dynamic type is the class currently being constructed.** So a virtual call in a base constructor dispatches to the *base's* override, not the derived one — the vptr is set per-stage. Calling a pure virtual from a base constructor invokes `__cxa_pure_virtual` and aborts. Same in reverse during destruction. The rule exists because the derived members do not exist yet; a "polymorphic init" call would operate on uninitialized state. The idiom is two-phase init (a separate `init()` call) or, better, passing behaviour in via a parameter/CRTP (Ch. 6 §6.19).

**If a constructor throws**, the object's lifetime never began: its destructor does not run, but all fully-constructed base and member subobjects are destroyed in reverse order, and for `new` expressions the matching `operator delete` is called automatically to release the storage. A `try`-block **function-try-block** on a constructor can catch member-init exceptions but must rethrow (falling off the end implicitly rethrows), and cannot access members.

### Across objects

| Category | Order |
|---|---|
| Automatic objects in a scope | Construction in declaration order; destruction in exact reverse |
| Function parameters | Construction order unspecified (Ch. 4 §4.3); destruction at end of full-expression |
| Temporaries | Destroyed at the end of the full-expression, in reverse creation order |
| Array elements | Ascending index; destroyed descending |
| Namespace-scope objects **within one TU** | Declaration order; destroyed in reverse (registered via `__cxa_atexit`) |
| Namespace-scope objects **across TUs** | **UNSPECIFIED** — §5.10 |
| Function-local `static` | On first control-flow pass, thread-safely; destroyed in reverse of *construction* order at exit |
| `thread_local` | First use in that thread; destroyed at thread exit, before static destructors |

Destruction at exit is itself a hazard: a static destructor may run after another TU's static it depends on has already died — the **static destruction order fiasco**, the mirror image of §5.10, and the reason long-lived singletons are often deliberately leaked (`static T* p = new T;` with no delete) or wrapped in `std::optional`/manual lifetime control. In a trading process, running destructors at shutdown can be actively harmful (touching freed shared memory, unregistering from an exchange session mid-teardown); `std::quick_exit`/`_exit` skip them deliberately.

---

## 5.10 Static Initialization Order Fiasco

Namespace-scope objects are initialized in two phases:

**Phase 1 — static initialization** (before `main`, at load time):
- **Zero-initialization** for everything without a constant initializer (`.bss`).
- **Constant initialization** for objects whose initializer is a constant expression — the value is computed by the compiler and baked into `.data`. No code runs.

**Phase 2 — dynamic initialization** (running constructors):
- **Ordered** within a translation unit: declaration order.
- **Unordered/indeterminate across translation units.** The linker decides, and it varies with link order, LTO, static vs shared libraries, and whether the object file was pulled from an archive at all.

```cpp
// a.cpp
extern Registry& reg();
Widget w("alpha");            // ctor calls reg().add(this)
// b.cpp
Registry g_registry;          // may be constructed AFTER w — using it is UB
```

### The fixes, ranked

**1. `constinit` (C++20)** — asserts that the variable is *constant-initialized*, so it participates in phase 1 and cannot be part of the fiasco:
```cpp
constinit std::atomic<uint64_t> g_seq{0};       // guaranteed no dynamic init
constinit Table g_table = make_table();          // compile error if make_table isn't constexpr
```
This is the correct default annotation for globals in a latency-sensitive process: no dynamic initializer, no ordering hazard, no startup cost, no guard variable.

**2. Construct-on-first-use (Meyers singleton)** — a function-local static:
```cpp
Registry& reg() { static Registry r; return r; }
```
Guaranteed initialized before first use, and **thread-safe since C++11** (the "magic statics" rule: concurrent callers block until initialization completes). Cost: the compiler emits a **guard variable** check on every call — an acquire-load of a byte plus a predictable branch. In a hot loop that's usually 1–2 cycles and perfectly predicted, but it is not free, and `-fno-threadsafe-statics` removes the locking (and the safety). Recursive initialization deadlocks or aborts.

**3. Leak deliberately** — `static Registry& r = *new Registry;` avoids destruction-order problems entirely at the cost of a reported leak (suppress in LSan).

**4. Explicit init phase** — a `void init_all()` called at the top of `main`, with everything else being a pointer or `optional`. This is the most common answer in trading systems, because it also makes startup ordering, warm-up, and failure handling explicit and testable.

**5. `nifty counter` / Schwarz counter** — the technique `<iostream>` uses: each TU including the header declares a static counter object whose constructor initializes the shared object on first increment. Worth being able to name.

### Related hazards

- **`std::cout` before `main`** works only because of the Schwarz counter in `<iostream>`; your own globals get no such guarantee.
- **Dynamic initialization in a shared library** runs at `dlopen`/load time via `.init_array`, in an order determined by dependency ordering — and static-library members not referenced may never be linked in at all, so their initializers never run. This is why self-registering factory patterns silently break when moved into a static library; the fix is `--whole-archive` or an explicit reference (Ch. 1 §1.11).
- **`thread_local` dynamic initialization** happens on first use in each thread and adds a TLS guard check to every access through the wrapper function — a measurable hot-path cost, avoidable with `constinit thread_local`.

---

## 5.11 Empty-Base Optimization

Introduced in Ch. 3 §3.4; here is the *why* and the design consequence.

An empty class has `sizeof >= 1` so distinct objects have distinct addresses. But a base subobject has no such requirement, so an empty base may occupy **zero** bytes:

```cpp
struct Empty {};
struct WithMember  { Empty e; int i; };   // sizeof 8  (e occupies a byte + 3 padding)
struct WithBase : Empty { int i; };       // sizeof 4  — EBO
```

EBO fails (the base takes a byte) when the same empty type appears twice in the hierarchy at the same offset, which is why the standard requires the base not be of the same type as the first data member.

### Why the standard library is built on it

Stateless function objects and allocators are everywhere, and storing them as members would cost 8 bytes each after padding:

| Type | Without EBO | With EBO |
|---|---|---|
| `std::unique_ptr<T, StatelessDeleter>` | 16 | **8** — same as `T*` |
| `std::vector<T, std::allocator<T>>` | 32 | **24** — three pointers |
| `std::set<K, std::less<K>>` node header | +8 per container | +0 |
| A lambda-as-comparator in a container | +1..8 | 0 |

This is why libstdc++ and libc++ historically used `_Tuple_impl`-style inheritance chains and `__compressed_pair` (libc++'s explicit EBO helper) rather than plain members. `boost::compressed_pair` is the classic standalone implementation.

### `[[no_unique_address]]` and the modern answer

C++20's `[[no_unique_address]]` (§5.12) removes the need to contort your class hierarchy for size. Modern libc++ has been migrating `__compressed_pair` to it. The interview point: **before C++20, "prefer composition over inheritance" had a concrete performance exception**, and `[[no_unique_address]]` finally removed it.

**Low-latency framing:** these are not trivial savings. A `std::unique_ptr` that is 8 bytes instead of 16 fits twice as many per cache line in an array of handles, and a vector at 24 bytes fits into the same line as neighbouring members. In a struct-of-arrays layout (Ch. 42 §42.2) the difference compounds directly into the miss rate.

---

## 5.12 `[[no_unique_address]]`

C++20. Applied to a **non-static data member**, it permits the member to share an address with another object, occupying zero bytes if it is empty.

```cpp
template <class T, class Alloc = std::allocator<T>>
class Vector {
    T* begin_; T* end_; T* cap_;
    [[no_unique_address]] Alloc alloc_;     // zero bytes for a stateless allocator
};
static_assert(sizeof(Vector<int>) == 24);
```

### Rules and gotchas

- It is a **permission, not a requirement** — the compiler may still give the member a unique address.
- **Two `[[no_unique_address]]` members of the same type cannot overlap each other** (they must have distinct addresses, being distinct objects of the same type), so:
  ```cpp
  struct S { [[no_unique_address]] Empty a, b; int i; };   // a and b need distinct addresses
  ```
  `sizeof(S)` is 8, not 4 — the two empties cannot both be at offset 0. Wrapping one in a distinct tag type restores the optimization. This is exactly the same constraint as EBO's.
- It can also let a member occupy another member's **tail padding**:
  ```cpp
  struct Pad { int i; char c; };                  // sizeof 8, 3 bytes tail padding
  struct T { [[no_unique_address]] Pad p; char d; };  // d may go in p's padding → sizeof 8
  ```
  This is a real behaviour change beyond empty members, and it means **`memcpy(&t.p, src, sizeof(Pad))` can clobber `t.d`** — the same hazard as tail-padding reuse in derived classes (Ch. 3 §3.4).
- **It changes ABI.** Adding or removing it on a public type breaks binary compatibility. MSVC could not adopt it without breaking its ABI and provides `[[msvc::no_unique_address]]` instead; portable code needs a macro.
- It has no effect on a non-empty member other than the tail-padding case.

### Where to use it

Stateless deleters, allocators, comparators, hashers, projections, empty policy/tag types, and CRTP-adjacent mixins stored by value. Anywhere you would previously have written a private inheritance hack. Combine with `static_assert(sizeof(X) == N)` (Ch. 3 §3.12) because whether it applied is invisible otherwise.

---

## 5.13 Union Active-Member Rules

A **union** stores at most one member at a time; all members share offset zero. Its size is that of the largest member, its alignment the strictest.

**Exactly one member is *active*** — the one whose lifetime has begun. Reading any other member is UB, with the sole exception of the **common initial sequence** rule for standard-layout structs (Ch. 3 §3.11).

```cpp
union U { int i; float f; };
U u; u.i = 1;
float x = u.f;      // UB in C++ (legal in C). GCC/Clang document it as an extension.
```

### Changing the active member

Assignment to a member of **trivial** type implicitly begins its lifetime and makes it active:
```cpp
u.f = 3.14f;        // f is now active; i's lifetime ended
```
For **non-trivial** members you must destroy the old and placement-new the new:
```cpp
union V { std::string s; std::vector<int> v; 
          V() : s() {} 
          ~V() {} };          // ← must be user-provided; the union can't know which to destroy
V x;
x.s.~basic_string();
new (&x.v) std::vector<int>{};
```
If any member has a non-trivial default constructor, copy/move constructor, destructor, or assignment, the union's corresponding special member is **implicitly deleted** and you must write it yourself, tracking the active member externally. This is why raw unions of non-trivial types are almost always the wrong tool.

### Anonymous unions and tagged unions

```cpp
struct Message {
    uint8_t type;
    union { Add add; Cancel cancel; Trade trade; };   // anonymous: members injected into Message
};
```
This is the standard wire-message shape (Ch. 51 §51.7): all members trivially copyable, the tag adjacent, no lifetime bookkeeping needed because everything is trivial.

### `std::variant` (C++17) versus a raw union

| | Raw union | `std::variant` |
|---|---|---|
| Tag | You maintain it | Built in (usually 1–8 bytes + padding) |
| Wrong-member read | **UB** | `std::get` throws `bad_variant_access`; `get_if` returns null |
| Non-trivial members | Manual ctor/dtor/assignment | Handled |
| Trivial members | Trivially copyable | **Also trivially copyable** since C++17 if all alternatives are |
| Dispatch | `switch` on your tag — jump table, predictable | `std::visit` — historically a function-pointer table (indirect call), now often a `switch` after inlining |
| `valueless_by_exception` | n/a | A real state after a throwing move; complicates every visit |
| Size | max member | max member + tag + padding |

`std::visit`'s historical cost is worth knowing: libstdc++ builds an N-dimensional table of function pointers, so a visit is an **indirect call** (Ch. 4 §4.9) that the compiler cannot inline. Recent libstdc++/libc++ special-case small variants into a `switch`, but on a hot path a hand-rolled `switch (msg.type)` over a tagged union is still the reliably-faster choice, and saying so — with the reason — is a good low-latency answer. `std::variant`'s never-valueless guarantee for trivially-movable alternatives means the exception state is usually absent in practice.

C++20 makes unions usable in constant expressions, including switching the active member — which is what allows `constexpr std::variant` and `constexpr std::optional`.

---

## 5.14 Destruction Through Base Pointers

```cpp
struct Base { ~Base(); };                  // NON-virtual
struct Derived : Base { std::vector<int> v; };
Base* p = new Derived;
delete p;                                  // UNDEFINED BEHAVIOUR
```

**Deleting an object of derived type through a pointer to a base with a non-virtual destructor is UB.** In practice: `Derived`'s destructor never runs (so `v`'s heap buffer leaks), and `operator delete` is called with the *base* subobject's address and, under sized deallocation (§5.15), `sizeof(Base)` — which for multiple inheritance can be a genuinely wrong pointer, corrupting the allocator rather than merely leaking.

### How virtual destructors work

A virtual destructor gets a vtable slot like any other virtual function; `delete p` loads the destructor pointer from the vptr and calls it. Under the Itanium ABI there are actually **two or three** destructor symbols per class:

| Symbol | Name | Purpose |
|---|---|---|
| `D2` | complete object destructor | destroys members and non-virtual bases |
| `D1` | base object destructor | as D2 but skips virtual bases |
| `D0` | **deleting destructor** | calls D1 then `operator delete` — this is what's in the vtable slot |

The `D0` variant is the mechanism that makes `delete p` call the right `operator delete` with the right size and address — and it's why the vtable-based path also fixes the pointer adjustment under multiple inheritance.

### The decision rule

| Situation | Destructor |
|---|---|
| Class is deleted polymorphically | **`virtual ~T() = default;`** |
| Class has any virtual function | Make the destructor virtual (you almost certainly delete polymorphically) |
| Base is used polymorphically but never owned via base pointer | `protected: ~T();` non-virtual — statically prevents `delete p` |
| Value type / final / no inheritance | Non-virtual (keep it trivially destructible) |
| Mixin / CRTP base (Ch. 6 §6.19) | `protected:` non-virtual — no vtable at all |

`protected: ~Base() = default;` is the underused answer: it makes `delete base_ptr;` a **compile error** while allowing derived classes and stack objects, and costs nothing. Use it for interfaces that are always owned by `unique_ptr<Derived>` or stored by value.

### Cost of adding a virtual destructor

It is not free, and this is the interview point:
- The class gains a **vptr**: +8 bytes, and the class stops being trivially copyable, standard-layout-with-data, and `memcpy`-able (Ch. 3 §§3.5–3.6). It can no longer be passed in registers (Ch. 4 §4.17) or placed in shared memory.
- Destruction becomes an **indirect call** that cannot be inlined or elided.
- The compiler can no longer omit the destructor loop for containers of the type.

So: `virtual` destructors on interfaces, never on small value types. A `struct Point` with a virtual destructor is 24 bytes instead of 8 and stops being a POD — a real, observed mistake.

**`std::shared_ptr` is the exception:** it captures the deleter from the *constructing* type, so `shared_ptr<Base> p = make_shared<Derived>()` destroys correctly even with a non-virtual base destructor (the control block stores a type-erased deleter). `unique_ptr` does **not** — its deleter is part of its type, so it requires the virtual destructor. That contrast is a favourite question (Ch. 9 §9.3).

---

## 5.15 Sized, Aligned, and Destroying `delete`

Three separate extensions to deallocation, all about giving `operator delete` more information so it can be faster or more correct.

### Sized deallocation (C++14)

```cpp
void operator delete(void* p) noexcept;
void operator delete(void* p, std::size_t size) noexcept;   // C++14 — preferred if declared
```
The compiler knows the static type at the `delete` site and passes `sizeof(T)`. **Why it matters:** size-segregated allocators (tcmalloc, jemalloc, most pool allocators) otherwise have to *look up* the size class from the pointer — a lookup in a radix tree or a read of the span header, which is an extra dependent memory access and often a cache miss on the free path. Passing the size turns free into arithmetic. Google measured meaningful gains from this in tcmalloc, which is why it was standardized.

Gotchas: GCC enables it by default (`-fsized-deallocation`); Clang historically did **not** in C++14 mode because of an ABI/compatibility concern — if you replace `operator delete(void*)` globally but not the sized form, the default sized version forwards to yours, but the reverse trap exists too. **If you replace one, replace both**, and make them consistent. For polymorphic deletion the size passed is the *dynamic* size, computed via the deleting destructor (§5.14), which is another reason non-virtual base deletion corrupts allocators.

### Aligned allocation (C++17)

```cpp
void* operator new(std::size_t, std::align_val_t);
void  operator delete(void*, std::align_val_t) noexcept;
void  operator delete(void*, std::size_t, std::align_val_t) noexcept;
```
Before C++17, `new` could not honour `alignas` beyond `alignof(std::max_align_t)` (16 on x86-64), so `new alignas(64) CacheLinePadded` silently returned under-aligned memory — a genuine correctness bug for SIMD types and false-sharing padding (Ch. 3 §3.3). C++17 routes over-aligned types to the aligned overloads automatically. Compile with `-faligned-new` on older toolchains; check `__cpp_aligned_new`. Note the aligned and unaligned families are **separate pools** in some implementations: memory from aligned `new` must go back through aligned `delete`, which the compiler handles as long as the type is complete at both sites.

### Destroying `delete` (C++20)

```cpp
struct Node {
    void operator delete(Node* p, std::destroying_delete_t);   // destructor NOT called first
};
```
Normally `delete p` runs `p->~T()` and *then* calls `operator delete`. With a destroying delete, `operator delete` is invoked with the object **still alive**, and it is responsible for destroying it.

Why: it lets the deallocation function *read the object* to decide how to free it. The motivating cases are variable-sized objects (a header whose payload length is stored in the object itself — trailing-array/"flexible array member" types), reference-counted intrusive objects, and objects whose allocation arena is recorded inside them:

```cpp
void Node::operator delete(Node* p, std::destroying_delete_t) {
    std::size_t n = p->length;      // still readable — this is the whole point
    p->~Node();
    ::operator delete(p, sizeof(Node) + n * sizeof(Elem));
}
```
Without it you had to duplicate the size computation at every `delete` site or store the arena pointer redundantly.

### The full set of gotchas

- **Mismatched pairs** — `new[]`/`delete`, `malloc`/`delete`, placement-new/`delete` are all UB. `delete[]` needs the array cookie that `new[]` wrote (Ch. 7 §7.2).
- **Class-specific `operator delete` is looked up statically** unless the destructor is virtual — another consequence of §5.14.
- **`operator delete` must be `noexcept`**; throwing from it is `terminate`.
- **Deleting an incomplete type** is UB with no diagnostic if the type has a non-trivial destructor — `unique_ptr<Incomplete>` requires the destructor to be defined where the type is complete, which is the PIMPL rule (Ch. 44 §44.14): declare `~Widget();` in the header and define it (even as `= default`) in the `.cpp`.

---

## Key Interview Questions

1. **When exactly does an object's lifetime begin and end?** — Begins when storage is obtained *and* initialization completes; ends when the destructor call starts or the storage is reused. Storage duration and lifetime are separate.
2. **What may you legally do with a pointer to storage before construction?** — Copy/compare the pointer, access bytes via `unsigned char*`/`std::byte*`, cast to `void*`. Not: dereference as `T*`, call any member (even non-virtual), or bind a reference.
3. **Why must you never use array placement new?** — The implementation may reserve an unspecified amount of overhead at the front, so the required buffer size is unknowable.
4. **What problem does `std::launder` solve?** — Refreshes a pointer after in-place replacement when the compiler may have cached a const member, a reference member, or the vptr. It creates nothing and does not legalize aliasing.
5. **`launder` vs `start_lifetime_as` vs `bit_cast` vs `construct_at`?** — Refresh a pointer / declare existing bytes are an object / make a new object from bytes / actually run a constructor. Only the last emits code.
6. **Difference between `T x;`, `T x{};`, and `T x = T();`** — Default- vs value- vs copy-initialization; for scalars and PODs the first leaves indeterminate values and the others zero.
7. **Why does `struct B { B() {} int x; }; B b{};` leave `x` indeterminate but `struct C { C() = default; int x; }; C c{};` zero it?** — A constructor defaulted *on its first declaration* is not user-provided, so value-initialization zero-initializes first.
8. **`std::vector<int> v(10,5)` vs `{10,5}`?** — `initializer_list` constructors are preferred by brace-init whenever viable: 10 fives vs two elements.
9. **What's the most vexing parse, in a form that matters?** — `std::lock_guard<std::mutex>(m);` declares a variable named `m` and locks nothing. Braces fix it.
10. **Which temporaries get lifetime extension, and which famously don't?** — Direct binding to a local reference extends; reference *members*, returned references, and binding through a function call do not. C++23 fixed the range-for case.
11. **Why is a virtual call in a constructor dispatched to the base's override?** — The dynamic type during construction is the class being constructed; derived members don't exist yet. Pure-virtual calls abort.
12. **In what order are members initialized?** — Declaration order, not initializer-list order (`-Wreorder`).
13. **What is the static initialization order fiasco and how do you fix it?** — Cross-TU dynamic initialization order is unspecified; fix with `constinit`, function-local statics (thread-safe since C++11, at the cost of a guard check), or an explicit init phase.
14. **What does EBO buy, and what replaced it?** — Zero-size empty bases, which is why `unique_ptr` with a stateless deleter is 8 bytes; `[[no_unique_address]]` gives the same for members.
15. **Why do two `[[no_unique_address]]` members of the same empty type not both vanish?** — Distinct objects of the same type require distinct addresses.
16. **When is reading an inactive union member legal?** — Only through the common initial sequence of standard-layout structs; otherwise UB (though a documented GCC/Clang extension).
17. **`std::variant` vs a hand-rolled tagged union on a hot path?** — `variant` gives safety and correct lifetimes but `std::visit` was historically an indirect call through a table; a `switch` on your own tag inlines reliably.
18. **What exactly goes wrong when deleting a `Derived` through a non-virtual `Base*`?** — Derived's destructor is skipped (leak), and `operator delete` gets the base subobject's address and `sizeof(Base)` — allocator corruption under multiple inheritance or sized delete.
19. **What is the cost of adding a virtual destructor to a small type?** — A vptr (+8 bytes), loss of trivial copyability and register passing, and a non-inlinable indirect destructor call.
20. **Why does `shared_ptr<Base> p = make_shared<Derived>()` destroy correctly without a virtual destructor, but `unique_ptr` doesn't?** — `shared_ptr` type-erases the deleter into the control block at construction; `unique_ptr`'s deleter is part of its type.
21. **Why does sized deallocation matter?** — Size-class allocators otherwise must look up the size from the pointer — a dependent load and likely cache miss on every free.
22. **What is destroying `delete` for?** — Reading the object (e.g. its trailing-array length or arena pointer) to decide how to deallocate, before it is destroyed.

---

## Common Traps

- **Calling a member function on storage before construction** — even a non-virtual one is UB.
- **Array placement new** — unknowable overhead; loop scalar placement new instead.
- **Forgetting the explicit destructor call** after placement new — silent resource leak with no allocator complaint.
- **Reaching for `std::launder` reflexively** — it doesn't legalize `reinterpret_cast` or fix aliasing.
- **`T x;` for a POD at block scope** — indeterminate; UB to read (erroneous in C++26).
- **`Widget w();`** — a function declaration. And **`std::lock_guard<std::mutex>(m);`** — no locking at all.
- **`{}` hijacked by an `initializer_list` constructor** — `vector<int>{10,5}` is two elements.
- **`= default` outside the class body** makes the constructor user-provided, silently changing value-initialization semantics.
- **Value-initializing a large aggregate on a hot path** — an unintended `memset`.
- **Initializing a reference member from a temporary** — no lifetime extension; dangles at the end of the full-expression.
- **Returning a reference or `string_view` to a local or temporary.**
- **Pre-C++23 range-for over a temporary's subobject** — the temporary dies before the body runs.
- **Writing member-initializers out of declaration order** — they run in declaration order (`-Wreorder`).
- **Virtual call in a constructor or destructor** — dispatches to the current stage's override; pure virtual aborts.
- **Throwing from a destructor** — implicitly `noexcept`, so it terminates during unwinding.
- **Two resources acquired in one constructor body** — the first leaks if the second throws.
- **Cross-TU global initialization dependencies** — unspecified order; use `constinit` or explicit init.
- **Self-registering factories in a static library** — the object file is never pulled in, so the initializer never runs; needs `--whole-archive`.
- **Function-local statics in a hot loop** — a guard-variable check on every call; `-fno-threadsafe-statics` trades safety for it.
- **Static destruction order at shutdown** — a dependency may already be destroyed; consider deliberate leaks or `_exit`.
- **Reading an inactive union member** — UB in C++ despite being legal C.
- **A union with any non-trivial member** — special members implicitly deleted; you must track the active member yourself.
- **`[[no_unique_address]]` members occupying tail padding** — `memcpy` into the member clobbers the neighbour.
- **Adding/removing `[[no_unique_address]]` on a shipped type** — ABI break.
- **Non-virtual destructor on a polymorphically-deleted base** — leak or allocator corruption; consider `protected: ~T()` when polymorphic deletion isn't wanted.
- **Replacing only one of `operator delete(void*)` and the sized form.**
- **`unique_ptr<Incomplete>` with an implicit destructor in the header** — the PIMPL trap; declare and define `~Widget()` out of line.

---

## Compact Recall Summary

**Storage vs lifetime.** Storage duration says how long the *bytes* live; lifetime says how long the *object* does. Lifetime begins after storage is obtained and initialization completes, ends when the destructor starts or storage is reused. Outside it you may only handle the pointer or read bytes through `unsigned char`/`std::byte`.

**Placement new.** Constructs in storage you own; you must destroy manually; array placement new is unusable due to unspecified overhead. Prefer `std::construct_at`/`destroy_at`/`uninitialized_*` (C++20) — `construct_at` is the constexpr-capable form that makes `constexpr std::vector` possible. `std::aligned_storage` is deprecated in C++23; use `alignas(T) std::byte[]`.

**Explicit lifetime APIs.** `launder` refreshes a pointer after in-place replacement (const/reference members, vptr, devirtualization); `start_lifetime_as` (C++23) declares that foreign bytes are an object; `bit_cast` makes a new object from bytes; implicit object creation (C++20, retroactive) covers `malloc`/`new`/`memcpy`. All are zero-cost except `construct_at`.

**Initialization.** Default = indeterminate for scalars in automatic/dynamic storage. Value = zero, unless a *user-provided* constructor intervenes — and `= default` on the first declaration is not user-provided. Braces forbid narrowing and defeat the most vexing parse but are hijacked by `initializer_list` constructors. Aggregates gained NSDMIs in C++14, base classes in C++17, and designated initializers plus parenthesized init in C++20.

**Temporaries.** A prvalue is a recipe, not an object, until materialized — the basis of guaranteed elision. Binding a temporary to a local reference extends its life; binding to a *reference member*, returning it, or passing it through a function does not. C++23 P2718 fixed range-for over temporaries.

**RAII.** Destructors run on every exit path including unwinding, giving exception safety for free. Destructors must not throw; a throwing constructor destroys completed members but not the object; each resource gets its own RAII member. Cost: non-trivial destructors force memory-passing at ABI boundaries and disable tail calls.

**Order.** Virtual bases → bases (declaration order) → members (**declaration order, not init-list order**) → body; destruction exactly reversed. During construction/destruction the dynamic type is the current class, so virtual calls don't reach derived overrides. Across TUs, dynamic initialization order is **unspecified** — fix with `constinit`, function-local statics (guard-variable cost), or an explicit init phase. Destruction order at exit is the mirror hazard; deliberate leaks and `_exit` are legitimate answers.

**Empty members.** EBO makes empty *bases* free — why `unique_ptr` with a stateless deleter is 8 bytes and `vector` is 24. `[[no_unique_address]]` (C++20) extends it to members, is only a permission, doesn't apply twice to the same type, can consume tail padding, and is an ABI decision.

**Unions.** One active member; reading another is UB outside the common initial sequence. Trivial members switch active by assignment; non-trivial ones need explicit destroy + placement new, and any non-trivial member deletes the union's special members. `std::variant` provides safety and lifetimes; `std::visit` costs an indirect call, so a hand-rolled `switch` on a tag still wins on hot paths.

**Deletion.** Deleting through a non-virtual base destructor is UB — the derived destructor is skipped and `operator delete` receives the wrong address and size. Virtual destructors cost a vptr, trivial copyability, register passing, and inlining; use `protected:` non-virtual when polymorphic deletion isn't needed. `shared_ptr` type-erases the deleter and survives this; `unique_ptr` does not. Sized delete (C++14) avoids a size-class lookup on free; aligned new/delete (C++17) fixed over-aligned types; destroying delete (C++20) lets deallocation read the object first.
