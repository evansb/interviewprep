# Chapter 8 — Allocator-Aware C++

An allocator-aware design separates two decisions: what objects a container owns, and where the storage for those objects comes from. Classic allocators encode the storage policy in the container's type. C++17 polymorphic memory resources make the policy a runtime value instead. Both designs are useful, but neither changes object lifetime rules: storage must remain valid, construction and destruction must still be paired, and memory must be returned through a compatible allocator.

This chapter uses C++23. It covers standard guarantees first; library implementation choices and measured costs are labeled separately. Chapter 7 owns raw allocation mechanisms and allocator implementation internals. This chapter concentrates on the standard allocator protocol, containers, propagation, nested allocation, and resource selection.

**Prerequisites:** Chapter 5 for object lifetime and destruction order, and Chapter 7 for alignment, arenas, pools, fragmentation, and allocation failure.

---

## Why this matters — Core

Allocation policy affects correctness before it affects speed. A container retains an allocator or resource handle and may use it during every capacity change and during destruction. If that resource has already died, the program has undefined behavior. If two containers use unequal, non-propagating allocators, a move assignment may allocate and move every element; swapping them may itself be undefined behavior.

The low-latency consequence follows from those rules. An apparently ordinary `push_back`, copy, move, or string construction can reach a general-purpose heap, contend, fault in pages, or fail. Allocator-aware code makes that path explicit. It can route a phase's allocations to a bounded arena, recycle node storage in a pool, reject an unexpected fallback, and count calls in a test. The goal is not to declare one allocator universally fastest. It is to choose a lifetime and exhaustion policy, then verify the allocation behavior under the intended workload.

---

## 90-second screen — Core

Five facts:

1. Allocation obtains suitably sized and aligned storage; construction begins object lifetime in that storage. Containers keep those operations separate because they often own capacity containing both live objects and unoccupied slots.
2. A classic allocator is part of a container's type. `std::pmr::polymorphic_allocator<T>` instead stores a `std::pmr::memory_resource*`, so the concrete resource can change without changing the container type.
3. Allocator equality means that memory allocated through either allocator can be deallocated through the other. Propagation traits decide whether an allocator is replaced during copy assignment, move assignment, or swap.
4. With unequal, non-propagating allocators, move assignment must move elements into destination-owned storage and may allocate. Swapping such containers has undefined behavior.
5. PMR construction is uses-allocator aware: an all-PMR composition such as `std::pmr::vector<std::pmr::string>` passes the outer resource into nested elements. Classic nested allocators need explicit forwarding, commonly through `std::scoped_allocator_adaptor`.

Two decisions:

- Choose a monotonic resource for phase-structured lifetimes: allocate a group, use it, destroy all objects, then release the whole region. Choose a pool when individual allocations of recurring sizes must be returned and reused independently.
- Choose PMR when runtime resource selection and stable public types matter. Choose a classic allocator when compile-time policy, static dispatch, or integration with an existing allocator-parameterized type matters. Confirm a performance choice by measuring calls, bytes, locality, and tail latency.

---

## 8.1 Why containers separate allocation from construction — Core

Consider a vector with capacity eight and size three:

```text
vector object
  ├── allocator/resource handle
  ├── begin ─────────────┐
  ├── size = 3           │
  └── capacity = 8       │
                         ▼
backing storage:  [ T ][ T ][ T ][ raw ][ raw ][ raw ][ raw ][ raw ]
                    live objects       suitably aligned storage only
```

The vector owns one allocation large enough for eight `T` objects, but only three object lifetimes have begun. `reserve(8)` allocates storage; it does not default-construct eight elements. `emplace_back` constructs one object in the next slot. `pop_back` destroys one object but normally retains the allocation. The distinction allows capacity reuse and supports types that are not default-constructible.

This is the same storage-versus-lifetime distinction introduced in Chapters 5 and 7, expressed through a container:

| Operation | Storage effect | Object-lifetime effect | Typical consequence |
|---|---|---|---|
| `reserve(n)` | May replace the allocation | May move/copy existing elements into new storage | Invalidation and possible allocation |
| `emplace_back(args...)` within capacity | None | Constructs one `T` | No container-storage allocation |
| `pop_back()` | Retains capacity | Destroys one `T` | Element destructor may still allocate or synchronize |
| `clear()` | Retains capacity | Destroys all elements | Size becomes zero; resource bytes remain owned |
| container destruction | Deallocates backing storage | Destroys live elements first | Allocator/resource must still be alive |

The standard allocator interface mirrors this split. An allocator supplies raw storage through `allocate` and accepts it back through `deallocate`. `std::allocator_traits` supplies the generic construction and destruction interface. Since C++20, the default traits implementation constructs with `std::construct_at` and destroys with `std::destroy_at` when the allocator does not customize those operations.

```cpp
#include <memory>

struct Quote {
    int price;
    int quantity;
};

int main() {
    std::allocator<Quote> alloc;
    using traits = std::allocator_traits<decltype(alloc)>;

    Quote* p = traits::allocate(alloc, 2);   // storage for two Quotes
    traits::construct(alloc, p, Quote{101, 7});
    traits::construct(alloc, p + 1, Quote{102, 3});

    traits::destroy(alloc, p + 1);
    traits::destroy(alloc, p);
    traits::deallocate(alloc, p, 2);
}
```

The example is deliberately manual. Production code should normally let a container or ownership type pair these operations. It nevertheless exposes the governing invariants:

- The returned storage must satisfy `Quote`'s size and alignment requirements.
- Only `p` and `p + 1` designate live `Quote` objects after the two constructions.
- Destruction must finish before deallocation.
- The pointer and allocation count must be returned through an allocator compatible with the one that produced them.

