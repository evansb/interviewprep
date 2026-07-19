# Chapter 32 — Virtual Memory

*Interview-focused revision notes. The theme: virtual memory is a lazy, lying abstraction — nothing you allocate exists until you touch it, and every mechanism in this chapter is either the kernel deferring work or you paying to stop it deferring at the wrong moment.*

---

## 32.1 Virtual and Physical Addresses

Every memory access a user program makes uses a **virtual address**. The MMU translates it to a **physical address** using per-process page tables, at a granularity of a **page** — 4 KiB on x86-64 and (usually) on AArch64 Linux, though AArch64 also supports 16 KiB and 64 KiB page sizes and Apple platforms use 16 KiB.

```
virtual address (48-bit canonical, x86-64 4-level)
 63      48 47    39 38    30 29    21 20    12 11        0
┌──────────┬────────┬────────┬────────┬────────┬───────────┐
│sign-ext  │ PML4   │  PDPT  │   PD   │   PT   │  offset   │
│(copy 47) │ 9 bits │ 9 bits │ 9 bits │ 9 bits │  12 bits  │
└──────────┴────────┴────────┴────────┴────────┴───────────┘
                                       └── page frame number ──┘ offset preserved
```

The low 12 bits (the **page offset**) pass through untranslated. Only the upper bits are translated, which is why translation granularity is a page and why a 4 KiB-aligned buffer stays 4 KiB-aligned in physical memory.

**Canonical addresses.** With 4-level paging only 48 bits are meaningful, and the hardware requires bits 63:47 to be all-equal (sign-extension of bit 47). This splits the space into a low half (`0x0000_0000_0000_0000`–`0x0000_7FFF_FFFF_FFFF`, 128 TiB, user) and a high half (`0xFFFF_8000_...`, kernel), with a non-canonical hole between them that faults with `#GP` rather than `#PF`. **LA57** (5-level paging, Ice Lake+) extends this to 57 bits / 128 PiB, but Linux only hands out addresses above 47 bits when explicitly requested via `mmap` hint — precisely so software that stores tag bits in the top pointer bits (Ch. 3 §3.10) doesn't break.

### Why virtual memory exists

| Property | Mechanism |
|---|---|
| Isolation | Separate page tables; a process cannot name another's memory |
| Relocation | Every program can be linked at the same virtual address (with ASLR, §32.20) |
| Overcommit | Virtual space can exceed physical (§32.18) |
| Sharing | Two page tables can point at one physical frame (§32.13) |
| Protection | Per-page R/W/X, user/supervisor bits |
| Demand paging | Nothing is resident until touched (§32.5) |

**The cost.** Every load and store requires a translation. The TLB (§32.7) makes the common case free; a miss costs a page walk (§32.8), 20–40 cycles warm and 100–200 ns cold. On a large-working-set random-access workload, **translation can be 10–40% of total runtime** — which is the entire justification for huge pages (§32.10–§32.11).

Physical memory itself is managed by the kernel's buddy allocator in power-of-two page orders, with per-CPU page lists for order-0 pages. Fragmentation of physical memory is what makes huge-page allocation fail at runtime (§32.11).

---

## 32.2 Process Address-Space Layout

A 64-bit Linux process on x86-64, with ASLR on:

```
0x7fff_ffff_ffff ┌──────────────────────────────┐  128 TiB user limit
                 │ [stack]  grows DOWN          │  RLIMIT_STACK (8 MiB default)
                 │   ↓                          │
                 │ 1 MiB stack_guard_gap        │
                 ├──────────────────────────────┤
                 │ mmap region — grows DOWN     │  shared libs, malloc's large
                 │   ld.so, libc, thread stacks │  allocations, anonymous mmaps
                 │   ↓                          │
                 ├──────────────────────────────┤
                 │        (large gap)           │
                 ├──────────────────────────────┤
                 │ [heap]  grows UP via brk     │  malloc's small allocations
                 │   ↑                          │
                 ├──────────────────────────────┤
                 │ .bss    (zero-filled)        │
                 │ .data   (rw, file-backed)    │
                 │ .rodata (r--)                │
                 │ .text   (r-x, file-backed,   │  shareable between processes
0x0000_5555_0000 │          often huge-page-able)│  running the same binary
                 ├──────────────────────────────┤
0x0000_0000_0000 │ unmapped — catches NULL derefs│  /proc/sys/vm/mmap_min_addr = 65536
                 └──────────────────────────────┘
0xffff_8000_...  kernel half: direct map of all physical RAM, vmalloc, module space
```

The kernel maintains this as a list (and red-black tree, now a maple tree in 6.1+) of **VMAs** — `vm_area_struct`, each describing a contiguous range with uniform protection, backing, and flags. `/proc/<pid>/maps` prints them (§32.25).

Facts worth having ready:

- **`.text` is file-backed and shared.** Twenty processes running the same binary share one copy of the code in the page cache (§32.22). This is why `RSS` overcounts and `PSS` exists (§32.24).
- **`.bss` occupies no file space** — it's an anonymous, zero-filled mapping created from the ELF program header's `memsz > filesz`.
- **The mmap region grows down** toward the heap on modern Linux (`mmap_base` is near the stack), so the "heap grows up, mmap grows down" picture is right for the classic layout. Which direction `mmap` picks (`legacy` vs `topdown`) depends on `RLIMIT_STACK` — an unlimited stack switches the kernel to the legacy bottom-up layout, which changes ASLR entropy and address ranges. That is a genuinely surprising interaction.
- **`mmap_min_addr`** (65536 by default) prevents mapping page zero, which historically turned NULL-pointer dereferences in the kernel into exploitable conditions.
- **Every thread's stack** (except the main thread's) is an ordinary `mmap` region in the mmap area, fixed-size, with a guard page (Ch. 31 §31.11).

`pmap -X <pid>`, `/proc/<pid>/maps`, and `/proc/<pid>/smaps_rollup` are the inspection tools.

---

## 32.3 Multi-Level Page Tables

A flat page table for a 48-bit space with 4 KiB pages would need 2³⁶ entries × 8 B = **512 GiB per process**. Multi-level (radix) page tables solve this by only materializing the levels that are actually used.

```
CR3 ──▶ PML4 (512 entries, 4 KiB)
          └─▶ PDPT (512 entries)      each entry covers 512 GiB
                └─▶ PD (512 entries)  each entry covers 1 GiB
                      └─▶ PT (512)    each entry covers 2 MiB
                            └─▶ 4 KiB page
```

Each level is exactly one 4 KiB page holding 512 8-byte entries (9 bits of index). A process using 1 MiB of memory needs 4 pages of page tables (16 KiB), not 512 GiB.

**PTE bit layout (x86-64), the parts that matter:**

| Bit | Name | Meaning |
|---|---|---|
| 0 | P (Present) | If 0, access faults. Linux uses the other 63 bits for swap entries when P=0. |
| 1 | R/W | 0 = read-only. **COW clears this** (§32.6). |
| 2 | U/S | 1 = user-accessible |
| 3,4 | PWT/PCD | Caching policy |
| 5 | A (Accessed) | Set by hardware on access; used by reclaim (§32.17) |
| 6 | D (Dirty) | Set by hardware on write; drives writeback (§32.22) |
| 7 | PS (Page Size) | At PD/PDPT level: this entry maps a 2 MiB / 1 GiB page directly (§32.10) |
| 8 | G (Global) | Entry survives a `CR3` reload — used for kernel mappings |
| 12–51 | PFN | Physical frame number |
| 63 | NX | No-execute |

**Page-table memory cost.** ~0.2% of mapped memory with 4 KiB pages (8 bytes per 4 KiB), i.e. **2 MiB of page tables per GiB**. With 2 MiB pages it drops 512×. For a process with 100 GiB mapped, that's 200 MiB of page tables — real memory, and real cache pressure during walks. `/proc/<pid>/status`'s `VmPTE` reports it.

**Consequences elsewhere:** `fork` must copy this structure (Ch. 31 §31.3), which is why `fork` is O(mapped pages). `munmap` must free it. And every page walk (§32.8) is up to four *dependent* memory accesses through this tree, which is why the hardware caches intermediate levels in dedicated **paging-structure caches** as well as in the ordinary data cache.

