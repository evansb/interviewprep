# Chapter 66 — B-Tree Variants

*Interview-focused revision notes. The theme: the classic in-place B-tree of Chapters 62–64 is a compromise, and every variant in this chapter is that compromise renegotiated on one of two axes — how writes hit disk (in-place overwrite vs shadow copy vs buffered messages) and how concurrency is achieved (page latches vs single-writer vs latch-free CAS). PostgreSQL's `nbtree` sits at one corner (in-place, latch-coupled, Lehman-Yao); the variants here — LMDB, WiredTiger, TokuDB, the Bw-tree — each move to a different corner and pay a different price. Know who uses which, and why.*

---

## 66.1 Why Variants Exist: The Limits of the Classic B-Tree

A classic B-tree (Ch. 62 §62.1) — the structure Postgres, InnoDB, and every textbook implement — is *in-place mutable*: to insert a key you locate the leaf page, then overwrite that page's bytes on disk. This is space-efficient and gives excellent read behavior (Ch. 61 §61.15's three axes: unbuffered, in-place, ordered). But in-place mutation has four structural costs that motivate every variant in this chapter.

**1. Write amplification from page-granular writes.** A B-tree page is 4–16 KB (Postgres 8 KB, InnoDB 16 KB, WiredTiger up to 32 KB). Changing one 20-byte record dirties the whole page, and the storage layer must eventually write the entire page back. Modifying one row can cost a full-page write — a **write amplification** of ~400× (8192 / 20) before you even count WAL, which logs the change *again*. On SSDs this also drives flash **erase-block** wear (Ch. 34).

**2. In-place update fights durability.** Overwriting a page in place risks a **torn page** (Ch. 63): a crash mid-write leaves half the old page and half the new. Classic B-trees defend against this with a **write-ahead log** plus techniques like Postgres's `full_page_writes` (log the entire page image the first time it is touched after a checkpoint) or InnoDB's **doublewrite buffer** (write the page twice, once to a scratch area). Both roughly *double* write volume. Copy-on-write B-trees eliminate this class of problem by never overwriting.

**3. Random write I/O.** Leaves in key order are scattered across the file, so a write-heavy workload with non-sequential keys produces random writes — cheap on B-trees relative to reads, but far worse than the sequential writes an LSM tree (Ch. 67) or a log-structured design achieves.

**4. Concurrency via latches.** To let many threads traverse and modify one tree, the classic implementation uses **latch coupling** (crabbing) and, for splits, the Lehman-Yao B-link trick (Ch. 64 §64.x). Latches are cheap but not free: on many-core machines, the latch on a hot page (the root, the right-most leaf under monotonic inserts) becomes a **contention point** that caps scalability. Latch-free variants (the Bw-tree) exist to remove exactly this bottleneck.

The variants regroup into three families by which cost they attack:

```
Classic in-place B-tree (Postgres nbtree)  ── the baseline everything contrasts against
   │
   ├── attack durability + torn pages ─────▶ Copy-on-Write B-trees      (LMDB)          §66.4–66.8
   │
   ├── attack write amplification ─────────▶ Buffered / lazy B-trees    (WiredTiger)    §66.9–66.11
   │                                          FD-trees                                   §66.12
   │                                          Bε-trees / fractal trees   (TokuDB)        §66.13–66.14
   │
   ├── attack latch contention ────────────▶ Bw-trees (latch-free)      (Hekaton)       §66.15–66.18
   │
   └── attack cache/block-size dependence ──▶ Cache-oblivious B-trees   (research)      §66.19
```

Crucially, **almost none of these are in Postgres.** Postgres uses a classic in-place Lehman-Yao `nbtree` and always has. When an interviewer asks about B-tree variants, the honest framing is: "Postgres is the baseline; these are what *other* engines do differently, and here is the trade each one buys." That framing is the spine of this chapter.

---

## 66.2 The Baseline: PostgreSQL's `nbtree` (Lehman-Yao In-Place)

Pin the baseline precisely, because every variant is defined by how it deviates.

Postgres's B-tree access method (`src/backend/access/nbtree`) is a **Lehman-Yao B⁺-link tree**:

- **In-place, mutable pages.** Insert/update/delete overwrite the 8 KB page. Durability is provided by the WAL (Ch. 65) and torn-page safety by `full_page_writes`.
- **B-link tree.** Every level is a singly-linked list left→right via a **high key** and a **right-link** pointer. A reader that lands on a page being split can follow the right-link to find a key that "moved right," so readers need not hold locks across the whole descent — this is the classic concurrency win of Lehman-Yao (Ch. 64).
- **Latch coupling for writers.** A writer descending to split takes buffer content locks (`LWLock`s, Ch. 24) on pages, coupling parent and child briefly.
- **Leaves point at the heap via TID** (Ch. 61 §61.7). Postgres is heap-organized, so the B-tree is a *secondary* structure: its leaves hold `(key, TID)`, never the row itself.
- **No versioning inside the tree.** MVCC lives in the heap (`xmin`/`xmax` on tuples), not in the index — the index can even contain entries pointing at dead tuples, cleaned up by VACUUM. This is why Postgres B-trees do *not* need the copy-on-write MVCC that LMDB builds in.

What Postgres's B-tree is **not**: it is not copy-on-write, not buffered/lazy, not latch-free, and it does not store multiple key versions. Every "variant" below changes one or more of those. Keep this list handy; interview answers should always say what changed *relative to nbtree*.

---

## 66.3 The Design Space: Two Axes

Two questions organize all the variants.

**Axis A — how does a write reach disk?**

| Strategy | Mechanism | Torn-page risk | Write amp | Example |
|---|---|---|---|---|
| In-place mutable | Overwrite the page | Yes → needs WAL + FPW/doublewrite | High (full page/change) | Postgres nbtree, InnoDB |
| Copy-on-write (shadow) | Write a fresh copy of the modified path; swap root | None (old tree intact until commit) | High per write, but no WAL | LMDB, WiredTiger checkpoints |
| Buffered / lazy | Batch changes in in-node message buffers; flush in bulk | Depends on backing store | Low (amortized) | Bε-tree/TokuDB, WiredTiger |
| Log-structured + delta | Append delta records; never update page in place | None | Low | Bw-tree / LLAMA |

**Axis B — how is concurrency achieved?**

| Strategy | Mechanism | Scales to many cores? | Example |
|---|---|---|---|
| Latch coupling (crabbing) + B-link | Short-held page latches; readers follow right-links | Moderate; hot-page contention | Postgres, InnoDB |
| Single writer / multi-reader | One write transaction at a time; readers lock-free via MVCC snapshots | Reads yes; writes serialized | LMDB |
| Latch-free (CAS on mapping table) | Atomic install of delta via compare-and-swap (Ch. 26) | Yes, that's the point | Bw-tree / Hekaton |

A given engine picks one from each axis. LMDB = *copy-on-write* + *single-writer*. WiredTiger = *buffered in RAM, copy-on-write checkpoints* + *hazard-pointer / lock-free-ish reads*. TokuDB = *buffered messages (in-place-ish under a WAL)* + latches. Bw-tree = *log-structured deltas* + *latch-free*. The rest of the chapter is these four cells expanded.

---

## 66.4 Copy-on-Write B-Trees: Shadow Paging

