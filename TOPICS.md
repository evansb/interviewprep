# The Low-Latency C++ Interview Bible — Page Inventory

> Canonical, deduplicated, fundamentals-first page structure for the MkDocs site.
> Each linked leaf is one planned content page; grouping pages are navigational only.

## Authoring Guide

Use the following as the standing prompt when writing or revising a chapter from
this inventory.

### Mission and scope

Write a fast-paced interview-preparation chapter for an experienced programmer
targeting low-latency C++ roles. The chapter is a handbook, not an exhaustive
language reference or a beginner tutorial. Optimize for concepts that help a
candidate explain a mechanism, predict behavior, diagnose a failure, estimate a
cost, or defend an engineering trade-off in an interview.

- Assume the reader can already write ordinary C++. Briefly define specialist
  language, operating-system, hardware, networking, and market-structure terms
  when they first appear.
- Cover standard C++ only through C++23. Do not teach C++26 drafts or proposals
  as available language features. Clearly label compiler extensions,
  platform-specific APIs, and implementation behavior.
- Give correctness and the abstract-machine rules before optimization advice.
  Explicitly distinguish a standard guarantee from common compiler, ABI,
  operating-system, or microarchitecture behavior.
- Prioritize the topic inventory for the chapter. Cross-reference another
  chapter instead of repeating its full explanation.
- Prefer durable mental models and decision procedures over trivia, historical
  surveys, or long lists of facts to memorize.

### Reading-time and length budget

The finished chapter must support two reading modes: a candidate should be able
to skim it in at most one hour and study it carefully, including examples and
questions, in at most two hours.

- Target **7,000–10,000 rendered words per chapter**, including code, tables,
  captions, questions, and summaries. A narrow chapter may be **4,000–7,000
  words**. Treat **12,000 words as a ceiling**, not a target.
- Spend roughly the first **60–70%** of the chapter on the interview-critical
  core. Put role-specific detail, deep dives, and reference material after it
  and label those sections so a skimming reader can skip them safely.
- Keep most major sections to a **5–10 minute deep read**. Break up any section
  that exceeds about 1,000 words or tries to teach more than one mental model.
- Keep examples small enough to understand at a glance—normally 10–30 lines
  and rarely more than 40. Remove setup that does not teach the point.
- If the inventory does not fit the budget, compress reference material into a
  table, link to the chapter that owns a prerequisite, and preserve the
  highest-yield mechanisms and trade-offs. Do not solve the problem by quietly
  exceeding the time budget.

### Style and pacing

- Lead with the conclusion or governing model, then explain the mechanism,
  demonstrate it, and end with its practical consequence. Do not make the
  reader wait through background material to discover why a section matters.
- Use a precise, direct, technically confident voice. Be compact without
  becoming cryptic. Prefer short paragraphs, concrete verbs, and descriptive
  headings.
- Keep the prose moving. Avoid throat-clearing, generic motivation, repeated
  summaries, fictional dialogue, excessive analogies, and phrases such as
  “simply,” “obviously,” or “just” where the omitted detail is the hard part.
- Introduce one main idea at a time. Connect sections with explicit causal
  transitions: what invariant is established, what cost follows, and what
  decision the reader can now make.
- Use bold text sparingly for terms and conclusions, not entire sentences.
  Use tables for real comparisons, diagrams for structure or event order, and
  lists for genuinely parallel items. Do not add a visual merely to decorate a
  section.
- State important qualifications next to the claim they constrain. Do not
  defer caveats until the end of the chapter.

### Recommended chapter shape

Adapt this structure to the subject rather than filling it mechanically:

1. **Why this matters.** In a few paragraphs, connect the topic to an interview
   decision, production failure, correctness boundary, or latency cost.
2. **90-second screen.** Give about five facts the reader must retain and two
   decisions they should be able to defend.
3. **Core mental model.** Present the smallest model that explains the rest of
   the chapter, preferably with one compact example, diagram, formula, or
   comparison table.
4. **Core sections.** Label them `Core`. For each one, move in the order
   **claim → mechanism → example → consequence/trade-off**.
5. **Worked reasoning.** Include at least one realistic prediction, diagnosis,
   design choice, or calculation. Show the reasoning, not merely the answer.
6. **Optional depth.** Label material `Role-specific`, `Deep dive`, or
   `Reference`. A reader who skips it must still retain a coherent core model.
7. **Recall and practice.** End with a compact recall card, interview questions
   that test reasoning, common traps where useful, and any prerequisite the
   next chapter assumes.

### Low-latency and interview lens

- Tie performance advice to a mechanism: allocations, cache lines, dependency
  chains, branches, synchronization, system calls, copies, queueing, or another
  named source of cost.
- Separate throughput, typical latency, and tail latency. State the workload,
  hardware, contention, data-size, and locality assumptions behind performance
  claims. Never call an operation “free,” “fast,” “slow,” or “lock-free” without
  the relevant definition and conditions.
- Explain what an optimization gives up: portability, determinism,
  maintainability, numerical behavior, memory, fairness, or correctness margin.
  Include the measurement that would confirm the claimed benefit.
- Favor interview questions that ask the reader to predict, compare, debug,
  calculate, or choose. Avoid questions whose only purpose is recalling an
  obscure name or constant.
- When advice is conditional, give the condition, benefit, cost, prerequisite,
  rollback, and success measure. A strong answer should sound like an
  engineering decision, not a slogan.

### Code and technical accuracy

- Prefer minimal, compiling C++23 examples. Include the necessary headers and
  make ownership, lifetime, synchronization, and error assumptions visible.
  If code is intentionally incomplete, non-portable, racy, or undefined, label
  it immediately and explain why.
- Use realistic low-latency examples, but keep domain detail subordinate to the
  concept being taught. One example should prove one main point.
- Distinguish compile time from run time, language rules from optimizer choices,
  and source-level intent from generated-machine behavior.
- Qualify hardware constants and benchmark results with the named platform.
  Prefer ranges or a method for measuring over a timeless-looking magic number.
- Before finishing, remove duplicated explanations, unsupported absolutes,
  needless code, and facts that do not help the reader answer “why?”, “what can
  go wrong?”, or “when would I choose this?”

## C++ Foundations

- **Chapter 1: Build and translation model**
  *Focus:* Explain how C++ source becomes a runnable binary and connect translation units, linkage, the ODR, symbols, and libraries to common build and linker interview failures.
  *Examples and visuals:* Include a two-file build example, a preprocess-to-link pipeline diagram, and a table mapping declarations, definitions, linkage, and storage duration.
  - Source files and headers
    *Focus:* Cover Source files and headers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Source files and headers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - The preprocess compile assemble and link pipeline
    *Focus:* Cover The preprocess compile assemble and link pipeline by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate The preprocess compile assemble and link pipeline, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Translation units
    *Focus:* Cover Translation units by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Translation units, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Header inclusion and include guards
    *Focus:* Cover Header inclusion and include guards by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Header inclusion and include guards, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Preprocessor macros and conditional compilation
    *Focus:* Cover Preprocessor macros and conditional compilation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Preprocessor macros and conditional compilation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Phases of translation
    *Focus:* Cover Phases of translation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Phases of translation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Declarations and definitions
    *Focus:* Cover Declarations and definitions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Declarations and definitions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - odr-use and required definitions
    *Focus:* Cover odr-use and required definitions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate odr-use and required definitions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - One Definition Rule
    *Focus:* Cover One Definition Rule by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate One Definition Rule, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Storage duration
    *Focus:* Cover Storage duration by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Storage duration, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Scope
    *Focus:* Cover Scope by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Scope, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Linkage
    *Focus:* Cover Linkage by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Linkage, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Language linkage
    *Focus:* Cover Language linkage by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Language linkage, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Inline functions and variables
    *Focus:* Cover Inline functions and variables by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Inline functions and variables, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Name mangling and extern C
    *Focus:* Cover Name mangling and extern C by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Name mangling and extern C, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Object files symbols and relocation
    *Focus:* Cover Object files symbols and relocation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Object files symbols and relocation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Static and dynamic libraries
    *Focus:* Cover Static and dynamic libraries by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Static and dynamic libraries, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Symbol visibility and weak symbols
    *Focus:* Cover Symbol visibility and weak symbols by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Symbol visibility and weak symbols, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 2: Types and conversions**
  *Focus:* Build a precise working model of C++ types and implicit conversions, emphasizing the integer, floating-point, pointer, reference, and deduction traps that appear in low-latency interviews.
  *Examples and visuals:* Include short conversion-prediction snippets, a usual-arithmetic-conversions flowchart, and tables for type widths, ranges, and deduction rules.
  - The C++ type system and type categories
    *Focus:* Cover The C++ type system and type categories by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate The C++ type system and type categories, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Fundamental types and fixed-width integers
    *Focus:* Cover Fundamental types and fixed-width integers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Fundamental types and fixed-width integers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Literals and literal types
    *Focus:* Cover Literals and literal types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Literals and literal types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Object types function types and void
    *Focus:* Cover Object types function types and void by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Object types function types and void, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Const and volatile qualification
    *Focus:* Cover Const and volatile qualification by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Const and volatile qualification, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - References
    *Focus:* Cover References by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate References, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Pointers and arrays
    *Focus:* Cover Pointers and arrays by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Pointers and arrays, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Arrays and array bounds
    *Focus:* Cover Arrays and array bounds by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Arrays and array bounds, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Array-to-pointer and function-to-pointer decay
    *Focus:* Cover Array-to-pointer and function-to-pointer decay by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Array-to-pointer and function-to-pointer decay, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Scoped and unscoped enumerations
    *Focus:* Cover Scoped and unscoped enumerations by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Scoped and unscoped enumerations, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Character types and encodings
    *Focus:* Cover Character types and encodings by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Character types and encodings, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Implicit and explicit conversions
    *Focus:* Cover Implicit and explicit conversions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Implicit and explicit conversions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Boolean conversions and null pointers
    *Focus:* Cover Boolean conversions and null pointers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Boolean conversions and null pointers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Integer promotions and usual arithmetic conversions
    *Focus:* Cover Integer promotions and usual arithmetic conversions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Integer promotions and usual arithmetic conversions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Signed and unsigned arithmetic
    *Focus:* Cover Signed and unsigned arithmetic by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Signed and unsigned arithmetic, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Integer overflow
    *Focus:* Trace the causes and consequences of Integer overflow, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Integer overflow, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - IEEE 754 floating point
    *Focus:* Cover IEEE 754 floating point by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate IEEE 754 floating point, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Subnormal floating-point values
    *Focus:* Cover Subnormal floating-point values by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Subnormal floating-point values, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - NaN and infinity
    *Focus:* Cover NaN and infinity by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate NaN and infinity, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Fast-math optimizations
    *Focus:* Cover Fast-math optimizations by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Fast-math optimizations, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Auto type deduction
    *Focus:* Cover Auto type deduction by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Auto type deduction, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Decltype and decltype(auto)
    *Focus:* Cover Decltype and decltype(auto) by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Decltype and decltype(auto), supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Explicit C++ casts
    *Focus:* Cover Explicit C++ casts by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Explicit C++ casts, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 3: Object representation and layout**
  *Focus:* Show how C++ objects occupy bytes and why padding, alignment, lifetime, aliasing, provenance, and ABI rules matter for cache efficiency and binary protocols.
  *Examples and visuals:* Include annotated struct layouts, byte-dump and bit_cast examples, and tables comparing trivial, standard-layout, and implicit-lifetime types.
  - Objects bytes and memory
    *Focus:* Cover Objects bytes and memory by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Objects bytes and memory, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Object and value representation
    *Focus:* Cover Object and value representation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Object and value representation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Size and alignment
    *Focus:* Cover Size and alignment by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Size and alignment, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Padding and indeterminate values
    *Focus:* Cover Padding and indeterminate values by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Padding and indeterminate values, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Member layout and tail padding
    *Focus:* Cover Member layout and tail padding by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Member layout and tail padding, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Trivial and trivially-copyable types
    *Focus:* Cover Trivial and trivially-copyable types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Trivial and trivially-copyable types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Standard-layout types
    *Focus:* Cover Standard-layout types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Standard-layout types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Implicit-lifetime types
    *Focus:* Cover Implicit-lifetime types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Implicit-lifetime types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Object lifetimes and storage reuse
    *Focus:* Cover Object lifetimes and storage reuse by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Object lifetimes and storage reuse, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Pointer arithmetic and provenance
    *Focus:* Cover Pointer arithmetic and provenance by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Pointer arithmetic and provenance, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Type accessibility and strict aliasing
    *Focus:* Cover Type accessibility and strict aliasing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Type accessibility and strict aliasing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Type punning bit_cast and byte inspection
    *Focus:* Cover Type punning bit_cast and byte inspection by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Type punning bit_cast and byte inspection, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Endianness and byte swapping
    *Focus:* Cover Endianness and byte swapping by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Endianness and byte swapping, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Layout compatibility and offsetof
    *Focus:* Cover Layout compatibility and offsetof by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Layout compatibility and offsetof, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - ABI-safe wire and shared-memory layouts
    *Focus:* Cover ABI-safe wire and shared-memory layouts by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate ABI-safe wire and shared-memory layouts, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 4: Expressions and functions**
  *Focus:* Teach candidates to reason exactly about expression evaluation, value categories, name lookup, overload resolution, calling, and undefined behavior.
  *Examples and visuals:* Include compiler-prediction snippets, an overload-resolution decision diagram, and a table distinguishing undefined, unspecified, and implementation-defined behavior.
  - Expressions operators and operands
    *Focus:* Cover Expressions operators and operands by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Expressions operators and operands, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Value categories
    *Focus:* Cover Value categories by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Value categories, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Expression sequencing
    *Focus:* Cover Expression sequencing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Expression sequencing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Order of evaluation
    *Focus:* Cover Order of evaluation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Order of evaluation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Undefined unspecified and implementation-defined behavior
    *Focus:* Cover Undefined unspecified and implementation-defined behavior by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Undefined unspecified and implementation-defined behavior, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Common sources of undefined behavior
    *Focus:* Cover Common sources of undefined behavior by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Common sources of undefined behavior, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Function declarations definitions and calls
    *Focus:* Cover Function declarations definitions and calls by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Function declarations definitions and calls, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Parameters arguments and return values
    *Focus:* Cover Parameters arguments and return values by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Parameters arguments and return values, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Namespaces and name lookup
    *Focus:* Cover Namespaces and name lookup by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Namespaces and name lookup, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Function overloading
    *Focus:* Cover Function overloading by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Function overloading, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Function overload resolution
    *Focus:* Cover Function overload resolution by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Function overload resolution, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Argument-dependent lookup
    *Focus:* Cover Argument-dependent lookup by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Argument-dependent lookup, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Default arguments
    *Focus:* Cover Default arguments by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Default arguments, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Return-type deduction
    *Focus:* Cover Return-type deduction by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Return-type deduction, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Compile-time function evaluation
    *Focus:* Cover Compile-time function evaluation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Compile-time function evaluation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Standard attributes
    *Focus:* Cover Standard attributes by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Standard attributes, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Function pointers
    *Focus:* Cover Function pointers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Function pointers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Pointers to members
    *Focus:* Cover Pointers to members by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Pointers to members, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Callable wrappers and std::invoke
    *Focus:* Cover Callable wrappers and std::invoke by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Callable wrappers and std::invoke, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - C variadic functions
    *Focus:* Cover C variadic functions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate C variadic functions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - C++ variadic templates
    *Focus:* Cover C++ variadic templates by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate C++ variadic templates, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Calling conventions and parameter passing
    *Focus:* Cover Calling conventions and parameter passing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Calling conventions and parameter passing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 5: Object lifetime and initialization**
  *Focus:* Explain when objects begin and end their lifetimes, how initialization forms differ, and how RAII and destruction rules prevent correctness and latency failures.
  *Examples and visuals:* Include constructor-and-destructor trace programs, lifetime timelines, and a table comparing default, value, direct, copy, list, and aggregate initialization.
  - Storage and object lifetime
    *Focus:* Cover Storage and object lifetime by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Storage and object lifetime, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Lifetime beginning ending and reuse
    *Focus:* Cover Lifetime beginning ending and reuse by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Lifetime beginning ending and reuse, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Initialization forms
    *Focus:* Cover Initialization forms by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Initialization forms, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Default value zero and list initialization
    *Focus:* Cover Default value zero and list initialization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Default value zero and list initialization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Direct and copy initialization
    *Focus:* Cover Direct and copy initialization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Direct and copy initialization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Aggregate initialization
    *Focus:* Cover Aggregate initialization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Aggregate initialization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Initialization versus assignment
    *Focus:* Compare Initialization versus assignment by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Initialization versus assignment, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Most vexing parse
    *Focus:* Cover Most vexing parse by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Most vexing parse, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Temporary materialization and lifetime extension
    *Focus:* Cover Temporary materialization and lifetime extension by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Temporary materialization and lifetime extension, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Construction and destruction order
    *Focus:* Cover Construction and destruction order by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Construction and destruction order, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - RAII
    *Focus:* Cover RAII by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate RAII, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Placement new
    *Focus:* Cover Placement new by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Placement new, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::launder and explicit lifetime APIs
    *Focus:* Cover std::launder and explicit lifetime APIs by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::launder and explicit lifetime APIs, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Union active-member rules
    *Focus:* Cover Union active-member rules by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Union active-member rules, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Static initialization order fiasco
    *Focus:* Cover Static initialization order fiasco by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Static initialization order fiasco, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Empty-base optimization
    *Focus:* Cover Empty-base optimization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Empty-base optimization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - no_unique_address
    *Focus:* Cover no_unique_address by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate no_unique_address, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Destruction through base pointers
    *Focus:* Cover Destruction through base pointers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Destruction through base pointers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Sized aligned and destroying delete
    *Focus:* Cover Sized aligned and destroying delete by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Sized aligned and destroying delete, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 6: Classes and polymorphism**
  *Focus:* Move from basic class construction and invariants to inheritance, dynamic dispatch, static polymorphism, and type erasure with explicit cost and ownership tradeoffs.
  *Examples and visuals:* Include a small class hierarchy, object-and-vtable diagrams, and a comparison table for virtual dispatch, CRTP, variants, and type erasure.
  - Defining classes objects and instances
    *Focus:* Cover Defining classes objects and instances by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Defining classes objects and instances, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Class versus struct
    *Focus:* Compare Class versus struct by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Class versus struct, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Data members member functions and this
    *Focus:* Cover Data members member functions and this by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Data members member functions and this, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Encapsulation invariants and access control
    *Focus:* Cover Encapsulation invariants and access control by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Encapsulation invariants and access control, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Constructors and destructors
    *Focus:* Cover Constructors and destructors by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Constructors and destructors, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Member initializer lists
    *Focus:* Cover Member initializer lists by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Member initializer lists, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Special member functions
    *Focus:* Cover Special member functions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Special member functions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Rule of zero three and five
    *Focus:* Cover Rule of zero three and five by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Rule of zero three and five, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Defaulted and deleted functions
    *Focus:* Cover Defaulted and deleted functions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Defaulted and deleted functions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Converting and explicit constructors
    *Focus:* Cover Converting and explicit constructors by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Converting and explicit constructors, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Delegating and inherited constructors
    *Focus:* Cover Delegating and inherited constructors by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Delegating and inherited constructors, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Ref-qualified member functions
    *Focus:* Cover Ref-qualified member functions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Ref-qualified member functions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Static class members
    *Focus:* Cover Static class members by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Static class members, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Bit-fields packing and alignment
    *Focus:* Cover Bit-fields packing and alignment by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Bit-fields packing and alignment, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Composition versus inheritance
    *Focus:* Compare Composition versus inheritance by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Composition versus inheritance, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Base and derived classes
    *Focus:* Cover Base and derived classes by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Base and derived classes, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Public protected and private inheritance
    *Focus:* Cover Public protected and private inheritance by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Public protected and private inheritance, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Object slicing
    *Focus:* Cover Object slicing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Object slicing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Virtual functions and dynamic polymorphism
    *Focus:* Cover Virtual functions and dynamic polymorphism by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Virtual functions and dynamic polymorphism, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Virtual dispatch and vtables
    *Focus:* Cover Virtual dispatch and vtables by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Virtual dispatch and vtables, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Abstract classes and pure virtual functions
    *Focus:* Cover Abstract classes and pure virtual functions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Abstract classes and pure virtual functions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Virtual destructors
    *Focus:* Cover Virtual destructors by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Virtual destructors, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Override and final
    *Focus:* Cover Override and final by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Override and final, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Multiple and virtual inheritance
    *Focus:* Cover Multiple and virtual inheritance by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Multiple and virtual inheritance, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Covariant return types
    *Focus:* Cover Covariant return types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Covariant return types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - RTTI and dynamic_cast
    *Focus:* Cover RTTI and dynamic_cast by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate RTTI and dynamic_cast, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Static polymorphism with CRTP
    *Focus:* Cover Static polymorphism with CRTP by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Static polymorphism with CRTP, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Type erasure
    *Focus:* Cover Type erasure by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Type erasure, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.

## Memory and Resource Management

- **Chapter 7: Raw allocation**
  *Focus:* Separate storage allocation from object construction and explain how general-purpose and specialized allocators trade fragmentation, locality, latency, and complexity.
  *Examples and visuals:* Include placement-new and aligned-allocation snippets, allocator memory-layout diagrams, and a table comparing arenas, slabs, pools, free lists, and the system heap.
  - Storage allocation versus object construction
    *Focus:* Compare Storage allocation versus object construction by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Storage allocation versus object construction, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Automatic static and dynamic storage
    *Focus:* Cover Automatic static and dynamic storage by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Automatic static and dynamic storage, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - The free store and heap terminology
    *Focus:* Cover The free store and heap terminology by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate The free store and heap terminology, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - new and delete
    *Focus:* Cover new and delete by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate new and delete, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - operator new and the new-expression
    *Focus:* Cover operator new and the new-expression by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate operator new and the new-expression, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Array new and delete
    *Focus:* Cover Array new and delete by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Array new and delete, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - malloc calloc realloc and free
    *Focus:* Cover malloc calloc realloc and free by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate malloc calloc realloc and free, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Mixing C and C++ allocation APIs
    *Focus:* Cover Mixing C and C++ allocation APIs by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Mixing C and C++ allocation APIs, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Allocation failure handling
    *Focus:* Trace the causes and consequences of Allocation failure handling, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Allocation failure handling, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Overloading allocation functions
    *Focus:* Cover Overloading allocation functions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Overloading allocation functions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Aligned allocation
    *Focus:* Cover Aligned allocation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Aligned allocation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Allocation size classes and fragmentation
    *Focus:* Trace the causes and consequences of Allocation size classes and fragmentation, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Allocation size classes and fragmentation, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Internal and external fragmentation
    *Focus:* Trace the causes and consequences of Internal and external fragmentation, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Internal and external fragmentation, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Arena and bump allocators
    *Focus:* Cover Arena and bump allocators by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Arena and bump allocators, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Stack allocators
    *Focus:* Cover Stack allocators by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Stack allocators, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Free-list and slab allocators
    *Focus:* Cover Free-list and slab allocators by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Free-list and slab allocators, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Fixed-size block allocators
    *Focus:* Cover Fixed-size block allocators by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Fixed-size block allocators, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Object pools
    *Focus:* Cover Object pools by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Object pools, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - General-purpose allocator implementations
    *Focus:* Cover General-purpose allocator implementations by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate General-purpose allocator implementations, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Huge-page-backed arenas
    *Focus:* Cover Huge-page-backed arenas by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Huge-page-backed arenas, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 8: Allocator-aware C++**
  *Focus:* Explain the standard allocator model and show how containers and polymorphic memory resources make allocation policy explicit and controllable.
  *Examples and visuals:* Include a custom allocator or memory_resource example, an allocator-propagation table, and a diagram of container objects, allocators, and backing storage.
  - Why containers separate allocation from construction
    *Focus:* Answer why containers separate allocation from construction and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Why containers separate allocation from construction, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - C++ allocator requirements
    *Focus:* Cover C++ allocator requirements by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate C++ allocator requirements, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - allocator_traits and allocator customization
    *Focus:* Cover allocator_traits and allocator customization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate allocator_traits and allocator customization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Allocator-aware containers
    *Focus:* Cover Allocator-aware containers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Allocator-aware containers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Allocator propagation and equality
    *Focus:* Cover Allocator propagation and equality by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Allocator propagation and equality, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - scoped_allocator_adaptor
    *Focus:* Cover scoped_allocator_adaptor by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate scoped_allocator_adaptor, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Runtime allocator selection with polymorphic_allocator
    *Focus:* Cover Runtime allocator selection with polymorphic_allocator by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Runtime allocator selection with polymorphic_allocator, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Polymorphic memory resources
    *Focus:* Cover Polymorphic memory resources by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Polymorphic memory resources, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Monotonic memory resources
    *Focus:* Cover Monotonic memory resources by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Monotonic memory resources, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Pool memory resources
    *Focus:* Cover Pool memory resources by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Pool memory resources, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Choosing resource lifetime and ownership
    *Focus:* Compare Choosing resource lifetime and ownership by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Choosing resource lifetime and ownership, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Allocation-free hot paths
    *Focus:* Cover Allocation-free hot paths by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Allocation-free hot paths, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 9: Ownership**
  *Focus:* Teach ownership as a lifetime contract and compare unique, shared, weak, intrusive, and non-owning representations with attention to hot-path costs.
  *Examples and visuals:* Include small ownership-transfer snippets, shared_ptr control-block and cycle diagrams, and a table selecting pointer types by ownership semantics.
  - Ownership borrowing and object lifetime
    *Focus:* Cover Ownership borrowing and object lifetime by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Ownership borrowing and object lifetime, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Raw pointers and references as non-owning views
    *Focus:* Cover Raw pointers and references as non-owning views by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Raw pointers and references as non-owning views, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - RAII ownership types
    *Focus:* Cover RAII ownership types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate RAII ownership types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Unique ownership with unique_ptr
    *Focus:* Cover Unique ownership with unique_ptr by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Unique ownership with unique_ptr, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Custom smart-pointer deleters
    *Focus:* Cover Custom smart-pointer deleters by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Custom smart-pointer deleters, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Shared ownership and control blocks
    *Focus:* Cover Shared ownership and control blocks by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Shared ownership and control blocks, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - make_shared allocation behavior
    *Focus:* Cover make_shared allocation behavior by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate make_shared allocation behavior, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - shared_ptr aliasing constructor
    *Focus:* Cover shared_ptr aliasing constructor by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate shared_ptr aliasing constructor, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - enable_shared_from_this
    *Focus:* Cover enable_shared_from_this by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate enable_shared_from_this, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Weak ownership
    *Focus:* Cover Weak ownership by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Weak ownership, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Shared-ownership cycles
    *Focus:* Cover Shared-ownership cycles by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Shared-ownership cycles, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Weak-pointer retention after make_shared
    *Focus:* Cover Weak-pointer retention after make_shared by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Weak-pointer retention after make_shared, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Intrusive reference counting
    *Focus:* Cover Intrusive reference counting by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Intrusive reference counting, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Choosing an ownership model
    *Focus:* Compare Choosing an ownership model by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Choosing an ownership model, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Smart-pointer costs on hot paths
    *Focus:* Define and quantify Smart-pointer costs on hot paths, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Smart-pointer costs on hot paths, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
