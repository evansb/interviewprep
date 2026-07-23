# Chapter 16 — Formatting and I/O

Formatting and I/O are separate operations. Formatting turns values into a representation; buffering groups that representation; transport moves bytes; flushing requests progress; durability requires another, stronger guarantee. A latency-sensitive design controls each boundary rather than treating “print” as one indivisible action.

Correctness comes first. Text may be locale-dependent, formatted input can fail after consuming characters, buffered output may never reach its destination, and a successful library call may still leave data only in user-space or kernel memory. Performance work begins only after the program defines what counts as a complete record, how errors are reported, and what loss policy is acceptable.

## 90-Second Screen — Core

Retain these facts:

1. `'\n'` inserts a character. `std::endl` inserts a newline and flushes the C++ stream. A flush may cause a system call, but it does not imply storage durability.
2. Iostreams carry state. Test an extraction itself—`while (in >> value)`—rather than testing `eof()` before attempting the read.
3. `sync_with_stdio(false)` permits the standard C++ streams to buffer independently from C `stdio`; it does not make mixed output ordered. Call it before I/O if you choose it.
4. `printf` is checked only by tools and implementation diagnostics; a conversion/argument mismatch is undefined behavior. A literal `std::format` format string is checked against its argument types during translation.
5. `to_chars` and `from_chars` allocate nothing, throw nothing, and ignore locale. They report a pointer and an error code, so callers must check both.
6. File and device operations can be partial. EOF, format failure, transport failure, flush failure, and durability failure are different states.

Be ready to defend two decisions:

- For protocol numbers or a fixed-buffer hot path, use `to_chars`/`from_chars`. For structured human-readable text, use `std::format` or `std::print` when the toolchain supports C++23; use streams or `stdio` when their state and error model fit.
- For hot-path logging, copy a bounded, self-contained record into a preallocated queue. The producer does no formatting, allocation, lock acquisition, syscall, or unbounded wait. The queue-full and consumer-failure policies are part of correctness, not afterthoughts.

---

## 16.1 Values, Representations, and Transports — Core

An I/O design is easier to reason about as four stages:

```
typed values
    │ formatting / serialization
    ▼
characters or bytes
    │ user-space buffering
    ▼
library buffer
    │ transport operation
    ▼
kernel / device / another process
    │ optional persistence operation
    ▼
durable medium
```

Each arrow has its own failure and cost. Formatting can reject a format, allocate, branch, or consult locale. Buffering copies bytes and may lock shared state. Transport can block, transfer only a prefix, or enter the kernel. Persistence can wait for a device and produce a much larger tail than ordinary buffered output.

### Text, binary, and formatted I/O

**Text I/O** moves a character sequence. The representation is intended to be interpreted as text and may be subject to implementation-specific external transformations. On systems that distinguish text and binary file modes, text mode can translate line endings; POSIX systems commonly make the two modes equivalent for regular files.

**Binary I/O** moves bytes without text-mode translation. `std::ios::binary` selects the implementation's binary open mode. It does not serialize C++ objects portably:

```cpp
#include <cstdint>

struct Quote {
    std::uint32_t id;
    double price;
};

// Not a portable file or wire format:
// out.write(reinterpret_cast<const char*>(&quote), sizeof quote);
```

The object can contain padding; byte order and floating representation can differ; schema changes alter layout; and pointers are meaningless outside the originating process. Trivial copyability permits copying an object's representation to bytes and back under the language's lifetime rules; it does not define a portable file format. A raw dump is appropriate only under a deliberately narrow contract that fixes the ABI, types, padding treatment, byte order, and reader compatibility. Chapter 55 owns fixed-layout serialization; protocol chapters own byte order and schema design.

**Formatted I/O** maps typed values to or from text according to formatting rules. `operator<<`, `printf`, `std::format`, and `to_chars` all format, but their state, locale, allocation, and error contracts differ.

| Facility | State and locale | Result storage | Primary error channel | Suitable role |
|---|---|---|---|---|
| Iostream insertion/extraction | Per-stream flags and locale | Stream buffer | `iostate`, optional exceptions | Stateful text files and ordinary diagnostics |
| C `printf`/`scanf` family | C locale, variadic format | `FILE*` or caller buffer | Return value, `ferror`, `errno` where specified | C boundaries and compact procedural I/O |
| `std::format` | Locale-neutral unless requested | Returned string or output iterator | Compile-time checking; `format_error` for runtime formats | Structured text |
| `std::print` | Format semantics plus output destination | Standard output or `FILE*` | Exceptions | Direct formatted output |
| `to_chars`/`from_chars` | No locale or persistent state | Caller-provided range | `errc` plus end pointer | Protocol fields and fixed buffers |
| `read`/`write`, `fread`/`fwrite` | No text formatting | Caller-provided bytes | Count plus library/OS error | Binary blocks |

The selection question is therefore not “which API is fastest?” It is “which representation, state model, error channel, and destination does this boundary require?”

---

## 16.2 Buffering, Flush, and Visibility — Core

Buffering amortizes transport overhead. Copying many small records into a user-space buffer can turn many potential kernel entries into one larger transfer. The trade-off is delayed visibility and loss of pending data if the process terminates abnormally.

The C standard defines fully buffered, line-buffered, and unbuffered streams. Defaults depend on the implementation and destination; a common hosted setup is line buffering for terminal `stdout`, full buffering when `stdout` is redirected, and no buffering for `stderr`. C++ stream buffers provide analogous batching, but the standard does not require a POSIX file descriptor or a particular `write(2)` pattern.