A **copy-on-write** (COW) B-tree never modifies a page in place. To change a leaf, you write a **new** copy of that leaf to a fresh location, then a new copy of its parent (pointing at the new leaf), then a new grandparent, … all the way up to a **new root**. Only when the whole modified path exists on disk do you atomically switch the "current root" pointer. This is **shadow paging**, an idea older than the B-tree literature (System R used it) but made practical by B-trees' shallow height.

```
Original tree (root R0):            After COW insert into leaf L (new root R1):

        R0                               R0 ······(still valid for old readers)
       /  \                             /  \
      A    B                           A    B
     /|    |\                         /|    |\
   ...L...  ...                     ...L...  ...
                                          \
   modify L  ─────────────▶            R1   L'   A'   (new copies)
                                      /  \       L' has the change
                                    A'    B      A' points at L'
                                          |      R1 points at A' and (shared) B
   Only pages ON the path root→L are copied. B and its subtree are SHARED,
   pointed at by BOTH R0 and R1. Height h ⇒ exactly h new pages per update.
```

The properties that fall out of this, and why they matter:

- **Atomic commit with one pointer flip.** The transition from "old tree" to "new tree" is the single atomic write of the new root pointer. Before it, a crash leaves the old tree perfectly intact; after it, the new tree is complete. There is **no torn-page window** and, remarkably, **no write-ahead log is required** for atomicity — the tree structure *is* the log. This is the headline advantage over nbtree.

- **Free, consistent snapshots.** Because old pages are never overwritten, any reader holding an old root pointer sees a complete, immutable snapshot of the tree as of that root — indefinitely, with zero copying. This is **MVCC via shadow paging** (Ch. 65): readers never block writers and writers never block readers, because they operate on physically distinct pages.

- **Path-copy cost.** Every update rewrites `h` pages (tree height, typically 3–5), regardless of how small the change. This is COW's write-amplification tax: an insert that dirties one leaf costs 3–5 page writes, not one. B-trees keep `h` small (high fan-out) precisely so this stays cheap.

- **Space churn → needs reclamation.** Superseded pages become garbage the moment no live snapshot references them. Something must find and recycle them (§66.7), or the file grows without bound.

The catch is that plain COW serializes writers: two concurrent writers would both try to produce a new root, and reconciling them is hard. The dominant COW B-tree in production — LMDB — simply **allows only one writer at a time**, turning the hard problem into a non-problem.

---

## 66.5 LMDB: The Copy-on-Write B-Tree in Production

**LMDB** (Lightning Memory-Mapped Database, by Howard Chu for OpenLDAP, ~2011) is the canonical production COW B-tree and the cleanest system to reason about. It backs OpenLDAP's `back-mdb`, is embedded in countless projects, and its design decisions are a favorite interview topic because each one follows logically from "COW + mmap."

The pillars:

**1. Memory-mapped, single file.** The entire database is one file `mmap`-ed (Ch. 32 §32.x) read-only into the process address space. Reads are pointer dereferences into the mapped region — **zero-copy**; there is no buffer pool, no page cache managed by LMDB, no serialization/deserialization. The OS page cache *is* LMDB's cache. A key value returned to the caller points directly into the mapped file (valid only for the life of the read transaction).

**2. Single-writer / multi-reader (MVCC).** At most **one write transaction** is active at a time, serialized by a single writer mutex. Read transactions are **unlimited and lock-free**: a reader grabs the current root and reads the immutable snapshot it defines. Because of COW, that snapshot is never mutated under the reader. Readers **never block writers and writers never block readers** — the property people usually pay MVCC bookkeeping for, LMDB gets for free from shadow paging.

**3. No WAL.** Consequence of COW (§66.4). Durability comes from writing new pages and then `fsync`-ing before flipping the committed root (via the meta page, §66.6). There is no separate log to replay; recovery is just "read the last valid meta page." This makes LMDB's on-disk footprint and recovery logic astonishingly small.

**4. `MVCC` snapshot isolation for free.** A long-running read transaction pins an old root; the writer keeps producing new roots. The reader sees a consistent point-in-time view for as long as it holds the transaction. The cost is that pages referenced by that old root cannot be reused until the reader finishes — a **long reader pins garbage** (§66.7), the LMDB analogue of Postgres's "long transaction blocks VACUUM."

```
LMDB address space (single mmap'd file):

 ┌────────┬────────┬──────────────────────────────────────────────┐
 │ meta 0 │ meta 1 │  data pages: B-tree nodes (COW), free pages   │
 └────────┴────────┴──────────────────────────────────────────────┘
   page 0   page 1   page 2 ...

 Each write txn:
   1. copy modified path → append new pages (reuse free pages if any)
   2. fsync data pages
   3. write new root + txnid into the OTHER meta page
   4. fsync meta page   ← this is the atomic commit point
```

**Performance shape.** LMDB reads are essentially as fast as memory allows (bounded by cache/TLB, Ch. 28/32) — often the fastest embedded KV store for read-dominant workloads. Writes are serialized and pay the path-copy tax, so LMDB is *not* a high-write-throughput store; that is the deliberate trade. It is optimized for the "write-rarely, read-constantly, never-lose-data, tiny-code" quadrant.

---

## 66.6 LMDB Meta-Page Double-Buffering

How does a single pointer flip commit a transaction *durably and atomically* with no log? LMDB uses **two meta pages** (page 0 and page 1) in a double-buffering / **ping-pong** scheme.

A meta page records the roots of the tree(s), the **transaction id**, and the last-used page number. Commit alternates which meta page it writes:

```
txn N   commits by writing meta page (N mod 2)     e.g. even txns → meta 0
txn N+1 commits by writing meta page ((N+1) mod 2)      odd txns → meta 1

On open/recovery: read BOTH meta pages, verify each (checksum/txnid),
                  and adopt the one with the HIGHER valid transaction id.
```

Why this is crash-safe with exactly two pages:

- The writer prepares all new data pages and `fsync`s them **first**. At this moment the *old* meta page still points at the *old* root — the database is fully consistent as the previous committed state.
- Then it writes the *other* meta page (the one not currently authoritative) with the new root and `txnid = N`, and `fsync`s it.
- If the crash happens **before** the meta write completes, that meta page is torn/invalid or has a lower txnid; recovery falls back to the still-intact other meta page → the transaction simply never happened. No partial state.
- If the crash happens **after**, the new meta page is valid with the higher txnid → the transaction is committed.

The commit is atomic because it hinges on a **single page write** that either fully lands or doesn't, and because the *previous* committed state is untouched in the other meta slot the whole time. This is why LMDB needs no undo log and no redo log: the two-meta-page ping-pong is a two-slot durable atomic register. (LMDB even guards against a single meta page being torn by keeping the previous one as a fallback — it never overwrites the meta page it is currently relying on.)

Durability modes mirror Ch. 61 §61.5's knob: default `fsync` on commit is fully durable; `MDB_NOSYNC`/`MDB_NOMETASYNC`/`MDB_MAPASYNC` relax the syncs for throughput at the cost of a bounded loss window (the metadata can lag the data, but COW guarantees you still recover to *some* consistent older root — never corruption, only lost recent commits).

---

## 66.7 Space Reclamation and the Free List

COW's Achilles heel is garbage: every update abandons `h` pages. Without reclamation the file grows on every write forever. LMDB solves this with a **free list** (itself stored as a second B-tree inside the same file, keyed by the transaction id that freed the pages).

The mechanism:

- When a write transaction copies a path, the **old** pages on that path are not needed by *this* new tree. They are added to the free list, tagged with the current `txnid`.
- A page tagged with txnid `T` can be **reused** once no live read transaction has a snapshot older than or equal to `T` — i.e., once every reader that could still see those pages has finished.
- The writer, before appending brand-new pages at the end of the file, first tries to **pull reusable pages off the free list**. This keeps the file from growing when the workload is update-in-place-ish (steady state churn reuses freed pages).

```
free-list B-tree:  txnid → [list of page numbers freed by that txn]

oldest live reader snapshot = txnid R
   ⇒ any free-list entry with txnid < R is safe to reuse
   ⇒ entries with txnid ≥ R are PINNED (a reader might still read them)
```

The failure mode is exactly Postgres's: a **long-lived read transaction** pins an old snapshot, so all pages freed after it cannot be reclaimed, and the file grows (LMDB "bloat"). The oldest reader's txnid is the reclamation horizon. This is why LMDB (like Postgres VACUUM) is sensitive to abandoned/idle-in-transaction readers, and why the map size must be provisioned for peak churn plus the worst-case reader lag.

Contrast with nbtree: Postgres reclaims space via VACUUM scanning the heap and index for dead tuples; LMDB reclaims via the free-list B-tree keyed on txnid. Same problem (MVCC garbage bounded by the oldest snapshot), different bookkeeping.

---

## 66.8 Abstracting Node Updates: One Codebase, Two Strategies

A practical engineering point the book emphasizes: a well-built storage engine does not hard-code "overwrite this page." It routes all node modifications through an **update abstraction** — a small interface like `updateNode(node, change)` — behind which the engine can implement *either* in-place mutation *or* copy-on-write, without the B-tree algorithms (search, split, merge, rebalance) knowing which.

```
   B-tree logic  ──▶  NodeUpdater interface  ──┬──▶  InPlaceUpdater:  memcpy into the page buffer
   (split/merge)                               │
   (unchanged)                                 └──▶  CopyOnWriteUpdater: allocate new page,
                                                       copy + apply change, record old page freed,
                                                       return new page id to bubble up to parent
```

Why this matters:

- **Testability and reuse.** The tricky, invariant-heavy B-tree code (Ch. 64) is written once. The in-place and COW behaviors differ only in the leaf implementation of "produce the updated node."
- **The bubble-up difference is localized.** In-place update returns "same page id, now dirty." COW update returns a **new page id**, which forces the parent to be updated too — so the abstraction's return value drives whether path-copying propagates. The recursion in the B-tree code is identical; only what `updateNode` returns changes.
- **Hybrid engines.** WiredTiger effectively uses this: it mutates page *images in memory* (in-place, fast) but writes them out copy-on-write at checkpoint time (§66.10). The update abstraction is exactly what lets one tree be in-place in RAM and COW on disk.

The interview takeaway: COW vs in-place is not a different *tree*, it is a different *node-update policy* behind a shared interface — which is why an engine can offer both and why the algorithmic complexity of B-tree maintenance is unchanged.

---

## 66.9 Lazy B-Trees: Buffering Updates at Nodes

The second family attacks **write amplification** by *buffering*. Instead of pushing each update down to its leaf immediately (dirtying a whole page per small change), a **lazy** (buffered) B-tree accumulates updates in in-memory buffers and applies them in batches, converting many small random page writes into fewer, larger, more sequential ones.

There are two flavors, which the book distinguishes:

1. **Buffer the whole page in memory, flush lazily** (WiredTiger, §66.10). Keep hot pages as mutable in-memory images; only *reconcile* them into on-disk page images occasionally (at checkpoint or eviction). Many logical updates to a page cost one disk write. This is buffering at the *page-cache* level, made explicit.

2. **Buffer per-node update messages that cascade down** (Lazy-Adaptive Tree §66.11, and the Bε-tree §66.13). Attach a small update buffer to each internal node; an update is *inserted into the root's buffer* and only pushed one level down when a buffer fills. A record migrates leafward over many operations, amortizing the cost.

The unifying idea is **amortization**: the expensive part of a B-tree write is the leaf page write, and buffering lets one physical write absorb many logical updates. The price is **read amplification** (a read may have to consult buffers along the path, not just the leaf) and **staleness/complexity** in reasoning about where the current value of a key lives. This is the same RUM-conjecture tension (Ch. 61 §61.15, Ch. 67) that separates B-trees from LSM trees, now applied *inside* the B-tree.

---

## 66.10 WiredTiger: In-Memory Images, Checkpoints, and Reconciliation

**WiredTiger** (by Keith Bostic and Michael Cahill, acquired by MongoDB in 2014; MongoDB's default storage engine since 3.2, 2015) is the most important lazy/buffered B-tree in production. Its architecture is a clean separation of an **in-memory tree** from an **on-disk block store**, mediated by **reconciliation**.

The three-layer structure:

```
   In-memory:   B-tree of PAGE objects. Each in-memory page holds:
                  • the clean on-disk image (read once), PLUS
                  • an "insert/update list" (skiplist) of modifications
                    made since the page was read — NOT applied to the image.
                        │
        reconciliation  │  (at eviction or checkpoint)
                        ▼
   On-disk:     immutable page images written by the BLOCK MANAGER to new
                offsets (copy-on-write at the block level). A checkpoint
                records the set of blocks forming a consistent tree root.
```

The moving parts, each an interview-worthy concept:

- **In-memory pages carry update lists.** When a transaction modifies a key, WiredTiger does **not** rewrite the page image; it prepends the new value to a per-key **update chain** (a skip-list of versions, which also serves MVCC — Ch. 65). Many updates accumulate cheaply in RAM.

- **Reconciliation** is the process of turning an in-memory page (image + update lists) into one or more clean on-disk page images. It walks the updates, picks the values visible to the checkpoint's snapshot, and serializes a fresh page. Reconciliation also **splits** oversized pages and **merges** tiny ones — structural maintenance happens here, lazily, not on every insert. This is where buffered updates are "paid off" in one batched write.

- **The block manager** allocates on-disk space and writes reconciled pages to **new locations** (never overwriting a live block), maintaining an extent-based free list of reusable space. Because writes go to new blocks, an in-progress checkpoint never corrupts the last durable one — **copy-on-write at the block/checkpoint granularity**, the same torn-page immunity LMDB gets (§66.4), applied per checkpoint rather than per transaction.

- **Checkpoints** are the durability boundary for the tree itself: a checkpoint is a consistent set of on-disk blocks with a root, written and `fsync`-ed. Between checkpoints, durability of individual commits is provided by a separate **journal / WAL** (WiredTiger *does* keep a write-ahead log for between-checkpoint durability, unlike LMDB — because its on-disk tree only advances at checkpoints, which are seconds apart). MongoDB's default: checkpoint every 60 seconds, journal `fsync` ~every 100 ms.

- **Eviction** under memory pressure reconciles and writes dirty pages out, then frees their RAM; clean pages are simply dropped. WiredTiger manages its own cache (default ~50% of RAM) rather than leaning entirely on the OS page cache the way LMDB does.

The net effect: WiredTiger absorbs bursts of updates in memory, batches them into large sequential block writes at reconciliation, and gets crash-safety from block-level COW plus a journal. It is dramatically more write-friendly than nbtree while remaining a B-tree (range scans, ordered keys), which is exactly why MongoDB adopted it over the old in-place `MMAPv1`.

---

## 66.11 The Lazy-Adaptive Tree (LA-Tree)

The **Lazy-Adaptive Tree** (LA-tree, Agrawal et al., 2009) is the research design that makes "buffer messages that cascade down" explicit and *adaptive*. It targets flash, where random writes are expensive and reads are cheap.

The structure: each subtree has an associated **update buffer** (a *cascaded* buffer). Updates are appended to a buffer high in the tree rather than applied to the leaf. When a buffer exceeds a threshold, it is **emptied** — its updates pushed down one level into the buffers of the child subtrees, cascading toward the leaves over many operations.

```
        [root buffer: batched updates] 
               │  (flush when full)
        ┌──────┴──────┐
    [buffer]        [buffer]        each internal node owns a buffer;
      │                │            updates trickle down in bulk, so a
   [leaves]        [leaves]         leaf is rewritten once per many updates
```

The **adaptive** part is the innovation: the buffer-emptying threshold is not fixed but tuned per subtree to the workload's read/write ratio. Read-heavy subtrees keep buffers small (so reads don't pay to scan large buffers); write-heavy subtrees keep buffers large (to maximize amortization). The tree *adapts* the buffering aggressiveness to balance read cost against write cost dynamically — an early instance of the read/write knob that the Bε-tree formalizes with its parameter ε. The LA-tree is not itself a shipping production engine, but it is the conceptual bridge from "lazy B-tree" to "Bε-tree," and it is where the book introduces cascaded buffers.

