# Chapter 62 — B-Tree Basics

*Interview-focused revision notes. The theme: a binary search tree is the right idea and the wrong shape for a disk. The B-tree keeps the "ordered, logarithmic search" idea but makes each node a whole page, trading a tall tree of tiny pointer-chasing nodes for a short, bushy tree of high-fanout pages — turning ~30 random I/Os into ~4. PostgreSQL's `nbtree` (a B+tree) is the reference implementation throughout; the theory is universal, but the numbers are Postgres's 8 KB page.*

---

## 62.1 Why In-Memory Search Trees Fail on Disk

Start from the structure everyone reaches for first: the **binary search tree** (BST). It keeps keys ordered, supports point lookup, predecessor/successor, and range scans, and does all of it in O(log₂ N) comparisons on a balanced tree. In RAM it is excellent. On disk it is a disaster, and understanding *why* is the entire motivation for the B-tree.

A BST node holds **one key and two child pointers**. To find a key among N you descend ~log₂ N nodes. For N = 10⁹ that is ~30 nodes. Three things make those 30 hops ruinous on a block device:

- **Pointer chasing with no locality.** Each node was allocated independently; the two children of a node live wherever the allocator put them, arbitrarily far apart in the file. Every descent step is a jump to an unrelated address. There is no reason the next node shares a page with the current one, so each of the ~30 steps is a fresh **random access** (Ch. 30). On disk, "random access" means a seek.
- **Low fanout wastes the block.** The unit of transfer from a block device is not a byte or a key — it is a **block/page** (§62.3), 8 KB in Postgres. To read one 24-byte BST node you must transfer the whole 8 KB page it sits on, then use 0.3% of it and throw the rest away. You paid for 8 KB of I/O to make one comparison. The tree's *fanout of 2* means each expensive page transfer buys you exactly one bit of decision.
- **Height grows with log₂.** Because each node discriminates only two ways, the tree is as tall as log₂ N. Height is the number of dependent, serialized I/Os on the critical path of a lookup — you cannot fetch node k+1 until node k tells you which child to visit. Tall tree = many serialized seeks.

The disease is not "trees are bad." Trees are exactly right — ordered, logarithmic, range-friendly. The disease is **the mismatch between the node size (bytes) and the I/O granularity (kilobytes)**, and the resulting **low fanout and large height**. Fix those two and the BST becomes the B-tree. The same in-memory-vs-disk tension appeared abstractly in (Ch. 21 §21.14); this chapter is where it becomes physical.

```
BST for 8 keys                     each node = its own page transfer
                4
             /     \
           2         6             lookup(7): read node(4) → page I/O
          / \       / \                        read node(6) → page I/O
         1   3     5   7                        read node(7) → page I/O
                                    3 dependent random I/Os for 8 keys;
                                    ~30 for a billion. Each moves 8 KB
                                    to use ~24 bytes of it.
```

---

## 62.2 Tree Balancing: AVL and Red-Black, and Why They Are Wrong for Disk

A raw BST can degenerate: insert keys in sorted order and it becomes a linked list of height N, O(N) lookup. **Self-balancing BSTs** fix the height by enforcing an invariant on every insert/delete:

| Structure | Balance invariant | Height bound | Rebalance op |
|---|---|---|---|
| **AVL tree** | subtree heights differ by ≤ 1 | ≤ 1.44 log₂ N | rotations (strict, more of them) |
| **Red-black tree** | no red-red edge; equal black-height | ≤ 2 log₂ N | rotations + recolor (fewer) |
| **Treap / skip list** | randomized | ~log₂ N expected | probabilistic |

These are the right tools **in memory** — the Linux kernel's VMA tree, `std::map`, Java's `TreeMap`, and Postgres's *in-memory* planner structures all use red-black or similar. But every one of them is still a **binary** structure: fanout 2, one key per node, height ∝ log₂ N. Balancing bounds the height; it does nothing about the two fatal disk properties from §62.1:

- Fanout is still 2, so a page transfer still buys one bit of decision.
- Height is still ~log₂ N ≈ 30 for a billion keys, so a lookup is still ~30 serialized random I/Os.

Worse, **rebalancing rotations are pointer surgery**: a rotation relinks three-to-five nodes. In memory that is a few cache-line writes. On disk each of those nodes is on a different page, so a rotation *dirties several scattered pages*, each of which must eventually be written back — turning one logical insert into a scatter of random writes and, under a WAL (Ch. 65), a pile of log records. The AVL/red-black machinery optimizes the wrong cost function: it minimizes *comparisons and node count*, when the disk cares about *page transfers*.

The B-tree keeps the balancing goal — **all leaves at the same depth, always** — but achieves it with a completely different move (splitting and merging fat nodes, §62.16–§62.17) that touches O(1) pages per operation in the common case, and it drives the height down by making each node a whole page with fanout in the *hundreds*.

---

## 62.3 The Block Is the Unit of I/O

The single fact the entire chapter is built on: **you cannot read one byte from a block device.** Storage hardware and the OS transfer data in fixed-size **blocks** (hardware sector: historically 512 B, modern "Advanced Format" 4 KB) and the OS/DBMS layer aggregates these into **pages** it reads and writes atomically.

| Layer | Unit | Typical size |
|---|---|---|
| HDD/SSD physical sector | sector | 512 B (legacy) / 4 KB (AF) |
| OS page cache | page | 4 KB (x86-64, Ch. 32) |
| **PostgreSQL** | page/block (`BLCKSZ`) | **8 KB** (compile-time constant) |
| MySQL InnoDB | page | 16 KB |
| SQLite | page | 4 KB (default since 3.12; was 1 KB) |
| Oracle | block | 8 KB default (2–32 KB) |

The consequences that shape B-trees:

- **Reading 1 byte costs one page transfer** (~8 KB in Postgres). So an on-disk structure should make every page it touches carry as many useful keys as possible — *pack the page*. That is exactly what a B-tree node is: a page densely filled with sorted keys.
- **Writing must be page-granular and ideally atomic.** A B-tree mutates pages in place (§62.16), which raises the **torn-page** problem — a crash mid-write can leave a half-updated 8 KB page (Ch. 63, Ch. 65). This is a direct cost of in-place mutation and is why Postgres writes **full-page images** to the WAL on the first change to a page after a checkpoint.
- **Amortization is the whole game.** If a page transfer costs ~100 µs on NVMe (§62.4), you want to extract hundreds of key comparisons from it, not one. Fanout is how a B-tree turns "expensive page transfer" into "hundreds of comparisons for the price of one I/O."

Postgres's 8 KB page (`BLCKSZ`) is the atom of everything below the executor: heap pages (Ch. 61 §61.7), B-tree pages, the buffer pool slot size (Ch. 65), and the WAL's full-page-image size all inherit it.

---

## 62.4 Disk and SSD Primer: Random I/O Is the Enemy

