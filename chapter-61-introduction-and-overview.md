# Chapter 61 — Storage Systems: Introduction and Overview

Chapters 61–74 are an **optional specialization track**. They prepare readers
for storage-engine, exchange-infrastructure, data-platform, and distributed-
systems interviews. The first sixty chapters remain a complete low-latency C++
and HFT systems path; this track does not restart the book or assume that every
trading role needs database internals.

The bridge is nevertheless useful. An exchange gateway journals events, a
market-data platform stores ordered history, a risk service needs consistent
state, and a recovery system replays a durable prefix. The same questions recur:

- What is the authoritative state?
- Which access patterns must be cheap?
- What is buffered, copied, indexed, or rewritten?
- When is a change durable and visible?
- What happens during a crash, concurrent update, or partial network failure?

This chapter supplies the comparison framework. Chapters 62–67 deepen local
storage engines. Chapters 68–74 deepen distributed systems.

## Who should take this track — Core

Read the full track if you expect to design or operate:

- time-series/history stores, journals, capture/replay systems, or reference-data
  services;
- exchange or broker infrastructure with durable transactional state;
- database kernels, storage libraries, streaming platforms, or distributed
  control planes;
- replication, failover, partitioning, or consensus mechanisms.

If your role is strictly latency-critical C++ on an established storage
platform, this chapter is designed to be a coherent stopping point. Retain the
framework and follow cross-references only when the role demands depth.

### The three-chapter bridge

A general HFT reader can take a short route:

1. **Chapter 61:** pages, indexes, buffering, WAL, transactions, and the
   local-to-distributed boundary.
2. **Chapter 71:** replication modes and consistency guarantees.
3. **Chapter 74:** consensus, quorum replication, commit, and snapshots.

That route covers the requested bridge from durable bytes to replicated
agreement. Specialists continue sequentially:

- **Chapters 62–67 — local storage:** B+trees, file/page formats, concurrent
  trees, transactions/recovery, tree variants, and LSM storage.
- **Chapters 68–74 — distributed state:** failure models, failure detection,
  election/fencing, replication/consistency, anti-entropy, distributed
  transactions, and consensus.

### Full-track roadmap

| Chapter | Question it owns |
|---|---|
| 61 | Which workload and guarantee drive storage/distribution choices? |
| 62 | Why does B+tree fan-out produce shallow ordered indexes? |
| 63 | How do pages become versioned, checksummed durable bytes? |
| 64 | How does a concurrent B-tree remain searchable through splits? |
| 65 | How do buffering, WAL, recovery, isolation, MVCC, and locks interact? |
| 66 | Which tree variants move read/write/space/concurrency costs? |
| 67 | How do memtables, runs, compaction, filters, and tombstones form an LSM? |
| 68 | What changes with independent failures and no shared memory/clock? |
| 69 | What can a failure detector suspect, with what error trade-off? |
| 70 | How do terms, elections, leases, and fencing constrain authority? |
| 71 | Which replication and consistency guarantee does a client observe? |
| 72 | How are divergent replicas repaired and membership changes spread? |
| 73 | Why do cross-partition transactions block, abort, or coordinate? |
| 74 | How does a quorum-replicated log commit and compact agreed state? |

This order is a dependency path, not a requirement for every role. A storage-
kernel candidate may stop after Chapter 67; an infrastructure candidate can
skim 62–67 after this overview and focus on 68–74.

## 90-second screen — Core

1. Start with workload: point/range access, read/write mix, record size, working
   set, durability point, concurrency, retention, and tail target.
2. A DBMS layers query semantics over an execution engine, transaction/recovery
   subsystem, indexes, buffer manager, and durable files. A storage engine is the
   lower part, not a synonym for the full DBMS.
3. Pages are transfer, caching, concurrency, and recovery units. Index fan-out,
   page occupancy, cache residency, and device behavior—not “disk is slow”—drive
   access cost.
4. B+trees organize mutable ordered pages; LSM designs buffer writes and create
   immutable sorted runs. Compare read, write, and space amplification plus
   background work.
5. Page-cache I/O, a private buffer pool, `mmap`, and direct I/O place caching and
   faults differently. None is a universal latency winner.
6. WAL and copy-on-write are recovery strategies, not durability by themselves.
   Ordering, synchronization, checksums/commit markers, and recovery rules define
   the durable prefix.
7. Transactions combine atomicity, isolation, and durability policy. Latches
   protect in-memory structures; locks/MVCC protect logical data semantics.
8. Distribution adds partial failure and multiple copies. Replication is not
   consensus, quorum arithmetic alone is not a consistency model, and retries
   need identities/idempotence.

Two choices to defend:

- B+tree, LSM, hash/log, or hybrid—from workload and amplification, not product
  fashion.
- Local commit, synchronous replication, or asynchronous replication—from the
  acknowledged guarantee and failure model.

---

## Workload and system layers

## 61.1 From an HFT Service to a Storage Engine — Core

An in-memory order map and a storage engine both map keys to values, but a
storage engine must survive capacities and failures that invalidate ordinary
container assumptions:

```
hot service state                    storage-engine state
-----------------                    --------------------
objects in one address space         records outlive one process
pointer/reference identity           logical page/record identifiers
cache lines as movement units        pages/blocks plus cache lines
process crash may lose state         recovery reconstructs a valid state
one owner can serialize updates      concurrent transactions need semantics
local memory ordering                persistent and replicated ordering
```

The transition is not “replace `unordered_map` with a B-tree.” It introduces a
file format, checksums/versioning, free-space management, a cache, recovery
metadata, concurrency control, background maintenance, and operational tools.

