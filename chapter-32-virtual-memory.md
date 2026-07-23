# Chapter 32 — Virtual Memory

## Why this matters

Virtual memory separates the addresses used by a process from the physical storage currently backing them. The separation gives isolation, sparse address spaces, shared mappings, copy-on-write, file-backed access, protection, and controlled reclaim. It also makes work lazy: reserving an address range, receiving a pointer from an allocator, or successfully mapping a file does not imply that every translation and physical page is ready.

For a latency-sensitive process, three questions drive the chapter:

1. Which accesses can enter the kernel through a page fault?
2. Which operations can invalidate translations or trigger reclaim, writeback, compaction, or migration?
3. How will startup establish and verify the intended residency, page size, locking, and failure policy?

This is a Linux-focused chapter through C++23. Architecture behavior, Linux API contracts, kernel-version behavior, and measurements are labeled separately. Chapter 29 owns NUMA placement strategy; Chapter 31 owns thread affinity and stack sizing; Chapter 34 owns explicit I/O; Chapter 56 owns journaling and crash-consistency protocols.

---

## 90-second screen — Core

- A virtual mapping is a policy and address range; it is not proof that every page is resident or writable without faulting.
- A TLB hit avoids a page-table walk. TLB reach is `entries × page size`; huge pages exchange coarser allocation/protection for greater reach and fewer page-table entries.
- A **minor fault** needs no backing-device read but can still allocate, zero, copy, wait for locks, or enter reclaim. A **major fault** required I/O. Neither category provides a latency bound.
- Copy-on-write shares pages until a write requires a private copy or permission change. `fork` and `MAP_PRIVATE` rely on it.
- Linux `MAP_PRIVATE` changes never update the file; `MAP_SHARED` changes enter the page-cache/writeback path. Visibility, writeback completion, durability, and crash atomicity are different properties.
- Locking and prefaulting solve different problems. `mlock` prevents eligible locked pages from being reclaimed; prefaulting establishes translations/backing before the critical phase.
- Transparent huge-page behavior depends on kernel version, configuration, mapping type, page size, alignment, and policy. Verify the actual mapping in the running process.

Be ready to defend two decisions:

1. Which regions are anonymous/file-backed, private/shared, base-page/huge-page, locked/unlocked, and why?
2. What happens if prefaulting, locking, huge-page allocation, or the memory limit fails at startup?

---

## 32.1 Why virtual memory, and what a process owns — Core

A process works in a virtual address space. The kernel and MMU jointly map portions of it to physical memory, file cache, device mappings, or no backing at all.

Virtual memory provides:

- **isolation:** one process cannot ordinarily address another’s memory;
- **protection:** mappings can be readable, writable, executable, or inaccessible;
- **sparse layout:** large ranges can be reserved without allocating all backing pages;
- **sharing:** distinct processes can map the same physical/file-backed pages;
- **copy-on-write:** mappings can share until modification;
- **reclaim:** the kernel can discard recoverable pages or move anonymous contents to swap;
- **stable virtual addresses:** physical pages can be migrated while the virtual interface remains.

### Address-space layout

A typical Linux process contains multiple virtual memory areas:

```text
low addresses
  executable text / read-only data / writable data
  heap-related mappings
  anonymous arenas and file mappings
  shared libraries
  thread stacks with guards
  kernel-provided helper mappings
high addresses
```

Exact order, gaps, addresses, and growth directions are architecture, loader, kernel, and ASLR dependent. Address-space layout randomization deliberately varies placement to make exploitation harder. It can also change cache-index and alignment effects between benchmark runs; disabling it is a controlled-measurement choice, not production tuning.

### Linux implementation labels

Linux represents a process address space with an `mm_struct`. Mapped ranges are **virtual memory areas** (VMAs) carrying address bounds, permissions, flags, backing object, and policy. Contemporary kernels use a Maple Tree to index VMAs; older descriptions often mention an rbtree plus linked list. This is kernel-version implementation detail, not a userspace ABI.

A fault or `mprotect` lookup first determines which VMA covers the address and whether the requested access is allowed. A process with many fragmented mappings increases VMA-management and observation work, but the cost is not one fixed amount per mapping.

### Heap and stacks

General allocators can obtain virtual memory by growing a traditional heap region with `brk` and by creating independent `mmap` regions. The cutoff, trimming, arena count, and reuse policy belong to the allocator implementation. A source-level `new` does not identify which kernel mechanism occurs.

The initial thread’s stack and library-created thread stacks are also mappings. An access that enters a guard region faults instead of silently entering the protected neighbor; a large stack-pointer jump can skip a narrow guard, so guard sizing and stack-clash probing still matter. Linux’s `MAP_STACK` is currently primarily a compatibility marker, and library thread stacks are normally fixed-size mappings rather than indefinitely growing objects. Stack sizing and alternate signal stacks belong to Chapters 31 and 33.

---

## 32.2 Multi-level page tables and PTE state — Core

For each memory access, the processor separates a virtual address into a page offset and virtual page number. Page tables translate the virtual page to a physical frame and attach permissions/state.

```text
virtual address
+---------------- virtual page number ----------------+-- offset --+
                         |
                         v
root -> level -> level -> leaf page-table entry
                         |
                         +---- physical frame + permissions

physical address = physical frame || unchanged page offset
```

A multi-level radix structure avoids allocating one flat table for the entire possible address space. Missing upper-level branches consume no lower-level tables. Larger page mappings terminate the walk at a higher level where the architecture permits.

### Architecture labels

