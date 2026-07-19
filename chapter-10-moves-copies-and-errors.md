# Chapter 10 — Moves Copies and Errors

*Interview-focused revision notes. The theme: both halves of this chapter are about what happens on the paths you did not write — the copy the compiler elided or silently reintroduced, and the unwind that runs when a function does not return normally. Cost and correctness both live on those paths.*

---

## 10.1 RVO and NRVO

**Copy elision** is the compiler's permission to construct an object directly in its final location rather than construct-then-copy-then-destroy. Two named cases:

- **RVO (Return Value Optimization)** — returning a *prvalue*: `return T{args};` or `return f();`.
- **NRVO (Named Return Value Optimization)** — returning a *named local* by value: `T t; ...; return t;`.

The mechanism is the ABI's **hidden return-slot pointer** (Ch. 3 §3.5). Under the System V AMD64 ABI, a function returning a class type too large or too non-trivial to fit in `rax:rdx` receives an extra first argument in `rdi`: the address of caller-provided storage. The callee constructs the return value *there*. So:

```cpp
Big make() { return Big{1,2}; }
Big b = make();          // Big is constructed directly into b's storage.
                         // Zero copies, zero moves, one constructor call.
```

### Guaranteed vs permitted

C++17 changed the model fundamentally. Before C++17, elision was an *optimization* the compiler was permitted to perform, but the copy/move constructor still had to be **accessible and not deleted** — so returning a move-only type by value was fine, but returning a non-copyable, non-movable type was ill-formed.

C++17 reframed prvalues: a prvalue is no longer an object, it is an *initializer* for one. Materialization happens only when required (Ch. 4 covers value categories). Consequently:

| Case | C++11/14 | C++17+ |
|---|---|---|
| `return T{...};` (prvalue) | Elision permitted; copy/move ctor must exist | **Guaranteed elision**; no copy/move ctor needed at all |
| `T t; return t;` (NRVO) | Permitted, not required | Still **permitted, not required** |
| `T t = T(T(T()));` | Permitted | Guaranteed — one object |

NRVO was deliberately left non-mandatory because it is not always implementable: two `return` statements naming *different* locals cannot both be constructed in the return slot, and a local whose address escapes before the return may not be relocatable.

```cpp
T f(bool c) { T a, b; return c ? a : b; }   // NRVO typically fails: two candidates
T g() { T t; use(&t); return t; }           // NRVO usually still works (compilers handle this)
T h() { T t; return std::move(t); }         // NRVO DISABLED — see below
```

### The pessimizing `std::move` on return

`return std::move(t);` converts the return expression from an lvalue naming a local into an xvalue. That makes the return value no longer a *name*, so **NRVO cannot apply**, and you get a guaranteed move construction where you would otherwise have had nothing. For a `std::string` that is a cheap pointer steal; for a `std::array<double, 64>` it is a 512-byte copy that would have cost zero. `-Wpessimizing-move` (GCC/Clang) diagnoses it.

The rule to state in an interview: **return a local by its name; never `std::move` it.** Implicit move already covers you — when NRVO does not apply, `return t;` treats `t` as an rvalue for overload resolution ([class.copy.elision]/3), so you get a move for free without blocking elision. C++20 (P1825) extended implicit move to function parameters, `return`ing by-value parameters, and `throw` operands; C++23 tightened it further so implicit move also applies when the return type is a reference type or a different type requiring a conversion.

The one place you *must* write `std::move` on return is when converting: `std::unique_ptr<Base> f() { std::unique_ptr<Derived> d = ...; return d; }` — pre-C++20 this needed the explicit move because the types differ; since C++20 implicit move handles it.

**Low-latency angle:** guaranteed RVO is what makes "return by value" the correct default for factory functions even for large objects. There is no allocation, no copy, and the caller's storage is often a stack slot the caller already had. The failure mode to watch is NRVO defeat: a `return` inside a `try` block, multiple return objects, or returning a member/global (never elidable — it must be copied, since the destination and source are distinct live objects).

---

## 10.2 Move Operations That Fall Back to Copying

A **move** is not a language primitive; it is overload resolution selecting a constructor or assignment operator taking `T&&`. If no such overload is viable, the `const T&` overload wins and you silently get a **copy**. Nothing warns. This is the single most common source of "I wrote move semantics and it got no faster."

`std::move` is a cast: `static_cast<T&&>(x)`. It moves nothing and generates no code. It only changes the value category of an expression so a different overload can be chosen.

### The five ways a move silently becomes a copy

**1. The type has no move operations.** A user-declared destructor, copy constructor, or copy assignment operator **suppresses implicit generation of the move constructor and move assignment**. So:

```cpp
struct Buf {
    std::vector<char> data;
    ~Buf() { log("gone"); }      // <-- kills implicit move ctor and move assign
};
Buf a = std::move(b);            // COPIES the vector. Silently.
```

This is the Rule of Five's real cost (Ch. 6): adding a destructor to a class turns every move into a copy. Fix with `Buf(Buf&&) = default;` plus the assignment, or restructure so no destructor is needed (Rule of Zero).

**2. The object is `const`.** `const T&&` does not bind to `T&&`; it binds to `const T&`.

```cpp
const std::string s = "...";
std::vector<std::string> v;
v.push_back(std::move(s));      // COPY — s is const
```

Returning `const T` by value (an old, bad habit) has exactly this effect at every call site.

**3. Members are moved from a *named* rvalue reference parameter without `std::move`.** Inside a function, a parameter of type `T&&` is an **lvalue**. Forgetting `std::move`/`std::forward` in the body copies.

```cpp
Widget(std::string&& s) : name_(s) {}              // COPIES
Widget(std::string&& s) : name_(std::move(s)) {}   // moves
```

**4. The move constructor is not `noexcept` and a container is reallocating.** See §10.3.

**5. The "move" doesn't own anything.** `std::array<T,N>` moves element-wise; a `std::string` in SSO mode (Ch. 13) copies its inline buffer; a trivially-copyable struct's move *is* a copy. Moving is only cheap when the type owns a heap resource.

### Moved-from state

The standard requires a moved-from standard-library object to be in a **valid but unspecified state**: you may call any operation with no precondition (`clear()`, `size()`, assignment, destruction), but you may not assume a value. `std::unique_ptr` is the exception with a *specified* state — null. `std::string` is not guaranteed empty (libstdc++ leaves it empty; MSVC may too; do not depend on it).

For your own types, the reasonable contract is: leave the source in a cheaply-destructible, self-consistent state. Do **not** write a move constructor that leaves dangling pointers, and do not "optimize" by skipping the source's nulling — the destructor will double-free.

### Self-move

