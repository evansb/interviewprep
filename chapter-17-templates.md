# Chapter 17 — Templates

## Why this matters in an HFT interview — Core

Templates move decisions about types and values into translation. A specialization can expose constants, concrete operations, and exact object layouts to optimization, but it can also multiply parsing, instantiation, machine code, and diagnostics. The useful model is therefore: what is checked at definition, what is deduced or substituted, what becomes instantiated, and what artifact is emitted?

This chapter develops that model through deduction, forwarding, lookup, specialization, constraints, and packs. See Chapter 4 for general overload resolution and value categories, and Chapter 19 for constant evaluation and other modern-language facilities.

## 90-second screen — Core

1. A template is parsed and its non-dependent constructs are checked at definition. Substitution/constraints determine whether a specialization participates; use then determines which definitions must be instantiated.
2. Function-template deduction matches parameter patterns after specified adjustments. It does not generally search for promotions or user-defined conversions; once arguments are fixed, ordinary conversions can apply.
3. `T&&` is a forwarding reference only when `T` is deduced by the same call, or for `auto&&`; reference collapsing then makes any `&` in a collapsing pair win.
4. Non-dependent names bind at the point of definition; dependent names resolve at instantiation via ordinary lookup from the definition point plus ADL from the instantiation point — which is why a member of a dependent base needs `this->`.
5. Concepts (C++20) express overload participation and ordering. Subsumption works from normalized, identical atomic constraints—not from arbitrary logical implication.

For new C++23 interfaces, prefer named concepts over `enable_if`; keep SFINAE knowledge for existing code and detection internals. Choose static specialization when its runtime benefit is measurable and the type set is controlled. At cold or open-ended boundaries, type erasure may trade one indirect call for lower build cost and smaller instruction footprint; see Chapter 6.

The translation-time control flow is:

```text
parse template definition
        |
call/use -> deduction -> substitution + constraint checking
                         | failure in allowed immediate context: candidate removed
                         v
                  overload/partial ordering
                         |
                  selected specialization
                         |
                instantiate required definition
                         | body error: hard diagnostic
                         v
                 optimize and possibly emit code
```

This order explains why SFINAE cannot hide an error in a selected function body and why constraints can improve an interface without guaranteeing cheaper compilation or faster machine code.

---

## 17.1 Kinds of Templates — Core

A template parameter can be a type, a compile-time value, or another template. Defaults and parameter packs are allowed under placement rules covered later. Four common declaration forms are:

```cpp
#include <cstddef>
#include <type_traits>

template <class T> T max(T a, T b);                              // function template
template <class T, std::size_t N> struct Array { T data[N]; };    // class template
template <class T> inline constexpr bool scalar_v =              // variable template
    std::is_arithmetic_v<T>;
template <class T> using PairWithInt = Array<T, 2>;               // alias template

static_assert(scalar_v<double>);
static_assert(sizeof(PairWithInt<int>) == 2 * sizeof(int));
```

**Function templates** deduce their arguments from the call (§17.2), participate in overload resolution alongside non-templates, and can be overloaded but only *fully* specialized — never partially:

```cpp
template <class T> void f(T);            // (1) primary
template <class T> void f(T*);           // (2) an overload, not a specialization
template <>        void f<int>(int);     // (3) full specialization of (1)
```
For an `int*` argument, overload resolution picks (2). Function-template specializations are not independent overload candidates: overload resolution first chooses a primary template, after which an explicit specialization of that primary can supply the definition. Prefer overloading or constraints for function dispatch; use class-template partial specialization when the type pattern itself must vary.

Between a function template and an equally good non-template overload, the non-template wins. Between two templates, partial ordering picks the more specialized.

**Class templates** support full and partial specialization (§17.6), member templates, static members (one per instantiation), and CTAD (§17.4, C++17). Each distinct instantiation is a distinct type: `Array<int,4>` and `Array<int,5>` share nothing, including static members.

**Variable templates** remove `::value` boilerplate: `std::is_integral_v<T>` exposes `is_integral<T>::value`. Under the corrected C++ rule (CWG2387), the namespace-scope internal-linkage exception for non-volatile `const` variables applies only to non-template variables. Implementations historically differed in applying that defect report. Write header-defined variable templates as `inline constexpr` in C++17 and later: `inline` makes the one-entity ODR intent explicit and avoids depending on older linkage behavior. `_v` syntax is readability, not an intrinsic compile-time optimization over `::value`.

**Alias templates** are the subtle one. An alias template is not a class, so:

- It has no specializations, full or partial. You cannot write `template <> using X<int> = …`.
- Its substituted result participates in deduction when the resulting pattern exposes the parameter; `template<class T> using Vec = std::vector<T>;` permits deduction through a parameter `Vec<T>`. A parameter in a non-deduced nested-name position still cannot be solved. Alias substitution is not a blanket deduction barrier.
- It is transparent: `Vec<int>` and `std::vector<int, MyAlloc<int>>` are the same type, so it creates no distinct type for overloading. Use a real class if you need distinctness.
- `std::type_identity_t<T>` deliberately places `T` in a non-deduced context, which is useful when another parameter should decide `T`:

```cpp
template <class T> void g(T, std::type_identity_t<T>);  // deduce only from the first argument
g(1.0, 2);   // T = double; the int converts. Without identity_t this would be ambiguous.
```

A member function template of a class template defined out of line needs two template parameter lists—`template<class T>` for the class and `template<class U>` for the member—not two `template<>` specialization headers. A constructor template does not suppress implicit declaration of a copy constructor, yet it can win overload resolution for a non-const lvalue; §17.3 diagnoses that case.

---

## 17.2 Template Argument Deduction — Core

Deduction matches each function-parameter type `P` against its argument type `A` and solves for template arguments. It is pattern matching with specified adjustments and limited fallback alternatives, not a general “find any conversion” process.