An allocator controls storage, not arbitrary element behavior. Reserving a vector's capacity cannot prevent a `T` constructor from allocating internally. A `std::vector<std::string>` may make no further vector allocations and still allocate character buffers. Nested allocator propagation in §8.4 addresses that second level.

### Allocator-aware containers

Standard containers other than `std::array` are allocator-aware where their declarations include an allocator parameter. In C++23 there is no standard fixed-capacity vector; a fixed-capacity alternative is a project-specific type or a different representation such as `std::array` plus an explicit size.

An allocator-aware container exposes `allocator_type` and `get_allocator()`. The returned allocator is a copy, not a mutable reference into the container. The container uses its allocator for its own element or node storage. It does not imply that every operation is allocation-free, nor that allocators used by member objects automatically match.

Classic allocation policy appears in the type:

```cpp
std::vector<int> ordinary;  // std::vector<int, std::allocator<int>>
```

If `ArenaAllocator<int>` is a different allocator type, then
`std::vector<int, ArenaAllocator<int>>` is a different vector type. That enables static dispatch and inlining, but can spread allocator template parameters through interfaces. PMR moves the variable part behind a runtime resource interface.

---

## 8.2 Runtime selection with `memory_resource` and `polymorphic_allocator` — Core

`std::pmr::memory_resource` is the type-erased interface for raw byte allocation. Its public non-virtual functions call three protected virtual customization points:

```cpp
// Schematic interface; this is not a replacement declaration.
class memory_resource {
public:
    void* allocate(std::size_t bytes,
                   std::size_t alignment = alignof(std::max_align_t));
    void deallocate(void* p, std::size_t bytes,
                    std::size_t alignment = alignof(std::max_align_t));
    bool is_equal(const memory_resource& other) const noexcept;

protected:
    virtual void* do_allocate(std::size_t, std::size_t) = 0;
    virtual void do_deallocate(void*, std::size_t, std::size_t) = 0;
    virtual bool do_is_equal(const memory_resource&) const noexcept = 0;
};
```

`std::pmr::polymorphic_allocator<T>` stores a pointer to one such resource. Its `allocate(n)` converts an element count to a byte request and delegates to the resource. PMR aliases bind standard containers to this allocator:

```cpp
namespace std::pmr {
    template<class T>
    using vector = std::vector<T, polymorphic_allocator<T>>;
    // Similar aliases exist for string and the standard dynamic containers.
}
```

Consequently, both objects below have exactly the same type:

```cpp
#include <array>
#include <cstddef>
#include <memory_resource>
#include <vector>

int main() {
    std::array<std::byte, 4096> bytes{};
    std::pmr::monotonic_buffer_resource arena{bytes.data(), bytes.size()};

    std::pmr::vector<int> from_heap;       // current default resource
    std::pmr::vector<int> from_arena{&arena};

    from_heap.push_back(1);
    from_arena.push_back(2);
}
```

The container object stores an allocator, the allocator stores a non-owning resource pointer, and the resource controls backing storage:

```text
pmr::vector<int>              monotonic_buffer_resource
┌─────────────────┐          ┌──────────────────────────┐
│ begin/size/cap  │          │ cursor, buffer, upstream │
│ allocator ────────────────►│ virtual allocate/free    │
└────────┬────────┘          └────────────┬─────────────┘
         │ elements                      │ upstream on exhaustion
         ▼                               ▼
  [ int int raw ... ]             another memory_resource
```

Neither arrow owns its target. The vector does not own the resource, and a resource generally does not own an upstream resource passed by pointer. Lifetime must therefore be arranged from the outside.

### Standard resources

| Facility | Standard behavior | Use |
|---|---|---|
| `new_delete_resource()` | Uses global allocation functions to allocate and deallocate | Ordinary fallback or baseline |
| `null_memory_resource()` | Every nonzero allocation request fails by throwing `std::bad_alloc`; deallocation has no effect | Detect or forbid upstream fallback |
| `get_default_resource()` | Returns the current process-wide default resource pointer | Default PMR construction |
| `set_default_resource(p)` | Atomically replaces the default; a null argument selects `new_delete_resource()` | Startup configuration, used cautiously |

Calls to `set_default_resource` and `get_default_resource` are required not to introduce a data race; exchanging the pointer is thread-safe. This does not make a mid-run policy change easy to reason about. Existing allocators retain the resource pointer captured when they were constructed, while later default-constructed allocators see the new pointer. A process can then contain visually identical objects backed by different resources. Prefer explicit resource injection. If a global default is changed, do it during single-threaded initialization before relevant objects are built.

### The PMR cost model

The standard promises semantics, not a specific object size or instruction sequence. A common implementation gives `polymorphic_allocator` one resource pointer and dispatches each allocation/deallocation through a virtual call. That suggests three costs to measure:

- one stored pointer in each allocator-bearing container object;
- an indirect call at an allocation boundary;
- less opportunity to inline the concrete allocation algorithm through that boundary.

For a bump-pointer resource, the indirect dispatch can be a meaningful fraction of an otherwise tiny operation. For a rare upstream heap allocation, page fault, or contended allocator path, it may be negligible. The dispatch occurs per allocation call, not per element access. Preallocation can therefore make the distinction irrelevant during steady state.

PMR buys runtime substitution and a stable container type. It does not promise lower latency. The resource behind it determines fragmentation, synchronization, locality, and exhaustion behavior.

Runtime selection is especially useful at subsystem boundaries. The same parsing function can receive a caller-owned scratch arena in production, a counting resource in a regression test, and `new_delete_resource()` in a utility program without changing its PMR container types. That flexibility also creates a review obligation: a bare default-constructed PMR container does not reveal its resource at the type level. Prefer passing a resource explicitly through a context or constructor when policy affects capacity, lifetime, or failure handling.

---

## 8.3 Propagation, equality, move, and swap — Core