x86-64 and AArch64 both support multi-level translation, but virtual-address widths, number of levels, base-page sizes, huge-page sizes, permission bits, accessed/dirty handling, and tagging differ by CPU and OS configuration. Do not hard-code “48 bits and four levels” as the only x86-64 mode or “4 KiB” as every AArch64 Linux base page.

Discover the process’s base page size through the OS, for example `sysconf(_SC_PAGESIZE)` on POSIX. Discover supported explicit huge-page sizes from Linux interfaces rather than assuming two named sizes exist.

A conceptual leaf entry can encode:

- whether a translation is present;
- readable/writable and user/kernel permission;
- executable or no-execute state;
- physical frame number;
- architecture/kernel state used for accessed, dirty, copy-on-write, swap, or special mappings;
- page-size information.

The exact bit layout is architectural and kernel-internal. Copy-on-write is not one universal hardware “COW bit”; Linux combines VMA permissions, PTE permissions, page metadata, and fault handling.

### Page-table memory and sharing

Smaller pages require more leaf entries for the same mapped bytes. A rough page-table model is:

```text
leaf PTE bytes ~= mapped bytes / page size × PTE size
```

Upper levels, sparse ranges, shared kernel tables, huge mappings, and implementation details change the total. Linux exposes page-table accounting such as `VmPTE` in `/proc/PID/status`; measure it for the target process.

Page tables themselves use memory and cache capacity. Under virtualization, a hardware walk can require a second level of translation maintained by the hypervisor, increasing the importance of translation caching and page-size choices. Exact walk costs belong to the named CPU and virtualization configuration.

### Worked translation-size estimate

Consider an 8 GiB dense region and assume, only for this calculation, 4 KiB base pages, 2 MiB larger pages, and 8-byte leaf entries:

```text
base-page leaves = 8 GiB / 4 KiB = 2,097,152
leaf storage      = 2,097,152 × 8 B = 16 MiB

large-page leaves = 8 GiB / 2 MiB = 4,096
leaf storage      = 4,096 × 8 B = 32 KiB
```

The calculation excludes upper tables and every implementation detail, but it exposes the scale difference. It also does not say that 16 MiB of page-table data is fetched for each access: the TLB, page-walk caches, and ordinary caches retain translations and table lines.

Suppose a particular data-TLB structure offered 512 usable entries for each page class. Its idealized reach would be 2 MiB with 4 KiB pages and 1 GiB with 2 MiB pages. That does **not** prove the larger-page run wins. A sparse 8 GiB reservation may touch only a few MiB, while a larger-page policy can add zeroing, compaction, fragmentation, or unwanted memory footprint. The defensible chain is:

```text
large dense working set
  -> measured TLB misses/page walks are material
  -> candidate regions satisfy alignment and lifecycle constraints
  -> page-size experiment reduces end-to-end tails without new VM stalls
```

Use the real processor’s TLB organization and the mapping’s observed page sizes when replacing this estimate with a capacity model.

---

## 32.3 TLBs, page walks, and invalidation — Core

A translation lookaside buffer (TLB) caches recent virtual-to-physical translations plus relevant permission state. A TLB hit lets address translation proceed without a page-table walk. A miss starts a hardware or software-assisted walk, depending on the architecture.

### Reach and walk cost

For a fully usable TLB level:

```text
TLB reach = translation entries × mapped page size
```

Real processors have multiple TLBs, separate instruction/data structures, shared second-level structures, associativity constraints, and different entries for different page sizes. The formula is a first bound, not a prediction of hit rate.

A page walk is a dependent chain: the entry found at one level gives the address of the next table. Page-walk caches can retain intermediate entries, and page-table lines can hit in ordinary caches. Therefore “number of levels × DRAM latency” is a pessimistic story, not a normal constant.

Measure:

- data and instruction TLB miss events;
- completed walks and walk-active cycles where supported;
- working-set size and access pattern;
- actual page sizes in the mappings;
- performance before and after a controlled page-size change.

Counter names and semantics are vendor-specific. Chapter 43 owns event validation and multiplexing checks.

### TLB invalidation and shootdowns

Changing a mapping or permission can leave stale translations on CPUs that used the address space. The kernel must invalidate them before the old translation can be used incorrectly.

```text
Thread changes mapping
    -> kernel updates page tables
    -> local invalidation
    -> remote CPUs that may cache translation are coordinated
    -> completion rule is satisfied
    -> old physical page/permission can be reused safely
```

**Architecture — x86-64:** TLB entries are not kept coherent merely because another core writes a page table. Linux uses architecture invalidation instructions and, when needed, inter-processor coordination. PCID and range/batch mechanisms can reduce work.

**Architecture — AArch64:** the architecture provides translation invalidation operations with shareability scopes and ordering requirements. That does not make every Linux invalidation free or eliminate all inter-CPU coordination. Cost still depends on scope, CPU count, mapping, and implementation.

Operations that may require invalidation include `munmap`, `mprotect`, copy-on-write permission changes, reclaim/unmap, page migration, and huge-page promotion/demotion. Linux batches and defers some work; do not infer one interrupt per page or one fixed cost.

The application-level mitigation is stable mappings during the critical phase. Avoid repeatedly mapping, unmapping, protecting, or discarding hot regions. Allocator trimming can perform these operations indirectly, so trace syscalls rather than inspect only application source.

---

## 32.4 Demand paging, fault types, and copy-on-write — Core

A page fault is a synchronous exception raised when the current translation cannot satisfy an access. Linux looks up the VMA, checks access, and resolves or signals:

```text
access virtual address A
  |
  +-- no covering VMA / forbidden permission ---> SIGSEGV
  |
  +-- valid VMA, translation absent
  |      +-- anonymous demand allocation/zeroing
  |      +-- file page already in page cache
  |      +-- file page requires storage I/O
  |      +-- anonymous page requires swap-in
  |
  +-- write to COW/read-only PTE in writable VMA
         +-- allocate/copy or reuse page, update permission
```

