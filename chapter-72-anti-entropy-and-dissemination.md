# Chapter 72 — Anti-Entropy and Dissemination

## 72.0 Why This Changes the Decision — Core

Leaderless replication accepts that replicas can temporarily disagree. That
choice is useful only if the system can later:

1. tell equal from divergent state;
2. determine which states dominate, conflict, or represent deletion;
3. transfer only what is missing;
4. spread membership and repair knowledge without one indispensable sender;
5. prevent old values from returning after deletion.

The chapter follows that chain:

```
missed write → version/digest comparison → hot-key repair
             → range/Merkle repair       → cold-key repair
             → gossip dissemination      → decentralized reach
             → tombstone-safe cleanup    → no resurrection
```

Chapter 71 owns quorum intersection, consistency models, conflict-resolution
families, and CRDT theory. Here versions and merge functions are inputs to the
repair layer. Anti-entropy can make replicas agree on a wrong or lossy resolver;
it does not upgrade the consistency model.

### Claim labels

- **[Protocol/model]** follows only under the stated network, failure, peer
  selection, version, merge, and stopping assumptions.
- **[Probability/model]** is a probability or expectation in a named stochastic
  model, not a per-run deadline.
- **[Implementation]** is one possible design rather than a protocol theorem.
- **[Cassandra 5.0/configuration]** describes the cited Apache Cassandra 5.0
  behavior; exact repair, read-repair, hint, tombstone, and gossip behavior is
  product/version/configuration dependent.
- **[Measured]** bandwidth, convergence time, tree cost, and operational
  thresholds require a named dataset, workload, topology, and failure pattern.

---

## 72.1 90-Second Screen — Core

Seven facts:

1. A missed replica write is not automatically repaired by waiting. Convergence
   needs repeated delivery or explicit comparison plus a deterministic,
   inflationary merge/winner rule.
2. Hinted handoff covers many short outages but is best effort. A hint may
   expire, be lost with its holder, become obsolete, or fail replay.
3. Read repair discovers divergence only for keys and replicas actually read.
   It is valuable for hot data and cannot guarantee cold-data convergence.
4. Merkle trees summarize canonical key ranges. Comparing already-built equal
   roots is O(1); building, updating, snapshotting, and validating the trees is
   not. A mismatching leaf identifies a range to compare/stream, not necessarily
   one bad record.
5. Gossip is redundant randomized dissemination. Its round/message behavior
   depends on peer sampling, fanout, topology, loss, churn, push/pull mode, and
   stopping rule. “O(log n) rounds” is a model result, not an operational SLA.
6. Deletion must replicate as a versioned tombstone. Garbage-collect it only
   after the system can exclude every older live copy, or that copy can
   resurrect the value.
7. A repair job is a distributed operation: pin ownership/schema/version
   context, handle concurrent writes, throttle streams, checkpoint progress,
   retry idempotently, and verify the result.

One layered answer:

| Gap | First response | Backstop |
|---|---|---|
| replica briefly unavailable | hint replay/direct retry | range repair |
| hot key differs | digest/full read and read repair | range repair |
| cold key differs | scheduled Merkle/range repair | rebuild/restore |
| hint lost or expired | none on hint path | range repair |
| membership fact missed | repeated gossip/pull | seed/control-plane reconciliation |
| stale live value after delete | retained tombstone + repair | restore/rebuild if tombstone was purged too early |

---

## 72.2 Failure Walkthrough: How Replicas Diverge — Core

Assume a key range is owned by replicas A, B, and C. Version comparison and
conflict resolution are already defined as required by Chapter 71. The client
writes `K = blue` with version `v7`:

```
time     A                 B                 C              hint holder H
t0       K=red,v6          K=red,v6          K=red,v6       —
t1       apply blue,v7     apply blue,v7     unreachable    store hint(C,K,v7)
t2       client receives success under the chosen write policy
t3       H loses disk before replay
t4       C returns: red,v6
```

The accepted write and its exact acknowledgment policy belong to Chapter 71.
For anti-entropy, the important facts are:

- A and B have a state that dominates C under the chosen version rule.
- C does not know it missed anything.
- no message is still guaranteed to deliver `v7` because the hint was lost;
- a read contacting A and C can discover and repair this hot key;
- if `K` remains cold, scheduled range repair must find it.

Divergence also arises from timeouts whose writes actually applied, process
crashes between local persistence and reply, network partitions, restored old
snapshots, node replacement, ownership movement, operator error, disk loss, and
concurrent writes. Repair must distinguish:

| Relationship | Meaning | Safe action |
|---|---|---|
| equal version and equal canonical content | replicas agree | none |
| one version dominates | one state supersedes the other | propagate dominant state |
| versions concurrent | neither supersedes the other | retain siblings or apply the declared deterministic merge |
| same version, different content | invariant/protocol corruption | quarantine and investigate; do not choose arbitrarily |
| state absent on one side | could mean never written, missed write, or purged tombstone | compare version/retention/ownership evidence |

An unversioned digest can say bytes differ but not which state is valid. A
timestamp can totally order values but may discard causally concurrent writes
and depends on its clock policy. Anti-entropy therefore transports the product's
version and deletion semantics; it does not invent them.

### Divergence has several clocks

Track separate durations:

- **write gap:** time from one replica accepting an update until every intended
  replica has it;
- **detection latency:** time until any mechanism notices the mismatch;
- **repair latency:** time from detection until all selected targets durably
  apply it;
