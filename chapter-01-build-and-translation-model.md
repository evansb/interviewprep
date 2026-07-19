# Chapter 1 — Build and Translation Model

*Interview-focused revision notes. Assumes you can already write C++; the goal is to be able to defend answers about what the compiler and linker actually do.*

---

## 1.1 Translation Units

A **translation unit (TU)** is the fundamental compilation input in C++: one source file after the preprocessor has run, i.e. the `.cpp` file plus the full transitive textual expansion of every `#include`, with conditional compilation resolved and macros substituted. The compiler sees TUs, never "files" in the sense the programmer thinks of them. The linker sees the object files produced from TUs.

The critical consequence: **C++ has no module boundary at the file level in the classical model.** A TU is a self-contained, independently compiled world. Nothing in TU A is visible to TU B unless it passes through the linker as a symbol, or unless the declaration is textually re-included in B. This is why C++ builds are `O(TUs × headers)` in preprocessed size — a project with 500 TUs each pulling in 50k lines of headers compiles 25M lines, not 500 files' worth.

```
foo.cpp ──preprocess──> TU (foo.cpp + all headers, expanded)
                            │
                         compile
                            ↓
                        foo.o  (machine code + symbol table)
                            │
        bar.o, baz.o ────────┼───── link ──> executable / shared lib
```

**Separate compilation** is the design goal this serves: change one `.cpp`, recompile one TU, relink. It fails the moment your change is in a widely included header — then every dependent TU is invalidated. This is the entire economic argument for the pimpl idiom, forward declarations, and (in C++20) modules.

**Isolation properties worth stating in an interview:**
- Two TUs may disagree about the meaning of a name and the compiler cannot detect it. If `struct S` has three `int` members in `a.cpp` and four in `b.cpp`, both compile cleanly; the program is ill-formed NDR (no diagnostic required) and typically produces memory corruption. This is the classic ODR violation, and it's why mismatched `-D` flags or `NDEBUG` inconsistency across a build is dangerous rather than merely untidy.
- Optimization is, by default, **per-TU**. The compiler cannot inline a function whose body lives in another TU. **LTO (link-time optimization)** exists precisely to break this wall: the compiler emits IR instead of machine code into object files, and the linker re-runs optimization across the whole program. LTO costs link time and memory, and it turns previously benign ODR violations into visible miscompiles because the optimizer now sees both conflicting definitions.

**C++20 modules** change the model: a module interface unit is compiled once into a binary artifact (BMI/CMI) that other TUs *import* rather than textually re-parse. Macros do not leak across `import`, and the compiler can enforce ODR across module boundaries. Adoption is gated on build-system support because module builds require dependency-ordered compilation, unlike headers, which are order-independent.

**Common misconception:** "one file = one TU." A header included by nobody is not a TU. A `.cpp` file `#include`d by another `.cpp` (occasionally done in unity builds) is not a separate TU. **Unity builds** (concatenating many `.cpp` files into one TU) trade incremental build speed for full-build speed and inlining opportunity, and they break code relying on internal linkage collisions — two TUs each with a `static int counter;` suddenly conflict, or worse, silently share.

---

## 1.2 Header Inclusion and Include Guards

`#include` is **textual substitution**, nothing more. The preprocessor locates a file and splices its contents in place of the directive. There is no notion of "importing a symbol." Everything downstream — parsing, name lookup, template instantiation — happens as though you had typed the header's contents at that point.

**Search rules:**
- `#include <name>` searches the *implementation-defined* system include paths (`-I`, `-isystem`, compiler defaults). By convention, system and third-party headers.
- `#include "name"` searches an implementation-defined additional set first — in practice, the directory of the including file — then falls back to the `<>` search. By convention, your own project headers.

The distinction is convention plus one real effect: `-isystem` directories typically suppress warnings from those headers, which is why you want third-party dependencies on `-isystem` and your own on `-I`.

### Include guards

Without protection, a header included twice in one TU redefines its types → hard error (a class may be declared many times, defined once per TU).

```cpp
#ifndef MYPROJ_WIDGET_H          // 1. not yet defined → enter
#define MYPROJ_WIDGET_H          // 2. define, so a second pass skips
...
#endif
```

**`#pragma once`** is a non-standard but universally supported alternative. Trade-offs:

| | Include guards | `#pragma once` |
|---|---|---|
| Standard | Yes | No (de facto universal) |
| Failure mode | Name collision between two headers using the same macro → one header silently vanishes | Compiler must identify "same file"; hard-links, symlinks, bind-mounts, or two build roots pointing at the same file can defeat it |
| Speed | Compiler must still open + tokenize the file (though most implement the "multiple-include optimization" and skip it) | Compiler can skip the `open()` entirely |
| Robustness | Copy-pasting a header and forgetting to rename the guard is a real, silent bug | No naming discipline needed |

Practical answer: use `#pragma once`, or both. Name guards with a project prefix and, ideally, a path (`MYPROJ_NET_SOCKET_H_`). Never use a leading underscore followed by a capital, or a double underscore anywhere — those identifiers are reserved to the implementation.

### The include-what-you-use discipline

A header should compile standalone: include every header whose declarations it uses and no more. **Transitive inclusion is a latent break** — if `a.h` gets `std::string` only because `b.h` happened to include `<string>`, then a cleanup in `b.h` breaks `a.h`. Enforce with a self-compilation test or a tool like `include-what-you-use`.

