# Chapter 63 — File Formats

## 63.0 Why This Changes the Decision — Core

A durable format is a protocol between versions of a program, not a snapshot of
one process's memory. Its reader may run years later, on another architecture,
after a crash interrupted a write. That reader needs explicit byte order,
lengths, identities, versions, integrity checks, and a recovery rule.

This chapter builds one such protocol:

```
durability contract
  → file/page identity
  → explicit primitive encoding
  → slotted variable-length records
  → checksum and structural validation
  → crash-safe publication
  → version migration and corruption diagnosis
```

Chapter 3 owns C++ object representation, padding, alignment, and lifetime.
This chapter never treats a native C++ object layout as portable storage.
Chapters 64 and 65 add B-tree mutation and transactional WAL/recovery.

### Claim labels

- **[C++23]** follows the C++ language/library standard.
- **[Format v1]** is a choice made by the sample format in this chapter.
- **[OS/API]** depends on the named operating-system API and its documented
  errors and semantics.
- **[Filesystem]** depends on filesystem, mount/configuration, and failure mode.
- **[Storage]** depends on device/controller atomicity, caches, flush support,
  firmware, and power-loss behavior.
- **[PostgreSQL 18]** describes the documented PostgreSQL 18 built-in storage
  formats; build options and other versions may differ.
- **[Product/version]** means a behavior must be verified for the deployed
  implementation and version.
- **[Measured]** means page size, compression, amplification, or performance
  requires a named workload and storage stack.

---

## 63.1 90-Second Screen — Core

Six facts:

1. Encode fields one by one into bytes of a specified width and byte order.
   Never dump a C++ `struct`: padding, alignment, ABI, endianness, and pointer
   values are not a stable file contract.
2. A page ID plus an in-page slot survives process restarts and page
   compaction. A native pointer or raw record offset usually does not.
3. A slotted page grows a slot array from the front and record bodies from the
   back. Moving a body updates one slot while its `(page_id, slot_id)` remains
   stable.
4. A checksum detects covered accidental corruption with some probability; it
   neither makes a multi-sector write atomic nor repairs the page. Define the
   algorithm, checksum-field treatment, and exact covered bytes.
5. A successful `write` does not generally mean durable media. Crash safety
   needs an ordering protocol—such as write-ahead logging or copy-on-write
   publication—and correctly placed persistence barriers for the deployed
   OS/filesystem/device.
6. Versions are executable compatibility policy. Validate magic, version,
   sizes, counts, offsets, overlap, flags, references, and checksum before using
   payload bytes; migrate by a resumable, testable plan.

The design question is not “what bytes should I write?” It is:

> After a crash at every boundary, which complete old or new state can the
> reader select, and how does it reject every incomplete state?

---

## 63.2 Start with the Durability Contract — Core

“Saved” is ambiguous. Define the failure model before the layout:

- Is the guarantee only against process termination, or also OS panic and
  sudden power loss?
- May a write be short, reordered, duplicated, or torn into old/new sectors?
- Does the device honestly complete cache-flush commands?
- Is loss of the storage device itself in scope, or handled by replication and
  backups?
- Must one record update be atomic, a whole page, or a transaction spanning
  files?
- Can recovery use a log, a second copy, or remote replica?
- How much recent committed work may be lost?
- May an old binary open a newer file, and may a new binary modify an older
  file in place?

No byte layout can compensate for an unstated contract.

### The persistence stack

A typical buffered write crosses several layers:

```
application buffer
  → kernel page cache
  → filesystem/journal
  → block layer/controller cache
  → device volatile cache
  → nonvolatile medium
```

**[OS/API]** A successful C++ stream write or POSIX `write` normally reports
that bytes were accepted by the OS; it is not a universal power-loss
durability barrier. `flush()` on an iostream pushes its user-space buffer toward
the OS, but is not a standard C++ primitive for forcing a filesystem object to
stable storage. Platform APIs such as POSIX `fsync`/`fdatasync` or Windows
flush operations must be used according to their platform documentation.

**[Filesystem]/[Storage]** Even a correct API call relies on the filesystem,
driver, controller, and device honoring ordering and flush promises. Network
filesystems and virtual disks add another boundary. Test the real stack and
retain replication/backups for failures outside the local protocol.

### Atomicity, durability, and integrity are different

| Property | Question | Typical mechanism |
|---|---|---|
| visibility atomicity | Can a reader see half an update? | lock, rename, generation selection, WAL recovery |
| crash atomicity | After restart, is old or new state selected, never a mixture? | COW + atomic publication, WAL, doublewrite |
| durability | Once acknowledged, does state survive the promised failures? | sync/flush ordering, durable replicas |
| integrity | Can changed/misdirected bytes be detected? | checksum/MAC, page identity, structural validation |
| authenticity | Did an authorized writer produce it? | keyed MAC/signature and key management |

A checksum supplies integrity evidence, not atomicity or authenticity. An
atomic namespace operation does not imply file contents reached stable storage.
A durable byte sequence can still be semantically invalid.

### Failure windows for replace-by-rename

A common single-file replacement protocol is:

1. create a temporary file in the destination directory;
2. write the complete new bytes and check every return value;
3. sync the temporary file;
4. rename it over the destination on the same filesystem;
5. sync the containing directory where the platform requires this to persist
   the directory entry.

This is **[POSIX/filesystem]**, not portable C++ and not a universal recipe for
every filesystem. Preserve ownership, permissions, extended metadata, and
security rules deliberately; avoid following attacker-controlled paths.