The allocator model must answer a safety question: if storage was obtained through allocator `a`, may allocator `b` deallocate it? Allocator equality encodes exactly that compatibility. Equality is not a claim that two allocators have equal state, equal performance, or the same current free space.

For `memory_resource`, `a.is_equal(b)` is true when `&a == &b` or the virtual equality operation says the resources are interchangeable. The safest custom resource equality is often identity. Returning true for two distinct resources is valid only if each can deallocate storage allocated by the other with the supplied byte count and alignment.

### The propagation controls

`std::allocator_traits<A>` exposes four relevant choices:

| Operation | Traits mechanism | If propagation is false |
|---|---|---|
| Copy construction `C dst(src)` | `select_on_container_copy_construction(src_alloc)` | Not a boolean trait; returned allocator is used |
| Copy assignment `dst = src` | `propagate_on_container_copy_assignment` (POCCA) | Destination keeps its allocator |
| Move assignment `dst = std::move(src)` | `propagate_on_container_move_assignment` (POCMA) | Destination keeps its allocator |
| `swap(dst, src)` | `propagate_on_container_swap` (POCS) | Allocators remain attached to their containers |

`is_always_equal` lets an allocator state that every instance is interchangeable. For a truly stateless allocator this permits containers to avoid runtime equality checks and can strengthen exception specifications. It must not be declared true merely to obtain a faster move.

PMR's `polymorphic_allocator` does not propagate on copy assignment, move assignment, or swap. Its `select_on_container_copy_construction()` returns a default-constructed `polymorphic_allocator`, which captures the current default resource. The ordinary allocator copy constructor does copy the resource pointer; it is the selection function used by allocator-aware container copy construction that deliberately chooses the default.

### Derive each case from deallocation safety

**Copy construction.** A new container has no existing storage policy to preserve. It uses `allocator_traits<A>::select_on_container_copy_construction` on the source allocator unless an explicit allocator is supplied. Therefore this PMR copy normally uses the current default, not `arena`:

```cpp
std::pmr::vector<int> source{&arena};
source.push_back(7);

std::pmr::vector<int> a{source};          // selected default resource
std::pmr::vector<int> b{source, &arena};  // explicit target resource
```

Use the allocator-extended constructor when the destination region matters. This also makes the copy and its potential allocation visible at the call site.

**Move construction without an allocator argument.** The newly constructed destination obtains the source allocator and can usually take over the source representation. For standard containers this is constant time. The source remains valid but its exact state is otherwise governed by the container's moved-from guarantees.

**Move construction with an explicit allocator.** This is a different overload. If the supplied allocator is unequal to the source allocator, the destination cannot safely take ownership of source storage. It must allocate through the supplied allocator and move elements. Do not generalize “move construction is constant time” to this overload.

**Copy assignment.** If POCCA is false, the destination retains its allocator and copies elements into storage owned by that allocator. Existing capacity can sometimes be reused. If POCCA is true and the allocator changes, the container must dispose of old storage through its old allocator before adopting the new policy.

**Move assignment.** With POCMA true, the allocator may move with the representation. With POCMA false, allocator equality decides whether the destination can steal the source's storage:

```text
POCMA true
    └─ allocator propagates; representation can transfer

POCMA false
    ├─ allocators equal
    │    └─ destination can later deallocate source storage; transfer is possible
    └─ allocators unequal
         └─ stealing would violate deallocation safety
              → allocate/reuse destination storage and move elements
```

The unequal branch is linear in the number of elements and may allocate. Element moves can also throw. For a PMR vector, a resource mismatch makes this branch reachable, so code must not assume move assignment is unconditionally `noexcept`.

**Swap.** If POCS is true, allocator state swaps with the contents. If POCS is false, the allocators stay where they are. The standard container requirements make swapping containers with unequal allocators undefined behavior in this case. An implementation is not required to fall back to an element-wise swap or diagnose the error.

### A propagation prediction

Suppose `left` uses resource L and `right` uses resource R, and L and R compare unequal:

```cpp
left = std::move(right);
```

For PMR, POCMA is false. `left` must keep L. If it stole R's buffer, `left` would later send that pointer to L, violating allocator compatibility. Therefore it must allocate or reuse storage through L and move the elements. The time and failure behavior are determined by element count, existing capacity, element move behavior, and L's allocation path—not by the spelling `std::move`.

Now consider:

```cpp
left.swap(right);
```

PMR's POCS is false, so L and R would remain with their original vector objects while the buffers exchanged places. Each vector would then own a buffer its allocator cannot necessarily deallocate. The precondition that allocators compare equal prevents this state. Violating it is undefined behavior.

### Operational rule

Treat a resource as part of a value's region identity. Move and swap freely inside one region. At a region boundary, construct or copy explicitly into the destination resource. This rule makes both cost and lifetime reviewable.

---

## 8.4 Nested allocation and uses-allocator construction — Core

An outer container's allocator always governs its own storage. It governs element-owned dynamic storage only if construction passes an allocator into the element and the element uses that allocator.

### All-PMR nesting propagates

`std::pmr::polymorphic_allocator::construct` performs uses-allocator construction. As a result, the string below receives the vector's resource:

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <memory_resource>
#include <string>
#include <vector>

int main() {
    std::array<std::byte, 4096> bytes{};
    std::pmr::monotonic_buffer_resource arena{
        bytes.data(), bytes.size(), std::pmr::null_memory_resource()
    };

    std::pmr::vector<std::pmr::string> symbols{&arena};
    symbols.emplace_back("A symbol name deliberately longer than typical SSO");

    assert(symbols.get_allocator().resource() == &arena);
    assert(symbols.front().get_allocator().resource() == &arena);
}
```

The long string avoids relying on a particular small-string-optimization capacity when observing actual allocation, but allocator identity is meaningful even when the string currently holds its characters inline.

The construction decision is conceptually:

```text
if T does not use allocator A
    construct T(args...)