A **database** is an organized collection of data. A **database management
system (DBMS)** provides definition, query, update, concurrency, recovery,
security, and administration. A **storage engine** maps logical records/index
operations to cached and durable bytes while preserving its transaction and
recovery contract.

Relational vocabulary remains useful even for non-relational engines:

- a **schema** defines named objects and constraints;
- a **table/relation** contains rows/tuples described by columns/attributes;
- a **key** identifies or orders records;
- a **primary key** is the chosen row identity; uniqueness is a logical
  constraint, not merely an index property;
- a **foreign key** constrains references between relations;
- a **catalog** stores metadata about schemas, types, indexes, privileges, and
  dependencies.

Physical design may diverge sharply while preserving the same relational
semantics. SQL does not require one page layout, index, MVCC scheme, or WAL
algorithm.

## 61.2 DBMS Layers and Query Flow — Core

A useful decomposition is:

```
client/protocol
      │ statement or prepared operation
      ▼
parse → semantic analysis/catalog lookup → rewrite
      ▼
planner/optimizer: logical alternatives → physical plan
      ▼
executor: scans, joins, sorts, aggregates, expression evaluation
      ▼
transaction + access methods + buffer manager + recovery
      ▼
files / page cache or direct I/O / storage device
```

The boundaries are conceptual; products combine or split components. A query
processor owns language semantics and plan choice. The executor drives physical
operators. Access methods implement heap, index, or log operations. The
transaction subsystem defines visibility and conflicts. Recovery reconstructs a
valid durable state after interruption.

### Planning and execution in one table

| Concern | Input | Decision/output | Failure or cost risk |
|---|---|---|---|
| Parse/analyze | Text/protocol values + catalog | Typed logical expression | Invalid names/types, catalog contention |
| Rewrite | Views/rules/policies | Equivalent logical tree | Expansion and semantic surprises |
| Optimize | Logical tree + statistics | Join order, scans, algorithms | Cardinality error chooses poor work |
| Execute | Physical plan | Batches/tuples | Spills, branch/virtual overhead, skew |
| Access method | Keys/predicates | Records or identifiers | Page reads, amplification, contention |
| Transaction | Reads/writes | Visibility/conflict decisions | Blocking, aborts, anomalies |
| Recovery | Log/pages/checkpoints | Recoverable state | Torn/corrupt writes, missing ordering |

Statistics—row counts, distributions, most-common values, distinct counts, and
correlations—feed cardinality estimates. Those estimates influence sequential,
index, or bitmap scans; nested-loop, hash, or merge joins; and whether sort,
aggregate, window, or materialization work fits memory. A cost estimate is a
model in product-specific units, not a prediction of wall-clock nanoseconds.

**Tuple-at-a-time** (Volcano-style pull) execution asks operators for one row at
a time. **Vectorized** execution processes batches, amortizing dispatch and
enabling cache/SIMD-friendly loops. This axis is independent of row versus column
storage, though columnar batches often complement vectorization. JIT compilation
can reduce expression interpretation after paying compilation cost; prepared
statements can reuse analysis/plans but may face a generic-versus-parameter-
specific plan trade-off. Parallel workers add setup, exchange, and skew costs.

The chapter does not catalog optimizer algorithms. The interview model is:

```
estimated rows → physical choice → memory/I/O/concurrency consequences
```

Use product tools such as `EXPLAIN` and runtime instrumentation to compare
estimated with observed rows and work. Exact node names, cost constants, and JIT
or parallel thresholds are product/version/configuration details.

## 61.3 Workload Before Product — Core

Classify the workload before selecting structures.

| Dimension | Questions |
|---|---|
| Access | Equality, ordered range, prefix, full scan, aggregation, latest value? |
| Mutation | Insert, update-in-place semantics, append, delete, overwrite frequency? |
| Mix | Read/write ratio, burst shape, skew, hot keys, concurrent writers? |
| Size | Record/key size, working set, total/retained data, growth rate? |
| Correctness | Atomic unit, isolation, uniqueness, constraints, acknowledged durability? |
| Latency | p50/tail target for foreground work; allowed background interference? |
| Operations | Backup, restore, schema evolution, compaction/vacuum, observability? |
| Distribution | One failure domain, replicas, partitions, geographic latency, availability? |

**OLTP** workloads perform many small transactional reads/writes, commonly by
key. **OLAP** workloads scan and aggregate many rows while touching selected
columns. **HTAP/mixed** systems attempt both; they often separate representations
or replicas because one layout rarely serves both optimally.

Do not infer storage from the label alone. An append-heavy event ledger is
transactional but may favor a log/LSM path. A point lookup with strict range
queries may favor a B+tree. An OLAP engine ingesting tiny updates may buffer them
before producing columnar segments.

---

## The storage-engine comparison framework

The four headline comparisons operate at different layers:

| Decision | Option A | Option B | Governing question |
|---|---|---|---|
| Index/update organization | B+tree | LSM/tree of sorted runs | Pay foreground page updates or background compaction? |
| Cache/I/O control | OS page cache/`mmap` | Private buffers/direct I/O | Who owns residency, eviction, faults, and writeback? |
| Crash recovery | WAL + later page write | Copy-on-write + root publication | Which ordered durable evidence selects committed state? |
| Failure domain | Local state | Partitioned/replicated state | Which failures must acknowledged work survive? |

These are not bundles. A B+tree can be copy-on-write; an LSM still usually needs
a log for unflushed memory; either can use buffered or direct I/O; either can sit
behind replication. Treating “LSM + direct + distributed” as one product category
hides the decisions the interview is testing.

Three additional axes predict much of the behavior:

- **buffering:** apply changes near their destination or accumulate/batch them;
- **mutability:** update existing durable pages/runs or write new generations;
- **ordering:** maintain key order, hash placement, or append order.