| Crash point | Expected recoverable evidence under the stated protocol |
|---|---|
| before temporary file is durable | old destination; incomplete temporary file may exist |
| after temporary sync, before rename | old destination plus complete orphan temporary |
| after rename, before directory sync | new name is live now; post-crash namespace persistence may be uncertain |
| after directory sync | new name/content are intended durable state |

The table is the specification. Fault-injection tests should terminate the
writer at every row and verify only permitted outcomes.

Directly overwriting a page has a harder window. A power loss may leave some
sectors from the old page and some from the new. A later checksum can reject
the mixture, but recovery still needs an old copy, WAL/full-page image,
doublewrite area, replica, or backup.

---

## 63.3 Files, Pages, Records, and Stable IDs — Core

The format hierarchy is:

```
database/collection
  └─ file
      ├─ superblock A
      ├─ superblock B
      └─ fixed-size pages
          ├─ page header
          ├─ slots
          ├─ free space
          └─ record bodies
              └─ explicitly encoded fields
```

Fixed-size pages give constant-time location:

```
file_offset(page_id) = data_start + page_id × page_size
```

Check multiplication and addition for overflow before seeking. Do not accept a
page ID whose computed range lies outside the actual file. A file may be split
into segments, in which case the logical page ID maps to `(segment, offset)`
using declared segment and page sizes.

### Logical IDs, physical offsets, and slots

A durable reference should name logical identity:

```
RecordId { file_id, page_id, slot_id, optional_generation }
```

The slot contains the current `(offset, length, state)` of the body. Compaction
may move the body and change its offset while the record ID stays stable. A
generation prevents an old ID from silently referring to a new record after a
slot is reused. Whether slot IDs may be reused is a format-level contract.

Raw byte offsets are sometimes appropriate inside one immutable object, but
they become expensive external identities: insertion, compaction, or rewrite
then requires updating every reference.

### Dual superblocks

**[Format v1]** reserves two independently checksummed superblock pages. Each
contains:

| Field | Purpose |
|---|---|
| file magic/type | reject an unrelated file |
| major/minor version | select a compatible decoder |
| header length | permit recognized extension |
| page size | cross-check addressing |
| file UUID | detect copied/mixed pages and manifests |
| generation | order valid committed roots |
| root page ID | reach the current logical structure |
| feature bits | distinguish required and optional features |
| checksum algorithm/coverage ID | avoid guessing integrity rules |
| checksum | validate the superblock copy |

Open validates both copies independently and selects the highest generation
whose entire referenced state satisfies the publication protocol. “Largest
number wins” alone is unsafe if that root could reference pages not yet durable.

For a copy-on-write update:

1. write newly allocated pages without modifying pages reachable from the
   current root;
2. validate them in memory and issue the required file persistence barrier;
3. write the older superblock slot with `generation + 1` and the new root;
4. issue a second barrier;
5. only later reclaim pages unreachable from both protected generations.

The first barrier makes dependencies durable before publication; the second
makes publication durable. A torn new superblock leaves the older valid copy.
This is not automatically transactionally atomic across several files.

### Page-size choice

Page size trades fanout and amortized I/O against write amplification, cache
waste, and torn-write exposure. It must also leave enough offset bits and match
the buffer manager. “Use the filesystem block size” is not a universal rule:
the device, filesystem, VM, and database may have distinct granularities.
Choose from measured workload behavior, then make it part of the file header.

---

## 63.4 Explicit Encoding, Not Native Layout — Core

### Primitive rules

**[Format v1]** uses:

- eight-bit bytes;
- unsigned integers of 16, 32, and 64 bits in little-endian order;
- no native pointers, `size_t`, `long`, enum representation, or `bool`;
- lengths as unsigned byte counts with declared maximums;
- UTF-8 text where text is intended, with a stated normalization policy;
- arbitrary byte strings otherwise;
- flags in fixed-width unsigned words, with unknown-bit rules;
- no implicit padding; reserved bytes are written as zero and validated as
  required by the version.

Portable formats may choose big-endian instead. The important property is one
canonical encoding, not matching the writer host.

**[C++23]** `std::uint32_t` exists only on implementations that provide an
exactly 32-bit unsigned type. `std::endian`, `std::byteswap`, `std::span`, and
`std::byte` help implement a codec; none declares the file format for you.

Do not do this:

```cpp
struct NativeHeader {
    std::uint32_t count;
    std::uint64_t root;
};

// Wrong as a durable protocol:
// out.write(reinterpret_cast<const char*>(&h), sizeof h);
```

The implementation may insert padding between `count` and `root`; padding
bytes can be indeterminate, object sizes and alignment are ABI choices, and
host byte order may differ. Packing pragmas trade one implementation-specific
layout for another and can introduce unaligned access; they do not create a
portable format.

### Lengths, tags, and bit fields

Every variable field needs an unambiguous boundary:

```
[tag:u16][length:u32][payload:length bytes]
```

Length-prefixing permits embedded zero bytes and skipping unknown optional
fields. The reader must check `length <= remaining` before forming a subspan
and impose semantic caps before allocating. Avoid `offset + length <= size`
when the addition can overflow; use `offset <= size && length <= size-offset`.

Bit-packed flags save space but require reserved-bit policy:

- `required_features`: reject any unknown set bit;
- `optional_features`: a reader may ignore a bit only if the enclosing
  length-delimited object remains safely skippable;
- enum/tag: reject unknown values unless the specification defines an
  `unknown` behavior.

Do not use a C++ bit-field layout on disk. Allocate bit numbers explicitly.

