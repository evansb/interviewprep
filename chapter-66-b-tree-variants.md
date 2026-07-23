# Chapter 66 — B-Tree Variants

## Why This Matters — Core

B-tree variants exist because “keep sorted keys in balanced pages” does not determine how an engine updates pages, coordinates writers, makes commits durable, reclaims obsolete state, or maps predicates to an index. Each design moves work among reads, writes, memory, storage, synchronization, recovery, and maintenance.

This optional-track chapter teaches a comparison method through three representative update strategies:

1. **copy-on-write (COW)/shadow-paged trees**, using LMDB as a product case;
2. **buffered-message Bε-trees**, as a write-optimized research/design case;
3. **delta-chain, mapping-table trees**, using the Bw-tree paper as a concurrency case.

It then treats PostgreSQL’s access methods separately. GiST, SP-GiST, GIN, BRIN, and hash are not simply faster or slower B-trees; they support different predicate and data organizations.

Chapter 62 owns ordinary B+tree search/split/merge fundamentals. Chapter 64 owns implementation details. Chapter 67 owns LSM trees. This chapter does not repeat them.

Sections 66.1–66.8 are the **Core** path. Section 66.9 is a skippable research/product reference; it is useful for recognizing names, not required for applying the comparison method.

Label every claim:

| Label | Example |
|---|---|
| Architecture | old roots remain reachable until a COW commit publishes a new root |
| Paper/model | Bε-tree I/O bounds under an external-memory model |
| Product/version | LMDB permits one concurrent write transaction |
| PostgreSQL version/operator class | which operators a current access method can support |
| Deployment | page size, storage atomicity, sync configuration |
| Measurement | p99 lookup latency or write amplification for workload W |

Paper asymptotics, one product’s mechanism, and one benchmark are not interchangeable evidence. There is no categorical performance ranking.

## 90-Second Screen — Core

Choose or analyze a variant by answering:

1. **Predicates:** equality, range, ordered output, containment, overlap, nearest neighbor, membership, or physical-range pruning?
2. **Workload:** reads/writes/deletes, point/range mix, batch size, key skew, scan length, and snapshot duration?
3. **Update invariant:** mutate a page, publish a copied path, buffer a message, or prepend a delta?
4. **Concurrency:** latch coupling, one writer, optimistic CAS/helping, or another ownership rule?
5. **Visibility:** which root/version/delta/message set defines a reader’s snapshot?
6. **Durability:** WAL/log, checkpoint, shadow root, flush ordering, checksums, and recovery selection?
7. **Amplification:** logical bytes versus bytes read, written, retained, and copied in memory?
8. **Maintenance:** splits/merges, flushing, consolidation, vacuum/cleanup, and garbage collection?
9. **Hardware assumptions:** block/page size, cache hierarchy, storage overwrite/atomicity, memory map, NUMA, and persistence API?
10. **Tail risk:** long reader, hot key/page, flush/consolidation debt, failed CAS, checkpoint, or false-positive recheck?

The core comparison:

| Strategy | Update publication | Read obligation | Deferred debt |
|---|---|---|---|
| in-place baseline | modify protected page, log/recover as engine requires | follow current tree | dirty pages, WAL/checkpoint/cleanup |
| COW | write new nodes and publish new root/version | follow chosen immutable root | obsolete pages and long-reader pinning |
| buffered Bε | append messages, flush batches downward | reconcile messages along search path | buffers, flush work, delayed deletes |
| Bw-tree delta | CAS new delta at logical page mapping | traverse/consolidate delta chain | consolidation and safe reclamation |

None wins every column.

## 66.1 The Axes That Matter — Core

### Start with invariants, not names

All selected variants retain a searchable key-space partition, but their current-state definitions differ:

```text
in-place:
  current page bytes + concurrency/recovery metadata

COW:
  pages reachable from committed root/version

Bε:
  leaf/base value combined with newer messages on its root-to-leaf path

Bw-tree:
  base page combined with installed delta chain at logical page ID
```

The reader must know which representation has precedence. A leaf containing key `k` is not enough to answer a Bε lookup if a newer delete message waits above it. A Bw-tree base page is not current without its deltas. A newly written COW leaf is not committed until the new root/version is durably and atomically selected under the engine’s protocol.

### Cost axes

Use measured or modeled amplification ratios:

\[
A_w=\frac{\text{physical bytes written}}{\text{logical update bytes}},
\quad
A_r=\frac{\text{physical bytes read or cache lines touched}}
{\text{logical result bytes}}
\]

\[
A_s=\frac{\text{allocated storage bytes}}
{\text{live logical data bytes}}
\]

These definitions require a boundary. Does physical writing include WAL, checkpoint, metadata, replication, filesystem, and device-internal amplification? Does a cached page count as zero I/O but many cache lines? State the layer.

Also record:

- point and range read work;
- update and delete work;
- memory amplification;
- synchronization and retry work;
- maintenance bandwidth and tail latency;
- recovery time and retained history;
- space reclaimability under oldest reader/snapshot;
- implementation and operational complexity.

An average hides burst debt. Buffered writes can be cheap until a flush. Delta install can be cheap until consolidation. COW commit can be regular while reclamation stalls behind an old reader.

### Build a comparison worksheet

Before choosing a design, fill one row per candidate. Unknown is a valid and useful answer; an unlabeled assumption is not.

