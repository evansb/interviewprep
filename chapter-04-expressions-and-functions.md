# Chapter 4 — Expressions and Functions

*Interview-focused revision notes. The theme: an expression is not just a value — it has a category, a sequencing relationship to its neighbours, and a set of rules deciding which function it calls. Every question in this chapter reduces to one of those three: what kind of thing is this, when does it happen relative to that, and which overload wins.*

---

## 4.1 Value Categories

Every expression in C++ has two independent properties: a **type** and a **value category**. The category answers two questions — *does this expression have identity (a stable address you could take)?* and *can it be moved from (is its resource safe to steal)?*

```
              has identity?
                yes        no
        ┌───────────────┬──────────────┐
moveable│    xvalue     │   prvalue    │   ← together: rvalue
   yes  │               │              │
        ├───────────────┼──────────────┤
    no  │    lvalue     │  (not used)  │
        └───────────────┴──────────────┘
        └─── glvalue ───┘
```

- **lvalue** — has identity, cannot be implicitly moved from. Named variables, `*p`, `a[i]`, a function call returning `T&`, string literals.
- **prvalue** ("pure rvalue") — no identity, moveable. Literals (except string literals), `a + b`, a call returning `T` by value, `T{}`, a lambda expression.
- **xvalue** ("expiring value") — has identity, moveable. `std::move(x)`, a call returning `T&&`, `a[i]` on an rvalue array, member access on an xvalue.
- **glvalue** = lvalue ∪ xvalue (things with identity). **rvalue** = prvalue ∪ xvalue (things you may move from).

The single most useful reframing: **a prvalue is not an object.** Since C++17 a prvalue is an *initializer* — a recipe for producing an object — and no object exists until the prvalue is **materialized** (Ch. 5 §5.7). This is what made guaranteed copy elision work: `T x = T(T(T()));` involves exactly one object because the nested prvalues never produce temporaries to elide.

### Traps and named-rvalue confusion

```cpp
void sink(std::string&& s) {
    consume(s);              // s is an LVALUE here — its type is rvalue-ref, its category is lvalue
    consume(std::move(s));   // correct: converts to xvalue
}
```
**A named rvalue reference is an lvalue.** *Type* and *category* are orthogonal; the rule exists so a parameter isn't silently moved from twice. This is the most common value-category interview question and it catches experienced people.

`std::move` is a cast, nothing more: `static_cast<remove_reference_t<T>&&>(x)`. It moves nothing and emits no code. `std::forward<T>` is a conditional cast that preserves category (Ch. 17). `decltype` distinguishes categories: `decltype(x)` on a name gives the declared type; `decltype((x))` — with the extra parens, making it an expression — gives `T&` for an lvalue and `T&&` for an xvalue (Ch. 2 §2.17).

### Why it matters at the ABI level

Value category selects the overload, which selects whether a copy or a move happens, which for a `std::vector` member is the difference between a heap allocation plus a `memcpy` and three pointer assignments. On a hot path, an accidental lvalue where you meant an xvalue is a silent allocation. Prvalues under guaranteed elision are the only zero-cost case: the callee constructs directly into the caller's storage via the hidden return-slot pointer (§4.17), so there is no object to move at all.

Bit-fields, and *only* bit-fields, are lvalues whose address cannot be taken — a reminder that "lvalue" means *identity*, not *addressable* (Ch. 3 §3.4).

---

## 4.2 Expression Sequencing

**Sequencing** defines the ordering of *value computations* (working out what an expression denotes) and *side effects* (writes to objects, I/O, atomic ops). C++11 replaced the old "sequence point" model with a partial order:

- **A is sequenced-before B** — every effect of A completes before any effect of B starts.
- **A and B are indeterminately sequenced** — one precedes the other, but which is unspecified. They do not interleave.
- **A and B are unsequenced** — no ordering at all; they may interleave freely.

The critical rule: **if two side effects on the same scalar object are unsequenced, or a side effect is unsequenced relative to a value computation using that object, the behaviour is undefined.**

### What is guaranteed

| Construct | Guarantee |
|---|---|
| `;` (full expression) | Everything sequenced-before the next statement |
| `&&`, `\|\|` | Left operand fully sequenced-before right; short-circuits |
| `,` (comma operator) | Left sequenced-before right |
| `?:` | Condition sequenced-before the selected branch |
| `a[i]`, `a->b`, `a.b` | Postfix expression sequenced-before the subscript/member (C++17) |
| `<<` / `>>` (C++17) | Left sequenced-before right — makes `cout << f() << g()` ordered |
| `=`, `+=` (C++17) | **Right** operand sequenced-before left; assignment's side effect sequenced-after both |
| `new T(expr)` (C++17) | Allocation sequenced-before evaluation of the initializer |
| Function call | All argument evaluations **indeterminately sequenced** relative to each other; each is complete before the body runs |
| `+`, `-`, `*`, `<`, arbitrary binary ops | **Unsequenced** — operands may interleave |

C++17 (P0145) was a major cleanup: it ordered `a[i]`, member access, shifts, and assignment, and it made function-argument evaluation *indeterminately* sequenced rather than unsequenced, which means arguments can no longer interleave. That last change is what makes `f(make_unique<A>(), make_unique<B>())` leak-free in C++17 — before it, the compiler could allocate both raw pointers, then run both constructors, and a throw in the second leaked the first.

### The classic UB cases

```cpp
i = i++ + 1;        // UB pre-C++17; well-defined C++17 (RHS before LHS assignment)... 
                    // but i = ++i + i++; is still UB (two unsequenced modifications)
f(i++, i++);        // UNSPECIFIED order, and pre-C++17 UB; C++17: indeterminately sequenced,
                    // still UB — two modifications of i unsequenced w.r.t. each other? No:
                    // indeterminately sequenced means NOT unsequenced, so C++17 makes it
                    // unspecified-which-order but defined.
a[i] = i++;         // C++17: defined (RHS first). Pre-C++17: UB.
cout << i << i++;   // C++17: defined and ordered left-to-right.
```
The safe interview answer is not to recite which C++17 rescued — it's to say **write it as two statements**, because the reader can't know the standard version and the compiler will produce identical code. `-Wsequence-point` (GCC) and `-Wunsequenced` (Clang) catch the obvious cases; UBSan does not, because these are compile-time-detectable, not runtime.

---

## 4.3 Order of Evaluation

Sequencing (§4.2) is the formal machinery; *order of evaluation* is the practical consequence: which of several subexpressions the compiler actually runs first, and what you may rely on.

**Function arguments have unspecified evaluation order.** Not undefined — *unspecified*, meaning the implementation picks one of a set of valid orders and need not document or be consistent about it. In practice: GCC and Clang on x86-64 SysV evaluate **right-to-left** (arguments are pushed/assigned in reverse), MSVC also right-to-left, but this changes with inlining and is not a contract.

```cpp
log(next_seq(), next_seq());     // which sequence number lands in which parameter? Unspecified.
```
This bites in trading code where argument expressions have side effects: `send(alloc_id(), timestamp())` may record a timestamp *before* the id, or after.

### Chained calls

```cpp
obj.set_a(f()).set_b(g());   // C++17: obj.set_a(f()) fully sequenced-before .set_b(g())
                             // ...but f() and g() ordering relative to the OTHER call's object
                             // expression was the pre-C++17 hazard
```
C++17's "postfix expression sequenced-before arguments" rule is what makes fluent/builder interfaces and `std::cout` chains behave as written.

### Initializer lists

Braced-init-lists are the exception worth memorizing: **elements of a braced-init-list are evaluated strictly left-to-right**, sequenced.

```cpp
std::vector<int> v{f(), g()};       // f() before g() — GUARANTEED
foo(f(), g());                      // unspecified order
Widget w{f(), g()};                 // left-to-right — guaranteed
```
This is a genuine reason to prefer braces when argument expressions have side effects, and it is a good "non-obvious detail" answer.

### Why the freedom exists