| Event | What it requests | What it does **not** guarantee |
|---|---|---|
| Insert `'\n'` | One newline character | A C++ stream flush, except where another policy triggers one |
| `std::endl` | Newline, then `flush()` | Disk durability |
| `std::flush` / `ostream::flush` | Synchronize the stream buffer with its controlled sequence | One syscall, physical-media persistence |
| `fflush(FILE*)` | Push pending C output to the host environment | `fsync`-like durability |
| Buffer fills | Library attempts transport | Completion of a whole application record unless designed that way |
| Normal `exit` | C streams are flushed and closed by the runtime | Flush after `abort`, `_Exit`, or a fatal signal |

On a typical POSIX `ofstream`, flushing a nonempty `filebuf` eventually invokes one or more system calls. A flush of an empty buffer may not. One `std::endl` per record defeats batching and can turn a formatting loop into a syscall-heavy loop. Use `'\n'` for record syntax and flush at an explicit semantic boundary: an interactive prompt, a handoff that requires visibility, a shutdown step, or a measured batching policy.

Several less-obvious operations can flush:

- `std::cin` is tied to `std::cout` by default, so a read can flush pending prompts.
- `std::unitbuf` requests a flush after each output operation; `std::cerr` has `unitbuf` set by default.
- Destroying or closing a file stream attempts to synchronize its buffer.
- Switching between reading and writing on a C update stream (`"r+"`, `"w+"`, or `"a+"`) requires the sequencing operations prescribed by the C rules.

Flushing is about movement between buffering layers, not durability. After a successful library flush, data can still reside in the kernel page cache or a device cache. POSIX `fsync`, platform storage semantics, power-loss behavior, and asynchronous kernel I/O belong to Chapter 34; Chapter 59 owns the observability loss and persistence policy.

### C buffering control

`setvbuf` configures a C stream's buffering mode and optional buffer. It must be called after the stream is associated with an open file and before any other operation on that stream. If the caller supplies storage, that storage must remain alive while the stream uses it.

```cpp
#include <array>
#include <cstdio>

int main() {
    std::array<char, 16 * 1024> storage{};
    std::FILE* file = std::fopen("events.log", "wb");
    if (file == nullptr) {
        return 1;
    }
    if (std::setvbuf(file, storage.data(), _IOFBF, storage.size()) != 0) {
        std::fclose(file);
        return 2;
    }
    const int rc = std::fputs("ready\n", file);
    const int close_rc = std::fclose(file); // also flushes pending output
    return (rc < 0 || close_rc != 0) ? 3 : 0;
}
```

The example checks `fclose` because a delayed write failure can first become visible while flushing. Ignoring close errors is acceptable only when loss is explicitly acceptable.

---

## 16.3 Iostream State, Files, and String Streams — Core

An iostream combines a **stream object** and a **stream buffer**:

```
basic_ostream / basic_istream
  formatting flags, locale, tie, exception mask, iostate
                         │ rdbuf()
                         ▼
basic_streambuf
  get/put areas, underflow/overflow, bulk transfer, synchronization
                         │
                         ▼
file, string, console, socket adapter, or custom destination
```

The stream owns formatted semantics; the buffer owns character transport. The standard specifies this interface, not how many virtual calls, copies, or syscalls a library uses. Implementations commonly handle characters inline while the buffer has space and call virtual refill/overflow functions only at boundaries. Bulk insertion may use an optimized block path. Inspect and benchmark the target library rather than repeating “iostreams make one virtual call per character.”

### State is the correctness contract

`std::ios_base::iostate` is a bitmask:

| Bit | Meaning |
|---|---|
| `goodbit` | No error bits; its value is zero |
| `eofbit` | Input reached end of the associated sequence |
| `failbit` | A formatted operation could not interpret or complete as requested |
| `badbit` | Loss of integrity in the underlying stream operation |

`operator bool` is equivalent to `!fail()`, so it rejects `failbit` and `badbit`. EOF is not a precondition to test. It is information learned by attempting a read:

```cpp
#include <sstream>
#include <vector>

std::vector<int> parse_ints(const char* text) {
    std::istringstream in{text};
    std::vector<int> values;
    for (int value; in >> value;) {
        values.push_back(value);
    }
    return values;
}
```

`while (!in.eof())` is wrong because EOF is normally set by the read that fails. The loop then processes a nonexistent record or stale application state. After a failed formatted extraction, do not infer a useful destination value; inspect the stream state and treat the parse transaction as failed. Exact assignment behavior depends on the extractor and failure path.

Streams report through state bits by default. Calling `exceptions(mask)` requests `std::ios_base::failure` after an operation sets a selected bit. This changes error transport, not the possible states. Exception mode can simplify a coarse file-loading boundary, but it is often inappropriate in a per-record parser where invalid input is expected and must be classified without unwinding.

Recovery requires three separate actions:

1. Decide whether the error is recoverable.
2. Clear the relevant state with `clear()`.
3. Remove or reposition past the offending input; clearing alone causes the same extraction to fail again.

### Sticky formatting state

Most formatting properties persist: base (`hex`/`dec`), floating style, precision, fill, `boolalpha`, and alignment remain until changed. `width` is usually reset to zero after the next formatted field. A helper that changes `std::hex` can alter every later integer written by its caller.

Save and restore state when a shared stream crosses an API boundary, or avoid shared formatting state. A narrow helper can copy flags, precision, and fill, then restore them before return. `std::format` avoids this category because each format string describes its own result.

### File streams

