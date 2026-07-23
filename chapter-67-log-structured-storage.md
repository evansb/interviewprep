# Chapter 67 — Log-Structured Storage

An LSM tree makes foreground writes cheap by postponing organization. A write is appended to a recovery log and inserted into memory; immutable sorted files are produced later. The postponed work does not disappear. Reads must reconcile several versions, and background compaction must rewrite data, remove obsolete versions, and preserve deletions correctly.

This chapter owns four ideas that are easy to repeat and hard to reason about precisely: **compaction, Bloom filters, tombstones, and amplification**. The goal is not to memorize that one compaction style is “fast.” It is to trace bytes and versions well enough to choose a design and explain its failure modes.

This is an optional-track chapter. Sections through §67.11 are the core. §67.12 is a skippable reference for specialized designs and named products.

---

## 67.1 The 90-Second Screen — Core

### Five facts

1. An LSM tree is a family of storage designs built from a mutable in-memory component and immutable, sorted on-disk runs. “LSM” does not specify one file format, memtable structure, or compaction policy.
2. A durable write usually reaches a **write-ahead log (WAL)** before it reaches the memtable. A full memtable is frozen and flushed as an **SSTable**. The precise acknowledgement point depends on the durability contract.
3. A point read searches newer state before older state. A range read performs a k-way merge and reconciles versions. Immutability helps concurrency, but it does not make all LSM reads inherently lock-free.
4. A delete appends a **tombstone**. Compaction may discard that tombstone only when no older value can become visible to any relevant reader, snapshot, replica, or recovery path.
5. Compaction trades among **read amplification**, **write amplification**, and **space amplification**. Report the numerator and denominator; a bare “10× write amplification” is not a portable fact.

### Two decisions

- Choose **leveled-like** organization when bounding overlapping runs and reclaiming space are worth more rewriting; choose **tiered-like** organization when reducing rewrite work is worth more runs, transient space, and less predictable large merges. These are tendencies, not universal rankings.
- Choose an LSM-shaped engine over a page-oriented B+ tree only after considering reads, scans, updates, value sizes, durability, cache, device behavior, and operational headroom. “Write-heavy” by itself is not a sufficient specification.

### One picture

```text
put/delete
    │
    ├── append WAL ── sync according to durability contract
    │
    └── insert active memtable
                 │ freeze
                 ▼
          immutable memtable
                 │ flush + install metadata
                 ▼
        immutable sorted runs (SSTables)
                 │
                 └── background compaction
                        merge, reconcile, rewrite, retire inputs

read: memtables → candidate SSTables → merge versions → newest visible result
```

If you can explain why the WAL segment cannot be retired before the flushed SSTable is safely installed, why a Bloom-filter “yes” is not proof, and why an old tombstone can still be live data, you have the core model.

---

## 67.2 Claim Labels: Architecture Is Not a Product Default

Storage discussions often mix a mathematical model, a product implementation, and a benchmark result. This chapter uses four labels:

- **[A] Architecture:** a property of the model or of a stated design.
- **[PV] Product/version/configuration:** behavior that must be checked against a named release and configuration.
- **[D] Derived:** arithmetic from assumptions shown in the chapter.
- **[M] Measured:** a result from a stated workload and measurement boundary.

For example:

- **[A]** SSTables are immutable after publication.
- **[PV]** a particular release uses a skip list as its default memtable.
- **[D]** a 64 MiB logical batch causing 608 MiB of physical writes has job-local write amplification of 9.5.
- **[M]** a production workload observed 7.2 storage reads per cache-miss lookup.

The label matters because two systems both called “LSM” may disagree on:

- whether one or many memtables accept concurrent writes;
- how commits group and sync the WAL;
- whether values live in SSTables or a separate value log;
- how runs are partitioned into files;
- whether compaction is leveled, tiered, hybrid, time-aware, FIFO, or disabled;
- how snapshots, transactions, range deletions, filters, and corruption are handled;
- whether sequence numbers are local, transactional, or supplied by a distributed layer.

The durable idea is a pipeline of **buffering → immutable sorted runs → merge/reconciliation**. Named options and defaults are reference material, not architecture.

---

## 67.3 The Write Path: WAL, Memtable, Flush, Install

### 67.3.1 A foreground write

A common single-node write path is:

1. Assign the operation an order: a sequence number, transaction timestamp, or equivalent version.
2. Append a record to the WAL.
3. Make the WAL durable to the degree promised by the API: per-operation sync, group commit, periodic sync, or no durable WAL.
4. Insert the version into the active memtable.
5. Acknowledge when the system’s visibility and durability contracts are satisfied.

The order of steps 2–4 can be pipelined internally, but the externally visible invariant is stronger than source-code order: **an acknowledged durable version must be recoverable after the failures covered by the contract**.

The memtable is an ordered, mutable in-memory structure. A skip list is common **[PV]**, but it is not part of the LSM definition. Trees, vectors for bulk loading, tries, and hash-based structures for restricted query patterns are possible. The required operations determine the choice:

- inserts and point lookups;
- ordered iteration for flush and range scans;
- accounting against a memory budget;
- concurrency compatible with the engine’s writer model.

The WAL and memtable have different jobs. The WAL is a recovery representation optimized for append and replay. The memtable is a queryable representation optimized for lookup and ordered iteration. Normal reads do not search the WAL.

### 67.3.2 Freezing without stopping the world

When the active memtable reaches a chosen condition—often bytes, sometimes entries or time—the engine:

1. marks it immutable;
2. installs a fresh active memtable;
3. queues the immutable memtable for flush.

Reads may need to search the new active memtable and one or more immutable memtables. If flush cannot keep up, immutables accumulate. A bounded engine eventually delays or stalls writes rather than allowing memory use to grow without limit.