- **Chapter 10: Moves copies and errors**
  *Focus:* Explain copy and move mechanics, elision, noexcept, and moved-from states before comparing exception-based and value-based error handling.
  *Examples and visuals:* Include instrumented copy/move traces, an exception-unwinding diagram, and a table comparing exceptions, error codes, optional, and expected.
  - Copy construction and copy assignment
    *Focus:* Cover Copy construction and copy assignment by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Copy construction and copy assignment, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Move semantics
    *Focus:* Cover Move semantics by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Move semantics, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Move construction and move assignment
    *Focus:* Cover Move construction and move assignment by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Move construction and move assignment, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Value categories and move eligibility
    *Focus:* Cover Value categories and move eligibility by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Value categories and move eligibility, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::move and std::forward
    *Focus:* Cover std::move and std::forward by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::move and std::forward, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Valid but unspecified moved-from states
    *Focus:* Cover Valid but unspecified moved-from states by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Valid but unspecified moved-from states, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Move-only types
    *Focus:* Cover Move-only types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Move-only types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - RVO and NRVO
    *Focus:* Cover RVO and NRVO by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate RVO and NRVO, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Guaranteed copy elision
    *Focus:* Cover Guaranteed copy elision by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Guaranteed copy elision, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Move operations that fall back to copying
    *Focus:* Cover Move operations that fall back to copying by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Move operations that fall back to copying, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Noexcept move operations
    *Focus:* Cover Noexcept move operations by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Noexcept move operations, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Error-handling strategy and failure contracts
    *Focus:* Trace the causes and consequences of Error-handling strategy and failure contracts, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Error-handling strategy and failure contracts, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Exception handling and stack unwinding
    *Focus:* Cover Exception handling and stack unwinding by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Exception handling and stack unwinding, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Zero-cost exception implementations
    *Focus:* Define and quantify Zero-cost exception implementations, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Zero-cost exception implementations, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Exception-safety guarantees
    *Focus:* Cover Exception-safety guarantees by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Exception-safety guarantees, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Scope guards
    *Focus:* Cover Scope guards by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Scope guards, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Disabling exceptions
    *Focus:* Cover Disabling exceptions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Disabling exceptions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Error codes
    *Focus:* Trace the causes and consequences of Error codes, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Error codes, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Optional return values
    *Focus:* Cover Optional return values by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Optional return values, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Expected return values
    *Focus:* Cover Expected return values by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Expected return values, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Termination and abort
    *Focus:* Cover Termination and abort by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Termination and abort, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.

## Standard Library

- **Chapter 11: Sequence containers**
  *Focus:* Compare standard and fixed-capacity sequence containers by layout, growth, invalidation, access patterns, and suitability for latency-sensitive code.
  *Examples and visuals:* Include microexamples showing growth and invalidation, memory-layout diagrams for vector, deque, and list, and a container-selection table.
  - Sequence-container requirements and common operations
    *Focus:* Cover Sequence-container requirements and common operations by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Sequence-container requirements and common operations, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Contiguous versus node-based storage
    *Focus:* Compare Contiguous versus node-based storage by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Contiguous versus node-based storage, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - std::array
    *Focus:* Cover std::array by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::array, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::vector
    *Focus:* Cover std::vector by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::vector, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Vector growth and capacity
    *Focus:* Cover Vector growth and capacity by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Vector growth and capacity, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::deque
    *Focus:* Cover std::deque by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::deque, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::list and std::forward_list
    *Focus:* Cover std::list and std::forward_list by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::list and std::forward_list, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::inplace_vector and fixed-capacity vectors
    *Focus:* Cover std::inplace_vector and fixed-capacity vectors by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::inplace_vector and fixed-capacity vectors, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Small-vector optimization
    *Focus:* Cover Small-vector optimization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Small-vector optimization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Container iterator invalidation
    *Focus:* Cover Container iterator invalidation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Container iterator invalidation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Choosing a sequence container
    *Focus:* Compare Choosing a sequence container by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Choosing a sequence container, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
- **Chapter 12: Associative containers**
  *Focus:* Explain ordered and hash-based lookup structures from their key requirements through collision handling, rehashing, locality, and modern flat-container designs.
  *Examples and visuals:* Include lookup and rehash snippets, tree and hash-table diagrams, and a table comparing complexity, stability, memory overhead, and cache behavior.
  - Keys values and associative lookup
    *Focus:* Cover Keys values and associative lookup by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Keys values and associative lookup, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Ordering equality hashing and key requirements
    *Focus:* Cover Ordering equality hashing and key requirements by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Ordering equality hashing and key requirements, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Ordered maps and sets
    *Focus:* Cover Ordered maps and sets by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Ordered maps and sets, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Tree-based lookup complexity
    *Focus:* Define and quantify Tree-based lookup complexity, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Tree-based lookup complexity, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Unordered maps and sets
    *Focus:* Cover Unordered maps and sets by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Unordered maps and sets, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Hash-table collision resolution
    *Focus:* Cover Hash-table collision resolution by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Hash-table collision resolution, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Load factors and rehashing
    *Focus:* Cover Load factors and rehashing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Load factors and rehashing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Open addressing
    *Focus:* Cover Open addressing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Open addressing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Robin Hood hashing
    *Focus:* Cover Robin Hood hashing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Robin Hood hashing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Flat hash maps
    *Focus:* Cover Flat hash maps by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Flat hash maps, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Flat maps and sets
    *Focus:* Cover Flat maps and sets by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Flat maps and sets, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Choosing ordered versus hash-based containers
    *Focus:* Compare Choosing ordered versus hash-based containers by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Choosing ordered versus hash-based containers, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
- **Chapter 13: Strings and non-owning views**
  *Focus:* Contrast owning strings with non-owning views and spans while emphasizing null termination, invalidation, lifetime, parsing, and conversion costs.
  *Examples and visuals:* Include dangling-view and zero-allocation parsing examples, ownership-and-lifetime diagrams, and a table comparing string, string_view, span, and C strings.
  - Character arrays C strings and null termination
    *Focus:* Cover Character arrays C strings and null termination by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Character arrays C strings and null termination, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::string
    *Focus:* Cover std::string by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::string, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Small-string optimization
    *Focus:* Cover Small-string optimization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Small-string optimization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - String ownership capacity and invalidation
    *Focus:* Cover String ownership capacity and invalidation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate String ownership capacity and invalidation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::string_view
    *Focus:* Cover std::string_view by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::string_view, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - string_view lifetime hazards
    *Focus:* Cover string_view lifetime hazards by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate string_view lifetime hazards, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::span
    *Focus:* Cover std::span by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::span, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::mdspan
    *Focus:* Cover std::mdspan by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::mdspan, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Character conversion with from_chars and to_chars
    *Focus:* Cover Character conversion with from_chars and to_chars by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Character conversion with from_chars and to_chars, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 14: Algorithms and ranges**
  *Focus:* Present the standard algorithms as contracts over iterators and ranges, then cover complexity, projections, lazy views, lifetime hazards, and parallel execution.
  *Examples and visuals:* Include before-and-after algorithm rewrites, a range-view pipeline diagram, and tables for iterator capabilities and algorithm preconditions.
  - Iterators sentinels and half-open ranges
    *Focus:* Cover Iterators sentinels and half-open ranges by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Iterators sentinels and half-open ranges, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Iterator categories
    *Focus:* Cover Iterator categories by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Iterator categories, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Callable predicates
    *Focus:* Cover Callable predicates by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Callable predicates, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Custom comparators and projections
    *Focus:* Cover Custom comparators and projections by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Custom comparators and projections, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Algorithm preconditions
    *Focus:* Cover Algorithm preconditions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Algorithm preconditions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Algorithm complexity guarantees
    *Focus:* Define and quantify Algorithm complexity guarantees, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Algorithm complexity guarantees, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Sorting algorithms in the standard library
    *Focus:* Cover Sorting algorithms in the standard library by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Sorting algorithms in the standard library, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Selection and partial-sorting algorithms
    *Focus:* Cover Selection and partial-sorting algorithms by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Selection and partial-sorting algorithms, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Binary-search algorithms
    *Focus:* Cover Binary-search algorithms by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Binary-search algorithms, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Partitioning algorithms
    *Focus:* Cover Partitioning algorithms by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Partitioning algorithms, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Transformation and accumulation algorithms
    *Focus:* Cover Transformation and accumulation algorithms by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Transformation and accumulation algorithms, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Range algorithms
    *Focus:* Cover Range algorithms by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Range algorithms, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Range concepts
    *Focus:* Cover Range concepts by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Range concepts, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Lazy range views
    *Focus:* Cover Lazy range views by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Lazy range views, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - View composition and materialization
    *Focus:* Cover View composition and materialization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate View composition and materialization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Range view lifetimes
    *Focus:* Cover Range view lifetimes by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Range view lifetimes, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Parallel algorithms and execution policies
    *Focus:* Turn Parallel algorithms and execution policies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Parallel algorithms and execution policies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
- **Chapter 15: Vocabulary and utility types**
  *Focus:* Show how vocabulary and utility types encode optionality, alternatives, products, bits, time, randomness, and SIMD intent directly in interfaces.
  *Examples and visuals:* Include compact API-design examples, variant visitation and chrono conversion snippets, and a table matching each vocabulary type to its semantic role.
  - Vocabulary types and expressive interfaces
    *Focus:* Cover Vocabulary types and expressive interfaces by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Vocabulary types and expressive interfaces, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Product sum and nullable types
    *Focus:* Cover Product sum and nullable types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Product sum and nullable types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Pair and tuple
    *Focus:* Cover Pair and tuple by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Pair and tuple, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::apply and std::tie
    *Focus:* Cover std::apply and std::tie by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::apply and std::tie, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::optional
    *Focus:* Cover std::optional by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::optional, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::variant and visitation
    *Focus:* Cover std::variant and visitation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::variant and visitation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::any
    *Focus:* Cover std::any by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::any, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Reference wrappers
    *Focus:* Cover Reference wrappers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Reference wrappers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::bitset
    *Focus:* Cover std::bitset by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::bitset, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Standard bit-manipulation utilities
    *Focus:* Cover Standard bit-manipulation utilities by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Standard bit-manipulation utilities, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::simd
    *Focus:* Cover std::simd by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::simd, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Random engines and distributions
    *Focus:* Cover Random engines and distributions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Random engines and distributions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::chrono durations and time points
    *Focus:* Cover std::chrono durations and time points by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::chrono durations and time points, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Standard clocks
    *Focus:* Cover Standard clocks by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Standard clocks, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Calendar and timezone library
    *Focus:* Cover Calendar and timezone library by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Calendar and timezone library, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 16: Formatting and I/O**
  *Focus:* Explain the layers and costs of C++ and C I/O, including buffering, formatting, locale, errors, files, and asynchronous logging.
  *Examples and visuals:* Include equivalent iostream, stdio, and format examples, a buffering-path diagram, and a table comparing allocation, synchronization, and formatting costs.
  - Text binary and formatted I/O
    *Focus:* Cover Text binary and formatted I/O by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Text binary and formatted I/O, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Streams stream buffers and buffering
    *Focus:* Cover Streams stream buffers and buffering by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Streams stream buffers and buffering, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Iostream architecture and cost
    *Focus:* Define and quantify Iostream architecture and cost, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Iostream architecture and cost, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - File streams and string streams
    *Focus:* Cover File streams and string streams by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate File streams and string streams, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - C stdio
    *Focus:* Cover C stdio by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate C stdio, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Synchronization between iostreams and stdio
    *Focus:* Cover Synchronization between iostreams and stdio by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Synchronization between iostreams and stdio, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::format and std::print
    *Focus:* Cover std::format and std::print by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::format and std::print, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Locale costs
    *Focus:* Define and quantify Locale costs, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Locale costs, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Error handling and partial I/O
    *Focus:* Trace the causes and consequences of Error handling and partial I/O, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Error handling and partial I/O, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Asynchronous logging
    *Focus:* Cover Asynchronous logging by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Asynchronous logging, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.

## Generic and Modern C++

- **Chapter 17: Templates**
  *Focus:* Develop templates from basic parameterization through deduction, instantiation, lookup, specialization, constraints, packs, forwarding, and compile-time cost.
  *Examples and visuals:* Include deduction and SFINAE prediction snippets, an instantiation-flow diagram, and tables for reference collapsing, constraint ordering, and specialization rules.
  - Generic programming and template syntax
    *Focus:* Cover Generic programming and template syntax by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Generic programming and template syntax, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Function class variable and alias templates
    *Focus:* Cover Function class variable and alias templates by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Function class variable and alias templates, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Template parameters and arguments
    *Focus:* Cover Template parameters and arguments by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Template parameters and arguments, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Non-type template parameters
    *Focus:* Cover Non-type template parameters by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Non-type template parameters, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Template instantiation
    *Focus:* Cover Template instantiation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Template instantiation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Implicit instantiation and points of instantiation
    *Focus:* Cover Implicit instantiation and points of instantiation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Implicit instantiation and points of instantiation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Explicit instantiation and extern template
    *Focus:* Cover Explicit instantiation and extern template by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Explicit instantiation and extern template, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Template argument deduction
    *Focus:* Cover Template argument deduction by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Template argument deduction, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Class template argument deduction
    *Focus:* Cover Class template argument deduction by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Class template argument deduction, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Full and partial specialization
    *Focus:* Cover Full and partial specialization by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Full and partial specialization, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Two-phase name lookup
    *Focus:* Cover Two-phase name lookup by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Two-phase name lookup, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Dependent names and disambiguators
    *Focus:* Cover Dependent names and disambiguators by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Dependent names and disambiguators, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Compile-time type traits
    *Focus:* Cover Compile-time type traits by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Compile-time type traits, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Substitution failure and overload participation
    *Focus:* Trace the causes and consequences of Substitution failure and overload participation, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Substitution failure and overload participation, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - SFINAE
    *Focus:* Cover SFINAE by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate SFINAE, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Detection idiom and void_t
    *Focus:* Cover Detection idiom and void_t by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Detection idiom and void_t, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Tag dispatch
    *Focus:* Cover Tag dispatch by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Tag dispatch, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - if constexpr
    *Focus:* Cover if constexpr by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate if constexpr, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Concepts and constraints
    *Focus:* Cover Concepts and constraints by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Concepts and constraints, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Constraint subsumption
    *Focus:* Cover Constraint subsumption by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Constraint subsumption, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Parameter packs and pack expansion
    *Focus:* Cover Parameter packs and pack expansion by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Parameter packs and pack expansion, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Fold expressions
    *Focus:* Cover Fold expressions by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Fold expressions, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Forwarding references and reference collapsing
    *Focus:* Cover Forwarding references and reference collapsing by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Forwarding references and reference collapsing, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Perfect forwarding
    *Focus:* Cover Perfect forwarding by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Perfect forwarding, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Expression templates
    *Focus:* Cover Expression templates by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Expression templates, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Template code bloat and compile-time cost
    *Focus:* Trace the causes and consequences of Template code bloat and compile-time cost, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Template code bloat and compile-time cost, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
- **Chapter 18: Lambdas and callable objects**
  *Focus:* Explain lambdas as generated function objects and cover capture, mutability, generic call operators, lifetime hazards, conversions, and wrapper-storage costs.
  *Examples and visuals:* Include capture and dangling-lifetime snippets, closure-object layout diagrams, and a table comparing lambdas, function objects, function pointers, and std::function.
  - Function objects and callable concepts
    *Focus:* Cover Function objects and callable concepts by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Function objects and callable concepts, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Lambda syntax and the generated call operator
    *Focus:* Cover Lambda syntax and the generated call operator by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Lambda syntax and the generated call operator, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Lambda closure types
    *Focus:* Cover Lambda closure types by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Lambda closure types, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Lambda capture modes
    *Focus:* Cover Lambda capture modes by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Lambda capture modes, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Init-capture
    *Focus:* Cover Init-capture by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Init-capture, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Capturing this and star-this
    *Focus:* Cover Capturing this and star-this by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Capturing this and star-this, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Mutable lambdas
    *Focus:* Cover Mutable lambdas by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Mutable lambdas, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Captureless lambda conversion
    *Focus:* Cover Captureless lambda conversion by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Captureless lambda conversion, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Generic lambdas
    *Focus:* Cover Generic lambdas by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Generic lambdas, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Constexpr lambdas
    *Focus:* Cover Constexpr lambdas by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Constexpr lambdas, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Dangling lambda captures
    *Focus:* Trace the causes and consequences of Dangling lambda captures, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Dangling lambda captures, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Lambda allocation and object size
    *Focus:* Cover Lambda allocation and object size by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Lambda allocation and object size, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Small-object optimization in callable wrappers
    *Focus:* Cover Small-object optimization in callable wrappers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Small-object optimization in callable wrappers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 19: Modern language facilities**
  *Focus:* Survey high-value modern and emerging language facilities while explaining the concrete problems, implementation models, and adoption constraints behind each feature.
  *Examples and visuals:* Include concise examples for structured bindings, comparisons, constexpr, modules, and coroutines, plus a version-and-compiler-support table.
  - Language-version evolution and feature-test macros
    *Focus:* Cover Language-version evolution and feature-test macros by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Language-version evolution and feature-test macros, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Range-based for loops
    *Focus:* Cover Range-based for loops by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Range-based for loops, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Structured bindings
    *Focus:* Cover Structured bindings by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Structured bindings, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Three-way comparison
    *Focus:* Compare Three-way comparison by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Three-way comparison, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Constant evaluation with constexpr and consteval
    *Focus:* Cover Constant evaluation with constexpr and consteval by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Constant evaluation with constexpr and consteval, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Constant initialization and constinit
    *Focus:* Cover Constant initialization and constinit by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Constant initialization and constinit, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Deducing this
    *Focus:* Cover Deducing this by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Deducing this, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Modules
    *Focus:* Cover Modules by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Modules, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Module interfaces implementations and imports
    *Focus:* Cover Module interfaces implementations and imports by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Module interfaces implementations and imports, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Coroutines
    *Focus:* Cover Coroutines by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Coroutines, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Coroutine promise types and frames
    *Focus:* Cover Coroutine promise types and frames by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Coroutine promise types and frames, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Coroutine suspension and allocation
    *Focus:* Cover Coroutine suspension and allocation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Coroutine suspension and allocation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::generator
    *Focus:* Cover std::generator by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::generator, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Contracts
    *Focus:* Cover Contracts by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Contracts, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Static reflection
    *Focus:* Cover Static reflection by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Static reflection, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
- **Chapter 20: Modern asynchronous C++**
  *Focus:* Build a model of asynchronous work, shared state, completion, cancellation, scheduling, and composition across futures, callbacks, coroutines, and senders.
  *Examples and visuals:* Include one task expressed with promises, callbacks, coroutines, and senders, a completion-flow diagram, and a comparison table for blocking and composition behavior.
  - Synchronous versus asynchronous execution
    *Focus:* Compare Synchronous versus asynchronous execution by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Synchronous versus asynchronous execution, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Tasks shared state and result channels
    *Focus:* Cover Tasks shared state and result channels by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Tasks shared state and result channels, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Callbacks event loops and continuations
    *Focus:* Cover Callbacks event loops and continuations by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Callbacks event loops and continuations, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Futures and promises
    *Focus:* Cover Futures and promises by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Futures and promises, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Waiting polling and retrieving results
    *Focus:* Cover Waiting polling and retrieving results by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Waiting polling and retrieving results, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Broken promises and exception propagation
    *Focus:* Cover Broken promises and exception propagation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Broken promises and exception propagation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Packaged tasks
    *Focus:* Cover Packaged tasks by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Packaged tasks, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - std::async
    *Focus:* Cover std::async by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate std::async, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Launch policies and deferred execution
    *Focus:* Turn Launch policies and deferred execution into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Launch policies and deferred execution, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Cooperative cancellation
    *Focus:* Cover Cooperative cancellation by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Cooperative cancellation, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Execution contexts schedulers and executors
    *Focus:* Cover Execution contexts schedulers and executors by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Execution contexts schedulers and executors, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Senders and receivers
    *Focus:* Cover Senders and receivers by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Senders and receivers, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.
  - Coroutine-based asynchronous I/O
    *Focus:* Cover Coroutine-based asynchronous I/O by explaining the governing C++ rules, compiler or runtime behavior, correctness boundaries, and consequences for low-latency code.
    *Examples and visuals:* Use a minimal compiling example to demonstrate Coroutine-based asynchronous I/O, supported by an object, lifetime, or control-flow diagram and a table of rules, costs, and interview traps.

## Algorithms and Data Structures

- **Chapter 21: Core data structures**
  *Focus:* Review the invariants, operations, complexity, memory representation, and locality of the data structures most likely to appear in coding and systems interviews.
  *Examples and visuals:* Include minimal implementations of selected structures, pointer-and-array layout diagrams, and a table comparing operation costs and cache behavior.
  - Abstract data types interfaces and invariants
    *Focus:* Cover Abstract data types interfaces and invariants through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Abstract data types interfaces and invariants, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Contiguous versus linked representation
    *Focus:* Compare Contiguous versus linked representation by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Contiguous versus linked representation, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Arrays and dynamic arrays
    *Focus:* Cover Arrays and dynamic arrays through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Arrays and dynamic arrays, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Linked lists
    *Focus:* Cover Linked lists through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Linked lists, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Stacks queues and deques
    *Focus:* Cover Stacks queues and deques through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Stacks queues and deques, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Circular buffers
    *Focus:* Cover Circular buffers through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Circular buffers, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Intrusive lists
    *Focus:* Cover Intrusive lists through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Intrusive lists, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Indexed and free lists
    *Focus:* Cover Indexed and free lists through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Indexed and free lists, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Hash tables
    *Focus:* Cover Hash tables through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Hash tables, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Search-tree ordering and traversal
    *Focus:* Cover Search-tree ordering and traversal through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Search-tree ordering and traversal, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Binary search trees
    *Focus:* Cover Binary search trees through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Binary search trees, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - AVL trees
    *Focus:* Cover AVL trees through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate AVL trees, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Red-black trees
    *Focus:* Cover Red-black trees through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Red-black trees, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Binary heaps and priority queues
    *Focus:* Cover Binary heaps and priority queues through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Binary heaps and priority queues, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Tries
    *Focus:* Cover Tries through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Tries, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Skip lists
    *Focus:* Cover Skip lists through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Skip lists, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - B-trees and B+ trees
    *Focus:* Cover B-trees and B+ trees through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate B-trees and B+ trees, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Disjoint-set union
    *Focus:* Cover Disjoint-set union through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Disjoint-set union, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Graph terminology vertices edges and paths
    *Focus:* Cover Graph terminology vertices edges and paths through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Graph terminology vertices edges and paths, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Graph representations
    *Focus:* Cover Graph representations through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Graph representations, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Segment trees
    *Focus:* Cover Segment trees through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Segment trees, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Fenwick trees
    *Focus:* Cover Fenwick trees through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Fenwick trees, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Bloom filters
    *Focus:* Cover Bloom filters through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Bloom filters, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - LRU caches
    *Focus:* Cover LRU caches through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate LRU caches, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Choosing by complexity locality and workload
    *Focus:* Compare Choosing by complexity locality and workload by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Choosing by complexity locality and workload, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
- **Chapter 22: Algorithmic techniques**
  *Focus:* Teach a repeatable way to recognize problem structure, establish invariants, choose an algorithmic pattern, and justify correctness and complexity under interview pressure.
  *Examples and visuals:* Include one representative problem per technique, state-transition or recursion diagrams where useful, and a pattern-recognition table keyed by problem signals.
  - Problem decomposition invariants and correctness
    *Focus:* Cover Problem decomposition invariants and correctness through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Problem decomposition invariants and correctness, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Brute force and baseline solutions
    *Focus:* Cover Brute force and baseline solutions through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Brute force and baseline solutions, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Two pointers
    *Focus:* Cover Two pointers through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Two pointers, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Sliding windows
    *Focus:* Cover Sliding windows through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Sliding windows, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Prefix sums
    *Focus:* Cover Prefix sums through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Prefix sums, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Sorting properties and tradeoffs
    *Focus:* Compare Sorting properties and tradeoffs by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Sorting properties and tradeoffs, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Binary search
    *Focus:* Cover Binary search through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Binary search, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Binary search on the answer
    *Focus:* Cover Binary search on the answer through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Binary search on the answer, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Interval algorithms
    *Focus:* Cover Interval algorithms through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Interval algorithms, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Sweep-line algorithms
    *Focus:* Cover Sweep-line algorithms through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Sweep-line algorithms, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Monotonic stacks and queues
    *Focus:* Cover Monotonic stacks and queues through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Monotonic stacks and queues, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Recursion and backtracking
    *Focus:* Cover Recursion and backtracking through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Recursion and backtracking, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Divide and conquer
    *Focus:* Cover Divide and conquer through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Divide and conquer, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Greedy algorithms
    *Focus:* Cover Greedy algorithms through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Greedy algorithms, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Dynamic programming
    *Focus:* Cover Dynamic programming through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Dynamic programming, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Bit-manipulation techniques
    *Focus:* Cover Bit-manipulation techniques through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Bit-manipulation techniques, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Breadth-first and depth-first search
    *Focus:* Cover Breadth-first and depth-first search through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Breadth-first and depth-first search, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Topological sorting
    *Focus:* Cover Topological sorting through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Topological sorting, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Shortest paths
    *Focus:* Cover Shortest paths through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Shortest paths, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Finite-state machines
    *Focus:* Cover Finite-state machines through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Finite-state machines, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Table-driven parsing
    *Focus:* Cover Table-driven parsing through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Table-driven parsing, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
