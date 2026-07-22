# Chapter 67 — Log-Structured Storage

*Interview-focused revision notes. The theme: a B-tree fights the disk by mutating pages in place and paying for it in random writes; the LSM tree stops fighting — it buffers writes in memory, flushes them as immutable sorted files, and pays instead in background compaction and read amplification. Every mechanism in this chapter is a consequence of one decision: never overwrite, only append. PostgreSQL's heap is the in-place baseline we measure against; RocksDB and LevelDB are the reference LSM engines throughout.*

---

## 67.1 Motivation: Turning Random Writes Into Sequential Writes

Chapter 61 §61.15 laid down three orthogonal axes — **buffering**, **immutability**, **ordering** — and named the B-tree as the choice *unbuffered, in-place, ordered*. The **log-structured merge tree** (LSM tree) is the opposite corner on two of those axes: **buffered** and **immutable**, while keeping **ordered**. Everything in this chapter falls out of that one substitution.

The problem the LSM tree solves is the cost of a random write to an ordered on-disk structure. In a B-tree (Ch. 62), inserting a key means descending to the correct leaf, dirtying that page, and eventually writing it back — an in-place update at a location chosen by the key, not by the write order. On a billion-key tree with a working set larger than RAM, consecutive inserts scatter across the whole file: each is a random write, and each may trigger a page split that dirties more pages and, under a WAL, forces the modified page to be logged too. A B-tree insert can cost far more bytes written to disk than the size of the row itself.

The LSM insight: **do not put the write where its key belongs; put it where the disk head already is.** Buffer writes in memory, keep them sorted there, and when the buffer is full, flush it to disk as one large **sequential** write — a brand-new file, never an overwrite. Sorting happens in RAM (cheap); the disk only ever sees big append-only transfers.

```
B-tree insert (in-place, random):        LSM insert (buffered, sequential):
  key 500 → leaf at offset 0x4A00          key 500 → memtable (RAM, sorted)
  key 8   → leaf at offset 0x0080          key 8   → memtable (RAM, sorted)
  key 993 → leaf at offset 0x9C00          key 993 → memtable (RAM, sorted)
  → 3 random writes, maybe page splits     → 0 disk writes yet; one big
                                             sequential flush when memtable fills
```

Why this wins, quantitatively, and why it wins *more* on flash:

- **Sequential ≫ random.** On an NVMe SSD, sequential write bandwidth is ~2–7 GB/s while small random writes are limited by IOPS and by the flash program/erase cycle; on spinning disk the gap is 100–1000×. Batching turns many small random writes into a few large sequential ones (Ch. 34).
- **Flash wear and the erase-before-write penalty.** NAND flash cannot overwrite a page in place — a block must be *erased* (a slow, coarse-grained operation) before its pages are rewritten. In-place update patterns amplify writes inside the device (§67.24). Append-only patterns align with how flash actually works: the LSM writes large immutable runs and lets the old ones be reclaimed wholesale.
- **Write-heavy workloads.** Ingest pipelines, time-series, metrics, event logs, message queues, and write-through caches are dominated by inserts and updates. For these, the B-tree's read-optimized structure is paying a tax the workload never collects. The LSM inverts the trade.

The price, paid in full later in this chapter: a single logical key can now have copies scattered across many files, so **reads must check multiple places** (read amplification), and the obsolete copies must be **merged away in the background** (write and space amplification from compaction). The RUM conjecture (§67.17) is the formal statement that you cannot escape all three at once.

**Postgres note.** Core PostgreSQL is *not* an LSM engine: its heap is updated in place (a new tuple version is written into a heap page, §61.7), and while its **WAL** is genuinely log-structured and append-only, the WAL is a *recovery log*, not the primary queryable store — you never read rows out of the WAL during normal operation. So Postgres is our contrast baseline: log-structured *durability* on top of an in-place *primary store*. An LSM engine makes the log-structured file *the* store. (MyRocks — MySQL on RocksDB — and OrioleDB are the Postgres-adjacent points where an LSM-style or undo-log engine replaces the heap.)

---

## 67.2 The LSM Tree: Structure and Components

An LSM tree is a **collection of sorted runs at increasing scales**, split across memory and disk. The canonical structure (LevelDB, RocksDB, Cassandra, HBase) has three moving parts:

```
        WRITES                                                READS check all of:
          │
          ▼
   ┌───────────────┐   append          ┌──────────────────────────────┐
   │  WAL / commit │◀──────────────────│  (durability only, not read   │
   │  log (disk)   │                   │   on the query path)          │
   └───────────────┘                   └──────────────────────────────┘
          │
          ▼
   ┌───────────────┐   in RAM, sorted (skip list). Mutable.
   │   MEMTABLE    │◀───────────────────────────────────────────  ① checked first
   └───────────────┘
          │  when full, becomes immutable and is flushed
          ▼
   ┌───────────────┐   in RAM, sorted, read-only, awaiting flush
   │ IMMUTABLE     │◀───────────────────────────────────────────  ② checked next
   │ MEMTABLE(s)   │
   └───────────────┘
          │  flush → one new SSTable
          ▼
   ┌─────────────────────────────────────────────┐
   │  SSTABLES on disk (immutable, sorted)        │◀──────────────  ③ newest → oldest
   │  Level 0:  [sst][sst][sst]   (may overlap)   │
   │  Level 1:  [────sst────][────sst────]        │  organized by
   │  Level 2:  [──sst──][──sst──][──sst──]  ...  │  compaction (§67.12)
   └─────────────────────────────────────────────┘
                        ▲
                        │ background COMPACTION merges & discards obsolete data
```

The two categories:

- **In-memory table (memtable):** a mutable, sorted, in-memory structure that absorbs writes. Usually a **skip list** (Ch. 21 §21.13) — sorted, supports concurrent readers with a single writer, and gives O(log n) insert and lookup without the rebalancing of a tree. When it reaches a size threshold it is frozen and a new empty memtable takes over.
- **On-disk tables (SSTables):** **Sorted String Tables** — immutable files holding key-value pairs sorted by key, plus an index and metadata (§67.5). Once written, an SSTable is never modified; it is only ever read or, eventually, deleted after its live data has been merged into a newer file.

The defining property: **the memtable is the only mutable component. Everything on disk is immutable.** That single fact is why LSM reads are lock-free (§67.23), why crash recovery is simple (replay the WAL into a fresh memtable), and why compaction can run concurrently with queries (it produces new files and atomically retires old ones).

The name decomposes: **Log-Structured** (writes are appended, never overwritten) **Merge** (obsolete data is reconciled by merging sorted runs) **Tree** (the runs form a hierarchy of increasing size). The original 1996 O'Neil et al. design used two disk components (C0 in memory, C1 on disk); modern engines generalize to many levels (§67.6).

---

## 67.3 The Memtable

The memtable is the write-absorbing buffer and the first thing every read consults. Requirements: **sorted** (so a flush produces a sorted SSTable directly, and so range scans work), **fast concurrent insert and lookup**, and **cheap iteration in key order**.

The dominant choice is a **skip list** (Ch. 21 §21.13):

- It keeps keys sorted, giving O(log n) insert/find and O(1) ordered iteration from any position.
- It supports **lock-free or single-writer/multi-reader concurrency** naturally: inserts splice nodes with a few atomic pointer updates, and readers traversing the list never see a torn structure. RocksDB's default memtable is a concurrent skip list allowing multiple concurrent writers.
- Unlike a balanced BST, it needs no rotations — insertions are local pointer splices, which is friendlier to concurrent modification.

Alternatives exist (RocksDB offers a hash-linked-list memtable for workloads that never range-scan, and a vector memtable for bulk load), but skip list is the general-purpose default. A red-black tree or B-tree in memory would also work; the skip list wins on concurrency simplicity.

Sizing and the memtable lifecycle:

- The memtable has a **size budget** (RocksDB `write_buffer_size`, default 64 MB). When exceeded, it is **switched**: the active memtable is marked immutable, a fresh empty one is installed as the write target, and the immutable memtable is queued for a background **flush** to L0.
- Multiple immutable memtables can coexist briefly if flushing lags ingest (`max_write_buffer_number`). If they pile up past the limit, writes **stall** — back-pressure that protects the engine from unbounded memory growth.
- The memtable holds **not just values but tombstones** (§67.7) and multiple versions of the same key; sorting keeps versions of one key adjacent so a lookup returns the newest.

Because the memtable lives only in RAM, it is **not durable on its own** — a crash loses it. Durability comes from the WAL written *before* the memtable is updated (§67.4). The memtable is essentially a materialized, queryable view of the tail of the WAL.

---

## 67.4 The Write Path

A write (put or delete) in an LSM engine touches two structures, in a fixed order dictated by durability:

```
put(k, v):
  1. Append (k, v) to the WAL and, per the durability policy, fsync it.     ─ durability
  2. Insert (k, v) into the active memtable (skip-list splice).             ─ queryability
  3. Acknowledge the write to the client.
  (No SSTable is touched. No random disk write happens.)

  ... asynchronously, later ...
  4. Memtable fills → switch → flush immutable memtable to a new L0 SSTable.
  5. Once the SSTable is durable, the corresponding WAL segment can be discarded.
```