`x = std::move(x)` must not corrupt. The idiomatic guard is not `if (this != &other) return *this;` in move assignment (which is a branch on the hot path) but rather writing the operation so self-assignment is harmless — swap-based, or unconditional member-wise move-assign of members that themselves tolerate it. The standard requires only *valid but unspecified* for self-move on library types, so it is safe from a UB perspective but the resulting value is not guaranteed.

**Verification technique worth naming:** compile with `-Wdeprecated-copy` / `-Wextra`, and in tests instrument a probe type that counts copy and move constructions. A hot-path allocation profile (Ch. 43) that shows unexpected `malloc` traffic is usually a fallen-back move.

---

## 10.3 Noexcept Move Operations

`noexcept` on a move constructor is not decoration; it changes which algorithm the standard library runs.

### The vector reallocation problem

`std::vector::push_back` when `size() == capacity()` must allocate a new buffer and transfer `n` elements. If it *moves* them and element 7's move constructor throws, the new buffer holds 7 constructed elements and the old buffer holds 7 gutted ones — there is no way to restore the original vector, so the **strong exception guarantee** (§10.6) is unachievable. If it *copies* them and element 7 throws, the old buffer is untouched: destroy the 7 new copies, free the new buffer, rethrow. Original vector intact.

So the library uses `std::move_if_noexcept`:

```
if (is_nothrow_move_constructible_v<T> || !is_copy_constructible_v<T>)
    move each element
else
    copy each element
```

Consequences:

| `T`'s move ctor | `T` copyable? | Reallocation does |
|---|---|---|
| `noexcept` | either | **move** |
| throwing | yes | **copy** — silent, and O(n) allocations for a `vector<vector<int>>` |
| throwing | no (move-only) | move (no choice); strong guarantee downgraded to basic |
| absent | yes | copy |

`vector<std::string>` growth with a non-`noexcept` `string` move would be catastrophic; every standard library marks these `noexcept`. Your own RAII types must too.

```cpp
struct Conn {
    Conn(Conn&&) noexcept;             // required for vector<Conn> to be fast
    Conn& operator=(Conn&&) noexcept;
};
static_assert(std::is_nothrow_move_constructible_v<Conn>);
```

That `static_assert` is the deliverable — put it next to the class.

### When `noexcept` is deduced

Implicitly-generated (`= default`) move operations get a computed exception specification: `noexcept` iff every base and member's corresponding operation is `noexcept`. So a single member with a throwing move (a legacy type, or a type holding a `std::list` under a non-`noexcept`-allocator, or historically `std::function`) poisons the whole class. `noexcept(expr)` and `std::is_nothrow_move_constructible_v` are how you inspect it.

### The semantics of violating `noexcept`

If a `noexcept` function throws, `std::terminate` is called immediately — via `std::terminate`, not by unwinding to a handler. The standard permits (does not require) the stack to be unwound first, so in practice you often get a useless backtrace on GCC because destructors have already run... actually GCC does *not* unwind for `noexcept` violations by default, which is what makes the core dump useful. Either way, the program dies. `noexcept` is a hard promise, not a hint.

### `noexcept` and code generation

Marking a function `noexcept` lets the compiler omit landing pads and unwind bookkeeping around calls into it, which shrinks `.eh_frame` and `.gcc_except_table` and can improve I-cache density (Ch. 27). It does **not** speed up the function body on the happy path in the zero-cost model (§10.7) — the common misconception is that `noexcept` makes code faster generally. Its real wins are: (a) unlocking move-based algorithms, (b) allowing the caller to omit cleanup code, (c) enabling optimizations across calls that would otherwise need to be exception-safe.

Where to put it: **move constructors, move assignment, swap, destructors (implicitly `noexcept` since C++11), and small leaf accessors.** Where not to: anything that allocates, or any function whose contract might legitimately need to grow an error path later — removing `noexcept` from a public API is an ABI-visible and semantics-visible break.

`noexcept(false)` is the default for ordinary functions. Destructors default to `noexcept(true)` in C++11; a destructor that throws therefore terminates, which is why "never throw from a destructor" became a hard rule rather than advice.

---

## 10.4 Move-Only Types

A **move-only type** has its copy operations deleted and its move operations available: `std::unique_ptr`, `std::thread`, `std::jthread`, `std::future`, `std::promise`, `std::packaged_task`, `std::fstream`, `std::unique_lock`, `std::mutex` (which is neither movable nor copyable — immovable), and any RAII handle over a non-duplicable resource.

```cpp
class Fd {
    int fd_ = -1;
public:
    explicit Fd(int fd) noexcept : fd_(fd) {}
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    Fd(Fd&& o) noexcept : fd_(std::exchange(o.fd_, -1)) {}
    Fd& operator=(Fd&& o) noexcept { std::swap(fd_, o.fd_); return *this; }
    ~Fd() { if (fd_ != -1) ::close(fd_); }
};
```

`std::exchange` (C++14) is the idiomatic move-constructor body: set the source to its null state and return the old value in one expression. Swap-based move *assignment* defers the old resource's release to the source's destructor, which is usually fine and is self-move-safe; if you need deterministic release order, do `close(fd_); fd_ = std::exchange(o.fd_, -1);` instead.

### Why move-only is the right default for resource handles

Copying a file descriptor, a thread, or a lock either requires a `dup`-style duplication with murky ownership semantics or is meaningless. Deleting the copy makes ownership a compile-time property: exactly one object owns the resource, so double-close and use-after-close become type errors rather than runtime bugs.

### Interactions to know

- **Containers of move-only types work**, but only for operations that don't require copying. `std::vector<std::unique_ptr<T>>` is fine; `v.resize(n)` requires default-construction, `v.insert` requires movability, and any algorithm requiring `CopyConstructible` (like `std::sort` on some implementations via the value-type temporary — actually `sort` requires only `MoveConstructible`/`MoveAssignable` since C++11) is fine. Initializer lists are *not*: `std::vector<std::unique_ptr<int>> v{std::make_unique<int>(1)};` fails, because `std::initializer_list` elements are `const` and must be copied.
- **`std::function` requires `CopyConstructible` callables**, so a lambda capturing a `unique_ptr` cannot be stored in a `std::function`. C++23's `std::move_only_function` fixes this and is also better-specified about const-correctness and reference qualification. `std::packaged_task` was always move-only.
- **Passing move-only types**: by value (`void take(Fd f)`) makes the transfer explicit at the call site, which must write `take(std::move(f))`. By `Fd&&` also works but is less clear about whether the callee actually took ownership.
- **Returning is free** — guaranteed RVO (§10.1) means `Fd open(...)` needs no move at all.

### Immovable types

