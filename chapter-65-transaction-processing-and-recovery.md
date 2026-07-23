# Chapter 65 — Transaction Processing and Recovery

A database update crosses three different worlds:

1. a page changes in volatile memory;
2. a log record makes the change recoverable after a crash;
3. concurrency control decides who may observe which logical version.

Those worlds cooperate, but they are not interchangeable. A mutex release can make bytes visible to another CPU without making them durable. An `fsync` can make a WAL prefix durable without making an uncommitted row visible. A snapshot can hide an aborted tuple even when the tuple's bytes already reached a data file.

This chapter first studies the mechanisms separately—buffer pool, WAL/recovery, and transactions/isolation—and only then joins them into one commit path.

> **Optional-track contract.** The Core path ends at §65.16 and is sufficient for the chapter exercises. §65.17 onward is a skippable PostgreSQL implementation and operations reference.

## 65.1 The 90-Second Screen

If you can explain the following, you have the chapter's backbone:

- A **transaction** is a logical unit that commits or aborts. Atomicity says its effects are all-or-nothing; durability says acknowledged durable commits survive the stated failures; isolation constrains what concurrent transactions may observe.
- A **buffer pool** maps persistent page identifiers to in-memory frames. A **pin** prevents frame reuse; a **latch** protects in-memory structure; a transaction **lock** protects logical data. These have different lifetimes.
- A dirty page may be written before its transaction commits (**steal**) and need not be written at commit (**no-force**). This makes the common path fast but requires recovery.
- **Write-ahead logging (WAL)** imposes two orderings:
  1. the log describing a page update must be durable before that dirty page is allowed to reach persistent storage;
  2. under a durable-commit policy, the commit record and its preceding transaction log must be durable before success is reported.
- An **LSN** orders log records. A page LSN records which update the page reflects. Recovery can skip redo whose LSN is already represented on the page.
- Textbook **ARIES** performs analysis, redo that repeats history, then undo of loser transactions using compensation log records. This is an architecture, not a synonym for every product's recovery.
- Isolation is about histories, not disks. MVCC chooses visible versions from a snapshot; locking controls conflicts; serializable execution must be equivalent to some serial order.
- Snapshot isolation can still permit **write skew**. PostgreSQL Repeatable Read and Serializable behavior must be discussed with a PostgreSQL version label, not inferred from the SQL level names alone.
- **Visibility**, **CPU publication**, and **durability** are three separate predicates.

The shortest useful mental model is:

```text
logical transaction
       │  locks / validation / MVCC visibility
       ▼
buffered page change ──LSN──> WAL record
       │                         │
       │ write page only after   │ flush commit prefix
       └──────────────┬──────────┘
                      ▼
              persistent storage
```

### Claim labels used in this chapter

Database internals discussions often turn one implementation into a universal law. The following labels prevent that:

- **[Architecture]** A general mechanism or correctness invariant.
- **[PostgreSQL 18]** Behavior documented for PostgreSQL 18. Recheck the deployed major version and configuration.
- **[Product/version]** A choice that differs among engines, releases, filesystems, or devices.
- **[Measured]** A performance statement that must be established on the target workload and machine.

Unless otherwise marked, the Core path describes architecture.

---

**Core path begins here.**

## 65.2 Module I — Why the Database Owns a Buffer Pool

Persistent tables and indexes are divided into pages. An operator wants a page by stable identity—perhaps `(file, fork, block)`—while memory is a fixed set of reusable frames.

```text
page table
  PageId A:17 ─────────> frame 42 [page bytes | metadata]
  PageId B:03 ─────────> frame  7 [page bytes | metadata]
  PageId C:91            absent

free/replacement candidate frames <──── replacement policy
```

A buffer pool is not merely a performance cache. It is also where the engine coordinates page identity, concurrent access, dirty state, WAL dependencies, and writeback. Its basic operations are:

1. look up a page ID;
2. if absent, select an unpinned victim;
3. if that victim is dirty, write it safely;
4. read the requested page and install the mapping;
5. pin the frame while the caller uses it;
6. latch the content while inspecting or mutating bytes;
7. mark it dirty and record the update LSN after a logged mutation;
8. unlatch and eventually unpin it.

### Pin, latch, and lock

These words are not synonyms.

| Mechanism | Protects | Typical lifetime | May wait for transaction? | Failure if omitted |
|---|---|---:|---:|---|
| Pin/reference | frame-to-page association | while caller holds page reference | no | frame reused beneath caller |
| Content latch | in-memory page bytes/metadata | critical section | no, by protocol | data race or torn in-memory structure |
| Transaction lock | logical row, key range, table, predicate | statement or transaction | yes | invalid concurrent history |

Suppose a B-tree search pins and read-latches a node. The pin says “do not evict this frame.” The latch says “do not split or rewrite these bytes while I inspect them.” Neither says “another transaction may not update the row I found.” That is concurrency control.

**Latch crabbing** or latch coupling acquires the child latch before releasing the parent latch during a tree descent. B-link designs can use right links and high keys to reduce how many page latches must be held. Those are index-structure protocols, not transaction isolation.

### Buffer lookup and replacement

A shared hash table or comparable directory maps page IDs to frames. The lookup structure itself requires synchronization, often partitioned to avoid one global hot lock. Replacement policies approximate future value using recency, frequency, scan resistance, or workload hints:

- exact LRU is intuitive but costly to maintain under contention;
- CLOCK gives pages “second chances” with a usage counter or reference bit;
- a scan-resistant ring confines one-pass traffic to a small working set;
- specialized pools may separate index, data, temporary, or recovery traffic.

The correctness requirement is small: never reuse a pinned frame; never expose a half-installed mapping; safely write a dirty victim. The “best” victim policy is **[Measured]**, because a sequential scan, a Zipfian OLTP workload, and a bulk loader reward different choices.

### Dirty pages and writeback

A page becomes **dirty** when its in-memory bytes differ from its persistent image. Writeback can occur:

- because a foreground request needs the frame;
- proactively from a background writer;
- as part of a checkpoint's progress;
- under memory or operating-system pressure.

Writeback is not necessarily persistence. With buffered I/O, a database `write` can copy bytes into the kernel page cache and return. The filesystem or device may still hold volatile state. The engine's durability protocol must use supported flush primitives and honor the filesystem/device contract.

## 65.3 The Buffer Pool Is Not the Kernel Page Cache

The database buffer pool and kernel page cache can contain the same logical bytes, but they answer different questions:

| Layer | Main identity | Knows transaction/WAL state? | Controls eviction for query value? | Is persistence? |
|---|---|---:|---:|---:|
| CPU cache | cache line/address | no | no | no |
| DB buffer pool | database page ID | yes | yes | no |
| Kernel page cache | file offset | no | broadly | no |
| Device volatile cache | device block | no | device policy | not necessarily |
| Durable medium | sector/block | no | n/a | according to failure contract |

With buffered I/O, a read may flow from kernel cache into a DB frame, and a write may flow back into kernel cache before a flush. With direct I/O, an engine may bypass much of the kernel page cache for selected paths, but alignment, metadata, and device behavior remain **[Product/version]** concerns.

Three distinctions prevent common bugs:

1. **CPU visibility:** synchronization such as a mutex handoff establishes when another thread may observe memory writes.
2. **database visibility:** locks, snapshots, and transaction status establish whether another transaction may logically observe a version.
3. **durability:** the configured storage protocol establishes whether state survives a stated crash.

A C++ release store is not an `fsync`. An `fsync` does not commit a transaction. A committed version might not be in a reader's older snapshot. Never use one of these facts to prove another.

## 65.4 Buffer-Pool Invariants and Costs

The important invariants are more durable than any replacement algorithm:

- A page ID maps to at most one authoritative writable frame in a pool, unless a more complex coherence protocol says otherwise.
- A caller may dereference frame bytes only while holding the required pin and latch.
- A victim must be unpinned, and its old mapping must not remain concurrently discoverable after reuse.
- A dirty page may be written only after its required WAL prefix is durable.
- An I/O error cannot silently transform a dirty page into a clean page.
- Checkpoint completion means the engine-specific checkpoint contract is satisfied; it does not mean “every byte everywhere was synchronously rewritten at one instant.”

Performance follows a queueing story:

```text
miss latency
  = directory lookup
  + victim search
  + optional WAL flush
  + optional dirty writeback
  + page read
  + contention
```

A high hit ratio can coexist with poor tail latency if pins are held too long, the directory is hot, dirty victims force WAL flushes, or checkpoint writeback saturates storage. Observe wait events, dirty-victim rates, writeback latency, and working-set shape—not hit ratio alone.

---

## 65.5 Module II — Transactions, Failure, and the Log

A transaction has a state machine:

```text
BEGIN ──> ACTIVE ──> COMMITTING ──> COMMITTED
                    │
ACTIVE ──error────> ABORTING ─────> ABORTED
```

`COMMIT` and `ROLLBACK` are not cosmetic SQL delimiters. They cause the engine to publish transaction status, release or transfer locks, retain or discard versions, and emit recovery metadata.

Savepoints introduce partial rollback inside a transaction. Prepared transactions introduce a durable **prepared** state before the global decision in two-phase commit. Both complicate cleanup: a forgotten prepared transaction can retain locks and resources across process lifetimes.

### ACID, precisely enough to reason

- **Atomicity:** after recovery, a transaction's externally defined effects are all present or all absent.
- **Consistency:** each committed transition preserves declared and application invariants, assuming transaction code and constraints are correct. The engine cannot infer every business rule.
- **Isolation:** permitted observations are constrained as if by the selected isolation contract.
- **Durability:** after the system reports a commit at a stated durability level, the effects survive the failures covered by that level.

Durability is conditional. “Survives database-process crash,” “survives OS crash,” “survives host power loss,” and “survives loss of the primary region” require different mechanisms. A product setting can intentionally acknowledge before local or remote persistence. State the failure model.

### Why recovery is required

An update may exist in several places at crash time:

- only in a CPU or process buffer;
- in an in-memory database frame;
- in an in-memory WAL buffer;
- in the kernel page cache;
- in a device's volatile cache;
- on durable media;
- on one or more replicas at receipt, flush, or apply stages.

Recovery interprets the **durable log prefix**, not the application's intention. It must tolerate any data-page subset allowed by the writeback policy.

## 65.6 Steal/No-Steal and Force/No-Force

Two independent choices explain much of recovery design:

- **Steal:** the buffer manager may write a page containing an uncommitted update. A recovery design must make those effects harmless or undoable.
- **No-steal:** such a page cannot be written before commit. This simplifies abort but can pin a large dirty working set.
- **Force:** commit forces all transaction data pages to persistent storage. This reduces redo need but makes commit random-I/O-heavy.
- **No-force:** commit need only secure recovery information; data pages can follow later. This requires redo.

| Policy | Uncommitted data may reach disk? | Committed data may be absent from pages? | Recovery consequence |
|---|---:|---:|---|
| no-steal + force | no | no | simplest, expensive |
| no-steal + no-force | no | yes | redo |
| steal + force | yes | no | undo or logical invisibility |
| steal + no-force | yes | yes | redo plus undo/invisibility mechanism |

Many high-performance designs choose steal + no-force, but the exact undo strategy varies. A textbook ARIES engine restores physical state by undoing loser actions. An MVCC engine may instead leave some loser-created versions physically present while transaction status makes them logically invisible, then reclaim them later. “Steal implies an ARIES undo pass” is therefore too strong.

## 65.7 WAL: The Two Orderings

A log is an append-oriented sequence of records. A record can contain:

- transaction ID and previous-record pointer;
- LSN;
- affected page or object;
- redo information;
- undo information or a reference to it;
- commit, abort, prepare, checkpoint, or compensation state.