---

## 66.12 FD-Trees: Fractional Cascading on Flash

The **FD-tree** (Flash-Disk tree, Li et al., 2010) is a B-tree-flavored structure that borrows the LSM idea of **logarithmic levels** and combines it with **fractional cascading** to keep multi-level search cheap. It is designed to turn the random writes a B-tree would do into sequential writes, on flash.

Structure: instead of one balanced tree, an FD-tree is a small **head tree** (a normal B-tree that fits in a few pages) plus a sequence of **sorted runs** `L₀, L₁, …, L_k`, each level geometrically larger than the last (ratio `k`). New entries go into the head tree / `L₀`; when a level fills, it is **merged** into the next larger level as a sequential write — exactly the leveled compaction of an LSM tree (Ch. 67 §67.x), but the runs are B-tree-organized.

The problem this creates: a search must potentially probe **every level** (the key could be in any run), so naive multi-level search costs `O(k · log n)` — one full binary search per level. **Fractional cascading** fixes this.

**Fractional cascading** is the technique of embedding, into each level, **pointers ("fences") to positions in the next level**, so that once you have located the search key's position in `L_i`, you can jump directly to the neighborhood of its position in `L_{i+1}` instead of searching `L_{i+1}` from scratch.

```
Without fractional cascading:  binary-search each level independently
   L0: [────x────]   O(log|L0|)
   L1: [──────x──────]   O(log|L1|)
   L2: [────────x────────]   O(log|L2|)      total ≈ Σ log|Li|

With fractional cascading:  every k-th key of L_{i+1} is copied down into L_i
   as a "fence pointer". Locate x in L0 → follow fence → land in a small window
   of L1 → follow fence → small window of L2 …   Each subsequent level costs O(1)
   after the first search.   total ≈ log|L0| + k·O(1)
```

FD-trees copy a sample of each level's keys up into the level above as **fence pointers**, so a search does one real binary search at the top and then follows fences down, giving search cost close to a single tree's `O(log n)` despite the data being spread across `k` sorted runs. The payoff: FD-trees get LSM-like **sequential-write** performance (merges, not random page updates) while keeping **B-tree-like search** cost via fractional cascading. They are a research/academic design (not a mainstream shipping engine), but they are the clearest illustration of fractional cascading in a database context — a technique that also underlies how the Bε-tree and some LSM designs bound their read amplification.

---

## 66.13 Bε-Trees and Fractal Trees: Message Buffers in Internal Nodes

The **Bε-tree** ("B-epsilon tree," Brodal & Fagerberg, 2003) is the most influential buffered B-tree, and its commercial embodiment — **fractal trees** in **TokuDB** and **PerconaFT** (used in Percona Server and historically TokuMX for MongoDB) — is the one you are most likely to be asked about. The idea: put a **message buffer** in every internal node and let it absorb writes.

Structure: a Bε-tree is a B-tree in which each internal node reserves part of its space for **pending update messages** (insert/delete/upsert) rather than using all its space for pivot keys.

```
   Internal node layout:
   ┌───────────────────────────┬───────────────────────────────────┐
   │  pivot keys + child ptrs  │      MESSAGE BUFFER                │
   │  (fraction ε of the node) │  (fraction 1−ε of the node)       │
   └───────────────────────────┴───────────────────────────────────┘
                                   buffered inserts/deletes/upserts
                                   destined for the subtree below,
                                   not yet applied to the leaves
```

The write path:

1. An insert is **not** sent to the leaf. It is written as a **message** into the **root** node's buffer. That's it — one write to one (cached) node. This is why Bε-tree inserts are extremely cheap.
2. When a node's buffer fills, its messages are **flushed** down to the children: each message moves into the appropriate child's buffer, in one batched, sequential I/O that carries *many* messages at once.
3. Messages cascade down over many operations; a leaf is only rewritten when a batch of messages finally reaches it. Because a flush moves `B^{1-ε}`-ish messages per I/O, the **per-message write cost is amortized** across the whole batch.