Linux accounting calls a fault **minor** when it does not require loading a page from a backing storage device, and **major** when it does. That classification is useful but incomplete:

| Fault path | Minor/major tendency | Work that may occur |
|---|---|---|
| Anonymous first write | Minor | allocate, zero, charge cgroup, install PTE |
| Anonymous first read | Minor | may use a shared zero page/huge zero page |
| Cached file page | Minor | map existing page-cache page |
| Uncached file page | Major | filesystem/block I/O and wait |
| Swapped anonymous page | Major | swap-cache lookup and storage/decompression path |
| Copy-on-write | Minor | allocate/copy or permission update |
| NUMA hinting/misplaced-page fault | Kernel-specific accounting | placement sampling and possible migration |

Do not attach a universal microsecond value to either category. A minor fault can wait for allocator work, memory-policy/cgroup charging, locks, compaction, or direct reclaim. A major fault’s delay depends on filesystem, device, queueing, readahead, and errors. Count and trace faults, then measure their distributions on the named system.

### Worked access sequence

Take three newly established regions: a private writable anonymous mapping, a private read-only file mapping whose pages are not cached, and a private writable mapping of that same file.

1. Reading the first anonymous page can cause a minor fault that installs shared zero backing. No unique writable anonymous page is implied.
2. Writing that page causes another fault. Linux obtains charged writable backing, zeroes it as required, installs a writable translation, and resumes the instruction. The fault is normally minor, but the allocation path can still encounter reclaim or compaction.
3. Reading an uncached file page can cause a major fault because filesystem/storage I/O is needed. A later page might already have arrived through readahead and then fault only minor when its page-cache page is mapped.
4. Reading the private writable file mapping can reuse the same page-cache page. The mapping remains private only with respect to modifications.
5. Writing that private mapping causes a COW fault. The process receives private dirty memory; the underlying file is unchanged by that store.
6. Unmapping and remapping the anonymous address discards the old mapping contract. A repeated address value does not preserve the previous PTE, contents, residency, or TLB entry.

This sequence shows why “first touch,” “file fault,” and “private mapping” are insufficient diagnoses. Record access type, mapping flags, cache state, and whether backing I/O occurred. Also distinguish a fault from a TLB miss: a valid page-table translation missing from the TLB causes a walk, not a Linux page-fault handler invocation.

### Anonymous zero pages and prefault implications

On Linux, a read from untouched anonymous memory may be satisfied by a shared read-only zero page rather than allocating a unique writable page. A later write then faults to obtain writable backing. Consequently, reading each page is not a reliable way to prepare a private writable arena.

For a writable critical region, populate it through the write-fault path: use `MADV_POPULATE_WRITE` where supported and applicable, or perform controlled writes. For a read-only file mapping, read population/readahead is appropriate. The desired future access determines the prefault method.

### Copy-on-write

After `fork`, parent and child initially share eligible pages. Private file mappings and the anonymous zero-page path use related COW behavior. On a write:

1. the access fails the current writable permission;
2. Linux validates that the VMA permits writing;
3. it obtains private writable backing or reuses the page when safe;
4. it copies data when needed;
5. it changes the PTE and invalidates stale translation state as required.

The copy granularity and whether a transparent huge page is copied, split, or handled another way depend on kernel version and page state. Avoid a universal “COW copies the whole huge page” claim.

Forking a large active process can impose page-table work and later COW faults on both parent and child. `MADV_DONTFORK` or `MADV_WIPEONFORK` can change inheritance for suitable regions, but their semantics must match the application. Chapter 31 owns process-creation strategy.

---

## 32.5 Mappings, protections, and failure signals — Core

`mmap` creates a mapping; it does not promise that every page is populated.

Two axes describe ordinary mappings:

| Backing | `MAP_PRIVATE` | `MAP_SHARED` |
|---|---|---|
| Anonymous | Process-private zero-fill/COW memory | Shared anonymous memory, commonly across related processes |
| File | Private COW view; modifications do not update file | Modifications affect shared page-cache pages and enter writeback |

`MAP_SHARED_VALIDATE` asks Linux to reject unknown mapping flags rather than silently ignoring them and is required for some specialized flags. Feature availability is version/filesystem dependent.

### Mapping lifecycle

```text
mmap succeeds
  -> VMA exists
  -> pages may still be absent
  -> first access may fault/populate
  -> mprotect may change allowed access
  -> msync/writeback may act on shared file pages
  -> munmap removes range and may require invalidation
```

Check every return value. `MAP_POPULATE` is an optimization request with weaker failure reporting than many callers assume: the `mmap` call does not necessarily fail merely because full population could not be completed. `MAP_LOCKED` is also weaker than an explicit successful `mlock` when the goal is to exclude later major faults. Use the API whose failure semantics match the policy, then verify residency/fault counts.

### `mprotect`

`mprotect` changes access permissions over page-aligned ranges. It can split VMAs, modify page tables, and invalidate cached translations. W^X transitions for JIT code are a legitimate use; toggling protections repeatedly on a hot path has both syscall and translation costs. Memory protection keys, where supported, provide a different mechanism with architecture-specific scope and are outside this chapter’s core.

Protection is checked at more than one layer. The VMA describes what the mapping permits; installed PTEs must encode compatible permissions; the TLB may cache those permissions. Linux must update and invalidate in an order that prevents a CPU from using stale access. This is why changing one source-level flag can become cross-CPU work.