Each optimization moves work. Buffering moves writes into flush; immutability
moves reclamation into compaction; ordering makes ranges cheap but requires
maintenance. Ask when the moved work runs, what bounds it, and whether it shares
the foreground CPU, memory bandwidth, cache, and device queue.

## 61.4 Rows, Columns, Memory, and Authority — Core

### Row versus column layout

A row layout places fields of one record together:

```
[id|symbol|price|qty] [id|symbol|price|qty] ...
```

A column layout groups one field across records:

```
[id id id ...] [symbol symbol ...] [price price ...] [qty qty ...]
```

Row layout favors operations that consume or update most of one record.
Column layout favors scans over a subset of columns, compression of similar
values, and vectorized operations. Columnar updates often accumulate in deltas
or new segments instead of modifying a compressed value in place.

“Wide-column” describes a data model associated with systems such as Bigtable-
style stores; it does not imply the analytical columnar physical layout above.
A wide-column product may use an LSM engine internally. Keep data model, physical
layout, and execution model as separate axes.

### In-memory versus storage-resident authority

An in-memory engine treats RAM as the primary online representation; a
storage-resident engine organizes durable pages/files and uses RAM as a cache.
This does not decide durability. An in-memory engine can acknowledge only after
a durable log/replica condition, while a storage-resident engine can acknowledge
buffered writes before stable storage if configured that way.

Ask:

- Does the authoritative working set fit with headroom, indexes, versions, and
  allocator overhead?
- What is rebuilt after restart, from which log/snapshot, within what recovery
  objective?
- Does pointer-rich layout block portability or fast restart?
- What happens when memory pressure exceeds assumptions?

Device technology changes the gap but not the framework. NVMe reduces access
latency and supports parallel queues compared with rotating media, so “random
I/O is always catastrophic” is obsolete. Random access can still increase
requests, queueing, metadata work, write amplification, and tail variability;
sequential/batched access still improves locality and device efficiency under
many workloads. Name the device and queue/load.

## 61.5 Pages, Data Files, and Index Indirection — Core

Storage engines group bytes into **pages** (or blocks). A page is commonly:

- a unit read/written through the storage/cache layer;
- a unit protected by an in-memory latch;
- a unit carrying checksum/version/recovery metadata;
- a unit managed for free space and eviction.

The engine’s page size need not equal a device sector, filesystem block, virtual
memory page, or CPU cache line. Correctness must account for the actual write
atomicity and synchronization guarantees of the deployed stack.

A **slotted page** keeps an array of stable slot/line identifiers and places
variable-sized records elsewhere in the page:

```
+---------------- page ----------------+
| header | slot directory →            |
|          free space                  |
|                 ← record bytes       |
+--------------------------------------+
```

Compaction can move record bytes while updating slots, leaving external record
identifiers such as `(page_id, slot_id)` stable. Chapter 63 owns format,
checksums, endian/version handling, and crash assumptions.

### Heap-organized versus index-organized

A heap-organized table stores rows without maintaining primary-key order; indexes
point to row identifiers. An index-organized/clustered design stores rows in the
leaves of an ordering index, often the primary-key tree.

| Choice | Advantage | Cost |
|---|---|---|
| Heap + secondary indexes | Stable row identifier can serve several indexes; cheap unordered append | Lookup may need index then heap; locality depends on heap organization |
| Clustered/index-organized | Primary-key/range locality; one descent reaches row | Secondary indexes need a row locator/primary key; key moves/splits affect layout |

“Primary,” “secondary,” “clustered,” and “unique” describe different properties.
A primary key is logical identity; a unique index can enforce it. A secondary
index is another access path. Clustering describes physical organization or a
product-specific reordering feature, not universal SQL semantics.

Indirection is deliberate:

```
secondary key → row ID or primary key → page/slot → record/version
```

It lets storage move records/pages or change versions without exposing raw
addresses. The extra lookup is a read-amplification/locality cost. Product
implementations choose different locators.

## 61.6 Index Families and Amplification — Core

An index trades write/space/maintenance cost for access.

### B+tree

A B+tree keeps separator keys in internal pages and ordered entries/records in
linked leaf pages. High fan-out keeps height small. Equality lookup descends one
root-to-leaf path; range scans descend once and traverse leaves.

An approximate internal fan-out is:

```
fanout ≈ floor((page_bytes - header_bytes) / (separator_bytes + child_ref_bytes))
```

This is a capacity estimate, not an I/O count. Effective height also depends on
occupancy, prefix/key compression, leaf capacity, root/internal cache residency,
and concurrent structure changes. Chapter 62 derives it; Chapter 64 owns
concurrent implementation.

### Worked fan-out estimate

Suppose an illustrative design uses 16,384-byte pages, reserves 128 bytes for
page metadata, and needs 24 bytes per separator-plus-child entry. Its maximum
internal fan-out estimate is:

```
usable bytes       = 16,384 - 128 = 16,256
maximum fan-out    = floor(16,256 / 24) = 677
planning fan-out   ≈ 677 × 0.70 ≈ 474
```

The 70% occupancy is a planning assumption, not a B+tree invariant. An engine
may target different fill factors at bulk load, leave split room, compress
prefixes, or experience skewed occupancy.

If a leaf entry averages 40 bytes, the same page holds at most 406 entries and
roughly 284 at the illustrative 70% occupancy. One billion entries would
therefore occupy about:

```
ceil(1,000,000,000 / 284) ≈ 3.52 million leaf pages
```

