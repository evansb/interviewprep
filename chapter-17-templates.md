# Chapter 17 — Templates

*Interview-focused revision notes. The theme: templates are a compile-time program whose inputs are types and values and whose output is generated code — so every question reduces to what the compiler knows, when it knows it, and what it costs to produce the answer.*

---

## 17.1 Function, Class, Variable and Alias Templates

A **template** is a pattern from which the compiler generates entities. There are four kinds, and knowing what each can and cannot do is table stakes.

```cpp
template <class T> T max(T a, T b);                       // function template
template <class T, size_t N> struct Array { T d[N]; };    // class template
template <class T> constexpr T pi = T(3.1415926535897932385L);  // variable template (C++14)
template <class T> using Vec = std::vector<T, MyAlloc<T>>;       // alias template (C++11)
```

### Function templates

Deduce their arguments from the call (§17.2), participate in overload resolution alongside non-templates, and can be **overloaded** but only **fully specialized** — never partially. The specialization prohibition is the single most important asymmetry in this section:

```cpp
template <class T> void f(T);            // (1) primary
template <class T> void f(T*);           // (2) an OVERLOAD, not a specialization
template <>        void f<int>(int);     // (3) full specialization OF (1)
```
`f(pint)` picks (2) by overload resolution, and (3) never enters the picture. This is Sutter's "why not specialize function templates" argument: specializations do not participate in overload resolution — the compiler first picks the most specialized *primary* template via partial ordering, *then* looks for a specialization of that one. Overloading is almost always what you want; if you truly need per-type behavior, dispatch to a class template's static member (which can be partially specialized) or use constraints (§17.13).

Between a function template and an equally good non-template overload, **the non-template wins**. Between two templates, **partial ordering** picks the more specialized.

### Class templates

Support full and partial specialization (§17.6), member templates, static members (one per instantiation), and — since C++17 — CTAD (§17.4). Each distinct instantiation is a distinct type: `Array<int,4>` and `Array<int,5>` share nothing, including static members.

### Variable templates

Introduced in C++14 primarily to remove `::value` boilerplate: `std::is_integral_v<T>` is a variable template defined as `is_integral<T>::value`. At namespace scope they have external linkage and are implicitly `inline` when `constexpr`, so header definitions do not violate the ODR (Ch. 1 §1.6).

### Alias templates

The subtle one. An alias template is **not a class**, so:

- It has **no specializations at all** — neither full nor partial. You cannot `template <> using X<int> = …`.
- It is **never deduced**. A function parameter of type `Vec<T>` cannot deduce `T` from a `std::vector<int, MyAlloc<int>>` argument in the general case, because alias substitution is not invertible. (C++20 CTAD *for* alias templates was added — §17.4 — but that's construction, not deduction in a parameter.)
- It is **transparent**: `Vec<int>` and `std::vector<int, MyAlloc<int>>` are the same type, so it does not create a distinct type for overloading. Use a real class (or a strong-typedef wrapper) if you need distinctness.
- It is **not a non-deduced context by itself** but reliably produces one; the idiom `template <class T> using type_identity_t = typename type_identity<T>::type` is how you deliberately *block* deduction on a parameter:

```cpp
template <class T> void g(T, std::type_identity_t<T>);  // deduce only from the first argument
g(1.0, 2);   // T = double; the int converts. Without identity_t this would be ambiguous.
```

Alias templates are also the standard cure for the "template template parameter with a default argument" mismatch, and for shortening dependent names (`typename std::iterator_traits<It>::value_type` → `std::iter_value_t<It>` in C++20).

**Member templates** deserve a note: a member function template of a class template can be declared in-class and defined out-of-line with two `template<>` headers, and a **template constructor never suppresses the implicitly declared copy constructor** — the source of the classic "my perfect-forwarding constructor hijacks copies of non-const objects" bug (§17.17).

---

## 17.2 Template Argument Deduction

Deduction matches the **parameter type P** against the **argument type A** and solves for the template parameters. It is a pattern-match, not a conversion: deduction succeeds only if a consistent substitution exists, and only a very small set of adjustments is permitted.

### The adjustments applied before matching

For a *by-value* parameter `P`:
1. Top-level cv-qualifiers on `A` are **dropped** (`const int` → `int`).
2. **Array-to-pointer and function-to-pointer decay** applies (`int[5]` → `int*`).

For a *reference* parameter `P& `or `P&&`, neither happens — which is why references preserve arrays and constness:

```cpp
template <class T> void byval(T);      int a[5];  byval(a);   // T = int*
template <class T> void byref(T&);                byref(a);   // T = int(&)[5]  — size preserved
template <class T, size_t N> void arr(T(&)[N]);   arr(a);     // N = 5   ← the idiom
const int c = 0;
byval(c);   // T = int   (const dropped)
byref(c);   // T = const int
```
`template <class T, size_t N> constexpr size_t len(T(&)[N]) { return N; }` is the safe replacement for the `sizeof(a)/sizeof(a[0])` macro, because it *fails to compile* on a pointer instead of silently giving 8/4.

### Permitted conversions during deduction

Only three: lvalue-to-rvalue/array/function decay (above), qualification conversion (adding `const` to a pointee), and derived-to-base for a class template parameter of the form `Base<T>` deduced from a derived class. Nothing else. **No integral promotion, no user-defined conversion, no arithmetic conversion.** This is why:

```cpp
template <class T> T max(T,T);
max(1, 2.0);   // ERROR — deduces T=int from arg1 and T=double from arg2, inconsistent
max<double>(1, 2.0);  // OK — T explicit, ordinary conversions now apply
```

### Non-deduced contexts

Positions where the parameter cannot be solved for; deduction skips them and they must come from elsewhere (explicit arguments, defaults, or other parameters):

| Context | Example |
|---|---|
| Nested name qualified by a template parameter | `typename A<T>::type` |
| Non-type argument involving a template parameter in an expression | `std::array<int, N+1>` |
| The parameter of a function-type parameter when other args disambiguate | `void(*)(T)` combined with defaults |
| A parameter with a default argument | `template<class T> void f(T = 0)` — the default doesn't deduce |
| The type of `std::initializer_list` in a plain `T` parameter | `f({1,2,3})` with `template<class T> void f(T)` fails |

The braced-init-list case is worth memorizing: `template <class T> void f(T)` rejects `f({1,2,3})` (braced lists are non-deduced), but `template <class T> void f(std::initializer_list<T>)` accepts it. This asymmetry is why `auto x = {1,2,3}` deduces `initializer_list<int>` while `template<class T> void f(T)` does not — the one deliberate divergence between `auto` deduction and template deduction (Ch. 2 §2.16).

### Deduction from multiple parameters

All deductions for the same parameter must agree exactly (after the adjustments). To make one argument non-deducing, wrap it in an identity alias (§17.1) or supply it explicitly.

**Return type deduction** (`auto f()`) uses template deduction rules, so it strips references and cv; `decltype(auto)` uses `decltype` rules and preserves them (Ch. 2 §2.17). Getting a proxy-returning forwarding wrapper right requires `decltype(auto)`.

---

## 17.3 Forwarding References and Reference Collapsing

A **forwarding reference** (the standard's term; "universal reference" is Meyers') is a parameter of the exact form `T&&` where `T` is a template parameter **being deduced by this call**, or `auto&&`. Nothing else qualifies:

```cpp
template <class T> void f(T&& x);              // forwarding reference
template <class T> void g(const T&& x);        // NOT — const disqualifies it
template <class T> void h(std::vector<T>&& v); // NOT — not the bare form T&&
template <class T> struct S {
    void m(T&& x);                             // NOT — T is already fixed by the class
};
auto&& r = expr;                               // forwarding reference
```

### The mechanism

Deduction has a special rule for `T&&`: if the argument is an **lvalue** of type `A`, then `T` is deduced as `A&`. If the argument is an rvalue, `T` is deduced as `A`. Then **reference collapsing** applies:

| Written | Collapses to |
|---|---|
| `T& &` | `T&` |
| `T& &&` | `T&` |
| `T&& &` | `T&` |
| `T&& &&` | `T&&` |

Mnemonic: **lvalue reference is infectious** — any `&` in the pair wins. Reference collapsing only occurs in contexts where a reference-to-reference can arise: template substitution, `auto`, `typedef`/alias substitution, and `decltype`. You still cannot write `int& &` directly.

```cpp
int i = 0;
f(i);    // A = int lvalue → T = int&  → param type int& && → int&
f(42);   // rvalue        → T = int   → param type int&&
```
So the parameter's declared type after substitution is `int&` in the first case and `int&&` in the second — and both cases have a *named* parameter `x`, which is an **lvalue** regardless. That is precisely why you need `std::forward` (§17.17): the parameter's value category is lost the moment it is named.

### Why forwarding references are greedy

`T&&` binds to everything — lvalues, rvalues, const, volatile — with an **exact match**. So it beats almost any other overload:

```cpp
struct Widget {
    template <class T> Widget(T&& name);   // greedy
    Widget(const Widget&);                 // copy ctor
};
Widget w1{"x"};
Widget w2{w1};       // calls the TEMPLATE — w1 is non-const lvalue, so T=Widget& is an
                     // exact match, while the copy ctor requires adding const
```
This is the canonical trap. Fixes: constrain the template with a concept or `enable_if` that excludes `Widget` and its bases (`std::same_as<std::remove_cvref_t<T>, Widget>` exclusion), or use tag dispatch, or in C++20 simply `requires (!std::derived_from<std::remove_cvref_t<T>, Widget>)`. Note that also declaring a `Widget(Widget&)` overload is a workaround that appears in older code.

`std::remove_cvref_t<T>` (C++20; `std::decay_t` pre-C++20) is the standard way to recover the underlying type inside a forwarding-reference template. `std::decay_t` additionally decays arrays and functions, which is usually *not* what you want when you only meant to strip references and cv.

---

## 17.4 Class Template Argument Deduction (CTAD)

Before C++17 a class template's arguments always had to be written, hence `make_pair`, `make_tuple`, `make_unique` — factory functions existing solely to get function-template deduction. **CTAD** (C++17) lets the class template's arguments be deduced from the constructor arguments.

```cpp
std::pair p{1, 2.0};              // std::pair<int, double>
std::vector v{1, 2, 3};           // std::vector<int>
std::lock_guard g{mtx};           // std::lock_guard<std::mutex>
std::array a{1, 2, 3};            // std::array<int, 3>
```

### The mechanism: implicit and explicit deduction guides

The compiler forms a set of fictional function templates:
- one per constructor of the primary template, with the class's template parameters as its own;
- a copy-deduction candidate;
- plus any **user-written deduction guides**.

Overload resolution over that set picks the class's arguments.

```cpp
template <class It> Vector(It, It) -> Vector<typename std::iterator_traits<It>::value_type>;
template <class T, class... U> Array(T, U...) -> Array<T, 1 + sizeof...(U)>;
```
Guides are needed whenever the constructor parameters don't directly expose the class parameters — iterator pairs being the archetype.

### Pitfalls

- **`std::vector v{v2}` copies rather than wraps.** The copy-deduction candidate wins, so you get `vector<int>`, not `vector<vector<int>>`. Similarly `std::pair p{p2}` is a copy.
- **Braces vs parens matter:** `std::vector v(3, 0)` → 3 zeros; `std::vector v{3, 0}` → the two elements 3 and 0 (initializer-list constructor).
- **CTAD does not apply to partial argument lists.** `std::pair<int> p{1, 2.0}` is ill-formed; it's all or nothing.
- **CTAD does not consider base classes' or inherited constructors.**
- **Aggregates**: C++20 added *aggregate deduction candidates*, so `template <class T> struct P { T a; T b; }; P p{1, 2};` works in C++20 but not C++17.
- **Alias template CTAD** (C++20): `template <class T> using IVec = std::vector<T, MyAlloc<T>>; IVec v{1,2,3};` deduces. It works by transforming the underlying template's guides through the alias.
- **Explicit guides can be `explicit`**, which suppresses CTAD in copy-initialization contexts.

**Should you use it?** For local variables of well-designed templates, yes — it removes noise. Avoid it in APIs where a reader can't see the deduced type, and be aware `auto x = f()` and CTAD interact badly with proxy types. `make_unique`/`make_shared` remain necessary because they also perform the *allocation* correctly (Ch. 9 §9.4) — CTAD does not replace them.

---

## 17.5 Non-Type Template Parameters (NTTPs)

An NTTP is a compile-time **value** parameter. Its permitted types have widened steadily:

| Since | Allowed NTTP types |
|---|---|
| C++98 | Integral and enum types, pointer/reference to object or function with linkage, `std::nullptr_t` (C++11), pointer-to-member |
| C++17 | `auto` NTTPs (`template <auto N>`); template argument may be any constant expression of a permitted type, including addresses of objects with internal linkage |
| C++20 | **Structural types**: literal class types with all-public, non-mutable, structural-typed members and no user-provided copy/move/destructor. Floating point becomes allowed. |
| C++26 | Constexpr-ness relaxations around structural types; `constexpr` structured bindings interplay |

```cpp
template <auto V> struct Constant { static constexpr auto value = V; };  // C++17
Constant<42>  ci;    Constant<'x'>  cc;    Constant<&glob> cp;

struct FixedString {                                    // C++20 structural type
    char data[16]{}; size_t n{};
    constexpr FixedString(const char (&s)[17]) { … }
};
template <FixedString Name> void log();                 // string literals as template args!
log<"order_ack">();
```
The `FixedString` NTTP is the enabling trick behind compile-time named channels, `boost::hana`-style string types, and format-site registries in async loggers (Ch. 16 §16.5).

### Semantics and gotchas

- **Two instantiations with template-argument-equivalent arguments are the same type.** For structural types, equivalence is member-wise, *not* `operator==` — a class with a custom `operator==` doesn't get to define identity here. Floating-point NTTPs compare by value with `-0.0 != 0.0` treated as distinct, and NaN is equal to itself for this purpose.
- **NTTPs of reference/pointer type require the referent to have static storage duration and (pre-C++17) linkage.** A `constexpr` local's address is not usable.
- **`template <auto>` cannot deduce the value from a runtime argument** — it must be a constant expression. `std::integral_constant<T, V>` and the `_v` variable templates remain the way to pass values *as types* into deduction.
- **Array-size NTTPs are the mechanism behind `std::array`, `std::bitset`, and fixed-capacity containers** (Ch. 11 §11.6). The key latency property: `N` is a compile-time constant, so bounds are foldable, loops are fully unrollable, and no capacity field is stored.

### Template template parameters

Adjacent but distinct: a parameter that is itself a template.

```cpp
template <template <class...> class Container, class T>
Container<T> make_container(std::initializer_list<T> il) { return Container<T>(il); }
```
Pre-C++17, a `template <class, class> class` parameter would *not* match `std::vector` (which has a default second argument) on some compilers — P0522 (C++17) fixed the matching rules so a more-specialized template matches a `class...` parameter. It's still the least ergonomic template feature; most code prefers deducing the whole container type and using `Container::rebind`/`value_type`.

---

## 17.6 Full and Partial Specialization

**Specialization** provides an alternative definition for specific arguments. The primary template must be declared first; a specialization is *not* an overload and does not itself take part in overload resolution.

```cpp
template <class T, class U> struct Pair { … };            // primary
template <>            struct Pair<int, int> { … };       // FULL (explicit) specialization
template <class T>     struct Pair<T, T> { … };           // PARTIAL specialization
template <class T>     struct Pair<T*, T*> { … };         // PARTIAL
```

| | Class templates | Function templates | Variable templates | Alias templates |
|---|---|---|---|---|
| Full specialization | Yes | Yes | Yes (C++14) | **No** |
| Partial specialization | Yes | **No** — overload instead | Yes (C++14) | **No** |

### Rules that catch people

- **A full specialization is a definition, not a template**, so it obeys the ODR like an ordinary class/function: put it in a header and it must be `inline` (functions) or it will multiply-define.
- **Full specialization must appear before the first use that would instantiate the primary**, in every TU that uses it. Violating this is IFNDR (ill-formed, no diagnostic required) — a genuinely nasty ODR bug where different TUs get different `std::hash<Key>`.
- **You may not specialize inside a different namespace**; before C++17 you had to close your namespace and reopen `namespace std`. Since C++17, `template <> struct std::hash<K> { … };` is writable with a qualified name.
- **Specializing standard library templates is only permitted for user-defined types**, and only for the ones the standard designates (`std::hash`, `std::formatter`, `std::numeric_limits`, `std::tuple_size`/`tuple_element`, `std::common_type`, `std::pointer_traits`, …). Adding declarations to `namespace std` otherwise is UB.
- **Partial specialization uses partial ordering** to pick the most specialized match; ambiguity is an error, not a silent pick.
- **Default arguments live on the primary only**; a partial specialization does not restate them.
- **Member specialization**: you can specialize a single member of a class template without specializing the whole class (`template <> void Ring<int>::push(int)`), but only outside the class and only for a full specialization of the enclosing arguments.

### When to reach for what

Partial specialization is the right tool for structural dispatch on *type shape* (`T*`, `T[N]`, `Container<T>`), which is exactly what `iterator_traits`, `remove_pointer`, `tuple_element` do. Constraints (§17.13) and `if constexpr` (§17.19) are the right tools for dispatch on *type properties*. Reaching for specialization when you meant a constraint produces open-coded, non-extensible dispatch tables that must be updated for each new type.

---

## 17.7 Template Instantiation

Templates are **not compiled when defined** — only when *instantiated*. Two kinds:

- **Implicit instantiation** — triggered by use. A class template is instantiated when it becomes **required to be complete** (you name a member, take `sizeof`, derive from it). Merely declaring `Foo<T>* p;` does **not** instantiate it, which is what makes forward declarations of templates useful and pimpl-with-templates feasible.
- **Explicit instantiation** — you ask for it by name (§17.10).

### Lazy member instantiation

**Member functions of a class template are instantiated only when used.** This is a load-bearing property:

```cpp
template <class T> struct Holder {
    T v;
    void print() { std::cout << v; }   // only ill-formed if print() is CALLED for a T
                                       // that has no operator<<
};
Holder<NoStream> h;    // fine
h.print();             // NOW it fails
```
It is why `std::vector<T>` works for `T` without a default constructor (only `resize(n)` needs it), and why a partially-satisfying type can still be stored. Virtual member functions are the exception: they are instantiated when the class is instantiated, because the vtable must be emitted.

### Point of instantiation and the ODR

Each use has a **point of instantiation** (POI): for function templates, immediately after the enclosing declaration; for class templates, immediately before. Names in the template's definition are looked up at either the **point of definition** (non-dependent names) or a combination of POD and POI via ADL (dependent names) — see §17.8. If the same specialization gets *different* meanings in different TUs, the program is **IFNDR**. This is why adding an overload after including a header can change behavior in one TU and not another.

Implicit instantiations are emitted as **weak/COMDAT symbols** in every TU that needs them, and the linker folds duplicates (Ch. 1 §1.12, Ch. 41 §41.11). That's how "define templates in headers" coexists with the ODR — but it means the compiler does redundant work per TU, which §17.22 addresses.

### Instantiation depth and recursion

Recursive templates instantiate a chain of types; each level is a full type with its own symbol and mangled name. `-ftemplate-depth=` (default 900 in GCC/Clang, 1024 in MSVC) bounds it. Deep recursion is *the* compile-time killer: a naively recursive `sum<Ts...>` is O(N) instantiations, while a fold expression (§17.16) is O(1). Rewriting recursion into pack expansion or `if constexpr` is the standard compile-time optimization.

---

## 17.8 Two-Phase Name Lookup

Template definitions are checked in two phases:

**Phase 1 — at the point of definition.** Syntax is checked, and every **non-dependent** name is looked up and bound *right there*, using ordinary unqualified lookup plus ADL at that point. Non-dependent constructs are type-checked immediately.

**Phase 2 — at the point of instantiation.** Dependent names are looked up. For dependent *function* calls, the lookup is the union of (a) ordinary lookup at the point of definition and (b) **ADL only** at the point of instantiation. Ordinary (non-ADL) lookup is *not* redone at instantiation.

```cpp
void g(double);
template <class T> void f(T t) { g(t); g(1); }
void g(int);              // declared AFTER the template
f(1);                     // g(t) is dependent → ADL at POI, but ADL on int finds nothing
                          // in the global namespace via ADL... so g(double) is called.
                          // g(1) is non-dependent → bound at definition → g(double).
```
The takeaway: **a later-declared ordinary function will not be found by a template unless ADL reaches it.** Practical consequence — customization points must be findable by ADL (which is why `swap`, `begin`, `end` use the "`using std::swap; swap(a,b)`" two-step, and why C++20 replaced that pattern with **customization point objects** `std::ranges::swap`/`begin`, which do the two-step internally and cannot be hijacked).

MSVC historically did *not* implement two-phase lookup, accepting code that GCC and Clang reject; `/permissive-` enables conformance and is the flag to name when asked why "it compiles on Windows only."

**Practical rule:** a template that uses a name not dependent on its parameters is checked immediately, so errors in a never-instantiated template body **are still errors** if they are non-dependent. `static_assert(false)` in an uninstantiated `else` branch is the classic victim — it must be made dependent (`static_assert(sizeof(T) == 0 && false)` historically, or `static_assert(false)` legitimized only for uninstantiated `if constexpr` branches by CWG2518 in C++23).

---

## 17.9 Dependent Names and Disambiguators

A **dependent name** is one whose meaning depends on a template parameter. The compiler parsing the template *before* knowing `T` must decide whether `T::X` is a type, a value, or a template — and it defaults to **not a type** and **not a template**. Hence the two disambiguators:

```cpp
template <class T> void f() {
    typename T::value_type v;              // 'typename': T::value_type is a TYPE
    T::template rebind<int> r;             // 'template': rebind is a TEMPLATE
    typename T::template rebind<int>::other o;   // both
}
```
Without `typename`, `T::value_type * p;` parses as a multiplication expression. Without `template`, `p->get<int>()` parses `<` as less-than.

### `typename` relaxations (C++20, P0634)

C++20 makes `typename` optional in contexts where **only a type can appear**: return types and parameter types of function declarations at namespace/class scope, trailing return types, the type in a `static_cast`-family cast, base-clause entries, member declarations, `using` alias definitions, and the type-id of `new`. It is still required inside function *bodies* for local declarations. Knowing which side of the line you're on is a useful modern-C++ detail.

### Names from dependent base classes

The subtlest case. Unqualified lookup **does not look into dependent base classes**:

```cpp
template <class T> struct Base { int value; void helper(); };
template <class T> struct Derived : Base<T> {
    void f() {
        value = 1;          // ERROR — 'value' not found; Base<T> is dependent
        this->value = 1;    // OK — makes it dependent, looked up at instantiation
        Base<T>::helper();  // OK — but disables virtual dispatch
        using Base<T>::value;   // OK — a using-declaration in the class body
    }
};
```
The reason: `Base<T>` might be specialized for some `T` such that `value` doesn't exist or means something else, so the compiler cannot bind it in phase 1. **`this->` is the idiomatic fix** and appears constantly in CRTP code (Ch. 6 §6.19). Missing it is a top-three cause of "compiles on MSVC, fails on GCC/Clang."

Recognizing the error text ("there are no arguments to `X` that depend on a template parameter, so a declaration of `X` must be available") and immediately answering "add `this->`" is a strong signal.

---

## 17.10 Explicit Instantiation and `extern template`

**Explicit instantiation definition** forces the compiler to generate code for a specialization in this TU:

```cpp
// in a .cpp
template class RingBuffer<Order>;                     // all members of the class
template void process<Order>(std::span<Order>);       // one function
```
**Explicit instantiation declaration** (`extern template`, C++11) tells every other TU *not* to implicitly instantiate — it will be found at link time:

```cpp
// in the header
extern template class RingBuffer<Order>;
```

### Why this exists

Implicit instantiation happens in every TU that uses the specialization; each produces identical COMDAT code, the compiler does the work N times, and the linker discards N−1 copies. For heavy templates (`std::basic_string<char>`, `std::vector<MyBigType>`, a parser template) this is a large share of build time and object-file size. The `extern template` in the header + explicit instantiation in one `.cpp` pattern is the standard fix — libstdc++ does exactly this for `basic_string<char>` and `basic_ostream<char>`.

### Trade-offs

| Aspect | Effect of `extern template` |
|---|---|
| Compile time | Improves — one instantiation instead of N |
| Object size / link time | Improves substantially |
| Runtime performance | **Can degrade**: the out-of-line definition is no longer visible for inlining unless LTO is on (Ch. 40 §40.3) |
| Coupling | The instantiating TU must be linked in; a missing explicit instantiation is a *link* error, and a link error for a template is far less informative than a compile error |
| Compatibility | Explicit instantiation ignores constraints/`if constexpr` branches you never wanted instantiated — the whole class body must be valid for that `T` |

The last point is a real gotcha: explicit instantiation of a class template instantiates **all** its member functions, including ones that would be ill-formed for that `T` and would never have been called. If that happens, explicitly instantiate individual members instead.

Explicit instantiation is also how you keep template implementations *out* of headers: define the template in a `.cpp` and explicitly instantiate the finite set of types you support. This is fine for closed type sets (a serializer for a known message set), and hostile for open ones.

---

## 17.11 SFINAE

**Substitution Failure Is Not An Error**: when the compiler substitutes deduced/explicit template arguments into a function template's *declaration* (signature, return type, template parameter defaults, and — since C++11 — default template arguments), and the result is ill-formed, that candidate is silently removed from the overload set instead of producing an error.

**Only the immediate context counts.** An error deeper inside — in an instantiated class body or function body — is a hard error, not a substitution failure:

```cpp
template <class T> typename T::type f(T);              // SFINAE-friendly: immediate context
template <class T> void g(T) { typename T::type x; }   // NOT — hard error on instantiation
```
This is why `std::iterator_traits` was made SFINAE-friendly in C++17 (a partial specialization that is empty when the required members are absent) and why "SFINAE-friendly" is a real API property.

### The `enable_if` idiom

```cpp
// 1. return type (cannot be used for constructors)
template <class T> std::enable_if_t<std::is_integral_v<T>, T> f(T);
// 2. extra defaulted template parameter (works for constructors; the modern default)
template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0> void g(T);
// 3. extra defaulted function parameter (leaks into the signature; avoid)
template <class T> void h(T, std::enable_if_t<std::is_integral_v<T>, int> = 0);
```
Form 2 is preferred because it works everywhere and doesn't perturb the visible signature. Note that two overloads distinguished only by `enable_if` in the *default template argument* have the same signature and are a redefinition — you must use different conditions, and `= 0` vs `= nullptr` does not distinguish them.

### `if constexpr` and concepts do not replace it entirely

`if constexpr` (§17.19) handles *branching inside one function* but cannot remove an overload from the set — so it cannot resolve ambiguity, cannot make a type non-constructible, and does not affect `std::is_invocable`. Concepts (§17.13) replace SFINAE for constraining, with better errors and subsumption, and are strictly preferable in C++20. SFINAE remains relevant for: pre-C++20 codebases, detecting expression validity in a trait, and library internals.

### Expression SFINAE

```cpp
template <class T>
auto size(const T& c) -> decltype(c.size()) { return c.size(); }   // valid only if c.size() compiles
```
`decltype` in a trailing return type puts an arbitrary *expression* in the immediate context. This is the foundation of the detection idiom (§17.12). `std::void_t`, `std::declval<T>()` (an unevaluated-context-only way to produce a `T&&` without constructing one) and trailing return types are the three tools.

---

## 17.12 The Detection Idiom and `void_t`

`std::void_t<Ts...>` (C++17) is `template <class...> using void_t = void;` — an alias that discards its arguments. Its power comes from the fact that *substituting into its arguments can fail*, and that failure is in the immediate context of a partial specialization.

```cpp
template <class T, class = void>
struct has_reserve : std::false_type {};

template <class T>
struct has_reserve<T, std::void_t<decltype(std::declval<T&>().reserve(size_t{}))>>
    : std::true_type {};
```
If `T::reserve(size_t)` doesn't exist, the specialization's argument list is ill-formed, the partial specialization drops out, and the primary (`false_type`) is selected. Note the empty-`void_t` detail: **CWG1558** made it defined that unused alias template arguments are still substituted — pre-fix compilers required a helper struct.

The generalized form (`std::experimental::is_detected`, never standardized but ubiquitous):

```cpp
template <template <class...> class Op, class... Args>
constexpr bool is_detected_v = /* … */;
template <class T> using reserve_t = decltype(std::declval<T&>().reserve(0));
static_assert(is_detected_v<reserve_t, std::vector<int>>);
```

### What replaced it

C++20 concepts express the same thing far more directly, with better diagnostics and with subsumption (§17.14):

```cpp
template <class T> concept HasReserve = requires (T& t, size_t n) { t.reserve(n); };
```
A `requires`-expression's requirements come in four flavors — **simple** (`t.reserve(n);` — expression must be valid), **type** (`typename T::value_type;`), **compound** (`{ t.size() } noexcept -> std::convertible_to<size_t>;`), and **nested** (`requires HasReserve<T>;`). The compound form is the one that subsumes `decltype`-based detection *and* adds return-type and `noexcept` checking, which `void_t` could only do awkwardly.

**The trap that survives into concepts:** a `requires`-expression only checks that the expression *compiles*, not that it does anything sane, and a requires-expression used as a plain boolean (`if (requires { … })`) versus a constraint (`requires requires { … }`) is a common syntax confusion — the double `requires` is correct and intentional.

Detection is inherently duck-typed, and both idioms share the deeper weakness: they check syntax, not semantics. Concepts partly address this with named semantic concepts (`std::regular`, `std::sized_sentinel_for`) whose extra requirements are documented but unenforced.

---

## 17.13 Concepts and Constraints

A **concept** (C++20) is a named compile-time boolean predicate over template parameters, usable to constrain templates. Concepts are the interface layer templates always lacked.

```cpp
template <class T>
concept Arithmetic = std::is_arithmetic_v<T>;

template <class T>
concept Hashable = requires (const T& t) {
    { std::hash<T>{}(t) } -> std::convertible_to<size_t>;
};
```

Four equivalent constraint syntaxes, in increasing verbosity:

```cpp
void f(Arithmetic auto x);                                  // abbreviated (terse)
template <Arithmetic T> void f(T x);                        // constrained parameter
template <class T> requires Arithmetic<T> void f(T x);      // requires-clause
template <class T> void f(T x) requires Arithmetic<T>;      // trailing requires-clause
```
The trailing form is the one that can reference the *function parameters* and is required when the constraint depends on more than the template parameters. `auto` parameters (abbreviated form) create an **invented** template parameter, so two `auto` parameters are independent types — `void f(auto a, auto b)` is a two-parameter template.

### What concepts buy over `enable_if`

| | `enable_if` SFINAE | Concepts |
|---|---|---|
| Diagnostics | Wall of substitution failures | "constraint not satisfied: `T` does not satisfy `Hashable` because `std::hash<T>{}(t)` is invalid" |
| Overload ranking | All-or-nothing; you must write mutually exclusive conditions | **Subsumption** orders overloads automatically (§17.14) |
| Readability | Condition hidden in the signature | Named, reusable, documentable |
| Compile time | Instantiates `enable_if` per check | Concepts are cached per (concept, args) — normally faster |
| Placement | Awkward for constructors, impossible on some declarations | Uniform, including on non-template member functions of class templates |

### Non-obvious rules

- **Constraints are checked before the function body is instantiated**, and a constraint failure removes the candidate — same as SFINAE, but with normalization and subsumption on top.
- **Atomic constraint identity is by source expression + parameter mapping.** Two textually identical `requires` clauses written in two different places are *different* atomic constraints and do not subsume each other. This is why you should name concepts rather than inline `requires` clauses if you want ordering.
- **Concepts cannot be recursive** and cannot be explicitly specialized.
- **A constrained non-template member function** of a class template is legal and is the clean way to conditionally provide a member: `void push_back(const T&) requires std::copy_constructible<T>;`. Under the old regime you needed a dummy template parameter. `std::optional` and `std::vector` use this for conditionally-trivial special members.
- **`requires` on a class template's member disables it without disabling the class**, replacing an entire family of `enable_if` base-class tricks.
- **Standard library concepts** live in `<concepts>` (`same_as`, `derived_from`, `convertible_to`, `integral`, `totally_ordered`, `invocable`, `regular`) and `<iterator>`/`<ranges>` (`input_iterator`, `sized_range`, …). Reaching for them instead of hand-rolling is expected in modern code (Ch. 14 §14.9).
- **C++26** adds `static_assert` with a user-generated message and improved constraint diagnostics; concepts themselves are stable.

Zero runtime cost — constraints exist entirely at compile time. The relevant cost is *compile* time, and concepts are generally cheaper than the `enable_if` they replace because satisfaction results are memoized.

---

## 17.14 Constraint Subsumption

**Subsumption** is the partial ordering of constrained declarations: if constraint A implies constraint B, A is *more constrained*, and when both candidates are otherwise equally good, the more-constrained one wins. This is what lets you write overload sets that refine each other without mutually exclusive conditions.

```cpp
template <std::input_iterator It>  void advance_(It, int);        // (1)
template <std::random_access_iterator It> void advance_(It, int); // (2)
// random_access_iterator subsumes input_iterator → (2) wins for a vector iterator
```
Under `enable_if` you would need `enable_if_t<is_random_access>` on one and `enable_if_t<is_input && !is_random_access>` on the other — quadratic bookkeeping that concepts eliminate. This is why `std::advance` and every ranges algorithm can select an optimal implementation cleanly.

### How the compiler decides

Constraints are **normalized** into a *conjunctive/disjunctive normal form* of **atomic constraints**. Concept names are expanded; `&&` and `||` in a constraint-expression become conjunctions and disjunctions in the normal form. A subsumes B if every disjunctive clause of A implies some clause of B, where implication is decided purely by **identity of atomic constraints** — no logical reasoning about the atoms themselves.

Consequences that trip people up:

- **`&&`/`||` inside a `requires`-expression or inside a `bool` expression do NOT decompose.** `requires (std::integral<T> && std::signed_integral<T>)` — where the whole thing is one atomic constraint — subsumes nothing. Only `&&`/`||` at the top level of the *constraint-expression* decompose.
- **Type-trait constraints don't subsume each other.** `requires std::is_integral_v<T>` and `requires std::is_signed_v<T>` are unrelated atoms; the compiler has no idea one implies the other. **Concepts subsume, traits do not** — the practical reason to define named concepts as thin wrappers even over traits, and to build concepts by conjunction of other concepts (`concept SignedIntegral = Integral<T> && IsSigned<T>;`).
- **Atomic constraints from different declarations are only identical if they come from the same source expression** (same token sequence, same declaration). Copy-pasting a `requires` clause creates a distinct atom.
- **Ambiguity is an error, not a silent choice**, which is a feature: unrelated constraints that both match produce a clear diagnostic.
- Subsumption is checked *after* ordinary overload-resolution tiebreakers such as conversion ranking and template partial ordering; it is a late tiebreaker, not an override.

**Interview framing:** "Why did my two `requires is_integral_v<T>` / `requires is_integral_v<T> && is_signed_v<T>` overloads become ambiguous?" — because the first isn't an atom shared by the second unless you factor it into a named concept and conjoin. That answer demonstrates you've actually written constrained overload sets.

---

## 17.15 Parameter Packs and Pack Expansion

A **template parameter pack** holds zero or more template arguments; a **function parameter pack** holds zero or more function parameters. **Pack expansion** is `pattern...`, which repeats the pattern once per pack element, comma-separated.

```cpp
template <class... Ts>                 // Ts is a template parameter pack
void f(Ts... args) {                   // args is a function parameter pack
    g(args...);                        // expands to g(a0, a1, a2)
    g(h(args)...);                     // g(h(a0), h(a1), h(a2))
    g(std::forward<Ts>(args)...);      // the perfect-forwarding expansion
    (void)std::initializer_list<int>{ (h(args), 0)... };  // pre-C++17 "for each" hack
}
sizeof...(Ts)                          // number of elements (NOT sizeof of anything)
```

The expansion point matters: `h(args)...` applies `h` per element; `h(args...)` passes all elements to one `h`. Multiple packs in one pattern expand **in lockstep** and must have equal length: `g(std::pair<Ts, Us>(ts, us)...)`.

### Where packs may appear and where they may not

- Packs must be **last** in a function template's parameter list to be deducible from a call (otherwise the trailing parameters are non-deduced).
- Packs in a *class* template must be last, full stop.
- There are **no pack indexing** or slicing operations in C++11–C++23; you index with recursion, `std::tuple_element`, or `std::get<I>`. **C++26 adds pack indexing** (`Ts...[I]` and `args...[I]`), which removes a large amount of metaprogramming boilerplate.
- **Packs cannot be captured directly in a lambda before C++20**; since C++20, `[...xs = std::forward<Ts>(args)]` init-capture pack expansion is legal (§18.2).
- A pack cannot be expanded into a nested pattern that itself introduces a pack of different length.

### Expansion contexts

Function argument lists, initializer lists, template argument lists, base-specifier lists, member initializer lists, lambda captures (C++20), `sizeof...`, fold expressions, and attribute lists. The base-specifier expansion is the mechanism behind the **overloaded visitor** idiom (§18.7 / Ch. 15 §15.4):

```cpp
template <class... Fs> struct overloaded : Fs... { using Fs::operator()...; };
template <class... Fs> overloaded(Fs...) -> overloaded<Fs...>;   // CTAD guide (C++17)
std::visit(overloaded{[](int i){…}, [](std::string s){…}}, v);
```
Note the *using-declaration pack expansion* `using Fs::operator()...;` — a C++17 addition that makes all the inherited call operators visible in one overload set. In C++20 the deduction guide became unnecessary (aggregate CTAD).

### Compile-time cost

Recursive pack processing costs one instantiation per element and is the dominant compile-time expense in older metaprogramming. Prefer, in order: fold expressions (§17.16) → pack expansion into an initializer list or a `constexpr` array → `if constexpr` recursion → full template recursion. Cutting a linear recursion to a fold routinely halves the compile time of a variadic-heavy header.

---

## 17.16 Fold Expressions

C++17 folds collapse a pack with a binary operator, replacing recursive helper templates:

| Form | Name | Expands to | Empty pack |
|---|---|---|---|
| `(... op pack)` | unary left fold | `((a0 op a1) op a2)` | ill-formed except `&&`, `||`, `,` |
| `(pack op ...)` | unary right fold | `(a0 op (a1 op a2))` | same |
| `(init op ... op pack)` | binary left fold | `((init op a0) op a1)` | `init` |
| `(pack op ... op init)` | binary right fold | `(a0 op (a1 op init))` | `init` |

Mnemonic: **the `...` sits on the side it associates toward** — `...` on the left means left fold.

```cpp
template <class... Ts> auto sum(Ts... v)      { return (v + ... + 0); }        // binary, safe on empty
template <class... Ts> bool all(Ts... v)      { return (... && v); }           // true if empty
template <class... Ts> void print(Ts&&... v)  { ((std::cout << v << ' '), ...); }  // comma fold
template <class... Ts> void push(Vec& d, Ts&&... v) { (d.push_back(std::forward<Ts>(v)), ...); }
```
The empty-pack defaults are: `&&` → `true`, `||` → `false`, `,` → `void()`. Everything else needs the binary form with an explicit identity.

### The subtleties

- **Comma folds guarantee sequencing.** `(f(v), ...)` evaluates left to right with a sequence point between elements. The pre-C++17 `initializer_list` hack also guaranteed order; a plain function call with a pack expansion `g(f(v)...)` **does not** — argument evaluation order is unspecified (Ch. 4 §4.3). This is a real bug source when the operations have side effects (writing into a serialization buffer, incrementing an offset).
- **Left vs right fold matters for non-associative operators** and for floating-point accumulation (Ch. 23 §23.7 — summation order changes the result).
- **Short-circuiting is preserved** in `&&` and `||` folds, so `(check(v) && ...)` stops at the first failure. That's genuinely useful for validation chains.
- **You may fold arbitrary binary operators** including `<<`, `->*`, and `=`; the `<<` case gives the concise stream-printer above but reintroduces iostream cost.
- **Wrap the whole fold in parentheses** — they are part of the grammar, not optional.
- Folding over a *comparison* chain (`(a < ...)`) is legal syntax but yields nonsense semantics because it chains as `((a0 < a1) < a2)`.

Folds are strictly better than recursion for compile time — one instantiation instead of N — and produce identical or better codegen because everything is inlined into the single frame.

---

## 17.17 Perfect Forwarding

**Perfect forwarding** means a wrapper passes its arguments to a target preserving type, value category, and cv-qualification exactly, so the target behaves as if called directly.

```cpp
template <class... Args>
decltype(auto) invoke_logged(Args&&... args) {
    return target(std::forward<Args>(args)...);
}
```
Three ingredients: **forwarding reference parameters** (§17.3), **`std::forward<T>`** in the call, and **`decltype(auto)`** as the return type if the target may return a reference.

`std::forward<T>(x)` is a conditional cast implemented as `static_cast<T&&>(x)` — combined with reference collapsing, `T=U&` yields `U&` (lvalue preserved) and `T=U` yields `U&&` (rvalue restored). It must be called with an **explicit** template argument; `std::forward(x)` is a compile error by design because deducing it would defeat the purpose. `std::move` is unconditional (`static_cast<remove_reference_t<T>&&>`).

**Rule: `std::move` for rvalue references, `std::forward` for forwarding references.** `std::move` on a forwarding reference silently steals from the caller's lvalue.

### What perfect forwarding cannot forward

| Case | Why | Workaround |
|---|---|---|
| Braced-init-lists | `{1,2}` has no type; non-deduced context (§17.2) | Declare an `initializer_list` parameter, or construct at the call site |
| `0`/`NULL` as a null pointer | Deduces to `int`/`long` | `nullptr` |
| Bitfield members | Cannot bind a non-const reference to a bitfield | Copy into a local first |
| Overloaded function names / function templates | No unique type to deduce | Cast to the target signature or wrap in a lambda |
| In-class `static const` without a definition | Pre-C++17 the reference bind ODR-uses it, so it needs an out-of-line definition | C++17 makes them implicitly `inline` — fixed |

These five are Meyers' canonical list and a common interview question.

### The greedy-constructor hazard (recap and cure)

Covered in §17.3 — a `template <class T> Widget(T&&)` constructor out-competes both the copy constructor (for non-const lvalues) and derived-class copies. Constrain it:

```cpp
template <class T>
    requires (!std::derived_from<std::remove_cvref_t<T>, Widget>)
Widget(T&& x);
```

### Forwarding and latency

- Perfect forwarding removes copies but **does not remove the object's cost**; forwarding a `std::string` by value into a container still moves. `emplace_back(args...)` forwards constructor arguments and constructs in place, avoiding one move over `push_back(T(args...))` (Ch. 11 §11.2).
- **`std::forward_like<T>(x)`** (C++23) forwards the *value category and constness of another expression* onto `x` — designed for "deducing this" member functions forwarding a member (Ch. 19 §19.11).
- **Forwarding through `std::invoke`** (C++17) handles the callable-shape cases (member pointers, member data) that a plain `f(args...)` cannot (Ch. 4 §4.11). `std::invoke_r` (C++23) adds an explicit return type.
- A forwarding wrapper is fully inlined at `-O2`, so the abstraction is genuinely zero-cost in the ABI sense — but it *does* instantiate a new function per argument-category combination, contributing to code bloat (§17.22).

---

## 17.18 Tag Dispatch

**Tag dispatch** selects an overload by passing an extra argument whose *type* encodes a compile-time property, letting ordinary overload resolution do the branching.

```cpp
template <class It>
void advance_impl(It& i, ptrdiff_t n, std::random_access_iterator_tag) { i += n; }
template <class It>
void advance_impl(It& i, ptrdiff_t n, std::input_iterator_tag) { while (n--) ++i; }

template <class It>
void advance(It& i, ptrdiff_t n) {
    advance_impl(i, n, typename std::iterator_traits<It>::iterator_category{});
}
```
This is the classic `std::advance`/`std::distance` implementation and the reason iterator category tags form an **inheritance hierarchy** (`random_access_iterator_tag : bidirectional_iterator_tag : …`): derived-to-base conversion gives you a *fallback ordering* for free — a bidirectional iterator matches the bidirectional overload exactly and the input overload by conversion, and exact match wins (Ch. 14 §14.7).

### Standard tag types

`std::true_type`/`false_type` (via `std::integral_constant`), the iterator category tags, `std::in_place_t`/`std::in_place_type_t<T>`/`std::in_place_index_t<I>`, `std::allocator_arg_t`, `std::nothrow_t`, `std::piecewise_construct_t`, `std::defer_lock_t`/`try_to_lock_t`/`adopt_lock_t`. Each exists to disambiguate an otherwise-ambiguous overload — `std::optional<T>(std::in_place, args...)` versus `std::optional<T>(U&&)` is the canonical example, and knowing *why* `in_place_t` exists (to distinguish "construct T from args" from "construct T from one arg that happens to be a T") is a good sign.

### Comparison of the dispatch mechanisms

| Mechanism | Removes overload? | Errors | Extensible by third parties | Compile cost | Since |
|---|---|---|---|---|---|
| Tag dispatch | No — resolves by conversion ranking | Good (a missing overload is a clear "no match") | Yes, by adding overloads | Low | C++98 |
| `enable_if` SFINAE | Yes | Poor | Yes | Medium | C++11 |
| `if constexpr` | No — single function | Excellent | **No** — closed set inside one body | Lowest | C++17 |
| Concepts | Yes, with subsumption | Best | Yes | Low | C++20 |

Tag dispatch remains preferable to `if constexpr` when you need an **open** set (library users adding overloads for their own types) and preferable to SFINAE pre-C++20 for readability. In C++20, concepts subsume most of its uses, but tag dispatch survives wherever the tag carries *data* as well as identity, and in `in_place`-style disambiguation where there is no predicate to constrain on.

A related pattern: **overload-set-as-customization-point** with a tag type (`tag_invoke`, P1895 — not standardized, but influential and used in senders/receivers, Ch. 20 §20.5). It solves the "customization points pollute the namespace and can't be constrained" problem by routing everything through one ADL-found `tag_invoke(tag, args...)`.

---

## 17.19 `if constexpr`

`if constexpr (cond)` (C++17) discards the untaken branch **at instantiation time**: the discarded statement is not instantiated, so it may contain code that would be ill-formed for the current template arguments.

```cpp
template <class T>
std::string to_text(const T& v) {
    if constexpr (std::is_arithmetic_v<T>)      return std::format("{}", v);
    else if constexpr (requires { v.to_string(); }) return v.to_string();
    else                                        return std::string(v);
}
```
This replaces whole families of tag dispatch and `enable_if` overload pairs with straight-line code.

### The precise rules

- **The condition must be a contextually-converted constant expression of type `bool`.**
- **Discarding only happens inside a template.** In a non-template function, both branches are fully checked — `if constexpr` there only prunes codegen, not semantics. This surprises people who try to use it to guard platform-specific code in a plain function.
- **The discarded branch is still parsed and its non-dependent constructs are still checked** (§17.8). `if constexpr (false) { garbage_syntax; }` is an error; `if constexpr (false) { T::nonexistent(); }` inside a template is fine.
- **`static_assert(false)` in a discarded branch was ill-formed** until CWG2518 (adopted as a DR, shipping in C++23 compilers) because it is non-dependent. The old workaround was a dependent false: `static_assert(dependent_false_v<T>)` or `[]<bool F = false>{ static_assert(F); }()`.
- **Returns from different branches may have different types** when the return type is `auto` — this is legal precisely because only one branch is instantiated. It is *not* legal in a non-template.
- **`if constexpr` in a lambda** works, and combined with a generic lambda gives you an inline type switch (§18.7).

### What it does *not* do

- It does not remove a function from an overload set, so it cannot fix ambiguity, cannot make `std::is_invocable_v` false, and cannot conditionally delete a member.
- It does not make an *open* extension point; adding support for a new type means editing the function.
- It is not a substitute for `constexpr` evaluation — the *condition* is compile-time; the branches are ordinary runtime code.

### Related C++23 additions

- **`if consteval`** — takes the "is this evaluation happening at compile time" branch, replacing the fragile `std::is_constant_evaluated()` in an `if constexpr` (which is always `true` there — a notorious trap: `if constexpr (std::is_constant_evaluated())` is *always* taken, because the condition is itself evaluated in a constant context). Use plain `if (std::is_constant_evaluated())` or `if consteval`.
- **`static_assert` with a computed message** (C++26) improves the diagnostics from an `else` fallback.

**Codegen note:** `if constexpr` folds at compile time with no branch emitted, so it is strictly better than a runtime `if` on a `constexpr` flag when the untaken side would be expensive to compile or invalid — but for merely *predictable* runtime conditions, an ordinary `if` costs ~0 after branch prediction (Ch. 27 §27.8), so `if constexpr` is about validity and compile time, not about branch elimination.

---

## 17.20 Compile-Time Type Traits

A **type trait** is a class or variable template that computes a property of, or a transformation on, a type. `<type_traits>` (C++11, expanded through C++26) is the metaprogramming standard library.

### The three families

| Family | Shape | Examples |
|---|---|---|
| Predicates | `trait<T>::value`, `trait_v<T>` (a `bool_constant`) | `is_integral`, `is_trivially_copyable`, `is_base_of`, `is_nothrow_move_constructible`, `is_invocable_r` |
| Transformations | `trait<T>::type`, `trait_t<T>` | `remove_reference`, `remove_cvref` (C++20), `decay`, `conditional`, `common_type`, `underlying_type`, `add_pointer` |
| Compiler-intrinsic-only | Cannot be written in the language | `is_trivially_copyable`, `is_polymorphic`, `is_enum`, `is_union`, `is_aggregate`, `is_final`, `has_unique_object_representations`, `is_layout_compatible` (C++20) |

The third row is worth naming: several traits are **impossible to implement without compiler support** (`__is_enum`, `__is_trivially_destructible`, …). This is a good answer to "how does `std::is_polymorphic` work?" — it doesn't; the compiler tells you.

### Traits that matter for latency and correctness

- `std::is_trivially_copyable_v` — gates `memcpy`, `std::atomic<T>`, register passing (Ch. 3 §3.5).
- `std::is_nothrow_move_constructible_v` — gates `move_if_noexcept`, i.e. whether `vector` reallocation moves or copies (Ch. 10 §10.3).
- `std::has_unique_object_representations_v` — gates byte-wise hashing and CAS (Ch. 3 §3.2).
- `std::is_invocable_r_v<R, F, Args...>` — the correct way to check a callable's shape, superseding hand-rolled detection.
- `std::alignment_of_v`, `std::is_standard_layout_v`, `std::is_layout_compatible_v` (C++20) — wire-format assertions (Ch. 3 §3.12).
- `std::conditional_t<B, T, F>` — compile-time type selection; note both branches must be *valid types*, unlike `if constexpr` branches which need not be valid *code*.

### Implementation patterns worth being able to write on a whiteboard

```cpp
template <class T> struct remove_reference      { using type = T; };
template <class T> struct remove_reference<T&>  { using type = T; };
template <class T> struct remove_reference<T&&> { using type = T; };

template <bool B, class T, class F> struct conditional      { using type = T; };
template <class T, class F>         struct conditional<false, T, F> { using type = F; };

template <class T, class U> inline constexpr bool is_same_v = false;
template <class T>          inline constexpr bool is_same_v<T, T> = true;   // variable-template partial spec
```
Being able to produce `is_same_v` and `remove_reference` from memory demonstrates that you understand partial specialization as pattern matching, which is the whole point of §17.6.

### Costs and modern alternatives

Trait *instantiations* are memoized per specialization, but a deep trait chain still costs. Variable templates (`_v`) are cheaper than class templates (`::value`) because they avoid instantiating a class. Compiler builtins (`__is_same`, `__remove_reference_t`) are dramatically cheaper still, and libstdc++/libc++ increasingly define the standard traits directly in terms of them — which is why "hand-rolled `is_same`" is now *slower to compile* than the standard one.

C++20 `std::type_identity`, C++23 `std::is_scoped_enum`, `std::to_underlying`, and `std::is_implicit_lifetime` (C++23) round out the set; C++26's static reflection (Ch. 19 §19.14) will eventually replace much of this with direct queries.

---

## 17.21 Expression Templates

An **expression template** is a template that, instead of computing a result, builds a *type* representing the expression tree, deferring evaluation until it is assigned or consumed. The purpose is to eliminate temporaries in composite expressions.

The problem it solves:

```cpp
Vector a, b, c, d, r;
r = a + b + c + d;    // naive operator+: three heap-allocated temporaries,
                      // four full passes over memory, all bandwidth-bound
```

The expression-template version:

```cpp
template <class L, class R> struct Sum {
    const L& l; const R& r;
    double operator[](size_t i) const { return l[i] + r[i]; }
    size_t size() const { return l.size(); }
};
template <class L, class R> Sum<L,R> operator+(const L& l, const R& r) { return {l, r}; }

Vector& Vector::operator=(const auto& expr) {          // the fusion point
    for (size_t i = 0; i < expr.size(); ++i) data[i] = expr[i];
    return *this;
}
```
`a + b + c + d` now has type `Sum<Sum<Sum<Vector,Vector>,Vector>,Vector>` — no allocation, and assignment runs **one fused loop with one pass over memory**. For a memory-bandwidth-bound kernel this is the difference between 4× and 1× the DRAM traffic (Ch. 29 §29.5), which is the entire performance story.

Users: **Eigen**, **Blaze**, **Armadillo**, **Boost.uBLAS**, **Boost.Spirit** (parser combinators), **Boost.Phoenix**, and CUDA/Kokkos kernels.

### The hazards

- **Dangling by design.** Nodes hold *references* to their operands. `auto e = a + b;` stores an expression referring to `a` and `b`, and `auto e = a + Vector{…};` refers to a destroyed temporary. Eigen's documentation warns about exactly this, and it is the number-one expression-template bug. `auto` is the enemy here — the intended usage is immediate consumption. Mitigations: store temporaries by value and lvalues by reference (via a `std::conditional_t` on the operand's value category), or forbid rvalue operands.
- **Compile time and diagnostics.** A moderately long expression produces a deeply nested type; error messages are famously enormous, and instantiation cost is superlinear in expression length.
- **Debug builds are much slower.** Without inlining, every `operator[]` on every node is a real call; a `-O0` Eigen build can be 10–100× slower than `-O2`.
- **Aliasing.** `r = r * m;` where `r` appears on both sides evaluates element-by-element and reads already-overwritten elements. Eigen requires an explicit `.eval()` for such cases; this is the same aliasing problem as `restrict` (Ch. 40 §40.7).