Logging may be physical (“replace these bytes”), logical (“insert key K”), or physiological (“perform operation O within page P”). Products mix forms.

### Ordering 1: log before data

Let `pageLSN(P)` be the newest logged update reflected by page `P`, and let `durableLSN` be the highest log position known durable under the storage contract.

```text
page P may be written only if pageLSN(P) <= durableLSN
```

If not, a crash could preserve the data change but lose the only record needed to explain, redo, or undo it.

This rule concerns the WAL record for the page state being written. It does not require the transaction to be committed. That is how steal remains possible.

### Ordering 2: commit record before durable acknowledgement

Let `commitLSN(T)` be transaction `T`'s commit record. Under the chapter's **durable local commit policy**:

```text
report durable success only if commitLSN(T) <= durableLSN
```

The commit record follows the transaction's prior records in the log, so a durable prefix through `commitLSN` also contains them. Group commit lets one flush make many commit records durable.

This is a deliberately named policy, not a universal definition of `COMMIT`. **[Product/version]** Asynchronous-commit settings may acknowledge earlier and explicitly allow recent acknowledged transactions to disappear after a crash. Synchronous replication may require a remote receipt, remote write, remote durable flush, or remote apply before acknowledgement. Those are different commit points.

### Append is not flush

“Written” is dangerously ambiguous:

```text
thread builds record
  → WAL buffer
  → write()/pwrite()
  → kernel cache
  → filesystem/device queues
  → durable medium
```

`write()` commonly establishes only that the kernel accepted bytes. `fsync`, `fdatasync`, `O_DSYNC`, write-through modes, barriers, and forced-unit-access operations have platform-specific contracts. A correct engine uses a supported end-to-end protocol and hardware that honors it. Memory fences only order CPU memory operations; they do not flush a filesystem or device cache.

## 65.8 LSNs, Idempotence, and Log Records

An LSN provides a total log position. Typical relationships are:

- each update record has an LSN;
- a page records the latest applied relevant LSN;
- a transaction record links backward to that transaction's prior log record;
- a checkpoint records enough state to bound restart work;
- a compensation log record (CLR) records work performed during undo.

Redo uses an idempotence test:

```text
if page.pageLSN < record.LSN:
    apply record.redo
    page.pageLSN = record.LSN
else:
    skip
```

Real physiological redo has additional checks: the page must be the intended page incarnation, record-specific preconditions must hold, and torn-page protection may supply a full image. `pageLSN` alone is a teaching abstraction, not a complete page-repair protocol.

Undo is not simply “apply `before` values backward.” A later transaction may have changed the same logical item. ARIES uses transaction chains, operation semantics, locking assumptions, and CLRs so that restartable undo is correct. Logical MVCC rollback uses version status and garbage collection differently.

## 65.9 Crash Windows: What Can Survive?

Assume steal + no-force and the durable local commit policy:

| Crash point | Durable evidence | Allowed result after recovery |
|---|---|---|
| before update WAL is durable | perhaps none | update absent; page must not contain it persistently |
| update WAL durable, data page not written | update record | redo can reconstruct if transaction wins; loser handled by undo/invisibility |
| uncommitted dirty page written | update WAL precedes page | loser effect must be undone or hidden |
| commit appended but not durable | no durable commit record | transaction may be treated as uncommitted |
| commit durable, before reply | durable commit record | transaction survives; client outcome is unknown and must resolve idempotently |
| reply sent after durable commit | durable commit record | transaction survives covered crashes |
| page write torn | WAL/full-image or other repair mechanism | restore a valid page or fail loudly; never accept silent corruption |

The “commit durable, before reply” window matters to API design. The client cannot distinguish “server committed, reply lost” from “server died before commit.” Retrying a non-idempotent operation can duplicate it. Use a transactionally stored idempotency key, unique request ID, or result lookup.

### Core invariants

1. A persistent dirty page never outruns its required durable log prefix.
2. Durable acknowledgement never outruns the policy's durable commit point.
3. Recovery applies only complete, validated log records from the durable prefix.
4. Redo is safe to repeat.
5. Undo or logical invisibility removes loser transactions from the recovered logical state.
6. Recovery actions themselves are restartable.
7. A corrupted or torn page is detected and repaired or rejected.

## 65.10 ARIES as an Architecture

ARIES—Algorithms for Recovery and Isolation Exploiting Semantics—is a particular WAL recovery family, not a generic name for logging. The classic restart shape is:

### Analysis

Scan from checkpoint information to reconstruct:

- transaction table: active, committed, aborting;
- dirty-page table: pages that may require redo and their earliest relevant LSN;
- loser transactions requiring undo.

A **fuzzy checkpoint** is taken while transactions and writeback continue. It records a conservative restart state rather than freezing the database into one instantaneous disk image.

### Redo: repeat history

Start at a conservative redo LSN and replay logged actions, including loser actions when required, while using page-LSN and record-specific tests to skip effects already present. The goal is to reconstruct the state at the instant of crash.

Why redo a loser only to undo it? Because recovery need not guess which of its dirty pages reached storage. Repeating history yields one known state; uniform undo then follows transaction chains.

### Undo losers

Walk loser transactions backward. Each undo emits a CLR containing redo information for the undo and a pointer to the next record still requiring undo. If recovery crashes again, redo repeats completed undo actions and resumes rather than undoing them twice.

ARIES also supports partial rollback, nested top-level actions, operation logging, and other machinery beyond this chapter. The important lesson is the proof structure: durable WAL constrains possible disk states; redo reaches a known history state; logged undo removes losers.

> **PostgreSQL boundary.** PostgreSQL is WAL-based and ARIES-influenced, but mapping it to “literal ARIES with its undo phase removed” is misleading. PostgreSQL has product-specific WAL resource managers, crash redo, full-page images, MVCC transaction status, and cleanup. Analyze its actual invariants rather than forcing every component into textbook ARIES vocabulary.

## 65.11 Worked Recovery Trace

Consider pages `P=10` and `Q=7`, both initially at page LSN 0.