Because \(474^2 = 224{,}676\) is too small to address that many leaves while
\(474^3 = 106{,}496{,}424\) is ample, this simplified model needs three internal
levels plus the leaf level. That is four logical page visits per point lookup.
It is **not** a prediction of four physical device reads: the root and upper
internal pages are small enough to be hot in many deployments, the leaf may
already be cached, and one read can trigger readahead or queueing. Conversely, a
visibility check or heap indirection may add another page. The useful habit is
to separate logical structure depth from cache misses and device service time.

B+trees update ordered pages in place conceptually, though buffer pools, WAL,
copy-on-write variants, and storage devices transform the physical write path.
Splits and page contention can create foreground tails. They provide natural
ordered/range access and usually bounded lookup fan-out.

### LSM tree

An LSM design accepts writes into an in-memory ordered structure, records
durability separately, and flushes immutable sorted files. Reads consult memory
and one or more on-disk runs, aided by indexes/filters. Background compaction
merges runs, discards overwritten/deleted versions when safe, and reorganizes
levels.

It converts many small updates into sequential/batched writes but pays:

- **write amplification:** bytes rewritten during flush/compaction;
- **read amplification:** structures/runs checked per query;
- **space amplification:** obsolete/duplicate versions awaiting reclamation;
- background CPU, bandwidth, and tail interference.

Leveling, tiering, size ratios, filters, key distribution, update/delete mix, and
compaction scheduling change those costs. “LSM is for writes, B+tree is for
reads” is only a first approximation. Chapter 67 derives both paths.

### Hash/log and hybrid choices

A hash index can provide equality access without ordered ranges. An append-only
log can make ingestion/recovery simple but needs indexes and reclamation.
Fractal/buffered trees, copy-on-write trees, and separated value logs rearrange
amplification. Chapter 66 compares representative variants; the selection method
stays constant.

### Comparison axes

| Axis | Questions |
|---|---|
| Foreground reads | Structures/pages touched; cache residency; range behavior? |
| Foreground writes | Pages/logs/metadata changed; split/flush probability? |
| Background work | Compaction, vacuum, checkpoint, index build; throttle/control? |
| Space | Indexes, free space, old versions, temporary rewrite headroom? |
| Concurrency | Hot-page/key conflicts; latch/lock scope; snapshot cost? |
| Recovery | WAL/COW/checkpoint; replay volume; corruption detection? |
| Device/cache | Page cache, direct I/O, `mmap`; queue depth and locality? |
| Operations | Backup, incremental restore, format evolution, observability? |

### Work backward from the observable guarantee

In a design interview, avoid beginning with component names. Begin with one
operation and work backward:

```
client acknowledgement
  ← commit/visibility rule
  ← required durable log, page, or root state
  ← buffer and device synchronization
  ← index/data changes
  ← logical transaction and access pattern
```

Then work forward through recovery. Ask what durable evidence exists after an
interruption at every arrow and how recovery selects one valid outcome. This
two-direction trace exposes missing assumptions. For example, “append to a log”
does not say whether the index can lag, whether the log suffix can tear, or
whether acknowledgement waits for synchronization. “Replicate to three nodes”
does not say which nodes must acknowledge or who is allowed to accept a write
after failover.

Use three budgets rather than one average-latency number:

- **foreground budget:** lookup, mutation, conflict handling, and commit work
  before response;
- **background budget:** writeback, checkpoint, vacuum/reclamation, compaction,
  backup, and replica catch-up;
- **recovery budget:** detection, replay/repair, leadership or fencing, and
  service restoration.

Background work consumes the same finite CPU, memory bandwidth, cache, and
storage queues unless isolation is demonstrated. A design that meets steady
state by accumulating unlimited maintenance debt is unstable, not fast. Record
the overload action too: throttle ingestion, reject work, shed optional queries,
increase lag, spill, or violate no acknowledged guarantee. An explicit degraded
mode is safer than an accidental one.

## 61.7 Buffer Managers and I/O Policy — Core

A **buffer pool** maps logical page IDs to memory frames and tracks pin/use/dirty
state. A miss chooses or obtains a frame, reads the page, validates it, and makes
it available. Eviction must not remove a pinned/in-use frame; dirty eviction
requires writeback consistent with recovery ordering.

```
page request
  ├─ hit  → pin/latch/use/unpin
  └─ miss → choose frame → write dirty victim if allowed
                         → read/validate requested page → install
```

Replacement policy predicts future reuse imperfectly. Sequential scans can
pollute a cache; hot indexes benefit from residency. Pinning everything prevents
eviction but fails once working set or concurrent pins exceed capacity.

On Linux, an engine may use:

- buffered `read`/`write` through the OS page cache;
- a private buffer pool on top of buffered I/O, accepting possible double
  caching for control/portability;
- `mmap`, shifting misses into page faults and using virtual-memory replacement;
- direct I/O with aligned application buffers, managing cache/readahead itself.

Chapter 34 owns the I/O mechanics. The storage decision depends on working set,
access pattern, memory accounting, fault tolerance, concurrency, and operational
control. `mmap` does not remove I/O; direct I/O does not imply durability; the
page cache is not inherently unpredictable in every workload.

### A page is a state machine

A practical buffer manager cannot treat a cached page as merely present or
absent. A frame moves through states such as:

```
absent → loading → clean → dirty → flushing → clean
                    ↕       ↕
                 pinned / latched
```

The arrows hide important rules. Concurrent missers should normally coordinate
on one load rather than issue duplicate reads. A page can be dirty again while
an older image is being written, so completion must not erase the newer dirty
state. An eviction candidate must have no active pins, and its short structural
latch is distinct from a transaction lock. A failed checksum or short read must
not publish a valid-looking frame.

Recovery adds an ordering constraint: before a dirty page containing change
record \(L\) is written to its durable home, the required log prefix through
\(L\) must already be durable. Replacement and checkpoint code therefore
interact with WAL even though they solve different problems.