Why the WAL comes first: the memtable is volatile, so if step 2 happened and the process crashed before the data reached an SSTable, it would be lost. The **write-ahead-logging rule** — log the change durably *before* it is considered committed — is the same principle as the recovery log in a B-tree engine (Ch. 65) and the AOF in Redis (§61.5). On restart, the engine **replays the WAL into a fresh memtable**, reconstructing exactly the pre-crash in-memory state, then resumes.

The durability knob is *when* the WAL is flushed:

- **Sync per write** (`fsync`/`fdatasync` each commit): fully durable, but throughput is capped at the device sync rate (tens to hundreds of microseconds per sync, Ch. 34).
- **Group commit / batched sync:** many writes share one `fsync`, trading a bounded loss window for far higher throughput.
- **WAL disabled / OS-buffered:** fastest, but a crash can lose recent writes. RocksDB exposes `WriteOptions::sync` and a `manual_wal_flush` mode; Cassandra's commitlog offers `periodic` (default, ~10 s window) vs `batch` sync.

Note the elegance: **the write path never performs a random write and never reads the disk.** It is a sequential WAL append plus an in-memory splice. This is why LSM engines sustain enormous write throughput — the per-write disk cost is amortized into the occasional large sequential flush. Contrast a B-tree, where the same insert may read a leaf page, split it, and write several pages back at key-scattered offsets.

**Flush** (step 4) is itself a purely sequential operation: iterate the immutable memtable in sorted order and stream it out as an SSTable's data blocks, index, and Bloom filter (§67.5). Because the memtable was already sorted, no external sort is needed.

---

## 67.5 SSTables: Sorted String Table Layout

The **Sorted String Table** is the on-disk unit of an LSM tree — an **immutable file of key-value pairs sorted by key**, self-describing enough to be searched without any external state. The LevelDB/RocksDB physical layout:

```
SSTable file (immutable)
┌───────────────────────────────────────────────────────────┐
│ Data block 0   : sorted [k,v][k,v]...   (~4–32 KB, then    │
│ Data block 1   : sorted [k,v][k,v]...    compressed)       │
│ ...                                                        │
│ Data block N                                               │
├───────────────────────────────────────────────────────────┤
│ Filter block   : Bloom filter over all keys (§67.9)        │
├───────────────────────────────────────────────────────────┤
│ Index block    : one entry per data block →                │
│                  (last key in block, block offset, length) │  ← sparse index
├───────────────────────────────────────────────────────────┤
│ Footer (fixed) : offsets of index block & filter/meta      │
│                  + magic number                            │
└───────────────────────────────────────────────────────────┘
```

The pieces and why each exists:

- **Data blocks.** Sorted key-value pairs packed into fixed-ish-size blocks (RocksDB `block_size`, default 4 KB). Within a block, keys are often **prefix-compressed** (restart points every ~16 keys let you binary-search without decompressing the whole block). The block is the unit of I/O and of the block cache (§67.19).
- **Index block.** A **sparse index** (§61.11): one entry per data block giving the block's last (or first) key and its file offset. To find a key you binary-search the index to locate the one block that could contain it, read that block (one I/O), and scan/binary-search within it. So a point lookup in one SSTable costs *one index consultation + one block read*, not a scan of the file.
- **Filter block.** A **Bloom filter** over the SSTable's keys (§67.9), letting a lookup skip the file entirely if the key is definitely absent — the single most important LSM read optimization.
- **Footer.** Fixed-size trailer with the offsets of the index and metadata blocks plus a magic number, so the whole file can be navigated starting from its end.

Because the file is immutable and sorted, several things become trivial: the index and Bloom filter are built once at flush time and never maintained; concurrent readers need no locks (the bytes never change); and merging two SSTables is a linear scan of two sorted streams. The cost of immutability is that an update to one key does not modify its SSTable — it lands in a *newer* SSTable, and the two copies coexist until compaction reconciles them (§67.11).

SSTables are grouped into **levels** and, in RocksDB, an SSTable is internally divided so a large logical table can be one file per key-range. HBase calls its equivalent files **HFiles**; Cassandra calls them **SSTables** and splits each into `Data.db`, `Index.db`, `Filter.db`, `Summary.db`, and `Statistics.db` companion files — the same conceptual pieces as separate files.

---

## 67.6 Two-Component vs Multi-Component LSM Trees

The original LSM design (O'Neil, Cheng, Gawlick, O'Neil, 1996) was **two-component**: **C0** in memory and **C1** on disk, with a rolling merge continuously pushing C0 into C1. Every write eventually participated in merging the *entire* C1, which made write amplification a function of the whole dataset size — impractical as data grew.

Modern engines are **multi-component (multi-level)**: rather than one giant on-disk component, they keep a **series of levels of geometrically increasing size**, and merges happen level-by-level so each merge touches a bounded amount of data.

```
Two-component (classic):          Multi-component (LevelDB/RocksDB):
  C0 (RAM)                          memtable (RAM)
   └── rolling merge ──►            L0  ~ a few SSTables (flush output, may overlap)
  C1 (disk, whole dataset)         L1  ~ 10× L0 target
                                   L2  ~ 10× L1
                                   L3  ~ 10× L2
                                   ...  (each level ~T× the previous; T≈10)
```

Key ideas of the multi-level structure:

- **Geometric size ratio T** (RocksDB `max_bytes_for_level_multiplier`, default 10). Level *i+1* is T times the size of level *i*. With T=10, a handful of levels covers terabytes: L1=256 MB, L2=2.56 GB, L3=25.6 GB, L4=256 GB.
- **Number of levels** ≈ log_T(N / memtable_size). This logarithm bounds both read cost (how many levels a lookup may consult) and write cost (how many times a key is rewritten on its way down).
- **L0 is special.** SSTables flushed from the memtable land in **L0** and may have **overlapping key ranges** with each other (each is an independent memtable snapshot). L1 and below are kept **non-overlapping** by leveled compaction (§67.13), which is what makes a lookup below L0 need to check only *one* SSTable per level.

The two-vs-multi distinction is really the origin of the two compaction families (§67.12): keeping many same-size runs and merging them in tiers (size-tiered, closer to accumulating C0 flushes) versus maintaining strict non-overlapping levels (leveled). Both are "multi-component"; they differ in how aggressively they merge.

---

## 67.7 Updates and Deletes: Tombstones

Immutability creates an immediate problem: **if you never overwrite, how do you update or delete?** The answer defines LSM semantics.

- **Update** = insert a new version of the key. The new key-value pair goes into the memtable and eventually an SSTable; the old copy still physically exists in an older SSTable. On read, **newest wins** (§67.11), so the update is visible immediately. The old copy is *garbage* that compaction will discard.
- **Delete** = insert a **tombstone**: a special marker `(key, DELETE)` that records "this key is deleted as of this point." A delete is therefore a **write**, not a subtraction — it *adds* a record. The tombstone shadows any older value of the key on read.

```
timeline of writes to key "user:42":
   put(user:42, "Alice")     → lands in SSTable at L3   (oldest)
   put(user:42, "Alice2")    → lands in SSTable at L1
   delete(user:42)           → tombstone in memtable    (newest)

read(user:42): scan newest→oldest, first hit is the TOMBSTONE → return "not found"
   (the two older values still exist on disk until compaction removes them)
```

Why tombstones are subtle and dangerous — a favorite interview topic:

- **Deletes cost space and I/O, not save them.** A delete makes data *bigger* until compaction. Deleting a billion keys writes a billion tombstones.
- **Tombstones must outlive every older copy.** A tombstone can only be dropped once compaction is certain no older SSTable still holds a shadowed value for that key — typically only when compaction reaches the **bottommost level**. Drop a tombstone too early and the old value **resurrects**: the classic "deleted data comes back" bug. This is acute in distributed stores (Cassandra), where a tombstone must survive at least `gc_grace_seconds` (default 10 days) so it can propagate to every replica before being collected; otherwise a replica that missed the delete re-introduces the value during repair.
- **Range deletes are worse.** A single `DeleteRange(a, z)` logically removes many keys. Naively that is one tombstone covering a range (RocksDB range tombstones) or, worse, one point tombstone per key. Either way, **reads over the deleted range must still traverse the tombstones**: a query scanning a range that was heavily deleted can read millions of tombstones to return zero rows. Cassandra's infamous "tombstone overwhelming" query failures come from exactly this — scanning past `tombstone_failure_threshold` (default 100,000) tombstones aborts the query.
- **Read-side cost.** Because a tombstone is just another record, the read path must merge it in like any value; a range scan pays for every tombstone it passes even though they produce no output.

The takeaway: **in an LSM tree, deletes are writes, and reclaiming the space they logically free requires compaction.** This inverts the intuition from an in-place engine, where a delete frees space more or less immediately.

---

## 67.8 The Read Path: Lookups and Read Amplification

A point lookup must find the **newest** version of a key across all components, checking them in newest-to-oldest order and stopping at the first hit (which may be a tombstone → "not found"):

