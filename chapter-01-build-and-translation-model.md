# Chapter 1 — Build and Translation Model

C++ is compiled in pieces. That fact explains most build failures that survive parsing: a source file can compile because it saw a declaration, yet the program can fail to link because no matching definition exists. More dangerously, every source file can compile and the program can link even though different pieces were compiled against incompatible definitions.

For interview purposes, use one governing model:

> Preprocessing forms translation units; each translation unit is compiled independently; the linker resolves implementation-level references between the resulting object files; the C++ One Definition Rule makes the independently compiled pieces one coherent program.

The C++ standard specifies translation and program rules. It does not require `.o` files, archives, ELF, PE/COFF, Mach-O, name mangling, a separate assembler, or a particular linker. Those are dominant toolchain mechanisms, and a low-latency engineer must understand them, but they are not language guarantees.

---

## 1.1 Why This Matters — Core

A build model is a correctness model before it is a compile-time concern. It determines whether:

- two components agree on the layout of an order message;
- a function declared in a header has one matching definition;
- a global is initialized before another global uses it;
- a header-only optimization obeys the One Definition Rule;
- a static archive contributes a registration object;
- a shared-library call performs work on its first invocation;
- a deployed binary loads the ABI-compatible library you tested.

These failures land at different stages. A missing header is normally a preprocessing failure. Calling an undeclared function is a compilation failure. Calling a declared but undefined function is usually a link failure. Loading an unavailable shared library is a load failure. An inconsistent class definition can be worse: the build may succeed and the program may have undefined behavior.

In a low-latency system, build choices also affect operational latency. Dynamic loading can add startup relocation and symbol-resolution work; lazy binding can move some of that work to the first call. Header-visible definitions and link-time optimization can expose more code to the optimizer, but they increase build cost and can grow hot instruction footprints. None of those mechanisms proves a performance outcome. Measure startup, steady-state latency, and tail latency on the actual binary, loader configuration, hardware, and workload.

### What a strong interview answer sounds like

A strong answer separates four layers:

1. **Language rule:** what the C++ abstract machine requires.
2. **Compiler action:** what one translation unit can be checked or optimized against.
3. **Linker/loader action:** how a particular ABI and object format connect binaries.
4. **Engineering consequence:** what fails, what it costs, and how to verify it.

“`inline` makes functions faster” mixes these layers and is wrong. “`inline` permits certain repeated definitions across translation units; actual call inlining is an optimization decision, and I would inspect generated code and benchmark the hot path” keeps them separate.

---

## 1.2 The 90-Second Screen — Core

Remember these six facts:

1. A **translation unit (TU)** is, informally, one source file after preprocessing has handled its inclusions and macros. TUs are compiled independently.
2. `#include` is token-level textual inclusion, not a symbol import. Include guards prevent repeated inclusion only within one preprocessing run.
3. A **declaration** provides enough information to use a name in permitted ways. A **definition** supplies the entity: function body, object storage, class layout, or another complete definition.
4. **Scope**, **linkage**, **storage duration**, and **symbol visibility** answer different questions. Never use them as synonyms.
5. The **One Definition Rule (ODR)** permits one program to be assembled from separate TUs. Some violations are diagnosed by the linker; others are ill-formed, no diagnostic required.
6. `inline` primarily changes definition and ODR rules. It does not command the optimizer to inline a call.

Be able to defend two decisions:

- **Header body or source-file body?** A header-visible body enables templates and optimization without LTO, but expands dependency, compile-time, code-size, and ODR risk. An out-of-line body narrows the interface and rebuild graph.
- **Static or dynamic library?** Static linking can simplify deployment and remove runtime-library lookup for that component; dynamic linking enables code sharing and independent replacement but adds ABI, loader, and version-management constraints.

Fast failure classification:

| Symptom | First question |
|---|---|
| Header not found or bad `#if` | What tokens did preprocessing produce? |
| Type or syntax error | What did this TU know at the point of use? |
| Undefined reference | Was there one link-visible, ABI-matching definition in the link? |
| Duplicate symbol | Did more than one strong definition enter the link? |
| Build succeeds, behavior changes with link order | Is there an ODR, weak-symbol, initialization-order, or interposition problem? |
| Executable starts on one host only | Which dynamic libraries, versions, search paths, and CPU requirements differ? |

---

## 1.3 From Source to Program — Core

The familiar preprocess–compile–assemble–link pipeline is a useful toolchain model:

```text
 quote.hpp ───────────────┐                 quote.cpp
                          v                     |
 quote.cpp ──> preprocess tokens ──> compile ──> assembly/IR ──> assemble ──> quote.o ──┐
                                                                                       |
 quote.hpp ───────────────┐                                                            +──> link ──> executable
                          v                     |                                      |
  main.cpp ──> preprocess tokens ──> compile ──> assembly/IR ──> assemble ──> main.o ──┘
```

Real compilers commonly fuse compilation and assembly, and LTO may place intermediate representation in an object container for later optimization. The C++ standard describes translation phases and a program; the separate commands below are a typical Unix-like interface, not a standard requirement:

```sh
c++ -std=c++23 -E main.cpp             # inspect preprocessed output
c++ -std=c++23 -S main.cpp             # emit target assembly
c++ -std=c++23 -c quote.cpp -o quote.o
c++ -std=c++23 -c main.cpp  -o main.o
c++ quote.o main.o -o quote_app
```

### A two-source-file build

The header is the shared contract:

```cpp
// quote.hpp
#ifndef BOOK_QUOTE_HPP
#define BOOK_QUOTE_HPP

#include <cstdint>

struct Quote {
    std::int64_t bid_ticks;
    std::int64_t ask_ticks;
};

[[nodiscard]] std::int64_t spread(const Quote& quote) noexcept;

#endif
```

One source file defines the operation:

```cpp
// quote.cpp
#include "quote.hpp"

std::int64_t spread(const Quote& quote) noexcept {
    return quote.ask_ticks - quote.bid_ticks;
}
```

The other source file calls it:

```cpp
// main.cpp
#include "quote.hpp"

#include <iostream>

int main() {
    const Quote quote{10'005, 10'008};
    std::cout << spread(quote) << '\n';
}
```

Both `.cpp` files include the same declaration of `spread` and definition of `Quote`. `main.cpp` can type-check the call without seeing the body of `spread`. A typical compiler emits a reference from `main.o`; `quote.o` contains the definition; the linker connects them.

This example establishes three boundaries:

- The compiler checks each TU using only declarations and definitions visible in that TU.
- The linker usually connects ABI-level names and addresses, not source-level intent.
- The ODR requires the repeated definition of `Quote` to be valid across TUs.

Change `quote.cpp` alone and an incremental build can recompile one TU, then relink. Change `quote.hpp` and both dependent TUs must normally be rebuilt. A build system that misses this dependency can combine a new `quote.o` with a stale `main.o` compiled against an old layout. That is why dependency tracking is part of correctness.

