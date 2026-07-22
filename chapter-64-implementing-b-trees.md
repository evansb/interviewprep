# Chapter 64 — Implementing B-Trees

*Interview-focused revision notes. The theme: a textbook B-tree is a clean recursive structure; a production B-tree is a pile of engineering hacks bolted onto that structure so it can survive concurrent readers and writers, oversized values, monotonic-key hot spots, and years of deletes without a global lock or a rebuild. PostgreSQL's `nbtree` is the reference, and its one non-negotiable design choice — the Lehman & Yao B-link tree — is what lets a reader descend the tree while a writer splits it out from under them. Everything else in this chapter is bookkeeping around that idea.*

---

## 64.1 The B-Tree Node Header

A B-tree node is a page (Ch. 63 §63.2). Its keys and downlinks are the interesting payload, but the fixed **header** at the top of the page is what makes the structure navigable, recoverable, and concurrency-safe. Chapter 62 (§62.x) gave you the abstract node — keys, separators, pointers; this chapter is about the bytes that wrap them.

Every B-tree page carries, in some form:

- **Flags / page type.** Is this a leaf, an internal node, the root, the metapage, a freshly-deleted page? A single byte or two of bit-flags. You cannot infer a node's role from its contents alone — a leaf and an internal node have the same slotted-page shape (Ch. 63 §63.3).
- **Free-space pointers.** Where the used region ends and free space begins, so an insert knows whether the key fits without a split. In a slotted page this is the pair *(lower, upper)*: the slot array grows down from `lower`, the cells grow up from `upper`, and free space is the gap between them.
- **Level.** The node's distance from the leaves. Leaves are level 0; the level increases toward the root. Level lets code assert invariants ("a downlink must point one level down") and lets concurrent descent know when it has reached a leaf.
- **Page LSN.** The log sequence number of the last WAL record that modified this page (Ch. 65). The buffer manager enforces **write-ahead logging**: a dirty page may not be flushed to disk until the WAL up to its `pd_lsn` is durable. The LSN is also how crash recovery decides whether a logged change has already been applied to a page (idempotent redo).

PostgreSQL makes this concrete. Every 8 KB page (`BLCKSZ = 8192`) opens with a 24-byte `PageHeaderData`:

```
PostgreSQL PageHeaderData (24 bytes), same for heap and index pages
┌────────────────┬──────────────────────────────────────────────┐
│ pd_lsn      8B │ LSN: xlog position of last change (WAL rule)  │
│ pd_checksum 2B │ page checksum (if data checksums enabled)     │
│ pd_flags    2B │ page-level flags (has free lines, all-visible…)│
│ pd_lower    2B │ offset to end of line-pointer array  ┐ free   │
│ pd_upper    2B │ offset to start of tuples            ┘ space  │
│ pd_special  2B │ offset to special space (AM-specific)         │
│ pd_pagesize │ page size + layout version                       │
│  _version 2B   │                                               │
│ pd_prune_xid4B │ oldest un-pruned XID hint (heap); 0 on index  │
└────────────────┴──────────────────────────────────────────────┘
```

`nbtree` then reserves a 16-byte **special space** at the very end of the page (`pd_special` points to it) for its own opaque header, `BTPageOpaqueData` (§64.3). So a B-tree page is: 24-byte generic header, then the line-pointer array growing down, free space, cells growing up, and a 16-byte B-tree footer. The usable middle is roughly `8192 − 24 − 16 = 8152` bytes, minus alignment.

The interview point: **a node's header is not overhead you tolerate; it is the part that makes the node safe.** The LSN enforces durability ordering, the level enforces structural invariants, the free-space pointers make splits decidable in O(1), and the flags let a reader that arrives at a page know instantly what it is holding.

---

## 64.2 Magic Numbers and the Metapage

How does the engine know a page it just read from disk is a valid B-tree page of the expected version, and not garbage, a torn write (Ch. 63 §63.x), or a page from an older on-disk format? **Magic numbers** and a **version field**, usually in a dedicated **metapage**.

A magic number is a fixed constant written into a known offset; on read, the code asserts it matches. It is a cheap, high-value corruption and version check — a wrong magic number means "this is not what I think it is, refuse rather than misinterpret."

`nbtree` puts this in **block 0**, the **metapage**, which contains no keys at all — only metadata:

```
nbtree metapage (block 0), BTMetaPageData
  btm_magic     = 0x053162   (BTREE_MAGIC — refuse the relation if mismatched)
  btm_version   = 4          (BTREE_VERSION; v4 since PG 12: suffix truncation,
                              heap-TID as tiebreak, deduplication in v13)
  btm_root      → block # of the current root
  btm_level     = height of the tree above the leaves
  btm_fastroot  → block # of the "fast root" (see below)
  btm_fastlevel = level of the fast root
  btm_last_cleanup_num_delpages, ...  (VACUUM bookkeeping, §64.19)
```

Two subtleties worth carrying into an interview:

- **The root is not at a fixed block.** Because the root splits and moves, block 0 is a *stable* metapage holding a *pointer* to the current root, not the root itself. Every descent starts by reading the metapage (almost always cached) to learn where the root is.
- **The "fast root."** When the top of the tree is a chain of single-child internal pages (an artifact of mass deletion), `nbtree` records a **fast root** lower down so descents can skip the degenerate spine. `btm_fastroot`/`btm_fastlevel` name it. The true root is retained for correctness; the fast root is an optimization.

The **version number** is what lets a new server read an old index: `nbtree` version 2 (pre-9.4), 3 (9.4), and 4 (12+) coexist on disk, and features like suffix truncation (§64.16) and deduplication (§64.17) require version 4. A `pg_upgrade`'d index stays at its old version until `REINDEX` (§64.20) rewrites it — which is why some optimizations "don't kick in" until you rebuild.

---

## 64.3 Sibling Links and Rightmost Pointers

A textbook B-tree is a pure tree: each node knows its children, and you navigate top-down. Real B-trees add **sibling links** — horizontal pointers between adjacent nodes *at the same level* — turning each level into a **doubly-linked list**. This is a B⁺-tree/B-link-tree elaboration and it is central to both range scans and concurrency.

`nbtree`'s 16-byte opaque footer:

```c
typedef struct BTPageOpaqueData {
    BlockNumber btpo_prev;    /* left sibling  (P_NONE if leftmost)  */
    BlockNumber btpo_next;    /* right sibling (P_NONE if rightmost) */
    uint32      btpo_level;   /* 0 = leaf, increasing upward         */
    uint16      btpo_flags;   /* BTP_LEAF|BTP_ROOT|BTP_DELETED|...    */
    BTCycleId   btpo_cycleid; /* vacuum cycle that split this page    */
} BTPageOpaqueData;           /* 16 bytes                            */
```

```
Level 1 (internal): [ A ]⇄[ B ]⇄[ C ]          btpo_prev / btpo_next chains
                      │      │      │            link every level, not just leaves
Level 0 (leaves):   [10 20]⇄[30 40]⇄[50 60 70]→ (range scans walk right here)
                       ↑leftmost         rightmost↑ (btpo_next = P_NONE)
```

Why sibling links matter:

- **Range scans and ordered iteration.** `SELECT ... WHERE k BETWEEN 30 AND 70 ORDER BY k` descends once to the leaf containing 30, then walks **`btpo_next`** across leaves without re-descending the tree. `ORDER BY k DESC` walks `btpo_prev`. Without sibling links every "next leaf" would be another root-to-leaf traversal.
- **Concurrent structure modification (the big one).** The right-link is the escape hatch a reader uses when a writer has split a node out from under it (§64.10–64.12). This is the whole reason Lehman-Yao needs the links; range scans are a happy side benefit.