ARM64 uses the same radix idea with different names (levels 0–3, `TTBR0_EL1` for user and `TTBR1_EL1` for kernel — note that ARM has **two** base registers, so kernel/user split doesn't need the canonical-hole trick, and KPTI is cheaper).

---

## 32.4 Page Faults

A **page fault** is a synchronous exception raised when translation fails. The CPU pushes an error code and the faulting address (in `CR2` on x86-64), and the kernel's handler decides what happened.

```
fault at address A
   │
   ├─ Is there a VMA covering A?
   │     no ──▶ SIGSEGV (or stack expansion, §32.21)
   │
   ├─ Are the requested permissions allowed by the VMA?
   │     no ──▶ SIGSEGV  (e.g. write to a read-only mapping)
   │
   ├─ PTE not present:
   │     ├─ anonymous, first touch  ──▶ allocate + zero a page   [minor]
   │     ├─ file-backed, in page cache ──▶ map it                 [minor]
   │     ├─ file-backed, not cached ──▶ read from disk            [MAJOR]
   │     └─ swapped out ──▶ read from swap                        [MAJOR]
   │
   └─ PTE present but write to a read-only page:
         ├─ VMA is writable, page is shared ──▶ COW copy          [minor]
         └─ VMA is read-only ──▶ SIGSEGV
```

| Fault class | Cost | Counted in |
|---|---|---|
| **Minor** (no I/O) | 0.5–2 µs | `minflt`, `perf stat -e minor-faults` |
| **Minor with page zeroing** | +0.3–1 µs (4 KiB `memset`) | same |
| **COW fault** | 1.5–3 µs (fault + 4 KiB copy) | `minflt` |
| **THP fault** (2 MiB) | 20–100 µs (zeroing 2 MiB) | `minflt`, `thp_fault_alloc` |
| **Major**, NVMe-backed | 30–150 µs | `majflt`, `perf stat -e major-faults` |
| **Major**, spinning disk | 3–10 ms | `majflt` |

**The 0.5–2 µs figure decomposes as:** ~200 ns exception entry and handler dispatch, VMA lookup in the maple tree (~100 ns), page allocation from the per-CPU free list (~200 ns), clearing 4 KiB (~300 ns at 12 GB/s), PTE installation and a local TLB flush (~100 ns), plus return. Contention on the per-`mm` `mmap_lock` can add unbounded time when other threads are calling `mmap`/`munmap` concurrently — a real and underappreciated tail-latency source in multithreaded servers.

**Diagnostics.** `/proc/<pid>/stat` fields 10 and 12 (`minflt`, `majflt`); `perf stat -e page-faults,minor-faults,major-faults`; `perf trace -F` for a live fault stream; `bpftrace -e 'software:page-faults:1 { @[comm, kstack] = count(); }'` to attribute them.

**The rule for hot paths:** a page fault on a latency-critical thread is a bug. Not a slow path — a bug. Pre-fault and lock everything at startup (§32.15–§32.16). A single major fault at `SCHED_FIFO` 99 blocks the thread for milliseconds.

---

## 32.5 Demand Paging

Linux allocates **virtual** address space eagerly and **physical** memory lazily. `mmap` of 1 GiB returns instantly and consumes zero physical memory; the pages materialize one fault at a time as you touch them.

```cpp
void* p = mmap(nullptr, 1UL<<30, PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);   // ~5 µs, 0 bytes of RAM
// VSZ += 1 GiB, RSS += 0
memset(p, 0, 1UL<<30);                              // 262,144 faults × ~1.5 µs ≈ 400 ms
// RSS += 1 GiB
```

That 400 ms is the number to remember: **touching a gigabyte of fresh anonymous memory for the first time costs a few hundred milliseconds in page faults alone**, entirely separate from the memory bandwidth cost. It is why `std::vector` reserve-then-fill has a startup cliff, why the first pass over a fresh arena is slow, and why every low-latency service pre-faults at startup.

**The zero page optimization.** A *read* from an untouched anonymous page doesn't allocate anything — the kernel maps a single shared, read-only **zero page**. Only a write triggers allocation (as a COW fault off the zero page). So:

```cpp
char* p = (char*)mmap(...);      // 1 GiB anonymous
volatile char c = p[12345];      // read: maps the shared zero page. RSS unchanged.
p[12345] = 1;                    // write: COW → real page allocated. RSS += 4 KiB.
```
This is why "I read the whole array and RSS didn't grow" is a real observation, and why a read-only pre-fault loop is **not** sufficient pre-faulting for a buffer you intend to write.

**Anonymous pages must be zeroed** before being handed to userspace, for obvious security reasons. That zeroing is the dominant per-fault cost for large pages (2 MiB of zeroing is ~100 µs) and is why THP faults are so much more expensive individually even though there are 512× fewer of them.

**Interaction with allocators.** `malloc`/`operator new` returning a pointer does not mean the memory exists. glibc's `malloc` uses `brk` for small requests and `mmap` for requests ≥ `M_MMAP_THRESHOLD` (128 KiB by default, dynamically adjusted); in both cases the pages are demand-paged. `calloc` is faster than `malloc`+`memset` for large sizes precisely because it can rely on the kernel's guarantee that fresh anonymous pages are already zero and skip the memset entirely — a nice detail (Ch. 7 §7.5).

Controls: `MAP_POPULATE` (§32.16), `mlockall` (§32.15), `madvise(MADV_WILLNEED)` (§32.14), and huge pages to reduce the fault count 512× (§32.10).

---

## 32.6 Copy-on-Write Faults

COW is the mechanism that makes `fork` cheap (Ch. 31 §31.3) and also underlies private file mappings, the zero page, and KSM.

**Setup:** both mappings point at the same physical frame; both PTEs are marked **read-only** even though the VMA says writable; the frame's refcount is ≥ 2.

**Fault:** a write traps. The handler sees `vma->vm_flags & VM_WRITE` is set but `pte_write()` is false → this is a COW fault, not a protection violation.

**Resolution:**
```
if (page_count(page) == 1 && !PageKsm(page)) {
    // sole owner — no copy needed, just make it writable ("reuse")
    pte = pte_mkwrite(pte);
} else {
    new = alloc_page();
    copy_page(new, old);          // 4 KiB memcpy
    set_pte(new, writable);
    put_page(old);                // may free it
}
```

The **reuse** path matters: if the other side already unmapped or wrote its copy, the refcount drops to 1 and the next fault costs only a PTE update (~0.5 µs), no copy. This is why a `fork`+`exec` pattern costs far less than the naive analysis suggests — the child `exec`s and drops all its references before most COW faults ever happen.

| Case | Cost |
|---|---|
| COW fault, 4 KiB, copy required | 1.5–3 µs |
| COW fault, reuse (refcount 1) | 0.5–1 µs |
| COW fault on a 2 MiB THP | 50–150 µs (copy 2 MiB) or a page split |
| Write to the shared zero page | 1–2 µs (allocate + zero, no copy needed) |

**Where COW bites in production:**

- **`fork` from a large-heap process:** the parent takes COW faults on its *own* working set afterwards, because `fork` marked its pages read-only too. A parent with a 4 GiB active heap can take tens of thousands of COW faults after forking — a multi-millisecond stall on the parent's critical path.
- **Redis's classic problem:** `BGSAVE` forks; if the parent then writes heavily, COW duplicates much of the dataset, and memory usage can nearly double. THP makes it dramatically worse (2 MiB copied per touched byte), which is why Redis logs a warning telling you to disable THP.
- **`MADV_DONTFORK`** excludes a region from `fork` entirely (the child sees it unmapped), avoiding both the page-table copy and the parent's COW faults. Correct for large read-only data or DMA regions.
- **`MADV_WIPEONFORK`** gives the child zeroed pages instead — used for secrets and for RNG state that must not be duplicated.

**KSM** (Kernel Samepage Merging, `MADV_MERGEABLE`) deduplicates identical pages across processes by making them COW. It saves memory on VM hosts and is a latency disaster for anything else: `ksmd` scanning plus COW faults on write. Off by default; keep it off.

---

## 32.7 Translation Lookaside Buffers

The **TLB** is a cache of virtual→physical translations. Without it every memory access would need a page walk; with it, translation is free on a hit.

Typical modern x86-64 (Ice Lake / Golden Cove class):

| Structure | Entries | Latency |
|---|---|---|
| L1 iTLB (4 KiB) | 128–256 | 0 extra cycles (parallel with L1i) |
| L1 dTLB (4 KiB) | 64–96 | 0 extra cycles |
| L1 dTLB (2 MiB) | 32 | 0 |
| L1 dTLB (1 GiB) | 4–8 | 0 |
| **STLB (unified L2)** | **1536–2048** (shared 4K/2M), some parts 3072 | 7–9 cycles |
| Paging-structure caches (PDE/PDPTE) | dozens | Short-circuits the walk |

**TLB reach** — the amount of memory addressable without a miss — is the number that matters:

| Page size | STLB entries | Reach |
|---|---|---|
| 4 KiB | 1536 | **6 MiB** |
| 2 MiB | 1536 | **3 GiB** |
| 1 GiB | 8 | **8 GiB** |

**6 MiB is smaller than L3.** That single fact is the entire argument for huge pages: a workload with a 1 GiB random-access working set will hit in L3 sometimes but will miss the TLB essentially always with 4 KiB pages, adding a page walk to a large fraction of accesses. Switching to 2 MiB pages raises reach to 3 GiB and can remove 10–40% of runtime on pointer-heavy or hash-table workloads.

**TLB entries are tagged.** x86-64 PCID tags entries with a 12-bit address-space ID so a `CR3` reload doesn't flush everything (Ch. 31 §31.1); the **G** bit marks kernel entries as global and exempt from flushes. ARM uses ASIDs identically. Without PCID (or with KPTI on a non-PCID CPU), every syscall would flush the user TLB — which is why Meltdown mitigations were so expensive on older hardware.

**Measurement:**
```bash
perf stat -e dTLB-load-misses,dTLB-store-misses,iTLB-load-misses ./app
perf stat -e dtlb_load_misses.walk_active,dtlb_load_misses.walk_completed,\
             dtlb_load_misses.walk_pending,page_walker_loads.dtlb_memory ./app
# walk_active cycles ÷ total cycles = fraction of time spent walking. >5% → use huge pages.
```
`dtlb_load_misses.walk_active` divided by `cycles` is the single most actionable TLB metric: it tells you directly what fraction of your runtime is address translation.

**Not flushed by:** ordinary context switches with PCID, and reads. **Flushed by:** `CR3` writes without PCID, `INVLPG` (single page), `invpcid`, writes to `CR4.PGE`, and remote **shootdowns** (§32.9).

---

## 32.8 Page Walks

On a TLB miss the hardware **page miss handler** walks the radix tree. Four levels means up to four dependent memory accesses:

```
CR3 → PML4E → PDPTE → PDE → PTE → physical frame
      (load)  (load)  (load) (load)   ← each may itself miss in cache
```

| Situation | Cost |
|---|---|
| All levels in the paging-structure caches | ~7–10 cycles |
| All levels in L1/L2 data cache | 20–40 cycles |
| Levels in L3 | 60–120 cycles |
| Levels in DRAM (worst case, 4 dependent misses) | **300–600 cycles / 100–200 ns** |
| 5-level paging (LA57) | +1 level, ~25% worse worst case |

**The walk is not fully serialized in practice.** Modern cores have **two page-miss handlers** (so two walks can proceed concurrently) and cache intermediate nodes aggressively — a PML4E covers 512 GiB, so it's essentially always cached; a PDPTE covers 1 GiB; a PDE covers 2 MiB. In practice the top two levels are nearly always hits, and the real cost is the PDE and PTE loads. That's why the effective warm cost is 20–40 cycles rather than 4 full memory accesses.

**Huge pages shorten the walk itself**, not just the miss rate: a 2 MiB page terminates at the PDE (3 levels), and a 1 GiB page at the PDPTE (2 levels). Fewer levels, fewer loads, and 512× fewer distinct entries competing for TLB slots.

**Nested paging multiplies it.** Under a hypervisor with EPT/NPT, each guest-physical address must itself be translated, so a full walk is up to **4 × 4 + 4 = 24 memory accesses** in the worst case. This is why huge pages matter far more in virtualized environments and why nested-paging TLB misses can cost 500 ns+.

**Hardware prefetch does not help page walks** — the accesses are dependent and data-dependent. What helps: huge pages, reducing the working set, improving locality (Ch. 28), and avoiding pointer-chasing layouts (Ch. 42 §42.1).

`perf stat -e page_walker_loads.dtlb_memory` counts walk loads that went to memory rather than cache — a high value means the page tables themselves have fallen out of cache, which happens with very large sparse address spaces.

---

## 32.9 TLB Shootdowns

The TLB is a **per-core** cache with no hardware coherence. If one core changes a page-table entry that another core has cached, the kernel must explicitly invalidate the other core's TLB. That is a **shootdown**, and it is implemented with **inter-processor interrupts**.

```
CPU 0: munmap() / mprotect() / page migration / COW / reclaim
   │
   ├─ modify the PTE
   ├─ local: INVLPG
   ├─ compute mm_cpumask — which CPUs have run this mm
   ├─ send IPI to each ──────────────▶ CPU 3: interrupt, flush, ACK
   │                     ──────────────▶ CPU 7: interrupt, flush, ACK
   └─ BUSY-WAIT for all acknowledgements
```

**The initiator blocks until every target acknowledges.** That makes shootdown cost scale with the number of participating cores:

| Cores in `mm_cpumask` | Latency |
|---|---|
| 1 (single-threaded) | ~0.2 µs — local `INVLPG` only, no IPI |
| 2 | 2–5 µs |
| 8 | 5–15 µs |
| 64 | 10–50 µs |
| Full flush vs single page | Full flush is cheaper to issue, far more expensive in aftermath |

**Operations that trigger shootdowns:** `munmap`, `mprotect`, `madvise(MADV_DONTNEED)`, `mremap`, page reclaim/swap-out, COW when the page is shared across CPUs, THP collapse and split, NUMA balancing (§32.27), and `migrate_pages`.

**The latency signature.** An unrelated thread on an isolated core taking a multi-microsecond stall with no context switch, no page fault, and no syscall — because another thread in the same process called `munmap`. This is one of the very few ways a properly isolated core can still be interrupted, and naming it is a strong interview answer (Ch. 31 §31.19).

**Mitigations:**

- **Never `munmap`/`mprotect`/`madvise(DONTNEED)` on the hot path.** Allocate arenas once at startup and never return memory (Ch. 7 §7.7, Ch. 55 §55.1). glibc's `M_TRIM_THRESHOLD` and `mallopt(M_TRIM_THRESHOLD, -1)` stop `malloc` returning memory to the kernel behind your back.
- **Use huge pages** — 512× fewer PTEs to invalidate, and THP collapse can itself cause shootdowns, so prefer *explicit* huge pages (§32.10) over transparent ones for hot data.
- **Reduce `mm_cpumask`**: threads that never run on a CPU don't get IPIs. Pinning helps here as a side effect.
- **`MADV_FREE` instead of `MADV_DONTNEED`**: lazy — it marks pages reclaimable without immediately unmapping, deferring (and often avoiding) the shootdown. jemalloc uses it.

**Measurement:**
```bash
grep TLB /proc/interrupts                       # per-CPU TLB shootdown IPI counts
perf stat -e tlb:tlb_flush ./app
bpftrace -e 'kprobe:flush_tlb_others { @[kstack] = count(); }'
```
`/proc/interrupts`' `TLB` row is the direct measurement, and watching it climb on an isolated core points straight at the culprit.

ARM64 differs importantly: `TLBI` instructions with the `IS` (inner-shareable) modifier are **broadcast in hardware**, no IPI required. Shootdowns are much cheaper there — one of the genuine architectural advantages of AArch64 for many-core systems.

---

## 32.10 Explicit Huge Pages

**HugeTLB** pages are reserved from a separate pool at boot (or later, with less reliability) and allocated explicitly. x86-64 supports **2 MiB** and **1 GiB**; AArch64 supports 2 MiB / 32 MiB / 512 MiB / 1 GiB depending on the base page size.

```bash
# boot-time reservation (reliable — memory isn't fragmented yet)
default_hugepagesz=1G hugepagesz=1G hugepages=32 hugepagesz=2M hugepages=1024

# runtime (may fail or take seconds due to compaction)
echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
numactl --membind=0 ...   # per-node: /sys/devices/system/node/node0/hugepages/...

cat /proc/meminfo | grep -i huge
# HugePages_Total, HugePages_Free, HugePages_Rsvd, Hugepagesize, Hugetlb
```

Three ways to use them:

```cpp
// 1. anonymous, via mmap flags
void* p = mmap(nullptr, 2UL<<20, PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB|MAP_HUGE_2MB, -1, 0);

// 2. hugetlbfs file mapping (shareable between processes)
int fd = open("/dev/hugepages/ring", O_CREAT|O_RDWR, 0600);
ftruncate(fd, 1UL<<30);
void* p = mmap(nullptr, 1UL<<30, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);

// 3. SysV shm with SHM_HUGETLB
```

| Property | HugeTLB |
|---|---|
| TLB reach (2 MiB) | 3 GiB vs 6 MiB — the whole point |
| Page-table memory | 512× less (2 MiB) / 262144× less (1 GiB) |
| Fault count for 1 GiB | 512 (2 MiB pages) vs 262,144 |
| Per-fault cost | 20–100 µs (zeroing 2 MiB) |
| Swappable | **No** — HugeTLB pages are never swapped or reclaimed |
| Reclaimable under pressure | No — the pool is carved out and unavailable to everything else |
| Alignment requirement | Address and length must be huge-page aligned |
| Runtime allocation reliability | Poor once memory is fragmented; reserve at boot |

**Why explicit rather than transparent (§32.11) for a hot path:** determinism. HugeTLB pages are pre-reserved, never split, never collapsed by a background daemon, never reclaimed, and never subject to compaction stalls. THP gives you the same TLB benefit *most* of the time and an unpredictable multi-millisecond stall the rest of the time.

**The standard low-latency configuration** is 1 GiB pages reserved at boot for the packet pools, order books, and arenas, with `transparent_hugepage=never` globally. DPDK requires exactly this (Ch. 47 §47.3); its memory model is built on hugetlbfs.

**Costs to acknowledge:** the reserved pool is unavailable to everything else even when unused (it's not a cache, it's a carve-out); internal fragmentation is severe if you allocate many small objects at 2 MiB granularity; `1 GiB` pages have only 4–8 TLB entries, so using more than ~8 GiB of them re-introduces misses. And **NUMA placement of the pool is per-node** — reserve on the node your threads will run on.

---

## 32.11 Transparent Huge Pages

**THP** gives huge pages automatically, without application changes, by (a) allocating a 2 MiB page on fault when the VMA is suitably aligned and sized, and (b) having a background thread, `khugepaged`, scan for runs of 512 contiguous 4 KiB pages and **collapse** them into a huge page.

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled        # always | madvise | never
cat /sys/kernel/mm/transparent_hugepage/defrag         # always|defer|defer+madvise|madvise|never
cat /sys/kernel/mm/transparent_hugepage/khugepaged/*   # scan rate, sleep interval
grep -i AnonHugePages /proc/meminfo
grep -i AnonHugePages /proc/<pid>/smaps                # per-mapping THP usage
```

| Setting | Behaviour |
|---|---|
| `enabled=always` | Every eligible anonymous mapping gets THP. Convenient, and the source of the horror stories. |
| `enabled=madvise` | THP only where the application asked via `madvise(MADV_HUGEPAGE)`. **The right default.** |
| `enabled=never` | Off entirely. |
| `defrag=always` | On a THP fault with no huge page free, **synchronously compact memory** — this is the multi-millisecond stall. |
| `defrag=defer` | Wake `kcompactd` and fall back to 4 KiB now. |
| `defrag=defer+madvise` | Synchronous only for `MADV_HUGEPAGE` regions. Reasonable compromise. |

### The failure modes, with signatures

1. **Synchronous compaction stalls.** With `defrag=always` and fragmented memory, a single page fault can take **10–500 ms** while the kernel migrates pages to build a contiguous 2 MiB block. Signature: an enormous, isolated latency spike with high `sys` time, `compact_stall`/`compact_fail` climbing in `/proc/vmstat`, and a stack through `__alloc_pages_direct_compact`.
2. **`khugepaged` interference.** Collapsing pages requires taking `mmap_lock` for write, copying 2 MiB, and issuing TLB shootdowns (§32.9). It runs periodically forever. Signature: periodic microsecond-to-millisecond stalls correlated with `khugepaged` CPU time and `thp_collapse_alloc` in `/proc/vmstat`.
3. **Memory bloat.** A 4 KiB allocation in a fresh 2 MiB-aligned region gets a whole 2 MiB page. Sparse heaps balloon; RSS can be several times the useful data.
4. **COW amplification.** A COW fault on a THP copies 2 MiB (~100 µs) or splits the page. This is the Redis `fork` problem (§32.6).
5. **Splitting.** `mprotect`, `madvise(DONTNEED)`, or partial `munmap` on part of a THP splits it back into 512 PTEs, with a shootdown.

**Every major latency-sensitive database and trading system disables THP** — MongoDB, Redis, Couchbase, Cassandra, Oracle, and essentially all HFT shops. The recommendation is not "THP is bad", it is: **THP is a throughput optimization with unbounded tail latency; use explicit HugeTLB where you want the TLB benefit deterministically, and set `enabled=madvise` or `never` otherwise.**

```bash
echo never   > /sys/kernel/mm/transparent_hugepage/enabled
echo never   > /sys/kernel/mm/transparent_hugepage/defrag
# or at boot: transparent_hugepage=never
```
Applying it at boot matters: flipping it at runtime doesn't undo THPs already established.

---

## 32.12 Anonymous and File-Backed `mmap`

Every VMA is one or the other, and the distinction determines reclaim behaviour, sharing, and durability.

| | **Anonymous** | **File-backed** |
|---|---|---|
| Created by | `MAP_ANONYMOUS`, `brk`, stacks, `.bss` | `mmap(fd, ...)`, `.text`, `.data` |
| Backing store | **Swap** (if configured) | The file |
| Under memory pressure | Swapped out, or OOM if no swap | **Dropped** — clean pages just discarded, dirty pages written back |
| Initial content | Zero-filled | File content, read on demand |
| Shared between processes | Only via `fork` (COW) or `MAP_SHARED\|MAP_ANONYMOUS` | Naturally, via the page cache |
| Counted in | `AnonPages`, `RSS` | `Cached`/`Mapped`, `RSS` |
| `msync` meaningful | No | Yes |

```cpp
mmap(nullptr, n, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);  // heap-like
mmap(nullptr, n, PROT_READ,            MAP_PRIVATE, fd, 0);                // read a file
mmap(nullptr, n, PROT_READ|PROT_WRITE, MAP_SHARED,  fd, 0);                // shared, persistent
mmap(nullptr, n, PROT_READ|PROT_WRITE, MAP_SHARED|MAP_ANONYMOUS, -1, 0);   // shared with children
```

**The reclaim asymmetry is the key insight.** Clean file-backed pages cost nothing to reclaim — the kernel just unmaps them, because the file still has the data. Anonymous pages *must* be written to swap first, and if there's no swap they cannot be reclaimed at all, which is why a swapless machine under pressure goes straight to the OOM killer (§32.18). It also means that under memory pressure your **executable's text pages get evicted**, and the next call into that code takes a major fault — a genuine and bizarre-looking source of latency spikes in code that touches no data.

**`mmap` for file I/O vs `read`:**

| | `mmap` | `read`/`pread` |
|---|---|---|
| Copies | Zero (page cache mapped directly) | One (page cache → user buffer) |
| Syscalls | One `mmap`, then faults | One per read |
| Cost per 4 KiB (cached) | ~1 µs (minor fault) then free | ~0.5–1 µs, every time |
| Cost per 4 KiB (uncached) | Major fault, 30–150 µs, **blocking and unpredictable** | Same I/O, but you know where it happens |
| Error handling | **`SIGBUS`** on I/O error or truncation (§32.28) | `errno` |
| Random access on a large file | Excellent | Extra syscall per access |
| Sequential streaming | Worse (fault storm) — use `read` or `MADV_SEQUENTIAL` | Better |

For latency work the decisive point is the last row of the error section: `mmap` turns an I/O error into an asynchronous `SIGBUS` at an arbitrary instruction, which you cannot handle cleanly. `mmap` is right for a large read-mostly index you can pre-fault and lock; `read`/`io_uring` is right for anything where you need explicit control over when the I/O happens.

---

## 32.13 Shared and Private Mappings

`MAP_SHARED` vs `MAP_PRIVATE` is orthogonal to anonymous vs file-backed, giving four combinations:

| | `MAP_PRIVATE` | `MAP_SHARED` |
|---|---|---|
| **Anonymous** | Ordinary heap/stack memory. `fork` → COW. | Memory shared with `fork`ed children; also `memfd`. Survives `fork` as genuinely shared. |
| **File-backed** | COW view of a file. Writes are private, never hit disk. This is how `.data` is mapped. | Writes go to the page cache and eventually to the file. Shared between all mappers. |

**`MAP_PRIVATE` file mapping semantics are subtle:** your writes are private, but *before* you write, reads may see other processes' modifications to the file — the kernel is not required to snapshot. After you write to a page, you have your own COW copy and are isolated. This "unspecified whether you see updates before your first write" behaviour is explicitly stated by POSIX and is a classic gotcha.

**Shared memory between unrelated processes** (Ch. 33 §33.4):

```cpp
// POSIX shm — a file in /dev/shm (tmpfs)
int fd = shm_open("/orderbook", O_CREAT|O_RDWR, 0600);
ftruncate(fd, size);                                   // MUST size it before mapping
void* p = mmap(nullptr, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);

// memfd — anonymous, no filesystem name, pass the fd over a UNIX socket
int fd = memfd_create("ring", MFD_CLOEXEC | MFD_ALLOW_SEALING);
fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW);   // prevents the SIGBUS of §32.28
```

`memfd_create` with **sealing** is the modern, correct primitive: no name in the filesystem to leak or collide, the fd can be passed over a UNIX socket with `SCM_RIGHTS`, and `F_SEAL_SHRINK` makes truncation-induced `SIGBUS` impossible. Naming it marks you as current.

**Rules for data structures in shared memory** (Ch. 3 §3.12): no pointers (the segment may map at different addresses in each process — use offsets or indices), no vtables, no `std::string`/`std::vector`, and `std::atomic<T>` must satisfy `is_always_lock_free` or you get no cross-process atomicity at all. Process-shared mutexes need `PTHREAD_PROCESS_SHARED` and, for safety against a crashing holder, `PTHREAD_MUTEX_ROBUST`.

**Latency note:** a shared-memory SPSC ring between two processes on the same socket costs 100–300 ns per handoff — essentially the same as between two threads, because it's the same cache-coherence transfer. Process boundaries cost nothing at runtime; they cost only at setup.

---

## 32.14 `madvise`

`madvise(addr, len, advice)` tells the kernel how a region will be used. Most advice is a hint; several forms are *not* hints and change semantics.

| Advice | Effect | Semantics |
|---|---|---|
| `MADV_NORMAL` | Default readahead | Hint |
| `MADV_SEQUENTIAL` | Aggressive readahead, drop behind | Hint |
| `MADV_RANDOM` | **Disable readahead** — the useful one for random-access indexes | Hint |
| `MADV_WILLNEED` | Start readahead / swap-in now, asynchronously | Hint |
| `MADV_DONTNEED` | **Discard the pages now.** Anonymous → next read gives **zeroes**; file-backed → re-read from file. Frees memory immediately, causes a TLB shootdown. | **NOT a hint — destroys data** |
| `MADV_FREE` | Mark pages as reclaimable-if-needed; contents kept until pressure. A write cancels it. Cheaper: **no immediate shootdown**. | Lazy; contents may become zero |
| `MADV_HUGEPAGE` | Enable THP for this region even under `enabled=madvise` | Hint |
| `MADV_NOHUGEPAGE` | Forbid THP here | Hint |
| `MADV_DONTFORK` | Region is absent in a `fork`ed child | Semantic |
| `MADV_WIPEONFORK` | Child sees zeroes | Semantic |
| `MADV_DONTDUMP` | Exclude from core dumps (huge arenas, secrets) | Semantic |
| `MADV_COLD` / `MADV_PAGEOUT` | Deactivate / immediately reclaim (5.4+) | Semantic |
| `MADV_POPULATE_READ` / `_WRITE` | **Pre-fault without a memory write** (5.14+) | §32.16 |

**`MADV_DONTNEED` is the most dangerous call in this table.** On Linux it *immediately discards anonymous pages* — subsequent reads return zero. It is not "the kernel may drop these if convenient"; it is "delete this data now". (On BSD it *is* a hint, which makes portable code hazardous.) Allocators use it to return memory; if you call it on live data you get silent zeroing.

**`MADV_FREE` vs `MADV_DONTNEED`** is a favourite comparison:

| | `MADV_DONTNEED` | `MADV_FREE` |
|---|---|---|
| Pages unmapped immediately | Yes | No |
| TLB shootdown at call time | **Yes** (§32.9) | No |
| RSS drops immediately | Yes | **No** — only under pressure |
| Contents after | Zeroes, guaranteed | Old contents *or* zeroes |
| Cost | ~2–20 µs + shootdown | ~1 µs |
| Used by | glibc `malloc` trim | jemalloc, and glibc for some paths |

`MADV_FREE` confuses monitoring: RSS stays high after an application "frees" memory, and people report a leak that isn't one. `/proc/<pid>/smaps`' `LazyFree` field shows the amount.

**The low-latency prescription:** `MADV_HUGEPAGE` on your big arenas (with THP otherwise off), `MADV_DONTFORK` and `MADV_DONTDUMP` on multi-gigabyte pools, `MADV_RANDOM` on memory-mapped indexes, `MADV_POPULATE_WRITE` at startup, and **never** `MADV_DONTNEED` on a running hot path.

---

## 32.15 Memory Locking

`mlock`/`mlockall` pin pages into physical memory: they cannot be swapped, and (crucially) they must be **present**, so locking also faults them in.

```cpp
mlockall(MCL_CURRENT | MCL_FUTURE);   // current mappings + everything mapped later
// Linux 4.4+: MCL_ONFAULT — lock pages as they fault in, don't pre-fault everything
mlock2(addr, len, MLOCK_ONFAULT);
munlockall();
```

| | Effect |
|---|---|
| `MCL_CURRENT` | Fault in and lock everything currently mapped |
| `MCL_FUTURE` | Automatically lock every future mapping. **Makes `mmap` fail with `ENOMEM` instead of succeeding lazily** — which is arguably a feature (you find out at allocation time, not at fault time). |
| `MCL_ONFAULT` | Don't pre-fault; lock pages once they're touched. Avoids a huge startup cost for sparse mappings. |

**Limits.** `RLIMIT_MEMLOCK` (`ulimit -l`) caps locked memory; the default is often 64 KiB, which makes `mlockall` fail immediately. Raise it via `/etc/security/limits.conf` (`memlock unlimited`), `systemd`'s `LimitMEMLOCK=infinity`, or `CAP_IPC_LOCK`. Since kernel 5.x, `RLIMIT_MEMLOCK` no longer governs some cases (io_uring, some RDMA registrations moved to accounting), but for `mlockall` it still applies.

**Why it matters for latency.** Locking is not primarily about swap (a well-provisioned trading host has swap off entirely). It is about **guaranteeing no major faults**, including:

- Text pages of your binary being evicted under page-cache pressure and re-faulted on the next call — the surprising case.
- Pages reclaimed by `kswapd` under a memory spike from an unrelated process.
- Pages of shared libraries dropped and re-read.

`mlockall(MCL_CURRENT|MCL_FUTURE)` at startup is a standard line in every real-time and trading process, alongside pre-faulting the stack (Ch. 31 §31.11) and pre-touching every arena (§32.16).

**What locking does not do:** it does not prevent TLB shootdowns, does not prevent minor faults on *not yet mapped* regions, does not stop `khugepaged` from collapsing (use `MADV_NOHUGEPAGE` too), and does not pin the *physical address* — the kernel may still migrate the page for NUMA balancing or compaction unless you also disable those. For DMA you need real pinning (`pin_user_pages` in the kernel, or a registered memory region in RDMA — Ch. 47 §47.14).

**Verification:** `/proc/<pid>/status`'s `VmLck`, and `/proc/<pid>/smaps` `Locked:` per mapping. `perf stat -e major-faults` should read zero in steady state; if it doesn't, your locking is incomplete.

---

## 32.16 Page Prefaulting

Pre-faulting means paying the fault cost at startup rather than on the critical path. There are five mechanisms, and they differ in ways that matter.

| Method | Effect | Notes |
|---|---|---|
| `mmap(..., MAP_POPULATE)` | Kernel pre-faults the whole mapping at `mmap` time | Synchronous; a 1 GiB anonymous mapping takes ~200–400 ms |
| `mlockall(MCL_CURRENT)` | Faults in *and* locks everything | The strongest and the usual choice |
| `madvise(MADV_POPULATE_WRITE)` | Pre-faults for write, no memory traffic from userspace (5.14+) | **The correct modern tool** |
| `madvise(MADV_WILLNEED)` | Asynchronous readahead | Advisory; doesn't guarantee presence |
| Manual touch loop | Write one byte per page | Portable; must be a **write**, not a read (§32.5) |

```cpp
// portable manual pre-fault — note it must WRITE
void prefault(void* base, size_t len, size_t pagesz = 4096) {
    auto* p = static_cast<volatile char*>(base);
    for (size_t i = 0; i < len; i += pagesz) p[i] = p[i];   // read-modify-write
}
```
A pure read loop maps the shared zero page and allocates nothing — the single most common pre-faulting bug. The `p[i] = p[i]` form works but relies on `volatile` to survive optimization; `MADV_POPULATE_WRITE` expresses the intent directly and is much faster because it stays in the kernel.

**Cost of getting it right, for a 4 GiB arena:**

| Approach | Startup cost | Steady-state faults |
|---|---|---|
| Nothing | 0 | ~1 M faults spread over the run, at the worst moments |
| Touch loop, 4 KiB pages | ~1.5 s | 0 |
| `MADV_POPULATE_WRITE`, 4 KiB | ~0.8 s | 0 |
| 2 MiB HugeTLB + populate | ~0.2 s | 0 |
| 1 GiB HugeTLB + populate | ~0.15 s | 0 |

The huge-page rows illustrate the point that fault *count* dominates: 4 GiB is 1,048,576 4 KiB faults or 2,048 2 MiB faults.

**The full startup sequence** for a latency-critical process, in order (each step depends on the previous):

```
1. Pin the thread to its core            (affinity first — determines the NUMA node)
2. Set NUMA policy / membind             (§32.26)
3. Reserve/attach huge pages             (§32.10)
4. Allocate all arenas, pools, queues    (Ch. 55 §55.1)
5. Pre-fault them (MADV_POPULATE_WRITE)  (this is where first-touch binds pages)
6. mlockall(MCL_CURRENT | MCL_FUTURE)    (§32.15)
7. Pre-fault the thread stack
8. Warm caches and branch predictors by running the hot path on synthetic data
9. Raise scheduling priority (SCHED_FIFO)  (last — so setup can't lock out the box)
```

Steps 1 and 5 must be in that order or first-touch puts the pages on the wrong node. Step 9 must be last (Ch. 31 §31.22).

---

## 32.17 Swapping

**Swapping** (more precisely on Linux, *paging*) writes anonymous pages to a swap device to free physical memory. File-backed clean pages don't need swap — they're just dropped (§32.12).

**Reclaim** is driven by `kswapd` (background, when free memory falls below the low watermark) or by **direct reclaim** (synchronous, in the allocating process's context, when free memory hits the min watermark). Direct reclaim is the latency killer: your `malloc` or page fault blocks while the kernel scans LRU lists, writes pages out, and possibly compacts.

```
watermarks (per zone, /proc/zoneinfo):
   high ──── kswapd stops
   low  ──── kswapd wakes (background, asynchronous)
   min  ──── DIRECT RECLAIM: the allocating thread does the work itself
```

Linux uses **active/inactive LRU lists** for anonymous and file pages separately, with a second-chance promotion based on the PTE Accessed bit. Multi-Gen LRU (MGLRU, 6.1+) replaces this with generational aging and is markedly better under pressure.

| Knob | Effect |
|---|---|
| `vm.swappiness` (0–200, default 60) | Relative preference for reclaiming anonymous vs file pages. **0 does not disable swap** — it means "only swap to avoid OOM". |
| `vm.min_free_kbytes` | The min watermark. Raising it makes `kswapd` start earlier, reducing direct-reclaim events. A standard low-latency tuning. |
| `vm.watermark_scale_factor` | Widens the gap between watermarks — same purpose, finer control. |
| `vm.vfs_cache_pressure` | How aggressively to reclaim dentry/inode caches |
| `vm.zone_reclaim_mode` | Whether to reclaim locally before allocating remotely on NUMA. **Default 0 is correct**; setting it to 1 causes pathological reclaim instead of harmless remote allocation. |

**Costs:** swap-out is asynchronous but competes for I/O; swap-in is a **major fault**, 30–150 µs on NVMe and 3–10 ms on spinning disk. On a `SCHED_FIFO` thread, that is a hard multi-millisecond stall at priority 99.

**The standard trading-host configuration is swap off entirely** (`swapoff -a`, no swap entry in `fstab`), plus `mlockall`, plus enough RAM. The tradeoff is explicit: with no swap, memory exhaustion means the OOM killer (§32.18) instead of a slow death. For a system where a 5 ms stall is worse than a restart, that is the right trade, and being able to state the trade-off is the answer the interviewer wants — not "swap is bad".

**`zswap`/`zram`** compress pages into RAM instead of writing to disk, turning a 10 ms fault into a ~10 µs decompression. Reasonable for general-purpose servers, still too unpredictable for a hot path.

**Diagnostics:** `vmstat 1`'s `si`/`so` columns (swap in/out, nonzero = trouble), `/proc/vmstat`'s `pgscan_direct`/`pgsteal_direct` (direct reclaim happening), `sar -B`, and `perf stat -e major-faults`.

---

## 32.18 Memory Overcommit and the OOM Killer

Linux by default lets processes allocate more virtual memory than exists, on the theory that most of it will never be touched (§32.5). `fork` of a large process, sparse arrays, and 8 MiB-per-thread stacks all depend on this.

```
/proc/sys/vm/overcommit_memory
  0 = heuristic (default): refuse "obviously" absurd single allocations, allow the rest
  1 = always overcommit: never refuse (what Redis and some databases want)
  2 = strict: total commit ≤ swap + overcommit_ratio% of RAM; allocations fail honestly
/proc/sys/vm/overcommit_ratio  = 50   (used only in mode 2)
/proc/meminfo: CommitLimit, Committed_AS
```

**Mode 2 is the only mode where `malloc` returning non-NULL means anything.** In modes 0 and 1, an allocation succeeds and the failure surfaces later, at an arbitrary page fault, as the OOM killer terminating a process. This is why "check the return of `malloc`" is necessary but not sufficient on Linux, and it's a good interview observation.

### The OOM killer

When physical memory plus swap is genuinely exhausted and reclaim fails, the kernel picks a victim:

```
badness score ≈ (RSS + swap + page-table size) normalized to 0–1000
              + oom_score_adj  (-1000 … +1000)
oom_score_adj = -1000  → completely immune
```
```bash
cat /proc/<pid>/oom_score /proc/<pid>/oom_score_adj
echo -1000 > /proc/<pid>/oom_score_adj          # protect the trading process
# systemd: OOMScoreAdjust=-1000
```

**The signature** is a kernel log entry — `Out of memory: Killed process 1234 (myapp) total-vm:..., anon-rss:...` — plus a task list dump. `dmesg -T | grep -i "killed process"` and `journalctl -k` are where you look. A process that "just disappeared" with no core dump and exit status reflecting `SIGKILL` is the classic presentation, and the reason it produces no core dump is that `SIGKILL` cannot be caught.

**Per-cgroup OOM** is the modern reality: cgroup v2's `memory.max` triggers a *cgroup-local* OOM kill when the group exceeds its limit, even with plenty of free memory system-wide. In containers this is what kills you. `memory.high` instead throttles (adds reclaim pressure and stalls the allocator) rather than killing — producing latency instead of death, which is sometimes worse. `memory.events`' `oom`, `oom_kill`, and `high` counters, plus **PSI** (`/proc/pressure/memory`, `memory.pressure`), are the diagnostics.

**For a trading system:** set `oom_score_adj=-1000` on the critical process, size memory so it never matters, disable swap, `mlockall`, and monitor `Committed_AS` versus `CommitLimit`. And note the corollary — if your process is immune, the OOM killer takes something *else*, possibly `sshd` or your monitoring agent, so protect the ability to log in too.

---

## 32.19 Heap Growth with `brk` and `mmap`

The C heap is not a kernel concept. It is a userspace data structure that acquires memory from the kernel through two mechanisms:

| | `brk`/`sbrk` | `mmap` |
|---|---|---|
| Shape | A single contiguous region that grows/shrinks at one end | Independent regions anywhere |
| Used by glibc `malloc` for | The **main arena**, small allocations | Requests ≥ `M_MMAP_THRESHOLD`, and **all non-main arenas** |
| Returning memory | Only by shrinking the top; a live allocation at the top blocks all of it | `munmap` any region independently |
| Syscall cost | ~1–2 µs | ~2–5 µs, plus shootdown on unmap |

glibc's `malloc` behaviour, which is what interviews actually probe:

| Knob | Default | Meaning |
|---|---|---|
| `M_MMAP_THRESHOLD` | 128 KiB, **dynamically adjusted upward** when `mmap`ed blocks are freed | Above this, `malloc` uses `mmap` directly |
| `M_TRIM_THRESHOLD` | 128 KiB, also dynamic | Free space at the top of the heap above this is returned via `brk` |
| `M_ARENA_MAX` | 8 × ncores | Number of per-thread arenas (each a 64 MiB `mmap` region) |
| `mallopt(M_MMAP_THRESHOLD, x)` / `MALLOC_TRIM_THRESHOLD_=-1` | | Disable the dynamic behaviour |

**The classic pathology:** an allocation pattern that repeatedly crosses `M_TRIM_THRESHOLD` makes `malloc` call `brk` to return memory and then immediately `brk` again to get it back — syscalls *and* page faults *and* TLB shootdowns on every cycle, invisible in the source code. Fix: `mallopt(M_TRIM_THRESHOLD, -1)` and `mallopt(M_MMAP_THRESHOLD, very_large)`, so the heap only ever grows.

**The multithreaded pathology:** glibc creates up to `8 × ncores` arenas to reduce lock contention, each reserving 64 MiB of address space. On a 64-core box that's 512 arenas and tens of gigabytes of VSZ, with real RSS growth from per-arena fragmentation. `MALLOC_ARENA_MAX=2` is a standard container tuning.

**For low latency the answer is simpler:** don't allocate on the hot path at all (Ch. 8 §8.8, Ch. 55 §55.1). Preallocate arenas and pools at startup, use a monotonic or pool `memory_resource` (Ch. 8 §8.6–§8.7), and configure the general allocator to never return memory. If you do need a general allocator, **jemalloc** or **tcmalloc** are markedly better than glibc for tail latency: per-thread caches, `MADV_FREE` instead of `MADV_DONTNEED`, and no `brk` trimming.

`strace -e trace=brk,mmap,munmap,madvise` on a running process is the direct way to see whether your allocator is talking to the kernel on the hot path — and the answer should be "not at all after startup".

---

## 32.20 Address-Space Layout Randomization

**ASLR** randomizes the base addresses of the stack, heap, mmap region, and (for PIE binaries) the executable itself, so that an attacker who can corrupt memory cannot predict where anything is.

```
/proc/sys/kernel/randomize_va_space
  0 = off
  1 = randomize stack + mmap base + VDSO
  2 = also randomize the brk heap  (default)
```

Entropy on x86-64: ~28 bits for the mmap base, ~30 for the stack, 28 for the PIE executable base — all at page granularity, and all *per-process*, chosen at `exec`.

| Consequence | Detail |
|---|---|
| PIE binaries need position-independent code | Access to globals goes through the GOT or RIP-relative addressing; ~0–3% overhead on x86-64 (RIP-relative is cheap), higher on 32-bit x86 where a register is burned |
| Addresses differ between runs | Reproducing a crash needs `setarch -R` or `ASLR=0` |
| Benchmarks become noisy | Different alignment of stack and heap changes cache-set conflicts and 4 KiB aliasing — **runs can differ by 5–10% for no other reason** |
| `fork`ed children share the parent's layout | Randomization happens at `exec`, not `fork` — which is why `fork`-only servers are weaker against brute-force attacks |
| Shared memory | Two processes map the same segment at *different* addresses; pointers stored inside are invalid (Ch. 3 §3.12) |

**The benchmarking point deserves emphasis.** Stabilizing measurements often requires `setarch $(uname -m) -R ./bench` (disables ASLR for that process) and controlling environment-variable size, because the environment block sits on the stack and shifts every subsequent alignment. This is a documented cause of "mysterious 8% regression on an unrelated commit" and is the kind of detail that distinguishes people who have actually chased benchmark noise (Ch. 43 §43.8).

**`MAP_FIXED` vs `MAP_FIXED_NOREPLACE`.** `MAP_FIXED` silently unmaps anything already at the target address — a genuine footgun that can destroy your own heap. `MAP_FIXED_NOREPLACE` (4.17+) fails with `EEXIST` instead. Use the latter always. Mapping shared memory at a fixed address in both processes (so raw pointers work) requires disabling ASLR or reserving the range early, and is fragile enough that offset-based addressing is the better answer.

For a trading host, ASLR is usually left on — the cost is nil and disabling it buys nothing measurable except benchmark stability, which you can get per-process with `setarch -R`.

---

## 32.21 Stack Growth and Guard Pages

The **main thread's** stack is special: it is created as a small VMA marked `VM_GROWSDOWN` and **grows automatically**. A fault below the current stack VMA, within `RLIMIT_STACK` of its base, is treated as a request to extend rather than as a segfault.

```
fault address A, below the stack VMA:
   is A >= sp - 65536?            (heuristic: allow for push/enter/red zone)
   is (stack_top - A) <= RLIMIT_STACK?
   is there a stack_guard_gap (1 MiB) of free space below?
      yes → extend the VMA, allocate a page, continue
      no  → SIGSEGV
```

**Non-main thread stacks do not grow.** They are ordinary fixed-size `mmap`s allocated by pthreads (Ch. 31 §31.11). Overflow hits a guard page and raises `SIGSEGV`, full stop.

| | Main thread | pthread |
|---|---|---|
| Initial size | One page, grows on demand | Full `RLIMIT_STACK` (8 MiB) mapped up front, demand-paged |
| Maximum | `RLIMIT_STACK` (`ulimit -s`) | Fixed at creation |
| Guard | `stack_guard_gap` = 256 pages (1 MiB) below | `guardsize` = 1 page (configurable) |
| Growth mechanism | Kernel `VM_GROWSDOWN` handling | None |

**Stack Clash.** The 1 MiB `stack_guard_gap` (introduced in 2017 for CVE-2017-1000364) exists because a single-page guard is defeatable: a function with a large frame moves `%rsp` past the guard in one instruction and writes into whatever is beyond. The compiler-side fix is **`-fstack-clash-protection`**, which emits a probe (one touch per page) as the frame is allocated, guaranteeing the guard is hit. It costs essentially nothing in steady state and should be on for any code with variable-length arrays or large locals.

**Handling stack overflow.** By default `SIGSEGV` from stack overflow cannot be handled, because the handler itself needs stack. The fix is an **alternate signal stack**:

```c
static char altstack[SIGSTKSZ];
stack_t ss{ .ss_sp = altstack, .ss_flags = 0, .ss_size = sizeof altstack };
sigaltstack(&ss, nullptr);
struct sigaction sa{};
sa.sa_flags = SA_SIGINFO | SA_ONSTACK;      // SA_ONSTACK is the point
sa.sa_sigaction = handler;
sigaction(SIGSEGV, &sa, nullptr);
```
Without `SA_ONSTACK` the handler faults immediately and the process dies with no diagnostic. This is a requirement for any crash handler that wants to report stack overflows (Ch. 33 §33.16, Ch. 58 §58.13).

**Latency angle:** each new stack page is a minor fault. A deep call chain entered for the first time under load produces a burst of them. Pre-fault the stack at startup (§32.16) — an `alloca` of the expected depth plus a write loop, or simply `mlockall(MCL_CURRENT)` after touching it.

---

## 32.22 Page Cache

The **page cache** holds file contents in memory, keyed by (inode, offset). Every `read`, `write`, and file `mmap` goes through it (except `O_DIRECT`, §32.12 / Ch. 34 §34.16).

```
read(fd, buf, n):
   page cache hit  → memcpy to userspace          ~0.5–1 µs per 4 KiB
   page cache miss → block I/O, then memcpy       30 µs (NVMe) – 10 ms (HDD)

write(fd, buf, n):
   copy into page cache, mark the page DIRTY, return   ← NOT durable
   writeback later by kworker/flush threads
```

**Writes are asynchronous by default.** `write()` returning success means the data is in the page cache, not on the device. Durability requires `fsync`/`fdatasync` (§32.29). This is the source of endless confusion and of real data-loss bugs in journaling code (Ch. 56 §56.1).

Writeback tuning (`/proc/sys/vm/`):

| Knob | Default | Meaning |
|---|---|---|
| `dirty_background_ratio` | 10% | Background writeback starts when this fraction of available memory is dirty |
| `dirty_ratio` | 20% | **Writers are throttled/blocked** at this point — a synchronous stall in `write()` |
| `dirty_expire_centisecs` | 3000 (30 s) | Age at which a dirty page must be written |
| `dirty_writeback_centisecs` | 500 (5 s) | How often the flusher wakes |
| `dirty_bytes` / `dirty_background_bytes` | — | Absolute alternatives to the ratios; **preferred on large-RAM machines**, where 20% of 512 GiB is 100 GiB of dirty data and the eventual flush is catastrophic |

**The latency failure mode:** a process writes a log or journal steadily; dirty pages accumulate; at `dirty_ratio` the kernel throttles the writer *inside* `write()` for however long it takes to push data to disk — hundreds of milliseconds. On a trading host, setting `vm.dirty_bytes` to something small (e.g. 64–256 MiB) converts one huge stall into many tiny ones. `/proc/meminfo`'s `Dirty` and `Writeback` fields track it.

**Readahead** (`/sys/block/*/queue/read_ahead_kb`, default 128 KiB) prefetches sequential file data. `posix_fadvise(POSIX_FADV_SEQUENTIAL|WILLNEED|DONTNEED|RANDOM)` controls it per-fd; `MADV_RANDOM` does the same for mappings.

**Dropping the cache** (`echo 3 > /proc/sys/vm/drop_caches`) is a benchmarking tool only — it evicts everything including your binary's text pages, causing a burst of major faults.

**Why `Cached` being large is fine:** the page cache is reclaimable. `free -h`'s "available" column, not "free", is the number that matters — a healthy Linux box has almost no free memory because the cache uses it all.

---

## 32.23 Working Sets

The **working set** W(t, τ) is the set of pages a process referenced in the interval [t−τ, t]. It is the amount of memory the process actually needs resident to run without thrashing.

Why it's the organizing concept:

- If the working set fits in a cache level, performance is that level's latency. Crossing a boundary produces a **discontinuity**, not a gradual degradation (Ch. 30 §30.1).
- If the working set exceeds physical memory, the system **thrashes**: every access faults, evicting a page that is about to be needed. Throughput collapses by orders of magnitude.
- If the working set exceeds **TLB reach** (§32.7 — 6 MiB with 4 KiB pages), you pay a page walk on most accesses even though the data is in cache.

| Working set | Dominant cost |
|---|---|
| ≤ 32 KiB | L1, ~1.3 ns |
| ≤ 1–2 MiB | L2, ~4 ns |
| ≤ **6 MiB** | L3, ~20 ns — **but TLB reach ends here at 4 KiB pages** |
| ≤ 32–128 MiB | L3 + page walks, ~20–40 ns |
| ≤ RAM | DRAM + page walks, 80–250 ns |
| > RAM | Major faults, 30 µs–10 ms — collapse |

**Measuring it:**

```bash
/proc/<pid>/clear_refs                    # echo 1: clear the Accessed bits, then wait, then read smaps
/proc/<pid>/smaps                         # Referenced: field = pages touched since the last clear
/proc/<pid>/smaps_rollup                  # aggregated, much cheaper to read
perf mem record / perf c2c                # address-level sampling
valgrind --tool=cachegrind                # simulated, exact, ~50× slowdown
perf stat -e cache-references,cache-misses,dTLB-load-misses
```
The `clear_refs`/`Referenced` technique is the canonical way to measure a real working set on Linux, and knowing it is a differentiator.

**Design consequences for low latency**, which is where this section earns its place:

- **Shrink the hot structure until it fits a level.** An order book that fits in L2 behaves completely differently from one that doesn't. Ch. 3 §3.4's member reordering and Ch. 42 §42.2's SoA layout are both working-set reductions.
- **Separate hot from cold fields.** A 200-byte struct where only 16 bytes are hot wastes 92% of every cache line fetched; splitting it can cut the working set by 10×.
- **Prefer indices to pointers** — 4-byte indices instead of 8-byte pointers halves the size of link-heavy structures and improves TLB behaviour.
- **Bound growth.** A hash table that grows without limit will eventually cross a boundary in production and produce a step-change in latency that no code change explains.

---

## 32.24 RSS, VSZ and PSS

The four memory numbers, and what each actually means:

| Metric | Definition | Where |
|---|---|---|
| **VSZ / `VmSize`** | Total virtual address space mapped. Includes untouched, `PROT_NONE`, and file mappings never read. | `ps`, `/proc/<pid>/status` |
| **RSS / `VmRSS`** | Physical pages currently mapped by this process, **counting shared pages in full for every sharer**. | `ps`, `top`, `/proc/<pid>/status` |
| **PSS** | Proportional Set Size: private pages + (each shared page ÷ number of sharers). **The only metric that sums correctly across processes.** | `/proc/<pid>/smaps`, `smaps_rollup` |
| **USS** | Unique Set Size: private pages only. What you'd reclaim by killing the process. | `smem`, computed from `smaps` |

```
Process A and B each map libc (2 MiB) and have 10 MiB private:
   RSS(A) = RSS(B) = 12 MiB   →  sum = 24 MiB   (but only 22 MiB is in use)
   PSS(A) = PSS(B) = 11 MiB   →  sum = 22 MiB   ✓
   USS(A) = USS(B) = 10 MiB
```

**VSZ is nearly meaningless on 64-bit.** A process with 1 TiB of VSZ may be using 100 MiB — thread stacks (8 MiB each), glibc arenas (64 MiB each), guard regions, and reserved-but-untouched arenas all inflate it. Alerting on VSZ produces false positives forever. The exceptions where VSZ matters: 32-bit processes (address space is the scarce resource), `RLIMIT_AS` enforcement, and strict overcommit mode (§32.18).

**RSS overcounts shared memory** and — the subtle one — **does not decrease when you `free()`**, because the allocator keeps the pages (§32.19). It also stays high after `MADV_FREE` (§32.14). Both produce phantom "memory leak" reports.

`/proc/<pid>/status` breakdown worth knowing:

```
VmPeak / VmSize        peak / current virtual
VmHWM  / VmRSS         peak / current resident
RssAnon / RssFile / RssShmem     ← the decomposition that actually diagnoses things
VmData / VmStk / VmExe / VmLib   ← by segment type
VmPTE                  ← page-table memory (§32.3)
VmSwap                 ← swapped-out anonymous
VmLck                  ← mlocked (§32.15)
HugetlbPages           ← explicit huge pages (§32.10)
```

`RssAnon` growing steadily is a real leak; `RssFile` growing is page cache being mapped; `RssShmem` is shared segments. For containers, cgroup v2's `memory.current` and `memory.stat` are authoritative — they count the page cache attributable to the group, which is why a container gets OOM-killed while `RSS` looks fine.

Tools: `smem -k -P myapp` (PSS/USS), `pmap -X <pid>`, `ps_mem`, and `/proc/<pid>/smaps_rollup` (cheap; reading full `smaps` on a process with 100,000 mappings takes seconds and holds `mmap_lock`).

---

## 32.25 Procfs Memory Maps

`/proc/<pid>/maps` — one line per VMA:

```
address                   perms offset   dev   inode      pathname
55a3e2c00000-55a3e2c01000 r--p 00000000 08:02 1573      /opt/app/trader
55a3e2c01000-55a3e2d40000 r-xp 00001000 08:02 1573      /opt/app/trader
55a3e2d40000-55a3e2d80000 r--p 00140000 08:02 1573      /opt/app/trader
55a3e2d81000-55a3e2d84000 rw-p 00180000 08:02 1573      /opt/app/trader
55a3e4a00000-55a3e5000000 rw-p 00000000 00:00 0         [heap]
7f2c00000000-7f2c40000000 rw-p 00000000 00:00 0                       ← anonymous arena
7f2c80000000-7f2c80021000 rw-s 00000000 00:0e 12345     /dev/hugepages/ring
7f2cb1a00000-7f2cb1a01000 ---p 00000000 00:00 0                       ← guard page
7f2cb1a01000-7f2cb2201000 rw-p 00000000 00:00 0                       ← thread stack (8 MiB)
7ffd4c3e0000-7ffd4c401000 rw-p 00000000 00:00 0         [stack]
7ffd4c4d3000-7ffd4c4d7000 r--p 00000000 00:00 0         [vvar]
7ffd4c4d7000-7ffd4c4d9000 r-xp 00000000 00:00 0         [vdso]
```

Perms are `rwxp`/`rwxs` — the fourth character is **p**rivate (COW) or **s**hared (§32.13). Reading this is a genuine skill:

| Pattern | Meaning |
|---|---|
| Four consecutive mappings of the same file with `r--p`, `r-xp`, `r--p`, `rw-p` | A modern binary or `.so` with separate RELRO segments |
| `---p` immediately below an 8 MiB `rw-p` | A thread stack and its guard page |
| Many 64 MiB `rw-p` anonymous regions | glibc per-thread malloc arenas (§32.19) |
| `rw-s` with a `/dev/hugepages` or `/dev/shm` path | Explicit huge pages or POSIX shm |
| `[vdso]`/`[vvar]` | The vDSO — how `clock_gettime` avoids a syscall (Ch. 34 §34.4) |
| Thousands of tiny mappings | `mmap` fragmentation; each costs a VMA and slows every fault (VMA lookup) and `fork` |

`/proc/<pid>/smaps` adds per-VMA detail — the fields that matter:

```
Size, Rss, Pss, Shared_Clean/Dirty, Private_Clean/Dirty,
Referenced      ← working-set measurement (§32.23)
Anonymous, LazyFree (MADV_FREE), AnonHugePages, ShmemPmdMapped,
Locked          ← mlock verification (§32.15)
THPeligible
VmFlags: rd wr mr mw me dw sd ...   ← includes ht (hugetlb), lo (locked), nr (no-reserve), dd (dontdump)
```

Related files worth naming: `/proc/<pid>/pagemap` (virtual→physical PFN mapping, root-only since 4.0 — used to verify huge-page and NUMA placement), `/proc/<pid>/numa_maps` (per-VMA NUMA node distribution — the direct way to verify first-touch worked), `/proc/<pid>/clear_refs` (§32.23), and `/proc/<pid>/smaps_rollup` (aggregate, cheap).

**Operational caution:** reading full `smaps` takes `mmap_lock` for read across every VMA. On a process with a large map count this can take tens of milliseconds and blocks concurrent `mmap`/`munmap` — a monitoring agent polling `smaps` every second has caused production latency incidents. Use `smaps_rollup`.

---

## 32.26 NUMA Memory Policies

On a NUMA system (Ch. 29 §29.17) physical memory is partitioned per node, and access to a remote node costs 1.4–2× (Ch. 30 §30.1). Which node a page lands on is determined by the **NUMA policy** in effect *at the moment of first touch*.

**First-touch** is the default (`MPOL_DEFAULT` → allocate on the node of the faulting CPU). Not the node of the `malloc` caller — the node of the CPU that first *writes* the page. This is the single most important fact in the section:

```cpp
char* buf = (char*)malloc(1UL<<30);    // no physical pages yet — no node assigned
// ... threads are created and pinned ...
// whichever thread touches a page first owns it, forever
```
The classic bug: the main thread `memset`s a large buffer at startup, so every page lands on node 0, and then eight worker threads pinned across two sockets all read remotely. The fix is to have each worker pre-fault its own slice (§32.16) *after* being pinned.

| Policy | Effect | Set by |
|---|---|---|
| `MPOL_DEFAULT` | First touch, local node | Default |
| `MPOL_BIND` | Allocate strictly from a node set; **OOM rather than go remote** | `numactl --membind`, `mbind()` |
| `MPOL_PREFERRED` | Prefer a node, fall back silently | `numactl --preferred` |
| `MPOL_INTERLEAVE` | Round-robin pages across nodes — trades latency for aggregate bandwidth | `numactl --interleave=all` |
| `MPOL_PREFERRED_MANY` (5.15+) | Prefer a set, fall back | `set_mempolicy` |

```bash
numactl --hardware                         # nodes, memory per node, distance matrix
numactl --cpunodebind=0 --membind=0 ./app  # the standard invocation
numastat -p <pid>                          # per-node allocation for a process
cat /proc/<pid>/numa_maps                  # per-VMA node distribution — verify first touch
migratepages <pid> 1 0                     # move pages between nodes (expensive)
perf c2c record/report                     # remote HITM attribution
perf stat -e node-loads,node-load-misses,offcore_response.*.remote_dram.*
```

**`--membind` vs `--preferred`.** `--membind` is honest: if node 0 is full you get an allocation failure or an OOM kill rather than silent remote memory and a 2× latency regression you'll spend a week finding. For a trading process, that failure is preferable. `--interleave=all` is right only for bandwidth-bound analytics that touch everything uniformly.

**The full NUMA discipline** for a hot path: pin the thread (Ch. 31 §31.17), bind memory to that thread's node, allocate and first-touch from that thread, put the NIC's queues and DMA buffers on the node the NIC is physically attached to (`/sys/class/net/eth0/device/numa_node`), and verify with `numa_maps` and `numastat` rather than assuming.

---

## 32.27 Automatic NUMA Balancing

`kernel.numa_balancing` (on by default on most distributions) tries to fix bad placement automatically. It works by **deliberately breaking translations**:

```
1. Periodically, unmap or mark PROT_NONE a sample of a task's pages ("NUMA hinting")
2. The next access faults — a NUMA hint fault
3. The handler records which node accessed the page
4. If a page is consistently accessed from a remote node, MIGRATE it
5. It may also migrate the TASK toward its memory
```

**Every step costs you.** Deliberate faults (0.5–2 µs each) on pages that were working perfectly; page migrations that copy 4 KiB and require TLB shootdowns (§32.9); and task migrations that discard your cache and, if you weren't pinned, your careful placement.

| Counter (`/proc/vmstat`) | Meaning |
|---|---|
| `numa_hint_faults` | Deliberate faults taken |
| `numa_hint_faults_local` | Of which were already local (pure waste) |
| `numa_pages_migrated` | Pages actually moved |
| `numa_pte_updates` | PTEs marked for hinting |
| `pgmigrate_success` / `pgmigrate_fail` | Migration outcomes |

Tunables: `kernel.numa_balancing_scan_period_min_ms` / `_max_ms`, `_scan_size_mb`.

**For a pinned, membound, pre-faulted process, automatic NUMA balancing is pure overhead** — the placement is already optimal, so every hinting fault is wasted work and every migration is a mistake. Disable it:

```bash
echo 0 > /proc/sys/kernel/numa_balancing        # or kernel.numa_balancing=0 in sysctl.conf
```

It genuinely helps the case it was designed for: unpinned, long-running, general-purpose workloads whose access patterns the operator hasn't analyzed. That is precisely the opposite of a trading hot path.

**The diagnostic signature** is instructive and worth being able to describe: sporadic microsecond-scale stalls with no context switch, no syscall, and no *application* page fault — because the fault is a NUMA hint fault, invisible to anything that only counts `majflt`, and it shows up only in `numa_hint_faults` and as an unexplained gap in a timestamp trace. Together with TLB shootdowns (§32.9) and SMIs (Ch. 31 §31.19), it's one of the three "impossible" stall sources on an isolated core.

---

## 32.28 Shared-Memory Truncation and `SIGBUS`

`SIGSEGV` means "no valid mapping or wrong permissions". **`SIGBUS` means "valid mapping, but the backing store cannot supply the page."** For file and shared-memory mappings, that distinction has real operational consequences.

**The truncation race:**

```cpp
int fd = shm_open("/ring", O_CREAT|O_RDWR, 0600);
ftruncate(fd, 1<<20);
char* p = (char*)mmap(nullptr, 1<<20, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
// another process (or a restart of the writer): ftruncate(fd, 0);
p[0] = 1;    // ← SIGBUS. The mapping is still valid; the pages are gone.
```

The mapping survives truncation — `munmap` is not implied — but any page beyond the new end-of-file faults with `SIGBUS` on access. In a trading system this is the classic **shared-memory restart bug**: the writer restarts, recreates and re-sizes its segment, and every reader still holding the old mapping dies with `SIGBUS` at an arbitrary instruction.

Other `SIGBUS` sources on mapped memory:

| Cause | Detail |
|---|---|
| Access beyond EOF in a file mapping | Including the partial last page beyond the file's true length |
| Truncation after mapping | As above |
| I/O error on a file-backed page (bad sector, network filesystem failure) | The read fails at fault time |
| Hardware memory error (uncorrectable ECC) | The kernel poisons the page; touching it gives `SIGBUS` with `BUS_MCEERR_AR` |
| hugetlbfs page-pool exhaustion at fault time | The reservation wasn't made |
| Filesystem full, for a sparse `MAP_SHARED` file mapping | The block allocation fails at writeback/fault |
| Misaligned access on strict-alignment architectures | SPARC and some ARM configurations (Ch. 3 §3.3) |

**Defences, in order of preference:**

1. **`memfd_create` + `F_SEAL_SHRINK` / `F_SEAL_GROW`** (§32.13). Sealing makes truncation *impossible*, eliminating the failure class rather than handling it. This is the correct modern answer.
2. **Never resize a live segment.** Size it once at creation, version the name (`/ring.v7`), and have readers switch to a new segment rather than mutate the old one.
3. **`fallocate(fd, 0, 0, size)`** rather than `ftruncate` for file-backed shared mappings, so blocks are actually allocated and you can't get `SIGBUS` from a full filesystem at fault time.
4. **`MAP_POPULATE` + `mlock`**, which forces the faults up front where they're an `mmap` error instead of a signal.
5. **A `SIGBUS` handler on an alternate signal stack** (§32.21) that logs and exits cleanly. `siginfo->si_addr` gives the faulting address and `si_code` distinguishes `BUS_ADRERR` (no backing) from `BUS_MCEERR_AR` (hardware error). Handling and *continuing* is very hard to do correctly — treat it as a crash-with-diagnostics path (Ch. 33 §33.16).

`SIGSEGV` vs `SIGBUS` as an interview question: **`SIGSEGV` = the address is wrong; `SIGBUS` = the address is right but the memory behind it isn't there.** Being able to give the truncation example immediately is the giveaway that you've operated shared memory in production.

---

## 32.29 Durable versus Visible Mapped Writes

A store to a `MAP_SHARED` mapping becomes **visible** to other processes immediately — the page is in the page cache and both parties' PTEs point at the same physical frame, so ordinary cache coherence handles it. It becomes **durable** only when written to the device. Conflating the two is the source of real data-loss bugs in journals and write-ahead logs (Ch. 56 §56.1).

```
store to MAP_SHARED page
   │  visible to other mappers of the same file: IMMEDIATELY (cache coherence)
   │  survives a process crash:                  YES (the page cache outlives the process)
   │  survives a KERNEL PANIC or power loss:     NO — until writeback + fsync
   ▼
msync(MS_SYNC) / fsync(fd) ──▶ writeback to the device
   │  survives power loss:  only if the device honoured the FLUSH/FUA
```

| Operation | Guarantees |
|---|---|
| `write()` returns | In page cache. Visible to readers of the file. **Not durable.** |
| Store to `MAP_SHARED` | In page cache. Visible. **Not durable.** No syscall was involved, so the kernel doesn't even know yet — it learns from the PTE dirty bit. |
| `msync(MS_ASYNC)` | Schedules writeback. **Returns before completion.** Nearly useless as a durability primitive. |
| `msync(MS_SYNC)` | Blocks until the mapped pages are written back. Does *not* necessarily flush file **metadata**. |
| `fdatasync(fd)` | Data + metadata needed to read the data (i.e. size). Cheaper than `fsync`. |
| `fsync(fd)` | Data + all metadata. |
| `fsync` on the **parent directory** | Required for a newly *created* file's directory entry to be durable — the step everyone forgets |
| `O_DIRECT` | Bypasses the page cache; still needs `fsync` unless combined with `O_DSYNC` |
| `O_DSYNC` / `O_SYNC` | Every write is synchronous — simple, and slow |

**Costs:** `fsync` on NVMe is 20–200 µs; on a SATA SSD 0.5–5 ms; on a spinning disk 5–20 ms; and on a filesystem with a shared journal (ext4 `data=ordered`) an `fsync` from one file can block on unrelated writeback, making the tail far worse than the mean. **`fsync` on the hot path is never acceptable** — the standard architecture is an append-only journal written by a *separate* thread or process from a lock-free queue, with the hot path never touching a descriptor (Ch. 56 §56.1, Ch. 59 §59.6).

**The ordering trap.** The page cache gives no ordering between separate pages, so a crash can leave a torn record: page 2 of a journal entry written, page 1 not. Durability requires either (a) writing a checksum over the record and validating on replay, (b) a two-phase commit with an `fsync` between data and commit-marker, or (c) ensuring each record fits within an atomically-written unit — and note that only a 512-byte sector is atomic on most devices, **not** 4 KiB, unless the device advertises atomic writes.

**Persistent memory** changes the primitives, and is worth a sentence: with DAX, stores go straight to the media and durability requires cache-line flushes (`CLWB`) plus `SFENCE`, not `msync` — this is the `pmem_persist` model. The C++-visible consequence is that the "visible vs durable" distinction moves from a syscall boundary to a cache-flush boundary, and `std::atomic` gives you the first but never the second.

**The one-line summary to have ready:** *visibility is free and immediate through cache coherence; durability costs a device round-trip and must be requested explicitly, and neither `write()` returning nor a store completing tells you anything about it.*

---

## Key Interview Questions

1. **Why are page tables multi-level?** — A flat 48-bit/4 KiB table would need 512 GiB per process; a radix tree materializes only the levels actually used, costing ~2 MiB of page tables per GiB mapped.
2. **What happens on a page fault, step by step?** — VMA lookup → permission check → classify (anonymous first touch / page-cache hit / disk read / swap / COW) → allocate and zero or read → install PTE → return. 0.5–2 µs minor, 30 µs–10 ms major.
3. **Minor vs major fault?** — Minor needs no I/O (allocate/zero, page-cache hit, COW); major requires reading from disk or swap. The 100× cost difference is what matters.
4. **Why doesn't RSS grow when I read a fresh anonymous mapping?** — Reads map the shared read-only zero page; only a write allocates. This is why pre-faulting must write.
5. **What does `mmap` of 1 GiB actually cost?** — About 5 µs and zero physical memory; touching it costs ~262,000 faults ≈ 400 ms.
6. **How does copy-on-write work, and when is no copy needed?** — Both PTEs marked read-only over a shared frame; a write faults and copies. If the refcount has dropped to 1 the kernel just re-enables write ("reuse") with no copy.
7. **What is TLB reach and why does it drive huge-page decisions?** — Entries × page size: ~6 MiB with 4 KiB pages (smaller than L3!), ~3 GiB with 2 MiB pages. Beyond reach you pay a page walk on most accesses.
8. **How expensive is a page walk?** — Up to 4 dependent loads: ~20–40 cycles warm, 100–200 ns if the page tables are in DRAM, and up to 24 accesses under nested paging in a VM.
9. **What is a TLB shootdown and why does it hurt?** — TLBs aren't coherent, so changing a PTE requires IPIs to every CPU that has run this `mm`, and the initiator busy-waits for all acknowledgements: 2–5 µs at two cores, 10–50 µs at sixty-four. Triggered by `munmap`, `mprotect`, `madvise(DONTNEED)`, reclaim, THP collapse, and NUMA migration.
10. **How can a fully isolated core still stall?** — TLB-shootdown IPIs, NUMA-balancing hint faults, and firmware SMIs — none of which appear as context switches or application page faults.
11. **HugeTLB vs THP?** — Both raise TLB reach; HugeTLB is pre-reserved, never split, never reclaimed, deterministic. THP is automatic and can cause synchronous compaction stalls of 10–500 ms plus `khugepaged` interference. Use explicit pages and `transparent_hugepage=never`.
12. **Why do Redis, MongoDB, and every HFT shop disable THP?** — Synchronous compaction on fault, `khugepaged` collapse work with shootdowns, 2 MiB COW copies, and RSS bloat.
13. **Anonymous vs file-backed pages under memory pressure?** — Clean file pages are simply dropped (the file still has them); anonymous pages must be swapped, and without swap cannot be reclaimed at all — hence straight to the OOM killer.
14. **`MADV_DONTNEED` vs `MADV_FREE`?** — `DONTNEED` discards immediately (anonymous pages read back as zero) and forces a shootdown; `FREE` marks pages reclaimable lazily, is cheaper, keeps RSS high, and contents may or may not survive.
15. **What does `mlockall` actually buy you?** — Faults everything in and prevents reclaim, so no major faults — including on your binary's text pages, which can otherwise be evicted and re-read. Needs `RLIMIT_MEMLOCK` raised.
16. **How do you correctly pre-fault a buffer?** — `madvise(MADV_POPULATE_WRITE)`, `MAP_POPULATE`, or `mlockall(MCL_CURRENT)`; a manual loop must **write**, not read.
17. **What is memory overcommit and what does `malloc` returning non-NULL mean?** — In default mode, almost nothing: the pages don't exist until touched, and failure surfaces later as an OOM kill. Only `overcommit_memory=2` makes the return value meaningful.
18. **How does the OOM killer choose?** — A badness score from RSS + swap + page tables, adjusted by `oom_score_adj` (−1000 = immune). Under cgroup v2 the kill is group-local at `memory.max`.
19. **How does glibc `malloc` get memory from the kernel, and what goes wrong?** — `brk` for the main arena, `mmap` above `M_MMAP_THRESHOLD` and for per-thread arenas; the pathologies are trim/grow thrashing at `M_TRIM_THRESHOLD` and `8 × ncores` 64 MiB arenas.
20. **Why can ASLR make a benchmark 5–10% noisy?** — Different stack/heap alignment changes cache-set conflicts and 4 KiB aliasing; stabilize with `setarch -R`.
21. **Why isn't a guard page enough to stop stack overflow?** — A large frame can move `%rsp` past it in one instruction; you need `-fstack-clash-protection` probes, plus `stack_guard_gap`.
22. **How do you handle `SIGSEGV` from stack overflow?** — `sigaltstack` plus `SA_ONSTACK`, otherwise the handler faults immediately.
23. **Does `write()` returning mean the data is on disk?** — No; it's in the page cache. Durability needs `fdatasync`/`fsync`, plus `fsync` of the parent directory for newly created files.
24. **`SIGSEGV` vs `SIGBUS`?** — Wrong address vs valid mapping with no backing page — classically, `ftruncate` of a shared-memory segment that another process still has mapped. Prevent with `memfd_create` + `F_SEAL_SHRINK`.
25. **What is first-touch and what's the classic bug?** — A page is placed on the NUMA node of the CPU that first writes it; the bug is the main thread `memset`ting a buffer before workers are pinned, putting everything on node 0.
26. **Why disable automatic NUMA balancing on a tuned system?** — It works by deliberately unmapping pages to sample access patterns; on an already-optimally-placed process, every hint fault and migration is pure overhead.
27. **RSS vs PSS vs VSZ?** — RSS counts shared pages fully for each sharer; PSS divides them and is the only metric that sums correctly; VSZ is address space and is nearly meaningless on 64-bit.
28. **How do you measure a working set?** — `echo 1 > /proc/<pid>/clear_refs`, wait, then read `Referenced:` from `smaps`; or cachegrind for exactness; or `perf stat` TLB and cache counters for the symptom.
29. **Why should a monitoring agent not poll `/proc/<pid>/smaps`?** — It takes `mmap_lock` across every VMA and can block concurrent `mmap`/`munmap` for tens of milliseconds; use `smaps_rollup`.

---

## Common Traps

- **Pre-faulting with a read loop** — reads map the shared zero page and allocate nothing.
- **Assuming `malloc` success means memory exists.** Overcommit defers the failure to an arbitrary fault, delivered as an OOM kill.
- **`munmap`, `mprotect`, or `madvise(MADV_DONTNEED)` on the hot path** — every one triggers a TLB-shootdown IPI storm proportional to your thread count.
- **Using `MADV_DONTNEED` on live data** — on Linux it *discards*; the data reads back as zeroes.
- **Being surprised that RSS doesn't drop after `free()`** — the allocator keeps the pages, and `MADV_FREE` keeps them until pressure.
- **Alerting on VSZ.** Thread stacks, glibc arenas, and reserved arenas inflate it arbitrarily.
- **Summing RSS across processes** — shared pages are counted repeatedly; use PSS.
- **Leaving THP at `always`** and then chasing 100 ms tail spikes (`compact_stall` in `/proc/vmstat`).
- **Enabling THP for a `fork`-heavy process** — COW copies 2 MiB per touched page.
- **Forgetting `RLIMIT_MEMLOCK`** — `mlockall` fails silently if you don't check its return value.
- **`mlockall` without `MADV_NOHUGEPAGE`** — `khugepaged` can still collapse and shoot down.
- **Touching a large buffer from the main thread before pinning workers** — first-touch binds every page to one NUMA node.
- **Using `numactl --preferred` when you meant `--membind`** — silent remote fallback is a 2× regression you'll never notice.
- **Leaving `kernel.numa_balancing` on** for a pinned, pre-faulted process.
- **Setting `vm.zone_reclaim_mode=1`** — causes aggressive local reclaim instead of harmless remote allocation.
- **Assuming `vm.swappiness=0` disables swap.** It doesn't; only `swapoff` does.
- **Leaving `vm.dirty_ratio` at 20% on a large-RAM box** — a writer eventually blocks inside `write()` for hundreds of milliseconds. Use `vm.dirty_bytes`.
- **`MAP_FIXED` instead of `MAP_FIXED_NOREPLACE`** — silently unmaps whatever was there.
- **`ftruncate`ing a live shared-memory segment** — every other mapper gets `SIGBUS`. Use `memfd_create` with `F_SEAL_SHRINK`.
- **`msync(MS_ASYNC)` as a durability primitive** — it returns before anything is written.
- **Forgetting to `fsync` the parent directory** after creating a file.
- **Assuming 4 KiB writes are atomic** — only a 512 B sector is, on most devices; checksum your records.
- **Installing a `SIGSEGV` handler without `sigaltstack`/`SA_ONSTACK`** — it can't run on an overflowed stack.
- **Ignoring cgroup `memory.max`** — the container OOMs while system-wide memory looks fine.
- **Polling full `/proc/<pid>/smaps` from a monitoring agent** — takes `mmap_lock` and stalls `mmap`/`munmap`.
- **Using `mmap` for streaming file I/O** — a fault storm plus asynchronous `SIGBUS` as your only error channel.

---

## Compact Recall Summary

**Translation.** 48-bit canonical addresses, 4-level radix page tables (9+9+9+9+12), ~2 MiB of page tables per GiB mapped. TLB reach is entries × page size: **6 MiB at 4 KiB pages, 3 GiB at 2 MiB pages** — the whole huge-page argument. A page walk is up to 4 dependent loads: 20–40 cycles warm, 100–200 ns cold, ~24 accesses under nested paging. TLBs are not coherent, so PTE changes need **shootdown IPIs**: 2–5 µs at two cores, 10–50 µs at sixty-four, triggered by `munmap`/`mprotect`/`DONTNEED`/reclaim/THP/NUMA migration.

**Laziness.** Virtual allocation is free; physical pages arrive one fault at a time. Minor fault 0.5–2 µs, COW 1.5–3 µs, THP fault 20–100 µs, major fault 30 µs–10 ms. Reads of untouched anonymous memory map the shared zero page and allocate nothing. Touching a fresh GiB costs ~400 ms in faults alone. `fork` is COW: page tables copied (O(mapped pages)), the parent then faults on its own working set.

**Huge pages.** HugeTLB is pre-reserved, unswappable, unsplittable, deterministic — reserve 1 GiB pages at boot per NUMA node. THP is automatic and gives the same reach with unbounded tails: synchronous compaction (10–500 ms), `khugepaged` collapse with shootdowns, 2 MiB COW copies, RSS bloat. Set `transparent_hugepage=never` and use explicit pages.

**Mappings.** Anonymous (swap-backed, must be written out to reclaim) vs file-backed (clean pages simply dropped — including your `.text`). `MAP_PRIVATE` (COW) vs `MAP_SHARED` (visible to all mappers). `memfd_create` + sealing is the modern shared-memory primitive; no pointers, no vtables, `is_always_lock_free` atomics only.

**Control.** `madvise`: `HUGEPAGE`, `RANDOM`, `DONTFORK`, `DONTDUMP`, `POPULATE_WRITE`; `DONTNEED` **destroys** anonymous data and shoots down, `FREE` is lazy and keeps RSS. `mlockall(MCL_CURRENT|MCL_FUTURE)` faults in and pins. Startup order: pin → set NUMA policy → allocate → pre-fault (first touch happens here) → `mlockall` → warm → raise priority.

**Pressure.** Watermarks drive `kswapd`; hitting `min` means **direct reclaim** inside your allocation. Swap turns a stall into milliseconds — most trading hosts run swapless and accept the OOM killer, with `oom_score_adj=-1000` on the critical process. Overcommit means `malloc` success is not a promise; cgroup `memory.max` kills group-locally. `vm.dirty_bytes` bounds writeback stalls.

**Accounting.** VSZ ≈ meaningless, RSS double-counts sharing, **PSS** sums correctly, USS is what you'd reclaim. `/proc/<pid>/status` (`RssAnon`/`RssFile`/`VmPTE`/`VmLck`), `maps`, `smaps_rollup`, `numa_maps`, `pagemap`, `clear_refs`+`Referenced` for working sets. NUMA: first touch binds the page to the writing CPU's node; `--membind` fails loudly where `--preferred` degrades silently; disable `numa_balancing` on a tuned system.

**Signals and durability.** `SIGSEGV` = wrong address; `SIGBUS` = right address, no backing page — the shared-memory `ftruncate` race, prevented by `F_SEAL_SHRINK`. Stack overflow needs `-fstack-clash-protection` and a `sigaltstack` handler. And visibility ≠ durability: stores to `MAP_SHARED` are visible immediately through cache coherence and survive a process crash, but survive a power loss only after `msync(MS_SYNC)`/`fdatasync` — 20–200 µs on NVMe, milliseconds elsewhere, never on the hot path.
