# Chapter 62 — B-Tree Basics

This optional-track chapter develops a B+tree as an algorithm over fixed-capacity pages. The generic invariants come first. PostgreSQL appears later as one implementation with named version-dependent choices; it is not the definition of a B+tree. Concurrent split protocols, latches, WAL, and crash recovery belong to Chapters 64–65.

---

## The 90-Second Screen — Core

1. A B+tree is a height-balanced multiway search tree. Internal pages contain separator keys and child references; leaf pages contain all searchable entries.
2. In an internal page with separators `s1 < s2 < ...`, each child owns one key interval. Search chooses an interval at every level and always terminates at a leaf.
3. All leaves have the same depth. Leaves are linked in key order, so a range scan descends once and then walks siblings.
4. Every non-root page has a lower and upper occupancy bound in the textbook model. The root is exceptional.
5. Insertion into a full page splits it, promotes or copies a separator into the parent, and may propagate to a new root.
6. Deletion from an underfull page first redistributes with a sibling when possible; otherwise it merges pages and removes a parent separator. Rebalancing may propagate upward.
7. Fanout is derived, not memorized:

   `fanout ≈ floor(usable_page_bytes / bytes_per_separator_and_child)`

   Real capacity also depends on headers, slot arrays, variable-length keys, alignment, compression, fill policy, and implementation metadata.
8. Height is approximately logarithmic in fanout. Cached upper levels often make leaf access, not root access, the dominant miss.
9. “B-tree” often means B+tree in database conversation, but the variants differ. State which one you mean.
10. Search correctness during a concurrent split requires extra machinery—latches, right-links/high keys, or another protocol. Chapter 64 owns that implementation proof.

---

## 62.1 The B+Tree Model and Its Invariants — Core

A binary search tree makes one two-way decision per node. A B+tree makes one many-way decision per page. The asymptotic idea is familiar—ordered search—but the unit of work is different. A node is sized to the storage or cache-management unit used by the system, so one page access exposes many separator keys.

Without an index, an equality or range predicate may need to examine every record: `O(N)` comparisons and potentially a scan of the stored relation. A sorted index narrows the candidate region while retaining order for range scans, predecessor/successor queries, and ordered output. The index costs storage, maintenance on writes, and an additional route from key to record.

A conventional pointer-based balanced BST is poorly matched to page-managed storage. Its fanout is two, so a large tree needs many dependent node visits; separately allocated nodes also waste most of each transferred page. AVL or red-black rotations bound BST height but do not change that fanout. A B+tree instead packs many routing keys into one page and rebalances by page split, redistribution, and merge.

This remains relevant on SSD and NVMe storage. Mechanical seek is no longer the only concern, but dependent cache/buffer misses, controller queueing, transfer size, write amplification, and CPU traversal still exist. For a fully memory-resident structure, cache-line- or SIMD-conscious variants may beat a storage-page B+tree. “Disk-oriented” describes the cost model, not a claim that one device latency dominates every deployment.

Use these terms consistently:

- A **key** determines ordering.
- A **value** is the record, row reference, or payload associated with a key.
- An **internal page** contains routing entries: separators and child references.
- A **leaf page** contains searchable key/value entries.
- **Fanout** is the number of children of an internal page.
- **Capacity** is the maximum entries a particular page representation can hold.
- **Occupancy** is the number or byte fraction currently used.
- **Height** here counts pages on a root-to-leaf path. Some texts count edges instead; state the convention.

For a simplified B+tree of order `m`, an internal node has at most `m` children and therefore at most `m - 1` separators. A common textbook minimum is `ceil(m / 2)` children for a non-root internal node. A leaf has a corresponding lower and upper entry bound. Production systems often use byte occupancy and more nuanced deletion policies, so “half full” is an algorithmic model, not a universal product rule.

The structural invariants are:

1. **Sorted contents.** Keys within every page are ordered according to one comparator.
2. **Routing partition.** Each internal separator divides disjoint child key ranges.
3. **Leaf ownership.** All searchable entries occur in leaves. Internal copies are routing information, not additional logical rows.
4. **Equal leaf depth.** Every root-to-leaf path contains the same number of pages.
5. **Bounded occupancy.** Except for the root, pages remain within the variant's minimum and maximum occupancy after rebalancing.
6. **Linked leaf order.** Each leaf can reach its next leaf in key order; many implementations also keep a previous link.
7. **Root exception.** A root may contain fewer entries than ordinary pages. An empty tree may be represented by no root or by one empty leaf, depending on the implementation.

An internal page can be drawn in either of two equivalent conventions. This chapter uses `children.size() == separators.size() + 1`:

```
separators:       [ 20 | 50 | 80 ]
children:        c0    c1    c2    c3

c0: k < 20
c1: 20 <= k < 50
c2: 50 <= k < 80
c3: 80 <= k
```

Some systems store a lower bound with each downlink instead. Duplicate keys also require a total ordering—often `(user_key, row_id)`—or explicit duplicate posting lists. The diagrams use unique integers only to keep the routing visible.

### B-tree versus B+tree