This is the first form of **compaction debt** in the broad sense: foreground ingest has created organization work that background workers have not yet completed. Later, excess overlapping SSTables create the more familiar on-disk debt.

### 67.3.3 Flush is a small commit protocol

A correct flush is not merely “write a file.” A simplified sequence is:

```text
immutable memtable
    │
    ├── stream sorted records into temporary SSTable
    ├── build index/filter/metadata and checksums
    ├── close and make required bytes durable
    ├── atomically publish new table in manifest/version metadata
    └── only then retire WAL coverage no longer needed
```

Publication is the key transition. Before it, recovery must be able to replay the relevant WAL. After it, the installed SSTable represents those versions. Deleting the WAL too early can lose acknowledged writes; publishing a partial output can make corrupt bytes authoritative.

Real systems differ in how they implement the metadata transaction—manifest records, version sets, journals, atomic renames, directory synchronization, or a combination **[PV]**. The architectural invariant is:

> At every crash point, recovery can choose a complete old state or a complete new state; it must not require an unpublished partial output.

WAL recycling also has more constraints than “the memtable was flushed.” A segment may contain records for multiple memtables or column families, and replication or backup may pin it **[PV]**.

### 67.3.4 What “sequential writes” does and does not mean

The write path batches small logical updates into WAL appends and large file creation. That often produces friendlier device I/O than scattered page updates. But the slogan needs qualifications:

- a WAL sync still has latency;
- compaction later reads and rewrites data;
- filesystems, encryption, checksums, compression, and device firmware transform I/O;
- an SSD’s flash translation layer may perform its own garbage collection;
- concurrent compactions can make the physical stream nonsequential;
- database and device write amplification multiply rather than cancel.

An LSM does not eliminate random access or rewriting. It moves much of that work off the foreground write path and changes its granularity.

---

## 67.4 SSTables: Immutable Sorted Runs

An **SSTable** is an immutable sorted run. “Sorted String Table” is historical terminology; keys and values can be arbitrary byte strings or typed encodings.

A representative block-based layout is:

```text
┌────────────────────────────────────────────┐
│ data blocks: sorted internal keys/values   │
├────────────────────────────────────────────┤
│ sparse block index: key boundary → handle  │
├────────────────────────────────────────────┤
│ optional Bloom/prefix filters              │
├────────────────────────────────────────────┤
│ properties, checksums, compression info    │
├────────────────────────────────────────────┤
│ footer: metadata handles and format marker │
└────────────────────────────────────────────┘
```

The exact layout is **[PV]**. Some formats partition indexes and filters; some store metadata in companion files; some separate large values. The recurring ideas are:

- **Sorted data.** Equality lookup can locate the candidate block through a sparse index. Range scans can start near a lower bound and continue in order.
- **Block granularity.** Compression and checksums are usually block-oriented. A lookup may read more bytes than the value because the block is the I/O and cache unit.
- **Sparse/skip index.** It records boundaries or restart/skip points rather than every uncompressed key. Indexes may be cached, partitioned, or multi-level.
- **Filter.** It can reject many files or blocks that definitely do not contain a queried key.
- **Immutability.** Readers can retain a reference to a published file while compaction creates a replacement. Retirement is deferred until no reader needs the old version.

The sort key is often an **internal key**, conceptually:

```text
(user_key ascending, sequence/version descending, record_type)
```

That ordering places versions of one user key together, newest first. The exact encoding and conflict order are product semantics **[PV]**. In a transactional engine, “newest” must also respect snapshot visibility; it cannot simply mean the largest wall-clock timestamp.

### File, run, and level are not synonyms

A **file** is a physical object. A **sorted run** is a logical sequence with no duplicate user-key ordering ambiguity inside it. A run can be range-partitioned across several files. A **level** is a position in a compaction policy and may contain one run or several runs.

Confusing these terms causes bad read-amplification estimates. Ten files forming one nonoverlapping run do not imply ten candidate files for one point key. Conversely, two overlapping runs may require two probes even if each run is stored in one file.

---

## 67.5 The Read Path: Point Lookups, Scans, and Reconciliation

### 67.5.1 Point lookup

A conceptual point read for key `k` does this:

1. Search the active memtable.
2. Search immutable memtables from newest to oldest.
3. Select on-disk runs whose key range might contain `k`.
4. Use applicable filters to reject candidates.
5. Search indexes and data blocks for remaining candidates.
6. Reconcile versions according to snapshot and deletion semantics.

Some engines probe serially newest-to-oldest and stop when the answer is determined. Others issue reads in parallel or consult metadata that narrows the search **[PV]**. Caches can satisfy index, filter, or data-block accesses.

A hit and a miss have different cost shapes. A recent hit may be in the memtable. A negative lookup may test filters across every run. An old hit may reach the bottom run. Therefore “read amplification” must say which population is measured:

- hit or miss;
- cache hit or storage access;
- point lookup or range;
- hot or uniform keys;
- snapshot or latest read.

### 67.5.2 Range read is a k-way merge

For a range `[lo, hi)`, each overlapping memtable or run contributes an iterator. A min-heap holds the next internal key from each iterator:

```text
run A: a@9  c@4  f@8 ...
run B: a@3  b@7  e@6 ...
run C: b@2  d@5  g@1 ...
         \     |     /
       heap ordered by user key, then version
```

Repeatedly:

1. pop the smallest internal key;
2. advance that iterator and restore the heap;
3. collect adjacent versions of the same user key;
4. emit the newest version visible to the read, unless it is a deletion.

For `N` input records across `k` iterators, the elementary heap model costs `O(N log k)` comparisons and `O(k)` iterator state. Implementations optimize common cases with loser trees, merging iterators, block prefetch, or specialized two-way paths **[PV]**. The important property is that merging is streaming; the entire input need not fit in memory.