### What each stage contributes

| Stage | Input and output in a common toolchain | Typical failure | Low-latency relevance |
|---|---|---|---|
| Preprocess | Source text to preprocessed tokens/text | Missing include, malformed directive, `#error` | Macro consistency and rebuild fan-out |
| Compile | TU to assembly or IR | Syntax, type, access, template errors | Optimization sees one TU unless LTO expands scope |
| Assemble | Assembly to relocatable object | Invalid target instruction/directive | ISA and object-format selection |
| Link | Objects/libraries to executable or shared object | Undefined or duplicate symbols, relocation overflow | Layout, dead stripping, interposition, LTO |
| Load | Executable plus shared dependencies to process image | Missing/incompatible library or symbol | Startup relocation, lazy binding, page faults |

The load step is outside the source-to-binary phrase “compile and link,” but it belongs in the operational model. A binary that links is not necessarily deployable.

---

## 1.4 Source Files, Headers, and Translation Units — Core

A source file is a build input by convention. A header is also a source file in the standard’s broad sense; the `.cpp`, `.cc`, `.h`, and `.hpp` suffixes are tool conventions. What matters is how the build treats the file.

For a conventional header-based build:

```text
main.cpp + everything it includes + active macro state
                         |
                         v
              one preprocessing translation unit
                         |
                         v
                  one translation unit
```

The compiler does not compile a header once and share its parsed meaning automatically. If 300 TUs include a large header, a conventional build may preprocess and parse that material 300 times. Precompiled headers and C++20 modules change implementation strategy and dependency handling, but do not turn ordinary `#include` into a semantic import.

### `#include` is textual

Given:

```cpp
// limits.hpp
inline constexpr int max_orders = 1'024;
```

and:

```cpp
#include "limits.hpp"
static_assert(max_orders >= 256);
```

the directive behaves approximately as if the header’s preprocessing tokens appeared at the directive. Macro definitions active before the include can affect the header; macros introduced by the header can affect following code. Include order can therefore change a TU’s meaning.

The precise search paths for `#include "name"` and `#include <name>` are implementation-defined. Toolchains conventionally search the includer’s location first for quotes and configured system paths for angle brackets, but build flags and compilers differ. Treat the distinction as a build-system contract, not a portable language path algorithm.

### Headers should be self-sufficient

A public header should include or declare what it needs. If `orders.hpp` uses `std::uint64_t`, include `<cstdint>` rather than relying on a previous header to do so. A useful check is to include the header first in its implementation file:

```cpp
#include "orders.hpp"

#include <algorithm>
#include <vector>
```

If `orders.hpp` has a hidden dependency, this ordering exposes it. The same principle keeps macro state predictable and reduces accidental include-order coupling.

Forward declarations can reduce dependencies:

```cpp
class OrderBook;

void publish(const OrderBook&) noexcept;
```

A pointer or reference can usually be declared while the class is incomplete. Constructing the object, accessing members, deriving from it, using it as a by-value data member, or applying `sizeof` requires a complete type. Do not hand-write forward declarations for standard-library types; include the prescribed header or an official forwarding header such as `<iosfwd>`.

Forward declarations reduce parsing and rebuild fan-out, but can make ownership and lifetime less obvious. Choose them when the abstraction boundary is real, not merely to minimize include counts.

### Include guards prevent one-TU repetition

The portable pattern is:

```cpp
#ifndef TRADING_ORDER_ID_HPP
#define TRADING_ORDER_ID_HPP

struct OrderId {
    unsigned long long value;
};

#endif
```

The first inclusion defines the guard macro. A second inclusion during the same preprocessing run skips the body. It does **not** prevent the header from being included in another TU; repeated class, inline, and template definitions across TUs are governed by the ODR.

Guard names must be project-unique and must avoid identifiers reserved to the implementation. `#pragma once` is widely supported but not specified by C++23. It asks the implementation to identify that a physical header has already been included. Projects often choose it for brevity; portable libraries commonly retain macro guards. Using both is usually redundant.

Guards solve repeated inclusion, not circular design. If `a.hpp` and `b.hpp` include each other, a guard may prevent an infinite include loop while leaving one file with an incomplete declaration at the wrong point. Break the dependency using a forward declaration or a smaller shared interface.

### Header rules, costs, and traps

| Choice | Governing rule | Cost or benefit | Interview trap |
|---|---|---|---|
| Put a class definition in a header | Multiple valid ODR definitions are permitted under strict conditions | Consumers know layout; every dependent TU parses it | “The guard guarantees one definition in the program” |
| Put a non-`inline` function body in a header | Usually creates a definition in every including TU | Body visible, but program normally violates ODR | “The linker will always choose one safely” |
| Forward-declare a class | Incomplete-type uses are restricted | Smaller dependency edge; implementation hidden | Destroying an owning pointer where the type is incomplete |
| Use an include guard | Macro suppresses later body in the same preprocessing run | Prevents within-TU redefinition | Guard collision silently suppresses another header |
| Use `#pragma once` | Implementation extension | Concise; typically efficient | Calling it a C++23 guarantee |
| Change a widely included header | Dependents must see a consistent definition | Large rebuild; prevents stale ABI assumptions | Treating dependency files as optional optimization |

C++20 modules can provide compiled interfaces and restrict macro leakage, but their artifact formats and build procedures are implementation-specific. In C++23 code, they are an available language facility, not a universal replacement for every header or a guarantee of faster builds. Measure the toolchain and project.

---

## 1.5 Preprocessor, Conditional Compilation, and Translation Phases — Core

The preprocessor manipulates preprocessing tokens before C++ type checking. It has no C++ scope, overload resolution, templates, or object lifetime. That explains both its usefulness and its hazards.

### Prefer language facilities for values and functions

This macro evaluates one argument more than once:

```cpp
#define BOOK_MAX(a, b) ((a) > (b) ? (a) : (b))

// Undefined sequencing concerns or surprising increments can follow:
// const int result = BOOK_MAX(i++, limit);
```

Parentheses protect operator grouping but cannot prevent repeated evaluation. A function template evaluates each argument once:

```cpp
template<class T>
constexpr const T& max_value(const T& a, const T& b) {
    return a > b ? a : b;
}
```

The example has its own lifetime constraints when called with temporaries because it returns a reference; `std::max` has comparable concerns. The point is not that every replacement is trivial. The point is that C++ declarations express types, evaluation, and scope, while a macro does not.

Prefer:

- `inline constexpr` variables to object-like value macros;
- functions or templates to function-like macros;
- `enum class` to groups of integer macros;
- `if constexpr` when both alternatives can be represented in valid C++ source.

Macros remain appropriate for include guards, implementation-provided feature detection, conditional availability, and capturing spelling or source location when a language facility does not meet the need. C++20 `std::source_location` removes many logging-macro use cases.

### Conditional compilation changes the program before type checking