| Question | Evidence to record |
|---|---|
| What is the committed/current state? | root/version, message order, mapping entry, or protected page |
| What makes an update visible? | latch release, version publication, accepted message, successful CAS |
| What makes it durable? | log record, ordered page writes, checkpoint, metadata protocol |
| What extra work does a read perform? | old-version selection, buffer probes, delta interpretation, heap recheck |
| What work is deferred? | page reclaim, buffer flush, consolidation, vacuum/summarization |
| What pins obsolete state? | snapshots, epochs, failed cleanup, replica/recovery retention |
| Where is contention? | writer lock, root buffer, mapping entry, allocator, metadata page |
| What is the overload behavior? | backpressure, unbounded debt, latency spike, failed allocation |
| Which fact is version-specific? | defaults, file format, operator class, checkpoint/recovery behavior |

Then define a service envelope, not merely a throughput target:

```text
dataset and memory ratio
key/value sizes and compressibility
read/update/delete and point/range distributions
hot-key and sequential-key cases
snapshot age and concurrency
required durability and recovery-time objective
storage limit and sustained maintenance bandwidth
p50 / p99 / p99.9 limits during steady state and debt repayment
```

This worksheet exposes false equivalences. A COW root publication and a Bw-tree delta CAS are both publication events, but the objects published, conflict rules, recovery requirements, and reclaim conditions differ. Likewise, a Bε buffer and a PostgreSQL GIN pending list both defer work, but they belong to different structures and have different query and maintenance semantics.

### Structural modification operations

A split/merge changes reachability among pages. Every variant needs an intermediate-state invariant:

- in-place B-link designs use right links/high keys and ordered latch/WAL protocols;
- COW constructs replacement paths that are unreachable from the committed root until publish;
- Bε flushing can cause child splits and parent pivot updates while preserving message routing;
- Bw-tree structural modifications use installed deltas/side links and multi-step helping protocols described by the paper.

“One atomic root store” or “one CAS” rarely describes the entire structural change. Identify each linearization/publication point and how readers navigate a half-completed operation.

## 66.2 Case Study One: Copy-on-Write Trees — Core

### Mechanism

To update leaf `L`, a path-copying tree creates a new leaf and replacement ancestors:

```text
before, committed root R0:
        R0
       /  \
      A    B
          / \
         L   M

construct off to the side:
  L' = update(L)
  B' = replace child L with L'
  R1 = replace child B with B'

publish/commit R1 only after required data and metadata ordering

old readers: R0 -> B  -> L
new readers: R1 -> B' -> L'
```

Unchanged subtrees are shared. A snapshot is a root/version plus a rule preventing reachable pages from reuse.

If a height-\(h\) path has one page per level and no split, one update creates roughly \(h\) replacement pages. With 16 KiB pages and \(h=4\), the tree-level data written is about 64 KiB for a tiny logical change before metadata, filesystem, or device amplification. This is an illustrative upper-level calculation, not a product prediction: engines can batch multiple updates in one transaction, share copied ancestors, compress pages, or use different node sizes.

### Atomicity and durability are separate

COW prevents overwriting the old reachable pages, but does not generically make a durable transaction atomic. A correct protocol must address:

1. write/initialize all new pages;
2. make required data durable under the storage/OS contract;
3. publish a root/version record with integrity/version fields;
4. make that metadata durable;
5. recover by choosing a fully valid committed version;
6. reclaim old pages only after no reader/version can reach them.

If metadata becomes durable before referenced pages, recovery can select an incomplete tree. If a torn/corrupt meta record is accepted, the root can be wrong. If old pages are reused while a reader holds the old root, snapshot safety fails. Exact ordering, sync, checksums, sector/page atomicity, and filesystem/device behavior are product/deployment facts.

COW may eliminate the need for a separate physiological page-redo log in a particular design, but it does not eliminate all logging, integrity, or durability mechanisms by definition.

### Crash-state reasoning

Reason about a commit as a state machine. The names below are architectural placeholders, not LMDB’s exact implementation:

| Crash point | Potential durable state | Safe recovery requirement |
|---|---|---|
| before any new page is durable | only old graph is complete | select old committed root |
| after some new pages | old graph complete; new graph incomplete | ignore unreachable partial graph |
| after all new pages, before new metadata | both data graphs may be complete | old root remains committed |
| during metadata publication | metadata may be old, new, or torn | validate records and select only a complete committed generation |
| after acknowledged commit | new root and every dependency must satisfy promised durability | select new generation or report a durability-contract violation |

This table separates three properties:

- **failure atomicity:** recovery observes the old or new transaction, not a mixture;
- **durability:** an acknowledged transaction survives the failures promised by the API;
- **integrity:** corrupted or torn state is detected rather than interpreted as valid.

The storage stack can reorder or cache writes unless the engine uses the required interfaces correctly. A protocol also has to state whether it protects only process crashes, operating-system crashes, or sudden power loss. Tests should inject termination between each phase, reopen through the real recovery path, verify all reachable pages, and repeat under every supported sync mode.

### Concurrency and reclamation

Immutable committed pages make readers simple: they traverse their snapshot without seeing in-place structural mutation. Writers are harder. Multiple writers can:

- serialize, producing one next root;
- branch from one root and conflict/rebase;
- coordinate disjoint path copies and merge;
- use higher-level transactions/logs.

There is no generic “COW means lock-free readers and writers.”

Reclamation follows reachability. Let `retire_version(page)` be the version after which a page is obsolete. It can be reused only when every live reader is newer than the last version that may reach it. A long snapshot therefore converts logically dead pages into retained space. Monitor oldest-reader age/version and reclaimable versus pinned bytes.