The read path: to look up a key, descend root→leaf as usual, but at **each node on the path also check its message buffer** for pending messages that affect the key (a newer insert/delete that hasn't reached the leaf yet). The current value is the newest message seen along the path, or the leaf value if none. So reads pay to scan `O(h)` buffers — a modest, bounded read-amplification tax.

**Why "fractal tree"?** Tokutek's marketing name for their Bε-tree implementation. Functionally identical concept; the message-buffer mechanism is the substance. TokuDB/PerconaFT add these to a MySQL/MongoDB-pluggable engine with a WAL for durability of the buffered messages.

The killer feature TokuDB advertised: **fast online schema changes** (e.g., adding a column) become cheap because the change is injected as a broadcast message into the root buffer and applied lazily as it cascades down — no full-table rewrite up front. And **high compression** (block-level, large nodes), because Bε-tree nodes are large (megabytes), which compresses well and suits the batched-write model.

---

## 66.14 The ε Knob: Trading Reads Against Writes

The Greek letter ε in "Bε-tree" is a real, tunable parameter in `[0, 1]` that sets **how much of each node is pivots vs buffer**, and it interpolates a whole spectrum of structures. This is the single most interview-worthy fact about Bε-trees, because it makes the read/write trade-off *quantitative*.

Let `B` be the block size (in units of items) and `N` the number of items. Node fan-out is `B^ε` (that fraction of the node holds pivots), and the buffer holds the remaining `B^{1-ε}`-scale messages. The asymptotic costs (I/Os), from the Brodal–Fagerberg analysis:

| Operation | Cost (I/Os) | At ε=1 (B-tree) | At ε→0 (buffered/LSM-like) |
|---|---|---|---|
| Point query | `O(log_{B^ε} N) = O((1/ε)·log_B N)` | `O(log_B N)` | grows by 1/ε factor |
| Insert (amortized) | `O((log_{B^ε} N) / B^{1-ε})` | `O(log_B N)` (full B-tree cost) | `O((log_B N)/B)` — B× faster |

Reading the table:

- **ε = 1**: the node is *all* pivots, no buffer → an ordinary B-tree. Fast point queries (`O(log_B N)`), slow inserts (one I/O per insert, no amortization).
- **ε = 1/2**: a common sweet spot. Fan-out `√B`, buffer `√B`. Inserts get roughly a `√B` speed-up over a B-tree, while point queries only double (`1/ε = 2`). For `B = 1024`, that's ~32× cheaper inserts for 2× costlier lookups.
- **ε → 0**: the node is *all* buffer, fan-out → constant → the structure degenerates toward a **logarithmic-level, LSM-like** design with maximal insert amortization but higher query cost.

So **ε is the dial between a B-tree and an LSM tree**, made continuous. This is the clean way to state where the Bε-tree lives on Chapter 61's / Chapter 67's read-vs-write spectrum: it is not "B-tree or LSM," it is "pick your ε." TokuDB picks an ε in the middle to get insert throughput close to an LSM tree while keeping point-query latency close to a B-tree — the pitch that "you can have most of both."

---

## 66.15 Bw-Trees: The Latch-Free B-Tree

The **Bw-tree** ("Buzz Word tree," Levandoski, Lomet & Sengupta at Microsoft Research, 2013) attacks the *other* axis: **concurrency**. It is a B-tree with **no latches at all** — all structural changes are made with atomic **compare-and-swap** (Ch. 26 §26.x). It is the storage structure under **Microsoft SQL Server's Hekaton** in-memory engine and the **Azure Cosmos DB / Deuteronomy** projects. On modern many-core hardware, latch contention on hot pages is the scaling wall (§66.1); the Bw-tree removes latches entirely.

Two mechanisms make latch-freedom possible: a **mapping table** and **delta records**.

**1. The mapping table — indirection that enables atomic swaps.** Every logical page has a **page id** (PID). Instead of pointers between nodes holding physical addresses, they hold **PIDs**. A central **mapping table** maps `PID → physical pointer` (a memory address, or an offset in the flash log under LLAMA, §66.18).

```
   node A ──child ptr = PID 7──▶   [ Mapping Table ]
                                     PID 7 ──▶ ●───▶ physical page / delta chain
                                     PID 8 ──▶ ●
                                     ...
   To "update" PID 7, you change ONE table slot with a single CAS.
   No node that references PID 7 needs to change — they all hold the PID, not the address.
```

The mapping table is the crux: because every inter-node reference is a PID resolved through the table, **changing a page's content is a single-word CAS on the page's table slot** — and no other node has to be modified, because they all reference the stable PID. This is the same "indirection makes relocation cheap" idea as Postgres's TID/line-pointer (Ch. 61 §61.14), repurposed to make updates *atomic and latch-free* instead of merely relocatable.

**2. Delta records — never modify a page in place.** To update a page, you do **not** rewrite it. You allocate a small **delta record** describing the change (insert key k, delete key k, …), set its "next" pointer to the current page, and **CAS the mapping-table slot** to point at the new delta.

```
   Mapping[PID 7]:  ●──▶ base page P
   Insert k:  create Δ(insert k){next → P};  CAS Mapping[PID 7]: P → Δ
   Update again: create Δ2{next → Δ};        CAS Mapping[PID 7]: Δ → Δ2

   PID 7 now resolves to a DELTA CHAIN:   Δ2 → Δ → base page P
```

A page is thus a **base page plus a chain of prepended deltas**. A read walks the delta chain (newest first), applying deltas to reconstruct the current logical page. The CAS install is the linearization point: it either succeeds (your delta is now visible to everyone) or fails (someone else installed first) → you retry. **No thread ever waits on a latch**; contention shows up as CAS-retry, not blocking. This is a direct application of the lock-free CAS-loop pattern from Ch. 26.

---

## 66.16 Bw-Tree Consolidation and Structural Modifications

Delta chains cannot grow forever — a long chain makes reads slow (you replay many deltas) and burns memory. Two maintenance operations keep the tree healthy, both done **latch-free**.

**Consolidation.** When a page's delta chain exceeds a threshold (e.g., 8–16 deltas), a thread builds a **new consolidated base page** that folds all the deltas into a fresh, sorted page image, then **CAS-installs** it into the mapping-table slot, replacing the delta-chain head. If the CAS fails (someone added a delta meanwhile), the consolidation is simply discarded and retried later. The old chain becomes garbage (reclaimed by epochs, §66.17).

```
   before:  Mapping[7] → Δ3 → Δ2 → Δ1 → base P     (reads replay 3 deltas)
   consolidate: build P' = apply(Δ3,Δ2,Δ1, P)
   CAS Mapping[7]: (Δ3-head) → P'                    (reads now hit clean page)
   old Δ3→Δ2→Δ1→P chain → epoch garbage
```

**Structural Modification Operations (SMOs) — splits and merges without latches.** This is the hardest part of the Bw-tree, because a split touches *two* pages (child and parent) and there is no lock to hold across both. The Bw-tree makes an SMO a **multi-step, half-completed-but-still-correct** sequence, each step a single atomic CAS, using the B-link idea (a side pointer) so that a concurrent thread encountering a *half-done* split can either **help complete it** or navigate around it:

1. **Split delta on the child.** Install (via CAS) a **split delta** on the overfull page P that says "keys ≥ k now live in new sibling Q, reachable via this side-link." At this instant the split is *logically* half-done: P still exists, Q exists, and a reader looking for a key ≥ k follows the side-link to Q (exactly Lehman-Yao B-link semantics, Ch. 64). The tree is already correct, just not yet reflected in the parent.
2. **Index-entry delta on the parent.** Install (via CAS) an **index-term delta** on the parent that adds the pivot key k pointing at Q, so future descents reach Q directly without the side-link.

Because each step is an isolated CAS and the intermediate state is *searchable and correct* (via the side-link), a thread that arrives mid-split isn't blocked: it detects the incomplete SMO and **cooperatively finishes** the missing step before proceeding. This **cooperative/helping** protocol is the standard lock-free technique (Ch. 26) for making a multi-word update appear atomic without locks. Merges work analogously with remove-node and merge deltas.

The upshot: the Bw-tree performs the same splits/merges as any B-tree, but every mutation — insert, consolidate, split, merge — is a lone compare-and-swap, so the structure scales across cores without a single latch. The cost is complexity (the SMO protocols are notoriously intricate) and read-time delta replay between consolidations.

---

## 66.17 Epoch-Based Reclamation: Freeing Memory Without Locks

Latch-freedom creates a memory-safety problem: a thread may **CAS away** an old page/delta chain (consolidation, §66.16) while **another thread is still reading it** (holding a raw pointer it got from the mapping table before the swap). You cannot `free` the old chain immediately — that would be a use-after-free (Ch. 26 §26.x, the classic lock-free reclamation problem). The Bw-tree uses **epoch-based reclamation (EBR)**.

The mechanism:

```
   Global epoch counter E, advanced periodically.
   Each thread, before touching Bw-tree memory, JOINS the current epoch e
     (announces "I am active in epoch e").
   When a thread removes an object (old delta chain), it does NOT free it;
     it places it on the GARBAGE LIST of the current epoch.
   An epoch's garbage may be freed only once NO thread remains active in
     that epoch OR any earlier one — i.e., every reader that could hold a
     pointer to the removed object has since left.
```

Why it is safe and cheap:

- A thread's **epoch membership** is a promise: "while I'm in epoch e, don't free anything retired in e or later, because I might be pointing at it." Once the thread exits (finishes its operation), it's gone from e.
- Garbage retired in epoch e is reclaimed only when the **oldest active epoch has advanced past e**, guaranteeing no live thread can still hold a reference. This is a coarse-grained, batched alternative to per-object reference counting or hazard pointers (Ch. 26) — cheaper on the hot path (just join/leave an epoch, no per-access atomic on each object) at the cost of *deferred*, batched freeing.
- The failure mode mirrors MVCC again: a thread that **stalls inside an epoch** (never leaves) pins all garbage from that epoch onward, growing memory — the same "oldest reader is the reclamation horizon" pattern as LMDB's free list (§66.7) and Postgres's VACUUM. The pattern recurs across every non-blocking, multi-version design in this chapter.

EBR is why the Bw-tree can be latch-free *and* memory-safe: readers never take a lock, and freeing is deferred until provably safe by epoch advancement.

---

## 66.18 LLAMA: Log-Structured Storage Under the Bw-Tree

The Bw-tree's *access-method* logic (mapping table, deltas, SMOs) is deliberately separated from its *storage-management* layer, called **LLAMA** (Latch-free, Log-structured Access-Method Aware). LLAMA is what turns the in-memory delta chains into a durable, cache-managed, flash-friendly store — and it is a direct preview of the log-structured ideas in Chapter 67.

What LLAMA provides beneath the Bw-tree:

- **The mapping table lives here.** LLAMA owns the `PID → pointer` indirection, and the pointer may be a **RAM address** (page cached in memory) *or* a **flash offset** (page currently only on the log). The Bw-tree above doesn't know or care which — it just follows PIDs. This is the same page-cache indirection every engine needs, made explicit and latch-free.

- **Log-structured writes.** Pages and deltas are flushed to storage by **appending** them to a sequential log (never overwriting), exactly the log-structured pattern (Ch. 67). Because the mapping table is the single source of truth for where a PID currently lives, the log can be written sequentially and compacted/garbage-collected in the background — random in-place writes are eliminated. A **flush delta** records that a page has been persisted.

- **Latch-free cache management.** Eviction, flushing, and the swap between RAM and flush-offset representations are all done through CAS on mapping-table slots, so the storage layer is as lock-free as the tree above it.

The clean layering — **access method (Bw-tree) on top, log-structured storage (LLAMA) underneath, mapping table as the seam** — is the Deuteronomy architecture's central idea: a latch-free ordered index that is agnostic to whether its pages are in memory or on a log-structured flash store. For interviews, the one-liner is: *the Bw-tree gets latch-freedom from the mapping table and CAS; LLAMA gives it log-structured, flash-optimized, in-place-free durability — sequential writes like an LSM tree, but under a B-tree index.*

---

## 66.19 Cache-Oblivious B-Trees and the van Emde Boas Layout

The final variant attacks a different assumption entirely: that you must **know the block size** to lay out a B-tree well. A classic B-tree's node size is tuned to the disk/SSD block (Ch. 63) — and to *the* block, singular. But a real machine has a **hierarchy** of block sizes: L1/L2/L3 cache lines and levels (Ch. 28), a TLB page (Ch. 32), a disk block. A structure tuned for the disk block is not tuned for the L2 cache. A **cache-oblivious** B-tree is laid out to be **asymptotically optimal at *every* level of the hierarchy simultaneously, without knowing any of their sizes** (Ch. 23's cache-oblivious algorithms).