For a by-value parameter `P`:
1. Top-level cv-qualifiers on `A` are dropped (`const int` → `int`).
2. Array-to-pointer and function-to-pointer decay applies (`int[5]` → `int*`).

For a reference parameter `P&` or `P&&`, neither happens — references preserve arrays and constness:

```cpp
template <class T> void byval(T);      int a[5];  byval(a);   // T = int*
template <class T> void byref(T&);                byref(a);   // T = int[5]; P is int(&)[5]
template <class T, size_t N> void arr(T(&)[N]);   arr(a);     // N = 5 — the idiom
const int c = 0;
byval(c);   // T = int   (const dropped)
byref(c);   // T = const int
```
`template <class T, std::size_t N> constexpr std::size_t len(T(&)[N]) { return N; }` preserves the array bound and rejects a pointer.

Do not memorize the adjustments as “three conversions.” For non-reference `P`, arrays/functions decay and top-level cv is ignored. For reference `P`, deduction uses the referred-to argument type. If direct matching fails, the standard permits specific alternatives in relevant forms, including certain cv/qualification compatibility and deduction of a class-template pattern from a derived argument. It does not generally apply integral promotions, arithmetic conversions, or user-defined conversions while solving for `T`:

```cpp
template <class T> T max(T,T);
max(1, 2.0);            // ERROR — deduces T=int from arg1, T=double from arg2, inconsistent
max<double>(1, 2.0);    // OK — T explicit, ordinary conversions now apply
```

**Non-deduced contexts** — positions the compiler cannot solve for, which must come from elsewhere (explicit arguments, defaults, or another parameter):

| Context | Example |
|---|---|
| Nested name qualified by a template parameter | `typename A<T>::type` |
| Non-type argument that is an expression involving the parameter | `std::array<int, N+1>` |
| A parameter with a default argument | `template<class T> void f(T = 0)` |
| The type of a braced-init-list matched against plain `T` | `f({1,2,3})` with `template<class T> void f(T)` fails |

`template <class T> void f(T)` rejects `f({1,2,3})`, but `template <class T> void f(std::initializer_list<T>)` accepts it — the one deliberate divergence between `auto` deduction (`auto x = {1,2,3}` deduces `initializer_list<int>`) and template deduction.

All deductions for the same template parameter must be consistent. After deduction or explicit specification fixes the specialization, conversions required by the resulting function parameter are considered normally. `auto` return deduction follows placeholder rules modeled on template deduction; `decltype(auto)` instead applies `decltype` rules and can preserve references.

### Deduction worksheet

Work out `T` (or "fails") before checking the answer column.

| `P` | Call | `T` | Why |
|---|---|---|---|
| `T` | `f(3)` | `int` | by value, no adjustment needed |
| `T` | `f(arr)` where `int arr[5]` | `int*` | array-to-pointer decay |
| `T&` | `f(arr)` where `int arr[5]` | `int[5]` | no decay; resulting parameter is `int(&)[5]` |
| `T` | `f(ci)` where `const int ci=1` | `int` | top-level cv dropped |
| `T&` | `f(ci)` where `const int ci=1` | `const int` | cv preserved through reference |
| `T` | `f(1, 2.0)` for `T f(T,T)` | fails | inconsistent deduction, no arithmetic conversion |
| `T&&` | `f(x)`, `x` an lvalue `int` | `int&` (collapses to `int&`) | forwarding reference, lvalue rule (§17.3) |
| `T&&` | `f(5)` | `int` (param becomes `int&&`) | forwarding reference, rvalue rule |
| `T` | `f({1,2,3})` for `f(T)` | fails | braced-init-list is non-deduced |

---

## 17.3 Forwarding References and Reference Collapsing — Core

A forwarding reference (the standard's term; "universal reference" is Meyers') is a parameter of exactly the form `T&&`, where `T` is a template parameter deduced by this call, or `auto&&`. Nothing else qualifies:

```cpp
template <class T> void f(T&& x);              // forwarding reference
template <class T> void g(const T&& x);        // NOT — const disqualifies it
template <class T> void h(std::vector<T>&& v); // NOT — not the bare form T&&
template <class T> struct S {
    void m(T&& x);                             // NOT — T is already fixed by the class
};
```

Deduction has a special rule for `T&&`: an lvalue argument of type `A` deduces `T = A&`; an rvalue deduces `T = A`. Reference collapsing then applies:

| Written | Collapses to |
|---|---|
| `T& &`, `T& &&`, `T&& &` | `T&` |
| `T&& &&` | `T&&` |

Any `&` in the pair wins. Collapsing only happens where a reference-to-reference can arise through substitution — template arguments, `auto`, alias substitution, `decltype` — you still cannot write `int& &` directly.

```cpp
int i = 0;
f(i);    // lvalue → T = int&  → param type int& && → int&
f(42);   // rvalue → T = int   → param type int&&
```
The parameter's declared type is `int&` in the first call and `int&&` in the second, but in both cases the expression `x` is an lvalue because it has a name.

### Perfect forwarding

`std::forward<T>(x)` is a conditional cast driven by deduced `T`: it produces an lvalue when `T` is an lvalue reference and an xvalue otherwise. This preserves the caller's value category through a forwarding wrapper.

```cpp
#include <utility>

int category(const int&) { return 1; }
int category(int&&) { return 2; }

template <class T>
int relay(T&& value) {
    return category(std::forward<T>(value));
}

int main() {
    int value = 7;
    return relay(value) == 1 && relay(7) == 2 ? 0 : 1;
}
```

