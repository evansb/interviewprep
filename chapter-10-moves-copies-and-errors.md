# Chapter 10 — Moves, Copies, and Errors

*Both halves of this chapter are about paths you did not write explicitly: the copy the compiler elided or silently reinstated, and the unwind that runs when a function does not return normally.*

---

## Why this matters in an HFT interview — Core
Two questions recur in senior C++ interviews: does this return value get copied, and what happens when this call fails? Both concern code the compiler generates on your behalf. Getting move semantics wrong can silently reintroduce allocations on a path that looked optimized. Getting error transport wrong either hides a failure the caller needed to see, or puts path-dependent exception handling on a latency-constrained path.

This chapter has two parts. Part A covers value transfer: when a copy is elided, when a "move" actually moves something, and when it quietly falls back to a copy. Part B covers failure transport: exceptions, error codes, `optional`, `expected`, and how a function terminates. Interviewers use this material to test whether you can predict what the compiler generates and whether you can choose a failure-transport mechanism from the shape of the problem rather than from habit.

## 90-second screen — Core
Five facts:

1. A prvalue return (`return T{args};`) is guaranteed elided since C++17. NRVO — returning a named local — is only ever permitted, never required.
2. A move is overload resolution selecting a `T&&` overload. If none is viable (no move constructor, source is `const`, wrong value category), a viable copy overload can be selected silently; with neither operation, the program is ill-formed.
3. To preserve rollback during `std::vector` reallocation, implementations prefer copying when move construction may throw and copying is available—the choice expressed by `std::move_if_noexcept`.
4. On common table-based ABIs, exception handling searches for a handler and then unwinds through cleanup code. The C++ standard specifies which destructors run when a handler is reached, but does not prescribe that ABI mechanism or require unwinding before `std::terminate`.
5. `optional<T>` means "value or nothing, no reason needed." `expected<T,E>` means "value or a reason." Both hold their active object inline. Common table-based exception implementations add little or no executed work when no throw occurs; throwing has high, path-dependent cost.

Two decisions:

- Make a move operation `noexcept` when its implementation can honor that contract, and test the trait on resource types intended for containers. A false `noexcept` promise terminates; a missing one can make library code choose copying.
- Whenever a function can fail in a way the caller must react to, decide up front whether the failure is exceptional (exception), reasonless absence (`optional`), or a routine outcome the caller must inspect (`expected`/error code). Do not default to exceptions out of habit.

---

## Part A: Value Transfer and Elision

## 10.1 Copy Elision: RVO and NRVO — Core

Copy elision constructs an object directly in its final location instead of construct-then-copy-then-destroy. Two named cases matter here:

- **RVO** (Return Value Optimization) — returning a prvalue: `return T{args};` or `return f();`.
- **NRVO** (Named Return Value Optimization) — returning a named local by value: `T t; ...; return t;`.

The usual mechanism is a hidden return-slot pointer: under the System V AMD64 ABI, some class returns use caller-provided storage into which the callee constructs the result (Chapter 41 §41.8 covers structure-return ABI). This is an implementation detail; the C++ rule specifies object construction and observable behavior, not registers or hidden parameters.

```cpp
struct Big { int x; int y; };

Big make() { return Big{1, 2}; }

int main() {
    Big b = make();   // no intermediate Big is copied or moved
    return b.x;
}
```

### Guaranteed vs. permitted

C++17 reframed what a prvalue is: it is no longer a temporary object but an initializer for one, materialized only when needed. This makes RVO for a prvalue return a guarantee, not an optimization the compiler may skip.

| Case | Before C++17 | C++17 and later |
|---|---|---|
| `return T{...};` (prvalue) | Elision permitted; copy/move ctor must still exist | Guaranteed elision; no copy/move ctor required at all |
| `T t; return t;` (NRVO) | Permitted, not required | Still permitted, not required |
| `T t = T(T(T()));` | Permitted | Guaranteed — one object, one construction |

NRVO eligibility is a language rule, not an escape-analysis rule. At a `return`, the operand must be the name of a non-`volatile` automatic object (not a function parameter or handler parameter) whose type matches the return type ignoring top-level cv-qualification. Taking the local's address does not itself defeat NRVO; when elision occurs, source and result are two ways to refer to the same object. Eligibility still does not require an implementation to elide.

```cpp
T f(bool c) { T a, b; return c ? a : b; }   // Not an id-expression naming one local — never
                                             // eligible for NRVO or implicit move; selects from lvalues.
T g(bool c) { T a, b; if (c) return a; return b; }  // Two candidates, same slot address known
                                             // at entry. Each return is eligible; elision remains
                                             // optional and implementation-dependent.
T h() { T t; return std::move(t); }         // NRVO disabled; overload resolution sees an xvalue.
```

### The pessimizing `std::move` on return

`return std::move(t);` turns the return operand from an lvalue naming a local into an xvalue. The operand is no longer a bare id-expression, so NRVO cannot apply, and overload resolution normally selects a move construction that could otherwise have been omitted. A dynamically allocated `std::string` may transfer a pointer; a `std::array<double, 64>` transfers every element. `-Wpessimizing-move` (GCC/Clang) flags the pattern.

Write `return t;`, not `return std::move(t);`. Implicit move already covers the case where NRVO does not fire: `return t;` treats `t` as an rvalue for overload resolution when it names an automatic local ([class.copy.elision]), so a move constructor is used instead of a copy without blocking elision on the paths where elision does apply.

C++20 expanded several implicit-move cases, including conversion from an eligible local to a related return type. C++23 simplified the rule: a move-eligible expression is treated as an xvalue for overload resolution. These version details matter in generic edge cases; the durable rule is to return an eligible local without adding `std::move`.

Guaranteed elision makes return by value a strong default for factories: `return T{...};` creates no intermediate `T`. It does not remove allocations performed by `T`'s own constructor. NRVO is defeated by `return std::move(t)` and does not apply to returning a member or global, because those expressions do not name an eligible automatic object. Use an instrumented type or inspect optimized code if optional NRVO matters.

---

## 10.2 How a Move Is Chosen — and How It Silently Becomes a Copy — Core

A move is not a language primitive. It is overload resolution selecting a constructor or assignment operator that takes `T&&`. If no such overload is viable, a viable `const T&` overload can win and copy without a warning. If copying is unavailable too, the expression is ill-formed.

`std::move` is a cast, `static_cast<T&&>(x)`. It moves nothing and generates no code; it only changes the value category of an expression so a different overload can be selected.

### Copy versus move construction and assignment