Bloom filters generally cannot prove that an arbitrary range is empty unless the engine built a filter matching that query domain, such as an applicable prefix filter. Sparse indexes, file boundaries, and zone maps can still prune ranges.

### 67.5.3 “Newest wins” is incomplete

Suppose the merge sees:

```text
k @ sequence 91 : DELETE
k @ sequence 77 : "blue"
k @ sequence 40 : "green"
```

For a latest read after sequence 91, `k` is absent. A snapshot at sequence 80 may still see `"blue"`. Compaction must preserve whichever versions can be observed by a supported snapshot.

The reconciliation rule therefore is:

> Choose the newest version that is visible under the read’s snapshot and transaction semantics; a visible deletion suppresses older values.

Distributed last-write-wins timestamps, single-node sequence numbers, and transactional commit order are not interchangeable. Clock skew can affect a timestamp-based product; it does not affect a local monotonic sequence in the same way **[PV]**.

### 67.5.4 Immutability is not a lock-freedom proof

Published SSTable bytes do not change, which simplifies readers. Yet an LSM read may still:

- acquire or retry around memtable state;
- pin a version/manifest view;
- synchronize in block caches and file tables;
- wait for I/O, decompression, or encryption;
- participate in epoch, reference-count, or hazard-pointer reclamation;
- wait behind transaction locks or distributed consistency work.

“This reader traverses immutable files” is an architectural observation. “Reads are lock-free” is an implementation claim requiring a progress proof for the whole read path.

---

## 67.6 Bloom Filters: Spend Memory to Avoid Negative I/O

A Bloom filter represents a set approximately. Insert a key by setting `k` bit positions in an `m`-bit array. Query the same positions:

- if any bit is zero, the key is **definitely not in the represented set**;
- if every bit is one, the key **may be present**.

The first statement assumes the mathematical filter was built over the same key domain, published correctly, queried with the same transformation, and not corrupted. Those engineering conditions are why “Bloom filters never have false negatives” should not be turned into “the storage system can never skip a real key.”

### 67.6.1 False-positive derivation

Let:

- `m` = number of bits;
- `n` = inserted keys;
- `k` = hash positions per key;
- `b = m/n` = bits per key.

Under the standard independence approximation, after `n` insertions the probability a bit remains zero is approximately `e^(-kn/m)`. The approximate false-positive probability is:

```text
p ≈ (1 - e^(-kn/m))^k
  = (1 - e^(-k/b))^k
```

The real-valued optimum is `k ≈ b ln 2`; an implementation chooses a nearby supported integer. At that optimum:

```text
p_min ≈ (0.6185)^b
```

Derived examples:

| Bits per key `b` | Rounded `k` | Approximate `p` |
|---:|---:|---:|
| 6 | 4 | 5.61% |
| 10 | 7 | 0.82% |
| 14 | 10 | 0.12% |

These are **[D]**, not promises from a product. Hash quality, key count estimation, filter construction, cache residency, partitioning, and implementation caps change measured behavior.

### 67.6.2 A validated calculator

This compact C++23 program calculates the table and verifies the compaction example in §67.9:

```cpp
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>

double bloom_fp(double bits_per_key) {
    const auto hashes = std::round(bits_per_key * std::log(2.0));
    return std::pow(1.0 - std::exp(-hashes / bits_per_key), hashes);
}

struct Job {
    std::uint64_t logical, wal, flush, compact_output;
    constexpr std::uint64_t writes() const {
        return wal + flush + compact_output;
    }
    constexpr double write_amp() const {
        return static_cast<double>(writes()) / static_cast<double>(logical);
    }
};

int main() {
    constexpr Job reclaimed{64, 64, 64, 480}; // MiB
    static_assert(reclaimed.writes() == 608);
    assert(std::abs(reclaimed.write_amp() - 9.5) < 1e-12);

    for (double b : {6.0, 10.0, 14.0})
        std::cout << std::fixed << std::setprecision(3)
                  << b << " bits/key: " << 100 * bloom_fp(b) << "%\n";
}
```

One conforming run prints:

```text
6.000 bits/key: 5.606%
10.000 bits/key: 0.819%
14.000 bits/key: 0.120%
```

Compile with:

```bash
c++ -std=c++23 -O2 -Wall -Wextra -Wpedantic bloom.cpp && ./a.out
```

### 67.6.3 Filters are a budget, not a checkbox

For `n` keys and `b` bits per key, the uncompressed bit array costs `nb/8` bytes, before metadata. Ten bits for one billion keys is about 1.25 GB **[D]**. That memory competes with data blocks, indexes, memtables, and the operating-system cache.

Filter placement also matters:

- **per-file versus per-block or partitioned filters;**
- **whole-key versus prefix filtering;**
- filters resident in memory versus read on demand;
- equal bits per key versus more bits where negative probes are expensive;
- bottom-run filters versus relying on the fact that many successful reads end there.

Measure useful negatives and observed false positives. A Bloom filter can report a beautiful theoretical false-positive rate yet save little I/O if most lookups are hits, filters miss the cache, or range scans dominate.

Bloom filters do not remove read amplification. They convert many candidate probes—especially negative point probes—into cheaper memory tests.

---

## 67.7 Compaction: Merge, Reconcile, Publish, Retire

Compaction selects sorted runs, merges them, removes data that is provably obsolete, emits new runs, publishes a new metadata view, and eventually retires the inputs.

```text
inputs selected under policy
       │
       ├── sequential/streaming merge
       ├── apply snapshot and tombstone rules
       ├── produce checked temporary outputs
       ├── install one new metadata version
       └── retire inputs after old readers release them
```

It serves several goals:

- reduce the number of runs a read may consult;
- enforce a chosen run/level shape;
- reclaim overwritten values and safe tombstones;
- rewrite data into current compression or format;
- keep foreground writes from accumulating unbounded debt.