```cpp
#if defined(BOOK_ENABLE_METRICS)
void record_fill_latency(long long nanoseconds) noexcept;
#endif
```

An undefined identifier in a preprocessor `#if` expression is replaced with `0` after macro expansion. A misspelled feature name can silently disable code:

```cpp
#if BOOK_ENABLE_METRCIS  // typo; commonly false unless warnings catch it
#endif
```

Use `defined(...)`, enable warnings such as GCC/Clang `-Wundef` where available, and centralize configuration. Compiler flags are implementation-specific; the correctness principle is portable.

The highest-risk pattern lets a per-TU macro alter an externally shared definition:

```cpp
// message.hpp — dangerous configuration boundary
struct Message {
    int kind;
#if defined(BOOK_TRACE_BUILD)
    long long trace_id;
#endif
};
```

If some TUs define `BOOK_TRACE_BUILD` and others do not, `Message` has inconsistent definitions and layout. The build may succeed; crossing the boundary has undefined behavior. Configuration that changes public types, calling conventions, exception mode, alignment, or standard-library ABI must be consistent across every participating binary.

`#if` is still useful for truly unavailable platform declarations:

```cpp
#if defined(_WIN32)
// Windows-specific adapter
#elif defined(__linux__)
// Linux-specific adapter
#else
#error "Unsupported platform"
#endif
```

The platform macros here are implementation-provided, not standard C++ macros. Hide such branches behind a stable C++ interface so most code has one definition.

### The standard’s phases versus the everyday pipeline

The standard describes nine conceptual translation phases through C++23. Implementations may combine them as long as observable behavior conforms.

| Phase | Conceptual work | Useful consequence |
|---|---|---|
| 1 | Map source-file characters into the translation character set and normalize line endings as specified | Source encoding handling precedes tokenization |
| 2 | Splice a backslash followed by a newline | A trailing backslash can unexpectedly continue a directive or line comment |
| 3 | Form preprocessing tokens and whitespace; replace each comment with one space | Comments do not emerge later from macro expansion |
| 4 | Execute preprocessing directives, expand macros, and process included files | Include order and macro state affect the resulting TU |
| 5 | Convert character and string literal contents according to their associated encoding rules | Source spelling and execution representation are distinct concerns |
| 6 | Concatenate adjacent string-literal tokens | `"bid=" "100"` forms one literal |
| 7 | Convert preprocessing tokens to C++ tokens; perform syntactic and semantic analysis | Declarations, types, and expressions acquire C++ meaning |
| 8 | Determine and instantiate required templates as specified | Some errors arise only when a specialization is needed |
| 9 | Combine translation units and resolve external references | Program-wide ODR and linkage obligations matter |

The everyday “preprocess, compile, assemble, link” picture maps onto these phases only approximately. In particular, the standard does not have a language-level “emit ELF object” phase. This distinction matters in an interview: use standard phases to explain token-order effects, and toolchain stages to diagnose files, symbols, and relocations.

### Two phase-order puzzles

First:

```cpp
#define BOOK_SIDE bid
const char* label = "best " "BOOK_SIDE";
```

Macro names inside string literals are not expanded; adjacent string literals are concatenated later. `label` is `"best BOOK_SIDE"`, not `"best bid"`. Stringification requires a macro designed for it.

Second:

```cpp
// Do not write this:
// a comment ending in a backslash \
int hidden = 7;
```

Backslash-newline splicing occurs before comments are replaced. The next physical line becomes part of the line comment. This is uncommon but directly follows from phase order.

The consequence for production code is restraint: preprocessor behavior is global within a TU and often invisible in the final source view. When a build differs by host or flag, inspect preprocessed output and the exact compile command before guessing.

---

## 1.6 Declarations, Definitions, and `odr-use` — Core

A declaration introduces or redeclares a name and its type. A definition is a declaration that also defines the entity. “Provides storage” is a useful shortcut for variables, but definitions cover functions, classes, enumerations, and templates too.

```cpp
extern int session_count;       // variable declaration, not a definition
int session_count = 0;          // variable definition

int decode(char);               // function declaration
int decode(char c) { return c; }// function definition

class Feed;                     // class declaration; Feed is incomplete
class Feed { int fd_; };        // class definition

struct Stats {
    static int packets;         // declares the static data member
};
int Stats::packets = 0;         // defines it
```

Every definition is a declaration, but not every declaration is a definition. A declaration must be visible before a use that needs it. A required definition may live in another TU.

### The four-axis table

The following table maps common declarations to definition status, scope, linkage, and storage duration. Storage duration applies to objects, not functions or types.

| Source form | Declaration or definition? | Scope of name | Linkage | Storage duration |
|---|---|---|---|---|
| `extern int x;` at namespace scope | Declaration, normally not definition | Namespace | Usually external | `x`, once defined, has static duration |
| `int x = 0;` at namespace scope | Definition | Namespace | External by default | Static |
| `static int x = 0;` at namespace scope | Definition | Namespace | Internal | Static |
| `const int x = 1;` at namespace scope | Definition | Namespace | Internal by default in C++ | Static |
| `inline int x = 1;` at namespace scope | Inline definition | Namespace | External by default | Static |
| `void f();` at namespace scope | Function declaration | Namespace | External by default | Not applicable |
| `static void f() {}` at namespace scope | Function definition | Namespace | Internal | Not applicable |
| `int n = 0;` inside a block | Definition | Block | No linkage | Automatic |
| `static int n = 0;` inside a block | Definition | Block | No linkage | Static |
| `thread_local int n = 0;` at namespace scope | Definition | Namespace | External by default | Thread |
| `auto p = new int{0};` inside a block | Defines automatic pointer `p`; dynamically creates an `int` object | Block for `p` | No linkage for `p` | Automatic for `p`; dynamic for allocated `int` |

This table prevents common category errors:

- `static` at namespace scope changes linkage; `static` at block scope changes storage duration.
- A name can have block scope while its object has static storage duration.
- Dynamic allocation does not make the pointer variable itself dynamically stored.
- External linkage does not mean “stored outside the object” or “exported from a shared library.”

### When a definition is required

A compiler can compile:

```cpp
long long sequence();

long long next() {
    return sequence() + 1;
}
```

The declaration is enough to check the call. If `next` is retained in the program and calls `sequence`, a matching definition is needed in the program. A conventional linker reports an undefined reference if none is provided.

The standard uses **odr-use** to distinguish uses that require an object or non-inline function definition from some uses that need only a value known at compile time. The full wording is detailed. A reliable interview approximation is:

- calling a named function usually odr-uses it;
- taking an object’s address or binding a reference to it usually odr-uses it;
- reading a variable in a potentially evaluated expression usually odr-uses it;
- certain constant-expression uses can substitute a value without requiring storage.

```cpp
struct Limits {
    static const int depth = 16;
};

static_assert(Limits::depth == 16);     // value can be used as a constant
const int* address = &Limits::depth;    // odr-use: an object must exist
```