else if T can be constructed as T(allocator_arg, A, args...)
    use leading-allocator form
else if T can be constructed as T(args..., A)
    use trailing-allocator form
else
    the construction is ill-formed
```

The actual standard utilities handle important details such as `pair` construction. C++20 exposes them as `std::uses_allocator_construction_args` and `std::make_obj_using_allocator`.

PMR aliases use compatible allocator-aware constructors, so propagation continues recursively through all-PMR structures such as:

```cpp
std::pmr::vector<std::pmr::vector<std::pmr::string>>
```

This does not mean every nested standard type is allocator-aware. A `std::string` is a different type from `std::pmr::string`; placing ordinary `std::string` objects in a PMR vector does not rewrite their allocator type.

### Custom allocator-aware elements

A user-defined type can participate by declaring `allocator_type` and providing the constructor forms its uses require:

```cpp
#include <memory_resource>
#include <string>
#include <utility>
#include <vector>

struct Order {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;

    std::pmr::string symbol;
    std::pmr::vector<int> leg_quantities;

    explicit Order(allocator_type a = {})
        : symbol{a}, leg_quantities{a} {}

    Order(const Order& other, allocator_type a)
        : symbol{other.symbol, a},
          leg_quantities{other.leg_quantities, a} {}

    Order(Order&& other, allocator_type a)
        : symbol{std::move(other.symbol), a},
          leg_quantities{std::move(other.leg_quantities), a} {}
};
```

The allocator-extended copy and move constructors matter when a containing allocator-aware object must recreate `Order` in another region. Declaring `allocator_type` without providing a compatible constructor does not silently ignore the allocator; uses-allocator construction becomes ill-formed for the attempted argument list.

There is a design trade-off. Making every aggregate allocator-aware adds constructors and region semantics. A flatter representation—one byte buffer plus offsets, or one vector of records plus an interned string table—can use fewer allocations and have clearer ownership. Nested PMR is a mechanism, not a requirement to build deeply nested object graphs.

### Why classic nested allocators need help

A conventional allocator's default `allocator_traits::construct` constructs the element from the arguments provided by the container. It does not automatically append the outer allocator. Therefore an outer classic allocator does not, by itself, become an inner container's allocator.

`std::scoped_allocator_adaptor` adds allocator-aware construction across nesting levels. Its outer allocator obtains storage for the outer container. Its inner allocator is supplied when elements are constructed.

The following compact example uses tagged allocators to make the policy observable:

```cpp
#include <cassert>
#include <cstddef>
#include <memory>
#include <scoped_allocator>
#include <vector>

template<class T>
struct TaggedAllocator {
    using value_type = T;
    int tag = 0;

    TaggedAllocator() = default;
    explicit TaggedAllocator(int value) : tag{value} {}

    template<class U>
    TaggedAllocator(const TaggedAllocator<U>& other) : tag{other.tag} {}

    T* allocate(std::size_t n) {
        return std::allocator<T>{}.allocate(n);
    }

    void deallocate(T* p, std::size_t n) noexcept {
        std::allocator<T>{}.deallocate(p, n);
    }

    template<class U>
    bool operator==(const TaggedAllocator<U>& other) const noexcept {
        return tag == other.tag;
    }
};

int main() {
    using Inner = std::vector<int, TaggedAllocator<int>>;
    using OuterAlloc = TaggedAllocator<Inner>;
    using InnerAlloc = TaggedAllocator<int>;
    using Scoped = std::scoped_allocator_adaptor<OuterAlloc, InnerAlloc>;

    std::vector<Inner, Scoped> rows{
        Scoped{OuterAlloc{7}, InnerAlloc{7}}
    };
    rows.emplace_back();

    assert(rows.get_allocator().outer_allocator().tag == 7);
    assert(rows.front().get_allocator().tag == 7);
}
```

Without the adaptor, `rows.emplace_back()` would default-construct the inner vector and its tag would be zero. In an all-PMR composition, adding `scoped_allocator_adaptor` is redundant because `polymorphic_allocator` already performs uses-allocator construction.

---

## 8.5 Monotonic and pool resources — Core

The standard supplies resources with two different lifetime models. Chapter 7 explains their underlying bump-pointer and free-list mechanisms; here the question is which policy matches the object graph.

| Resource | Individual deallocation | Thread safety | Memory returned upstream | Best workload shape |
|---|---|---|---|---|
| `monotonic_buffer_resource` | `deallocate` has no effect | No | On `release()` or destruction | Whole phase dies together |
| `unsynchronized_pool_resource` | Recycles blocks | No | On `release()` or destruction | Recurring sizes, independent frees, one-thread ownership |
| `synchronized_pool_resource` | Recycles blocks | Yes | On `release()` or destruction | Shared use where synchronization cost is acceptable |

### Monotonic resources

A monotonic resource serves requests from an initial buffer and then, if permitted, obtains larger buffers from an upstream resource. Individual deallocation does nothing. `release()` returns all memory obtained from the upstream and resets the resource for reuse. Destruction has the same bulk-release effect.

```cpp
#include <array>
#include <cstddef>
#include <memory_resource>