| LSN | Record | Buffer effect |
|---:|---|---|
| 10 | `T1: P 10→15` | `P=15`, `pageLSN=10` |
| 20 | `T2: Q 7→9` | `Q=9`, `pageLSN=20` |
| 30 | `COMMIT T1` | no data-page change |
| 40 | `T2: P 15→18` | `P=18`, `pageLSN=40` |

Assume WAL is durable through LSN 40. `T1`'s commit was acknowledged. `T2` has no commit record. Before the crash:

- `P` at LSN 10 was written after WAL through 10 became durable;
- the later `P` update at LSN 40 remains only in memory;
- `Q` remains only in memory.

Persistent pages at crash are therefore `P=15@10`, `Q=7@0`.

**Analysis** finds `T1` a winner and `T2` a loser.

**Redo** repeats history:

- LSN 10 is skipped because `P.pageLSN == 10`;
- LSN 20 changes `Q` to `9@20`;
- LSN 40 changes `P` to `18@40`.

Now the reconstructed crash state is `P=18`, `Q=9`.

**Undo** follows `T2` backward:

- undo LSN 40: `P 18→15`, and log a CLR;
- undo LSN 20: `Q 9→7`, and log a CLR;
- log `T2` abort/end.

The recovered logical state is `P=15`, `Q=7`: all of committed `T1`, none of loser `T2`. If recovery crashes after the first CLR, its redo is repeatable and the CLR's next-undo pointer resumes at LSN 20.

This trace deliberately serializes writes to `P`. A generic “copy before-image backward” implementation would be wrong when later committed writes overlap; production algorithms use stronger rules.

## 65.12 A Compact, Validated WAL Model

The following C++23 program validates two WAL gates and the exact trace above. It is intentionally not an ARIES implementation. Its undo shortcut is valid only because every loser update in this trace is the latest reconstructed update to its page.

```cpp
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>

enum class Kind { update, commit };

struct Record {
    std::uint64_t lsn;
    std::size_t tx;
    Kind kind;
    std::size_t page;
    int before;
    int after;
};

struct Page {
    int value;
    std::uint64_t page_lsn;
};

constexpr bool may_write_page(std::uint64_t page_lsn,
                              std::uint64_t durable_lsn) {
    return page_lsn <= durable_lsn;
}

constexpr bool may_ack_durable_commit(std::uint64_t commit_lsn,
                                      std::uint64_t durable_lsn) {
    return commit_lsn <= durable_lsn;
}

int main() {
    constexpr std::array log{
        Record{10, 1, Kind::update, 0, 10, 15},
        Record{20, 2, Kind::update, 1,  7,  9},
        Record{30, 1, Kind::commit, 0,  0,  0},
        Record{40, 2, Kind::update, 0, 15, 18},
    };

    static_assert(!may_write_page(40, 30));
    static_assert(may_write_page(40, 40));
    static_assert(!may_ack_durable_commit(30, 20));
    static_assert(may_ack_durable_commit(30, 30));

    std::array pages{Page{15, 10}, Page{7, 0}}; // crash image
    std::array committed{false, false, false};   // indexed by tx

    for (const auto& r : log) {                  // analysis
        if (r.kind == Kind::commit) {
            committed[r.tx] = true;
        }
    }

    for (const auto& r : log) {                  // redo history
        if (r.kind == Kind::update &&
            pages[r.page].page_lsn < r.lsn) {
            pages[r.page] = Page{r.after, r.lsn};
        }
    }
    assert(pages[0].value == 18 && pages[1].value == 9);

    for (auto it = log.rbegin(); it != log.rend(); ++it) {
        const auto& r = *it;
        if (r.kind == Kind::update && !committed[r.tx]) {
            assert(pages[r.page].page_lsn == r.lsn);
            pages[r.page] = Page{r.before, 0};   // trace-only undo
        }
    }
    assert(pages[0].value == 15 && pages[1].value == 7);
}
```

What the model proves is narrow but useful:

- neither the page write nor durable acknowledgement may outrun `durable_lsn`;
- redo reconstructs missing page effects from the durable log;
- loser removal produces the expected final state for the stated trace.

It does not model checksums, page incarnation, concurrent recovery, CLRs, partial records, media failure, or MVCC visibility. Compact models are valuable only when their boundary is explicit.

## 65.13 Checkpoints, Torn Pages, and Media Recovery

A checkpoint bounds restart work by recording a recovery starting point and advancing persistent page state. It usually spreads writes over time. Forcing every dirty page simultaneously would create latency spikes and require an unrealistic global pause.

Checkpoint frequency trades:

- more frequent: less crash redo, more repeated page writes and checkpoint overhead;
- less frequent: more WAL retention and longer recovery, smoother foreground operation;
- poorly paced: bursty I/O and tail-latency cliffs.

A **redo point** is the oldest WAL position restart may need. A **restartpoint** is a checkpoint-like recovery milestone while replaying archived or streamed WAL. Exact names and rules are **[Product/version]**.

### Torn pages

A database page can span multiple atomic storage units. Power loss during a write may leave some sectors old and others new. A record-level redo operation cannot safely assume such a page is structurally valid.

Defenses include:

- full-page images in WAL at strategically chosen times;
- checksums plus a separate repair source;
- doublewrite or shadow-copy techniques;
- storage-supported atomic page writes with a verified contract.

Checksums detect corruption; they do not by themselves repair it. A full-page image can restore a base onto which later redo applies.

### Crash recovery versus media recovery

Crash recovery assumes the data and WAL devices remain available but contain an allowed mix of old and new pages. Media recovery handles lost or corrupted storage:

1. restore a base backup;
2. replay archived WAL to a target point or end;
3. establish a new consistent recovery timeline.

Point-in-time recovery can stop before an accidental operation if the base backup and complete required WAL range exist. A WAL archive is not a substitute for testing restores.

---

## 65.14 Module III — Histories and Isolation