Use `PROT_NONE` deliberately for guard ranges or reserved-but-inaccessible address space. It does not free the VMA. For JIT code, complete data writes, publish with the required language-level synchronization, perform the platform’s instruction-cache maintenance where required, and only then expose executable permission. C++ atomic ordering and OS page protection solve different problems.

### `SIGSEGV` versus `SIGBUS`

- `SIGSEGV` commonly means no permitted mapping covers the access or the requested permission is denied.
- `SIGBUS` for a file mapping commonly occurs when the virtual address is mapped but the corresponding file storage no longer exists, such as access beyond a truncated file’s new end.

Do not reduce every possible signal cause to one sentence; architecture-specific alignment errors, hardware errors, and special mappings add cases.

The shared-file truncation race is operationally important:

```text
reader maps file length N
writer truncates/replaces underlying object incorrectly
reader touches a page beyond new end
kernel delivers SIGBUS at the access
```

Prevent it by lifecycle design: seal a `memfd` against shrink/grow where applicable, never truncate a live shared object, or publish a new version and switch readers. A signal handler is a crash-diagnostics fallback, not a general recovery transaction. Chapter 33 owns signal-safety rules.

---

## 32.6 Page cache, readahead, writeback, and durability boundaries — Core

File-backed mappings normally interact with the Linux page cache. A cache miss can initiate filesystem I/O; a shared writable mapping can dirty cached pages; background or synchronous writeback later sends dirty data toward storage.

### Read path and readahead

Sequential access can trigger page-cache readahead. Random access can make that extra I/O wasteful. `madvise(MADV_SEQUENTIAL)` and `MADV_RANDOM` communicate expected mapping access patterns; they are advice, and exact effects are kernel/filesystem/version dependent.

For a latency-sensitive read-mostly mapped file:

1. validate the file size and lifecycle;
2. issue appropriate readahead/population before the critical phase;
3. touch or verify the pages needed by the working set;
4. lock only if the capacity and privilege policy justifies it;
5. watch major faults and refault/reclaim signals in steady state.

Mapping a file converts some explicit I/O errors into faults/signals at load instructions. Use `pread` or another explicit I/O API when error timing and cancellation matter more than direct mapped access.

### Dirty pages and throttling

Dirty shared pages cannot accumulate without bound. Linux writeback policy uses background workers and can throttle tasks that dirty memory faster than the backing system can absorb it. A store instruction can therefore contribute to later stalls through dirty limits even though the initial store only changed cache/page-cache state.

Relevant evidence includes dirty/writeback amounts, writeback activity, I/O pressure, and task-level delay. Thresholds and algorithms vary by kernel and configuration; do not prescribe one global dirty ratio for every machine.

### Visibility is not durability

| Event | What can safely be claimed |
|---|---|
| Store to `MAP_SHARED` memory | Other correctly synchronized mappers can observe the cache-coherent update |
| `write` returns | Data accepted by the kernel according to that API; ordinary buffered writes are not thereby power-loss durable |
| `msync(..., MS_ASYNC)` on Linux | Linux tracks dirty pages; since Linux 2.6.19 this flag performs no additional scheduling work |
| `msync(..., MS_SYNC)` succeeds | Requested mapped-file updates were synchronously written back per the filesystem/API contract |
| `fsync`/`fdatasync` succeeds | The documented file synchronization guarantee, subject to filesystem/device behavior |

`msync(MS_SYNC)` is not a transaction, ordering protocol, or record-atomicity guarantee. It does not by itself make a multi-page data structure crash-consistent. Metadata and directory-entry durability have separate rules, and storage power-loss atomicity must come from documented filesystem/device guarantees. Chapter 56 builds journal protocols; Chapter 34 owns `O_DIRECT` and explicit I/O semantics.

Persistent-memory/DAX mappings have different flush and mapping contracts. `MAP_SYNC` is Linux-version/filesystem/device specific and requires `MAP_SHARED_VALIDATE`; it is not a generic “durable mmap” flag.

---

## 32.7 Locking and prefaulting policy — Core

**Prefaulting** establishes backing and page-table state before the critical phase. **Locking** prevents eligible pages from being paged/reclaimed while locked. One does not imply every property of the other.

### Linux API comparison

| Mechanism | Core effect | Important qualification |
|---|---|---|
| Manual write per base page | Exercises writable fault path | Generates stores; must resist optimization and obey object lifetime |
| `MADV_POPULATE_READ` | Faults readable pages as if read | Linux 5.14+; private anonymous pages may still use zero backing |
| `MADV_POPULATE_WRITE` | Faults writable pages as if written | Linux 5.14+; mapping restrictions and later-version extensions apply |
| `MAP_POPULATE` | Attempts mapping population/readahead | Incomplete population does not necessarily fail `mmap` |
| `mlock`/`mlock2` | Locks a range; Linux brings required pages in unless on-fault mode used | Subject to limits/privilege and mapping rules |
| `mlockall(MCL_CURRENT)` | Locks current eligible mappings | Later mappings are not covered |
| `MCL_FUTURE` | Requests locking of future mappings | Future `mmap`/`brk`/stack growth may fail on limit exhaustion |
| `MCL_ONFAULT` / `MLOCK_ONFAULT` | Lock pages when faulted | Deliberately does not prefault the untouched range |

Version-check Linux-only advice flags at compile/runtime as appropriate. A successful return and a steady-state zero-fault observation are both useful: the former validates the API request, the latter validates the complete lifecycle.

### Compact Linux/POSIX example

The complete C++23 example maps an anonymous arena, prefers `MADV_POPULATE_WRITE` when the build exposes it, falls back to one write per base page, then locks the range. It keeps a fallback because kernel support and mapping applicability can differ from header availability.