- **verification latency:** time until a later comparison confirms agreement;
- **exposure:** number and policy of reads that could observe an older or
  conflicting state during the gap.

A low average repair latency can hide a cold-key tail. Read repair makes popular
keys converge quickly while keys never read depend entirely on background range
coverage. Report the oldest unrepaired range/version horizon, not only repair
throughput.

Classify root causes because remediation differs:

| Cause | Evidence | Response |
|---|---|---|
| transient delivery miss | timeout plus later healthy target | retry/hint, then verify |
| target outage/partition | failure interval and hint backlog | controlled replay + range repair |
| coordinator ambiguity | client timeout, some replica versions advanced | idempotent retry/read resolution |
| disk/page corruption | checksum/I/O error or same version with bad bytes | isolate, reconstruct from verified sources |
| stale snapshot rejoin | replica incarnation/data horizon behind cluster | fence and rebuild, not ordinary trickle repair |
| topology race | data on old/new owner sets differ by epoch | ownership-aware bootstrap/cleanup |
| resolver/schema mismatch | peers interpret equal input differently | stop repair and fix compatibility |

Repair is unsafe when nodes disagree on the meaning of a version or value. More
bandwidth merely spreads the disagreement faster.

### Explicit convergence assumptions

One useful convergence statement is:

> After updates stop, all live replicas for a range eventually reach the same
> state if every relevant state is retained, the merge is deterministic and
> convergent, every divergent range is compared fairly often, messages
> eventually get through often enough, and repair keeps retrying.

Spell out the assumptions:

- ownership/schema/partitioning epoch is stable, or repair uses a protocol that
  accounts for transitions;
- replicas that are permanently lost are rebuilt from an authoritative live
  set rather than returning indefinitely with stale storage;
- version comparison and merge are deterministic; for state-based convergence,
  merge is typically associative, commutative, and idempotent;
- deletes remain represented until every older copy is repaired or excluded;
- digest collisions are acceptably unlikely or confirmed by finer comparison;
- peer/range scheduling is fair—no replica or cold range is starved forever;
- there is an eventual period in which useful communication and storage
  capacity are available;
- repair messages are idempotent or deduplicated and failed jobs resume.

Continuous partitions, unbounded churn, unbounded new writes, Byzantine peers,
premature tombstone collection, inconsistent resolvers, or a scheduler that
never selects a range invalidate that statement. Eventual consistency has no
universal deadline.

---

## 72.3 The Layered Repair Stack — Core

No single mechanism covers all failure windows:

```
write path:  direct fanout ──miss──> durable hint ──loss/expiry──┐
                                                                │
read path:   digest/full read ──mismatch──> read repair          │
                 (only keys/replicas touched)                    │
                                                                ▼
background:  snapshot range → summaries/Merkle → stream/merge → verify
                              (cold-data backstop)
```

| Mechanism | Trigger | Coverage | Main cost | Gap left |
|---|---|---|---|---|
| direct retry | write timeout | one mutation/target | write latency/load | retries can end |
| hinted handoff | missed write, target later returns | recorded recent misses | hint disk and replay traffic | lost/expired/unrecorded hints |
| read repair | read observes differing versions/digests | read key + contacted replicas | read latency and repair writes | cold keys/uncontacted replicas |
| range/Merkle repair | scheduled/manual discrepancy check | selected range/replica set | scans, hashing, streaming, compaction | ranges not scheduled/completed |
| rebuild/bootstrap | lost or replaced replica | assigned ranges from sources | large transfer and validation | bad source/transition race |
| gossip | periodic peer exchange | membership/summaries/rumors selected for gossip | duplicate messages/state | finite rumor may die out |

Layering is not redundant waste. Each mechanism shortens a different
inconsistency window, while scheduled full coverage prevents best-effort paths
from becoming correctness assumptions.

---

## 72.4 Versions, Digests, and Compact Summaries — Core

### Compare versions before payloads

A record comparison normally considers:

```
key + version/causal metadata + tombstone/expiry + canonical value
```

If one version dominates, repair can transfer the winner. Concurrent versions
must be retained or merged by the Chapter 71 policy. A tombstone participates
as a value with a version; “missing” is not equivalent to “deleted.”

A digest is a compact fingerprint. It is useful at three scales:

- value digest on a read path;
- bucket/range digest for repair;
- tree root/interior digest for hierarchical localization.

Both peers must hash the same canonical representation, range boundary,
snapshot point, schema, comparator, tombstone treatment, and hash algorithm.
Otherwise equal logical state can hash differently, or unequal state can be
omitted from coverage.

Hash equality is evidence with collision probability determined by the
algorithm and adversary model. Non-cryptographic hashes may be fine for
accidental mismatch localization with full comparison before destructive
action; hostile peers or corruption threats may need cryptographic hashes/MACs.

### Digest reads and read repair

An **[Implementation]** coordinator may request one full value and digests from
other read replicas:

```
A → full(K,v,payload)
B → digest(canonical K,v,payload)
C → digest(canonical K,v,payload)
```

If digests match the full response, payload transfer is saved. On mismatch, the
coordinator fetches enough full versioned states to resolve correctly, returns
according to the read policy, and may repair stale respondents.

Do not universalize this sequence. Which replicas return data or digests, when
repair blocks the client, how ranges/partitions are reconciled, and what
consistency property follows are product/version/configuration details. A read
that contacts two of three replicas cannot repair the third. An asynchronous
repair can fail after the client response. A digest of a filtered query must
cover exactly the data whose agreement is claimed.