```
get(k):
  1. Active memtable            (RAM)      — hit? return newest version / tombstone
  2. Immutable memtable(s)      (RAM)      — hit? return
  3. L0 SSTables, newest first  (disk)     — L0 overlaps, so check EACH L0 file
                                             (Bloom filter first — skip if absent)
  4. L1 SSTable covering k      (disk)     — non-overlapping: at most ONE file
  5. L2 SSTable covering k      (disk)     — at most one file
     ...down through the levels...
  → first version found wins; if none, key does not exist.
```

The costs:

- **Read amplification.** A single logical read may consult many files. Worst case with no Bloom filters: memtable + every L0 file + one file per lower level. If L0 holds up to 4 files and there are 6 levels, that is up to ~10 places to check for one key. **Reads are the LSM's weak spot**, the mirror image of its write strength.
- **Bloom filters cut the disk cost dramatically** (§67.9): for a key absent from an SSTable, the filter says "no" ~99% of the time without any block read, so a lookup for a non-existent key touches ~zero data blocks per SSTable instead of one. This is why LSM point lookups are viable at all.
- **The block cache and index** (§67.19) keep frequently accessed index and data blocks in RAM, so a "disk" check is often a memory hit.
- **Existence checks vs value reads.** A lookup that finds the key in the memtable or a high level is cheap; the expensive case is a key that lives only in a **deep level**, or a query for a **non-existent key** that must be ruled out of every SSTable (Bloom filters make even this cheap).

**Range scans** cannot use Bloom filters (a filter answers point membership, not "is any key in [a,b] present"). A range scan opens an iterator on *every* component whose key range overlaps the query and does a **merge iteration** (§67.10) across them, which is why range scans over LSM data are inherently multi-way and why keeping levels non-overlapping (fewer runs) matters for scan performance.

The structural point: **an LSM trades cheap writes for expensive reads.** Compaction (§67.12) exists partly to *reduce* read amplification by merging many runs into fewer, non-overlapping runs — spending write I/O to buy back read performance.

---

## 67.9 Bloom Filters

The **Bloom filter** (Ch. 21 §21.19) is the mechanism that makes LSM point lookups practical. Without it, a `get` for a key that happens to live in the deepest level (or nowhere) would read one data block from *every* SSTable to rule the key out. The Bloom filter answers "**is this key definitely absent from this SSTable?**" from a small in-memory bit array, with **no false negatives** and a tunable **false-positive rate**.

How it applies here: each SSTable carries a Bloom filter over its keys (the filter block, §67.5), usually kept in RAM (or the block cache). On a lookup, before reading any data block from an SSTable, consult its filter:

- Filter says **"absent"** → skip this SSTable entirely (0 data-block reads). Guaranteed correct: no false negatives.
- Filter says **"maybe present"** → read the indexed data block and check for real. This is either a true hit or a **false positive** (wasted block read).

The false-positive math (the interview numbers): for a filter with **m** bits over **n** keys using **k** optimal hash functions, the false-positive probability is approximately

```
  p ≈ (1 − e^(−kn/m))^k,   minimized at k = (m/n)·ln 2
```

which in practice means:

| bits per key (m/n) | optimal k | false-positive rate p |
|---|---|---|
| 5  | ~3 | ~9.2% |
| 8  | ~6 | ~2.1% |
| 10 | ~7 | ~1.0% |
| 12 | ~8 | ~0.45% |
| 16 | ~11 | ~0.05% |

RocksDB defaults to **10 bits per key** (~1% false positives) — roughly 1.25 bytes of RAM per key to eliminate ~99% of unnecessary SSTable probes. Cassandra's `bloom_filter_fp_chance` defaults to 0.01 for leveled compaction and 0.1 for size-tiered (bigger tables get cheaper filters).

Refinements the reference engines use:

- **Full vs block-based filters.** RocksDB's `full_filter` (one filter for the whole SSTable) replaced the older per-block filter, avoiding a filter lookup per block.
- **Ribbon filters** (RocksDB) achieve the same FPR at ~30% fewer bits than a Bloom filter, at higher construction cost.
- **Prefix Bloom filters** enable filtering on a key *prefix*, letting some range/prefix scans skip SSTables.
- **Filters do not help pure range scans** over arbitrary ranges, and they cost RAM: at 10 bits/key, 1 billion keys ≈ 1.25 GB of filters. Memory-constrained deployments sometimes drop filters on the largest (bottommost) level, where most data lives but lookups are rarer.

The essential trade: a small, fixed amount of RAM per key converts LSM read amplification from "one block read per SSTable" to "one block read per SSTable *that actually contains the key* (plus a ~1% false-positive tax)."

---

## 67.10 Merge Iteration Across Sorted Runs

