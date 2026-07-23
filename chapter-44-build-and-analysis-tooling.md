# Chapter 44 — Build and Analysis Tooling

## 44.0 Why This Changes the Decision — Core

A warning, sanitizer, analyzer, symbol table, or profile answers only the
question represented by the binary it inspected. If developer and CI builds do
not share declared targets, dependencies, toolchains, and options, “the tool
passed” is weak evidence.

The workflow in this chapter is:

```
pin inputs → configure targets → compile warnings
           → tests under dynamic diagnostics
           → static analysis
           → inspect release binary/ABI
           → profile the real artifact
           → enforce independent CI jobs and preserve provenance
```

Chapter 43 owns benchmark/profiling methodology: workload selection, controls,
statistics, and interpretation. Chapter 44 owns the build and tool catalog:
which artifact to produce, which defect classes a tool observes, and how to
make the evidence repeatable.

### Claim labels

- **[C++23]** is a language/library rule.
- **[CMake]** depends on the stated minimum CMake version and generator.
- **[GCC]**, **[Clang/LLVM]**, or **[MSVC]** is toolchain behavior to verify for
  the pinned version.
- **[Linux/ELF]** is not portable to Mach-O/PE/COFF or another OS.
- **[Tool/version]** means flags, defaults, reports, suppressions, and platform
  support can change.
- **[Measured]** compile time, diagnostic overhead, or runtime effect requires
  the machine, versions, cache state, target graph, workload, and statistic.

---

## 44.1 90-Second Screen — Core

Five facts:

1. Modern CMake is target-based. Sources, include paths, definitions, features,
   libraries, and options attach to targets and propagate through usage
   requirements; global flags create invisible coupling.
2. Warnings, static analyzers, and sanitizers overlap but are not substitutes.
   A clean run proves only that this tool/version observed no enabled finding on
   the exercised code/configuration.
3. Sanitizers change memory layout, timing, code generation, and library
   interactions. Use separate jobs—especially TSan and MSan—and reproduce
   performance on an unsanitized release artifact.
4. Hermetic means inputs are controlled; reproducible means equivalent inputs
   produce equivalent or bit-identical outputs under a declared definition.
   Neither follows merely from using a container.
5. ABI is more than exported names: calling convention, type layout, inline
   code, templates, exception/RTTI mode, standard library, compiler ABI, and
   symbol versions can matter.

Two decisions to defend:

- **Which tool can observe this defect?** State instrumentation/static model,
  exercised path, unsupported boundaries, expected false-positive/negative
  modes, and required build.
- **Which artifact is releasable?** Identify source/dependency/toolchain/config
  provenance, tests/analyses passed, exported ABI, debug-symbol linkage, and
  reproducibility comparison.

---

## 44.2 One Target Graph, Several Artifacts — Core

Consider a library used by an executable and a test:

```
project_options (INTERFACE) ─┬─> order_core ──> gateway
project_warnings (INTERFACE) ┘       └────────> order_core_test

PUBLIC: consumers compile with it
PRIVATE: only this target builds/links with it
INTERFACE: only consumers use it; no compiled artifact
```

### Minimal multi-target CMake project

```cmake
cmake_minimum_required(VERSION 3.25)
project(order_gateway VERSION 1.0 LANGUAGES CXX)

include(CTest)

add_library(project_options INTERFACE)
target_compile_features(project_options INTERFACE cxx_std_23)

add_library(project_warnings INTERFACE)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(project_warnings INTERFACE
    -Wall -Wextra -Wpedantic -Wconversion -Wshadow)
elseif(MSVC)
  target_compile_options(project_warnings INTERFACE /W4)
endif()

add_library(order_core src/book.cpp)
target_include_directories(order_core
  PUBLIC
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
    "$<INSTALL_INTERFACE:include>")
target_link_libraries(order_core
  PUBLIC project_options
  PRIVATE project_warnings)

add_executable(gateway src/main.cpp)
target_link_libraries(gateway PRIVATE order_core project_warnings)

if(BUILD_TESTING)
  add_executable(order_core_test tests/book_test.cpp)
  target_link_libraries(order_core_test PRIVATE order_core project_warnings)
  add_test(NAME order_core_test COMMAND order_core_test)
endif()
```

Version 3.25 is this example project's chosen baseline, not the minimum for
every command shown. Pin and test the actual minimum. Warning names differ
across compiler/version and should not leak into third-party targets.

`project_options` is `PUBLIC` on `order_core` because consumers must compile
with the selected C++ feature requirement. Warnings are `PRIVATE`: this project
does not force its warning policy onto consumers. The executable/test attach
warnings directly for their own sources.

### `PUBLIC`, `PRIVATE`, and `INTERFACE`

For `target_link_libraries(A SCOPE B)`:

| Scope | A consumes B's usage requirements | Consumers inherit B's usage requirements |
|---|---:|---:|
| `PRIVATE` | yes | no |
| `PUBLIC` | yes | yes |
| `INTERFACE` | no | yes |

The same usage-requirement idea applies to include directories, compile
definitions/options, sources, and features. Choose scope from the source/header
contract:

- If a public header includes `<dep/api.hpp>`, consumers need the dependency's
  include path: usually `PUBLIC`.
- If only `book.cpp` includes it: `PRIVATE`.
- If a header-only adapter forwards requirements but has no compiled use:
  `INTERFACE`.

There is a static-library nuance: an archive has no final link step, so CMake can
forward a `PRIVATE` implementation dependency as a link-only requirement of the
eventual executable. That does not expose the dependency's include directories,
compile definitions, or other non-link usage requirements to consumers. Read
the table as an API/usage-requirement rule, not as a promise about every item on
the final linker command.

This is not merely build cleanliness. Incorrect scope can produce a package that
builds in-tree only because another target or global include path masks the
missing transitive requirement.

### Configurations are named policies