### Bitmap version summaries

A per-origin scalar “largest sequence seen” is compact only when receipt is
contiguous. Out-of-order delivery creates holes. A bitmap summary can encode:

```
origin X:
  contiguous base = 103
  bitmap for 104..111 = 0 1 0 1 0 0 0 0
                              ^   ^
                         have 105,107
```

The peer can request 104 and 106 without retransmitting 105 and 107. When 104
arrives, the contiguous base can advance through any now-complete prefix.
Window size bounds metadata; events older than retained history require a
snapshot/range repair. This is not the same as a causal version vector:

- a version vector summarizes causal progress by origin;
- a bitmap/window records holes in a bounded sequence space;
- neither contains missing payloads;
- counter reuse, origin reincarnation, wraparound, and membership changes need
  epochs/identities;
- a summary claiming receipt is safe only after the corresponding state is
  durably incorporated under the protocol.

### Summary validity is protocol state

Cacheable summaries need invalidation rules. Tag a range digest with:

```
(range, ownership_epoch, schema_epoch, snapshot_horizon,
 canonical_encoder, hash_algorithm, generation)
```

It is comparable only to a summary with compatible tags. A crash between
applying a record and updating a persisted digest can create false equality or
a false mismatch unless both changes share an atomic log/rebuild protocol.
Common choices are:

- build summaries from an immutable snapshot for each repair;
- maintain a tree transactionally with data mutations;
- mark affected leaves dirty and recompute before comparison;
- treat cached summaries as hints, then verify records before completion.

Incremental summaries also require retained history. If A says “all events
through 50,000” but discarded the event log, B cannot fetch event 49,000 from
A even if the summary exposes the gap. It needs a snapshot or another source.
Metadata reduces discovery bandwidth; it does not create missing history.

Compression, encryption, and nondeterministic serialization can make physical
bytes differ for equal logical values. Decide whether a digest protects stored
representation or canonical logical state. The former detects storage
differences; the latter supports logical reconciliation. Some designs keep both.

---

## 72.5 Merkle Trees: Localize Before Streaming — Core

A Merkle tree partitions a canonical ordered key space into leaves. Each leaf
hashes records in its range; each parent hashes its ordered child hashes:

```
                    H(0..15)
                 /             \
            H(0..7)             H(8..15)
           /      \             /       \
       H(0..3) H(4..7)     H(8..11) H(12..15)
```

Two replicas compare roots:

- equal roots: the covered snapshots are probably equal under the hash model;
- unequal roots: compare children and descend only into mismatching branches;
- mismatching leaves: exchange finer summaries or versioned records for those
  key/token ranges, merge, then verify.

### Cost without slogans

Comparing two already-built root hashes is O(1). Constructing a tree from `M`
records is at least proportional to reading/canonicalizing the covered state in
a simple implementation. Incremental maintenance shifts work onto writes and
must remain consistent with compaction, tombstones, snapshots, and crashes.

For a balanced binary tree with fixed leaf boundaries, locating `d` sparse
mismatching leaves often compares far fewer than all leaves, but “O(d log M)”
is only a useful model under assumptions about balance, resolution, and
non-overlapping paths. Shared paths reduce comparisons; coarse leaves cause
overstreaming; widespread divergence approaches full comparison/transfer.

Tree memory sets resolution. If one leaf represents a million records, one
different record makes the whole leaf suspect. A second record-level exchange
can avoid streaming the entire bucket, at extra reads/rounds.

### Snapshot and ownership requirements

Peers must compare like with like:

- identical token/key boundaries and ownership epoch;
- compatible schema, partitioner, comparator, and canonical encoder;
- a stable snapshot or logical cut, or a protocol that tolerates concurrent
  mutation;
- all relevant live values, versions, tombstones, and expirations;
- agreed tree shape/hash algorithm.

If A hashes before `v9` and B hashes after `v9`, a mismatch may be legitimate
concurrency rather than lost data. Repairs should stream versioned states and
merge, not blindly overwrite a range image. After topology change, an old tree
for different ownership cannot prove current replicas agree.

### Worked Merkle comparison

Replicas cover 16 keys with one key per leaf. A and B differ at keys 2 and 13.
Using interval notation, comparison visits:

```
[0,16) mismatch                                      1
  [0,8) mismatch, [8,16) mismatch                    2
  [0,4) mismatch, [4,8) equal                        2
  [8,12) equal, [12,16) mismatch                     2
  [0,2) equal, [2,4) mismatch                        2
  [12,14) mismatch, [14,16) equal                    2
  [2,3) mismatch, [3,4) equal                        2
  [12,13) equal, [13,14) mismatch                    2
                                                     —
                                          15 hash comparisons
```

A flat leaf comparison would compare 16 leaf hashes; full data comparison would
inspect all 16 records. This tiny example saves little. With many leaves and
few differences, high-level equal branches prune large ranges. The calculation
is not a universal complexity bound: a different arity, batch protocol, cached
nodes, or mismatch distribution changes it.

The actual transfer is two versioned records only if leaves are single-key and
the merge finds one winner each. With four-key leaves and no finer exchange,
up to eight records/range contents may be inspected or streamed—overrepair
caused by summary granularity.

### Tree arity and lifecycle

Binary trees make the worked descent easy to see. Higher arity shortens height
but sends more child hashes at a mismatching node. If hashes are `h` bytes and a
node has arity `b`, expanding it transfers roughly `b × h` digest bytes plus
framing. The optimum depends on mismatch clustering, round-trip latency, tree
memory, and batch size; it is **[Measured]**.

