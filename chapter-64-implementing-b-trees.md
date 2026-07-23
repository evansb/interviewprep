# Chapter 64 — Implementing B-Trees

## Why this matters — Core

Chapter 62 explains what B-trees do. This optional-track chapter explains what must be true while a storage engine is changing one: keys live in variable-length page cells, a split touches several pages, readers race with parent updates, and a crash can occur after any dirty cache line or log record.

The implementation problem is therefore not “write a recursive insert.” It is to preserve three layers of invariants:

1. **Logical:** search routes to every key that the index promises to contain.
2. **In-memory structural:** every state visible after a page latch is released is searchable, even while parent separators lag behind a split.
3. **Crash:** every disk state reachable after recovery is either the old structure or a completed, searchable new structure.

The most useful design in this chapter is a page-based B+ tree augmented with a **high key** and **right sibling link** on every level—a B-link tree. A concurrent reader sent to a page that just split can detect that its target lies beyond the page’s high key and move right. That makes a temporarily missing parent downlink a performance problem, not a wrong-answer bug.

Generic algorithmic requirements come first. C++ representation choices, OS I/O, and PostgreSQL, SQLite, or InnoDB behavior are labeled because none is a universal B-tree rule.

## 90-second screen — Core

Retain these facts:

1. Persist page IDs and encoded offsets, never C++ pointers. Validate magic, format version, page type, bounds, ordering, level, and checksum before trusting a page.
2. Search binary-searches a sorted slot array, dereferences variable-length cells, and descends by page ID. A breadcrumb is a verified hint, not a stable parent pointer.
3. Publish a B-link split in this order: build the right page; give it the old upper bound/right link; change the left page’s high key/right link; then make the parent downlink discoverable. Once the left page is visible, moved keys are reachable by moving right.
4. A **latch** protects in-memory page structure for a short critical section; a transaction **lock** protects logical data for longer. A buffer pin/reference prevents page eviction or reuse. Do not conflate them.
5. WAL insertion and transaction commit are different. A page gets the split record’s LSN; WAL must reach durable storage before either dirty page can be flushed. Product policy determines when commit waits for WAL.
6. Deletion policy is not universal. Some engines merge under-full pages; others tolerate low occupancy and reclaim only empty pages to reduce structural contention.

Be able to defend two decisions:

- Choose latch crabbing when the implementation wants locally simple structural updates; choose B-link move-right descent when high concurrency justifies more page metadata and delayed parent repair.
- Choose eager merge, lazy cleanup, or rebuild from workload evidence: space amplification, write contention, scan cost, recovery complexity, and maintenance windows.

## 64.1 From Abstract Nodes to Durable Pages — Core

### The page is the unit of validation and recovery

A page-based B+ tree stores records or record locators in leaves and separator/downlink pairs in internal pages. The page is normally the unit fetched into the buffer pool, latched, dirtied, checksummed, and described by WAL. A practical layout is slotted:

```text
low address
┌──────────────── page header ────────────────┐
│ magic/version/type/level/pageLSN            │
│ lower, upper, count, flags                  │
│ high-key descriptor, left/right page IDs    │
├──────── sorted slot directory ──────────────┤ grows →
│ slot 0 │ slot 1 │ ...                       │
│                 free space                  │
│       variable-length key/value cells       │ ← grows
├──────── optional engine-special area ───────┤
└─────────────────────────────────────────────┘
high address
```

The slot directory defines logical order. Each slot contains an encoded offset and length for a cell elsewhere in the page. Inserting a slot may shift a compact fixed-size array without moving every variable-length cell. Defragmentation can repack cells while preserving slot order.

A plausible header contains:

| Field | Invariant or purpose |
|---|---|
| magic and format version | reject wrong object, unsupported layout, or obvious corruption |
| page ID/type | leaf, internal, root/metapage, overflow, free/deleted |
| level | leaves are level 0; an internal downlink targets level minus one |
| lower/upper/count | slot and cell regions do not overlap and remain within the page |
| high key | exclusive upper bound for this page’s key range, or +∞ at the right edge |
| sibling IDs | horizontal recovery/range path; a right link is essential for B-link descent |
| page LSN | newest WAL record reflected in the page |
| flags/generation | split, deleted, or other transitional state; generation detects stale references |
| checksum | detects many torn or corrupted page images, not every semantic error |

The exact encoding is a file-format contract, not a C++ object layout. Do not persist a struct by writing `sizeof(PageHeader)` bytes: padding, endianness, enum size, alignment, and compiler ABI can change. Decode fixed-width fields explicitly, reject overflow before pointer arithmetic, and version migrations deliberately.

### Structural invariants

Write these as executable assertions before writing insert:

1. Slots are ordered by the index’s total comparator. If user keys can duplicate, append a stable record identifier or define duplicate-run semantics.
2. A leaf’s entries lie within its `(low bound, high key)` interval. A right sibling at the same level begins at or beyond that boundary according to the separator convention.
3. Internal separators partition key space without gaps. Every downlink targets an allocated page one level lower.
4. All root-to-leaf paths have equal height.
5. Each non-rightmost page has a valid right link and finite high key; following right links at one level progresses monotonically and cannot cycle.
6. Every live page is reachable from the root through downlinks or through a permitted transitional right-link path.
7. Free-space metadata agrees with all slot/cell bounds. No live cell overlaps another or header/special space.
8. Each page’s LSN describes an update whose WAL precedes any durable image of that update.
9. Recycled page IDs cannot be mistaken for old pages. Use a safe reclamation scheme and, when needed, a generation in references.

