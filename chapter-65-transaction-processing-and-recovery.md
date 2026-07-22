# Chapter 65 — Transaction Processing and Recovery

*Interview-focused revision notes. The theme: a transaction is a promise — atomic, durable, and isolated from its neighbors — made on top of hardware that offers none of those things. This chapter is the machinery that keeps the promise: a buffer pool that lies about where data lives, a write-ahead log that is the real source of truth, and a concurrency-control scheme that lets many transactions believe they are alone. PostgreSQL is the reference throughout, and its two defining choices — steal + no-force durability, and MVCC instead of an undo log — explain almost everything that follows. Where Postgres sits at one end, we name who sits at the other: ARIES/System R, InnoDB, Oracle.*

---

## 65.1 Why a Buffer Pool Exists

The data lives on a block device; the CPU can only compute on bytes in RAM. Between them sits the **buffer pool** (Postgres: `shared_buffers`), a fixed region of memory that caches on-disk pages so that hot data is served without touching the device. Every read and write in a disk-based engine goes *through* the buffer pool — the access methods (B-tree, heap) never touch the file directly.

The justification is the latency gap of Ch. 30: a DRAM access is ~100 ns, a random NVMe read ~50–100 µs, a random seek on spinning rust ~10 ms. That is three to five orders of magnitude. A buffer pool converts the *second* access to a hot page from a device round-trip into a pointer dereference. Because real workloads are skewed (a small hot set is touched constantly), even a pool far smaller than the database serves the overwhelming majority of accesses from memory.

```
        access methods (B-tree, heap)  — ask for "page (rel, blockno)"
                    │  ReadBuffer(rel, blockno)
                    ▼
        ┌───────────────────────────────────────────┐
        │  Buffer pool (shared_buffers)              │
        │   buffer table (hash: tag → frame)         │  hit?  return frame, pin++
        │   NBuffers frames of 8 KB each             │
        │   buffer descriptors (state, pin, usage)   │  miss? evict a victim,
        └───────────────────────────────────────────┘         read from disk
                    │  read/write 8 KB blocks
                    ▼
              block device  (Ch. 34 I/O)
```

The buffer pool is a **cache with write-back semantics**, not write-through: a modified ("dirty") page can sit in memory long after the transaction that changed it committed, and is flushed to the data file lazily. That single fact is why a durability subsystem — the write-ahead log — is mandatory: if the authoritative page is still in volatile RAM at crash time, something else on stable storage must be able to reconstruct it (§65.8, §65.11).

The unit of caching is the **page** (Postgres `BLCKSZ` = 8 KB, InnoDB 16 KB, Oracle typically 8 KB), matching the on-disk page so that a fetch is one aligned block transfer. The pool is sized in pages: `NBuffers = shared_buffers / BLCKSZ`. A 4 GB `shared_buffers` is 524288 frames.

---

## 65.2 The Buffer Pool vs the OS Page Cache

Here is a subtlety unique to Postgres and a favorite interview probe: **Postgres reads and writes through the OS page cache (Ch. 32), so a page can be cached twice** — once in `shared_buffers`, once in the kernel's page cache. This is **double buffering**, and it is a deliberate, defensible design, not a bug.

```
   Postgres backend
        │ read()/write() on the data file (buffered I/O, no O_DIRECT)
        ▼
   ┌──────────────────────┐   copy       ┌───────────────────────┐
   │ shared_buffers       │◀────────────▶│ OS page cache (Ch. 32)│
   │ (Postgres frames)    │              │ (kernel page frames)  │
   └──────────────────────┘              └───────────────────────┘
                                                   │ actual device I/O
                                                   ▼  writeback, readahead
                                              block device
```

Why not use **direct I/O** (`O_DIRECT`, Ch. 34) and own the cache entirely, like InnoDB and Oracle do? The Postgres position, historically:

- **The kernel does work Postgres would have to reimplement**: readahead (sequential prefetch), write coalescing, and — crucially — using *all otherwise-free RAM* as cache. `shared_buffers` is fixed; the page cache grows to fill the machine. A box with 128 GB RAM and 8 GB `shared_buffers` still caches ~110 GB of hot data in the kernel.
- This is why Postgres tuning advice caps `shared_buffers` around **25% of RAM** rather than 80%: you are deliberately leaving room for the OS page cache to act as a large L2 behind the small L1 of `shared_buffers`. A cache hit in `shared_buffers` is a pointer dereference; a "miss" that hits the page cache is a `memcpy`, not a device I/O — much cheaper than a real miss.

The costs, which the alternative engines cite:

- **Wasted RAM** to double-caching the hottest pages.
- **Loss of control over eviction and writeback timing** — the kernel may write dirty pages back on its own schedule, and `fsync` (§65.12) becomes the only way to force ordering. The infamous *fsyncgate* (2018) was exactly this: on some kernels a failed writeback could be reported once and the dirty page silently dropped, so a later `fsync` returned success while data was lost. Postgres now panics on `fsync` failure to force full recovery.

InnoDB and Oracle instead set `O_DIRECT` (InnoDB: `innodb_flush_method=O_DIRECT`) and make the buffer pool large (50–80% of RAM), owning caching, readahead, and writeback themselves — no double buffering, at the cost of reimplementing what the kernel already does. Postgres 16+ has been adding direct-I/O and asynchronous-I/O paths (via `io_uring`, Ch. 34) precisely to close this gap, but the buffered-I/O + page-cache model is still the default mental model to bring to an interview.

---

## 65.3 Buffer Pool Structure

Concretely, the pool is three parallel arrays plus a hash table, all in shared memory so every backend process (Ch. 61 §61.3) sees the same cache.

```
Buffer table (hash)          Buffer descriptors[NBuffers]        Buffer blocks[NBuffers]
 tag → buf_id                 ┌───────────────────────────┐       ┌──────────────────┐
 {rel, fork, blocknum}        │ tag: {rel,fork,blocknum}  │       │  8 KB page image │
   ─────────► buf_id 5 ─────► │ state: flags | usagecount  │ ────► │  (frame 5)       │
                              │        | refcount (pins)   │       └──────────────────┘
                              │ content_lock (LWLock)      │
                              │ io_in_progress lock         │
                              │ freeNext (free list link)  │
                              └───────────────────────────┘
```

- The **buffer tag** identifies a page uniquely: `{relation, fork number, block number}`. (A relation has multiple *forks*: the main data fork, the free-space map, the visibility map.)
- The **buffer table** is a shared hash table mapping tag → `buf_id`. A `ReadBuffer` hashes the tag, probes the table, and either finds the frame (hit) or misses. The table is sharded into partitions each guarded by its own `LWLock` (the `BufMappingLock` partitions) to reduce contention — the same partitioning idea as a striped lock (Ch. 24), avoiding one global mutex on the hottest path.
- Each **buffer descriptor** holds the tag, a packed atomic `state` word (flags + `usagecount` + `refcount`), a `content_lock` (an `LWLock`, §65.27) that readers/writers of the page take in shared/exclusive mode, and an I/O-in-progress indicator.
- The **buffer block** is the actual 8 KB frame holding the page image.

Modifying the packed `state` word is done with atomic compare-and-swap (Ch. 23) rather than a lock, because pin/unpin is on the hottest path and taking a spinlock per pin would be a scalability disaster; false sharing (Ch. 28) on these descriptors is a real tuning concern in high-core-count builds.

---

## 65.4 Pinning and the Pin Count

Before a backend reads or writes a page's bytes, it must **pin** the buffer: increment the descriptor's `refcount`. The pin is a promise — "I am using this frame; do not evict it or repoint it at a different page." When done, the backend **unpins** (decrements). A buffer with `refcount > 0` is **ineligible for eviction**, because evicting it would pull the page out from under a reader mid-access.

```
ReadBuffer:  pin (refcount++), then take content_lock (shared/excl) to touch bytes
              ... use the page ...
ReleaseBuffer: release content_lock, then unpin (refcount--)
```

Two distinct protections, and conflating them is a classic error:

- **The pin (`refcount`)** protects the *frame–page association*: while pinned, this frame keeps holding *this* page. It says nothing about who may read or write the bytes.
- **The `content_lock` (an `LWLock`)** protects the *bytes*: shared mode for readers, exclusive for a writer. Many transactions can hold a shared content lock on a pinned page at once.

A page can therefore be pinned by many backends simultaneously (each has `refcount++`), all reading concurrently. Eviction requires `refcount == 0`. This is why a long-held cursor over a huge table does not, by itself, wedge the buffer pool: a backend pins a page, copies out the tuples it needs, and unpins promptly — it does not hold the pin across the whole scan. Holding a pin too long is a bug pattern that stalls eviction.