In older language modes, the address-taking line requires one out-of-class definition. In C++17 and later, a `constexpr` static data member is implicitly an inline variable:

```cpp
struct Limits {
    static constexpr int depth = 16;
};

const int* address = &Limits::depth; // valid; no separate definition needed
```

Do not reduce `odr-use` to “the optimizer emitted storage.” ODR requirements come from the abstract program before a dead-code or constant-folding optimization happens. Conversely, implementation dead stripping can remove unneeded machine code without changing the language-level rule.

---

## 1.7 The One Definition Rule — Core

Separate compilation is sound only if repeated declarations and definitions agree. The ODR is that agreement.

At interview depth, divide it into three cases:

1. Within one TU, a definable item has at most one definition.
2. A non-inline function or variable that is odr-used must have one definition in the program.
3. Some entities may have definitions in multiple TUs: class types, enumeration types, templates, and inline functions and variables are central examples. Their definitions must satisfy strict equivalence conditions, including matching token sequences and consistent name lookup, with additional rules for constants, lambdas, and internal/no-linkage entities.

There are refinements for named modules and specialized entities in C++20–23. The safe handbook rule is: put one canonical definition in one interface, compile every consumer with consistent configuration, and do not create a second spelling of the “same” type.

### Loud violations

Zero matching definitions commonly produces an undefined-reference error:

```cpp
// main.cpp
int risk_limit();

int main() {
    return risk_limit(); // declaration seen; no definition linked
}
```

Two ordinary external definitions commonly produce a duplicate-symbol error:

```cpp
// a.cpp
int risk_limit() { return 100; }

// b.cpp
int risk_limit() { return 200; }
```

The exact diagnostic and whether it occurs at traditional link time are implementation details. The language rule is not “the linker must catch this”; the program is ill-formed.

### Silent violations

The dangerous case is an entity for which multiple definitions are permitted only when the definitions agree:

```cpp
// packet.hpp
struct Packet {
    int type;
#if defined(BOOK_WITH_CAPTURE)
    long long capture_ns;
#endif
};

inline int packet_type(const Packet& packet) {
    return packet.type;
}
```

If `BOOK_WITH_CAPTURE` differs across TUs, both TUs can compile, and a conventional linker may have no reason to complain. Yet the program contains inconsistent definitions of `Packet`; the ODR is violated. The standard does not require a diagnostic for many cross-TU ODR violations. If the build accepts the program, behavior is undefined.

This is not “the linker picked the wrong layout.” Each compiler generated code under a different premise. A function in one TU may calculate an offset, size, alignment, copy length, or array stride that disagrees with another. The bug can emerge as data corruption far from the header.

### ODR decision procedure

When reviewing a multi-file definition, ask:

1. **May it have multiple definitions?** If not, place the definition in one source file.
2. **Are the definitions derived from one canonical header or module interface?**
3. **Can macros, include order, generated headers, pragmas, or compiler flags change its tokens or name lookup?**
4. **Do all binaries agree on ABI-relevant options?** Examples include packing, target ABI, standard-library debug mode, exception/RTTI expectations, and compiler ABI switches.
5. **Could stale objects remain after the interface changed?**
6. **Can CI build with another link order, LTO, sanitizers, or ODR-oriented diagnostics to expose disagreement?**

No single tool proves ODR compliance. Some sanitizers and LTO modes detect subsets; compiler and linker options vary. Reproducible commands, uniform configuration, complete dependency graphs, and clean rebuilds after ABI-affecting changes are the primary controls.

### What the linker normally cannot prove

A conventional linker can compare symbol names and object-format metadata. It does not generally prove that every TU used the same:

- class layout;
- inline body;
- default argument;
- exception specification;
- template meaning;
- packing state;
- compiler option set.

Debug information or LTO metadata can enable extra checks, but those remain toolchain facilities. Successful linking is evidence that references were resolved, not proof that the C++ program obeys the ODR.

---

## 1.8 Scope, Linkage, and Storage Duration — Core

These concepts are independent:

- **Scope:** where unqualified or qualified name lookup can find a declaration.
- **Linkage:** whether declarations in different scopes or TUs can denote the same entity.
- **Storage duration:** the minimum potential duration of an object’s storage.
- **Lifetime:** when an object exists in that storage as a particular type.
- **Visibility:** in object-file discussions, usually a platform rule controlling dynamic symbol exposure.

### Scope answers “where can I name it?”

Common scopes include namespace, class, block, function parameter, template parameter, and enumeration scopes. A local variable’s name stops being available after its block:

```cpp
void consume() {
    int batch = 8;
    {
        int batch = 16; // hides the outer name in this inner block
        (void)batch;
    }
    (void)batch;         // names the outer object again
}
```

Hiding changes lookup, not storage duration or linkage. Both `batch` objects have automatic storage duration and no linkage.

### Linkage answers “can declarations denote one entity?”

For the chapter’s main cases:

| Linkage | Meaning | Common source form |
|---|---|---|
| No linkage | Declarations outside the relevant scope cannot redeclare the same entity by linkage | Block locals, local classes, function parameters |
| Internal linkage | The name denotes one entity within one TU | Namespace-scope `static`; unnamed-namespace members; non-template non-`volatile` namespace-scope `const` unless adjusted |
| External linkage | Declarations can denote one entity across TUs | Ordinary namespace-scope functions and variables; many named types and templates |
| Module linkage | C++20 module-related declarations can denote an entity across units of one named module | Non-exported names attached to a named module, subject to module rules |

An unnamed namespace is the normal way to keep implementation names TU-local:

```cpp
namespace {
constexpr int bucket_count = 64;

int bucket_for(int id) noexcept {
    return id & (bucket_count - 1);
}
}
```

Each TU that includes such a definition gets distinct entities. Do not expose a TU-local type through an external inline or template interface whose repeated definitions are supposed to agree.

Namespace-scope `const` has a notable C++ default:

```cpp
const int local_depth = 16;          // internal linkage by default
extern const int shared_depth = 16;  // definition with external linkage
```

If the first line is in a header, every TU has a distinct object if storage is needed. Use `inline constexpr` when the design requires one ODR entity defined in the header:

```cpp
inline constexpr int shared_depth = 16;
```

### Storage duration answers “how long can the storage exist?”

| Duration | Typical object | Begins/ends conceptually | Latency concern |
|---|---|---|---|
| Automatic | Non-static block local, parameter | On block/function activation; released on exit | Usually no allocator call; initialization and destruction can still cost |
| Static | Namespace object, static data member, block `static` | Storage spans program execution | Initialization order, first-use guard, shutdown order |
| Thread | `thread_local` object | Per thread | Access model and thread-start/exit work are implementation-dependent |
| Dynamic | Object created in allocated storage | Controlled by allocation/construction and destruction/deallocation | Allocator contention, cache misses, fragmentation, tail latency |