```cpp
#include <cerrno>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <sys/mman.h>
#include <unistd.h>

int main() {
    constexpr std::size_t length = 1U << 20;
    const long page_value = ::sysconf(_SC_PAGESIZE);
    if (page_value <= 0) return EXIT_FAILURE;
    const auto page = static_cast<std::size_t>(page_value);

    void* mapping = ::mmap(nullptr, length, PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED) return EXIT_FAILURE;

    bool populated = false;
#ifdef MADV_POPULATE_WRITE
    populated = (::madvise(mapping, length, MADV_POPULATE_WRITE) == 0);
#endif
    if (!populated) {
        auto* bytes = static_cast<volatile std::byte*>(mapping);
        for (std::size_t offset = 0; offset < length; offset += page)
            bytes[offset] = std::byte{0};
    }

    const bool locked = (::mlock(mapping, length) == 0);
    if (!locked)
        std::fprintf(stderr, "mlock failed: errno=%d\n", errno);

    if (locked && ::munlock(mapping, length) != 0)
        return EXIT_FAILURE;
    return ::munmap(mapping, length) == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
```

The example reports `mlock` failure instead of claiming the policy succeeded. A production service can treat that as fatal or degraded according to an explicit contract. The manual fallback writes `std::byte` storage and does not construct arbitrary application objects.

### What locking does not guarantee

Locking does not:

- reserve CPU time or prevent preemption;
- prevent TLB misses or mapping invalidations;
- stop another thread from calling `mprotect`/`munmap`;
- make future unmentioned mappings resident;
- establish NUMA placement by itself;
- make mapped writes durable;
- eliminate COW faults after an ill-timed `fork`.

Memory locks are not inherited by a child across `fork`. Linux documentation also warns that COW faults after locking can harm real-time predictability. Arrange process creation before entering the locked critical phase where possible.

`RLIMIT_MEMLOCK`, `CAP_IPC_LOCK`, service-manager configuration, and cgroup/resource constraints affect success. `MCL_FUTURE` can make later thread-stack allocation fail, so create required threads and validate their stacks in the startup plan.

### Conditional startup policy

One defensible sequence is:

```text
1. establish thread/NUMA policy (Chapters 29 and 31)
2. create required threads and mappings
3. allocate/construct arenas and queues
4. establish intended base/huge-page backing
5. prefault with the future access mode
6. lock the required working set
7. warm code/data paths
8. verify mappings, locked bytes, page sizes, and fault deltas
9. enter the critical phase
```

Order changes may be valid. For example, a service using `MCL_FUTURE` deliberately might lock before creating later mappings so failure occurs immediately. State why, test exhaustion, and do not silently continue with a different latency profile.

---

## 32.8 Page sizes and huge-page choices — Core

Larger pages increase TLB reach and reduce page-table entry count. They also enlarge allocation, zeroing, copy, reclaim, protection, and internal-fragmentation units.

| Property | Base pages | Transparent huge pages | Explicit hugetlb pages |
|---|---|---|---|
| Allocation | Ordinary VM | Kernel promotion/fault policy | Dedicated hugetlb pool |
| Page-size certainty | Base size | May vary over time/range | Requested supported hugetlb size |
| Fallback | Normal | Often falls back to smaller pages | Mapping/allocation can fail |
| Reclaim/split | Ordinary reclaim | May split/demote under policy/pressure | Pool-managed; hugetlb pages are not swapped under memory pressure |
| Operational effort | Lowest | Policy/version verification | Pool sizing, privilege/mount/accounting |
| Main risk | TLB/page-table pressure | Compaction/promotion/demotion and uncertain coverage | Reserved capacity and allocation failure |

### Explicit huge pages

Linux `MAP_HUGETLB` requests hugetlb-backed mappings. Supported sizes, pool availability, privilege/group rules, NUMA distribution, reservation semantics, and surplus behavior depend on the kernel and platform.

Advantages:

- explicit page-size class;
- reduced TLB/page-table pressure;
- no transparent background promotion of that range.

Costs:

- pool capacity is unavailable to ordinary allocations according to hugetlb policy;
- internal fragmentation for small/sparse regions;
- startup can fail when the required pool/node lacks pages;
- provisioning at runtime may require compaction or may fail after fragmentation.

The correct fallback is workload-specific. A service whose SLO depends on the huge mapping may fail startup. A best-effort analytics job may log and use base pages. Neither response is universally correct.

### Transparent huge pages

THP policy is not one Boolean. Current Linux supports multiple transparent page sizes on some platforms, per-size controls, anonymous and shmem/tmpfs policies, and constrained file-backed cases. Behavior has changed across kernel versions and configuration.

Relevant mechanisms include:

- allocating a large page on fault when policy and availability permit;
- background collapse by `khugepaged`;
- synchronous best-effort collapse through `MADV_COLLAPSE` on supported kernels;
- splitting/demotion because of protection changes, COW, reclaim, or underuse;
- direct reclaim/compaction depending on defrag policy.

`MADV_HUGEPAGE` and `MADV_NOHUGEPAGE` control eligibility/advice for a range; they do not prove the current page size. `MADV_COLLAPSE` has distinct semantics and, on supported kernels, can bypass global “never” settings while still respecting an explicit no-huge-page VMA.

The Linux 6.17 THP documentation describes ordinary support for anonymous and
tmpfs/shmem mappings. Some kernel trees/configurations have also exposed
constrained read-only file-backed mappings, reflected by fields such as
`FilePmdMapped`. Consequently, executable file mappings are not a universal
“huge text page” feature. Verify kernel version/configuration, filesystem and
mapping requirements, alignment, write state, and the actual mapping’s
`KernelPageSize`, `MMUPageSize`, `AnonHugePages`, `ShmemPmdMapped`, or
`FilePmdMapped` fields; procfs fields themselves evolve.