Construction creates a new object; assignment changes an object whose lifetime has already begun. That distinction determines both the selected special member and the resource work required.

| Expression | Operation considered | Typical owning-type effect |
|---|---|---|
| `T b = a;` | copy construction | acquire a distinct resource representing `a` |
| `T b = std::move(a);` | move construction, with copy fallback | transfer or reproduce `a`'s value into new storage |
| `b = a;` | copy assignment | release/replace `b`'s old value, then copy |
| `b = std::move(a);` | move assignment, with copy fallback | release/replace `b`'s old value, then transfer |

This instrumented example makes overload selection visible and compiles as C++23:

```cpp
#include <iostream>
#include <utility>

struct Trace {
    Trace() = default;
    Trace(const Trace&) { std::cout << "copy construct\n"; }
    Trace(Trace&&) noexcept { std::cout << "move construct\n"; }
    Trace& operator=(const Trace&) {
        std::cout << "copy assign\n";
        return *this;
    }
    Trace& operator=(Trace&&) noexcept {
        std::cout << "move assign\n";
        return *this;
    }
};

int main() {
    Trace a;
    Trace b = a;
    Trace c = std::move(a);
    b = c;
    c = std::move(b);
}
```

For an owning type, copy operations must establish independent ownership; move operations normally transfer ownership and leave the source valid. Chapter 6 owns the rules that declare, delete, or suppress these special members. Here the interview task is to identify which expression category reaches which overload.

### Four copy fallbacks—and one expensive move

**No move operations exist.** A user-declared destructor, copy constructor, or copy assignment operator suppresses implicit generation of the move constructor and move assignment.

```cpp
struct Buf {
    std::vector<char> data;
    ~Buf() { log("gone"); }      // suppresses the implicit move ctor and move assign
};
Buf a = std::move(b);            // copies the vector — no diagnostic
```

Adding a destructor to a class (the Rule of Five, Ch. 6) has this cost. Fix with `Buf(Buf&&) = default;` plus the assignment, or restructure so no destructor is needed (Rule of Zero).

**The object is `const`.** `const T&&` does not bind to `T&&`; it binds to `const T&`.

```cpp
const std::string s = "...";
v.push_back(std::move(s));       // copies — s is const
```

Returning `const T` by value can also inhibit move overloads at consuming call sites; top-level `const` on a returned class value is usually counterproductive.

**A named `T&&` parameter is used without `std::move`.** Inside a function body, a parameter declared `T&&` is itself an lvalue.

```cpp
Widget(std::string&& s) : name_(s) {}              // copies
Widget(std::string&& s) : name_(std::move(s)) {}   // moves
```

**The move constructor is not `noexcept` and a `vector` is reallocating.** Covered in §10.3.

**A selected move may still do copy-like work.** `std::array<T,N>` moves element-wise; a `std::string` using a small-string representation normally transfers its inline characters; a trivial aggregate's move construction performs the same value transfer as its copy construction. This is not a copy fallback—the move overload was selected—but it explains why "moved" does not mean "cheap."

### `std::forward` preserves a caller's value category

Use `std::move` when this scope is unconditionally giving up an object. Use `std::forward<T>` only with a forwarding reference whose template argument records how the caller passed the expression:

```cpp
#include <utility>

template<class T>
void relay(T&& x) {
    consume(std::forward<T>(x));
}
```

If the caller passes an lvalue, `T` is deduced as an lvalue-reference type and `forward<T>(x)` is an lvalue. If the caller passes an rvalue, it is an xvalue. Writing `consume(x)` always passes an lvalue because `x` is named; writing `consume(std::move(x))` always offers the caller's object for moving, including when the caller passed an lvalue. Outside forwarding code, prefer a direct `std::move` when ownership is intentionally transferred.

### Moved-from state

Unless a component gives a stronger postcondition, a moved-from standard-library object is placed in a valid but unspecified state. Operations whose preconditions it satisfies remain legal, and destruction or assignment is safe; do not infer a particular value. Several types specify more: a moved-from `unique_ptr` is null, a moved-from `shared_ptr` is empty, and a moved-from `thread` is not joinable. `std::string` is not guaranteed empty after a move.

For your own types, leave the source in a cheaply-destructible, self-consistent state. Do not skip nulling a moved-from owning pointer — the destructor will double-free.

### Self-move

For standard-library types covered by the library's MoveAssignable requirements, `x = std::move(x)` must leave `x` valid but its value may be unspecified. Give an application type an equally clear contract. A swap-based implementation often tolerates self-move without an identity branch; a release-then-acquire implementation may need `if (this != &other)`. Do not assume member-wise move assignment is self-move-safe without checking each member's contract.

Verification: build with warnings, and in tests use a probe type that counts copy and move constructions. Unexpected allocation traffic can indicate a copy fallback, container growth, or an allocation inside the moved type; correlate allocation and construction traces before concluding.

---

## 10.3 `noexcept` and Move Operations — Core

`noexcept` on a move constructor changes which algorithm the standard library runs; it is not decoration.

### The vector reallocation problem

`vector::push_back`, when `size() == capacity()`, allocates a new buffer and transfers `n` elements. If it moves them and element 7's move constructor throws, the new buffer holds 7 constructed elements and the old buffer holds 7 gutted ones — there is no way to restore the original vector, so the strong exception guarantee (§10.6) is unreachable. If it copies them and element 7 throws instead, the old buffer is untouched: destroy the new copies, free the new buffer, rethrow, original vector intact.

Implementations commonly express the required choice with `std::move_if_noexcept`, conceptually:

```
if (is_nothrow_move_constructible_v<T> || !is_copy_constructible_v<T>)
    move each element
else
    copy each element
```

| `T`'s move ctor | `T` copyable? | Reallocation does |
|---|---|---|
| `noexcept` | either | move |
| potentially throwing | yes | copy is selected to preserve rollback; copies may allocate |
| potentially throwing | no (move-only) | move (no alternative); effects after a throw are restricted by the operation's specification |
| absent | yes | copy |

Do not generalize this to every library move operation: exception specifications can depend on the operation, element type, deleter, comparator, or allocator traits. For a resource handle whose transfer consists only of copying a handle and clearing the source, a non-throwing contract is appropriate:

```cpp
struct Conn {
    Conn(Conn&&) noexcept;
    Conn& operator=(Conn&&) noexcept;
};
static_assert(std::is_nothrow_move_constructible_v<Conn>);
```

Put the `static_assert` near code that relies on the trait; it catches a later member change that would alter container behavior.

### When `noexcept` is deduced