Compaction is not logically identical to “remove duplicates.” It is a metadata transaction plus garbage collection under visibility constraints.

### 67.7.1 Leveled-like organization

In a classic leveled model, each disk level is one logical sorted run, often range-partitioned into files. Adjacent levels grow geometrically. New flush files may first collect in an overlapping level zero; lower levels maintain nonoverlapping key ranges within each level.

```text
L0: [a..f] [c..m] [h..z]       overlapping flush runs
L1: [a..d][e..k][l..q][r..z]   one partitioned run
L2: [a........m][n........z]    larger partitioned run
```

A compaction from `Li` selects data and overlapping key ranges from `Li+1`, merges them, and replaces that slice. Consequences under the model:

- one key maps to at most one file in each nonoverlapping run;
- old versions are reconciled relatively promptly;
- the destination slice can be rewritten repeatedly as new data arrives;
- level-zero overlap can dominate tail latency when debt grows.

Fanout, file selection, dynamic level sizes, trivial moves, subcompactions, compression by level, and whether L0 is compacted wholesale are **[PV]**. Even the name is product-specific: RocksDB documentation describes its “Level” style as tiered+leveled because memtables and L0 can contain multiple runs.

Leveled organization commonly buys lower read and space amplification by paying more write amplification, but key-order inserts, skewed updates, nonoverlapping moves, and a working set captured above the bottom can reverse a simplistic ranking.

### 67.7.2 Tiered-like organization

A tiered model allows several runs of a size class to coexist, then merges runs—often of similar sizes—into a larger run:

```text
64 MiB + 64 MiB + 64 MiB + 64 MiB
                 │
                 └── merge → approximately 256 MiB
```

Unlike a leveled merge, this idealized merge need not rewrite an existing destination run. That lowers per-level rewrite work. The costs are:

- more overlapping runs for reads and scans;
- more obsolete versions waiting for a merge;
- input plus output space during compaction;
- increasingly large, long-running top-tier merges;
- less convenient partial rewriting under skew.

“Size-tiered,” “universal,” and “tiered” are related labels, not guaranteed synonyms. RocksDB calls its tiered family “Universal”; Cassandra exposes named strategies with their own bucketing, tombstone, repair, and time-window behavior **[PV]**.

### 67.7.3 Hybrids and workload-aware policies

Practical policies occupy a continuum:

- tiered upper levels with a leveled bottom;
- several runs per level (“leveled-N”);
- time-window grouping for append-mostly TTL data;
- FIFO deletion for cache-like data whose oldest files may simply expire;
- manual or workload-aware compaction.

Time windows do not magically solve deletion. They work best when writes obey the time partitioning assumption and an entire closed window can become irrelevant together. Late writes, updates across windows, snapshots, and repair can defeat the simple “drop a file” story **[PV]**.

### 67.7.4 Scheduling and debt

Policy chooses *what* to merge; scheduling chooses *when and with what resources*. A system needs budgets for:

- compaction read and write bandwidth;
- number and size of concurrent jobs;
- CPU for decompression, merge, checksum, and recompression;
- memory for input buffers and output builders;
- foreground latency interference;
- free space for outputs before inputs can be deleted.

If ingest creates compaction work faster than workers discharge it, pending bytes and overlapping runs grow. Eventually the engine must throttle or stall writes. A write stall is therefore not an arbitrary defect; it is the bounded-system response to debt that would otherwise consume all memory, disk, or read latency.

A dangerous operational pattern is to maximize benchmark ingest with compaction disabled, then declare victory before debt is repaid. A valid steady-state benchmark runs long enough for level sizes, compaction throughput, and free space to stabilize—or explicitly reports that it measured a burst.

---

## 67.8 Tombstones: Deletion Is Information

An immutable run cannot erase an older value in place. A delete therefore appends a version whose payload means “absent”:

```text
newer                                    older
k@90 DELETE  ──────────────────────────► k@12 "value"
```

Until the engine proves the older value cannot be observed, the tombstone is live information. Dropping it too early causes **resurrection**.

### 67.8.1 The local resurrection puzzle

Assume:

```text
L1 contains k@90 DELETE
L3 contains k@12 "value"
```

A compaction rewrites L1 without including the overlapping L3 range and discards the tombstone because “deletes do not return data.” A later read finds no version in L1, continues to L3, and returns `"value"`. The deleted record has resurrected.

Safe collection requires a proof appropriate to the design, such as:

- the compaction covers all older data for that user key or range; or
- metadata proves no lower run can contain an older version; and
- no supported snapshot still needs an older version; and
- no recovery, replica, backup, or repair process can reintroduce an older version.

“The tombstone reached the bottommost level” is a useful shorthand only if “bottommost” is defined for that key range and the other visibility constraints are satisfied.

### 67.8.2 Point, range, and expiry tombstones

A **point tombstone** deletes one key. A **range tombstone** covers an interval and complicates merge logic: it must suppress covered older keys while coexisting with newer inserts inside the range. A TTL expiry is semantically a deletion even if the stored representation is an expiry time rather than an immediately materialized tombstone.

Large deletion workloads can temporarily increase space:

1. deleting adds records;
2. tombstones and old values coexist;
3. compaction rewrites overlapping live data;
4. only a safety proof permits reclamation.

Thus “we deleted half the keys” can be followed by more disk use and higher read cost before compaction catches up.

### 67.8.3 Distributed retention is product semantics

In a replicated database, an offline replica may still hold the old value. If every healthy replica forgets the deletion before repair reaches the stale replica, that replica can return the value to the system. Retention must therefore account for repair, anti-entropy, clocks, consistency, and failure duration.

Cassandra’s tombstone and grace behavior is especially configuration- and version-sensitive **[PV]**. Do not copy a numeric grace period as an LSM law. State the Cassandra version, table options, repair regime, transient-replication behavior if applicable, and the failure assumption being protected.