### Decision procedure

1. Measure TLB/walk contribution with the real working set.
2. Identify regions large, dense, aligned, and stable enough for larger pages.
3. Compare explicit hugetlb and opted-in THP under idle and memory pressure.
4. Record fault, compaction, split/collapse, RSS, and latency distributions.
5. Define pool/policy exhaustion and rollback.
6. Verify page sizes after startup and over time.

Huge pages are valuable when translation is material; they are not a universal latency improvement.

---

## 32.9 Worked diagnosis: first request is slow, tails recur — Core

A service shows two symptoms:

- the first request after restart is much slower;
- later tail spikes coincide with host memory pressure.

### Hypotheses

The startup symptom may come from:

- anonymous demand faults and zeroing;
- file-backed major/minor faults and readahead;
- COW after process creation;
- cold TLB/page-table/cache state;
- lazy allocator or dynamic-loader work.

The recurring tails may come from:

- reclaim or refault of the working set;
- dirty-page throttling/writeback;
- THP compaction/promotion/splitting;
- allocator `mmap`/`munmap` and TLB invalidation;
- NUMA migration;
- cgroup `memory.high` reclaim or approaching `memory.max`.

### Evidence plan

Capture before and during a reproduction:

```bash
perf stat -e page-faults,minor-faults,major-faults -- ./service-test
grep -E '^(VmSize|VmRSS|VmLck|VmPTE|HugetlbPages):' /proc/"$PID"/status
cat /proc/"$PID"/smaps_rollup
cat /proc/pressure/memory
cat /sys/fs/cgroup/APP/memory.events
cat /sys/fs/cgroup/APP/memory.pressure
```

Paths and cgroup layout vary. `perf` event availability and permissions vary. `/proc/PID/smaps` offers per-mapping detail but can be expensive on mapping-heavy processes; use it for targeted diagnosis rather than high-frequency polling.

Record deltas, not only cumulative totals:

| Evidence | Supports | Does not prove alone |
|---|---|---|
| Major-fault increase | Backing I/O occurred for fault | Which file/device caused it |
| Minor-fault increase | Translation/backing/COW work without counted backing I/O | That each fault was cheap |
| PSI memory stall | Tasks lost time to memory pressure | Exact page or call site |
| `memory.events` high/max/oom changes | cgroup limit interaction | Global host cause |
| THP split/collapse/compact counters | Huge-page activity | Direct causality without timing correlation |
| `mmap`/`munmap` trace | Mapping churn | Shootdown cost on a particular CPU |
| Walk events rise | Translation pressure | That huge pages are the best fix |

Use fault tracepoints/BPF or sampled call stacks where supported to attribute fault addresses and stacks. Tool overhead and kernel symbol availability must be included in the report.

### Controlled fixes

Test one mechanism at a time:

1. prefault writable arenas and required file pages;
2. lock only the measured critical working set;
3. stop allocator trimming/mapping churn or replace hot allocation with arenas;
4. opt stable dense regions into a tested page-size policy;
5. provide cgroup and host headroom or load-shed before pressure;
6. move process creation and COW before the critical phase.

Success means fault deltas and pressure signals change as predicted and the latency distribution improves under the same workload. A zero fault count does not prove zero TLB misses, and a lower walk counter does not prove that THP compaction tails are acceptable.

---

## 32.10 `madvise` and user-space fault handling — Role-specific

`madvise` includes advisory and semantic operations. Read the exact manual for the target kernel and mapping.

| Advice | Broad purpose | Critical qualification |
|---|---|---|
| `MADV_RANDOM` / `MADV_SEQUENTIAL` | Influence access/readahead policy | Advisory, implementation dependent |
| `MADV_WILLNEED` | Request near-future availability/readahead | Does not guarantee residency at return |
| `MADV_POPULATE_READ/WRITE` | Synchronously populate applicable ranges | Linux 5.14+ with mapping/version restrictions |
| `MADV_DONTNEED` | Discard/release current contents according to mapping semantics | Anonymous private pages later read as zero; not a harmless cache hint |
| `MADV_FREE` | Mark private anonymous pages lazily reclaimable | Contents are uncertain after reclaim; RSS may remain |
| `MADV_COLD` / `MADV_PAGEOUT` | Influence reclaim/pageout | Linux 5.4+; best-effort/applicability constraints |
| `MADV_DONTFORK` / `MADV_WIPEONFORK` | Change fork inheritance | Semantic lifecycle change |
| `MADV_HUGEPAGE` / `MADV_NOHUGEPAGE` | THP eligibility policy | Does not verify current backing |
| `MADV_DONTDUMP` | Exclude range from core dump | Debuggability trade-off |

Ignoring an unsupported return turns a requested policy into wishful thinking. Log `errno`, kernel version, mapping type, and chosen fallback.

### `userfaultfd`

Linux `userfaultfd` lets user space receive and resolve selected faults on registered ranges. Feature modes and supported mapping types are version-gated:

- missing-page handling;
- write-protect faults;
- minor-fault handling for supported hugetlbfs/shmem cases;
- non-page-fault events such as unmap/remove in supported configurations.

Uses include post-copy migration, checkpoint/restore, live snapshotting, and specialized paging. It moves fault resolution into another user-space component; it does not make the fault path bounded. Handler scheduling, queueing, registration permissions/security policy, and failure recovery become part of correctness.

For a hot path, pre-establishing memory is normally simpler than deliberately faulting into `userfaultfd`. Use it when lazy population or write tracking is itself the product requirement.