`ifstream`, `ofstream`, and `fstream` own a `basic_filebuf`. Opening can fail; reading can finish with a short count; flushing and closing can fail after earlier insertions appeared successful.

```cpp
#include <fstream>
#include <limits>
#include <string>

bool write_snapshot(const std::string& path, const std::string& bytes) {
    if (bytes.size() >
        static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max())) {
        return false;
    }
    std::ofstream out{path, std::ios::binary | std::ios::trunc};
    if (!out) {
        return false;
    }
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    out.close();                 // make delayed errors observable now
    return static_cast<bool>(out);
}
```

The function verifies library-level completion, not power-loss durability or atomic replacement. A production snapshot normally writes a temporary file, flushes as required by its durability contract, and renames it using platform rules covered later.

For input blocks, `read(buffer, n)` sets failure state when it obtains fewer than `n` characters. `gcount()` reports how many characters the last unformatted input operation actually extracted. A short final block can be normal EOF, while a short fixed-size header is usually corruption; the application must distinguish them.

### String streams

`istringstream` and `ostringstream` reuse the stream formatting model over memory. They are convenient for tests and heterogeneous ad hoc text, but they retain sentry/state/locale machinery and their backing string can grow dynamically. Reconstructing an `ostringstream` per message can therefore add allocation and deallocation to a hot loop.

C++20 added `basic_stringbuf::view()` for a non-owning view of the current sequence. The view is invalidated by operations that change or destroy the buffer. Calling `str()` obtains an owning string; depending on value category and overload, this can copy or move storage. For a fixed numeric field, `charconv` is a smaller contract.

---

## 16.4 C `stdio`, `printf`, and Synchronization — Core

C `stdio` combines a `FILE` object, buffering, position/state, and functions such as `fread`, `fwrite`, `fprintf`, and `fscanf`. It remains important at C interfaces and underlies the `FILE*` overloads of C++23 printing facilities.

`printf` is variadic. Default argument promotions apply, but no language rule connects an argument to its conversion:

- `%d` expects an `int`; `%zu` expects `size_t`; `%p` expects `void*`.
- `%s` expects a pointer to a null-terminated character sequence, not a `std::string`.
- A nonliteral, attacker-controlled format string can interpret `%` directives; passing it as `printf("%s", input)` treats it as data.
- A mismatch is undefined behavior. Compiler format warnings recover valuable checking but are not a C++ type-system guarantee.

`snprintf` is useful when a caller owns a fixed buffer. For a nonnegative return, the value is the number of characters that would have been produced, excluding the terminator. A value greater than or equal to the buffer size means truncation. A negative value reports an encoding or formatting failure.

```cpp
#include <array>
#include <cstdio>
#include <string_view>

std::string_view render_quantity(int quantity, std::array<char, 32>& out) {
    const int n = std::snprintf(out.data(), out.size(), "qty=%d", quantity);
    if (n < 0 || static_cast<std::size_t>(n) >= out.size()) {
        return {};
    }
    return {out.data(), static_cast<std::size_t>(n)};
}
```

The returned view borrows `out`; the caller must not retain it after the array dies or is reused.

### Synchronizing C and C++ standard streams

The eight standard C++ streams are synchronized with their corresponding C streams by default. Observable effects of operations on synchronized character pairs are required to match, which permits predictable interleaving and allows thread-safe individual character operations, though groups of operations can still interleave.

`std::ios_base::sync_with_stdio(false)` permits independent buffering and can improve throughput for programs that use only iostreams. It does not make mixing illegal, but call order across `printf` and `cout` no longer determines output order without explicit coordination. If called after I/O has occurred on a standard stream, the effect is implementation-defined. Make the choice once at startup and use one family per destination.

`std::cin.tie(nullptr)` removes the default tie that flushes `cout` before an input operation. That is useful for batch input, but interactive prompts must then flush explicitly.

Thread safety is separate from C/C++ synchronization. While the standard streams remain synchronized, required character operations from several threads do not create data races, yet fragments can interleave. Turning synchronization off changes the applicable guarantees and must follow the implementation's documented thread-use contract. A complete log record needs application-level serialization. C++20 `osyncstream` can assemble a record privately and emit it atomically relative to other `osyncstream`s on the same wrapped buffer, but it may allocate and is not a hot-path logging design.

---

## 16.5 Error Handling and Partial I/O — Core

An I/O call is not a Boolean event. It can transfer a prefix, reach an expected boundary, encounter malformed input, lose transport integrity, or delay failure until a flush. Robust code defines completion at the layer it owns.

| Symptom | State threatened | Evidence to inspect | Typical response |
|---|---|---|---|
| Formatted token is invalid | Parsed value invariant | `failbit`, `from_chars.ec`, conversion return | Reject record or resynchronize |
| Input ends between records | Availability | `eofbit`, `feof`, zero-byte OS result | Normal completion if boundary permits |
| Input ends inside fixed record | Framing integrity | Short `gcount`/element count | Report truncation/corruption |
| Output buffer is too small | Representation completeness | Required size or `value_too_large` | Reject, resize off-path, or mark truncation |
| Library transport fails | Delivery | `badbit`, `ferror`, negative OS result | Retry only where contract allows; surface error |
| Flush or close fails | Delayed delivery | Stream state, `fflush`/`fclose` result | Mark output incomplete; alert or fail operation |
| Queue is full | Logging observability | Failed `try_push`, drop counter | Apply explicit drop/overwrite/backpressure policy |
| Consumer cannot write | Logging sink health | Error counter and sink state | Alarm, fail over, disable, or stop according to policy |