The trick is the **van Emde Boas (vEB) recursive layout** of the tree in memory/file:

```
   Take a complete tree of height h. Split it horizontally in the MIDDLE:
     • one TOP subtree of height h/2
     • about √N BOTTOM subtrees, each of height h/2
   Lay out RECURSIVELY: store the entire top subtree (itself vEB-laid-out)
   contiguously, then each bottom subtree (each vEB-laid-out) contiguously.

        ┌─────────────────────────────────────────────┐
        │  [ top subtree ]  [ bottom₁ ] [ bottom₂ ] …  │   contiguous in memory
        └─────────────────────────────────────────────┘
                 h/2 tall        each h/2 tall

   vs BFS layout (level-by-level) or DFS layout — the vEB split is what
   makes any block size B capture a whole √B-ish contiguous chunk of a path.
```

Why this is optimal regardless of `B`: a root-to-leaf search touches `O(log N)` nodes. Under the vEB layout, for **any** block size `B`, a contiguous run of about `log B` levels of any search path falls within a single recursive block, so the whole path crosses only `O(log_B N)` blocks — the *same* asymptotic block-transfer bound a B-tree tuned specifically for `B` achieves — **but the layout never mentions `B`.** One structure is therefore simultaneously cache-efficient at the L2 line size, the page size, and the disk block size. This is the payoff of cache-obliviousness (Ch. 23): optimal across the whole memory hierarchy (Ch. 28) with a single, block-size-agnostic layout.