**Forward declarations** cut dependency edges. You may declare `class Widget;` and use `Widget*`, `Widget&`, and function signatures taking/returning `Widget` by value — but you need the complete type to construct, destroy, call members, take `sizeof`, or use it as a value member. Note you must *not* forward-declare standard library types (`std::string`, `std::vector`) yourself: the standard reserves the right to add default template arguments and hidden parameters. Use `<iosfwd>`, or the library's own forwarding headers.

**Pimpl (pointer to implementation)** is forward declaration taken to its conclusion: the header exposes only `std::unique_ptr<Impl> p_;` and an opaque `class Impl;`, so implementation changes never invalidate dependent TUs and ABI stays stable. Costs: one heap allocation, one pointer indirection per access, loss of inlining, and the destructor must be defined in the `.cpp` (where `Impl` is complete) or `unique_ptr` fails to instantiate.

---

## 1.3 Preprocessor Macros and Conditional Compilation

The preprocessor is a **token-level, type-unaware, scope-unaware** text processor that runs before the language proper exists. Every macro pathology follows from those three properties.

### Object-like and function-like macros

```cpp
#define BUFSZ 4096                   // object-like
#define MAX(a,b) ((a) < (b) ? (b) : (a))   // function-like
```

**Failure modes, in the order interviewers ask about them:**

1. **Missing parentheses.** `#define SQ(x) x*x` then `SQ(1+2)` → `1+2*1+2` = 5. Parenthesize every parameter *and* the whole body.
2. **Multiple evaluation.** `MAX(i++, j)` increments `i` twice. No amount of parenthesization fixes this; it's inherent to substitution. This is the primary argument for `constexpr`/`inline` functions and templates.
3. **No scope, no namespaces.** A macro named `min` in a Windows header destroys `std::min` at every use site. (`#define NOMINMAX` before `<windows.h>` is the standard workaround; the general lesson is that macro names should be `SHOUTY_AND_PREFIXED`.)
4. **Type invisibility.** Macros can't overload, can't be templates, can't participate in ADL, and are invisible to debuggers and IDE tooling.

Modern replacements: `constexpr` variables for constants, `inline`/`constexpr` functions for computation, templates for generic code, `enum class` for named constants. Macros remain legitimately irreplaceable for: header guards, conditional compilation, stringification of expressions (assertion/logging macros capturing `__FILE__`, `__LINE__`, and the source text), and X-macros for generating parallel tables.

### Operators `#` and `##`

- `#x` **stringifies** the argument's tokens: `#define STR(x) #x` → `STR(a+b)` yields `"a+b"`.
- `a##b` **pastes** tokens into one: `#define CAT(a,b) a##b` → `CAT(foo,bar)` yields `foo bar` joined as `foobar`.

Both suppress macro expansion of their operands, hence the standard two-level idiom:

```cpp
#define STR_(x) #x
#define STR(x)  STR_(x)     // expands x first, then stringifies
#define VERSION 3
STR(VERSION)   // "3"   (STR_ alone would give "VERSION")
```

`__LINE__`-based unique-name generation (`CAT(tmp_, __LINE__)`) requires the same indirection.

### Variadic macros

```cpp
#define LOG(fmt, ...) fprintf(stderr, fmt, __VA_ARGS__)
```
The trailing-comma problem when `__VA_ARGS__` is empty was long solved by the GNU extension `, ##__VA_ARGS__`; C++20 standardized `__VA_OPT__(,)`, which emits its content only if the variadic arguments are non-empty.

### Conditional compilation

```cpp
#if defined(__linux__) && !defined(NDEBUG)
#elif defined(_WIN32)
#else
#  error "unsupported platform"
#endif
```

`#ifdef X` ≡ `#if defined(X)`. Undefined identifiers in `#if` evaluate to `0`, which means **a typo in a feature macro silently takes the false branch** — a top-tier source of "why is this code not running." Prefer `#if defined(FEATURE_X)` over bare `#if FEATURE_X`, and consider compiling with `-Wundef`.

Real dangers:
- `#if` arithmetic uses the largest integer type and evaluates independently of the target's actual types, so `#if sizeof(int) == 4` is *not* even legal — `sizeof` doesn't exist in the preprocessor. Use `<climits>`/`<cstdint>` limits or `static_assert`.
- **Configuration skew.** Because macros can change class layout (`#ifdef DEBUG` adding a member) and macros are per-TU, mismatched flags across TUs are ODR violations that link successfully and crash at runtime. This is why `NDEBUG` must be consistent across your whole build including prebuilt dependencies.
- Prefer `if constexpr` and normal `if` over `#ifdef` inside function bodies where possible: unpreprocessed-out code is still type-checked, so it can't rot.

**Standard predefined macros worth knowing:** `__cplusplus` (`201703L`, `202002L`, …), `__FILE__`, `__LINE__`, `__DATE__`, `__TIME__`, `NDEBUG` (controls `assert`), and the feature-test macros (`__cpp_lib_ranges`, etc., via `<version>`), which are the correct modern way to probe library support rather than guessing from compiler version.

---

## 1.4 Phases of Translation

The standard defines **9 phases** (C++17 onward; older texts say 8). They are a semantic model — compilers fuse them — but interviewers ask because the *ordering* explains real behaviors.