An implicitly generated or defaulted move operation gets a computed exception specification based on the corresponding operations of bases and members. A single potentially throwing suboperation can make the whole move potentially throwing. Construction and assignment are distinct: allocator propagation and equality can make a container's move assignment conditional even when its move construction is non-throwing. Check the exact trait you need, such as `std::is_nothrow_move_constructible_v<T>` or `std::is_nothrow_move_assignable_v<T>`.

### Violating `noexcept`

If an exception exits a `noexcept` function, `std::terminate` is called. Whether the implementation unwinds any part of the stack first is unspecified. `noexcept` is therefore a semantic promise, not an optimization hint; write it only when every path, including cleanup and user callbacks, can honor it.

### `noexcept` and code generation

`noexcept` can remove exceptional control-flow edges at a call site and enable optimization, but it does not generally remove all unwind metadata: ABIs also use that metadata to unwind through frames, produce backtraces, or support other language runtimes. Do not promise an I-cache or runtime gain without comparing the target toolchain's code and binary sections. Its portable value is stronger: generic code can inspect the specification and select an algorithm such as copy-versus-move transfer.

Make move operations, `swap`, destructors, and leaf accessors `noexcept` when their implementations cannot throw. An implicitly declared destructor is non-throwing when the destructors it invokes are non-throwing; a throwing member destructor changes that result. Allocation is evidence that a non-throwing promise needs an explicit exhaustion policy, not an automatic prohibition. Changing a public exception specification can affect type compatibility and generic-code choices, so treat it as part of the interface.

---

## 10.4 Move-Only and Immovable Types — Core

A move-only type has deleted copy operations and available move operations: `std::unique_ptr`, `std::thread`, `std::jthread`, `std::future`, `std::promise`, `std::packaged_task`, `std::fstream`, `std::unique_lock`, and any RAII handle over a non-duplicable resource.

```cpp
#include <unistd.h>  // POSIX close; not standard C++
#include <utility>

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

`std::exchange` (C++14) expresses the move-constructor invariant: install the source's null state and return its old handle. Swap-based move assignment defers releasing the destination's old resource to the source's destructor and tolerates self-move. A release-then-transfer implementation can release promptly but must test self-move before closing anything.

Copying a file descriptor, a thread, or a lock either needs `dup`-style duplication with unclear ownership or is meaningless. Deleting the copy makes ownership a compile-time property: exactly one object owns the resource, so double-close and use-after-close become type errors.

### Interactions to know

- `std::vector<std::unique_ptr<T>>` supports operations whose requirements its element type meets, including end insertion and sorting with a suitable ordering; those operations can rearrange elements by move. `resize(n)` can default-construct null pointers. An initializer-list construction from temporary `unique_ptr`s fails because `initializer_list` elements are `const` and the vector constructor must copy from them.
- `std::function` requires a `CopyConstructible` callable, so a lambda capturing a `unique_ptr` cannot be stored in one. `std::move_only_function` (C++23) removes that requirement and is also better-specified about const and reference qualification.
- Passing a move-only type by value (`void take(Fd f)`) makes the transfer explicit at the call site (`take(std::move(f))`); passing by `Fd&&` also works but leaves whether the callee actually takes ownership implicit.
- Returning a prvalue `Fd{raw}` requires no move construction. Returning a named `Fd` is eligible for NRVO and otherwise uses implicit move.

### Immovable types

Deleting the move operations too — `std::mutex`, `std::atomic`, `std::condition_variable`, and anything holding a self-pointer or a registered address — means the object cannot change address after construction. It cannot live in a `vector` that may reallocate, and before C++17 could not be returned by value at all; C++17's guaranteed elision allows returning an immovable prvalue, since no move or copy is needed:

```cpp
struct Immovable {
    Immovable(const Immovable&) = delete;
    Immovable(Immovable&&) = delete;
    Immovable();
};
Immovable make() { return Immovable{}; }   // ill-formed before C++17, fine since
```

Hold an immovable object at a stable address: behind a `unique_ptr`, in suitable node-based storage, or in fixed-capacity storage constructed in place. A `deque` does not relocate existing elements when growing at its ends, but middle insertion has separate movement and invalidation rules (Chapter 11).

**Low-latency angle.** A move-only handle can encode exclusive ownership without a reference-count update or a second allocation. Its call ABI is implementation-specific: some ABIs pass even pointer-sized non-trivial class objects indirectly. Do not weaken ownership to a raw handle on that basis alone. If a measured call boundary matters, compare an ownership-preserving signature, inlining, and a lower-level internal interface while keeping the public lifetime contract explicit.

---

## Is a move guaranteed, or can the compiler still copy? — Core
The compiler never copies where the standard guarantees elision — a prvalue return, or a variable directly initialized from a prvalue — because after C++17 there is no copy to elide: the object is constructed once, in place.

Everywhere else, "move" is not guaranteed at all. It is the outcome of ordinary overload resolution at the point where you write `std::move(x)`, `return x;` on an eligible local, or pass an rvalue argument. A viable copy can be the fallback when no move overload is viable, and conditional dispatch such as `move_if_noexcept` can deliberately select copying. With neither operation available, the expression is ill-formed. So the answer has two parts:

- **Elision** (RVO, guaranteed NRVO is not a thing, mandatory copy elision for prvalues) is a language guarantee: no object is copied or moved at all, because the compiler was never required to make a temporary in the first place.
- **Move** is never guaranteed by name; it is what you get when a `T&&` overload is viable and wins resolution. `noexcept`, `const`-ness, a missing move constructor, or a `move_if_noexcept` fallback can all silently substitute a copy instead, and the language will not warn you.

The practical rule is to derive the result: first ask whether elision applies; otherwise identify the expression's value category, list viable copy/move overloads, and apply overload resolution. For a library algorithm, then check whether its specification or implementation makes a conditional `noexcept` choice.

---

## Part B: Failure Transport and Guarantees

Part A covered what happens on the paths that construct and transfer values. Part B covers what happens when a function cannot produce a value at all: how the failure is represented, what it costs, and what guarantee the caller can rely on about program state afterward. The two parts share a throughline — both are about compiler-generated paths — but the design question shifts from "how do I avoid an unnecessary copy" to "how do I choose what a failure costs and who can see it."

## 10.5 Exceptions and Stack Unwinding — Core

A `throw` transfers control from the throw point to a matching `catch`, destroying every automatic object constructed in between.

### The stages

**Throw.** `throw X{args}` initializes an exception object in implementation-managed storage and begins exception handling. The standard does not require a general-purpose heap allocation for that object. Implementations usually obtain runtime-managed storage and commonly reserve emergency capacity for low-memory cases; the mechanism and contention behavior are not portable.

**Search and cleanup.** The Itanium C++ ABI used on many Unix-like targets performs phase 1 to search for a handler without destroying objects, then phase 2 to run cleanup landing pads until reaching that handler. Other ABIs may use a different mechanism. The C++ guarantee is behavioral: when control reaches a handler, automatic objects whose scopes were exited are destroyed in reverse construction order. If no matching handler exists, `std::terminate` is invoked; whether the implementation unwinds first is implementation-defined.

```text
Common table-based implementation