Deleting the move operations as well (`std::mutex`, `std::atomic`, `std::condition_variable`, and anything with a self-pointer or that has registered its own address somewhere) means the object cannot change address after construction. Consequences: it cannot live in a `std::vector` that reallocates, cannot be returned by value pre-C++17 (post-C++17 guaranteed elision *does* allow returning an immovable prvalue — a genuinely useful C++17 change), and must be held by `unique_ptr`, `deque`, or in a fixed-capacity structure.

```cpp
struct Immovable { Immovable(const Immovable&) = delete; Immovable(Immovable&&) = delete; Immovable(); };
Immovable make() { return Immovable{}; }   // ill-formed pre-C++17, fine in C++17
```

**Low-latency angle:** move-only handles with `noexcept` moves are the cheapest correct ownership model — no reference count, no atomic, no allocation (contrast `shared_ptr`, Ch. 9). A `unique_ptr` with a stateless deleter is one pointer wide (EBO, Ch. 3 §3.4) but is **not trivially copyable**, so it is passed on the stack rather than in a register under the SysV ABI (Ch. 3 §3.5). For a hot-path function taking ownership, passing the raw handle and constructing the RAII wrapper inside can measurably win.

---

## 10.5 Exception Handling and Stack Unwinding

An exception transfers control from a `throw` to a matching `catch`, destroying every automatic object in between. The machinery:

**1. Throw.** `throw X{args}` allocates an **exception object** in an implementation-managed region. On the Itanium C++ ABI, `__cxa_allocate_exception` takes it from a per-thread emergency buffer if `malloc` fails (the emergency pool is ~64–72 KB in libstdc++, sized for a handful of small exceptions); otherwise from the heap. The exception object is copy-initialized from the operand — so `throw` can itself throw, and `throw` allocates. This matters: **you cannot throw reliably under memory pressure**, which is why `std::bad_alloc` objects are preallocated.

**2. Two-phase unwind** (Itanium ABI / DWARF CFI):
- *Phase 1 (search):* walk the stack using unwind tables, asking each frame's **personality routine** (`__gxx_personality_v0`) whether it has a handler matching the thrown type. Nothing is destroyed yet. If no handler is found anywhere, `std::terminate` is called **with the stack intact** — this is why an uncaught exception gives you a usable core dump.
- *Phase 2 (cleanup):* walk again, this time running each frame's cleanup code (destructors of locals, i.e. **landing pads**) and restoring callee-saved registers, until the handler frame is reached.

The two phases exist precisely so that "no handler" is detectable before any state is destroyed.

**3. Catch matching** is by type, in source order within a `try`, allowing: exact type, base class (public, unambiguous, non-virtual-ambiguity), and qualification conversion / derived-to-base pointer conversion. **No implicit conversions** — `catch (long)` does not catch a thrown `int`. `catch (...)` catches everything, including foreign exceptions (a Windows SEH exception, or a `pthread_cancel` unwind on Linux — swallowing that with `catch(...)` and not rethrowing breaks thread cancellation).

```cpp
try { f(); }
catch (const std::out_of_range& e) { ... }   // most-derived first
catch (const std::logic_error& e) { ... }
catch (const std::exception& e) { ... }      // catch by CONST REFERENCE, always
catch (...) { cleanup(); throw; }            // bare throw rethrows the current exception
```

Catching by value slices (Ch. 6) and copies; catching by non-const reference is legal but pointless. `throw;` inside a handler rethrows the *same* exception object (no copy); `throw e;` rethrows a **slice-copy** of the static type of `e` — a classic bug.

### Cost model

| Phase | Cost |
|---|---|
| Entering/leaving a `try` block | **Zero** on the table-based model (§10.7) |
| Happy path through a function with destructors | Zero extra (destructor calls are the same as without exceptions) |
| `throw` | Allocation + `_Unwind_RaiseException` + table lookups |
| Per frame unwound | Binary search in `.eh_frame_hdr`, decode CFI, run landing pad |

Measured order of magnitude: **1–10 µs** for a throw crossing a handful of frames, dominated by unwind-table decoding and, on many implementations, a **global mutex** taken in `dl_iterate_phdr` when locating the frame-description entries for a shared library. That global lock is why exception throughput collapses under multithreading and why "exceptions are cheap" is only true for the *non*-throwing path. GCC 12+ and glibc have reduced but not eliminated this.

Rule for HFT: exceptions are acceptable for genuinely exceptional, non-hot-path conditions (config load failure, connection loss during startup) and unacceptable as control flow on the tick-to-trade path (Ch. 52). A "not found" is not exceptional; it is a `std::optional` (§10.10).

### `noexcept`, `std::current_exception`, nesting

`std::current_exception()` (C++11) captures the in-flight exception as a `std::exception_ptr` (a refcounted handle to the exception object) so it can be stored, moved across threads, and rethrown with `std::rethrow_exception`. This is how `std::promise::set_exception` and `std::future` propagate errors across threads. `std::nested_exception` / `std::throw_with_nested` build exception chains for layered context.

Throwing while an exception is already propagating (i.e. from a destructor during unwinding) calls `std::terminate` — the reason destructors are implicitly `noexcept`.

---

## 10.6 Exception-Safety Guarantees

Abrahams' four levels, from weakest to strongest. These are contracts you assert about *your* functions, and that you rely on from the library.