Nulls can use one bit per field. State whether `1` means null or present, the
bit order within a byte, and whether absent trailing bits must be zero. A null
field should have no payload unless the format explicitly permits a placeholder.

### Numbers, text, and canonical form

For signed integers, specify the mapping—not “whatever the compiler uses.”
For floating point, specify whether IEEE 754 encodings are accepted and how
NaNs, infinities, and signed zero are handled. If byte order must preserve
numeric sort order, ordinary little-endian encodings are unsuitable without a
separate sortable-key transformation.

Text needs more than “string”: encoding, validity, normalization, case
comparison, maximum byte length, and whether embedded NUL is legal. A checksum
can prove bytes remained the same while two canonically equivalent Unicode
spellings still compare differently.

Canonical encoding—one byte representation per logical value—simplifies
hashing, deduplication, signatures, deterministic tests, and replication.
Require sorted map keys, zero reserved bytes, minimal integer encodings, and a
chosen NaN representation when those properties matter.

---

## 63.5 A Slotted Page and Its Invariants — Core

**[Format v1]** uses 4096-byte data pages. A 40-byte header is followed by
eight-byte slots; record bytes grow backward from the page end:

```
offset 0
┌──────────────────────────────────────────────────────────┐
│ header: magic/version/id/generation/count/lower/upper/CRC │
├──────────────────────────────────────────────────────────┤
│ slot 0 │ slot 1 │ ...       slots grow →                │
├──────────────── lower ───────────────────────────────────┤
│                       free space                         │
├──────────────── upper ───────────────────────────────────┤
│            ← record bodies grow from page end            │
└──────────────────────────────────────────────────────────┘
offset 4096
```

Header fields:

| Offset | Width | Field | Rule |
|---:|---:|---|---|
| 0 | 4 | magic | ASCII `CPPG` |
| 4 | 2 | major | `1` for this decoder |
| 6 | 2 | minor | compatible additive revision |
| 8 | 4 | page size | `4096` |
| 12 | 8 | page ID | must match requested location |
| 20 | 8 | generation | used by owning tree/root policy |
| 28 | 2 | slot count | bounded by header/page size |
| 30 | 2 | flags | unknown required bits rejected |
| 32 | 2 | lower | exactly `40 + count × 8` in v1 |
| 34 | 2 | upper | start of body region |
| 36 | 4 | CRC-32C | full page with this field zero |

Each slot contains a 32-bit body offset and 32-bit byte length. A zero length is
a tombstone in this teaching format; consequently empty live records are not
representable. A production format could add explicit slot-state bits.

### Structural invariants

Validate in a safe order:

1. supplied buffer is exactly the supported page size;
2. magic and version are recognized;
3. declared page size and requested page ID match;
4. checksum matches under the specified zeroed-field rule;
5. slot-count multiplication fits and `lower` equals the expected directory
   end;
6. `header_size <= lower <= upper <= page_size`;
7. every live slot satisfies `upper <= offset`, `length <= page_size-offset`;
8. live record ranges do not overlap;
9. reserved flags/bytes and record-level encodings are valid;
10. cross-page references point to permitted page types/generations.

Never follow an offset, allocate from a length, or loop to an untrusted count
before its local bound is established. Checksum first versus structure first is
a policy trade: enough fixed header must be read safely to locate/identify the
checksum, but all reads themselves must be bounds-safe.

### Insert, delete, compact

An insert needs one slot plus the body length. It succeeds when:

```
body_length + slot_size <= upper - lower
```

The writer subtracts the body length from `upper`, copies the body, writes the
slot, increments the count, advances `lower`, then computes the checksum over
the final page image. These are in-memory construction steps; publication
atomicity comes from COW/WAL, not from their order inside a buffer.

Deletion marks a slot dead. The hole in the body region is fragmented space,
not immediately part of the contiguous `[lower, upper)` gap. Compaction copies
live bodies toward the end and rewrites their slot offsets. External record IDs
remain stable because they name slots.

Maintain two values:

- contiguous free space, which accepts an insert without compaction;
- reclaimable space, which includes holes/dead bodies.

A free-space map is a hint. If stale, the target page rechecks its actual
header while latched and chooses another page or compacts; correctness must not
depend on the hint being exact.

### Cell design

A leaf record might be:

```
[record_version:u8]
[flags:u8]
[key_length:u16]
[value_length:u32]
[key bytes]
[value bytes]
```

An internal B-tree cell replaces the value with a child page ID. A row cell may
have a fixed prefix, null bitmap, offset table, then variable fields. An offset
table gives O(1) field location at a space cost; walking length-prefixed fields
is smaller but makes later-field access proportional to preceding fields.

Alignment inside the portable sample format is unnecessary because the decoder
copies/assembles bytes rather than dereferencing a typed pointer. A
product-specific native format may deliberately align fields for its supported
ABI. Advice such as “order columns widest first” is conditional: it can reduce
padding in some layouts, but nulls, variable headers, compression, schema
semantics, and engine rules can dominate. Measure and keep C++ layout details
in Chapter 3.

### Oversized values, compression, and encryption

A record larger than a page needs an explicit policy: reject it, split it into
overflow pages, or store it in a separate object and leave a typed reference.
An overflow reference should include identity, logical length, chunk/count
limits, and enough integrity information to detect missing, duplicated,
reordered, or cross-file chunks. Recovery and garbage collection must treat the
owning record and overflow chain consistently.