`Debug`, `Release`, `RelWithDebInfo`, and `MinSizeRel` are conventional CMake
configuration names. Their actual flags depend on compiler, platform, cache,
toolchain file, and project overrides. Never translate “Release” into a
universal optimization/debug/assertion guarantee.

Single-config generators commonly select `CMAKE_BUILD_TYPE` at configure time.
Multi-config generators select with `cmake --build ... --config <name>`. Prefer
presets/toolchain files that name compiler and cache values:

```bash
cmake -S . -B build/gcc-debug -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_COMPILER=g++
cmake --build build/gcc-debug --parallel
ctest --test-dir build/gcc-debug --output-on-failure
```

Record `cmake --version`, compiler/linker identity, cache, configure command,
generator, and environment. A build directory belongs to one configured
toolchain/policy; do not mutate it across unrelated compilers and trust stale
feature checks.

### Incremental and clean builds

An incremental build is correct only if the graph declares every generated
file, command input/output, include dependency, code-generation tool, and
configuration dependency. Ninja/Make depfiles discover included headers, but
custom commands still need explicit `DEPENDS`, `BYPRODUCTS`, and stable outputs.

A clean build is useful evidence:

- CI from an empty build directory detects undeclared/generated dependencies.
- An incremental-after-header-change test detects missing edges.
- Reconfiguring after dependency/toolchain changes detects stale cache
  assumptions.

“Delete the build directory” is not a fix for an incorrect graph. Find the
missing edge so every developer and remote cache observes it.

### The artifact ladder

One source revision normally yields several intentionally different artifacts.
Give each a separate build directory and a name that describes the evidence it
can provide:

| Artifact | Typical policy | Evidence it provides |
|---|---|---|
| developer debug | low optimization, debug info, assertions | short edit/build/test loop and debuggability |
| warning qualification | two or more pinned compilers, optimized and debug variants | frontend diversity and configuration-sensitive diagnostics |
| ASan+UBSan | instrumentation, symbols, representative optimization | exercised memory-safety and enabled UB checks |
| TSan | thread instrumentation, concurrency tests | exercised happens-before/race observations |
| MSan | instrumented supported userspace | exercised initializedness flow |
| release candidate | deployment optimization, LTO/PGO/hardening as applicable | the actual code to inspect, profile, sign, and ship |

The ladder is not a maturity ranking: an ASan binary is not “almost release.”
It is a different measuring instrument. A result belongs to the tuple

```
(source, dependencies, toolchain, target, configuration, runtime, workload)
```

Changing one element creates new evidence. CI may build several tuples from the
same source, but release approval must ultimately point to one immutable
candidate digest.

Keep configuration choices declarative. A checked-in preset can name generator,
binary directory, toolchain, and cache variables:

```json
{
  "version": 6,
  "configurePresets": [
    {
      "name": "clang-asan",
      "generator": "Ninja",
      "binaryDir": "${sourceDir}/build/clang-asan",
      "cacheVariables": {
        "CMAKE_BUILD_TYPE": "RelWithDebInfo",
        "CMAKE_CXX_COMPILER": "clang++",
        "ENABLE_ASAN_UBSAN": "ON"
      }
    }
  ],
  "buildPresets": [
    { "name": "clang-asan", "configurePreset": "clang-asan" }
  ],
  "testPresets": [
    {
      "name": "clang-asan",
      "configurePreset": "clang-asan",
      "output": { "outputOnFailure": true }
    }
  ]
}
```

This uses the CMake Presets schema understood by the chosen CMake baseline;
schema versions and available fields are versioned. Validate with the pinned
CMake and do not edit a preset-generated cache interactively in CI. Local
developer presets can inherit project presets without becoming release inputs.

### Installation is a consumer test

An in-tree build can conceal broken usage requirements. Add a small downstream
project that uses the installed package from an empty prefix and knows none of
the producer's source-tree paths. It should need only a package lookup and its
own target:

```cmake
find_package(order_core CONFIG REQUIRED)
add_executable(consumer main.cpp)
target_link_libraries(consumer PRIVATE order::core)
```

Build that consumer with every supported compiler/standard-library combination.
This catches missing installed headers, absolute build paths, omitted
transitive requirements, mismatched feature requirements, and packages that
only work because a monorepo supplied global state. If the public API exposes a
dependency type, decide whether the package must locate and propagate that
dependency or whether the API should hide it. The consumer test makes that
contract executable.

---

## 44.3 Warnings and Static Analysis — Core

### Compiler warnings

Warnings are usually low-cost compiler diagnostics integrated with parsing,
instantiation, optimization, and code generation. Some use control/data-flow
analysis, but their scope and path sensitivity vary by diagnostic and compiler.
There is no portable “maximum warnings” list. Start with a reviewed baseline
for each pinned compiler, enable more in stages, and record intentional
suppressions narrowly.

Policy:

1. project-owned code is warning-clean in CI;
2. CI may promote enabled warnings to errors after toolchain pinning;
3. third-party/generated code uses separate targets and `SYSTEM` includes or
   scoped suppression;
4. new compiler versions enter a nonblocking qualification job before becoming
   required;
5. do not silence by broad casts or pragmas that remove the evidence.

High-signal families include suspicious conversions, shadowing, format
mismatch, fallthrough, uninitialized use, missing overrides, and unreachable or
duplicated conditions. Exact names and detection vary by GCC/Clang/MSVC version.
Optimization can enable additional data-flow warnings, so run at least one
optimized warning build.

### Static analyzers

Static analyzers explore paths and model APIs without needing a triggering test:

| Tool family | Inputs | Strength | Blind spot/cost |
|---|---|---|---|
| `clang-tidy` checks | compile command + source | modernize, bug-prone, readability, project rules | check/version/config dependent; many style findings |
| Clang Static Analyzer | translation unit/path model | ownership, null, resource/path bugs | path explosion, cross-TU/model limits |
| GCC `-fanalyzer` | compiler build | path-sensitive diagnostics in GCC workflow | GCC-version coverage/cost |
| `cppcheck` | source/config | independent rule set, portability | needs correct defines/includes; model differs from compiler |
| commercial analyzers | full build/database | deeper cross-TU/security/compliance models | license, setup, triage |

Generate a compilation database:

```bash
cmake -S . -B build/analysis -G Ninja \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build/analysis
clang-tidy -p build/analysis src/book.cpp
```

`compile_commands.json` captures per-translation-unit commands, not necessarily
link/package steps. Pin check sets and analyzer versions. Baseline existing
findings by identity/location if necessary, but fail CI on newly introduced
high-confidence findings. A baseline must be burn-down debt, not permanent
amnesty.

### Make analyzer input faithful

An analyzer invoked with the wrong preprocessor state is analyzing a different
program. Check that the compilation database contains the production defines,
language mode, generated include directories, architecture flags, and response
files. Analyze all important variants when conditionals select materially
different code—Linux versus Windows adapters, exceptions on/off, or alternate
allocators—but do not multiply configurations without a coverage reason.

Prefer machine-readable diagnostics when the tool supports a stable format.
Normalize only volatile fields; retain the original report. A useful finding
record contains:

```
tool + version + check ID
source revision + compilation-command identity
primary location + path/trace
severity/confidence + owner
disposition: fixed | accepted | suppressed | analyzer defect
reason + expiry/review version
```

Triage the program before tuning the tool. Reduce the path, confirm whether its
preconditions are feasible, and write a regression test if execution is
possible. A true report in currently unreachable code may reveal a fragile
invariant, but its release priority differs from an externally reachable
memory-safety defect. A false report should become a minimized analyzer test or
a narrow suppression. Disabling the whole check discards unrelated evidence.

Static analysis also belongs at API boundaries. Annotated ownership/nullability
contracts, RAII types, `[[nodiscard]]`, and constrained interfaces can improve
both compiler diagnostics and human review. An analyzer cannot recover a
contract that the type system and code never express.

### Compiler Explorer

Compiler Explorer is excellent for reducing a language/code-generation question
to one function and comparing compiler versions/options. It does not reproduce
your full headers, LTO, PGO, linker, CPU, allocator, environment, or workload
unless you deliberately mirror them.

Use it to form a hypothesis—“this abstraction still vectorizes,” “this
constructor disappeared,” “this atomic maps to this instruction on this
target”—then verify the real build with saved compiler output, disassembly, and
runtime evidence. Do not paste a result from “latest” and treat it as your
release binary.

---

## 44.4 Sanitizers: Instrumented Evidence — Core

Sanitizers insert compile-time instrumentation and link runtime support. Compile
and link all project code consistently; preserve debug information and a frame
unwinding strategy supported by the toolchain. Exact flags, compatible
combinations, defaults, runtime options, and supported platforms are
version-specific.

### Defect-to-tool map

| Tool | Strong at | Important limits |
|---|---|---|
| AddressSanitizer (ASan) | heap/stack/global out-of-bounds, many use-after-free/scope, invalid free | exercised paths only; custom allocators/assembly/uninstrumented code can hide bugs; layout changes |
| UndefinedBehaviorSanitizer (UBSan) | enabled checks such as signed overflow, bad shift/alignment, invalid downcast/vptr | not every UB is checked; recover/trap behavior and groups vary |
| ThreadSanitizer (TSan) | data races and some synchronization misuse in instrumented execution | large timing/layout effect; unsupported custom synchronization and uninstrumented libraries cause blind spots or misleading reports |
| MemorySanitizer (MSan) | use of uninitialized values and origin tracking | primarily Clang on supported platforms; requires instrumented dependencies/runtime for useful coverage |
| LeakSanitizer (LSan) | unreachable allocations at process-exit checking | reachability is not ownership; platform/integration and intentional globals matter |
| Valgrind Memcheck | binary-translation memory/definedness checks without recompiling all code | platform/ISA support and very large slowdown; execution differs; JIT/syscalls may need support |

No row promises absence of the bug class. A test must execute the path and the
tool must understand every relevant boundary.

### ASan + selected UBSan build

Extend the target graph with an interface target:

```cmake
option(ENABLE_ASAN_UBSAN "Enable supported Clang/GCC sanitizers" OFF)

add_library(project_sanitizers INTERFACE)
if(ENABLE_ASAN_UBSAN)
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(project_sanitizers INTERFACE
      -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(project_sanitizers INTERFACE
      -fsanitize=address,undefined)
  else()
    message(FATAL_ERROR "Qualify sanitizer flags for this compiler")
  endif()
endif()

target_link_libraries(order_core PRIVATE project_sanitizers)
target_link_libraries(gateway PRIVATE project_sanitizers)
target_link_libraries(order_core_test PRIVATE project_sanitizers)
```

This example qualifies one GCC/Clang family; real projects centralize attachment
so no executable misses the runtime. Some UBSan checks or runtimes are
incompatible with particular environments. Verify the selected set and
symbolizer in the pinned image.

Configure and run:

```bash
cmake -S . -B build/asan -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_CXX_COMPILER=clang++ -DENABLE_ASAN_UBSAN=ON
cmake --build build/asan --parallel
ctest --test-dir build/asan --output-on-failure
```

An optimized-with-debug-info sanitizer job often finds different issues from
`Debug`, but optimization can also change reproducibility. Keep both only when
their incremental coverage justifies CI cost.

### TSan is a separate concurrency build

Do not combine TSan with ASan in a generic matrix entry. Instrument all feasible
code, run concurrency stress/scenarios, and keep symbols. TSan reports
happens-before conflicts based on synchronization it recognizes.