A **schedule** or history interleaves operations from transactions. Two operations conflict when they access the same logical item, at least one writes, and their order can change the result.

A history is **conflict-serializable** if its precedence graph is acyclic:

1. create one node per transaction;
2. add `Ti → Tj` when a conflicting operation of `Ti` precedes one of `Tj`;
3. a cycle proves no conflict-equivalent serial order exists.

Serializability is a property of committed effects and observations, not a promise that transactions literally run one at a time. Concurrency control may block, validate and abort, maintain versions, or combine those techniques.

### Common anomalies

| Anomaly | Minimal shape | Threat |
|---|---|---|
| dirty read | `T2` reads `T1`'s uncommitted write; `T1` aborts | observes nonexistent state |
| nonrepeatable read | `T1` reads X; `T2` commits X; `T1` rereads X | one transaction sees two row values |
| phantom | `T1` runs predicate; `T2` inserts matching row; `T1` reruns | result set changes |
| lost update | both derive writes from same old X; one overwrites the other | accepted intent disappears |
| write skew | both read invariant set, then update disjoint items | cross-row invariant breaks |
| serialization anomaly | committed history has no equivalent serial order | application reasoning fails |

The SQL standard defines isolation levels by required phenomena, but implementations may provide stronger behavior. Names do not fully determine lost-update or write-skew behavior. Document the product and version.

### Isolation-level orientation

| Requested idea | Snapshot cadence / control | Usually prevented | Still investigate |
|---|---|---|---|
| Read Uncommitted | product-specific | little required by standard | dirty and all later anomalies |
| Read Committed | often statement snapshot or short read locks | dirty read | nonrepeatable read, phantom, write skew |
| Repeatable Read | transaction snapshot or long read locks | dirty/nonrepeatable reads | product-specific phantom and write skew behavior |
| Serializable | 2PL, SSI, OCC/certification, or hybrid | nonserializable committed history | abort/retry and operational costs |

“Serializable” guarantees that successfully committed transactions can be ordered serially. It does not guarantee that every attempt commits or that reads never block.

## 65.15 Concurrency-Control Families

### Pessimistic locking and 2PL

Pessimistic control waits before a conflicting action. Shared/exclusive locks are the basic form. **Two-phase locking (2PL)** has:

- a growing phase in which locks are acquired;
- a shrinking phase after the first release, in which no new locks are acquired.

2PL yields conflict-serializability. Strict 2PL retains exclusive locks through commit/abort, preventing other transactions from observing or overwriting uncommitted writes. Rigorous variants retain all locks.

Lock granularity ranges from row/key through page and table to predicate/range. Fine locks improve concurrency but cost metadata and acquisition work. Intention modes summarize lower-level intentions so table and row locking can coexist. Advisory locks encode application-defined coordination; the database does not infer the protected invariant.

### Deadlocks

If `T1` holds A and waits for B while `T2` holds B and waits for A, the wait-for graph contains a cycle. Remedies include:

- consistent resource order, where practical;
- prevention schemes based on transaction age;
- timeout as a coarse escape hatch;
- cycle detection followed by victim abort.

Detection must include the relevant wait queues and lock conversions. A deadlock timeout is not the same as a statement timeout, and its configured value is **[Product/version]**. Applications should make abort-and-retry safe.

Latches can deadlock too, but engines generally prevent that with strict acquisition protocols because transaction-scale detection is too expensive and slow for tiny critical sections.

### Optimistic concurrency control

OCC typically performs:

1. **read:** compute using a private read/write set;
2. **validate:** ensure overlapping commits do not invalidate the computation;
3. **write:** publish changes, or abort and retry.

It avoids waits under low contention but wastes work under conflict. Timestamp-ordering and certification systems are related families with different validation rules.

### MVCC

MVCC keeps multiple logical versions. A snapshot plus transaction status determines visibility:

```text
visible(version, snapshot)
  = creator is visible to snapshot
    and deleter/replacer is not visible to snapshot
```

That formula is conceptual. Self-visible writes, command ordering, prepared transactions, aborted subtransactions, and special status values complicate a real engine.

MVCC lets a reader use an older committed version rather than block behind a writer. It does not eliminate:

- writer-writer conflict handling;
- version reclamation;
- index entries pointing to multiple versions;
- snapshot bookkeeping;
- serializability anomalies.

Old versions can be reclaimed only when no relevant snapshot, replica, decoder, or prepared transaction can need them. Long-lived horizons turn logical concurrency into physical bloat.

## 65.16 Worked Isolation Trace: Write Skew

Invariant: at least one doctor must remain on call.

```text
initial: Alice=on, Bob=on

T1 snapshot: reads Alice=on, Bob=on
T2 snapshot: reads Alice=on, Bob=on

T1 writes Alice=off
T2 writes Bob=off

T1 commits
T2 commits
final: Alice=off, Bob=off
```

Each transaction preserves the invariant relative to its snapshot. They write different rows, so a “first committer wins on the same row” rule sees no write-write collision. Yet both commits create a cycle:

```text
T1 read Bob before T2 wrote Bob: T1 ─rw→ T2
T2 read Alice before T1 wrote Alice: T2 ─rw→ T1
```

This is write skew, not a lost update. No write overwrote the other; the missing conflict is at the predicate or invariant level.

Solutions include:

- serializable isolation with retry;
- an explicit lock on one shared invariant row;
- a schema-level constraint that the engine can enforce atomically;
- carefully locking every row representing the predicate, while handling empty-set phantoms.

A check constraint on each individual doctor row cannot express “at least one across this set.” Correctness belongs where the invariant can be serialized.

### Integration: one update from statement to crash safety

Now join the three modules:

1. The transaction reads versions permitted by its snapshot or obtains logical locks.
2. The executor locates a page, pins its frame, and acquires the appropriate content latch.
3. It constructs the new version or in-place change and the associated WAL record.
4. WAL insertion assigns an LSN. The page is changed, marked dirty, and tagged with that LSN under the engine's protocol.
5. The latch is released; the pin is released when the caller no longer needs the mapping. Transaction locks may remain.
6. A writer may flush the page only after WAL is durable through its page LSN.
7. On commit, concurrency control confirms the transaction may commit—perhaps after validation or serialization checks—and a commit record/status transition is produced.
8. Under the selected durable policy, WAL is flushed through the commit point before success is reported. Group commit may batch many transactions.
9. Logical locks and visibility state are released/published according to the engine's ordering.
10. Later, checkpoints bound recovery; reclamation removes versions older than every visibility horizon.

Step 9 is intentionally not reduced to one universal order. Some engines make a transaction visible only after durable commit; asynchronous policies and replicated systems distinguish local visibility, local durability, remote flush, and remote apply. The correctness requirement is that readers and recovery agree with the documented commit state machine.

---

**Skippable PostgreSQL 18 reference begins here.**

The rest of the chapter maps the inventory to one product. These are **[PostgreSQL 18]** statements, based on PostgreSQL 18 documentation available in July 2026. Internal names and operational defaults can change; verify the deployed major version, settings, platform, and source tree.

## 65.17 PostgreSQL MVCC and Transaction Metadata

PostgreSQL heap tuples carry transaction-related fields including creator `xmin`, deletion/replacement `xmax`, and command information. A snapshot captures an XID visibility horizon and transactions in progress. At a high level, the visibility test asks:

1. Did the inserting transaction commit, abort, remain in progress, or belong to this transaction?
2. Was that insertion visible to this snapshot?
3. Is there a deleting/updating transaction, and was its action visible to this snapshot?

Commit status is stored in transaction-status machinery commonly discussed through `pg_xact`. Tuple **hint bits** can cache status facts in heap pages, so a later reader can dirty a page while recording a hint. Subtransaction parentage involves `pg_subtrans`; overflowed subtransaction state can make visibility checks and recovery behavior more expensive.

Several small, page-oriented status areas use SLRU-style caching rather than the ordinary relation buffer pool. Treat `pg_xact`, subtransaction status, commit timestamps, notification state, and MultiXact state as distinct stores with their own wraparound and I/O characteristics. Active transaction state is coordinated through structures commonly discussed as `ProcArray`; cluster-wide visibility horizons are derived from active and retained state, not from a wall clock. Names such as “global xmin” describe a horizon concept, while the exact fields and calculations are version-specific.

**Command IDs** order changes made by one transaction so statements can see the appropriate earlier self-effects. Savepoints create subtransactions for rollback semantics, but deep savepoint nesting is not free.

### Horizons, freezing, and wraparound

Normal PostgreSQL XIDs occupy a finite circular space. “Older” comparisons are meaningful only within a bounded window. Vacuum freezes sufficiently old committed tuple state so future visibility no longer depends on treating that ordinary XID as permanently old.

The oldest possibly relevant snapshot forms a reclamation horizon. Active backends, prepared transactions, standby feedback, and logical decoding/replication slots can retain horizons. A stale horizon has two coupled symptoms:

- dead tuples and catalog rows cannot be reclaimed;
- anti-wraparound work becomes urgent.

Operational rule: monitor XID and MultiXact age as correctness budgets, not merely as bloat metrics. An anti-wraparound vacuum may receive special treatment because failing to advance the horizon eventually threatens database availability.

### MultiXacts and row locks

Several transactions can hold compatible row-level locks on one tuple. PostgreSQL can represent the group with a MultiXact ID whose member data lives in dedicated status storage. This avoids modeling every row lock as a conventional heavyweight lock-table entry, but introduces a second finite ID space that also needs vacuum/freeze discipline.

Do not simplify this to “all PostgreSQL row locks live only in `xmax`.” Tuple header fields, MultiXact member storage, heavyweight transaction-ID waits, and lock manager state cooperate.

## 65.18 PostgreSQL Isolation, Locks, and SSI

PostgreSQL 18 documents:

- Read Uncommitted behaves like Read Committed.
- Read Committed normally takes a new snapshot per command.
- Repeatable Read uses one transaction snapshot and is implemented as snapshot isolation; serialization anomalies remain possible.
- Serializable adds Serializable Snapshot Isolation (SSI) monitoring and can abort transactions whose dependency pattern risks a nonserializable result.

PostgreSQL's SSI **predicate locks** appear as `SIReadLock` state. They record reads so rw-antidependencies can be detected; they do not block writers like conventional locks. Tracking may coarsen from tuple/page to relation granularity, trading memory for more false-positive serialization failures. Applications must retry the whole transaction on SQLSTATE `40001`.

PostgreSQL also exposes:

- table lock modes with a documented conflict matrix;
- row lock modes used by DML and `SELECT ... FOR ...`;
- page-level locks used internally and normally released quickly;
- transaction-scoped or session-scoped advisory locks;
- heavyweight locks and fast paths for selected common cases;
- LWLocks and spinlocks for internal in-memory synchronization.

The first four are logical coordination interfaces or effects. LWLocks/spinlocks are latches. Conflating them yields bad explanations of both deadlock and isolation.

PostgreSQL detects deadlocks among heavyweight waits and aborts a participant. Detection timing and victim choice are implementation/configuration matters. Use a consistent application lock order to reduce cycles, and still handle deadlock errors because plans and hidden lock acquisition can vary.

## 65.19 PostgreSQL Buffers and WAL

A PostgreSQL shared-buffer identity is represented by a buffer tag that identifies a relation fork and block. Pins protect frame reuse; content locks protect page bytes; lookup and buffer metadata use additional synchronization. Shared-buffer lookup is partitioned, and replacement uses a clock-sweep family with usage counts. Bulk access paths may use small buffer access strategy rings to limit cache pollution.

These details explain behavior, not universal tuning constants. PostgreSQL also relies on the operating-system cache. Memory percentage recommendations in documentation are starting points, not laws; benchmark the complete memory budget, including connections, sorts, hash operations, maintenance, kernel cache, and other processes.