### LMDB — product case, not definition

LMDB documentation describes a memory-mapped ordered store with many read transactions and one concurrent write transaction per environment. Readers use transaction snapshots; writes use copy-on-write page updates. Those are LMDB product properties, not required properties of all COW trees.

LMDB’s source/file format uses two meta pages and selects transaction metadata across commits. The exact meta fields, validation, sync flags, and durability behavior are version/config/platform details. Avoid reducing it to “alternate pages and pick the larger transaction ID” without checking validity and sync configuration. Unsafe/no-sync modes change durability guarantees.

LMDB’s memory-mapped reads can return views without an application copy in supported APIs, but view lifetime is tied to transaction/environment rules. “Zero copy” does not mean pages cannot fault, storage cannot stall, or application lifetime rules disappear.

**Fit indicators:**

- snapshot reads dominate and one-writer serialization is acceptable;
- a compact embedded ordered store and memory-map model fit the process;
- COW space/reclamation behavior is operationally manageable.

**Reject/measure carefully when:**

- concurrent write throughput is the binding need;
- long readers are common and file growth is constrained;
- large values/path-copying cause unacceptable write/space amplification;
- storage/sync semantics are not understood.

## 66.3 Case Study Two: Buffered Bε-Trees — Core

### Mechanism and invariant

A Bε-tree reserves internal-node space for pivots and update-message buffers. Inserts, updates, and deletes enter near the root and move down in batches:

```text
             [ pivots | message buffer ]
                  /                 \
      [ pivots | buffer ]     [ pivots | buffer ]
              |                       |
            leaves                  leaves

put(k,v) -> message at root
buffer pressure -> batch messages for one child downward
eventually -> apply messages at target leaf
```

For any key \(k\), the current value is determined by the leaf plus relevant newer messages in buffers along its search path. Messages need an order/version so multiple updates/deletes to the same key compose correctly.

The parameter \(\epsilon\), in the standard external-memory presentation, controls how node capacity is divided between pivots/fanout and buffering. Exact bounds assume a block-transfer model and implementation choices described by the paper. Do not translate an asymptotic factor directly into production latency.

### Why buffering can help writes

Suppose a full buffer contains \(m\) messages and the largest child partition contains \(g\) of them. Flushing those \(g\) together amortizes one child read/write over \(g\) updates instead of visiting the child once per update. For a purely illustrative batch of 256 messages evenly targeting 16 children, each child averages 16 messages; flushing a child group can amortize its page I/O over roughly 16 logical updates. Skew, partial buffers, cache state, message size, splits, durability logging, and range operations change the result.

The gain is not “sequential writes by definition.” It is fewer/larger grouped transfers under a workload that supplies useful batching. A hot single key, uniformly sparse updates, or strict per-update durability can behave differently.

### A small visibility example

Assume the leaf’s durable base contains `(k, 10)`. From root to leaf, a reader encounters these messages, listed oldest to newest:

```text
put(k, 12)
add(k, 3)
delete(k)
put(k, 20)
```

The visible result is `(k, 20)`, not the leaf value and not the first matching message. An implementation may combine messages early—for example, collapsing two overwriting puts—but only if the transformation preserves ordering and the semantics of every operation. Noncommutative updates make this especially important.

A range query over `[a, z]` has a second problem: relevant messages may be distributed across buffers at several levels. It must neither omit an inserted key that has not reached its leaf nor emit a leaf key hidden by a newer delete. Useful per-buffer indexes can locate relevant messages, but their CPU, space, and update costs belong in the comparison.

There are therefore at least three meaningful “update complete” points:

1. accepted and visible to a transaction;
2. durable according to the engine’s log/checkpoint contract;
3. propagated/applied to the final leaf representation.

Conflating them causes bad recovery tests and misleading latency measurements. A benchmark must say which point its timer ends at.

### Read and maintenance obligations

A point lookup examines the search path’s message buffers and leaf, applying relevant messages in order. A range scan must reconcile messages affecting the range. Bloom/filter/index structures inside buffers can reduce search CPU/I/O, but add memory and maintenance.

Debt appears as:

- full/near-full buffers requiring flush;
- messages duplicated/moved through levels;
- delayed deletes/tombstones;
- split work caused by arriving batches;
- checkpoint/log state needed for durability;
- large flushes competing with reads.

Tail latency depends on whether flushing is synchronous, background, cooperative, throttled, or admission-controlled. A throughput benchmark that ends before draining buffers reports incomplete work.

### Correctness and recovery

A crash-safe implementation must preserve message order and exactly-once logical application across log/checkpoint/recovery boundaries. If a message is durable in a parent and partially flushed to a child, recovery needs enough identity/protocol to avoid losing or double-applying it. The abstract Bε-tree does not prescribe a production WAL/checkpoint.

Concurrent flushing, queries, and structural changes need latches/versioning or another protocol. “Buffered” is an update-placement strategy, not a concurrency algorithm.

**Fit indicators:**

- many small updates can batch by subtree;
- write bandwidth/amplification is more constraining than minimal point-read work;
- ordered range access remains important;
- maintenance bandwidth and latency can be governed.

**Reject/measure carefully when:**

- reads require consistently minimal/low-variance lookup work;
- workload does not form useful batches;
- strict immediate visibility/durability forces expensive flush/log paths;
- operational tooling cannot expose buffer/flush debt.