Minimum occupancy is deliberately absent from this universal list. Textbook B-trees often require half-full non-root nodes; production engines can weaken that invariant and recover density through vacuum, merge, or rebuild.

### High keys, links, and boundary conventions

This chapter uses half-open ranges:

```text
page P owns [low(P), high(P))
key >= high(P)  ⇒  move to P.right
rightmost page  ⇒  high(P) = +∞ and no right link
```

The comparison must use the index’s complete total order. For duplicates, comparing only the user-visible key can move too far or stop too early; compare `(key, record_id)` or use the engine’s duplicate-run convention.

Some products store the high key as a special cell, others in a header, and some use a fence key with slightly different inclusive/exclusive semantics. The invariant matters more than the representation: a reader must be able to prove whether its target may have moved right.

Left links are convenient for reverse scans but are not required by the classic B-link correctness argument. Maintaining them during concurrent split/delete adds another multi-page obligation. A product may use doubly linked leaves, singly linked levels, or restart reverse scans from an ancestor.

### Overflow pages are a product choice

If a cell can approach page size, fanout collapses and split may be impossible. Common policies are:

- cap key/value size and return a controlled error;
- keep a comparison prefix plus a pointer to overflow pages;
- store a record locator in the index and put large values in another storage structure;
- compress values, while still enforcing a worst-case bound.

Overflow chains add reads, allocation/recovery work, and reclaim hazards. SQLite B-trees use overflow pages for large cells. InnoDB can store large column data off-page according to row format. PostgreSQL’s B-tree access method does not use general index overflow chains; oversized index tuples fail a product- and page-size-dependent limit, while heap TOAST is a separate mechanism. Those are product formats, not alternative names for the same algorithm.

## 64.2 Safe Page Search — Core

### Binary search through indirection

Cells are physically scattered, so search binary-searches the sorted slot directory. Every probed slot is validated before it becomes an address. This compact C++23 example assumes the header and slots have already been decoded into host-endian values; it never overlays a C++ struct on disk bytes.

```cpp
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

struct Slot {
    std::uint16_t offset;
    std::uint16_t length;
};

struct PageView {
    std::span<const std::byte> bytes;
    std::span<const Slot> slots; // decoded, logically sorted

    std::optional<std::span<const std::byte>>
    cell(std::size_t i) const {
        if (i >= slots.size()) return std::nullopt;
        const auto [off, len] = slots[i];
        if (off > bytes.size() || len > bytes.size() - off)
            return std::nullopt;
        return bytes.subspan(off, len);
    }
};

template<class Compare>
std::optional<std::size_t>
lower_bound_slot(const PageView& page,
                 std::span<const std::byte> key, Compare compare) {
    std::size_t first = 0, count = page.slots.size();
    while (count != 0) {
        const std::size_t step = count / 2;
        const std::size_t mid = first + step;
        const auto cell = page.cell(mid);
        if (!cell) return std::nullopt; // corrupt page
        if (compare(*cell, key) < 0) {
            first = mid + 1;
            count -= step + 1;
        } else {
            count = step;
        }
    }
    return first;
}
```

The comparator must extract the encoded key safely and implement exactly the order used during insertion, including collation, null ordering, sort direction, and record-ID tie-breaks. A comparator upgrade can invalidate an existing index even when the page format is unchanged; products therefore version collations/operators or require rebuilds.

For `f` entries, binary search uses about `ceil(log2(f + 1))` comparisons. Indirection makes each comparison touch both a slot and a cell, and variable-length/collated keys can dominate CPU cost. Prefix-compressed pages may reconstruct keys using earlier cells, trading density for more comparison work.

### Root-to-leaf descent state

A safe generic B-link descent is:

```text
page_id := root_from_metapage()
pin page_id

loop:
    S-latch page
    validate header, generation, level, bounds

    while search_key >= page.high_key:
        next := page.right
        pin next before page can be reclaimed
        unlatch and unpin page
        page := next
        S-latch and validate page

    if page is leaf:
        binary-search slots
        return leaf pin + position under the caller's protocol

    child := binary-search separators and choose downlink
    pin child while the parent state is protected
    optionally record breadcrumb(parent ID, generation, slot, level)
    unlatch and unpin parent
    page := child
```

“Pin child” stands for the buffer manager’s lifetime protocol. Some engines latch-couple parent and child; some optimistically copy a downlink, release the parent, and validate a page generation/version after latching the child. What is unsafe is reading a raw page ID, allowing the referenced page to be reclaimed/reused, and later treating a different page at that ID as the child.

A breadcrumb accelerates split propagation. It is not a parent pointer: the parent can split after descent, moving the relevant downlink to a right sibling. When ascending, verify level, generation, high key, and expected child; move right or re-descend if stale.