“Benign race” is often a misunderstanding: ordinary conflicting non-atomic
access is undefined behavior in C++. But reports can still be caused by
unsupported synchronization primitives, deliberate runtime techniques,
uninstrumented code, annotations, or tool defects. Triage:

1. identify the exact conflicting accesses and object lifetime;
2. draw the C++ happens-before relationship expected;
3. verify both modules are instrumented and the primitive is supported;
4. fix the program if the edge is absent;
5. add the narrow documented annotation/suppression only if a real edge exists
   outside TSan's model;
6. retain a regression test and tool/version justification.

TSan not reporting a race can mean the schedule did not occur, one side was
uninstrumented, or the platform/tool is unsupported.

### MSan and LSan deployment

MSan propagates initialization state. If a system library returns data from
uninstrumented code without an interceptor/initialized annotation, results can
be noisy or incomplete. Serious MSan use typically needs an instrumented
userspace/dependency stack. Make it an explicit supported-platform job, not a
flag casually added to the normal build.

LSan can run integrated with ASan on supported configurations or separately
where available. It finds allocations unreachable at check time, not all
semantic resource leaks. File descriptors, registrations, threads, mappings,
and allocator-retained reachable objects require other checks.

### Probe effects

Instrumented binaries are for correctness discovery. They change:

- object layout/red zones and allocator behavior;
- instruction count, registers, stack, and cache footprint;
- scheduling and race probability;
- memory consumption and process limits;
- signal/error handling and library linkage.

Do not use sanitizer latency as production latency. Reproduce the fixed test on
the release configuration and use Chapter 43's measurement controls.

### Read a sanitizer report as a causal record

Start with the first report from a deterministic run. Later failures may be
secondary corruption. For an ASan lifetime report, preserve:

- error kind, access size, address, and thread;
- stack for the invalid use;
- stack where storage was released or left scope;
- stack where it was allocated;
- exact executable/build ID and matching symbols;
- test seed, inputs, environment, and sanitizer runtime options.

The top frame is not automatically the defect owner. A dereference in a library
may merely expose a pointer invalidated earlier by its caller. Reconstruct
allocation, ownership transfer, invalidation, and use in time order. For UBSan,
record the exact enabled check and whether the runtime was configured to recover
or terminate; repeated recovery can produce cascading diagnostics.

Symbolization is part of the pipeline, not a developer afterthought. Keep file
and line information, ensure the compatible symbolizer is discoverable, and
archive stripped artifact and separate debug file under a shared build
identity. Container paths can differ from source checkout paths, so preserve a
source mapping. Never symbolize an address against a convenient rebuild: even
small link-layout changes can map it to the wrong instruction.

Quarantine policy matters. A failing sanitizer test should preserve the report
and fail its owning job. If an external library forces a suppression, scope it
to the documented library/symbol, explain why upgrading or instrumenting it is
not currently possible, assign an owner, and review it when either tool or
dependency changes. Suppressing by broad source tree or disabling
instrumentation on a hot boundary creates a coverage hole that CI should list.

### Coverage without pretending it is proof

Dynamic diagnostics improve only when the workload reaches relevant states.
Combine ordinary unit/integration tests with:

- regression tests that force the formerly failing capacity, lifetime, or
  scheduling boundary;
- parser/protocol fuzzing with a retained corpus and deterministic crash input;
- allocation-failure and error-path injection;
- concurrency stress with bounded seeds and recorded schedules when possible;
- long-running scenarios that cross cache eviction, reconnect, rotation, or
  shutdown paths.

Code coverage can reveal unexecuted regions, but line/branch coverage is not
sanitizer-semantic coverage. A line that ran may not have exercised the
overflowing size, invalid lifetime, or conflicting schedule. Report coverage as
a navigation aid; pair it with boundary-oriented tests and defect hypotheses.

---

## 44.5 Worked Workflow: Dangling Vector Pointer — Core

This program caches an element pointer, then grows the vector:

```cpp
#include <cstdio>
#include <vector>

struct Order { int price; };

int main() {
    std::vector<Order> orders;
    orders.push_back({100});
    Order* best = &orders.front();

    for (int i = 0; i != 1'000; ++i) {
        orders.push_back({101 + i}); // may reallocate
    }

    std::printf("%d\n", best->price); // use after invalidation
}
```

Reason before choosing tools:

1. `best` points into vector storage.
2. A capacity-changing insertion invalidates pointers/references/iterators.
3. The later dereference has undefined behavior.
4. Whether it appears to work depends on allocator/layout/reuse.

Tool workflow:

1. Compile warnings: likely no diagnostic; the lifetime relation is dynamic.
2. Static analysis: a version/check may find invalidation, but do not rely on it.
3. ASan test: if reallocation frees/poisons the old buffer, it should report a
   heap-use-after-free with allocation/free/use stacks.
4. UBSan is not the primary tool; the invalid address is ASan territory.
5. Valgrind Memcheck is an alternative reproduction when supported, with a
   different execution/probe effect.
6. Inspect the stack against the exact binary/build ID and symbol file.
7. Fix the ownership model: store an index, reacquire the pointer after
   mutation, or use a container/design with the required stability. `reserve`
   is correct only if a proved capacity bound prevents every invalidating
   growth.
8. Add a test that forces capacity growth, run the full sanitizer matrix, then
   test the release artifact.

This is the triage principle: identify the threatened language invariant, use
the tool most able to observe it, and retain a test that makes the path
deterministic.

### Reproduce, minimize, fix, and close

For a standalone Clang build on a supported host, an intentionally compact
reproduction command is:

```bash
clang++ -std=c++23 -O1 -g -Wall -Wextra -Wpedantic \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  dangling.cpp -o dangling
./dangling
```

Both compile and link include `-fsanitize=...`; omitting it from the link step
can omit the runtime. The expected evidence is an ASan heap-use-after-free
report, but exact wording, stack format, default leak behavior, and exit status
belong to the installed Clang/runtime/platform. The example prints the value
rather than using `assert`, because configurations defining `NDEBUG` remove the
assertion—and the invalid read—with it.

