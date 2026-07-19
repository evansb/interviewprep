# Chapter 16 — Formatting and I/O

*Interview-focused revision notes. The theme: text output is where a hot path quietly acquires virtual dispatch, locale lookups, heap allocations, and syscalls — and every one of them is avoidable if you understand what each formatting layer actually does.*

---

## 16.1 Iostream Architecture and Cost

`<iostream>` is a two-layer design: a **stream** object that handles formatting and state, and a **stream buffer** (`std::basic_streambuf`) that handles character transport. Understanding the split explains every performance property of the library.

```
std::ostream (formatting layer)
  ├── format flags (ios_base::fmtflags), width, precision, fill
  ├── locale (imbued std::locale, cached facet pointers)
  ├── iostate bits: goodbit / badbit / failbit / eofbit
  └── rdbuf() ──► std::streambuf (transport layer)
                    ├── put area:  pbase() ─ pptr() ─ epptr()
                    ├── get area:  eback() ─ gptr() ─ egptr()
                    └── virtual overflow() / underflow() / sync() / xsputn()
```

The **streambuf** owns a character array with three pointers per area. `sputc` is inline and cheap: bounds-check `pptr() < epptr()`, store, increment. Only when the put area fills does it call the **virtual** `overflow()`, which for `std::filebuf` issues a `write(2)`. So the syscall cost is amortized over the buffer (typically 4–8 KiB, `BUFSIZ`-derived), but the *virtual call per character* is not always amortized — `xsputn` is the bulk path and quality implementations override it with a `memcpy`, but naive `operator<<` chains on small values still cross a virtual boundary per insertion.

### Where the time goes

| Cost | Source | Avoidable? |
|---|---|---|
| Virtual dispatch per `<<` | `streambuf::xsputn`/`overflow` | Partly (bulk writes) |
| `sentry` construction per `<<` | Flushes tied stream, checks `good()`, locale-dependent whitespace skip on input | No (mandated) |
| Locale facet lookup | `std::use_facet<num_put<char>>(getloc())` per numeric insertion | Yes — see §16.4 |
| `num_put` virtual formatting | A virtual call into the locale facet, which formats into a temp buffer | Yes — use `to_chars`/`format` |
| Allocation | `ostringstream` grows its internal string | Yes — `std::string` reserve, or `format_to` into a fixed buffer |
| `std::endl` | Inserts `'\n'` **and calls `flush()`** → `write(2)` syscall every line | Yes — use `'\n'` |
| `sync_with_stdio` | Pre-C++11 mandated unbuffered `cout` proxying to C `stdout` | Yes — `sync_with_stdio(false)` |

**`std::endl` is the single most common iostream performance bug.** It forces a flush, which on a `filebuf` is a `write` syscall (~1–2 µs with modern spectre mitigations, more under seccomp). A logging loop that writes a million lines with `endl` makes a million syscalls; with `'\n'` it makes a few thousand.

**`std::ios_base::sync_with_stdio(false)`** decouples `cin`/`cout` from C `stdio`. By default the standard requires the C++ streams and C streams to be interleavable, which most implementations achieve by making `cout` an unbuffered wrapper over `stdout` — every insertion goes through `fputc`. Turning sync off gives `cout` its own buffer and typically yields a 2–10× throughput improvement. The cost: you may no longer mix `printf` and `cout`. Also untie `cin` from `cout` with `std::cin.tie(nullptr)` — otherwise every read flushes `cout` (the `sentry` does this).

### State handling

Streams report errors via `iostate` bits, not exceptions, by default. `failbit` means a formatting/extraction failure with the stream still usable; `badbit` means the underlying transport broke. `stream.exceptions(std::ios::badbit)` enables throwing. `operator bool` tests `!fail()` — so `while (in >> x)` is correct, but `while (!in.eof())` is the classic off-by-one bug: `eofbit` is set *after* the failed read, so the loop body runs once with an unmodified `x`. Since C++11, a failed extraction also zero-initializes the target (previously it was left alone), which changes the symptom but not the bug.

### Sticky formatting flags