Do not say “stack is always fast.” Automatic storage commonly uses a stack, but the standard does not require one; constructing a large or complex automatic object can be expensive. Similarly, dynamic storage duration does not require the global heap or a system call on every allocation; an arena can provide dynamic storage from preallocated memory.

Storage duration and lifetime differ. Raw storage may exist before an object’s lifetime begins and after it ends. That distinction becomes important in allocator, union, and object-model work.

### Static initialization is a correctness and latency boundary

Objects with static storage duration are first zero-initialized; constant initialization occurs where its requirements are met. Other initialization is dynamic and may execute code. Ordering across TUs is nuanced and often not a safe dependency mechanism.

Use `constinit` to require static initialization of a variable:

```cpp
constinit int feed_count = 0;
```

`constinit` does not make the object constant. It rejects an initializer that would require disallowed dynamic initialization, helping move surprise work out of startup.

A block-local static gives construction on first control passage, with thread-safe initialization since C++11:

```cpp
class Registry {
public:
    void add(int);
};

Registry& registry() {
    static Registry instance;
    return instance;
}
```

This avoids a cross-TU initialization dependency, but it can put synchronization and constructor work on the first caller. For a latency-sensitive path, initialize deliberately during startup and warm the exact operation, then measure. Compiler switches that disable thread-safe statics weaken the language guarantee and are non-portable; do not use them casually.

`thread_local` can remove sharing between worker threads, but its access and initialization costs depend on TLS model, linkage, loader arrangement, and platform. Inspect generated code and benchmark the deployed form instead of assuming it is equivalent to an ordinary register or stack access.

---

## 1.9 Inline Functions and Variables — Core

`inline` permits an entity to be defined in multiple TUs under ODR conditions. For an inline function or variable with external or module linkage, its definition must be reachable in each TU where it is declared and odr-used, and it represents one entity with one address as required by the language rules.

```cpp
// price_math.hpp
#ifndef BOOK_PRICE_MATH_HPP
#define BOOK_PRICE_MATH_HPP

inline constexpr long long ticks_per_unit = 10'000;

[[nodiscard]] inline long long to_ticks(long long units) noexcept {
    return units * ticks_per_unit;
}

#endif
```

This is valid in many TUs if the definitions satisfy the ODR. A typical ABI emits coalescible COMDAT/weak-like sections so the linker can retain one out-of-line copy when needed, but that is an implementation technique, not the definition of `inline`.

### Inline in the language versus call inlining

The optimizer may inline a call to a function that lacks the `inline` specifier. It may also retain an actual call to a function declared `inline`. Decisions depend on optimization settings, profile data, body size, target, visibility, and surrounding code.

The indirect relationship is visibility of the body:

- A body in a header is available to each compiling TU, enabling local call-site optimization.
- A body in another TU is normally unavailable during ordinary compilation.
- LTO can make bodies available across TU boundaries without placing every body in a public header.

For low-latency code, call inlining can remove call/return overhead and expose constants, aliases, and branches to further optimization. It can also increase machine-code size and instruction-cache pressure. Confirm with compiler optimization remarks or disassembly, then benchmark representative instruction working sets and report tail as well as typical latency.

### Inline variables solve header-defined shared state, not design

Before C++17, a non-`const` global in a header normally caused multiple definitions. An inline variable permits a header definition:

```cpp
inline std::atomic<unsigned long long> packets_seen{0};
```

The ODR issue is solved; contention is not. Every worker updating this one cache line can create coherence traffic. Prefer per-thread or sharded counters if the workload permits, and merge off the hot path. The linkage mechanism and the runtime sharing design are separate decisions.

### `static inline` changes identity

```cpp
// counter.hpp
static inline int next_local_id() {
    static int value = 0;
    return ++value;
}
```

The namespace-scope function name has internal linkage because of `static`. Each TU has a separate function and a separate function-local `value`. Remove `static`, leaving a valid external inline definition, and the function-local static denotes one object shared across all TUs. Both forms compile; they express different identity and synchronization.

Implicitly inline cases include functions defined inside class definitions and `constexpr`/`consteval` functions. `constexpr` static data members are inline variables since C++17. Templates have their own multiple-definition provisions; do not explain them merely as “implicitly inline.”

---

## 1.10 Object Files, Symbols, and Relocation — Core

The standard stops at translation units and the program. Mainstream native toolchains represent separately compiled output as **relocatable object files**. ELF is common on Linux, Mach-O on Apple platforms, and PE/COFF on Windows. Details below are ABI and toolchain behavior.

A relocatable object commonly contains:

- machine-code and read-only-data sections;
- writable and zero-initialized data sections;
- a symbol table describing defined and unresolved names;
- relocation records identifying locations whose final address is not yet known;
- optional debug, unwind, exception, and LTO information.

For the two-source example, a simplified view is:

```text
main.o
  text: main machine code
  defined symbol: main
  undefined symbol: spread(Quote const&)
  relocation: patch call site to resolved spread address

quote.o
  text: spread machine code
  defined symbol: spread(Quote const&)

linker
  chooses output addresses
  resolves the reference to the definition
  applies or preserves the relocation
```

A **symbol** is an object-format name plus attributes such as binding, type, section, size, visibility, or version, depending on the format. The linker does not generally reason from the original C++ type system. It acts on the ABI encoding and metadata the compiler emitted.

A **relocation** says, approximately, “once the address of this target is known, adjust these bytes using this relocation kind.” Some references can be resolved by a static link. Others remain for the dynamic loader, often through indirection tables or stubs.

Useful inspection commands are platform-specific:

```sh
nm -C main.o
objdump -dr main.o
readelf -Ws quote.o
```

On macOS, `otool` and Apple’s `nm` are typical; on Windows, `dumpbin` is common. `-C` requests C++ demangling where supported.

### Worked symbol prediction

Suppose `main.o` calls `spread` and the final link omits `quote.o`.

1. `main.cpp` compiled because `quote.hpp` declared `spread`.
2. `main.o` therefore contains code for a call plus an unresolved reference.
3. No linked input defines an ABI-matching symbol.
4. The linker cannot apply the call relocation.
5. It reports an undefined symbol/reference.

Now suppose `quote.cpp` accidentally defines:

```cpp
long spread(const Quote& quote) noexcept {
    return static_cast<long>(quote.ask_ticks - quote.bid_ticks);
}
```

while the header declares:

```cpp
long long spread(const Quote&) noexcept;
```

On many C++ ABIs, non-template function return types are not encoded in the mangled name. If the mismatched definition was created without including the header, the linker may connect the call despite incompatible source-level types. The program then violates its language contract, and behavior depends on the ABI mismatch. This is why an implementation file must include its own header first: the compiler, not the linker, should compare declaration and definition.

That is a high-yield interview lesson: name mangling detects many signature mismatches, not every possible type disagreement.