Compression changes validation order. Bound the declared uncompressed size and
compression ratio before allocating; checksum either the exact stored
compressed bytes or clearly define a logical-content checksum. Per-page
compression permits random access but may waste tail space; larger compression
units improve ratio while increasing read amplification and recovery scope.
Those are **[Measured]** trade-offs.

Encryption needs authenticated encryption or a separate MAC when tampering is
in scope. Define nonce/IV generation and uniqueness, associated data (such as
file UUID, page ID, generation, and version), key identity/rotation, and whether
headers remain plaintext. A plain CRC over ciphertext can detect accidental
damage but does not authenticate it. Typical read order is envelope bounds,
identity/version needed to select the key, authentication/decryption,
decompression with limits, then semantic validation. Never reuse a nonce under
a key merely because a page ID was recycled.

---

## 63.6 A Compact C++23 Encoder/Decoder — Core

This complete sample explicitly encodes two string records, validates bounds
and overlap, and uses the CRC-32C Castagnoli polynomial. It is intentionally a
page codec, not a crash-safe file writer.

```cpp
#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

constexpr std::size_t page_size = 4096;
constexpr std::size_t header_size = 40;
constexpr std::size_t slot_size = 8;
constexpr std::size_t checksum_offset = 36;

template<class T>
    requires std::is_unsigned_v<T>
void put_le(std::span<std::byte> out, std::size_t pos, T value) {
    assert(pos <= out.size() && sizeof(T) <= out.size() - pos);
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        out[pos + i] = std::byte((value >> (8 * i)) & T{0xff});
    }
}

template<class T>
    requires std::is_unsigned_v<T>
std::optional<T> get_le(std::span<const std::byte> in, std::size_t pos) {
    if (pos > in.size() || sizeof(T) > in.size() - pos) return std::nullopt;
    T value{};
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        value |= T(std::to_integer<unsigned char>(in[pos + i])) << (8 * i);
    }
    return value;
}

std::uint32_t crc32c(std::span<const std::byte> bytes) {
    std::uint32_t crc = 0xffff'ffffu;
    for (std::byte b : bytes) {
        crc ^= std::to_integer<std::uint8_t>(b);
        for (int bit = 0; bit != 8; ++bit) {
            const std::uint32_t mask = 0u - (crc & 1u);
            crc = (crc >> 1) ^ (0x82f6'3b78u & mask);
        }
    }
    return ~crc;
}

using Page = std::array<std::byte, page_size>;

std::optional<Page> encode_page(
    std::uint64_t page_id,
    std::uint64_t generation,
    std::span<const std::string_view> records) {
    if (records.size() > (page_size - header_size) / slot_size) {
        return std::nullopt;
    }

    Page page{};
    const std::size_t lower = header_size + records.size() * slot_size;
    std::size_t upper = page_size;

    for (std::size_t i = 0; i < records.size(); ++i) {
        const auto record = records[i];
        if (record.empty()) return std::nullopt; // zero length is a tombstone
        if (record.size() > upper - lower) return std::nullopt;
        upper -= record.size();
        std::memcpy(page.data() + upper, record.data(), record.size());
        put_le<std::uint32_t>(page, header_size + i * slot_size,
                              static_cast<std::uint32_t>(upper));
        put_le<std::uint32_t>(page, header_size + i * slot_size + 4,
                              static_cast<std::uint32_t>(record.size()));
    }

    page[0] = std::byte{'C'}; page[1] = std::byte{'P'};
    page[2] = std::byte{'P'}; page[3] = std::byte{'G'};
    put_le<std::uint16_t>(page, 4, 1);
    put_le<std::uint16_t>(page, 6, 0);
    put_le<std::uint32_t>(page, 8, page_size);
    put_le<std::uint64_t>(page, 12, page_id);
    put_le<std::uint64_t>(page, 20, generation);
    put_le<std::uint16_t>(page, 28,
                          static_cast<std::uint16_t>(records.size()));
    put_le<std::uint16_t>(page, 30, 0);
    put_le<std::uint16_t>(page, 32, static_cast<std::uint16_t>(lower));
    put_le<std::uint16_t>(page, 34, static_cast<std::uint16_t>(upper));
    put_le<std::uint32_t>(page, checksum_offset, 0);
    put_le<std::uint32_t>(page, checksum_offset, crc32c(page));
    return page;
}

struct Decoded {
    std::uint64_t page_id;
    std::uint64_t generation;
    std::vector<std::string> records;
};

std::optional<Decoded> decode_page(std::span<const std::byte> input,
                                   std::uint64_t expected_page_id) {
    if (input.size() != page_size) return std::nullopt;
    if (input[0] != std::byte{'C'} || input[1] != std::byte{'P'} ||
        input[2] != std::byte{'P'} || input[3] != std::byte{'G'}) {
        return std::nullopt;
    }

    const auto major = get_le<std::uint16_t>(input, 4);
    const auto minor = get_le<std::uint16_t>(input, 6);
    const auto declared_size = get_le<std::uint32_t>(input, 8);
    const auto page_id = get_le<std::uint64_t>(input, 12);
    const auto generation = get_le<std::uint64_t>(input, 20);
    const auto count = get_le<std::uint16_t>(input, 28);
    const auto flags = get_le<std::uint16_t>(input, 30);
    const auto lower = get_le<std::uint16_t>(input, 32);
    const auto upper = get_le<std::uint16_t>(input, 34);
    const auto stored_crc = get_le<std::uint32_t>(input, checksum_offset);
    if (!major || !minor || !declared_size || !page_id || !generation ||
        !count || !flags || !lower || !upper || !stored_crc) {
        return std::nullopt;
    }
    if (*major != 1 || *minor != 0 || *declared_size != page_size ||
        *page_id != expected_page_id || *flags != 0) {
        return std::nullopt;
    }

    Page copy{};
    std::ranges::copy(input, copy.begin());
    put_le<std::uint32_t>(copy, checksum_offset, 0);
    if (crc32c(copy) != *stored_crc) return std::nullopt;

    if (*count > (page_size - header_size) / slot_size) return std::nullopt;
    const std::size_t expected_lower = header_size + *count * slot_size;
    if (*lower != expected_lower || *upper < *lower || *upper > page_size) {
        return std::nullopt;
    }

    std::vector<std::pair<std::size_t, std::size_t>> ranges;
    Decoded result{*page_id, *generation, {}};
    result.records.reserve(*count);
    for (std::size_t i = 0; i < *count; ++i) {
        const auto off = get_le<std::uint32_t>(
            input, header_size + i * slot_size);
        const auto len = get_le<std::uint32_t>(
            input, header_size + i * slot_size + 4);
        if (!off || !len || *len == 0 || *off < *upper ||
            *off > page_size || *len > page_size - *off) {
            return std::nullopt;
        }
        ranges.emplace_back(*off, *off + *len);
        result.records.emplace_back(
            reinterpret_cast<const char*>(input.data() + *off), *len);
    }
    std::ranges::sort(ranges);
    for (std::size_t i = 1; i < ranges.size(); ++i) {
        if (ranges[i - 1].second > ranges[i].first) return std::nullopt;
    }
    return result;
}

int main() {
    const std::span<const char> check{"123456789", 9};
    assert(crc32c(std::as_bytes(check)) == 0xe306'9283u);

    const std::array<std::string_view, 2> records{"alpha", "beta"};
    auto page = encode_page(7, 42, records);
    assert(page);
    auto decoded = decode_page(*page, 7);
    assert(decoded && decoded->generation == 42);
    assert((decoded->records == std::vector<std::string>{"alpha", "beta"}));

    (*page)[100] ^= std::byte{1};
    assert(!decode_page(*page, 7)); // corruption is detected
}
```