int main() {
    alignas(std::max_align_t) std::array<std::byte, 64 * 1024> storage{};
    std::pmr::monotonic_buffer_resource arena{
        storage.data(), storage.size(), std::pmr::null_memory_resource()
    };
}
```

Using `null_memory_resource()` as upstream gives the region a fixed byte budget. Exhaustion throws `std::bad_alloc`; it does not return null. Whether the application catches that exception, rejects an input, or terminates is a separate boundary decision. A latency-sensitive design must make the policy explicit rather than accidentally falling back to the heap.

`clear()` and `release()` are not interchangeable:

- `container.clear()` destroys the container's elements and retains the container allocation.
- `arena.release()` invalidates all storage allocated from the arena and does not run destructors.

Calling `release()` while any object, pointer, iterator, or view may still use arena storage creates dangling access. Calling it before a container using the resource is destroyed is also wrong even if that resource currently ignores deallocation; the container's destructor still calls through its stored resource pointer.

This scope is safe:

```cpp
for (int event = 0; event != 1000; ++event) {
    {
        std::pmr::vector<int> scratch{&arena};
        scratch.reserve(128);
        // Parse and process one event.
    }                 // scratch and its elements are destroyed first
    arena.release();  // no arena-backed object remains alive
}
```

This apparently similar arrangement is unsafe:

```cpp
std::pmr::vector<int> scratch{&arena};
scratch.push_back(1);
arena.release();      // scratch still refers to invalidated storage
// Even scratch's later destruction calls a resource after its allocation vanished.
```

The important monotonic-resource cost is high-water memory, not only allocation instruction count. Within a phase, erased or destroyed objects do not make their bytes reusable. A loop that repeatedly grows temporary containers without a phase-level release can consume new chunks indefinitely. Conversely, a container kept alive across phases cannot safely retain capacity across `release()`.

### Pool resources

Pool resources group small requests into implementation-selected pools, normally by block size and alignment. Returned blocks can be reused by later matching requests. Requests too large for a pool are handled separately through the upstream resource.

`std::pmr::pool_options` provides two tuning hints:

```cpp
std::pmr::pool_options options;
options.max_blocks_per_chunk = 256;
options.largest_required_pool_block = 512;

std::pmr::unsynchronized_pool_resource pool{
    options, std::pmr::new_delete_resource()
};
```

The standard does not specify size classes, chunk growth, cache behavior, or the exact meaning an implementation gives to an accepted hint. Benchmark the actual library version. The durable model is:

- an allocation performs runtime resource dispatch, selects a pool or oversized path, and obtains a block;
- deallocation returns an eligible block to the resource for reuse;
- retained chunks make memory usage follow a high-water mark until `release()` or destruction;
- the synchronized resource must coordinate concurrent access; the unsynchronized resource requires external exclusion and is often used with thread ownership.

A pool fits node-based containers with interleaved insertion and erasure:

```cpp
#include <map>
#include <memory_resource>

struct OrderState {
    int quantity;
};

int main() {
    std::pmr::unsynchronized_pool_resource pool;
    std::pmr::map<int, OrderState> orders{&pool};

    orders.emplace(42, OrderState{100});
    orders.erase(42);   // node storage can be recycled by the pool
}
```

Do not infer that a standard pool beats every general allocator. A tuned general allocator may already have thread caches and size classes. A single-type custom pool can avoid type erasure and size-class selection but gives up generality and requires much more correctness work. Measure p50 and tail latency, upstream calls, resident memory, and cross-thread behavior on the target deployment.

### Resource composition

Resources can be layered:

```text
pmr::list<Node>
       │
       ▼
unsynchronized_pool_resource  — recycles individual node blocks
       │ upstream chunk requests
       ▼
monotonic_buffer_resource     — obtains bytes from a bounded initial buffer
       │ exhaustion
       ▼
null_memory_resource          — throws; no heap fallback
```

The composition creates two reset boundaries. Pool `release()` discards its pools and returns chunks to the arena, whose deallocation is a no-op. Arena `release()` then resets the actual bounded storage. All pool-allocated objects must be destroyed before the pool is released, and the pool must stop using its upstream before the arena is released.

Often one resource is enough. Layering a pool over a monotonic resource is appropriate only when block reuse inside a phase matters. It adds metadata, policy interactions, and another dispatch boundary.

---

## 8.6 Choosing resource lifetime and ownership — Core

A PMR container owns its elements, but it does not own its `memory_resource`. The resource must outlive every allocator, container, and allocated object that can call it or refer to its storage. The upstream must in turn outlive the downstream resource.

Declaration order makes the common stack-scoped case clear because local objects are destroyed in reverse order:

```text
construction                                  destruction

1. backing buffer  ─────────────────────────► 4. backing buffer
2. arena           ─────────────────────────► 3. arena
3. container       ─────────────────────────► 2. container
4. elements        ─────────────────────────► 1. elements

Required lifetime nesting:
[ backing buffer [ arena [ container [ elements ] ] ] ]
```

The buffer must be declared before the arena, and the arena before its containers:

```cpp
std::array<std::byte, 4096> buffer{};
std::pmr::monotonic_buffer_resource arena{buffer.data(), buffer.size()};
std::pmr::vector<int> values{&arena};
```

The raw pointer interface permits unsafe designs, so ownership should be explicit at a higher level. Useful patterns include:

- A request context owns the backing buffer and resource; request-local containers borrow that resource and cannot escape the context.
- A thread context owns an unsynchronized pool; objects are created, used, and destroyed on that thread.
- A long-lived service object owns a resource as a member declared before allocator-aware members, so member destruction occurs in the safe reverse order.
- An API takes `std::pmr::memory_resource*` to express non-owning policy injection. The caller remains responsible for lifetime.

Avoid returning a PMR container backed by a local resource:

```cpp
// Incorrect: returned vector stores a pointer to a destroyed resource and
// refers to storage whose lifetime ended when the function returned.
std::pmr::vector<int> bad_result() {
    std::pmr::monotonic_buffer_resource local;
    std::pmr::vector<int> out{&local};
    out.push_back(1);
    return out;
}
```

Returning by value does not repair the resource lifetime. NRVO, when performed, can construct the result vector directly, but it does not extend `local`'s lifetime. Move construction would carry the same resource pointer.

### Decision procedure

```text
Do all allocated objects die at one explicit phase boundary?
  ├─ yes → monotonic resource
  │        ├─ bounded memory required? use fixed buffer + null upstream
  │        └─ growth acceptable? choose and monitor an upstream
  └─ no
       ├─ recurring small sizes with independent frees?
       │    ├─ one owner thread → unsynchronized pool
       │    └─ shared concurrently → synchronized pool or redesign ownership
       └─ general/irregular lifetime → measured general allocator or custom policy