Why a *page transfer* is the cost to minimize, and why *random* page transfers are worse than sequential, comes down to the physics of the media (developed in Ch. 30; recapped here because it is the B-tree's reason to exist).

**Spinning disk (HDD).** A read requires (1) a **seek** — moving the head to the right track, ~5–10 ms — plus (2) **rotational latency** — waiting for the sector to rotate under the head, ~2–4 ms at 7200 RPM (half a rotation ≈ 4.2 ms). A random 8 KB read is therefore ~**8–12 ms**, dominated by mechanical motion. Once positioned, sequential transfer is fast (~100–200 MB/s), so **sequential reads are ~100× cheaper per byte than random reads.**

**SSD / NVMe.** No moving parts, so no seek/rotation. A random 4–8 KB read is ~**50–100 µs** (NVMe) or ~100–150 µs (SATA SSD). Random is *much* closer to sequential than on an HDD, but a gap remains: SSDs read/write in **pages** (4–16 KB) and erase in large **blocks** (MB), so write amplification and the flash translation layer still favor sequential/large I/O. Random reads also can't be coalesced.

| Media | Random 8 KB read | Sequential MB/s | Random : sequential penalty |
|---|---|---|---|
| DRAM (for scale) | ~100 ns | tens of GB/s | ~1× |
| HDD 7200 RPM | ~8–12 ms | ~150 MB/s | ~100× |
| SATA SSD | ~100–150 µs | ~500 MB/s | ~a few× |
| NVMe SSD | ~50–100 µs | 3–7 GB/s | ~a few× |

The B-tree's design goal restated in these numbers: a lookup is a chain of *random* page reads (you can't predict the next page until the current one is read), and **height = the length of that chain.** On an HDD, cutting a lookup from 30 random reads (BST) to 4 (B-tree) is 30×12 ms = 360 ms → 4×12 ms = 48 ms. On NVMe it is ~3 ms → ~400 µs. Either way, **fanout buys height, and height is serialized random I/O.** (And note: even on fast NVMe, where random is cheap, fewer levels still means fewer buffer-pool lookups and fewer chances to miss the cache — §62.21.)

---

## 62.5 Addressing on Disk: Page-ID Plus Offset

An in-memory tree links nodes with **pointers** (raw addresses). An on-disk tree cannot: the file is mapped at a different virtual address every run, and a stored pointer would be meaningless after restart (Ch. 61 §61.4). So on-disk structures address by **page id + offset**, and a B-tree "child pointer" is a **page/block number**, not a memory address.

In Postgres an index is a file (a `relation`, split into 1 GB segments) of 8 KB pages numbered `0, 1, 2, …`. A B-tree "downlink" is a `BlockNumber` (a 32-bit page index). To follow it, the engine asks the **buffer manager** (Ch. 65) for that block:

```
downlink = BlockNumber 4217
        │
        ▼
buffer manager: is block 4217 of this index resident in shared_buffers?
   ├─ yes → hash-table hit, pin the buffer, return pointer into the pool   (~100 ns)
   └─ no  → evict a victim, issue read of 8 KB from the index file          (~50 µs–10 ms)
```

Within a page, a specific tuple is found by a **line pointer / item id** (slotted page layout, Ch. 63): the downlink names the page, and a small binary search inside the page (§62.14) names the entry. This two-level *page-id then in-page-offset* addressing is the same indirection that lets heap tuples move within a page without invalidating references (Ch. 61 §61.14), and it is why "the pointer is a page number" is the correct mental model for every B-tree edge.

The metapage detail worth knowing: **block 0 of a Postgres nbtree index is a metapage** (`BTMetaPageData`) that stores, among other things, the block number of the current **root** and a cached tree level. A lookup starts by reading the metapage (almost always cached) to learn where the root is, because the root's block number *changes* whenever the tree grows a level (§62.16).

---

## 62.6 From BST to B-Tree: The Core Idea

The B-tree is the answer to one question: *what if a tree node were a whole page instead of a single key?* Invented by Rudolf Bayer and Ed McCreight at Boeing in 1970 (the "B" is deliberately never officially expanded — Bayer, Boeing, balanced, block: take your pick), it generalizes the BST along exactly the axis the disk cares about.

Take a BST node — one key, two children — and inflate it to fill a page: **now it holds up to *m*−1 sorted keys and up to *m* children.** A single node with 400 keys makes a **400-way** branching decision from one page transfer, instead of 400 separate 2-way decisions from 400 page transfers.

```
B-tree node (one page) with keys k1<k2<...<k(m-1) and children c0..c(m-1):

        ┌────┬────┬────┬────┬─────┬────┐
        │ c0 │ k1 │ c1 │ k2 │ ... │c(m-1)
        └─┬──┴────┴─┬──┴────┴─────┴─┬──┘
          │         │               │
     keys < k1  k1 ≤ keys < k2   keys ≥ k(m-1)
```

The three defining properties, each a direct fix for a §62.1 failure:

1. **High fanout (m in the hundreds).** Each page transfer discriminates m ways, not 2. Fanout is chosen so a node fills one page (§62.10): with an 8 KB page and small keys, m ≈ a few hundred.
2. **Shallow height, ~log_m N.** Because branching is base m ≫ 2, the height collapses. log₄₀₀(10⁹) ≈ 3.45 → 4 levels, versus log₂(10⁹) ≈ 30 for a BST (§62.11, §62.13).
3. **Perfect balance, always.** Every leaf is at the same depth. The tree does not rebalance by rotations; it grows and shrinks *at the root* via splits and merges (§62.16–§62.17), which keeps all root-to-leaf paths equal length by construction.

That is the whole idea. Everything else in this chapter — B+trees, separator keys, splits, merges, `nbtree` specifics — is elaboration on "make the node a page, make the fanout huge, keep it balanced by splitting."

---

## 62.7 B-Tree Versus B+Tree

"B-tree" is used loosely for a family. The distinction that matters in practice is between the **original B-tree** and the **B+tree** — and essentially every database, Postgres included, uses the B+tree.

**Classic B-tree.** Keys *and their associated values/records* are stored in **all** nodes — internal and leaf alike. A search can terminate early at an internal node if the key is found there.

**B+tree.** Internal nodes store **only keys (separators) and child pointers — no values**. *All* values live in the **leaf** level. Internal nodes are pure routing structure. Additionally, leaves are usually **linked** into a sorted list (§62.8).

```
B-tree (values in every node)        B+tree (values only in leaves)
        [ 30:v ]                             [ 30 ]           ← routing only
       /        \                           /      \
  [10:v,20:v] [40:v,50:v]            [10 20 30] → [30 40 50]  ← all values here,
                                                               leaves linked →
```

Why databases overwhelmingly choose the **B+tree**:

| Property | Classic B-tree | B+tree | Why it matters |
|---|---|---|---|
| Where values live | all nodes | leaves only | keeps internal nodes value-free |
| Internal-node fanout | lower (keys carry values) | **higher** (keys only) | more routing per page → shallower tree |
| Range scan | must traverse tree repeatedly | **follow linked leaves** | sequential leaf walk, no re-descent |
| All lookups touch | variable depth | **always full depth to a leaf** | uniform, predictable cost |
| Point vs range uniformity | mixed | uniform | simpler concurrency & caching |

The decisive win is **fanout in the internal levels**. Because a B+tree's internal nodes hold no values, they pack far more separator keys per page, so the branching factor is higher and the tree is *shallower* — which is exactly the metric that costs I/O. The second win is **range scans**: leaves form a sorted linked list, so `WHERE x BETWEEN a AND b` descends once to the first leaf and then walks leaf-to-leaf, never re-entering the upper tree.

**Postgres's `nbtree` is a B+tree** (specifically a Lehman & Yao B-link tree, §62.18): every index entry — the key plus a heap TID — lives in the leaf level, and internal pages hold only pivot keys and downlinks. When this book (and most engineers) say "B-tree," they mean B+tree. InnoDB, SQLite, Oracle, DB2, and SQL Server are all B+trees too.

---

## 62.8 Linked Leaves and Range Scans

The B+tree feature that makes it a *database* index rather than just a dictionary is the **linked leaf level**. Each leaf page stores a pointer to its right (and in Postgres, left) sibling, so the leaves form a doubly/singly linked list in key order:

```
        internal (routing)
       /     |       \
  [ 3 7 ] [ 12 19 ] [ 24 31 ]        leaves, sorted, linked:
     ⇄        ⇄         ⇄
  leaf0  →  leaf1  →  leaf2  →  ...   right-links let a scan walk
                                       key order without touching
                                       the internal levels again
```