The pin count is the buffer-pool analogue of a reference count (Ch. 19's `shared_ptr`): the resource cannot be reclaimed while any user holds a reference. It is *not* a transaction-duration lock (§65.27) — pins are physical, short-lived, and released well before commit.

---

## 65.5 Page Replacement Policies

When a page must be brought in and no frame is free, the pool must **evict** a victim. The eviction policy is a bet about future access; every policy is a heuristic approximation of the unachievable optimal (Bélády's: evict the page used furthest in the future).

**FIFO.** Evict the oldest-loaded page. Trivial (a queue), but ignores usage — it will evict a hot page just because it was loaded early. Rarely used alone; suffers *Bélády's anomaly* (more frames can mean more misses).

**LRU (Least Recently Used).** Evict the page not touched for the longest time. Excellent for skewed workloads — the hot set stays resident. Two problems:

- **Cost.** True LRU requires moving a page to the head of a list on *every* access, which is a linked-list mutation under a lock on the hottest path — a scalability killer in a shared pool.
- **Scan resistance (the sequential-flooding problem).** One large sequential scan (e.g. a `SELECT count(*)` over a big table) touches millions of pages exactly once. Pure LRU treats each as "most recently used" and evicts the genuinely hot working set to make room for pages that will never be touched again. A single analytical query trashes the cache for every OLTP query. This is the defining weakness of naive LRU.

**LFU (Least Frequently Used).** Evict the least-accessed page by a frequency counter. Scan-resistant (one-touch pages have low counts) but slow to adapt: a page that was hot yesterday keeps a high count and resists eviction long after it cooled ("cache pollution"). Needs aging.

**CLOCK / second-chance.** Approximate LRU without per-access list surgery. Arrange frames in a ring; each has a *reference bit*. On access, set the bit. To evict, a hand sweeps the ring: if a frame's bit is set, clear it and give a "second chance" (skip); if clear, evict it. This approximates LRU (recently-used pages get their bit re-set before the hand returns) but the only per-access work is setting one bit — no locking, no list moves. This is why virtually every real buffer pool uses a CLOCK variant.

```
CLOCK ring, hand sweeps clockwise; ref bit gives a "second chance"
        [P0:1]───[P1:0]───[P2:1]
          │                  │
        [P7:0]            [P3:1]
          │                  │
        [P6:1]───[P5:0]───[P4:0]
                    ▲
                   hand:  bit==0 → evict P5; bit==1 → clear it, advance
```

| Policy | Per-access cost | Scan-resistant? | Adapts quickly? | Notes |
|---|---|---|---|---|
| FIFO | O(1) | no | n/a | ignores usage; Bélády anomaly |
| LRU | O(1) but list mutation + lock | **no** | yes | sequential flooding evicts hot set |
| LFU | O(1) + counter | yes | **no** | cache pollution without aging |
| CLOCK | set one bit | approx (with counts) | yes | LRU approximation, lock-light |
| ARC / 2Q / LRU-K | more state | yes | yes | scan-resistant refinements |

Advanced policies (**LRU-K**, **2Q**, **ARC**) explicitly separate "seen once" from "seen many times" so that a scan flows through a probationary queue without evicting the frequently-used set — solving scan resistance directly. InnoDB uses a **midpoint-insertion LRU**: new pages enter at the "5/8 point," not the head, so a scan cannot promote its pages to the hot end unless they are re-read after a delay.

---

## 65.6 Postgres's Clock-Sweep with Usage Counts

Postgres uses a specific CLOCK variant called the **clock-sweep**, and knowing its exact rules is a strong interview signal.

Each buffer descriptor carries a small `usage_count` (0–5, capped by `BM_MAX_USAGE_COUNT = 5`) instead of a single reference bit — this folds a bit of LFU into CLOCK. A shared **`nextVictimBuffer`** pointer is the clock hand.

- **On unpin** (a page has just been used), `usage_count` is incremented, saturating at 5.
- **To find a victim**, the sweep advances the hand over descriptors. For each candidate: if `refcount > 0` (pinned), skip it — it cannot be evicted. Else if `usage_count > 0`, **decrement it and skip** (second chance). Else (`usage_count == 0` and unpinned), **choose it as the victim**.

```
clock-sweep victim search (simplified):
  loop:
    buf = descriptors[nextVictimBuffer]; advance nextVictimBuffer (mod NBuffers)
    if buf.refcount > 0:           continue           # pinned, cannot evict
    if buf.usage_count > 0:        buf.usage_count--; continue   # second chance
    else:                          return buf          # evict this one
```

A page touched 5 times survives five full sweeps of the hand before becoming eligible — cheap frequency weighting. A one-touch page from a sequential scan enters with `usage_count = 1` and is reclaimed after a single sweep, giving partial scan resistance.

Postgres adds an explicit scan-protection mechanism on top: **buffer ring / ring buffer strategies** (`BufferAccessStrategy`). Sequential scans of large tables (larger than ~`shared_buffers`/4), `VACUUM`, and bulk `COPY` do not use the main clock-sweep at all; they cycle through a *small fixed ring* of buffers (a few hundred KB), reusing the same handful of frames. This is Postgres's direct answer to sequential flooding: a `SELECT count(*)` over a 500 GB table cannot evict your OLTP hot set because it is confined to its own ring.

If the sweep finds a **dirty** victim, it must be written out before the frame can be reused (§65.7). A free list of never-used buffers is consulted first at startup; once warmed, essentially all allocation goes through the clock-sweep.

---

## 65.7 Dirty Pages, Write-Back, the Background Writer and Checkpointer

A page modified in the buffer pool is **dirty**: it differs from the on-disk copy. Because the pool is write-back, dirty pages must eventually reach the data file, and *who* does that writing matters.

Three actors flush dirty buffers in Postgres:

1. **Backend eviction (the slow path you want to avoid).** If a backend's clock-sweep picks a dirty victim, that backend must write the page itself before reusing the frame — synchronous I/O on the query's critical path. Foreground write latency is the symptom of a pool that is dirtying pages faster than they are being cleaned.
2. **The background writer (`bgwriter`).** A dedicated process that walks *ahead* of the clock hand, writing out dirty buffers that are likely to be evicted soon, so backends find clean victims and never block on write. It trickles writes continuously (`bgwriter_delay`, `bgwriter_lru_maxpages`), smoothing I/O.
3. **The checkpointer.** Periodically writes *all* dirty buffers as of a checkpoint, establishing a recovery floor (§65.14).

```
   dirty buffers in shared_buffers
        │                         │                         │
   backend evicts a       background writer            checkpointer
   dirty victim           cleans ahead of hand         flushes ALL dirty
   (BAD: on query path)   (GOOD: hides latency)        as of checkpoint
        └───────────────────────┴─────────────────────────┘
                                 ▼
                          data file (Ch. 34)  ──fsync at checkpoint──▶ durable
```

Critical ordering rule, and the reason recovery works at all: **a dirty page may not be written to the data file until the WAL records describing its changes are on stable storage** (the write-ahead rule, §65.11). Every page carries a **`pd_lsn`** in its header — the LSN of the last WAL record that modified it. Before writing a page out, the buffer manager ensures the WAL has been flushed up to that page's `pd_lsn`. This is what makes "steal" (§65.10) safe.

The tension: flush too eagerly and you waste I/O rewriting pages that are about to be dirtied again; flush too lazily and crash recovery has an enormous backlog to redo, and checkpoints become I/O storms. The knobs — `checkpoint_timeout`, `max_wal_size`, `checkpoint_completion_target` (spread the checkpoint's writes over a fraction of the interval, default 0.9, to avoid a spike) — trade recovery time against steady-state I/O smoothness (§65.14).

---

## 65.8 Why Recovery Is Needed

A transaction promises **atomicity** (all-or-nothing) and **durability** (a committed change survives) — the A and D of ACID. Both promises are threatened by the same event: a crash (power loss, kernel panic, `kill -9`, hardware fault) at an arbitrary instant. Recovery is the subsystem that keeps A and D across crashes.

Two failure modes must be repaired on restart, and they pull in opposite directions:

- **Lost committed work (durability failure).** Transaction T committed, but its changes were only in the buffer pool (dirty pages not yet flushed) when the machine died. The data file does not reflect T. Recovery must **redo** T's changes.
- **Surviving uncommitted work (atomicity failure).** Transaction T's dirty pages *were* flushed to the data file (the pool "stole" the frame and wrote it out), but T had not committed — it was still running, or explicitly rolling back, when the crash hit. The data file reflects a partial T. Recovery must **undo** T's changes.

Which of these can happen is dictated entirely by two buffer-management policies — **steal/no-steal** and **force/no-force** (§65.10) — and the answer determines whether the engine needs a redo log, an undo log, or both. The engine cannot simply "flush on commit and hope": a crash *during* the flush leaves the data file half-updated, which is exactly the torn state recovery exists to detect and repair (§65.16).

The tool that makes recovery possible is the **log**: a separate, append-only, sequentially-written record of *intended and completed changes* that reaches stable storage in a controlled order. On restart, the engine reads the log and brings the data files to a consistent state — redoing what committed, undoing what did not. The log, not the data file, is the source of truth for the recent past.

---

## 65.9 What to Log: Physical, Logical, Physiological

A log record describes a change, but at what level of abstraction? Three choices, with different sizes, replay costs, and robustness.

- **Physical logging.** Record the *bytes*: "page 42, offset 128, before-image = `0x…`, after-image = `0x…`." Replay is trivial and idempotent (just stamp the after-image), and it is robust — replay does not depend on any code path or index state. But records are large (whole changed regions) and brittle to structural assumptions.

- **Logical logging.** Record the *operation*: "insert row (7, 'Alice') into table `orders`." Compact — one record regardless of how many pages/indexes it touches. But replay must *re-execute* the operation through the access methods, which requires the database to be in a consistent, operational state (all indexes present and correct), and the operation must be deterministic. Logical replay of "insert" also has to update every index, redo B-tree splits, etc. — fragile during recovery.

- **Physiological logging** (the ARIES term, and what Postgres and most real engines use). **Physical across pages, logical within a page**: "on page 42, insert this tuple at line pointer 3" or "on page 42, set the bits at these offsets." Each record names a specific page (physical) but describes the change in terms of that page's internal structure (logical), e.g. "add this index entry to this B-tree page," letting the page's own layout code apply it. This is the sweet spot: records are compact, replay is per-page and idempotent (guarded by the page LSN, §65.11), and it survives the page-format details without re-running whole logical operations across the tree.

Postgres WAL is **physiological**: each WAL record targets specific blocks (by `{rel, fork, blocknum}`) and carries a redo routine per resource manager (`heap`, `btree`, `gin`, …) that knows how to re-apply the change to that page. It is redo-oriented — it records after-images / redo actions, not classic undo before-images (§65.15), because MVCC handles rollback without an undo log.

```
 Physical:      "page P, bytes [a,b) := <after-image>"        big, dumb, idempotent
 Logical:       "INSERT INTO orders VALUES (7,'Alice')"        tiny, must re-execute op
 Physiological: "on page P: insert tuple T at slot 3"          per-page, structure-aware  ← ARIES/Postgres
```

---

## 65.10 Steal/No-Steal and Force/No-Force

Two orthogonal buffer-pool policies decide the entire shape of recovery. This 2×2 is the single most important table in the chapter.

**Steal vs no-steal** — may a dirty page from an *uncommitted* transaction be written to disk (evicted, "stolen") before that transaction commits?

- **Steal**: yes. The buffer manager may evict any page whenever it needs the frame, even if an open transaction dirtied it. Consequence: an uncommitted change can reach the data file, so a crash may leave uncommitted data on disk → **undo (rollback) capability is required**.
- **No-steal**: no. Pin every dirty page of an in-flight transaction in memory until it commits. No uncommitted data ever hits disk → **no undo needed**, but the buffer pool must be able to hold all of a transaction's dirty pages, which is impractical for large transactions.

**Force vs no-force** — must all of a transaction's dirty pages be written to disk *at commit* (forced) before commit is acknowledged?

- **Force**: yes. On commit, flush every dirty page to the data file. Then a committed transaction's data is guaranteed on disk → **no redo needed**. But commit now pays random-write I/O for every touched page — slow — and a crash mid-flush is unsafe without more machinery.
- **No-force**: no. Commit only makes the *log* durable (a small sequential append + `fsync`); the data pages are flushed lazily later. Fast commits, but a committed transaction's data pages may still be in the volatile pool at crash → **redo is required**.

```
                 │ FORCE (flush data pages at commit)  │ NO-FORCE (flush lazily)
─────────────────┼─────────────────────────────────────┼──────────────────────────────
 NO-STEAL        │ no redo, no undo                     │ redo only
 (pin dirty      │ (simplest; impractical — pool must   │ (uncommitted never on disk;
  uncommitted    │  hold all dirty pages)               │  committed may not be → redo)
  pages)         │                                      │
─────────────────┼─────────────────────────────────────┼──────────────────────────────
 STEAL           │ undo only                            │ redo + undo   ← ARIES, InnoDB
 (evict any      │ (uncommitted may be on disk → undo;  │ (both problems present;
  page anytime)  │  committed forced → no redo)         │  most flexible, fastest)  ← the standard
```

**Real systems almost universally choose steal + no-force**, the bottom-right cell, because it gives the buffer manager total freedom (evict anything, anytime → high memory efficiency) and makes commit cheap (only the log is forced). The price is that recovery needs *both* redo (for committed-but-unflushed work) and undo (for uncommitted-but-flushed work). ARIES and InnoDB implement full redo+undo.

**Postgres is steal + no-force, but redo-only in practice.** It steals (evicts uncommitted dirty pages freely) and does not force data pages at commit (only the WAL is `fsync`ed). Yet it has *no undo log* — because MVCC leaves the old row version in place, "rolling back" an aborted transaction requires no data reversal: the aborted transaction's `xid` is simply marked aborted in the commit log, and its tuple versions become invisible to everyone (§65.15). So Postgres needs redo (WAL replay) but gets undo "for free" from MVCC. This is the deepest contrast in the chapter and worth being able to state precisely.

---

## 65.11 Write-Ahead Logging: LSNs and the Write-Ahead Rule

The **write-ahead log (WAL)** is the mechanism that makes steal + no-force safe. Its governing invariant, the **write-ahead rule**, has two parts:

1. **Redo rule (for steal):** before a *dirty data page* is written to the data file, all log records describing changes to that page must already be on stable storage. (So if a stolen, uncommitted page hits disk, the log needed to undo it is guaranteed present.)
2. **Commit rule (for durability / no-force):** before a transaction is reported **committed**, all its log records — up to and including its commit record — must be on stable storage. (So a committed transaction can always be redone even though its data pages are not yet flushed.)

Put simply: **log before data, and log before acknowledging commit.** The log reaches disk in an order the engine controls; the data pages reach disk whenever convenient.

The ordering is tracked by the **LSN (Log Sequence Number)**: a monotonically increasing identifier for a position in the log. In Postgres the LSN is literally the **byte offset in the WAL stream** (a 64-bit value, printed as `16/B374D848`). Every WAL record has an LSN; every data page header stores **`pd_lsn`**, the LSN of the *last* WAL record that modified that page.

```
   modify page P in buffer pool:
      1. build WAL record R describing the change
      2. append R to WAL buffer, get lsn(R)
      3. apply the change to page P in the pool
      4. set P.pd_lsn = lsn(R)          # page "remembers" its latest log position
      ...
   later, to write P to the data file:
      FlushWAL(up to P.pd_lsn)          # write-ahead rule: log first
      write P to data file
```

The `pd_lsn` on a page is also what makes **redo idempotent**, which is essential because recovery may replay a record whose effect already reached disk. During redo, for each log record at `lsn(R)` targeting page P, the engine compares: **if `P.pd_lsn >= lsn(R)`, the change is already present — skip it**; only if `P.pd_lsn < lsn(R)` does it re-apply and advance `P.pd_lsn`. This LSN comparison is how ARIES avoids double-applying a redo and how "repeating history" (§65.13) converges to the exact pre-crash state.

The log is the **source of truth**: at commit time the data files may be arbitrarily stale, but the WAL — durable and ordered — contains everything needed to reconstruct them. Replication (Part II) exploits this directly: streaming the WAL to a replica reproduces the primary's state byte-for-byte (physical replication).

---

## 65.12 Postgres WAL Mechanics: fsync, Group Commit, synchronous_commit

The WAL is written first into **`wal_buffers`** (a shared-memory ring, default ~1/32 of `shared_buffers`, capped), then flushed to the WAL segment files (16 MB files under `pg_wal/`). A commit does the following:

1. Write the commit record into `wal_buffers`.
2. Flush the WAL up to that record to the OS, and **`fsync`** (Ch. 34) the WAL file so it is on stable media.
3. Only then acknowledge `COMMIT` to the client (commit rule, §65.11).

The `fsync` in step 2 is the durability cost, and it is expensive: a real device sync is tens to hundreds of microseconds (and historically much more on spinning disks with write caches). If every commit did its own `fsync`, throughput would cap at the device's sync rate — a few thousand per second on a mediocre disk.

**Group commit** amortizes this. When many backends commit near-simultaneously, one `fsync` flushes all their commit records at once. Postgres implements this partly automatically (a backend that finds a flush already in progress waits and rides it) and partly via **`commit_delay`** / **`commit_siblings`**, which deliberately pause a committer for a few microseconds so more commits pile into the same `fsync`. The trade is identical to Ch. 61 §61.5: a tiny latency penalty per commit for a large throughput gain — one sync serves N transactions.

**`synchronous_commit`** exposes the durability/latency knob directly:

| `synchronous_commit` | Commit waits for… | Loss window on crash |
|---|---|---|
| `on` (default) | local WAL `fsync`ed to disk | none (local) |
| `off` | WAL written to buffers, **not yet fsynced** | up to `wal_writer_delay` (~a few 100 ms) of *committed* txns |
| `local` | local flush only (ignore replicas) | none locally; replica may lag |
| `remote_write` / `on` (with sync replicas) | replica received / flushed WAL | none, survives primary loss |

`synchronous_commit = off` is the crucial one: it keeps **atomicity and consistency** (the WAL is still ordered and complete, so recovery never sees a torn transaction) while relaxing only **durability** — a crash can lose the last few hundred milliseconds of *committed* transactions, but never corrupts the database or exposes partial transactions. This is a very different, and much safer, trade than turning `fsync` off entirely (which risks corruption). The **WAL writer** process flushes `wal_buffers` periodically (`wal_writer_delay`) so asynchronous commits still reach disk soon.

`full_page_writes` (§65.16) and `wal_compression` further shape WAL volume; `max_wal_size` bounds how much WAL accumulates between checkpoints.

---

## 65.13 ARIES: Analysis, Redo, Undo, and Repeating History

**ARIES** (Algorithms for Recovery and Isolation Exploiting Semantics, Mohan et al., IBM, 1992) is the canonical crash-recovery algorithm for a steal + no-force engine with physiological logging. Even where a system deviates (Postgres does), ARIES is the vocabulary interviewers expect. Recovery runs in **three passes over the WAL**:

```
        crash
          │
   ┌──────┴────────────────────────────────────────────────────┐
   │ 1. ANALYSIS   scan forward from last checkpoint             │
   │      rebuild the Dirty Page Table (which pages were dirty)  │
   │      and the Transaction Table (which txns were in flight)  │
   │      determine RedoLSN = oldest recLSN in DPT (where redo   │
   │      must start) and the set of losers (uncommitted txns)   │
   ├────────────────────────────────────────────────────────────┤
   │ 2. REDO       scan forward from RedoLSN                      │
   │      REPEAT HISTORY: re-apply EVERY logged change (winners  │
   │      AND losers), skipping any whose page.pd_lsn >= rec.lsn  │
   │      → brings the database to its exact pre-crash state      │
   ├────────────────────────────────────────────────────────────┤
   │ 3. UNDO       scan backward                                  │
   │      roll back the losers (uncommitted txns), writing a CLR  │
   │      for each undone action so undo itself is redo-safe      │
   └────────────────────────────────────────────────────────────┘
```

**Analysis** reconstructs, from the last checkpoint forward, two structures: the **Dirty Page Table (DPT)** — for each dirty page, the `recLSN`, the earliest LSN that dirtied it since it was last clean — and the **Transaction Table** — the set of transactions in flight and their state. The smallest `recLSN` in the DPT is the **RedoLSN**: no change before it can still be missing from disk, so redo starts there.

**Redo — "repeat history."** ARIES's signature idea: redo re-applies **every** change in the log from RedoLSN forward, for *both* committed and uncommitted transactions, unconditionally (subject to the page-LSN idempotence check of §65.11). This deliberately re-creates the *exact* state at the moment of the crash, including changes made by transactions that will be rolled back in the next phase. Why redo losers too? Because it makes the undo phase uniform: undo can assume history is fully present and simply walk transactions backward, rather than reasoning about which partial effects reached disk. Repeating history is what lets ARIES support fine-grained (row-level) locking and physiological logging cleanly.

**Undo.** Now roll back the losers (uncommitted at crash), applying their changes in reverse. Each undone action is itself logged as a **Compensation Log Record (CLR)** — a redo-only record describing the *undo* action, with an `UndoNextLSN` pointer to the next earlier action still to undo. CLRs solve the "crash during recovery" problem: if the system crashes *again* mid-undo, the next recovery redoes the CLRs (undo already done stays done) and continues undoing from where `UndoNextLSN` left off, never redoing an undo. Undo work is therefore **bounded and non-repeating** — you never undo the same action twice, no matter how many nested crashes occur.

The three ARIES principles to recite: **(1) Write-ahead logging** (§65.11); **(2) Repeating history during redo** (restore exact pre-crash state, then undo); **(3) Logging changes during undo** via CLRs (so undo is idempotent under repeated crashes).

---

## 65.14 Checkpoints, Fuzzy Checkpoints, and Restartpoints

Without checkpoints, recovery would have to replay the WAL from the beginning of time. A **checkpoint** bounds recovery work by establishing a position in the WAL such that everything before it is guaranteed applied to the data files — so redo can *start* at (roughly) the checkpoint instead of the epoch.

A naive **"sharp" checkpoint** would stop all transactions, flush every dirty buffer, and record "all data ≤ LSN X is on disk." Correct, but it freezes the database during the flush — unacceptable.

A **fuzzy checkpoint** (what real systems use) runs *concurrently* with transactions. It does not stop the world; instead it records a checkpoint record that captures the DPT and active-transaction table at the checkpoint's start, and flushes dirty buffers in the background over an interval. Because transactions keep running and dirtying pages during the flush, the checkpoint is "fuzzy" — the on-disk state is not a clean snapshot — but the recorded DPT tells recovery precisely which pages might still be behind, so Analysis (§65.13) starts from the checkpoint and Redo starts from the oldest `recLSN`, not from the checkpoint LSN itself.

**In Postgres**, the **checkpointer** process performs a checkpoint every `checkpoint_timeout` (default 5 min) or when WAL since the last checkpoint approaches `max_wal_size`, whichever first. It:

1. Writes a checkpoint *start* WAL record, remembering the current WAL insert position (the **redo point**).
2. Writes **all** buffers dirty as of the start to the data files — spread over `checkpoint_completion_target` × the interval (default 0.9) to avoid an I/O spike.
3. `fsync`s the data files, then writes a checkpoint record and updates `pg_control` with the new redo point.

After a crash, Postgres begins redo at the **redo point** recorded in `pg_control` and replays WAL forward. Recovery time is therefore proportional to WAL generated since the last checkpoint — the fundamental **tuning trade**: frequent checkpoints → short recovery but more full-page writes and steady I/O; infrequent checkpoints → less write overhead but longer recovery and larger checkpoint spikes.

On a **replica** (or during archive recovery), the equivalent is a **restartpoint**: the standby cannot create its own checkpoints (it is replaying the primary's WAL) but periodically performs a restartpoint at a replayed checkpoint record, flushing buffers so that if the *standby* crashes it can restart redo from a recent point rather than the beginning of the stream.

---

## 65.15 Mapping Postgres onto ARIES: Redo-Only Recovery via MVCC

Postgres is the great deviation from textbook ARIES, and articulating exactly how is a top-tier interview answer.

Postgres implements **redo (WAL replay)** faithfully — Analysis + Redo, repeating history via page-LSN idempotence — but has **no undo phase and no undo log at all** during crash recovery. There is no Transaction Table rollback pass, no CLRs, no before-images to reverse. Why can it skip the entire third ARIES phase?

**Because MVCC keeps old versions instead of overwriting (Ch. 61 §61.7).** An `UPDATE` writes a *new* tuple version and marks the old one's `xmax`; a `DELETE` sets `xmax`; neither destroys the prior state. Visibility is decided per-tuple by the inserting/deleting transaction ids (`xmin`/`xmax`) checked against the reader's snapshot and against the **commit log** (`pg_xact`, formerly `clog`), a small array recording each transaction's fate (in-progress / committed / aborted).

So "undoing" an aborted or crashed transaction requires *no data modification*:

- A crashed transaction never wrote a commit record, so on recovery its `xid` is treated as **aborted** in `pg_xact`.
- Its inserted tuple versions have `xmin` = that aborted xid → **invisible to everyone**, forever. Its deletions (setting `xmax` = aborted xid) are simply ignored, so the old versions remain visible.
- No page needs reverting. The aborted versions are just dead tuples, reclaimed later by **VACUUM** (Ch. 61 §61.14) — undo is deferred, incremental, and done by garbage collection rather than a recovery pass.

```
 ARIES / InnoDB / Oracle:                    PostgreSQL MVCC:
   UPDATE overwrites row in place              UPDATE writes NEW version, old kept
   → old value saved to UNDO log/rollback seg  → both versions on the heap page
   ROLLBACK / crash: replay undo to restore    ROLLBACK / crash: mark xid aborted;
   RECOVERY: redo THEN undo (3 phases)           new versions invisible; NO undo pass
                                               RECOVERY: redo only (2 phases)
   cost: undo log, purge threads               cost: dead tuples, VACUUM, bloat
```

Contrast the alternatives explicitly:

- **InnoDB** overwrites the row in the clustered index in place and saves the pre-image to a **rollback segment / undo log** (in the system tablespace / undo tablespaces). It builds old MVCC read-views *by walking the undo log backward*. Rollback and crash-undo both replay undo; a **purge** thread later discards undo no longer needed. So InnoDB is classic ARIES redo+undo — undo does double duty for both rollback and MVCC snapshots.
- **Oracle** similarly uses **undo/rollback segments** and reconstructs consistent reads from undo, and produces the "ORA-01555 snapshot too old" error when a long query needs undo that has been overwritten — the direct analogue of Postgres bloat pressure.

The trade in one line: **Postgres pays for MVCC in disk space and VACUUM (undo is garbage collection); InnoDB/Oracle pay for MVCC in undo-log machinery and a redo+undo recovery, but reclaim space in place.** Same isolation guarantees, opposite cost structure.

(Postgres has experimented with an undo-based storage engine, **zheap**, precisely to get in-place updates and avoid bloat — adopting the InnoDB-style undo model under the pluggable table-AM. Its existence underlines that the redo-only property is a consequence of the *heap's* MVCC choice, not of Postgres's WAL.)

---

## 65.16 The Torn-Page Problem and Full-Page Writes

A crash can strike *during* a page write. A Postgres page is 8 KB but the device writes in 512 B or 4 KB sectors atomically — so an 8 KB write is several sector writes, and a power loss can leave a page half old, half new: a **torn page** (a.k.a. partial write). Physiological WAL replay assumes it is applying a delta to a *consistent* base page; a torn base page would corrupt the redo.

```
 8 KB page = 2 × 4 KB device sectors. Power fails after sector 0, before sector 1:
   ┌───────────────┬───────────────┐
   │ sector 0: NEW │ sector 1: OLD  │   ← torn: neither the old nor the new page,
   └───────────────┴───────────────┘     and WAL redo of a delta onto it corrupts.
```

Postgres's defense is **full-page writes** (`full_page_writes = on`, the default). The rule: **the first time a page is modified after a checkpoint, the entire page image is written into the WAL** (a full-page image, FPI), not just the delta. Subsequent modifications of the same page before the next checkpoint log only the delta.

During redo, when Postgres encounters a WAL record carrying a full-page image, it **overwrites the whole page** with that image rather than applying a delta — so even if the on-disk page was torn, redo restores a known-good full copy, and all later deltas apply cleanly on top. Because a page is only guaranteed consistent on disk as of the last checkpoint, one FPI per page per checkpoint interval is exactly sufficient.

Costs and interactions:

- **WAL volume balloons right after each checkpoint** (every first-touch page logs 8 KB). This is a major reason `full_page_writes` and checkpoint frequency interact: more frequent checkpoints → more FPIs → more WAL. `wal_compression` compresses FPIs to blunt this.
- It is also why the first run of a benchmark right after a checkpoint is slower — the FPI surge.
- **When can it be disabled?** Only if the storage guarantees atomic 8 KB writes — e.g. ZFS/btrfs with copy-on-write, or hardware with battery-backed atomic page writes. InnoDB solves the same problem differently with the **doublewrite buffer**: it writes each page first to a sequential doublewrite area, `fsync`s, then to its real location; on recovery a torn page in place is recovered from its clean copy in the doublewrite buffer. Two solutions to one problem — Postgres logs the whole page in the WAL; InnoDB stages it in a separate area first.

InnoDB additionally has **crash-safe page checksums / LSN-in-header-and-trailer** to *detect* torn pages; Postgres detects corruption via optional page checksums (`data_checksums`).

---

## 65.17 Serializability and Schedules

Now to the C in ACID's neighbor, **isolation**. Concurrency control's gold standard is **serializability**: the result of executing transactions concurrently must equal the result of *some* serial (one-at-a-time) order. Serializability is the correctness criterion; isolation levels (§65.19) are the deliberately weaker approximations of it.

A **schedule** is an interleaving of the operations (reads/writes) of concurrent transactions. A schedule is **serial** if each transaction runs to completion before the next starts. A **serializable** schedule is one *equivalent* to some serial schedule — but "equivalent" needs a definition:

- **Conflict serializability.** Two operations *conflict* if they are from different transactions, touch the same item, and at least one is a write (write–write, write–read, read–write). A schedule is conflict-serializable if it can be transformed into a serial schedule by swapping *non-conflicting* adjacent operations. This is decided by the **precedence graph** (a.k.a. serialization / conflict graph): a node per transaction, an edge Tᵢ → Tⱼ whenever an operation of Tᵢ conflicts with and precedes an operation of Tⱼ on the same item. **A schedule is conflict-serializable iff its precedence graph is acyclic.** A cycle means no serial order is consistent with the observed conflicts.

```
 Precedence graph:  edge Ti → Tj  if Ti's op precedes & conflicts Tj's op on same item
        T1 ──▶ T2          acyclic  → conflict-serializable (order T1,T2,T3)
         ▲      │
         └──────┘  T3       a cycle (T1→T2→T3→T1) → NOT serializable
```

- **View serializability** is strictly weaker (larger class): two schedules are view-equivalent if every read reads the value from the same writer, and the final write of each item is the same. Every conflict-serializable schedule is view-serializable, but not vice versa (view-serializability admits schedules with "blind writes" that conflict-serializability rejects). Deciding view-serializability is NP-complete, so **practical schedulers enforce conflict-serializability** (via locking or via the precedence-graph testing of SSI, §65.22) — it is efficiently checkable and only slightly conservative.

Additional schedule properties matter for recovery: a **recoverable** schedule never lets a transaction commit before a transaction whose data it read has committed; **cascadeless** (avoids-cascading-aborts, ACA) schedules only read committed data, so one abort never forces others to abort. Strict schedules (the basis of Strict 2PL, §65.24) additionally forbid reading *or writing* an item written by an uncommitted transaction.

---

## 65.18 Read and Write Anomalies

Weakening isolation admits specific **anomalies**. Interviewers expect you to define each precisely and draw its timeline. Read (r) and write (w) are indexed by transaction.

**Dirty write** (w–w): T2 overwrites a value written by uncommitted T1. If T1 aborts, its rollback may undo T2's write or leave an inconsistent mix. Forbidden by *every* real isolation level (even Read Uncommitted).

**Dirty read** (r after uncommitted w): T2 reads a value T1 wrote but has not committed; if T1 aborts, T2 read a value that never existed.
```
 T1: w(x=20) ................ ABORT
 T2:            r(x)=20              ← read a value that was rolled back
```

**Non-repeatable read / fuzzy read** (r–w–r): T1 reads x, T2 updates and commits x, T1 reads x again and gets a different value — the same row changed under T1's feet.
```
 T1: r(x)=10 ....................... r(x)=20   (differs!)
 T2:           w(x=20) COMMIT
```

**Phantom read**: T1 runs a *predicate* query (e.g. `WHERE age>30`), T2 inserts/deletes a row matching that predicate and commits, T1 re-runs the query and the *set of rows* changes — a new row "appears." Distinct from non-repeatable read: it is about rows entering/leaving a result set, not a single row's value changing. Defeating phantoms requires locking *ranges/predicates*, not just rows.
```
 T1: SELECT count(*) WHERE age>30  → 5 ............ same query → 6  (phantom)
 T2:                     INSERT (age=40) COMMIT
```

**Lost update** (r–r–w–w): T1 and T2 both read x=10, both compute x+1, both write 11; one update is lost (should be 12). Classic under naive read-modify-write without locking or version checks.

**Write skew** (the signature Snapshot-Isolation anomaly): two transactions read an *overlapping* set, then each writes a *different* item, and the combination violates a constraint that each alone preserved. Canonical: two doctors on call; a rule says ≥1 must remain on call. Each reads "2 on call," each takes themselves off (writing *different* rows), both commit → 0 on call. Neither transaction saw the other's write because they wrote different rows — so no write–write conflict, and Snapshot Isolation permits it.
```
 constraint: on_call(Alice) OR on_call(Bob)  must hold
 T1: r(Alice=on,Bob=on) ... w(Alice=off) COMMIT
 T2: r(Alice=on,Bob=on) ....... w(Bob=off) COMMIT      → both off: constraint broken
```

**Read-only anomaly** (Fekete et al.): even a *read-only* transaction can observe a state inconsistent with any serial order under Snapshot Isolation, given the right interleaving of two read-write transactions — proving SI is not serializable even for readers, and motivating SSI (§65.22).

---

## 65.19 Isolation Levels and the Anomaly Table

The SQL standard (SQL-92) defines four isolation levels by which anomalies each *forbids*. The definitions are phrased in terms of the "big three" phenomena; the standard's table is the one to memorize.

| Isolation level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| **Read Uncommitted** | possible | possible | possible |
| **Read Committed** | prevented | possible | possible |
| **Repeatable Read** | prevented | prevented | possible |
| **Serializable** | prevented | prevented | prevented |

The standard's flaw, exposed by Berenson et al. (1995, "A Critique of ANSI SQL Isolation Levels"): it defines levels by the *lock-based* implementation's phenomena and omits anomalies that **Snapshot Isolation** exhibits — namely **write skew** and lost-update/read-only anomalies. SI prevents all three standard phenomena yet is *not* serializable. So the four-row table is necessary but not sufficient; a complete answer names write skew as the level the standard forgot.

A fuller table including SI and the extra anomalies:

| Level | Dirty read | Lost update | Non-repeatable | Phantom | Write skew |
|---|---|---|---|---|---|
| Read Uncommitted | poss.* | poss. | poss. | poss. | poss. |
| Read Committed | no | poss. | poss. | poss. | poss. |
| Snapshot Isolation | no | no | no | no | **possible** |
| Serializable | no | no | no | no | no |

(*In Postgres, even Read Uncommitted forbids dirty reads — §65.20.)

The general implementation lever: **stronger isolation = holding conflict-preventing controls longer / over wider scopes** (longer read locks, range/predicate locks), costing concurrency. Read Committed releases read locks immediately; Repeatable Read holds them to commit; Serializable additionally prevents phantoms via range/predicate locking (lock-based) or conflict-cycle detection (SSI).

---

## 65.20 PostgreSQL's Real Isolation Behavior

Postgres does not implement isolation with the standard's read/write locks; it uses **MVCC snapshots**, and its actual behavior differs from the standard's minimums in ways interviewers reward knowing.

- **Read Uncommitted → treated as Read Committed.** Postgres *never* permits dirty reads at any level — an MVCC reader only ever sees committed versions (its snapshot filters by commit status). Requesting Read Uncommitted silently gives Read Committed. So the top row of the standard table is unreachable in Postgres.

- **Read Committed (the default).** Each *statement* takes a fresh snapshot at its start. Within one statement the view is stable; across statements in the same transaction it advances, so non-repeatable reads and phantoms are visible between statements. A subtlety unique to RC + MVCC: on a write conflict (updating a row another transaction just updated and committed), Postgres does an **EPQ ("EvalPlanQual") re-check** — it re-reads the *latest committed* version and re-applies the `WHERE` to it, rather than aborting. This can produce results that look non-serializable and surprises people.

- **Repeatable Read = Snapshot Isolation.** Postgres takes **one snapshot at the first statement** of the transaction and holds it for the whole transaction — a consistent point-in-time view. This is strictly *stronger* than the standard's RR: it prevents phantoms too (a snapshot cannot see rows committed after it). But it is exactly SI, so it **permits write skew** and the read-only anomaly. Postgres RR also uses **first-updater-wins**: if two RR transactions update the same row, the second to reach it aborts with a serialization failure (`could not serialize access`) rather than silently losing an update — so lost update is prevented, but the app must retry.

- **Serializable = SSI (Serializable Snapshot Isolation).** Postgres 9.1+ implements true serializability *on top of* SI by detecting dangerous conflict-graph structures at runtime and aborting a transaction to break the cycle (§65.22). It adds no read locks that block writers — reads remain non-blocking MVCC reads — but tracks read/write dependencies with lightweight **predicate (SIRead) locks** and aborts one participant of a would-be non-serializable execution. Cost: potential serialization-failure retries; benefit: full serializability with reader concurrency.

```
 Postgres level        Snapshot taken            Prevents                     Anomaly left
 ─────────────────────────────────────────────────────────────────────────────────────────
 Read Committed        per STATEMENT              dirty read                   non-repeatable,
 (default)                                                                     phantom, write skew
 Repeatable Read       once per TRANSACTION       + non-repeatable, phantom    write skew,
 (= Snapshot Isol.)      (first statement)          (+ lost update via FUW)    read-only anomaly
 Serializable (SSI)    once per TRANSACTION        + write skew (all)          none (fully serializable)
                        + dependency tracking
```

The practical upshot: Postgres RR is safe against everything *except* write skew; if your invariant spans multiple rows that different transactions might each update, you need **Serializable** or explicit locking (`SELECT ... FOR UPDATE`).

---

## 65.21 MVCC Deep Dive: Snapshots, xmin/xmax, Visibility

MVCC (multi-version concurrency control) is how Postgres gives readers a consistent view without blocking writers and writers without blocking readers — the headline property: **readers never block writers, writers never block readers** (only writer–writer on the same row conflicts). Each row exists as multiple **versions** (Ch. 61 §61.7); a transaction's **snapshot** selects the correct version of each row.

**Transaction ids and command ids.** Every write transaction gets a monotonically increasing 32-bit **`xid`** (transaction id). Within a transaction, statements get an increasing **`cid`** (command id) so a statement doesn't see its own later effects incorrectly. Each heap tuple header stores:

- **`xmin`** — the xid that inserted this version.
- **`xmax`** — the xid that deleted/updated-away this version (0 if live).
- **`t_cid`, `t_ctid`** — command id and pointer to the next version.
- **infomask hint bits** (below).

**The snapshot.** A snapshot captured at a point in time is essentially `{xmin, xmax, xip[]}`:

- `xmin` (snapshot) = oldest xid still running when the snapshot was taken; anything older is definitely finished.
- `xmax` (snapshot) = first xid not yet assigned; anything ≥ this had not started, so is invisible.
- `xip[]` = the list of xids **in progress** at snapshot time (between snapshot `xmin` and `xmax`) — these are invisible even though their range overlaps.

```
 xid axis:  |<-- committed & visible -->|<-- in flight (xip) -->|<-- future -->|
            0 ................ snap.xmin ... [xip list] ... snap.xmax ..........
            └ definitely done             └ maybe running        └ not started (invisible)
```

**Visibility rule** for a tuple to be visible to a snapshot S (simplified):

1. Its `xmin` must have **committed** *and* be visible to S (xmin < S.xmax, not in S.xip, and its commit is recorded), **and**
2. Its `xmax` is either 0 (never deleted), **or** the deleting xid is *not* visible to S (still in flight, aborted, or in S.xip) — i.e. the delete hasn't "happened" from S's viewpoint.

So a reader with an old snapshot sees the *old* version (its `xmax` deleter is not yet visible) while a concurrent writer's new version (higher `xmin`) is invisible — no blocking, no locks.

**Commit log (`pg_xact` / clog) and hint bits.** To check "did xid N commit?", Postgres consults **`pg_xact`** (formerly `clog`), a densely packed array with 2 bits per transaction (in-progress / committed / aborted / sub-committed). This lookup is on the visibility hot path, so Postgres caches the answer in the tuple itself as **hint bits** (`HEAP_XMIN_COMMITTED`, `HEAP_XMAX_COMMITTED`, etc.) in the `infomask`. The *first* reader of a tuple after the writer committed consults `pg_xact`, then stamps the hint bit; later readers skip `pg_xact`. This is why a `SELECT` can dirty pages (setting hint bits is a page modification) and cause surprising write I/O on a "read-only" query right after a bulk load — a classic gotcha.

**Frozen tuples and wraparound.** Because xids are 32-bit and wrap around ~4 billion, old tuples must be **frozen** (marked "committed and visible to everyone," historically `xmin = FrozenXID`, now via a frozen infomask bit) by VACUUM before their xid is within 2 billion of the current one, or the database halts to prevent wraparound corruption. This ties MVCC visibility directly back to VACUUM (Ch. 61 §61.14).

---

## 65.22 SSI and Write-Skew Detection

Serializable Snapshot Isolation (Cahill/Röhm/Fekete, 2008; Postgres 9.1) makes Snapshot Isolation fully serializable by catching the specific structure that causes SI's anomalies, without adding blocking read locks.

The theory: every non-serializable SI execution contains a **"dangerous structure"** in the conflict graph — two consecutive **rw-antidependency** edges forming a specific pattern: T1 →rw T2 →rw T3, where a *pivot* transaction T2 has both an incoming and an outgoing rw-dependency, and T3 committed first (or T3 = T1). An **rw-antidependency** (read-write conflict) exists when T_a reads a version that T_b then overwrites — T_a "should have" come before T_b. If two such edges meet at a pivot, the schedule may have a cycle → not serializable. SSI tracks these edges at runtime and, when a dangerous structure appears, **aborts the pivot** to break it.

```
 Dangerous structure (necessary for an SI cycle):
        T1 ──rw──▶ T2 ──rw──▶ T3
                   ▲ pivot: has in+out rw edges → abort T2 to be safe
 Write skew is exactly this with T1,T3 being each other (two txns each reading what
 the other writes): T_a ──rw──▶ T_b ──rw──▶ T_a  → SSI aborts one.
```

To detect rw-antidependencies, Postgres tracks **what each serializable transaction read** using **predicate locks** implemented as **SIRead locks** (`SIReadLock`) — non-blocking "soft" locks recorded in a dedicated shared structure (`pg_serializable` / the predicate lock manager). An SIReadLock does *not* block anyone; it is a *marker* that "this transaction read this page/tuple/range," so that when another transaction writes there, the rw-edge is recorded. Predicate locks are taken at tuple, page, or relation granularity, escalating (tuple → page → relation) under memory pressure — coarser granularity means more false positives (unnecessary aborts) but bounded memory.

Consequences and interview points:

- SSI can produce **false-positive serialization failures** (abort a transaction that would actually have been fine) because predicate locks are conservative — the app must be prepared to **retry** on `40001 serialization_failure`. Serializable in Postgres is a *contract to retry*, not a promise of no aborts.
- It keeps reads **non-blocking** — the great advantage over strict two-phase locking, which would take real read locks and serialize readers against writers.
- Long-running or memory-heavy serializable transactions can force predicate-lock escalation and more aborts; keep serializable transactions short.

SSI is how Postgres solves the **write-skew** and **read-only** anomalies that plain RR/SI (§65.20) permits — by detecting the conflict cycle rather than by locking rows the transaction never wrote.

---

## 65.23 Optimistic Concurrency Control

Concurrency control splits into **pessimistic** (assume conflicts, lock/block up front — §65.24) and **optimistic** (assume conflicts are rare, run freely, validate at the end). SSI is one optimistic scheme; the classic **OCC** (Kung & Robinson, 1981) is the template.

OCC runs a transaction in three phases:

```
 ┌──────────┐   ┌────────────┐   ┌──────────┐
 │  READ    │──▶│ VALIDATION │──▶│  WRITE   │
 │ execute  │   │ check no   │   │ install  │
 │ against  │   │ conflict   │   │ changes  │
 │ a private│   │ with txns  │   │ (if valid│
 │ workspace│   │ that       │   │  ; else  │
 │ (buffer  │   │ committed  │   │  ABORT & │
 │  writes) │   │ meanwhile  │   │  retry)  │
 └──────────┘   └────────────┘   └──────────┘
```

1. **Read phase.** Execute the transaction against a private copy; buffer all writes locally, tracking a *read set* and *write set*. Nothing is visible to others yet.
2. **Validation phase.** At commit, check that this transaction's read/write sets do not conflict with any transaction that committed since it started (backward validation) or is validating concurrently (forward validation). If a conflict is found, **abort and restart**.
3. **Write phase.** If validation passes, atomically install the buffered writes (make them visible).

OCC wins when contention is low: no locking overhead, no deadlocks (there are no locks to deadlock on), readers never block. It loses under high contention: work done in the read phase is *wasted* on abort, and livelock/starvation is possible without backoff. It also needs a validation window that is itself serialized (or carefully lock-managed), which can become the bottleneck.

Where it shows up: SSI is optimistic (validate via conflict detection, abort on danger); Postgres's **first-updater-wins** under RR is optimistic (proceed, detect the write conflict, abort the loser); many in-memory and distributed systems (FoundationDB, some HANA/Hekaton paths) use OCC because it avoids lock-manager contention that dominates in-memory workloads. The alternative — **MVCC** — is arguably a third category (multi-version), often combined with either optimistic (SSI) or pessimistic (2PL on writes) control.

---

## 65.24 Pessimistic Concurrency Control: 2PL and Strict 2PL

The dominant pessimistic scheme is **Two-Phase Locking (2PL)**. Rule: every transaction acquires locks in a **growing phase** and releases them in a **shrinking phase**, and **once it releases any lock it may acquire no more**. The "two phases" are grow-then-shrink over the transaction's lifetime.

```
 locks held
   ▲            growing            shrinking
   │          ┌────────────┐
   │        ┌─┘            └─┐
   │      ┌─┘                └─┐
   │    ┌─┘                    └──── (may not acquire after first release)
   └────┴────────────────────────────────────▶ time
        acquire locks         release locks
```

**Theorem: any schedule produced by 2PL is conflict-serializable.** The two-phase discipline guarantees the precedence graph (§65.17) is acyclic — this is why 2PL is the canonical way to *implement* serializability with locks. Locks come in modes (**shared** S for reads, **exclusive** X for writes) with a compatibility matrix: S/S compatible, S/X and X/X incompatible.

Variants tighten *when* locks release:

- **Basic 2PL** may release a lock during the shrinking phase before commit. Problem: another transaction can read the just-unlocked data, and if the first transaction then aborts, **cascading aborts** ensue. Also allows dirty reads of not-yet-committed writes released early.
- **Strict 2PL (S2PL)** holds all **exclusive (write) locks until commit/abort** (releasing shared locks may still happen earlier). This makes schedules **strict** (no reading/writing uncommitted data) → **no cascading aborts**, and recoverable. This is what most lock-based systems actually use.
- **Strong Strict 2PL / Rigorous 2PL (SS2PL)** holds **all** locks (shared and exclusive) until commit/abort. Simplest to reason about; commit order = serialization order. This is the textbook "2PL" most databases implement (it's what "held until commit" usually means).

2PL's costs are **blocking** (a transaction waits for conflicting locks — latency) and **deadlock** (§65.25), which 2PL does not prevent. Its guarantee is strong (serializability) but its concurrency for read-heavy workloads is poor because readers block writers and vice versa — the exact problem MVCC/SSI avoids. This is why Postgres uses MVCC for reads and only takes real 2PL-style locks for *writes* and explicit lock requests; DB2 and SQL Server (in their default non-snapshot modes) are more classically 2PL.

---

## 65.25 Deadlocks: Detection vs Prevention

Any lock-based scheme can **deadlock**: T1 holds lock A and waits for B; T2 holds B and waits for A; neither proceeds. Deadlock is a cycle in the **wait-for graph** (node per transaction, edge Tᵢ → Tⱼ if Tᵢ waits for a lock held by Tⱼ).

```
 wait-for graph:   T1 ──waits-for──▶ T2
                    ▲                  │
                    └──────waits-for───┘   cycle = deadlock
```

Two strategies:

**Deadlock prevention** — structure lock acquisition so cycles cannot form:

- **Lock ordering**: always acquire locks in a global order (e.g. by object id). No cycle can form (same principle as lock hierarchies in Ch. 24). Requires knowing the lock set in advance — often impractical for ad-hoc SQL.
- **Timestamp schemes** using transaction age to decide who waits vs who dies:
  - **Wait-Die** (non-preemptive): if an *older* transaction requests a lock held by a *younger* one, it waits; if a *younger* requests one held by an older, it **dies** (aborts and retries). Older transactions never abort due to a younger one.
  - **Wound-Wait** (preemptive): if an *older* requests a lock held by a *younger*, it **wounds** (aborts) the younger; if a *younger* requests one held by an older, it waits. Younger transactions never wound older ones.
  Both use a consistent age ordering so cycles cannot form; both may abort transactions that would not actually have deadlocked.

**Deadlock detection** — allow deadlocks, find and break them:

- Periodically (or on a wait timeout) build the wait-for graph and search for a cycle; if found, choose a **victim** and abort it to break the cycle.

**Postgres uses detection, not prevention.** When a backend blocks on a heavyweight lock, it starts a timer of **`deadlock_timeout`** (default **1 second**). Only if it is *still* waiting after that does it run the deadlock detector: build the wait-for graph among all backends, look for a cycle, and if one exists, abort one transaction (the one whose abort breaks the cycle, roughly the one that detected it) with `ERROR: deadlock detected`. The 1-second delay is deliberate — most lock waits resolve quickly, so it avoids running the (relatively expensive) global graph search on every brief wait. The detector runs lazily, only for waits that outlast the timeout. Tuning `deadlock_timeout` too low wastes CPU on graph checks; too high delays breaking real deadlocks.

Applications reduce deadlocks by acquiring locks in a consistent order (e.g. always update rows by ascending primary key) — the same discipline as prevention, applied by convention rather than by the engine.

---

## 65.26 Lock Granularity and the Heavyweight Lock Manager

Locks trade **concurrency against overhead** along a granularity axis: coarse (table-level) locks are cheap to manage but throttle concurrency; fine (row-level) locks maximize concurrency but cost memory and CPU to track millions of them.

```
 coarse ◀──────────────────────────────────────────────▶ fine
 database  tablespace  table  page  row/tuple            (predicate/key-range)
 few locks, low concurrency          many locks, high concurrency, more overhead
```

Systems that lock at fine granularity use **intention locks** and **lock escalation** (SQL Server, DB2, InnoDB) to manage the explosion: an intention-exclusive (IX) lock on the table signals "I hold X locks on some rows below," so a table-level lock request can detect the conflict without scanning every row lock; when row locks on one table exceed a threshold, the engine **escalates** to a single coarser lock, trading concurrency for memory.

**Postgres has two distinct lock systems**, and confusing them is a common error:

- **Heavyweight locks (the lock manager, `LOCK` / `pg_locks`).** Transaction-duration, deadlock-detected, stored in a shared hash table partitioned into 16 partitions (each guarded by an `LWLock`) to reduce contention. These cover **table-level lock modes** (8 modes, from `ACCESS SHARE` taken by `SELECT`, through `ROW EXCLUSIVE` by DML, to `ACCESS EXCLUSIVE` by `DROP`/`ALTER`/`TRUNCATE`), advisory locks, and object locks. The 8×8 conflict matrix decides who blocks whom (e.g. `ACCESS SHARE` vs `ACCESS EXCLUSIVE` conflict — a `SELECT` blocks a `TRUNCATE` and vice versa).

- **Row-level (tuple) locks — mostly *not* in the lock manager.** Postgres records a row lock **in the tuple itself** via `xmax` and infomask bits, so millions of row locks cost no lock-manager memory — the row *is* its own lock. `SELECT ... FOR UPDATE` (exclusive) and `FOR SHARE` (shared) set the row's `xmax` to the locking xid; a conflicting writer sees `xmax` set by a live transaction and waits on it. Because a single `xmax` field can name only one xid, when **multiple** transactions lock the same row in shared mode, Postgres allocates a **multixact** (`MultiXactId`) — a shared structure listing all the lockers — and stores the multixact id in `xmax`. Multixacts have their own SLRU logs (`pg_multixact`) and their own wraparound/freezing concerns, a real production pitfall under heavy `FOR SHARE`/foreign-key workloads.

So a Postgres `UPDATE` takes: an `ACCESS SHARE`/`ROW EXCLUSIVE` heavyweight lock on the *table* (cheap, one per table), and a per-*row* lock recorded in each tuple's `xmax` (cheap, no lock-manager entry) — plus, if it must wait, a transient wait registered so the deadlock detector can see it. This hybrid is why Postgres scales to many concurrent row-level writers without a lock table blowing up.

---

## 65.27 Latches vs Locks, Latch Crabbing, and B-link Trees

The final and most-confused distinction: **locks** vs **latches**. Petrov (and every serious DB text) insists on the separation.

| | **Lock** (logical) | **Latch** (physical) |
|---|---|---|
| Protects | logical database contents (rows, tables, predicates) | in-memory data structures (a page, a hash bucket, the buffer descriptor) |
| Duration | **transaction** — held to commit/abort | **operation** — held for a few instructions |
| Managed by | the lock manager; appears in `pg_locks` | the code directly; not tracked per-transaction |
| Deadlock | **detected** (wait-for graph) | **avoided by protocol** (never detected) |
| Modes | S/X + intention, 8 table modes | shared/exclusive (reader-writer) |
| Analogue | a database concept | a mutex/rwlock (Ch. 24) |

A **lock** is a transaction-level, logically-meaningful, potentially long-held construct managed by the lock manager (§65.26). A **latch** is a short-lived, physical mutual-exclusion primitive protecting an in-memory structure during the handful of instructions that read or modify it — exactly the mutexes and reader-writer locks of Ch. 24. Latches are *not* transaction-scoped: a page latch is taken, the page bytes are changed, the latch is released — all within one operation, long before commit.

**Postgres's three latch tiers** (all in shared memory, all from Ch. 24's toolkit):

- **Spinlocks** — the lowest level, a busy-wait `TAS`/CAS loop (Ch. 23) held for *only a few instructions* (e.g. to update a buffer descriptor's state word). No queueing, no deadlock detection; you must never do anything that could block while holding one.
- **LWLocks (lightweight locks)** — reader/writer latches with a wait queue, used for the buffer `content_lock`, WAL insertion, the buffer-mapping partitions, `pg_xact` SLRU access, etc. These are the workhorse latches. They can be held in shared or exclusive mode; they are released quickly and never held across a wait for I/O in a way that could deadlock (acquisition order is disciplined).
- **Heavyweight locks** — the transaction-duration *locks* of §65.26 (not latches at all), with full deadlock detection.

**Latch crabbing / lock coupling** is the classic protocol for safely traversing a B-tree (Ch. 62–64) under concurrency using latches:

```
 Descending a B-tree with latch crabbing (read):
   latch(root, S)
   find child; latch(child, S); UNLATCH(root)      ← release parent once child is safe
   find child; latch(child, S); UNLATCH(parent)
   ... "crab" down: never hold more than 2 levels at once
```

You latch a node, then latch its child, and only *after* the child latch is held do you release the parent — like a crab moving one claw at a time, always holding the ground under it. For reads, a shared latch on parent can be released as soon as the child is latched. For **writes**, the hazard is a split/merge that propagates upward: you may need to hold ancestor latches until you are sure the child modification will not cascade up (a node is "safe" if it will not split/merge — not full/not minimal). Optimistic descents take shared latches and only re-descend with exclusive latches if a split is actually needed, because holding exclusive latches from the root down would serialize all writers at the root.

**B-link trees (Blink-trees)** (Lehman & Yao, 1981) are the latch-light alternative Postgres actually uses (tie back to Ch. 64). Each B-tree node has a **right-link** pointer to its right sibling and a **high key**. A split adds the new right sibling and links to it *before* updating the parent, so a reader that descended to a node just before it split can detect (via the high key) that its key now lives to the right and simply **follow the right-link** — without holding a latch on the parent. This means a traversal never needs to hold more than **one node latch at a time** (no crabbing on the read path), dramatically reducing latch contention at upper levels. Postgres's nbtree is a B-link tree precisely to keep the hot root and internal pages from becoming a latch bottleneck under concurrent readers and writers.

The unifying picture: **locks give you isolation between *transactions* (logical, long, deadlock-detected); latches give you data-structure integrity between *threads/processes* (physical, short, protocol-safe).** MVCC minimizes the *locks* (readers take none); B-link trees + fine LWLocks minimize the *latches*. Both minimizations are why Postgres sustains high concurrency.

---

## Summary

- The **buffer pool** (`shared_buffers`) caches on-disk pages with **write-back** semantics; Postgres also reads through the **OS page cache**, accepting double buffering to reuse kernel readahead/writeback and all free RAM (hence `shared_buffers` ≈ 25% of RAM), whereas InnoDB/Oracle use `O_DIRECT` and own the cache.
- Pages are **pinned** (refcount) so they can't be evicted while in use; the byte contents are separately protected by a **content latch**. Postgres evicts via **clock-sweep** with `usage_count` 0–5 and confines big scans to a **ring buffer** for scan resistance.
- Recovery exists to preserve **atomicity + durability** across crashes. **Steal + no-force** (Postgres, ARIES, InnoDB) gives the buffer manager freedom and cheap commits, at the price of needing **redo** (committed-but-unflushed) and, in ARIES, **undo** (uncommitted-but-flushed).
- **WAL** enforces **log-before-data** and **log-before-commit**, tracked by **LSNs**; a page's `pd_lsn` makes redo **idempotent**. Postgres commits by `fsync`ing WAL, amortized via **group commit**; `synchronous_commit=off` relaxes only durability (bounded loss), never consistency.
- **ARIES** = analysis → **redo (repeat history for all txns)** → **undo (losers, logging CLRs so undo is crash-safe)**, bounded by **fuzzy checkpoints**. **Postgres maps to redo-only**: MVCC keeps old versions, so an aborted/crashed xid is simply marked aborted in `pg_xact` — **no undo log**; the cost is dead tuples and **VACUUM**. InnoDB/Oracle instead keep **undo/rollback segments**.
- **Torn pages** are defended by **full-page writes** (first post-checkpoint modification logs the whole page); InnoDB uses a **doublewrite buffer** instead.
- **Serializability** (acyclic precedence graph) is the gold standard; isolation levels are weaker approximations admitting **dirty read, non-repeatable read, phantom, lost update, write skew, read-only anomaly**. The SQL table omits **write skew**, which **Snapshot Isolation** permits.
- Postgres: no dirty reads ever; **RR = Snapshot Isolation** (allows write skew); **Serializable = SSI** (detects the dangerous rw-antidependency structure via non-blocking **SIRead/predicate locks** and aborts a pivot). **MVCC**: snapshots `{xmin,xmax,xip}`, tuple `xmin`/`xmax`, `pg_xact` + **hint bits**, freezing to avoid xid wraparound.
- **2PL** (grow then shrink) guarantees serializability; **Strict/Rigorous 2PL** holds write (or all) locks to commit, avoiding cascading aborts. **OCC** validates at commit and aborts on conflict. Postgres uses **deadlock detection** after `deadlock_timeout` (1 s), not prevention.
- **Locks** (logical, transaction-duration, deadlock-detected) ≠ **latches** (physical, operation-duration, protocol-safe = Ch. 24 mutexes). Postgres row locks live in the tuple's `xmax` (+ **multixacts** for shared), not the lock table. B-tree traversal uses **latch crabbing**, and Postgres's **B-link tree** needs only one node latch at a time.

---

## Key Interview Questions

1. **Why does a disk-based DBMS need a buffer pool at all?** — To exploit the 3–5 order-of-magnitude gap between DRAM (~100 ns), NVMe (~50–100 µs), and disk (~10 ms). It caches hot pages so repeated accesses are memory dereferences, and because workloads are skewed, even a small pool serves most accesses. It uses write-back (not write-through) semantics, which is exactly why a WAL is mandatory.
2. **Why does Postgres use both `shared_buffers` and the OS page cache, and what's the tuning consequence?** — Postgres does buffered I/O, so pages are cached in `shared_buffers` and again in the kernel page cache (double buffering). It leverages kernel readahead/writeback and lets the page cache use all free RAM as an L2, so `shared_buffers` is tuned to ~25% of RAM, not 80%. InnoDB/Oracle instead use `O_DIRECT` and a large buffer pool they own.
3. **What is the difference between pinning a buffer and latching its contents?** — The pin (refcount) protects the frame-page association: a pinned page can't be evicted or repointed. The content latch (an LWLock, shared/exclusive) protects the bytes for reading/writing. Many backends can pin and share-latch the same page concurrently; eviction requires refcount 0. Both are physical and short-lived, not transaction locks.
4. **Why does naive LRU fail for a database buffer pool?** — Two reasons: maintaining recency requires list mutation under a lock on every access (a scalability killer in a shared pool), and it isn't scan-resistant — one large sequential scan touches millions of one-time pages, marking each most-recently-used and evicting the genuine hot set (sequential flooding). CLOCK approximations and ring buffers fix this.
5. **Explain Postgres's clock-sweep eviction precisely.** — Each buffer has a usage_count 0–5. On unpin, usage_count increments (saturating at 5). A shared clock hand sweeps buffers: pinned (refcount>0) are skipped; usage_count>0 is decremented and skipped (second chance); usage_count==0 and unpinned is the victim. Large scans/VACUUM use a small ring buffer instead, so they can't evict the hot set.
6. **Who writes dirty pages back to disk in Postgres, and what ordering rule governs it?** — Three actors: a backend that evicts a dirty victim (slow, on the query path), the background writer (cleans ahead of the clock hand), and the checkpointer (flushes all dirty as of a checkpoint). The rule: a page may not be written until the WAL is flushed up to that page's pd_lsn (write-ahead rule), which is what makes steal safe.
7. **What are the steal/no-steal and force/no-force policies, and what does each imply for recovery?** — Steal: uncommitted dirty pages may reach disk → undo needed. No-steal: they can't → no undo. Force: commit flushes all data pages → no redo. No-force: commit only flushes the log → redo needed. Real systems pick steal + no-force (max buffer freedom, cheap commits), which needs both redo and undo.
8. **Postgres is steal + no-force, yet has no undo log — how?** — MVCC keeps old row versions in place instead of overwriting. A crashed/aborted transaction wrote no commit record, so its xid is treated as aborted in pg_xact and its tuple versions become invisible to everyone — no page reversal needed. Undo is deferred to VACUUM (garbage collection). So Postgres needs redo (WAL) but gets undo "for free."
9. **What is an LSN and how does it make redo idempotent?** — A Log Sequence Number identifies a position in the WAL (in Postgres, the byte offset). Every page header stores pd_lsn = the LSN of the last change applied to it. During redo, a record at lsn R is applied to a page only if page.pd_lsn < R; otherwise the change is already present and is skipped. This lets recovery safely replay records whose effects already reached disk.
10. **State the write-ahead rule.** — Two parts: (1) before a dirty data page is written to disk, all WAL records describing its changes must be durable (makes steal safe); (2) before a transaction is reported committed, all its WAL records including the commit record must be durable (makes no-force durable). In short: log before data, log before acknowledging commit.
11. **What is group commit and what does `synchronous_commit=off` trade?** — Group commit amortizes one expensive fsync over many concurrent commits. synchronous_commit=off returns commit before the WAL is fsynced, so a crash can lose the last few hundred ms of committed transactions — but it relaxes only durability, never atomicity/consistency: recovery never sees a torn transaction. That's far safer than disabling fsync (which risks corruption).
12. **Describe the three phases of ARIES.** — Analysis: scan forward from the last checkpoint to rebuild the dirty-page and transaction tables and find where redo starts. Redo: repeat history — re-apply every logged change (committed and uncommitted), guarded by the page-LSN check, restoring the exact pre-crash state. Undo: roll back the losers in reverse, logging CLRs so undo survives further crashes.
13. **What does "repeating history" mean and why redo uncommitted transactions?** — Redo re-applies all changes, including those of transactions that will be rolled back, to reconstruct the exact pre-crash database state. This makes the undo phase uniform: undo can assume complete history and simply walk transactions backward, rather than reasoning about which partial effects survived. It's what lets ARIES support fine-grained locking and physiological logging.
14. **What is a CLR and what problem does it solve?** — A Compensation Log Record logs an undo action as a redo-only record with an UndoNextLSN pointer to the next action to undo. If the system crashes during recovery, CLRs are redone (already-done undo stays done) and undo resumes from UndoNextLSN, so no action is ever undone twice. It bounds undo work under repeated crashes.
15. **How does Postgres crash recovery differ from textbook ARIES?** — Postgres does analysis + redo (repeat history via page LSNs) starting from the redo point in pg_control, but has no undo phase and no undo log, because MVCC handles rollback: a crashed xid is marked aborted and its versions become invisible. InnoDB/Oracle keep undo/rollback segments and do full redo+undo, reclaiming space in place instead of via VACUUM.
16. **What is a torn page and how does Postgres prevent corruption from it?** — An 8 KB page write spans multiple device sectors; a crash mid-write leaves it part-old, part-new, which would corrupt physiological redo. Postgres logs the full page image the first time a page is modified after each checkpoint (full_page_writes); redo overwrites the whole page from that image. InnoDB instead uses a doublewrite buffer.
17. **Physical vs logical vs physiological logging — which does Postgres use and why?** — Physical logs bytes (big, idempotent); logical logs operations (tiny, must re-execute, fragile in recovery); physiological is physical-across-pages, logical-within-a-page ("on page P, insert tuple at slot 3"). Postgres WAL is physiological: compact, per-page, idempotent via page LSNs, and robust without re-running whole logical operations.
18. **What is a fuzzy checkpoint and how does it bound recovery?** — A checkpoint that runs concurrently with transactions rather than freezing them: it records the redo point and dirty-page state, then flushes dirty buffers over an interval (checkpoint_completion_target). Recovery starts redo at the recorded redo point, so recovery time is proportional to WAL since the last checkpoint — the core checkpoint-frequency tuning trade.
19. **What is conflict serializability and how is it tested?** — A schedule is conflict-serializable if non-conflicting adjacent operations can be swapped to reach a serial order. It's tested with the precedence graph (edge Ti→Tj on each conflicting, ordered same-item op pair): the schedule is conflict-serializable iff the graph is acyclic. It's the efficiently-checkable subset of view serializability (which is NP-complete).
20. **Define write skew and why Snapshot Isolation permits it.** — Two transactions read an overlapping set, then each writes a different item, jointly violating a constraint each preserved alone (e.g. both doctors go off-call because each only removed themselves). SI gives each a consistent snapshot and only conflicts on write-write to the same row; different rows means no conflict, so both commit. SI isn't serializable — this is the anomaly the SQL standard omitted.
21. **Give the SQL isolation levels and the anomalies each forbids.** — Read Uncommitted (allows dirty, non-repeatable, phantom), Read Committed (forbids dirty), Repeatable Read (forbids dirty + non-repeatable), Serializable (forbids all three). The standard table is defined by lock-based phenomena and omits write skew, which Snapshot Isolation exhibits despite forbidding all three standard phenomena.
22. **What does each Postgres isolation level actually do?** — Read Uncommitted acts as Read Committed (no dirty reads ever). Read Committed takes a snapshot per statement. Repeatable Read takes one snapshot per transaction = Snapshot Isolation (prevents phantoms too, but allows write skew; first-updater-wins prevents lost update). Serializable = SSI, fully serializable via conflict-cycle detection with retry on serialization failure.
23. **How does a Postgres MVCC snapshot decide tuple visibility?** — A snapshot is {xmin, xmax, xip[]}. A tuple is visible if its xmin committed and is visible to the snapshot (not in xip, < snapshot xmax) and its xmax is 0 or refers to a transaction not visible to the snapshot (in flight/aborted/in xip). Commit status comes from pg_xact, cached in the tuple as hint bits to avoid repeated lookups.
24. **What are hint bits and why can a SELECT cause writes?** — Hint bits (HEAP_XMIN_COMMITTED, etc.) cache a transaction's commit/abort status in the tuple's infomask so later visibility checks skip pg_xact. The first reader after a writer commits looks up pg_xact and stamps the hint bit — a page modification — so a read-only SELECT right after a bulk load can dirty pages and generate write I/O, a common surprise.
25. **How does Serializable Snapshot Isolation achieve serializability without blocking reads?** — It runs on SI but tracks read/write (rw-antidependency) edges using non-blocking SIRead/predicate locks. Every non-serializable SI execution contains a dangerous structure — a pivot transaction with both an incoming and outgoing rw edge; SSI detects it and aborts the pivot. Reads never block; the cost is possible false-positive serialization-failure retries.
26. **What are SIRead (predicate) locks, and do they block anything?** — They are markers recording what a serializable transaction read (at tuple/page/relation granularity, escalating under memory pressure). They block nothing; they exist so that when another transaction writes to a read location, the rw-antidependency edge can be detected. Coarser granularity means more false-positive aborts but bounded memory.
27. **Explain 2PL and its strict/rigorous variants.** — Two-Phase Locking acquires all locks in a growing phase and releases in a shrinking phase (no acquire after first release), which guarantees conflict-serializability. Strict 2PL holds exclusive locks until commit (no cascading aborts); rigorous/strong-strict 2PL holds all locks until commit (commit order = serialization order). Basic 2PL allows cascading aborts.
28. **What is optimistic concurrency control and when does it win?** — OCC runs in read (private workspace, buffered writes), validation (check read/write sets don't conflict with transactions that committed meanwhile), and write (install if valid, else abort/retry) phases. It wins under low contention — no locks, no deadlocks, non-blocking reads — and loses under high contention because aborted work is wasted. SSI and Postgres first-updater-wins are optimistic.
29. **How does Postgres handle deadlocks?** — Detection, not prevention. A backend blocked on a heavyweight lock waits deadlock_timeout (default 1 s); if still blocked, it runs the deadlock detector, which builds the global wait-for graph and aborts a transaction to break any cycle. The 1-second delay avoids running the expensive graph search on the many lock waits that resolve quickly.
30. **Where do Postgres row locks live, and what is a multixact?** — In the tuple itself: SELECT FOR UPDATE/FOR SHARE and DML set the row's xmax (and infomask) to the locking xid, so millions of row locks cost no lock-manager memory. When multiple transactions share-lock one row, xmax can't hold them all, so Postgres allocates a MultiXactId listing all lockers (in pg_multixact), which has its own wraparound/freezing concerns.
31. **Distinguish a lock from a latch.** — A lock is logical: it protects database contents (rows, tables, predicates), is held for the transaction's duration, is managed by the lock manager, and has deadlock detection. A latch is physical: it protects an in-memory structure (a page, a buffer descriptor), is held for a few instructions, is a plain mutex/rwlock (Ch. 24), and avoids deadlock by protocol. Postgres spinlocks and LWLocks are latches; heavyweight locks are locks.
32. **What is latch crabbing and how do B-link trees improve on it?** — Latch crabbing (lock coupling) descends a B-tree by latching a child before releasing the parent, holding at most two levels at once; writers may hold ancestors until a node is "safe" from splits. B-link trees (Lehman-Yao, used by Postgres nbtree) add right-links and high keys so a reader whose node split can follow the right-link instead of holding the parent latch — only one node latch at a time, cutting contention at the hot upper levels.
33. **Why does MVCC give better read concurrency than 2PL?** — Under 2PL, readers take shared locks that block writers and vice versa, serializing read-heavy workloads. MVCC serves each reader the correct version from its snapshot without any lock, so readers never block writers and writers never block readers — only writer-writer conflicts on the same row block. Postgres combines MVCC reads with 2PL-style locks only for writes and explicit lock requests.
34. **What does full-page-writes cost, and when can you disable it?** — Every first modification of a page after a checkpoint logs the whole 8 KB into the WAL, so WAL volume spikes right after each checkpoint and interacts with checkpoint frequency (wal_compression helps). It can be disabled only if storage guarantees atomic 8 KB page writes (e.g. copy-on-write filesystems like ZFS, or hardware atomic writes); otherwise a torn page would corrupt redo.

---

## Common Traps

- **Assuming Postgres uses O_DIRECT and a huge buffer pool.** It does buffered I/O through the OS page cache (double buffering); `shared_buffers` is tuned to ~25% of RAM precisely to leave room for the kernel cache, unlike InnoDB/Oracle.
- **Confusing a page pin with a content latch.** The pin (refcount) stops eviction; the content latch guards the bytes. Many backends can pin and share-latch the same page at once; both are physical and released long before commit.
- **Thinking pure LRU is fine for a buffer pool.** It is not scan-resistant — one big sequential scan evicts the hot set (sequential flooding) — which is why Postgres uses clock-sweep plus ring buffers for large scans.
- **Saying Postgres has an undo log or does an ARIES undo pass on recovery.** It is redo-only; MVCC makes a crashed/aborted xid's versions invisible without reversing any page, and VACUUM reclaims them later. InnoDB/Oracle are the ones with undo/rollback segments.
- **Believing steal + no-force needs no logging.** It needs the most: redo (committed-but-unflushed) and, in ARIES, undo (uncommitted-but-flushed). It is chosen because it maximizes buffer freedom and minimizes commit cost, not because it's simple.
- **Equating `synchronous_commit=off` with `fsync=off`.** The former relaxes only durability (bounded loss of committed txns) while keeping the database consistent and never torn; the latter risks actual corruption. They are not the same knob.
- **Forgetting write skew when discussing Repeatable Read.** Postgres RR is Snapshot Isolation, which prevents dirty/non-repeatable/phantom reads but permits write skew and the read-only anomaly; only Serializable (SSI) closes them.
- **Calling Postgres Serializable "lock-based" or claiming it never aborts.** It is SSI: non-blocking reads plus predicate (SIRead) locks and conflict-cycle detection that aborts a pivot; applications must retry on serialization_failure.
- **Assuming SIRead/predicate locks block writers.** They block nothing; they only record reads so rw-antidependencies can be detected. Coarser granularity means more false-positive aborts, not more blocking.
- **Treating row locks as lock-manager entries in Postgres.** Row locks live in the tuple's xmax (with multixacts for multiple shared lockers), so they don't consume lock-table memory — unlike table-level heavyweight locks.
- **Conflating locks and latches.** Locks are logical and transaction-scoped with deadlock detection; latches (spinlocks, LWLocks) are physical, held for a few instructions, and deadlock-free by protocol — they are the mutexes of Ch. 24.
- **Thinking full_page_writes is always redundant overhead.** It defends against torn pages and is safe to disable only on storage guaranteeing atomic page writes; otherwise it is what keeps physiological redo from corrupting a partially-written page.
- **Assuming a monotonic auto-increment id avoids all B-tree contention.** It still concentrates inserts on the rightmost leaf and its latch; B-link trees and page-level latching, not the key choice alone, are what keep that hot path from serializing.