throw
  │
  ├─ search frames for a matching handler
  │      └─ none found ──► std::terminate
  │
  └─ handler found
         └─ unwind toward it
              ├─ destroy exited-scope objects in reverse construction order
              └─ enter catch clause
```

**Catch matching** is by type, in source order within a handler sequence: exact type and specified reference, qualification, pointer, and accessible-base conversions can match. General implicit conversions do not — `catch (long)` does not catch a thrown `int`. Put derived handlers before base handlers. `catch (...)` catches any C++ exception; platform runtimes can impose additional rules for foreign or forced unwinds.

```cpp
try { f(); }
catch (const std::out_of_range& e) { /* most derived first */ }
catch (const std::exception& e)    { /* avoid slicing and copying */ }
catch (...) { cleanup(); throw; }   // bare throw rethrows the current exception, no copy
```

Catching by value can copy and slice (Chapter 6); catch polymorphic exceptions by reference, normally `const` reference. `throw;` in a handler rethrows the current exception object. `throw e;` initializes a new exception from the expression's static type and can slice when `e` is a base-class reference.

### Cost model

On common table-based implementations, entering a `try` block normally adds no executed instruction on the non-throwing path, although exception edges can affect optimization and metadata increases binary size. A throw initializes the exception object, searches for a handler, and may run cleanup code across many frames. Allocation, lookup, and locking details depend on the runtime. There is no portable cycle count: measure throw frequency and latency distribution on the deployed toolchain, with representative stack depth and loaded libraries.

For a latency-constrained path, exceptions are usually a poor representation of routine rejection or absence because throw latency varies with the dynamic path and cleanup work. They can still fit coarse startup or recovery boundaries where automatic propagation and rich context matter more. A lookup miss often maps to `optional`; a failed lookup caused by an I/O error needs a reason and therefore does not.

### `current_exception` and nesting

`std::current_exception()` captures the current exception in an `std::exception_ptr`, so it can be stored, transferred across threads, and rethrown with `std::rethrow_exception`. Its representation and whether copying it uses atomic reference counting are implementation details. This is how promises and futures can propagate failures. If a destructor exits by throwing while another exception is already causing unwinding, `std::terminate` is called. Cleanup functions should therefore be non-throwing.

### Deep dive: the table-based mechanism

"Zero-cost" exceptions means zero or near-zero executed handler-registration work on the non-throwing path, not zero total cost. Table-based schemes trade that work for metadata, exceptional control-flow edges, and expensive throws. SJLJ-style schemes register handlers dynamically and therefore impose different non-throwing-path costs; target and toolchain determine the model.

The compiler emits, per function, static data describing the frame:

| Section | Contents |
|---|---|
| `.eh_frame` | DWARF Call Frame Information describing how to restore registers for PC ranges; also useful to debuggers and profilers. |
| `.eh_frame_hdr` | An optional index over frame information. |
| `.gcc_except_table` | Language-specific data mapping call-site ranges to cleanup and handler actions. |
| `.text` | Landing pads that run cleanup or enter handlers; optimizers may place uncommon code in cold regions. |

At runtime on such a target, the unwinder uses frame information and a language personality routine to inspect each relevant frame and its language-specific data. Exact lookup structures and placement are toolchain choices.

Metadata and landing pads add code or data size, and exceptional edges can affect optimization. The amount varies too much to summarize with a percentage. Compare section sizes, generated code, non-throwing throughput, and throw-latency percentiles for the actual build. Disabling C++ exception syntax may remove language-specific tables, but platforms can retain unwind information for profiling, debugging, or unwinding through the frame.

Platform runtimes may reuse unwind machinery for thread exit, cancellation, or foreign-language exceptions. That is a boundary contract, not portable C++ behavior. Frame pointers are a separate stack-walking aid often used by profilers; Windows x64 uses analogous but distinct table metadata.

---

## 10.6 Exception-Safety Guarantees — Core

Four levels, weakest to strongest, are contracts you assert about your own functions and rely on from the library.

| Guarantee | Meaning | Example |
|---|---|---|
| No-throw | Does not emit an exception to its caller; its contract may still allow termination or a reported failure. | `vector::size`; a correctly specified handle move |
| Strong | Commit-or-rollback: on a throw, state is exactly as before the call. | `vector::push_back` when `T`'s move is `noexcept` or `T` is copyable |
| Basic | No leaks and invariants hold, but observable state may change. | A documented multi-step update that preserves validity on each step |
| None | No useful postcondition; invariants or ownership may be broken. | Raw resource mutation without RAII or rollback |

Basic should be the floor for ordinary recoverable operations. RAII prevents resource leaks during unwinding, but it does not by itself preserve a multi-object invariant; mutation order and rollback still matter.

### Achieving the strong guarantee

```cpp
Widget& Widget::operator=(const Widget& rhs) {
    Widget tmp(rhs);      // all fallible work happens here, on a temporary
    swap(*this, tmp);     // noexcept commit
    return *this;         // tmp's destructor releases the old state
}
```

Do all fallible work on a copy, then commit with a `noexcept` operation. Copy-and-swap gives the strong guarantee and handles self-assignment as a side effect. Its cost is an extra allocation and copy on every assignment — which is why the standard library's own containers do not use it internally; a `vector::assign` that can reuse an already-sufficient buffer is cheaper than allocate-copy-swap, so hot-path code often accepts the basic guarantee plus explicit checks instead.

### Where library guarantees land

Do not assign one guarantee to a container name; read the operation's exception paragraph and its type requirements.

- `vector::reserve` and end insertion generally have no effect when allocation or construction throws. When the implementation must use a potentially throwing move of a non-copyable element, the standard permits weaker or unspecified effects if that move throws.
- Middle insertion can need move construction and move assignment of existing elements. Its guarantee depends on which of those operations can throw and where capacity is available.
- Erasing from `vector` does not allocate, but element move assignment can throw; a partial shift can leave a valid yet changed sequence.
- A standard algorithm whose user-supplied comparison or move operation throws may leave the range rearranged. A comparator that violates the required strict weak ordering violates the algorithm's precondition.
- Node-based insertion can usually construct a node before linking it, which supports rollback, but allocator and user callback exceptions still need to be checked against that specific overload.

### The commit/rollback discipline

Order operations so everything that can fail happens before anything that changes observable state: allocate before linking, construct the node before splicing it in, build a new config object before swapping the pointer to it. When operations cannot be reordered this way, use a scope guard (§10.13) with an explicit `dismiss()`.

The strong guarantee is not free and is not always the right target. Preserving it while transferring copyable elements whose moves may throw can require O(n) copies. Providing it for a function that has already sent a network packet is not possible—you cannot un-send. State which level you promise and identify the irreversible boundary.

---

## 10.7 Disabling Exceptions — Role-specific

`-fno-exceptions` (GCC/Clang) and MSVC exception-handling flags are implementation modes, not C++ language features. They can reject exception syntax in the affected translation unit and remove some C++ exception metadata; exact behavior, library compatibility, and retained unwind information are toolchain-specific.

### What changes

- Standard-library operations whose specified failure is an exception still need a vendor policy. A particular library build may terminate, abort, fail to link, or require an exception-enabled boundary. Inspect and test the deployed library; the standard does not define `vector::at` under a non-standard no-exceptions mode.
- Ordinary throwing `operator new` has no alternative standard failure result. Code in this mode commonly uses checked `new (std::nothrow)`, a bounded allocator with an explicit exhaustion policy, or a toolchain-provided termination policy.
- RAII still works for normal returns; only the unwinding path is gone.

### Who does this, and why

Game engines, embedded and freestanding targets, and some HFT stacks. In roughly decreasing order of how well the reason holds up:

1. Predictability — throw latency depends on dynamic stack depth, cleanup, and runtime state, making it difficult to budget on a p99.9-sensitive path.
2. Binary size on a constrained target.
3. Interop with a C library or runtime that cannot unwind through it.
4. "Exceptions are slow," asserted without separating the non-throwing path, throw path, metadata size, and optimization effects.

A common posture is narrower than global `-fno-exceptions`: exceptions remain available during startup, configuration, and recovery, while hot-path APIs use `noexcept` contracts plus explicit results. Preallocation (Chapter 7) removes known allocation and `bad_alloc` paths, but every callee and callback still has to be audited before the boundary can honestly be non-throwing.

### Deep dive: mixing translation units

Compilers can link translation units built with different exception modes, but safe propagation across such a boundary is an ABI and toolchain question. A no-exceptions frame may lack cleanup landing pads, so its automatic objects may not be destroyed even if the runtime can unwind through it. Put an exception-enabled adapter at the boundary, catch there, and translate failure before entering no-exceptions code. Test the exact compiler, flags, and libraries rather than assuming cross-mode propagation is supported.

`-fno-rtti` is separate: supported compilers retain the type data needed for catch matching while restricting uses such as `dynamic_cast` and `typeid`. Unwind-table flags are separate again and can affect backtraces or profilers. None of these vendor switches is made portable by the C++23 freestanding library subset.

---

## 10.8 Error Codes — Core

An error code signals failure without unwinding, in-band or out-of-band:

```cpp
int  parse(const char* s, Value* out);              // C style: return code, out-param
Value parse(const char* s, std::error_code& ec);    // library style
std::expected<Value, ParseError> parse(...);        // C++23, §10.10
```

### `<system_error>`

| Type | Role |
|---|---|
| `std::error_category` | A namespace for codes, compared by singleton address: `generic_category()`, `system_category()`, or a custom one. |
| `std::error_code` | A specific platform error: `{value, category}` — `errno`/`GetLastError` lives here. |
| `std::error_condition` | A portable condition to compare against, e.g. `std::errc::no_such_file_or_directory`. |
| `std::system_error` | The exception type wrapping an `error_code`, for code that does throw. |

`ec == std::errc::no_such_file_or_directory` asks the category whether its concrete code is equivalent to that portable condition. Whether a platform category supplies a useful mapping depends on its implementation. An `error_code` stores an integer and category identity without owning an error message; its exact layout, triviality, and calling convention are not specified.

`<filesystem>` demonstrates the dual-API convention worth imitating: a throwing overload and an `error_code&` overload of the same function.

```cpp
std::filesystem::file_size(p);        // throws filesystem_error
std::filesystem::file_size(p, ec);    // sets ec; also returns a sentinel on failure
```

### Failure modes of error codes

- **Ignoring the return value.** `[[nodiscard]]` (C++17) exists for this; apply it to error-returning functions and, on a type, to every function that returns that type.
- **Losing context.** An `error_code` says `ENOENT`, not "while loading `/etc/app/config.yaml`." A code composes with `expected<T, RichError>` if context is needed, or is logged where it's produced.
- **Sentinel interleaving.** A return that is both a status and a value (`read()` returning `-1` or a byte count) forces sentinel checks that are easy to get wrong (Ch. 23 covers sentinel hazards in numeric code).

### Cost model

An error-code check creates an explicit control-flow edge at each call site. When failure is rare and stable, that branch is often predicted correctly, but prediction depends on history and code layout. The trade against exceptions:

| | Exception | Error code |
|---|---|---|
| Happy-path cost | Usually no dynamic registration under the table model; metadata/optimization effects remain | Explicit test and propagation at each level |
| Error-path cost | Search plus cleanup proportional to the dynamic path; runtime details vary | Explicit tests, context creation, and propagation |
| Ignorable | No | Yes, unless marked `[[nodiscard]]` |
| Propagates automatically | Yes | No — manual at every level |
| Works from a constructor or operator | Yes | No — no return channel |

That last row is the reason a design that bans exceptions must also ban failing constructors: use a static `create()` factory returning `expected`, or accept the invalid-object window RAII exists to close.

---

## 10.9 `std::optional<T>` — Core

`optional<T>` (C++17) models "a `T` or nothing," where absence is not an error: a lookup miss, an unset configuration field, end of sequence.

### Representation

The contained `T`, when engaged, is nested within the `optional`; no separate dynamic allocation is required by `optional` itself. Implementations generally need storage for `T` plus engagement state and possible padding, but size and layout are not specified. `optional` itself never has a third, valueless-by-exception state: it is either engaged or disengaged. Operations performed to construct or copy `T` can still allocate or throw.

### Interface, and where the UB is

```cpp
std::optional<int> o = find(k);
if (o) use(*o);                 // operator*: undefined behavior if empty
o.value();                      // throws std::bad_optional_access if empty
o.value_or(0);                  // returns held value or converted fallback; that transfer can throw
o.reset(); o.emplace(args...);  // in-place construction, no temporary
```

`*o` on an empty `optional` is undefined behavior, not a throw. `value()` is the checked accessor, and because it throws it is not usable in `-fno-exceptions` code.

C++23 added monadic operations that remove most branchy plumbing:

```cpp
auto n = parse(s)                                            // optional<int>
             .transform([](int v) { return v * 2; })         // optional<int>
             .and_then([](int v) { return validate(v); })    // optional<int>
             .or_else([] { return std::optional<int>{0}; }); // optional<int>