### C and C++ partial operations

`fread(ptr, size, count, file)` and `fwrite` return the number of complete elements transferred. Using `size == 1` for a byte buffer makes the return directly comparable to a byte count. A short `fread` can mean EOF or error; call `feof` and `ferror` after the short result. A short `fwrite` is a failure condition for the intended block.

Formatted C functions report counts too. `printf`/`fprintf` return a negative value on output or encoding error. `scanf` returns the number of assignments completed, which can be less than requested after consuming part of the input; `EOF` is distinct. Code that checks only “not EOF” can accept a partially populated record.

Iostream unformatted reads expose `gcount()`. Formatted reads expose state and may consume a prefix before failing. Parsing directly into a live domain object can therefore leave a mixture of old and new fields. Parse into temporary values, validate all fields, then commit:

```cpp
#include <istream>
#include <string>
#include <utility>

struct Order {
    std::string symbol;
    int quantity;
};

bool read_order(std::istream& in, Order& destination) {
    std::string symbol;
    int quantity = 0;
    if (!(in >> symbol >> quantity) || quantity <= 0) {
        return false;
    }
    destination = Order{std::move(symbol), quantity};
    return true;
}
```

This gives the domain object a strong parse guarantee: on failure, `destination` is unchanged. It does not rewind the stream; resynchronizing after malformed input is a separate framing decision.

Below the library, POSIX `read` and `write` can return a positive count smaller than requested and can be interrupted. Nonblocking descriptors add “would block.” Correct retry loops, readiness/completion APIs, and syscall error semantics belong to Chapter 34 §§34.3–34.6. The lesson here is to preserve counts and errors instead of narrowing them to `bool`.

### EOF is not an error policy

EOF is normal for “read records until the file ends” only when it occurs at a record boundary. If a binary header promises a 1,024-byte payload and only 700 bytes arrive, EOF is truncation. If an interactive peer closes while a request is outstanding, EOF can be a protocol failure. The transport reports a condition; the application assigns meaning.

### Destructors cannot report completion

RAII guarantees an attempt to close a stream, not that the attempt succeeded observably. Destructors cannot return an error, and standard stream destructors do not provide a convenient place to react to late failure. When output matters, explicitly flush/close and inspect state before the object leaves scope. For logging where loss is tolerated, document that decision and count lost records where possible.

---

## 16.6 Safe Structured Formatting: `format` and `print` — Core

`std::format` (C++20) describes one formatting operation without mutating shared stream flags. For a literal format string accepted through `std::format_string<Args...>`, replacement fields and argument types are checked during translation. A call such as `std::format("{:d}", std::string{"x"})` is ill-formed rather than runtime undefined behavior.

A runtime-supplied format is a different trust boundary. In C++23, use `std::vformat` with `std::make_format_args`; invalid syntax or an incompatible runtime specification throws `std::format_error`. C++26's `runtime_format` is outside this book's language version.

```cpp
#include <format>
#include <string>

std::string describe_fill(int id, double price, int quantity) {
    return std::format("fill id={} px={:.4f} qty={}", id, price, quantity);
}
```

`std::format` returns a `std::string`. Whether that string allocates depends on result length, allocator behavior, and the library's small-string representation; the standard does not specify an SSO threshold.

### Formatting into caller storage

`format_to` writes through an output iterator. `format_to_n` writes at most `n` output elements and also returns the total size the untruncated result would have required:

```cpp
#include <array>
#include <format>
#include <string_view>

std::string_view bounded_message(int id, std::array<char, 64>& storage) {
    auto result = std::format_to_n(
        storage.data(), storage.size(), "cancel id={}", id);
    if (static_cast<std::size_t>(result.size) > storage.size()) {
        return {}; // policy: reject rather than emit a truncated record
    }
    return {storage.data(), static_cast<std::size_t>(result.out - storage.data())};
}
```

The output range prevents an overrun. It does not choose a truncation policy for the application. Silently accepting a prefix can produce ambiguous logs or invalid JSON, so reject, mark, or split according to the record format.

Using an output iterator avoids the mandatory returned string, but the standard does not promise that every implementation or user-defined formatter performs no internal allocation. If allocation freedom is a hard requirement, test the deployed library or use a narrower conversion path.

### Custom formatters

A `formatter<T, char>` specialization defines how a user type parses its format specification and emits output. The parse function must reject unsupported trailing specification text rather than silently accepting it. In C++23, the formatting call operator is required to work on a const formatter.

```cpp
#include <format>

struct Price {
    long ticks;
};

template <>
struct std::formatter<Price> {
    constexpr auto parse(std::format_parse_context& context) {
        auto it = context.begin();
        if (it != context.end() && *it != '}') {
            throw std::format_error{"Price supports only {}"};
        }
        return it;
    }

    auto format(const Price& price, std::format_context& context) const {
        return std::format_to(
            context.out(), "{}.{:02}", price.ticks / 100, price.ticks % 100);
    }
};
```

This simple formatter assumes nonnegative ticks; a production formatter must define the sign and minimum-value cases. That domain rule matters more than the formatter syntax.

### C++23 printing

`std::print` and `std::println` format directly to the standard output stream or a supplied `FILE*`. They avoid requiring the caller to construct an intermediate string. The standard specifies observable output and errors, not allocation count, lock strategy, syscall count, or a particular POSIX/Windows implementation.

Formatting failures use the format facility's rules; output failures can throw `std::system_error`. Toolchain support for `<format>` and `<print>` lagged the language standard, so check feature-test macros and the minimum supported standard-library version in the build. Lack of one library implementation does not change their C++23 status.