Compile the sample:

```bash
clang++ -std=c++23 -O2 -Wall -Wextra -Wpedantic page_codec.cpp
./a.out
```

`assert` is suitable here only as a test harness; a production decoder returns
typed errors and must behave safely when `NDEBUG` is defined. The encoder's
internal `put_le` assertions protect programmer-established offsets, not
untrusted input. The decoder performs ordinary memory copies/string
construction only after bounds validation.

CRC-32C detects common accidental changes well but has collisions and is not
keyed. For malicious input, keep all structural checks and use a cryptographic
hash or MAC when the threat model requires authenticity. Algorithm IDs and
coverage rules remain part of the file version.

---

## 63.7 Checksums, Torn Writes, and Recovery — Core

### Define checksum coverage exactly

“The page is checksummed” is incomplete. Specify:

- algorithm and parameters;
- bytes covered, including or excluding unused free space;
- checksum field replaced with zero or omitted during calculation;
- whether page ID, file UUID, page type, generation, and logical length are
  covered;
- when the checksum is calculated relative to compression/encryption;
- how an all-zero/uninitialized page is represented;
- whether stored bytes or decoded logical content are protected.

The sample covers all 4096 stored bytes, including page ID/generation, with the
checksum field zero. Covering page identity helps detect a valid page written
to the wrong location. A file UUID would further detect pages transplanted
between files; v1 would need to store it or derive a keyed checksum context.

Checksumming unused bytes requires writers to initialize them deterministically.
Otherwise stale memory or previous record fragments enter the checksum and may
leak data. Zero free space before writing when confidentiality or deterministic
images require it.

### What a torn page looks like

Assume old page generation 41 and new generation 42 span several storage
sectors. Power fails after some sectors reach media:

```
sector:       0       1       2       3
on media:   new42   new42    old41    old41
```

No claim that the application issued one page-sized write makes those sectors
one power-fail atomic unit. **[Storage]** atomic-write units and guarantees vary;
some devices/interfaces expose stronger facilities, but they must be queried,
aligned, configured, and tested rather than assumed.

The mixed page will normally fail a correctly implemented checksum. Possible
responses:

- restore a full-page image or redo from WAL;
- select the previous immutable COW page through the older superblock;
- recover from a doublewrite copy;
- fetch a verified replica;
- stop and require restore from backup.

Returning partial decoded records after checksum failure converts detected
corruption into silent corruption. Fail closed unless a documented forensic
mode isolates the damaged object and never writes it back as valid.

### WAL ordering

Write-ahead logging uses a different publication rule:

1. while a page is latched, construct a WAL record describing the change
   and associate its log sequence number (LSN) with the dirty page;
2. flush WAL through that LSN before the data page may reach durable storage;
3. acknowledge commit according to the transaction durability policy;
4. later flush dirty pages;
5. after crash, start from a checkpoint and redo logged actions newer than
   the durable page state.

A page LSN says which logged change the page image reflects. It is not itself a
checksum. WAL redo can repair a missing update, but a torn original page may
not be a valid base for physiological redo. Systems therefore use full-page
images after checkpoints, a doublewrite scheme, atomic-write support, or COW.
Chapter 65 develops WAL and transactional recovery.

### Scrubbing and repair

Validate at read, at backup/restore, and during background scrubbing. A scrubber
should record file/page identity, expected and observed checksum, device error,
replica comparison, and repair source. It must coordinate with writers so it
does not mistake an in-memory transition or partial buffered read for stable
corruption.