### 67.8.4 Tombstones are an operational signal

Useful measurements include:

- tombstones created and scanned;
- age distribution of retained tombstones;
- expired data awaiting reclamation;
- range-tombstone coverage;
- snapshots or replicas pinning old versions;
- compaction bytes spent reclaiming deletions;
- resurrection-safety horizon under the current repair policy.

The correct goal is not “minimize tombstones.” It is “retain deletion information exactly as long as correctness requires, then reclaim it efficiently.”

---

## 67.9 Amplification: Define the Boundary, Then Do the Arithmetic

Amplification is a ratio. Every report needs a numerator, denominator, interval, and scope.

### 67.9.1 Write amplification

One useful storage-engine definition is:

```text
WA = physical bytes written by the engine
     ------------------------------------
     logical user bytes accepted
```

But the numerator may or may not include WAL, initial flush, compaction, manifest writes, replication, backups, filesystem copy-on-write, and device-internal NAND writes. Compression can even make some byte ratios less than an uncompressed logical denominator. Label the boundary.

### 67.9.2 Read amplification

Possible definitions include:

```text
storage blocks read / logical operation
candidate runs consulted / logical operation
physical bytes read / logical result bytes
```

Report hit/miss mix, point/range mix, cache state, and whether filter/index reads count. A range returning 100 MiB should not be judged by the same denominator as a 20-byte point result.

### 67.9.3 Space amplification

A common definition is:

```text
SA = physical storage occupied
     -------------------------
     live logical data size
```

Clarify whether the numerator includes WAL, temporary compaction outputs, snapshots, replicas, backups, metadata, and reserved free space. Some literature instead reports “extra space” as `(physical - live) / live`; under that convention 1.2× in the first definition becomes 20%. Name the convention.

### 67.9.4 Worked compaction job

Consider one **illustrative**, deliberately local job **[D]**:

- new logical batch: 64 MiB;
- WAL written: 64 MiB;
- initial SSTable flush: 64 MiB;
- the run overlaps 576 MiB in a lower level;
- compaction reads `64 + 576 = 640 MiB`;
- after removing overwritten or deleted versions, output is 480 MiB.

For the 64 MiB batch, charging the entire job to that trigger:

```text
engine writes = WAL + flush + compaction output
              = 64 + 64 + 480
              = 608 MiB

job-local WA = 608 / 64 = 9.5

compaction reads  = 640 MiB
compaction writes = 480 MiB
input reclaimed   = 640 - 480 = 160 MiB
```

If nothing were obsolete, output would be 640 MiB and the same accounting would give `(64 + 64 + 640) / 64 = 12`. This does **not** prove the database has steady-state WA 9.5 or 12. The lower-level bytes may be charged across a time interval or many triggering writes. The example teaches how to state an accounting boundary.

Now compare an idealized tiered merge of four new 64 MiB runs:

```text
logical input represented = 256 MiB
compaction reads          = 256 MiB
compaction output         = 256 MiB, before garbage removal
compaction-only WA        = 256 / 256 = 1
```

That lower job-local rewrite cost buys four overlapping runs before the merge, plus transient space for 256 MiB of inputs and about 256 MiB of output. It also says nothing about a later top-tier merge.

### 67.9.5 Turning amplification into a capacity decision

Suppose measurement—not a rule of thumb—shows:

- logical ingest `U = 100 MiB/s`;
- engine WA including WAL `A_w = 9.5`;
- compaction reads attributable to ingest `A_r = 8.0` bytes per user byte.

Then steady-state storage traffic implied by that measurement is:

```text
engine writes = U × A_w = 950 MiB/s
compaction-related reads = U × A_r = 800 MiB/s
```

This is already about 1.71 GiB/s of aggregate read/write traffic before foreground reads, backups, replication, and device-level amplification. Provisioning exactly 950 MiB/s of advertised write bandwidth is unsafe: latency, concurrency, garbage collection, and headroom matter.

If the device’s measured sustainable budget under the intended queueing and latency target is lower, the choices are explicit:

- reduce ingest;
- reduce measured WA by changing run shape, value placement, or workload locality;
- add devices or compaction workers if the bottleneck scales;
- relax foreground latency or read/space goals;
- change compression, acknowledging the CPU and byte effects;
- buffer a burst, while proving the debt can be repaid.

### 67.9.6 RUM as a compass, not a calculator

The RUM trade-off—Read, Update, Memory—captures why no access method minimizes all overheads for every workload. Bloom filters spend memory to reduce negative-read work. Leveled compaction spends update bandwidth to reduce runs and obsolete space. Tiering saves rewrite work while retaining more runs and temporary space.

RUM does not supply a configuration or predict a benchmark. Use it to ask which resource pays, then calculate with the workload.

---

## 67.10 Choosing LSM Shape, B+ Tree, or a Hybrid

Avoid this table:

```text
LSM = fast writes, slow reads
B+ tree = slow writes, fast reads
```

Both sides buffer, cache, log, batch, compress, and run background maintenance. Instead, ask:

| Question | Pressure toward an LSM-shaped design | Pressure toward a page/B+ tree design |
|---|---|---|
| Write pattern | sustained ingest benefits from batch/append | localized updates benefit from stable pages |
| Point misses | enough RAM for effective filters | one index traversal is already bounded |
| Range scans | merge fan-in and duplicate versions are controlled | physical/key locality and stable leaf links help |
| Update skew | compaction can focus on hot ranges | hot pages remain cached and update in place |
| Values | small values tolerate rewriting; or separation is available | large values can be updated without rewriting unrelated ranges |
| Space | compaction headroom is affordable | page fragmentation and MVCC garbage are affordable |
| Durability | WAL/group commit fits the contract | WAL/page recovery fits the contract |
| Operations | stalls and debt are observable/manageable | checkpoints, vacuum, splits, and page bloat are observable/manageable |