### Choosing among the formatted families

| Requirement | First candidate | Reason to reject it |
|---|---|---|
| C ABI or existing `FILE*` code | `fprintf`/`snprintf` | Variadic mismatch risk or locale dependence |
| Stateful report with many inserted user types | Iostream | Sticky state, locale, allocation, or composition cost |
| Self-contained structured message | `std::format` | Returned-string allocation is unacceptable |
| Direct human-readable output | `std::print` | Toolchain support or exception policy does not fit |
| Fixed numeric protocol field | `to_chars` | Needs richer layout than the narrow API provides |

---

## 16.7 Allocation-Free Numeric Conversion — Core

`std::to_chars` and `std::from_chars` operate on a caller-provided character range. They allocate nothing, throw nothing, and ignore the global or stream locale. They also avoid hidden parsing conveniences:

- output is not null-terminated;
- input whitespace is not skipped;
- integer parsing does not accept a leading `+`;
- integer base is explicit and prefixes such as `0x` are not consumed as part of base 16;
- success can still leave an unparsed suffix.

Always check the error code and the returned pointer:

```cpp
#include <charconv>
#include <string_view>
#include <system_error>

bool parse_quantity(std::string_view field, int& quantity) {
    if (field.empty()) {
        return false;
    }
    int candidate = 0;
    const char* first = field.data();
    const char* last = first + field.size();
    const auto [ptr, ec] = std::from_chars(first, last, candidate);
    if (ec != std::errc{} || ptr != last || candidate <= 0) {
        return false;
    }
    quantity = candidate;
    return true;
}
```

`invalid_argument` means no character matched. `result_out_of_range` means the mathematical value does not fit. For output, `value_too_large` means the supplied range was too small. Preserve the old destination until all checks succeed, as the example does.

```cpp
#include <array>
#include <charconv>
#include <string_view>

std::string_view render_id(unsigned long long id, std::array<char, 32>& out) {
    const auto [ptr, ec] = std::to_chars(out.data(), out.data() + out.size(), id);
    if (ec != std::errc{}) {
        return {};
    }
    return {out.data(), static_cast<std::size_t>(ptr - out.data())};
}
```

Floating-point overloads are also standard. Their representation rules and round-trip choices are covered in Chapter 13 §13.4. For protocol parsing, specify whether non-finite values, signs, exponent notation, and complete consumption are permitted; “`from_chars` succeeded” is only the lexical part of validation.

---

## 16.8 Asynchronous Logging Contract — Core

Asynchronous logging moves formatting and transport away from the producer. It does not remove their cost; it changes which thread pays, batches work, and introduces a bounded queue between production and visibility.

```
hot producer
  validate/copy fixed record
  try_push ──────full?──▶ explicit loss policy + counter
      │
      ▼
preallocated bounded queue
      │
      ▼
logging consumer
  decode → format → batch → write → check errors
      │
      ▼
sink and health reporting
```

The producer contract for a strict hot path is:

- no text formatting;
- no dynamic allocation;
- no syscall;
- no mutex or library-stream lock;
- only queue atomics whose lock-free implementation is verified on the target;
- no unbounded wait;
- bounded copying into a preallocated slot;
- an observable result when the queue is full.

The queue algorithm and its memory-order proof belong to Chapter 26. This chapter owns the record, loss, lifetime, and formatting boundaries.

### Record format and lifetime

A queued record must be self-contained until consumption. Numeric values, enum tags, fixed arrays, stable interned IDs, and offsets into storage with a longer lifetime are suitable. Arbitrary pointers and `string_view`s are not: a local buffer or reused `std::string` can die or change before the consumer reads it.

For short symbols, copy bytes inline. For long messages, choose among bounded inline storage, a separately owned block, interning, or deliberate truncation. Each choice changes producer copy cost and capacity. Never enqueue a pointer merely because it is cheaper without proving the pointee lifetime.

Do not persist raw C++ object representations as a durable log format. Even a trivially copyable queue record can contain padding and native-endian values. The in-process queue can use domain structs; the consumer should serialize an explicit stable representation before writing a file intended for later binaries.

### Queue-full policy

There is no universally correct full policy:

| Policy | Producer effect | Information effect | Appropriate condition |
|---|---|---|---|
| Drop newest and count | Bounded failed push | Loses current record | Diagnostics must never delay trading path |
| Overwrite oldest | Bounded push | Preserves recent window, loses history | Flight recorder |
| Sample | Bounded conditional push | Controlled reduction | High-volume repetitive telemetry |
| Block/backpressure | Couples producer to consumer | Preserves records while sink recovers | Audit path whose correctness requires delivery |
| Synchronous fallback | Adds formatting/syscall tail | Attempts delivery | Rare critical events outside strict hot path |
| Stop/fail closed | Ends or degrades service | Avoids unaudited operation | Regulatory or risk requirement |

“Drop and count” is a common hot-path choice, not a default for every log. A regulatory audit trail can require backpressure or fail-closed behavior. The counter must itself be safe and visible; a logger that silently drops when its queue is full has converted an observability problem into hidden data loss.

### Consumer and shutdown policy

The consumer formats, batches records, writes, and checks the sink. Batching reduces lock and syscall frequency but increases queueing delay and the amount lost on abrupt termination. Measure throughput, producer p50/p99/max, queue high-water mark, drop count, consumer lag, and time-to-visible-output under normal load and induced sink stalls.