- **Chapter 23: Complexity and numerical correctness**
  *Focus:* Combine asymptotic and cache-aware cost reasoning with the integer, fixed-point, decimal, and floating-point correctness needed in financial systems.
  *Examples and visuals:* Include complexity derivations and numerical edge-case snippets, error-propagation diagrams, and tables for representation ranges, rounding modes, and overflow strategies.
  - Cost models and counting operations
    *Focus:* Define and quantify Cost models and counting operations, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Cost models and counting operations, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Asymptotic notation
    *Focus:* Cover Asymptotic notation through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Asymptotic notation, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Big O Big Omega and Big Theta
    *Focus:* Cover Big O Big Omega and Big Theta through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Big O Big Omega and Big Theta, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Best average and worst-case complexity
    *Focus:* Define and quantify Best average and worst-case complexity, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Best average and worst-case complexity, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Amortized analysis
    *Focus:* Cover Amortized analysis through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Amortized analysis, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Space-time tradeoffs
    *Focus:* Compare Space-time tradeoffs by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Space-time tradeoffs, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Cache complexity
    *Focus:* Define and quantify Cache complexity, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Cache complexity, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Cache-oblivious algorithms
    *Focus:* Cover Cache-oblivious algorithms through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Cache-oblivious algorithms, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Integer ranges overflow and underflow
    *Focus:* Trace the causes and consequences of Integer ranges overflow and underflow, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Integer ranges overflow and underflow, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Checked and saturating arithmetic
    *Focus:* Cover Checked and saturating arithmetic through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Checked and saturating arithmetic, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Fixed-point representation
    *Focus:* Cover Fixed-point representation through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Fixed-point representation, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Fixed-point price arithmetic
    *Focus:* Cover Fixed-point price arithmetic through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Fixed-point price arithmetic, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Scale conversion and rounding
    *Focus:* Cover Scale conversion and rounding through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Scale conversion and rounding, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Decimal conversion and tick precision
    *Focus:* Cover Decimal conversion and tick precision through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Decimal conversion and tick precision, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Floating-point error and conditioning
    *Focus:* Trace the causes and consequences of Floating-point error and conditioning, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Floating-point error and conditioning, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Numerical stability
    *Focus:* Cover Numerical stability through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Numerical stability, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Floating-point comparison
    *Focus:* Compare Floating-point comparison by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Floating-point comparison, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Kahan summation
    *Focus:* Cover Kahan summation through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Kahan summation, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.
  - Sentinel-value hazards
    *Focus:* Cover Sentinel-value hazards through its defining invariants, core operations, correctness argument, complexity, and sensitivity to representation and locality.
    *Examples and visuals:* Use a compact implementation or worked trace to demonstrate Sentinel-value hazards, supported by an invariant or state diagram and a table of operation costs, edge cases, and alternatives.

## Concurrency and the C++ Memory Model

- **Chapter 24: Threads and synchronization**
  *Focus:* Explain the lifecycle and coordination of C++ threads, progressing from mutex and condition-variable fundamentals to thread pools, contention pathologies, and hybrid waiting.
  *Examples and visuals:* Include a correct producer-consumer implementation, wait-state and deadlock diagrams, and a table comparing synchronization primitives by semantics and cost.
  - Concurrency versus parallelism
    *Focus:* Compare Concurrency versus parallelism by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Concurrency versus parallelism, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Processes threads and tasks
    *Focus:* Cover Processes threads and tasks with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Processes threads and tasks, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Shared state race conditions and synchronization
    *Focus:* Trace the causes and consequences of Shared state race conditions and synchronization, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Shared state race conditions and synchronization, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - std::thread and std::jthread
    *Focus:* Cover std::thread and std::jthread with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate std::thread and std::jthread, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Thread arguments return values and ownership
    *Focus:* Cover Thread arguments return values and ownership with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Thread arguments return values and ownership, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Joining and detaching threads
    *Focus:* Cover Joining and detaching threads with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Joining and detaching threads, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Thread-local storage
    *Focus:* Cover Thread-local storage with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Thread-local storage, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Mutexes
    *Focus:* Cover Mutexes with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Mutexes, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Critical sections and lock invariants
    *Focus:* Cover Critical sections and lock invariants with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Critical sections and lock invariants, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - RAII lock wrappers
    *Focus:* Cover RAII lock wrappers with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate RAII lock wrappers, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Reader-writer mutexes
    *Focus:* Cover Reader-writer mutexes with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Reader-writer mutexes, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Deadlock-free multi-locking
    *Focus:* Trace the causes and consequences of Deadlock-free multi-locking, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Deadlock-free multi-locking, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Condition variables
    *Focus:* Cover Condition variables with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Condition variables, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Spurious and lost wakeups
    *Focus:* Cover Spurious and lost wakeups with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Spurious and lost wakeups, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - One-time initialization
    *Focus:* Cover One-time initialization with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate One-time initialization, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - C++ semaphores
    *Focus:* Cover C++ semaphores with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate C++ semaphores, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Latches and barriers
    *Focus:* Cover Latches and barriers with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Latches and barriers, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic wait and notification
    *Focus:* Cover Atomic wait and notification with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic wait and notification, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Spin-then-park synchronization
    *Focus:* Cover Spin-then-park synchronization with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Spin-then-park synchronization, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Futex-backed and adaptive mutexes
    *Focus:* Cover Futex-backed and adaptive mutexes with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Futex-backed and adaptive mutexes, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Thread creation and thread pools
    *Focus:* Cover Thread creation and thread pools with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Thread creation and thread pools, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Task queues work sharing and work stealing
    *Focus:* Cover Task queues work sharing and work stealing with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Task queues work sharing and work stealing, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Deadlock
    *Focus:* Trace the causes and consequences of Deadlock, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Deadlock, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Livelock
    *Focus:* Trace the causes and consequences of Livelock, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Livelock, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Priority inversion
    *Focus:* Cover Priority inversion with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Priority inversion, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Lock convoys
    *Focus:* Cover Lock convoys with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Lock convoys, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
- **Chapter 25: C++ memory model**
  *Focus:* Give candidates a precise happens-before model for data races, atomics, memory orders, fences, publication, and the distinction between compiler and hardware ordering.
  *Examples and visuals:* Include litmus tests to predict, happens-before graphs, and tables mapping C++ memory orders to guarantees and representative hardware instructions.
  - The abstract machine and observable behavior
    *Focus:* Cover The abstract machine and observable behavior with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate The abstract machine and observable behavior, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Threads memory locations and conflicting actions
    *Focus:* Cover Threads memory locations and conflicting actions with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Threads memory locations and conflicting actions, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Sequenced-before and inter-thread ordering
    *Focus:* Cover Sequenced-before and inter-thread ordering with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Sequenced-before and inter-thread ordering, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Data races
    *Focus:* Trace the causes and consequences of Data races, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Data races, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - The data-race-free sequential-consistency guarantee
    *Focus:* Trace the causes and consequences of The data-race-free sequential-consistency guarantee, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate The data-race-free sequential-consistency guarantee, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Happens-before and synchronizes-with
    *Focus:* Cover Happens-before and synchronizes-with with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Happens-before and synchronizes-with, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic types and lock freedom
    *Focus:* Cover Atomic types and lock freedom with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic types and lock freedom, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - std::atomic_ref
    *Focus:* Cover std::atomic_ref with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate std::atomic_ref, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic loads stores and exchanges
    *Focus:* Cover Atomic loads stores and exchanges with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic loads stores and exchanges, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic read-modify-write operations
    *Focus:* Cover Atomic read-modify-write operations with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic read-modify-write operations, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Compare-exchange loops
    *Focus:* Cover Compare-exchange loops with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Compare-exchange loops, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Spurious compare-exchange failure
    *Focus:* Trace the causes and consequences of Spurious compare-exchange failure, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Spurious compare-exchange failure, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Sequential consistency
    *Focus:* Cover Sequential consistency with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Sequential consistency, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Relaxed ordering
    *Focus:* Cover Relaxed ordering with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Relaxed ordering, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Acquire and release ordering
    *Focus:* Cover Acquire and release ordering with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Acquire and release ordering, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Consume ordering
    *Focus:* Cover Consume ordering with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Consume ordering, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Modification order and coherence
    *Focus:* Cover Modification order and coherence with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Modification order and coherence, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Release sequences
    *Focus:* Cover Release sequences with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Release sequences, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic fences
    *Focus:* Cover Atomic fences with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic fences, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Fence-atomic synchronization
    *Focus:* Cover Fence-atomic synchronization with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Fence-atomic synchronization, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Safe publication
    *Focus:* Cover Safe publication with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Safe publication, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Double-checked locking
    *Focus:* Cover Double-checked locking with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Double-checked locking, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic shared pointers
    *Focus:* Cover Atomic shared pointers with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic shared pointers, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Memory-model litmus tests
    *Focus:* Cover Memory-model litmus tests with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Memory-model litmus tests, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic tearing and alignment
    *Focus:* Cover Atomic tearing and alignment with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic tearing and alignment, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Compiler barriers and CPU fences
    *Focus:* Cover Compiler barriers and CPU fences with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Compiler barriers and CPU fences, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Volatile is not synchronization
    *Focus:* Cover Volatile is not synchronization with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Volatile is not synchronization, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
- **Chapter 26: Lock-free programming**
  *Focus:* Explain non-blocking progress and linearizability before examining contention, ABA, reclamation, and the design of practical bounded queues.
  *Examples and visuals:* Include an annotated SPSC ring buffer and compare-exchange loop, linearization-point timelines, and tables comparing reclamation schemes and queue topologies.
  - Blocking versus non-blocking algorithms
    *Focus:* Compare Blocking versus non-blocking algorithms by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Blocking versus non-blocking algorithms, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Obstruction-free lock-free and wait-free progress
    *Focus:* Cover Obstruction-free lock-free and wait-free progress with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Obstruction-free lock-free and wait-free progress, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Linearizability and linearization points
    *Focus:* Cover Linearizability and linearization points with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Linearizability and linearization points, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Composability and lock-free algorithm invariants
    *Focus:* Cover Composability and lock-free algorithm invariants with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Composability and lock-free algorithm invariants, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Atomic contention and compare-exchange retry loops
    *Focus:* Cover Atomic contention and compare-exchange retry loops with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Atomic contention and compare-exchange retry loops, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Seqlocks
    *Focus:* Cover Seqlocks with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Seqlocks, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - ABA problem
    *Focus:* Cover ABA problem with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate ABA problem, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Tagged pointers
    *Focus:* Cover Tagged pointers with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Tagged pointers, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Memory reclamation
    *Focus:* Cover Memory reclamation with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Memory reclamation, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Hazard pointers
    *Focus:* Cover Hazard pointers with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Hazard pointers, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Epoch-based reclamation
    *Focus:* Cover Epoch-based reclamation with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Epoch-based reclamation, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Read-copy-update
    *Focus:* Cover Read-copy-update with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Read-copy-update, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Queue producer-consumer topologies
    *Focus:* Cover Queue producer-consumer topologies with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Queue producer-consumer topologies, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - SPSC queues
    *Focus:* Cover SPSC queues with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate SPSC queues, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - MPSC queues
    *Focus:* Cover MPSC queues with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate MPSC queues, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - MPMC queues
    *Focus:* Cover MPMC queues with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate MPMC queues, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Bounded lock-free ring buffers
    *Focus:* Cover Bounded lock-free ring buffers with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Bounded lock-free ring buffers, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Queue wraparound and sequence counters
    *Focus:* Cover Queue wraparound and sequence counters with precise ownership, synchronization, ordering, progress, contention, and failure reasoning suitable for a C++ concurrency interview.
    *Examples and visuals:* Use a small multithreaded example or litmus test to demonstrate Queue wraparound and sequence counters, supported by a happens-before or state timeline and a table of guarantees, progress, contention, and failure modes.
  - Queue backpressure policies
    *Focus:* Turn Queue backpressure policies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Queue backpressure policies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.

## Computer Architecture

- **Chapter 27: CPU execution**
  *Focus:* Trace instructions through a modern out-of-order CPU and connect front-end, dependency, port, speculation, branch, and SMT behavior to observed latency.
  *Examples and visuals:* Include short assembly kernels, a pipeline and reorder-buffer diagram, and tables for instruction latency, throughput, and execution-port usage.
  - Instruction-set architecture versus microarchitecture
    *Focus:* Compare Instruction-set architecture versus microarchitecture by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Instruction-set architecture versus microarchitecture, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - The fetch decode execute cycle
    *Focus:* Cover The fetch decode execute cycle by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate The fetch decode execute cycle, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - CPU pipeline fundamentals
    *Focus:* Cover CPU pipeline fundamentals by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate CPU pipeline fundamentals, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Front-end bandwidth and instruction-cache pressure
    *Focus:* Define and quantify Front-end bandwidth and instruction-cache pressure, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Front-end bandwidth and instruction-cache pressure, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Micro-ops and the micro-op cache
    *Focus:* Cover Micro-ops and the micro-op cache by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Micro-ops and the micro-op cache, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Superscalar execution
    *Focus:* Cover Superscalar execution by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Superscalar execution, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Instruction latency and throughput
    *Focus:* Define and quantify Instruction latency and throughput, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Instruction latency and throughput, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Data dependencies and critical paths
    *Focus:* Cover Data dependencies and critical paths by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Data dependencies and critical paths, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Out-of-order execution and retirement
    *Focus:* Cover Out-of-order execution and retirement by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Out-of-order execution and retirement, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Instruction-level parallelism
    *Focus:* Cover Instruction-level parallelism by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Instruction-level parallelism, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Reorder buffers and reservation stations
    *Focus:* Cover Reorder buffers and reservation stations by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Reorder buffers and reservation stations, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Register renaming
    *Focus:* Cover Register renaming by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Register renaming, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Execution ports and port contention
    *Focus:* Cover Execution ports and port contention by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Execution ports and port contention, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Data control and structural hazards
    *Focus:* Cover Data control and structural hazards by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Data control and structural hazards, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Speculative execution
    *Focus:* Cover Speculative execution by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Speculative execution, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Branch prediction
    *Focus:* Cover Branch prediction by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Branch prediction, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Branch-target buffers
    *Focus:* Cover Branch-target buffers by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Branch-target buffers, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Branch-misprediction recovery
    *Focus:* Cover Branch-misprediction recovery by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Branch-misprediction recovery, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Machine clears
    *Focus:* Cover Machine clears by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Machine clears, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Hardware multithreading and SMT contention
    *Focus:* Cover Hardware multithreading and SMT contention by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Hardware multithreading and SMT contention, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Spectre-class mitigations
    *Focus:* Cover Spectre-class mitigations by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Spectre-class mitigations, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
- **Chapter 28: Caches**
  *Focus:* Explain how locality, cache geometry, replacement, write policy, coherence, sharing, prefetching, and TLB behavior determine memory-access performance.
  *Examples and visuals:* Include stride and false-sharing benchmarks, cache-address decomposition and coherence diagrams, and a hierarchy table with capacities and approximate costs.
  - Temporal and spatial locality
    *Focus:* Cover Temporal and spatial locality by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Temporal and spatial locality, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache hierarchy
    *Focus:* Cover Cache hierarchy by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache hierarchy, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache hits misses and miss penalties
    *Focus:* Cover Cache hits misses and miss penalties by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache hits misses and miss penalties, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache-line organization
    *Focus:* Cover Cache-line organization by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache-line organization, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache associativity and address decomposition
    *Focus:* Cover Cache associativity and address decomposition by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache associativity and address decomposition, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache replacement policies
    *Focus:* Turn Cache replacement policies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Cache replacement policies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Inclusive exclusive and non-inclusive caches
    *Focus:* Cover Inclusive exclusive and non-inclusive caches by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Inclusive exclusive and non-inclusive caches, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Write-back and write-through caches
    *Focus:* Cover Write-back and write-through caches by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Write-back and write-through caches, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Write allocation policies
    *Focus:* Turn Write allocation policies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Write allocation policies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Compulsory capacity and conflict misses
    *Focus:* Cover Compulsory capacity and conflict misses by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Compulsory capacity and conflict misses, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache thrashing
    *Focus:* Cover Cache thrashing by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache thrashing, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache coherence protocols
    *Focus:* Cover Cache coherence protocols by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache coherence protocols, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - True sharing and cache-line bouncing
    *Focus:* Cover True sharing and cache-line bouncing by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate True sharing and cache-line bouncing, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - False sharing
    *Focus:* Cover False sharing by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate False sharing, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache-line padding
    *Focus:* Cover Cache-line padding by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache-line padding, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache warming
    *Focus:* Cover Cache warming by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache warming, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Hardware prefetchers
    *Focus:* Cover Hardware prefetchers by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Hardware prefetchers, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Software prefetching and prefetch distance
    *Focus:* Cover Software prefetching and prefetch distance by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Software prefetching and prefetch distance, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Non-temporal stores
    *Focus:* Cover Non-temporal stores by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Non-temporal stores, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Cache coloring and way partitioning
    *Focus:* Cover Cache coloring and way partitioning by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Cache coloring and way partitioning, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Instruction TLB behavior
    *Focus:* Cover Instruction TLB behavior by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Instruction TLB behavior, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
- **Chapter 29: Memory and NUMA**
  *Focus:* Extend the memory model beyond caches into DRAM, load-store machinery, hardware ordering, NUMA, interconnects, DMA, IOMMUs, and device coherence.
  *Examples and visuals:* Include NUMA placement and bandwidth experiments, DRAM-bank and socket-topology diagrams, and tables comparing local, remote, and device-memory paths.
  - The memory hierarchy beyond caches
    *Focus:* Cover The memory hierarchy beyond caches by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate The memory hierarchy beyond caches, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - DRAM cells and organization
    *Focus:* Cover DRAM cells and organization by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate DRAM cells and organization, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - DRAM channels ranks banks and rows
    *Focus:* Cover DRAM channels ranks banks and rows by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate DRAM channels ranks banks and rows, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Row-buffer behavior
    *Focus:* Cover Row-buffer behavior by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Row-buffer behavior, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Memory controllers
    *Focus:* Cover Memory controllers by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Memory controllers, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Memory bandwidth and latency
    *Focus:* Define and quantify Memory bandwidth and latency, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Memory bandwidth and latency, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Memory-level parallelism
    *Focus:* Cover Memory-level parallelism by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Memory-level parallelism, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Load-store queues
    *Focus:* Cover Load-store queues by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Load-store queues, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Store buffers
    *Focus:* Cover Store buffers by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Store buffers, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Memory disambiguation
    *Focus:* Cover Memory disambiguation by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Memory disambiguation, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Store-to-load forwarding
    *Focus:* Cover Store-to-load forwarding by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Store-to-load forwarding, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Read for ownership
    *Focus:* Cover Read for ownership by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Read for ownership, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Write combining
    *Focus:* Cover Write combining by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Write combining, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Split-line and split-page accesses
    *Focus:* Cover Split-line and split-page accesses by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Split-line and split-page accesses, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Hardware memory consistency models
    *Focus:* Cover Hardware memory consistency models by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Hardware memory consistency models, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - x86 TSO
    *Focus:* Cover x86 TSO by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate x86 TSO, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Weak hardware memory ordering
    *Focus:* Cover Weak hardware memory ordering by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Weak hardware memory ordering, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Hardware memory barriers
    *Focus:* Cover Hardware memory barriers by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Hardware memory barriers, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Locked instructions and atomic operations
    *Focus:* Cover Locked instructions and atomic operations by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Locked instructions and atomic operations, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - NUMA topology
    *Focus:* Cover NUMA topology by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate NUMA topology, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - NUMA nodes distances and locality
    *Focus:* Cover NUMA nodes distances and locality by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate NUMA nodes distances and locality, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - First-touch allocation
    *Focus:* Cover First-touch allocation by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate First-touch allocation, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Remote-memory access
    *Focus:* Cover Remote-memory access by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Remote-memory access, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - CPU interconnects
    *Focus:* Cover CPU interconnects by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate CPU interconnects, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Thread memory and NIC NUMA locality
    *Focus:* Cover Thread memory and NIC NUMA locality by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Thread memory and NIC NUMA locality, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Device memory access and I/O coherence
    *Focus:* Cover Device memory access and I/O coherence by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Device memory access and I/O coherence, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - PCIe and DMA
    *Focus:* Cover PCIe and DMA by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate PCIe and DMA, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - IOMMU
    *Focus:* Cover IOMMU by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate IOMMU, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Intel DDIO
    *Focus:* Cover Intel DDIO by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Intel DDIO, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
- **Chapter 30: Latency reference**
  *Focus:* Provide a calibrated order-of-magnitude reference for compute, memory, synchronization, system-call, storage, and network delays without presenting estimates as universal constants.
  *Examples and visuals:* Include a logarithmic latency ladder, serialization calculations, and a table that records representative ranges alongside measurement caveats.
  - Time units orders of magnitude and conversions
    *Focus:* Cover Time units orders of magnitude and conversions by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Time units orders of magnitude and conversions, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.
  - Latency throughput and bandwidth
    *Focus:* Define and quantify Latency throughput and bandwidth, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Latency throughput and bandwidth, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - CPU and memory latency numbers
    *Focus:* Define and quantify CPU and memory latency numbers, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate CPU and memory latency numbers, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Synchronization and syscall latency numbers
    *Focus:* Define and quantify Synchronization and syscall latency numbers, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Synchronization and syscall latency numbers, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Network latency and serialization numbers
    *Focus:* Define and quantify Network latency and serialization numbers, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Network latency and serialization numbers, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Storage latency numbers
    *Focus:* Define and quantify Storage latency numbers, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Storage latency numbers, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Queueing load and tail latency
    *Focus:* Define and quantify Queueing load and tail latency, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Queueing load and tail latency, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Latency numbers as estimates not constants
    *Focus:* Define and quantify Latency numbers as estimates not constants, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Latency numbers as estimates not constants, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Measuring the target system instead of trusting tables
    *Focus:* Cover Measuring the target system instead of trusting tables by connecting the underlying mechanism to instruction execution, data movement, measurable bottlenecks, and low-latency optimization decisions.
    *Examples and visuals:* Use a focused microbenchmark or annotated assembly trace to demonstrate Measuring the target system instead of trusting tables, supported by a hardware data-path diagram and a table of expected counters, latency, and throughput effects.

## Linux and Operating Systems

- **Chapter 31: Processes threads and scheduling**
  *Focus:* Explain Linux task and thread creation, identity, lifecycle, scheduling, affinity, preemption, futexes, and kernel synchronization from a low-latency perspective.
  *Examples and visuals:* Include fork, clone, affinity, and scheduling-policy snippets, task and run-queue diagrams, and tables comparing scheduler classes and waiting primitives.
  - Concurrency processes and threads
    *Focus:* Cover Concurrency processes and threads from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Concurrency processes and threads, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Processes and address spaces
    *Focus:* Cover Processes and address spaces from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Processes and address spaces, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process IDs thread IDs and thread groups
    *Focus:* Cover Process IDs thread IDs and thread groups from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Process IDs thread IDs and thread groups, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process versus thread isolation and sharing
    *Focus:* Compare Process versus thread isolation and sharing by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Process versus thread isolation and sharing, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - fork and copy-on-write
    *Focus:* Cover fork and copy-on-write from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate fork and copy-on-write, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - exec and process replacement
    *Focus:* Cover exec and process replacement from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate exec and process replacement, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process states
    *Focus:* Cover Process states from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Process states, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process exit waiting and reaping
    *Focus:* Cover Process exit waiting and reaping from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Process exit waiting and reaping, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process reaping zombies and orphans
    *Focus:* Cover Process reaping zombies and orphans from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Process reaping zombies and orphans, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process groups sessions and daemons
    *Focus:* Cover Process groups sessions and daemons from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Process groups sessions and daemons, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - task_struct and the Linux task model
    *Focus:* Cover task_struct and the Linux task model from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate task_struct and the Linux task model, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Linux clone and task sharing
    *Focus:* Cover Linux clone and task sharing from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Linux clone and task sharing, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - clone3 and pidfds
    *Focus:* Cover clone3 and pidfds from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate clone3 and pidfds, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Kernel and user threads
    *Focus:* Cover Kernel and user threads from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Kernel and user threads, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Linux NPTL
    *Focus:* Cover Linux NPTL from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Linux NPTL, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Pthreads
    *Focus:* Cover Pthreads from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Pthreads, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Thread stacks and guard pages
    *Focus:* Cover Thread stacks and guard pages from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Thread stacks and guard pages, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Thread-local storage and thread control blocks
    *Focus:* Cover Thread-local storage and thread control blocks from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Thread-local storage and thread control blocks, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Fibers and user-space scheduling
    *Focus:* Cover Fibers and user-space scheduling from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Fibers and user-space scheduling, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Scheduling goals policy and mechanism
    *Focus:* Turn Scheduling goals policy and mechanism into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Scheduling goals policy and mechanism, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Context switches
    *Focus:* Cover Context switches from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Context switches, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Per-CPU run queues and scheduler classes
    *Focus:* Cover Per-CPU run queues and scheduler classes from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Per-CPU run queues and scheduler classes, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Nice values priorities and scheduling weights
    *Focus:* Cover Nice values priorities and scheduling weights from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Nice values priorities and scheduling weights, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Linux fair scheduling
    *Focus:* Cover Linux fair scheduling from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Linux fair scheduling, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Virtual runtime and EEVDF scheduling
    *Focus:* Cover Virtual runtime and EEVDF scheduling from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Virtual runtime and EEVDF scheduling, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Real-time scheduling policies
    *Focus:* Turn Real-time scheduling policies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Real-time scheduling policies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Scheduling domains load balancing and task migration
    *Focus:* Cover Scheduling domains load balancing and task migration from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Scheduling domains load balancing and task migration, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Scheduler run queues and wakeup latency
    *Focus:* Define and quantify Scheduler run queues and wakeup latency, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Scheduler run queues and wakeup latency, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Wake queues and the thundering-herd problem
    *Focus:* Cover Wake queues and the thundering-herd problem from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Wake queues and the thundering-herd problem, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Kernel preemption models and preemption points
    *Focus:* Cover Kernel preemption models and preemption points from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Kernel preemption models and preemption points, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - CPU affinity
    *Focus:* Cover CPU affinity from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate CPU affinity, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - CPU topology-aware pinning
    *Focus:* Cover CPU topology-aware pinning from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate CPU topology-aware pinning, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Core isolation
    *Focus:* Cover Core isolation from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Core isolation, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Housekeeping CPUs
    *Focus:* Cover Housekeeping CPUs from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Housekeeping CPUs, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Busy polling versus blocking
    *Focus:* Compare Busy polling versus blocking by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Busy polling versus blocking, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Futex wait wake and requeue operations
    *Focus:* Cover Futex wait wake and requeue operations from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Futex wait wake and requeue operations, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Priority-inheritance futexes
    *Focus:* Cover Priority-inheritance futexes from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Priority-inheritance futexes, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Restartable sequences
    *Focus:* Cover Restartable sequences from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Restartable sequences, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Linux kernel spinlocks mutexes and semaphores
    *Focus:* Cover Linux kernel spinlocks mutexes and semaphores from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Linux kernel spinlocks mutexes and semaphores, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Wait queues completions and sequence counters
    *Focus:* Cover Wait queues completions and sequence counters from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Wait queues completions and sequence counters, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Read-copy-update grace periods and callbacks
    *Focus:* Cover Read-copy-update grace periods and callbacks from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Read-copy-update grace periods and callbacks, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Interrupt softirq and process context
    *Focus:* Cover Interrupt softirq and process context from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Interrupt softirq and process context, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Lock ordering lockdep and concurrency debugging
    *Focus:* Cover Lock ordering lockdep and concurrency debugging from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Lock ordering lockdep and concurrency debugging, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Real-time scheduling operational hazards
    *Focus:* Cover Real-time scheduling operational hazards from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Real-time scheduling operational hazards, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