Using `std::move(value)` would incorrectly treat an lvalue caller's object as expendable. Passing `value` without a cast would always select the lvalue path. Forward each consumable argument once: forwarding the same rvalue twice can expose a moved-from object to the second consumer. Forwarding preserves category, not lifetime; a callee that stores a reference can still dangle after the full expression. C++23 `std::forward_like<Model>(x)` applies `Model`'s cv/ref pattern to another expression and is useful for forwarding members; Chapter 4 covers the underlying value categories.

A forwarding-reference constructor matches a broad set of cv/ref forms exactly, so it can out-compete an intended copy overload:

```cpp
struct Widget {
    template <class T> Widget(T&& name);   // greedy
    Widget(const Widget&);                 // copy ctor
};
Widget w1{"x"};
Widget w2{w1};   // calls the TEMPLATE: w1 is a non-const lvalue, T=Widget& is an exact
                 // match, while the copy ctor needs to add const
```
Fix by constraining the template to exclude `Widget` and its bases:

```cpp
template <class T>
    requires (!std::derived_from<std::remove_cvref_t<T>, Widget>)
Widget(T&& x);
```
`std::remove_cvref_t<T>` (C++20; `std::decay_t` pre-C++20) recovers the underlying type. `std::decay_t` also decays arrays and functions, which is usually not what you want when you only meant to strip references and cv.

---

## 17.4 Class Template Argument Deduction (CTAD) — Core

CTAD lets class-template arguments be deduced from initialization. Factory functions such as `make_pair` predate CTAD, but they can also apply deliberate decay/reference policies rather than serving only as spelling workarounds.

```cpp
std::pair p{1, 2.0};              // std::pair<int, double>
std::vector v{1, 2, 3};           // std::vector<int>
std::lock_guard g{mtx};           // std::lock_guard<std::mutex>
```

The compiler forms a set of fictional function templates — one per constructor of the primary template, a copy-deduction candidate, and any user-written deduction guides — and runs overload resolution over that set. Guides are needed whenever the constructor parameters don't directly expose the class parameters:

```cpp
template <class It> Vector(It, It) -> Vector<typename std::iterator_traits<It>::value_type>;
```

Pitfalls: `std::vector v{v2}` copies rather than wraps, because the copy-deduction candidate wins — you get `vector<int>`, not `vector<vector<int>>`. `std::vector v(3, 0)` gives three zeros; `std::vector v{3, 0}` gives the two elements `3` and `0` (initializer-list constructor). CTAD does not accept partial argument lists (`std::pair<int> p{1, 2.0}` is ill-formed) and does not consider base classes' or inherited constructors. C++20 added aggregate deduction candidates (`template <class T> struct P { T a; T b; }; P p{1, 2};`) and alias-template CTAD. An explicit guide can be marked `explicit`, which suppresses CTAD in copy-initialization contexts.

Use CTAD where the deduction guide expresses the intended ownership and element type. `make_unique` and `make_shared` remain important because they combine allocation and construction with the intended ownership machinery; Chapter 9 covers those details.

---

## 17.5 Instantiation, Two-Phase Lookup, and Dependent Names — Core

Template definitions are parsed, and non-dependent names and constructs are checked immediately. **Implicit instantiation** occurs when a context requires a specialization. A class specialization generally needs instantiation when its complete type affects semantics—for example, `sizeof(Box<int>)` or an object definition—while declaring `Box<int>*` can use an incomplete specialization. **Explicit instantiation** requests a specialization directly (§17.14).

Instantiating a class specialization instantiates member declarations, but an ordinary non-deleted member-function definition is not implicitly instantiated until a context requires it:

```cpp
#include <iostream>

struct NoStream {};

template <class T> struct Holder {
    T v;
    void print() { std::cout << v; }
};

int main() {
    Holder<NoStream> h{};  // fine: print's definition is not required
    // h.print();          // error if enabled: NoStream is not stream-insertable
}
```
This permits `Holder<NoStream>` until `print()` is required. Virtual members need a qualification: the standard leaves it unspecified whether an implementation implicitly instantiates a virtual member of a templated class when it would not otherwise be instantiated. Vtable emission can therefore expose an ill-formed virtual body earlier on one implementation than an ordinary member body. Do not use an invalid unused virtual member as a portability boundary; constrain it or make its definition valid for every supported specialization.

An implicit instantiation has one or more **points of instantiation**, determined by the kind of specialization and the use that requires it. Those points affect dependent lookup and whether an explicit specialization was declared soon enough. A specialization with multiple points must have the same meaning at each. In common object formats, multiple translation units may emit coalescible copies of the same specialization, but that weak/COMDAT mechanism is an ABI/toolchain strategy, not the language rule.

### Two-phase lookup

**Phase 1**, at the point of definition: non-dependent names are looked up and bound. **Phase 2**, when a specialization is instantiated: dependent constructs are completed. For a dependent function call, ordinary unqualified lookup is anchored at the template definition; argument-dependent lookup can add declarations from associated namespaces visible at the definition or instantiation context:

```cpp
void g(double);
template <class T> void f(T t) { g(t); g(1); }
void g(int);              // declared AFTER the template

f(1);   // g(t) is dependent → ADL at the instantiation point finds nothing for int → g(double)
        // g(1) is non-dependent → bound at definition → g(double)
```
A later ordinary declaration is not found merely because it precedes the instantiation; ADL must reach an associated namespace. This is why customization functions are placed where ADL can find them. The `using std::swap; swap(a, b);` pattern supplies a standard fallback while leaving the call unqualified for ADL.

A template body's non-dependent constructs are checked at definition time even if the template is never instantiated. `static_assert(false)` in an `if constexpr` branch used to require a dependent workaround for this reason; CWG2518 (C++23) legitimizes a literal `false` inside a *discarded* `if constexpr` branch specifically (§17.12).

### Dependent names and disambiguators

A dependent qualified name is not assumed to denote a type or template unless the grammar or prior declarations establish that meaning. Two disambiguators resolve ambiguous parses:

```cpp
template <class T> void f() {
    typename T::value_type v;              // 'typename': T::value_type is a TYPE
    typename T::template rebind<int> r;     // both disambiguators can be needed
}
```
Without `typename`, `T::value_type * p;` can parse as multiplication. Without `template`, `<` after a dependent object can parse as less-than. Several contexts already assume a type, and C++20 expanded that set; the durable rule is to ask whether the parser can know the dependent qualified name is a type in that grammar, not whether the text appears inside or outside a function.

### Worked example: dependent base lookup

Unqualified lookup does not search a dependent base class, because a specialization of that base might not define the member. This first fragment is intentionally ill-formed:

```cpp
template <class T> struct Base {
    int value = 42;
    virtual void helper() {}
};
template <class T> struct Derived : Base<T> {
    void f() {
        value = 1;          // ERROR: use of undeclared identifier 'value'
    }
};
```
Make the name dependent so lookup happens at instantiation:

```cpp
template <class T> struct Derived : Base<T> {
    using Base<T>::value;      // brings 'value' into this scope — a member-declaration,
                                // so it must appear directly in the class body, not in f()
    void f() {
        this->value = 1;       // also fixes it, without a using-declaration
        Base<T>::helper();     // qualified call — compiles, but suppresses virtual dispatch
        value = 2;             // OK now, thanks to the using-declaration above
    }
};
```
These fixes act differently: `this->value` makes that use dependent; `using Base<T>::value;` introduces the base member into the derived scope for unqualified uses and must appear at class scope. `Base<T>::helper()` is explicitly qualified and therefore suppresses virtual dispatch; `this->helper()` would preserve it.

---

## 17.6 Full and Partial Specialization — Core

Specialization provides an alternative definition for specific arguments. The primary template must be declared first; a specialization is not an overload and does not itself participate in overload resolution.

```cpp
template <class T, class U> struct Pair { /* ... */ };            // primary
template <>            struct Pair<int, int> { /* ... */ };       // FULL specialization
template <class T>     struct Pair<T, T> { /* ... */ };           // PARTIAL specialization
```

| | Class templates | Function templates | Variable templates | Alias templates |
|---|---|---|---|---|
| Full specialization | Yes | Yes | Yes | No |
| Partial specialization | Yes | No — overload instead | Yes | No |

Key rules:

- A full specialization can be declared and later defined. Its definition obeys the ordinary ODR; a function specialization defined in a header normally needs `inline`.
- Declare a full specialization before any use that would instantiate the primary, in every translation unit where such use occurs. Violating that ordering makes the program ill-formed and cross-translation-unit diagnostics are not dependable.
- Specializing a standard-library template is allowed only where that template's specification permits it and the program meets its requirements, usually involving a program-defined type. `std::hash` and `std::formatter` are common permitted customization points; adding arbitrary declarations to `namespace std` is not.
- Partial specialization uses partial ordering to pick the most specialized match; ambiguity is an error.
- Default arguments live on the primary only; a partial specialization does not restate them.
- A single member can be specialized without specializing the whole class (`template <> void Ring<int>::push(int)`), but only outside the class, for a full specialization of the enclosing arguments.

Partial specialization is suited to type shape (`T*`, `T[N]`, `Container<T>`). Concepts (§17.7) and `if constexpr` (§17.12) express properties and branch validity more directly. The trade-off is openness: specialization associates behavior with exact patterns, whereas a semantic concept can admit future types that satisfy its contract.

---

## 17.7 Concepts and Constraints — Core

A concept (C++20) is a named compile-time boolean predicate over template parameters.

### Type traits as compile-time queries

Standard type traits are class templates that expose either a `value` or a nested `type`. Convenience aliases such as `std::remove_cvref_t<T>` and variable templates such as `std::is_integral_v<T>` shorten `typename std::remove_cvref<T>::type` and `std::is_integral<T>::value`; they do not change the abstract result or promise less compiler work.

Traits answer the exact property they specify. `is_convertible_v<From, To>` models an imaginary conversion in its defined context; it does not prove that conversion is cheap or semantically appropriate. Some traits place conditions on incomplete types when completion could change the answer, so check the trait's preconditions rather than treating all unevaluated queries as harmless. Do not specialize standard traits unless their specification explicitly permits it.

```cpp
template <class T>
concept Arithmetic = std::is_arithmetic_v<T>;

template <class T>
concept Hashable = requires (const T& t) {
    { std::hash<T>{}(t) } -> std::convertible_to<std::size_t>;
};
```

A `requires`-expression's requirements come in four flavors: **simple** (`t.reserve(n);` — must compile), **type** (`typename T::value_type;`), **compound** (`{ t.size() } noexcept -> std::convertible_to<std::size_t>;` — also checks the return type and `noexcept`), and **nested** (`requires HasReserve<T>;`). A requires-expression can be used as a boolean; a requires-clause whose operand is a requires-expression legitimately contains the word twice: `requires requires { ... }`.

For this concept, four declaration forms express the same constraint:

```cpp
void f(Arithmetic auto x);                                  // abbreviated
template <Arithmetic T> void f(T x);                        // constrained parameter
template <class T> requires Arithmetic<T> void f(T x);      // requires-clause
template <class T> void f(T x) requires Arithmetic<T>;      // trailing requires-clause
```
The trailing form can name function parameters, which the pre-declarator form cannot.

### `enable_if` versus a concept, the same function two ways

```cpp
// SFINAE / enable_if
template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
constexpr T clamp_nonneg_sfinae(T v) { return v < 0 ? 0 : v; }

// Concept-constrained
template <std::integral T>
constexpr T clamp_nonneg(T v) { return v < 0 ? 0 : v; }
```
Both reject `double` before the body is selected. The concept version exposes a named interface condition and participates in constraint subsumption. Diagnostic wording and compile-time caching are implementation properties; `_v`, `enable_if`, and a concept do not carry universal relative compile-time costs.