```

For every choice, state:

1. who owns the resource and upstream;
2. which objects may retain its storage;
3. whether concurrent calls are permitted;
4. what happens at exhaustion;
5. when bulk release is legal;
6. which observation will verify the expected benefit.

Those are correctness properties. “Arena allocation is fast” is not a design specification.

---

## 8.7 Proving allocation behavior — Core

An allocation-counting resource converts a performance claim into an observable invariant. It also demonstrates the minimum `memory_resource` customization surface:

```cpp
#include <cassert>
#include <cstddef>
#include <memory_resource>
#include <vector>

class CountingResource final : public std::pmr::memory_resource {
public:
    explicit CountingResource(std::pmr::memory_resource* upstream)
        : upstream_{upstream} {}

    std::size_t allocation_calls() const noexcept { return calls_; }
    std::size_t allocated_bytes() const noexcept { return bytes_; }

private:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override {
        void* p = upstream_->allocate(bytes, alignment);
        ++calls_;             // Count successful allocations.
        bytes_ += bytes;
        return p;
    }

    void do_deallocate(void* p, std::size_t bytes,
                       std::size_t alignment) override {
        upstream_->deallocate(p, bytes, alignment);
    }

    bool do_is_equal(
        const std::pmr::memory_resource& other) const noexcept override {
        return this == &other;
    }

    std::pmr::memory_resource* upstream_;
    std::size_t calls_ = 0;
    std::size_t bytes_ = 0;
};

int main() {
    CountingResource counted{std::pmr::new_delete_resource()};
    std::pmr::vector<int> values{&counted};

    values.reserve(64);
    const auto warmed_up = counted.allocation_calls();

    for (int iteration = 0; iteration != 1000; ++iteration) {
        values.clear();       // retains vector capacity
        for (int i = 0; i != 64; ++i) {
            values.push_back(i);
        }
    }

    assert(counted.allocation_calls() == warmed_up);
}
```

The counter is deliberately not thread-safe. The test gives one thread exclusive access, matching `unsynchronized` resource assumptions. If shared instrumentation is required, synchronization or per-thread counters must be added, and their measurement effect understood.

Count after the upstream allocation succeeds. If allocation throws, the resource has not delivered storage. A fuller diagnostic resource may separately count attempts, successful calls, deallocations, current bytes, peak bytes, and request-size histograms.

This test proves a narrow statement: the vector made no further storage requests through `counted` after `reserve`. It does not prove:

- no allocation occurred through a different resource or global `operator new`;
- element constructors allocate nothing;
- no page fault occurred when already-allocated pages were first touched;
- the loop has bounded execution latency.

Route the complete object graph through the instrumented resource, combine it with platform allocation/page-fault profiling, and prefault storage where the operating environment requires it. The useful invariant is workload-specific: after initialization, this event-processing path makes zero allocation calls and touches only resident, owned storage.

### Custom resource correctness checklist

A resource wrapper must forward the exact byte count and alignment it received to a compatible upstream during deallocation. Its equality operation must reflect cross-deallocation compatibility. Its lifetime must dominate both users and upstream calls. If it collects data concurrently, the counters must be synchronized without introducing a data race.

Alignment is especially easy to lose in wrappers. Do not replace
`upstream_->allocate(bytes, alignment)` with an unaligned byte allocation. Chapter 7 covers the underlying aligned-allocation obligations.

---

## 8.8 Worked low-latency design: per-message scratch state — Core

Assume a market-data handler parses one message into temporary strings and price levels. All temporary data is discarded before the next message. Requirements:

- no general-heap allocation after warm-up;
- a hard memory limit per message;
- no temporary object may escape the processing call;
- failure on an oversized message must be explicit;
- one feed thread owns the scratch state.

The lifetime shape selects a monotonic resource. A fixed initial buffer plus `null_memory_resource()` makes capacity bounded. The resource is declared before all borrowing containers. Each container is destroyed before `release()`.

```cpp
#include <array>
#include <cstddef>
#include <memory_resource>
#include <string>
#include <string_view>
#include <vector>

struct Level {
    int price;
    int quantity;
};

void consume(std::string_view symbol,
             const std::pmr::vector<Level>& levels);

class MessageScratch {
public:
    void process(std::string_view incoming_symbol) {
        ReleaseOnExit reset{arena_}; // declared first, therefore destroyed last
        std::pmr::string symbol{incoming_symbol, &arena_};
        std::pmr::vector<Level> levels{&arena_};
        levels.reserve(32);

        // Parsing is abbreviated; every temporary owner uses arena_.
        levels.push_back(Level{10100, 20});
        consume(symbol, levels);
    } // levels and symbol die, then reset releases all scratch storage

private:
    struct ReleaseOnExit {
        std::pmr::monotonic_buffer_resource& resource;
        ~ReleaseOnExit() { resource.release(); }
    };