- **Chapter 32: Virtual memory**
  *Focus:* Trace Linux virtual memory from address spaces and page tables through faults, mappings, huge pages, page cache, reclaim, swapping, NUMA, and observability.
  *Examples and visuals:* Include mmap, mlock, madvise, and fault-measurement examples, address-space and page-table diagrams, and tables for fault types and memory-accounting metrics.
  - Why operating systems use virtual memory
    *Focus:* Answer why operating systems use virtual memory and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Why operating systems use virtual memory, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Virtual and physical addresses
    *Focus:* Cover Virtual and physical addresses from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Virtual and physical addresses, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process address-space layout
    *Focus:* Cover Process address-space layout from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Process address-space layout, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - mm_struct VMAs and the maple tree
    *Focus:* Cover mm_struct VMAs and the maple tree from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate mm_struct VMAs and the maple tree, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Heap growth with brk and mmap
    *Focus:* Cover Heap growth with brk and mmap from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Heap growth with brk and mmap, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Stack growth and guard pages
    *Focus:* Cover Stack growth and guard pages from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Stack growth and guard pages, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Address-space layout randomization
    *Focus:* Cover Address-space layout randomization from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Address-space layout randomization, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Anonymous and file-backed mmap
    *Focus:* Cover Anonymous and file-backed mmap from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Anonymous and file-backed mmap, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Shared and private mappings
    *Focus:* Cover Shared and private mappings from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Shared and private mappings, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - madvise
    *Focus:* Cover madvise from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate madvise, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - mprotect and memory protection changes
    *Focus:* Cover mprotect and memory protection changes from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate mprotect and memory protection changes, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Multi-level page tables
    *Focus:* Cover Multi-level page tables from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Multi-level page tables, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page-table entries and permission bits
    *Focus:* Cover Page-table entries and permission bits from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Page-table entries and permission bits, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Translation lookaside buffers
    *Focus:* Cover Translation lookaside buffers from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Translation lookaside buffers, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page walks
    *Focus:* Cover Page walks from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Page walks, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - TLB shootdowns
    *Focus:* Cover TLB shootdowns from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate TLB shootdowns, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page faults
    *Focus:* Cover Page faults from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Page faults, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Demand paging
    *Focus:* Cover Demand paging from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Demand paging, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Minor versus major page faults
    *Focus:* Compare Minor versus major page faults by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Minor versus major page faults, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - The Linux page-fault handling path
    *Focus:* Cover The Linux page-fault handling path from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate The Linux page-fault handling path, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Copy-on-write faults
    *Focus:* Cover Copy-on-write faults from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Copy-on-write faults, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - userfaultfd and user-space fault handling
    *Focus:* Cover userfaultfd and user-space fault handling from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate userfaultfd and user-space fault handling, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Memory locking
    *Focus:* Cover Memory locking from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Memory locking, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page prefaulting
    *Focus:* Cover Page prefaulting from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Page prefaulting, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page size and huge-page tradeoffs
    *Focus:* Compare Page size and huge-page tradeoffs by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Page size and huge-page tradeoffs, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Explicit huge pages
    *Focus:* Cover Explicit huge pages from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Explicit huge pages, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Transparent huge pages
    *Focus:* Cover Transparent huge pages from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Transparent huge pages, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Working sets
    *Focus:* Cover Working sets from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Working sets, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page cache
    *Focus:* Cover Page cache from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Page cache, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page-cache readahead
    *Focus:* Cover Page-cache readahead from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Page-cache readahead, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - msync and mapped-file writeback
    *Focus:* Cover msync and mapped-file writeback from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate msync and mapped-file writeback, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Dirty pages writeback and writeback throttling
    *Focus:* Cover Dirty pages writeback and writeback throttling from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Dirty pages writeback and writeback throttling, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Direct reclaim and background reclaim
    *Focus:* Cover Direct reclaim and background reclaim from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Direct reclaim and background reclaim, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Active inactive and multigenerational LRU reclaim
    *Focus:* Cover Active inactive and multigenerational LRU reclaim from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Active inactive and multigenerational LRU reclaim, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Anonymous reverse mapping
    *Focus:* Cover Anonymous reverse mapping from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Anonymous reverse mapping, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page migration compaction and fragmentation
    *Focus:* Trace the causes and consequences of Page migration compaction and fragmentation, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Page migration compaction and fragmentation, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Swapping
    *Focus:* Cover Swapping from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Swapping, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Swap cache zswap and compressed memory
    *Focus:* Cover Swap cache zswap and compressed memory from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Swap cache zswap and compressed memory, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Memory overcommit and the OOM killer
    *Focus:* Cover Memory overcommit and the OOM killer from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Memory overcommit and the OOM killer, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Memory cgroups and cgroup OOM behavior
    *Focus:* Cover Memory cgroups and cgroup OOM behavior from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Memory cgroups and cgroup OOM behavior, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Kernel same-page merging
    *Focus:* Cover Kernel same-page merging from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Kernel same-page merging, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - NUMA memory policies
    *Focus:* Turn NUMA memory policies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate NUMA memory policies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Automatic NUMA balancing
    *Focus:* Cover Automatic NUMA balancing from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Automatic NUMA balancing, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - NUMA page migration and misplaced-page faults
    *Focus:* Cover NUMA page migration and misplaced-page faults from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate NUMA page migration and misplaced-page faults, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Memory accounting and observability
    *Focus:* Cover Memory accounting and observability from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Memory accounting and observability, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - RSS VSZ and PSS
    *Focus:* Cover RSS VSZ and PSS from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate RSS VSZ and PSS, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Proportional-set and unique-set sizing
    *Focus:* Cover Proportional-set and unique-set sizing from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Proportional-set and unique-set sizing, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Procfs memory maps
    *Focus:* Cover Procfs memory maps from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Procfs memory maps, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Page-fault and reclaim observability
    *Focus:* Cover Page-fault and reclaim observability from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Page-fault and reclaim observability, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Memory pressure stall information
    *Focus:* Cover Memory pressure stall information from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Memory pressure stall information, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Shared-memory truncation and SIGBUS
    *Focus:* Cover Shared-memory truncation and SIGBUS from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Shared-memory truncation and SIGBUS, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Durable versus visible mapped writes
    *Focus:* Compare Durable versus visible mapped writes by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Durable versus visible mapped writes, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
- **Chapter 33: IPC and signals**
  *Focus:* Compare Linux interprocess communication mechanisms and explain how shared state, descriptor-based notifications, synchronization, and asynchronous signals interact.
  *Examples and visuals:* Include a pipe or shared-memory exchange and a safe signal-handling example, IPC data-flow diagrams, and a latency-and-semantics comparison table.
  - Why processes need interprocess communication
    *Focus:* Answer why processes need interprocess communication and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Why processes need interprocess communication, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Message passing versus shared memory
    *Focus:* Compare Message passing versus shared memory by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Message passing versus shared memory, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Pipes and FIFOs
    *Focus:* Cover Pipes and FIFOs from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Pipes and FIFOs, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - POSIX and System V message queues
    *Focus:* Cover POSIX and System V message queues from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate POSIX and System V message queues, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - UNIX-domain sockets
    *Focus:* Cover UNIX-domain sockets from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate UNIX-domain sockets, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - POSIX and System V shared memory
    *Focus:* Cover POSIX and System V shared memory from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate POSIX and System V shared memory, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Process-shared synchronization
    *Focus:* Cover Process-shared synchronization from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Process-shared synchronization, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - POSIX and System V semaphores
    *Focus:* Cover POSIX and System V semaphores from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate POSIX and System V semaphores, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Futexes
    *Focus:* Cover Futexes from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Futexes, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - eventfd
    *Focus:* Cover eventfd from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate eventfd, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - signalfd
    *Focus:* Cover signalfd from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate signalfd, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - timerfd
    *Focus:* Cover timerfd from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate timerfd, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Lock-free interprocess queues
    *Focus:* Cover Lock-free interprocess queues from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Lock-free interprocess queues, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Signals as asynchronous notifications
    *Focus:* Cover Signals as asynchronous notifications from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Signals as asynchronous notifications, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Signal delivery and disposition
    *Focus:* Cover Signal delivery and disposition from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Signal delivery and disposition, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - sigaction
    *Focus:* Cover sigaction from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate sigaction, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Signal masks
    *Focus:* Cover Signal masks from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Signal masks, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Async-signal safety
    *Focus:* Cover Async-signal safety from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Async-signal safety, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Alternate signal stacks
    *Focus:* Cover Alternate signal stacks from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Alternate signal stacks, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Core-dump signals and crash handlers
    *Focus:* Cover Core-dump signals and crash handlers from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Core-dump signals and crash handlers, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
- **Chapter 34: System calls and I/O**
  *Focus:* Explain the user-kernel boundary, Unix descriptor model, blocking and readiness APIs, zero-copy paths, direct I/O, and io_uring completion mechanics.
  *Examples and visuals:* Include robust short-I/O and epoll or io_uring loops, syscall and data-copy path diagrams, and tables comparing readiness, completion, and synchronous I/O.
  - User mode and kernel mode
    *Focus:* Cover User mode and kernel mode from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate User mode and kernel mode, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - System calls as the kernel API
    *Focus:* Cover System calls as the kernel API from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate System calls as the kernel API, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - System-call entry
    *Focus:* Cover System-call entry from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate System-call entry, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Mode switches versus context switches
    *Focus:* Compare Mode switches versus context switches by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Mode switches versus context switches, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - vDSO
    *Focus:* Cover vDSO from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate vDSO, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - System-call overhead
    *Focus:* Define and quantify System-call overhead, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate System-call overhead, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Unix file and byte-stream abstractions
    *Focus:* Cover Unix file and byte-stream abstractions from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Unix file and byte-stream abstractions, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - File descriptors and descriptor tables
    *Focus:* Cover File descriptors and descriptor tables from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate File descriptors and descriptor tables, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - open read write and close
    *Focus:* Cover open read write and close from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate open read write and close, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Descriptor duplication
    *Focus:* Cover Descriptor duplication from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Descriptor duplication, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - File offsets seek and append
    *Focus:* Cover File offsets seek and append from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate File offsets seek and append, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Short reads and writes
    *Focus:* Cover Short reads and writes from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Short reads and writes, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - EINTR and EAGAIN handling
    *Focus:* Cover EINTR and EAGAIN handling from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate EINTR and EAGAIN handling, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Blocking and non-blocking I/O
    *Focus:* Cover Blocking and non-blocking I/O from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Blocking and non-blocking I/O, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Synchronous and asynchronous I/O
    *Focus:* Cover Synchronous and asynchronous I/O from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Synchronous and asynchronous I/O, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - select and poll
    *Focus:* Cover select and poll from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate select and poll, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - epoll
    *Focus:* Cover epoll from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate epoll, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Edge-triggered and level-triggered readiness
    *Focus:* Cover Edge-triggered and level-triggered readiness from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Edge-triggered and level-triggered readiness, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - kqueue
    *Focus:* Cover kqueue from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate kqueue, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Scatter-gather I/O
    *Focus:* Cover Scatter-gather I/O from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Scatter-gather I/O, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - sendfile splice and zero-copy file I/O
    *Focus:* Cover sendfile splice and zero-copy file I/O from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate sendfile splice and zero-copy file I/O, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Direct I/O
    *Focus:* Cover Direct I/O from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Direct I/O, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - io_uring
    *Focus:* Cover io_uring from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate io_uring, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - io_uring architecture and submission queues
    *Focus:* Cover io_uring architecture and submission queues from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate io_uring architecture and submission queues, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - io_uring registered resources
    *Focus:* Cover io_uring registered resources from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate io_uring registered resources, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - io_uring polling modes
    *Focus:* Cover io_uring polling modes from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate io_uring polling modes, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - strace and ltrace
    *Focus:* Cover strace and ltrace from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate strace and ltrace, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
- **Chapter 35: Time and low-latency tuning**
  *Focus:* Cover Linux timekeeping and synchronization before presenting a measurement-led approach to controlling scheduler, power, interrupt, memory, and topology jitter.
  *Examples and visuals:* Include clock-reading and affinity scripts, clock-domain and tuning-topology diagrams, and a table of tuning knobs with benefits, risks, and verification methods.
  - Timekeeping clocks and timers
    *Focus:* Cover Timekeeping clocks and timers from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Timekeeping clocks and timers, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Linux clock sources
    *Focus:* Cover Linux clock sources from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Linux clock sources, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Monotonic realtime and raw clocks
    *Focus:* Cover Monotonic realtime and raw clocks from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Monotonic realtime and raw clocks, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - TSC synchronization and monotonicity
    *Focus:* Cover TSC synchronization and monotonicity from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate TSC synchronization and monotonicity, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Timer facilities
    *Focus:* Cover Timer facilities from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Timer facilities, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Timer wheels
    *Focus:* Cover Timer wheels from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Timer wheels, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Clock synchronization and timestamp domains
    *Focus:* Define and quantify Clock synchronization and timestamp domains, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Clock synchronization and timestamp domains, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - NTP synchronization
    *Focus:* Cover NTP synchronization from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate NTP synchronization, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - PTP synchronization
    *Focus:* Cover PTP synchronization from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate PTP synchronization, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - PTP hardware clocks
    *Focus:* Cover PTP hardware clocks from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate PTP hardware clocks, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Clock steps slews and leap seconds
    *Focus:* Cover Clock steps slews and leap seconds from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Clock steps slews and leap seconds, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Sources of latency jitter
    *Focus:* Define and quantify Sources of latency jitter, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Sources of latency jitter, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Measure tune and verify methodology
    *Focus:* Cover Measure tune and verify methodology from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Measure tune and verify methodology, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Sysctl procfs and sysfs tuning
    *Focus:* Cover Sysctl procfs and sysfs tuning from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Sysctl procfs and sysfs tuning, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - CPU frequency governors
    *Focus:* Cover CPU frequency governors from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate CPU frequency governors, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Turbo boost
    *Focus:* Cover Turbo boost from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Turbo boost, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - CPU C-states and P-states
    *Focus:* Cover CPU C-states and P-states from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate CPU C-states and P-states, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - IRQ affinity
    *Focus:* Cover IRQ affinity from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate IRQ affinity, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Softirqs and kernel workqueues
    *Focus:* Cover Softirqs and kernel workqueues from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Softirqs and kernel workqueues, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Kernel command-line isolation options
    *Focus:* Cover Kernel command-line isolation options from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate Kernel command-line isolation options, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - PREEMPT_RT
    *Focus:* Cover PREEMPT_RT from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate PREEMPT_RT, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - cyclictest
    *Focus:* Cover cyclictest from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate cyclictest, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - Transparent-huge-page latency spikes
    *Focus:* Define and quantify Transparent-huge-page latency spikes, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Transparent-huge-page latency spikes, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - cgroups and namespaces
    *Focus:* Cover cgroups and namespaces from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate cgroups and namespaces, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - eBPF ftrace and bpftrace
    *Focus:* Cover eBPF ftrace and bpftrace from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate eBPF ftrace and bpftrace, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.
  - PCIe topology for device locality
    *Focus:* Cover PCIe topology for device locality from both application and Linux-kernel viewpoints, emphasizing lifecycle, state transitions, resource costs, latency, and operational hazards.
    *Examples and visuals:* Use a minimal syscall, diagnostic, or tracing example to demonstrate PCIe topology for device locality, supported by a user-kernel state or data-path diagram and a table of costs, states, and failure modes.

## Networking Fundamentals

- **Chapter 36: Ethernet and IP**
  *Focus:* Establish packet-networking fundamentals from layering and Ethernet framing through addressing, discovery, routing, fragmentation, NAT, and ICMP diagnostics.
  *Examples and visuals:* Include header-decoding and CIDR exercises, encapsulation and forwarding diagrams, and tables for Ethernet and IP header fields and overhead.
  - Networks hosts links packets and protocols
    *Focus:* Cover Networks hosts links packets and protocols through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Networks hosts links packets and protocols, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - OSI and TCP-IP models
    *Focus:* Cover OSI and TCP-IP models through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate OSI and TCP-IP models, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Encapsulation and protocol headers
    *Focus:* Cover Encapsulation and protocol headers through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Encapsulation and protocol headers, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Unicast broadcast and multicast delivery
    *Focus:* Cover Unicast broadcast and multicast delivery through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Unicast broadcast and multicast delivery, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Network byte order
    *Focus:* Cover Network byte order through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Network byte order, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Internet checksums
    *Focus:* Cover Internet checksums through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Internet checksums, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Ethernet frames
    *Focus:* Cover Ethernet frames through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Ethernet frames, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Ethernet on-wire overhead
    *Focus:* Define and quantify Ethernet on-wire overhead, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Ethernet on-wire overhead, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - MAC addressing
    *Focus:* Cover MAC addressing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate MAC addressing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - VLAN tagging
    *Focus:* Cover VLAN tagging through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate VLAN tagging, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - MTU and jumbo frames
    *Focus:* Cover MTU and jumbo frames through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate MTU and jumbo frames, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Ethernet switching and MAC learning
    *Focus:* Cover Ethernet switching and MAC learning through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Ethernet switching and MAC learning, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - IPv4 addressing and CIDR
    *Focus:* Cover IPv4 addressing and CIDR through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate IPv4 addressing and CIDR, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Subnets gateways and default routes
    *Focus:* Cover Subnets gateways and default routes through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Subnets gateways and default routes, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - IPv6 fundamentals
    *Focus:* Cover IPv6 fundamentals through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate IPv6 fundamentals, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - IP headers
    *Focus:* Cover IP headers through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate IP headers, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - ARP
    *Focus:* Cover ARP through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate ARP, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - IPv6 neighbor discovery
    *Focus:* Cover IPv6 neighbor discovery through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate IPv6 neighbor discovery, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Routing tables and longest-prefix matching
    *Focus:* Cover Routing tables and longest-prefix matching through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Routing tables and longest-prefix matching, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Switching and routing
    *Focus:* Cover Switching and routing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Switching and routing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - IP fragmentation
    *Focus:* Trace the causes and consequences of IP fragmentation, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate IP fragmentation, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - TTL and hop limits
    *Focus:* Cover TTL and hop limits through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TTL and hop limits, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - NAT
    *Focus:* Cover NAT through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate NAT, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - ICMP ping and traceroute
    *Focus:* Cover ICMP ping and traceroute through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate ICMP ping and traceroute, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
- **Chapter 37: UDP and multicast**
  *Focus:* Explain UDP datagram behavior and then build the multicast membership, delivery, failure, sequencing, and recovery model used by exchange market-data feeds.
  *Examples and visuals:* Include UDP sender-receiver and multicast-join snippets, multicast network and recovery-flow diagrams, and a table of loss and redundancy strategies.
  - UDP semantics and datagrams
    *Focus:* Cover UDP semantics and datagrams through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate UDP semantics and datagrams, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - UDP ports and socket demultiplexing
    *Focus:* Cover UDP ports and socket demultiplexing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate UDP ports and socket demultiplexing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - UDP headers and checksums
    *Focus:* Cover UDP headers and checksums through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate UDP headers and checksums, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Datagram size MTU and fragmentation
    *Focus:* Trace the causes and consequences of Datagram size MTU and fragmentation, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Datagram size MTU and fragmentation, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - UDP loss duplication and reordering
    *Focus:* Trace the causes and consequences of UDP loss duplication and reordering, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate UDP loss duplication and reordering, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Application-level loss recovery
    *Focus:* Trace the causes and consequences of Application-level loss recovery, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Application-level loss recovery, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Sequence-number gap detection
    *Focus:* Cover Sequence-number gap detection through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Sequence-number gap detection, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Unicast broadcast and multicast comparison
    *Focus:* Compare Unicast broadcast and multicast comparison by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Unicast broadcast and multicast comparison, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - IP multicast groups
    *Focus:* Cover IP multicast groups through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate IP multicast groups, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - IGMP
    *Focus:* Cover IGMP through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate IGMP, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Source-specific multicast
    *Focus:* Cover Source-specific multicast through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Source-specific multicast, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Multicast NIC filtering
    *Focus:* Cover Multicast NIC filtering through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Multicast NIC filtering, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - IGMP snooping and queriers
    *Focus:* Cover IGMP snooping and queriers through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate IGMP snooping and queriers, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Multicast routing failures
    *Focus:* Trace the causes and consequences of Multicast routing failures, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Multicast routing failures, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Reliable multicast patterns
    *Focus:* Cover Reliable multicast patterns through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Reliable multicast patterns, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Retransmission channels
    *Focus:* Cover Retransmission channels through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Retransmission channels, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Snapshot recovery
    *Focus:* Cover Snapshot recovery through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Snapshot recovery, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Redundant multicast feeds
    *Focus:* Cover Redundant multicast feeds through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Redundant multicast feeds, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
- **Chapter 38: TCP**
  *Focus:* Build TCP from byte-stream and connection semantics through reliability, flow control, congestion control, latency options, teardown, and application framing.
  *Examples and visuals:* Include a framed-message client and server, sequence-space and congestion-window diagrams, and a table explaining common socket options and their tradeoffs.
  - TCP byte-stream semantics
    *Focus:* Cover TCP byte-stream semantics through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP byte-stream semantics, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP endpoints sockets and connections
    *Focus:* Cover TCP endpoints sockets and connections through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP endpoints sockets and connections, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP three-way handshake
    *Focus:* Cover TCP three-way handshake through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP three-way handshake, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP sequence and acknowledgement numbers
    *Focus:* Cover TCP sequence and acknowledgement numbers through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP sequence and acknowledgement numbers, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Reliable delivery retransmission and duplicate suppression
    *Focus:* Cover Reliable delivery retransmission and duplicate suppression through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Reliable delivery retransmission and duplicate suppression, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - RTT estimation and retransmission timeout
    *Focus:* Cover RTT estimation and retransmission timeout through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate RTT estimation and retransmission timeout, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Selective acknowledgements
    *Focus:* Cover Selective acknowledgements through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Selective acknowledgements, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP flow control
    *Focus:* Cover TCP flow control through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP flow control, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Receive windows window scaling and MSS
    *Focus:* Cover Receive windows window scaling and MSS through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Receive windows window scaling and MSS, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP congestion control
    *Focus:* Cover TCP congestion control through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP congestion control, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Slow start and congestion avoidance
    *Focus:* Cover Slow start and congestion avoidance through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Slow start and congestion avoidance, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Fast retransmit and recovery
    *Focus:* Cover Fast retransmit and recovery through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Fast retransmit and recovery, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Reno CUBIC and BBR
    *Focus:* Cover Reno CUBIC and BBR through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Reno CUBIC and BBR, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Bandwidth-delay product
    *Focus:* Define and quantify Bandwidth-delay product, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Bandwidth-delay product, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Bufferbloat
    *Focus:* Cover Bufferbloat through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Bufferbloat, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Nagle algorithm
    *Focus:* Cover Nagle algorithm through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Nagle algorithm, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Delayed acknowledgements
    *Focus:* Cover Delayed acknowledgements through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Delayed acknowledgements, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP_NODELAY QUICKACK and CORK
    *Focus:* Cover TCP_NODELAY QUICKACK and CORK through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP_NODELAY QUICKACK and CORK, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP head-of-line blocking
    *Focus:* Cover TCP head-of-line blocking through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP head-of-line blocking, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP connection teardown
    *Focus:* Cover TCP connection teardown through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP connection teardown, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP half-close and reconnect behavior
    *Focus:* Cover TCP half-close and reconnect behavior through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP half-close and reconnect behavior, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP keepalive
    *Focus:* Cover TCP keepalive through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP keepalive, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TIME_WAIT
    *Focus:* Cover TIME_WAIT through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TIME_WAIT, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP message framing
    *Focus:* Cover TCP message framing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP message framing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
