# Chapter 61 — Introduction and Overview

*Interview-focused revision notes. The theme: a database is not one program but a stack of subsystems, and almost every design decision in the storage layer reduces to three axes — buffer or write through, mutate in place or append, keep data ordered or not. PostgreSQL is the reference implementation throughout, but the axes are universal; where Postgres sits at one end, we name who sits at the other.*

---

## 61.1 What a Database Management System Is

A **database management system** (DBMS) is application software that stores data durably and lets clients define, query, and modify it concurrently and safely. That one sentence hides an enormous amount of machinery: a wire protocol, a parser, an optimizer, an execution engine, a concurrency-control subsystem, a durability subsystem, and — the subject of Part I of this book — a **storage engine** that actually turns rows into bytes on a block device and back.

It is worth fixing terminology, because interviews probe it. A **database** is a logical collection of data. A **DBMS** is the software managing it. A **database instance** (or *node*) is a single running process (or process group) of that software. People say "database" for all three; be precise when it matters.

DBMSs are classified along several independent axes, and conflating them is a classic mistake:

| Axis | Ends | Postgres |
|---|---|---|
| Workload | OLTP (many small point read/writes) ↔ OLAP (few large scans/aggregations) ↔ HTAP (both) | OLTP-first, competent OLAP |
| Data model | relational ↔ document ↔ key-value ↔ wide-column ↔ graph | relational (with JSONB, arrays) |
| Storage medium | disk-based ↔ in-memory | disk-based (§61.4) |
| Layout | row-oriented ↔ column-oriented | row-oriented (§61.6) |
| Distribution | single-node ↔ distributed | single-node core (Part II covers distribution) |

These are orthogonal. A relational database can be in-memory (VoltDB), column-oriented (ClickHouse speaks SQL), or distributed (CockroachDB). The relational model says nothing about the storage engine, and this book is almost entirely about the storage engine — the part the SQL standard deliberately does not specify.

**OLTP vs OLAP** is the workload distinction that drives storage layout. **OLTP** (Online Transaction Processing) is many short-lived transactions, each touching a handful of rows by key — an order insert, a balance update. **OLAP** (Online Analytical Processing) is few long-running queries, each scanning millions of rows over a few columns — "sum revenue by region for last quarter." **HTAP** (Hybrid Transactional/Analytical Processing) tries to serve both from one system. As we will see, OLTP wants rows and B-trees; OLAP wants columns and immutable sorted files; the tension between them is the reason so many storage engines exist.

---

## 61.2 DBMS Architecture: The Layers

There is no universal DBMS architecture, but most systems can be decomposed into the same layers. Data flows down on the way in and up on the way out.

```
              ┌─────────────────────────────────────────┐
  client ───▶ │ Transport / wire protocol                │  connection, auth, session
              ├─────────────────────────────────────────┤
              │ Query processor                           │
              │   ├─ parser        → parse tree           │  syntax + catalog lookup
              │   ├─ analyzer/rewriter → query tree       │  semantics, views, rules
              │   └─ optimizer     → execution plan        │  cost-based plan selection
              ├─────────────────────────────────────────┤
              │ Execution engine                          │  runs the plan: scans, joins,
              │   (local ops, or remote for distributed) │  aggregates, sorts
              ├─────────────────────────────────────────┤
              │ Storage engine                            │ ◀── Part I of this book
              │   ├─ transaction manager                  │  isolation, locking
              │   ├─ lock manager                         │  row/table/predicate locks
              │   ├─ access methods (B-tree, LSM, heap)   │  on-disk structures
              │   ├─ buffer manager / page cache          │  RAM ↔ disk paging
              │   └─ recovery manager (WAL)               │  durability, crash recovery
              └─────────────────────────────────────────┘
                              │
                         block device
```

The **query processor** is the *compiler*; the **execution engine** and **storage engine** are the *runtime*. This book lives below the plan: given "fetch the row with id = 42," how does the storage engine find it, and given "insert this row," how does it write it durably without corrupting concurrent readers?

The critical interface is between the execution engine and the storage engine. A well-factored DBMS defines this as a narrow API — roughly *open cursor, seek, get next, insert, update, delete, commit* — so that storage engines can be swapped. **MySQL** made this explicit and pluggable: InnoDB, MyISAM, and RocksDB (MyRocks) are interchangeable storage engines under one query processor. **MongoDB** swapped MMAPv1 for **WiredTiger**. **PostgreSQL** historically had one tightly-integrated engine, but since version 12 exposes a **table access method** API (`pluggable table AM`), which is how projects like Zheap and OrioleDB experiment with alternative storage under the same planner.

---

## 61.3 The PostgreSQL Process Model

Because Postgres is our reference, pin down how a running instance is actually organized — it differs from the thread-per-connection model most engineers assume.

Postgres is **process-per-connection**, not thread-per-connection. A supervisor process, the **postmaster**, listens on the port. On each new connection it `fork`s (Ch. 31 §31.3) a dedicated **backend** process that runs that session's queries to completion. There is no thread pool; there is a *process* per client. This is why a naive Postgres deployment needs a connection pooler (PgBouncer) in front — each backend costs a process and its private memory, and thousands of idle connections are thousands of processes.