Fixed range boundaries let independently built trees align, but skew can put
most data in one leaf. Equal-count boundaries improve balance but require peers
to agree on split points despite missing keys. Token subranges, histograms, or a
negotiated partition plan are alternatives. Never compare child position 3 on
A with position 3 on B unless both cover the same interval.

A tree can be:

- built on demand by scanning an immutable storage snapshot;
- cached per immutable storage component and composed;
- incrementally updated with each mutation;
- periodically rebuilt under a snapshot sequence.

On-demand builds spend read I/O and CPU during repair. Incremental trees make
comparison fast but add write amplification, persistence/recovery complexity,
and dirty-state handling. Trees age after compaction, tombstone purge, schema
change, ownership movement, or a hash upgrade.

Use the hierarchy for localization. Before streaming or deleting, compare
versioned records in the mismatching range. After repair, rebuild/invalidate
affected summaries and compare again at a clearly identified horizon.

---

## 72.6 Compact Validated C++23 Model — Core

The model below uses a toy totally ordered version `(counter, writer)` and
versioned tombstones. It builds deterministic range hashes, descends to
mismatching keys, repairs both sides, and verifies convergence. It deliberately
does not model concurrent siblings or production cryptographic hashing.

```cpp
#include <algorithm>
#include <cassert>
#include <compare>
#include <cstdint>
#include <map>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <vector>

struct Version {
    std::uint64_t counter{};
    std::uint32_t writer{};
    auto operator<=>(const Version&) const = default;
};

struct Record {
    Version version;
    bool tombstone{};
    std::string value;
    bool operator==(const Record&) const = default;
};

using State = std::map<std::string, Record>;

void hash_byte(std::uint64_t& h, std::uint8_t b) {
    h ^= b;
    h *= 1'099'511'628'211ull; // FNV-1a step: illustrative, not adversarial
}

template<class T>
void hash_uint(std::uint64_t& h, T value) {
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        hash_byte(h, static_cast<std::uint8_t>(value >> (8 * i)));
    }
}

void hash_text(std::uint64_t& h, std::string_view text) {
    hash_uint(h, std::uint64_t{text.size()});
    for (unsigned char c : text) hash_byte(h, c);
}

void hash_record(std::uint64_t& h, std::string_view key,
                 const Record* record) {
    hash_text(h, key);
    hash_byte(h, record ? 1 : 0); // distinguish absent from tombstone
    if (!record) return;
    hash_uint(h, record->version.counter);
    hash_uint(h, record->version.writer);
    hash_byte(h, record->tombstone ? 1 : 0);
    hash_text(h, record->value);
}

std::uint64_t range_hash(const State& state,
                         std::span<const std::string> keys,
                         std::size_t first, std::size_t last) {
    std::uint64_t h = 14'695'981'039'346'656'037ull;
    hash_uint(h, std::uint64_t{last - first});
    for (std::size_t i = first; i < last; ++i) {
        const auto it = state.find(keys[i]);
        hash_record(h, keys[i], it == state.end() ? nullptr : &it->second);
    }
    return h;
}

void find_differences(const State& a, const State& b,
                      std::span<const std::string> keys,
                      std::size_t first, std::size_t last,
                      std::vector<std::string>& out) {
    if (range_hash(a, keys, first, last) ==
        range_hash(b, keys, first, last)) return;
    if (last - first == 1) {
        out.push_back(keys[first]);
        return;
    }
    const std::size_t mid = first + (last - first) / 2;
    find_differences(a, b, keys, first, mid, out);
    find_differences(a, b, keys, mid, last, out);
}

const Record* lookup(const State& s, const std::string& key) {
    const auto it = s.find(key);
    return it == s.end() ? nullptr : &it->second;
}

bool reconcile_key(State& a, State& b, const std::string& key) {
    const Record* left = lookup(a, key);
    const Record* right = lookup(b, key);
    if (!left && !right) return true;
    if (!left) { a[key] = *right; return true; }
    if (!right) { b[key] = *left; return true; }

    if (left->version == right->version) {
        return *left == *right; // same version/different content is corruption
    }
    const Record winner =
        left->version > right->version ? *left : *right;
    a[key] = winner;
    b[key] = winner;
    return true;
}

std::vector<std::string> key_union(const State& a, const State& b) {
    std::set<std::string> keys;
    for (const auto& [key, _] : a) keys.insert(key);
    for (const auto& [key, _] : b) keys.insert(key);
    return {keys.begin(), keys.end()};
}

int main() {
    State a{
        {"alpha", {{1, 1}, false, "red"}},
        {"beta",  {{4, 1}, true,  ""}},     // deletion
        {"gamma", {{3, 2}, false, "green"}}
    };
    State b{
        {"alpha", {{1, 1}, false, "red"}},
        {"beta",  {{2, 2}, false, "obsolete"}}
        // gamma was missed
    };

    const auto keys = key_union(a, b);
    std::vector<std::string> differing;
    find_differences(a, b, keys, 0, keys.size(), differing);
    assert((differing == std::vector<std::string>{"beta", "gamma"}));

    for (const auto& key : differing) {
        assert(reconcile_key(a, b, key));
    }
    assert(a == b);
    assert(a.at("beta").tombstone); // old beta did not resurrect
    assert(range_hash(a, keys, 0, keys.size()) ==
           range_hash(b, keys, 0, keys.size()));
}
```

