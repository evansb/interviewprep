# Chapter 63 — File Formats

*Interview-focused revision notes. The theme: an on-disk format is what you get when you take an in-memory data structure and strip out everything the file cannot keep — the pointers, the address-space assumptions, the freedom to be any size — and replace it with page-id addressing, explicit lengths, fixed-size blocks, and a checksum. PostgreSQL's 8 KB heap page is the reference throughout; every design choice in it answers a constraint that RAM does not impose and disk does.*

---

## 63.1 Why Databases Define Their Own On-Disk Formats

A storage engine cannot simply `write()` its in-memory structures to disk and `read()` them back. Chapter 61 (§61.4) gave the one-sentence reason — *you cannot store a pointer* — and this chapter is the consequence worked out in full. An on-disk format is a serialization discipline shaped by four constraints that main memory does not impose:

1. **No pointers.** A heap-allocated node holds `Node*` values that are virtual addresses (Ch. 32). Written to disk and mapped again next run — possibly at a different base, in a different process — every one of them is garbage. On-disk references must be **position-independent**: a page number plus an offset (§63.2), meaningful regardless of where the file is mapped.
2. **The block, not the byte, is the unit of transfer.** A DRAM access is ~100 ns; a random NVMe read is ~50–100 µs; a seek on spinning rust is ~10 ms (Ch. 30). The device moves data in **sectors** (512 B or 4 KB) and the OS in **pages** (4 KB, Ch. 32); the database amortizes that cost by working in larger fixed blocks — 8 KB in Postgres, 16 KB in InnoDB. The format is organized *around* the block because the block is what an I/O actually moves (Ch. 34).
3. **Self-description and durability.** Bytes on disk outlive the process that wrote them and must survive its crash. The format therefore carries its own **version** (so a newer binary can read an older file, §63.17), its own **checksum** (so corruption is detected, not silently served, §63.18), and enough structure to be parsed with no external schema baked into pointer offsets.
4. **Portability limits are chosen deliberately.** The format writer decides how portable the file is: whether integers are big- or little-endian (§63.3), whether fields are aligned (§63.6), whether the layout depends on the host ABI at all. Postgres chooses *speed over portability* — its files are not portable across endianness or alignment (§63.21) — while SQLite chooses the opposite.

The mental model to carry into the rest of the chapter: **an on-disk format is a wire format that happens to be read by the same program that wrote it** (Ch. 3 §3.12 is the C++-level version of the same discipline — fixed widths, explicit padding, explicit byte order, no pointers, versioned, checked). Everything below is that discipline applied to a page.

---

## 63.2 Page-Id and Offset Addressing

Because a raw address is meaningless across restarts, on-disk structures address data by a **logical location**: the pair *(page id, in-page offset)*. This is the single most important idea in the chapter — it is what makes every reference in every index and every intra-file link survive being written, evicted, and re-read at a new address.

A **page id** (Postgres: *block number*, `BlockNumber`, a 32-bit unsigned integer) is the ordinal of a fixed-size page within the file: page 0 starts at byte 0, page 1 at byte `BLCKSZ`, page *N* at byte `N × BLCKSZ`. Converting a page id to a file offset is a shift, not a lookup — the whole point of fixed-size pages (§63.8). With an 8 KB page and a 32-bit block number, one **fork** of a relation addresses up to `2^32 × 8 KB = 32 TB`; Postgres splits it into 1 GB **segment files** (`relfilenode`, `relfilenode.1`, …) so no single file must exceed what old filesystems allowed.

An **offset** locates data *within* a page. In a slotted page (§63.10) the index does not even store the raw byte offset — it stores a **slot number** (Postgres: line-pointer index), and the slot holds the offset. This is the *double indirection* Chapter 61 (§61.14) flagged: index entry → **TID** *(block number, line-pointer index)* → **line pointer** *(offset, length)* → tuple bytes. The extra hop is deliberate: it lets the engine move a tuple within its page (compaction, §63.15) by rewriting one 4-byte line pointer, without touching a single index that references it.

```
TID = (block number, line-pointer index)          ← what an index leaf stores
        │                    │
        │                    └─▶ pd_linp[idx]  →  (lp_off, lp_len)   ← line pointer in the page
        │                                              │
        └─▶ file offset = block × 8192                 └─▶ tuple at page + lp_off
```

Contrast with an in-memory B-tree, whose internal nodes hold real child pointers. On disk those become **child page ids**; a B-tree descent (Ch. 62, Ch. 64) is a sequence of *page-id dereferences*, each one a buffer-pool lookup (Ch. 61 §61.15) that either hits RAM or issues a block read. Page-id addressing is why the same tree structure works identically in cache and on disk.

---

## 63.3 Binary Encoding of Primitive Types

At the bottom of every format are the primitive scalars, encoded as fixed-width binary — not text. The choices mirror Chapter 3 exactly, because an on-disk record *is* an object representation (Ch. 3 §3.1) that must be readable by a future run.

**Fixed-size integers.** Encoded in their natural width: 1, 2, 4, 8 bytes. The two live questions are **signedness** and **endianness** (Ch. 3 §3.9):

- *Endianness* is the order of the bytes of a multi-byte scalar. Network protocols and many portable file formats use **big-endian** ("network byte order", Ch. 3 §3.9, Ch. 36) so the file reads the same on any host. Postgres, by contrast, writes integers in **host-native** byte order (little-endian on x86-64/ARM) — it never byte-swaps on the storage path, trading portability for the elimination of a swap on every field access (§63.21). SQLite writes **big-endian** regardless of host, which is one reason a SQLite file is byte-for-byte portable and a Postgres file is not.
- *Signed integers* are two's complement (universal on real hardware, and mandated since C++20). A subtlety for **ordered** formats: two's-complement negative integers have their high bit set, so a naive `memcmp` of raw signed integers sorts negatives *after* positives. Formats that rely on byte-wise key comparison (some LSM key encoders, Ch. 67) flip the sign bit on encode so that lexicographic byte order matches numeric order — a trick worth naming.

**Floating point** is stored as raw IEEE-754 (Ch. 3), 4 or 8 bytes. Two gotchas recur: `+0.0` and `-0.0` are equal values with different bit patterns, and NaN has many representations — so byte-comparing floats is wrong (exactly why `has_unique_object_representations_v` is false for float types, Ch. 3 §3.2). Databases that must sort floats normalize these cases.

**Fixed vs variable size** is the first structural fork. A `bool`, `int4`, `float8`, `timestamp`, or `char(n)` with a fixed length is stored inline at a computable offset. A `text`, `bytea`, `varchar`, `numeric`, or array is **variable-size** and needs an explicit length (§63.4). Postgres records this per type as `attlen` in `pg_attribute`: a positive number is the fixed width; **`-1`** means a varlena (variable-length, length-prefixed); **`-2`** means a C-string (NUL-terminated, used for `cstring` internally).

---

## 63.4 Variable-Size Data and Length-Prefixed Strings

A string has no natural fixed width, so its bytes must be preceded (or, rarely, followed) by something that says how many there are. Two encodings exist and the trade-off is classic:

- **Length-prefixed** ("counted"): store the length, then the bytes. Random-access to the end is O(1) (you know the size), the bytes may contain any value including NUL, and validation is trivial. This is what databases use.
- **Terminated** (C strings, `attlen = -2`): a sentinel byte (NUL) ends the value. No length field, but the value cannot contain the sentinel, and finding the length is an O(n) scan. Databases avoid this for user data.

Postgres's length-prefixed type is the **varlena** (`struct varlena`), and its header is a small masterpiece of space optimization worth knowing in byte-level detail:

```
Four-byte header (varattrib_4b):   used when total length > 126 bytes
  ┌───────────────┬───────────────────────────────────────┐
  │ 4-byte length header (len in 30 bits + 2 flag bits)    │  data ...
  └───────────────┴───────────────────────────────────────┘
  VARSIZE(x) = total incl. header;  VARDATA(x) = payload start (x + 4)
  Max payload: 2^30 − 1 ≈ 1 GB  (this is the hard per-field limit)

One-byte header (varattrib_1b):    used when total length ≤ 126 bytes
  ┌───┬───────────────────────────────┐
  │ 1 │ up to 126 bytes of data        │   header byte = length, high bit flags "short"
  └───┴───────────────────────────────┘
  Saves 3 bytes on every short string — huge on tables of small text columns.

TOAST pointer (varattrib_1b_e):    an 18-byte out-of-line reference (§63.16)
  ┌───┬──────────────────────────────────────────────┐
  │tag│ va_rawsize, va_extsize, va_valueid, va_toastrelid │
  └───┴──────────────────────────────────────────────┘
```

The **short 1-byte header** (added in Postgres 8.3) is why a table of short strings is not bloated by 4-byte length words: a value up to 126 bytes pays a single header byte. The engine distinguishes the three forms by examining the first byte's low/high bits — and *that bit test depends on endianness*, which is a root cause of Postgres file non-portability (§63.21). The 30-bit length field caps any single field at just under **1 GB**; larger logical values are impossible in a single attribute.

For interviews, the general principle is what matters: **variable-length data is length-prefixed, the length lives with the value, and a good format special-cases the common short value to avoid a fat header.** LSM SSTables, Parquet pages, and protobuf all make the same choice (protobuf uses a varint length prefix).

---

## 63.5 Bit-Packed Data: Booleans, Flags, and Null Bitmaps

Storing one boolean per byte wastes 7 bits; storing eight booleans per byte is free. On-disk formats therefore **bit-pack** small categorical data — but only where the density is worth the extra masking on read. Three uses dominate:

**Flag/status words.** A page or record header packs many independent booleans into one integer, read with masks. Postgres's tuple header has two 16-bit **infomask** words (§63.12): `t_infomask` carries `HEAP_HASNULL` (0x0001), `HEAP_HASVARWIDTH` (0x0002), `HEAP_HASEXTERNAL` (0x0004, i.e. has a TOAST pointer), `HEAP_XMIN_COMMITTED`/`HEAP_XMIN_INVALID` hint bits, `HEAP_XMAX_COMMITTED`, and more; `t_infomask2` packs the attribute count in its low 11 bits (`HEAP_NATTS_MASK`) alongside the HOT/visibility flags `HEAP_HOT_UPDATED`, `HEAP_ONLY_TUPLE`, and `HEAP_KEYS_UPDATED`. Every one of those bits saves a byte and, more importantly, is testable with a single AND.

**Enums** are stored as their integer code, not their text, in the minimum width that holds the domain. Postgres enum values are 4-byte OIDs internally; a column-store dictionary-encodes the domain to `⌈log2(cardinality)⌉` bits per value (Ch. 61 §61.6).

**Null bitmaps** are the canonical bit-packed structure and a favorite interview target. Rather than store a per-column "is null" byte, a record with nullable columns carries a **bitmap of one bit per column**, present only when at least one column is actually null. In a Postgres heap tuple the null bitmap (`t_bits`) appears immediately after the 23-byte fixed header, sized `⌈natts / 8⌉` bytes, and *only if* `HEAP_HASNULL` is set (otherwise it is omitted entirely — a row with no nulls pays zero bitmap bytes). A set bit means the column *is present* (not null); a clear bit means null, and the null column then occupies **no space at all** in the data area:

```
Tuple with 10 columns, columns 3 and 7 null:
  [23-byte header | t_bits = 1 0 1 1 1 1 0 1 1 1 (+pad to 2 bytes) | data for the 8 non-null cols]
                     col1 ...          col10       ^ nulls consume no data bytes
```

The payoff: a wide table with many usually-null columns stores almost nothing for the nulls. The cost: the bitmap must be consulted to compute *any* later column's offset, because a null shifts everything after it — which is one reason variable/nullable columns are read left-to-right and why a column after many varlenas has no constant offset (§63.7).

---

## 63.6 Alignment and Padding in On-Disk Records

The same alignment rules that shape an in-memory struct (Ch. 3 §3.3–3.4) apply to on-disk records, because the engine wants to read a field with a natural aligned load rather than a byte-assembly loop. Postgres aligns every stored attribute to its type's `attalign`:

| `attalign` | boundary | types |
|---|---|---|
| `c` (char) | 1 byte | `bool`, `char`, short varlenas (1-byte header) |
| `s` (short) | 2 bytes | `int2`, `smallint` |
| `i` (int) | 4 bytes | `int4`, `float4`, `date`, 4-byte-header varlenas |
| `d` (double) | 8 bytes | `int8`, `float8`, `timestamp` |

The tuple's data area begins at `t_hoff`, which is itself **MAXALIGN**'d — `MAXALIGN` rounds up to `MAXIMUM_ALIGNOF`, normally **8** (the alignment of `double`/`int8` on 64-bit platforms). So the 23-byte header plus null bitmap is padded up to a multiple of 8 before column data starts; a null-free tuple has `t_hoff = 24` (`MAXALIGN(23)`). Between columns, **alignment padding** bytes are inserted exactly as in a C struct, and — exactly as in Ch. 3 §3.4 — column *declaration order* determines how much padding you pay:

```
CREATE TABLE bad  (a bool, b int8, c bool, d int4);   -- pays padding twice
   a[1] pad[7] b[8] c[1] pad[3] d[4]            → 24 bytes of tuple data
CREATE TABLE good (b int8, d int4, a bool, c bool);   -- packed
   b[8] d[4] a[1] c[1] pad[2]                   → 16 bytes of tuple data
```

That is a **33% shrink** of the on-disk row from column ordering alone, and unlike a C++ struct there is no `pahole` in your face — the waste is invisible until you measure `pg_column_size` or a table's on-disk footprint. The interview point mirrors Ch. 3 exactly: **declare columns largest-alignment-first to minimize inter-column padding**, and be aware the engine does not reorder for you (Postgres deliberately preserves logical column order on disk).

A crucial exception: a **varlena with a 1-byte header** (§63.4) has `char` alignment and needs **no** preceding padding, so Postgres can pack short strings tightly. This interacts with alignment in a way that makes the *first* varlena cheap and any fixed-width column placed after a run of varlenas non-constant-offset (§63.7).

---

## 63.7 Separating Fixed and Variable Parts

The general layout principle underneath §63.4–63.6: a record splits into a **fixed part** whose fields have constant offsets, and a **variable part** whose fields must be located by walking or by a small offset table. Getting this split right is what makes column access fast.

The naive layout — fields in declaration order, variable data inline — has a fatal property: **the offset of any field after the first variable-length field is not a constant.** To read column 9 you must decode the lengths of columns 1–8. Postgres's heap tuple has exactly this property: attribute *k*'s offset depends on the widths (and null-ness) of all attributes before it, so `heap_deform_tuple` walks left to right, and Postgres caches per-attribute offsets (`attcacheoff`) only up to the first variable-width or nullable column. This is why *column position matters for read cost*, and why frequently-accessed fixed-width columns are best placed early.

Two better layouts avoid the walk and appear across systems:

- **Offset/pointer array inside the record.** Store all fixed fields, then an array of offsets to each variable field, then the variable bytes. Now any variable field is one indirection away (read its offset, jump). This is the record-level analogue of the slotted page (§63.10) — a slot directory, but for fields within a row. SQLite's record format uses a header of per-column *serial types* (varint-encoded type-and-length codes) at the front, so the parser learns every column's size before the body (§63.20).
- **Fixed and variable in separate regions.** Keep the fixed-width columns packed contiguously (constant offsets, vectorizable), and push variable-length columns to a tail region reached by offset. This is the direction column stores take to the extreme (Ch. 61 §61.6): each column is its own contiguous region entirely.

```
General record layout (the pattern to remember):
  ┌──────────────┬──────────────────┬───────────────────────────┐
  │ fixed part   │ offsets to var    │ variable-length payloads   │
  │ (const offs) │ fields (a table)  │ (strings, arrays, blobs)   │
  └──────────────┴──────────────────┴───────────────────────────┘
```

The unifying idea: **constant offsets are free to read; variable data costs an indirection or a walk, so put a small offset table between them.** Every format in this chapter is a variation on where that table lives — in the row (SQLite), in the page (slotted pages), or in a file footer (Parquet).