| Phase | What happens | Why it matters |
|---|---|---|
| 1 | Physical source chars → basic source character set; trigraphs (removed in C++17) | Encoding conversion happens *first* |
| 2 | Backslash-newline **line splicing** | A trailing `\` in a `//` comment eats the next line. Splicing precedes comment removal. |
| 3 | Decompose into preprocessing tokens and whitespace; **comments become one space** | Comments cannot be produced by macro expansion; `/*` inside a string literal is not a comment |
| 4 | Preprocessor directives executed, macros expanded, `#include`d files run through phases 1–4 recursively | Recursion is why included files get their own line splicing |
| 5 | Character/string literal characters converted to the execution character set | Source encoding vs execution encoding split |
| 6 | **Adjacent string literals concatenated** | `"a" "b"` → `"ab"`; happens after macro expansion, so `"x" MACRO` works |
| 7 | Tokens → syntactic/semantic analysis; **translation unit compiled** | The "real" compiler |
| 8 | **Template instantiation** — instantiation units produced | Explains two-phase lookup and why template errors appear late |
| 9 | **Linking**: external references resolved, translation units + libraries combined | Where ODR and linkage bite |

**Consequences to be able to recite:**

- Line splicing before tokenization means this is a bug:
  ```cpp
  // comment ending in backslash \
  doSomething();      // <-- swallowed into the comment
  ```
- Because comments become whitespace in phase 3, you cannot form a comment via macro pasting, and `//` inside a `"string"` is inert.
- Because `#include` is phase 4, the included file's macros are live in the includer from that point on — inclusion order is semantically significant. Hence "include your own header first" (proves self-sufficiency) and "include `<windows.h>` last, or after `NOMINMAX`."
- Phase 8 separation explains **two-phase name lookup**: non-dependent names in a template are bound at definition (phase 7), dependent names at instantiation (phase 8), using the instantiation context plus ADL. MSVC historically deferred everything to phase 8, which is why code written against MSVC often fails on GCC/Clang with "`there are no arguments to 'foo' that depend on a template parameter`" — the fix is usually `this->foo()` or a qualified name.
- Phase 9 is where the linker has no type information (only mangled names), which sets up everything in §1.6–§1.12.

---

## 1.5 Declarations and Definitions

A **declaration** introduces a name and gives it a type, letting the compiler type-check uses. A **definition** additionally provides the entity itself — the code, the storage, or the class layout — so that the entity can be brought into existence.

Every definition is a declaration; the reverse is false.

```cpp
extern int  x;              // declaration
int         x = 5;          // definition (allocates storage)
int         y;              // definition at namespace scope (zero-init)

void f(int);                // declaration
void f(int a) { /*...*/ }   // definition

class C;                    // declaration (incomplete type)
class C { int a; };         // definition (complete type)

struct S { static int s; }; // declares S::s; does NOT define it
int S::s = 0;               // definition, must appear in exactly one TU

using A = int;              // definition of a type alias
typedef int B;              // ditto
enum class E : int;         // declaration (opaque enum, needs fixed underlying type)
```

### Complete vs incomplete types

An **incomplete type** is declared but not defined. You may form pointers and references to it, declare (not define) functions using it, and `extern`-declare objects of it. You may not: `sizeof`, instantiate, dereference-and-use, access members, or use it as a base class or by-value member. Incompleteness is the mechanism behind pimpl, opaque handles, and mutually recursive types.

```cpp
struct Node;                 // incomplete
struct List { Node* head; }; // fine — pointer to incomplete
struct Node { int v; Node* next; }; // now complete
```

`std::vector<Incomplete>` was UB before C++17; `vector`, `list`, and `forward_list` now explicitly permit incomplete element types provided the type is complete before any member is used. Most other containers still require completeness.

### Rules of thumb

- **Declare in headers, define in exactly one TU** — with three exceptions that are the subject of §1.6 and §1.9: classes, inline functions/variables, and templates may be defined in every TU that needs them, provided the definitions are token-identical.
- **The most vexing parse**: `Widget w();` declares a function returning `Widget`, it does not define an object. `Widget w{};` disambiguates. Similarly `Widget w(Gadget());` is a function declaration taking a pointer-to-function.
- Default arguments belong on the declaration (typically once, in the header), not repeated on the definition.
- A function definition without a prior declaration also *declares* it; forward declarations exist to permit use-before-definition and cross-TU visibility.

---

## 1.6 The One Definition Rule (ODR)

The ODR is the contract that makes separate compilation sound. Three clauses:

**ODR-1 (per TU):** No TU may contain more than one definition of any variable, function, class type, enumeration, or template.

**ODR-2 (per program):** Every non-inline function or variable that is *odr-used* must have **exactly one** definition in the entire program. Zero definitions → undefined-reference link error. Two → duplicate-symbol link error. These are the friendly failures.

**ODR-3 (the dangerous one):** Classes, inline functions, inline variables, and templates may be defined in multiple TUs, **but every definition must consist of the same sequence of tokens, and names must resolve to the same entities in every TU.** Violation is **ill-formed, no diagnostic required (IFNDR)** — the compiler and linker are permitted to silently accept it and produce nonsense.

### Why ODR-3 fails silently