Compile and run:

```bash
clang++ -std=c++23 -O2 -Wall -Wextra -Wpedantic repair_model.cpp
./a.out
```

This teaching implementation recomputes range hashes repeatedly, so its local
CPU work is worse than a maintained tree. That is intentional: it validates the
canonicalization and descent logic without pretending cached-tree construction
is free. A production implementation needs snapshot integration, bounded
memory/work, strong hash selection, typed corruption errors, streaming,
checkpointing, and a resolver for concurrent versions.

---

## 72.7 Hinted Handoff and Read Repair — Core

### Hints shorten transient gaps

When target C is unavailable, a coordinator can durably record:

```
Hint {
  destination replica/epoch,
  key or mutation,
  original version,
  creation/expiry metadata,
  schema/serialization version,
  integrity check
}
```

After C returns, the holder streams hints with throttling. Applying the original
version makes replay idempotent under the record resolver; inventing a new
version at replay time could overwrite a later write.

Failure windows:

| Window | Consequence |
|---|---|
| target applies write but reply is lost | hint/retry duplicates; idempotent version handles it |
| client acknowledged before hint is locally durable | accepted gap may have no hint |
| hint durable, holder fails permanently | hint is lost unless replicated/recoverable |
| target stays down beyond retention | new hints may no longer be recorded; full repair required |
| topology/schema changes before replay | destination and mutation need epoch/version validation |
| replay floods recovering target | recovery can fail again; throttle/backpressure/jitter |
| newer target value exists | old hinted version must lose under the resolver |

Hints consume disk and can form a replay storm after a long outage. They are an
optimization for the common transient case, not proof that scheduled repair is
unnecessary.

### Read repair covers observed replicas

On a read, a coordinator compares versioned responses or digests, fetches
needed full states, resolves them, and may send the result to stale respondents.
Blocking until some repair writes finish increases latency and may support a
product's particular read guarantee; asynchronous repair reduces client delay
but can fail later.

Do not infer universal semantics from the name “read repair.” State:

- consistency/read policy and contacted replicas;
- data/digest request pattern;
- resolver for domination/concurrency/tombstones;
- whether the response waits for repairs and which acknowledgments;
- behavior on timeout or digest collision/mismatch;
- whether uncontacted replicas are repaired.

**[Cassandra 5.0/configuration]** Apache Cassandra documents hints and read
repair as best-effort mechanisms and full/incremental anti-entropy repair as the
backstop. Exact options and defaults change; consult the documentation and live
configuration rather than memorizing a historical chance or mode.

---

## 72.8 Tombstones: Repairing Absence Safely — Core

A physical absence carries no version. If A deletes `K` by erasing it while C
is offline, later repair sees:

```
A: absent          C: K=red,v6
```

It cannot distinguish “A never had K” from “A deleted K after v6.” The live
copy can spread back. Instead write a tombstone:

```
A: TOMBSTONE(K,v7)     C: K=red,v6
```

`v7` dominates `v6`, so repair propagates deletion. Reads hide the tombstone
from application results while storage and repair retain it.

### The resurrection window

```
t0  C goes offline with K=v6
t1  A/B accept tombstone v7
t2  hint expires or is lost
t3  A/B garbage-collect tombstone v7
t4  C returns with v6
t5  repair sees live v6 versus absence → v6 may resurrect
```

Safe garbage collection requires evidence stronger than elapsed wall time:

- every replica that could hold an older version was repaired after the delete;
- permanently missing replicas are fenced/rebuilt rather than rejoining with
  old storage;
- snapshots, backups, hints, queues, and new ownership transfers cannot
  reintroduce the old version without the tombstone;
- repair completion is trustworthy for the relevant range/epoch;
- clock/TTL assumptions are satisfied if time participates.

Some products approximate this with a grace/retention interval longer than the
maximum expected outage and repair interval. That is an operational assumption,
not a theorem. Longer retention increases read/compaction/storage cost; shorter
retention increases resurrection risk.

**[Cassandra 5.0/configuration]** Tombstone purging depends on table
`gc_grace_seconds`, compaction state/strategy, repaired status and related
options. Official repair guidance ties repair scheduling to the tombstone
retention policy. Do not claim “tombstones disappear exactly after N days” or
copy a default across versions/tables.

Range tombstones, TTL expiry, and partition deletion make coverage more complex:
the anti-entropy digest must include deletion state that suppresses older cells.
Repairing only visible live rows is incorrect.

---

## 72.9 Gossip and Epidemic Dissemination — Core

Gossip disseminates a fact without requiring its originator to contact every
node. Periodically, each node samples one or more peers and exchanges rumors,
version summaries, or state digests. Multiple paths tolerate individual loss
and temporary failure.

Separate two uses:

- **membership/control gossip:** liveness suspicions, endpoint state, schema or
  topology metadata;
- **data anti-entropy:** summaries or actual replicated data.

A product may use gossip for membership while Merkle streaming repairs user
data. Hearing that C is alive can trigger hint replay; gossip did not itself
deliver every missed row.

### Push, pull, and push-pull

| Mode | Exchange | Strength | Weakness |
|---|---|---|---|
| push | informed node sends newer facts | rapid early spread | uninformed tail may be missed; duplicates |
| pull | node asks peer for what it lacks | good at finding late/missed nodes | early spread waits for uninformed nodes to sample informed ones |
| push-pull | both exchange summaries/deltas | strong early and tail behavior | more bytes/work per contact |