    alignas(std::max_align_t)
        std::array<std::byte, 16 * 1024> storage_{};
    std::pmr::monotonic_buffer_resource arena_{
        storage_.data(), storage_.size(),
        std::pmr::null_memory_resource()
    };
};
```

Member destruction order is safe: `arena_` is declared after `storage_`, so it is destroyed first; both survive every container local to `process`. If allocator-aware containers were members, they would need to be declared after `arena_` so they were destroyed before it.

`ReleaseOnExit` is also ordered deliberately. It is constructed before the allocator-backed locals and therefore destroyed after them, on normal return and during exception unwinding. The resource is reset only after the string and vector destructors have finished.

The abbreviated parser must not store `symbol.data()`, `levels.data()`, iterators, spans, or views beyond `consume`. That lifetime condition is part of the API contract. If output must survive, it must be copied into a destination-owned region before `process` returns.

### Sizing and failure reasoning

The 16 KiB size is not a universal recommendation. Derive a bound from the accepted message format and the chosen library's observed allocation requests:

1. Bound the number of levels and maximum symbol/text bytes at validation.
2. Account for vector capacity, string character storage, alignment padding, and resource bookkeeping.
3. Exercise maximum legal inputs through a counting or tracing resource on the production standard-library implementation.
4. Add a documented safety margin for implementation variation accepted by the deployment policy.
5. Keep `null_memory_resource` upstream so a mistaken estimate fails visibly in a test instead of silently changing latency behavior.

The function currently lets `std::bad_alloc` escape on exhaustion. A real handler must put the policy at an appropriate boundary: reject and count an invalid/oversized message, trigger a controlled feed reset, or terminate if capacity exhaustion violates a proven invariant. Catching inside the hottest inner loop may complicate control flow; allowing an uncaught exception may be unacceptable. The correct boundary depends on the system's recovery contract, not allocator fashion.

### What to measure

Warm the code path, then measure separately:

- allocation calls and requested bytes through the scratch resource;
- fallback attempts, which must remain zero;
- minor and major page faults on the feed thread after warm-up;
- typical and high-percentile processing latency under realistic bursts;
- maximum scratch high-water usage;
- CPU migrations and contention if the ownership model is violated.

Compare against a baseline using pre-reserved ordinary containers, not against an artificially allocation-heavy implementation. The arena may improve locality and reset cost, but fixed capacity consumes reserved memory and rejects inputs beyond its bound. That is the trade: deterministic policy and easy bulk reclamation in exchange for a capacity contract and non-escaping lifetimes.

---

## 8.9 Classic allocator requirements and `allocator_traits` — Deep dive

This section is useful when implementing an allocator type, maintaining allocator-parameterized libraries, or reading container diagnostics. It is not required to choose among standard PMR resources.

### The traits adapter

Containers access allocators through `std::allocator_traits<A>`. The traits class normalizes a small allocator interface and derives or defaults associated operations. Important members include:

| Traits facility | Purpose |
|---|---|
| `value_type` | Element type requested through this allocator |
| `pointer`, `const_pointer`, `size_type`, `difference_type` | Associated types, defaulted when absent |
| `rebind_alloc<U>` | Corresponding allocator for another type |
| `allocate`, `deallocate` | Storage operations |
| `construct`, `destroy` | Object lifetime operations |
| `select_on_container_copy_construction` | Allocator selected for a copied container |
| POCCA, POCMA, POCS | Assignment/swap propagation |
| `is_always_equal` | Whether every instance is deallocation-compatible |
| `allocate_at_least` | C++23 request that may report usable capacity greater than requested |

Do not call optional legacy members such as `a.construct(...)` directly. Go through `allocator_traits`, which provides the fallback and supports allocators that omit them.

### A compact classic allocator

This stateless example delegates storage to `std::allocator` and exists to show the shape, not to improve performance:

```cpp
#include <cstddef>
#include <memory>
#include <type_traits>

template<class T>
class DelegatingAllocator {
public:
    using value_type = T;
    using is_always_equal = std::true_type;

    DelegatingAllocator() noexcept = default;

    template<class U>
    DelegatingAllocator(const DelegatingAllocator<U>&) noexcept {}

    [[nodiscard]] T* allocate(std::size_t n) {
        return std::allocator<T>{}.allocate(n);
    }

    void deallocate(T* p, std::size_t n) noexcept {
        std::allocator<T>{}.deallocate(p, n);
    }

    template<class U>
    bool operator==(const DelegatingAllocator<U>&) const noexcept {
        return true;
    }
};
```

An allocator's exact requirements depend on the standard version and how its type is formed. A conventional `template<class T> Alloc` can often be rebound by `allocator_traits` without declaring the old nested `rebind` struct. The converting constructor remains important for carrying state between `Alloc<T>` and `Alloc<U>`. Do not memorize C++98 boilerplate as the modern minimum; validate a custom allocator with the actual containers and operations it must support.

### Rebinding

`std::vector<T, A>` allocates a contiguous array of `T`. A node-based container needs storage for an implementation-defined node containing links, bookkeeping, and a `T`. It obtains a rebound allocator:

```text
user supplies Alloc<T>
        │
allocator_traits<Alloc<T>>::rebind_alloc<Node>
        ▼
     Alloc<Node>