```

### Gotchas

- `optional<bool>` is effectively three-state, and `if (ob)` tests engagement, not the contained value.
- `optional<T&>` does not exist through C++23. Use a pointer when null is a natural non-owning state, or `std::reference_wrapper<T>` when reference-like syntax is useful.
- Comparisons are defined; an empty `optional` compares less than any engaged one, and `optional<T>` compares directly against `T` and against `std::nullopt`.
- `optional` has an implementation-defined object representation and is not a portable wire-format field; encode presence explicitly (Chapter 3).
- Chained `optional` is not an error channel: it discards *why* something failed. That is what `expected` is for.

**Low-latency angle.** A small trivially copyable `optional<T>` can have a compact register-return ABI, but verify the target ABI and compiler. Compared with a bool plus out-parameter, it ties engagement to storage initialization and makes misuse harder. Compare code generation only if the boundary is measured as hot.

---

## 10.10 `std::expected<T,E>` — Core

`expected<T,E>` (C++23) is `optional` with a reason: it holds either a `T` or an `E`. It standardizes the pattern behind `folly::Expected`, `tl::expected`, and `absl::StatusOr`.

```cpp
#include <charconv>
#include <expected>
#include <string_view>

enum class ParseError { Invalid, NonPositive };

std::expected<int, ParseError>
parse_positive(std::string_view s) noexcept {
    int value{};
    const auto [ptr, ec] =
        std::from_chars(s.data(), s.data() + s.size(), value);
    if (ec != std::errc{} || ptr != s.data() + s.size())
        return std::unexpected(ParseError::Invalid);
    if (value <= 0)
        return std::unexpected(ParseError::NonPositive);
    return value;
}