`nbtree` links **every** level, not just the leaves — internal levels are doubly-linked lists too, because the B-link "move right" trick must work at every level of a concurrent descent, not only at the bottom.

A **rightmost pointer** is the degenerate case: the rightmost node at each level has `btpo_next = P_NONE`. Internal nodes also need a rightmost *child* pointer — a downlink for keys greater than every separator. `nbtree` handles this by making the internal node's first slot a "minus-infinity" downlink with no key and letting the high key (§64.4) bound the top; the practical effect is that an internal node with *n* separators has *n+1* children, the last of which covers "everything above the last separator."

---

## 64.4 High Keys

A **high key** is a copy of an **upper bound** on every key that the node (and its subtree) may contain, stored *inside the node itself*. It is the single most important auxiliary field for concurrent B-trees, and it is easy to underrate.

In `nbtree`, a non-rightmost page stores its high key as the **first item** on the page (slot `P_HIKEY`, offset 1); real data keys start at slot 2 (`P_FIRSTDATAKEY`). The rightmost page at each level has **no** high key — its implicit upper bound is +∞.

```
Leaf with high key = 40 (an upper bound; keys on the page are strictly < the
high key of the page to its right, i.e. this page owns [.., 40) )

  [ HIKEY=40 | 30 | 35 | 38 ]  ⇄next⇄  [ HIKEY=70 | 40 | 55 | 60 ]  ⇄  ...
       slot1   slot2 …               the right page owns [40, 70)
```

The high key answers a precise question: *"could the key I am searching for live to the right of this page?"* If `search_key >= high_key`, the answer is yes — the item I want is not here, move right. If `search_key < high_key`, this page is the correct one (or the item does not exist).

Two distinct roles:

1. **A separator that stays valid across splits.** When a page splits, the high key of the left half becomes the new split point. Because the high key is *inside* the page, it travels with the page and does not depend on the parent being updated yet.
2. **The "move right" test in Lehman-Yao (§64.11).** A descending reader that finds `search_key >= high_key` knows a concurrent split has happened and that the data moved to the right sibling. It follows `btpo_next` instead of failing — *without holding any lock on the parent.* The high key + right-link pair is exactly what makes lock-free-ish descent correct.

The high key is also what the parent's downlink separator is *derived from*: when a split installs a new downlink in the parent, that downlink key is (a truncated form of, §64.16) the left page's new high key. So the same value appears twice — once as the child's high key, once as the parent's separator — and the child's copy is authoritative during the window when the parent has not yet been updated.

---

## 64.5 Binary Search Within a Node

Finding a key *within* a node of a few hundred entries is a plain **binary search**, but the layout adds a twist: the entries are variable-length cells scattered across the page, so you cannot binary-search the cells directly. You binary-search the **slot array** (the sorted array of line pointers / item ids), and dereference each probed slot to reach its cell.

```
Slotted page:            slot array (fixed 4-byte ItemIds, sorted by key)
  [lp0][lp1][lp2][lp3][lp4]...          ← binary search THIS (random access, O(1)/slot)
     │    │    │
     ▼    ▼    ▼
  cells: variable-length (key,TID) at arbitrary offsets, NOT contiguous, NOT sorted
```

Because each `ItemIdData` is a fixed 4 bytes, the slot array is a dense sorted array you can index in O(1): `lo`, `hi`, `mid = (lo+hi)/2`, read `slot[mid]`, follow it to the cell, compare the cell's key to the search key, recurse. This is **binary search with an indirection level** — the comparison target is one pointer-dereference away from the array being searched. `nbtree`'s `_bt_binsrch` does exactly this on the `ItemId` array.

Costs and consequences interviewers probe:

- **Comparisons per node:** `⌈log₂(fanout)⌉` — about 8–9 for a 300–500-entry page. A 4-level tree therefore does ~32–40 key comparisons total, most against **cached** upper levels.
- **Cache behavior:** each probe touches the small slot array (good locality) plus one scattered cell (a likely cache miss). Comparison cost is dominated by the cell dereference, which is why fixed-width, prefix-truncated separators (§64.16) that let you compare fewer bytes matter.
- **Comparator cost:** the compare is a type-specific operator (`btint4cmp`, `bttextcmp`, a collation-aware call for `text`). Collation comparisons are far more expensive than integer ones — a reason `text` indexes with heavy collations are slower to probe, and a reason `C` collation or `text_pattern_ops` speeds them up.
- **Insertion position:** the same binary search returns the insertion point for a new key, so search and insert share one routine.

A refinement some engines use is an **indirection / offset table of prefixes** — storing a small fixed-size prefix of each key alongside the slot so most comparisons are resolved without touching the full cell. `nbtree` does not keep a separate prefix array, but suffix truncation (§64.16) achieves a related effect by making separator keys short.

---

## 64.6 Oversized Keys and Values: Overflow Pages versus TOAST

A B-tree only works if a node holds a useful **fanout** — at least a handful of keys per page. A key or value larger than (roughly) a fraction of a page would blow that up: a 4 KB value in an 8 KB page gives a fanout of one, degenerating the tree into a linked list. Every B-tree needs an answer for "what if a datum is too big for a node?"

**The classic answer: overflow pages.** Store as much of the cell as fits in the node and **spill the remainder to a chain of overflow pages** linked off the cell. The node keeps a fixed-size stub (enough to compare and a pointer to the overflow chain); the bulk lives out-of-line.

- **SQLite** does exactly this. A cell that exceeds the page's usable payload keeps a prefix on the page and links the rest through a singly-linked list of overflow pages (each overflow page is `pagesize − 4` bytes of payload plus a 4-byte next-page pointer). The thresholds (`maxLocal`/`minLocal`) are tuned so pages stay reasonably full.
- **InnoDB** stores large `VARCHAR`/`BLOB`/`TEXT` columns off-page in **overflow (external) pages**, keeping a 20-byte pointer in the clustered-index record (`DYNAMIC`/`COMPRESSED` row formats push the whole column off-page; `COMPACT`/`REDUNDANT` keep a 768-byte prefix in-record).

**PostgreSQL's answer is different, and it is a favorite contrast.** `nbtree` has **no overflow pages**. Instead:

- **Heap values** use **TOAST** (The Oversized-Attribute Storage Technique): an attribute wider than `TOAST_TUPLE_THRESHOLD` (~2 KB, i.e. rows aimed at ~4 per page) is compressed and/or pushed to an out-of-line **TOAST table** (itself a heap with its own index), leaving an 18-byte TOAST pointer in the main tuple. TOAST is a *heap* mechanism.
- **Index tuples are simply capped.** A single B-tree entry may not exceed **`BTMaxItemSize` ≈ 2704 bytes** (about one-third of the page, chosen so at least three entries fit — the minimum for a valid split). Exceed it and you get the runtime error `index row size N exceeds btree version 4 maximum 2704`. The index does **not** silently spill to overflow pages.

The consequence: you cannot B-tree-index an arbitrarily large value in Postgres. The idioms are to index an **expression** — `CREATE INDEX ON t (md5(bigcol))` or `... (left(bigcol, 100))` — or to use a different access method (GIN for full-text, hash for equality-only). Note that TOAST and the index limit are orthogonal: TOAST shrinks the *heap tuple*, but the **index key is measured before TOASTing is relevant** because the index stores the key value itself, and a huge key still overflows `BTMaxItemSize`.

```
                 too-big datum?   mechanism            keeps in-node
  SQLite         overflow pages   linked overflow list prefix + next-ptr
  InnoDB (LOB)   overflow pages   external BLOB pages   ptr (+opt 768B prefix)
  Postgres heap  TOAST            out-of-line TOAST tbl 18-byte TOAST pointer
  Postgres index NONE — hard cap  error at 2704 bytes  (must index expr/hash)
```

---

## 64.7 Propagating Splits Up the Tree