The linker deduplicates these multiply-defined symbols by *name only*. Given two different definitions of `Widget::size()` in two TUs (because a macro differed), the linker keeps whichever it encounters first and discards the other. Half your program now calls a function compiled against a different class layout.

```cpp
// a.cpp
#define FAST 1
#include "widget.h"     // struct Widget { int a; #if FAST  int cache; #endif };

// b.cpp
#include "widget.h"     // struct Widget { int a; };
// sizeof(Widget) differs across TUs → any cross-TU Widget traffic is corruption
```

Real-world sources of ODR violations, ranked by frequency:
1. **Inconsistent macro definitions** across TUs (`NDEBUG`, `_GLIBCXX_DEBUG`, `-D` flags, packing pragmas).
2. **Mixing ABI-incompatible builds** — debug and release runtimes, different `-std=`, different `_ITERATOR_DEBUG_LEVEL` on MSVC.
3. **Anonymous-namespace types used in inline function signatures** — the type is distinct per TU, so the inline function's definitions are not equivalent even though the tokens are identical.
4. **Two different libraries statically linking different versions of a third**, each exporting the same symbols.
5. `static` local variables in header-defined functions that differ per TU by a macro.

### Odr-use

A variable is **odr-used** roughly when its address is taken or a reference binds to it — i.e. when the entity must actually exist in memory. If a constant is only ever read as a value, it is not odr-used and no definition is required. This was the pre-C++17 headache:

```cpp
struct S { static const int N = 10; };     // declaration + initializer
int S::N;                                  // pre-C++17: needed if odr-used
std::min(S::N, x);                         // binds const int& → odr-use → link error without the definition
```
C++17's **`inline` variables** (and implicitly `inline` for `constexpr static` data members) removed the need for the out-of-line definition. This is the single most common modern answer to "how do I put a global in a header?"

### Detection

- Compile with identical flags everywhere; centralize them in your build system.
- **`-fsanitize=address` with `detect_odr_violation=2`** (default 1) catches distinct definitions of the same global.
- **`gold`/`lld --detect-odr-violations`**, or comparing debug-info type hashes.
- LTO frequently *surfaces* ODR bugs as miscompiles or ICEs — a good reason to run an LTO build in CI even if you ship non-LTO.
- Put implementation-only helpers in an **anonymous namespace** so they cannot collide at all.

---

## 1.7 Linkage

**Linkage** determines whether a name declared in one scope can refer to the same entity as a declaration in another scope.

| Linkage | Meaning | How you get it |
|---|---|---|
| **No linkage** | Name refers to a unique entity; not visible outside its scope | Local variables, function parameters, local classes, local typedefs |
| **Internal** | Refers to the same entity within the TU only | `static` at namespace scope; members of anonymous namespaces; `const`/`constexpr` namespace-scope variables (C++ only — differs from C!); anonymous unions; enumerators/typedefs at namespace scope |
| **External** | Refers to the same entity across the whole program | Non-`static` functions and variables at namespace scope; class types and their members; `extern` declarations; enums and templates |
| **Module** (C++20) | Visible across the TUs of one named module, not beyond | Exported-less declarations in a module unit |

**The C/C++ `const` divergence is a classic interview question.**

```cpp
const int  N = 10;   // C++: internal linkage → safe to put in a header
                     // C:   external linkage → duplicate symbol if in a header
extern const int M = 10; // C++: force external linkage
```
Because namespace-scope `const` is internal in C++, each TU gets its own copy — usually optimized away entirely, but if odr-used, you get *N distinct objects at different addresses*. Never depend on the address of a header-declared `const` being unique. Use `inline constexpr` (C++17) when you need a single, shared object.

### Anonymous namespaces vs `static`

```cpp
namespace { void helper(); }   // preferred
static void helper();          // legacy, still fine for functions/variables
```
An anonymous namespace gives its members internal linkage (formally: a unique name unique to the TU, plus a using-directive). Advantages over `static`: it works for **types**, and types with internal linkage can be used as template arguments (which pre-C++11 `static` entities could not). Trap: a type defined in an anonymous namespace is a *different type in every TU* — leaking it into an inline function's or template's signature is an ODR violation (§1.6).

### Linkage vs scope vs visibility — do not conflate

- **Scope**: the region of source text where a name is *usable* by lookup. A compile-time, language-level concept.
- **Linkage**: whether declarations in different scopes/TUs denote the *same entity*. Resolved at compile+link time.
- **Storage duration**: when the object's memory exists (§1.8). Orthogonal.
- **Symbol visibility**: an ELF/Mach-O *loader* concept about what's exported from a shared object (§1.12). A different layer entirely.

A `static` local variable has **no linkage**, **static storage duration**, and **block scope** — the canonical example proving the three axes are independent.

### Language linkage

`extern "C"` (§1.10) is a fourth, orthogonal property: it selects the calling convention and name-mangling scheme, not the internal/external axis.

---

## 1.8 Storage Duration

**Storage duration** is the lifetime of the *memory*, distinct from the *object lifetime* (which begins at the end of construction and ends when the destructor starts).

| Duration | Allocated | Deallocated | Examples |
|---|---|---|---|
| **Automatic** | On entry to the block (conceptually) | On exit from the block, incl. exceptions | Non-static locals, parameters |
| **Static** | Before `main` (storage), init per rules below | After `main` returns, reverse order of completed construction | Globals, `static` locals, `static` members, `extern`, `thread_local`'s sibling |
| **Thread** | Thread start | Thread exit | `thread_local` |
| **Dynamic** | `new` / `operator new` / allocator | `delete` / `operator delete` | Heap objects |