---

## 1.11 Worked Diagnosis: Compile, Link, Load, or ODR? — Core

Consider a service update that produces:

```text
undefined reference to `book::apply(book::Update const&)'
```

Use a staged diagnosis instead of adding libraries at random.

### Step 1: Confirm what the caller requested

Demangle the diagnostic if necessary. Check the exact namespace, class, parameter types, cv/ref qualifiers, and sometimes ABI tags. Compare the declaration visible to the caller with the intended interface.

Ask whether the call is compiled conditionally or whether a stale generated header declared an older signature.

### Step 2: Inspect candidate definitions

Use the platform’s symbol tool on object files and libraries. There are four common outcomes:

| Observation | Likely cause | Next action |
|---|---|---|
| No candidate library contains the definition | Source omitted, feature disabled, dead build target | Fix target sources/configuration |
| Object contains matching definition, final link omits object | Link line or archive extraction issue | Fix dependency/order or explicit anchor |
| Object contains a similar but differently mangled definition | Declaration/definition or ABI mismatch | Include canonical header; align flags and signatures |
| Dynamic library exports it, loader cannot find/version it | Search path, soname/import, visibility, or version issue | Inspect runtime dependency resolution |

### Step 3: Check archive extraction

An object file named directly on the link line normally participates. A static archive is searched according to linker rules and may contribute only members needed to resolve unresolved symbols at that point. GNU-like linkers traditionally process archives left to right:

```sh
c++ main.o -lconsumer -lprovider
```

can work when `consumer` needs `provider`, while the reverse order can fail. Linker groups or repeated libraries handle cycles on some toolchains, but better component boundaries avoid them.

### Step 4: Separate symbol resolution from ODR correctness

If the symbol exists and the build succeeds, do not conclude that all TUs agreed. A changed struct layout, packing pragma, inline body, or macro can produce a silent ODR/ABI fault.

A useful clean-room test is:

1. record every compile and link command;
2. remove stale build artifacts using the build system’s safe clean mechanism;
3. rebuild with uniform flags;
4. inspect preprocessed output for disagreeing TUs;
5. compare symbol and layout diagnostics where available;
6. enable LTO or relevant sanitizers in CI as additional detectors, not proofs.

### A realistic ODR failure

Assume a feed-handler library and executable share:

```cpp
struct Update {
    std::uint32_t instrument;
    std::uint32_t quantity;
#if defined(BOOK_CAPTURE_TIMESTAMP)
    std::uint64_t capture_ns;
#endif
};
```

Only the library is rebuilt with `BOOK_CAPTURE_TIMESTAMP`.

- The library compiles with `sizeof(Update)` commonly 16 on an ABI aligning `std::uint64_t` to 8 bytes.
- The stale executable commonly assumes 8.
- The linker sees the same function symbol if layout is not encoded in the name.
- An array stride, by-value copy, or field access can now disagree.

The exact sizes are ABI-dependent; use `static_assert` only when the external protocol or ABI truly requires a layout, and assert offsets/alignment as well as size. Better, serialize through a stable wire representation and ensure all C++ components rebuild when the interface changes.

This bug threatens correctness and tail latency: corruption may trigger rare error handling, allocator activity, or process failure. Do not frame ODR discipline as compile-time housekeeping.

---

## 1.12 Static and Dynamic Libraries — Role-specific

Libraries package compiled code; they do not change the C++ ODR. Two copies of a prohibited definition remain invalid even if they arrived through different libraries.

### Static archives

A static library (`.a` on many Unix-like platforms, often `.lib` on Windows) is commonly an archive of object files plus an index. Traditional linkers extract an archive member when it satisfies an unresolved reference.

This creates a registration trap:

```cpp
// venue_x.cpp
namespace {
const bool registered = register_venue("X");
}
```

If the object file contains no symbol requested by the rest of the link, the archive member may never be extracted, so the initializer never appears in the executable. Solutions include:

- reference an explicit registration function;
- generate and call a registry table;
- request whole-archive/force-load behavior for a tightly scoped library.

The flags are linker-specific. Explicit registration is usually easier to reason about and test. Whole-archive can increase binary size and introduce duplicate definitions.

Static linking can provide:

- a self-contained component version in the executable;
- no runtime search for that library;
- opportunities for dead stripping and, with suitable LTO, cross-component optimization.

It can cost:

- larger on-disk and memory footprint across multiple processes;
- relinking/redeploying to patch a dependency;
- license or platform restrictions;
- duplicated library state if several static copies enter different shared objects;
- archive-order and hidden-registration surprises.

“Static calls are always direct” is not guaranteed. Interposition, code model, function pointers, visibility, and linker choices matter. Inspect the final binary.

### Dynamic/shared libraries

A shared object (`.so`, `.dylib`, or `.dll`, depending on platform) is mapped and connected by a loader. The details differ sharply:

- ELF systems commonly use GOT/PLT mechanisms and may support symbol interposition.
- Mach-O uses its own binding and stub machinery.
- Windows DLLs commonly use import tables and explicit export/import controls.

Position-independent code, relocation, symbol lookup, lazy/eager binding, and library search paths are platform mechanisms, not C++ rules.

| Dimension | Static archive in executable | Shared library |
|---|---|---|
| Version selected | Usually fixed at link/rebuild | Selected under loader and deployment rules |
| Startup | No load of that separate shared object | Mapping, relocation, constructors, and binding may add work |
| First call | No lazy dynamic binding for that library | May pay lazy-binding cost on configurations that use it |
| Code sharing | Each linked artifact has its own code pages | Read-only pages can often be shared across processes |
| Optimization boundary | LTO may cross it if compatible IR is available | Normally an ABI boundary |
| Patch model | Relink and redeploy consumers | Replace compatible library independently |
| Main risk | duplication, archive extraction, rebuild scope | ABI/version skew, search path, exported surface |

For a low-latency process, a defensible policy is:

1. identify which components lie on startup and hot-call paths;
2. decide whether independent replacement is required;
3. pin exact dependency versions and loader paths;
4. force eager binding or warm calls if the platform supports it and first-hit jitter matters;
5. measure process startup, first call, steady-state distribution, page faults, and instruction footprint;
6. retain a rollback path.

Fully static executables are not universally available or desirable. Some operating-system services, runtime components, security update models, and licenses constrain them.

### ABI is the shared-library contract

Source compatibility is insufficient. Changing any of these can break existing consumers:

- exported function signature or calling convention;
- class size, alignment, data-member order, or base classes;
- virtual function set or order under an ABI;
- exception or RTTI boundary expectations;
- allocator/runtime ownership across the boundary;
- inline implementation or template instantiation compiled into consumers;
- standard-library type layout or compiler ABI mode.

A C-shaped boundary with opaque handles and explicit create/destroy functions reduces, but does not eliminate, ABI risk. The interface still needs versioning, ownership, threading, error, and lifetime rules.

---

## 1.13 Language Linkage, Name Mangling, and `extern "C"` — Role-specific

C++ permits overloaded functions, namespaces, member functions, and templates. A linker symbol therefore needs some ABI-specific way to distinguish source-level entities. Most native C++ ABIs use **name mangling**.

For example, an Itanium C++ ABI toolchain might encode:

```cpp
namespace book {
void publish(int);
void publish(double);
}
```

as two different symbol strings. MSVC uses a different scheme. C++23 does not specify either spelling. Compatibility requires agreement on compiler ABI, target architecture, calling conventions, standard-library ABI, and relevant options—not merely using the same function declaration.

### Language linkage is a language property

`extern "C"` specifies C language linkage for function types and function names in the cases defined by the standard:

```cpp
extern "C" int book_start() noexcept;
```

A typical implementation emits a stable C-style external name rather than its C++ mangling. It does not:

- make the body compile as C;
- permit function overloading at that exported name;
- specify every platform calling-convention detail;
- create a portable C ABI for C++ classes, exceptions, or standard-library types;
- force dynamic-symbol export on every platform.

The body may use C++ internally:

```cpp
extern "C" int book_start() noexcept {
    try {
        // Construct C++ objects and initialize the service.
        return 0;
    } catch (...) {
        return -1;
    }
}
```

Catch exceptions at a C-facing boundary. Whether a particular unwinder can cross frames compiled as C is an ABI matter; C callers have no portable C++ exception contract. `noexcept` plus internal translation to an error code makes the interface explicit.

### A portable header shared with C

```c
#ifndef BOOK_API_H
#define BOOK_API_H