Insertion is easy until a leaf fills. Then the node **splits**: allocate a new page, move roughly half the entries to it, and install a **new separator + downlink in the parent** so future descents can reach both halves. The parent may itself be full, so the split **propagates upward**, potentially all the way to a **root split** that grows the tree by one level. This is the *only* way a B-tree gets taller, and it is why B-trees grow from the leaves up, not the root down.

```
Before (leaf full):            After split of leaf, downlink pushed to parent:

parent: [ …| 40 |… ]           parent: [ …| 40 | 55 |… ]   ← new separator 55
              │                              │     │
leaf:   [40 45 50 55 60]        left:  [40 45 50]  right:[55 60]
        (no room for 52)         ↑ high key becomes 55, right-link → right
```

The mechanics, and where the subtlety lives:

1. **Choose a split point.** Textbook: the median, for a ~50/50 split. Real engines bias it. `nbtree`'s `_bt_findsplitloc` uses **fill-factor-aware** heuristics: a *rightmost* split (monotonic keys) packs the left page ~90–99% full so the new inserts flow right (§64.14); an interior split aims closer to 50/50; special "many duplicates" and "single value" strategies (PG 12+) avoid pathological splits when a key has huge cardinality skew.
2. **Derive the separator.** The separator pushed into the parent is a **truncated copy of the left page's new high key** (§64.16), chosen to be the shortest value that still discriminates left from right.
3. **Install the downlink in the parent.** Insert `(separator, right-page-block)` into the parent. If the parent overflows, split it too — recursion up the tree.
4. **Root split.** If the root splits, a **new root** is allocated pointing at the two halves, `btm_root`/`btm_level` in the metapage are updated, and the tree is now one level taller. Height changes happen *only here*.

Crash safety makes this delicate: a leaf split and the matching parent-downlink insert are **two page writes**, and a crash between them would orphan the right page (reachable only by right-link, missing from the parent). `nbtree` handles this atomically-enough by marking the left page `BTP_INCOMPLETE_SPLIT` and WAL-logging the split; the *next* descent (or `VACUUM`) that notices the flag finishes the parent insert. The right sibling is never lost because the **right-link is written first and is always followable** — which is precisely the Lehman-Yao guarantee (§64.11).

---

## 64.8 Breadcrumbs

To install a downlink after a split you must find the **parent** — but a plain descent only remembers the leaf. Re-descending from the root to find the parent is wasteful and, worse, racy under concurrency (the tree may have changed). The standard fix is **breadcrumbs**: while descending, remember the path — the page (and slot) visited at each level — so a split can walk *back up* the remembered path to insert each downlink without re-traversing.

```
Descent records a stack:            Split at leaf walks the stack upward:

  root (blk 3, slot 5)   ┐          insert downlink into blk 27 …
  internal(blk 27, slot 2)│ push    if blk 27 splits, pop → insert into blk 3
  leaf   (blk 91)        ┘          if blk 3 (root) splits → new root
```

`nbtree` implements this with a **`BTStack`**: `_bt_search` pushes a `BTStackData` frame `(bts_blkno, bts_offset)` for each internal page it passes through. On a leaf split, `_bt_insert`/`_bt_insertonpg` pops the stack to locate and update each parent.