Dirty buffers can be written by foreground and background activity. A checkpoint spreads required writes and establishes recovery metadata. The WAL rule still governs every page: WAL needed for that page image must be flushed first. How a backend reports a file that later needs synchronization to the checkpointer is an internal, version-specific fsync-request path; completion of an ordinary background write is not itself a durable-commit proof.

PostgreSQL WAL records are inserted into shared WAL buffers and later written/flushed. The documented WAL contract says data-file changes may be written only after the corresponding WAL is flushed to permanent storage. One WAL flush can serve many commits.

Crash startup obtains checkpoint and recovery coordinates from durable control metadata and then replays validated WAL from the required redo point. Tools such as `pg_controldata` expose selected control-file state, but fields are not a recovery API and must be interpreted with the matching server version.

### Commit and `synchronous_commit`

For PostgreSQL 18, `synchronous_commit` selects how much WAL processing must complete before success is returned. Local non-`off` modes wait for local WAL flush; replication modes can additionally wait for remote write, flush, or apply. With `off`, success can precede local durable flush, so a crash can lose recent acknowledged transactions without making the recovered database internally inconsistent.

Do not state a fixed loss interval without the actual `wal_writer_delay` and relevant version/configuration. Do not equate `synchronous_commit=off` with `fsync=off`: the former relaxes acknowledgement durability for selected transactions, whereas disabling `fsync` changes the system-wide recovery assumptions and can risk corruption.

### Full-page writes and checkpoints

With `full_page_writes` enabled, PostgreSQL logs a full image on the first modification of a page after a checkpoint so recovery can restore a page whose storage write was partial. This increases WAL volume, often especially after checkpoints. Whether compression helps, and how much, is **[Measured]**.

Do not advise disabling this protection merely because the storage is “modern.” Require an end-to-end documented atomic-write guarantee or an equivalent recovery mechanism, and validate it under the actual stack.

### PostgreSQL recovery versus textbook ARIES

| Concern | Textbook ARIES shape | PostgreSQL 18 orientation |
|---|---|---|
| restart | analysis, repeat-history redo, loser undo | control-file/recovery metadata plus WAL redo |
| rollback | undo records and CLRs restore loser effects | MVCC status makes loser tuple versions invisible; cleanup later |
| page repair | page LSN plus logged actions | WAL resource-manager redo and full-page images |
| checkpoints | fuzzy transaction/dirty-page state | PostgreSQL checkpoint and redo-point rules |
| garbage | undo restores/reclaims logical state | vacuum/pruning reclaim dead versions |

This table is a comparison, not a claim of component-for-component equivalence. PostgreSQL has non-MVCC physical structures and specialized WAL redo rules; “aborted tuples are invisible” is not a complete recovery algorithm.

## 65.20 Vacuum, HOT, Pruning, and Bloat

MVCC turns update/delete into version lifecycle management.

- **Page pruning** can remove or redirect tuple-chain items when page-local knowledge proves they are no longer needed.
- **VACUUM** identifies dead tuples relative to horizons, makes space reusable, maintains auxiliary maps/statistics, and coordinates index cleanup.
- **HOT updates** can avoid adding new index entries when indexed columns are unchanged and the new version fits under PostgreSQL's HOT rules on the same heap page.
- **Freezing** removes the need for future ordinary XID age comparisons for old committed tuples.
- **VACUUM FULL** rewrites and compacts a table under a much stronger lock; ordinary vacuum generally makes internal space reusable without returning all file space to the OS.

“Bloat” is not one number. Diagnose:

| Symptom | Possible cause | Evidence to collect |
|---|---|---|
| many dead tuples | updates/deletes outpace cleanup | table stats, vacuum progress, workload rate |
| file remains large | reusable internal free space | relation size plus page/sample inspection |
| vacuum cannot remove old versions | old snapshot or retained horizon | backend age, prepared xacts, slots, standby feedback |
| index much larger than live data suggests | obsolete index entries, splits, key shape | per-index size/use, index inspection |
| frequent anti-wraparound work | high XID rate or slow horizon advance | XID/MultiXact ages and autovacuum logs |

Vacuum progress views report phases and counters, not a universal completion percentage. Intervention should target the retaining horizon or workload cause before reaching for a rewrite.

## 65.21 Replication and WAL Retention

Physical streaming replication ships WAL-level changes and replays them on a compatible standby. A hot standby can serve read-only queries while replay progresses, but visibility and conflict handling are constrained by recovery. Distinguish:

- WAL generated;
- WAL sent;
- WAL received/written;
- WAL durably flushed remotely;
- WAL replayed/applied;
- change visible to a standby query.

Those positions explain why “replicated” is ambiguous.

Replication slots retain what a consumer may still need. A physical slot can retain WAL; a logical slot can retain WAL and catalog/tuple horizons needed for decoding. An abandoned slot can therefore cause unbounded storage growth or prevent cleanup unless configured safeguards intervene. Monitor `restart_lsn`, activity, retained bytes, and relevant `xmin`/`catalog_xmin`.

Logical decoding converts WAL-level information into transactionally ordered logical changes. A reorder buffer assembles changes by transaction because WAL interleaves concurrent activity and uncommitted transactions must not be emitted as ordinary committed changes. Large or long transactions can pressure memory and spill resources. Replica identity controls what old-key information is available for updates/deletes.

Logical replication is not byte-for-byte recovery. It has publication/subscription rules, table/schema concerns, conflict behavior, and sequence/DDL limitations that must be checked for the deployed version.

Prepared transactions and logical decoding add another lifecycle: two-phase decoding can expose prepare/commit-prepared events when configured and supported. Do not assume that an ordinary commit stream covers every distributed transaction state.

---

## 65.22 Recall Card