---

## 32.11 Working sets, reclaim, swap, and limits — Role-specific

A **working set** is the memory actively needed over a relevant time window. Capacity planning must include application pages, page tables, allocator fragmentation, page cache, kernel memory, device buffers, replicas, and safety headroom.

### Reclaim paths

Under pressure, Linux can:

- discard clean file-backed pages and read them again later;
- write dirty file-backed pages before reclaim;
- move eligible anonymous pages to swap;
- reclaim lazily freed pages;
- shrink kernel caches;
- compact/migrate pages to satisfy contiguous allocations;
- invoke cgroup or global OOM policy when progress/capacity fails.

Background reclaim tries to maintain free-memory watermarks. Direct reclaim runs in the context of a task that needs memory and can impose application-visible delay. Reclaim implementation has evolved: classic active/inactive lists and optional/configurable multi-generational LRU behavior must be labeled by kernel configuration/version.

Refaults matter more than eviction counts alone. Reclaiming a page that is immediately needed again creates thrashing. PSI reports time tasks are stalled under memory pressure and can be observed system-wide or per cgroup v2; it complements page counters.

### Reverse mapping, migration, compaction, fragmentation

To unmap or migrate a physical page, Linux may need to find page-table mappings that reference it. Anonymous reverse mapping and file mapping structures support that work. Cost depends on sharing and mapping topology.

Compaction attempts to create larger contiguous free extents by migrating movable pages. It can support huge-page allocation and higher-order kernel allocation, but consumes CPU and can stall an allocating/faulting task when synchronous. External fragmentation means enough free bytes exist but not in suitable contiguous blocks.

NUMA balancing can deliberately create hinting/protection faults, sample access locality, and migrate pages. Chapter 29 owns the placement decision. Here the important point is observability: those faults/migrations are VM work and can affect latency even without storage I/O.

### Swap and compressed swap

Swap gives anonymous contents a backing store so pages can be reclaimed. A later access may require a major fault. Swap cache can retain swap-backed pages in memory. zswap is a compressed in-memory cache for pages on the swap path; it trades CPU and compressed-memory capacity against backing-store I/O. zram and other compressed-memory configurations have different architecture and policy.

“Disable swap” is conditional advice. It removes storage swap-in stalls but reduces reclaim options and can reach OOM sooner. A latency service may choose that trade with sufficient RAM, locking, cgroup isolation, load shedding, and a restart plan. A general server may prefer controlled swap/compression. Measure the failure mode being optimized.

### Overcommit and OOM

Linux `vm.overcommit_memory` modes are:

- `0`: heuristic overcommit handling;
- `1`: always overcommit from the commit-accounting perspective;
- `2`: stricter commit accounting based on configured commit limit.

Mode 2 does not mean every future access is latency-bounded or immune to cgroup limits, NUMA exhaustion, kernel allocations, `MAP_NORESERVE`, or administrative changes. Successful allocation reserves/address-accounts according to policy; it is not proof that all pages are resident.

OOM can be global, constrained by a memory policy/cpuset, or local to a memory cgroup. Victim selection and group behavior depend on configuration. Adjusting one process’s OOM score transfers risk to other services and must be an operational decision, not a coding trick.

For cgroup v2 inspect `memory.current`, `memory.high`, `memory.max`, `memory.events`, swap controls, and `memory.pressure`. `memory.high` can throttle through reclaim before `memory.max` produces an OOM event.

### Kernel same-page merging

KSM can scan eligible mergeable anonymous pages, replace identical pages with shared read-only backing, and use COW on later writes. It exchanges memory savings for scanning, reverse-mapping, and write-fault work. It is appropriate for some consolidation workloads; latency-sensitive processes should know whether their mappings are opted in rather than assume a system-wide behavior.

---

## 32.12 Accounting and observability — Reference

Linux memory numbers answer different questions:

| Metric | Meaning and caveat |
|---|---|
| VSZ / `VmSize` | Virtual address-space extent; includes untouched and nonresident mappings |
| RSS / `VmRSS` | Resident pages charged to the process; shared pages can be counted in multiple processes and some interfaces are approximate |
| PSS | Resident shared pages divided among sharers; useful for aggregate attribution |
| USS | Private resident memory attributable only to the process; commonly derived by tools |
| `VmLck` | Bytes reported locked |
| `VmPTE` | Page-table memory accounting |
| `HugetlbPages` | hugetlb memory charged to process |

Do not call stable RSS proof of a leak or its absence. Allocators retain memory, lazy-free pages can remain resident, file cache is reclaimable, and shared-page accounting differs.

### Compact inspection map

| Interface | Use |
|---|---|
| `/proc/PID/maps` | Address ranges, permissions, private/shared flag, backing names |
| `/proc/PID/smaps` | Per-mapping RSS/PSS/private/shared/locked/page-size details |
| `/proc/PID/smaps_rollup` | Aggregate smaps-style accounting |
| `/proc/PID/status` | Summary fields such as RSS, locked, PTE, fault-independent process state |
| `/proc/PID/numa_maps` | Mapping-level NUMA policy/page distribution |
| `/proc/vmstat` | System VM events: faults, reclaim, compaction, THP, migration, writeback |
| `/proc/pressure/memory` | System memory-pressure stall time |
| cgroup v2 memory files | Workload-specific usage, limits, events, pressure |

Fields evolve by kernel. Reading detailed procfs data also consumes CPU and can contend with address-space changes; benchmark the monitoring interval.

Page-fault counters are cumulative. Capture before/after deltas around a known phase. Pair them with fault address/stack tracing when attribution matters. Reclaim and PSI are system/cgroup signals; a process can suffer due to another workload without increasing its own major-fault count.