### Search cost model

With fanout `F`, leaf capacity `L`, and `N` records, height is approximately:

```text
h ≈ 1 + ceil(log_F(N / L))
```

The useful latency model is:

```text
Tlookup ≈ Σlevel (buffer-lookup + latch/validation
                  + log2(entries) × compare)
          + cache-misses × storage-read latency
          + right-moves × sibling cost
```

Upper levels often remain cached, so one cold leaf read can dominate. Under contention, latch wait can dominate even when every page is resident. Measure tree height, buffer-hit ratio, comparisons, right moves, latch-wait distributions, and leaf I/O separately.

Worked sizing: with internal fanout 300 and 90 million leaf entries at 300 entries per leaf, there are roughly 300,000 leaves, 1,000 level-1 pages, about four level-2 pages, and one root. The tree has four page levels including leaves. Only the leaf is likely cold; “O(log N)” alone hides that practical shape.

## 64.3 Insert, Delete, and Split Propagation — Core

### Insert without a split

An insert first finds the target leaf under the search protocol, then:

1. acquire an exclusive leaf latch or upgrade/restart safely;
2. revalidate that the key belongs below the current high key;
3. enforce uniqueness/visibility according to the transaction layer;
4. find the slot position;
5. compact if total free space suffices but is fragmented;
6. append WAL describing the page change and obtain an LSN;
7. install the cell/slot, update header/page LSN, mark the buffer dirty;
8. release the latch.

The **page-visibility point** is latch release: later readers can observe the in-memory change. The **WAL rule** does not require the record to be durable before latch release; it requires WAL through the page LSN to become durable before the dirty page image can reach durable storage. The **transaction commit point** belongs to Chapter 65 and may require a WAL flush plus transaction-status work. Do not call these three points “commit” interchangeably.

If latches do not support safe upgrade, release a shared latch, acquire exclusive, and restart/revalidate. Waiting for upgrade while another upgrader holds a shared latch is a classic deadlock.

### Split a leaf

Assume a full leaf `L` owns `[a, z)` and points to old sibling `S`. Inserting produces halves `[a, m)` and `[m, z)`:

```text
before:
parent ... ───────► L [a ... z) ─────► S

after child split is visible, before parent repair:
parent ... ───────► L [a ... m) ─────► R [m ... z) ─────► S
                                    new page

after parent repair:
parent ... ───────► L      separator m ───────► R
```

A generic split under exclusive latches:

```text
split_leaf(L, pending_entry):
    X-latch L; revalidate target and lack of space
    allocate and X-latch new page R
    build sorted union(existing entries, pending_entry)
    choose boundary m by bytes and policy, not merely entry count

    initialize R:
        entries := keys >= m
        high_key := old L.high_key
        right := old L.right
        level := L.level

    prepare L:
        entries := keys < m
        high_key := m
        right := R.id
        optional flag := parent-link-pending

    append a split WAL record that can reconstruct L and R
    assign both pageLSNs; dirty both pages

    make R readable, then publish by releasing L only after
    L.high_key/L.right and R are mutually consistent

    insert separator/downlink into verified parent
    clear pending flag with its own logged update if the design uses one
```

The split’s **structural publication point** is when other threads may read the new `L.high_key` and `L.right`. At that point:

- every old and new key is present exactly where the comparator says;
- a reader sent to `L` can reach `R`;
- `R` retains the old upper bound and old right link;
- the parent may still lack `R`, but search remains correct.

Publishing the parent downlink first is dangerous: a reader could reach an uninitialized right page. Moving entries and releasing `L` before its high key/right link are visible is also dangerous: a reader sent by the old parent can report a false miss.

The WAL record must make redo idempotent. It might log physical after-images/fragments for both pages or a physiological operation with enough identity to reject a repeated application. It also needs an allocation story for `R`; a crash cannot leave recovery treating the same page as both free and live.

### Choosing the split point

Count-balanced is not necessarily byte-balanced. Variable keys require measuring encoded cells plus slots. Policies include:

- interior split near half the usable bytes;
- rightmost split that leaves the old left page fuller for ascending inserts;
- reserve space according to fill factor;
- avoid dividing a duplicate run if that harms comparison or compression;
- minimize separator length where legal;
- account for the pending insert rather than splitting first and immediately splitting again.

Biased right-edge splits improve space use for monotonic inserts but concentrate writers on one leaf. Randomizing keys spreads contention but can damage compression/locality and application ordering. Partitioning or a different ingest structure may be a better solution than disguising sequence keys.

### Parent propagation and root growth

To insert `(separator, R.id)`, use the breadcrumb only after verifying:

- the page is at `L.level + 1`;
- its generation is the expected one;
- its key range covers the separator, moving right if not;
- it still contains the downlink that should precede `R`.

If the parent lacks space, split it using the same high-key/right-link publication rule, then propagate upward. Avoid holding a child latch while recursively waiting for arbitrary ancestors unless the latch order proves deadlock-free. B-link designs commonly publish the child split, release lower latches, and repair upward with verified breadcrumbs.