Checksums do not detect lost writes when the old page is internally valid.
Generations, page LSNs, parent expectations, replicated log position, and
end-to-end verification help detect staleness or misdirection.

---

## 63.8 Versioning, Migration, and Validation — Core

### Major, minor, and feature negotiation

Use version fields as rules:

- **major** changes when an old reader cannot safely interpret the structure;
- **minor** permits changes explicitly designed for backward-compatible
  reading;
- **required feature bits** cause rejection when unknown;
- **optional feature bits** may be ignored only under a stated skip rule.

Magic numbers reject wrong file types; they are not a substitute for versions
or validation. Put enough fixed bootstrap information at known offsets to find
the rest of the header. Include header length before extension fields.

Avoid one global version if independent object families evolve differently.
A file version can select the superblock grammar while page/record type and
version select local grammars. Too many unconstrained versions, however,
produce an untestable compatibility matrix. Publish supported combinations.

### Reader/writer compatibility

Define capabilities separately:

| Binary/file relation | Read? | Write? |
|---|---:|---:|
| current binary, current file | yes | yes |
| current binary, supported old file | yes | only after/through declared upgrade |
| old binary, newer compatible-minor file | perhaps | usually no unless guaranteed |
| unknown major or required feature | no | no |

Read-only forward compatibility is safer than allowing an old writer to erase
unknown fields. Preserve-unknown-field schemes require byte-for-byte retention
and conflict rules; they are not automatic.

### Migration strategies

1. **Read old, write new lazily.** Decode old records and rewrite them when
   naturally updated. This spreads cost but keeps both decoders and mixed
   states for a long time.
2. **Offline in-place migration.** Saves space but has difficult crash/rollback
   windows. Every unit needs an idempotent progress marker and old/new
   distinction.
3. **Shadow rewrite then swap.** Build a new file, validate it, sync it, then
   publish atomically under the platform protocol. Costs temporary space but
   makes rollback and validation straightforward.
4. **Logical export/import.** Slowest and may lose physical details, but crosses
   major architecture or engine boundaries cleanly.

For important data, prefer a migration that is resumable, observable, and does
not destroy the last known-good representation before the replacement is
durable and validated.

### Migration plan

A release-ready plan states:

1. accepted source versions and rejected combinations;
2. preflight space, backup, replica, and checksum requirements;
3. transformation and canonicalization rules;
4. progress unit and durable checkpoint;
5. restart behavior after every crash point;
6. validation of counts, identities, references, checksums, and application
   invariants;
7. rollback boundary;
8. point after which the old binary is fenced out;
9. cleanup of old pages/files only after the rollback window.

Test golden files written by supported historical versions. Tests that merely
round-trip the current encoder through the current decoder can preserve the
same bug on both sides. Include hand-authored boundary cases, truncated files,
unknown flags, overflow lengths, overlapping slots, duplicate IDs, bad
checksums, wrong-endian simulations, and randomized fuzz input.

### Validation layers

| Layer | Examples | Failure meaning |
|---|---|---|
| envelope | file size, magic, version, header length | wrong/truncated/unsupported object |
| integrity | checksum/MAC | bytes differ from protected image |
| local structure | counts, ranges, alignment if required, overlap | malformed page |
| graph structure | page type, parent/child reachability, no forbidden cycles | damaged logical structure |
| semantics | sorted keys, unique IDs, schema/type constraints | structurally readable but invalid data |
| transaction/recovery | generations, LSN ordering, committed roots | state not safely published |

Return precise typed errors without trusting corrupt strings for logging.
Limit recursion, allocations, decompression ratio, and total work so a corrupt
file cannot become a denial-of-service input.

---

## 63.9 Worked Design and Corruption Diagnosis — Core

Suppose a service stores a catalog in the sample format. Generation 41 points
to root page 17. It builds generation 42 with new leaf pages 90–93 and root 94.

### Correct COW publication

```
T0  superblock A = (gen 41, root 17), B = older
T1  write pages 90..94; each includes ID, gen 42, checksum
T2  persistence barrier for page file succeeds
T3  write superblock B = (gen 42, root 94, checksum)
T4  persistence barrier succeeds
T5  generation 42 may be acknowledged; old pages remain protected
```

Failure outcomes:

| Crash | Recovery |
|---|---|
| before T2 | select valid generation 41; ignore/reclaim unreachable new pages |
| after T2, before T3 | same; new pages are durable but unpublished |
| during T3 | B may fail checksum; select A generation 41 |
| after T3, before T4 | current visibility may show B, but promised power-loss durability is not yet established |
| after T4 | select B generation 42 after validating root/page identities |

If the writer published B before ensuring pages 90–94 durable, a perfectly
checksummed superblock could point to missing or stale data. This is an ordering
bug, not a checksum bug.

### Incident: page 92 fails CRC

Do not immediately “fix the checksum.” Diagnose:

1. **Freeze evidence.** Stop writes or snapshot consistently. Record file UUID,
   superblock generation, page ID, physical path/segment, offsets, hashes,
   device/kernel errors, and exact decoder version.
2. **Confirm identity.** Was page 92 read from the computed offset? Does its
   embedded ID equal 92 and file identity match? A valid checksum with the
   wrong ID suggests misdirected I/O or addressing.
3. **Classify the image.** Compare sectors/regions with generation 41 and 42
   copies. A mixture suggests a torn overwrite; all-old but valid data suggests
   a lost write; random localized bits suggest media/memory/path corruption.