## 66.4 Case Study Three: Bw-Tree Delta Chains — Core

### Mapping-table indirection

The Bw-tree papers describe logical page IDs (PIDs) resolved through a mapping table. An update allocates a delta record pointing to the prior state, then uses compare-and-swap (CAS) to replace the mapping entry:

```text
parent contains stable PID 42

mapping[42] -> InsertDelta(k7)
                 -> DeleteDelta(k3)
                     -> BasePage(...)

new update D:
D.next = current mapping[42]
CAS(mapping[42], old_head, D)
```

The successful CAS publishes the delta for that PID. A reader resolves the PID and interprets the chain over the base page. Logical references remain stable while physical representations change.

“Latch-free” is a progress/concurrency claim for the algorithm, not “no synchronization” or “wait-free.” Threads allocate, read shared mapping entries, perform CAS, retry on conflict, help structural operations, and participate in safe memory reclamation.

### Delta cost and consolidation

Small deltas avoid copying a whole page for each update, but read work grows with chain length. If a base page search costs \(C_b\), each examined delta costs \(C_d\), and chain length is \(d\), a simple CPU model is:

\[
C_{\text{lookup}}\approx C_b+dC_d
\]

Real behavior is nonlinear because cache locality, early match, branch prediction, consolidation state, and delta types differ. The model explains why a threshold exists, not what it should be.

**Consolidation** builds a new base representation incorporating deltas and CAS-publishes it if the observed chain is still current. A failed CAS can discard/retry/help according to the algorithm. Consolidation is not garbage collection:

- consolidation reduces logical chain/deferred-read work;
- reclamation waits until no reader can still reference the removed chain.

Threshold/admission/background policy controls a read/write/tail trade. No universal delta-chain length is correct.

### A delta-chain race

Let `mapping[42]` point to head `H0`. Writers A and B construct deltas `DA -> H0` and `DB -> H0`. A wins:

```text
CAS(mapping[42], H0, DA) succeeds
CAS(mapping[42], H0, DB) fails
```

B must reread the head, decide whether A’s logical change conflicts, and construct or retarget a valid attempt such as `DB' -> DA`. It cannot blindly publish the stale `DB -> H0`, because that would detach A’s update from the current chain. A successful CAS is a local publication point for one mapping entry; transaction atomicity across several logical pages needs additional machinery.

Now suppose consolidator C reads `DA -> H0` and builds base `BC`. Before C publishes, B installs `DB' -> DA`. C’s CAS expecting `DA` fails. It must not replace the newer chain with `BC`; doing so would lose B’s update. Depending on the algorithm, C retries from the new head or abandons its candidate. The unpublished `BC` is private garbage, while the old published chain still cannot be freed until readers are safe.

This race shows four distinct costs:

- allocation and abandoned work after failed CAS;
- retries under a hot logical page;
- longer reader chains while consolidation loses races;
- memory held after logical replacement but before epoch safety.

A credible benchmark records these separately. Aggregate operations per second can look healthy while one hot PID produces retry and tail-latency outliers.

### Structural modification operations

A split affects a child’s key range and parent routing. The paper uses delta-described structural modification operations, side-link/B-link ideas, and helping so an intermediate state remains searchable. The exact sequence matters: claiming that one CAS changes every involved page atomically is wrong.

Analyze:

1. which CAS is each operation’s linearization point;
2. how a reader encountering a split delta reaches the right sibling/range;
3. who installs the parent index term;
4. how helpers detect complete/incomplete work;
5. how failed CAS retries avoid duplicate structural effects.

### Epoch reclamation

Once a mapping entry no longer points to an old chain, a reader may still hold its raw address. Epoch-based reclamation defers freeing until all relevant readers have left epochs in which they could have acquired it. A stalled/unregistered thread can pin garbage; a thread that fails to announce activity can cause use-after-free.

Epoch protocol, thread lifecycle, memory allocator, crash model, and persistence layer are separate from the abstract delta-chain lookup. The LLAMA paper is one storage/cache layer associated with the original work; do not assume every product called “Bw-tree” uses the identical layer or paper revision.

**Fit indicators:**

- many-core latch contention on mutable pages is measured;
- mapping-table indirection and delta read work fit the cache/workload;
- the team can implement/test helping and reclamation correctly.

**Reject/measure carefully when:**

- simpler page ownership/latching already meets capacity;
- hot-page CAS retries or consolidation tails dominate;
- long/stalled threads pin memory;
- persistence/recovery mapping is underspecified.

## 66.5 Abstract Node Updates Without Hiding Semantics — Core

An implementation can express a logical operation separately from physical publication:

```text
logical:
  Apply(node_view, change) -> new logical contents + structural result

physical strategies:
  InPlace: lock/log/mutate existing page
  COW:     allocate replacement and return new page ID upward
  Buffer:  encode ordered message; flush later
  Delta:   allocate delta and CAS-publish at logical PID
```

This separates key ordering, split decisions, and search semantics from storage mechanics. But one interface cannot erase different obligations:

| Concern | In-place | COW | Buffer | Delta |
|---|---|---|---|---|
| publication result | same page ID/version changes | new page/root path | message accepted, leaf may lag | new chain head |
| durability record | WAL/page policy | new pages + root metadata | message/log/checkpoint | delta/log/mapping policy |
| reader view | protected/versioned page | chosen immutable root | leaf plus path messages | base plus chain |
| cleanup | dead entries/pages | obsolete versions/pages | applied messages/tombstones | consolidated chains |
| conflict | latch/version | writer/root conflict | buffer/flush coordination | CAS retry/help |