### What is replacing them

**Lazy range views** (C++20, Ch. 14 §14.10) are the standardized, general form of the same idea for sequences: `v | views::filter(p) | views::transform(f)` builds a composed view type and fuses the loop at consumption, with the same dangling hazards (`views::owning_view` and the borrowed-range machinery are the standard's answer). For numeric code, expression templates remain unmatched; for pipelines, ranges are the idiom. C++26's `std::simd` and explicit blocking often beat both for hand-tuned kernels.

---

## 17.22 Template Code Bloat and Compile-Time Cost

Templates trade compile time and binary size for runtime specialization. In a large low-latency codebase both costs are first-order, and being able to reason about them is a differentiator.

### Where compile time goes

1. **Header parsing, repeated per TU.** `<algorithm>`, `<ranges>`, `<format>` are tens of thousands of lines each; including them in a widely-included header multiplies across every TU.
2. **Instantiation, repeated per TU.** Each TU instantiates the same specializations and the linker throws away the duplicates.
3. **Deep instantiation chains.** Recursive metaprogramming, long `enable_if` chains, `std::tuple` operations on large tuples.
4. **Overload resolution over large candidate sets** — each candidate requires substitution.

### Where binary size goes

1. **One function body per distinct specialization.** `std::sort` instantiated for 30 comparator/type combinations is 30 bodies.
2. **Forwarding wrappers multiplying by value category.** `template <class... A> void f(A&&...)` called with 3 arguments generates up to 2³ signatures (though most collapse after inlining).
3. **Inline expansion at each call site.**

Bloat matters for latency because of **instruction cache and iTLB pressure** (Ch. 28 §28.16). A hot loop competing with megabytes of cold template instantiations suffers front-end stalls that don't show up in a microbenchmark. This is the argument behind BOLT/PGO hot-cold splitting (Ch. 40 §40.10) and `-ffunction-sections -Wl,--gc-sections`.

### Mitigations, roughly in order of payoff

| Technique | Effect |
|---|---|
| **Thin-template / fat-base idiom** | Put type-independent logic in a non-template base or a `void*`-based implementation; the template is a thin type-safe façade. This is how MSVC's `std::vector<T*>` collapses all pointer instantiations to one `vector<void*>` body. |
| **Erase where dispatch is cold** | `std::function`/`function_ref`/a virtual interface at cold boundaries; templates only on the hot path (Ch. 6 §6.20). |
| **`extern template`** (§17.10) | One instantiation instead of N; costs inlining unless LTO. |
| **Fold expressions over recursion** (§17.16) | O(1) vs O(N) instantiations. |
| **`if constexpr` over overload sets** | Fewer candidates, less substitution. |
| **Compiler builtins for traits** | libstdc++/libc++ already do this; avoid hand-rolled traits. |
| **Reduce header fan-out** | Forward declarations, pimpl (Ch. 44 §44.14), and *not* including `<iostream>`/`<format>` in headers. |
| **Precompiled headers / unity builds** | Amortize parsing; unity builds also amortize instantiation but hurt incremental rebuilds (Ch. 44 §44.13). |
| **Modules** (C++20) | Structurally eliminate re-parsing and much re-instantiation; the real long-term fix (Ch. 19 §19.6). |
| **Identical Code Folding** (`--icf=all`) | The linker merges byte-identical instantiations — very effective against pointer-type bloat (Ch. 41 §41.11). |

### Tooling to name

`-ftime-trace` (Clang) emits a Chrome-tracing JSON showing per-template instantiation cost — the single most useful tool here, visualized with `ClangBuildAnalyzer`. `-ftime-report` (GCC/Clang) gives phase totals. `templight` traces instantiation trees. `nm --size-sort --demangle` and `bloaty` attribute binary size to symbols. `include-what-you-use` and `clang-include-cleaner` prune headers. `ccache`/`sccache` and `ninja` address the rebuild side rather than the per-TU cost.

**The interview-grade framing:** templates give you monomorphized, inlinable, allocation-free code on the hot path — that's why HFT codebases are template-heavy. The price is compile time, binary size, and icache pressure, so the discipline is *template where the code is hot and the type set is small; erase where the code is cold or the type set is open.*

---

## Key Interview Questions

1. **Why can't you partially specialize a function template, and what do you do instead?** — The language only allows full specialization; overload and let partial ordering choose, or forward to a class template's static member. Specializations don't participate in overload resolution.
2. **What can an alias template not do?** — Be specialized (fully or partially) and be deduced from a function argument. It creates no distinct type.
3. **What conversions are allowed during template argument deduction?** — Only decay, qualification conversion, and derived-to-base for `Base<T>` parameters. No promotions, no user-defined conversions — hence `max(1, 2.0)` fails.
4. **What exactly is a forwarding reference?** — Precisely `T&&` where `T` is deduced by this call, or `auto&&`. `const T&&` and `vector<T>&&` are not, and neither is `T&&` on a member of an already-instantiated class template.
5. **State the reference collapsing rules.** — Any `&` in the pair wins; only `&& &&` gives `&&`.
6. **Why does a perfect-forwarding constructor hijack copies?** — For a non-const lvalue, `T&&` deduces `T=Widget&` and is an exact match, beating the copy constructor which requires adding `const`. Constrain it with `requires (!derived_from<remove_cvref_t<T>, Widget>)`.
7. **What can't be perfectly forwarded?** — Braced-init-lists, `0`/`NULL` as null pointers, bitfields, overloaded function names, and (pre-C++17) undefined in-class statics.
8. **What is CTAD and name two pitfalls.** — Deducing class template arguments from constructor arguments; `vector v{v2}` copies instead of wrapping, and `vector v(3,0)` vs `vector v{3,0}` differ.
9. **What types can be non-type template parameters?** — Integral/enum/pointer/reference/member-pointer classically; `auto` NTTPs in C++17; **structural class types and floating point in C++20**, which is what allows string literals as template arguments.
10. **When is a class template member function instantiated?** — Only when used (except virtuals, which are instantiated with the class). This is why `vector<T>` works for `T` lacking a default constructor.
11. **Explain two-phase lookup.** — Non-dependent names bind at the point of definition; dependent names bind at instantiation using ordinary lookup from the definition point plus ADL from the instantiation point. `/permissive-` makes MSVC conform.
12. **Why do you need `this->` in a class template derived from a dependent base?** — Unqualified lookup skips dependent bases, since a specialization of the base might not have the member.
13. **What does `extern template` do and what does it cost?** — Suppresses implicit instantiation in this TU, cutting compile time and object size; you lose inlining unless LTO is on, and an explicit instantiation definition instantiates *all* members.
14. **What is SFINAE and what is the "immediate context"?** — Substitution failure in a declaration removes a candidate; failures inside a function body or an instantiated class are hard errors.
15. **How does `void_t` detection work?** — A partial specialization whose argument is `void_t<decltype(expr)>` drops out if `expr` is invalid, falling back to the `false_type` primary.
16. **Why prefer concepts over `enable_if`?** — Diagnostics, uniform placement including constructors and non-template members, memoized satisfaction, and **subsumption-based overload ordering**.
17. **Why don't two type-trait `requires` clauses subsume each other?** — Subsumption compares *atomic constraints by identity*; `is_integral_v<T>` and `is_signed_v<T>` are unrelated atoms. Factor into named concepts and conjoin with top-level `&&`.
18. **What are the empty-pack defaults for unary folds?** — Only `&&` (true), `||` (false), and `,` (void) are allowed; everything else needs a binary fold with an explicit identity.
19. **Why is a comma fold safer than a pack expansion in a function call?** — The comma fold guarantees left-to-right sequencing; function argument evaluation order is unspecified.
20. **What can `if constexpr` not do that SFINAE/concepts can?** — Remove a declaration from an overload set, resolve ambiguity, affect `is_invocable`, or provide an open extension point.
21. **Why is `if constexpr (std::is_constant_evaluated())` always true?** — The condition is itself evaluated in a constant expression context; use `if consteval` (C++23) or a plain runtime `if`.
22. **What are expression templates and their two main dangers?** — Deferred expression trees that fuse loops and eliminate temporaries; they dangle when bound to `auto` or built from temporaries, and they explode compile time and debug-build performance.
23. **How do you reduce template code bloat?** — Thin-template/fat-base, type erasure at cold boundaries, `extern template`, folds over recursion, `--icf=all`, and reduced header fan-out; measure with `-ftime-trace` and `bloaty`.

---

## Common Traps

- **Specializing a function template and expecting it to beat an overload** — it never enters overload resolution.
- **Trying to partially specialize a function or alias template** — not allowed.
- **`max(1, 2.0)`** — inconsistent deduction; no arithmetic conversions during deduction.
- **`f({1,2,3})` on `template <class T> void f(T)`** — braced-init-lists are a non-deduced context.
- **Thinking `const T&&` or `vector<T>&&` is a forwarding reference.**
- **`std::move` on a forwarding reference** — steals from the caller's lvalue.
- **`std::forward` without an explicit template argument** — intentionally ill-formed.
- **An unconstrained `template <class T> Widget(T&&)` constructor** — hijacks the copy constructor for non-const lvalues.
- **`std::vector v{other_vector}`** — CTAD's copy candidate wins; you get a copy, not a nested vector.
- **`std::vector v{3, 0}` vs `v(3, 0)`** — two elements vs three zeros.
- **Full specialization declared after first use in some TU** — IFNDR; different TUs silently get different behavior.
- **Full specialization in a header without `inline`** (functions) — multiple definition.
- **Specializing a standard template for a non-user-defined type** — UB.
- **Missing `this->` on a member of a dependent base** — fails on GCC/Clang, "works" on MSVC without `/permissive-`.
- **Missing `typename`/`template` disambiguators** in dependent nested names.
- **Explicit instantiation of a class whose members aren't all valid for that `T`** — instantiates everything.
- **`enable_if` in a default template argument used to distinguish two overloads** — same signature, redefinition error.
- **SFINAE on something outside the immediate context** — hard error instead of a removed candidate.
- **Two identical inline `requires` clauses in different declarations** — distinct atoms, no subsumption, ambiguity.
- **Unary fold over an empty pack with `+`** — ill-formed; use the binary form.
- **Left vs right fold on a non-associative operator** — including floating-point summation.
- **`static_assert(false)` in a discarded `if constexpr` branch** — non-dependent, so it fires; fixed only by CWG2518 in C++23.
- **`if constexpr` in a non-template function** — both branches are fully checked.
- **`auto e = a + b;` with expression templates** — dangling references to operands.
- **Aliasing in expression templates** (`r = r * m`) — needs an explicit `.eval()`.
- **`#include <format>`/`<ranges>` in a widely-included header** — multiplied parse cost across every TU.

---

## Compact Recall Summary

**Kinds.** Function templates deduce and overload but only fully specialize. Class templates fully and partially specialize. Variable templates (C++14) give `_v` traits. Alias templates cannot be specialized or deduced and create no distinct type; `type_identity_t` is the standard deduction blocker.

**Deduction.** Pattern matching with only decay, qualification conversion, and derived-to-`Base<T>` allowed. By-value drops top-level cv and decays arrays; by-reference preserves both, which is what makes `T(&)[N]` capture array extents. Non-deduced contexts: `typename A<T>::type`, expressions in NTTPs, defaulted parameters, braced-init-lists.

**Forwarding.** `T&&` (deduced) and `auto&&` are forwarding references; lvalues deduce `T=A&` and collapsing yields `A&`. Any `&` in a collapsing pair wins. `std::forward<T>` restores the value category; `std::move` is unconditional. Forwarding references are greedy and hijack copy constructors — constrain them. Cannot forward braced lists, `0`, bitfields, or overload names.

**CTAD** (C++17) uses implicit guides from constructors plus user guides; watch the copy-deduction candidate and brace-vs-paren. Aggregate and alias CTAD arrive in C++20.

**NTTPs.** Integral/pointer/enum classically; `auto` NTTPs in C++17; **structural class types and floats in C++20**, which enables string-literal template arguments. Equivalence is member-wise, not `operator==`.

**Instantiation and lookup.** Implicit instantiation is lazy per member (virtuals excepted) and emitted as COMDAT in every TU. Non-dependent names bind at the definition point; dependent names use ADL at instantiation — so customization points must be ADL-reachable, and members of dependent bases need `this->`. `typename`/`template` disambiguate dependent names; C++20 makes `typename` optional where only a type is possible. `extern template` + one explicit instantiation cuts build time at the cost of inlining.

**Constraining.** SFINAE removes candidates on substitution failure in the *immediate context only*; `enable_if` in an extra defaulted template parameter is the portable form; `void_t` + partial specialization is the detection idiom. C++20 concepts replace all of it with named predicates, `requires`-expressions (simple/type/compound/nested), better errors, and **subsumption** — which orders overloads automatically but only over atomic constraints compared by identity, so wrap traits in named concepts and conjoin at the top level.

**Packs.** `pattern...` expands per element; multiple packs expand in lockstep; packs must be last to deduce. `sizeof...` counts. Fold expressions (C++17) replace recursion in O(1) instantiations — `...` sits on the associating side, empty packs are only valid for `&&`/`||`/`,`, and comma folds are the only expansion form with guaranteed sequencing. C++26 adds pack indexing.

**Dispatch.** Tag dispatch resolves by conversion ranking over a tag hierarchy (the `std::advance` design) and stays open to third-party extension; `if constexpr` (C++17) gives closed, in-function branching that discards uninstantiated branches — but only inside templates, and it cannot remove overloads. Concepts do both jobs better where the language version allows.

**Traits.** Predicates, transformations, and compiler-intrinsic-only traits (`is_trivially_copyable`, `is_polymorphic`) that cannot be written in the language. Know `is_trivially_copyable_v`, `is_nothrow_move_constructible_v`, `has_unique_object_representations_v`, and `is_invocable_r_v` and what each gates. `_v` variable templates beat `::value` for compile time; builtins beat both.

**Cost.** Expression templates fuse composite expressions into one memory pass (Eigen) at the cost of dangling `auto`, huge diagnostics, and slow debug builds; lazy range views are the standardized sequence analogue with the same lifetime hazards. Template bloat costs compile time, binary size, and — the one that matters at runtime — icache and iTLB pressure. Mitigate with thin-template/fat-base, type erasure at cold boundaries, `extern template`, folds, ICF, header hygiene, and eventually modules; measure with `-ftime-trace`, `ClangBuildAnalyzer`, and `bloaty`.