A root split creates a new root one level higher pointing to the two old-root halves. Initialize and log the new root before atomically/logically changing the stable metapage root pointer. Readers that saw the old root can still move right; readers that see the new root get direct routing. Root pointer, level, and generation must change as one recoverable metadata operation.

### Delete, merge, and occupancy

Logical deletion belongs to transaction visibility; physical index cleanup can be immediate or deferred. Before removing a leaf entry, ensure no allowed snapshot still needs it. Then deletion can leave a hole, mark a slot dead, or compact the page.

An eager underflow policy borrows from a sibling or merges pages and deletes a parent separator. Merge is harder than split:

- it modifies two siblings, a parent, and possibly neighbor links;
- readers may hold stale links to the removed page;
- parent underflow can cascade toward the root;
- physical page reuse must wait until no reader can follow an old reference;
- latch acquisition must obey a global order.

Many concurrent engines therefore delay merge or reclaim only empty pages. That weakens minimum occupancy, grows footprint, and motivates vacuum/rebuild, but avoids frequent multi-page structural changes. State the selected invariant explicitly; never mix textbook “half full” proofs with a lazy-delete implementation.

## 64.4 Latches and Concurrent Descent — Core

### Locks, latches, and pins

| Mechanism | Protects | Typical duration | Survives transaction? |
|---|---|---|---|
| transaction/key lock | logical rows, keys, predicates, uniqueness | statement/transaction | often yes |
| page latch | bytes and structural fields in a buffer frame | micro-critical section | no |
| buffer pin/reference | frame/page lifetime; prevents eviction/reuse | while page is used | no |
| WAL/commit protocol | crash ordering and durability | log/page lifecycle | durable state does |

A thread must not perform slow I/O while holding a contended root latch if the buffer manager can pin/fetch first. It must not call arbitrary user comparison code under a latch unless that code is guaranteed bounded, nonblocking, and reentrant. Collation and memory allocation choices therefore influence latch design.

### Crabbing versus B-link movement

**Latch crabbing** acquires a child latch before releasing the parent. For update, it can retain ancestors until the child is “safe” for the operation—will not split for insert or underflow for delete. It has a straightforward proof but increases root/internal contention and requires a precise safe-node definition for variable-length entries.

**B-link descent** can release the parent before the child is finally known to own the search key. If a concurrent split makes the chosen child stale, its high key tells the reader to move right. Short per-page latches scale better, but the design pays for sibling metadata, validation, safe reclamation, and more complex recovery.

Optimistic variants replace shared read latches with version counters:

```text
read version (must be even/stable)
copy header/slots needed for search
read version again
if changed or writer-active: retry
```

That is a C++ memory-model and reclamation problem as well as an algorithm. Page bytes cannot be concurrently mutated non-atomically while a reader copies them without a synchronization scheme that makes the access data-race-free. A seqlock-like design needs atomic version publication, immutable/copy-on-write contents or carefully synchronized reads, and safe lifetime. “Readers take no latch” is not permission for undefined behavior.

### Latch ordering

Define one order for every structural path. Common components are:

- top-down for ordinary descent/crabbing;
- left-to-right for sibling operations;
- ascending level only after lower latches have been released, for delayed parent repair;
- page-ID order as a tie-break when the logical order is ambiguous.

No operation may improvise the reverse order. If page relationships change before all needed latches are acquired, release and restart rather than holding one latch while searching indefinitely.

Maintain a latch table per operation:

| Operation | Initial latch | Additional latch | Safe release/commit point |
|---|---|---|---|
| point search | S or optimistic validation | pin/latch chosen child or right sibling | after child/reference validation |
| leaf insert | X leaf | none if space | WAL inserted, page LSN/state installed |
| split | X left, then X allocated right | later verified parent | right initialized and left high/right published |
| merge | product-defined ordered sibling/parent set | neighbor for link repair | survivor/link/parent change recoverably published |
| vacuum/recycle | X target plus reclamation metadata | links/parent as design requires | no old reader can resolve stale page ID as new page |

## 64.5 Worked Concurrent Split Diagnosis — Core

### Failure: a false negative under load

Tree state:

```text
parent P: downlink [0, 100) → leaf L
leaf L: keys 10..90, high=100, right=S
reader searches 80
```

Observed timeline in a broken implementation:

```text
R1  S-latches P, copies downlink to L, releases P, pauses
W1  X-latches L, allocates R, moves keys 60..90 into R
W1  releases L before setting L.high=60 and L.right=R
R1  latches L, searches, does not find 80, returns NOT FOUND
W1  later updates L's link/high key and parent P
```

The bug is not “reader needed the parent latch longer.” The violated invariant is that moved keys became unreachable from the old routing path during structural publication.

### Correct publication

```text
W1  X-latches L and new R
W1  builds R with keys 60..90, high=100, right=S
W1  changes L to keys 10..50, high=60, right=R
W1  WAL-logs the two-page split; installs pageLSNs
W1  releases R and L                     ← structural publication

R1  latches L, sees 80 >= high 60
R1  pins/latches R, finds 80             ← parent repair not required

W1  verifies breadcrumb P and inserts separator 60 → R
```