In a classic B-tree, values may occur in internal nodes as well as leaves, and a successful point lookup can stop above the leaf level. In a B+tree, internal nodes are routing-only and every logical entry lives at the leaf level.

| Property | Classic B-tree | B+tree |
|---|---|---|
| Values | internal and leaf nodes | leaves only |
| Successful lookup | may stop internally | ends at a leaf |
| Internal fanout | payload may reduce it | routing entries only |
| Range scan | traversal depends on variant | descend once, then follow leaves |

Database indexes commonly use B+tree-family structures because value-free internal pages can have high fanout and linked leaves make ordered scans direct. That design does not guarantee a particular page size, height, or fill percentage.

---

## 62.2 Point Lookup and Range Scan — Core

Point lookup repeats two operations:

1. Search the sorted separators inside the current page.
2. Follow the selected child reference.

At the leaf, search the sorted entries and confirm equality. If each internal page has fanout near `f` and the tree contains `N` entries, a balanced lookup touches `O(log_f N)` pages. The comparisons inside a page are commonly binary search, interpolation-like search, prefix-aware search, or a small linear/SIMD search; that choice changes CPU cost but not the routing invariant.

### Worked lookup

Consider:

```
                         [ 30 | 70 ]
                       /      |      \
             [10 20 25]  [30 45 60]  [70 80 95]
                  L0  <---->  L1  <---->  L2
```

Lookup `45`:

1. At the root, `30 <= 45 < 70`, so choose the middle child.
2. Binary-search leaf `L1`.
3. Find `45`.

Lookup `55` follows the same child, then fails between `45` and `60`. An unsuccessful lookup still terminates at the leaf where the key would be inserted.

The route is a proof obligation. If a separator is the smallest key in its right subtree, then equality must route right. A program that uses `upper_bound` where its separator convention requires `lower_bound`, or vice versa, can silently lose boundary keys.

### Range scan

For `[22, 82)`:

1. Descend to the first leaf that could contain `22`.
2. Start at `lower_bound(22)` within that leaf.
3. Emit entries while the key is below `82`.
4. Follow the next-leaf pointer when a leaf is exhausted.

```
[10 20 25] -> [30 45 60] -> [70 80 95]
       25       30 45 60      70 80       emitted
```

The cost is one root-to-leaf descent plus the number of leaf pages containing the range, not one descent per result. Whether sibling pages are physically adjacent is an allocation property, not a B+tree guarantee. The links provide logical order even when storage placement is fragmented.

### Compact search pseudocode

```cpp
PageId find_leaf(PageId root, Key key) {
    PageId id = root;
    for (;;) {
        Page const& page = read_page(id);
        if (page.is_leaf()) return id;

        // Convention: separator[i] is the lower bound of child[i + 1].
        auto it = std::upper_bound(page.separators.begin(),
                                   page.separators.end(), key);
        std::size_t child = static_cast<std::size_t>(
            it - page.separators.begin());
        id = page.children[child];
    }
}
```

This is single-threaded conceptual code. It assumes pages remain stable while read and that every referenced page is valid. Chapter 64 adds pins/latches and a protocol for encountering a concurrent split.

---

## 62.3 Insertion and Splitting — Core

Insertion first performs ordinary lookup. If the target leaf has room, insert the new entry in sorted order and stop. A full leaf is split.

For a conceptual split:

1. Combine the old entries and the new entry in sorted order.
2. Choose a split position satisfying the occupancy policy.
3. Keep the lower portion in the left leaf and move the upper portion into a new right leaf.
4. Repair leaf sibling links.
5. Insert a separator for the new right leaf into the parent.
6. If the parent overflows, split the parent and propagate upward.
7. If the old root splits, allocate a new root with two children. Only this step increases tree height.

The leaf and internal cases treat the separator differently:

- In a **leaf split**, the first key of the new right leaf is normally **copied** into the parent. The logical entry remains in the leaf.
- In a common **internal split**, a middle separator is **promoted** into the parent and removed from the split children, because internal keys are routing structure.

Exact separator truncation, duplicate handling, and high-key representation are implementation details.

### Worked insertion

Use leaf capacity 4 and internal capacity 3 separators. Begin:

```
root/leaf: [10 20 30 40]
```

Insert `25`. The sorted temporary contents are `[10 20 25 30 40]`, which do not fit. Split:

```
left leaf  [10 20]  ->  right leaf [25 30 40]
```

Create a root whose separator is the lower bound of the right child:

```
                   [25]
                 /      \
          [10 20]  ->  [25 30 40]
```

The tree grew from height 1 to height 2. Search equality at `25` routes right, matching the chosen separator convention.

Now insert `50`, then `60`. The right leaf eventually overflows:

```
temporary right: [25 30 40 50 60]
split:           [25 30] -> [40 50 60]
copy up:                    40
```

The root becomes:

```
                      [25 | 40]
                    /     |      \
              [10 20] [25 30] [40 50 60]
```

At each step, verify all invariants:

- leaf entries sorted;
- root separators sorted;
- separator `25` equals the lower bound of its right child;
- all leaves at depth 1;
- sibling links reflect leaf order;
- no page exceeds capacity.

### Split policy is a workload choice