Sink failure cannot be logged recursively to the same failed sink. Use a separate health channel, an atomic status consumed by supervision, a fallback descriptor, or a process policy. Shutdown must define whether producers stop first, whether the queue drains, what timeout applies, and how undrained records are counted.

Disabled log levels need lazy argument evaluation. A normal function call evaluates its arguments before entering the logger, so `debug("{}", expensive())` still pays for `expensive()`. A guarding macro, callable/lambda wrapper, or explicit `if (enabled)` can preserve the disabled-path contract. Chapter 41 owns cold code layout; Chapter 59 owns production sampling, correlation, and flight recorders.

---

## 16.9 Worked Design: A Bounded Fill Logger — Core

Assume one matching-engine thread produces fill events and one logging thread consumes them. A fill contains an order ID, price in integer ticks, quantity, and a symbol of at most eight bytes. The requirement is bounded producer time even if the disk stalls; losing diagnostic fill messages is allowed only if counted. This is not the regulatory audit trail.

### Step 1: Make the record own its data

The symbol is copied inline. Integer ticks avoid floating-point text policy on the producer. A site/type tag lets the consumer choose a formatter without storing a format-string pointer.

```cpp
#include <array>
#include <cstdint>

struct Symbol {
    std::array<char, 8> bytes{};
    std::uint8_t size{};
};

struct FillRecord {
    std::uint64_t sequence{};
    std::uint64_t order_id{};
    std::int64_t price_ticks{};
    std::uint32_t quantity{};
    Symbol symbol{};
};

struct FillSink {
    bool try_push(const FillRecord&) noexcept; // supplied by the concrete ring
};

bool log_fill(FillSink& sink, const FillRecord& record) noexcept {
    return sink.try_push(record); // false means caller increments its drop counter
}
```

The interface is intentionally narrower than a logging framework. The surrounding contract requires `try_push` not to wait; `noexcept` alone expresses only its exception behavior and does not prove bounded progress. Chapter 26 supplies a concrete SPSC ring with release/acquire publication and separated producer/consumer cache lines.

An inline symbol costs a fixed nine bytes before padding. The alternative pointer would reduce copying but introduce lifetime proof, extra indirection, and possibly a second allocation. For an eight-byte maximum, inline ownership is the simpler invariant.

### Step 2: Format only on the consumer

The consumer can use `std::format_to_n`, but a delimiter-separated record is also easy to encode with `to_chars`. This helper is fully bounded and rejects insufficient output storage rather than emitting a partial line:

```cpp
#include <algorithm>
#include <charconv>
#include <span>
#include <string_view>

bool encode_fill(std::span<char> out, const FillRecord& r, std::size_t& used) {
    if (out.empty() || r.symbol.size > r.symbol.bytes.size()) return false;
    char* cursor = out.data();
    char* const end = cursor + out.size();

    auto append = [&](std::string_view text) {
        if (static_cast<std::size_t>(end - cursor) < text.size()) return false;
        cursor = std::copy(text.begin(), text.end(), cursor);
        return true;
    };
    auto number = [&](auto value) {
        const auto [next, ec] = std::to_chars(cursor, end, value);
        if (ec != std::errc{}) return false;
        cursor = next;
        return true;
    };

    if (!number(r.sequence) || !append(",") || !number(r.order_id) ||
        !append(",") || !number(r.price_ticks) || !append(",") ||
        !number(r.quantity) || !append(",") ||
        !append({r.symbol.bytes.data(), r.symbol.size}) || !append("\n")) {
        return false;
    }
    used = static_cast<std::size_t>(cursor - out.data());
    return true;
}
```

The consumer owns the destination buffer until the write completes. Reusing it while an asynchronous transport still references it would recreate the same lifetime bug on the other side of the queue.

### Step 3: State the failure and latency argument

The producer performs one bounded record copy and one bounded `try_push`. It allocates nothing and invokes no I/O. On full, it returns false; the producer increments a per-thread drop counter and continues. Because there is one producer per ring, the drop counter can be thread-confined on the update path and aggregated later.

The consumer drains several records into a preallocated byte block, then writes the block. If `encode_fill` fails, that is a configuration/schema error: the fixed buffer cannot hold the maximum record. Count it and alarm; do not truncate silently. If the sink write fails, publish logger health out of band and follow the configured disable/failover policy.

The design trades immediate visibility and guaranteed diagnostic delivery for bounded producer latency. Confirm the decision with four tests:

1. maximum-size symbols and numeric values fit the encoding buffer;
2. queue publication passes thread-sanitized and wraparound tests owned by Chapter 26;
3. a deliberately stalled consumer produces bounded `try_push` time and an exact drop count;
4. orderly shutdown drains or reports every remaining slot.

This worked design stops at the logging boundary. Multi-producer merging, timestamps, disk layout, compression, and kernel asynchronous I/O belong to Chapters 35, 59, and 34.

---

## 16.10 Locale and Character Classification — Role-specific

A locale packages cultural rules as facets such as `num_put`, `num_get`, `numpunct`, `ctype`, `collate`, and time/money facets. Iostream formatted operations use the stream's locale. C formatted conversion and functions such as `strtod` use the relevant C locale category.

The main low-latency issue is correctness. A protocol decimal point must not change because process configuration selects a locale whose decimal separator is a comma. `to_chars` and `from_chars` are locale-independent by specification. `std::format` is locale-independent unless locale-specific formatting is requested, such as the `L` option with a locale-aware overload/context.

Locale performance is implementation-dependent. Facet access can involve lookup and virtual dispatch; constructing a named locale can allocate and consult operating-system locale data. These are mechanisms to measure, not a universal cycle count. Construct and imbue locales during setup if human-facing output requires them.