- **Chapter 39: Switching behavior**
  *Focus:* Explain how Ethernet switches learn and forward frames and how architecture, buffering, contention, hashing, flow control, and redundancy affect latency and ordering.
  *Examples and visuals:* Include serialization and microburst calculations, switch-fabric and queue diagrams, and a table comparing store-and-forward, cut-through, and buffering designs.
  - Layer-2 switches bridges and forwarding databases
    *Focus:* Cover Layer-2 switches bridges and forwarding databases through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Layer-2 switches bridges and forwarding databases, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - MAC learning flooding and aging
    *Focus:* Cover MAC learning flooding and aging through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate MAC learning flooding and aging, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Store-and-forward switching
    *Focus:* Cover Store-and-forward switching through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Store-and-forward switching, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Cut-through switching
    *Focus:* Cover Cut-through switching through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Cut-through switching, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Serialization delay
    *Focus:* Cover Serialization delay through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Serialization delay, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Propagation processing and queueing delay
    *Focus:* Cover Propagation processing and queueing delay through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Propagation processing and queueing delay, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Switch output-port contention
    *Focus:* Cover Switch output-port contention through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Switch output-port contention, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Network microbursts
    *Focus:* Cover Network microbursts through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Network microbursts, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Shallow and deep switch buffers
    *Focus:* Cover Shallow and deep switch buffers through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Shallow and deep switch buffers, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Switch head-of-line blocking
    *Focus:* Cover Switch head-of-line blocking through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Switch head-of-line blocking, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Switch fabrics input queues and output queues
    *Focus:* Cover Switch fabrics input queues and output queues through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Switch fabrics input queues and output queues, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - ECMP and LAG hashing
    *Focus:* Cover ECMP and LAG hashing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate ECMP and LAG hashing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Packet reordering
    *Focus:* Cover Packet reordering through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Packet reordering, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Ethernet flow control and PFC
    *Focus:* Cover Ethernet flow control and PFC through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Ethernet flow control and PFC, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Redundant network paths
    *Focus:* Cover Redundant network paths through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Redundant network paths, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Layer-2 loops and spanning tree
    *Focus:* Cover Layer-2 loops and spanning tree through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Layer-2 loops and spanning tree, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.

## Performance Engineering

- **Chapter 40: Compiler optimization**
  *Focus:* Explain what optimizing compilers may transform, how major optimization passes work, and how flags, aliasing, LTO, profiles, and post-link tools influence generated code.
  *Examples and visuals:* Include before-and-after assembly examples, an optimization-pipeline diagram, and tables connecting optimization reports and compiler flags to likely remedies and risks.
  - The as-if rule and observable behavior
    *Focus:* Cover The as-if rule and observable behavior as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate The as-if rule and observable behavior, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Debug release and optimized builds
    *Focus:* Cover Debug release and optimized builds as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Debug release and optimized builds, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Compiler optimization levels
    *Focus:* Cover Compiler optimization levels as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Compiler optimization levels, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - CPU architecture and tuning flags
    *Focus:* Cover CPU architecture and tuning flags as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate CPU architecture and tuning flags, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Undefined behavior and optimization assumptions
    *Focus:* Cover Undefined behavior and optimization assumptions as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Undefined behavior and optimization assumptions, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Inspecting generated code
    *Focus:* Cover Inspecting generated code as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Inspecting generated code, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Constant folding and propagation
    *Focus:* Cover Constant folding and propagation as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Constant folding and propagation, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Dead-code elimination
    *Focus:* Cover Dead-code elimination as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Dead-code elimination, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Common-subexpression elimination
    *Focus:* Cover Common-subexpression elimination as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Common-subexpression elimination, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Inlining heuristics
    *Focus:* Cover Inlining heuristics as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Inlining heuristics, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Forced inline and noinline attributes
    *Focus:* Cover Forced inline and noinline attributes as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Forced inline and noinline attributes, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Branch probability hints
    *Focus:* Cover Branch probability hints as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Branch probability hints, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Restrict and alias analysis
    *Focus:* Cover Restrict and alias analysis as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Restrict and alias analysis, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Strict-aliasing optimizations
    *Focus:* Cover Strict-aliasing optimizations as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Strict-aliasing optimizations, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Loop unrolling
    *Focus:* Cover Loop unrolling as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Loop unrolling, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Automatic vectorization
    *Focus:* Cover Automatic vectorization as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Automatic vectorization, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Escape analysis
    *Focus:* Cover Escape analysis as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Escape analysis, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Interprocedural optimization
    *Focus:* Cover Interprocedural optimization as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Interprocedural optimization, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Link-time optimization
    *Focus:* Cover Link-time optimization as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Link-time optimization, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Identical-code folding
    *Focus:* Cover Identical-code folding as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Identical-code folding, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Section garbage collection
    *Focus:* Cover Section garbage collection as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Section garbage collection, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Profile-guided optimization
    *Focus:* Cover Profile-guided optimization as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Profile-guided optimization, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - AutoFDO
    *Focus:* Cover AutoFDO as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate AutoFDO, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - BOLT post-link optimization
    *Focus:* Cover BOLT post-link optimization as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate BOLT post-link optimization, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Optimization remarks and missed-optimization reports
    *Focus:* Cover Optimization remarks and missed-optimization reports as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Optimization remarks and missed-optimization reports, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
- **Chapter 41: Assembly binaries and ABI**
  *Focus:* Teach enough x86-64, AArch64, calling convention, ELF, relocation, linking, and unwind knowledge to explain compiler output and production stack traces.
  *Examples and visuals:* Include annotated disassemblies and ELF inspection commands, stack-frame and PLT/GOT diagrams, and tables for registers, argument passing, and section roles.
  - Machine code assembly and disassembly
    *Focus:* Cover Machine code assembly and disassembly as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Machine code assembly and disassembly, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Instructions operands registers and flags
    *Focus:* Cover Instructions operands registers and flags as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Instructions operands registers and flags, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - x86-64 registers flags and addressing
    *Focus:* Cover x86-64 registers flags and addressing as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate x86-64 registers flags and addressing, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Reading x86-64 assembly
    *Focus:* Cover Reading x86-64 assembly as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Reading x86-64 assembly, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Common compiler assembly idioms
    *Focus:* Cover Common compiler assembly idioms as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Common compiler assembly idioms, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - AArch64 assembly fundamentals
    *Focus:* Cover AArch64 assembly fundamentals as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate AArch64 assembly fundamentals, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Application binary interfaces
    *Focus:* Cover Application binary interfaces as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Application binary interfaces, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - System V AMD64 calling convention
    *Focus:* Cover System V AMD64 calling convention as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate System V AMD64 calling convention, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Stack alignment and the red zone
    *Focus:* Cover Stack alignment and the red zone as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Stack alignment and the red zone, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Caller-saved and callee-saved registers
    *Focus:* Cover Caller-saved and callee-saved registers as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Caller-saved and callee-saved registers, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Structure parameter and return ABI
    *Focus:* Cover Structure parameter and return ABI as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Structure parameter and return ABI, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Tail calls
    *Focus:* Cover Tail calls as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Tail calls, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - ELF sections and segments
    *Focus:* Cover ELF sections and segments as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate ELF sections and segments, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - ELF symbols and relocations
    *Focus:* Cover ELF symbols and relocations as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate ELF symbols and relocations, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - PLT GOT and position-independent code
    *Focus:* Cover PLT GOT and position-independent code as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate PLT GOT and position-independent code, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Dynamic linking
    *Focus:* Cover Dynamic linking as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Dynamic linking, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Binary inspection tools
    *Focus:* Cover Binary inspection tools as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Binary inspection tools, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Debug information and symbolization
    *Focus:* Cover Debug information and symbolization as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Debug information and symbolization, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Stack unwinding and frame pointers
    *Focus:* Cover Stack unwinding and frame pointers as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Stack unwinding and frame pointers, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Code layout and cold splitting
    *Focus:* Cover Code layout and cold splitting as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Code layout and cold splitting, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
- **Chapter 42: CPU-conscious optimization**
  *Focus:* Turn profiles into CPU-aware changes involving data layout, locality, branches, dependencies, SIMD, alignment, tiling, and non-temporal memory operations.
  *Examples and visuals:* Include measured scalar and optimized kernels, dependency-chain and SIMD-lane diagrams, and a table separating broadly useful techniques from architecture-specific hazards.
  - Profile-guided bottleneck selection
    *Focus:* Cover Profile-guided bottleneck selection as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Profile-guided bottleneck selection, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Data-oriented design
    *Focus:* Cover Data-oriented design as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Data-oriented design, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Array-of-structures versus structure-of-arrays
    *Focus:* Compare Array-of-structures versus structure-of-arrays by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Array-of-structures versus structure-of-arrays, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Alignment for cache lines and SIMD
    *Focus:* Cover Alignment for cache lines and SIMD as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Alignment for cache lines and SIMD, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Loop tiling and blocking
    *Focus:* Cover Loop tiling and blocking as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Loop tiling and blocking, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Dependency chains and critical paths
    *Focus:* Cover Dependency chains and critical paths as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Dependency chains and critical paths, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Software pipelining
    *Focus:* Cover Software pipelining as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Software pipelining, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Branchless programming
    *Focus:* Cover Branchless programming as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Branchless programming, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Conditional moves
    *Focus:* Cover Conditional moves as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Conditional moves, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Lookup-table optimization
    *Focus:* Cover Lookup-table optimization as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Lookup-table optimization, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Scalar versus vector execution
    *Focus:* Compare Scalar versus vector execution by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Scalar versus vector execution, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - SIMD intrinsics
    *Focus:* Cover SIMD intrinsics as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate SIMD intrinsics, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Partial-register and false dependencies
    *Focus:* Cover Partial-register and false dependencies as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Partial-register and false dependencies, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - AVX-SSE transition penalties
    *Focus:* Cover AVX-SSE transition penalties as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate AVX-SSE transition penalties, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - SIMD frequency downclocking
    *Focus:* Cover SIMD frequency downclocking as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate SIMD frequency downclocking, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Non-temporal memory access
    *Focus:* Cover Non-temporal memory access as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Non-temporal memory access, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
- **Chapter 43: Measurement and profiling**
  *Focus:* Teach candidates to design trustworthy performance experiments, interpret distributions and tail latency, control noise, and select profiling tools without introducing misleading probe effects.
  *Examples and visuals:* Include a flawed and corrected benchmark, histogram and coordinated-omission diagrams, and a table mapping performance questions to counters, profilers, and experimental controls.
  - Questions hypotheses and performance experiments
    *Focus:* Cover Questions hypotheses and performance experiments as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Questions hypotheses and performance experiments, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Latency versus throughput
    *Focus:* Compare Latency versus throughput by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Latency versus throughput, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Mean median variance and distributions
    *Focus:* Cover Mean median variance and distributions as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Mean median variance and distributions, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Tail-latency percentiles
    *Focus:* Define and quantify Tail-latency percentiles, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Tail-latency percentiles, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Histograms and HDR Histogram
    *Focus:* Cover Histograms and HDR Histogram as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Histograms and HDR Histogram, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Correct quantile aggregation
    *Focus:* Define and quantify Correct quantile aggregation, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Correct quantile aggregation, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Coordinated omission
    *Focus:* Trace the causes and consequences of Coordinated omission, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Coordinated omission, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Clock selection resolution and measurement overhead
    *Focus:* Define and quantify Clock selection resolution and measurement overhead, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Clock selection resolution and measurement overhead, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Benchmark warmup
    *Focus:* Define and quantify Benchmark warmup, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Benchmark warmup, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Sample size confidence and repeatability
    *Focus:* Cover Sample size confidence and repeatability as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Sample size confidence and repeatability, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Outliers and jitter sources
    *Focus:* Cover Outliers and jitter sources as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Outliers and jitter sources, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Benchmark isolation
    *Focus:* Define and quantify Benchmark isolation, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Benchmark isolation, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - CPU affinity and frequency control for benchmarks
    *Focus:* Define and quantify CPU affinity and frequency control for benchmarks, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate CPU affinity and frequency control for benchmarks, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - NUMA-aware benchmarking
    *Focus:* Cover NUMA-aware benchmarking as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate NUMA-aware benchmarking, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Google Benchmark barriers
    *Focus:* Define and quantify Google Benchmark barriers, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Google Benchmark barriers, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - RDTSC and RDTSCP timing
    *Focus:* Define and quantify RDTSC and RDTSCP timing, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate RDTSC and RDTSCP timing, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - TSC-to-time calibration
    *Focus:* Cover TSC-to-time calibration as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate TSC-to-time calibration, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Profiling sampling versus instrumentation
    *Focus:* Compare Profiling sampling versus instrumentation by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Profiling sampling versus instrumentation, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Hardware performance counters
    *Focus:* Cover Hardware performance counters as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Hardware performance counters, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - perf stat
    *Focus:* Cover perf stat as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate perf stat, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - perf record report and annotate
    *Focus:* Cover perf record report and annotate as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate perf record report and annotate, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Flame graphs
    *Focus:* Cover Flame graphs as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Flame graphs, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - PMU multiplexing skid and sampling bias
    *Focus:* Cover PMU multiplexing skid and sampling bias as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate PMU multiplexing skid and sampling bias, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Top-down microarchitecture analysis
    *Focus:* Cover Top-down microarchitecture analysis as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Top-down microarchitecture analysis, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Cachegrind and Callgrind
    *Focus:* Cover Cachegrind and Callgrind as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Cachegrind and Callgrind, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Intel VTune
    *Focus:* Cover Intel VTune as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Intel VTune, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - LIKWID and Intel PCM
    *Focus:* Cover LIKWID and Intel PCM as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate LIKWID and Intel PCM, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
  - Allocation profiling
    *Focus:* Define and quantify Allocation profiling, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Allocation profiling, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Lock-contention profiling
    *Focus:* Define and quantify Lock-contention profiling, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Lock-contention profiling, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Off-CPU profiling
    *Focus:* Define and quantify Off-CPU profiling, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Off-CPU profiling, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Probe effects
    *Focus:* Cover Probe effects as a performance-engineering tool or mechanism, including assumptions, evidence, interpretation, limitations, and effects on generated or running code.
    *Examples and visuals:* Use a reproducible benchmark, compiler output, or tool session to demonstrate Probe effects, supported by a before-and-after or measurement-flow diagram and a table for interpreting results and tradeoffs.
- **Chapter 44: Build and analysis tooling**
  *Focus:* Present a practical C++ build and analysis workflow covering target-based CMake, warnings, static analysis, sanitizers, compile-time control, reproducibility, and ABI compatibility.
  *Examples and visuals:* Include a minimal multi-target CMake project and sanitizer failure examples, a dependency-graph diagram, and a table matching bug classes to analysis tools.
  - Build configurations targets and dependency graphs
    *Focus:* Cover Build configurations targets and dependency graphs as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Build configurations targets and dependency graphs, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - CMake target model
    *Focus:* Cover CMake target model as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate CMake target model, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Public private and interface dependencies
    *Focus:* Cover Public private and interface dependencies as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Public private and interface dependencies, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Incremental and clean builds
    *Focus:* Cover Incremental and clean builds as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Incremental and clean builds, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Compiler warnings
    *Focus:* Cover Compiler warnings as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Compiler warnings, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Static analysis
    *Focus:* Cover Static analysis as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Static analysis, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Compiler Explorer
    *Focus:* Cover Compiler Explorer as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Compiler Explorer, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - AddressSanitizer
    *Focus:* Cover AddressSanitizer as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate AddressSanitizer, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - UndefinedBehaviorSanitizer
    *Focus:* Cover UndefinedBehaviorSanitizer as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate UndefinedBehaviorSanitizer, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - ThreadSanitizer
    *Focus:* Cover ThreadSanitizer as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate ThreadSanitizer, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - MemorySanitizer
    *Focus:* Cover MemorySanitizer as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate MemorySanitizer, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - LeakSanitizer
    *Focus:* Cover LeakSanitizer as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate LeakSanitizer, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Valgrind Memcheck
    *Focus:* Cover Valgrind Memcheck as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Valgrind Memcheck, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Reducing C++ compile times
    *Focus:* Cover Reducing C++ compile times as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Reducing C++ compile times, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Precompiled headers and unity builds
    *Focus:* Cover Precompiled headers and unity builds as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Precompiled headers and unity builds, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - PIMPL
    *Focus:* Cover PIMPL as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate PIMPL, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Reproducible and hermetic builds
    *Focus:* Cover Reproducible and hermetic builds as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Reproducible and hermetic builds, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - Dependency pinning and build provenance
    *Focus:* Cover Dependency pinning and build provenance as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate Dependency pinning and build provenance, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.
  - ABI compatibility and symbol versioning
    *Focus:* Cover ABI compatibility and symbol versioning as part of a reliable C++ build and analysis workflow, emphasizing configuration, evidence, defect coverage, limitations, reproducibility, and developer cost.
    *Examples and visuals:* Use a minimal project, failing program, or tool invocation to demonstrate ABI compatibility and symbol versioning, supported by a dependency or analysis-flow diagram and a table of inputs, findings, blind spots, and remediation steps.

## Trading-Grade Networking

- **Chapter 45: Socket programming**
  *Focus:* Develop robust Linux socket code from endpoint creation and lifecycle through partial I/O, non-blocking loops, batching, timestamps, error queues, filtering, busy polling, and zero copy.
  *Examples and visuals:* Include small UDP and TCP event-loop programs, socket-state and buffer-ownership diagrams, and tables for syscalls, flags, ancillary data, and completion semantics.
  - Sockets endpoints and address families
    *Focus:* Cover Sockets endpoints and address families through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Sockets endpoints and address families, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Stream datagram and raw socket types
    *Focus:* Cover Stream datagram and raw socket types through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Stream datagram and raw socket types, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket lifecycle
    *Focus:* Cover Socket lifecycle through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Socket lifecycle, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Binding listening accepting and connecting
    *Focus:* Cover Binding listening accepting and connecting through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Binding listening accepting and connecting, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Datagram send and receive
    *Focus:* Cover Datagram send and receive through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Datagram send and receive, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Stream send and receive
    *Focus:* Cover Stream send and receive through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Stream send and receive, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Partial TCP I/O
    *Focus:* Cover Partial TCP I/O through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Partial TCP I/O, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Blocking non-blocking and timeout behavior
    *Focus:* Cover Blocking non-blocking and timeout behavior through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Blocking non-blocking and timeout behavior, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket errors and asynchronous error reporting
    *Focus:* Trace the causes and consequences of Socket errors and asynchronous error reporting, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Socket errors and asynchronous error reporting, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Socket shutdown and close
    *Focus:* Cover Socket shutdown and close through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Socket shutdown and close, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket address and port reuse
    *Focus:* Cover Socket address and port reuse through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Socket address and port reuse, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket buffer sizing
    *Focus:* Cover Socket buffer sizing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Socket buffer sizing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Non-blocking socket event loops
    *Focus:* Cover Non-blocking socket event loops through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Non-blocking socket event loops, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Batched datagram syscalls
    *Focus:* Cover Batched datagram syscalls through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Batched datagram syscalls, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - recvmsg ancillary data
    *Focus:* Cover recvmsg ancillary data through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate recvmsg ancillary data, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket timestamp options
    *Focus:* Define and quantify Socket timestamp options, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Socket timestamp options, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Linux socket error queue
    *Focus:* Trace the causes and consequences of Linux socket error queue, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Linux socket error queue, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Busy-poll socket options
    *Focus:* Cover Busy-poll socket options through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Busy-poll socket options, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - BPF socket filters
    *Focus:* Cover BPF socket filters through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate BPF socket filters, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - MSG_ZEROCOPY
    *Focus:* Cover MSG_ZEROCOPY through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate MSG_ZEROCOPY, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Zero-copy completion ownership
    *Focus:* Cover Zero-copy completion ownership through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Zero-copy completion ownership, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
- **Chapter 46: Linux network stack**
  *Focus:* Trace packets through Linux receive and transmit paths and explain the costs and controls associated with NAPI, sk_buffs, routing, queues, offloads, steering, namespaces, filtering, and drops.
  *Examples and visuals:* Include packet-path tracing commands or eBPF snippets, detailed RX and TX diagrams, and a table mapping tuning knobs and counters to each stage.
  - Linux networking objects and packet flow
    *Focus:* Cover Linux networking objects and packet flow through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Linux networking objects and packet flow, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - net_device network namespaces and per-network state
    *Focus:* Cover net_device network namespaces and per-network state through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate net_device network namespaces and per-network state, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - NIC DMA descriptor rings
    *Focus:* Cover NIC DMA descriptor rings through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate NIC DMA descriptor rings, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Kernel receive path
    *Focus:* Cover Kernel receive path through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Kernel receive path, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Interrupt-driven packet processing
    *Focus:* Cover Interrupt-driven packet processing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Interrupt-driven packet processing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Interrupt coalescing tradeoffs
    *Focus:* Compare Interrupt coalescing tradeoffs by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Interrupt coalescing tradeoffs, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - NAPI polling
    *Focus:* Cover NAPI polling through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate NAPI polling, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Interrupt softirqs and the networking backlog
    *Focus:* Cover Interrupt softirqs and the networking backlog through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Interrupt softirqs and the networking backlog, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Receive and transmit budget exhaustion
    *Focus:* Trace the causes and consequences of Receive and transmit budget exhaustion, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Receive and transmit budget exhaustion, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - sk_buff
    *Focus:* Cover sk_buff through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate sk_buff, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - sk_buff allocation cloning and linearization costs
    *Focus:* Define and quantify sk_buff allocation cloning and linearization costs, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate sk_buff allocation cloning and linearization costs, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Ethernet IP UDP and TCP protocol demultiplexing
    *Focus:* Cover Ethernet IP UDP and TCP protocol demultiplexing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Ethernet IP UDP and TCP protocol demultiplexing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Routing-policy and destination-cache lookups
    *Focus:* Turn Routing-policy and destination-cache lookups into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Routing-policy and destination-cache lookups, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Neighbor tables ARP and NDP state machines
    *Focus:* Cover Neighbor tables ARP and NDP state machines through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Neighbor tables ARP and NDP state machines, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket receive and send queues
    *Focus:* Cover Socket receive and send queues through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Socket receive and send queues, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket memory accounting and autotuning
    *Focus:* Cover Socket memory accounting and autotuning through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Socket memory accounting and autotuning, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Kernel transmit path
    *Focus:* Cover Kernel transmit path through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Kernel transmit path, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Queueing disciplines and traffic control
    *Focus:* Cover Queueing disciplines and traffic control through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Queueing disciplines and traffic control, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCP small queues and byte queue limits
    *Focus:* Cover TCP small queues and byte queue limits through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCP small queues and byte queue limits, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Segmentation aggregation and checksum offload
    *Focus:* Cover Segmentation aggregation and checksum offload through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Segmentation aggregation and checksum offload, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - GRO and LRO
    *Focus:* Cover GRO and LRO through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate GRO and LRO, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - GSO and TSO
    *Focus:* Cover GSO and TSO through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate GSO and TSO, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Checksum offload
    *Focus:* Cover Checksum offload through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Checksum offload, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Multi-queue scaling and flow steering
    *Focus:* Cover Multi-queue scaling and flow steering through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Multi-queue scaling and flow steering, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Receive-side scaling
    *Focus:* Cover Receive-side scaling through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Receive-side scaling, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - RPS RFS and XPS
    *Focus:* Cover RPS RFS and XPS through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate RPS RFS and XPS, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Flow steering
    *Focus:* Cover Flow steering through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Flow steering, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Per-queue interrupt affinity
    *Focus:* Cover Per-queue interrupt affinity through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Per-queue interrupt affinity, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Virtual networking and packet filtering
    *Focus:* Cover Virtual networking and packet filtering through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Virtual networking and packet filtering, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Network namespaces veth pairs bridges and routing
    *Focus:* Cover Network namespaces veth pairs bridges and routing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Network namespaces veth pairs bridges and routing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Netfilter conntrack and NAT costs
    *Focus:* Define and quantify Netfilter conntrack and NAT costs, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Netfilter conntrack and NAT costs, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - SO_REUSEPORT load distribution and BPF selection
    *Focus:* Cover SO_REUSEPORT load distribution and BPF selection through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate SO_REUSEPORT load distribution and BPF selection, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - XDP traffic-control and socket BPF hook points
    *Focus:* Cover XDP traffic-control and socket BPF hook points through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate XDP traffic-control and socket BPF hook points, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Network-stack sysctls and per-route metrics
    *Focus:* Cover Network-stack sysctls and per-route metrics through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Network-stack sysctls and per-route metrics, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Socket busy polling and NAPI IDs
    *Focus:* Cover Socket busy polling and NAPI IDs through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Socket busy polling and NAPI IDs, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Packet-path observability and drop diagnosis
    *Focus:* Trace the causes and consequences of Packet-path observability and drop diagnosis, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Packet-path observability and drop diagnosis, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - NIC and kernel packet-drop accounting
    *Focus:* Trace the causes and consequences of NIC and kernel packet-drop accounting, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate NIC and kernel packet-drop accounting, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Dropwatch perf tracepoints and eBPF packet-path tracing
    *Focus:* Cover Dropwatch perf tracepoints and eBPF packet-path tracing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Dropwatch perf tracepoints and eBPF packet-path tracing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