A median split is simple and protects worst-case occupancy. Some systems bias a split for append-heavy keys or reserve free space to reduce future splits. Prefix compression and variable-length records make “half” mean bytes rather than entry count. These policies affect write amplification and utilization, but they must preserve routing and occupancy guarantees.

A split is not a single atomic memory write. In a durable concurrent implementation it interacts with page allocation, parent updates, latches, WAL, and crash recovery. The conceptual order above is not a safe production write sequence; Chapter 64 supplies that layer.

---

## 62.4 Deletion, Redistribution, and Merge — Core

Deletion removes a leaf entry. If the leaf remains above its minimum occupancy, no structural change is required. Otherwise:

1. Try to **redistribute** (borrow) an entry from an adjacent sibling that has more than its minimum.
2. Update the parent separator so it still equals the right child's lower bound under this chapter's convention.
3. If redistribution is impossible, **merge** the underfull page with a sibling.
4. Remove the redundant child reference and separator from the parent.
5. If the parent becomes underfull, rebalance upward.
6. If a root internal page ends with one child, replace the root with that child. Only root collapse decreases height.

### Worked redistribution

Assume leaf minimum 2, capacity 4:

```
                  [30]
                /      \
          [10 20]  ->  [30 40 50]
```

Delete `20`. The left leaf becomes `[10]`, below minimum. The right sibling can spare its first entry:

```
before: parent [30], leaves [10] and [30 40 50]
move 30 left
after:  parent [40], leaves [10 30] and [40 50]
```

Updating the parent from `30` to `40` is essential. Leaving the old separator routes keys in `[30, 40)` to the wrong child.

### Worked merge

Start with both siblings at minimum:

```
                  [30 | 70]
                /     |      \
          [10 20] [30 40] [70 80]
```

Delete `40`, leaving `[30]`. Neither neighbor should donate if doing so would underflow. Merge the middle leaf with the left:

```
merged leaf: [10 20 30]
remove child and separator 30 from parent

                  [70]
                /      \
       [10 20 30]  ->  [70 80]
```

If the parent had become empty and were the root, its sole child would become the new root. A non-root parent would itself need redistribution or merge.

### Logical deletion versus physical rebalancing

The textbook algorithm restores minimum occupancy immediately. Real storage engines may defer page merging because merging can add writes, contention, and complex interactions with snapshots or recovery. They may mark entries dead, compact a page, recycle empty pages later, or tolerate sparse pages. This is a product policy layered on the same search invariant; do not infer a specific merge policy from the term “B+tree.”

---

## 62.5 Page Layout, Fanout, and a Worked Capacity Calculation — Core

High fanout comes from packing routing entries into one managed page. Derive it from the representation:

```
P = page bytes
H = fixed header/special-area bytes
S = slot-directory bytes per entry
K = average encoded separator bytes
C = encoded child-reference bytes
E = other per-entry metadata/alignment

usable bytes U = P - H
approximate fanout f = floor(U / (S + K + C + E))
```

This estimate is intentionally parameterized. There is no universal 8 KiB page, 8-byte child reference, 90% fill factor, or 400-way fanout.

### Worked generic calculation

Suppose a particular design chooses:

- page size `P = 16,384` bytes;
- fixed overhead `H = 128` bytes;
- slot `S = 4` bytes;
- average compressed separator `K = 12` bytes;
- child reference `C = 8` bytes;
- other entry overhead `E = 4` bytes.

Then:

```
U = 16,384 - 128 = 16,256 bytes
entry budget = 4 + 12 + 8 + 4 = 28 bytes
f ≈ floor(16,256 / 28) = 580 routing entries
```

Treat `580` as a planning estimate, not a guarantee. A real implementation may need one more child than separators, reserve free space, store a high key, align records, encode variable-length offsets, or cap entries independently. Long separators can reduce capacity sharply; prefix/suffix truncation can increase it.

Now change only the average separator to 60 bytes:

```
entry budget = 4 + 60 + 8 + 4 = 76 bytes
f ≈ floor(16,256 / 76) = 213
```

The same page format now has roughly one third the fanout. Key width and encoding can matter more than the nominal page size.

### Leaf capacity

Leaf entries include the full key plus a value or row reference:

```
leaf_capacity ≈ floor((P - leaf_header) /
                      (slot + encoded_key + encoded_value + metadata))
```

Variable-length records make capacity byte-based. A page with many small entries can hold more entries than one with a few large values. Oversized values may be stored out of line, rejected, or handled by overflow pages depending on the product.

### Slotted pages

A common representation keeps a slot array at one end and packed variable-length records at the other:

```
low addresses
┌──────────────────────────────────────┐
│ header │ slots →      free      ← records │
└──────────────────────────────────────┘
high addresses
```

A slot stores an offset/length rather than the record itself. Records can be compacted within the page while stable slot numbers or logical identifiers remain valid. This is a storage-engine technique, not a requirement of the abstract B+tree.

---

## 62.6 Height, Caching, and the Cost Model — Core

Let:

- `L` be average leaf entries;
- `f` be average internal fanout;
- `h` count levels including root and leaf.

A rough capacity model is:

```
N(h) ≈ L * f^(h - 1)
h ≈ 1 + ceil(log_f(N / L))       for N > L
```

Use conservative occupancies for a worst-case bound and measured averages for capacity planning.

### Worked height calculation

For the generic example, suppose measured steady-state averages are `f = 300` and `L = 240`, not the maximum capacities:

| Height | Approximate entries |
|---:|---:|
| 1 | `240` |
| 2 | `240 × 300 = 72,000` |
| 3 | `240 × 300² = 21,600,000` |
| 4 | `240 × 300³ = 6,480,000,000` |

The lesson is the exponent, not the number 300. A high-fanout tree can cover billions of entries in a few levels, but wider keys, low occupancy, duplicate representation, and smaller pages change the result.

### Page touches are not automatically device I/Os

A height-4 lookup conceptually visits four tree pages. It does not necessarily perform four storage reads:

- the root and upper internal pages are small and frequently cached;
- the target leaf may already be resident;
- a buffer miss may be satisfied from an OS cache or from the device;
- after finding an index entry, fetching the referenced row can add another access;
- a covering index may avoid that row fetch;
- prefetch and concurrent requests can overlap some latency, though one lookup's dependent descent remains sequential.

Separate three cost layers:

| Layer | Example cost source |
|---|---|
| In-page CPU | comparator, binary search, decompression, branch/cache behavior |
| Buffer manager | hash lookup, pin/reference management, latch acquisition |
| Storage | queueing, controller/FTL behavior, media latency, page fault/read |

HDDs make random dependent reads especially costly because of mechanical positioning. SSD and NVMe devices reduce that gap substantially, but dependent misses, queueing, write amplification, and cache misses still matter. Do not attach one latency number to “NVMe” or conclude that random and sequential access are equivalent across devices and workloads.

### Read and write amplification

Point lookup read amplification is roughly the uncached tree levels plus any base-row lookup. Insertion write amplification can include:

- the modified leaf;
- a newly allocated split page;
- parent pages if separators propagate;
- logging or copy-on-write metadata;
- storage-device internal amplification.

The algorithm bounds the number of pages on a path, but recovery and storage policies determine physical writes. Chapters 63–65 make those layers explicit.

---

## 62.7 A Compact Validated Model — Core

This small C++23 model demonstrates routing, leaf insertion, and leaf splitting. It intentionally supports a root with leaf children only; recursive internal splitting is left as an exercise. That limitation keeps the code honest and small rather than disguising a partial production implementation.

```cpp
#include <algorithm>
#include <cassert>
#include <cstddef>
#include <vector>

struct Leaf {
    std::vector<int> keys;
};

struct Root {
    // separator[i] is the lower bound of child[i + 1]
    std::vector<int> separators;
    std::vector<Leaf> children;
};

std::size_t child_for(Root const& root, int key) {
    return static_cast<std::size_t>(
        std::upper_bound(root.separators.begin(),
                         root.separators.end(), key)
        - root.separators.begin());
}

bool contains(Root const& root, int key) {
    Leaf const& leaf = root.children[child_for(root, key)];
    return std::binary_search(leaf.keys.begin(), leaf.keys.end(), key);
}

void insert_unique(Root& root, int key, std::size_t leaf_capacity) {
    std::size_t i = child_for(root, key);
    Leaf& leaf = root.children[i];
    auto pos = std::lower_bound(leaf.keys.begin(), leaf.keys.end(), key);
    if (pos != leaf.keys.end() && *pos == key) return;
    leaf.keys.insert(pos, key);

    if (leaf.keys.size() <= leaf_capacity) return;

    std::size_t mid = leaf.keys.size() / 2;
    Leaf right{{leaf.keys.begin() + static_cast<std::ptrdiff_t>(mid),
                leaf.keys.end()}};
    leaf.keys.erase(leaf.keys.begin() + static_cast<std::ptrdiff_t>(mid),
                    leaf.keys.end());

    int separator = right.keys.front();
    root.separators.insert(root.separators.begin()
                               + static_cast<std::ptrdiff_t>(i),
                           separator);
    root.children.insert(root.children.begin()
                             + static_cast<std::ptrdiff_t>(i + 1),
                         std::move(right));
}

int main() {
    Root root{{}, {Leaf{{10, 20, 30, 40}}}};
    insert_unique(root, 25, 4);

    assert((root.separators == std::vector<int>{25}));
    assert((root.children[0].keys == std::vector<int>{10, 20}));
    assert((root.children[1].keys == std::vector<int>{25, 30, 40}));
    assert(contains(root, 25));
    assert(!contains(root, 26));
}
```

The model stores children by value, not page ID, and vector insertion invalidates references. It has no persistence, duplicate values, sibling links, deletion, recursive internal nodes, concurrency, or recovery. Its purpose is to validate the separator convention and split trace. A production implementation requires explicit page ownership and failure handling, which Chapter 64 develops.

---

## 62.8 Deep Dives: Keys, Bulk Build, and Validation — Deep dive

### Duplicate and composite keys

The clean diagrams use unique integers, but database indexes commonly contain duplicates. A search tree still needs a total routing order. Three broad representations are:

1. **Composite physical key.** Order entries by `(user_key, row_id)` or another unique suffix. Every physical entry has a distinct position even when many user keys compare equal.
2. **Posting list.** Store one user key with a list or compressed set of row references. This can reduce repeated-key storage but makes updates and overflow handling more complex.
3. **Repeated equal entries.** Permit multiple equal keys and define precisely whether descent chooses the leftmost or rightmost candidate page, then scan across siblings as needed.

Suppose a leaf split divides equal key `42` across both pages. A parent separator containing only `42` cannot tell a point lookup which page contains a particular row reference. That is not necessarily wrong: the lookup can descend to the first possible page and scan right. But uniqueness checks, deletion by row ID, and range endpoints must use the same convention. Adding a tie-breaker to the physical key can make routing exact.

Composite SQL keys add another issue: lexicographic order. An index on `(venue, symbol, timestamp)` can efficiently route:

- an equality prefix such as `venue = ?`;
- a longer equality prefix plus a range on the next component;
- a complete tuple lookup.

It does not generally provide the same routing power for a predicate on `timestamp` alone, because timestamps for different venues and symbols are interleaved by the earlier components. This is an ordering consequence, not a planner quirk.

Null ordering, collation, descending components, and locale/version changes belong to the comparator contract. If two processes or software versions disagree about key order, the tree can remain structurally well formed while searches return wrong results. Persistent indexes therefore tie their semantics to operator classes, collation versions, or rebuild requirements.

### Variable-length keys and separator truncation

A fixed-order textbook tree counts entries. A variable-length tree budgets bytes. Consider two leaves:

```
leaf A: 100 short integer keys
leaf B: 8 long strings
```

They may have similar byte occupancy even though their entry counts differ by more than an order of magnitude. Split selection should normally balance byte use and ensure that both results satisfy any required minimum. A simple `entries.size() / 2` split can create one nearly full page and one nearly empty page.

Internal separators need only distinguish adjacent child ranges; they do not always need the entire leaf key. If the largest key on the left is:

```
"exchange/alpha/2026-07-23/000099"
```

and the smallest on the right is:

```
"exchange/beta/2026-01-01/000001"
```

a shorter boundary derived from `"exchange/b..."` may suffice, subject to comparator semantics. Short separators increase fanout. The shortening algorithm must still choose a value strictly above the left range and at or below the right range under the routing convention. Byte-prefix truncation is unsafe for arbitrary collations or encodings unless the comparator contract explicitly supports it.

Prefix compression can also encode each key relative to a page prefix or previous key. That trades CPU work and update complexity for smaller pages and greater fanout. Capacity calculations must then use measured encoded sizes and include restart points or metadata, rather than dividing by the uncompressed C++ object size.

### Bulk construction

Repeated insertion is not the only way to create a tree. If entries are already sorted, a **bulk load** can build leaves from left to right:

1. Allocate a leaf and append sorted entries until its target fill is reached.
2. Link it to the preceding leaf.
3. Record the new leaf's lower bound for the parent level.
4. Build the next leaf.
5. Once leaves are complete, construct the next internal level from their lower bounds and page IDs.
6. Repeat until one root remains.

```
sorted input
   │
   ├──> [leaf 0] -> [leaf 1] -> [leaf 2] -> [leaf 3]
   │          \        |           |          /
   └────────── separators build parent level ──┘
```

Bulk construction avoids the repeated search and split propagation of inserting every item into an initially empty tree. It can choose a desired initial free-space reserve and often writes pages in an allocation-friendly order. Its cost includes sorting when the input is not already ordered. External sorting, WAL policy, parallel construction, and crash recovery are product-level concerns.

Target occupancy is a tradeoff:

- Dense pages reduce space and read amplification.
- Reserved free space can absorb future inserts without immediate splits.
- Append-only increasing keys concentrate future inserts at the right edge.
- Random keys distribute insert pressure but can fragment free space across many leaves.

No one fill target is best for bulk build, steady updates, or skewed append workloads. Measure split rate, page utilization, and write amplification for the actual key distribution.

### In-page search

Tree height counts page visits, but each visit performs CPU work. Binary search takes `O(log e)` comparator calls for `e` entries. With variable strings or locale-aware comparison, comparator cost can dominate. Alternatives include:

- linear search for very small pages;
- interpolation or learned position estimates for suitable distributions;
- cache-conscious layouts that separate fixed-size key prefixes from payload offsets;
- SIMD comparison of fixed-width keys;
- prefix compression with restart points;
- storing a short discriminator alongside a long key.

Binary search has non-sequential probes and branches; linear search has predictable access but more comparisons. The crossover depends on entry count, key width, comparator, cache state, compiler, and CPU. This belongs to the in-page representation, not the abstract B+tree proof.

Do not optimize it from an instruction count alone. A sampled profile must show that internal-page comparison is material after accounting for buffer lookup, latching, leaf comparison, and any base-row fetch.

### Bottom-up validation

A validator is often more valuable than another optimization. Given a quiescent tree, validate recursively:

1. Page keys are sorted by the exact production comparator.
2. Internal pages have one more child than separator in this representation.
3. Every child range is bounded by its neighboring separators.
4. Every leaf has the same depth.
5. Occupancy respects root and non-root rules.
6. Every referenced page exists and no reachable page is visited twice unless the format explicitly permits sharing.
7. Leaf next-links form one acyclic ordered chain containing exactly the reachable leaves.
8. Parent-derived lower/upper bounds agree with the minimum and maximum keys found below.

One useful interface carries bounds down the recursion:

```cpp
struct Bound {
    int key;
    bool inclusive;
};

void validate(PageId id,
              std::optional<Bound> low,
              std::optional<Bound> high,
              unsigned depth,
              std::optional<unsigned>& leaf_depth);
```

At an internal page, derive a bound pair for every child. At a leaf, verify every entry against the inherited pair and compare `depth` with the first observed leaf depth. Separately walk the sibling chain and compare it with the recursive leaf order.

For the compact model, property-based testing can compare `insert`, `erase`, and `contains` with `std::set`. Generate adversarial sequences as well as random ones:

- strictly increasing and decreasing insertion;
- repeated boundary keys;
- insert to split, then delete to minimum;
- alternating operations near separators;
- delete everything to force root collapse;
- variable-size keys clustered around the page byte limit.

A set oracle checks logical contents; structural validation checks the tree-specific invariants. Both are necessary. A tree can contain the right keys yet have a stale separator that only fails after a later split.

### Failure boundaries

The abstract operations say “allocate page, write children, update parent.” Persistence turns those into a multi-write transaction. A crash can occur after any write. Copy-on-write trees, WAL-protected in-place trees, and shadow-paging designs solve this with different publication and recovery rules.

The key distinction is:

- **algorithmic invariant:** what a completed tree state must satisfy;
- **concurrent invariant:** what readers may observe during an operation;
- **recovery invariant:** which incomplete states are legal after a crash and how replay/rollback repairs them.

Chapter 62 proves only the first. Chapter 64 handles concurrent structural modification; Chapter 65 handles recovery. Keeping those contracts separate prevents plausible-looking single-thread pseudocode from being treated as durable code.

### Why the bounds hold

The equal-depth invariant and minimum occupancy give the height bound. Let a non-root internal page have at least `t` children, where `t >= 2`. At height 1, the root is a leaf. At height 2, the root has at least two leaf children after the first root split. Each additional internal level multiplies the minimum number of reachable leaves by at least `t`.

For height `h >= 2`, a simplified minimum-leaf count is:

```
minimum leaves >= 2 * t^(h - 2)
```

If every non-root leaf contains at least `l_min` entries, then:

```
N >= 2 * t^(h - 2) * l_min
```

Solving for `h` yields a logarithmic upper bound. The root exception changes the constant, not the logarithm. This proof is why a deletion algorithm cannot simply leave arbitrary empty non-root pages: without a lower occupancy invariant, fanout can collapse toward one and the height guarantee disappears.

Operation bounds follow from the same path structure:

- Search visits one page per level: `O(h)`.
- Insert searches one path and can split at most one page per level: `O(h)` page-level structural work.
- Delete searches one path and can rebalance at most one page per level: `O(h)` page-level structural work.
- Range scan visits `O(h + q)` pages where `q` is the number of leaf pages traversed, plus output processing.

These are worst-case algorithmic counts. A split copies many bytes within one or two pages, comparator cost varies, and durable logging adds work. Big-O does not turn all page operations into equal-latency events.

### Choosing a page size

Larger pages tend to increase fanout and reduce metadata overhead per stored key. They can also:

- increase the bytes read when a lookup needs only one entry;
- increase split-copy and write size;
- increase latch hold time for page-local work;
- waste cache when access is sparse;
- interact differently with filesystem, virtual-memory, and device granularities.

Smaller pages can reduce transfer and copy size but increase height and metadata. The best unit depends on whether the engine uses a private buffer pool, the OS page cache, direct I/O, memory mapping, remote storage, or persistent memory. It also depends on checksum and atomic-write assumptions.

A “page” is therefore a software contract, not necessarily one hardware sector or one virtual-memory page. An engine may issue several device sectors for one database page, or group several database pages in one I/O. Conversely, a memory-resident B+tree may size nodes for cache lines or allocator classes rather than storage blocks.

Use a sensitivity table instead of a universal recommendation. For fixed overhead 128 bytes and 28-byte internal entries:

| Page bytes | Approximate maximum routing entries |
|---:|---:|
| 4,096 | `floor((4096 - 128) / 28) = 141` |
| 8,192 | `288` |
| 16,384 | `580` |
| 32,768 | `1,165` |

Doubling page size roughly doubles maximum fanout in this fixed-width example, but it does not necessarily reduce measured latency. Recompute with the actual encoded key distribution, then benchmark the end-to-end workload.

### Fragmentation and maintenance

There are several different kinds of “empty space”:

- **in-page free space** available for another entry;
- **fragmented in-page space** recoverable by compaction;
- **underfull live pages** that still participate in the tree;
- **unreachable pages** awaiting safe reclamation;
- **unused file extents** that may or may not be returned to the filesystem.