The concurrency wrinkle — and why breadcrumbs alone are not enough — is that between recording a breadcrumb and using it, **the parent may itself have split**, so the remembered page might no longer be the correct parent (the downlink may now belong on the parent's right sibling). The breadcrumb is therefore treated as a **hint**, not a certainty: when following it up, the code re-checks the high key at that level and **moves right** (§64.11) if the target has moved. Breadcrumbs make the common case O(1) per level; the high-key/right-link machinery makes the racy case correct. This is a recurring pattern — *cache the path, but verify with the invariant.*

---

## 64.9 Merges and Rebalancing

Deletion is the mirror of insertion. Textbook B-trees keep every non-root node at least **half full** and, when a delete drops a node below that, either **borrow** an entry from a sibling (rebalance) or **merge** two under-full siblings into one and delete the now-orphaned separator from the parent, propagating the merge upward the way splits propagate. This keeps the tree balanced and bounds its height at `⌈log_fanout N⌉`.

That is the theory. **Production systems diverge sharply**, and the divergence is a great interview discriminator:

- **PostgreSQL does not merge under-full pages, and does not rebalance on delete.** A page that loses entries stays where it is; `nbtree` only reclaims a page when it becomes **entirely empty**, at which point `VACUUM` marks it deleted and eventually recycles it (§64.19). There is **no borrow-from-sibling, no half-full merge.** The reasons are (a) merging requires locking three pages (two siblings + parent) plus their neighbors, which is hostile to the concurrent-descent design; (b) MVCC means "deleted" tuples linger until `VACUUM` anyway; (c) empty-page recycling recovers most of the space with far less locking. The cost is that a B-tree that saw many deletes can stay **physically large with half-empty pages** — index bloat (§64.20).
- **InnoDB does merge.** When a page's fill falls below `MERGE_THRESHOLD` (default 50%) after a delete or update, InnoDB merges it with a sibling, taking a "pessimistic" latch on the index. This keeps InnoDB indexes denser than Postgres's over delete-heavy workloads, at the cost of more structure-modification contention.
- **SQLite** rebalances on delete (its `balance()` routine handles both directions) but, being single-writer, pays no concurrency price for it.

The takeaway: **"B-trees stay half full" is a textbook invariant, not a production guarantee.** Postgres deliberately trades the invariant away for concurrency and simplicity, which is exactly why Postgres has an index-bloat story and a `REINDEX` command and InnoDB's is milder.

---

## 64.10 The Concurrency Problem

Here is the problem the rest of the chapter exists to solve. A **reader is descending** the tree toward a leaf. Concurrently, a **writer splits** a node on the reader's path. If the timing is wrong, the reader can arrive at a page that **no longer contains the key it wants** — the key was moved to a newly-created right sibling that the reader never learned about, because the reader read the parent's downlink *before* the split installed the new one.

```
Reader reads parent downlink → block 91 (leaf), then pauses.
Writer splits block 91: keys ≥ 55 move to new block 210; parent gets a new
  downlink for 210. Reader resumes, lands on 91, searches for 60 — NOT THERE.
  Naively: reader reports "not found" for a key that exists. CORRUPTION of results.
```

The naïve fix is **locking the whole path**: a reader locks each node before releasing the parent, and a writer locks the entire root-to-leaf path it might split. Both are correct and both are catastrophic for concurrency — the writer's path lock serializes against every reader, and holding locks across I/O (the child might not be resident) stalls everyone. On a busy index the root becomes a global latch. There are two escapes, and they define the two schools of concurrent B-tree design:

1. **Latch coupling / crabbing (§64.13):** hold at most two locks at a time, hand-over-hand, and release the parent as soon as the child is known safe. Correct, widely used (InnoDB, DB2), but readers still take latches on internal pages.
2. **B-link trees / Lehman-Yao (§64.11–64.12):** add right-links and high keys so a reader that "misses" can **detect the miss and move right** to find the moved data, **without having locked the parent at all.** This is what Postgres `nbtree` uses, and it is why Postgres readers descend the tree taking only short per-page pins, never a path lock.

The distinction to state crisply in an interview: *crabbing prevents the race by locking; Lehman-Yao tolerates the race by making it recoverable.*

---

## 64.11 Lehman-Yao B-Link Trees

The **Lehman & Yao (1981)** B-link tree is the design that makes concurrent B-tree access scale, and it is the intellectual core of this chapter. Its insight: augment a B⁺-tree with two things already introduced —

- a **right-link** (`btpo_next`) at every level (§64.3), and
- a **high key** on every non-rightmost page (§64.4) —

and impose one rule: **a page split always writes the new right sibling and the splitting page's right-link/high-key *first*, and installs the parent downlink *second* (and lazily).** Between those two steps the tree is in a legal, navigable state: the moved data is reachable from the old page by following its right-link, and the high key tells you when to follow it.

This yields the **"move right" protocol** for any descent:

```
At each page P while searching for key k:
  1. binary-search P.
  2. if P is NOT rightmost and k >= P.high_key:
        a split moved my data right → follow P.btpo_next, retry at the sibling.
        (do this WITHOUT locking the parent; you may move right several times.)
  3. else descend to the child (internal) or return the match/absence (leaf).
```

Why it is correct: the **high key is a hard upper bound** on what P can hold. If `k >= high_key`, then `k` is *definitely* not on P and *definitely* on some page to the right (the right sibling's range starts at P's high key). Following the right-link is guaranteed to make progress toward the page that owns `k`, and the chain is guaranteed intact because splits publish the right-link before anything else. A reader can therefore descend with **no lock on the parent** and at most a short pin/lock on the single page it is examining; if a writer splits underneath it, the reader simply walks right until the high keys stop telling it to.

The properties that make this a landmark result:

- **Readers never block writers and vice versa on the descent path.** A reader holds at most one page at a time (plus the one it is moving to).
- **The tree is always in a consistent state**, even mid-split, because the "half-done" split (right-link written, parent not yet updated) is a *legal* B-link tree — just one where reaching the new page requires a move-right rather than a direct downlink.
- **Deferred parent updates are safe.** The parent downlink can be installed later (even by a different process) because the right-link already makes the new page reachable. This is what `BTP_INCOMPLETE_SPLIT` (§64.7) exploits.

The cost is a small amount of extra work on reads (occasional move-right hops) and the extra space for high keys and right-links — a cheap price for lock-free-ish descent.

---

## 64.12 How PostgreSQL nbtree Implements Lehman-Yao

`nbtree` is a faithful, battle-tested Lehman-Yao implementation with a few pragmatic deviations, and interviewers who know Postgres will want the specifics.

**Descent (`_bt_search` / `_bt_moveright`).** A search reads the metapage for the root, then at each level:
- Takes a **shared buffer content lock** (`BUFFER_LOCK_SHARE`) on the page — a short LWLock, not a heavyweight lock, held only while examining that one page.
- Calls **`_bt_moveright`**: if the search key is `≥` the page's high key, it releases the page, follows `btpo_next`, and repeats — the move-right protocol verbatim. This also handles the `BTP_INCOMPLETE_SPLIT` case by finishing the split before proceeding.
- Descends to the child, releasing the parent lock *before* locking the child. Crucially it does **not** couple locks on the read path — it relies on move-right for correctness, so at most one page is locked at a time. (This is a genuine Lehman-Yao property; crabbing engines cannot release the parent that early.)

**Insertion (`_bt_doinsert` / `_bt_insertonpg`).** The descent uses the breadcrumb `BTStack` (§64.8). At the leaf, it takes an **exclusive** content lock. If the key fits, it inserts and is done. If not, `_bt_split` runs: it write-locks the new right page and the old page, populates the right page, fixes right-links (`old.next` becomes `new`, `new.next` becomes the old `next`, and the old right-neighbor's `prev` is repointed), sets the old page's high key, WAL-logs the whole split as one record, and marks the old page `BTP_INCOMPLETE_SPLIT`. Then `_bt_insert_parent` walks the stack up to install the downlink, moving right at the parent level if the breadcrumb was stale.

**Deviations from pure Lehman-Yao worth naming:**
- **No `xmax`-style lock coupling on writes to internal pages beyond what's needed;** internal inserts still lock the target internal page exclusively, but reads never do.
- **Heap-TID as a tiebreaker (PG 12+).** Lehman-Yao assumes unique keys. Real indexes have duplicates. Postgres appends the **heap TID** as an implicit final key column, making every index key logically unique and giving duplicates a stable sort order. This is what makes suffix truncation and efficient duplicate handling possible, and it turned the "duplicate storm" pathology of pre-12 indexes into ordered, easily-split runs.
- **`_bt_moveright` also repairs incomplete splits it encounters**, so the deferred-parent-update window is closed opportunistically by whoever passes through next, not only by VACUUM.

**Vacuum interlock.** Because a reader may be paused mid-descent holding no lock on a page it is about to visit, VACUUM cannot simply delete and recycle a page a reader might still reach by a stale right-link. `nbtree` uses the `btpo_cycleid` and a delete-then-recycle-later protocol (§64.19) so that a page is only *recycled* once no in-flight scan can still be following a link to it.

The result: on a read-mostly workload, thousands of Postgres backends can descend the same hot index concurrently, each taking only brief shared page locks and never a path lock, precisely because of Lehman-Yao.

---

## 64.13 Latch Coupling and Crabbing

The alternative to B-link trees — and the design most textbooks and many engines use — is **latch coupling**, also called **crabbing** (you move like a crab, always holding on with one claw before releasing the other). Chapter 65 develops locking/latching in depth; here is the B-tree-specific shape.

```
Crabbing descent (read):        Crabbing descent (write, optimistic):
  lock(root, S)                   lock path with S latches …
  lock(child, S)                  … but take X only on the leaf if it
  unlock(root)   ← only after       won't split; if it might split,
  lock(grandchild, S)               restart "pessimistically" with X
  unlock(child) …                   latches down the path.
```

The rule: **acquire the child's latch before releasing the parent's.** At most two latches are held at once, so the race of §64.10 cannot occur — a splitter cannot modify a node while a descender holds it. For writes, an optimization takes **shared** latches down to the leaf and upgrades to exclusive only where a split is actually needed; a node is "**safe**" (release ancestors early) if an insert into it cannot cause a split (it has free space) or a delete cannot cause a merge (it is more than half full).

- **InnoDB** crabs. It holds an **index-level SX/S latch** plus per-page latches, using an *optimistic* descent (leaf-only X latch) that falls back to a *pessimistic* descent (X latches from a safe ancestor down) when a structure modification is required. This is why InnoDB's SMOs (structure modification operations) are heavier than Postgres's and why InnoDB benefits from its **adaptive hash index** to shortcut descents on hot keys.
- **DB2, SQL Server** use variants of latch coupling as well.

**Crabbing vs Lehman-Yao, head to head:**

| | Crabbing (InnoDB) | B-link / Lehman-Yao (Postgres) |
|---|---|---|
| Latches held on descent | two (hand-over-hand) | **one** (per page, briefly) |
| Reader vs writer on path | serialize via latch coupling | **do not block**; reader moves right |
| Handles the split race by | preventing it (locking) | tolerating it (right-link + high key) |
| Extra structure needed | none beyond latches | right-links + high keys on every page |
| Cost | latch contention near the root | occasional move-right hops |

The one-line summary to deliver: **crabbing is pessimistic (lock so the race can't happen); Lehman-Yao is optimistic (let the race happen and recover via right-links).** Postgres chose optimism; InnoDB chose pessimism, and buys back some of the cost with an adaptive hash index.

---

## 64.14 Right-Only Appends and the Rightmost-Leaf Fast Path

A hugely common workload is **monotonically increasing keys**: an `auto-increment`/`bigserial` primary key, a `created_at` timestamp, a sequence. Every insert lands at the **rightmost leaf**. This is both an opportunity (you can optimize the common path) and a hazard (the rightmost page is a write hot spot, and naïve 50/50 splits waste half the tree).

**The opportunity — a rightmost fast path.** For strictly increasing keys, a full root-to-leaf descent per insert is wasteful when the answer is almost always "the same rightmost leaf as last time." `nbtree` caches the block number of the leaf it last inserted into (in the relcache, `rd_amcache` / the `BTScanInsert` fast path in `_bt_search`/`_bt_findinsertloc`). On the next insert it **checks the cached rightmost leaf first**: if the new key is `> ` that page's second-to-last key and the page has room (and is still rightmost), it inserts there directly, skipping the descent entirely. A miss falls back to a normal descent. This turns an ascending-key bulk insert from `O(N log N)` page accesses into roughly `O(N)`.

**The hazard, and the split heuristic.** If the rightmost page split 50/50 like an interior page, then after every split the *left* half would be permanently half-empty (no key will ever be inserted into it again, since all future keys are larger). Over a long ascending load that wastes ~50% of the index. `nbtree`'s `_bt_findsplitloc` detects a **rightmost split** and packs the left page nearly full (governed by `fillfactor`, default 90 for B-trees, but rightmost splits skew even higher), leaving almost all new space on the right where the next inserts go. This is why an ascending-key index built by inserts is denser than an index over random keys — and why `fillfactor` matters differently for the two.

**The residual problem — contention.** Even with a fast path, the rightmost leaf (and its buffer content lock) is a single hot page every inserting backend contends on. This is the classic "**right-edge contention**" / "index insertion hot spot." Mitigations discussed in practice: hash/reverse the key to spread inserts (at the cost of range-scan locality), partition by time so the hot edge rotates, or accept it (a single page lock held microseconds is often fine). InnoDB has the same hot spot on ascending clustered keys — the reason its manual recommends monotonic PKs for locality yet warns about the "last page" contention under high concurrency.

---

## 64.15 Bulk Loading

Building a B-tree by **inserting keys one at a time** is the worst way to build one: every insert descends the tree, dirties a leaf, and periodically triggers a split that dirties ancestors and fragments the file. For `CREATE INDEX` on an existing table — millions of rows already present — engines instead **build the tree bottom-up from sorted data**, which is dramatically faster and produces a denser, less-fragmented index.

`nbtree`'s sorted build (`nbtsort.c`):

```
1. SCAN the heap, emitting (index_key, heap_TID) for every live row.
2. SORT them (tuplesort; can spill to disk; PARALLEL workers since PG 11).
3. PACK leaf pages left→right, filling each to leaf `fillfactor` (default 90%),
   linking right-links as you go. No splits happen — pages are built full.
4. As each leaf fills, emit its high key as a downlink up to the level-1 builder,
   which packs internal pages the same way, recursing until one page remains: the root.
5. WAL-log the finished index (or skip WAL under wal_level=minimal for a new relation).
```

Why this wins, quantitatively and structurally:

- **No splits, no descents.** Building `N` entries is one sort (`O(N log N)` comparisons but sequential I/O) plus one linear pack, versus `N` random descents-with-splits for incremental insertion.
- **Dense, sequential, cache-friendly result.** Pages come out ~90% full and **physically contiguous left-to-right on disk**, so a subsequent range scan is near-sequential I/O. An incrementally-built index over random keys is ~70% full and scattered.
- **Parallelism.** The sort parallelizes across workers; `maintenance_work_mem` sizes the sort and directly affects whether it stays in memory.

Other systems: **InnoDB** has fast index creation / sorted builds (`innodb_sort_buffer_size`) that likewise sort then bulk-load leaf pages. **SQLite** builds indexes by inserting, but `CREATE INDEX` on a populated table sorts first. The general principle — *sort once, pack bottom-up* — is universal and is the reason "load data, then create indexes" beats "create indexes, then load data" by large factors.

A related lever: **`REINDEX`** (§64.20) is just a bulk build over the existing index's keys, which is why it both speeds up and *compacts* a bloated index.

---

## 64.16 Prefix and Suffix Truncation of Separator Keys

Internal-node separators do not need to be *whole* keys — they only need to **discriminate** between the left and right subtrees. Shrinking them packs more separators per internal page, which **raises fanout, lowers tree height, and shrinks the working set of the cached upper levels.** Two complementary techniques:

- **Suffix truncation.** A separator only needs to be large enough to route: if the last key on the left page is `"Smith, Alice"` and the first on the right is `"Smith, Bob"`, the separator `"Smith, B"` (or even a boundary between them) suffices. Truncate the trailing bytes/attributes that do not affect routing. This shortens *high multi-column keys* enormously.
- **Prefix truncation / compression.** Within a page, all keys share a common prefix with the page's low bound; store the prefix once and only the differing suffixes per key. (This is a within-node compression, distinct from suffix-truncated separators.)

**PostgreSQL implements suffix truncation at the attribute granularity (PG 12+, `nbtree` v4).** When a leaf splits, `_bt_truncate` produces the new separator (pushed to the parent) by **dropping trailing index columns that are not needed to tell the two halves apart**, keeping only the shortest prefix of attributes that still distinguishes them — and, if even the last needed attribute is shared, falling back to the implicit **heap-TID** column (§64.12) as the final discriminator.

```
Multi-column index on (last, first, id). Leaf split boundary:
  left  page last key:  ("Smith","Alice", 7001)
  right page first key: ("Smith","Bob",   3002)
  full separator would be ("Smith","Bob",3002) — 3 attributes.
  suffix-truncated separator: ("Smith","Bob")  — 2 attrs suffice to route,
     "id" is dropped. If first names matched too, keep id; if those matched,
     use heap TID.  Result: shorter separators → higher internal fanout.
```

Concrete payoff: on a wide multi-column index, suffix truncation can cut internal-node key sizes several-fold, measurably increasing fanout and often removing a whole tree level on real indexes. It also makes internal keys **more stable** (they stop encoding volatile trailing columns), reducing how often a small leaf change perturbs separators. This was one of the headline `nbtree` improvements of PG 12 and is a direct application of the "separators are routers, not data" principle — a great thing to be able to explain from first principles.

---

## 64.17 Deduplication and Posting Lists

Indexes on **low-cardinality** columns store the same key value thousands of times, once per matching row, each with its own heap TID — an enormous waste and a driver of index bloat. **PostgreSQL 13** added `nbtree` **deduplication**: consecutive index tuples with **equal keys** are merged into a single **posting-list tuple** that stores the key **once** followed by a sorted array of heap TIDs.

```
Before dedup (many equal keys):        After dedup (one posting list tuple):
  ["active", TID1]                       ["active", {TID1,TID2,TID3,TID4,...}]
  ["active", TID2]                          key stored once, TIDs packed 6B each
  ["active", TID3]      →  merged  →
  ["active", TID4]
   … each ~16–24 B …                     amortized ~6 B per row instead of ~16–24 B
```

Details worth knowing:

- **Storage parameter `deduplicate_items`** (default `on`) controls it. Deduplication runs **lazily**, as a "**delay-the-split**" step: when a leaf is about to split, `nbtree` first tries to deduplicate it, and only splits if that does not free enough room. So it costs nothing until a page is under pressure.
- **Space savings** on a boolean/enum/status column are large — an index can shrink 2–4× — which also improves cache hit rates and range-scan speed.
- **Unique indexes benefit too**, subtly: even a unique index accumulates duplicate keys transiently because MVCC keeps **dead** duplicate versions until VACUUM. Postgres 13 deduplicates those to **delay page splits caused by version churn**, and PG 14's **bottom-up index deletion** (§64.18) complements it by removing dead duplicates entirely before a split.
- **Interaction with heap-TID ordering (§64.12):** because TIDs are the implicit final sort key, the TIDs within a posting list are naturally sorted, which keeps range scans and TID-based deletion efficient.

This is a relatively recent feature and a good "what's new in modern Postgres" answer: pre-13 Postgres indexes on low-cardinality columns were notoriously fat; dedup + bottom-up deletion largely fixed that.

---

## 64.18 Simple Deletion, kill_prior_tuple, and Microvacuum

Under MVCC, an `UPDATE` or `DELETE` does not remove the index entry — it creates *new* row versions and leaves the old ones' index entries pointing at now-dead heap tuples (Ch. 61 §61.14, Ch. 65). If nothing cleaned these up until the next `VACUUM`, indexes on churning tables would bloat between vacuums. `nbtree` has several *opportunistic* cleanup mechanisms that run during ordinary queries, and they are frequent interview fodder because they explain why "the index shrank without a VACUUM."

- **`kill_prior_tuple` / LP_DEAD hinting.** When an index scan follows an entry to the heap and finds the heap tuple is **dead to everyone** (not just invisible to me), it sets an **`LP_DEAD` "known dead" hint bit** on that index tuple. This is cheap (a hint, not WAL-logged as a delete) and means future scans can skip the entry immediately.
- **Simple index-tuple deletion / "microvacuum" (`_bt_vacuum_one_page`).** When a leaf is about to split and it holds LP_DEAD-marked tuples, `nbtree` first **physically deletes those known-dead tuples** from the page. Very often this frees enough space to **avoid the split entirely**, keeping the index compact between vacuums. This is triggered by page pressure, not on a schedule.
- **Bottom-up index deletion (PG 14).** A more aggressive version aimed at **version churn**: when a leaf is about to split and the pressure looks like it comes from repeated non-HOT updates of the same logical rows (many dead duplicates), `nbtree` proactively visits the heap to confirm which entries are dead and deletes them, again to **avoid the split**. It targets exactly the workload — frequently-updated rows with a secondary index on an unchanged column — that used to bloat indexes fastest.

```
scan finds heap tuple dead → set LP_DEAD hint on index tuple  (kill_prior_tuple)
leaf about to split → delete LP_DEAD tuples first             (microvacuum)
                    → if still tight & churn-shaped, probe heap (bottom-up del, PG14)
                    → only split if none of that freed enough room
```

The unifying idea: **splits are expensive and permanent (Postgres never merges, §64.9), so it is worth a lot of work to avoid one.** Deduplication (§64.17), microvacuum, and bottom-up deletion are all "delay/avoid the split" tactics that fire precisely when a page is about to split. Together they are why modern Postgres indexes on update-heavy tables stay far leaner than pre-13/14 ones.

---

## 64.19 Vacuum, Page Deletion, and Recycling

Opportunistic cleanup (§64.18) handles per-page pressure, but only **`VACUUM`** does whole-index maintenance: it scans the index, removes entries pointing at dead heap tuples that autovacuum is reclaiming, and handles **empty pages**. Because Postgres never merges under-full pages (§64.9), a B-tree page is only reclaimed when it becomes **completely empty**, and reclaiming it safely under concurrent descent is delicate.

**Page deletion is a two-phase, concurrency-safe protocol:**

1. **Delete.** VACUUM finds an empty leaf, unlinks it from its siblings (fixing their right/left links) and from its parent (removing the downlink), and marks it `BTP_DELETED`, stamping it with a **transaction id** (`btpo_level` union / a full 64-bit XID since PG 14). The page is now out of the tree but **not yet reusable**.
2. **Recycle — but only when safe.** A scanner that was paused mid-descent might still hold a stale right-link pointing at the just-deleted page. So the page may be **reused only once no active transaction could still be following a link to it** — determined by comparing the stamped XID against the oldest running transaction (the Lehman-Yao "someone might still move-right into me" hazard). Until then the page sits in limbo. When safe, it is handed to the **Free Space Map (FSM)** and can be re-allocated for a future split.

```
empty leaf → unlink from siblings+parent, mark BTP_DELETED + stamp XID   (phase 1)
   … page is unreachable by NEW descents but a paused scan might still reach it …
oldest-running-XID passes the stamp → page is safe → put in FSM → reusable (phase 2)
```

Key consequences:

- **Deletes don't shrink the index file.** Reclaimed pages go on the FSM for *reuse by this index*; they are not returned to the OS. The file only shrinks if empty pages happen to be at the **physical end** of the file (rare). This is the root of index bloat (§64.20).
- **Two VACUUMs were historically needed** to fully recycle a deleted page (one to delete, a later one to recycle after the XID horizon passed). **PG 14** switched to storing a full 64-bit XID so a single VACUUM can often both delete and recycle, and added `btm_last_cleanup_num_delpages` bookkeeping so VACUUM can **skip index cleanup entirely** when there is nothing to do (a big cost saver on large, stable indexes).
- **`btpo_cycleid`** tags pages split during a given VACUUM's scan so VACUUM doesn't miss entries that moved right past its cursor mid-scan — another Lehman-Yao interaction.

---

## 64.20 Index Bloat and REINDEX

**Index bloat** is a B-tree file much larger than the live data warrants — half-empty pages, recycled-but-not-returned space, fragmentation from years of splits and deletes. Postgres is especially prone to it because it (a) never merges under-full pages (§64.9), (b) only recycles fully-empty pages, and (c) returns freed pages to the FSM for reuse rather than to the OS. A table that was once large and is now small, or one under heavy update churn on a poorly-covered index, can carry an index several times its necessary size.

Why deletes specifically don't shrink an index:

- A `DELETE` marks heap tuples dead; VACUUM later removes the matching index entries, leaving **partially-empty leaf pages** that are not merged. The average fill can drop to 50% or worse, but the page count — and thus the file — does not fall.
- Only if a leaf becomes **totally empty** is it deleted and eventually recycled, and even then the space is reused internally, not freed to the filesystem.

**The fix is to rebuild the index**, which triggers the dense bottom-up bulk build of §64.15:

- **`REINDEX INDEX foo`** rebuilds it from scratch, producing a ~90%-full, contiguous index — but takes an **`ACCESS EXCLUSIVE` lock** on the table for the duration, blocking reads and writes. Unusable on a live OLTP table of any size.
- **`REINDEX ... CONCURRENTLY`** (PG 12+) builds a **new** index alongside the old one while normal traffic proceeds, then swaps them under a brief lock and drops the old one. It is slower and uses more space transiently (two copies), and can fail leaving an `INVALID` index to clean up, but it avoids the exclusive lock. This is the production-safe compaction path.
- **`pg_repack`** (extension) achieves similar online rebuilds for tables and indexes.
- Prevention beats cure: adequate **autovacuum** tuning keeps dead tuples from accumulating; `fillfactor` leaves headroom for HOT updates (Ch. 61 §61.14) so fewer index writes happen at all; and dedup/bottom-up deletion (§64.17–64.18) slow bloat's onset.

Contrast with **InnoDB**, which merges under-full pages (§64.9), so its indexes self-compact somewhat and it needs an explicit rebuild (`OPTIMIZE TABLE`) less urgently — though InnoDB clustered indexes still fragment and benefit from periodic rebuilds. The interview line: **Postgres trades eager rebalancing for concurrency, and pays for it with a bloat-and-`REINDEX` maintenance story that InnoDB's eager merging softens.**

---

## 64.21 Practical Numbers and Failure Modes

Concrete figures anchor the whole chapter and are what a strong candidate can quote.

**Sizes and fanout (8 KB page, `nbtree`):**

- Usable per page ≈ `8192 − 24 (header) − 16 (opaque) ≈ 8152` bytes.
- A `bigint` leaf entry ≈ 8 B key + 8 B `IndexTupleData` header + 6 B TID (in the header's `t_tid`) → with a 4 B line pointer, roughly **16–24 B per entry** → **~350–500 entries per leaf**; internal pages hold *more* separators after suffix truncation (§64.16), so **fanout is often 300–600**.
- Height: `⌈log_fanout N⌉`. At fanout 400: **1 level ≈ 400 rows, 2 ≈ 160K, 3 ≈ 64M, 4 ≈ 25 billion.** A **4-level tree indexes billions of rows**; the metapage, root, and usually the entire non-leaf portion stay cached, so a warm point lookup is effectively **one leaf page read (or zero, if cached)**.
- `BTMaxItemSize ≈ 2704` bytes — the hard per-entry cap (§64.6).

**Latencies (Ch. 30's numbers applied):**

- Warm lookup, all pages in `shared_buffers`: a handful of binary searches + comparisons, **sub-microsecond to a few µs**.
- Cold lookup touching a leaf on NVMe: **~50–100 µs** dominated by the single leaf read; on spinning disk, **~10 ms**. The tree's low height is the whole point — it bounds cold I/O to `height` reads, and caching removes all but the leaf.

**Failure modes and pathologies:**

- **Right-edge contention (§64.14):** monotonic-key inserts serialize on the rightmost leaf's buffer lock. Symptom: high `LWLock` / buffer-content contention under concurrent inserts; mitigated by key spreading or partitioning.
- **Index bloat (§64.20):** delete/update churn leaves half-empty pages Postgres won't merge; file grows, scans slow, cache wastes. Fix: `REINDEX CONCURRENTLY`, tune autovacuum.
- **Oversized key error (§64.6):** `index row size N exceeds btree maximum 2704` when indexing a wide column directly; fix by indexing an expression/hash.
- **Duplicate/version storms pre-PG13:** low-cardinality or heavily-updated indexes ballooned before dedup (§64.17) and bottom-up deletion (§64.18); "upgrade and `REINDEX` to v4" is the fix.
- **Corruption detection:** wrong magic/version (§64.2) or a failed page checksum flags a bad page; `amcheck` (`bt_index_check` / `bt_index_parent_check`) verifies structural invariants — right-links, high-key ordering, downlink consistency — and is how the Lehman-Yao invariants are audited in production.
- **Interrupted split / crash:** a `BTP_INCOMPLETE_SPLIT` page is legal and self-healing — the next descent or VACUUM finishes the parent insert; the right-link guarantees no data was lost (§64.7, §64.11).

The through-line for the whole chapter: **a production B-tree is a Lehman-Yao B-link tree wearing a lot of maintenance machinery.** Right-links + high keys give lock-free-ish concurrent descent; breadcrumbs and incomplete-split flags make splits crash-safe and cheap; suffix truncation and deduplication keep it dense; microvacuum, bottom-up deletion, and VACUUM page recycling keep it from bloating; and bulk loading builds it fast. Postgres `nbtree` is the canonical instance of every one of these.

---

## Summary

- A B-tree node is a page whose **header** (flags, free-space pointers, **level**, **page LSN**) is what makes it navigable, recoverable (WAL LSN ordering), and safe; `nbtree` uses a 24-byte page header plus a 16-byte opaque footer.
- **Magic numbers** and a **version field** (in `nbtree`'s block-0 **metapage**, which also holds the root pointer and a **fast root**) validate and version the on-disk format; the root is reached via a stable metapage pointer, not a fixed block.
- **Sibling links** (`btpo_prev`/`btpo_next`) turn each level into a doubly-linked list, enabling range scans and — crucially — the Lehman-Yao move-right escape; **rightmost** nodes terminate the chain.
- **High keys** (an upper bound copied into each non-rightmost page) let a descender detect that a concurrent split moved its data right and **move right without locking the parent** — the heart of B-link trees.
- Within a node, search is **binary search over the sorted slot array with a dereference** to each variable-length cell; ~8–9 comparisons per node.
- Oversized data: SQLite/InnoDB use **overflow pages**; Postgres uses **TOAST for heap values** and simply **caps index entries at ~2704 bytes** (no overflow pages).
- Splits propagate up via **breadcrumbs** (the remembered descent path, a hint re-verified by high keys); Postgres **does not merge** under-full pages (only recycles empty ones), unlike InnoDB.
- The **concurrency problem** (reader descends while writer splits) is solved by **Lehman-Yao B-link trees** (right-link + high key, tolerate the race) in Postgres `nbtree`, versus **latch coupling/crabbing** (prevent the race by locking) in InnoDB.
- **Right-edge fast path** and split heuristics optimize monotonic-key inserts; **bulk loading** (sort then pack bottom-up) builds dense indexes fast; **suffix truncation** and **deduplication/posting lists** keep them small; **microvacuum, bottom-up deletion, VACUUM page deletion + FSM recycling** fight bloat, with **`REINDEX CONCURRENTLY`** as the compaction of last resort.

---

## Key Interview Questions

1. **What does a B-tree page header contain and why does each field matter?** — Flags/page type (leaf/internal/root/deleted), free-space pointers (`pd_lower`/`pd_upper` — make splits O(1)-decidable), level (leaf=0, enforces invariants and detects reaching a leaf), and the page LSN (enforces write-ahead logging — the page can't flush until WAL ≤ its LSN is durable — and drives idempotent redo).
2. **What is the metapage and why isn't the root at a fixed block?** — Block 0 holds `BTMetaPageData`: magic number, version, and a **pointer** to the current root plus a fast root. The root splits and moves, so a stable metapage indirects to it; every descent starts by reading the (cached) metapage.
3. **What is a magic number and what does it protect against?** — A fixed constant at a known offset, checked on read, that catches corruption, torn writes, and wrong-format/version pages by refusing to misinterpret them; `nbtree`'s is `0x053162` with version 4 for suffix truncation and deduplication.
4. **What are sibling links and what are they for?** — Horizontal `prev`/`next` pointers making each level a doubly-linked list; they let range scans walk leaf-to-leaf without re-descending and, more importantly, give a descender the right-link to follow when a split moved its data.
5. **What is a high key and what two jobs does it do?** — An upper bound on all keys a page may hold, stored as the page's first item. It acts as a split-stable separator, and it powers the Lehman-Yao "move right" test: if `search_key ≥ high_key`, a concurrent split moved the data right, so follow the right-link — no parent lock needed.
6. **How is search within a node performed, and why the indirection?** — Binary search over the fixed-width sorted slot/line-pointer array, dereferencing each probed slot to its variable-length cell to compare. The cells aren't contiguous or sorted, so you search the slot array (O(1) indexable) not the cells; ~8–9 comparisons for a 300–500-entry page.
7. **How do B-trees handle a key/value too big for a node?** — Either overflow pages (SQLite spills a linked list; InnoDB stores BLOBs in external pages) or an out-of-line mechanism. Postgres has **no index overflow pages**: it TOASTs large *heap* values but **hard-caps index entries at ~2704 bytes** (`BTMaxItemSize`), erroring otherwise; you index an expression/hash instead.
8. **Why does Postgres cap index entries instead of using overflow pages, and how does TOAST relate?** — Overflow chains complicate the concurrent-descent design; capping keeps every entry comparable in one page. TOAST shrinks the heap tuple but doesn't help the index, because the index stores the key value itself — a huge key still exceeds the cap.
9. **How does a split propagate up the tree, and when does height change?** — A full node splits ~in half, pushes a separator (a truncated high key) + downlink into the parent; if the parent overflows it splits too, recursing up. Height increases **only** when the root splits and a new root is created — B-trees grow from the leaves up.
10. **What are breadcrumbs and why aren't they sufficient alone?** — The remembered descent path (`BTStack` of page+slot per level) used to find parents for downlink insertion without re-traversing. Between recording and using a breadcrumb the parent may have split, so it's a hint re-verified by the high key, moving right if the target moved.
11. **Does Postgres merge under-full B-tree pages? Contrast InnoDB.** — No. `nbtree` never merges or borrows; it only reclaims **completely empty** pages (via VACUUM delete + FSM recycle). InnoDB merges pages below `MERGE_THRESHOLD` (default 50%). Postgres trades the half-full invariant for concurrency, at the cost of a bloat/`REINDEX` story.
12. **State the concurrency problem a concurrent B-tree must solve.** — A reader descends while a writer splits a node on its path; the reader can land on a page whose data was moved to a new right sibling it never learned about, and wrongly report "not found." The fixes are latch coupling (prevent) or B-link trees (tolerate + recover).
13. **Explain the Lehman-Yao B-link tree and its core invariant.** — Add right-links and high keys to every level, and always publish a split's right-link/high-key **before** the parent downlink. Between those steps the tree is a legal B-link tree: moved data is reachable via the right-link, and `search_key ≥ high_key` tells a descender to move right — all without locking the parent.
14. **Why is move-right correct?** — The high key is a hard upper bound on the page's contents. If `search_key ≥ high_key`, the key is definitely not on this page and definitely to the right, and splits guarantee the right-link is intact, so following it always makes progress toward the owning page.
15. **How does Postgres `nbtree` implement Lehman-Yao specifically?** — `_bt_search`/`_bt_moveright` take a short shared content lock on **one** page at a time, move right on high-key overshoot, and release the parent before locking the child (no read-path crabbing). Splits set `BTP_INCOMPLETE_SPLIT` and defer the parent insert, which any later descender or VACUUM completes.
16. **How does `nbtree` handle duplicate keys given Lehman-Yao assumes uniqueness?** — Since PG 12 it appends the **heap TID** as an implicit final key column, making every key logically unique and giving duplicates a stable order. This enables suffix truncation and orderly duplicate handling, curing the pre-12 "duplicate storm" split pathology.
17. **What is latch coupling / crabbing and how does it differ from B-link trees?** — Hand-over-hand latching: acquire the child's latch before releasing the parent's, holding at most two at once so the split race can't occur. It prevents the race by locking (InnoDB, DB2); Lehman-Yao tolerates the race via right-links. Crabbing holds two latches and contends near the root; B-link holds one.
18. **How are monotonically increasing key inserts optimized, and what's the hazard?** — A cached rightmost-leaf fast path skips the full descent when the new key belongs on the same rightmost page; `_bt_findsplitloc` packs rightmost splits nearly full so left halves aren't wasted. The hazard is right-edge contention: every insert fights for the rightmost page's lock.
19. **How is a B-tree bulk-loaded and why is it far better than inserting?** — Scan the heap, sort (key, TID) pairs (parallelizable), then pack leaf pages left-to-right to `fillfactor` and build internal levels bottom-up — no splits, no descents. The result is ~90% full and physically contiguous; `CREATE INDEX`/`REINDEX` use it. "Load then index" beats "index then load."
20. **What is suffix truncation and what does it buy?** — At a leaf split, the separator pushed to the parent keeps only the shortest prefix of attributes that distinguishes the two halves (falling back to heap TID), dropping trailing columns. Shorter separators raise internal fanout, lower tree height, shrink the cached upper levels, and stabilize separators. Added in PG 12.
21. **What is `nbtree` deduplication and when does it run?** — Since PG 13, consecutive equal-key tuples merge into a **posting-list tuple** storing the key once plus a sorted TID array, run lazily as a delay-the-split step under page pressure (`deduplicate_items`). It shrinks low-cardinality indexes 2–4× and delays splits from MVCC version churn even on unique indexes.
22. **Explain `kill_prior_tuple` and microvacuum.** — When an index scan finds a heap tuple dead to everyone, it sets an `LP_DEAD` hint on the index tuple; when a leaf is about to split, `nbtree` physically deletes those known-dead tuples first (microvacuum), often avoiding the split. Both run during ordinary queries, between VACUUMs.
23. **What is bottom-up index deletion (PG 14) and what workload does it target?** — When a split looks driven by version churn (many dead duplicates from repeated non-HOT updates), `nbtree` proactively checks the heap and deletes dead entries to avoid the split. It targets frequently-updated rows with a secondary index on an unchanged column — the fastest historical bloat source.
24. **Why don't deletes shrink a Postgres index, and how do you reclaim the space?** — Deletes leave partially-empty pages Postgres won't merge; only fully-empty pages are deleted and recycled **to the FSM for reuse**, not returned to the OS, so the file rarely shrinks. Reclaim with `REINDEX` (rebuild, dense) — `REINDEX CONCURRENTLY` to avoid the `ACCESS EXCLUSIVE` lock.
25. **Why is `nbtree` page recycling a two-phase process?** — A paused scanner may still hold a stale right-link to a just-emptied page, so a deleted page is stamped with an XID and only recycled once no running transaction could still follow a link to it (Lehman-Yao hazard). PG 14's 64-bit XID lets one VACUUM often both delete and recycle.
26. **How big can an `nbtree` get, and how tall?** — With fanout ~300–600 (helped by suffix truncation), height is `⌈log_fanout N⌉`: ~64M rows at 3 levels, ~25 billion at 4. A 4-level tree indexes billions of rows; upper levels stay cached, so a warm lookup is sub-µs and a cold one is ~one leaf read (~50–100 µs NVMe).
27. **How are Lehman-Yao invariants audited in production?** — The `amcheck` extension (`bt_index_check`, `bt_index_parent_check`) verifies right-link/high-key ordering and downlink consistency; page checksums and the magic/version guard against physical corruption. A `BTP_INCOMPLETE_SPLIT` page is legal and self-heals on the next descent.
28. **Why is a page LSN in the header essential to durability?** — It records the last WAL record that changed the page; the buffer manager refuses to flush the page until the WAL up to that LSN is on disk (write-ahead rule), and recovery compares it to a redo record's LSN to apply each change exactly once (idempotent redo).

---

## Common Traps

- **Assuming production B-trees keep every node at least half full.** That is a textbook invariant; Postgres never merges or borrows and only recycles fully-empty pages, so real indexes routinely run half-empty and bloat.
- **Thinking a reader must lock the parent (or the whole path) during descent.** In a Lehman-Yao B-link tree the reader holds at most one short page lock and moves right on high-key overshoot — the parent is never path-locked on reads.
- **Confusing crabbing with B-link trees.** Crabbing (InnoDB) *prevents* the split race by holding two latches hand-over-hand; Lehman-Yao (Postgres) *tolerates* it with right-links and high keys and holds only one.
- **Believing TOAST lets you B-tree-index arbitrarily large values.** TOAST shrinks the heap tuple, not the index key; index entries are hard-capped at ~2704 bytes and indexing a wide column directly errors out.
- **Expecting `DELETE` (or even `VACUUM`) to shrink an index file.** Freed pages go to the FSM for internal reuse, not back to the OS; only `REINDEX`/`pg_repack` actually compacts and shrinks a bloated index.
- **Forgetting that the root is not at a fixed block.** Descents read the block-0 metapage first to find the current (or fast) root, which moves whenever the root splits.
- **Assuming a 50/50 split is always right.** For monotonic keys a 50/50 rightmost split permanently wastes the left half; `nbtree` packs rightmost splits nearly full via fill-factor-aware heuristics.
- **Overlooking that duplicates break the classic unique-key B-tree assumption.** Postgres appends the heap TID as an implicit final key column to restore uniqueness, which is what makes suffix truncation, ordered duplicates, and deduplication work.
- **Treating a breadcrumb as a guaranteed-correct parent.** Between recording and using it the parent may have split; it is a hint that must be re-verified by the high key and followed right if stale.
- **Thinking splits are cheap and reversible.** In Postgres a split is permanent (no merge), so the engine spends real effort — deduplication, microvacuum, bottom-up deletion — specifically to avoid splitting a page that is under pressure.
- **Assuming an interrupted split corrupts the tree.** A `BTP_INCOMPLETE_SPLIT` page is a legal B-link state because the right-link is written first; the next descent or VACUUM finishes the deferred parent insert and no data is lost.