```cpp
std::cout << std::hex << 255 << " " << 16;   // "ff 10" — hex is STICKY
std::cout << std::setw(8) << x << y;         // width applies only to x — width is NOT sticky
```
Width is reset after every formatted insertion; everything else (`hex`, `precision`, `fill`, `boolalpha`) persists, including across function boundaries. This makes iostreams non-composable: a library that sets `hex` corrupts your output. `std::ios_base` flag save/restore (Boost's `io_state_saver`) is the manual fix; `std::format` avoids the problem entirely by having no global state.

**Low-latency verdict:** iostreams are acceptable for startup, config dumps, and diagnostics off the hot path. They are disqualified from a tick-to-trade path by their locale dependence, virtual dispatch, allocation, and — decisively — the syscall on flush. See §16.5 for what replaces them.

---

## 16.2 C stdio

`<cstdio>` is the C library's buffered I/O: a `FILE*` holding a buffer, a position, an error/EOF flag, and — on POSIX-conforming implementations — **a lock**.

### Buffering modes

| Mode | Set by | Flush trigger | Default for |
|---|---|---|---|
| Fully buffered (`_IOFBF`) | `setvbuf` | Buffer full, `fflush`, `exit` | Files, and pipes/redirected stdout |
| Line buffered (`_IOLBF`) | `setvbuf` | `'\n'`, buffer full | `stdout` **when it is a terminal** |
| Unbuffered (`_IONBF`) | `setvbuf` | Every write | `stderr` |

The terminal-dependence is the source of a perennial bug: a program whose output looks correctly interleaved on a console produces scrambled or truncated output when redirected to a file, because `stdout` silently switched from line-buffered to fully-buffered while `stderr` stayed unbuffered. Worse, a crash (`abort`, `SIGSEGV`) loses the buffered contents entirely — which is exactly when you wanted the log. Fixes: `setvbuf(stdout, nullptr, _IOLBF, size)` explicitly, or write diagnostics to `stderr`, or install a crash handler that flushes (bearing in mind `fflush` is **not async-signal-safe**; Ch. 33 covers the signal-safety constraint properly).

`setvbuf` must be called after the stream is opened and **before any I/O on it**; calling it later is undefined.

### Thread safety and the `_unlocked` family

POSIX requires `FILE*` operations to be atomic with respect to each other, implemented with a per-`FILE` recursive lock. Every `putc`/`fwrite` therefore takes and releases a lock — usually uncontended, so a few nanoseconds, but not free, and a genuine scalability limit when multiple threads log to the same `FILE*`.

```cpp
flockfile(stdout);
for (auto c : s) putc_unlocked(c, stdout);   // no per-char lock
funlockfile(stdout);
```
`getc_unlocked`/`putc_unlocked` are POSIX; `fwrite_unlocked`/`fputs_unlocked` are GNU extensions. This is the standard trick for competitive-programming-grade I/O throughput and occasionally appears in interviews as "how would you speed up character-at-a-time input."

### `printf` mechanics and cost

`printf` is a C variadic function (Ch. 4 §4.15), so:
- Arguments undergo **default argument promotions**: `float`→`double`, small integers→`int`. This is why `%f` handles both `float` and `double`, and why passing a `short` for `%hd` still works.
- There is **no type checking** in the language. GCC/Clang recover it with `__attribute__((format(printf, m, n)))` and `-Wformat`, `-Wformat-security`. Applying that attribute to your own logging wrappers is a strong practice signal.
- Passing a `std::string` where `%s` is expected, or a `size_t` to `%d`, is UB. `-Wformat` catches both.
- The format string is **parsed at runtime**, character by character, with a state machine and a conversion dispatch. A single `printf("%d\n", x)` on glibc runs hundreds of instructions before touching the buffer.
- A **non-literal format string** derived from user input is the classic format-string vulnerability (`%n` writes to memory).

### stdio vs iostreams

| | `printf` | `operator<<` |
|---|---|---|
| Type safety | None (attribute-recovered) | Full, via overloads |
| Extensible to user types | No | Yes (`operator<<`) |
| Argument reordering / i18n | `%1$s` (POSIX) | No |
| Cost | Runtime format parse + lock | Virtual dispatch + locale facet + sentry |
| Global state | Locale only | Locale + sticky stream flags |
| Binary size | Small | Large (heavy templates, static init) |

Neither wins decisively; `std::format` supersedes both (§16.3). Note that including `<iostream>` pulls in a **static initializer** (`std::ios_base::Init`) that constructs the standard streams in every TU, which is measurable startup cost and a static-initialization-order concern (Ch. 5 §5.10).

---

## 16.3 `std::format` and `std::print`

C++20's `<format>` (P0645, based on `fmtlib`) is a type-safe, extensible, locale-independent-by-default, compile-time-checked formatting facility. C++23 adds `<print>` (`std::print`/`std::println`) which formats directly to a `FILE*` without constructing a `std::string`.

```cpp
std::string s = std::format("{} filled {:.2f} @ {:>8}", id, qty, px);  // C++20
std::print("{} filled {:.2f}\n", id, qty);                            // C++23
std::println("qty={}", qty);                                          // adds '\n'
```

### Compile-time format-string checking

In C++20 as amended by P2216, the format string is a `std::format_string<Args...>` — a consteval-constructed wrapper that *parses the string at compile time* against the argument types. A mismatched `{:d}` on a `std::string` is a **compile error**, not UB or an exception. That is the single biggest correctness argument over `printf`.

A runtime format string (from a config file) requires the opt-in `std::runtime_format` (C++26) or `std::vformat` with `std::make_format_args`:

```cpp
std::string fmt = load_from_config();
std::string out = std::vformat(fmt, std::make_format_args(a, b));  // throws format_error on mismatch
```

### The type-erasure design and why it matters for code size

`std::format` does **not** instantiate the whole formatting machinery per argument-type combination. It packs arguments into a `std::format_args` — a type-erased array of (type tag, value/pointer) pairs — and calls a single non-template `vformat`. Small built-in types are stored inline; user types are stored as a `void*` plus a function pointer to a formatting thunk. The template surface per call site is therefore tiny (just the packing), and the heavy parsing/formatting code exists once in the binary. This is a deliberate answer to `iostream`'s and naive-variadic-template's code bloat (Ch. 17 §17.22), and it is exactly the kind of design detail interviewers use to separate users from readers of the library.

### `format_to` and `format_to_n` — the allocation-free path

`std::format` returns a `std::string`, which allocates for anything beyond SSO (Ch. 13 §13.2). The output-iterator forms do not:

```cpp
char buf[128];
auto res = std::format_to_n(buf, sizeof buf, "{},{},{}\n", a, b, c);
// res.out = one past last written; res.size = chars that WOULD have been written
std::string_view line{buf, static_cast<size_t>(res.out - buf)};
```
`format_to_n` truncates safely and reports the untruncated length — the correct primitive for a fixed-size log record. `std::formatted_size(fmt, args...)` computes the length without writing, for exact preallocation. Use `std::back_inserter(existing_string)` to append without a fresh allocation when you already reserved.

### Custom formatters

```cpp
template <> struct std::formatter<Price> {
    constexpr auto parse(std::format_parse_context& ctx) { return ctx.begin(); }
    auto format(Price p, std::format_context& ctx) const {
        return std::format_to(ctx.out(), "{}.{:02}", p.ticks / 100, p.ticks % 100);
    }
};
```
`parse` runs at compile time when the format string is a literal, so a bad spec for your own type is a compile error too. Deriving from `std::formatter<std::string_view>` and delegating is the cheap way to inherit alignment/width handling. C++23 requires `format` to be `const`-qualified.

### Standard version map

| Feature | Version |
|---|---|
| `std::format`, `format_to`, `formatted_size`, `vformat` | C++20 |
| Compile-time checked format strings (P2216) | C++20 (as amended, retroactive) |
| Formatting ranges, tuples, pairs (`"{}"` on a `vector`) | C++23 |
| `std::print`, `std::println`, `std::print(FILE*, …)` | C++23 |
| `std::formatter` for `std::thread::id`, `stacktrace` | C++23 |
| `std::runtime_format`, formatting `std::filesystem::path` | C++26 |

`std::print` on a terminal writes via the native Unicode path on Windows (fixing the historic UTF-8 console problem); on POSIX it is `fwrite` to the `FILE*`, so it interleaves correctly with `printf` and respects the same buffering.

### Performance

`std::format` uses **Grisu/Ryu-derived shortest-round-trip float formatting** (via `to_chars`, §16.4 note) and does no locale lookup unless you write `{:L}`. Measured against `printf` it is typically comparable or faster for integers and substantially faster for floats; against `ostringstream` it is 2–10× faster and allocates far less. Against `std::to_chars` it is slower — `to_chars` remains the floor for pure number→text (Ch. 13 §13.6).

---

## 16.4 Locale Costs

A **locale** is a set of **facets** — polymorphic objects encapsulating culture-dependent behavior: `num_put`/`num_get` (number formatting), `numpunct` (decimal point, thousands separator, grouping), `collate` (string ordering), `ctype` (character classification), `moneypunct`, `time_put`.

### Why locales are expensive

1. **Virtual dispatch per operation.** `os << 42` does `use_facet<num_put<char>>(os.getloc()).put(...)`, an indirect call into the facet, which formats via yet more indirection.
2. **`use_facet` is a lookup.** It indexes the locale's facet vector by a static facet id — cheap in isolation, but on top of everything else it is another dependent load.
3. **Locale objects are reference-counted and shared.** Copying a `std::locale` touches an atomic refcount.
4. **The C locale functions (`setlocale`, `localeconv`) are process-global and not thread-safe** in general. `setlocale` from one thread while another formats is a data race. POSIX `uselocale` + `newlocale` gives per-thread locales; glibc's `strtod_l`/`snprintf_l` family takes an explicit `locale_t`.
5. **`std::isalpha`/`std::tolower` from `<cctype>` consult the global C locale.** In a character-classification loop this is a function call plus a table lookup that the compiler cannot inline or fold. Hand-rolled `c >= '0' && c <= '9'` or a 256-byte lookup table is dramatically faster and, critically, *deterministic*.

### The correctness hazards

The classic production incident: a process running under a European locale where `LC_NUMERIC` sets the decimal separator to `,`. Then:

```cpp
double d = 3.14;
printf("%f", d);          // prints "3,140000"
strtod("3.14", nullptr);  // parses as 3.0  — silently truncated
```
A price parser or a CSV writer that respects the ambient locale will corrupt data on a machine with a different `LANG`. Related: `std::stod` and `atof` are locale-sensitive; `std::from_chars`/`std::to_chars` are **not** — they are defined to use the C locale's rules always, which is why they are the correct tool for protocol and file parsing (Ch. 13 §13.6).

`std::sort` with `strcoll`-based comparison depends on `LC_COLLATE` and can be non-deterministic across machines — a serious reproducibility problem for a replay system.

### Locale in `std::format`

`std::format` is **locale-independent by default**. Locale-aware formatting is explicitly opt-in per specifier:

```cpp
std::format("{}", 1234567);           // "1234567"           — always
std::format("{:L}", 1234567);         // "1,234,567"         — uses the global locale
std::format(std::locale("de_DE"), "{:L}", 1234.5);  // "1.234,5"
```
This inversion of the default is one of `<format>`'s most important design decisions and a good thing to name explicitly in an interview.

### Practical rules for latency-sensitive code

- Never touch a locale on the hot path. If you must produce grouped output, do it in the reporting tier.
- Use `to_chars`/`from_chars` for all machine-readable numeric conversion; they are locale-immune, allocation-free, non-throwing, and the fastest option available.
- Avoid `<cctype>` in parsers; use explicit range checks or a 256-entry table (which also branchlessly folds into a load).
- If a third-party library calls `setlocale`, you have a process-wide, thread-unsafe mutation. Setting `LC_ALL=C` in the process environment at startup is defensive practice for trading systems.
- Constructing a `std::locale` by name (`std::locale("en_US.UTF-8")`) is genuinely expensive — it may hit the filesystem to load locale data. Never in a loop; never on a hot path; hoist and cache.

---

## 16.5 Asynchronous Logging

The requirement in a low-latency system: the producing thread must spend the minimum possible time — tens of nanoseconds, no allocation, no syscall, no lock, no formatting — and everything else must be moved off the critical path.

### The architecture

```
 hot thread                      background thread
 ─────────                       ─────────────────
 log(fmt_id, args…)
   ├─ rdtsc timestamp   (~20 cyc)
   ├─ serialize raw args into
   │  an SPSC ring slot  (memcpy)      ──►  drain ring
   └─ release-store the sequence            format text (locale, floats)
                                            write(2) / io_uring
                                            fsync policy
```

Everything expensive is deferred: **format at consumption, not at production.** The producer writes a compact binary record — a format-site identifier plus the raw argument bytes — and never converts a number to text. This is the design of **NanoLog**, **Quill**, **Binlog**, and `spdlog`'s async mode (which formats eagerly and is therefore an order of magnitude slower on the producer side, though still far better than synchronous iostreams).

### Design decisions and their trade-offs

| Decision | Options | Trade-off |
|---|---|---|
| Queue | SPSC ring per thread vs one MPSC | Per-thread SPSC avoids all contention and false sharing; costs memory and requires a merge by timestamp at the consumer (Ch. 26 §26.3) |
| Full-queue policy | Block, drop, overwrite | Blocking couples the hot path to disk latency — usually unacceptable. **Drop with a counter** is the standard trading answer: never let logging cause a trading pause, but always account for the drop (Ch. 59 §59.7) |
| Timestamp | `rdtsc` vs `clock_gettime` | `rdtsc`/`rdtscp` is ~20 cycles and needs calibration and monotonic-TSC guarantees; `clock_gettime(CLOCK_MONOTONIC)` via vDSO is ~20–25 ns with no syscall (Ch. 34 §34.4). Convert to wall time offline. |
| Payload | Fully static (format-string id) vs partly dynamic | Static ids need a compile-time registry (`__COUNTER__`/`constexpr` section trick) and an offline dictionary to decode; the log file is then unreadable without the binary's metadata — a real operational cost |
| Strings | Copy vs reference | A `const char*` argument may dangle by the time the consumer formats it. Either restrict to string literals (immortal, so store the pointer) or copy the bytes into the ring. **This is the most common correctness bug in async loggers.** |
| Level check | Runtime branch vs compile-time | A well-predicted `if (level >= threshold)` costs ~1 cycle and keeps the disabled call's argument evaluation elided; mark it `[[unlikely]]` and keep the cold body `noinline` so the hot path's I-cache holds no logging code (Ch. 41 §41.17) |

### Non-obvious details

- **Argument evaluation must be short-circuited.** `LOG_DEBUG("{}", expensive())` must not call `expensive()` when the level is off. A function call cannot do this; the macro must guard the whole expression. This is a legitimate reason macros persist in modern logging libraries.
- **Cache pressure is the hidden cost.** A logging call that touches the ring buffer evicts working-set lines. A large ring reduces drops but worsens cache and TLB behavior; huge-page-backed rings (Ch. 32 §32.10) mitigate the TLB side.
- **The consumer must not block the producer through memory ordering.** The producer does a `store(release)` of the write index; the consumer `load(acquire)`s it. Padding the two indices onto separate cache lines is mandatory or you get false sharing on every single log call (Ch. 26 §26.16).
- **Flush-on-crash.** A signal handler cannot safely call `write` on a partially-committed record, and cannot call `malloc`/`fflush` at all. The standard approach is a **flight recorder**: keep the ring in a `mmap`ed file so the kernel persists it even if the process dies (Ch. 59 §59.13), rather than trying to flush from the handler.
- **Ordering across threads.** With per-thread queues there is no global order. Merging by TSC requires cross-core TSC synchronization (invariant TSC, `constant_tsc`, `nonstop_tsc`) — otherwise the merged log shows causally impossible orderings, which is deeply confusing during an incident (Ch. 35 §35.3).
- **`write(2)` from the consumer** to a file on a busy disk can stall for milliseconds. Because it is off the hot path this is acceptable, but the consumer's queue must be sized for the worst-case stall, and `O_DIRECT` or `io_uring` (Ch. 34 §34.14) can bound it better.

Rough cost ladder for emitting one log line, producer-side:

| Approach | Producer cost |
|---|---|
| `std::cout << … << std::endl` | 1–10 µs (syscall + locale + virtual) |
| `printf` to line-buffered stdout | ~1 µs (format + lock, syscall per line) |
| `spdlog` async (formats eagerly) | 100–300 ns |
| Binary-payload async (NanoLog-style) | 10–30 ns |
| Disabled level check | ~1 cycle |

---

## Key Interview Questions

1. **What are the two layers of an iostream and where is the syscall?** — The stream does formatting and state; the `streambuf` owns the character buffer and issues the syscall from `overflow`/`sync`.
2. **Why is `std::endl` a performance bug?** — It flushes, causing a `write(2)` per line; `'\n'` writes into the buffer instead.
3. **What does `sync_with_stdio(false)` do and what does it cost?** — Gives `cout` its own buffer instead of proxying C `stdout`; you may no longer interleave `printf` with `cout`.
4. **Why is `while (!in.eof())` wrong?** — `eofbit` is set by the failing read, so the body executes once with a stale/zeroed value; test the stream itself.
5. **Which stream formatting manipulators are sticky?** — All of them except `setw`, and stickiness leaks across function boundaries, making iostreams non-composable.
6. **Why does redirecting stdout change output interleaving?** — `stdout` is line-buffered on a terminal and fully buffered on a pipe/file; `stderr` is unbuffered.
7. **How do you make character-at-a-time stdio fast?** — `flockfile` plus `getc_unlocked`/`putc_unlocked`, avoiding the per-`FILE` lock.
8. **What type checking does `printf` have?** — None in the language; only `__attribute__((format))` / `-Wformat`. Arguments undergo default promotions, and a non-literal format string is a security vulnerability.
9. **How is `std::format`'s format string checked?** — `std::format_string` is consteval-parsed against the argument types, so mismatches are compile errors; runtime strings need `vformat` or `std::runtime_format` (C++26).
10. **Why doesn't `std::format` bloat code the way you'd expect from a variadic template?** — Arguments are type-erased into `std::format_args`; only the small packing code is instantiated per call site, and one non-template `vformat` does the work.
11. **How do you format without allocating?** — `std::format_to_n` into a stack buffer (it also reports the untruncated size), or `format_to` with `back_inserter` into a reserved string.
12. **Is `std::format` locale-aware?** — No, by default; locale behavior is opt-in per-specifier with `{:L}`. This is the inverse of iostreams and `printf`.
13. **Name a production bug caused by locales.** — `LC_NUMERIC` making `%f`/`strtod` use `,` as the decimal separator, silently corrupting price parsing; `from_chars`/`to_chars` are immune.
14. **Why avoid `<cctype>` in a parser?** — `isdigit` and friends consult the global C locale: an uninlinable call, a table lookup, and locale-dependent semantics.
15. **Design an async logger for a hot path.** — Per-thread SPSC ring, `rdtsc` timestamp, serialize raw binary arguments (never format), drop-with-counter on full, background thread formats and writes, offline dictionary decodes format-site ids.
16. **Why must an async logger not store a `const char*` argument?** — It may dangle before the consumer formats it; only string literals are safe to store by pointer, everything else must be copied.
17. **Why is a logging macro still necessary in modern C++?** — Only a macro can suppress evaluation of the arguments when the level is disabled.
18. **How do you get a crash-consistent log without flushing from a signal handler?** — Keep the ring in an `mmap`ed file so the kernel persists it; `fflush`/`malloc` are not async-signal-safe.
19. **What breaks when merging per-thread logs by timestamp?** — Without invariant, synchronized TSC across cores the merged order can be causally impossible.

---

## Common Traps

- **`std::endl` in a loop** — a syscall per line.
- **Leaving `sync_with_stdio` on** and wondering why `cin`/`cout` are slow; also forgetting `cin.tie(nullptr)`.
- **`while (!stream.eof())`** — processes the last item twice.
- **Sticky `std::hex`/`precision` leaking** into unrelated output from another function.
- **`setw` assumed sticky** — it applies to exactly one insertion.
- **Buffered stdout lost on crash** — redirected output is fully buffered, so the last few KB vanish exactly when you need them.
- **`setvbuf` called after the first I/O** — undefined.
- **`printf("%d", someSizeT)` / passing `std::string` to `%s`** — UB; only `-Wformat` saves you.
- **User-controlled format string** — `%n` write primitive.
- **`std::format` returning a `std::string`** on a hot path — allocates past SSO; use `format_to_n`.
- **Assuming `{}` groups digits** — it never does; you need `{:L}`.
- **`setlocale` called by a dependency** — process-global, thread-unsafe, and can flip your decimal separator.
- **`std::stod`/`atof` for protocol parsing** — locale-sensitive; use `from_chars`.
- **Constructing `std::locale("…")` inside a loop** — may hit the filesystem.
- **Formatting eagerly in an "async" logger** — the expensive part is still on the producer.
- **Blocking when the log queue is full** — couples trading latency to disk latency; drop and count instead.
- **Unpadded producer/consumer indices** — false sharing on every log call.
- **Storing pointers to non-literal strings in a log record** — dangling by consumption time.
- **`#include <iostream>` in every TU** — drags in `ios_base::Init` static initialization and significant binary size.

---

## Compact Recall Summary

**Iostreams.** Two layers: formatting stream over a `streambuf` with put/get areas and virtual `overflow`/`underflow`/`xsputn`. Costs: `sentry` per insertion, virtual dispatch, `num_put` locale facet lookup, allocation in `ostringstream`, and a syscall on every `std::endl`. Flags are sticky except `setw`, so streams are non-composable. `sync_with_stdio(false)` plus `cin.tie(nullptr)` is the standard speedup. Test the stream, never `eof()`.

**stdio.** `FILE*` buffering is fully-buffered for files, line-buffered for terminals, unbuffered for `stderr` — hence redirection changes interleaving and crashes lose buffered output. POSIX mandates per-`FILE` locking; `getc_unlocked`/`putc_unlocked` under `flockfile` bypass it. `printf` is variadic: default promotions, no language-level type checking (recover it with `__attribute__((format))`), runtime format parsing, and a format-string vulnerability class.

**`std::format` / `std::print`.** C++20/C++23. Format strings are consteval-checked against argument types. Arguments are **type-erased** into `format_args` so a single non-template `vformat` does the work — small code size. `format_to_n` gives allocation-free, truncation-safe output plus the untruncated length; `formatted_size` sizes exactly. Custom `formatter<T>` with `constexpr parse` gets compile-time checking too. C++23 adds range/tuple formatting and `std::print`; C++26 adds `runtime_format`.

**Locales.** Facet-based, virtual, refcounted, and process-global at the C level. `LC_NUMERIC` silently changes decimal separators and breaks `printf("%f")`/`strtod`; `to_chars`/`from_chars` are locale-immune and are the correct machine-readable conversion primitives. `<cctype>` functions are locale-dependent calls — replace with range checks or a table. `std::format` is locale-independent unless you write `{:L}`. Set `LC_ALL=C` defensively.

**Async logging.** Producer does timestamp + binary argument copy into a per-thread SPSC ring and nothing else — no formatting, no allocation, no lock, no syscall (10–30 ns achievable). Consumer formats and writes. Drop-and-count on overflow rather than blocking. Guard with a macro so disabled levels don't evaluate arguments; keep the cold path out of line. Copy or restrict strings to literals to avoid dangling. Pad the ring indices against false sharing. Use an `mmap`ed ring as a flight recorder instead of flushing from a signal handler, and require invariant TSC before merging per-thread logs by timestamp.