The abstraction must return enough information: new physical ID, split range/sibling, visibility version, durability dependency, and retire list. A method named `updateNode()` that conceals these cannot provide correct recovery or reclamation.

## 66.6 Worked Variant Selection — Core

Suppose a persistent embedded service stores 200 million ordered keys. Its workload is:

```text
95% snapshot point/range reads
5% updates, normally one writer
read transactions can last seconds, with a measured rare minute-long reader
crash recovery must select a valid committed state
storage budget is finite; p99 read latency matters more than peak write throughput
```

### Step 1: eliminate by binding constraints

- PostgreSQL access-method selection is not the question; this is an embedded storage-engine design.
- A Bε-tree’s buffered write benefit attacks a nonbinding 5% update rate and adds message reconciliation to reads.
- A Bw-tree attacks many-writer latch contention that the workload does not have and adds delta/reclamation complexity.
- COW aligns with snapshot readers and one writer, but the minute-long reader can pin obsolete pages.

COW is the leading hypothesis, not an automatic winner.

### Step 2: quantify one risk

Assume the writer replaces 2,000 pages/s during a burst and a 60-second reader prevents all those pages from reuse. With 16 KiB pages:

\[
2{,}000\times60\times16\text{ KiB}
=1{,}920{,}000\text{ KiB}
\approx1.83\text{ GiB}
\]

This is a worst-case illustrative bound under the assumptions, not an LMDB prediction. Transactions can share/reuse patterns, pages can vary, and some retired pages may not be pinned. It tells the team to measure pages retired by version and bound reader lifetime.

### Step 3: specify the experiment

Compare the mature baseline and COW candidate with:

- the same key/value distribution and dataset larger than memory where relevant;
- normal/burst updates plus long snapshots;
- point/range p50/p99/p99.9, not just throughput;
- logical, filesystem, and device bytes if available;
- live/reclaimable/pinned storage over time;
- commit latency under required sync settings;
- crash-at-each-commit-phase recovery tests;
- file/map/storage exhaustion behavior.

Reject COW if reader pinning violates the space objective or required durability mode produces unacceptable commit tails. Do not switch to Bw-tree merely because it is “latch-free”; revisit the actual binding constraint.

### A different workload changes the answer

If 64 writers contend on hot pages in an in-memory index and profiling shows latch wait dominates, a Bw-tree-style design becomes relevant—subject to CAS retry, chain, and epoch evidence. If storage writes dominate and updates batch broadly by key range while read amplification is acceptable, Bε becomes relevant. The method, not the brand map, is the reusable result.

## 66.7 PostgreSQL Access Methods: Choose by Predicate — Core

PostgreSQL’s index access-method framework lets an index type implement planner/executor and maintenance callbacks. Operator classes/families define which data types, operators, ordering/search semantics, and support functions work with an access method. This is an extensibility contract, not a selection of B-tree update strategies.

Always use the documentation for the deployed PostgreSQL major version and installed extension/operator class. The current documentation lists built-in B-tree, hash, GiST, SP-GiST, GIN, and BRIN access methods; capabilities depend on operator classes.

### Representative choices

| Access method | Organization/predicate shape | Main false-positive/maintenance consideration |
|---|---|---|
| B-tree | sortable values; equality/range/order under operator class | ordinary page/update/vacuum costs; collation/order semantics |
| hash | hashed key; equality | no ordered/range use; collision/recheck/size behavior by implementation |
| GiST | extensible balanced tree over bounding/penalty/consistent methods | often lossy bounding predicates require recheck |
| SP-GiST | space-partitioning framework such as tries/quad/k-d families | data distribution and operator class drive shape |
| GIN | inverted entries for component-bearing values | posting maintenance and pending-list/cleanup behavior |
| BRIN | summaries for physical block ranges | false positives and heap recheck; correlation/range granularity |

“GiST is for geometry” is too narrow; it is a framework. “GIN is for JSON” is too narrow; it indexes components under an operator class. “BRIN is a smaller B-tree” is wrong; it summarizes heap block ranges.

### Example workload

```sql
-- Ordered time predicates and ordered retrieval:
CREATE INDEX events_time_btree ON events USING btree (event_time);

-- Multi-component membership, assuming the appropriate built-in/extension
-- data type and operator class:
CREATE INDEX docs_terms_gin ON docs USING gin (terms);

-- Physically time-correlated append table; BRIN is a candidate, not a promise:
CREATE INDEX events_time_brin ON events USING brin (event_time);
```

The SQL syntax is illustrative. Whether the planner uses an index depends on query predicate, operator/operator class, statistics, selectivity, table size/layout, cost settings, visibility, and available alternatives.

### GiST

GiST is a balanced-tree framework whose operator class supplies methods such as consistency, union/bounding, penalty, pick-split, and possibly distance ordering. Internal predicates can be conservative: a branch may be visited because its bounding representation could match; the heap/index tuple can require recheck.

Choose by:

- exact operators and ordering support;
- bounding quality/overlap;
- split/penalty behavior for data distribution;
- recheck rate and fetched heap pages;
- update/build/space cost.

### SP-GiST

SP-GiST supports space-partitioned structures whose partitions need not be balanced in the B-tree sense. Tries, quadtrees, and k-d-like operator classes are representative. It can suit data with natural recursive partitioning; skew and operator-class implementation matter.