The honest caveat: cache-oblivious B-trees (and their dynamic cousins, the **cache-oblivious lookahead array**, COLA — the structure behind TokuDB's earliest prototypes) are largely **research / niche** structures. Their constant factors and the cost of maintaining the recursive layout under updates make cache-*aware* B-trees (tuned to the one block size that dominates) the pragmatic production choice. But the idea is a favorite theory-flavored interview question, and it explains *why* B-tree node sizing is a tuning decision at all.

---

## 66.20 Putting It Together: The Comparison Table

The one table to internalize. Every entry answers "how does this deviate from Postgres nbtree, and what does that buy?"

| Variant | Write strategy | Concurrency | Torn-page / WAL | Write amp | Read amp | Who uses it |
|---|---|---|---|---|---|---|
| **Classic in-place** (baseline) | Overwrite page in place | Latch coupling + B-link | Torn-page risk → **needs WAL + FPW/doublewrite** | High (full page) | Low (1 leaf) | **PostgreSQL nbtree**, InnoDB, Oracle |
| **Copy-on-write** | New copy of root→leaf path; swap root | **Single writer** / multi-reader (MVCC) | **No torn page, no WAL** | High per write (h pages) | Low | **LMDB**, BoltDB, WiredTiger (at checkpoint) |
| **Lazy / buffered (page)** | In-mem image + update list; reconcile in batches | Hazard-pointer reads; block-COW | Block-level COW + **journal** | Low (amortized) | Low–med (update lists) | **WiredTiger** (MongoDB) |
| **Bε-tree / fractal** | Message buffers in internal nodes; cascade down | Latches | WAL for buffered messages | **Low** (`~log/B^{1-ε}`) | Med (scan `h` buffers) | **TokuDB / PerconaFT**, TokuMX |
| **FD-tree** | Leveled sorted runs, sequential merges | Latches | — | Low (sequential) | Med → cut by **fractional cascading** | Research (flash) |
| **Bw-tree** | Prepend **delta records**; log-structured (LLAMA) | **Latch-free** (mapping table + CAS) | No in-place; log-structured | Low | Med (replay delta chain) | **SQL Server Hekaton**, Cosmos DB |
| **Cache-oblivious** | (layout technique, orthogonal) | — | — | — | Optimal at **all** block sizes | Research (COLA→TokuDB roots) |

How to choose, in one breath each:

- **Read-mostly, embedded, must-not-lose-data, tiny code** → copy-on-write (LMDB).
- **Mixed OLTP with bursts of writes, needs range scans, general-purpose document store** → lazy/buffered (WiredTiger / MongoDB).
- **Insert- and update-heavy, wants LSM-like write throughput but B-tree point queries and cheap schema changes** → Bε-tree (TokuDB).
- **Many-core, in-memory, latch contention is the wall** → latch-free (Bw-tree / Hekaton).
- **Classic mixed workload, mature ecosystem, MVCC in the heap** → the in-place baseline (Postgres). Sometimes the boring answer is the right one, and knowing *when* the exotic variants are overkill is itself the senior-level answer.

---

## Summary

- The classic **in-place, mutable, latch-coupled** B-tree (PostgreSQL `nbtree`, InnoDB) is the baseline. Its costs — full-page write amplification, torn-page risk (needing WAL + full-page-writes/doublewrite), random writes, and hot-page latch contention — motivate every variant.
- **Copy-on-write B-trees** (LMDB) never overwrite: they copy the root→leaf path and atomically swap the root. This eliminates torn pages and the WAL, and gives free MVCC snapshots, at the cost of copying `h` pages per update and needing space reclamation (a free-list B-tree keyed by txnid; long readers pin garbage). LMDB adds single-writer/multi-reader concurrency, a memory-mapped zero-copy design, and crash-safe **two-meta-page ping-pong** commits.
- The **update abstraction** lets one B-tree codebase be in-place *or* copy-on-write behind a `updateNode` interface; the only difference is whether the update returns a new page id that must bubble up.
- **Lazy/buffered B-trees** attack write amplification by batching. **WiredTiger** (MongoDB's default) keeps mutable in-memory page images with update lists and **reconciles** them into immutable on-disk images written copy-on-write by a **block manager** at **checkpoints**, with a journal for between-checkpoint durability.
- **Bε-trees / fractal trees** (TokuDB/PerconaFT) put **message buffers** in internal nodes; inserts land in the root buffer and cascade down in batches. The parameter **ε ∈ [0,1]** is a continuous dial between a B-tree (ε=1: fast reads, slow writes) and an LSM-like structure (ε→0: fast writes, slower reads); ε=½ gives ~√B cheaper inserts for 2× costlier point queries.
- **FD-trees** use leveled sorted runs (sequential merges, like LSM) plus **fractional cascading** (fence pointers down levels) to keep multi-level search near single-tree cost.
- **Bw-trees** (SQL Server Hekaton) are **latch-free**: a **mapping table** (`PID → pointer`) makes every page update a single **compare-and-swap** installing a prepended **delta record**; splits/merges are multi-step CAS **SMOs** using B-link side pointers and cooperative helping; memory is reclaimed with **epoch-based reclamation**; **LLAMA** provides log-structured, flash-friendly durability underneath.
- **Cache-oblivious B-trees** use the recursive **van Emde Boas layout** to be block-transfer-optimal at *every* level of the memory hierarchy without knowing any block size — elegant theory, mostly research in practice.
- **Almost none of these are Postgres.** The interview skill is naming who uses what (LMDB=COW, WiredTiger=buffered, TokuDB=Bε, Hekaton=Bw) and what each trade buys.

---

## Key Interview Questions

1. **Why do B-tree variants exist at all?** — The classic in-place B-tree has four structural costs: full-page write amplification (dirtying an 8–16 KB page for a 20-byte change), torn-page risk that forces a WAL plus full-page-writes/doublewrite, random write I/O, and latch contention on hot pages. Each variant renegotiates one of these.
2. **Is PostgreSQL's B-tree any of these variants?** — No. Postgres uses a classic in-place, latch-coupled Lehman-Yao B⁺-link tree (`nbtree`) and always has. MVCC lives in the heap, not the index. The variants describe what *other* engines (LMDB, WiredTiger, TokuDB, Hekaton) do differently.
3. **What is a copy-on-write B-tree?** — One that never overwrites a page: to change a leaf it writes new copies of every page on the root-to-leaf path, then atomically swaps a single "current root" pointer. Old pages remain a valid snapshot. It is shadow paging applied to a B-tree.
4. **How does copy-on-write eliminate the write-ahead log?** — The commit is a single atomic root-pointer flip; before it the old tree is fully intact, after it the new tree is complete, so there is no torn-page window and nothing to redo/undo. The tree structure itself provides atomicity, so no separate log is needed for it.
5. **What is the cost of copy-on-write?** — Every update rewrites `h` pages (tree height, ~3–5) even for a one-byte change — a write-amplification tax — and superseded pages become garbage that must be reclaimed, or the file grows without bound.
6. **Describe LMDB's core design.** — A single memory-mapped file (zero-copy reads via pointer dereference, OS page cache as the cache), copy-on-write B-tree, single-writer/multi-reader MVCC, no WAL, and crash-safe commits via two-meta-page double-buffering. Optimized for read-mostly, durable, tiny-code embedded use.
7. **Why does LMDB allow only one writer at a time?** — Copy-on-write makes concurrent writers hard to reconcile (each would produce its own new root). Serializing writers with a single mutex turns that into a non-problem; readers stay lock-free on immutable snapshots, so writers never block readers and vice versa.
8. **How does LMDB commit atomically and durably without a log?** — It keeps two meta pages and alternates (ping-pong) which one each commit writes. It `fsync`s the new data pages first, then writes the new root/txnid into the *other* meta page and `fsync`s it. Recovery reads both meta pages and adopts the one with the higher valid txnid; a crash mid-commit falls back to the intact previous meta page.
9. **How does LMDB reclaim space, and what breaks it?** — A free-list B-tree keyed by the txnid that freed each page; pages are reusable once no live reader has a snapshot old enough to still reference them. A long-lived read transaction pins an old snapshot, blocking reclamation and bloating the file — the same "oldest reader is the horizon" problem as Postgres VACUUM.
10. **What is the "update abstraction" and why does it matter?** — A `updateNode(node, change)` interface behind which the engine implements either in-place mutation or copy-on-write, so the invariant-heavy B-tree algorithms are written once. The only difference is that COW returns a new page id, which forces the parent to update and path-copying to propagate.
11. **What is a lazy / buffered B-tree?** — One that batches updates instead of pushing each to its leaf immediately, converting many small random page writes into fewer larger writes. Two flavors: buffer whole pages in memory and flush lazily (WiredTiger), or buffer per-node update messages that cascade down (Bε-tree/LA-tree).
12. **Explain WiredTiger's architecture.** — An in-memory B-tree of pages, each holding a clean on-disk image plus an update-list skiplist of unapplied modifications; a **reconciliation** step folds updates into fresh immutable on-disk page images; a **block manager** writes them copy-on-write to new locations; **checkpoints** are the tree's durability boundary, with a journal/WAL for between-checkpoint commits. It is MongoDB's default engine.
13. **What is reconciliation in WiredTiger?** — The process that turns an in-memory page (base image + update lists) into one or more clean on-disk page images, choosing checkpoint-visible values and performing splits/merges. It is where buffered in-memory updates are batched into a single durable write.
14. **Does WiredTiger use a WAL if it's copy-on-write?** — Yes, a journal. Its on-disk tree only advances at checkpoints (default ~60 s), so between checkpoints individual commit durability comes from the journal (fsync ~every 100 ms). This differs from LMDB, whose per-transaction commits are themselves durable, so it needs no log.
15. **What is a Bε-tree?** — A B-tree whose internal nodes reserve space for a **message buffer** of pending inserts/deletes. Writes go into the root buffer (one cheap write) and cascade down in batches when buffers fill; reads check every buffer on the path. It amortizes write cost heavily while keeping ordered range access.
16. **What does the ε parameter control?** — The split of each node between pivots (fraction ~`B^ε`, setting fan-out) and buffer. ε=1 is an ordinary B-tree (fast reads, one I/O per insert); ε→0 is an LSM-like structure (max insert amortization, costlier queries); ε=½ gives ~√B cheaper inserts for ~2× point-query cost. It is a continuous dial between a B-tree and an LSM tree.
17. **What is a fractal tree and who ships it?** — Tokutek's commercial name for their Bε-tree implementation, shipped in **TokuDB** (MySQL) and **PerconaFT**/TokuMX. Its selling points were LSM-like insert throughput with B-tree point queries, cheap online schema changes (injected as broadcast messages), and high compression from large nodes.
18. **What is fractional cascading and where is it used?** — Embedding fence pointers from one sorted level into the level above so that, after locating a key at one level, you jump directly to its neighborhood at the next level instead of searching from scratch. FD-trees use it to keep multi-level search near single-tree `O(log n)` despite spreading data across leveled runs.
19. **What is a Bw-tree and what problem does it solve?** — A **latch-free** B-tree (Microsoft, used in SQL Server Hekaton and Cosmos DB) that removes latch contention on many-core hardware. All updates are done with compare-and-swap via a mapping table and delta records — no thread ever blocks on a page latch.
20. **How does the Bw-tree's mapping table enable latch-freedom?** — Inter-node references hold logical page ids (PIDs), and a central mapping table resolves `PID → physical pointer`. Updating a page is a single CAS on its table slot; no other node changes, because they all reference the stable PID. Indirection makes the update atomic and local.
21. **What are delta records in a Bw-tree?** — Small records describing a change (insert/delete key), prepended to a page by CASing the mapping-table slot to point at the new delta whose "next" is the old head. A page becomes a base image plus a delta chain; reads replay the chain newest-first. The CAS is the linearization point; failure means retry.
22. **How does a Bw-tree consolidate, and why?** — Long delta chains slow reads and waste memory, so when a chain exceeds a threshold a thread builds a fresh consolidated base page folding in all deltas and CAS-installs it; on CAS failure it discards and retries. The old chain becomes epoch garbage.
23. **How does a Bw-tree split a node without latches?** — As a multi-step SMO of single CAS steps that leaves a *correct* intermediate state: first install a split delta on the child with a B-link side pointer (readers already reach the moved keys via the side-link), then install an index-term delta on the parent. A thread arriving mid-split cooperatively completes the missing step.
24. **Why does the Bw-tree need epoch-based reclamation?** — Because a thread may CAS away an old delta chain while another thread still holds a raw pointer to it, freeing immediately would be a use-after-free. EBR defers freeing an epoch's garbage until no thread remains active in that epoch or earlier, guaranteeing no live reference survives.
25. **What is LLAMA?** — The latch-free, log-structured storage layer beneath the Bw-tree. It owns the mapping table (a PID may resolve to RAM or a flash offset), appends pages/deltas sequentially to a log (no in-place writes), and manages caching/eviction with CAS. It gives the Bw-tree LSM-like sequential-write durability under a B-tree index.
26. **What is a cache-oblivious B-tree?** — A B-tree laid out (via the recursive van Emde Boas layout) to be block-transfer-optimal at every level of the memory hierarchy at once, without knowing any block size. A search crosses `O(log_B N)` blocks for *any* B, matching a B-tree specifically tuned to B, but the layout never mentions B.
27. **How does the van Emde Boas layout work?** — Recursively split a tree of height `h` into a top subtree of height `h/2` and ~√N bottom subtrees of height `h/2`, storing each recursively-laid-out subtree contiguously. This packs about `log B` consecutive levels of any path into a single block for any B.
28. **Why are cache-oblivious B-trees rare in production?** — Their constant factors and the cost of maintaining the recursive layout under updates make cache-*aware* B-trees (tuned to the one dominant block size) the pragmatic choice. They matter as theory and as the COLA structure behind TokuDB's earliest prototypes.
29. **Which engine uses which variant? Give the map.** — LMDB = copy-on-write + single-writer; WiredTiger (MongoDB) = buffered in-memory images + copy-on-write checkpoints; TokuDB/PerconaFT = Bε-tree/fractal trees; SQL Server Hekaton / Cosmos DB = Bw-tree (latch-free); PostgreSQL/InnoDB = classic in-place baseline.
30. **When is the boring in-place Postgres B-tree the right answer?** — For classic mixed OLTP with a mature ecosystem where MVCC in the heap and the WAL are acceptable, and where neither write amplification nor many-core latch contention is the binding constraint. Reaching for a Bw-tree or Bε-tree when a plain B-tree suffices is over-engineering; knowing when the exotic variant is overkill is a senior-level answer.

---

## Common Traps

- **Claiming Postgres uses copy-on-write or a Bw-tree.** Postgres uses a classic in-place Lehman-Yao B⁺-link tree; its MVCC lives in the heap tuples, not in the index. COW/Bw/Bε are what *other* engines do.
- **Saying copy-on-write needs no durability mechanism at all.** It needs no *WAL for atomicity*, but it still must `fsync` new data pages and the meta/root before the commit counts; durability still costs a flush.
- **Forgetting that copy-on-write and Bw-tree and LMDB all have the "oldest reader pins garbage" failure mode.** A long reader (LMDB free-list), a stalled thread (Bw-tree epoch), or a long transaction (Postgres VACUUM) all block reclamation and bloat storage — the same MVCC horizon problem.
- **Thinking LMDB's two meta pages are for two databases or replicas.** They are a ping-pong double buffer for crash-atomic commits: writes alternate meta slots so the previous committed root is always intact as a fallback.
- **Assuming a Bε-tree read only touches the leaf.** A read must check the message buffer at *every* node on the root-to-leaf path, because a newer insert/delete may still be buffered above the leaf — that is the read-amplification cost of buffering.
- **Treating ε as a fixed constant rather than a tunable knob.** ε ∈ [0,1] continuously interpolates between a B-tree (ε=1) and an LSM-like structure (ε→0); the whole point is that it dials the read/write trade-off.
- **Believing the Bw-tree takes a lock during splits because two pages change.** It performs splits as multi-step single-CAS SMOs with a B-link side pointer and cooperative helping, so the half-done state is already correct and searchable — no latch is ever held.
- **Confusing consolidation with reclamation in the Bw-tree.** Consolidation folds a delta chain into a fresh base page (a read-speed optimization); epoch-based reclamation is the separate mechanism that safely frees the now-garbage old chain.
- **Saying WiredTiger has no WAL because it's copy-on-write.** It keeps a journal for between-checkpoint commit durability; block-level COW only protects the *checkpointed* tree, and checkpoints are ~60 s apart.
- **Assuming cache-oblivious means "ignores the cache."** It means optimal *without being told* the block sizes — simultaneously efficient at every hierarchy level via the vEB layout, not indifferent to caching.
- **Mixing up the two axes.** "How writes reach disk" (in-place / COW / buffered / delta-log) and "how concurrency works" (latch coupling / single-writer / latch-free CAS) are independent; each engine picks one from each, e.g. LMDB is COW + single-writer while the Bw-tree is delta-log + latch-free.
- **Calling fractal trees and Bε-trees different structures.** "Fractal tree" is Tokutek's marketing name for their Bε-tree implementation; the message-buffer mechanism is identical.