Since C++20, **temporary materialization** doesn't create a fifth category, but temporaries' lifetime rules are their own topic (destroyed at end of full-expression, unless lifetime-extended by binding to a `const&` or rvalue reference).

### Static initialization order

Two stages before `main`:
1. **Static initialization** — *zero-initialization*, then *constant initialization* for entities whose initializer is a constant expression. Done at load time from the binary image; no code runs. `constinit` (C++20) asserts an entity is constant-initialized, converting a dynamic-init surprise into a compile error.
2. **Dynamic initialization** — everything else, i.e. constructors and non-constant initializers. Within a TU: **guaranteed in order of definition.** Across TUs: **unspecified.**

This is the **static initialization order fiasco**: a global in `a.cpp` whose constructor uses a global in `b.cpp` may see a zero-initialized-but-not-constructed object.

**Fix — Construct On First Use / Meyers singleton:**
```cpp
Registry& registry() {
    static Registry r;      // initialized on first call
    return r;
}
```
Since C++11, function-local static initialization is **thread-safe**: concurrent first calls block until one thread completes the initialization (implemented via a guard variable and `__cxa_guard_acquire`). Cost: one relaxed atomic load of the guard byte on the fast path — usually negligible, but measurable in the hottest loops, and `-fno-threadsafe-statics` exists for freestanding targets.

The mirror problem is the **static *de*initialization fiasco**: destructors run in reverse order of construction completion, so a global logger may be destroyed before its last user. The nuclear-but-correct answer is a leaked singleton (`static Registry* r = new Registry;`) — never destroyed, so never destroyed too early. Trades a one-time "leak" (reported by leak sanitizers unless suppressed) for correctness at shutdown.

### `thread_local`

Each thread gets its own instance; construction happens on first use in that thread, destruction at thread exit. Access is not free: depending on the TLS model (`initial-exec`, `local-dynamic`, `global-dynamic`), it may cost a call to `__tls_get_addr`, especially for variables in dynamically loaded shared libraries. `-ftls-model=initial-exec` speeds it up at the cost of forbidding `dlopen` of that library.

### Practical points

- Automatic storage is a stack-pointer adjustment: allocation is effectively free, and the whole frame is released at once. This is why arena/stack allocation dominates heap allocation in performance work.
- Objects with automatic storage are destroyed during stack unwinding — the foundation of RAII.
- Dangling references from returning the address of an automatic object is a top-3 UB source; `-Wreturn-local-addr` catches the naive cases.
- "Static storage duration" ≠ "`static` keyword". `static` means internal linkage at namespace scope, static duration at block scope, and "no `this`" for class members — three unrelated meanings, a favorite trivia question.

---

## 1.9 Inline Functions and Variables

**`inline` does not mean "inline this."** It never really did; it is a *linkage/ODR* keyword. It means: **this entity may be defined in multiple TUs, and the linker shall pick one and treat them as the same entity.**

Mechanically, the compiler emits the definition into every TU that needs it, marking each in a **COMDAT** section (`.text._Z3foov` in ELF, or `__gnu_linkonce`), and the linker discards all but one. Without `inline`, two definitions are a duplicate-symbol error.

Inlining as an optimization is decided by the compiler based on cost heuristics (call-site count, body size, `-O` level), largely ignoring the keyword — though it *is* a weak hint, and it does have a strong practical effect: **inlining is only possible if the body is visible**, so putting a definition in a header (which requires `inline`) is what actually enables cross-TU inlining without LTO.

```cpp
// util.h
inline int clamp(int v, int lo, int hi) { return v < lo ? lo : v < hi ? v : hi; }
inline constexpr double kPi = 3.14159265358979;   // C++17 inline variable
```

**Implicitly inline:**
- Member functions defined inside the class body.
- `constexpr` functions and `consteval` functions.
- `constexpr` **static** data members (C++17) — hence no out-of-line definition needed.
- Function templates and member functions of class templates are not *inline* per se, but obey the same "define everywhere" ODR exemption.
- Deleted and defaulted-in-class functions.

**Inline variables (C++17)** finally solve header-only globals:
```cpp
// before C++17
extern Config g_config;             // header
Config g_config;                    // exactly one .cpp — annoying for header-only libs
// C++17
inline Config g_config;             // header only, one object program-wide
```

### Trade-offs and failure modes

- **Every inline definition is duplicated in every TU** until the linker collapses it: bigger object files, slower links. Aggressive header-only libraries are the main cause of multi-minute link times.
- **ABI fragility**: an inline function's body is baked into every caller. Changing it and relinking only the "owning" library leaves stale copies inlined into callers. This is why library authors keep ABI-critical logic out-of-line and why pimpl exists.
- **ODR trap**: if two TUs see different bodies for the same `inline` function (macro divergence again), the linker silently keeps one. No diagnostic.
- **`static` in a header ≠ `inline` in a header.** `static inline` in a header gives each TU its *own copy* of the function and, crucially, its own copy of any function-local `static` variable inside it. `inline` alone gives one shared copy. A counter inside a `static inline` header function counts per-TU — a genuinely nasty bug.
- **Force/forbid**: `__attribute__((always_inline))` / `[[gnu::always_inline]]` and `__forceinline` (MSVC) actually force it (or error); `__attribute__((noinline))` forbids. Use sparingly and with measurements — the optimizer is usually right, and forced inlining of a large function can blow the instruction cache and *slow* the program.
- Excessive inlining hurts: I-cache pressure, larger stack frames, longer compile times. It helps most for small functions where call overhead dominates, and for exposing constants to the optimizer (constant propagation across the call boundary is often the real win, not the saved `call` instruction).