Do not infer tree balance or range-order behavior from the `GiST` substring. Verify supported operators and nearest-neighbor ordering for the operator class/version.

### GIN and pending work

GIN is an inverted index: one indexed item can yield multiple keys, each associated with postings. This fits membership/containment/search over arrays, documents, or text-like components under the operator class. Costs include key extraction, posting growth, multi-key query combination, and maintenance.

Product configuration can buffer insert work in a pending list and later merge it into the main GIN structure. That trades foreground update work against later cleanup/query/build effects. Pending-list thresholds/defaults and behavior are PostgreSQL-version/config facts; measure rather than copy a universal setting.

### BRIN

BRIN stores summaries for ranges of physical heap blocks. A min/max-style summary can eliminate a range only when its bounds prove no match; otherwise PostgreSQL scans/rechecks candidate heap ranges. It is most effective when the indexed value is correlated with physical layout and the query excludes many ranges.

Estimate:

\[
\text{candidate fraction}
=\frac{\text{heap ranges not excluded by summaries}}
{\text{total heap ranges}}
\]

Index size can be tiny while candidate fraction is near one, yielding little pruning. Measure `EXPLAIN (ANALYZE, BUFFERS)` carefully on representative data; detailed query-planner mechanics are outside this chapter.

### Workload decision flow

```text
Need ordered equality/range/output?
  -> B-tree operator class is first candidate

Equality only and hash semantics offer a measured advantage?
  -> compare hash, but retain B-tree as baseline

Value decomposes into components; membership/containment?
  -> GIN candidate

Predicate has bounding/overlap/distance semantics?
  -> GiST candidate if operator class supports it

Natural recursive space partition/trie?
  -> SP-GiST candidate

Huge table, physically correlated column, coarse pruning acceptable?
  -> BRIN candidate

No operator class for predicate?
  -> access method name alone cannot help
```

Index selection also includes no index, partial/expression/multicolumn B-tree, or extension-specific access methods. Verify with production-like distributions and maintenance workload.

### Worked PostgreSQL selection

Consider an append-heavy `telemetry` table:

```text
received_at   timestamp, strongly correlated with heap insertion order
device_id     identifier, equality predicates
tags          array-like set, containment predicates
location      geometric value, distance predicates
```

Representative queries ask for one device over a recent time range, rows containing two tags, nearby locations, and a month-wide time window over a table much larger than memory. Selection proceeds by semantics before cost:

1. `(device_id, received_at)` in a multicolumn B-tree is a candidate for equality on the leading device and a time range/order on the second key. Column order and exact query predicates matter.
2. A GIN operator class supporting the tags containment operator is a candidate for tag membership. A B-tree over the serialized array is not semantically equivalent.
3. A GiST or SP-GiST operator class supporting the required distance/ordering operator is a candidate for the spatial query. The access-method name alone does not guarantee nearest-neighbor support.
4. BRIN on `received_at` is a candidate for broad time pruning because physical correlation is expected. A narrow, selective lookup may still favor the B-tree.

The candidates are not mutually exclusive, but every extra index consumes build time, storage, cache, update work, WAL, and vacuum/maintenance effort. Test the actual combinations. For the BRIN candidate, perturb physical order and observe candidate fraction and rechecks. For GIN, include sustained ingestion long enough to exercise pending-list cleanup. For the spatial index, record lossy rechecks and heap fetches, not only index traversal time.

A result such as “BRIN was smaller” is incomplete. A defensible conclusion is conditional: under dataset D and query distribution Q, with measured correlation C and access method/operator class V, it met the latency objective while adding M bytes and U update cost. Changing ingestion order or the query operator invalidates part of that evidence.

### Measurement protocol: make deferred work visible

A variant comparison needs phases long enough to reach equilibrium and then expose recovery and cleanup:

```text
1. build/load the same logical dataset
2. warm to a declared cache state
3. run mixed foreground traffic to steady state
4. introduce skew, bursts, long readers, and storage pressure
5. stop new writes but keep measuring until deferred work drains
6. crash at selected publication/checkpoint phases and recover
7. verify logical contents and scan every reachable structure
```

Publish at least four timelines:

- foreground latency and throughput;
- physical read/write bandwidth at declared layers;
- deferred debt—retired pages, buffered messages, delta depth, pending work;
- live, allocated, reclaimable, and pinned space.

The drain phase prevents “fast writes” from meaning “work left for after the measurement.” Run the experiment long enough for several reclamation, consolidation, flush, checkpoint, or vacuum cycles. If a design relies on background bandwidth, cap that bandwidth realistically instead of letting a short benchmark consume an unrealistic idle machine.

Failure tests should cover more than successful reopen. Maintain a reference logical history, inject failure after each durable/publication transition, recover, and compare a full ordered scan plus point/range probes against an allowed committed prefix. Validate parent/child ranges, message order, delta reachability, free-space ownership, and duplicate allocation. Repeat while a structural modification and cleanup operation are in progress.

Concurrency tests need adversarial schedules:

- many threads update one hot range;
- readers pause while holding old roots, page pointers, or epochs;
- consolidators/flushers repeatedly lose races;
- allocators approach their space limit;
- a writer is terminated while owning coordination state.

Report retry distributions, maximum chain/buffer age, oldest snapshot/epoch, and time to recover after overload. A mean retry count does not reveal starvation-like outliers.