Both **range scans** and **compaction** need to read many sorted runs (memtables, SSTables) as a single sorted stream. This is a **k-way merge**, and the standard implementation is a **min-heap (priority queue) of iterators**, one per run (Ch. 21's heap):

```
k sorted runs, each with a cursor at its current smallest key:

  run A: [ a1  d4  f7 ... ]   cursor→ a1
  run B: [ b2  d9  e3 ... ]   cursor→ b2       min-heap keyed on (current key)
  run C: [ a5  c1  g8 ... ]   cursor→ a5       ┌──────────────┐
                                               │ root = a1 (A)│  ← smallest
  step: pop heap-min → emit/merge → advance    └──────────────┘
        that run's cursor → re-heapify.
```

The algorithm:

1. Initialize the heap with the head element of each of the k runs. Heap ordered by key (ties broken so the **newest run wins**, §67.11).
2. Pop the minimum. That is the next key in global sorted order.
3. Advance the cursor of the run the minimum came from; push its new head into the heap.
4. Repeat until all runs exhausted.

Cost: emitting N total elements across k runs is **O(N log k)** — each element is pushed and popped once, and heap operations are O(log k). Memory is O(k): one buffered element (or one block) per run, not the whole dataset. This is exactly why merging is cheap and streaming: it never materializes more than one element per run at a time, so two 100 GB SSTables merge in bounded memory with sequential reads and a sequential write.

Two consumers of the same merge:

- **Range scan / iterator:** the merge output is handed to the query, with reconciliation applied (dedupe versions of a key, honor tombstones). The runs are memtable + immutable memtables + all overlapping SSTables.
- **Compaction:** the merge output is written to new SSTable(s), with obsolete versions and eligible tombstones dropped. The runs are the SSTables selected for compaction.

Because SSTables are sorted and immutable, this merge is a **sequential read of each input and a sequential write of the output** — the disk-friendly access pattern the whole design is built to produce. The heap makes the k-way case as cheap as a two-way merge up to the log k factor.

---

## 67.11 Reconciliation: Newest Wins

When the merge (§67.10) encounters **multiple entries for the same key** across runs — the direct result of updates and deletes never overwriting — it must **reconcile** them into a single logical answer. The rule: **the newest version wins, and a tombstone means the key is absent.**

"Newest" is determined by an ordering the engine imposes on writes. RocksDB stamps every write with a monotonically increasing **sequence number**; the internal key is `(user_key, sequence_number, type)` and is sorted by user key ascending then **sequence number descending**, so among equal user keys the newest is encountered first. Cassandra uses client-supplied or coordinator **timestamps** as the conflict resolver (last-write-wins by timestamp — with the well-known hazard that clock skew can make a "later" write lose).

```
merge sees these entries for user key "x" (newest → oldest):
   (x, seq=91, PUT "v3")      ← newest: this is the answer
   (x, seq=77, PUT "v2")      ← obsolete, discard
   (x, seq=40, DELETE)        ← obsolete
   (x, seq=12, PUT "v1")      ← obsolete
→ result: x = "v3"

if instead the newest were (x, seq=91, DELETE):
→ result: x absent; but the DELETE tombstone can only be physically dropped
  once no older SSTable for x can exist (bottommost level, §67.7).
```

Consequences:

- **Read reconciliation** stops at the first (newest) entry for a key — a scan need not read older versions once it has the newest. But it must *reach* the newest, which is why versions are kept adjacent by the sort order.
- **Compaction reconciliation** keeps only the newest version *that any live read could need*. With MVCC/snapshots (§67.23), older versions still visible to an open snapshot must be retained; only versions older than the oldest live snapshot are safe to drop.
- **Tombstone retention** is the tricky part: a tombstone is "the newest version says deleted," but dropping it during compaction is only safe when the compaction includes the bottommost level (no older shadowed value can survive elsewhere). Until then the tombstone must be carried forward, even up-level, so it keeps shadowing.
- **Clock-based reconciliation is fragile.** Cassandra's timestamp LWW means a write with a skewed-forward clock can permanently shadow a semantically newer write. Sequence-number ordering (single-node RocksDB) is exact because it is a true logical order.

Reconciliation is where the LSM's "append instead of overwrite" cost is finally paid back: the physical duplication introduced by immutability is collapsed to the correct logical value at read and compaction time.

---

## 67.12 Compaction: Role and Cost

**Compaction** is the background process that merges SSTables, discards obsolete data, and reorganizes runs. It is the counterpart to VACUUM in Postgres (§61.14) and the engine's most important — and most expensive — maintenance task. Without it, an LSM tree degenerates into an ever-growing pile of overlapping SSTables that reads must all consult.

What compaction accomplishes:

- **Reduces read amplification:** merges many runs into fewer, non-overlapping runs, so a lookup consults fewer files.
- **Reclaims space:** drops superseded versions (older PUTs shadowed by newer ones) and eligible tombstones, shrinking on-disk size back toward the live-data size (reducing space amplification).
- **Maintains the level structure:** pushes data down the levels so the size invariants (§67.6) hold.

What compaction costs — and this is the central trade of the whole chapter:

- **Write amplification:** every key is **rewritten each time it moves down a level**. With T=10 leveled compaction, a key can be rewritten ~10× per level (it is merged with ~T times its own volume from the level below each time it descends), so total bytes written to disk can be **10–30× the bytes ingested**. This is the price of keeping reads cheap.
- **I/O and CPU:** compaction reads and rewrites large volumes, competing with foreground queries for disk bandwidth, CPU (decompression/recompression, merge), and block cache. Poorly tuned compaction causes latency spikes.
- **Write stalls:** if compaction cannot keep up with ingest, L0 files or pending memtables accumulate; the engine throttles or stalls writes to let compaction catch up (RocksDB `level0_slowdown_writes_trigger` / `level0_stop_writes_trigger`).

```
compaction merges overlapping/superseded data into cleaner runs:

  before:  L0: [a..z][a..z][a..z]   ← 3 overlapping files, reads check all 3
           L1: [a..m][n..z]
  after:   L0: (empty)
           L1: [a..m][n..z]         ← merged, deduped, tombstones applied,
                                       non-overlapping; reads check 1 file
```

The knob nobody escapes: **compaction converts write amplification into lower read and space amplification.** Compact aggressively → fewer runs, cheaper reads, tighter space, but more write I/O. Compact lazily → cheaper writes, but more runs, higher read amplification, and more wasted space. §67.13–67.15 are three different points on this curve.

---

## 67.13 Leveled Compaction

**Leveled compaction** (LevelDB's original, RocksDB's default for lower levels, Cassandra's LCS) is optimized for **reads and space** at the cost of **write amplification**. The defining invariant: **within each level L1 and below, SSTables have disjoint (non-overlapping) key ranges**, so a lookup consults **at most one SSTable per level**.

```
Level 0: [a..f][c..k][h..z]   ← overlapping (flush output); read checks all
Level 1: [a..d][e..j][k..p][q..z]   ← non-overlapping, ~256 MB total
Level 2: [a..b][c..d]...[y..z]      ← non-overlapping, ~2.56 GB total (10×)
Level 3: ...                        ← ~25.6 GB (10×) ...
```

How it works:

- Each level has a **target size**; level *i+1* is T× (default 10×) level *i*.
- When a level exceeds its target, compaction picks (typically) **one SSTable** from it and **all overlapping SSTables in the next level down**, merges them, and writes the non-overlapping result into level *i+1*. Because ranges are disjoint, picking one file from Li overlaps only a bounded slice of Li+1.
- **L0→L1 is special:** L0 files overlap each other, so an L0→L1 compaction merges *all* current L0 files with the overlapping L1 range.

Properties:

- **Read amplification: low.** ≤1 SSTable per level below L0, plus the L0 files. Combined with Bloom filters, a point lookup reads very few blocks.
- **Space amplification: low.** At most ~10% of data is "extra" (the invariant keeps each level near its target and one full copy dominates); the RocksDB rule of thumb is space amplification ≈ 1.11.
- **Write amplification: high.** Each key is rewritten roughly T times per level on its way down; total ~10–30×. Merging one Li file pulls in ~T files from Li+1, so each byte written to Li causes ~T bytes rewritten in Li+1.

Leveled compaction is the right default for **read-heavy or space-constrained** workloads and for datasets where predictable, bounded space matters. It is the wrong choice for **write-saturated** ingest, where its write amplification becomes the bottleneck — that is where size-tiered wins.

---

## 67.14 Size-Tiered Compaction

**Size-tiered compaction** (Cassandra's STCS, the default there; RocksDB's "universal compaction" is closely related) optimizes for **write amplification** at the cost of **read and space amplification**. Instead of maintaining strict non-overlapping levels, it groups SSTables into **size tiers** and merges several **similarly-sized** tables into one larger table when enough have accumulated.

```
Size-tiered: accumulate same-size runs, merge when a tier has ≥ min_threshold:

  small tier: [64MB][64MB][64MB][64MB]  ── merge 4 ──►  [~256MB]
  next tier:  [256MB][256MB][256MB][256MB] ── merge ──► [~1GB]
  next tier:  [1GB][1GB]...              ── merge ──►    [~4GB]
  (multiple OVERLAPPING runs coexist at each size; reads check them all)
```

How it works (Cassandra STCS): when at least `min_threshold` (default 4) SSTables of roughly the same size exist, they are merged into one. The output is bigger and joins the next size bucket, where it again waits for peers. Multiple overlapping SSTables of similar size coexist at every tier.

Properties:

- **Write amplification: low.** A key is rewritten only ~log_f(N/memtable) times total (f = fan-in, ~4), each merge combining a bounded number of same-size runs. Fewer rewrites than leveled → better for write-heavy ingest.
- **Read amplification: high.** Multiple overlapping runs per tier means a lookup may check many SSTables (Bloom filters mitigate but do not eliminate this); range scans merge across all of them.
- **Space amplification: high.** A merge of k same-size tables transiently needs room for the inputs *and* the output; worst case an update-heavy workload keeps many obsolete copies until the big infrequent merges happen. STCS can need **~2× the live data size** in the worst case (and transiently more during a big compaction), which is why Cassandra clusters keep substantial free disk headroom.
- **Big-table problem:** as tables grow, top-tier compactions become huge and rare, so obsolete data in the largest tables lingers a long time, and one enormous SSTable can dominate.

Size-tiered is the right default for **write-heavy, append-mostly** workloads (time-series, logs, immutable events) where reads are recent-biased and space is cheap. Cassandra offers it as STCS and offers **leveled (LCS)** for read-heavy/update-heavy tables that need bounded space and low read amplification — the same read/write/space trade, exposed as a per-table knob.

---

## 67.15 Time-Window Compaction and Other Strategies

Beyond the two canonical families, real engines ship specialized strategies for specific access patterns:

- **Time-Window Compaction (TWCS, Cassandra).** For **time-series** data where rows are written once, never updated, and expire via TTL. Data is bucketed into **time windows** (e.g. one day); SSTables within a window are size-tier-compacted, but **windows are never compacted together**. The payoff: an entire expired window becomes one or a few SSTables that can be **dropped whole** once every row's TTL passes — no tombstone scanning, no rewriting live data to expire old data. This sidesteps the tombstone-cost problem (§67.7) for the workload where it hurts most. (DTCS, its predecessor, had edge-case bugs and TWCS replaced it.)
- **FIFO compaction (RocksDB).** For **caches and short-lived data**: when total size exceeds a limit, simply **delete the oldest SSTable**. No merging at all — the ultimate low-write-amplification strategy, valid only when the workload tolerates losing the oldest data.
- **Universal compaction (RocksDB).** RocksDB's size-tiered analog: merges runs to bound the *number* of sorted runs (read amplification) while keeping write amplification low; tunable to cap space amplification. Good for write-heavy workloads that still need bounded read cost.
- **Tiered+Leveled / hybrid.** Many production systems use **tiered for the upper (small, hot) levels** and **leveled for the bottom (large) level** — cheap writes where data churns fast, bounded space where most bytes live. RocksDB's leveled compaction is itself a hybrid (L0 is tiered-ish; L1+ is leveled).

The pattern across all of these: **choose the compaction strategy to match how the workload creates garbage.** Update-heavy → leveled (reclaim superseded versions promptly). Append-only with TTL → time-window (drop whole windows). Write-saturated, space-cheap → size-tiered/universal. Cache → FIFO. There is no universally best strategy — which is precisely the RUM conjecture (§67.17) made operational.

---

## 67.16 Read, Write, and Space Amplification Defined

The three amplification factors are the currency in which every LSM (and B-tree) trade-off is denominated. Define each precisely:

- **Read amplification (RA)** = bytes (or I/Os) read from storage per logical read. For an LSM point lookup: number of SSTables/levels consulted (after Bloom filtering). For a B-tree: tree height in page reads. LSM RA is *higher* and grows with the number of runs.
- **Write amplification (WA)** = bytes written to storage per byte of logical data ingested. For an LSM: 1 (WAL) + 1 (flush) + rewrites during compaction; leveled ≈ 10–30×, size-tiered lower. For a B-tree: dirty page(s) per row times WAL, often also large due to full-page writes. This is the metric flash cares about (wear).
- **Space amplification (SA)** = bytes on storage per byte of live logical data. Extra copies (obsolete versions, un-collected tombstones, un-merged runs). Leveled ≈ 1.1×; size-tiered up to ~2×+.

```
                 Read amp     Write amp    Space amp
 Leveled          low          HIGH         low  (~1.1×)
 Size-tiered      HIGH         low          HIGH (~2×)
 B-tree           low          med–high     med  (fragmentation, ~1.3–2×)
```

The measured numbers matter in interviews:

| Structure / strategy | Read amp | Write amp | Space amp |
|---|---|---|---|
| B-tree (in-place) | ~O(height), low | ~O(node writes) + FPW | fragmentation, half-full pages |
| LSM leveled (T=10) | low (≤1/level + L0) | high (~10–30×) | low (~1.11×) |
| LSM size-tiered | high (many runs) | low (~log_f N) | high (~2×) |

Two amplifications trade against the third: **you can pick low read+space (leveled) OR low write (size-tiered), not all three.** That is not an engineering limitation to be fixed — it is a theorem, next section.

---

## 67.17 The RUM Conjecture

The **RUM conjecture** (Athanassoulis et al., 2016) formalizes why no storage structure is universally optimal. RUM = **Read overhead, Update overhead, Memory (space) overhead.** The conjecture:

> **Any access method can optimize for at most two of {Read, Update, Memory}; improving all three simultaneously is not achievable.** Minimizing two of the overheads forces the third up.

Mapping the structures onto the three corners:

```
              READ-optimized
                   /\
                  /  \
     B-tree ────►/    \◄──── heavily compressed /
   (low read,   /      \      column store (low space,
    low-ish     /        \     high read+update cost)
    space)     /__________\
        UPDATE-opt      MEMORY-opt
        LSM size-tiered   (tight packing,
        (low write,        succinct structures)
         high read+space)
```

- **Read-optimized** (minimize RA): B-trees, dense indexes, materialized views. Pay in update cost (maintain the structure) and/or space (redundant indexes).
- **Update-optimized** (minimize WA): **LSM trees** — buffer + append means writes are cheap, but reads must merge many runs (RA) and obsolete copies linger (SA). Size-tiered is the extreme write-optimized corner.
- **Memory-optimized** (minimize SA): heavy compression, succinct/compact structures, no redundant indexes. Pay in read (decompression) and update (recompression) cost.

Why it matters for LSM specifically: the **compaction strategy is a dial along the R–U edge.** Leveled compaction moves toward the Read/Memory corner (low RA, low SA) by spending Update budget (high WA). Size-tiered moves toward the Update corner (low WA) by spending Read and Memory (high RA, high SA). You are choosing which two overheads to minimize; the conjecture says the third must give.

The practical toolkit — knobs that move you along the RUM triangle without changing the fundamentals:

- **Bloom filters** (§67.9): spend a little Memory to buy back Read amplification (reduce false SSTable probes). A rare all-three win at the *margin*, but bounded by the RAM you can afford.
- **Key-value separation / WiscKey** (§67.22): reduce Write amplification (Update) by not rewriting values during compaction, paying in extra reads (Read) for scans and extra space (garbage in the value log).
- **Size ratio T** (§67.6): larger T → fewer levels → lower RA but higher per-level WA; smaller T → the reverse.

RUM is the reason this chapter has three compaction strategies instead of one "best" one, and the reason B-trees and LSM trees coexist rather than one replacing the other (§67.18). It is the theoretical statement of the three-axes framing from §61.15.

---

## 67.18 LSM Trees vs B-Trees

The headline rivalry of Part I (§61.15), now that both sides are developed. Both keep keys **ordered**; they differ on **buffering** and **mutability**, and every performance difference follows.

| Dimension | B-tree (Ch. 62–64) | LSM tree |
|---|---|---|
| Buffering | No (writes go to pages) | Yes (memtable) |
| Mutability | In-place (overwrite pages) | Append-only (immutable SSTables) |
| Write pattern | Random page writes | Sequential (WAL + flush) |
| Write amplification | Moderate–high (dirty pages + full-page writes) | High under compaction, but sequential |
| Read (point) | ~O(height) reads, ≤1 place | Multiple runs; Bloom-filtered |
| Read (range) | Excellent (ordered leaves, in-place) | Good, but merges k runs |
| Space | Fragmentation, ~half-full pages | Obsolete copies until compaction |
| Concurrency | Latch coupling / crabbing on pages | Lock-free reads (immutable files) |
| Best workload | Read-heavy, mixed r/w, low latency reads | Write-heavy ingest, flash, scans |
| Reference | Postgres, InnoDB, WiredTiger (default) | RocksDB, LevelDB, Cassandra, HBase |

The core intuition:

- **Writes.** A B-tree does an **in-place random write** per modification (plus WAL); an LSM does a **sequential append** and defers the reorganization to batched compaction. On write-saturated flash, the LSM's sequential pattern and lower per-write cost win — but its *total* bytes written (write amplification via compaction) can actually exceed a B-tree's. The distinction: LSM writes are **sequential and batched** even when voluminous, which flash and disks both prefer.
- **Reads.** A B-tree reads **one path to one leaf** — the key lives in exactly one place. An LSM must potentially check **many runs** because a key's newest version could be in the memtable or any level. Bloom filters and compaction narrow this, but reads are structurally the LSM's weaker side.
- **Space.** A B-tree wastes space on **partially-full pages and fragmentation**; an LSM wastes space on **obsolete versions and tombstones** awaiting compaction. Leveled LSM actually has *lower* steady-state space amplification (~1.1×) than a fragmented B-tree.
- **Concurrency.** LSM **reads never block** because SSTables are immutable — no page latches, no reader-writer coordination on disk structures (§67.23). B-trees need careful latch coupling / crabbing (Ch. 64) to let readers and writers share pages.

When to choose which (the interview answer): **write-heavy, ingest-dominated, or flash-bound → LSM** (RocksDB/Cassandra); **read-heavy, latency-sensitive point reads, or read-modify-write transactional → B-tree** (Postgres/InnoDB). Many systems offer both: MySQL with InnoDB (B-tree) or MyRocks (LSM); MongoDB with WiredTiger's B-tree or LSM options. The choice is a RUM-conjecture decision (§67.17), not a matter of one being obsolete.

---

## 67.19 Block Cache, Compression, and Disk Access

Between the abstract structure and the block device sit two implementation layers that dominate real LSM performance: the **block cache** and **block compression**.

**Block cache.** Because SSTable data is on disk and immutable, the engine keeps recently used **uncompressed data blocks and index/filter blocks** in an in-memory **block cache** (RocksDB `LRUCache` / `ClockCache`, default LRU). Distinctions from a B-tree's buffer pool:

- The block cache caches **immutable blocks**, so it never has dirty pages to write back — eviction is free (just drop the block). A B-tree buffer pool must write dirty pages before evicting (Ch. 65).
- It typically caches **uncompressed** blocks (after decompression), so cache hits skip both I/O *and* decompression. RocksDB can optionally also keep a **compressed block cache** to hold more blocks per byte of RAM.
- **Index and filter blocks** compete with data blocks for cache space; `cache_index_and_filter_blocks` controls whether they are pinned or evictable. Evicting the filter block re-introduces false-probe I/O, so hot SSTables usually pin their filters.
- The OS **page cache** (Ch. 32) also caches file bytes underneath, so LSM engines that use buffered I/O get a second cache layer; engines using `O_DIRECT` bypass it to avoid double-caching.

**Block compression.** SSTable data blocks are compressed on write and decompressed on read. Because a block holds many similar sorted keys, compression ratios are good. The choice is a speed/ratio trade:

| Codec | Ratio | Speed | Typical use |
|---|---|---|---|
| **Snappy** | modest (~2×) | very fast | LevelDB/RocksDB default; hot data |
| **LZ4** | ~2× | fastest decompress | latency-sensitive levels |
| **Zstd** | high (~3–4×) | fast, tunable levels | bottommost level, cold data |
| **Zlib/gzip** | high | slow | rarely, archival |

The standard production pattern (RocksDB `bottommost_compression`): use **fast, light compression (LZ4/Snappy) on upper levels** where data is hot and churns, and **stronger compression (Zstd) on the bottommost level** where most bytes live and are read rarely — buying space where it is cheap to and speed where it is needed. **Zstd dictionaries** trained per-SSTable improve the ratio on small blocks. Compression multiplies effective I/O bandwidth and cuts SA, at CPU cost on the read path (mitigated by the uncompressed block cache).

The interaction that matters: **compression and the block cache together determine effective read cost.** A read is: check Bloom filter (RAM) → maybe read a block (disk I/O, unless in page cache) → decompress (CPU, unless in the uncompressed block cache) → binary-search within block. Tuning is about keeping hot filters/indexes/blocks resident and pushing heavy compression to cold data.

---

## 67.20 Unordered LSM Storage: Bitcask

Not every log-structured store keeps data ordered on disk. **Bitcask** (the default storage engine of Riak) is the archetype of an **unordered, hash-indexed, append-only log** — the corner of the three axes that is *buffered-ish, immutable/append, but* ***unordered*** *(§61.15)*.

Structure:

```
DISK: append-only data files (logs), newest at the tail
  [k=a,v=..][k=z,v=..][k=a,v=NEW][k=m,v=..]  ← writes just append here
                        ▲
RAM: keydir — a hash map from EVERY key to its latest location
  { a → (file 7, offset 512, size 40),
    z → (file 7, offset 96,  size 12),
    m → (file 7, offset 640, size 30), ... }   ← ALL keys must fit in RAM
```

- **Writes** append the record to the current log file (sequential) and update the in-memory **keydir** hash map to point at the new offset. An update or delete is just a new append; the keydir now points at the newest copy (a delete writes a tombstone and removes the keydir entry).
- **Reads** are **one hash lookup + one disk read**: the keydir gives the exact file/offset, so a `get` is a single seek and read — **O(1), exactly one I/O**, no merge, no Bloom filter, no level traversal. This is Bitcask's headline advantage: predictable, single-seek reads.
- **Compaction ("merge")** rewrites live records from old log files into new ones and drops superseded/tombstoned entries, then discards the old files — the same reclaim idea, over an unordered log.

The defining trade-offs:

- **All keys must fit in RAM.** The keydir holds *every* key (not values). This caps the number of keys by memory and is Bitcask's fundamental limitation — it is unsuitable for datasets with more keys than fit in the keydir.
- **No range scans, no ordered iteration.** Because data is unordered and the index is a hash map, there is **no efficient range query** — you cannot scan keys in order without sorting the whole keydir. This is the price of dropping the *ordering* axis.
- **Extremely simple and crash-friendly.** Recovery rebuilds the keydir by scanning the logs (or a saved **hint file** that stores key→offset without values, for fast startup). Fixed, predictable read latency and high write throughput.

Bitcask is the clean illustration that "log-structured" and "sorted" are **independent choices**: an LSM tree keeps its logs sorted (SSTables) to enable range scans and disk-resident indexes at the cost of merge-on-read; Bitcask keeps its log unordered and indexes it entirely in RAM to get single-seek reads, sacrificing range queries and bounding capacity by memory.

---

## 67.21 WiscKey: Key-Value Separation

The dominant cost of a leveled LSM is **write amplification from compaction** (§67.13): every compaction rewrites *both keys and values*, even though only the keys need to stay sorted. If values are large, this is enormous waste — a 1 KB value rewritten 15× on its way down the levels costs 15 KB of write amplification for one logical write. **WiscKey** (Lu et al., 2016; the design behind Badger and RocksDB's `BlobDB`) attacks exactly this by **separating keys from values**.

```
LSM tree (small):                    Value log (vLog, append-only):
  key → (vLog file, offset, size)      [v1][v2][v3][v4]...  ← values live here
  keys are compacted normally,         values are NOT rewritten by LSM compaction;
  but each entry's "value" is just     they are appended once and GC'd separately.
  a small pointer into the vLog.
```

The mechanism:

- **Values go to a separate append-only value log (vLog).** The LSM tree stores only `key → (value pointer)`. Since values are usually much larger than keys, the LSM tree becomes **much smaller**.
- **Compaction now rewrites only keys + pointers**, not values. Write amplification during compaction drops proportionally to value size — for large values, the reduction is dramatic (the paper reports up to ~10× lower WA and correspondingly higher throughput).
- A **smaller LSM tree** also means fewer levels, smaller Bloom filters, and better cache residency for the key structure.

The costs (RUM again — WA bought with RA and SA):

- **Extra indirection on reads.** A point read now does the LSM lookup to get the pointer, then a **second read** into the vLog for the value. Bloom filters and a small LSM keep the first hop cheap, but there is an added dereference.
- **Range scans lose locality.** In a normal LSM, a range scan reads values contiguously from SSTable blocks; with key-value separation, the values are scattered across the vLog, so a scan does **random reads into the vLog** (one per key). WiscKey mitigates with prefetching and parallel reads exploiting SSD internal parallelism (§67.24), but scans of large ranges are its weak spot.
- **Garbage collection of the vLog.** The vLog accumulates dead values (superseded/deleted). A separate GC must reclaim them: walk the vLog tail, check whether each value is still the current one (via the LSM), and re-append live values / advance the head. This is extra machinery and its own space amplification in the vLog.

WiscKey's sweet spot is **large values on fast SSDs** (where random vLog reads are cheap due to internal parallelism) with **write-heavy or update-heavy** workloads. RocksDB exposes it as **BlobDB** (values above a size threshold spill to blob files); it is off the default path because for small values the indirection cost outweighs the (small) WA saving. It is the cleanest example of trading write amplification for read amplification along the RUM edge.

---

## 67.22 Concurrency in LSM Trees

Immutability makes LSM concurrency dramatically simpler than B-tree concurrency (Ch. 64's latch coupling / crabbing). The governing fact: **on-disk SSTables never change, so reads over them need no locks at all.**

- **Lock-free reads of SSTables.** A reader can scan any SSTable without coordination, because its bytes are guaranteed stable for the file's whole lifetime. Compaction never mutates an SSTable in place; it writes *new* SSTables and then atomically retires the inputs. So a reader mid-scan on an old SSTable is unaffected — the file is not deleted until no reader references it (reference counting).
- **The memtable is the only mutable structure**, and it is the only place needing write coordination. A **skip list** memtable supports a single writer with many concurrent readers, or (RocksDB's concurrent skip list) multiple concurrent writers via atomic pointer splices. Readers see a consistent view because insertions only add nodes.
- **Memtable switch is the coordination point.** When the active memtable fills, the engine atomically swaps in a fresh memtable and marks the old one immutable. This swap (and the WAL rotation with it) is the main synchronization event; readers and writers briefly coordinate on which memtable is current, typically via an atomic pointer / RCU-style version.
- **Snapshots via sequence numbers.** Because every write has a sequence number (§67.11) and old versions are retained until compaction, an LSM provides **consistent snapshots** cheaply: a snapshot is just a sequence number, and a read at that snapshot ignores any entry with a higher sequence number. Compaction must not drop a version still visible to the **oldest live snapshot**. This is the LSM analog of MVCC (§61.7), and it is why LSM engines support MVCC-style isolation naturally.
- **Compaction concurrency.** Multiple compactions run in parallel on disjoint key ranges/levels (RocksDB `max_background_compactions`). They coordinate through the engine's **version set / manifest** — an atomically-updated record of which SSTables constitute the current tree. Installing a compaction's output is a single atomic manifest edit: add the new files, remove the inputs.

The net effect: **the read path is essentially lock-free**, the write path coordinates only on the memtable and the manifest, and background compaction is isolated by immutability. This is a structural advantage over in-place B-trees, where every reader and writer contends on shared, mutable pages. It is one of the reasons write-heavy, high-concurrency systems (Cassandra, ScyllaDB) are built on LSM — ScyllaDB in particular pairs LSM immutability with a shard-per-core, shared-nothing thread model to eliminate almost all cross-core locking.

---

## 67.23 Log Stacking: LSM on Flash and the FTL

An LSM tree is log-structured, but it does not run on bare flash — it runs on top of layers that are **themselves log-structured**, and stacking logs on logs multiplies write amplification. This is the "**log stacking**" problem, and it is a favorite senior-level interview topic because it exposes that "sequential writes" is a leaky abstraction.

The stack, top to bottom:

```
  LSM tree            log-structured: WAL + SSTable flushes + compaction
        │  (thinks it writes sequentially)
        ▼
  Filesystem          journaling FS (ext4/xfs) is log-structured for metadata;
        │             file allocation adds its own remapping
        ▼
  SSD FTL             log-structured: the Flash Translation Layer maps logical
        │             block addresses to physical flash pages, writing new pages
        ▼             and garbage-collecting erase blocks — a hidden LSM-like log
  NAND flash          erase-before-write; program/erase at block granularity
```

The key mechanism is the **Flash Translation Layer (FTL)**. NAND flash cannot overwrite a page in place: a page must belong to an **erase block** that is erased (slow, ~ms, coarse) before any of its pages can be rewritten. To hide this, the SSD's FTL maintains a **logical-to-physical mapping** and writes every update to a **new** physical page, marking the old one stale — i.e. the FTL is **internally a log-structured store with its own garbage collection and its own write amplification.**

The consequence — **log-on-log write amplification:**

- The LSM writes "sequentially" at the logical level, but its compaction rewrites data repeatedly (WA ~10–30×).
- Underneath, the **FTL** does its *own* garbage collection and remapping, adding its own WA (device WA of 1.5–4× is typical, higher when the drive is full or the write pattern fragments erase blocks).
- The **filesystem journal** adds another log for metadata (and, with data journaling, for data).
- These multiply: total flash writes = LSM WA × FS overhead × FTL WA. Two independent log-structured layers, each doing garbage collection, each unaware of the other, **wear the flash faster and waste bandwidth** — and worse, the FTL's GC and the LSM's compaction can fight, since the FTL cannot tell obsolete-by-compaction data from live data until the filesystem issues **TRIM/discard**.

Related stacking cases the book raises:

- **LLAMA** — the log-structured, latch-free storage layer *underneath* the **Bw-tree** (Ch. 66). Even a "B-tree" here is implemented on a log-structured cache/storage substrate, so a Bw-tree on an SSD is *also* log-on-log. LLAMA does page **delta** updates and its own log-structured cleaning.
- **Filesystem logging.** Journaling filesystems (ext4, xfs) and log-structured filesystems (F2FS, designed *for* flash) add a layer whose behavior interacts with both the LSM above and the FTL below.

The point: **an LSM's sequential-write advantage is partly consumed by the redundant log-structured layers beneath it.** Recognizing the stack is prerequisite to reducing it — the subject of the final section.

---

## 67.24 Mindful Stacking: Removing Redundant Translation Layers

If the LSM, the filesystem, and the FTL are all log-structured and all doing garbage collection independently, the fix is **mindful stacking**: make the layers cooperate, or remove the redundant ones so there is **one** log-structured manager, not three fighting each other.

The techniques, from least to most invasive:

- **TRIM / discard.** The filesystem tells the SSD which logical blocks are now free (e.g. after an LSM deletes a compacted SSTable). Without TRIM, the FTL believes stale data is still live and copies it during GC, inflating device WA. TRIM lets the FTL reclaim erase blocks the upper layers have abandoned — the minimum coordination between LSM/FS and FTL.
- **Aligning LSM I/O to flash geometry.** Sizing SSTables and write buffers to the SSD's erase-block / page size so that when an SSTable is deleted, whole erase blocks become free at once, minimizing FTL copy-on-GC. Large sequential compaction outputs already help here versus small scattered writes.
- **Open-Channel SSDs.** Expose the flash's physical geometry (channels, dies, erase blocks) to the host and **remove the FTL**, letting the host software (the database) do the logical-to-physical mapping and garbage collection *once*. The LSM's compaction and the flash's block management become the same operation — no log-on-log. LightNVM was the Linux subsystem for this.
- **ZNS (Zoned Namespaces).** The modern, standardized successor (NVMe ZNS). The drive exposes **zones** that must be written **sequentially** and **reset (erased) as a unit** — surfacing the erase-block constraint to the host instead of hiding it behind an FTL. An LSM maps beautifully onto zones: **write one SSTable per zone (sequential), and reset the whole zone when that SSTable is compacted away.** This **eliminates the FTL's garbage collection** (the host's compaction *is* the GC), collapsing device WA toward ~1×, cutting over-provisioning, and removing the FTL's DRAM. RocksDB has a **ZenFS** backend built for ZNS; ScyllaDB and Western Digital demonstrated large WA and throughput wins.
- **Application-managed flash generally.** The theme of "mindful stacking": there should be **one** entity responsible for the log-structured mapping and cleaning, and it should be the one with the most semantic knowledge — the database, which knows what compaction made obsolete. Duplicating that responsibility in a hidden FTL wastes writes.

The unifying idea closing the chapter: log-structured storage is powerful precisely because sequential, append-only, immutable writes suit both disks and flash — but that power is squandered when **multiple layers each independently reinvent the log and its garbage collection.** The frontier (ZNS, open-channel, LLAMA-aware stacks) is about **collapsing the redundant logs into one**, so the LSM's compaction and the device's block reclamation are a single, coordinated act rather than two adversaries. That is the same indirection-and-translation motif from §61.14, seen one layer lower: a translation layer is invaluable, but you want exactly one of them.

---

## Summary

- The LSM tree is the **buffered + immutable + ordered** corner of §61.15's three axes — the append-only counterpart to the in-place B-tree. Its whole reason for existence is to **turn random writes into sequential writes**, which wins on write-heavy workloads and on flash.
- Structure: a mutable in-memory **memtable** (usually a **skip list**, Ch. 21 §21.13) absorbs writes; when full it flushes to an immutable, sorted on-disk **SSTable**. Levels of geometrically increasing size (ratio T≈10) organize the SSTables.
- Write path: append to the **WAL** (durability) → insert into the **memtable** (queryability) → ack. No random disk write. Crash recovery replays the WAL into a fresh memtable.
- **Updates and deletes are writes:** an update inserts a new version (newest wins); a **delete inserts a tombstone**. Tombstones cost space and I/O, must outlive every older copy (else data **resurrects**), and make range-deleted scans expensive.
- Reads check memtable → immutable memtables → SSTables newest-to-oldest, giving **read amplification**; **Bloom filters** (Ch. 21 §21.19; ~10 bits/key ≈ 1% FPR) skip SSTables that cannot contain a key. Range scans do a **k-way merge** (min-heap of iterators, O(N log k)) with **newest-wins reconciliation**.
- **Compaction** merges runs, drops obsolete data, and maintains levels, trading **write amplification** for lower read and space amplification. **Leveled** (non-overlapping levels, low RA/SA, high WA) vs **size-tiered** (same-size tiers, low WA, high RA/SA) vs **time-window** (drop whole expired windows) are three points on that curve.
- The **RUM conjecture**: you can minimize at most two of **Read, Update, Memory** overhead; the compaction strategy is your dial along that triangle. This, not accident, is why B-trees and LSM trees coexist.
- SSTables (data blocks + index block + Bloom filter + footer) plus a **block cache** and **block compression** (Snappy/LZ4 hot, Zstd cold) determine real read cost. **Immutable SSTables make reads lock-free**; only the memtable switch and manifest edit need coordination.
- Variants: **Bitcask** (unordered — hash index over an append log, all keys in RAM, no range scans, single-seek reads); **WiscKey** (key-value separation — values in a vLog cut compaction WA at the cost of scan locality and vLog GC).
- **Log stacking:** the LSM sits on a journaling filesystem sitting on an SSD **FTL** that is *itself* log-structured — **log-on-log write amplification**. **Mindful stacking** (TRIM, open-channel SSDs, **ZNS** with per-zone SSTables) collapses the redundant logs so compaction and device GC become one act.

---

## Key Interview Questions

1. **Why do LSM trees exist — what problem do they solve?** — They convert the random, in-place writes of an ordered structure (like a B-tree) into large sequential appends by buffering writes in a memory memtable and flushing immutable sorted files. This wins on write-heavy workloads and on flash, where sequential writes are far cheaper and align with erase-before-write NAND behavior.
2. **Where does an LSM tree sit on the three axes of §61.15?** — Buffered (memtable), immutable (append-only SSTables), and ordered (sorted files/levels). It shares "ordered" with the B-tree but flips "buffered" and "in-place," which is the source of every performance difference between them.
3. **Is PostgreSQL an LSM engine?** — No. Its heap is updated in place (new tuple versions written into heap pages), so it is the in-place baseline. Its WAL is log-structured but is a recovery log, not the primary queryable store — you never read rows from the WAL in normal operation. MyRocks and OrioleDB are the Postgres-adjacent LSM/alternative-engine points.
4. **Describe the LSM write path.** — Append the record to the WAL and (per durability policy) fsync it, then insert it into the sorted in-memory memtable, then acknowledge. No SSTable is touched and no random disk write occurs; the memtable later flushes to an L0 SSTable as one sequential write.
5. **What is a memtable and why usually a skip list?** — The mutable, sorted, in-memory buffer that absorbs writes and is checked first on reads. A skip list keeps keys sorted with O(log n) ops, needs no rotations, and supports concurrent single-writer/multi-reader (or concurrent-writer) access via atomic pointer splices — ideal for a structure that is constantly mutated and iterated.
6. **What is an SSTable and what does it contain?** — A Sorted String Table: an immutable file of key-value pairs sorted by key, plus a sparse index block (one entry per data block), a Bloom filter block, and a footer with offsets/magic. Immutability and sorting make it lock-free to read, cheap to merge, and buildable once at flush time.
7. **How are updates and deletes handled if files are immutable?** — An update inserts a new version of the key (newest wins on read); a delete inserts a tombstone marker. Both are writes that *add* records; the obsolete copies persist until compaction reconciles and discards them.
8. **What is a tombstone and why is it dangerous?** — A marker recording that a key is deleted; it shadows older values on read. It costs space and I/O rather than freeing it, must outlive every older copy (or the deleted value resurrects), and makes scans over heavily-deleted ranges expensive because the reader traverses all the tombstones. In Cassandra it must survive `gc_grace_seconds` to propagate to replicas.
9. **Walk through an LSM point lookup.** — Check the active memtable, then immutable memtables, then SSTables newest-to-oldest: all L0 files (they overlap) and one file per lower level (non-overlapping), consulting each SSTable's Bloom filter first to skip it if the key is absent. Return the first (newest) version found; a tombstone means "not found."
10. **What is read amplification and why is it the LSM's weakness?** — The number of places (files/levels) a single logical read may consult, because a key's newest version could be in the memtable or any level. Without Bloom filters a lookup could read a block from every SSTable; the structure trades cheap writes for this multi-run read cost.
11. **How do Bloom filters help, and what are the numbers?** — Each SSTable has a Bloom filter over its keys; a lookup consults it before reading any block and skips the file if it says "absent" (no false negatives). At ~10 bits/key with ~7 hash functions the false-positive rate is ~1%, so ~99% of unnecessary SSTable probes are eliminated for ~1.25 bytes of RAM per key. Filters don't help arbitrary range scans.
12. **How does a range scan work over an LSM tree?** — It opens an iterator on every component whose key range overlaps the query (memtable, immutable memtables, overlapping SSTables) and does a k-way merge — typically a min-heap of iterators, O(N log k) — applying newest-wins reconciliation and honoring tombstones. Bloom filters cannot prune it since they only answer point membership.
13. **How is a conflict between multiple versions of a key resolved?** — Newest wins. RocksDB tags each write with a monotonic sequence number and sorts equal user keys by descending sequence, so the newest is seen first; Cassandra uses timestamps (last-write-wins, vulnerable to clock skew). A tombstone as the newest version means the key is absent.
14. **What is compaction and what does it trade?** — The background merging of SSTables that discards obsolete versions and eligible tombstones and maintains the level structure. It reduces read and space amplification by spending write amplification (rewriting data) and I/O/CPU — the central LSM trade-off, and the cause of write stalls if it can't keep up with ingest.
15. **Leveled vs size-tiered compaction?** — Leveled keeps non-overlapping SSTables per level (≤1 file/level on reads), giving low read and space amplification (~1.1×) but high write amplification (~10–30×). Size-tiered merges same-size runs in tiers, giving low write amplification but high read and space amplification (~2×). Leveled suits read/update/space-sensitive workloads; size-tiered suits write-saturated ingest.
16. **What is time-window compaction and when is it used?** — For write-once, TTL-expiring time-series data: SSTables are bucketed by time window and windows are never merged together, so an entire expired window is dropped whole once its rows' TTLs pass — avoiding tombstone scanning and avoiding rewriting live data to expire old data.
17. **Define read, write, and space amplification.** — Read amp = bytes/IOs read per logical read; write amp = bytes written to storage per byte ingested; space amp = bytes stored per byte of live data. LSM leveled: low read/space, high write. Size-tiered: low write, high read/space. They are the currency of every storage trade-off.
18. **State the RUM conjecture and its relevance to LSM tuning.** — You can optimize at most two of Read, Update, and Memory (space) overhead; improving all three at once is not achievable. The compaction strategy is the dial: leveled favors Read+Memory by spending Update; size-tiered favors Update by spending Read+Memory. It explains why one structure/strategy can't be universally best.
19. **Compare LSM trees and B-trees.** — Both are ordered. B-trees are unbuffered and in-place: random writes, one place per key on reads, careful page latching. LSM trees are buffered and append-only: sequential batched writes, multi-run Bloom-filtered reads, lock-free reads over immutable files. Write-heavy/flash → LSM; read-heavy/latency-sensitive → B-tree.
20. **Why are LSM reads lock-free while B-tree reads need latches?** — SSTables are immutable, so their bytes never change during a read — no coordination needed, and compaction retires files only when no reader references them. Only the mutable memtable and the manifest edit require synchronization. B-tree pages are mutated in place, so readers and writers must coordinate via latch coupling.
21. **How does an LSM provide consistent snapshots / MVCC?** — Every write carries a sequence number and old versions are retained until compaction, so a snapshot is just a sequence number and a read ignores entries with higher sequence numbers. Compaction must not drop a version still visible to the oldest live snapshot — the LSM analog of Postgres MVCC and VACUUM.
22. **What is Bitcask and what are its limits?** — An unordered, append-only log with an in-memory hash index (keydir) mapping every key to its file+offset. Reads are a single hash lookup plus one disk seek (O(1), one I/O). Limits: all keys must fit in RAM, and there are no range scans or ordered iteration because the log is unordered and indexed by hash.
23. **What is WiscKey / key-value separation and what does it buy?** — Store only key→pointer in the LSM tree and put values in a separate append-only value log (vLog). Compaction then rewrites only keys/pointers, slashing write amplification for large values. Costs: an extra read hop per lookup, scattered (random) vLog reads that hurt range scans, and separate vLog garbage collection. RocksDB exposes it as BlobDB.
24. **What are the block cache and block compression, and how do they interact?** — The block cache holds recently used (usually uncompressed) data/index/filter blocks; since blocks are immutable, eviction is free (no write-back). Blocks are compressed (Snappy/LZ4 for hot upper levels, Zstd for the cold bottom level). A read is: Bloom filter (RAM) → maybe read block (I/O) → decompress (CPU, skipped on uncompressed-cache hit) → search block.
25. **What is log stacking / log-on-log write amplification?** — An LSM is log-structured, but it runs on a journaling filesystem on an SSD whose FTL is itself log-structured (remaps every write to a new flash page and garbage-collects erase blocks). Each layer independently does GC and adds write amplification, so total flash writes multiply and the FTL's GC can fight the LSM's compaction.
26. **Why can't NAND flash be overwritten in place, and what does the FTL do?** — A flash page can only be programmed after its containing erase block is erased (slow, coarse-grained). The Flash Translation Layer hides this by keeping a logical-to-physical map, writing updates to fresh pages, marking old ones stale, and garbage-collecting erase blocks — effectively a hidden log-structured store with its own write amplification.
27. **What is mindful stacking, and how do ZNS / open-channel SSDs help?** — The principle that only one layer should manage the log-structured mapping and garbage collection — the one with the most semantic knowledge (the database). Open-channel SSDs and NVMe ZNS expose flash geometry/zones so the host writes SSTables sequentially into zones and resets a whole zone on compaction, making compaction *be* the device GC — eliminating the FTL's redundant GC and driving device write amplification toward 1×.
28. **When would you choose an LSM engine over a B-tree engine?** — For write-heavy or ingest-dominated workloads, time-series/logs/metrics, flash-bound deployments where sequential writes and lower write cost matter, and workloads tolerant of higher read amplification. Choose a B-tree for read-heavy, low-latency point reads, and read-modify-write transactional workloads. It's a RUM-conjecture decision, not obsolescence.
29. **Why is L0 special in a leveled LSM?** — L0 SSTables come directly from independent memtable flushes, so they can have overlapping key ranges and a read must check every L0 file. L1 and below are kept non-overlapping by compaction, so a lookup consults at most one SSTable per level there. L0→L1 compaction therefore merges all overlapping L0 files with the overlapping L1 range.
30. **What causes write stalls in an LSM engine?** — When flushes or compaction can't keep pace with ingest, immutable memtables pile up (past `max_write_buffer_number`) or L0 accumulates files (past the slowdown/stop triggers), so the engine throttles or blocks writes to let background work catch up — back-pressure that bounds memory and read amplification at the cost of write latency.

---

## Common Traps

- **Thinking a delete frees space in an LSM.** A delete writes a tombstone; the key's old value and the tombstone both persist until compaction, so a delete makes data *larger* first and only reclaims space later.
- **Dropping tombstones too early causes data resurrection.** A tombstone must outlive every older copy of the key (typically until compaction reaches the bottommost level, and in Cassandra past `gc_grace_seconds`); collect it early and a shadowed older value comes back.
- **Assuming Bloom filters speed up range scans.** They answer point membership only; a range scan cannot use them and must merge every overlapping run. Only prefix Bloom filters help specific prefix scans.
- **Believing LSM writes are cheap in total bytes.** Per-write cost is low and sequential, but compaction write amplification (leveled ~10–30×) can make total bytes written exceed a B-tree's — the win is that the writes are sequential and batched, not that they are fewer.
- **Confusing "log-structured" with "sorted."** Bitcask is log-structured but unordered (hash-indexed, no range scans); an LSM is log-structured and sorted. Ordering is an independent axis from immutability/buffering.
- **Calling PostgreSQL an LSM because it has a WAL.** The WAL is a recovery log; the primary store is the in-place heap. A log for durability is not a log-structured primary store.
- **Ignoring that reads must check many runs.** Read amplification is the LSM's structural weakness; a key can live in the memtable or any level, so point reads are multi-run and range scans are multi-way merges.
- **Assuming leveled compaction is always best.** It minimizes read/space amplification but pays high write amplification; for write-saturated ingest, size-tiered/universal (low write amp) is often the right choice — a RUM trade, not a bug.
- **Forgetting the RUM conjecture when asked for "the fastest" engine.** No structure minimizes read, update, and memory overhead together; the honest answer names which two the workload should optimize and why.
- **Overlooking log-on-log amplification on flash.** The SSD FTL is itself a log-structured GC'd store; stacking an LSM (and a journaling filesystem) on top multiplies write amplification and wears the flash faster unless TRIM/ZNS/open-channel collapse the redundant layers.
- **Assuming immutable SSTables mean no space overhead.** Immutability creates duplicate/obsolete versions and un-collected tombstones (space amplification) that only compaction reclaims; size-tiered can hold ~2× the live data.
- **Treating WiscKey / key-value separation as a free win.** It cuts compaction write amplification for large values but adds a read indirection, scatters values so range scans do random vLog reads, and requires separate vLog garbage collection.
- **Expecting fast range scans from Bitcask.** Its in-RAM hash index gives single-seek point reads but no ordered iteration; range queries require sorting the entire keydir, which is why range-scan workloads need a sorted LSM instead.