Deleting half the logical rows does not imply that an index file shrinks by half. If surviving keys are spread across many leaves, each leaf may remain reachable. Merging can consolidate them, but durable concurrent merging has a cost and may move contention elsewhere. Rebuild, vacuum-like maintenance, background compaction, and online page recycling are product policies.

Insertion order also shapes fragmentation. Monotonic keys usually target the rightmost leaf, producing a concentrated append/split pattern. Random keys distribute writes and splits across the key space. Neither is universally better: monotonic keys improve locality but can create a hot page under concurrency; random keys reduce one hotspot but may increase working-set breadth and fragmentation.

Measure:

- live bytes versus allocated bytes;
- leaf and internal occupancy distributions, not only averages;
- splits and merges per write;
- tree height over time;
- cache hit rate by level;
- write bytes at the database, filesystem, and device layers.

Those observations distinguish a structural tree problem from buffer, allocator, recovery, or device amplification.

---

## 62.9 PostgreSQL `nbtree`: A Labeled Case Study — Skippable Reference

The following is product-specific. PostgreSQL's `nbtree` access method is a B+tree-family implementation with B-link techniques. Details can change across releases, compile-time options, and index operator classes; consult the documentation and source for the deployed major version.

At a high level:

- Leaf tuples contain indexed key data plus a heap tuple identifier, subject to features such as deduplication and included columns.
- Internal pivot tuples contain routing information and downlinks.
- Pages have sibling links and high-key conventions used to preserve navigation across splits.
- A metapage records tree metadata including a root reference.
- Page-local special/opaque metadata records `nbtree` state such as level and sibling-navigation information; exact structs and flags are source-version details.
- Page size is controlled by the build's `BLCKSZ`; the common packaged default is not a universal PostgreSQL or B+tree constant.
- Pivot-key suffix truncation is available in modern PostgreSQL releases to keep internal routing tuples smaller where semantics permit.
- Duplicate representation, bottom-up deletion, page recycling, and vacuum interaction are version- and workload-dependent.

Do not transfer the textbook immediate-merge rule directly to PostgreSQL. PostgreSQL commonly removes dead index tuples and reuses space without eagerly coalescing every underfull page. MVCC visibility is primarily determined through heap and visibility metadata; an index entry's presence does not by itself prove that a row version is visible to the current snapshot.

Likewise, do not treat a PostgreSQL high key as the generic definition of every B+tree separator. High keys and right-links are part of a concurrency/navigation design. The abstract tree in §§62.1–62.7 needs only ordered separators and stable child ranges.

Useful version-labeled inspection commands include:

```sql
SELECT current_setting('block_size');   -- server build/runtime report
SELECT version();
```

Extensions such as `pageinspect` can expose page details for investigation, but their functions and output are PostgreSQL-version-specific and require appropriate privileges. They are diagnostic interfaces, not application APIs.

Three PostgreSQL boundaries are especially easy to blur:

**Uniqueness.** A unique B-tree index enforces a logical constraint, but MVCC means an apparently conflicting heap tuple may be deleted, uncommitted, or otherwise subject to visibility/wait rules. The index access method and transaction machinery cooperate; separator routing alone cannot decide uniqueness.

PostgreSQL also has a speculative-insertion protocol used by operations such as conflict-aware insertion. Its wait/confirm/abort behavior is transaction machinery layered on the index search; it is not a generic B+tree insertion step.

**Index-only scans.** An `nbtree` leaf can contain key data, a heap TID, and optionally included columns, yet PostgreSQL may still need visibility information associated with the heap. The visibility map can allow some heap visits to be skipped. “All values live in B+tree leaves” is the abstract structure; it does not mean every SQL query is answerable without consulting MVCC metadata.

**Deletion and reuse.** Removing an index tuple, marking a page recyclable, unlinking a page from the sibling chain, and reusing its block number are distinct events with concurrency and recovery constraints. A generic merge diagram does not specify when PostgreSQL performs each event. Release notes and the deployed source version are the authority for bottom-up deletion, deduplication, vacuum interaction, and page-recycling behavior.

**Build-time comparison.** PostgreSQL operator classes may provide sort-support routines and abbreviated keys to accelerate sorting during index construction. An abbreviation is an optimization for comparison/sort work, not necessarily the persistent logical key or an internal separator. Its safety and collision handling are defined by the operator class and release.

For a concrete investigation, record at least:

- `server_version_num`;
- `block_size`;
- complete index definition and operator classes;
- whether deduplication or included columns apply;
- observed index levels and page statistics from version-compatible tooling;
- workload phase, since a newly built index and a churned index can have different occupancy.

That evidence makes a fanout or bloat explanation reproducible without turning one PostgreSQL release's page layout into a universal algorithm.

---

## 62.10 Concurrency Handoff — Core Boundary

The single-thread algorithm assumes a page does not change between choosing a child and reading it. A concurrent split violates that assumption unless the implementation adds a protocol.

Questions a concurrent design must answer include:

- Which operation linearizes a point lookup, insert, or delete?
- Which latches protect in-memory page bytes, and how are they ordered to avoid deadlock?
- Can a reader release a parent before latching a child?
- If a child splits before its parent receives the new separator, how does a reader find the new right page?
- How are range scans kept complete without returning an entry twice?
- When can a removed page ID be safely reused?
- How are partially completed structural changes recovered after a crash?