Finally, compare the simplest mature baseline under identical correctness and durability requirements. Do not disable sync for one candidate, count cache hits differently, omit WAL/device bytes from one numerator, or stop before one candidate’s maintenance phase. Record source commit, product major version, build flags, filesystem, device, kernel, and operator class. These details convert a benchmark anecdote into evidence another engineer can challenge or reproduce.

## 66.8 Comparison Matrix — Core

| Axis | COW/path copy | Bε/message buffer | Bw-tree/delta |
|---|---|---|---|
| current state | committed root/version | leaf plus ordered path messages | mapping entry’s base+delta chain |
| small update | copy affected path | append root/internal message | CAS prepend delta |
| point read | immutable path | path plus relevant buffers | chain plus base |
| range read | leaf traversal for snapshot | reconcile buffered range messages | interpret/consolidate affected chains |
| writer concurrency | design/product-specific; LMDB serializes | separate concurrency protocol required | latch-free CAS/helping in paper design |
| durability | ordered new pages + valid root/meta protocol | implementation log/checkpoint | implementation mapping/log/storage protocol |
| deferred debt | obsolete pages | buffer flush/tombstones | delta consolidation |
| reclamation hazard | old roots/readers | applied/dead messages/pages | readers holding old chains/epochs |
| hot-spot risk | writer/root/path copying | skewed child flushes | CAS retry and long chains |
| best reason to investigate | snapshot isolation/update simplicity | measured write/I/O batching need | measured latch contention/many-core need |

This is not a leaderboard. Add workload-specific rows: compression, value size, storage type, replication, recovery objective, operator/predicate, implementation maturity, and operational tooling.

## 66.9 Research and Product Reference — Reference

This section is skippable. It locates additional names without turning them into prerequisites.

### WiredTiger and lazy B-tree updates

Current WiredTiger architecture documentation describes B-tree pages with in-memory and on-disk representations; updates can be chained in memory. Reconciliation creates on-disk page images during eviction/checkpoint work. Checkpoint durability and optional commit-level logging are separately documented.

“Lazy B-tree” is a family-level description, not one universal protocol. WiredTiger is a product architecture with versions/configuration, not simply “a Bε-tree.” Its update lists/page reconciliation illustrate another way to defer or batch in-memory changes before durable page images. Checkpoint, logging, history store, eviction, and timestamps interact; consult documentation for the deployed release.

### FD-trees and fractional cascading

FD-trees are a research design for flash that organizes sorted levels and uses fractional-cascading-style pointers/fences to reduce repeated search work across levels. They resemble log-structured/run-based designs more than a single mutable page tree. Chapter 67’s LSM framework is a better foundation than memorizing the name.

The transferable question is: when data spans multiple sorted components, what metadata lets a search at one level narrow the next without a full independent search?

### Fractal trees and Bε-trees

“Fractal tree” has been used for buffered-update tree families and product/marketing lineages. A Bε-tree is a particular paper/model with stated parameters and bounds. Treat any mapping from the broad name to a concrete implementation as a source-and-version claim; do not silently transfer the Bε paper’s exact model, concurrency, or durability properties to every product carrying related terminology.

### Lazy-adaptive trees

LA-tree work explores adaptation between update buffering and more read-optimized organization. Treat exact states/algorithms/results as paper-specific. The transferable idea is to make deferred-work policy respond to workload while accounting for transition debt and instability.

### LLAMA

LLAMA is a research cache/storage subsystem associated with the Bw-tree papers. It uses logical-to-physical indirection and log-structured storage mechanisms. The original layering helps explain why the Bw-tree mapping table serves both in-memory and storage movement, but a later product may implement a different persistence layer.

### Cache-oblivious layouts

Cache-oblivious search-tree research lays out recursive subtrees, often using van Emde Boas-style recursion, to achieve asymptotically efficient block transfers without a fixed block size in the model. It is a layout/model technique orthogonal to COW, buffering, or latch freedom.

The theoretical bound assumes an idealized hierarchy/block-transfer model. Dynamic updates, persistence, virtual memory, prefetchers, cache associativity, concurrency, and constants determine product performance. Compare against a cache-aware page layout on the actual hierarchy.

### Catalog discipline

For any paper/product name, record only:

```text
problem and workload
state invariant
update publication
read reconstruction
concurrency/progress
durability/recovery
deferred maintenance/reclamation
hardware/cost model
evidence and version
```

If those cannot be stated, the name is not yet useful.

### Source anchors and version hygiene

Use primary material before repeating an architectural claim:

- PostgreSQL’s current manuals for access-method capabilities, operator classes, GIN, BRIN, GiST, SP-GiST, and the deployed major version;
- the Microsoft Research Bw-tree papers for the algorithm’s mapping table, delta records, latch-free protocol, and stated evaluation;
- the Bε-tree paper for its parameterization and external-memory bounds;
- the LMDB API/source corresponding to the exact library and file-format version in use;
- WiredTiger’s architecture and durability documentation corresponding to the embedded or standalone release and configuration.

A paper publication date is not a product version. A “current” web manual can move to a newer major release after this chapter is printed. Capture the title, revision or commit, retrieval date, relevant configuration, and the claim it supports in design notes. For a deployed system, inspect compiled features and runtime settings as well as documentation. If an implementation diverges from the paper, describe the implementation; do not repair the discrepancy by silently importing the paper’s properties.

## 66.10 Common Traps — Core