The C locale is process-global in the standard interface. Concurrently changing it with `setlocale` while other code performs locale-sensitive operations is not a portable design. Set process policy during single-threaded startup or use platform-specific locale objects where required.

Character-classification functions have a separate correctness trap:

```cpp
#include <cctype>

bool is_space(char ch) {
    return std::isspace(static_cast<unsigned char>(ch)) != 0;
}
```

Passing a negative `char` value other than `EOF` to `<cctype>` classification functions is undefined behavior. Cast through `unsigned char`. For an ASCII wire protocol, explicit ASCII range checks are both semantically clearer and independent of locale; do not replace Unicode or human-text rules with ASCII checks merely for speed.

---

## 16.11 Stream Buffers and Locking — Deep Dive

`basic_streambuf` maintains get and put areas. When the current pointer reaches the end, virtual functions such as `underflow`, `overflow`, and `sync` let a derived buffer refill, emit, or synchronize. `xsgetn` and `xsputn` support bulk transfer. A library may optimize common paths, cache locale information, or forward blocks directly; none of those choices gives a portable instruction count.

This separation is useful for adapters and tests. A custom stream buffer can route output to a bounded memory region or count bytes. It is also easy to implement incorrectly: pointer-area invariants, EOF representation, partial writes, exception translation, and object lifetime all matter. Prefer existing buffers unless the transport boundary genuinely needs stream syntax.

Both C and C++ facilities may synchronize access to shared standard streams. On POSIX, `FILE*` functions normally use per-stream locking; `_unlocked` functions and `flockfile` are POSIX extensions, not standard C++. Avoiding a library lock is valid only if the application proves exclusive access. A per-thread buffer followed by one serialized handoff often scales better than many threads writing fragments to one stream.

`osyncstream` solves record interleaving, not I/O latency. Each wrapper accumulates characters in a `basic_syncbuf`; emission to the wrapped buffer is synchronized against other wrappers targeting the same buffer. Buffer growth may allocate, and eventual emission can flush or block. It is useful for readable diagnostics from worker threads, not for a producer contract that forbids allocation and blocking.

---

## 16.12 Measuring Formatter and I/O Cost — Reference

Benchmark the layer you intend to choose. A formatter benchmark that discards output can be optimized away; one that writes to a terminal mostly measures terminal and scheduler behavior. A useful experiment separates:

1. value-to-buffer formatting;
2. buffer growth/allocation;
3. synchronization on a shared stream;
4. buffer-to-kernel transport;
5. storage/device completion.

The following harness compares integer conversion into local storage. It deliberately includes construction of an `ostringstream` on each operation; if your real design reuses one, change the harness to match.

```cpp
#include <array>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <sstream>
#include <system_error>
#include <utility>

template <class Function>
auto measure_batch(Function convert, unsigned seed) {
    std::size_t checksum = 0;
    const auto start = std::chrono::steady_clock::now();
    for (int i = 0; i != 100'000; ++i) {
        seed = seed * 1664525u + 1013904223u;
        checksum += convert(seed);
    }
    return std::pair{std::chrono::steady_clock::now() - start, checksum};
}

std::size_t with_to_chars(unsigned value) {
    std::array<char, 32> out{};
    auto [ptr, ec] = std::to_chars(out.data(), out.data() + out.size(), value);
    if (ec != std::errc{}) return 0;
    const auto size = static_cast<std::size_t>(ptr - out.data());
    return size + static_cast<unsigned char>(out.front()) +
           static_cast<unsigned char>(ptr[-1]);
}

std::size_t with_snprintf(unsigned value) {
    std::array<char, 32> out{};
    const int n = std::snprintf(out.data(), out.size(), "%u", value);
    if (n <= 0 || static_cast<std::size_t>(n) >= out.size()) return 0;
    return static_cast<std::size_t>(n) +
           static_cast<unsigned char>(out.front()) +
           static_cast<unsigned char>(out[static_cast<std::size_t>(n - 1)]);
}

std::size_t with_stream(unsigned value) {
    std::ostringstream out;
    out << value;
    const auto text = out.str();
    return text.size() + static_cast<unsigned char>(text.front()) +
           static_cast<unsigned char>(text.back());
}
```

Reading the first and last produced characters into the checksum forces the representation to be materialized; checking only the reported length can permit more aggressive optimization. Run many batches after warm-up, retain each duration, and compare a distribution rather than one average. Pinning, compiler flags, library versions, CPU power state, input distribution, buffer size, and locale are experimental inputs. Verify the checksum and inspect allocations/syscalls separately with the tools from Chapter 43. Add `format_to_n` only when the tested standard library supports it.

For end-to-end logging, induce a consumer stall. Report producer latency percentiles and maximum, drops, queue depth, consumer lag, batch size, bytes per syscall, and shutdown drain time. A faster median that develops an unbounded full-queue pause is a failed low-latency design.

---

## 16.13 Selection Reference