Minimize while retaining the ownership sequence. Removing unrelated application
code is useful; replacing the vector with a raw allocation too early can erase
the invalidation mechanism under investigation. Record the vector capacities
or break at the insertion that changes capacity if the full report is not
enough. The causal sequence should remain:

```
allocate vector buffer → take element address → grow/reallocate
                       → free old buffer → dereference stale address
```

An index represents identity relative to the current vector storage without
retaining an address across reallocation:

```cpp
#include <cstddef>
#include <cstdio>
#include <vector>

struct Order { int price; };

int main() {
    std::vector<Order> orders;
    orders.push_back({100});
    const std::size_t best = 0;

    for (int i = 0; i != 1'000; ++i) {
        orders.push_back({101 + i});
    }

    std::printf("%d\n", orders.at(best).price);
}
```

`at` also converts an invalid index into a specified bounds exception rather
than unchecked indexing, but it does not solve concurrent mutation or semantic
removal/reordering. If order identity must survive erase or sort, an index is
the wrong abstraction; use a stable ID and lookup or redesign ownership.

Close the finding only after:

1. the minimized pre-fix test fails under the pinned ASan job;
2. the same test passes with the ownership fix;
3. ordinary and other sanitizer jobs show no regression;
4. the exact release configuration passes the behavioral test;
5. the issue links report, build identity, root cause, fix, and regression test.

That chain is stronger than “ASan is green”: it demonstrates that the tool
observed the intended defect and that a particular change removed the causal
path.

---

## 44.6 Compile-Time Control — Role-specific

Compile-time optimization is graph optimization. Measure clean and incremental
builds separately; do not optimize from impressions.

### Find the cost

| Tool/evidence | Platform/version scope | Question |
|---|---|---|
| Ninja `-d stats`/logs | Ninja | scheduling, command count, critical path clues |
| Clang `-ftime-trace` | Clang/version | headers/templates/frontend time per TU |
| GCC `-ftime-report` | GCC/version | compiler phase totals |
| build-system tracing | generator-specific | why command reran / dependency edge |
| include graph / IWYU | tool/config | expensive/transitive includes |
| compiler cache stats | ccache/sccache version/config | hit/miss and non-cacheable causes |

Measure on declared hardware with cold/warm filesystem and compiler-cache state.
Generated code, LTO, debug info, and link strategy can move the critical path.

### Remedies and trade-offs

- Reduce public/transitive includes; forward-declare only where the language
  permits complete-type deferral.
- Split frequently changed interfaces from heavy stable implementation.
- Reduce repeated template instantiation with explicit instantiation where API
  design allows.
- Parallelize only until CPU, memory, or I/O saturation; swapping is regression.
- Use compiler caches with normalized, trustworthy inputs and cache provenance.
- Separate expensive LTO/codegen from fast developer loops while retaining a
  release-equivalent CI build.
- Use modules/header units only after toolchain/build support is qualified.

### Precompiled headers

A PCH can amortize parsing of large, stable, widely shared headers. It also has a
large invalidation domain, is sensitive to compiler/options/macros, and can hide
poor header boundaries. Apply per target after trace evidence; keep headers
self-contained by compiling header tests without accidental PCH help.

### Unity/jumbo builds

Unity builds combine several `.cpp` files into fewer translation units. They can
reduce repeated parsing and expose more optimization, but may:

- collide anonymous-namespace/static names or macros;
- hide missing direct includes and ODR problems;
- enlarge compiler memory spikes;
- make one edit rebuild a large unity batch;
- differ semantically from ordinary translation-unit boundaries in broken code.

Keep at least one non-unity clean CI build. Tune batch size from measured memory
and incremental behavior rather than enabling one monolithic unit.

### PIMPL

PIMPL moves private representation behind an incomplete type, reducing rebuilds
and insulating some layout changes:

```cpp
// engine.hpp
#include <memory>

class Engine {
public:
    Engine();
    ~Engine();                 // defined where Impl is complete
    Engine(Engine&&) noexcept;
    Engine& operator=(Engine&&) noexcept;
private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
```

It can add allocation, pointer indirection, ownership code, and inhibit
inlining/locality. A stable pointer-sized public object helps ABI management but
does not guarantee ABI compatibility: member functions, exception behavior,
vtable, inline definitions, compiler/standard-library ABI, and ownership
contracts still matter. Use PIMPL at change/ABI boundaries, not mechanically in
hot types.

---

## 44.7 Reproducible, Hermetic, and Provenanced Builds — Core

Definitions:

- **Hermetic build:** declared inputs are isolated/controlled; undeclared host
  tools, headers, network, locale, and environment cannot silently affect it.
- **Reproducible build:** a stated rebuild procedure produces outputs considered
  identical under a declared comparison, often byte-for-byte.
- **Provenance:** signed/attested metadata identifies source, dependencies,
  toolchain, configuration, builder, and produced artifact.

A container helps pin userspace but does not automatically pin its mutable tag,
kernel-dependent behavior, downloaded dependencies, time, CPU-target flags, or
remote services.

### Sources of nondeterminism

| Input | Control |
|---|---|
| source path embedded in debug/info/macros | compiler prefix-map options qualified by version |
| timestamps/date/time macros/archive metadata | `SOURCE_DATE_EPOCH` and deterministic archive/tool modes where supported |
| directory/glob iteration or parallel race | sort inputs; declare outputs/dependencies |
| locale/timezone/environment | fixed allowlist |
| compiler/linker/build-id | content-addressed pinned toolchain and documented link policy |
| generated files/network fetch | hash-pinned offline cache/vendor source |
| CPU auto-detection | explicit deployment target; avoid builder-dependent `-march=native` |
| dependency resolver | lockfile/exact commit + content hash + repository identity |