```
postmaster (listener, forks children, reaps them)
   ├─ backend #1  ─┐
   ├─ backend #2   │  each runs one session's SQL, attached to shared memory
   ├─ backend #N  ─┘
   ├─ background writer      (flushes dirty buffers ahead of checkpoints)
   ├─ checkpointer           (writes checkpoints, §61.4 / Ch. 65)
   ├─ WAL writer             (flushes the WAL buffers)
   ├─ autovacuum launcher    (spawns vacuum workers, §61.14 / Ch. 65)
   └─ background workers      (parallel query, logical replication, extensions)
                 │
        ┌────────┴─────────┐
        │  shared memory   │  shared_buffers (the buffer pool), WAL buffers,
        │  (System V / mmap)│  lock tables, proc array — all backends attach here
        └──────────────────┘
```

The consequences that matter for the storage engine:

- **`shared_buffers`** is the buffer pool (§61.15, Ch. 65), a fixed region of shared memory that every backend attaches to. A page read by one backend is visible to all. Default is small (128 MB); production tunes it to ~25% of RAM.
- Because backends are separate processes, all coordination — buffer pins, lock tables, the list of live transactions — lives in **shared memory** with explicit latches and lightweight locks (`LWLock`), the database analogue of the primitives in Ch. 24.
- A crashing backend can be isolated: the postmaster detects the death, and because shared memory could be corrupt, it forces a **crash-recovery restart** of the whole instance from the WAL rather than trusting the survivors.

MySQL/InnoDB, by contrast, is **thread-per-connection** inside one server process. The trade-off is the classic one from Ch. 31: processes give isolation and simpler memory safety at the cost of heavier context switches and no shared address space beyond the explicit shared-memory segment.

---

## 61.4 Memory- Versus Disk-Based DBMS

The single biggest storage-architecture decision is where the **primary copy** of the data lives: on durable secondary storage (disk-based) or in main memory (in-memory).