| Need | Choose | Named costs to verify | Correctness trap |
|---|---|---|---|
| Parse protocol integer | `from_chars` | Branches over digits | Ignoring suffix or `errc` |
| Format one number into fixed storage | `to_chars` | Conversion only | No terminator; undersized range |
| Compose structured text in memory | `format_to_n`/`format_to` | Formatter work; possible implementation/user allocation | Treating truncation as valid record |
| Obtain owning formatted string | `std::format` | Result allocation/copy | Runtime format can throw |
| Print formatted C++23 text | `std::print` | Library lock, buffering, transport | Assuming syscall/allocation count |
| Stateful text file | `fstream` | Sentry, locale, buffer, flush | Ignoring state/close failure |
| Parse heterogeneous ad hoc text | `istringstream` | Locale, buffer/string allocation | `eof()` loop and partial object mutation |
| C boundary or `FILE*` | `stdio` | Runtime format parse, stream lock, buffer | Variadic mismatch and unchecked returns |
| Binary block | `read`/`write`, `fread`/`fwrite`, stream `read`/`write` | Copy, partial transfer, syscall at lower layer | Treating object layout as serialization |
| Hot-path diagnostics | Fixed record plus bounded queue | Record copy, queue cache lines, drop accounting | Pointer lifetime or hidden blocking |

Optimization should remove a named mechanism and preserve an explicit error policy. “Replace `ostringstream` with `to_chars` to remove locale/state machinery and dynamic string growth for this fixed integer field; confirm allocation count and p99 conversion time” is an engineering claim. “Iostreams are slow” is not.

---

## Recall Card — Core

- Separate formatting, buffering, transport, flush, and durability.
- `std::endl` inserts a newline and flushes; `'\n'` only inserts a character.
- A flush can expose delayed errors and cause transport, but it does not guarantee persistent storage.
- Test extraction with the extraction expression. EOF is learned by reading and is only normal at a valid framing boundary.
- Iostream flags are sticky except field width's one-use behavior; stream errors are state bits unless the exception mask requests throwing.
- `sync_with_stdio(false)` allows C++ and C standard streams to buffer independently; choose it before I/O and avoid mixed ordering assumptions.
- `printf` mismatches are undefined behavior. Literal `std::format` strings are type-checked.
- `to_chars`/`from_chars` are locale-free, non-allocating, non-throwing range operations. Check `ec` and `ptr`.
- Partial input/output and delayed flush/close failures must remain visible in the API.
- A bounded async logger copies self-contained records, has an explicit full policy, formats on the consumer, and reports sink failure.

## Common Traps — Core

- Using `while (!stream.eof())` and processing one nonexistent final record.
- Clearing `failbit` without consuming or skipping the offending input.
- Writing a native C++ struct as a supposedly portable binary file.
- Assuming `std::endl`, `fflush`, or `close` implies power-loss durability.
- Calling `sync_with_stdio(false)` after standard-stream I/O and expecting portable behavior.
- Passing `std::string` to `%s`, `size_t` to `%d`, or untrusted text as the `printf` format.
- Ignoring the required size from `snprintf` or `format_to_n` and accepting a truncated record.
- Ignoring an unparsed suffix after successful `from_chars`.
- Passing a negative plain `char` to `std::isspace` or another `<cctype>` function.
- Enqueuing `string_view`, `c_str()`, or a pointer to producer-owned mutable storage in an async logger.
- Making the “async” producer format a string, allocate a queue node, take a mutex, or block on full.
- Reporting logger failure by recursively logging to the failed logger.

## Reasoning Questions — Core

1. A loop replaces `'\n'` with `std::endl` and develops tail spikes. Which layer changed, and what measurements would confirm the mechanism?
2. Why can `while (!in.eof())` process an invalid record, and how does `while (in >> record)` change the control flow?
3. A file stream's insertions all succeeded, but `close()` fails. Which earlier assumption was wrong, and what should the surrounding operation report?
4. When is `sync_with_stdio(false)` helpful, and why does it make `printf`/`cout` call order an unsafe output-order assumption?
5. Compare `snprintf`, `format_to_n`, and `to_chars` for a fixed 32-byte numeric field: what checking and formatting power does each provide?
6. Why must a `from_chars` parser check both `ec` and `ptr == last` for a protocol field?
7. A binary file created by dumping a struct fails after a compiler upgrade. Name three representation properties that could have changed.
8. For a full logging queue, when is drop-and-count correct, and when must the process backpressure or fail closed?
9. Why does copying an eight-byte symbol inline improve correctness over queuing a `string_view`, even though both have bounded-size handles?
10. Which metrics distinguish a logger that moved work off the producer from one that merely hid unbounded delay in its queue?

## Code-Reading Puzzle — Core

```cpp
#include <iomanip>
#include <iostream>

int main() {
    std::cout << std::hex << 255 << ' ';
    std::cout << std::setw(4) << std::setfill('0') << 7 << ' ';
    std::cout << 16 << ' ' << 16 << '\n';
}
```

Predict the exact output. Which settings persist, which setting applies only to one field, and what would a helper need to restore before returning?

## Design Exercise — Core

Design a diagnostic logger for per-order risk decisions. The producer record needs an order ID, an eight-byte symbol, a decision enum, a signed limit value, and an optional explanation of at most 48 bytes.

Specify:

1. the in-memory record representation and how optional text owns its lifetime;
2. whether each producer has an SPSC queue or producers share another queue;
3. the full-queue policy for ordinary rejects and for a “risk subsystem unavailable” event;
4. how the consumer detects truncation and sink failure;
5. the shutdown/drain rule;
6. the benchmark workload, induced failure, and success measures.

Keep scheduling, queue implementation, filesystem durability, and cross-thread clock synchronization as cross-references to Chapters 26, 34, 35, and 59.

## Prerequisites for Chapter 17 — Core

Chapter 17 covers templates. Before starting it, you should be able to distinguish compile-time checking from runtime format parsing, recognize where a formatting API's template instantiations begin, and explain why an output-iterator API can avoid constructing a result string without guaranteeing that every formatter implementation allocates nothing.