These are questions, not automatic votes. For example, update skew can help a some-to-some leveled LSM avoid rewriting cold ranges; it can also help a B+ tree keep hot leaves resident.

### 67.10.1 PostgreSQL WAL does not make PostgreSQL an LSM

PostgreSQL’s WAL records changes before corresponding data-file changes become durable, allowing recovery to redo them. The WAL is sequential recovery state; normal queries read heap and index structures, not WAL records. PostgreSQL therefore demonstrates that **log-structured recovery and log-structured primary storage are independent choices**.

PostgreSQL MVCC also creates multiple row versions and later reclaims dead tuples through vacuum. That resembles LSM version cleanup at a high level, but the structures and rules differ:

- PostgreSQL versions reside in heap pages and indexes reference tuples;
- an LSM orders versions inside immutable runs;
- vacuum and compaction choose different physical units and have different concurrency/failure protocols;
- both must respect snapshot visibility before reclamation.

The useful comparison is “both are visibility-aware garbage collectors,” not “compaction is just VACUUM.”

### 67.10.2 A defensible selection statement

A strong design answer sounds like:

> The workload ingests 100 MiB/s, mostly inserts, with 95% recent-key point reads, short scans, and 30% storage headroom. I would prototype an LSM with filters and a hybrid/tiered upper shape, then measure steady-state compaction bandwidth, P99 read latency, and debt recovery after a burst. If large range scans or space headroom fail the target, I would test a more leveled shape or a page-oriented index. The choice remains conditional on the engine version and device.

It exposes assumptions, metrics, and a fallback. “LSM because writes” does not.

---

## 67.11 Failure and Operations

An LSM engine is healthy only if it can preserve the version graph and continuously repay deferred work.

### 67.11.1 Crash cases to test

| Crash point | Required recovery property |
|---|---|
| WAL record partly written | detect/truncate invalid tail; do not invent a committed write |
| WAL durable, memtable update absent | replay reconstructs the version |
| memtable updated, acknowledgement not sent | duplicate retry is resolved by API/transaction semantics |
| SSTable output partly written | unpublished output is ignored or safely removed |
| output complete, metadata not installed | old input set remains authoritative |
| metadata installed, inputs still present | new view is authoritative; old files await safe retirement |
| inputs unlinked, old reader active | reader’s file/reference lifetime remains valid |
| disk full during compaction | old state remains readable; engine applies bounded back-pressure |

Checksums detect corruption; they do not define whether to fail, retry another copy, quarantine a file, or return partial data. That is policy **[PV]**.

### 67.11.2 Metadata and file lifetime

Readers commonly pin an immutable metadata version describing the live file set. Compaction publishes a new version atomically, while existing readers finish on the old version. Input files can be unlinked or recycled only when no live metadata view, snapshot, backup, or iterator needs them.

This is the same general pattern used by copy-on-write structures:

```text
build new objects → publish one root/version → reclaim old objects later
```

Failure safety depends on the publication boundary; concurrency safety depends on deferred reclamation.

### 67.11.3 Metrics that reveal the real bottleneck

At minimum, observe:

- accepted logical bytes and operations;
- WAL bytes, sync latency, group size, and unsynced exposure;
- active/immutable memtable bytes and flush latency;
- run/file counts by level or tier;
- pending compaction bytes and oldest debt age;
- compaction input/output/reclaimed bytes and CPU time;
- write stall/throttle duration and cause;
- point hit/miss latency split by cache state;
- files/blocks/bytes consulted per read;
- filter queries, useful negatives, and measured false positives;
- live data, obsolete bytes, temporary output, snapshots, and free disk;
- tombstone count/age and versions pinned by snapshots or replicas;
- checksum failures, recovery duration, and orphan cleanup.

Calculate WA, RA, and SA from these counters at the boundary you care about. Configuration names are not measurements.

### 67.11.4 Failure drills

A production readiness test should include:

1. crash during WAL append;
2. kill during flush publication;
3. kill during compaction publication;
4. restart with a corrupt or truncated final block;
5. exhaust free space during a large compaction;
6. hold a long snapshot while updates and deletes accumulate;
7. burst ingest above compaction capacity, then measure debt-repayment time;
8. in a replicated product, keep a replica offline beyond the assumed repair window and verify deletion behavior.

The last drill is product-specific and may be destructive; perform it in an isolated environment with the exact supported procedure.

### 67.11.5 Common operational diagnoses

**Writes stall while the device is not at advertised bandwidth.** Check latency-sensitive queue depth, L0 overlap, immutable memtables, CPU compression, per-job serialization, and free-space constraints. Peak bandwidth is not sustainable compaction capacity.

**Negative reads suddenly slow down.** Check run count, filter cache residency, filter compatibility with the query type, observed false-positive rate, and whether compaction debt expanded the candidate set.

**Disk grows after a bulk delete.** Check tombstone retention, long snapshots, replication/repair pins, compaction scheduling, and temporary output headroom. Deletion initially adds information.

**A compaction strategy looks superior in a short benchmark.** Repeat through steady state, force or await debt repayment, include cache warm/cold phases, and report final space. Deferred work can disguise cost.

---

## 67.12 Skippable Reference: Variants and Product Names

Skip this section on a first pass. It is useful for recognizing design points, not for memorizing defaults.

### 67.12.1 Bitcask

Bitcask is a log-structured key-value design with append-only data files and an in-memory hash index mapping each key to its newest record location. It provides a useful contrast:

- excellent point lookup when the full key directory fits memory;
- append-friendly writes;
- merge/cleanup needed to reclaim older records;
- no inherent sorted order for range scans.