### Residency is a snapshot, not a promise

`mincore` can report whether pages of an eligible mapping are resident at the instant Linux samples them. It does not lock the pages, identify which process caused residency, promise that a later access will avoid a fault, or establish writable private backing merely because an anonymous read resolves through zero backing. `/proc/PID/pagemap` and related interfaces have permission and information restrictions that have changed for security reasons.

A startup verifier should therefore combine evidence:

1. API results prove that the requested `madvise`, `mlock`, or mapping operation was accepted.
2. `smaps`/status data checks locked bytes, RSS, and effective page-size fields for the intended address ranges.
3. Phase-scoped minor/major-fault deltas show whether the warm-up exercised the future access pattern.
4. Pressure testing demonstrates whether reclaim, compaction, cgroup charging, or a fallback policy changes the steady-state result.

No single RSS value establishes all four properties. For example, a range can be resident but unlocked, locked but still incur TLB misses, or huge-page eligible while currently backed by base pages.

---

## Recall card — Core

- VM separates process-visible addresses from current physical/file backing.
- VMAs describe mapped ranges; page tables encode translations and permissions; TLBs cache them.
- TLB reach is page size times usable entries, but associativity and multiple levels affect hit rate.
- Minor means no counted backing-device load, not “bounded” or “cheap.” Major means I/O was needed.
- An untouched anonymous read may use shared zero backing; prepare writable arenas through the write path.
- COW shares until write; `fork`, private mappings, and huge-page state determine the resulting work.
- `MAP_PRIVATE` never writes changes to the file; `MAP_SHARED` enters page-cache/writeback semantics.
- Prefaulting establishes backing/translations; locking prevents eligible locked pages from reclaim.
- Explicit hugetlb and THP have different allocation, fallback, reclaim, and observability contracts.
- Visibility, synchronous writeback, durability, and crash consistency are separate guarantees.

---

## Common traps — Core

- Treating a successful `malloc` or `mmap` as proof that physical pages are resident.
- Assigning one fixed time to minor or major faults.
- Reading one byte per anonymous page and assuming private writable backing was allocated.
- Assuming every x86-64 system has four page-table levels and 4 KiB is every Linux base page.
- Calling every TLB invalidation one IPI per page.
- Using `MAP_POPULATE` or `MAP_LOCKED` without understanding their incomplete failure semantics.
- Enabling THP globally and assuming every mapping became one fixed huge-page size.
- Claiming file-backed/text THP support without kernel, configuration, filesystem, and mapping qualifications.
- Calling `MADV_DONTNEED` a harmless cache hint for private anonymous data.
- Using `MCL_FUTURE` without accounting for later stacks and mappings.
- Disabling swap without headroom, OOM, cgroup, and restart plans.
- Treating `msync(MS_SYNC)` as a transaction or universal power-loss atomicity guarantee.
- Polling detailed `smaps` aggressively on a mapping-heavy process.
- Fixing NUMA placement in this chapter without applying Chapter 29’s policy and verification.

---

## Reasoning questions

1. Why does a multi-level page table save memory for sparse address spaces, and what does a huge-page leaf change?
2. A minor-fault count rises during a latency spike. List four potentially expensive minor-fault paths.
3. Why can reading an untouched anonymous arena fail to prepare it for later writes?
4. Trace a write to a COW page after `fork`, including permission and translation changes.
5. What measurements distinguish TLB pressure from demand faults and from reclaim?
6. Compare explicit hugetlb pages and opted-in THP for page-size certainty, failure behavior, and memory pressure.
7. What does successful `mlock` establish, and what separate evidence verifies the complete startup policy?
8. Why can a valid-looking shared file pointer raise `SIGBUS` after another process changes the file?
9. What is guaranteed by a visible shared mapped store, `msync(MS_SYNC)`, and a crash-consistent journal respectively?
10. How can a cgroup-limited workload experience reclaim/OOM while the host still reports free memory elsewhere?

---

## Code-reading puzzle

The code attempts to remove all hot-path faults:

```cpp
void prepare(std::span<const std::byte> arena) {
    volatile std::byte sink{};
    for (std::size_t i = 0; i < arena.size(); i += page_size)
        sink = arena[i];
    (void)sink;
}
```

Assume `arena` refers to a private writable anonymous mapping that will later be modified. Explain why the loop can complete while future writes still fault. Redesign the interface and preparation step without writing outside object lifetimes. State how `MADV_POPULATE_WRITE`, manual byte-storage writes, and later construction differ.

---

## Implementation exercise

Build a Linux VM diagnostic with three regions:

1. private anonymous writable memory;
2. a private read-only file mapping;
3. a shared writable file or sealed-`memfd` mapping.

For each region, record mapping flags, page size, fault deltas, RSS/PSS, and page-size fields after:

- mapping only;
- read population;
- write population where permitted;
- successful locking;
- access under controlled memory pressure;
- cleanup/unmapping.

Run base-page and one available huge-page/THP configuration as separate trials. Add one deliberate file truncation in an isolated test process and confirm the documented signal rather than crashing the harness. Report kernel/configuration, filesystem, cgroup limits, swap state, NUMA policy, and exact commands. Finish with an exhaustion plan for failed locking, failed hugetlb allocation, unsupported advice, and a cgroup limit reached during startup.

---

## Prerequisite for Chapter 33

Chapter 33 builds IPC on shared mappings and handles asynchronous signals. Before continuing, be able to explain mapping lifetime, private versus shared changes, why truncation can produce `SIGBUS`, why process-shared visibility still needs synchronization, and why a signal handler cannot safely repair an arbitrary faulting transaction.