- Treating all alternatives as “B-trees with a different node layout.”
- Claiming COW makes persistence atomic without data/meta ordering, sync, validation, and recovery selection.
- Claiming every COW tree needs no WAL/log.
- Generalizing LMDB’s one-writer or memory-map API to all COW trees.
- Forgetting that long readers can pin COW pages.
- Reading only the leaf in a Bε-tree and ignoring newer buffered messages.
- Translating a Bε asymptotic I/O gain into a latency promise.
- Calling buffering a concurrency or durability protocol.
- Calling the Bw-tree free of synchronization because it is latch-free.
- Treating one CAS as the whole Bw-tree split/merge.
- Confusing delta consolidation with memory reclamation.
- Freeing a replaced delta chain while a reader can still hold it.
- Assuming the paper, a product, and a product’s current release share identical internals.
- Comparing amplification without defining the storage/cache boundary.
- Benchmarking buffered writes without draining maintenance debt.
- Selecting an exotic variant before measuring the baseline bottleneck.
- Treating GiST, SP-GiST, GIN, and BRIN as B-tree update variants.
- Choosing a PostgreSQL access method without an operator class supporting the predicate.
- Assuming a small BRIN index means selective pruning.
- Assuming GIN’s pending work is free rather than deferred.
- Calling GiST exact when its operator class can return lossy candidates requiring recheck.
- Hard-coding PostgreSQL/product defaults from another major version.
- Presenting one workload ranking as universal.

## 66.11 Recall Card — Core

```text
COMPARE
predicate/workload -> invariant -> update publication -> read obligation
-> concurrency -> durability -> maintenance/reclamation
-> read/write/space/memory amplification -> hardware assumptions -> evidence

COW
write new path -> order durability -> publish valid root/version
read immutable snapshot; old reader can pin obsolete pages
LMDB is a product case: many readers, one concurrent writer

Bε
ordered update/delete messages buffered in internal nodes
flush batches down; read reconciles path buffers + leaf
write batching trades for read/flush/tombstone debt

BW-TREE
stable PID -> mapping table -> delta chain -> base
CAS publishes delta; reads interpret chain
consolidation shortens chain; epoch/other protocol reclaims safely
latch-free != no synchronization or wait-free

STRUCTURAL CHANGE
multi-page operation needs searchable intermediate states/helping or
unreachable construction; identify publication/linearization points

POSTGRESQL
B-tree: sortable equality/range/order
hash: equality
GiST: extensible balanced/bounding framework
SP-GiST: space-partitioning framework
GIN: inverted components/postings
BRIN: physical block-range summaries and heap recheck
operator class/family determines supported predicates

LABELS
architecture | paper/model | product/release | deployment | measurement
never turn a paper result or product mechanism into a universal ranking
```

## 66.12 Questions — Core

1. Compare in-place, COW, buffered-message, and delta updates by the definition of current state.
2. Why is “publish a new root” insufficient to describe crash-safe COW persistence?
3. Derive COW path-copy bytes for a chosen height/page size, then name reasons the estimate differs from measured device writes.
4. Explain the Bε lookup invariant and why delete messages complicate reads and recovery.
5. Distinguish a Bw-tree delta’s publication, consolidation, structural modification, and reclamation.
6. When does single-writer COW fit better than a latch-free tree, even if the latter scales to more writers?
7. Contrast PostgreSQL B-tree, GiST, SP-GiST, GIN, and BRIN by predicate/organization rather than speed.
8. What evidence would show a BRIN candidate is effective for one table and workload?
9. Design an experiment comparing two variants without hiding deferred maintenance or changing durability.
10. Label each claim in a design review as architecture, paper/model, product/version, deployment, or measurement.

## 66.13 Puzzle and Exercise — Core

### Puzzle: the “atomic” COW commit

An engine writes new COW pages, writes a metadata record pointing to the new root, and reports success. After power loss, metadata is present but a child page contains old/partial data. The team says the storage violated COW atomicity.

COW protected the old tree from overwrite; it did not enforce persistence ordering or validate the new version. The commit protocol made the new root selectable before all referenced data was durably valid, or assumed unsupported atomic/writeback behavior. Recovery should retain/select the last fully valid committed root. Fix the ordering/sync/meta-integrity protocol and test crashes after every phase; do not blame the abstract tree.

### Exercise: one comparison, two decisions

Choose an update-heavy ordered key-value workload and a PostgreSQL query workload.

For the storage-engine workload:

1. define point/range/update/delete mix, values, skew, snapshots, and durability;
2. compare baseline, COW, Bε, and Bw-tree state invariants;
3. calculate one path-copy, buffer-batch, and delta-chain cost;
4. define structural-change and crash-recovery tests;
5. measure read/write/space/memory amplification and maintenance tails;
6. select one design and state its rejection/rollback evidence.

For PostgreSQL:

1. write representative equality/range/containment/nearest-neighbor or pruning queries;
2. list the available operator classes on the deployed major version;
3. select B-tree/hash/GiST/SP-GiST/GIN/BRIN candidates by predicate;
4. populate production-like distributions and physical correlation;
5. compare plans, buffers, rechecks, build/update/space, and query distributions;
6. include “no index” and a partial/expression/multicolumn alternative.

Do not claim the storage-engine winner predicts the PostgreSQL access-method winner. They answer different questions.

## Prerequisite for Chapter 67 — Core

You are ready for log-structured storage when you can explain how buffering converts per-update work into deferred batch/merge work; distinguish update, read, and space amplification by layer; account for tombstones and maintenance debt; and avoid calling every multi-level sorted design a B-tree variant. Chapter 67 develops memtables, immutable runs, compaction, and LSM tradeoffs.