It is log-structured storage, but not the canonical “sorted runs plus merge iteration” LSM shape.

### 67.12.2 WiscKey and key-value separation

WiscKey is a research design that stores keys and references in the LSM while placing values in a separate append-only value log. Compaction rewrites small keys rather than large values, reducing byte write amplification when values dominate.

The bill moves elsewhere:

- a point read may need an extra value-log access;
- range scans can turn into scattered value reads;
- the value log needs garbage collection;
- crash consistency must coordinate references and values;
- stale-value accounting depends on the workload.

Key-value separation is therefore another RUM move, not a free optimization. Product implementations inspired by it have their own caching, GC, and recovery semantics **[PV]**.

### 67.12.3 FTL and log-on-log stacking

An SSD already maps logical writes onto flash through a flash translation layer (FTL) and performs garbage collection. An LSM above a copy-on-write filesystem above an FTL can create **log-on-log stacking**:

```text
LSM compaction rewrites logical files
        × filesystem copy-on-write/metadata work
        × FTL relocation and erase-block garbage collection
        = device NAND writes
```

The factors are not perfectly independent, but the multiplication is a good warning. Measure host bytes and device/NAND bytes separately when the hardware exposes them.

Zoned storage can expose placement constraints so the host writes zones sequentially and resets them explicitly. That may reduce hidden FTL work, but pushes allocation, cleaning, zone lifetime, and recovery obligations upward. “ZNS removes garbage collection” is false; it changes who performs it.

### 67.12.4 Named compaction taxonomies

RocksDB’s documentation distinguishes classic leveled, tiered, tiered+leveled, leveled-N, and FIFO models. Its product names include **Level**, **Universal**, and **FIFO**; Universal is in the tiered family, while Level includes a tiered L0 above leveled lower levels **[PV]**.

Cassandra’s strategy names and tombstone behavior belong to Cassandra’s data model, repair process, release, and table configuration **[PV]**. HBase, Pebble, LevelDB, and cloud services make different choices. Translate the product name back into:

- how many sorted runs may coexist;
- whether ranges overlap;
- which inputs a job rewrites;
- when versions and tombstones become safe to drop;
- what bounds trigger stalls or require headroom.

Those questions travel across products.

### 67.12.5 Primary references