The search result is correct before the parent changes. Parent repair reduces future right moves.

### Second race: two writers repairing the parent

Suppose `W2` splits `R` while `W1` is preparing to insert `R`’s downlink into `P`. Or `P` itself splits. A stale breadcrumb can now refer to the wrong parent page/slot.

Diagnosis:

1. Log page ID, level, generation, high key, right link, latch mode, and operation ID at each structural step.
2. Reconstruct whether every parent insertion first verified the expected child/downlink.
3. Check whether following right links at the parent level reaches the separator’s owning page.
4. Check for duplicate/missing downlinks and whether repair is idempotent.
5. Run the structural checker while writes are stopped to distinguish checker snapshot races from durable damage.

Repair algorithm:

```text
candidate := breadcrumb.page
pin/latch candidate at expected parent level
while separator >= candidate.high_key:
    move right with lifetime protection
if expected left-child downlink is absent:
    re-descend from root or recognize repair already completed
insert only if (separator, right-page) is not already present
```

An incomplete-split marker can make responsibility explicit. Any traverser or maintenance worker that sees it may help complete parent insertion. Helping must be idempotent and WAL-logged; two helpers cannot install conflicting separators.

### What testing should reproduce

Add failpoints after:

1. right page allocation;
2. right page initialization;
3. left high/right change;
4. split WAL insertion;
5. each latch release;
6. parent insertion;
7. root/metapage update.

At each point, pause one thread and run searches for keys on both sides. Then crash the process and recover. The invariant checker must accept supported transitional states and reject the broken interval above.

## 64.6 WAL and Recovery Integration — Core

### WAL obligations

A structural update spans pages, but common storage writes are page-granular and can tear. WAL makes the logical structural action recoverable:

```text
under page latches:
    construct validated after-state or redo parameters
    append WAL record; receive LSN
    install page changes and pageLSN
    mark buffers dirty
release latches

buffer flush rule:
    durable_wal_end >= page.pageLSN
    before writing that dirty page to durable storage
```

Appending to an in-memory WAL buffer is enough for latch release if the buffer manager enforces this rule. Durable transaction commit is a later protocol. A no-steal design could avoid flushing uncommitted pages, but high-performance databases commonly use steal/no-force variants and need corresponding recovery semantics.

**OS/filesystem boundary:** `write` completion, page-cache dirtiness, device-cache persistence, and atomic sector/page writes are different guarantees. The storage layer must use the target OS durability interfaces and account for filesystem/device ordering; a B-tree algorithm cannot assume that one page write is atomic or durable. Direct I/O, `fsync`/equivalents, checksums, full-page images, and doublewrite buffers are implementation choices coupled to Chapter 63/65’s storage model.

Split WAL must cover:

- allocation/initialization identity of the new page;
- entries and fence/right-link state for both halves;
- flags that make delayed parent repair recognizable;
- enough old/new sibling information to redo link changes;
- parent/root changes in their records;
- full-page protection or another torn-page strategy when required.

The record format is product-specific. ARIES-style systems often use physiological redo: name a page and describe a logical-within-page action. PostgreSQL uses WAL records and page LSNs with full-page images after checkpoints when configured/required to protect against torn writes. InnoDB has its own redo and doublewrite/recovery mechanisms. Do not transplant one product’s record sequence into another engine without its buffer and transaction model.

### Idempotent redo

Recovery examines a page LSN:

```text
if page.pageLSN >= record.LSN:
    page already reflects this record; skip
else:
    validate page identity/generation
    apply redo
    set page.pageLSN = record.LSN
```

This sketch is insufficient for every multi-page record: one page may have the split LSN while another was torn or never written. Redo must evaluate each affected page and reconstruct the complete supported state, often from a full image or record payload. Checksums detect corruption but do not reconstruct data.

An interrupted split must have a documented post-recovery state:

- redo completes both child pages and parent update atomically in recovery; or
- children are searchable through the right link and a pending flag causes later parent repair; or
- recovery performs the missing structural step before opening the index.

“WAL logged something” is not a proof. State the crash point, durable bytes, redo preconditions, and reachability after redo.

### Undo and logical visibility

Aborting the transaction that caused a physical split usually does not unsplit the tree: the structure can remain, while the inserted logical entry is undone or becomes invisible/dead according to the engine. Structural changes are system transactions or otherwise independently redoable because other transactions may already rely on the new routing.

This separation is fundamental:

```text
physical split: preserve searchable structure across all transactions
logical insert: obey the inserting transaction's commit/abort visibility
```

Chapter 65 owns ARIES/MVCC/transaction details. The B-tree layer must expose enough record identity and hooks for that layer without attempting to reverse shared structural history on user abort.

### Page deletion and safe reuse

Removing a downlink does not make a page immediately reusable. A reader may have copied its page ID or may be following an old right link. Options include:

- buffer pins/reference counts plus a deletion state;
- epochs or quiescent-state reclamation;
- transaction-ID horizons;
- generation-tagged page references;
- never reusing pages until an offline rebuild.

Reuse is the ABA problem on disk: page 42 can disappear and later hold an unrelated node while a stale reference still says “42.” Recovery also needs allocation/free metadata ordered with the structural WAL. A free-space map alone is not a lifetime proof.