This turns range and ordered access into a **sequential leaf walk**:

- **Range scan** `WHERE k BETWEEN 15 AND 40`: descend once (root → internal → leaf) to the leaf containing 15 — O(log_m N) — then follow right-links, emitting keys until you pass 40. Cost = *one descent + a sequential walk of the matched leaves*, not one descent per result.
- **`ORDER BY k` / index scan without a sort**: the linked leaf order *is* sorted order, so the planner can stream rows already ordered and skip a sort node entirely.
- **`MIN`/`MAX`**: descend to the leftmost/rightmost leaf.

In Postgres the leaf links (`btpo_next`, `btpo_prev` in the page's special area) also serve **concurrency**: the right-link is the backbone of the Lehman & Yao B-link algorithm (§62.18, Ch. 64), letting a scan that lands on a page mid-split follow the right-link to find keys that moved, without holding locks up the tree.

Contrast with a **hash index** (§62.22): a hash index answers `=` in ~O(1) but supports **no range scans and no ordering** at all, because hashing destroys key order. The linked, sorted leaf level is precisely what a B+tree has and a hash index lacks — and it is why B-trees are the default index while hash indexes are a niche.

---

## 62.9 The B-Tree Hierarchy: Root, Internal, Leaf

A B+tree has exactly three *kinds* of node, distinguished by their role, not their format:

```
                         ┌──────────────┐
   level (height-1) ───▶ │   ROOT       │   1 page, almost always cached
                         └──┬───────┬───┘
                            │       │
   internal / routing  ┌────▼──┐ ┌──▼────┐   "branch" pages: separator
   (levels 1..h-2) ───▶│ INTNL │ │ INTNL │    keys + downlinks only
                       └─┬───┬─┘ └─┬───┬─┘
                         │   │     │   │
   leaf (level 0) ──▶ [leaf][leaf][leaf][leaf]  key + heap TID, linked ⇄
                         all leaves at the SAME depth
```

- **Root.** The single entry point (its block number is cached in the metapage, §62.5). When the tree has one page, the root *is* a leaf. As the tree grows, the root becomes an internal node. Because it is read on every lookup, it is essentially always resident in `shared_buffers` (§62.21).
- **Internal / branch nodes.** Pure routing: each holds separator keys and **downlinks** (child block numbers). They contain **no values/TIDs** (B+tree, §62.7). Their only job is to send a search to the correct child.
- **Leaf nodes.** Hold the actual index entries — `(key, heap TID)` in Postgres — in sorted order, and the sibling links (§62.8). *All* data is here; every successful and unsuccessful lookup ends at a leaf.

**Occupancy** (how full a node is) is bounded on both sides (§62.15): every node except the root must be at least ~half full, which is what guarantees the fanout — and therefore the log_m N height — actually holds. The **branching factor / fanout** is the number of children an internal node points to; it is set by how many separator keys fit in a page (§62.10).

A key structural invariant: **B-trees grow and shrink only at the root.** Leaves never get "deeper" independently; the only way the tree gains a level is a **root split** (§62.16), and the only way it loses one is the root collapsing after merges (§62.17). This is what keeps all leaves at equal depth and the tree perfectly height-balanced without rotations.

---

## 62.10 Fanout, Branching Factor, and Occupancy

**Fanout** (branching factor) is the number of children per internal node, and it is set by a simple budget: *how many `(separator key, downlink)` pairs fit in one page?* Work it out for Postgres's 8 KB nbtree page.

Page budget (8192 bytes):
```
  PageHeaderData        24 bytes   (LSN, checksum, free-space pointers)
  BTPageOpaqueData      16 bytes   (special area: left/right links, flags, level)
  ------------------------------
  usable                8152 bytes for line pointers + tuples
```

Per entry, for an 8-byte `bigint` key:
```
  ItemIdData (line pointer)   4 bytes
  IndexTupleData header       8 bytes
  key payload (bigint)        8 bytes   (+ null bitmap / alignment as needed)
  ------------------------------
  ~20 bytes per index entry
```

So a fully packed page holds ≈ 8152 / 20 ≈ **407 entries**. That is the raw fanout budget. Adjust for reality:

- **Leaf pages** default to **90% fillfactor** (§62.20): ~407 × 0.90 ≈ **~366 entries** per leaf at build time.
- **Internal pages** are always packed to ~100% and, since PG 12, use **suffix truncation** of pivot keys (§62.18) to make separators *shorter* than full leaf keys, which *raises* internal fanout above the naive number.
- **Wider keys shrink fanout.** A 40-byte `text` key gives ~8152 / (12 + 40) ≈ **~156** entries; a 4-byte `int` gives ~8152 / 16 ≈ **~500**. Fanout scales inversely with key width — the single biggest lever on tree height.

| Key type | ~bytes/entry | ~Fanout (8 KB page) |
|---|---|---|
| `int4` (4 B) | ~16 | ~500 |
| `int8`/`bigint` (8 B) | ~20 | ~400 |
| `uuid` (16 B) | ~28 | ~290 |
| `text` ~40 B | ~52 | ~156 |

InnoDB's **16 KB** page roughly doubles these fanouts; SQLite's 4 KB page halves them. The takeaway: **fanout is in the hundreds because the page is kilobytes and the keys are tens of bytes**, and that ratio — not any deep math — is why B-trees are only 3–5 levels tall (§62.11). **Occupancy invariants** (§62.15) guarantee nodes stay at least ~half full so the *worst-case* fanout is still ~half of these numbers, keeping height logarithmic even after arbitrary deletes.

---

## 62.11 Worked Example: Height for a Billion Keys

Put the fanout to work. Take a `bigint` index: fanout f ≈ 400, leaf capacity L ≈ 367 (90% fillfactor). The number of keys a tree of height *h* (counting levels) can hold is roughly `f^(h-1) × L`:

```
  h = 1 (root is a leaf):        L                 ≈ 367           keys
  h = 2 (root + leaves):         f  × L  = 400×367 ≈ 146,800       keys
  h = 3:                         f² × L  = 160k×367 ≈ 58,700,000   keys  (~59 M)
  h = 4:                         f³ × L  = 64M×367  ≈ 23,500,000,000 keys (~23 B)
  h = 5:                         f⁴ × L            ≈ 9.4 × 10¹²    keys  (~9 T)
```

Read off the practical answer:

| Rows indexed | B-tree levels (f≈400, bigint) | BST height (log₂) |
|---|---|---|
| 10³ (1 K) | 1–2 | ~10 |
| 10⁶ (1 M) | **3** | ~20 |
| 10⁹ (1 B) | **4** | ~30 |
| 10¹² (1 T) | **5** | ~40 |

**A billion-row index is 4 levels deep.** A trillion-row index is 5. This is the number to have memorized, and the reason for the interview cliché that *"B-trees are always short and fat."* Even pathologically wide keys rarely push a real index past 5–6 levels, because fanout only has to be in the dozens to keep height single-digit: even f = 50 gives 50⁴ = 6.25 M leaves × 367 ≈ 2 billion keys at height 5.

The payoff is entirely about the **serialized random I/O** of §62.4. A billion-key lookup is **4 page reads** in a B-tree versus **~30** in a balanced BST — and, crucially, the top 1–3 of those 4 levels are tiny and stay cached (§62.21), so the *physical* I/O per lookup is often just the **leaf read + the heap fetch**. That is the difference between a database that serves 100k point lookups/second and one that does not.

---

## 62.12 Separator Keys and High Keys: How Routing Works

Internal nodes route by **separator keys** (Postgres calls them **pivot tuples**). A separator is not a data key you can look up; it is a *boundary* that says "keys below me go left, keys at-or-above me go right." An internal node with keys `[k1, k2, …, k(m-1)]` and children `[c0, c1, …, c(m-1)]` obeys:

```
  keys in c0   <  k1
  k1 ≤ keys in c1  <  k2
  k2 ≤ keys in c2  <  k3
  ...
  k(m-1) ≤ keys in c(m-1)
```

So to route a search key `q`, find the child interval `q` falls into and descend. Because a B+tree stores all values in leaves, **the same key value can appear both as a leaf entry and as a separator up in an internal node** — the separator is just a copy used for routing (this is why leaf splits *copy* the key up while internal splits *push* it up, §62.16).

**High keys (the B-link addition).** Postgres's Lehman & Yao design stores, in each page's special area, a **high key**: an upper bound on every key the page (and its subtree) may contain — effectively "the first key of my right sibling." The high key is what makes **right-links safe** (§62.8, §62.18):

- During a lookup, if the search key is **greater than the page's high key**, the key must have **moved right** due to a concurrent split, so the searcher follows the **right-link** to the sibling instead of failing. This lets readers proceed during a split without locking the parent — the core of B-link concurrency (Ch. 64).
- The high key also bounds range scans: a scan knows it has exhausted a leaf's relevant keys when it reaches the high key.

**Suffix truncation** (PG 12+) exploits the fact that separators only need to be *just discriminating enough*. When splitting, Postgres computes the shortest prefix that still separates the two halves and stores only that as the pivot — e.g. to separate `"apple"` from `"banana"` it may store just `"b"`. Shorter separators mean more of them per internal page, i.e. **higher fanout and a shallower tree** for the same data (§62.10).

---

## 62.13 Lookup Complexity: Why Base b Beats Base 2

The lookup cost of a B-tree is **O(log_b N) page reads**, where *b* is the fanout — and the base of that logarithm is the whole point. Two logarithms differ only by a constant factor mathematically, but on disk the base is a factor of **8–9× in I/O count** for realistic sizes:

```
  N = 10⁹
  BST:    log₂(10⁹)   ≈ 30      node reads (each a potential random I/O)
  B-tree: log₄₀₀(10⁹) = log₂(10⁹)/log₂(400) = 30 / 8.64 ≈ 3.5 → 4 page reads
```

Every increment of fanout divides the height by `log₂(fanout)`. Going from fanout 2 to fanout 400 divides height by ~8.6. That constant is not "just a constant" when each unit is a serialized random seek costing milliseconds (HDD) or tens of microseconds (SSD).

**In-node cost is separate and cheap.** Inside each of those ~4 pages the engine does a **binary search** over the sorted keys (§62.14): with ~400 keys per page that is ~log₂(400) ≈ 9 comparisons. Total comparisons ≈ 4 × 9 ≈ 36 — the *same* asymptotic ~log₂ N total comparisons as a BST (as it must be; comparisons are information-theoretically bounded). **The B-tree does not reduce the number of comparisons; it reduces the number of *page transfers*.** The comparisons happen in RAM on an already-loaded page (fast); the page transfers happen over the I/O bus (slow). B-trees move the log₂ N work from the slow axis to the fast axis.

**Cache and TLB angle.** Even in a fully-cached index the base still helps: 4 buffer-pool lookups and 4 cache-resident pages beat 30 pointer-chases through 30 unrelated cache lines (each a likely L1/L2 miss, Ch. 27). A binary search *within* a page has poor spatial locality (it jumps around the page), which is why some engines lay keys out cache-obliviously (Eytzinger/van Emde Boas order) — an advanced optimization Postgres does not use, but the reason binary-search-in-node is not "free" even in memory.

---

## 62.14 The Lookup Algorithm: Descent and In-Node Binary Search

The algorithm is "descend, binary-searching within each node until you reach a leaf." Concretely, `lookup(q)`:

```
  page ← root (block number from metapage, §62.5)
  loop:
      pin page in buffer pool                      # §62.5 buffer manager
      if page is INTERNAL:
          i ← binary_search separators for q       # find child interval
          child ← downlink[i]
          if q > page.high_key:  child ← right_link # B-link: key moved right, §62.12
          unpin page
          page ← child                              # descend one level (one I/O if cold)
          continue
      else:  # LEAF
          i ← binary_search leaf keys for q
          if found:  return (key, TID) [+ walk right-links for duplicates/range]
          else:      return NOT FOUND (position i is the insert point)
```

Points that come up in interviews:

- **Every lookup, hit or miss, goes all the way to a leaf.** In a B+tree the value/TID is only in the leaf (§62.7), so there is no early termination at an internal node. Cost is uniform = tree height in page reads.
- **Descent is serialized.** You cannot read level k+1 until level k's binary search names the child. Height = length of the serial I/O chain — the reason §62.11's "4 levels" is the latency-critical number.
- **Binary search per node**, not linear scan: ~log₂(fanout) comparisons per page. Postgres's `_bt_binsrch` does exactly this on the page's sorted line-pointer array.
- **A "not found" still returns a position** — the leaf slot where the key *would* go — which is exactly what an insert needs (§62.16), so lookup and the first phase of insert share code.
- **The heap fetch is a separate, additional I/O.** For `SELECT * FROM t WHERE id=42`, the B-tree yields a **TID**, then Postgres reads the *heap* page and applies MVCC visibility (Ch. 61 §61.7, §61.16). So a point query is ≈ (index levels) + 1 heap read — of which the upper index levels are usually cached, leaving ~1 leaf read + 1 heap read as physical I/O (§62.21). An **index-only scan** can skip the heap read if the visibility map says the page is all-visible (Ch. 61 §61.13).

---

## 62.15 Occupancy Invariants: The B-Tree of Order m

The formal definition pins down "at least half full," which is what guarantees the fanout — and thus the logarithmic height — cannot silently collapse. A **B-tree of order m** (max m children per node) satisfies:

| Invariant | Rule |
|---|---|
| Max children | every node has ≤ **m** children (≤ m−1 keys) |
| Min children (non-root internal) | every internal node has ≥ **⌈m/2⌉** children |
| Min keys (non-root) | every node has ≥ **⌈m/2⌉ − 1** keys |
| Root | ≥ 1 key (≥ 2 children) unless it is the only (leaf) node |
| Depth | **all leaves are at the same depth** |
| Order | keys within a node are sorted; subtree key ranges are separated by the parent's separators |

The load-bearing invariant is the **minimum occupancy: every node except the root is at least ~half full.** Consequences:

- **Guaranteed fanout ≥ ⌈m/2⌉**, so height ≤ ~log_{⌈m/2⌉} N even in the worst case. Without a minimum, deletes could leave nodes with one key each, degenerating the tree back toward a tall chain. The minimum is what makes the O(log N) bound *hold under deletes*, not just after a clean build.
- **Space is at least ~50% utilized** in the worst case, ~69% (ln 2) on average under random insertions, and up to ~100% right after a bulk load. This bounds the on-disk size of the index to O(N).
- **Splits and merges are the enforcement mechanism.** An insert that would exceed m−1 keys triggers a **split** (§62.16); a delete that would drop below ⌈m/2⌉−1 keys triggers a **borrow or merge** (§62.17). These are the only two operations that change node count, and they are what keep every node inside `[⌈m/2⌉−1, m−1]` keys.

Terminology note: some texts define a B-tree by its **minimum degree t** instead, where each node holds between `t−1` and `2t−1` keys (so m = 2t). Same structure, different parameter. Interviewers may use either; be ready to translate `order m ↔ minimum degree t = ⌈m/2⌉`.

**Postgres caveat (important, §62.19):** `nbtree` enforces the *maximum* (it splits on overflow) but **deliberately does not enforce the minimum** — it does not merge underfull pages during normal operation. So a heavily-deleted Postgres index can hold pages far below half full, which is the origin of **index bloat**. The classic order-m minimum-occupancy invariant is a *theoretical* guarantee that real systems often relax on the delete side for concurrency reasons.

---

## 62.16 Node Splits on Insert

Inserts never make the tree taller by pushing leaves down; they make it taller by **splitting a full node and propagating a separator up**, growing the tree **at the root**. The algorithm, bottom-up:

1. Descend to the target leaf (§62.14); the lookup's "not found" position is the insert slot.
2. If the leaf has room (< m−1 keys), insert in sorted order. **Done — no propagation.** This is the overwhelmingly common case.
3. If the leaf is full, **split** it: divide its keys into a left and right half around a **median**, allocate a new sibling page, and **insert a separator + downlink for the new page into the parent.**
4. If the parent is now full, it splits too, recursively, up the tree.
5. If the **root** splits, allocate a **brand-new root** with one key and two children. **The tree's height increases by exactly one** — the only way that ever happens.

**Leaf split copies up; internal split pushes up** (the B+tree distinction, §62.7): a leaf must keep *all* its keys, so the separator is a **copy** of the right half's first key; an internal node's median key is a pure separator, so it is **moved** up and removed from the child.

Worked example, order m = 4 (max 3 keys/node), inserting into a leaf that is full:

```
Start: root=leaf [10 | 20 | 30]      (full: 3 keys)

Insert 40 → leaf overflows [10 20 30 40], split around median:
   left leaf [10 | 20]      right leaf [30 | 40]
   copy up first key of right half (30) as the new root separator:

            [ 30 ]                 ← NEW ROOT, tree height 1 → 2
           /      \
      [10 | 20]  [30 | 40]         ← leaves, linked ⇄

Insert 50, 60 → right leaf fills [30 40 50 60]... wait, 3-key max:
Insert 50 → [30 | 40 | 50] full.  Insert 60 → split [30 40 | 50 60]:
   push 50 up into root:
            [ 30 | 50 ]
           /    |     \
    [10 20] [30 40] [50 60]
```

Properties to state:

- **Splits propagate bottom-up, O(height) pages** in the worst case (a "cascading" split all the way to the root), but amortized O(1) because most inserts stop at step 2. Bulk sequential inserts (monotonic key) always split the **rightmost** page — Postgres has a *fast-path* for this (`_bt_search` right-most cache).
- **The tree stays perfectly balanced** because growth happens only at the root, lengthening *every* root-to-leaf path by one simultaneously.
- **Splits under crash/concurrency are the hard part** (Ch. 64): a split touches ≥ 2 pages (child + parent, or child + new sibling + parent) that must change atomically. Postgres uses the **right-link + high key** (§62.12) so a concurrent reader can still navigate a half-completed split, and WAL-logs the split as one atomic action (Ch. 65).
- A split at ~50/50 leaves both pages ~half full; Postgres biases **rightmost-page splits** heavily to the left (~90/10) so ever-increasing keys keep the left page packed — otherwise a monotonic workload would leave every page 50% full.

---

## 62.17 Node Merges and Rebalancing on Delete

Deletion is the mirror image: removing a key can drop a node **below the minimum occupancy** (⌈m/2⌉−1 keys) — an **underflow** — which is repaired by *borrowing* from a sibling or *merging* with one, and merges can shrink the tree at the root.

The classic (textbook / InnoDB-style) delete algorithm:

1. Find and remove the key from its leaf.
2. If the leaf still has ≥ ⌈m/2⌉−1 keys, **done.**
3. Else **underflow**. Try to **borrow (rotate)** from an adjacent sibling that has *spare* keys (> minimum): move one key from the sibling through the parent (the sibling's extreme key rotates up into the parent, the parent's separator rotates down into the deficient node). Occupancy restored, no merge.
4. If no sibling has a spare key, **merge** the deficient node with a sibling: combine their keys plus the parent's separator into one node, and **remove the separator + downlink from the parent.**
5. Removing the separator can now underflow the **parent**, so borrow/merge recurses upward.
6. If the merge empties the **root** (drops it to zero keys / one child), **delete the root and make its sole child the new root** — the tree's height **decreases by one.**

Worked example, order m = 4 (min = ⌈4/2⌉−1 = 1 key), borrow then merge:

```
            [ 30 | 50 ]
           /    |     \
    [10 20] [40]    [60 70]

Delete 40 → middle leaf [40] becomes empty (underflow, needs ≥1 key).
  Left sibling [10 20] has a spare → BORROW:
     move 20 up as new separator, pull old separator 30 down:
            [ 20 | 50 ]
           /    |     \
      [10]   [30]   [60 70]

Now delete 30 → middle leaf empty again.
  Left sibling [10] has NO spare (at minimum) → MERGE middle with left,
  pulling separator 20 down:
            [ 50 ]
           /      \
     [10 20]    [60 70]           ← parent lost a key; still valid
```

**PostgreSQL does almost none of this.** `nbtree` **does not borrow or merge underfull pages during normal deletes.** A deleted leaf entry is just marked dead / removed, and the page is left underfull. Merging is avoided because it would require locking multiple pages and the parent in a way that fights the B-link concurrency design (§62.18, Ch. 64). Instead:

- A page is only **fully emptied and unlinked** (recycled to the free space map) by **VACUUM**, and only when it becomes *completely* empty, not merely underfull.
- This is a deliberate trade: **cheap, highly-concurrent deletes in exchange for potential index bloat** (§62.19–§62.20). It is the single biggest divergence between the textbook B-tree and Postgres's real one.

So the honest interview answer is two-layered: *the general B-tree balances deletes with borrow/merge to preserve the half-full invariant; Postgres skips it, leaves pages sparse, and relies on VACUUM + REINDEX to reclaim space.*

---

## 62.18 PostgreSQL nbtree Internals

`nbtree` (`src/backend/access/nbtree/`) is Postgres's B+tree access method and the default for `CREATE INDEX`. Concrete facts worth having ready:

- **B+tree, 8 KB pages.** Every entry `(index key, heap TID)` lives in the leaf level; internal pages hold pivots + downlinks. Page = `BLCKSZ` = 8192 B (§62.3, §62.10).
- **Lehman & Yao B-link tree.** Each page carries a **high key** and a **right-link** to its sibling (§62.12). This is what lets Postgres do lookups and splits with only **per-page** locks (latches) instead of locking a path from root to leaf, giving high write concurrency (developed in Ch. 64). A reader that arrives at a page mid-split simply *moves right* if the wanted key exceeds the high key.
- **Metapage at block 0.** Points to the current root block and caches the tree level; read first on every descent (§62.5). The root's location changes on a root split, so the indirection is necessary.
- **TID as tiebreaker (PG 12+).** Duplicate index keys are kept in **heap-TID order**, making the key effectively unique internally. This makes index scans over duplicates stable and enables targeted deletion.
- **Suffix truncation (PG 12+).** Pivot tuples in internal pages are truncated to the shortest distinguishing prefix (§62.12), raising internal fanout and often shaving a level off wide-key indexes.
- **Deduplication (PG 13+).** Runs of equal keys in a leaf are stored once as a **posting list** `(key → list of TIDs)` instead of repeating the key per TID, dramatically shrinking low-cardinality indexes (e.g. a boolean or status column) and deferring page splits.
- **Bottom-up index deletion (PG 14+).** When a leaf is about to split due to churn from **non-HOT updates** (Ch. 61 §61.14), nbtree first tries to reclaim entries pointing to *dead* heap tuples on that page, frequently **avoiding the split entirely** and curbing "version churn" bloat.
- **Fast path for monotonic inserts.** A cached rightmost-leaf pointer lets ever-increasing keys (serial PKs, timestamps) skip the root-to-leaf descent and append directly, with a left-biased split (§62.16).
- **Height in practice: 3–5 levels.** For the vast majority of tables (up to hundreds of millions of rows) the index is 3–4 levels (§62.11). `SELECT * FROM bt_metap('idx')` and the `pageinspect` extension expose the actual `level`.

`nbtree` is thus a *B-link B+tree with suffix truncation, deduplication, and lazy space reclamation* — recognizably the textbook structure, tuned hard for concurrency and MVCC churn rather than for the classic minimum-occupancy invariant.

---

## 62.19 Why Postgres Rarely Merges: VACUUM and Page Splits

Tie together *why* Postgres relaxes the delete-side balancing of §62.17, because it is a favorite deep-dive question and it connects the B-tree to the whole MVCC story (Ch. 61 §61.14, Ch. 65).

**MVCC makes index churn constant.** Every `UPDATE` that changes an indexed column (or any non-HOT update) inserts a **new index entry** pointing at the new heap tuple version, while the old entry lingers until it is known dead. Deletes likewise leave index entries pointing at soon-dead tuples. So an nbtree is perpetually accumulating entries that will become garbage — far more write pressure on the index than a naive "one entry per live row" model.

**Merging would fight concurrency.** Borrowing/merging (§62.17) requires atomically locking a node, a sibling, and the parent, coordinated up the tree — exactly the multi-page, top-down locking the B-link design (§62.18) exists to *avoid*. Eager merges would serialize writers and reintroduce the contention B-link removed. So Postgres chooses **not to merge underfull pages** at all during DML.

**What reclaims space instead:**

- **VACUUM** scans the index, removes entries pointing to dead tuples, and — only when a page ends up **completely empty** — unlinks it and records it in the **free space map** for reuse by future splits. It does **not** consolidate two half-full pages into one.
- **Page splits are never undone.** Once a page splits, the two halves persist even if later deletes empty them below half full. A workload of "insert ascending, delete oldest" (a queue) can leave a long trail of sparse pages that VACUUM cannot merge — a classic bloat pattern.
- **`REINDEX` / `REINDEX CONCURRENTLY`** is the real remedy: it rebuilds the index from scratch, packing leaves to `fillfactor` and restoring minimal height. It is the only routine way to *shrink* an index and reset occupancy.
- **Bottom-up deletion (PG 14+, §62.18)** and **deduplication (PG 13+)** attack the problem preventively by deferring or avoiding splits, which reduces how much bloat accumulates in the first place — but they don't merge existing sparse pages either.

The one-line summary: **Postgres trades the textbook half-full guarantee for lock-light, MVCC-friendly writes, and pays for it with index bloat that VACUUM only partially reclaims and REINDEX fully fixes.**

---

## 62.20 fillfactor, Deduplication, and Index Bloat

**`fillfactor`** is the knob for how full B-tree pages are packed *at build/insert time*, trading space for split-avoidance.

- Default for a B-tree index is **90** (leaves filled to 90%, ~10% left free). Internal pages ignore fillfactor and pack full.
- **Lower fillfactor (e.g. 70)** leaves more free space per leaf, so subsequent inserts/updates near existing keys find room *without splitting* — good for tables with many in-place-ish updates, at the cost of a larger index and slightly worse scan density.
- **fillfactor 100** packs leaves completely — ideal for **read-only or append-only monotonic** indexes (nothing will be inserted between existing keys), giving the smallest, shallowest tree and best scan locality. Postgres already special-cases rightmost splits toward ~90/10 for monotonic keys (§62.16).

```
CREATE INDEX idx ON t (k) WITH (fillfactor = 100);   -- pack tight, read-mostly
CREATE INDEX idx ON t (k) WITH (fillfactor = 70);    -- leave slack for churn
```

**Index bloat** is the gap between an index's on-disk size and the size it *would* be if rebuilt. Its sources, all from this chapter:

| Source | Mechanism | Remedy |
|---|---|---|
| MVCC version churn | non-HOT updates add index entries per version (§62.19) | autovacuum; bottom-up deletion (PG 14) |
| Un-merged sparse pages | deletes leave pages < half full; nbtree never merges (§62.17) | REINDEX |
| Split fragmentation | 50/50 splits leave both halves half-empty under random inserts | REINDEX; tune fillfactor |
| Low-cardinality repetition | repeated keys stored per TID (pre-PG 13) | deduplication (PG 13+) |

**Deduplication** (PG 13+) is worth restating as a fanout multiplier: instead of storing `(status='active', TID1), (status='active', TID2), …` as N full entries, nbtree stores one posting-list tuple `status='active' → [TID1, TID2, …]`. For a column with few distinct values this can shrink the index several-fold and postpone splits, effectively *raising leaf occupancy* without touching fillfactor. It is enabled by default (`deduplicate_items = on`) except where semantics forbid it (e.g. unique indexes still allow it, but not with `INCLUDE`d columns in some versions).

To measure bloat: the `pgstattuple` extension (`pgstatindex('idx')`) reports `avg_leaf_density` and `leaf_fragmentation`; a healthy freshly-built index shows leaf density near the fillfactor, and heavy bloat shows it far lower.

---

## 62.21 Practical Numbers: Levels, Caching, and Latency

Assemble the numbers into the picture a senior engineer should be able to sketch on a whiteboard: **why B-trees are shallow, and why the upper levels are free.**

**Levels vs rows** (bigint key, f≈400, §62.11): 1 M → 3 levels, 1 B → 4, 1 T → 5. Real Postgres indexes are almost always **3–5 levels.**

**The upper levels stay cached, so height ≠ physical I/O.** Count the pages at each level of a 4-level, billion-key index:

```
  Level 3 (root):        1 page          ~8 KB      always in shared_buffers
  Level 2 (internal): ~400 pages       ~3 MB       trivially cached
  Level 1 (internal): ~160,000 pages   ~1.2 GB     mostly cached if index is hot
  Level 0 (leaves):  ~2,700,000 pages   ~21 GB      too big to fully cache
```

The top two-to-three levels are a few megabytes — they live permanently in the buffer pool for any actively used index. So a point lookup's **physical** cost is typically:

```
  root + upper internals ... cache hits (0 physical reads)
  leaf page ............... 1 physical read (if cold)         ~50–100 µs NVMe
  heap page .............. 1 physical read (Ch. 61 §61.16)    ~50–100 µs NVMe
  --------------------------------------------------------
  ≈ 2 physical reads for a cold point query, ~0 for a hot one
```

This is why B-trees dominate OLTP: **an indexed point lookup is ~2 random reads regardless of table size**, and both often hit cache. Compare the alternatives on a billion-row table:

| Access path | Page reads (cold) | Notes |
|---|---|---|
| Sequential scan | ~13 million (21 GB / 8 KB heap, plus more) | O(N); ruinous for a point query |
| BST (hypothetical on disk) | ~30 random | height ∝ log₂ N |
| **B-tree index scan** | **~2** (leaf + heap), upper levels cached | height ∝ log_f N |
| Index-only scan | ~1 (leaf; heap skipped if all-visible) | Ch. 61 §61.13 |
| Hash index (equality only) | ~1–2 | no ranges/order (§62.22) |

**Height barely grows with data.** Going from 1 M to 1 B rows (1000×) adds *one* level. Going 1 B to 1 T (1000×) adds *one* more. That logarithmic-in-a-huge-base scaling is the property that makes a B-tree a *database* index: the cost of a lookup is effectively constant across the entire practical range of table sizes, and the constant is tiny because fanout is huge and the top is cached.

---

## 62.22 B-Tree Versus Hash and Other Access Methods

The B-tree is the default, but not the only access method. Knowing when it is *not* the right structure is a common senior-level probe.

| Access method | Good at | Bad at | Postgres |
|---|---|---|---|
| **B-tree (B+tree)** | `=`, `<`, `>`, `BETWEEN`, `ORDER BY`, prefix `LIKE 'abc%'`, uniqueness | nothing major for ordered data; larger than hash | default (`nbtree`) |
| **Hash** | equality `=` only, ~O(1) | **no ranges, no ordering**, no sorting | `USING hash` (WAL-logged since PG 10) |
| **GiST** | ranges/geometry/nearest-neighbor, extensible | not a total order; balance heuristic | `USING gist` |
| **GIN** | multi-valued columns (arrays, JSONB, full-text) | slow point updates | `USING gin` |
| **BRIN** | huge, naturally-ordered tables (time-series) | random-ordered data | `USING brin` |
| **LSM tree** | write-heavy ingest, sequential writes | read/space amplification | not core (RocksDB/MyRocks, Ch. 67) |

Why the **B-tree remains the default** despite hash being faster for pure equality:

- **It is a superset of use cases.** A B-tree serves equality *and* ranges *and* ordering *and* uniqueness from one structure; a hash index does only equality. One index type covers `WHERE id=?`, `WHERE ts BETWEEN ? AND ?`, `ORDER BY`, and `UNIQUE` constraints.
- **Ordering is free.** Because leaves are sorted and linked (§62.8), the B-tree answers `ORDER BY` and range predicates without a sort step; a hash index cannot produce sorted output at all.
- **Predictable, bounded height.** 3–5 levels for anything realistic (§62.21), with the top cached — no hash-collision chains, no resize storms.

**BRIN** is the instructive contrast: for a 10-billion-row append-only time-series table, a B-tree index on the timestamp is itself hundreds of GB. A **BRIN** index stores just the min/max timestamp per *range of pages* (a sparse "zone map," Ch. 61 §61.8) — kilobytes instead of gigabytes — and works only because the data is *physically* ordered by time. It trades the B-tree's precise per-row lookup for near-zero size when the correlation between key order and physical order is high. This is the same buffering/ordering trade-off framing from Ch. 61 §61.15: the B-tree keeps keys ordered *in a separate structure*; BRIN exploits ordering that already exists in the *heap*; the LSM tree (Ch. 67) keeps ordering but buffers and appends instead of mutating in place.

The through-line to Chapters 63–67: this chapter defined the B-tree's **shape** (fanout, height, splits/merges). **Ch. 63** lays out how a single page is physically formatted (slotted pages, cell layout); **Ch. 64** makes the structure *concurrent and crash-safe* (the B-link locking sketched here, page-level latches, WAL); **Ch. 66** covers B-tree *variants* (copy-on-write B-trees like LMDB, Bε-trees, FD-trees); and **Ch. 67** develops the LSM tree — the buffered, immutable, append-only counterpart that makes the opposite choice on Ch. 61's three axes.

---

## Summary

- A BST is the right idea (ordered, logarithmic, range-friendly) and the wrong shape for disk: **fanout 2** wastes an 8 KB page on one comparison, and **height ~log₂ N ≈ 30** for a billion keys means ~30 serialized random I/Os. Balancing (AVL/red-black) fixes height but keeps fanout 2 and adds scattered-write rotations.
- The **block is the unit of I/O** (Postgres page = 8 KB). A B-tree makes each node a whole page with **fanout in the hundreds**, collapsing height to **~log_f N** and turning a page transfer into hundreds of comparisons.
- **Random I/O is the enemy** (HDD random ~10 ms vs sequential; NVMe random ~50–100 µs). Height = length of the serialized random-read chain, so cutting 30 reads to 4 is the B-tree's whole payoff.
- Databases use the **B+tree**: values only in leaves (higher internal fanout → shallower), leaves **linked** for range scans and `ORDER BY`. Postgres `nbtree` is a B+tree (Lehman & Yao **B-link**, with high keys and right-links for concurrency).
- Fanout for an 8 KB page and an 8-byte key is **~400**; a **billion-row index is ~4 levels**, a trillion-row index ~5. The **top 2–3 levels stay cached**, so a cold point lookup is ~2 physical reads (leaf + heap) regardless of table size.
- **Inserts split** full nodes bottom-up and grow the tree **at the root** (the only way height increases); **deletes** classically borrow/merge to keep nodes ≥ half full — but **Postgres does not merge underfull pages**, trading the occupancy invariant for lock-light MVCC writes and relying on **VACUUM/REINDEX** to reclaim bloat.
- The **order-m invariant** (nodes ≥ ⌈m/2⌉ children, all leaves at equal depth) is what guarantees logarithmic height under arbitrary deletes; `fillfactor` (default 90), **deduplication** (PG 13), **suffix truncation** (PG 12), and **bottom-up deletion** (PG 14) tune real occupancy and fanout.

---

## Key Interview Questions

1. **Why can't you just use a balanced BST (AVL/red-black) as a disk index?** — Fanout is still 2, so each 8 KB page transfer buys one comparison, and height is still ~log₂ N ≈ 30 for a billion keys → ~30 serialized random I/Os. Rotations also dirty several scattered pages per insert. Balancing optimizes comparisons/node-count; disk cares about page transfers.
2. **What is the single core idea of a B-tree?** — Make each tree node a whole page holding hundreds of sorted keys (high fanout m), so branching is base m ≫ 2. Height collapses to ~log_m N (3–5 levels), and each expensive page transfer yields hundreds of in-RAM comparisons.
3. **What is the difference between a B-tree and a B+tree, and which do databases use?** — A classic B-tree stores values in all nodes; a B+tree stores values only in leaves and links the leaves in sorted order. Databases (Postgres nbtree, InnoDB, SQLite) use B+trees because value-free internal nodes pack more separators → higher fanout → shallower tree, and linked leaves make range scans a sequential walk.
4. **Why is fanout in the hundreds, specifically?** — Because the page is kilobytes and keys are tens of bytes. An 8 KB Postgres page minus ~40 B overhead, divided by ~20 B per bigint entry, is ~400 entries. Fanout scales inversely with key width and with page size (InnoDB's 16 KB page ~doubles it).
5. **How many levels does a B-tree index on a billion rows have?** — About 4 (with bigint keys, fanout ~400: 400³×367 ≈ 23 B keys at height 4). A million rows is ~3 levels, a trillion ~5. Real Postgres indexes are almost always 3–5 levels.
6. **Why does the base of the logarithm matter if all logs differ by a constant?** — Because the "constant" is log₂(fanout) ≈ 8.6 for fanout 400, and each unit is a *serialized random I/O* costing µs–ms. log₄₀₀(10⁹) ≈ 4 vs log₂(10⁹) ≈ 30 is an ~8× reduction in real page reads on the latency-critical path.
7. **Does a B-tree reduce the number of comparisons versus a BST?** — No. Total comparisons are still ~log₂ N (≈ 4 pages × ~9 in-page binary-search steps ≈ 36). It moves those comparisons from slow page transfers onto already-loaded pages in RAM; it minimizes *page transfers*, not comparisons.
8. **What is the lookup algorithm?** — Start at the root (block from the metapage), binary-search separators to pick a child, descend, repeat until a leaf, then binary-search the leaf. Descent is serialized (can't read level k+1 until k names the child), and in a B+tree every lookup — hit or miss — reaches a leaf.
9. **How is a "child pointer" represented on disk and why not a real pointer?** — As a **page/block number**, resolved through the buffer manager. A raw memory pointer would be meaningless after restart because the file isn't mapped at a fixed address; on-disk structures address by page id + offset (Ch. 61 §61.4).
10. **What is a separator/pivot key?** — A boundary value in an internal node that says "keys below go to this child, keys at-or-above go to the next," not a value you can look up. In a B+tree the same key value can appear both as a leaf entry and as a copied-up separator.
11. **What is a high key and a right-link, and why do they exist?** — Postgres's B-link design stores a high key (upper bound on a page's keys ≈ first key of the right sibling) and a right-link to the sibling. If a search key exceeds the high key, it moved right due to a concurrent split, so the reader follows the right-link — enabling lookups/splits with only per-page locks (high concurrency).
12. **How does a B-tree grow taller?** — Only by a **root split**: when the root fills and splits, a new root with one key and two children is created, increasing height by one. Growth happens exclusively at the root, which is what keeps all leaves at equal depth.
13. **Walk through an insert that causes a split.** — Descend to the target leaf; if it has room, insert sorted. If full, split into two halves around the median, allocate a sibling, and insert a separator + downlink into the parent (leaf split *copies* the key up, internal split *pushes* it up). If the parent overflows it splits recursively; a root split adds a level.
14. **What are the occupancy invariants of a B-tree of order m?** — ≤ m children (≤ m−1 keys) per node; every non-root node ≥ ⌈m/2⌉ children (≥ ⌈m/2⌉−1 keys); all leaves at the same depth. The minimum-occupancy rule guarantees fanout ≥ ~m/2 and thus logarithmic height even after deletes.
15. **How does deletion keep the tree balanced in the textbook algorithm?** — Remove the key; if the node underflows (below ⌈m/2⌉−1 keys), borrow a key from a sibling with spare (rotate through the parent), else merge with a sibling and pull the separator down. Merges can underflow the parent, recursing up; emptying the root shrinks height by one.
16. **How is Postgres's delete/merge behavior different, and why?** — nbtree does **not** borrow or merge underfull pages during normal deletes — it leaves pages sparse — because merging would require multi-page top-down locking that fights the B-link concurrency design. It reclaims space only via VACUUM (empty pages) and REINDEX, accepting index bloat for lock-light writes.
17. **What is index bloat and how do you fix it?** — The gap between an index's actual size and a freshly-rebuilt size, caused by MVCC version churn, un-merged sparse pages, and split fragmentation. VACUUM removes dead entries and recycles fully-empty pages but never merges; REINDEX (CONCURRENTLY) rebuilds and repacks. pgstattuple measures it.
18. **What does fillfactor control and when would you change it?** — How full leaf pages are packed at build/insert time (default 90). Use 100 for read-only/append-only monotonic indexes (smallest, shallowest tree); lower it (e.g. 70) for churny tables so inserts find room without splitting. Internal pages ignore fillfactor.
19. **Why is a B-tree point lookup ~2 physical reads regardless of table size?** — The top 2–3 levels (root + upper internals) total a few MB and stay cached in shared_buffers, so only the leaf read and the heap fetch are physical (and often cached too). Height grows by just one level per ~1000× more rows.
20. **Why is Postgres nbtree called a B-link tree?** — It implements Lehman & Yao's design: high keys plus right-links let a reader that lands on a page mid-split move right to find relocated keys without locking the parent, so concurrent readers and writers coordinate with per-page latches instead of path locks (Ch. 64).
21. **What do suffix truncation, deduplication, and bottom-up deletion each do?** — Suffix truncation (PG 12) shortens internal pivots to the minimal distinguishing prefix → higher fanout, shallower tree. Deduplication (PG 13) stores repeated keys once as a posting list `(key→TIDs)` → smaller low-cardinality indexes. Bottom-up deletion (PG 14) reclaims dead entries to avoid splits from update churn.
22. **When is a hash index better than a B-tree, and why is B-tree still the default?** — A hash index answers pure equality in ~O(1) but supports no ranges, ordering, or sorting. The B-tree serves `=`, ranges, `ORDER BY`, prefixes, and uniqueness from one structure with predictable 3–5-level height and cached upper levels, so it is the sensible default; hash is a narrow optimization.
23. **Why does a B+tree make range scans efficient?** — Leaves are stored in sorted order and linked. A range query descends once to the first leaf (O(log_m N)) then walks right-links emitting matches — no re-descent per result — and the leaf order is sorted order, so `ORDER BY` needs no sort step.
24. **What is the metapage in a Postgres nbtree index?** — Block 0, which stores the current root's block number and cached level. Every descent reads it first (it is essentially always cached). It exists because the root's location changes whenever a root split grows the tree.
25. **Why do random writes hurt a B-tree, and how does that motivate LSM trees?** — In-place mutation of pages plus splits produces scattered random writes and torn-page risk (needing full-page WAL images). LSM trees (Ch. 67) instead buffer writes in memory and flush immutable sorted files sequentially, trading random-write cost for read/space amplification — the opposite choice on Ch. 61's three axes.
26. **Is early termination possible at an internal node in a B+tree?** — No. Because values/TIDs live only in leaves, every lookup must descend to a leaf even if the search key equals a separator; the separator is just a routing copy. Cost is uniform = tree height in page reads.
27. **Why does a monotonic (auto-increment) insert workload behave specially?** — Every insert lands in the rightmost leaf, so Postgres uses a cached rightmost-leaf fast path and biases the split ~90/10 to the left, keeping the left page packed instead of leaving every page 50% full as a balanced split would.
28. **How does a B-tree stay perfectly height-balanced without rotations?** — It grows only at the root (split propagation) and shrinks only at the root (merge collapse). Because both operations lengthen or shorten *every* root-to-leaf path simultaneously, all leaves are always at the same depth — no per-node rotation needed.

---

## Common Traps

- **Confusing B-tree with B+tree.** In interviews "B-tree" almost always means the B+tree databases actually use — values only in leaves, linked leaf list. Saying values live in internal nodes describes the rarely-used classic form.
- **Claiming a B-tree needs fewer comparisons than a BST.** It needs the same ~log₂ N comparisons; it needs far fewer *page transfers*. The win is I/O, not comparison count.
- **Thinking the log base is "just a constant factor."** log₂(fanout) ≈ 8–9 for realistic fanout, and each unit is a serialized random I/O — a billion-key lookup is ~4 reads vs ~30, an 8× difference on the latency-critical path.
- **Assuming Postgres merges underfull B-tree pages on delete.** nbtree does not merge or borrow on normal deletes; it leaves pages sparse and relies on VACUUM (only for fully-empty pages) and REINDEX, which is the root cause of index bloat.
- **Believing the whole index must be read/cached to do a lookup.** Only a few pages on the root-to-leaf path are touched; the top 2–3 levels (a few MB) stay cached, so a cold point lookup is ~2 physical reads regardless of a billion-row table.
- **Saying a leaf split moves the median up like an internal split.** A B+tree *leaf* split *copies* the separator up (leaves must keep all keys); only an *internal* split *moves* the median up and removes it from the child.
- **Ignoring that key width sets fanout and therefore height.** A 40-byte text key has ~1/3 the fanout of a 4-byte int and can add a level. Wide/random keys (e.g. random UUIDs) inflate both index size and split churn.
- **Forgetting the extra heap fetch in Postgres.** A B-tree scan yields a TID, not the row; the row needs a separate heap page read plus MVCC visibility (unless an index-only scan with an all-visible page skips it). Total point-query cost is index levels + 1.
- **Confusing "order m" with "minimum degree t."** Order m = max children; minimum degree t = min keys+1 with m = 2t. Both describe the same structure; translate before answering.
- **Treating tree height as physical I/O.** Height counts levels, but upper levels are cached, so height overstates the disk reads; conversely a sequential scan of a billion-row heap is millions of reads, not O(log N).
- **Assuming a hash index is strictly better for equality.** It is faster for pure `=`, but it cannot do ranges, ordering, or sorting, and offers no predictable bounded height — which is why the B-tree, not the hash index, is the default.