```text
BUFFER
PageId → frame. Pin prevents reuse. Latch protects bytes.
Lock protects logical data. Dirty ≠ durable.

WAL
Before page persistence: durableLSN ≥ pageLSN.
Before durable acknowledgement: durableLSN ≥ commitLSN.
write() ≠ durable flush. Memory ordering ≠ storage ordering.

RECOVERY
Durable log prefix is truth.
ARIES: analysis → repeat-history redo → CLR-based loser undo.
Other engines may use MVCC invisibility and product-specific redo.

ISOLATION
Serializable committed history has a serial equivalent.
MVCC chooses versions; it does not automatically prevent write skew.
Visibility ≠ publication ≠ durability.

OPERATIONS
Checkpoints bound redo. Full-page repair handles torn writes.
Oldest horizons govern vacuum. Slots/old snapshots retain WAL or tuples.
Replication has receive, write, flush, apply, and visibility positions.
```

## 65.23 Questions

1. A thread release-stores `dirty=true`, another acquire-loads it, and the WAL bytes have been passed to `write()`. Which visibility or durability facts are established, and which are not?
2. With `pageLSN=900` and `durableLSN=850`, may the buffer manager write the page? What must happen first?
3. Draw the possible recovered outcomes for a transaction whose commit record is durable but whose success response was lost. How should a client retry safely?
4. Why does steal + no-force need both a winner-reconstruction mechanism and a loser-removal mechanism? Give two different loser-removal designs.
5. In the worked trace, why does redo apply T2 before undoing it? What extra machinery makes production undo restartable?
6. Classify a pin, a content latch, a row lock, and an SSI read marker by protected object and lifetime.
7. Prove the doctor schedule nonserializable by drawing its dependency cycle. Why would same-row write-conflict detection miss it?
8. A logical replication slot is inactive while disk use and dead tuples grow. Name the two different retention horizons to inspect and the distinct resources each can retain.

## 65.24 Puzzle

A system reports:

```text
T committed successfully
standby has received WAL through T
primary loses power
standby is promoted
T is absent
```

Is this necessarily a database bug?

No. “Received” may mean bytes reached a process or kernel but were neither durably flushed nor replayed. The acknowledgement policy may have required only local primary durability, or may have allowed asynchronous local commit. The conclusion requires the configured commit mode, the primary's flush point, the standby's write/flush/replay points, and the failure model. Vocabulary is part of the proof.

## 65.25 Exercise: Crash Matrix

Extend the C++ model with an enumeration of crash cuts after each log record and three legal page images:

- neither page written;
- only `P@10` written;
- both `P@10` and `Q@20` written.

Reject any image whose page LSN exceeds durable LSN. For every remaining image:

1. redo the durable prefix;
2. classify winners by durable commit records;
3. remove loser effects using a trace-specific safe rule or a proper logged-undo model;
4. assert that every prefix through LSN 30 recovers `P=15, Q=7`, while prefixes before the commit do not retain `T1`.

Then add a crash during undo. The exercise is complete only when a persisted compensation record prevents completed undo from being performed incorrectly after restart.

## 65.26 Common Traps

- **“The page is visible, so it is durable.”** CPU publication, logical visibility, and persistence are separate.
- **“`write()` committed it.”** Kernel acceptance is not necessarily durable storage, and storage persistence alone is not a transaction commit.
- **“Every `COMMIT` means durable local flush.”** Asynchronous settings and distributed commit levels deliberately define other acknowledgement points.
- **“The OS cache is the database buffer pool.”** It lacks database page identity, pins, WAL dependency, and query-aware replacement state.
- **“A pin is a lock.”** A pin prevents frame reuse; a latch protects memory; a transaction lock constrains histories.
- **“Steal always requires physical ARIES undo.”** It requires loser effects to be removed from recovered logical state; MVCC invisibility is a different strategy.
- **“PostgreSQL is redo-only ARIES.”** It is safer to call it WAL-based and ARIES-influenced, then describe its actual recovery and MVCC machinery.
- **“Snapshot isolation is serializable because every transaction sees a consistent snapshot.”** The write-skew cycle disproves this.
- **“Predicate locks always block writers.”** PostgreSQL SSI read markers track dependencies without acting like conventional blocking predicate locks.
- **“Checksums repair torn pages.”** Checksums detect; a full-page image, replica, backup, or other redundancy repairs.
- **“Vacuum is only a space optimization.”** It also advances visibility/freeze state needed to manage finite transaction ID spaces.
- **“A replication slot is harmless while idle.”** It can retain WAL, tuple/catalog horizons, or both.
- **“PostgreSQL defaults are architecture.”** Settings, supported sync methods, lock behavior, and internal structures are product/version/platform facts.

## 65.27 Prerequisite Check

Before continuing to replication consensus or distributed transactions, verify that you can:

- distinguish a database page, buffer frame, and OS-cached file block;
- explain pin versus latch versus logical lock;
- state both WAL orderings without saying merely “log first”;
- enumerate the unknown-outcome crash window around a commit response;
- derive analysis/redo/undo actions from a short log and page-LSN trace;
- identify write skew and draw its dependency cycle;
- explain why a visibility horizon controls physical reclamation;
- distinguish remote receive, write, flush, replay, and query visibility.

If any item is fuzzy, return to the corresponding module. Distributed protocols multiply these states; they do not remove them.

## 65.28 Primary References

- C. Mohan et al., [“ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging”](https://research.ibm.com/publications/aries-a-transaction-recovery-method-supporting-fine-granularity-locking-and-partial-rollbacks-using-write-ahead-logging), *ACM TODS* 17(1), 1992.
- PostgreSQL 18, [Write-Ahead Logging](https://www.postgresql.org/docs/18/wal-intro.html) and [WAL configuration](https://www.postgresql.org/docs/18/runtime-config-wal.html).
- PostgreSQL 18, [Concurrency Control](https://www.postgresql.org/docs/18/mvcc.html) and [Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html).
- PostgreSQL 18, [Routine Vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html), [Logical Decoding](https://www.postgresql.org/docs/18/logicaldecoding.html), and [`pg_replication_slots`](https://www.postgresql.org/docs/18/view-pg-replication-slots.html).