## 64.7 Maintenance and Build Paths — Role-specific

A reader can skip this section and still understand search, split, concurrency, and recovery.

### Right-edge inserts and bulk loading

Ascending keys repeatedly target the rightmost leaf. This is the **right-only append** case. A right-edge cache can avoid a full descent when its page generation/high key still proves ownership. A biased split can pack the completed left page densely and leave room in the new right page.

The trade-off is a hot latch and cache line. With many writers, one rightmost page bounds throughput. Evidence includes latch wait concentrated on the same page, repeated rightmost splits, and low CPU utilization despite blocked workers. Partitioning, per-writer staging trees followed by merge, or a log-structured design can scale better.

Bulk loading avoids repeated descent and split:

1. scan and produce `(key, record locator)` pairs under a defined snapshot;
2. externally sort using the exact index comparator;
3. pack leaf pages left-to-right to a chosen fill factor;
4. derive separators and build internal levels bottom-up;
5. WAL/log or otherwise durably install pages and publish the root.

Cost is roughly sort plus sequential page construction rather than `N` random insert paths. It uses temporary disk and must integrate concurrent changes for an online build.

### Concurrent and online index builds

A generic online build has phases:

```text
establish snapshot/build start
    → scan base table and bulk-build private index
capture or make discoverable concurrent mutations
    → catch up changes
validate against a later visibility boundary
    → publish index as usable
retire build state after old transactions can no longer miss it
```

There is no universal “nonblocking CREATE INDEX.” Designs use change logs, dual maintenance, repeated validation scans, or MVCC horizons. Unique indexes are harder because concurrent duplicates must be rejected consistently before the new index becomes authoritative. A crash must leave the index clearly unpublished/invalid or recoverably complete.

**PostgreSQL product note:** `CREATE INDEX CONCURRENTLY` uses multiple transactions and waits/scans so normal writes can continue; the catalog can contain an invalid index after failure, requiring cleanup/retry. Exact phases, locks, supported commands, and version behavior belong to the deployed PostgreSQL manual. **InnoDB and commercial engines** use different online-DDL algorithms and lock levels. “Online” can still require brief metadata locks and substantial I/O/WAL.

### Compression, deduplication, and overflow

Compression improves fanout but complicates random access and update:

- prefix compression stores shared key prefixes once or relative to a restart point;
- suffix truncation shortens internal separators to the minimum distinguishing prefix;
- posting lists store one duplicate key with multiple record IDs;
- page compression encodes a whole page but can turn a small update into recompression.

Each encoding needs a standalone validator and version. Recovery must know whether WAL describes logical entries or compressed byte ranges. Comparators must behave identically before and after reconstruction.

**PostgreSQL product/version note:** modern `nbtree` uses separator suffix truncation introduced in PostgreSQL 12-era format work and deduplication/posting lists introduced in PostgreSQL 13 for eligible indexes. Eligibility has restrictions; unique indexes and indexes with included columns are important cases to check rather than assume. Rebuild may be needed for an old on-disk index to gain a newer format feature.

### Vacuum, fragmentation, and defragmentation

Three types of free space differ:

1. unreferenced holes within a page;
2. under-filled but live pages within the tree;
3. completely unreachable pages eligible for later reuse.

Page compaction fixes the first. Merge or rebuild fixes the second. Safe deletion/reclamation fixes the third. Calling all three “vacuum” hides different latch, WAL, and crash obligations.

Lazy deletion can mark entries dead and remove them when a page is under insertion pressure, avoiding a split. Background vacuum can remove globally dead entries and delete empty pages. A rebuild creates a new dense tree and atomically publishes it, consuming temporary space and I/O.

PostgreSQL generally avoids routine merge of merely under-full `nbtree` pages and can recycle empty pages only under its safe-deletion rules. That favors concurrency but permits bloat; `REINDEX` or a concurrent rebuild compacts. InnoDB has different merge/space-management behavior. Measure product-specific leaf density, dead entries, file size, scan I/O, and write amplification before prescribing maintenance.

## 64.8 Product Reference: PostgreSQL `nbtree` — Reference

This section maps the generic concepts to one concrete engine without making them universal.

### Page representation

With the common 8 KiB PostgreSQL build, a B-tree page uses the generic PostgreSQL page header and an access-method-specific opaque area. The opaque data includes sibling block numbers, level, and flags. A stable metapage at block 0 stores magic/version metadata and root/fast-root information; the root itself can move when it splits.

Non-rightmost pages store a high key in a special first item position; rightmost pages have an implicit +∞ bound. Internal and leaf pages participate in sibling chains. Exact struct sizes, flag names, format versions, and maximum tuple sizes are compile-time/product-version details—inspect server headers and page tools for the target build rather than hard-coding folklore.

PostgreSQL index tuples use heap TIDs as record locators and ordering tie-break information where required. The details evolved across versions to support duplicate ordering and separator truncation. Collation/provider changes can require `REINDEX`.

### Split and cleanup behavior