- **Chapter 47: Kernel bypass and RDMA**
  *Focus:* Explain why and how applications bypass the kernel, manage descriptors and DMA-visible memory, and use user-space networking or RDMA while accepting operational complexity.
  *Examples and visuals:* Include a minimal AF_XDP, DPDK, or verbs-style loop, queue-ownership and RDMA-operation diagrams, and a table comparing kernel sockets, bypass APIs, and RDMA.
  - Kernel-bypass motivation and tradeoffs
    *Focus:* Compare Kernel-bypass motivation and tradeoffs by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Kernel-bypass motivation and tradeoffs, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Device queues descriptors and ownership
    *Focus:* Cover Device queues descriptors and ownership through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Device queues descriptors and ownership, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Huge pages DMA mapping and IOVA addressing
    *Focus:* Cover Huge pages DMA mapping and IOVA addressing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Huge pages DMA mapping and IOVA addressing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - PACKET_MMAP and AF_PACKET
    *Focus:* Cover PACKET_MMAP and AF_PACKET through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate PACKET_MMAP and AF_PACKET, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - AF_XDP and XDP
    *Focus:* Cover AF_XDP and XDP through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate AF_XDP and XDP, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - DPDK poll-mode drivers
    *Focus:* Cover DPDK poll-mode drivers through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate DPDK poll-mode drivers, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - DPDK huge-page memory
    *Focus:* Cover DPDK huge-page memory through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate DPDK huge-page memory, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - OpenOnload
    *Focus:* Cover OpenOnload through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate OpenOnload, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - ef_vi
    *Focus:* Cover ef_vi through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate ef_vi, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - TCPDirect
    *Focus:* Cover TCPDirect through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate TCPDirect, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - VMA
    *Focus:* Cover VMA through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate VMA, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - User-space TCP-IP stacks
    *Focus:* Cover User-space TCP-IP stacks through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate User-space TCP-IP stacks, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Busy-poll NIC loops
    *Focus:* Cover Busy-poll NIC loops through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Busy-poll NIC loops, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Zero-copy receive
    *Focus:* Cover Zero-copy receive through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Zero-copy receive, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Descriptor ownership and completion queues
    *Focus:* Cover Descriptor ownership and completion queues through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Descriptor ownership and completion queues, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - RDMA transport and programming model
    *Focus:* Cover RDMA transport and programming model through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate RDMA transport and programming model, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Memory registration and pinning
    *Focus:* Cover Memory registration and pinning through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Memory registration and pinning, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - RDMA memory regions
    *Focus:* Cover RDMA memory regions through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate RDMA memory regions, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - RDMA queue pairs and completion queues
    *Focus:* Cover RDMA queue pairs and completion queues through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate RDMA queue pairs and completion queues, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - One-sided and two-sided RDMA
    *Focus:* Cover One-sided and two-sided RDMA through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate One-sided and two-sided RDMA, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - RoCE and InfiniBand
    *Focus:* Cover RoCE and InfiniBand through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate RoCE and InfiniBand, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
- **Chapter 48: NICs acceleration and measurement**
  *Focus:* Describe NIC and SmartNIC architecture, FPGA acceleration, capture and timestamping, clock error, and the correct measurement of latency, loss, jitter, and saturation.
  *Examples and visuals:* Include timestamp extraction and packet-rate calculations, NIC queue and clock-domain diagrams, and a table separating host, software, NIC, and external measurement error.
  - NIC ports queues rings and offload engines
    *Focus:* Cover NIC ports queues rings and offload engines through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate NIC ports queues rings and offload engines, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Host NIC and PCIe data flow
    *Focus:* Cover Host NIC and PCIe data flow through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Host NIC and PCIe data flow, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - SmartNICs
    *Focus:* Cover SmartNICs through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate SmartNICs, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - FPGA-based NICs
    *Focus:* Cover FPGA-based NICs through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate FPGA-based NICs, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - FPGA order entry
    *Focus:* Cover FPGA order entry through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate FPGA order entry, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - FPGA and kernel-bypass hybrids
    *Focus:* Cover FPGA and kernel-bypass hybrids through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate FPGA and kernel-bypass hybrids, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Packet capture and timestamping
    *Focus:* Cover Packet capture and timestamping through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Packet capture and timestamping, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - tcpdump and Wireshark
    *Focus:* Cover tcpdump and Wireshark through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate tcpdump and Wireshark, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Packet capture with libpcap
    *Focus:* Cover Packet capture with libpcap through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Packet capture with libpcap, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - NIC hardware timestamping
    *Focus:* Cover NIC hardware timestamping through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate NIC hardware timestamping, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Software and hardware timestamp selection
    *Focus:* Define and quantify Software and hardware timestamp selection, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Software and hardware timestamp selection, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - PTP grandmaster clocks
    *Focus:* Cover PTP grandmaster clocks through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate PTP grandmaster clocks, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Measurement goals methodology and error
    *Focus:* Trace the causes and consequences of Measurement goals methodology and error, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Measurement goals methodology and error, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - One-way versus round-trip latency
    *Focus:* Compare One-way versus round-trip latency by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate One-way versus round-trip latency, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Clock synchronization error
    *Focus:* Trace the causes and consequences of Clock synchronization error, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Clock synchronization error, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Packet-loss and jitter measurement
    *Focus:* Trace the causes and consequences of Packet-loss and jitter measurement, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Packet-loss and jitter measurement, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Capacity and saturation measurement
    *Focus:* Define and quantify Capacity and saturation measurement, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Capacity and saturation measurement, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - NIC ring sizing
    *Focus:* Cover NIC ring sizing through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate NIC ring sizing, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Packets-per-second limits
    *Focus:* Cover Packets-per-second limits through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Packets-per-second limits, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.
  - Offered load and goodput
    *Focus:* Cover Offered load and goodput through its wire or API semantics, state transitions, data path, ordering guarantees, failure behavior, and latency implications.
    *Examples and visuals:* Use a bounded socket, packet, or capture example to demonstrate Offered load and goodput, supported by a header, state-machine, or packet-path diagram and a table of fields, guarantees, costs, and failures.

## Market Microstructure and Trading

- **Chapter 49: Market fundamentals**
  *Focus:* Give engineers the market vocabulary and mechanics needed to understand instruments, venues, books, spreads, liquidity, priority, fees, sessions, auctions, and market states.
  *Examples and visuals:* Include a worked order-book snapshot, price-time and pro-rata allocation diagrams, and tables for tick, lot, contract, session, and fee concepts.
  - Financial markets participants and venues
    *Focus:* Cover Financial markets participants and venues in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Financial markets participants and venues, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Instruments venues and trading sessions
    *Focus:* Cover Instruments venues and trading sessions in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Instruments venues and trading sessions, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Buyers sellers bids and offers
    *Focus:* Cover Buyers sellers bids and offers in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Buyers sellers bids and offers, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Bid ask and spread
    *Focus:* Cover Bid ask and spread in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Bid ask and spread, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Limit order books price levels and depth
    *Focus:* Cover Limit order books price levels and depth in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Limit order books price levels and depth, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Market depth and liquidity
    *Focus:* Cover Market depth and liquidity in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Market depth and liquidity, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Tick sizes
    *Focus:* Cover Tick sizes in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Tick sizes, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Lot sizes and contract multipliers
    *Focus:* Cover Lot sizes and contract multipliers in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Lot sizes and contract multipliers, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Instrument symbology
    *Focus:* Cover Instrument symbology in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Instrument symbology, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Reference-data changes
    *Focus:* Cover Reference-data changes in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Reference-data changes, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Matching and allocation priority
    *Focus:* Cover Matching and allocation priority in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Matching and allocation priority, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Price-time priority
    *Focus:* Cover Price-time priority in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Price-time priority, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Pro-rata allocation
    *Focus:* Cover Pro-rata allocation in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Pro-rata allocation, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Queue position
    *Focus:* Cover Queue position in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Queue position, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Maker-taker fees and rebates
    *Focus:* Cover Maker-taker fees and rebates in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Maker-taker fees and rebates, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Continuous trading
    *Focus:* Cover Continuous trading in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Continuous trading, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Opening and closing auctions
    *Focus:* Cover Opening and closing auctions in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Opening and closing auctions, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Trading halts and price bands
    *Focus:* Cover Trading halts and price bands in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Trading halts and price bands, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Locked and crossed markets
    *Focus:* Cover Locked and crossed markets in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Locked and crossed markets, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
- **Chapter 50: Orders and matching**
  *Focus:* Explain order intent, types, constraints, lifecycle races, book invariants, price-level representation, and matching-engine behavior from entry through execution.
  *Examples and visuals:* Include an order-state-machine implementation and small book update trace, lifecycle and matching diagrams, and tables comparing order types and time-in-force rules.
  - Orders sides quantities prices and time in force
    *Focus:* Cover Orders sides quantities prices and time in force in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Orders sides quantities prices and time in force, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Order identifiers and client intent
    *Focus:* Cover Order identifiers and client intent in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Order identifiers and client intent, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Market orders
    *Focus:* Cover Market orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Market orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Limit orders
    *Focus:* Cover Limit orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Limit orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Stop orders
    *Focus:* Cover Stop orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Stop orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Pegged orders
    *Focus:* Cover Pegged orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Pegged orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Time-in-force and execution constraints
    *Focus:* Cover Time-in-force and execution constraints in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Time-in-force and execution constraints, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Post-only orders
    *Focus:* Cover Post-only orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Post-only orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Immediate-or-cancel orders
    *Focus:* Cover Immediate-or-cancel orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Immediate-or-cancel orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Fill-or-kill orders
    *Focus:* Cover Fill-or-kill orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Fill-or-kill orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Good-till-cancelled and dated orders
    *Focus:* Cover Good-till-cancelled and dated orders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Good-till-cancelled and dated orders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Order acceptance rejection and acknowledgement
    *Focus:* Cover Order acceptance rejection and acknowledgement in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Order acceptance rejection and acknowledgement, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Order lifecycle state machine
    *Focus:* Cover Order lifecycle state machine in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Order lifecycle state machine, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Cancel replace and fill races
    *Focus:* Trace the causes and consequences of Cancel replace and fill races, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Cancel replace and fill races, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Late acknowledgements
    *Focus:* Cover Late acknowledgements in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Late acknowledgements, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Duplicate execution messages
    *Focus:* Cover Duplicate execution messages in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Duplicate execution messages, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Limit-order-book invariants
    *Focus:* Cover Limit-order-book invariants in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Limit-order-book invariants, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Limit-order-book representation
    *Focus:* Cover Limit-order-book representation in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Limit-order-book representation, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Price-level data structures
    *Focus:* Cover Price-level data structures in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Price-level data structures, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Order queues at a price level
    *Focus:* Cover Order queues at a price level in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Order queues at a price level, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Best-bid-offer maintenance
    *Focus:* Cover Best-bid-offer maintenance in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Best-bid-offer maintenance, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Add cancel modify and execute events
    *Focus:* Cover Add cancel modify and execute events in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Add cancel modify and execute events, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Matching rules and execution reports
    *Focus:* Cover Matching rules and execution reports in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Matching rules and execution reports, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Matching-engine design
    *Focus:* Cover Matching-engine design in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Matching-engine design, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
- **Chapter 51: Exchange protocols**
  *Focus:* Show how exchange session and application protocols frame, encode, sequence, validate, recover, and parse messages under strict correctness and allocation constraints.
  *Examples and visuals:* Include a bounded binary-message decoder and sequence-gap handler, wire-layout and recovery-flow diagrams, and a table comparing FIX, FAST, ITCH, OUCH, and SBE.
  - Protocol roles sessions and application messages
    *Focus:* Cover Protocol roles sessions and application messages in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Protocol roles sessions and application messages, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Text versus binary protocols
    *Focus:* Compare Text versus binary protocols by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Text versus binary protocols, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Message framing lengths and message types
    *Focus:* Cover Message framing lengths and message types in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Message framing lengths and message types, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Session sequencing heartbeats and recovery
    *Focus:* Cover Session sequencing heartbeats and recovery in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Session sequencing heartbeats and recovery, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - FIX session layer
    *Focus:* Cover FIX session layer in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate FIX session layer, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - FIX application messages
    *Focus:* Cover FIX application messages in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate FIX application messages, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Binary message framing
    *Focus:* Cover Binary message framing in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Binary message framing, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Protocol endianness and alignment
    *Focus:* Cover Protocol endianness and alignment in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Protocol endianness and alignment, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Schema and version evolution
    *Focus:* Cover Schema and version evolution in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Schema and version evolution, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - FAST encoding
    *Focus:* Cover FAST encoding in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate FAST encoding, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Simple Binary Encoding
    *Focus:* Cover Simple Binary Encoding in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Simple Binary Encoding, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - ITCH market data
    *Focus:* Cover ITCH market data in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate ITCH market data, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - OUCH order entry
    *Focus:* Cover OUCH order entry in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate OUCH order entry, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Protocol sequence numbers
    *Focus:* Cover Protocol sequence numbers in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Protocol sequence numbers, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Gap-fill and replay protocols
    *Focus:* Cover Gap-fill and replay protocols in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Gap-fill and replay protocols, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Checksums and CRCs
    *Focus:* Cover Checksums and CRCs in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Checksums and CRCs, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Untrusted length and count validation
    *Focus:* Cover Untrusted length and count validation in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Untrusted length and count validation, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Allocation-free parsing
    *Focus:* Cover Allocation-free parsing in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Allocation-free parsing, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Zero-copy deserialization
    *Focus:* Cover Zero-copy deserialization in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Zero-copy deserialization, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.

## Low-Latency Trading Systems

- **Chapter 52: Architecture and latency**
  *Focus:* Present an end-to-end low-latency trading architecture and teach candidates to budget, measure, and reason about every stage, queue, batching decision, and overload boundary.
  *Examples and visuals:* Include a miniature feed-to-order pipeline, critical-path and latency-budget diagrams, and a table of per-stage work, ownership, latency, and backpressure policy.
  - System requirements throughput latency and correctness
    *Focus:* Define and quantify System requirements throughput latency and correctness, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate System requirements throughput latency and correctness, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Latency vocabulary and measurement boundaries
    *Focus:* Define and quantify Latency vocabulary and measurement boundaries, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Latency vocabulary and measurement boundaries, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Tick-to-trade and wire-to-wire latency
    *Focus:* Define and quantify Tick-to-trade and wire-to-wire latency, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Tick-to-trade and wire-to-wire latency, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - End-to-end latency budgets
    *Focus:* Define and quantify End-to-end latency budgets, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate End-to-end latency budgets, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Market-data strategy and order-gateway pipeline
    *Focus:* Turn Market-data strategy and order-gateway pipeline into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Market-data strategy and order-gateway pipeline, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Feed handlers
    *Focus:* Cover Feed handlers in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Feed handlers, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Book builders
    *Focus:* Cover Book builders in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Book builders, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Market-data normalization
    *Focus:* Cover Market-data normalization in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Market-data normalization, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Colocation and cross-connects
    *Focus:* Cover Colocation and cross-connects in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Colocation and cross-connects, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Hot warm and cold paths
    *Focus:* Cover Hot warm and cold paths in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Hot warm and cold paths, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Single-writer event loops
    *Focus:* Cover Single-writer event loops in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Single-writer event loops, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Staged pipeline architectures
    *Focus:* Cover Staged pipeline architectures in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Staged pipeline architectures, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Inter-stage queue costs
    *Focus:* Define and quantify Inter-stage queue costs, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Inter-stage queue costs, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Per-stage latency budgets
    *Focus:* Define and quantify Per-stage latency budgets, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Per-stage latency budgets, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Critical-path analysis
    *Focus:* Cover Critical-path analysis in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Critical-path analysis, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Capacity queues and overload
    *Focus:* Cover Capacity queues and overload in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Capacity queues and overload, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Batching tradeoffs
    *Focus:* Compare Batching tradeoffs by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Batching tradeoffs, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Throughput-latency curves
    *Focus:* Define and quantify Throughput-latency curves, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Throughput-latency curves, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Bounded queues and backpressure
    *Focus:* Cover Bounded queues and backpressure in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Bounded queues and backpressure, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Overload shedding
    *Focus:* Cover Overload shedding in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Overload shedding, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
- **Chapter 53: Market-data correctness**
  *Focus:* Explain how a feed handler builds deterministic market state despite snapshots, increments, gaps, duplicates, redundant channels, stale data, and replay.
  *Examples and visuals:* Include a sequence-aware feed-state machine and replay test, snapshot-plus-delta and A/B arbitration diagrams, and a table of failure cases and recovery actions.
  - Market-data state events and ordering
    *Focus:* Cover Market-data state events and ordering in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Market-data state events and ordering, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Channel instrument and message identity
    *Focus:* Cover Channel instrument and message identity in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Channel instrument and message identity, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Sequence numbers and continuity
    *Focus:* Cover Sequence numbers and continuity in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Sequence numbers and continuity, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Incremental market-data feeds
    *Focus:* Cover Incremental market-data feeds in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Incremental market-data feeds, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Snapshot feeds
    *Focus:* Cover Snapshot feeds in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Snapshot feeds, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Snapshot-plus-delta recovery
    *Focus:* Cover Snapshot-plus-delta recovery in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Snapshot-plus-delta recovery, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Feed sequence-gap recovery
    *Focus:* Cover Feed sequence-gap recovery in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Feed sequence-gap recovery, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Market-data packet duplicate suppression
    *Focus:* Cover Market-data packet duplicate suppression in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Market-data packet duplicate suppression, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Redundant A-B feed arbitration
    *Focus:* Cover Redundant A-B feed arbitration in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Redundant A-B feed arbitration, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Deterministic feed merge rules
    *Focus:* Cover Deterministic feed merge rules in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Deterministic feed merge rules, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Stale-market detection
    *Focus:* Trace the causes and consequences of Stale-market detection, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Stale-market detection, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Deterministic market-data replay
    *Focus:* Cover Deterministic market-data replay in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Deterministic market-data replay, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
- **Chapter 54: Order gateways**
  *Focus:* Cover the session, correlation, idempotency, recovery, throttling, disconnect, drop-copy, and reconciliation responsibilities at the exchange-facing order boundary.
  *Examples and visuals:* Include an idempotent order-state machine and resend simulation, session and identifier-mapping diagrams, and a table mapping disconnect and duplicate scenarios to safe actions.
  - Order-gateway responsibilities and trust boundaries
    *Focus:* Cover Order-gateway responsibilities and trust boundaries in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Order-gateway responsibilities and trust boundaries, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Session state versus order state
    *Focus:* Compare Session state versus order state by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Session state versus order state, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Trading-session logon and logout
    *Focus:* Cover Trading-session logon and logout in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Trading-session logon and logout, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Session heartbeats
    *Focus:* Cover Session heartbeats in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Session heartbeats, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Session sequence reset
    *Focus:* Cover Session sequence reset in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Session sequence reset, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Resend and replay
    *Focus:* Cover Resend and replay in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Resend and replay, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Reconnect behavior
    *Focus:* Cover Reconnect behavior in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Reconnect behavior, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Order lifecycle and correlation
    *Focus:* Cover Order lifecycle and correlation in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Order lifecycle and correlation, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Client and exchange order identifiers
    *Focus:* Cover Client and exchange order identifiers in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Client and exchange order identifiers, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Order-correlation tables
    *Focus:* Cover Order-correlation tables in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Order-correlation tables, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Idempotent order state transitions
    *Focus:* Cover Idempotent order state transitions in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Idempotent order state transitions, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Duplicate suppression
    *Focus:* Cover Duplicate suppression in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Duplicate suppression, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - At-least-once processing
    *Focus:* Cover At-least-once processing in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate At-least-once processing, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Disconnect recovery
    *Focus:* Cover Disconnect recovery in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Disconnect recovery, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Exchange rate limits
    *Focus:* Cover Exchange rate limits in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Exchange rate limits, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Message throttling
    *Focus:* Cover Message throttling in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Message throttling, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Cancel on disconnect
    *Focus:* Cover Cancel on disconnect in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Cancel on disconnect, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Drop copy
    *Focus:* Trace the causes and consequences of Drop copy, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Drop copy, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Post-trade reconciliation
    *Focus:* Cover Post-trade reconciliation in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Post-trade reconciliation, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
- **Chapter 55: Hot-path techniques**
  *Focus:* Show how to identify the true critical path and remove allocation, locking, system calls, indirection, logging, layout, scheduling, and power-management variability from it.
  *Examples and visuals:* Include a profiled baseline and incrementally optimized event loop, hot-path ownership and memory-layout diagrams, and a table recording each technique's gain and tradeoff.
  - Defining and measuring the hot path
    *Focus:* Cover Defining and measuring the hot path in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Defining and measuring the hot path, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Moving work off the critical path
    *Focus:* Cover Moving work off the critical path in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Moving work off the critical path, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Hot-path preallocation
    *Focus:* Cover Hot-path preallocation in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Hot-path preallocation, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Hot-path object pools
    *Focus:* Cover Hot-path object pools in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Hot-path object pools, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Cache-friendly fixed-layout data
    *Focus:* Cover Cache-friendly fixed-layout data in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Cache-friendly fixed-layout data, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Fixed-layout serialization
    *Focus:* Cover Fixed-layout serialization in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Fixed-layout serialization, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Lock avoidance
    *Focus:* Cover Lock avoidance in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Lock avoidance, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - System-call avoidance
    *Focus:* Cover System-call avoidance in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate System-call avoidance, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Busy-spin event loops
    *Focus:* Cover Busy-spin event loops in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Busy-spin event loops, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Isolated-core thread pinning
    *Focus:* Cover Isolated-core thread pinning in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Isolated-core thread pinning, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Allocation-free logging
    *Focus:* Cover Allocation-free logging in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Allocation-free logging, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Compile-time hot-path specialization
    *Focus:* Cover Compile-time hot-path specialization in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Compile-time hot-path specialization, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Avoiding virtual dispatch
    *Focus:* Cover Avoiding virtual dispatch in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Avoiding virtual dispatch, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Reducing power-state jitter
    *Focus:* Cover Reducing power-state jitter in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Reducing power-state jitter, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
- **Chapter 56: Reliability and risk**
  *Focus:* Join restart and failover correctness with overload handling and pre-trade controls so a fast system remains recoverable, fenced, bounded, and safe.
  *Examples and visuals:* Include journal replay and risk-check pipeline examples, failover and fencing state diagrams, and a table mapping failures or limit breaches to system responses.
  - Failure models recovery objectives and invariants
    *Focus:* Trace the causes and consequences of Failure models recovery objectives and invariants, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Failure models recovery objectives and invariants, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Durable state and restart recovery
    *Focus:* Cover Durable state and restart recovery in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Durable state and restart recovery, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Write-ahead trading journals
    *Focus:* Cover Write-ahead trading journals in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Write-ahead trading journals, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Crash-consistent sequence checkpoints
    *Focus:* Cover Crash-consistent sequence checkpoints in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Crash-consistent sequence checkpoints, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Startup and replay recovery
    *Focus:* Cover Startup and replay recovery in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Startup and replay recovery, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - High availability and failover
    *Focus:* Cover High availability and failover in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate High availability and failover, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Active-passive redundancy
    *Focus:* Cover Active-passive redundancy in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Active-passive redundancy, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Leader fencing
    *Focus:* Cover Leader fencing in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Leader fencing, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Split-brain avoidance
    *Focus:* Trace the causes and consequences of Split-brain avoidance, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Split-brain avoidance, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - State convergence after failover
    *Focus:* Cover State convergence after failover in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate State convergence after failover, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Heartbeats and watchdogs
    *Focus:* Cover Heartbeats and watchdogs in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Heartbeats and watchdogs, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Fail-open versus fail-closed behavior
    *Focus:* Compare Fail-open versus fail-closed behavior by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Fail-open versus fail-closed behavior, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Capacity limits and overload policy
    *Focus:* Turn Capacity limits and overload policy into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Capacity limits and overload policy, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Burst capacity planning
    *Focus:* Cover Burst capacity planning in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Burst capacity planning, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Queue-watermark alarms
    *Focus:* Cover Queue-watermark alarms in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Queue-watermark alarms, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Graceful degradation
    *Focus:* Cover Graceful degradation in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Graceful degradation, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Pre-trade risk controls
    *Focus:* Cover Pre-trade risk controls in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Pre-trade risk controls, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Pre-trade price collars
    *Focus:* Cover Pre-trade price collars in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Pre-trade price collars, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Fat-finger and notional limits
    *Focus:* Cover Fat-finger and notional limits in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Fat-finger and notional limits, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Position and credit limits
    *Focus:* Cover Position and credit limits in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Position and credit limits, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Maximum order quantity
    *Focus:* Cover Maximum order quantity in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Maximum order quantity, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Runaway-strategy detection
    *Focus:* Turn Runaway-strategy detection into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Runaway-strategy detection, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Trading kill switches
    *Focus:* Cover Trading kill switches in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Trading kill switches, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Mass cancel
    *Focus:* Cover Mass cancel in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Mass cancel, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Self-trade prevention
    *Focus:* Cover Self-trade prevention in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Self-trade prevention, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Duplicate-order protection
    *Focus:* Cover Duplicate-order protection in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Duplicate-order protection, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.
  - Risk-state consistency
    *Focus:* Cover Risk-state consistency in a low-latency trading system, emphasizing state, ordering, correctness invariants, failure handling, and critical-path impact.
    *Examples and visuals:* Use a concrete event sequence or small state machine to demonstrate Risk-state consistency, supported by a timeline or data-flow diagram and a table of invariants, race cases, and required responses.

## Testing Debugging and Operations

- **Chapter 57: Testing**
  *Focus:* Build a layered testing strategy for native, concurrent, protocol-driven, time-dependent, and failover-sensitive systems with deterministic reproduction wherever possible.
  *Examples and visuals:* Include property, fuzz, scheduler, replay, and fault-injection examples, a test-pyramid diagram, and a table mapping risks to test techniques and required oracles.
  - Test goals scope and oracles
    *Focus:* Cover Test goals scope and oracles by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Test goals scope and oracles, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - The test pyramid and test boundaries
    *Focus:* Cover The test pyramid and test boundaries by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate The test pyramid and test boundaries, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Unit testing
    *Focus:* Cover Unit testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Unit testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Integration and end-to-end testing
    *Focus:* Cover Integration and end-to-end testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Integration and end-to-end testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Property-based testing
    *Focus:* Cover Property-based testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Property-based testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Differential testing
    *Focus:* Cover Differential testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Differential testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Model-based testing
    *Focus:* Cover Model-based testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Model-based testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Deterministic random seeds and reproducers
    *Focus:* Cover Deterministic random seeds and reproducers by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Deterministic random seeds and reproducers, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Fuzzing native code
    *Focus:* Cover Fuzzing native code by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Fuzzing native code, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Protocol-vector tests
    *Focus:* Cover Protocol-vector tests by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Protocol-vector tests, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Malformed-message fuzzing
    *Focus:* Cover Malformed-message fuzzing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Malformed-message fuzzing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Concurrency stress and soak testing
    *Focus:* Cover Concurrency stress and soak testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Concurrency stress and soak testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Randomized scheduler testing
    *Focus:* Cover Randomized scheduler testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Randomized scheduler testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Memory-model model checking
    *Focus:* Cover Memory-model model checking by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Memory-model model checking, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Deterministic simulation
    *Focus:* Cover Deterministic simulation by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Deterministic simulation, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Virtual clocks
    *Focus:* Cover Virtual clocks by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Virtual clocks, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Recorded packet replay
    *Focus:* Cover Recorded packet replay by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Recorded packet replay, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Fault injection
    *Focus:* Cover Fault injection by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Fault injection, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Load burst and soak testing
    *Focus:* Cover Load burst and soak testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Load burst and soak testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Failover testing
    *Focus:* Cover Failover testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Failover testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Hardware-in-the-loop testing
    *Focus:* Cover Hardware-in-the-loop testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Hardware-in-the-loop testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
  - Loopback latency testing
    *Focus:* Cover Loopback latency testing by defining the risk under test, the test boundary and oracle, the required determinism, the defects it can expose, and the failures it cannot rule out.
    *Examples and visuals:* Use the smallest useful test or harness to demonstrate Loopback latency testing, supported by an execution or fault-injection diagram and a table mapping risks, stimuli, oracles, coverage, and reproducibility.