Flags such as prefix maps and deterministic archives are compiler/binutils
version behavior, not C++ guarantees. Compare two builds in separate absolute
paths/builders, then use `diffoscope` or binary-section tools to localize
differences.

### Dependency pinning

Pin more than a version string:

- exact source digest/commit and authenticated origin;
- transitive dependency resolution/lock;
- patches and build options/features;
- compiler, standard library, linker, CMake, generator, code generators;
- target architecture/baseline, sysroot/SDK;
- licenses and SBOM identity;
- vulnerability/upgrade policy.

Vendoring improves availability/control but transfers update responsibility.
Fetching at configure time weakens offline hermeticity unless content hashes and
mirrors are controlled. Never follow an unpinned branch/tag in a release build.

### Artifact provenance

For each release store:

```
source commit + dirty state
dependency lock/digests + patches
toolchain/sysroot/container digest
CMake preset/cache + compile/link commands
tests/analyzers/sanitizer job results
artifact digest + build ID + separate debug-symbol digest
exported ABI report + SBOM + signer/attestation
```

This supports rollback and postmortem symbolization. Embedding all metadata into
the binary can itself hurt bit reproducibility; an external manifest keyed by
artifact digest avoids that cycle.

### A two-build reproducibility check

Define equality before automating it. Byte-for-byte identity is the strongest
simple rule, but some ecosystems deliberately compare normalized packages or
selected sections. Write down excluded fields and why they cannot affect
execution, identity, signing, or symbolization.

A useful experiment performs two clean builds:

1. use the same source/dependency/toolchain digests;
2. choose distinct absolute checkout and build paths;
3. isolate each from user configuration and undeclared caches;
4. set the declared locale, timezone, epoch, umask, and target CPU;
5. prohibit network access after inputs are staged;
6. build with recorded commands;
7. compare artifacts and manifests by cryptographic digest;
8. if different, inspect archive members, ELF sections, strings, DWARF paths,
   symbol ordering, and generated files before changing flags.

The first differing byte is a clue, not necessarily the cause. A timestamp in a
generated header can perturb preprocessing, object contents, link order, build
ID, compression, and package digest. Work upstream from the earliest semantic
input difference.

Remote caches require the same discipline. A cache key must cover every input
that affects output: compiler executable and plugins, command line, environment,
headers/modules, generated files, working-directory normalization, and sometimes
system headers or sysroot identity. A high hit rate is not evidence of
correctness. Poisoned or cross-tenant cache entries are a supply-chain concern;
authenticate results or rebuild samples independently.

### Reproducibility and release signing

Signing normally changes the package or creates a detached signature, so define
which unsigned content is reproducible and when signing occurs. A robust
release flow is:

```
build candidate → test/analyze/inspect candidate digest
                → reproduce unsigned digest independently
                → sign/attest that digest
                → package without rebuilding
                → verify package references the approved digest
```

If platform signing necessarily rewrites an executable, preserve and attest the
pre-sign and post-sign identities and verify the transformation. Reproducibility
does not establish that inputs were benign; provenance does not establish that
the output is reproducible. They answer complementary questions.

---

## 44.8 Binary and ABI Inspection — Core

Build success does not prove the intended binary was linked. On Linux/ELF:

```bash
file build/release/gateway
readelf -h -l -d -n build/release/gateway
readelf --dyn-syms --wide build/release/gateway
nm -C --defined-only build/release/liborder_core.so
objdump -drwC build/release/gateway
```

Use LLVM equivalents where appropriate. Output/options vary by version and
binary format. Avoid running untrusted artifacts merely to inspect them;
`readelf` examines metadata without dynamic loading. `ldd` has platform/security
caveats, so prefer dynamic-section/interpreter inspection for unknown binaries.

Questions:

- Is architecture/endianness/interpreter/RPATH/RUNPATH correct?
- Which shared objects and symbol versions are required?
- Are intended symbols exported and unintended internals hidden?
- Are hardening, debug link/build ID, and unwind sections present as policy
  requires?
- Did sanitizer/LTO/PGO flags accidentally enter or disappear?
- Does disassembly correspond to the source/optimization claim?

### ABI compatibility

Source compatibility is not binary compatibility. Changes that may break a C++
ABI include:

- object size/alignment/member/base/vtable layout;
- function signature, calling convention, exception specification where ABI
  relevant, mangled name, visibility;
- removing/changing exported data or symbols;
- inline/template behavior compiled into consumers;
- allocator/ownership or standard-library type across boundary;
- compiler ABI switches, RTTI/exceptions, packing, sanitizers;
- required library/symbol versions.

Header-only code avoids a shared-library call boundary but does not eliminate
ABI/ODR/version skew: consumers embed template/inline definitions and layouts.

Use exported-symbol allowlists plus ABI tools such as `libabigail`'s
`abidw`/`abidiff` on the exact supported platform. Debug information improves
type comparison. Tool output needs policy: private/local changes may be harmless;
semantic changes can be harmful without an ABI diff.

Build an ABI check around a released baseline rather than a developer's current
working tree:

```bash
abidw --out-file abi/current.xml build/release/liborder_core.so
abidiff abi/released.xml abi/current.xml
```

Options, supported debug formats, suppression behavior, and exit-code meaning
are libabigail-version specific. Store the baseline beside the release
manifest, run the comparison on the same platform/architecture ABI, and retain
the full report. A symbol-only fallback can miss changes to reachable type
layout; matching debug information permits deeper comparison.

Classify changes:

- **compatible extension:** for example, a genuinely new exported function
  that does not disturb an existing contract;
- **potentially compatible but review-required:** the tool reports a type or
  symbol detail whose exposure depends on public headers and supported use;
- **incompatible:** a removed required symbol, changed calling
  convention/layout, vtable disruption, or changed required dependency ABI;