int main() {
    return parse_positive("42").value_or(0) == 42 ? 0 : 1;
}
```

### Representation and semantics

The active `T` or `E` is stored within the `expected`; `expected` itself does not require a separate allocation. A typical representation overlaps storage for `T` and `E` and adds a discriminant. Size and layout remain implementation-defined, and constructing either alternative can allocate if that type does.

Unlike `variant`, `expected` has no `valueless_by_exception`-style state. Cross-state assignment overloads are constrained so their available `T`/`E` operations can preserve an engaged-or-unexpected state if construction throws. If the required safe transition cannot be expressed for the chosen types, that assignment overload is unavailable.

| Member | Behavior |
|---|---|
| `operator bool()`, `has_value()` | true iff holding a `T` |
| `operator*`, `operator->` | undefined behavior if holding `E` — same trap as `optional` |
| `value()` | throws `std::bad_expected_access<E>` if holding `E` |
| `error()` | undefined behavior if holding `T` |
| `value_or(x)` | returns the value or a converted fallback; construction can throw |
| `and_then`, `transform`, `or_else`, `transform_error` | monadic composition |
| `std::unexpected<E>` | the tagged constructor for the error side |

```cpp
std::expected<Config, Err> load(std::string_view p) {
    auto bytes = read_file(p);                 // expected<vector<byte>, Err>
    if (!bytes) return std::unexpected(bytes.error());
    return parse_config(*bytes);
}
// equivalently, monadically:
auto load2(std::string_view p) { return read_file(p).and_then(parse_config); }
```

`expected<void, E>` specializes for "succeeds, or fails with a reason" — the direct replacement for a bare error-code return that carries no value on success.

### Trade-offs vs. exceptions

| | `expected` | Exception |
|---|---|---|
| Error-path cost | Explicit branch plus operations of `E`; bounded only if `E` is | Search and cleanup depend on the dynamic path and runtime |
| Propagation | Manual at every level — no `?`-operator equivalent in C++ | Automatic |
| Visible in the signature | Yes; projects can additionally enforce checking with diagnostics or wrappers | No — only `noexcept` or its absence hints at it |
| Usable from constructors/operators | No — no return channel | Yes |
| Ignorable | Yes; apply project diagnostics or a wrapper policy when checking is mandatory | An uncaught failure cannot be silently continued past |

### Practical guidance for latency-sensitive systems

Use `expected` on a hot path for routine failures when both alternatives have controlled operations. A small trivially copyable error enum helps keep transfer and destruction bounded. A string error can allocate and may change the return ABI. If richer context is needed, carry a code or stable identifier and materialize text at a colder boundary.

Combine with `std::error_code` for OS-level errors (`expected<size_t, std::error_code>` for a read) and a domain enum for protocol errors. `expected<T, std::variant<...>>` is expressive but grows the object; a flat error enum is usually the better trade.

---

## 10.11 Choosing a Failure-Transport Mechanism — Core

The four transports differ along axes that map onto real design questions. Use this table before defaulting to whatever the surrounding code already uses.

| Axis | Exception | `expected<T,E>` | `optional<T>` | error code / `error_code` |
|---|---|---|---|---|
| Failure frequency | Rare, truly exceptional | Routine, expected to happen | Absence is a normal outcome, not a failure | Routine, often OS/library boundary |
| Information the caller needs | Rich context, a message, a type hierarchy | A specific reason, cheaply | None — absence needs no explanation | A platform code, comparable across categories |
| API composability | Automatic propagation through many layers | Manual, but monadic (`and_then`/`transform`) at each step | Manual, monadic since C++23 | Manual, no composition support |
| Latency predictability | Depends on call depth, cleanup, and runtime | Explicit and locally analyzable if `T`/`E` operations are bounded | Explicit and locally analyzable if `T` is bounded | Explicit, but context/category operations may add work |
| Recovery boundary | Coarse — a `catch` far from the failure, or the process | Local — the immediate caller must decide | Local — caller supplies a default or skips | Local, or wrapped in an exception at a boundary (`<filesystem>`-style dual API) |

Read the table by starting from the axis that constrains you most. On a hot path, latency predictability often favors an explicit result even when failure is rare. At a configuration or startup boundary, recovery is coarse-grained and rich context may matter more, which can favor exceptions. When the caller must act differently depending on *why* something failed, and that decision belongs close to the call, `expected` fits; when there is nothing to explain, `optional` is the honest signature.

A single system typically uses more than one: `expected` on the parse/validate/risk-check path, `optional` for lookups, exceptions during startup and configuration, and `error_code` at OS-facing boundaries with a throwing wrapper for the non-hot-path callers who want one.

A useful first-pass decision procedure is:

```text
Can any caller recover coherently?
  no  ──► fail-closed / termination policy
  yes
   │
   ├─ Is absence normal and reasonless? ──► optional<T>
   ├─ Is failure routine and reason-bearing? ──► expected<T,E>
   │      └─ at an OS boundary, E may be error_code
   └─ Is propagation across many layers more important than throw-path latency?
          └─ exception, caught at a documented recovery boundary