- **Chapter 58: Native debugging**
  *Focus:* Teach a disciplined path from reproduction and symbols to live debugging, optimized-code reasoning, core analysis, and diagnosis of concurrency, heap, and memory-corruption failures.
  *Examples and visuals:* Include a guided GDB or LLDB session and core-dump investigation, stack and heap-corruption diagrams, and a table of symptoms, commands, and likely causes.
  - Reproduce reduce observe and explain
    *Focus:* Cover Reproduce reduce observe and explain as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Reproduce reduce observe and explain, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - GDB and LLDB fundamentals
    *Focus:* Cover GDB and LLDB fundamentals as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate GDB and LLDB fundamentals, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Breakpoints and watchpoints
    *Focus:* Cover Breakpoints and watchpoints as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Breakpoints and watchpoints, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Symbols source mappings and stack frames
    *Focus:* Cover Symbols source mappings and stack frames as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Symbols source mappings and stack frames, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Debugging optimized code
    *Focus:* Cover Debugging optimized code as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Debugging optimized code, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Core dumps
    *Focus:* Cover Core dumps as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Core dumps, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Postmortem register and stack analysis
    *Focus:* Cover Postmortem register and stack analysis as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Postmortem register and stack analysis, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - DWARF and split debug information
    *Focus:* Cover DWARF and split debug information as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate DWARF and split debug information, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Build IDs and symbol servers
    *Focus:* Cover Build IDs and symbol servers as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Build IDs and symbol servers, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - std::stacktrace
    *Focus:* Cover std::stacktrace as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate std::stacktrace, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Deadlock diagnosis
    *Focus:* Cover Deadlock diagnosis as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Deadlock diagnosis, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Livelock and CPU-spin diagnosis
    *Focus:* Cover Livelock and CPU-spin diagnosis as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Livelock and CPU-spin diagnosis, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Memory-corruption diagnosis
    *Focus:* Cover Memory-corruption diagnosis as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Memory-corruption diagnosis, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Heap debugging
    *Focus:* Cover Heap debugging as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Heap debugging, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
  - Crash-handler limitations
    *Focus:* Cover Crash-handler limitations as a debugging technique, emphasizing symptoms, evidence collection, relevant process or machine state, reasoning steps, optimized-code complications, and tool limitations.
    *Examples and visuals:* Use a compact reproducer or debugger session to demonstrate Crash-handler limitations, supported by a stack, memory, thread, or control-flow diagram and a table mapping symptoms to commands, evidence, and likely causes.
- **Chapter 59: Observability**
  *Focus:* Explain how to design low-overhead metrics, logs, traces, health signals, alerts, and flight recorders that preserve enough causal and temporal context for production diagnosis.
  *Examples and visuals:* Include per-core metric aggregation and ring-buffer logging examples, event-correlation and clock-domain diagrams, and a table of signals, cardinality limits, and failure modes.
  - Observability signals metrics logs traces and profiles
    *Focus:* Cover Observability signals metrics logs traces and profiles as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Observability signals metrics logs traces and profiles, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Instrumentation cost sampling and cardinality
    *Focus:* Cover Instrumentation cost sampling and cardinality as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Instrumentation cost sampling and cardinality, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Metrics types and semantics
    *Focus:* Cover Metrics types and semantics as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Metrics types and semantics, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - High-cardinality metrics
    *Focus:* Cover High-cardinality metrics as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate High-cardinality metrics, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Per-core metrics aggregation
    *Focus:* Cover Per-core metrics aggregation as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Per-core metrics aggregation, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Latency histograms in production
    *Focus:* Cover Latency histograms in production as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Latency histograms in production, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Structured and binary logging
    *Focus:* Cover Structured and binary logging as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Structured and binary logging, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Lock-free logging queues
    *Focus:* Cover Lock-free logging queues as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Lock-free logging queues, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Log sampling and drop accounting
    *Focus:* Cover Log sampling and drop accounting as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Log sampling and drop accounting, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Tracing spans and causal context
    *Focus:* Cover Tracing spans and causal context as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Tracing spans and causal context, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Sequence and timestamp event correlation
    *Focus:* Cover Sequence and timestamp event correlation as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Sequence and timestamp event correlation, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Clock-domain uncertainty
    *Focus:* Cover Clock-domain uncertainty as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Clock-domain uncertainty, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Health checks and heartbeats
    *Focus:* Cover Health checks and heartbeats as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Health checks and heartbeats, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Watchdogs and stall detectors
    *Focus:* Cover Watchdogs and stall detectors as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Watchdogs and stall detectors, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Tail-latency alerting
    *Focus:* Cover Tail-latency alerting as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Tail-latency alerting, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
  - Flight-recorder ring buffers
    *Focus:* Cover Flight-recorder ring buffers as an observability signal or mechanism, emphasizing semantics, collection, overhead, cardinality, temporal correlation, loss behavior, and diagnostic value.
    *Examples and visuals:* Use a small instrumentation example and representative telemetry to demonstrate Flight-recorder ring buffers, supported by a signal-flow or event-timeline diagram and a table of fields, costs, aggregation rules, and alert conditions.
- **Chapter 60: Deployment and operations**
  *Focus:* Cover the full operational lifecycle from reproducible artifacts and validated configuration through startup, health, rollout, rollback, draining, auditing, and resource exhaustion.
  *Examples and visuals:* Include service configuration and graceful-shutdown examples, deployment and process-lifecycle diagrams, and a checklist table for release, rollback, capacity, and failure readiness.
  - Build release deploy and operate lifecycle
    *Focus:* Cover Build release deploy and operate lifecycle as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Build release deploy and operate lifecycle, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Reproducible deployment artifacts
    *Focus:* Cover Reproducible deployment artifacts as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Reproducible deployment artifacts, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Processes services and supervision
    *Focus:* Cover Processes services and supervision as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Processes services and supervision, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Environment configuration and secrets
    *Focus:* Cover Environment configuration and secrets as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Environment configuration and secrets, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Immutable configuration
    *Focus:* Cover Immutable configuration as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Immutable configuration, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Configuration and reference-data validation
    *Focus:* Cover Configuration and reference-data validation as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Configuration and reference-data validation, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Atomic configuration updates
    *Focus:* Cover Atomic configuration updates as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Atomic configuration updates, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Startup dependency ordering
    *Focus:* Cover Startup dependency ordering as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Startup dependency ordering, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Startup warmup and cache priming
    *Focus:* Cover Startup warmup and cache priming as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Startup warmup and cache priming, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Readiness versus liveness
    *Focus:* Cover Readiness versus liveness as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Readiness versus liveness, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Safe shutdown and draining
    *Focus:* Cover Safe shutdown and draining as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Safe shutdown and draining, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Staged rollout and rollback
    *Focus:* Cover Staged rollout and rollback as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Staged rollout and rollback, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Feature and venue kill switches
    *Focus:* Cover Feature and venue kill switches as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Feature and venue kill switches, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Audit trails
    *Focus:* Cover Audit trails as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Audit trails, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Capacity headroom
    *Focus:* Cover Capacity headroom as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Capacity headroom, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Resource limits and descriptor exhaustion
    *Focus:* Cover Resource limits and descriptor exhaustion as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Resource limits and descriptor exhaustion, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.
  - Disk and log-retention failures
    *Focus:* Cover Disk and log-retention failures as an operational lifecycle or safety mechanism, emphasizing preconditions, automation, state transitions, failure containment, recovery, auditability, and capacity impact.
    *Examples and visuals:* Use a concrete configuration, deployment step, runbook action, or failure drill to demonstrate Disk and log-retention failures, supported by a lifecycle diagram and a table of checks, signals, rollback actions, and ownership.

## Database Internals (PostgreSQL as Reference)

- **Chapter 61: Introduction and Overview**
  *Focus:* Introduce DBMS layers and storage choices through PostgreSQL's process, memory, catalog, heap, query-planning, and execution architecture.
  *Examples and visuals:* Include a query traced from protocol message to executor output, PostgreSQL process and query-pipeline diagrams, and a table comparing storage and execution models.
  - What a DBMS is and how it is layered
    *Focus:* Explain what a DBMS is and how it is layered, establish the essential vocabulary and boundaries, and connect each layer to the surrounding system.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate What a DBMS is and how it is layered, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Databases schemas tables rows and columns
    *Focus:* Cover Databases schemas tables rows and columns as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Databases schemas tables rows and columns, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - The relational model keys and constraints
    *Focus:* Cover The relational model keys and constraints as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate The relational model keys and constraints, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Query processing storage and transaction subsystems
    *Focus:* Cover Query processing storage and transaction subsystems as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Query processing storage and transaction subsystems, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - OLTP OLAP and mixed workloads
    *Focus:* Cover OLTP OLAP and mixed workloads as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate OLTP OLAP and mixed workloads, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Memory- versus disk-based DBMS
    *Focus:* Compare Memory- versus disk-based DBMS by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Memory- versus disk-based DBMS, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Durability in memory-based stores
    *Focus:* Cover Durability in memory-based stores as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Durability in memory-based stores, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Row- versus column-oriented storage
    *Focus:* Compare Row- versus column-oriented storage by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Row- versus column-oriented storage, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Column-oriented data layout in practice
    *Focus:* Cover Column-oriented data layout in practice as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Column-oriented data layout in practice, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Vectorized execution and hybrids
    *Focus:* Cover Vectorized execution and hybrids as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Vectorized execution and hybrids, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Wide-column stores versus column stores
    *Focus:* Compare Wide-column stores versus column stores by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Wide-column stores versus column stores, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Data files and index files
    *Focus:* Cover Data files and index files as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Data files and index files, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Heap-organized versus index-organized tables
    *Focus:* Compare Heap-organized versus index-organized tables by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Heap-organized versus index-organized tables, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Primary secondary clustered and non-clustered indexes
    *Focus:* Cover Primary secondary clustered and non-clustered indexes as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Primary secondary clustered and non-clustered indexes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - The primary index as indirection
    *Focus:* Cover The primary index as indirection as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate The primary index as indirection, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Buffering immutability and ordering
    *Focus:* Cover Buffering immutability and ordering as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Buffering immutability and ordering, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL server architecture and process model
    *Focus:* Cover PostgreSQL server architecture and process model as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL server architecture and process model, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - The postmaster backend lifecycle and client sessions
    *Focus:* Cover The postmaster backend lifecycle and client sessions as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate The postmaster backend lifecycle and client sessions, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Shared memory local memory and dynamic shared memory
    *Focus:* Cover Shared memory local memory and dynamic shared memory as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Shared memory local memory and dynamic shared memory, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Memory contexts resource owners and error cleanup
    *Focus:* Trace the causes and consequences of Memory contexts resource owners and error cleanup, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Memory contexts resource owners and error cleanup, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Background writer checkpointer WAL writer and auxiliary processes
    *Focus:* Cover Background writer checkpointer WAL writer and auxiliary processes as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Background writer checkpointer WAL writer and auxiliary processes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - System catalogs object identifiers and dependency tracking
    *Focus:* Cover System catalogs object identifiers and dependency tracking as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate System catalogs object identifiers and dependency tracking, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Relations relfilenodes tablespaces and storage forks
    *Focus:* Cover Relations relfilenodes tablespaces and storage forks as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Relations relfilenodes tablespaces and storage forks, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - The PostgreSQL heap and append-new-version updates
    *Focus:* Cover The PostgreSQL heap and append-new-version updates as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate The PostgreSQL heap and append-new-version updates, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - The life of a PostgreSQL query
    *Focus:* Cover The life of a PostgreSQL query as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate The life of a PostgreSQL query, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL frontend-backend protocol and query modes
    *Focus:* Cover PostgreSQL frontend-backend protocol and query modes as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL frontend-backend protocol and query modes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Query parsing semantic analysis and rewriting
    *Focus:* Cover Query parsing semantic analysis and rewriting as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Query parsing semantic analysis and rewriting, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Rule and view expansion
    *Focus:* Cover Rule and view expansion as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Rule and view expansion, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Planner paths parameterization and cost estimation
    *Focus:* Define and quantify Planner paths parameterization and cost estimation, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate Planner paths parameterization and cost estimation, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Table statistics histograms most-common values and correlation
    *Focus:* Cover Table statistics histograms most-common values and correlation as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Table statistics histograms most-common values and correlation, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Extended statistics and cardinality estimation
    *Focus:* Cover Extended statistics and cardinality estimation as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Extended statistics and cardinality estimation, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Join ordering dynamic programming and GEQO
    *Focus:* Cover Join ordering dynamic programming and GEQO as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Join ordering dynamic programming and GEQO, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Sequential bitmap and index scan plans
    *Focus:* Cover Sequential bitmap and index scan plans as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Sequential bitmap and index scan plans, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Nested-loop hash and merge joins
    *Focus:* Cover Nested-loop hash and merge joins as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Nested-loop hash and merge joins, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Volcano-style pull execution
    *Focus:* Cover Volcano-style pull execution as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Volcano-style pull execution, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Sort aggregate window and materialization nodes
    *Focus:* Cover Sort aggregate window and materialization nodes as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Sort aggregate window and materialization nodes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Parallel query workers and dynamic shared memory
    *Focus:* Cover Parallel query workers and dynamic shared memory as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Parallel query workers and dynamic shared memory, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Prepared statements generic plans and custom plans
    *Focus:* Cover Prepared statements generic plans and custom plans as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Prepared statements generic plans and custom plans, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Expression evaluation and JIT compilation
    *Focus:* Cover Expression evaluation and JIT compilation as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Expression evaluation and JIT compilation, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - EXPLAIN EXPLAIN ANALYZE and executor instrumentation
    *Focus:* Cover EXPLAIN EXPLAIN ANALYZE and executor instrumentation as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate EXPLAIN EXPLAIN ANALYZE and executor instrumentation, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
- **Chapter 62: B-Tree Basics**
  *Focus:* Derive disk-oriented B+ trees from index requirements and then explain PostgreSQL nbtree pages, traversal, concurrency, uniqueness, deletion, and visibility behavior.
  *Examples and visuals:* Include hand-worked lookup, split, merge, and range-scan examples, generic and PostgreSQL page diagrams, and a table of invariants and operations.
  - Why databases need indexes
    *Focus:* Answer why databases need indexes and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Why databases need indexes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Ordered keys equality lookup and range scans
    *Focus:* Cover Ordered keys equality lookup and range scans as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Ordered keys equality lookup and range scans, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Why in-memory search trees fail on disk
    *Focus:* Answer why in-memory search trees fail on disk and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Why in-memory search trees fail on disk, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Trees for disk-based storage
    *Focus:* Cover Trees for disk-based storage as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Trees for disk-based storage, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - B-trees versus B+trees
    *Focus:* Compare B-trees versus B+trees by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate B-trees versus B+trees, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Root internal and leaf pages
    *Focus:* Cover Root internal and leaf pages as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Root internal and leaf pages, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - B-tree hierarchy fanout and height
    *Focus:* Cover B-tree hierarchy fanout and height as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate B-tree hierarchy fanout and height, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Separator and high keys
    *Focus:* Cover Separator and high keys as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Separator and high keys, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - B-tree lookup complexity and algorithm
    *Focus:* Define and quantify B-tree lookup complexity and algorithm, derive the main cost or interpretation, and explain how to reason about it without relying on misleading averages or folklore.
    *Examples and visuals:* Use a reproducible calculation or measurement to demonstrate B-tree lookup complexity and algorithm, supported by an annotated distribution or data-path diagram and a table of units, assumptions, expected ranges, and pitfalls.
  - Leaf scans and ordered traversal
    *Focus:* Cover Leaf scans and ordered traversal as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Leaf scans and ordered traversal, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Occupancy invariants
    *Focus:* Cover Occupancy invariants as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Occupancy invariants, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Node splits
    *Focus:* Cover Node splits as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Node splits, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Node merges and rebalancing
    *Focus:* Cover Node merges and rebalancing as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Node merges and rebalancing, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL nbtree keys operator classes and collations
    *Focus:* Cover PostgreSQL nbtree keys operator classes and collations as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL nbtree keys operator classes and collations, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL nbtree metapages and page opaque data
    *Focus:* Cover PostgreSQL nbtree metapages and page opaque data as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL nbtree metapages and page opaque data, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - High keys sibling links and Lehman-Yao traversal
    *Focus:* Cover High keys sibling links and Lehman-Yao traversal as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate High keys sibling links and Lehman-Yao traversal, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Index tuples heap TIDs and posting-list deduplication
    *Focus:* Cover Index tuples heap TIDs and posting-list deduplication as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Index tuples heap TIDs and posting-list deduplication, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - MVCC visibility checks through the heap
    *Focus:* Cover MVCC visibility checks through the heap as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate MVCC visibility checks through the heap, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Unique-index checks and speculative insertion
    *Focus:* Cover Unique-index checks and speculative insertion as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Unique-index checks and speculative insertion, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Bottom-up index deletion and page deletion
    *Focus:* Cover Bottom-up index deletion and page deletion as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Bottom-up index deletion and page deletion, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Index-only scans and the visibility map
    *Focus:* Cover Index-only scans and the visibility map as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Index-only scans and the visibility map, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Sort support and abbreviated keys
    *Focus:* Cover Sort support and abbreviated keys as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Sort support and abbreviated keys, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Concurrent scans splits and buffer locking
    *Focus:* Cover Concurrent scans splits and buffer locking as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Concurrent scans splits and buffer locking, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
- **Chapter 63: File Formats**
  *Focus:* Explain how database records become durable bytes and use PostgreSQL pages, tuples, TOAST, forks, checksums, and LSNs as the concrete reference format.
  *Examples and visuals:* Include a small binary page decoder or pageinspect session, annotated heap-page and tuple diagrams, and tables for headers, flags, offsets, and storage forks.
  - Motivation for on-disk formats
    *Focus:* Cover Motivation for on-disk formats as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Motivation for on-disk formats, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Files blocks pages records and fields
    *Focus:* Cover Files blocks pages records and fields as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Files blocks pages records and fields, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Portability alignment and byte order
    *Focus:* Cover Portability alignment and byte order as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Portability alignment and byte order, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Binary encoding and primitive types
    *Focus:* Cover Binary encoding and primitive types as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Binary encoding and primitive types, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Strings and variable-size data
    *Focus:* Cover Strings and variable-size data as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Strings and variable-size data, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Bit-packed booleans, enums, and flags
    *Focus:* Cover Bit-packed booleans, enums, and flags as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Bit-packed booleans, enums, and flags, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Versioning magic numbers and compatibility
    *Focus:* Cover Versioning magic numbers and compatibility as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Versioning magic numbers and compatibility, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Page structure
    *Focus:* Cover Page structure as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Page structure, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Slotted pages
    *Focus:* Cover Slotted pages as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Slotted pages, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Cell layout
    *Focus:* Cover Cell layout as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Cell layout, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL block size and common page layout
    *Focus:* Cover PostgreSQL block size and common page layout as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL block size and common page layout, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PageHeaderData ItemIdData and free-space boundaries
    *Focus:* Cover PageHeaderData ItemIdData and free-space boundaries as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PageHeaderData ItemIdData and free-space boundaries, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - The PostgreSQL heap tuple layout
    *Focus:* Cover The PostgreSQL heap tuple layout as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate The PostgreSQL heap tuple layout, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - HeapTupleHeaderData null bitmaps alignment and infomask bits
    *Focus:* Cover HeapTupleHeaderData null bitmaps alignment and infomask bits as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate HeapTupleHeaderData null bitmaps alignment and infomask bits, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - xmin xmax command IDs and tuple CTIDs
    *Focus:* Cover xmin xmax command IDs and tuple CTIDs as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate xmin xmax command IDs and tuple CTIDs, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Fixed-length pass-by-value and varlena datums
    *Focus:* Cover Fixed-length pass-by-value and varlena datums as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Fixed-length pass-by-value and varlena datums, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - TOAST compression and out-of-line values
    *Focus:* Cover TOAST compression and out-of-line values as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate TOAST compression and out-of-line values, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Main free-space visibility and initialization forks
    *Focus:* Cover Main free-space visibility and initialization forks as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Main free-space visibility and initialization forks, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Free-space map trees and visibility-map bits
    *Focus:* Cover Free-space map trees and visibility-map bits as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Free-space map trees and visibility-map bits, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Storage managers relation segments and temporary files
    *Focus:* Cover Storage managers relation segments and temporary files as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Storage managers relation segments and temporary files, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Checksumming and torn pages
    *Focus:* Cover Checksumming and torn pages as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Checksumming and torn pages, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Page LSNs full-page images and WAL consistency
    *Focus:* Cover Page LSNs full-page images and WAL consistency as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Page LSNs full-page images and WAL consistency, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
- **Chapter 64: Implementing B-Trees**
  *Focus:* Turn B-tree invariants into an implementation covering page search, insertion, deletion, split propagation, concurrent descent, maintenance, WAL, online builds, and verification.
  *Examples and visuals:* Include a compact page-based B+ tree or split routine, before-and-after structural diagrams, and a table of latch, WAL, and invariant obligations per operation.
  - Mapping B-tree invariants onto pages
    *Focus:* Cover Mapping B-tree invariants onto pages as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Mapping B-tree invariants onto pages, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Page header
    *Focus:* Cover Page header as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Page header, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Node high keys
    *Focus:* Cover Node high keys as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Node high keys, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Sibling and rightmost links
    *Focus:* Cover Sibling and rightmost links as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Sibling and rightmost links, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Overflow pages
    *Focus:* Trace the causes and consequences of Overflow pages, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Overflow pages, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Root-to-leaf search and descent state
    *Focus:* Cover Root-to-leaf search and descent state as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Root-to-leaf search and descent state, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Binary search with indirection pointers
    *Focus:* Cover Binary search with indirection pointers as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Binary search with indirection pointers, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Breadcrumbs
    *Focus:* Cover Breadcrumbs as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Breadcrumbs, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Insertion deletion and occupancy maintenance
    *Focus:* Cover Insertion deletion and occupancy maintenance as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Insertion deletion and occupancy maintenance, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Propagating splits and merges
    *Focus:* Cover Propagating splits and merges as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Propagating splits and merges, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - B-link trees and concurrent descent
    *Focus:* Cover B-link trees and concurrent descent as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate B-link trees and concurrent descent, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Latches lock coupling and split races
    *Focus:* Trace the causes and consequences of Latches lock coupling and split races, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Latches lock coupling and split races, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Right-only appends and bulk loading
    *Focus:* Cover Right-only appends and bulk loading as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Right-only appends and bulk loading, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Compression and deduplication
    *Focus:* Cover Compression and deduplication as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Compression and deduplication, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Vacuum, fragmentation, and defragmentation
    *Focus:* Trace the causes and consequences of Vacuum, fragmentation, and defragmentation, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Vacuum, fragmentation, and defragmentation, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - WAL-logging page changes and split completion
    *Focus:* Cover WAL-logging page changes and split completion as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate WAL-logging page changes and split completion, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Concurrent and online index builds
    *Focus:* Cover Concurrent and online index builds as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Concurrent and online index builds, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - amcheck pageinspect and structural verification
    *Focus:* Cover amcheck pageinspect and structural verification as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate amcheck pageinspect and structural verification, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