- **semantic-only:** binary call shape remains compatible but meaning,
  preconditions, ownership, exceptions, or threading contract changed.

ABI automation is strongest when public surface is deliberate. Hide internal
symbols by default, explicitly export supported entry points, avoid exposing
standard-library implementation types across long-lived independently upgraded
boundaries, and version the semantic contract. Do not suppress a reported
change merely because a smoke-test consumer still starts; it may not instantiate
or exercise the affected layout.

**[Linux/ELF] Symbol versioning** can preserve multiple symbol contracts using
a linker version script and compatible implementation:

```text
ORDER_CORE_1.0 {
  global: order_core_*;
  local: *;
};
```

This controls symbol namespace/version nodes; it does not make incompatible
object layout or semantics safe. Treat exported C++ classes carefully; a narrow
C ABI or opaque handle often makes long-lived plugin/process boundaries easier.

---

## 44.9 Profiling Tool Catalog — Reference

Use Chapter 43 to design and interpret the experiment. This catalog only maps a
question to an artifact/tool:

| Question | Candidate tools | Required caution |
|---|---|---|
| aggregate CPU/PMU counts | Linux `perf stat`, vendor PMU tools, LIKWID/PCM | event availability, multiplexing, privilege, topology, counter meaning |
| where on-CPU time samples land | `perf record/report/annotate`, VTune, sampling profiler | symbols/unwind, skid, frequency, sample bias |
| call-shape visualization | folded stacks/flame graph | width is samples, not causal latency; unwind quality |
| simulated instruction/cache behavior | Valgrind Cachegrind/Callgrind | simulation/model and huge probe effect |
| allocation volume/stacks | heaptrack, allocator profiler, ASan hooks where suitable | allocator replacement/sampling changes behavior |
| lock contention | `perf lock`, mutex instrumentation, eBPF/tooling | supported lock types, instrumentation effect |
| off-CPU/blocking stacks | scheduler trace/eBPF off-CPU tools | clock/symbols, event loss, privilege |
| binary code generation | Compiler Explorer, `objdump`, LLVM tools | compile flags/LTO/PGO and real binary |

Sampling observes periodic/event-triggered state with lower event volume but
can miss rare paths and suffer skid/bias. Instrumentation records chosen events
more directly but changes every instrumented path. Hardware counters count
microarchitectural events whose names/semantics vary by CPU; multiplexing scales
time-shared counters and increases uncertainty.

Do not reproduce a profiler tutorial here. Store exact commands, tool versions,
kernel permissions, event schedule, symbols/build ID, lost-event/multiplexing
statistics, and the profile's target artifact.

---

## 44.10 Executable CI Matrix — Core

Independent jobs avoid incompatible tools and make failure ownership clear:

| Job | Artifact/purpose | Required result |
|---|---|---|
| GCC debug warnings | independent frontend + unit/integration tests | warning-clean, tests pass |
| Clang release-with-debug | optimized tests and release-like codegen | tests pass, binary inspected |
| Clang ASan+UBSan | memory + enabled UB checks | exercised suite clean |
| Clang TSan | concurrency scenarios | reports triaged; no unjustified suppression |
| Clang MSan (supported image) | initializedness with instrumented deps | suite clean |
| static analysis | pinned `clang-tidy`/analyzer set | no new gated findings |
| clean/incremental graph | empty build + targeted header/generated change | correct commands rebuild |
| ABI/reproducibility | supported shared API + double build | policy-compatible ABI; declared output equality |

Representative commands:

```bash
set -eu
cmake --preset "${PRESET}"
cmake --build --preset "${PRESET}" --parallel
ctest --preset "${PRESET}"
```

Here `PRESET` is selected from reviewed, checked-in presets by a trusted matrix;
do not construct cache arguments from an untrusted free-form string. Use
immutable toolchain images. Archive test XML/logs, sanitizer reports,
compile commands, binary/build ID/debug symbols, ABI diff, SBOM, provenance, and
artifact digest as appropriate.

Gating policy:

- required jobs use pinned versions and fail deterministically;
- qualification jobs test upcoming compiler/analyzer versions without blocking;
- flaky tests are defects with owners/data, not indefinite retries;
- suppressions include tool/version, reason, scope, owner, and expiry/review;
- time or overhead budgets are measured on named runners and revised from data;
- release requires the exact candidate artifact, not a separately rebuilt copy.

### Failure routing and evidence retention

Make the CI result tell the next engineer where to start:

| Failure | First owner/evidence | First response |
|---|---|---|
| compile/warning | target + compiler/version + complete command | reduce diagnostic; confirm policy and source ownership |
| analyzer | check ID + path trace + compile-command hash | establish feasible path; test, fix, or narrow disposition |
| ASan/UBSan/MSan | first report + matching symbols + seed/input | reconstruct lifetime/value operation and minimize |
| TSan | both access stacks + thread creation + expected synchronization | draw happens-before; verify instrumentation/model |
| test timeout/flaky | test seed, timing, runner load, prior attempts | preserve data; isolate nondeterminism rather than retry to green |
| ABI | baseline/current artifacts + headers/debug info + tool report | classify public exposure and compatibility policy |
| reproducibility | both manifests/digests + structured binary diff | find earliest differing declared/undeclared input |
| package mismatch | approved and packaged digests + signing log | stop release; locate rebuild/transformation boundary |

Logs are evidence only if they survive the failed job. Upload them in a final
step whose execution does not turn a failing analysis into success. Apply
retention based on investigation and release needs, remove secrets and
user-controlled terminal escapes, and restrict access to sensitive crash inputs.

Order gates so cheap structural failures stop waste while independent useful
jobs still run. Formatting/configuration checks may precede builds; compile and
unit tests fan out by compiler; sanitizer and analyzer jobs consume their own
artifacts; ABI, binary inspection, reproduction, and packaging operate on the
release candidate. Do not make the static-analysis job reuse an ASan compilation
database if that changes preprocessor conditions from the intended analysis
configuration.