Concepts cannot be recursively defined or explicitly specialized. A constrained non-template member of a class template is legal: `void push(const T&) requires std::copy_constructible<T>;`. Prefer an existing standard concept when its semantics match; a requires-expression checks syntax and selected properties, not the full meaning promised by names such as `regular`.

### Subsumption

Subsumption is the standard's formal partial ordering of normalized constraints. When two otherwise comparable candidates are viable, the more constrained one can win; the compiler does not invoke a general theorem prover.

```cpp
template <std::input_iterator It>          void advance_(It, int);  // (1)
template <std::random_access_iterator It>  void advance_(It, int);  // (2)
// random_access_iterator refines input_iterator, so (2) wins for a vector iterator.
```
Constraints are normalized into atomic constraints; concept names expand, and top-level `&&`/`||` in the *constraint-expression* decompose into conjunctions/disjunctions. Subsumption is decided by **identity of atomic constraints**, not by logical reasoning about what they mean:

```cpp
template <class T> requires std::is_integral_v<T> void f(T);                          // (1)
template <class T> requires (std::is_integral_v<T> && std::is_signed_v<T>) void f(T);  // (2)
f(1);  // ambiguous: the repeated trait expression is not the same atomic constraint
```
The `is_integral_v<T>` in (1) and the textually repeated occurrence in (2) come from different source expressions, so they are not identical atomic constraints. Factoring the shared condition into a named concept reuses its normalized atom:

```cpp
template <class T> concept Integral = std::is_integral_v<T>;
template <class T> concept SignedIntegral = Integral<T> && std::is_signed_v<T>;
template <Integral T>        int f(T);   // (1)
template <SignedIntegral T>  int f(T);   // (2) subsumes (1)
```
Two atomic constraints are identical only if they come from the same source expression (same declaration) — copy-pasting a `requires` clause creates a distinct atom. Ambiguity is an error, not a silent choice. Subsumption is checked after ordinary overload-resolution tiebreakers (conversion ranking, template partial ordering) — it is a late tiebreaker.

| Constraint relationship | Result for otherwise equal candidates |
|---|---|
| One candidate reuses a named concept and adds a conjunct | The added-conjunct candidate can subsume the base |
| Each declaration repeats equivalent trait text independently | Atoms are distinct; neither may subsume the other |
| Constraints are semantically related but normalize to unrelated atoms | No logical inference; ambiguity remains possible |
| One candidate already has a better conversion sequence | Ordinary overload ranking decides before constraints need to break the tie |

**Exercise.** Define `concept C1 = std::integral<T>;` and `concept C2 = C1<T> && std::same_as<T, int>;`. Write two overloads of `g`, then predict why `g(1)` selects `C2` while `g(1u)` selects `C1`. Replace `C1<T>` inside `C2` by a fresh `std::integral<T>` expression and diagnose the resulting ambiguity.

---

## 17.8 Parameter Packs and Fold Expressions — Core

A template parameter pack holds zero or more template arguments; a function parameter pack holds zero or more function parameters. A pack expansion, `pattern...`, repeats its pattern once per element.

```cpp
#include <utility>
#include <vector>

template <class... Ts>
auto sum(Ts... values) {
    return (0 + ... + values);  // binary left fold; empty pack returns 0
}

template <class V, class... Ts>
void push_all(V& out, Ts&&... values) {
    (out.push_back(std::forward<Ts>(values)), ...);
}

int main() {
    std::vector<int> values;
    push_all(values, 1, 2, 3);
    return sum(1, 2, 3) == 6 && values.size() == 3 ? 0 : 1;
}
```
The expansion point matters: `h(args)...` applies `h` to each element; `h(args...)` passes the entire pack to one call. `sizeof...(Ts)` is the element count. Multiple packs in one pattern expand in lockstep and must have equal lengths.

A template parameter pack in a primary **class** template must be last. In a **function** template, later template parameters are permitted when they have defaults or can be deduced. A different rule applies to function parameters: a function parameter pack that is not at the end of the function parameter list is a non-deduced context, so `template<class... Ts> void f(Ts..., int);` cannot infer a nonempty `Ts...` from leading call arguments. Reorder the parameters or package the prefix explicitly. Chapter 18 covers lambda pack captures.

Pack expansion is permitted only in specified grammatical contexts, including argument lists, initializer lists, base lists, and `using` declarations. Placement decides what syntax repeats.

### Fold expressions (C++17)

| Form | Name | Expands to | Empty pack |
|---|---|---|---|
| `(... op pack)` | unary left fold | `((a0 op a1) op a2)` | ill-formed except `&&`, `\|\|`, `,` |
| `(pack op ...)` | unary right fold | `(a0 op (a1 op a2))` | same |
| `(init op ... op pack)` | binary left fold | `((init op a0) op a1)` | `init` |
| `(pack op ... op init)` | binary right fold | `(a0 op (a1 op init))` | `init` |

`...` sits on the side it associates toward. Empty-pack defaults: `&&` → `true`, `||` → `false`, `,` → `void()`; everything else needs the binary form with an explicit identity.

A comma fold guarantees left-to-right sequencing. A plain function call with pack expansion, `g(f(v)...)`, leaves argument evaluation order unspecified (Chapter 4), which matters when elements mutate shared state. Left versus right fold matters for non-associative operators, including subtraction and floating-point addition (Chapter 23).

A recursive helper typically creates one function/class specialization per element; one fold expression can process the whole pack inside one enclosing specialization. The compiler still analyzes every expanded operand, so this reduces instantiation depth and event count rather than making compile work independent of pack length.

---

## 17.9 Compile-Time and Code-Size Cost — Core