A B-link design associates a right-link and an upper bound/high key with a page. A reader whose search key exceeds that bound moves right, allowing it to recover from some parent/child timing windows. That sentence is only the intuition. Correctness depends on exact latch order, publication order, memory reclamation, and WAL/recovery rules.

Chapter 64 owns latch coupling, split propagation, B-link/high-key traversal, concurrent scans, and recovery interactions. Chapter 62 intentionally does not provide concurrent pseudocode that could be mistaken for a complete algorithm.

---

## 62.11 B+Tree Versus Other Access Methods — Role-specific

An index is chosen for its workload and storage policy, not because one structure wins universally.

| Structure | Strength | Cost or limitation |
|---|---|---|
| B+tree | point lookup, ordered scan, predecessor/successor | in-place splits and page maintenance |
| Hash index | equality lookup | no intrinsic ordering or range scan |
| LSM tree | high sequential write throughput | compaction and read/write amplification |
| Radix/trie family | prefix structure, bytewise routing | key-shape and memory-layout sensitivity |
| Sorted flat file/run | dense scans and binary search | updates require rebuilding/merging |

A B+tree is attractive when ordered access and mixed reads/writes matter. An LSM design may be better for sustained ingestion, accepting background compaction and multi-run lookup. In-memory indexes can choose cache-line-sized nodes, radix partitions, or contiguous arrays rather than storage pages. Chapter 61 provides the broader storage comparison.

---

## 62.12 Recall and Practice — Core

**Recall card**

- B+tree internal pages route; leaves own all searchable entries and are linked in order.
- Separators and child ranges must use one explicit equality convention.
- All leaves have equal depth. Only a root split increases height; only root collapse decreases it.
- Leaf split copies a boundary upward; a common internal split promotes a separator.
- Delete redistributes when a sibling can spare occupancy, otherwise merges and removes a parent separator.
- Minimum occupancy is part of the textbook bound, but products may use byte-based thresholds and defer merges.
- Fanout is a page-budget calculation, not a remembered constant.
- Height is driven exponentially by fanout, while physical I/O depends on caching and the row-fetch path.
- PostgreSQL `nbtree`, its page size, high keys, deduplication, and deletion policy are product/version facts.
- Concurrent correctness and recovery are Chapter 64–65 concerns.

**Questions**

1. State the seven invariants in §62.1 and identify which ones are relaxed for the root.
2. Given separators `[20, 50, 80]`, which child receives keys `19`, `20`, `79`, and `80` under this chapter's convention?
3. Why is a leaf separator copied into the parent, while a common internal split promotes a separator?
4. After borrowing the smallest key from a right leaf, which parent separator must change and why?
5. Derive internal fanout from page, header, slot, separator, child-reference, and metadata sizes. Which inputs are averages?
6. Explain why a height-4 lookup need not issue four device reads.
7. Contrast textbook immediate merge with a storage engine that defers coalescing sparse pages.
8. What information lets a B-link reader recover from landing on the left half of a concurrently split key range?

**Puzzle**

Leaf capacity is 4, minimum occupancy is 2, and the root is:

```
                  [25 | 60]
                /     |       \
          [5 10] [25 40] [60 70 90]
```

Apply, in order: insert `50`, insert `55`, delete `25`, delete `40`. Draw the tree after each operation. At every step list the separator updates, sibling-link changes, and whether redistribution or merge is required. More than one split policy may be valid; state yours and verify all child intervals.

**Implementation exercise**

Extend the model in §62.7 with:

1. a validator for sorted keys, separator lower bounds, child count, and occupancy;
2. next-leaf links represented by stable integer IDs;
3. deletion with redistribution and merge for a root whose children are leaves;
4. randomized comparison against `std::set<int>` after every operation.

Run thousands of insert/erase/contains operations with a fixed seed, then several random seeds. Keep concurrency out of this exercise. If you add recursive internal levels, validate equal leaf depth and propagate splits/merges all the way to root growth/collapse.

**Traps**

- Saying “B-tree” without clarifying classic B-tree versus B+tree.
- Mixing “order,” maximum children, maximum keys, and minimum degree from different textbooks.
- Using inconsistent equality routing at a separator boundary.
- Forgetting to update the parent separator after redistribution.
- Copying an internal promoted separator into both children when the chosen variant requires removal.
- Computing fanout from key width alone while ignoring slots, child references, headers, alignment, and compression.
- Treating logical page visits as physical storage I/Os.
- Quoting one page size, fill factor, fanout, height, or device latency as universal.
- Applying PostgreSQL's deletion, visibility, or high-key behavior to every B+tree.
- Presenting single-thread split order as a safe concurrent or crash-consistent algorithm.

**Prerequisite for Chapters 63–65**

You should be able to route a boundary key, work a leaf and internal split, repair separators after redistribution or merge, derive fanout from a byte budget, and distinguish conceptual page visits from cache/device I/O. Chapter 63 adds page representation, Chapter 64 adds safe implementation and concurrency, and Chapter 65 adds transactional recovery.