4. **Find authoritative recovery data.** In COW, root 94 should reference an
   immutable page and generation 41 may still retain its older counterpart.
   In WAL, find the page LSN/full-page image and verify the WAL checksum.
   Compare a verified replica or backup.
5. **Repair through the engine's protocol.** Restore/replay/copy a verified
   page, recompute its checksum as part of a legitimate write, and persist it.
   Never bless unknown bytes by recalculating their checksum.
6. **Validate outward.** Check parent/child references, key ranges, record
   counts, all pages in the affected generation, and replicas/backups.
7. **Find cause.** Inspect power events, device health, firmware, controller
   cache policy, filesystem logs, memory errors, and whether every barrier was
   checked.

An error report should distinguish:

```
ChecksumMismatch(page=92, expected=..., observed=...)
WrongPageId(requested=92, embedded=29)
TruncatedPage(expected=4096, observed=3584)
SlotOutOfBounds(slot=7, offset=..., length=...)
OverlappingSlots(first=3, second=7)
UnsupportedRequiredFeature(bit=...)
```

That specificity turns “database is corrupt” into a recoverable investigation.

---

## 63.10 PostgreSQL 18 Physical-Format Reference — Skippable

This section is a concrete product reference, not a portable format recipe.
PostgreSQL physical files are tied to server major version/build/platform
expectations; use documented server tools rather than decoding live relation
files casually.

### Pages and item identifiers

**[PostgreSQL 18/build]** Built-in tables and indexes are arrays of fixed-size
pages, usually 8 KiB; another size can be selected when building the server.
The common page layout is:

```
PageHeaderData (24 bytes)
ItemIdData array (4 bytes each)
free space [pd_lower, pd_upper)
items growing backward
special space (used by index access methods; empty for ordinary heap pages)
```

Important `PageHeaderData` fields:

| Field | Role |
|---|---|
| `pd_lsn` | WAL position of the last change represented by the page |
| `pd_checksum` | page checksum when enabled |
| `pd_flags` | page flags |
| `pd_lower` | end of item-identifier array/start of free gap |
| `pd_upper` | end of free gap/start of item bodies |
| `pd_special` | start of access-method special space |
| `pd_pagesize_version` | page-size cross-check plus layout version |
| `pd_prune_xid` | hint for potentially profitable pruning |

An `ItemIdData` entry describes an item's offset, length, and interpretation
bits. Its array index remains stable while tuple bytes move during page
compaction. A tuple identifier (`CTID`/`ItemPointer`) is essentially block
number plus item-identifier index.

The product packs fields into native C structures and uses product macros to
interpret them. That does not license a separate C++ program to declare a
look-alike struct and `reinterpret_cast` arbitrary bytes. Decode documented
offsets/bit rules for the exact build, or use PostgreSQL's own facilities.

### Heap tuple reference

**[PostgreSQL 18/platform]** A heap row has a fixed header (23 bytes on most
machines), optional null bitmap, alignment padding to `t_hoff`, then attribute
data. Key header concepts:

- `t_xmin`: inserting transaction ID;
- `t_xmax`: deleting/locking transaction ID;
- command-ID overlay fields;
- `t_ctid`: current tuple ID or link to a newer row version;
- `t_infomask`/`t_infomask2`: status bits and attribute count;
- `t_hoff`: offset to user data.

The null bitmap is present only when its flag says so; a set bit means
not-null. Attribute interpretation also requires catalog metadata such as
length and alignment. Fixed pass-by-value versus pass-by-reference is an
in-memory function-call convention; the stored tuple contains the format's
datum bytes, not useful process pointers.

Variable-length `varlena` values have product-specific headers/flags and may be
short, compressed, or external. TOAST moves oversized attribute data to an
associated table in chunks and leaves an external reference in the main row.
Compression methods, thresholds, headers, and limits are product/version
details; use server APIs to detoast rather than treating the reference as a
generic blob pointer.

### Forks, maps, and segments

**[PostgreSQL 18/build]** A relation can have:

| Fork | Purpose |
|---|---|
| main | table or index pages |
| free-space map (`_fsm`) | tree of approximate available-space categories |
| visibility map (`_vm`) | page bits such as all-visible/all-frozen |
| initialization (`_init`) | reset image for unlogged relations |

The FSM and VM are auxiliary structures with their own recovery/maintenance
semantics; hints are rechecked against actual pages. TOAST is an associated
relation, not another fork.

Relation files are split into segments when they exceed the configured segment
size; 1 GiB is the default, but it is a build option. Temporary operation files
have separate lifecycle and durability expectations. A filenode is a physical
identity and need not remain equal to a logical relation OID across operations.

### Checksums, LSNs, and full-page images

**[PostgreSQL 18]** Data-page checksums are enabled by default but can be
disabled at cluster initialization or changed offline. They are verified on
read and cover data pages, not every persistent internal file or temporary
file.

PostgreSQL uses WAL ordering: log must reach durable storage before the related
data page. Because an 8 KiB page can be partially written at sector granularity,
full-page images in WAL protect the first modification after a checkpoint under
the normal `full_page_writes` policy. Recovery can restore the image before
redoing later changes. `pd_lsn` supports redo decisions; it does not prove page
integrity by itself.

For inspection, a controlled `pageinspect` session is safer than parsing a
live file behind the server:

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;
SELECT lower, upper, special, pagesize, version, prune_xid
FROM page_header(get_raw_page('demo', 0));