Templates can trade build resources and binary size for runtime specialization. None of those outcomes is automatic: a specialization may be inlined away, merged with an identical body, or never emitted.

**Compile time** can grow through repeated header parsing, repeated instantiation work across translation units, deep recursive metaprograms, expensive constant evaluation, and large overload candidate sets. **Object and binary size** can grow when distinct specializations require emitted bodies or metadata. Linkers may coalesce equivalent definitions, and optimizers may merge or remove code, but the front end already paid to parse and instantiate it.

Larger hot code can increase instruction-cache and iTLB pressure; cold emitted specializations may mainly affect disk, load time, and link time. Confirm runtime impact with instruction-front-end counters and production-shaped control flow (Chapter 28), not binary size alone.

| Technique | Mechanism and trade-off |
|---|---|
| Thin-template / fat-base idiom | Type-independent logic in a non-template base; the template is a thin façade. |
| Type erasure at a cold boundary | Reduces specialization count but adds an indirect-dispatch/ownership contract; see Chapter 6. |
| `extern template` (§17.14) | Can suppress repeated out-of-line instantiation for a closed type set; requires a linked definition. |
| Fold over recursive helpers (§17.8) | Reduces recursive specialization depth while retaining per-operand analysis. |
| One constrained entry plus `if constexpr` | Can shrink an overload set; gives up open extension through new overloads. |
| Reduced header fan-out | Avoids repeated parsing; may require a stable non-template boundary or pimpl (Chapter 44). |
| Toolchain code folding/LTO | May merge bodies across TUs; increases link work and is platform/configuration-specific (Chapter 41). |

### Lab: measuring instantiation cost with `-ftime-trace`

Clang's `-ftime-trace` can emit JSON events for parsing and instantiation:

```bash
clang++ -std=c++23 -ftime-trace=heavy-trace.json -c heavy.cpp -o heavy.o
```
Check that the local compiler supports the option and named-output form. Compare clean builds of the same TU, compiler, flags, machine load, and cache state. Count `InstantiateFunction`/`InstantiateClass` events and inspect the longest events. Rewrite one recursive pack helper as a fold, then compare trace structure and wall time; expect fewer recursive specializations, not a guaranteed speedup. For code size, compare optimized linked artifacts with `size`, `nm`/`llvm-nm`, a linker map, or `bloaty` when available. Record text size and instruction-front-end counters separately.

---

## 17.10 Non-Type Template Parameters — Reference / Deep dive

A non-type template parameter (NTTP) carries a constant template argument. C++23 accepts structural types: scalar types, lvalue-reference types, and qualifying literal class types whose bases and non-static data members are public, non-mutable, and themselves structural types or arrays of them. `auto` can deduce the NTTP type.

```cpp
#include <algorithm>
#include <cstddef>

template <std::size_t N>
struct FixedString {
    char data[N]{};
    constexpr FixedString(const char (&s)[N]) { std::copy_n(s, N, data); }
};
template <std::size_t N>
FixedString(const char (&)[N]) -> FixedString<N>;

template <FixedString Name>
constexpr std::size_t channel_width() { return sizeof(Name.data); }

static_assert(channel_width<"order_ack">() == 10); // 9 characters plus '\0'
```
The placeholder `FixedString` in the template parameter uses class template argument deduction, so each literal supplies its own bound. Hard-coding one `FixedString<N>` would reject every other literal length.

Template-argument equivalence for a structural class is determined recursively from its subobjects, not by calling its `operator==`. Floating arguments also follow template-argument-equivalence rules rather than ordinary runtime equality: `C<-0.0>` and `C<0.0>` are distinct specializations. Such details make floating NTTPs poor semantic identifiers unless bit-sensitive identity is intended. An NTTP argument must satisfy constant-expression and permitted-value restrictions; `template<auto>` does not turn a runtime value into a template argument. A known `N` lets optimization specialize loops and storage, but does not guarantee unrolling.

**Template template parameters** are adjacent but distinct — a parameter that is itself a template:

```cpp
template <template <class...> class Container, class T>
Container<T> make_container(std::initializer_list<T> il) { return Container<T>(il); }
```
Template-template parameter matching has exact language rules for compatible parameter lists. In application interfaces, deducing a complete container type and constraining the operations it must provide is often less coupled to a particular template signature.

---

## 17.11 SFINAE and the Detection Idiom — Deep dive

Substitution Failure Is Not An Error: when substituting deduced or explicit arguments into a function template's declaration (signature, return type, defaults) is ill-formed, that candidate is silently dropped instead of erroring. Only the **immediate context** counts — an error deeper inside an instantiated body is a hard error, not a substitution failure:

```cpp
template <class T> typename T::type f(T);              // SFINAE-friendly: immediate context
template <class T> void g(T) { typename T::type x; }   // NOT — hard error on instantiation
```

```cpp
// enable_if idiom
template <class T> std::enable_if_t<std::is_integral_v<T>, T> f(T);                  // return type
template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0> void g(T);      // template parameter
```
The template-parameter form works for constructors, which have no return type. A common failure is writing two declarations that differ only in a default template argument: defaults are not part of a function-template signature, so that can be a redefinition rather than two overloads. Make the constraint affect a signature component correctly, or use concepts.

`if constexpr` (§17.12) branches inside one selected specialization but cannot remove an overload candidate, so it cannot resolve ambiguity or change whether that declaration is invocable. Concepts are the clearer C++20/C++23 interface tool; SFINAE remains relevant when reading older code and implementing compatibility layers.

### `void_t` and expression SFINAE

```cpp
template <class T>
auto size(const T& c) -> decltype(c.size()) { return c.size(); }   // valid only if c.size() compiles
```
`decltype` in a trailing return type puts an expression in the immediate context — the foundation of the detection idiom. `std::void_t<Ts...>` (C++17) is `template <class...> using void_t = void;`; its power is that substituting into its arguments can fail, and that failure is in the immediate context of a partial specialization:

```cpp
template <class T, class = void>
struct has_reserve : std::false_type {};
template <class T>
struct has_reserve<T, std::void_t<
    decltype(std::declval<T&>().reserve(std::size_t{}))>>
    : std::true_type {};
```
If `T::reserve(size_t)` doesn't exist, the partial specialization's argument list is ill-formed and drops out, leaving the `false_type` primary.

Concepts express the same check as a named interface condition and participate in subsumption:

```cpp
template <class T>
concept HasReserve = requires (T& t, std::size_t n) { t.reserve(n); };
```
Both idioms are duck-typed: they check that an expression compiles, not that it does anything sane. Named semantic concepts (`std::regular`, `std::sized_sentinel_for`) document additional requirements the compiler does not enforce.

---

## 17.12 Tag Dispatch and `if constexpr` — Deep dive

**Tag dispatch** selects an overload by passing an extra argument whose type encodes a compile-time property, letting ordinary overload resolution branch:

```cpp
template <class It>
void advance_impl(It& i, std::ptrdiff_t n,
                  std::random_access_iterator_tag) { i += n; }
template <class It>
void advance_impl(It& i, std::ptrdiff_t n,
                  std::input_iterator_tag) {
    while (n > 0) { ++i; --n; }
}

template <class It>
void advance(It& i, std::ptrdiff_t n) {
    advance_impl(i, n, typename std::iterator_traits<It>::iterator_category{});
}
```
Iterator category tags form an inheritance hierarchy, so ordinary conversion ranking orders helper overloads: a random-access tag matches its overload exactly and an input-tag overload through a base conversion.

| Mechanism | Overload participation | Selection mechanism | Main limitation |
|---|---|---|---|
| Tag dispatch | Helper overloads remain candidates | Ordinary conversion ranking | Requires tag plumbing and lookup design |
| `enable_if` SFINAE | Failed substitution removes candidate | Overload resolution | Indirect syntax and implementation-dependent diagnostics |
| `if constexpr` | Does not remove enclosing candidate | Constant condition inside selected function | Closed branches; cannot repair overload ambiguity |
| Concepts | Unsatisfied constraint removes candidate | Constraints plus subsumption | Atomic-constraint identity can surprise |

Tag dispatch remains useful when an unqualified helper and ADL deliberately form an open customization set, or when a tag such as `std::in_place_t` disambiguates an operation. Concepts constrain whether an interface participates; `if constexpr` selects valid implementation code after that interface has already been chosen.

### `if constexpr` mechanics

`if constexpr (cond)` selects a compile-time branch. In a templated entity whose condition remains value-dependent, the unchosen statement is not instantiated for that specialization, so it may contain dependent code that is invalid for that specialization's type.

```cpp
template <class T>
std::string to_text(const T& v) {
    if constexpr (std::is_arithmetic_v<T>)           return std::to_string(v);
    else if constexpr (requires { v.to_string(); })  return v.to_string();
    else                                             return std::string(v);
}
```

- The condition must be a constant expression contextually convertible to `bool`.
- Outside a template, both substatements must be well-formed even when one is discarded. Inside a template, non-dependent errors are still checked at definition; only specialization-dependent invalidity is protected by discarding.
- C++23 implementations incorporating CWG2518 permit `static_assert(false)` in a branch discarded for every instantiated specialization. Older modes/toolchains may need a dependent-false helper.
- A template with deduced `auto` return type can return different types from mutually discarded branches because only the selected return statements participate for that specialization.
- It does not remove a candidate from an overload set, cannot resolve ambiguity, cannot affect `std::is_invocable_v`, and is not an open extension point.
- The selected specialization does not require runtime selection between branches. Compile-time and generated-code effects still depend on the bodies and implementation.

Chapter 19 covers `if consteval` and constant evaluation; it is a different question from type-based template dispatch.

---

## 17.13 Expression Templates — Role-specific / Deep dive

This section is skippable unless the role uses numeric/domain-specific libraries. An expression template builds a type representing an expression tree and defers evaluation until a consumer materializes the result.

```cpp
Vector a, b, c, d, result;
result = a + b + c + d; // naive eager operators may create three temporaries
```