Capacity is policy too. A large sequential scan can evict a small, valuable
index working set, so engines may use scan rings, admission rules, or separate
priorities. A private pool over the OS page cache can duplicate some bytes, but
it can also provide explicit pinning, checksums, page identities, and recovery
coordination. Measure useful residency and tail latency rather than condemning
or endorsing “double caching” by slogan.

## 61.8 WAL, Copy-on-Write, Checkpoints, and Durability — Core

Crash recovery needs enough durable information to distinguish committed state
and repair interrupted updates.

### Write-ahead logging

WAL records changes before corresponding modified data pages may reach stable
storage:

```
change page in memory
      │
append log record L
      │
make required log prefix durable ──► transaction may acknowledge per policy
      │
data page can be written later, but never ahead of required WAL
```

The core ordering invariant is “log before data.” Commit durability additionally
requires the commit record/prefix to reach the promised durable domain before
acknowledgement. Group commit amortizes synchronization across transactions but
adds waiting and coupling. Checkpoints bound recovery work by recording a point
from which the system can reconstruct state; they do not necessarily flush every
logical update or eliminate WAL.

Recovery can need redo, undo, or version/visibility processing depending on
steal/no-force and engine design. Chapter 65 owns those policies. Do not infer
durability from a release store, page-cache visibility, or a successful ordinary
write.

### Copy-on-write

A COW structure writes changed pages to new locations and eventually publishes a
new root/metadata generation. Readers can retain an old immutable generation.
However:

```
write child pages → synchronize required data
                  → write/publish new root metadata
                  → synchronize commit point
```

COW does not automatically make a transaction atomic or durable. The engine must
define write ordering, torn-write detection, metadata redundancy/checksums, root
selection, free-space reclamation, and recovery after interruption. It may trade
WAL/replay complexity for rewrite/space amplification.

### Durability is a contract

State the acknowledged failure set:

- process crash only;
- kernel/host crash;
- sudden power loss with specified device cache behavior;
- storage-device loss;
- availability-zone or site loss.

Local synchronization cannot survive device loss. Replication can survive a
failure domain only if the acknowledged replica state and fencing/consistency
protocol provide that guarantee. Product settings can weaken or strengthen the
contract; name version/configuration.

## 61.9 Transactions and Concurrency — Core

A transaction groups operations under stated atomicity, consistency, isolation,
and durability semantics. “Consistency” in ACID means application/database
invariants are preserved by valid transactions; it is not the distributed
consistency-model term used later.

Two kinds of synchronization are easy to confuse:

- a **latch** protects an in-memory data structure/page during a short critical
  section;
- a **lock** or MVCC conflict rule protects logical records/ranges and
  transaction isolation, potentially across waits.

MVCC retains versions so readers can observe a snapshot while writers create new
versions. It reduces some read/write blocking but adds visibility checks, old-
version space, cleanup, and write-conflict rules. Locking can enforce serial
access but risks waits/deadlocks. Optimistic schemes validate before commit and
may abort under contention. No label alone specifies anomalies: state the
isolation level and engine behavior.

Common anomalies—dirty/nonrepeatable reads, lost update, write skew, phantoms—
depend on transaction histories. Serializable execution preserves an equivalent
serial ordering, but implementations use locking, validation, SSI-like
techniques, or combinations, each with abort/wait costs. Chapter 65 owns the
histories and recovery interaction.

### Worked crash timeline: one transfer

Consider a transaction that debits account \(A\) and credits account \(B\).
Assume the engine uses WAL and promises that an acknowledged commit survives a
host crash. The logical invariant is that the sum is unchanged; the physical
problem is that the two data pages and the log can reach storage at different
times.

1. The transaction obtains whatever logical concurrency protection its
   isolation design requires.
2. It creates the debit and credit changes in memory and appends the
   corresponding log information.
3. The buffer manager might write a changed data page before the transaction
   commits. A **steal** policy allows this and therefore needs a way to undo or
   hide an uncommitted effect during recovery.
4. At commit, the engine makes the required log prefix, including the commit
   decision, durable before acknowledging under this contract.
5. The changed data pages may remain dirty after acknowledgement. A
   **no-force** policy allows this and therefore needs redo or an equivalent way
   to reconstruct committed state.

Now stop the host at three points:

| Crash point | Required recovery outcome |
|---|---|
| Before a durable commit decision | Transfer is not committed; neither half may become visible as committed |
| Commit decision durable, neither data page durable | Redo/reconstruction produces both committed effects |
| Commit decision durable, one data page durable | Recovery completes the missing effect without applying the other twice |

The exact log records may contain physical byte changes, logical operations,
page images, compensation information, or version metadata. The invariant is
more general than any one format: acknowledgement, replay, and visibility must
agree on a single transaction outcome.

This example also separates **isolation** from **durability**. A perfect recovery
algorithm does not prevent two concurrent transfers from losing an update.
Likewise, serializable execution before a crash does not ensure committed bytes
survive it. Storage systems must compose both properties, then prove the
composition under their stated failure model.

---

## Concrete reference and distributed bridge

## 61.10 PostgreSQL as a Reference, Not the Definition — Role-specific

PostgreSQL is useful because its architecture exposes the general layers, but
product details are not universal storage rules.

At a high level, supported PostgreSQL releases use a server process that accepts
connections and creates backend processes, plus auxiliary/background processes.
Backends share memory containing the buffer pool and coordination structures,
while retaining local execution memory. Memory contexts group allocations for
bulk cleanup; resource-owner machinery tracks resources that must be released on
error. Background roles participate in WAL, checkpointing, writeback, vacuum,
statistics, and replication. Exact process names/responsibilities evolve by
release and configuration.

The following is an **implementation map**, not a portable DBMS specification:

```
client
  │ frontend/backend protocol
  ▼
server process (historically “postmaster”)
  ├─ backend process for a client session
  │    parse/rewrite/plan/execute
  │    local memory contexts + access to shared buffers/catalog state
  ├─ parallel workers using coordinated shared/dynamic-shared state
  └─ auxiliary/background processes
       WAL writing, checkpointing, buffer writeback, vacuum, replication, ...
```

| PostgreSQL concept | Role and boundary |
|---|---|
| Simple query protocol | Sends a query string as one protocol operation; do not equate “simple” with cheap execution |
| Extended query protocol | Separates parse, bind, optional describe, execute, and synchronization operations; enables parameters and prepared execution |
| Shared memory | Cross-process buffers, locks, and coordination state established by the server |
| Local memory/context | Backend-owned allocations grouped by lifetime so an error path can discard a whole context |
| Dynamic shared memory | Runtime-created cross-process regions used by features such as parallel query; not ordinary session-local memory |
| Resource owner | Tracks releasable resources across normal and error cleanup; complementary to allocation lifetime |
| System catalog and OID | Catalog rows describe database objects; object identifiers and dependency records support lookup and lifecycle operations |
| Relation and physical file identity | A logical relation is not a permanent pathname; physical relation identifiers can change during rewrite-like operations |
| Tablespace and storage fork | Tablespaces influence physical placement; a relation can have separate main, free-space, visibility, or initialization storage according to relation kind |

This indirection matters operationally. Code that treats an object identifier as
a forever-stable external ID, or a current relation filename as logical identity,
crosses an implementation boundary. Likewise, dynamic shared memory does not
turn PostgreSQL into a thread-per-query engine: cooperating processes still need
explicit shared representations and synchronization.

Core PostgreSQL tables are heap-organized. B-tree indexes store heap tuple
identifiers rather than full rows. MVCC updates generally create new tuple
versions; vacuum reclaims versions no longer visible to any relevant snapshot.
Same-page heap-only update optimizations and visibility maps reduce particular
index/heap work under conditions owned by later chapters. These are PostgreSQL
choices, not definitions of MVCC or a relational DBMS.

### A query walkthrough

Trace a parameterized point query:

```sql
SELECT account_id, status
FROM orders
WHERE order_id = $1;
```

1. The protocol/backend identifies a statement and parameters.
2. Parsing and semantic analysis resolve names/types against catalogs; rewrite
   expands relevant rules/views/policies.
3. The planner estimates rows and compares paths such as sequential or index
   scan, using statistics and parameter information.
4. The executor drives the chosen operators.
5. A B-tree index path descends cached/read pages and yields a heap identifier.
6. The heap page is fetched through the buffer manager; MVCC determines which
   tuple version is visible to the transaction snapshot.
7. Projection produces result fields and the protocol returns them.

A covering/index-only path may avoid heap data fetches only when the engine can
establish visibility from maintained metadata; this is product/state-dependent.
Prepared statements may use custom or generic plans depending on product logic
and execution history. `EXPLAIN ANALYZE` executes the query and adds
instrumentation, so its timing is evidence with overhead, not a transparent
production measurement.

Use this walkthrough to locate a problem:

```
wrong rows estimate? → statistics/planner
right plan, many page misses? → index/layout/buffer working set
page hit, transaction waits? → concurrency/lock conflict
fast execution, slow response? → queue/protocol/client
commit tail? → WAL/sync/device/replication
```

PostgreSQL-specific catalogs, file forks, tuple headers, optimizer search,
autovacuum, and access-method details belong in role-specific study and later
chapters. Verify all product behavior against the deployed major version and
configuration.

## 61.11 From Local Storage to Distributed State — Core

A local storage engine assumes one recovery authority over its files and memory.
Distribution removes that simplicity:

| Local concept | Distributed extension |
|---|---|
| Page/record identifier | Partition/shard key plus replica placement |
| WAL sequence | Per-replica log plus agreement/order protocol |
| Process crash | Partial failure: some nodes/links fail while others run |
| Local durable commit | Which replicas acknowledged, under which failure domains? |
| Lock/transaction | Coordination across shards; blocking/abort recovery |
| Checkpoint/backup | Consistent snapshot across changing replicas |
| One clock/ordering context | No shared memory or perfectly shared global time |

**Partitioning** decides where data and transactions live. Good keys distribute
load and co-locate operations that need atomicity; bad keys create hotspots or
cross-partition coordination.

**Replication** maintains multiple copies. Synchronous replication delays
acknowledgement until a specified replica condition; asynchronous replication
can acknowledge locally and catch up later, admitting a loss/staleness window.
Leader-based and leaderless designs make different ordering, failover, and repair
choices.

A **consistency model** specifies allowed observations—linearizable, sequential,
causal, session, eventual, or another contract. It is not inferred from the word
“replicated.” Quorum intersection (`R + W > N`) is insufficient by itself for
linearizability without a protocol that orders versions, handles incomplete and
concurrent writes, and reads the correct state.

**Consensus** lets participants agree on ordered decisions despite stated
failures under stated timing/liveness assumptions. It can replicate a log and
support leader terms/commit, but does not decide schema, partition key, client
idempotence, or every distributed transaction automatically.

Retries are ambiguous: a timeout does not prove the operation failed. Carry
stable request identities and define idempotence/deduplication. Fencing prevents
a delayed former leader from continuing to mutate an external resource.
Chapters 68–74 develop these boundaries.

---

## Worked choice and reference

## 61.12 Worked Choice: Exchange Event History — Core

Design a store for an immutable exchange-event history with these **illustrative
assumptions**, not universal market rates:

- sustained ingest `r = 100,000` records/s;
- encoded record `s = 96` bytes before indexes/metadata;
- primary access: append and replay by sequence range;
- secondary access: recent events by order ID;
- analytics scans a few fields over long intervals;
- acknowledgement requires a durable local prefix;
- seven days of online retention; later data moves to colder storage.

### Step 1: calculate the unavoidable data rate

```
payload rate = r × s
             = 100,000/s × 96 bytes
             = 9.6 MB/s        (decimal)

payload/day = 9.6 MB/s × 86,400 s
            = 829.44 GB/day
```

Seven payload days are about 5.81 TB before page slack, WAL, indexes, checksums,
replication, temporary compaction/COW space, and filesystem overhead. The first
design correction is capacity: a “small record” workload is a multi-terabyte
retention system.

If a secondary index adds `i` bytes per record and total write amplification is
`WA`, an initial bandwidth model is:

```
physical write rate ≈ r × (s + i) × WA
```

`WA` is measured/configuration-dependent. It must include compaction/page
rewrite and WAL as defined by the accounting boundary; do not mix logical data
and device-write metrics without labels.

### Step 2: choose representations by access

The authoritative sequence is append-only and range-replayed. A segmented log
with sparse sequence-to-offset metadata is simpler than forcing every event into
a mutable primary-key tree. Segment headers/footers, checksums, versioning, and a
commit/durable-prefix rule are required.

Order-ID lookup is a separate access path. Options:

- a B+tree/hash index updated per event;
- a buffered/LSM secondary index, accepting compaction/read amplification;
- an in-memory recent-window index rebuilt from the authoritative log, if older
  lookup latency and restart time meet requirements.

Analytics over selected fields favors columnar derived segments or a downstream
analytical replica. Making the ingestion record columnar in place could
complicate append/recovery and point reconstruction. One system can legitimately
use a row-like event log, a key index, and columnar derived data.

### Step 3: compare B+tree and LSM for the secondary index

The obvious claim “writes are high, therefore use an LSM” is incomplete.

| Question | B+tree consequence | LSM consequence |
|---|---|---|
| Keys mostly append/random? | Random IDs may split/touch scattered leaves | Memtable absorbs order; compaction later |
| Recent lookups dominate? | Hot upper/leaf pages may cache well | Memory/recent runs may answer cheaply |
| Range by ID needed? | Natural ordered leaves | Natural per-run order, merged across runs |
| Tail budget under maintenance? | Splits/checkpoint/writeback | Flush/compaction interference |
| Storage headroom | Page slack + indexes | Runs + obsolete versions + compaction workspace |
| Recovery | WAL + dirty-page recovery | WAL/memtable replay + manifest/run recovery |

Prototype both with the actual key distribution, retention deletes, cache budget,
device, compaction/checkpoint policy, and concurrent analytics. NVMe makes random
page I/O more viable than HDD folklore suggests, but does not eliminate page
splits, queueing, write amplification, or cache residency.

### Step 4: select I/O and durability

Buffered I/O may provide effective write coalescing and operational simplicity.
Direct I/O may give the engine tighter cache/writeback control if it can satisfy
alignment, buffer, and queue-depth requirements. `mmap` may suit read-only
segments but exposes page-fault placement and truncation/corruption behavior.
Benchmark end-to-end acknowledgement and replay, not only sequential bandwidth.

For durable-local acknowledgement:

1. encode a versioned/checksummed record;
2. append it to the current segment and/or WAL design;
3. synchronize the promised prefix according to batching policy;
4. advance a recoverable commit marker/metadata rule;
5. acknowledge only at the documented durable point.

Group synchronization trades acknowledgement delay for amortized barriers. A
power-failure/recovery test must demonstrate that scanning selects exactly a
valid prefix and rejects torn/corrupt suffix data.

### Step 5: make distribution a separate decision

If local-device loss must not lose acknowledged events, local durability is
insufficient. Add a replica acknowledgement condition and fencing/failover
protocol, then restate latency and availability during partition. Asynchronous
replication supports local latency with a loss window; synchronous replication
adds network/remote storage to the acknowledgement path. Chapter 71 defines the
consistency/replication choice and Chapter 74 the agreement mechanism.

### Step 6: success measures and rollback

Measure:

- acknowledgement p50/tail under sustained/bursty ingest;
- physical bytes written per logical byte;
- replay and point-lookup latency with cold/warm cache;
- compaction/checkpoint overlap tails;
- recovery time and valid-prefix correctness after injected interruption;
- disk-space high-water, including maintenance workspace;
- replica lag and acknowledged-loss behavior if distributed.

Keep segment/index format versioned and the reference replay path available.
Rollback must not require reading new files with an old binary unless
compatibility was designed and tested.

## 61.13 Comparison Checklist — Reference

### Workload

- [ ] Point, range, scan, aggregation, and latest-value access are quantified.
- [ ] Read/write/delete mix includes bursts, skew, hot keys, and concurrency.
- [ ] Working set, retained size, record/key size, and growth are calculated.
- [ ] Foreground tail and background maintenance budgets are separate.

### Storage

- [ ] Logical record identity is independent of raw address.
- [ ] Page/segment size, occupancy, checksum, version, and atomicity assumptions
  are explicit.
- [ ] Read/write/space amplification accounting boundaries are named.
- [ ] Buffer/page-cache/direct/`mmap` choice includes fault and memory accounting.
- [ ] Maintenance workspace and overload throttling are sized.

### Transactions and recovery

- [ ] Atomic unit, isolation level, and conflict behavior are stated.
- [ ] WAL or COW ordering and acknowledged durable point are explicit.
- [ ] Checkpoint/replay duration meets recovery objectives.
- [ ] Torn/corrupt writes and synchronization failures are tested.
- [ ] Visibility is not confused with durability.