- O’Neil et al., [*The Log-Structured Merge-Tree (LSM-Tree)*](https://www.cs.umb.edu/~poneil/lsmtree.pdf), 1996.
- RocksDB, [Compaction taxonomy and product mapping](https://github.com/facebook/rocksdb/wiki/Compaction).
- RocksDB, [Bloom-filter implementation notes](https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter).
- PostgreSQL, [Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html).
- PostgreSQL, [MVCC introduction](https://www.postgresql.org/docs/current/mvcc-intro.html).

Treat current documentation as versioned product evidence, not as a universal LSM specification.

---

## 67.13 Worked Design Review

You are choosing storage for this workload:

```text
live data              2 TiB
logical ingest         80 MiB/s average, 240 MiB/s for 20-minute bursts
records                1 KiB median, 16 KiB P99
reads                  70% point, 20% short range, 10% long analytical range
point-read population  60% recent hits, 25% old hits, 15% misses
updates/deletes        20% of writes
snapshot lifetime      normally <5 min, maximum 2 h
free-space budget      35%
durability             acknowledged writes survive host power loss
```

### Step 1: reject premature conclusions

The workload is not merely “write-heavy.” Long scans, old hits, deletes, two-hour snapshots, and tight space all influence the result. A pure tiered shape may save rewrite bandwidth but violate scan and space targets; an aggressively leveled shape may exceed compaction bandwidth during bursts.

### Step 2: state an initial hypothesis

A reasonable experiment is a hybrid:

- WAL with group commit whose measured loss window is zero under the required host-power model;
- ordered memtables and enough immutable capacity to absorb short flush jitter;
- filters sized from the miss population and memory budget;
- tiered/overlapping upper runs to absorb bursts;
- a leveled or bounded-run lower shape for old-hit, scan, and space behavior;
- compaction admission control reserving latency budget for foreground reads.

This is not yet a decision. It is a testable configuration class.

### Step 3: calculate burst debt

The burst adds:

```text
(240 - 80) MiB/s × 20 min × 60 s/min
= 192,000 MiB
≈ 187.5 GiB
```

If measured background capacity at acceptable foreground latency can organize only the average 80 MiB/s, debt never shrinks. Suppose it can sustain the work generated by 120 MiB/s after the burst. The spare logical-equivalent rate is `120 - 80 = 40 MiB/s`, so ideal debt repayment takes:

```text
192,000 MiB / 40 MiB/s = 4,800 s = 80 min
```

That estimate assumes amplification remains stable while debt is high. Test it; extra L0 overlap and large jobs may change the ratio.

### Step 4: test space at the worst moment

Thirty-five percent of 2 TiB is about 716.8 GiB **[D]**. That budget must cover obsolete versions, tombstones, WAL, snapshots, temporary compaction output, and the 187.5 GiB burst. A top-tier all-to-all merge could exceed it even if steady-state SA looks acceptable. Bound job size or choose a policy that can compact partitions independently.

### Step 5: define acceptance evidence

Run beyond steady state, inject the burst, and require:

- no correctness loss under power-failure simulation;
- foreground P99 within target during and after the burst;
- debt returns to baseline within the planned 80-minute order of magnitude;
- peak occupied disk remains below the safety threshold;
- two-hour snapshots do not cause unbounded version/tombstone retention;
- point miss and old-hit block reads remain within measured budgets;
- long scans meet throughput without starving compaction.

The winner may be LSM, B+ tree, or a split architecture—for example, an ingest store plus an analytical representation. The review succeeds when the evidence selects the design, not when an LSM slogan does.

---

## 67.14 Recall Card

```text
LSM CORE
  foreground: WAL → memtable → acknowledge per durability contract
  background: freeze → flush SSTable → publish metadata → retire WAL coverage
  read: search new to old; merge sorted iterators; newest visible version wins

SSTABLE
  immutable sorted run; block data + sparse index + optional filter + checksums
  file ≠ run ≠ level

BLOOM
  negative = definitely absent under correct construction/query
  positive = maybe present
  p ≈ (1 - exp(-k/b))^k; optimum k ≈ b ln 2

COMPACTION
  select → merge → visibility/tombstone GC → build → publish → retire
  leveled tendency: fewer runs/space, more destination rewriting
  tiered tendency: less rewriting, more runs/transient space/large merges
  names and defaults are product/version/configuration claims

TOMBSTONE
  deletion is a newer version
  drop only when no older value can reappear and no reader needs it

AMPLIFICATION
  WA = physical write bytes / logical user bytes
  RA = stated reads/files/blocks/bytes / logical read or result
  SA = physical occupied bytes / live logical bytes
  always state boundary, workload, interval, and cache/device scope

OPERATIONS
  watch WAL sync, immutable count, run overlap, compaction debt,
  stalls, filter effectiveness, tombstone age, snapshots, and free space
```

---

## 67.15 Review Questions

1. Why does a durable LSM write normally update both a WAL and a memtable? Why is the WAL not normally on the query path?
2. Describe a crash-safe flush publication sequence. At what point may the relevant WAL coverage become eligible for retirement?
3. Distinguish an SSTable file, a sorted run, and a level. Why does the distinction matter when estimating point-read amplification?
4. Derive the approximate Bloom false-positive formula from `m` bits, `n` keys, and `k` hash positions. What does a positive result prove?
5. A filter uses 10 bits per key for 500 million keys. Approximately how much raw bit-array memory does it require? What other costs are excluded?
6. Explain the local tombstone resurrection puzzle. Add one distributed condition that can delay safe collection.
7. In what sense does leveled organization tend to trade write amplification for read and space amplification? Give two workload or implementation details that can invalidate a simplistic ranking.
8. A 32 MiB flush overlaps 288 MiB below and emits 240 MiB after garbage removal. Including a 32 MiB WAL and 32 MiB flush, calculate job-local engine WA charged to the new batch. Also calculate compaction input reclaimed.
9. Why is “PostgreSQL has a WAL, therefore it is an LSM” incorrect? What high-level garbage-collection concern do vacuum and compaction share?
10. Name six metrics needed to decide whether slow writes come from WAL latency, flush debt, compaction debt, CPU, or free-space pressure.

---

## 67.16 Applied Exercise

Build a small simulator; do not build a production database.

1. Represent each version as `(user_key, sequence, kind, value)`.
2. Keep an ordered memtable. After a byte threshold, freeze and flush it to an immutable sorted vector.
3. Implement point lookup and a k-way range merge. Support snapshots by maximum visible sequence.
4. Add point tombstones. Write a test that would resurrect a key if a tombstone were dropped before an older run was included.
5. Add a Bloom filter to each run. Count candidates, useful negatives, false positives, and data-block probes.
6. Implement two toy policies:
   - leveled-like: merge a new run with every overlapping run in the next level;
   - tiered-like: merge four similarly sized runs.
7. Track logical write bytes, WAL bytes, flush bytes, compaction input/output bytes, occupied bytes, and live bytes.

Run three workloads:

- uniform inserts;
- repeated updates to a hot 1% of keys;
- append-mostly data followed by a large delete.

For every graph, label whether it shows a burst or steady state and define each amplification denominator. The interesting result is not which policy “wins”; it is how update skew, deletes, snapshots, and query mix move the bill.

---

## 67.17 Traps

- **“Everything is append-only.”** WAL and new SSTables are append/create oriented, but compaction rewrites and retires data; metadata and devices have their own behavior.
- **“A Bloom-filter hit means the key exists.”** It means “maybe.” A negative is the useful result.
- **“Bloom filters have no false negatives, so the system cannot miss.”** The mathematical structure has that property under correct construction and matching queries; bugs, corruption, incompatible prefixes, or publication failures are system concerns.
- **“All LSM reads are lock-free.”** Immutability simplifies concurrency; it does not prove end-to-end lock freedom.
- **“One file equals one level.”** A run can be partitioned across files, and a level can contain several runs.
- **“Leveled is always read-optimized; tiered is always write-optimized.”** Those are directional models. Skew, ordered writes, caches, filters, value sizes, and hybrid policies matter.
- **“Delete frees space.”** Delete first writes a tombstone. Reclamation waits for compaction and visibility/repair safety.
- **“A tombstone can be dropped after a fixed number of days.”** Retention follows snapshot, overlap, recovery, and distributed repair assumptions. A duration is a product policy, not an LSM theorem.
- **“WA is 10×.”** Without a boundary, interval, workload, and configuration, the number is uninterpretable.
- **“Sequential host writes mean low flash wear.”** Device garbage collection can add further amplification.
- **“PostgreSQL WAL makes the heap log-structured.”** WAL is recovery state; heap and indexes remain the queryable primary structures.
- **“No stalls in a short benchmark means compaction keeps up.”** Deferred debt may simply not have matured.

---

## 67.18 Prerequisite for Chapter 68

Chapter 68 moves from one storage engine to several machines. Carry forward this distinction:

> A local WAL answers “can this node recover acknowledged state under its durability contract?” Replication answers “which nodes have which versions, in what order, and what happens across partitions and failures?”

Local sequence order is not automatically a global order. A durable tombstone on one node is not safely collectible cluster-wide until the distributed protocol’s visibility and repair conditions hold. When Chapter 68 discusses partial failure, do not silently substitute “the disk is durable” for “the distributed write is committed.”