```cpp
// Conceptual sketch: ownership, concepts, size checks, and alias handling omitted.
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
The expression's type encodes its tree. In this sketch, lightweight nodes themselves do not allocate, and assignment can evaluate one fused element loop. Whether that beats eager temporaries depends on optimizer visibility, destination allocation, vectorization, cache residency, and memory bandwidth; Chapter 29 covers numeric-kernel measurement.

**Lifetime is the first correctness boundary.** Nodes above hold references. `auto expr = a + b;` remains valid only while both operands live; `auto expr = a + Vector{...};` dangles after the initializer's full expression. A production design can own rvalue operands and reference lvalues, forbid storage/rvalues, or eagerly materialize. `auto` is not itself wrong—it exposes the lazy node type whose lifetime contract must be understood.

Expression depth also creates distinct types and larger diagnostics. In debug builds, uninlined accessor layers may be visible at runtime. Aliasing is separate: if the destination also appears in an expression whose element `i` depends on other destination elements, element-by-element assignment can overwrite data before it is read. Detect aliasing or materialize a temporary. Chapter 14 covers range views rather than repeating their lifetime model here.

---

## 17.14 Explicit Instantiation and Build Tooling — Reference / Deep dive

An **explicit instantiation definition** requests instantiation in one translation unit:

```cpp
template class RingBuffer<Order>;                     // all members of the class
template void process<Order>(std::span<Order>);       // one function
```
An **explicit instantiation declaration** (`extern template`) suppresses an implicit instantiation that the translation unit would otherwise perform; one matching explicit definition must exist in the program when the specialization is required:

```cpp
extern template class RingBuffer<Order>;   // in the header
```

Without this arrangement, front ends may repeat instantiation work in each translation unit that uses the specialization. Object-file coalescing can remove duplicate emitted definitions later, but it cannot refund parsing and semantic-analysis time. Place the `extern template` declaration in the header seen by clients and one matching explicit instantiation definition in a source file that sees the template definition.

| Aspect | Possible effect and condition |
|---|---|
| Compile time | Less repeated instantiation work when many TUs use the same costly specialization |
| Object/link work | Fewer emitted copies before coalescing; impact depends on compiler/linker |
| Inlining | `extern template` does not hide a definition that remains in the header; moving the definition out of line can restrict inlining without LTO |
| Coupling | The instantiating TU must be linked in; a missing explicit instantiation is a link error |

At its point, an explicit instantiation definition of a class specialization also explicitly instantiates eligible non-template members whose definitions are visible and not previously explicitly specialized. That can expose an ill-formed member that lazy implicit instantiation never needed. Move the explicit-instantiation point before unrelated member definitions or instantiate selected members individually when appropriate.

Keeping a template definition in a `.cpp` and explicitly instantiating a finite supported set creates a closed type boundary: unsupported types fail to link or cannot instantiate. That is appropriate only when the supported set is deliberate and tested. Use the §17.9 trace/size workflow to verify the build benefit and a representative runtime benchmark to check that code-placement changes did not regress the hot path.

---

## 17.15 Recall and Practice — Core

### Recall card

- Template definitions are parsed and non-dependent constructs checked before instantiation; substitution and constraints govern candidate participation.
- Deduction uses specified adjustments and limited alternatives, not general promotions or user-defined conversions.
- `T&&` is a forwarding reference only when `T` is deduced by this call (or `auto&&`); any `&` in a collapsing pair wins.
- A named parameter is an lvalue expression; use `std::forward<T>` to preserve a forwarding reference's incoming category.
- Non-dependent names bind at definition; dependent names resolve at instantiation via definition-point lookup plus instantiation-point ADL — members of a dependent base need `this->`.
- Ordinary member definitions are instantiated when required; eager instantiation of an otherwise-unneeded virtual member is unspecified.
- A function-template specialization does not join the overload set; overload resolution selects a primary first.
- Concepts subsume by identity of atomic constraints, not by logical implication between traits — wrap traits in named, conjoined concepts to get ordering.
- A fold avoids recursive helper specializations, but the compiler still analyzes every expanded operand.
- In a template specialization, `if constexpr` can discard dependent invalid code; it does not remove the enclosing overload.

### Common traps

- Reporting the resulting parameter type (`int(&)[5]`) when asked for deduced `T` (`int[5]`).
- Calling every `T&&` an rvalue reference or forwarding with `std::move`.
- Assuming an alias template is always a non-deduced context, or trying to specialize an alias.
- Omitting `typename`, `template`, or `this->` for a genuinely dependent name.
- Defining a header variable template as plain `constexpr` and relying on disputed historical linkage behavior instead of `inline constexpr`.
- Copying logically equivalent trait expressions into constraints and expecting semantic subsumption.
- Placing a function parameter pack before a deduced suffix and expecting the prefix length to be inferred.
- Treating `_v` traits, concepts, folds, or templates in general as intrinsically cheaper without a trace and linked-size measurement.
- Adding `extern template` without one reachable explicit definition, or explicitly instantiating a class whose visible member definitions are invalid for that type.

### Questions

1. Why can a function template be overloaded but not partially specialized?
2. What can a class template do that an alias template cannot, and when can deduction still pass through an alias?
3. Which adjustments occur for by-value versus reference parameters, and why does `f(1, 2.0)` fail for `f(T, T)`?
4. What distinguishes a forwarding reference from an ordinary rvalue-reference parameter?
5. Why can an unconstrained `template <class T> Widget(T&&)` constructor win over the copy constructor for a non-const lvalue?
6. Why may an invalid virtual member body be diagnosed earlier than an unused ordinary member body, and what is portable guidance?
7. Why does a member of a dependent base require `this->`, and what does `using Base<T>::member;` do differently?
8. Why do `requires std::is_integral_v<T>` and `requires (std::is_integral_v<T> && std::is_signed_v<T>)` fail to subsume each other, and how do you fix it?
9. Why is a comma fold safer than a plain pack-expanded function call when the elements have side effects?
10. What can `if constexpr` not do that a removed-overload mechanism (SFINAE or a concept) can?

### Code-reading puzzle

```cpp
#include <iostream>

template <class T>
struct Base {
    virtual void go() { std::cout << "base\n"; }
    virtual ~Base() = default;
};

template <class T> struct Derived : Base<T> {
    void go() override { std::cout << "derived\n"; }
    void call() { go(); Base<T>::go(); this->go(); }
};

int main() {
    Derived<int>{}.call();
}
```

Predict the three output lines. Which two calls use virtual dispatch semantics, why is the qualified base call different, and why does unqualified `go()` not need `this->` here?

### Implementation exercise

Write `template <class T> concept Printable = requires (std::ostream& os, const T& t) { os << t; };` and a function `dump(const auto&... xs)` that prints each argument space-separated using a fold expression, constrained so it fails to compile — with a named-constraint diagnostic, not a wall of substitution errors — for any argument that isn't `Printable`. Then write the same dump function with `enable_if` instead of the concept and compare the two error messages by passing a non-printable type to each.

### Prerequisites for Chapter 18

Chapter 18 assumes you can deduce a forwarding-reference parameter, apply reference collapsing, recognize a non-deduced context, and read constraints on a callable. Chapter 6 covers type erasure; Chapter 18 applies these template rules to closure types without repeating deduction.