---

## 63.8 Fixed-Size Pages as the Unit of I/O

Records are grouped into **pages** (also called *blocks*): fixed-size, contiguous regions that are the granularity of reads, writes, caching, and locking. A page is the atom of the storage engine — the buffer pool (Ch. 61 §61.15) caches pages, the I/O layer transfers pages, and a latch protects a page.

**Why fixed-size:**

- **O(1) addressing.** Page *N* is at byte `N × page_size` — a shift, no directory (§63.2). Variable-size pages would need an offset index just to find a page.
- **Simple free-space management.** A freed page is a fixed-size hole any other page can reuse; there is no external fragmentation *at the page level* (fragmentation only lives *inside* a page, §63.14).
- **Alignment with the storage stack.** An 8 KB page is a whole number of 4 KB OS pages (Ch. 32) and device sectors, so a page read is a clean, aligned I/O (Ch. 34).

**Common page sizes** are a small, telling table:

| System | Default page size | Configurable? |
|---|---|---|
| PostgreSQL | **8 KB** (`BLCKSZ`) | compile-time only (1–32 KB) |
| MySQL / InnoDB | **16 KB** (`innodb_page_size`) | 4/8/16/32/64 KB at init |
| SQLite | **4 KB** (since 3.12) | `PRAGMA page_size`, 512 B–64 KB |
| Oracle | 8 KB (`db_block_size`) | 2–32 KB |
| Parquet | ~1 MB **row group**, ~1 MB pages | writer option |

The size is a **fanout vs. write-amplification** trade (Ch. 62, §63.21). Bigger pages → higher B-tree fanout → shallower tree → fewer seeks per lookup, but more bytes read for a point lookup and a larger torn-write window (§63.19). 8–16 KB is the industry sweet spot for OLTP; analytics formats go far larger because they scan.

A page is not addressed by a pointer but referenced by page id, and internally it is organized so records can be added, removed, and moved without disturbing the references into it — which is the slotted page.

---

## 63.9 The Page Header

Every page begins with a fixed **header** holding page-level metadata: free-space pointers, a version, a checksum, and log-sequence information for recovery. Postgres's `PageHeaderData` is exactly **24 bytes** and every field earns its place:

```
PageHeaderData — 24 bytes, at offset 0 of every heap and index page
 off  size  field                 meaning
 ───  ────  ────────────────────  ──────────────────────────────────────────────
  0    8    pd_lsn                 WAL LSN of the last change to this page (Ch. 65)
                                     — recovery replays WAL only past this point
  8    2    pd_checksum           16-bit page checksum (0 if checksums disabled, §63.18)
 10    2    pd_flags              page-level flag bits (has free line ptrs, all-visible…)
 12    2    pd_lower              byte offset to END of line-pointer array (start of free space)
 14    2    pd_upper              byte offset to START of tuples (end of free space)
 16    2    pd_special            byte offset to the special space (page end for heap;
                                     index opaque data for B-tree, §63.11)
 18    2    pd_pagesize_version   page size OR'd with layout version (§63.17)
 20    4    pd_prune_xid          oldest un-pruned XID hint (helps VACUUM/HOT, Ch. 65)
 ───  ────
 24          pd_linp[]            the line-pointer (ItemIdData) array begins here
```

Three fields carry most of the weight:

- **`pd_lower` / `pd_upper`** are the free-space pointers that make the page a slotted page (§63.10): free space is the contiguous gap `[pd_lower, pd_upper)`. Free bytes = `pd_upper − pd_lower`. Adding a tuple grows `pd_lower` down (a new line pointer) and shrinks `pd_upper` up (the tuple body).
- **`pd_lsn`** ties the page to the write-ahead log: a page must not be flushed to disk until the WAL record at `pd_lsn` is durable (the **WAL rule**, Ch. 65). It is also how full-page-write recovery (§63.19) knows whether a WAL record predates the page image.
- **`pd_pagesize_version`** packs two things because the page size is always a multiple of 256, leaving the low 8 bits free for a version number (§63.17). The current layout version is **4**; an 8 KB page reads `0x2004` (0x2000 | 4).

The header being *fixed and first* is what lets any code open a page, read 24 bytes, and know the page's size, version, integrity, free space, and recovery position before parsing a single record.

---

## 63.10 Slotted Pages

The **slotted page** (or *slotted-page organization*) is the central idea of the chapter: the layout that lets a fixed-size page hold **variable-size records**, support **deletion** and **compaction**, and keep **stable references** to records that physically move — all at once. Petrov calls it the near-universal organization for record-oriented storage, and Postgres, InnoDB, SQLite, and essentially every disk B-tree use a version of it.

The construction: two structures grow toward each other from opposite ends of the page, with free space in the middle.

- From the **front** (right after the header) grows an array of small, fixed-size **slots** (Postgres: *line pointers*, `ItemIdData`; SQLite: the *cell pointer array*). Each slot records **where** a record lives and **how big** it is — an *(offset, length)* pair. Slots grow *downward* toward higher addresses.
- From the **back** (the end of the page) grow the **records themselves** (Postgres: *tuples*; general term: *cells*, §63.13), packed against the end, growing *upward* toward lower addresses.
- Between them is the **free space**, delimited by the header's `pd_lower` (end of slots) and `pd_upper` (start of cells).

```
┌────────────────────────────────────────────────────────────────────┐  ← offset 0
│ Page header (24 B): pd_lower, pd_upper, checksum, lsn, version ...   │
├────────────────────────────────────────────────────────────────────┤  ← 24
│ Slot 0 │ Slot 1 │ Slot 2 │ Slot 3 │ ...          slots grow  ──▶     │
│  (off,len each 4 B)                                                   │
│═══════════════════════ pd_lower ═══════════════════════════════════ │
│                                                                      │
│                        F R E E   S P A C E                           │
│                                                                      │
│═══════════════════════ pd_upper ═══════════════════════════════════ │
│      ◀── cells grow            ... cell3   cell2   cell1   cell0      │
│  each cell: record header + field data (variable length)             │
├────────────────────────────────────────────────────────────────────┤
│ special space (heap: empty; B-tree: sibling links, flags) │ pd_special│
└────────────────────────────────────────────────────────────────────┘  ← 8192
```

Why this specific shape solves every problem at once:

- **Variable-size records with no external fragmentation.** A new cell of any size is placed at `pd_upper − size`; a new slot at `pd_lower`. Records of different sizes coexist; the only fragmentation is *internal* free bytes, reclaimable by compaction (§63.15) — never the external fragmentation of a free-list allocator.
- **Stable references under movement.** An index (or a sibling page) references a record by **slot number**, never by byte offset. Compaction slides cells around and rewrites the slot's offset; the slot number is unchanged, so **no external reference needs updating**. This is the indirection of Chapter 61 §61.14, and it is the reason the slot array exists at all.
- **Two independent allocators, one gap.** Slots and cells never interleave, so growth is just two pointers moving toward each other. The page is "full" when `pd_lower` meets `pd_upper` (accounting for the size of the next slot + cell).
- **Ordered iteration decoupled from physical order.** Cells sit in insertion order (wherever there was room), but the *slot array* can be kept in **key order** (as B-tree pages do), giving sorted access and binary search over slots while cells stay physically wherever they landed. Reordering rows = reordering 4-byte slots, not moving cell bytes.

This last point is the quiet power of slotted pages: **logical order lives in the cheap slot array; physical placement lives in the expensive cell area; the two are decoupled.**

---

## 63.11 The PostgreSQL Heap Page in Full

Grounding the abstraction in the real Postgres page (recapping Ch. 61 §61.7 at byte resolution). An 8 KB heap page has four regions:

```
8192-byte heap page
┌─────────────────────────────────────────────────────────┐ 0
│ PageHeaderData                              24 bytes      │
├─────────────────────────────────────────────────────────┤ 24
│ ItemIdData array  (line pointers, 4 B each)              │
│  lp[0] lp[1] lp[2] ...                    ─── grows ──▶   │
│  each: lp_off:15  lp_flags:2  lp_len:15                  │  ← pd_lower marks the end
├─────────────────────────────────────────────────────────┤
│                     free space                           │
├─────────────────────────────────────────────────────────┤  ← pd_upper marks the start
│  ...  tuple[2]   tuple[1]   tuple[0]      ◀── grows ───   │
│  each: HeapTupleHeaderData (23 B) + null bitmap + data   │
├─────────────────────────────────────────────────────────┤  ← pd_special
│ special space: EMPTY for heap (pd_special = 8192)        │
└─────────────────────────────────────────────────────────┘ 8192
```

The **line pointer** (`ItemIdData`) is a single 32-bit word, tightly bit-packed (§63.5) into three fields:

```
ItemIdData — 4 bytes = 32 bits
  ┌──────────────────┬────────┬──────────────────┐
  │ lp_off : 15 bits │lp_flags│  lp_len : 15 bits │
  └──────────────────┴──2 bits┴──────────────────┘
  lp_off : byte offset of the tuple within the 8 KB page (15 bits ⇒ 0..32767 ⊇ 8192)
  lp_len : byte length of the tuple
  lp_flags : LP_UNUSED(0) LP_NORMAL(1) LP_REDIRECT(2) LP_DEAD(3)
```

The `lp_flags` states are the machinery behind deletion and HOT (Ch. 61 §61.14):

- **`LP_NORMAL`** — a live line pointer; `lp_off`/`lp_len` locate a real tuple.
- **`LP_DEAD`** — the tuple is dead (no transaction can see it); the line pointer is retained but the space is reclaimable. Index entries may still point here until cleaned.
- **`LP_REDIRECT`** — used for **HOT chains**: the slot points not at a tuple but at *another line pointer* on the same page (`lp_off` is a line-pointer index). This is what lets the head of a HOT chain be redirected to the current version while the *original TID the index holds* stays valid — indirection on top of indirection.
- **`LP_UNUSED`** — free slot, available for reuse (this is what VACUUM produces from `LP_DEAD`).

The **special space** at the page tail (`pd_special`) is empty for a heap (so `pd_special = pd_pagesize = 8192`), but a **B-tree index page** puts its `BTPageOpaqueData` there (16 bytes): the left/right sibling block numbers (`btpo_prev`, `btpo_next`) that thread leaves into a doubly-linked list for range scans (Ch. 62), plus level and flag bits. Same page skeleton, different tail — a clean example of one slotted-page format serving both heap and index.

---

## 63.12 The Heap Tuple Header

Each cell in a heap page is a tuple prefixed by `HeapTupleHeaderData` — **23 bytes** fixed, then an optional null bitmap, then the column data. The exact layout is a frequent interview target because every byte encodes an MVCC or layout fact (Ch. 61 §61.7, Ch. 65):

```
HeapTupleHeaderData — 23 bytes fixed
 off  size  field          meaning
 ───  ────  ─────────────  ─────────────────────────────────────────────────
  0    4    t_xmin         inserting transaction id (MVCC, Ch. 65)
  4    4    t_xmax         deleting/locking transaction id (0 if live)
  8    4    t_cid / t_xvac command id within the xact (union field)
 12    6    t_ctid         (block, offset) of THIS or the NEXT row version
 18    2    t_infomask2    low 11 bits = column count; high bits = HOT/key flags
 20    2    t_infomask     null/varwidth/external + xmin/xmax commit hint bits
 22    1    t_hoff         byte offset from tuple start to column data (MAXALIGN'd)
 ───  ────
 23          t_bits[]      null bitmap: ⌈natts/8⌉ bytes, ONLY if HEAP_HASNULL
                           then padding to t_hoff, then the column data
```

Key facts to have ready:

- **`t_xmin`/`t_xmax`** implement MVCC: an update writes a *new* tuple version and stamps the old one's `t_xmax`; both versions coexist on the page until VACUUM reclaims the dead one (Ch. 61 §61.7, Ch. 65). This is *why the heap is multi-versioned on disk* and why dead space accumulates.
- **`t_ctid`** normally points at the tuple itself; after an update it points forward to the successor version's TID, forming the update chain. It is 6 bytes: a 4-byte block id + 2-byte offset — the on-disk TID (§63.2).
- **`t_hoff`** is where the column data starts and is **MAXALIGN'd to 8** (§63.6). With no nulls, `t_hoff = 24` (padding the 23-byte header up to 8). With a null bitmap, `t_hoff = MAXALIGN(23 + ⌈natts/8⌉)`.
- **The 23→24 padding** means the *minimum* heap tuple overhead is 24 bytes of header before any data, plus the 4-byte line pointer — **28 bytes of pure overhead per row**. On a table of narrow rows this is the dominant cost and the reason very wide, very short rows waste space; it is also why Postgres cannot store more than `⌊8192 / (28 + data)⌋`-ish tuples per page (MaxHeapTuplesPerPage caps it near 291).

The header being fixed-size and first means the executor can read visibility (`t_xmin`, `t_xmax`, `t_infomask`) *without* decoding the row's columns — visibility checks touch only the header, which is why an index-only scan can consult the visibility map instead of the tuple (Ch. 61 §61.13).

---

## 63.13 Cell Layout: Key Cells and Key-Value Cells

Petrov's vocabulary for the records inside a slotted page is the **cell**, and the distinction between two cell kinds explains the difference between a B-tree's internal and leaf pages.

- A **key cell** holds a *separator key* and a *pointer to a child page* — it says "keys ≥ this go down there." It lives in **internal (branch) nodes** of a B-tree. It carries no user value, only routing information: `[key][child page id]`.
- A **key-value cell** holds a key and its associated **value** (the row, or the indexed columns plus a TID). It lives in **leaf nodes**: `[key][value]`.

```
Internal B-tree page (key cells):        Leaf B-tree page (key-value cells):
  [k1 | child0][k2 | child1][k3 |...]      [k1 | TID/row][k2 | TID/row]...
   routing only, values absent              actual payload at the bottom
```

Combining cells into a page is just the slotted-page mechanism (§63.10): cells (of either kind, variable-length because keys vary) fill from the back, slots index them from the front, and the slot array is kept **sorted by key** so a page lookup is a binary search over slots followed by one cell dereference. Because the two cell kinds share the same slotted-page container, **one page format serves both levels of the tree** — the only difference is what the cell holds (a child id vs. a value), which is why B-tree code paths for internal and leaf pages are so similar (Ch. 62, Ch. 64).

Two practical layout notes on cells:

- **Managing variable-size keys.** Keys are variable-length (a `varchar` key, a multi-column key), so cells are variable-length, which is exactly why slotted pages (not fixed arrays) are used for index pages. Some engines store a **prefix-truncated** separator in internal nodes — the shortest key that still routes correctly — to fit more cells per page and raise fanout (a §63.21 concern).
- **Overflow for oversized cells.** A cell that does not fit in a page (a huge key or value) is handled by *out-of-line* storage — Postgres TOAST for heap values (§63.16), overflow pages for InnoDB/SQLite. The slotted page never holds a cell larger than the free space; the format always has an escape hatch to a separate page chain.

---

## 63.14 Deletion, Fragmentation, and Free Space

Deletion in a slotted page is deliberately **not** an immediate byte-level removal, because moving cells on every delete would be expensive and would invalidate references mid-flight. Instead, deletion is a two-phase affair: **mark now, reclaim later.**

**Marking.** To delete a record, the engine marks its **slot**, not its bytes. In Postgres, a delete stamps the tuple's `t_xmax` (MVCC — the row is still visible to older snapshots, Ch. 65); once no snapshot can see it, VACUUM sets the line pointer to `LP_DEAD`, and later to `LP_UNUSED`. The cell's bytes still sit in the page as a **hole**. In a plain (non-MVCC) slotted page, deletion simply flags the slot dead and leaves the cell as dead space.

**Fragmentation.** After a series of deletes and variable-size inserts, the page's free space is split into two kinds:

```
Before compaction: free space is fragmented
┌────────────────────────────────────────────────────────────┐
│ header │ slots: [live][DEAD][live][UNUSED] ─▶                │
│═══ pd_lower ═══                                              │
│           contiguous free (between pointers)                 │
│═══ pd_upper ═══                                              │
│  live │ ░░ hole ░░ │ live │ ░░ hole ░░ │ live                │
│         ^ dead cell bytes are internal fragmentation         │
└────────────────────────────────────────────────────────────┘
```

- **Contiguous free space** between `pd_lower` and `pd_upper` — immediately usable for the next cell.
- **Fragmented free space** — the holes left by deleted cells, scattered among live cells. Unusable until reclaimed, because a new cell needs *contiguous* bytes.

The header often tracks reclaimable space so the engine knows whether compaction would help. Postgres's `pd_flags` carries `PD_HAS_FREE_LINES` (some line pointer is `LP_UNUSED` and reusable) and the free space per page is summarized in a separate **Free Space Map** (`_fsm` fork) so an insert can find a page with room without scanning. The **fragmentation invariant** to remember: *slotted-page fragmentation is always internal to a page and always reclaimable by compaction* — it never becomes the un-coalescable external fragmentation of a general heap allocator, precisely because every live cell is relocatable via its slot.

---

## 63.15 Defragmentation and Compaction

**Compaction** (Postgres: *page pruning* / the defragmentation step of VACUUM) reclaims fragmented free space by sliding all live cells together against the end of the page, coalescing the holes into one contiguous free region — and it is *safe* precisely because of slotted-page indirection.

The operation:

1. Walk the slots; collect the live cells (skip `LP_DEAD`/`LP_UNUSED`).
2. Copy live cells to the top of a fresh page image (or compact in place), packed against the page end.
3. **Rewrite each live slot's offset** (`lp_off`) to the cell's new position; lengths and *slot numbers* are unchanged.
4. Reset `pd_upper` to the new top-of-cells; now free space is one contiguous block.

```
After compaction:
┌────────────────────────────────────────────────────────────┐
│ header │ slots (same slot numbers, updated offsets) ─▶      │
│═══ pd_lower ═══                                              │
│          one large contiguous free region                   │
│═══ pd_upper (moved up) ═══                                   │
│                      live │ live │ live   (holes gone)       │
└────────────────────────────────────────────────────────────┘
```

The critical property: **no reference outside the page changes.** Every index leaf, every sibling link, still names the cell by *(block, slot number)*; only the slot's internal `lp_off` moved. This is the entire payoff of storing a slot number instead of a byte offset (§63.2, §63.10, Ch. 61 §61.14). Without the slot layer, compaction would have to find and rewrite every index entry pointing into the page — turning a local page operation into a whole-table one.

Postgres does this opportunistically: **HOT pruning** compacts a page's dead HOT-chain tuples during ordinary access when the page is being written anyway, and VACUUM does a fuller pass. Both are page-local, WAL-logged, and reference-preserving. The interview one-liner: **compaction is cheap and reference-stable because a slotted page addresses records by relocatable slot, not by fixed offset.**

---

## 63.16 TOAST: Oversized-Attribute Storage

A page is 8 KB, and Postgres requires **at least four tuples per heap page**, so no single tuple may exceed roughly **2 KB** — yet columns can be up to 1 GB (§63.4). **TOAST** (The Oversized-Attribute Storage Technique) is how Postgres stores values larger than a page: compress them, and if still too big, move them **out-of-line** to a side table, leaving only an 18-byte pointer in the row.

**The threshold.** `TOAST_TUPLE_THRESHOLD` ≈ **2000 bytes** (exactly `MAXALIGN_DOWN((BLCKSZ − header) / 4)` for 4 tuples/page). When a tuple's total width exceeds this, the TOAST machinery runs on its variable-length (toastable) attributes, largest first, until the tuple fits:

1. **Compress** the value in place (default codec **pglz**; **LZ4** available since Postgres 14 via `default_toast_compression`). If compression alone brings the tuple under threshold, done — the compressed value stays inline.
2. **Move out-of-line.** If still too big, write the (possibly compressed) value to the table's **TOAST table** — an auto-created relation `pg_toast.pg_toast_<oid>` — and replace the column in the main tuple with an 18-byte **TOAST pointer** (`varatt_external`: raw size, external size, value OID, TOAST relation OID).

**The TOAST table** is itself an ordinary heap. The large value is split into **chunks** of `TOAST_MAX_CHUNK_SIZE` ≈ **1996 bytes** (so ~4 chunks per TOAST page), each a row `(chunk_id, chunk_seq, chunk_data)`, with a B-tree index on `(chunk_id, chunk_seq)` for ordered reassembly:

```
Main heap tuple:                    TOAST table pg_toast_<oid>:
  [... | 18-byte TOAST ptr | ...]     (chunk_id=42, seq=0, data[0..1995])
              │  va_valueid=42        (chunk_id=42, seq=1, data[1996..3991])
              └──────────────────────▶(chunk_id=42, seq=2, data[3992..])
                                       indexed on (chunk_id, chunk_seq)
```

**Per-column storage strategy** (`ALTER TABLE ... SET STORAGE`) tunes this:

| Strategy | Compress? | Out-of-line? | Use |
|---|---|---|---|
| `PLAIN` | no | no | fixed-width, non-toastable types |
| `EXTENDED` | yes | yes | **default** for toastable types |
| `EXTERNAL` | no | yes | fast substring/`LEFT()` on big values (no decompress) |
| `MAIN` | yes | last resort | prefer keeping compressed value inline |

The interview points: TOAST is **transparent** (queries never mention it), it makes the effective row-width limit ~1 GB despite an 8 KB page, and it is why a `SELECT` of a small column from a wide row is cheap — the big TOASTed columns are not read unless referenced (Postgres does not de-TOAST columns a query never touches). The out-of-line-plus-pointer pattern is universal: InnoDB overflow pages and SQLite overflow-page chains solve the same "value bigger than a page" problem the same way.

---

## 63.17 Versioning and Magic Numbers

On-disk formats outlive the code that wrote them, so a durable format must answer *"what version am I, and is this even my file?"* — via **magic numbers** and **version numbers**.

**Magic numbers** are a fixed byte signature that identifies a file (or page) as belonging to a format, caught early so a wrong or corrupt file fails loudly instead of being misparsed:

- **SQLite**: the file begins with the 16-byte string `"SQLite format 3\000"` — read it and you instantly know the format.
- **Parquet**: the 4-byte magic `"PAR1"` appears at **both** the start and the end of the file; the trailing copy lets a reader validate the file and locate the footer by seeking to the end (§63.20).
- **PNG, ELF, class files**, and most binary formats open with a magic (`0x89PNG`, `0x7FELF`, `0xCAFEBABE`) — the same discipline.
- **Postgres** does not put a magic in every 8 KB heap page (space is precious and the file is only ever opened by Postgres), but its **WAL** pages carry `XLOG_PAGE_MAGIC`, and the cluster's `pg_control` file carries `PG_CONTROL_VERSION` and a `CATALOG_VERSION_NO` that must match the server binary, or startup refuses.

**Version numbers** let a format evolve while a newer binary still reads older files (backward compatibility). Postgres packs the **page layout version** into `pd_pagesize_version` (§63.9): because the page size is a multiple of 256, the low 8 bits hold the version. The current version is **4** (since 8.3, when short varlena headers and the current tuple layout landed); an 8 KB v4 page reads `0x2004`. On read, Postgres validates both the size and the version; a mismatch means the file was written by an incompatible layout and cannot be read in place — which is why **major-version upgrades that change the page format require `pg_upgrade`** (which can link files if the format is unchanged) or a dump/restore.