#ifdef __cplusplus
extern "C" {
#endif

struct book_handle;

int book_create(struct book_handle** out);
void book_destroy(struct book_handle* handle);

#ifdef __cplusplus
}
#endif

#endif
```

The opaque `book_handle` hides C++ layout. The implementation must still specify:

- which function allocates and frees the handle;
- whether null is accepted;
- thread-safety and reentrancy;
- error-code meanings;
- version negotiation;
- whether callbacks may block or throw;
- ownership of buffers and strings.

On Windows, an export annotation may also be required. On ELF, visibility settings or a version script can control export. Those are separate from language linkage.

### Diagnose a mangled-name failure

When an undefined symbol contains a long encoded name:

1. demangle it using the platform tool;
2. compare the result with the intended declaration;
3. inspect candidate libraries for the exact encoded or demangled symbol;
4. check architecture and ABI tags;
5. check that the library is actually included and visible;
6. only then change link order or libraries.

`extern "C"` is not a general cure for linker errors. It deliberately removes overloading at the boundary and should be used for C interoperability or a deliberately stable entry point.

---

## 1.14 Symbol Visibility and Weak Symbols — Deep dive

**Symbol visibility** is an object-format and platform concept controlling whether a definition is exposed outside a shared object and, on some systems, whether it can be preempted. It is not C++ scope or linkage.

On common ELF toolchains:

- default visibility exposes a symbol to dynamic lookup and may allow interposition;
- hidden visibility keeps it within the shared object;
- protected and internal modes have additional platform-specific semantics.

Mach-O and PE/COFF provide different controls. Attributes such as:

```cpp
__attribute__((visibility("default")))
```

and flags such as `-fvisibility=hidden` are compiler extensions, not C++23 syntax. Windows commonly uses `__declspec(dllexport)` and `__declspec(dllimport)`.

### Why reduce the exported surface?

An explicit export allowlist can:

- prevent accidental ABI commitments;
- reduce dynamic symbol and relocation work;
- enable direct binding or optimization for internal calls on some toolchains;
- reduce collision and interposition risk;
- make compatibility review tractable.

It can also break runtime lookup, plugins, RTTI, exception matching, or cross-library type identity if a required symbol or type metadata becomes hidden. Export the complete intended boundary and test it as a separately built consumer.

Visibility affects potential latency through named mechanisms—dynamic lookup, indirection, relocation, and optimization barriers—but the size of the effect is binary- and platform-specific. Compare symbol tables, relocations, disassembly, startup traces, and latency measurements before claiming a win.

### Weak symbols are not the ODR

Many object formats/toolchains support **weak definitions**. A strong definition can override a weak one without the ordinary duplicate-definition diagnostic. An unresolved weak reference may have a null/zero result. Syntax and semantics vary by platform:

```cpp
// GNU/Clang extension; not portable C++23.
extern "C" void optional_probe() __attribute__((weak));