---

## 1.10 Name Mangling and `extern "C"`

C++ requires the linker to distinguish `void f(int)` from `void f(double)` from `Ns::C::f() const`, but the linker only sees strings. **Name mangling** (formally, *decoration*) encodes the full signature — namespaces, class, parameter types, cv-qualifiers, ref-qualifiers, template arguments, return type for templates — into a single flat identifier.

```
void ns::C::f(int, const char*) const
  →  _ZNK2ns1C1fEiPKc          (Itanium ABI, used by GCC/Clang)
     ^^^ ^  ^  ^  ^^^^
     |   |  |  |  parameters: i = int, PKc = pointer to const char
     |   |  |  function name
     |   |  class
     |   namespace, length-prefixed
     _Z = mangled name, N…E = nested, K = const member
```

Decode with `c++filt` (or `nm -C`, `llvm-cxxfilt`). Interviewers like: "given an undefined-symbol error, what do you do?" → `c++filt` the symbol, then `nm -C --defined-only` the libraries to find who should provide it.

**Mangling schemes are ABI, not standard.** GCC and Clang share the Itanium C++ ABI; MSVC has its own (`?f@C@ns@@QEBAXHPEBD@Z`). Consequence: **you cannot link C++ objects across incompatible compilers/ABIs.** The GCC 5 `std::string` ABI break (`_GLIBCXX_USE_CXX11_ABI`) is the standard war story — `std::__cxx11::basic_string` vs the old COW string mangle differently, so mixing them produces undefined references rather than silent corruption. That was a *deliberate* use of mangling as a safety net.

### `extern "C"`

Declares **C language linkage**: no mangling (or minimal platform decoration like a leading underscore) plus the C calling convention.

```cpp
extern "C" void  init(void);
extern "C" { #include "c_api.h" }        // typical pattern

// canonical dual-language header:
#ifdef __cplusplus
extern "C" {
#endif
void init(void);
#ifdef __cplusplus
}
#endif
```

Rules and limits:
- Only **one** function of a given name may have C linkage — **no overloading**, since there's nothing to encode the difference into.
- C linkage applies to function *types* too, so a function pointer passed to a C API strictly should be `extern "C"` typed. In practice most compilers are lenient; strictly it matters for callbacks.
- Class member functions cannot have C linkage. To expose C++ objects to C, hand out opaque `void*`/struct pointers and free functions.
- **Exceptions must not propagate through an `extern "C"` frame** into C code — the C frames have no unwind tables. Wrap every C-callable entry point in `try { … } catch(...) { return ERROR; }`. `noexcept` on the boundary turns escapes into `std::terminate`, which is at least deterministic.
- `extern "C"` does **not** change linkage in the internal/external sense, and does not disable C++ semantics *inside* the function — you can still use templates, RAII, and exceptions internally.

This is also the mechanism behind plugin systems: export a single `extern "C" Plugin* create_plugin();` factory whose name is stable across compilers, and do everything else through a C++ abstract interface (whose vtable layout you must then keep stable — a separate ABI hazard).

---

## 1.11 Static and Dynamic Libraries

### Static libraries (`.a`, `.lib`)

An archive — essentially a `tar` of object files with a symbol index. **The linker does not link the whole archive.** It processes inputs left to right, maintaining a set of undefined symbols; on reaching an archive it pulls in *only those members that resolve a currently-undefined symbol*, then moves on.

Consequences, all of them interview-frequent:
- **Link order matters.** `g++ main.o -la -lb` works if `a` needs `b`; the reverse fails with undefined references. Fixes: correct ordering, repeat the library, or `-Wl,--start-group … -Wl,--end-group` for circular dependencies (slower — it iterates).
- **The static initialization trap.** An object file that only contains self-registering globals (`static Registrar r;`) resolves no undefined symbol, so it is *never pulled in* and the registration silently doesn't happen. Fix with `-Wl,--whole-archive` (GNU) / `-force_load` (Apple) / `/WHOLEARCHIVE` (MSVC), or reference something in that object explicitly.
- Unused members are never even copied, so the linker naturally strips dead code at object granularity. `-ffunction-sections -fdata-sections -Wl,--gc-sections` refines this to function granularity.

### Dynamic/shared libraries (`.so`, `.dylib`, `.dll`)

Loaded at run time by the dynamic loader (`ld.so`). Must be built **position-independent** (`-fPIC`) so the code works at any load address; calls to exported functions go through the **PLT** (procedure linkage table) and data through the **GOT** (global offset table), resolved lazily by default (`LD_BIND_NOW`/`-Wl,-z,now` forces eager binding — better for security and latency determinism, worse for startup).