The general strategy every format follows: **a magic to reject foreign files, a version to gate parsing, and additive-only evolution** (new optional fields, never reordered or repurposed old ones — the same rule as Ch. 3 §3.12's "version the format"). Formats built for long-term interchange (Parquet, Avro) push this furthest with a full schema in the footer so old and new readers negotiate fields; embedded engines (Postgres) do the minimum because the same program reads and writes.

---

## 63.18 Page Checksums

Storage silently corrupts data: bit rot on the medium, a firmware bug, a misdirected write, a truncated write on power loss. A **page checksum** is a small integrity code stored in the page that lets a read *detect* corruption instead of returning wrong bytes as if they were right.

**Postgres data checksums.** When enabled, every page's 24-byte header carries a **16-bit** `pd_checksum` (§63.9). The lifecycle:

- **On write** (evicting a dirty page from the buffer pool to disk): compute the checksum over the whole page and stamp `pd_checksum`.
- **On read** (loading a page from disk into the buffer pool): recompute and compare; a mismatch raises an error (`invalid page in block …`) rather than serving the page. `zero_damaged_pages` and `pg_checksums` are the recovery/administration tools.

The algorithm is **not a CRC** — it is an **FNV-1a-based** checksum computed over the page as 32-bit words across 32 parallel accumulator lanes (deliberately SIMD-friendly so it is cheap on the hot I/O path, Ch. 42), folded to 16 bits, then mixed with the **block number** so a page written to the *wrong location* (a misdirected write) is also caught. During computation the `pd_checksum` field is treated as zero so the code is self-consistent. Enabled at `initdb --data-checksums` or offline via `pg_checksums`; as of **Postgres 18 (2025) data checksums are on by default**.

**What checksums catch and what they don't** — the crucial nuance:

| Detects | Does *not* detect / fix |
|---|---|
| Bit rot / media errors in a page on disk | In-memory corruption (checksum is stamped *after* the corruption if it happened in RAM) |
| A **torn page** — a partial write (§63.19) | It cannot **repair** anything — detection only |
| A misdirected write to the wrong block (block # is mixed in) | Corruption in transit *after* the checksum is verified |
| ~65535/65536 of random single-page corruptions | Some collisions (16-bit ⇒ ~1/65536 miss rate) |

Two boundary facts to state precisely: (1) the data checksum is a **page-level, on-disk integrity check**, separate from the **WAL's CRC-32C** (Castagnoli), which protects each *log record* — different structures, different algorithms, different failure domains. (2) A checksum **detects** a torn page but does **not** make writes atomic; recovering a torn page requires the mechanism in §63.19. Reporting that a checksum "prevents" torn writes is a classic error — it only reveals them.

---

## 63.19 The Torn-Page Problem and Full-Page Writes

An 8 KB Postgres page is not written atomically by the hardware. The device guarantees atomicity only at **sector** granularity (512 B, or 4 KB on modern drives); an 8 KB page is 2–16 sectors. If power is lost mid-write, some sectors are new and some are old — a **torn page** (also *partial write* / *fractured block*, Ch. 61 §61.5):

```
Writing an 8 KB page = up to 16 sector writes. Crash after sector 5:
  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
  │ NEW  │ NEW  │ NEW  │ NEW  │ NEW  │ OLD  │ OLD  │ OLD  │   ← mixed, self-inconsistent
  └──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
```

The page checksum (§63.18) will *notice* the tear on the next read, but noticing is not fixing — the page is a blend of two versions and neither the old nor the new data is fully present. Worse, the WAL replay after a crash normally applies **incremental** changes ("update 12 bytes at offset 400 of this page"), and a delta applied to a torn base page produces garbage.

**Postgres's solution: full-page writes (FPW).** With `full_page_writes = on` (the default), the **first modification of a page after each checkpoint** writes the *entire page image* into the WAL as a **full-page image (FPI)**, before the incremental changes. On crash recovery, when replay encounters an FPI it **overwrites the whole page** with the logged image rather than applying a delta — so a torn on-disk page is discarded and reconstructed from a known-good image, after which subsequent WAL deltas apply cleanly (Ch. 65 develops recovery in full).

```
Checkpoint ──▶ first write to page P: WAL record carries a FULL 8 KB image of P
               later writes to P:     WAL records carry only deltas
Recovery: replay hits the FPI ⇒ restore whole page ⇒ then apply deltas safely
```

The costs and the alternatives (all worth naming):

- **WAL amplification.** FPIs bloat the WAL, worst right after a checkpoint (every touched page logs a full image). `wal_compression` compresses FPIs to soften this; spacing checkpoints further apart reduces their frequency but lengthens recovery.
- **InnoDB's doublewrite buffer** solves the same problem differently: it writes each page **twice** — first sequentially to a *doublewrite* area, `fsync`, then to the final location. On recovery a torn final page is restored from its intact doublewrite copy. FPW logs to the WAL; doublewrite logs to a dedicated region — same guarantee, different mechanism.
- **When you can turn FPW off.** On storage that writes 8 KB atomically — a copy-on-write filesystem like **ZFS**, or NVMe with atomic-write support — torn pages cannot occur, and `full_page_writes = off` is safe and saves the WAL overhead. This is the direct link between the *format* (page bigger than a sector) and the *durability strategy* (Ch. 65): the whole problem exists only because the page is larger than the atomic write unit.

---

## 63.20 Other Formats: SQLite, InnoDB, and Parquet

The slotted-page and page-header ideas recur across engines with instructive variations.

**SQLite — the portable single-file database.** The entire database is one file, an array of pages (default **4 KB**, power of two, 512 B–64 KB). Page 1 opens with a **100-byte header** whose first 16 bytes are the magic `"SQLite format 3\000"`, followed by the page size, format versions, and the free-page count. Every table and index is a B-tree; a B-tree page is a **slotted page** with an 8-byte header (leaf) or 12-byte header (interior), a **cell-pointer array** of 2-byte offsets growing from the front, and cells growing from the end — the §63.10 structure exactly. Two deliberate portability choices distinguish it from Postgres: **all multi-byte integers are big-endian**, and the record format prefixes each row with a header of **varint serial-type codes** (§63.7) that also encode length — so a SQLite file is byte-for-byte identical across architectures (the design goal: a database file usable as an application file format for decades). Free space uses a **freeblock** linked list plus a fragmented-bytes counter within each page. Base SQLite has no per-page data checksum (its integrity comes from the rollback journal / WAL and an optional checksum VFS), a reminder that checksums are a *choice*, not a given.

**InnoDB — the 16 KB clustered B-tree.** MySQL/InnoDB pages default to **16 KB**. Each page has a **38-byte FIL header** (page number, previous/next page ids threading the level, LSN, page type, tablespace id, and a checksum at offset 0) and an **8-byte FIL trailer** whose low 32 bits of the LSN must equal the header's — a built-in torn-page detector independent of the checksum. Records are stored in a **compact row format** as a singly-linked list in key order from a synthetic *infimum* to *supremum* record, indexed by a sparse **page directory** of 2-byte slots (one per ~4–8 records) at the page end — a slotted directory used for binary search rather than for cell relocation, a subtly different use of the slot idea. The table itself is the clustered primary-key B-tree (Ch. 61 §61.12); oversized `BLOB`/`TEXT` go to **overflow pages** with a 20-byte pointer, InnoDB's TOAST. Torn writes are handled by the **doublewrite buffer** (§63.19).

**Parquet — the columnar, immutable file.** Parquet is the odd one out: **column-oriented** (Ch. 61 §61.6), append-only-immutable, and optimized for scans, not point writes. The file opens and closes with the magic `"PAR1"`; the **footer** holds Thrift-encoded metadata — the schema, and per-**row-group**, per-**column-chunk** metadata including byte offsets, encodings (dictionary, RLE/bit-packing, delta), and **statistics (min/max/null count)** that let a reader skip whole chunks that cannot match a predicate (the zone-map idea, Ch. 61 §61.8). Data pages may carry an optional **CRC-32 checksum**. Versioning lives in the metadata (a `version` field and per-column encodings) so old and new readers negotiate. Parquet is the concrete example of how the same design vocabulary — headers, length prefixes, checksums, versioning, statistics — assembles into a completely different shape when the workload is analytics rather than OLTP.

---

## 63.21 Endianness, Alignment Cost, Fanout, and Space

Closing with the cross-cutting trade-offs the format designer actually balances.

**Endianness portability.** A format is portable across architectures only if its byte order is fixed and its layout is host-independent. **SQLite and Parquet are portable** (fixed big-endian / defined encodings); **Postgres is not** — it writes host-native byte order and its varlena header bit-tests depend on endianness (§63.4), so a Postgres data directory cannot be copied between a big-endian and little-endian machine, and even `pg_upgrade` requires matching architecture and alignment. The trade Postgres made: skip the byte-swap on every integer field access (Ch. 3 §3.9 notes the swap is ~1 cycle but on the critical read path of every tuple), accepting non-portability because the same server reads what it wrote. This is the on-disk instance of Chapter 3 §3.12's rule — *portable formats fix endianness explicitly; local formats may use native order* — and Postgres deliberately chose "local."

**Alignment cost.** Aligning fields to their natural boundaries (§63.6) makes reads a single aligned load instead of a byte-assembly loop, but it **wastes space to padding** — up to 7 bytes between a `bool` and an `int8`. On disk that padding is not free: it is bytes written, cached in the buffer pool, and moved on every I/O. The tension: alignment buys CPU on read, padding costs space and I/O. Postgres pays it (aligned tuples, MAXALIGN'd headers); column stores largely **avoid** it, because a column is a dense same-type array that is already naturally aligned and packs with no inter-field gaps — one more reason columnar layout is denser (Ch. 61 §61.6).

**Fanout and space.** Everything about the page format feeds back into **fanout** — how many children a B-tree internal page points to, which sets the tree's height and thus the number of page reads per lookup (Ch. 62, Ch. 64). Anything that shrinks a cell raises fanout: **prefix-truncated separator keys** (§63.13), the **short varlena header** (§63.4), tight null bitmaps (§63.5), and good column ordering (§63.6) all pack more cells per page. Bigger pages raise fanout too (§63.8) but read more per point lookup and widen the torn-write window (§63.19). The designer's balance in one sentence: **a page format is a negotiation between packing density (fanout, less I/O, less space) and access cost (alignment, no byte-swaps, atomic-write safety)** — and where a system lands on it (Postgres native+aligned+FPW, SQLite portable+big-endian, Parquet columnar+immutable) is fully explained by whether it optimizes for local OLTP, portable embedding, or analytic scans.

---

## Summary

- An on-disk format is a serialization discipline forced by four constraints RAM does not impose: **no pointers** (address by page-id + offset), **the block is the I/O unit** (fixed-size pages), **self-description and durability** (versions, magic, checksums), and **deliberately chosen portability**.
- **Primitives** are fixed-width binary: integers with a chosen endianness (Postgres native/little, SQLite big), two's-complement signed, IEEE-754 floats. **Variable-length data is length-prefixed**; Postgres varlenas use a 4-byte header, a 3-byte-saving **short 1-byte header** for ≤126-byte values, and an 18-byte TOAST pointer, capping a field at ~1 GB.
- **Bit-packing** compresses flags (infomask words) and nulls; a **null bitmap** of `⌈natts/8⌉` bytes appears only when a row has nulls, and a null column then costs zero data bytes.
- **Alignment** (Postgres `attalign`, `MAXALIGN` = 8) makes reads single loads but wastes padding; **column order matters** — largest-alignment-first can shrink a row ~33%, exactly as in a C struct (Ch. 3 §3.4).
- A **page** (Postgres 8 KB, InnoDB 16 KB, SQLite 4 KB) is the fixed-size unit of I/O, caching, and locking; its **24-byte header** holds `pd_lower`/`pd_upper` (free-space pointers), `pd_lsn`, `pd_checksum`, and a packed size+version word.
- The **slotted page** is the central structure: fixed-size **slots** (line pointers) grow from the front, variable **cells** (tuples) from the back, free space between. It supports variable-size records with only internal fragmentation, and — because references use a **relocatable slot number, not a byte offset** — enables **compaction** that rewrites slot offsets while every external index reference stays valid.
- Postgres tuples carry a **23-byte header** (`t_xmin`/`t_xmax` MVCC, `t_ctid`, infomasks, `t_hoff`), padded to `t_hoff` ≥ 24, plus the null bitmap and aligned column data; **line pointers** (`ItemIdData`, 4 bytes, states `LP_NORMAL/DEAD/REDIRECT/UNUSED`) drive deletion and HOT.
- **TOAST** stores values over ~2 KB by compressing (pglz/LZ4) and moving out-of-line into a chunked TOAST table, leaving an 18-byte pointer — raising the effective field limit to ~1 GB behind an 8 KB page.
- **Magic numbers** reject foreign files; **version numbers** (Postgres layout version 4 in `pd_pagesize_version`) gate parsing and force `pg_upgrade` on format changes.
- **Checksums** (Postgres 16-bit FNV-1a page checksum, on by default in PG18; distinct from WAL CRC-32C) **detect** bit rot, misdirected writes, and **torn pages** but repair nothing. A torn page — an 8 KB page partially written because the device is atomic only per sector — is *recovered* by **full-page writes** (a full image in the WAL after each checkpoint), the analogue of InnoDB's **doublewrite buffer**; both are unnecessary on atomic-write storage (ZFS, atomic NVMe).

---

## Key Interview Questions

1. **Why can't a database just write its in-memory structures to disk?** — In-memory structures hold pointers (virtual addresses) that are meaningless after restart or in another process, and the block device transfers data in sectors/pages, not bytes. On-disk formats therefore use position-independent page-id + offset addressing, fixed-size pages, explicit lengths, versions, and checksums.
2. **What is page-id + offset addressing and why is it used?** — Data is referenced by (page id, in-page offset) instead of a raw address, so references survive being written and re-read at a different mapping. Page id → file offset is `page × page_size` (a shift, no lookup), and in slotted pages the "offset" is really a relocatable slot number.
3. **How is variable-length data stored, and what is a Postgres varlena?** — Length-prefixed: the length precedes the bytes so access is O(1), values can contain any byte, and validation is easy. A varlena uses a 4-byte header (30-bit length, ~1 GB max), a short 1-byte header for values ≤126 bytes (saves 3 bytes each), or an 18-byte TOAST pointer for out-of-line values.
4. **What is a null bitmap and when is it present?** — A bitmap with one bit per column indicating present/null, stored right after the tuple header, sized `⌈natts/8⌉` bytes. It exists only when a row actually has a null (`HEAP_HASNULL`); a null column then occupies zero bytes in the data area, but shifts the offsets of later columns.
5. **Why does column declaration order affect on-disk row size in Postgres?** — Each column is aligned to its type's boundary (`attalign`), so a small column before a large one inserts padding, exactly like a C struct (Ch. 3 §3.4). Ordering columns largest-alignment-first minimizes inter-column padding and can shrink a row by ~33%; the engine does not reorder for you.
6. **What is a slotted page and what three problems does it solve at once?** — A page with fixed-size slots growing from the front and variable-size cells growing from the back, free space between. It stores variable-length records with only internal fragmentation, supports deletion by marking slots, and keeps stable references because records are addressed by relocatable slot number rather than byte offset.
7. **Why does a slotted page address records by slot number instead of byte offset?** — So the page can be compacted: sliding live cells together to reclaim holes only requires rewriting each slot's internal offset, while every external index entry (which holds the slot number) stays valid. A byte-offset scheme would force rewriting every reference on every move.
8. **Describe the PostgreSQL page header fields that matter.** — 24 bytes: `pd_lsn` (WAL position of last change, gates flushing), `pd_checksum` (16-bit), `pd_flags`, `pd_lower`/`pd_upper` (free-space boundaries), `pd_special` (special-space start), `pd_pagesize_version` (size OR'd with layout version), `pd_prune_xid`. Free bytes = `pd_upper − pd_lower`.
9. **What is in a Postgres line pointer (ItemIdData)?** — A 4-byte word: `lp_off` (15-bit offset in the page), `lp_flags` (2 bits: UNUSED/NORMAL/REDIRECT/DEAD), `lp_len` (15-bit length). It is the slot; indexes point at (block, line-pointer index), and the line pointer's states drive deletion and HOT redirection.
10. **What is in the Postgres heap tuple header?** — 23 bytes: `t_xmin`/`t_xmax` (inserting/deleting XIDs for MVCC), `t_cid`/`t_xvac`, `t_ctid` (6-byte TID of this or the next version), `t_infomask2` (column count + HOT flags), `t_infomask` (null/varwidth/hint bits), `t_hoff` (offset to data, MAXALIGN'd to ≥24). Then the optional null bitmap and aligned column data.
11. **What is the minimum per-row overhead in a Postgres heap?** — About 28 bytes: a 4-byte line pointer plus a 23-byte header padded to `t_hoff = 24`. This dominates the cost of very narrow rows and caps tuples per 8 KB page near 291.
12. **Difference between a key cell and a key-value cell?** — A key cell holds a separator key and a child page id and lives in B-tree internal nodes (routing only). A key-value cell holds a key and its value (row or TID) and lives in leaves. The same slotted-page container holds both, which is why internal and leaf pages share a format.
13. **How does deletion work in a slotted page, and what is fragmentation?** — Deletion marks the slot (Postgres stamps `t_xmax`, then VACUUM sets `LP_DEAD`/`LP_UNUSED`); the cell bytes remain as a hole. Free space then splits into contiguous free (between the pointers) and fragmented free (scattered holes), the latter usable only after compaction. The fragmentation is always internal and always reclaimable.
14. **What is compaction and why is it cheap?** — Sliding live cells together to coalesce holes into one contiguous free region, rewriting each live slot's offset. It is cheap and safe because it is page-local and no external reference changes — indexes still name cells by slot number. Postgres does it via HOT pruning and VACUUM.
15. **What is TOAST and when does it trigger?** — The Oversized-Attribute Storage Technique: when a tuple exceeds ~2 KB (`TOAST_TUPLE_THRESHOLD`), Postgres compresses toastable columns (pglz/LZ4) and, if still too big, moves them out-of-line into a chunked TOAST table (`pg_toast.pg_toast_<oid>`, ~1996-byte chunks), leaving an 18-byte pointer in the row. It raises the effective field limit to ~1 GB.
16. **What are the TOAST storage strategies?** — PLAIN (no compress, no out-of-line; fixed-width types), EXTENDED (compress then out-of-line; the default), EXTERNAL (out-of-line, no compression; fast substring), MAIN (compress inline, out-of-line only as a last resort).
17. **What is a magic number and which formats use one?** — A fixed signature identifying the format so wrong/corrupt files fail loudly. SQLite: `"SQLite format 3\000"`; Parquet: `"PAR1"` at both ends; ELF/PNG/class files have their own. Postgres omits per-page magics in the heap but versions its WAL pages and `pg_control`.
18. **How does Postgres version its page format and why does it matter?** — The layout version is packed into the low 8 bits of `pd_pagesize_version` (page size is a multiple of 256); the current version is 4. A version mismatch means an incompatible layout, which is why format-changing major upgrades need `pg_upgrade` or dump/restore.
19. **What do Postgres data checksums protect against, and what don't they?** — They detect on-disk corruption: bit rot, misdirected writes (the block number is mixed in), and torn pages. They do not detect in-memory corruption, cannot repair anything, and miss ~1/65536 of corruptions (16-bit). They are separate from the WAL's CRC-32C.
20. **Is a checksum a CRC in Postgres?** — No. Postgres uses a 16-bit FNV-1a-based checksum computed over 32-bit words across 32 parallel accumulator lanes (SIMD-friendly), folded and mixed with the block number. The WAL uses CRC-32C (Castagnoli) per record — a different algorithm for a different structure.
21. **What is a torn page and why does it happen?** — A page partially written on a crash because the device guarantees atomicity only per sector (512 B/4 KB) while a Postgres page is 8 KB, so some sectors are new and some old. The result is a self-inconsistent page that a checksum will flag but cannot fix.
22. **How does Postgres recover from torn pages?** — Full-page writes: after each checkpoint, the first modification of a page logs the entire page image (an FPI) into the WAL before deltas. On recovery, replaying an FPI overwrites the whole page with a known-good image, then later deltas apply cleanly. `wal_compression` reduces the WAL cost.
23. **How does InnoDB solve the torn-page problem differently?** — The doublewrite buffer: each page is written twice — first sequentially to a doublewrite area and fsynced, then to its final location. On recovery a torn final page is restored from its intact doublewrite copy. Same guarantee as full-page writes, via a dedicated region rather than the WAL.
24. **When can you disable full-page writes safely?** — On storage that writes an 8 KB page atomically: a copy-on-write filesystem like ZFS, or NVMe with atomic-write support. Then torn pages cannot occur and `full_page_writes = off` removes the WAL overhead.
25. **Why is a Postgres data directory not portable across architectures, but a SQLite file is?** — Postgres writes host-native byte order and its varlena header bit-tests depend on endianness, so files cannot move between big- and little-endian (or different alignment) machines. SQLite fixes all multi-byte integers big-endian and uses a host-independent record format, making its file byte-for-byte portable.
26. **How does the page format influence B-tree fanout?** — Anything that shrinks a cell packs more cells per page and raises fanout, lowering tree height and reads per lookup: prefix-truncated separator keys, short varlena headers, tight null bitmaps, good column ordering. Bigger pages raise fanout too but read more per point lookup and widen the torn-write window.
27. **Why do databases use fixed-size pages instead of variable-size ones?** — Fixed size gives O(1) addressing (page N at `N × size`), simple page-level free-space management with no external fragmentation, and clean alignment with OS pages and device sectors. Variable-size pages would need an offset index just to locate a page.
28. **How is a value larger than 8 KB but the tuple limit is ~2 KB reconciled?** — A tuple must fit ~4 per page (~2 KB), but TOAST moves large columns out-of-line into a chunked side table and leaves an 18-byte pointer, so the visible row stays small while the value can be up to ~1 GB, fetched only when the column is referenced.

---

## Common Traps

- **Thinking a checksum prevents or repairs torn pages.** It only *detects* corruption; recovering a torn page needs full-page writes (Postgres) or the doublewrite buffer (InnoDB) — the checksum just tells you the page is bad.
- **Assuming an 8 KB page is written atomically.** Hardware guarantees atomicity only per sector (512 B/4 KB); an 8 KB page spans multiple sectors and can tear on a crash — the entire reason full-page writes exist.
- **Confusing the page-level data checksum with the WAL CRC.** They are different algorithms (16-bit FNV-1a vs CRC-32C), protect different structures (data pages vs log records), and cover different failure domains.
- **Believing an index stores a byte offset into the page.** It stores a slot/line-pointer number; the slot holds the offset, and that indirection is exactly what lets compaction relocate tuples without touching any index.
- **Ignoring column order in a Postgres table.** Misordered columns pay alignment padding (like a C struct); largest-alignment-first can cut on-disk row size ~33%, and the engine never reorders for you.
- **Assuming a null column still occupies its column's width.** With a null bitmap, a null column consumes zero data bytes — but it shifts the offsets of all later columns, so column position affects read cost.
- **Treating a Postgres data directory as portable.** Native byte order and endianness-dependent varlena headers make files non-portable across architectures; even `pg_upgrade` requires matching architecture and alignment.
- **Forgetting variable-length data needs an explicit length.** Fixed-width fields have constant offsets; the first variable field makes every following field's offset non-constant, forcing a left-to-right walk (or an in-record offset table).
- **Overlooking TOAST when reasoning about row size.** Values over ~2 KB are compressed and moved out-of-line with only an 18-byte pointer left inline, so on-disk row width and query cost depend on which columns are TOASTed and referenced.
- **Assuming compaction must update indexes.** It updates only the slots' internal offsets; because references are slot numbers, no external index or sibling link changes — that is the whole point of the slot layer.
- **Conflating page size with atomicity or with fanout in one direction only.** Bigger pages raise B-tree fanout (fewer levels) but increase bytes read per point lookup and enlarge the torn-write window — it is a genuine trade, not a free win.
- **Storing structs or floats byte-for-byte across the format boundary.** Padding leaks, endianness, and float representations (±0.0, NaN) break byte comparison and portability — the on-disk instance of Chapter 3's serialization rules.