void maybe_probe() {
    if (optional_probe != nullptr) {
        optional_probe();
    }
}
```

Typical uses include optional hooks, default embedded interrupt handlers, and toolchain emission of coalescible inline/template material. COMDAT selection provides related deduplication mechanisms.

Hazards:

- the winner among several weak definitions can depend on toolchain and link order;
- a weak reference may not cause a static archive member to be extracted;
- interposition can prevent assumptions about which body is called;
- behavior differs across ELF, Mach-O, and PE/COFF;
- weak machinery does not legalize conflicting C++ definitions.

If two inline definitions differ, “the linker chose one weak copy” describes a possible implementation outcome, not a valid program. The ODR remains the correctness rule.

For latency-sensitive optional instrumentation, a weak hook can remove an explicit registration system, but the branch, interposition, and deployment ambiguity may be worse than a stable function pointer initialized at startup. Measure both and prefer the mechanism with an explicit lifecycle.

---

## 1.15 Engineering Choices for a Low-Latency Build — Role-specific

The build model becomes useful when it guides decisions rather than trivia.

### Choice 1: Move a hot function into a header?

**Condition:** profiling and generated code show call overhead or missed constant propagation on an important path.

**Potential benefit:** body visibility enables per-TU inlining and specialization without LTO.

**Costs:** more parsing, larger rebuild fan-out, possible code growth, ABI behavior compiled into every consumer, and stricter exposure to macro-driven ODR disagreement.

**Alternative:** keep it out of line and enable compatible LTO or profile-guided optimization.

**Success measure:** benchmark end-to-end latency distribution on the intended CPU; inspect call removal and instruction footprint. Roll back if p99/p99.9 or build time worsens.

### Choice 2: Hide most shared-library symbols?

**Condition:** the library has a small, controlled external API.

**Potential benefit:** smaller exported surface, fewer preemptible calls, less relocation/symbol work, and better optimization on supported platforms.

**Costs:** explicit export annotations/version scripts; risk of hiding plugin, RTTI, exception, or factory symbols.

**Success measure:** ABI test against an independently compiled consumer; compare dynamic symbol/relocation counts, startup, and hot-call code generation.

### Choice 3: Prefer static linking for a trading service?

**Condition:** reproducible deployment and first-hit predictability matter more than independent library replacement, and platform/licensing constraints permit it.

**Potential benefit:** dependency versions are baked into one artifact; no dynamic lookup for statically included components; LTO opportunities.

**Costs:** larger artifacts, duplicated pages across processes, relink/redeploy for security fixes, possible duplicated state, archive extraction surprises.

**Success measure:** deployment reproducibility plus cold-start, warmed steady-state, page-fault, RSS, and tail-latency measurements. Keep the dynamic build as rollback if operational cost grows.

### Choice 4: Use compile-time configuration to change layout?

Usually do not do this across component boundaries. If unavoidable:

- generate one configuration header;
- make every TU and dependent library consume it;
- encode a version or layout signature at the boundary;
- force complete rebuilds when it changes;
- add `static_assert` checks for externally specified properties;
- reject mismatched versions during startup.

The benefit may be smaller or feature-specialized objects. The cost is combinatorial binary variants and silent ODR/ABI risk. A runtime branch outside the hot loop is often a safer trade.

### Choice 5: Add LTO?

LTO can optimize across source-file and static-library boundaries when compatible IR is present. It can improve inlining, devirtualization, constant propagation, and dead removal. It can also increase link time and memory, alter layout, expose latent ODR bugs, and grow or shrink code in workload-dependent ways.

Treat ThinLTO, full LTO, and vendor variants as toolchain modes, not language features. Compare clean/incremental build cost, binary size, symbols, instruction-cache behavior, and latency. Preserve non-LTO builds in CI because toolchain diversity catches different assumptions.

---

## 1.16 Recall and Practice — Core

### Recall card

- A TU is independently compiled preprocessed source; ordinary headers are textually included.
- Include guards prevent repeated inclusion within one preprocessing run, not across the program.
- Declarations let a TU type-check; required definitions make the complete program valid.
- ODR violations can be loud link failures or silent undefined behavior with no required diagnostic.
- Scope controls lookup; linkage controls identity across declarations; storage duration controls storage; lifetime controls object existence; visibility controls platform-level export.
- `inline` permits repeated ODR definitions. Call inlining is an optimizer choice.
- Object files, symbols, relocations, archives, shared objects, mangling, and weak definitions are common ABI/toolchain mechanisms, not C++ abstract-machine requirements.
- Static archives extract members under linker rules; unreferenced self-registration can disappear.
- Dynamic libraries add an ABI and loader boundary. Warm-up and eager binding can move work, but only measurement establishes latency.
- `extern "C"` specifies language linkage; it does not export a symbol everywhere or make C++ classes into a portable C ABI.

### Common interview traps

| Trap | Better answer |
|---|---|
| “Each header is compiled once.” | Each conventional TU preprocesses and parses included headers; PCH/modules can change the implementation. |
| “`static` means one thing.” | At namespace scope it commonly gives internal linkage; at block scope it gives static storage duration; as a class member it has another role. |
| “The linker checks types.” | The compiler checks visible declarations; the linker usually operates on ABI names and metadata. Some mismatches mangle differently, others do not. |
| “Include guards enforce the ODR.” | They prevent repeat inclusion within one TU. Cross-TU validity is still governed by the ODR. |
| “Inline functions are faster.” | The specifier changes definition rules; inspect optimization and measure call-site performance. |
| “Static linking removes all indirection.” | It removes dynamic lookup for that component; final calls still depend on code generation, pointers, visibility, and ABI. |
| “A successful link proves one valid definition.” | Some ODR violations require no diagnostic and link successfully. |
| “`extern "C"` is the C ABI.” | It supplies C language linkage; calling convention, layout, export, ownership, and error rules remain platform/interface concerns. |

### Prediction and diagnosis questions

1. `api.hpp` declares `int parse(const char*)`, while `api.cpp` defines `int parse(char*)` without including the header. Why can both source files compile, and what is the likely link result?
2. A header defines `int limit = 100;` and is included by ten TUs. Which rule is violated? Give two valid designs with different identity semantics.
3. A header defines `const int limit = 100;`. Why does this usually avoid a duplicate external symbol in C++, and why might comparing `&limit` across TUs surprise you?
4. Two TUs see different members in the same class because one defines a feature macro. Why is a clean link not reassuring?
5. Explain `static int counter` inside a function using scope, linkage, storage duration, lifetime, and initialization timing.
6. A plugin registers through a namespace-scope object. It works as a direct object input but disappears when placed in a static archive. Predict the linker’s reasoning and propose a deterministic fix.
7. A shared-library function causes one latency spike on its first call. Name at least three mechanisms to investigate and one measurement for each.
8. Why can changing only a function’s return type be especially dangerous if its implementation does not include the canonical header?
9. Compare a header-visible hot function with an out-of-line function plus LTO. What evidence would decide between them?
10. A DLL/shared object exposes a C++ class containing `std::string`. List the ABI assumptions this leaks and redesign the boundary.
11. Why can hidden visibility improve optimization on one platform yet break an exception or RTTI boundary?
12. Distinguish a weak symbol from a C++ inline definition. Why does the former not repair an ODR violation?

### Code-reading exercise

```cpp
// counter.hpp
#ifndef BOOK_COUNTER_HPP
#define BOOK_COUNTER_HPP

inline int next_id() {
    static int id = 0;
    return ++id;
}

#endif
```

TU A and TU B both include the header. A call in TU A returns `1`; the next call in TU B returns `2`, because the valid external inline function has one function-local static object across the program.

Now change the function to:

```cpp
static inline int next_id() {
    static int id = 0;
    return ++id;
}
```

The namespace-scope `static` gives the function internal linkage. Each TU has its own function and local static, so the first call in each TU returns `1`. This is a semantic identity change, not an optimization tweak.

The examples are single-threaded. Concurrent increments would create a data race; thread-safe initialization of the local static does not make later `++id` operations atomic.

### Hands-on build exercise

Using the `quote.hpp`, `quote.cpp`, and `main.cpp` example:

1. Preprocess `main.cpp`. Locate the included `Quote` definition and the `spread` declaration.
2. Compile both TUs separately. Inspect defined and unresolved symbols with the platform’s symbol tool.
3. Link only `main.o`. Explain the undefined reference from declaration, definition, and relocation perspectives.
4. Link both objects. Confirm the program prints `3`.
5. Add a second ordinary definition of `spread` in `main.cpp`. Record the diagnostic and explain the ODR violation without relying on its exact wording.
6. Put an inconsistent inline definition behind different per-TU macros. Observe that a successful link does not make it valid.
7. Build a static archive containing `quote.o`; test how link order affects your toolchain.
8. If supported, build a shared library and compare its exported symbols, relocations, first-call behavior, and steady-state disassembly with the static form.

### Before Chapter 2

You should now be able to look at a declaration and answer:

- what entity it declares or defines;
- where the name is in scope;
- what linkage gives the entity its identity;
- what storage duration applies;
- whether another TU must supply a definition;
- which disagreement could survive the build.

Chapter 2 assumes this separation when it examines types and conversions across function and binary boundaries.