Messages should carry identities/versions and be idempotent. Bound rumor state
with acknowledgments, age, counters, or summaries, but every finite stopping
rule admits some probability that a live node never received a rumor. Periodic
pull or full reconciliation supplies the backstop.

### Why convergence is probabilistic

Random peer selection can repeatedly choose already-informed peers. Loss and
churn add more misses. A stochastic analysis describes a distribution over
runs; it cannot say a particular run completes by a fixed round unless the
protocol adds deterministic coverage or an external deadline/fallback.

Under a simplified push model:

- `N` nodes are all mutually reachable;
- `I` informed nodes each choose `f` targets independently and uniformly from
  the other `N-1` nodes;
- messages in the round are delivered;
- targets become informed after the round.

For one uninformed node, the probability of no contact in that round is:

```
P(not contacted) = (1 - 1/(N-1))^(fI)
```

With `N=8`, `I=4`, `f=1`:

```
P(contacted) = 1 - (6/7)^4 ≈ 0.4602
expected newly informed = (8-4) × 0.4602 ≈ 1.84
```

This is an expectation under independent uniform choices, not a guarantee that
two nodes join in the next round. Targets chosen by the same sender may be
without replacement; real partial views are nonuniform; messages are lost;
nodes have capacity limits. Recompute for the actual model.

An ideal duplicate-free doubling trace can inform 8 nodes from one in three
rounds:

```
round 0: A
round 1: A→B                                  2 informed
round 2: A→C, B→D                             4 informed
round 3: A→E, B→F, C→G, D→H                   8 informed
```

Random gossip usually includes duplicate contacts, so this is a lower-bound
illustration for that ideal schedule, not a universal `ceil(log2 N)` deadline.

### Conditions for durable dissemination

Convergence needs peer sampling whose time-varying communication graph connects
the live membership, continued rounds or a safe stopping rule, eventual message
delivery opportunities, bounded overload, retained facts/summaries, and
compatible merge rules. A partitioned subgroup cannot learn facts while cut
off; after healing, pull/anti-entropy must bridge it.

Failure detectors provide suspicions, not perfect membership truth. Excluding a
slow live peer forever can violate fairness. Including dead peers forever wastes
contacts. Chapter 69 owns detector thresholds and actions.

### Rumor lifetime, duplicates, and overload

A gossip item needs an identity such as `(origin_incarnation, sequence)` and a
merge rule. Receivers remember enough IDs or version summaries to suppress
duplicate work. If deduplication state expires before old messages, the
operation must remain idempotent.

Three stopping patterns have different semantics:

- **fixed rounds/forward count:** bounds traffic, but leaves a nonzero miss
  probability under the model;
- **acknowledgment-based:** stronger evidence for named members, but membership
  changes and acknowledgments can be lost;
- **continuous anti-entropy:** no per-rumor completion point; periodic summaries
  rediscover omissions while consuming steady traffic.

Many systems combine a finite eager rumor with continuous pull. A newly joined
or long-partitioned node cannot rely on rumors whose lifetime ended before it
appeared; it must bootstrap a snapshot and reconcile a version horizon.

Gossip is not free during an incident. A topology change can generate large
state while packet loss causes retries and partial views retain dead peers.
Bound message size, prioritize freshness, coalesce superseded versions,
rate-limit rounds, and add backpressure. Dropping an old rumor is safe only if
a pull/snapshot path can recover it. Observe duplicate ratio, bytes per useful
update, peer-sampling bias, convergence quantiles, stale-view age, and the
nonconverged fraction under the chosen stopping rule.

Security also matters. A forged membership rumor can redirect traffic or evict
healthy peers. Authenticate peers/messages when required, bind versions to node
incarnations, prevent replay across clusters, and rate-limit announcements.
Epidemic redundancy amplifies malicious input as efficiently as legitimate
input.

---

## 72.10 Repair as an Operational Protocol — Core

A scheduled repair is not just “run Merkle trees.” A robust range session has:

```
plan → snapshot/validation summaries → compare → stream versioned differences
     → apply idempotently → verify → checkpoint completion
```

### Plan and fence context

Record:

- keyspace/table/range and replica set;
- topology/ownership and schema epochs;
- partitioner/comparator/canonicalization/hash versions;
- full versus incremental scope and prior repair metadata;
- tombstone/TTL horizon;
- source selection and failure policy;
- resource budgets and job identity.

If ownership changes mid-session, either coordinate/fence the transition or
restart/replan affected ranges. Marking an obsolete replica set “repaired” can
leave the new owner stale.

### Stream and apply

Range streaming competes with foreground disk, network, CPU, memory, cache, and
compaction. Limit concurrent sessions and bytes, use backpressure, and expose:

- ranges planned/compared/verified;
- bytes scanned/hashed/streamed;
- mismatching leaves/partitions;
- retries, failures, and checkpoint age;
- per-peer backlog and throughput;
- oldest unrepaired range relative to tombstone retention;
- overstreaming ratio and foreground latency impact.

Repair messages must carry original versions and tombstones. Concurrent writes
may occur after the snapshot; applying streamed records via the normal resolver
prevents an old snapshot value from overwriting a newer local one. Bulk file
replacement needs stronger snapshot/fencing rules.

### Full, incremental, and verification

- **full repair** reconsiders all selected data and can detect old divergence or
  some corruption, at high scan/stream cost;
- **incremental repair** uses metadata to limit work since earlier successful
  sessions, but depends on that metadata and implementation invariants;