SELECT lp, lp_off, lp_flags, lp_len, t_xmin, t_xmax, t_ctid
FROM heap_page_items(get_raw_page('demo', 0))
ORDER BY lp;
```

Run only with appropriate privilege and against the exact server version.
Interpret MVCC fields with Chapter 65; do not infer committed visibility from
`xmin`/`xmax` alone.

---

## 63.11 Common Traps — Core

- Writing `sizeof(T)` bytes of a C++ object and calling it serialization.
- Adding a packing pragma and claiming the file is now portable.
- Storing `size_t`, native enum/bit-field representation, pointers, or host
  byte order without a deliberately platform-bound format contract.
- Reading a count or length, allocating immediately, and checking the file
  boundary afterward.
- Checking `offset + length <= size` without handling integer overflow.
- Validating every slot independently but failing to reject overlapping bodies.
- Treating a checksum as repair, cryptographic authenticity, or proof of a
  current rather than stale page.
- Leaving checksum coverage, checksum-field treatment, or page identity outside
  the specification.
- Assuming a page-sized `write` is power-fail atomic.
- Treating C++ stream `flush()` as a durable-media barrier.
- Replacing a file with rename but ignoring the temporary-file and directory
  persistence windows.
- Publishing a new root before all pages reachable from it are durable.
- Reusing slot IDs without a generation policy, so stale references resolve to
  unrelated new records.
- Recalculating a checksum over unknown corrupt bytes and thereby blessing
  them.
- Allowing an older writer to open a newer file and erase fields/features it
  does not understand.
- Making migration one destructive pass with no durable progress record,
  rollback boundary, or crash-injection tests.
- Believing round-trip tests alone prove compatibility.
- Applying PostgreSQL offsets, flags, page sizes, or fork details to another
  version/build/product—or treating them as a portable design mandate.

---

## Recall Card — Core

- A durable file is a versioned byte protocol; encode fields explicitly.
- Stable references use logical file/page/slot IDs, not native pointers.
- A slotted page has `header | slots → | free | ← bodies`; compaction changes
  slot offsets while record IDs stay stable.
- Validate envelope, checksum, local ranges/overlap, graph invariants,
  semantics, and publication state before use.
- Define checksum algorithm and coverage. Checksums detect; COW/WAL/replicas
  recover.
- A successful write or stream flush is not a universal persistence guarantee.
- COW publication persists children before the new root; WAL persists log
  before the data page.
- Dual valid superblocks plus generations survive a torn publication record.
- Versions define read/write compatibility; migrations must resume after every
  crash point and retain rollback evidence.
- PostgreSQL pages/tuples/TOAST/forks are a useful product reference, not
  portable native structs.

## Questions — Core

1. Why can two compilers that agree on C++ values disagree on `sizeof` and byte
   layout of a header, and which explicit encoding rules remove the dependency?
2. Derive the maximum legal slot count for the 4096-byte sample page, then list
   every bound needed before reading slot 100.
3. Explain why `(page_id, slot_id)` survives compaction but may still need a
   generation when deletion permits slot reuse.
4. Define checksum coverage that detects both torn and misdirected pages. What
   corruption and malicious changes can still evade CRC-32C?
5. For each replace-by-rename crash window, state which file may be selected
   and why syncing only the new file is insufficient on relevant platforms.
6. In the COW timeline, what failure results if the new superblock becomes
   durable before a referenced leaf page?
7. Why can WAL redo require a full-page image or doublewrite mechanism when the
   base page is torn?
8. Design major/minor/feature-bit rules that let a new reader accept an old
   file without allowing an old writer to erase unknown required data.
9. A page has a valid checksum and correct ID but an older generation than its
   parent expects. Classify the likely failure and name useful evidence.
10. Map PostgreSQL's `pd_lower`, `pd_upper`, `ItemIdData`, `CTID`, TOAST, FSM,
    VM, page checksum, and `pd_lsn` to the generic ideas in this chapter.

## Applied Exercise and Puzzle — Core

Extend the sample codec into a two-superblock file:

1. define and encode a superblock with file UUID, page size, generation, root,
   required features, checksum algorithm, and checksum;
2. add typed decoder errors and reject duplicate/overlapping slots, unknown
   required flags, wrong page identity, truncation, and oversized records;
3. implement tombstones with explicit slot states and compact without changing
   live slot IDs;
4. write a shadow generation, persist its pages, publish the alternate
   superblock, then persist publication using the APIs documented for your OS;
5. inject termination before and after every write/barrier;
6. fuzz decoder bytes and impose allocation/work limits;
7. migrate a golden v0 file to v1 by shadow rewrite and verify logical equality,
   file identity, checksums, and rollback.

Record the OS, filesystem, mount options, device/controller, compiler, and test
failure model. Do not claim power-loss safety from process-kill tests alone.

**Puzzle:** both superblocks pass CRC. A has generation 105/root 700; B has
generation 106/root 900. Root 900 passes CRC, but one child has generation 106
and all-zero bytes except a syntactically valid empty-page header. The writer
acknowledged generation 106.

Choosing the highest valid superblock is insufficient. The likely publication
protocol persisted the root before all dependencies, accepted an unwritten page
as a valid empty page, or omitted semantic reachability validation. Specify the
write/barrier ordering that should have prevented this, how an allocated-page
state or content commitment could make the error detectable, which generation
recovery may safely select, and what evidence is required before repair.

## Prerequisites for Chapter 64 — Core

You should be able to encode/decode a checked slotted page, explain stable page
and slot IDs, distinguish integrity from crash atomicity/durability, and trace
copy-on-write or WAL failure windows. Chapter 64 uses those invariants to
implement B-tree search, split, merge, and concurrent page updates.