A **disk-based DBMS** — Postgres, MySQL, Oracle, SQLite — holds the authoritative data in files on a block device and uses RAM as a *cache* (the buffer pool). It is built around structures optimized for block devices: **B-trees** (Ch. 62–64) and **LSM trees** (Ch. 67), both of which minimize the number of block transfers because a block transfer is thousands of times slower than a memory access (Ch. 30's latency numbers are the whole justification).

An **in-memory DBMS** — Redis, VoltDB, MemSQL/SingleStore, SAP HANA, Memcached — holds the authoritative data in RAM. Disk, if used at all, is only for durability (a log and periodic snapshots), never for serving reads. Because it is freed from the block-transfer constraint, it can use pointer-rich structures that would be catastrophic on disk: plain binary trees, skip lists, and hash tables with real pointers rather than page offsets.

The reason the distinction is fundamental, not incidental:

- **Access-time asymmetry.** A DRAM access is ~100 ns; a random NVMe read is ~50–100 µs; a random seek on spinning rust is ~10 ms (Ch. 30). That is 3–5 orders of magnitude. On-disk structures exist to *convert random I/O into sequential I/O and to touch as few blocks as possible*, because the block, not the byte, is the unit of transfer.
- **Volatility.** RAM loses its contents on power failure. An in-memory DBMS is therefore *not automatically durable*; durability must be engineered on top (§61.5). A disk-based DBMS gets durability from the medium, but must engineer *performance* on top of a slow medium.
- **Addressing.** In memory you dereference a pointer. On disk you cannot store a pointer — the file will be mapped at a different address next time, and pointers are meaningless across restarts. On-disk structures address data by **page id + offset**, not by memory address. This single fact shapes all of file formats (Ch. 63) and B-tree implementation (Ch. 64).

**Cost and capacity** are the practical limiters: RAM is far more expensive per byte and bounded by what one machine can hold (single-terabyte territory), while disk is cheap and effectively unbounded. In-memory systems therefore either target datasets that fit in RAM or shard across many nodes (Part II).

The line is blurring. Postgres with a buffer pool larger than the working set behaves nearly like an in-memory system for reads. Anti-caching and tiered designs keep hot data in RAM and evict cold data to disk. But the *authoritative-copy* question still decides the structures the engine is built from.

---

## 61.5 Durability in Memory-Based Stores

If RAM is volatile, how does an in-memory DBMS survive a crash? The same two mechanisms every durable system uses, which recur throughout Part I:

1. **A write-ahead log (WAL).** Before acknowledging a write, append a record describing it to a sequential log on disk and `fsync` it. The log is append-only and sequential, so it is cheap even on slow media (sequential write ≫ random write). On restart, **replay** the log to reconstruct the in-memory state. This is exactly the mechanism a disk-based engine uses for crash recovery (Ch. 65) — the difference is only that the in-memory engine reconstructs *all* state from the log, not just the uncommitted tail.

2. **Periodic snapshots (checkpoints).** The log grows without bound, and replaying all of history is slow. Periodically, write a full **snapshot** of in-memory state to disk and truncate the log ahead of it. Recovery then = load the latest snapshot + replay the log suffix after it. Redis's **RDB** files are snapshots; its **AOF** (append-only file) is the WAL; production Redis often runs both.

The durability knob is *when the log is flushed*. `fsync` per write is fully durable but caps throughput at the device's sync rate (Ch. 34: a sync is tens to hundreds of microseconds). Batching many writes per `fsync` (**group commit**) trades a bounded window of potential loss for far higher throughput — the same trade every disk-based engine makes. Redis exposes this directly: `appendfsync always` (per write), `everysec` (batched, up to 1 s loss), or `no` (leave it to the OS page cache, Ch. 32).

The interview point: **durability and medium are independent.** An in-memory store *can* be fully durable (WAL + `fsync`), and a disk-based store *can* lose data (if it `fsync`s lazily or lies about it). "In-memory" describes where reads are served from, not whether writes survive a crash.

---

## 61.6 Row- Versus Column-Oriented Storage

Given a table, in what order do its bytes hit the page? Two answers, and the choice is the strongest predictor of whether a system is good at OLTP or OLAP.

```
Table:  id | name  | age | city
        1  | Alice | 30  | NYC
        2  | Bob   | 25  | LA
        3  | Cara  | 41  | SF

Row-oriented on disk (Postgres):     each row's fields stored contiguously
   [1,Alice,30,NYC] [2,Bob,25,LA] [3,Cara,41,SF]

Column-oriented on disk (ClickHouse): each column stored contiguously
   id:   [1,2,3]      name: [Alice,Bob,Cara]
   age:  [30,25,41]   city: [NYC,LA,SF]
```

A **row store** keeps all of a row's columns together. Fetching one whole row ("get the order with id 42") reads one place. This is what OLTP wants: point reads and writes of complete records. Postgres, MySQL, Oracle, and SQL Server are all row stores by default.

A **column store** keeps all values of one column together. Fetching one column across all rows ("average age") reads one contiguous run and skips the columns you did not ask for. This is what OLAP wants. ClickHouse, Vertica, Amazon Redshift, DuckDB, and Parquet-on-disk are column stores.

The deep reasons a column store wins at analytics — and each recurs later:

- **I/O proportional to columns touched, not rows.** A query over 3 of 50 columns reads ~6% of the data. A row store must read every row in full to get at those 3 fields.
- **Compression is dramatically better.** Adjacent values in a column are the same type and highly similar, so run-length encoding, dictionary encoding, delta encoding, and frame-of-reference all work far better than on the heterogeneous bytes of a row (Ch. 63). 10× column compression is routine; it also multiplies effective I/O bandwidth.
- **Vectorized execution.** A column is a dense array of one type, so the execution engine can process it in SIMD-friendly batches (Ch. 42) — one predicate applied to 1024 packed integers per loop, instead of one branchy row-at-a-time interpreter step.

And the reasons a column store is bad at OLTP:

- **Inserting or reading one row touches every column file.** A single-row insert becomes N separate appends; a single-row read gathers N scattered locations back into a tuple.
- **Point updates are expensive**, which is why most column stores are append-mostly / immutable (Ch. 67) and batch their writes.

---

## 61.7 Row-Oriented Data Layout: The Postgres Heap Tuple

Make the row store concrete with Postgres's on-disk format, because it recurs in Ch. 63–65 and is a favorite interview target.

A Postgres table is stored as a **heap**: a file (actually a set of 1 GB segment files) divided into fixed-size **pages**, 8 KB by default (`BLCKSZ`). A page holds rows in no particular order — "heap" here means *unordered pile*, not the priority-queue structure of Ch. 21. Each page is a **slotted page** (Ch. 63):

```
8 KB heap page
┌──────────────────────────────────────────────────────────┐
│ PageHeader (24 B): LSN, checksum, free-space pointers     │
├──────────────────────────────────────────────────────────┤
│ ItemId array (line pointers): (offset,length) per tuple → │
│   [lp1][lp2][lp3]...            grows downward             │
├───────────────────────────────────────┬──────────────────┤
│              free space                │                  │
├───────────────────────────────────────┴──────────────────┤
│ ...tuple3  tuple2  tuple1              grows upward        │
│ each tuple: HeapTupleHeader (23 B) + null bitmap + data   │
└──────────────────────────────────────────────────────────┘
```

Two facts about the tuple header carry the whole MVCC story (Ch. 65):

- **`xmin` / `xmax`** — the transaction ids that inserted and (if any) deleted this tuple version. Postgres never overwrites a row in place on update; it writes a **new tuple version** and marks the old one's `xmax`. Both versions coexist on disk; visibility rules pick the right one per transaction. This is **MVCC** (multi-version concurrency control), and it is why Postgres needs **VACUUM** (§61.14) to reclaim dead versions.
- **`t_ctid`** — a pointer to the *next* version of this row, `(block number, item offset)`. Normally it points to itself; after an update it points forward to the successor version, forming an update chain.

A tuple is addressed by its **TID** (tuple id, exposed as the system column `ctid`): the pair *(page number, line-pointer index)*. Note the **indirection**: an index does not point at a byte offset, it points at a **line pointer**, and the line pointer points at the tuple within the page. That extra hop lets the page be compacted (tuples slid around to reclaim space) without touching any index — only the line pointer moves. Hold onto that; it is the key to §61.14 and to HOT updates.

---

## 61.8 Column-Oriented Data Layout in Practice

A pure column store physically stores each column as its own sequence, typically split into **blocks / row-groups** of some number of rows (e.g. Parquet's default row-group is large, ~128 MB; ClickHouse uses granules of 8192 rows). Within a column block the engine applies type-specific encoding and compression, and stores per-block **min/max metadata** (a *zone map*) so that a query can skip entire blocks whose range cannot match a predicate (Ch. 63's sparse-index idea).

```
Parquet-style file
  Row group 0
    Column chunk: id    [pages: dictionary + RLE, min=1, max=8192]
    Column chunk: age   [pages: delta-encoded,    min=18, max=99]
    Column chunk: city  [pages: dictionary,       min=..., max=...]
  Row group 1
    ...
  Footer: schema + per-column-chunk metadata (offsets, encodings, stats)
```

To reconstruct row *i* — needed whenever the query does return whole rows — the engine reads position *i* from each column chunk and stitches them; this is the **tuple reconstruction** cost, and it is why late materialization (delaying reconstruction until after filters cut the row count) is a core column-store optimization.

**Where Postgres fits.** Core Postgres is a row store, full stop. Column orientation comes from outside the heap:

- **Extensions**: Citus's `columnar` access method (formerly `cstore_fdw`) stores tables in a compressed columnar format inside Postgres, using the pluggable table-AM hook from §61.2.
- **Foreign data / external engines**: query Parquet files via `parquet_fdw`, or pair Postgres with **DuckDB** (an embedded column-store OLAP engine) for analytics over the same data.
- **Hybrid systems**: Some HTAP designs keep a row store for writes and asynchronously materialize a column store for scans.

The takeaway for interviews: *Postgres is not a column store, and "just add an index" does not turn a row store into an analytics engine.* Column orientation is a physical-storage property, not an index you bolt on.

---

## 61.9 Distinctions, Hybrids, and Vectorized Execution

The row/column choice is not binary in modern systems, and the nuances distinguish a shallow answer from a deep one.

- **PAX (Partition Attributes Across).** Store row groups, but *within* each group lay columns out contiguously. You get columnar compression and scan behavior within a group, while keeping a whole row's data on one page for locality. Parquet and ORC are essentially PAX; Postgres's own heap is *not* PAX (it is pure row within a page).
- **Vectorized vs tuple-at-a-time execution** is a related but separate axis. Classic Postgres uses the **Volcano/iterator model**: each operator's `next()` returns one tuple, pulled up the plan tree — simple, but one virtual call per tuple per operator, murder on the branch predictor and instruction cache (Ch. 27). Column engines use **vectorized execution**: each `next()` returns a *batch* (a vector of, say, 1024 values), amortizing dispatch and enabling SIMD (Ch. 42). Some row stores (SQL Server batch mode, DuckDB) adopt vectorization independent of on-disk layout. **JIT-compiled execution** (Postgres uses LLVM JIT for expression evaluation on big queries) is a third answer to the same interpreter-overhead problem.
- **HTAP** systems try to be both. Approaches: dual storage (row store + async column replica, e.g. SingleStore, TiDB's TiFlash), or a single format that compromises (fractured mirrors, delta+base designs). The hard part is keeping the analytical copy fresh without slowing the transactional path — a recurring theme once we reach replication in Part II.

The mental model: **on-disk layout** (row / column / PAX) and **execution model** (tuple-at-a-time / vectorized / compiled) are independent knobs, and "column-oriented" loosely bundles both because they pay off together.

---

## 61.10 Wide-Column Stores Are Not Column Stores

A perennial source of confusion, and a favorite gotcha. **Wide-column stores** — Apache Cassandra, HBase, Google Bigtable, ScyllaDB — are *not* column-oriented in the §61.6 sense. The name refers to the **data model**, not the physical layout.

A wide-column store is a **map of maps**: a row key maps to a set of **column families**, and within a family a possibly-huge and *per-row-variable* set of columns maps to values. Different rows can have entirely different columns — the "wide" and "sparse" part — which a rigid relational row cannot do.

```
Bigtable/Cassandra logical model:
  row key ──▶ { column family A: { col1: v, col2: v, ... },
               column family B: { colX: v, ... } }
  another row key can have a completely different set of columns.
```

Physically, wide-column stores are usually **LSM-tree** engines (Ch. 67): writes append to sorted string tables, grouped *by column family*. So there is a grain of truth — data within a column family is stored together — but the model is a sparse, schema-flexible key-value map, and the physical engine is LSM, not the compressed columnar format of a Vertica or ClickHouse. Calling Cassandra a "column-oriented database" in an interview is the kind of imprecision that gets flagged. It is a **wide-column** store; ClickHouse is **column-oriented**; the two solve different problems.

---

## 61.11 Data Files and Index Files

Every disk-based engine splits its on-disk state into two kinds of file, and the relationship between them is the crux of Part I.

- **Data files** hold the actual records. In Postgres these are the heap files (§61.7).
- **Index files** hold structures that map a search key to a *location* in the data files, so you can find a record without scanning everything.

The point of an index is to make lookups sublinear. A full **sequential scan** of a table is O(N) blocks — fine for OLAP, ruinous for a point lookup on a billion-row table. An index turns that into O(log N) block accesses (B-tree, Ch. 62) or an O(1)-ish hash probe. Without indexes a DBMS is a very expensive flat file.

Indexes are classified along axes that recur constantly:

| Axis | Meaning |
|---|---|
| **Primary vs secondary** | Primary index is built on the key by which data is physically organized; secondary indexes are all the others. |
| **Clustered vs non-clustered** | Clustered: the data file *is* ordered by the index key (index and data are one structure). Non-clustered: the index is separate, pointing into an independently-ordered data file. |
| **Dense vs sparse** | Dense: one index entry per record. Sparse: one entry per *block/page*, relying on within-block scan (Ch. 62–63). |
| **Covering** | The index contains all columns a query needs, so the data file need not be touched at all (index-only scan). |

These are the vocabulary of the next several chapters; §61.12–61.14 make them concrete in Postgres and its rivals.

---

## 61.12 Data Files: Heap-Organized vs Index-Organized

How is the primary data file itself organized? Two dominant answers, and Postgres and MySQL sit at opposite ends — a comparison interviewers love.

**Heap-organized (Postgres).** The data file is an unordered heap (§61.7); rows land wherever there is free space. There is **no clustered index** and no "primary" storage order. The primary key is simply a **unique B-tree index** like any other, whose entries point (via TID) into the heap. Consequences:

- All indexes, including the primary key, are **secondary** in structure: they store a key and a **TID** into the heap. There is no "special" primary index that owns the rows.
- A point lookup is: probe the index → get a TID → fetch the heap page → return the tuple. Two structures, at least two page reads.
- The `CLUSTER` command physically reorders the heap to match one index's order *once*, but Postgres does **not** maintain that order as rows change — it decays immediately. Postgres has no self-maintaining clustered index.

**Index-organized / clustered (MySQL InnoDB, Oracle IOT).** The table *is* a B-tree keyed on the primary key; the full row lives in the B-tree's leaf pages. There is no separate heap. Consequences:

- A primary-key lookup finds the whole row in the leaf — one structure, no second hop.
- **Secondary indexes store the primary key**, not a physical pointer, at their leaves. So a secondary-index lookup does two B-tree descents: secondary index → primary key → clustered index → row. This is why a large or randomly-generated primary key bloats every secondary index and why InnoDB advises small, monotonic primary keys.
- Insert order matters: a random primary key causes page splits all over the clustered B-tree; a monotonic key (auto-increment) appends to the rightmost leaf.

The trade-off in one line: **heap-organized decouples the primary key from physical layout (cheap secondary indexes, but every read is an index + heap hop); index-organized fuses them (fast primary-key reads, but fat secondary indexes and split-sensitive inserts).**

---

## 61.13 Index Files: Primary, Secondary, Clustered, Non-Clustered

Nail the four-way vocabulary from §61.11, because the terms are used inconsistently in the wild and an interviewer may be checking whether you can disentangle them.

- A **primary index** is the index on the attribute that determines physical order. In an index-organized table it *is* the table. In heap-organized Postgres there is arguably no primary index in this strict sense — the primary-key index is just the unique index the DBA designated.
- A **secondary index** is any additional index. It always needs a way to reach the row: a physical TID (Postgres) or the primary key (InnoDB clustered tables).
- **Clustered** means index order = data order. There can be at most **one** clustered index per table, because data can only be sorted one way. InnoDB's primary key is clustered; Postgres has none maintained.
- **Non-clustered** means the index is a separate structure whose order is independent of the data. You can have many.

A **covering index** short-circuits the row fetch entirely: if every column the query references is present in the index, the engine does an **index-only scan** and never touches the heap. Postgres supports this and adds `INCLUDE` columns (stored only in the leaf, not part of the key) precisely to make more queries covering. The catch in Postgres: because visibility info lives in the heap (§61.7), an index-only scan still must consult the **visibility map** to confirm the page is all-visible; if not, it falls back to a heap fetch. That coupling of visibility to the heap is a direct consequence of MVCC and recurs in Ch. 65.

---

## 61.14 The Primary Index as Indirection

Here is the unifying idea the book highlights: **an index entry points at a record's *location*, and that location is deliberately an indirection, not a raw byte address.** The extra level of indirection is what makes the storage engine maintainable.

In Postgres the chain is: index entry → **TID** *(page, line-pointer index)* → **line pointer** *(offset, length within page)* → tuple bytes. Two indirections. Why bother?

- **Intra-page compaction.** When a page accumulates dead tuples, Postgres can slide the live tuples together to reclaim contiguous free space, updating only the **line pointers** — the TIDs the indexes hold still resolve correctly. No index needs updating for a page-internal move. Without the line-pointer level, every compaction would have to rewrite every index.
- **Row versioning across pages.** When an update must place the new tuple version on a *different* page (the current page is full), the old tuple's `t_ctid` points forward to the new TID, and the indexes are updated to point at the new version. But when the new version fits on the **same page** and no indexed column changed, Postgres performs a **HOT** (Heap-Only Tuple) update: it chains the new version off the old via `t_ctid` and **does not touch any index at all**. Indexes still point at the original line pointer, which is redirected to the current version. HOT is one of Postgres's most important write optimizations, and it exists *only because of the indirection layer*.

The cost of MVCC's copy-on-update is **dead tuples** — old versions no longer visible to any transaction. **VACUUM** reclaims them: it scans for dead tuples, removes their index entries, and frees their line pointers for reuse; **autovacuum** does this in the background. Neglected vacuuming causes **table bloat** (files far larger than live data) and, in the extreme, **transaction-ID wraparound**, the failure mode that has taken down production Postgres fleets. All of it traces back to §61.7's decision to keep multiple versions in the heap — a decision the indirection layer makes survivable.

This same indirection idea appears everywhere: LSM trees indirect through levels and a memtable (Ch. 67); some engines add a **translation layer** (a logical-to-physical id map) so that background compaction can relocate data without rewriting references — the same trick, one level up.

---

## 61.15 Buffering, Immutability, and Ordering: The Three Axes

The book's central organizing claim, and the one to be able to reproduce cold: nearly every storage structure is defined by its choice on three orthogonal axes. These three axes are the map for all of Chapters 62–67.

**1. Buffering — do writes accumulate in memory before hitting disk?**
- *Not buffered*: apply each change to the on-disk structure immediately. Simpler, but many small random writes.
- *Buffered*: batch changes in a memory buffer and flush them together as larger, more sequential writes. LSM trees are built on buffering (the memtable); B-trees buffer implicitly via the page cache and some variants buffer explicitly.

**2. Mutability (immutability) — are files updated in place or only appended?**
- *In-place / mutable*: overwrite existing bytes. B-trees mutate pages in place. Efficient space use, but requires careful concurrency and crash handling (you can catch a page half-written — Ch. 63's torn-page problem).
- *Immutable / append-only*: never overwrite; write new data and treat old as obsolete, reclaiming later via compaction. LSM SSTables are immutable. Immutability simplifies concurrency (readers never see a half-written record) and crash recovery, at the cost of space amplification and background compaction.

**3. Ordering — are records kept sorted by key on disk?**
- *Ordered*: records (or the index over them) are sorted by key, enabling range scans and binary search. B-trees keep keys ordered.
- *Unordered*: records are stored in write/arrival order (a heap, or a hash-indexed log like Bitcask, Ch. 67), giving fast writes but requiring an index for any ordered access.

```
                 Buffered?     In place vs append?   Ordered on disk?
B-tree           mostly no     in place              ordered
LSM tree         yes (memtbl)  append-only           ordered (per SSTable)
Heap file        no            append (+ in-place    unordered
                               reuse of free space)
Hash log (Bitcask) no          append-only           unordered
```

The reason these three axes matter more than any feature list: they *predict the performance profile*. Buffered + immutable + ordered (LSM) gives excellent write throughput and good range reads at the cost of read amplification and compaction (write amplification) — the **RUM conjecture** trade-off (Ch. 67) that you cannot minimize Read, Update, and Memory overhead all at once. In-place + ordered + unbuffered (B-tree) gives excellent point/range reads and read-modify-write, at the cost of random write I/O. **B-trees vs LSM trees is the headline rivalry of Part I, and it is entirely explained by these three axes** — which is why Chapters 62–66 develop the B-tree and Chapter 67 develops its immutable, buffered counterpart.

---

## 61.16 The Life of a Query: An End-to-End Walkthrough

Tie the layers together by tracing `SELECT * FROM orders WHERE id = 42;` through a warm Postgres, naming which chapter owns each step.

1. **Transport.** The client sends the query over the wire protocol; the backend process (§61.3) for this session receives it. Under the hood this is a TCP byte stream (Ch. 38) framed by Postgres's message protocol.
2. **Parse.** The parser turns SQL text into a parse tree, resolving `orders` and `id` against the system catalogs (themselves ordinary tables).
3. **Plan/optimize.** The optimizer estimates that a point lookup on the primary key `id` is cheapest via the `orders_pkey` B-tree index (an **Index Scan**), not a Seq Scan. This is cost-based and depends on statistics gathered by `ANALYZE`.
4. **Execute — index descent.** The executor asks the B-tree access method for `id = 42`. The B-tree is walked root → internal → leaf (Ch. 62); each page is fetched through the **buffer manager** (§61.15, Ch. 65): if resident in `shared_buffers`, it is a memory hit; if not, a page read from the heap file (Ch. 34 I/O). The leaf yields a **TID** (§61.14).
5. **Execute — heap fetch.** The executor fetches the heap page named by the TID (again via the buffer manager), follows the line pointer to the tuple, and applies **MVCC visibility** (§61.7, Ch. 65): is this tuple version visible to my transaction's snapshot? It follows the `t_ctid` update chain if needed to find the version I should see.
6. **Return.** The visible tuple is projected and sent back up through the executor to the transport layer to the client.

Every subsystem this chapter introduced appears: process model (§61.3), buffer pool (§61.15), B-tree access method (§61.11), heap layout and TID indirection (§61.7, §61.14), MVCC (§61.7). The rest of Part I zooms into each: **how the B-tree in step 4 is structured (Ch. 62), how its pages are laid out on disk (Ch. 63), how it is actually implemented and kept balanced under concurrent writes (Ch. 64), how the transaction and durability machinery in step 5 works (Ch. 65), what variants trade off differently (Ch. 66), and what a fundamentally different, append-only engine looks like (Ch. 67).** Part II then asks what changes when the data — and these very mechanisms — are spread across many nodes.

---

## Summary

- A DBMS is a stack: transport → query processor (parse, optimize) → execution engine → **storage engine** (transactions, locks, access methods, buffer pool, recovery). Part I is the storage engine; the SQL standard deliberately leaves it unspecified.
- Postgres is **process-per-connection** around a shared-memory **buffer pool** (`shared_buffers`), with background processes for checkpointing, WAL, and autovacuum.
- The **disk vs memory** decision is about where the *authoritative copy* lives and is driven by the 3–5-order-of-magnitude access-time gap; durability is independent of the medium (in-memory stores get it from WAL + snapshots).
- **Row vs column** layout predicts OLTP vs OLAP fitness; **wide-column** stores (Cassandra) are a *data model*, not the columnar physical layout of a ClickHouse.
- Postgres is **heap-organized** (rows in an unordered heap; all indexes secondary, pointing via **TID**); InnoDB is **index-organized** (clustered PK B-tree; secondary indexes store the PK).
- The **primary index as indirection** (index → TID → line pointer → tuple) is what makes intra-page compaction, HOT updates, and VACUUM possible — all consequences of MVCC keeping multiple versions in the heap.
- Nearly every storage structure is defined by three axes — **buffering, immutability, ordering** — and B-trees vs LSM trees is that choice made two opposite ways.

---

## Key Interview Questions

1. **What are the layers of a DBMS, top to bottom?** — Transport/wire protocol → query processor (parser, analyzer/rewriter, cost-based optimizer) → execution engine → storage engine (transaction manager, lock manager, access methods, buffer manager, recovery/WAL) → block device. The optimizer is the compiler; the execution and storage engines are the runtime.
2. **What is a storage engine, and why is it a separate concept from the DBMS?** — The subsystem that turns rows into durable bytes and back: access methods, buffer pool, transactions, recovery. It is swappable behind the execution engine's cursor API (MySQL's InnoDB/RocksDB, MongoDB's WiredTiger, Postgres's table-AM), and the SQL standard deliberately does not specify it.
3. **How is a running PostgreSQL instance structured?** — Process-per-connection: a postmaster forks a backend process per client, plus background processes (checkpointer, WAL writer, background writer, autovacuum). All attach to a shared-memory region containing the buffer pool (`shared_buffers`), WAL buffers, and lock tables. This is why Postgres needs a connection pooler at scale.
4. **Disk-based vs in-memory DBMS — what actually differs?** — Where the authoritative copy lives. Disk-based (Postgres) uses RAM as a cache and on-disk structures (B-trees/LSM) that minimize block transfers; in-memory (Redis, VoltDB) holds the primary copy in RAM and can use pointer-rich structures. Driven by the ~100 ns vs ~50–100 µs vs ~10 ms access-time gap between DRAM, NVMe, and disk.
5. **If RAM is volatile, how is an in-memory database durable?** — A write-ahead log (append + `fsync` before ack) plus periodic snapshots/checkpoints; recovery loads the latest snapshot and replays the log suffix. Redis: AOF is the WAL, RDB is the snapshot. Durability is a knob (`fsync` per write vs group commit vs OS-deferred), independent of the storage medium.
6. **Row-oriented vs column-oriented storage — when does each win?** — Row stores keep a whole row contiguous: great for OLTP point read/writes. Column stores keep each column contiguous: great for OLAP because I/O is proportional to columns touched, compression is far better (similar adjacent values), and execution can be vectorized/SIMD. Column stores are bad at single-row insert/update.
7. **Is PostgreSQL a column store, and how would you do columnar analytics with it?** — No, core Postgres is a row store. Columnar comes from extensions (Citus `columnar` table-AM), foreign data wrappers over Parquet, or pairing with an embedded column engine like DuckDB. You cannot turn a row store columnar by adding an index.
8. **Why are wide-column stores like Cassandra not "column-oriented"?** — "Wide-column" names the *data model* (a sparse, per-row-variable map of maps grouped into column families), not the physical layout. Cassandra/HBase/Bigtable are usually LSM-tree engines; they are not the compressed columnar format of ClickHouse/Vertica.
9. **What is a Postgres heap, and how is a tuple addressed?** — A heap is the unordered table file split into 8 KB slotted pages. A tuple is addressed by TID = (page number, line-pointer index), exposed as `ctid`. Indexes point at the TID/line pointer, not at raw bytes.
10. **Heap-organized vs index-organized tables?** — Heap-organized (Postgres): rows in an unordered heap, all indexes secondary and pointing via TID, no maintained clustered index. Index-organized/clustered (InnoDB, Oracle IOT): the table is a PK B-tree with full rows in the leaves, and secondary indexes store the PK, so a secondary lookup does two descents.
11. **In InnoDB, why do secondary indexes store the primary key instead of a row pointer, and what's the cost?** — Because the row lives in the clustered PK B-tree and can move on page splits; storing the PK keeps secondary indexes valid across moves. Cost: every secondary lookup does an extra PK B-tree descent, and a large PK bloats every secondary index — hence the advice to use small, monotonic primary keys.
12. **What does "primary index as indirection" mean and why does it matter?** — An index points at a *location* (TID → line pointer → tuple), not a byte address. The indirection lets Postgres compact a page (moving tuples, updating only line pointers) and perform HOT updates without touching any index. Without it, every relocation would rewrite every index.
13. **What is a HOT update?** — Heap-Only Tuple update: when an update fits on the same page and changes no indexed column, Postgres chains the new version off the old via `t_ctid` and updates no index. It relies entirely on the line-pointer indirection and greatly reduces index write amplification.
14. **Why does Postgres need VACUUM?** — MVCC writes a new tuple version on every update/delete and leaves the old ones as dead tuples in the heap. VACUUM reclaims dead tuples and their index entries; autovacuum runs it in the background. Neglect causes table bloat and, in the extreme, transaction-ID wraparound.
15. **What are the three axes that define a storage structure?** — Buffering (batch writes in memory or not), mutability (update pages in place vs append-only immutable files), and ordering (keep records sorted by key on disk or not). B-trees are unbuffered/in-place/ordered; LSM trees are buffered/immutable/ordered.
16. **Explain the B-tree vs LSM-tree trade-off in terms of those axes.** — B-tree: in-place, ordered, largely unbuffered → excellent point/range reads and read-modify-write, but random write I/O. LSM: buffered (memtable) + immutable (SSTables) + ordered → excellent write throughput and good range reads, at the cost of read amplification and compaction (write amplification). It is the RUM-conjecture trade (Ch. 67).
17. **What is a covering / index-only scan, and Postgres's caveat?** — If an index contains every column a query needs, the engine answers from the index and skips the data file. Postgres supports it (with `INCLUDE` columns) but must still check the visibility map, because MVCC visibility lives in the heap; a not-all-visible page forces a heap fetch anyway.
18. **Walk a point-lookup `SELECT ... WHERE id = 42` through Postgres.** — Backend receives it → parse and catalog-resolve → optimizer picks an Index Scan → B-tree descent (pages via buffer pool) yields a TID → fetch the heap page, follow the line pointer, apply MVCC visibility (follow the `t_ctid` chain if needed) → project and return.
19. **Dense vs sparse index?** — Dense: one index entry per record. Sparse: one entry per block/page, relying on a scan within the located block; requires the data to be ordered so the block boundaries are meaningful. Sparse indexes are smaller and are how B-tree internal levels and column-store zone maps work.
20. **OLTP vs OLAP vs HTAP, and how does it map to storage layout?** — OLTP = many small key-based read/writes → row store + B-tree. OLAP = few large scans/aggregations over a few columns → column store + immutable sorted files + vectorized execution. HTAP tries to serve both, usually via dual storage (a row store plus an async column replica), whose challenge is keeping the analytical copy fresh without slowing writes.
21. **Vectorized vs tuple-at-a-time execution — is it the same as column storage?** — No, it's an independent axis. Volcano/iterator execution returns one tuple per `next()` (a virtual call per tuple per operator); vectorized execution returns a batch (enabling SIMD). Column layout and vectorization pay off together, so the terms get bundled, but row stores can vectorize (SQL Server batch mode, DuckDB) and Postgres JIT-compiles expressions to attack the same interpreter overhead.
22. **Why can't a single storage structure be optimal for reads, writes, and space at once?** — The RUM conjecture: optimizing any two of Read overhead, Update overhead, and Memory (space) overhead sacrifices the third. B-trees favor reads; LSM trees favor writes and pay in read/space amplification; heavy compression favors space and pays in update cost. The three axes of §61.15 are how you pick your two.

---

## Common Traps

- **Calling Cassandra/HBase "column-oriented."** They are *wide-column* (a data-model term); physically they are LSM engines, not the compressed columnar layout of ClickHouse/Vertica.
- **Assuming "in-memory" means "not durable" (or that disk-based means safe).** Durability is a WAL/`fsync` decision independent of medium; an in-memory store can be fully durable and a disk store can lose data with lazy `fsync`.
- **Thinking Postgres has a clustered/primary-storage index.** Postgres is heap-organized; the primary key is just a unique B-tree pointing via TID, and `CLUSTER` reorders once and then decays.
- **Believing an index-only scan in Postgres never touches the heap.** It still consults the visibility map, because MVCC visibility lives in the heap; a not-all-visible page triggers a heap fetch.
- **Confusing row/column *storage* with vectorized/tuple-at-a-time *execution*.** They are independent knobs that happen to pay off together.
- **Expecting `SELECT count(*)` or wide-column analytics to be fast on a row store.** Row stores read whole rows; analytics over a few columns of a big table want columnar storage, not another index.
- **Forgetting that MVCC updates create dead tuples.** Without adequate (auto)vacuuming, tables bloat and transaction-ID wraparound eventually forces the database read-only.
- **Assuming a large or random primary key is harmless in InnoDB.** It is copied into every secondary index and causes clustered-B-tree page splits; small monotonic keys are strongly preferred.
- **Treating an index pointer as a byte offset.** It is an indirection (TID → line pointer); that layer is exactly what enables page compaction and HOT updates.