Unspecified argument order lets the compiler schedule for register pressure and latency: it can evaluate the expensive, high-latency subexpression first so its result is ready while the cheap one computes, filling the pipeline (Ch. 27). Fixing the order would cost real performance in numeric code. The committee has repeatedly declined to specify it for exactly this reason, while fixing the cases (`new`, assignment, shifts, subscript) where the freedom bought nothing and caused bugs.

**Interview framing:** *"Is `f(i++, i++)` undefined or unspecified in C++17?"* — the modifications are indeterminately sequenced (each argument's evaluation is complete before the other starts), so it is no longer UB, but which value each parameter receives is unspecified. Pre-C++17 it was UB. Getting that distinction right signals precision.

---

## 4.4 Undefined, Unspecified, and Implementation-Defined Behavior

These three are conflated constantly; an interviewer will ask you to separate them.

| Category | Definition | Documented? | Can vary run to run? | Example |
|---|---|---|---|---|
| **Undefined (UB)** | No requirements at all. The standard imposes nothing on the entire program. | No | Yes — and retroactively | Signed overflow, null deref, OOB access, data race |
| **Unspecified** | The implementation picks from a set of valid behaviours. | No | Yes | Argument evaluation order, `<` on unrelated pointers, padding byte values |
| **Implementation-defined** | Unspecified, but the implementation **must document** its choice. | **Yes** | No | `sizeof(int)`, `char` signedness, right-shift of negative values (until C++20), `>>` on signed |
| **Erroneous (C++26)** | Well-defined-but-wrong: a specific incorrect value, diagnosable, no time travel. | Partially | Yes | Reading an uninitialized automatic variable (P2795) |
| **Ill-formed, NDR** | The program is invalid but the compiler need not diagnose it | — | — | ODR violations (Ch. 1 §1.6) |

### Why UB is worse than "unpredictable result"

The compiler is entitled to assume UB never happens, and it propagates that assumption **backwards through the program**:

```cpp
int f(int* p) {
    int x = *p;              // if p were null this would be UB...
    if (p == nullptr) return -1;   // ...so the compiler DELETES this check
    return x;
}
```
This is "time travel": the consequence appears *before* the offending operation, and code you wrote is silently removed. The canonical real-world instance is the Linux kernel's `tun_chr_poll` CVE-2009-1897, where exactly this deletion of a null check produced an exploitable bug. Similarly, a loop with signed-overflow UB may be assumed to terminate, and a function whose every path is UB may be compiled to nothing at all (Clang emits `ud2`).

The lesson to state: **UB is not "whatever the hardware does."** Reasoning about UB in terms of machine behaviour is the mistake; it is a contract violation with the optimizer.

### Tooling

- **UBSan** (`-fsanitize=undefined`) — runtime detection of overflow, misalignment, null deref, bad enum/bool values, OOB (with `-fsanitize=bounds`). ~20% slowdown; run it in CI, not production.
- **ASan** (`-fsanitize=address`) — heap/stack/global overflow, use-after-free, ~2× slowdown.
- **TSan** — data races (Ch. 25).
- **`-fwrapv`** makes signed overflow defined (two's complement wrap), and **`-ftrapv`** traps it. Both cost optimizations — `-fwrapv` in particular defeats loop-strength-reduction and some vectorization, because the compiler can no longer assume `i` doesn't wrap.
- **`-fno-strict-aliasing`, `-fno-delete-null-pointer-checks`** — what the kernel uses to disable specific UB-based optimizations wholesale.

**Low-latency angle:** signed loop counters are *faster* than unsigned ones precisely because signed overflow is UB, so the compiler can promote a 32-bit induction variable to 64-bit without emitting wraparound handling. `for (int i = 0; i < n; ++i)` vectorizes where `for (unsigned i = ...)` may not. That is a real, measurable, counterintuitive answer.

---

## 4.5 Common Sources of Undefined Behavior

A checklist worth having ordered by how often it actually appears in production C++:

**Memory and lifetime**
- Use-after-free, use-after-move-then-read-of-unspecified-state (the latter is *not* UB — moved-from standard types are valid but unspecified; reading them is legal, assuming a particular value is a bug).
- Dangling references: returning a reference to a local, a `string_view` into a temporary (Ch. 13), a lambda capturing by reference and outliving the capture (Ch. 18).
- Out-of-bounds access, including `v[v.size()]` and `&v[0]` on an empty vector (`v.data()` is the fix).
- Deleting through a base pointer without a virtual destructor (Ch. 6 §6.13).
- Mismatched `new`/`delete[]`, `malloc`/`delete`.

**Arithmetic**
- **Signed integer overflow** (Ch. 2 §2.4). Unsigned wraps — defined.
- Division by zero, and `INT_MIN / -1` (overflows the quotient; on x86 raises `#DE` and crashes).
- Shift by ≥ width, or by a negative amount. `x << 32` for 32-bit `x` is UB, and x86's shift instructions mask the count to 5 bits so it silently yields `x`.
- Conversion of an out-of-range floating value to an integer type.

**Pointers and types**
- Strict-aliasing violations (Ch. 3 §3.8), misaligned access (Ch. 3 §3.3), null dereference — *including* `memcpy(nullptr, nullptr, 0)`, which is UB despite the zero length.
- Pointer arithmetic outside an array (Ch. 3 §3.10).
- Reading an inactive union member (Ch. 5 §5.13), outside the common initial sequence.
- Reading an indeterminate value (Ch. 3 §3.2) — erroneous, not UB, in C++26.

**Control and initialization**
- Falling off the end of a value-returning function. The compiler may assume the path is unreachable and delete the branch leading to it; Clang emits nothing and execution runs into the next function. `-Wreturn-type` should be an error in every build.
- Infinite loop with no side effects (C++11–C++23: UB because the compiler may assume forward progress; a `while(1){}` spin loop needs an atomic or a volatile read, or `std::this_thread::yield`). This surprises people writing spin waits.
- Recursion depth exceeding the stack — not formally UB-by-name but unbounded in effect.
- Static initialization order fiasco (Ch. 5 §5.10) — unspecified order, UB if you read an unconstructed object.

**Concurrency**
- Any data race (Ch. 25 §25.1). Two unsynchronized accesses, at least one a write.
- Recursive locking of a non-recursive mutex, unlocking a mutex you don't own.

**Library contract violations**
- Passing an invalid iterator, invalidated by a prior mutation (Ch. 11 §11.8).
- Calling `.front()`/`.back()`/`.top()` on an empty container.
- Violating a comparator's strict-weak-ordering requirement — `std::sort` with a bad comparator reads out of bounds and corrupts memory, not merely producing a wrong order. This is a favourite question: *why does an invalid comparator crash rather than misorder?* Because libstdc++'s introsort omits a bounds check in the partition inner loop, relying on the sentinel property that a valid ordering guarantees.

The strong-candidate framing: UB clusters into *lifetime*, *bounds*, *arithmetic*, *aliasing*, and *concurrency*, and each has a corresponding sanitizer. Naming the sanitizer for each class is worth as much as listing the cases.

---

## 4.6 Function Overload Resolution

Overload resolution runs in three phases, and confusing them is the source of most "why did it pick *that*?" surprises.

```
1. Name lookup      → assemble candidate set (ordinary lookup + ADL §4.7)
2. Viability filter → discard candidates whose parameters can't be initialized
                      from the arguments, or whose constraints fail (C++20)
3. Best match       → rank the viable ones by conversion sequence
```

**Name lookup happens first and is not influenced by the arguments' suitability.** If a derived class declares *any* function named `f`, it hides *all* base-class `f`s regardless of signature — the base overloads are never in the candidate set. `using Base::f;` reintroduces them. Same for an inner-scope declaration hiding an outer one.

### Ranking conversion sequences

Each argument gets an implicit conversion sequence, ranked:

| Rank | Category | Examples |
|---|---|---|
| 1 | **Exact match** | Identity, lvalue-to-rvalue, array/function-to-pointer decay, qualification conversion (`T*`→`const T*`) |
| 2 | **Promotion** | `char`/`short`→`int`, `float`→`double`, unscoped enum→underlying (Ch. 2 §2.2) |
| 3 | **Conversion** | Any other standard conversion: `int`→`double`, `int`→`bool`, `Derived*`→`Base*`, `T*`→`void*`, pointer-to-bool |
| 4 | **User-defined conversion** | One converting constructor **or** one conversion operator — never two chained |
| 5 | **Ellipsis** | `...` — always worst |

A candidate wins only if it is **no worse for every argument and strictly better for at least one**. If no candidate satisfies that, the call is **ambiguous** — a hard error, not a coin flip.

```cpp
void f(int);
void f(double);
f(3.0f);     // float→double is a promotion (rank 2); float→int is a conversion (rank 3) → f(double)
f('a');      // char→int is a promotion → f(int)
f(3u);       // unsigned→int and unsigned→double are BOTH rank-3 conversions → AMBIGUOUS
```
That third line is the classic trap and worth being able to produce on demand.

### Tie-breakers, in order

1. Better conversion sequence for some argument (above).
2. **Non-template beats template specialization.** `template<class T> void g(T);` loses to `void g(int);` for `g(1)`.
3. **More specialized template wins** (partial ordering of function templates): `g(T*)` beats `g(T)`.
4. For constrained functions (C++20), **more-constrained wins** via subsumption (Ch. 17 §17.14).
5. Non-`explicit` constructors only, in copy-initialization contexts.

### Details that separate candidates

- **Return type is not part of overload resolution.** You cannot overload on it. (Except via a conversion-operator-returning proxy, the `end()`-sentinel trick, or `auto`-deduced return in a template.)
- **`const`/ref-qualifiers on the implicit object parameter participate**: `f() &`, `f() &&`, `f() const` are ranked like any other argument (Ch. 6 §6.7). This is how `optional::value() &&` can return `T&&`.
- **A perfect-forwarding constructor `template<class T> Widget(T&&)` beats the copy constructor** for a non-const lvalue `Widget`, because `T&&` deduces `Widget&` (exact match) while the copy ctor needs a qualification conversion to `const Widget&`. This is the single most notorious overload bug in modern C++, fixed by constraining with `requires !std::same_as<std::remove_cvref_t<T>, Widget>` or `enable_if`.
- **`0` is both an int and a null-pointer constant** — `f(int)` vs `f(char*)` with `f(0)` is ambiguous in spirit and resolved to `f(int)` in practice; `nullptr` (Ch. 2 §2.11) exists to kill this.
- **`long` vs `long long` vs `size_t`** overloads produce endless ambiguity in 64-bit code because `size_t` is `unsigned long` on LP64 but `unsigned long long` on Windows.

**Debug tooling:** `-fverbose-asm` won't help; the practical technique is to induce a deliberate error (call with a `struct{}` argument) so the compiler prints the full candidate set with rejection reasons, or use `-Wconversion` and Compiler Explorer.

---

## 4.7 Argument-Dependent Lookup

**ADL** (Koenig lookup) says: for an unqualified function call, the candidate set includes not only names found by ordinary lookup, but also names in the **associated namespaces** of the argument types.

```cpp
namespace lib { struct S{}; void f(S); }
lib::S s;
f(s);          // finds lib::f via ADL — no using-directive, no qualification
```

**Associated entities** of a type include: its own namespace; for a class, its base classes' namespaces and the namespaces of its template arguments; for enums, the enclosing namespace; for pointers/arrays, those of the pointee. Note `std::vector<MyType>` associates both `std` and `MyType`'s namespace.

### Why it exists

Without ADL, `a + b` for a user-defined type would require the operator to be in scope or qualified — and you cannot qualify an operator in infix form. `std::cout << x` works only because ADL finds `operator<<` in `std`. Every operator overload in existence depends on ADL.

### The `std::swap` two-step

```cpp
template <class T> void algo(T& a, T& b) {
    using std::swap;   // brings std::swap into scope as a FALLBACK
    swap(a, b);        // unqualified → ADL finds a better user swap if one exists
}
```
Writing `std::swap(a, b)` qualified *disables* ADL and forces the generic version, which for a type with an efficient custom swap is a real performance loss. This idiom generalizes to `begin`/`end`/`size` and is the pre-C++20 answer; **C++20 CPOs** (`std::ranges::swap`, `std::ranges::begin`) encapsulate the two-step so users can't get it wrong — a customization point object is a function *object*, so it is not itself found by ADL and cannot be hijacked.

### Hidden friends

Declaring an operator as a `friend` *defined inside* the class makes it findable **only** by ADL:

```cpp
struct Money {
    friend Money operator+(Money, Money) { /*...*/ }   // hidden friend
};
```
It is invisible to ordinary lookup, so it never pollutes the overload set for unrelated calls. Benefits: dramatically smaller candidate sets (a real **compile-time** win in template-heavy code), no accidental matches via implicit conversions, and no ambiguity with other namespaces' operators. This is the modern recommended way to write operators and a strong signal in an interview.

### Failure modes

- **Unexpected hijacking:** an argument in namespace `N` drags all of `N`'s overloads into consideration. Adding a function to your namespace can break distant code.
- **ADL does not apply** when ordinary lookup finds a class member, a variable, or a block-scope function declaration — the whole ADL step is disabled if ordinary lookup finds a non-function or a class member.
- **Fundamental types have no associated namespaces**, so `f(1)` never uses ADL.
- **`std::` overloads for standard types** are why `swap(v1, v2)` on vectors works unqualified.

---

## 4.8 Default Arguments

A default argument supplies a value when the caller omits a trailing parameter. The substitution happens **at the call site, at compile time**, using the declaration visible there.

```cpp
void f(int a, int b = 10, int c = a);   // ERROR: c = a — parameters are not in scope as values
void g(int a = 1, int b);               // ERROR: defaults must be trailing
```

### The rules that matter

- **Defaults are per-declaration, not per-function**, and accumulate across declarations in a scope:
  ```cpp
  void f(int a, int b);
  void f(int a, int b = 5);   // legal — adds a default
  ```
  Different translation units can see different defaults for the same function. This is an **ODR-adjacent hazard**: the header declares `f(int = 1)`, a `.cpp` redeclares `f(int = 2)`, and calls in different TUs pass different values with no diagnostic (Ch. 1 §1.6).

- **Default arguments are evaluated at each call**, in the caller's context, so `void log(Time t = now())` calls `now()` per call — usually what you want, and a common source of confusion with Python's evaluate-once semantics.

- **Virtual functions use the STATIC type's default.** This is the big one:
  ```cpp
  struct B { virtual void f(int x = 1) { print(x); } };
  struct D : B { void f(int x = 2) override { print(x); } };
  B* p = new D;  p->f();     // calls D::f but prints 1 — B's default
  ```
  The vtable dispatches the *body*; the default comes from the static type at the call site. **Never give a virtual function a default argument.** Clang-tidy flags this.

- **Defaults are not part of the function type**, so a function pointer to `void f(int = 1)` has type `void(*)(int)` and calling through it requires the argument.

- **Access control still applies:** a default argument that names a private member is checked at the call site.

### Default arguments versus overloads

| | Default arguments | Overloads |
|---|---|---|
| Binary size | One function | One per signature — template-instantiation-like bloat |
| Address-taking | Single address, full arity | Distinct addresses |
| Virtual | Broken (static-type default) | Works |
| Differing behaviour per arity | Cannot | Can |
| ABI stability | **Adding a default is source-compatible but callers bake the value in** — changing it requires recompiling every caller | Adding an overload is ABI-additive |

That last row is the low-latency/library answer: **a default argument's value is part of the caller's code**, so a shipped `.so` that changes a default silently keeps the old behaviour for un-recompiled clients. Libraries with strict ABI policies (Qt, Abseil) prefer overloads.

---

## 4.9 Function Pointers

A function pointer stores a code address. Its type includes the full signature; there is no decay to `void*` (formally — POSIX requires `dlsym`'s round-trip to work, which is a documented extension).

```cpp
int  add(int, int);
int (*fp)(int, int) = add;   // & is optional — function-to-pointer decay (Ch. 2 §2.15)
int  r = fp(1, 2);           // * is optional too
using Fn = int(*)(int, int);
```
Read declarations "inside-out from the identifier": `int (*f)(int)` is *f is a pointer to a function taking int returning int*; `int *f(int)` is *f is a function returning int\**. `cdecl` and C++11 alias templates (`using Fn = int(*)(int);`) exist because the syntax is genuinely bad.

**`noexcept` is part of the type since C++17.** `void(*)() noexcept` converts to `void(*)()` but not the reverse. This broke code that stored `noexcept` callbacks in non-`noexcept`-typed tables.

### Performance: the indirect-call cost

An indirect call must resolve its target before the front end can fetch the next instructions. The CPU predicts it via the **BTB** (branch target buffer) / indirect-branch predictor:

- **Monomorphic call site** (same target every time) — predicted correctly, cost ≈ a direct call, maybe 1–2 cycles extra.
- **Polymorphic, alternating targets** — mispredict, ~15–20 cycle pipeline flush (Ch. 27 §27.11) plus a likely I-cache miss at the new target.
- **Never inlined** unless the compiler can prove the target (constant propagation, devirtualization, or LTO). This is the true cost: not the indirect jump but the **lost inlining** and therefore lost constant folding across the boundary.

The low-latency conclusions: prefer templates/`if constexpr` for compile-time-known dispatch (Ch. 17); if you must dispatch at runtime, sort work by handler so each call site stays monomorphic (a batching win); consider a `switch` over a small enum, which compiles to a jump table but with a *predictable* index pattern, or to a branch tree the predictor handles better. Speculative-execution mitigations (retpolines, IBRS — Ch. 27 §27.18) make indirect calls dramatically more expensive on affected kernels/builds, sometimes 30+ cycles; that is a genuinely non-obvious detail.

Function pointers are trivially copyable and register-passable, unlike `std::function` (§4.11) — which is why C callback APIs use `(void* ctx, fn)` pairs.

---

## 4.10 Pointers to Members

A pointer to member is **not an address** — it is an *offset* (for data members) or a dispatch recipe (for member functions). It must be combined with an object.

```cpp
struct S { int a; int b; void f(int); };

int  S::*pd = &S::b;        // pointer to data member
void (S::*pf)(int) = &S::f; // pointer to member function

S s; S* ps = &s;
s.*pd  = 1;                 //  .*  on an object
ps->*pf(3);                 // WRONG — precedence!
(ps->*pf)(3);               // correct: ->* binds looser than ()
```
`.*` and `->*` are the lowest-precedence operators most people never use, hence the mandatory parentheses.

### Representation and cost

| Kind | Typical Itanium ABI representation | Size (x86-64) |
|---|---|---|
| Data member pointer | byte offset, `-1` for null | 8 bytes |
| Non-virtual member function | code address + `this`-adjustment | 16 bytes |
| Virtual member function | vtable index (odd-tagged ptr) + adjustment | 16 bytes |
| Under multiple inheritance | same 16 bytes, adjustment non-zero | 16 |
| MSVC, unknown class (incomplete type) | up to **24 bytes** — MSVC sizes them by inheritance model | varies |

Key facts: a pointer-to-member-function is **twice the size of a normal function pointer**, and calling through one emits a runtime test ("is this virtual?") on the low bit under the Itanium ABI — a branch plus a possible vtable load. That is why they are essentially absent from hot paths. MSVC's `/vmg`, `/vmb` flags change the representation and are an ABI landmine when an incomplete type is used.

**`&S::f` requires the `&` and the qualified name** — unlike free functions, there is no decay, and `S::f` alone is ill-formed.

### Where they earn their keep

- **`std::invoke` and `std::bind`** normalize member-pointer calls (§4.11).
- **Projections in C++20 ranges**: `std::ranges::sort(v, {}, &Order::price)` — the member pointer is a projection, and because it's a compile-time constant the compiler inlines it to an offset load. This is the modern, zero-cost use.
- **Compile-time reflection substitutes** — building serialization tables from `&S::field` lists.
- **Member offsets without `offsetof`** for non-standard-layout types (Ch. 3 §3.11), though this is nonportable.

Pointers to members convert **upward is backwards**: a `Base::*` converts *to* a `Derived::*` (safe: a Derived contains a Base subobject), not the other way. This inverted-variance rule is a nice question.

---

## 4.11 Callable Wrappers and `std::invoke`

A **Callable** is anything usable with `f(args...)` — function pointers, function references, lambdas, objects with `operator()`, and member pointers. The last of these has a *different call syntax*, and that inconsistency is what `std::invoke` exists to erase.

**INVOKE semantics** (`std::invoke`, C++17, `constexpr` since C++20):

```cpp
std::invoke(f, args...);            // f(args...)
std::invoke(&S::mem_fn, obj, a);    // obj.mem_fn(a)
std::invoke(&S::mem_fn, ptr, a);    // ptr->mem_fn(a)
std::invoke(&S::mem_fn, ref_wrap,a);// ref_wrap.get().mem_fn(a)
std::invoke(&S::data, obj);         // obj.data
```
This is the rule that `std::thread`, `std::bind`, `std::function`, `std::async`, and every algorithm taking a callable already used since C++11 — `invoke` just exposed it. `std::invoke_result_t<F, Args...>` and `std::is_invocable_v<F, Args...>` are the corresponding traits (replacing the removed `result_of`).

C++23 adds **`std::invoke_r<R>`** (explicit return type, for discarding or converting) and **`std::bind_back`**; C++20 added `std::bind_front`.

### The wrapper hierarchy

| Type | Owns? | Type-erased? | Allocates? | Call cost | Since |
|---|---|---|---|---|---|
| Function pointer | no | no | no | indirect call | — |
| Lambda / functor | n/a | no | no | **inlined** when the type is known | C++11 |
| **`std::function<R(A)>`** | yes (copies) | yes | **maybe** (SOO for small, else heap) | indirect call + possible cache miss | C++11 |
| **`std::move_only_function`** | yes | yes | maybe | same, no copy requirement | **C++23** |
| **`std::copyable_function`** | yes | yes | maybe | same, correct const-propagation | **C++26** |
| **`std::function_ref<R(A)>`** | **no** | yes | **never** | one indirect call, 2 pointers | **C++26** |
| `std::reference_wrapper` | no | no | no | free | C++11 |

`std::function`'s three costs, in order of importance for low latency:
1. **Type erasure defeats inlining** — the call is always indirect (§4.9).
2. **Heap allocation** if the callable exceeds the small-object buffer (typically 16 bytes in libstdc++, 24 in libc++ — enough for *two* captured pointers in libstdc++, so capturing `this` plus one more thing may allocate). Ch. 18 §18.10.
3. **Extra indirection / cache miss** to reach the heap-stored callable, plus a virtual-ish dispatch through the manager pointer.

Also: `std::function` requires the callable to be **copy-constructible** — which is why you cannot store a lambda capturing `unique_ptr` in one, and why `move_only_function` was added. And `std::function::operator()` is `const` but invokes a non-const callable — a const-correctness hole `copyable_function` fixes.

**Rule of thumb:** on a hot path, take callables as a **template parameter** (`template<class F> void for_each(F&&)`) so they inline; use `function_ref`/`std::function` only at genuine type-erasure boundaries (plugin registries, deferred work queues), and preallocate. For stored callbacks in a trading engine, a `void(*)(void*)` + context pointer pair, or a fixed-size inline-storage delegate, is the standard hand-rolled answer.

---

## 4.12 Compile-Time Function Evaluation

Moving work from run time to compile time is free latency, and the ladder of facilities has grown steadily.

| Keyword | Meaning | Since |
|---|---|---|
| `const` | Immutable; *may* be a constant expression if initialized by one | — |
| **`constexpr` (variable)** | Must be usable in a constant expression; initialized at compile time | C++11 |
| **`constexpr` (function)** | *May* run at compile time if arguments permit; otherwise runs at runtime | C++11 |
| **`consteval`** | **Immediate function** — must produce a constant; calling it at runtime is an error | C++20 |
| **`constinit`** | Guarantees **constant initialization** (no dynamic init) without implying `const` | C++20 |
| `if consteval` | Branch on whether we're in a constant evaluation | C++23 |
| `std::is_constant_evaluated()` | Same, as a function (careful: always true inside `if constexpr`) | C++20 |

`constexpr` on a function is a **permission, not an obligation**. `constexpr int f(int n)` called with a runtime `n` simply runs at runtime. To *force* compile-time evaluation, assign to a `constexpr` variable, use it as a template argument, or make it `consteval`.

### Evolution of what's allowed

- **C++11**: a single `return` statement. Painfully restrictive; everything was recursive.
- **C++14**: loops, local variables, multiple statements, mutation of locals. The version that made `constexpr` usable.
- **C++17**: `if constexpr`, `constexpr` lambdas, `constexpr` on static member functions implied for `inline`.
- **C++20**: `try`/`catch` (may not throw), virtual calls, dynamic allocation **that is freed within the same evaluation** (transient allocation), `std::vector` and `std::string` usable at compile time (libstdc++ 12+), `constexpr` destructors, `union` active-member switching.
- **C++23**: `static constexpr` in constexpr functions, non-literal variables in constexpr functions if not evaluated, relaxed `goto`/label rules, `constexpr` `std::unique_ptr` (C++23), and `if consteval`.
- **C++26**: `constexpr` exceptions that actually propagate, `constexpr` placement new, static reflection (Ch. 19 §19.14).

Still forbidden everywhere: `reinterpret_cast`, `goto` (until C++23), reading uninitialized memory, undefined behaviour of any kind (**UB is a hard compile error in a constant expression** — which makes `constexpr` a UB detector: `static_assert(f(x) == y)` will fail to compile on signed overflow).

### The low-latency uses

- **Lookup tables built at compile time** — a `constexpr std::array<uint8_t, 256>` CRC or decode table lands in `.rodata`, costs zero startup time, and avoids the static-initialization-order fiasco entirely (Ch. 5 §5.10).
- **Compile-time parsing of protocol schemas / format strings** — `std::format`'s C++20 compile-time format-string checking is `consteval` machinery.
- **`constinit`** on globals guarantees no dynamic initializer runs, which means no guard variable, no thread-safe-statics lock, and no init-order dependency. In a latency-sensitive daemon this is the correct annotation for every non-trivial global.
- **Compile-time hashing** of symbol strings to integer IDs, so the hot path compares integers.

**Cost:** compile-time evaluation is interpreted by the compiler's constant evaluator and is *slow* — orders of magnitude slower than the generated code. Heavy `constexpr` work is a real build-time regression (Ch. 44), and `-fconstexpr-ops-limit` / `-fconstexpr-steps` exist because evaluators bail out.

---

## 4.13 Standard Attributes

Attributes carry information to the compiler without changing the language's semantics — with two exceptions (`[[noreturn]]`, `[[carries_dependency]]`) that genuinely do.

| Attribute | Effect | Since |
|---|---|---|
| `[[noreturn]]` | Function never returns; caller's post-call code is unreachable. Enables better codegen and silences warnings. **Returning anyway is UB.** | C++11 |
| `[[deprecated("msg")]]` | Warning on use | C++14 |
| `[[fallthrough]]` | Suppresses the implicit-fallthrough warning in a `switch` | C++17 |
| `[[nodiscard]]` / `[[nodiscard("why")]]` | Warn if the return value is discarded. Apply to `empty()`, factory functions, `expected`, and anything whose ignored result is a bug. | C++17 / C++20 |
| `[[maybe_unused]]` | Suppresses unused warnings (parameters, NDEBUG-only variables) | C++17 |
| `[[likely]]` / `[[unlikely]]` | Branch-probability hint on a statement or label | **C++20** |
| `[[no_unique_address]]` | Empty members may occupy zero bytes (Ch. 3 §3.4) | C++20 |
| `[[assume(expr)]]` | The compiler may assume `expr`; false ⇒ UB | **C++23** |
| `[[indeterminate]]` | Opts a variable out of C++26 erroneous-behaviour zeroing | C++26 |

Unknown attributes must be **ignored** (not an error) since C++17, which is what makes vendor attributes (`[[gnu::...]]`, `[[clang::...]]`, `[[msvc::...]]`) portable to write.

### `[[likely]]`/`[[unlikely]]` — the low-latency detail

```cpp
if (rc != 0) [[unlikely]] { handle_error(); }
```
These do **not** change branch *prediction* — the hardware predictor learns from runtime behaviour and ignores your annotation. What they change is **code layout**: the compiler moves the unlikely block out of line (to a cold section, `.text.unlikely`), so the hot path is contiguous. The win is **instruction-cache density and front-end bandwidth**, not prediction (Ch. 27 §27.15, Ch. 41 §41.17). Overusing them makes things worse; PGO (Ch. 40 §40.9) measures the truth and beats hand annotation nearly always. GCC's older `__builtin_expect` / `__builtin_expect_with_probability` are equivalent, and `likely()`/`unlikely()` macros in the kernel are the same idea.

`[[assume(x)]]` is the sharpest tool here: it lets you assert alignment, ranges, or non-nullness so the compiler drops checks and vectorizes. It is also the easiest way to introduce silent UB — an assumption that is ever false poisons the whole function. Prefer `std::assume_aligned` and `__builtin_unreachable()`-with-a-checked-assert-in-debug patterns. Note `[[assume]]` must not have side effects; the expression is *not evaluated*.

`[[nodiscard]]` deserves emphasis for error-code-based designs (Ch. 10 §10.9): marking `std::expected`-returning functions `[[nodiscard]]` converts a whole class of silently-ignored-error bugs into compile warnings.

---

## 4.14 Return-Type Deduction

Three distinct mechanisms, frequently conflated.

**1. Trailing return type (C++11)** — moves the return type after the parameters so it can name them:
```cpp
template <class T, class U>
auto add(T t, U u) -> decltype(t + u);       // parameters are in scope here
```

**2. `auto` return-type deduction (C++14)** — deduce from the `return` statements, using **template argument deduction rules**, which means `auto` **strips references and top-level cv**:
```cpp
auto f() { static int x; return x; }       // returns int  — copies!
auto& g() { static int x; return x; }      // returns int&
decltype(auto) h() { static int x; return x; }   // int (name → declared type)
decltype(auto) k() { static int x; return (x); } // int&  — parens make it an expression!
```

**3. `decltype(auto)` (C++14)** — deduce using `decltype` rules, which *preserve* reference-ness and are sensitive to parentheses (Ch. 2 §2.17). This is the tool for perfect-forwarding wrappers:
```cpp
template <class F, class... A>
decltype(auto) timed(F&& f, A&&... a) {
    ScopedTimer t;
    return std::invoke(std::forward<F>(f), std::forward<A>(a)...);  // preserves T, T&, T&&
}
```
Without `decltype(auto)` this wrapper silently copies every reference-returning function's result — a common and expensive bug.

### Rules and constraints

- Multiple `return` statements must deduce **identically**: `auto f(bool b){ if(b) return 1; return 2.0; }` is an error, not a common-type computation.
- A recursive `auto` function must have a non-recursive `return` **before** the recursive one, so the type is known.
- **A function with a deduced return type cannot be forward-declared usefully** — the definition must be visible to call it. This kills `auto` returns in headers-as-interfaces and PIMPL boundaries (Ch. 44 §44.14), and it means deduced returns are **not** an ABI-stable interface.
- Deduced return types **cannot be virtual** (the vtable slot needs a known type).
- `auto` returning by value from an expression involving a `string_view` or reference member is the standard dangling-return trap: `auto substr(...)` returning a view into a temporary.

C++20 adds **abbreviated function templates** (`auto f(auto x)`), and constrained `auto` (`std::integral auto f()`), which constrains the deduced type.

**Interview framing:** *"When do you need `decltype(auto)`?"* — when writing a generic wrapper that must return exactly what the wrapped call returns, including references; `auto` would decay it to a value and silently copy or dangle.

---

## 4.15 C Variadic Functions

```cpp
#include <cstdarg>
int sum(int count, ...) {
    va_list ap; va_start(ap, count);
    int s = 0;
    for (int i = 0; i < count; ++i) s += va_arg(ap, int);   // TYPE MUST BE CORRECT
    va_end(ap);
    return s;
}
```

The mechanism: arguments after the named ones are placed per the ABI (SysV x86-64: first six integer args in registers, first eight floats in SSE registers, the rest on the stack; a variadic call must set `AL` to the number of SSE registers used). `va_list` on SysV is a struct with a register-save-area pointer and offsets, which is why `va_list` is not portably copyable — use `va_copy`.

### Why it is dangerous

- **No type checking.** `va_arg(ap, int)` on a `double` reads garbage from the wrong register class.
- **Default argument promotions apply**: `float`→`double`, `char`/`short`/`bool`→`int`. So `va_arg(ap, float)` is *always* wrong; `va_arg(ap, char)` likewise.
- **Passing a non-trivial class type through `...` is conditionally-supported and usually UB.** Passing `std::string` to `printf("%s")` compiles and prints garbage — hence `-Wformat` and `std::format`.
- **No way to know how many arguments there are** — you need a count, a sentinel, or a format string. A `NULL` sentinel must be cast (`(char*)NULL`) on platforms where `NULL` is `0` and `int` is narrower than a pointer.
- **Security:** format-string vulnerabilities (`printf(user_input)`) are the classic remote-code-execution primitive via `%n`.

`-Wformat=2 -Wformat-security` gives compilers `printf`-family type checking, extendable to your own functions with `[[gnu::format(printf, 1, 2)]]`.

### Replacements

| Need | Modern tool |
|---|---|
| Type-safe variable arity | Variadic templates (§4.16) |
| Formatting | **`std::format`/`std::print`** (C++20/23) — compile-time-checked format strings, type-safe, no promotions (Ch. 16 §16.3) |
| Runtime-varying formatting | `std::vformat` with `std::format_args` |
| Homogeneous list | `std::initializer_list`, `std::span` |

`...` retains one important non-variadic use: **as a worst-match overload in SFINAE**, where `f(...)` is the fallback that loses to every other candidate (Ch. 17 §17.11), and in `catch(...)`.

**Low-latency note:** variadic functions cannot be inlined as effectively (the register-save-area prologue spills all argument registers to the stack — a real cost, visible in `printf`'s prologue), which is one more reason `std::format` with a fully-templated implementation is faster than `printf` when the format string is constant. The counterpoint: `std::format` costs compile time and code size per call site (Ch. 17 §17.22), and `printf` on a well-tuned libc is very fast; the actual low-latency answer is that neither belongs on the hot path — you log binary and format offline (Ch. 16 §16.5).

---

## 4.16 C++ Variadic Templates

```cpp
template <class... Ts>              // template parameter pack
void log(Ts&&... args) {            // function parameter pack (here, forwarding refs)
    (std::cout << ... << args);     // fold expression (C++17)
}
```

A **parameter pack** holds zero or more template arguments/parameters. `sizeof...(Ts)` yields the count (compile-time). **Pack expansion** — the trailing `...` — repeats a pattern once per element, comma-separated.

```cpp
f(args...);                    // f(a1, a2, a3)
f(g(args)...);                 // f(g(a1), g(a2), g(a3))
f(std::forward<Ts>(args)...);  // perfect forwarding (Ch. 17 §17.17)
Base<Ts>...                    // in a base-clause: inherit from each
```

### Fold expressions (C++17)

Before C++17, reduction required recursive instantiation — one template instantiation per element, with the compile-time and error-message cost that implies.

| Form | Expansion | Empty pack |
|---|---|---|
| `(... op pack)` | left fold: `((a1 op a2) op a3)` | ill-formed (except `&&`,`\|\|`,`,`) |
| `(pack op ...)` | right fold: `(a1 op (a2 op a3))` | same |
| `(init op ... op pack)` | binary left fold | `init` |
| `(pack op ... op init)` | binary right fold | `init` |

Only `&&` (→`true`), `||` (→`false`), and `,` (→`void()`) have defaults for the empty pack; everything else needs the binary form. `(cond && ...)` short-circuits, which matters when the operands have side effects.

### Idioms worth having ready

```cpp
(f(args), ...);                                   // call f on each, left to right — GUARANTEED order
                                                  // (comma fold is sequenced)
(v.push_back(args), ...);
auto total = (0 + ... + args);
bool all_pos = (... && (args > 0));

// pre-C++17 expander trick, still seen:
int dummy[] = {0, (f(args), 0)...};  (void)dummy;  // braced-init-list ⇒ left-to-right (§4.3)

// indexing a pack
template <std::size_t I, class... Ts>
using nth_t = std::tuple_element_t<I, std::tuple<Ts...>>;
```
C++26 adds **pack indexing** (`Ts...[I]`, `args...[I]`) natively, removing the `tuple_element` dance — worth naming.

### Costs and failure modes

- **Order of pack expansion in a function call is unspecified** (§4.3) — `f(g(args)...)` does not guarantee left-to-right. Use a comma fold or a braced-init-list when order matters.
- **Instantiation cost:** each distinct pack produces a distinct instantiation. Recursive variadic implementations are O(N) instantiations deep and are a major compile-time sink; fold expressions and `if constexpr` flattened much of this (Ch. 17 §17.22).
- **Code bloat:** a variadic `emplace_back` generates a function per argument-type combination — real `.text` growth, real I-cache pressure. This is the argument for type-erasing at the boundary and templating only the thin inner layer.
- Packs must be the **last** template parameter for deduction to work in most cases; a pack followed by a deducible parameter is a common error.
- **Empty packs** are legal and routinely break constructors (`Widget(Ts&&...)` with zero args competes with the default constructor).

**Where they shine on hot paths:** `emplace_back`/`make_unique`-style perfect forwarding (constructing in place, no temporary — Ch. 9), compile-time dispatch tables, and heterogeneous logging where the fold builds a fixed-layout binary record with no allocation and no format parsing at runtime.

---

## 4.17 Calling Conventions and Parameter Passing

The **ABI** (application binary interface) specifies where arguments go, who saves which registers, how the stack is aligned, and how returns work. On Linux/macOS x86-64 that is **System V AMD64** (Ch. 41 §41.5); Windows x64 differs materially.

### System V AMD64, essentials

```
Integer/pointer args:  RDI, RSI, RDX, RCX, R8, R9   then stack (right-to-left push)
SSE/float args:        XMM0–XMM7                    then stack
Return:                RAX (+RDX for 128-bit), XMM0 (+XMM1)
Callee-saved:          RBX, RBP, R12–R15            (must be preserved)
Caller-saved:          everything else, incl. all XMM
Stack alignment:       16 bytes at the CALL instruction
Red zone:              128 bytes below RSP usable by leaf functions without adjusting RSP
Variadic:              AL = number of vector registers used
```

| | System V (Linux/macOS) | Microsoft x64 |
|---|---|---|
| Integer arg registers | 6 (RDI RSI RDX RCX R8 R9) | **4** (RCX RDX R8 R9) |
| Float arg registers | 8 | 4, and int/float share *positions* |
| Shadow space | none | **32 bytes** reserved by caller |
| Red zone | 128 bytes | **none** |
| Callee-saved | RBX RBP R12–R15 | + RSI, RDI, XMM6–XMM15 |

### How aggregates are passed — the part that matters

A class type is classified field-by-field into eight-byte "chunks":
- **≤ 16 bytes and trivially copyable** → passed in **up to two registers** (INTEGER/SSE class per chunk).
- **> 16 bytes**, or containing unaligned/mixed classes → passed **in memory** (copied to the stack by the caller).
- **Non-trivial for the purposes of calls** (user-provided or virtual copy/move constructor, or a non-trivial destructor) → passed **by invisible reference**: the caller constructs a temporary and passes its address. Ch. 3 §3.5.

That last rule is the highest-value ABI fact in C++:

```cpp
struct A { int x, y; };                              // 8 bytes  → one register
struct B { int x, y; ~B(){} };                       // 8 bytes  → MEMORY. The destructor costs you the register.
std::unique_ptr<T> p;                                // 8 bytes  → MEMORY, not a register
```
**`std::unique_ptr` is not zero-overhead across a non-inlined function boundary** — it has a non-trivial destructor, so it is passed by address, unlike a raw pointer. Inside a translation unit with inlining, the cost vanishes; across an ABI boundary it is real, and it is *the* answer to "is `unique_ptr` really zero-cost?" (Ch. 9 §9.11).

Returns: a large or non-trivial return value uses the **hidden return-slot pointer** in RDI (shifting all other arguments right one register) — the mechanism that makes RVO/NRVO work by construction (Ch. 10 §10.1). The callee constructs the object directly in the caller's storage.

### Passing guidance

| Situation | Pass as |
|---|---|
| Small trivially copyable (≤16 B) | **by value** — register, and enables optimization |
| Large, read-only | `const T&` |
| Sink / will be stored | **by value, then `std::move`** (one move for lvalues, zero for rvalues) |
| Needs both lvalue and rvalue efficiency in a template | `T&&` forwarding reference |
| Non-owning contiguous data | `std::span<const T>` / `std::string_view` (Ch. 13) |
| Optional out-parameter | pointer (nullable), not a reference |

Reference parameters compile to pointers, so `const int&` for an `int` is a **pessimization**: it forces a memory round trip and blocks constant propagation when not inlined. `const std::string&` on a hot path is worse — it invites a temporary `std::string` construction (heap allocation) at every call site given a `const char*`; `std::string_view` is the fix.

Other calling conventions worth naming: `__attribute__((fastcall/regparm))` (x86-32 legacy), `__vectorcall` (MSVC, passes vectors in registers), `[[gnu::preserve_all]]`/`preserve_most` (Clang, for cold paths and JIT stubs), and `__attribute__((sysv_abi))` for interop. **Tail calls** (Ch. 41 §41.9) matter for dispatch loops: the compiler can only turn `return f(x);` into a `jmp` if there are no non-trivial destructors pending and the ABIs match, which is why RAII objects in scope silently disable tail-call optimization.

---

## 4.18 Namespaces and Name Lookup

Namespaces partition names to prevent collisions; **name lookup** is the algorithm that turns an identifier in source into a declaration.

### The two lookup kinds

- **Qualified lookup** (`N::f`, `obj.f`, `Class::f`) — search only the named scope and, for classes, its bases. Disables ADL.
- **Unqualified lookup** — search progressively outward: block scope → enclosing blocks → function/class scope (including base classes) → enclosing namespaces → global namespace. **Stops at the first scope containing the name** — including a name of a completely wrong kind. Then, for function calls, ADL (§4.7) is added.

The "stops at the first hit" rule is what produces **name hiding**:
```cpp
struct Base   { void f(int); void f(double); };
struct Derived: Base { void f(const char*); };
Derived d;  d.f(1);           // ERROR — Base::f is HIDDEN, no int overload visible
// fix: `using Base::f;` inside Derived
```
This applies to variables shadowing outer variables (`-Wshadow`), to a member hiding a namespace-scope function, and to a `using`-declaration's interaction with overloads.

### Namespace facilities

```cpp
namespace a::b::c { ... }              // nested definition, C++17
namespace fs = std::filesystem;        // alias
using namespace std;                   // using-DIRECTIVE — makes names findable (never in a header)
using std::vector;                     // using-DECLARATION — introduces one name; preferred
inline namespace v2 { ... }            // members visible in the enclosing namespace
namespace { ... }                      // unnamed: internal linkage (Ch. 1 §1.7)
```

**Unnamed namespaces** are the modern replacement for file-static: they give internal linkage to *types* as well as functions and variables, which `static` cannot do. Every helper in a `.cpp` should live in one — it prevents ODR violations and lets the linker discard unused code (Ch. 40 §40.20).

**Inline namespaces** are the ABI-versioning mechanism: libstdc++'s `std::__cxx11` (the C++11 `std::string` ABI break) and `std::__1` in libc++ are inline namespaces, so `std::string` resolves to `std::__1::basic_string<...>` in the mangled name (Ch. 1 §1.10) while reading as `std::string` in source. Two libraries built against different versions produce different mangled symbols and fail to link — which is exactly the desired outcome, versus silently linking incompatible layouts. That is the strongest answer to "how would you version an ABI?" (Ch. 44 §44.17).

**`using namespace std;` at namespace scope in a header** is the canonical sin: it injects thousands of names into every including TU, causing ambiguities that appear only when some *other* header is added, and breaking `std::` additions (adding `std::size` in C++17 broke code with a global `size`). At function scope in a `.cpp` it is defensible.

### Lookup subtleties worth knowing

- **Two-phase lookup in templates** (Ch. 17 §17.8): non-dependent names bind at *definition*; dependent names at *instantiation*, via ADL only. This is why `this->member` and `typename`/`template` disambiguators are needed, and why MSVC's historical lack of two-phase lookup made code non-portable.
- **Point of declaration** is *after* the declarator: `int x = x;` is self-initialization with an indeterminate value, not a reference to the outer `x`.
- **Class-scope lookup includes base classes** and is done before enclosing namespaces — a base member hides a namespace-scope name of the same name.
- **Ambiguity across `using namespace`** is a hard error only at the point of use, so adding a using-directive can break far-away code.
- **`::f` forces global scope**, useful to escape a member or a hijacking overload.
- **Modules (C++20, Ch. 19 §19.6)** change this materially: names are not injected by textual inclusion, so lookup depends on explicit `export`, which finally makes header hygiene structural rather than conventional.

---

## Key Interview Questions

1. **What are the five value categories and how do the two axes define them?** — identity × moveability: lvalue (identity, no move), prvalue (no identity, move), xvalue (both); glvalue = identity, rvalue = moveable.
2. **Is a named `T&&` parameter an lvalue or an rvalue?** — An lvalue. Type and value category are orthogonal; you must `std::move` it again to move from it.
3. **What did C++17 change about evaluation order?** — Ordered `=`, `[]`, `.`, `<<`/`>>`, and `new`'s allocation-vs-initializer; made function arguments indeterminately (not un-) sequenced, which fixed the `f(make_unique<A>(), make_unique<B>())` leak.
4. **Is argument evaluation order undefined or unspecified?** — Unspecified; braced-init-list elements, by contrast, are guaranteed left-to-right.
5. **Distinguish undefined, unspecified, and implementation-defined behaviour.** — No requirements at all / a choice from a valid set / a documented choice. Only UB can travel backwards and delete your code.
6. **Why can UB delete a null check you wrote before the dereference?** — The compiler assumes UB never occurs, so a later dereference proves the pointer non-null everywhere in the function.
7. **Why is a signed loop counter sometimes faster than an unsigned one?** — Signed overflow is UB, so the compiler may widen the induction variable and skip wraparound handling, enabling vectorization.
8. **Walk through overload resolution.** — Name lookup builds candidates (ordinary + ADL), viability filters, then conversion-sequence ranking; ties broken by non-template > template, more-specialized template, more-constrained.
9. **Why does a perfect-forwarding constructor hijack the copy constructor?** — `T&&` deduces `Widget&`, an exact match, beating the copy ctor's qualification conversion to `const Widget&`. Constrain it.
10. **What is ADL and why is `using std::swap; swap(a,b);` written that way?** — ADL adds the argument types' namespaces to the candidate set; qualifying `std::swap` would disable ADL and force the generic version. C++20 CPOs encapsulate this.
11. **What is a hidden friend and why prefer it?** — A friend defined in-class, findable only by ADL: smaller overload sets, faster compiles, no accidental conversions.
12. **Why should a virtual function never have a default argument?** — The default comes from the static type at the call site while the body dispatches dynamically.
13. **What is the real cost of an indirect call?** — Not the jump, but lost inlining plus a possible BTB mispredict (~15–20 cycles) and I-cache miss; retpoline mitigations make it far worse.
14. **How big is a pointer-to-member-function and why?** — 16 bytes under Itanium: code address or vtable index plus a `this`-adjustment, with a runtime virtual/non-virtual test on call.
15. **What does `std::invoke` add over `f(args...)`?** — Uniform INVOKE semantics that also handle member pointers and `reference_wrapper`; the rule `std::thread`/`bind`/`function` already used.
16. **What are `std::function`'s three costs?** — Type erasure blocks inlining; heap allocation when the callable exceeds the small buffer; an extra indirection/cache miss. Plus a copy-constructibility requirement (`move_only_function` in C++23 fixes that).
17. **`constexpr` vs `consteval` vs `constinit`?** — May be compile-time / must be compile-time / must be constant-*initialized* without being const.
18. **What do `[[likely]]`/`[[unlikely]]` actually do?** — Code layout (cold-block outlining), not hardware prediction; PGO usually beats them.
19. **When do you need `decltype(auto)`?** — In forwarding wrappers, to return exactly what the wrapped call returns including references; `auto` would decay and copy.
20. **Why is a struct with a destructor passed differently from an identical one without?** — Non-trivial destructor ⇒ passed by invisible reference under SysV, not in registers. This is why `unique_ptr` isn't free across ABI boundaries.
21. **What is an inline namespace for?** — ABI versioning: `std::__1`/`__cxx11` change the mangled name so incompatible builds fail to link instead of silently corrupting.

---

## Common Traps

- **Treating a named rvalue reference as an rvalue** — one missing `std::move` turns a move into a copy.
- **`std::move` on a `const` object** — yields `const T&&`, binds to the copy constructor, silently copies.
- **Assuming left-to-right function argument evaluation.** Unspecified; only braced-init-lists guarantee it.
- **`i = i++ + ++i`-style expressions** — write two statements; version-dependent legality is not worth arguing about.
- **Believing UB means "whatever the hardware does."** It means the optimizer may reason backwards and delete code.
- **Empty infinite loop without a side effect** — forward-progress UB; a spin wait needs an atomic/volatile read or a yield.
- **`std::sort` with a non-strict-weak comparator** — reads out of bounds and corrupts memory, not merely misorders.
- **A derived-class member hiding all base overloads** — needs `using Base::f;`.
- **Unconstrained `template<class T> Widget(T&&)`** hijacking the copy constructor.
- **Overloading on `int` vs `double` and calling with `unsigned`** — ambiguous.
- **Default arguments on virtual functions** — static type supplies the value.
- **Changing a default argument in a shipped library** — callers baked the old value in; requires recompilation.
- **Qualifying `std::swap`** and losing the user's efficient overload.
- **Adding a function to your namespace** and breaking distant ADL-dependent calls.
- **`va_arg(ap, float)` or `va_arg(ap, char)`** — default argument promotions make these always wrong.
- **Passing a `std::string` to `printf("%s")`** — compiles, prints garbage; use `std::format`.
- **`std::function` in a hot path** — hidden allocation past ~16 bytes of captures and no inlining.
- **`const std::string&` parameters** — a `const char*` argument allocates at every call site; use `string_view`.
- **`const int&` parameters** — forces memory, blocks constant propagation.
- **Forgetting `(obj->*pmf)(args)` parentheses** — `->*` binds looser than the call.
- **`auto` return types in headers/PIMPL boundaries** — the definition must be visible, and they can't be virtual.
- **Relying on pack-expansion order in a function call** — unspecified; use a comma fold.
- **`using namespace std;` in a header** — mass name injection and future-standard breakage.
- **`[[assume(expr)]]` with an expression that can be false** — silent, unbounded UB.
- **Falling off the end of a non-void function** — the compiler may delete the path entirely.

---

## Compact Recall Summary

**Value categories.** Two axes: identity and moveability. lvalue = identity only; prvalue = moveability only and, since C++17, *not an object at all* until materialized; xvalue = both. Named rvalue references are lvalues. `std::move` is a cast that emits no code; `decltype((x))` adds a reference.

**Sequencing.** Unsequenced ⇒ UB if two side effects touch the same scalar. C++17 ordered `=` (right before left), `[]`, `.`, `<<`/`>>`, `new`'s allocation, and made call arguments *indeterminately* sequenced — which is what makes `f(make_unique<A>(), make_unique<B>())` safe. Argument order remains unspecified; braced-init-lists are guaranteed left-to-right.

**Behaviour classes.** UB = no requirements, propagates backwards, deletes code. Unspecified = a valid choice, undocumented. Implementation-defined = a documented choice. C++26 adds *erroneous* for uninitialized reads. Sanitizers map one-to-one onto UB classes: UBSan (arithmetic/alignment/enums), ASan (bounds/lifetime), TSan (races).

**Overload resolution.** Lookup (ordinary + ADL) → viability → conversion ranking (exact > promotion > conversion > user-defined > ellipsis, at most one user-defined conversion) → tie-breakers (non-template, more specialized, more constrained). Return type never participates; name hiding removes base overloads entirely.

**ADL.** Unqualified calls also search the argument types' namespaces — the reason operator overloading works at all. `using std::swap;` then unqualified `swap`; C++20 CPOs automate it. Hidden friends (in-class friend definitions) are ADL-only, cutting overload-set size and compile time.

**Defaults and pointers.** Default arguments are baked into the caller (ABI hazard) and are taken from the *static* type for virtuals. Function pointers cost lost inlining plus BTB pressure; pointers to members are 16 bytes with a virtual/non-virtual runtime test. `std::invoke` unifies all callables; `std::function` costs erasure + possible allocation; prefer template parameters on hot paths, `function_ref` (C++26) at boundaries.

**Compile time.** `constexpr` = may; `consteval` = must; `constinit` = constant-initialized, not const. C++14 made `constexpr` usable, C++20 added allocation/`vector`/`string`/virtuals, C++23 `if consteval`. UB is a hard error in constant evaluation. Use it for tables, format checking, and killing dynamic initialization.

**Attributes.** `[[nodiscard]]` for error-returning APIs, `[[likely]]` for *layout* not prediction, `[[assume]]` as a loaded gun, `[[noreturn]]` and `[[no_unique_address]]` as the two that change semantics. Unknown attributes are ignored since C++17.

**Deduction and variadics.** `auto` return strips references (use `decltype(auto)` in wrappers); deduced returns can't be virtual or forward-declared. C variadics have no type checking and apply default promotions — replaced by variadic templates and `std::format`. Fold expressions (C++17) replaced recursive instantiation; only `&&`/`||`/`,` have empty-pack defaults; pack indexing arrives in C++26; instantiation count and code bloat are the real costs.

**ABI.** SysV x86-64: six integer + eight SSE argument registers, 16-byte stack alignment, 128-byte red zone. Aggregates ≤16 bytes go in registers, but **any non-trivial copy/move/destructor forces passing by invisible reference** — the reason `unique_ptr` is not free at a non-inlined boundary. Large/non-trivial returns use a hidden return-slot pointer, which is the machinery behind guaranteed elision. Pass small trivially-copyable types by value; use `span`/`string_view` for non-owning data; RAII objects in scope disable tail calls.

**Lookup.** Unqualified lookup stops at the first scope containing the name, of any kind — hence hiding. Unnamed namespaces are the modern `static` and cover types too. Inline namespaces are how ABIs are versioned (`std::__1`). Never `using namespace std;` in a header. Templates use two-phase lookup; modules replace injection with explicit export.