```

State must survive that conversion. If an arena allocator's `Alloc<T>` points to arena X but its rebound `Alloc<Node>` silently points elsewhere, node allocation violates the user's policy.

### `allocate` and `deallocate`

`allocate(n)` returns storage suitable for an array of `n` `T` objects or throws an exception on failure. It must guard the element-count-to-byte-count calculation against overflow before requesting bytes. The returned pointer need not point to live `T` objects yet.

`deallocate(p, n)` receives the pointer and count associated with the allocation according to the allocator requirements. It is not a general `free` operation. The allocator must support the alignments required for its `value_type`, including over-aligned types. A wrapper that forwards to `malloc` without handling extended alignment is not a general conforming solution.

C++23's `allocator_traits::allocate_at_least(a, n)` returns an allocation result containing a pointer and an actual element count of at least `n`. This lets an allocator expose size-class rounding to a consumer rather than hiding usable capacity. It does not permit a caller to construct beyond the returned count or deallocate with an unrelated size.

### Stateful allocator design

A stateful allocator should define:

- what its state points to and who owns that state;
- equality in terms of cross-deallocation compatibility;
- propagation traits matching the intended value semantics;
- behavior when rebound to another element type;
- thread-safety and exhaustion behavior;
- whether it can satisfy over-aligned requests.

Propagation is an API semantic, not a container optimization switch. If POCMA is true, moving a container may replace the destination's allocator state. If that would unexpectedly change region ownership, leave it false and accept that unequal-allocator moves are linear. If POCS is false, callers must establish equality before swapping.

### Standard guarantee versus implementation observation

| Claim | Classification |
|---|---|
| Unequal, non-propagating allocator swap violates the standard container requirement | Standard rule |
| A PMR resource pointer is non-owning | Standard interface consequence |
| `monotonic_buffer_resource::deallocate` has no effect | Standard behavior |
| A particular `pmr::vector` is one pointer larger than `std::vector` | Implementation observation |
| A pool uses a particular set of size classes | Implementation detail |
| PMR costs a fixed number of cycles | Unsupported without a named measurement |

This distinction matters in interviews and design reviews. Start from the rule needed for correctness, then describe the likely implementation mechanism, then state what would be measured.

---

## 8.10 Common traps — Reference

| Trap | Violated rule | Repair |
|---|---|---|
| Returning a PMR container backed by a local resource | Resource and storage die before the container | Use caller-owned resource or copy into destination-owned storage |
| Calling `release()` while containers or views remain live | Bulk release invalidates all resource storage and runs no destructors | End object scopes first, then release |
| Assuming `clear()` reclaims monotonic bytes | Resource deallocation is a no-op | Use a valid phase boundary and `release()` |
| Copying a PMR container and expecting the same resource | Copy construction uses allocator selection | Pass the target resource explicitly |
| Treating every move as constant time | Unequal explicit/destination allocator prevents stealing | Check allocator equality, overload, capacity, and propagation |
| Swapping unequal PMR containers | POCS is false and allocator equality is required | Keep values in one region or perform explicit copies |
| Using `pmr::vector<std::string>` and expecting nested PMR | Ordinary `std::string` has its own allocator type | Use `std::pmr::string` |
| Adding `scoped_allocator_adaptor` to all-PMR nesting | Solves a classic nested-forwarding problem already handled by PMR | Use it where classic inner allocators need forwarding |
| Sharing an unsynchronized resource between threads | Concurrent access is not safe | Give it thread ownership, synchronize externally, or choose another design |
| Declaring `is_always_equal = true` for distinct arenas | Containers may skip checks and cross-deallocate | Report compatibility truthfully |
| Allowing an arena to fall back silently | Capacity violation reaches an unexpected upstream | Choose an explicit upstream; use null for a hard bound |
| Counting only outer-container allocations | Elements may allocate elsewhere | Route and instrument the complete object graph |

---

## Recall and practice

### Recall card

1. Containers separate storage from lifetime: capacity can contain both live objects and raw slots.
2. Classic allocators are part of the container type; PMR selects a `memory_resource` at runtime through a non-owning pointer.
3. Equality means cross-deallocation compatibility. POCCA, POCMA, and POCS control propagation during assignments and swap.
4. Unequal, non-propagating move assignment is element-wise and may allocate; unequal, non-propagating swap is undefined behavior.
5. PMR copy construction selects the current default resource unless an allocator is supplied explicitly.
6. All-PMR nesting uses allocator-aware construction automatically; classic nested containers use explicit forwarding or `scoped_allocator_adaptor`.
7. Monotonic resources fit bulk lifetimes; pool resources fit independent deallocation and reuse. Neither owns a resource passed as upstream.
8. Destroy every resource-backed object before `release()` or resource destruction, and prove steady-state behavior with instrumentation.

### Questions

1. Why can a vector have capacity for eight objects while only three object lifetimes have begun?
2. What exactly must `a == b` mean for allocator instances?
3. A PMR vector is copy-constructed without an explicit resource. Which selection mechanism determines its resource?
4. Derive what move assignment must do when POCMA is false and the source and destination allocators are unequal.
5. Why is swapping two PMR containers backed by unequal resources not an element-wise fallback?
6. Why does `std::pmr::vector<std::pmr::string>` propagate its resource, while `std::pmr::vector<std::string>` does not?
7. When does `scoped_allocator_adaptor` add behavior that an ordinary classic allocator lacks?
8. Compare monotonic and pool resources for a workload that erases half its nodes but retains the rest for hours.
9. What does an allocation counter prove, and which allocation or latency sources can it miss?
10. Design the ownership order for a fixed buffer, a monotonic resource, a pool upstreamed by that resource, and a PMR list.

### Code-reading puzzle

```cpp
std::pmr::vector<int> make_values() {
    std::byte bytes[1024]{};
    std::pmr::monotonic_buffer_resource arena{
        bytes, sizeof bytes, std::pmr::null_memory_resource()
    };
    std::pmr::vector<int> values{&arena};
    values.push_back(42);
    return values;
}
```

Identify both lifetime failures in the returned value. Does copy elision or move construction make either one safe?

### Design exercise

Design scratch allocation for a single-threaded feed parser whose legal messages contain at most 64 levels and 256 bytes of text. Specify:

- the resource chain and hard-exhaustion behavior;
- declaration and destruction order;
- how nested strings receive the resource;
- how an oversized message is handled;
- how maximum storage is estimated on the deployment library;
- a test proving that representative steady-state processing performs no unexpected allocation.

Then change the workload: parsed orders may survive independently for minutes and are erased out of order. Explain why the original resource no longer fits and what resource or representation you would evaluate instead.

### Next prerequisite

Chapter 9 assumes that storage policy and ownership policy are separate. Before continuing, be able to state who owns a resource, who merely borrows it, when storage becomes invalid, and which allocator is permitted to deallocate it. Chapter 9 applies those lifetime contracts to raw pointers, `unique_ptr`, `shared_ptr`, and other ownership handles.