```

This is a starting point, not a substitute for checking constructor constraints, compatibility with surrounding APIs, and the operations performed by `T` and `E`.

---

## 10.12 Termination and Abort — Core

How a program stops determines what it cleans up first.

| Mechanism | Destructors of automatics | Static/`atexit` destructors | Flushes iostreams | Core dump |
|---|---|---|---|---|
| `return` from `main` | Yes | Yes | Yes | No |
| `std::exit(n)` | No | Yes | Yes | No |
| `std::quick_exit(n)` | No | No (`at_quick_exit` handlers only) | No | No |
| `std::_Exit(n)` | No | No | No | No |
| `std::abort()` | No | No | No | Platform and process-policy dependent |
| `std::terminate()` | Unwinding before the call depends on why it was invoked and the implementation | No guaranteed cleanup | No guaranteed flush | Default handler calls `abort`; a replacement controls its action |
| Uncaught exception | Implementation-defined whether the stack unwinds before termination | No guaranteed cleanup | No guaranteed flush | Depends on the terminate handler and platform |

### `std::terminate`

Called in cases including: no handler is found for an exception; an exception exits a `noexcept` function; a destructor invoked during unwinding exits via another exception; a joinable `std::thread` is destroyed; an initial thread function exits via an exception; or destruction of a static or thread-local object exits via an exception. Passing a null `exception_ptr` to `std::rethrow_exception` violates its precondition; do not rely on termination as its specified result.

```cpp
std::set_terminate([]{
    if (auto ep = std::current_exception()) {
        try { std::rethrow_exception(ep); }
        catch (const std::exception& e) { fprintf(stderr, "fatal: %s\n", e.what()); }
        catch (...) { fprintf(stderr, "fatal: unknown exception\n"); }
    }
    std::abort();   // requests abnormal termination; core policy is platform-specific
});
```

The handler must not return; returning causes `abort`.

`~thread()` on a still-joinable thread calls `std::terminate` rather than implicitly joining or detaching, since neither is safe as a silent default. `std::jthread` (C++20) joins in its destructor and additionally carries a `stop_token`.

For an unrecoverable inconsistency in a trading system, failing closed is safer than continuing with corrupted risk state (Ch. 56 §56.9). What counts as unrecoverable must be defined narrowly, diagnostics depend on deployed core policy, and the kill-switch/mass-cancel path must be exercised independently of process termination.

### Deep dive: crash handlers and cores

On POSIX systems, `abort()` raises `SIGABRT`; whether a core is produced depends on signal disposition and system configuration such as resource limits and core policy. This is operating-system behavior, not a C++ guarantee.

A POSIX signal handler may call only async-signal-safe functions. `malloc`, `printf`, C++ library facilities, and typical symbolic backtrace functions do not qualify. The robust minimal pattern is to record preallocated diagnostic data with a signal-safe write, restore or use the default disposition, and re-raise so normal core handling can occur. Even `backtrace()` is not specified as async-signal-safe.

`std::stacktrace` is a C++23 library facility, subject to implementation availability. It is not an async-signal-safe crash-handler primitive, and symbolization/allocation behavior is implementation-specific; use it only in ordinary program context after verifying toolchain support.

---

## 10.13 Scope Guards — Core

A scope guard runs a cleanup action when control leaves a scope by any path: normal exit, early `return`, `break`, or exception. It generalizes RAII to an arbitrary action where a dedicated class is not worth writing.

```cpp
int fd = ::open(path, O_RDONLY);
if (fd < 0) return std::unexpected(err());
ScopeExit close_fd{[&]() noexcept { ::close(fd); }};
// any number of early returns or throws below; fd is always closed
```

Three flavors are commonly distinguished:

| Guard | Fires when |
|---|---|
| `scope_exit` | Always, on scope exit |
| `scope_fail` | Only if leaving via an exception |
| `scope_success` | Only if leaving normally |

`dismiss()`/`release()` is what turns a guard into a commit-rollback tool — the strong-guarantee pattern of §10.6 when copy-and-swap is too expensive:

```cpp
auto [it, inserted] = registry.insert({key, value}); // may throw; no insertion on failure
if (!inserted) return duplicate_key;
ScopeExit rollback{[&]() noexcept { registry.erase(it); }};
index.add(key);        // contract: no effect if it throws
rollback.dismiss();    // both structures now contain key
```

The destructor must not emit an exception. Require a non-throwing cleanup callback or catch failures according to a documented policy; logging itself is not automatically safe or non-throwing. Capture by reference is appropriate only while every referent outlives the guard.

A `unique_ptr` with a custom deleter (Ch. 9) is the other common "run this at the end" idiom. Use it when a resource *value* needs to be carried around or returned; use a scope guard for a local action that has no value to hold.

### Deep dive: implementation and standardization

```cpp
#include <type_traits>
#include <utility>

template <class F>
requires std::is_nothrow_move_constructible_v<F> &&
         std::is_nothrow_invocable_v<F&>
class ScopeExit {
    F f_; bool active_ = true;
public:
    explicit ScopeExit(F f) noexcept : f_(std::move(f)) {}
    ~ScopeExit() noexcept { if (active_) f_(); }
    void dismiss() noexcept { active_ = false; }
    ScopeExit(ScopeExit&& o) noexcept
        : f_(std::move(o.f_)), active_(std::exchange(o.active_, false)) {}
    ScopeExit(const ScopeExit&) = delete;
};
```

`scope_fail`/`scope_success` record `std::uncaught_exceptions()` (C++17, plural) at construction and compare it at destruction. The essential test is:

```cpp
const bool a_new_exception_is_unwinding =
    std::uncaught_exceptions() > count_at_construction;