|  | Static | Dynamic |
|---|---|---|
| Binary size | Larger executable, no external deps | Smaller executable; library shared across processes (one physical copy of `.text` in RAM) |
| Startup | Fastest — nothing to resolve | Loader must map, relocate, resolve symbols |
| Call cost | Direct call, fully inlinable via LTO | Indirect via PLT/GOT; no cross-boundary inlining |
| Deployment | Single self-contained artifact | Version skew, "DLL hell", `LD_LIBRARY_PATH`/`rpath` issues |
| Updates | Relink everything | Drop in a new `.so`, if ABI-compatible |
| Security fixes | Rebuild all consumers | Patch one file (major argument for distros) |
| Symbol collisions | Detected at link | Can be resolved at load in surprising ways (interposition) |

**ABI compatibility** is the whole game for shared libraries: you may not change class layout, virtual function order, inline function bodies, default arguments, or exported signatures without a soname bump. Linux encodes this in the **soname** (`libfoo.so.2`) with a symlink chain `libfoo.so → libfoo.so.2.3.1`. Symbol versioning (`GLIBC_2.34`) lets a single `.so` export multiple incompatible versions of one symbol.

**Loading modes:** implicit (link time, `-lfoo`) vs explicit (`dlopen`/`dlsym`, `LoadLibrary`/`GetProcAddress`). `dlsym` requires a stable, unmangled symbol name → `extern "C"` factory functions (§1.10).

**Windows specifics** worth naming: symbols are not exported by default; you need `__declspec(dllexport)` when building and `__declspec(dllimport)` when consuming (the usual macro dance), or a `.def` file. Building a DLL also produces an *import library* (`.lib`) that the linker consumes. And each DLL may link its own CRT — allocating in one DLL and freeing in another with mismatched CRTs corrupts the heap, which is why cross-DLL interfaces should never pass ownership of raw allocations.

---

## 1.12 Symbol Visibility and Weak Symbols

### Visibility

ELF visibility controls whether a symbol in a shared object is exported to other modules.

| Visibility | Meaning |
|---|---|
| `default` | Exported; **can be interposed** (preempted by a definition loaded earlier) |
| `protected` | Exported, but references *within* the defining module always bind locally — no self-interposition |
| `hidden` | Not exported; usable within the module only. Still has external linkage for the static linker. |
| `internal` | Hidden plus a promise it's never called from another module (rarely used, ABI-specific) |

Default on ELF is `default`, i.e. **everything is exported** — the opposite of Windows. This is bad: huge dynamic symbol tables (slower load, larger binaries), accidental API surface, and interposition preventing optimization.

Best practice for a library:
```
-fvisibility=hidden -fvisibility-inlines-hidden
```
then explicitly export your API:
```cpp
#define API __attribute__((visibility("default")))     // or __declspec(dllexport)
class API Widget { ... };
API int process(Widget&);
```
This is the portable-macro pattern every real library uses (`FOO_EXPORT`). Note `-fvisibility-inlines-hidden` also shrinks binaries substantially by not exporting inline member functions — safe unless you compare function *addresses* across module boundaries.