### Distribution

- [ ] Partition key co-locates required transactions and avoids hotspots.
- [ ] Replica acknowledgement and tolerated failure domains are stated.
- [ ] Read consistency/staleness and failover behavior are stated.
- [ ] Retry identity, deduplication, fencing, and reconciliation exist.
- [ ] Product/version/configuration claims are verified against deployment.

## 61.14 Labels and Product Cautions — Reference

Keep claims in four categories:

| Label | Meaning |
|---|---|
| **Mechanism** | General storage idea: page, WAL ordering, MVCC, compaction |
| **Implementation** | One engine’s design: heap locator, clustered primary tree, process model |
| **Product/version** | Behavior/configuration in a named release |
| **Measured** | Result on named data, cache state, hardware, and maintenance load |

Avoid product generalization:

- PostgreSQL heap/MVCC/vacuum behavior does not define every row store.
- InnoDB-style clustered primary organization does not define every B+tree.
- One LSM product’s compaction or tombstone policy does not define LSM semantics.
- An embedded in-process engine and a network DBMS have different queueing and
  failure surfaces even if both use B+trees.
- Cloud-service durability/consistency names require current service,
  region/topology, and configuration documentation.

### Common traps

- Selecting a product before quantifying access and durability.
- Treating a successful buffered write as durable.
- Treating COW root publication as atomic without ordering and recovery metadata.
- Counting only logical payload while ignoring WAL, indexes, versions, and
  maintenance workspace.
- Calling wide-column data “columnar analytics.”
- Assuming NVMe makes layout/amplification irrelevant or preserves HDD ratios.
- Equating primary key, primary index, unique index, and clustered storage.
- Confusing latches with transaction locks or ACID consistency with distributed
  consistency.
- Assuming MVCC means reads never block or transactions never abort.
- Assuming replication implies linearizability or that quorum arithmetic alone
  proves it.
- Benchmarking warm point reads and extrapolating to cold recovery or compaction
  tails.

## Recall Card — Core

- Chapters 61–74 are optional storage/distributed specialization. The short
  bridge is 61 → 71 → 74.
- Workload precedes structure: access, mutation, size, correctness, latency,
  operations, distribution.
- DBMS layers are query processing, execution, transactions/access methods,
  buffering, recovery, and durable files.
- Pages provide I/O/cache/latch/recovery units; stable page/slot identifiers add
  relocation indirection.
- B+trees maintain ordered mutable pages; LSMs buffer into immutable sorted runs.
  Compare all amplification and maintenance.
- Row/column, memory/storage authority, execution model, and data model are
  independent axes.
- Page cache, private buffers, `mmap`, and direct I/O move control and costs; none
  defines durability.
- WAL requires log-before-data and an explicit durable commit point. COW requires
  ordered data/root publication and recovery rules.
- Transactions define isolation/conflict/atomicity; latches protect structures.
- Distribution adds partitions, replicas, ambiguous timeouts, consistency
  contracts, fencing, and agreement.

## Questions — Core

1. Trace a point query from parse through index, buffer manager, MVCC visibility,
   and result. Where can queueing, I/O, or contention enter?
2. Given page/header/key/reference sizes and occupancy, estimate B+tree fan-out.
   Why does fan-out not directly equal physical reads?
3. Compare B+tree and LSM choices for point reads, ranges, random updates,
   retention deletes, and maintenance tails.
4. When would row storage plus vectorized execution beat a column store, and when
   would columnar layout dominate?
5. Explain how an in-memory engine can be durable and how a storage-resident
   engine can still lose acknowledged writes.
6. Compare WAL and COW recovery. What ordering/commit metadata does each still
   need?
7. Distinguish a buffer latch, transaction lock, MVCC visibility check, and
   distributed lease/fencing token.
8. Why does `R + W > N` not by itself guarantee a linearizable replicated store?
9. Recalculate the exchange-history example after doubling retention and adding
   a 32-byte secondary entry with measured write amplification. Which capacity
   or bandwidth limit fails first?
10. Which readers should stop after this chapter, and what does the 61 → 71 → 74
    bridge add to an HFT systems interview?

## Code-Reading Puzzle — Core

```cpp
struct PageHeader {
    std::uint32_t magic;
    std::uint16_t version;
    std::uint16_t count;
    std::uint64_t committed_sequence;
};

void commit(PageHeader* mapped, std::uint64_t seq) {
    mapped->committed_sequence = seq;
    std::atomic_thread_fence(std::memory_order_release);
    acknowledge(seq);
}
```

Explain why this does not establish crash durability. Separate C++ memory
ordering from persistent ordering, page-cache writeback, device caches, torn
writes, checksum/commit-record coverage, and recovery selection. State what a
real contract must add before acknowledgement.

## Implementation Exercise — Core

Choose a storage design for one workload:

- exchange event history;
- reference-data service with point/range queries and rare updates;
- intraday analytical store scanning selected fields;
- replicated risk-limit state.

Produce:

1. workload and capacity arithmetic;
2. row/column and memory/storage-authority choices;
3. primary data organization plus every index;
4. page/cache/I/O policy;
5. B+tree/LSM/log/hybrid comparison with amplification;
6. transaction/isolation and WAL/COW acknowledged point;
7. background maintenance and overload policy;
8. recovery test and format/version rollback;
9. optional partition/replication/consistency extension.

Include one alternative rejected by evidence, not preference.

## Prerequisite for Chapter 62 — Core

Chapter 62 assumes you can define pages, keys, row identifiers, point/range
access, occupancy, and buffer hits/misses; estimate fan-out from page and entry
sizes; and explain why device/cache behavior and workload determine the value of
an ordered high-fan-out tree.