| Guarantee | Meaning | Example |
|---|---|---|
| **No-throw** (`noexcept`) | Never throws. Always succeeds. | `swap`, `~T`, move ops, `vector::size` |
| **Strong** | Commit-or-rollback: if it throws, program state is exactly as before the call. | `vector::push_back` (when `T`'s move is `noexcept` or `T` is copyable) |
| **Basic** | No leaks, all invariants hold, but the value is unspecified. | `vector::insert` in the middle for throwing-move `T` |
| **None** | Anything, including leaks and broken invariants. | Unacceptable in modern C++ |

"Basic" is the *minimum acceptable* level and should be the default for everything you write. Achieving it is almost entirely a matter of RAII (Ch. 5): if every resource is owned by an object with a destructor, unwinding cleans up automatically and you get the basic guarantee for free.

### Achieving the strong guarantee: copy-and-swap

```cpp
Widget& Widget::operator=(const Widget& rhs) {
    Widget tmp(rhs);          // all the throwing work happens here, on a temporary
    swap(*this, tmp);         // noexcept commit
    return *this;             // tmp's destructor releases the old state
}
```
The pattern is: **do all fallible work on a copy, then commit with a `noexcept` operation.** It gives the strong guarantee and handles self-assignment for free. Its cost is an extra allocation and copy on every assignment, which is why hot-path code often prefers the basic guarantee plus explicit checks. The unified assignment operator `Widget& operator=(Widget rhs)` (by value) folds copy and move assignment into one, letting the caller's move elide the copy — elegant, but it forces a copy for lvalue arguments even when in-place reuse (e.g. reusing an already-large-enough buffer) would be cheaper. For containers, in-place reuse is why the standard does *not* use copy-and-swap.

### Where the standard library's guarantees bite

- `vector::push_back` / `emplace_back` / `reserve`: strong, conditional on `move_if_noexcept` (§10.3).
- `vector::insert`/`erase` in the middle: **basic only** — elements are shuffled by move-assignment and a throw leaves them scrambled.
- `std::sort`: basic. If the comparator throws, the range is a permutation of the original but not sorted, and a comparator that is not a strict weak ordering is **UB**, not an exception.
- `std::map::insert`: strong. Node-based containers get this nearly for free because the node is allocated and constructed before any tree surgery.
- `unordered_map::insert`: strong, but **rehash can throw** and the guarantee holds only if the hash and equality predicates don't throw.
- `std::deque::push_front/push_back`: strong. `insert` in the middle: basic.

### The commit/rollback discipline

The generalizable rule: **order operations so that everything that can fail happens before anything that changes observable state.** Allocate first, then link. Construct the node, then splice it. Build the new config, then swap the pointer. When you cannot reorder, use a scope guard (§10.13) with explicit `dismiss()`.

**Misconception to correct:** the strong guarantee is not free and is not always desirable. Providing it for a container of throwing-move elements costs O(n) copies. Providing it for a function that publishes to a network is impossible (you cannot un-send a packet). Know which level you are promising, and document it.

---

## 10.7 Zero-Cost Exception Implementations

"Zero-cost" (better: **table-based**, or **zero-cost-on-the-happy-path**) means no runtime work is done to *enter* or *leave* a `try` block. The alternative — the **`setjmp`/`longjmp` (SJLJ)** model — pushes a handler record onto a linked list at every `try` entry and pops it on exit, costing time on every execution, throwing or not. SJLJ is what old MinGW and some embedded toolchains used; every modern mainstream target uses the table model.

### How the table model works

The compiler emits, per function, static data describing the frame:

| Section | Contents |
|---|---|
| `.eh_frame` | DWARF **Call Frame Information**: how to restore the stack pointer and callee-saved registers for each PC range. Also used by debuggers and profilers for unwinding. |
| `.eh_frame_hdr` | A sorted binary-search table over `.eh_frame` PC ranges, found via the `PT_GNU_EH_FRAME` program header. |
| `.gcc_except_table` | The **LSDA** (Language-Specific Data Area): per-PC-range action tables mapping "if the exception type matches T, jump to landing pad L". |
| `.text` cold sections | The **landing pads** themselves — destructor calls and handler entry code, placed out of line. |

At runtime, `_Unwind_RaiseException` reads the return address, binary-searches `.eh_frame_hdr`, decodes CFI to virtually unwind one frame, and calls the personality routine with the LSDA. Repeat.

### What "zero-cost" actually costs

Not zero:

- **Binary size.** Unwind tables commonly add 10–20% to a C++ binary. That is cold data, but `.gcc_except_table` and landing pads are interleaved with hot code layout decisions.
- **I-cache and optimization pressure.** A call that may throw is a control-flow edge to a landing pad. That constrains register allocation across the call (values live in the landing pad must be recoverable), can inhibit some transformations, and adds basic blocks. Compilers place landing pads in cold sections (`.text.unlikely`) to limit I-cache damage — see Ch. 41 on code layout.
- **Inlining budget.** Landing-pad code counts toward inlining cost heuristics.
- **Throw cost.** Microseconds, plus the `dl_iterate_phdr` lock (§10.5).

`-fno-exceptions` removes the tables. Measuring the difference is the honest way to answer "do exceptions cost anything": build both ways and compare `size`, `perf stat` on the hot loop, and the actual generated code in Compiler Explorer (Ch. 44).

### Related mechanisms

- **Forced unwind** — `pthread_exit` and thread cancellation on glibc use the same unwinder (`_Unwind_ForcedUnwind`). Hence `catch (...)` without a rethrow can break `pthread_cancel`.
- **`-fasynchronous-unwind-tables`** is the default on x86-64 Linux even for C, because the ABI requires unwind info for backtraces; so unwind tables exist independently of exceptions.
- **Frame pointers** (`-fno-omit-frame-pointer`) are unrelated to exception unwinding (which uses CFI) but are what cheap profilers use; see Ch. 41 §on stack unwinding.
- **Windows x64** uses a different but analogous table scheme (`.pdata`/`.xdata`, `RtlUnwindEx`); MSVC's `/EHsc` vs `/EHa` controls whether asynchronous (SEH) exceptions participate.

**C++26 direction:** P0709 (Herbceptions) proposed statically-typed, value-returned exceptions with deterministic cost; it has not been adopted. What *has* landed is `std::expected` (C++23, §10.11) as the pragmatic middle ground.

---

## 10.8 Disabling Exceptions

`-fno-exceptions` (GCC/Clang) / `/EHs-c-` (MSVC) makes `throw`, `try`, and `catch` ill-formed and drops the unwind tables. Real constraints follow.

### What breaks

- **The standard library still throws** — `std::vector::at`, `std::stoi`, `std::string::substr` out of range, `std::optional::value` on empty, and every allocation. With `-fno-exceptions`, libstdc++ replaces `throw X` with a call to `std::terminate`/`abort` (via `__throw_length_error` etc.). So `vector::at` out of range aborts the process instead of throwing. That is a *behavior* change, not just a compile-time one.
- **`operator new` cannot report failure by exception.** Use `new (std::nothrow)` and check, or replace the allocator.
- **Mixing translation units** compiled with and without exceptions is legal (the flag is per-TU) but the no-exceptions TU has no landing pads, so an exception propagating *through* it has undefined behavior — the destructors of its locals will not run, and in practice you get `std::terminate`. Never let an exception cross into an `-fno-exceptions` frame; wrap the boundary in a TU that does have exceptions enabled and catches everything.
- **RAII still works** for normal returns; only the unwinding path is gone.

### Who does this and why

Game engines, embedded/freestanding targets, some kernel-adjacent code, and parts of HFT stacks. The motivations, in decreasing order of legitimacy:

1. **Determinism**: no code path can take microseconds unpredictably. On a tick-to-trade path where p99.9 matters more than the mean, an unbounded unwind is unacceptable.
2. **Binary size** on constrained targets.
3. **Interop** with C or with a runtime that cannot unwind.
4. "Exceptions are slow" as a cargo-culted belief — usually not supported by measurement, since the happy path is genuinely free.

The more common HFT posture is not `-fno-exceptions` globally but: exceptions enabled, allowed during startup/configuration/recovery, and **structurally absent from the hot path** — enforced by making hot-path functions `noexcept` (so a throw terminates loudly in test rather than silently costing latency in production), by using `std::expected`/error codes there, and by preallocating (Ch. 55) so nothing on the hot path can allocate and therefore nothing can throw `bad_alloc`.

### Related toggles

- `-fno-rtti` is orthogonal but often paired; note that **exception matching needs type information** but uses its own type-info mechanism, so `-fno-rtti` with exceptions enabled works.
- `-fno-unwind-tables` / `-fno-asynchronous-unwind-tables` additionally removes the CFI, which breaks backtraces and profilers. Usually you want to keep unwind tables even with `-fno-exceptions`.
- Freestanding C++ (C++23 formalized a freestanding subset) makes much of this precise.

---

## 10.9 Error Codes

An **error code** is an out-of-band or in-band value signalling failure without unwinding. The design space:

```cpp
int  parse(const char* s, Value* out);      // C style: return code, out-param
bool parse(const char* s, Value& out);      // boolean, no reason
Value parse(const char* s, std::error_code& ec);   // library style
std::expected<Value, ParseError> parse(...);       // C++23, §10.11
```

### `<system_error>`

C++11 standardized a vocabulary for OS-level errors:

| Type | Role |
|---|---|
| `std::error_category` | A namespace for codes; singleton, compared by address. `std::generic_category()`, `std::system_category()`, `std::iostream_category()`, plus yours. |
| `std::error_code` | A **specific** platform error: `{value, category}`. `errno`/`GetLastError` lives here. |
| `std::error_condition` | A **portable** abstraction to compare against: `std::errc::no_such_file_or_directory`. |
| `std::errc` | Enum of POSIX error conditions. |
| `std::system_error` | The exception type wrapping an `error_code`. |

The point of the code/condition split is that `ec == std::errc::no_such_file_or_directory` works whether the underlying code came from `errno` (`ENOENT`) or from Windows (`ERROR_FILE_NOT_FOUND`), because the category's `equivalent()` maps them. Registering a custom category means specializing `std::is_error_code_enum` and providing a `category` singleton.

`std::error_code` is two words (an `int` and a pointer), trivially copyable, allocation-free, and returned in registers — cheap enough for a hot path.

The `<filesystem>` library shows the dual-API convention that is worth imitating: every function has a throwing overload and an `error_code&` overload.

```cpp
std::filesystem::file_size(p);        // throws filesystem_error
std::filesystem::file_size(p, ec);    // sets ec, returns -1
```

### Failure modes of error codes

- **Ignoring the return value.** The reason `[[nodiscard]]` (C++17) exists; mark your error-returning functions and error types with it. `[[nodiscard]]` on a *type* makes every function returning it checked.
- **Error-handling code volume.** Every call site grows a branch. This is the honest cost side of the trade against exceptions.
- **Losing context.** An `error_code` says "ENOENT", not "while loading /etc/app/config.yaml". Exceptions carry a message; codes need a separate mechanism (`std::expected<T, RichError>`).
- **The valid/invalid interleaving problem**: `int` return codes that also carry data (`read()` returning `-1` or a count) force sentinel checks and are easy to get wrong (Ch. 23 on sentinel hazards).

### Cost and codegen

An error-code return is a predictable branch. On the happy path the branch predictor learns it (Ch. 27) and the cost approaches zero; the residual cost is code size and the extra basic block. Compare:

| | Exception | Error code |
|---|---|---|
| Happy path | Zero (table model) | One well-predicted branch per call site |
| Error path | µs, allocation, global lock | Nanoseconds |
| Can be ignored | No | Yes (mitigate with `[[nodiscard]]`) |
| Composes through deep call stacks | Automatically | Manual propagation at every level |
| Works with constructors / operators | Yes | No — must use a factory or a valid-flag |
| Hot-path suitable | Only if it never throws | Yes |

That last row is the crux: **constructors and overloaded operators have no return channel**, so a design that bans exceptions must also ban failing constructors — use a static `create()` returning `expected`, or two-phase init (which reintroduces the invalid-object state RAII exists to eliminate).

---

## 10.10 Optional Return Values

`std::optional<T>` (C++17) models "a `T` or nothing" — a value that may be absent, where absence is **not an error**. Lookup miss, unset configuration field, end-of-sequence.

### Representation

```
optional<T>:  [ aligned storage for T ][ bool engaged ][ padding ]
sizeof(optional<int>) == 8      (4 + 1 + 3 padding)
sizeof(optional<double>) == 16
sizeof(optional<T*>) == 16      <-- no null-pointer optimization
```

It is *not* a discriminated pointer: `optional<T*>` costs 16 bytes, unlike Rust's niche optimization. There is no standard mechanism to specify a sentinel, so if you need a compact optional for a hot data structure, you write your own with a domain sentinel (`price == INT64_MIN` means absent) — and take on the sentinel hazards of Ch. 23.

Key properties: the `T` is stored **inline**, so no allocation; `optional<T>` is trivially copyable/destructible iff `T` is, which preserves register passing for small types; and `optional` is never valueless.

### Interface, and where the UB is

```cpp
std::optional<int> o = find(k);
if (o) use(*o);                 // operator* : UB if empty
o.value();                      // throws std::bad_optional_access if empty
o.value_or(0);                  // never throws; note it COPIES the fallback and requires T copyable
o.reset(); o.emplace(args...);  // in-place construction, no temporary
```

`*o` on an empty optional is **undefined behavior**, not a throw. That is the single most-asked detail. `value()` is the checked accessor — and it throws, so it is not `-fno-exceptions` friendly.

C++23 added **monadic operations**, which remove most of the branchy plumbing:

```cpp
auto n = parse(s)                      // optional<int>
          .transform([](int v){ return v * 2; })      // optional<int>
          .and_then([](int v){ return validate(v); }) // optional<int>
          .or_else([]{ return std::optional<int>{0}; });
```

### Gotchas

- **`optional<bool>` is a three-state type** and `if (ob)` tests *engagement*, not the contained value. A very common bug.
- **`optional<T&>` does not exist** in C++17/20/23 — it was cut over assignment-semantics disagreement (does `o = x` rebind or assign through?). C++26 adopted `optional<T&>` (P2988) with rebinding assignment. Until then, use `T*` or `std::reference_wrapper`.
- **Comparison operators are defined**, and an empty optional compares less than any engaged one. `optional<T>` also compares directly against `T` and against `std::nullopt`.
- **`optional` in an aggregate defeats trivial layout goals** only if `T` is non-trivial; otherwise the layout is predictable but the `bool` adds padding — avoid in wire formats (Ch. 3 §3.12).
- **Chained `optional` is not an error channel.** If the caller needs to know *why*, `optional` throws that away. That is exactly what `expected` is for.

**Low-latency angle:** `optional<T>` for small trivially-copyable `T` is returned in registers under SysV (a pair fits in `rax:rdx`), so a lookup returning `optional<uint64_t>` costs nothing beyond the flag. For large `T` it goes through the return slot. Prefer `optional` over "return a bool and fill an out-param" — the codegen is the same and the API is unmistakable.

---

## 10.11 Expected Return Values

`std::expected<T, E>` (C++23) is `optional` with a reason: it holds either a `T` (the expected value) or an `E` (the error). It is the standardization of `Result<T, E>` / `folly::Expected` / `tl::expected` / `absl::StatusOr`.

```cpp
std::expected<Order, ParseError> parse(std::span<const std::byte> buf);

auto r = parse(buf);
if (!r) { log(r.error()); return; }
process(*r);
```

### Representation and semantics

```
expected<T,E>: union { T val; E err; } + bool has_value
sizeof == max(sizeof(T), sizeof(E)) + 1, rounded to alignment
```

Storage is a union — the `T` and `E` overlap — so `expected<int, error_code>` is 24 bytes, not the sum. Like `optional`, no allocation; unlike `variant`, no valueless-by-exception state in the common case (it *can* become valueless only if reassignment throws and the type isn't nothrow-movable, in which case the operation is ill-formed or uses a temporary — the specification requires the operations to be constrained so that this is avoided where possible).

API surface:

| Member | Behavior |
|---|---|
| `operator bool()`, `has_value()` | true iff holding a `T` |
| `operator*`, `operator->` | **UB if unexpected** (same trap as `optional`) |
| `value()` | throws `std::bad_expected_access<E>` if unexpected |
| `error()` | **UB if it holds a value** |
| `value_or(x)` | fallback |
| `and_then`, `transform`, `or_else`, `transform_error` | monadic composition, present from the start |
| `std::unexpected<E>` | the tagged constructor for the error side |

```cpp
std::expected<Config, Err> load(std::string_view p) {
    auto bytes = read_file(p);                       // expected<vector<byte>, Err>
    if (!bytes) return std::unexpected(bytes.error());
    return parse_config(*bytes);
}
// or, monadically:
auto load2(std::string_view p) { return read_file(p).and_then(parse_config); }
```

`std::expected<void, E>` is specialized for "operation that either succeeds or fails with a reason" — the direct replacement for a bare error-code return.

### Trade-offs vs exceptions

| | `expected` | Exception |
|---|---|---|
| Error path cost | Deterministic, no allocation, a branch | µs, allocation, unwinder lock |
| Propagation | **Manual at every level** — the biggest ergonomic cost; no `?` operator in C++ | Automatic |
| Visible in the signature | Yes (self-documenting, `[[nodiscard]]`) | No (only `noexcept` or its absence) |
| Constructors/operators | Cannot use it | Works |
| Binary size | Grows call sites | Grows tables |
| Ignorable | Only if you drop `[[nodiscard]]` | No |

`expected` is `[[nodiscard]]` in the standard, so ignoring one is a warning.

### Practical guidance for latency-sensitive systems

Use `expected` for anything on the hot path that can fail in a *routine* way: message parse failures, risk-check rejections (Ch. 56), venue rejects. Keep `E` small and trivially copyable — an enum class or a 4-byte code, not a `std::string`, because a `string` error type makes the whole `expected` non-trivially-destructible and pushes it out of registers. If you need rich context, put a code in the `expected` and log details separately.

Combine with `std::error_code` for OS errors (`expected<size_t, std::error_code>` for a read) and with a domain enum for protocol errors. `expected<T, std::variant<...>>` is expressive but expands the size; prefer a flat error enum.

**Interview framing:** *"When would you use `optional` vs `expected` vs an exception?"* — `optional` when absence is normal and reasonless; `expected` when the caller must act on *why* and the failure is routine and on a latency-sensitive path; exceptions when the failure is genuinely exceptional, must not be ignorable, must propagate through many layers unchanged, or arises in a constructor.

---

## 10.12 Termination and Abort

The ways a C++ program stops, and what each one does to your state.

| Mechanism | Runs destructors of automatics | Runs static destructors / `atexit` | Flushes iostreams | Core dump |
|---|---|---|---|---|
| `return` from `main` | Yes (in `main`) | **Yes** | Yes | No |
| `std::exit(n)` | **No** | Yes | Yes | No |
| `std::quick_exit(n)` | No | No (runs `at_quick_exit` handlers only) | No | No |
| `std::_Exit(n)` | No | **No** | **No** | No |
| `std::abort()` | No | No | No | **Yes** (SIGABRT) |
| `std::terminate()` | Implementation-defined (usually no) | No | No | Yes (default handler calls `abort`) |
| Uncaught exception | **No** (phase 1 finds no handler → terminate with stack intact) | No | No | Yes |
| `_exit`/`_Exit` from a signal handler | No | No | No | No |

### `std::terminate`

Called when: an exception escapes `main` uncaught; a `noexcept` function throws; an exception escapes a destructor during unwinding; a `throw` occurs with no handler; `std::thread` is destroyed while joinable; a `std::thread`'s function throws; `std::rethrow_exception` on a null `exception_ptr`; a static/thread-local destructor throws.

`std::set_terminate` installs a handler. A useful production pattern:

```cpp
std::set_terminate([]{
    if (auto ep = std::current_exception()) {
        try { std::rethrow_exception(ep); }
        catch (const std::exception& e) { fprintf(stderr, "fatal: %s\n", e.what()); }
        catch (...) { fprintf(stderr, "fatal: unknown exception\n"); }
    }
    std::abort();      // ensures a core dump
});
```
The handler must not return; if it does, `abort` is called anyway.

### `std::thread` destruction

`~thread()` on a still-joinable thread calls `std::terminate` — a deliberate design decision (neither implicit join nor implicit detach is safe as a default). `std::jthread` (C++20) joins in its destructor and additionally carries a `stop_token`.

### `abort`, signals, and cores

`abort()` raises `SIGABRT`. If the handler is default, the kernel dumps core per `ulimit -c` and `/proc/sys/kernel/core_pattern`. Preconditions for a *useful* core: unwind tables or frame pointers present, symbols not stripped (or a build-ID-matched separate debug file — Ch. 58), and the core not truncated by `ulimit`.

**Crash-handler limitations** are a real interview topic: a `SIGSEGV` handler may call only **async-signal-safe** functions (Ch. 33). `malloc`, `printf`, `std::stacktrace`, and anything taking a lock are not on that list — a handler that calls `backtrace_symbols` can deadlock on the malloc arena lock the crashed thread was already holding. The safe pattern is: pre-allocate everything, use `write(2)` directly, use `backtrace()` (which is *mostly* safe once `libgcc` is preloaded) not `backtrace_symbols`, then re-raise the signal with the default disposition to get the core.

### `std::stacktrace` (C++23)

`std::stacktrace::current()` gives a portable captured backtrace with symbolization. It **allocates** and is not signal-safe, so it belongs in exception constructors and log paths, not in signal handlers. On libstdc++ it requires linking `-lstdc++exp` and DWARF info to be present.

**Design point for trading systems:** for an unrecoverable inconsistency, *fail fast and loudly* — `abort()` with a core beats limping on with corrupted risk state (Ch. 56, fail-closed). The counterpart is that "unrecoverable" must be defined narrowly, and the kill-switch/mass-cancel path must be exercised before the abort.

---

## 10.13 Scope Guards

A **scope guard** runs a cleanup action when control leaves a scope, by any path — normal exit, early `return`, `break`, or exception. It generalizes RAII to arbitrary code where writing a dedicated class is not worth it.

```cpp
template <class F>
class ScopeExit {
    F f_; bool active_ = true;
public:
    explicit ScopeExit(F f) noexcept : f_(std::move(f)) {}
    ~ScopeExit() noexcept { if (active_) f_(); }
    void dismiss() noexcept { active_ = false; }
    ScopeExit(ScopeExit&& o) noexcept : f_(std::move(o.f_)), active_(std::exchange(o.active_, false)) {}
    ScopeExit(const ScopeExit&) = delete;
};
#define SCOPE_EXIT auto CONCAT(_g_, __LINE__) = ScopeExit([&]
```

Usage:

```cpp
int fd = ::open(path, O_RDONLY);
if (fd < 0) return std::unexpected(err());
ScopeExit close_fd{[&]{ ::close(fd); }};
// ... any number of early returns or throws; fd is always closed
```

### The three flavors (Boost.ScopeExit / D / P0052)

| Guard | Fires when |
|---|---|
| `scope_exit` | Always on scope exit |
| `scope_fail` | Only if leaving via an exception |
| `scope_success` | Only if leaving normally |

`scope_fail`/`scope_success` are implemented by comparing `std::uncaught_exceptions()` (C++17, **plural**) at construction and destruction. The older singular `uncaught_exception()` was deprecated and removed in C++20 precisely because it could not distinguish "an exception is in flight" from "a *new* exception started during this destructor's scope" — the plural count solves it.

```cpp
class ScopeFail {
    int n_ = std::uncaught_exceptions();
    ...
    ~ScopeFail() { if (std::uncaught_exceptions() > n_) f_(); }
};
```

Standardization: P0052 targeted `<scope>` with `std::scope_exit`, `scope_fail`, `scope_success`, and `unique_resource`. It shipped as **Library Fundamentals TS v3** (`std::experimental::scope_exit`) and is available today as `folly::makeGuard`, `absl::Cleanup` (C++17, with `absl::Cleanup guard = absl::MakeCleanup(...)` and `std::move(guard).Cancel()`), `gsl::finally`, and Boost.ScopeExit. C++26 adds `<scope>` proper. Until then, a 20-line implementation is standard practice — and writing one on a whiteboard is a common interview exercise.

### Correctness details

- **The destructor must be `noexcept`.** A throwing guard during unwinding terminates (§10.5). Wrap the callable in a `try`/`catch(...)` if the action can fail, and log rather than propagate.
- **Capture by reference is normal** because the guard's lifetime is strictly inside the scope; capture by value only if the guard escapes.
- **`dismiss()` / `release()` is what makes it a commit-rollback tool** — the strong-guarantee pattern of §10.6 when copy-and-swap is too expensive:
  ```cpp
  registry.insert(key, value);
  ScopeExit rollback{[&]{ registry.erase(key); }};
  index.add(key);        // may throw; if it does, the insert is undone
  rollback.dismiss();    // commit
  ```
- **CTAD (C++17)** removes the need for a `make_guard` factory; pre-C++17 you needed one because class templates couldn't deduce.
- **Cost is zero** in optimized builds: the lambda is inlined, the `bool` is a constant when never dismissed, and the whole guard vanishes. Verify in Compiler Explorer if it matters.

Compared with `unique_ptr` with a custom deleter (Ch. 9) — the other common idiom for "run this at the end" — a scope guard is stateless-by-default, does not require a pointer-like resource, and expresses "do this" rather than "own this". Use `unique_ptr`/`unique_resource` when a resource *value* must be carried around or returned; use a scope guard for a local action.

---

## Key Interview Questions

1. **What is the difference between RVO and NRVO, and which is guaranteed?** — RVO returns a prvalue and is guaranteed since C++17 (no copy/move ctor needed); NRVO returns a named local and is permitted but never required.
2. **Why is `return std::move(x);` a pessimization?** — It turns the return expression into an xvalue, disabling NRVO and forcing a move where elision would have cost nothing. Implicit move already applies to `return x;`.
3. **Name five ways a "move" silently becomes a copy.** — No move operations (user-declared destructor/copy suppresses them); source is `const`; forgetting `std::move` on a named `T&&` parameter; a non-`noexcept` move during vector reallocation; the type owns nothing.
4. **Why must a move constructor be `noexcept`?** — `std::vector` uses `move_if_noexcept`; a throwing move forces element-wise copying during reallocation to preserve the strong guarantee.
5. **What state is a moved-from object in?** — Valid but unspecified; any precondition-free operation is legal. `unique_ptr` is the exception with a specified null state.
6. **Describe two-phase unwinding.** — Phase 1 searches for a handler without destroying anything (so an uncaught exception terminates with the stack intact); phase 2 runs landing pads frame by frame.
7. **Why is `catch (const std::exception&)` and not `catch (std::exception)`?** — By value slices the derived type and copies; by const reference preserves it. Likewise `throw;` rethrows, `throw e;` slices.
8. **What does "zero-cost exceptions" actually cost?** — Nothing on the happy path; 10–20% binary size in unwind tables, landing-pad basic blocks that constrain optimization, and microseconds plus a global `dl_iterate_phdr` lock on throw.
9. **List the four exception-safety guarantees.** — No-throw, strong (commit-or-rollback), basic (no leaks, invariants hold, value unspecified), none. Basic is the minimum; RAII gives it for free.
10. **How do you implement the strong guarantee?** — Copy-and-swap, or do all fallible work first and commit with a `noexcept` operation; a scope guard with `dismiss()` when copying is too expensive.
11. **What breaks with `-fno-exceptions`?** — `vector::at`, `stoi`, `optional::value`, and `new` abort instead of throwing; an exception propagating through a `-fno-exceptions` frame is UB; constructors lose their only error channel.
12. **`optional` vs `expected` vs exceptions?** — Absence with no reason; routine failure with a reason on a latency-sensitive path; genuinely exceptional or constructor-originated failure that must not be ignorable.
13. **What happens on `*empty_optional`?** — Undefined behavior. `value()` is the checked accessor and throws `bad_optional_access`.
14. **Why is `optional<bool>` dangerous, and why is there no `optional<T&>`?** — `if (ob)` tests engagement not value; references were cut over rebind-vs-assign ambiguity, restored by P2988 in C++26.
15. **What is the memory layout of `expected<T,E>`?** — A union of `T` and `E` plus a discriminant, so `max(sizeof)` not the sum; no allocation. Keep `E` small and trivially copyable to stay in registers.
16. **What is `std::error_code` vs `std::error_condition`?** — A concrete platform error (`{value, category}`) vs a portable condition to compare against (`std::errc`), mapped by the category's `equivalent()`.
17. **Enumerate the termination paths and what each preserves.** — `return`/`exit` run static destructors and flush; `quick_exit` runs only `at_quick_exit`; `_Exit` runs nothing; `abort` cores; uncaught exception terminates without unwinding.
18. **When does `std::terminate` get called?** — Uncaught exception, `noexcept` violation, throw during unwinding, joinable `~thread`, throwing static destructor, null `rethrow_exception`.
19. **How would you write a scope guard, and how does `scope_fail` know?** — RAII wrapper over a callable with a `dismiss()` flag and a `noexcept` destructor; `scope_fail` compares `std::uncaught_exceptions()` (plural, C++17) at construction and destruction.

---

## Common Traps

- **`return std::move(local);`** — disables NRVO; `-Wpessimizing-move`.
- **Adding a destructor to a class** — suppresses the implicit move operations, turning every move into a copy silently.
- **Moving from a `const` object** — binds to `const T&`, copies, no diagnostic.
- **Using a named `T&&` parameter without `std::move`** — it is an lvalue inside the function.
- **Forgetting `noexcept` on a move constructor** — `std::vector` growth silently copies every element.
- **Assuming a moved-from `std::string` is empty** — valid but *unspecified*.
- **Throwing from a destructor** — destructors are implicitly `noexcept`; this terminates.
- **`throw e;` instead of `throw;` in a handler** — slices to the static type.
- **`catch (std::exception e)` by value** — slices and copies.
- **`catch (...)` without rethrowing** — swallows forced unwinds and breaks `pthread_cancel`.
- **Believing `noexcept` speeds up the function body** — it enables *algorithms*, and lets callers omit cleanup; it does not accelerate straight-line code.
- **Relying on the strong guarantee from `vector::insert` in the middle** — that is basic only.
- **Throwing on a hot path** — microseconds, an allocation, and a process-global unwinder lock.
- **Mixing `-fno-exceptions` and exception-enabled TUs and letting an exception cross the boundary** — UB, destructors skipped.
- **`*optional` when empty** — UB, not a throw.
- **`optional<bool>` truth-testing** — tests engagement, not the value.
- **A `std::string` error type in `expected`** — kills triviality, allocates on the error path, leaves registers.
- **Ignoring an `error_code` return** — mark it `[[nodiscard]]`.
- **`std::exit` in a multithreaded program** — runs static destructors while other threads are still running them; use `_Exit` or `quick_exit` for crash paths.
- **Destroying a joinable `std::thread`** — `std::terminate`. Use `jthread`.
- **Calling `malloc`/`backtrace_symbols`/`std::stacktrace` from a signal handler** — not async-signal-safe; deadlocks on the allocator lock.
- **A scope guard whose action can throw** — destructor is `noexcept`; wrap and log.

---

## Compact Recall Summary

**Elision.** Prvalue returns are guaranteed elided since C++17 (a prvalue is an initializer, not an object), so even immovable types can be returned by value. NRVO remains optional and is defeated by multiple return objects and by `return std::move(x)`. Implicit move makes `return x;` use the move constructor when elision fails; C++20/23 extended it to parameters, `throw` operands, conversions, and reference returns.

**Moves.** `std::move` is a cast that generates no code; a "move" is just overload resolution. It degrades to a copy when the type has no move operations (a user-declared destructor or copy suppresses them), when the source is `const`, when a named `T&&` is used without `std::move`, or when a vector reallocates a type with a throwing move. `noexcept` on move construction is mandatory for performance because of `move_if_noexcept`; assert it. Moved-from means valid-but-unspecified.

**Move-only.** Deleted copies plus `noexcept` moves is the cheapest correct ownership model. `std::exchange` in the move constructor; swap in move assignment. `std::function` needs copyable callables — use C++23 `move_only_function`. Immovable types can be returned by value only since C++17.

**Unwinding.** Two phases: search (nothing destroyed, so an uncaught exception cores with the stack intact) then cleanup (landing pads). Catch by const reference; `throw;` rethrows without slicing. Cost: zero on the happy path under the table model; on throw, an allocation plus unwind-table decoding plus a global lock — microseconds, and worse under contention. Tables live in `.eh_frame`, `.eh_frame_hdr`, and `.gcc_except_table`, costing 10–20% binary size.

**Safety levels.** No-throw ⊃ strong ⊃ basic ⊃ none. Basic comes free from RAII and is the floor. Strong comes from copy-and-swap or from ordering all fallible work before any state change, with a dismissible scope guard as the general rollback tool. `vector::push_back` is strong (conditionally), `vector::insert` in the middle is basic, `sort` is basic.

**Error channels.** `optional<T>` for reasonless absence (inline storage, `*` is UB when empty, no `optional<T&>` before C++26, `optional<bool>` traps). `expected<T,E>` (C++23) for routine failures needing a reason — union layout, monadic `and_then`/`transform`, `[[nodiscard]]`, keep `E` small and trivial. `error_code`/`error_condition` for OS errors. Exceptions for genuinely exceptional conditions and for constructors, which have no return channel. HFT posture: exceptions enabled globally, structurally absent from the hot path, hot-path functions marked `noexcept`.

**Termination.** `exit` runs static destructors and flushes; `quick_exit` runs only its own handlers; `_Exit` runs nothing; `abort` cores. `std::terminate` fires on uncaught exceptions, `noexcept` violations, throws during unwinding, and joinable `~thread`. Install a `set_terminate` handler that logs the current exception and calls `abort` for a core. Signal handlers are restricted to async-signal-safe calls — no `malloc`, no `std::stacktrace`.

**Scope guards.** RAII over a callable, `noexcept` destructor, `dismiss()` for commit. `scope_fail`/`scope_success` compare `std::uncaught_exceptions()` (plural since C++17). Available as `folly::makeGuard`, `absl::Cleanup`, `gsl::finally`, LFTS v3 `experimental::scope_exit`; standardized in `<scope>` for C++26. Compiles to nothing.