### Qualification without surprise

Pinned tools must still be upgraded. Run a scheduled, nonblocking qualification
matrix for upcoming compiler, standard library, CMake, analyzer, sanitizer
runtime, linker, and SDK versions. Compare:

- new warnings/check IDs and removed or renamed options;
- sanitizer platform support, runtime defaults, and suppression behavior;
- generated code, exported symbols, dependency requirements, and binary size;
- clean/incremental build time and peak memory on named runners;
- test results and reproducibility behavior.

Promote a qualified set through a reviewed change that updates pins,
suppressions/baselines, and provenance together. “Latest” is useful for early
warning, not a reproducible release input.

---

## 44.11 Common Traps — Core

- Putting include paths/definitions/options in global CMake variables, then
  mistaking accidental target coupling for declared dependencies.
- Assuming CMake configuration names imply universal compiler flags.
- Fixing stale incremental builds by routinely deleting `build/` instead of
  declaring the missing dependency.
- Enabling `-Werror` for unpinned new compilers or third-party headers and
  turning upgrades into unrelated emergencies.
- Treating no warnings, analyzer findings, or sanitizer reports as proof of
  correctness.
- Combining incompatible sanitizers or leaving one executable/library
  uninstrumented without documenting the blind spot.
- Calling every TSan report real without checking unsupported synchronization,
  or calling every race benign without drawing happens-before.
- Using MSan with an uninstrumented dependency stack and trusting noisy/partial
  results.
- Benchmarking sanitizer, Valgrind, traced, unity, or PCH artifacts as if they
  were the release binary.
- Using a unity build/PCH to hide missing includes and never testing normal
  translation units.
- Claiming PIMPL/header-only design guarantees ABI stability.
- Pinning direct dependencies but allowing mutable transitive downloads,
  compiler images, or sysroots.
- Comparing stripped binaries without accounting for build IDs/debug sections,
  then declaring a reproducibility failure or success.
- Reading a flame graph as elapsed critical-path latency rather than sampled
  on-CPU stack frequency.
- Rebuilding after approval instead of releasing the digest-qualified candidate.

---

## Recall Card — Core

- Model CMake with targets and usage requirements; use `PUBLIC`, `PRIVATE`, and
  `INTERFACE` from the header/consumer contract.
- A clean build tests graph completeness; an incremental build tests dependency
  edges. Deleting the directory does not repair the graph.
- Warnings, static analysis, and dynamic sanitizers cover different defects and
  all have version/model/path blind spots.
- ASan/UBSan, TSan, and MSan generally deserve separate qualified jobs; MSan
  needs an instrumented dependency world for useful results.
- Instrumentation changes timing/layout. Diagnose correctness there, then
  validate behavior/performance on the exact release artifact.
- PCH, unity, caching, explicit instantiation, and PIMPL trade build time against
  invalidation, hidden coupling, memory, runtime, or design complexity.
- Hermeticity controls inputs; reproducibility compares outputs; provenance
  explains who built which digest from what.
- Inspect symbols/dependencies/disassembly and enforce ABI/reproducibility before
  release; a successful link is not binary qualification.

## Questions — Core

1. Given a library whose public header mentions a dependency type, derive the
   correct CMake scope and explain the installed-package failure from `PRIVATE`.
2. A generated header changes but Ninja rebuilds nothing. Which graph edges and
   custom-command properties do you inspect before doing a clean build?
3. Why can optimized warning builds find issues absent from Debug, and why is a
   warning set/version not portable policy?
4. Choose ASan, UBSan, TSan, MSan, LSan, or Memcheck for five defects. For each,
   name one blind spot that could produce a clean run.
5. TSan reports a race around a custom userspace lock. What evidence separates a
   real missing happens-before edge from unsupported synchronization?
6. A PCH halves clean build time but worsens incremental time. What traces and
   invalidation experiment decide whether to keep it?
7. Two container builds differ byte-for-byte. List undeclared inputs a container
   tag did not control and the tools that localize the difference.
8. A shared library's exported symbol names are unchanged. Which C++ ABI changes
   can still break existing consumers?
9. When would sampling, instrumentation, PMU counters, allocation profiling, or
   off-CPU tracing answer different questions about the same latency incident?
10. Design a CI matrix that catches the dangling-vector defect, a data race, an
    undeclared generated dependency, and an ABI break without combining
    incompatible tools.

## Applied Exercise and Puzzle — Core

Create the minimal project in §44.2 with checked-in presets for GCC debug, Clang
release-with-debug, ASan+UBSan, and TSan. Add:

1. the dangling-vector test from §44.5 and a fixed index-based implementation;
2. one deliberate data race exercised by a bounded stress test, then fix it with
   a documented C++ happens-before edge;
3. a generated header whose custom-command dependency is initially missing;
4. an exported shared-library API and an ABI baseline;
5. two clean builds in different absolute paths with a diff report;
6. CI artifacts containing compile database, reports, build IDs, symbols/debug
   link, SBOM, and provenance.

Validate every command against pinned CMake/compiler/analyzer versions and the
target platform. Record unsupported sanitizer jobs explicitly rather than
silently skipping them.

**Puzzle:** all sanitizer and analyzer jobs pass, but the released service
crashes and its core file cannot be symbolized. CI tested a rebuilt artifact
while packaging stripped another binary without preserving its build-ID-matched
debug file. Explain why more sanitizer coverage would not fix this evidence
chain, then redesign CI so tests, inspection, signing, packaging, and
symbolization all refer to one immutable digest.

## Prerequisites for Chapter 45 — Core

Chapter 45 assumes you can build and test small Linux C++23 programs with strict
warnings and sanitizers, inspect a failing binary, and preserve exact toolchain
provenance. Socket semantics begin there; benchmark methodology remains in
Chapter 43.