**Interposition** is why `default` visibility costs performance: because a `default`-visibility function could be replaced at load time (that's how `LD_PRELOAD` malloc-replacement works), the compiler cannot inline calls to it even within the same library, and must route them through the PLT. `hidden` or `protected` restores direct calls.

Watch out for **type identity across module boundaries**: `dynamic_cast`, `typeid`, and exception catching compare RTTI by *pointer* to type_info name on most Itanium-ABI platforms (with a string-comparison fallback). If a class's typeinfo is `hidden` in two libraries, each has its own copy, and `catch (MyError&)` in one library will *not* catch an exception thrown by the other. **Rule: types used across module boundaries — especially exception types and polymorphic bases — must have `default` visibility.** This is one of the highest-value obscure facts to know.

### Weak symbols

A **weak** symbol may be overridden by a strong definition without a duplicate-symbol error; if no definition exists at all, a weak *reference* resolves to null rather than failing the link.

```cpp
__attribute__((weak)) void hook() { /* default no-op */ }   // weak definition
extern __attribute__((weak)) void optional_feature();       // weak reference
if (optional_feature) optional_feature();                   // null check is legal and required
```

Uses:
- **Default implementations** overridable by the application (classic in embedded/RTOS: weak ISR handlers).
- **Optional dependencies** — call a function if the library happened to be loaded.
- **The compiler's own use**: template instantiations, inline functions, and vtables are emitted as **weak (COMDAT/`linkonce_odr`)** symbols so duplicates across TUs collapse instead of colliding. This is the actual implementation of the ODR-3 exemption in §1.6 — and the reason ODR violations there are silent: the linker's job is precisely to discard "duplicates" without comparing them.

Rules and hazards:
- Strong beats weak; among multiple weak definitions, the choice is unspecified (in practice: first encountered).
- Weak symbols disable some optimizations, since the definition visible at compile time may not be the one used.
- Not portable to Windows in the same form (Windows uses `/ALTERNATENAME` and COMDAT selection).
- Interaction with static libraries is subtle: a weak *reference* does not cause an archive member to be pulled in, so linking order can decide whether the feature is "present."

---

## Key Interview Questions

1. **What is a translation unit, and why can two TUs disagree about a type without any error?** — TU = source + expanded includes; the compiler never compares TUs, and the linker sees only mangled names, so layout disagreements are IFNDR.
2. **What does `inline` actually do?** — Relaxes the ODR to permit one definition per TU with linker deduplication; inlining as an optimization is a separate, heuristic decision.
3. **Why does `static const int` in a header behave differently in C and C++?** — In C++ namespace-scope `const` has internal linkage; in C it's external, so headers would produce duplicate symbols.
4. **Explain the static initialization order fiasco and two fixes.** — Cross-TU dynamic init order is unspecified; fix with function-local statics (Construct On First Use) or `constinit`/constant initialization.
5. **Why does link order matter for static libraries but not object files?** — Archives contribute only members that resolve currently-undefined symbols, processed left to right.
6. **Why do self-registering objects vanish when moved into a static library?** — Nothing references them, so their object file is never extracted; needs `--whole-archive` or an explicit reference.
7. **What is name mangling and why is `extern "C"` needed?** — Signature encoding for the linker; `extern "C"` disables it for C interop and `dlsym`, at the cost of overloading.
8. **Why can't you catch an exception thrown by another shared library sometimes?** — Type identity relies on RTTI symbol identity; `-fvisibility=hidden` on the exception type gives each module its own typeinfo.
9. **What is the difference between linkage, scope, storage duration, and visibility?** — Entity identity across declarations; source region of lookup; memory lifetime; loader-level export control. Independent axes.
10. **Why is `-fvisibility=hidden` recommended for shared libraries?** — Smaller symbol tables, faster loading, defined API surface, and enables direct calls/inlining by removing interposition.
11. **When would you choose static over dynamic linking?** — Deterministic deployment, best startup and call performance, whole-program optimization; give up shared-memory savings and independent security patching.
12. **What are the 9 phases of translation, and name one observable consequence of the ordering.** — E.g. line splicing before comment removal makes a trailing `\` in a `//` comment swallow the next line.

---

## Common Traps

- **Believing `inline` controls inlining.** It controls linkage and ODR.
- **Assuming `#pragma once` is always safe.** Symlinks/hard links/duplicate build roots can defeat file identity.
- **Forgetting that inconsistent `-D` flags are ODR violations,** not just build hygiene — debug/release mixing corrupts memory.
- **Using `static` for a function in a header** and expecting a single shared function-local `static` counter. You get one per TU.
- **Bare `#if FEATURE` with a typo'd name** silently evaluating to false; use `#if defined(...)` and `-Wundef`.
- **Macro double-evaluation** (`MAX(i++, j)`) and missing parentheses (`SQ(1+2)`).
- **Most vexing parse:** `Widget w();` is a function declaration.
- **Expecting cross-TU dynamic initialization order to be defined.** It isn't; only within-TU order is.
- **Returning a reference/pointer to an automatic object.**
- **Assuming `extern "C"` functions can be overloaded** or that exceptions may cross them.
- **Anonymous-namespace types leaking into inline/template signatures** → ODR violation with identical tokens.
- **Assuming a class type is complete after a forward declaration** — no `sizeof`, no members, no by-value use.
- **Forward-declaring `std::string`/`std::vector` yourself** instead of including the real header.
- **Assuming symbols are hidden by default on Linux** as they are on Windows.
- **Passing ownership of allocations across DLL boundaries** with different CRTs.

---

## Compact Recall Summary

**Model.** Source + includes → preprocessed **TU** → object file → linker → program. 9 translation phases; the fusion of "textual include" and "independent compilation" produces every hazard in this chapter.

**Preprocessor.** Token-level, type-blind, scope-blind. Guards (`#pragma once` or prefixed `#ifndef`), `#`/`##` need double indirection, `__VA_OPT__` for variadics, `-Wundef` against typo'd `#if`. Prefer `constexpr`/templates/`if constexpr`.

**Declaration vs definition.** Declaration = name + type; definition = the entity. Incomplete types allow pointers/references only. Declare in headers, define once — except classes, `inline` entities, and templates.

**ODR.** One definition per TU; exactly one per program for non-inline entities; identical token sequences and identical name resolution for the multi-definition-permitted set. Violations of the third clause are **IFNDR** — silent. Root causes: flag skew, ABI mixing, anonymous-namespace leakage.

**Linkage.** none / internal (`static`, anonymous namespace, namespace-scope `const` in C++) / external / module. Independent of scope, storage duration, and visibility.

**Storage duration.** automatic / static / thread / dynamic. Static init = zero-init + constant-init (load time), then dynamic init (ordered within a TU, unspecified across TUs) → fiasco → Construct On First Use, thread-safe since C++11.

**`inline`.** ODR exemption + COMDAT/weak emission + linker dedup. Enables cross-TU inlining by making bodies visible. `inline` variables (C++17) give header-only globals. `static` in a header is not a substitute.

**Mangling.** Signature → flat symbol name; ABI-specific (Itanium vs MSVC). `extern "C"` disables it for C interop, `dlsym`, and plugin ABIs; costs overloading and forbids escaping exceptions.

**Libraries.** Static archives contribute only needed members (link order matters; self-registration breaks). Shared objects need `-fPIC`, resolve through PLT/GOT, and demand ABI stability (soname, symbol versioning).

**Visibility.** ELF defaults to exporting everything; use `-fvisibility=hidden` plus explicit export macros — but keep exception types and polymorphic bases at `default` visibility or RTTI identity breaks across modules. Weak symbols enable defaults, optional deps, and are the mechanism by which template/inline duplicates are silently collapsed.