`nbtree` follows B-link principles: a search can move right using high keys and sibling links when parent routing lags. Its implementation has explicit incomplete-split machinery so a delayed parent downlink can be finished later. Exact latch/pin/WAL sequences are PostgreSQL implementation details and change over releases; the durable lesson is searchable child publication before reliance on the parent.

PostgreSQL uses several split-avoidance and cleanup techniques in modern releases:

- dead-item hints and page-local deletion;
- bottom-up deletion for some version-churn workloads;
- duplicate-key deduplication where eligible;
- vacuum cleanup and empty-page deletion/recycling;
- fill-factor and rightmost split heuristics.

It does not promise textbook half-full pages after deletion. A bloated index can remain logically correct while wasting cache and I/O.

### Verification commands

PostgreSQL extensions expose valuable evidence:

```sql
CREATE EXTENSION IF NOT EXISTS amcheck;
SELECT bt_index_check('public.orders_by_id'::regclass);

-- Stronger checks and exact function signatures/locking vary by release.
SELECT bt_index_parent_check('public.orders_by_id'::regclass);

CREATE EXTENSION IF NOT EXISTS pageinspect;
SELECT * FROM bt_metap('public.orders_by_id');
SELECT * FROM bt_page_stats('public.orders_by_id', 1);
```

Run functions that exist in the deployed release and understand their locking/load effects. `pageinspect` is low-level and can expose changing pages; it is not a substitute for `amcheck`’s structural reasoning. A successful checker is evidence at a point in time, not proof against future storage corruption.

SQLite’s integrity checks and InnoDB’s diagnostics expose different invariants because their formats, concurrency, and overflow/merge policies differ.

## 64.9 Verification and Testing — Core

### Structural verifier

Build the checker before optimizing. Given a stable snapshot or offline image, it should:

1. validate metapage/root identity, magic, version, and height;
2. validate every page header, checksum, slot/cell bound, and comparator order;
3. propagate expected low/high bounds down each parent edge;
4. verify child level and separator/downlink consistency;
5. walk each level’s right-link chain, checking monotonic high keys, no cycles, and rightmost termination;
6. record reachability, then report orphaned, multiply owned, or illegally free pages;
7. validate overflow chains, posting lists, and duplicate order if enabled;
8. validate transitional split/delete states permitted by recovery;
9. cross-check allocation/free-space metadata and page generations;
10. optionally compare index entries with base-table visibility under a defined snapshot.

An online checker cannot freely compare fields read at different times. It needs latches, a snapshot, page LSN/version retries, or a product-supported verification algorithm. Otherwise it reports concurrency as corruption.

### Test matrix

| Test | What it targets |
|---|---|
| model/property test against `std::map`/multimap semantics | search/insert/delete and duplicate ordering |
| every slot/cell boundary and corrupt length | decoder bounds and overflow |
| variable-size keys around exact split capacity | byte-based split and separator choice |
| ascending, descending, random, and all-equal keys | edge splits, duplicate runs, density |
| tiny synthetic pages | frequent root/parent splits and merges |
| deterministic concurrent scheduler | stale breadcrumbs, right moves, latch order |
| failpoint + crash after every WAL/publication step | redo, allocation, incomplete split |
| long reader plus delete/reuse | ABA and reclamation safety |
| bulk build plus concurrent mutation | catch-up/validation/publish boundary |
| comparator/collation upgrade fixture | file-format semantic compatibility |

Use sanitizers for in-memory C++ code, but they cannot prove crash ordering. Crash tests must terminate without normal buffer flushing, restart from durable images, run recovery, then run both the model comparison and structural checker.

### Cost and correctness counters

Track:

- tree height and pages by level;
- leaf/internal density distributions, not only averages;
- comparisons and right moves per search;
- split rate by level and bytes moved;
- time waiting for each latch/page and restart counts;
- WAL bytes and dirty pages per operation;
- dead entries, compactions, merges/page deletions, and reclaim delay;
- buffer hits/misses and storage latency;
- online-build catch-up lag and validation failures;
- checker failures labeled by invariant.

A split that is individually fast can still be the bottleneck if it serializes the right edge or writes several WAL/page images. A dense tree can still be slower if compression multiplies comparison CPU. Tie every optimization to its counterexample and rollback criterion.

## 64.10 Compact Operation Checklist — Reference

| Operation | Validate before | Latches/pins | WAL/recovery obligation | Visible-state invariant |
|---|---|---|---|---|
| search | header, generation, bounds, comparator version | page pin + S latch/version; protect child/right lifetime | none unless helping repair | move-right always progresses |
| in-page insert | leaf owns key, uniqueness policy, space | X leaf | log before data-page flush; set pageLSN | sorted slots, bounded cells |
| leaf split | target/range after X latch | X left + new right; ordered later parent latch | allocation + both child states + repair marker | right page reachable before parent required |
| parent insert | breadcrumb level/range/expected child | verified X parent | idempotent separator/downlink update | no conflicting duplicate downlink |
| root split | old root identity/level | old halves, new root, metapage under defined order | recover new root before root-pointer publication | old or new root route remains searchable |
| delete | visibility and record identity | X leaf | logical/physical deletion record | no required entry disappears |
| merge/page delete | sibling ranges, parent, reclamation horizon | ordered siblings/parent + pins | links/downlink/free-state are recoverable | stale readers cannot observe reused page |
| bulk/online publish | complete validated private tree, catch-up boundary | metadata/schema locks are product-specific | durable pages/root/catalog publication | planner cannot choose incomplete index |