```

The plural form replaced the older singular `uncaught_exception()` (removed in C++20) because a single boolean cannot distinguish "an exception is already in flight" from "a new exception started during this destructor's own scope."

There is no standard `std::scope_exit` in C++23. Projects commonly use a small reviewed implementation or a library facility such as `folly::makeGuard`, `absl::Cleanup`, or `gsl::finally`; their interfaces and exception policies differ.

An optimizer can inline the lambda and eliminate a guard's object or active flag when control flow makes them redundant. That is not a language guarantee; inspect code generation if guard overhead matters on a specific path.

---

## HFT application: an order-reject path — Core
A gateway parses inbound venue messages, validates them against risk limits, and forwards accepted orders. Two failure classes exist on this path: malformed messages (routine, must be counted and logged, must not stop processing later messages) and a corrupted internal risk-state invariant (should never happen, and if it does, safety requires stopping rather than continuing).

```cpp
enum class RejectReason { BadFraming, UnknownSymbol, RiskLimitExceeded };

std::expected<Order, RejectReason> validate(std::span<const std::byte> msg,
                                             const RiskState& risk) noexcept {
    auto parsed = parse_order(msg);               // also specified noexcept
    if (!parsed) return parsed;                    // propagate the enum error
    if (!risk.symbol_known(parsed->symbol))
        return std::unexpected(RejectReason::UnknownSymbol);
    if (!risk.within_limits(*parsed))
        return std::unexpected(RejectReason::RiskLimitExceeded);
    return parsed;
}
```

`validate` may be `noexcept` only after `parse_order`, both `RiskState` queries, and the relevant `Order`/`expected` moves are verified non-throwing. Its routine failure side carries a small enum and performs no error-message allocation. Whether the full return object uses registers depends on `Order` and the target ABI. The internal-invariant case is not modeled as a `RejectReason`: there is no caller-local recovery using state no longer trusted. A production system must connect that fail-closed decision to an independently tested stop-accepting/cancel procedure before process termination.

---

## Recall card — Core
- RVO for a prvalue return is guaranteed since C++17; NRVO for a named local is only ever permitted.
- `return std::move(local);` disables NRVO and forces an unnecessary move; write `return local;`.
- A move is overload resolution on `T&&`; a missing move constructor, a `const` source, or a named `T&&` parameter used without `std::move` can select a viable copy instead.
- Make move construction/assignment `noexcept` only when true; container transfer can prefer copying when move construction may throw and copying is available.
- Common table-based ABIs search and then clean up; the language guarantees destruction on the path to a found handler, not that ABI or pre-termination unwinding.
- Exception-safety guarantees, weakest to strongest: none, basic, strong commit-or-rollback, and no-throw. RAII prevents leaks but mutation order preserves cross-object invariants.
- `optional<T>` for reasonless absence; `*empty` is undefined behavior, not a throw. `expected<T,E>` for a routine failure the caller must act on; keep `E` small.
- `std::terminate` fires on a `noexcept` violation, an uncaught exception, a throw during unwinding, and a joinable `~thread`.

## Questions — Core
1. What distinguishes RVO from NRVO, and which one does the standard guarantee?
2. Name three distinct reasons a `std::move(x)` expression can still result in a copy at the call site.
3. Why is a `move_if_noexcept`-style choice useful during `vector` reallocation?
4. What may you do with a moved-from `std::vector`, and name two library types with stronger moved-from postconditions.
5. Separate the C++ guarantees during handler transfer from the two-phase mechanism used by an Itanium-ABI implementation.
6. Give an example of a standard-library operation that offers only the basic guarantee, and explain why the strong guarantee is not free for it.
7. A function needs to report "row not found" versus "row found but the connection dropped mid-read." Which of `optional`, `expected`, or an exception fits each case, and why?
8. Why can a constructor not use `std::expected` or an error code the way a free function can?
9. Why can portable C++ not answer what `vector::at` does in a vendor's `-fno-exceptions` mode, and what must you verify before enabling that mode?
10. What is the difference between `throw;` and `throw e;` inside a `catch` block?

## Code-reading puzzle — Core
```cpp
struct Node {
    std::string label;
    explicit Node(std::string l) : label(std::move(l)) {}
    ~Node() { audit_log(label); }
};

std::vector<Node> build(std::vector<std::string> names) {
    std::vector<Node> out;
    out.reserve(names.size());
    for (auto& n : names) out.push_back(Node{std::move(n)});
    return out;
}
```

`build` compiles and runs correctly, but a profiler shows every `Node` is copy-constructed, not move-constructed, even though the loop calls `push_back` with a prvalue and `label` is moved out of `n` before it. `Node` declares only a destructor — no copy or move member appears anywhere in the class. What does that destructor suppress, what does it leave alone, and which overload does `push_back` actually call? (Hint: a user-declared destructor suppresses implicit generation of one pair of special members and leaves the other pair intact, merely deprecated. Decide which pair is which before deciding what "moved" even means for `Node` here.)

## Implementation exercise — Core
Two parts.

**API rewrite.** Given this throwing interface:

```cpp
struct ConfigError : std::runtime_error { using std::runtime_error::runtime_error; };

Config load_config(const std::filesystem::path& p);   // throws ConfigError, std::filesystem::filesystem_error
```

Rewrite it to return `std::expected<Config, ConfigError>` (keep `ConfigError` as the error type, or replace it with a small enum if you can justify the trade). Update any two call sites you can imagine — one that must abort startup on failure, one that can substitute a default — and show how each looks with `expected` versus how it looked with exceptions. State which axis from §10.11 drove your choice.

**Exception safety.** This function is meant to provide the strong guarantee but does not:

```cpp
void OrderBook::replace(OrderId id, Order new_order) {
    levels_[new_order.price].push_back(new_order);   // may throw (allocation)
    index_.erase(id);                                 // does not throw
    index_[new_order.id] = &levels_[new_order.price].back();
}
```

Identify the ordering defect, then rewrite `replace` so that if any fallible step throws, `OrderBook` is left exactly as it was before the call. State which guarantee level the fixed version achieves and why it cannot cheaply be strengthened further (or show that it can).

## Prerequisites for Chapter 11 — Core
Chapter 11 assumes you can already: predict whether a container operation invalidates iterators/references/pointers (built on the move/copy vocabulary here), reason about the cost of a reallocation in terms of moves versus copies (§10.2–§10.3), and read a `noexcept` specification to know which algorithm a container will run. If any of those feel shaky, revisit §10.2 and §10.3 before continuing.