- **Chapter 65: Transaction Processing and Recovery**
  *Focus:* Build from ACID, isolation, locking, and MVCC into PostgreSQL snapshots, buffer management, WAL, crash recovery, vacuum, wraparound prevention, and replication.
  *Examples and visuals:* Include anomaly schedules and PostgreSQL visibility or WAL exercises, transaction and recovery timelines, and tables for isolation levels, lock modes, tuple states, and durability steps.
  - Transactions and the ACID properties
    *Focus:* Cover Transactions and the ACID properties as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Transactions and the ACID properties, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Transaction begin commit abort and rollback
    *Focus:* Cover Transaction begin commit abort and rollback as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Transaction begin commit abort and rollback, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Schedules histories and serial execution
    *Focus:* Cover Schedules histories and serial execution as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Schedules histories and serial execution, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Read and write anomalies
    *Focus:* Cover Read and write anomalies as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Read and write anomalies, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Isolation levels
    *Focus:* Cover Isolation levels as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Isolation levels, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Serializability
    *Focus:* Cover Serializability as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Serializability, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Optimistic concurrency control
    *Focus:* Cover Optimistic concurrency control as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Optimistic concurrency control, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Pessimistic and lock-based concurrency control
    *Focus:* Cover Pessimistic and lock-based concurrency control as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Pessimistic and lock-based concurrency control, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Multiversion concurrency control
    *Focus:* Cover Multiversion concurrency control as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Multiversion concurrency control, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Locks, latches, and latch crabbing
    *Focus:* Cover Locks, latches, and latch crabbing as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Locks, latches, and latch crabbing, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Deadlocks
    *Focus:* Trace the causes and consequences of Deadlocks, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Deadlocks, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - PostgreSQL transaction IDs epochs and wraparound
    *Focus:* Cover PostgreSQL transaction IDs epochs and wraparound as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL transaction IDs epochs and wraparound, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Snapshots command IDs and tuple visibility rules
    *Focus:* Cover Snapshots command IDs and tuple visibility rules as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Snapshots command IDs and tuple visibility rules, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - ProcArray visibility horizons and global xmin
    *Focus:* Cover ProcArray visibility horizons and global xmin as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate ProcArray visibility horizons and global xmin, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - pg_xact commit status pg_subtrans and hint bits
    *Focus:* Cover pg_xact commit status pg_subtrans and hint bits as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate pg_xact commit status pg_subtrans and hint bits, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - SLRU caches and transaction-status storage
    *Focus:* Cover SLRU caches and transaction-status storage as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate SLRU caches and transaction-status storage, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - MultiXacts and shared row locks
    *Focus:* Cover MultiXacts and shared row locks as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate MultiXacts and shared row locks, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Subtransactions savepoints and subtransaction overflow
    *Focus:* Trace the causes and consequences of Subtransactions savepoints and subtransaction overflow, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Subtransactions savepoints and subtransaction overflow, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Prepared transactions and two-phase commit
    *Focus:* Cover Prepared transactions and two-phase commit as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Prepared transactions and two-phase commit, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Read Committed and snapshot isolation in PostgreSQL
    *Focus:* Cover Read Committed and snapshot isolation in PostgreSQL as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Read Committed and snapshot isolation in PostgreSQL, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Serializable snapshot isolation and predicate locks
    *Focus:* Cover Serializable snapshot isolation and predicate locks as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Serializable snapshot isolation and predicate locks, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Table row page and advisory lock modes
    *Focus:* Cover Table row page and advisory lock modes as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Table row page and advisory lock modes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Fast-path locks heavyweight locks LWLocks and spinlocks
    *Focus:* Cover Fast-path locks heavyweight locks LWLocks and spinlocks as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Fast-path locks heavyweight locks LWLocks and spinlocks, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Deadlock detection timeouts and wait queues
    *Focus:* Trace the causes and consequences of Deadlock detection timeouts and wait queues, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Deadlock detection timeouts and wait queues, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Why a database needs a buffer pool
    *Focus:* Answer why a database needs a buffer pool and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Why a database needs a buffer pool, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Buffer management
    *Focus:* Cover Buffer management as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Buffer management, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Cache eviction and page replacement
    *Focus:* Cover Cache eviction and page replacement as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Cache eviction and page replacement, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL buffer tags pins and content locks
    *Focus:* Cover PostgreSQL buffer tags pins and content locks as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL buffer tags pins and content locks, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Shared buffer lookup partitioning and replacement
    *Focus:* Cover Shared buffer lookup partitioning and replacement as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Shared buffer lookup partitioning and replacement, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Buffer clock sweep usage counts and ring strategies
    *Focus:* Turn Buffer clock sweep usage counts and ring strategies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Buffer clock sweep usage counts and ring strategies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Dirty-buffer writeback and backend fsync requests
    *Focus:* Cover Dirty-buffer writeback and backend fsync requests as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Dirty-buffer writeback and backend fsync requests, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Failure atomicity durability and recovery
    *Focus:* Trace the causes and consequences of Failure atomicity durability and recovery, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Failure atomicity durability and recovery, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Recovery and log semantics
    *Focus:* Cover Recovery and log semantics as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Recovery and log semantics, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Steal and force policies
    *Focus:* Turn Steal and force policies into a decision framework based on semantics, correctness constraints, workload shape, resource limits, and latency objectives.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Steal and force policies, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Write-ahead logging and LSNs
    *Focus:* Cover Write-ahead logging and LSNs as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Write-ahead logging and LSNs, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - ARIES
    *Focus:* Cover ARIES as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate ARIES, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL recovery versus ARIES
    *Focus:* Compare PostgreSQL recovery versus ARIES by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate PostgreSQL recovery versus ARIES, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - PostgreSQL WAL records insertion buffers and flush ordering
    *Focus:* Cover PostgreSQL WAL records insertion buffers and flush ordering as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL WAL records insertion buffers and flush ordering, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Commit records synchronous_commit and group commit
    *Focus:* Cover Commit records synchronous_commit and group commit as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Commit records synchronous_commit and group commit, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Kernel page cache fsync and durable ordering
    *Focus:* Cover Kernel page cache fsync and durable ordering as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Kernel page cache fsync and durable ordering, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Full-page writes and checkpoints
    *Focus:* Cover Full-page writes and checkpoints as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Full-page writes and checkpoints, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Checkpoint spreading redo points and restartpoints
    *Focus:* Cover Checkpoint spreading redo points and restartpoints as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Checkpoint spreading redo points and restartpoints, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Crash recovery timelines and control files
    *Focus:* Cover Crash recovery timelines and control files as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Crash recovery timelines and control files, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - WAL archiving and point-in-time recovery
    *Focus:* Cover WAL archiving and point-in-time recovery as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate WAL archiving and point-in-time recovery, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - MVCC garbage and visibility horizons
    *Focus:* Cover MVCC garbage and visibility horizons as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate MVCC garbage and visibility horizons, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - VACUUM autovacuum and dead-tuple reclamation
    *Focus:* Cover VACUUM autovacuum and dead-tuple reclamation as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate VACUUM autovacuum and dead-tuple reclamation, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Freezing visibility horizons and anti-wraparound vacuum
    *Focus:* Cover Freezing visibility horizons and anti-wraparound vacuum as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Freezing visibility horizons and anti-wraparound vacuum, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Heap-only tuples and HOT update chains
    *Focus:* Cover Heap-only tuples and HOT update chains as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Heap-only tuples and HOT update chains, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Heap page pruning compaction and index cleanup
    *Focus:* Cover Heap page pruning compaction and index cleanup as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Heap page pruning compaction and index cleanup, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Vacuum progress monitoring and table bloat diagnosis
    *Focus:* Trace the causes and consequences of Vacuum progress monitoring and table bloat diagnosis, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Vacuum progress monitoring and table bloat diagnosis, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Replication slots and WAL retention
    *Focus:* Cover Replication slots and WAL retention as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Replication slots and WAL retention, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Physical streaming replication and hot standby
    *Focus:* Cover Physical streaming replication and hot standby as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Physical streaming replication and hot standby, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Logical decoding reorder buffers and logical replication
    *Focus:* Cover Logical decoding reorder buffers and logical replication as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Logical decoding reorder buffers and logical replication, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
- **Chapter 66: B-Tree Variants**
  *Focus:* Compare alternative B-tree update strategies and PostgreSQL index access methods so candidates can select structures based on key type, predicate, update rate, and workload.
  *Examples and visuals:* Include representative queries and index choices, diagrams for copy-on-write, delta, GiST, GIN, and BRIN organization, and a workload-selection table.
  - Why storage engines vary the B-tree
    *Focus:* Answer why storage engines vary the B-tree and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Why storage engines vary the B-tree, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Update-in-place copy-on-write and delta records
    *Focus:* Cover Update-in-place copy-on-write and delta records as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Update-in-place copy-on-write and delta records, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Copy-on-write B-trees and LMDB
    *Focus:* Cover Copy-on-write B-trees and LMDB as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Copy-on-write B-trees and LMDB, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Abstracting node updates
    *Focus:* Cover Abstracting node updates as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Abstracting node updates, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Lazy B-trees and WiredTiger
    *Focus:* Cover Lazy B-trees and WiredTiger as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Lazy B-trees and WiredTiger, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - FD-trees and fractional cascading
    *Focus:* Cover FD-trees and fractional cascading as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate FD-trees and fractional cascading, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Fractal and Bε-trees
    *Focus:* Cover Fractal and Bε-trees as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Fractal and Bε-trees, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Bw-trees and latch-free updates
    *Focus:* Cover Bw-trees and latch-free updates as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Bw-trees and latch-free updates, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Structural modification operations
    *Focus:* Cover Structural modification operations as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Structural modification operations, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Consolidation and garbage collection
    *Focus:* Cover Consolidation and garbage collection as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Consolidation and garbage collection, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Cache-oblivious B-trees
    *Focus:* Cover Cache-oblivious B-trees as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Cache-oblivious B-trees, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL index access-method framework
    *Focus:* Cover PostgreSQL index access-method framework as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL index access-method framework, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Index access-method APIs and operator families
    *Focus:* Cover Index access-method APIs and operator families as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Index access-method APIs and operator families, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL hash indexes
    *Focus:* Cover PostgreSQL hash indexes as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate PostgreSQL hash indexes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - GiST extensible balanced search trees
    *Focus:* Cover GiST extensible balanced search trees as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate GiST extensible balanced search trees, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - SP-GiST space-partitioned search trees
    *Focus:* Cover SP-GiST space-partitioned search trees as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate SP-GiST space-partitioned search trees, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - GIN inverted indexes and pending lists
    *Focus:* Cover GIN inverted indexes and pending lists as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate GIN inverted indexes and pending lists, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - BRIN block-range summaries
    *Focus:* Cover BRIN block-range summaries as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate BRIN block-range summaries, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Choosing PostgreSQL indexes from workload shape
    *Focus:* Compare Choosing PostgreSQL indexes from workload shape by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Choosing PostgreSQL indexes from workload shape, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
- **Chapter 67: Log-Structured Storage**
  *Focus:* Explain LSM write and read paths, immutable runs, compaction, amplification, concurrency, and storage-stack effects before contrasting them with PostgreSQL heap-plus-WAL storage.
  *Examples and visuals:* Include a memtable flush and compaction simulation, level and read-path diagrams, and a table comparing LSM configurations and PostgreSQL tradeoffs.
  - Append-only writes and immutable sorted runs
    *Focus:* Cover Append-only writes and immutable sorted runs as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Append-only writes and immutable sorted runs, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - LSM tree structure
    *Focus:* Cover LSM tree structure as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate LSM tree structure, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Write-ahead logs
    *Focus:* Cover Write-ahead logs as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Write-ahead logs, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Memtables and SSTables
    *Focus:* Cover Memtables and SSTables as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Memtables and SSTables, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Sorted string tables
    *Focus:* Cover Sorted string tables as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Sorted string tables, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Tombstones, updates, and deletes
    *Focus:* Cover Tombstones, updates, and deletes as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Tombstones, updates, and deletes, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - LSM read paths
    *Focus:* Cover LSM read paths as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate LSM read paths, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Bloom filters sparse indexes and skip lists
    *Focus:* Cover Bloom filters sparse indexes and skip lists as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Bloom filters sparse indexes and skip lists, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - LSM lookups and read amplification
    *Focus:* Cover LSM lookups and read amplification as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate LSM lookups and read amplification, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Merge-iteration and reconciliation
    *Focus:* Cover Merge-iteration and reconciliation as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Merge-iteration and reconciliation, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Compaction purpose and mechanics
    *Focus:* Cover Compaction purpose and mechanics as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Compaction purpose and mechanics, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Leveled versus size-tiered compaction
    *Focus:* Compare Leveled versus size-tiered compaction by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Leveled versus size-tiered compaction, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Read, write, and space amplification
    *Focus:* Cover Read, write, and space amplification as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Read, write, and space amplification, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - The RUM conjecture
    *Focus:* Cover The RUM conjecture as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate The RUM conjecture, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Concurrency in LSM trees
    *Focus:* Cover Concurrency in LSM trees as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Concurrency in LSM trees, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Unordered LSM storage: Bitcask and WiscKey
    *Focus:* Cover Unordered LSM storage: Bitcask and WiscKey as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Unordered LSM storage: Bitcask and WiscKey, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - Log stacking and the flash translation layer
    *Focus:* Cover Log stacking and the flash translation layer as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Log stacking and the flash translation layer, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - PostgreSQL heap plus WAL versus LSM storage
    *Focus:* Compare PostgreSQL heap plus WAL versus LSM storage by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate PostgreSQL heap plus WAL versus LSM storage, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Distinguishing PostgreSQL WAL from an LSM tree
    *Focus:* Cover Distinguishing PostgreSQL WAL from an LSM tree as a database-internals concept and relate the general mechanism to PostgreSQL data structures, concurrency, I/O, recovery, and performance.
    *Examples and visuals:* Use a small SQL, page, transaction, or algorithm trace to demonstrate Distinguishing PostgreSQL WAL from an LSM tree, supported by a storage or execution diagram and a table of invariants, I/O costs, locks, and failure cases.
  - LSM tradeoffs relative to PostgreSQL MVCC and vacuum
    *Focus:* Compare LSM tradeoffs relative to PostgreSQL MVCC and vacuum by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate LSM tradeoffs relative to PostgreSQL MVCC and vacuum, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.

## Distributed Data Systems

- **Chapter 68: Distributed Systems: Introduction and Overview**
  *Focus:* Establish the vocabulary, goals, execution model, communication limits, time, failures, safety, liveness, synchrony, and impossibility results underlying distributed systems.
  *Examples and visuals:* Include message-ordering and partial-failure scenarios, space-time diagrams, and a table distinguishing failure, delivery, and synchrony models.
  - Nodes processes messages and distributed state
    *Focus:* Cover Nodes processes messages and distributed state with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Nodes processes messages and distributed state, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Goals scalability availability and fault tolerance
    *Focus:* Cover Goals scalability availability and fault tolerance with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Goals scalability availability and fault tolerance, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Why distribution is hard
    *Focus:* Answer why distribution is hard and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Why distribution is hard, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Concurrent execution and shared state
    *Focus:* Cover Concurrent execution and shared state with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Concurrent execution and shared state, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Fallacies of distributed computing
    *Focus:* Cover Fallacies of distributed computing with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Fallacies of distributed computing, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Links and message delivery
    *Focus:* Cover Links and message delivery with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Links and message delivery, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Clocks and time
    *Focus:* Cover Clocks and time with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Clocks and time, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Ordering causality and concurrency
    *Focus:* Cover Ordering causality and concurrency with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Ordering causality and concurrency, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Network partitions and partial failures
    *Focus:* Trace the causes and consequences of Network partitions and partial failures, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Network partitions and partial failures, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Failure models
    *Focus:* Trace the causes and consequences of Failure models, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Failure models, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Cascading failures
    *Focus:* Trace the causes and consequences of Cascading failures, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Cascading failures, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Safety liveness and progress
    *Focus:* Cover Safety liveness and progress with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Safety liveness and progress, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - System synchrony models
    *Focus:* Cover System synchrony models with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate System synchrony models, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - The Two Generals' Problem
    *Focus:* Cover The Two Generals' Problem with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate The Two Generals' Problem, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - FLP impossibility
    *Focus:* Cover FLP impossibility with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate FLP impossibility, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
- **Chapter 69: Failure Detection**
  *Focus:* Explain why remote failure is inferred rather than observed and compare timeout, heartbeat, accrual, gossip, SWIM, and indirect detection strategies.
  *Examples and visuals:* Include a configurable heartbeat detector or phi calculation, suspicion-timeline and SWIM diagrams, and a table comparing completeness, accuracy, cost, and false positives.
  - Why failures cannot be observed directly
    *Focus:* Answer why failures cannot be observed directly and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Why failures cannot be observed directly, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Failure suspicion detection and membership
    *Focus:* Trace the causes and consequences of Failure suspicion detection and membership, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Failure suspicion detection and membership, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Failure detectors: completeness and accuracy
    *Focus:* Trace the causes and consequences of Failure detectors: completeness and accuracy, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Failure detectors: completeness and accuracy, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Timeouts
    *Focus:* Cover Timeouts with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Timeouts, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Heartbeats and pings
    *Focus:* Cover Heartbeats and pings with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Heartbeats and pings, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - GC pauses and false positives
    *Focus:* Cover GC pauses and false positives with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate GC pauses and false positives, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Timeout-free failure detectors
    *Focus:* Trace the causes and consequences of Timeout-free failure detectors, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Timeout-free failure detectors, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Outsourced heartbeats
    *Focus:* Cover Outsourced heartbeats with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Outsourced heartbeats, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Phi-accrual failure detector
    *Focus:* Trace the causes and consequences of Phi-accrual failure detector, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Phi-accrual failure detector, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Gossip and failure detection
    *Focus:* Trace the causes and consequences of Gossip and failure detection, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Gossip and failure detection, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - SWIM and indirect probing
    *Focus:* Cover SWIM and indirect probing with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate SWIM and indirect probing, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Reversing failure detection
    *Focus:* Trace the causes and consequences of Reversing failure detection, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Reversing failure detection, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
- **Chapter 70: Leader Election**
  *Focus:* Explain when systems need leaders and how elections use votes, epochs, quorums, leases, and fencing to provide safety and progress without split brain.
  *Examples and visuals:* Include a small election-state simulation, term and lease timelines, and a table comparing bully, ring, quorum-backed, and production election approaches.
  - Leader roles and single-writer coordination
    *Focus:* Cover Leader roles and single-writer coordination with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Leader roles and single-writer coordination, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Leader election versus consensus
    *Focus:* Compare Leader election versus consensus by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Leader election versus consensus, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Election triggers candidates and votes
    *Focus:* Cover Election triggers candidates and votes with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Election triggers candidates and votes, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Safety and liveness of election
    *Focus:* Cover Safety and liveness of election with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Safety and liveness of election, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Epochs, terms, and fencing tokens
    *Focus:* Cover Epochs, terms, and fencing tokens with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Epochs, terms, and fencing tokens, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Split-brain and quorums
    *Focus:* Trace the causes and consequences of Split-brain and quorums, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Split-brain and quorums, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Leases
    *Focus:* Cover Leases with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Leases, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Bully algorithm
    *Focus:* Cover Bully algorithm with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Bully algorithm, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Next-in-line and invitation variants
    *Focus:* Cover Next-in-line and invitation variants with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Next-in-line and invitation variants, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Ring algorithm
    *Focus:* Cover Ring algorithm with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Ring algorithm, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Real-world election: ZooKeeper, etcd, Patroni
    *Focus:* Cover Real-world election: ZooKeeper, etcd, Patroni with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Real-world election: ZooKeeper, etcd, Patroni, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
- **Chapter 71: Replication and Consistency**
  *Focus:* Connect replication topology and timing to failover, stale reads, CAP tradeoffs, consistency models, logical clocks, quorums, and conflict-free convergence.
  *Examples and visuals:* Include read-write histories to classify consistency and quorum calculations, replication and causality diagrams, and a table comparing guarantees and availability costs.
  - Why replicate
    *Focus:* Answer why replicate and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Why replicate, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Replicas leaders followers and logs
    *Focus:* Cover Replicas leaders followers and logs with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Replicas leaders followers and logs, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Replication topologies
    *Focus:* Cover Replication topologies with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Replication topologies, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Synchronous versus asynchronous replication
    *Focus:* Compare Synchronous versus asynchronous replication by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Synchronous versus asynchronous replication, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Replication lag failover and stale reads
    *Focus:* Trace the causes and consequences of Replication lag failover and stale reads, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Replication lag failover and stale reads, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - The CAP theorem and PACELC
    *Focus:* Cover The CAP theorem and PACELC with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate The CAP theorem and PACELC, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Harvest and yield
    *Focus:* Cover Harvest and yield with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Harvest and yield, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Consistency-model vocabulary
    *Focus:* Cover Consistency-model vocabulary with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Consistency-model vocabulary, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Linearizability
    *Focus:* Cover Linearizability with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Linearizability, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Sequential and causal consistency
    *Focus:* Cover Sequential and causal consistency with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Sequential and causal consistency, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Session and client-centric models
    *Focus:* Cover Session and client-centric models with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Session and client-centric models, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Eventual and tunable consistency
    *Focus:* Cover Eventual and tunable consistency with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Eventual and tunable consistency, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Conflict detection and logical clocks
    *Focus:* Cover Conflict detection and logical clocks with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Conflict detection and logical clocks, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Vector clocks
    *Focus:* Cover Vector clocks with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Vector clocks, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Quorums
    *Focus:* Cover Quorums with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Quorums, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - CRDTs and strong eventual consistency
    *Focus:* Cover CRDTs and strong eventual consistency with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate CRDTs and strong eventual consistency, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
- **Chapter 72: Anti-Entropy and Dissemination**
  *Focus:* Explain how replicas detect, compare, repair, and disseminate divergent state using digests, Merkle trees, version summaries, hinted handoff, and gossip.
  *Examples and visuals:* Include a small Merkle-tree comparison or gossip simulation, convergence and repair-flow diagrams, and a table comparing bandwidth, convergence speed, and failure tolerance.
  - Replica divergence and anti-entropy
    *Focus:* Cover Replica divergence and anti-entropy with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Replica divergence and anti-entropy, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Comparing state versions and digests
    *Focus:* Cover Comparing state versions and digests with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Comparing state versions and digests, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Merkle trees
    *Focus:* Cover Merkle trees with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Merkle trees, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Bitmap version vectors
    *Focus:* Cover Bitmap version vectors with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Bitmap version vectors, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Read repair and digest reads
    *Focus:* Cover Read repair and digest reads with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Read repair and digest reads, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Hinted handoff
    *Focus:* Cover Hinted handoff with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Hinted handoff, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Why gossip converges probabilistically
    *Focus:* Answer why gossip converges probabilistically and connect the motivation to correctness, implementation constraints, workload behavior, and low-latency tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Why gossip converges probabilistically, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Gossip dissemination
    *Focus:* Cover Gossip dissemination with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Gossip dissemination, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Push, pull, and push-pull
    *Focus:* Cover Push, pull, and push-pull with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Push, pull, and push-pull, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Overlay networks and hybrid gossip
    *Focus:* Cover Overlay networks and hybrid gossip with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Overlay networks and hybrid gossip, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Partial views
    *Focus:* Cover Partial views with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Partial views, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
- **Chapter 73: Distributed Transactions**
  *Focus:* Explain the added atomicity and isolation problems of cross-partition work and compare commit protocols, deterministic execution, timestamp systems, sagas, and coordination avoidance.
  *Examples and visuals:* Include a two-phase-commit failure simulation and saga example, coordinator-participant and cross-shard timelines, and a table comparing blocking, consistency, and recovery properties.
  - Local versus distributed transactions
    *Focus:* Compare Local versus distributed transactions by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Local versus distributed transactions, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Single-partition versus cross-partition work
    *Focus:* Compare Single-partition versus cross-partition work by semantics, implementation, correctness guarantees, resource costs, and the workload conditions that should drive an interview-quality choice.
    *Examples and visuals:* Use a side-by-side worked example to demonstrate Single-partition versus cross-partition work, supported by a decision flowchart and a table comparing semantics, costs, failure modes, and appropriate use cases.
  - Database partitioning and consistent hashing
    *Focus:* Cover Database partitioning and consistent hashing with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Database partitioning and consistent hashing, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Atomic commitment
    *Focus:* Cover Atomic commitment with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Atomic commitment, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Commit protocols coordinators and participants
    *Focus:* Cover Commit protocols coordinators and participants with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Commit protocols coordinators and participants, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Two-phase commit
    *Focus:* Cover Two-phase commit with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Two-phase commit, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Cohort and coordinator failures
    *Focus:* Trace the causes and consequences of Cohort and coordinator failures, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Cohort and coordinator failures, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - The blocking problem
    *Focus:* Cover The blocking problem with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate The blocking problem, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Three-phase commit
    *Focus:* Cover Three-phase commit with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Three-phase commit, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Consensus-backed commit
    *Focus:* Cover Consensus-backed commit with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Consensus-backed commit, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Distributed isolation and concurrency control
    *Focus:* Cover Distributed isolation and concurrency control with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Distributed isolation and concurrency control, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Calvin and deterministic transactions
    *Focus:* Cover Calvin and deterministic transactions with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Calvin and deterministic transactions, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Spanner and TrueTime
    *Focus:* Cover Spanner and TrueTime with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Spanner and TrueTime, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Percolator
    *Focus:* Cover Percolator with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Percolator, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Sagas compensating actions and workflow transactions
    *Focus:* Cover Sagas compensating actions and workflow transactions with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Sagas compensating actions and workflow transactions, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Coordination avoidance
    *Focus:* Cover Coordination avoidance with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Coordination avoidance, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
- **Chapter 74: Consensus**
  *Focus:* Define consensus and state-machine replication before comparing quorum reasoning, Paxos, Raft, atomic broadcast, membership changes, snapshots, and Byzantine agreement.
  *Examples and visuals:* Include a small replicated-log simulation or worked failure trace, Paxos and Raft message diagrams, and a table comparing assumptions, roles, safety rules, and operational complexity.
  - The consensus problem
    *Focus:* Cover The consensus problem with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate The consensus problem, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Agreement validity termination and fault assumptions
    *Focus:* Cover Agreement validity termination and fault assumptions with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Agreement validity termination and fault assumptions, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Quorums majority intersection and durability
    *Focus:* Cover Quorums majority intersection and durability with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Quorums majority intersection and durability, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - State-machine replication
    *Focus:* Cover State-machine replication with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate State-machine replication, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Atomic broadcast and virtual synchrony
    *Focus:* Cover Atomic broadcast and virtual synchrony with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Atomic broadcast and virtual synchrony, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Paxos
    *Focus:* Cover Paxos with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Paxos, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Paxos quorums and failure scenarios
    *Focus:* Trace the causes and consequences of Paxos quorums and failure scenarios, identify the threatened invariant and observable symptoms, and explain prevention, detection, and recovery.
    *Examples and visuals:* Use a minimal reproduction or failure trace to demonstrate Paxos quorums and failure scenarios, supported by a causal timeline and a table mapping symptoms and violated invariants to detection and mitigation steps.
  - Multi-Paxos and variants
    *Focus:* Cover Multi-Paxos and variants with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Multi-Paxos and variants, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Raft
    *Focus:* Cover Raft with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Raft, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Raft leader election and terms
    *Focus:* Cover Raft leader election and terms with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Raft leader election and terms, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Raft log replication and safety
    *Focus:* Cover Raft log replication and safety with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Raft log replication and safety, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Membership changes snapshots and log compaction
    *Focus:* Cover Membership changes snapshots and log compaction with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Membership changes snapshots and log compaction, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - ZooKeeper Atomic Broadcast
    *Focus:* Cover ZooKeeper Atomic Broadcast with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate ZooKeeper Atomic Broadcast, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Byzantine consensus and PBFT
    *Focus:* Cover Byzantine consensus and PBFT with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Byzantine consensus and PBFT, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
  - Consensus in practice
    *Focus:* Cover Consensus in practice with explicit system assumptions, message and state transitions, safety and liveness properties, failure cases, and operational tradeoffs.
    *Examples and visuals:* Use a worked execution or failure trace to demonstrate Consensus in practice, supported by a space-time or state-machine diagram and a table of assumptions, guarantees, costs, and recovery behavior.