- **preview/validation** builds/compares summaries without streaming, useful for
  estimating or checking, but does not heal data.

Definitions and exact behavior are product-specific. A failed incremental
session must not advance completion metadata for unfinished ranges. Periodic
full verification can catch gaps outside incremental assumptions.

### Restartable repair state machine

Persist progress at a retryable unit:

```
PLANNED
  → SNAPSHOTTED(summary IDs/horizons)
  → COMPARED(mismatching subranges)
  → STREAMING(per-peer checkpoints)
  → APPLIED(original versions)
  → VERIFIED(new compatible summaries)
  → COMPLETE
```

Failure windows:

| Crash/failure | Safe restart |
|---|---|
| after plan, before snapshot | revalidate epochs and resnapshot |
| after one peer snapshots | expire the partial session or obtain compatible horizons |
| after compare, before stream | reuse only while source snapshots/history remain pinned |
| midway through stream | resume by chunk ID/version; duplicates must be harmless |
| after apply, before checkpoint | resend; resolver/idempotency prevents regression |
| after stream, before verification | verify; bytes-sent is not completion |
| after verification, before completion record | repeat or atomically publish verification evidence |

A completion record should name job ID, ranges, every replica incarnation,
ownership/schema epochs, snapshot/version horizons, hash/canonicalization
versions, stream results, verification roots, and completion time. “Last repair
Tuesday” is too weak to decide whether a tombstone for one range may be purged.

### Source selection and disagreement

With three replicas, repair is not always “copy from A.” If A dominates B and C,
A is an obvious source. If A and B are concurrent, preserve/merge both. If two
replicas report the same version with different content, majority voting may
mask deterministic corruption or a software bug; quarantine the range and
preserve evidence.

For bulk rebuild, select sources by range ownership, durable version/log
horizon, integrity, failure domain, and load. Verify chunks end to end and the
completed range structurally. A checksum-valid source can still be stale.
Cross-datacenter policies may intentionally limit traffic, but then the
convergence claim must name the replica set covered.

### Cancellation and admission control

Repair should yield to survival. Before admitting work, estimate snapshot
space, tree memory, read I/O, outgoing/incoming streams, compaction debt, and
the target's ability to ingest. Reserve capacity for foreground requests and
failure recovery. A node that is already rebuilding should not become the
source for every other repair merely because it responds.

Cancellation also needs semantics. Stopping comparison is harmless if no
completion state advances. Stopping a stream leaves a prefix applied; original
versions make a later restart safe, but pinned snapshots and temporary files
must be released or retained by an explicit lease. Never roll back by writing
the source snapshot over newer target values.

Schedule for correlated failures: running all replica-pair repairs for the same
range simultaneously may concentrate reads on one disk or remove all failure
headroom. Stagger ranges/failure domains, randomize starts, and bound retries.
Exponential backoff without a maximum repair-age alert can quietly violate the
tombstone horizon, so pair backoff with a deadline/escalation derived from the
retention contract.

Operational success has three layers:

1. the command/process finished;
2. every planned range reached a durable verified state for the named epoch;
3. the fleet completed all required coverage before its safety horizon.

Only the latter two justify convergence or tombstone-GC claims.

### Repair scheduling calculation

Suppose tombstones are eligible for collection after a configured retention
`G`, the worst planned node outage is `D`, one full repair cycle takes `R`, and
alert/operator recovery margin is `M`. A necessary planning inequality in this
simplified policy is:

```
D + R + M < G
```

It is not sufficient: jobs can fail, clocks/compaction interact, coverage can
be incomplete, and restored snapshots may be older. If `D=24 h`, `R=30 h`, and
`M=12 h`, then the plan needs `G > 66 h`; choosing 72 h leaves only 6 h of
unmodeled margin. Measure actual high-percentile repair completion and alert
before the margin is consumed. Do not import these numbers as defaults.

---

## 72.11 Overlay and Product Reference — Skippable

### Partial views and hybrid overlays

All-to-all membership costs grow with cluster size. A **partial view** keeps a
bounded set of peers and refreshes it through sampling/shuffling. The overlay
must remain connected under churn and avoid correlated neighborhoods. Metrics
include component count, path length, peer diversity, stale/dead entries, and
sampling bias.

A broadcast tree has low duplicate traffic but a failed interior node cuts a
subtree until repair. Unstructured gossip is redundant but wasteful. Hybrid
protocols can use an eager tree for first delivery and lazy gossip/digests to
detect and repair omissions. Research systems such as Plumtree and HyParView
illustrate these designs; their guarantees depend on their precise algorithms,
failure model, and parameters. They are role-specific, not requirements for
operating ordinary database repair.

### Cassandra 5.0 orientation

**[Cassandra 5.0/configuration]** The official Apache documentation describes a
layered scheme:

- coordinators store best-effort hints for unavailable replicas and later
  replay them;
- reads can perform replica read repair according to current table/system
  behavior;
- full/incremental anti-entropy repair compares common token ranges with Merkle
  trees and streams differences;
- repair is operationally scheduled/managed and can consume substantial disk
  and network I/O;
- tombstone safety depends on completing appropriate repair before purge
  assumptions are exceeded.

Current commands/options, automatic-repair capabilities, defaults, incremental
repair metadata, and read-repair behavior are version-specific. Inspect the
running version and configuration. Do not equate Cassandra hints with every
Dynamo-style sloppy-quorum design, and do not treat gossip membership as the
mechanism that repairs all table data.

---

## 72.12 Common Traps — Core