## 64.11 Recall and Practice — Core

### Recall card

- Persist encoded page IDs and offsets, not C++ pointers or ABI structs.
- Slots are the sorted indirection; cells can move during compaction.
- High key + right link turns a stale parent route into a recoverable move right.
- A breadcrumb is a hint. Revalidate level, generation, range, and expected child.
- Publish a split’s searchable child state before depending on the parent downlink.
- Latch release, WAL durability, and transaction commit are distinct points.
- Page pins/reclamation are part of search correctness, not buffer-pool trivia.
- Split propagation grows height only at a root split; deletion/merge policy is product-specific.
- WAL must redo multi-page structure idempotently, including allocation and interrupted repair.
- Online builds need snapshot, mutation catch-up, validation, and atomic publication.

### Interview questions

1. Why does a slotted page binary-search slots rather than variable-length cells, and what bounds checks precede dereference?
2. State the high-key/right-link invariant and prove why a reader sent to the old left page still finds a key moved by a split.
3. Identify the structural publication point, WAL-before-data point, and transaction commit point in an insert. Why are they different?
4. A parent breadcrumb was correct during descent but stale during split propagation. How do you locate the right parent without corrupting routing?
5. Compare latch crabbing with B-link descent in correctness proof, latch footprint, recovery metadata, and reclamation complexity.
6. Why can an abort undo an inserted entry without reversing a page split that the insert caused?
7. Design a byte-balanced split for variable-length keys. When would you bias a rightmost split, and what contention can result?
8. Why is deleting a page from its parent insufficient to reuse its page ID? Give two safe-reclamation designs.
9. Outline an online index build and identify the point at which concurrent mutations can otherwise be missed.
10. Which tests distinguish a correct incomplete-split recovery design from one that merely passes single-threaded insert/search?

### Code-reading puzzle

This intentionally broken split omits essential synchronization and recovery:

```cpp
void split(Page& left, Page& right, Parent& parent) {
    const auto middle = left.size() / 2;
    right.items.assign(left.items.begin() + middle, left.items.end());
    left.items.erase(left.items.begin() + middle, left.items.end());
    parent.add(right.items.front().key, right.id);
    left.right = right.id;
}
```

Find at least twelve problems. Start with: no latches/pins; entry count instead of byte capacity; no pending insert; no high keys; wrong publication order; no preservation of old right link; no level/generation initialization; parent may be stale/full; duplicates may make the separator invalid; no WAL/page LSN/allocation record; no root case; no rollback/restart on comparison/allocation failure; C++ references imply in-memory objects rather than encoded pages; no bounds/corruption validation.

### Implementation exercise

Implement an in-memory page-ID B-link tree with a tiny configurable page capacity:

1. Use decoded host objects but no raw pointers between pages.
2. Support duplicate keys with `(key, record_id)` ordering.
3. Implement slot lower-bound, leaf insertion, split, verified breadcrumbs, and root growth.
4. Pause a writer after child split publication and prove searches on both halves succeed before parent repair.
5. Add page generations and reuse; hold a long reader to test stale references.
6. Serialize pages with explicit little-endian fields and corruption checks.
7. Add a logical WAL, crash after each split step, replay idempotently, and run the verifier.

Stretch goal: add lazy delete, empty-page reclamation with epochs, and a bulk builder. Compare height, density, split count, right moves, and bytes logged against repeated insertion.

### Common traps

- Persisting native C++ structs, pointers, `size_t`, or enums as an on-disk format.
- Checking only checksum/magic and then trusting corrupt slot offsets.
- Using a user-key comparator that disagrees with duplicate or collation ordering.
- Assuming every production B-tree keeps pages half full.
- Publishing moved entries before left high key/right link make them reachable.
- Publishing a parent downlink to an uninitialized page.
- Holding a child latch while recursively acquiring ancestors in an unproved order.
- Treating a breadcrumb or page ID as stable across split/recycle.
- Saying “lock” when the design needs separate transaction locks, page latches, and pins.
- Releasing latches only after WAL flush, unnecessarily putting storage latency in the critical section.
- Flushing dirty pages before WAL through their page LSN is durable.
- Reversing a shared structural split when a user transaction aborts.
- Reusing an unlinked page while a stale reader can still reach its old generation.
- Waiting for a full online build, then forgetting mutations that committed during its scan.
- Running an offline-style checker concurrently and calling every inconsistent snapshot corruption.
- Copying PostgreSQL, SQLite, or InnoDB constants/algorithms without their page, WAL, and MVCC contracts.

### Prerequisite for Chapter 65

Carry forward the distinction between logical transaction state and physical page structure. Chapter 65 assumes that a page update has a WAL record and page LSN, that the buffer manager enforces WAL-before-data, and that structural changes such as splits can be independently redoable even when the user transaction later aborts.