- Saying replicas converge “eventually” without naming fair scheduling,
  eventual communication, retained state, and merge assumptions.
- Repeating `R + W > N` as if it specifies repair; Chapter 71 explains why
  quorum arithmetic alone is not a complete freshness/linearizability proof.
- Treating physical absence as a deletion.
- Purging tombstones because a timer elapsed even though a replica/backup can
  still return an older live value.
- Letting a restored or replaced node rejoin from stale storage without fencing
  its incarnation and rebuilding/repairing it.
- Comparing values by digest without comparing versions or handling collisions.
- Hashing different snapshots, schemas, ownership ranges, tombstone rules, or
  canonical encodings and calling the mismatch corruption.
- Saying Merkle comparison is O(1) while ignoring tree construction and update.
- Assuming a mismatching Merkle leaf identifies one record or means the entire
  leaf must be streamed.
- Counting a stored hint as guaranteed delivery.
- Replaying hints with a new timestamp/version so an old mutation defeats a
  later write.
- Repairing only read respondents and claiming the whole replica set is healed.
- Treating gossip's expected/model round count as a deterministic deadline.
- Stopping a rumor after a fixed number of forwards with no pull/full-sync
  backstop.
- Using all-to-all peer lists or correlated partial views without measuring
  connectivity and control traffic.
- Running unthrottled repair on every node simultaneously and turning recovery
  into an outage.
- Marking a failed/obsolete incremental range complete.
- Copying historical Cassandra hint, read-repair, gossip, or `gc_grace`
  defaults into an architecture guarantee.

---

## Recall Card — Core

- Direct retries/hints shorten write misses; read repair heals hot observed
  keys; Merkle/range repair heals cold and lost-hint gaps.
- Compare canonical `(key, version, tombstone, value)` state. A digest detects a
  difference; the version/merge policy decides repair.
- Equal cached Merkle roots compare in O(1); building and maintaining them costs
  scans or write-path work.
- Leaf resolution trades tree memory against comparison rounds and overstreaming.
- A bitmap version summary records bounded holes; it is not missing data and is
  not automatically a causal version vector.
- Gossip is probabilistic under its peer-selection/loss model. Push spreads
  early, pull repairs the tail, push-pull does both at more per-contact cost.
- Tombstones are versioned deletions. Retain them until every older source is
  repaired, retired, or fenced.
- Repair pins range/topology/schema context, streams original versions
  idempotently, throttles, checkpoints, and verifies.

## Questions — Core

1. Walk the A/B/C lost-hint scenario and identify which mechanism repairs a hot
   key, a cold key, and a hint lost with its holder.
2. State sufficient convergence assumptions for a state-based anti-entropy
   system. Which assumption does a permanent partition violate?
3. Why does a digest mismatch not say which replica is correct? What metadata
   must the full comparison include?
4. Compare the build, root-comparison, descent, and transfer costs of a Merkle
   repair; explain how leaf granularity causes overstreaming.
5. A bitmap says origin X has base 103 and bits for 105/107. What can the peer
   infer, and what can it not infer about causal conflicts or payloads?
6. Derive the `N=8, I=4, f=1` expected-newly-informed calculation. Which real
   gossip behaviors invalidate its independence/uniform-delivery model?
7. Draw the tombstone resurrection timeline and list the evidence required
   before garbage collection.
8. Why must a repair session pin or validate ownership and schema epochs? What
   can fail during token movement?
9. Contrast hints, read repair, incremental repair, full repair, and rebuild by
   coverage, latency path, resource cost, and failure window.
10. Given outage, repair-duration, and operator-margin distributions, design an
    alert and retention policy without treating one configured grace value as a
    universal guarantee.

## Applied Exercise and Puzzle — Core

Extend §72.6 into a three-replica simulator:

1. add concurrent-version siblings or a semilattice merge rather than the toy
   total order;
2. model a durable hint queue with holder crash, expiry, replay, and idempotence;
3. retain versioned tombstones and demonstrate resurrection when they are
   deliberately purged too early;
4. build cached binary Merkle trees over fixed ranges and count construction,
   comparison, and streamed-record work separately;
5. implement push, pull, and push-pull gossip with seeded randomness, loss, and
   partial views;
6. run many trials and report a convergence-time distribution and nonconverged
   fraction under an explicit stopping rule—not only the mean;
7. inject ownership changes and require repair jobs to restart or translate
   their range epoch;
8. verify all replicas converge after writes stop under the stated fairness and
   connectivity assumptions.

**Puzzle:** A, B, and C store a key. A/B hold tombstone `v20`; C was offline
with live `v19`. A scheduled repair reports success, then A/B compact away
`v20`. C returns and `v19` reappears everywhere.

Give at least four explanations consistent with “repair succeeded”: C was not
in the repaired ownership set; the key range/session failed but aggregate status
was misread; repair used a snapshot before `v20`; incremental metadata excluded
the relevant data; the tombstone was omitted from hashing/streaming; or C was
later restored from an unfenced snapshot. Redesign the completion record and
tombstone-GC gate so “success” proves coverage of the correct range, replica
incarnations, ownership/schema epoch, snapshot/version horizon, and deletion
state.

## Prerequisites for Chapter 73 — Core

You should be able to trace a missed write through hints, read repair, Merkle
repair, and tombstone retention; state probabilistic gossip assumptions; and
design an idempotent, throttled, verifiable range-repair operation. Chapter 73
adds atomic commit and isolation for work spanning partitions.
